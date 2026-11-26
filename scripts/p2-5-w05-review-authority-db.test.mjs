/**
 * P2.5-W05 - review authority backend (DB regression, PGlite, 55-migration ledger).
 *
 * Proves the W05 policy lock at the DB boundary:
 *   * review authority (visibility AND decision) = capability change_review plus an
 *     effective all scope grant; team/own scope, a role/email, a reporting audience
 *     and created_by never make an actor a reviewer;
 *   * the reviewer bundle is declared and minimal (change_review) and grants nothing to anybody;
 *   * every direct mutation path stays denied on SUBMITTED, for an actor holding
 *     payment_edit + employment_status.apply + entry_privileged_edit + entry_admin at
 *     all scope, with values/version/audit unchanged; the approval engine is the only
 *     path that applies to canonical data, and DRAFT keeps working;
 *     P2.5-HF-R3 changes exactly one of those paths on purpose: the privileged correction
 *     path may now target a SUBMITTED entry (see the dedicated R3 test at the end);
 *   * the W03 worker directory now serves allowed_actions.propose_change from the W04
 *     assignment authority instead of the PROPOSE_PENDING_W04_POLICY placeholder.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const W05_MIGRATION = "20261008150000_p2_5_w05_review_authority.sql";
const W05_R1_MIGRATION = "20261008160000_p2_5_w05_r1_review_capability_matrix.sql";
const STATUS_DEFAULT_MIGRATION = "20261008170000_p2_5_initial_employment_status_on.sql";
const W06A_MIGRATION = "20261008140000_p2_5_w06a_manager_candidates.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "proj_w05_a", PROJ_B = "proj_w05_b";
const REC_PM = uuid(21), REC_B = uuid(22), REC_UP = uuid(23);
const UPLOADER_AUTH = uuid(31), UPLOADER_APP = uuid(41);
const PM_AUTH = uuid(32), PM_APP = uuid(42);
const ADMIN_AUTH = uuid(33), ADMIN_APP = uuid(43);
const REV_ALL_AUTH = uuid(34), REV_ALL_APP = uuid(44);
const REV_TEAM_AUTH = uuid(35), REV_TEAM_APP = uuid(45);
const REV_OWN_AUTH = uuid(36), REV_OWN_APP = uuid(46);
const REV_NONE_AUTH = uuid(37), REV_NONE_APP = uuid(47);
const ALL_NO_CAP_AUTH = uuid(38), ALL_NO_CAP_APP = uuid(48);
const REV_BUNDLE_AUTH = uuid(39), REV_BUNDLE_APP = uuid(49);

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
  assert.equal(names.indexOf(STATUS_DEFAULT_MIGRATION), 56, "initial-ON remains #57");
  assert.equal(names.indexOf(W05_R1_MIGRATION), 55, "initial-ON follows W05-R1 #56");
  assert.equal(names.indexOf(W05_MIGRATION), 54, "W05-R1 follows W05 #55");
  assert.equal(names.indexOf(W06A_MIGRATION), 53, "W05-R1 ledger keeps W06A #54");
  return db;
}

async function insertActor(db, auth, app, capabilities, scopeKind = null, teamId = null) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,true,'Synthetic Account')", [app, auth]);
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [app, capability]);
  }
  if (scopeKind !== null) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)" +
      " values ($1,$2,$3,'2020-01-01',true)", [app, scopeKind, scopeKind === "team" ? teamId : null]);
  }
}

async function seed(db) {
  // Catalog rows first: the team-scoped actor references a team at insert time.
  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_W5','Team W5')", [TEAM]);
  for (const [project, name] of [[PROJ_A, "Project W5 A"], [PROJ_B, "Project W5 B"]]) {
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)",
      [project, name]);
  }
  for (const [recruiter, name] of [[REC_PM, "Recruiter PM"], [REC_B, "Recruiter B"],
    [REC_UP, "Recruiter Uploader"]]) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1,$2)", [recruiter, name]);
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
      " values ($1,'hrp','2020-01-01',true)", [recruiter]);
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [recruiter, TEAM]);
  }

  await insertActor(db, UPLOADER_AUTH, UPLOADER_APP,
    ["entry_create", "submission_create", "entry_own", "change_request_create"], "own");
  await insertActor(db, PM_AUTH, PM_APP,
    ["entry_create", "change_request_create"], null);
  await insertActor(db, ADMIN_AUTH, ADMIN_APP,
    ["entry_admin", "change_review", "pii_view", "payment_view", "payment_edit",
      "employment_status.apply", "entry_privileged_edit"], "all");
  await insertActor(db, REV_ALL_AUTH, REV_ALL_APP, ["change_review", "pii_view"], "all");
  await insertActor(db, REV_TEAM_AUTH, REV_TEAM_APP, ["change_review", "pii_view"], "team", TEAM);
  await insertActor(db, REV_OWN_AUTH, REV_OWN_APP, ["change_review", "pii_view"], "own");
  await insertActor(db, REV_NONE_AUTH, REV_NONE_APP, ["change_review"], null);
  await insertActor(db, ALL_NO_CAP_AUTH, ALL_NO_CAP_APP, [], "all");
  // Retired PII/payment grants are unnecessary; change_review plus all scope is sufficient.
  await insertActor(db, REV_BUNDLE_AUTH, REV_BUNDLE_APP,
    ["change_review"], "all");

  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)",
    [PM_APP, REC_PM]);
  // PM_APP manages PROJ_A: the W04 propose authority.
  await db.query(
    "select public.direct_entry_assign_project_manager($1::uuid,$2::uuid,$3::text,$4::uuid," +
    "$5::date,$6::integer,$7::text,$8::text)",
    [ADMIN_AUTH, ADMIN_APP, PROJ_A, REC_PM, null, 1, "W05 synthetic assignment", "w05-assign"]);
}

let entrySeq = 0;
/** Creates a submission with one SUBMITTED or DRAFT entry; returns ids. */
async function addEntry(db, {
  project = PROJ_A, recruiter = REC_PM, createdBy = UPLOADER_APP,
  workDate = "2026-10-01", state = "SUBMITTED", payment = null,
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
      " provider_type, labor_type)" +
      " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY')",
      [entry, submission, candidate, createdBy, project, workDate,
        "hrp-" + year + "-" + String(300000 + n),
        JSON.stringify({ display_name: "W05 Worker " + n,
          date_of_birth: { state: "unknown" }, national_id: { state: "unknown" },
          address: { state: "provided", value: "W05 address " + n },
          phone: { state: "unknown" } }),
        recruiter, TEAM]);
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
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return { entry, submission };
}

