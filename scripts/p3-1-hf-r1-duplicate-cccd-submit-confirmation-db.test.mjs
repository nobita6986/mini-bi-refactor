/**
 * P3.1-HF-R1 - canh bao CCCD trung khi chuyen ban nhap sang cho duyet.
 *
 * Luu y nghiep vu: luu ho so (create, update, paste, import, full profile, autosave,
 * save draft, rehire) KHONG bao gio bao loi hay hoi gi chi vi CCCD trung. Chi mot
 * duong duy nhat - DRAFT -> SUBMITTED - moi kiem tra va co the yeu cau nguoi dung xac nhan.
 *
 * Lane nay khoa bon nhom hop dong:
 *   A. status matrix: chi ON / UNCONFIRMED (ke ca thieu event => UNCONFIRMED) moi canh
 *      bao; OFF khong bao gio duoc canh bao;
 *   B. pham vi match: cung project, khac project, cung submission, self-match, soft
 *      delete, CCCD khong canonical, va bien the dinh dang;
 *   C. workflow: save/import van luu binh thuong, DRAFT -> SUBMITTED co conflict thi
 *      confirmation-required voi zero residue, xac nhan dung fingerprint thi moi doi
 *      trang thai, fingerprint gia/stale khong bypass, idempotent replay va double-click
 *      khong tao transition/audit thu hai, va cac transition khac khong chay canh bao;
 *   D. projection: masked, bounded, deterministic, exact-key, khong UUID, khong ten
 *      nguoi khac, khong CCCD day du, khong nhan tieng Viet trong SQL.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { replaceFunctionSourceForMutationProbe } from "./lib/mutate-pglite-function-source.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const HOTFIX_MIGRATION = "20261009100000_p3_1_hf_duplicate_cccd_reporting.sql";
const PREVIOUS_MIGRATION = "20261009090000_p3_1_hf_recruiter_alias_backfill.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

const PREFLIGHT_FN = "public.direct_entry_submission_duplicate_cccd_preflight";
const CONFIRMED_FN =
  "public.direct_entry_transition_submission_duplicate_cccd_confirmed";
const STATE_FN = "public.direct_entry_submission_duplicate_cccd_state";
const APPLY_FN = "public.direct_entry_transition_submission_apply";
const LEGACY_FN = "public.direct_entry_transition_submission";

const PREFLIGHT_SIGNATURE = PREFLIGHT_FN + "(uuid,uuid,uuid)";
const CONFIRMED_SIGNATURE =
  CONFIRMED_FN + "(uuid,uuid,uuid,integer,text,text,text,integer)";
const STATE_SIGNATURE = STATE_FN + "(uuid)";
const APPLY_SIGNATURE = APPLY_FN + "(uuid,uuid,uuid,integer,text,text,text,integer)";
const LEGACY_SIGNATURE = LEGACY_FN + "(uuid,uuid,uuid,integer,text,text)";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "hf_r1_proj_a";
const PROJ_B = "hf_r1_proj_b";
const REC_A = uuid(21);

// Nguoi tao submission (recruiter): day du quyen ghi cua cac writer hien co + own scope.
const OWNER_AUTH = uuid(31), OWNER_APP = uuid(41);
// Actor duoc map va co capability nhung KHONG co own scope nao: moi duong phai fail-closed.
const NO_SCOPE_AUTH = uuid(32), NO_SCOPE_APP = uuid(42);
// Actor khac co own scope: khong phai chu submission thi khong duoc doc/chuyen.
const OUTSIDER_AUTH = uuid(33), OUTSIDER_APP = uuid(43);
// Khong bao gio nam trong direct_entry_app_users.
const UNMAPPED_AUTH = uuid(34), UNMAPPED_APP = uuid(44);

const OWNER_CAPABILITIES = [
  "entry_admin", "recruiter_master_manage", "team_master_manage",
  "entry_create", "submission_create", "employment_status.apply", "change_request_create",
];

const CONFIRMATION_REQUIRED = /duplicate cccd acknowledgement required/;
const CONFIRMATION_MALFORMED = /duplicate cccd acknowledgement is malformed/;
const CONFIRMATION_TARGET = /duplicate cccd acknowledgement needs the submitted target/;

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
  assert.equal(names.indexOf(HOTFIX_MIGRATION), 73, "the contract ships in #74");
  assert.equal(names.indexOf(PREVIOUS_MIGRATION), 72, "#74 stays append-only");
  return db;
}

async function insertActor(db, auth, app, capabilities, scopeKinds = []) {
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,true,'R1 Account')", [app, auth]);
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

function workerDetails(cccd) {
  return {
    date_of_birth: { state: "provided", value: "1990-01-01" },
    national_id: cccd === null ? { state: "unknown" } : { state: "provided", value: cccd },
    address: { state: "provided", value: "R1 address" },
    phone: { state: "provided", value: "0900000000" },
  };
}

let seq = 0;
function nextId(base) {
  seq += 1;
  return uuid(base + seq);
}

function nextCode() {
  seq += 1;
  return "hrp-2026-" + String(700000 + seq);
}

// Cac writer hien co doi idempotency key dung dang UUID, nen key phai duoc dan xuat
// (deterministically) tu label chu khong phai chuoi tu do.
function idemKey(label) {
  seq += 1;
  const digest = createHash("sha256").update(label + ":" + String(seq)).digest("hex");
  return "9" + digest.slice(0, 7) + "-0000-4000-8000-" + digest.slice(7, 19);
}

async function count(db, sql, params = []) {
  const result = await db.query(sql, params);
  return Number(Object.values(result.rows[0])[0]);
}

let reasonSeq = 0;
async function appendStatus(db, entryId, status, date, version, supersedesEventId) {
  reasonSeq += 1;
  const reasonId = (await db.query(
    "insert into public.direct_entry_restricted_reasons (actor_user_id, reason_text)" +
    " values ($1,$2) returning reason_id::text as id",
    [OWNER_APP, `R1 reason ${reasonSeq}`])).rows[0].id;
  return (await db.query(
    "insert into public.direct_entry_employment_status_events" +
    " (entry_id, status, effective_date, leave_date, leave_reason_text, version," +
    " actor_user_id, reason_id, supersedes_event_id)" +
    " values ($1,$2,$3::date, case when $2 = 'OFF' then $3::date else null end," +
    " case when $2 = 'OFF' then 'R1 synthetic leave' else null end, $4,$5,$6,$7)" +
    " returning event_id::text as id",
    [entryId, status, date, version, OWNER_APP, reasonId, supersedesEventId])).rows[0].id;
}

async function softDeleteEntry(db, entryId) {
  await db.query(
    "update public.direct_entries set deleted_at = $2::timestamptz, version = version + 1" +
    " where entry_id = $1", [entryId, "2026-02-01T00:00:00Z"]);
}

/**
 * Mot episode DA TON TAI (submission da qua SUBMITTED) voi lich su trang thai tuy y.
 * `statuses` la mang [status, supersedes, effectiveDate] theo version tang dan:
 *   * version 1 phai la ON/UNCONFIRMED dung ngay first_work_date (luat initial status);
 *   * OFF luon la event sau, khong bao gio la event dau tien;
 *   * supersedes = "previous" nghia la correction tro vao event lien truoc (bat buoc khi
 *     mo lai mot episode dang OFF).
 */
