/**
 * P2.5-W03 - worker directory server projection (DB regression, PGlite over the
 * 75-migration ledger).
 *
 * Proves the P2.5 section 4.1 read model at the DB boundary:
 *   * recruiter audience = verified/effective app-user -> recruiter link, and the
 *     uploader (created_by) is NOT a recruiter;
 *   * project audience  = effective project-manager assignment, several managers
 *     included, cross-project denied, out-of-scope project refused;
 *   * all audience      = an effective all scope grant AND (entry_admin OR
 *     change_review); the reporting audience and a team/own scope never open it;
 *   * keyset pagination and every filter are server-side and bounded;
 *   * payment follows the authorized worker audience; raw worker profile PII is never returned;
 *   * allowed_actions is server-supplied; propose_change follows the W04 assignment
 *     authority (P2.5-W05 #55 replaced the PROPOSE_PENDING_W04_POLICY placeholder).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const W03_MIGRATION = "20261008120000_p2_5_w03_worker_directory_projection.sql";
const W04_MIGRATION = "20261008130000_p2_5_w04_project_manager_change_request_policy.sql";
const W02_MIGRATION = "20261008110000_p2_5_w02_multi_manager_project_authority.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "proj_a", PROJ_B = "proj_b", PROJ_C = "proj_c";
const REC_A = uuid(21), REC_B = uuid(22), REC_C = uuid(23);
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const MGR_A_AUTH = uuid(32), MGR_A_APP = uuid(42);
const MGR_B_AUTH = uuid(33), MGR_B_APP = uuid(43);
const UPLOADER_AUTH = uuid(34), UPLOADER_APP = uuid(44);
const PLAIN_AUTH = uuid(35), PLAIN_APP = uuid(45);
const REVIEWER_AUTH = uuid(36), REVIEWER_APP = uuid(46);

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
  assert.equal(names.indexOf(W04_MIGRATION), 52, "W04 is #53");
  assert.equal(names.indexOf(W03_MIGRATION), 51, "W03 is #52");
  assert.equal(names.indexOf(W02_MIGRATION), 50, "W03 depends on W02 #51");
  return db;
}

async function seed(db) {
  entrySeq = 0;
  for (const [auth, app] of [[ADMIN_AUTH, ADMIN_APP], [MGR_A_AUTH, MGR_A_APP],
    [MGR_B_AUTH, MGR_B_APP], [UPLOADER_AUTH, UPLOADER_APP], [PLAIN_AUTH, PLAIN_APP],
    [REVIEWER_AUTH, REVIEWER_APP]]) {
    await db.query("insert into auth.users (id,email) values ($1,$2)", [auth, `user-${app.slice(-2)}@example.test`]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
      " values ($1,$2,true,'Synthetic Account')", [app, auth]);
  }
  await db.query(
    "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
    " values ($1,'entry_admin','2020-01-01',true)", [ADMIN_APP]);
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)" +
    " values ($1,'all','2020-01-01',true)", [ADMIN_APP]);
  for (const app of [MGR_A_APP, MGR_B_APP, UPLOADER_APP, PLAIN_APP, REVIEWER_APP]) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
      " values ($1,'entry_create','2020-01-01',true)", [app]);
  }
  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_W3','Team W3')", [TEAM]);
  for (const [project, name] of [[PROJ_A, "Project A"], [PROJ_B, "Project B"], [PROJ_C, "Project C"]]) {
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)",
      [project, name]);
  }
  for (const [recruiter, name] of [[REC_A, "Recruiter A"], [REC_B, "Recruiter B"], [REC_C, "Recruiter C"]]) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1,$2)", [recruiter, name]);
    await db.query(
      "insert into public.recruiter_provider_memberships" +
      " (recruiter_id, provider_type, valid_from, is_current) values ($1,'hrp','2020-01-01',true)",
      [recruiter]);
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [recruiter, TEAM]);
  }
  // MGR_A <-> REC_A, MGR_B <-> REC_B: the verified link is the recruiter identity.
  for (const [app, recruiter] of [[MGR_A_APP, REC_A], [MGR_B_APP, REC_B], [UPLOADER_APP, REC_C]]) {
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links" +
      " (app_user_id, recruiter_id, verified, valid_from, is_current)" +
      " values ($1,$2,true,'2020-01-01',true)",
      [app, recruiter]);
  }
  // PLAIN stays unlinked: it must never resolve to a recruiter audience.
}

let entrySeq = 0;
/** Live sibling created alongside a soft-deleted row (see addWorker). */
let lastSibling = null;
/** One SUBMITTED worker row; returns the entry id. */
async function addWorker(db, {
  project = PROJ_A, recruiter = REC_A, createdBy = UPLOADER_APP,
  workDate = "2026-10-01", state = "SUBMITTED", deleted = false,
  payment = null, createdAt = null,
}) {
  entrySeq += 1;
  const n = entrySeq;
  const candidate = uuid(5000 + n), submission = uuid(6000 + n), entry = uuid(7000 + n);
  const year = String(workDate).slice(0, 4);
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidate]);
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)" +
      " values ($1,$2,'DRAFT')", [submission, createdBy]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
      " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
      " provider_type, labor_type, created_at)" +
      " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY',coalesce($11::timestamptz,now()))",
      [entry, submission, candidate, createdBy, project, workDate,
        "hrp-" + year + "-" + String(300000 + n),
        JSON.stringify({ display_name: "Worker " + n,
          date_of_birth: { state: "provided", value: "1990-01-01" },
          national_id: { state: "provided", value: String(100000000000 + n) },
          address: { state: "provided", value: "1 Synthetic Street " + n },
          phone: { state: "provided", value: "0900" + String(100000 + n) } }),
        recruiter, TEAM, createdAt]);
    if (state !== "DRAFT") {
      await seedLegacyReviewSubmission(db, submission);
    }
    if (state === "SUBMITTED") {
      await db.query(
        "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
        [submission]);
    }
    if (payment !== null) {
      await db.query(
        "insert into public.direct_entry_payments (entry_id, state, account_number, bank_id," +
        " account_holder_name) values ($1,$2,$3,$4,$5)",
        [entry, payment.state, payment.account_number ?? null, payment.bank_id ?? null,
          payment.account_holder_name ?? null]);
    }
    let sibling = null;
    if (deleted) {
      // A submission may not end up with only deleted rows, so the soft-deleted
      // worker keeps a live sibling in the same submission.
      sibling = uuid(9000 + n);
      await db.query(
        "insert into public.direct_entries (entry_id, submission_id, candidate_id," +
        " created_by_user_id, project_id, first_work_date, employee_code, worker_details," +
        " recruiter_id, team_id, provider_type, labor_type, created_at)" +
        " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY',coalesce($11::timestamptz,now()))",
        [sibling, submission, candidate, createdBy, project, workDate,
          "hrp-" + year + "-" + String(400000 + n),
          JSON.stringify({ display_name: "Worker " + n + " sibling",
            date_of_birth: { state: "omitted" }, national_id: { state: "omitted" },
            address: { state: "omitted" }, phone: { state: "omitted" } }),
          recruiter, TEAM, createdAt]);
      // direct_entries has an OCC trigger: every mutation must advance the version.
      await db.query(
        "update public.direct_entries set deleted_at = now(), version = version + 1" +
        " where entry_id = $1", [entry]);
    }
    lastSibling = sibling;
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return entry;
}

