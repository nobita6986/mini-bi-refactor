import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

export const uuid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
export const TEAM_A = uuid(11);
export const TEAM_B = uuid(12);
export const TEAM_INACTIVE = uuid(13);
export const TEAM_ORPHAN = uuid(14);
export const REC_A = uuid(21);
export const REC_B = uuid(22);
export const REC_INACTIVE = uuid(23);
export const REC_ORPHAN = uuid(24);
export const AUTH_ALL = uuid(31);
export const AUTH_TEAM = uuid(32);
export const AUTH_OWN = uuid(33);
export const APP_ALL = uuid(41);
export const APP_TEAM = uuid(42);
export const APP_OWN = uuid(43);
export const PROJECT_A = "proj_a";
export const PROJECT_B = "proj_b";
export const SOURCE = uuid(61);
export const RUN = uuid(62);
const OMITTED = { state: "omitted" };

const PRE_3C_PIN_MIGRATION_NAME = "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql";

export async function buildDb({ throughMigration = PRE_3C_PIN_MIGRATION_NAME } = {}) {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrationNames = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  if (throughMigration && !migrationNames.includes(throughMigration)) {
    throw new Error(`Unknown migration: ${throughMigration}`);
  }
  for (const name of migrationNames) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    if (name === throughMigration) break;
  }
  return { db, migrationNames };
}

