/**
 * P2.5-HF - worker create authority + CCCD rehire (DB regression, PGlite).
 *
 * Proves the hotfix contract at the DB boundary:
 *   * creation authority is the effective project-manager assignment on the row's
 *     project (several managers equal), never created_by / recruiter / team /
 *     first_work_date, and no global capability is handed to a manager;
 *   * the legacy Admin bundle keeps working unchanged;
 *   * one unauthorized row fails the whole batch with zero residue;
 *   * a rehire is a NEW entry (server employee_code + entry_id) allowed only when
 *     every earlier episode of the normalized CCCD is OFF; ON / UNCONFIRMED / missing
 *     status fail closed with a stable code and no CCCD in the message;
 *   * the narrow lookup returns the minimum episode fields and refuses non-managers.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const HF_MIGRATION = "20261008180000_p2_5_hf_worker_create_and_rehire.sql";
const INITIAL_ON_MIGRATION = "20261008170000_p2_5_initial_employment_status_on.sql";
const R2_MIGRATION = "20261008200000_p2_5_hf_r2_cccd_canonicalization_guard.sql";
const R3_MIGRATION = "20261008210000_p2_5_hf_r3_worker_full_correction.sql";
const R6_MIGRATION = "20261008230000_p2_5_hf_r6_manager_initial_status.sql";
const R7_MIGRATION = "20261008240000_p2_5_hf_r7_deferred_submission_trigger_boundary.sql";
const VENDOR_DOCUMENT_MIGRATION = "20261009010000_p3_w07a_r3_vendor_hidden_team_and_document_upload.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "hf_proj_a", PROJ_B = "hf_proj_b";
const REC_A = uuid(21), REC_B = uuid(22), REC_C = uuid(23), REC_D = uuid(24);
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const MGR_A_AUTH = uuid(32), MGR_A_APP = uuid(42);
const MGR_B_AUTH = uuid(33), MGR_B_APP = uuid(43);
const MGR_C_AUTH = uuid(34), MGR_C_APP = uuid(44);
const UPLOADER_AUTH = uuid(35), UPLOADER_APP = uuid(45);
const RECRUITER_AUTH = uuid(36), RECRUITER_APP = uuid(46);

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")
    .sort();
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(VENDOR_DOCUMENT_MIGRATION), 64, "P3-W07A-R3 remains #65");
  assert.equal(names.indexOf(R7_MIGRATION), 63, "P2.5-HF-R7 remains #64");
  assert.equal(names.indexOf(R6_MIGRATION), 62, "P2.5-HF-R6 remains #63");
  assert.equal(names.indexOf(R3_MIGRATION), 60, "P2.5-HF-R3 remains #61");
  assert.equal(names.indexOf(R2_MIGRATION), 59, "P2.5-HF-R2 remains #60");
  assert.equal(names.indexOf(HF_MIGRATION), 57, "P2.5-HF remains #58");
  assert.equal(names.indexOf(INITIAL_ON_MIGRATION), 56, "P2.5-HF follows #57");
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

async function assignManager(db, { project, recruiter, app, validFrom = "2020-01-01", validTo = null }) {
  if ((await db.query(
    "select count(*)::int as n from public.direct_entry_app_user_recruiter_links" +
    " where app_user_id = $1::uuid and recruiter_id = $2::uuid and is_current", [app, recruiter])).rows[0].n === 0) {
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links" +
      " (app_user_id, recruiter_id, verified, valid_from, is_current)" +
      " values ($1,$2,true,'2020-01-01',true)", [app, recruiter]);
  }
  await db.query(
    "insert into public.direct_entry_project_manager_assignments" +
    " (project_id, manager_recruiter_id, valid_from, valid_to, revoked_at, is_current)" +
    " values ($1,$2,$3::date,$4::date, case when $4::date is null then null else now() end,$5)",
    [project, recruiter, validFrom, validTo, validTo === null]);
}

async function seed(db) {
  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_HF','Team HF')", [TEAM]);
  for (const [project, name] of [[PROJ_A, "Project HF A"], [PROJ_B, "Project HF B"]]) {
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ($1,$2)",
      [project, name]);
  }
  for (const [recruiter, name] of [[REC_A, "Recruiter A"], [REC_B, "Recruiter B"],
    [REC_C, "Recruiter C"], [REC_D, "Recruiter D"]]) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1,$2)", [recruiter, name]);
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
      " values ($1,'hrp','2020-01-01',true)", [recruiter]);
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [recruiter, TEAM]);
  }
  // Admin keeps the legacy bundle (entry_create + submission_create + own scope).
  await insertActor(db, ADMIN_AUTH, ADMIN_APP,
    ["entry_admin", "entry_create", "submission_create",
      "employment_status.apply", "change_request_create"], "own");
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)" +
    " values ($1,'all','2020-01-01',true)", [ADMIN_APP]);
  // Managers hold NO global create capability and no scope grant.
  await insertActor(db, MGR_A_AUTH, MGR_A_APP, ["change_request_create"]);
  await insertActor(db, MGR_B_AUTH, MGR_B_APP, ["change_request_create"]);
  await insertActor(db, MGR_C_AUTH, MGR_C_APP, ["change_request_create"]);
  // Uploader has the global bundle but manages nothing.
  await insertActor(db, UPLOADER_AUTH, UPLOADER_APP,
    ["entry_create", "submission_create", "change_request_create"], "own");
  // Recruiter is linked but has no assignment.
  await insertActor(db, RECRUITER_AUTH, RECRUITER_APP, ["change_request_create"]);
  await assignManager(db, { project: PROJ_A, recruiter: REC_A, app: MGR_A_APP });
  await assignManager(db, { project: PROJ_A, recruiter: REC_B, app: MGR_B_APP, validFrom: "2026-01-01" });
  // REC_D manages only project B, so MGR_C is never an effective manager of project A.
  await assignManager(db, { project: PROJ_B, recruiter: REC_D, app: MGR_C_APP });
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)",
    [RECRUITER_APP, REC_C]);
}

/** The batch RPCs require a UUID-shaped idempotency key; a counter stays unique. */
let keySeq = 0;
function idemKey() {
  keySeq += 1;
  return "00000000-0000-4000-8000-" + String(keySeq).padStart(12, "0");
}

