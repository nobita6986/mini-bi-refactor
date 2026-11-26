/**
 * P1.6-W04-S04C-S02C - PGlite fixture dung chung cho submission-read DB test va local acceptance.
 *
 * Ap dung TOAN BO migration local (32) theo thu tu ten file, roi seed actor/submission synthetic.
 * Khong ket noi mang, khong dung Supabase.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

export const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

export const PROJECT_ID = "s02c_project";
export const TEAM_A = "94000000-0000-4000-8000-0000000000c1";
export const RECRUITER_A = "93000000-0000-4000-8000-0000000000c1";
const OWNER_RECRUITER_ID = "93000000-0000-4000-8000-0000000000c2";

export const ACTORS = Object.freeze({
  owner: {
    auth_subject: "11000000-0000-4000-8000-000000000001",
    app_user_id: "21000000-0000-4000-8000-000000000001",
  },
  noCapability: {
    auth_subject: "11000000-0000-4000-8000-000000000002",
    app_user_id: "21000000-0000-4000-8000-000000000002",
  },
  noScope: {
    auth_subject: "11000000-0000-4000-8000-000000000003",
    app_user_id: "21000000-0000-4000-8000-000000000003",
  },
  teamScopeOnly: {
    auth_subject: "11000000-0000-4000-8000-000000000004",
    app_user_id: "21000000-0000-4000-8000-000000000004",
  },
  otherOwner: {
    auth_subject: "11000000-0000-4000-8000-000000000005",
    app_user_id: "21000000-0000-4000-8000-000000000005",
  },
});

export const SUBMISSION_STAMPS = Object.freeze({
  draft: "2026-10-04T09:00:00Z",
  review: "2026-10-04T09:01:00Z",
  submitted: "2026-10-04T09:02:00Z",
  draftTied: "2026-10-04T09:00:00Z",
});

export async function createMigratedDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")
    .sort();
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return { db, migrationNames: names };
}

async function insertActor(db, actor, capabilities, scopeKind, teamId, currentState) {
  await db.query("insert into auth.users(id) values ($1)", [actor.auth_subject]);
  // P2.5-HF-R5: display_name exists from #62; earlier partial ledgers
  // (historical contract tests) must keep working without it.
  const hasDisplayName = (await db.query(
    "select 1 from information_schema.columns where table_schema='public'" +
    " and table_name='direct_entry_app_users' and column_name='display_name'",
  )).rows.length > 0;
  await db.query(
    hasDisplayName
      ? "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')"
      : "insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled) values ($1,$2,true)",
    [actor.app_user_id, actor.auth_subject],
  );
  const currentColumns = currentState ? ",is_current" : "";
  const currentValue = currentState ? ",true" : "";
  for (const capability of capabilities) {
    await db.query(
      `insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from${currentColumns})` +
      ` values ($1,$2,'2020-01-01'${currentValue})`, [actor.app_user_id, capability]);
  }
  if (scopeKind !== null) {
    await db.query(
      `insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from${currentColumns})` +
      ` values ($1,$2,$3,'2020-01-01'${currentValue})`,
      [actor.app_user_id, scopeKind, scopeKind === "team" ? teamId : null]);
  }
}

function worker(displayName) {
  const optional = { state: "unknown" };
  return {
    display_name: displayName,
    date_of_birth: optional,
    national_id: optional,
    address: optional,
    phone: optional,
  };
}

export async function mutate(db, sql, values) {
  try {
    const result = await db.query(sql, values);
    return { data: result.rows?.[0]?.data ?? null, error: null };
  } catch (error) {
    return { data: null, error: { code: error.code, message: error.message } };
  }
}

export function listOwnSubmissions(db, actor, { pageSize = 20, cursor = null, state = null } = {}) {
  return mutate(db,
    "select public.direct_entry_list_own_submissions($1::uuid,$2::uuid,$3::integer,$4::text,$5::text) as data",
    [actor.auth_subject, actor.app_user_id, pageSize, cursor, state]);
}

export function readOwnSubmission(db, actor, submissionId) {
  return mutate(db,
    "select public.direct_entry_read_own_submission($1::uuid,$2::uuid,$3::uuid) as data",
    [actor.auth_subject, actor.app_user_id, submissionId]);
}

export async function setSubmissionCreatedAt(db, submissionId, stamp) {
  await db.exec("alter table public.direct_entry_submissions disable trigger direct_entry_submission_transition");
  try {
    await db.query(
      "update public.direct_entry_submissions set created_at = $2::timestamptz where submission_id = $1",
      [submissionId, stamp]);
  } finally {
    await db.exec("alter table public.direct_entry_submissions enable trigger direct_entry_submission_transition");
  }
}

async function createSubmission(db, actor, codes, recruiterId, keySuffix) {
  const created = await mutate(db,
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) as data",
    [actor.auth_subject, actor.app_user_id,
      JSON.stringify(codes.map((employeeCode) => ({
        project_id: PROJECT_ID,
        first_work_date: "2026-10-15",
        employee_code: employeeCode,
        worker_details: worker("S02C worker " + employeeCode.slice(-1)),
        recruiter_id: recruiterId,
        labor_type: "TEMPORARY",
      }))),
      "s02c_create_" + keySuffix]);
  if (created.error) throw new Error("create batch failed: " + created.error.message);
  const { rows } = await db.query(
    "select e.entry_id, e.submission_id from public.direct_entries e" +
    " where e.employee_code = any($1::text[]) order by e.entry_id",
    [codes]);
  return { submissionId: rows[0].submission_id, entryIds: rows.map((row) => row.entry_id) };
}

async function transition(db, actor, submissionId, expectedVersion, targetState, suffix) {
  const result = await mutate(db,
    "select public.direct_entry_transition_submission($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) as data",
    [actor.auth_subject, actor.app_user_id, submissionId, expectedVersion, targetState,
      "s02c_transition_" + suffix]);
  if (result.error) throw new Error(targetState + " failed: " + result.error.message);
  return result.data;
}

export async function seedSubmissionReadFixture(db) {
  const currentState = (await db.query(
    "select exists (select 1 from information_schema.columns where table_schema='public'" +
    " and table_name='direct_entry_capability_grants' and column_name='is_current') as present",
  )).rows[0].present;
  await db.query("insert into public.teams(team_id,code,display_name) values ($1,$2,$3)",
    [TEAM_A, "s02c_team", "S02C team"]);
  const currentColumns = currentState ? ",is_current" : "";
  const currentValue = currentState ? ",true" : "";
  for (const [recruiterId, displayName] of [
    [RECRUITER_A, "S02C recruiter"], [OWNER_RECRUITER_ID, "S02C project manager"],
  ]) {
    await db.query("insert into public.recruiters(recruiter_id,display_name) values ($1,$2)",
      [recruiterId, displayName]);
    await db.query(
      `insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from${currentColumns})` +
      ` values ($1,'hrp','2020-01-01'${currentValue})`, [recruiterId]);
    await db.query(
      `insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from${currentColumns})` +
      ` values ($1,$2,'2020-01-01'${currentValue})`, [recruiterId, TEAM_A]);
  }
  await db.query(
    "insert into public.direct_entry_projects(project_id,display_name) values ($1,$2)",
    [PROJECT_ID, "S02C project"]);

  await insertActor(db, ACTORS.owner, ["entry_create", "submission_create", "entry_own"], "own", null, currentState);
  await insertActor(db, ACTORS.noCapability, ["entry_own"], "own", null, currentState);
  await insertActor(db, ACTORS.noScope, ["entry_create", "submission_create", "entry_own"], null, null, currentState);
  await insertActor(db, ACTORS.teamScopeOnly, ["entry_create", "submission_create", "entry_own"], "team", TEAM_A, currentState);
  await insertActor(db, ACTORS.otherOwner, ["entry_create", "submission_create", "entry_own"], "own", null, currentState);

  if ((await db.query(
    "select to_regclass('public.direct_entry_project_manager_assignments') is not null as present",
  )).rows[0].present) {
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links(app_user_id,recruiter_id,verified,valid_from${currentColumns})` +
      ` values ($1,$2,true,'2020-01-01'${currentValue})`, [ACTORS.owner.app_user_id, OWNER_RECRUITER_ID]);
    await db.query(
      `insert into public.direct_entry_project_manager_assignments(project_id,manager_recruiter_id${currentColumns})` +
      ` values ($1,$2${currentValue})`, [PROJECT_ID, OWNER_RECRUITER_ID]);
  }

  const draft = await createSubmission(db, ACTORS.owner, ["hrp-2026-400001"], RECRUITER_A, "draft");
  const review = await createSubmission(db, ACTORS.owner, ["hrp-2026-400002"], RECRUITER_A, "review");
  const submitted = await createSubmission(db, ACTORS.owner,
    ["hrp-2026-400003", "hrp-2026-400004"], RECRUITER_A, "submitted");
  const draftTied = await createSubmission(db, ACTORS.owner, ["hrp-2026-400005"], RECRUITER_A, "tied");

  await seedLegacyReviewSubmission(db, review.submissionId);
  await seedLegacyReviewSubmission(db, submitted.submissionId);
  await transition(db, ACTORS.owner, submitted.submissionId, 2, "SUBMITTED", "submitted_b");

  await setSubmissionCreatedAt(db, draft.submissionId, SUBMISSION_STAMPS.draft);
  await setSubmissionCreatedAt(db, draftTied.submissionId, SUBMISSION_STAMPS.draftTied);
  await setSubmissionCreatedAt(db, review.submissionId, SUBMISSION_STAMPS.review);
  await setSubmissionCreatedAt(db, submitted.submissionId, SUBMISSION_STAMPS.submitted);

  return {
    draft, review, submitted, draftTied,
    submissions: {
      draft: draft.submissionId,
      review: review.submissionId,
      submitted: submitted.submissionId,
      draftTied: draftTied.submissionId,
    },
  };
}
