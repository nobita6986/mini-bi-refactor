/**
 * Phase 2 — Recruitment Posts Foundation (`recruitment_project_briefs`, `recruitment_project_brief_labor_types`, `recruitment_project_brief_revisions`)
 * PGlite Database Acceptance & Regression Suite (T-AUTH-01..13, T-ACL-01..02, T-MULTI-POST-01..02, T-CAT-01..04, T-VAL-01..12, T-OCC-01..02, T-IDEM-01..05, T-FEED-01..08, T-PROJ-01).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  projectRecruitmentPostContext,
  projectRecruitmentPostGet,
  projectRecruitmentPostList,
  projectRecruitmentPostListWithFacets,
  projectRecruitmentPostMutation,
  projectRecruitmentPostPublicFeedV1,
} from "../src/lib/recruitment-posts/contract.ts";
import {
  RECRUITMENT_POST_LIST_MINE_MIGRATION_NAME,
  RECRUITMENT_POST_LIST_MINE_RPC_SIGNATURES,
  RECRUITMENT_POST_LIST_WITH_FACETS_MIGRATION_NAME,
  RECRUITMENT_POST_LIST_WITH_FACETS_RPC_SIGNATURES,
  RECRUITMENT_POST_PUBLIC_FEED_V1_MIGRATION_NAME,
  RECRUITMENT_POST_PUBLIC_FEED_V1_RPC_SIGNATURES,
  RECRUITMENT_POSTS_MIGRATION_NAME,
  RECRUITMENT_POSTS_RPC_SIGNATURES,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const NOBITA_ADMIN = {
  auth: "10000000-0000-4000-8000-000000000201",
  app: "20000000-0000-4000-8000-000000000201",
  email: "nobita6986@gmail.com",
  display_name: "Nobita Full Admin",
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: ["all"],
};

const LIENVU_BOD = {
  auth: "10000000-0000-4000-8000-000000000202",
  app: "20000000-0000-4000-8000-000000000202",
  email: "lienvu@hrpartner.vn",
  display_name: "Liên Vũ BOD",
  capabilities: ["entry_privileged_edit"],
  scopes: ["all"],
};

const NGATTT_BOD_REPORTS = {
  auth: "10000000-0000-4000-8000-000000000203",
  app: "20000000-0000-4000-8000-000000000203",
  email: "ngattt@hrpartner.vn",
  display_name: "Nga TTT BOD",
  capabilities: ["report_analytics_view", "report_view"],
  scopes: ["all"],
};

const ADMIN_ALSO_PM = {
  auth: "10000000-0000-4000-8000-000000000204",
  app: "20000000-0000-4000-8000-000000000204",
  recruiter: "30000000-0000-4000-8000-000000000204",
  email: "admin.pm@hrpartner.vn",
  display_name: "Admin kiêm PM",
  recruiter_display_name: "Admin kiêm PM",
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: ["all"],
};

const PM_A = {
  auth: "10000000-0000-4000-8000-000000000205",
  app: "20000000-0000-4000-8000-000000000205",
  recruiter: "30000000-0000-4000-8000-000000000205",
  email: "pma@hrpartner.vn",
  display_name: "App User PM A",
  recruiter_display_name: "Recruiter Verified PM A",
  capabilities: ["change_request_create"],
  scopes: ["own"],
};

const PM_B = {
  auth: "10000000-0000-4000-8000-000000000206",
  app: "20000000-0000-4000-8000-000000000206",
  recruiter: "30000000-0000-4000-8000-000000000206",
  email: "pmb@hrpartner.vn",
  display_name: "Quản lý Dự án B",
  recruiter_display_name: "Quản lý Dự án B",
  capabilities: ["change_request_create"],
  scopes: ["own"],
};

const REGULAR_STAFF = {
  auth: "10000000-0000-4000-8000-000000000207",
  app: "20000000-0000-4000-8000-000000000207",
  email: "staff@hrpartner.vn",
  display_name: "Nhân viên Tuyển dụng",
  capabilities: ["submission_create", "entry_own"],
  scopes: ["own"],
};

const DISABLED_USER = {
  auth: "10000000-0000-4000-8000-000000000208",
  app: "20000000-0000-4000-8000-000000000208",
  email: "disabled@hrpartner.vn",
  display_name: "Tài khoản Khóa",
  enabled: false,
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: ["all"],
};

const CATALOG_OPERATOR_ALL = {
  auth: "10000000-0000-4000-8000-000000000209",
  app: "20000000-0000-4000-8000-000000000209",
  email: "catalog.all@hrpartner.vn",
  display_name: "Catalog Master All Scope",
  capabilities: ["catalog_master_manage"],
  scopes: ["all"],
};

const REVIEWER_PROJECT_ADMIN_ALL = {
  auth: "10000000-0000-4000-8000-000000000210",
  app: "20000000-0000-4000-8000-000000000210",
  email: "reviewer.all@hrpartner.vn",
  display_name: "Reviewer Project Admin All Scope",
  capabilities: ["entry_admin", "change_review"],
  scopes: ["all"],
};

const WORKER_HISTORY_VIEWER_ALL = {
  auth: "10000000-0000-4000-8000-000000000211",
  app: "20000000-0000-4000-8000-000000000211",
  email: "history.all@hrpartner.vn",
  display_name: "Worker History Viewer All Scope",
  capabilities: ["worker_edit_history_view"],
  scopes: ["all"],
};

const KEY = (n) => `80000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const RPC_PARAMS = {
  recruitment_post_get_context: ["p_auth_subject", "p_app_user_id"],
  recruitment_post_list: [
    "p_auth_subject",
    "p_app_user_id",
    "p_project_id",
    "p_province_id",
    "p_industrial_park_id",
    "p_labor_type_key",
    "p_updated_from",
    "p_updated_to",
    "p_cursor",
    "p_snapshot_token",
    "p_page_size",
  ],
  recruitment_post_list_with_facets: [
    "p_auth_subject",
    "p_app_user_id",
    "p_project_id",
    "p_province_id",
    "p_industrial_park_id",
    "p_labor_type_key",
    "p_updated_from",
    "p_updated_to",
    "p_cursor",
    "p_snapshot_token",
    "p_page_size",
  ],
  recruitment_post_list_mine: [
    "p_auth_subject",
    "p_app_user_id",
    "p_cursor",
    "p_snapshot_token",
    "p_page_size",
  ],
  recruitment_post_public_feed_v1: [],
  recruitment_post_get: ["p_auth_subject", "p_app_user_id", "p_brief_id"],
  recruitment_post_create: [
    "p_auth_subject",
    "p_app_user_id",
    "p_payload",
    "p_idempotency_key",
  ],
  recruitment_post_update: [
    "p_auth_subject",
    "p_app_user_id",
    "p_brief_id",
    "p_expected_version",
    "p_payload",
    "p_idempotency_key",
  ],
  recruitment_post_withdraw: [
    "p_auth_subject",
    "p_app_user_id",
    "p_brief_id",
    "p_expected_version",
    "p_idempotency_key",
  ],
  industrial_park_update_admin: [
    "p_auth_subject",
    "p_app_user_id",
    "p_industrial_park_id",
    "p_expected_version",
    "p_province_id",
    "p_display_name",
    "p_reason",
    "p_idempotency_key",
  ],
};

function makeBriefContent(overrides = {}) {
  return {
    general: {
      customer_name: "Công ty TNHH Điện tử Việt Hàn",
      investment_origin: "Hàn Quốc",
      manufacturing_industry: "Sản xuất linh kiện điện tử",
      job_description: "Lắp ráp và kiểm tra ngoại quan linh kiện điện tử",
      environment_types: ["CLEAN_ROOM", "NORMAL_ROOM"],
      work_postures: ["SITTING", "STANDING"],
      shift_pattern: "TWO_SHIFTS",
      shift_details: null,
      manager_name: "Trần Quản Lý",
      manager_phone: "0912345678",
      labor_type_keys: ["CHINH_THUC"],
      supply_schedule_text: "Tuyển liên tục các ngày trong tuần",
      expected_headcount: 100,
      ...(overrides.general ?? {}),
    },
    candidate: {
      age_min: 18,
      age_max: 40,
      gender_requirement: "ANY",
      education_requirement: "SECONDARY",
      experience_required: false,
      experience_details: null,
      accept_former_customer_workers: true,
      entry_assessment_text: "Test tay khéo và phỏng vấn trực tiếp",
      other_requirements_text: "Không dị ứng phòng sạch",
      ...(overrides.candidate ?? {}),
    },
    compensation: {
      base_salary_vnd: "6000000",
      base_salary_conditions: "Đủ 26 ngày công tiêu chuẩn",
      attendance_bonus_vnd: "500000",
      attendance_bonus_conditions: "Không đi muộn về sớm",
      living_allowance_vnd: "400000",
      living_allowance_conditions: null,
      seniority_allowance_vnd: "300000",
      seniority_allowance_conditions: "Từ tháng thứ 2",
      eyesight_allowance_vnd: null,
      eyesight_allowance_conditions: null,
      other_allowance_text: null,
      average_income_min_vnd: "9500000",
      average_income_max_vnd: "13000000",
      salary_payment_schedule: "Ngày 10 hàng tháng qua ngân hàng",
      salary_advance_available: true,
      salary_advance_amount_vnd: "2000000",
      salary_advance_schedule: "Ngày 25 hàng tháng",
      weekly_salary_available: false,
      weekly_salary_payment_schedule: null,
      day_shift_8h_vnd: "240000",
      day_shift_11h_vnd: "350000",
      night_shift_8h_vnd: "290000",
      night_shift_11h_vnd: "420000",
      sunday_day_11h_vnd: "520000",
      sunday_night_11h_vnd: "600000",
      holiday_day_11h_vnd: "780000",
      holiday_night_11h_vnd: "880000",
      ppe_provided: true,
      ppe_details: "Phát miễn phí 2 bộ quần áo và giày phòng sạch",
      other_benefits: "Hỗ trợ 2 bữa ăn ca tại nhà máy",
      ...(overrides.compensation ?? {}),
    },
    documents: {
      require_original_cccd_and_copy: true,
      require_certified_resume: false,
      require_health_certificate_within_6_months: false,
      require_photo_3x4: true,
      require_degree_or_certificate: false,
      require_social_insurance_book: false,
      require_other_documents: false,
      other_documents_text: null,
      ...(overrides.documents ?? {}),
    },
  };
}

function makeCreatePayload(projectId, parkId, overrides = {}) {
  return {
    project_id: projectId,
    industrial_park_id: parkId,
    ...makeBriefContent(overrides),
  };
}

async function createDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(
    names.includes(RECRUITMENT_POSTS_MIGRATION_NAME),
    `Expected migration ${RECRUITMENT_POSTS_MIGRATION_NAME}`,
  );
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    if (name === RECRUITMENT_POSTS_MIGRATION_NAME) {
      await db.exec(
        "create role rp_nobypass_migrator nologin nobypassrls;" +
          " grant postgres to rp_nobypass_migrator with admin false, inherit true, set false;",
      );
      await db.exec("begin");
      let nobypassErr = null;
      try {
        await db.exec("set local role rp_nobypass_migrator");
        await db.exec(migrationSqlForTransaction(sql));
      } catch (err) {
        nobypassErr = err;
      } finally {
        await db.exec("rollback; reset role;");
      }
      assert.ok(
        nobypassErr,
        "Migration must fail closed when executed by a NOBYPASSRLS role that cannot SET to the direct_entries owner",
      );
      assert.equal(nobypassErr.code, "55000");
      assert.match(nobypassErr.message, /must bypass FORCE RLS/);

      const { rows: rolledBackRows } = await db.query(
        "select to_regclass('public.recruitment_project_briefs') as rel",
      );
      assert.equal(
        rolledBackRows[0].rel,
        null,
        "Failed NOBYPASSRLS migration must roll back atomically without leaving tables behind",
      );
    }
    await db.exec(sql);
  }
  return db;
}

async function rpc(db, name, args = {}) {
  const order = RPC_PARAMS[name];
  assert.ok(order, `unknown rpc ${name}`);
  const values = order.map((key) => {
    if (key in args) return args[key];
    if (key === "p_page_size") return 10;
    return null;
  });
  const placeholders = order
    .map((key, index) =>
      key === "p_payload" ? `$${index + 1}::jsonb` : `$${index + 1}`,
    )
    .join(", ");
  const { rows } = await db.query(
    `select public.${name}(${placeholders}) as result`,
    values,
  );
  return rows[0].result;
}

async function rpcError(db, name, args = {}) {
  try {
    await rpc(db, name, args);
    return null;
  } catch (error) {
    return { code: error.code, message: error.message };
  }
}

async function addActor(db, actor) {
  await db.query("insert into auth.users (id) values ($1::uuid)", [
    actor.auth,
  ]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
     values ($1::uuid, $2::uuid, $3, $4)`,
    [actor.app, actor.auth, actor.enabled !== false, actor.display_name],
  );
  for (const capability of actor.capabilities ?? []) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2020-01-01', true)`,
      [actor.app, capability],
    );
  }
  for (const kind of actor.scopes ?? []) {
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, $2, '2020-01-01', true)`,
      [actor.app, kind],
    );
  }
  if (actor.recruiter) {
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, active)
       values ($1::uuid, $2, true)`,
      [actor.recruiter, actor.recruiter_display_name ?? actor.display_name],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2020-01-01', true)`,
      [actor.app, actor.recruiter],
    );
  }
}

async function assignPm(db, projectId, managerRecruiterId, { validTo = null, isCurrent = true } = {}) {
  await db.query(
    `insert into public.direct_entry_project_manager_assignments
       (project_id, manager_recruiter_id, valid_from, valid_to, revoked_at, is_current)
     values ($1, $2::uuid, '2026-01-01', $3::date, case when $3::date is null then null else '2026-02-01T00:00:00Z'::timestamptz end, $4)`,
    [projectId, managerRecruiterId, validTo, isCurrent],
  );
}

const db = await createDatabase();

const ALL_ACTORS = [
  NOBITA_ADMIN,
  LIENVU_BOD,
  NGATTT_BOD_REPORTS,
  ADMIN_ALSO_PM,
  PM_A,
  PM_B,
  REGULAR_STAFF,
  DISABLED_USER,
  CATALOG_OPERATOR_ALL,
  REVIEWER_PROJECT_ADMIN_ALL,
  WORKER_HISTORY_VIEWER_ALL,
];

for (const actor of ALL_ACTORS) {
  await addActor(db, actor);
}

// Seed projects and labor types
await db.exec(`
  insert into public.direct_entry_projects (project_id, display_name, active)
  values
    ('PROJ_RP_A', 'Dự án Điện tử A', true),
    ('PROJ_RP_B', 'Dự án Cơ khí B', true),
    ('PROJ_RP_INACTIVE', 'Dự án Ngừng Hoạt Động', false)
  on conflict (project_id) do nothing;

  insert into public.direct_entry_labor_types (labor_type_key, display_name, reporting_key, sort_order, active)
  values
    ('CHINH_THUC', 'Chính thức', 'chinh_thuc', 10, true),
    ('THOI_VU', 'Thời vụ', 'thoi_vu', 20, true),
    ('LUONG_TUAN', 'Lương tuần', 'luong_tuan', 30, true),
    ('NGUNG_DUNG_LT', 'Loại hình đã khóa', 'ngung_dung_lt', 90, false)
  on conflict (labor_type_key) do update
    set active = excluded.active,
        display_name = excluded.display_name;
`);

await assignPm(db, "PROJ_RP_A", PM_A.recruiter);
await assignPm(db, "PROJ_RP_A", PM_B.recruiter);
await assignPm(db, "PROJ_RP_A", ADMIN_ALSO_PM.recruiter);
await assignPm(db, "PROJ_RP_B", PM_B.recruiter);
await assignPm(db, "PROJ_RP_B", PM_A.recruiter, { validTo: "2026-02-01", isCurrent: false });

const { rows: parkSeedRows } = await db.query(`
  select ip.industrial_park_id,
         ip.industrial_park_code,
         ip.display_name,
         ip.province_id,
         ip.version as park_version,
         p.province_code
    from public.industrial_parks ip
    join public.administrative_provinces p
      on p.province_id = ip.province_id
   order by ip.industrial_park_code asc
`);
const parksByCode = Object.fromEntries(
  parkSeedRows.map((row) => [row.industrial_park_code, row]),
);
const PARK_BA_THIEN_1 = parksByCode.VP_BA_THIEN_1;
const PARK_BA_THIEN_2 = parksByCode.VP_BA_THIEN_2;
const PARK_KHAI_QUANG = parksByCode.VP_KHAI_QUANG;
const PARK_PHU_HA = parksByCode.PT_PHU_HA;

test("T-ACL-01, T-ACL-02 & T-AUTH-13: 8 public RPCs are service_role-only, all 10 internal helpers are revoked from all roles including service_role, no pair unique index exists, and zero hard-coded emails exist in SQL definitions", async () => {
  assert.equal(RECRUITMENT_POSTS_RPC_SIGNATURES.length, 6);
  assert.equal(RECRUITMENT_POST_LIST_MINE_RPC_SIGNATURES.length, 1);
  assert.equal(RECRUITMENT_POST_PUBLIC_FEED_V1_RPC_SIGNATURES.length, 1);

  // Confirm pair unique index does NOT exist, while non-unique project published index DOES exist
  const { rows: idxRows } = await db.query(`
    select indexname, indexdef
      from pg_indexes
     where schemaname = 'public'
       and tablename = 'recruitment_project_briefs'
  `);
  const idxNames = idxRows.map((r) => r.indexname);
  assert.equal(
    idxNames.includes("recruitment_project_briefs_published_pair_uidx"),
    false,
    "Unique index on (project_id, industrial_park_id) must NOT exist",
  );
  assert.equal(
    idxNames.includes("recruitment_project_briefs_project_published_idx"),
    true,
    "Non-unique partial index on (project_id, brief_id) where status='PUBLISHED' must exist",
  );
  assert.equal(
    idxNames.includes("recruitment_project_briefs_creator_status_updated_idx"),
    true,
    "Index on (created_by_app_user_id, status, updated_at desc, brief_id desc) must exist",
  );

  // T-AUTH-13: No '@' character or hard-coded email in any recruitment_post* function body
  const { rows: fnDefs } = await db.query(`
    select p.proname, pg_get_functiondef(p.oid) as fn_def
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname like 'recruitment_post%'
  `);
  assert.equal(fnDefs.length, 19);
  for (const row of fnDefs) {
    assert.equal(
      row.fn_def.includes("@"),
      false,
      `Function ${row.proname} must not contain '@' or hard-coded email`,
    );
    assert.equal(
      row.fn_def.includes("RECRUITMENT_POST_ACTIVE_PAIR_EXISTS"),
      false,
      `Function ${row.proname} must not reference RECRUITMENT_POST_ACTIVE_PAIR_EXISTS`,
    );
  }

  // T-ACL-01: Check privileges and FORCE RLS bypass owner invariant on all 16 routines
  const { rows: privRows } = await db.query(`
    select p.proname,
           (coalesce(r.rolsuper, false) or coalesce(r.rolbypassrls, false)) as owner_bypasses_rls,
           has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as srv_exec
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      join pg_roles r on r.oid = p.proowner
     where n.nspname = 'public'
       and p.proname like 'recruitment_post%'
  `);
  for (const row of privRows) {
    assert.equal(
      row.owner_bypasses_rls,
      true,
      `${row.proname} owner must have rolsuper or rolbypassrls to read/write FORCE RLS tables`,
    );
    assert.equal(row.pub_exec, false, `${row.proname} public EXECUTE must be false`);
    assert.equal(row.anon_exec, false, `${row.proname} anon EXECUTE must be false`);
    assert.equal(row.auth_exec, false, `${row.proname} authenticated EXECUTE must be false`);
    if (row.proname.startsWith("recruitment_post__internal_")) {
      assert.equal(
        row.srv_exec,
        false,
        `Internal helper ${row.proname} must have service_role EXECUTE = false`,
      );
    } else {
      assert.equal(
        row.srv_exec,
        true,
        `Public RPC ${row.proname} must have service_role EXECUTE = true`,
      );
    }
  }

  // T-ACL-02: Direct call to internal helpers under service_role / authenticated / anon fails with 42501
  for (const role of ["service_role", "authenticated", "anon"]) {
    let caught = null;
    await db.exec("begin");
    try {
      await db.exec(`set local role ${role}`);
      await db.query(
        "select public.recruitment_post__internal_actor_is_full_admin_or_bod($1::uuid)",
        [NOBITA_ADMIN.app],
      );
    } catch (err) {
      caught = err;
    } finally {
      await db.exec("rollback");
    }
    assert.ok(caught, `Expected 42501 when ${role} calls internal helper directly`);
    assert.equal(caught.code, "42501");
  }

  // T-ACL-03: Migration $self_check$ fails with 55000 if any public RPC or internal helper
  // is owned by a NOBYPASSRLS role (`rp_nobypass_migrator`), even when tables are owned by `postgres`.
  const migrationSql = await readFile(
    path.join(MIGRATION_DIR, RECRUITMENT_POSTS_MIGRATION_NAME),
    "utf8",
  );
  const selfCheckBlockMatch = migrationSql.match(
    /do \$self_check\$[\s\S]*?\$self_check\$;/,
  );
  assert.ok(selfCheckBlockMatch, "Expected $self_check$ block in migration");
  const selfCheckSql = selfCheckBlockMatch[0];

  for (const [label, alterStmt, expectedPattern] of [
    [
      "public RPC owned by NOBYPASSRLS role",
      "alter function public.recruitment_post_get_context(uuid, uuid) owner to rp_nobypass_migrator",
      /owner of RPC public\.recruitment_post_get_context\(uuid,uuid\) must bypass FORCE RLS/,
    ],
    [
      "internal helper owned by NOBYPASSRLS role",
      "alter function public.recruitment_post__internal_actor_is_full_admin_or_bod(uuid) owner to rp_nobypass_migrator",
      /owner of internal helper public\.recruitment_post__internal_actor_is_full_admin_or_bod\(uuid\) must bypass FORCE RLS/,
    ],
  ]) {
    let selfCheckErr = null;
    await db.exec("begin");
    try {
      await db.exec(alterStmt);
      await db.exec(selfCheckSql);
    } catch (err) {
      selfCheckErr = err;
    } finally {
      await db.exec("rollback");
    }
    assert.ok(selfCheckErr, `Expected $self_check$ to fail for ${label}`);
    assert.equal(selfCheckErr.code, "55000");
    assert.match(selfCheckErr.message, expectedPattern);
  }
});

test("T-AUTH-01..12 & T-PROJ-01: Authorization matrix for create, update, withdraw, get, and context; verified recruiter display_name priority", async () => {
  // T-AUTH-01: Disabled user or mismatched (auth_subject, app_user_id) rejected with 42501
  for (const rpcName of [
    "recruitment_post_get_context",
    "recruitment_post_list",
    "recruitment_post_list_mine",
    "recruitment_post_get",
    "recruitment_post_create",
    "recruitment_post_update",
    "recruitment_post_withdraw",
  ]) {
    const errDisabled = await rpcError(db, rpcName, {
      p_auth_subject: DISABLED_USER.auth,
      p_app_user_id: DISABLED_USER.app,
      p_brief_id: KEY(901),
      p_expected_version: 1,
      p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id),
      p_idempotency_key: KEY(901),
    });
    assert.equal(errDisabled?.code, "42501");
    assert.equal(errDisabled?.message, "RECRUITMENT_POST_ACCESS_DENIED");

    const errMismatch = await rpcError(db, rpcName, {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_B.app,
      p_brief_id: KEY(902),
      p_expected_version: 1,
      p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id),
      p_idempotency_key: KEY(902),
    });
    assert.equal(errMismatch?.code, "42501");
  }

  // T-AUTH-02: Regular staff cannot create -> 42501, 0 rows in briefs/revisions/audit/idempotency
  const staffErr = await rpcError(db, "recruitment_post_create", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id),
    p_idempotency_key: KEY(101),
  });
  assert.equal(staffErr?.code, "42501");
  const { rows: orphanIdem } = await db.query(
    "select count(*)::int as c from public.direct_entry_rpc_idempotency where idempotency_key = $1",
    [KEY(101)],
  );
  assert.equal(orphanIdem[0].c, 0);

  // T-AUTH-03 & T-AUTH-04: PM_A is assigned to PROJ_RP_A, but revoked on PROJ_RP_B -> cannot create on PROJ_RP_B
  const ctxPmA = await rpc(db, "recruitment_post_get_context", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
  });
  assert.ok(projectRecruitmentPostContext(ctxPmA) !== null);
  assert.equal(ctxPmA.can_create, true);
  assert.deepEqual(
    ctxPmA.managed_projects.map((p) => p.project_id),
    ["PROJ_RP_A"],
  );

  const errWrongProj = await rpcError(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: makeCreatePayload("PROJ_RP_B", PARK_BA_THIEN_1.industrial_park_id),
    p_idempotency_key: KEY(102),
  });
  assert.equal(errWrongProj?.code, "42501");

  // T-AUTH-05: Full Admin / BOD who is NOT PM of the project cannot create!
  for (const [idx, adminActor] of [
    NOBITA_ADMIN,
    LIENVU_BOD,
    NGATTT_BOD_REPORTS,
  ].entries()) {
    const ctxAdmin = await rpc(db, "recruitment_post_get_context", {
      p_auth_subject: adminActor.auth,
      p_app_user_id: adminActor.app,
    });
    assert.equal(ctxAdmin.can_create, false);
    assert.equal(ctxAdmin.managed_projects.length, 0);

    const errAdminCreate = await rpcError(db, "recruitment_post_create", {
      p_auth_subject: adminActor.auth,
      p_app_user_id: adminActor.app,
      p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id),
      p_idempotency_key: KEY(110 + idx),
    });
    assert.equal(errAdminCreate?.code, "42501");
    assert.equal(errAdminCreate?.message, "RECRUITMENT_POST_ACCESS_DENIED");
  }

  // T-AUTH-06: Full Admin who is also PM of PROJ_RP_A can create
  const adminPmCreated = await rpc(db, "recruitment_post_create", {
    p_auth_subject: ADMIN_ALSO_PM.auth,
    p_app_user_id: ADMIN_ALSO_PM.app,
    p_payload: makeCreatePayload("PROJ_RP_A", PARK_KHAI_QUANG.industrial_park_id),
    p_idempotency_key: KEY(120),
  });
  assert.ok(projectRecruitmentPostMutation(adminPmCreated) !== null);
  assert.equal(adminPmCreated.changed, true);
  assert.equal(adminPmCreated.replayed, false);
  assert.equal(adminPmCreated.post.created_by_display_name, ADMIN_ALSO_PM.display_name);

  // T-AUTH-07 & T-PROJ-01: PM_A creates posts at different industrial parks; verified recruiter display_name is used
  const pmACreated1 = await rpc(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id),
    p_idempotency_key: KEY(121),
  });
  const pmACreated2 = await rpc(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_2.industrial_park_id),
    p_idempotency_key: KEY(122),
  });
  assert.equal(
    pmACreated1.post.created_by_display_name,
    "Recruiter Verified PM A",
    "Verified recruiter display_name must take priority over app_users.display_name (Q8)",
  );
  assert.equal(pmACreated1.post.industrial_park.display_name, "KCN Bá Thiện 1");
  assert.equal(pmACreated2.post.industrial_park.display_name, "KCN Bá Thiện 2");

  const briefId1 = pmACreated1.post.brief_id;
  const briefId2 = pmACreated2.post.brief_id;

  // T-AUTH-08: Another PM of the same project (PM_B) CANNOT update or withdraw PM_A's post
  const getForPmB = await rpc(db, "recruitment_post_get", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_brief_id: briefId1,
  });
  assert.ok(projectRecruitmentPostGet(getForPmB) !== null);
  assert.deepEqual(getForPmB.post.allowed_actions, {
    can_edit: false,
    can_withdraw: false,
  });

  const errPmBUpdate = await rpcError(db, "recruitment_post_update", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_brief_id: briefId1,
    p_expected_version: 1,
    p_payload: makeBriefContent({ general: { customer_name: "PM B sửa trộm" } }),
    p_idempotency_key: KEY(123),
  });
  assert.equal(errPmBUpdate?.code, "42501");

  const errPmBWithdraw = await rpcError(db, "recruitment_post_withdraw", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_brief_id: briefId1,
    p_expected_version: 1,
    p_idempotency_key: KEY(124),
  });
  assert.equal(errPmBWithdraw?.code, "42501");

  // T-AUTH-11: Non-Full-Admin all-scope personas (catalog_master_manage, entry_admin+change_review, worker_edit_history_view)
  // CANNOT update or withdraw PM_A's post
  for (const [idx, nonAdminAll] of [
    CATALOG_OPERATOR_ALL,
    REVIEWER_PROJECT_ADMIN_ALL,
    WORKER_HISTORY_VIEWER_ALL,
  ].entries()) {
    const getView = await rpc(db, "recruitment_post_get", {
      p_auth_subject: nonAdminAll.auth,
      p_app_user_id: nonAdminAll.app,
      p_brief_id: briefId1,
    });
    assert.deepEqual(getView.post.allowed_actions, {
      can_edit: false,
      can_withdraw: false,
    });

    const errUpd = await rpcError(db, "recruitment_post_update", {
      p_auth_subject: nonAdminAll.auth,
      p_app_user_id: nonAdminAll.app,
      p_brief_id: briefId1,
      p_expected_version: 1,
      p_payload: makeBriefContent({ general: { customer_name: "Hack" } }),
      p_idempotency_key: KEY(130 + idx * 2),
    });
    assert.equal(errUpd?.code, "42501");

    const errWd = await rpcError(db, "recruitment_post_withdraw", {
      p_auth_subject: nonAdminAll.auth,
      p_app_user_id: nonAdminAll.app,
      p_brief_id: briefId1,
      p_expected_version: 1,
      p_idempotency_key: KEY(131 + idx * 2),
    });
    assert.equal(errWd?.code, "42501");
  }

  // T-AUTH-09: Creator (PM_A) unassigned from PROJ_RP_A can still update, withdraw, and get(WITHDRAWN) on their own post
  await db.query(
    `update public.direct_entry_project_manager_assignments
        set is_current = false,
            valid_to = '2026-11-10'::date,
            revoked_at = '2026-11-10T00:00:00Z'::timestamptz
      where project_id = 'PROJ_RP_A'
        and manager_recruiter_id = $1::uuid`,
    [PM_A.recruiter],
  );

  const creatorUpdateAfterUnassign = await rpc(db, "recruitment_post_update", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: briefId2,
    p_expected_version: 1,
    p_payload: makeBriefContent({
      general: { customer_name: "Công ty A (Creator cập nhật sau khi rời dự án)" },
    }),
    p_idempotency_key: KEY(140),
  });
  assert.equal(creatorUpdateAfterUnassign.post.version, 2);

  const creatorWithdrawAfterUnassign = await rpc(db, "recruitment_post_withdraw", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: briefId2,
    p_expected_version: 2,
    p_idempotency_key: KEY(141),
  });
  assert.equal(creatorWithdrawAfterUnassign.post.status, "WITHDRAWN");
  assert.equal(creatorWithdrawAfterUnassign.post.version, 3);

  const creatorGetWithdrawn = await rpc(db, "recruitment_post_get", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: briefId2,
  });
  assert.equal(creatorGetWithdrawn.post.status, "WITHDRAWN");

  // Re-assign PM_A to PROJ_RP_A for subsequent tests
  await db.query(
    `update public.direct_entry_project_manager_assignments
        set is_current = true,
            valid_to = null,
            revoked_at = null
      where project_id = 'PROJ_RP_A'
        and manager_recruiter_id = $1::uuid`,
    [PM_A.recruiter],
  );

  // T-AUTH-12: Regular staff, PM_B, and non-Full-Admin all-scope personas get 404 P0002 on WITHDRAWN post
  for (const deniedViewer of [
    REGULAR_STAFF,
    PM_B,
    CATALOG_OPERATOR_ALL,
    REVIEWER_PROJECT_ADMIN_ALL,
    WORKER_HISTORY_VIEWER_ALL,
  ]) {
    const errGetWithdrawn = await rpcError(db, "recruitment_post_get", {
      p_auth_subject: deniedViewer.auth,
      p_app_user_id: deniedViewer.app,
      p_brief_id: briefId2,
    });
    assert.equal(errGetWithdrawn?.code, "P0002");
    assert.equal(errGetWithdrawn?.message, "RECRUITMENT_POST_NOT_FOUND");
  }

  // T-AUTH-10: All 3 canonical Full Admin / BOD branches can update, withdraw, and get(WITHDRAWN) on PM_A's post
  const updByNobita = await rpc(db, "recruitment_post_update", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_brief_id: briefId1,
    p_expected_version: 1,
    p_payload: makeBriefContent({ general: { customer_name: "Nobita chỉnh sửa" } }),
    p_idempotency_key: KEY(150),
  });
  assert.equal(updByNobita.post.version, 2);

  const updByLienVu = await rpc(db, "recruitment_post_update", {
    p_auth_subject: LIENVU_BOD.auth,
    p_app_user_id: LIENVU_BOD.app,
    p_brief_id: briefId1,
    p_expected_version: 2,
    p_payload: makeBriefContent({ general: { customer_name: "Liên Vũ chỉnh sửa" } }),
    p_idempotency_key: KEY(151),
  });
  assert.equal(updByLienVu.post.version, 3);

  const wdByNgaTtt = await rpc(db, "recruitment_post_withdraw", {
    p_auth_subject: NGATTT_BOD_REPORTS.auth,
    p_app_user_id: NGATTT_BOD_REPORTS.app,
    p_brief_id: briefId1,
    p_expected_version: 3,
    p_idempotency_key: KEY(152),
  });
  assert.equal(wdByNgaTtt.post.status, "WITHDRAWN");
  assert.equal(wdByNgaTtt.post.version, 4);

  for (const bodActor of [NOBITA_ADMIN, LIENVU_BOD, NGATTT_BOD_REPORTS]) {
    const bodGetWithdrawn = await rpc(db, "recruitment_post_get", {
      p_auth_subject: bodActor.auth,
      p_app_user_id: bodActor.app,
      p_brief_id: briefId1,
    });
    assert.equal(bodGetWithdrawn.post.status, "WITHDRAWN");
  }

  // Withdraw adminPmCreated so subsequent tests start with 0 PUBLISHED posts
  await rpc(db, "recruitment_post_withdraw", {
    p_auth_subject: ADMIN_ALSO_PM.auth,
    p_app_user_id: ADMIN_ALSO_PM.app,
    p_brief_id: adminPmCreated.post.brief_id,
    p_expected_version: 1,
    p_idempotency_key: KEY(153),
  });
});

test("T-MULTI-POST-01 & T-MULTI-POST-02: Multiple PUBLISHED posts for the same (project_id, industrial_park_id) are allowed; retry with the same idempotency_key replays without duplicating", async () => {
  const idemFirst = KEY(201);
  const idemSecond = KEY(202);
  const idemThirdSameContent = KEY(203);

  const first = await rpc(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id, {
      general: { job_description: "Vị trí 1: Lắp ráp bảng mạch SMT" },
    }),
    p_idempotency_key: idemFirst,
  });

  const second = await rpc(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id, {
      general: { job_description: "Vị trí 2: Kiểm tra ngoại quan QC" },
    }),
    p_idempotency_key: idemSecond,
  });

  // T-MULTI-POST-02: Even identical content with a new idempotency key succeeds and creates an independent brief_id
  const thirdSameContent = await rpc(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id, {
      general: { job_description: "Vị trí 2: Kiểm tra ngoại quan QC" },
    }),
    p_idempotency_key: idemThirdSameContent,
  });

  assert.equal(first.post.status, "PUBLISHED");
  assert.equal(second.post.status, "PUBLISHED");
  assert.equal(thirdSameContent.post.status, "PUBLISHED");
  assert.notEqual(first.post.brief_id, second.post.brief_id);
  assert.notEqual(second.post.brief_id, thirdSameContent.post.brief_id);

  // Retry of the first request with the same idempotency_key replays the exact first brief_id
  const replayFirst = await rpc(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id, {
      general: { job_description: "Vị trí 1: Lắp ráp bảng mạch SMT" },
    }),
    p_idempotency_key: idemFirst,
  });
  assert.equal(replayFirst.replayed, true);
  assert.equal(replayFirst.post.brief_id, first.post.brief_id);

  // Clean up these 3 posts by withdrawing them so later feed tests start from a clean slate
  for (const [idx, post] of [first.post, second.post, thirdSameContent.post].entries()) {
    await rpc(db, "recruitment_post_withdraw", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_brief_id: post.brief_id,
      p_expected_version: 1,
      p_idempotency_key: KEY(210 + idx),
    });
  }
});

test("T-CAT-01..04: Catalog active checks on create, Q9 editing/withdrawing when project/park is later deactivated, Must fix 1 province-move guard, and Must fix 3 labor_types.active + can_create", async () => {
  // T-CAT-01: Create with inactive project or inactive labor_type fails with 22023 RECRUITMENT_POST_CONTENT_INVALID
  await assignPm(db, "PROJ_RP_INACTIVE", PM_A.recruiter);
  const errInactiveProj = await rpcError(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: makeCreatePayload(
      "PROJ_RP_INACTIVE",
      PARK_BA_THIEN_1.industrial_park_id,
    ),
    p_idempotency_key: KEY(301),
  });
  assert.equal(errInactiveProj?.code, "22023");
  assert.equal(errInactiveProj?.message, "RECRUITMENT_POST_CONTENT_INVALID");

  const errInactiveLt = await rpcError(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id, {
      general: { labor_type_keys: ["NGUNG_DUNG_LT"] },
    }),
    p_idempotency_key: KEY(302),
  });
  assert.equal(errInactiveLt?.code, "22023");

  // Create a valid post on PROJ_RP_B + PARK_PHU_HA (with PM_B) using THOI_VU
  const createdForCat = await rpc(db, "recruitment_post_create", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_payload: makeCreatePayload("PROJ_RP_B", PARK_PHU_HA.industrial_park_id, {
      general: { labor_type_keys: ["THOI_VU"] },
    }),
    p_idempotency_key: KEY(303),
  });
  const catBriefId = createdForCat.post.brief_id;

  // T-CAT-03 (Must fix 1): Moving PARK_PHU_HA to VINH_PHUC while it has a PUBLISHED post is blocked with PT409 INDUSTRIAL_PARK_HAS_PUBLISHED_POSTS
  const moveBlocked = await rpcError(db, "industrial_park_update_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_industrial_park_id: PARK_PHU_HA.industrial_park_id,
    p_expected_version: 1,
    p_province_id: PARK_BA_THIEN_1.province_id,
    p_display_name: null,
    p_reason: "Try moving park with published post",
    p_idempotency_key: KEY(304),
  });
  assert.equal(moveBlocked?.code, "PT409");
  assert.equal(moveBlocked?.message, "INDUSTRIAL_PARK_HAS_PUBLISHED_POSTS");

  // T-CAT-04 (Must fix 3): Deactivate THOI_VU while it is referenced by a PUBLISHED post
  await db.exec(
    "update public.direct_entry_labor_types set active = false where labor_type_key = 'THOI_VU'",
  );
  const ctxWithInactiveLt = await rpc(db, "recruitment_post_get_context", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
  });
  const thoiVuOption = ctxWithInactiveLt.labor_types.find(
    (lt) => lt.labor_type_key === "THOI_VU",
  );
  const chinhThucOption = ctxWithInactiveLt.labor_types.find(
    (lt) => lt.labor_type_key === "CHINH_THUC",
  );
  assert.deepEqual(thoiVuOption, {
    labor_type_key: "THOI_VU",
    display_name: "Thời vụ",
    active: false,
  });
  assert.equal(chinhThucOption?.active, true);
  assert.equal(ctxWithInactiveLt.can_create, true);

  // Deactivate all labor types -> can_create becomes false even though PM_B has active project & active park
  await db.exec("update public.direct_entry_labor_types set active = false");
  const ctxAllLtOff = await rpc(db, "recruitment_post_get_context", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
  });
  assert.equal(ctxAllLtOff.can_create, false);

  // Restore active labor types
  await db.exec(
    "update public.direct_entry_labor_types set active = true where labor_type_key in ('CHINH_THUC', 'THOI_VU', 'LUONG_TUAN')",
  );

  // T-CAT-02 (Q9): Deactivate PROJ_RP_B and PARK_PHU_HA after post was published -> update, get_context, list, and withdraw all succeed
  await db.exec(`
    update public.direct_entry_projects set active = false where project_id = 'PROJ_RP_B';
    update public.industrial_parks set active = false where industrial_park_id = '${PARK_PHU_HA.industrial_park_id}';
  `);

  const ctxWhenDeactivated = await rpc(db, "recruitment_post_get_context", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
  });
  assert.ok(
    ctxWhenDeactivated.filter_projects.some((p) => p.project_id === "PROJ_RP_B"),
    "filter_projects must still include deactivated project that has a PUBLISHED post",
  );
  const phuHaInCtx = ctxWhenDeactivated.industrial_parks.find(
    (ip) => ip.industrial_park_id === PARK_PHU_HA.industrial_park_id,
  );
  assert.equal(phuHaInCtx?.active, false);

  const updOnDeactivated = await rpc(db, "recruitment_post_update", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_brief_id: catBriefId,
    p_expected_version: 1,
    p_payload: makeBriefContent({
      general: {
        customer_name: "Cập nhật khi KCN và dự án đã ngừng kích hoạt",
        labor_type_keys: ["THOI_VU"],
      },
    }),
    p_idempotency_key: KEY(305),
  });
  assert.equal(updOnDeactivated.post.version, 2);
  assert.equal(updOnDeactivated.post.industrial_park.active, false);
  assert.equal(updOnDeactivated.post.industrial_park.display_name, "KCN Phú Hà");

  const wdOnDeactivated = await rpc(db, "recruitment_post_withdraw", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_brief_id: catBriefId,
    p_expected_version: 2,
    p_idempotency_key: KEY(306),
  });
  assert.equal(wdOnDeactivated.post.status, "WITHDRAWN");

  // Restore PROJ_RP_B and PARK_PHU_HA active flags
  await db.exec(`
    update public.direct_entry_projects set active = true where project_id = 'PROJ_RP_B';
    update public.industrial_parks set active = true where industrial_park_id = '${PARK_PHU_HA.industrial_park_id}';
  `);

  // T-CAT-03 Step 2: Now that PARK_PHU_HA has 0 PUBLISHED posts, moving province succeeds (and then move it back)
  const movedPark = await rpc(db, "industrial_park_update_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_industrial_park_id: PARK_PHU_HA.industrial_park_id,
    p_expected_version: 1,
    p_province_id: PARK_BA_THIEN_1.province_id,
    p_display_name: null,
    p_reason: "Move province after withdrawing all posts",
    p_idempotency_key: KEY(307),
  });
  assert.equal(movedPark.province_id, PARK_BA_THIEN_1.province_id);

  await rpc(db, "industrial_park_update_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_industrial_park_id: PARK_PHU_HA.industrial_park_id,
    p_expected_version: movedPark.version,
    p_province_id: PARK_PHU_HA.province_id,
    p_display_name: null,
    p_reason: "Restore Phú Hà back to Phú Thọ",
    p_idempotency_key: KEY(308),
  });
});

test("T-VAL-01..12, T-OCC-01..02 & T-IDEM-01..05: SQL boundary validation, OCC stale vs already-withdrawn, idempotency replay & conflict, and Q7 no-op update", async () => {
  // T-VAL-01..12 at SQL RPC boundary
  const badCases = [
    [
      "age_min < 15",
      { candidate: { age_min: 14, age_max: 35 } },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "age_max > 70",
      { candidate: { age_min: 18, age_max: 71 } },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "age_min > age_max",
      { candidate: { age_min: 40, age_max: 25 } },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "average_income_min_vnd > average_income_max_vnd",
      {
        compensation: {
          average_income_min_vnd: "12000000",
          average_income_max_vnd: "9000000",
        },
      },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "VND overflow > 9007199254740991",
      { compensation: { base_salary_vnd: "9007199254740992" } },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "expected_headcount > 1000000",
      { general: { expected_headcount: 1_000_001 } },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "invalid manager_phone",
      { general: { manager_phone: "123" } },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "shift_pattern OTHER without shift_details",
      { general: { shift_pattern: "OTHER", shift_details: null } },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "experience_required=true without experience_details",
      { candidate: { experience_required: true, experience_details: null } },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "salary_advance_available=false with amount",
      {
        compensation: {
          salary_advance_available: false,
          salary_advance_amount_vnd: "1000000",
          salary_advance_schedule: null,
        },
      },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "weekly_salary_available=false with schedule",
      {
        compensation: {
          weekly_salary_available: false,
          weekly_salary_payment_schedule: "Thứ 7 hàng tuần",
        },
      },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "require_other_documents=true without text",
      {
        documents: {
          require_other_documents: true,
          other_documents_text: null,
        },
      },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
    [
      "duplicate labor_type_keys",
      { general: { labor_type_keys: ["CHINH_THUC", "CHINH_THUC"] } },
      "RECRUITMENT_POST_CONTENT_INVALID",
    ],
  ];

  for (const [idx, [label, overrides, expectedMsg]] of badCases.entries()) {
    const err = await rpcError(db, "recruitment_post_create", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_payload: makeCreatePayload(
        "PROJ_RP_A",
        PARK_BA_THIEN_1.industrial_park_id,
        overrides,
      ),
      p_idempotency_key: KEY(400 + idx),
    });
    assert.equal(err?.code, "22023", `Expected 22023 for ${label}`);
    assert.equal(err?.message, expectedMsg, `Expected ${expectedMsg} for ${label}`);
  }

  // Create a post for OCC and idempotency tests
  const idemCreate = KEY(450);
  const createPayload = makeCreatePayload(
    "PROJ_RP_A",
    PARK_BA_THIEN_1.industrial_park_id,
  );
  const created = await rpc(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: createPayload,
    p_idempotency_key: idemCreate,
  });
  const briefId = created.post.brief_id;

  // T-IDEM-01: Replay create with exact same (actor, action, idempotency_key, payload)
  const replayedCreate = await rpc(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: createPayload,
    p_idempotency_key: idemCreate,
  });
  assert.equal(replayedCreate.replayed, true);
  assert.equal(replayedCreate.post.brief_id, briefId);

  // T-IDEM-02: Same idempotency_key with different payload -> PT409 RECRUITMENT_POST_IDEMPOTENCY_CONFLICT
  const errDiffPayload = await rpcError(db, "recruitment_post_create", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id, {
      general: { expected_headcount: 999 },
    }),
    p_idempotency_key: idemCreate,
  });
  assert.equal(errDiffPayload?.code, "PT409");
  assert.equal(errDiffPayload?.message, "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT");

  // T-IDEM-03: Same idempotency_key with different action (update / withdraw) -> PT409 RECRUITMENT_POST_IDEMPOTENCY_CONFLICT
  const errDiffAction = await rpcError(db, "recruitment_post_withdraw", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: briefId,
    p_expected_version: 1,
    p_idempotency_key: idemCreate,
  });
  assert.equal(errDiffAction?.code, "PT409");
  assert.equal(errDiffAction?.message, "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT");

  // T-IDEM-04: Same idempotency_key with different actor -> PT409 RECRUITMENT_POST_IDEMPOTENCY_CONFLICT
  const errDiffActor = await rpcError(db, "recruitment_post_create", {
    p_auth_subject: ADMIN_ALSO_PM.auth,
    p_app_user_id: ADMIN_ALSO_PM.app,
    p_payload: createPayload,
    p_idempotency_key: idemCreate,
  });
  assert.equal(errDiffActor?.code, "PT409");
  assert.equal(errDiffActor?.message, "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT");

  // T-IDEM-05 (Q7): No-op update does not increment version or add revision/audit, but finishes idempotency so replay returns replayed=true
  const idemNoop = KEY(451);
  const { rows: revBeforeNoop } = await db.query(
    "select count(*)::int as c from public.recruitment_project_brief_revisions where brief_id = $1::uuid",
    [briefId],
  );
  const noop1 = await rpc(db, "recruitment_post_update", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: briefId,
    p_expected_version: 1,
    p_payload: makeBriefContent(),
    p_idempotency_key: idemNoop,
  });
  assert.equal(noop1.changed, false);
  assert.equal(noop1.replayed, false);
  assert.equal(noop1.post.version, 1);

  const { rows: revAfterNoop } = await db.query(
    "select count(*)::int as c from public.recruitment_project_brief_revisions where brief_id = $1::uuid",
    [briefId],
  );
  assert.equal(revAfterNoop[0].c, revBeforeNoop[0].c);

  const noop2 = await rpc(db, "recruitment_post_update", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: briefId,
    p_expected_version: 1,
    p_payload: makeBriefContent(),
    p_idempotency_key: idemNoop,
  });
  assert.equal(noop2.changed, false);
  assert.equal(noop2.replayed, true);
  assert.equal(noop2.post.version, 1);

  // T-OCC-01: Stale expected_version -> PT409 RECRUITMENT_POST_STALE
  const errStale = await rpcError(db, "recruitment_post_update", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: briefId,
    p_expected_version: 99,
    p_payload: makeBriefContent({ general: { customer_name: "Stale" } }),
    p_idempotency_key: KEY(452),
  });
  assert.equal(errStale?.code, "PT409");
  assert.equal(errStale?.message, "RECRUITMENT_POST_STALE");

  // Withdraw post
  const withdrawn = await rpc(db, "recruitment_post_withdraw", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: briefId,
    p_expected_version: 1,
    p_idempotency_key: KEY(453),
  });
  assert.equal(withdrawn.post.status, "WITHDRAWN");
  assert.equal(withdrawn.post.version, 2);

  // T-OCC-02: Update or withdraw on already WITHDRAWN post with matching expected_version=2 -> PT409 RECRUITMENT_POST_ALREADY_WITHDRAWN
  const errUpdWithdrawn = await rpcError(db, "recruitment_post_update", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: briefId,
    p_expected_version: 2,
    p_payload: makeBriefContent({ general: { customer_name: "After withdraw" } }),
    p_idempotency_key: KEY(454),
  });
  assert.equal(errUpdWithdrawn?.code, "PT409");
  assert.equal(errUpdWithdrawn?.message, "RECRUITMENT_POST_ALREADY_WITHDRAWN");

  const errWdWithdrawn = await rpcError(db, "recruitment_post_withdraw", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: briefId,
    p_expected_version: 2,
    p_idempotency_key: KEY(455),
  });
  assert.equal(errWdWithdrawn?.code, "PT409");
  assert.equal(errWdWithdrawn?.message, "RECRUITMENT_POST_ALREADY_WITHDRAWN");
});

test("T-FEED-01..08: Snapshot S1 + Keyset Cursor C1 pagination across 25 posts, concurrent edits between pages, pinned labor_type_key membership as-of S, immediate withdrawal removal, cursor/snapshot validation, and province filter stability", async () => {
  // Create 25 PUBLISHED posts: 15 in PARK_BA_THIEN_1 (VINH_PHUC, CHINH_THUC) and 10 in PARK_PHU_HA (PHU_THO, THOI_VU)
  const createdIds = [];
  for (let i = 1; i <= 25; i += 1) {
    const isVinhPhuc = i <= 15;
    const park = isVinhPhuc ? PARK_BA_THIEN_1 : PARK_PHU_HA;
    const laborKeys = isVinhPhuc ? ["CHINH_THUC"] : ["THOI_VU"];
    const res = await rpc(db, "recruitment_post_create", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_payload: makeCreatePayload("PROJ_RP_A", park.industrial_park_id, {
        general: {
          customer_name: `Khách hàng Feed #${String(i).padStart(2, "0")}`,
          labor_type_keys: laborKeys,
        },
      }),
      p_idempotency_key: KEY(500 + i),
    });
    createdIds.push(res.post.brief_id);
  }

  // T-FEED-01: Paginate all 25 posts across 3 pages (10, 10, 5) with same snapshot_token
  const page1 = await rpc(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_page_size: 10,
  });
  assert.ok(projectRecruitmentPostList(page1) !== null);
  assert.equal(page1.items.length, 10);
  assert.equal(page1.has_more, true);
  assert.ok(page1.next_cursor);

  const page2 = await rpc(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_snapshot_token: page1.snapshot_token,
    p_cursor: page1.next_cursor,
    p_page_size: 10,
  });
  assert.equal(page2.items.length, 10);
  assert.equal(page2.has_more, true);
  assert.equal(page2.snapshot_token, page1.snapshot_token);

  const page3 = await rpc(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_snapshot_token: page1.snapshot_token,
    p_cursor: page2.next_cursor,
    p_page_size: 10,
  });
  assert.equal(page3.items.length, 5);
  assert.equal(page3.has_more, false);
  assert.equal(page3.next_cursor, null);

  const all25 = [...page1.items, ...page2.items, ...page3.items].map(
    (item) => item.brief_id,
  );
  assert.equal(new Set(all25).size, 25, "All 25 items across 3 pages must be unique");

  // T-FEED-02 & T-FEED-03 (Must fix 1): Open page 1 filtered by labor_type_key = 'CHINH_THUC' (15 items total: 10 on page 1, 5 on page 2).
  // Between page 1 and page 2:
  //   - Edit an item on page 1 (so its current updated_at becomes newest)
  //   - Edit an item on page 2 to change its labor_type_keys from ['CHINH_THUC'] to ['THOI_VU']
  //   - Edit a PT_PHU_HA item (which had ['THOI_VU'] at S) to ['CHINH_THUC']
  // Page 2 under snapshot S must STILL return the exact 5 items that had 'CHINH_THUC' at S!
  const ltPage1 = await rpc(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_labor_type_key: "CHINH_THUC",
    p_page_size: 10,
  });
  assert.equal(ltPage1.items.length, 10);
  assert.equal(ltPage1.has_more, true);

  // Expected 5 items on page 2 before any concurrent edits:
  const expectedLtPage2BeforeEdit = await rpc(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_labor_type_key: "CHINH_THUC",
    p_snapshot_token: ltPage1.snapshot_token,
    p_cursor: ltPage1.next_cursor,
    p_page_size: 10,
  });
  const expectedLtPage2Ids = expectedLtPage2BeforeEdit.items.map(
    (item) => item.brief_id,
  );
  assert.equal(expectedLtPage2Ids.length, 5);

  // Perform the 3 mutations after snapshot S was opened:
  await rpc(db, "recruitment_post_update", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: ltPage1.items[0].brief_id,
    p_expected_version: 1,
    p_payload: makeBriefContent({
      general: {
        customer_name: "Tin trang 1 bị sửa sau khi mở snapshot S",
        labor_type_keys: ["CHINH_THUC"],
      },
    }),
    p_idempotency_key: KEY(551),
  });

  await rpc(db, "recruitment_post_update", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: expectedLtPage2Ids[0],
    p_expected_version: 1,
    p_payload: makeBriefContent({
      general: {
        customer_name: "Tin trang 2 đổi sang THOI_VU sau snapshot S",
        labor_type_keys: ["THOI_VU"],
      },
    }),
    p_idempotency_key: KEY(552),
  });

  const phuHaPostId = createdIds[24];
  await rpc(db, "recruitment_post_update", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: phuHaPostId,
    p_expected_version: 1,
    p_payload: makeBriefContent({
      general: {
        customer_name: "Tin Phú Hà đổi sang CHINH_THUC sau snapshot S",
        labor_type_keys: ["CHINH_THUC"],
      },
    }),
    p_idempotency_key: KEY(553),
  });

  const ltPage2AfterEdits = await rpc(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_labor_type_key: "CHINH_THUC",
    p_snapshot_token: ltPage1.snapshot_token,
    p_cursor: ltPage1.next_cursor,
    p_page_size: 10,
  });
  assert.deepEqual(
    ltPage2AfterEdits.items.map((item) => item.brief_id),
    expectedLtPage2Ids,
    "As-of S membership and ordering must remain 100% stable across concurrent updates and labor_type changes",
  );

  // T-FEED-04: Withdraw one of the items on page 2 -> disappears immediately when loading page 2 under snapshot S
  const withdrawnPage2Id = expectedLtPage2Ids[1];
  await rpc(db, "recruitment_post_withdraw", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_brief_id: withdrawnPage2Id,
    p_expected_version: 1,
    p_idempotency_key: KEY(554),
  });

  const ltPage2AfterWithdraw = await rpc(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_labor_type_key: "CHINH_THUC",
    p_snapshot_token: ltPage1.snapshot_token,
    p_cursor: ltPage1.next_cursor,
    p_page_size: 10,
  });
  assert.deepEqual(
    ltPage2AfterWithdraw.items.map((item) => item.brief_id),
    expectedLtPage2Ids.filter((id) => id !== withdrawnPage2Id),
    "Withdrawn post must disappear immediately from page 2 without shifting or skipping remaining items",
  );

  // T-FEED-08 (Must fix 1): Paginate by province_id = VINH_PHUC while Admin tries to move parks with PUBLISHED posts between provinces
  const provPage1 = await rpc(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_province_id: PARK_BA_THIEN_1.province_id,
    p_page_size: 10,
  });
  assert.equal(provPage1.items.length, 10);
  assert.equal(provPage1.has_more, true);

  const errMoveVpToPt = await rpcError(db, "industrial_park_update_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_industrial_park_id: PARK_BA_THIEN_1.industrial_park_id,
    p_expected_version: 1,
    p_province_id: PARK_PHU_HA.province_id,
    p_display_name: null,
    p_reason: "Try move VP park during pagination",
    p_idempotency_key: KEY(560),
  });
  assert.equal(errMoveVpToPt?.code, "PT409");

  const errMovePtToVp = await rpcError(db, "industrial_park_update_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_industrial_park_id: PARK_PHU_HA.industrial_park_id,
    p_expected_version: 3,
    p_province_id: PARK_BA_THIEN_1.province_id,
    p_display_name: null,
    p_reason: "Try move PT park during pagination",
    p_idempotency_key: KEY(561),
  });
  assert.equal(errMovePtToVp?.code, "PT409");

  const provPage2 = await rpc(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_province_id: PARK_BA_THIEN_1.province_id,
    p_snapshot_token: provPage1.snapshot_token,
    p_cursor: provPage1.next_cursor,
    p_page_size: 10,
  });
  assert.equal(provPage2.items.length, 4); // 15 initially - 1 withdrawn = 14 total (10 + 4)

  // T-FEED-05, T-FEED-06, T-FEED-07: Cursor & snapshot_token validation at SQL boundary
  // Cursor of snapshot A with snapshot_token of snapshot B -> 22023 RECRUITMENT_POST_SNAPSHOT_INVALID
  const errCrossSnapshot = await rpcError(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_snapshot_token: provPage1.snapshot_token,
    p_cursor: page1.next_cursor,
  });
  assert.equal(errCrossSnapshot?.code, "22023");
  assert.equal(errCrossSnapshot?.message, "RECRUITMENT_POST_SNAPSHOT_INVALID");

  // Snapshot token of filter A used with filter B -> 22023 RECRUITMENT_POST_SNAPSHOT_INVALID
  const errCrossFilter = await rpcError(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_project_id: "PROJ_RP_B",
    p_snapshot_token: page1.snapshot_token,
  });
  assert.equal(errCrossFilter?.code, "22023");
  assert.equal(errCrossFilter?.message, "RECRUITMENT_POST_SNAPSHOT_INVALID");

  // Cursor without snapshot_token -> 22023 RECRUITMENT_POST_SNAPSHOT_INVALID
  const errCursorWithoutSnapshot = await rpcError(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_cursor: page1.next_cursor,
  });
  assert.equal(errCursorWithoutSnapshot?.code, "22023");
  assert.equal(
    errCursorWithoutSnapshot?.message,
    "RECRUITMENT_POST_SNAPSHOT_INVALID",
  );

  // Future snapshot_seq > max(revision_seq) -> 22023 RECRUITMENT_POST_SNAPSHOT_INVALID
  const tokenHash = page1.snapshot_token.split(".")[2];
  const errFutureSeq = await rpcError(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_snapshot_token: `S1.999999999.${tokenHash}`,
  });
  assert.equal(errFutureSeq?.code, "22023");
  assert.equal(errFutureSeq?.message, "RECRUITMENT_POST_SNAPSHOT_INVALID");

  // 19-digit integer (> bigint max) -> 22023 RECRUITMENT_POST_SNAPSHOT_INVALID (never 22003)
  const err19Digits = await rpcError(db, "recruitment_post_list", {
    p_auth_subject: REGULAR_STAFF.auth,
    p_app_user_id: REGULAR_STAFF.app,
    p_snapshot_token: `S1.9999999999999999999.${tokenHash}`,
  });
  assert.equal(err19Digits?.code, "22023");
  assert.equal(err19Digits?.message, "RECRUITMENT_POST_SNAPSHOT_INVALID");
});

test("T-MINE-01..07: recruitment_post_list_mine creator-only PUBLISHED + WITHDRAWN projection, former PM history retention, page_size=15 bounds, 15+5 snapshot pagination, and cross-tab token rejection", async () => {
  // T-MINE-07: $self_check$ in 20261110150000_recruitment_post_list_mine.sql fails with 55000 if owned by NOBYPASSRLS role
  const mineMigrationSql = await readFile(
    path.join(MIGRATION_DIR, RECRUITMENT_POST_LIST_MINE_MIGRATION_NAME),
    "utf8",
  );
  const mineSelfCheckMatch = mineMigrationSql.match(
    /do \$self_check\$[\s\S]*?\$self_check\$;/,
  );
  assert.ok(mineSelfCheckMatch, "Expected $self_check$ block in list_mine migration");
  let mineSelfCheckErr = null;
  await db.exec("begin");
  try {
    await db.exec(
      "alter function public.recruitment_post_list_mine(uuid, uuid, text, text, integer) owner to rp_nobypass_migrator",
    );
    await db.exec(mineSelfCheckMatch[0]);
  } catch (err) {
    mineSelfCheckErr = err;
  } finally {
    await db.exec("rollback");
  }
  assert.ok(mineSelfCheckErr);
  assert.equal(mineSelfCheckErr.code, "55000");
  assert.match(mineSelfCheckErr.message, /must bypass FORCE RLS/);

  // T-MINE-04: Default page_size = 15 and bounds (1..15) on both recruitment_post_list and recruitment_post_list_mine
  const { rows: defaultListRows } = await db.query(
    "select public.recruitment_post_list($1::uuid, $2::uuid) as result",
    [REGULAR_STAFF.auth, REGULAR_STAFF.app],
  );
  assert.equal(defaultListRows[0].result.page_size, 15);
  assert.equal(defaultListRows[0].result.items.length, 15);

  const { rows: defaultMineRows } = await db.query(
    "select public.recruitment_post_list_mine($1::uuid, $2::uuid) as result",
    [PM_A.auth, PM_A.app],
  );
  assert.equal(defaultMineRows[0].result.page_size, 15);
  assert.ok(projectRecruitmentPostList(defaultMineRows[0].result) !== null);

  for (const rpcName of ["recruitment_post_list", "recruitment_post_list_mine"]) {
    for (const invalidSize of [0, 16, -1, null]) {
      const errSize = await rpcError(db, rpcName, {
        p_auth_subject: PM_A.auth,
        p_app_user_id: PM_A.app,
        p_page_size: invalidSize,
      });
      assert.equal(errSize?.code, "22023", `${rpcName} must reject page_size=${invalidSize}`);
      assert.equal(errSize?.message, "RECRUITMENT_POST_INPUT_INVALID");
    }
  }

  // T-MINE-01 & T-MINE-02: PM_A sees only posts where created_by_app_user_id = PM_A.app (both PUBLISHED and WITHDRAWN),
  // never posts created by ADMIN_ALSO_PM or PM_B. Full Admin (NOBITA_ADMIN) with 0 created posts gets empty items.
  const nobitaMine = await rpc(db, "recruitment_post_list_mine", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_page_size: 15,
  });
  assert.deepEqual(nobitaMine.items, []);
  assert.equal(nobitaMine.has_more, false);
  assert.equal(nobitaMine.next_cursor, null);

  const bodMine = await rpc(db, "recruitment_post_list_mine", {
    p_auth_subject: LIENVU_BOD.auth,
    p_app_user_id: LIENVU_BOD.app,
    p_page_size: 15,
  });
  assert.deepEqual(bodMine.items, []);

  // Ensure PM_B has at least 20 posts total (mix of PUBLISHED and WITHDRAWN) to test 15 + 5 pagination
  const { rows: pmBCountRows } = await db.query(
    "select count(*)::int as c from public.recruitment_project_briefs where created_by_app_user_id = $1::uuid",
    [PM_B.app],
  );
  const existingPmBCount = pmBCountRows[0].c;
  const neededFor20 = Math.max(0, 20 - existingPmBCount);
  const createdForPmB = [];
  for (let i = 0; i < neededFor20; i++) {
    const created = await rpc(db, "recruitment_post_create", {
      p_auth_subject: PM_B.auth,
      p_app_user_id: PM_B.app,
      p_payload: makeCreatePayload(
        "PROJ_RP_B",
        PARK_BA_THIEN_1.industrial_park_id,
        {
          general: {
            customer_name: `Công ty Tin Của Tôi PM_B #${i + 1}`,
            expected_headcount: 50 + i,
          },
        },
      ),
      p_idempotency_key: KEY(700 + i),
    });
    createdForPmB.push(created.post);
  }
  // Withdraw one of PM_B's newly created posts so PM_B has both PUBLISHED and WITHDRAWN
  const targetWithdrawPost = createdForPmB[createdForPmB.length - 1];
  await rpc(db, "recruitment_post_withdraw", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_brief_id: targetWithdrawPost.brief_id,
    p_expected_version: targetWithdrawPost.version,
    p_idempotency_key: KEY(750),
  });

  // Paginate PM_B's 20 posts across page 1 (15 items) and page 2 (5 items)
  const pmBPage1 = await rpc(db, "recruitment_post_list_mine", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_page_size: 15,
  });
  assert.ok(projectRecruitmentPostList(pmBPage1) !== null);
  assert.equal(pmBPage1.page_size, 15);
  assert.equal(pmBPage1.items.length, 15);
  assert.equal(pmBPage1.has_more, true);
  assert.ok(pmBPage1.next_cursor);

  // Concurrent mutation by PM_B after snapshot S1 is taken must not corrupt S1 pagination
  await rpc(db, "recruitment_post_update", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_brief_id: createdForPmB[0].brief_id,
    p_expected_version: 1,
    p_payload: makeBriefContent({
      general: { customer_name: "Cập nhật sau snapshot S1" },
    }),
    p_idempotency_key: KEY(751),
  });

  const pmBPage2 = await rpc(db, "recruitment_post_list_mine", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_snapshot_token: pmBPage1.snapshot_token,
    p_cursor: pmBPage1.next_cursor,
    p_page_size: 15,
  });
  assert.ok(projectRecruitmentPostList(pmBPage2) !== null);
  assert.equal(pmBPage2.items.length, 5);
  assert.equal(pmBPage2.has_more, false);
  assert.equal(pmBPage2.next_cursor, null);

  const allPmBMineItems = [...pmBPage1.items, ...pmBPage2.items];
  const uniquePmBIds = new Set(allPmBMineItems.map((it) => it.brief_id));
  assert.equal(uniquePmBIds.size, 20, "Zero duplicate or missing items across 15+5 pages");
  assert.equal(
    allPmBMineItems.some((it) => it.status === "WITHDRAWN"),
    true,
    "Mine list must include WITHDRAWN posts",
  );
  assert.equal(
    allPmBMineItems.some((it) => it.status === "PUBLISHED"),
    true,
    "Mine list must include PUBLISHED posts",
  );

  // Verify every returned item actually belongs to PM_B in DB
  const { rows: ownerCheckRows } = await db.query(
    `select count(*)::int as wrong_owner
       from public.recruitment_project_briefs
      where brief_id = any($1::uuid[])
        and created_by_app_user_id <> $2::uuid`,
    [Array.from(uniquePmBIds), PM_B.app],
  );
  assert.equal(ownerCheckRows[0].wrong_owner, 0);

  // Verify WITHDRAWN item has can_edit=false and can_withdraw=false
  const withdrawnItemInMine = allPmBMineItems.find(
    (it) => it.brief_id === targetWithdrawPost.brief_id,
  );
  assert.ok(withdrawnItemInMine);
  assert.equal(withdrawnItemInMine.status, "WITHDRAWN");
  assert.deepEqual(withdrawnItemInMine.allowed_actions, {
    can_edit: false,
    can_withdraw: false,
  });

  // T-MINE-03: Former PM whose assignment on PROJ_RP_B ended (can_create=false) still sees their created posts in recruitment_post_list_mine
  await db.exec("begin");
  try {
    await db.query(
      `update public.direct_entry_project_manager_assignments
          set is_current = false,
              valid_to = '2026-06-01'::date,
              revoked_at = '2026-06-01T00:00:00Z'::timestamptz
        where manager_recruiter_id = $1::uuid
          and is_current = true`,
      [PM_B.recruiter],
    );
    const formerPmCtx = await rpc(db, "recruitment_post_get_context", {
      p_auth_subject: PM_B.auth,
      p_app_user_id: PM_B.app,
    });
    assert.equal(formerPmCtx.can_create, false);

    const formerPmMine = await rpc(db, "recruitment_post_list_mine", {
      p_auth_subject: PM_B.auth,
      p_app_user_id: PM_B.app,
      p_page_size: 15,
    });
    assert.equal(formerPmMine.items.length, 15);
    for (const item of formerPmMine.items) {
      const expectedMutate = item.status === "PUBLISHED";
      assert.deepEqual(
        item.allowed_actions,
        { can_edit: expectedMutate, can_withdraw: expectedMutate },
        "Former PM must retain history in Tin của tôi with status-derived allowed_actions",
      );
    }
  } finally {
    await db.exec("rollback");
  }

  // T-MINE-06: Cross-tab and cross-actor snapshot/cursor tokens must fail with 22023 RECRUITMENT_POST_SNAPSHOT_INVALID
  const pubFeedPage = await rpc(db, "recruitment_post_list", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_page_size: 15,
  });
  const errPubTokenInMine = await rpcError(db, "recruitment_post_list_mine", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_snapshot_token: pubFeedPage.snapshot_token,
    p_page_size: 15,
  });
  assert.equal(errPubTokenInMine?.code, "22023");
  assert.equal(errPubTokenInMine?.message, "RECRUITMENT_POST_SNAPSHOT_INVALID");

  const errMineTokenInPub = await rpcError(db, "recruitment_post_list", {
    p_auth_subject: PM_B.auth,
    p_app_user_id: PM_B.app,
    p_snapshot_token: pmBPage1.snapshot_token,
    p_page_size: 15,
  });
  assert.equal(errMineTokenInPub?.code, "22023");
  assert.equal(errMineTokenInPub?.message, "RECRUITMENT_POST_SNAPSHOT_INVALID");

  const errCrossActorMineToken = await rpcError(db, "recruitment_post_list_mine", {
    p_auth_subject: PM_A.auth,
    p_app_user_id: PM_A.app,
    p_snapshot_token: pmBPage1.snapshot_token,
    p_page_size: 15,
  });
  assert.equal(errCrossActorMineToken?.code, "22023");
  assert.equal(errCrossActorMineToken?.message, "RECRUITMENT_POST_SNAPSHOT_INVALID");

  // =========================================================================
  // 10. Public Feed v1 (`recruitment_post_public_feed_v1`) ACL, lifecycle & allowlist
  // =========================================================================
  assert.equal(
    RECRUITMENT_POST_PUBLIC_FEED_V1_MIGRATION_NAME,
    "20261111190000_recruitment_post_public_feed_v1.sql",
  );
  assert.deepEqual(RECRUITMENT_POST_PUBLIC_FEED_V1_RPC_SIGNATURES, [
    "public.recruitment_post_public_feed_v1()",
  ]);

  // T-PUB-01: anon and authenticated cannot execute recruitment_post_public_feed_v1; service_role can
  for (const deniedRole of ["anon", "authenticated"]) {
    await db.exec(`set role ${deniedRole}`);
    try {
      const deniedErr = await rpcError(db, "recruitment_post_public_feed_v1");
      assert.equal(
        deniedErr?.code,
        "42501",
        `${deniedRole} must be denied EXECUTE on recruitment_post_public_feed_v1`,
      );
    } finally {
      await db.exec("reset role");
    }
  }

  // T-PUB-02: Create -> Update -> Withdraw lifecycle and empty feed in an isolated transaction
  await db.exec("begin");
  try {
    // Withdraw all currently PUBLISHED posts so feed becomes genuinely empty
    const { rows: activeBriefRows } = await db.query(
      `select brief_id, version
         from public.recruitment_project_briefs
        where status = 'PUBLISHED'`,
    );
    let drainSeq = 9000;
    for (const row of activeBriefRows) {
      drainSeq += 1;
      await rpc(db, "recruitment_post_withdraw", {
        p_auth_subject: NOBITA_ADMIN.auth,
        p_app_user_id: NOBITA_ADMIN.app,
        p_brief_id: row.brief_id,
        p_expected_version: row.version,
        p_idempotency_key: KEY(drainSeq),
      });
    }

    await db.exec("set local role service_role");
    const emptyPublicFeed = await rpc(db, "recruitment_post_public_feed_v1");
    await db.exec("reset role");
    assert.deepEqual(emptyPublicFeed, {
      schema_version: 1,
      jobs: [],
    });
    assert.deepEqual(
      projectRecruitmentPostPublicFeedV1(emptyPublicFeed),
      emptyPublicFeed,
    );

    // Create a new PUBLISHED post (with gender_requirement = 'ANY' and internal manager_phone/manager_name)
    const createdForPub = await rpc(db, "recruitment_post_create", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id, {
        general: {
          customer_name: "Công ty Điện tử Public Feed",
          job_description: "Vận hành máy SMT ban đầu",
          manager_name: "Nội Bộ Không Được Lộ",
          manager_phone: "0999888777",
        },
        candidate: {
          gender_requirement: "ANY",
        },
      }),
      p_idempotency_key: KEY(9501),
    });
    const pubBriefId = createdForPub.post.brief_id;

    await db.exec("set local role service_role");
    const feedAfterCreate = await rpc(db, "recruitment_post_public_feed_v1");
    await db.exec("reset role");
    const projectedCreateFeed = projectRecruitmentPostPublicFeedV1(feedAfterCreate);
    assert.ok(projectedCreateFeed !== null, "Public feed after create must pass contract projection");
    assert.equal(projectedCreateFeed.schema_version, 1);
    assert.equal(projectedCreateFeed.jobs.length, 1);
    assert.equal(projectedCreateFeed.jobs[0].id, pubBriefId);
    assert.equal(projectedCreateFeed.jobs[0].brief_id, pubBriefId);
    assert.equal(projectedCreateFeed.jobs[0].version, 1);
    assert.equal(
      projectedCreateFeed.jobs[0].general.job_description,
      "Vận hành máy SMT ban đầu",
    );
    assert.equal(projectedCreateFeed.jobs[0].candidate.gender_requirement, "ANY");
    assert.equal(projectedCreateFeed.jobs[0].candidate.gender_label, "Nam/Nữ");
    // Internal fields must never appear in the serialized feed
    const rawCreateFeedStr = JSON.stringify(feedAfterCreate);
    assert.equal(rawCreateFeedStr.includes("0999888777"), false);
    assert.equal(rawCreateFeedStr.includes("Nội Bộ Không Được Lộ"), false);
    assert.equal(rawCreateFeedStr.includes("manager_phone"), false);
    assert.equal(rawCreateFeedStr.includes("manager_name"), false);
    assert.equal(rawCreateFeedStr.includes("allowed_actions"), false);
    assert.equal(rawCreateFeedStr.includes("created_by"), false);
    assert.equal(rawCreateFeedStr.includes("updated_by"), false);

    // Update the post -> keeps exact same ID (`id` / `brief_id`), increments version, updates content & updated_at
    await rpc(db, "recruitment_post_update", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_brief_id: pubBriefId,
      p_expected_version: 1,
      p_payload: makeBriefContent({
        general: {
          customer_name: "Công ty Điện tử Public Feed",
          job_description: "Vận hành máy SMT đã cập nhật",
          manager_name: "Nội Bộ Không Được Lộ",
          manager_phone: "0999888777",
        },
        candidate: {
          gender_requirement: "ANY",
        },
      }),
      p_idempotency_key: KEY(9502),
    });

    await db.exec("set local role service_role");
    const feedAfterUpdate = await rpc(db, "recruitment_post_public_feed_v1");
    await db.exec("reset role");
    const projectedUpdateFeed = projectRecruitmentPostPublicFeedV1(feedAfterUpdate);
    assert.ok(projectedUpdateFeed !== null);
    assert.equal(projectedUpdateFeed.jobs.length, 1);
    assert.equal(projectedUpdateFeed.jobs[0].id, pubBriefId);
    assert.equal(projectedUpdateFeed.jobs[0].brief_id, pubBriefId);
    assert.equal(projectedUpdateFeed.jobs[0].version, 2);
    assert.equal(
      projectedUpdateFeed.jobs[0].general.job_description,
      "Vận hành máy SMT đã cập nhật",
    );

    // Withdraw the post -> disappears on the next read
    await rpc(db, "recruitment_post_withdraw", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_brief_id: pubBriefId,
      p_expected_version: 2,
      p_idempotency_key: KEY(9503),
    });

    await db.exec("set local role service_role");
    const feedAfterWithdraw = await rpc(db, "recruitment_post_public_feed_v1");
    await db.exec("reset role");
    assert.deepEqual(feedAfterWithdraw, {
      schema_version: 1,
      jobs: [],
    });
  } finally {
    await db.exec("rollback");
  }
});

test("T-FACETS-01..07: recruitment_post_list_with_facets ACL, >20-post fixture with out-of-page-1 facets, single/combined filters, page-2 cursor, empty filter match, multi-labor-type counting, deactivated KCN, Vietnamese sort + code tie-breaker, and legacy 5-key web compatibility", async () => {
  assert.deepEqual(RECRUITMENT_POST_LIST_WITH_FACETS_RPC_SIGNATURES, [
    "public.recruitment_post_list_with_facets(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer)",
  ]);

  // T-FACETS-01: $self_check$ fails with 55000 if owned by NOBYPASSRLS role, and anon/authenticated are denied with 42501
  const facetsMigrationSql = await readFile(
    path.join(MIGRATION_DIR, RECRUITMENT_POST_LIST_WITH_FACETS_MIGRATION_NAME),
    "utf8",
  );
  const selfCheckMatch = facetsMigrationSql.match(
    /do \$self_check\$[\s\S]*?\$self_check\$;/,
  );
  assert.ok(selfCheckMatch, "Expected $self_check$ block in list_with_facets migration");

  let selfCheckErr = null;
  await db.exec("begin");
  try {
    await db.exec(
      "alter function public.recruitment_post_list_with_facets(uuid, uuid, text, uuid, uuid, text, date, date, text, text, integer) owner to rp_nobypass_migrator",
    );
    await db.exec(selfCheckMatch[0]);
  } catch (err) {
    selfCheckErr = err;
  } finally {
    await db.exec("rollback");
  }
  assert.ok(selfCheckErr);
  assert.equal(selfCheckErr.code, "55000");

  for (const deniedRole of ["anon", "authenticated"]) {
    let roleErr = null;
    await db.exec("begin");
    try {
      await db.exec(`set local role ${deniedRole}`);
      await rpc(db, "recruitment_post_list_with_facets", {
        p_auth_subject: REGULAR_STAFF.auth,
        p_app_user_id: REGULAR_STAFF.app,
        p_page_size: 10,
      });
    } catch (err) {
      roleErr = err;
    } finally {
      await db.exec("rollback");
    }
    assert.ok(roleErr, `${deniedRole} must be denied EXECUTE on recruitment_post_list_with_facets`);
    assert.equal(roleErr.code, "42501");
  }

  // Disabled user and unmapped actor are denied with 42501 RECRUITMENT_POST_ACCESS_DENIED
  const disabledErr = await rpcError(db, "recruitment_post_list_with_facets", {
    p_auth_subject: DISABLED_USER.auth,
    p_app_user_id: DISABLED_USER.app,
    p_page_size: 10,
  });
  assert.equal(disabledErr?.code, "42501");
  assert.equal(disabledErr?.message, "RECRUITMENT_POST_ACCESS_DENIED");

  await db.exec("begin");
  try {
    // 1. Drain all existing PUBLISHED posts -> verify empty state returns total_count: 0 and two empty arrays
    const { rows: existingPub } = await db.query(
      "select brief_id, version from public.recruitment_project_briefs where status = 'PUBLISHED'",
    );
    let seq = 9600;
    for (const row of existingPub) {
      seq += 1;
      await rpc(db, "recruitment_post_withdraw", {
        p_auth_subject: NOBITA_ADMIN.auth,
        p_app_user_id: NOBITA_ADMIN.app,
        p_brief_id: row.brief_id,
        p_expected_version: row.version,
        p_idempotency_key: KEY(seq),
      });
    }

    await db.exec("set local role service_role");
    const emptyFacets = await rpc(db, "recruitment_post_list_with_facets", {
      p_auth_subject: REGULAR_STAFF.auth,
      p_app_user_id: REGULAR_STAFF.app,
      p_page_size: 10,
    });
    await db.exec("reset role");
    const projectedEmpty = projectRecruitmentPostListWithFacets(emptyFacets);
    assert.ok(projectedEmpty !== null);
    assert.deepEqual(projectedEmpty.items, []);
    assert.equal(projectedEmpty.page_size, 10);
    assert.equal(projectedEmpty.has_more, false);
    assert.equal(projectedEmpty.next_cursor, null);
    assert.equal(projectedEmpty.total_count, 0);
    assert.deepEqual(projectedEmpty.industrial_parks, []);
    assert.deepEqual(projectedEmpty.labor_types, []);

    // 2. Seed additional labor type and industrial parks for Vietnamese sort & tie-breaker + deactivated KCN tests
    await db.query(
      `insert into public.direct_entry_labor_types (labor_type_key, display_name, reporting_key, sort_order, active)
       values ('KHOAN_SP', 'Khoán sản phẩm', 'khoan_sp', 40, true)
       on conflict (labor_type_key) do nothing`,
    );

    const PARK_DIEM_THUY_ID = "10000000-0000-4000-8000-000000000311";
    const PARK_PHU_HA_DUP_ID = "10000000-0000-4000-8000-000000000312";
    const PARK_TO_DEACTIVATE_ID = "10000000-0000-4000-8000-000000000313";
    const PARK_AN_NFD_ID = "10000000-0000-4000-8000-000000000314";
    const PARK_ANG_ID = "10000000-0000-4000-8000-000000000315";
    const PARK_AN_NFD_DISPLAY_NAME = "KCN A\u0301n";

    await db.query(
      `insert into public.industrial_parks (
         industrial_park_id, industrial_park_code, province_id, display_name, normalized_key, active, version
       ) values
         ($1::uuid, 'DIEM_THUY', $6::uuid, 'KCN Điềm Thụy', 'diemthuy', true, 1),
         ($2::uuid, 'AA_PHU_HA_TIE', $7::uuid, $8, 'phuhavp', true, 1),
         ($3::uuid, 'SONG_KHE_TEMP', $6::uuid, 'KCN Song Khê', 'songkhe', true, 1),
         ($4::uuid, 'ZZ_AN_NFD', $6::uuid, $9, 'kcnannfd', true, 1),
         ($5::uuid, 'AA_ANG', $6::uuid, 'KCN Ang', 'kcnang', true, 1)`,
      [
        PARK_DIEM_THUY_ID,
        PARK_PHU_HA_DUP_ID,
        PARK_TO_DEACTIVATE_ID,
        PARK_AN_NFD_ID,
        PARK_ANG_ID,
        PARK_PHU_HA.province_id,
        PARK_BA_THIEN_1.province_id,
        PARK_PHU_HA.display_name,
        PARK_AN_NFD_DISPLAY_NAME,
      ],
    );

    // 3. Create >20 PUBLISHED posts (24 posts total) in chronological order so oldest posts are outside the first 10 items:
    // - Oldest post #1: on PARK_TO_DEACTIVATE_ID ('KCN Song Khê'), with labor_type_keys: ['KHOAN_SP'] (ONLY appears outside first 10!)
    seq += 1;
    const postDeactivatedPark = await rpc(db, "recruitment_post_create", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_payload: makeCreatePayload("PROJ_RP_A", PARK_TO_DEACTIVATE_ID, {
        general: {
          customer_name: "Công ty KCN Sắp Tắt Danh Mục",
          labor_type_keys: ["KHOAN_SP"],
        },
      }),
      p_idempotency_key: KEY(seq),
    });

    // Deactivate PARK_TO_DEACTIVATE_ID in catalog AFTER the post is published!
    await db.query(
      "update public.industrial_parks set active = false, version = version + 1 where industrial_park_id = $1::uuid",
      [PARK_TO_DEACTIVATE_ID],
    );

    // - Post #2: on PARK_DIEM_THUY_ID ('KCN Điềm Thụy'), multi-labor-type ['CHINH_THUC', 'THOI_VU'] (also outside first 10!)
    seq += 1;
    const postMultiLabor = await rpc(db, "recruitment_post_create", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_payload: makeCreatePayload("PROJ_RP_A", PARK_DIEM_THUY_ID, {
        general: {
          customer_name: "Công ty Điềm Thụy Đa Hình Thức",
          labor_type_keys: ["CHINH_THUC", "THOI_VU"],
        },
      }),
      p_idempotency_key: KEY(seq),
    });

    // - Post #3: on PARK_PHU_HA_DUP_ID (display_name 'KCN Phú Hà', code 'AA_PHU_HA_TIE') with ['THOI_VU']
    seq += 1;
    await rpc(db, "recruitment_post_create", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_payload: makeCreatePayload("PROJ_RP_A", PARK_PHU_HA_DUP_ID, {
        general: {
          customer_name: "Công ty Phú Hà Tie Breaker",
          labor_type_keys: ["THOI_VU"],
        },
      }),
      p_idempotency_key: KEY(seq),
    });

    // - Post #4: on PARK_ANG_ID ('KCN Ang', code 'AA_ANG') with ['THOI_VU']
    seq += 1;
    await rpc(db, "recruitment_post_create", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_payload: makeCreatePayload("PROJ_RP_A", PARK_ANG_ID, {
        general: {
          customer_name: "Công ty KCN Ang",
          labor_type_keys: ["THOI_VU"],
        },
      }),
      p_idempotency_key: KEY(seq),
    });

    // - Post #5: on PARK_AN_NFD_ID ('KCN A\u0301n' decomposed Unicode, code 'ZZ_AN_NFD') with ['THOI_VU']
    seq += 1;
    await rpc(db, "recruitment_post_create", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_payload: makeCreatePayload("PROJ_RP_A", PARK_AN_NFD_ID, {
        general: {
          customer_name: "Công ty KCN Án NFD",
          labor_type_keys: ["THOI_VU"],
        },
      }),
      p_idempotency_key: KEY(seq),
    });

    // - Posts #6..#12 (7 posts): on PARK_PHU_HA ('KCN Phú Hà', code 'PT_PHU_HA') with ['THOI_VU']
    for (let i = 0; i < 7; i++) {
      seq += 1;
      await rpc(db, "recruitment_post_create", {
        p_auth_subject: PM_A.auth,
        p_app_user_id: PM_A.app,
        p_payload: makeCreatePayload("PROJ_RP_A", PARK_PHU_HA.industrial_park_id, {
          general: {
            customer_name: `Công ty Phú Hà #${i + 1}`,
            labor_type_keys: ["THOI_VU"],
          },
        }),
        p_idempotency_key: KEY(seq),
      });
    }

    // - Newest 12 posts (#13..#24): ALL on PARK_BA_THIEN_1 ('KCN Bá Thiện I') with ONLY ['CHINH_THUC']!
    //   This guarantees the first 10 items (page 1 with page_size=10) contain ONLY PARK_BA_THIEN_1 and 'CHINH_THUC',
    //   while all other parks and labor types only appear in items 11..24!
    for (let i = 0; i < 12; i++) {
      seq += 1;
      await rpc(db, "recruitment_post_create", {
        p_auth_subject: PM_A.auth,
        p_app_user_id: PM_A.app,
        p_payload: makeCreatePayload("PROJ_RP_A", PARK_BA_THIEN_1.industrial_park_id, {
          general: {
            customer_name: `Công ty Bá Thiện Mới Nhất #${i + 1}`,
            labor_type_keys: ["CHINH_THUC"],
          },
        }),
        p_idempotency_key: KEY(seq),
      });
    }

    const expectedParksFacet = [
      {
        industrial_park_id: PARK_AN_NFD_ID,
        industrial_park_code: "ZZ_AN_NFD",
        display_name: PARK_AN_NFD_DISPLAY_NAME,
        active: true,
        job_count: 1,
      },
      {
        industrial_park_id: PARK_ANG_ID,
        industrial_park_code: "AA_ANG",
        display_name: "KCN Ang",
        active: true,
        job_count: 1,
      },
      {
        industrial_park_id: PARK_BA_THIEN_1.industrial_park_id,
        industrial_park_code: PARK_BA_THIEN_1.industrial_park_code,
        display_name: PARK_BA_THIEN_1.display_name,
        active: true,
        job_count: 12,
      },
      {
        industrial_park_id: PARK_DIEM_THUY_ID,
        industrial_park_code: "DIEM_THUY",
        display_name: "KCN Điềm Thụy",
        active: true,
        job_count: 1,
      },
      {
        industrial_park_id: PARK_PHU_HA_DUP_ID,
        industrial_park_code: "AA_PHU_HA_TIE",
        display_name: PARK_PHU_HA.display_name,
        active: true,
        job_count: 1,
      },
      {
        industrial_park_id: PARK_PHU_HA.industrial_park_id,
        industrial_park_code: PARK_PHU_HA.industrial_park_code,
        display_name: PARK_PHU_HA.display_name,
        active: true,
        job_count: 7,
      },
      {
        industrial_park_id: PARK_TO_DEACTIVATE_ID,
        industrial_park_code: "SONG_KHE_TEMP",
        display_name: "KCN Song Khê",
        active: true,
        job_count: 1,
      },
    ];
    const expectedLaborTypesFacet = [
      {
        labor_type_key: "CHINH_THUC",
        display_name: "Chính thức",
        job_count: 13,
      },
      {
        labor_type_key: "THOI_VU",
        display_name: "Thời vụ",
        job_count: 11,
      },
      {
        labor_type_key: "KHOAN_SP",
        display_name: "Khoán sản phẩm",
        job_count: 1,
      },
    ];

    // T-FACETS-02: Page 1 with page_size=10 returns only 10 items (all BA_THIEN_1 + CHINH_THUC),
    // yet facets contain all 7 industrial parks (with 'KCN A\u0301n' sorted before 'KCN Ang') and all 3 labor types across all 24 posts!
    const page1 = projectRecruitmentPostListWithFacets(
      await rpc(db, "recruitment_post_list_with_facets", {
        p_auth_subject: REGULAR_STAFF.auth,
        p_app_user_id: REGULAR_STAFF.app,
        p_page_size: 10,
      }),
    );
    assert.ok(page1 !== null);
    assert.equal(page1.items.length, 10);
    assert.equal(page1.page_size, 10);
    assert.equal(page1.has_more, true);
    assert.ok(page1.next_cursor !== null);
    assert.equal(
      page1.items.every(
        (it) =>
          it.industrial_park.industrial_park_id ===
            PARK_BA_THIEN_1.industrial_park_id &&
          it.general.labor_types.length === 1 &&
          it.general.labor_types[0].labor_type_key === "CHINH_THUC",
      ),
      true,
      "First 10 items only contain KCN Bá Thiện 1 and CHINH_THUC",
    );
    assert.equal(page1.total_count, 24);
    assert.deepEqual(page1.industrial_parks, expectedParksFacet);
    assert.deepEqual(page1.labor_types, expectedLaborTypesFacet);

    // T-FACETS-03: Load Page 2 and Page 3 with cursor + snapshot_token and page_size=10
    const page2 = projectRecruitmentPostListWithFacets(
      await rpc(db, "recruitment_post_list_with_facets", {
        p_auth_subject: REGULAR_STAFF.auth,
        p_app_user_id: REGULAR_STAFF.app,
        p_cursor: page1.next_cursor,
        p_snapshot_token: page1.snapshot_token,
        p_page_size: 10,
      }),
    );
    assert.ok(page2 !== null);
    assert.equal(page2.items.length, 10);
    assert.equal(page2.has_more, true);
    assert.equal(page2.total_count, 24);
    assert.deepEqual(page2.industrial_parks, expectedParksFacet);
    assert.deepEqual(page2.labor_types, expectedLaborTypesFacet);

    const page3 = projectRecruitmentPostListWithFacets(
      await rpc(db, "recruitment_post_list_with_facets", {
        p_auth_subject: REGULAR_STAFF.auth,
        p_app_user_id: REGULAR_STAFF.app,
        p_cursor: page2.next_cursor,
        p_snapshot_token: page2.snapshot_token,
        p_page_size: 10,
      }),
    );
    assert.ok(page3 !== null);
    assert.equal(page3.items.length, 4);
    assert.equal(page3.has_more, false);
    assert.equal(page3.next_cursor, null);
    // Oldest item in page3 is on PARK_TO_DEACTIVATE_ID: in item projection, industrial_park.active is false (catalog truth),
    // while in facet industrial_parks it is active: true!
    const deactivatedParkItem = page3.items.find(
      (it) => it.brief_id === postDeactivatedPark.post.brief_id,
    );
    assert.ok(deactivatedParkItem);
    assert.equal(deactivatedParkItem.industrial_park.active, false);

    // Single filter by industrial_park_id (PARK_PHU_HA -> 7 items) still returns global facets (total_count=24)
    const filteredByPark = projectRecruitmentPostListWithFacets(
      await rpc(db, "recruitment_post_list_with_facets", {
        p_auth_subject: REGULAR_STAFF.auth,
        p_app_user_id: REGULAR_STAFF.app,
        p_industrial_park_id: PARK_PHU_HA.industrial_park_id,
        p_page_size: 10,
      }),
    );
    assert.ok(filteredByPark !== null);
    assert.equal(filteredByPark.items.length, 7);
    assert.equal(filteredByPark.has_more, false);
    assert.equal(filteredByPark.total_count, 24);
    assert.deepEqual(filteredByPark.industrial_parks, expectedParksFacet);
    assert.deepEqual(filteredByPark.labor_types, expectedLaborTypesFacet);

    // Single filter by labor_type_key ('KHOAN_SP' -> 1 item outside page 1 of unfiltered feed)
    const filteredByLabor = projectRecruitmentPostListWithFacets(
      await rpc(db, "recruitment_post_list_with_facets", {
        p_auth_subject: REGULAR_STAFF.auth,
        p_app_user_id: REGULAR_STAFF.app,
        p_labor_type_key: "KHOAN_SP",
        p_page_size: 10,
      }),
    );
    assert.ok(filteredByLabor !== null);
    assert.equal(filteredByLabor.items.length, 1);
    assert.equal(filteredByLabor.items[0].brief_id, postDeactivatedPark.post.brief_id);
    assert.equal(filteredByLabor.total_count, 24);

    // Combined filter (PARK_DIEM_THUY_ID + 'CHINH_THUC' -> 1 item: postMultiLabor)
    const filteredCombined = projectRecruitmentPostListWithFacets(
      await rpc(db, "recruitment_post_list_with_facets", {
        p_auth_subject: REGULAR_STAFF.auth,
        p_app_user_id: REGULAR_STAFF.app,
        p_industrial_park_id: PARK_DIEM_THUY_ID,
        p_labor_type_key: "CHINH_THUC",
        p_page_size: 10,
      }),
    );
    assert.ok(filteredCombined !== null);
    assert.equal(filteredCombined.items.length, 1);
    assert.equal(filteredCombined.items[0].brief_id, postMultiLabor.post.brief_id);
    assert.equal(filteredCombined.total_count, 24);

    // Empty filter match (PARK_BA_THIEN_1 + 'KHOAN_SP' -> 0 items) still returns global facets (total_count=24)
    const filteredNoMatch = projectRecruitmentPostListWithFacets(
      await rpc(db, "recruitment_post_list_with_facets", {
        p_auth_subject: REGULAR_STAFF.auth,
        p_app_user_id: REGULAR_STAFF.app,
        p_industrial_park_id: PARK_BA_THIEN_1.industrial_park_id,
        p_labor_type_key: "KHOAN_SP",
        p_page_size: 10,
      }),
    );
    assert.ok(filteredNoMatch !== null);
    assert.deepEqual(filteredNoMatch.items, []);
    assert.equal(filteredNoMatch.has_more, false);
    assert.equal(filteredNoMatch.next_cursor, null);
    assert.equal(filteredNoMatch.total_count, 24);
    assert.deepEqual(filteredNoMatch.industrial_parks, expectedParksFacet);
    assert.deepEqual(filteredNoMatch.labor_types, expectedLaborTypesFacet);

    // T-FACETS-05: Withdraw postMultiLabor (which had ['CHINH_THUC', 'THOI_VU'] on PARK_DIEM_THUY_ID)
    // -> total_count drops from 24 to 23, PARK_DIEM_THUY_ID disappears from industrial_parks,
    //    and both CHINH_THUC (13->12) and THOI_VU (11->10) decrease by 1!
    seq += 1;
    await rpc(db, "recruitment_post_withdraw", {
      p_auth_subject: PM_A.auth,
      p_app_user_id: PM_A.app,
      p_brief_id: postMultiLabor.post.brief_id,
      p_expected_version: 1,
      p_idempotency_key: KEY(seq),
    });

    const afterWithdraw = projectRecruitmentPostListWithFacets(
      await rpc(db, "recruitment_post_list_with_facets", {
        p_auth_subject: REGULAR_STAFF.auth,
        p_app_user_id: REGULAR_STAFF.app,
        p_page_size: 10,
      }),
    );
    assert.ok(afterWithdraw !== null);
    assert.equal(afterWithdraw.total_count, 23);
    assert.equal(
      afterWithdraw.industrial_parks.some(
        (p) => p.industrial_park_id === PARK_DIEM_THUY_ID,
      ),
      false,
      "KCN Điềm Thụy must disappear from facets once its only PUBLISHED post is withdrawn",
    );
    assert.deepEqual(afterWithdraw.labor_types, [
      { labor_type_key: "CHINH_THUC", display_name: "Chính thức", job_count: 12 },
      { labor_type_key: "THOI_VU", display_name: "Thời vụ", job_count: 10 },
      { labor_type_key: "KHOAN_SP", display_name: "Khoán sản phẩm", job_count: 1 },
    ]);

    // T-FACETS-07: Legacy Web RPC `recruitment_post_list` (default page_size=15) still returns exact 5 keys
    // and passes existing `projectRecruitmentPostList` parser
    const webLegacyRaw = await rpc(db, "recruitment_post_list", {
      p_auth_subject: REGULAR_STAFF.auth,
      p_app_user_id: REGULAR_STAFF.app,
      p_page_size: 15,
    });
    assert.deepEqual(
      Object.keys(webLegacyRaw).sort(),
      ["has_more", "items", "next_cursor", "page_size", "snapshot_token"],
    );
    const webLegacyProjected = projectRecruitmentPostList(webLegacyRaw);
    assert.ok(webLegacyProjected !== null);
    assert.equal(webLegacyProjected.items.length, 15);
    assert.equal(webLegacyProjected.page_size, 15);
    assert.equal(webLegacyProjected.has_more, true);
  } finally {
    await db.exec("rollback");
  }
});
