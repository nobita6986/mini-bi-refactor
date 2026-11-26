/**
 * P2.5-HF-R1 - episode invariant tren duong ghi trang thai + lookup co gioi han.
 *
 * Finding 1: #58 chi giu invariant "mot CCCD chi co toi da mot episode khac OFF" khi
 * INSERT/UPDATE direct_entries.worker_details. Migration #59 chuyen invariant sang
 * direct_entry_employment_status_events - diem ghi chung cua moi duong trang thai
 * (direct_entry_apply_employment_status, direct_entry_correct_latest_status va apply
 * WORK_STATUS cua change request). Regression bat buoc: episode cu OFF + episode moi ON,
 * roi duyet OFF->ON tren episode cu => bi tu choi nguyen tu (khong partial canonical/
 * version/audit), va khong duoc dung de thay cho ho so moi.
 *
 * Finding 2: lookup nhan ten HOAC CCCD (co the ca hai), bounded/paginated, CCCD exact
 * match giu so 0 dau, khong tra CCCD day du/PII/ngan hang/tai lieu, khong phai danh ba
 * toan cuc, va chi manager co assignment hieu luc o project dich (hoac all-scope admin).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const R1_MIGRATION = "20261008190000_p2_5_hf_r1_episode_status_guard_and_lookup_boundary.sql";
const R2_MIGRATION = "20261008200000_p2_5_hf_r2_cccd_canonicalization_guard.sql";
const R3_MIGRATION = "20261008210000_p2_5_hf_r3_worker_full_correction.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "hf_proj_a", PROJ_B = "hf_proj_b";
const REC_A = uuid(21), REC_D = uuid(24), REC_RECRUITER = uuid(25);
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const MGR_A_AUTH = uuid(32), MGR_A_APP = uuid(42);
const MGR_C_AUTH = uuid(34), MGR_C_APP = uuid(44);
const STATUS_AUTH = uuid(37), STATUS_APP = uuid(47);
const REV_AUTH = uuid(38), REV_APP = uuid(48);
const UPLOADER_AUTH = uuid(35), UPLOADER_APP = uuid(45);
const RECRUITER_AUTH = uuid(36), RECRUITER_APP = uuid(46);

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
  assert.equal(names.indexOf(R2_MIGRATION), 59, "P2.5-HF-R2 remains #60");
  assert.equal(names.indexOf(R1_MIGRATION), 58, "P2.5-HF-R1 remains #59");
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

async function assignManager(db, { project, recruiter, app }) {
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)",
    [app, recruiter]);
  await db.query(
    "insert into public.direct_entry_project_manager_assignments" +
    " (project_id, manager_recruiter_id, valid_from, is_current)" +
    " values ($1,$2,'2020-01-01',true)", [project, recruiter]);
}

async function seed(db) {
  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_R1','Team R1')", [TEAM]);
  for (const [project, name] of [[PROJ_A, "Project R1 A"], [PROJ_B, "Project R1 B"]]) {
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)",
      [project, name]);
  }
  for (const [recruiter, name] of [[REC_A, "Recruiter A"], [REC_D, "Recruiter D"],
    [REC_RECRUITER, "Recruiter Attribution"]]) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1,$2)", [recruiter, name]);
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
      " values ($1,'hrp','2020-01-01',true)", [recruiter]);
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [recruiter, TEAM]);
  }
  await insertActor(db, ADMIN_AUTH, ADMIN_APP,
    ["entry_admin", "entry_create", "submission_create", "payment_view", "payment_edit",
      "employment_status.apply", "change_request_create"], "all");
  // The status path needs exactly one effective scope grant, so this actor carries only 'all'.
  await insertActor(db, STATUS_AUTH, STATUS_APP,
    ["employment_status.apply", "change_request_create"], "all");
  await insertActor(db, REV_AUTH, REV_APP, ["change_review", "pii_view"], "all");
  await insertActor(db, MGR_A_AUTH, MGR_A_APP, ["change_request_create"]);
  await insertActor(db, MGR_C_AUTH, MGR_C_APP, ["change_request_create"]);
  await insertActor(db, UPLOADER_AUTH, UPLOADER_APP,
    ["entry_create", "submission_create", "change_request_create"], "own");
  await insertActor(db, RECRUITER_AUTH, RECRUITER_APP, ["change_request_create"]);
  await assignManager(db, { project: PROJ_A, recruiter: REC_A, app: MGR_A_APP });
  await assignManager(db, { project: PROJ_B, recruiter: REC_D, app: MGR_C_APP });
  // This actor manages only project B and never the lookup target project A.
  await assignManager(db, { project: PROJ_B, recruiter: REC_RECRUITER, app: RECRUITER_APP });
}

function workerDetails(cccd) {
  return {
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: cccd === null ? { state: "unknown" } : { state: "provided", value: cccd },
    address: { state: "provided", value: "R1 address" },
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

async function state(db) {
  return {
    entries: await count(db, "select count(*)::int as n from public.direct_entries"),
    statusEvents: await count(db, "select count(*)::int as n from public.direct_entry_employment_status_events"),
    audits: await count(db, "select count(*)::int as n from public.direct_entry_audit_events"),
    idempotency: await count(db, "select count(*)::int as n from public.direct_entry_rpc_idempotency"),
    reasons: await count(db, "select count(*)::int as n from public.direct_entry_restricted_reasons"),
  };
}

/** One episode for a CCCD, inserted directly so its history is exactly the case under test. */
let episodeSeq = 0;
async function seedEpisode(db, { cccd, name, project = PROJ_A, date = "2026-01-05", status, draft = false }) {
  episodeSeq += 1;
  const candidate = uuid(2000 + episodeSeq), submission = uuid(3000 + episodeSeq);
  const entry = uuid(4000 + episodeSeq);
  const code = "hrp-2026-" + String(800000 + episodeSeq);
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
        JSON.stringify({ display_name: name, ...workerDetails(cccd) }), REC_A, TEAM]);
    if (!draft) {
      await seedLegacyReviewSubmission(db, submission);
      await db.query(
        "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
        [submission]);
    }
    const steps = status === "OFF" ? ["ON", "OFF"] : status === null ? [] : [status];
    if (steps.length > 0) {
      const reasonId = (await db.query(
        "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
        " values ($1,'R1 episode status') returning reason_id::text as id", [ADMIN_APP])).rows[0].id;
      for (const [index, step] of steps.entries()) {
        await db.query(
          "insert into public.direct_entry_employment_status_events" +
          " (entry_id, status, effective_date, leave_date, leave_reason_text, version," +
          " actor_user_id, reason_id)" +
          " values ($1,$2,$3::date, case when $2 = 'OFF' then $3::date else null end," +
          " case when $2 = 'OFF' then 'R1 synthetic leave' else null end, $4,$5,$6)",
          [entry, step, date, index + 1, ADMIN_APP, reasonId]);
      }
    }
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return { entryId: entry, employeeCode: code };
}

