/**
 * PRE-W2-HF-D2 - Active duplicate-CCCD reporting semantics (DB regression, PGlite over the
 * migration ledger).
 *
 * Duplicate reporting is limited to the same canonical CCCD, project and first-work date.
 * Subsequent forward-only migrations include live UNCONFIRMED episodes and retain matching
 * non-deleted, non-voided clusters after OFF transitions; unrelated rehires stay excluded.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const D2_MIGRATION = "20261013140000_pre_w2_hf_d2_active_duplicate_cccd_semantics.sql";
const REPORT_SIGNATURE = "public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "hf_d2_proj_a";
const PROJ_B = "hf_d2_proj_b";
const PROJ_C = "hf_d2_proj_c";
const REC_A = uuid(21);
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const PM_AUTH = uuid(32), PM_APP = uuid(42);

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`migration ${name} failed to install: ${error.message}`, { cause: error });
    }
  }
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(D2_MIGRATION), 87, "HF-D2 remains #88 before the cutoff and export migrations");
  return db;
}

async function insertActor(db, auth, app, capabilities = [], scopes = []) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,true,'HF-D2 Account')", [app, auth]);
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)" +
      " values ($1,$2,'2020-01-01')", [app, capability]);
  }
  for (const scopeKind of scopes) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from)" +
      " values ($1,$2,$3,'2020-01-01')",
      [app, scopeKind, scopeKind === "team" ? TEAM : null]);
  }
}

async function seed(db) {
  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_HFD2','Team HFD2')",
    [TEAM]);
  for (const [pid, name] of [
    [PROJ_A, "Project HFD2 A"], [PROJ_B, "Project HFD2 B"], [PROJ_C, "Project HFD2 C"],
  ]) {
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)",
      [pid, name]);
  }
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter HFD2')",
    [REC_A]);
  await db.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from)" +
    " values ($1,'hrp','2020-01-01')", [REC_A]);
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)" +
    " values ($1,$2,'2020-01-01')", [REC_A, TEAM]);

  await insertActor(db, ADMIN_AUTH, ADMIN_APP,
    ["entry_admin", "recruiter_master_manage", "team_master_manage"], ["all"]);
  await insertActor(db, PM_AUTH, PM_APP, ["entry_create"], ["all"]);
}

function workerDetails(cccd) {
  return {
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: cccd === null ? { state: "unknown" } : { state: "provided", value: cccd },
    address: { state: "provided", value: "HFD2 address" },
    phone: { state: "provided", value: "0900000000" },
  };
}

let episodeSeq = 0;
async function seedEpisode(db, { cccd, name, project = PROJ_A, date = "2026-01-05" }) {
  episodeSeq += 1;
  const candidate = uuid(5000 + episodeSeq);
  const submission = uuid(6000 + episodeSeq);
  const entry = uuid(7000 + episodeSeq);
  const code = "hrp-2026-" + String(810000 + episodeSeq);
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
    await seedLegacyReviewSubmission(db, submission);
    await db.query(
      "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
      [submission]);
    await appendStatus(db, entry, "ON", date, 1, null);
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return { entryId: entry, employeeCode: code };
}

let reasonSeq = 0;
async function appendStatus(db, entryId, status, date, version, supersedesEventId) {
  reasonSeq += 1;
  const reasonId = (await db.query(
    "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
    " values ($1,$2) returning reason_id::text as id", [ADMIN_APP, `HF-D2 reason ${reasonSeq}`])).rows[0].id;
  return (await db.query(
    "insert into public.direct_entry_employment_status_events" +
    " (entry_id, status, effective_date, leave_date, leave_reason_text, version," +
    " actor_user_id, reason_id, supersedes_event_id)" +
    " values ($1,$2,$3::date, case when $2 = 'OFF' then $3::date else null end," +
    " case when $2 = 'OFF' then 'HF-D2 synthetic leave' else null end, $4,$5,$6,$7)" +
    " returning event_id::text as id",
    [entryId, status, date, version, ADMIN_APP, reasonId, supersedesEventId])).rows[0].id;
}

/** Seed a profile whose latest status is the given one (ON -> single ON event; OFF -> ON then OFF). */
async function seedProfile(db, { cccd, name, project = PROJ_A, date = "2026-01-05", status = "ON" }) {
  const ep = await seedEpisode(db, { cccd, name, project, date });
  if (status === "OFF") {
    await appendStatus(db, ep.entryId, "OFF", date, 2, null);
  }
  return ep;
}

/** PM closes an episode: append the next OFF event for the given entry. */
async function closeEpisode(db, entryId, date = "2026-02-01") {
  return appendStatus(db, entryId, "OFF", date, 2, null);
}

