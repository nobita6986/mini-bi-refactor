import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(REPO_ROOT, "supabase", "migrations");
const SQL_DIR = path.join(__dirname, "wp2a-shadow", "sql");
const TODAY = "2026-11-12";
const TOMORROW = "2026-11-13";
const FUTURE_DATE = "2026-11-20";
const PAST_DATE = "2026-10-01";
const AS_OF_TODAY_TS = "2026-11-12T10:00:00+07:00";
const AS_OF_YESTERDAY_TS = "2026-11-11T10:00:00+07:00";
const AS_OF_TOMORROW_TS = "2026-11-13T10:00:00+07:00";

const ALL_33_CAPABILITIES = [
  "entry_create",
  "entry_own",
  "entry_team",
  "entry_admin",
  "entry_restore",
  "submission_create",
  "change_request_create",
  "change_review",
  "entry_privileged_edit",
  "employment_status.request",
  "employment_status.review",
  "employment_status.apply",
  "document_upload",
  "document_view",
  "payment_view",
  "payment_edit",
  "recruiter_master_manage",
  "team_master_manage",
  "pii_view",
  "pii_export",
  "audit_view",
  "catalog_master_manage",
  "team_manager_assign",
  "report_form_manage",
  "report_assign",
  "report_view",
  "report_analytics_view",
  "report_review",
  "report_delegate",
  "vendor_finance_view",
  "vendor_finance_record",
  "duplicate_cccd_withdraw",
  "worker_edit_history_view",
];

function stripSql(sqlText) {
  return sqlText
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim()
    .replace(/;\s*$/, "");
}

async function loadShadowSqls() {
  const names = {
    snap: "01_current_effective_snapshot.sql",
    diff: "02_candidate_and_diff.sql",
    drift: "03_drift_diagnostics.sql",
    persona: "04_uat_persona_matrix_check.sql",
  };
  const out = {};
  for (const [k, file] of Object.entries(names)) {
    out[k] = stripSql(await readFile(path.join(SQL_DIR, file), "utf8"));
  }
  return out;
}

async function bootDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  await db.exec("alter table auth.users add column if not exists email text;");
  const files = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
  for (const f of files) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, f), "utf8"));
  }
  return db;
}

function makeUuid(prefix, n) {
  const hex = n.toString(16).padStart(12, "0");
  return `${prefix}-${prefix.slice(0, 4)}-4${prefix.slice(0, 3)}-8${prefix.slice(0, 3)}-${hex}`;
}

async function createUser(db, id, displayName, enabled = true, createdAt = "2026-01-01T00:00:00Z") {
  await db.query(`insert into auth.users (id, email) values ($1::uuid, $2)`, [id, `${displayName.toLowerCase().replace(/[^a-z0-9]/g, "")}@test.local`]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name, created_at)
     values ($1::uuid, $1::uuid, $2, $3, $4::timestamptz)`,
    [id, enabled, displayName, createdAt]
  );
}

async function createTeam(db, teamId, code, active = true) {
  await db.query(
    `insert into public.teams (team_id, code, display_name, active, version)
     values ($1::uuid, $2, $3, $4, 1)`,
    [teamId, code, `Team ${code}`, active]
  );
}

async function createRecruiter(db, recId, code, active = true) {
  await db.query(
    `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)
     values ($1::uuid, $2, $3, 'STAFF', $4, 1)`,
    [recId, `Recruiter ${code}`, code, active]
  );
}

async function linkRecruiter(db, appUserId, recId, { validFrom = PAST_DATE, validTo = null, isCurrent = true, verified = true } = {}) {
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, valid_to, is_current)
     values ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6)`,
    [appUserId, recId, verified, validFrom, validTo, isCurrent]
  );
}

async function getDepartmentId(db, code) {
  const res = await db.query(`select department_id from public.organization_departments where code = $1`, [code]);
  return res.rows[0].department_id;
}