async function insertEntry(db, { entry, submission, candidate, createdBy, project, date, code, recruiter, team, provider, labor }) {
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates(candidate_id) values ($1)", [candidate]);
    await db.query("insert into public.direct_entry_submissions(submission_id,created_by_user_id,state) values ($1,$2,'DRAFT')", [submission, createdBy]);
    await db.query(
      "insert into public.direct_entries(entry_id,submission_id,candidate_id,created_by_user_id,project_id,first_work_date,employee_code,worker_details,recruiter_id,team_id,provider_type,labor_type) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [entry, submission, candidate, createdBy, project, date, code, JSON.stringify({ display_name: "Worker " + code, date_of_birth: OMITTED, national_id: OMITTED, address: OMITTED, phone: OMITTED }), recruiter, team, provider, labor],
    );
    await seedLegacyReviewSubmission(db, submission);
    await db.query("update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1", [submission]);
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

export async function seedReportingFixture(db) {
  for (const [auth, app] of [[AUTH_ALL, APP_ALL], [AUTH_TEAM, APP_TEAM], [AUTH_OWN, APP_OWN]]) {
    await db.query("insert into auth.users(id) values ($1)", [auth]);
    await db.query("insert into public.direct_entry_app_users(app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')", [app, auth]);
  }
  await db.query("insert into public.teams(team_id,code,display_name,active) values ($1,'TEAM_A','Team A',true),($2,'TEAM_B','Team B',true),($3,'TEAM_INACTIVE','Inactive Team',true),($4,'TEAM_ORPHAN','Orphan Team',true)", [TEAM_A, TEAM_B, TEAM_INACTIVE, TEAM_ORPHAN]);
  const vendor = (await db.query("select public.direct_entry_system_vendor_team_id() as team_id")).rows[0].team_id;
  await db.query("insert into public.recruiters(recruiter_id,display_name) values ($1,'Recruiter A'),($2,'Recruiter B'),($3,'Recruiter Inactive'),($4,'Recruiter Orphan')", [REC_A, REC_B, REC_INACTIVE, REC_ORPHAN]);
  for (const [rec, team, key] of [[REC_A, TEAM_A, "rec a"], [REC_B, TEAM_B, "rec b"], [REC_INACTIVE, TEAM_INACTIVE, "rec inactive"], [REC_ORPHAN, TEAM_ORPHAN, "rec orphan"]]) {
    await db.query("insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from) values ($1,'hrp','2020-01-01')", [rec]);
    await db.query("insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from) values ($1,$2,'2020-01-01')", [rec, team]);
    await db.query("insert into public.recruiter_aliases(recruiter_id,reporting_key,valid_from) values ($1,$2,'2020-01-01')", [rec, key]);
  }
  await db.query("insert into public.direct_entry_projects(project_id,display_name) values ($1,'Project A'),($2,'Project B')", [PROJECT_A, PROJECT_B]);
  await db.query("insert into public.direct_entry_app_user_recruiter_links(app_user_id,recruiter_id,verified,valid_from) values ($1,$2,true,'2020-01-01')", [APP_OWN, REC_A]);
  await db.query("insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from,is_current) values ($1,'all',null,'2020-01-01',true),($2,'team',$3,'2020-01-01',true),($4,'own',null,'2020-01-01',true)", [APP_ALL, APP_TEAM, TEAM_A, APP_OWN]);
  await db.query("insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from,is_current) values ($1,'entry_admin','2020-01-01',true),($2,'entry_team','2020-01-01',true),($3,'entry_own','2020-01-01',true)", [APP_ALL, APP_TEAM, APP_OWN]);
  await db.query("insert into public.data_sources(id,drive_file_id,file_name,sheet_name,active,is_test) values ($1,'legacy','legacy.xlsx','Sheet1',true,false)", [SOURCE]);
  await db.query("insert into public.sync_runs(run_id,source_id,trigger_type,status,started_at,finished_at) values ($1,$2,'manual','succeeded','2026-10-05T00:00:00Z','2026-10-05T00:00:00Z')", [RUN, SOURCE]);
  await db.query("insert into public.daily_recruitment_breakdown(source_id,business_date,project_key,project_display,recruiter_key,recruiter_display,provider_type_key,provider_type_display,employment_type_key,employment_type_display,recruited_count,sync_run_id,snapshot_at) values ($1,'1999-09-25','legacy_proj','Legacy Project','legacy_rec','Legacy Recruiter','hrp','HRP','thời vụ','Thời vụ',7,$2,'2026-10-05T00:00:00Z')", [SOURCE, RUN]);

  await insertEntry(db, { entry: uuid(101), submission: uuid(201), candidate: uuid(301), createdBy: APP_OWN, project: PROJECT_A, date: "2026-10-10", code: "hrp-2026-000001", recruiter: REC_A, team: TEAM_A, provider: "hrp", labor: "TEMPORARY" });
  await insertEntry(db, { entry: uuid(102), submission: uuid(202), candidate: uuid(302), createdBy: APP_OWN, project: PROJECT_B, date: "2026-10-11", code: "hrp-2026-000002", recruiter: REC_B, team: TEAM_B, provider: "hrp", labor: "PERMANENT" });
  await insertEntry(db, { entry: uuid(103), submission: uuid(203), candidate: uuid(303), createdBy: APP_OWN, project: PROJECT_A, date: "2026-10-12", code: "hrp-2026-000003", recruiter: REC_INACTIVE, team: TEAM_INACTIVE, provider: "hrp", labor: "TEMPORARY" });
  await insertEntry(db, { entry: uuid(105), submission: uuid(205), candidate: uuid(305), createdBy: APP_OWN, project: PROJECT_A, date: "2026-10-14", code: "hrp-2026-000005", recruiter: REC_ORPHAN, team: TEAM_ORPHAN, provider: "hrp", labor: "TEMPORARY" });
  await insertEntry(db, { entry: uuid(106), submission: uuid(206), candidate: uuid(306), createdBy: APP_OWN, project: PROJECT_A, date: "2026-10-15", code: "hrp-2026-000006", recruiter: REC_A, team: TEAM_A, provider: "hrp", labor: "TEMPORARY" });
  await db.query("alter table public.teams disable trigger all");
  await db.query("delete from public.teams where team_id=$1", [TEAM_ORPHAN]);
  await db.query("alter table public.teams enable trigger all");
  await db.query("update public.teams set active=false where team_id=$1", [TEAM_INACTIVE]);
  await db.query("update public.teams set active=false where team_id=$1", [TEAM_INACTIVE]);
  return { vendor };
}

export async function query(db, sql, values = []) {
  return (await db.query(sql, values)).rows;
}
