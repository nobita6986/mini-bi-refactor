/**
 * Workforce Offboarding Report ("Báo cáo NLĐ nghỉ việc") — PGlite Behavioral,
 * Snapshot Suppression, Authorization Matrix, Export Parity, Lifecycle Invalidation
 * & Zero-CCCD Boundary Test Suite.
 *
 * Applies the full `supabase/migrations` stack from scratch in an isolated in-memory
 * PGlite database and verifies:
 *   1. Migration rollback atomicity, checksum stability, Forced RLS, immutability
 *      trigger, zero CCCD columns, and strict helper/RPC ACL boundaries.
 *   2. `phone: null` acceptance end-to-end from SQL -> TypeScript projector -> API.
 *   3. Authority matrix:
 *      - Full Admin & BoD (`all` scope): `can_hide = true`, `can_export = true`,
 *        snapshot refs present, hide succeeds, export excludes hidden snapshots.
 *      - Team Leader (`team` scope): `can_hide = false`, `can_export = false`,
 *        no phone or snapshot refs, hide & export rejected with `42501`.
 *      - Staff / unauthorized roles: rejected with `42501` across list, export & hide.
 *   4. Snapshot suppression semantics:
 *      - Hiding a snapshot removes the worker from list (Admin, BoD, Team Leader)
 *        and Excel export source while leaving `direct_entries` and
 *        `direct_entry_employment_status_events` 100% untouched.
 *      - Idempotent replay returns `replayed: true` without creating a second row;
 *        same key + different reason/snapshot raises `23505 IDEMPOTENCY_CONFLICT`;
 *        hiding an already-hidden snapshot with a new key raises `PT409`.
 *      - Lifecycle invalidation:
 *        (a) Hidden worker gets a new `SUBMITTED` episode (`UNCONFIRMED`) -> reappears;
 *            transitions to `ON` -> disappears per report rule; later transitions to
 *            `OFF >= 3 days` -> reappears until hidden again.
 *        (b) Hidden worker's status event is superseded by a corrected `OFF >= 3 days`
 *            event -> snapshot changes and worker automatically reappears.
 *   5. Zero raw or derived CCCD in `direct_entry_offboarding_suppressions` rows and
 *      in all RPC responses / error payloads.
 */
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  parseOffboardingHideResult,
  parseOffboardingReportExport,
  parseOffboardingReportList,
} from "../src/lib/workforce/offboarding-report-contract.ts";
import {
  HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_MIGRATION_NAME,
  migrationChecksum,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const CCCD_WORKER_1 = "001099000111";
const CCCD_WORKER_2 = "001099000222";
const CCCD_WORKER_3 = "001099000333";

function uuid(n) {
  return `81000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const PRE_3C_PIN_MIGRATION_NAME = "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql";

async function loadMigrations() {
  const allNames = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const pinIdx = allNames.indexOf(PRE_3C_PIN_MIGRATION_NAME);
  assert.notEqual(pinIdx, -1, `missing ${PRE_3C_PIN_MIGRATION_NAME}`);
  const names = allNames.slice(0, pinIdx + 1);
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createDatabase({ stopBeforeTarget = false } = {}) {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrations();
  const targetIndex = migrations.findIndex(
    (m) => m.name === HF_OFFBOARDING_SUPPRESSION_AND_ATTENDANCE_FILTER_MIGRATION_NAME,
  );
  assert.ok(targetIndex >= 0, "HF offboarding/attendance migration must exist");
  const slice = stopBeforeTarget ? migrations.slice(0, targetIndex) : migrations;
  for (const m of slice) {
    await db.exec(m.sql);
  }
  return { db, targetMigration: migrations[targetIndex] };
}

function buildWorkerDetails({ name, cccd, phone = null }) {
  return {
    display_name: name,
    date_of_birth: { state: "omitted" },
    national_id: { state: "provided", value: cccd },
    address: { state: "omitted" },
    phone: phone === null ? { state: "omitted" } : { state: "provided", value: phone },
  };
}

async function insertSubmittedEpisode(
  db,
  {
    entryId,
    submissionId,
    candidateId,
    createdByUserId,
    projectId,
    firstWorkDate,
    employeeCode,
    recruiterId,
    teamId,
    workerDetails,
  },
) {
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1::uuid)", [
      candidateId,
    ]);
    await db.query(
      `insert into public.direct_entry_submissions (submission_id, created_by_user_id, state)
       values ($1::uuid, $2::uuid, 'DRAFT')`,
      [submissionId, createdByUserId],
    );
    await db.query(
      `insert into public.direct_entries (
         entry_id, submission_id, candidate_id, created_by_user_id, project_id,
         first_work_date, employee_code, worker_details, recruiter_id, team_id,
         provider_type, labor_type
       ) values (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
         $6::date, $7, $8::jsonb, $9::uuid, $10::uuid,
         'hrp', 'TEMPORARY'
       )`,
      [
        entryId,
        submissionId,
        candidateId,
        createdByUserId,
        projectId,
        firstWorkDate,
        employeeCode,
        JSON.stringify(workerDetails),
        recruiterId,
        teamId,
      ],
    );
    await seedLegacyReviewSubmission(db, submissionId);
    await db.query(
      `update public.direct_entry_submissions
          set state = 'SUBMITTED',
              submitted_at = coalesce(submitted_at, now()),
              version = 3
        where submission_id = $1::uuid`,
      [submissionId],
    );
    await db.exec("commit");
  } catch (err) {
    await db.exec("rollback");
    throw err;
  }
}

async function insertStatusEvent(
  db,
  {
    eventId,
    entryId,
    status,
    effectiveDate,
    leaveReasonText = null,
    version,
    actorUserId,
    reasonId,
    supersedesEventId = null,
  },
) {
  await db.query(
    `insert into public.direct_entry_employment_status_events (
       event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
       version, actor_user_id, reason_id, supersedes_event_id
     ) values (
       $1::uuid, $2::uuid, $3, $4::date, $5::date, $6,
       $7::integer, $8::uuid, $9::uuid, $10::uuid
     )`,
    [
      eventId,
      entryId,
      status,
      effectiveDate,
      status === "OFF" ? effectiveDate : null,
      status === "OFF" ? leaveReasonText : null,
      version,
      actorUserId,
      reasonId,
      supersedesEventId,
    ],
  );
}

async function callAsServiceRole(db, queryText, params) {
  await db.exec("begin; set local role service_role;");
  try {
    const res = await db.query(queryText, params);
    await db.exec("commit;");
    return res.rows[0].data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

test("HF migration rollback atomicity, checksum stability, Forced RLS, immutability, zero CCCD schema, and ACL boundaries", async () => {
  const { db, targetMigration } = await createDatabase({ stopBeforeTarget: true });
  try {
    const c1 = migrationChecksum(targetMigration.sql);
    const c2 = migrationChecksum(targetMigration.sql.replace(/\n/g, "\r\n"));
    assert.equal(c1, c2, "LF-normalized migration checksum is CRLF-invariant");
    assert.match(c1, /^[0-9a-f]{64}$/);

    // Rollback atomicity
    await db.exec("begin;");
    await db.exec(migrationSqlForTransaction(targetMigration.sql));
    await db.exec("rollback;");

    const rolledBack = await db.query(
      "select to_regclass('public.direct_entry_offboarding_suppressions') as tbl",
    );
    assert.equal(rolledBack.rows[0].tbl, null);

    // Forward apply
    await db.exec(targetMigration.sql);

    const tableAudit = await db.query(`
      select c.relrowsecurity as rls,
             c.relforcerowsecurity as force_rls,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies,
             (select array_agg(att.attname order by att.attnum)
                from pg_attribute att
               where att.attrelid = c.oid and att.attnum > 0 and not att.attisdropped) as cols
        from pg_class c
       where c.oid = 'public.direct_entry_offboarding_suppressions'::regclass
    `);
    assert.equal(tableAudit.rows[0].rls, true);
    assert.equal(tableAudit.rows[0].force_rls, true);
    assert.equal(tableAudit.rows[0].policies, 0);
    assert.deepEqual(tableAudit.rows[0].cols, [
      "suppression_id",
      "snapshot_entry_id",
      "snapshot_status_event_id",
      "snapshot_signature",
      "reason",
      "hidden_by_user_id",
      "hidden_at",
      "idempotency_key",
    ]);

    for (const role of ["anon", "authenticated", "service_role"]) {
      const priv = await db.query(
        `select has_table_privilege($1, 'public.direct_entry_offboarding_suppressions', 'SELECT, INSERT, UPDATE, DELETE') as allowed,
                has_function_privilege($1, 'public.direct_entry_offboarding_hide_snapshot(uuid,uuid,uuid,uuid,text,text)', 'EXECUTE') as hide_exec,
                has_function_privilege($1, 'public.direct_entry__internal_offboarding_rows(uuid,uuid,text,uuid,boolean)', 'EXECUTE') as helper_exec`,
        [role],
      );
      assert.equal(priv.rows[0].allowed, false, `${role} must have zero table privileges`);
      assert.equal(priv.rows[0].helper_exec, false, `${role} must not execute internal helper`);
      assert.equal(
        priv.rows[0].hide_exec,
        role === "service_role",
        `${role} hide RPC EXECUTE matches service_role-only boundary`,
      );
    }
  } finally {
    await db.close();
  }
});

test("Offboarding suppression end-to-end: phone: null, authority matrix, export parity, fact preservation, idempotency, lifecycle reappearance & zero CCCD leak", async () => {
  const { db } = await createDatabase();
  try {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const candidateHelperPriv = await db.query(
        `select has_function_privilege($1, 'public.direct_entry__internal_offboarding_candidates(text,uuid,date)', 'EXECUTE') as allowed`,
        [role],
      );
      assert.equal(
        candidateHelperPriv.rows[0].allowed,
        false,
        `${role} must not execute internal candidate helper direct_entry__internal_offboarding_candidates`,
      );
    }

    const authDateRes = await db.query(
      "select (public.direct_entry_authorization_date() - 5)::text as off_5d, (public.direct_entry_authorization_date() - 4)::text as off_4d, (public.direct_entry_authorization_date() - 10)::text as start_10d",
    );
    const { off_5d: off5d, off_4d: off4d, start_10d: start10d } = authDateRes.rows[0];
    const entryYear = start10d.slice(0, 4);

    // Actors
    const ADMIN = { auth: uuid(1), app: uuid(11) };
    const BOD = { auth: uuid(2), app: uuid(12) };
    const LEAD_A = { auth: uuid(3), app: uuid(13), recruiter: uuid(23) };
    const STAFF = { auth: uuid(4), app: uuid(14) };

    const TEAM_A = uuid(31);
    const TEAM_B = uuid(32);
    const REC_A = uuid(41);
    const REC_B = uuid(42);
    const RESTRICTED_REASON_ID = uuid(50);

    for (const actor of [ADMIN, BOD, LEAD_A, STAFF]) {
      await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
    }
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
       values ($1::uuid, $2::uuid, true, 'Admin Toàn Hệ Thống'),
              ($3::uuid, $4::uuid, true, 'Ban Giám Đốc'),
              ($5::uuid, $6::uuid, true, 'Team Leader A'),
              ($7::uuid, $8::uuid, true, 'Nhân Viên Tuyển Dụng')`,
      [ADMIN.app, ADMIN.auth, BOD.app, BOD.auth, LEAD_A.app, LEAD_A.auth, STAFF.app, STAFF.auth],
    );

    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'OFF_TEAM_A', 'Nhóm Tuyển Dụng A', true),
              ($2::uuid, 'OFF_TEAM_B', 'Nhóm Tuyển Dụng B', true)`,
      [TEAM_A, TEAM_B],
    );

    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, active)
       values ($1::uuid, 'Trưởng Nhóm A', true),
              ($2::uuid, 'Chuyên Viên A', true),
              ($3::uuid, 'Chuyên Viên B', true)`,
      [LEAD_A.recruiter, REC_A, REC_B],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2020-01-01', true),
              ($2::uuid, 'hrp', '2020-01-01', true),
              ($3::uuid, 'hrp', '2020-01-01', true)`,
      [LEAD_A.recruiter, REC_A, REC_B],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $4::uuid, '2020-01-01', true),
              ($2::uuid, $4::uuid, '2020-01-01', true),
              ($3::uuid, $5::uuid, '2020-01-01', true)`,
      [LEAD_A.recruiter, REC_A, REC_B, TEAM_A, TEAM_B],
    );

    // Admin grants
    for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, '2020-01-01', true)`,
        [ADMIN.app, cap],
      );
    }
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2020-01-01', true)`,
      [ADMIN.app],
    );

    // BoD grants
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_privileged_edit', '2020-01-01', true)`,
      [BOD.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2020-01-01', true)`,
      [BOD.app],
    );

    // Team Leader A canonical setup
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'team_manager_assign', '2020-01-01', true)`,
      [LEAD_A.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'team', $2::uuid, '2020-01-01', true)`,
      [LEAD_A.app, TEAM_A],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2020-01-01', true)`,
      [LEAD_A.app, LEAD_A.recruiter],
    );
    await db.query(
      `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, '2020-01-01', true)`,
      [TEAM_A, LEAD_A.app, LEAD_A.recruiter],
    );

    // Staff own-scope grants
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_own', '2020-01-01', true)`,
      [STAFF.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'own', '2020-01-01', true)`,
      [STAFF.app],
    );

    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name)
       values ('proj_off_a', 'Dự Án Sản Xuất A'),
              ('proj_off_b', 'Dự Án Kho Vận B')`,
    );
    await db.query(
      `insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text)
       values ($1::uuid, $2::uuid, 'Offboarding test fixture')`,
      [RESTRICTED_REASON_ID, ADMIN.app],
    );

    // Seed 3 eligible workers:
    // - Worker 1 (Team A, phone omitted -> phone: null in SQL)
    // - Worker 2 (Team B, phone provided -> phone: "0987654321")
    // - Worker 3 (Team A, phone omitted -> phone: null in SQL)
    const EP_W1 = uuid(101);
    const EV_W1_ON = uuid(191);
    const EV_W1_OFF = uuid(201);
    const EP_W2 = uuid(102);
    const EV_W2_ON = uuid(192);
    const EV_W2_OFF = uuid(202);
    const EP_W3 = uuid(103);
    const EV_W3_ON = uuid(193);
    const EV_W3_OFF = uuid(203);

    await insertSubmittedEpisode(db, {
      entryId: EP_W1,
      submissionId: uuid(301),
      candidateId: uuid(401),
      createdByUserId: ADMIN.app,
      projectId: "proj_off_a",
      firstWorkDate: start10d,
      employeeCode: `hrp-${entryYear}-000901`,
      recruiterId: REC_A,
      teamId: TEAM_A,
      workerDetails: buildWorkerDetails({
        name: "Nguyễn Văn Ẩn Một",
        cccd: CCCD_WORKER_1,
        phone: null,
      }),
    });
    await insertStatusEvent(db, {
      eventId: EV_W1_ON,
      entryId: EP_W1,
      status: "ON",
      effectiveDate: start10d,
      version: 1,
      actorUserId: ADMIN.app,
      reasonId: RESTRICTED_REASON_ID,
    });
    await insertStatusEvent(db, {
      eventId: EV_W1_OFF,
      entryId: EP_W1,
      status: "OFF",
      effectiveDate: off5d,
      leaveReasonText: "Về quê chăm gia đình",
      version: 2,
      actorUserId: ADMIN.app,
      reasonId: RESTRICTED_REASON_ID,
    });

    await insertSubmittedEpisode(db, {
      entryId: EP_W2,
      submissionId: uuid(302),
      candidateId: uuid(402),
      createdByUserId: ADMIN.app,
      projectId: "proj_off_b",
      firstWorkDate: start10d,
      employeeCode: `hrp-${entryYear}-000902`,
      recruiterId: REC_B,
      teamId: TEAM_B,
      workerDetails: buildWorkerDetails({
        name: "Trần Thị Ẩn Hai",
        cccd: CCCD_WORKER_2,
        phone: "0987654321",
      }),
    });
    await insertStatusEvent(db, {
      eventId: EV_W2_ON,
      entryId: EP_W2,
      status: "ON",
      effectiveDate: start10d,
      version: 1,
      actorUserId: ADMIN.app,
      reasonId: RESTRICTED_REASON_ID,
    });
    await insertStatusEvent(db, {
      eventId: EV_W2_OFF,
      entryId: EP_W2,
      status: "OFF",
      effectiveDate: off5d,
      leaveReasonText: "Hết hợp đồng thời vụ",
      version: 2,
      actorUserId: ADMIN.app,
      reasonId: RESTRICTED_REASON_ID,
    });

    await insertSubmittedEpisode(db, {
      entryId: EP_W3,
      submissionId: uuid(303),
      candidateId: uuid(403),
      createdByUserId: ADMIN.app,
      projectId: "proj_off_a",
      firstWorkDate: start10d,
      employeeCode: `hrp-${entryYear}-000903`,
      recruiterId: REC_A,
      teamId: TEAM_A,
      workerDetails: buildWorkerDetails({
        name: "Lê Văn Giữ Hiển Thị",
        cccd: CCCD_WORKER_3,
        phone: null,
      }),
    });
    await insertStatusEvent(db, {
      eventId: EV_W3_ON,
      entryId: EP_W3,
      status: "ON",
      effectiveDate: start10d,
      version: 1,
      actorUserId: ADMIN.app,
      reasonId: RESTRICTED_REASON_ID,
    });
    await insertStatusEvent(db, {
      eventId: EV_W3_OFF,
      entryId: EP_W3,
      status: "OFF",
      effectiveDate: off4d,
      leaveReasonText: "Nghỉ việc cá nhân",
      version: 2,
      actorUserId: ADMIN.app,
      reasonId: RESTRICTED_REASON_ID,
    });

    const callList = (actor, page = 1, pageSize = 25) =>
      callAsServiceRole(
        db,
        "select public.direct_entry_offboarding_report($1::uuid, $2::uuid, $3::int, $4::int) as data",
        [actor.auth, actor.app, page, pageSize],
      );
    const callExport = (actor) =>
      callAsServiceRole(
        db,
        "select public.direct_entry_offboarding_report_export($1::uuid, $2::uuid) as data",
        [actor.auth, actor.app],
      );
    const callHide = (actor, entryId, eventId, reason, idempotencyKey) =>
      callAsServiceRole(
        db,
        "select public.direct_entry_offboarding_hide_snapshot($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text) as data",
        [actor.auth, actor.app, entryId, eventId, reason, idempotencyKey],
      );

    // 1. Initial Admin, BoD, and Team Leader views + phone: null contract validation
    const initialAdminList = await callList(ADMIN);
    assert.ok(parseOffboardingReportList(initialAdminList) !== null);
    assert.equal(initialAdminList.can_hide, true);
    assert.equal(initialAdminList.can_export, true);
    assert.equal(initialAdminList.total, 3);
    assert.equal(initialAdminList.items[0].phone, null);
    assert.equal(initialAdminList.items[0].snapshot_entry_id, EP_W1);
    assert.equal(initialAdminList.items[0].snapshot_status_event_id, EV_W1_OFF);
    assert.equal(initialAdminList.items[1].phone, "0987654321");

    const initialBodList = await callList(BOD);
    assert.ok(parseOffboardingReportList(initialBodList) !== null);
    assert.equal(initialBodList.authority, "bod");
    assert.equal(initialBodList.can_hide, true);
    assert.equal(initialBodList.total, 3);

    const initialLeadList = await callList(LEAD_A);
    assert.ok(parseOffboardingReportList(initialLeadList) !== null);
    assert.equal(initialLeadList.scope, "team");
    assert.equal(initialLeadList.authority, "team_leader");
    assert.equal(initialLeadList.can_hide, false);
    assert.equal(initialLeadList.can_export, false);
    assert.equal(initialLeadList.total, 2, "Team Leader A sees only Team A workers (W1 and W3)");
    for (const item of initialLeadList.items) {
      assert.equal("phone" in item, false);
      assert.equal("snapshot_entry_id" in item, false);
      assert.equal("snapshot_status_event_id" in item, false);
    }

    // Team Leader & Staff are denied hide and export
    await assert.rejects(
      () => callHide(LEAD_A, EP_W1, EV_W1_OFF, "Cố tình ẩn", "idem-lead-0001"),
      (err) => err.code === "42501",
    );
    await assert.rejects(
      () => callExport(LEAD_A),
      (err) => err.code === "42501",
    );
    await assert.rejects(
      () => callList(STAFF),
      (err) => err.code === "42501",
    );
    await assert.rejects(
      () => callHide(STAFF, EP_W1, EV_W1_OFF, "Cố tình ẩn", "idem-staff-0001"),
      (err) => err.code === "42501",
    );

    // Capture recruitment & status event facts before hiding to prove 0 mutation
    const entriesSnapshotBefore = (
      await db.query(
        "select entry_id, version, deleted_at, voided_at, worker_details from public.direct_entries order by entry_id",
      )
    ).rows;
    const statusSnapshotBefore = (
      await db.query(
        "select event_id, entry_id, status, effective_date::text, version, supersedes_event_id from public.direct_entry_employment_status_events order by event_id",
      )
    ).rows;

    // 2. Admin hides Worker 1 -> disappears from list (Admin, BoD, Team Leader) AND export
    const hideW1 = await callHide(
      ADMIN,
      EP_W1,
      EV_W1_OFF,
      "  Đã về quê chăm con nhỏ, quá tuổi tuyển mới  ",
      "idem-admin-hide-w1",
    );
    assert.ok(parseOffboardingHideResult(hideW1) !== null);
    assert.equal(hideW1.replayed, false);
    assert.equal(hideW1.snapshot_entry_id, EP_W1);
    assert.equal(hideW1.snapshot_status_event_id, EV_W1_OFF);

    // Underlying recruitment & status tables are 100% untouched
    const entriesSnapshotAfter = (
      await db.query(
        "select entry_id, version, deleted_at, voided_at, worker_details from public.direct_entries order by entry_id",
      )
    ).rows;
    const statusSnapshotAfter = (
      await db.query(
        "select event_id, entry_id, status, effective_date::text, version, supersedes_event_id from public.direct_entry_employment_status_events order by event_id",
      )
    ).rows;
    assert.deepEqual(entriesSnapshotAfter, entriesSnapshotBefore);
    assert.deepEqual(statusSnapshotAfter, statusSnapshotBefore);

    // Immutability guard blocks UPDATE and DELETE on direct_entry_offboarding_suppressions
    await assert.rejects(
      () =>
        db.query(
          "update public.direct_entry_offboarding_suppressions set reason = 'Sửa trái phép'",
        ),
      (err) => err.code === "55000",
    );
    await assert.rejects(
      () => db.query("delete from public.direct_entry_offboarding_suppressions"),
      (err) => err.code === "55000",
    );

    const adminAfterHideW1 = await callList(ADMIN);
    assert.deepEqual(
      adminAfterHideW1.items.map((i) => i.employee_code),
      [`hrp-${entryYear}-000902`, `hrp-${entryYear}-000903`],
    );
    const leadAfterHideW1 = await callList(LEAD_A);
    assert.deepEqual(
      leadAfterHideW1.items.map((i) => i.employee_code),
      [`hrp-${entryYear}-000903`],
    );
    const exportAfterHideW1 = await callExport(BOD);
    assert.ok(parseOffboardingReportExport(exportAfterHideW1) !== null);
    assert.deepEqual(
      exportAfterHideW1.items.map((i) => i.employee_code),
      [`hrp-${entryYear}-000902`, `hrp-${entryYear}-000903`],
    );

    // 3. Idempotent replay, idempotency conflict, stale/already-hidden conflict, and validation
    const replayW1 = await callHide(
      ADMIN,
      EP_W1,
      EV_W1_OFF,
      "Đã về quê chăm con nhỏ, quá tuổi tuyển mới",
      "idem-admin-hide-w1",
    );
    assert.equal(replayW1.replayed, true);
    assert.equal(replayW1.suppression_id, hideW1.suppression_id);
    assert.equal(replayW1.hidden_at, hideW1.hidden_at);

    await assert.rejects(
      () =>
        callHide(ADMIN, EP_W1, EV_W1_OFF, "Lý do khác trên cùng key", "idem-admin-hide-w1"),
      (err) => err.code === "23505" && String(err.message).includes("IDEMPOTENCY_CONFLICT"),
    );

    await assert.rejects(
      () =>
        callHide(
          BOD,
          EP_W1,
          EV_W1_OFF,
          "BoD bấm ẩn lại snapshot đã ẩn",
          "idem-bod-duplicate-w1",
        ),
      (err) =>
        err.code === "PT409" &&
        String(err.message).includes("WORKFORCE_OFFBOARDING_SNAPSHOT_STALE"),
    );

    await assert.rejects(
      () => callHide(ADMIN, EP_W2, EV_W2_OFF, "   ", "idem-invalid-empty"),
      (err) => err.code === "22023",
    );

    // 4. BoD can hide Worker 2
    const hideW2 = await callHide(
      BOD,
      EP_W2,
      EV_W2_OFF,
      "Đã chuyển sang công ty khác tại địa phương",
      "idem-bod-hide-w2",
    );
    assert.equal(hideW2.replayed, false);
    assert.deepEqual(
      (await callList(ADMIN)).items.map((i) => i.employee_code),
      [`hrp-${entryYear}-000903`],
    );

    // 5. Lifecycle invalidation (Scenario A):
    // Worker 1 gets a new SUBMITTED episode (UNCONFIRMED / waiting for work) -> reappears immediately!
    const EP_W1_NEW = uuid(104);
    const EV_W1_NEW_UNCONFIRMED = uuid(204);
    const EV_W1_NEW_ON = uuid(205);
    const EV_W1_NEW_OFF = uuid(206);
    const off5Year = off5d.slice(0, 4);

    await insertSubmittedEpisode(db, {
      entryId: EP_W1_NEW,
      submissionId: uuid(304),
      candidateId: uuid(404),
      createdByUserId: ADMIN.app,
      projectId: "proj_off_b",
      firstWorkDate: off5d,
      employeeCode: `hrp-${off5Year}-000904`,
      recruiterId: REC_A,
      teamId: TEAM_A,
      workerDetails: buildWorkerDetails({
        name: "Nguyễn Văn Ẩn Một",
        cccd: CCCD_WORKER_1,
        phone: "0901112222",
      }),
    });
    await insertStatusEvent(db, {
      eventId: EV_W1_NEW_UNCONFIRMED,
      entryId: EP_W1_NEW,
      status: "UNCONFIRMED",
      effectiveDate: off5d,
      version: 1,
      actorUserId: ADMIN.app,
      reasonId: RESTRICTED_REASON_ID,
    });

    const afterNewSubmittedUnconfirmed = await callList(ADMIN);
    assert.ok(
      afterNewSubmittedUnconfirmed.items.some((i) => i.snapshot_entry_id === EP_W1_NEW),
      "Worker 1 reappears immediately when a new SUBMITTED episode changes the snapshot while still eligible",
    );

    // Worker 1 transitions ON -> disappears per report's `not has_on` business rule
    await insertStatusEvent(db, {
      eventId: EV_W1_NEW_ON,
      entryId: EP_W1_NEW,
      status: "ON",
      effectiveDate: off5d,
      version: 2,
      actorUserId: ADMIN.app,
      reasonId: RESTRICTED_REASON_ID,
    });
    const afterTransitionOn = await callList(ADMIN);
    assert.equal(
      afterTransitionOn.items.some(
        (i) =>
          i.employee_code === `hrp-${entryYear}-000901` ||
          i.employee_code === `hrp-${off5Year}-000904`,
      ),
      false,
      "Worker 1 disappears while ON",
    );

    // Later Worker 1 transitions OFF >= 3 days -> reappears until hidden again!
    await insertStatusEvent(db, {
      eventId: EV_W1_NEW_OFF,
      entryId: EP_W1_NEW,
      status: "OFF",
      effectiveDate: off4d,
      leaveReasonText: "Nghỉ đợt tuyển mới",
      version: 3,
      actorUserId: ADMIN.app,
      reasonId: RESTRICTED_REASON_ID,
    });
    const afterSecondOff = await callList(ADMIN);
    const reappearedW1 = afterSecondOff.items.find(
      (i) => i.employee_code === `hrp-${off5Year}-000904`,
    );
    assert.ok(reappearedW1, "Worker 1 reappears after new OFF >= 3 days");
    assert.equal(reappearedW1.snapshot_entry_id, EP_W1_NEW);
    assert.equal(reappearedW1.snapshot_status_event_id, EV_W1_NEW_OFF);

    // Lifecycle invalidation (Scenario B): status-event supersession on Worker 2 invalidates old suppression
    const EV_W2_ON_REVERT = uuid(207);
    const EV_W2_OFF_SUPERSEDING = uuid(208);
    await insertStatusEvent(db, {
      eventId: EV_W2_ON_REVERT,
      entryId: EP_W2,
      status: "ON",
      effectiveDate: off5d,
      version: 3,
      actorUserId: ADMIN.app,
      reasonId: RESTRICTED_REASON_ID,
      supersedesEventId: EV_W2_OFF,
    });
    await insertStatusEvent(db, {
      eventId: EV_W2_OFF_SUPERSEDING,
      entryId: EP_W2,
      status: "OFF",
      effectiveDate: off4d,
      leaveReasonText: "Điều chỉnh ngày nghỉ chính thức",
      version: 4,
      actorUserId: ADMIN.app,
      reasonId: RESTRICTED_REASON_ID,
    });
    const afterStatusSupersede = await callList(BOD);
    const reappearedW2 = afterStatusSupersede.items.find(
      (i) => i.employee_code === `hrp-${entryYear}-000902`,
    );
    assert.ok(reappearedW2, "Worker 2 reappears when status event is superseded");
    assert.equal(reappearedW2.snapshot_status_event_id, EV_W2_OFF_SUPERSEDING);

    // 6. Zero raw or derived CCCD in suppression table and in all RPC outputs
    const suppressionRows = (
      await db.query("select * from public.direct_entry_offboarding_suppressions")
    ).rows;
    assert.equal(suppressionRows.length, 2);
    const serializedSuppressions = JSON.stringify(suppressionRows);
    const serializedOutputs = JSON.stringify({
      initialAdminList,
      initialLeadList,
      exportAfterHideW1,
      hideW1,
      afterSecondOff,
      afterStatusSupersede,
    });

    for (const cccd of [CCCD_WORKER_1, CCCD_WORKER_2, CCCD_WORKER_3]) {
      const md5 = createHash("md5").update(cccd).digest("hex");
      const sha256 = createHash("sha256").update(cccd).digest("hex");
      assert.equal(serializedSuppressions.includes(cccd), false, "no raw CCCD in DB table");
      assert.equal(serializedSuppressions.includes(md5), false, "no CCCD MD5 in DB table");
      assert.equal(serializedSuppressions.includes(sha256), false, "no CCCD SHA-256 in DB table");
      assert.equal(serializedOutputs.includes(cccd), false, "no raw CCCD in RPC outputs");
    }
  } finally {
    await db.close();
  }
});