/** WORK_STATUS change request against one episode. */
async function proposeWorkStatus(db, { entry, version, status = "ON", date = "2026-05-01" }) {
  const res = await db.query(
    "select public.direct_entry_create_change_request($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::text) as data",
    [MGR_A_AUTH, MGR_A_APP, JSON.stringify([{
      entry_id: entry, target_kind: "WORK_STATUS", expected_version: version,
      proposal: { status, effective_date: date },
    }]), "R1 synthetic status request", idemKey()]);
  return res.rows[0].data.request_id;
}

async function approve(db, requestId, version = 1) {
  return db.query(
    "select public.direct_entry_decide_change_request($1::uuid,$2::uuid,$3::uuid,$4::integer," +
    "$5::text,$6::text,$7::text) as data",
    [REV_AUTH, REV_APP, requestId, version, "APPROVED", "R1 synthetic approval", idemKey()]);
}

async function entryVersion(db, entryId) {
  return (await db.query(
    "select version from public.direct_entries where entry_id = $1::uuid", [entryId])).rows[0].version;
}

async function latestStatusVersion(db, entryId) {
  return count(db,
    "select coalesce(max(version),0)::int as n from public.direct_entry_employment_status_events" +
    " where entry_id = $1::uuid", [entryId]);
}

// ---------------------------------------------------------------------------
// 1. Status-event path keeps the invariant and refuses to reopen an old episode.
// ---------------------------------------------------------------------------
test("R1: approving OFF->ON on an older episode is refused atomically", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const old = await seedEpisode(db, { cccd: "400000000001", name: "R1 Rehire",
      project: PROJ_A, date: "2026-01-05", status: "OFF" });
    const fresh = await seedEpisode(db, { cccd: "400000000001", name: "R1 Rehire",
      project: PROJ_B, date: "2026-03-05", status: "ON" });

    const beforeVersion = await entryVersion(db, old.entryId);
    // Layer 1: direct status mutation is DRAFT-only (W04 #53), so a submitted episode can
    // only move through the change-request engine.
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_apply_employment_status(" +
        "$1::uuid,$2::uuid,$3::uuid,$4::int,$5::text,$6::date,$7::text,$8::text,$9::text) as data",
        [STATUS_AUTH, STATUS_APP, old.entryId, beforeVersion, "ON", "2026-05-01", null,
          "R1 reopen old episode", idemKey()]),
      (error) => error.code === "42501");

    // Layer 2: approving WORK_STATUS OFF->ON on the older episode is refused on the
    // status-event path. P3.1-HF removed the cross-episode canonical-CCCD conflict, so the
    // only refusal left here is the append-only one: an episode whose latest event is OFF is
    // never reopened, and a return to work is a new profile.
    const requestId = await proposeWorkStatus(db, { entry: old.entryId, version: beforeVersion });
    const before = await state(db);
    await assert.rejects(
      () => approve(db, requestId),
      (error) => {
        assert.equal(error.code, "23505", "the status path must fail closed");
        // P3.1-HF: the cross-episode canonical-CCCD conflict is gone, so the append-only
        // reopen rule is the only stable safe message left on this path.
        assert.ok(error.message.includes("worker_episode_reopen_forbidden"),
          "stable safe message expected, got: " + error.message);
        assert.equal(error.message.includes("400000000001"), false, "no CCCD in the error");
        return true;
      });
    assert.deepEqual(await state(db), before, "canonical/version/audit must not be partial");
    assert.equal(await entryVersion(db, old.entryId), beforeVersion, "entry version unchanged");
    assert.equal(await latestStatusVersion(db, old.entryId), 2, "no status event was appended");
    assert.equal(await entryVersion(db, fresh.entryId), 1, "the newer episode is untouched");
    assert.deepEqual((await db.query(
      "select state, version from public.direct_entry_change_requests where request_id = $1::uuid",
      [requestId])).rows, [{ state: "PENDING", version: 1 }],
    "the refused approval leaves no half-recorded decision");
  } finally {
    await db.close();
  }
});

