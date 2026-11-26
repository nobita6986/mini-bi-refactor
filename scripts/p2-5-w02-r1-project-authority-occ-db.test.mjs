/**
 * P2.5-W02-R1 - project master OCC, revisions and the W07E #50 safety guard
 * (DB regression, PGlite over the 75-migration ledger).
 *
 * Closes the three findings of the T0 R1 review of P2.5-W02:
 *   F1 real OCC: assign/unassign no longer use an "expected active assignment
 *      count" (which cannot see ABA) but the row-locked, fail-closed
 *      direct_entry_projects.version, advanced by every mutation.
 *   F2 project CRUD: create/update/list/get/activate-deactivate with actor
 *      mapping + entry_admin + all scope + reason + expected version +
 *      idempotency + immutable audit + before/after project revision, and no
 *      hard delete anywhere.
 *   F3 safety: #50 and #51 keep their own BEGIN/COMMIT, no single-transaction
 *      apply path exists in this repo, and the withdrawn
 *      `psql --single-transaction -f #50 -f #51` proposal must not come back.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const ROOT = process.cwd();
const W02_MIGRATION =
  "20261008110000_p2_5_w02_multi_manager_project_authority.sql";
const W03_MIGRATION =
  "20261008120000_p2_5_w03_worker_directory_projection.sql";
const W04_MIGRATION =
  "20261008130000_p2_5_w04_project_manager_change_request_policy.sql";
const W07E_MIGRATION =
  "20261008100000_p3_w07e_project_manager_submitted_change_requests.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const REC_A = uuid(21), REC_B = uuid(22), REC_C = uuid(23), REC_D = uuid(24);
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const MGR_A_AUTH = uuid(32), MGR_A_APP = uuid(42);
const MGR_B_AUTH = uuid(33), MGR_B_APP = uuid(43);
const MGR_C_AUTH = uuid(34), MGR_C_APP = uuid(44);

const PRE_3C_PIN_MIGRATION_NAME = "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql";

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const pinIdx = names.indexOf(PRE_3C_PIN_MIGRATION_NAME);
  assert.notEqual(pinIdx, -1, `missing ${PRE_3C_PIN_MIGRATION_NAME}`);
  for (const name of names.slice(0, pinIdx + 1)) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(W02_MIGRATION), 50, "W02 is #51");
  assert.equal(names.indexOf(W04_MIGRATION), 52, "W04 is #53");
  assert.equal(names.indexOf(W03_MIGRATION), 51, "P2.5-W03 stays at #52");
  return db;
}

async function seed(db) {
  for (const [auth, app] of [[ADMIN_AUTH, ADMIN_APP], [MGR_A_AUTH, MGR_A_APP],
    [MGR_B_AUTH, MGR_B_APP], [MGR_C_AUTH, MGR_C_APP]]) {
    await db.query("insert into auth.users (id) values ($1)", [auth]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
      " values ($1,$2,true,'Synthetic Account')", [app, auth]);
  }
  for (const capability of ["entry_admin", "change_request_create", "entry_create"]) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [ADMIN_APP, capability]);
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)" +
    " values ($1,'all','2020-01-01',true)", [ADMIN_APP]);
  for (const app of [MGR_A_APP, MGR_B_APP, MGR_C_APP]) {
    for (const capability of ["change_request_create", "entry_create"]) {
      await db.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
        " values ($1,$2,'2020-01-01',true)", [app, capability]);
    }
  }
  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_R1','Team R1')",
    [TEAM]);
  for (const [recruiter, name] of [[REC_A, "Recruiter A"], [REC_B, "Recruiter B"],
    [REC_C, "Recruiter C"], [REC_D, "Recruiter D"]]) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1,$2)",
      [recruiter, name]);
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
      " values ($1,'hrp','2020-01-01',true)", [recruiter]);
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [recruiter, TEAM]);
  }
  for (const [app, recruiter] of [[MGR_A_APP, REC_A], [MGR_B_APP, REC_B], [MGR_C_APP, REC_C]]) {
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links" +
      " (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)",
      [app, recruiter]);
  }
}

// --- RPC wrappers -----------------------------------------------------------
async function createProject(db, {
  projectId = "proj_r1", displayName = "R1 Project",
  reason = "Owner created the project", key = "create-key-1",
  actor = ADMIN_APP, auth = ADMIN_AUTH,
} = {}) {
  const res = await db.query(
    "select public.direct_entry_create_project($1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text) as data",
    [auth, actor, projectId, displayName, reason, key]);
  return res.rows[0].data;
}

async function updateProject(db, {
  projectId = "proj_r1", expectedVersion, displayName = "R1 Project renamed",
  reason = "Owner renamed the project", key = "update-key-1",
  actor = ADMIN_APP, auth = ADMIN_AUTH,
} = {}) {
  const res = await db.query(
    "select public.direct_entry_update_project($1::uuid,$2::uuid,$3::text,$4::integer,$5::text,$6::text,$7::text) as data",
    [auth, actor, projectId, expectedVersion, displayName, reason, key]);
  return res.rows[0].data;
}

async function setProjectActive(db, {
  projectId = "proj_r1", active, expectedVersion,
  reason = "Owner changed the project lifecycle", key = "active-key-1",
  actor = ADMIN_APP, auth = ADMIN_AUTH,
} = {}) {
  const res = await db.query(
    "select public.direct_entry_set_project_active($1::uuid,$2::uuid,$3::text,$4::boolean,$5::integer,$6::text,$7::text) as data",
    [auth, actor, projectId, active, expectedVersion, reason, key]);
  return res.rows[0].data;
}

async function getProject(db, projectId = "proj_r1", actor = ADMIN_APP, auth = ADMIN_AUTH) {
  const res = await db.query(
    "select public.direct_entry_get_project_admin($1::uuid,$2::uuid,$3::text) as data",
    [auth, actor, projectId]);
  return res.rows[0].data;
}

async function listProjects(db, includeInactive = true, actor = ADMIN_APP, auth = ADMIN_AUTH) {
  const res = await db.query(
    "select public.direct_entry_list_projects_admin($1::uuid,$2::uuid,$3::boolean) as data",
    [auth, actor, includeInactive]);
  return res.rows[0].data;
}

async function assign(db, {
  project = "proj_r1", manager = REC_A, expectedProjectVersion,
  reason = "Owner assigned the project manager", key = "assign-key-1",
  actor = ADMIN_APP, auth = ADMIN_AUTH,
} = {}) {
  const res = await db.query(
    "select public.direct_entry_assign_project_manager($1::uuid,$2::uuid,$3::text,$4::uuid,$5::date,$6::integer,$7::text,$8::text) as data",
    [auth, actor, project, manager, null, expectedProjectVersion, reason, key]);
  return res.rows[0].data;
}

async function unassign(db, {
  assignmentId, expectedVersion = 1, expectedProjectVersion,
  reason = "Owner removed the project manager", key = "unassign-key-1",
  actor = ADMIN_APP, auth = ADMIN_AUTH,
} = {}) {
  const res = await db.query(
    "select public.direct_entry_unassign_project_manager($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::integer,$6::text,$7::text) as data",
    [auth, actor, assignmentId, expectedVersion, expectedProjectVersion, reason, key]);
  return res.rows[0].data;
}

async function projectVersion(db, project = "proj_r1") {
  const res = await db.query(
    "select version from public.direct_entry_projects where project_id = $1", [project]);
  return res.rows[0]?.version ?? null;
}

async function activeAssignmentCount(db, project = "proj_r1") {
  const res = await db.query(
    "select count(*)::int as n from public.direct_entry_project_manager_assignments" +
    " where project_id = $1 and valid_to is null", [project]);
  return res.rows[0].n;
}

async function countOf(db, sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

async function auditCount(db) {
  return countOf(db, "select count(*)::int as n from public.direct_entry_audit_events");
}

async function revisionRows(db, project = "proj_r1") {
  const res = await db.query(
    "select revision_id::text as revision_id, version, project_id," +
    " before_snapshot, after_snapshot, actor_user_id::text as actor, reason_id is not null as has_reason" +
    " from public.direct_entry_project_revisions where project_id = $1 order by version", [project]);
  return res.rows;
}

async function authorizationDate(db) {
  const res = await db.query("select public.direct_entry_authorization_date()::text as d");
  return res.rows[0].d;
}

async function canAccess(db, app, project) {
  const res = await db.query(
    "select public.direct_entry_actor_can_access_project($1::uuid,$2::text) as ok", [app, project]);
  return res.rows[0].ok;
}

async function catalogProjectIds(db, auth, app) {
  const res = await db.query(
    "select public.direct_entry_input_catalog($1::uuid,$2::uuid,$3::date) as data",
    [auth, app, await authorizationDate(db)]);
  return (res.rows[0].data.projects ?? []).map((p) => p.project_id).sort();
}

/** One SUBMITTED worker row in the given project (history that must never vanish). */
async function insertSubmittedEntry(db, { project, recruiter = REC_D, createdBy = ADMIN_APP }) {
  const n = await countOf(db, "select count(*)::int as n from public.direct_entries") + 1;
  const candidate = uuid(5000 + n), submission = uuid(6000 + n), entry = uuid(7000 + n);
  const date = await authorizationDate(db);
  // The submission non-empty guard is deferred, so the row and its entry must be
  // written inside one explicit transaction (same pattern as the W02 suite).
  await db.exec("begin");
  try {
  await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidate]);
  await db.query(
    "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)" +
    " values ($1,$2,'DRAFT')", [submission, createdBy]);
  await db.query(
    "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
    " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
    " provider_type, labor_type)" +
    " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY')",
    [entry, submission, candidate, createdBy, project, date,
      "hrp-" + String(date).slice(0, 4) + "-" + String(300000 + n),
      JSON.stringify({ display_name: "R1 Worker " + n, date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" }, address: { state: "omitted" },
        phone: { state: "omitted" } }),
      recruiter, TEAM]);
  await seedLegacyReviewSubmission(db, submission);
  await db.query(
    "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
    [submission]);
  await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return entry;
}

