/**
 * P2 Direct Entry reporting dimension classification hotfix - DB regression.
 *
 * Reproduces the Production shape (17 imported facts whose provider membership
 * starts AFTER their first_work_date and whose recruiters have no alias row),
 * proves the Dashboard buckets collapse to "Không xác định" (__unknown__), and
 * proves the evidence-backed repair restores the exact acceptance distribution:
 *   Jahwa 8 Vendor, Compal 3 HRP, Dongyang 3 Vendor + 3 HRP; total 17 (6 HRP /
 *   11 Vendor) with recruiter codes tu.vd 1, thinhvuong.vd 7, anhhn.td 3,
 *   dhr.vd 2, hainq.td 1, nhieunt.td 2, hao.vd 1.
 *
 * The repair runs the SAME statements as the data-plane script, imported from
 * scripts/lib/p2-de-reporting-dimension-repair.mjs, so the test cannot drift
 * from the production logic. Genuinely missing/contradictory/ambiguous metadata
 * must stay refused and keep resolving to __unknown__.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

import {
  REPAIR_ACTOR_SQL,
  REPAIR_DISTRIBUTION_SQL,
  REPAIR_PLAN_SQL,
  REPAIR_VERIFY_SQL,
  acceptanceCheck,
  assignmentStatements,
  auditStatements,
  deriveRepairPlan,
  foldDistribution,
  summariseRepairPlan,
} from "./lib/p2-de-reporting-dimension-repair.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

// Production shape: the imported membership period starts on the catalog import
// date, after the work dates of the imported entries.
const WORK_EARLY = "2026-10-02";
const WORK_LATE = "2026-10-05";
const REPAIRED_FROM = "2026-10-06";
// Early enough that a pre-window entry (Draft or pre-cutoff) can be inserted and
// still be proven NOT to move the repair anchor.
const PRE_REPAIR_FROM = "2026-09-01";
const OLD_ROW_DATE = "2026-09-25";

const TEAM = uuid(11);
const AUTH_ALL = uuid(31), APP_ALL = uuid(41);
const R_ANHHN = uuid(21), R_NHIEUNT = uuid(22), R_HAINQ = uuid(23);
const R_THINHVUONG = uuid(24), R_DHR = uuid(25), R_HAO = uuid(26), R_TU = uuid(27);

/** Every entry in the acceptance batch: project, recruiter, stored provider. */
const BATCH = [
  ...[0, 1, 2, 3, 4, 5, 6].map((i) => ({
    project: "proj_jahwa", recruiter: R_THINHVUONG, provider: "vendor",
    date: i < 5 ? WORK_EARLY : WORK_LATE,
  })),
  { project: "proj_jahwa", recruiter: R_TU, provider: "vendor", date: WORK_EARLY },
  { project: "proj_compal", recruiter: R_NHIEUNT, provider: "hrp", date: WORK_EARLY },
  { project: "proj_compal", recruiter: R_NHIEUNT, provider: "hrp", date: WORK_LATE },
  { project: "proj_compal", recruiter: R_HAINQ, provider: "hrp", date: WORK_EARLY },
  { project: "proj_dongyang", recruiter: R_ANHHN, provider: "hrp", date: WORK_EARLY },
  { project: "proj_dongyang", recruiter: R_ANHHN, provider: "hrp", date: WORK_EARLY },
  { project: "proj_dongyang", recruiter: R_ANHHN, provider: "hrp", date: WORK_LATE },
  { project: "proj_dongyang", recruiter: R_DHR, provider: "vendor", date: WORK_EARLY },
  { project: "proj_dongyang", recruiter: R_DHR, provider: "vendor", date: WORK_LATE },
  { project: "proj_dongyang", recruiter: R_HAO, provider: "vendor", date: WORK_EARLY },
];

const EXPECTED_PROVIDER_SPLIT = { hrp: 6, vendor: 11 };
const EXPECTED_CODE_SPLIT = {
  "anhhn.td": 3, "dhr.vd": 2, "hainq.td": 1, "hao.vd": 1,
  "nhieunt.td": 2, "thinhvuong.vd": 7, "tu.vd": 1,
};

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const OMITTED = { state: "omitted" };
function workerDetails(name) {
  return { display_name: name, date_of_birth: OMITTED, national_id: OMITTED, address: OMITTED, phone: OMITTED };
}

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf("20261009090000_p3_1_hf_recruiter_alias_backfill.sql"), 72, "migration chronology remains append-only");
  assert.equal(names.indexOf("20261009100000_p3_1_hf_duplicate_cccd_reporting.sql"), 73, "migration chronology remains append-only");
  // This is the regression for the earlier one-off P2 repair. Apply the
  // pre-hotfix ledger so its defect fixture remains reproducible; #73 has its
  // own focused lane and prevents this shape from being created again.
  // P3.1-HF: #74 follows #73, so cut explicitly before the alias backfill
  // instead of dropping only the last ledger entry.
  for (const name of names.slice(0, names.indexOf(
    "20261009090000_p3_1_hf_recruiter_alias_backfill.sql"))) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

