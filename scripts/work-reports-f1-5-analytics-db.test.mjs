/**
 * F1.5-WP1 Work Reports Analytics — Scoped SQL Aggregation, Breakdown, Contributions,
 * Source Evidence & Metric Projection Reconciliation Suite.
 *
 * Verifies against PGlite (all migrations through `20261021230000_f1_5_full_admin_report_read_closure.sql`):
 *   - `SEC-WR-12`: Forced RLS, zero client table/function privileges, exact `service_role` allowlist
 *   - `AG-01`, `AG-02`, `AG-03`, `AG-15`: `due_count`, `completed_count`, `on_time_count`, `late_submitted_count`,
 *     `pending_due_count` vs `overdue_missing_count` across `due_at` and `Asia/Ho_Chi_Minh` (`+07:00`) midnight
 *   - `AG-04`, `AG-05`: Null vs Zero vs Missing (`numeric_value = 0` included in `AVG`; `NULL` counted in `missing_value_count`)
 *   - `AG-06`: Weighted group ratio `SUM(numerator)/SUM(denominator)` (never `AVG(row_ratio)`)
 *   - `AG-07`, `AG-18`: Cross-version compatibility by `(metric_key, unit, compatible_group)` — compatible versions sum together;
 *     incompatible unit/compatible_group separated with version label
 *   - `AG-08`, `AG-09`, `SEC-WR-01`..`03`, `SEC-WR-06`..`08`: `snapshot_team_id` immutability across team transfer,
 *     scoped Team Leader vs BoD (`all`) vs Form Admin without `report_analytics_view`/`report_view`,
 *     out-of-scope `team_id`/`assignee_id` rejection (`42501 WORK_REPORT_SCOPE_DENIED`), immediate revocation & disable denial
 *   - `AG-11`, `AG-12`, `AG-16`: Revision history deduplication (`is_eligible = true and is_final = true`),
 *     drill-down reconciliation (`SUM(contributions.metric_contribution_value) === overview.sum_value` and `length === count_valid`),
 *     source evidence lookup by `submission_id` and `obligation_id`, and `work_report_reconcile_metric_projection` tamper detection
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const TEAM_A = "95000000-0000-4000-8000-00000000f15a";
const TEAM_B = "95000000-0000-4000-8000-00000000f15b";

const BOD_ADMIN = {
  auth: "15000000-0000-4000-8000-000000000001",
  app: "25000000-0000-4000-8000-000000000001",
  name: "BoD All Scope",
};
const FULL_ADMIN_IMPLICIT = {
  auth: "15000000-0000-4000-8000-000000000010",
  app: "25000000-0000-4000-8000-000000000010",
  name: "Canonical Full Admin Without Report Tokens",
};
const FORM_ADMIN_ONLY = {
  auth: "15000000-0000-4000-8000-000000000002",
  app: "25000000-0000-4000-8000-000000000002",
  name: "Form Admin Without Report View",
};
const ANALYTICS_ONLY_USER = {
  auth: "15000000-0000-4000-8000-000000000003",
  app: "25000000-0000-4000-8000-000000000003",
  name: "Analytics Without Report View",
};
const LEADER_A = {
  auth: "15000000-0000-4000-8000-000000000004",
  app: "25000000-0000-4000-8000-000000000004",
  recruiter: "35000000-0000-4000-8000-000000000004",
  name: "Team Leader A",
};
const LEADER_B = {
  auth: "15000000-0000-4000-8000-000000000005",
  app: "25000000-0000-4000-8000-000000000005",
  recruiter: "35000000-0000-4000-8000-000000000005",
  name: "Team Leader B",
};
const STAFF_A1 = {
  auth: "15000000-0000-4000-8000-000000000006",
  app: "25000000-0000-4000-8000-000000000006",
  recruiter: "35000000-0000-4000-8000-000000000006",
  name: "Staff A1",
};
const STAFF_A2 = {
  auth: "15000000-0000-4000-8000-000000000007",
  app: "25000000-0000-4000-8000-000000000007",
  recruiter: "35000000-0000-4000-8000-000000000007",
  name: "Staff A2",
};
const STAFF_A3 = {
  auth: "15000000-0000-4000-8000-000000000008",
  app: "25000000-0000-4000-8000-000000000008",
  recruiter: "35000000-0000-4000-8000-000000000008",
  name: "Staff A3",
};
const STAFF_B1 = {
  auth: "15000000-0000-4000-8000-000000000009",
  app: "25000000-0000-4000-8000-000000000009",
  recruiter: "35000000-0000-4000-8000-000000000009",
  name: "Staff B1",
};

let seq = 0;
const KEY = (prefix) => `f15_${prefix}_${++seq}`;

async function createDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

async function seedActorsAndTeams(db) {
  await db.query(
    `insert into public.teams (team_id, code, display_name, active)
     values ($1::uuid, 'WR15_TEAM_A', 'Nhóm Tuyển Dụng A', true),
            ($2::uuid, 'WR15_TEAM_B', 'Nhóm Tuyển Dụng B', true)`,
    [TEAM_A, TEAM_B],
  );

  for (const actor of [
    BOD_ADMIN,
    FULL_ADMIN_IMPLICIT,
    FORM_ADMIN_ONLY,
    ANALYTICS_ONLY_USER,
    LEADER_A,
    LEADER_B,
    STAFF_A1,
    STAFF_A2,
    STAFF_A3,
    STAFF_B1,
  ]) {
    await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
       values ($1::uuid, $2::uuid, $3, true)`,
      [actor.app, actor.auth, actor.name],
    );
  }

  // BOD_ADMIN has full capabilities + all scope
  for (const cap of [
    "entry_admin",
    "team_master_manage",
    "recruiter_master_manage",
    "catalog_master_manage",
    "report_form_manage",
    "report_assign",
    "report_view",
    "report_analytics_view",
  ]) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [BOD_ADMIN.app, cap],
    );
  }
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1::uuid, 'all', '2026-01-01', true)`,
    [BOD_ADMIN.app],
  );

  // Canonical Full Admin inherits every current Work Reports action without separate report tokens.
  for (const cap of ["entry_admin", "team_master_manage", "recruiter_master_manage"]) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [FULL_ADMIN_IMPLICIT.app, cap],
    );
  }
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1::uuid, 'all', '2026-01-01', true)`,
    [FULL_ADMIN_IMPLICIT.app],
  );

  // FORM_ADMIN_ONLY has entry_admin + report_form_manage @ all, but NO report_view or report_analytics_view (SEC-WR-03)
  for (const cap of ["entry_admin", "report_form_manage"]) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [FORM_ADMIN_ONLY.app, cap],
    );
  }
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1::uuid, 'all', '2026-01-01', true)`,
    [FORM_ADMIN_ONLY.app],
  );

  // ANALYTICS_ONLY_USER has report_analytics_view @ all, but NO report_view
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
     values ($1::uuid, 'report_analytics_view', '2026-01-01', true)`,
    [ANALYTICS_ONLY_USER.app],
  );
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1::uuid, 'all', '2026-01-01', true)`,
    [ANALYTICS_ONLY_USER.app],
  );

  for (const [person, teamId, code] of [
    [LEADER_A, TEAM_A, "NV_F15_LA"],
    [LEADER_B, TEAM_B, "NV_F15_LB"],
    [STAFF_A1, TEAM_A, "NV_F15_A1"],
    [STAFF_A2, TEAM_A, "NV_F15_A2"],
    [STAFF_A3, TEAM_A, "NV_F15_A3"],
    [STAFF_B1, TEAM_B, "NV_F15_B1"],
  ]) {
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, $3, 'STAFF', true)`,
      [person.recruiter, person.name, code],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2026-01-01', true)`,
      [person.recruiter],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, '2026-01-01', true)`,
      [person.recruiter, teamId],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
      [person.app, person.recruiter],
    );
  }

  // Designate LEADER_A on TEAM_A and LEADER_B on TEAM_B via canonical RPC
  await db.query(
    `select public.direct_entry_designate_team_leader(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, null::date, 1, 'Designate Leader A', $5
     )`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, TEAM_A, LEADER_A.app, KEY("desig_la")],
  );
  await db.query(
    `select public.direct_entry_designate_team_leader(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, null::date, 1, 'Designate Leader B', $5
     )`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, TEAM_B, LEADER_B.app, KEY("desig_lb")],
  );
}

const db = await createDatabase();
await seedActorsAndTeams(db);

test("SEC-WR-12: F1.5 analytics RPCs are granted only to service_role while internal helper is revoked from all roles", async () => {
  const rpcNames = [
    "work_report_analytics_overview",
    "work_report_analytics_breakdown",
    "work_report_analytics_contributions",
    "work_report_reconcile_metric_projection",
    "work_report__internal_resolve_analytics_scope",
  ];
  const { rows } = await db.query(
    `select p.proname,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
            has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = any($1::text[])
      order by p.proname`,
    [rpcNames],
  );
  assert.equal(rows.length, rpcNames.length);
  for (const row of rows) {
    assert.equal(row.anon_exec, false, `${row.proname} anon execute`);
    assert.equal(row.auth_exec, false, `${row.proname} authenticated execute`);
    if (row.proname === "work_report__internal_resolve_analytics_scope") {
      assert.equal(row.service_exec, false, "internal helper must not be executable by service_role");
    } else {
      assert.equal(row.service_exec, true, `${row.proname} must be executable by service_role`);
    }
  }
});

test("AG-01, AG-02, AG-03, AG-15: compliance due/completed/on-time/late/pending/overdue counts and completion_rate across deadline boundary", async () => {
  const metricContract = buildWorkReportMetricContract(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  const { rows: tplCreated } = await db.query(
    `select public.work_report_create_template(
       $1::uuid, $2::uuid, 'RECRUITMENT_COMPLIANCE_V1', 'Báo cáo tuân thủ ngày',
       null, 'DAILY', $3::jsonb, $4::jsonb, $5
     ) as result`,
    [
      BOD_ADMIN.auth,
      BOD_ADMIN.app,
      JSON.stringify(RECRUITMENT_DAILY_TEMPLATE_SCHEMA),
      JSON.stringify(metricContract),
      KEY("tpl_comp_create"),
    ],
  );
  const templateId = tplCreated[0].result.template_id;
  const versionId = tplCreated[0].result.draft_version_id;
  await db.query(
    `select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5)`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, versionId, KEY("tpl_comp_pub")],
  );

  const { rows: assignCreated } = await db.query(
    `select public.work_report_create_assignment(
       $1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null,
       'DAILY', true, 1, '23:59:59'::time, false, '2026-10-01'::date, null, $5
     ) as result`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, TEAM_A, KEY("assign_comp")],
  );
  const assignmentId = assignCreated[0].result.assignment_id;

  // Seed 20 active obligations + 1 exempted obligation for 2026-10-20 (due 2026-10-21 23:59:59+07 = 2026-10-21T16:59:59Z)
  // 18 completed: 15 on-time (<= due_at), 3 late (> due_at), 2 unsubmitted
  const dueAt = "2026-10-21T16:59:59Z";
  for (let i = 1; i <= 21; i++) {
    const authId = `16000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const appId = `26000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const obId = `76000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    await db.query("insert into auth.users (id) values ($1::uuid)", [authId]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
       values ($1::uuid, $2::uuid, $3, true)`,
      [appId, authId, `Member ${i}`],
    );
    const status = i === 21 ? "EXEMPTED" : "ACTIVE";
    await db.query(
      `insert into public.work_report_obligations
         (obligation_id, template_id, template_version_id, assignment_id, assignee_app_user_id,
          snapshot_team_id, snapshot_team_code, snapshot_team_display_name,
          period_type, period_key, period_start_date, period_end_date, due_at, is_mandatory, obligation_status)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               $6::uuid, 'WR15_TEAM_A', 'Nhóm Tuyển Dụng A',
               'DAILY', '2026-10-20', '2026-10-20'::date, '2026-10-20'::date, $7::timestamptz, true, $8)`,
      [obId, templateId, versionId, assignmentId, appId, TEAM_A, dueAt, status],
    );

    if (i <= 18) {
      const subId = `86000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const revId = `96000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
      const isLate = i > 15;
      const submittedAt = isLate ? "2026-10-21T17:00:00Z" : "2026-10-21T16:59:59Z";
      const payload = { calls_made: 10, interested_candidates: 2, workers_started: 1 };
      await db.query(
        `insert into public.work_report_submissions
           (submission_id, obligation_id, template_id, template_version_id, assignee_app_user_id,
            submitted_by_user_id, submitted_team_id, state, draft_payload_json,
            first_submitted_at, latest_submitted_at, is_late)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $5::uuid, $6::uuid, 'COMPLETED', $7::jsonb,
                 $8::timestamptz, $8::timestamptz, $9)`,
        [subId, obId, templateId, versionId, appId, TEAM_A, JSON.stringify(payload), submittedAt, isLate],
      );
      await db.query(
        `insert into public.work_report_submission_revisions
           (revision_id, submission_id, obligation_id, template_version_id, revision_no,
            payload_json, payload_checksum, created_by_user_id, created_at)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1,
                 $5::jsonb, repeat('a', 64), $6::uuid, $7::timestamptz)`,
        [revId, subId, obId, versionId, JSON.stringify(payload), appId, submittedAt],
      );
      await db.query(
        `update public.work_report_submissions set current_revision_id = $1::uuid where submission_id = $2::uuid`,
        [revId, subId],
      );
      for (const [key, unit, val] of [
        ["calls_made", "cuộc", 10],
        ["interested_candidates", "người", 2],
        ["workers_started", "người", 1],
      ]) {
        await db.query(
          `insert into public.work_report_metric_values
             (submission_id, revision_id, obligation_id, template_id, template_version_id,
              assignee_app_user_id, snapshot_team_id, period_type, period_key,
              period_start_date, period_end_date, field_key, metric_key, compatible_group,
              value_type, unit, numeric_value, is_current_revision, is_provisional, is_final, is_eligible)
           values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   $6::uuid, $7::uuid, 'DAILY', '2026-10-20',
                   '2026-10-20'::date, '2026-10-20'::date, $8, $8, $9,
                   'INTEGER', $10, $11, true, false, true, true)`,
          [subId, revId, obId, templateId, versionId, appId, TEAM_A, key, `recruitment_daily_${key}_v1`, unit, val],
        );
      }
    }
  }

  // AG-03 & AG-15: When due_at on the 2 unsubmitted obligations is ahead of DB statement_timestamp(), they are pending_due, NOT overdue
  await db.query(
    `update public.work_report_obligations
        set due_at = statement_timestamp() + interval '1 hour'
      where template_id = $1::uuid
        and obligation_id in ('76000000-0000-4000-8000-000000000019', '76000000-0000-4000-8000-000000000020')`,
    [templateId],
  );
  const { rows: beforeDeadlineRows } = await db.query(
    `select public.work_report_analytics_overview(
       $1::uuid, $2::uuid, $3::uuid, null, '2026-10-20'::date, '2026-10-20'::date,
       $4::uuid, null, 'final'
     ) as result`,
    [LEADER_A.auth, LEADER_A.app, templateId, TEAM_A],
  );
  assert.equal(typeof beforeDeadlineRows[0].result.as_of, "string");
  assert.equal(Number.isNaN(Date.parse(beforeDeadlineRows[0].result.as_of)), false);
  assert.deepEqual(beforeDeadlineRows[0].result.compliance, {
    due_count: 20,
    completed_count: 18,
    on_time_count: 15,
    late_submitted_count: 3,
    pending_due_count: 2,
    overdue_missing_count: 0,
    exempted_count: 1,
    pending_review_count: 0,
    completion_rate: 90,
  });

  // AG-01, AG-02 & AG-15: Once due_at is behind DB statement_timestamp(), the 2 unsubmitted become overdue_missing
  await db.query(
    `update public.work_report_obligations
        set due_at = statement_timestamp() - interval '1 second'
      where template_id = $1::uuid
        and obligation_id in ('76000000-0000-4000-8000-000000000019', '76000000-0000-4000-8000-000000000020')`,
    [templateId],
  );
  const { rows: afterDeadlineRows } = await db.query(
    `select public.work_report_analytics_overview(
       $1::uuid, $2::uuid, $3::uuid, null, '2026-10-20'::date, '2026-10-20'::date,
       $4::uuid, null, 'final'
     ) as result`,
    [LEADER_A.auth, LEADER_A.app, templateId, TEAM_A],
  );
  assert.equal(typeof afterDeadlineRows[0].result.as_of, "string");
  assert.equal(Number.isNaN(Date.parse(afterDeadlineRows[0].result.as_of)), false);
  assert.deepEqual(afterDeadlineRows[0].result.compliance, {
    due_count: 20,
    completed_count: 18,
    on_time_count: 15,
    late_submitted_count: 3,
    pending_due_count: 0,
    overdue_missing_count: 2,
    exempted_count: 1,
    pending_review_count: 0,
    completion_rate: 90,
  });
});

test("AG-04, AG-05, AG-06, AG-07, AG-08, AG-09, AG-11, AG-16, AG-17 & SEC-WR matrix: end-to-end analytics, breakdown, contributions, source evidence & reconciliation", async () => {
  // Create Mẫu #1 where workers_started is optional (required = false) so we can test AG-04 (null vs 0 vs missing)
  // alongside AG-05 (0 included in AVG) and AG-06 (weighted ratio 10/40 = 25.00%)
  const v1Schema = structuredClone(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  const workersField = v1Schema.sections[0].fields.find((f) => f.field_key === "workers_started");
  workersField.required = false;
  workersField.default_value = null;
  const v1Contract = buildWorkReportMetricContract(v1Schema);

  const { rows: createdRows } = await db.query(
    `select public.work_report_create_template(
       $1::uuid, $2::uuid, 'RECRUITMENT_DAILY_ANALYTICS', 'Báo cáo công việc tuyển dụng ngày',
       'Mẫu #1 kiểm thử F1.5', 'DAILY', $3::jsonb, $4::jsonb, $5
     ) as result`,
    [
      BOD_ADMIN.auth,
      BOD_ADMIN.app,
      JSON.stringify(v1Schema),
      JSON.stringify(v1Contract),
      KEY("tpl_main_create"),
    ],
  );
  const templateId = createdRows[0].result.template_id;
  const v1Id = createdRows[0].result.draft_version_id;

  await db.query(
    `select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5)`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, v1Id, KEY("tpl_main_pub_v1")],
  );

  // Assign TEAM_A (STAFF_A1, STAFF_A2, STAFF_A3, LEADER_A) and TEAM_B (STAFF_B1, LEADER_B)
  await db.query(
    `select public.work_report_create_assignment(
       $1::uuid, $2::uuid, $3::uuid, 'USER_SET', null, null, $4::uuid[],
       'DAILY', true, 5, '23:59:59'::time, false, '2026-01-01'::date, null, $5
     )`,
    [
      LEADER_A.auth,
      LEADER_A.app,
      templateId,
      [STAFF_A1.app, STAFF_A2.app, STAFF_A3.app, LEADER_A.app],
      KEY("assign_team_a"),
    ],
  );
  await db.query(
    `select public.work_report_create_assignment(
       $1::uuid, $2::uuid, $3::uuid, 'USER', $4::uuid, null, null,
       'DAILY', true, 5, '23:59:59'::time, false, '2026-01-01'::date, null, $5
     )`,
    [LEADER_B.auth, LEADER_B.app, templateId, STAFF_B1.app, KEY("assign_team_b")],
  );

  // Materialize Period 1: 2099-10-20 (future due_at so staff can submit directly)
  const period1 = "2099-10-20";
  await db.query(
    `select public.work_report_ensure_obligations_for_window($1::uuid, $2::uuid, $3::date)`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, period1],
  );

  const getObId = async (actor, periodKey) => {
    const { rows } = await db.query(
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as result",
      [actor.auth, actor.app],
    );
    return rows[0].result.items.find((o) => o.template_id === templateId && o.period_key === periodKey).obligation_id;
  };

  const obA1_p1 = await getObId(STAFF_A1, period1);
  const obA2_p1 = await getObId(STAFF_A2, period1);
  const obA3_p1 = await getObId(STAFF_A3, period1);
  const obB1_p1 = await getObId(STAFF_B1, period1);

  // AG-11: STAFF_A1 submits revision 1 (calls=999), then resubmits revision 2 (calls=2, interested=1, workers_started=0)
  // Revision 1 must NOT be counted; only Revision 2 is eligible!
  await db.query(
    `select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)`,
    [
      STAFF_A1.auth,
      STAFF_A1.app,
      obA1_p1,
      JSON.stringify({ calls_made: 999, interested_candidates: 99, workers_started: 99 }),
      KEY("sub_a1_r1"),
    ],
  );
  const { rows: subA1Rev2 } = await db.query(
    `select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, 2, $5) as result`,
    [
      STAFF_A1.auth,
      STAFF_A1.app,
      obA1_p1,
      JSON.stringify({ calls_made: 2, interested_candidates: 1, workers_started: 0 }),
      KEY("sub_a1_r2"),
    ],
  );
  const submissionA1Id = subA1Rev2[0].result.submission_id;

  // STAFF_A2 submits (calls=18, interested=9, workers_started=10)
  await db.query(
    `select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)`,
    [
      STAFF_A2.auth,
      STAFF_A2.app,
      obA2_p1,
      JSON.stringify({ calls_made: 18, interested_candidates: 9, workers_started: 10 }),
      KEY("sub_a2_r1"),
    ],
  );

  // STAFF_A3 submits (calls=20, interested=0, workers_started=null) -> leaves optional workers_started blank!
  // LEADER_A does not submit (4th person in Team A is MISSING)
  await db.query(
    `select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)`,
    [
      STAFF_A3.auth,
      STAFF_A3.app,
      obA3_p1,
      JSON.stringify({ calls_made: 20, interested_candidates: 0, workers_started: null }),
      KEY("sub_a3_r1"),
    ],
  );

  // STAFF_B1 in Team B submits (calls=50, interested=25, workers_started=5)
  const { rows: subB1Rows } = await db.query(
    `select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5) as result`,
    [
      STAFF_B1.auth,
      STAFF_B1.app,
      obB1_p1,
      JSON.stringify({ calls_made: 50, interested_candidates: 25, workers_started: 5 }),
      KEY("sub_b1_r1"),
    ],
  );
  const submissionB1Id = subB1Rows[0].result.submission_id;

  // Verify Team A overview via LEADER_A:
  // - due_count = 4, completed_count = 3, pending_due_count = 1
  // - calls_made: 2 + 18 + 20 = 40, count_valid = 3, avg_value = 13.33, missing_value_count = 0
  // - interested_candidates (AG-05 with 0): 1 + 9 + 0 = 10, count_valid = 3, avg_value = 3.33, missing_value_count = 0
  // - workers_started (AG-04 with 0, 10, null, and 1 unsubmitted): sum = 10, count_valid = 2, avg = 5, missing_value_count = 1
  // - interested_per_call_rate (AG-06 weighted ratio): 10 / 40 * 100 = 25 (NOT average of 50%, 50%, 0% = 33.33%)
  const { rows: teamAOverviewRows } = await db.query(
    `select public.work_report_analytics_overview(
       $1::uuid, $2::uuid, $3::uuid, null, $4::date, $4::date, null, null, 'final'
     ) as result`,
    [LEADER_A.auth, LEADER_A.app, templateId, period1],
  );
  const teamAOverview = teamAOverviewRows[0].result;
  assert.equal(typeof teamAOverview.as_of, "string");
  assert.equal(Number.isNaN(Date.parse(teamAOverview.as_of)), false);
  assert.deepEqual(teamAOverview.effective_scope, {
    kind: "team",
    label: "Nhóm Tuyển Dụng A",
  });
  assert.equal(teamAOverview.compliance.due_count, 4);
  assert.equal(teamAOverview.compliance.completed_count, 3);
  assert.equal(teamAOverview.compliance.completion_rate, 75);

  const callsMetric = teamAOverview.metrics.find((m) => m.metric_key === "calls_made");
  assert.deepEqual(callsMetric, {
    metric_key: "calls_made",
    label: "Số cuộc gọi",
    unit: "cuộc",
    compatible_group: "recruitment_daily_calls_made_v1",
    sum_value: 40,
    avg_value: 13.33,
    min_value: 2,
    max_value: 20,
    count_valid: 3,
    missing_value_count: 0,
  });

  const interestedMetric = teamAOverview.metrics.find((m) => m.metric_key === "interested_candidates");
  assert.deepEqual(interestedMetric, {
    metric_key: "interested_candidates",
    label: "Ứng viên quan tâm",
    unit: "người",
    compatible_group: "recruitment_daily_interested_candidates_v1",
    sum_value: 10,
    avg_value: 3.33,
    min_value: 0,
    max_value: 9,
    count_valid: 3,
    missing_value_count: 0,
  });

  const startedMetric = teamAOverview.metrics.find((m) => m.metric_key === "workers_started");
  assert.deepEqual(startedMetric, {
    metric_key: "workers_started",
    label: "NLĐ đi làm",
    unit: "người",
    compatible_group: "recruitment_daily_workers_started_v1",
    sum_value: 10,
    avg_value: 5,
    min_value: 0,
    max_value: 10,
    count_valid: 2,
    missing_value_count: 1,
  });

  const interestedPerCall = teamAOverview.ratios.find((r) => r.ratio_key === "interested_per_call_rate");
  assert.equal(interestedPerCall.numerator_sum, 10);
  assert.equal(interestedPerCall.denominator_sum, 40);
  assert.equal(interestedPerCall.value, 25);

  // AG-16 & SEC-WR-08: Drill-down contributions for workers_started under LEADER_A
  // Must contain ONLY Team A rows with valid workers_started (STAFF_A1=0, STAFF_A2=10; excludes STAFF_A3 null, excludes Team B)
  const { rows: contribRows } = await db.query(
    `select public.work_report_analytics_contributions(
       $1::uuid, $2::uuid, $3::uuid, null, $4::date, $4::date, null, null, 'final',
       'workers_started', null, null, null, null, null, 100
     ) as result`,
    [LEADER_A.auth, LEADER_A.app, templateId, period1],
  );
  const contribItems = contribRows[0].result.items;
  assert.equal(contribItems.length, startedMetric.count_valid);
  const contribSum = contribItems.reduce((acc, item) => acc + item.metric_contribution_value, 0);
  assert.equal(contribSum, startedMetric.sum_value);
  assert.ok(contribItems.every((item) => item.snapshot_team_id === TEAM_A));

  // Source evidence via submission_id and obligation_id (SEC-WR-01)
  const { rows: evidenceBySubId } = await db.query(
    "select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid) as result",
    [LEADER_A.auth, LEADER_A.app, submissionA1Id],
  );
  assert.equal(evidenceBySubId[0].result.submission.submission_id, submissionA1Id);
  assert.equal(evidenceBySubId[0].result.revisions.length, 2);

  // SEC-WR-01: STAFF_A1 cannot read STAFF_B1's submission by submission_id or obligation_id
  await assert.rejects(
    db.query("select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid)", [
      STAFF_A1.auth,
      STAFF_A1.app,
      submissionB1Id,
    ]),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_ACCESS_DENIED"),
  );
  await assert.rejects(
    db.query("select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid)", [
      LEADER_A.auth,
      LEADER_A.app,
      submissionB1Id,
    ]),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_SCOPE_DENIED"),
  );

  // AG-07: Clone v2 (compatible label change for calls_made) -> aggregates with v1;
  // then clone v3 (incompatible unit/compatible_group for calls_made) -> separated in overview!
  const { rows: cloneV2Rows } = await db.query(
    `select public.work_report_clone_template_draft($1::uuid, $2::uuid, $3::uuid, 2, $4) as result`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, KEY("clone_v2")],
  );
  const v2Id = cloneV2Rows[0].result.draft_version_id;
  const v2Schema = structuredClone(v1Schema);
  v2Schema.sections[0].fields[0].label = "Tổng cuộc gọi (v2)";
  const v2Contract = buildWorkReportMetricContract(v2Schema);
  await db.query(
    `select public.work_report_update_template_draft(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 3,
       'Báo cáo công việc tuyển dụng ngày', 'Mẫu #1 v2', 'DAILY', $5::jsonb, $6::jsonb, $7
     )`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, v2Id, JSON.stringify(v2Schema), JSON.stringify(v2Contract), KEY("upd_v2")],
  );
  await db.query(
    `select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, 4, $5)`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, v2Id, KEY("pub_v2")],
  );

  // AG-08: Transfer STAFF_A1 from TEAM_A to TEAM_B before Period 2 (2099-10-21)
  await db.query(
    `update public.recruiter_team_memberships set is_current = false, valid_to = '2026-10-20'
      where recruiter_id = $1::uuid and is_current`,
    [STAFF_A1.recruiter],
  );
  await db.query(
    `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
     values ($1::uuid, $2::uuid, '2026-10-21', true)`,
    [STAFF_A1.recruiter, TEAM_B],
  );

  // Materialize Period 2 (2099-10-21): STAFF_A1's obligation now has snapshot_team_id = TEAM_B and uses v2
  const period2 = "2099-10-21";
  await db.query(
    `update public.work_report_assignments set template_version_id = $1::uuid where template_id = $2::uuid`,
    [v2Id, templateId],
  );
  await db.query(
    `select public.work_report_ensure_obligations_for_window($1::uuid, $2::uuid, $3::date)`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, period2],
  );

  const obA1_p2 = await getObId(STAFF_A1, period2);
  await db.query(
    `select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)`,
    [
      STAFF_A1.auth,
      STAFF_A1.app,
      obA1_p2,
      JSON.stringify({ calls_made: 15, interested_candidates: 5, workers_started: 2 }),
      KEY("sub_a1_p2"),
    ],
  );

  // AG-08 verification:
  // - In Period 1, STAFF_A1's submission belongs to TEAM_A (sum calls_made in TEAM_A = 40)
  // - In Period 2, STAFF_A1's submission belongs to TEAM_B (LEADER_A sees 0 calls_made in Period 2; LEADER_B sees 15 calls_made in Period 2)
  const { rows: leaderAP2Rows } = await db.query(
    `select public.work_report_analytics_overview(
       $1::uuid, $2::uuid, $3::uuid, null, $4::date, $4::date, null, null, 'final'
     ) as result`,
    [LEADER_A.auth, LEADER_A.app, templateId, period2],
  );
  assert.equal(leaderAP2Rows[0].result.compliance.completed_count, 0);

  const { rows: leaderBP2Rows } = await db.query(
    `select public.work_report_analytics_overview(
       $1::uuid, $2::uuid, $3::uuid, null, $4::date, $4::date, null, null, 'final'
     ) as result`,
    [LEADER_B.auth, LEADER_B.app, templateId, period2],
  );
  assert.equal(leaderBP2Rows[0].result.compliance.completed_count, 1);
  assert.equal(
    leaderBP2Rows[0].result.metrics.find((m) => m.metric_key === "calls_made").sum_value,
    15,
  );

  // AG-07 compatible versions (v1 + v2): BoD viewing across Period 1..Period 2 sees v1 (90) + v2 (15) = 105 in a single calls_made row
  const { rows: bodCombinedRows } = await db.query(
    `select public.work_report_analytics_overview(
       $1::uuid, $2::uuid, $3::uuid, null, $4::date, $5::date, null, null, 'final'
     ) as result`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, period1, period2],
  );
  const bodCalls = bodCombinedRows[0].result.metrics.filter((m) => m.metric_key === "calls_made");
  assert.equal(bodCalls.length, 1, "compatible v1 and v2 merge into 1 metric row");
  assert.equal(bodCalls[0].label, "Tổng cuộc gọi (v2)");
  assert.equal(bodCalls[0].sum_value, 105);

  // Breakdown by team, assignee, and period
  const { rows: breakdownByTeam } = await db.query(
    `select public.work_report_analytics_breakdown(
       $1::uuid, $2::uuid, $3::uuid, null, $4::date, $5::date, null, null, 'final', 'team', 1, 50
     ) as result`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, period1, period2],
  );
  assert.equal(typeof breakdownByTeam[0].result.as_of, "string");
  assert.equal(Number.isNaN(Date.parse(breakdownByTeam[0].result.as_of)), false);
  assert.equal(breakdownByTeam[0].result.items.length, 2);
  const teamABreakdown = breakdownByTeam[0].result.items.find((i) => i.group_id === TEAM_A);
  const teamBBreakdown = breakdownByTeam[0].result.items.find((i) => i.group_id === TEAM_B);
  assert.equal(teamABreakdown.metrics.find((m) => m.metric_key === "calls_made").sum_value, 40);
  assert.equal(teamBBreakdown.metrics.find((m) => m.metric_key === "calls_made").sum_value, 65);

  // AG-07 incompatible version (v3 changes unit of calls_made to 'phút' and compatible_group to 'recruitment_daily_calls_minutes_v3')
  const { rows: cloneV3Rows } = await db.query(
    `select public.work_report_clone_template_draft($1::uuid, $2::uuid, $3::uuid, 5, $4) as result`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, KEY("clone_v3")],
  );
  const v3Id = cloneV3Rows[0].result.draft_version_id;
  const v3Schema = structuredClone(v2Schema);
  v3Schema.sections[0].fields[0].label = "Thời lượng gọi";
  v3Schema.sections[0].fields[0].metric_spec.unit = "phút";
  v3Schema.sections[0].fields[0].metric_spec.compatible_group = "recruitment_daily_calls_minutes_v3";
  const v3Contract = buildWorkReportMetricContract(v3Schema);
  await db.query(
    `select public.work_report_update_template_draft(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 6,
       'Báo cáo công việc tuyển dụng ngày', 'Mẫu #1 v3 đổi đơn vị', 'DAILY', $5::jsonb, $6::jsonb, $7
     )`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, v3Id, JSON.stringify(v3Schema), JSON.stringify(v3Contract), KEY("upd_v3")],
  );
  await db.query(
    `select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, 7, $5)`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, v3Id, KEY("pub_v3")],
  );

  const period3 = "2099-10-22";
  await db.query(
    `update public.work_report_assignments set template_version_id = $1::uuid where template_id = $2::uuid`,
    [v3Id, templateId],
  );
  await db.query(
    `select public.work_report_ensure_obligations_for_window($1::uuid, $2::uuid, $3::date)`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, period3],
  );
  const obB1_p3 = await getObId(STAFF_B1, period3);
  await db.query(
    `select public.work_report_submit($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)`,
    [
      STAFF_B1.auth,
      STAFF_B1.app,
      obB1_p3,
      JSON.stringify({ calls_made: 120, interested_candidates: 4, workers_started: 1 }),
      KEY("sub_b1_p3"),
    ],
  );

  const { rows: bodAllThreePeriods } = await db.query(
    `select public.work_report_analytics_overview(
       $1::uuid, $2::uuid, $3::uuid, null, $4::date, $5::date, null, null, 'final'
     ) as result`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, period1, period3],
  );
  const callsVariants = bodAllThreePeriods[0].result.metrics.filter((m) => m.metric_key === "calls_made");
  assert.equal(callsVariants.length, 2, "incompatible unit/compatible_group must NOT be summed together");
  assert.deepEqual(
    callsVariants.map((m) => ({
      label: m.label,
      unit: m.unit,
      compatible_group: m.compatible_group,
      sum_value: m.sum_value,
    })),
    [
      {
        label: "Tổng cuộc gọi (v2) (v1-v2)",
        unit: "cuộc",
        compatible_group: "recruitment_daily_calls_made_v1",
        sum_value: 105,
      },
      {
        label: "Thời lượng gọi (v3)",
        unit: "phút",
        compatible_group: "recruitment_daily_calls_minutes_v3",
        sum_value: 120,
      },
    ],
  );

  // Metric projection reconciliation RPC (work_report_reconcile_metric_projection)
  const { rows: reconcileCleanRows } = await db.query(
    "select public.work_report_reconcile_metric_projection($1::uuid, $2::uuid, $3::uuid) as result",
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId],
  );
  assert.equal(reconcileCleanRows[0].result.ok, true);
  assert.equal(reconcileCleanRows[0].result.total_discrepancy_count, 0);
  assert.equal(reconcileCleanRows[0].result.checked_submissions_count, 6);

  // Simulate projection drift (tamper with numeric_value on 1 eligible metric row) -> reconciliation must detect it!
  await db.query(
    `update public.work_report_metric_values
        set numeric_value = 777
      where submission_id = $1::uuid and is_eligible and field_key = 'calls_made'`,
    [submissionA1Id],
  );
  const { rows: reconcileTamperedRows } = await db.query(
    "select public.work_report_reconcile_metric_projection($1::uuid, $2::uuid, $3::uuid) as result",
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId],
  );
  assert.equal(reconcileTamperedRows[0].result.ok, false);
  assert.equal(reconcileTamperedRows[0].result.value_mismatch_count, 1);
  assert.equal(reconcileTamperedRows[0].result.total_discrepancy_count, 1);

  // Restore numeric_value = 2 and verify reconciliation returns ok: true
  await db.query(
    `update public.work_report_metric_values
        set numeric_value = 2
      where submission_id = $1::uuid and is_eligible and field_key = 'calls_made'`,
    [submissionA1Id],
  );
  const { rows: reconcileRestoredRows } = await db.query(
    "select public.work_report_reconcile_metric_projection($1::uuid, $2::uuid, $3::uuid) as result",
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId],
  );
  assert.equal(reconcileRestoredRows[0].result.ok, true);
  assert.equal(reconcileRestoredRows[0].result.total_discrepancy_count, 0);

  // Canonical Full Admin can use overview, drill-down, and source evidence without duplicate report grants.
  const { rows: fullAdminOverviewRows } = await db.query(
    `select public.work_report_analytics_overview(
       $1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'final'
     ) as result`,
    [FULL_ADMIN_IMPLICIT.auth, FULL_ADMIN_IMPLICIT.app, templateId],
  );
  assert.equal(fullAdminOverviewRows[0].result.effective_scope.kind, "all");

  const { rows: fullAdminContributionRows } = await db.query(
    `select public.work_report_analytics_contributions(
       $1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'final',
       null, null, null, null, null, null, 50
     ) as result`,
    [FULL_ADMIN_IMPLICIT.auth, FULL_ADMIN_IMPLICIT.app, templateId],
  );
  assert.ok(fullAdminContributionRows[0].result.items.length > 0);

  const { rows: fullAdminEvidenceRows } = await db.query(
    `select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid) as result`,
    [FULL_ADMIN_IMPLICIT.auth, FULL_ADMIN_IMPLICIT.app, submissionA1Id],
  );
  assert.equal(fullAdminEvidenceRows[0].result.submission.submission_id, submissionA1Id);

  // SEC-WR-02: Team Leader A spoofing team_id = TEAM_B or assignee_id = STAFF_B1 is rejected with 42501 WORK_REPORT_SCOPE_DENIED
  await assert.rejects(
    db.query(
      `select public.work_report_analytics_overview(
         $1::uuid, $2::uuid, $3::uuid, null, null, null, $4::uuid, null, 'final'
       )`,
      [LEADER_A.auth, LEADER_A.app, templateId, TEAM_B],
    ),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_SCOPE_DENIED"),
  );
  await assert.rejects(
    db.query(
      `select public.work_report_analytics_overview(
         $1::uuid, $2::uuid, $3::uuid, null, null, null, null, $4::uuid, 'final'
       )`,
      [LEADER_A.auth, LEADER_A.app, templateId, STAFF_B1.app],
    ),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_SCOPE_DENIED"),
  );
  await assert.rejects(
    db.query(
      `select public.work_report_analytics_contributions(
         $1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'final',
         null, null, $4::uuid, null, null, null, 50
       )`,
      [LEADER_A.auth, LEADER_A.app, templateId, TEAM_B],
    ),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_SCOPE_DENIED"),
  );

  // SEC-WR-03: Form Admin (entry_admin + report_form_manage @ all, no report_analytics_view/report_view) is denied
  await assert.rejects(
    db.query(
      `select public.work_report_analytics_overview(
         $1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'final'
       )`,
      [FORM_ADMIN_ONLY.auth, FORM_ADMIN_ONLY.app, templateId],
    ),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_CAPABILITY_DENIED"),
  );

  // ANALYTICS_ONLY_USER can read overview & breakdown, but is denied contributions (requires report_view)
  const { rows: analyticsOnlyOverview } = await db.query(
    `select public.work_report_analytics_overview(
       $1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'final'
     ) as result`,
    [ANALYTICS_ONLY_USER.auth, ANALYTICS_ONLY_USER.app, templateId],
  );
  assert.equal(analyticsOnlyOverview[0].result.effective_scope.kind, "all");
  await assert.rejects(
    db.query(
      `select public.work_report_analytics_contributions(
         $1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'final',
         null, null, null, null, null, null, 50
       )`,
      [ANALYTICS_ONLY_USER.auth, ANALYTICS_ONLY_USER.app, templateId],
    ),
    (err) => err.code === "42501" && err.message.includes("WORK_REPORT_CAPABILITY_DENIED"),
  );

  // SEC-WR-07 & AG-17: Revoke Team Leader A -> immediate denial on overview, breakdown, and contributions
  await db.query(
    `select public.direct_entry_revoke_team_leader(
       $1::uuid, $2::uuid, $3::uuid, null::date, 2, 'Revoke Leader A', $4
     )`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, TEAM_A, KEY("revoke_la")],
  );
  await assert.rejects(
    db.query(
      `select public.work_report_analytics_overview(
         $1::uuid, $2::uuid, $3::uuid, null, null, null, null, null, 'final'
       )`,
      [LEADER_A.auth, LEADER_A.app, templateId],
    ),
    (err) => err.code === "42501",
  );
});

test("contributions keyset pagination neither skips nor duplicates rows when a new submission arrives or the cursor row is updated between pages", async () => {
  const contract = buildWorkReportMetricContract(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  const { rows: tplRows } = await db.query(
    `select public.work_report_create_template(
       $1::uuid, $2::uuid, 'RECRUITMENT_DAILY_KEYSET', 'Báo cáo kiểm thử keyset cursor',
       'Kiểm thử keyset pagination ổn định giữa các trang', 'DAILY', $3::jsonb, $4::jsonb, $5
     ) as result`,
    [
      BOD_ADMIN.auth,
      BOD_ADMIN.app,
      JSON.stringify(RECRUITMENT_DAILY_TEMPLATE_SCHEMA),
      JSON.stringify(contract),
      KEY("tpl_keyset_create"),
    ],
  );
  const templateId = tplRows[0].result.template_id;
  const versionId = tplRows[0].result.draft_version_id;
  await db.query(
    `select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5)`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, versionId, KEY("tpl_keyset_pub")],
  );

  const { rows: assignRows } = await db.query(
    `select public.work_report_create_assignment(
       $1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null,
       'DAILY', true, 1, '23:59:59'::time, false, '2026-10-01'::date, null, $5
     ) as result`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, templateId, TEAM_B, KEY("assign_keyset")],
  );
  const assignmentId = assignRows[0].result.assignment_id;

  // Seed 5 obligations O1..O5 on TEAM_B:
  // Initially O1..O4 are COMPLETED with distinct submitted_at descending:
  //   O1: 2026-10-21T10:04:00Z (calls_made = 40)
  //   O2: 2026-10-21T10:03:00Z (calls_made = 30)  <-- last row of Page 1 (limit = 2)
  //   O3: 2026-10-21T10:02:00Z (calls_made = 20)
  //   O4: 2026-10-21T10:01:00Z (calls_made = 10)
  //   O5: unsubmitted initially (will be submitted between Page 1 and Page 2!)
  const obIds = [];
  const subIds = [];
  for (let i = 1; i <= 5; i++) {
    const authId = `17000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const appId = `27000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const obId = `77000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const subId = `87000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const revId = `97000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    obIds.push(obId);
    subIds.push(subId);

    await db.query("insert into auth.users (id) values ($1::uuid)", [authId]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
       values ($1::uuid, $2::uuid, $3, true)`,
      [appId, authId, `Keyset Member ${i}`],
    );
    await db.query(
      `insert into public.work_report_obligations
         (obligation_id, template_id, template_version_id, assignment_id, assignee_app_user_id,
          snapshot_team_id, snapshot_team_code, snapshot_team_display_name,
          period_type, period_key, period_start_date, period_end_date, due_at, is_mandatory, obligation_status)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               $6::uuid, 'WR15_TEAM_B', 'Nhóm Tuyển Dụng B',
               'DAILY', '2026-10-20', '2026-10-20'::date, '2026-10-20'::date, '2099-10-21T16:59:59Z'::timestamptz, true, 'ACTIVE')`,
      [obId, templateId, versionId, assignmentId, appId, TEAM_B],
    );

    if (i <= 4) {
      const minute = 5 - i; // i=1 -> 10:04, i=2 -> 10:03, i=3 -> 10:02, i=4 -> 10:01
      const submittedAt = `2026-10-21T10:0${minute}:00.000000Z`;
      const callsVal = (5 - i) * 10;
      const payload = { calls_made: callsVal, interested_candidates: 1, workers_started: 0 };
      await db.query(
        `insert into public.work_report_submissions
           (submission_id, obligation_id, template_id, template_version_id, assignee_app_user_id,
            submitted_by_user_id, submitted_team_id, state, draft_payload_json,
            first_submitted_at, latest_submitted_at, is_late)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $5::uuid, $6::uuid, 'COMPLETED', $7::jsonb,
                 $8::timestamptz, $8::timestamptz, false)`,
        [subId, obId, templateId, versionId, appId, TEAM_B, JSON.stringify(payload), submittedAt],
      );
      await db.query(
        `insert into public.work_report_submission_revisions
           (revision_id, submission_id, obligation_id, template_version_id, revision_no,
            payload_json, payload_checksum, created_by_user_id, created_at)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1,
                 $5::jsonb, repeat('b', 64), $6::uuid, $7::timestamptz)`,
        [revId, subId, obId, versionId, JSON.stringify(payload), appId, submittedAt],
      );
      await db.query(
        `update public.work_report_submissions set current_revision_id = $1::uuid where submission_id = $2::uuid`,
        [revId, subId],
      );
      await db.query(
        `insert into public.work_report_metric_values
           (submission_id, revision_id, obligation_id, template_id, template_version_id,
            assignee_app_user_id, snapshot_team_id, period_type, period_key,
            period_start_date, period_end_date, field_key, metric_key, compatible_group,
            value_type, unit, numeric_value, is_current_revision, is_provisional, is_final, is_eligible)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6::uuid, $7::uuid, 'DAILY', '2026-10-20',
                 '2026-10-20'::date, '2026-10-20'::date, 'calls_made', 'calls_made', 'recruitment_daily_calls_made_v1',
                 'INTEGER', 'cuộc', $8, true, false, true, true)`,
        [subId, revId, obId, templateId, versionId, appId, TEAM_B, callsVal],
      );
    }
  }

  // 1) Fetch Page 1 (limit = 2, cursor = null) -> returns [O1, O2]
  const { rows: page1Rows } = await db.query(
    `select public.work_report_analytics_contributions(
       $1::uuid, $2::uuid, $3::uuid, null, null, null, $4::uuid, null, 'final',
       'calls_made', null, null, null, null, null, 2
     ) as result`,
    [LEADER_B.auth, LEADER_B.app, templateId, TEAM_B],
  );
  const page1 = page1Rows[0].result;
  assert.equal(typeof page1.as_of, "string");
  assert.deepEqual(
    page1.items.map((item) => item.obligation_id),
    [obIds[0], obIds[1]],
  );
  assert.equal(page1.next_cursor, `2026-10-21T10:03:00.000000Z|2026-10-20|${obIds[1]}`);

  // 2) Between Page 1 and Page 2:
  //    a) O5 submits a brand-new report at 2026-10-21T10:05:00Z (sorts before O1!)
  //    b) O2 (the anchor row of Page 1!) submits a new revision at 2026-10-21T10:06:00Z (moves O2 to row 1!)
  const appId5 = "27000000-0000-4000-8000-000000000005";
  const revId5 = "97000000-0000-4000-8000-000000000005";
  await db.query(
    `insert into public.work_report_submissions
       (submission_id, obligation_id, template_id, template_version_id, assignee_app_user_id,
        submitted_by_user_id, submitted_team_id, state, draft_payload_json,
        first_submitted_at, latest_submitted_at, is_late)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
             $5::uuid, $6::uuid, 'COMPLETED', '{"calls_made":50,"interested_candidates":1,"workers_started":0}'::jsonb,
             '2026-10-21T10:05:00.000000Z'::timestamptz, '2026-10-21T10:05:00.000000Z'::timestamptz, false)`,
    [subIds[4], obIds[4], templateId, versionId, appId5, TEAM_B],
  );
  await db.query(
    `insert into public.work_report_submission_revisions
       (revision_id, submission_id, obligation_id, template_version_id, revision_no,
        payload_json, payload_checksum, created_by_user_id, created_at)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1,
             '{"calls_made":50,"interested_candidates":1,"workers_started":0}'::jsonb, repeat('c', 64), $5::uuid, '2026-10-21T10:05:00.000000Z'::timestamptz)`,
    [revId5, subIds[4], obIds[4], versionId, appId5],
  );
  await db.query(
    `update public.work_report_submissions set current_revision_id = $1::uuid where submission_id = $2::uuid`,
    [revId5, subIds[4]],
  );
  await db.query(
    `insert into public.work_report_metric_values
       (submission_id, revision_id, obligation_id, template_id, template_version_id,
        assignee_app_user_id, snapshot_team_id, period_type, period_key,
        period_start_date, period_end_date, field_key, metric_key, compatible_group,
        value_type, unit, numeric_value, is_current_revision, is_provisional, is_final, is_eligible)
     values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
             $6::uuid, $7::uuid, 'DAILY', '2026-10-20',
             '2026-10-20'::date, '2026-10-20'::date, 'calls_made', 'calls_made', 'recruitment_daily_calls_made_v1',
             'INTEGER', 'cuộc', 50, true, false, true, true)`,
    [subIds[4], revId5, obIds[4], templateId, versionId, appId5, TEAM_B],
  );

  // Update O2's latest_submitted_at to 10:06:00Z (simulating resubmission of the cursor anchor row between Page 1 and Page 2)
  await db.query(
    `update public.work_report_submissions
        set latest_submitted_at = '2026-10-21T10:06:00.000000Z'::timestamptz
      where submission_id = $1::uuid`,
    [subIds[1]],
  );

  // 3) Fetch Page 2 using page1.next_cursor (limit = 2) -> must return [O3, O4] with zero skipped or duplicated rows!
  const { rows: page2Rows } = await db.query(
    `select public.work_report_analytics_contributions(
       $1::uuid, $2::uuid, $3::uuid, null, null, null, $4::uuid, null, 'final',
       'calls_made', null, null, null, null, $5, 2
     ) as result`,
    [LEADER_B.auth, LEADER_B.app, templateId, TEAM_B, page1.next_cursor],
  );
  const page2 = page2Rows[0].result;
  assert.deepEqual(
    page2.items.map((item) => item.obligation_id),
    [obIds[2], obIds[3]],
    "Page 2 must return [O3, O4] without duplicating O1/O2 or skipping O3",
  );
  assert.equal(page2.next_cursor, null);

  // 4) Malformed or legacy bare-UUID cursor must be rejected with 22023 WORK_REPORT_CURSOR_INVALID
  await assert.rejects(
    db.query(
      `select public.work_report_analytics_contributions(
         $1::uuid, $2::uuid, $3::uuid, null, null, null, $4::uuid, null, 'final',
         'calls_made', null, null, null, null, $5, 2
       )`,
      [LEADER_B.auth, LEADER_B.app, templateId, TEAM_B, obIds[1]],
    ),
    (err) => err.code === "22023" && err.message.includes("WORK_REPORT_CURSOR_INVALID"),
  );
});

test("HF: work_report_analytics_filter_options supports analytics-only actors, enforces team vs all scope without leaking out-of-scope options, and stays separate from report_view", async () => {
  const TEAM_A_ANALYTICS_ONLY = {
    auth: "15000000-0000-4000-8000-000000000091",
    app: "25000000-0000-4000-8000-000000000091",
    name: "Team A Analytics Only Actor",
  };
  const REPORT_VIEW_ONLY = {
    auth: "15000000-0000-4000-8000-000000000092",
    app: "25000000-0000-4000-8000-000000000092",
    name: "Report View Only Actor",
  };

  for (const actor of [TEAM_A_ANALYTICS_ONLY, REPORT_VIEW_ONLY]) {
    await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
       values ($1::uuid, $2::uuid, $3, true)`,
      [actor.app, actor.auth, actor.name],
    );
  }

  // Grant ONLY report_analytics_view @ team: TEAM_A (no report_view, no report_assign)
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
     values ($1::uuid, 'report_analytics_view', '2026-01-01', true)`,
    [TEAM_A_ANALYTICS_ONLY.app],
  );
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)`,
    [TEAM_A_ANALYTICS_ONLY.app, TEAM_A],
  );

  // Grant ONLY report_view @ all (no report_analytics_view)
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
     values ($1::uuid, 'report_view', '2026-01-01', true)`,
    [REPORT_VIEW_ONLY.app],
  );
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1::uuid, 'all', '2026-01-01', true)`,
    [REPORT_VIEW_ONLY.app],
  );

  // Create a Team-B-only template to prove TEAM_A_ANALYTICS_ONLY does NOT see out-of-scope templates
  const bOnlySchema = structuredClone(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  const bOnlyContract = buildWorkReportMetricContract(bOnlySchema);
  const { rows: bOnlyTplRows } = await db.query(
    `select public.work_report_create_template(
       $1::uuid, $2::uuid, 'TEAM_B_EXCLUSIVE_TPL', 'Báo cáo riêng Nhóm B',
       null, 'DAILY', $3::jsonb, $4::jsonb, $5
     ) as result`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, JSON.stringify(bOnlySchema), JSON.stringify(bOnlyContract), KEY("hf_b_only_tpl")],
  );
  const bOnlyTplId = bOnlyTplRows[0].result.template_id;
  await db.query(
    `select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5)`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, bOnlyTplId, bOnlyTplRows[0].result.draft_version_id, KEY("hf_b_only_pub")],
  );
  await db.query(
    `select public.work_report_create_assignment(
       $1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null,
       'DAILY', true, 0, '23:59:59'::time, false, '2026-01-01'::date, null, $5
     )`,
    [BOD_ADMIN.auth, BOD_ADMIN.app, bOnlyTplId, TEAM_B, KEY("hf_b_only_assign")],
  );

  // 1) TEAM_A_ANALYTICS_ONLY gets strictly TEAM_A options without report_view or report_assign
  const { rows: teamAOptsRows } = await db.query(
    `select public.work_report_analytics_filter_options($1::uuid, $2::uuid) as result`,
    [TEAM_A_ANALYTICS_ONLY.auth, TEAM_A_ANALYTICS_ONLY.app],
  );
  const teamAOpts = teamAOptsRows[0].result;
  assert.deepEqual(teamAOpts.effective_scope, { kind: "team", label: "Nhóm Tuyển Dụng A" });
  assert.deepEqual(teamAOpts.teams.map((t) => t.team_id), [TEAM_A], "only TEAM_A returned");
  assert.equal(
    teamAOpts.templates.some((t) => t.template_id === bOnlyTplId),
    false,
    "Team-B-only template excluded from Team A analytics options",
  );
  const mainTplOpt = teamAOpts.templates.find((t) => t.template_code === "RECRUITMENT_DAILY_ANALYTICS");
  assert.ok(mainTplOpt, "Team A template included with version numbers");
  assert.ok(mainTplOpt.versions.every((v) => Number.isInteger(v.version_no) && v.version_no >= 1));
  assert.equal(
    teamAOpts.assignees.some((u) => u.app_user_id === STAFF_B1.app),
    false,
    "Team B staff never leaked in Team A analytics assignees",
  );
  assert.ok(teamAOpts.assignees.every((u) => u.team_ids.includes(TEAM_A)));

  // And TEAM_A_ANALYTICS_ONLY still CANNOT read source submission content (strict capability separation)
  const { rows: anySubRow } = await db.query(
    `select submission_id from public.work_report_submissions limit 1`,
  );
  await assert.rejects(
    db.query(`select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid)`, [
      TEAM_A_ANALYTICS_ONLY.auth,
      TEAM_A_ANALYTICS_ONLY.app,
      anySubRow[0].submission_id,
    ]),
    (err) => err.code === "42501",
  );

  // 2) All-scope analytics-only actor & canonical Full Admin see both teams and Team-B template
  for (const actor of [ANALYTICS_ONLY_USER, FULL_ADMIN_IMPLICIT]) {
    const { rows } = await db.query(
      `select public.work_report_analytics_filter_options($1::uuid, $2::uuid) as result`,
      [actor.auth, actor.app],
    );
    assert.equal(rows[0].result.effective_scope.kind, "all");
    const teamIds = rows[0].result.teams.map((t) => t.team_id);
    assert.ok(teamIds.includes(TEAM_A) && teamIds.includes(TEAM_B));
    assert.ok(rows[0].result.templates.some((t) => t.template_id === bOnlyTplId));
  }

  // 3) Actors with ONLY report_view or ONLY report_form_manage (without report_analytics_view) are denied 42501
  for (const actor of [REPORT_VIEW_ONLY, FORM_ADMIN_ONLY]) {
    await assert.rejects(
      db.query(`select public.work_report_analytics_filter_options($1::uuid, $2::uuid)`, [
        actor.auth,
        actor.app,
      ]),
      (err) => err.code === "42501" && err.message.includes("WORK_REPORT_CAPABILITY_DENIED"),
    );
  }
});