async function report(db, { auth = ADMIN_AUTH, app = ADMIN_APP, page = 1, pageSize = 25 } = {}) {
  return (await db.query(
    `select public.direct_entry_duplicate_cccd_report($1::uuid,$2::uuid,$3::int,$4::int) as data`,
    [auth, app, page, pageSize])).rows[0].data;
}

// ---------------------------------------------------------------------------
// 1. Only historical (OFF) duplicates are not reported.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D2: a CCCD with only resigned episodes is not reported", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedProfile(db, { cccd: "012345678901", name: "HFD2 Resigned A", project: PROJ_A, status: "OFF" });
    await seedProfile(db, { cccd: "012345678901", name: "HFD2 Resigned B", project: PROJ_B, status: "OFF" });

    const payload = await report(db);
    assert.equal(payload.total_groups, 0);
    assert.equal(payload.total_entries, 0);
    assert.deepEqual(payload.groups, []);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. One active + one inactive is not a working duplicate.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D2: one active plus one resigned episode is not reported", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedProfile(db, { cccd: "012345678901", name: "HFD2 Working", project: PROJ_A, status: "ON" });
    await seedProfile(db, { cccd: "012345678901", name: "HFD2 Resigned", project: PROJ_B, status: "OFF" });

    const payload = await report(db);
    assert.equal(payload.total_groups, 0);
    assert.equal(payload.total_entries, 0);
    assert.deepEqual(payload.groups, []);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Two active episodes are reported, and only those ON episodes are returned.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D2: two active episodes in the same project/day are reported as one group", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedProfile(db, { cccd: "012345678901", name: "HFD2 Active A", project: PROJ_A, date: "2026-01-05" });
    await seedProfile(db, { cccd: "012345678901", name: "HFD2 Active B", project: PROJ_A, date: "2026-01-05" });

    const payload = await report(db);
    assert.equal(payload.total_groups, 1);
    assert.equal(payload.total_entries, 2);
    assert.equal(payload.groups.length, 1);
    const [group] = payload.groups;
    assert.equal(group.cccd_last4, "8901");
    assert.equal(group.profile_count, 2);
    assert.equal(group.project_count, 1);
    assert.equal(group.active_profile_count, 2);
    assert.deepEqual(group.episodes.map((e) => e.latest_status), ["ON", "ON"]);
    assert.deepEqual(group.episodes.map((e) => e.active), [true, true]);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. After a PM closes one episode, the matching duplicate cluster remains visible as history.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D2: closing one episode retains the same-project/day group on the next read", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const a = await seedProfile(db, { cccd: "012345678901", name: "HFD2 Active A", project: PROJ_A });
    await seedProfile(db, { cccd: "012345678901", name: "HFD2 Active B", project: PROJ_A });

    const before = await report(db);
    assert.equal(before.total_groups, 1);
    assert.equal(before.total_entries, 2);

    await closeEpisode(db, a.entryId);

    const after = await report(db);
    assert.equal(after.total_groups, 1);
    assert.equal(after.total_entries, 2);
    assert.equal(after.groups[0].profile_count, 2);
    assert.equal(after.groups[0].active_profile_count, 1);
    assert.deepEqual(after.groups[0].episodes.map((episode) => episode.latest_status), ["OFF", "ON"]);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Two active matching episodes form the group; an unrelated resigned rehire is excluded.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D2: three episodes with two active return only the active ones", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedProfile(db, { cccd: "012345678901", name: "HFD2 Active A", project: PROJ_A, date: "2026-01-05" });
    await seedProfile(db, { cccd: "012345678901", name: "HFD2 Active B", project: PROJ_A, date: "2026-01-05" });
    await seedProfile(db, { cccd: "012345678901", name: "HFD2 Resigned", project: PROJ_C, date: "2026-03-01", status: "OFF" });

    const payload = await report(db);
    assert.equal(payload.total_groups, 1);
    assert.equal(payload.total_entries, 2, "the resigned episode is not counted or returned");
    const [group] = payload.groups;
    assert.equal(group.profile_count, 2);
    assert.equal(group.project_count, 1);
    assert.equal(group.active_profile_count, 2);
    assert.equal(group.episodes.length, 2);
    assert.deepEqual(group.episodes.map((e) => e.latest_status), ["ON", "ON"]);
    assert.deepEqual(group.episodes.map((e) => e.project_id), [PROJ_A, PROJ_A]);
    assert.deepEqual(group.episodes.map((e) => e.project_display), ["Project HFD2 A", "Project HFD2 A"]);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Pagination and counts reflect only eligible (active) groups.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D2: pagination and counts are computed after the active filter", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // Three eligible groups (2 active each) and one ineligible group (1 active + 1 OFF).
    await seedProfile(db, { cccd: "111111111", name: "G1 A", project: PROJ_A });
    await seedProfile(db, { cccd: "111111111", name: "G1 B", project: PROJ_A });
    await seedProfile(db, { cccd: "222222222", name: "G2 A", project: PROJ_A });
    await seedProfile(db, { cccd: "222222222", name: "G2 B", project: PROJ_A });
    await seedProfile(db, { cccd: "333333333", name: "G3 A", project: PROJ_A });
    await seedProfile(db, { cccd: "333333333", name: "G3 B", project: PROJ_A });
    await seedProfile(db, { cccd: "444444444", name: "G4 Active", project: PROJ_A });
    await seedProfile(db, { cccd: "444444444", name: "G4 Resigned", project: PROJ_B, status: "OFF" });

    const first = await report(db, { pageSize: 2 });
    assert.equal(first.total_groups, 3, "only three CCCDs have two active episodes");
    assert.equal(first.total_entries, 6);
    assert.equal(first.has_more, true);
    assert.equal(first.groups.length, 2);
    assert.deepEqual(first.groups.map((g) => g.cccd_last4), ["1111", "2222"]);

    const second = await report(db, { page: 2, pageSize: 2 });
    assert.equal(second.total_groups, 3);
    assert.equal(second.total_entries, 6);
    assert.equal(second.has_more, false);
    assert.deepEqual(second.groups.map((g) => g.cccd_last4), ["3333"]);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Projection safety: no raw CCCD, no internal UUID, no actor identifier.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D2: the report never leaks the raw CCCD or internal identifiers", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const a = await seedProfile(db, { cccd: "012345678901", name: "HFD2 Active A", project: PROJ_A });
    const b = await seedProfile(db, { cccd: "012345678901", name: "HFD2 Active B", project: PROJ_A });

    const payload = await report(db, { auth: PM_AUTH, app: PM_APP });
    assert.equal(payload.authority, "business_actor");
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("012345678901"), "the raw canonical CCCD must not leave the DB");
    for (const secret of [PM_AUTH, PM_APP, ADMIN_AUTH, ADMIN_APP, REC_A, TEAM]) {
      assert.ok(!serialized.includes(secret), `internal actor/catalog UUID leaked: ${secret}`);
    }
    assert.deepEqual(
      payload.groups[0].episodes.map((ep) => ep.entry_id).sort(),
      [a.entryId, b.entryId].sort(),
    );
    const episode = payload.groups[0].episodes[0];
    assert.deepEqual(Object.keys(episode).sort(), [
      "active", "can_mark_off", "can_self_withdraw", "display_name", "employee_code", "entry_id",
      "entry_version", "first_work_date", "latest_status", "project_display", "project_id",
    ]);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 8. The patch is append-only: the report stays STABLE, SECURITY DEFINER,