/** worker_details WITHOUT display_name: the row's top-level field supplies it. */
function workerDetails(cccd) {
  return {
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: cccd === null ? { state: "unknown" } : { state: "provided", value: cccd },
    address: { state: "provided", value: "HF address" },
    phone: { state: "provided", value: "0900000000" },
  };
}

function batchRow({ project = PROJ_A, recruiter = REC_A, date = "2026-10-01", cccd = null,
  name = "HF Worker", provider = "hrp", payment = null, employment = null, code = null }) {
  const row = {
    project_id: project,
    first_work_date: date,
    provider_type: provider,
    recruiter_id: recruiter,
    labor_type: "TEMPORARY",
    display_name: name,
    worker_details: workerDetails(cccd),
  };
  if (code !== null) row.employee_code = code;
  if (payment !== null) row.payment = payment;
  if (employment !== null) row.employment = employment;
  return row;
}

/** Inner worker-profile/1.0 batch (explicit employee_code, no provider_type field). */
async function createBatchV1(db, { rows, key, auth, app }) {
  const v1Rows = rows.map((row) => { const copy = { ...row }; delete copy.provider_type; return copy; });
  const res = await db.query(
    "select public.direct_entry_create_full_profile_batch($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text) as data",
    [auth, app, "worker-profile/1.0", JSON.stringify(v1Rows), idemKey(key)]);
  return res.rows[0].data;
}

/** Public worker-profile/1.1 batch (server-generated employee codes). */
async function createBatchV2(db, { rows, key, auth, app }) {
  const res = await db.query(
    "select public.direct_entry_create_full_profile_batch_v2($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text) as data",
    [auth, app, "worker-profile/1.1", JSON.stringify(rows), idemKey(key)]);
  return res.rows[0].data;
}

async function createLegacyBatch(db, { rows, key, auth, app }) {
  const res = await db.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text) as data",
    [auth, app, JSON.stringify(rows), idemKey(key)]);
  return res.rows[0].data;
}