async function seedTemplate(db, { templateId, versionId, grantorId, status = "ACTIVE" }) {
  await db.query(
    `insert into public.work_report_templates
       (template_id, template_code, display_name, default_frequency, status, current_published_version_id, created_by_user_id, version)
     values ($1::uuid, $2, 'WP2A Daily Template', 'DAILY', $3, null, $4::uuid, 1)`,
    [templateId, `WP2A_TPL_${templateId.slice(-6).toUpperCase()}`, status, grantorId]
  );
  const metricContract = buildWorkReportMetricContract(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  await db.query(
    `insert into public.work_report_template_versions
       (version_id, template_id, version_no, status, requires_review, schema_json, metric_contract_json, schema_checksum, published_by_user_id, published_at)
     values ($1::uuid, $2::uuid, 1, 'PUBLISHED', false, $3::jsonb, $4::jsonb, $5, $6::uuid, '2026-10-01T00:00:00Z'::timestamptz)`,
    [
      versionId,
      templateId,
      JSON.stringify(RECRUITMENT_DAILY_TEMPLATE_SCHEMA),
      JSON.stringify(metricContract),
      "a".repeat(64),
      grantorId,
    ]
  );
  await db.query(
    `update public.work_report_templates set current_published_version_id = $1::uuid where template_id = $2::uuid`,
    [versionId, templateId]
  );
}

async function runReadOnly(db, asOfTs, fn) {
  await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;");
  try {
    await db.query("SET LOCAL TIME ZONE 'Asia/Ho_Chi_Minh';");
    await db.query("SELECT set_config('wp2a.as_of_ts', $1, true);", [asOfTs]);
    const res = await fn();
    await db.query("ROLLBACK;");
    return res;
  } catch (err) {
    try {
      await db.query("ROLLBACK;");
    } catch {
      // ignore
    }
    throw err;
  }
}

async function getCandidate(db, asOfTs, appUserId = null) {
  return (
    await db.query(
      `select * from public.direct_entry_authz_resolve_candidate_access($1::timestamptz, $2::uuid)`,
      [asOfTs, appUserId]
    )
  ).rows;
}

async function getDiff(db, asOfTs, appUserId = null) {
  return (
    await db.query(
      `select * from public.direct_entry_authz_compare_shadow_access($1::timestamptz, $2::uuid)`,
      [asOfTs, appUserId]
    )
  ).rows;
}

test("WP2A-1: Migration READ ONLY safety, strict service_role ACLs, and RPC-vs-SQL parity", async () => {
  const db = await bootDb();
  const sqls = await loadShadowSqls();
  try {
    const u1 = makeUuid("10000001", 1);
    await createUser(db, u1, "Parity User");
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_own', $2::date, true)`,
      [u1, PAST_DATE]
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'own', $2::date, true)`,
      [u1, PAST_DATE]
    );

    const aclCheck = await db.query(`
      select
        pg_catalog.has_function_privilege('service_role', 'public.direct_entry_authz_resolve_candidate_access(timestamptz, uuid)', 'EXECUTE') as sr_cand,
        pg_catalog.has_function_privilege('service_role', 'public.direct_entry_authz_resolve_current_snapshot(timestamptz, uuid)', 'EXECUTE') as sr_snap,
        pg_catalog.has_function_privilege('service_role', 'public.direct_entry_authz_compare_shadow_access(timestamptz, uuid)', 'EXECUTE') as sr_diff,
        pg_catalog.has_function_privilege('anon', 'public.direct_entry_authz_resolve_candidate_access(timestamptz, uuid)', 'EXECUTE') as anon_cand,
        pg_catalog.has_function_privilege('authenticated', 'public.direct_entry_authz_compare_shadow_access(timestamptz, uuid)', 'EXECUTE') as auth_diff,
        pg_catalog.has_function_privilege('public', 'public.direct_entry_authz_resolve_current_snapshot(timestamptz, uuid)', 'EXECUTE') as pub_snap
    `);
    assert.deepEqual(aclCheck.rows[0], {
      sr_cand: true,
      sr_snap: true,
      sr_diff: true,
      anon_cand: false,
      auth_diff: false,
      pub_snap: false,
    });

    await runReadOnly(db, AS_OF_TODAY_TS, async () => {
      const rpcSnap = await db.query(
        `select * from public.direct_entry_authz_resolve_current_snapshot($1::timestamptz, null)`,
        [AS_OF_TODAY_TS]
      );
      const rpcCand = await db.query(
        `select * from public.direct_entry_authz_resolve_candidate_access($1::timestamptz, null)`,
        [AS_OF_TODAY_TS]
      );
      const rpcDiff = await db.query(
        `select * from public.direct_entry_authz_compare_shadow_access($1::timestamptz, null)`,
        [AS_OF_TODAY_TS]
      );
      const fileSnap = await db.query(sqls.snap);
      const fileDiff = await db.query(sqls.diff);

      const normSnap = (r) => `${r.app_user_id}|${r.row_layer}|${r.module_code}|${r.action_code}|${r.scope_kind}|${r.scope_ref}|${r.grant_source}`;
      assert.deepEqual(rpcSnap.rows.map(normSnap).sort(), fileSnap.rows.map(normSnap).sort());
      const normDiff = (r) => `${r.app_user_id}|${r.diff_status}|${r.diff_classification}|${r.row_layer}|${r.action_code}|${r.scope_kind}|${r.scope_ref}`;
      assert.deepEqual(rpcDiff.rows.map(normDiff).sort(), fileDiff.rows.map(normDiff).sort());
      assert.ok(rpcCand.rows.length > 0);
    });
  } finally {
    await db.close();
  }
});

test("WP2A-2: All 9 authority sources, 23 capabilities under all scope, and multi-role additive union", async () => {
  const db = await bootDb();
  try {
    const admin = makeUuid("20000001", 1);
    const multi = makeUuid("20000002", 2);
    const grantor = makeUuid("20000003", 3);
    const acct = makeUuid("20000004", 4);
    const teamA = makeUuid("20000010", 1);
    const recMulti = makeUuid("20000020", 1);
    const tplId = makeUuid("20000030", 1);
    const verId = makeUuid("20000031", 1);

    await createUser(db, admin, "Full Admin 23 Caps");
    await createUser(db, multi, "Multi Role TL Plus Leave");
    await createUser(db, grantor, "Grantor Admin");
    await createUser(db, acct, "Accountant Multi");
    await createTeam(db, teamA, "TM_2A");
    await createRecruiter(db, recMulti, "REC_2A");
    await linkRecruiter(db, multi, recMulti);

    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ('PROJ_2A', 'Project 2A', true, 1)`
    );
    for (const cap of ALL_33_CAPABILITIES) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, $3::date, true)`,
        [admin, cap, PAST_DATE]
      );
    }
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', $2::date, true)`,
      [admin, PAST_DATE]
    );

    // 9 sources across multi, acct & grantor:
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_own', $2::date, true),
              ($3::uuid, 'entry_admin', $2::date, true),
              ($3::uuid, 'recruiter_master_manage', $2::date, true),
              ($3::uuid, 'team_master_manage', $2::date, true)`,
      [multi, PAST_DATE, grantor]
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'all', null, $3::date, true),
              ($2::uuid, 'team', $4::uuid, $3::date, true)`,
      [grantor, multi, PAST_DATE, teamA]
    );
    await db.query(
      `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, $4::date, true)`,
      [teamA, multi, recMulti, PAST_DATE]
    );
    await db.query(
      `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current, version)
       values ('PROJ_2A', $1::uuid, $2::date, true, 1)`,
      [recMulti, PAST_DATE]
    );
    const acctDeptId = await getDepartmentId(db, "ACCOUNTING");
    await db.query(
      `insert into public.organization_department_memberships (department_id, app_user_id, valid_from, version, granted_by_user_id, grant_reason)
       values ($1::uuid, $2::uuid, $3::date, 1, $4::uuid, 'Seed acct dept')`,
      [acctDeptId, acct, PAST_DATE, grantor]
    );
    await db.query(
      `insert into public.leave_module_grants (app_user_id, role_code, valid_from, is_current, reason)
       values ($1::uuid, 'HR_LEAVE_OPERATOR', $2::date, true, 'Seed leave role')`,
      [grantor, PAST_DATE]
    );
    await db.query(
      `insert into public.leave_department_approvers (unit_kind, approver_app_user_id, valid_from, is_current, reason)
       values ('MARKETING', $1::uuid, $2::date, true, 'Seed mkt approver')`,
      [multi, PAST_DATE]
    );
    await db.query(`SELECT set_config('vendor_finance.admin_write_marker', 'on', false)`);
    await db.query(
      `insert into public.vendor_finance_global_roles (app_user_id, role_code, version, valid_from, granted_by_user_id, grant_reason)
       values ($1::uuid, 'GLOBAL_VIEWER', 1, $2::date, $3::uuid, 'Seed vfin viewer')`,
      [acct, PAST_DATE, grantor]
    );
    await db.query(
      `insert into public.vendor_finance_project_accountants (project_id, accountant_user_id, version, valid_from, assigned_by_user_id, assign_reason)
       values ('PROJ_2A', $1::uuid, 1, $2::date, $3::uuid, 'Seed PA')`,
      [acct, PAST_DATE, grantor]
    );
    await seedTemplate(db, { templateId: tplId, versionId: verId, grantorId: grantor });
    await db.query(
      `insert into public.work_report_delegations
         (grantor_user_id, delegate_app_user_id, capability, template_id, template_version_id, scope_kind, scope_team_id, effective_from, effective_to, state, is_current, version)
       values ($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'team', $5::uuid, '2026-10-01T00:00:00Z'::timestamptz, null, 'ACTIVE', true, 1)`,
      [grantor, multi, tplId, verId, teamA]
    );

    const adminCand = await getCandidate(db, AS_OF_TODAY_TS, admin);
    const adminRawCaps = adminCand.filter((r) => r.row_layer === "RAW_GRANT" && r.action_code.startsWith("cap:")).map((r) => r.action_code);
    assert.equal(adminRawCaps.length, 33, "All 33 capabilities must be preserved in candidate RAW_GRANT");
    assert.ok(adminCand.some((r) => r.row_layer === "RAW_GRANT" && r.action_code === "scope:all"));

    const multiCand = await getCandidate(db, AS_OF_TODAY_TS, multi);
    const hasAction = (rows, code, scopeRef) => rows.some((r) => r.action_code === code && (scopeRef === undefined || r.scope_ref === scopeRef));
    assert.ok(hasAction(multiCand, "recruiter_link:verified", recMulti));
    assert.ok(hasAction(multiCand, "assignment:team_leader", teamA));
    assert.ok(hasAction(multiCand, "assignment:project_manager", "PROJ_2A"));
    assert.ok(hasAction(multiCand, "department_approver:MARKETING", "MARKETING"));
    assert.ok(hasAction(multiCand, "delegation:report_review", `${tplId}:${teamA}`));
    assert.ok(hasAction(multiCand, "op:leave:approve_department", "MARKETING"));
    assert.ok(hasAction(multiCand, "op:work_reports:review", `${tplId}:${teamA}`));

    const acctCand = await getCandidate(db, AS_OF_TODAY_TS, acct);
    assert.ok(hasAction(acctCand, "dept_member:ACCOUNTING", acctDeptId));
    assert.ok(hasAction(acctCand, "vfin_role:GLOBAL_VIEWER", "*"));
    assert.ok(hasAction(acctCand, "vfin_project_accountant", "PROJ_2A"));

    const grantorCand = await getCandidate(db, AS_OF_TODAY_TS, grantor);
    assert.ok(hasAction(grantorCand, "leave_role:HR_LEAVE_OPERATOR", "*"));

    const diffs = await getDiff(db, AS_OF_TODAY_TS);
    const unexpected = diffs.filter((r) => r.diff_classification.startsWith("UNEXPECTED_"));
    assert.deepEqual(unexpected, [], `Expected 0 unexpected diffs across all 9 sources, got ${JSON.stringify(unexpected)}`);
  } finally {
    await db.close();
  }
});