async function propose(db, { entry, expectedVersion = 1, key, auth = PM_AUTH, app = PM_APP,
  targetKind = "ENTRY_FIELD", proposal = null }) {
  // display_name is protected (W04): a worker_details proposal must carry the stored
  // one, so read it instead of guessing.
  const stored = (await db.query(
    "select worker_details->>'display_name' as name from public.direct_entries where entry_id = $1::uuid",
    [entry])).rows[0].name;
  const res = await db.query(
    "select public.direct_entry_create_change_request($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text) as data",
    [auth, app,
      JSON.stringify([{ entry_id: entry, target_kind: targetKind, expected_version: expectedVersion,
        // worker_details is replaced as a whole validated object (the entry check
        // requires every key), with display_name unchanged.
        proposal: proposal ?? { worker_details: { display_name: stored,
          date_of_birth: { state: "unknown" }, national_id: { state: "unknown" },
          address: { state: "provided", value: "W05 proposed address" },
          phone: { state: "unknown" } } } }]),
      "W05 synthetic request", key]);
  return res.rows[0].data;
}

async function decide(db, { requestId, auth, app, decision = "APPROVED", version = 1, key, reason = "W05 synthetic decision" }) {
  const res = await db.query(
    "select public.direct_entry_decide_change_request($1::uuid,$2::uuid,$3::uuid,$4::integer," +
    "$5::text,$6::text,$7::text) as data",
    [auth, app, requestId, version, decision, reason, key]);
  return res.rows[0].data;
}

async function listRequests(db, auth, app, pageSize = 50) {
  const res = await db.query(
    "select public.direct_entry_list_change_requests($1::uuid,$2::uuid,$3::integer,$4::text,$5::text) as data",
    [auth, app, pageSize, null, null]);
  return res.rows[0].data;
}