async function count(db, sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

async function residue(db) {
  return {
    entries: await count(db, "select count(*)::int as n from public.direct_entries"),
    submissions: await count(db, "select count(*)::int as n from public.direct_entry_submissions"),
    reasons: await count(db, "select count(*)::int as n from public.direct_entry_restricted_reasons"),
    audits: await count(db, "select count(*)::int as n from public.direct_entry_audit_events"),
    idempotency: await count(db, "select count(*)::int as n from public.direct_entry_rpc_idempotency"),
  };
}

/**
 * A previous episode for one CCCD, inserted directly so its employment history is
 * exactly the case under test (the status table is append-only by design).
 */
let episodeSeq = 0;
async function seedEpisode(db, { cccd, name, project = PROJ_A, date = "2026-01-05", status }) {
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
    await db.query(
      "update public.direct_entry_submissions set state='SUBMITTED', version=2 where submission_id=$1",
      [submission]);
    // The status validator only accepts UNCONFIRMED or ON as the initial event, so a
    // prior OFF episode is ON then OFF (an append-only history, never an update).
    const steps = status === "OFF" ? ["ON", "OFF"]
      : status === null ? [] : [status];
    if (steps.length > 0) {
      const reasonId = (await db.query(
        "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
        " values ($1,'HF episode status') returning reason_id::text as id", [ADMIN_APP])).rows[0].id;
      for (const [index, step] of steps.entries()) {
        await db.query(
          "insert into public.direct_entry_employment_status_events" +
          " (entry_id, status, effective_date, leave_date, leave_reason_text, version," +
          " actor_user_id, reason_id)" +
          " values ($1,$2,$3::date, case when $2 = 'OFF' then $3::date else null end," +
          " case when $2 = 'OFF' then 'HF synthetic leave' else null end, $4,$5,$6)",
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

// ---------------------------------------------------------------------------
// 1. Assigned project manager may create; everyone else stays refused.
// ---------------------------------------------------------------------------
test("HF: the assigned project manager creates full-profile rows (v1 and v2, quick add)", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // v1 contract 1.0 with an explicit server-shaped code.
    const v1 = await createBatchV1(db, {
      rows: [batchRow({ cccd: "111111111111", name: "HF One", code: "hrp-2026-900001" })],
      key: "hf-v1", auth: MGR_A_AUTH, app: MGR_A_APP,
    });
    assert.equal(v1.entry_ids.length, 1);
    // v2 contract 1.1: employee_code is generated by the server.
    const v2 = await createBatchV2(db, {
      rows: [batchRow({ cccd: "222222222222", name: "HF Two" })],
      key: "hf-v2", auth: MGR_A_AUTH, app: MGR_A_APP,
    });
    assert.match(v2.employee_codes[0], /^hrp-2026-[0-9]{6}$/);
    // The second manager of the same project has the same authority.
    const second = await createBatchV2(db, {
      rows: [batchRow({ cccd: "333333333333", name: "HF Three" })],
      key: "hf-v2-second", auth: MGR_B_AUTH, app: MGR_B_APP,
    });
    assert.equal(second.entry_ids.length, 1);
    // The legacy v1 batch is one of the four patched create paths: a manager may use it.
    const legacy = await createLegacyBatch(db, {
      rows: [{ project_id: PROJ_A, first_work_date: "2026-10-06", employee_code: "hrp-2026-900006",
        labor_type: "TEMPORARY", recruiter_id: REC_A,
        worker_details: { display_name: "HF Legacy", ...workerDetails("666666666666") } }],
      key: "hf-legacy", auth: MGR_A_AUTH, app: MGR_A_APP,
    });
    assert.equal(legacy.entry_ids.length, 1);
    // Initial status is the #57 ON default.
    const statuses = await db.query(
      "select status, count(*)::int as n from public.direct_entry_employment_status_events" +
      " group by 1");
    assert.deepEqual(statuses.rows, [{ status: "ON", n: 4 }]);
    // Quick add (draft row) uses the same authority.
    const quick = await createBatchV2(db, {
      rows: [batchRow({ cccd: "444444444444", name: "HF Four" })],
      key: "hf-quick-submission", auth: MGR_A_AUTH, app: MGR_A_APP,
    });
    const draft = await db.query(
      "select public.direct_entry_create_draft_row($1::uuid,$2::uuid,$3::uuid,$4::integer," +
      "$5::jsonb,$6::text) as data",
      [MGR_A_AUTH, MGR_A_APP,
        (await db.query("select submission_id from public.direct_entries where entry_id = $1::uuid",
          [quick.entry_ids[0]])).rows[0].submission_id,
        1, JSON.stringify({
          project_id: PROJ_A, first_work_date: "2026-10-05", employee_code: "hrp-2026-900005",
          labor_type: "TEMPORARY", recruiter_id: REC_A,
          worker_details: { display_name: "HF Five", ...workerDetails("555555555555") },
        }), "hf-quick-row"]);
    assert.ok(draft.rows[0].data.entry_id);
  } finally {
    await db.close();
  }
});

test("HF: manager outside the project, wrong assignment state and non-managers are refused", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const before = await residue(db);
    const attempts = [
      ["manager A on project B", MGR_A_AUTH, MGR_A_APP, PROJ_B],
      ["uploader not a manager", UPLOADER_AUTH, UPLOADER_APP, PROJ_A],
      ["recruiter without assignment", RECRUITER_AUTH, RECRUITER_APP, PROJ_A],
    ];
    for (const [label, auth, app, target] of attempts) {
      await assert.rejects(
        () => createBatchV2(db, { rows: [batchRow({ project: target, cccd: null, name: label })],
          key: "deny-" + label, auth, app }),
        (error) => error.code === "42501", label);
    }
    // Future and expired assignments are inert: REC_C (already linked to the recruiter
    // actor) gets a future assignment on project A and an expired one on project B.
    await db.query(
      "insert into public.direct_entry_project_manager_assignments" +
      " (project_id, manager_recruiter_id, valid_from) values ($1,$2,'2099-01-01'::date)",
      [PROJ_A, REC_C]);
    await db.query(
      "insert into public.direct_entry_project_manager_assignments" +
      " (project_id, manager_recruiter_id, valid_from, valid_to, revoked_at)" +
      " values ($1,$2,'2020-01-01'::date,'2021-01-01'::date, now())", [PROJ_B, REC_C]);
    for (const [label, project] of [["future assignment", PROJ_A],
      ["expired assignment", PROJ_B]]) {
      await assert.rejects(
        () => createBatchV2(db, { rows: [batchRow({ project, cccd: null, name: "HF " + label })],
          key: "deny-" + label, auth: RECRUITER_AUTH, app: RECRUITER_APP }),
        (error) => error.code === "42501", label);
    }
    assert.deepEqual(await residue(db), before, "a refused create leaves no residue");
  } finally {
    await db.close();
  }
});

test("HF-R6: assigned manager may create an explicit OFF profile without a global status capability", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const manager = await createBatchV2(db, {
      rows: [batchRow({
        date: "2026-10-01",
        cccd: "121212121212",
        name: "HF Manager Historical",
        payment: { state: "provided", bank_name: "Text Bank" },
        employment: {
          initial_status: "OFF",
          leave_date: "2026-10-07",
          leave_reason_text: "Synthetic historical departure",
        },
      })],
      key: "hf-r6-manager-off",
      auth: MGR_A_AUTH,
      app: MGR_A_APP,
    });
    const history = await db.query(
      "select status, version from public.direct_entry_employment_status_events" +
      " where entry_id = $1::uuid order by version",
      [manager.entry_ids[0]],
    );
    assert.deepEqual(history.rows, [
      { status: "ON", version: 1 },
      { status: "OFF", version: 2 },
    ]);

    const before = await residue(db);
    await assert.rejects(
      () => createBatchV2(db, {
        rows: [batchRow({
          date: "2026-10-01",
          cccd: "131313131313",
          name: "HF Legacy Explicit Off",
          employment: {
            initial_status: "OFF",
            leave_date: "2026-10-07",
            leave_reason_text: "Synthetic legacy departure",
          },
        })],
        key: "hf-r6-legacy-off",
        auth: UPLOADER_AUTH,
        app: UPLOADER_APP,
      }),
      (error) => error.code === "42501",
      "legacy/global create path still requires employment_status.apply",
    );
    assert.deepEqual(await residue(db), before, "the refused legacy row leaves zero residue");
  } finally {
    await db.close();
  }
});