async function seedExisting(db, {
  cccd, name, project = PROJ_A, date = "2026-01-05", statuses = [["ON", null]], deleted = false,
}) {
  const candidate = nextId(1000);
  const submission = nextId(2000);
  const entry = nextId(3000);
  const code = nextCode();
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidate]);
    await db.query(
      "insert into public.direct_entry_submissions" +
      " (submission_id, created_by_user_id, state, version, submitted_at)" +
      " values ($1,$2,'SUBMITTED',3,now())", [submission, OWNER_APP]);
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
      " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
      " provider_type, labor_type, deleted_at)" +
      " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY',null)",
      [entry, submission, candidate, OWNER_APP, project, date, code,
        JSON.stringify({ display_name: name, ...workerDetails(cccd) }), REC_A, TEAM]);
    let previous = null;
    let version = 1;
    for (const [status, supersedes, eventDate] of statuses) {
      previous = await appendStatus(db, entry, status, eventDate ?? date, version,
        supersedes === "previous" ? previous : supersedes);
      version += 1;
    }
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
  if (deleted) await softDeleteEntry(db, entry);
  return { entryId: entry, submissionId: submission, employeeCode: code };
}

/** Mot submission DRAFT voi 1..n dong - duong vao cua preflight va confirm. */
async function seedDraft(db, rows, { creator = OWNER_APP, state = "DRAFT", version = 1 } = {}) {
  const submission = nextId(2000);
  await db.exec("begin");
  try {
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state, version)" +
      " values ($1,$2,$3,$4)", [submission, creator, state, version]);
    const entryIds = [];
    for (const row of rows) {
      const candidate = nextId(1000);
      const entry = nextId(3000);
      await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [candidate]);
      await db.query(
        "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id," +
        " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id," +
        " provider_type, labor_type, deleted_at)" +
        " values ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,'hrp','TEMPORARY',null)",
        [entry, submission, candidate, creator, row.project ?? PROJ_A,
          row.date ?? "2026-10-01", row.code ?? nextCode(),
          JSON.stringify({ display_name: row.name ?? "R1 Draft", ...workerDetails(row.cccd ?? null) }),
          REC_A, TEAM]);
      entryIds.push(entry);
    }
    await db.exec("commit");
    return { submissionId: submission, entryIds };
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

/** Nen tang: team, hai project, recruiter va ba actor. */
async function seed(db) {
  await db.query(
    "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_R1','Team R1')", [TEAM]);
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project R1 A')",
    [PROJ_A]);
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name) values ($1,'Project R1 B')",
    [PROJ_B]);
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter R1')", [REC_A]);
  await db.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
    " values ($1,'hrp','2020-01-01',true)", [REC_A]);
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
    " values ($1,$2,'2020-01-01',true)", [REC_A, TEAM]);

  // Cac writer hien co (full-profile v1/v2 va legacy batch) van yeu cau scope 'all' cho mot so
  // truong ho so, nen actor nay giu ca hai; hop dong transition chi doi own scope + capability.
  await insertActor(db, OWNER_AUTH, OWNER_APP, OWNER_CAPABILITIES, ["own", "all"]);
  await insertActor(db, NO_SCOPE_AUTH, NO_SCOPE_APP, ["submission_create"]);
  await insertActor(db, OUTSIDER_AUTH, OUTSIDER_APP, ["submission_create"], ["own"]);
}

async function preflight(db, { auth = OWNER_AUTH, app = OWNER_APP, submissionId } = {}) {
  return (await db.query(
    "select " + PREFLIGHT_FN + "($1::uuid,$2::uuid,$3::uuid) as data",
    [auth, app, submissionId])).rows[0].data;
}

async function legacyTransition(db, {
  auth = OWNER_AUTH, app = OWNER_APP, submissionId, version, target = "SUBMITTED", key = null,
}) {
  return (await db.query(
    "select public.direct_entry_transition_submission" +
    "($1::uuid,$2::uuid,$3::uuid,$4::int,$5::text,$6::text) as data",
    [auth, app, submissionId, version, target, key ?? idemKey("legacy")])).rows[0].data;
}

async function confirmedTransition(db, {
  auth = OWNER_AUTH, app = OWNER_APP, submissionId, version, target = "SUBMITTED",
  key = null, fingerprint, conflicts,
}) {
  return (await db.query(
    "select " + CONFIRMED_FN + "($1::uuid,$2::uuid,$3::uuid,$4::int,$5::text,$6::text," +
    "$7::text,$8::int) as data",
    [auth, app, submissionId, version, target, key ?? idemKey("confirmed"), fingerprint,
      conflicts])).rows[0].data;
}

async function submissionRow(db, submissionId) {
  const row = (await db.query(
    "select state, version::int as version from public.direct_entry_submissions" +
    " where submission_id = $1", [submissionId])).rows[0];
  return { state: row.state, version: Number(row.version) };
}

async function auditRows(db, submissionId) {
  return (await db.query(
    "select a.action, a.outcome, a.changed_fields, r.reason_text" +
    " from public.direct_entry_audit_events a" +
    " left join public.direct_entry_restricted_reasons r on r.reason_id = a.reason_id" +
    " where a.resource_ref = $1 order by a.created_at", [submissionId])).rows;
}

async function assertRejects(run, pattern, label) {
  await assert.rejects(run, (error) => {
    assert.match(error.message, pattern, label);
    return true;
  }, label);
}

/** Zero residue: van DRAFT, version khong doi, khong audit, revision hay idempotency. */
async function assertZeroResidue(db, submissionId, { version, key = null } = {}) {
  assert.deepEqual(await submissionRow(db, submissionId), { state: "DRAFT", version },
    "submission phai van la DRAFT dung version cu");
  assert.equal(await count(db,
    "select count(*) from public.direct_entry_audit_events" +
    " where resource_ref = $1 and action = 'submission_transition'",
    [submissionId]), 0, "preflight/cancel khong duoc ghi audit transition");
  assert.equal(await count(db,
    "select count(*) from public.direct_entry_submission_revisions" +
    " where submission_id = $1 and version > 1",
    [submissionId]), 0, "khong duoc tao revision transition moi");
  if (key) {
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_rpc_idempotency where idempotency_key = $1",
      [key]), 0, "khong duoc de lai idempotency row");
  }
}

/** Duong ghi that: full-profile v1 batch tao mot submission DRAFT. */
async function createFullProfile(db, {
  cccd, name, project = PROJ_A, date = "2026-10-02", code = null, key = "full-profile",
}) {
  await db.query(
    "select public.direct_entry_create_full_profile_batch($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text)",
    [OWNER_AUTH, OWNER_APP, "worker-profile/1.0", JSON.stringify([{
      project_id: project, first_work_date: date, employee_code: code ?? nextCode(),
      recruiter_id: REC_A, labor_type: "TEMPORARY", display_name: name,
      worker_details: workerDetails(cccd),
    }]), idemKey(key)]);
  return (await db.query(
    "select entry_id::text as \"entryId\", submission_id::text as \"submissionId\"" +
    " from public.direct_entries where worker_details->'national_id'->>'value' = $1" +
    " order by created_at desc limit 1", [cccd])).rows[0];
}