/**
 * Employment status history. The first event may be legacy UNCONFIRMED or the
 * current ON default at first_work_date; later events are ON/OFF transitions
 * (OFF carries a leave date).
 */
async function setEmploymentHistory(db, entry, steps) {
  const reasonId = await syntheticReason(db, "synthetic status reason");
  let version = 0;
  for (const step of steps) {
    version += 1;
    await db.query(
      "insert into public.direct_entry_employment_status_events" +
      " (entry_id, status, effective_date, leave_date, leave_reason_text, version," +
      " actor_user_id, reason_id)" +
      " values ($1,$2,$3::date, case when $2 = 'OFF' then $3::date else null end," +
      " case when $2 = 'OFF' then 'synthetic leave' else null end, $4,$5,$6)",
      [entry, step.status, step.effective, version, UPLOADER_APP, reasonId]);
  }
}

async function grantCapability(db, app, capability) {
  await db.query(
    "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
    " values ($1,$2,'2020-01-01',true)", [app, capability]);
}

async function grantScope(db, app, scopeKind, teamId = null) {
  await db.query(
    "insert into public.direct_entry_scope_grants" +
    " (app_user_id, scope_kind, team_id, valid_from, is_current)" +
    " values ($1,$2,$3,'2020-01-01',true)", [app, scopeKind, teamId]);
}