test("HF: a mixed-project batch is refused whole, and the Admin path is unchanged", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const before = await residue(db);
    await assert.rejects(
      () => createBatchV2(db, {
        rows: [batchRow({ project: PROJ_A, cccd: "666666666666", name: "HF Allowed" }),
          batchRow({ project: PROJ_B, cccd: "777777777777", name: "HF Forbidden" })],
        key: "hf-mixed", auth: MGR_A_AUTH, app: MGR_A_APP,
      }),
      (error) => error.code === "42501", "mixed batch");
    assert.deepEqual(await residue(db), before,
      "one unauthorized row leaves no entry, submission, reason, audit or idempotency row");

    // Admin keeps the legacy bundle: any project, including the bank text fields.
    const admin = await createBatchV2(db, {
      rows: [batchRow({ project: PROJ_B, cccd: "888888888888", name: "HF Admin",
        payment: { state: "provided", account_number: "012345678901",
          bank_name: "Synthetic Bank", account_holder_name: "HF Holder" } })],
      key: "hf-admin", auth: ADMIN_AUTH, app: ADMIN_APP,
    });
    assert.equal(admin.entry_ids.length, 1);
    const payment = await db.query(
      "select account_number, bank_name from public.direct_entry_payments where entry_id = $1::uuid",
      [admin.entry_ids[0]]);
    assert.deepEqual(payment.rows[0],
      { account_number: "012345678901", bank_name: "Synthetic Bank" });
  } finally {
    await db.close();
  }
});

