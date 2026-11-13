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

test("WP2A-3: Reporting capability+scope+1:1 link rules, strict fallback, offboarding, and workers_all_tab", async () => {
  const db = await bootDb();
  try {
    const bodOrphan = makeUuid("30000001", 1);
    const bodNoCapWithTeam = makeUuid("30000002", 2);
    const fbTeamValid = makeUuid("30000003", 3);
    const fbRecValid = makeUuid("30000004", 4);
    const teamNoCap = makeUuid("30000005", 5);
    const teamWrongCap = makeUuid("30000006", 6);
    const recAmb1to2 = makeUuid("30000007", 7);
    const recAmb2to1a = makeUuid("30000008", 8);
    const recAmb2to1b = makeUuid("30000009", 9);
    const teamPositive = makeUuid("3000000a", 10);
    const recPositive = makeUuid("3000000b", 11);
    const offboardAnalytics = makeUuid("3000000c", 12);
    const workersPrivEdit = makeUuid("3000000d", 13);

    const teamA = makeUuid("30000010", 1);
    const rFb = makeUuid("30000020", 1);
    const rAmb1 = makeUuid("30000020", 2);
    const rAmb2 = makeUuid("30000020", 3);
    const rShared = makeUuid("30000020", 4);
    const rPos = makeUuid("30000020", 5);

    for (const [id, name] of [
      [bodOrphan, "BOD Orphan"],
      [bodNoCapWithTeam, "BOD Zero-Cap Team"],
      [fbTeamValid, "Fallback Valid Team"],
      [fbRecValid, "Fallback Valid Recruited"],
      [teamNoCap, "Team No Cap"],
      [teamWrongCap, "Team Wrong Cap"],
      [recAmb1to2, "Rec Ambiguous 1to2"],
      [recAmb2to1a, "Rec Ambiguous 2to1 A"],
      [recAmb2to1b, "Rec Ambiguous 2to1 B"],
      [teamPositive, "Team Positive"],
      [recPositive, "Rec Positive"],
      [offboardAnalytics, "Offboard Analytics Only"],
      [workersPrivEdit, "Workers Priv Edit Only"],
    ]) {
      await createUser(db, id, name);
    }
    await createTeam(db, teamA, "TM_3A");
    for (const [rid, code] of [
      [rFb, "R3_FB"],
      [rAmb1, "R3_AMB1"],
      [rAmb2, "R3_AMB2"],
      [rShared, "R3_SHARED"],
      [rPos, "R3_POS"],
    ]) {
      await createRecruiter(db, rid, code);
    }

    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'all', null, $10::date, true),
              ($2::uuid, 'all', null, $10::date, true),
              ($2::uuid, 'team', $11::uuid, $10::date, true),
              ($3::uuid, 'all', null, $10::date, true),
              ($3::uuid, 'team', $11::uuid, $10::date, true),
              ($4::uuid, 'all', null, $10::date, true),
              ($4::uuid, 'team', $11::uuid, $10::date, true),
              ($5::uuid, 'team', $11::uuid, $10::date, true),
              ($6::uuid, 'team', $11::uuid, $10::date, true),
              ($7::uuid, 'team', $11::uuid, $10::date, true),
              ($8::uuid, 'all', null, $10::date, true),
              ($9::uuid, 'all', null, $10::date, true)`,
      [
        bodOrphan,
        bodNoCapWithTeam,
        fbTeamValid,
        fbRecValid,
        teamNoCap,
        teamWrongCap,
        teamPositive,
        offboardAnalytics,
        workersPrivEdit,
        PAST_DATE,
        teamA,
      ]
    );
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_team', $10::date, true),
              ($2::uuid, 'entry_own', $10::date, true),
              ($3::uuid, 'catalog_master_manage', $10::date, true),
              ($4::uuid, 'entry_own', $10::date, true),
              ($5::uuid, 'entry_own', $10::date, true),
              ($6::uuid, 'entry_own', $10::date, true),
              ($7::uuid, 'report_view', $10::date, true),
              ($8::uuid, 'report_view', $10::date, true),
              ($9::uuid, 'report_view', $10::date, true),
              ($9::uuid, 'report_analytics_view', $10::date, true),
              ($11::uuid, 'entry_privileged_edit', $10::date, true)`,
      [
        fbTeamValid,
        fbRecValid,
        teamWrongCap,
        recAmb1to2,
        recAmb2to1a,
        recAmb2to1b,
        teamPositive,
        recPositive,
        offboardAnalytics,
        PAST_DATE,
        workersPrivEdit,
      ]
    );

    await linkRecruiter(db, fbRecValid, rFb);
    await linkRecruiter(db, recPositive, rPos);
    await db.query(`alter table public.direct_entry_app_user_recruiter_links disable trigger user`);
    await linkRecruiter(db, recAmb1to2, rAmb1);
    await linkRecruiter(db, recAmb1to2, rAmb2);
    await linkRecruiter(db, recAmb2to1a, rShared);
    await linkRecruiter(db, recAmb2to1b, rShared);
    await db.query(`alter table public.direct_entry_app_user_recruiter_links enable trigger user`);

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
    assert.equal((await getDiff(db, AS_OF_TODAY_TS, bodOrphan)).length, 0);

    // Zero-cap scope='all' + scope='team' must NOT gain fallback team Dashboard access!
    const candNoCapFb = await getCandidate(db, AS_OF_TODAY_TS, bodNoCapWithTeam);
    assert.ok(!candNoCapFb.some((r) => r.row_layer === "MODULE_OP"));
    assert.ok(candNoCapFb.every((r) => r.action_code === "scope:team"));
    const diffNoCapFb = await getDiff(db, AS_OF_TODAY_TS, bodNoCapWithTeam);
    assert.equal(diffNoCapFb.length, 4);
    assert.ok(diffNoCapFb.every((r) => r.diff_classification === "EXPECTED_FIX_ORPHAN_ALL_SCOPE" && r.scope_kind === "all"));

    // Valid fallback to team (holds entry_team) & fallback past unauthorized all+team to recruited (holds entry_own + 1:1 link)
    const diffFbTeam = await getDiff(db, AS_OF_TODAY_TS, fbTeamValid);
    assert.ok(diffFbTeam.some((r) => r.diff_classification === "EXPECTED_FIX_DASHBOARD_FALLBACK_AFTER_INVALID_ALL_SCOPE" && r.scope_kind === "team" && r.scope_ref === teamA));
    assert.ok(!diffFbTeam.some((r) => r.diff_classification.startsWith("UNEXPECTED_")));

    const candFbRec = await getCandidate(db, AS_OF_TODAY_TS, fbRecValid);
    assert.ok(candFbRec.some((r) => r.action_code === "op:dashboard:view_general" && r.scope_kind === "recruited" && r.scope_ref === rFb));
    const diffFbRec = await getDiff(db, AS_OF_TODAY_TS, fbRecValid);
    assert.ok(diffFbRec.some((r) => r.diff_classification === "EXPECTED_FIX_DASHBOARD_FALLBACK_AFTER_INVALID_ALL_SCOPE" && r.scope_kind === "recruited" && r.scope_ref === rFb));
    assert.ok(!diffFbRec.some((r) => r.diff_classification.startsWith("UNEXPECTED_")));

    // Negative team (0 caps & wrong-module cap) and ambiguous recruiter links (1:2 & 2:1)
    for (const negTeamUser of [teamNoCap, teamWrongCap]) {
      const c = await getCandidate(db, AS_OF_TODAY_TS, negTeamUser);
      assert.ok(!c.some((r) => r.action_code === "op:dashboard:view_general"));
      const d = await getDiff(db, AS_OF_TODAY_TS, negTeamUser);
      assert.ok(d.some((r) => r.diff_classification === "EXPECTED_FIX_REPORTING_SCOPE_WITHOUT_CAPABILITY" && r.scope_kind === "team"));
    }
    for (const ambUser of [recAmb1to2, recAmb2to1a, recAmb2to1b]) {
      const c = await getCandidate(db, AS_OF_TODAY_TS, ambUser);
      assert.ok(!c.some((r) => r.action_code === "op:dashboard:view_general"));
      const d = await getDiff(db, AS_OF_TODAY_TS, ambUser);
      if (ambUser === recAmb1to2) {
        // Legacy Dashboard already checks 1 user -> 1 recruiter count = 1, so both curr and cand withhold @recruited
        assert.equal(d.length, 0);
      } else {
        // Legacy Dashboard misses 2 users -> 1 recruiter (2:1) ambiguity; Candidate blocks and classifies it
        assert.ok(d.some((r) => r.diff_classification === "EXPECTED_FIX_AMBIGUOUS_RECRUITER_LINK" && r.action_code === "op:dashboard:view_general" && r.scope_kind === "recruited"));
        assert.ok(!d.some((r) => r.diff_classification.startsWith("UNEXPECTED_")));
      }
    }

    // Positive team (report_view) and recruited (report_view + 1:1) cases
    assert.ok((await getCandidate(db, AS_OF_TODAY_TS, teamPositive)).some((r) => r.action_code === "op:dashboard:view_general" && r.scope_kind === "team"));
    assert.equal((await getDiff(db, AS_OF_TODAY_TS, teamPositive)).length, 0);
    assert.ok((await getCandidate(db, AS_OF_TODAY_TS, recPositive)).some((r) => r.action_code === "op:dashboard:view_general" && r.scope_kind === "recruited"));
    assert.equal((await getDiff(db, AS_OF_TODAY_TS, recPositive)).length, 0);

    // Tightened offboarding_view (report_view+analytics alone denied) and workers_all_tab (entry_privileged_edit alone denied)
    assert.ok(!(await getCandidate(db, AS_OF_TODAY_TS, offboardAnalytics)).some((r) => r.action_code === "op:workforce:offboarding_view"));
    const candPriv = await getCandidate(db, AS_OF_TODAY_TS, workersPrivEdit);
    assert.ok(candPriv.some((r) => r.action_code === "op:workforce:offboarding_view" && r.scope_kind === "all"));
    assert.ok(!candPriv.some((r) => r.action_code === "op:direct_entry:workers_all_tab"));
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

test("WP2A-11: Intra-day historical reconstruction (before/at/after revoke, same-day grant+revoke, handover) and limitation labels", async () => {
  const db = await bootDb();
  try {
    const pmPrior = makeUuid("b0000001", 1);
    const pmSameDay = makeUuid("b0000002", 2);
    const pmNext = makeUuid("b0000003", 3);
    const tl1 = makeUuid("b0000004", 4);
    const tl2 = makeUuid("b0000005", 5);
    const leaveOp = makeUuid("b0000006", 6);
    const acctUser = makeUuid("b0000007", 7);
    const grantor = makeUuid("b0000008", 8);

    const recPm1 = makeUuid("b0000020", 1);
    const recPmSame = makeUuid("b0000020", 2);
    const recPmNext = makeUuid("b0000020", 3);
    const recTl1 = makeUuid("b0000020", 4);
    const recTl2 = makeUuid("b0000020", 5);
    const teamH = makeUuid("b0000010", 1);
    const teamCancel = makeUuid("b0000010", 2);

    for (const [id, name] of [
      [pmPrior, "PM Prior Revoked Same Day"],
      [pmSameDay, "PM Same Day Grant Revoke"],
      [pmNext, "PM Handover Target"],
      [tl1, "TL1 Rev Handover"],
      [tl2, "TL2 Rev Handover"],
      [leaveOp, "Leave Same Day Operator"],
      [acctUser, "Acct VFin Same Day"],
      [grantor, "Grantor Admin"],
    ]) {
      await createUser(db, id, name);
    }
    await createTeam(db, teamH, "TM_11H");
    await createTeam(db, teamCancel, "TM_11C");
    for (const [rid, code] of [
      [recPm1, "R11_PM1"],
      [recPmSame, "R11_PMS"],
      [recPmNext, "R11_PM2"],
      [recTl1, "R11_TL1"],
      [recTl2, "R11_TL2"],
    ]) {
      await createRecruiter(db, rid, code);
    }
    await linkRecruiter(db, pmPrior, recPm1);
    await linkRecruiter(db, pmSameDay, recPmSame);
    await linkRecruiter(db, pmNext, recPmNext);
    await linkRecruiter(db, tl1, recTl1);
    await linkRecruiter(db, tl2, recTl2);

    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ('PROJ_11A', 'Project 11A', true, 1), ('PROJ_11B', 'Project 11B', true, 1)`
    );

    // 1) PM active since PAST_DATE, revoked at 15:00 TODAY (`valid_to = TODAY, is_current = false, revoked_at = 15:00+07`)
    //    PLUS PM handover `pmNext` starting at 15:00 TODAY on PROJ_11A
    await db.query(
      `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, valid_to, is_current, version, created_at, revoked_at)
       values ('PROJ_11A', $1::uuid, $3::date, $4::date, false, 1, '2026-10-01T08:00:00+07:00'::timestamptz, '2026-11-12T15:00:00+07:00'::timestamptz),
              ('PROJ_11A', $2::uuid, $4::date, null, true, 2, '2026-11-12T15:00:00+07:00'::timestamptz, null)`,
      [recPm1, recPmNext, PAST_DATE, TODAY]
    );

    // 2) Same-day PM grant at 08:00 TODAY -> revoked at 15:00 TODAY (`valid_from = TODAY, valid_to = TODAY`)
    await db.query(
      `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, valid_to, is_current, version, created_at, revoked_at)
       values ('PROJ_11B', $1::uuid, $2::date, $2::date, false, 1, '2026-11-12T08:00:00+07:00'::timestamptz, '2026-11-12T15:00:00+07:00'::timestamptz)`,
      [recPmSame, TODAY]
    );

    // 3) Same-day TL handover via direct_entry_team_leader_revisions (`tl1` at 08:00 -> `tl2` at 15:00)
    await db.query(`SELECT set_config('direct_entry.team_leader_marker', 'on', false)`);
    await db.query(
      `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, is_current, created_at)
       values ($1::uuid, $2::uuid, $4::uuid, $6::date, $6::date, false, '2026-11-12T08:00:00+07:00'::timestamptz),
              ($1::uuid, $3::uuid, $5::uuid, $6::date, null, true, '2026-11-12T15:00:00+07:00'::timestamptz)`,
      [teamH, tl1, tl2, recTl1, recTl2, TODAY]
    );
    await db.query(
      `insert into public.direct_entry_team_leader_revisions (team_id, version, actor_user_id, action, before_snapshot, after_snapshot, created_at)
       values ($1::uuid, 1, $6::uuid, 'ASSIGN', null, jsonb_build_object('team_id', $1::text, 'leader_app_user_id', $2::text, 'leader_recruiter_id', $4::text, 'valid_from', $7::text, 'version', 1), '2026-11-12T08:00:00+07:00'::timestamptz),
              ($1::uuid, 2, $6::uuid, 'HANDOVER', jsonb_build_object('team_id', $1::text, 'leader_app_user_id', $2::text, 'leader_recruiter_id', $4::text), jsonb_build_object('team_id', $1::text, 'leader_app_user_id', $3::text, 'leader_recruiter_id', $5::text, 'valid_from', $7::text, 'version', 2), '2026-11-12T15:00:00+07:00'::timestamptz)`,
      [teamH, tl1, tl2, recTl1, recTl2, grantor, TODAY]
    );

    // 3b) Active TL (`tl1`) with a cancelled future TL replacement (`tl2`) on `teamCancel`
    await db.query(
      `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, is_current, created_at)
       values ($1::uuid, $2::uuid, $4::uuid, $6::date, null, true, '2026-10-01T08:00:00+07:00'::timestamptz),
              ($1::uuid, $3::uuid, $5::uuid, $7::date, $7::date, false, '2026-10-10T18:34:19+07:00'::timestamptz)`,
      [teamCancel, tl1, tl2, recTl1, recTl2, PAST_DATE, FUTURE_DATE]
    );
    await db.query(
      `insert into public.direct_entry_team_leader_revisions (team_id, version, actor_user_id, action, before_snapshot, after_snapshot, created_at)
       values ($1::uuid, 1, $6::uuid, 'transition', null, jsonb_build_object('team_id', $1::text, 'leader_app_user_id', $2::text, 'leader_recruiter_id', $4::text, 'valid_from', $7::text, 'valid_to', null, 'version', 1), '2026-10-01T08:00:00+07:00'::timestamptz),
              ($1::uuid, 2, $6::uuid, 'replace', jsonb_build_object('team_id', $1::text, 'leader_app_user_id', $2::text, 'leader_recruiter_id', $4::text, 'valid_from', $7::text, 'valid_to', null), jsonb_build_object('team_id', $1::text, 'leader_app_user_id', $3::text, 'leader_recruiter_id', $5::text, 'valid_from', $8::text, 'valid_to', null, 'version', 2), '2026-10-10T18:34:19+07:00'::timestamptz),
              ($1::uuid, 3, $6::uuid, 'revoke', jsonb_build_object('team_id', $1::text, 'leader_app_user_id', $3::text, 'leader_recruiter_id', $5::text, 'valid_from', $8::text, 'valid_to', null), jsonb_build_object('team_id', $1::text, 'leader_app_user_id', $3::text, 'leader_recruiter_id', $5::text, 'valid_from', $8::text, 'valid_to', $8::text, 'version', 3), '2026-10-10T18:34:38+07:00'::timestamptz)`,
      [teamCancel, tl1, tl2, recTl1, recTl2, grantor, PAST_DATE, FUTURE_DATE]
    );

    // 4) Same-day Leave Dept Approver handover (`tl1` at 08:00 -> `tl2` at 15:00) & Leave Module Grant grant at 08:00 + revoke at 15:00
    await db.query(
      `insert into public.leave_department_approvers (unit_kind, approver_app_user_id, valid_from, valid_to, is_current, reason, created_at, updated_at)
       values ('IT', $1::uuid, $3::date, $3::date, false, 'Morning IT approver', '2026-11-12T08:00:00+07:00'::timestamptz, '2026-11-12T15:00:00+07:00'::timestamptz),
              ('IT', $2::uuid, $3::date, null, true, 'Afternoon IT approver', '2026-11-12T15:00:00+07:00'::timestamptz, '2026-11-12T15:00:00+07:00'::timestamptz)`,
      [tl1, tl2, TODAY]
    );
    const lmgId = makeUuid("b0000099", 1);
    await db.query(
      `insert into public.leave_module_grants (grant_id, app_user_id, role_code, valid_from, valid_to, is_current, reason, created_at, updated_at)
       values ($1::uuid, $2::uuid, 'HR_LEAVE_OPERATOR', $3::date, $4::date, false, 'Same-day grant+revoke', '2026-11-12T08:00:00+07:00'::timestamptz, '2026-11-12T15:00:00+07:00'::timestamptz)`,
      [lmgId, leaveOp, TODAY, TOMORROW]
    );
    await db.query(
      `insert into public.leave_audit_events (event_type, actor_app_user_id, target_app_user_id, reason, payload, created_at)
       values ('MODULE_GRANT_REVOKE', $1::uuid, $2::uuid, 'Same-day revoke', jsonb_build_object('grant_id', $3::text), '2026-11-12T15:00:00+07:00'::timestamptz)`,
      [grantor, leaveOp, lmgId]
    );

    // 5) Same-day ACCOUNTING dept + VFin Project Accountant & Global Role (`08:00` -> `15:00`, `valid_to = TODAY`)
    const acctDeptId = await getDepartmentId(db, "ACCOUNTING");
    await db.query(`SELECT set_config('org_department.membership_cancel_marker', 'on', false)`);
    await db.query(
      `insert into public.organization_department_memberships (department_id, app_user_id, valid_from, valid_to, version, granted_by_user_id, grant_reason, revoked_by_user_id, revoke_reason, created_at, revoked_at)
       values ($1::uuid, $2::uuid, $3::date, $3::date, 1, $4::uuid, 'Same-day acct', $4::uuid, 'Same-day revoke acct', '2026-11-12T08:00:00+07:00'::timestamptz, '2026-11-12T15:00:00+07:00'::timestamptz)`,
      [acctDeptId, acctUser, TODAY, grantor]
    );
    await db.query(`SELECT set_config('vendor_finance.admin_write_marker', 'on', false)`);
    await db.query(
      `insert into public.vendor_finance_project_accountants (project_id, accountant_user_id, version, valid_from, valid_to, assigned_by_user_id, assign_reason, ended_by_user_id, end_reason, created_at, ended_at)
       values ('PROJ_11A', $1::uuid, 1, $2::date, $2::date, $3::uuid, 'Same-day PA', $3::uuid, 'Same-day revoke PA', '2026-11-12T08:00:00+07:00'::timestamptz, '2026-11-12T15:00:00+07:00'::timestamptz)`,
      [acctUser, TODAY, grantor]
    );
    await db.query(
      `insert into public.vendor_finance_global_roles (app_user_id, role_code, version, valid_from, valid_to, granted_by_user_id, grant_reason, ended_by_user_id, end_reason, created_at, ended_at)
       values ($1::uuid, 'GLOBAL_VIEWER', 1, $2::date, $2::date, $3::uuid, 'Same-day VFin', $3::uuid, 'Same-day revoke VFin', '2026-11-12T08:00:00+07:00'::timestamptz, '2026-11-12T15:00:00+07:00'::timestamptz)`,
      [acctUser, TODAY, grantor]
    );
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_own', $2::date, true)`,
      [pmPrior, PAST_DATE]
    );

    const T_BEFORE_START = "2026-11-12T07:59:59+07:00";
    const T_MORNING = "2026-11-12T09:00:00+07:00";
    const T_EXACT_REVOKE = "2026-11-12T15:00:00+07:00";
    const T_AFTER_REVOKE = "2026-11-12T16:00:00+07:00";

    // At 07:59: pmPrior active; same-day grants NOT active yet
    assert.ok((await getCandidate(db, T_BEFORE_START, pmPrior)).some((r) => r.action_code === "assignment:project_manager"));
    assert.ok(!(await getCandidate(db, T_BEFORE_START, pmSameDay)).some((r) => r.action_code === "assignment:project_manager"));
    assert.ok(!(await getCandidate(db, T_BEFORE_START, leaveOp)).some((r) => r.action_code === "leave_role:HR_LEAVE_OPERATOR"));

    // At 09:00: pmPrior, pmSameDay, tl1, leaveOp, acctUser ALL active! pmNext & tl2 ABSENT!
    const pmPriorMorning = await getCandidate(db, T_MORNING, pmPrior);
    assert.ok(pmPriorMorning.some((r) => r.action_code === "assignment:project_manager" && r.scope_ref === "PROJ_11A"));
    assert.ok(pmPriorMorning.some((r) => r.action_code === "op:vendor_finance:pm_project_view" && r.scope_ref === "PROJ_11A"));
    assert.ok(pmPriorMorning.some((r) => r.action_code === "op:salary_advance:pm_request" && r.scope_ref === "PROJ_11A"));
    assert.ok(pmPriorMorning.some((r) => r.action_code === "op:recruitment_posts:pm_manage_project" && r.scope_ref === "PROJ_11A"));
    // Date-only capability on past as_of_ts MUST disclose LIMITATION_DATE_GRANULARITY_ONLY (never POINT_IN_TIME_CURRENT)
    const capRowMorning = pmPriorMorning.find((r) => r.action_code === "cap:entry_own");
    assert.ok(capRowMorning.reconstructibility.includes("LIMITATION_DATE_GRANULARITY_ONLY"));
    assert.ok(!pmPriorMorning.some((r) => r.reconstructibility === "POINT_IN_TIME_CURRENT"));

    // Diff for pmPrior at 09:00 explains intra-day historical reconstruction cleanly without UNEXPECTED_*
    const pmPriorMorningDiff = await getDiff(db, T_MORNING, pmPrior);
    assert.ok(pmPriorMorningDiff.some((r) => r.action_code === "assignment:project_manager" && r.diff_classification === "EXPECTED_FIX_HISTORICAL_INTRADAY_RECONSTRUCTED"));
    assert.ok(!pmPriorMorningDiff.some((r) => r.diff_classification.startsWith("UNEXPECTED_")));

    assert.ok((await getCandidate(db, T_MORNING, pmSameDay)).some((r) => r.action_code === "assignment:project_manager" && r.scope_ref === "PROJ_11B"));
    assert.ok(!(await getCandidate(db, T_MORNING, pmNext)).some((r) => r.action_code === "assignment:project_manager"));

    const tl1Morning = await getCandidate(db, T_MORNING, tl1);
    assert.ok(tl1Morning.some((r) => r.action_code === "assignment:team_leader" && r.scope_ref === teamH));
    assert.ok(tl1Morning.some((r) => r.action_code === "assignment:team_leader" && r.scope_ref === teamCancel));
    assert.ok(tl1Morning.some((r) => r.action_code === "department_approver:IT"));
    const tl2Morning = await getCandidate(db, T_MORNING, tl2);
    assert.ok(!tl2Morning.some((r) => r.action_code === "assignment:team_leader"));
    assert.ok(!tl2Morning.some((r) => r.action_code === "department_approver:IT"));
    const tl2MorningDiff = await getDiff(db, T_MORNING, tl2);
    assert.ok(tl2MorningDiff.some((r) => r.action_code === "assignment:team_leader" && r.scope_ref === teamH && r.diff_classification === "EXPECTED_FIX_HISTORICAL_INTRADAY_CREATED_AFTER_ASOF"));
    assert.ok(!tl2MorningDiff.some((r) => r.diff_classification.startsWith("UNEXPECTED_")));

    assert.ok((await getCandidate(db, T_MORNING, leaveOp)).some((r) => r.action_code === "leave_role:HR_LEAVE_OPERATOR"));
    const acctMorning = await getCandidate(db, T_MORNING, acctUser);
    assert.ok(acctMorning.some((r) => r.action_code === "dept_member:ACCOUNTING"));
    assert.ok(acctMorning.some((r) => r.action_code === "op:vendor_finance:project_ledger_operate" && r.scope_ref === "PROJ_11A"));
    assert.ok(acctMorning.some((r) => r.action_code === "vfin_role:GLOBAL_VIEWER"));

    // At 15:00 exact and 16:00: revoked rows gone; handover targets active; cancelled future replacement on teamCancel stays excluded!
    for (const ts of [T_EXACT_REVOKE, T_AFTER_REVOKE]) {
      assert.ok(!(await getCandidate(db, ts, pmPrior)).some((r) => r.action_code === "assignment:project_manager"));
      assert.ok(!(await getCandidate(db, ts, pmSameDay)).some((r) => r.action_code === "assignment:project_manager"));
      assert.ok((await getCandidate(db, ts, pmNext)).some((r) => r.action_code === "assignment:project_manager" && r.scope_ref === "PROJ_11A"));
      assert.ok(!(await getCandidate(db, ts, tl1)).some((r) => r.action_code === "assignment:team_leader" && r.scope_ref === teamH));
      assert.ok((await getCandidate(db, ts, tl1)).some((r) => r.action_code === "assignment:team_leader" && r.scope_ref === teamCancel));
      assert.ok(!(await getCandidate(db, ts, tl1)).some((r) => r.action_code === "department_approver:IT"));
      assert.ok((await getCandidate(db, ts, tl2)).some((r) => r.action_code === "assignment:team_leader" && r.scope_ref === teamH));
      assert.ok(!(await getCandidate(db, ts, tl2)).some((r) => r.action_code === "assignment:team_leader" && r.scope_ref === teamCancel));
      assert.ok((await getCandidate(db, ts, tl2)).some((r) => r.action_code === "department_approver:IT"));
      assert.ok(!(await getCandidate(db, ts, leaveOp)).some((r) => r.action_code === "leave_role:HR_LEAVE_OPERATOR"));
      assert.ok(!(await getCandidate(db, ts, acctUser)).some((r) => r.action_code === "op:vendor_finance:project_ledger_operate"));
    }
  } finally {
    await db.close();
  }
});

