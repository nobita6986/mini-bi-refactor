/**
 * P3.1-HF - mot CMT/CCCD canonical trung nhau duoc BAO CAO, khong bao gio bi CHAN.
 *
 * Finding: cohort P2.5-HF khien mot CMT/CCCD canonical chi giu duoc mot episode song. Import,
 * chinh sua hoac rehire mot episode thu hai hop le (khac project, khac episode cua cung mot
 * nguoi, dong lich su) that bai bang loi nghiep vu, trong khi khong co quy tac domain nao cam
 * dieu do - va khong man hinh nao cho biet profile nao dang trung.
 *
 * Lane nay khoa hai nua cua hotfix:
 *   1. moi raiser duplicate-CCCD o tang nghiep vu (in-batch, row guard, status-event guard,
 *      unique index) da bi go bo, trong khi format validation 9/12 chu so va quy tac canonical
 *      giu nguyen byte-for-byte;
 *   2. bao cao duplicate chi doc: masked (4 chu so cuoi), bounded, deterministic, khong tra ve
 *      UUID nao, va chi Full Admin / catalog_master_manage / entry_privileged_edit o all scope
 *      moi doc duoc.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";
import {
  projectDuplicateCccdReportRpcPage,
  projectDuplicateCccdReportResponse,
} from "../src/lib/direct-entry/duplicate-cccd-report-contract.ts";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const HOTFIX_MIGRATION = "20261009100000_p3_1_hf_duplicate_cccd_reporting.sql";
const PREVIOUS_MIGRATION = "20261009090000_p3_1_hf_recruiter_alias_backfill.sql";
const R3_MIGRATION = "20261008210000_p2_5_hf_r3_worker_full_correction.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "hf_dup_proj_a";
const PROJ_B = "hf_dup_proj_b";
const PROJ_C = "hf_dup_proj_c";
const REC_A = uuid(21);

// Full Admin (legacy triple) / Accounting-Admin / BoD / entry_admin-only / change_review /
// team leader / mapped without any capability.
const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const ACC_AUTH = uuid(32), ACC_APP = uuid(42);
const BOD_AUTH = uuid(33), BOD_APP = uuid(43);
const LONE_AUTH = uuid(34), LONE_APP = uuid(44);
const REVIEW_AUTH = uuid(35), REVIEW_APP = uuid(45);
const LEADER_AUTH = uuid(36), LEADER_APP = uuid(46);
const OUTSIDE_AUTH = uuid(37), OUTSIDE_APP = uuid(47);
// Full Admin triple, but only team scope: proves the reader needs an effective all scope.
const SCOPED_AUTH = uuid(38), SCOPED_APP = uuid(48);
// Never inserted into direct_entry_app_users: proves an unmapped actor is refused.
const UNMAPPED_AUTH = uuid(39), UNMAPPED_APP = uuid(49);

const REPORT_FUNCTION = "public.direct_entry_duplicate_cccd_report";
const REPORT_SIGNATURE = REPORT_FUNCTION + "(uuid,uuid,integer,integer)";
const REPORT_SIGNATURE_5ARG = REPORT_FUNCTION + "(uuid,uuid,integer,integer,boolean)";
const SELF_WITHDRAW_SIGNATURE =
  "public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)";
const INTERNAL_VOID_SIGNATURE =
  "public.direct_entry__internal_apply_entry_void(uuid,uuid,uuid,integer,uuid,text,text,text,uuid)";
const READER_SIGNATURE = "public.direct_entry_assert_duplicate_cccd_reader(uuid,uuid)";

// The P3.1-W01B legacy "Full Admin" triple plus the capabilities the P2.5-HF per-row
// creation authority needs. The reader gate only looks at the triple.
const FULL_ADMIN_CAPABILITIES = [
  "entry_admin", "recruiter_master_manage", "team_master_manage", "entry_create",
  "submission_create", "employment_status.apply", "change_request_create",
];

const PRE_3C_PIN_MIGRATION_NAME = "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql";

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
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
  assert.equal(names.indexOf(HOTFIX_MIGRATION), 73, "P3.1-HF #74 stays append-only before W02-B #75 and the leader-scope hotfix #76");
  assert.equal(names.indexOf(PREVIOUS_MIGRATION), 72, "P3.1-HF stays append-only");
  assert.equal(names.indexOf(R3_MIGRATION), 60, "P2.5-HF-R3 remains #61");
  return db;
}

async function insertActor(db, auth, app, capabilities, scopeKinds = []) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,true,'Hotfix Account')", [app, auth]);
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [app, capability]);
  }
  for (const scopeKind of scopeKinds) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)" +
      " values ($1,$2,$3,'2020-01-01',true)",
      [app, scopeKind, scopeKind === "team" ? TEAM : null]);
  }
}

async function seed(db) {
  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_HF','Team HF')", [TEAM]);
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project HF A')",
    [PROJ_A]);
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project HF B')",
    [PROJ_B]);
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project HF C')",
    [PROJ_C]);
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter HF')", [REC_A]);
  await db.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
    " values ($1,'hrp','2020-01-01',true)", [REC_A]);
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
    " values ($1,$2,'2020-01-01',true)", [REC_A, TEAM]);

  // own scope as well: the v1 full-profile batch and the legacy batch keep their per-row
  // creation authority (P2.5-HF), which needs a live own grant at the work date.
  await insertActor(db, ADMIN_AUTH, ADMIN_APP, FULL_ADMIN_CAPABILITIES, ["all", "own"]);
  await insertActor(db, ACC_AUTH, ACC_APP, ["catalog_master_manage"], ["all"]);
  await insertActor(db, BOD_AUTH, BOD_APP, ["entry_privileged_edit"], ["all"]);
  await insertActor(db, LONE_AUTH, LONE_APP, ["entry_admin"], ["all"]);
  await insertActor(db, REVIEW_AUTH, REVIEW_APP, ["change_review"], ["all"]);
  await insertActor(db, LEADER_AUTH, LEADER_APP, ["team_manager_assign"], ["team"]);
  await insertActor(db, OUTSIDE_AUTH, OUTSIDE_APP, [], ["all"]);
  await insertActor(db, SCOPED_AUTH, SCOPED_APP, FULL_ADMIN_CAPABILITIES, ["team"]);
  // UNMAPPED_AUTH deliberately never appears in direct_entry_app_users.
}


function workerDetails(cccd, extra = {}) {
  return {
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: cccd === null ? { state: "unknown" } : { state: "provided", value: cccd },
    address: { state: "provided", value: "HF address" },
    phone: { state: "provided", value: "0900000000" },
    ...extra,
  };
}

// Every writer demands an RFC-4122 shaped key and the v2 wrapper derives a second key
// from it, so each call must be unique and well formed.
let keySeq = 0;
function idemKey() {
  keySeq += 1;
  return uuid(900000 + keySeq);
}

async function count(db, sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

/** Mot episode lich su ghi truc tiep vao bang - khong di qua batch create. */
let episodeSeq = 0;
async function seedEpisode(db, {
  cccd, name, project = PROJ_A, date = "2026-01-05", status = "ON", deleted = false,
  createdBy = ADMIN_APP, recruiter = REC_A, team = TEAM, submissionState = "SUBMITTED",
}) {
  episodeSeq += 1;
  const candidate = uuid(2000 + episodeSeq);
  const submission = uuid(3000 + episodeSeq);
  const entry = uuid(4000 + episodeSeq);
  const code = "hrp-2026-" + String(800000 + episodeSeq);
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidate]);
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)" +
      " values ($1,$2,'DRAFT')", [submission, createdBy]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
      " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
      " provider_type, labor_type, deleted_at)" +
      " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY',null)",
      [entry, submission, candidate, createdBy, project, date, code,
        JSON.stringify({ display_name: name, ...workerDetails(cccd) }), recruiter, team]);
    if (submissionState === "REVIEW") {
      await seedLegacyReviewSubmission(db, submission);
    } else if (submissionState === "SUBMITTED") {
      await seedLegacyReviewSubmission(db, submission);
      await db.query(
        "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
        [submission]);
    }
    if (status !== null) {
      await appendStatus(db, entry, status, date, 1, null);
    }
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  if (deleted) {
    // Xoa mem SAU khi commit: submission da qua duoc kiem tra "nonempty" o thoi diem
    // commit, va khong con update state nao duoc xep hang lai.
    await softDeleteEntry(db, entry);
  }
  return { entryId: entry, submissionId: submission, candidateId: candidate, employeeCode: code };
}

/** Xoa mem mot episode da commit - the version guard doi version tang dung 1. */
async function softDeleteEntry(db, entryId) {
  await db.query(
    "update public.direct_entries set deleted_at = $2::timestamptz, version = version + 1" +
    " where entry_id = $1", [entryId, "2026-02-01T00:00:00Z"]);
}

let reasonSeq = 0;
async function appendStatus(db, entryId, status, date, version, supersedesEventId) {
  reasonSeq += 1;
  const reasonId = (await db.query(
    "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
    " values ($1,$2) returning reason_id::text as id", [ADMIN_APP, `HF reason ${reasonSeq}`])).rows[0].id;
  return (await db.query(
    "insert into public.direct_entry_employment_status_events" +
    " (entry_id, status, effective_date, leave_date, leave_reason_text, version," +
    " actor_user_id, reason_id, supersedes_event_id)" +
    " values ($1,$2,$3::date, case when $2 = 'OFF' then $3::date else null end," +
    " case when $2 = 'OFF' then 'HF synthetic leave' else null end, $4,$5,$6,$7)" +
    " returning event_id::text as id",
    [entryId, status, date, version, ADMIN_APP, reasonId, supersedesEventId])).rows[0].id;
}

/** Duong create that su: full-profile v1 batch (server-side). */
async function createFullProfile(db, { cccd, name, project = PROJ_A, date = "2026-10-01",
  code = "hrp-2026-900001", auth = ADMIN_AUTH, app = ADMIN_APP }) {
  return db.query(
    "select public.direct_entry_create_full_profile_batch($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text)",
    [auth, app, "worker-profile/1.0", JSON.stringify([{
      project_id: project, first_work_date: date, employee_code: code,
      recruiter_id: REC_A, labor_type: "TEMPORARY", display_name: name,
      worker_details: workerDetails(cccd),
    }]), idemKey("hf-v1")]);
}

async function createFullProfileV2(db, { cccd, name, project = PROJ_A, date = "2026-10-02" }) {
  return db.query(
    "select public.direct_entry_create_full_profile_batch_v2($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text)",
    [ADMIN_AUTH, ADMIN_APP, "worker-profile/1.1", JSON.stringify([{
      project_id: project, first_work_date: date, provider_type: "hrp", recruiter_id: REC_A,
      labor_type: "TEMPORARY", display_name: name, worker_details: workerDetails(cccd),
    }]), idemKey("hf-v2")]);
}