test("HF-R7: service_role can commit a valid batch through the deferred submission trigger", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const boundary = await db.query(
      "select p.prosecdef as security_definer," +
      " has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute," +
      " has_table_privilege('service_role','public.direct_entry_submissions','SELECT,INSERT,UPDATE,DELETE')" +
      " as service_table_access" +
      " from pg_proc p where p.oid=" +
      " 'public.direct_entry_require_nonempty_submission()'::regprocedure",
    );
    assert.deepEqual(boundary.rows[0], {
      security_definer: true,
      service_execute: false,
      service_table_access: false,
    });

    await db.exec("begin; set local role service_role;");
    let created;
    try {
      created = await createBatchV2(db, {
        rows: [batchRow({ cccd: null, name: "HF Deferred Commit" })],
        key: "hf-r7-deferred-commit",
        auth: MGR_A_AUTH,
        app: MGR_A_APP,
      });
      await db.exec("commit");
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }

    assert.equal(created.entry_ids.length, 1);
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_submissions"), 1,
    "the real COMMIT, not a rollback-only probe, completes under service_role");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. CCCD rehire.
// ---------------------------------------------------------------------------
test("HF: a rehire after a closed episode creates a brand new episode", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const previous = await seedEpisode(db, { cccd: "999999999999", name: "HF Rehire",
      status: "OFF" });
    const before = await db.query(
      "select entry_id, employee_code, version, worker_details from public.direct_entries" +
      " where entry_id = $1::uuid", [previous.entryId]);

    const created = await createBatchV2(db, {
      rows: [batchRow({ project: PROJ_B, date: "2026-10-02", cccd: "999999999999",
        name: "HF Rehire" })],
      key: "hf-rehire", auth: MGR_C_AUTH, app: MGR_C_APP,
    });
    const newEntry = created.entry_ids[0];
    assert.notEqual(newEntry, previous.entryId, "a rehire is a new entry");
    assert.notEqual(created.employee_codes[0], previous.employeeCode,
      "a rehire gets a new server-generated employee code");
    const after = await db.query(
      "select entry_id, employee_code, version, worker_details from public.direct_entries" +
      " where entry_id = $1::uuid", [previous.entryId]);
    assert.deepEqual(after.rows[0], before.rows[0], "the earlier episode is never touched");
    assert.equal(await count(db,
      "select count(*)::int as n from public.direct_entry_employment_status_events" +
      " where entry_id = $1::uuid and status = 'ON'", [newEntry]), 1,
    "the new episode starts ON");
  } finally {
    await db.close();
  }
});