// ---------------------------------------------------------------------------
// 1. Project master CRUD: versioned, audited, reversible, never deleted.
// ---------------------------------------------------------------------------
test("R1: project create/update/deactivate is versioned and audited", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const created = await createProject(db);
    assert.deepEqual(
      { project_id: created.project_id, active: created.active, version: created.version,
        created: created.created },
      { project_id: "proj_r1", active: true, version: 1, created: true });

    const afterCreate = await revisionRows(db);
    assert.equal(afterCreate.length, 1, "create appends exactly one project revision");
    assert.equal(afterCreate[0].version, 1);
    assert.equal(afterCreate[0].before_snapshot, null, "creation has no before state");
    assert.equal(afterCreate[0].after_snapshot.display_name, "R1 Project");
    assert.equal(afterCreate[0].after_snapshot.version, 1);
    assert.equal(afterCreate[0].has_reason, true, "a project revision always carries a reason");

    const renamed = await updateProject(db, { expectedVersion: 1, displayName: "R1 Renamed" });
    assert.equal(renamed.version, 2);
    const deactivated = await setProjectActive(db, { active: false, expectedVersion: 2 });
    assert.equal(deactivated.version, 3);
    assert.equal(deactivated.active, false);

    const revisions = await revisionRows(db);
    assert.deepEqual(revisions.map((r) => r.version), [1, 2, 3]);
    assert.equal(revisions[1].before_snapshot.display_name, "R1 Project");
    assert.equal(revisions[1].after_snapshot.display_name, "R1 Renamed");
    assert.equal(revisions[2].before_snapshot.active, true);
    assert.equal(revisions[2].after_snapshot.active, false);
    assert.equal(revisions.every((r) => r.after_snapshot.version === r.version), true,
      "the stored after-snapshot can never disagree with the project row version");

    const project = await getProject(db);
    assert.equal(project.display_name, "R1 Renamed");
    assert.equal(project.active, false);
    assert.equal(project.version, 3);
    assert.equal(project.revision_count, 3);
    assert.equal(project.created_at !== null, true,
      "the first audited mutation is the honest creation timestamp");
    assert.equal(project.updated_at !== null, true);

    const actions = await db.query(
      "select action, capability, scope_kind, project_revision_id is not null as linked" +
      " from public.direct_entry_audit_events where resource_ref = 'proj_r1' order by created_at");
    assert.deepEqual(actions.rows.map((r) => r.action),
      ["project_create", "project_update", "project_set_active"]);
    assert.equal(actions.rows.every((r) => r.capability === "entry_admin"), true);
    assert.equal(actions.rows.every((r) => r.scope_kind === "all"), true);
    assert.equal(actions.rows.every((r) => r.linked), true,
      "every project audit event points at the revision it produced");
  } finally {
    await db.close();
  }
});