//    service_role-only, masked and bounded; the HF-C reader guard is untouched.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D2: the report boundary and reader guard are unchanged", async () => {
  const db = await buildDb();
  try {
    const report5ArgSig =
      "public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)";
    for (const sig of [REPORT_SIGNATURE, report5ArgSig]) {
      const reportFn = (await db.query(
        "select prosrc, provolatile, prosecdef, p.proconfig::text as config" +
        " from pg_proc p where p.oid = $1::regprocedure", [sig])).rows[0];
      assert.equal(reportFn.provolatile, "s", sig);
      assert.equal(reportFn.prosecdef, true, sig);
      assert.ok(String(reportFn.config).includes("search_path=pg_catalog, public"), sig);

      const acl = (await db.query(
        "select has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec," +
        " has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec," +
        " has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec" +
        " from pg_proc p where p.oid = $1::regprocedure", [sig])).rows[0];
      assert.deepEqual(acl, { service_exec: true, anon_exec: false, auth_exec: false }, sig);
    }

    const report5Arg = (await db.query(
      "select prosrc from pg_proc p where p.oid = $1::regprocedure", [report5ArgSig])).rows[0];
    assert.ok(report5Arg.prosrc.includes("l.latest_status = 'ON'"), "the ON working predicate is present");
    assert.equal(report5Arg.prosrc.includes("l.latest_status <> 'OFF'"), false, "the old OFF-based active predicate is gone");

    const reader = (await db.query(
      "select replace(p.prosrc, chr(13), '') as source from pg_proc p" +
      " where p.oid = 'public.direct_entry_assert_duplicate_cccd_reader(uuid,uuid)'::regprocedure")).rows[0];
    assert.ok(reader.source.includes("direct_entry_assert_actor_mapping"));
    assert.ok(reader.source.includes("'business_actor'"));
  } finally {
    await db.close();
  }
});