test("WP2A-3: Orphan scope=all narrows, explicit BoD grant restores, and fallback team scope recovers", async () => {
  const db = await bootDb();
  try {
    const bodOrphan = makeUuid("30000001", 1);
    const bodFallback = makeUuid("30000002", 2);
    const teamA = makeUuid("30000010", 1);
    await createUser(db, bodOrphan, "BOD Orphan");
    await createUser(db, bodFallback, "BOD Orphan With Team Fallback");
    await createTeam(db, teamA, "TM_3A");

    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'all', null, $3::date, true),
              ($2::uuid, 'all', null, $3::date, true),
              ($2::uuid, 'team', $4::uuid, $3::date, true)`,
      [bodOrphan, bodFallback, PAST_DATE, teamA]
    );

    const diffOrphan = await getDiff(db, AS_OF_TODAY_TS, bodOrphan);
    assert.equal(diffOrphan.length, 4);
    assert.ok(diffOrphan.every((r) => r.diff_classification === "EXPECTED_FIX_ORPHAN_ALL_SCOPE"));

    // Restore BoD with explicit report_view + report_analytics_view -> 0 diff!
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'report_view', $2::date, true),
              ($1::uuid, 'report_analytics_view', $2::date, true)`,
      [bodOrphan, PAST_DATE]
    );
    const diffRestored = await getDiff(db, AS_OF_TODAY_TS, bodOrphan);
    assert.equal(diffRestored.length, 0);

    // Fallback user keeps team Dashboard fallback while dropping invalid all scope
    const diffFb = await getDiff(db, AS_OF_TODAY_TS, bodFallback);
    assert.ok(diffFb.some((r) => r.diff_classification === "EXPECTED_FIX_ORPHAN_ALL_SCOPE" && r.scope_kind === "all"));
    assert.ok(diffFb.some((r) => r.diff_classification === "EXPECTED_FIX_DASHBOARD_FALLBACK_AFTER_INVALID_ALL_SCOPE" && r.scope_kind === "team" && r.scope_ref === teamA));
    assert.ok(!diffFb.some((r) => r.diff_classification.startsWith("UNEXPECTED_")));
  } finally {
    await db.close();
  }
});