async function hasCapability(db, app, capability) {
  const res = await db.query(
    "select public.direct_entry_has_capability($1::uuid,$2::text) as ok", [app, capability]);
  return res.rows[0].ok;
}

async function reportingAudience(db, auth, app) {
  const res = await db.query(
    "select public.direct_entry_reporting_resolve_audience($1::uuid,$2::uuid) as data", [auth, app]);
  return res.rows[0].data;
}

async function assignManager(db, { project, recruiter, key }) {
  const version = await currentProjectVersion(db, project);
  await db.query(
    "select public.direct_entry_assign_project_manager($1::uuid,$2::uuid,$3::text,$4::uuid," +
    "$5::date,$6::integer,$7::text,$8::text)",
    [ADMIN_AUTH, ADMIN_APP, project, recruiter, null, version,
      "synthetic assignment", key]);
}

async function currentProjectVersion(db, project) {
  const res = await db.query(
    "select version from public.direct_entry_projects where project_id = $1", [project]);
  return res.rows[0].version;
}

async function listWorkers(db, {
  auth = MGR_A_AUTH, app = MGR_A_APP, scope = "managed",
  project = null, recruiter = null, employment = null, cursor = null, pageSize = null,
} = {}) {
  const res = await db.query(
    "select public.direct_entry_list_workers($1::uuid,$2::uuid,$3::text,$4::text,$5::uuid," +
    "$6::text,$7::text,$8::integer) as data",
    [auth, app, scope, project, recruiter, employment, cursor, pageSize]);
  return res.rows[0].data;
}

function codes(items) {
  return items.map((row) => row.employee_code).sort();
}

/**
 * Row-level change-request fixtures. The directory only reads the request tables,
 * so these insert the rows directly: this suite must not re-test the W04 engine
 * policy, and it must keep working while that policy is rebaselined.
 */
async function syntheticReason(db, text = "synthetic reason") {
  const res = await db.query(
    "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
    " values ($1,$2) returning reason_id::text as id", [UPLOADER_APP, text]);
  return res.rows[0].id;
}

async function insertPendingRequest(db, { entry, key }) {
  const reasonId = await syntheticReason(db);
  const res = await db.query(
    "insert into public.direct_entry_change_requests" +
    " (proposer_user_id, state, version, idempotency_key, request_hash, reason_id)" +
    " values ($1,'PENDING',1,$2,$3,$4) returning request_id::text as id",
    [MGR_A_APP, key, "a".repeat(64), reasonId]);
  const requestId = res.rows[0].id;
  await db.query(
    "insert into public.direct_entry_change_request_items" +
    " (request_id, entry_id, target_kind, expected_version, proposal)" +
    " values ($1,$2,'ENTRY_FIELD',1,$3::jsonb)",
    [requestId, entry, JSON.stringify({ phone: "0900000001" })]);
  return requestId;
}

async function rejectRequest(db, requestId) {
  const reasonId = await syntheticReason(db, "synthetic rejection");
  await db.query(
    "update public.direct_entry_change_requests set state='REJECTED', version=2," +
    " decided_by_user_id=$2, decided_at=now(), decision_reason_id=$3 where request_id=$1",
    [requestId, ADMIN_APP, reasonId]);
}

