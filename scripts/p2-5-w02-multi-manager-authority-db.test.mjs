/**
 * P2.5-W02 - multi-manager project authority (DB regression, PGlite).
 *
 * Verifies the Owner policy lock at the DB boundary:
 *   * several managers can be concurrently effective on one project;
 *   * authority comes ONLY from an assignment effective at operation time
 *     (verified app-user/recruiter link + [valid_from, valid_to));
 *   * created_by, team, recruiter attribution and the worker's first_work_date
 *     never grant project authority;
 *   * unassign revokes runtime authority immediately and keeps history;
 *   * the admin RPCs require capability + all scope, allow an optional action
 *     reason, enforce OCC, and write immutable audit rows;
 *   * the #51 expand/backfill preserves existing assignments without inventing
 *     actor or reason history.
 *
 * Scope note: P3-W07E (#50) still contains its creator/team/first_work_date
 * propose fallback. Rebaselining that policy is P2.5-W04, so this suite asserts
 * the W02 project-authority helpers only and does not pretend the #50 propose
 * path is already fixed.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const W02_MIGRATION =
  "20261008110000_p2_5_w02_multi_manager_project_authority.sql";
const W03_MIGRATION =
  "20261008120000_p2_5_w03_worker_directory_projection.sql";
const W04_MIGRATION =
  "20261008130000_p2_5_w04_project_manager_change_request_policy.sql";
const PRE_W02_MIGRATION =
  "20261008100000_p3_w07e_project_manager_submitted_change_requests.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

const AUTHORIZATION_DATE = "2026-10-08"; // fixed in the fixture via the helper below

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_1 = "proj_1", PROJ_2 = "proj_2";
const REC_A = uuid(21), REC_B = uuid(22), REC_C = uuid(23), REC_D = uuid(24),
  REC_CREATOR = uuid(25), REC_NO_SCOPE = uuid(26);
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const MGR_A_AUTH = uuid(32), MGR_A_APP = uuid(42);
const MGR_B_AUTH = uuid(33), MGR_B_APP = uuid(43);
const MGR_C_AUTH = uuid(34), MGR_C_APP = uuid(44);
const REC_AUTH = uuid(35), REC_APP = uuid(45);
const CREATOR_AUTH = uuid(36), CREATOR_APP = uuid(46);
const MGR_NO_SCOPE_AUTH = uuid(37), MGR_NO_SCOPE_APP = uuid(47);

async function migrationNamesUpTo(untilName) {
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  if (untilName === null) return names;
  const index = names.indexOf(untilName);
  assert.notEqual(index, -1, "migration not found: " + untilName);
  return names.slice(0, index + 1);
}

async function migratedDb(untilName = null) {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = await migrationNamesUpTo(untilName);
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return { db, names };
}

async function buildDb() {
  const { db, names } = await migratedDb(null);
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(W02_MIGRATION), 50, "W02 is #51");
  assert.equal(names.indexOf(W04_MIGRATION), 52, "W04 is #53");
  assert.equal(names.indexOf(W03_MIGRATION), 51, "P2.5-W03 stays at #52");
  return db;
}

async function seedActors(db) {
  const hasCurrentState = (await db.query(
    "select 1 from information_schema.columns where table_schema='public'" +
    " and table_name='direct_entry_capability_grants' and column_name='is_current'",
  )).rows.length > 0;
  const markerColumn = hasCurrentState ? ", is_current" : "";
  const markerValue = hasCurrentState ? ", true" : "";
  const actors = [
    [ADMIN_AUTH, ADMIN_APP], [MGR_A_AUTH, MGR_A_APP], [MGR_B_AUTH, MGR_B_APP],
    [MGR_C_AUTH, MGR_C_APP], [REC_AUTH, REC_APP], [CREATOR_AUTH, CREATOR_APP],
    [MGR_NO_SCOPE_AUTH, MGR_NO_SCOPE_APP],
  ];
  // P2.5-HF-R5: display_name exists from #62; the PRE_W02 partial ledger must
  // keep working without it.
  const hasDisplayName = (await db.query(
    "select 1 from information_schema.columns where table_schema='public'" +
    " and table_name='direct_entry_app_users' and column_name='display_name'",
  )).rows.length > 0;
  for (const [auth, app] of actors) {
    await db.query("insert into auth.users (id) values ($1)", [auth]);
    await db.query(
      hasDisplayName
        ? "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')"
        : "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled) values ($1,$2,true)",
      [app, auth]);
  }
  // entry_admin + all scope: the explicit project-administration bundle.
  for (const capability of ["entry_admin", "change_request_create", "entry_create"]) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from${markerColumn})` +
      ` values ($1,$2,'2020-01-01'${markerValue})`, [ADMIN_APP, capability]);
  }
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from${markerColumn})` +
    ` values ($1,'all','2020-01-01'${markerValue})`, [ADMIN_APP]);
  // A manager with entry_admin but WITHOUT the all scope must not administer.
  await db.query(
    `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from${markerColumn})` +
    ` values ($1,'entry_admin','2020-01-01'${markerValue})`, [MGR_NO_SCOPE_APP]);
  for (const app of [MGR_A_APP, MGR_B_APP, MGR_C_APP, REC_APP, CREATOR_APP]) {
    for (const capability of ["change_request_create", "entry_create"]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from${markerColumn})` +
        ` values ($1,$2,'2020-01-01'${markerValue})`, [app, capability]);
    }
  }

  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_A','Team A')", [TEAM]);
  for (const [project, name] of [[PROJ_1, "Project One"], [PROJ_2, "Project Two"]]) {
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)",
      [project, name]);
  }
  for (const [recruiter, name] of [[REC_A, "Recruiter A"], [REC_B, "Recruiter B"],
    [REC_C, "Recruiter C"], [REC_D, "Recruiter D"],
    [REC_CREATOR, "Recruiter Creator"], [REC_NO_SCOPE, "Recruiter No Scope"]]) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1,$2)",
      [recruiter, name]);
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from${markerColumn})` +
      ` values ($1,'hrp','2020-01-01'${markerValue})`, [recruiter]);
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from${markerColumn})` +
      ` values ($1,$2,'2020-01-01'${markerValue})`, [recruiter, TEAM]);
  }
  const links = [
    [MGR_A_APP, REC_A], [MGR_B_APP, REC_B], [MGR_C_APP, REC_C],
    [REC_APP, REC_D], [CREATOR_APP, REC_CREATOR], [MGR_NO_SCOPE_APP, REC_NO_SCOPE],
  ];
  for (const [app, recruiter] of links) {
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links` +
      ` (app_user_id, recruiter_id, verified, valid_from${markerColumn}) values ($1,$2,true,'2020-01-01'${markerValue})`,
      [app, recruiter]);
  }
}

async function adminRpc(db, sql, params) {
  return db.query(sql, params);
}

async function listAssignments(db, projectId = null, includeHistory = false) {
  const res = await db.query(
    "select public.direct_entry_list_project_manager_assignments($1::uuid,$2::uuid,$3::text,$4::boolean) as data",
    [ADMIN_AUTH, ADMIN_APP, projectId, includeHistory]);
  return res.rows[0].data;
}

/**
 * The project OCC token, exactly as the list RPC hands it to a client. P2.5-W02-R1
 * replaced "expected active assignment count" with this monotonic version, so a
 * stale snapshot is refused even when the row count did not change (ABA).
 */