async function createLegacyBatch(db, { cccd, name, date = "2026-10-03", code = "hrp-2026-900002" }) {
  return db.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text)",
    [ADMIN_AUTH, ADMIN_APP, JSON.stringify([{
      project_id: PROJ_A, first_work_date: date, employee_code: code,
      labor_type: "TEMPORARY", recruiter_id: REC_A,
      worker_details: { display_name: name, ...workerDetails(cccd) },
    }]), idemKey("hf-legacy")]);
}

async function report(db, {
  auth = ADMIN_AUTH, app = ADMIN_APP, page = 1, pageSize = 25, managedOnly,
} = {}) {
  if (managedOnly === undefined) {
    return (await db.query(
      `select ${REPORT_FUNCTION}($1::uuid,$2::uuid,$3::int,$4::int) as data`,
      [auth, app, page, pageSize])).rows[0].data;
  }
  return (await db.query(
    `select ${REPORT_FUNCTION}($1::uuid,$2::uuid,$3::int,$4::int,$5::boolean) as data`,
    [auth, app, page, pageSize, managedOnly])).rows[0].data;
}

async function reportDenied(db, options, message) {
  await assert.rejects(
    () => report(db, options),
    (error) => {
      assert.equal(error.code, "42501", "the duplicate report must deny with 42501");
      if (message) {
        assert.match(error.message, message);
      }
      return true;
    });
}

/**
 * Go CHECK worker_details trong luc seed du lieu lich su (dinh dang CCCD cu), roi gan lai
 * o dang NOT VALID - khong ghi de du lieu that va khong sua migration cu.
 */
async function relaxWorkerDetailsCheck(db) {
  const row = (await db.query(
    "select conname from pg_constraint where conrelid = 'public.direct_entries'::regclass" +
    " and contype = 'c' and pg_get_constraintdef(oid) like '%valid_worker_details%'")).rows[0];
  assert.ok(row, "the worker_details CHECK constraint must exist");
  await db.query('alter table public.direct_entries drop constraint "' + row.conname + '"');
}

async function restoreWorkerDetailsCheck(db) {
  await db.exec(
    "alter table public.direct_entries" +
    " add constraint direct_entries_worker_details_hf_simulated" +
    " check (public.direct_entry_valid_worker_details(worker_details)) not valid");
}

/** Hai episode song trong cung mot (CCCD, project, ngay vao lam) duplicate cluster. */
async function seedPair(db, options = {}) {
  const {
    cccd, first = "2026-01-05", second = "2026-01-05", statusFirst = "ON", statusSecond = "ON",
    firstProject = PROJ_A, secondProject = PROJ_A,
  } = options;
  const a = await seedEpisode(db, {
    cccd, name: "HF Pair A", project: firstProject, date: first, status: statusFirst,
  });
  const b = await seedEpisode(db, {
    cccd, name: "HF Pair B", project: secondProject, date: second, status: statusSecond,
  });
  return { a, b };
}