// ---------------------------------------------------------------------------
// A. Status matrix - chi ON / UNCONFIRMED (ke ca thieu event) moi canh bao.
// ---------------------------------------------------------------------------
test("P3.1-HF-R1 A1-A3: ON, UNCONFIRMED and a missing event all require confirmation", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const cases = [
      { label: "ON", cccd: "012345678901", statuses: [["ON", null]], expected: "ON" },
      { label: "UNCONFIRMED", cccd: "012345678902",
        statuses: [["UNCONFIRMED", null]], expected: "UNCONFIRMED" },
      { label: "no event", cccd: "012345678903", statuses: [], expected: "UNCONFIRMED" },
    ];
    for (const item of cases) {
      await seedExisting(db, { cccd: item.cccd, name: "R1 Existing " + item.label,
        statuses: item.statuses, date: "2026-01-05" });
      const draft = await seedDraft(db, [{ cccd: item.cccd, name: "R1 Draft " + item.label }]);
      const view = await preflight(db, { submissionId: draft.submissionId });
      assert.equal(view.conflict_count, 1, item.label);
      assert.equal(view.conflicts.length, 1, item.label);
      assert.equal(view.conflicts[0].employment_status, item.expected, item.label);
      assert.equal(view.conflicts[0].cccd_last4, item.cccd.slice(-4), item.label);
      assert.equal(view.version, 1, item.label);

      const refusedKey = idemKey("a1-refused");
      await assertRejects(() => legacyTransition(db, {
        submissionId: draft.submissionId, version: 1, key: refusedKey,
      }), CONFIRMATION_REQUIRED, item.label);
      await assertZeroResidue(db, draft.submissionId, { version: 1, key: refusedKey });

      const applied = await confirmedTransition(db, {
        submissionId: draft.submissionId, version: 1, key: idemKey("a1-applied"),
        fingerprint: view.fingerprint, conflicts: view.conflict_count,
      });
      assert.equal(applied.status, "applied", item.label);
      assert.equal(applied.state, "SUBMITTED", item.label);
      assert.equal(applied.version, 2, item.label);
      assert.deepEqual(await submissionRow(db, draft.submissionId),
        { state: "SUBMITTED", version: 2 }, item.label);
    }
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 A4-A5-A10: OFF never warns, so those transitions run without confirmation", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const cases = [
      { cccd: "123456789", statuses: [["ON", null], ["OFF", null]], label: "latest OFF (A4)" },
      { cccd: "123456780",
        statuses: [["ON", null, "2026-01-05"], ["OFF", null, "2026-03-01"]],
        label: "newest version OFF (A5)" },
    ];
    for (const item of cases) {
      await seedExisting(db, { cccd: item.cccd, name: "R1 Off " + item.label,
        statuses: item.statuses, date: "2026-01-05" });
      const draft = await seedDraft(db, [{ cccd: item.cccd, name: "R1 Draft " + item.label }]);
      const view = await preflight(db, { submissionId: draft.submissionId });
      assert.equal(view.conflict_count, 0, item.label);
      assert.deepEqual(view.conflicts, [], item.label);

      // Khong can xac nhan: duong transition cu van chay binh thuong.
      const applied = await legacyTransition(db, {
        submissionId: draft.submissionId, version: 1, key: idemKey("off"),
      });
      assert.equal(applied.state, "SUBMITTED", item.label);
      assert.equal(applied.version, 2, item.label);
      const audit = await auditRows(db, draft.submissionId);
      assert.equal(audit.length, 1, item.label);
      assert.deepEqual(audit[0].changed_fields, ["state", "version"], item.label);
      assert.equal(audit[0].reason_text, null, item.label);
    }

    // A10: moi episode trung deu OFF (hai project) - khong canh bao, transition binh thuong.
    await seedExisting(db, { cccd: "123456781", name: "R1 Off One", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null], ["OFF", null, "2026-03-01"]] });
    await seedExisting(db, { cccd: "123456781", name: "R1 Off Two", project: PROJ_B,
      date: "2026-02-05", statuses: [["ON", null], ["OFF", null, "2026-03-02"]] });
    const allOff = await seedDraft(db, [{ cccd: "123456781", name: "R1 Draft A10" }]);
    const allOffView = await preflight(db, { submissionId: allOff.submissionId });
    assert.equal(allOffView.conflict_count, 0, "all duplicates OFF (A10)");
    assert.deepEqual(allOffView.conflicts, [], "A10");
    const allOffApplied = await legacyTransition(db, {
      submissionId: allOff.submissionId, version: 1, key: idemKey("off10"),
    });
    assert.equal(allOffApplied.state, "SUBMITTED", "A10");
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 A6-A7: the newest version decides (OFF -> ON correction, ON -> UNCONFIRMED)", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // A6: ON (v1) -> OFF (v2) -> ON (v3, correction superseding v2). Latest is ON.
    const reopened = await seedExisting(db, { cccd: "234567890", name: "R1 Reopened",
      date: "2026-01-05", statuses: [["ON", null], ["OFF", null], ["ON", "previous"]] });
    const draftA = await seedDraft(db, [{ cccd: "234567890", name: "R1 Draft Reopened" }]);
    const viewA = await preflight(db, { submissionId: draftA.submissionId });
    assert.equal(viewA.conflict_count, 1, "A6");
    assert.equal(viewA.conflicts[0].employment_status, "ON", "A6");
    await assertRejects(() => legacyTransition(db,
      { submissionId: draftA.submissionId, version: 1 }), CONFIRMATION_REQUIRED, "A6");
    await assertZeroResidue(db, draftA.submissionId, { version: 1 });

    // A7: ON (v1) -> UNCONFIRMED (v2, correction superseding v1). Latest is UNCONFIRMED.
    const changed = await seedExisting(db, { cccd: "234567891", name: "R1 Changed",
      date: "2026-01-05", statuses: [["ON", null], ["UNCONFIRMED", "previous"]] });
    const draftB = await seedDraft(db, [{ cccd: "234567891", name: "R1 Draft Changed" }]);
    const viewB = await preflight(db, { submissionId: draftB.submissionId });
    assert.equal(viewB.conflict_count, 1, "A7");
    assert.equal(viewB.conflicts[0].employment_status, "UNCONFIRMED", "A7");
    assert.notEqual(reopened.entryId, changed.entryId);
    const applied = await confirmedTransition(db, { submissionId: draftB.submissionId, version: 1,
      fingerprint: viewB.fingerprint, conflicts: viewB.conflict_count });
    assert.equal(applied.state, "SUBMITTED", "A7");
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 A8-A9: an OFF episode is never reported beside a live one", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedExisting(db, { cccd: "345678901", name: "R1 Off Twin", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null], ["OFF", null, "2026-03-01"]] });
    await seedExisting(db, { cccd: "345678901", name: "R1 On Twin", project: PROJ_B,
      date: "2026-02-05", statuses: [["ON", null]] });
    const draftA = await seedDraft(db, [{ cccd: "345678901", name: "R1 Draft Twin" }]);
    const viewA = await preflight(db, { submissionId: draftA.submissionId });
    assert.equal(viewA.conflict_count, 1, "A8: chi con mot conflict");
    assert.equal(viewA.conflicts[0].employment_status, "ON", "A8");
    assert.equal(viewA.conflicts[0].project_display, "Project R1 B", "A8");
    assert.equal(viewA.conflicts[0].cccd_last4, "8901", "A8");
    assert.equal(JSON.stringify(viewA).includes("R1 Off Twin"), false,
      "A8: episode OFF khong duoc xuat hien trong projection");

    await seedExisting(db, { cccd: "345678902", name: "R1 Off Twin B", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null], ["OFF", null, "2026-03-01"]] });
    await seedExisting(db, { cccd: "345678902", name: "R1 Unconfirmed Twin", project: PROJ_B,
      date: "2026-02-05", statuses: [["UNCONFIRMED", null]] });
    const draftB = await seedDraft(db, [{ cccd: "345678902", name: "R1 Draft Twin B" }]);
    const viewB = await preflight(db, { submissionId: draftB.submissionId });
    assert.equal(viewB.conflict_count, 1, "A9");
    assert.equal(viewB.conflicts[0].employment_status, "UNCONFIRMED", "A9");
    assert.equal(JSON.stringify(viewB).includes("R1 Off Twin B"), false, "A9");
  } finally {
    await db.close();
  }
});