async function seedBase(db) {
  await db.query("insert into auth.users (id) values ($1)", [AUTH_ALL]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name) values ($1,$2,true,'Synthetic Account')",
    [APP_ALL, AUTH_ALL]);
  await db.query(
    "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from)" +
    " values ($1,'entry_admin','2020-01-01')", [APP_ALL]);
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from)" +
    " values ($1,'all','2020-01-01')", [APP_ALL]);
  await db.query("insert into public.teams (team_id, code, display_name) values ($1,'TEAM_A','Team A')", [TEAM]);
  for (const [id, name] of [
    ["proj_jahwa", "Công Ty Tnhh Jahwa Vina"],
    ["proj_compal", "Công Ty Tnhh Compal (Việt Nam)"],
    ["proj_dongyang", "Công Ty Tnhh Dongyang Electronics Việt Nam"],
  ]) {
    await db.query("insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)", [id, name]);
  }
  for (const vendor of ["thinhvuong.vd", "dhr.vd", "hao.vd", "tu.vd"]) {
    await db.query("insert into public.vendors (vendor_id, display_name) values ($1,$2)", [vendor, vendor]);
  }
  // HRP recruiters carry their reporting code in recruiters.personnel_code;
  // Vendor recruiters carry theirs on the provider membership row.
  const recruiters = [
    { id: R_ANHHN, name: "Recruiter A", provider: "hrp", code: "anhhn.td" },
    { id: R_NHIEUNT, name: "Recruiter N", provider: "hrp", code: "nhieunt.td" },
    { id: R_HAINQ, name: "Recruiter H", provider: "hrp", code: "hainq.td" },
    { id: R_THINHVUONG, name: "Recruiter T", provider: "vendor", code: "thinhvuong.vd" },
    { id: R_DHR, name: "Recruiter D", provider: "vendor", code: "dhr.vd" },
    { id: R_HAO, name: "Recruiter O", provider: "vendor", code: "hao.vd" },
    { id: R_TU, name: "Recruiter U", provider: "vendor", code: "tu.vd" },
  ];
  for (const recruiter of recruiters) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name, personnel_code) values ($1,$2,$3)",
      [recruiter.id, recruiter.name, recruiter.provider === "hrp" ? recruiter.code : null]);
    await db.query(
      "insert into public.recruiter_provider_memberships" +
      " (recruiter_id, provider_type, valid_from, vendor_id) values ($1,$2,$3::date,$4)",
      [recruiter.id, recruiter.provider, PRE_REPAIR_FROM,
        recruiter.provider === "vendor" ? recruiter.code : null]);
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)" +
      " values ($1,$2,'2020-01-01')", [recruiter.id, TEAM]);
  }
}

let entrySeq = 0;
async function insertEntry(db, { project, recruiter, provider, date, submit = true }) {
  entrySeq += 1;
  const entry = uuid(1000 + entrySeq), sub = uuid(2000 + entrySeq), cand = uuid(3000 + entrySeq);
  const code = "hrp-2026-" + String(100000 + entrySeq);
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [cand]);
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)" +
      " values ($1,$2,'DRAFT')", [sub, APP_ALL]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
      " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
      " provider_type, labor_type)" +
      " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,'TEMPORARY')",
      [entry, sub, cand, APP_ALL, project, date, code,
        JSON.stringify(workerDetails("Worker " + entrySeq)), recruiter, TEAM, provider]);
    if (submit) {
      await seedLegacyReviewSubmission(db, sub);
      await db.query("update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1", [sub]);
    }
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return entry;
}

/** Faithful reproduction of the Production import defect. */
async function redateMemberships(db) {
  await db.query("update public.recruiter_provider_memberships set valid_from = $1::date", [REPAIRED_FROM]);
}

async function seedBatch(db) {
  const entries = [];
  for (const item of BATCH) entries.push(await insertEntry(db, item));
  return entries;
}

async function windowFacts(db) {
  const res = await db.query(
    "select provider_type_key, recruiter_key, entry_id::text as entry_id, project_display" +
    " from public.direct_entry_reporting_facts_v01");
  return res.rows;
}

async function repairPlan(db) {
  const rows = await db.query(REPAIR_PLAN_SQL);
  return deriveRepairPlan(rows.rows);
}

// The operating account used by the repair (enabled + entry_admin capability).
const REPAIR_ACTOR = {
  appUserId: APP_ALL,
  authSubject: AUTH_ALL,
  capability: "entry_admin",
  reasonText: "P2 DE reporting dimension metadata repair (PGlite regression)",
};