test("R1: a closed episode is never reopened through the append-only path", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const first = await seedEpisode(db, { cccd: "400000000002", name: "R1 Reopen",
      project: PROJ_A, date: "2026-01-05", status: "OFF" });
    await seedEpisode(db, { cccd: "400000000002", name: "R1 Reopen",
      project: PROJ_A, date: "2026-02-05", status: "OFF" });
    // Both episodes are OFF, so the invariant alone would allow this: the reopen rule is
    // what refuses to let a closed episode stand in for a new profile.
    const requestId = await proposeWorkStatus(db, { entry: first.entryId,
      version: await entryVersion(db, first.entryId) });
    const before = await state(db);
    await assert.rejects(() => approve(db, requestId), (error) => error.code === "23505");
    assert.deepEqual(await state(db), before);

    // The dedicated correction path supersedes the event it fixes instead of reopening a
    // closed episode, so it keeps working on a draft episode.
    const draftEpisode = await seedEpisode(db, { cccd: "400000000003", name: "R1 Draft",
      project: PROJ_A, date: "2026-01-05", status: "OFF", draft: true });
    const correctEntryVersion = await entryVersion(db, draftEpisode.entryId);
    const correctStatusVersion = await latestStatusVersion(db, draftEpisode.entryId);
    const corrected = await db.query(
      "select public.direct_entry_correct_latest_status(" +
      "$1::uuid,$2::uuid,$3::uuid,$4::int,$5::int,$6::text,$7::date,$8::text,$9::text,$10::text) as data",
      // A correction must carry the effective date of the event it supersedes.
      [STATUS_AUTH, STATUS_APP, draftEpisode.entryId, correctEntryVersion, correctStatusVersion,
        "ON", "2026-01-05", null, "R1 correct erroneous departure", idemKey()]);
    assert.equal(corrected.rows[0].data.status, "ON");
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_employment_status_events" +
      " where entry_id = $1::uuid and supersedes_event_id is not null", [draftEpisode.entryId]), 1,
    "the correction supersedes instead of reopening");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Bounded lookup: name OR exact CCCD, paginated, minimum fields only.
