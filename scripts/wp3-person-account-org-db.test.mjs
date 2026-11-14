/**
 * WP3B Person, Account Classification, Person-Account Link, Department Membership
 * & Department HEAD — Database & Backfill Test Suite (TM-01..TM-11, TM-13..TM-18).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  computeAssignAccountingMemberFingerprint,
  computeCreateDepartmentFingerprint,
  computeDesignateHeadFingerprint,
  computeEndAccountingMemberFingerprint,
  computeEndHeadFingerprint,
  computeEndPersonMemberFingerprint,
  computeUpdateDepartmentFingerprint,
} from "../src/lib/departments/department-contract.ts";
import { parsePatchAdminConfigBody } from "../src/lib/leave/leave-contract.ts";
import {
  computeCreatePersonFingerprint,
  computeLinkAccountPersonFingerprint,
  computeSetAccountTypeFingerprint,
  computeTransferPersonDepartmentFingerprint,
  computeUnlinkAccountPersonFingerprint,
  computeUpdatePersonFingerprint,
} from "../src/lib/organization/person-contract.ts";
import {
  WP3B_BACKFILL_SCHEMA_VERSION,
  computeBackfillManifestFingerprint,
} from "./lib/wp3b-backfill-manifest.mjs";
import {
  assertSafeBackfillConnectionTarget,
  runQ1HrpRecruiterAudit,
  runWp3bBackfill,
} from "./wp3b-backfill-person-account-org.mjs";
import {
  WP3B_PERSON_ACCOUNT_ORG_MIGRATION_NAME,
  WP3B_PERSON_ACCOUNT_ORG_RPC_SIGNATURES,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const FULL_ADMIN = {
  auth: "11000000-0000-4000-8000-000000000001",
  app: "21000000-0000-4000-8000-000000000001",
  email: "full.admin@company.local",
  name: "Full Admin",
};

const SCOPED_ADMIN = {
  auth: "11000000-0000-4000-8000-000000000002",
  app: "21000000-0000-4000-8000-000000000002",
  email: "scoped.admin@company.local",
  name: "Scoped Admin",
};

const USER_A = {
  auth: "11000000-0000-4000-8000-000000000003",
  app: "21000000-0000-4000-8000-000000000003",
  recruiter: "31000000-0000-4000-8000-000000000003",
  email: "user.a@company.local",
  name: "Tài khoản A",
  personnelCode: "REC-A01",
};

const USER_B = {
  auth: "11000000-0000-4000-8000-000000000004",
  app: "21000000-0000-4000-8000-000000000004",
  recruiter: "31000000-0000-4000-8000-000000000004",
  email: "user.b@company.local",
  name: "Tài khoản B",
  personnelCode: "REC-B02",
};

const USER_ACCT = {
  auth: "11000000-0000-4000-8000-000000000005",
  app: "21000000-0000-4000-8000-000000000005",
  email: "acct.c@company.local",
  name: "Kế toán C",
};

const USER_SHARED = {
  auth: "11000000-0000-4000-8000-000000000006",
  app: "21000000-0000-4000-8000-000000000006",
  email: "shared.svc@company.local",
  name: "Tài khoản dùng chung",
};

const USER_CONFLICT = {
  auth: "11000000-0000-4000-8000-000000000007",
  app: "21000000-0000-4000-8000-000000000007",
  recruiter: "31000000-0000-4000-8000-000000000007",
  email: "conflict.u@company.local",
  name: "Tài khoản Xung Đột",
  personnelCode: "REC-X07",
};

const USER_DISABLED = {
  auth: "11000000-0000-4000-8000-000000000008",
  app: "21000000-0000-4000-8000-000000000008",
  email: "disabled.acct@company.local",
  name: "Tài khoản Khóa D",
};

const USER_C = {
  auth: "11000000-0000-4000-8000-000000000009",
  app: "21000000-0000-4000-8000-000000000009",
  recruiter: "31000000-0000-4000-8000-000000000009",
  email: "user.c@company.local",
  name: "Tài khoản C2",
  personnelCode: "REC-C09",
};

const VENDOR_ID = "vendor-partner-01";
const VENDOR_RECRUITER = "31000000-0000-4000-8000-000000000099";
const HRP_UNLINKED_RECRUITER = "31000000-0000-4000-8000-000000000088";
const TEAM_ALPHA = "51000000-0000-4000-8000-000000000001";
const TEAM_BETA = "51000000-0000-4000-8000-000000000002";
const SYS_VENDOR_TEAM = "51000000-0000-4000-8000-0000000000ff";

let idempSeq = 100;
function nextKey() {
  idempSeq += 1;
  return `77000000-0000-4000-8000-${String(idempSeq).padStart(12, "0")}`;
}
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMigratedWp3Database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  await db.exec("alter table auth.users add column email text;");
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.includes(WP3B_PERSON_ACCOUNT_ORG_MIGRATION_NAME));
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    await db.exec(sql);
  }
  return db;
}

async function seedWp3BaseData(db) {
  for (const u of [
    FULL_ADMIN,
    SCOPED_ADMIN,
    USER_A,
    USER_B,
    USER_ACCT,
    USER_SHARED,
    USER_CONFLICT,
    USER_C,
  ]) {
    await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
      [u.app, u.auth, u.name],
    );
  }

  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
    USER_DISABLED.auth,
    USER_DISABLED.email,
  ]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, false)",
    [USER_DISABLED.app, USER_DISABLED.auth, USER_DISABLED.name],
  );

  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
     values ($1::uuid, 'entry_admin', '2026-01-01', true),
            ($1::uuid, 'recruiter_master_manage', '2026-01-01', true),
            ($1::uuid, 'team_master_manage', '2026-01-01', true),
            ($2::uuid, 'entry_admin', '2026-01-01', true)`,
    [FULL_ADMIN.app, SCOPED_ADMIN.app],
  );
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1::uuid, 'all', '2026-01-01', true),
            ($2::uuid, 'own', '2026-01-01', true)`,
    [FULL_ADMIN.app, SCOPED_ADMIN.app],
  );

  await db.query(
    "insert into public.vendors (vendor_id, display_name, active) values ($1, 'Vendor Đối Tác', true)",
    [VENDOR_ID],
  );
  const recDeptRes = await db.query(
    "select department_id from public.organization_departments where system_key = 'RECRUITMENT'",
  );
  const recDeptId = recDeptRes.rows[0].department_id;

  await db.query(
    `insert into public.teams (team_id, code, display_name, active, department_id)
     values ($1::uuid, 'ALPHA', 'Nhóm Alpha', true, $4::uuid),
            ($2::uuid, 'BETA', 'Nhóm Beta', true, $4::uuid),
            ($3::uuid, '__system_vendor__', 'System Vendor Internal', true, null)`,
    [TEAM_ALPHA, TEAM_BETA, SYS_VENDOR_TEAM, recDeptId],
  );

  for (const r of [USER_A, USER_B, USER_CONFLICT, USER_C]) {
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, $3, 'STAFF', true)`,
      [r.recruiter, r.name, r.personnelCode],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
       values ($1::uuid, 'hrp', null, '2026-01-01', true)`,
      [r.recruiter],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
      [r.app, r.recruiter],
    );
  }

  await db.query(
    `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
     values ($1::uuid, 'Nhân viên Vendor', 'VND-099', 'STAFF', true)`,
    [VENDOR_RECRUITER],
  );
  await db.query(
    `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
     values ($1::uuid, 'vendor', $2, '2026-01-01', true)`,
    [VENDOR_RECRUITER, VENDOR_ID],
  );

  await db.query(
    `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
     values ($1::uuid, 'HRP Chưa Link', 'REC-UNLINKED', 'STAFF', true)`,
    [HRP_UNLINKED_RECRUITER],
  );
  await db.query(
    `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
     values ($1::uuid, 'hrp', null, '2026-01-01', true)`,
    [HRP_UNLINKED_RECRUITER],
  );
}

test("TM-15 & TM-18: RLS/FORCE RLS, zero overloaded org_department_* RPCs, internal revokes, and Full-Admin-only ACL", async () => {
  const db = await createMigratedWp3Database();
  await seedWp3BaseData(db);

  const { rows: relRows } = await db.query(`
    select relname,
           c.relrowsecurity,
           c.relforcerowsecurity,
           has_table_privilege('anon', c.oid, 'SELECT') as anon_sel,
           has_table_privilege('authenticated', c.oid, 'SELECT') as auth_sel,
           has_table_privilege('service_role', c.oid, 'SELECT') as srv_sel
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in (
         'organization_persons',
         'organization_account_person_links',
         'organization_person_department_memberships',
         'organization_department_heads'
       )
     order by c.relname
  `);
  assert.equal(relRows.length, 4);
  for (const row of relRows) {
    assert.equal(row.relrowsecurity, true, `${row.relname} must enable RLS`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname} must force RLS`);
    assert.equal(row.anon_sel, false);
    assert.equal(row.auth_sel, false);
    assert.equal(row.srv_sel, false);
  }

  // Zero overloaded org_department_* RPCs (excluding internal helpers if checked separately, none may overload)
  const { rows: overloadRows } = await db.query(`
    select p.proname, count(*)::int as cnt
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'org_department\\_%' escape '\\'
     group by p.proname
    having count(*) > 1
  `);
  assert.equal(overloadRows.length, 0, "Zero overloaded org_department_* routines allowed");

  // Exact signatures & ACLs for public WP3B RPCs
  const { rows: rpcAclRows } = await db.query(
    `select sig,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
            has_function_privilege('service_role', p.oid, 'EXECUTE') as srv_exec
       from unnest($1::text[]) as sig
       join pg_proc p on p.oid = to_regprocedure(sig)`,
    [WP3B_PERSON_ACCOUNT_ORG_RPC_SIGNATURES],
  );
  assert.equal(rpcAclRows.length, WP3B_PERSON_ACCOUNT_ORG_RPC_SIGNATURES.length);
  for (const row of rpcAclRows) {
    assert.equal(row.anon_exec, false, `${row.sig} must deny anon`);
    assert.equal(row.auth_exec, false, `${row.sig} must deny authenticated`);
    assert.equal(row.srv_exec, true, `${row.sig} must allow service_role`);
  }

  // Internal helpers revoke execute from ALL (including service_role)
  const { rows: internalRows } = await db.query(`
    select p.oid::regprocedure::text as sig,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as srv_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'org_department\\_\\_internal\\_%' escape '\\'
  `);
  assert.ok(internalRows.length >= 10);
  for (const row of internalRows) {
    assert.equal(row.anon_exec, false, `${row.sig} internal must deny anon`);
    assert.equal(row.auth_exec, false, `${row.sig} internal must deny authenticated`);
    assert.equal(row.srv_exec, false, `${row.sig} internal must deny service_role`);
  }

  // Non-Full-Admin denied on WP3 RPCs
  await assert.rejects(
    db.query(
      "select public.org_department_list_persons_admin($1::uuid, $2::uuid, null, 'active', null, 'all', null, 1, 25)",
      [SCOPED_ADMIN.auth, SCOPED_ADMIN.app],
    ),
    /actor is not a Full Admin|DEPARTMENT_ACCESS_DENIED|42501/,
  );
  await db.close();
});

test("TM-04, TM-07, TM-10, TM-13: Departments guard, validation, recruiter matching, HEAD OD-WP3-04 & OD-WP3-05", async () => {
  const db = await createMigratedWp3Database();
  await seedWp3BaseData(db);

  const deptsList = (
    await db.query(
      "select public.org_department_list_departments_admin($1::uuid, $2::uuid, false, null) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app],
    )
  ).rows[0].data;
  assert.equal(deptsList.departments.length, 5);
  assert.deepEqual(
    deptsList.departments.map((d) => d.system_key),
    ["RECRUITMENT", "ACCOUNTING", "MARKETING", "IT", "MANAGEMENT_BOD"],
  );
  const deptByKey = new Map(deptsList.departments.map((d) => [d.system_key, d]));

  // TM-10: Create custom dept LEGAL_OPS -> rename & deactivate when empty; block system_key mutations & DELETE
  const kCreateDept = nextKey();
  const fpCreateDept = computeCreateDepartmentFingerprint({
    actor_app_user_id: FULL_ADMIN.app,
    code: "LEGAL_OPS",
    name: "Phòng Pháp chế",
    reason: "Tạo phòng ban tùy chỉnh",
  });
  const legalDept = (
    await db.query(
      "select public.org_department_create_department_admin($1::uuid, $2::uuid, 'LEGAL_OPS', 'Phòng Pháp chế', 'Tạo phòng ban tùy chỉnh', $3::uuid, $4) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app, kCreateDept, fpCreateDept],
    )
  ).rows[0].data.department;
  assert.equal(legalDept.system_key, null);
  assert.equal(legalDept.membership_mode, "MANAGED_MEMBERSHIP");
  assert.equal(legalDept.default_policy_code, "ORGANIZATIONAL_MEMBERSHIP_ONLY");
  assert.equal(legalDept.version, 1);

  await assert.rejects(
    db.query("update public.organization_departments set system_key = 'ACCOUNTING' where department_id = $1::uuid", [
      legalDept.department_id,
    ]),
    /DEPARTMENT_SYSTEM_KEY_IMMUTABLE|DEPARTMENT_SYSTEM_RECORD_IMMUTABLE|55000/,
  );
  await assert.rejects(
    db.query("update public.organization_departments set system_key = null where system_key = 'ACCOUNTING'"),
    /DEPARTMENT_SYSTEM_KEY_IMMUTABLE|DEPARTMENT_SYSTEM_RECORD_IMMUTABLE|55000/,
  );
  await assert.rejects(
    db.query("update public.organization_departments set system_key = 'RECRUITMENT' where system_key = 'ACCOUNTING'"),
    /DEPARTMENT_SYSTEM_KEY_IMMUTABLE|DEPARTMENT_SYSTEM_RECORD_IMMUTABLE|55000/,
  );
  await assert.rejects(
    db.query("delete from public.organization_departments where department_id = $1::uuid", [
      legalDept.department_id,
    ]),
    /DEPARTMENT_SYSTEM_RECORD_IMMUTABLE|55000/,
  );

  // Deactivate & reactivate custom dept while empty succeeds!
  const kDeactDept = nextKey();
  const deactDept = (
    await db.query(
      "select public.org_department_update_department_admin($1::uuid, $2::uuid, $3::uuid, 1, 'Phòng Pháp chế v2', false, 'Tạm đóng khi trống', $4::uuid, $5) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        legalDept.department_id,
        kDeactDept,
        computeUpdateDepartmentFingerprint({
          actor_app_user_id: FULL_ADMIN.app,
          department_id: legalDept.department_id,
          expected_department_version: 1,
          name: "Phòng Pháp chế v2",
          is_active: false,
          reason: "Tạm đóng khi trống",
        }),
      ],
    )
  ).rows[0].data.department;
  assert.equal(deactDept.is_active, false);

  const kReactDept = nextKey();
  await db.query(
    "select public.org_department_update_department_admin($1::uuid, $2::uuid, $3::uuid, 2, 'Phòng Pháp chế', true, 'Mở lại phòng ban', $4::uuid, $5)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      legalDept.department_id,
      kReactDept,
      computeUpdateDepartmentFingerprint({
        actor_app_user_id: FULL_ADMIN.app,
        department_id: legalDept.department_id,
        expected_department_version: 2,
        name: "Phòng Pháp chế",
        is_active: true,
        reason: "Mở lại phòng ban",
      }),
    ],
  );

  // System dept cannot be deactivated
  await assert.rejects(
    db.query(
      "select public.org_department_update_department_admin($1::uuid, $2::uuid, $3::uuid, 1, 'Phòng Marketing', false, 'Đóng thử', $4::uuid, $5)",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        deptByKey.get("MARKETING").department_id,
        nextKey(),
        FP_A,
      ],
    ),
    /DEPARTMENT_VALIDATION_ERROR|DEPARTMENT_QUERY_INVALID|SYSTEM|22023|42501|55000/i,
  );

  // Person validation (reject hrp-YYYY-NNNNNN, vendor recruiter, duplicate CI code)
  await assert.rejects(
    db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'hrp-2026-000123', 'Synthetic', null, null, null, null, null, 'Test', $3::uuid, $4)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, nextKey(), FP_A],
    ),
    /ORG_VALIDATION_ERROR|22023|23514/,
  );
  await assert.rejects(
    db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'VND-001', 'Vendor User', null, null, null, null, $3::uuid, 'Test', $4::uuid, $5)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, VENDOR_RECRUITER, nextKey(), FP_A],
    ),
    /VENDOR_RECRUITER_NOT_INTERNAL_PERSON|ORG_VALIDATION_ERROR|23514/,
  );

  // Snapshot counts BEFORE creating/linking/assigning/designating HEAD (TM-04)
  const preCounts = (
    await db.query(`
      select
        (select count(*)::int from public.recruiters) as recruiters_cnt,
        (select count(*)::int from public.direct_entry_capability_grants) as caps_cnt,
        (select count(*)::int from public.direct_entry_scope_grants) as scopes_cnt,
        (select count(*)::int from public.direct_entry_team_leader_assignments) as leaders_cnt
    `)
  ).rows[0];

  // Create valid person A linked to USER_A & RECRUITMENT
  const kP1 = nextKey();
  const fpP1 = computeCreatePersonFingerprint(FULL_ADMIN.app, {
    employee_code: "TD-001",
    full_name: "Nguyễn Văn A",
    joined_on: "2026-01-15",
    initial_department_ref: deptByKey.get("RECRUITMENT").department_id,
    account_ref: USER_A.app,
    expected_account_version: 1,
    recruiter_id: USER_A.recruiter,
    reason: "Tạo nhân sự A",
    idempotency_key: kP1,
  });
  const personA = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'TD-001', 'Nguyễn Văn A', '2026-01-15', $3::uuid, $4::uuid, 1, $5::uuid, 'Tạo nhân sự A', $6::uuid, $7) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        deptByKey.get("RECRUITMENT").department_id,
        USER_A.app,
        USER_A.recruiter,
        kP1,
        fpP1,
      ],
    )
  ).rows[0].data.person;
  assert.equal(personA.employee_code, "TD-001");
  assert.equal(personA.active_account_link.account_ref, USER_A.app);
  assert.equal(personA.active_department.code, "RECRUITMENT");

  // Duplicate case-insensitive employee_code rejected
  await assert.rejects(
    db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'td-001', 'Dup Code', null, null, null, null, null, 'Dup', $3::uuid, $4)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, nextKey(), FP_A],
    ),
    /DUPLICATE_CODE|23505/,
  );

  // TM-07: Recruiter conflict & unconfirmed link mismatch
  // Create unlinked Person C with recruiter_id = null; try linking to USER_C (which has verified recruiter link USER_C.recruiter)
  const kPC = nextKey();
  const personC = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'TD-009', 'Nguyễn C', null, null, null, null, null, 'Tạo nhân sự C', $3::uuid, $4) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        kPC,
        computeCreatePersonFingerprint(FULL_ADMIN.app, {
          employee_code: "TD-009",
          full_name: "Nguyễn C",
          joined_on: null,
          initial_department_ref: null,
          account_ref: null,
          expected_account_version: null,
          recruiter_id: null,
          reason: "Tạo nhân sự C",
          idempotency_key: kPC,
        }),
      ],
    )
  ).rows[0].data.person;

  // Trying to link Person C to USER_A (already linked to TD-001 -> ACCOUNT_OR_PERSON_ALREADY_LINKED)
  // First test linking Person C (recruiter_id = null) to USER_C without confirmed_recruiter_id -> RECRUITER_LINK_MISMATCH
  await assert.rejects(
    db.query(
      "select public.org_department_link_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, null, 'Thiếu confirm', $5::uuid, $6)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, USER_C.app, personC.person_id, nextKey(), FP_A],
    ),
    /RECRUITER_LINK_MISMATCH/,
  );

  // Providing wrong confirmed_recruiter_id while person has recruiter_id = HRP_UNLINKED_RECRUITER -> RECRUITER_IDENTITY_CONFLICT
  const kPB0 = nextKey();
  const personB0 = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'TD-002', 'Trần B0', null, null, null, null, $3::uuid, 'Tạo nhân sự B0', $4::uuid, $5) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        HRP_UNLINKED_RECRUITER,
        kPB0,
        computeCreatePersonFingerprint(FULL_ADMIN.app, {
          employee_code: "TD-002",
          full_name: "Trần B0",
          joined_on: null,
          initial_department_ref: null,
          account_ref: null,
          expected_account_version: null,
          recruiter_id: HRP_UNLINKED_RECRUITER,
          reason: "Tạo nhân sự B0",
          idempotency_key: kPB0,
        }),
      ],
    )
  ).rows[0].data.person;
  await assert.rejects(
    db.query(
      "select public.org_department_link_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, null, 'R1 khac R2', $5::uuid, $6)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, USER_C.app, personB0.person_id, nextKey(), FP_A],
    ),
    /RECRUITER_IDENTITY_CONFLICT/,
  );

  // Confirming USER_C.recruiter on Person C succeeds & propagates recruiter_id!
  const kLinkC = nextKey();
  const fpLinkC = computeLinkAccountPersonFingerprint(FULL_ADMIN.app, USER_C.app, {
    person_id: personC.person_id,
    expected_account_version: 1,
    expected_person_version: 1,
    confirmed_recruiter_id: USER_C.recruiter,
    reason: "Xác nhận recruiter link",
    idempotency_key: kLinkC,
  });
  const linkedC = (
    await db.query(
      "select public.org_department_link_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 1, $5::uuid, 'Xác nhận recruiter link', $6::uuid, $7) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app, USER_C.app, personC.person_id, USER_C.recruiter, kLinkC, fpLinkC],
    )
  ).rows[0].data;
  assert.equal(linkedC.link.account_ref, USER_C.app);

  // Create unlinked Person B in LEGAL_OPS -> blocks deactivating LEGAL_OPS
  const kP2 = nextKey();
  const personB = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'LP-002', 'Trần Thị B', '2026-02-01', $3::uuid, null, null, null, 'Tạo nhân sự B', $4::uuid, $5) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        legalDept.department_id,
        kP2,
        computeCreatePersonFingerprint(FULL_ADMIN.app, {
          employee_code: "LP-002",
          full_name: "Trần Thị B",
          joined_on: "2026-02-01",
          initial_department_ref: legalDept.department_id,
          account_ref: null,
          expected_account_version: null,
          recruiter_id: null,
          reason: "Tạo nhân sự B",
          idempotency_key: kP2,
        }),
      ],
    )
  ).rows[0].data.person;

  await assert.rejects(
    db.query(
      "select public.org_department_update_department_admin($1::uuid, $2::uuid, $3::uuid, 3, 'Phòng Pháp chế', false, 'Đóng', $4::uuid, $5)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, legalDept.department_id, nextKey(), FP_A],
    ),
    /DEPARTMENT_HAS_ACTIVE_ASSIGNMENTS/,
  );

  // Designate HEAD requires active member in same department (OD-WP3-04)
  await assert.rejects(
    db.query(
      "select public.org_department_designate_head_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, null, 'Wrong dept head', $5::uuid, $6)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, deptByKey.get("RECRUITMENT").department_id, personB.person_id, nextKey(), FP_A],
    ),
    /PERSON_NOT_ACTIVE_MEMBER_OF_DEPARTMENT/,
  );

  const recDeptId = deptByKey.get("RECRUITMENT").department_id;
  const kHeadA = nextKey();
  const headARes = (
    await db.query(
      "select public.org_department_designate_head_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, null, 'Bổ nhiệm Trưởng phòng Tuyển dụng', $5::uuid, $6) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        recDeptId,
        personA.person_id,
        kHeadA,
        computeDesignateHeadFingerprint({
          actor_app_user_id: FULL_ADMIN.app,
          department_id: recDeptId,
          person_id: personA.person_id,
          expected_department_version: 1,
          expected_current_head_assignment_id: null,
          reason: "Bổ nhiệm Trưởng phòng Tuyển dụng",
        }),
      ],
    )
  ).rows[0].data;
  assert.equal(headARes.department_version, 2);
  assert.equal(headARes.active_head.person_id, personA.person_id);

  // TM-13: While active HEAD, transfer / end_member / INACTIVE fail with PERSON_IS_ACTIVE_DEPARTMENT_HEAD
  await assert.rejects(
    db.query(
      "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, 'Try transfer', $7::uuid, $8)",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        personA.person_id,
        legalDept.department_id,
        personA.version,
        personA.active_department.membership_id,
        nextKey(),
        FP_A,
      ],
    ),
    /PERSON_IS_ACTIVE_DEPARTMENT_HEAD/,
  );
  await assert.rejects(
    db.query(
      "select public.org_department_end_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, 'Try end member', $6::uuid, $7)",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        recDeptId,
        personA.active_department.membership_id,
        personA.version,
        nextKey(),
        FP_A,
      ],
    ),
    /PERSON_IS_ACTIVE_DEPARTMENT_HEAD/,
  );
  await assert.rejects(
    db.query(
      "select public.org_department_update_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, 'TD-001', 'Nguyễn Văn A', '2026-01-15', 'INACTIVE', 'Try deactivate', $5::uuid, $6)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, personA.person_id, personA.version, nextKey(), FP_A],
    ),
    /PERSON_IS_ACTIVE_DEPARTMENT_HEAD/,
  );

  // OD-WP3-04: Account unlink SUCCEEDS even while Person A is active HEAD
  const kUnlinkA = nextKey();
  const fpUnlinkA = computeUnlinkAccountPersonFingerprint(FULL_ADMIN.app, USER_A.app, {
    expected_account_version: personA.active_account_link.account_version,
    expected_person_version: personA.version,
    expected_link_id: personA.active_account_link.link_id,
    reason: "Gỡ tài khoản dù đang là HEAD",
    idempotency_key: kUnlinkA,
  });
  const unlinkedA = (
    await db.query(
      "select public.org_department_unlink_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, $5::int, $6::uuid, 'Gỡ tài khoản dù đang là HEAD', $7::uuid, $8) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        USER_A.app,
        personA.active_account_link.account_version,
        personA.version,
        personA.active_account_link.link_id,
        kUnlinkA,
        fpUnlinkA,
      ],
    )
  ).rows[0].data;
  assert.ok(unlinkedA.ended_link.ended_at);

  // TM-04 & OD-WP3-05: Zero new rows in recruiters, capability_grants, scope_grants, team_leader_memberships, leave_department_approvers
  const postCounts = (
    await db.query(`
      select
        (select count(*)::int from public.recruiters) as recruiters_cnt,
        (select count(*)::int from public.direct_entry_capability_grants) as caps_cnt,
        (select count(*)::int from public.direct_entry_scope_grants) as scopes_cnt,
        (select count(*)::int from public.direct_entry_team_leader_assignments) as leaders_cnt,
        (select count(*)::int from public.leave_department_approvers) as approvers_cnt
    `)
  ).rows[0];
  assert.equal(postCounts.recruiters_cnt, preCounts.recruiters_cnt);
  assert.equal(postCounts.caps_cnt, preCounts.caps_cnt);
  assert.equal(postCounts.scopes_cnt, preCounts.scopes_cnt);
  assert.equal(postCounts.leaders_cnt, preCounts.leaders_cnt);
  assert.equal(postCounts.approvers_cnt, 0);

  // End HEAD on Person A -> now transfer to LEGAL_OPS succeeds!
  const kEndHeadA = nextKey();
  await db.query(
    "select public.org_department_end_head_admin($1::uuid, $2::uuid, $3::uuid, 2, $4::uuid, 'Kết thúc nhiệm kỳ Trưởng phòng', $5::uuid, $6)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      recDeptId,
      headARes.active_head.head_assignment_id,
      kEndHeadA,
      computeEndHeadFingerprint({
        actor_app_user_id: FULL_ADMIN.app,
        department_id: recDeptId,
        expected_department_version: 2,
        expected_current_head_assignment_id: headARes.active_head.head_assignment_id,
        reason: "Kết thúc nhiệm kỳ Trưởng phòng",
      }),
    ],
  );

  const personAAfterEndHead = (
    await db.query(
      "select public.org_department_get_person_admin($1::uuid, $2::uuid, $3::uuid, null) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app, personA.person_id],
    )
  ).rows[0].data.person;

  const kTransferA = nextKey();
  const transferRes = (
    await db.query(
      "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, 'Điều chuyển sang Pháp chế', $7::uuid, $8) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        personA.person_id,
        legalDept.department_id,
        personAAfterEndHead.version,
        personAAfterEndHead.active_department.membership_id,
        kTransferA,
        computeTransferPersonDepartmentFingerprint(FULL_ADMIN.app, personA.person_id, {
          target_department_ref: legalDept.department_id,
          expected_person_version: personAAfterEndHead.version,
          expected_current_membership_id: personAAfterEndHead.active_department.membership_id,
          reason: "Điều chuyển sang Pháp chế",
          idempotency_key: kTransferA,
        }),
      ],
    )
  ).rows[0].data;
  assert.equal(transferRes.closed_membership.ended_at, transferRes.active_membership.started_at);

  await db.close();
});

test("TM-08, TM-11 & TM-14: Intra-day ACCOUNTING/MKT & link swap, stale form >= 2 hops, idempotency BEFORE OCC", async () => {
  const db = await createMigratedWp3Database();
  await seedWp3BaseData(db);

  const deptsList = (
    await db.query(
      "select public.org_department_list_departments_admin($1::uuid, $2::uuid, false, null) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app],
    )
  ).rows[0].data;
  const recDept = deptsList.departments.find((d) => d.system_key === "RECRUITMENT");
  const mktDept = deptsList.departments.find((d) => d.system_key === "MARKETING");
  const acctDept = deptsList.departments.find((d) => d.system_key === "ACCOUNTING");

  // Create person + assign to ACCOUNTING (T1), link USER_ACCT, transfer to MARKETING (T2), transfer back to ACCOUNTING (T3), end (T4)
  const kCreate = nextKey();
  const fpCreate = computeCreatePersonFingerprint(FULL_ADMIN.app, {
    employee_code: "TMP-08",
    full_name: "Nhân Sự Lịch Sử",
    joined_on: "2026-11-01",
    initial_department_ref: acctDept.department_id,
    account_ref: USER_ACCT.app,
    expected_account_version: 1,
    recruiter_id: null,
    reason: "TM-08 create in ACCOUNTING",
    idempotency_key: kCreate,
  });
  const createOut = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'TMP-08', 'Nhân Sự Lịch Sử', '2026-11-01', $3::uuid, $4::uuid, 1, null, 'TM-08 create in ACCOUNTING', $5::uuid, $6) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app, acctDept.department_id, USER_ACCT.app, kCreate, fpCreate],
    )
  ).rows[0].data;
  const p = createOut.person;
  await sleep(20);
  const tAtT1 = (await db.query("select clock_timestamp() as ts")).rows[0].ts.toISOString();
  await sleep(20);

  // Swap account link U_ACCT -> unlink -> link U_SHARED is blocked, so link USER_B (while Person is in ACCOUNTING -> projects USER_B into ACCOUNTING!)
  const kUnlink = nextKey();
  const unlinkOut = (
    await db.query(
      "select public.org_department_unlink_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, $5::int, $6::uuid, 'Gỡ U1', $7::uuid, $8) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        USER_ACCT.app,
        p.active_account_link.account_version,
        p.version,
        p.active_account_link.link_id,
        kUnlink,
        computeUnlinkAccountPersonFingerprint(FULL_ADMIN.app, USER_ACCT.app, {
          expected_account_version: p.active_account_link.account_version,
          expected_person_version: p.version,
          expected_link_id: p.active_account_link.link_id,
          reason: "Gỡ U1",
          idempotency_key: kUnlink,
        }),
      ],
    )
  ).rows[0].data;

  // Transfer ACCOUNTING -> MARKETING (bump version!)
  const kTrMkt = nextKey();
  const fpTrMkt = computeTransferPersonDepartmentFingerprint(FULL_ADMIN.app, p.person_id, {
    target_department_ref: mktDept.department_id,
    expected_person_version: unlinkOut.person_version,
    expected_current_membership_id: p.active_department.membership_id,
    reason: "Sang MKT lúc T2",
    idempotency_key: kTrMkt,
  });
  const trMktOut = (
    await db.query(
      "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, 'Sang MKT lúc T2', $7::uuid, $8) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        p.person_id,
        mktDept.department_id,
        unlinkOut.person_version,
        p.active_department.membership_id,
        kTrMkt,
        fpTrMkt,
      ],
    )
  ).rows[0].data;
  await sleep(20);
  const tAtT2 = (await db.query("select clock_timestamp() as ts")).rows[0].ts.toISOString();
  await sleep(20);

  // Transfer MARKETING -> ACCOUNTING (intra-day re-entry into ACCOUNTING!)
  const kTrAcct = nextKey();
  const trAcctOut = (
    await db.query(
      "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, 'Quay lại ACCOUNTING lúc T3', $7::uuid, $8) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        p.person_id,
        acctDept.department_id,
        trMktOut.person_version,
        trMktOut.active_membership.membership_id,
        kTrAcct,
        computeTransferPersonDepartmentFingerprint(FULL_ADMIN.app, p.person_id, {
          target_department_ref: acctDept.department_id,
          expected_person_version: trMktOut.person_version,
          expected_current_membership_id: trMktOut.active_membership.membership_id,
          reason: "Quay lại ACCOUNTING lúc T3",
          idempotency_key: kTrAcct,
        }),
      ],
    )
  ).rows[0].data;
  await sleep(20);
  const tAtT3 = (await db.query("select clock_timestamp() as ts")).rows[0].ts.toISOString();
  await sleep(20);

  // Link USER_B while Person is in ACCOUNTING -> USER_B now gets active ACCOUNTING projection, USER_ACCT stayed closed
  const kLinkU2 = nextKey();
  const linkU2Out = (
    await db.query(
      "select public.org_department_link_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5::int, $6::uuid, 'Link U2 trong ACCOUNTING', $7::uuid, $8) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        USER_B.app,
        p.person_id,
        trAcctOut.person_version,
        USER_B.recruiter,
        kLinkU2,
        computeLinkAccountPersonFingerprint(FULL_ADMIN.app, USER_B.app, {
          person_id: p.person_id,
          expected_account_version: 1,
          expected_person_version: trAcctOut.person_version,
          confirmed_recruiter_id: USER_B.recruiter,
          reason: "Link U2 trong ACCOUNTING",
          idempotency_key: kLinkU2,
        }),
      ],
    )
  ).rows[0].data;
  assert.equal(
    (
      await db.query(
        "select count(*)::int as cnt from public.organization_department_memberships where app_user_id = $1::uuid and valid_to is null",
        [USER_B.app],
      )
    ).rows[0].cnt,
    1,
  );

  // End ACCOUNTING membership at T4
  const kEndMem = nextKey();
  const endMemOut = (
    await db.query(
      "select public.org_department_end_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, 'Rời ACCOUNTING lúc T4', $6::uuid, $7) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        acctDept.department_id,
        trAcctOut.active_membership.membership_id,
        linkU2Out.person_version,
        kEndMem,
        computeEndPersonMemberFingerprint({
          actor_app_user_id: FULL_ADMIN.app,
          department_id: acctDept.department_id,
          membership_id: trAcctOut.active_membership.membership_id,
          expected_person_version: linkU2Out.person_version,
          reason: "Rời ACCOUNTING lúc T4",
        }),
      ],
    )
  ).rows[0].data;
  await sleep(20);
  const tAtT4 = (await db.query("select clock_timestamp() as ts")).rows[0].ts.toISOString();

  // Verify as_of reconstruction across T1, T2, T3, T4!
  assert.equal(
    (
      await db.query(
        "select public.org_department_get_person_admin($1::uuid, $2::uuid, $3::uuid, $4::timestamptz) as data",
        [FULL_ADMIN.auth, FULL_ADMIN.app, p.person_id, tAtT1],
      )
    ).rows[0].data.person.active_department.code,
    "ACCOUNTING",
  );
  assert.equal(
    (
      await db.query(
        "select public.org_department_get_person_admin($1::uuid, $2::uuid, $3::uuid, $4::timestamptz) as data",
        [FULL_ADMIN.auth, FULL_ADMIN.app, p.person_id, tAtT2],
      )
    ).rows[0].data.person.active_department.code,
    "MARKETING",
  );
  assert.equal(
    (
      await db.query(
        "select public.org_department_get_person_admin($1::uuid, $2::uuid, $3::uuid, $4::timestamptz) as data",
        [FULL_ADMIN.auth, FULL_ADMIN.app, p.person_id, tAtT3],
      )
    ).rows[0].data.person.active_department.code,
    "ACCOUNTING",
  );
  assert.equal(
    (
      await db.query(
        "select public.org_department_get_person_admin($1::uuid, $2::uuid, $3::uuid, $4::timestamptz) as data",
        [FULL_ADMIN.auth, FULL_ADMIN.app, p.person_id, tAtT4],
      )
    ).rows[0].data.person.active_department,
    null,
  );

  // TM-11: Stale form after >= 2 hops (using original membership_id from T1 and stale version) -> VERSION_CONFLICT (PT409)
  await assert.rejects(
    db.query(
      "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, 'Stale form', $7::uuid, $8)",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        p.person_id,
        recDept.department_id,
        p.version,
        p.active_department.membership_id,
        nextKey(),
        FP_A,
      ],
    ),
    /VERSION_CONFLICT/,
  );

  // Also test HEAD stale form after >= 2 replacements H1 -> H2 -> H3
  const pH1 = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'HD-01', 'Head 1', null, $3::uuid, null, null, null, 'H1', $4::uuid, $5) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        recDept.department_id,
        nextKey(),
        computeCreatePersonFingerprint(FULL_ADMIN.app, {
          employee_code: "HD-01",
          full_name: "Head 1",
          joined_on: null,
          initial_department_ref: recDept.department_id,
          account_ref: null,
          expected_account_version: null,
          recruiter_id: null,
          reason: "H1",
          idempotency_key: "x",
        }),
      ],
    )
  ).rows[0].data.person;
  const pH2 = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'HD-02', 'Head 2', null, $3::uuid, null, null, null, 'H2', $4::uuid, $5) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        recDept.department_id,
        nextKey(),
        computeCreatePersonFingerprint(FULL_ADMIN.app, {
          employee_code: "HD-02",
          full_name: "Head 2",
          joined_on: null,
          initial_department_ref: recDept.department_id,
          account_ref: null,
          expected_account_version: null,
          recruiter_id: null,
          reason: "H2",
          idempotency_key: "x",
        }),
      ],
    )
  ).rows[0].data.person;
  const pH3 = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'HD-03', 'Head 3', null, $3::uuid, null, null, null, 'H3', $4::uuid, $5) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        recDept.department_id,
        nextKey(),
        computeCreatePersonFingerprint(FULL_ADMIN.app, {
          employee_code: "HD-03",
          full_name: "Head 3",
          joined_on: null,
          initial_department_ref: recDept.department_id,
          account_ref: null,
          expected_account_version: null,
          recruiter_id: null,
          reason: "H3",
          idempotency_key: "x",
        }),
      ],
    )
  ).rows[0].data.person;

  const h1 = (
    await db.query(
      "select public.org_department_designate_head_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, null, 'H1', $5::uuid, $6) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        recDept.department_id,
        pH1.person_id,
        nextKey(),
        computeDesignateHeadFingerprint({
          actor_app_user_id: FULL_ADMIN.app,
          department_id: recDept.department_id,
          person_id: pH1.person_id,
          expected_department_version: 1,
          expected_current_head_assignment_id: null,
          reason: "H1",
        }),
      ],
    )
  ).rows[0].data;
  const h2 = (
    await db.query(
      "select public.org_department_designate_head_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, $5::uuid, 'H2', $6::uuid, $7) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        recDept.department_id,
        pH2.person_id,
        h1.active_head.head_assignment_id,
        nextKey(),
        computeDesignateHeadFingerprint({
          actor_app_user_id: FULL_ADMIN.app,
          department_id: recDept.department_id,
          person_id: pH2.person_id,
          expected_department_version: 2,
          expected_current_head_assignment_id: h1.active_head.head_assignment_id,
          reason: "H2",
        }),
      ],
    )
  ).rows[0].data;
  await db.query(
    "select public.org_department_designate_head_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 3, $5::uuid, 'H3', $6::uuid, $7) as data",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      recDept.department_id,
      pH3.person_id,
      h2.active_head.head_assignment_id,
      nextKey(),
      computeDesignateHeadFingerprint({
        actor_app_user_id: FULL_ADMIN.app,
        department_id: recDept.department_id,
        person_id: pH3.person_id,
        expected_department_version: 3,
        expected_current_head_assignment_id: h2.active_head.head_assignment_id,
        reason: "H3",
      }),
    ],
  );
  // Stale designate after H1 -> H2 -> H3 fails VERSION_CONFLICT
  await assert.rejects(
    db.query(
      "select public.org_department_designate_head_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, $5::uuid, 'Stale HEAD', $6::uuid, $7)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, recDept.department_id, pH1.person_id, h1.active_head.head_assignment_id, nextKey(), FP_A],
    ),
    /VERSION_CONFLICT/,
  );

  // TM-14: Idempotency BEFORE OCC — replay kTrMkt AFTER person_version already moved from T2 to T4/ended!
  assert.ok(endMemOut.person_version > trMktOut.person_version);
  const replayTrMkt = (
    await db.query(
      "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, 'Sang MKT lúc T2', $7::uuid, $8) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        p.person_id,
        mktDept.department_id,
        unlinkOut.person_version,
        p.active_department.membership_id,
        kTrMkt,
        fpTrMkt,
      ],
    )
  ).rows[0].data;
  assert.equal(replayTrMkt.replayed, true);
  assert.equal(replayTrMkt.active_membership.membership_id, trMktOut.active_membership.membership_id);

  // Reusing kCreate on different operation (update_person), different target, or mutated payload -> IDEMPOTENCY_CONFLICT!
  await assert.rejects(
    db.query(
      "select public.org_department_update_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, 'TMP-08', 'New Name', '2026-11-01', 'ACTIVE', 'Reuse key', $5::uuid, $6)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, p.person_id, endMemOut.person_version, kCreate, FP_B],
    ),
    /IDEMPOTENCY_CONFLICT|23505/,
  );
  await assert.rejects(
    db.query(
      "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, 'Different target', $7::uuid, $8)",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        pH1.person_id,
        mktDept.department_id,
        pH1.version,
        pH1.active_department.membership_id,
        kTrMkt,
        FP_B,
      ],
    ),
    /IDEMPOTENCY_CONFLICT|23505/,
  );
  await assert.rejects(
    db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'TMP-99', 'Other Person', null, null, null, null, null, 'TM-08', $3::uuid, $4)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, kCreate, FP_B],
    ),
    /IDEMPOTENCY_CONFLICT|23505/,
  );

  await db.close();
});

test("TM-05, TM-06 & TM-09: Leave guard/sync, ACCOUNTING legacy RPC parity, 3-way display name sync, team guard & enable/disable", async () => {
  const db = await createMigratedWp3Database();
  await seedWp3BaseData(db);

  const deptsList = (
    await db.query(
      "select public.org_department_list_departments_admin($1::uuid, $2::uuid, false, null) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app],
    )
  ).rows[0].data;
  const recDept = deptsList.departments.find((d) => d.system_key === "RECRUITMENT");
  const acctDept = deptsList.departments.find((d) => d.system_key === "ACCOUNTING");
  const mktDept = deptsList.departments.find((d) => d.system_key === "MARKETING");

  // TM-09: direct_entry_create_team binds RECRUITMENT; raw null/ACCOUNTING rejected; __system_vendor__ stays null
  const createdTeam = (
    await db.query(
      "select public.direct_entry_create_team($1::uuid, $2::uuid, 0, 'GAMMA', 'Nhóm Gamma', 'Tạo team mới', $3) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app, nextKey()],
    )
  ).rows[0].data;
  assert.equal(
    (await db.query("select department_id from public.teams where team_id = $1::uuid", [createdTeam.team_id]))
      .rows[0].department_id,
    recDept.department_id,
  );
  assert.equal(
    (await db.query("select department_id from public.teams where team_id = $1::uuid", [SYS_VENDOR_TEAM])).rows[0]
      .department_id,
    null,
  );
  const rawNullTeam = (
    await db.query(
      "insert into public.teams (code, display_name, active, department_id) values ('RAW_NULL', 'Raw Null', true, null) returning department_id",
    )
  ).rows[0];
  assert.equal(rawNullTeam.department_id, recDept.department_id);
  await assert.rejects(
    db.query("update public.teams set department_id = $2::uuid where team_id = $1::uuid", [
      SYS_VENDOR_TEAM,
      recDept.department_id,
    ]),
    /SYSTEM_VENDOR_TEAM_DEPARTMENT_FORBIDDEN/,
  );
  await assert.rejects(
    db.query("insert into public.teams (code, display_name, active, department_id) values ('BAD2', 'Bad 2', true, $1::uuid)", [
      acctDept.department_id,
    ]),
    /TEAM_DEPARTMENT_MUST_BE_RECRUITMENT/,
  );

  // TM-05: Seed leave_employee_profiles -> create Person linked to USER_ACCT with 0 depts -> legacy assign_accounting_member opens both!
  await db.query(
    `insert into public.leave_employee_profiles (app_user_id, is_shared_non_employee, employment_status, unit_kind, work_start_date, row_version, updated_by_app_user_id)
     values ($1::uuid, false, 'PROBATION', 'UNCLASSIFIED', '2025-05-01', 1, $2::uuid)`,
    [USER_ACCT.app, FULL_ADMIN.app],
  );
  const kPAcct = nextKey();
  const personAcct = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'KT-005', 'Kế Toán C', '2026-03-01', null, $3::uuid, 1, null, 'Chưa gắn phòng', $4::uuid, $5) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        USER_ACCT.app,
        kPAcct,
        computeCreatePersonFingerprint(FULL_ADMIN.app, {
          employee_code: "KT-005",
          full_name: "Kế Toán C",
          joined_on: "2026-03-01",
          initial_department_ref: null,
          account_ref: USER_ACCT.app,
          expected_account_version: 1,
          recruiter_id: null,
          reason: "Chưa gắn phòng",
          idempotency_key: kPAcct,
        }),
      ],
    )
  ).rows[0].data.person;

  // Assign via legacy org_department_assign_accounting_member while Person has 0 depts -> opens both WP3 & legacy rows!
  const kLegAssign = nextKey();
  await db.query(
    "select public.org_department_assign_accounting_member($1::uuid, $2::uuid, $3::uuid, 0, null, 'Assign accounting legacy', $4::uuid, $5)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      USER_ACCT.app,
      kLegAssign,
      computeAssignAccountingMemberFingerprint({
        actor_app_user_id: FULL_ADMIN.app,
        account_ref: USER_ACCT.app,
        expected_pair_version: 0,
        effective_from: null,
        reason: "Assign accounting legacy",
      }),
    ],
  );
  const pAfterLegAssign = (
    await db.query(
      "select public.org_department_get_person_admin($1::uuid, $2::uuid, $3::uuid, null) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app, personAcct.person_id],
    )
  ).rows[0].data.person;
  assert.equal(pAfterLegAssign.active_department.code, "ACCOUNTING");

  // Disable then re-enable USER_ACCT -> link & membership remain intact (TM-01 runtime part)
  await db.query(
    "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, 2, 'Tạm khóa', $4)",
    [FULL_ADMIN.auth, FULL_ADMIN.app, USER_ACCT.app, nextKey()],
  );
  await assert.rejects(
    db.query("select public.direct_entry_assert_actor_app_user_admin($1::uuid, $2::uuid)", [
      USER_ACCT.auth,
      USER_ACCT.app,
    ]),
    /actor mapping denied|42501/,
  );
  await db.query(
    "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, 3, 'Mở khóa', $4)",
    [FULL_ADMIN.auth, FULL_ADMIN.app, USER_ACCT.app, nextKey()],
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as cnt from public.organization_account_person_links where app_user_id = $1::uuid and ended_at is null",
        [USER_ACCT.app],
      )
    ).rows[0].cnt,
    1,
  );

  // Transfer ACCOUNTING -> MARKETING closes legacy row & syncs leave_employee_profiles.unit_kind = 'MARKETING'
  const kTr = nextKey();
  await db.query(
    "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, 'Sang Marketing', $7::uuid, $8)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      personAcct.person_id,
      mktDept.department_id,
      pAfterLegAssign.version,
      pAfterLegAssign.active_department.membership_id,
      kTr,
      computeTransferPersonDepartmentFingerprint(FULL_ADMIN.app, personAcct.person_id, {
        target_department_ref: mktDept.department_id,
        expected_person_version: pAfterLegAssign.version,
        expected_current_membership_id: pAfterLegAssign.active_department.membership_id,
        reason: "Sang Marketing",
        idempotency_key: kTr,
      }),
    ],
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as cnt from public.organization_department_memberships where app_user_id = $1::uuid and valid_to is null",
        [USER_ACCT.app],
      )
    ).rows[0].cnt,
    0,
  );
  const lpRow = (
    await db.query(
      "select unit_kind, work_start_date::text as ws, row_version from public.leave_employee_profiles where app_user_id = $1::uuid",
      [USER_ACCT.app],
    )
  ).rows[0];
  assert.equal(lpRow.unit_kind, "MARKETING");
  assert.equal(lpRow.ws, "2025-05-01");

  // TM-05 Leave guard: leave_management_upsert_employee_profile_admin CANNOT change unit_kind or is_shared_non_employee,
  // while updating employment_status ('PROBATION' -> 'OFFICIAL') with matching unit_kind = 'MARKETING' SUCCEEDS!
  const badLeaveReq = parsePatchAdminConfigBody(
    {
      operation: "UPSERT_EMPLOYEE_PROFILE",
      target_app_user_id: USER_ACCT.app,
      is_shared_non_employee: false,
      employment_status: "OFFICIAL",
      unit_kind: "IT",
      work_start_date: "2025-05-01",
      official_effective_date: "2026-05-01",
      next_seniority_effective_date: null,
      next_seniority_units: 0,
      expected_row_version: lpRow.row_version,
      reason: "Thử đổi unit_kind trái phép",
      idempotency_key: nextKey(),
    },
    "2026-11-13",
  );
  assert.equal(badLeaveReq.ok, true);
  await assert.rejects(
    db.query(
      "select public.leave_management_upsert_employee_profile_admin($1::uuid,$2::uuid,$3::uuid,$4::boolean,$5,$6,$7::date,$8::date,$9::date,$10::int,$11::int,$12,$13,$14)",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        badLeaveReq.data.target_app_user_id,
        badLeaveReq.data.is_shared_non_employee,
        badLeaveReq.data.employment_status,
        badLeaveReq.data.unit_kind,
        badLeaveReq.data.work_start_date,
        badLeaveReq.data.official_effective_date,
        badLeaveReq.data.next_seniority_effective_date,
        badLeaveReq.data.next_seniority_units,
        badLeaveReq.data.expected_row_version,
        badLeaveReq.data.reason,
        badLeaveReq.data.idempotency_key,
        badLeaveReq.data.request_fingerprint,
      ],
    ),
    /LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN/,
  );

  const okLeaveReq = parsePatchAdminConfigBody(
    {
      operation: "UPSERT_EMPLOYEE_PROFILE",
      target_app_user_id: USER_ACCT.app,
      is_shared_non_employee: false,
      employment_status: "OFFICIAL",
      unit_kind: "MARKETING",
      work_start_date: "2025-05-01",
      official_effective_date: "2026-05-01",
      next_seniority_effective_date: null,
      next_seniority_units: 0,
      expected_row_version: lpRow.row_version,
      reason: "Cập nhật OFFICIAL trong Leave Admin",
      idempotency_key: nextKey(),
    },
    "2026-11-13",
  );
  assert.equal(okLeaveReq.ok, true);
  await db.query(
    "select public.leave_management_upsert_employee_profile_admin($1::uuid,$2::uuid,$3::uuid,$4::boolean,$5,$6,$7::date,$8::date,$9::date,$10::int,$11::int,$12,$13,$14)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      okLeaveReq.data.target_app_user_id,
      okLeaveReq.data.is_shared_non_employee,
      okLeaveReq.data.employment_status,
      okLeaveReq.data.unit_kind,
      okLeaveReq.data.work_start_date,
      okLeaveReq.data.official_effective_date,
      okLeaveReq.data.next_seniority_effective_date,
      okLeaveReq.data.next_seniority_units,
      okLeaveReq.data.expected_row_version,
      okLeaveReq.data.reason,
      okLeaveReq.data.idempotency_key,
      okLeaveReq.data.request_fingerprint,
    ],
  );
  assert.equal(
    (
      await db.query("select employment_status from public.leave_employee_profiles where app_user_id = $1::uuid", [
        USER_ACCT.app,
      ])
    ).rows[0].employment_status,
    "OFFICIAL",
  );

  // Calling legacy assign_accounting_member while Person is in MARKETING fails PERSON_ALREADY_IN_OTHER_DEPARTMENT!
  await assert.rejects(
    db.query(
      "select public.org_department_assign_accounting_member($1::uuid, $2::uuid, $3::uuid, 2, null, 'Try legacy assign', $4::uuid, $5)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, USER_ACCT.app, nextKey(), FP_A],
    ),
    /PERSON_ALREADY_IN_OTHER_DEPARTMENT/,
  );

  // TM-06: 3-way display name sync across ALL 3 writers!
  const kPA = nextKey();
  const personA = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'TD-010', 'Tên Gốc 1', null, $3::uuid, $4::uuid, 1, $5::uuid, 'Tạo A', $6::uuid, $7) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        recDept.department_id,
        USER_A.app,
        USER_A.recruiter,
        kPA,
        computeCreatePersonFingerprint(FULL_ADMIN.app, {
          employee_code: "TD-010",
          full_name: "Tên Gốc 1",
          joined_on: null,
          initial_department_ref: recDept.department_id,
          account_ref: USER_A.app,
          expected_account_version: 1,
          recruiter_id: USER_A.recruiter,
          reason: "Tạo A",
          idempotency_key: kPA,
        }),
      ],
    )
  ).rows[0].data.person;

  // Writer 1: org_department_update_person_admin
  const kUp1 = nextKey();
  const up1 = (
    await db.query(
      "select public.org_department_update_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, 'TD-010', 'Tên Từ Person RPC', null, 'ACTIVE', 'Sync 1', $5::uuid, $6) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        personA.person_id,
        personA.version,
        kUp1,
        computeUpdatePersonFingerprint(FULL_ADMIN.app, personA.person_id, {
          expected_person_version: personA.version,
          employee_code: "TD-010",
          full_name: "Tên Từ Person RPC",
          joined_on: null,
          status: "ACTIVE",
          reason: "Sync 1",
          idempotency_key: kUp1,
        }),
      ],
    )
  ).rows[0].data.person;
  assert.equal(up1.full_name, "Tên Từ Person RPC");
  const checkSync = async (expectedName) => {
    const r = (
      await db.query(
        `select p.full_name, u.display_name as acc_name, r.display_name as rec_name, p.version as p_ver, u.version as u_ver,
                r.version as r_ver
           from public.organization_persons p
           join public.organization_account_person_links l on l.person_id = p.person_id and l.ended_at is null
           join public.direct_entry_app_users u on u.app_user_id = l.app_user_id
           join public.recruiters r on r.recruiter_id = p.recruiter_id
          where p.person_id = $1::uuid`,
        [personA.person_id],
      )
    ).rows[0];
    assert.equal(r.full_name, expectedName);
    assert.equal(r.acc_name, expectedName);
    assert.equal(r.rec_name, expectedName);
    return r;
  };
  let cur = await checkSync("Tên Từ Person RPC");

  // Writer 2: direct_entry_account_operation_update_display_name
  await db.query(
    "select public.direct_entry_account_operation_update_display_name($1::uuid, $2::uuid, $3::uuid, 'Tên Từ Account RPC', $4::int, 'Sync 2', $5)",
    [FULL_ADMIN.auth, FULL_ADMIN.app, USER_A.app, cur.u_ver, nextKey()],
  );
  cur = await checkSync("Tên Từ Account RPC");

  // Writer 3: direct_entry_update_personnel
  await db.query(
    "select public.direct_entry_update_personnel($1::uuid, $2::uuid, $3::uuid, $4::int, 'Tên Từ Personnel RPC', $5, 'STAFF', 'Sync 3', $6)",
    [FULL_ADMIN.auth, FULL_ADMIN.app, USER_A.recruiter, cur.r_ver, USER_A.personnelCode, nextKey()],
  );
  await checkSync("Tên Từ Personnel RPC");

  await db.close();
});

test("NWC backfill requires explicit staging mode and refuses other remote targets", () => {
  const direct = "postgresql://postgres:x@db.nwcvmigrhzdywaumkrjp.supabase.co:5432/postgres";
  const pooler = "postgresql://postgres.nwcvmigrhzdywaumkrjp:x@aws-0-region.pooler.supabase.com:5432/postgres";
  for (const uri of [direct, pooler]) {
    assert.throws(() => assertSafeBackfillConnectionTarget(uri, { allowRemoteTarget: true }), /BACKFILL_FORBIDDEN_NWC_TARGET/);
    assert.equal(assertSafeBackfillConnectionTarget(uri, { nwcStaging: true }), uri);
  }
  for (const uri of [
    "postgresql://postgres:x@db.otherproject.supabase.co:5432/postgres",
    "postgresql://postgres.otherproject:x@aws-0-region.pooler.supabase.com:5432/postgres",
    "postgresql://postgres.nwcvmigrhzdywaumkrjp:x@untrusted.example:5432/postgres",
  ]) {
    assert.throws(() => assertSafeBackfillConnectionTarget(uri, { nwcStaging: true, allowRemoteTarget: true }), /BACKFILL_NWC_TARGET_MISMATCH/);
  }
});

test("TM-01, TM-02, TM-03, TM-16 & TM-17: Q1 audit, BACKFILL_DATE_EVIDENCE timestamp invariant, SHARED/SERVICE, disabled account, OD-WP3-05 leave approver separation & self_check 1..7", async () => {
  const db = await createMigratedWp3Database();
  await seedWp3BaseData(db);

  // NWC safety guard
  assert.throws(
    () =>
      assertSafeBackfillConnectionTarget(
        "postgresql://postgres:x@db.nwcvmigrhzdywaumkrjp.supabase.co:5432/postgres",
      ),
    /BACKFILL_FORBIDDEN_NWC_TARGET/,
  );

  // TM-02 & OD-WP3-05: Seed active leave_department_approvers for ACCOUNTING BEFORE backfill -> backfill produces 0 automatic HEAD!
  await db.query(
    `insert into public.leave_department_approvers (unit_kind, approver_app_user_id, valid_from, valid_to, is_current, reason, row_version, updated_by_app_user_id)
     values ('ACCOUNTING', $1::uuid, '2026-01-01', null, true, 'Existing leave approver', 1, $2::uuid)`,
    [USER_B.app, FULL_ADMIN.app],
  );

  // TM-16: Seed direct_entries (exact schema columns!), PM rows, team memberships on HRP_UNLINKED_RECRUITER (0 links) & USER_A.recruiter (1 link)
  await db.query(
    `insert into public.direct_entry_projects (project_id, display_name, active, version)
     values ('p_q1', 'Q1 Proj', true, 1), ('p_q2', 'Q2 Proj', true, 1)`,
  );
  await db.query(
    `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, valid_to, is_current)
     values ($1::uuid, $4::uuid, '2026-01-01', '2026-01-31', false),
            ($1::uuid, $3::uuid, '2026-02-01', null, true),
            ($2::uuid, $4::uuid, '2026-01-01', '2026-01-31', false),
            ($2::uuid, $3::uuid, '2026-02-01', null, true)`,
    [HRP_UNLINKED_RECRUITER, USER_A.recruiter, TEAM_ALPHA, TEAM_BETA],
  );
  const subId = "61000000-0000-4000-8000-000000000001";
  const candIds = [
    "62000000-0000-4000-8000-000000000001",
    "62000000-0000-4000-8000-000000000002",
    "62000000-0000-4000-8000-000000000003",
    "62000000-0000-4000-8000-000000000004",
  ];
  await db.query("begin");
  try {
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1::uuid, $2::uuid, 'DRAFT')",
      [subId, FULL_ADMIN.app],
    );
    for (const cid of candIds) {
      await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1::uuid)", [cid]);
    }
    const validWorker = JSON.stringify({
      display_name: "Công nhân Q1",
      date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    });
    await db.query(
      `insert into public.direct_entries (submission_id, candidate_id, created_by_user_id, project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type)
       values ($1::uuid, $2::uuid, $6::uuid, 'p_q1', '2026-11-10', 'hrp-2026-000001', $10::jsonb, $7::uuid, $8::uuid, 'hrp', 'TEMPORARY'),
              ($1::uuid, $3::uuid, $6::uuid, 'p_q1', '2026-11-11', 'hrp-2026-000002', $10::jsonb, $7::uuid, $8::uuid, 'hrp', 'TEMPORARY'),
              ($1::uuid, $4::uuid, $6::uuid, 'p_q1', '2026-11-10', 'hrp-2026-000003', $10::jsonb, $9::uuid, $8::uuid, 'hrp', 'TEMPORARY'),
              ($1::uuid, $5::uuid, $6::uuid, 'p_q1', '2026-11-11', 'hrp-2026-000004', $10::jsonb, $9::uuid, $8::uuid, 'hrp', 'TEMPORARY')`,
      [
        subId,
        candIds[0],
        candIds[1],
        candIds[2],
        candIds[3],
        FULL_ADMIN.app,
        HRP_UNLINKED_RECRUITER,
        TEAM_ALPHA,
        USER_A.recruiter,
        validWorker,
      ],
    );
    await db.query("commit");
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
  await db.query(
    `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, valid_to, is_current, revoked_at)
     values ('p_q1', $1::uuid, '2025-12-01', '2025-12-31', false, '2025-12-31T00:00:00Z'),
            ('p_q1', $1::uuid, '2026-01-01', null, true, null),
            ('p_q2', $1::uuid, '2026-02-01', null, true, null),
            ('p_q1', $2::uuid, '2026-01-01', null, true, null),
            ('p_q2', $2::uuid, '2026-02-01', null, true, null)`,
    [HRP_UNLINKED_RECRUITER, USER_A.recruiter],
  );

  const q1Rows = await runQ1HrpRecruiterAudit(db, { manageTransaction: true });
  const unlinkedMetric = q1Rows.find((r) => r.recruiter_id === HRP_UNLINKED_RECRUITER);
  assert.ok(unlinkedMetric);
  assert.equal(unlinkedMetric.active_verified_link_count, 0);
  assert.equal(unlinkedMetric.worker_entries_count, 2);
  assert.equal(unlinkedMetric.active_pm_count, 2);
  assert.equal(unlinkedMetric.total_pm_history_count, 3);
  assert.equal(unlinkedMetric.active_team_count, 1);
  assert.equal(q1Rows.find((r) => r.recruiter_id === USER_A.recruiter), undefined);

  // TM-01 + TM-17: Seed legacy ACCOUNTING for USER_ACCT, USER_DISABLED (enabled=false!), and USER_CONFLICT (+ historical work_report_obligations)
  const acctDept = (
    await db.query("select department_id from public.organization_departments where system_key = 'ACCOUNTING'")
  ).rows[0];
  await db.query(
    `insert into public.organization_department_memberships (department_id, app_user_id, valid_from, valid_to, version, granted_by_user_id, grant_reason)
     values ($1::uuid, $2::uuid, '2026-01-01', null, 1, $5::uuid, 'Legacy acct C'),
            ($1::uuid, $3::uuid, '2026-01-01', null, 1, $5::uuid, 'Legacy acct D disabled'),
            ($1::uuid, $4::uuid, '2026-01-01', null, 1, $5::uuid, 'Conflict acct')`,
    [acctDept.department_id, USER_ACCT.app, USER_DISABLED.app, USER_CONFLICT.app, FULL_ADMIN.app],
  );

  const tpl = (
    await db.query(
      `insert into public.work_report_templates (template_code, display_name, default_frequency, status, created_by_user_id)
       values ('TPL_WP3B', 'Báo cáo tuần', 'DAILY', 'ACTIVE', $1::uuid) returning template_id`,
      [FULL_ADMIN.app],
    )
  ).rows[0];
  const tplVer = (
    await db.query(
      `insert into public.work_report_template_versions (template_id, version_no, status, schema_json, metric_contract_json, schema_checksum, published_by_user_id, published_at)
       values ($1::uuid, 1, 'PUBLISHED', '{}'::jsonb, '{}'::jsonb, repeat('a', 64), $2::uuid, '2026-11-10T00:00:00Z') returning version_id`,
      [tpl.template_id, FULL_ADMIN.app],
    )
  ).rows[0];
  const asgn = (
    await db.query(
      `insert into public.work_report_assignments (template_id, template_version_id, target_kind, target_user_id, frequency, effective_from, assigned_by_user_id)
       values ($1::uuid, $2::uuid, 'USER', $3::uuid, 'DAILY', '2026-11-10', $4::uuid) returning assignment_id`,
      [tpl.template_id, tplVer.version_id, USER_CONFLICT.app, FULL_ADMIN.app],
    )
  ).rows[0];
  await db.query(
    `insert into public.work_report_obligations (template_id, template_version_id, assignment_id, assignee_app_user_id, snapshot_team_id, snapshot_team_code, snapshot_team_display_name, period_type, period_key, period_start_date, period_end_date, due_at, is_mandatory, obligation_status)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'ALPHA', 'Nhóm Alpha', 'DAILY', '2026-11-12', '2026-11-12', '2026-11-12', '2026-11-12T11:00:00Z', true, 'ACTIVE')`,
    [tpl.template_id, tplVer.version_id, asgn.assignment_id, USER_CONFLICT.app, TEAM_ALPHA],
  );

  const manifestWithoutQuarantine = {
    schema_version: WP3B_BACKFILL_SCHEMA_VERSION,
    approved_by: "Owner",
    approved_at: "2026-11-13T10:00:00+07:00",
    actor_app_user_id: FULL_ADMIN.app,
    reason: "Backfill kiểm thử WP3B",
    account_classifications: [
      { account_ref: USER_SHARED.app, account_type: "SHARED", evidence_note: "Shared account" },
      { account_ref: USER_ACCT.app, account_type: "NORMAL", evidence_note: "Accountant account" },
      { account_ref: USER_DISABLED.app, account_type: "NORMAL", evidence_note: "Disabled account still has active Person & ACCOUNTING" },
    ],
    persons: [
      {
        employee_code: "TD-003",
        full_name: "Nhân Sự A",
        status: "ACTIVE",
        joined_on: "2026-01-10",
        recruiter_id: USER_A.recruiter,
        account_ref: USER_A.app,
        link_source_kind: "BACKFILL_CURRENT_STATE_ONLY",
        link_evidence_date: null,
        department_membership: { department_code: "RECRUITMENT", source_kind: "BACKFILL_CURRENT_STATE_ONLY", evidence_date: null },
      },
      {
        employee_code: "KT-005",
        full_name: "Kế Toán C",
        status: "ACTIVE",
        joined_on: "2026-02-01",
        recruiter_id: null,
        account_ref: USER_ACCT.app,
        link_source_kind: "BACKFILL_DATE_EVIDENCE",
        link_evidence_date: "2026-02-01",
        department_membership: { department_code: "ACCOUNTING", source_kind: "BACKFILL_DATE_EVIDENCE", evidence_date: "2026-02-01" },
      },
      {
        employee_code: "KT-006",
        full_name: "Tài khoản Khóa D",
        status: "ACTIVE",
        joined_on: "2026-02-15",
        recruiter_id: null,
        account_ref: USER_DISABLED.app,
        link_source_kind: "BACKFILL_CURRENT_STATE_ONLY",
        link_evidence_date: null,
        department_membership: { department_code: "ACCOUNTING", source_kind: "BACKFILL_CURRENT_STATE_ONLY", evidence_date: null },
      },
      {
        employee_code: "REC-088",
        full_name: "Nhân Sự Nghỉ Việc",
        status: "INACTIVE",
        joined_on: "2025-01-01",
        recruiter_id: HRP_UNLINKED_RECRUITER,
        account_ref: null,
        link_source_kind: null,
        link_evidence_date: null,
        department_membership: null,
      },
    ],
    department_heads: [],
    quarantined_exceptions: [],
  };

  // Must fail when USER_CONFLICT is NOT quarantined!
  await assert.rejects(
    runWp3bBackfill(db, { manifest: manifestWithoutQuarantine, dryRun: true }),
    /UNQUARANTINED_CROSS_SOURCE_CONFLICT/,
  );

  const validManifest = {
    ...manifestWithoutQuarantine,
    quarantined_exceptions: [
      {
        kind: "ACCOUNT",
        ref: USER_CONFLICT.app,
        conflict_code: "CROSS_SOURCE_ACCOUNTING_RECRUITMENT",
        note: "Xung đột chéo nguồn ACCOUNTING + Recruitment chưa xác minh (OD-WP3-01)",
      },
    ],
  };

  const dryRes = await runWp3bBackfill(db, { manifest: validManifest, dryRun: true });
  assert.equal(dryRes.ok, true);
  assert.equal(dryRes.dry_run, true);
  assert.equal(dryRes.self_check.ok, true);
  assert.equal(
    (await db.query("select count(*)::int as cnt from public.organization_persons")).rows[0].cnt,
    0,
  );

  // Capture timestamp BEFORE apply to prove TM-03 (BACKFILL_DATE_EVIDENCE does NOT backfill fake started_at in the past!)
  const preApplyTs = (await db.query("select clock_timestamp() as ts")).rows[0].ts.toISOString();
  await sleep(25);

  const applyRes = await runWp3bBackfill(db, {
    manifest: validManifest,
    dryRun: false,
    expectedFingerprint: dryRes.manifest_fingerprint,
  });
  assert.equal(applyRes.ok, true);
  assert.equal(applyRes.replayed, false);
  assert.equal(applyRes.self_check.ok, true);

  // TM-02: leave_department_approvers (USER_B for ACCOUNTING) created ZERO automatic organization_department_heads!
  assert.equal(
    (await db.query("select count(*)::int as cnt from public.organization_department_heads where ended_at is null")).rows[0].cnt,
    0,
  );

  // TM-03: KT-005 (BACKFILL_DATE_EVIDENCE with evidence_date = 2026-02-01) has started_at >= preApplyTs and evidence_date = 2026-02-01,
  // and as_of(preApplyTs) returns null active_department & null active_account_link!
  const kt005Row = (
    await db.query(
      `select p.person_id, m.started_at, m.evidence_date::text as ev_date, m.source_kind
         from public.organization_persons p
         join public.organization_person_department_memberships m on m.person_id = p.person_id and m.ended_at is null
        where p.employee_code = 'KT-005'`,
    )
  ).rows[0];
  assert.equal(kt005Row.source_kind, "BACKFILL_DATE_EVIDENCE");
  assert.equal(kt005Row.ev_date, "2026-02-01");
  assert.ok(new Date(kt005Row.started_at).getTime() >= new Date(preApplyTs).getTime());

  const kt005BeforeBackfill = (
    await db.query(
      "select public.org_department_get_person_admin($1::uuid, $2::uuid, $3::uuid, $4::timestamptz) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app, kt005Row.person_id, preApplyTs],
    )
  ).rows[0].data.person;
  assert.equal(kt005BeforeBackfill.active_department, null);
  assert.equal(kt005BeforeBackfill.active_account_link, null);

  // TM-01: Disabled account KT-006 backfilled as Person status = 'ACTIVE', active link & active ACCOUNTING membership
  const kt006Row = (
    await db.query(
      `select p.status, m.membership_id, l.link_id
         from public.organization_persons p
         join public.organization_account_person_links l on l.person_id = p.person_id and l.ended_at is null
         join public.organization_person_department_memberships m on m.person_id = p.person_id and m.ended_at is null
        where p.employee_code = 'KT-006'`,
    )
  ).rows[0];
  assert.equal(kt006Row.status, "ACTIVE");

  // TM-17: SHARED blocks link & sets leave_employee_profiles.is_shared_non_employee = true
  const sharedLp = (
    await db.query(
      "select is_shared_non_employee from public.leave_employee_profiles where app_user_id = $1::uuid",
      [USER_SHARED.app],
    )
  ).rows[0];
  assert.equal(sharedLp.is_shared_non_employee, true);
  await assert.rejects(
    db.query(
      "select public.org_department_link_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, 2, 1, null, 'Link shared', $5::uuid, $6)",
      [FULL_ADMIN.auth, FULL_ADMIN.app, USER_SHARED.app, kt005Row.person_id, nextKey(), FP_A],
    ),
    /ACCOUNT_TYPE_LINK_FORBIDDEN/,
  );

  // Idempotent re-apply succeeds with replayed: true & zero duplicates
  const reapplyRes = await runWp3bBackfill(db, {
    manifest: validManifest,
    dryRun: false,
    expectedFingerprint: dryRes.manifest_fingerprint,
  });
  assert.equal(reapplyRes.replayed, true);
  assert.equal(
    (await db.query("select count(*)::int as cnt from public.organization_persons")).rows[0].cnt,
    4,
  );

  // Historical work_report_obligations for USER_CONFLICT preserved 100%
  assert.equal(
    (
      await db.query(
        "select count(*)::int as cnt from public.work_report_obligations where assignee_app_user_id = $1::uuid",
        [USER_CONFLICT.app],
      )
    ).rows[0].cnt,
    1,
  );

  // Conflicting manifest aborts instead of silently skipping
  const mismatchedManifest = structuredClone(validManifest);
  mismatchedManifest.persons[0].full_name = "Tên Khác Xung Đột";
  await assert.rejects(
    runWp3bBackfill(db, { manifest: mismatchedManifest, dryRun: true }),
    /BACKFILL_PERSON_MISMATCH/,
  );

  await db.close();
});

test("WP3B P1-1 Fix: INACTIVE Person drops legacy ACCOUNTING projection & VFIN authority, reactivation restores, Account.enabled=false preserves org state", async () => {
  const db = await createMigratedWp3Database();
  await seedWp3BaseData(db);

  const deptRows = (await db.query("select department_id, system_key, version from public.organization_departments")).rows;
  const acctDept = deptRows.find((d) => d.system_key === "ACCOUNTING");
  const itDept = deptRows.find((d) => d.system_key === "IT");

  // Person in ACCOUNTING linked to enabled NORMAL account USER_ACCT
  const kCreate = nextKey();
  const pAcct = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'KT-P1-01', 'Kế Toán Trạng Thái', '2026-01-15', $3::uuid, $4::uuid, 1, null, 'Tạo kế toán ACTIVE', $5::uuid, $6) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        acctDept.department_id,
        USER_ACCT.app,
        kCreate,
        computeCreatePersonFingerprint(FULL_ADMIN.app, {
          employee_code: "KT-P1-01",
          full_name: "Kế Toán Trạng Thái",
          joined_on: "2026-01-15",
          initial_department_ref: acctDept.department_id,
          account_ref: USER_ACCT.app,
          expected_account_version: 1,
          recruiter_id: null,
          reason: "Tạo kế toán ACTIVE",
          idempotency_key: kCreate,
        }),
      ],
    )
  ).rows[0].data.person;

  // Verify initial active state in both legacy reader & VFIN resolver
  const initialCheck = (
    await db.query(
      `select public.org_department__internal_has_active_membership($2::uuid, 'ACCOUNTING', public.direct_entry_authorization_date()) as has_acct,
              public.org_department__internal_resolve_vfin_default_authority($1::uuid, $2::uuid, public.direct_entry_authorization_date()) as vfin_auth`,
      [USER_ACCT.auth, USER_ACCT.app],
    )
  ).rows[0];
  assert.equal(initialCheck.has_acct, true);
  assert.equal(initialCheck.vfin_auth.allowed, true);
  assert.equal(initialCheck.vfin_auth.authority_source, "accounting_department");

  // 1) Update Person status -> INACTIVE (Account remains enabled = true)
  const kDeact = nextKey();
  await db.query(
    "select public.org_department_update_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, 'KT-P1-01', 'Kế Toán Trạng Thái', '2026-01-15', 'INACTIVE', 'Ngừng hoạt động nhân sự', $5::uuid, $6)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      pAcct.person_id,
      pAcct.version,
      kDeact,
      computeUpdatePersonFingerprint(FULL_ADMIN.app, pAcct.person_id, {
        expected_person_version: pAcct.version,
        employee_code: "KT-P1-01",
        full_name: "Kế Toán Trạng Thái",
        joined_on: "2026-01-15",
        status: "INACTIVE",
        reason: "Ngừng hoạt động nhân sự",
        idempotency_key: kDeact,
      }),
    ],
  );

  const afterDeact = (
    await db.query(
      `select p.status,
              u.enabled,
              public.org_department__internal_has_active_membership(u.app_user_id, 'ACCOUNTING', public.direct_entry_authorization_date()) as legacy_acct,
              public.org_department__internal_resolve_vfin_default_authority(u.auth_subject, u.app_user_id, public.direct_entry_authorization_date()) as vfin_auth,
              (select count(*)::int from public.organization_department_memberships lm where lm.app_user_id = u.app_user_id and lm.valid_to is null) as open_legacy_rows,
              (select count(*)::int from public.organization_person_department_memberships pm where pm.person_id = p.person_id and pm.ended_at is null) as open_wp3_memberships,
              (select count(*)::int from public.organization_account_person_links l where l.person_id = p.person_id and l.ended_at is null) as open_wp3_links
         from public.organization_persons p
         join public.organization_account_person_links l0 on l0.person_id = p.person_id and l0.ended_at is null
         join public.direct_entry_app_users u on u.app_user_id = l0.app_user_id
        where p.person_id = $1::uuid`,
      [pAcct.person_id],
    )
  ).rows[0];
  assert.equal(afterDeact.status, "INACTIVE");
  assert.equal(afterDeact.enabled, true);
  assert.equal(afterDeact.legacy_acct, false);
  assert.equal(afterDeact.vfin_auth.allowed, false);
  assert.equal(afterDeact.vfin_auth.authority_source, "none");
  assert.equal(afterDeact.open_legacy_rows, 0);
  // Org relations & history preserved while Person is INACTIVE
  assert.equal(afterDeact.open_wp3_memberships, 1);
  assert.equal(afterDeact.open_wp3_links, 1);

  // 2) Reactivate Person INACTIVE -> ACTIVE restores legacy ACCOUNTING projection & VFIN authority
  const kReact = nextKey();
  await db.query(
    "select public.org_department_update_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, 'KT-P1-01', 'Kế Toán Trạng Thái', '2026-01-15', 'ACTIVE', 'Tái kích hoạt nhân sự', $5::uuid, $6)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      pAcct.person_id,
      pAcct.version + 1,
      kReact,
      computeUpdatePersonFingerprint(FULL_ADMIN.app, pAcct.person_id, {
        expected_person_version: pAcct.version + 1,
        employee_code: "KT-P1-01",
        full_name: "Kế Toán Trạng Thái",
        joined_on: "2026-01-15",
        status: "ACTIVE",
        reason: "Tái kích hoạt nhân sự",
        idempotency_key: kReact,
      }),
    ],
  );
  const afterReact = (
    await db.query(
      `select public.org_department__internal_has_active_membership($2::uuid, 'ACCOUNTING', public.direct_entry_authorization_date()) as legacy_acct,
              public.org_department__internal_resolve_vfin_default_authority($1::uuid, $2::uuid, public.direct_entry_authorization_date()) as vfin_auth`,
      [USER_ACCT.auth, USER_ACCT.app],
    )
  ).rows[0];
  assert.equal(afterReact.legacy_acct, true);
  assert.equal(afterReact.vfin_auth.allowed, true);

  // Second deactivation on same calendar day succeeds cleanly (no legacy version collision)
  const kDeact2 = nextKey();
  await db.query(
    "select public.org_department_update_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, 'KT-P1-01', 'Kế Toán Trạng Thái', '2026-01-15', 'INACTIVE', 'Ngừng lần 2', $5::uuid, $6)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      pAcct.person_id,
      pAcct.version + 2,
      kDeact2,
      computeUpdatePersonFingerprint(FULL_ADMIN.app, pAcct.person_id, {
        expected_person_version: pAcct.version + 2,
        employee_code: "KT-P1-01",
        full_name: "Kế Toán Trạng Thái",
        joined_on: "2026-01-15",
        status: "INACTIVE",
        reason: "Ngừng lần 2",
        idempotency_key: kDeact2,
      }),
    ],
  );
  assert.equal(
    (
      await db.query(
        "select public.org_department__internal_has_active_membership($1::uuid, 'ACCOUNTING', public.direct_entry_authorization_date()) as legacy_acct",
        [USER_ACCT.app],
      )
    ).rows[0].legacy_acct,
    false,
  );

  // 3) Disabling an active NORMAL Account (Account.enabled = false) does NOT close org relations, HEAD, or Person.status
  const kItPerson = nextKey();
  const pHead = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'IT-P1-01', 'Trưởng Phòng IT', '2026-01-10', $3::uuid, $4::uuid, 1, $5::uuid, 'Tạo IT HEAD', $6::uuid, $7) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        itDept.department_id,
        USER_A.app,
        USER_A.recruiter,
        kItPerson,
        computeCreatePersonFingerprint(FULL_ADMIN.app, {
          employee_code: "IT-P1-01",
          full_name: "Trưởng Phòng IT",
          joined_on: "2026-01-10",
          initial_department_ref: itDept.department_id,
          account_ref: USER_A.app,
          expected_account_version: 1,
          recruiter_id: USER_A.recruiter,
          reason: "Tạo IT HEAD",
          idempotency_key: kItPerson,
        }),
      ],
    )
  ).rows[0].data.person;
  const kHead = nextKey();
  await db.query(
    "select public.org_department_designate_head_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, null, 'Bổ nhiệm HEAD IT', $6::uuid, $7)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      itDept.department_id,
      pHead.person_id,
      itDept.version,
      kHead,
      computeDesignateHeadFingerprint({
        actor_app_user_id: FULL_ADMIN.app,
        department_id: itDept.department_id,
        person_id: pHead.person_id,
        expected_department_version: itDept.version,
        expected_current_head_assignment_id: null,
        reason: "Bổ nhiệm HEAD IT",
      }),
    ],
  );
  const accVerA = (
    await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [USER_A.app])
  ).rows[0].version;
  await db.query(
    "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4::int, 'Khóa tài khoản đơn thuần', $5)",
    [FULL_ADMIN.auth, FULL_ADMIN.app, USER_A.app, accVerA, nextKey()],
  );
  const afterAccDisable = (
    await db.query(
      `select p.status,
              u.enabled,
              (select count(*)::int from public.organization_account_person_links l where l.person_id = p.person_id and l.ended_at is null) as links,
              (select count(*)::int from public.organization_person_department_memberships m where m.person_id = p.person_id and m.ended_at is null) as memberships,
              (select count(*)::int from public.organization_department_heads h where h.person_id = p.person_id and h.ended_at is null) as heads
         from public.organization_persons p
         join public.organization_account_person_links l0 on l0.person_id = p.person_id and l0.ended_at is null
         join public.direct_entry_app_users u on u.app_user_id = l0.app_user_id
        where p.person_id = $1::uuid`,
      [pHead.person_id],
    )
  ).rows[0];
  assert.equal(afterAccDisable.enabled, false);
  assert.equal(afterAccDisable.status, "ACTIVE");
  assert.equal(afterAccDisable.links, 1);
  assert.equal(afterAccDisable.memberships, 1);
  assert.equal(afterAccDisable.heads, 1);

  await db.close();
});

test("WP3B P1-2 Fix: Org sync never overwrites leave_employee_profiles.work_start_date or Leave policy fields across old and new writers", async () => {
  const db = await createMigratedWp3Database();
  await seedWp3BaseData(db);

  const deptRows = (await db.query("select department_id, system_key from public.organization_departments")).rows;
  const acctDept = deptRows.find((d) => d.system_key === "ACCOUNTING");
  const mktDept = deptRows.find((d) => d.system_key === "MARKETING");
  const itDept = deptRows.find((d) => d.system_key === "IT");

  const kCreate = nextKey();
  const p = (
    await db.query(
      "select public.org_department_create_person_admin($1::uuid, $2::uuid, 'LP-P1-02', 'Hồ Sơ Phép Gốc', '2026-01-15', $3::uuid, $4::uuid, 1, $5::uuid, 'Tạo nhân sự MARKETING', $6::uuid, $7) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        mktDept.department_id,
        USER_A.app,
        USER_A.recruiter,
        kCreate,
        computeCreatePersonFingerprint(FULL_ADMIN.app, {
          employee_code: "LP-P1-02",
          full_name: "Hồ Sơ Phép Gốc",
          joined_on: "2026-01-15",
          initial_department_ref: mktDept.department_id,
          account_ref: USER_A.app,
          expected_account_version: 1,
          recruiter_id: USER_A.recruiter,
          reason: "Tạo nhân sự MARKETING",
          idempotency_key: kCreate,
        }),
      ],
    )
  ).rows[0].data.person;

  // Seed Leave policy row owned by Leave Admin with distinct work_start_date = 2020-01-01
  const upsertReq = parsePatchAdminConfigBody(
    {
      operation: "UPSERT_EMPLOYEE_PROFILE",
      target_app_user_id: USER_A.app,
      is_shared_non_employee: false,
      employment_status: "OFFICIAL",
      unit_kind: "MARKETING",
      work_start_date: "2020-01-01",
      official_effective_date: "2020-03-01",
      next_seniority_effective_date: "2027-01-01",
      next_seniority_units: 5,
      expected_row_version: 0,
      reason: "Leave Admin tạo hồ sơ phép gốc",
      idempotency_key: nextKey(),
    },
    "2026-11-13",
  );
  assert.equal(upsertReq.ok, true);
  await db.query(
    "select public.leave_management_upsert_employee_profile_admin($1::uuid,$2::uuid,$3::uuid,$4::boolean,$5,$6,$7::date,$8::date,$9::date,$10::int,$11::int,$12,$13,$14)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      upsertReq.data.target_app_user_id,
      upsertReq.data.is_shared_non_employee,
      upsertReq.data.employment_status,
      upsertReq.data.unit_kind,
      upsertReq.data.work_start_date,
      upsertReq.data.official_effective_date,
      upsertReq.data.next_seniority_effective_date,
      upsertReq.data.next_seniority_units,
      upsertReq.data.expected_row_version,
      upsertReq.data.reason,
      upsertReq.data.idempotency_key,
      upsertReq.data.request_fingerprint,
    ],
  );
  await db.query("update public.leave_employee_profiles set notes = 'Policy note preserved' where app_user_id = $1::uuid", [
    USER_A.app,
  ]);

  async function readLeaveSnapshot() {
    return (
      await db.query(
        `select is_shared_non_employee,
                employment_status,
                unit_kind,
                work_start_date::text as work_start_date,
                official_effective_date::text as official_effective_date,
                next_seniority_effective_date::text as next_seniority_effective_date,
                next_seniority_units,
                notes
           from public.leave_employee_profiles
          where app_user_id = $1::uuid`,
        [USER_A.app],
      )
    ).rows[0];
  }

  function assertPolicyFieldsIntact(snap, expectedUnitKind) {
    assert.equal(snap.is_shared_non_employee, false);
    assert.equal(snap.employment_status, "OFFICIAL");
    assert.equal(snap.unit_kind, expectedUnitKind);
    assert.equal(snap.work_start_date, "2020-01-01");
    assert.equal(snap.official_effective_date, "2020-03-01");
    assert.equal(snap.next_seniority_effective_date, "2027-01-01");
    assert.equal(snap.next_seniority_units, 5);
    assert.equal(snap.notes, "Policy note preserved");
  }

  // 1) Update Person (joined_on & status)
  let pCur = p;
  const kUpd = nextKey();
  pCur = (
    await db.query(
      "select public.org_department_update_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, 'LP-P1-02', 'Tên Đổi WP3', '2026-02-20', 'ACTIVE', 'Cập nhật HR joined_on', $5::uuid, $6) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        pCur.person_id,
        pCur.version,
        kUpd,
        computeUpdatePersonFingerprint(FULL_ADMIN.app, pCur.person_id, {
          expected_person_version: pCur.version,
          employee_code: "LP-P1-02",
          full_name: "Tên Đổi WP3",
          joined_on: "2026-02-20",
          status: "ACTIVE",
          reason: "Cập nhật HR joined_on",
          idempotency_key: kUpd,
        }),
      ],
    )
  ).rows[0].data.person;
  assertPolicyFieldsIntact(await readLeaveSnapshot(), "MARKETING");

  // 2) Legacy update display name
  let accVer = (await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [USER_A.app])).rows[0].version;
  await db.query(
    "select public.direct_entry_account_operation_update_display_name($1::uuid, $2::uuid, $3::uuid, 'Tên Đổi Account Legacy', $4::int, 'Đổi tên cũ', $5)",
    [FULL_ADMIN.auth, FULL_ADMIN.app, USER_A.app, accVer, nextKey()],
  );
  assertPolicyFieldsIntact(await readLeaveSnapshot(), "MARKETING");

  // 3) Legacy update personnel
  const recVer = (await db.query("select version from public.recruiters where recruiter_id = $1::uuid", [USER_A.recruiter])).rows[0].version;
  await db.query(
    "select public.direct_entry_update_personnel($1::uuid, $2::uuid, $3::uuid, $4::int, 'Tên Đổi Recruiter Legacy', 'REC-A01', 'STAFF', 'Sửa nhân sự cũ', $5)",
    [FULL_ADMIN.auth, FULL_ADMIN.app, USER_A.recruiter, recVer, nextKey()],
  );
  assertPolicyFieldsIntact(await readLeaveSnapshot(), "MARKETING");

  // 4) Transfer MARKETING -> IT -> ACCOUNTING
  pCur = (
    await db.query(
      "select public.org_department_get_person_admin($1::uuid, $2::uuid, $3::uuid, null) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app, pCur.person_id],
    )
  ).rows[0].data.person;
  const kTr1 = nextKey();
  const tr1 = (
    await db.query(
      "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, 'Chuyển IT', $7::uuid, $8) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        pCur.person_id,
        itDept.department_id,
        pCur.version,
        pCur.active_department.membership_id,
        kTr1,
        computeTransferPersonDepartmentFingerprint(FULL_ADMIN.app, pCur.person_id, {
          target_department_ref: itDept.department_id,
          expected_person_version: pCur.version,
          expected_current_membership_id: pCur.active_department.membership_id,
          reason: "Chuyển IT",
          idempotency_key: kTr1,
        }),
      ],
    )
  ).rows[0].data;
  assertPolicyFieldsIntact(await readLeaveSnapshot(), "IT");

  const kTr2 = nextKey();
  await db.query(
    "select public.org_department_transfer_person_member_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::uuid, 'Chuyển Kế toán', $7::uuid, $8)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      pCur.person_id,
      acctDept.department_id,
      tr1.person_version,
      tr1.active_membership.membership_id,
      kTr2,
      computeTransferPersonDepartmentFingerprint(FULL_ADMIN.app, pCur.person_id, {
        target_department_ref: acctDept.department_id,
        expected_person_version: tr1.person_version,
        expected_current_membership_id: tr1.active_membership.membership_id,
        reason: "Chuyển Kế toán",
        idempotency_key: kTr2,
      }),
    ],
  );
  assertPolicyFieldsIntact(await readLeaveSnapshot(), "ACCOUNTING");

  // 5) Legacy end_accounting_member & assign_accounting_member
  const legacyM = (
    await db.query(
      "select membership_id, version from public.organization_department_memberships where app_user_id = $1::uuid and valid_to is null",
      [USER_A.app],
    )
  ).rows[0];
  const kEndLeg = nextKey();
  await db.query(
    "select public.org_department_end_accounting_member($1::uuid, $2::uuid, $3::uuid, $4::int, null, 'Kết thúc kế toán cũ', $5::uuid, $6)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      legacyM.membership_id,
      legacyM.version,
      kEndLeg,
      computeEndAccountingMemberFingerprint({
        actor_app_user_id: FULL_ADMIN.app,
        membership_id: legacyM.membership_id,
        expected_pair_version: legacyM.version,
        effective_to: null,
        reason: "Kết thúc kế toán cũ",
      }),
    ],
  );
  assertPolicyFieldsIntact(await readLeaveSnapshot(), "UNCLASSIFIED");

  const kAssLeg = nextKey();
  await db.query(
    "select public.org_department_assign_accounting_member($1::uuid, $2::uuid, $3::uuid, $4::int, null, 'Gán lại kế toán cũ', $5::uuid, $6)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      USER_A.app,
      legacyM.version + 1,
      kAssLeg,
      computeAssignAccountingMemberFingerprint({
        actor_app_user_id: FULL_ADMIN.app,
        account_ref: USER_A.app,
        expected_pair_version: legacyM.version + 1,
        effective_from: null,
        reason: "Gán lại kế toán cũ",
      }),
    ],
  );
  assertPolicyFieldsIntact(await readLeaveSnapshot(), "ACCOUNTING");

  // 6) Unlink & re-link Account <-> Person
  pCur = (
    await db.query(
      "select public.org_department_get_person_admin($1::uuid, $2::uuid, $3::uuid, null) as data",
      [FULL_ADMIN.auth, FULL_ADMIN.app, pCur.person_id],
    )
  ).rows[0].data.person;
  accVer = (await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [USER_A.app])).rows[0].version;
  const kUnlink = nextKey();
  await db.query(
    "select public.org_department_unlink_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::int, $5::int, $6::uuid, 'Gỡ liên kết kiểm tra', $7::uuid, $8)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      USER_A.app,
      accVer,
      pCur.version,
      pCur.active_account_link.link_id,
      kUnlink,
      computeUnlinkAccountPersonFingerprint(FULL_ADMIN.app, USER_A.app, {
        expected_account_version: accVer,
        expected_person_version: pCur.version,
        expected_link_id: pCur.active_account_link.link_id,
        reason: "Gỡ liên kết kiểm tra",
        idempotency_key: kUnlink,
      }),
    ],
  );
  assertPolicyFieldsIntact(await readLeaveSnapshot(), "UNCLASSIFIED");

  const kRelink = nextKey();
  await db.query(
    "select public.org_department_link_account_person_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6::int, $7::uuid, 'Nối lại kiểm tra', $8::uuid, $9)",
    [
      FULL_ADMIN.auth,
      FULL_ADMIN.app,
      USER_A.app,
      pCur.person_id,
      accVer + 1,
      pCur.version + 1,
      USER_A.recruiter,
      kRelink,
      computeLinkAccountPersonFingerprint(FULL_ADMIN.app, USER_A.app, {
        person_id: pCur.person_id,
        expected_account_version: accVer + 1,
        expected_person_version: pCur.version + 1,
        confirmed_recruiter_id: USER_A.recruiter,
        reason: "Nối lại kiểm tra",
        idempotency_key: kRelink,
      }),
    ],
  );
  assertPolicyFieldsIntact(await readLeaveSnapshot(), "ACCOUNTING");

  await db.close();
});

test("WP3B P1-3 Fix: Open-ended work_report_delegations (effective_to IS NULL) block SHARED/SERVICE for both grantor & delegate and backfill, until revoked", async () => {
  const db = await createMigratedWp3Database();
  await seedWp3BaseData(db);

  // Use USER_ACCT as delegate (no personal assignments initially) and USER_SHARED as grantor
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
     values ($1::uuid, 'report_delegate', '2026-01-01', true),
            ($1::uuid, 'report_review', '2026-01-01', true)`,
    [USER_SHARED.app],
  );
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1::uuid, 'all', '2026-01-01', true)`,
    [USER_SHARED.app],
  );
  const template = (
    await db.query(
      `insert into public.work_report_templates (template_code, display_name, default_frequency, status, created_by_user_id)
       values ('WP3B_OPEN_DELEG', 'WP3B Open Delegation', 'DAILY', 'ACTIVE', $1::uuid)
       returning template_id`,
      [FULL_ADMIN.app],
    )
  ).rows[0];
  const tplVer = (
    await db.query(
      `insert into public.work_report_template_versions (template_id, version_no, status, schema_json, metric_contract_json, schema_checksum, published_by_user_id, published_at)
       values ($1::uuid, 1, 'PUBLISHED', '{}'::jsonb, '{}'::jsonb, repeat('a', 64), $2::uuid, clock_timestamp())
       returning version_id`,
      [template.template_id, FULL_ADMIN.app],
    )
  ).rows[0];
  await db.query("update public.work_report_templates set current_published_version_id = $2::uuid where template_id = $1::uuid", [
    template.template_id,
    tplVer.version_id,
  ]);

  // Seed historical revoked assignment + historical obligation for delegate to verify preservation after revocation + classification
  const histAsgn = (
    await db.query(
      `insert into public.work_report_assignments (
         template_id, template_version_id, target_kind, target_user_id, frequency, effective_from, assigned_by_user_id, state, is_current
       )
       values ($1::uuid, $2::uuid, 'USER', $3::uuid, 'DAILY', '2026-11-01', $4::uuid, 'REVOKED', false)
       returning assignment_id`,
      [template.template_id, tplVer.version_id, USER_ACCT.app, FULL_ADMIN.app],
    )
  ).rows[0];
  await db.query(
    `insert into public.work_report_obligations (
       template_id, template_version_id, assignment_id, assignee_app_user_id,
       snapshot_team_id, snapshot_team_code, snapshot_team_display_name,
       period_type, period_key, period_start_date, period_end_date, due_at, is_mandatory, obligation_status
     )
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'ALPHA', 'Nhóm Alpha', 'DAILY', '2026-11-01', '2026-11-01', '2026-11-01', '2026-11-02T00:00:00Z', true, 'ACTIVE')`,
    [template.template_id, tplVer.version_id, histAsgn.assignment_id, USER_ACCT.app, TEAM_ALPHA],
  );

  // Create open-ended (effective_to = NULL) delegation
  const delegation = (
    await db.query(
      "select public.work_report_create_delegation($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'all', null, null, null, $5) as data",
      [USER_SHARED.auth, USER_SHARED.app, USER_ACCT.app, template.template_id, nextKey()],
    )
  ).rows[0].data;
  assert.equal(delegation.state, "ACTIVE");
  assert.equal(delegation.effective_to, null);

  // Both delegate and grantor MUST be blocked from both SHARED and SERVICE
  for (const target of [USER_ACCT, USER_SHARED]) {
    for (const targetType of ["SHARED", "SERVICE"]) {
      const kCls = nextKey();
      await assert.rejects(
        db.query(
          "select public.org_department_set_account_type_admin($1::uuid, $2::uuid, $3::uuid, $4, 1, 'Attempt classification with open delegation', $5::uuid, $6)",
          [
            FULL_ADMIN.auth,
            FULL_ADMIN.app,
            target.app,
            targetType,
            kCls,
            computeSetAccountTypeFingerprint(FULL_ADMIN.app, target.app, {
              account_type: targetType,
              expected_account_version: 1,
              reason: "Attempt classification with open delegation",
              idempotency_key: kCls,
            }),
          ],
        ),
        /ACCOUNT_HAS_PERSON_OR_PERSONAL_ASSIGNMENTS/,
      );
    }
  }

  // Backfill manifest classifying delegate OR grantor as SHARED/SERVICE MUST also reject!
  for (const blockedRef of [USER_ACCT.app, USER_SHARED.app]) {
    for (const blockedType of ["SHARED", "SERVICE"]) {
      const blockedManifest = {
        schema_version: WP3B_BACKFILL_SCHEMA_VERSION,
        approved_by: "Owner",
        approved_at: "2026-11-13T03:00:00Z",
        actor_app_user_id: FULL_ADMIN.app,
        reason: "Backfill blocked by open-ended delegation",
        account_classifications: [
          {
            account_ref: blockedRef,
            account_type: blockedType,
            evidence_note: "Test open-ended delegation block",
          },
        ],
        persons: [],
        department_heads: [],
        quarantined_exceptions: [],
      };
      await assert.rejects(
        runWp3bBackfill(db, {
          manifest: blockedManifest,
          dryRun: false,
          expectedFingerprint: computeBackfillManifestFingerprint(blockedManifest),
        }),
        /BACKFILL_ACCOUNT_HAS_PERSONAL_ASSIGNMENTS/,
      );
    }
  }

  // Delegation remains effective & NOT auto-revoked
  assert.equal(
    (
      await db.query(
        "select public.work_report__internal_is_delegation_effective($1::uuid, clock_timestamp()) as eff",
        [delegation.delegation_id],
      )
    ).rows[0].eff,
    true,
  );

  // Explicitly revoke delegation -> classification to SHARED then SERVICE now succeeds, obligation preserved
  await db.query(
    "select public.work_report_revoke_delegation($1::uuid, $2::uuid, $3::uuid, 1, $4)",
    [USER_SHARED.auth, USER_SHARED.app, delegation.delegation_id, nextKey()],
  );
  assert.equal(
    (
      await db.query(
        "select public.work_report__internal_is_delegation_effective($1::uuid, clock_timestamp()) as eff",
        [delegation.delegation_id],
      )
    ).rows[0].eff,
    false,
  );

  const kToShared = nextKey();
  const sharedRes = (
    await db.query(
      "select public.org_department_set_account_type_admin($1::uuid, $2::uuid, $3::uuid, 'SHARED', 1, 'After revocation', $4::uuid, $5) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        USER_ACCT.app,
        kToShared,
        computeSetAccountTypeFingerprint(FULL_ADMIN.app, USER_ACCT.app, {
          account_type: "SHARED",
          expected_account_version: 1,
          reason: "After revocation",
          idempotency_key: kToShared,
        }),
      ],
    )
  ).rows[0].data;
  assert.equal(sharedRes.account.account_type, "SHARED");

  const kToSvc = nextKey();
  const svcRes = (
    await db.query(
      "select public.org_department_set_account_type_admin($1::uuid, $2::uuid, $3::uuid, 'SERVICE', 2, 'Switch to SERVICE', $4::uuid, $5) as data",
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        USER_ACCT.app,
        kToSvc,
        computeSetAccountTypeFingerprint(FULL_ADMIN.app, USER_ACCT.app, {
          account_type: "SERVICE",
          expected_account_version: 2,
          reason: "Switch to SERVICE",
          idempotency_key: kToSvc,
        }),
      ],
    )
  ).rows[0].data;
  assert.equal(svcRes.account.account_type, "SERVICE");

  // Historical obligation remains intact
  assert.equal(
    (
      await db.query(
        "select count(*)::int as cnt from public.work_report_obligations where assignee_app_user_id = $1::uuid",
        [USER_ACCT.app],
      )
    ).rows[0].cnt,
    1,
  );

  await db.close();
});