test("HF: ON, UNCONFIRMED and unknown prior episodes no longer block a new episode", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // P3.1-HF: #58/#59 refused a second live episode for one canonical CCCD. That business
    // block is gone on every write path - the duplicate is reported, never blocked.
    for (const [index, status] of ["ON", "UNCONFIRMED", null].entries()) {
      const cccd = "10000000000" + index;
      const previous = await seedEpisode(db, { cccd, name: "HF Shared " + index, status });
      const created = await createBatchV2(db, { rows: [batchRow({ date: "2026-10-02", cccd,
        name: "HF Shared " + index })], key: "hf-shared-" + index,
        auth: MGR_A_AUTH, app: MGR_A_APP });
      assert.equal(created.entry_ids.length, 1,
        String(status) + " prior episode must not block the new episode");
      assert.notEqual(created.entry_ids[0], previous.entryId, "the new episode is a new entry");
      const still = await db.query(
        "select count(*)::int as n from public.direct_entries where entry_id = $1::uuid",
        [previous.entryId]);
      assert.equal(still.rows[0].n, 1, "the earlier episode survives untouched");
    }
    // The in-batch duplicate check is gone too: one batch may carry two rows of one worker.
    const before = await residue(db);
    const twins = await createBatchV2(db, {
      rows: [batchRow({ cccd: "200000000000", name: "HF Twin" }),
        batchRow({ cccd: "200000000000", name: "HF Twin" })],
      key: "hf-twin", auth: MGR_A_AUTH, app: MGR_A_APP,
    });
    assert.equal(twins.entry_ids.length, 2, "both rows of the twin batch are written");
    assert.notEqual(twins.entry_ids[0], twins.entry_ids[1]);
    assert.equal((await residue(db)).entries, before.entries + 2, "exactly two new episodes");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Narrow rehire lookup.
// ---------------------------------------------------------------------------
test("HF: the rehire lookup returns the minimum fields and refuses non-managers", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const a = await seedEpisode(db, { cccd: "300000000000", name: "HF Lookup",
      project: PROJ_A, date: "2026-01-05", status: "OFF" });
    await seedEpisode(db, { cccd: "300000000000", name: "HF Lookup", project: PROJ_B,
      date: "2026-03-05", status: "ON" });

    const LOOKUP = "select public.direct_entry_lookup_worker_episodes(" +
      "$1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::int,$7::int) as data";
    const lookup = async (auth, app, query = {}) => (await db.query(LOOKUP, [
      auth, app, query.project ?? PROJ_A, query.name ?? null, query.cccd ?? null,
      query.pageSize ?? 20, query.offset ?? 0,
    ])).rows[0].data;

    const manager = await lookup(MGR_A_AUTH, MGR_A_APP, { cccd: "300000000000" });
    assert.equal(manager.match, "national_id");
    assert.equal(manager.workers.length, 1, "the exact CCCD resolves to one worker");
    const worker = manager.workers[0];
    assert.equal(worker.episode_count, 2, "history is visible across projects");
    assert.equal(worker.active_episode_exists, true);
    assert.equal(worker.rehire_allowed, false);
    assert.deepEqual(Object.keys(worker).sort(), [
      "active_episode_exists", "display_name", "employee_code", "episode_count",
      "episodes", "rehire_allowed",
    ]);
    assert.deepEqual(Object.keys(worker.episodes[0]).sort(), [
      "display_name", "employee_code", "entry_id", "first_work_date", "latest_status",
      "project_display", "project_id",
    ]);
    // The match literal is the only place the words "national_id" may appear.
    const serialized = JSON.stringify(manager.workers);
    for (const forbidden of ["300000000000", "1990-01-01", "HF address", "0900000000",
      "account_number", "bank_name", "national_id", "date_of_birth", "phone"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden + " must never leak");
    }

    // A manager of another project, an uploader and a recruiter are refused.
    for (const [label, auth, app] of [
      ["manager of another project", MGR_C_AUTH, MGR_C_APP],
      ["uploader", UPLOADER_AUTH, UPLOADER_APP],
      ["recruiter", RECRUITER_AUTH, RECRUITER_APP],
    ]) {
      await assert.rejects(() => lookup(auth, app, { cccd: "300000000000" }),
        (error) => error.code === "42501", label);
    }
    // The all-scope administrator may look up too.
    const admin = await lookup(ADMIN_AUTH, ADMIN_APP, { cccd: "300000000000" });
    assert.equal(admin.workers[0].episode_count, 2);
    assert.notEqual(a.entryId, null);
    // At least one lookup key is required; R1 accepts name-only or CCCD-only.
    await assert.rejects(
      () => lookup(MGR_A_AUTH, MGR_A_APP, {}),
      (error) => error.code === "22023");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Authority mechanics: helper, guard and no direct-edit after SUBMITTED.
// ---------------------------------------------------------------------------
test("HF: the authority helper, the dropped episode guard and the SUBMITTED boundary", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const authority = async (auth, app, project, date = "2026-10-01") => (await db.query(
      "select public.direct_entry_create_authority($1::uuid,$2::uuid,$3::text,$4::date) as kind",
      [auth, app, project, date])).rows[0].kind;
    assert.equal(await authority(MGR_A_AUTH, MGR_A_APP, PROJ_A), "manager");
    assert.equal(await authority(ADMIN_AUTH, ADMIN_APP, PROJ_B), "legacy");
    await assert.rejects(() => authority(MGR_A_AUTH, MGR_A_APP, PROJ_B),
      (error) => error.code === "42501");
    assert.equal(await authority(UPLOADER_AUTH, UPLOADER_APP, PROJ_A), "legacy",
      "the legacy admin bundle is unchanged, it does not need an assignment");
    await assert.rejects(() => authority(RECRUITER_AUTH, RECRUITER_APP, PROJ_A),
      (error) => error.code === "42501",
      "a recruiter link and created_by never authorize a create");

    // ACL: the helper stays internal, the lookup is service_role only.
    for (const signature of [
      "public.direct_entry_create_authority(uuid, uuid, text, date)",
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
    const trigger = await db.query(
      "select tgname from pg_trigger where tgrelid = 'public.direct_entries'::regclass" +
      " and not tgisinternal and tgname = 'direct_entry_active_episode_guard'");
    assert.equal(trigger.rows.length, 0, "the duplicate-CCCD row guard trigger is gone");
    const index = await db.query(
      "select count(*)::int as n from pg_indexes where schemaname='public'" +
      " and indexname='direct_entries_worker_national_id_uidx'");
    assert.equal(index.rows[0].n, 0, "the one-row-per-CCCD index is gone");

    // A SUBMITTED row still accepts no direct mutation, manager or not.
    const created = await createBatchV2(db, {
      rows: [batchRow({ cccd: "400000000000", name: "HF Boundary" })],
      key: "hf-boundary", auth: MGR_A_AUTH, app: MGR_A_APP,
    });
    const entryId = created.entry_ids[0];
    const submissionId = (await db.query(
      "select submission_id from public.direct_entries where entry_id = $1::uuid",
      [entryId])).rows[0].submission_id;
    await db.query(
      "update public.direct_entry_submissions set state='SUBMITTED', version=2 where submission_id=$1",
      [submissionId]);
    const before = await residue(db);
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_update_payment($1::uuid,$2::uuid,$3::uuid,$4::integer," +
        "$5::integer,$6::jsonb,$7::text,$8::text)",
        [MGR_A_AUTH, MGR_A_APP, entryId, 1, 1,
          JSON.stringify({ state: "provided", account_number: "999999999999", bank_id: null,
            account_holder_name: "HF Forged" }), "HF forged payment", "hf-forged"]),
      (error) => error.code === "42501", "no direct edit after SUBMITTED");
    assert.deepEqual(await residue(db), before);
  } finally {
    await db.close();
  }
});