test("WP2A-4: Wrong-module scope=all keeps catalog_manage but drops Dashboard all ops", async () => {
  const db = await bootDb();
  try {
    const catAll = makeUuid("40000001", 1);
    const catOwn = makeUuid("40000002", 2);
    await createUser(db, catAll, "Catalog All");
    await createUser(db, catOwn, "Catalog Own");

    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'catalog_master_manage', $3::date, true),
              ($2::uuid, 'catalog_master_manage', $3::date, true)`,
      [catAll, catOwn, PAST_DATE]
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', $3::date, true),
              ($2::uuid, 'own', $3::date, true)`,
      [catAll, catOwn, PAST_DATE]
    );

    const candCatAll = await getCandidate(db, AS_OF_TODAY_TS, catAll);
    assert.ok(candCatAll.some((r) => r.action_code === "op:admin:catalog_manage" && r.scope_kind === "all"));
    assert.ok(!candCatAll.some((r) => r.module_code === "dashboard"));

    const diffCatAll = await getDiff(db, AS_OF_TODAY_TS, catAll);
    assert.equal(diffCatAll.length, 3);
    assert.ok(diffCatAll.every((r) => r.diff_classification === "EXPECTED_FIX_ALL_SCOPE_WRONG_MODULE_CAPABILITY"));

    const candCatOwn = await getCandidate(db, AS_OF_TODAY_TS, catOwn);
    assert.ok(!candCatOwn.some((r) => r.action_code === "op:admin:catalog_manage"));
    assert.ok(!candCatOwn.some((r) => r.module_code === "dashboard"));
    assert.equal((await getDiff(db, AS_OF_TODAY_TS, catOwn)).length, 0);
  } finally {
    await db.close();
  }
});

