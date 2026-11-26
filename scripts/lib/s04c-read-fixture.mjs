/**
 * P1.6-W04-S04C-S02B - PGlite fixture dung chung cho DB test va local acceptance.
 *
 * Ap dung TOAN BO migration local tu supabase/migrations theo thu tu ten file (from scratch),
 * sau do seed actor/entry/change request synthetic. Khong ket noi mang, khong dung Supabase.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");

export const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

export const PROJECT_ID = "s02b_project";
export const TEAM_A = "94000000-0000-4000-8000-00000000000a";
export const TEAM_B = "94000000-0000-4000-8000-00000000000b";
export const RECRUITER_A = "93000000-0000-4000-8000-00000000000a";
export const RECRUITER_B = "93000000-0000-4000-8000-00000000000b";

export const ACTORS = Object.freeze({
  proposer: {
    auth_subject: "10000000-0000-4000-8000-000000000001",
    app_user_id: "20000000-0000-4000-8000-000000000001",
  },
  reviewer: {
    auth_subject: "10000000-0000-4000-8000-000000000002",
    app_user_id: "20000000-0000-4000-8000-000000000002",
  },
  reviewerAll: {
    auth_subject: "10000000-0000-4000-8000-000000000003",
    app_user_id: "20000000-0000-4000-8000-000000000003",
  },
  reviewerNoCapability: {
    auth_subject: "10000000-0000-4000-8000-000000000004",
    app_user_id: "20000000-0000-4000-8000-000000000004",
  },
  outsider: {
    auth_subject: "10000000-0000-4000-8000-000000000005",
    app_user_id: "20000000-0000-4000-8000-000000000005",
  },
  admin: {
    auth_subject: "10000000-0000-4000-8000-000000000007",
    app_user_id: "20000000-0000-4000-8000-000000000007",
  },
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

async function grantCapabilities(db, actor, capabilities, currentState) {
  const columns = currentState ? ",is_current" : "";
  const value = currentState ? ",true" : "";
  for (const capability of capabilities) {
    await db.query(
      `insert into public.direct_entry_capability_grants(app_user_id,capability,valid_from${columns})` +
      ` values ($1,$2,'2020-01-01'${value})`,
      [actor.app_user_id, capability],
    );
  }
}

async function grantScope(db, actor, scopeKind, teamId, currentState) {
  const columns = currentState ? ",is_current" : "";
  const value = currentState ? ",true" : "";
  await db.query(
    `insert into public.direct_entry_scope_grants(app_user_id,scope_kind,team_id,valid_from${columns})` +
    ` values ($1,$2,$3,'2020-01-01'${value})`,
    [actor.app_user_id, scopeKind, scopeKind === "team" ? teamId : null],
  );
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
  await grantCapabilities(db, actor, capabilities, currentState);
  await grantScope(db, actor, scopeKind, teamId, currentState);
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

export function transitionInput(actor, submissionId, expectedVersion, targetState, suffix) {
  return {
    sql: "select public.direct_entry_transition_submission($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) as data",
    values: [actor.auth_subject, actor.app_user_id, submissionId, expectedVersion, targetState,
      "s02b_transition_" + suffix],
  };
}

export async function seedChangeRequestFixture(db, {
  manageTransaction = true,
  workerDetailsForFirstEntry = null,
  submissionWorkflow = "direct",
} = {}) {
  if (manageTransaction) await db.query("begin");
  // Historical-ledger fixtures stop before R1 adds current-state markers.
  const currentState = (await db.query(
    "select exists (select 1 from information_schema.columns where table_schema='public'" +
    " and table_name='direct_entry_capability_grants' and column_name='is_current') as present",
  )).rows[0].present;
  await db.query("insert into public.teams(team_id,code,display_name) values ($1,$2,$3)",
    [TEAM_A, "s02b_team_a", "S02B team A"]);
  await db.query("insert into public.teams(team_id,code,display_name) values ($1,$2,$3)",
    [TEAM_B, "s02b_team_b", "S02B team B"]);
  await db.query("insert into public.recruiters(recruiter_id,display_name) values ($1,$2)",
    [RECRUITER_A, "S02B recruiter A"]);
  await db.query("insert into public.recruiters(recruiter_id,display_name) values ($1,$2)",
    [RECRUITER_B, "S02B recruiter B"]);
  for (const [recruiterId, teamId] of [[RECRUITER_A, TEAM_A], [RECRUITER_B, TEAM_B]]) {
    const currentColumns = currentState ? ",is_current" : "";
    const currentValue = currentState ? ",true" : "";
    await db.query(
      `insert into public.recruiter_provider_memberships(recruiter_id,provider_type,valid_from${currentColumns})` +
      ` values ($1,'hrp','2020-01-01'${currentValue})`, [recruiterId]);
    await db.query(
      `insert into public.recruiter_team_memberships(recruiter_id,team_id,valid_from${currentColumns})` +
      ` values ($1,$2,'2020-01-01'${currentValue})`, [recruiterId, teamId]);
  }
  await db.query(
    "insert into public.direct_entry_projects(project_id,display_name) values ($1,$2)",
    [PROJECT_ID, "S02B project"]);
  await db.query(
    "insert into public.direct_entry_banks(bank_id,display_name) values ($1,$2)",
    ["s02b_bank", "S02B bank"]);


  await insertActor(db, ACTORS.proposer,
    ["entry_create", "submission_create", "entry_own", "change_request_create", "change_review"],
    "own", null, currentState);
  // P2.5-W02: proposer authority is the EFFECTIVE project-manager assignment; the
  // creator/team/first_work_date fallback is closed by migration #51, so the
  // synthetic proposer is the assigned manager of this project. Historical-ledger
  // tests apply migrations only up to an older number, so the assignment is
  // created only when the W07B table already exists.
  const assignmentTable = await db.query(
    "select to_regclass('public.direct_entry_project_manager_assignments') is not null as present");
  if (assignmentTable.rows[0].present) {
    const currentColumns = currentState ? ", is_current" : "";
    const currentValue = currentState ? ", true" : "";
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links` +
      ` (app_user_id, recruiter_id, verified, valid_from${currentColumns})` +
      ` values ($1,$2,true,'2020-01-01'${currentValue})`,
      [ACTORS.proposer.app_user_id, RECRUITER_A]);
    await db.query(
      `insert into public.direct_entry_project_manager_assignments` +
      ` (project_id, manager_recruiter_id, valid_from${currentColumns})` +
      ` values ($1,$2,'2020-01-01'${currentValue})`,
      [PROJECT_ID, RECRUITER_A]);
  }
  await insertActor(db, ACTORS.reviewer, ["change_review"], "team", TEAM_A, currentState);
  await insertActor(db, ACTORS.reviewerAll, ["change_review", "pii_view"], "all", null, currentState);
  await insertActor(db, ACTORS.reviewerNoCapability, [], "team", TEAM_A, currentState);
  await insertActor(db, ACTORS.outsider, ["change_review"], "own", null, currentState);
  await insertActor(db, ACTORS.admin, ["entry_admin"], "all", null, currentState);

  const rows = [
    { code: "hrp-2026-300001", recruiterId: RECRUITER_A },
    { code: "hrp-2026-300002", recruiterId: RECRUITER_B },
  ];
  const created = await db.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) as data",
    [ACTORS.proposer.auth_subject, ACTORS.proposer.app_user_id,
      JSON.stringify(rows.map((row) => ({
        project_id: PROJECT_ID,
        first_work_date: "2026-10-15",
        employee_code: row.code,
        worker_details: row.code === "hrp-2026-300001" && workerDetailsForFirstEntry !== null
          ? workerDetailsForFirstEntry
          : worker("S02B worker" + row.code.slice(-1)),
        recruiter_id: row.recruiterId,
        labor_type: "TEMPORARY",
      }))),
      "s02b_create_batch"]);
  assertDataOk(created);

  const entries = await db.query(
    "select e.entry_id, e.submission_id, e.team_id, e.version" +
    " from public.direct_entries e where e.employee_code = any($1::text[]) order by e.employee_code",
    [rows.map((row) => row.code)]);
  const entryA = entries.rows[0];
  const entryB = entries.rows[1];
  const submissionId = entryA.submission_id;

  if (submissionWorkflow === "legacy") {
    const toReview = transitionInput(ACTORS.proposer, submissionId, 1, "REVIEW", "review");
    await db.query(toReview.sql, toReview.values);
    const toSubmitted = transitionInput(ACTORS.proposer, submissionId, 2, "SUBMITTED", "submit");
    await db.query(toSubmitted.sql, toSubmitted.values);
  } else if (submissionWorkflow === "direct") {
    const toSubmitted = transitionInput(ACTORS.proposer, submissionId, 1, "SUBMITTED", "submit");
    await db.query(toSubmitted.sql, toSubmitted.values);
  } else if (submissionWorkflow !== "draft") {
    throw new Error("unsupported synthetic submission workflow");
  }
  if (manageTransaction) await db.query("commit");

  return { entryA, entryB, submissionId };
}

export function assertDataOk(result) {
  const data = result.rows?.[0]?.data;
  if (data === undefined) throw new Error("expected a jsonb result");
  return data;
}
export const REQUEST_STAMPS = Object.freeze({
  single: "2026-10-03T10:00:00Z",
  multi: "2026-10-03T10:01:00Z",
  withdrawn: "2026-10-03T10:02:00Z",
  rejected: "2026-10-03T10:03:00Z",
  approved: "2026-10-03T10:04:00Z",
  tied: "2026-10-03T10:04:00Z",
});

export function item(entryId, expectedVersion, proposal, targetKind = "ENTRY_FIELD") {
  return { entry_id: entryId, target_kind: targetKind, expected_version: expectedVersion, proposal };
}

export async function mutate(db, sql, values) {
  try {
    const result = await db.query(sql, values);
    return { data: result.rows?.[0]?.data ?? null, error: null };
  } catch (error) {
    return { data: null, error: { code: error.code, message: error.message } };
  }
}

export function createChangeRequest(db, actor, items, reason, key) {
  return mutate(db,
    "select public.direct_entry_create_change_request($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text) as data",
    [actor.auth_subject, actor.app_user_id, JSON.stringify(items), reason, key]);
}

export function withdrawChangeRequest(db, actor, requestId, expectedVersion, key) {
  return mutate(db,
    "select public.direct_entry_withdraw_change_request($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text) as data",
    [actor.auth_subject, actor.app_user_id, requestId, expectedVersion, key]);
}

export function decideChangeRequest(db, actor, requestId, decision, expectedVersion, reason, key) {
  const fn = decision === "approve"
    ? "public.direct_entry_approve_change_request"
    : "public.direct_entry_reject_change_request";
  return mutate(db,
    "select " + fn + "($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) as data",
    [actor.auth_subject, actor.app_user_id, requestId, expectedVersion, reason, key]);
}

export function listChangeRequests(db, actor, { pageSize = 20, cursor = null, state = null } = {}) {
  return mutate(db,
    "select public.direct_entry_list_change_requests($1::uuid,$2::uuid,$3::integer,$4::text,$5::text) as data",
    [actor.auth_subject, actor.app_user_id, pageSize, cursor, state]);
}

export function listGlobalChangeRequestHistory(db, actor, {
  pageSize = 20, cursor = null, days = 3,
} = {}) {
  return mutate(db,
    "select public.direct_entry_list_global_change_request_history($1::uuid,$2::uuid,$3::integer,$4::text,$5::integer) as data",
    [actor.auth_subject, actor.app_user_id, pageSize, cursor, days]);
}

export function readChangeRequest(db, actor, requestId) {
  return mutate(db,
    "select public.direct_entry_read_change_request($1::uuid,$2::uuid,$3::uuid) as data",
    [actor.auth_subject, actor.app_user_id, requestId]);
}

/**
 * Guard direct_entry_change_request_transition chi cho UPDATE theo dung buoc state/version,
 * nen fixture phai tam tat trigger nay khi ghim created_at de test keyset pagination.
 */