async function createReason(db, reasonText = REPAIR_ACTOR.reasonText) {
  const res = await db.query(
    "select public.direct_entry_reason($1::uuid,$2::text)::text as reason_id",
    [REPAIR_ACTOR.appUserId, reasonText]);
  return res.rows[0].reason_id;
}

async function applyPlan(db, plan, reasonId = null) {
  await db.exec("begin");
  try {
    let statements = 0;
    if (plan.assignments.length > 0) {
      const resolvedReason = reasonId ?? (await createReason(db));
      for (const assignment of plan.assignments) {
        for (const statement of assignmentStatements(assignment)) {
          await db.query(statement.sql, statement.params);
          statements += 1;
        }
        for (const statement of auditStatements(assignment, {
          authSubject: REPAIR_ACTOR.authSubject,
          appUserId: REPAIR_ACTOR.appUserId,
          capability: REPAIR_ACTOR.capability,
          reasonId: resolvedReason,
        })) {
          await db.query(statement.sql, statement.params);
          statements += 1;
        }
      }
    }
    await db.exec("commit");
    return statements;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

/** Mirrors the CLI: before -> plan -> execute -> after -> acceptance check. */
async function runRepair(db) {
  const before = await currentState(db);
  const plan = await repairPlan(db);
  const statements = await applyPlan(db, plan);
  const after = await currentState(db);
  return { before, plan, statements, after, acceptance: acceptanceCheck(before, after, plan) };
}

async function distribution(db) {
  const res = await db.query(REPAIR_DISTRIBUTION_SQL);
  return foldDistribution(res.rows);
}

async function countOf(db, sql) {
  const res = await db.query(sql);
  return Number(Object.values(res.rows[0])[0]);
}

async function currentState(db) {
  const window = await db.query(REPAIR_VERIFY_SQL);
  return { window: window.rows[0], distribution: await distribution(db) };
}
// ---------------------------------------------------------------------------
// 1. The defect, reproduced on the real projection.
// ---------------------------------------------------------------------------
test("P2-DE-dim: the imported batch resolves to __unknown__ before the repair", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    await redateMemberships(db);
    const facts = await windowFacts(db);
    assert.equal(facts.length, 17, "the batch must project exactly 17 facts");
    assert.equal(new Set(facts.map((f) => f.entry_id)).size, 17, "no double count");
    assert.equal(facts.every((f) => f.provider_type_key === "__unknown__"), true,
      "every imported fact currently falls into the unknown provider bucket");
    assert.equal(facts.every((f) => f.recruiter_key === "__unknown__"), true,
      "every imported fact currently falls into the unknown recruiter bucket");
    const stored = await db.query(
      "select provider_type, count(*)::int as n from public.direct_entries" +
      " where deleted_at is null group by 1 order by 1");
    assert.deepEqual(stored.rows.map((r) => [r.provider_type, r.n]), [["hrp", 6], ["vendor", 11]],
      "the stored canonical classification is intact (6 HRP / 11 Vendor)");
    const coverage = await db.query(
      "select count(*)::int as facts," +
      " count(*) filter (where public.direct_entry_reporting_recruiter_provider_key(" +
      "   e.recruiter_id, e.first_work_date) = '__unknown__')::int as provider_unknown" +
      " from public.direct_entries e");
    assert.deepEqual(coverage.rows[0], { facts: 17, provider_unknown: 17 });
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. The evidence-backed plan.
// ---------------------------------------------------------------------------
test("P2-DE-dim: the plan derives the source-table distribution from stored evidence", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    await redateMemberships(db);
    const plan = await repairPlan(db);
    const summary = summariseRepairPlan(plan);
    assert.equal(summary.refused_recruiters, 0, "nothing in the batch may be refused");
    assert.deepEqual(summary.refusal_reasons, []);
    assert.equal(summary.recruiters_to_repair, 7);
    assert.equal(summary.facts_covered, 17);
    assert.equal(summary.membership_valid_from_updates, 7);
    assert.equal(summary.alias_rows_inserted, 7);
    assert.deepEqual(summary.provider_split, EXPECTED_PROVIDER_SPLIT);
    assert.deepEqual(summary.reporting_code_split, EXPECTED_CODE_SPLIT);
    for (const assignment of plan.assignments) {
      assert.equal(assignment.target_from, WORK_EARLY,
        "the correction anchors on the earliest non-deleted entry work date");
      assert.ok(assignment.reporting_key_source);
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Apply the plan: exact acceptance distribution, audit, idempotency.
// ---------------------------------------------------------------------------
test("P2-DE-dim: the repair restores the acceptance distribution and is audited", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    await redateMemberships(db);
    const run = await runRepair(db);
    assert.equal(run.statements, 21, "7 membership re-dates + 7 alias rows + 7 audit events");
    assert.equal(run.acceptance.ok, true, "the acceptance check must pass on the first run");
    assert.equal(run.acceptance.facts_total_unchanged, true, "the fact count must not move");
    assert.equal(run.acceptance.provider_unknown_after, 0);
    assert.equal(run.acceptance.recruiter_unknown_after, 0);

    const after = await distribution(db);
    assert.equal(after.facts_total, 17);
    assert.deepEqual(after.provider_split, EXPECTED_PROVIDER_SPLIT);
    assert.deepEqual(after.reporting_code_split, EXPECTED_CODE_SPLIT);

    // The acceptance fixture, project by project.
    const perProject = await db.query(
      "select p.display_name as project," +
      " public.direct_entry_reporting_recruiter_provider_key(e.recruiter_id, e.first_work_date) as provider," +
      " count(*)::int as n" +
      " from public.direct_entry_reporting_facts_v01 f" +
      " join public.direct_entries e on e.entry_id = f.entry_id" +
      " join public.direct_entry_projects p on p.project_id = e.project_id" +
      " group by 1, 2 order by 1, 2");
    assert.deepEqual(perProject.rows.map((r) => ({ project: r.project, provider: r.provider, n: r.n })), [
      { project: "Công Ty Tnhh Compal (Việt Nam)", provider: "hrp", n: 3 },
      { project: "Công Ty Tnhh Dongyang Electronics Việt Nam", provider: "hrp", n: 3 },
      { project: "Công Ty Tnhh Dongyang Electronics Việt Nam", provider: "vendor", n: 3 },
      { project: "Công Ty Tnhh Jahwa Vina", provider: "vendor", n: 8 },
    ]);

    const facts = await windowFacts(db);
    assert.equal(facts.length, 17, "the repair must not duplicate or drop facts");
    assert.equal(facts.every((f) => f.provider_type_key === "hrp" || f.provider_type_key === "vendor"), true);
    assert.equal(facts.every((f) => f.recruiter_key !== "__unknown__"), true);

    const audit = await db.query(
      "select action, capability, outcome, cardinality(changed_fields)::int as fields," +
      " count(*)::int as n," +
      " count(*) filter (where auth_subject is not null)::int as with_auth_subject," +
      " count(*) filter (where app_user_id is not null)::int as with_app_user," +
      " count(*) filter (where reason_id is not null)::int as with_reason," +
      " count(distinct reason_id)::int as distinct_reasons," +
      " bool_and(auth_subject::text = $1::text) as auth_subject_matches," +
      " bool_and(app_user_id::text = $2::text) as app_user_matches" +
      " from public.direct_entry_audit_events group by 1,2,3,4", [AUTH_ALL, APP_ALL]);
    assert.deepEqual(audit.rows, [{
      action: "p2_de_reporting_dimension_repair",
      capability: "entry_admin",
      outcome: "APPLIED",
      fields: 2,
      n: 7,
      with_auth_subject: 7,
      with_app_user: 7,
      with_reason: 7,
      distinct_reasons: 1,
      auth_subject_matches: true,
      app_user_matches: true,
    }]);
    const reason = await db.query(
      "select reason_text, actor_user_id::text as actor, count(*) over ()::int as total" +
      " from public.direct_entry_restricted_reasons");
    assert.equal(reason.rows.length, 1, "exactly one restricted reason per run");
    assert.equal(reason.rows[0].total, 1);
    assert.equal(reason.rows[0].reason_text, REPAIR_ACTOR.reasonText);
    assert.equal(reason.rows[0].actor, APP_ALL);

    // Idempotent: a second run has nothing left to do.
    const second = summariseRepairPlan(await repairPlan(db));
    assert.equal(second.recruiters_to_repair, 0);
    assert.equal(second.already_resolved_recruiters, 7);
    assert.equal(second.refused_recruiters, 0);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. W05A actor scope keeps reading the same corrected classification.
// ---------------------------------------------------------------------------
test("P2-DE-dim: the W05A scoped projection sees the repaired dimensions", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    await redateMemberships(db);
    const before = await db.query(
      "select public.direct_entry_reporting_scoped_facts($1::uuid,$2::uuid,$3::jsonb) as data",
      [AUTH_ALL, APP_ALL, JSON.stringify({})]);
    assert.equal(before.rows[0].data.audience.audience, "all");
    assert.equal(before.rows[0].data.facts.every((f) => f.provider_type_key === "__unknown__"), true);
    await applyPlan(db, await repairPlan(db));
    const after = await db.query(
      "select public.direct_entry_reporting_scoped_facts($1::uuid,$2::uuid,$3::jsonb) as data",
      [AUTH_ALL, APP_ALL, JSON.stringify({})]);
    const facts = after.rows[0].data.facts;
    assert.equal(facts.length, 17);
    const provider = {};
    const codes = {};
    for (const fact of facts) {
      provider[fact.provider_type_key] = (provider[fact.provider_type_key] ?? 0) + fact.recruited_count;
      codes[fact.recruiter_key] = (codes[fact.recruiter_key] ?? 0) + fact.recruited_count;
    }
    assert.deepEqual(provider, EXPECTED_PROVIDER_SPLIT);
    assert.deepEqual(codes, EXPECTED_CODE_SPLIT);
  } finally {
    await db.close();
  }
});
// ---------------------------------------------------------------------------
// 5. Fail-closed: genuinely missing, expired or contradictory metadata.
// ---------------------------------------------------------------------------
const R_UNMAPPED = uuid(28), R_EXPIRED = uuid(29), R_CONTRADICT = uuid(30);
const R_DUP_HRP = uuid(32), R_DUP_VENDOR = uuid(33);

async function insertRecruiter(db, { id, provider, personnelCode = null, vendorId = null }) {
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name, personnel_code) values ($1,$2,$3)",
    [id, "Recruiter " + id.slice(-4), personnelCode]);
  await db.query(
    "insert into public.recruiter_provider_memberships" +
    " (recruiter_id, provider_type, valid_from, vendor_id) values ($1,$2,$3::date,$4)",
    [id, provider, PRE_REPAIR_FROM, vendorId]);
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)" +
    " values ($1,$2,'2020-01-01')", [id, TEAM]);
}

