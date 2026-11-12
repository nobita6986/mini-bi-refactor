import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  CAPABILITIES,
} from "../src/lib/auth/direct-entry-v2.ts";
import {
  RECRUITMENT_DAILY_TEMPLATE_SCHEMA,
} from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";
import {
  F1_5_WORK_REPORTS_ANALYTICS_RPC_SIGNATURES,
  F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_RPC_SIGNATURE,
  F1_WORK_REPORTS_ASSIGNMENT_TRACKING_RPC_SIGNATURE,
  F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES,
  HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_RPC_SIGNATURES,
  WORK_REPORTS_ANDROID_SYNC_AND_UX_RPC_SIGNATURE,
  WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const TEAM_A = "94000000-0000-4000-8000-00000000f20a";
const TEAM_B = "94000000-0000-4000-8000-00000000f20b";

const ADMIN = {
  auth: "10000000-0000-4000-8000-00000000f201",
  app: "20000000-0000-4000-8000-00000000f201",
};
const LEADER_A = {
  auth: "10000000-0000-4000-8000-00000000f202",
  app: "20000000-0000-4000-8000-00000000f202",
  recruiter: "30000000-0000-4000-8000-00000000f202",
};
const STAFF_A = {
  auth: "10000000-0000-4000-8000-00000000f203",
  app: "20000000-0000-4000-8000-00000000f203",
  recruiter: "30000000-0000-4000-8000-00000000f203",
};
const STAFF_B = {
  auth: "10000000-0000-4000-8000-00000000f204",
  app: "20000000-0000-4000-8000-00000000f204",
  recruiter: "30000000-0000-4000-8000-00000000f204",
};
const DELEGATE_A = {
  auth: "10000000-0000-4000-8000-00000000f206",
  app: "20000000-0000-4000-8000-00000000f206",
  recruiter: "30000000-0000-4000-8000-00000000f206",
};
const DISABLED = {
  auth: "10000000-0000-4000-8000-00000000f205",
  app: "20000000-0000-4000-8000-00000000f205",
};

let keySequence = 0;
const idempotencyKey = (prefix) => `f2_${prefix}_${++keySequence}`;
const F2_RPC_SIGNATURES = Object.freeze([
  "work_report_decide_review(uuid, uuid, uuid, text, text, integer, text)",
  "work_report_list_pending_reviews(uuid, uuid, uuid, text, integer)",
  "work_report_get_review_submission(uuid, uuid, uuid)",
  "work_report_list_delegations(uuid, uuid)",
  "work_report_create_delegation(uuid, uuid, text, uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone, text)",
  "work_report_revoke_delegation(uuid, uuid, uuid, integer, text)",
]);
const F2_RPC_NAMES = [
  "work_report_decide_review",
  "work_report_list_pending_reviews",
  "work_report_get_review_submission",
  "work_report_create_delegation",
  "work_report_list_delegations",
  "work_report_revoke_delegation",
];
const normalizeSignature = (signature) => signature.replace(/,\s*/g, ", ");

async function createDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

const db = await createDatabase();

async function requireF2Contract() {
  const { rows } = await db.query(`
    select p.proname, p.oid::regprocedure::text as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = any($1::text[])
     order by p.proname, p.oid::regprocedure::text`,
  [F2_RPC_NAMES]);
  const found = new Set(rows.map((row) => row.proname));
  const expected = F2_RPC_NAMES;
  assert.deepEqual(
    [...found].sort(),
    expected.sort(),
    `F2 regression gate requires the F2 WP1 migration/RPCs; missing: ${expected.filter((name) => !found.has(name)).join(", ") || "none"}. This is expected to fail on a pre-F2 baseline and must not be skipped.`,
  );
  assert.deepEqual(rows.map((row) => normalizeSignature(row.signature)).sort(), [...F2_RPC_SIGNATURES].sort(),
    "F2 RPC argument order is the canonical server-bound ABI");
  return rows;
}

async function seedActors() {
  await db.query(`insert into public.teams (team_id, code, display_name, active)
    values ($1::uuid, 'F2_TEAM_A', 'F2 Team A', true),
           ($2::uuid, 'F2_TEAM_B', 'F2 Team B', true)`, [TEAM_A, TEAM_B]);

  for (const [actor, displayName, enabled] of [
    [ADMIN, "F2 Review Admin", true],
    [LEADER_A, "F2 Team Leader A", true],
    [STAFF_A, "F2 Staff A", true],
    [STAFF_B, "F2 Staff B", true],
    [DELEGATE_A, "F2 Delegate A", true],
    [DISABLED, "F2 Disabled", false],
  ]) {
    await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
    await db.query(`insert into public.direct_entry_app_users
      (app_user_id, auth_subject, display_name, enabled)
      values ($1::uuid, $2::uuid, $3, $4)`,
    [actor.app, actor.auth, displayName, enabled]);
  }

  for (const capability of [
    "entry_admin",
    "team_master_manage",
    "recruiter_master_manage",
    "team_manager_assign",
    "report_form_manage",
    "report_assign",
    "report_view",
    "report_analytics_view",
    "report_review",
    "report_delegate",
  ]) {
    await db.query(`insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from, is_current)
      values ($1::uuid, $2, '2026-01-01', true)`, [ADMIN.app, capability]);
  }
  await db.query(`insert into public.direct_entry_scope_grants
    (app_user_id, scope_kind, valid_from, is_current)
    values ($1::uuid, 'all', '2026-01-01', true)`, [ADMIN.app]);

  for (const [actor, teamId, personnelCode] of [
    [LEADER_A, TEAM_A, "F2_LA"],
    [STAFF_A, TEAM_A, "F2_SA"],
    [STAFF_B, TEAM_B, "F2_SB"],
    [DELEGATE_A, TEAM_A, "F2_DA"],
  ]) {
    await db.query(`insert into public.recruiters
      (recruiter_id, display_name, personnel_code, personnel_position, active)
      values ($1::uuid, $2, $3, 'STAFF', true)`,
    [actor.recruiter, personnelCode, personnelCode]);
    await db.query(`insert into public.recruiter_provider_memberships
      (recruiter_id, provider_type, valid_from, is_current)
      values ($1::uuid, 'hrp', '2026-01-01', true)`, [actor.recruiter]);
    await db.query(`insert into public.recruiter_team_memberships
      (recruiter_id, team_id, valid_from, is_current)
      values ($1::uuid, $2::uuid, '2026-01-01', true)`, [actor.recruiter, teamId]);
    await db.query(`insert into public.direct_entry_app_user_recruiter_links
      (app_user_id, recruiter_id, verified, valid_from, is_current)
      values ($1::uuid, $2::uuid, true, '2026-01-01', true)`, [actor.app, actor.recruiter]);
  }

  await db.query(`select public.direct_entry_designate_team_leader(
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, null::date, 1, 'F2 regression fixture', $5
  )`, [ADMIN.auth, ADMIN.app, TEAM_A, LEADER_A.app, idempotencyKey("leader")]);
}

async function createReviewTemplate({ requiresReview = true, templateCode = "F2_REVIEW_DAILY" } = {}) {
  const schema = RECRUITMENT_DAILY_TEMPLATE_SCHEMA;
  const metrics = buildWorkReportMetricContract(schema);
  const { rows } = await db.query(`select public.work_report_create_template(
    $1::uuid, $2::uuid, $3::text, 'F2 review fixture', null, 'DAILY',
    $4::jsonb, $5::jsonb, $6
  ) as result`, [
    ADMIN.auth,
    ADMIN.app,
    templateCode,
    JSON.stringify(schema),
    JSON.stringify(metrics),
    idempotencyKey("template"),
  ]);
  const created = rows[0].result;
  if (requiresReview) {
    await db.query(`update public.work_report_template_versions
      set requires_review = true where version_id = $1::uuid and status = 'DRAFT'`,
    [created.draft_version_id]);
  }
  await db.query(`select public.work_report_publish_template(
    $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6
  )`, [ADMIN.auth, ADMIN.app, created.template_id, created.draft_version_id,
    created.version, idempotencyKey("publish")]);
  return { templateId: created.template_id, versionId: created.draft_version_id };
}

async function createAssignment(templateId, targetKind, teamId, userId, startDate) {
  const { rows } = await db.query(`select public.work_report_create_assignment(
    $1::uuid, $2::uuid, $3::uuid, $4::text, $5::uuid, $6::uuid, null::uuid[],
    'DAILY', true, 0, '23:59:59'::time, false, $7::date, null::date, $8
  ) as result`, [
    ADMIN.auth,
    ADMIN.app,
    templateId,
    targetKind,
    userId,
    teamId,
    startDate,
    idempotencyKey("assignment"),
  ]);
  return rows[0].result.assignment_id;
}

async function materialize(date) {
  return db.query(`select public.work_report_ensure_obligations_for_window(
    $1::uuid, $2::uuid, $3::date
  ) as result`, [ADMIN.auth, ADMIN.app, date]);
}

async function submit(actor, obligationId, calls, expectedVersion = null) {
  const { rows } = await db.query(`select public.work_report_submit(
    $1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::integer, $6::text
  ) as result`, [
    actor.auth,
    actor.app,
    obligationId,
    JSON.stringify({ calls_made: calls, interested_candidates: 1, workers_started: 0, notes: null }),
    expectedVersion,
    idempotencyKey("submit"),
  ]);
  return rows[0].result;
}

async function createDelegation(
  actor,
  grantee,
  templateId,
  scopeId,
  effectiveFrom,
  effectiveTo,
  capability = "report_review",
  scopeKind = "team",
) {
  const { rows } = await db.query(`select public.work_report_create_delegation(
    $1::uuid, $2::uuid, $3::text, $4::uuid, $5::uuid, $6::text, $7::uuid,
    $8::timestamptz, $9::timestamptz, $10::text
  ) as result`, [
    actor.auth,
    actor.app,
    capability,
    grantee.app,
    templateId,
    scopeKind,
    scopeId,
    effectiveFrom,
    effectiveTo,
    idempotencyKey("delegation-create"),
  ]);
  return rows[0].result;
}

test("F2 contract adds exactly the two locked capabilities and RLS-protected tables", async () => {
  assert.equal(CAPABILITIES.length, 29, "Active capability registry includes F2, VFIN-01, duplicate CCCD, and worker history tokens");
  assert.ok(CAPABILITIES.includes("report_review"));
  assert.ok(CAPABILITIES.includes("report_delegate"));

  const { rows: constraints } = await db.query(`select pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'direct_entry_capability_grants'
       and c.conname = 'direct_entry_capability_grants_capability_check'`);
  assert.equal(constraints.length, 1);
  const dbTokens = [...constraints[0].definition.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.equal(dbTokens.length, 33, "DB capability vocabulary is 29 active + 4 retired compatibility tokens");
  assert.ok(dbTokens.includes("report_review"));
  assert.ok(dbTokens.includes("report_delegate"));

  const { rows } = await db.query(`select c.relname, c.relrowsecurity, c.relforcerowsecurity,
      has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
      has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
      has_table_privilege('service_role', c.oid, 'SELECT') as service_select
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any(array['work_report_review_events','work_report_delegations'])
    order by c.relname`);
  assert.deepEqual(rows.map((row) => row.relname), ["work_report_delegations", "work_report_review_events"]);
  for (const row of rows) {
    assert.equal(row.relrowsecurity, true, `${row.relname} RLS enabled`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname} FORCE RLS enabled`);
    assert.equal(row.anon_select, false, `${row.relname} anon SELECT revoked`);
    assert.equal(row.authenticated_select, false, `${row.relname} authenticated SELECT revoked`);
    assert.equal(row.service_select, false, `${row.relname} service_role SELECT revoked`);
  }
});

test("F2 RPCs are SECURITY DEFINER, owned by migration operator and executable only by service_role", async () => {
  await requireF2Contract();

  const { rows: rpcRows } = await db.query(`select p.proname, p.oid::regprocedure::text as signature,
      p.prosecdef, pg_get_userbyid(p.proowner) as owner,
      has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute,
      coalesce((select bool_or(x.grantee = 0 and x.privilege_type = 'EXECUTE')
        from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x), false) as public_execute
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any($1::text[])
    order by p.proname`, [F2_RPC_NAMES]);
  assert.equal(rpcRows.length, F2_RPC_NAMES.length);
  for (const row of rpcRows) {
    assert.equal(row.prosecdef, true, `${row.signature} SECURITY DEFINER`);
    assert.equal(row.owner, "postgres", `${row.signature} owner is the migration operator in ephemeral PostgreSQL`);
    assert.equal(row.anon_execute, false, `${row.signature} anon EXECUTE revoked`);
    assert.equal(row.authenticated_execute, false, `${row.signature} authenticated EXECUTE revoked`);
    assert.equal(row.service_execute, true, `${row.signature} service_role EXECUTE granted`);
    assert.equal(row.public_execute, false, `${row.signature} PUBLIC EXECUTE revoked`);
  }

  const { rows: serviceRows } = await db.query(`select p.oid::regprocedure::text as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'work_report_%'
      and has_function_privilege('service_role', p.oid, 'EXECUTE')
    order by p.oid::regprocedure::text`);
  const expectedServiceRpcSignatures = [
    ...F1_WORK_REPORTS_SERVICE_RPC_SIGNATURES,
    F1_WORK_REPORTS_ASSIGNMENT_OPTIONS_RPC_SIGNATURE,
    F1_WORK_REPORTS_ASSIGNMENT_TRACKING_RPC_SIGNATURE,
    ...F1_5_WORK_REPORTS_ANALYTICS_RPC_SIGNATURES,
    ...F2_RPC_SIGNATURES,
    ...WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES,
    ...HF_WORK_REPORTS_GROUPS_AND_ANALYTICS_OPTIONS_RPC_SIGNATURES,
    WORK_REPORTS_ANDROID_SYNC_AND_UX_RPC_SIGNATURE,
  ].map((signature) => signature.replace(/^public\./, "")).sort();
  assert.deepEqual(serviceRows.map((row) => normalizeSignature(row.signature)).sort(), expectedServiceRpcSignatures,
    "service_role EXECUTE is limited to the explicit F1/F1.5/F2 API allowlist");

  const { rows: helpers } = await db.query(`select p.oid::regprocedure::text as signature,
      has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'work_report__internal_%'`);
  assert.ok(helpers.every((row) => !row.service_execute), "internal F2 helpers are not directly callable by service_role");
});

test("F2 review, delegation and finality behavior regression gate", async () => {
  await requireF2Contract();
  await seedActors();

  const defaultTemplate = await createReviewTemplate({
    requiresReview: false,
    templateCode: "F2_DEFAULT_FALSE",
  });
  const { rows: defaultSetting } = await db.query(`select requires_review
    from public.work_report_template_versions where version_id = $1::uuid`, [defaultTemplate.versionId]);
  assert.equal(defaultSetting[0].requires_review, false, "requires_review defaults false");
  await createAssignment(defaultTemplate.templateId, "TEAM", TEAM_A, null, "2099-10-19");
  await materialize("2099-10-19");
  const { rows: defaultObligations } = await db.query(`select obligation_id
    from public.work_report_obligations where template_id = $1::uuid and assignee_app_user_id = $2::uuid
      and period_key = '2099-10-19'`, [defaultTemplate.templateId, STAFF_A.app]);
  const completedWithoutReview = await submit(STAFF_A, defaultObligations[0].obligation_id, 8);
  assert.equal(completedWithoutReview.state, "COMPLETED", "no-review template completes on submit");
  const { rows: defaultMetrics } = await db.query(`select is_provisional, is_final, is_eligible
    from public.work_report_metric_values where submission_id = $1::uuid`, [completedWithoutReview.submission_id]);
  assert.ok(defaultMetrics.length > 0 && defaultMetrics.every((row) =>
    !row.is_provisional && row.is_final && row.is_eligible));

  const { templateId, versionId } = await createReviewTemplate();
  const template = await db.query(`select requires_review from public.work_report_template_versions
    where version_id = $1::uuid`, [versionId]);
  assert.equal(template.rows[0].requires_review, true, "review fixture uses a published requires_review template");

  await createAssignment(templateId, "TEAM", TEAM_A, null, "2099-10-20");
  await createAssignment(templateId, "TEAM", TEAM_B, null, "2099-10-20");
  await materialize("2099-10-20");

  const { rows: obligations } = await db.query(`select obligation_id, assignee_app_user_id
    from public.work_report_obligations where template_id = $1::uuid and period_key = '2099-10-20'
    order by assignee_app_user_id`, [templateId]);
  const staffAObligation = obligations.find((row) => row.assignee_app_user_id === STAFF_A.app);
  const leaderAObligation = obligations.find((row) => row.assignee_app_user_id === LEADER_A.app);
  const staffBObligation = obligations.find((row) => row.assignee_app_user_id === STAFF_B.app);
  assert.ok(staffAObligation && leaderAObligation && staffBObligation);

  const staffASubmission = await submit(STAFF_A, staffAObligation.obligation_id, 10);
  const leaderSelfSubmission = await submit(LEADER_A, leaderAObligation.obligation_id, 20);
  const staffBSubmission = await submit(STAFF_B, staffBObligation.obligation_id, 30);
  for (const submission of [staffASubmission, leaderSelfSubmission, staffBSubmission]) {
    assert.equal(submission.state, "PENDING_REVIEW");
  }

  const { rows: leaderQueue } = await db.query(`select public.work_report_list_pending_reviews(
    $1::uuid, $2::uuid, null::uuid, null::text, 50
  ) as result`, [LEADER_A.auth, LEADER_A.app]);
  const leaderQueueItems = leaderQueue[0].result.items;
  assert.ok(leaderQueueItems.some((item) => item.obligation_id === staffAObligation.obligation_id),
    "Team Leader inbox includes a pending review in the current team");
  assert.equal(leaderQueueItems.some((item) => item.obligation_id === staffBObligation.obligation_id), false,
    "Team Leader inbox excludes a pending review outside the current team");
  assert.ok(leaderQueueItems.every((item) => !("payload_json" in item) && !("draft_payload_json" in item)),
    "pending inbox returns metadata only; payload requires reviewer detail RPC");
  const { rows: adminQueue } = await db.query(`select public.work_report_list_pending_reviews(
    $1::uuid, $2::uuid, null::uuid, null::text, 50
  ) as result`, [ADMIN.auth, ADMIN.app]);
  assert.equal(adminQueue[0].result.items.length, 3, "explicit all-scope Admin can list every pending review");
  await db.exec("begin; set local role service_role");
  try {
    const { rows: serviceRoleQueue } = await db.query(`select public.work_report_list_pending_reviews(
      $1::uuid, $2::uuid, null::uuid, null::text, 50
    ) as result`, [ADMIN.auth, ADMIN.app]);
    assert.equal(serviceRoleQueue[0].result.items.length, 3,
      "service_role can reach the server RPC while table access remains revoked");
  } finally {
    await db.exec("rollback");
  }
  await assert.rejects(
    db.query(`select public.work_report_list_pending_reviews($1::uuid, $2::uuid, null, null, 50)`,
      [ADMIN.auth, LEADER_A.app]),
    (error) => error.code === "42501",
    "RPC actor identity must bind auth subject to app user; client-supplied mismatch is rejected",
  );
  const { rows: reviewDetail } = await db.query(`select public.work_report_get_review_submission(
    $1::uuid, $2::uuid, $3::uuid
  ) as result`, [LEADER_A.auth, LEADER_A.app, staffAObligation.obligation_id]);
  assert.match(JSON.stringify(reviewDetail[0].result), /"calls_made"\s*:\s*10/,
    "authorized Team Leader can read submitted content in current team");
  await assert.rejects(
    db.query(`select public.work_report_get_review_submission($1::uuid, $2::uuid, $3::uuid)`,
      [LEADER_A.auth, LEADER_A.app, staffBObligation.obligation_id]),
    (error) => error.code === "42501",
  );

  const { rows: leaderGrants } = await db.query(`select g.capability, s.scope_kind
    from public.direct_entry_capability_grants g
    join public.work_report_team_leader_capability_grants x on x.capability_grant_id = g.grant_id
    join public.direct_entry_scope_grants s on s.app_user_id = g.app_user_id
      and s.scope_kind = 'team' and s.team_id = $2::uuid and s.is_current
    where g.app_user_id = $1::uuid and g.is_current and g.capability in ('report_review','report_delegate')
    order by g.capability`, [LEADER_A.app, TEAM_A]);
  assert.deepEqual(leaderGrants, [{ capability: "report_review", scope_kind: "team" }],
    "current Team Leader receives review @ team, never delegation by default");

  const finalBeforeReview = await db.query(`select public.work_report_analytics_overview(
    $1::uuid, $2::uuid, $3::uuid, null, '2099-10-20'::date, '2099-10-20'::date,
    null, null, 'final'
  ) as result`, [ADMIN.auth, ADMIN.app, templateId]);
  const defaultFinality = await db.query(`select public.work_report_analytics_overview(
    $1::uuid, $2::uuid, $3::uuid
  ) as result`, [ADMIN.auth, ADMIN.app, templateId]);
  const provisionalBeforeReview = await db.query(`select public.work_report_analytics_overview(
    $1::uuid, $2::uuid, $3::uuid, null, '2099-10-20'::date, '2099-10-20'::date,
    null, null, 'provisional_included'
  ) as result`, [ADMIN.auth, ADMIN.app, templateId]);
  assert.equal(defaultFinality.rows[0].result.metrics.find((metric) => metric.metric_key === "calls_made").sum_value, null,
    "omitted finality defaults to final and excludes pending submissions");
  assert.equal(finalBeforeReview.rows[0].result.compliance.pending_review_count, 3,
    "pending reviews remain in submitted/compliance totals");
  assert.equal(finalBeforeReview.rows[0].result.metrics.find((metric) => metric.metric_key === "calls_made").sum_value, null,
    "default final analytics excludes pending submissions");
  assert.equal(provisionalBeforeReview.rows[0].result.metrics.find((metric) => metric.metric_key === "calls_made").sum_value, 60,
    "provisional mode explicitly includes pending submissions");

  const decision = (actor, obligationId, state, reason, version, key) => db.query(`select public.work_report_decide_review(
    $1::uuid, $2::uuid, $3::uuid, $4::text, $5::text, $6::integer, $7::text
  ) as result`, [actor.auth, actor.app, obligationId, state, reason, version, key]);

  await assert.rejects(
    decision(LEADER_A, leaderAObligation.obligation_id, "APPROVED", null, leaderSelfSubmission.version,
      idempotencyKey("self-review")),
    (error) => error.code === "42501" && error.message.includes("WORK_REPORT_SELF_REVIEW_FORBIDDEN"),
  );
  await assert.rejects(
    decision(LEADER_A, staffBObligation.obligation_id, "APPROVED", null, staffBSubmission.version,
      idempotencyKey("cross-team-review")),
    (error) => error.code === "42501",
  );

  const approveKey = idempotencyKey("approve");
  const { rows: approvedRows } = await decision(
    LEADER_A, staffAObligation.obligation_id, "APPROVED", null, staffASubmission.version, approveKey,
  );
  const approved = approvedRows[0].result;
  assert.equal(approved.state, "APPROVED");
  const { rows: replayRows } = await decision(
    LEADER_A, staffAObligation.obligation_id, "APPROVED", null, staffASubmission.version, approveKey,
  );
  assert.deepEqual(replayRows[0].result, approved, "idempotent retry returns the original decision result");

  await assert.rejects(
    decision(LEADER_A, staffAObligation.obligation_id, "APPROVED", null, staffASubmission.version,
      idempotencyKey("stale-review")),
    (error) => error.code === "40001" || error.message.includes("WORK_REPORT_VERSION_CONFLICT"),
  );

  await assert.rejects(
    decision(ADMIN, staffBObligation.obligation_id, "REJECTED", null, staffBSubmission.version,
      idempotencyKey("reject-no-reason")),
    (error) => error.message.toLowerCase().includes("reason"),
  );
  const { rows: rejectedRows } = await decision(
    ADMIN, staffBObligation.obligation_id, "REJECTED", "Thiếu thông tin đối soát", staffBSubmission.version,
    idempotencyKey("reject"),
  );
  assert.equal(rejectedRows[0].result.state, "REJECTED");
  const { rows: rejectedSubmission } = await db.query(`select version
    from public.work_report_submissions where submission_id = $1::uuid`, [staffBSubmission.submission_id]);
  const resubmitted = await submit(STAFF_B, staffBObligation.obligation_id, 31, rejectedSubmission[0].version);
  assert.equal(resubmitted.state, "PENDING_REVIEW", "resubmit returns to review queue");
  assert.equal(resubmitted.revision_no, 2, "resubmit appends a new revision");
  const { rows: revisionRows } = await db.query(`select revision_no from public.work_report_submission_revisions
    where submission_id = $1::uuid order by revision_no`, [staffBSubmission.submission_id]);
  assert.deepEqual(revisionRows.map((row) => row.revision_no), [1, 2], "rejection never overwrites prior revision");
  const { rows: metricsAfterDecision } = await db.query(`select submission_id, revision_id, is_current_revision,
      is_provisional, is_final, is_eligible
    from public.work_report_metric_values where submission_id = any($1::uuid[])
    order by submission_id, revision_id`, [[staffASubmission.submission_id, staffBSubmission.submission_id]]);
  const approvedMetrics = metricsAfterDecision.filter((row) => row.submission_id === staffASubmission.submission_id);
  const rejectedMetrics = metricsAfterDecision.filter((row) => row.submission_id === staffBSubmission.submission_id);
  assert.ok(approvedMetrics.every((row) => row.is_current_revision && row.is_final && row.is_eligible && !row.is_provisional));
  assert.ok(rejectedMetrics.some((row) => !row.is_current_revision && !row.is_final && !row.is_eligible && !row.is_provisional),
    "rejected revision is retained but not counted");
  assert.ok(rejectedMetrics.some((row) => row.is_current_revision && row.is_provisional && row.is_eligible && !row.is_final),
    "resubmitted revision is the only eligible provisional contribution");
  const finalAfterReview = await db.query(`select public.work_report_analytics_overview(
    $1::uuid, $2::uuid, $3::uuid, null, '2099-10-20'::date, '2099-10-20'::date,
    null, null, 'final'
  ) as result`, [ADMIN.auth, ADMIN.app, templateId]);
  const provisionalAfterReview = await db.query(`select public.work_report_analytics_overview(
    $1::uuid, $2::uuid, $3::uuid, null, '2099-10-20'::date, '2099-10-20'::date,
    null, null, 'provisional_included'
  ) as result`, [ADMIN.auth, ADMIN.app, templateId]);
  assert.equal(finalAfterReview.rows[0].result.metrics.find((metric) => metric.metric_key === "calls_made").sum_value, 10,
    "approved revision is final; rejected and pending revisions are excluded from final metrics");
  assert.equal(provisionalAfterReview.rows[0].result.metrics.find((metric) => metric.metric_key === "calls_made").sum_value, 61,
    "provisional metrics include approved and current pending revisions, but not rejected/superseded revisions");

  const { rows: eventRows } = await db.query(`select count(*)::int as n
    from public.work_report_review_events where submission_id = any($1::uuid[])`,
  [[staffASubmission.submission_id, staffBSubmission.submission_id]]);
  assert.equal(eventRows[0].n, 2, "approve and reject each append exactly one review event");
  const { rows: auditRows } = await db.query(`select count(*)::int as n
    from public.work_report_audit_events where submission_id = any($1::uuid[])
      and outcome = 'APPLIED'`, [[staffASubmission.submission_id, staffBSubmission.submission_id]]);
  assert.ok(auditRows[0].n >= 2, "approve and reject append audit; resubmission audit is retained too");

  const activeFrom = "2026-01-01T00:00:00.000Z";
  const activeTo = "2099-12-31T23:59:59.000Z";
  await assert.rejects(
    createDelegation(LEADER_A, DELEGATE_A, templateId, TEAM_A, activeFrom, activeTo),
    (error) => error.code === "42501",
    "Team Leader receives report_review but not report_delegate by default",
  );
  await assert.rejects(
    createDelegation(ADMIN, STAFF_B, templateId, TEAM_A, activeFrom, activeTo),
    (error) => error.code === "42501",
    "grantee outside the delegated team scope is denied",
  );
  await assert.rejects(
    createDelegation(ADMIN, DELEGATE_A, templateId, TEAM_A, activeFrom, activeTo, "report_delegate"),
    (error) => error.code === "22023" || error.code === "42501",
    "delegation capability cannot itself be delegated",
  );

  await db.query(`insert into public.direct_entry_capability_grants
    (app_user_id, capability, valid_from, is_current)
    values ($1::uuid, 'report_delegate', '2026-01-01', true)`, [LEADER_A.app]);
  await assert.rejects(
    createDelegation(LEADER_A, DELEGATE_A, templateId, null, activeFrom, activeTo, "report_review", "all"),
    (error) => error.code === "42501",
    "delegation cannot exceed the issuer's current team scope to all scope",
  );

  const delegation = await createDelegation(ADMIN, DELEGATE_A, templateId, TEAM_A, activeFrom, activeTo);
  assert.ok(delegation.delegation_id);
  const assignmentDelegation = await createDelegation(
    ADMIN, DELEGATE_A, templateId, TEAM_A, activeFrom, activeTo, "report_assign",
  );
  assert.ok(assignmentDelegation.delegation_id);
  const { rows: delegationCapabilities } = await db.query(`select capability
    from public.work_report_delegations
    where delegation_id = any($1::uuid[]) order by capability`,
  [[delegation.delegation_id, assignmentDelegation.delegation_id]]);
  assert.deepEqual(delegationCapabilities.map((row) => row.capability), ["report_assign", "report_review"],
    "delegation supports only the two capabilities in the F2 contract");
  const { rows: listedDelegations } = await db.query(`select public.work_report_list_delegations(
    $1::uuid, $2::uuid
  ) as result`, [ADMIN.auth, ADMIN.app]);
  assert.ok(listedDelegations[0].result.items.some((item) => item.delegation_id === delegation.delegation_id),
    "issuer can list the delegation it created");
  const { rows: delegateDirectGrant } = await db.query(`select count(*)::int as n
    from public.direct_entry_capability_grants where app_user_id = $1::uuid
      and capability = 'report_review' and is_current`, [DELEGATE_A.app]);
  assert.equal(delegateDirectGrant[0].n, 0, "delegation does not create a permanent capability grant");
  await assert.rejects(
    createDelegation(DELEGATE_A, STAFF_A, templateId, TEAM_A, activeFrom, activeTo),
    (error) => error.code === "42501",
    "a delegated reviewer cannot re-delegate authority",
  );
  await assert.rejects(
    db.query(`select public.work_report_get_review_submission(
      $1::uuid, $2::uuid, $3::uuid
    )`, [DELEGATE_A.auth, DELEGATE_A.app, staffBObligation.obligation_id]),
    (error) => error.code === "42501",
    "delegated reviewer cannot read an obligation outside the delegated child team scope",
  );

  const otherTemplate = await createReviewTemplate({ templateCode: "F2_OTHER_DAILY" });
  await createAssignment(otherTemplate.templateId, "TEAM", TEAM_A, null, "2099-10-21");
  await materialize("2099-10-21");
  const { rows: otherTemplateObligations } = await db.query(`select obligation_id
    from public.work_report_obligations where template_id = $1::uuid and assignee_app_user_id = $2::uuid
      and period_key = '2099-10-21'`, [otherTemplate.templateId, STAFF_A.app]);
  const otherTemplateSubmission = await submit(STAFF_A, otherTemplateObligations[0].obligation_id, 7);
  await assert.rejects(
    db.query(`select public.work_report_get_review_submission(
      $1::uuid, $2::uuid, $3::uuid
    )`, [DELEGATE_A.auth, DELEGATE_A.app, otherTemplateObligations[0].obligation_id]),
    (error) => error.code === "42501",
    "delegated reviewer cannot access another template even in the same team scope",
  );
  const { rows: delegatedObligationRows } = await db.query(`select obligation_id
    from public.work_report_obligations where template_id = $1::uuid and assignee_app_user_id = $2::uuid
      and period_key = '2099-10-21'`, [templateId, STAFF_A.app]);
  const delegatedObligation = delegatedObligationRows[0].obligation_id;
  const delegatedSubmission = await submit(STAFF_A, delegatedObligation, 12);
  const { rows: delegatedDetail } = await db.query(`select public.work_report_get_review_submission(
    $1::uuid, $2::uuid, $3::uuid
  ) as result`, [DELEGATE_A.auth, DELEGATE_A.app, delegatedObligation]);
  assert.match(JSON.stringify(delegatedDetail[0].result), /"calls_made"\s*:\s*12/,
    "valid delegate can read review content inside the delegated scope and resource");
  const delegateApproveKey = idempotencyKey("delegate-approve");
  const { rows: delegatedApproval } = await db.query(`select public.work_report_decide_review(
    $1::uuid, $2::uuid, $3::uuid, 'APPROVED', null, $4::integer, $5::text
  ) as result`, [DELEGATE_A.auth, DELEGATE_A.app, delegatedObligation,
    delegatedSubmission.version, delegateApproveKey]);
  assert.equal(delegatedApproval[0].result.state, "APPROVED", "delegate can review within delegated resource/time");
  assert.equal(otherTemplateSubmission.state, "PENDING_REVIEW");

  await materialize("2099-10-22");
  const { rows: revokeObligationRows } = await db.query(`select obligation_id
    from public.work_report_obligations where template_id = $1::uuid and assignee_app_user_id = $2::uuid
      and period_key = '2099-10-22'`, [templateId, STAFF_A.app]);
  const revokeObligation = revokeObligationRows[0].obligation_id;
  const revokeSubmission = await submit(STAFF_A, revokeObligation, 13);
  await db.query(`select public.work_report_revoke_delegation(
    $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::text
  )`, [ADMIN.auth, ADMIN.app, delegation.delegation_id, delegation.version ?? 1,
    idempotencyKey("delegation-revoke")]);
  await assert.rejects(
    db.query(`select public.work_report_decide_review(
      $1::uuid, $2::uuid, $3::uuid, 'APPROVED', null, $4::integer, $5::text
    )`, [DELEGATE_A.auth, DELEGATE_A.app, revokeObligation, revokeSubmission.version,
      idempotencyKey("revoked-delegate-review")]),
    (error) => error.code === "42501",
    "revocation immediately removes delegated access",
  );

  const expiredDelegation = await createDelegation(ADMIN, DELEGATE_A, templateId, TEAM_A,
    new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 1_500).toISOString());
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  await assert.rejects(
    db.query(`select public.work_report_decide_review(
      $1::uuid, $2::uuid, $3::uuid, 'APPROVED', null, $4::integer, $5::text
    )`, [DELEGATE_A.auth, DELEGATE_A.app, revokeObligation, revokeSubmission.version,
      idempotencyKey("expired-delegate-review")]),
    (error) => error.code === "42501",
    "expired delegation fails closed",
  );

  await materialize("2099-10-23");
  const { rows: lostAuthorityObligations } = await db.query(`select obligation_id
    from public.work_report_obligations where template_id = $1::uuid and assignee_app_user_id = $2::uuid
      and period_key = '2099-10-23'`, [templateId, STAFF_A.app]);
  const lostAuthorityObligation = lostAuthorityObligations[0].obligation_id;
  const lostAuthoritySubmission = await submit(STAFF_A, lostAuthorityObligation, 14);
  const retainedDelegation = await createDelegation(ADMIN, DELEGATE_A, templateId, TEAM_A, activeFrom, activeTo);
  const grantorReviewGrant = await db.query(`update public.direct_entry_capability_grants
    set is_current = false where app_user_id = $1::uuid and capability = 'report_review' and is_current
    returning grant_id`, [ADMIN.app]);
  assert.ok(grantorReviewGrant.rows.length > 0);
  await assert.rejects(
    db.query(`select public.work_report_decide_review(
      $1::uuid, $2::uuid, $3::uuid, 'APPROVED', null, $4::integer, $5::text
    )`, [DELEGATE_A.auth, DELEGATE_A.app, lostAuthorityObligation, lostAuthoritySubmission.version,
      idempotencyKey("grantor-revoked-review")]),
    (error) => error.code === "42501",
    "delegation is ineffective when the grantor loses current source authority",
  );
  assert.ok(expiredDelegation.delegation_id && retainedDelegation.delegation_id);

  await db.query(`select public.direct_entry_revoke_team_leader(
    $1::uuid, $2::uuid, $3::uuid, null::date, 2, 'F2 test revoke', $4
  )`, [ADMIN.auth, ADMIN.app, TEAM_A, idempotencyKey("leader-revoke")]);
  await assert.rejects(
    decision(LEADER_A, revokeObligation, "APPROVED", null, revokeSubmission.version,
      idempotencyKey("revoked-leader-review")),
    (error) => error.code === "42501",
    "revoked Team Leader loses report_review immediately",
  );
  await assert.rejects(
    decision(DISABLED, revokeObligation, "APPROVED", null, revokeSubmission.version,
      idempotencyKey("disabled-reviewer")),
    (error) => error.code === "42501",
    "disabled actor is denied at the RPC boundary",
  );
});

test.after(async () => {
  await db.close();
});
