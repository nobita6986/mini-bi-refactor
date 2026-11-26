/**
 * PRE-W2-P1/HF-G - Full-PII worker export RPC (DB regression, PGlite over the migration ledger).
 *
 * Proves the export contract at the DB boundary:
 *   * recruited/managed full-PII export requires the existing row authority, not a
 *     separate field/export capability; `all` retains its explicit scope + action;
 *   * `all` (and any other scope) is denied with 42501;
 *   * one batch read over the authorized set with the directory's eligibility/filter
 *     semantics and deterministic order;
 *   * full-PII projection (never masked) with the exact 20-field row shape;
 *   * 10,000 -> {status:"ok"}; 10,001 -> {status:"too_many_rows"} with a persisted
 *     REJECTED audit and no worker row; the RPC does not raise after the audit;
 *   * audit mapping recruited->own, managed->project, a non-PII resource_ref and an
 *     empty changed_fields; and the RPC is service_role-only.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const EXPORT_MIGRATION_NAME = "20261013120000_pre_w2_p1_worker_export.sql";
const RPC = "public.direct_entry_export_workers(uuid,uuid,text,text,uuid,text,text)";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "proj_a", PROJ_B = "proj_b";
const REC_A = uuid(21), REC_B = uuid(22);
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const MGR_AUTH = uuid(32), MGR_APP = uuid(42);
const UPLOADER_AUTH = uuid(34), UPLOADER_APP = uuid(44);

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
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`migration ${name} failed to install: ${error.message}`, { cause: error });
    }
  }
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(EXPORT_MIGRATION_NAME), 85, "the export migration stays #86 before HF-C #87, HF-D2 #88, cutoff #89, HF-E #90, HF-F #91, D3-A #92 and HF-G #93");
  return db;
}

async function seed(db) {
  entrySeq = 0;
  for (const [auth, app] of [[ADMIN_AUTH, ADMIN_APP], [MGR_AUTH, MGR_APP],
    [UPLOADER_AUTH, UPLOADER_APP]]) {
    await db.query("insert into auth.users (id) values ($1)", [auth]);
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
  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_X','Team X')", [TEAM]);
  for (const [project, name] of [[PROJ_A, "Project A"], [PROJ_B, "Project B"]]) {
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)",
      [project, name]);
  }
  for (const [recruiter, name] of [[REC_A, "Recruiter A"], [REC_B, "Recruiter B"]]) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1,$2)", [recruiter, name]);
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
      " values ($1,'hrp','2020-01-01',true)", [recruiter]);
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [recruiter, TEAM]);
  }
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)",
    [MGR_APP, REC_A]);
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)",
    [UPLOADER_APP, REC_B]);
}

async function grant(db, app, capability) {
  await db.query(
    "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
    " values ($1,$2,'2020-01-01',true)", [app, capability]);
}

async function grantExportCaps(db, app) {
  await grant(db, app, "pii_export");
  await grant(db, app, "pii_view");
  await grant(db, app, "payment_view");
}

async function assignManager(db, { project, recruiter, key }) {
  const version = (await db.query(
    "select version from public.direct_entry_projects where project_id = $1", [project]))
    .rows[0].version;
  await db.query(
    "select public.direct_entry_assign_project_manager($1::uuid,$2::uuid,$3::text,$4::uuid," +
    "$5::date,$6::integer,$7::text,$8::text)",
    [ADMIN_AUTH, ADMIN_APP, project, recruiter, null, version, "synthetic assignment", key]);
}

let entrySeq = 0;
async function addWorker(db, {
  project = PROJ_A, recruiter = REC_A, workDate = "2026-10-01", state = "SUBMITTED",
  payment = null, employment = null, generalNote = undefined, providerType = "hrp",
  laborType = "TEMPORARY",
}) {
  entrySeq += 1;
  const n = entrySeq;
  const candidate = uuid(5000 + n), submission = uuid(6000 + n), entry = uuid(7000 + n);
  const year = String(workDate).slice(0, 4);
  const workerDetails = {
    display_name: "Worker " + n,
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: { state: "provided", value: "0123456789" + String(10 + n).slice(-2) },
    national_id_issued_at: { state: "provided", value: "2020-01-02" },
    address: { state: "provided", value: "1 Synthetic Street " + n },
    phone: { state: "provided", value: "0900" + String(100000 + n) },
  };
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidate]);
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)" +
      " values ($1,$2,'DRAFT')", [submission, UPLOADER_APP]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
      " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
      " provider_type, labor_type, general_note)" +
      " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13)",
      [entry, submission, candidate, UPLOADER_APP, project, workDate,
        "hrp-" + year + "-" + String(300000 + n), JSON.stringify(workerDetails), recruiter, TEAM,
        providerType, laborType, generalNote ?? null]);
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
        " bank_name, account_holder_name) values ($1,'provided',$2,$3,$4,$5)",
        [entry, payment.account_number ?? null, payment.bank_id ?? null, payment.bank_name ?? null,
          payment.account_holder_name ?? null]);
    }
    if (employment !== null) {
      const reasonId = (await db.query(
        "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
        " values ($1,'synthetic status reason') returning reason_id::text as id",
        [UPLOADER_APP])).rows[0].id;
      let version = 0;
      for (const step of employment) {
        version += 1;
        await db.query(
          "insert into public.direct_entry_employment_status_events" +
          " (entry_id, status, effective_date, leave_date, leave_reason_text, version," +
          " actor_user_id, reason_id)" +
          " values ($1,$2,$3::date, case when $2='OFF' then $3::date else null end," +
          " case when $2='OFF' then 'synthetic leave' else null end, $4,$5,$6)",
          [entry, step.status, step.effective, version, UPLOADER_APP, reasonId]);
      }
    }
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  return entry;
}

async function runExport(db, {
  auth = MGR_AUTH, app = MGR_APP, scope = "recruited", project = null, recruiter = null,
  employment = null, reason = "export test reason",
} = {}) {
  const res = await db.query(
    "select public.direct_entry_export_workers($1::uuid,$2::uuid,$3::text,$4::text,$5::uuid," +
    "$6::text,$7::text) as data",
    [auth, app, scope, project, recruiter, employment, reason]);
  return res.rows[0].data;
}

async function audits(db) {
  return (await db.query(
    "select action, capability, scope_kind, outcome, denial_code, resource_ref, reason_id," +
    " changed_fields from public.direct_entry_audit_events where action = 'worker_export'" +
    " order by created_at")).rows;
}

// ---------------------------------------------------------------------------
// 1. recruited (own) succeeds with full PII + payment, and writes an ALLOW audit.
// ---------------------------------------------------------------------------
test("PRE-W2-P1: recruited export returns the full authorized rows and an own/ALLOW audit", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const entry = await addWorker(db, {
      recruiter: REC_A, workDate: "2026-10-01",
      payment: { account_number: "012345678901", bank_name: "Synthetic Bank",
        account_holder_name: "Synthetic Holder" },
      employment: [{ status: "UNCONFIRMED", effective: "2026-10-01" },
        { status: "ON", effective: "2026-10-02" },
        { status: "OFF", effective: "2026-10-03" }],
      generalNote: "Synthetic general note",
    });
    // Another recruiter's worker must never appear.
    await addWorker(db, { recruiter: REC_B, workDate: "2026-10-04" });

    const payload = await runExport(db, { scope: "recruited" });
    assert.equal(payload.status, "ok");
    assert.equal(payload.rows.length, 1);
    const row = payload.rows[0];
    assert.deepEqual(Object.keys(row).sort(), [
      "account_holder_name", "account_number", "address", "bank_name", "date_of_birth",
      "display_name", "employee_code", "employment_status", "first_work_date", "general_note",
      "labor_type_display", "leave_date", "leave_reason", "national_id", "national_id_issued_at",
      "payment_note", "phone",
      "project_display", "provider_type", "recruiter_display",
    ]);
    // FULL PII and FULL payment (never masked).
    assert.match(row.national_id, /^0123456789[0-9]{2}$/);
    assert.equal(row.account_number, "012345678901");
    assert.equal(row.date_of_birth, "1990-01-01");
    assert.equal(row.national_id_issued_at, "2020-01-02");
    assert.match(row.phone, /^0900[0-9]{6}$/);
    assert.equal(row.address, "1 Synthetic Street 1");
    assert.equal(row.project_display, "Project A");
    assert.equal(row.recruiter_display, "Recruiter A");
    assert.equal(row.provider_type, "HRP");
    assert.equal(row.labor_type_display, "Thời vụ");
    assert.equal(row.employment_status, "OFF");
    assert.equal(row.leave_date, "2026-10-03");
    assert.equal(row.leave_reason, "synthetic leave");
    assert.equal(row.bank_name, "Synthetic Bank");
    assert.equal(row.account_holder_name, "Synthetic Holder");
    assert.equal(row.payment_note, null, "no authoritative payment note");
    assert.equal(row.general_note, "Synthetic general note",
      "general_note comes from direct_entries.general_note");
    assert.equal(row.employee_code, "hrp-2026-300001");
    assert.ok(entry);

    const [audit] = await audits(db);
    assert.equal(audit.action, "worker_export");
    assert.equal(audit.capability, null);
    assert.equal(audit.scope_kind, "own");
    assert.equal(audit.outcome, "ALLOW");
    assert.equal(audit.denial_code, null);
    assert.equal(audit.changed_fields.length, 0);
    assert.ok(audit.reason_id);
    assert.match(audit.resource_ref, /^worker-export:recruited:1:[0-9a-f]{64}$/);
    assert.ok(audit.resource_ref.length <= 128);
    assert.doesNotMatch(audit.resource_ref, /0123|proj_a/);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. managed (project) succeeds and logs the project scope_kind.
// ---------------------------------------------------------------------------
test("PRE-W2-P1: managed export logs the project scope_kind", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await assignManager(db, { project: PROJ_A, recruiter: REC_A, key: "assign-a" });
    await addWorker(db, { project: PROJ_A, recruiter: REC_B, workDate: "2026-10-02" });

    const payload = await runExport(db, { scope: "managed" });
    assert.equal(payload.status, "ok");
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0].project_display, "Project A");
    const [audit] = await audits(db);
    assert.equal(audit.scope_kind, "project");
    assert.equal(audit.outcome, "ALLOW");

    // Out-of-scope project is refused, not silently empty.
    await assert.rejects(
      () => runExport(db, { scope: "managed", project: PROJ_B }),
      (error) => error.code === "42501",
      "a project outside the effective assignment must be denied");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Row authority gates recruited/managed; all uses explicit scope + action only.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-G: directory scopes export full PII without extra grants; all stays restricted", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await addWorker(db, { recruiter: REC_A, workDate: "2026-10-01" });

    // A linked recruiter without pii/payment export capabilities can export only their own rows.
    const own = await runExport(db, { scope: "recruited" });
    assert.equal(own.status, "ok");
    assert.equal(own.rows.length, 1);
    assert.equal(own.rows[0].national_id, "012345678911");
    assert.equal(own.rows[0].account_number, null);
    assert.equal((await audits(db)).at(-1).scope_kind, "own");

    // No all-scope grant means a normal linked recruiter is denied the company-wide export.
    await assert.rejects(() => runExport(db, { scope: "all" }),
      (error) => error.code === "42501", "all must be denied without the all audience");
    await assert.rejects(() => runExport(db, { scope: "everything" }),
      (error) => error.code === "42501", "an unknown scope must be denied");

    // Admin (entry_admin + all scope) succeeds without any field/export capability.
    const directoryAll = await db.query(
      "select public.direct_entry_list_workers($1::uuid,$2::uuid,'all',null,null,null,null,25) as data",
      [ADMIN_AUTH, ADMIN_APP]);
    assert.equal(Array.isArray(directoryAll.rows[0].data.items), true,
      "the all directory audience is open for this actor");
    const all = await runExport(db, { auth: ADMIN_AUTH, app: ADMIN_APP, scope: "all" });
    assert.equal(all.status, "ok");
    assert.equal(all.rows.length, 1);
    const allAudit = (await audits(db)).at(-1);
    assert.equal(allAudit.scope_kind, "all");

    // Legacy field/export rows are inert. They cannot substitute for entry_admin
    // or change_review, even when an actor has explicit all scope.
    const legacyAuth = uuid(36), legacyApp = uuid(46);
    await db.query("insert into auth.users (id) values ($1)", [legacyAuth]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
      " values ($1,$2,true,'Legacy Capability Account')", [legacyApp, legacyAuth]);
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)" +
      " values ($1,'all','2020-01-01',true)", [legacyApp]);
    await grantExportCaps(db, legacyApp);
    await assert.rejects(
      () => runExport(db, { auth: legacyAuth, app: legacyApp, scope: "all" }),
      (error) => error.code === "42501", "legacy tokens do not grant company-wide export");
    assert.equal((await audits(db)).length, 2, "denied legacy actor writes no export audit");

    // Row authority is still required: a linked recruiter without an assignment
    // cannot use the managed scope.
    await assert.rejects(() => runExport(db, { scope: "managed" }),
      (error) => error.code === "42501", "managed needs an effective assignment");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Filters mirror the worker directory; deterministic order.
// ---------------------------------------------------------------------------
test("PRE-W2-P1: filters mirror the worker directory and ordering is deterministic", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await grantExportCaps(db, MGR_APP);
    await addWorker(db, { recruiter: REC_A, workDate: "2026-10-01" });
    await addWorker(db, { recruiter: REC_A, workDate: "2026-10-03",
      employment: [{ status: "UNCONFIRMED", effective: "2026-10-03" },
        { status: "ON", effective: "2026-10-03" }] });
    const off = await addWorker(db, { recruiter: REC_A, workDate: "2026-10-02",
      employment: [{ status: "UNCONFIRMED", effective: "2026-10-02" },
        { status: "OFF", effective: "2026-10-02" }] });

    const all = await runExport(db, { scope: "recruited" });
    assert.deepEqual(all.rows.map((r) => r.first_work_date),
      ["2026-10-03", "2026-10-02", "2026-10-01"], "newest first");

    const onOnly = await runExport(db, { scope: "recruited", employment: "ON" });
    const directory = await db.query(
      "select public.direct_entry_list_workers($1::uuid,$2::uuid,'recruited',null,null,'ON',null,25) as data",
      [MGR_AUTH, MGR_APP]);
    assert.deepEqual(
      onOnly.rows.map((r) => r.employee_code).sort(),
      directory.rows[0].data.items.map((r) => r.employee_code).sort(),
      "the export ON filter matches the directory ON filter");

    const offOnly = await runExport(db, { scope: "recruited", employment: "OFF" });
    assert.deepEqual(offOnly.rows.map((r) => r.employee_code), ["hrp-2026-300003"]);
    assert.ok(off);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Row cap: 10,000 ok; 10,001 -> too_many_rows + persisted REJECTED audit.
// ---------------------------------------------------------------------------
test("PRE-W2-P1: the 10,000/10,001 row cap fails closed with a persisted REJECTED audit", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await grantExportCaps(db, MGR_APP);

    // 10,000 eligible rows -> success. One transaction: the deferred
    // non-empty-submission trigger fires at COMMIT, after the entries exist.
    await db.exec("begin");
    try {
      await db.query(
        "insert into public.direct_entry_candidates (candidate_id)" +
        " select md5('cap-cand-' || g)::uuid from generate_series(1, 10000) g");
      await db.query(
        "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)" +
        " values ($1,$2,'DRAFT')", [uuid(8800), UPLOADER_APP]);
      await db.query(
        "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
        " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
        " provider_type, labor_type)" +
        " select md5('cap-entry-' || g)::uuid, $1, md5('cap-cand-' || g)::uuid, $2, $3," +
        " date '2026-01-01' + (g % 100), 'hrp-2026-' || lpad(g::text, 6, '0')," +
        " jsonb_build_object('display_name','Cap '||g," +
        " 'national_id', jsonb_build_object('state','provided','value','0'||lpad(g::text,11,'0'))," +
        " 'date_of_birth', jsonb_build_object('state','omitted')," +
        " 'address', jsonb_build_object('state','omitted')," +
        " 'phone', jsonb_build_object('state','omitted'))," +
        " $4, $5, 'hrp', 'TEMPORARY'" +
        " from generate_series(1, 10000) g",
        [uuid(8800), UPLOADER_APP, PROJ_A, REC_A, TEAM]);
      await seedLegacyReviewSubmission(db, uuid(8800));
      await db.query(
        "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
        [uuid(8800)]);
      await db.exec("commit");
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }

    const atLimit = await runExport(db, { scope: "recruited" });
    assert.equal(atLimit.status, "ok");
    assert.equal(atLimit.rows.length, 10000);
    assert.equal((await audits(db)).at(-1).outcome, "ALLOW");

    // Add one more -> 10,001 -> too_many_rows, no rows, REJECTED audit persists.
    await addWorker(db, { recruiter: REC_A, workDate: "2026-12-31" });
    const over = await runExport(db, { scope: "recruited" });
    assert.equal(over.status, "too_many_rows");
    assert.equal(over.limit, 10000);
    assert.equal("rows" in over, false, "no worker row on the cap path");

    const after = await audits(db);
    const rejected = after.filter((a) => a.outcome === "REJECTED");
    assert.equal(rejected.length, 1, "the REJECTED cap audit survives the non-raising return");
    assert.equal(rejected[0].denial_code, "EXPORT_ROW_LIMIT_EXCEEDED");
    assert.equal(rejected[0].capability, null);
    assert.equal(rejected[0].scope_kind, "own");
    assert.match(rejected[0].resource_ref, /^worker-export:recruited:10001:[0-9a-f]{64}$/);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. ACL + no capability grant in the migration source.
// ---------------------------------------------------------------------------
test("PRE-W2-P1: the export RPC is service_role-only and the migration grants no capability", async () => {
  const db = await buildDb();
  try {
    const res = await db.query(
      "select p.prosecdef, p.proconfig from pg_proc p where p.oid = $1::regprocedure", [RPC]);
    assert.equal(res.rows[0].prosecdef, true);
    assert.ok(res.rows[0].proconfig.includes("search_path=pg_catalog, public"));
    for (const [role, expected] of [["service_role", true], ["anon", false], ["authenticated", false]]) {
      const priv = await db.query(
        "select has_function_privilege($1, $2::regprocedure, 'EXECUTE') as ok", [role, RPC]);
      assert.equal(priv.rows[0].ok, expected, RPC + " vs " + role);
    }
    const count = (await db.query(
      "select count(*)::int as n from pg_proc p where p.oid = $1::regprocedure", [RPC])).rows[0].n;
    assert.equal(count, 1, "exactly one export RPC");
  } finally {
    await db.close();
  }

  const sql = await readFile(path.join(MIGRATION_DIR, EXPORT_MIGRATION_NAME), "utf8");
  assert.doesNotMatch(sql, /insert into public\.direct_entry_capability_grants/,
    "the migration must not grant a capability");
  assert.doesNotMatch(sql, /direct_entry_rpc_idempotency|direct_entry_idempotency_begin/,
    "the export must not use idempotency");
});

// ---------------------------------------------------------------------------
// 7. PRE-W2-HF-E: BoD/Accounting (change_review + all scope) audience + Ghi chú.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-E: change_review + all scope exports all workers with the Ghi chú column", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const reviewerAuth = uuid(35), reviewerApp = uuid(45);
    await db.query("insert into auth.users (id) values ($1)", [reviewerAuth]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
      " values ($1,$2,true,'Reviewer Account')", [reviewerApp, reviewerAuth]);
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)" +
      " values ($1,'all','2020-01-01',true)", [reviewerApp]);
    await grant(db, reviewerApp, "change_review");
    await grantExportCaps(db, reviewerApp);

    await addWorker(db, { recruiter: REC_A, workDate: "2026-10-01", generalNote: "Note A" });
    await addWorker(db, { recruiter: REC_B, workDate: "2026-10-02", generalNote: "Note B" });

    const payload = await runExport(db, { auth: reviewerAuth, app: reviewerApp, scope: "all" });
    assert.equal(payload.status, "ok");
    assert.equal(payload.rows.length, 2, "change_review + all scope exports the whole directory");
    assert.deepEqual(payload.rows.map((r) => r.general_note).sort(), ["Note A", "Note B"]);
    const [audit] = await audits(db);
    assert.equal(audit.scope_kind, "all");
    assert.equal(audit.outcome, "ALLOW");
    assert.match(audit.resource_ref, /^worker-export:all:2:[0-9a-f]{64}$/);

    // A recruiter/PM with legacy field/export rows but no all scope is still denied `all`.
    await grantExportCaps(db, MGR_APP);
    await assert.rejects(() => runExport(db, { scope: "all" }),
      (error) => error.code === "42501", "recruiter/PM must not export all");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 8. HF: first_work_date range, provider_type (hrp/vendor), and search filters
//    keep directory rows, summary counts, and export rows in sync.
// ---------------------------------------------------------------------------
test("HF: worker directory and export filters support first_work_date range, provider_type, and search", async () => {
  const db = await buildDb();
  try {
    await seed(db);

    const w1 = await addWorker(db, {
      project: PROJ_A,
      recruiter: REC_A,
      workDate: "2026-10-01",
    });
    const w2 = await addWorker(db, {
      project: PROJ_A,
      recruiter: REC_A,
      workDate: "2026-10-10",
      laborType: "PERMANENT",
    });
    await db.query(
      "update public.recruiter_provider_memberships set provider_type = 'vendor' where recruiter_id = $1",
      [REC_B],
    );
    const w3 = await addWorker(db, {
      project: PROJ_B,
      recruiter: REC_B,
      workDate: "2026-10-15",
      providerType: "vendor",
    });
    assert.ok(w1 && w2 && w3);

    // 1. Date range filter [2026-10-05 .. 2026-10-20] returns w2 and w3
    const listRange = (await db.query(
      "select public.direct_entry_list_workers(" +
        "$1::uuid,$2::uuid,'all',null,null,null,null,25,null," +
        "'2026-10-05'::date,'2026-10-20'::date,null" +
      ") as data",
      [ADMIN_AUTH, ADMIN_APP],
    )).rows[0].data;
    assert.equal(listRange.items.length, 2);
    assert.deepEqual(listRange.summary, {
      total_workers: 2,
      project_count: 2,
      recruiter_count: 2,
    });

    const expRange = (await db.query(
      "select public.direct_entry_export_workers(" +
        "$1::uuid,$2::uuid,'all',null,null,null,'range export',null," +
        "'2026-10-05'::date,'2026-10-20'::date,null" +
      ") as data",
      [ADMIN_AUTH, ADMIN_APP],
    )).rows[0].data;
    assert.equal(expRange.status, "ok");
    assert.equal(expRange.rows.length, 2);
    assert.deepEqual(
      expRange.rows.map((r) => r.employee_code),
      listRange.items.map((r) => r.employee_code),
    );

    // 2. Provider type filter ('vendor') returns only w3
    const listVendor = (await db.query(
      "select public.direct_entry_list_workers(" +
        "$1::uuid,$2::uuid,'all',null,null,null,null,25,null," +
        "null,null,'vendor'" +
      ") as data",
      [ADMIN_AUTH, ADMIN_APP],
    )).rows[0].data;
    assert.equal(listVendor.items.length, 1);
    assert.equal(listVendor.items[0].entry_id, w3);
    assert.deepEqual(listVendor.summary, {
      total_workers: 1,
      project_count: 1,
      recruiter_count: 1,
    });

    const expVendor = (await db.query(
      "select public.direct_entry_export_workers(" +
        "$1::uuid,$2::uuid,'all',null,null,null,'vendor export',null," +
        "null,null,'vendor'" +
      ") as data",
      [ADMIN_AUTH, ADMIN_APP],
    )).rows[0].data;
    assert.equal(expVendor.status, "ok");
    assert.equal(expVendor.rows.length, 1);
    assert.equal(expVendor.rows[0].provider_type, "Vendor");

    // 2b. Labor type filter ('PERMANENT') returns only w2 and keeps summary + export in sync
    const listPermanent = (await db.query(
      "select public.direct_entry_list_workers(" +
        "$1::uuid,$2::uuid,'all',null,null,null,null,25,null," +
        "null,null,null,'PERMANENT'" +
      ") as data",
      [ADMIN_AUTH, ADMIN_APP],
    )).rows[0].data;
    assert.equal(listPermanent.items.length, 1);
    assert.equal(listPermanent.items[0].entry_id, w2);
    assert.equal(listPermanent.items[0].labor_type, "PERMANENT");
    assert.deepEqual(listPermanent.summary, {
      total_workers: 1,
      project_count: 1,
      recruiter_count: 1,
    });

    const expPermanent = (await db.query(
      "select public.direct_entry_export_workers(" +
        "$1::uuid,$2::uuid,'all',null,null,null,'permanent export',null," +
        "null,null,null,'PERMANENT'" +
      ") as data",
      [ADMIN_AUTH, ADMIN_APP],
    )).rows[0].data;
    assert.equal(expPermanent.status, "ok");
    assert.equal(expPermanent.rows.length, 1);
    assert.equal(expPermanent.rows[0].employee_code, listPermanent.items[0].employee_code);

    // 3. Invalid date range (from > to), invalid provider_type, or invalid labor_type raises 22023
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_list_workers(" +
          "$1::uuid,$2::uuid,'all',null,null,null,null,25,null," +
          "'2026-10-20'::date,'2026-10-05'::date,null" +
        ")",
        [ADMIN_AUTH, ADMIN_APP],
      ),
      (err) => err.code === "22023",
    );
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_export_workers(" +
          "$1::uuid,$2::uuid,'all',null,null,null,'bad range',null," +
          "'2026-10-20'::date,'2026-10-05'::date,null" +
        ")",
        [ADMIN_AUTH, ADMIN_APP],
      ),
      (err) => err.code === "22023",
    );
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_list_workers(" +
          "$1::uuid,$2::uuid,'all',null,null,null,null,25,null," +
          "null,null,'invalid'" +
        ")",
        [ADMIN_AUTH, ADMIN_APP],
      ),
      (err) => err.code === "22023",
    );
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_list_workers(" +
          "$1::uuid,$2::uuid,'all',null,null,null,null,25,null," +
          "null,null,null,'invalid-labor'" +
        ")",
        [ADMIN_AUTH, ADMIN_APP],
      ),
      (err) => err.code === "22023",
    );
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_export_workers(" +
          "$1::uuid,$2::uuid,'all',null,null,null,'bad labor',null," +
          "null,null,null,'invalid-labor'" +
        ")",
        [ADMIN_AUTH, ADMIN_APP],
      ),
      (err) => err.code === "22023",
    );
  } finally {
    await db.close();
  }
});