async function keyOf(db, entryId) {
  const res = await db.query(
    "select public.direct_entry_reporting_recruiter_provider_key(e.recruiter_id, e.first_work_date)" +
    "  as provider_key," +
    " public.direct_entry_reporting_recruiter_alias_key(e.recruiter_id, e.first_work_date) as recruiter_key" +
    " from public.direct_entries e where e.entry_id = $1::uuid", [entryId]);
  return res.rows[0];
}

test("P2-DE-dim: a recruiter without any provider membership is refused and stays unknown", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    await insertRecruiter(db, { id: R_UNMAPPED, provider: "hrp", personnelCode: "unmapped.td" });
    const orphan = await insertEntry(db, {
      project: "proj_jahwa", recruiter: R_UNMAPPED, provider: "hrp", date: WORK_EARLY,
    });
    await redateMemberships(db);
    await db.query("delete from public.recruiter_provider_memberships where recruiter_id = $1", [R_UNMAPPED]);
    assert.deepEqual(await keyOf(db, orphan), { provider_key: "__unknown__", recruiter_key: "__unknown__" });
    const summary = summariseRepairPlan(await repairPlan(db));
    assert.equal(summary.recruiters_to_repair, 7, "the batch stays repairable");
    assert.equal(summary.refused_recruiters, 1);
    assert.deepEqual(summary.refusal_reasons, ["recruiter must have exactly one provider membership row"]);
    assert.deepEqual(await keyOf(db, orphan), { provider_key: "__unknown__", recruiter_key: "__unknown__" });
  } finally {
    await db.close();
  }
});

