/**
 * P2.5-HF-R3 - sua toan bo truong ho so (PM de xuat) + Admin/BoD-Ke toan sua truc tiep.
 *
 * Policy T0 (R3):
 *   (1) PM co assignment hieu luc duoc de xuat thay doi qua workflow; R1.2 them direct edit
 *       chi trong du an dang duoc phan cong. Ho so ngoai du an van bi tu choi.
 *   (2) Admin (entry_admin + all) va BoD/Ke toan (entry_privileged_edit + all) duoc SUA TRUC TIEP
 *       ho so da gui, bat buoc reason + OCC + revision + audit bat bien. Submission dang REVIEW
 *       van bi khoa.
 *   (3) Giu employee/entry/project ID on dinh, khong hard-delete/sua lich su; trang thai chi doi
 *       qua status event; CCCD van 9/12 digits va giu invariant episode #58-#60.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const R3_MIGRATION = "20261008210000_p2_5_hf_r3_worker_full_correction.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11), TEAM_B = uuid(12);
const PROJ_A = "hf_proj_a", PROJ_B = "hf_proj_b";
const REC_A = uuid(21), REC_B = uuid(22), REC_C = uuid(23);
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const BOD_AUTH = uuid(32), BOD_APP = uuid(42);
const REVIEWER_AUTH = uuid(33), REVIEWER_APP = uuid(43);
const MGR_AUTH = uuid(34), MGR_APP = uuid(44);
const RECRUITER_AUTH = uuid(35), RECRUITER_APP = uuid(45);
const UPLOADER_AUTH = uuid(36), UPLOADER_APP = uuid(46);

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(R3_MIGRATION), 60, "P2.5-HF-R3 remains #61");
  return db;
}

async function insertActor(db, auth, app, capabilities, scopeKind = null) {
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
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [app, scopeKind]);
  }
}

async function seed(db) {
  for (const [team, code, name] of [[TEAM, "TEAM_R3", "Team R3"], [TEAM_B, "TEAM_R3B", "Team R3 B"]]) {
    await db.query(
      "insert into public.teams (team_id, code, display_name) values ($1,$2,$3)", [team, code, name]);
  }
  for (const [project, name] of [[PROJ_A, "Project R3 A"], [PROJ_B, "Project R3 B"]]) {
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)",
      [project, name]);
  }
  for (const [recruiter, name, team] of [[REC_A, "Recruiter A", TEAM], [REC_B, "Recruiter B", TEAM_B],
    [REC_C, "Recruiter C", TEAM]]) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1,$2)", [recruiter, name]);
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
      " values ($1,'hrp','2020-01-01',true)", [recruiter]);
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [recruiter, team]);
  }
  // Admin: entry_admin + entry_privileged_edit at all scope (the locked Admin bundle shape).
  await insertActor(db, ADMIN_AUTH, ADMIN_APP,
    ["entry_admin", "entry_privileged_edit", "entry_create", "submission_create", "change_review",
      "payment_view", "payment_edit"], "all");
  // BoD/Accounting bundle: change_review + entry_privileged_edit at all scope.
  await insertActor(db, BOD_AUTH, BOD_APP, ["change_review", "entry_privileged_edit"], "all");
  // Reviewer: change_review only - never entry_privileged_edit (W05 reviewed bundle).
  // W05 bundle: change_review always, plus pii_view when the item carries worker_details.
  await insertActor(db, REVIEWER_AUTH, REVIEWER_APP, ["change_review", "pii_view"], "all");
  // Manager: assignment authority only, no privileged capability and no scope grant.
  // A manager holds change_request_create plus pii_view (W05-R1: a worker_details
  // proposal needs pii_view), and gets project authority from the assignment only.
  await insertActor(db, MGR_AUTH, MGR_APP, ["change_request_create", "pii_view"]);
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)",
    [MGR_APP, REC_A]);
  await db.query(
    "insert into public.direct_entry_project_manager_assignments" +
    " (project_id, manager_recruiter_id, valid_from, is_current) values ($1,$2,'2020-01-01',true)", [PROJ_A, REC_A]);
  await insertActor(db, RECRUITER_AUTH, RECRUITER_APP, ["change_request_create"]);
  await insertActor(db, UPLOADER_AUTH, UPLOADER_APP, ["entry_create", "submission_create"], "own");
}

function workerDetails(cccd, name) {
  return {
    display_name: name,
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: { state: "provided", value: cccd },
    address: { state: "provided", value: "R3 address" },
    phone: { state: "provided", value: "0900000000" },
  };
}

let keySeq = 0;
function idemKey() {
  keySeq += 1;
  return "00000000-0000-4000-8000-" + String(keySeq).padStart(12, "0");
}

async function count(db, sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

async function residue(db) {
  return {
    entries: await count(db, "select count(*)::int as n from public.direct_entries"),
    versions: await count(db, "select coalesce(sum(version),0)::int as n from public.direct_entries"),
    revisions: await count(db, "select count(*)::int as n from public.direct_entry_revisions"),
    audits: await count(db, "select count(*)::int as n from public.direct_entry_audit_events"),
    idempotency: await count(db, "select count(*)::int as n from public.direct_entry_rpc_idempotency"),
    reasons: await count(db, "select count(*)::int as n from public.direct_entry_restricted_reasons"),
  };
}

let episodeSeq = 0;
async function seedEpisode(db, { cccd, name = "R3 Worker", project = PROJ_A, date = "2026-01-05",
  status = "ON", employeeCode = null, submissionState = "SUBMITTED" }) {
  episodeSeq += 1;
  const candidate = uuid(2000 + episodeSeq), submission = uuid(3000 + episodeSeq);
  const entry = uuid(4000 + episodeSeq);
  const code = employeeCode ?? "hrp-2026-" + String(800000 + episodeSeq);
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidate]);
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)" +
      " values ($1,$2,'DRAFT')", [submission, ADMIN_APP]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
      " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
      " provider_type, labor_type)" +
      " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY')",
      [entry, submission, candidate, ADMIN_APP, project, date, code,
        JSON.stringify(workerDetails(cccd, name)), REC_A, TEAM]);
    if (submissionState === "SUBMITTED" || submissionState === "REVIEW") {
      await seedLegacyReviewSubmission(db, submission);
      if (submissionState === "SUBMITTED") {
        await db.query(
          "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
          [submission]);
      }
    } else if (submissionState !== "DRAFT") {
      // Insert straight into the requested state: the submission transition trigger is not
      // the subject of this test.
      await db.query(
        "update public.direct_entry_submissions set state=$2, version=2 where submission_id=$1",
        [submission, submissionState]);
    }
    const steps = status === "OFF" ? ["ON", "OFF"] : status === null ? [] : [status];
    if (steps.length > 0) {
      const reasonId = (await db.query(
        "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
        " values ($1,'R3 episode status') returning reason_id::text as id", [ADMIN_APP])).rows[0].id;
      for (const [index, step] of steps.entries()) {
        await db.query(
          "insert into public.direct_entry_employment_status_events" +
          " (entry_id, status, effective_date, leave_date, leave_reason_text, version," +
          " actor_user_id, reason_id)" +
          " values ($1,$2,$3::date, case when $2 = 'OFF' then $3::date else null end," +
          " case when $2 = 'OFF' then 'R3 synthetic leave' else null end, $4,$5,$6)",
          [entry, step, date, index + 1, ADMIN_APP, reasonId]);
      }
    }
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return { entryId: entry, candidateId: candidate, submissionId: submission, employeeCode: code };
}

async function entryVersion(db, entryId) {
  return (await db.query(
    "select version from public.direct_entries where entry_id = $1::uuid", [entryId])).rows[0].version;
}

function edit(db, { auth, app, entryId, version, patch, reason = "R3 correction", key = idemKey() }) {
  return db.query(
    "select public.direct_entry_privileged_edit(" +
    "$1::uuid,$2::uuid,$3::uuid,$4::int,$5::jsonb,$6::text,$7::text) as data",
    [auth, app, entryId, version, JSON.stringify(patch), reason, key]);
}

async function propose(db, { entry, version, proposal, key = idemKey(), auth = MGR_AUTH, app = MGR_APP }) {
  return (await db.query(
    "select public.direct_entry_create_change_request($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text) as data",
    [auth, app, JSON.stringify([{
      entry_id: entry, target_kind: "ENTRY_FIELD", expected_version: version, proposal,
    }]), "R3 full-field proposal", key])).rows[0].data;
}

async function decide(db, { requestId, version = 1, decision = "APPROVED", auth = REVIEWER_AUTH,
  app = REVIEWER_APP, key = idemKey() }) {
  return db.query(
    "select public.direct_entry_decide_change_request($1::uuid,$2::uuid,$3::uuid,$4::integer," +
    "$5::text,$6::text,$7::text) as data",
    [auth, app, requestId, version, decision, "R3 synthetic decision", key]);
}

async function entryRow(db, entryId) {
  return (await db.query(
    "select project_id, first_work_date::text as first_work_date, employee_code," +
    " worker_details->>'display_name' as display_name, worker_details->'national_id'->>'value' as cccd," +
    " recruiter_id::text as recruiter_id, team_id::text as team_id, provider_type, labor_type," +
    " version, deleted_at, entry_id::text as entry_id, candidate_id::text as candidate_id," +
    " submission_id::text as submission_id" +
    " from public.direct_entries where entry_id = $1::uuid", [entryId])).rows[0];
}

// ---------------------------------------------------------------------------
// 1. Admin / BoD direct correction on a submitted worker.
// ---------------------------------------------------------------------------
test("R3: admin and BoD correct a submitted worker directly with reason/OCC/audit", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const seeded = await seedEpisode(db, { cccd: "700000000001", name: "R3 Before" });
    const version = await entryVersion(db, seeded.entryId);
    const key = idemKey();
    const result = await edit(db, {
      auth: ADMIN_AUTH, app: ADMIN_APP, entryId: seeded.entryId, version, key,
      patch: { employee_code: "hrp-2026-900777", labor_type: "PERMANENT",
        worker_details: workerDetails("700000000001", "R3 After") },
    });
    assert.equal(result.rows[0].data.version, version + 1);
    const row = await entryRow(db, seeded.entryId);
    assert.equal(row.employee_code, "hrp-2026-900777");
    assert.equal(row.labor_type, "PERMANENT");
    assert.equal(row.display_name, "R3 After", "display_name corrections apply directly");
    assert.equal(row.entry_id, seeded.entryId, "identity keys stay stable");
    assert.equal(row.candidate_id, seeded.candidateId);
    assert.equal(row.submission_id, seeded.submissionId);
    assert.equal(row.deleted_at, null, "nothing is deleted or soft-deleted");
    // reason + revision + immutable audit
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_revisions where entry_id = $1::uuid",
      [seeded.entryId]), 1);
    const audit = (await db.query(
      "select action, capability, outcome, scope_kind, changed_fields from public.direct_entry_audit_events" +
      " where resource_ref = $1", [seeded.entryId])).rows;
    assert.deepEqual(audit, [{
      action: "entry_privileged_edit", capability: "entry_privileged_edit", outcome: "APPLIED",
      scope_kind: "all", changed_fields: ["employee_code", "labor_type", "worker_details"],
    }]);
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_restricted_reasons" +
      " where reason_text = 'R3 correction'"), 1, "the reason is persisted");

    // Idempotent replay: same key, same payload, no second revision.
    const replay = await edit(db, {
      auth: ADMIN_AUTH, app: ADMIN_APP, entryId: seeded.entryId, version, key,
      patch: { employee_code: "hrp-2026-900777", labor_type: "PERMANENT",
        worker_details: workerDetails("700000000001", "R3 After") },
    });
    assert.equal(replay.rows[0].data.version, version + 1);
    assert.equal(await entryVersion(db, seeded.entryId), version + 1);
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_revisions where entry_id = $1::uuid",
      [seeded.entryId]), 1);

    // BoD/Accounting holds entry_privileged_edit at all scope and may correct too.
    const bod = await edit(db, {
      auth: BOD_AUTH, app: BOD_APP, entryId: seeded.entryId,
      version: await entryVersion(db, seeded.entryId), patch: { project_id: PROJ_B },
    });
    assert.equal(bod.rows[0].data.version, version + 2);
    assert.equal((await entryRow(db, seeded.entryId)).project_id, PROJ_B);
  } finally {
    await db.close();
  }
});

test("HF-F: privileged correction appends status atomically for Admin and BoD/Accounting", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const adminEntry = await seedEpisode(db, { cccd: "700000000011", name: "HF-F Admin" });
    const version = await entryVersion(db, adminEntry.entryId);
    const key = idemKey();
    const patch = {
      labor_type: "PERMANENT",
      employment_status: {
        status: "OFF", effective_date: "2026-10-13", leave_reason: "Đã nghỉ thực tế",
      },
    };
    const result = await edit(db, {
      auth: ADMIN_AUTH, app: ADMIN_APP, entryId: adminEntry.entryId, version, patch, key,
    });
    assert.equal(result.rows[0].data.version, version + 1);
    assert.deepEqual((await db.query(
      "select status, effective_date::text, leave_reason_text from " +
      "public.direct_entry_employment_status_events where entry_id=$1 order by version desc limit 1",
      [adminEntry.entryId])).rows[0], {
      status: "OFF", effective_date: "2026-10-13", leave_reason_text: "Đã nghỉ thực tế",
    });
    assert.equal((await entryRow(db, adminEntry.entryId)).labor_type, "PERMANENT");
    assert.deepEqual((await db.query(
      "select changed_fields from public.direct_entry_audit_events where resource_ref=$1",
      [adminEntry.entryId])).rows.at(-1).changed_fields, ["employment_status", "labor_type"]);

    await edit(db, {
      auth: ADMIN_AUTH, app: ADMIN_APP, entryId: adminEntry.entryId, version, patch, key,
    });
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_employment_status_events where entry_id=$1",
      [adminEntry.entryId]), 2, "idempotent replay must not append a second transition");

    const bodEntry = await seedEpisode(db, {
      cccd: "700000000012", name: "HF-F BoD", status: "UNCONFIRMED",
    });
    await edit(db, {
      auth: BOD_AUTH, app: BOD_APP, entryId: bodEntry.entryId,
      version: await entryVersion(db, bodEntry.entryId),
      patch: { employment_status: { status: "ON", effective_date: "2026-10-13" } },
    });
    assert.equal((await db.query(
      "select status from public.direct_entry_employment_status_events " +
      "where entry_id=$1 order by version desc limit 1", [bodEntry.entryId])).rows[0].status, "ON");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Actor matrix, stale OCC, REVIEW lock, zero residue.
// ---------------------------------------------------------------------------
test("R3: the direct correction actor matrix fails closed with zero residue", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const seeded = await seedEpisode(db, {
      cccd: "700000000002", name: "R3 Matrix", project: PROJ_B,
    });
    const version = await entryVersion(db, seeded.entryId);
    const patch = { labor_type: "PERMANENT" };
    for (const [label, auth, app, code] of [
      ["reviewer without entry_privileged_edit", REVIEWER_AUTH, REVIEWER_APP, "42501"],
      ["project manager", MGR_AUTH, MGR_APP, "42501"],
      ["recruiter", RECRUITER_AUTH, RECRUITER_APP, "42501"],
      ["uploader", UPLOADER_AUTH, UPLOADER_APP, "42501"],
    ]) {
      const before = await residue(db);
      await assert.rejects(
        () => edit(db, { auth, app, entryId: seeded.entryId, version, patch }),
        (error) => error.code === code, label);
      assert.deepEqual(await residue(db), before, label + " must leave zero residue");
    }
    // OCC: a stale expected version is refused and writes nothing.
    const before = await residue(db);
    await assert.rejects(
      () => edit(db, { auth: ADMIN_AUTH, app: ADMIN_APP, entryId: seeded.entryId,
        version: version + 5, patch }),
      (error) => error.code === "PT409");
    assert.deepEqual(await residue(db), before);
    // Unsupported/authority keys are refused: no status change and no forged authority.
    for (const bad of [{ employment_status: "OFF" }, { version: 99 }, { deleted_at: null },
      { app_user_id: uuid(41) }, { team_id: TEAM_B }, { provider_type: "vendor" }]) {
      await assert.rejects(
        () => edit(db, { auth: ADMIN_AUTH, app: ADMIN_APP, entryId: seeded.entryId,
          version, patch: bad }),
        (error) => error.code === "22023", JSON.stringify(bad));
    }
    assert.deepEqual(await residue(db), before);
    // A submission under review stays locked even for the admin bundle.
    const reviewing = await seedEpisode(db, { cccd: "700000000009", name: "R3 Reviewed",
      submissionState: "REVIEW" });
    const reviewingVersion = await entryVersion(db, reviewing.entryId);
    const beforeReview = await residue(db);
    await assert.rejects(
      () => edit(db, { auth: ADMIN_AUTH, app: ADMIN_APP, entryId: reviewing.entryId,
        version: reviewingVersion, patch }),
      (error) => error.code === "42501");
    assert.deepEqual(await residue(db), beforeReview);
    // Status is still event-only: the direct status RPC stays DRAFT-only.
    const beforeStatusProbe = await residue(db);
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_apply_employment_status(" +
        "$1::uuid,$2::uuid,$3::uuid,$4::int,$5::text,$6::date,$7::text,$8::text,$9::text)",
        [ADMIN_AUTH, ADMIN_APP, seeded.entryId, version, "OFF", "2026-05-01", "R3 leave",
          "R3 status", idemKey()]),
      (error) => error.code === "42501");
    assert.deepEqual(await residue(db), beforeStatusProbe);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Project manager proposes every business field; approval applies it.
// ---------------------------------------------------------------------------
test("R3: a manager proposes the full field set and the approval applies it", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const seeded = await seedEpisode(db, { cccd: "700000000003", name: "R3 Proposal" });
    const version = await entryVersion(db, seeded.entryId);
    const proposal = {
      project_id: PROJ_B,
      first_work_date: "2026-02-01",
      employee_code: "hrp-2026-900888",
      recruiter_id: REC_B,
      labor_type: "PERMANENT",
      worker_details: workerDetails("700000000003", "R3 Proposed Name"),
    };
    const request = await propose(db, { entry: seeded.entryId, version, proposal });
    assert.ok(request.request_id, "the full business field set is proposable now");
    // No self-review: the proposer cannot decide their own request.
    await assert.rejects(
      () => decide(db, { requestId: request.request_id, auth: MGR_AUTH, app: MGR_APP }),
      (error) => error.code === "42501");
    const decision = await decide(db, { requestId: request.request_id });
    assert.ok(decision.rows[0].data);
    assert.deepEqual((await db.query(
      "select state, version from public.direct_entry_change_requests where request_id = $1::uuid",
      [request.request_id])).rows, [{ state: "APPROVED", version: 2 }]);
    const row = await entryRow(db, seeded.entryId);
    assert.equal(row.project_id, PROJ_B);
    assert.equal(row.first_work_date, "2026-02-01");
    assert.equal(row.employee_code, "hrp-2026-900888");
    assert.equal(row.labor_type, "PERMANENT");
    assert.equal(row.display_name, "R3 Proposed Name", "the name is no longer protected");
    assert.equal(row.recruiter_id, REC_B);
    assert.equal(row.team_id, TEAM_B, "team is re-derived from the new recruiter");
    assert.equal(row.provider_type, "hrp");
    assert.equal(row.version, version + 1);
    assert.equal(row.entry_id, seeded.entryId, "identity keys stay stable");
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_revisions where entry_id = $1::uuid",
      [seeded.entryId]), 1);
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_audit_events" +
      " where resource_ref = $1 and action = 'change_request_approve'", [seeded.entryId]), 1);
    // Unknown proposal keys are still refused.
    await assert.rejects(
      () => propose(db, { entry: seeded.entryId, version: row.version,
        proposal: { annual_leave_days: 12 } }),
      (error) => error.code === "22023");
    await assert.rejects(
      () => propose(db, { entry: seeded.entryId, version: row.version,
        proposal: { employee_code: "hrp-2026-900889", app_user_id: uuid(41) } }),
      (error) => error.code === "22023");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. CCCD rule and episode invariant on the direct correction path.
// ---------------------------------------------------------------------------
test("R3: the direct correction keeps the CCCD format rule and the append-only invariant", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const active = await seedEpisode(db, { cccd: "700000000004", name: "R3 Active" });
    const target = await seedEpisode(db, { cccd: "700000000005", name: "R3 Target" });
    const version = await entryVersion(db, target.entryId);
    const before = await residue(db);
    // A non canonical CMT/CCCD is refused by the write validator.
    for (const bad of ["7000 000005", "7000000000", "NOT-REAL"]) {
      await assert.rejects(
        () => edit(db, { auth: ADMIN_AUTH, app: ADMIN_APP, entryId: target.entryId, version,
          patch: { worker_details: workerDetails(bad, "R3 Target") } }),
        (error) => error.code === "23514", bad);
    }
    assert.deepEqual(await residue(db), before, "no partial write on a refused CCCD format");
    // P3.1-HF: reusing the CCCD of a still active episode is no longer refused by the
    // #58/#60 guard. The correction is written and the duplicate is reported, never blocked.
    const shared = await edit(db, { auth: ADMIN_AUTH, app: ADMIN_APP, entryId: target.entryId,
      version, patch: { worker_details: workerDetails("700000000004", "R3 Target") } });
    assert.equal(shared.rows[0].data.version, version + 1);
    assert.equal((await entryRow(db, target.entryId)).cccd, "700000000004");
    assert.equal(active.entryId !== target.entryId, true);
    // A free canonical CCCD is still accepted, leading zero preserved.
    const ok = await edit(db, { auth: ADMIN_AUTH, app: ADMIN_APP, entryId: target.entryId,
      version: version + 1, patch: { worker_details: workerDetails("012345678901", "R3 Target") } });
    assert.equal(ok.rows[0].data.version, version + 2);
    assert.equal((await entryRow(db, target.entryId)).cccd, "012345678901");
  } finally {
    await db.close();
  }
});