test("WP2A-12: Strict EXPECTED_FIX_* classifier refuses to mask simulated Candidate bugs", async () => {
  const db = await bootDb();
  try {
    const validAll = makeUuid("c0000001", 1);
    const validPm = makeUuid("c0000002", 2);
    const validPa = makeUuid("c0000003", 3);
    const validDel = makeUuid("c0000004", 4);
    const grantor = makeUuid("c0000005", 5);
    const invalidFbUser = makeUuid("c0000006", 6);

    const teamA = makeUuid("c0000010", 1);
    const recPm = makeUuid("c0000020", 1);
    const tplId = makeUuid("c0000030", 1);
    const verId = makeUuid("c0000031", 1);

    for (const [id, name] of [
      [validAll, "Valid All Dash"],
      [validPm, "Valid PM 1to1"],
      [validPa, "Valid PA Dept"],
      [validDel, "Valid Delegate"],
      [grantor, "Valid Grantor"],
      [invalidFbUser, "Zero-Cap Fallback Bug Target"],
    ]) {
      await createUser(db, id, name);
    }
    await createTeam(db, teamA, "TM_12A");
    await createRecruiter(db, recPm, "R12_PM");
    await linkRecruiter(db, validPm, recPm);

    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ('PROJ_12A', 'Project 12A', true, 1)`
    );
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'report_view', $3::date, true),
              ($1::uuid, 'report_analytics_view', $3::date, true),
              ($2::uuid, 'entry_admin', $3::date, true),
              ($2::uuid, 'recruiter_master_manage', $3::date, true),
              ($2::uuid, 'team_master_manage', $3::date, true),
              ($4::uuid, 'entry_own', $3::date, true),
              ($5::uuid, 'report_view', $3::date, true)`,
      [validAll, grantor, PAST_DATE, validPm, validDel]
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'all', null, $4::date, true),
              ($2::uuid, 'all', null, $4::date, true),
              ($3::uuid, 'team', $5::uuid, $4::date, true)`,
      [validAll, grantor, validDel, PAST_DATE, teamA]
    );
    await db.query(
      `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current, version)
       values ('PROJ_12A', $1::uuid, $2::date, true, 1)`,
      [recPm, PAST_DATE]
    );
    const acctDeptId = await getDepartmentId(db, "ACCOUNTING");
    await db.query(
      `insert into public.organization_department_memberships (department_id, app_user_id, valid_from, version, granted_by_user_id, grant_reason)
       values ($1::uuid, $2::uuid, $3::date, 1, $4::uuid, 'Valid PA dept')`,
      [acctDeptId, validPa, PAST_DATE, grantor]
    );
    await db.query(`SELECT set_config('vendor_finance.admin_write_marker', 'on', false)`);
    await db.query(
      `insert into public.vendor_finance_project_accountants (project_id, accountant_user_id, version, valid_from, assigned_by_user_id, assign_reason)
       values ('PROJ_12A', $1::uuid, 1, $2::date, $3::uuid, 'Valid PA')`,
      [validPa, PAST_DATE, grantor]
    );
    await seedTemplate(db, { templateId: tplId, versionId: verId, grantorId: grantor });
    await db.query(
      `insert into public.work_report_delegations
         (grantor_user_id, delegate_app_user_id, capability, template_id, template_version_id, scope_kind, scope_team_id, effective_from, effective_to, state, is_current, version)
       values ($1::uuid, $2::uuid, 'report_review', $3::uuid, $4::uuid, 'team', $5::uuid, '2026-10-01T00:00:00Z'::timestamptz, null, 'ACTIVE', true, 1)`,
      [grantor, validDel, tplId, verId, teamA]
    );
    // invalidFbUser holds scope='all' + scope='team' with ZERO capabilities
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'all', null, $2::date, true),
              ($1::uuid, 'team', $3::uuid, $2::date, true)`,
      [invalidFbUser, PAST_DATE, teamA]
    );

    assert.equal((await getDiff(db, AS_OF_TODAY_TS, validAll)).length, 0);
    assert.equal((await getDiff(db, AS_OF_TODAY_TS, validPm)).length, 0);
    assert.equal((await getDiff(db, AS_OF_TODAY_TS, validPa)).length, 0);
    assert.equal((await getDiff(db, AS_OF_TODAY_TS, validDel)).length, 0);

    // Simulate Candidate bugs inside a rolled-back transaction:
    // 1) Drop ALL rows for validAll, validPm, validPa, validDel
    // 2) Inject an invalid Dashboard @ team fallback row for zero-cap invalidFbUser
    await db.query("BEGIN");
    try {
      await db.query(`
        create or replace function public.direct_entry_authz_resolve_candidate_access(
          p_as_of_ts timestamptz default pg_catalog.transaction_timestamp(),
          p_app_user_id uuid default null
        )
        returns table (
          as_of_ts timestamptz, as_of_date date, app_user_id uuid, user_created_date date,
          row_layer text, module_code text, action_code text, scope_kind text,
          scope_ref text, grant_source text, valid_from text, valid_to text, reconstructibility text
        )
        language sql stable security definer set search_path = pg_catalog, public
        as $bug$
          select
            coalesce(p_as_of_ts, pg_catalog.transaction_timestamp()),
            (coalesce(p_as_of_ts, pg_catalog.transaction_timestamp()) at time zone 'Asia/Ho_Chi_Minh')::date,
            '${invalidFbUser}'::uuid,
            '2026-01-01'::date,
            'MODULE_OP'::text,
            'dashboard'::text,
            'op:dashboard:view_general'::text,
            'team'::text,
            '${teamA}'::text,
            'simulated:bug_fallback'::text,
            '2026-10-01'::text,
            'infinity'::text,
            'POINT_IN_TIME_CURRENT'::text
          where p_app_user_id is null or p_app_user_id = '${invalidFbUser}'::uuid;
        $bug$;
      `);

      const simDiff = (await db.query(
        `select * from public.direct_entry_authz_compare_shadow_access($1::timestamptz, null)`,
        [AS_OF_TODAY_TS]
      )).rows;

      for (const uid of [validAll, validPm, validPa, validDel]) {
        const userDiffs = simDiff.filter((r) => r.app_user_id === uid);
        assert.ok(userDiffs.length > 0, `Simulated drop must emit diffs for ${uid}`);
        assert.ok(
          userDiffs.every((r) => r.diff_classification === "UNEXPECTED_REGRESSION_CHECK_REQUIRED"),
          `Simulated bug for ${uid} was masked as EXPECTED_FIX_*: ${JSON.stringify(userDiffs)}`
        );
      }

      const fbGainDiff = simDiff.filter(
        (r) => r.app_user_id === invalidFbUser && r.diff_status === "GAINED_IN_CANDIDATE" && r.action_code === "op:dashboard:view_general"
      );
      assert.equal(fbGainDiff.length, 1);
      assert.equal(
        fbGainDiff[0].diff_classification,
        "UNEXPECTED_WIDENING_CHECK_REQUIRED",
        "Fabricated fallback for zero-cap user must NOT be classified as EXPECTED_FIX_DASHBOARD_FALLBACK_AFTER_INVALID_ALL_SCOPE"
      );
    } finally {
      await db.query("ROLLBACK");
    }
  } finally {
    await db.close();
  }
});