/** Go CHECK worker_details de seed CCCD dinh dang cu / khong canonical (khong sua migration). */
async function relaxWorkerDetailsCheck(db) {
  const row = (await db.query(
    "select conname from pg_constraint where conrelid = 'public.direct_entries'::regclass" +
    " and contype = 'c' and pg_get_constraintdef(oid) like '%valid_worker_details%'")).rows[0];
  assert.ok(row, "worker_details CHECK phai ton tai");
  await db.query('alter table public.direct_entries drop constraint "' + row.conname + '"');
}

async function restoreWorkerDetailsCheck(db) {
  await db.exec(
    "alter table public.direct_entries" +
    " add constraint direct_entries_worker_details_r1_simulated" +
    " check (public.direct_entry_valid_worker_details(worker_details)) not valid");
}

/** Cac writer khac cua he thong: import v2 va legacy batch. */
async function createFullProfileV2(db, {
  cccd, name, project = PROJ_A, date = "2026-10-03", key = "full-profile-v2",
}) {
  await db.query(
    "select public.direct_entry_create_full_profile_batch_v2($1::uuid,$2::uuid,$3::text,$4::jsonb,$5::text)",
    [OWNER_AUTH, OWNER_APP, "worker-profile/1.1", JSON.stringify([{
      project_id: project, first_work_date: date, provider_type: "hrp", recruiter_id: REC_A,
      labor_type: "TEMPORARY", display_name: name, worker_details: workerDetails(cccd),
    }]), idemKey(key)]);
}

async function createLegacyBatch(db, {
  cccd, name, project = PROJ_A, date = "2026-10-04", key = "legacy-batch",
}) {
  await db.query(
    "select public.direct_entry_create_batch($1::uuid,$2::uuid,$3::jsonb,$4::text)",
    [OWNER_AUTH, OWNER_APP, JSON.stringify([{
      project_id: project, first_work_date: date, employee_code: nextCode(),
      labor_type: "TEMPORARY", recruiter_id: REC_A,
      worker_details: { display_name: name, ...workerDetails(cccd) },
    }]), idemKey(key)]);
}

