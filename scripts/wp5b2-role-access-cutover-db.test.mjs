/**
 * WP5B-2 — Cutover Role/Effective Access & Group A Paired Enforcement
 * PGlite Database & TypeScript Reader Contract Regression Suite.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { WP5B1_ROLE_EFFECTIVE_ACCESS_MIGRATION_NAME } from "./lib/migration-validation.mjs";
import { WP5_ROLE_CATALOG } from "./lib/wp5-cutover-manifest.mjs";
import {
  readCutoverInventory,
  runWp5Cutover,
  sanitizeCutoverReport,
  verifyPostCutoverInvariants,
} from "./wp5-cutover-role-access.mjs";
import {
  hasPairedAllReportingAccess,
  hasPairedFullAdmin,
} from "../src/lib/auth/direct-entry-v2.ts";
import { canManageTeamLeadersFromActor } from "../src/lib/auth/direct-entry-page-access.ts";
import { guardAiSettingsAdminActor } from "../src/lib/ai-config/server/route-helpers.mjs";
import { keyringFromEnvironment } from "../src/lib/ai-config/crypto-envelope.ts";
import { createProviderConfigStoreCore } from "../src/lib/ai-config/store-core.ts";
import { saveProviderConfig } from "../src/lib/ai-config/settings-service.ts";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = {
  auth: "10000000-0000-4000-8000-000000000101",
  app: "20000000-0000-4000-8000-000000000101",
  email: "nobita6986@gmail.com",
  name: "Canonical Owner",
};
const LUANPT = {
  auth: "10000000-0000-4000-8000-000000000102",
  app: "20000000-0000-4000-8000-000000000102",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const NGATTT = {
  auth: "10000000-0000-4000-8000-000000000103",
  app: "20000000-0000-4000-8000-000000000103",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const LIENVU = {
  auth: "10000000-0000-4000-8000-000000000104",
  app: "20000000-0000-4000-8000-000000000104",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const COLLISION = {
  auth: "10000000-0000-4000-8000-000000000105",
  app: "20000000-0000-4000-8000-000000000105",
  email: "nobita6986@hrpartner.vn",
  name: "Local-Part Collision",
};
const FIFTH_ADMIN = {
  auth: "10000000-0000-4000-8000-000000000106",
  app: "20000000-0000-4000-8000-000000000106",
  recruiter: "30000000-0000-4000-8000-000000000106",
  email: "fifth.admin@hrpartner.vn",
  name: "Fifth Dynamic Admin",
};
const HR_OP = {
  auth: "10000000-0000-4000-8000-000000000107",
  app: "20000000-0000-4000-8000-000000000107",
  email: "hr.op@hrpartner.vn",
  name: "HR Operator Staff",
};
const CROSS_GRANT = {
  auth: "10000000-0000-4000-8000-000000000108",
  app: "20000000-0000-4000-8000-000000000108",
  email: "cross.grant@hrpartner.vn",
  name: "Cross Grant Staff",
};
const DUONGLT_TD = {
  auth: "10000000-0000-4000-8000-000000000109",
  app: "20000000-0000-4000-8000-000000000109",
  email: "duonglt.td@hrpartner.vn",
  name: "DuongLT No Recruiter Link",
};
const HIST_DISABLED = {
  auth: "10000000-0000-4000-8000-000000000110",
  app: "20000000-0000-4000-8000-000000000110",
  email: "hist.disabled@hrpartner.vn",
  name: "Historical Pre-WP5 Disabled",
};
const D10_SUSPENDED_REC = {
  auth: "10000000-0000-4000-8000-000000000116",
  app: "20000000-0000-4000-8000-000000000116",
  recruiter: "30000000-0000-4000-8000-000000000116",
  email: "d10.suspended@hrpartner.vn",
  name: "D10 Suspended Recruiter",
};
const TL_CANDIDATE = {
  auth: "10000000-0000-4000-8000-000000000111",
  app: "20000000-0000-4000-8000-000000000111",
  recruiter: "30000000-0000-4000-8000-000000000111",
  email: "tl.cand@hrpartner.vn",
  name: "TL Candidate Recruiter",
};
const DELEG_GRANTOR = {
  auth: "10000000-0000-4000-8000-000000000112",
  app: "20000000-0000-4000-8000-000000000112",
  email: "deleg.grantor@hrpartner.vn",
  name: "Delegation Grantor",
};
const HAIDX_TD = {
  auth: "10000000-0000-4000-8000-000000000113",
  app: "20000000-0000-4000-8000-000000000113",
  recruiter: "30000000-0000-4000-8000-000000000113",
  email: "haidx.td@hrpartner.vn",
  name: "Hai DX TD",
};
const PERS_TARGET = {
  auth: "10000000-0000-4000-8000-000000000114",
  app: "20000000-0000-4000-8000-000000000114",
  email: "pers.cutover@hrpartner.vn",
  name: "Post Cutover Personnel",
};
const LINK_TARGET = {
  auth: "10000000-0000-4000-8000-000000000115",
  app: "20000000-0000-4000-8000-000000000115",
  recruiter: "30000000-0000-4000-8000-000000000115",
  personnelCode: "link.cutover",
  email: "link.cutover@hrpartner.vn",
  name: "Post Cutover Link Target",
};

const TEAM_ID = "50000000-0000-4000-8000-000000000101";
const PROJECT_ID = "PROJ_WP5B2_01";

let seq = 1;
function uuidSeq() {
  return `92000000-0000-4000-8000-${(seq++).toString(16).padStart(12, "0")}`;
}

function sha256Hex(obj) {
  return createHash("sha256").update(JSON.stringify(obj), "utf8").digest("hex");
}

function assertNoEmailOrAt(value, label) {
  const txt = JSON.stringify(value);
  assert.equal(txt.includes("@"), false, `${label} must not expose '@' or raw email`);
  const stack = [value];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const item of cur) stack.push(item);
    } else if (cur && typeof cur === "object") {
      for (const [k, v] of Object.entries(cur)) {
        assert.equal(/email/i.test(k), false, `${label} must not expose key '${k}'`);
        stack.push(v);
      }
    }
  }
}

async function seedAccount(
  db,
  user,
  {
    enabled = true,
    accountType = "NORMAL",
    caps = [],
    scopes = [],
    teamScopes = [],
    authzManaged = false,
  } = {},
) {
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, account_type, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, $4, $5, $6, 1)`,
    [user.app, user.auth, user.name, accountType, enabled, authzManaged],
  );
  for (const cap of caps) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2020-01-01', true)`,
      [user.app, cap],
    );
  }
  for (const sk of scopes) {
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, $2, null, '2020-01-01', true)`,
      [user.app, sk],
    );
  }
  for (const tid of teamScopes) {
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'team', $2::uuid, '2020-01-01', true)`,
      [user.app, tid],
    );
  }
  if (user.recruiter) {
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
       values ($1::uuid, $2, $3, $4, true, 1)`,
      [user.recruiter, user.name, user.personnelCode ?? null, user.personnelCode ? "STAFF" : null],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2020-01-01', true)`,
      [user.recruiter],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2020-01-01', true)`,
      [user.app, user.recruiter],
    );
  }
}

function buildProbeBriefPayload(projectId, industrialParkId) {
  return {
    project_id: projectId,
    industrial_park_id: industrialParkId,
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
    },
  };
}

function buildValidAiEnvelope(configId, version, profile, url, model) {
  return {
    envelope_version: 2,
    algorithm: "aes-256-gcm",
    key_id: "k1",
    config_id: configId,
    provider_profile: profile,
    config_version: version,
    api_base_url: url,
    model,
    iv: Buffer.alloc(12, 1).toString("base64"),
    ciphertext: Buffer.from("encrypted-fixture-payload").toString("base64"),
    authentication_tag: Buffer.alloc(16, 2).toString("base64"),
    created_at: "2026-11-18T16:00:00.000Z",
  };
}

async function setupDatabase() {
  const db = new PGlite();
  await db.exec(PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(names.includes(WP5B1_ROLE_EFFECTIVE_ACCESS_MIGRATION_NAME));
  assert.ok(names.includes("20261118160000_wp5b2_role_access_cutover.sql"));
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }

  await db.query(
    `insert into public.teams (team_id, code, display_name, active, version)
     values ($1::uuid, 'WP5B2_TEAM_01', 'Team WP5B2 Test', true, 1)`,
    [TEAM_ID],
  );
  await db.query(
    `insert into public.direct_entry_projects (project_id, display_name, active)
     values ($1, 'WP5B2 Probe Project', true)
     on conflict (project_id) do nothing`,
    [PROJECT_ID],
  );
  await db.exec(`
    insert into public.direct_entry_labor_types (labor_type_key, display_name, reporting_key, sort_order, active)
    values ('CHINH_THUC', 'Chính thức', 'chinh_thuc', 10, true)
    on conflict (labor_type_key) do update set active = true;
  `);

  // 4 Initial Admins (exact production migration topology)
  await seedAccount(db, OWNER, {
    caps: ["entry_admin", "recruiter_master_manage", "team_master_manage", "entry_own", "duplicate_cccd_withdraw"],
    scopes: ["all"],
  });
  await seedAccount(db, LUANPT, {
    caps: [],
    scopes: ["all"], // orphan 'all' scope pre-cutover
  });
  await seedAccount(db, NGATTT, {
    caps: ["entry_admin", "recruiter_master_manage", "team_master_manage", "audit_view", "duplicate_cccd_withdraw"],
    scopes: ["all"],
  });
  await seedAccount(db, LIENVU, {
    caps: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    scopes: ["all"],
  });

  // Local-part collision (must never auto-ADMIN or be protected)
  await seedAccount(db, COLLISION, {
    caps: ["entry_own"],
    scopes: ["own"],
  });

  const legacyRecruiterCaps = WP5_ROLE_CATALOG.RECRUITER.capabilities.map((c) => c.capability);

  // 5th staff (recruiter only initially; will receive dynamic ADMIN post-cutover)
  await seedAccount(db, FIFTH_ADMIN, {
    caps: legacyRecruiterCaps,
    scopes: ["own"],
  });

  // HR Operator (full HR_OPERATOR bundle, no entry_admin)
  await seedAccount(db, HR_OP, {
    caps: ["recruiter_master_manage", "team_master_manage", "catalog_master_manage", "audit_view", "document_view"],
    scopes: ["all"],
  });

  // Cross-grant user pre-cutover (`entry_own` + legacy `all` scope, no entry_admin/report_analytics_view/team_master_manage)
  await seedAccount(db, CROSS_GRANT, {
    caps: ["entry_own"],
    scopes: ["all"],
  });

  // EMPLOYEE_BASE-only with 0 recruiter links (matches duonglt.td / .kt behavior)
  await seedAccount(db, DUONGLT_TD, {
    caps: [],
    scopes: [],
  });

  // Pre-WP5 historical disabled account (closed legacy grants, suspended_by_account_disable = false)
  await seedAccount(db, HIST_DISABLED, { enabled: false });
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable)
     values ($1::uuid, 'entry_own', '2020-01-01', '2025-01-01', false, false)`,
    [HIST_DISABLED.app],
  );
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to, is_current, suspended_by_account_disable)
     values ($1::uuid, 'own', '2020-01-01', '2025-01-01', false, false)`,
    [HIST_DISABLED.app],
  );

  // WP5B-1 D10-suspended Recruiter before cutover (suspended_by_account_disable = true; must retain dormant roles & restore 7 grants on post-cutover enable)
  await seedAccount(db, D10_SUSPENDED_REC, {
    caps: legacyRecruiterCaps,
    scopes: ["own"],
  });
  await db.query(
    "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, 1, 'Suspend D10 recruiter before cutover', $4)",
    [OWNER.auth, OWNER.app, D10_SUSPENDED_REC.app, `seed-d10-dis-${seq++}`],
  );

  // Team Leader candidate member
  await seedAccount(db, TL_CANDIDATE, {
    caps: legacyRecruiterCaps,
    scopes: ["own"],
  });
  await db.query(
    `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
     values ($1::uuid, $2::uuid, '2020-01-01', true)`,
    [TL_CANDIDATE.recruiter, TEAM_ID],
  );

  // Work Reports delegation grantor + grantee (haidx.td)
  await seedAccount(db, DELEG_GRANTOR, {
    caps: ["report_form_manage", "report_delegate", "report_assign", "report_review", "report_view"],
    scopes: ["all"],
  });
  await seedAccount(db, HAIDX_TD, {
    caps: legacyRecruiterCaps,
    scopes: ["own"],
  });
  await db.query(
    `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
     values ($1::uuid, $2::uuid, '2020-01-01', true)`,
    [HAIDX_TD.recruiter, TEAM_ID],
  );

  // Personnel create target & link recruiter target
  await seedAccount(db, PERS_TARGET, { caps: [], scopes: [] });
  await seedAccount(db, LINK_TARGET, { caps: [], scopes: [] });
  await db.query(
    "delete from public.direct_entry_app_user_recruiter_links where app_user_id = $1::uuid",
    [LINK_TARGET.app],
  );

  return db;
}

const db = await setupDatabase();

test("1. Pre-cutover upgrade (220->221): cutover_ready=false, legacy allowlist dropped, paired orphan 'all' scope tightened", async () => {
  const { rows: [state] } = await db.query("select cutover_ready from public.authz_system_state");
  assert.equal(state.cutover_ready, false);

  const { rows: [fnCheck] } = await db.query(
    `select pg_catalog.to_regprocedure('public.worker_edit_history_is_allowlisted_admin(uuid,uuid)') as fn`,
  );
  assert.equal(fnCheck.fn, null, "worker_edit_history_is_allowlisted_admin must be dropped by WP5B-2");

  // Pre-cutover orphan 'all' scope on LUANPT must NOT resolve 'all' in Group A reporting!
  const { rows: [{ payload: luanAud }] } = await db.query(
    "select public.direct_entry_reporting_resolve_audience($1::uuid, $2::uuid) as payload",
    [LUANPT.auth, LUANPT.app],
  );
  assert.equal(luanAud.audience, "own", "Orphan 'all' scope without paired cap must resolve 'own' pre-cutover");
  assert.equal(luanAud.recruiter_id, null);

  // Cross-grant pre-cutover (entry_own + legacy 'all' scope, missing entry_admin/report_analytics_view) must NOT get 'all'
  const { rows: [{ payload: crossAud }] } = await db.query(
    "select public.direct_entry_reporting_resolve_audience($1::uuid, $2::uuid) as payload",
    [CROSS_GRANT.auth, CROSS_GRANT.app],
  );
  assert.equal(crossAud.audience, "own", "Unpaired entry_own + all scope must resolve 'own'");

  // DUONGLT_TD (0 caps, 0 links) gets safe own/null pre-cutover
  const { rows: [{ payload: duongAud }] } = await db.query(
    "select public.direct_entry_reporting_resolve_audience($1::uuid, $2::uuid) as payload",
    [DUONGLT_TD.auth, DUONGLT_TD.app],
  );
  assert.deepEqual(duongAud, { audience: "own", label: "Cá nhân", team_ids: [], recruiter_id: null });

  // NGATTT (now paired ADMIN caps + all scope) still gets global 'all' via pre-cutover bridge
  const { rows: [{ payload: ngaAud }] } = await db.query(
    "select public.direct_entry_reporting_resolve_audience($1::uuid, $2::uuid) as payload",
    [NGATTT.auth, NGATTT.app],
  );
  assert.equal(ngaAud.audience, "all");

  // Pre-cutover account creation (cutover_ready=false) preserves legacy compatibility (authz_managed=false, 0 authz roles)
  const { rows: [{ res: preBegan }] } = await db.query(
    "select public.direct_entry_account_operation_begin($1::uuid, $2::uuid, 'CREATE_ACCOUNT', 'pre.cutover', 'Pre Cutover User', null, 'Pre cutover standalone create', $3) as res",
    [OWNER.auth, OWNER.app, `pre-begin-${seq++}`],
  );
  await db.query(
    "select public.direct_entry_account_operation_claim($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
    [OWNER.auth, OWNER.app, preBegan.intent_id, preBegan.intent_token],
  );
  const preAuthSubject = "10000000-0000-4000-8000-000000000190";
  await db.query("insert into auth.users (id, email) values ($1::uuid, 'pre.cutover@hrpartner.vn')", [
    preAuthSubject,
  ]);
  const { rows: [{ res: preFin }] } = await db.query(
    "select public.direct_entry_account_operation_finalize_create($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6) as res",
    [OWNER.auth, OWNER.app, preBegan.intent_id, preBegan.intent_token, preAuthSubject, `pre-fin-${seq++}`],
  );
  assert.equal(preFin.intent_state, "APPLIED");
  const { rows: [preAcct] } = await db.query(
    "select authz_managed, enabled from public.direct_entry_app_users where app_user_id = $1::uuid",
    [preFin.app_user_id],
  );
  assert.equal(preAcct.authz_managed, false, "Pre-cutover finalize_create keeps authz_managed=false");
  const { rows: [{ cnt: preRoleCnt }] } = await db.query(
    "select count(*)::int as cnt from public.authz_account_role_assignments where app_user_id = $1::uuid",
    [preFin.app_user_id],
  );
  assert.equal(preRoleCnt, 0, "Pre-cutover finalize_create assigns 0 authz roles until cutover");
});

let lockedFingerprint = null;

test("2. Cutover CLI library: --read-only-plan, --dry-run rollback, guardrails, --apply, and idempotent noop", async () => {
  const roPlan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.equal(roPlan.status, "READ_ONLY_PLAN_GENERATED");
  assert.equal(roPlan.system_state.cutover_ready, false);
  assert.equal(
    roPlan.action_diff.unexpected_diff_count,
    0,
    JSON.stringify(roPlan.action_diff.rows.filter((r) => r.anomalies.length > 0)),
  );
  lockedFingerprint = roPlan.manifest_fingerprint;
  assert.match(lockedFingerprint, /^[a-f0-9]{64}$/);
  assertNoEmailOrAt(sanitizeCutoverReport(roPlan), "sanitized read-only plan");

  const dryRun = await runWp5Cutover(db, {
    mode: "dry-run",
    expectedFingerprint: lockedFingerprint,
  });
  assert.equal(dryRun.status, "DRY_RUN_VERIFIED");
  assert.equal(dryRun.postconditions.protected_owner_app_user_id, OWNER.app);

  // Confirm --dry-run rolled back cleanly
  const { rows: [stateAfterDry] } = await db.query("select cutover_ready from public.authz_system_state");
  assert.equal(stateAfterDry.cutover_ready, false);
  const { rows: [roleCountAfterDry] } = await db.query(
    "select count(*)::int as cnt from public.authz_account_role_assignments",
  );
  assert.equal(roleCountAfterDry.cnt, 0);

  // Guardrails: missing --confirm-apply & mismatched fingerprint
  await assert.rejects(
    runWp5Cutover(db, { mode: "apply", confirmApply: false, expectedFingerprint: lockedFingerprint }),
    /CUTOVER_APPLY_REQUIRES_CONFIRM/,
  );
  await assert.rejects(
    runWp5Cutover(db, { mode: "apply", confirmApply: true, expectedFingerprint: "0".repeat(64) }),
    /CUTOVER_FINGERPRINT_MISMATCH/,
  );
  const { rows: [stateAfterBadApply] } = await db.query("select cutover_ready from public.authz_system_state");
  assert.equal(stateAfterBadApply.cutover_ready, false);

  // Apply with matching fingerprint
  const applied = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: lockedFingerprint,
  });
  assert.equal(applied.status, "APPLIED");
  assert.equal(applied.system_state.cutover_ready, true);
  assert.equal(applied.postconditions.active_admin_count, 4);

  const { rows: [unmanaged] } = await db.query(
    "select count(*)::int as cnt from public.direct_entry_app_users where authz_managed = false",
  );
  assert.equal(unmanaged.cnt, 0);

  // Immediate re-run returns ALREADY_APPLIED_NOOP
  const noop = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: lockedFingerprint,
  });
  assert.equal(noop.status, "ALREADY_APPLIED_NOOP");
  assertNoEmailOrAt(sanitizeCutoverReport(noop), "sanitized noop");
});

test("3. 4 Initial Admins + 5th dynamic ADMIN share identical 21-cap bundle, zero allowlist, C4 PM excluded", async () => {
  const { rows: [{ industrial_park_id: parkId }] } = await db.query(
    "select industrial_park_id from public.industrial_parks where industrial_park_code = 'VP_BA_THIEN_1' limit 1",
  );
  const briefPayload = buildProbeBriefPayload(PROJECT_ID, parkId);

  for (const admin of [OWNER, LUANPT, NGATTT, LIENVU]) {
    const { rows: [{ payload: ctx }] } = await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
      [admin.auth],
    );
    assertNoEmailOrAt(ctx, `admin_ctx_${admin.name}`);
    assert.equal(ctx.effective_grants.length, WP5_ROLE_CATALOG.ADMIN.capabilities.length);
    assert.equal(hasPairedFullAdmin(ctx), true);
    assert.equal(hasPairedAllReportingAccess(ctx), true);
    assert.equal(canManageTeamLeadersFromActor({ ok: true, actor: ctx }), true);

    // Every initial admin can use worker_edit_history_search & missing docs @ ALL (even luanpt & lienvu!)
    await db.query(
      "select public.worker_edit_history_search($1::uuid, $2::uuid, null, null, '2026-11-01'::date, '2026-11-18'::date) as res",
      [admin.auth, admin.app],
    );
    const { rows: [{ res: missingRes }] } = await db.query(
      "select public.direct_entry_list_missing_document_workers($1::uuid, $2::uuid) as res",
      [admin.auth, admin.app],
    );
    assert.equal(missingRes.scope_kind, "all");
    assert.equal(missingRes.can_upload, true);
  }

  // C4: Initial ADMIN without PM assignment MUST be denied recruitment_post_create (42501)
  await assert.rejects(
    db.query(
      "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4)",
      [NGATTT.auth, NGATTT.app, JSON.stringify(briefPayload), uuidSeq()],
    ),
    (err) => err?.code === "42501",
  );

  // Prior to ADMIN grant, FIFTH_ADMIN cannot access worker_edit_history or global missing docs
  await assert.rejects(
    db.query(
      "select public.worker_edit_history_search($1::uuid, $2::uuid, null, null, '2026-11-01'::date, '2026-11-18'::date)",
      [FIFTH_ADMIN.auth, FIFTH_ADMIN.app],
    ),
    (err) => err?.code === "42501",
  );
  const { rows: [{ res: fifthMissingBefore }] } = await db.query(
    "select public.direct_entry_list_missing_document_workers($1::uuid, $2::uuid) as res",
    [FIFTH_ADMIN.auth, FIFTH_ADMIN.app],
  );
  assert.equal(fifthMissingBefore.scope_kind, "recruited");

  // Grant ADMIN dynamically to FIFTH_ADMIN (not in any hardcode allowlist)
  const { rows: [{ version: fifthVer }] } = await db.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [FIFTH_ADMIN.app],
  );
  const assignIdem = uuidSeq();
  await db.query(
    "select public.direct_entry_authz_assign_global_role_admin($1::uuid, $2::uuid, $3::uuid, 'ADMIN', $4, 'Dynamic 5th ADMIN promotion', $5::uuid, $6)",
    [OWNER.auth, OWNER.app, FIFTH_ADMIN.app, fifthVer, assignIdem, sha256Hex({ t: "5th-admin", v: fifthVer })],
  );

  const { rows: [{ payload: fifthCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [FIFTH_ADMIN.auth],
  );
  const fifthGrantKeys = new Set(fifthCtx.effective_grants.map((g) => `${g.capability}::${g.scope_kind}`));
  for (const cap of WP5_ROLE_CATALOG.ADMIN.capabilities) {
    assert.equal(
      fifthGrantKeys.has(`${cap.capability}::${cap.scope_template}`),
      true,
      `5th ADMIN missing bundle capability ${cap.capability}@${cap.scope_template}`,
    );
  }
  assert.equal(hasPairedFullAdmin(fifthCtx), true);

  await db.query(
    "select public.worker_edit_history_search($1::uuid, $2::uuid, null, null, '2026-11-01'::date, '2026-11-18'::date)",
    [FIFTH_ADMIN.auth, FIFTH_ADMIN.app],
  );
  const { rows: [{ res: fifthMissingAfter }] } = await db.query(
    "select public.direct_entry_list_missing_document_workers($1::uuid, $2::uuid) as res",
    [FIFTH_ADMIN.auth, FIFTH_ADMIN.app],
  );
  assert.equal(fifthMissingAfter.scope_kind, "all");
  assert.equal(fifthMissingAfter.can_upload, true);

  // 5th ADMIN without PM assignment MUST still be denied recruitment_post_create
  await assert.rejects(
    db.query(
      "select public.recruitment_post_create($1::uuid, $2::uuid, $3::jsonb, $4)",
      [FIFTH_ADMIN.auth, FIFTH_ADMIN.app, JSON.stringify(briefPayload), uuidSeq()],
    ),
    (err) => err?.code === "42501",
  );
});

test("4. Revoke ADMIN cleanly removes bundle; Owner ADMIN protected; collision account isolated", async () => {
  // Revoke ADMIN from FIFTH_ADMIN -> loses worker_edit_history & AI admin, keeps EMPLOYEE_BASE + RECRUITER
  const { rows: [fifthAdminRow] } = await db.query(
    `select a.assignment_id, u.version
       from public.authz_account_role_assignments a
       join public.direct_entry_app_users u on u.app_user_id = a.app_user_id
      where a.app_user_id = $1::uuid and a.role_code = 'ADMIN' and a.ended_at is null`,
    [FIFTH_ADMIN.app],
  );
  await db.query(
    "select public.direct_entry_authz_revoke_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'Revoke 5th ADMIN after verification', $6::uuid, $7)",
    [
      OWNER.auth,
      OWNER.app,
      FIFTH_ADMIN.app,
      fifthAdminRow.assignment_id,
      fifthAdminRow.version,
      uuidSeq(),
      sha256Hex({ revoke: "5th-admin" }),
    ],
  );

  const { rows: [{ payload: fifthAfterRevoke }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [FIFTH_ADMIN.auth],
  );
  assert.equal(hasPairedFullAdmin(fifthAfterRevoke), false);
  assert.equal(
    fifthAfterRevoke.effective_grants.some((g) => g.capability === "entry_admin"),
    false,
    "Revoking ADMIN must clear entry_admin without legacy re-grant",
  );
  assert.equal(
    fifthAfterRevoke.effective_grants.some((g) => g.capability === "entry_create" && g.scope_kind === "OWN"),
    true,
    "Revoking ADMIN must preserve RECRUITER own capabilities",
  );
  await assert.rejects(
    db.query(
      "select public.worker_edit_history_search($1::uuid, $2::uuid, null, null, '2026-11-01'::date, '2026-11-18'::date)",
      [FIFTH_ADMIN.auth, FIFTH_ADMIN.app],
    ),
    (err) => err?.code === "42501",
  );

  // Attempt to revoke Canonical Owner ADMIN must fail with PT409 AUTHZ_PROTECTED_ASSIGNMENT & 0 version bump
  const { rows: [ownerAssign] } = await db.query(
    `select a.assignment_id, a.is_protected, u.version
       from public.authz_account_role_assignments a
       join public.direct_entry_app_users u on u.app_user_id = a.app_user_id
      where a.app_user_id = $1::uuid and a.role_code = 'ADMIN' and a.ended_at is null`,
    [OWNER.app],
  );
  assert.equal(ownerAssign.is_protected, true);
  await assert.rejects(
    db.query(
      "select public.direct_entry_authz_revoke_global_role_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'Attempt illegal owner revoke', $6::uuid, $7)",
      [
        NGATTT.auth,
        NGATTT.app,
        OWNER.app,
        ownerAssign.assignment_id,
        ownerAssign.version,
        uuidSeq(),
        sha256Hex({ illegal: "owner-revoke" }),
      ],
    ),
    (err) => err?.code === "PT409" && err.message.includes("AUTHZ_PROTECTED_ASSIGNMENT"),
  );
  const { rows: [{ version: ownerVerAfter }] } = await db.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [OWNER.app],
  );
  assert.equal(ownerVerAfter, ownerAssign.version, "Failed protected revoke must not bump Owner version");

  // Local-part collision nobita6986@hrpartner.vn only has EMPLOYEE_BASE (not ADMIN, not protected)
  const { rows: collisionRoles } = await db.query(
    `select role_code, is_protected
       from public.authz_account_role_assignments
      where app_user_id = $1::uuid and ended_at is null
      order by role_code`,
    [COLLISION.app],
  );
  assert.deepEqual(collisionRoles, [{ role_code: "EMPLOYEE_BASE", is_protected: false }]);
});

test("5. Owner disable/re-enable + pre-WP5 disabled non-resurrection + idempotent cutover noop post-mutation", async () => {
  // Disable NGATTT, verify ALREADY_APPLIED_NOOP still succeeds even when an initial admin is disabled!
  const { rows: [{ version: ngaVer }] } = await db.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [NGATTT.app],
  );
  await db.query(
    "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Test disable ngattt post-cutover', $5)",
    [OWNER.auth, OWNER.app, NGATTT.app, ngaVer, `dis-nga-${seq++}`],
  );
  const postDisableNoop = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: lockedFingerprint,
  });
  assert.equal(postDisableNoop.status, "ALREADY_APPLIED_NOOP");

  // Re-enable NGATTT so NGATTT can disable OWNER cleanly
  await db.query(
    "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Re-enable ngattt', $5)",
    [OWNER.auth, OWNER.app, NGATTT.app, ngaVer + 1, `en-nga-${seq++}`],
  );

  // Designate TL_CANDIDATE then revoke before disabling Owner? Even better: designate NGATTT on a team then revoke TL later -> verify Owner disable/enable!
  const { rows: [{ version: ownerVer }] } = await db.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [OWNER.app],
  );
  await db.query(
    "select public.direct_entry_disable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Disable canonical Owner test', $5)",
    [NGATTT.auth, NGATTT.app, OWNER.app, ownerVer, `dis-owner-${seq++}`],
  );

  const { rows: [{ payload: disabledOwnerCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [OWNER.auth],
  );
  assert.deepEqual(disabledOwnerCtx.effective_grants, []);

  await assert.rejects(
    db.query("select public.direct_entry_reporting_resolve_audience($1::uuid, $2::uuid)", [OWNER.auth, OWNER.app]),
    (err) => err?.code === "42501" && err.message.includes("reporting actor unavailable"),
  );

  const validEnv = buildValidAiEnvelope("pilot", 1, "openai", "https://api.openai.com/v1", "gpt-4o-mini");
  const { rows: [{ res: disabledOwnerAi }] } = await db.query(
    "select public.ai_provider_config_save('pilot', null, 'openai', 'https://api.openai.com/v1', 'api.openai.com', 'gpt-4o-mini', $1::jsonb, $2, $3, 'config_created') as res",
    [JSON.stringify(validEnv), "a".repeat(16), OWNER.app],
  );
  assert.equal(disabledOwnerAi.ok, false);
  assert.equal(disabledOwnerAi.code, "AI_FORBIDDEN");

  // Re-enable Owner -> restores 21 ADMIN grants
  await db.query(
    "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Re-enable canonical Owner', $5)",
    [NGATTT.auth, NGATTT.app, OWNER.app, ownerVer + 1, `en-owner-${seq++}`],
  );
  const { rows: [{ payload: enabledOwnerCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [OWNER.auth],
  );
  assert.equal(enabledOwnerCtx.effective_grants.length, 21);

  // Re-enable pre-WP5 disabled historical account -> 0 effective grants, 0 resurrected legacy rows
  const { rows: [{ version: histVer }] } = await db.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [HIST_DISABLED.app],
  );
  await db.query(
    "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Re-enable pre-WP5 disabled', $5)",
    [OWNER.auth, OWNER.app, HIST_DISABLED.app, histVer, `en-hist-${seq++}`],
  );
  const { rows: [{ payload: histCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [HIST_DISABLED.auth],
  );
  assert.deepEqual(histCtx.effective_grants, []);
  const { rows: [histLegacy] } = await db.query(
    "select count(*)::int as cnt from public.direct_entry_capability_grants where app_user_id = $1::uuid and is_current = true and valid_to is null",
    [HIST_DISABLED.app],
  );
  assert.equal(histLegacy.cnt, 0);

  // Re-enable WP5B-1 D10-suspended Recruiter post-cutover -> restores EMPLOYEE_BASE + RECRUITER + active recruiter link + all 7 OWN grants
  const { rows: [d10PreEnable] } = await db.query(
    "select version, authz_managed, enabled from public.direct_entry_app_users where app_user_id = $1::uuid",
    [D10_SUSPENDED_REC.app],
  );
  assert.equal(d10PreEnable.enabled, false);
  assert.equal(d10PreEnable.authz_managed, true);
  await db.query(
    "select public.direct_entry_enable_app_user($1::uuid, $2::uuid, $3::uuid, $4, 'Re-enable D10 suspended recruiter', $5)",
    [OWNER.auth, OWNER.app, D10_SUSPENDED_REC.app, d10PreEnable.version, `en-d10-${seq++}`],
  );
  const { rows: [{ payload: d10Ctx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [D10_SUSPENDED_REC.auth],
  );
  assert.equal(d10Ctx.effective_grants.length, 7);
  assert.equal(
    d10Ctx.effective_grants.every((g) => g.scope_kind === "OWN" && g.source_type === "ROLE_BUNDLE"),
    true,
  );
  const { rows: [d10Link] } = await db.query(
    "select is_current, suspended_by_account_disable from public.direct_entry_app_user_recruiter_links where app_user_id = $1::uuid",
    [D10_SUSPENDED_REC.app],
  );
  assert.deepEqual(d10Link, { is_current: true, suspended_by_account_disable: false });
});

test("6. Cross-grant attack blocked, HR_OPERATOR manages TL cleanly, EMPLOYEE_BASE-only gets empty 'own'", async () => {
  // CROSS_GRANT only has BACKFILL_EXCEPTION entry_own @ OWN -> add EXCEPTION_GRANT catalog_master_manage @ ALL via direct table test
  await db.query(
    `insert into public.authz_direct_capability_grants (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
     values ($1::uuid, 'catalog_master_manage', 'ALL', null, 'EXCEPTION_GRANT', 'Cross-grant simulation', $2::uuid)`,
    [CROSS_GRANT.app, OWNER.app],
  );
  const { rows: [{ payload: crossCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [CROSS_GRANT.auth],
  );
  assert.equal(hasPairedAllReportingAccess(crossCtx), false);
  assert.equal(hasPairedFullAdmin(crossCtx), false);
  assert.equal(canManageTeamLeadersFromActor({ ok: true, actor: crossCtx }), false);

  const { rows: [{ payload: crossAud }] } = await db.query(
    "select public.direct_entry_reporting_resolve_audience($1::uuid, $2::uuid) as payload",
    [CROSS_GRANT.auth, CROSS_GRANT.app],
  );
  assert.equal(crossAud.audience, "own");

  await assert.rejects(
    db.query("select public.worker_edit_history_search($1::uuid, $2::uuid, null, null, '2026-11-01'::date, '2026-11-18'::date)", [CROSS_GRANT.auth, CROSS_GRANT.app]),
    (err) => err?.code === "42501",
  );
  await assert.rejects(
    db.query(
      "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, public.direct_entry_authorization_date(), 1, 'Cross grant TL blocked', $5)",
      [CROSS_GRANT.auth, CROSS_GRANT.app, TEAM_ID, TL_CANDIDATE.app, `cross-tl-${seq++}`],
    ),
    (err) => err?.code === "42501",
  );

  // HR_OPERATOR (team_master_manage @ ALL, no entry_admin) CAN manage Team Leaders!
  const { rows: [{ payload: hrCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [HR_OP.auth],
  );
  assert.equal(hasPairedFullAdmin(hrCtx), false);
  assert.equal(canManageTeamLeadersFromActor({ ok: true, actor: hrCtx }), true);

  const { rows: [{ version: teamVer }] } = await db.query(
    "select version from public.teams where team_id = $1::uuid",
    [TEAM_ID],
  );
  await db.query(
    "select public.direct_entry_designate_team_leader($1::uuid, $2::uuid, $3::uuid, $4::uuid, public.direct_entry_authorization_date(), $5, 'HR_OPERATOR designate TL', $6)",
    [HR_OP.auth, HR_OP.app, TEAM_ID, TL_CANDIDATE.app, teamVer, `hr-tl-des-${seq++}`],
  );
  const { rows: [{ payload: tlAfterDesig }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [TL_CANDIDATE.auth],
  );
  assert.equal(
    tlAfterDesig.assigned_roles.some((r) => r.role_code === "TEAM_LEADER" && r.scope_id === TEAM_ID),
    true,
  );

  await db.query(
    "select public.direct_entry_revoke_team_leader($1::uuid, $2::uuid, $3::uuid, public.direct_entry_authorization_date(), $4, 'HR_OPERATOR revoke TL', $5)",
    [HR_OP.auth, HR_OP.app, TEAM_ID, teamVer + 1, `hr-tl-rev-${seq++}`],
  );
  const { rows: [{ payload: tlAfterRev }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [TL_CANDIDATE.auth],
  );
  assert.equal(
    tlAfterRev.assigned_roles.some((r) => r.role_code === "TEAM_LEADER" && r.scope_id === TEAM_ID),
    false,
  );

  // EMPLOYEE_BASE-only (duonglt.td) -> empty 'own' reporting
  const { rows: [{ payload: duongAud }] } = await db.query(
    "select public.direct_entry_reporting_resolve_audience($1::uuid, $2::uuid) as payload",
    [DUONGLT_TD.auth, DUONGLT_TD.app],
  );
  assert.deepEqual(duongAud, { audience: "own", label: "Cá nhân", team_ids: [], recruiter_id: null });
});

test("7. R3 Work Reports delegation: template-scoped (T1 allowed, T2 denied), 0 blanket grants in effective_grants", async () => {
  const schema = RECRUITMENT_DAILY_TEMPLATE_SCHEMA;
  const metrics = buildWorkReportMetricContract(schema);

  const createPublishedTemplate = async (code) => {
    const { rows: [{ res: created }] } = await db.query(
      `select public.work_report_create_template(
         $1::uuid, $2::uuid, $3::text, $3::text, null, 'DAILY', $4::jsonb, $5::jsonb, $6
       ) as res`,
      [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, code, JSON.stringify(schema), JSON.stringify(metrics), `tpl-${seq++}`],
    );
    await db.query(
      "update public.work_report_template_versions set requires_review = true where version_id = $1::uuid",
      [created.draft_version_id],
    );
    await db.query(
      "select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)",
      [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, created.template_id, created.draft_version_id, created.version, `pub-${seq++}`],
    );
    return created.template_id;
  };

  const t1Id = await createPublishedTemplate("WP5B2_TPL_T1");
  const t2Id = await createPublishedTemplate("WP5B2_TPL_T2");

  // Assign both T1 & T2 to TL_CANDIDATE for today and submit PENDING_REVIEW on each
  const { rows: [{ auth_date: today }] } = await db.query("select public.direct_entry_authorization_date()::text as auth_date");
  for (const tid of [t1Id, t2Id]) {
    await db.query(
      `select public.work_report_create_assignment(
         $1::uuid, $2::uuid, $3::uuid, 'USER', $4::uuid, null::uuid, null::uuid[],
         'DAILY', true, 0, '23:59:59'::time, false, $5::date, null::date, $6
       )`,
      [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, tid, TL_CANDIDATE.app, today, `asg-${seq++}`],
    );
  }
  await db.query(
    "select public.work_report_ensure_obligations_for_window($1::uuid, $2::uuid, $3::date)",
    [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, today],
  );
  const { rows: obRows } = await db.query(
    "select obligation_id, template_id from public.work_report_obligations where assignee_app_user_id = $1::uuid order by created_at",
    [TL_CANDIDATE.app],
  );
  assert.equal(obRows.length, 2);
  for (const ob of obRows) {
    await db.query(
      "select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null::integer, $5)",
      [
        TL_CANDIDATE.auth,
        TL_CANDIDATE.app,
        ob.obligation_id,
        JSON.stringify({ calls_made: 5, interested_candidates: 2, workers_started: 1, notes: null }),
        `sub-${seq++}`,
      ],
    );
  }

  // Create template-scoped delegation ONLY for T1 on HAIDX_TD
  await db.query(
    `select public.work_report_create_delegation(
       $1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'all', null::uuid,
       null::timestamptz, null::timestamptz, $5
     )`,
    [DELEG_GRANTOR.auth, DELEG_GRANTOR.app, HAIDX_TD.app, t1Id, `del-${seq++}`],
  );

  // 0 blanket report_review / report_assign rows anywhere for haidx.td
  const { rows: [{ payload: haidxCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [HAIDX_TD.auth],
  );
  assert.equal(
    haidxCtx.effective_grants.some((g) => g.capability === "report_review" || g.capability === "report_assign"),
    false,
    "R3: effective_grants must not contain blanket report_review/report_assign from delegation",
  );
  const { rows: [legacyAllCount] } = await db.query(
    "select count(*)::int as cnt from public.direct_entry_scope_grants where app_user_id = $1::uuid and scope_kind = 'all' and is_current = true",
    [HAIDX_TD.app],
  );
  assert.equal(legacyAllCount.cnt, 0);

  // SQL resolver authorizes T1 and denies T2
  const { rows: authT1 } = await db.query(
    "select * from public.work_report__internal_resolve_capability_authority($1::uuid, 'report_review', $2::uuid, null::uuid, statement_timestamp())",
    [HAIDX_TD.app, t1Id],
  );
  assert.equal(authT1.length, 1);
  assert.equal(authT1[0].acting_scope_kind, "all");

  const { rows: authT2 } = await db.query(
    "select * from public.work_report__internal_resolve_capability_authority($1::uuid, 'report_review', $2::uuid, null::uuid, statement_timestamp())",
    [HAIDX_TD.app, t2Id],
  );
  assert.equal(authT2.length, 0);

  // Pending reviews query returns ONLY T1 item, excluding T2
  const { rows: [{ res: pendingAll }] } = await db.query(
    "select public.work_report_list_pending_reviews($1::uuid, $2::uuid, null::uuid, null, 50) as res",
    [HAIDX_TD.auth, HAIDX_TD.app],
  );
  assert.deepEqual(
    pendingAll.items.map((i) => i.template_id),
    [t1Id],
    "R3: delegated reviewer only sees pending reviews for delegated template T1, never T2",
  );
});

test("8. AI Settings OD-WP5-04: 5 RPCs & TS guards enforce UUID Full Admin and reject 'pilot-admin'/HR_OP/collision", async () => {
  const envV1 = buildValidAiEnvelope("pilot", 1, "openai", "https://api.openai.com/v1", "gpt-4o-mini");

  // Save as Full Admin OWNER UUID
  const { rows: [{ res: saved }] } = await db.query(
    "select public.ai_provider_config_save('pilot', null, 'openai', 'https://api.openai.com/v1', 'api.openai.com', 'gpt-4o-mini', $1::jsonb, $2, $3, 'config_created') as res",
    [JSON.stringify(envV1), "b".repeat(16), OWNER.app],
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.config.version, 1);

  const { rows: [cfgRow] } = await db.query(
    "select created_by_ref, updated_by_ref from public.ai_provider_configs where config_id = 'pilot' and version = 1",
  );
  assert.equal(cfgRow.created_by_ref, OWNER.app);
  assert.equal(cfgRow.updated_by_ref, OWNER.app);

  // Negative checks across all 5 mutating AI RPCs
  const invalidActors = ["pilot-admin", HR_OP.app, COLLISION.app];
  for (const badActor of invalidActors) {
    const { rows: [{ res: rSave }] } = await db.query(
      "select public.ai_provider_config_save('pilot', 1, 'openai', 'https://api.openai.com/v1', 'api.openai.com', 'gpt-4o-mini', $1::jsonb, $2, $3, 'credential_rotated') as res",
      [JSON.stringify(buildValidAiEnvelope("pilot", 2, "openai", "https://api.openai.com/v1", "gpt-4o-mini")), "c".repeat(16), badActor],
    );
    assert.deepEqual({ ok: rSave.ok, code: rSave.code }, { ok: false, code: "AI_FORBIDDEN" });

    const { rows: [{ res: rTest }] } = await db.query(
      "select public.ai_provider_config_test_result('pilot', 1, true, 'ok', $1) as res",
      [badActor],
    );
    assert.deepEqual({ ok: rTest.ok, code: rTest.code }, { ok: false, code: "AI_FORBIDDEN" });

    const { rows: [{ res: rAct }] } = await db.query(
      "select public.ai_provider_config_activate('pilot', 1, $1) as res",
      [badActor],
    );
    assert.deepEqual({ ok: rAct.ok, code: rAct.code }, { ok: false, code: "AI_FORBIDDEN" });

    const { rows: [{ res: rDis }] } = await db.query(
      "select public.ai_provider_config_disable('pilot', 1, $1) as res",
      [badActor],
    );
    assert.deepEqual({ ok: rDis.ok, code: rDis.code }, { ok: false, code: "AI_FORBIDDEN" });

    const { rows: [{ res: rRej }] } = await db.query(
      "select public.ai_provider_config_rejected('pilot', 1, $1, 'bad_input') as res",
      [badActor],
    );
    assert.deepEqual({ ok: rRej.ok, code: rRej.code }, { ok: false, code: "AI_FORBIDDEN" });
  }

  // Happy lifecycle under valid Full Admin UUID (NGATTT)
  const { rows: [{ res: testOk }] } = await db.query(
    "select public.ai_provider_config_test_result('pilot', 1, true, 'ok', $1) as res",
    [NGATTT.app],
  );
  assert.equal(testOk.ok, true);
  assert.equal(testOk.config.status, "verified");

  const { rows: [{ res: actOk }] } = await db.query(
    "select public.ai_provider_config_activate('pilot', 1, $1) as res",
    [NGATTT.app],
  );
  assert.equal(actOk.ok, true);
  assert.equal(actOk.config.status, "active");

  const { rows: [{ res: disOk }] } = await db.query(
    "select public.ai_provider_config_disable('pilot', 1, $1) as res",
    [OWNER.app],
  );
  assert.equal(disOk.ok, true);
  assert.equal(disOk.config.status, "disabled");

  // TypeScript route-helpers + store-core + settings-service parity with SQL
  const { rows: [{ payload: hrCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [HR_OP.auth],
  );
  const guardHr = guardAiSettingsAdminActor(hrCtx);
  assert.equal(guardHr.ok, false);
  assert.equal(guardHr.response.status, 403);
  assert.equal((await guardHr.response.json()).code, "AI_FORBIDDEN");

  const guardNonUuid = guardAiSettingsAdminActor({ app_user_id: "pilot-admin", effective_grants: [] });
  assert.equal(guardNonUuid.ok, false);
  assert.equal(guardNonUuid.response.status, 403);

  const { rows: [{ payload: ownerCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [OWNER.auth],
  );
  const guardOwner = guardAiSettingsAdminActor(ownerCtx);
  assert.deepEqual(guardOwner, { ok: true, actor_ref: OWNER.app });

  const keyring = keyringFromEnvironment({
    AI_SETTINGS_ENABLED: "true",
    AI_CONFIG_ACTIVE_KEY_ID: "k1",
    AI_CONFIG_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  const pgliteStore = createProviderConfigStoreCore({
    config_id: "pilot-provider",
    keyring: () => ({ ok: true, keyring }),
    rpc: async (name, params) => {
      if (name === "ai_provider_config_current") {
        const { rows: [{ res }] } = await db.query(
          "select public.ai_provider_config_current($1) as res",
          [params.p_config_id],
        );
        return { data: res, error: null };
      }
      if (name === "ai_provider_config_version") {
        const { rows: [{ res }] } = await db.query(
          "select public.ai_provider_config_version($1, $2) as res",
          [params.p_config_id, params.p_version],
        );
        return { data: res, error: null };
      }
      if (name === "ai_provider_config_save") {
        const { rows: [{ res }] } = await db.query(
          "select public.ai_provider_config_save($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) as res",
          [
            params.p_config_id,
            params.p_expected_version,
            params.p_provider_profile,
            params.p_api_base_url,
            params.p_sanitized_host,
            params.p_model,
            JSON.stringify(params.p_envelope),
            params.p_key_fingerprint,
            params.p_actor_ref,
            params.p_action,
          ],
        );
        return { data: res, error: null };
      }
      throw new Error(`Unexpected RPC in cutover test: ${name}`);
    },
  });
  const tsSaveRejected = await saveProviderConfig({
    store: pgliteStore,
    keyring,
    url_policy: { environment: "production", nodeEnv: "production", allowedHosts: ["api.openai.com"] },
    actor: HR_OP.app,
    body: {
      provider_profile: "openai-compatible",
      api_url: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      api_key: "sk-wp5b2-synthetic-key-value",
      expected_version: null,
    },
  });
  assert.equal(tsSaveRejected.ok, false);
  assert.equal(tsSaveRejected.code, "AI_FORBIDDEN");

  const tsSavePilotRejected = await saveProviderConfig({
    store: pgliteStore,
    keyring,
    url_policy: { environment: "production", nodeEnv: "production", allowedHosts: ["api.openai.com"] },
    actor: "pilot-admin",
    body: {
      provider_profile: "openai-compatible",
      api_url: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      api_key: "sk-wp5b2-synthetic-key-value",
      expected_version: null,
    },
  });
  assert.equal(tsSavePilotRejected.ok, false);
  assert.equal(tsSavePilotRejected.code, "AI_FORBIDDEN");

  const tsSaveOwnerOk = await saveProviderConfig({
    store: pgliteStore,
    keyring,
    url_policy: { environment: "production", nodeEnv: "production", allowedHosts: ["api.openai.com"] },
    actor: OWNER.app,
    body: {
      provider_profile: "openai-compatible",
      api_url: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      api_key: "sk-wp5b2-synthetic-key-value",
      expected_version: null,
    },
  });
  assert.equal(tsSaveOwnerOk.ok, true);
  assert.equal(tsSaveOwnerOk.config.version, 1);

  const flagSrc = await readFile(path.resolve("src/lib/ai-config/settings-flag.ts"), "utf8");
  const settingsSrc = await readFile(path.resolve("src/lib/ai-config/server/settings.mjs"), "utf8");
  assert.equal(flagSrc.includes("PILOT_ACTOR_REF"), false);
  assert.equal(settingsSrc.includes("PILOT_ACTOR_REF"), false);
  assert.equal(settingsSrc.includes("ACTOR_UUID_RE") && settingsSrc.includes("AI_FORBIDDEN"), true);
});

test("9. Post-cutover create_personnel & link_recruiter set authz_managed=true + EMPLOYEE_BASE + RECRUITER and preserve invariants", async () => {
  await db.query(
    "select public.direct_entry_account_operation_create_personnel($1::uuid, $2::uuid, $3::uuid, 1, 'pers.cutover', 'STAFF', null, 'Post cutover create_personnel', $4)",
    [OWNER.auth, OWNER.app, PERS_TARGET.app, `create-pers-${seq++}`],
  );
  await db.query(
    "select public.direct_entry_account_operation_link_recruiter($1::uuid, $2::uuid, $3::uuid, 1, $4::uuid, 1, 'Post cutover link_recruiter', $5)",
    [OWNER.auth, OWNER.app, LINK_TARGET.recruiter, LINK_TARGET.app, `link-rec-${seq++}`],
  );

  // Brand-new post-cutover account created after cutover gets BOTH EMPLOYEE_BASE & RECRUITER with PERSONNEL_LINK_AUTO + authz_managed=true
  const FRESH_POST = {
    auth: "10000000-0000-4000-8000-000000000199",
    app: "20000000-0000-4000-8000-000000000199",
    email: "fresh.post@hrpartner.vn",
    name: "Fresh Post Cutover User",
  };
  await seedAccount(db, FRESH_POST, { authzManaged: false });
  await db.query(
    "select public.direct_entry_account_operation_create_personnel($1::uuid, $2::uuid, $3::uuid, 1, 'fresh.post', 'STAFF', null, 'Fresh post cutover personnel', $4)",
    [OWNER.auth, OWNER.app, FRESH_POST.app, `create-pers-fresh-${seq++}`],
  );

  for (const target of [PERS_TARGET, LINK_TARGET, FRESH_POST]) {
    const { rows: [userRow] } = await db.query(
      "select authz_managed from public.direct_entry_app_users where app_user_id = $1::uuid",
      [target.app],
    );
    assert.equal(userRow.authz_managed, true, `${target.email} must have authz_managed = true`);

    const { rows: roles } = await db.query(
      `select role_code, source_kind
         from public.authz_account_role_assignments
        where app_user_id = $1::uuid and ended_at is null
        order by role_code asc`,
      [target.app],
    );
    assert.deepEqual(
      roles.map((r) => r.role_code),
      ["EMPLOYEE_BASE", "RECRUITER"],
      `${target.email} must have EMPLOYEE_BASE + RECRUITER`,
    );
    if (target.app === FRESH_POST.app) {
      assert.deepEqual(roles, [
        { role_code: "EMPLOYEE_BASE", source_kind: "PERSONNEL_LINK_AUTO" },
        { role_code: "RECRUITER", source_kind: "PERSONNEL_LINK_AUTO" },
      ]);
    }
  }

  const finalCheck = await verifyPostCutoverInvariants(db, null);
  assert.equal(finalCheck.protected_owner_app_user_id, OWNER.app);

  // Confirm readCutoverInventory works cleanly post-cutover too
  const inv = await readCutoverInventory(db);
  assert.ok(inv.accounts.length >= 14);
});

test("10. Post-cutover finalize_create: standalone begin->claim->finalize, idempotency replay, INDETERMINATE reconcile, and cutover noop", async () => {
  // 1) Standalone CREATE_ACCOUNT flow: begin -> claim -> Auth user -> finalize_create
  const { rows: [{ res: postBegan }] } = await db.query(
    "select public.direct_entry_account_operation_begin($1::uuid, $2::uuid, 'CREATE_ACCOUNT', 'post.standalone', 'Post Standalone Staff', null, 'Post cutover standalone account create', $3) as res",
    [OWNER.auth, OWNER.app, `post-begin-${seq++}`],
  );
  const { rows: [{ res: postClaimed }] } = await db.query(
    "select public.direct_entry_account_operation_claim($1::uuid, $2::uuid, $3::uuid, $4::uuid) as res",
    [OWNER.auth, OWNER.app, postBegan.intent_id, postBegan.intent_token],
  );
  assert.equal(postClaimed.claimed, true);

  const postAuthSubject = "10000000-0000-4000-8000-000000000191";
  await db.query("insert into auth.users (id, email) values ($1::uuid, 'post.standalone@hrpartner.vn')", [
    postAuthSubject,
  ]);
  const finalizeIdemKey = `post-fin-${seq++}`;
  const { rows: [{ res: finRes }] } = await db.query(
    "select public.direct_entry_account_operation_finalize_create($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6) as res",
    [OWNER.auth, OWNER.app, postBegan.intent_id, postBegan.intent_token, postAuthSubject, finalizeIdemKey],
  );
  assert.equal(finRes.intent_state, "APPLIED");
  assert.equal(finRes.version, 1);

  const { rows: [createdAcct] } = await db.query(
    "select enabled, account_type, authz_managed, version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [finRes.app_user_id],
  );
  assert.deepEqual(createdAcct, {
    enabled: true,
    account_type: "NORMAL",
    authz_managed: true,
    version: 1,
  });

  const { rows: openPersonLinks } = await db.query(
    "select count(*)::int as cnt from public.organization_account_person_links where app_user_id = $1::uuid and ended_at is null",
    [finRes.app_user_id],
  );
  assert.equal(openPersonLinks[0].cnt, 0, "finalize_create must not auto-create Person links");

  const { rows: baseRoles } = await db.query(
    `select role_code, source_kind, is_protected
       from public.authz_account_role_assignments
      where app_user_id = $1::uuid and ended_at is null`,
    [finRes.app_user_id],
  );
  assert.deepEqual(baseRoles, [
    { role_code: "EMPLOYEE_BASE", source_kind: "ADMIN_ASSIGNMENT", is_protected: false },
  ]);

  const { rows: [capCount] } = await db.query(
    "select count(*)::int as cnt from public.direct_entry_capability_grants where app_user_id = $1::uuid and is_current = true",
    [finRes.app_user_id],
  );
  const { rows: [scopeCount] } = await db.query(
    "select count(*)::int as cnt from public.direct_entry_scope_grants where app_user_id = $1::uuid and is_current = true",
    [finRes.app_user_id],
  );
  assert.equal(capCount.cnt, 0);
  assert.equal(scopeCount.cnt, 0);

  const { rows: [{ payload: standaloneCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [postAuthSubject],
  );
  assertNoEmailOrAt(standaloneCtx, "standalone_post_cutover_ctx");
  assert.deepEqual(standaloneCtx.effective_grants, []);

  const { rows: [{ payload: standaloneAud }] } = await db.query(
    "select public.direct_entry_reporting_resolve_audience($1::uuid, $2::uuid) as payload",
    [postAuthSubject, finRes.app_user_id],
  );
  assert.deepEqual(standaloneAud, { audience: "own", label: "Cá nhân", team_ids: [], recruiter_id: null });

  // 2) Same-key idempotency replay -> identical payload & zero duplicate roles/audits
  const { rows: [{ res: finReplay }] } = await db.query(
    "select public.direct_entry_account_operation_finalize_create($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6) as res",
    [OWNER.auth, OWNER.app, postBegan.intent_id, postBegan.intent_token, postAuthSubject, finalizeIdemKey],
  );
  assert.deepEqual(finReplay, finRes);
  const { rows: [{ cnt: baseAuditCnt }] } = await db.query(
    `select count(*)::int as cnt
       from public.authz_audit_events
      where target_app_user_id = $1::uuid and operation_name = 'AUTHZ_ACCOUNT_CREATE_BASE_ROLE'`,
    [finRes.app_user_id],
  );
  assert.equal(baseAuditCnt, 1);

  // 3) INDETERMINATE reconcile path -> same finalize_create writer & terminal idempotency guard
  const { rows: [{ res: recBegan }] } = await db.query(
    "select public.direct_entry_account_operation_begin($1::uuid, $2::uuid, 'CREATE_ACCOUNT', 'post.reconcile', 'Post Reconcile Staff', null, 'Reconcile unknown auth outcome', $3) as res",
    [OWNER.auth, OWNER.app, `rec-begin-${seq++}`],
  );
  await db.query(
    "select public.direct_entry_account_operation_claim($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
    [OWNER.auth, OWNER.app, recBegan.intent_id, recBegan.intent_token],
  );
  await db.query(
    "select public.direct_entry_account_operation_finish($1::uuid, $2::uuid, $3::uuid, 'INDETERMINATE', 'auth_unknown')",
    [OWNER.auth, OWNER.app, recBegan.intent_id],
  );
  const recAuthSubject = "10000000-0000-4000-8000-000000000192";
  await db.query("insert into auth.users (id, email) values ($1::uuid, 'post.reconcile@hrpartner.vn')", [
    recAuthSubject,
  ]);
  const { rows: [{ res: recFin }] } = await db.query(
    "select public.direct_entry_account_operation_finalize_create($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6) as res",
    [OWNER.auth, OWNER.app, recBegan.intent_id, recBegan.intent_token, recAuthSubject, `rec-fin-${seq++}`],
  );
  assert.equal(recFin.intent_state, "APPLIED");
  const { rows: [recAcct] } = await db.query(
    "select authz_managed, version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [recFin.app_user_id],
  );
  assert.deepEqual(recAcct, { authz_managed: true, version: 1 });
  const { rows: recRoles } = await db.query(
    "select role_code from public.authz_account_role_assignments where app_user_id = $1::uuid and ended_at is null",
    [recFin.app_user_id],
  );
  assert.deepEqual(recRoles, [{ role_code: "EMPLOYEE_BASE" }]);

  // Terminal-state reconcile retry with a new idempotency key stays immutable and clean
  const { rows: [{ res: recTerminalReplay }] } = await db.query(
    "select public.direct_entry_account_operation_finalize_create($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6) as res",
    [OWNER.auth, OWNER.app, recBegan.intent_id, recBegan.intent_token, recAuthSubject, `rec-fin-term-${seq++}`],
  );
  assert.deepEqual(recTerminalReplay, {
    intent_id: recBegan.intent_id,
    intent_state: "APPLIED",
    account_ref: recFin.app_user_id,
  });

  // 4) Re-running cutover apply MUST succeed with ALREADY_APPLIED_NOOP immediately after standalone account creation
  const postCreateNoop = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: lockedFingerprint,
  });
  assert.equal(postCreateNoop.status, "ALREADY_APPLIED_NOOP");

  // 5) Creating personnel on the standalone account adds RECRUITER + 7 OWN grants & keeps cutover noop clean
  await db.query(
    "select public.direct_entry_account_operation_create_personnel($1::uuid, $2::uuid, $3::uuid, 1, 'post.standalone', 'STAFF', null, 'Link personnel to standalone post-cutover account', $4)",
    [OWNER.auth, OWNER.app, finRes.app_user_id, `post-pers-${seq++}`],
  );
  const { rows: upgradedRoles } = await db.query(
    "select role_code from public.authz_account_role_assignments where app_user_id = $1::uuid and ended_at is null order by role_code asc",
    [finRes.app_user_id],
  );
  assert.deepEqual(
    upgradedRoles.map((r) => r.role_code),
    ["EMPLOYEE_BASE", "RECRUITER"],
  );
  const { rows: [{ payload: upgradedCtx }] } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as payload",
    [postAuthSubject],
  );
  assert.equal(upgradedCtx.effective_grants.length, 7);

  const postPersonnelNoop = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: lockedFingerprint,
  });
  assert.equal(postPersonnelNoop.status, "ALREADY_APPLIED_NOOP");
});