test("WP2A-5: Disabled users and inactive parents yield 0 active candidate authority", async () => {
  const db = await bootDb();
  const sqls = await loadShadowSqls();
  try {
    const disabled = makeUuid("50000001", 1);
    const activeU = makeUuid("50000002", 2);
    const grantor = makeUuid("50000003", 3);
    const inactiveTeam = makeUuid("50000010", 1);
    const activeTeam = makeUuid("50000011", 2);
    const inactiveRec = makeUuid("50000020", 1);
    const tplArchived = makeUuid("50000030", 1);
    const verArchived = makeUuid("50000031", 1);

    await createUser(db, disabled, "Disabled User", false);
    await createUser(db, activeU, "Active With Inactive Parents", true);
    await createUser(db, grantor, "Admin Grantor", true);
    await createTeam(db, inactiveTeam, "TM_INACT", false);
    await createTeam(db, activeTeam, "TM_ACT", true);
    await createRecruiter(db, inactiveRec, "REC_INACT", false);

    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ('PROJ_INACT', 'Inactive Proj', false, 1)`
    );
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_own', $3::date, true),
              ($2::uuid, 'entry_own', $3::date, true)`,
      [disabled, activeU, PAST_DATE]
    );
    await db.query(
      `insert into public.leave_module_grants (app_user_id, role_code, valid_from, is_current, reason)
       values ($1::uuid, 'HR_REPORT_VIEWER', $2::date, true, 'Disabled active leave grant')`,
      [disabled, PAST_DATE]
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'team', $2::uuid, $3::date, true)`,
      [activeU, inactiveTeam, PAST_DATE]
    );
    await linkRecruiter(db, activeU, inactiveRec);
    await db.query(
      `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current, version)
       values ('PROJ_INACT', $1::uuid, $2::date, true, 1)`,
      [inactiveRec, PAST_DATE]
    );
    await seedTemplate(db, { templateId: tplArchived, versionId: verArchived, grantorId: grantor, status: "ARCHIVED" });
    await db.query(
      `insert into public.work_report_delegations
         (grantor_user_id, delegate_app_user_id, capability, template_id, template_version_id, scope_kind, scope_team_id, effective_from, effective_to, state, is_current, version)
       values ($1::uuid, $2::uuid, 'report_assign', $3::uuid, $4::uuid, 'team', $5::uuid, '2026-10-01T00:00:00Z'::timestamptz, null, 'ACTIVE', true, 1)`,
      [grantor, activeU, tplArchived, verArchived, activeTeam]
    );

    assert.equal((await getCandidate(db, AS_OF_TODAY_TS, disabled)).length, 0);
    const activeCand = await getCandidate(db, AS_OF_TODAY_TS, activeU);
    assert.ok(!activeCand.some((r) => r.scope_ref === inactiveTeam));
    assert.ok(!activeCand.some((r) => r.action_code === "recruiter_link:verified"));
    assert.ok(!activeCand.some((r) => r.scope_ref === "PROJ_INACT"));
    assert.ok(!activeCand.some((r) => r.action_code === "delegation:report_assign"));

    await runReadOnly(db, AS_OF_TODAY_TS, async () => {
      const drift = (await db.query(sqls.drift)).rows;
      assert.ok(drift.some((r) => r.drift_code === "DISABLED_USER_ACTIVE_LEAVE_GRANT" && r.app_user_id === disabled));
    });
  } finally {
    await db.close();
  }
});

test("WP2A-6: Stale is_current drift — future-dated and expired grants excluded by candidate", async () => {
  const db = await bootDb();
  try {
    const futureU = makeUuid("60000001", 1);
    const expiredU = makeUuid("60000002", 2);
    await createUser(db, futureU, "Future Grant User");
    await createUser(db, expiredU, "Expired Stale Current User");

    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current)
       values ($1::uuid, 'entry_own', $3::date, null, true),
              ($2::uuid, 'entry_own', $4::date, $5::date, true)`,
      [futureU, expiredU, FUTURE_DATE, PAST_DATE, TODAY]
    );

    assert.equal((await getCandidate(db, AS_OF_TODAY_TS, futureU)).length, 0);
    assert.equal((await getCandidate(db, AS_OF_TODAY_TS, expiredU)).length, 0);
    // Half-open [valid_from, valid_to): active yesterday (TODAY > YESTERDAY)
    assert.ok((await getCandidate(db, AS_OF_YESTERDAY_TS, expiredU)).length > 0);

    const diffF = await getDiff(db, AS_OF_TODAY_TS, futureU);
    assert.ok(diffF.some((r) => r.diff_classification === "EXPECTED_FIX_FUTURE_DATED_GRANT"));
    const diffE = await getDiff(db, AS_OF_TODAY_TS, expiredU);
    assert.ok(diffE.some((r) => r.diff_classification === "EXPECTED_FIX_EXPIRED_GRANT_STALE_IS_CURRENT"));
  } finally {
    await db.close();
  }
});