// ---------------------------------------------------------------------------
// 1. Cai dat: migration #74 append-only, 74 migration, khong sua #58..#61.
// ---------------------------------------------------------------------------
test("P3.1-HF: the migration installs as #74 and leaves #58..#61 untouched", async () => {
  const db = await buildDb();
  try {
    assert.equal(await count(db,
      "select count(*) from pg_proc where proname = 'direct_entry_guard_active_episode'"), 0);
    assert.equal(await count(db,
      "select count(*) from pg_proc where proname = 'direct_entry_duplicate_cccd_report'"), 2,
      "4-arg retained delegate + 5-arg managed_only implementation");
    assert.equal(await count(db,
      "select count(*) from pg_proc where proname = 'direct_entry_assert_duplicate_cccd_reader'"), 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. Moi duong ghi nghiep vu chap nhan episode thu hai cua cung mot CCCD.
// ---------------------------------------------------------------------------
test("P3.1-HF: create, import v2 and the legacy batch all accept a second live episode", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createFullProfile(db, { cccd: "012345678901", name: "HF First" });
    await createFullProfile(db, { cccd: "012345678901", name: "HF Second", date: "2026-10-05",
      code: "hrp-2026-900011" });
    await createFullProfileV2(db, { cccd: "012345678901", name: "HF Third" });
    await createLegacyBatch(db, { cccd: "012345678901", name: "HF Fourth" });

    assert.equal(await count(db,
      "select count(*) from public.direct_entries" +
      " where worker_details->'national_id'->>'value' = '012345678901'"), 4,
    "four live episodes may share one canonical CCCD");
    assert.equal(await count(db, "select count(*) from public.direct_entries"), 4);
  } finally {
    await db.close();
  }
});

test("P3.1-HF: no duplicate-CCCD raiser and no unique CCCD index survive in public", async () => {
  const db = await buildDb();
  try {
    assert.equal(await count(db,
      "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname = 'public' and p.prokind = 'f'" +
      " and (p.prosrc like '%NATIONAL_ID_DUPLICATE%'" +
      "      or p.prosrc like '%worker_active_episode_exists%')"), 0,
    "no public function may still raise a duplicate-CCCD error");
    assert.equal(await count(db,
      "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname = 'public' and p.prokind = 'f'" +
      " and p.prosrc ~ 'direct_entry_guard_active_episode'"), 0);
    assert.equal(await count(db,
      "select count(*) from pg_index i where i.indrelid = 'public.direct_entries'::regclass" +
      " and i.indisunique and i.indexprs is not null" +
      " and pg_get_indexdef(i.indexrelid) like '%national_id%'"), 0,
    "a unique CCCD index would block a second episode at the storage layer");
    assert.equal(await count(db,
      "select count(*) from pg_trigger t join pg_proc p on p.oid = t.tgfoid" +
      " where t.tgrelid = 'public.direct_entries'::regclass and not t.tgisinternal" +
      " and (p.prosrc like '%NATIONAL_ID_DUPLICATE%'" +
      "      or p.prosrc like '%worker_active_episode_exists%')"), 0);
  } finally {
    await db.close();
  }
});

test("P3.1-HF: the raw write path accepts a second active episode for one canonical CCCD", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const first = await seedEpisode(db, { cccd: "098765432", name: "HF Raw First", status: "ON" });
    const second = await seedEpisode(db, { cccd: "098765432", name: "HF Raw Second", status: "ON",
      project: PROJ_B, date: "2026-03-01" });
    assert.notEqual(first.entryId, second.entryId);
    assert.equal(await count(db,
      "select count(*) from public.direct_entries where deleted_at is null"), 2,
    "the row guard must not refuse the second episode");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_employment_status_events"), 2,
    "the status-event guard must not refuse the second live episode either");

    // Du lieu lich su giu dinh dang cu (co khoang trang) van nap duoc: report chuan hoa,
    // con duong ghi khong tu y sua lai gia tri.
    await relaxWorkerDetailsCheck(db);
    const legacy = await seedEpisode(db, { cccd: "0987 65432", name: "HF Raw Legacy",
      status: "ON", project: PROJ_B, date: "2026-04-01" });
    await restoreWorkerDetailsCheck(db);
    assert.equal(await count(db,
      "select count(*) from public.direct_entries where deleted_at is null"), 3);
    assert.match(legacy.employeeCode, /^hrp-2026-[0-9]{6}$/);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Quyen doc (PRE-W2-HF-C): MOI authenticated active business actor (co actor
//    mapping hop le) deu doc duoc; chi unmapped/mismatched bi tu choi.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-C: every mapped active business actor reads the same global report", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createFullProfile(db, { cccd: "012345678901", name: "HF Gate First" });
    await createFullProfile(db, { cccd: "012345678901", name: "HF Gate Second",
      date: "2026-10-01", code: "hrp-2026-900011" });

    // Every mapped + enabled actor — regardless of capability or scope bundle —
    // reads the SAME global result under one stable authority label.
    for (const [auth, app] of [
      [ADMIN_AUTH, ADMIN_APP], [ACC_AUTH, ACC_APP], [BOD_AUTH, BOD_APP],
      [LONE_AUTH, LONE_APP], [REVIEW_AUTH, REVIEW_APP], [LEADER_AUTH, LEADER_APP],
      [OUTSIDE_AUTH, OUTSIDE_APP], [SCOPED_AUTH, SCOPED_APP],
    ]) {
      const payload = await report(db, { auth, app });
      assert.equal(payload.authority, "business_actor", "one stable authority label");
      assert.equal(payload.total_groups, 1);
      assert.equal(payload.total_entries, 2);
      assert.equal(payload.groups.length, 1);
      assert.equal(payload.groups[0].profile_count, 2);
    }

    // Mapping stays the authority: a mismatched or unmapped actor is denied
    // before any read.
    await reportDenied(db, { auth: ADMIN_AUTH, app: ACC_APP }, /actor mapping denied/);
    await reportDenied(db, { auth: UNMAPPED_AUTH, app: UNMAPPED_APP }, /actor mapping denied/);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Noi dung bao cao: mask, chuan hoa dinh dang cu, khong lo UUID.
// ---------------------------------------------------------------------------
test("P3.1-HF: the report masks the CCCD, normalizes legacy formatting and emits no UUID", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await relaxWorkerDetailsCheck(db);
    // Mot cap trung: mot dong canonical + mot dong con giu dinh dang cu.
    const epCanonical = await seedEpisode(db, { cccd: "012345678901", name: "HF Mask Canonical", project: PROJ_A,
      date: "2026-01-05", status: "ON" });
    // Dong dinh dang cu giu nguyen dinh dang (co khoang trang) va trang thai ON: report
    // chuan hoa CCCD, con duong ghi khong tu y sua lai gia tri.
    const epLegacy = await seedEpisode(db, { cccd: "0123 456 78901", name: "HF Mask Legacy",
      project: PROJ_A, date: "2026-01-05", status: "ON" });
    // Cac truong hop KHONG phai trung: xuat hien mot lan, unknown, va da xoa mem.
    const epSingle = await seedEpisode(db, { cccd: "111222333", name: "HF Mask Single", project: PROJ_A,
      date: "2026-03-01", status: "ON" });
    await seedEpisode(db, { cccd: null, name: "HF Mask Unknown", project: PROJ_A,
      date: "2026-03-02", status: "ON" });
    await seedEpisode(db, { cccd: "555666777", name: "HF Mask Deleted", project: PROJ_A,
      date: "2026-03-03", status: "ON", deleted: true });
    await seedEpisode(db, { cccd: "555666777", name: "HF Mask Deleted Two", project: PROJ_B,
      date: "2026-03-04", status: "ON", deleted: true });
    await restoreWorkerDetailsCheck(db);

    const payload = await report(db);
    assert.equal(payload.page, 1);
    assert.equal(payload.page_size, 25);
    assert.equal(payload.has_more, false);
    assert.equal(payload.total_groups, 1, "chi CCCD xuat hien hai lan moi la trung");
    assert.equal(payload.total_entries, 2);

    const [group] = payload.groups;
    assert.deepEqual(Object.keys(group).sort(), [
      "active_profile_count", "cccd_last4", "cccd_length", "episodes", "first_work_date",
      "latest_first_work_date", "profile_count", "project_count",
    ]);
    assert.equal(group.cccd_last4, "8901");
    assert.equal(group.cccd_length, 12);
    assert.equal(group.profile_count, 2);
    assert.equal(group.project_count, 1);
    assert.equal(group.active_profile_count, 2);
    assert.equal(group.first_work_date, "2026-01-05");
    assert.equal(group.latest_first_work_date, "2026-01-05");

    // Same-day episodes use entry_id as the deterministic tiebreaker.
    assert.deepEqual(group.episodes.map((e) => e.entry_id), [epCanonical.entryId, epLegacy.entryId]);
    assert.deepEqual(group.episodes.map((e) => e.first_work_date), ["2026-01-05", "2026-01-05"]);
    assert.deepEqual(group.episodes.map((e) => e.latest_status), ["ON", "ON"]);
    assert.deepEqual(group.episodes.map((e) => e.active), [true, true]);
    assert.deepEqual(group.episodes.map((e) => e.project_id), [PROJ_A, PROJ_A]);
    assert.deepEqual(group.episodes.map((e) => e.project_display),
      ["Project HF A", "Project HF A"]);
    assert.deepEqual(Object.keys(group.episodes[0]).sort(), [
      "active", "can_mark_off", "can_self_withdraw", "display_name", "employee_code", "entry_id",
      "entry_version", "first_work_date", "latest_status", "project_display", "project_id",
    ]);

    const serialized = JSON.stringify(payload);
    assert.ok(!serialized.includes("012345678901"),
      "so CCCD canonical day du khong duoc roi khoi database");
    assert.ok(!serialized.includes("0123 456 78901"),
      "dinh dang luu tru cu cung khong duoc ro ri");
    for (const secret of [
      epLegacy.submissionId, epLegacy.candidateId, epCanonical.submissionId, epCanonical.candidateId,
      epSingle.entryId, ADMIN_AUTH, ADMIN_APP, REC_A, TEAM,
    ]) {
      assert.ok(!serialized.includes(secret), `internal UUID leaked: ${secret}`);
    }

    // Project bi thieu khong duoc lam mat ca nhom trung: join phai la left join.
    assert.equal(await count(db,
      "select count(*) from pg_proc where oid = $1::regprocedure" +
      " and prosrc like '%left join public.direct_entry_projects%'", [REPORT_SIGNATURE_5ARG]), 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 7. Bien: page_size <= 100, page <= 1000, va kiem tra truoc khi doc du lieu.
// ---------------------------------------------------------------------------
test("P3.1-HF: the report is bounded and rejects out-of-range paging", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedPair(db, { cccd: "012345678901" });

    for (const [page, pageSize, message] of [
      [1, 101, /duplicate_report_page_size_invalid/],
      [1, 0, /duplicate_report_page_size_invalid/],
      [1, -5, /duplicate_report_page_size_invalid/],
      [1001, 25, /duplicate_report_page_invalid/],
      [0, 25, /duplicate_report_page_invalid/],
    ]) {
      await assert.rejects(() => report(db, { page, pageSize }), (error) => {
        assert.equal(error.code, "22023");
        assert.match(error.message, message);
        return true;
      });
    }

    // Bien duoc kiem tra TRUOC quyen doc: ke ca actor chua map cung khong do duoc
    // hinh dang cua report khi tham so sai.
    await assert.rejects(
      () => report(db, { auth: UNMAPPED_AUTH, app: UNMAPPED_APP, pageSize: 101 }),
      (error) => {
        assert.equal(error.code, "22023");
        assert.match(error.message, /duplicate_report_page_size_invalid/);
        return true;
      });
    await reportDenied(db, { auth: UNMAPPED_AUTH, app: UNMAPPED_APP });

    // Tham so null roi ve mac dinh 1 / 25 thay vi loi.
    const defaults = await report(db, { page: null, pageSize: null });
    assert.equal(defaults.page, 1);
    assert.equal(defaults.page_size, 25);
    assert.equal(defaults.total_groups, 1);
    // 100 la kich thuoc trang lon nhat duoc chap nhan.
    const widest = await report(db, { pageSize: 100 });
    assert.equal(widest.page_size, 100);
    assert.equal(widest.groups.length, 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 8. Determinism: thu tu nhom, thu tu episode va cat trang.
// ---------------------------------------------------------------------------
test("P3.1-HF: group and episode ordering plus paging are deterministic", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedPair(db, { cccd: "111111111" });
    const middlePair = await seedPair(db, { cccd: "222222222", first: "2026-03-01", second: "2026-03-01" });
    await seedPair(db, { cccd: "333333333" });

    const first = await report(db, { pageSize: 2 });
    assert.equal(first.total_groups, 3);
    assert.equal(first.total_entries, 6);
    assert.equal(first.has_more, true);
    assert.deepEqual(first.groups.map((g) => g.cccd_last4), ["1111", "2222"]);
    assert.deepEqual(first.groups.map((g) => g.cccd_length), [9, 9]);
    // Same-date episodes use entry_id as the deterministic tiebreaker.
    assert.deepEqual(first.groups[1].episodes.map((e) => e.entry_id),
      [middlePair.a.entryId, middlePair.b.entryId]);

    const second = await report(db, { page: 2, pageSize: 2 });
    assert.equal(second.has_more, false);
    assert.equal(second.total_groups, 3);
    assert.deepEqual(second.groups.map((g) => g.cccd_last4), ["3333"]);

    const beyond = await report(db, { page: 3, pageSize: 2 });
    assert.deepEqual(beyond.groups, []);
    assert.equal(beyond.has_more, false);
    assert.equal(beyond.total_groups, 3);
    assert.equal(beyond.total_entries, 6);

    // Hai lan goi y het phai tra ve JSON giong nhau tung byte.
    assert.deepEqual(await report(db, { pageSize: 2 }), first);
    assert.deepEqual(await report(db, { page: 2, pageSize: 2 }), second);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 9. Chi doc: khong ghi, khong lock, khong merge, khong "sua" profile nao.
// ---------------------------------------------------------------------------
test("P3.1-HF: reading the report never writes, locks, merges or repairs", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedPair(db, { cccd: "012345678901" });
    const snapshot = async () => [
      await count(db, "select count(*) from public.direct_entries"),
      await count(db, "select count(*) from public.direct_entry_candidates"),
      await count(db, "select count(*) from public.direct_entry_submissions"),
      await count(db, "select count(*) from public.direct_entry_submission_revisions"),
      await count(db, "select count(*) from public.direct_entry_employment_status_events"),
      await count(db, "select count(*) from public.direct_entry_audit_events"),
      await count(db, "select count(*) from public.direct_entry_revisions"),
      await count(db, "select count(*) from public.direct_entry_rpc_idempotency"),
      await count(db, "select count(*) from public.direct_entry_restricted_reasons"),
      await count(db, "select coalesce(sum(version),0) from public.direct_entries"),
      await count(db,
        "select count(*) from public.direct_entries where deleted_at is not null"),
    ];
    const before = await snapshot();
    for (let round = 0; round < 5; round += 1) {
      await report(db, { page: 1, pageSize: 2 });
    }
    assert.deepEqual(await snapshot(), before, "report khong duoc de lai bat cu dong nao");

    for (const sig of [REPORT_SIGNATURE, REPORT_SIGNATURE_5ARG]) {
      const reportSource = (await db.query(
        "select prosrc, provolatile, prosecdef," +
        " p.proconfig::text as proconfig" +
        " from pg_proc p where p.oid = $1::regprocedure", [sig])).rows[0];
      assert.equal(reportSource.provolatile, "s", `report ${sig} phai la STABLE (khong ghi)`);
      assert.equal(reportSource.prosecdef, true, sig);
      assert.ok(String(reportSource.proconfig).includes("search_path=pg_catalog, public"),
        `search_path phai duoc ghim cho ${sig}`);
      const body = reportSource.prosrc.toLowerCase();
      for (const verb of ["insert into", "update ", "delete from", "pg_advisory", "for update",
        "truncate", "commit"]) {
        assert.equal(body.includes(verb), false, `than report ${sig} khong duoc chua "${verb}"`);
      }
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 10. Bien gioi cai dat: report + self-withdraw chi service_role goi duoc, guard/internal helper bi thu hoi.
// ---------------------------------------------------------------------------
test("P3.1-HF: the report and self-withdraw RPCs are service_role-only and internal helpers are revoked", async () => {
  const db = await buildDb();
  try {
    const acl = async (signature) => (await db.query(
      "select has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec," +
      " has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec," +
      " (select count(*)::int from" +
      " aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a" +
      " where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec" +
      " from pg_proc p where p.oid = '" + signature + "'::regprocedure")).rows[0];

    for (const sig of [REPORT_SIGNATURE, REPORT_SIGNATURE_5ARG, SELF_WITHDRAW_SIGNATURE]) {
      const granted = await acl(sig);
      assert.equal(granted.service_exec, true, `service_role goi ${sig}`);
      assert.equal(granted.anon_exec, false, sig);
      assert.equal(granted.auth_exec, false, sig);
      assert.equal(granted.public_exec, 0, `PUBLIC khong duoc goi ${sig}`);
    }

    for (const sig of [READER_SIGNATURE, INTERNAL_VOID_SIGNATURE]) {
      const revoked = await acl(sig);
      assert.equal(revoked.service_exec, false, `helper noi bo ${sig} khong duoc goi tu service_role`);
      assert.equal(revoked.anon_exec, false, sig);
      assert.equal(revoked.auth_exec, false, sig);
      assert.equal(revoked.public_exec, 0, sig);
    }

    assert.equal(await count(db,
      "select count(*) from pg_proc where oid = 'public.direct_entry_assert_duplicate_cccd_reader" +
      "(uuid,uuid)'::regprocedure and prorettype = 'text'::regtype and provolatile = 's'"), 1);

    const duplicateNames = (await db.query(
      "select distinct p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname = 'public' and p.prokind = 'f'" +
      " and p.proname like '%duplicate%' order by p.proname")).rows
      .map((row) => row.proname);
    assert.deepEqual(duplicateNames, [
      "direct_entry_assert_duplicate_cccd_reader",
      "direct_entry_duplicate_cccd_report",
      "direct_entry_self_withdraw_duplicate_cccd",
      "direct_entry_submission_duplicate_cccd_preflight",
      "direct_entry_submission_duplicate_cccd_state",
      "direct_entry_transition_submission_duplicate_cccd_confirmed",
    ], "chi report, self-withdraw, guard va contract xac nhan duoc mang ten duplicate");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 11. HF: managed_only loc dung nhom co it nhat mot episode thuoc du an PM dang quan ly,
//     giu nguyen counterpart episode cua nhom do, va tinh total/paging SAU khi loc.
// ---------------------------------------------------------------------------
test("HF: managed_only filters by effective PM assignment, retains counterpart episodes, and paginates after filtering", async () => {
  const db = await buildDb();
  try {
    await seed(db);

    const PM_AUTH = uuid(131), PM_APP = uuid(141), PM_REC = uuid(121);
    const FUTURE_PM_AUTH = uuid(132), FUTURE_PM_APP = uuid(142), FUTURE_PM_REC = uuid(122);
    const REVOKED_PM_AUTH = uuid(133), REVOKED_PM_APP = uuid(143), REVOKED_PM_REC = uuid(123);

    for (const [recId, name] of [
      [PM_REC, "PM Recruiter"],
      [FUTURE_PM_REC, "Future PM Recruiter"],
      [REVOKED_PM_REC, "Revoked PM Recruiter"],
    ]) {
      await db.query(
        "insert into public.recruiters (recruiter_id, display_name, active) values ($1,$2,true)",
        [recId, name]);
      await db.query(
        "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
        " values ($1,'hrp','2020-01-01',true)", [recId]);
      await db.query(
        "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
        " values ($1,$2,'2020-01-01',true)", [recId, TEAM]);
    }

    await insertActor(db, PM_AUTH, PM_APP, ["entry_own"], ["own"]);
    await insertActor(db, FUTURE_PM_AUTH, FUTURE_PM_APP, ["entry_own"], ["own"]);
    await insertActor(db, REVOKED_PM_AUTH, REVOKED_PM_APP, ["entry_own"], ["own"]);

    for (const [appId, recId] of [
      [PM_APP, PM_REC],
      [FUTURE_PM_APP, FUTURE_PM_REC],
      [REVOKED_PM_APP, REVOKED_PM_REC],
    ]) {
      await db.query(
        "insert into public.direct_entry_app_user_recruiter_links" +
        " (app_user_id, recruiter_id, verified, valid_from, is_current)" +
        " values ($1,$2,true,'2020-01-01',true)",
        [appId, recId]);
    }

    // PM_APP currently manages PROJ_A and PROJ_B (via real audited RPC or canonical table state):
    await db.query(
      "insert into public.direct_entry_project_manager_assignments" +
      " (project_id, manager_recruiter_id, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true), ($3,$2,'2020-01-01',true)",
      [PROJ_A, PM_REC, PROJ_B]);
    // FUTURE_PM_APP has is_current = false (future/inactive interval):
    await db.query(
      "insert into public.direct_entry_project_manager_assignments" +
      " (project_id, manager_recruiter_id, valid_from, is_current)" +
      " values ($1,$2,'2030-01-01',false)",
      [PROJ_A, FUTURE_PM_REC]);
    // REVOKED_PM_APP has a revoked assignment:
    await db.query(
      "insert into public.direct_entry_project_manager_assignments" +
      " (project_id, manager_recruiter_id, valid_from, valid_to, revoked_at, revoked_by_user_id, is_current)" +
      " values ($1,$2,'2020-01-01','2025-01-01',now(),$3,false)",
      [PROJ_A, REVOKED_PM_REC, ADMIN_APP]);

    // Each duplicate group belongs to one project/day; managed_only keeps its full cluster.
    await seedPair(db, { cccd: "111111111", firstProject: PROJ_A, secondProject: PROJ_A });
    await seedPair(db, { cccd: "222222222", firstProject: PROJ_B, secondProject: PROJ_B });
    // Group 3 (333333333): PROJ_C + PROJ_C -> outside PM_APP's managed projects!
    await seedPair(db, { cccd: "333333333", firstProject: PROJ_C, secondProject: PROJ_C });

    // Global report (managed_only = false) returns all 3 groups:
    const globalRes = await report(db, { auth: PM_AUTH, app: PM_APP, managedOnly: false });
    assert.equal(globalRes.total_groups, 3);
    assert.equal(globalRes.total_entries, 6);

    // Managed-only page 1 (page_size = 1) returns the full PROJ_A cluster and accurate post-filter totals:
    const managedPage1 = await report(db, { auth: PM_AUTH, app: PM_APP, page: 1, pageSize: 1, managedOnly: true });
    assert.equal(managedPage1.total_groups, 2);
    assert.equal(managedPage1.total_entries, 4);
    assert.equal(managedPage1.has_more, true);
    assert.equal(managedPage1.groups.length, 1);
    assert.equal(managedPage1.groups[0].cccd_last4, "1111");
    assert.equal(managedPage1.groups[0].profile_count, 2);
    assert.deepEqual(managedPage1.groups[0].episodes.map((e) => e.project_id), [PROJ_A, PROJ_A]);

    // Managed-only page 2 (page_size = 1) returns Group 2 with has_more = false:
    const managedPage2 = await report(db, { auth: PM_AUTH, app: PM_APP, page: 2, pageSize: 1, managedOnly: true });
    assert.equal(managedPage2.total_groups, 2);
    assert.equal(managedPage2.total_entries, 4);
    assert.equal(managedPage2.has_more, false);
    assert.equal(managedPage2.groups[0].cccd_last4, "2222");
    assert.deepEqual(managedPage2.groups[0].episodes.map((e) => e.project_id), [PROJ_B, PROJ_B]);

    // Actors with 0 effective managed projects (plain actor, future PM, revoked PM, or Full Admin without PM assignment)
    // receive an empty result (never falling back to global):
    for (const [auth, app, label] of [
      [OUTSIDE_AUTH, OUTSIDE_APP, "actor without PM assignment"],
      [FUTURE_PM_AUTH, FUTURE_PM_APP, "future non-current PM assignment"],
      [REVOKED_PM_AUTH, REVOKED_PM_APP, "revoked PM assignment"],
      [ADMIN_AUTH, ADMIN_APP, "admin with 0 direct PM assignments"],
    ]) {
      const empty = await report(db, { auth, app, managedOnly: true });
      assert.equal(empty.total_groups, 0, label);
      assert.equal(empty.total_entries, 0, label);
      assert.equal(empty.has_more, false, label);
      assert.deepEqual(empty.groups, [], label);
    }
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 12. HF: can_mark_off authority; same-project/day history remains after OFF.
// ---------------------------------------------------------------------------
test("HF: can_mark_off matches direct-edit authority and OFF transitions preserve duplicate history", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const TEAM_B = uuid(211);
    const REC_B = uuid(221);
    const TL_REC = uuid(222);
    const PM_REC = uuid(223);
    const CREATOR_AUTH = uuid(231), CREATOR_APP = uuid(241);
    const PM_AUTH = uuid(232), PM_APP = uuid(242);

    await db.query(
      "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_HF_B','Team HF B')",
      [TEAM_B]);
    for (const [recId, name, teamId] of [
      [REC_B, "Recruiter B", TEAM_B],
      [TL_REC, "Leader Recruiter", TEAM],
      [PM_REC, "PM Recruiter", TEAM_B],
    ]) {
      await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,$2)", [recId, name]);
      await db.query(
        "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
        " values ($1,'hrp','2020-01-01',true)", [recId]);
      await db.query(
        "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
        " values ($1,$2,'2020-01-01',true)", [recId, teamId]);
    }

    // Complete canonical current Team Leader setup for LEADER_APP on TEAM:
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links" +
      " (app_user_id, recruiter_id, verified, valid_from, is_current)" +
      " values ($1,$2,true,'2020-01-01',true)",
      [LEADER_APP, TL_REC]);
    await db.query(
      "insert into public.direct_entry_team_leader_assignments" +
      " (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)" +
      " values ($1,$2,$3,'2020-01-01',true)",
      [TEAM, LEADER_APP, TL_REC]);

    // Assigned PM on PROJ_A only:
    await insertActor(db, PM_AUTH, PM_APP, ["entry_own"], ["own"]);
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links" +
      " (app_user_id, recruiter_id, verified, valid_from, is_current)" +
      " values ($1,$2,true,'2020-01-01',true)",
      [PM_APP, PM_REC]);
    await db.query(
      "insert into public.direct_entry_project_manager_assignments" +
      " (project_id, manager_recruiter_id, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)",
      [PROJ_A, PM_REC]);

    // Plain creator without direct-edit authority:
    await insertActor(db, CREATOR_AUTH, CREATOR_APP, ["entry_own", "entry_create"], ["own"]);

    // Two same-CCCD project/day clusters:
    //   PROJ_A: epA (SUBMITTED, CREATOR_APP) + epReview (REVIEW)
    //   PROJ_B: epB + epBPair (SUBMITTED, TEAM_B)
    const epA = await seedEpisode(db, {
      cccd: "012345678901", name: "Worker A", project: PROJ_A, date: "2026-01-05",
      createdBy: CREATOR_APP, recruiter: REC_A, team: TEAM, submissionState: "SUBMITTED",
    });
    const epB = await seedEpisode(db, {
      cccd: "012345678901", name: "Worker B", project: PROJ_B, date: "2026-02-10",
      createdBy: ADMIN_APP, recruiter: REC_B, team: TEAM_B, submissionState: "SUBMITTED",
    });
    const epBPair = await seedEpisode(db, {
      cccd: "012345678901", name: "Worker B Pair", project: PROJ_B, date: "2026-02-10",
      createdBy: ADMIN_APP, recruiter: REC_B, team: TEAM_B, submissionState: "SUBMITTED",
    });
    const epReview = await seedEpisode(db, {
      cccd: "012345678901", name: "Worker Review", project: PROJ_A, date: "2026-01-05",
      createdBy: ADMIN_APP, recruiter: REC_A, team: TEAM, submissionState: "REVIEW",
    });

    const flagsByActor = async (auth, app) => {
      const res = await report(db, { auth, app, managedOnly: false });
      return Object.fromEntries(res.groups[0].episodes.map((e) => [e.entry_id, e.can_mark_off]));
    };

    // Full Admin and BoD can mark OFF SUBMITTED rows, never REVIEW rows:
    assert.deepEqual(await flagsByActor(ADMIN_AUTH, ADMIN_APP), {
      [epA.entryId]: true, [epB.entryId]: true, [epBPair.entryId]: true, [epReview.entryId]: false,
    });
    assert.deepEqual(await flagsByActor(BOD_AUTH, BOD_APP), {
      [epA.entryId]: true, [epB.entryId]: true, [epBPair.entryId]: true, [epReview.entryId]: false,
    });
    // Team Leader of TEAM can mark OFF only TEAM's non-REVIEW row:
    assert.deepEqual(await flagsByActor(LEADER_AUTH, LEADER_APP), {
      [epA.entryId]: true, [epB.entryId]: false, [epBPair.entryId]: false, [epReview.entryId]: false,
    });
    // PM of PROJ_A can mark OFF only PROJ_A's non-REVIEW row:
    assert.deepEqual(await flagsByActor(PM_AUTH, PM_APP), {
      [epA.entryId]: true, [epB.entryId]: false, [epBPair.entryId]: false, [epReview.entryId]: false,
    });
    // Plain creator cannot mark OFF even their own row:
    assert.deepEqual(await flagsByActor(CREATOR_AUTH, CREATOR_APP), {
      [epA.entryId]: false, [epB.entryId]: false, [epBPair.entryId]: false, [epReview.entryId]: false,
    });

    // Missing leave_reason on ON -> OFF is rejected:
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_privileged_edit($1::uuid,$2::uuid,$3::uuid,1,$4::jsonb,null,$5::text)",
        [PM_AUTH, PM_APP, epA.entryId, JSON.stringify({
          employment_status: { status: "OFF", effective_date: "2026-02-15", leave_reason: "   " },
        }), idemKey()]),
      (err) => err.code === "22023" || err.code === "23514",
    );

    // Stale expected_version is rejected with PT409:
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_privileged_edit($1::uuid,$2::uuid,$3::uuid,99,$4::jsonb,null,$5::text)",
        [PM_AUTH, PM_APP, epA.entryId, JSON.stringify({
          employment_status: { status: "OFF", effective_date: "2026-02-15", leave_reason: "Nghỉ việc tự nguyện" },
        }), idemKey()]),
      (err) => err.code === "PT409",
    );

    // PM marks epA OFF with valid leave_reason; its same-project/day duplicate cluster remains in history.
    await db.query(
      "select public.direct_entry_privileged_edit($1::uuid,$2::uuid,$3::uuid,1,$4::jsonb,$5::text,$6::text)",
      [PM_AUTH, PM_APP, epA.entryId, JSON.stringify({
        employment_status: { status: "OFF", effective_date: "2026-02-15", leave_reason: "Đã nghỉ tại dự án A" },
      }), "Cập nhật từ báo cáo CCCD trùng", idemKey()],
    );

    // Admin marks the PROJ_B cluster sibling OFF too; both clusters remain visible as history.
    await db.query(
      "select public.direct_entry_privileged_edit($1::uuid,$2::uuid,$3::uuid,1,$4::jsonb,null,$5::text)",
      [ADMIN_AUTH, ADMIN_APP, epB.entryId, JSON.stringify({
        employment_status: { status: "OFF", effective_date: "2026-02-20", leave_reason: "Nghỉ tại dự án B" },
      }), idemKey()],
    );

    const afterOff = await report(db);
    assert.equal(afterOff.total_groups, 1, "same-project/day duplicate history remains visible after OFF transitions");
    assert.equal(afterOff.total_entries, 4);
    assert.equal(afterOff.groups[0].active_profile_count, 2);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 13. HF: can_self_withdraw + direct_entry_self_withdraw_duplicate_cccd:
//     strictly created_by_user_id = actor (never recruiter_id, no Admin/BoD/TL/PM override),
//     preserves history/audit without fake change request, idempotent, and decrements new-hire facts by 1.
// ---------------------------------------------------------------------------
test("HF: self-withdraw enforces strict creator ownership, idempotency, active-duplicate guard, and decrements reporting facts by 1", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const CREATOR_AUTH = uuid(331), CREATOR_APP = uuid(341);
    const OTHER_AUTH = uuid(332), OTHER_APP = uuid(342);
    const REC_ATTRIBUTED = uuid(321);

    await db.query("insert into public.recruiters (recruiter_id, display_name) values ($1,'Attributed Recruiter')",
      [REC_ATTRIBUTED]);
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
      " values ($1,'hrp','2020-01-01',true)", [REC_ATTRIBUTED]);
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [REC_ATTRIBUTED, TEAM]);

    await insertActor(db, CREATOR_AUTH, CREATOR_APP, ["entry_own"], ["own"]);
    await insertActor(db, OTHER_AUTH, OTHER_APP, ["entry_own"], ["own"]);
    // Link OTHER_APP to REC_ATTRIBUTED so OTHER_APP is the attributed recruiter, NOT created_by_user_id!
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links" +
      " (app_user_id, recruiter_id, verified, valid_from, is_current)" +
      " values ($1,$2,true,'2020-01-01',true)",
      [OTHER_APP, REC_ATTRIBUTED]);

    // Seed two post-cutoff SUBMITTED ON episodes sharing CCCD 079200001234:
    //   ownEp: created_by_user_id = CREATOR_APP, recruiter_id = REC_ATTRIBUTED (linked to OTHER_APP!)
    //   counterpartEp: created_by_user_id = OTHER_APP, recruiter_id = REC_A
    // Both rows belong to the same CCCD/project/first-work-date duplicate cluster.
    const ownEp = await seedEpisode(db, {
      cccd: "079200001234", name: "Creator Duplicate", project: PROJ_A, date: "2026-10-05",
      createdBy: CREATOR_APP, recruiter: REC_ATTRIBUTED, team: TEAM, submissionState: "SUBMITTED",
    });
    const counterpartEp = await seedEpisode(db, {
      cccd: "079200001234", name: "Counterpart Duplicate", project: PROJ_A, date: "2026-10-05",
      createdBy: OTHER_APP, recruiter: REC_A, team: TEAM, submissionState: "SUBMITTED",
    });

    // Check can_self_withdraw projection for CREATOR_APP, OTHER_APP (recruiter_id != creator), ADMIN_APP, BOD_APP:
    const creatorView = await report(db, { auth: CREATOR_AUTH, app: CREATOR_APP, managedOnly: false });
    assert.deepEqual(
      Object.fromEntries(creatorView.groups[0].episodes.map((e) => [e.entry_id, e.can_self_withdraw])),
      { [ownEp.entryId]: true, [counterpartEp.entryId]: false },
    );

    const otherView = await report(db, { auth: OTHER_AUTH, app: OTHER_APP, managedOnly: false });
    assert.deepEqual(
      Object.fromEntries(otherView.groups[0].episodes.map((e) => [e.entry_id, e.can_self_withdraw])),
      { [ownEp.entryId]: false, [counterpartEp.entryId]: true },
      "attributed recruiter_id never grants can_self_withdraw on another creator's row",
    );

    for (const [auth, app, roleLabel] of [
      [ADMIN_AUTH, ADMIN_APP, "Full Admin"],
      [BOD_AUTH, BOD_APP, "BoD privileged editor"],
      [LEADER_AUTH, LEADER_APP, "Team Leader"],
    ]) {
      const roleView = await report(db, { auth, app, managedOnly: false });
      assert.deepEqual(
        Object.fromEntries(roleView.groups[0].episodes.map((e) => [e.entry_id, e.can_self_withdraw])),
        { [ownEp.entryId]: false, [counterpartEp.entryId]: false },
        `${roleLabel} must not get can_self_withdraw on rows created by others`,
      );
      await assert.rejects(
        () => db.query(
          "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text)",
          [auth, app, ownEp.entryId, "Admin override attempt", idemKey()]),
        (err) => err.code === "42501",
        `${roleLabel} self-withdraw on non-owned row must fail closed with 42501`,
      );
    }

    // Attributed recruiter (OTHER_APP) trying to self-withdraw ownEp is also denied with 42501:
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text)",
        [OTHER_AUTH, OTHER_APP, ownEp.entryId, "Recruiter link attempt", idemKey()]),
      (err) => err.code === "42501",
    );

    // OCC mismatch fails closed with PT409:
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,9,$4::text,$5::text)",
        [CREATOR_AUTH, CREATOR_APP, ownEp.entryId, "OCC mismatch", idemKey()]),
      (err) => err.code === "PT409" && /version conflict/i.test(err.message),
    );

    // Reporting new-hire facts count BEFORE self-withdraw is 2:
    const hiresBefore = await count(
      db,
      "select coalesce(sum(recruited_count), 0) from public.direct_entry_reporting_facts_v01",
    );
    assert.equal(hiresBefore, 2);

    // Creator self-withdraws ownEp:
    const withdrawKey = idemKey();
    const firstWithdraw = (await db.query(
      "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text) as data",
      [CREATOR_AUTH, CREATOR_APP, ownEp.entryId, "  Tự rút hồ sơ nhập trùng  ", withdrawKey],
    )).rows[0].data;
    assert.deepEqual(firstWithdraw, { entry_id: ownEp.entryId, version: 2 });

    // Idempotent replay with the same key returns the exact same result without a second revision/audit:
    const replayWithdraw = (await db.query(
      "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text) as data",
      [CREATOR_AUTH, CREATOR_APP, ownEp.entryId, "Tự rút hồ sơ nhập trùng", withdrawKey],
    )).rows[0].data;
    assert.deepEqual(replayWithdraw, firstWithdraw);

    // Verify domain & reporting & audit invariants:
    const hiresAfter = await count(
      db,
      "select coalesce(sum(recruited_count), 0) from public.direct_entry_reporting_facts_v01",
    );
    assert.equal(hiresAfter, 1, "new-hire count decrements by exactly 1");

    const entryRow = (await db.query(
      "select deleted_at, voided_at, voided_by_user_id, void_reason_id, version from public.direct_entries where entry_id = $1",
      [ownEp.entryId],
    )).rows[0];
    assert.equal(entryRow.deleted_at, null, "self-withdraw never deletes the row");
    assert.notEqual(entryRow.voided_at, null);
    assert.equal(entryRow.voided_by_user_id, CREATOR_APP);
    assert.notEqual(entryRow.void_reason_id, null);
    assert.equal(entryRow.version, 2);

    assert.equal(
      await count(db, "select count(*) from public.direct_entry_change_requests"),
      0,
      "self-withdraw never creates a fake change request",
    );
    assert.equal(
      await count(db, "select count(*) from public.direct_entry_revisions where entry_id = $1", [ownEp.entryId]),
      1,
      "exactly one revision written across initial call + idempotent replay",
    );
    assert.equal(
      await count(
        db,
        "select count(*) from public.direct_entry_audit_events" +
        " where resource_ref = $1 and action = 'entry_self_withdraw_duplicate_cccd'" +
        " and outcome = 'APPLIED' and changed_fields = array['ENTRY_VOID']",
        [ownEp.entryId],
      ),
      1,
      "exactly one immutable audit event recorded",
    );

    // Duplicate report is now empty (only 1 active ON episode remains):
    const afterReport = await report(db, { auth: CREATOR_AUTH, app: CREATOR_APP, managedOnly: false });
    assert.equal(afterReport.total_groups, 0);
    assert.deepEqual(afterReport.groups, []);

    // Counterpart's creator can NO LONGER self-withdraw counterpartEp because it is no longer an active duplicate!
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text)",
        [OTHER_AUTH, OTHER_APP, counterpartEp.entryId, "Late withdraw", idemKey()]),
      (err) => err.code === "PT409" && /not an active duplicate/i.test(err.message),
    );
  } finally {
    await db.close();
  }
});