async function currentProjectVersion(db, project = PROJ_1) {
  const res = await db.query(
    "select version from public.direct_entry_projects where project_id = $1", [project]);
  return res.rows[0].version;
}

async function assign(db, {
  project = PROJ_1, manager = REC_A, validFrom = null, expectedProjectVersion = null,
  reason = "Owner approved project manager assignment", key = "assign-key-1",
  actor = ADMIN_APP, auth = ADMIN_AUTH,
} = {}) {
  // Tests that are not about OCC read the current token; OCC cases pass it in.
  const expected = expectedProjectVersion === null
    ? await currentProjectVersion(db, project) : expectedProjectVersion;
  const res = await db.query(
    "select public.direct_entry_assign_project_manager($1::uuid,$2::uuid,$3::text,$4::uuid,$5::date,$6::integer,$7::text,$8::text) as data",
    [auth, actor, project, manager, validFrom, expected, reason, key]);
  return res.rows[0].data;
}

async function unassign(db, {
  assignmentId, expectedVersion = 1, expectedProjectVersion = null,
  reason = "Owner removed project manager",
  key = "unassign-key-1", actor = ADMIN_APP, auth = ADMIN_AUTH,
} = {}) {
  const owner = await db.query(
    "select project_id from public.direct_entry_project_manager_assignments where assignment_id = $1",
    [assignmentId]);
  const expectedProject = expectedProjectVersion === null
    ? await currentProjectVersion(db, owner.rows[0].project_id) : expectedProjectVersion;
  const res = await db.query(
    "select public.direct_entry_unassign_project_manager($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::integer,$6::text,$7::text) as data",
    [auth, actor, assignmentId, expectedVersion, expectedProject, reason, key]);
  return res.rows[0].data;
}

async function canAccess(db, app, project) {
  const res = await db.query(
    "select public.direct_entry_actor_can_access_project($1::uuid,$2::text) as ok", [app, project]);
  return res.rows[0].ok;
}