test("P2-DE-dim: an expired alias history is refused and never becomes a wrong recruiter", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    await insertRecruiter(db, { id: R_EXPIRED, provider: "hrp", personnelCode: "expired.td" });
    const stale = await insertEntry(db, {
      project: "proj_compal", recruiter: R_EXPIRED, provider: "hrp", date: WORK_EARLY,
    });
    await db.query(
      "insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from, valid_to)" +
      " values ($1,'expired.td','2020-01-01','2026-10-01')", [R_EXPIRED]);
    await redateMemberships(db);
    assert.deepEqual(await keyOf(db, stale), { provider_key: "__unknown__", recruiter_key: "__unknown__" });
    const summary = summariseRepairPlan(await repairPlan(db));
    assert.equal(summary.refused_recruiters, 1);
    assert.deepEqual(summary.refusal_reasons, ["recruiter already has a reporting alias history"]);
    assert.equal(summary.recruiters_to_repair, 7);
  } finally {
    await db.close();
  }
});

test("P2-DE-dim: a membership contradicting the stored provider is refused", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    await insertRecruiter(db, { id: R_CONTRADICT, provider: "hrp", personnelCode: "contradict.td" });
    const contested = await insertEntry(db, {
      project: "proj_dongyang", recruiter: R_CONTRADICT, provider: "hrp", date: WORK_EARLY,
    });
    await redateMemberships(db);
    // The membership timeline is re-pointed to a different provider after the
    // fact was written: the repair must refuse instead of picking a side.
    await db.query(
      "update public.recruiter_provider_memberships set provider_type = 'vendor'" +
      " where recruiter_id = $1", [R_CONTRADICT]);
    const summary = summariseRepairPlan(await repairPlan(db));
    assert.equal(summary.refused_recruiters, 1);
    assert.deepEqual(summary.refusal_reasons, ["membership provider contradicts the stored fact provider"]);
    assert.equal(summary.recruiters_to_repair, 7);
    // Untouched by the plan: the row keeps the unknown bucket instead of being
    // silently reclassified from a contradicting membership timeline.
    assert.deepEqual(await keyOf(db, contested), {
      provider_key: "__unknown__",
      recruiter_key: "__unknown__",
    });
  } finally {
    await db.close();
  }
});