// ---------------------------------------------------------------------------
// B. Pham vi match - chi canonical CCCD + entry_id quyet dinh, khong project/team.
// ---------------------------------------------------------------------------
test("P3.1-HF-R1 B11-B13: same project, another project and UNCONFIRMED all warn", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedExisting(db, { cccd: "456789012", name: "R1 Same Project", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null]] });
    await seedExisting(db, { cccd: "456789013", name: "R1 Other Project", project: PROJ_B,
      date: "2026-01-05", statuses: [["ON", null]] });
    await seedExisting(db, { cccd: "456789014", name: "R1 Same Project Unconfirmed", project: PROJ_A,
      date: "2026-01-05", statuses: [["UNCONFIRMED", null]] });

    const sameProject = await seedDraft(db, [{ cccd: "456789012", project: PROJ_A }]);
    const sameProjectView = await preflight(db, { submissionId: sameProject.submissionId });
    assert.equal(sameProjectView.conflict_count, 1, "B11");
    assert.equal(sameProjectView.conflicts[0].employment_status, "ON", "B11");
    assert.equal(sameProjectView.conflicts[0].project_display, "Project R1 A", "B11");

    const otherProject = await seedDraft(db, [{ cccd: "456789013", project: PROJ_A }]);
    const otherProjectView = await preflight(db, { submissionId: otherProject.submissionId });
    assert.equal(otherProjectView.conflict_count, 1, "B12: khac project van canh bao");
    assert.equal(otherProjectView.conflicts[0].employment_status, "ON", "B12");
    assert.equal(otherProjectView.conflicts[0].project_display, "Project R1 B", "B12");

    const unconfirmed = await seedDraft(db, [{ cccd: "456789014", project: PROJ_B }]);
    const unconfirmedView = await preflight(db, { submissionId: unconfirmed.submissionId });
    assert.equal(unconfirmedView.conflict_count, 1, "B13");
    assert.equal(unconfirmedView.conflicts[0].employment_status, "UNCONFIRMED", "B13");
    assert.equal(unconfirmedView.conflicts[0].project_display, "Project R1 A", "B13");
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 B14-B16: self match, soft delete and unusable national ids never warn", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // B14: mot dong duy nhat, khong ai khac trung -> chinh no khong tu canh bao.
    const alone = await seedDraft(db, [{ cccd: "567890123", name: "R1 Alone" }]);
    assert.equal((await preflight(db, { submissionId: alone.submissionId })).conflict_count, 0,
      "B14: self-match bi loai theo entry_id");

    // B15: episode trung da soft-delete.
    await seedExisting(db, { cccd: "567890124", name: "R1 Deleted", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null]], deleted: true });
    const draftDeleted = await seedDraft(db, [{ cccd: "567890124", name: "R1 Draft Deleted" }]);
    assert.equal((await preflight(db, { submissionId: draftDeleted.submissionId })).conflict_count,
      0, "B15: soft-deleted khong phai conflict");

    // B16: national id null hoac khong canonical.
    await seedExisting(db, { cccd: "567890125", name: "R1 Live", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null]] });
    const draftUnknown = await seedDraft(db, [{ cccd: null, name: "R1 Unknown" }]);
    assert.equal((await preflight(db, { submissionId: draftUnknown.submissionId })).conflict_count,
      0, "B16: national id unknown khong canh bao");
    await relaxWorkerDetailsCheck(db);
    const draftWeird = await seedDraft(db, [{ cccd: "NOT-REAL", name: "R1 Weird" }]);
    await restoreWorkerDetailsCheck(db);
    assert.equal((await preflight(db, { submissionId: draftWeird.submissionId })).conflict_count,
      0, "B16: gia tri khong canonical khong canh bao");
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 B17-B18: formatting variants and two rows of one submission still warn", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // B17: du lieu lich su giu dinh dang cu (co khoang trang) van canonicalize ve cung CCCD.
    await relaxWorkerDetailsCheck(db);
    await seedExisting(db, { cccd: "012 345 678 901", name: "R1 Legacy Format", project: PROJ_B,
      date: "2026-01-05", statuses: [["ON", null]] });
    await restoreWorkerDetailsCheck(db);
    const draft = await seedDraft(db, [{ cccd: "012345678901", name: "R1 Canonical Draft" }]);
    const view = await preflight(db, { submissionId: draft.submissionId });
    assert.equal(view.conflict_count, 1, "B17");
    assert.equal(view.conflicts[0].cccd_last4, "8901", "B17");
    assert.equal(view.conflicts[0].employment_status, "ON", "B17");
    assert.equal(JSON.stringify(view).includes("012345678901"), false,
      "B17: khong duoc lo CCCD day du");

    // B18: hai dong khac nhau trong CUNG submission, da luu thanh hai entry, canh bao lan nhau.
    const pair = await seedDraft(db, [
      { cccd: "678901234", name: "R1 Pair One" },
      { cccd: "678901234", name: "R1 Pair Two" },
    ]);
    const pairView = await preflight(db, { submissionId: pair.submissionId });
    assert.equal(pairView.conflict_count, 2, "B18: hai chieu cua mot cap trung");
    assert.deepEqual(pairView.conflicts.map((item) => item.draft_display_name).sort(),
      ["R1 Pair One", "R1 Pair Two"], "B18");
    assert.equal(pairView.conflicts.every((item) => item.employment_status === "UNCONFIRMED"), true,
      "B18: thieu event => UNCONFIRMED");
    await assertRejects(() => legacyTransition(db, { submissionId: pair.submissionId, version: 1 }),
      CONFIRMATION_REQUIRED, "B18");
    await assertZeroResidue(db, pair.submissionId, { version: 1 });
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// C. Workflow - canh bao chi nam tren DRAFT -> SUBMITTED.
// ---------------------------------------------------------------------------
test("P3.1-HF-R1 C19-C20: create, import v2 and the legacy import all save a duplicate", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedExisting(db, { cccd: "789012345", name: "R1 Existing Save", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null]] });

    // C19: duong tao ban nhap that (full-profile v1) voi CCCD da ton tai mot ho so ON.
    const viaWriter = await createFullProfile(db, { cccd: "789012345", name: "R1 Writer Draft" });
    assert.deepEqual(await submissionRow(db, viaWriter.submissionId), { state: "DRAFT", version: 1 },
      "C19: luu ban nhap van thanh cong");
    assert.equal(await count(db,
      "select count(*) from public.direct_entries where entry_id = $1 and deleted_at is null",
      [viaWriter.entryId]), 1, "C19");

    // C20: import v2 va legacy batch cung luu duoc cung CCCD do.
    await createFullProfileV2(db, { cccd: "789012345", name: "R1 Writer V2" });
    await createLegacyBatch(db, { cccd: "789012345", name: "R1 Writer Legacy" });
    assert.equal(await count(db,
      "select count(*) from public.direct_entries" +
      " where worker_details->'national_id'->>'value' = '789012345' and deleted_at is null"), 4,
      "C20: bon episode song voi mot CCCD");
    assert.equal(await count(db,
      "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname = 'public' and p.prokind = 'f'" +
      " and p.prosrc like '%NATIONAL_ID_DUPLICATE%'"), 0,
      "C20: khong con raiser duplicate nao o tang nghiep vu");

    // Va duong REVIEW cua chinh submission do van phai xac nhan.
    const view = await preflight(db, { submissionId: viaWriter.submissionId });
    assert.equal(view.conflict_count, 3, "C20: ba profile khac dang song");
    await assertRejects(() => legacyTransition(db, { submissionId: viaWriter.submissionId, version: 1 }),
      CONFIRMATION_REQUIRED, "C20");
    await assertZeroResidue(db, viaWriter.submissionId, { version: 1 });
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 C21-C23: confirmation-required, cancel and a matching acknowledgement", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const existing = await seedExisting(db, { cccd: "890123456", name: "R1 Existing C23",
      project: PROJ_A, date: "2026-01-05", statuses: [["ON", null]] });
    const draft = await seedDraft(db, [{ cccd: "890123456", name: "R1 Draft C23" }]);
    const view = await preflight(db, { submissionId: draft.submissionId });
    assert.equal(view.conflict_count, 1, "C21");
    assert.equal(view.version, 1, "C21");

    // C21: chuyen trang thai khong xac nhan -> confirmation-required + zero residue.
    const key = idemKey("c21");
    await assertRejects(() => legacyTransition(db, { submissionId: draft.submissionId, version: 1,
      key }), CONFIRMATION_REQUIRED, "C21");
    await assertZeroResidue(db, draft.submissionId, { version: 1, key });

    // C22: chon quay lai kiem tra -> van DRAFT, fingerprint va version khong doi.
    const again = await preflight(db, { submissionId: draft.submissionId });
    assert.equal(again.conflict_count, 1, "C22");
    assert.equal(again.fingerprint, view.fingerprint, "C22: fingerprint on dinh");
    assert.equal(again.version, 1, "C22");
    await assertZeroResidue(db, draft.submissionId, { version: 1 });

    // C23: xac nhan dung fingerprint -> REVIEW dung mot lan, audit khong chua PII.
    const applied = await confirmedTransition(db, { submissionId: draft.submissionId, version: 1,
      key: idemKey("c23"), fingerprint: view.fingerprint, conflicts: view.conflict_count });
    assert.deepEqual(applied, { status: "applied", submission_id: draft.submissionId,
      state: "SUBMITTED", version: 2 }, "C23");
    assert.deepEqual(await submissionRow(db, draft.submissionId), { state: "SUBMITTED", version: 2 });
    const audit = await auditRows(db, draft.submissionId);
    assert.equal(audit.length, 1, "C23: dung mot audit");
    assert.equal(audit[0].outcome, "APPLIED", "C23");
    assert.deepEqual(audit[0].changed_fields, ["state", "version"], "C23");
    assert.equal(audit[0].reason_text, null,
      "C23: transition audit does not create a fake restricted-reason row");
    assert.equal(audit[0].reason_text?.includes("890123456") ?? false, false, "C23: khong ghi CCCD");
    assert.equal(JSON.stringify(audit).includes("R1 Existing C23"), false,
      "C23: khong ghi ten ho so da ton tai");
    assert.equal(JSON.stringify(audit).includes("Project R1 A"), false,
      "C23: khong ghi ten du an");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_submission_revisions where submission_id = $1",
      [draft.submissionId]), 1, "C23");
    const revision = (await db.query(
      "select reason_id, after_snapshot from public.direct_entry_submission_revisions" +
      " where submission_id=$1 order by version desc limit 1", [draft.submissionId])).rows[0];
    assert.equal(revision.reason_id, null, "C23: revision retains nullable operation reason");
    assert.deepEqual(revision.after_snapshot.duplicate_cccd_acknowledgement, {
      conflict_count: 1, fingerprint_prefix: view.fingerprint.slice(0, 12),
    }, "C23: revision preserves structured non-PII acknowledgement evidence");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_restricted_reasons" +
      " where reason_text like 'Submission state transition%'"), 0,
      "C23: no server-authored restricted-reason placeholder is stored");
    assert.notEqual(existing.entryId, draft.entryIds[0]);
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 C24: a conflict set that changes between preflight and confirm needs a new acknowledgement", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // ON -> OFF: fingerprint cu het hieu luc, server recheck, va transition tiep tuc duoc vi
    // khong con conflict nao.
    const flipping = await seedExisting(db, { cccd: "901234567", name: "R1 Flip",
      project: PROJ_A, date: "2026-01-05", statuses: [["ON", null]] });
    const draft = await seedDraft(db, [{ cccd: "901234567", name: "R1 Draft Flip" }]);
    const before = await preflight(db, { submissionId: draft.submissionId });
    assert.equal(before.conflict_count, 1, "C24");
    await appendStatus(db, flipping.entryId, "OFF", "2026-03-01", 2, null);
    const after = await preflight(db, { submissionId: draft.submissionId });
    assert.equal(after.conflict_count, 0, "C24: OFF lam conflict bien mat");
    assert.notEqual(after.fingerprint, before.fingerprint, "C24: fingerprint doi");
    // C24: canh bao cu het hieu luc. Server recheck thay khong con conflict nao nen transition di
    // tiep, va audit KHONG duoc dung lai acknowledgement cu.
    const applied = await confirmedTransition(db, { submissionId: draft.submissionId, version: 1,
      key: idemKey("c24-live"), fingerprint: before.fingerprint,
      conflicts: before.conflict_count });
    assert.equal(applied.state, "SUBMITTED", "C24: het conflict thi transition binh thuong");
    const staleAudit = await auditRows(db, draft.submissionId);
    assert.equal(staleAudit.length, 1, "C24");
    assert.equal(staleAudit[0].reason_text, null,
      "C24: khong duoc dung lai canh bao cu");

    // OFF -> ON (correction) va them mot ho so trung: conflict xuat hien lai, fingerprint doi.
    const reopening = await seedExisting(db, { cccd: "901234568", name: "R1 Reopening",
      project: PROJ_A, date: "2026-01-05", statuses: [["ON", null]] });
    const draftB = await seedDraft(db, [{ cccd: "901234568", name: "R1 Draft Reopening" }]);
    const off = await appendStatus(db, reopening.entryId, "OFF", "2026-03-01", 2, null);
    const offView = await preflight(db, { submissionId: draftB.submissionId });
    assert.equal(offView.conflict_count, 0, "C24: dang OFF");
    await appendStatus(db, reopening.entryId, "ON", "2026-03-01", 3, off);
    const onView = await preflight(db, { submissionId: draftB.submissionId });
    assert.equal(onView.conflict_count, 1, "C24 OFF -> ON");
    await assertRejects(() => confirmedTransition(db, { submissionId: draftB.submissionId, version: 1,
      key: idemKey("c24-off"), fingerprint: offView.fingerprint, conflicts: 1 }),
      CONFIRMATION_REQUIRED, "C24 OFF -> ON: phai xac nhan lai");
    await assertZeroResidue(db, draftB.submissionId, { version: 1 });

    await seedExisting(db, { cccd: "901234568", name: "R1 Reopening Twin", project: PROJ_B,
      date: "2026-02-05", statuses: [["ON", null]] });
    const grownView = await preflight(db, { submissionId: draftB.submissionId });
    assert.equal(grownView.conflict_count, 2, "C24: them ho so trung");
    assert.notEqual(grownView.fingerprint, onView.fingerprint, "C24: fingerprint doi khi them record");
    await assertRejects(() => confirmedTransition(db, { submissionId: draftB.submissionId, version: 1,
      key: idemKey("c24-grown"), fingerprint: onView.fingerprint, conflicts: 1 }),
      CONFIRMATION_REQUIRED, "C24: fingerprint cu khong dung cho tap moi");
    await assertZeroResidue(db, draftB.submissionId, { version: 1 });
    const confirmed = await confirmedTransition(db, { submissionId: draftB.submissionId, version: 1,
      key: idemKey("c24-final"), fingerprint: grownView.fingerprint,
      conflicts: grownView.conflict_count });
    assert.equal(confirmed.state, "SUBMITTED", "C24: xac nhan lai voi tap moi");
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 C25: a forged, mismatched or malformed acknowledgement is refused with no residue", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedExisting(db, { cccd: "012345678", name: "R1 Existing C25", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null]] });
    const draft = await seedDraft(db, [{ cccd: "012345678", name: "R1 Draft C25" }]);
    const view = await preflight(db, { submissionId: draft.submissionId });
    assert.equal(view.conflict_count, 1, "C25");
    const attempts = [
      { label: "forged fingerprint", fingerprint: "a".repeat(64), conflicts: 1,
        pattern: CONFIRMATION_REQUIRED },
      { label: "wrong count", fingerprint: view.fingerprint, conflicts: 2,
        pattern: CONFIRMATION_REQUIRED },
      { label: "malformed fingerprint", fingerprint: "zz".repeat(32), conflicts: 1,
        pattern: CONFIRMATION_MALFORMED },
      { label: "zero count", fingerprint: view.fingerprint, conflicts: 0,
        pattern: CONFIRMATION_MALFORMED },
      { label: "uppercase fingerprint", fingerprint: view.fingerprint.toUpperCase(), conflicts: 1,
        pattern: CONFIRMATION_MALFORMED },
    ];
    for (const item of attempts) {
      const key = idemKey("c25");
      await assertRejects(() => confirmedTransition(db, { submissionId: draft.submissionId, version: 1,
        key, fingerprint: item.fingerprint, conflicts: item.conflicts }), item.pattern, item.label);
      await assertZeroResidue(db, draft.submissionId, { version: 1, key });
    }
    // C25: fingerprint gia khong pha hong gi - xac nhan dung van chay.
    const applied = await confirmedTransition(db, { submissionId: draft.submissionId, version: 1,
      key: idemKey("c25-ok"), fingerprint: view.fingerprint, conflicts: view.conflict_count });
    assert.equal(applied.state, "SUBMITTED", "C25");
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 C25b: the confirmed entry point accepts only a SUBMITTED target", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedExisting(db, { cccd: "012345679", name: "R1 Existing C25b", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null]] });
    const draft = await seedDraft(db, [{ cccd: "012345679", name: "R1 Draft C25b" }]);
    const view = await preflight(db, { submissionId: draft.submissionId });
    assert.equal(view.conflict_count, 1, "C25b");
    const key = idemKey("c25b-target");
    await assertRejects(() => confirmedTransition(db, { submissionId: draft.submissionId, version: 1,
      key, target: "REVIEW", fingerprint: view.fingerprint, conflicts: view.conflict_count }),
      CONFIRMATION_TARGET, "C25b: chi SUBMITTED moi duoc xac nhan");
    await assertZeroResidue(db, draft.submissionId, { version: 1, key });
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 C26-C27: a direct RPC, a legacy caller and every unmapped actor fail closed", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedExisting(db, { cccd: "123456790", name: "R1 Existing Bypass", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null]] });
    const draft = await seedDraft(db, [{ cccd: "123456790", name: "R1 Draft Bypass" }]);

    // C26: goi thang RPC sau tham so, khong qua UI, khong xac nhan -> bi tu choi.
    const bypassKey = idemKey("c26");
    await assertRejects(() => legacyTransition(db, { submissionId: draft.submissionId, version: 1,
      key: bypassKey }), CONFIRMATION_REQUIRED, "C26");
    await assertZeroResidue(db, draft.submissionId, { version: 1, key: bypassKey });

    // C27: chu ky cu chi uy quyen cho than dung chung, khong tu ap dung transition.
    const legacySource = (await db.query(
      "select prosrc from pg_proc where oid = $1::regprocedure", [LEGACY_SIGNATURE])).rows[0].prosrc;
    assert.match(legacySource, /direct_entry_transition_submission_apply/, "C27");
    assert.equal(legacySource.includes("update public.direct_entry_submissions"), false, "C27");
    assert.equal(legacySource.includes("set state = p_target_state"), false, "C27");
    assert.equal(legacySource.includes("direct_entry_idempotency_finish"), false, "C27");

    // Bien gioi quyen: preflight/confirmed service_role-only, than dung chung bi thu hoi.
    const acl = async (signature) => (await db.query(
      "select has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec," +
      " has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec," +
      " has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec" +
      " from pg_proc p where p.oid = $1::regprocedure", [signature])).rows[0];
    assert.deepEqual(await acl(PREFLIGHT_SIGNATURE),
      { service_exec: true, anon_exec: false, auth_exec: false }, "C27 preflight");
    assert.deepEqual(await acl(CONFIRMED_SIGNATURE),
      { service_exec: true, anon_exec: false, auth_exec: false }, "C27 confirmed");
    assert.deepEqual(await acl(STATE_SIGNATURE),
      { service_exec: false, anon_exec: false, auth_exec: false }, "C27 state");
    assert.deepEqual(await acl(APPLY_SIGNATURE),
      { service_exec: false, anon_exec: false, auth_exec: false }, "C27 apply");

    // Authority: thieu own scope, khong phai chu submission, khong duoc map - deu fail-closed.
    await assertRejects(() => preflight(db, { auth: NO_SCOPE_AUTH, app: NO_SCOPE_APP,
      submissionId: draft.submissionId }), /scope denied/, "C27 thieu own scope");
    await assertRejects(() => preflight(db, { auth: OUTSIDER_AUTH, app: OUTSIDER_APP,
      submissionId: draft.submissionId }), /submission scope denied/, "C27 khong phai chu");
    await assertRejects(() => preflight(db, { auth: UNMAPPED_AUTH, app: UNMAPPED_APP,
      submissionId: draft.submissionId }), /actor/, "C27 khong map");
    await assertRejects(() => confirmedTransition(db, { auth: UNMAPPED_AUTH, app: UNMAPPED_APP,
      submissionId: draft.submissionId, version: 1, fingerprint: "a".repeat(64), conflicts: 1 }),
      /actor/, "C27 confirm khong map");
    await assertZeroResidue(db, draft.submissionId, { version: 1 });

    // Khong pha regression: submission khong conflict van di duong cu binh thuong.
    const clean = await seedDraft(db, [{ cccd: "234567899", name: "R1 Draft Clean" }]);
    const cleanView = await preflight(db, { submissionId: clean.submissionId });
    assert.equal(cleanView.conflict_count, 0, "C27");
    const ok = await legacyTransition(db, { submissionId: clean.submissionId, version: 1 });
    assert.equal(ok.state, "SUBMITTED", "C27");
    // Preflight chi phuc vu DRAFT -> SUBMITTED.
    await assertRejects(() => preflight(db, { submissionId: clean.submissionId }),
      /not a draft/, "C27: submission khong con la DRAFT");
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 C28-C29: an exact replay and a double click create one transition and one audit", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedExisting(db, { cccd: "234567900", name: "R1 Existing Replay", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null]] });
    const draft = await seedDraft(db, [{ cccd: "234567900", name: "R1 Draft Replay" }]);
    const view = await preflight(db, { submissionId: draft.submissionId });
    const key = idemKey("c28");
    const request = { submissionId: draft.submissionId, version: 1, key,
      fingerprint: view.fingerprint, conflicts: view.conflict_count };
    const first = await confirmedTransition(db, request);
    const replay = await confirmedTransition(db, request);
    assert.deepEqual(replay, first, "C28: replay tra dung ket qua cu");
    assert.deepEqual(await submissionRow(db, draft.submissionId), { state: "SUBMITTED", version: 2 },
      "C29: double click chi doi trang thai mot lan");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_audit_events where resource_ref = $1",
      [draft.submissionId]), 1, "C29: chi mot audit APPLIED");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_submission_revisions where submission_id = $1",
      [draft.submissionId]), 1, "C29: chi mot revision");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_rpc_idempotency" +
      " where idempotency_key = $1 and result is not null", [key]), 1,
    "C29: idempotency da hoan tat dung mot lan");
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 C30: legacy REVIEW transitions remain and new DRAFT cannot enter REVIEW", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedExisting(db, { cccd: "345678900", name: "R1 Existing Lifecycle", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null]] });
    const draft = await seedDraft(db, [{ cccd: "345678900", name: "R1 Legacy REVIEW" }],
      { state: "REVIEW", version: 2 });

    // Batch REVIEW da ton tai van duoc tra ve DRAFT.
    const back = await legacyTransition(db, { submissionId: draft.submissionId, version: 2,
      target: "DRAFT" });
    assert.equal(back.state, "DRAFT", "C30");
    // DRAFT moi khong the tao buoc REVIEW; tu choi khong ghi audit/revision.
    const rejectedKey = idemKey("c30-invalid-review");
    const beforeRejected = {
      audit: await count(db,
        "select count(*) from public.direct_entry_audit_events" +
        " where resource_ref = $1 and action = 'submission_transition'", [draft.submissionId]),
      revisions: await count(db,
        "select count(*) from public.direct_entry_submission_revisions" +
        " where submission_id = $1 and version > 1", [draft.submissionId]),
    };
    await assertRejects(() => legacyTransition(db, {
      submissionId: draft.submissionId, version: 3, target: "REVIEW", key: rejectedKey,
    }),
      /invalid submission mutation/, "C30");
    assert.deepEqual(await submissionRow(db, draft.submissionId), { state: "DRAFT", version: 3 });
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_audit_events" +
      " where resource_ref = $1 and action = 'submission_transition'", [draft.submissionId]),
    beforeRejected.audit);
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_submission_revisions" +
      " where submission_id = $1 and version > 1", [draft.submissionId]), beforeRejected.revisions);
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_rpc_idempotency where idempotency_key = $1",
      [rejectedKey]), 0);

    // Sau khi chuyen lai DRAFT, CCCD confirmation van bat buoc cho SUBMITTED.
    const second = await preflight(db, { submissionId: draft.submissionId });
    const key = idemKey("c30-direct-submit");
    await assertRejects(() => legacyTransition(db, {
      submissionId: draft.submissionId, version: 3, key,
    }), CONFIRMATION_REQUIRED, "C30 DRAFT submit");
    assert.deepEqual(await submissionRow(db, draft.submissionId), { state: "DRAFT", version: 3 });
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_audit_events" +
      " where resource_ref = $1 and action = 'submission_transition'", [draft.submissionId]),
    beforeRejected.audit);
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_submission_revisions" +
      " where submission_id = $1 and version > 1", [draft.submissionId]), beforeRejected.revisions);
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_rpc_idempotency where idempotency_key = $1",
      [key]), 0);
    const confirmed = await confirmedTransition(db, {
      submissionId: draft.submissionId, version: 3,
      fingerprint: second.fingerprint, conflicts: second.conflict_count,
    });
    assert.equal(confirmed.state, "SUBMITTED", "C30 DRAFT submit");

    // REVIEW batch cu co the submit truc tiep theo authority da co, khong can ack moi.
    const review = await seedDraft(db, [{ cccd: "345678900", name: "R1 Legacy REVIEW submit" }],
      { state: "REVIEW", version: 2 });
    const submitted = await legacyTransition(db, {
      submissionId: review.submissionId, version: 2, target: "SUBMITTED",
    });
    assert.equal(submitted.state, "SUBMITTED", "C30 legacy REVIEW submit");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_audit_events where resource_ref = $1",
      [draft.submissionId]), 2, "C30: rejected REVIEW edge wrote no extra audit");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_audit_events where resource_ref = $1",
      [review.submissionId]), 1, "C30 legacy REVIEW submit audit");
  } finally {
    await db.close();
  }
});