async function isAssignedPm(db, app, project) {
  const res = await db.query(
    "select public.direct_entry_actor_is_assigned_project_manager($1::uuid,$2::text) as ok",
    [app, project]);
  return res.rows[0].ok;
}

async function hasAssignment(db, app) {
  const res = await db.query(
    "select public.direct_entry_actor_has_project_assignment($1::uuid) as ok", [app]);
  return res.rows[0].ok;
}

/** Insert an assignment row directly (bypassing the admin RPC) for guard tests. */
async function rawAssign(db, { project = PROJ_1, manager = REC_A, validFrom, validTo = null }) {
  await db.query(
    "insert into public.direct_entry_project_manager_assignments" +
    " (project_id, manager_recruiter_id, valid_from, valid_to, revoked_at)" +
    " values ($1,$2,$3::date,$4::date, case when $4::date is null then null else now() end)",
    [project, manager, validFrom, validTo]);
}

function daysFromAuthorization(days) {
  const base = new Date(AUTHORIZATION_DATE + "T00:00:00Z");
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
async function authorizationDate(db) {
  const res = await db.query(
    "select public.direct_entry_authorization_date()::text as d");
  return res.rows[0].d;
}

async function shiftedDate(db, days) {
  const base = new Date((await authorizationDate(db)) + "T00:00:00Z");
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

async function countOf(db, sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

async function catalogProjectIds(db, auth, app) {
  const res = await db.query(
    "select public.direct_entry_input_catalog($1::uuid,$2::uuid,$3::date) as data",
    [auth, app, await authorizationDate(db)]);
  const projects = res.rows[0].data.projects ?? [];
  return projects.map((p) => p.project_id).sort();
}

async function insertSubmittedEntry(db, { project, recruiter, date, createdBy }) {
  const n = await countOf(db, "select count(*)::int as n from public.direct_entries") + 1;
  const candidate = uuid(5000 + n), submission = uuid(6000 + n), entry = uuid(7000 + n);
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
        // The employee code embeds the work-date year (direct_entries check).
        "hrp-" + String(date).slice(0, 4) + "-" + String(300000 + n),
        JSON.stringify({ display_name: "Worker " + n, date_of_birth: { state: "omitted" },
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
// 1. Several managers can be effective on one project at the same time.
// ---------------------------------------------------------------------------
test("P2.5-W02: two active managers on one project both hold authority", async () => {
  const db = await buildDb();
  try {
    await seedActors(db);
    const first = await assign(db, { manager: REC_A });
    assert.equal(first.version, 1);
    assert.equal(first.valid_to, null);
    const second = await assign(db, {
      manager: REC_B, key: "assign-key-2",
    });
    assert.notEqual(second.assignment_id, first.assignment_id);

    assert.equal(await canAccess(db, MGR_A_APP, PROJ_1), true, "first manager keeps authority");
    assert.equal(await canAccess(db, MGR_B_APP, PROJ_1), true, "second manager gains authority");
    assert.equal(await isAssignedPm(db, MGR_A_APP, PROJ_1), true);
    assert.equal(await isAssignedPm(db, MGR_B_APP, PROJ_1), true);
    assert.equal(await hasAssignment(db, MGR_A_APP), true);
    assert.equal(await hasAssignment(db, MGR_B_APP), true);

    // Adding the second manager must not rewrite the first assignment.
    const rows = await db.query(
      "select assignment_id::text as id, valid_from::text as valid_from, version" +
      " from public.direct_entry_project_manager_assignments order by created_at, assignment_id");
    assert.equal(rows.rows.length, 2);
    const firstRow = rows.rows.find((row) => row.id === first.assignment_id);
    assert.ok(firstRow);
    assert.equal(firstRow.valid_from, await authorizationDate(db));
    assert.equal(firstRow.version, 1, "no last-write-wins on the first assignment");

    const list = await listAssignments(db, PROJ_1);
    assert.equal(list.active_assignment_count, 2);
    assert.equal(list.assignments.length, 2);
    assert.equal(list.assignments.every((a) => a.effective), true);
    assert.equal(list.project_version, 3,
      "the list RPC hands back the PROJECT OCC token the caller must return");
    assert.equal(list.project_active, true);
    assert.equal(list.assignments.every((a) => a.project_version === 3), true);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Cross-project access is fail-closed.
// ---------------------------------------------------------------------------
test("P2.5-W02: a manager of another project has no authority on this one", async () => {
  const db = await buildDb();
  try {
    await seedActors(db);
    await assign(db, { project: PROJ_1, manager: REC_A });
    await assign(db, {
      project: PROJ_2, manager: REC_C, key: "assign-key-2",
    });
    assert.equal(await canAccess(db, MGR_A_APP, PROJ_1), true);
    assert.equal(await canAccess(db, MGR_A_APP, PROJ_2), false, "no cross-project authority");
    assert.equal(await isAssignedPm(db, MGR_A_APP, PROJ_2), false);
    assert.equal(await canAccess(db, MGR_C_APP, PROJ_1), false, "no cross-project authority");
    assert.equal(await canAccess(db, MGR_C_APP, PROJ_2), true);
    // The explicit admin bundle keeps the global bypass.
    assert.equal(await canAccess(db, ADMIN_APP, PROJ_1), true);
    assert.equal(await canAccess(db, ADMIN_APP, PROJ_2), true);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Expired / future / revoked assignments never grant authority.
// ---------------------------------------------------------------------------
test("P2.5-W02: expired, future and revoked assignments confer no authority", async () => {
  const db = await buildDb();
  try {
    await seedActors(db);
    // Expired interval.
    await rawAssign(db, {
      manager: REC_D, validFrom: await shiftedDate(db, -60), validTo: await shiftedDate(db, -30),
    });
    assert.equal(await canAccess(db, REC_APP, PROJ_1), false, "expired assignment is inert");
    assert.equal(await hasAssignment(db, REC_APP), false);
    // Future interval.
    await rawAssign(db, { manager: REC_C, validFrom: await shiftedDate(db, 30) });
    assert.equal(await canAccess(db, MGR_C_APP, PROJ_1), false, "future assignment is inert");
    assert.equal(await isAssignedPm(db, MGR_C_APP, PROJ_1), false);
    // Revoked interval (through the admin RPC). The future REC_C assignment is
    // still OPEN, so the OCC count for this project is 1.
    const created = await assign(db, { manager: REC_A });
    assert.equal(await canAccess(db, MGR_A_APP, PROJ_1), true);
    await unassign(db, { assignmentId: created.assignment_id });
    assert.equal(await canAccess(db, MGR_A_APP, PROJ_1), false, "revocation is immediate");
    assert.equal(await isAssignedPm(db, MGR_A_APP, PROJ_1), false);
    // The expired/future rows are still authoritative for nobody.
    assert.equal(await hasAssignment(db, REC_APP), false);
    assert.equal(await hasAssignment(db, MGR_C_APP), false);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Unassign revokes runtime authority and keeps the whole history.
// ---------------------------------------------------------------------------
test("P2.5-W02: unassign removes authority but preserves history and audit", async () => {
  const db = await buildDb();
  try {
    await seedActors(db);
    const created = await assign(db, { manager: REC_A });
    const revoked = await unassign(db, { assignmentId: created.assignment_id });
    assert.equal(revoked.already_unassigned, false);
    assert.equal(revoked.version, 2, "OCC version advances on revocation");
    assert.equal(revoked.valid_to, await authorizationDate(db));

    const row = await db.query(
      "select valid_from::text as valid_from, valid_to::text as valid_to, version," +
      " revoked_by_user_id::text as revoked_by, revoked_at is not null as has_revoked_at," +
      " revoke_reason_id is not null as has_reason, created_by_user_id::text as created_by" +
      " from public.direct_entry_project_manager_assignments where assignment_id = $1::uuid",
      [created.assignment_id]);
    assert.equal(row.rows.length, 1, "the assignment row is never deleted");
    assert.equal(row.rows[0].valid_to, await authorizationDate(db));
    assert.equal(row.rows[0].version, 2);
    assert.equal(row.rows[0].revoked_by, ADMIN_APP);
    assert.equal(row.rows[0].has_revoked_at, true);
    assert.equal(row.rows[0].has_reason, true);
    assert.equal(row.rows[0].created_by, ADMIN_APP);

    const active = await listAssignments(db, PROJ_1);
    assert.equal(active.active_assignment_count, 0);
    const history = await listAssignments(db, PROJ_1, true);
    assert.equal(history.assignments.length, 1);
    assert.equal(history.assignments[0].effective, false);

    const audit = await db.query(
      "select action, outcome, capability, resource_ref from public.direct_entry_audit_events" +
      " where resource_ref = $1 order by created_at", [created.assignment_id]);
    assert.deepEqual(audit.rows.map((r) => r.action).sort(),
      ["project_manager_assignment_assign", "project_manager_assignment_unassign"]);
    assert.equal(audit.rows.every((r) => r.outcome === "APPLIED"), true);
    assert.equal(audit.rows.every((r) => r.capability === "entry_admin"), true);
  } finally {
    await db.close();
  }
});
// ---------------------------------------------------------------------------
// 5. created_by is audit only.
// ---------------------------------------------------------------------------
test("P2.5-W02: being the entry creator grants no project authority", async () => {
  const db = await buildDb();
  try {
    await seedActors(db);
    await insertSubmittedEntry(db, {
      project: PROJ_1, recruiter: REC_D, date: await shiftedDate(db, -5),
      createdBy: CREATOR_APP,
    });
    await assign(db, { manager: REC_A });

    assert.equal(await canAccess(db, CREATOR_APP, PROJ_1), false,
      "created_by must not grant project access");
    assert.equal(await isAssignedPm(db, CREATOR_APP, PROJ_1), false);
    assert.equal(await hasAssignment(db, CREATOR_APP), false);

    // End-to-end: the W07B filtered catalog is the read-side guard.
    assert.deepEqual(await catalogProjectIds(db, MGR_A_AUTH, MGR_A_APP), [PROJ_1],
      "the assigned manager sees the project");
    assert.deepEqual(await catalogProjectIds(db, CREATOR_AUTH, CREATOR_APP), [],
      "the creator of a row in that project sees nothing");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Recruiter attribution is not project authority.
// ---------------------------------------------------------------------------
test("P2.5-W02: recruiter attribution alone grants no propose authority", async () => {
  const db = await buildDb();
  try {
    await seedActors(db);
    // REC_APP is verified-linked to REC_D, and REC_D owns submitted rows, yet the
    // actor holds no assignment anywhere.
    await insertSubmittedEntry(db, {
      project: PROJ_1, recruiter: REC_D, date: await shiftedDate(db, -3),
      createdBy: CREATOR_APP,
    });
    await insertSubmittedEntry(db, {
      project: PROJ_2, recruiter: REC_D, date: await shiftedDate(db, 3),
      createdBy: CREATOR_APP,
    });
    assert.equal(await hasAssignment(db, REC_APP), false);
    assert.equal(await canAccess(db, REC_APP, PROJ_1), false);
    assert.equal(await canAccess(db, REC_APP, PROJ_2), false);
    assert.equal(await isAssignedPm(db, REC_APP, PROJ_1), false);
    assert.deepEqual(await catalogProjectIds(db, REC_AUTH, REC_APP), [],
      "recruiter attribution does not open the project catalog");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 7. The worker's first_work_date never influences authority.
// ---------------------------------------------------------------------------
test("P2.5-W02: past and future first_work_date do not change authority", async () => {
  const db = await buildDb();
  try {
    await seedActors(db);
    await insertSubmittedEntry(db, {
      project: PROJ_1, recruiter: REC_A, date: await shiftedDate(db, -200),
      createdBy: CREATOR_APP,
    });
    await insertSubmittedEntry(db, {
      project: PROJ_1, recruiter: REC_A, date: await shiftedDate(db, 200),
      createdBy: CREATOR_APP,
    });
    await assign(db, { manager: REC_A });
    assert.equal(await canAccess(db, MGR_A_APP, PROJ_1), true,
      "authority follows the assignment, not the work date");
    assert.equal(await canAccess(db, CREATOR_APP, PROJ_1), false,
      "a past/future work date never creates authority");
    const before = await canAccess(db, MGR_A_APP, PROJ_1);
    await insertSubmittedEntry(db, {
      project: PROJ_1, recruiter: REC_A, date: await authorizationDate(db),
      createdBy: MGR_A_APP,
    });
    assert.equal(await canAccess(db, MGR_A_APP, PROJ_1), before,
      "adding more rows does not change the assignment predicate");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 8. One open assignment per pair; several managers stay allowed.
// ---------------------------------------------------------------------------
test("P2.5-W02: a duplicate active pair is blocked while other managers are allowed", async () => {
  const db = await buildDb();
  try {
    await seedActors(db);
    await assign(db, { manager: REC_A });
    await assert.rejects(
      () => assign(db, { manager: REC_A, key: "assign-key-dup" }),
      (error) => error.code === "23505",
      "the same manager cannot be assigned twice to the same project");
    const overlappingOpenFrom = await shiftedDate(db, -1);
    await assert.rejects(
      () => rawAssign(db, { manager: REC_A, validFrom: overlappingOpenFrom }),
      (error) => error.code === "23P01" || error.code === "23505",
      "direct DML cannot create a second open row for the same pair");
    // Different managers on the same project remain legal.
    const second = await assign(db, {
      manager: REC_B, key: "assign-key-b",
    });
    assert.ok(second.assignment_id);
    assert.equal(await countOf(db,
      "select count(*)::int as n from public.direct_entry_project_manager_assignments"),
      2);
    // Overlapping closed intervals for the same pair are rejected too.
    const closedFrom = await shiftedDate(db, -10);
    const closedTo = await shiftedDate(db, -5);
    await rawAssign(db, { manager: REC_C, validFrom: closedFrom, validTo: closedTo });
    const overlapFrom = await shiftedDate(db, -7);
    const overlapTo = await shiftedDate(db, -2);
    await assert.rejects(
      () => rawAssign(db, { manager: REC_C, validFrom: overlapFrom, validTo: overlapTo }),
      (error) => error.code === "23P01",
      "overlapping history for the same pair is rejected");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 9. Administration RPCs: capability, all scope, optional reason, OCC, idempotency, audit.
// ---------------------------------------------------------------------------
test("P2.5-W02: admin RPCs require capability and all scope; action reason is optional under OCC", async () => {
  const db = await buildDb();
  try {
    await seedActors(db);
    // No entry_admin capability.
    await assert.rejects(
      () => assign(db, { actor: MGR_A_APP, auth: MGR_A_AUTH }),
      (error) => error.code === "42501",
      "project administration needs the explicit entry_admin capability");
    // entry_admin without the all scope.
    await assert.rejects(
      () => assign(db, { actor: MGR_NO_SCOPE_APP, auth: MGR_NO_SCOPE_AUTH }),
      (error) => error.code === "42501",
      "project administration needs an effective all scope");
    // OCC on the project version (row-locked and fail-closed). P2.5-W02-R1
    // replaced the active-assignment count, which could not detect ABA.
    const v0 = await currentProjectVersion(db, PROJ_1);
    const blankReason = await assign(db, {
      manager: REC_C, expectedProjectVersion: v0, reason: "   ", key: "blank-reason-key",
    });
    assert.equal(blankReason.project_version, v0 + 1,
      "a blank action reason normalizes to NULL and does not block assignment");
    assert.equal(await countOf(db,
      "select count(*)::int as n from public.direct_entry_restricted_reasons"), 0,
      "blank action reasons do not create restricted-reason rows");
    const blankReplay = await assign(db, {
      manager: REC_C, expectedProjectVersion: v0, reason: null, key: "blank-reason-key",
    });
    assert.equal(blankReplay.assignment_id, blankReason.assignment_id,
      "blank and NULL reasons share the canonical idempotency input");
    assert.equal((await db.query(
      "select reason_id from public.direct_entry_project_manager_assignments where assignment_id=$1",
      [blankReason.assignment_id],
    )).rows[0].reason_id, null, "the assignment stores a real NULL reason reference");
    assert.equal(await countOf(db,
      "select count(*)::int as n from public.direct_entry_project_manager_assignments"), 1,
      "canonical replay does not duplicate the assignment");
    const blankAudit = await db.query(
      "select action, reason_id is null as no_reason from public.direct_entry_audit_events" +
      " where resource_ref = $1", [blankReason.assignment_id]);
    assert.deepEqual(blankAudit.rows, [{
      action: "project_manager_assignment_assign", no_reason: true,
    }], "audit remains while the optional reason is NULL");

    const v1 = await currentProjectVersion(db, PROJ_1);
    const created = await assign(db, { manager: REC_A, expectedProjectVersion: v1 });
    assert.equal(created.project_version, v1 + 1, "assign advances the project version");
    await assert.rejects(
      () => assign(db, {
        manager: REC_C, expectedProjectVersion: 5, key: "assign-key-occ",
      }),
      (error) => error.code === "PT409",
      "a stale expected project version is a conflict");
    // OCC on revocation.
    await assert.rejects(
      () => unassign(db, { assignmentId: created.assignment_id, expectedVersion: 9 }),
      (error) => error.code === "PT409",
      "a stale assignment version is a conflict");
    // Reason + audit rows exist for the accepted mutation.
    assert.equal(await countOf(db,
      "select count(*)::int as n from public.direct_entry_restricted_reasons"), 1);
    const audit = await db.query(
      "select action, capability, scope_kind, reason_id is not null as has_reason" +
      " from public.direct_entry_audit_events where resource_ref = $1",
      [created.assignment_id]);
    assert.deepEqual(audit.rows, [{
      action: "project_manager_assignment_assign", capability: "entry_admin",
      scope_kind: "all", has_reason: true,
    }]);
    // Idempotent replay: same key + same payload => same result, no new rows.
    const replay = await assign(db, { manager: REC_A, expectedProjectVersion: v1 });
    assert.equal(replay.assignment_id, created.assignment_id);
    assert.equal(replay.project_version, created.project_version);
    assert.equal(await countOf(db,
      "select count(*)::int as n from public.direct_entry_project_manager_assignments"), 2);
    assert.equal(await countOf(db,
      "select count(*)::int as n from public.direct_entry_restricted_reasons"), 1);
    // Same key, different payload => conflict.
    await assert.rejects(
      () => assign(db, { manager: REC_B, expectedProjectVersion: v1 }),
      (error) => error.code === "22023",
      "an idempotency key cannot be reused with different input");
    // The list RPC is admin-only too.
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_list_project_manager_assignments($1::uuid,$2::uuid,$3::text,$4::boolean)",
        [MGR_A_AUTH, MGR_A_APP, PROJ_1, true]),
      (error) => error.code === "42501");
  } finally {
    await db.close();
  }
});
// ---------------------------------------------------------------------------
// 10. Expand/backfill: existing assignments survive without invented history.
// ---------------------------------------------------------------------------
test("P2.5-W02: the expand/backfill keeps existing assignments and invents nothing", async () => {
  const { db } = await migratedDb(PRE_W02_MIGRATION);
  try {
    await seedActors(db);
    await db.query(
      "insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id)" +
      " values ($1,$2)", [PROJ_1, REC_A]);
    assert.equal(await countOf(db,
      "select count(*)::int as n from public.direct_entry_project_manager_assignments"), 1);
    assert.equal(await canAccess(db, MGR_A_APP, PROJ_1), true,
      "the W07B single-manager contract works before W02");

    // Apply the W02 successor migration exactly as the ledger would.
    await db.exec(await readFile(path.join(MIGRATION_DIR, W02_MIGRATION), "utf8"));

    assert.equal(await countOf(db,
      "select count(*)::int as n from public.direct_entry_project_manager_assignments"),
      1, "the backfill must not invent rows");
    const row = await db.query(
      "select manager_recruiter_id::text as manager, assignment_id is not null as has_identity," +
      " valid_from::text as valid_from, valid_to, created_by_user_id, reason_id, revoked_at, version" +
      " from public.direct_entry_project_manager_assignments");
    assert.equal(row.rows[0].manager, REC_A, "the manager pair is preserved");
    assert.equal(row.rows[0].has_identity, true);
    assert.equal(row.rows[0].valid_from, await authorizationDate(db),
      "the historical assignment becomes an OPEN interval starting at the migration date");
    assert.equal(row.rows[0].valid_to, null);
    assert.equal(row.rows[0].created_by_user_id, null,
      "no historical actor is invented");
    assert.equal(row.rows[0].reason_id, null, "no historical reason is invented");
    assert.equal(row.rows[0].revoked_at, null);
    assert.equal(row.rows[0].version, 1);
    assert.equal(await canAccess(db, MGR_A_APP, PROJ_1), true,
      "the backfilled interval keeps the manager effective");
    assert.equal(await canAccess(db, MGR_B_APP, PROJ_1), false);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 11. ACL / SECURITY DEFINER / search_path / reuse assertions.
// ---------------------------------------------------------------------------
const AUTHORITY_HELPERS = [
  "public.direct_entry_project_assignment_effective(uuid, text)",
  "public.direct_entry_actor_is_assigned_project_manager(uuid, text)",
  "public.direct_entry_actor_has_project_assignment(uuid)",
  "public.direct_entry_actor_can_access_project(uuid, text)",
  "public.direct_entry_assert_project_admin(uuid, uuid)",
];
const ADMIN_RPCS = [
  "public.direct_entry_list_project_manager_assignments(uuid, uuid, text, boolean)",
  "public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text)",
  "public.direct_entry_unassign_project_manager(uuid, uuid, uuid, integer, integer, text, text)",
  "public.direct_entry_list_projects_admin(uuid, uuid, boolean)",
  "public.direct_entry_get_project_admin(uuid, uuid, text)",
  "public.direct_entry_create_project(uuid, uuid, text, text, text, text)",
  "public.direct_entry_update_project(uuid, uuid, text, integer, text, text, text)",
  "public.direct_entry_set_project_active(uuid, uuid, text, boolean, integer, text, text)",
];

test("P2.5-W02: table ACL, helper hardening and W07B reuse stay intact", async () => {
  const db = await buildDb();
  try {
    const table = await db.query(
      "select relrowsecurity, relforcerowsecurity from pg_class" +
      " where oid = 'public.direct_entry_project_manager_assignments'::regclass");
    assert.deepEqual(table.rows[0], { relrowsecurity: true, relforcerowsecurity: true });
    for (const role of ["anon", "authenticated", "service_role"]) {
      const res = await db.query(
        "select has_table_privilege($1,'public.direct_entry_project_manager_assignments','SELECT') as s," +
        " has_table_privilege($1,'public.direct_entry_project_manager_assignments','INSERT') as i," +
        " has_table_privilege($1,'public.direct_entry_project_manager_assignments','UPDATE') as u," +
        " has_table_privilege($1,'public.direct_entry_project_manager_assignments','DELETE') as d", [role]);
      assert.deepEqual(res.rows[0], { s: false, i: false, u: false, d: false }, role + " must have no table access");
    }

    for (const signature of AUTHORITY_HELPERS) {
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

    for (const signature of ADMIN_RPCS) {
      const res = await db.query(
        "select p.prosecdef from pg_proc p where p.oid = $1::regprocedure", [signature]);
      assert.equal(res.rows[0].prosecdef, true);
      for (const [role, expected] of [["service_role", true], ["anon", false], ["authenticated", false]]) {
        const priv = await db.query(
          "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [role, signature]);
        assert.equal(priv.rows[0].ok, expected, signature + " vs " + role);
      }
    }

    // Interval integrity objects.
    const index = await db.query(
      "select indexdef from pg_indexes where schemaname='public'" +
      " and indexname='direct_entry_pm_assignment_active_pair_idx'");
    assert.equal(index.rows.length, 1);
    assert.ok(index.rows[0].indexdef.includes("UNIQUE"));
    assert.ok(index.rows[0].indexdef.includes("WHERE (valid_to IS NULL)"));
    const triggers = await db.query(
      "select tgname from pg_trigger where tgrelid =" +
      " 'public.direct_entry_project_manager_assignments'::regclass and not tgisinternal order by tgname");
    assert.deepEqual(triggers.rows.map((r) => r.tgname),
      ["direct_entry_pm_assignment_no_overlap", "direct_entry_pm_assignment_touch",
        "direct_entry_set_current_on_insert"]);

    // W07B reuse: the same helper still backs the catalog and the write guard,
    // so no second authorization framework was introduced.
    for (const signature of [
      "public.direct_entry_input_catalog(uuid, uuid, date)",
      "public.direct_entry_create_full_profile_batch_v2(uuid, uuid, text, jsonb, text)",
    ]) {
      const res = await db.query(
        "select pg_get_functiondef(p.oid) as def from pg_proc p where p.oid = $1::regprocedure",
        [signature]);
      assert.ok(res.rows[0].def.includes("direct_entry_actor_can_access_project"),
        signature + " must keep calling the shared project authority helper");
    }
    const helperCount = await db.query(
      "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname='public' and p.proname in ('direct_entry_actor_can_access_project'," +
      " 'direct_entry_actor_is_assigned_project_manager'," +
      " 'direct_entry_actor_has_project_assignment'," +
      " 'direct_entry_project_assignment_effective')");
    assert.equal(helperCount.rows[0].n, 4, "exactly one predicate family, no duplicates");
  } finally {
    await db.close();
  }
});
async function proposeScope(db, auth, app, entryId, targetKind = "ENTRY_FIELD") {
  const res = await db.query(
    "select public.direct_entry_resolve_change_request_scope($1::uuid,$2::uuid,$3::uuid,$4::text) as scope",
    [auth, app, entryId, targetKind]);
  return res.rows[0].scope;
}

// ---------------------------------------------------------------------------
// 12. The P3-W07E (#50) creator/team/date proposer fallback is closed by #51.
// ---------------------------------------------------------------------------
test("P2.5-W02: proposer authority is the assignment, not creator/team/date", async () => {
  const db = await buildDb();
  try {
    await seedActors(db);
    // Give the creator exactly what the #50 fallback needed: change_request_create
    // plus an own scope, and make them the creator of the row.
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)" +
      " values ($1,'own','2020-01-01')", [CREATOR_APP]);
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)" +
      " values ($1,'entry_own','2020-01-01')", [CREATOR_APP]);
    const entry = await insertSubmittedEntry(db, {
      project: PROJ_1, recruiter: REC_D, date: await shiftedDate(db, -2),
      createdBy: CREATOR_APP,
    });
    const owner = await db.query(
      "select created_by_user_id::text as owner from public.direct_entries where entry_id = $1::uuid",
      [entry]);
    assert.equal(owner.rows[0].owner, CREATOR_APP, "the creator really owns the row");

    // #50 returned 'own'/'team' for this actor. After #51 it fails closed.
    await assert.rejects(
      () => proposeScope(db, CREATOR_AUTH, CREATOR_APP, entry),
      (error) => error.code === "42501",
      "the creator fallback must be closed");
    await assert.rejects(
      () => proposeScope(db, REC_AUTH, REC_APP, entry),
      (error) => error.code === "42501",
      "recruiter attribution must not propose");

    // An effective assignment still works; DOCUMENT stays rejected.
    const assignment = await assign(db, { manager: REC_A });
    assert.equal(await proposeScope(db, MGR_A_AUTH, MGR_A_APP, entry), "project");
    await assert.rejects(
      () => proposeScope(db, MGR_A_AUTH, MGR_A_APP, entry, "DOCUMENT"),
      (error) => error.code === "42501",
      "document/CCCD targets stay out of scope");

    // Revocation removes propose authority immediately.
    await unassign(db, { assignmentId: assignment.assignment_id });
    await assert.rejects(
      () => proposeScope(db, MGR_A_AUTH, MGR_A_APP, entry),
      (error) => error.code === "42501");
  } finally {
    await db.close();
  }
});