test("P2-DE-dim: two recruiters deriving the same code are both refused", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    await db.query("insert into public.vendors (vendor_id, display_name) values ('shared.td','shared.td')");
    await insertRecruiter(db, { id: R_DUP_HRP, provider: "hrp", personnelCode: "shared.td" });
    await insertRecruiter(db, { id: R_DUP_VENDOR, provider: "vendor", vendorId: "shared.td" });
    await insertEntry(db, { project: "proj_compal", recruiter: R_DUP_HRP, provider: "hrp", date: WORK_EARLY });
    await insertEntry(db, { project: "proj_jahwa", recruiter: R_DUP_VENDOR, provider: "vendor", date: WORK_EARLY });
    await redateMemberships(db);
    const summary = summariseRepairPlan(await repairPlan(db));
    assert.equal(summary.refused_recruiters, 2);
    assert.deepEqual(summary.refusal_reasons, ["reporting code is claimed by more than one recruiter in this batch"]);
    assert.equal(summary.recruiters_to_repair, 7, "the acceptance batch is unaffected");
    assert.equal(Object.hasOwn(summary.reporting_code_split, "shared.td"), false,
      "an ambiguous code must never enter the repaired split");
  } finally {
    await db.close();
  }
});
// ---------------------------------------------------------------------------
// 6. R1: the repair anchor is the earliest WINDOW fact, never an older row.
// ---------------------------------------------------------------------------
test("P2-DE-dim R1: an older Draft or pre-cutoff row never pulls the anchor back", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    // A Draft and a pre-cutoff SUBMITTED row, both older than every window fact.
    await insertEntry(db, {
      project: "proj_jahwa", recruiter: R_THINHVUONG, provider: "vendor",
      date: OLD_ROW_DATE, submit: false,
    });
    await insertEntry(db, {
      project: "proj_dongyang", recruiter: R_DHR, provider: "vendor", date: OLD_ROW_DATE,
    });
    await redateMemberships(db);
    const plan = await repairPlan(db);
    assert.equal(plan.refusals.length, 0);
    assert.equal(plan.assignments.length, 7);
    for (const assignment of plan.assignments) {
      assert.equal(assignment.target_from, WORK_EARLY,
        "the anchor must stay on the earliest reporting-window fact");
    }
    assert.equal(await countOf(db, "select count(*)::int as n from public.direct_entry_reporting_facts_v01"),
      17, "the pre-window rows must not join the reporting window");
    await applyPlan(db, plan);
    const bounds = await db.query(
      "select min(m.valid_from)::text as membership_from," +
      " (select min(a.valid_from)::text from public.recruiter_aliases a) as alias_from" +
      " from public.recruiter_provider_memberships m");
    assert.deepEqual(bounds.rows[0], { membership_from: WORK_EARLY, alias_from: WORK_EARLY });
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 7. R1: a reporting key already used by ANOTHER recruiter is refused.
// ---------------------------------------------------------------------------
const R_FOREIGN = uuid(34);

async function seedForeignAlias(db, { key, validTo }) {
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name, personnel_code)" +
    " values ($1,'Foreign Recruiter','foreign.td')", [R_FOREIGN]);
  await db.query(
    "insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from, valid_to)" +
    " values ($1,$2,'2020-01-01',$3::date)", [R_FOREIGN, key, validTo]);
}

test("P2-DE-dim R1: a key already claimed by another recruiter is refused", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    // Another recruiter still carries the key thinhvuong.vd (open ended), so a new
    // alias with valid_to = NULL would merge two people onto one reporting key.
    await seedForeignAlias(db, { key: "thinhvuong.vd", validTo: null });
    await redateMemberships(db);
    const plan = await repairPlan(db);
    const summary = summariseRepairPlan(plan);
    assert.equal(summary.refused_recruiters, 1);
    assert.deepEqual(summary.refusal_reasons, ["reporting code is already used by another recruiter"]);
    assert.equal(summary.recruiters_to_repair, 6, "the other recruiters stay repairable");
    assert.equal(plan.assignments.some((a) => a.reporting_key === "thinhvuong.vd"), false,
      "the contested key must never be inserted");
    assert.equal(Object.hasOwn(summary.reporting_code_split, "thinhvuong.vd"), false);
    // The foreign alias is untouched.
    assert.equal(await countOf(db, "select count(*)::int as n from public.recruiter_aliases"), 1);
  } finally {
    await db.close();
  }
});