test("mutation probe: removing duplicate confirmation permits a conflicting DRAFT submit", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedExisting(db, {
      cccd: "456789012",
      name: "R1 Mutation Existing",
      project: PROJ_A,
      date: "2026-01-05",
      statuses: [["ON", null]],
    });
    const draft = await seedDraft(db, [
      { cccd: "456789012", name: "R1 Mutation Duplicate" },
    ]);
    await replaceFunctionSourceForMutationProbe(db,
      "public.direct_entry_transition_submission_apply(uuid,uuid,uuid,integer,text,text,text,integer)",
      "      if v_conflict_count > 0 then",
      "      if false then");
    const mutant = await legacyTransition(db, {
      submissionId: draft.submissionId,
      version: 1,
      key: idemKey("mutation-duplicate-confirmation"),
    });
    assert.equal(mutant.state, "SUBMITTED",
      "without the duplicate confirmation check, the DB accepts a conflicting submit");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// D. Projection - masked, bounded, deterministic, exact-key, khong PII.
// ---------------------------------------------------------------------------
const PREFLIGHT_KEYS = ["conflict_count", "conflicts", "fingerprint", "submission_id", "version"];
const CONFLICT_KEYS = ["cccd_last4", "conflict_ref", "draft_display_name",
  "employment_status", "project_display"];

test("P3.1-HF-R1 D31-D33: exact keys, canonical status only and no Vietnamese label in SQL", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await seedExisting(db, { cccd: "456789100", name: "R1 Projection ON", project: PROJ_A,
      date: "2026-01-05", statuses: [["ON", null]] });
    const draft = await seedDraft(db, [{ cccd: "456789100", name: "R1 Draft Projection" }]);
    const view = await preflight(db, { submissionId: draft.submissionId });
    assert.deepEqual(Object.keys(view).sort(), PREFLIGHT_KEYS, "D36: hop dong exact-key");
    assert.equal(view.submission_id, draft.submissionId, "D31");
    assert.equal(view.conflicts.length, 1, "D31");
    assert.deepEqual(Object.keys(view.conflicts[0]).sort(), CONFLICT_KEYS, "D31: item exact-key");
    assert.equal(view.conflicts[0].employment_status, "ON", "D31: ON la trang thai canonical");
    assert.equal(view.conflicts[0].cccd_last4, "9100", "D34");
    assert.match(view.conflicts[0].conflict_ref, /^[0-9a-f]{12}$/, "D35: ref opaque");
    assert.match(view.fingerprint, /^[0-9a-f]{64}$/, "D36: fingerprint hex 64");
    assert.equal(typeof view.conflicts[0].project_display, "string", "D31: project chi de doi chieu");

    // D32: thieu event => UNCONFIRMED trong projection (nhan tieng Viet do tang TS quyet dinh).
    const noEvent = await seedExisting(db, { cccd: "456789101", name: "R1 Projection No Event",
      project: PROJ_A, date: "2026-01-05", statuses: [] });
    const draftB = await seedDraft(db, [{ cccd: "456789101", name: "R1 Draft No Event" }]);
    const viewB = await preflight(db, { submissionId: draftB.submissionId });
    assert.equal(viewB.conflicts[0].employment_status, "UNCONFIRMED", "D32");
    assert.notEqual(noEvent.entryId, draftB.entryIds[0]);

    // SQL khong duoc chua nhan tieng Viet: mapping nhan nam o projection TS.
    const sources = (await db.query(
      "select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname = 'public'")).rows;
    const contract = sources.filter((row) => /duplicate_cccd|acknowledgement/.test(row.proname));
    assert.equal(contract.length >= 4, true, "D31: bon ham cua contract xac nhan");
    for (const row of contract) {
      assert.equal(/Đang làm việc|Không xác định/.test(row.prosrc), false,
        "D31: SQL khong duoc tu dien nhan tieng Viet");
    }
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 D34-D37: masked, deterministic, bounded, no PII and no DB detail leak", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const existing = await seedExisting(db, { cccd: "567890100", name: "R1 Secret Existing Name",
      project: PROJ_A, date: "2026-01-05", statuses: [["ON", null]] });
    const draft = await seedDraft(db, [{ cccd: "567890100", name: "R1 Draft Name" }]);
    const view = await preflight(db, { submissionId: draft.submissionId });
    const text = JSON.stringify(view);
    assert.equal(text.includes("567890100"), false, "D34: khong lo CCCD day du");
    assert.equal(text.includes(existing.employeeCode), false, "D34: khong lo employee_code");
    assert.equal(text.includes("R1 Secret Existing Name"), false, "D34: khong lo ten ho so khac");
    assert.equal(text.includes(existing.entryId), false, "D35: khong lo entry_id cua ho so khac");
    assert.equal(text.includes(draft.entryIds[0]), false, "D35: khong lo entry_id cua chinh no");
    // D35: du lieu cua modal (tung conflict item) khong duoc chua UUID tho. submission_id la ma
    // tham chieu cua chinh yeu cau (UI dung lam key, khong hien thi) nen duoc phep co mat.
    assert.equal(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
        JSON.stringify(view.conflicts)),
      false, "D35: khong render UUID tho trong conflict item");
    assert.equal(text.includes(draft.submissionId), true,
      "D35: submission_id la ma tham chieu cua yeu cau");

    // Deterministic: cung trang thai thi cung ket qua.
    assert.deepEqual(await preflight(db, { submissionId: draft.submissionId }), view, "D36");

    // Bounded: 21 ho so trung -> dem du 21 nhung projection toi da 20 item.
    for (let index = 0; index < 20; index += 1) {
      await seedExisting(db, { cccd: "567890100", name: "R1 Bulk " + index, project: PROJ_B,
        date: "2026-01-0" + ((index % 9) + 1), statuses: [["ON", null]] });
    }
    const bulk = await preflight(db, { submissionId: draft.submissionId });
    assert.equal(bulk.conflict_count, 21, "D36: dem du 21 conflict");
    assert.equal(bulk.conflicts.length, 20, "D36: projection toi da 20 item");
    assert.equal(new Set(bulk.conflicts.map((item) => item.conflict_ref)).size, 20,
      "D36: conflict_ref duy nhat");
    assert.equal(bulk.conflicts.every((item) => item.employment_status === "ON"), true, "D36");

    // D37: thong diep loi cua DB khong chua du lieu nguoi dung.
    await assert.rejects(() => preflight(db, { auth: UNMAPPED_AUTH, app: UNMAPPED_APP,
      submissionId: draft.submissionId }), (error) => {
      assert.equal(/567890100|R1 Secret|Project R1/.test(error.message), false,
        "D37: khong lo du lieu qua thong diep loi");
      return true;
    }, "D37");
  } finally {
    await db.close();
  }
});

test("P3.1-HF-R1 D37: only the shared body writes a submission state, and no raiser survives", async () => {
  const db = await buildDb();
  try {
    const writers = (await db.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname = 'public' and p.prokind = 'f'" +
      " and p.prosrc like '%set state = p_target_state%'")).rows.map((row) => row.proname);
    assert.deepEqual(writers, ["direct_entry_transition_submission_apply"],
      "D37: chi than dung chung duoc ghi state");
    assert.equal(await count(db,
      "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace" +
      " where n.nspname = 'public' and p.prokind = 'f'" +
      " and p.prosrc ~* 'duplicate cccd (found|exists|not allowed)'"), 0,
    "D37: khong co refusal duplicate-CCCD nao o tang nghiep vu");
  } finally {
    await db.close();
  }
});