test("R1: an inactive or referenced project is never hard-deleted", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createProject(db);
    await insertSubmittedEntry(db, { project: "proj_r1" });
    await setProjectActive(db, { active: false, expectedVersion: 1 });

    // No administrative surface can delete a project.
    assert.equal(await countOf(db,
      "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname = 'public' and p.proname like 'direct_entry_%project%'" +
      " and p.proname like '%delete%'"), 0,
    "no project delete/drop RPC may exist");

    // Direct DML is blocked twice over: the roles have no table privilege, and
    // the owner is stopped by the referencing rows / the append-only revision.
    for (const role of ["anon", "authenticated", "service_role"]) {
      const priv = await db.query(
        "select has_table_privilege($1,'public.direct_entry_projects','DELETE') as d", [role]);
      assert.equal(priv.rows[0].d, false, role + " must not be able to delete a project");
    }
    await assert.rejects(
      () => db.query("delete from public.direct_entry_projects where project_id = 'proj_r1'"),
      (error) => error.code === "23503" || /foreign key constraint/.test(error.message),
      "a referenced project cannot be deleted even by direct DML");
    await assert.rejects(
      () => db.query("delete from public.direct_entry_project_revisions where project_id = 'proj_r1'"),
      (error) => error.code === "55000",
      "the revision history is append-only");
    assert.equal(await countOf(db,
      "select count(*)::int as n from public.direct_entry_projects where project_id = 'proj_r1'"),
    1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. OCC + ABA: the count could not see it, the project version can.
// ---------------------------------------------------------------------------
test("R1: a stale project version refuses ABA after A is removed and B added", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createProject(db);
    const first = await assign(db, { manager: REC_A, expectedProjectVersion: 1 });
    assert.equal(first.project_version, 2);

    // Client snapshot: version 2 with exactly one active manager.
    const snapshot = { projectVersion: 2, activeCount: await activeAssignmentCount(db) };
    assert.equal(snapshot.activeCount, 1);

    const second = await assign(db, { manager: REC_B, expectedProjectVersion: 2, key: "assign-key-2" });
    assert.equal(second.project_version, 3);
    assert.equal(await activeAssignmentCount(db), 2);

    const revoked = await unassign(db, {
      assignmentId: first.assignment_id, expectedVersion: 1,
      expectedProjectVersion: 3, key: "unassign-key-aba",
    });
    assert.equal(revoked.version, 2, "the assignment row has its own OCC version");
    assert.equal(revoked.project_version, 4);

    // ABA: the active count is back to the value in the snapshot, but the state
    // is different (manager B, not manager A). A count-based OCC accepts this.
    assert.equal(await activeAssignmentCount(db), snapshot.activeCount,
      "the row count alone cannot see the ABA sequence");
    assert.notEqual(await projectVersion(db), snapshot.projectVersion);
    assert.equal(await canAccess(db, MGR_B_APP, "proj_r1"), true);
    assert.equal(await canAccess(db, MGR_A_APP, "proj_r1"), false);

    // A request built from the old snapshot must be refused as stale.
    await assert.rejects(
      () => assign(db, {
        manager: REC_C, expectedProjectVersion: snapshot.projectVersion, key: "assign-key-aba",
      }),
      (error) => error.code === "PT409",
      "a stale project snapshot may not add a manager");
    await assert.rejects(
      () => unassign(db, {
        assignmentId: second.assignment_id, expectedVersion: 1,
        expectedProjectVersion: snapshot.projectVersion, key: "unassign-key-aba-stale",
      }),
      (error) => error.code === "PT409",
      "a stale project snapshot may not remove a manager");
    await assert.rejects(
      () => updateProject(db, { expectedVersion: snapshot.projectVersion }),
      (error) => error.code === "PT409");
    await assert.rejects(
      () => setProjectActive(db, { active: false, expectedVersion: snapshot.projectVersion }),
      (error) => error.code === "PT409");

    // Nothing changed, and the same request with the CURRENT version succeeds.
    assert.equal(await projectVersion(db), 4);
    assert.equal(await activeAssignmentCount(db), 1);
    const current = await assign(db, {
      manager: REC_C, expectedProjectVersion: 4, key: "assign-key-aba-current",
    });
    assert.equal(current.project_version, 5);
    assert.equal(await projectVersion(db), 5, "the project version only ever moves forward");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Every assignment mutation advances the project version + writes a revision.
// ---------------------------------------------------------------------------
test("R1: every assignment mutation bumps the project version and appends a revision", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createProject(db);
    const a = await assign(db, { manager: REC_A, expectedProjectVersion: 1 });
    const b = await assign(db, { manager: REC_B, expectedProjectVersion: 2, key: "assign-key-2" });
    const removed = await unassign(db, {
      assignmentId: a.assignment_id, expectedVersion: 1, expectedProjectVersion: 3,
      key: "unassign-key-1",
    });

    assert.deepEqual(
      [a.project_version, b.project_version, removed.project_version], [2, 3, 4],
      "each assignment mutation advanced the project version by exactly one");
    assert.equal(await projectVersion(db), 4);

    const revisions = await revisionRows(db);
    assert.deepEqual(revisions.map((r) => r.version), [1, 2, 3, 4],
      "one revision per mutation, contiguous and unique per project");
    assert.deepEqual(
      revisions.slice(1).map((r) => r.after_snapshot.assignment_change.change),
      ["ASSIGN", "ASSIGN", "UNASSIGN"]);
    assert.equal(revisions[3].after_snapshot.assignment_change.assignment_id, a.assignment_id);
    assert.equal(revisions[1].after_snapshot.assignment_change.manager_recruiter_id, REC_A);
    assert.equal(revisions[3].before_snapshot.version, 3,
      "before/after snapshots bracket the mutation");
    assert.equal(revisions.every((r) => r.actor === ADMIN_APP), true,
      "the revision records the acting administrator");
    assert.equal(revisions.every((r) => r.has_reason), true);

    const linked = await db.query(
      "select a.action, a.project_revision_id::text as revision_id, r.version" +
      " from public.direct_entry_audit_events a" +
      " join public.direct_entry_project_revisions r on r.revision_id = a.project_revision_id" +
      " where a.action like 'project_manager_assignment%' order by a.created_at");
    assert.deepEqual(linked.rows.map((r) => r.action),
      ["project_manager_assignment_assign", "project_manager_assignment_assign",
        "project_manager_assignment_unassign"]);
    assert.deepEqual(linked.rows.map((r) => r.version), [2, 3, 4],
      "assignment audit events are linked to the project revision they caused");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3b. R2: the revision snapshot contract holds after real mutations.
//     Mirrors the #51 self-check predicate (section 5 of the migration) so the
//     invariant is verified against data, not only at migration time.
// ---------------------------------------------------------------------------
const REVISION_SNAPSHOT_KEYS = ["project_id", "display_name", "active", "version"];
const REVISION_INVARIANT_SQL =
  "select count(*)::int as n from public.direct_entry_project_revisions r" +
  " where not (r.after_snapshot ?& array['project_id','display_name','active','version'])" +
  " or r.after_snapshot->>'project_id' is distinct from r.project_id" +
  " or (r.after_snapshot->>'version')::int is distinct from r.version" +
  " or (r.before_snapshot is not null" +
  "     and not (r.before_snapshot ?& array['project_id','display_name','active','version']))";

test("R2: every project revision stores a full project snapshot, not a delta", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createProject(db);                                   // revision 1 (create)
    const a = await assign(db, { manager: REC_A, expectedProjectVersion: 1 }); // revision 2
    await assign(db, { manager: REC_B, expectedProjectVersion: 2, key: "assign-key-2" }); // 3
    await unassign(db, { assignmentId: a.assignment_id, expectedVersion: 1,
      expectedProjectVersion: 3, key: "unassign-key-snap" });  // revision 4
    await updateProject(db, { expectedVersion: 4, displayName: "R2 Snapshot",
      key: "update-key-snap" });                               // revision 5
    await setProjectActive(db, { active: false, expectedVersion: 5,
      key: "active-key-snap" });                               // revision 6

    assert.equal(await countOf(db, REVISION_INVARIANT_SQL), 0,
      "the #51 self-check invariant must find no bad revision after assign/unassign");

    const revisions = await revisionRows(db);
    assert.deepEqual(revisions.map((r) => r.version), [1, 2, 3, 4, 5, 6]);
    for (const revision of revisions) {
      for (const key of REVISION_SNAPSHOT_KEYS) {
        assert.ok(key in revision.after_snapshot,
          "after_snapshot of revision " + revision.version + " must carry " + key);
      }
      assert.equal(revision.after_snapshot.project_id, revision.project_id);
      assert.equal(revision.after_snapshot.version, revision.version,
        "after_snapshot.version must equal revision.version");
      assert.equal(revision.after_snapshot.display_name !== undefined, true);
      assert.equal(revision.after_snapshot.active !== undefined, true);
      assert.equal(revision.after_snapshot.change, undefined,
        "the assignment delta must not replace the project snapshot");
      if (revision.before_snapshot !== null) {
        for (const key of REVISION_SNAPSHOT_KEYS) {
          assert.ok(key in revision.before_snapshot,
            "before_snapshot of revision " + revision.version + " must carry " + key);
        }
        assert.equal(revision.before_snapshot.version, revision.version - 1,
          "before_snapshot is the project state before the mutation");
      }
    }
    assert.equal(revisions[0].before_snapshot, null, "creation has no before state");

    // The assignment delta is preserved under its own key.
    assert.deepEqual(
      revisions.slice(1, 4).map((r) => r.after_snapshot.assignment_change.change),
      ["ASSIGN", "ASSIGN", "UNASSIGN"]);
    assert.equal(revisions.slice(1, 4).every(
      (r) => r.after_snapshot.display_name === "R1 Project"), true,
    "an assignment mutation does not rewrite the project display name");
    assert.equal(revisions[4].after_snapshot.display_name, "R2 Snapshot");
    assert.equal(revisions[4].after_snapshot.assignment_change, undefined);
    assert.equal(revisions[5].after_snapshot.active, false);

    // The stored sequence cannot disagree with the project row.
    assert.equal(revisions[revisions.length - 1].version, await projectVersion(db),
      "the last revision version is the project version");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Fail-closed OCC on both tiers, with no partial mutation.
// ---------------------------------------------------------------------------
test("R1: stale project and stale assignment versions fail closed with no mutation", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createProject(db);
    const created = await assign(db, { manager: REC_A, expectedProjectVersion: 1 });

    const before = {
      audits: await auditCount(db),
      revisions: (await revisionRows(db)).length,
      reasons: await countOf(db, "select count(*)::int as n from public.direct_entry_restricted_reasons"),
      assignments: await countOf(db,
        "select count(*)::int as n from public.direct_entry_project_manager_assignments"),
    };

    for (const stale of [1, 9]) {
      await assert.rejects(() => assign(db, {
        manager: REC_B, expectedProjectVersion: stale, key: "assign-key-stale-" + stale,
      }), (error) => error.code === "PT409");
      await assert.rejects(() => unassign(db, {
        assignmentId: created.assignment_id, expectedVersion: 1,
        expectedProjectVersion: stale, key: "unassign-key-stale-" + stale,
      }), (error) => error.code === "PT409");
      await assert.rejects(() => updateProject(db, {
        expectedVersion: stale, key: "update-key-stale-" + stale,
      }), (error) => error.code === "PT409");
      await assert.rejects(() => setProjectActive(db, {
        active: false, expectedVersion: stale, key: "active-key-stale-" + stale,
      }), (error) => error.code === "PT409");
    }

    // Correct project version, stale ASSIGNMENT version (tier 2 OCC).
    await assert.rejects(() => unassign(db, {
      assignmentId: created.assignment_id, expectedVersion: 7, expectedProjectVersion: 2,
      key: "unassign-key-tier2",
    }), (error) => error.code === "PT409");

    // A missing project and a missing assignment stay distinguishable from a
    // stale one.
    await assert.rejects(() => assign(db, {
      project: "proj_absent", manager: REC_B, expectedProjectVersion: 1, key: "assign-key-absent",
    }), (error) => error.code === "P0002");
    await assert.rejects(() => unassign(db, {
      assignmentId: uuid(999), expectedVersion: 1, expectedProjectVersion: 2, key: "unassign-key-absent",
    }), (error) => error.code === "P0002");

    assert.deepEqual({
      audits: await auditCount(db),
      revisions: (await revisionRows(db)).length,
      reasons: await countOf(db, "select count(*)::int as n from public.direct_entry_restricted_reasons"),
      assignments: await countOf(db,
        "select count(*)::int as n from public.direct_entry_project_manager_assignments"),
      projectVersion: await projectVersion(db),
    }, { ...before, projectVersion: 2 },
    "a refused mutation leaves no audit, revision, reason, assignment or version change");

    const row = await db.query(
      "select a.valid_to, a.version as assignment_version, p.active, p.display_name" +
      " from public.direct_entry_projects p," +
      " lateral (select valid_to, version from public.direct_entry_project_manager_assignments" +
      " where assignment_id = $1) a where p.project_id = 'proj_r1'", [created.assignment_id]);
    assert.equal(row.rows[0].valid_to, null, "the assignment was not revoked");
    assert.equal(row.rows[0].active, true, "the project was not deactivated");
    assert.equal(row.rows[0].display_name, "R1 Project");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Reason, idempotency, audit and revision completeness.
// ---------------------------------------------------------------------------
test("R1: reason, idempotency, audit and revision are complete for every mutation", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createProject(db);

    const first = await assign(db, { manager: REC_A, expectedProjectVersion: 1 });
    const replay = await assign(db, { manager: REC_A, expectedProjectVersion: 1 });
    assert.deepEqual(replay, first, "same key + same payload replays the stored result");
    assert.equal((await revisionRows(db)).length, 2, "a replay writes no revision");
    assert.equal(await auditCount(db), 2, "a replay writes no audit event");
    assert.equal(await countOf(db,
      "select count(*)::int as n from public.direct_entry_restricted_reasons"), 2,
    "a replay writes no reason");

    await assert.rejects(() => assign(db, {
      manager: REC_B, expectedProjectVersion: 1,
    }), (error) => error.code === "22023",
    "the same key with a different payload is refused");
    assert.equal((await revisionRows(db)).length, 2);

    const updated = await updateProject(db, { expectedVersion: 2, displayName: "R1 Snapshot" });
    const updateReplay = await updateProject(db, { expectedVersion: 2, displayName: "R1 Snapshot" });
    assert.deepEqual(updateReplay, updated);
    await assert.rejects(() => updateProject(db, {
      expectedVersion: 2, displayName: "R1 Other",
    }), (error) => error.code === "22023");
    assert.equal((await revisionRows(db)).length, 3);

    const deactivated = await setProjectActive(db, {
      active: false, expectedVersion: 3, key: "active-key-1",
    });
    const activeReplay = await setProjectActive(db, {
      active: false, expectedVersion: 3, key: "active-key-1",
    });
    assert.deepEqual(activeReplay, deactivated);
    assert.equal(deactivated.version, 4);

    // A no-op mutation is refused instead of writing a false revision.
    await assert.rejects(() => updateProject(db, {
      expectedVersion: 4, displayName: "R1 Snapshot", key: "update-key-noop",
    }), (error) => error.code === "22023");
    await assert.rejects(() => setProjectActive(db, {
      active: false, expectedVersion: 4, key: "active-key-noop",
    }), (error) => error.code === "22023");
    assert.equal((await revisionRows(db)).length, 4);

    const expectedReasons = await countOf(db,
      "select count(*)::int as n from public.direct_entry_restricted_reasons");
    assert.equal(expectedReasons, 4,
      "one restricted reason per accepted mutation, none per refusal and none per replay");

    const joined = await db.query(
      "select a.action, a.reason_id = r.reason_id as same_reason, a.app_user_id::text as actor," +
      " r.actor_user_id::text as revision_actor" +
      " from public.direct_entry_audit_events a" +
      " join public.direct_entry_project_revisions r on r.revision_id = a.project_revision_id" +
      " where a.action like 'project%' order by a.created_at");
    assert.equal(joined.rows.length, 4, "each accepted mutation is audited and revision-linked");
    assert.deepEqual(joined.rows.map((r) => r.action).sort(), ["project_create",
      "project_manager_assignment_assign", "project_set_active", "project_update"]);
    assert.equal(joined.rows.every((r) => r.same_reason), true,
      "the audit event and the revision share the one restricted reason");
    assert.equal(joined.rows.every((r) => r.actor === ADMIN_APP && r.revision_actor === ADMIN_APP), true);

    // The list projection exposes the OCC token the caller must return.
    const list = await listProjects(db);
    assert.equal(list.projects.length, 1);
    assert.equal(list.projects[0].version, 4);
    assert.equal(list.projects[0].active, false);
    assert.equal(list.projects[0].active_assignment_count, 1);
    assert.equal(list.projects[0].revision_count, 4);
    assert.equal((await listProjects(db, false)).projects.length, 0,
      "the inactive project is filtered out of the active-only projection");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. An inactive project accepts no new assignment.
// ---------------------------------------------------------------------------
test("R1: an inactive project accepts no new assignment and leaves the catalog", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createProject(db);
    await insertSubmittedEntry(db, { project: "proj_r1" });
    const assigned = await assign(db, { manager: REC_A, expectedProjectVersion: 1 });
    assert.deepEqual(await catalogProjectIds(db, MGR_A_AUTH, MGR_A_APP), ["proj_r1"]);

    await setProjectActive(db, { active: false, expectedVersion: 2 });
    await assert.rejects(() => assign(db, {
      manager: REC_B, expectedProjectVersion: 3, key: "assign-key-inactive",
    }), (error) => error.code === "22023",
    "a deactivated project must not receive a new manager");

    // Deactivation hides the project from the create-new flow...
    assert.deepEqual(await catalogProjectIds(db, MGR_A_AUTH, MGR_A_APP), [],
      "an inactive project is not selectable for new entries");
    assert.equal((await listProjects(db, false)).projects.length, 0);
    assert.equal((await listProjects(db, true)).projects.length, 1);

    // ...but it is not an authority revocation: the existing assignment still
    // governs access to the history, and only unassign revokes it.
    assert.equal(await canAccess(db, MGR_A_APP, "proj_r1"), true);
    await unassign(db, {
      assignmentId: assigned.assignment_id, expectedVersion: 1, expectedProjectVersion: 3,
    });
    assert.equal(await canAccess(db, MGR_A_APP, "proj_r1"), false,
      "unassign still works on an inactive project and revokes authority");
    assert.equal(await projectVersion(db), 4);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 7. History survives deactivate and unassign.
// ---------------------------------------------------------------------------
test("R1: worker, project and assignment history survive deactivate and unassign", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createProject(db);
    const entry = await insertSubmittedEntry(db, { project: "proj_r1" });
    const assigned = await assign(db, { manager: REC_A, expectedProjectVersion: 1 });
    const entryBefore = await db.query(
      "select e.project_id, e.version, e.deleted_at, s.state" +
      " from public.direct_entries e join public.direct_entry_submissions s" +
      " on s.submission_id = e.submission_id where e.entry_id = $1::uuid", [entry]);

    await setProjectActive(db, { active: false, expectedVersion: 2 });
    const revoked = await unassign(db, {
      assignmentId: assigned.assignment_id, expectedVersion: 1, expectedProjectVersion: 3,
    });
    assert.equal(revoked.already_unassigned, false);

    const entryAfter = await db.query(
      "select e.project_id, e.version, e.deleted_at, s.state" +
      " from public.direct_entries e join public.direct_entry_submissions s" +
      " on s.submission_id = e.submission_id where e.entry_id = $1::uuid", [entry]);
    assert.deepEqual(entryAfter.rows[0], entryBefore.rows[0],
      "deactivate/unassign must not touch the worker row");

    assert.deepEqual(await db.query(
      "select project_id, active, version from public.direct_entry_projects" +
      " where project_id = 'proj_r1'").then((r) => r.rows[0]),
    { project_id: "proj_r1", active: false, version: 4 },
    "the project row survives deactivation");

    const assignment = await db.query(
      "select valid_to is not null as closed, revoked_by_user_id::text as revoked_by," +
      " revoke_reason_id is not null as has_reason, version, assignment_id::text as id" +
      " from public.direct_entry_project_manager_assignments where assignment_id = $1::uuid",
      [assigned.assignment_id]);
    assert.deepEqual(assignment.rows[0], {
      closed: true, revoked_by: ADMIN_APP, has_reason: true, version: 2,
      id: assigned.assignment_id,
    }, "the assignment is closed, never deleted");
    assert.equal((await revisionRows(db)).length, 4,
      "the project revision history is intact after deactivate + unassign");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 8. ACL / SECURITY DEFINER / search_path for every new object.
// ---------------------------------------------------------------------------
const R1_HELPERS = [
  "public.direct_entry_lock_project(text, integer)",
  "public.direct_entry_project_snapshot(public.direct_entry_projects)",
  "public.direct_entry_write_project_revision(text, integer, uuid, uuid, jsonb, jsonb)",
  "public.direct_entry_bump_project_version(text, uuid, uuid, jsonb, jsonb)",
];
const R1_RPCS = [
  "public.direct_entry_list_projects_admin(uuid, uuid, boolean)",
  "public.direct_entry_get_project_admin(uuid, uuid, text)",
  "public.direct_entry_create_project(uuid, uuid, text, text, text, text)",
  "public.direct_entry_update_project(uuid, uuid, text, integer, text, text, text)",
  "public.direct_entry_set_project_active(uuid, uuid, text, boolean, integer, text, text)",
  "public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text)",
  "public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, integer, text, text)",
];

test("R1: new helpers/RPCs are hardened and the revision table is locked down", async () => {
  const db = await buildDb();
  try {
    for (const signature of R1_HELPERS) {
      const res = await db.query(
        "select p.prosecdef, p.proconfig from pg_proc p where p.oid = $1::regprocedure",
        [signature]);
      assert.equal(res.rows[0].prosecdef, true, signature + " must be SECURITY DEFINER");
      assert.ok(res.rows[0].proconfig.includes("search_path=pg_catalog, public"),
        signature + " must pin search_path");
      for (const role of ["anon", "authenticated", "service_role"]) {
        const priv = await db.query(
          "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [role, signature]);
        assert.equal(priv.rows[0].ok, false, signature + " must stay revoked from " + role);
      }
    }

    for (const signature of R1_RPCS) {
      const res = await db.query(
        "select p.prosecdef, p.proconfig from pg_proc p where p.oid = $1::regprocedure",
        [signature]);
      assert.equal(res.rows[0].prosecdef, true, signature + " must be SECURITY DEFINER");
      assert.ok(res.rows[0].proconfig.includes("search_path=pg_catalog, public"),
        signature + " must pin search_path");
      for (const [role, expected] of [["service_role", true], ["anon", false],
        ["authenticated", false]]) {
        const priv = await db.query(
          "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [role, signature]);
        assert.equal(priv.rows[0].ok, expected, signature + " vs " + role);
      }
    }

    // The revision table is exactly as unreachable as every other revision table.
    const table = await db.query(
      "select relrowsecurity, relforcerowsecurity from pg_class" +
      " where oid = 'public.direct_entry_project_revisions'::regclass");
    assert.deepEqual(table.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    for (const role of ["anon", "authenticated", "service_role"]) {
      const res = await db.query(
        "select has_table_privilege($1,'public.direct_entry_project_revisions','SELECT') as s," +
        " has_table_privilege($1,'public.direct_entry_project_revisions','INSERT') as i," +
        " has_table_privilege($1,'public.direct_entry_project_revisions','UPDATE') as u," +
        " has_table_privilege($1,'public.direct_entry_project_revisions','DELETE') as d", [role]);
      assert.deepEqual(res.rows[0], { s: false, i: false, u: false, d: false },
        role + " must have no access to the project revision history");
    }
    const triggers = await db.query(
      "select tgname from pg_trigger where tgrelid =" +
      " 'public.direct_entry_project_revisions'::regclass and not tgisinternal");
    assert.deepEqual(triggers.rows.map((r) => r.tgname),
      ["direct_entry_project_revisions_immutable"]);

    // The OCC column itself stays behind the RPC boundary.
    for (const role of ["anon", "authenticated", "service_role"]) {
      const priv = await db.query(
        "select has_table_privilege($1,'public.direct_entry_projects','SELECT') as s", [role]);
      assert.equal(priv.rows[0].s, false, role + " must not read the project master directly");
    }
    const link = await db.query(
      "select c.is_nullable from information_schema.columns c" +
      " where c.table_schema='public' and c.table_name='direct_entry_audit_events'" +
      " and c.column_name='project_revision_id'");
    assert.equal(link.rows[0].is_nullable, "YES");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 9. F3 regression guard: #50/#51 keep their order; no fake atomic apply.
// ---------------------------------------------------------------------------
test("R1: #50/#51 keep ledger order and cannot be grouped atomically", async () => {
  const w07e = (await readFile(path.join(MIGRATION_DIR, W07E_MIGRATION), "utf8")).toLowerCase();
  const w02 = (await readFile(path.join(MIGRATION_DIR, W02_MIGRATION), "utf8")).toLowerCase();
  for (const [name, sql] of [[W07E_MIGRATION, w07e], [W02_MIGRATION, w02]]) {
    assert.match(sql, /\nbegin;/,
      name + " opens its own transaction");
    assert.match(sql, /\ncommit;\s*$/,
      name + " closes its own transaction with an inner COMMIT");
  }
  assert.ok(W07E_MIGRATION < W02_MIGRATION, "#51 always applies after #50");
  assert.ok((await readdir(MIGRATION_DIR)).includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");

  // The repo's only apply path is one transaction PER FILE, so there is no
  // grouped-apply mode that could make the two files atomic.
  const applyScript = await readFile(path.join(ROOT, "scripts", "apply-migrations.mjs"), "utf8");
  assert.match(applyScript, /await client\.query\("begin"\)/);
  assert.match(applyScript, /await client\.query\("commit"\)/);
  assert.equal(/single-transaction|--grouped|applyGrouped/.test(applyScript), false,
    "no grouped/one-transaction apply mode may be added");

  // Guard against reintroducing the withdrawn proposal anywhere in the lane.
  for (const relative of ["scripts/apply-migrations.mjs",
    "docs/handoffs/p2-5-w02-multi-manager-project-authority-HANDOFF.md",
    "scripts/p2-5-w02-w07e50-safety-check.mjs"]) {
    const text = await readFile(path.join(ROOT, relative), "utf8");
    assert.equal(text.includes("--single-transaction"), false,
      relative + " must not propose psql --single-transaction (an inner COMMIT makes it non-atomic)");
  }
});