test("P2-DE-dim R1: a foreign alias closed before the anchor does not block the repair", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    await seedForeignAlias(db, { key: "thinhvuong.vd", validTo: "2026-10-01" });
    await redateMemberships(db);
    const summary = summariseRepairPlan(await repairPlan(db));
    assert.equal(summary.refused_recruiters, 0);
    assert.equal(summary.recruiters_to_repair, 7);
    assert.deepEqual(summary.reporting_code_split, EXPECTED_CODE_SPLIT);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 8. R1: a second run after a successful repair is a valid no-op.
// ---------------------------------------------------------------------------
test("P2-DE-dim R1: the second run is a no-op with no duplicate alias or audit", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    await redateMemberships(db);
    const first = await runRepair(db);
    assert.equal(first.acceptance.ok, true);
    const aliasesAfterFirst = await countOf(db, "select count(*)::int as n from public.recruiter_aliases");
    const auditAfterFirst = await countOf(db, "select count(*)::int as n from public.direct_entry_audit_events");
    assert.equal(aliasesAfterFirst, 7);
    assert.equal(auditAfterFirst, 7);

    const second = await runRepair(db);
    assert.equal(second.plan.assignments.length, 0, "nothing left to repair");
    assert.equal(second.plan.skipped.length, 7);
    assert.equal(second.statements, 0, "a no-op run must not write anything");
    assert.equal(second.acceptance.ok, true, "a no-op rerun must still satisfy acceptance");
    assert.equal(second.acceptance.resolved_by_this_run.provider, 0);
    assert.equal(second.acceptance.resolved_by_this_run.recruiter, 0);
    assert.deepEqual(second.after.distribution, first.after.distribution);
    assert.equal(await countOf(db, "select count(*)::int as n from public.recruiter_aliases"), 7);
    assert.equal(await countOf(db, "select count(*)::int as n from public.direct_entry_audit_events"), 7);
    assert.equal(await countOf(db, "select count(*)::int as n from public.direct_entry_restricted_reasons"), 1,
      "a no-op run must not create another restricted reason");
  } finally {
    await db.close();
  }
});
// ---------------------------------------------------------------------------
// 9. R1: the dry-run path applies the real statements and rolls everything back.
// ---------------------------------------------------------------------------
test("P2-DE-dim R1: a dry-run applies nothing and leaves the window untouched", async () => {
  const db = await buildDb();
  try {
    await seedBase(db);
    await seedBatch(db);
    await redateMemberships(db);
    const before = await currentState(db);
    const plan = await repairPlan(db);
    assert.equal(plan.assignments.length, 7);

    // Exactly what the CLI does for --dry-run: begin, execute, verify, rollback.
    await db.exec("begin");
    const reasonId = await createReason(db);
    let statements = 0;
    for (const assignment of plan.assignments) {
      for (const statement of assignmentStatements(assignment)) {
        await db.query(statement.sql, statement.params);
        statements += 1;
      }
      for (const statement of auditStatements(assignment, {
        authSubject: REPAIR_ACTOR.authSubject,
        appUserId: REPAIR_ACTOR.appUserId,
        capability: REPAIR_ACTOR.capability,
        reasonId,
      })) {
        await db.query(statement.sql, statement.params);
        statements += 1;
      }
    }
    const inside = await currentState(db);
    const acceptance = acceptanceCheck(before, inside, plan);
    assert.equal(statements, 21);
    assert.equal(acceptance.ok, true, "acceptance must hold inside the dry-run transaction");
    assert.equal(inside.window.provider_unknown, 0);
    assert.deepEqual(inside.distribution.provider_split, EXPECTED_PROVIDER_SPLIT);
    await db.exec("rollback");

    // Nothing persisted.
    assert.equal(await countOf(db, "select count(*)::int as n from public.recruiter_aliases"), 0);
    assert.equal(await countOf(db, "select count(*)::int as n from public.direct_entry_audit_events"), 0);
    assert.equal(await countOf(db, "select count(*)::int as n from public.direct_entry_restricted_reasons"), 0);
    const reverted = await db.query(
      "select count(*)::int as still_open from public.recruiter_provider_memberships" +
      " where valid_from = $1::date", [REPAIRED_FROM]);
    assert.equal(reverted.rows[0].still_open, 7, "every membership window must be back to its original date");
    assert.deepEqual((await currentState(db)).distribution, before.distribution);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 10. WP10-7-3C: REPAIR_ACTOR_SQL resolves canonical Permission Group actors
//     on HEAD migrations without reading legacy grant tables.
// ---------------------------------------------------------------------------
test("P2-DE-dim WP10-7-3C: REPAIR_ACTOR_SQL resolves canonical authz_managed actors on HEAD", async () => {
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
    for (const name of names) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const adminAuth = uuid(501), adminApp = uuid(601);
    const hrAuth = uuid(502), hrApp = uuid(602);
    const bothAuth = uuid(503), bothApp = uuid(603);
    const recAuth = uuid(504), recApp = uuid(604);
    const disabledAuth = uuid(505), disabledApp = uuid(605);
    const unmanagedAuth = uuid(506), unmanagedApp = uuid(606);
    const futureAuth = uuid(507), futureApp = uuid(607);
    const expiredAuth = uuid(508), expiredApp = uuid(608);

    for (const [auth, app, enabled, managed] of [
      [adminAuth, adminApp, true, true],
      [hrAuth, hrApp, true, true],
      [bothAuth, bothApp, true, true],
      [recAuth, recApp, true, true],
      [disabledAuth, disabledApp, false, true],
      [unmanagedAuth, unmanagedApp, true, false],
      [futureAuth, futureApp, true, true],
      [expiredAuth, expiredApp, true, true],
    ]) {
      await db.query("insert into auth.users (id) values ($1::uuid)", [auth]);
      await db.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, authz_managed, display_name)" +
        " values ($1::uuid, $2::uuid, $3, $4, $5)",
        [app, auth, enabled, managed, "Actor " + app.slice(-4)],
      );
    }

    const assign = async (app, code, { startedAt = "2020-01-01T00:00:00Z", endedAt = null } = {}) => {
      await db.query(
        "insert into public.authz_user_group_members" +
        " (group_id, app_user_id, source_kind, reason, started_at, ended_at, ended_by_app_user_id, ended_reason)" +
        " select g.group_id, $1::uuid, 'ADMIN_ASSIGNMENT', 'Hotfix actor test', $3::timestamptz, $4::timestamptz," +
        "   case when $4::timestamptz is null then null else $5::uuid end," +
        "   case when $4::timestamptz is null then null else 'Expired' end" +
        " from public.authz_user_groups g where g.code = $2",
        [app, code, startedAt, endedAt, adminApp],
      );
    };

    await assign(adminApp, "SYSTEM_ADMIN");
    await assign(hrApp, "HR_CATALOG_OPERATOR");
    await assign(bothApp, "SYSTEM_ADMIN");
    await assign(bothApp, "HR_CATALOG_OPERATOR");
    await assign(recApp, "RECRUITER_OPERATIONS");
    await assign(disabledApp, "SYSTEM_ADMIN");
    await assign(unmanagedApp, "SYSTEM_ADMIN");
    await assign(futureApp, "SYSTEM_ADMIN", { startedAt: "2099-01-01T00:00:00Z" });
    await assign(expiredApp, "SYSTEM_ADMIN", { endedAt: "2020-06-01T00:00:00Z" });

    assert.deepEqual((await db.query(REPAIR_ACTOR_SQL, [adminApp])).rows, [
      { app_user_id: adminApp, auth_subject: adminAuth, capability: "recruiter_master_manage" },
    ]);
    assert.deepEqual((await db.query(REPAIR_ACTOR_SQL, [hrApp])).rows, [
      { app_user_id: hrApp, auth_subject: hrAuth, capability: "recruiter_master_manage" },
    ]);
    assert.deepEqual((await db.query(REPAIR_ACTOR_SQL, [bothApp])).rows, [
      { app_user_id: bothApp, auth_subject: bothAuth, capability: "recruiter_master_manage" },
    ]);
    assert.deepEqual((await db.query(REPAIR_ACTOR_SQL, [recApp])).rows, [
      { app_user_id: recApp, auth_subject: recAuth, capability: null },
    ]);
    assert.deepEqual((await db.query(REPAIR_ACTOR_SQL, [disabledApp])).rows, []);
    assert.deepEqual((await db.query(REPAIR_ACTOR_SQL, [unmanagedApp])).rows, []);
    assert.deepEqual((await db.query(REPAIR_ACTOR_SQL, [futureApp])).rows, [
      { app_user_id: futureApp, auth_subject: futureAuth, capability: null },
    ]);
    assert.deepEqual((await db.query(REPAIR_ACTOR_SQL, [expiredApp])).rows, [
      { app_user_id: expiredApp, auth_subject: expiredAuth, capability: null },
    ]);
  } finally {
    await db.close();
  }
});