test("WP2A-7: Same-day/cross-day transfer/revoke, leave same-day trap, PM ambiguous link, VFin ACCOUNTING gate, shared non-employee", async () => {
  const db = await bootDb();
  try {
    const tl1 = makeUuid("70000001", 1);
    const tl2 = makeUuid("70000002", 2);
    const sameDayRevoke = makeUuid("70000003", 3);
    const pmAmb = makeUuid("70000004", 4);
    const pmAmbOther = makeUuid("70000008", 8);
    const paNoDept = makeUuid("70000005", 5);
    const sharedAcct = makeUuid("70000006", 6);
    const grantor = makeUuid("70000007", 7);
    const teamA = makeUuid("70000010", 1);
    const r1 = makeUuid("70000020", 1);
    const r2 = makeUuid("70000021", 2);
    const r3 = makeUuid("70000022", 3);

    for (const [id, name] of [
      [tl1, "TL Old"],
      [tl2, "TL New"],
      [sameDayRevoke, "Leave Same Day Trap"],
      [pmAmb, "PM Ambiguous 1"],
      [pmAmbOther, "PM Ambiguous 2"],
      [paNoDept, "PA Missing Dept"],
      [sharedAcct, "Shared Non Employee"],
      [grantor, "Admin 7"],
    ]) {
      await createUser(db, id, name);
    }
    await createTeam(db, teamA, "TM_7A");
    await createRecruiter(db, r1, "R7_1");
    await createRecruiter(db, r2, "R7_2");
    await createRecruiter(db, r3, "R7_3");
    await linkRecruiter(db, tl1, r1);
    await linkRecruiter(db, tl2, r2);
    await linkRecruiter(db, pmAmb, r3);

    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ('PROJ_7A', 'Project 7A', true, 1)`
    );
    await db.query(
      `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current, version)
       values ('PROJ_7A', $1::uuid, $2::date, true, 1)`,
      [r3, PAST_DATE]
    );
    // Inject corrupt second verified account linked to the same recruiter r3 after PM assignment -> non-1:1 link blocked in candidate!
    await db.query(`alter table public.direct_entry_app_user_recruiter_links disable trigger user`);
    await linkRecruiter(db, pmAmbOther, r3);
    await db.query(`alter table public.direct_entry_app_user_recruiter_links enable trigger user`);
    // TL handover + Leave Approver handover on TODAY:
    await db.query(
      `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, $5::date, $6::date, false),
              ($1::uuid, $4::uuid, $7::uuid, $6::date, null, true)`,
      [teamA, tl1, r1, tl2, PAST_DATE, TODAY, r2]
    );
    await db.query(
      `insert into public.leave_department_approvers (unit_kind, approver_app_user_id, valid_from, valid_to, is_current, reason)
       values ('IT', $1::uuid, $3::date, $4::date, false, 'Old'),
              ('IT', $2::uuid, $4::date, null, true, 'New')`,
      [tl1, tl2, PAST_DATE, TODAY]
    );
    // Leave same-day grant + revoke trap: valid_from = TODAY, valid_to = TOMORROW, is_current = false, updated_at = AS_OF_TODAY_TS
    await db.query(
      `insert into public.leave_module_grants (app_user_id, role_code, valid_from, valid_to, is_current, reason, updated_at)
       values ($1::uuid, 'HR_REPORT_VIEWER', $2::date, $3::date, false, 'Same-day revoke', $4::timestamptz)`,
      [sameDayRevoke, TODAY, TOMORROW, AS_OF_TODAY_TS]
    );
    // VFin Project Accountant without ACCOUNTING dept
    await db.query(`SELECT set_config('vendor_finance.admin_write_marker', 'on', false)`);
    await db.query(
      `insert into public.vendor_finance_project_accountants (project_id, accountant_user_id, version, valid_from, assigned_by_user_id, assign_reason)
       values ('PROJ_7A', $1::uuid, 1, $2::date, $3::uuid, 'PA no dept')`,
      [paNoDept, PAST_DATE, grantor]
    );
    // Shared non-employee with Leave Approver row -> candidate must exclude!
    await db.query(
      `insert into public.leave_employee_profiles (app_user_id, unit_kind, employment_status, work_start_date, official_effective_date, is_shared_non_employee)
       values ($1::uuid, 'MARKETING', 'OFFICIAL', '2026-01-01', '2026-01-01', true)`,
      [sharedAcct]
    );
    await db.query(
      `insert into public.leave_department_approvers (unit_kind, approver_app_user_id, valid_from, is_current, reason)
       values ('ACCOUNTING', $1::uuid, $2::date, true, 'Shared error')`,
      [sharedAcct, PAST_DATE]
    );

    assert.ok(!(await getCandidate(db, AS_OF_TODAY_TS, tl1)).some((r) => r.action_code === "assignment:team_leader"));
    assert.ok((await getCandidate(db, AS_OF_YESTERDAY_TS, tl1)).some((r) => r.action_code === "assignment:team_leader"));
    assert.ok((await getCandidate(db, AS_OF_TODAY_TS, tl2)).some((r) => r.action_code === "assignment:team_leader"));
    assert.ok((await getCandidate(db, AS_OF_TODAY_TS, tl2)).some((r) => r.action_code === "department_approver:IT"));

    assert.equal((await getCandidate(db, AS_OF_TODAY_TS, sameDayRevoke)).length, 0);
    assert.ok(!(await getCandidate(db, AS_OF_TODAY_TS, pmAmb)).some((r) => r.action_code === "assignment:project_manager"));
    assert.ok(!(await getCandidate(db, AS_OF_TODAY_TS, paNoDept)).some((r) => r.action_code === "op:vendor_finance:project_ledger_operate"));
    const sharedCand = await getCandidate(db, AS_OF_TODAY_TS, sharedAcct);
    assert.equal(sharedCand.filter((r) => r.row_layer === "MODULE_OP").length, 0);

    const diffPm = await getDiff(db, AS_OF_TODAY_TS, pmAmb);
    assert.ok(diffPm.some((r) => r.diff_classification === "EXPECTED_FIX_AMBIGUOUS_RECRUITER_LINK"));
    const diffPa = await getDiff(db, AS_OF_TODAY_TS, paNoDept);
    assert.ok(diffPa.some((r) => r.diff_classification === "EXPECTED_FIX_PROJECT_ACCOUNTANT_REQUIRES_ACCOUNTING_DEPT"));
    const diffShared = await getDiff(db, AS_OF_TODAY_TS, sharedAcct);
    assert.ok(diffShared.some((r) => r.diff_classification === "EXPECTED_FIX_SHARED_ACCOUNT_EXCLUSION"));
  } finally {
    await db.close();
  }
});

test("WP2A-8: work_report_delegations immediate open-ended, cross-day persistence, immediate revoke, grantor invalid, and delegate direct cap survival", async () => {
  const db = await bootDb();
  try {
    const grantor = makeUuid("80000001", 1);
    const badGrantor = makeUuid("80000002", 2);
    const delegate = makeUuid("80000003", 3);
    const teamA = makeUuid("80000010", 1);
    const recG = makeUuid("80000020", 1);
    const tplId = makeUuid("80000030", 1);
    const verId = makeUuid("80000031", 1);
    const delId = makeUuid("80000040", 1);

    await createUser(db, grantor, "Valid Admin Grantor");
    await createUser(db, badGrantor, "Grantor Without Right");
    await createUser(db, delegate, "Delegate With Direct Cap");
    await createTeam(db, teamA, "TM_8A");
    await createRecruiter(db, recG, "R8");
    await linkRecruiter(db, grantor, recG);

    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_admin', $3::date, true),
              ($1::uuid, 'recruiter_master_manage', $3::date, true),
              ($1::uuid, 'team_master_manage', $3::date, true),
              ($2::uuid, 'report_view', $3::date, true)`,
      [grantor, delegate, PAST_DATE]
    );
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current)
       values ($1::uuid, 'report_delegate', $2::date, $3::date, true),
              ($1::uuid, 'report_review', $2::date, $3::date, true)`,
      [badGrantor, PAST_DATE, TODAY]
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current)
       values ($1::uuid, 'all', null, $4::date, null, true),
              ($2::uuid, 'team', $6::uuid, $4::date, $5::date, true),
              ($3::uuid, 'team', $6::uuid, $4::date, null, true)`,
      [grantor, badGrantor, delegate, PAST_DATE, TODAY, teamA]
    );
    await seedTemplate(db, { templateId: tplId, versionId: verId, grantorId: grantor });

    // 1) Open-ended effective_to IS NULL delegation created at T0
    await db.query(
      `insert into public.work_report_delegations
         (delegation_id, grantor_user_id, delegate_app_user_id, capability, template_id, template_version_id, scope_kind, scope_team_id, effective_from, effective_to, state, is_current, version)
       values ($1::uuid, $2::uuid, $3::uuid, 'report_assign', $4::uuid, $5::uuid, 'team', $6::uuid, '2026-11-12T08:00:00+07:00'::timestamptz, null, 'ACTIVE', true, 1),
              (gen_random_uuid(), $7::uuid, $3::uuid, 'report_review', $4::uuid, $5::uuid, 'team', $6::uuid, '2026-11-12T08:00:00+07:00'::timestamptz, null, 'ACTIVE', true, 1)`,
      [delId, grantor, delegate, tplId, verId, teamA, badGrantor]
    );

    const candAtT0 = await getCandidate(db, "2026-11-12T08:00:00+07:00", delegate);
    const expectedScopeRef = `${tplId}:${teamA}`;
    assert.ok(candAtT0.some((r) => r.action_code === "delegation:report_assign" && r.scope_ref === expectedScopeRef));
    assert.ok(candAtT0.some((r) => r.action_code === "op:work_reports:assign" && r.scope_ref === expectedScopeRef));
    // badGrantor delegation must be dropped in candidate
    assert.ok(!candAtT0.some((r) => r.action_code === "delegation:report_review"));
    // Check diff flags badGrantor as EXPECTED_FIX_DELEGATION_GRANTOR_INVALID
    const diffAtT0 = await getDiff(db, "2026-11-12T08:00:00+07:00", delegate);
    assert.ok(diffAtT0.some((r) => r.diff_classification === "EXPECTED_FIX_DELEGATION_GRANTOR_INVALID"));

    // 2) Cross-day persistence (D + 1)
    const candNextDay = await getCandidate(db, AS_OF_TOMORROW_TS, delegate);
    assert.ok(candNextDay.some((r) => r.action_code === "delegation:report_assign" && r.scope_ref === expectedScopeRef));

    // 3) Immediate revoke at 15:00 -> revoked at 15:00, still reconstructible before 15:00, direct cap survives!
    await db.query(
      `update public.work_report_delegations
          set state = 'REVOKED', is_current = false, revoked_by_user_id = $2::uuid, revoked_at = '2026-11-12T15:00:00+07:00'::timestamptz
        where delegation_id = $1::uuid`,
      [delId, grantor]
    );
    const candBeforeRevoke = await getCandidate(db, "2026-11-12T14:59:59+07:00", delegate);
    assert.ok(candBeforeRevoke.some((r) => r.action_code === "delegation:report_assign"));
    const candAtRevoke = await getCandidate(db, "2026-11-12T15:00:00+07:00", delegate);
    assert.ok(!candAtRevoke.some((r) => r.action_code === "delegation:report_assign"));
    assert.ok(candAtRevoke.some((r) => r.action_code === "cap:report_view"), "Delegate direct capability must survive delegation revoke");
  } finally {
    await db.close();
  }
});

