/**
 * R1-T1-B current-state authorization regressions. Uses the full local migration
 * chain in PGlite only; fixture rows contain synthetic identities and dates.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildDb } from "./lib/p3-w05b-team-fixture.mjs";

const uuid = (n) => "10000000-0000-4000-8000-" + String(n).padStart(12, "0");
const AUTH = uuid(1), APP = uuid(2);
const FUTURE_AUTH = uuid(3), FUTURE_APP = uuid(4);
const TEAM_A = uuid(11), TEAM_B = uuid(12);
const REC_A = uuid(21), REC_B = uuid(22), REC_C = uuid(23);
const PROJECT = "r1-synthetic-project";
const PROJECT_PM = "r1-synthetic-pm-project";
const PRE_R1_BASELINE = "20261019130000_pre_w2_hf_draft_submission_delete.sql";
const R1_MIGRATION = "20261020200000_r1_current_state_authorization.sql";
const R1_1_TEAM_LEADER_MIGRATION = "20261020210000_r1_1_team_leader_direct_edit.sql";
const OPTIONAL_ACTION_REASONS_MIGRATION = "20261020220000_r1_1_optional_action_reasons.sql";

async function addActor(db, auth, app, name) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
     values ($1, $2, true, $3)`, [app, auth, name],
  );
}

async function addCurrentCapability(db, app, capability) {
  await db.query(
    `insert into public.direct_entry_capability_grants
       (app_user_id, capability, valid_from, valid_to, is_current)
     values ($1, $2, '2020-01-01', '2021-01-01', true)`, [app, capability],
  );
}

async function seedActorsAndResources(db) {
  await addActor(db, AUTH, APP, "Synthetic Admin");
  await addActor(db, FUTURE_AUTH, FUTURE_APP, "Synthetic Future Actor");
  for (const capability of [
    "entry_admin", "recruiter_master_manage", "team_master_manage",
    "pii_view", "pii_export", "payment_view", "payment_edit",
  ]) await addCurrentCapability(db, APP, capability);
  await db.query(
    `insert into public.teams (team_id, code, display_name, active) values
      ($1, 'R1_TEAM_A', 'Synthetic Team A', true),
      ($2, 'R1_TEAM_B', 'Synthetic Team B', true)`, [TEAM_A, TEAM_B],
  );
  await db.query(
    `insert into public.recruiters (recruiter_id, display_name, active) values
      ($1, 'Synthetic Recruiter A', true), ($2, 'Synthetic Recruiter B', true)`, [REC_A, REC_B],
  );
  await db.query(
    `insert into public.direct_entry_scope_grants
       (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current) values
      ($1, 'all', null, '2020-01-01', '2021-01-01', true),
      ($1, 'team', $2, '2020-01-01', '2021-01-01', true),
      ($1, 'team', $3, '2020-01-01', null, false)`, [APP, TEAM_A, TEAM_B],
  );
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links
       (app_user_id, recruiter_id, verified, valid_from, valid_to, is_current) values
      ($1, $2, true, '2020-01-01', '2021-01-01', true),
      ($1, $3, true, '2010-01-01', '2011-01-01', false)`, [APP, REC_A, REC_B],
  );
  await db.query(
    `insert into public.direct_entry_projects (project_id, display_name, active)
     values ($1, 'Synthetic Project', true)`, [PROJECT],
  );
}

async function seedProjectManager(db) {
  await seedActorsAndResources(db);
  await db.query(
    `insert into public.recruiter_provider_memberships
       (recruiter_id, provider_type, valid_from, is_current)
     values ($1, 'hrp', '2020-01-01', true)`, [REC_A],
  );
  await db.query(
    `insert into public.recruiter_team_memberships
       (recruiter_id, team_id, valid_from, is_current)
     values ($1, $2, '2020-01-01', true)`, [REC_A, TEAM_A],
  );
  const managerAuth = uuid(5), managerApp = uuid(6);
  await addActor(db, managerAuth, managerApp, "Synthetic Project Manager");
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links
       (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1, $2, true, '2020-01-01', true)`, [managerApp, REC_B],
  );
  await db.query(
    `select public.direct_entry_create_project(
      $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text)`,
    [AUTH, APP, PROJECT_PM, "Synthetic PM Project", "create for PM history test", "r1-pm-create"],
  );
  const assignment = (await db.query(
    `select public.direct_entry_assign_project_manager(
      $1::uuid, $2::uuid, $3::text, $4::uuid, null, 1, $5::text, $6::text) as result`,
    [AUTH, APP, PROJECT_PM, REC_B, "assign synthetic PM", "r1-pm-assign"],
  )).rows[0].result;
  return { assignment, managerAuth, managerApp };
}

async function seedStrictTeamLeader(db, {
  auth = uuid(70), app = uuid(71), recruiter = REC_B, team = TEAM_A,
} = {}) {
  await addActor(db, auth, app, "Synthetic Team Leader");
  await addCurrentCapability(db, app, "team_manager_assign");
  await db.query(
    `insert into public.direct_entry_scope_grants
       (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1, 'team', $2, '2020-01-01', true)`, [app, team],
  );
  await db.query(
    `insert into public.recruiter_provider_memberships
       (recruiter_id, provider_type, valid_from, is_current)
     values ($1, 'hrp', '2020-01-01', true)`, [recruiter],
  );
  await db.query(
    `insert into public.recruiter_team_memberships
       (recruiter_id, team_id, valid_from, is_current)
     values ($1, $2, '2020-01-01', true)`, [recruiter, team],
  );
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links
       (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1, $2, true, '2020-01-01', true)`, [app, recruiter],
  );
  await db.query(
    `insert into public.direct_entry_team_leader_assignments
       (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
     values ($1, $2, $3, '2020-01-01', true)`, [team, app, recruiter],
  );
  return { auth, app, recruiter, team };
}

async function insertSyntheticProjectEntry(db, state = "DRAFT", options = {}) {
  const {
    entryId = uuid(7), candidateId = uuid(8), submissionId = uuid(9),
    ownerApp = APP, projectId = PROJECT_PM, employeeSuffix = "000901",
    recruiterId = REC_A, teamId = TEAM_A, displayName = "Synthetic PM Draft",
  } = options;
  const year = (await db.query(
    "select to_char(public.direct_entry_authorization_date(), 'YYYY') as year",
  )).rows[0].year;
  await db.query("begin");
  try {
    await db.query("insert into public.direct_entry_candidates(candidate_id) values ($1)", [candidateId]);
    await db.query(
      "insert into public.direct_entry_submissions(submission_id, created_by_user_id) values ($1, $2)",
      [submissionId, ownerApp],
    );
    await db.query(
      `insert into public.direct_entries (
         entry_id, submission_id, candidate_id, created_by_user_id, project_id,
         first_work_date, employee_code, worker_details, recruiter_id, team_id,
         provider_type, labor_type
       ) values (
         $1, $2, $3, $4, $5, public.direct_entry_authorization_date(), $6,
         $7::jsonb, $8, $9, 'hrp', 'TEMPORARY'
       )`,
      [entryId, submissionId, candidateId, ownerApp, projectId, `hrp-${year}-${employeeSuffix}`, JSON.stringify({
        display_name: displayName,
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      }), recruiterId, teamId],
    );
    if (state === "SUBMITTED") {
      await db.query(
        "update public.direct_entry_submissions set state='SUBMITTED', version=version+1 where submission_id=$1",
        [submissionId],
      );
    }
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
  return { entryId, year };
}

test("R1 current-state backfill handles an existing project-team mapping", async () => {
  const { db } = await buildDb({ throughMigration: PRE_R1_BASELINE });
  try {
    await addActor(db, AUTH, APP, "Synthetic Pre-R1 Admin");
    for (const capability of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)
         values ($1, $2, '2020-01-01')`, [APP, capability],
      );
    }
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)
       values ($1, 'all', '2020-01-01')`, [APP],
    );
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1, 'R1_CUTOVER_TEAM', 'Synthetic Cutover Team', true)`, [TEAM_A],
    );
    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active)
       values ($1, 'Synthetic Cutover Project', true)`, [PROJECT],
    );
    const result = (await db.query(
      `select public.direct_entry_grant_project_team_scope(
        $1::uuid, $2::uuid, $3::text, $4::uuid, 0, '2020-01-01'::date, $5::text, $6::text) as result`,
      [AUTH, APP, PROJECT, TEAM_A, "Synthetic R1 cutover seed", "r1-cutover-seed"],
    )).rows[0].result;
    const migration = await readFile(path.resolve("supabase/migrations", R1_MIGRATION), "utf8");
    await db.exec(migration);
    assert.deepEqual((await db.query(
      `select is_current, version from public.direct_entry_project_team_scopes where mapping_id=$1`,
      [result.mapping_id],
    )).rows[0], { is_current: true, version: 1 },
    "backfill activates the existing mapping without changing its business pair version");
  } finally {
    await db.close();
  }
});

test("R1.1 optional-action-reason migration accepts legacy CRLF function bodies", async () => {
  const { db } = await buildDb({ throughMigration: R1_1_TEAM_LEADER_MIGRATION });
  try {
    const functions = await db.query(
      `select pg_get_functiondef(p.oid) as definition
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
        where n.nspname = 'public' and p.prokind = 'f' and l.lanname = 'plpgsql'
          and p.proname like 'direct_entry_%' and p.proname <> 'direct_entry_reason'
          and p.proargnames @> array['p_reason']::text[]`,
    );
    assert.equal(functions.rows.length, 43);
    for (const { definition } of functions.rows) {
      await db.exec(definition.replace(/\r?\n/g, "\r\n"));
    }
    const crlf = await db.query(
      `select count(*)::integer as count
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
        where n.nspname = 'public' and p.prokind = 'f' and l.lanname = 'plpgsql'
          and p.proname like 'direct_entry_%' and p.proname <> 'direct_entry_reason'
          and p.proargnames @> array['p_reason']::text[]
          and position(chr(13) || chr(10) in p.prosrc) > 0`,
    );
    assert.equal(crlf.rows[0].count, 43, "fixture reproduces PostgreSQL function bodies stored with CRLF");

    await db.exec(await readFile(path.resolve("supabase/migrations", OPTIONAL_ACTION_REASONS_MIGRATION), "utf8"));

    const normalized = await db.query(
      `select count(*)::integer as count
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         join pg_language l on l.oid = p.prolang
        where n.nspname = 'public' and p.prokind = 'f' and l.lanname = 'plpgsql'
          and p.proname like 'direct_entry_%' and p.proname <> 'direct_entry_reason'
          and p.proargnames @> array['p_reason']::text[]
          and position('p_reason := nullif(btrim(p_reason),' in p.prosrc) > 0`,
    );
    assert.equal(normalized.rows[0].count, 43, "all intended RPCs receive optional-reason normalization");
    assert.equal((await db.query(
      `select is_nullable from information_schema.columns
        where table_schema='public' and table_name='direct_entry_change_requests' and column_name='reason_id'`,
    )).rows[0].is_nullable, "YES");
    const reasonAcl = await db.query(
      `select has_function_privilege('direct_entry_catalog_bootstrap_executor',
                'public.direct_entry_reason(uuid,text)', 'EXECUTE') as executor,
              has_function_privilege('service_role', 'public.direct_entry_reason(uuid,text)', 'EXECUTE') as service,
              has_function_privilege('anon', 'public.direct_entry_reason(uuid,text)', 'EXECUTE') as anon,
              has_function_privilege('authenticated', 'public.direct_entry_reason(uuid,text)', 'EXECUTE') as authenticated,
              has_function_privilege('public', 'public.direct_entry_reason(uuid,text)', 'EXECUTE') as public`,
    );
    assert.deepEqual(reasonAcl.rows[0], {
      executor: true, service: false, anon: false, authenticated: false, public: false,
    }, "reason helper remains private to its restricted server-side caller");
  } finally {
    await db.close();
  }
});

test("actor context and capability/scope helpers use only explicit current rows", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);

    const context = (await db.query(
      "select public.direct_entry_resolve_actor_context($1) as context", [AUTH],
    )).rows[0].context;
    assert.deepEqual(Object.keys(context).sort(), [
      "all_scope_grants", "allowed_worker_tabs", "app_user_id", "assigned_roles", "auth_subject", "capabilities",
      "display_name", "effective_grants", "enabled", "recruiter_links", "team_scope_grants", "teams",
    ]);
    assert.deepEqual(context.allowed_worker_tabs, ["recruited", "all"]);
    assert.ok(context.capabilities.includes("entry_admin"));
    for (const retired of ["pii_view", "pii_export", "payment_view", "payment_edit"]) {
      assert.equal(context.capabilities.includes(retired), false, retired);
      assert.equal((await db.query(
        "select public.direct_entry_has_capability($1, $2) as allowed", [APP, retired],
      )).rows[0].allowed, false, retired + " is not an effective capability");
    }
    assert.equal(context.recruiter_links.length, 1);
    assert.equal(context.recruiter_links[0].recruiter_id, REC_A);
    assert.equal(context.recruiter_links[0].valid_to, "2021-01-01",
      "date fields stay available as inert history metadata");
    assert.equal(context.team_scope_grants.length, 1);
    assert.equal(context.team_scope_grants[0].team_id, TEAM_A);
    assert.equal(context.all_scope_grants.length, 1);
    assert.deepEqual(context.teams.map((team) => team.team_id), [TEAM_A]);

    assert.equal((await db.query(
      "select public.direct_entry_has_capability($1, 'entry_admin') as allowed", [APP],
    )).rows[0].allowed, true, "a current marker stays authoritative after its legacy date interval");
    assert.deepEqual((await db.query(
      "select public.direct_entry_has_scope($1, 'all') as allowed", [APP],
    )).rows[0].allowed, true);
    assert.equal((await db.query(
      "select public.direct_entry_has_scope($1, 'team') as allowed", [APP],
    )).rows[0].allowed, true);

    // A scheduled row starts false, and changing only its dates never promotes it.
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)
       values ($1, 'all', '2099-01-01')`, [FUTURE_APP],
    );
    assert.equal((await db.query(
      "select is_current from public.direct_entry_scope_grants where app_user_id=$1", [FUTURE_APP],
    )).rows[0].is_current, false);
    assert.equal((await db.query(
      "select public.direct_entry_has_scope($1, 'all') as allowed", [FUTURE_APP],
    )).rows[0].allowed, false);
    await db.query(
      `update public.direct_entry_scope_grants set valid_from='2020-01-01'
       where app_user_id=$1`, [FUTURE_APP],
    );
    assert.equal((await db.query(
      "select public.direct_entry_has_scope($1, 'all') as allowed", [FUTURE_APP],
    )).rows[0].allowed, false, "date-only changes do not activate scheduled authority");
    const futureContext = (await db.query(
      "select public.direct_entry_resolve_actor_context($1) as context", [FUTURE_AUTH],
    )).rows[0].context;
    assert.deepEqual(futureContext.all_scope_grants, []);
  } finally {
    await db.close();
  }
});

test("project-team grant/revoke is transactional current state, not an interval comparison", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    const futureDate = "2999-01-01";
    await assert.rejects(
      db.query(
        `select public.direct_entry_grant_project_team_scope(
          $1::uuid,$2::uuid,$3::text,$4::uuid,0,$5::date,null,'r1-future-scope')`,
        [AUTH, APP, PROJECT, TEAM_A, futureDate],
      ),
      (error) => error.code === "22023",
      "the audited grant RPC cannot create future active authority",
    );

    const result = (await db.query(
        `select public.direct_entry_grant_project_team_scope(
          $1::uuid,$2::uuid,$3::text,$4::uuid,0,null,null,'r1-current-scope') as result`,
      [AUTH, APP, PROJECT, TEAM_A],
    )).rows[0].result;
    const mappingId = result.mapping_id;
    assert.ok(mappingId);
    assert.deepEqual((await db.query(
      `select is_current, reason_id from public.direct_entry_project_team_scopes where mapping_id=$1`, [mappingId],
    )).rows[0], { is_current: true, reason_id: null },
    "the grant remains current without a placeholder reason row");
    const pairVersion = (await db.query(
      `select version from public.direct_entry_project_team_scopes where mapping_id=$1`, [mappingId],
    )).rows[0].version;
    await db.query(
      `update public.direct_entry_project_team_scopes set is_current=false where mapping_id=$1`, [mappingId],
    );
    await db.query(
      `update public.direct_entry_project_team_scopes set is_current=true where mapping_id=$1`, [mappingId],
    );
    assert.equal((await db.query(
      `select version from public.direct_entry_project_team_scopes where mapping_id=$1`, [mappingId],
    )).rows[0].version, pairVersion, "current-state marker changes leave the project/team pair version untouched");
    assert.equal((await db.query(
      "select public.direct_entry_project_team_scope_effective($1,$2) as allowed", [PROJECT, TEAM_A],
    )).rows[0].allowed, true);

    await db.query(
      `select public.direct_entry_revoke_project_team_scope(
        $1::uuid,$2::uuid,$3::uuid,null,null,'r1-revoke-scope')`,
      [AUTH, APP, mappingId],
    );
    assert.deepEqual((await db.query(
      `select is_current, revoke_reason_id from public.direct_entry_project_team_scopes where mapping_id=$1`, [mappingId],
    )).rows[0], { is_current: false, revoke_reason_id: null },
    "revocation metadata stays complete while its action reason remains optional");
    assert.equal((await db.query(
      "select public.direct_entry_project_team_scope_effective($1,$2) as allowed", [PROJECT, TEAM_A],
    )).rows[0].allowed, false, "revoke denies the next request");
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where resource_ref=$1 and action in ('project_team_scope_grant','project_team_scope_revoke')
          and outcome='APPLIED'`, [mappingId],
    )).rows[0].n, 2);
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where resource_ref=$1 and action in ('project_team_scope_grant','project_team_scope_revoke')
          and outcome='APPLIED' and reason_id is not null`, [mappingId],
    )).rows[0].n, 0, "both auditable scope operations omit fake reason records");
  } finally {
    await db.close();
  }
});

test("project deactivation preserves PM draft and history authority until explicit unassign", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_A],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_A, TEAM_A],
    );
    const managerAuth = uuid(5), managerApp = uuid(6);
    await addActor(db, managerAuth, managerApp, "Synthetic Project Manager");
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1, $2, true, '2020-01-01', true)`, [managerApp, REC_B],
    );

    await db.query(
      `select public.direct_entry_create_project(
        $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text)`,
      [AUTH, APP, PROJECT_PM, "Synthetic PM Project", "create for PM history test", "r1-pm-create"],
    );
    const assignment = (await db.query(
      `select public.direct_entry_assign_project_manager(
        $1::uuid, $2::uuid, $3::text, $4::uuid, null, 1, $5::text, $6::text) as result`,
      [AUTH, APP, PROJECT_PM, REC_B, "assign synthetic PM", "r1-pm-assign"],
    )).rows[0].result;
    const entryId = uuid(7), candidateId = uuid(8), submissionId = uuid(9);
    const year = (await db.query(
      "select to_char(public.direct_entry_authorization_date(), 'YYYY') as year",
    )).rows[0].year;
    await db.query("begin");
    await db.query("insert into public.direct_entry_candidates(candidate_id) values ($1)", [candidateId]);
    await db.query(
      "insert into public.direct_entry_submissions(submission_id, created_by_user_id) values ($1, $2)",
      [submissionId, APP],
    );
    await db.query(
      `insert into public.direct_entries (
         entry_id, submission_id, candidate_id, created_by_user_id, project_id,
         first_work_date, employee_code, worker_details, recruiter_id, team_id,
         provider_type, labor_type
       ) values (
         $1, $2, $3, $4, $5, public.direct_entry_authorization_date(),
         'hrp-' || to_char(public.direct_entry_authorization_date(), 'YYYY') || '-000901',
         $6::jsonb, $7, $8, 'hrp', 'TEMPORARY'
       )`,
      [entryId, submissionId, candidateId, APP, PROJECT_PM, JSON.stringify({
        display_name: "Synthetic PM Draft",
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      }), REC_A, TEAM_A],
    );
    await db.query("commit");
    const draftUpdate = (await db.query(
      `select public.direct_entry_update_draft_row(
        $1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::text) as result`,
      [managerAuth, managerApp, entryId,
        JSON.stringify({ employee_code: `hrp-${year}-000902` }), "r1-pm-draft-update"],
    )).rows[0].result;
    assert.equal(draftUpdate.version, 2,
      "a current project-manager assignment retains the existing scoped DRAFT edit authority");
    assert.deepEqual((await db.query(
      "select employee_code, version from public.direct_entries where entry_id = $1", [entryId],
    )).rows[0], { employee_code: `hrp-${year}-000902`, version: 2 });
    await addCurrentCapability(db, APP, "submission_create");
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'own', null, '2020-01-01', true)`, [APP],
    );
    await db.query(
      `select public.direct_entry_transition_submission_apply(
        $1::uuid, $2::uuid, $3::uuid, 2, 'SUBMITTED', $4::text, null, null)`,
      [AUTH, APP, submissionId, "r1-pm-submit"],
    );

    await db.query(
      `select public.direct_entry_set_project_active(
        $1::uuid, $2::uuid, $3::text, false, 2, $4::text, $5::text)`,
      [AUTH, APP, PROJECT_PM, "deactivate synthetic project", "r1-pm-deactivate"],
    );
    await db.query(
      `update public.direct_entry_project_manager_assignments
          set version = version + 1 where assignment_id = $1`,
      [assignment.assignment_id],
    );
    assert.deepEqual((await db.query(
      `select is_current, valid_to::text as valid_to from public.direct_entry_project_manager_assignments
        where assignment_id = $1`, [assignment.assignment_id],
    )).rows[0], { is_current: true, valid_to: null });
    assert.equal((await db.query(
      `select public.direct_entry_actor_can_access_project($1, $2) as allowed`,
      [managerApp, PROJECT_PM],
    )).rows[0].allowed, true,
    "deactivation hides new-work choices but keeps the manager's history authority");
    const managedWorkers = (await db.query(
      `select public.direct_entry_list_workers(
         $1::uuid, $2::uuid, 'managed', $3::text, null, null, null, 25) as result`,
      [managerAuth, managerApp, PROJECT_PM],
    )).rows[0].result.items;
    assert.deepEqual(managedWorkers.map((worker) => worker.entry_id), [entryId],
      "managed history read retains the existing row after project deactivation");

    await db.query(
      `select public.direct_entry_unassign_project_manager(
        $1::uuid, $2::uuid, $3::uuid, 2, 3, $4::text, $5::text)`,
      [AUTH, APP, assignment.assignment_id, "unassign synthetic PM", "r1-pm-unassign"],
    );
    assert.deepEqual((await db.query(
      `select is_current, valid_to::text as valid_to from public.direct_entry_project_manager_assignments
        where assignment_id = $1`, [assignment.assignment_id],
    )).rows[0], { is_current: false, valid_to: await db.query(
      "select public.direct_entry_authorization_date()::text as today").then((r) => r.rows[0].today) });
    assert.equal((await db.query(
      `select public.direct_entry_actor_can_access_project($1, $2) as allowed`,
      [managerApp, PROJECT_PM],
    )).rows[0].allowed, false, "explicit unassign revokes the history authority");
    await assert.rejects(
      db.query(
        `select public.direct_entry_list_workers(
          $1::uuid, $2::uuid, 'managed', $3::text, null, null, null, 25)`,
        [managerAuth, managerApp, PROJECT_PM],
      ),
      (error) => error.code === "42501",
      "managed history read is denied after explicit unassign",
    );
  } finally {
    await db.close();
  }
});

test("PM assignment authority fails closed for ambiguous links and revoked rows", async () => {
  const { db } = await buildDb();
  try {
    const { assignment, managerApp } = await seedProjectManager(db);
    await db.query(
      `insert into public.direct_entry_project_manager_assignments (
         project_id, manager_recruiter_id, valid_from, valid_to, revoked_at, is_current
       ) values ($1, $2, '2020-01-01', '2020-01-02', now(), true)`,
      [PROJECT_PM, REC_B],
    );
    assert.equal((await db.query(
      `select is_current from public.direct_entry_project_manager_assignments
        where project_id=$1 and manager_recruiter_id=$2 and revoked_at is not null`,
      [PROJECT_PM, REC_B],
    )).rows[0].is_current, false,
    "a pre-revoked row cannot be marked current by the insert trigger");
    assert.equal((await db.query(
      "select public.direct_entry_project_assignment_effective($1, $2) as allowed",
      [managerApp, PROJECT_PM],
    )).rows[0].allowed, true, "the unique current link retains PM authority");

    const duplicateAuth = uuid(30), duplicateApp = uuid(31);
    await addActor(db, duplicateAuth, duplicateApp, "Synthetic Duplicate PM Link");
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, valid_to, is_current)
       values ($1, $2, true, '2015-01-01', '2019-01-01', true)`, [duplicateApp, REC_B],
    );
    assert.equal((await db.query(
      "select public.direct_entry_project_assignment_effective($1, $2) as allowed",
      [managerApp, PROJECT_PM],
    )).rows[0].allowed, false,
    "two current verified links make PM authority ambiguous for the original actor");
    assert.equal((await db.query(
      "select public.direct_entry_project_assignment_effective($1, $2) as allowed",
      [duplicateApp, PROJECT_PM],
    )).rows[0].allowed, false,
    "the second linked app user cannot inherit a PM assignment");
    await assert.rejects(
      db.query(
        `select public.direct_entry_list_workers(
          $1::uuid, $2::uuid, 'managed', $3::text, null, null, null, 25)`,
        [duplicateAuth, duplicateApp, PROJECT_PM],
      ),
      (error) => error.code === "42501",
      "managed directory reads reject ambiguous recruiter links",
    );
    const secondProject = `${PROJECT_PM}-duplicate-link`;
    await db.query(
      `select public.direct_entry_create_project(
        $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text)`,
      [AUTH, APP, secondProject, "Synthetic duplicate-link project", "duplicate-link rejection test", "r1-pm-create-second"],
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_assign_project_manager(
          $1::uuid, $2::uuid, $3::text, $4::uuid, null, 1, $5::text, $6::text)`,
        [AUTH, APP, secondProject, REC_B, "ambiguous PM link must be rejected", "r1-pm-assign-duplicate"],
      ),
      (error) => error.code === "22023",
      "the audited assignment mutation rejects an ambiguous manager link",
    );
    assert.equal((await db.query(
      `select is_current from public.direct_entry_project_manager_assignments where assignment_id=$1`,
      [assignment.assignment_id],
    )).rows[0].is_current, true,
    "the assignment remains current while the helper denies ambiguous link state");
  } finally {
    await db.close();
  }
});

test("own DRAFT wrapper preserves omitted payments and explicit updates, OCC, audit and guards", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_A],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_A, TEAM_A],
    );
    const ownerAuth = uuid(50), ownerApp = uuid(51);
    await addActor(db, ownerAuth, ownerApp, "Synthetic Own Draft Actor");
    await addCurrentCapability(db, ownerApp, "entry_own");
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'own', null, '2020-01-01', true)`, [ownerApp],
    );
    const { entryId } = await insertSyntheticProjectEntry(db, "DRAFT", {
      entryId: uuid(52), candidateId: uuid(53), submissionId: uuid(54),
      ownerApp, projectId: PROJECT, employeeSuffix: "000952",
    });
    await db.query(
      `insert into public.direct_entry_banks (bank_id, display_name)
       values ('hf2-synthetic-bank', 'HF2 Synthetic Bank')`,
    );
    await db.query(
      `insert into public.direct_entry_payments (
         entry_id, state, account_number, bank_id, bank_name, account_holder_name, version
       ) values ($1, 'provided', '000098765432', 'hf2-synthetic-bank',
         'HF2 Synthetic Bank', 'HF2 Synthetic Holder', 4)`, [entryId],
    );
    await db.query(
      `select public.direct_entry_update_own_draft_row(
        $1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::text)`,
      [ownerAuth, ownerApp, entryId, JSON.stringify({ general_note: "Synthetic unrelated edit" }),
        "r1-own-draft-unrelated-edit"],
    );
    assert.deepEqual((await db.query(
      `select general_note, version from public.direct_entries where entry_id=$1`, [entryId],
    )).rows[0], { general_note: "Synthetic unrelated edit", version: 2 });
    assert.deepEqual((await db.query(
      `select state, account_number, bank_id, bank_name, account_holder_name, version
         from public.direct_entry_payments where entry_id=$1`, [entryId],
    )).rows[0], {
      state: "provided", account_number: "000098765432", bank_id: "hf2-synthetic-bank",
      bank_name: "HF2 Synthetic Bank", account_holder_name: "HF2 Synthetic Holder", version: 4,
    }, "an unrelated draft edit leaves the complete saved payment row unchanged");
    const patch = {
      general_note: "Synthetic payment edit",
      payment: {
        state: "provided",
        account_number: "000012345678",
        bank_name: "Synthetic Bank",
        account_holder_name: "Synthetic Holder",
      },
    };
    await db.query(
      `select public.direct_entry_update_own_draft_row(
        $1::uuid, $2::uuid, $3::uuid, 2, $4::jsonb, $5::text)`,
      [ownerAuth, ownerApp, entryId, JSON.stringify(patch), "r1-own-draft-update"],
    );
    assert.deepEqual((await db.query(
      `select general_note, version from public.direct_entries where entry_id=$1`, [entryId],
    )).rows[0], { general_note: "Synthetic payment edit", version: 3 });
    assert.deepEqual((await db.query(
      `select state, account_number, bank_id, bank_name, account_holder_name, version
         from public.direct_entry_payments where entry_id=$1`, [entryId],
    )).rows[0], {
      state: "provided", account_number: "000012345678", bank_id: null,
      bank_name: "Synthetic Bank", account_holder_name: "Synthetic Holder", version: 5,
    }, "an explicit payment edit keeps leading zeros and increments payment OCC");
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_revisions where entry_id=$1`, [entryId],
    )).rows[0].n, 2, "each allowed draft edit records one row revision");
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where resource_ref=$1 and action='draft_row_update' and outcome='APPLIED'`, [entryId],
    )).rows[0].n, 2, "one applied audit event records each edit");

    await assert.rejects(
      db.query(
        `select public.direct_entry_update_own_draft_row(
          $1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::text)`,
        [ownerAuth, ownerApp, entryId, JSON.stringify({ general_note: "stale" }), "r1-own-draft-stale"],
      ),
      (error) => error.code === "PT409",
      "the owner wrapper preserves strict entry OCC",
    );

    const { entryId: otherEntryId } = await insertSyntheticProjectEntry(db, "DRAFT", {
      entryId: uuid(55), candidateId: uuid(56), submissionId: uuid(57),
      ownerApp: APP, projectId: PROJECT, employeeSuffix: "000953",
    });
    await assert.rejects(
      db.query(
        `select public.direct_entry_update_own_draft_row(
          $1::uuid, $2::uuid, $3::uuid, 1, $4::jsonb, $5::text)`,
        [ownerAuth, ownerApp, otherEntryId, JSON.stringify({ general_note: "other owner" }), "r1-own-draft-other-owner"],
      ),
      (error) => error.code === "42501",
      "the owner wrapper denies another owner's draft row",
    );

    await db.query(
      `update public.direct_entry_submissions set state='SUBMITTED', version=version+1
        where submission_id=$1`, [uuid(54)],
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_update_own_draft_row(
          $1::uuid, $2::uuid, $3::uuid, 3, $4::jsonb, $5::text)`,
        [ownerAuth, ownerApp, entryId, JSON.stringify({ general_note: "submitted" }), "r1-own-draft-submitted"],
      ),
      (error) => error.code === "42501",
      "the owner wrapper denies submitted rows",
    );
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where resource_ref=$1 and action='draft_row_update' and outcome='APPLIED'`, [entryId],
    )).rows[0].n, 2, "denied retries do not create extra applied audit events");
  } finally {
    await db.close();
  }
});

test("R1.1 projects team edit scope and preserves strict current-team direct-edit authority", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    const reasonCountBeforeBlank = (await db.query(
      `select count(*)::int as n from public.direct_entry_restricted_reasons where actor_user_id=$1`, [APP],
    )).rows[0].n;
    assert.equal((await db.query(
      `select public.direct_entry_reason($1, null) as reason_id`, [APP],
    )).rows[0].reason_id, null);
    assert.equal((await db.query(
      `select public.direct_entry_reason($1, '   ') as reason_id`, [APP],
    )).rows[0].reason_id, null);
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_restricted_reasons where actor_user_id=$1`, [APP],
    )).rows[0].n, reasonCountBeforeBlank,
    "omitted and blank reasons normalize to NULL without creating restricted-reason rows");
    await assert.rejects(
      db.query(`select public.direct_entry_reason($1, $2)`, [APP, "x".repeat(4001)]),
      (error) => error.code === "22023",
      "the restricted-reason boundary retains its existing 4,000 character maximum",
    );
    const leader = await seedStrictTeamLeader(db);
    await addCurrentCapability(db, APP, "entry_privileged_edit");
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_A],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_A, TEAM_A],
    );
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, active)
       values ($1, 'Synthetic Team B Worker', true)`, [REC_C],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_C],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_C, TEAM_B],
    );

    const targetProject = "r1-synthetic-team-target";
    await db.query(
      `insert into public.direct_entry_projects(project_id, display_name, active)
       values ($1, 'Synthetic Team Target', true)`, [targetProject],
    );
    const mapReason = (await db.query(
      `select public.direct_entry_reason($1, 'Synthetic project team mapping') as reason_id`, [APP],
    )).rows[0].reason_id;
    await db.query(
      `insert into public.direct_entry_project_team_scopes
         (project_id, team_id, valid_from, version, granted_by_user_id, reason_id, is_current)
       values ($1, $2, '2020-01-01', 1, $3, $4, true),
              ($5, $2, '2020-01-01', 1, $3, $4, true)`,
      [PROJECT, TEAM_A, APP, mapReason, targetProject],
    );

    const { entryId: inTeamEntry } = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(72), candidateId: uuid(73), submissionId: uuid(74),
      projectId: PROJECT, employeeSuffix: "000972", recruiterId: REC_A, teamId: TEAM_A,
    });
    const { entryId: outsideEntry } = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(75), candidateId: uuid(76), submissionId: uuid(77),
      projectId: PROJECT, employeeSuffix: "000973", recruiterId: REC_C, teamId: TEAM_B,
    });
    const statusReason = (await db.query(
      `select public.direct_entry_reason($1, 'Synthetic initial status') as reason_id`, [APP],
    )).rows[0].reason_id;
    const authDate = (await db.query(
      `select public.direct_entry_authorization_date()::text as date`,
    )).rows[0].date;
    await db.query(
      `insert into public.direct_entry_employment_status_events
         (entry_id, status, effective_date, version, actor_user_id, reason_id)
       values ($1, 'UNCONFIRMED', $2, 1, $3, $4)`,
      [inTeamEntry, authDate, APP, statusReason],
    );

    assert.equal((await db.query(
      `select public.direct_entry_assert_team_leader_current_team($1, $2, $3) as team_id`,
      [leader.auth, leader.app, TEAM_A],
    )).rows[0].team_id, TEAM_A);

    const teamPage = (await db.query(
      `select public.direct_entry_list_workers($1, $2, 'team', null, null, null, null, 25) as data`,
      [leader.auth, leader.app],
    )).rows[0].data;
    assert.equal(teamPage.scope, "team");
    assert.deepEqual(teamPage.items.map((row) => row.entry_id), [inTeamEntry],
      "Team Leader directory only returns rows in its one current team");
    assert.equal(teamPage.items[0].allowed_actions.direct_edit, true,
      "direct edit is projected by the server for an in-team row");

    await db.query(
      `update public.direct_entry_scope_grants set is_current=false
        where app_user_id=$1 and scope_kind='team' and team_id=$2`, [APP, TEAM_A],
    );
    const adminPage = (await db.query(
      `select public.direct_entry_list_workers($1, $2, 'all', null, null, null, null, 25) as data`,
      [AUTH, APP],
    )).rows[0].data;
    assert.equal(adminPage.items.find((row) => row.entry_id === inTeamEntry)
      .allowed_actions.direct_edit, true, "the existing Admin/BoD edit action remains projected");

    assert.equal((await db.query(
      `select public.direct_entry_has_entry_access($1, 'entry_privileged_edit', $2, $3, $4) as allowed`,
      [leader.app, APP, TEAM_A, authDate],
    )).rows[0].allowed, false,
    "the Team Leader is not granted the existing all-scope edit capability");
    await assert.rejects(
      db.query(
        `select public.direct_entry_read_projection($1, $2, $3)`,
        [leader.auth, leader.app, outsideEntry],
      ),
      (error) => error.code === "42501",
      "Team Leader row detail is denied outside the current team",
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 1, $4::jsonb, 'outside team attempt', 'r1-1-outside-team')`,
        [leader.auth, leader.app, outsideEntry, JSON.stringify({ employee_code: "outside" })],
      ),
      (error) => error.code === "42501",
      "direct_edit RPC remains the final authority for out-of-team rows",
    );

    const onResult = (await db.query(
      `select public.direct_entry_privileged_edit(
        $1, $2, $3, 1, $4::jsonb, null, 'r1-1-team-on') as result`,
      [leader.auth, leader.app, inTeamEntry, JSON.stringify({ employment_status: {
        status: "ON", effective_date: authDate,
      } })],
    )).rows[0].result;
    assert.equal(onResult.version, 2);
    const onReplay = (await db.query(
      `select public.direct_entry_privileged_edit(
        $1, $2, $3, 1, $4::jsonb, '   ', 'r1-1-team-on') as result`,
      [leader.auth, leader.app, inTeamEntry, JSON.stringify({ employment_status: {
        status: "ON", effective_date: authDate,
      } })],
    )).rows[0].result;
    assert.deepEqual(onReplay, onResult,
      "NULL and blank normalize before idempotency hashing and replay the same result");
    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 2, $4::jsonb, $5, 'r1-1-long-reason')`,
        [leader.auth, leader.app, inTeamEntry,
          JSON.stringify({ employee_code: `hrp-${authDate.slice(0, 4)}-999999` }), "x".repeat(1001)],
      ),
      (error) => error.code === "22023",
      "the privileged-edit endpoint retains its narrower 1,000 character reason maximum",
    );
    assert.deepEqual((await db.query(
      `select status, leave_reason_text, version from public.direct_entry_employment_status_events
        where entry_id = $1 order by version desc limit 1`, [inTeamEntry],
    )).rows[0], { status: "ON", leave_reason_text: null, version: 2 });
    assert.deepEqual((await db.query(
      `select reason_id from public.direct_entry_employment_status_events
        where entry_id=$1 order by version desc limit 1`, [inTeamEntry],
    )).rows[0], { reason_id: null }, "the ON event retains its history with no placeholder reason");

    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 2, $4::jsonb, 'missing leave reason', 'r1-1-team-off-missing-reason')`,
        [leader.auth, leader.app, inTeamEntry, JSON.stringify({
          employment_status: { status: "OFF", effective_date: authDate },
        })],
      ),
      (error) => ["22023", "23514"].includes(error.code),
      "OFF remains invalid without a nonblank leave reason",
    );

    const offPatch = { employment_status: {
      status: "OFF", effective_date: authDate, leave_reason: "Synthetic leave reason required for OFF",
    } };
    const offResult = (await db.query(
      `select public.direct_entry_privileged_edit($1, $2, $3, 2, $4::jsonb, $5, $6) as result`,
      [leader.auth, leader.app, inTeamEntry, JSON.stringify(offPatch), "   ", "r1-1-team-off"],
    )).rows[0].result;
    assert.equal(offResult.version, 3);
    assert.deepEqual((await db.query(
      `select status, leave_reason_text, version from public.direct_entry_employment_status_events
        where entry_id = $1 order by version desc limit 1`, [inTeamEntry],
    )).rows[0], {
      status: "OFF", leave_reason_text: "Synthetic leave reason required for OFF", version: 3,
    }, "Team Leader OFF change preserves mandatory leave reason and event history");
    assert.deepEqual((await db.query(
      `select reason_id from public.direct_entry_employment_status_events
        where entry_id=$1 order by version desc limit 1`, [inTeamEntry],
    )).rows[0], { reason_id: null },
    "OFF keeps its required leave reason independently from the optional action reason");

    const projectResult = (await db.query(
      `select public.direct_entry_privileged_edit(
        $1, $2, $3, 3, $4::jsonb, 'Move within team project', 'r1-1-team-project') as result`,
      [leader.auth, leader.app, inTeamEntry, JSON.stringify({ project_id: targetProject })],
    )).rows[0].result;
    assert.equal(projectResult.version, 4, "old and proposed project/team scopes are both current");
    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 4, $4::jsonb, 'Move outside team', 'r1-1-team-project-outside')`,
        [leader.auth, leader.app, inTeamEntry, JSON.stringify({ recruiter_id: REC_C })],
      ),
      (error) => error.code === "42501",
      "a proposed recruiter on another team is denied before the row changes",
    );
    assert.deepEqual((await db.query(
      `select recruiter_id, team_id, project_id, version from public.direct_entries where entry_id=$1`,
      [inTeamEntry],
    )).rows[0], { recruiter_id: REC_A, team_id: TEAM_A, project_id: targetProject, version: 4 });
    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 3, $4::jsonb, 'Stale edit', 'r1-1-team-stale')`,
        [leader.auth, leader.app, inTeamEntry, JSON.stringify({ employee_code: "stale" })],
      ),
      (error) => error.code === "PT409",
      "direct Team Leader edits keep strict OCC after the scoped authorization path",
    );
    assert.equal((await db.query(
      `select count(*)::int as n from public.direct_entry_audit_events
        where app_user_id=$1 and action='entry_privileged_edit' and outcome='APPLIED'
          and scope_kind='team' and scope_team_id=$2`, [leader.app, TEAM_A],
    )).rows[0].n, 3, "successful ON/OFF and project changes are audited as team-scoped");

    const teamExport = (await db.query(
      `select public.direct_entry_export_workers(
        $1, $2, 'team', null, null, null, 'Synthetic team export reason') as data`,
      [leader.auth, leader.app],
    )).rows[0].data;
    assert.equal(teamExport.status, "ok");
    assert.equal(teamExport.rows.length, 1);
    assert.equal(teamExport.rows[0].employee_code, `hrp-${authDate.slice(0, 4)}-000972`);
    assert.equal((await db.query(
      `select scope_kind from public.direct_entry_audit_events
        where app_user_id=$1 and action='worker_export' order by created_at desc limit 1`,
      [leader.app],
    )).rows[0].scope_kind, "team", "team export uses the same strict team audience and audit scope");

    await assert.rejects(
      db.query(
        `select public.direct_entry_assert_team_leader_current_team($1, $2, null)`, [AUTH, APP],
      ),
      (error) => error.code === "42501",
      "a full catalog operator cannot inherit Team Leader proof through the isolated bypass",
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_worker_directory_audience($1, $2, 'team', null)`, [AUTH, APP],
      ),
      (error) => error.code === "42501",
      "the catalog-operator branch does not authorize the Team Leader team directory scope",
    );

    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'team', $2, '2020-01-01', true)`, [leader.app, TEAM_B],
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_assert_team_leader_current_team($1, $2, null)`,
        [leader.auth, leader.app],
      ),
      (error) => error.code === "42501",
      "ambiguous multiple current team scopes fail closed",
    );
    await db.query(
      `update public.direct_entry_scope_grants set is_current=false
        where app_user_id=$1 and scope_kind='team' and team_id=$2`, [leader.app, TEAM_B],
    );
    await db.query("begin");
    await db.query("select set_config('direct_entry.team_leader_marker', 'on', true)");
    await db.query(
      `update public.direct_entry_team_leader_assignments
          set valid_to=valid_from, is_current=false
        where team_id=$1 and leader_app_user_id=$2`, [TEAM_A, leader.app],
    );
    await db.query("commit");
    await assert.rejects(
      db.query(
        `select public.direct_entry_assert_team_leader_current_team($1, $2, null)`,
        [leader.auth, leader.app],
      ),
      (error) => error.code === "42501",
      "revoked Team Leader assignment no longer authorizes current-team reads or edits",
    );

    const ambiguousAuth = uuid(80), ambiguousApp = uuid(81);
    await addActor(db, ambiguousAuth, ambiguousApp, "Synthetic Ambiguous Team Leader");
    await addCurrentCapability(db, ambiguousApp, "team_manager_assign");
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'team', $2, '2020-01-01', true)`, [ambiguousApp, TEAM_B],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1, $2, true, '2020-01-01', true)`, [ambiguousApp, REC_C],
    );
    await db.query(
      `insert into public.direct_entry_team_leader_assignments
         (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
       values ($1, $2, $3, '2020-01-01', true)`, [TEAM_B, ambiguousApp, REC_C],
    );
    await db.query(
      `update public.direct_entry_app_user_recruiter_links
          set valid_to='2021-01-01'
        where app_user_id=$1 and recruiter_id=$2`, [ambiguousApp, REC_C],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1, $2, true, '2021-01-01', true)`, [ambiguousApp, REC_A],
    );
    await assert.rejects(
      db.query(
        `select public.direct_entry_assert_team_leader_current_team($1, $2, null)`,
        [ambiguousAuth, ambiguousApp],
      ),
      (error) => error.code === "42501",
      "ambiguous current recruiter links fail closed even when their history intervals do not overlap",
    );
  } finally {
    await db.close();
  }
});

test("R1.2 search and direct edit use current scope across overlapping directory audiences", async () => {
  const { db } = await buildDb();
  try {
    const seededManager = await seedProjectManager(db);
    const manager = { auth: seededManager.managerAuth, app: seededManager.managerApp };
    await addCurrentCapability(db, APP, "entry_privileged_edit");
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_B],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_B, TEAM_A],
    );
    const otherProject = "r1-2-synthetic-project-b";
    await db.query(
      `insert into public.direct_entry_projects(project_id, display_name, active)
       values ($1, 'Synthetic Project B', true)`, [otherProject],
    );

    const projectTeamEntry = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(91), candidateId: uuid(92), submissionId: uuid(93),
      projectId: PROJECT_PM, employeeSuffix: "000021", recruiterId: REC_B, teamId: TEAM_A,
      displayName: "NGUYỄN VĂN ÁNH",
    });
    const projectOnlyEntry = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(94), candidateId: uuid(95), submissionId: uuid(96),
      projectId: PROJECT_PM, employeeSuffix: "000022", recruiterId: REC_B, teamId: TEAM_A,
    });
    const outsideEntry = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(97), candidateId: uuid(98), submissionId: uuid(99),
      projectId: otherProject, employeeSuffix: "000023", recruiterId: REC_B, teamId: TEAM_A,
    });
    const statusReason = (await db.query(
      `select public.direct_entry_reason($1, 'Synthetic initial status') as reason_id`, [APP],
    )).rows[0].reason_id;
    const authDate = (await db.query(
      `select public.direct_entry_authorization_date()::text as date`,
    )).rows[0].date;
    await db.query(
      `insert into public.direct_entry_employment_status_events
         (entry_id, status, effective_date, version, actor_user_id, reason_id)
       values ($1, 'UNCONFIRMED', $3, 1, $4, $5),
              ($2, 'UNCONFIRMED', $3, 1, $4, $5)`,
      [projectTeamEntry.entryId, projectOnlyEntry.entryId, authDate, APP, statusReason],
    );

    const directory = async (actor, scope, search = null, cursor = null, pageSize = 25,
      projectId = null, recruiterId = null, status = null) => (await db.query(
      `select public.direct_entry_list_workers(
        $1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::text, $7::text, $8::integer, $9::text
      ) as data`,
      [actor.auth, actor.app, scope, projectId, recruiterId, status, cursor, pageSize, search],
    )).rows[0].data;

    const managedPage = await directory(manager, "managed");
    assert.deepEqual(managedPage.items.map((row) => row.entry_id).sort(),
      [projectTeamEntry.entryId, projectOnlyEntry.entryId].sort());
    assert.ok(managedPage.items.every((row) => row.allowed_actions.direct_edit),
      "current PM direct-edit authority is projected for every row in the assigned project");
    const recruitedPage = await directory(manager, "recruited");
    const actionByEntry = new Map(recruitedPage.items.map((row) => [row.entry_id, row.allowed_actions.direct_edit]));
    assert.equal(actionByEntry.get(projectTeamEntry.entryId), true);
    assert.equal(actionByEntry.get(projectOnlyEntry.entryId), true);
    assert.equal(actionByEntry.get(outsideEntry.entryId), false,
      "a PM's managed tab is not used to authorize a row in another project");

    const accentedSearch = await directory(manager, "recruited", "nguyễn văn");
    assert.deepEqual(accentedSearch.items.map((row) => row.entry_id), [projectTeamEntry.entryId],
      "database search is case-insensitive for Vietnamese names");
    const filteredSearch = await directory(manager, "recruited", "00002", null, 25,
      PROJECT_PM, REC_B, "UNCONFIRMED");
    assert.equal(filteredSearch.summary.total_workers, 2,
      "search summary reflects search plus status, project, recruiter and scope filters");
    assert.equal((await directory(manager, "recruited", "%")).summary.total_workers, 0,
      "wildcard characters are literal and are not expanded by SQL");

    let cursor = null;
    const pagedIds = [];
    for (let index = 0; index < 3; index += 1) {
      const result = await directory(manager, "recruited", "00002", cursor, 1);
      assert.equal(result.summary.total_workers, 3);
      assert.equal(result.items.length, 1);
      pagedIds.push(result.items[0].entry_id);
      cursor = result.next_cursor;
      assert.equal(result.has_more, index < 2);
    }
    assert.equal(new Set(pagedIds).size, 3, "search pagination neither repeats nor skips rows");
    assert.equal((await directory(manager, "recruited", "000021")).items[0].employee_code,
      `hrp-${projectTeamEntry.year}-000021`, "employee-code search preserves leading zeroes");

    await assert.rejects(directory(manager, "recruited", "x".repeat(101)),
      (error) => error.code === "22023", "the RPC enforces the bounded search contract too");
    const outsider = { auth: uuid(101), app: uuid(102) };
    await addActor(db, outsider.auth, outsider.app, "Synthetic Out-of-Scope Staff");
    await assert.rejects(directory(outsider, "recruited", "000021"),
      (error) => error.code === "42501", "search does not expand recruiter or project scope");

    const pmEdit = (await db.query(
      `select public.direct_entry_privileged_edit(
        $1, $2, $3, 1, $4::jsonb, null, 'r1-2-pm-edit') as result`,
      [manager.auth, manager.app, projectOnlyEntry.entryId, JSON.stringify({
        employment_status: { status: "ON", effective_date: authDate },
      })],
    )).rows[0].result;
    assert.equal(pmEdit.version, 2, "current PM can mutate an assigned-project entry");
    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 1, $4::jsonb, null, 'r1-2-pm-outside')`,
        [manager.auth, manager.app, outsideEntry.entryId, JSON.stringify({
          employment_status: { status: "ON", effective_date: authDate },
        })],
      ),
      (error) => error.code === "42501", "current PM cannot edit a different unassigned project",
    );

    const overlapHas = (await db.query(
      `select public.direct_entry_has_entry_access($1, 'entry_privileged_edit', $2, $3, $4) as allowed,
              public.direct_entry_assert_entry_access($5, $1, 'entry_privileged_edit', $2, $3, $4) as scope`,
      [APP, APP, TEAM_A, authDate, AUTH],
    )).rows[0];
    assert.deepEqual(overlapHas, { allowed: true, scope: "all" },
      "overlapping all/team grants remain valid and Full Admin scope takes precedence");
    const adminPage = await directory({ auth: AUTH, app: APP }, "all");
    assert.equal(adminPage.items.find((row) => row.entry_id === projectOnlyEntry.entryId)
      .allowed_actions.direct_edit, true, "Full Admin action is projected despite overlapping grants");
    const adminEdit = (await db.query(
      `select public.direct_entry_privileged_edit(
        $1, $2, $3, 1, $4::jsonb, null, 'r1-2-admin-edit') as result`,
      [AUTH, APP, projectTeamEntry.entryId, JSON.stringify({
        employment_status: { status: "ON", effective_date: authDate },
      })],
    )).rows[0].result;
    assert.equal(adminEdit.version, 2, "Full Admin can edit a row while an additional team grant is current");
    assert.equal((await db.query(
      `select scope_kind from public.direct_entry_audit_events
        where app_user_id=$1 and action='entry_privileged_edit' and resource_ref=$2
          and outcome='APPLIED' order by created_at desc limit 1`, [APP, projectTeamEntry.entryId],
    )).rows[0].scope_kind, "all", "Full Admin edit is audited in the all scope");

    const assignment = (await db.query(
      `select assignment_id, version from public.direct_entry_project_manager_assignments
        where project_id=$1 and manager_recruiter_id=$2 and is_current`,
      [PROJECT_PM, REC_B],
    )).rows[0];
    const projectVersion = (await db.query(
      `select version from public.direct_entry_projects where project_id=$1`, [PROJECT_PM],
    )).rows[0].version;
    await db.query(
      `select public.direct_entry_unassign_project_manager(
        $1, $2, $3, $4, $5, 'Synthetic R1.2 revoke', 'r1-2-pm-revoke')`,
      [AUTH, APP, assignment.assignment_id, assignment.version, projectVersion],
    );
    const afterRevoke = await directory(manager, "recruited");
    assert.equal(afterRevoke.items.find((row) => row.entry_id === projectOnlyEntry.entryId)
      .allowed_actions.direct_edit, false, "revoked PM authority is removed on the next projection");
    await assert.rejects(
      db.query(
        `select public.direct_entry_privileged_edit(
          $1, $2, $3, 2, $4::jsonb, null, 'r1-2-pm-after-revoke')`,
        [manager.auth, manager.app, projectOnlyEntry.entryId, JSON.stringify({
          employment_status: { status: "OFF", effective_date: authDate,
            leave_reason: "Synthetic required leave reason" },
        })],
      ),
      (error) => error.code === "42501", "revoked PM access is denied by the mutation RPC immediately",
    );
  } finally {
    await db.close();
  }
});

test("R1.1 Team Leader request review uses the same current team for WORK_STATUS detail and decision", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    const leader = await seedStrictTeamLeader(db);
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_A],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_A, TEAM_A],
    );
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, active)
       values ($1, 'Synthetic Team B Worker', true)`, [REC_C],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`, [REC_C],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`, [REC_C, TEAM_B],
    );
    const proposer = { auth: uuid(78), app: uuid(79) };
    await addActor(db, proposer.auth, proposer.app, "Synthetic Team Member");
    await addCurrentCapability(db, proposer.app, "change_request_create");
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1, $2, true, '2020-01-01', true)`, [proposer.app, REC_C],
    );
    await db.query(
      `select public.direct_entry_assign_project_manager(
        $1, $2, $3, $4, null, 1, 'Synthetic optional-reason PM', 'r1-1-optional-pm')`,
      [AUTH, APP, PROJECT, REC_C],
    );

    const { entryId: inTeamEntry } = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(80), candidateId: uuid(81), submissionId: uuid(82),
      projectId: PROJECT, employeeSuffix: "000980", recruiterId: REC_A, teamId: TEAM_A,
    });
    const { entryId: outsideEntry } = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(83), candidateId: uuid(84), submissionId: uuid(85),
      projectId: PROJECT, employeeSuffix: "000981", recruiterId: REC_C, teamId: TEAM_B,
    });
    const statusReason = (await db.query(
      `select public.direct_entry_reason($1, 'Synthetic initial status') as reason_id`, [APP],
    )).rows[0].reason_id;
    const authDate = (await db.query(
      `select public.direct_entry_authorization_date()::text as date`,
    )).rows[0].date;
    await db.query(
      `insert into public.direct_entry_employment_status_events
         (entry_id, status, effective_date, version, actor_user_id, reason_id)
       values ($1, 'UNCONFIRMED', $2, 1, $3, $4),
              ($5, 'UNCONFIRMED', $2, 1, $3, $4)`,
      [inTeamEntry, authDate, APP, statusReason, outsideEntry],
    );

    await db.query(
      `select public.direct_entry_privileged_edit(
        $1, $2, $3, 1, $4::jsonb, 'Current status baseline', 'r1-1-review-baseline')`,
      [leader.auth, leader.app, inTeamEntry, JSON.stringify({ employment_status: {
        status: "ON", effective_date: authDate,
      } })],
    );

    const requestReason = (await db.query(
      `select public.direct_entry_reason($1, 'Synthetic request context') as reason_id`, [proposer.app],
    )).rows[0].reason_id;
    const inTeamRequest = uuid(86);
    const outsideRequest = uuid(87);
    const staleRequest = uuid(88);
    const requestIds = [inTeamRequest, outsideRequest, staleRequest];
    for (const [index, requestId] of requestIds.entries()) {
      await db.query(
        `insert into public.direct_entry_change_requests
           (request_id, proposer_user_id, state, version, idempotency_key, request_hash, reason_id)
         values ($1, $2, 'PENDING', 1, $3, $4, $5)`,
        [requestId, proposer.app, `r1-1-request-${index}`, "a".repeat(64), requestReason],
      );
    }
    await db.query(
      `insert into public.direct_entry_change_request_items
         (request_id, entry_id, target_kind, expected_version, proposal)
       values ($1, $2, 'WORK_STATUS', 2, $3::jsonb),
              ($4, $5, 'WORK_STATUS', 1, $3::jsonb),
              ($6, $2, 'WORK_STATUS', 1, $3::jsonb)`,
      [inTeamRequest, inTeamEntry, JSON.stringify({
        status: "OFF", effective_date: authDate, leave_reason: "Synthetic proposed leave reason",
      }), outsideRequest, outsideEntry, staleRequest],
    );

    const inTeamEntryVersion = (await db.query(
      `select version from public.direct_entries where entry_id=$1`, [inTeamEntry],
    )).rows[0].version;
    const optionalItems = JSON.stringify([{
      entry_id: inTeamEntry, target_kind: "ENTRY_FIELD", expected_version: inTeamEntryVersion,
      proposal: { labor_type: "TEMPORARY" },
    }]);
    const optionalRequest = (await db.query(
      `select public.direct_entry_create_change_request(
        $1, $2, $3::jsonb, null, 'r1-1-optional-request') as data`,
      [proposer.auth, proposer.app, optionalItems],
    )).rows[0].data;
    const optionalRequestReplay = (await db.query(
      `select public.direct_entry_create_change_request(
        $1, $2, $3::jsonb, '   ', 'r1-1-optional-request') as data`,
      [proposer.auth, proposer.app, optionalItems],
    )).rows[0].data;
    assert.deepEqual(optionalRequestReplay, optionalRequest,
      "change-request create hashes the canonical NULL action reason");
    assert.equal((await db.query(
      `select reason_id from public.direct_entry_change_requests where request_id=$1`,
      [optionalRequest.request_id],
    )).rows[0].reason_id, null);
    assert.equal((await db.query(
      `select reason_id from public.direct_entry_change_request_revisions
        where request_id=$1 order by version desc limit 1`, [optionalRequest.request_id],
    )).rows[0].reason_id, null);
    assert.equal((await db.query(
      `select reason_id from public.direct_entry_audit_events
        where resource_ref=$1 and action='change_request_create' order by created_at desc limit 1`,
      [optionalRequest.request_id],
    )).rows[0].reason_id, null);

    assert.equal((await db.query(
      `select public.direct_entry_team_leader_request_team($1, $2) as team_id`,
      [leader.app, inTeamRequest],
    )).rows[0].team_id, TEAM_A);
    assert.equal((await db.query(
      `select public.direct_entry_change_request_audience($1, $2, $3) as audience`,
      [leader.app, proposer.app, inTeamRequest],
    )).rows[0].audience, "REVIEWER");
    assert.equal((await db.query(
      `select public.direct_entry_team_leader_request_team($1, $2) as team_id`,
      [leader.app, outsideRequest],
    )).rows[0].team_id, null);
    assert.equal((await db.query(
      `select public.direct_entry_change_request_audience($1, $2, $3) as audience`,
      [leader.app, proposer.app, outsideRequest],
    )).rows[0].audience, "NONE", "outside-team requests are not visible to the Team Leader");

    const requestList = (await db.query(
      `select public.direct_entry_list_change_requests($1, $2, 50, null, null) as data`,
      [leader.auth, leader.app],
    )).rows[0].data;
    assert.deepEqual(requestList.requests.map((request) => request.request_id).sort(),
      [inTeamRequest, staleRequest, optionalRequest.request_id].sort());
    assert.equal(requestList.requests.find((request) => request.request_id === inTeamRequest).can_decide, true);
    const detail = (await db.query(
      `select public.direct_entry_read_change_request($1, $2, $3) as data`,
      [leader.auth, leader.app, inTeamRequest],
    )).rows[0].data;
    assert.equal(detail.can_decide, true);
    assert.equal(detail.items[0].target_kind, "WORK_STATUS");
    assert.equal(detail.items[0].proposal.status, "OFF");
    assert.equal(detail.items[0].proposal.leave_reason, "Synthetic proposed leave reason");
    await assert.rejects(
      db.query(
        `select public.direct_entry_read_change_request($1, $2, $3)`,
        [leader.auth, leader.app, outsideRequest],
      ),
      (error) => error.code === "P0002",
      "outside-team request detail uses the non-enumerating not-found response",
    );

    await assert.rejects(
      db.query(
        `select public.direct_entry_decide_change_request(
          $1, $2, $3, 1, 'APPROVED', 'Approve stale proposal', 'r1-1-stale-approve')`,
        [leader.auth, leader.app, staleRequest],
      ),
      (error) => error.code === "PT409",
      "a stale WORK_STATUS proposal cannot be applied by the Team Leader",
    );
    const rejected = (await db.query(
      `select public.direct_entry_decide_change_request(
        $1, $2, $3, 1, 'REJECTED', 'Reject stale proposal', 'r1-1-stale-reject') as data`,
      [leader.auth, leader.app, staleRequest],
    )).rows[0].data;
    assert.equal(rejected.state, "REJECTED", "a Team Leader can reject a stale current-team proposal");

    const approved = (await db.query(
      `select public.direct_entry_decide_change_request(
        $1, $2, $3, 1, 'APPROVED', null, 'r1-1-work-status-approve') as data`,
      [leader.auth, leader.app, inTeamRequest],
    )).rows[0].data;
    assert.equal(approved.state, "APPROVED");
    assert.equal((await db.query(
      `select decision_reason_id from public.direct_entry_change_requests where request_id=$1`,
      [inTeamRequest],
    )).rows[0].decision_reason_id, null);
    assert.equal((await db.query(
      `select reason_id from public.direct_entry_change_request_revisions
        where request_id=$1 order by version desc limit 1`, [inTeamRequest],
    )).rows[0].reason_id, null, "review revision persists without a placeholder decision reason");
    assert.equal((await db.query(
      `select reason_id from public.direct_entry_audit_events
        where app_user_id=$1 and action='change_request_approve' and resource_ref=$2
        order by created_at desc limit 1`,
      [leader.app, inTeamEntry],
    )).rows[0].reason_id, null, "review audit persists without a placeholder decision reason");
    assert.equal((await db.query(
      `select status, leave_reason_text from public.direct_entry_employment_status_events
        where entry_id=$1 order by version desc limit 1`, [inTeamEntry],
    )).rows[0].status, "OFF");
    assert.equal((await db.query(
      `select scope_kind, scope_team_id from public.direct_entry_audit_events
        where app_user_id=$1 and action='change_request_approve' and resource_ref=$2
        order by created_at desc limit 1`, [leader.app, inTeamEntry],
    )).rows[0].scope_team_id, TEAM_A,
    "WORK_STATUS approval retains the Team Leader current-team audit scope");

    await assert.rejects(
      db.query(
        `select public.direct_entry_decide_change_request(
          $1, $2, $3, 1, 'REJECTED', 'Cross-team decision', 'r1-1-cross-team-decision')`,
        [leader.auth, leader.app, outsideRequest],
      ),
      (error) => error.code === "42501",
      "the Team Leader cannot decide requests for another team",
    );
  } finally {
    await db.close();
  }
});

test("Android background attachments may finish after SUBMITTED only for the record creator", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    await addCurrentCapability(db, APP, "document_upload");
    await addCurrentCapability(db, FUTURE_APP, "document_upload");
    await db.query(
      `insert into public.recruiter_provider_memberships
         (recruiter_id, provider_type, valid_from, is_current)
       values ($1, 'hrp', '2020-01-01', true)`,
      [REC_A],
    );
    await db.query(
      `insert into public.recruiter_team_memberships
         (recruiter_id, team_id, valid_from, is_current)
       values ($1, $2, '2020-01-01', true)`,
      [REC_A, TEAM_A],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'all', null, '2020-01-01', true)`,
      [FUTURE_APP],
    );

    const { entryId } = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(1601),
      candidateId: uuid(1602),
      submissionId: uuid(1603),
      ownerApp: APP,
      projectId: PROJECT,
      employeeSuffix: "001601",
      displayName: "Android Background Upload",
    });

    const reserved = (await db.query(
      `select public.direct_entry_reserve_document_direct_upload(
        $1::uuid, $2::uuid, $3::uuid, 1, 'WORKER_PORTRAIT',
        'android-background-reserve-1601', 4, 'image/jpeg', null
      ) as data`,
      [AUTH, APP, entryId],
    )).rows[0].data;
    assert.equal(reserved.reused, false);
    assert.equal(reserved.entry_version, 2);

    const context = (await db.query(
      `select public.direct_entry_document_direct_context(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'finalize'
      ) as data`,
      [AUTH, APP, entryId, reserved.document_id],
    )).rows[0].data;
    assert.equal(context.document_type, "WORKER_PORTRAIT");
    assert.equal(context.entry_version, 2);

    const finalized = (await db.query(
      `select public.direct_entry_finalize_document_direct_upload(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 2,
        'android-background-finalize-1601', 'validated', $5::text, 4, 'image/jpeg'
      ) as data`,
      [AUTH, APP, entryId, reserved.document_id, "a".repeat(64)],
    )).rows[0].data;
    assert.equal(finalized.validation_status, "VALIDATED");
    assert.equal(finalized.entry_version, 3);

    const auditReason = (await db.query(
      `select r.reason_text
         from public.direct_entry_audit_events a
         join public.direct_entry_restricted_reasons r on r.reason_id = a.reason_id
        where a.action = 'document_direct_reserve' and a.resource_ref = $1
        order by a.created_at desc limit 1`,
      [entryId],
    )).rows[0].reason_text;
    assert.equal(auditReason, "Android background attachment upload");

    await assert.rejects(
      db.query(
        `select public.direct_entry_reserve_document_direct_upload(
          $1::uuid, $2::uuid, $3::uuid, 3, 'CCCD_FRONT',
          'cross-user-background-reserve-1601', 4, 'image/jpeg', null
        )`,
        [FUTURE_AUTH, FUTURE_APP, entryId],
      ),
      (error) => error.code === "42501",
      "document_upload alone never permits background mutation of another creator's submitted entry",
    );
  } finally {
    await db.close();
  }
});

test("actor binding and S0 service-role ACLs remain enforced", async () => {
  const { db } = await buildDb();
  try {
    await seedActorsAndResources(db);
    await assert.rejects(
      db.query("select public.direct_entry_assert_actor($1,$2,'entry_admin')", [FUTURE_AUTH, APP]),
      (error) => error.code === "42501",
      "a client-supplied actor UUID cannot substitute for the mapped auth subject",
    );

    const { rows } = await db.query(
      `select
         has_function_privilege('service_role', 'public.direct_entry_resolve_actor_context(uuid)', 'EXECUTE') as resolver_service,
         has_function_privilege('anon', 'public.direct_entry_resolve_actor_context(uuid)', 'EXECUTE') as resolver_anon,
         has_function_privilege('authenticated', 'public.direct_entry_resolve_actor_context(uuid)', 'EXECUTE') as resolver_authenticated,
         has_function_privilege('anon', 'public.direct_entry_has_capability(uuid,text)', 'EXECUTE') as helper_anon,
         has_function_privilege('authenticated', 'public.direct_entry_has_capability(uuid,text)', 'EXECUTE') as helper_authenticated,
         has_function_privilege('service_role', 'public.direct_entry_has_capability(uuid,text)', 'EXECUTE') as helper_service,
         has_function_privilege('public', 'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)', 'EXECUTE') as team_helper_public,
         has_function_privilege('anon', 'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)', 'EXECUTE') as team_helper_anon,
         has_function_privilege('authenticated', 'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)', 'EXECUTE') as team_helper_authenticated,
         has_function_privilege('service_role', 'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)', 'EXECUTE') as team_helper_service,
         has_function_privilege('service_role', 'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)', 'EXECUTE') as export_service,
         has_function_privilege('anon', 'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)', 'EXECUTE') as export_anon,
         has_function_privilege('authenticated', 'public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)', 'EXECUTE') as export_authenticated`,
    );
    const bootstrap = await db.query(
      `select
         (select pg_get_userbyid(proowner) from pg_proc where oid='public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)'::regprocedure) as apply_owner,
         (select pg_get_userbyid(proowner) from pg_proc where oid='public.direct_entry_catalog_bootstrap_plan(uuid,uuid)'::regprocedure) as plan_owner,
         has_function_privilege('service_role', 'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)', 'EXECUTE') as service,
         has_function_privilege('public', 'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)', 'EXECUTE') as public,
         has_function_privilege('anon', 'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)', 'EXECUTE') as anon,
         has_function_privilege('authenticated', 'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)', 'EXECUTE') as authenticated,
         has_schema_privilege('direct_entry_catalog_bootstrap_executor', 'public', 'CREATE') as executor_create
      `,
    );
    assert.deepEqual(bootstrap.rows[0], {
      apply_owner: "direct_entry_catalog_bootstrap_executor",
      plan_owner: "direct_entry_catalog_bootstrap_executor",
      service: true, public: false, anon: false, authenticated: false, executor_create: false,
    }, "R1 preserves the bootstrap SECURITY DEFINER owner, service ACL and schema boundary");
    const temporaryMembership = await db.query(
      `select exists (select 1 from pg_auth_members where member=current_user::regrole
        and roleid='direct_entry_catalog_bootstrap_executor'::regrole and grantor=current_user::regrole) as exists`,
    );
    assert.equal(temporaryMembership.rows[0].exists, false, "migration installer membership is not retained");

    assert.deepEqual(rows[0], {
      resolver_service: true,
      resolver_anon: false,
      resolver_authenticated: false,
      helper_anon: false,
      helper_authenticated: false,
      helper_service: false,
      team_helper_public: false,
      team_helper_anon: false,
      team_helper_authenticated: false,
      team_helper_service: false,
      export_service: true,
      export_anon: false,
      export_authenticated: false,
    });
  } finally {
    await db.close();
  }
});

test("T1A: direct_entry_resolve_actor_context allowed_worker_tabs matches RPC authority for uploader, recruited, managed, team, and all including ambiguous and revoked cases", async () => {
  const { db } = await buildDb();
  try {
    const { assignment, managerAuth, managerApp } = await seedProjectManager(db);
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, active)
       values ($1, 'Synthetic Recruiter C', true)`,
      [REC_C],
    );

    const resolveCtx = async (authSubject) =>
      (
        await db.query(
          "select public.direct_entry_resolve_actor_context($1::uuid) as context",
          [authSubject],
        )
      ).rows[0].context;

    // -------------------------------------------------------------------------
    // 1. Existing fields + report_review scopes + ACL non-regression
    // -------------------------------------------------------------------------
    await addCurrentCapability(db, APP, "report_review");
    const adminCtx = await resolveCtx(AUTH);
    assert.deepEqual(Object.keys(adminCtx).sort(), [
      "all_scope_grants",
      "allowed_worker_tabs",
      "app_user_id",
      "assigned_roles",
      "auth_subject",
      "capabilities",
      "display_name",
      "effective_grants",
      "effective_report_review_scopes",
      "enabled",
      "recruiter_links",
      "team_scope_grants",
      "teams",
    ]);
    assert.deepEqual(adminCtx.allowed_worker_tabs, ["recruited", "all"]);
    assert.ok(Array.isArray(adminCtx.effective_report_review_scopes));
    assert.ok(adminCtx.effective_report_review_scopes.length > 0);

    // -------------------------------------------------------------------------
    // 2. Uploader tab parity with public.direct_entry_list_own_submissions
    // -------------------------------------------------------------------------
    const uploaderAuth = uuid(81);
    const uploaderApp = uuid(82);
    await addActor(db, uploaderAuth, uploaderApp, "Synthetic Uploader");
    await addCurrentCapability(db, uploaderApp, "entry_own");
    await addCurrentCapability(db, uploaderApp, "entry_create");
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current)
       values ($1, 'own', null, '2020-01-01', '2021-01-01', true)`,
      [uploaderApp],
    );

    // Without submission_create: uploader tab is absent and RPC raises 42501
    assert.deepEqual((await resolveCtx(uploaderAuth)).allowed_worker_tabs, []);
    await assert.rejects(
      db.query(
        "select public.direct_entry_list_own_submissions($1::uuid, $2::uuid, 25, null, null)",
        [uploaderAuth, uploaderApp],
      ),
      (err) => err.code === "42501",
      "entry_own/entry_create without submission_create is rejected by direct_entry_list_own_submissions",
    );

    // Grant submission_create (with historical valid_to metadata): both tab and RPC succeed
    await addCurrentCapability(db, uploaderApp, "submission_create");
    assert.deepEqual((await resolveCtx(uploaderAuth)).allowed_worker_tabs, ["uploader"]);
    const ownSubPage = (
      await db.query(
        "select public.direct_entry_list_own_submissions($1::uuid, $2::uuid, 25, null, null) as page",
        [uploaderAuth, uploaderApp],
      )
    ).rows[0].page;
    assert.ok(Array.isArray(ownSubPage.items));
    assert.equal(ownSubPage.page_size, 25);

    // Duplicate current own scope grant (count = 2): both tab and RPC reject
    await db.query("drop index if exists public.idx_direct_entry_scope_grants_current_own_unique");
    const duplicateOwnGrantId = (
      await db.query(
        `insert into public.direct_entry_scope_grants
           (app_user_id, scope_kind, team_id, valid_from, is_current)
         values ($1, 'own', null, '2022-01-01', true)
         returning grant_id`,
        [uploaderApp],
      )
    ).rows[0].grant_id;
    assert.deepEqual(
      (await resolveCtx(uploaderAuth)).allowed_worker_tabs,
      [],
      "duplicate current own scope grants must omit uploader tab",
    );
    await assert.rejects(
      db.query(
        "select public.direct_entry_list_own_submissions($1::uuid, $2::uuid, 25, null, null)",
        [uploaderAuth, uploaderApp],
      ),
      (err) => err.code === "42501",
      "duplicate current own scope grants must fail closed in direct_entry_list_own_submissions",
    );

    // Restore single current own scope grant -> allowed again
    await db.query("delete from public.direct_entry_scope_grants where grant_id = $1", [
      duplicateOwnGrantId,
    ]);
    assert.deepEqual((await resolveCtx(uploaderAuth)).allowed_worker_tabs, ["uploader"]);

    // Non-current own scope grant -> denied
    await db.query(
      "update public.direct_entry_scope_grants set is_current = false where app_user_id = $1",
      [uploaderApp],
    );
    assert.deepEqual((await resolveCtx(uploaderAuth)).allowed_worker_tabs, []);
    await assert.rejects(
      db.query(
        "select public.direct_entry_list_own_submissions($1::uuid, $2::uuid, 25, null, null)",
        [uploaderAuth, uploaderApp],
      ),
      (err) => err.code === "42501",
    );

    // -------------------------------------------------------------------------
    // 3. Managed & Recruited tab parity with direct_entry_actor_has_project_assignment
    // -------------------------------------------------------------------------
    // Effective PM (with 1 verified current link to REC_B) gets uploader, recruited, managed
    assert.deepEqual((await resolveCtx(managerAuth)).allowed_worker_tabs, [
      "uploader",
      "recruited",
      "managed",
    ]);
    const pmManagedPage = (
      await db.query(
        "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'managed', null, null, null, null, 25) as page",
        [managerAuth, managerApp],
      )
    ).rows[0].page;
    assert.equal(pmManagedPage.scope, "managed");
    assert.ok(Array.isArray(pmManagedPage.items));
    const pmOwnSubPage = (
      await db.query(
        "select public.direct_entry_list_own_submissions($1::uuid, $2::uuid, 25, null, null) as page",
        [managerAuth, managerApp],
      )
    ).rows[0].page;
    assert.ok(Array.isArray(pmOwnSubPage.items));

    // Cross-account ambiguous recruiter link: another enabled user also links to REC_B
    const dupRecruiterAuth = uuid(83);
    const dupRecruiterApp = uuid(84);
    await addActor(db, dupRecruiterAuth, dupRecruiterApp, "Duplicate Recruiter Link Actor");
    const crossAccountLinkId = (
      await db.query(
        `insert into public.direct_entry_app_user_recruiter_links
           (app_user_id, recruiter_id, verified, valid_from, valid_to, is_current)
         values ($1, $2, true, '2015-01-01', '2019-01-01', true)
         returning link_id`,
        [dupRecruiterApp, REC_B],
      )
    ).rows[0].link_id;

    // direct_entry_project_assignment_effective rejects when manager_recruiter_id has >1 verified current link
    assert.deepEqual(
      (await resolveCtx(managerAuth)).allowed_worker_tabs,
      ["recruited"],
      "cross-account ambiguous recruiter link must revoke managed and PM-derived uploader tabs",
    );
    await assert.rejects(
      db.query(
        "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'managed', null, null, null, null, 25)",
        [managerAuth, managerApp],
      ),
      (err) => err.code === "42501",
    );

    // Clean up cross-account duplicate link -> managed + uploader restored
    await db.query("delete from public.direct_entry_app_user_recruiter_links where link_id = $1", [
      crossAccountLinkId,
    ]);
    assert.deepEqual((await resolveCtx(managerAuth)).allowed_worker_tabs, [
      "uploader",
      "recruited",
      "managed",
    ]);

    // Same-account ambiguous recruiter links (manager linked to both REC_B and REC_C):
    // recruited requires count(*) = 1 per app_user_id (so recruited is omitted and raises 42501),
    // while direct_entry_project_assignment_effective checks uniqueness per manager_recruiter_id (REC_B),
    // so managed + PM-derived uploader remain allowed.
    const secondSelfLinkId = (
      await db.query(
        `insert into public.direct_entry_app_user_recruiter_links
           (app_user_id, recruiter_id, verified, valid_from, valid_to, is_current)
         values ($1, $2, true, '2015-01-01', '2019-01-01', true)
         returning link_id`,
        [managerApp, REC_C],
      )
    ).rows[0].link_id;
    assert.deepEqual(
      (await resolveCtx(managerAuth)).allowed_worker_tabs,
      ["uploader", "managed"],
      "same-account ambiguous recruiter links omit recruited while preserving managed via direct_entry_actor_has_project_assignment",
    );
    await assert.rejects(
      db.query(
        "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'recruited', null, null, null, null, 25)",
        [managerAuth, managerApp],
      ),
      (err) => err.code === "42501",
    );
    const managedStillOk = (
      await db.query(
        "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'managed', null, null, null, null, 25) as page",
        [managerAuth, managerApp],
      )
    ).rows[0].page;
    assert.equal(managedStillOk.scope, "managed");

    await db.query("delete from public.direct_entry_app_user_recruiter_links where link_id = $1", [
      secondSelfLinkId,
    ]);
    assert.deepEqual((await resolveCtx(managerAuth)).allowed_worker_tabs, [
      "uploader",
      "recruited",
      "managed",
    ]);

    // Revoking PM assignment removes managed and PM-derived uploader, keeping recruited
    await db.query(
      "update public.direct_entry_project_manager_assignments set is_current = false where assignment_id = $1",
      [assignment.assignment_id],
    );
    assert.deepEqual((await resolveCtx(managerAuth)).allowed_worker_tabs, ["recruited"]);
    await assert.rejects(
      db.query(
        "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'managed', null, null, null, null, 25)",
        [managerAuth, managerApp],
      ),
      (err) => err.code === "42501",
    );

    // -------------------------------------------------------------------------
    // 4. Team tab parity with public.direct_entry_assert_team_leader_current_team
    // -------------------------------------------------------------------------
    const leader = await seedStrictTeamLeader(db, {
      auth: uuid(85),
      app: uuid(86),
      recruiter: REC_C,
      team: TEAM_A,
    });
    assert.deepEqual((await resolveCtx(leader.auth)).allowed_worker_tabs, ["recruited", "team"]);
    const teamPage = (
      await db.query(
        "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'team', null, null, null, null, 25) as page",
        [leader.auth, leader.app],
      )
    ).rows[0].page;
    assert.equal(teamPage.scope, "team");
    assert.ok(Array.isArray(teamPage.items));

    // 4a. Ambiguous team scope grants (2 current team scopes) -> team tab omitted & RPC raises 42501
    const extraTeamScopeId = (
      await db.query(
        `insert into public.direct_entry_scope_grants
           (app_user_id, scope_kind, team_id, valid_from, is_current)
         values ($1, 'team', $2, '2020-01-01', true)
         returning grant_id`,
        [leader.app, TEAM_B],
      )
    ).rows[0].grant_id;
    assert.deepEqual(
      (await resolveCtx(leader.auth)).allowed_worker_tabs,
      ["recruited"],
      "ambiguous team scope grants must omit team tab",
    );
    await assert.rejects(
      db.query(
        "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'team', null, null, null, null, 25)",
        [leader.auth, leader.app],
      ),
      (err) => err.code === "42501",
    );
    await db.query("delete from public.direct_entry_scope_grants where grant_id = $1", [
      extraTeamScopeId,
    ]);
    assert.deepEqual((await resolveCtx(leader.auth)).allowed_worker_tabs, ["recruited", "team"]);

    // 4b. Ambiguous team leader assignments -> team tab omitted & RPC raises 42501
    await db.query("alter table public.direct_entry_team_leader_assignments disable trigger user");
    const extraLeaderAssignmentId = (
      await db.query(
        `insert into public.direct_entry_team_leader_assignments
           (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to, is_current)
         values ($1, $2, $3, '2021-01-01', '2099-01-01', true)
         returning assignment_id`,
        [TEAM_B, leader.app, leader.recruiter],
      )
    ).rows[0].assignment_id;
    assert.deepEqual(
      (await resolveCtx(leader.auth)).allowed_worker_tabs,
      ["recruited"],
      "ambiguous team leader assignments must omit team tab",
    );
    await assert.rejects(
      db.query(
        "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'team', null, null, null, null, 25)",
        [leader.auth, leader.app],
      ),
      (err) => err.code === "42501",
    );
    await db.query(
      "delete from public.direct_entry_team_leader_assignments where assignment_id = $1",
      [extraLeaderAssignmentId],
    );
    await db.query("alter table public.direct_entry_team_leader_assignments enable trigger user");
    assert.deepEqual((await resolveCtx(leader.auth)).allowed_worker_tabs, ["recruited", "team"]);

    // 4c. Ambiguous recruiter team memberships -> team tab omitted & RPC raises 42501
    await db.query("alter table public.recruiter_team_memberships disable trigger user");
    const extraMembershipId = (
      await db.query(
        `insert into public.recruiter_team_memberships
           (recruiter_id, team_id, valid_from, valid_to, is_current)
         values ($1, $2, '2021-01-01', '2099-01-01', true)
         returning membership_id`,
        [leader.recruiter, TEAM_B],
      )
    ).rows[0].membership_id;
    assert.deepEqual(
      (await resolveCtx(leader.auth)).allowed_worker_tabs,
      ["recruited"],
      "ambiguous recruiter team memberships must omit team tab",
    );
    await assert.rejects(
      db.query(
        "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'team', null, null, null, null, 25)",
        [leader.auth, leader.app],
      ),
      (err) => err.code === "42501",
    );
    await db.query("delete from public.recruiter_team_memberships where membership_id = $1", [
      extraMembershipId,
    ]);
    await db.query("alter table public.recruiter_team_memberships enable trigger user");
    assert.deepEqual((await resolveCtx(leader.auth)).allowed_worker_tabs, ["recruited", "team"]);

    // 4d. Non-HRP provider membership (vendor) -> team tab omitted & RPC raises 42501
    await db.query(
      "update public.recruiter_provider_memberships set provider_type = 'vendor' where recruiter_id = $1",
      [leader.recruiter],
    );
    assert.deepEqual(
      (await resolveCtx(leader.auth)).allowed_worker_tabs,
      ["recruited"],
      "vendor provider membership must omit team tab",
    );
    await assert.rejects(
      db.query(
        "select public.direct_entry_list_workers($1::uuid, $2::uuid, 'team', null, null, null, null, 25)",
        [leader.auth, leader.app],
      ),
      (err) => err.code === "42501",
    );
  } finally {
    await db.close();
  }
});

test("T1A Hotfix Issue #1: direct_entry_read_projection authorizes all 5 worker directory tab audiences (uploader, recruited, managed, team, all) and overlapping scopes while denying out-of-scope actors", async () => {
  const { db } = await buildDb();
  try {
    const { managerAuth, managerApp } = await seedProjectManager(db);
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, active)
       values ($1, 'Synthetic Recruiter C', true)`,
      [REC_C],
    );

    const leader = await seedStrictTeamLeader(db, {
      auth: uuid(93),
      app: uuid(94),
      recruiter: REC_C,
      team: TEAM_A,
    });
    const { entryId } = await insertSyntheticProjectEntry(db, "SUBMITTED");

    const readProjection = async (authSubject, appUserId, targetEntryId) =>
      (
        await db.query(
          "select public.direct_entry_read_projection($1::uuid, $2::uuid, $3::uuid) as projection",
          [authSubject, appUserId, targetEntryId],
        )
      ).rows[0].projection;

    // 1. Recruited viewer (linked to REC_A, no entry_own capability) can open detail of entryId and gets scope_kind = 'recruited'
    const recruitedAuth = uuid(91);
    const recruitedApp = uuid(92);
    await addActor(db, recruitedAuth, recruitedApp, "Recruited Only Viewer");
    await db.query(
      `update public.direct_entry_app_user_recruiter_links
          set app_user_id = $1
        where app_user_id = $2 and recruiter_id = $3 and is_current`,
      [recruitedApp, APP, REC_A],
    );
    const recruitedProj = await readProjection(recruitedAuth, recruitedApp, entryId);
    assert.equal(recruitedProj.entry_id, entryId);
    assert.equal(recruitedProj.scope_kind, "recruited");
    assert.deepEqual(recruitedProj.documents, []);
    assert.equal(recruitedProj.worker_portrait, null, "without document_view, portrait is null");

    // 2. Managed viewer (PM on PROJECT_PM) can open detail of entryId and gets scope_kind = 'project'
    const managedProj = await readProjection(managerAuth, managerApp, entryId);
    assert.equal(managedProj.entry_id, entryId);
    assert.equal(managedProj.scope_kind, "project");

    // 3a. Team Leader of TEAM_A can open detail of entryId in TEAM_A and gets scope_kind = 'team'
    const teamProj = await readProjection(leader.auth, leader.app, entryId);
    assert.equal(teamProj.entry_id, entryId);
    assert.equal(teamProj.scope_kind, "team");

    // 3b. Actor with overlapping 'own' (entry_own) and 'team' (entry_team) draft scopes on their own entry in TEAM_A does not fail with 42501
    await addCurrentCapability(db, leader.app, "entry_own");
    await addCurrentCapability(db, leader.app, "entry_team");
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'own', null, '2020-01-01', true)`,
      [leader.app],
    );
    const { entryId: overlapEntryId } = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(14),
      candidateId: uuid(15),
      submissionId: uuid(16),
      ownerApp: leader.app,
      employeeSuffix: "000903",
    });
    const overlapProj = await readProjection(leader.auth, leader.app, overlapEntryId);
    assert.equal(overlapProj.entry_id, overlapEntryId);
    assert.ok(["own", "team"].includes(overlapProj.scope_kind));

    // 4. Uploader viewer (created entry, has own scope + submission_create, WITHOUT entry_own) can open detail of their own entry
    const uploaderAuth = uuid(95);
    const uploaderApp = uuid(96);
    await addActor(db, uploaderAuth, uploaderApp, "Submission Uploader Only");
    await addCurrentCapability(db, uploaderApp, "submission_create");
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'own', null, '2020-01-01', true)`,
      [uploaderApp],
    );
    const { entryId: uploaderEntryId } = await insertSyntheticProjectEntry(db, "SUBMITTED", {
      entryId: uuid(17),
      candidateId: uuid(18),
      submissionId: uuid(19),
      ownerApp: uploaderApp,
      employeeSuffix: "000902",
    });
    const uploaderProj = await readProjection(uploaderAuth, uploaderApp, uploaderEntryId);
    assert.equal(uploaderProj.entry_id, uploaderEntryId);
    assert.equal(uploaderProj.scope_kind, "own");

    // 5. All-scope viewer (change_review @ all) can open detail of entryId and gets scope_kind = 'all'
    const allViewerAuth = uuid(97);
    const allViewerApp = uuid(98);
    await addActor(db, allViewerAuth, allViewerApp, "All Scope Reviewer");
    await addCurrentCapability(db, allViewerApp, "change_review");
    await addCurrentCapability(db, allViewerApp, "document_view");
    await db.query(
      `insert into public.direct_entry_scope_grants
         (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1, 'all', null, '2020-01-01', true)`,
      [allViewerApp],
    );
    const allProj = await readProjection(allViewerAuth, allViewerApp, entryId);
    assert.equal(allProj.entry_id, entryId);
    assert.equal(allProj.scope_kind, "all");
    assert.ok(allProj.worker_portrait !== null, "with document_view, portrait metadata is returned");

    // 6. Out-of-scope actor is denied with 42501
    const outsiderAuth = uuid(99);
    const outsiderApp = uuid(100);
    await addActor(db, outsiderAuth, outsiderApp, "Out Of Scope Actor");
    await assert.rejects(
      readProjection(outsiderAuth, outsiderApp, entryId),
      (err) => err.code === "42501",
      "out-of-scope actor must be denied with 42501",
    );
  } finally {
    await db.close();
  }
});
