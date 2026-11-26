/**
 * PRE-W2-HF-C - Global duplicate-CCCD read access (DB regression, PGlite over the 87-migration ledger).
 *
 * Proves the reader gate is now the canonical actor-mapping / active-account guard:
 *   * every mapped + enabled business actor — recruiter, team leader, project
 *     manager, accounting, admin, BoD, or an actor with no capability at all —
 *     reads the SAME global report under one stable authority label;
 *   * anonymous / unmapped / mismatched / disabled actors fail closed with 42501
 *     before any read;
 *   * the report RPC keeps its masked projection, pagination bounds and
 *     service_role-only ACL, and the old capability/all-scope gate is gone.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const HF_C_MIGRATION = "20261013130000_pre_w2_hf_c_global_duplicate_cccd_read_access.sql";
const REPORT_SIGNATURE = "public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer)";
const REPORT_SIGNATURE_5ARG =
  "public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)";
const READER_SIGNATURE = "public.direct_entry_assert_duplicate_cccd_reader(uuid,uuid)";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "proj_a";
const REC_A = uuid(21);
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const RECRUITER_AUTH = uuid(32), RECRUITER_APP = uuid(42);
const LEADER_AUTH = uuid(33), LEADER_APP = uuid(43);
const PM_AUTH = uuid(34), PM_APP = uuid(44);
const NOCAP_AUTH = uuid(35), NOCAP_APP = uuid(45);
const DISABLED_AUTH = uuid(36), DISABLED_APP = uuid(46);
const UNMAPPED_AUTH = uuid(37), UNMAPPED_APP = uuid(47);

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
  assert.equal(names.indexOf(HF_C_MIGRATION), 86, "HF-C #87 stays before D2 #88, cutoff #89, export #90 and status HF-F #91");
  return db;
}

async function insertActor(db, auth, app, { capabilities = [], scopes = [], enabled = true } = {}) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,$3,'HF-C Account')", [app, auth, enabled]);
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
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_HFC','Team HFC')", [TEAM]);
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project HFC')",
    [PROJ_A]);
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter HFC')", [REC_A]);
  await db.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from)" +
    " values ($1,'hrp','2020-01-01')", [REC_A]);
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)" +
    " values ($1,$2,'2020-01-01')", [REC_A, TEAM]);

  await insertActor(db, ADMIN_AUTH, ADMIN_APP,
    { capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"], scopes: ["all"] });
  await insertActor(db, RECRUITER_AUTH, RECRUITER_APP, { capabilities: ["entry_own"], scopes: ["own"] });
  await insertActor(db, LEADER_AUTH, LEADER_APP,
    { capabilities: ["team_manager_assign"], scopes: ["team"] });
  await insertActor(db, PM_AUTH, PM_APP, { capabilities: ["entry_create"], scopes: ["own"] });
  await insertActor(db, NOCAP_AUTH, NOCAP_APP, {});
  await insertActor(db, DISABLED_AUTH, DISABLED_APP, { enabled: false });
  // UNMAPPED_AUTH deliberately never appears in direct_entry_app_users.

  // Verified recruiter link for the recruiter audience actor (used by the report
  // eligibility read; the reader gate itself only needs the actor mapping).
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from) values ($1,$2,true,'2020-01-01')",
    [RECRUITER_APP, REC_A]);
}

let entrySeq = 0;
let reasonSeq = 0;
async function addProfile(db, { cccd, name, code, date = "2026-01-05" }) {
  entrySeq += 1;
  const candidate = uuid(5000 + entrySeq);
  const submission = uuid(6000 + entrySeq);
  const entry = uuid(7000 + entrySeq);
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
      [entry, submission, candidate, ADMIN_APP, PROJ_A, date, code,
        JSON.stringify({ display_name: name,
          date_of_birth: { state: "provided", value: "1990-01-01" },
          national_id: { state: "provided", value: cccd },
          address: { state: "provided", value: "1 HFC Street" },
          phone: { state: "provided", value: "0900000000" } }),
        REC_A, TEAM]);
    // PRE-W2-HF-D2: the report now only counts ON (working) episodes, so seed an ON
    // status event; a profile with no event (UNCONFIRMED) is no longer "working".
    reasonSeq += 1;
    const reasonId = (await db.query(
      "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
      " values ($1,$2) returning reason_id::text as id", [ADMIN_APP, `HFC reason ${reasonSeq}`])).rows[0].id;
    await db.query(
      "insert into public.direct_entry_employment_status_events" +
      " (entry_id, status, effective_date, leave_date, leave_reason_text, version," +
      " actor_user_id, reason_id, supersedes_event_id)" +
      " values ($1,'ON',$2::date,null,null,1,$3,$4,null)",
      [entry, date, ADMIN_APP, reasonId]);
    await seedLegacyReviewSubmission(db, submission);
    await db.query(
      "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
      [submission]);
    await db.exec("commit");
    return { entryId: entry, submissionId: submission, candidateId: candidate };
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function report(db, { auth = ADMIN_AUTH, app = ADMIN_APP, page = 1, pageSize = 25 } = {}) {
  return (await db.query(
    `select public.direct_entry_duplicate_cccd_report($1::uuid,$2::uuid,$3::int,$4::int) as data`,
    [auth, app, page, pageSize])).rows[0].data;
}

async function reportDenied(db, options) {
  await assert.rejects(() => report(db, options), (error) => error.code === "42501");
}

// ---------------------------------------------------------------------------
// 1. Every mapped + enabled actor reads the same global report.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-C: every mapped active actor reads the same global report", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await addProfile(db, { cccd: "012345678901", name: "HFC First", code: "hrp-2026-300001" });
    await addProfile(db, { cccd: "012345678901", name: "HFC Second", code: "hrp-2026-300002" });

    const expected = {
      authority: "business_actor",
      page: 1,
      page_size: 25,
      total_groups: 1,
      total_entries: 2,
      has_more: false,
    };
    for (const [auth, app, label] of [
      [ADMIN_AUTH, ADMIN_APP, "admin"],
      [RECRUITER_AUTH, RECRUITER_APP, "recruiter"],
      [LEADER_AUTH, LEADER_APP, "team leader"],
      [PM_AUTH, PM_APP, "project manager"],
      [NOCAP_AUTH, NOCAP_APP, "no-capability actor"],
    ]) {
      const payload = await report(db, { auth, app });
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(payload[key], value, `${label} -> ${key}`);
      }
      assert.equal(payload.groups.length, 1, label);
      assert.equal(payload.groups[0].profile_count, 2, label);
      assert.equal(payload.groups[0].cccd_last4, "8901", label);
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. The reader still fails closed for anonymous / unmapped / disabled actors.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-C: unmapped, mismatched and disabled actors are denied", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await addProfile(db, { cccd: "012345678901", name: "HFC First", code: "hrp-2026-300001" });
    await addProfile(db, { cccd: "012345678901", name: "HFC Second", code: "hrp-2026-300002" });

    // Never mapped into direct_entry_app_users.
    await reportDenied(db, { auth: UNMAPPED_AUTH, app: UNMAPPED_APP });
    // Actor/subject pair mismatch (the app_user is mapped to another subject).
    await reportDenied(db, { auth: ADMIN_AUTH, app: RECRUITER_APP });
    // Disabled account.
    await reportDenied(db, { auth: DISABLED_AUTH, app: DISABLED_APP });
    // An all-zero (anonymous-shaped) actor.
    await reportDenied(db, { auth: uuid(999), app: uuid(998) });
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Projection, pagination bounds and read-only posture are unchanged.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-C: the masked projection and pagination bounds are unchanged", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const first = await addProfile(db, { cccd: "012345678901", name: "HFC First", code: "hrp-2026-300001" });
    const second = await addProfile(db, { cccd: "012345678901", name: "HFC Second", code: "hrp-2026-300002" });

    const payload = await report(db, { auth: NOCAP_AUTH, app: NOCAP_APP });
    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("012345678901"), "the raw CCCD must never leave the database");
    for (const secret of [
      first.submissionId, first.candidateId, second.submissionId, second.candidateId,
      ADMIN_AUTH, ADMIN_APP, NOCAP_AUTH, NOCAP_APP, REC_A, TEAM,
    ]) {
      assert.ok(!serialized.includes(secret), `internal UUID leaked: ${secret}`);
    }
    assert.deepEqual(
      payload.groups[0].episodes.map((ep) => ep.entry_id).sort(),
      [first.entryId, second.entryId].sort(),
    );
    assert.deepEqual(Object.keys(payload).sort(), [
      "authority", "authorization_date", "groups", "has_more", "page", "page_size",
      "total_entries", "total_groups",
    ]);

    for (const [page, pageSize, code] of [
      [0, 25, "22023"], [1001, 25, "22023"], [1, 0, "22023"], [1, 101, "22023"],
    ]) {
      await assert.rejects(() => report(db, { page, pageSize }),
        (error) => error.code === code, `page ${page} / ${pageSize}`);
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. ACL + source posture: report service_role-only, reader fully revoked, no
//    capability grant, old gate gone.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-C: the report stays service_role-only and grants no capability", async () => {
  const db = await buildDb();
  try {
    const acl = async (signature) => (await db.query(
      "select has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec," +
      " has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec" +
      " from pg_proc p where p.oid = '" + signature + "'::regprocedure")).rows[0];

    const reportAcl = await acl(REPORT_SIGNATURE);
    assert.deepEqual(reportAcl, { service_exec: true, anon_exec: false, auth_exec: false });
    const report5ArgAcl = await acl(REPORT_SIGNATURE_5ARG);
    assert.deepEqual(report5ArgAcl, { service_exec: true, anon_exec: false, auth_exec: false });
    const readerAcl = await acl(READER_SIGNATURE);
    assert.deepEqual(readerAcl,
      { service_exec: false, anon_exec: false, auth_exec: false },
      "the reader guard stays revoked from every role");

    const reader = (await db.query(
      "select replace(p.prosrc, chr(13), '') as source, p.prosecdef," +
      " p.proconfig::text as config from pg_proc p where p.oid = $1::regprocedure",
      [READER_SIGNATURE])).rows[0];
    assert.equal(reader.prosecdef, true);
    assert.ok(String(reader.config).includes("search_path=pg_catalog, public"));
    assert.ok(reader.source.includes("direct_entry_assert_actor_mapping"),
      "the reader reuses the canonical actor-mapping guard");
    for (const gone of [
      "duplicate cccd report denied", "duplicate cccd report requires all scope",
      "'entry_admin'", "'catalog_master_manage'", "'entry_privileged_edit'",
      "direct_entry_has_capability", "direct_entry_scope_grants",
    ]) {
      assert.equal(reader.source.includes(gone), false, `the old gate fragment survived: ${gone}`);
    }
    assert.match(reader.source, /'business_actor'/);
  } finally {
    await db.close();
  }

  const sql = await readFile(path.join(MIGRATION_DIR, HF_C_MIGRATION), "utf8");
  assert.doesNotMatch(sql, /insert into public\.direct_entry_capability_grants/,
    "the migration must not grant a capability");
  assert.doesNotMatch(sql, /insert into public\.direct_entry_scope_grants/,
    "the migration must not grant a scope");
  // The report RPC is not re-created: the migration is a reader-gate patch only.
  assert.doesNotMatch(sql, /create or replace function public\.direct_entry_duplicate_cccd_report\(/,
    "the report RPC body must be untouched");
});