test("WP2A-9: Missing historical evidence labeling and non-resurrection of wiped non-current rows", async () => {
  const db = await bootDb();
  const sqls = await loadShadowSqls();
  try {
    const u = makeUuid("90000001", 1);
    await createUser(db, u, "Wiped Grant User");
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current)
       values ($1::uuid, 'entry_own', $2::date, null, false),
              ($1::uuid, 'report_view', $2::date, null, true)`,
      [u, PAST_DATE]
    );

    const histCand = await getCandidate(db, "2026-11-01T10:00:00+07:00", u);
    assert.ok(!histCand.some((r) => r.action_code === "cap:entry_own"), "Wiped row (is_current=false, valid_to IS NULL) must never be resurrected");
    assert.ok(histCand.every((r) => r.reconstructibility.startsWith("CURRENT_STATE_ONLY")));

    await runReadOnly(db, AS_OF_TODAY_TS, async () => {
      const drift = (await db.query(sqls.drift)).rows;
      assert.ok(drift.some((r) => r.drift_code === "MISSING_VALID_TO_ON_NON_CURRENT_ROW" && r.app_user_id === u));
    });
  } finally {
    await db.close();
  }
});

test("WP2A-10: EXPLAIN ANALYZE BUFFERS cost benchmark on 80-user synthetic dataset", async () => {
  const db = await bootDb();
  const sqls = await loadShadowSqls();
  try {
    const teams = [];
    for (let t = 0; t < 4; t += 1) {
      const tid = makeUuid("a0000010", t + 1);
      teams.push(tid);
      await createTeam(db, tid, `TM_B_${t + 1}`);
    }
    for (let i = 1; i <= 80; i += 1) {
      const uid = makeUuid("a0000001", i);
      const rid = makeUuid("a0000020", i);
      await createUser(db, uid, `Bench User ${i}`);
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, 'entry_own', $2::date, true)`,
        [uid, PAST_DATE]
      );
      await db.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
         values ($1::uuid, 'team', $2::uuid, $3::date, true)`,
        [uid, teams[i % 4], PAST_DATE]
      );
      await createRecruiter(db, rid, `RB_${i}`);
      await linkRecruiter(db, uid, rid);
    }

    await runReadOnly(db, AS_OF_TODAY_TS, async () => {
      const exRpc = await db.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM public.direct_entry_authz_compare_shadow_access($1::timestamptz, null)`,
        [AS_OF_TODAY_TS]
      );
      const exSql = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sqls.diff}`);

      for (const [label, planArr] of [
        ["rpc_80u", exRpc.rows[0]["QUERY PLAN"]],
        ["sql_80u", exSql.rows[0]["QUERY PLAN"]],
      ]) {
        const root = planArr[0];
        let tempWritten = 0;
        const walk = (n) => {
          if (!n || typeof n !== "object") return;
          tempWritten += Number(n["Temp Written Blocks"] || 0);
          if (Array.isArray(n.Plans)) n.Plans.forEach(walk);
        };
        walk(root.Plan);
        assert.equal(tempWritten, 0, `${label} must not spill temp blocks on 80-user fixture`);
        assert.ok(Number(root["Execution Time"]) < 2000, `${label} took ${root["Execution Time"]}ms (<2000ms expected)`);
      }
    });
  } finally {
    await db.close();
  }
});