async function count(db, sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

async function snapshot(db) {
  return {
    entries: await count(db, "select count(*)::int as n from public.direct_entries"),
    revisions: await count(db, "select count(*)::int as n from public.direct_entry_revisions"),
    audits: await count(db, "select count(*)::int as n from public.direct_entry_audit_events"),
    statuses: await count(db, "select count(*)::int as n from public.direct_entry_employment_status_events"),
    payments: await count(db, "select coalesce(sum(version),0)::int as n from public.direct_entry_payments"),
    versions: await count(db, "select coalesce(sum(version),0)::int as n from public.direct_entries"),
    idempotency: await count(db, "select count(*)::int as n from public.direct_entry_rpc_idempotency"),
  };
}

// ---------------------------------------------------------------------------
// 1. Decision authority: change_review + effective all scope.
// ---------------------------------------------------------------------------
test("W05: approve/reject need change_review and an effective all scope grant", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const { entry } = await addEntry(db, {});
    const request = await propose(db, { entry, key: "w05-request-1" });

    const before = await snapshot(db);
    const entryBefore = await db.query(
      "select version, worker_details from public.direct_entries where entry_id = $1::uuid", [entry]);

    for (const [label, auth, app, code] of [
      ["team scope", REV_TEAM_AUTH, REV_TEAM_APP, "42501"],
      ["own scope", REV_OWN_AUTH, REV_OWN_APP, "42501"],
      ["no scope", REV_NONE_AUTH, REV_NONE_APP, "42501"],
      ["all scope without change_review", ALL_NO_CAP_AUTH, ALL_NO_CAP_APP, "42501"],
    ]) {
      for (const decision of ["APPROVED", "REJECTED"]) {
        await assert.rejects(
          () => decide(db, { requestId: request.request_id, auth, app, decision,
            key: "w05-deny-" + label + "-" + decision }),
          (error) => error.code === code,
          label + " must not " + decision);
      }
    }
    assert.deepEqual(await snapshot(db), before,
      "a denied review leaves no revision, audit, idempotency or version change");
    const entryMid = await db.query(
      "select version, worker_details from public.direct_entries where entry_id = $1::uuid", [entry]);
    assert.deepEqual(entryMid.rows[0], entryBefore.rows[0], "canonical data untouched");
    const requestMid = await db.query(
      "select state, version from public.direct_entry_change_requests where request_id = $1::uuid",
      [request.request_id]);
    assert.deepEqual(requestMid.rows[0], { state: "PENDING", version: 1 });

    // The all-scope reviewer with the bundle capabilities decides it once.
    const approved = await decide(db, { requestId: request.request_id,
      auth: REV_ALL_AUTH, app: REV_ALL_APP, key: "w05-approve-1" });
    assert.deepEqual(approved, { request_id: request.request_id, state: "APPROVED", version: 2 });
    const entryAfter = await db.query(
      "select version, worker_details->'address'->>'value' as address from public.direct_entries" +
      " where entry_id = $1::uuid", [entry]);
    assert.equal(entryAfter.rows[0].version, 2, "the approval engine applied the change once");
    assert.equal(entryAfter.rows[0].address, "W05 proposed address");
    const audit = await db.query(
      "select capability, scope_kind, outcome from public.direct_entry_audit_events" +
      " where action = 'change_request_approve'");
    assert.deepEqual(audit.rows, [{ capability: "change_review", scope_kind: "all", outcome: "APPLIED" }]);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Visibility follows the same authority as the decision.
// ---------------------------------------------------------------------------
test("W05: reviewer visibility requires the same all-scope lock", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const { entry } = await addEntry(db, {});
    const request = await propose(db, { entry, key: "w05-request-2" });

    const all = await listRequests(db, REV_ALL_AUTH, REV_ALL_APP);
    assert.deepEqual(all.requests.map((row) => row.request_id), [request.request_id],
      "the all-scope reviewer sees the queue");
    const detail = await db.query(
      "select public.direct_entry_read_change_request($1::uuid,$2::uuid,$3::uuid) as data",
      [REV_ALL_AUTH, REV_ALL_APP, request.request_id]);
    assert.equal(detail.rows[0].data.request_id, request.request_id);

    for (const [label, auth, app] of [
      ["team scope", REV_TEAM_AUTH, REV_TEAM_APP],
      ["own scope", REV_OWN_AUTH, REV_OWN_APP],
      ["no scope", REV_NONE_AUTH, REV_NONE_APP],
      ["all scope without change_review", ALL_NO_CAP_AUTH, ALL_NO_CAP_APP],
    ]) {
      const queue = await listRequests(db, auth, app);
      assert.deepEqual(queue.requests, [], label + " must not see the reviewer queue");
      await assert.rejects(
        () => db.query(
          "select public.direct_entry_read_change_request($1::uuid,$2::uuid,$3::uuid) as data",
          [auth, app, request.request_id]),
        (error) => error.code === "P0002",
        label + " must not read the request detail");
    }

    // The proposer leg is unchanged: the assigned manager still sees their request.
    const proposer = await listRequests(db, PM_AUTH, PM_APP);
    assert.deepEqual(proposer.requests.map((row) => row.request_id), [request.request_id]);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. No direct mutation on SUBMITTED, even for a fully privileged reviewer.
// ---------------------------------------------------------------------------
test("W05: every direct mutation path is denied on SUBMITTED with zero residue", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const submitted = await addEntry(db, {
      payment: { state: "provided", account_number: "012345678901", bank_id: null,
        account_holder_name: "W05 Holder" },
    });
    const draft = await addEntry(db, { state: "DRAFT", workDate: "2026-10-02" });

    // ADMIN holds payment_edit + employment_status.apply + entry_privileged_edit +
    // entry_admin at all scope: the strongest direct-mutation actor that exists.
    const before = await snapshot(db);
    const submittedBefore = await db.query(
      "select version, worker_details, project_id, recruiter_id from public.direct_entries" +
      " where entry_id = $1::uuid", [submitted.entry]);
    const paymentBefore = await db.query(
      "select state, account_number, version from public.direct_entry_payments where entry_id = $1::uuid",
      [submitted.entry]);

    const probes = [
      ["update_payment",
        "select public.direct_entry_update_payment($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::integer,$6::jsonb,$7::text,$8::text)",
        [ADMIN_AUTH, ADMIN_APP, submitted.entry, 1, 1,
          JSON.stringify({ state: "provided", account_number: "999999999999", bank_id: null,
            account_holder_name: "W05 Forged" }), "W05 forged payment", "w05-probe-payment"]],
      ["apply_employment_status",
        "select public.direct_entry_apply_employment_status($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::date,$7::text,$8::text,$9::text)",
        [ADMIN_AUTH, ADMIN_APP, submitted.entry, 1, "OFF", "2026-10-01", "W05 synthetic leave",
          "W05 forged status", "w05-probe-status"]],
      ["correct_latest_status",
        "select public.direct_entry_correct_latest_status($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::integer,$6::text,$7::date,$8::text,$9::text,$10::text)",
        [ADMIN_AUTH, ADMIN_APP, submitted.entry, 1, 2, "ON", "2026-10-01", null,
          "W05 forged correction", "w05-probe-correct"]],
      ["transition_submission",
        "select public.direct_entry_transition_submission($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text)",
        [ADMIN_AUTH, ADMIN_APP, submitted.submission, 3, "DRAFT", "w05-probe-transition"]],
    ];
    for (const [label, sql, params] of probes) {
      await assert.rejects(() => db.query(sql, params),
        (error) => error.code === "42501", label + " must be denied on SUBMITTED");
    }
    // P2.5-HF-R3 deliberately opens ONE of these paths for Admin/BoD on SUBMITTED data.
    // It is asserted in its own test at the end of this file so the residue checks above
    // keep describing the paths that stay closed.

    // Draft-only RPCs cannot reach a SUBMITTED row either.
    for (const [label, sql, params] of [
      ["update_draft_row",
        "select public.direct_entry_update_draft_row($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::jsonb,$6::text)",
        [ADMIN_AUTH, ADMIN_APP, submitted.entry, 1,
          JSON.stringify({ labor_type: "PERMANENT" }), "w05-probe-draft-update"]],
      ["delete_draft_row",
        "select public.direct_entry_delete_draft_row($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text)",
        [ADMIN_AUTH, ADMIN_APP, submitted.entry, 1, "w05-probe-draft-delete"]],
      ["create_draft_row",
        "select public.direct_entry_create_draft_row($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::jsonb,$6::text)",
        [ADMIN_AUTH, ADMIN_APP, submitted.submission, 3,
          JSON.stringify({ project_id: PROJ_A, first_work_date: "2026-10-03",
            employee_code: "hrp-2026-399999", recruiter_id: REC_PM, labor_type: "TEMPORARY",
            worker_details: { display_name: "W05 Worker draft",
              date_of_birth: { state: "unknown" }, national_id: { state: "unknown" },
              address: { state: "unknown" }, phone: { state: "unknown" } } }),
          "w05-probe-draft-create"]],
    ]) {
      await assert.rejects(() => db.query(sql, params),
        (error) => error.code === "42501", label + " must be denied on a SUBMITTED submission");
    }

    assert.deepEqual(await snapshot(db), before,
      "no denied direct mutation may add a revision, audit row, status event or version bump");
    assert.deepEqual(
      (await db.query("select version, worker_details, project_id, recruiter_id" +
        " from public.direct_entries where entry_id = $1::uuid", [submitted.entry])).rows[0],
      submittedBefore.rows[0]);
    assert.deepEqual(
      (await db.query("select state, account_number, version from public.direct_entry_payments" +
        " where entry_id = $1::uuid", [submitted.entry])).rows[0],
      paymentBefore.rows[0], "the forged payment never reached the row");

    // DRAFT is unchanged: the owner can still edit their draft row.
    const draftEdit = await db.query(
      "select public.direct_entry_update_draft_row($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::jsonb,$6::text) as data",
      [UPLOADER_AUTH, UPLOADER_APP, draft.entry, 1,
        JSON.stringify({ labor_type: "PERMANENT" }), "w05-draft-ok"]);
    assert.equal(draftEdit.rows[0].data.version, 2, "DRAFT edits keep working");
    const submittedRevisions = (entryId) => count(db,
      "select count(*)::int as n from public.direct_entry_revisions where entry_id = $1::uuid",
      [entryId]);
    assert.equal(await submittedRevisions(submitted.entry), 0,
      "no denied probe wrote a canonical revision");

    // The approval engine is the only path that touches canonical SUBMITTED data.
    const afterDraft = await snapshot(db);
    const request = await propose(db, { entry: submitted.entry, key: "w05-request-3" });
    await decide(db, { requestId: request.request_id, auth: REV_ALL_AUTH, app: REV_ALL_APP,
      key: "w05-approve-3" });
    const after = await snapshot(db);
    assert.equal(after.revisions, afterDraft.revisions + 1, "one revision per applied request");
    assert.equal(after.versions, afterDraft.versions + 1, "one canonical version bump");
    assert.equal(await submittedRevisions(submitted.entry), 1);
    // The engine audits the proposal, the decision and the applied change once each
    // (existing behaviour, reused unchanged by W05).
    for (const action of ["change_request_create", "change_request_approved",
      "change_request_approve"]) {
      assert.equal(await count(db,
        "select count(*)::int as n from public.direct_entry_audit_events where action = $1",
        [action]), 1, action);
    }
    assert.equal(after.audits, afterDraft.audits + 3);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Reviewer bundle: declared, minimal, granted to nobody.
// ---------------------------------------------------------------------------
test("W05: the reviewer bundle stays minimal and grants nothing", async () => {
  const db = await buildDb();
  try {
    const bundle = (await db.query(
      "select public.direct_entry_reviewer_bundle_capabilities() as bundle")).rows[0].bundle;
    assert.deepEqual(bundle, ["change_review"]);
    for (const forbidden of ["payment_edit", "employment_status.apply", "document_view",
      "document_upload", "entry_privileged_edit", "pii_export", "entry_admin",
      "entry_create", "submission_create", "change_request_create"]) {
      assert.equal(bundle.includes(forbidden), false, forbidden + " must stay out of the bundle");
    }

    // The migration seeds no grant: every capability row in a seeded database comes
    // from the fixtures, and no account carries a bundle-only token it was not given.
    await seed(db);
    const stray = await count(db,
      "select count(*)::int as n from public.direct_entry_capability_grants" +
      " where capability = any($1::text[]) and app_user_id = any($2::uuid[])",
      [["pii_export", "document_view", "document_upload", "payment_edit"],
        [REV_ALL_APP, REV_TEAM_APP, REV_OWN_APP, REV_NONE_APP, ALL_NO_CAP_APP]]);
    assert.equal(stray, 0, "no reviewer fixture account received apply/export tokens");

    // Both helpers are private; server entry points expose the required behavior.
    for (const sql of [
      "public.direct_entry_reviewer_bundle_capabilities()",
      "public.direct_entry_has_scope(uuid, text)",
    ]) {
      for (const [role, expected] of [["service_role", false], ["anon", false],
        ["authenticated", false]]) {
        const ok = (await db.query(
          "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [role, sql])).rows[0].ok;
        assert.equal(ok, expected, sql + " vs " + role);
      }
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. The worker directory now serves the W04 propose authority.
// ---------------------------------------------------------------------------
test("W05: directory propose_change follows the assignment, not the placeholder", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await addEntry(db, { project: PROJ_A, recruiter: REC_PM, workDate: "2026-10-01" });
    await addEntry(db, { project: PROJ_B, recruiter: REC_B, workDate: "2026-10-02" });

    const page = async (auth, app, scope) => (await db.query(
      "select public.direct_entry_list_workers($1::uuid,$2::uuid,$3::text,null,null,null,null,null) as data",
      [auth, app, scope])).rows[0].data;

    const managed = await page(PM_AUTH, PM_APP, "managed");
    assert.equal(managed.items.length, 1);
    assert.equal(managed.items[0].project_id, PROJ_A);
    assert.equal(managed.items[0].is_project_manager, true);
    assert.deepEqual(managed.items[0].allowed_actions, {
      view: true, view_pii: true, view_payment: true,
      direct_edit: true,
      propose_change: true, propose_change_code: null,
    }, "the assigned manager may propose and receives the server-projected direct-edit action");

    for (const [auth, app, scope] of [[ADMIN_AUTH, ADMIN_APP, "all"],
      [REV_ALL_AUTH, REV_ALL_APP, "all"]]) {
      const adminPage = await page(auth, app, scope);
      assert.equal(adminPage.items.every((row) => row.is_project_manager === false), true);
      assert.equal(adminPage.items.every(
        (row) => row.allowed_actions.propose_change === false), true);
      assert.equal(adminPage.items.every(
        (row) => row.allowed_actions.propose_change_code === "NOT_PROJECT_MANAGER"), true,
      "a non-manager sees the stable denial code, never the W04 placeholder");
    }

    // propose_change is per-ROW authority: the same manager sees the same action on
    // the recruiter-scoped view of their own row.
    const recruited = await page(PM_AUTH, PM_APP, "recruited");
    assert.deepEqual(recruited.items.map((row) => row.project_id), [PROJ_A]);
    assert.equal(recruited.items[0].allowed_actions.propose_change, true);

    // A non-manager never gets the action, and the denial code is stable.
    const adminPage = await page(ADMIN_AUTH, ADMIN_APP, "all");
    const projB = adminPage.items.find((row) => row.project_id === PROJ_B);
    assert.equal(projB.is_project_manager, false);
    assert.equal(projB.allowed_actions.propose_change, false);
    assert.equal(projB.allowed_actions.propose_change_code, "NOT_PROJECT_MANAGER");
    await assert.rejects(
      () => page(REV_NONE_AUTH, REV_NONE_APP, "all"),
      (error) => error.code === "42501",
      "no all scope means no directory page");
  } finally {
    await db.close();
  }
});
// ---------------------------------------------------------------------------
// 6. R1 matrix: the reviewer bundle decides every opened target kind.
// ---------------------------------------------------------------------------
test("W05-R1: the reviewer bundle decides ENTRY_FIELD, PAYMENT and WORK_STATUS without apply tokens", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const entryField = await addEntry(db, { workDate: "2026-10-01" });
    const payment = await addEntry(db, { workDate: "2026-10-02" });
    const status = await addEntry(db, { workDate: "2026-10-03" });
    const documentEntry = await addEntry(db, { workDate: "2026-10-04" });

    // A WORK_STATUS proposal needs a real status history to transition from.
    const reasonId = (await db.query(
      "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
      " values ($1,'W05-R1 initial status') returning reason_id::text as id",
      [UPLOADER_APP])).rows[0].id;
    await db.query(
      "insert into public.direct_entry_employment_status_events" +
      " (entry_id, status, effective_date, version, actor_user_id, reason_id)" +
      " values ($1,'UNCONFIRMED','2026-10-03'::date,1,$2,$3)",
      [status.entry, UPLOADER_APP, reasonId]);

    const bundleCapabilities = (await db.query(
      "select array_agg(capability order by capability) as caps from" +
      " public.direct_entry_capability_grants where app_user_id = $1::uuid", [REV_BUNDLE_APP])).rows[0].caps;
    assert.deepEqual(bundleCapabilities, ["change_review"],
      "the deciding reviewer holds no PII/payment-specific capability");

    // ENTRY_FIELD with worker_details: change_review and all scope.
    const entryRequest = await propose(db, { entry: entryField.entry, key: "w05r1-entry" });
    const entryApproved = await decide(db, { requestId: entryRequest.request_id,
      auth: REV_BUNDLE_AUTH, app: REV_BUNDLE_APP, key: "w05r1-entry-approve" });
    assert.equal(entryApproved.state, "APPROVED");

    // PAYMENT: change_review and all scope, with no payment-specific capability.
    const paymentRequest = await propose(db, { entry: payment.entry, key: "w05r1-payment",
      targetKind: "PAYMENT", proposal: { state: "provided", account_number: "012345678901",
        bank_id: null, account_holder_name: "W05-R1 Holder" } });
    const paymentApproved = await decide(db, { requestId: paymentRequest.request_id,
      auth: REV_BUNDLE_AUTH, app: REV_BUNDLE_APP, key: "w05r1-payment-approve" });
    assert.equal(paymentApproved.state, "APPROVED");
    const storedPayment = await db.query(
      "select state, account_number, version from public.direct_entry_payments" +
      " where entry_id = $1::uuid", [payment.entry]);
    assert.deepEqual(storedPayment.rows[0],
      { state: "provided", account_number: "012345678901", version: 1 },
      "the approval engine applied the payment without a payment_edit holder");

    // WORK_STATUS: change_review only, no employment_status.apply anywhere in the bundle.
    const statusRequest = await propose(db, { entry: status.entry, key: "w05r1-status",
      targetKind: "WORK_STATUS", proposal: { status: "OFF", effective_date: "2026-10-04",
        leave_reason: "W05-R1 synthetic leave" } });
    const statusApproved = await decide(db, { requestId: statusRequest.request_id,
      auth: REV_BUNDLE_AUTH, app: REV_BUNDLE_APP, key: "w05r1-status-approve" });
    assert.equal(statusApproved.state, "APPROVED");
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_employment_status_events" +
      " where entry_id = $1::uuid and status = 'OFF'", [status.entry]), 1);

    // Missing capabilities still deny per target kind, and the denial is evaluated
    // before the request state so nothing is mutated.
    const probeRequest = await propose(db, { entry: payment.entry, expectedVersion: 2,
      key: "w05r1-probe", targetKind: "PAYMENT",
      proposal: { state: "unknown", account_number: null, bank_id: null, account_holder_name: null } });
    const noChangeReview = await decide(db, { requestId: probeRequest.request_id,
      auth: ALL_NO_CAP_AUTH, app: ALL_NO_CAP_APP, key: "w05r1-no-cap" }).catch((error) => error);
    assert.equal(noChangeReview.code, "42501", "all scope without change_review is refused");
    const noAllScope = await decide(db, { requestId: probeRequest.request_id,
      auth: REV_TEAM_AUTH, app: REV_TEAM_APP, key: "w05r1-no-scope" }).catch((error) => error);
    assert.equal(noAllScope.code, "42501", "change_review without all scope is refused");
    const noPaymentView = await decide(db, { requestId: probeRequest.request_id,
      auth: REV_ALL_AUTH, app: REV_ALL_APP, key: "w05r1-no-pv" }).catch((error) => error);
    assert.equal(noPaymentView.state, "APPROVED",
      "an all-scope reviewer with change_review may decide PAYMENT without payment_view");
    const probeState = await db.query(
      "select state, version from public.direct_entry_change_requests where request_id = $1::uuid",
      [probeRequest.request_id]);
    assert.deepEqual(probeState.rows[0], { state: "APPROVED", version: 2 },
      "only the reviewer without change_review and the out-of-scope reviewer are refused");

    // An all-scope reviewer without any PII/payment grant can still review worker fields.
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)" +
      " values ($1,'all','2020-01-01',true)", [REV_NONE_APP]);
    const noPiiViewRequest = await propose(db, { entry: documentEntry.entry, expectedVersion: 1,
      key: "w05r1-no-pii" });
    const noPiiView = await decide(db, { requestId: noPiiViewRequest.request_id,
      auth: REV_NONE_AUTH, app: REV_NONE_APP, key: "w05r1-no-pii-approve" });
    assert.equal(noPiiView.state, "APPROVED",
      "an all-scope reviewer with change_review may decide worker fields without pii_view");

    // DOCUMENT stays closed to the W05 lane: the target cannot even be proposed, and the
    // matrix keeps its own document capabilities for any legacy item.
    await assert.rejects(
      () => propose(db, { entry: documentEntry.entry, key: "w05r1-document",
        targetKind: "DOCUMENT", proposal: { document_type: "EMPLOYMENT_CONTRACT",
          idempotency_key: "w05r1-doc", checksum_sha256: "a".repeat(64), size_bytes: 2048,
          mime_type: "application/pdf" } }),
      (error) => error.code === "23514" || error.code === "42501",
      "a DOCUMENT proposal is refused by policy");
    const matrixSource = (await db.query(
      "select p.prosrc as src from pg_proc p" +
      " where p.oid = 'public.direct_entry_change_request_required_capabilities(uuid)'::regprocedure"
    )).rows[0].src;
    assert.equal(matrixSource.includes("document_view"), true,
      "DOCUMENT keeps its existing capability requirement");
    assert.equal(matrixSource.includes("document_upload"), true);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 7. R1 finding 2: an unappliable worker_details is refused at CREATE.
// ---------------------------------------------------------------------------
test("W05-R1: an unappliable worker_details proposal is refused before any request exists", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const { entry } = await addEntry(db, {});
    const stored = (await db.query(
      "select worker_details from public.direct_entries where entry_id = $1::uuid",
      [entry])).rows[0].worker_details;
    const before = await snapshot(db);

    for (const [index, workerDetails] of [
      { gender: "MALE" },
      { ...stored, national_id: { state: "provided" } },
      { ...stored, nope: 1 },
      { ...stored, phone: "0900000000" },
    ].entries()) {
      await assert.rejects(
        () => propose(db, { entry, key: "w05r1-bad-" + index,
          proposal: { worker_details: workerDetails } }),
        (error) => error.code === "22023",
        "proposal " + index + " must be refused at CREATE");
    }
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_change_requests"), 0,
    "no request row may survive a refused proposal");
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_change_request_items"), 0);
    assert.deepEqual(await snapshot(db), before,
      "a refused proposal leaves no reason, idempotency, audit or version trace");

    // The canonical shape is accepted and stays appliable end to end.
    const request = await propose(db, { entry, key: "w05r1-good",
      proposal: { worker_details: { ...stored, address: { state: "provided",
        value: "W05-R1 canonical address" } } } });
    const approved = await decide(db, { requestId: request.request_id,
      auth: REV_BUNDLE_AUTH, app: REV_BUNDLE_APP, key: "w05r1-good-approve" });
    assert.equal(approved.state, "APPROVED");
    const applied = (await db.query(
      "select version, worker_details->'address'->>'value' as address" +
      " from public.direct_entries where entry_id = $1::uuid", [entry])).rows[0];
    assert.deepEqual(applied, { version: 2, address: "W05-R1 canonical address" });
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// P2.5-HF-R3: the privileged correction path is the deliberate exception.
// ---------------------------------------------------------------------------
test("R3: the privileged correction path applies to SUBMITTED while the other paths stay closed", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const editorAuth = uuid(60), editorApp = uuid(61);
    await insertActor(db, editorAuth, editorApp, ["entry_privileged_edit"], "all");
    const entryRef = await addEntry(db, {});
    const version = (await db.query(
      "select version from public.direct_entries where entry_id = $1::uuid",
      [entryRef.entry])).rows[0].version;
    // A DRAFT-only path is still refused, so the exception is specific.
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_update_payment(" +
        "$1::uuid,$2::uuid,$3::uuid,$4::integer,$5::integer,$6::jsonb,$7::text,$8::text)",
        [editorAuth, editorApp, entryRef.entry, version, 1,
          JSON.stringify({ state: "unknown" }), "R3 payment", "w05-r3-payment"]),
      (error) => error.code === "42501",
      "the payment path stays change-request only on SUBMITTED");
    const edited = await db.query(
      "select public.direct_entry_privileged_edit(" +
      "$1::uuid,$2::uuid,$3::uuid,$4::integer,$5::jsonb,$6::text,$7::text) as data",
      [editorAuth, editorApp, entryRef.entry, version,
        JSON.stringify({ labor_type: "PERMANENT" }), "R3 correction", "w05-r3-edit"]);
    assert.equal(edited.rows[0].data.version, version + 1);
    assert.deepEqual((await db.query(
      "select labor_type, version from public.direct_entries where entry_id = $1::uuid",
      [entryRef.entry])).rows, [{ labor_type: "PERMANENT", version: version + 1 }]);
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_revisions where entry_id = $1::uuid",
      [entryRef.entry]), 1);
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_audit_events where resource_ref = $1",
      [entryRef.entry]), 1);
  } finally {
    await db.close();
  }
});