export async function setRequestCreatedAt(db, requestId, stamp) {
  await db.exec("alter table public.direct_entry_change_requests disable trigger direct_entry_change_request_transition");
  try {
    await db.query("update public.direct_entry_change_requests set created_at = $2::timestamptz where request_id = $1",
      [requestId, stamp]);
  } finally {
    await db.exec("alter table public.direct_entry_change_requests enable trigger direct_entry_change_request_transition");
  }
}

export async function setRequestDecidedAt(db, requestId, stamp) {
  await db.exec("alter table public.direct_entry_change_requests disable trigger direct_entry_change_request_transition");
  try {
    await db.query("update public.direct_entry_change_requests set decided_at = $2::timestamptz where request_id = $1",
      [requestId, stamp]);
  } finally {
    await db.exec("alter table public.direct_entry_change_requests enable trigger direct_entry_change_request_transition");
  }
}

/**
 * Sau seedChangeRequestFixture: tao 6 request voi created_at xac dinh va trang thai
 * PENDING x4, WITHDRAWN, REJECTED, APPROVED de test list/detail/pagination.
 */
export async function seedChangeRequests(db, fixture) {
  const { entryA, entryB } = fixture;
  const requests = {};
  // P2.5-W04: ENTRY_FIELD may only carry unprotected worker_details, and the
  // proposal must carry the full profile shape (DB check constraint).
  const storedDetails = (await db.query(
    "select worker_details from public.direct_entries where entry_id=$1",
    [entryA.entry_id])).rows[0].worker_details;
  const storedDetailsB = (await db.query(
    "select worker_details from public.direct_entries where entry_id=$1",
    [entryB.entry_id])).rows[0].worker_details;
  const W04_UNPROTECTED_DETAILS = {
    ...storedDetails,
    address: { state: "provided", value: "W04 unprotected address" },
  };
  const W04_UNPROTECTED_DETAILS_B = {
    ...storedDetailsB,
    address: { state: "provided", value: "W04 unprotected address" },
  };
  const plan = [
    ["single", [item(entryA.entry_id, entryA.version, { worker_details: { ...W04_UNPROTECTED_DETAILS } })], REQUEST_STAMPS.single],
    ["multi", [item(entryA.entry_id, entryA.version, { worker_details: { ...W04_UNPROTECTED_DETAILS } }),
      item(entryB.entry_id, entryB.version, { worker_details: { ...W04_UNPROTECTED_DETAILS_B } })], REQUEST_STAMPS.multi],
    ["withdrawn", [item(entryA.entry_id, entryA.version, { worker_details: { ...W04_UNPROTECTED_DETAILS } })], REQUEST_STAMPS.withdrawn],
    ["rejected", [item(entryA.entry_id, entryA.version, { worker_details: { ...W04_UNPROTECTED_DETAILS } })], REQUEST_STAMPS.rejected],
    ["approved", [item(entryA.entry_id, entryA.version, { worker_details: { ...W04_UNPROTECTED_DETAILS } })], REQUEST_STAMPS.approved],
    ["tied", [item(entryA.entry_id, entryA.version, { worker_details: { ...W04_UNPROTECTED_DETAILS } })], REQUEST_STAMPS.tied],
  ];
  for (const [name, items, stamp] of plan) {
    const created = await createChangeRequest(db, ACTORS.proposer, items,
      "S02B request " + name, "s02b_create_" + name);
    if (created.error) throw new Error(name + " create failed: " + created.error.message);
    requests[name] = created.data.request_id;
    await setRequestCreatedAt(db, created.data.request_id, stamp);
  }
  const withdrawn = await withdrawChangeRequest(db, ACTORS.proposer, requests.withdrawn, 1, "s02b_withdraw");
  if (withdrawn.error) throw new Error("withdraw failed: " + withdrawn.error.message);
  const rejected = await decideChangeRequest(db, ACTORS.reviewerAll, requests.rejected, "reject", 1,
    "S02B reject reason", "s02b_reject");
  if (rejected.error) throw new Error("reject failed: " + rejected.error.message);
  const approved = await decideChangeRequest(db, ACTORS.reviewerAll, requests.approved, "approve", 1,
    "S02B approve reason", "s02b_approve");
  if (approved.error) throw new Error("approve failed: " + approved.error.message);
  return requests;
}