test("HF: duplicate_cccd_withdraw grants only all-company duplicate withdrawal and audits the delegated actor", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const DELEGATE_AUTH = uuid(350), DELEGATE_APP = uuid(360);
    await insertActor(db, DELEGATE_AUTH, DELEGATE_APP, ["duplicate_cccd_withdraw"]);

    const first = await seedEpisode(db, {
      cccd: "079200009876", name: "Company Duplicate A", project: PROJ_A,
      date: "2026-10-05", createdBy: ADMIN_APP,
    });
    const second = await seedEpisode(db, {
      cccd: "079200009876", name: "Company Duplicate B", project: PROJ_A,
      date: "2026-10-05", createdBy: BOD_APP,
    });

    const delegatePrivileges = (await db.query(
      "select public.direct_entry_has_scope($1::uuid, 'all') as all_scope, " +
      "public.direct_entry_has_capability($1::uuid, 'entry_admin') as entry_admin, " +
      "public.direct_entry_has_capability($1::uuid, 'entry_privileged_edit') as privileged_edit",
      [DELEGATE_APP],
    )).rows[0];
    assert.deepEqual(delegatePrivileges, {
      all_scope: false, entry_admin: false, privileged_edit: false,
    }, "the narrow grant must not create general scope or administration rights");

    const delegateView = await report(db, {
      auth: DELEGATE_AUTH, app: DELEGATE_APP, managedOnly: false,
    });
    assert.equal(delegateView.groups.length, 1);
    assert.deepEqual(
      Object.fromEntries(delegateView.groups[0].episodes.map((episode) => [episode.entry_id, episode.can_self_withdraw])),
      { [first.entryId]: true, [second.entryId]: true },
      "the capability enables withdrawal actions on every episode in the visible company report",
    );

    const ungrantedView = await report(db, {
      auth: OUTSIDE_AUTH, app: OUTSIDE_APP, managedOnly: false,
    });
    assert.ok(ungrantedView.groups[0].episodes.every((episode) => !episode.can_self_withdraw));
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text)",
        [OUTSIDE_AUTH, OUTSIDE_APP, first.entryId, "Unauthorized withdrawal", idemKey()],
      ),
      (error) => error.code === "42501",
      "global report access alone must not grant global withdrawal",
    );

    assert.equal(await count(
      db,
      "select coalesce(sum(recruited_count), 0) from public.direct_entry_reporting_facts_v01",
    ), 2);
    const withdrawn = (await db.query(
      "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text) as data",
      [DELEGATE_AUTH, DELEGATE_APP, first.entryId, "Đã xác nhận hồ sơ trùng", idemKey()],
    )).rows[0].data;
    assert.deepEqual(withdrawn, { entry_id: first.entryId, version: 2 });

    const entry = (await db.query(
      "select voided_by_user_id, version from public.direct_entries where entry_id = $1",
      [first.entryId],
    )).rows[0];
    assert.equal(entry.voided_by_user_id, DELEGATE_APP);
    assert.equal(entry.version, 2);
    const audit = (await db.query(
      "select app_user_id, capability, scope_kind from public.direct_entry_audit_events " +
      "where resource_ref = $1 and action = 'entry_self_withdraw_duplicate_cccd' " +
      "and outcome = 'APPLIED'",
      [first.entryId],
    )).rows[0];
    assert.deepEqual(audit, {
      app_user_id: DELEGATE_APP,
      capability: "duplicate_cccd_withdraw",
      scope_kind: "all",
    }, "audit must identify the delegated capability rather than mislabeling the creator");
    assert.equal( await count(
      db,
      "select coalesce(sum(recruited_count), 0) from public.direct_entry_reporting_facts_v01",
    ), 1, "the withdrawn duplicate is removed from recruitment reporting facts exactly once");
    assert.equal((await report(db, {
      auth: DELEGATE_AUTH, app: DELEGATE_APP, managedOnly: false,
    })).total_groups, 0);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 14. T1C HF: Same-(CCCD, project_id, first_work_date) clusters stay in the
