/**
 * P2.5 reviewer/accounting hotfix - root cause regression (PGlite over #1-#56).
 *
 * The reviewer bundle (change_review + pii_view + payment_view + effective all
 * scope, NO entry_admin) can read and decide change requests. W2S1 also allows
 * this bounded all-scope reviewer audience to read the submitted entry
 * projection; pii/payment/document fields remain independently capability-gated.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) { return "00000000-0000-4000-8000-" + String(n).padStart(12, "0"); }
const TEAM = uuid(11);
const PROJ_A = "proj_rv_a";
const REC_PM = uuid(21);
const UPLOADER_AUTH = uuid(31), UPLOADER_APP = uuid(41);
const PM_AUTH = uuid(32), PM_APP = uuid(42);
const ADMIN_AUTH = uuid(33), ADMIN_APP = uuid(43);
const REV_AUTH = uuid(39), REV_APP = uuid(49);

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql") && n <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
  for (const name of names) await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  return db;
}

async function insertActor(db, auth, app, capabilities, scopeKind = null) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')",
    [app, auth]);
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [app, capability]);
  }
  if (scopeKind !== null) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [app, scopeKind]);
  }
}

async function seed(db) {
  await db.query("insert into public.teams (team_id, code, display_name) values ($1,'TEAM_RV','Team RV')", [TEAM]);
  await db.query("insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project RV')", [PROJ_A]);
  await db.query("insert into public.direct_entry_banks (bank_id, display_name) values ('bank_rv','Bank RV')");
  await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter PM')", [REC_PM]);
  await db.query("insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1,'hrp','2020-01-01',true)", [REC_PM]);
  await db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1,$2,'2020-01-01',true)", [REC_PM, TEAM]);
  await insertActor(db, UPLOADER_AUTH, UPLOADER_APP, ["entry_create", "submission_create", "entry_own", "change_request_create"], "own");
  await insertActor(db, PM_AUTH, PM_APP, ["entry_create", "change_request_create"], null);
  await insertActor(db, ADMIN_AUTH, ADMIN_APP, ["entry_admin", "change_review", "pii_view", "payment_view"], "all");
  // Exactly the reviewer bundle in Production (lienvu / ngattt): NO entry_admin.
  await insertActor(db, REV_AUTH, REV_APP, ["change_review", "pii_view", "payment_view"], "all");
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)" +
    " values ($1,$2,true,'2020-01-01',true)", [PM_APP, REC_PM]);
  await db.query(
    "select public.direct_entry_assign_project_manager($1::uuid,$2::uuid,$3::text,$4::uuid,$5::date,$6::integer,$7::text,$8::text)",
    [ADMIN_AUTH, ADMIN_APP, PROJ_A, REC_PM, null, 1, "synthetic assignment", "rv-assign"]);
}

let seq = 0;
async function addSubmittedEntry(db) {
  seq += 1; const n = seq;
  const candidate = uuid(5000 + n), submission = uuid(6000 + n), entry = uuid(7000 + n);
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidate]);
    await db.query("insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1,$2,'DRAFT')", [submission, UPLOADER_APP]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
      " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
      " provider_type, labor_type) values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY')",
      [entry, submission, candidate, UPLOADER_APP, PROJ_A, "2026-10-01",
        "hrp-2026-" + String(300000 + n),
        JSON.stringify({ display_name: "RV Worker " + n,
          date_of_birth: { state: "unknown" }, national_id: { state: "unknown" },
          address: { state: "provided", value: "RV address " + n }, phone: { state: "unknown" } }),
        REC_PM, TEAM]);
    await seedLegacyReviewSubmission(db, submission);
    await db.query("update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1", [submission]);
    // Initial employment status event (UNCONFIRMED at first_work_date).
    const reason = await db.query(
      "select public.direct_entry_reason($1::uuid,$2::text) as reason_id",
      [UPLOADER_APP, "synthetic initial status"]);
    await db.query(
      "insert into public.direct_entry_employment_status_events" +
      " (entry_id, status, effective_date, version, actor_user_id, reason_id)" +
      " values ($1,'UNCONFIRMED','2026-10-01',1,$2,$3)",
      [entry, UPLOADER_APP, reason.rows[0].reason_id]);
    await db.exec("commit");
  } catch (error) { await db.exec("rollback"); throw error; }
  return { entry, submission };
}

async function proposeWorkStatus(db, entry, key) {
  const res = await db.query(
    "select public.direct_entry_create_change_request($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text) as data",
    [PM_AUTH, PM_APP, JSON.stringify([{ entry_id: entry, target_kind: "WORK_STATUS",
      expected_version: 1, proposal: { status: "ON", effective_date: "2026-10-02" } }]),
      "synthetic status request", key]);
  return res.rows[0].data;
}

async function readProjection(db, auth, app, entry) {
  return db.query("select public.direct_entry_read_projection($1::uuid,$2::uuid,$3::uuid) as data",
    [auth, app, entry]);
}

test("reviewer bundle CAN read the change-request detail and the decision path", async () => {
  const db = await buildDb();
  await seed(db);
  const { entry } = await addSubmittedEntry(db);
  const request = await proposeWorkStatus(db, entry, "rv-status-1");
  assert.equal(request.state, "PENDING");
  const detail = await db.query(
    "select public.direct_entry_read_change_request($1::uuid,$2::uuid,$3::uuid) as data",
    [REV_AUTH, REV_APP, request.request_id]);
  assert.equal(detail.rows[0].data.state, "PENDING");
  assert.equal(detail.rows[0].data.can_decide, true, "reviewer bundle quyet dinh duoc");
  // WORK_STATUS needs change_review only (W05-R1) — no employment_status.apply.
  const decided = await db.query(
    "select public.direct_entry_decide_change_request($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text,$7::text) as data",
    [REV_AUTH, REV_APP, request.request_id, 1, "APPROVED", "synthetic approval", "rv-decide-1"]);
  assert.equal(decided.rows[0].data.state, "APPROVED");
  await db.close();
});

test("reviewer bundle CAN read the bounded SUBMITTED entry projection without entry_admin", async () => {
  const db = await buildDb();
  await seed(db);
  const { entry } = await addSubmittedEntry(db);
  // The reviewer drawer reads this endpoint for the BEFORE values.
  const reviewer = await readProjection(db, REV_AUTH, REV_APP, entry);
  assert.equal(reviewer.rows[0].data.scope_kind, "all");
  assert.match(reviewer.rows[0].data.worker_details.display_name, /^RV Worker \d+$/,
    "pii_view keeps worker details available to the authorized reviewer");
  assert.deepEqual(reviewer.rows[0].data.documents, [],
    "document_view remains an independent field gate");

  // entry_admin + all remains a separately authorized audience.
  const admin = await readProjection(db, ADMIN_AUTH, ADMIN_APP, entry);
  assert.ok(admin.rows[0].data, "entry_admin + all can read the projection");
  await db.close();
});

test("all-scope change reviewers use resource scope without PII/payment capabilities", async () => {
  const db = await buildDb();
  await seed(db);
  const restrictedAuth = uuid(50), restrictedApp = uuid(51);
  await insertActor(db, restrictedAuth, restrictedApp, ["change_review"], "all");
  const { entry } = await addSubmittedEntry(db);
  await db.query(
    "insert into public.direct_entry_payments(entry_id,state,account_number,bank_id,account_holder_name)" +
      " values ($1,'provided','12345678','bank_rv','Synthetic Holder')",
    [entry]);
  const reviewer = await readProjection(db, REV_AUTH, REV_APP, entry);
  assert.equal(reviewer.rows[0].data.payment.account_number, "12345678",
    "payment_view allows the authorized reviewer to read payment details");
  assert.equal(reviewer.rows[0].data.payment.bank_id, "bank_rv");

  const restricted = await readProjection(db, restrictedAuth, restrictedApp, entry);
  const data = restricted.rows[0].data;
  assert.equal(data.scope_kind, "all");
  assert.equal(data.worker_details.display_name, "RV Worker 3",
    "change_review plus all scope exposes the bounded worker detail without pii_view");
  assert.equal(data.worker_details.address.value, "RV address 3",
    "worker detail visibility follows the reviewer resource scope");
  assert.equal(data.payment.account_number, "12345678",
    "payment visibility no longer depends on payment_view");
  assert.equal(data.payment.bank_id, "bank_rv");
  assert.equal(data.payment.account_holder_name, "Synthetic Holder");
  assert.deepEqual(data.documents, [],
    "missing document_view returns no document metadata");
  await db.close();
});