// ---------------------------------------------------------------------------
test("R1: the lookup accepts a name or an exact CCCD and stays bounded", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const older = await seedEpisode(db, { cccd: "012345678901", name: "R1 Padded",
      project: PROJ_A, date: "2026-01-05", status: "OFF" });
    const newer = await seedEpisode(db, { cccd: "012345678901", name: "R1 Padded",
      project: PROJ_B, date: "2026-04-05", status: "OFF" });
    for (const [index, cccd] of ["500000000001", "500000000002", "500000000003"].entries()) {
      await seedEpisode(db, { cccd, name: "R1 Common", project: PROJ_A,
        date: "2026-02-0" + (index + 1), status: "OFF" });
    }
    await seedEpisode(db, { cccd: "600000000001", name: "R1 Other", project: PROJ_A,
      date: "2026-02-09", status: "OFF" });

    const LOOKUP = "select public.direct_entry_lookup_worker_episodes(" +
      "$1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::int,$7::int) as data";
    const lookup = async (auth, app, project, query = {}) => (await db.query(LOOKUP, [
      auth, app, project, query.name ?? null, query.cccd ?? null,
      query.pageSize ?? 20, query.offset ?? 0])).rows[0].data;

    // CCCD only, with formatting characters and a leading zero preserved as text.
    const byId = await lookup(MGR_A_AUTH, MGR_A_APP, PROJ_A, { cccd: "0123 456 78901" });
    assert.equal(byId.match, "national_id");
    assert.equal(byId.workers.length, 1);
    assert.equal(byId.workers[0].episode_count, 2, "the whole episode history is visible");
    assert.deepEqual(byId.workers[0].episodes.map((e) => e.entry_id).sort(),
      [older.entryId, newer.entryId].sort());
    assert.equal(byId.workers[0].active_episode_exists, false);
    assert.equal(byId.workers[0].rehire_allowed, true);

    // A different name must not hide the exact CCCD match.
    const mismatched = await lookup(MGR_A_AUTH, MGR_A_APP, PROJ_A,
      { cccd: "012345678901", name: "Ten Khac Han" });
    assert.equal(mismatched.workers.length, 1, "the CCCD stays authoritative");
    assert.equal(mismatched.workers[0].episodes.length, 2);

    // Name only, bounded to the target project; page_size/offset page the workers.
    const pageOne = await lookup(MGR_A_AUTH, MGR_A_APP, PROJ_A,
      { name: "R1 Common", pageSize: 2, offset: 0 });
    assert.equal(pageOne.match, "display_name");
    assert.equal(pageOne.workers.length, 2);
    assert.equal(pageOne.has_more, true);
    assert.equal(pageOne.page_size, 2);
    const pageTwo = await lookup(MGR_A_AUTH, MGR_A_APP, PROJ_A,
      { name: "R1 Common", pageSize: 2, offset: 2 });
    assert.equal(pageTwo.workers.length, 1, "the third worker is on page two");
    assert.equal(pageTwo.has_more, false);

    // A name search is never a global directory: project B does not know project A names.
    const crossProject = await lookup(MGR_C_AUTH, MGR_C_APP, PROJ_B, { name: "R1 Common" });
    assert.equal(crossProject.workers.length, 0, "name search stays inside the target project");

    // Minimum fields only, no CCCD and no other PII.
    // The match literal is the only place the words "national_id" may appear.
    const serialized = JSON.stringify(byId.workers);
    for (const forbidden of ["012345678901", "0123 456 78901", "1990-01-01", "R1 address",
      "0900000000", "account_number", "bank_name", "national_id", "date_of_birth", "phone"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden + " must never leak");
    }
    assert.deepEqual(Object.keys(byId.workers[0]).sort(), [
      "active_episode_exists", "display_name", "employee_code", "episode_count", "episodes",
      "rehire_allowed",
    ]);
    assert.deepEqual(Object.keys(byId.workers[0].episodes[0]).sort(), [
      "display_name", "employee_code", "entry_id", "first_work_date", "latest_status",
      "project_display", "project_id",
    ]);

    // Authority: manager of the target project only, or an all-scope administrator.
    for (const [label, auth, app] of [
      ["manager of another project", MGR_C_AUTH, MGR_C_APP],
      ["uploader", UPLOADER_AUTH, UPLOADER_APP],
      ["recruiter", RECRUITER_AUTH, RECRUITER_APP],
    ]) {
      await assert.rejects(() => lookup(auth, app, PROJ_A, { cccd: "012345678901" }),
        (error) => error.code === "42501", label);
    }
    const admin = await lookup(ADMIN_AUTH, ADMIN_APP, PROJ_A, { cccd: "012345678901" });
    assert.equal(admin.workers.length, 1);

    // Input validation fails closed before any database access decision.
    for (const [query, project] of [
      [{}, PROJ_A],
      [{ name: "R1 Common", pageSize: 51 }, PROJ_A],
      [{ name: "R1 Common", pageSize: 0 }, PROJ_A],
      [{ name: "R1 Common", offset: 5001 }, PROJ_A],
      [{ cccd: "abc" }, PROJ_A],
      [{ cccd: "12345" }, PROJ_A],
      [{ cccd: "012345678901" }, ""],
    ]) {
      await assert.rejects(() => lookup(MGR_A_AUTH, MGR_A_APP, project, query),
        (error) => error.code === "22023", JSON.stringify(query));
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Guards and ACLs.
// ---------------------------------------------------------------------------
test("R1: the status guard is a table-level trigger and stays internal", async () => {
  const db = await buildDb();
  try {
    const trigger = await db.query(
      "select tgname, tgtype from pg_trigger where tgrelid =" +
      " 'public.direct_entry_employment_status_events'::regclass and not tgisinternal");
    assert.ok(trigger.rows.map((row) => row.tgname).includes("direct_entry_episode_status_guard"),
      "the table-level status guard must exist");
    for (const signature of [
      "public.direct_entry_guard_episode_status_event()",
    ]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const ok = (await db.query(
          "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok",
          [role, signature])).rows[0].ok;
        assert.equal(ok, false, signature + " vs " + role);
      }
    }
    // P3.1-HF: the canonical-CCCD row guard and its trigger are dropped, never replaced.
    assert.equal(await count(db,
      "select count(*)::int as n from pg_proc where proname = 'direct_entry_guard_active_episode'"),
    0, "the duplicate-CCCD row guard function is gone");
    assert.equal(await count(db,
      "select count(*)::int as n from pg_trigger" +
      " where tgname = 'direct_entry_active_episode_guard'"),
    0, "the duplicate-CCCD row guard trigger is gone");
    const lookupAcl = await db.query(
      "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service," +
      " has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as authenticated",
      ["public.direct_entry_lookup_worker_episodes(uuid, uuid, text, text, text, integer, integer)"]);
    assert.equal(lookupAcl.rows[0].service, true);
    assert.equal(lookupAcl.rows[0].authenticated, false);
    const oldSignature = await db.query(
      "select to_regprocedure($1) as oid",
      ["public.direct_entry_lookup_worker_episodes(uuid,uuid,text,text,text)"]);
    assert.equal(oldSignature.rows[0].oid, null, "the unrestricted signature is gone");
  } finally {
    await db.close();
  }
});