//     report across ON+OFF and OFF+OFF, while cross-day/cross-project OFF
//     rehires stay excluded, and void/soft-delete recalculates or drops groups.
// ---------------------------------------------------------------------------
test("HF same-project-same-day: ON+OFF and OFF+OFF stay reported, cross-day/cross-project OFF stay excluded, and void/soft-delete recalculates", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const DELEGATE_AUTH = uuid(450), DELEGATE_APP = uuid(460);
    await insertActor(db, DELEGATE_AUTH, DELEGATE_APP, ["duplicate_cccd_withdraw"]);

    // Case 1 & 2: Same CCCD (079200001111) + same project (PROJ_A) + same first_work_date (2026-10-05)
    // Start with two ON profiles created at different times:
    const ep1 = await seedEpisode(db, {
      cccd: "079200001111", name: "Same Day Dup 1", project: PROJ_A,
      date: "2026-10-05", status: "ON", createdBy: ADMIN_APP,
    });
    const ep2 = await seedEpisode(db, {
      cccd: "079200001111", name: "Same Day Dup 2", project: PROJ_A,
      date: "2026-10-05", status: "ON", createdBy: ADMIN_APP,
    });

    // Transition ep2 to OFF (ON + OFF on same project + same day):
    await appendStatus(db, ep2.entryId, "OFF", "2026-10-10", 2, null);

    const onOffRaw = await report(db, { auth: ADMIN_AUTH, app: ADMIN_APP, managedOnly: false });
    assert.equal(onOffRaw.total_groups, 1, "ON + OFF same project & day remains in report");
    assert.equal(onOffRaw.total_entries, 2);
    const onOffPage = projectDuplicateCccdReportRpcPage(onOffRaw, { page: 1, page_size: 25 });
    assert.ok(onOffPage, "ON + OFF group passes TypeScript RPC projection");
    assert.ok(
      projectDuplicateCccdReportResponse({ ok: true, ...onOffPage }, { page: 1, page_size: 25 }),
      "ON + OFF group passes API response projection",
    );
    const [onOffGroup] = onOffPage.groups;
    assert.equal(onOffGroup.profile_count, 2);
    assert.equal(onOffGroup.project_count, 1);
    assert.equal(onOffGroup.active_profile_count, 1);
    assert.deepEqual(
      onOffGroup.episodes.map((e) => ({
        entry_id: e.entry_id,
        latest_status: e.latest_status,
        active: e.active,
        can_mark_off: e.can_mark_off,
        can_self_withdraw: e.can_self_withdraw,
      })),
      [
        {
          entry_id: ep1.entryId,
          latest_status: "ON",
          active: true,
          can_mark_off: true,
          can_self_withdraw: true,
        },
        {
          entry_id: ep2.entryId,
          latest_status: "OFF",
          active: false,
          can_mark_off: false,
          can_self_withdraw: true,
        },
      ],
      "both ON and OFF episodes in a >=2 valid same-project-day duplicate group can be withdrawn by authorized actors",
    );

    // A delegated actor may withdraw either the ON or the OFF row in the >=2 valid duplicate group.
    const delegateOnOff = await report(db, { auth: DELEGATE_AUTH, app: DELEGATE_APP, managedOnly: false });
    assert.equal(
      delegateOnOff.groups[0].episodes.find((e) => e.entry_id === ep1.entryId).can_self_withdraw,
      true,
    );
    assert.equal(
      delegateOnOff.groups[0].episodes.find((e) => e.entry_id === ep2.entryId).can_self_withdraw,
      true,
    );

    // Transition ep1 to OFF as well (OFF + OFF on same project + same day):
    await appendStatus(db, ep1.entryId, "OFF", "2026-10-12", 2, null);

    // Recruitment facts are untouched by OFF transitions:
    assert.equal(
      await count(db, "select coalesce(sum(recruited_count), 0) from public.direct_entry_reporting_facts_v01"),
      2,
      "OFF transition never removes hires from recruitment facts",
    );

    const offOffRaw = await report(db, { auth: ADMIN_AUTH, app: ADMIN_APP, managedOnly: false });
    assert.equal(offOffRaw.total_groups, 1, "OFF + OFF same project & day remains in report");
    assert.equal(offOffRaw.total_entries, 2);
    const offOffPage = projectDuplicateCccdReportRpcPage(offOffRaw, { page: 1, page_size: 25 });
    assert.ok(offOffPage, "OFF + OFF group passes TypeScript RPC projection");
    assert.equal(offOffPage.groups[0].active_profile_count, 0);
    assert.deepEqual(
      offOffPage.groups[0].episodes.map((e) => ({
        latest_status: e.latest_status,
        active: e.active,
        can_mark_off: e.can_mark_off,
        can_self_withdraw: e.can_self_withdraw,
      })),
      [
        { latest_status: "OFF", active: false, can_mark_off: false, can_self_withdraw: true },
        { latest_status: "OFF", active: false, can_mark_off: false, can_self_withdraw: true },
      ],
    );

    // Case 3: Same CCCD + same project + DIFFERENT first_work_date, both OFF (or ON + OFF) -> NOT reported!
    const diffDay1 = await seedEpisode(db, {
      cccd: "079200002222", name: "Rehire Day 1", project: PROJ_A, date: "2026-01-05", status: "ON",
    });
    const diffDay2 = await seedEpisode(db, {
      cccd: "079200002222", name: "Rehire Day 2", project: PROJ_A, date: "2026-06-01", status: "ON",
    });
    await appendStatus(db, diffDay1.entryId, "OFF", "2026-02-01", 2, null);
    await appendStatus(db, diffDay2.entryId, "OFF", "2026-07-01", 2, null);

    // Case 4: Same CCCD + DIFFERENT project, both OFF (same day and different day) -> NOT reported!
    const diffProj1 = await seedEpisode(db, {
      cccd: "079200003333", name: "Diff Proj 1", project: PROJ_A, date: "2026-10-05", status: "ON",
    });
    const diffProj2 = await seedEpisode(db, {
      cccd: "079200003333", name: "Diff Proj 2", project: PROJ_B, date: "2026-10-05", status: "ON",
    });
    await appendStatus(db, diffProj1.entryId, "OFF", "2026-10-10", 2, null);
    await appendStatus(db, diffProj2.entryId, "OFF", "2026-10-10", 2, null);

    const checkExclusions = await report(db, { auth: ADMIN_AUTH, app: ADMIN_APP, managedOnly: false });
    assert.equal(checkExclusions.total_groups, 1, "cross-day and cross-project OFF pairs stay excluded");
    assert.deepEqual(checkExclusions.groups.map((g) => g.cccd_last4), ["1111"]);

    // Case 5: Add a 3rd same-(CCCD, project, day) row to 079200001111, then soft-delete one and void another:
    const ep3 = await seedEpisode(db, {
      cccd: "079200001111", name: "Same Day Dup 3", project: PROJ_A,
      date: "2026-10-05", status: "ON", createdBy: ADMIN_APP,
    });
    await appendStatus(db, ep3.entryId, "OFF", "2026-10-15", 2, null);

    const withThree = await report(db, { auth: ADMIN_AUTH, app: ADMIN_APP, managedOnly: false });
    assert.equal(withThree.total_groups, 1);
    assert.equal(withThree.total_entries, 3);
    assert.equal(withThree.groups[0].profile_count, 3);

    // Soft-delete ep3 -> group recalculates from 3 to 2:
    await softDeleteEntry(db, ep3.entryId);
    const afterSoftDelete = await report(db, { auth: ADMIN_AUTH, app: ADMIN_APP, managedOnly: false });
    assert.equal(afterSoftDelete.total_groups, 1);
    assert.equal(afterSoftDelete.total_entries, 2);
    assert.equal(afterSoftDelete.groups[0].profile_count, 2);

    // Apply ENTRY_VOID to ep2 -> only 1 eligible row remains in the cluster, so the group disappears:
    const voidReasonId = (await db.query(
      "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text) values ($1, 'Void historical duplicate') returning reason_id",
      [ADMIN_APP],
    )).rows[0].reason_id;
    await db.query(
      "update public.direct_entries set voided_at = now(), voided_by_user_id = $2, void_reason_id = $3, version = version + 1 where entry_id = $1",
      [ep2.entryId, ADMIN_APP, voidReasonId],
    );
    const afterVoid = await report(db, { auth: ADMIN_AUTH, app: ADMIN_APP, managedOnly: false });
    assert.equal(afterVoid.total_groups, 0, "group disappears once < 2 non-deleted, non-voided rows remain");
    assert.equal(afterVoid.total_entries, 0);
    assert.deepEqual(afterVoid.groups, []);

    // An OFF target cannot be withdrawn against an unrelated rehire on another date.
    const offRehire = await seedEpisode(db, {
      cccd: "079200004444", name: "OFF duplicate from another date", project: PROJ_A,
      date: "2026-10-05", status: "ON", createdBy: ADMIN_APP,
    });
    const onRehire = await seedEpisode(db, {
      cccd: "079200004444", name: "Different-date active rehire", project: PROJ_A,
      date: "2026-11-05", status: "ON", createdBy: ADMIN_APP,
    });
    await appendStatus(db, offRehire.entryId, "OFF", "2026-10-10", 2, null);
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text)",
        [DELEGATE_AUTH, DELEGATE_APP, offRehire.entryId, "Do not conflate a rehire", idemKey()],
      ),
      (err) => err.code === "PT409" && /not an active duplicate/i.test(err.message),
    );

    // Same-project-same-day ON + OFF: withdraw the OFF duplicate, preserve the ON employee,
    // and keep the narrow delegated audit attribution.
    const retained = await seedEpisode(db, {
      cccd: "079200005555", name: "Retained active employee", project: PROJ_A,
      date: "2026-10-05", status: "ON", createdBy: ADMIN_APP,
    });
    const resignedDuplicate = await seedEpisode(db, {
      cccd: "079200005555", name: "Resigned duplicate", project: PROJ_A,
      date: "2026-10-05", status: "ON", createdBy: ADMIN_APP,
    });
    await appendStatus(db, resignedDuplicate.entryId, "OFF", "2026-10-10", 2, null);

    const eligibleView = await report(db, { auth: DELEGATE_AUTH, app: DELEGATE_APP, managedOnly: false });
    const eligibleGroup = eligibleView.groups.find((g) => g.cccd_last4 === "5555");
    assert.ok(eligibleGroup);
    const offAction = eligibleGroup.episodes.find((e) => e.entry_id === resignedDuplicate.entryId);
    const retainedAction = eligibleGroup.episodes.find((e) => e.entry_id === retained.entryId);
    assert.equal(offAction.can_self_withdraw, true);
    assert.equal(retainedAction.can_self_withdraw, true);

    const withdrawnOff = (await db.query(
      "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text) as data",
      [DELEGATE_AUTH, DELEGATE_APP, resignedDuplicate.entryId, offAction.entry_version, "Remove resigned duplicate", idemKey()],
    )).rows[0].data;
    assert.deepEqual(withdrawnOff, { entry_id: resignedDuplicate.entryId, version: 2 });
    const withdrawnRow = (await db.query(
      "select voided_at, voided_by_user_id from public.direct_entries where entry_id=$1",
      [resignedDuplicate.entryId],
    )).rows[0];
    assert.notEqual(withdrawnRow.voided_at, null);
    assert.equal(withdrawnRow.voided_by_user_id, DELEGATE_APP);
    const delegatedAudit = (await db.query(
      "select capability, scope_kind from public.direct_entry_audit_events " +
      "where resource_ref=$1 and action='entry_self_withdraw_duplicate_cccd' and outcome='APPLIED'",
      [resignedDuplicate.entryId],
    )).rows[0];
    assert.deepEqual(delegatedAudit, { capability: "duplicate_cccd_withdraw", scope_kind: "all" });
    const afterOffWithdraw = await report(db, { auth: DELEGATE_AUTH, app: DELEGATE_APP, managedOnly: false });
    assert.equal(afterOffWithdraw.groups.some((g) => g.cccd_last4 === "5555"), false);
    assert.equal(await count(db, "select count(*) from public.direct_entries where entry_id=$1 and voided_at is null", [retained.entryId]), 1);
    assert.equal(await count(db, "select count(*) from public.direct_entries where entry_id=$1 and voided_at is null", [onRehire.entryId]), 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 15. T1C HF: ON+UNCONFIRMED, UNCONFIRMED+UNCONFIRMED, action flag alignment,
//     and pagination/totals when mixing live and historical same-project-day groups.
// ---------------------------------------------------------------------------
test("HF UNCONFIRMED contract + action flag consistency + mixed live/historical pagination", async () => {
  const db = await buildDb();
  try {
    await seed(db);

    // Three active profiles with one CCCD but three different projects/dates are rehires,
    // not a duplicate cluster (the screenshot case).
    const unrelated1 = await seedEpisode(db, {
      cccd: "079200001000", name: "Unrelated active 1", project: PROJ_A, date: "2026-10-01",
      status: "ON", createdBy: ADMIN_APP,
    });
    await seedEpisode(db, {
      cccd: "079200001000", name: "Unrelated active 2", project: PROJ_B, date: "2026-10-02",
      status: "ON", createdBy: ADMIN_APP,
    });
    await seedEpisode(db, {
      cccd: "079200001000", name: "Unrelated active 3", project: PROJ_C, date: "2026-10-03",
      status: "ON", createdBy: ADMIN_APP,
    });

    // Group 1 (last4: 1001): ON + UNCONFIRMED in the same project/day duplicate cluster.
    const g1On = await seedEpisode(db, {
      cccd: "079200001001", name: "G1 ON", project: PROJ_A, date: "2026-10-01",
      status: "ON", createdBy: ADMIN_APP,
    });
    const g1Unc = await seedEpisode(db, {
      cccd: "079200001001", name: "G1 UNCONFIRMED", project: PROJ_A, date: "2026-10-01",
      status: "UNCONFIRMED", createdBy: ADMIN_APP,
    });

    // Group 2 (last4: 1002): UNCONFIRMED + UNCONFIRMED (same project & day)
    await seedEpisode(db, {
      cccd: "079200001002", name: "G2 UNC A", project: PROJ_A, date: "2026-10-03",
      status: "UNCONFIRMED", createdBy: ADMIN_APP,
    });
    await seedEpisode(db, {
      cccd: "079200001002", name: "G2 UNC B", project: PROJ_A, date: "2026-10-03",
      status: "UNCONFIRMED", createdBy: ADMIN_APP,
    });

    // Group 3 (last4: 1003): ON + ON + OFF on same project & day -> active_profile_count = 2
    // Plus a 4th OFF episode on a DIFFERENT project (PROJ_B) which must NOT be included!
    const g3On1 = await seedEpisode(db, {
      cccd: "079200001003", name: "G3 ON 1", project: PROJ_A, date: "2026-10-04",
      status: "ON", createdBy: ADMIN_APP,
    });
    const g3On2 = await seedEpisode(db, {
      cccd: "079200001003", name: "G3 ON 2", project: PROJ_A, date: "2026-10-04",
      status: "ON", createdBy: ADMIN_APP,
    });
    const g3OffSame = await seedEpisode(db, {
      cccd: "079200001003", name: "G3 OFF Same", project: PROJ_A, date: "2026-10-04",
      status: "ON", createdBy: ADMIN_APP,
    });
    await appendStatus(db, g3OffSame.entryId, "OFF", "2026-10-06", 2, null);

    const g3OffOtherProj = await seedEpisode(db, {
      cccd: "079200001003", name: "G3 OFF Other Proj", project: PROJ_B, date: "2026-05-01",
      status: "ON", createdBy: ADMIN_APP,
    });
    await appendStatus(db, g3OffOtherProj.entryId, "OFF", "2026-06-01", 2, null);

    // Read full page and verify TypeScript contract projection does not fail closed (no 500):
    const fullRaw = await report(db, { auth: ADMIN_AUTH, app: ADMIN_APP, page: 1, pageSize: 25, managedOnly: false });
    assert.equal(fullRaw.total_groups, 3);
    assert.equal(fullRaw.total_entries, 7, "three matching clusters; unrelated rehires and the lone OFF episode are excluded");
    assert.equal(fullRaw.groups.some((g) => g.cccd_last4 === "1000"), false,
      "same CCCD across three distinct projects/dates is not reported as a duplicate");
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text)",
        [ADMIN_AUTH, ADMIN_APP, unrelated1.entryId, "Do not withdraw a legitimate rehire", idemKey()],
      ),
      (err) => err.code === "PT409",
      "direct RPC calls also reject rows outside a same-project same-day duplicate cluster",
    );
    const fullProjected = projectDuplicateCccdReportRpcPage(fullRaw, { page: 1, page_size: 25 });
    assert.ok(fullProjected, "mixed ON/UNCONFIRMED/OFF payload passes TypeScript RPC projection");
    assert.ok(
      projectDuplicateCccdReportResponse({ ok: true, ...fullProjected }, { page: 1, page_size: 25 }),
      "mixed payload passes API/UI response contract",
    );

    const [projG1, projG2, projG3] = fullProjected.groups;

    // Verify Group 1 (ON + UNCONFIRMED):
    assert.equal(projG1.cccd_last4, "1001");
    assert.equal(projG1.profile_count, 2);
    assert.equal(projG1.active_profile_count, 1);
    assert.deepEqual(
      projG1.episodes.map((e) => ({
        entry_id: e.entry_id,
        status: e.latest_status,
        active: e.active,
        can_mark_off: e.can_mark_off,
        can_self_withdraw: e.can_self_withdraw,
      })),
      [
        { entry_id: g1On.entryId, status: "ON", active: true, can_mark_off: true, can_self_withdraw: false },
        { entry_id: g1Unc.entryId, status: "UNCONFIRMED", active: false, can_mark_off: false, can_self_withdraw: false },
      ],
      "ON + UNCONFIRMED has active_profile_count=1 so neither episode emits can_self_withdraw=true",
    );

    // Verify Group 2 (UNCONFIRMED + UNCONFIRMED):
    assert.equal(projG2.cccd_last4, "1002");
    assert.equal(projG2.profile_count, 2);
    assert.equal(projG2.active_profile_count, 0);
    assert.ok(projG2.episodes.every((e) =>
      e.latest_status === "UNCONFIRMED" && !e.active && !e.can_mark_off && !e.can_self_withdraw));

    // Verify Group 3 (ON + ON + OFF on same project & day, excluding g3OffOtherProj):
    assert.equal(projG3.cccd_last4, "1003");
    assert.equal(projG3.profile_count, 3);
    assert.equal(projG3.project_count, 1);
    assert.equal(projG3.active_profile_count, 2);
    assert.deepEqual(
      projG3.episodes.map((e) => ({
        entry_id: e.entry_id,
        status: e.latest_status,
        active: e.active,
        can_mark_off: e.can_mark_off,
        can_self_withdraw: e.can_self_withdraw,
      })),
      [
        { entry_id: g3On1.entryId, status: "ON", active: true, can_mark_off: true, can_self_withdraw: true },
        { entry_id: g3On2.entryId, status: "ON", active: true, can_mark_off: true, can_self_withdraw: true },
        { entry_id: g3OffSame.entryId, status: "OFF", active: false, can_mark_off: false, can_self_withdraw: true },
      ],
      "ON episodes allow withdrawal with another active row; OFF same-project-day rows can be withdrawn while an active sibling remains",
    );

    // Verify pagination across the 3 mixed groups (pageSize = 2):
    const page1Raw = await report(db, { auth: ADMIN_AUTH, app: ADMIN_APP, page: 1, pageSize: 2, managedOnly: false });
    const page1 = projectDuplicateCccdReportRpcPage(page1Raw, { page: 1, page_size: 2 });
    assert.ok(page1);
    assert.equal(page1.total_groups, 3);
    assert.equal(page1.total_entries, 7);
    assert.equal(page1.has_more, true);
    assert.deepEqual(page1.groups.map((g) => g.cccd_last4), ["1001", "1002"]);

    const page2Raw = await report(db, { auth: ADMIN_AUTH, app: ADMIN_APP, page: 2, pageSize: 2, managedOnly: false });
    const page2 = projectDuplicateCccdReportRpcPage(page2Raw, { page: 2, page_size: 2 });
    assert.ok(page2);
    assert.equal(page2.total_groups, 3);
    assert.equal(page2.total_entries, 7);
    assert.equal(page2.has_more, false);
    assert.deepEqual(page2.groups.map((g) => g.cccd_last4), ["1003"]);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 16. T1A HF: Assigned Project Manager (QLDA) can withdraw ON and OFF duplicate
//     profiles (including OFF+OFF groups) in their assigned projects, is denied
//     outside their assigned projects, and cannot withdraw the last remaining profile.
// ---------------------------------------------------------------------------
test("HF QLDA + OFF+OFF withdrawal: assigned project manager can withdraw ON/OFF duplicates in managed projects and is denied outside managed projects", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const PM_AUTH = uuid(531), PM_APP = uuid(541), PM_REC = uuid(521);
    const CREATOR_AUTH = uuid(532), CREATOR_APP = uuid(542);

    await db.query(
      "insert into public.recruiters (recruiter_id, display_name, active) values ($1, 'Assigned PM Recruiter', true)",
      [PM_REC],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1, 'hrp', '2020-01-01', true)",
      [PM_REC],
    );
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1, $2, '2020-01-01', true)",
      [PM_REC, TEAM],
    );

    await insertActor(db, PM_AUTH, PM_APP, ["entry_own"], ["own"]);
    await insertActor(db, CREATOR_AUTH, CREATOR_APP, ["entry_own"], ["own"]);
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1, $2, true, '2020-01-01', true)",
      [PM_APP, PM_REC],
    );
    // Assign PM_APP as current Project Manager ONLY for PROJ_A (not PROJ_B):
    await db.query(
      "insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current) values ($1, $2, '2020-01-01', true)",
      [PROJ_A, PM_REC],
    );

    // Seed an OFF + OFF duplicate cluster in PROJ_A (created by CREATOR_APP, not PM_APP):
    const projAOff1 = await seedEpisode(db, {
      cccd: "079200007777", name: "ProjA Resigned 1", project: PROJ_A, date: "2026-10-05",
      status: "ON", createdBy: CREATOR_APP,
    });
    const projAOff2 = await seedEpisode(db, {
      cccd: "079200007777", name: "ProjA Resigned 2", project: PROJ_A, date: "2026-10-05",
      status: "ON", createdBy: CREATOR_APP,
    });
    await appendStatus(db, projAOff1.entryId, "OFF", "2026-10-08", 2, null);
    await appendStatus(db, projAOff2.entryId, "OFF", "2026-10-09", 2, null);

    // Seed an ON + OFF duplicate cluster in PROJ_B (created by CREATOR_APP, not managed by PM_APP):
    await seedEpisode(db, {
      cccd: "079200008888", name: "ProjB Active", project: PROJ_B, date: "2026-10-05",
      status: "ON", createdBy: CREATOR_APP,
    });
    const projBOff = await seedEpisode(db, {
      cccd: "079200008888", name: "ProjB Resigned", project: PROJ_B, date: "2026-10-05",
      status: "ON", createdBy: CREATOR_APP,
    });
    await appendStatus(db, projBOff.entryId, "OFF", "2026-10-08", 2, null);

    // Verify PM_APP report projection:
    // - In PROJ_A (OFF+OFF): can_self_withdraw = true on both OFF profiles
    // - In PROJ_B (ON+OFF, unmanaged): can_self_withdraw = false on both profiles
    const pmReport = await report(db, { auth: PM_AUTH, app: PM_APP, managedOnly: false });
    const groupA = pmReport.groups.find((g) => g.cccd_last4 === "7777");
    const groupB = pmReport.groups.find((g) => g.cccd_last4 === "8888");
    assert.ok(groupA);
    assert.ok(groupB);
    assert.deepEqual(
      groupA.episodes.map((e) => e.can_self_withdraw),
      [true, true],
      "assigned QLDA gets can_self_withdraw=true on OFF+OFF duplicate profiles in their managed project",
    );
    assert.deepEqual(
      groupB.episodes.map((e) => e.can_self_withdraw),
      [false, false],
      "assigned QLDA does not get can_self_withdraw on projects they do not manage",
    );

    // Server RPC rejects PM_APP attempting to withdraw an episode in PROJ_B (unmanaged):
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text)",
        [PM_AUTH, PM_APP, projBOff.entryId, "Unmanaged project attempt", idemKey()],
      ),
      (err) => err.code === "42501",
      "QLDA must be rejected with 42501 when attempting to withdraw from an unmanaged project",
    );

    // Assigned QLDA withdraws projAOff1 from the OFF+OFF cluster in PROJ_A:
    const withdrawRes = (await db.query(
      "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text) as data",
      [PM_AUTH, PM_APP, projAOff1.entryId, "QLDA rút hồ sơ trùng đã nghỉ", idemKey()],
    )).rows[0].data;
    assert.deepEqual(withdrawRes, { entry_id: projAOff1.entryId, version: 2 });

    // Audit records capability='project_manager_self_withdraw' and scope_kind='project':
    const pmAudit = (await db.query(
      "select app_user_id, capability, scope_kind from public.direct_entry_audit_events " +
      "where resource_ref = $1 and action = 'entry_self_withdraw_duplicate_cccd' and outcome = 'APPLIED'",
      [projAOff1.entryId],
    )).rows[0];
    assert.deepEqual(pmAudit, {
      app_user_id: PM_APP,
      capability: "project_manager_self_withdraw",
      scope_kind: "project",
    });

    // Group 7777 now has only 1 remaining OFF profile (projAOff2), so it disappears from the report
    // and cannot be withdrawn a second time (neither by QLDA nor by creator):
    const afterPmWithdraw = await report(db, { auth: PM_AUTH, app: PM_APP, managedOnly: false });
    assert.equal(afterPmWithdraw.groups.some((g) => g.cccd_last4 === "7777"), false);
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text)",
        [PM_AUTH, PM_APP, projAOff2.entryId, "Cannot withdraw last remaining profile", idemKey()],
      ),
      (err) => err.code === "PT409" && /not an active duplicate/i.test(err.message),
    );
    await assert.rejects(
      () => db.query(
        "select public.direct_entry_self_withdraw_duplicate_cccd($1::uuid,$2::uuid,$3::uuid,1,$4::text,$5::text)",
        [CREATOR_AUTH, CREATOR_APP, projAOff2.entryId, "Creator also cannot withdraw last remaining profile", idemKey()],
      ),
      (err) => err.code === "PT409" && /not an active duplicate/i.test(err.message),
    );
  } finally {
    await db.close();
  }
});