// ---------------------------------------------------------------------------
// 1. Three relationships stay distinct: recruiter != uploader != project manager.
// ---------------------------------------------------------------------------
test("W03: recruiter, uploader and project manager are three different audiences", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // REC_A worker was entered by the uploader; another worker belongs to REC_B.
    const entryA = await addWorker(db, { recruiter: REC_A, createdBy: UPLOADER_APP });
    await addWorker(db, { recruiter: REC_B, createdBy: UPLOADER_APP, workDate: "2026-10-02" });

    // The uploader is REC_C's linked account and entered both rows, but is neither
    // the recruiter of record nor a project manager.
    const uploaderRecruited = await listWorkers(db, {
      auth: UPLOADER_AUTH, app: UPLOADER_APP, scope: "recruited",
    });
    assert.deepEqual(uploaderRecruited.items, [],
      "created_by is not a recruiter identity");
    await assert.rejects(
      () => listWorkers(db, { auth: UPLOADER_AUTH, app: UPLOADER_APP, scope: "managed" }),
      (error) => error.code === "42501",
      "created_by is not a project assignment");

    // The canonical recruiter of record sees exactly their own rows.
    const recruiterA = await listWorkers(db, {
      auth: MGR_A_AUTH, app: MGR_A_APP, scope: "recruited",
    });
    assert.deepEqual(codes(recruiterA.items), ["hrp-2026-300001"]);
    assert.equal(recruiterA.items[0].entry_id, entryA);
    assert.equal(recruiterA.items[0].recruiter_id, REC_A);
    assert.equal(recruiterA.items[0].is_project_manager, false,
      "a recruiter with no assignment is not a project manager");
    assert.equal(recruiterA.items[0].allowed_actions.propose_change, false);
    // The uploader is NOT leaked into the canonical recruiter's projection.
    assert.equal(recruiterA.items[0].created_by_user_id, undefined);

    // An unlinked account resolves to no audience at all.
    await assert.rejects(
      () => listWorkers(db, { auth: PLAIN_AUTH, app: PLAIN_APP, scope: "recruited" }),
      (error) => error.code === "42501",
      "recruiter audience needs a verified link");
    await assert.rejects(
      () => listWorkers(db, { auth: UPLOADER_AUTH, app: UPLOADER_APP, scope: "all" }),
      (error) => error.code === "42501",
      "the all audience needs a reviewer capability and an all scope grant");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Project audience: effective assignment only, multi-manager, cross-project.
// ---------------------------------------------------------------------------
test("W03: project audience follows the effective assignment, several managers included", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await addWorker(db, { project: PROJ_A, recruiter: REC_A, workDate: "2026-10-01" });
    await addWorker(db, { project: PROJ_A, recruiter: REC_B, workDate: "2026-10-02" });
    await addWorker(db, { project: PROJ_B, recruiter: REC_A, workDate: "2026-10-03" });

    // MGR_A manages PROJ_A, MGR_B manages PROJ_A as well: multi-manager.
    await assignManager(db, { project: PROJ_A, recruiter: REC_A, key: "assign-a" });
    await assignManager(db, { project: PROJ_A, recruiter: REC_B, key: "assign-b" });

    for (const [auth, app] of [[MGR_A_AUTH, MGR_A_APP], [MGR_B_AUTH, MGR_B_APP]]) {
      const page = await listWorkers(db, { auth, app, scope: "managed" });
      assert.deepEqual(codes(page.items), ["hrp-2026-300001", "hrp-2026-300002"],
        "both effective managers see every worker of the project");
      assert.equal(page.items.every((row) => row.project_id === PROJ_A), true);
      assert.equal(page.items.every((row) => row.is_project_manager === true), true,
        "rows in a managed project report is_project_manager");
    }

    // A worker of PROJ_B is outside the assignment of both managers.
    await assignManager(db, { project: PROJ_B, recruiter: REC_C, key: "assign-c" });
    const crossProject = await listWorkers(db, {
      auth: MGR_A_AUTH, app: MGR_A_APP, scope: "managed", project: PROJ_B,
    }).catch((error) => error);
    assert.equal(crossProject.code, "42501",
      "asking for a project outside the effective assignment is refused");

    // Filters stay inside the audience: a recruiter filter cannot widen it.
    const filtered = await listWorkers(db, {
      auth: MGR_A_AUTH, app: MGR_A_APP, scope: "managed", recruiter: REC_B,
    });
    assert.deepEqual(codes(filtered.items), ["hrp-2026-300002"]);
    // Revoking the assignment removes the rows immediately.
    const assignment = await db.query(
      "select assignment_id::text as id, version from public.direct_entry_project_manager_assignments" +
      " a join public.direct_entry_app_user_recruiter_links l" +
      " on l.recruiter_id = a.manager_recruiter_id and l.app_user_id = $1::uuid" +
      " where a.project_id = $2 and a.valid_to is null", [MGR_A_APP, PROJ_A]);
    await db.query(
      "select public.direct_entry_unassign_project_manager($1::uuid,$2::uuid,$3::uuid,$4::integer," +
      "$5::integer,$6::text,$7::text)",
      [ADMIN_AUTH, ADMIN_APP, assignment.rows[0].id, assignment.rows[0].version,
        await currentProjectVersion(db, PROJ_A), "synthetic revocation", "unassign-a"]);
    const afterRevoke = await listWorkers(db, {
      auth: MGR_A_AUTH, app: MGR_A_APP, scope: "managed",
    }).catch((error) => error);
    assert.equal(afterRevoke.code, "42501", "no assignment left => no project audience");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. All audience policy (P2.5-W03-R1): an effective all scope AND one of the
//    reviewer/admin capabilities. The reporting audience, a team/own scope, an
//    uploader identity or a recruiter link never open it.
// ---------------------------------------------------------------------------
test("W03-R1: the all audience accepts entry_admin or change_review, always with all scope", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await addWorker(db, {
      project: PROJ_A, recruiter: REC_A, workDate: "2026-10-01",
      payment: { state: "provided", account_number: "012345678901", bank_id: null,
        account_holder_name: "Synthetic Holder" },
    });
    await addWorker(db, { project: PROJ_B, recruiter: REC_B, workDate: "2026-10-02" });
    const ALL_CODES = ["hrp-2026-300001", "hrp-2026-300002"];

    // 1. entry_admin + all -> allow (Admin / project administrator).
    assert.deepEqual(codes((await listWorkers(db, {
      auth: ADMIN_AUTH, app: ADMIN_APP, scope: "all" })).items), ALL_CODES);

    // 2. change_review + all -> allow (Accounting / BoD reviewer bundle), and the
    //    reviewer bundle must NOT need entry_admin to open the directory.
    await grantCapability(db, REVIEWER_APP, "change_review");
    await grantScope(db, REVIEWER_APP, "all");
    assert.equal(await hasCapability(db, REVIEWER_APP, "entry_admin"), false);
    const reviewerPage = await listWorkers(db, {
      auth: REVIEWER_AUTH, app: REVIEWER_APP, scope: "all" });
    assert.deepEqual(codes(reviewerPage.items), ALL_CODES);
    assert.deepEqual(reviewerPage.summary,
      { total_workers: 2, project_count: 2, recruiter_count: 2 },
      "all-scope summary remains restricted to the same authorized audience");

    // 3. entry_admin without an all scope -> deny.
    await grantCapability(db, MGR_A_APP, "entry_admin");
    await assert.rejects(
      () => listWorkers(db, { auth: MGR_A_AUTH, app: MGR_A_APP, scope: "all" }),
      (error) => error.code === "42501",
      "entry_admin without an all scope grant is refused");

    // 4. change_review without an all scope -> deny.
    await grantCapability(db, PLAIN_APP, "change_review");
    await assert.rejects(
      () => listWorkers(db, { auth: PLAIN_AUTH, app: PLAIN_APP, scope: "all" }),
      (error) => error.code === "42501",
      "change_review without an all scope grant is refused");

    // 5. all scope but neither capability -> deny, even though the W05A reporting
    //    audience for the same actor resolves to all. Reporting is not a directory
    //    grant, and this actor is also the uploader of both rows.
    await grantScope(db, UPLOADER_APP, "all");
    await grantCapability(db, UPLOADER_APP, "report_analytics_view");
    const reporting = await reportingAudience(db, UPLOADER_AUTH, UPLOADER_APP);
    assert.equal(reporting.audience, "all",
      "the reporting audience really is all for this actor");
    assert.equal(await hasCapability(db, UPLOADER_APP, "entry_admin"), false);
    assert.equal(await hasCapability(db, UPLOADER_APP, "change_review"), false);
    await assert.rejects(
      () => listWorkers(db, { auth: UPLOADER_AUTH, app: UPLOADER_APP, scope: "all" }),
      (error) => error.code === "42501",
      "all scope plus the reporting audience never opens the directory");

    // 6. a team or own scope never substitutes for all, even with a capability.
    await grantCapability(db, MGR_B_APP, "entry_admin");
    await grantScope(db, MGR_B_APP, "team", TEAM);
    await assert.rejects(
      () => listWorkers(db, { auth: MGR_B_AUTH, app: MGR_B_APP, scope: "all" }),
      (error) => error.code === "42501",
      "entry_admin + team scope is not an all audience");
    await grantScope(db, PLAIN_APP, "own");
    await assert.rejects(
      () => listWorkers(db, { auth: PLAIN_AUTH, app: PLAIN_APP, scope: "all" }),
      (error) => error.code === "42501",
      "change_review + own scope is not an all audience");

    // 7. Retired payment/PII capabilities no longer alter an authorized row projection.
    const paidRow = (page) =>
      page.items.find((item) => item.employee_code === "hrp-2026-300001");
    const withoutLegacyGrants = paidRow(await listWorkers(db, {
      auth: REVIEWER_AUTH, app: REVIEWER_APP, scope: "all" }));
    assert.equal(withoutLegacyGrants.payment.account_number, "012345678901");
    assert.deepEqual(
      [withoutLegacyGrants.allowed_actions.view_payment, withoutLegacyGrants.allowed_actions.view_pii],
      [true, true],
      "payment and profile actions follow the authorized worker audience");
    await grantCapability(db, REVIEWER_APP, "payment_view");
    await grantCapability(db, REVIEWER_APP, "pii_view");
    assert.equal(await hasCapability(db, REVIEWER_APP, "payment_view"), false);
    assert.equal(await hasCapability(db, REVIEWER_APP, "pii_view"), false);
    const withLegacyGrants = paidRow(await listWorkers(db, {
      auth: REVIEWER_AUTH, app: REVIEWER_APP, scope: "all" }));
    assert.deepEqual(withLegacyGrants.payment, withoutLegacyGrants.payment);
    assert.deepEqual(withLegacyGrants.allowed_actions, withoutLegacyGrants.allowed_actions);
    for (const leaked of ["national_id", "date_of_birth", "address", "phone", "worker_details"]) {
      assert.equal(leaked in withLegacyGrants, false, leaked + " must never be in a directory row");
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Keyset pagination and server-side filters.
// ---------------------------------------------------------------------------
test("W03: pagination is keyset, stable and bounded; filters are server-side", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await assignManager(db, { project: PROJ_A, recruiter: REC_A, key: "assign-a" });
    const codesInOrder = [];
    const createdAtByWorkDate = new Map([
      ["2026-10-01", "2026-10-08T09:00:00.000000Z"],
      ["2026-10-02", "2026-10-04T09:00:00.000000Z"],
      ["2026-10-03", "2026-10-07T09:00:00.000000Z"],
      ["2026-10-04", "2026-10-03T09:00:00.000000Z"],
      ["2026-10-05", "2026-10-05T09:00:00.000000Z"],
    ]);
    for (const day of ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]) {
      const entry = await addWorker(db, {
        project: PROJ_A, recruiter: day === "2026-10-03" ? REC_B : REC_A, workDate: day,
        createdAt: createdAtByWorkDate.get(day),
      });
      codesInOrder.push(entry);
    }
    await addWorker(db, { project: PROJ_A, workDate: "2026-10-06", state: "REVIEW" });
    const deletedEntry = await addWorker(db, {
      project: PROJ_A, workDate: "2026-10-07", deleted: true,
      createdAt: "2026-10-06T09:00:00.000000Z",
    });
    const liveSibling = lastSibling;
    await addWorker(db, { project: PROJ_B, workDate: "2026-10-08" });

    const first = await listWorkers(db, { scope: "managed", pageSize: 2 });
    assert.equal(first.page_size, 2);
    assert.equal(first.has_more, true);
    assert.deepEqual(first.summary, { total_workers: 6, project_count: 1, recruiter_count: 2 },
      "summary covers every authorized, filtered row rather than only this page");
    assert.deepEqual(first.items.map((row) => row.entry_id),
      [codesInOrder[0], codesInOrder[2]], "newest entry time first, independent of first work date");
    assert.match(first.next_cursor, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\|[0-9a-f-]{36}$/);

    const seen = [...first.items.map((row) => row.entry_id)];
    let cursor = first.next_cursor;
    let guard = 0;
    while (cursor !== null && guard < 10) {
      const page = await listWorkers(db, { scope: "managed", pageSize: 2, cursor });
      assert.deepEqual(page.summary, first.summary,
        "summary stays cursor-independent on every page");
      seen.push(...page.items.map((row) => row.entry_id));
      cursor = page.next_cursor;
      guard += 1;
    }
    assert.deepEqual(seen, [codesInOrder[0], codesInOrder[2], liveSibling,
      codesInOrder[4], codesInOrder[1], codesInOrder[3]],
      "the full scan returns every eligible row exactly once");
    assert.equal(new Set(seen).size, seen.length, "no duplicate row across pages");

    // REVIEW, soft-deleted rows and other projects never appear in the page.
    assert.equal(seen.length, 6);
    assert.equal(seen.includes(deletedEntry), false, "a soft-deleted row is not a worker");
    assert.equal(seen.includes(liveSibling), true, "its live sibling still is");

    const auditEntry = await db.query(
      "select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as data",
      [ADMIN_AUTH, ADMIN_APP, liveSibling]);
    assert.equal(auditEntry.rows[0].data.created_at, "2026-10-06T09:00:00.000000Z");
    assert.deepEqual(auditEntry.rows[0].data.created_by, {
      display_name: "Recruiter C", login_id: `user-${UPLOADER_APP.slice(-2)}`,
    }, "authorized detail exposes only the creator display and login id, not its database key");

    // Bounds and validation are server-side.
    for (const pageSize of [0, 101]) {
      await assert.rejects(() => listWorkers(db, { scope: "managed", pageSize }),
        (error) => error.code === "22023", "page size " + pageSize);
    }
    await assert.rejects(() => listWorkers(db, { scope: "managed", cursor: "not-a-cursor" }),
      (error) => error.code === "22023");
    await assert.rejects(() => listWorkers(db, { scope: "everything" }),
      (error) => error.code === "22023");
    await assert.rejects(() => listWorkers(db, { scope: "managed", employment: "MAYBE" }),
      (error) => error.code === "22023");
    await assert.rejects(
      () => listWorkers(db, { scope: "managed", project: "bad project id" }),
      (error) => error.code === "22023");

  } finally {
    await db.close();
  }
});

test("W03: the employment status filter reads the latest status event", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await assignManager(db, { project: PROJ_A, recruiter: REC_A, key: "assign-a" });
    const worker = await addWorker(db, { project: PROJ_A, workDate: "2026-10-02" });
    const untouched = await addWorker(db, { project: PROJ_A, workDate: "2026-10-03" });
    const raw = await addWorker(db, { project: PROJ_A, workDate: "2026-10-05" });
    await setEmploymentHistory(db, worker, [
      { status: "UNCONFIRMED", effective: "2026-10-02" },
      { status: "ON", effective: "2026-10-03" },
      { status: "OFF", effective: "2026-10-04" },
    ]);
    await setEmploymentHistory(db, untouched, [
      { status: "UNCONFIRMED", effective: "2026-10-03" },
    ]);

    const off = await listWorkers(db, { scope: "managed", employment: "OFF" });
    assert.deepEqual(off.items.map((row) => row.entry_id), [worker]);
    assert.equal(off.items[0].employment_status, "OFF");
    assert.deepEqual(off.summary, { total_workers: 1, project_count: 1, recruiter_count: 1 },
      "summary follows the selected employment status");
    const unconfirmed = await listWorkers(db, { scope: "managed", employment: "UNCONFIRMED" });
    assert.deepEqual(unconfirmed.items.map((row) => row.entry_id), [untouched],
      "the filter follows the latest status event");
    assert.equal(unconfirmed.items[0].employment_status, "UNCONFIRMED");
    // A worker with no status event has no status: the directory mirrors the
    // existing read projection instead of inventing the engine's implicit default.
    const all = await listWorkers(db, { scope: "managed" });
    assert.equal(all.items.find((row) => row.entry_id === raw).employment_status, null);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Worker row scope governs payment; full worker profile PII stays excluded.
// ---------------------------------------------------------------------------
test("W03-R1: payment follows worker scope; raw profile PII is never projected", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await assignManager(db, { project: PROJ_A, recruiter: REC_A, key: "assign-a" });
    await addWorker(db, {
      project: PROJ_A, workDate: "2026-10-01",
      payment: { state: "provided", account_number: "012345678901", bank_id: null,
        account_holder_name: "Synthetic Holder" },
    });

    const withoutLegacyGrants = await listWorkers(db, { scope: "managed" });
    const rowWithout = withoutLegacyGrants.items[0];
    assert.equal(rowWithout.payment.account_number, "012345678901");
    assert.equal(rowWithout.allowed_actions.view_payment, true);
    assert.equal(rowWithout.allowed_actions.view_pii, true);
    for (const leaked of ["national_id", "date_of_birth", "address", "phone", "worker_details"]) {
      assert.equal(leaked in rowWithout, false, leaked + " must never be in the directory row");
    }

    await grantCapability(db, MGR_A_APP, "payment_view");
    await grantCapability(db, MGR_A_APP, "pii_view");
    assert.equal(await hasCapability(db, MGR_A_APP, "payment_view"), false);
    assert.equal(await hasCapability(db, MGR_A_APP, "pii_view"), false);
    const withLegacyGrants = await listWorkers(db, { scope: "managed" });
    const rowWith = withLegacyGrants.items[0];
    assert.deepEqual(rowWith.payment, rowWithout.payment,
      "retired field-level grants do not change the authorized worker projection");
    assert.deepEqual(rowWith.allowed_actions, rowWithout.allowed_actions);
    assert.deepEqual(Object.keys(rowWithout).sort(), Object.keys(rowWith).sort(),
      "the row key set never changes with capability");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. allowed_actions is server-supplied for current assignment authority.
// ---------------------------------------------------------------------------
test("W03: allowed_actions is server-supplied and follows the assignment authority", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await assignManager(db, { project: PROJ_A, recruiter: REC_A, key: "assign-a" });
    const entry = await addWorker(db, { project: PROJ_A, recruiter: REC_A, workDate: "2026-10-01" });

    // P2.5-W05 (#55): a current project manager may edit and propose through
    // existing server authority; the UI prioritizes direct edit for the row.
    for (const scope of ["managed", "recruited"]) {
      const page = await listWorkers(db, { scope });
      for (const row of page.items) {
        assert.deepEqual(row.allowed_actions, {
          view: true,
          view_pii: true,
          view_payment: true,
          direct_edit: true,
          propose_change: true,
          propose_change_code: null,
        }, scope + " must advertise propose_change for the assigned manager");
      }
    }
    const admin = await listWorkers(db, { auth: ADMIN_AUTH, app: ADMIN_APP, scope: "all" });
    for (const row of admin.items) {
      assert.deepEqual(row.allowed_actions, {
        view: true,
        view_pii: true,
        view_payment: true,
        direct_edit: false,
        propose_change: false,
        propose_change_code: "NOT_PROJECT_MANAGER",
      }, "a non-manager must get the stable denial, never a placeholder");
    }

    // is_project_manager remains the same predicate the action is derived from.
    const managed = await listWorkers(db, { scope: "managed" });
    assert.equal(managed.items[0].is_project_manager, true);
    assert.equal(managed.items[0].entry_id, entry);

    // Pending request and last decision metadata come from the existing engine tables.
    const requestId = await insertPendingRequest(db, { entry, key: "w03-propose-1" });
    const pending = await listWorkers(db, { scope: "managed" });
    assert.deepEqual(pending.items[0].pending_request, {
      request_id: requestId, state: "PENDING", version: 1,
    });
    assert.equal(pending.items[0].last_decision, null);

    await rejectRequest(db, requestId);
    const decided = await listWorkers(db, { scope: "managed" });
    assert.equal(decided.items[0].pending_request, null);
    assert.equal(decided.items[0].last_decision.state, "REJECTED");
    assert.match(decided.items[0].last_decision.decided_at, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*Z$/);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 7. ACL / hardening.
// ---------------------------------------------------------------------------
test("W03: the directory RPC is service_role only and the audience guard is revoked", async () => {
  const db = await buildDb();
  try {
    const rpc = "public.direct_entry_list_workers(uuid, uuid, text, text, uuid, text, text, integer)";
    const guard = "public.direct_entry_worker_directory_audience(uuid, uuid, text, text)";
    const res = await db.query(
      "select p.prosecdef, p.proconfig from pg_proc p where p.oid = $1::regprocedure", [rpc]);
    assert.equal(res.rows[0].prosecdef, true);
    assert.ok(res.rows[0].proconfig.includes("search_path=pg_catalog, public"));
    for (const [role, expected] of [["service_role", true], ["anon", false], ["authenticated", false]]) {
      const priv = await db.query(
        "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [role, rpc]);
      assert.equal(priv.rows[0].ok, expected, rpc + " vs " + role);
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      const priv = await db.query(
        "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [role, guard]);
      assert.equal(priv.rows[0].ok, false, guard + " must stay revoked from " + role);
    }
    const guardDef = await db.query(
      "select p.prosecdef from pg_proc p where p.oid = $1::regprocedure", [guard]);
    assert.equal(guardDef.rows[0].prosecdef, true);
  } finally {
    await db.close();
  }
});
