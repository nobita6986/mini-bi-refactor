import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  ATTENDANCE_PHOTO_MIME_TYPE,
  computeAttendanceRequestFingerprint,
} from "../src/lib/attendance/attendance-contract.ts";
import {
  computeBranchAssignRequestFingerprint,
  computeBranchUnassignRequestFingerprint,
  computeBranchUpsertRequestFingerprint,
  computeExplanationDecideRequestFingerprint,
  computeExplanationSubmitRequestFingerprint,
  computeSlotPolicyAssignRequestFingerprint,
  computeSlotPolicyCreateRequestFingerprint,
  computeSlotPolicyProfileUpsertRequestFingerprint,
  computeSlotPolicyUnassignRequestFingerprint,
} from "../src/lib/attendance/attendance-monthly-matrix-api.ts";
import {
  DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_ID,
  projectAssignBranchResult,
  projectAssignSlotPolicyResult,
  projectAttendanceBranchesAdminList,
  projectAttendanceExplanationApprovalInbox,
  projectAttendanceMonthlyMatrixReport,
  projectAttendanceSlotPoliciesAdminList,
  projectCreateSlotPolicyResult,
  projectDecideAttendanceExplanationResult,
  projectMyAttendanceExplanationsOverview,
  projectSubmitAttendanceExplanationResult,
  projectUnassignBranchResult,
  projectUnassignSlotPolicyResult,
  projectUpsertBranchResult,
  projectUpsertSlotPolicyProfileResult,
} from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import { computeHqLocationRequestFingerprint } from "../src/lib/attendance/attendance-report-api.ts";
import { projectAttendanceAdminReport } from "../src/lib/attendance/attendance-report-contract.ts";
import { buildAttendanceMonthlyMatrixXlsx } from "../src/lib/attendance/attendance-monthly-matrix-xlsx.ts";
import {
  projectAdminList,
  projectAdminLocationMutation,
  projectAdminProject,
} from "../src/lib/direct-entry/project-admin-contract.ts";
import { projectHrpSyncCatalog } from "../src/lib/integrations/hrp/catalog-contract.ts";
import {
  ATTENDANCE_EXPLANATIONS_WAVE2_MIGRATION_NAME,
  ATTENDANCE_EXPLANATIONS_WAVE2_RPC_SIGNATURES,
  ATTENDANCE_FLEXIBLE_SLOT_POLICY_MIGRATION_NAME,
  ATTENDANCE_FLEXIBLE_SLOT_POLICY_RPC_SIGNATURES,
  ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_MIGRATION_NAME,
  ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_RPC_SIGNATURES,
  ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_MIGRATION_NAME,
  ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_RPC_SIGNATURES,
  migrationChecksum,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const TEAM_ALPHA = "99000000-0000-4000-8000-0000000000a1";

const ACTORS = {
  FULL_ADMIN: {
    auth: "19100000-0000-4000-8000-000000000001",
    app: "29100000-0000-4000-8000-000000000001",
    name: "Quản Trị Toàn Hệ Thống",
  },
  BOD_PRIVILEGED: {
    auth: "19100000-0000-4000-8000-000000000002",
    app: "29100000-0000-4000-8000-000000000002",
    name: "Ban Giám Đốc (Direct Entry)",
  },
  PROJECT_ADMIN: {
    auth: "19100000-0000-4000-8000-000000000006",
    app: "29100000-0000-4000-8000-000000000006",
    name: "Quản Trị Dự Án",
  },
  TEAM_LEADER: {
    auth: "19100000-0000-4000-8000-000000000004",
    app: "29100000-0000-4000-8000-000000000004",
    name: "Trưởng Nhóm Alpha",
  },
  STAFF_A: {
    auth: "19100000-0000-4000-8000-000000000011",
    app: "29100000-0000-4000-8000-000000000011",
    recruiter: "39100000-0000-4000-8000-000000000011",
    code: "NV_MAT_01",
    name: "Nhân Viên Chi Nhánh A",
  },
  STAFF_B: {
    auth: "19100000-0000-4000-8000-000000000012",
    app: "29100000-0000-4000-8000-000000000012",
    recruiter: "39100000-0000-4000-8000-000000000012",
    code: "NV_MAT_02",
    name: "Nhân Viên Trụ Sở HQ B",
  },
  DISABLED_STAFF: {
    auth: "19100000-0000-4000-8000-000000000015",
    app: "29100000-0000-4000-8000-000000000015",
    name: "Nhân Viên Ngừng Hoạt Động",
  },
};

const PHOTO_SHA = "c".repeat(64);
const TOKEN_DIGEST = "d".repeat(64);

const HQ_HANOI = { latitude: 21.028511, longitude: 105.804817 };
const BRANCH_BAC_NINH_V1 = { latitude: 21.186082, longitude: 106.076314 };
const BRANCH_BAC_NINH_V2 = { latitude: 10.776889, longitude: 106.700806 };

let uuidSeq = 0;
function nextUuid() {
  uuidSeq += 1;
  return `f9100000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
}

function haversineMetersOracle(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const meters = 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(Math.max(0, a))));
  return Math.round(meters * 10) / 10;
}

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createDatabase({
  stopBeforeTarget = false,
  targetMigrationName = ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_MIGRATION_NAME,
} = {}) {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrations();
  const targetIndex = migrations.findIndex((m) => m.name === targetMigrationName);
  assert.ok(targetIndex >= 0, "Target migration must exist");
  const slice = stopBeforeTarget ? migrations.slice(0, targetIndex) : migrations;
  for (const m of slice) {
    await db.exec(m.sql);
  }
  return { db, migrations, targetMigration: migrations[targetIndex] };
}

async function seedActorsAndCatalog(db) {
  await db.query(
    `insert into public.teams (team_id, code, display_name, active)
     values ($1::uuid, 'MAT_ALPHA', 'Nhóm Tuyển Dụng Alpha', true)`,
    [TEAM_ALPHA],
  );

  for (const actor of Object.values(ACTORS)) {
    await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
       values ($1::uuid, $2::uuid, $3, $4)`,
      [actor.app, actor.auth, actor.name, actor !== ACTORS.DISABLED_STAFF],
    );
  }

  const grantCaps = async (actor, caps) => {
    for (const cap of caps) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, '2026-01-01', true)`,
        [actor.app, cap],
      );
    }
  };

  const grantScope = async (actor, scopeKind, teamId = null) => {
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, $2, $3::uuid, '2026-01-01', true)`,
      [actor.app, scopeKind, teamId],
    );
  };

  await grantCaps(ACTORS.FULL_ADMIN, [
    "entry_admin",
    "recruiter_master_manage",
    "team_master_manage",
  ]);
  await grantScope(ACTORS.FULL_ADMIN, "all");

  await grantCaps(ACTORS.BOD_PRIVILEGED, ["entry_privileged_edit"]);
  await grantScope(ACTORS.BOD_PRIVILEGED, "all");

  await grantCaps(ACTORS.PROJECT_ADMIN, ["entry_admin"]);
  await grantScope(ACTORS.PROJECT_ADMIN, "all");

  await grantCaps(ACTORS.TEAM_LEADER, [
    "team_manager_assign",
    "report_view",
    "report_analytics_view",
  ]);
  await grantScope(ACTORS.TEAM_LEADER, "team", TEAM_ALPHA);

  await grantCaps(ACTORS.STAFF_A, ["entry_create", "entry_own", "submission_create"]);
  await grantScope(ACTORS.STAFF_A, "own");

  await grantCaps(ACTORS.STAFF_B, ["entry_create", "entry_own", "submission_create"]);
  await grantScope(ACTORS.STAFF_B, "own");

  for (const staff of [ACTORS.STAFF_A, ACTORS.STAFF_B]) {
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, $3, 'STAFF', true)`,
      [staff.recruiter, staff.name, staff.code],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2026-01-01', true)`,
      [staff.recruiter],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, '2026-01-01', true)`,
      [staff.recruiter, TEAM_ALPHA],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
      [staff.app, staff.recruiter],
    );
  }

  await db.query(
    `insert into public.direct_entry_projects (project_id, display_name, active, version)
     values ('luxshare-bn', 'Luxshare Bắc Ninh', true, 1),
            ('goertek-bn', 'Goertek Bắc Ninh', true, 1)`,
  );
}

async function callAsServiceRole(db, sql, params = []) {
  await db.exec("begin; set local role service_role;");
  try {
    const res = await db.query(sql, params);
    await db.exec("commit;");
    return res.rows[0]?.data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

async function recordCheckInAsServiceRole(db, input) {
  const idempotencyKey = input.idempotency_key ?? nextUuid();
  const timeSource = input.time_source ?? "SERVER_ANCHORED";
  const capturedIso = input.captured_at;
  const receivedIso = input.received_at ?? input.captured_at;
  const anchorIssuedIso = timeSource === "SERVER_ANCHORED" ? capturedIso : null;
  const elapsedMs = timeSource === "SERVER_ANCHORED" ? 0 : null;
  const tokenDigest = timeSource === "SERVER_ANCHORED" ? TOKEN_DIGEST : null;
  const addressHint = input.address_hint ?? "Địa chỉ thử nghiệm";
  const note = input.note ?? "";
  const accuracyMeters = input.accuracy_meters ?? 12.0;

  const fingerprint = computeAttendanceRequestFingerprint({
    app_user_id: input.actor.app,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracy_meters: accuracyMeters,
    address_hint: addressHint,
    note,
    client_captured_at_ms: Date.parse(capturedIso),
    time_source: timeSource,
    time_token_digest: tokenDigest,
    elapsed_since_anchor_ms: elapsedMs,
    photo_sha256: PHOTO_SHA,
  });

  return callAsServiceRole(
    db,
    `select public.attendance_record_checkin(
      $1::uuid, $2::uuid, $3::uuid, $4::text,
      $5::double precision, $6::double precision, $7::double precision,
      $8::text, $9::text, $10::timestamptz, $11::text, $12::timestamptz,
      $13::bigint, $14::text, $15::text, $16::text, $17::integer, $18::text, $19::timestamptz
    ) as data`,
    [
      input.actor.auth,
      input.actor.app,
      idempotencyKey,
      fingerprint,
      input.latitude,
      input.longitude,
      accuracyMeters,
      addressHint,
      note,
      capturedIso,
      timeSource,
      anchorIssuedIso,
      elapsedMs,
      tokenDigest,
      `preview/attendance/2026-10-05/${input.actor.app}/${idempotencyKey}.jpg`,
      PHOTO_SHA,
      4096,
      ATTENDANCE_PHOTO_MIME_TYPE,
      receivedIso,
    ],
  );
}

test("Migration 20261102120000 rolls back atomically on error and exposes only service_role RPCs", async () => {
  const { db, targetMigration } = await createDatabase({ stopBeforeTarget: true });
  try {
    assert.equal(
      targetMigration.name,
      ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_MIGRATION_NAME,
    );
    const checksum = migrationChecksum(targetMigration.sql);
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.equal(
      migrationChecksum(targetMigration.sql.replace(/\n/g, "\r\n")),
      checksum,
    );

    const failingSql = `${migrationSqlForTransaction(targetMigration.sql)}\nselect 1 / 0;\n`;
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(failingSql);
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      (err) => err.code === "22012",
    );

    const { rows: leftoverTables } = await db.query(
      `select count(*)::int as n
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname in (
            'attendance_branches',
            'attendance_branch_revisions',
            'attendance_branch_assignments'
          )`,
    );
    assert.equal(leftoverTables[0].n, 0, "rollback leaves zero branch tables");

    await db.exec("begin;");
    await db.exec(migrationSqlForTransaction(targetMigration.sql));
    await db.exec("commit;");

    for (const sig of ATTENDANCE_MONTHLY_MATRIX_BRANCHES_PROJECT_COORDS_RPC_SIGNATURES) {
      const { rows } = await db.query("select to_regprocedure($1)::text as oid_name", [sig]);
      assert.ok(rows[0].oid_name, `RPC ${sig} must exist after commit`);
    }
  } finally {
    await db.close();
  }
});

test("Migration 20261103120000 upgrades untouched Stage 1 default to 5 slots and never overwrites Admin-customized policies", async () => {
  const { db, targetMigration } = await createDatabase({
    stopBeforeTarget: true,
    targetMigrationName: ATTENDANCE_FLEXIBLE_SLOT_POLICY_MIGRATION_NAME,
  });
  try {
    await seedActorsAndCatalog(db);
    // Simulate an Admin having created a custom Stage 1 policy v2 before 20261103120000 runs
    await callAsServiceRole(
      db,
      `select public.attendance_create_slot_policy_admin(
        $1::uuid, $2::uuid, '2026-12-01'::date,
        '07:45', 10, 10, '11:45', 10, 10, '13:15', 10, 10, '17:15', 10, 10,
        1, $3::uuid, $4::text
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, nextUuid(), "e".repeat(64)],
    );

    // Apply Stage 1.5 migration
    await db.exec("begin;");
    await db.exec(migrationSqlForTransaction(targetMigration.sql));
    await db.exec("commit;");

    for (const sig of ATTENDANCE_FLEXIBLE_SLOT_POLICY_RPC_SIGNATURES) {
      const { rows } = await db.query("select to_regprocedure($1)::text as oid_name", [sig]);
      assert.ok(rows[0].oid_name, `RPC ${sig} must exist after Stage 1.5 commit`);
    }

    const policiesRaw = await callAsServiceRole(
      db,
      "select public.attendance_get_slot_policies_admin($1::uuid, $2::uuid) as data",
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
    );
    const policies = projectAttendanceSlotPoliciesAdminList(policiesRaw);
    assert.ok(policies, "Admin-customized policies project cleanly after Stage 1.5 upgrade");
    assert.equal(policies.versions.length, 2);

    const v2 = policies.versions.find((v) => v.version === 2);
    const v1 = policies.versions.find((v) => v.version === 1);
    assert.ok(v1 && v2);
    // Neither v1 nor Admin-created v2 was overwritten with 5 slots because Admin had already configured v2!
    assert.deepEqual(
      v1.slots.map((s) => s.target_time),
      ["08:00", "11:00", "13:00", "17:00"],
    );
    assert.deepEqual(
      v2.slots.map((s) => s.target_time),
      ["07:45", "11:45", "13:15", "17:15"],
    );
  } finally {
    await db.close();
  }
});

test("HRP Branches, Branch Check-In Distance Snapshot Immutability, Project Coordinates, HRP Sync Catalog & Monthly Attendance Matrix Report", async () => {
  const { db } = await createDatabase();
  try {
    await seedActorsAndCatalog(db);

    // -------------------------------------------------------------------------
    // 1. Direct table and helper ACL checks
    // -------------------------------------------------------------------------
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const table of [
        "attendance_branches",
        "attendance_branch_revisions",
        "attendance_branch_assignments",
        "attendance_slot_policy_profiles",
        "attendance_slot_policy_assignments",
      ]) {
        await assert.rejects(
          async () => {
            await db.exec(`begin; set local role ${role};`);
            try {
              await db.query(`select * from public.${table}`);
              await db.exec("commit;");
            } catch (err) {
              await db.exec("rollback;");
              throw err;
            }
          },
          (err) => err.code === "42501",
          `${role} must not have direct SELECT on ${table}`,
        );
      }
    }

    // -------------------------------------------------------------------------
    // 2. Configure HQ v1 and HRP Branches (with & without coordinates)
    // -------------------------------------------------------------------------
    const hqKey = nextUuid();
    const hqFp = computeHqLocationRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      expected_version: 0,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
    });
    await callAsServiceRole(
      db,
      "select public.attendance_set_hq_location($1::uuid, $2::uuid, $3::double precision, $4::double precision, $5::integer, $6::uuid, $7::text) as data",
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        HQ_HANOI.latitude,
        HQ_HANOI.longitude,
        0,
        hqKey,
        hqFp,
      ],
    );

    // BoD reader cannot write branches
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          "select public.attendance_upsert_branch_admin($1::uuid, $2::uuid, null, 'BN_01', 'Chi nhánh Bắc Ninh', 'KCN VSIP', 21.18, 106.07, true, 0, $3::uuid, $4::text) as data",
          [ACTORS.BOD_PRIVILEGED.auth, ACTORS.BOD_PRIVILEGED.app, nextUuid(), "a".repeat(64)],
        ),
      (err) => err.code === "42501" && String(err.message).includes("ATTENDANCE_BRANCH_WRITE_DENIED"),
    );

    // Create Branch 1 (with coordinates): BN_01 v1
    const bnCreateKey = nextUuid();
    const bnCreateFp = computeBranchUpsertRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      branch_id: null,
      branch_code: "BN_01",
      display_name: "Chi nhánh Bắc Ninh",
      address: "KCN VSIP Bắc Ninh",
      latitude: BRANCH_BAC_NINH_V1.latitude,
      longitude: BRANCH_BAC_NINH_V1.longitude,
      active: true,
      expected_version: 0,
    });
    const bnCreatedRaw = await callAsServiceRole(
      db,
      `select public.attendance_upsert_branch_admin(
        $1::uuid, $2::uuid, null, 'BN_01', 'Chi nhánh Bắc Ninh', 'KCN VSIP Bắc Ninh',
        $3::double precision, $4::double precision, true, 0, $5::uuid, $6::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        BRANCH_BAC_NINH_V1.latitude,
        BRANCH_BAC_NINH_V1.longitude,
        bnCreateKey,
        bnCreateFp,
      ],
    );
    const bnCreated = projectUpsertBranchResult(bnCreatedRaw);
    assert.ok(bnCreated, "strict projection passes for branch create");
    assert.equal(bnCreated.replayed, false);
    assert.equal(bnCreated.branch.branch_code, "BN_01");
    assert.equal(bnCreated.branch.version, 1);
    const bnBranchId = bnCreated.branch.branch_id;

    // Idempotent replay of branch create returns replayed = true
    const bnReplayRaw = await callAsServiceRole(
      db,
      `select public.attendance_upsert_branch_admin(
        $1::uuid, $2::uuid, null, 'BN_01', 'Chi nhánh Bắc Ninh', 'KCN VSIP Bắc Ninh',
        $3::double precision, $4::double precision, true, 0, $5::uuid, $6::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        BRANCH_BAC_NINH_V1.latitude,
        BRANCH_BAC_NINH_V1.longitude,
        bnCreateKey,
        bnCreateFp,
      ],
    );
    assert.equal(bnReplayRaw.replayed, true);
    assert.equal(bnReplayRaw.branch.branch_id, bnBranchId);

    // Create Branch 2 (without coordinates): DN_NO_GPS v1
    const dnCreateKey = nextUuid();
    const dnCreateFp = computeBranchUpsertRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      branch_id: null,
      branch_code: "DN_NO_GPS",
      display_name: "Chi nhánh Đà Nẵng (Chưa gắn GPS)",
      address: "Hải Châu, Đà Nẵng",
      latitude: null,
      longitude: null,
      active: true,
      expected_version: 0,
    });
    const dnCreatedRaw = await callAsServiceRole(
      db,
      `select public.attendance_upsert_branch_admin(
        $1::uuid, $2::uuid, null, 'DN_NO_GPS', 'Chi nhánh Đà Nẵng (Chưa gắn GPS)', 'Hải Châu, Đà Nẵng',
        null, null, true, 0, $3::uuid, $4::text
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, dnCreateKey, dnCreateFp],
    );
    const dnCreated = projectUpsertBranchResult(dnCreatedRaw);
    assert.ok(dnCreated);
    assert.equal(dnCreated.branch.latitude, null);
    assert.equal(dnCreated.branch.longitude, null);
    const dnBranchId = dnCreated.branch.branch_id;

    // Append-only immutability on attendance_branch_revisions
    await assert.rejects(
      () => db.query("delete from public.attendance_branch_revisions"),
      (err) => String(err.message).includes("ATTENDANCE_CHECKINS_IMMUTABLE"),
    );

    // Anchor initial v1 HQ and branch revisions to 2026-01-01 so October/November 2026
    // test check-ins remain deterministic regardless of the wall-clock date when CI runs.
    await db.query(
      "alter table public.attendance_hq_location_revisions disable trigger attendance_hq_location_revisions_immutable_guard",
    );
    await db.query(
      "update public.attendance_hq_location_revisions set effective_from = '2026-01-01T00:00:00.000Z'::timestamptz where version = 1",
    );
    await db.query(
      "alter table public.attendance_hq_location_revisions enable trigger attendance_hq_location_revisions_immutable_guard",
    );
    await db.query(
      "alter table public.attendance_branch_revisions disable trigger user",
    );
    await db.query(
      "update public.attendance_branch_revisions set effective_from = '2026-01-01T00:00:00.000Z'::timestamptz where version = 1",
    );
    await db.query(
      "alter table public.attendance_branch_revisions enable trigger user",
    );

    // -------------------------------------------------------------------------
    // 3. Employee Branch Assignment by app_user_id & Overlap Guard
    // -------------------------------------------------------------------------
    await db.query("select set_config('direct_entry.test_authorization_date', '2026-11-01', false)");
    const assign1Key = nextUuid();
    const assign1Fp = computeBranchAssignRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      target_app_user_id: ACTORS.STAFF_A.app,
      branch_id: bnBranchId,
      valid_from: "2026-11-01",
      expected_version: 1,
    });
    const assign1Raw = await callAsServiceRole(
      db,
      `select public.attendance_assign_employee_branch_admin(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-11-01'::date, 1, $5::uuid, $6::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        ACTORS.STAFF_A.app,
        bnBranchId,
        assign1Key,
        assign1Fp,
      ],
    );
    const assign1 = projectAssignBranchResult(assign1Raw);
    assert.ok(assign1);
    assert.equal(assign1.assignment.app_user_id, ACTORS.STAFF_A.app);
    assert.equal(assign1.assignment.branch_id, bnBranchId);
    assert.equal(assign1.assignment.valid_from, "2026-11-01");
    assert.equal(assign1.assignment.valid_to, null);

    // Overlapping assignment for STAFF_A must fail with ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP
    await db.query("select set_config('direct_entry.test_authorization_date', '2026-11-10', false)");
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_assign_employee_branch_admin(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-11-10'::date, 1, $5::uuid, $6::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            ACTORS.STAFF_A.app,
            dnBranchId,
            nextUuid(),
            "e".repeat(64),
          ],
        ),
      (err) =>
        (err.code === "PT409" || err.code === "23505") &&
        String(err.message).includes("ATTENDANCE_BRANCH_ASSIGNMENT_OVERLAP"),
    );

    // Assigning disabled user must fail with ATTENDANCE_BRANCH_TARGET_USER_INVALID
    await db.query("select set_config('direct_entry.test_authorization_date', '2026-11-01', false)");
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_assign_employee_branch_admin(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-11-01'::date, 1, $5::uuid, $6::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            ACTORS.DISABLED_STAFF.app,
            bnBranchId,
            nextUuid(),
            "f".repeat(64),
          ],
        ),
      (err) =>
        err.code === "22023" &&
        String(err.message).includes("ATTENDANCE_BRANCH_TARGET_USER_INVALID"),
    );

    // -------------------------------------------------------------------------
    // 4. Check-In Distance by Branch vs HQ & Snapshot Immutability
    // -------------------------------------------------------------------------
    // 4a. STAFF_A (assigned to BN_01 v1) checks in on 2026-11-05 (08:15 VN = 01:15 UTC)
    const staffACheckin1Lat = 21.187;
    const staffACheckin1Lon = 106.077;
    const expectedBranchDist1 = haversineMetersOracle(
      staffACheckin1Lat,
      staffACheckin1Lon,
      BRANCH_BAC_NINH_V1.latitude,
      BRANCH_BAC_NINH_V1.longitude,
    );

    const checkin1 = await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_A,
      latitude: staffACheckin1Lat,
      longitude: staffACheckin1Lon,
      captured_at: "2026-11-05T01:15:00.000Z",
    });
    assert.equal(checkin1.replayed, false);

    // 4b. STAFF_A second check-in on 2026-11-05 (17:30 VN = 10:30 UTC)
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_A,
      latitude: staffACheckin1Lat,
      longitude: staffACheckin1Lon,
      captured_at: "2026-11-05T10:30:00.000Z",
    });

    // 4c. Now update BN_01 coordinates to v2 (~1,150 km away in HCMC)
    const bnUpdateKey = nextUuid();
    const bnUpdateFp = computeBranchUpsertRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      branch_id: bnBranchId,
      branch_code: "BN_01",
      display_name: "Chi nhánh Bắc Ninh (Đổi Tọa Độ)",
      address: "KCN VSIP Bắc Ninh",
      latitude: BRANCH_BAC_NINH_V2.latitude,
      longitude: BRANCH_BAC_NINH_V2.longitude,
      active: true,
      expected_version: 1,
    });
    const bnUpdatedRaw = await callAsServiceRole(
      db,
      `select public.attendance_upsert_branch_admin(
        $1::uuid, $2::uuid, $3::uuid, 'BN_01', 'Chi nhánh Bắc Ninh (Đổi Tọa Độ)', 'KCN VSIP Bắc Ninh',
        $4::double precision, $5::double precision, true, 1, $6::uuid, $7::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        bnBranchId,
        BRANCH_BAC_NINH_V2.latitude,
        BRANCH_BAC_NINH_V2.longitude,
        bnUpdateKey,
        bnUpdateFp,
      ],
    );
    assert.equal(bnUpdatedRaw.branch.version, 2);

    // 4d. Reject future and past valid_to / valid_from under WP1, then unassign STAFF_A from BN_01 on 2026-11-08 and assign to DN_NO_GPS from 2026-11-09
    await db.query("select set_config('direct_entry.test_authorization_date', '2026-11-08', false)");
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_unassign_employee_branch_admin(
            $1::uuid, $2::uuid, $3::uuid, '2099-01-01'::date, 1, $4::uuid, $5::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            assign1.assignment.assignment_id,
            nextUuid(),
            "a".repeat(64),
          ],
        ),
      (err) =>
        err.code === "22023" &&
        String(err.message).includes("ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE"),
    );
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_unassign_employee_branch_admin(
            $1::uuid, $2::uuid, $3::uuid, '2026-11-05'::date, 1, $4::uuid, $5::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            assign1.assignment.assignment_id,
            nextUuid(),
            "b".repeat(64),
          ],
        ),
      (err) =>
        err.code === "22023" &&
        String(err.message).includes("ATTENDANCE_BRANCH_ASSIGNMENT_PAST_DATE"),
    );

    const unassign1Key = nextUuid();
    const unassign1Fp = computeBranchUnassignRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      assignment_id: assign1.assignment.assignment_id,
      valid_to: "2026-11-08",
      expected_version: 1,
    });
    const unassign1Raw = await callAsServiceRole(
      db,
      `select public.attendance_unassign_employee_branch_admin(
        $1::uuid, $2::uuid, $3::uuid, '2026-11-08'::date, 1, $4::uuid, $5::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        assign1.assignment.assignment_id,
        unassign1Key,
        unassign1Fp,
      ],
    );
    const unassign1 = projectUnassignBranchResult(unassign1Raw);
    assert.ok(unassign1);
    assert.equal(unassign1.assignment.valid_to, "2026-11-08");
    assert.equal(unassign1.assignment.version, 2);

    await db.query("select set_config('direct_entry.test_authorization_date', '2026-11-09', false)");
    const assign2Key = nextUuid();
    const assign2Fp = computeBranchAssignRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      target_app_user_id: ACTORS.STAFF_A.app,
      branch_id: dnBranchId,
      valid_from: "2026-11-09",
      expected_version: 1,
    });
    await callAsServiceRole(
      db,
      `select public.attendance_assign_employee_branch_admin(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-11-09'::date, 1, $5::uuid, $6::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        ACTORS.STAFF_A.app,
        dnBranchId,
        assign2Key,
        assign2Fp,
      ],
    );
    await db.query("select set_config('direct_entry.test_authorization_date', '', false)");

    // 4e. STAFF_A checks in on 2026-11-10 while assigned to DN_NO_GPS (missing branch coordinates)
    // Must succeed, record BRANCH_NOT_CONFIGURED with distance_meters = null, and NOT fallback to HQ!
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_A,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-11-10T01:00:00.000Z",
    });

    // 4f. STAFF_B (unassigned to any branch) checks in on 2026-11-05 near HQ_HANOI
    const staffBCheckinLat = 21.029;
    const staffBCheckinLon = 105.805;
    const expectedHqDist = haversineMetersOracle(
      staffBCheckinLat,
      staffBCheckinLon,
      HQ_HANOI.latitude,
      HQ_HANOI.longitude,
    );
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: staffBCheckinLat,
      longitude: staffBCheckinLon,
      captured_at: "2026-11-05T01:20:00.000Z",
    });

    // Verify attendance_admin_report preserves historical BN_01 v1 snapshot & DN_NO_GPS status
    const adminReportRaw = await callAsServiceRole(
      db,
      `select public.attendance_admin_report(
        $1::uuid, $2::uuid, '2026-11-01'::date, '2026-11-30'::date, 1, 25, null, null
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
    );
    const adminReport = projectAttendanceAdminReport(adminReportRaw);
    assert.ok(adminReport, "attendance_admin_report strict projection passes with branch fields");

    const nov17Item = adminReport.items.find(
      (i) => i.employee_display_name === ACTORS.STAFF_A.name && i.business_date === "2026-11-10",
    );
    assert.ok(nov17Item);
    assert.equal(nov17Item.distance_status, "BRANCH_NOT_CONFIGURED");
    assert.equal(nov17Item.distance_meters, null);
    assert.equal(nov17Item.hq_version_used, null);
    assert.equal(nov17Item.branch_code_used, "DN_NO_GPS");
    assert.equal(nov17Item.branch_version_used, 1);

    const nov05StaffAItems = adminReport.items.filter(
      (i) => i.employee_display_name === ACTORS.STAFF_A.name && i.business_date === "2026-11-05",
    );
    assert.equal(nov05StaffAItems.length, 2);
    for (const item of nov05StaffAItems) {
      assert.equal(item.distance_status, "COMPUTED");
      assert.equal(item.distance_meters, expectedBranchDist1);
      assert.equal(item.branch_id_used, bnBranchId);
      assert.equal(item.branch_code_used, "BN_01");
      assert.equal(item.branch_name_used, "Chi nhánh Bắc Ninh");
      assert.equal(
        item.branch_version_used,
        1,
        "historical check-in must keep branch_version_used = 1 after BN_01 is updated to v2",
      );
      assert.equal(item.hq_version_used, null);
    }

    const nov05StaffBItem = adminReport.items.find(
      (i) => i.employee_display_name === ACTORS.STAFF_B.name && i.business_date === "2026-11-05",
    );
    assert.ok(nov05StaffBItem);
    assert.equal(nov05StaffBItem.distance_status, "COMPUTED");
    assert.equal(nov05StaffBItem.distance_meters, expectedHqDist);
    assert.equal(nov05StaffBItem.hq_version_used, 1);
    assert.equal(nov05StaffBItem.branch_id_used, null);

    // Verify attendance_list_branches_admin
    const branchListRaw = await callAsServiceRole(
      db,
      "select public.attendance_list_branches_admin($1::uuid, $2::uuid, true) as data",
      [ACTORS.BOD_PRIVILEGED.auth, ACTORS.BOD_PRIVILEGED.app],
    );
    const branchList = projectAttendanceBranchesAdminList(branchListRaw);
    assert.ok(branchList, "attendance_list_branches_admin strict projection passes");
    assert.equal(branchList.viewer.can_manage_branches, false);
    assert.equal(branchList.branches.length, 2);
    assert.equal(branchList.assignments.length, 2);

    // -------------------------------------------------------------------------
    // 5. Approved Leaves & Monthly Attendance Matrix Report
    // -------------------------------------------------------------------------
    const leaveReqId1 = nextUuid();
    const leaveReqId2 = nextUuid();
    await db.query(
      `insert into public.leave_requests (
         request_id, app_user_id, status, employment_status_snapshot, unit_kind_snapshot,
         profile_configured_at_submit, requested_units, reason, route_kind,
         submitted_at, decided_at, decided_by_app_user_id, row_version
       ) values
       ($1::uuid, $2::uuid, 'APPROVED', 'OFFICIAL', 'RECRUITMENT', true, 3, 'Nghỉ phép tháng 11', 'TEAM_LEADER', now(), now(), $3::uuid, 2),
       ($4::uuid, $5::uuid, 'PENDING', 'OFFICIAL', 'RECRUITMENT', true, 2, 'Chưa duyệt', 'TEAM_LEADER', now(), null, null, 1)`,
      [
        leaveReqId1,
        ACTORS.STAFF_A.app,
        ACTORS.FULL_ADMIN.app,
        leaveReqId2,
        ACTORS.STAFF_A.app,
      ],
    );

    await db.query(
      `insert into public.leave_request_days (
         request_id, app_user_id, leave_date, session_code,
         leave_type, half_day_units, is_active
       ) values
       ($1::uuid, $2::uuid, '2026-11-06'::date, 'FULL', 'ANNUAL', 2, true),
       ($1::uuid, $2::uuid, '2026-11-05'::date, 'PM', 'UNPAID', 1, true),
       ($3::uuid, $2::uuid, '2026-11-07'::date, 'FULL', 'ANNUAL', 2, true)`,
      [leaveReqId1, ACTORS.STAFF_A.app, leaveReqId2],
    );

    const matrixRaw = await callAsServiceRole(
      db,
      `select public.attendance_monthly_matrix_report(
        $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 25
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
    );
    const matrix = projectAttendanceMonthlyMatrixReport(matrixRaw);
    assert.ok(matrix, "attendance_monthly_matrix_report strict projection passes");
    assert.equal(matrix.filters.year_month, "2026-11");
    assert.equal(matrix.days_in_month, 30);
    assert.equal(matrix.calendar_days.length, 30);

    const staffARow = matrix.items.find((r) => r.app_user_id === ACTORS.STAFF_A.app);
    assert.ok(staffARow, "STAFF_A row present in monthly matrix");
    assert.equal(staffARow.personnel_code, "NV_MAT_01");
    assert.equal(staffARow.summary.checkin_day_count, 2); // Nov 5 and Nov 17
    assert.equal(staffARow.summary.total_checkins, 3); // 2 on Nov 5 + 1 on Nov 17
    assert.equal(staffARow.summary.approved_leave_day_count, 2); // Nov 5 (PM) and Nov 6 (FULL); Nov 7 SUBMITTED is excluded
    assert.equal(staffARow.summary.approved_leave_units, 1.5); // 3 half-day units = 1.5 days
    assert.equal(staffARow.summary.checkin_and_leave_day_count, 1); // Nov 5 has both check-in and PM leave
    const { rows: businessDateRows } = await db.query(
      "select to_char(clock_timestamp() at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') as today_vn",
    );
    const [todayYear, todayMonth, todayDay] = businessDateRows[0].today_vn
      .split("-")
      .map(Number);
    const todayMonthKey = todayYear * 12 + todayMonth;
    const reportMonthKey = 2026 * 12 + 11;
    const completedDayCount = Math.min(
      30,
      Math.max(
        0,
        todayMonthKey > reportMonthKey
          ? 30
          : todayMonthKey === reportMonthKey
            ? todayDay - 1
            : 0,
      ),
    );
    const elapsedCheckinDays = [5, 10].filter((day) => day <= completedDayCount).length;
    const elapsedLeaveDays = [5, 6].filter((day) => day <= completedDayCount).length;
    const elapsedOverlapDays = [5].filter((day) => day <= completedDayCount).length;
    assert.equal(staffARow.summary.no_checkin_day_count, completedDayCount - elapsedCheckinDays);
    assert.equal(
      staffARow.summary.no_checkin_without_leave_day_count,
      completedDayCount - elapsedCheckinDays - (elapsedLeaveDays - elapsedOverlapDays),
      "Only completed calendar days contribute to missing-attendance totals",
    );

    const nov05Cell = staffARow.days.find((d) => d.business_date === "2026-11-05");
    assert.ok(nov05Cell);
    assert.equal(nov05Cell.day_status, "CHECKED_IN_AND_LEAVE");
    assert.equal(nov05Cell.checkin_count, 2);
    assert.equal(nov05Cell.first_time_local, "08:15");
    assert.equal(nov05Cell.last_time_local, "17:30");
    assert.equal(nov05Cell.distance_target_kind, "BRANCH");
    assert.equal(nov05Cell.branch_code_used, "BN_01");
    assert.equal(nov05Cell.branch_version_used, 1);
    assert.equal(nov05Cell.distance_meters, expectedBranchDist1);
    assert.equal(nov05Cell.has_approved_leave, true);
    assert.equal(nov05Cell.approved_leave_units, 0.5);
    assert.equal(nov05Cell.approved_leaves.length, 1);
    assert.equal(nov05Cell.approved_leaves[0].session_code, "PM");
    assert.equal(nov05Cell.approved_leaves[0].leave_type, "UNPAID");

    const nov06Cell = staffARow.days.find((d) => d.business_date === "2026-11-06");
    assert.ok(nov06Cell);
    assert.equal(nov06Cell.day_status, "APPROVED_LEAVE");
    assert.equal(nov06Cell.has_checkin, false);
    assert.equal(nov06Cell.has_approved_leave, true);
    assert.equal(nov06Cell.approved_leave_units, 1);
    assert.equal(nov06Cell.approved_leaves[0].session_code, "FULL");
    assert.equal(nov06Cell.approved_leaves[0].leave_type, "ANNUAL");

    const nov07Cell = staffARow.days.find((d) => d.business_date === "2026-11-07");
    assert.ok(nov07Cell);
    assert.ok(
      ["UPCOMING", "NO_CHECKIN"].includes(nov07Cell.day_status),
      "unapproved leave does not cover attendance; the day is upcoming until slots are due",
    );
    assert.equal(nov07Cell.has_approved_leave, false);
    assert.ok(nov07Cell.slots.every((slot) => slot.slot_status !== "LEAVE_COVERED"));

    const nov17Cell = staffARow.days.find((d) => d.business_date === "2026-11-10");
    assert.ok(nov17Cell);
    assert.equal(nov17Cell.day_status, "CHECKED_IN");
    assert.equal(nov17Cell.distance_target_kind, "BRANCH");
    assert.equal(nov17Cell.distance_status, "BRANCH_NOT_CONFIGURED");
    assert.equal(nov17Cell.distance_meters, null);

    // Filter monthly matrix by historical branch_id_used (bnBranchId)
    const bnFilteredRaw = await callAsServiceRole(
      db,
      `select public.attendance_monthly_matrix_report(
        $1::uuid, $2::uuid, '2026-11', $3::uuid, null, null, 1, 25
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, bnBranchId],
    );
    const bnFiltered = projectAttendanceMonthlyMatrixReport(bnFilteredRaw);
    assert.ok(bnFiltered);
    assert.equal(bnFiltered.items.length, 1);
    assert.equal(bnFiltered.items[0].app_user_id, ACTORS.STAFF_A.app);

    // Snapshot token consistency across paginated RPC calls & change detection when data mutates with identical total_rows
    const page1BeforeEdit = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 1
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
      ),
    );
    const page2BeforeEdit = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 2, 1
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
      ),
    );
    assert.ok(page1BeforeEdit && page2BeforeEdit);
    assert.match(page1BeforeEdit.pagination.snapshot_token, /^[0-9a-f]{32}$/);
    assert.equal(
      page2BeforeEdit.pagination.snapshot_token,
      page1BeforeEdit.pagination.snapshot_token,
      "snapshot_token must match across pages when reading the same dataset state",
    );

    // Approve leaveReqId2 (Nov 7) mid-export: total_rows remains identical, but dataset snapshot changes
    await db.query(
      "update public.leave_requests set status = 'APPROVED', decided_at = now(), decided_by_app_user_id = $2::uuid where request_id = $1::uuid",
      [leaveReqId2, ACTORS.FULL_ADMIN.app],
    );
    const page2AfterEdit = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 2, 1
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
      ),
    );
    assert.ok(page2AfterEdit);
    assert.equal(
      page2AfterEdit.pagination.total_rows,
      page1BeforeEdit.pagination.total_rows,
      "total_rows stays identical after mid-export edit",
    );
    assert.notEqual(
      page2AfterEdit.pagination.snapshot_token,
      page1BeforeEdit.pagination.snapshot_token,
      "snapshot_token must change when underlying attendance/leave data changes with identical row count",
    );

    // -------------------------------------------------------------------------
    // 6. Project Coordinates Admin CRUD & HRP Sync Catalog RPC
    // -------------------------------------------------------------------------
    // Team leader cannot update project coordinates
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.direct_entry_update_project_location(
            $1::uuid, $2::uuid, 'luxshare-bn', 1, 'KCN Quang Châu', 21.2581234, 106.1534567, 250, false, 'Cập nhật tọa độ', 'idem-proj-loc-denied'
          ) as data`,
          [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
        ),
      (err) => err.code === "42501",
    );

    const updatedLocRaw = await callAsServiceRole(
      db,
      `select public.direct_entry_update_project_location(
        $1::uuid, $2::uuid, 'luxshare-bn', 1, 'KCN Quang Châu, Việt Yên, Bắc Giang',
        21.2581234, 106.1534567, 250, false, 'Xác nhận tọa độ cổng chính', 'idem-proj-loc-1'
      ) as data`,
      [ACTORS.PROJECT_ADMIN.auth, ACTORS.PROJECT_ADMIN.app],
    );
    const updatedLoc = projectAdminLocationMutation(updatedLocRaw);
    assert.equal(updatedLoc.project_id, "luxshare-bn");
    assert.equal(updatedLoc.version, 2);
    assert.deepEqual(updatedLoc.location, {
      address: "KCN Quang Châu, Việt Yên, Bắc Giang",
      latitude: 21.2581234,
      longitude: 106.1534567,
      radius_meters: 250,
      confirmed_at: updatedLoc.location.confirmed_at,
    });

    // List & Get projects admin include location
    const listedProjectsRaw = await callAsServiceRole(
      db,
      "select public.direct_entry_list_projects_admin($1::uuid, $2::uuid, true) as data",
      [ACTORS.PROJECT_ADMIN.auth, ACTORS.PROJECT_ADMIN.app],
    );
    const listedProjects = projectAdminList(listedProjectsRaw);
    const luxProject = listedProjects.projects.find((p) => p.project_id === "luxshare-bn");
    assert.ok(luxProject);
    assert.equal(luxProject.version, 2);
    assert.equal(luxProject.location?.latitude, 21.2581234);
    assert.equal(luxProject.location?.radius_meters, 250);

    const gotProjectRaw = await callAsServiceRole(
      db,
      "select public.direct_entry_get_project_admin($1::uuid, $2::uuid, 'goertek-bn') as data",
      [ACTORS.PROJECT_ADMIN.auth, ACTORS.PROJECT_ADMIN.app],
    );
    const gotProject = projectAdminProject(gotProjectRaw);
    assert.equal(gotProject.location, null);

    // HRP Sync Catalog RPC
    const requestId = nextUuid();
    const hrpCatalogRaw = await callAsServiceRole(
      db,
      "select public.hrp_sync_catalog($1::uuid, null, $2::uuid) as data",
      [ACTORS.PROJECT_ADMIN.auth, requestId],
    );
    const hrpCatalog = projectHrpSyncCatalog(hrpCatalogRaw);
    assert.ok(hrpCatalog, "hrp_sync_catalog matches BI-HRP-WORKER-SYNC-CONTRACT.md §3.1");
    assert.equal(hrpCatalog.ok, true);
    const hrpLux = hrpCatalog.projects.find((p) => p.projectId === "luxshare-bn");
    assert.ok(hrpLux);
    assert.equal(hrpLux.version, 2);
    assert.deepEqual(hrpLux.location, {
      address: "KCN Quang Châu, Việt Yên, Bắc Giang",
      latitude: 21.2581234,
      longitude: 106.1534567,
      radiusMeters: 250,
      confirmedAt: hrpLux.location?.confirmedAt ?? null,
    });
    const hrpGoertek = hrpCatalog.projects.find((p) => p.projectId === "goertek-bn");
    assert.ok(hrpGoertek);
    assert.equal(hrpGoertek.location, null);

    // Verify audit event written for hrp_sync_catalog_read
    const { rows: auditRows } = await db.query(
      `select action, capability, resource_ref, outcome, changed_fields
         from public.direct_entry_audit_events
        where action = 'hrp_sync_catalog_read'
          and resource_ref = $1`,
      [`hrp_v1_catalog:${requestId}`],
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].outcome, "ALLOW");
    assert.equal(auditRows[0].capability, "integration_hrp_catalog");

    // Clear project coordinates
    const clearedLocRaw = await callAsServiceRole(
      db,
      `select public.direct_entry_update_project_location(
        $1::uuid, $2::uuid, 'luxshare-bn', 2, null, null, null, null, true, 'Xóa tọa độ tạm', 'idem-proj-loc-clear'
      ) as data`,
      [ACTORS.PROJECT_ADMIN.auth, ACTORS.PROJECT_ADMIN.app],
    );
    const clearedLoc = projectAdminLocationMutation(clearedLocRaw);
    assert.equal(clearedLoc.version, 3);
    assert.equal(clearedLoc.location, null);

    // -------------------------------------------------------------------------
    // 7. Flexible Slot Monthly Attendance Matrix & Date-Effective Slot Policy Configuration
    // -------------------------------------------------------------------------
    // 7a. Default seeded slot policy version 1 (5 slots: 07:30, 10:00, 13:00, 15:00, 16:30, ±15m)
    const slotPoliciesRaw1 = await callAsServiceRole(
      db,
      "select public.attendance_get_slot_policies_admin($1::uuid, $2::uuid) as data",
      [ACTORS.BOD_PRIVILEGED.auth, ACTORS.BOD_PRIVILEGED.app],
    );
    const slotPolicies1 = projectAttendanceSlotPoliciesAdminList(slotPoliciesRaw1);
    assert.ok(slotPolicies1, "attendance_get_slot_policies_admin strict projection passes");
    assert.equal(slotPolicies1.viewer.can_manage_slot_policy, false);
    assert.equal(slotPolicies1.current_policy.version, 1);
    assert.equal(slotPolicies1.current_policy.effective_from_date, "2000-01-01");
    assert.deepEqual(
      slotPolicies1.current_policy.slots.map((s) => s.target_time),
      ["07:30", "10:00", "13:00", "15:00", "16:30"],
    );
    assert.deepEqual(
      slotPolicies1.current_policy.slots.map((s) => s.slot_label),
      ["Time 1", "Time 2", "Time 3", "Time 4", "Time 5"],
    );

    // 7b. BoD cannot create a slot policy version
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_create_slot_policy_admin(
            $1::uuid, $2::uuid, '2026-12-15'::date,
            '07:30', 15, 15, '11:30', 15, 15, '13:00', 15, 15, '17:00', 15, 15,
            1, $3::uuid, $4::text
          ) as data`,
          [ACTORS.BOD_PRIVILEGED.auth, ACTORS.BOD_PRIVILEGED.app, nextUuid(), "a".repeat(64)],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_WRITE_DENIED/.test(err.message),
    );

    // 7c. Past effective_from_date is rejected to protect historical reports
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_create_slot_policy_admin(
            $1::uuid, $2::uuid, '2000-06-01'::date,
            '07:30', 15, 15, '11:30', 15, 15, '13:00', 15, 15, '17:00', 15, 15,
            1, $3::uuid, $4::text
          ) as data`,
          [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, nextUuid(), "b".repeat(64)],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_EFFECTIVE_DATE_PAST/.test(err.message),
    );

    // 7d. Create date-effective winter schedule v2 starting 2026-12-15 (4 slots: 08:30, 12:00, 13:30, 17:30, ±15m)
    const createPolicyKey = nextUuid();
    const createPolicyInput = {
      effective_from_date: "2026-12-15",
      slot_1_time: "08:30",
      slot_1_grace_before_minutes: 15,
      slot_1_grace_after_minutes: 15,
      slot_2_time: "12:00",
      slot_2_grace_before_minutes: 15,
      slot_2_grace_after_minutes: 15,
      slot_3_time: "13:30",
      slot_3_grace_before_minutes: 15,
      slot_3_grace_after_minutes: 15,
      slot_4_time: "17:30",
      slot_4_grace_before_minutes: 15,
      slot_4_grace_after_minutes: 15,
      expected_version: 1,
      idempotency_key: createPolicyKey,
    };
    const createPolicyFp = computeSlotPolicyCreateRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      ...createPolicyInput,
    });
    const createdPolicyRaw = await callAsServiceRole(
      db,
      `select public.attendance_create_slot_policy_admin(
        $1::uuid, $2::uuid, '2026-12-15'::date,
        '08:30', 15, 15, '12:00', 15, 15, '13:30', 15, 15, '17:30', 15, 15,
        1, $3::uuid, $4::text
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, createPolicyKey, createPolicyFp],
    );
    const createdPolicy = projectCreateSlotPolicyResult(createdPolicyRaw);
    assert.ok(createdPolicy, "attendance_create_slot_policy_admin strict projection passes");
    assert.equal(createdPolicy.replayed, false);
    assert.equal(createdPolicy.policy.version, 2);
    assert.equal(createdPolicy.policy.effective_from_date, "2026-12-15");
    assert.equal(createdPolicy.policy.slots.length, 4);

    // 7d-bis. Create flexible 6-slot schedule v3 starting 2026-12-22 via 7-arg JSONB RPC
    const createPolicyV3Key = nextUuid();
    const v3Slots = [
      { slot_label: "Time 1", target_time: "07:00", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 2", target_time: "09:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 3", target_time: "11:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 4", target_time: "13:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 5", target_time: "15:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_label: "Time 6", target_time: "17:30", grace_before_minutes: 15, grace_after_minutes: 15 },
    ];
    const createPolicyV3Fp = computeSlotPolicyCreateRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      effective_from_date: "2026-12-22",
      slots: v3Slots,
      expected_version: 2,
    });
    const createdPolicyV3Raw = await callAsServiceRole(
      db,
      `select public.attendance_create_slot_policy_admin(
        $1::uuid, $2::uuid, '2026-12-22'::date, $3::jsonb, 2, $4::uuid, $5::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        JSON.stringify(v3Slots),
        createPolicyV3Key,
        createPolicyV3Fp,
      ],
    );
    const createdPolicyV3 = projectCreateSlotPolicyResult(createdPolicyV3Raw);
    assert.ok(createdPolicyV3, "6-slot policy v3 strict projection passes");
    assert.equal(createdPolicyV3.policy.version, 3);
    assert.equal(createdPolicyV3.policy.slots.length, 6);
    assert.deepEqual(
      createdPolicyV3.policy.slots.map((s) => s.target_time),
      ["07:00", "09:30", "11:30", "13:30", "15:30", "17:30"],
    );

    // 7e. Overlapping/earlier effective_from_date (<= 2026-12-22) and stale expected_version are rejected
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_create_slot_policy_admin(
            $1::uuid, $2::uuid, '2026-12-22'::date,
            '08:00', 15, 15, '11:00', 15, 15, '13:00', 15, 15, '17:00', 15, 15,
            3, $3::uuid, $4::text
          ) as data`,
          [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, nextUuid(), "c".repeat(64)],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_OVERLAP/.test(err.message),
    );
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_create_slot_policy_admin(
            $1::uuid, $2::uuid, '2026-12-28'::date,
            '08:00', 15, 15, '11:00', 15, 15, '13:00', 15, 15, '17:00', 15, 15,
            1, $3::uuid, $4::text
          ) as data`,
          [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, nextUuid(), "d".repeat(64)],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT/.test(err.message),
    );

    // 7f. Verify immutability trigger on public.attendance_slot_policy_versions
    await assert.rejects(
      () =>
        db.query(
          "update public.attendance_slot_policy_versions set slot_1_time = '09:00' where version = 1",
        ),
      (err) => /ATTENDANCE_CHECKINS_IMMUTABLE/.test(err.message),
    );

    // 7g. Record December 2026 check-ins for STAFF_B across v1 (5 slots), v2 (4 slots), and v3 (6 slots):
    // On 2026-12-10 (uses v1 5-slot: 07:30, 10:00, 13:00, 15:00, 16:30 ±15m):
    // - 07:15 VN (00:15 UTC): exact boundary (-15m from 07:30) -> SLOT_1, ON_TIME
    // - 07:45 VN (00:45 UTC): exact boundary (+15m from 07:30) -> SLOT_1, ON_TIME (2nd check-in in SLOT_1!)
    // - 08:45 VN (01:45 UTC): equidistant tie-break between 07:30 (450m) and 10:00 (600m) -> SLOT_1, LATE (+75m)
    // - 11:30 VN (04:30 UTC): equidistant tie-break between 10:00 (600m) and 13:00 (780m) -> SLOT_2, LATE (+90m)
    // - 14:00 VN (07:00 UTC): equidistant tie-break between 13:00 (780m) and 15:00 (900m) -> SLOT_3, LATE (+60m)
    for (const utcTime of [
      "2026-12-10T00:15:00.000Z",
      "2026-12-10T00:45:00.000Z",
      "2026-12-10T01:45:00.000Z",
      "2026-12-10T04:30:00.000Z",
      "2026-12-10T07:00:00.000Z",
    ]) {
      await recordCheckInAsServiceRole(db, {
        actor: ACTORS.STAFF_B,
        latitude: HQ_HANOI.latitude,
        longitude: HQ_HANOI.longitude,
        captured_at: utcTime,
      });
    }

    // On 2026-12-16 (uses v2 4-slot: 08:30, 12:00, 13:30, 17:30 ±15m):
    // - 08:30 VN (01:30 UTC): under v2, 08:30 is exact ON_TIME for SLOT_1
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-12-16T01:30:00.000Z",
    });

    // On 2026-12-24 (uses v3 6-slot: 07:00, 09:30, 11:30, 13:30, 15:30, 17:30 ±15m):
    // - 17:30 VN (10:30 UTC): assigned to SLOT_6 (17:30), ON_TIME
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-12-24T10:30:00.000Z",
    });

    const decMatrixRaw = await callAsServiceRole(
      db,
      `select public.attendance_monthly_matrix_report(
        $1::uuid, $2::uuid, '2026-12', null, $3::uuid, null, 1, 25
      ) as data`,
      [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, ACTORS.STAFF_B.app],
    );
    const decMatrix = projectAttendanceMonthlyMatrixReport(decMatrixRaw);
    assert.ok(decMatrix, "December matrix strict projection passes");
    assert.deepEqual(
      decMatrix.slot_policy.month_policies.map((p) => p.version),
      [1, 2, 3],
      "December 2026 report must report v1 (5 slots), v2 (4 slots), and v3 (6 slots) in month_policies",
    );
    assert.deepEqual(
      decMatrix.slot_policy.month_policies.map((p) => p.slots.length),
      [5, 4, 6],
    );

    const staffBDecRow = decMatrix.items[0];
    assert.ok(staffBDecRow);

    const dec10Cell = staffBDecRow.days.find((d) => d.business_date === "2026-12-10");
    assert.ok(dec10Cell);
    assert.equal(dec10Cell.policy_version_used, 1);
    assert.equal(dec10Cell.slots.length, 5);
    assert.equal(dec10Cell.slots[0].target_time, "07:30");
    assert.deepEqual(
      dec10Cell.slots[0].checkins.map((c) => c.time_local),
      ["07:15", "07:45", "08:45"],
    );
    assert.equal(dec10Cell.slots[0].checkins[0].deviation_status, "ON_TIME");
    assert.equal(dec10Cell.slots[0].checkins[1].deviation_status, "ON_TIME");
    assert.equal(dec10Cell.slots[0].checkins[2].deviation_status, "LATE");
    assert.deepEqual(
      dec10Cell.slots[1].checkins.map((c) => c.time_local),
      ["11:30"],
    );
    assert.deepEqual(
      dec10Cell.slots[2].checkins.map((c) => c.time_local),
      ["14:00"],
    );
    assert.equal(dec10Cell.slots[3].slot_status, "UPCOMING");
    assert.equal(dec10Cell.slots[4].slot_status, "UPCOMING");
    assert.equal(dec10Cell.day_status, "CHECKED_IN");
    assert.equal(dec10Cell.missing_slot_count, 0);

    const dec16Cell = staffBDecRow.days.find((d) => d.business_date === "2026-12-16");
    assert.ok(dec16Cell);
    assert.equal(dec16Cell.policy_version_used, 2);
    assert.equal(dec16Cell.slots.length, 4);
    assert.equal(dec16Cell.slots[0].target_time, "08:30");
    assert.equal(dec16Cell.slots[0].slot_status, "ON_TIME");
    assert.equal(dec16Cell.slots[0].checkins[0].time_local, "08:30");
    assert.equal(dec16Cell.slots[0].checkins[0].deviation_status, "ON_TIME");
    assert.equal(dec16Cell.slots[0].checkins[0].delta_minutes, 0);

    const dec24Cell = staffBDecRow.days.find((d) => d.business_date === "2026-12-24");
    assert.ok(dec24Cell);
    assert.equal(dec24Cell.policy_version_used, 3);
    assert.equal(dec24Cell.slots.length, 6);
    assert.equal(dec24Cell.slots[5].slot_code, "SLOT_6");
    assert.equal(dec24Cell.slots[5].target_time, "17:30");
    assert.equal(dec24Cell.slots[5].slot_status, "ON_TIME");
    assert.equal(dec24Cell.slots[5].checkins[0].time_local, "17:30");

    // -------------------------------------------------------------------------
    // 8. Wave 2: Attendance Explanations (Employee Submit, Leave-Aligned Approver Routing, Approve/Reject & Report Projection)
    // -------------------------------------------------------------------------
    // Configure TEAM_LEADER as active leader of TEAM_ALPHA so Leave & Attendance Explanation routing resolves TEAM_LEADER
    const teamLeaderRecruiterId = "39100000-0000-4000-8000-000000000004";
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, 'NV_TL_01', 'TEAM_LEADER', true)
       on conflict do nothing`,
      [teamLeaderRecruiterId, ACTORS.TEAM_LEADER.name],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-01-01', true)
       on conflict do nothing`,
      [ACTORS.TEAM_LEADER.app, teamLeaderRecruiterId],
    );
    await db.query(
      `insert into public.direct_entry_team_leader_assignments
         (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01'::date, true)
       on conflict do nothing`,
      [TEAM_ALPHA, ACTORS.TEAM_LEADER.app, teamLeaderRecruiterId],
    );

    // Seed past check-ins on 2026-10-10 (which is <= today in Asia/Ho_Chi_Minh):
    // - 00:30 UTC -> 07:30 local -> SLOT_1 (07:30) ON_TIME
    // - 04:30 UTC -> 11:30 local -> SLOT_2 (10:00) OUT_OF_GRACE (+90p)
    // - SLOT_4 (15:00) -> MISSING
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-10-10T00:30:00.000Z",
    });
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-10-10T04:30:00.000Z",
    });

    const { rows: checkinCountBeforeRows } = await db.query(
      `select count(*)::int as cnt
         from public.attendance_checkins
        where app_user_id = $1::uuid
          and business_date = '2026-10-10'::date`,
      [ACTORS.STAFF_B.app],
    );
    assert.equal(checkinCountBeforeRows[0].cnt, 2);

    // 8a. STAFF_B loads personal explanation overview for 2026-10-10
    const overviewRaw = await callAsServiceRole(
      db,
      "select public.attendance_get_my_explanations_overview($1::uuid, $2::uuid, '2026-10-10'::date) as data",
      [ACTORS.STAFF_B.auth, ACTORS.STAFF_B.app],
    );
    const overview = projectMyAttendanceExplanationsOverview(overviewRaw);
    assert.ok(overview, "attendance_get_my_explanations_overview strict projection passes");
    assert.equal(overview.viewer.can_submit_explanation, true);
    assert.equal(overview.routing.route_kind, "TEAM_LEADER");
    assert.equal(overview.routing.primary_approver?.app_user_id, ACTORS.TEAM_LEADER.app);

    // 8b. Submitting an explanation for a future date is rejected as ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_submit_explanation(
            $1::uuid, $2::uuid, '2026-12-16'::date, 'SLOT_1', 'Ngày tương lai', $3::text, $4::text
          ) as data`,
          [ACTORS.STAFF_B.auth, ACTORS.STAFF_B.app, nextUuid(), "0".repeat(64)],
        ),
      (err) => /ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED/.test(err.message),
    );

    // On 2026-10-10, SLOT_1 is ON_TIME (07:30 vs 07:30) -> must be rejected as ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE!
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_submit_explanation(
            $1::uuid, $2::uuid, '2026-10-10'::date, 'SLOT_1', 'Khung giờ đã đúng giờ', $3::text, $4::text
          ) as data`,
          [ACTORS.STAFF_B.auth, ACTORS.STAFF_B.app, nextUuid(), "1".repeat(64)],
        ),
      (err) => /ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE/.test(err.message),
    );

    // Submit explanation for 2026-10-10 SLOT_2 (OUT_OF_GRACE, check-in at 11:30 vs 10:00)
    const expSlot2Key = nextUuid();
    const expSlot2Body = {
      app_user_id: ACTORS.STAFF_B.app,
      business_date: "2026-10-10",
      slot_code: "SLOT_2",
      reason: "Kẹt xe khi di chuyển giữa hai điểm phỏng vấn",
    };
    const expSlot2Fp = computeExplanationSubmitRequestFingerprint(expSlot2Body);
    const expSlot2Raw = await callAsServiceRole(
      db,
      `select public.attendance_submit_explanation(
        $1::uuid, $2::uuid, '2026-10-10'::date, 'SLOT_2', $3::text, $4::text, $5::text
      ) as data`,
      [
        ACTORS.STAFF_B.auth,
        ACTORS.STAFF_B.app,
        expSlot2Body.reason,
        expSlot2Key,
        expSlot2Fp,
      ],
    );
    const expSlot2 = projectSubmitAttendanceExplanationResult(expSlot2Raw);
    assert.ok(expSlot2, "submit explanation SLOT_2 projection passes");
    assert.equal(expSlot2.replayed, false);
    assert.equal(expSlot2.explanation.status, "PENDING");
    assert.equal(expSlot2.explanation.original_slot_status, "OUT_OF_GRACE");
    assert.equal(expSlot2.explanation.route_kind, "TEAM_LEADER");
    assert.equal(expSlot2.explanation.primary_approver?.app_user_id, ACTORS.TEAM_LEADER.app);
    assert.equal(expSlot2.explanation.related_checkins.length, 1);
    assert.equal(expSlot2.explanation.related_checkins[0].time_local, "11:30");

    // Submit explanation for 2026-10-10 SLOT_4 (MISSING, target 15:00)
    const expSlot4Key = nextUuid();
    const expSlot4Body = {
      app_user_id: ACTORS.STAFF_B.app,
      business_date: "2026-10-10",
      slot_code: "SLOT_4",
      reason: "Đi gặp ứng viên tại khu công nghiệp không có sóng",
    };
    const expSlot4Fp = computeExplanationSubmitRequestFingerprint(expSlot4Body);
    const expSlot4Raw = await callAsServiceRole(
      db,
      `select public.attendance_submit_explanation(
        $1::uuid, $2::uuid, '2026-10-10'::date, 'SLOT_4', $3::text, $4::text, $5::text
      ) as data`,
      [
        ACTORS.STAFF_B.auth,
        ACTORS.STAFF_B.app,
        expSlot4Body.reason,
        expSlot4Key,
        expSlot4Fp,
      ],
    );
    const expSlot4 = projectSubmitAttendanceExplanationResult(expSlot4Raw);
    assert.ok(expSlot4, "submit explanation SLOT_4 projection passes");
    assert.equal(expSlot4.explanation.original_slot_status, "MISSING");
    assert.equal(expSlot4.explanation.related_checkins.length, 0);

    // Future slots must not be submittable before their configured time window.
    const futureExplanationBody = {
      app_user_id: ACTORS.STAFF_B.app,
      business_date: "2099-12-31",
      slot_code: "SLOT_1",
      reason: "Không thể chấm công ở thời điểm tương lai",
    };
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_submit_explanation(
            $1::uuid, $2::uuid, '2099-12-31'::date, 'SLOT_1', $3::text, $4::text, $5::text
          ) as data`,
          [
            ACTORS.STAFF_B.auth,
            ACTORS.STAFF_B.app,
            futureExplanationBody.reason,
            nextUuid(),
            computeExplanationSubmitRequestFingerprint(futureExplanationBody),
          ],
        ),
      (err) => /ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED/.test(err.message),
    );

    // Duplicate explanation for same employee + date + slot with new idempotency key is rejected
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_submit_explanation(
            $1::uuid, $2::uuid, '2026-10-10'::date, 'SLOT_4', 'Gửi trùng lần 2', $3::text, $4::text
          ) as data`,
          [ACTORS.STAFF_B.auth, ACTORS.STAFF_B.app, nextUuid(), "2".repeat(64)],
        ),
      (err) => /ATTENDANCE_EXPLANATION_ALREADY_EXISTS/.test(err.message),
    );

    // Self-approval by STAFF_B is denied
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_decide_explanation(
            $1::uuid, $2::uuid, $3::uuid, 'APPROVE', 1, 'Tự duyệt', $4::text, $5::text
          ) as data`,
          [
            ACTORS.STAFF_B.auth,
            ACTORS.STAFF_B.app,
            expSlot4.explanation.explanation_id,
            nextUuid(),
            "3".repeat(64),
          ],
        ),
      (err) =>
        /ATTENDANCE_EXPLANATION_DECIDE_DENIED|ATTENDANCE_EXPLANATION_SELF_APPROVAL_FORBIDDEN/.test(
          err.message,
        ),
    );

    // 8c. TEAM_LEADER lists explanation approval inbox and sees both PENDING items
    const inboxRaw = await callAsServiceRole(
      db,
      "select public.attendance_list_explanation_approval_inbox($1::uuid, $2::uuid, 'PENDING', 20, 0) as data",
      [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
    );
    const inbox = projectAttendanceExplanationApprovalInbox(inboxRaw);
    assert.ok(inbox, "attendance_list_explanation_approval_inbox strict projection passes");
    assert.equal(inbox.pagination.total_rows, 2);
    assert.equal(inbox.pagination.pending_count, 2);

    // 8d. TEAM_LEADER approves SLOT_4 (MISSING -> EXPLAINED_APPROVED) and rejects SLOT_2 (OUT_OF_GRACE -> keeps OUT_OF_GRACE + REJECTED)
    const approveKey = nextUuid();
    const approveBody = {
      app_user_id: ACTORS.TEAM_LEADER.app,
      explanation_id: expSlot4.explanation.explanation_id,
      decision: "APPROVE",
      expected_row_version: 1,
      decision_note: "Xác nhận lịch đi tuyển dụng thực tế",
    };
    const approveFp = computeExplanationDecideRequestFingerprint(approveBody);
    const approvedRaw = await callAsServiceRole(
      db,
      `select public.attendance_decide_explanation(
        $1::uuid, $2::uuid, $3::uuid, 'APPROVE', 1, $4::text, $5::text, $6::text
      ) as data`,
      [
        ACTORS.TEAM_LEADER.auth,
        ACTORS.TEAM_LEADER.app,
        expSlot4.explanation.explanation_id,
        approveBody.decision_note,
        approveKey,
        approveFp,
      ],
    );
    const approvedRes = projectDecideAttendanceExplanationResult(approvedRaw);
    assert.ok(approvedRes);
    assert.equal(approvedRes.explanation.status, "APPROVED");
    assert.equal(approvedRes.explanation.effective_slot_status, "EXPLAINED_APPROVED");

    const rejectKey = nextUuid();
    const rejectBody = {
      app_user_id: ACTORS.TEAM_LEADER.app,
      explanation_id: expSlot2.explanation.explanation_id,
      decision: "REJECT",
      expected_row_version: 1,
      decision_note: "Không báo trước cho trưởng nhóm",
    };
    const rejectFp = computeExplanationDecideRequestFingerprint(rejectBody);
    const rejectedRaw = await callAsServiceRole(
      db,
      `select public.attendance_decide_explanation(
        $1::uuid, $2::uuid, $3::uuid, 'REJECT', 1, $4::text, $5::text, $6::text
      ) as data`,
      [
        ACTORS.TEAM_LEADER.auth,
        ACTORS.TEAM_LEADER.app,
        expSlot2.explanation.explanation_id,
        rejectBody.decision_note,
        rejectKey,
        rejectFp,
      ],
    );
    const rejectedRes = projectDecideAttendanceExplanationResult(rejectedRaw);
    assert.ok(rejectedRes);
    assert.equal(rejectedRes.explanation.status, "REJECTED");
    assert.equal(rejectedRes.explanation.effective_slot_status, "OUT_OF_GRACE");

    // 8e. Verify original attendance_checkins are completely untouched (no synthetic check-ins created)
    const { rows: checkinCountAfterRows } = await db.query(
      `select count(*)::int as cnt
         from public.attendance_checkins
        where app_user_id = $1::uuid
          and business_date = '2026-10-10'::date`,
      [ACTORS.STAFF_B.app],
    );
    assert.equal(
      checkinCountAfterRows[0].cnt,
      2,
      "Approving/rejecting explanations must never create or mutate attendance_checkins rows",
    );

    // 8f. Verify Monthly Report reflects EXPLAINED_APPROVED on SLOT_4 and REJECTED on SLOT_2
    const octMatrixAfterExp = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-10', null, $3::uuid, null, 1, 25
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, ACTORS.STAFF_B.app],
      ),
    );
    assert.ok(octMatrixAfterExp);
    const oct10After = octMatrixAfterExp.items[0].days.find(
      (d) => d.business_date === "2026-10-10",
    );
    assert.ok(oct10After);
    // SLOT_4 (index 3) is now EXPLAINED_APPROVED and no longer counted as MISSING!
    assert.equal(oct10After.slots[3].slot_code, "SLOT_4");
    assert.equal(oct10After.slots[3].slot_status, "EXPLAINED_APPROVED");
    assert.equal(oct10After.slots[3].explanation?.status, "APPROVED");
    assert.equal(oct10After.slots[3].checkins.length, 0);
    // SLOT_2 (index 1) retains OUT_OF_GRACE and carries explanation.status === "REJECTED"
    assert.equal(oct10After.slots[1].slot_code, "SLOT_2");
    assert.equal(oct10After.slots[1].slot_status, "OUT_OF_GRACE");
    assert.equal(oct10After.slots[1].explanation?.status, "REJECTED");
    // Only SLOT_3 and SLOT_5 (2 slots) remain MISSING -> missing_slot_count decreased from 3 to 2
    assert.equal(oct10After.missing_slot_count, 2);

    // 8g. Verify Employee Full Name Resolution across attendance_admin_report, attendance_monthly_matrix_report, and attendance_list_branches_admin
    const loginStaffMatchedAuth = "19100000-0000-4000-8000-000000000021";
    const loginStaffMatchedApp = "29100000-0000-4000-8000-000000000021";
    const loginStaffMatchedRecruiter = "39100000-0000-4000-8000-000000000021";
    const loginStaffUnmatchedAuth = "19100000-0000-4000-8000-000000000022";
    const loginStaffUnmatchedApp = "29100000-0000-4000-8000-000000000022";
    const singleWordNameStaffAuth = "19100000-0000-4000-8000-000000000023";
    const singleWordNameStaffApp = "29100000-0000-4000-8000-000000000023";

    await db.query(
      "insert into auth.users (id) values ($1::uuid), ($2::uuid), ($3::uuid)",
      [loginStaffMatchedAuth, loginStaffUnmatchedAuth, singleWordNameStaffAuth],
    );
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
       values
         ($1::uuid, $2::uuid, 'anhhn.td', true),
         ($3::uuid, $4::uuid, 'loginonly.td', true),
         ($5::uuid, $6::uuid, 'nam', true)`,
      [
        loginStaffMatchedApp,
        loginStaffMatchedAuth,
        loginStaffUnmatchedApp,
        loginStaffUnmatchedAuth,
        singleWordNameStaffApp,
        singleWordNameStaffAuth,
      ],
    );
    // Unambiguous active recruiter matching code 'anhhn.td' -> full name 'Nguyễn Thị Huệ' (even without verified link row)
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, active)
       values ($1::uuid, 'Nguyễn Thị Huệ', 'anhhn.td', true)`,
      [loginStaffMatchedRecruiter],
    );

    const branchesWithIdentity = projectAttendanceBranchesAdminList(
      await callAsServiceRole(
        db,
        "select public.attendance_list_branches_admin($1::uuid, $2::uuid) as data",
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
      ),
    );
    assert.ok(branchesWithIdentity);
    const matchedOpt = branchesWithIdentity.employee_options.find(
      (opt) => opt.app_user_id === loginStaffMatchedApp,
    );
    assert.ok(matchedOpt);
    assert.equal(matchedOpt.display_name, "Nguyễn Thị Huệ");
    assert.equal(matchedOpt.personnel_code, "anhhn.td");

    const unmatchedOpt = branchesWithIdentity.employee_options.find(
      (opt) => opt.app_user_id === loginStaffUnmatchedApp,
    );
    assert.ok(unmatchedOpt);
    assert.equal(unmatchedOpt.display_name, "Chưa cập nhật họ tên");
    assert.equal(unmatchedOpt.personnel_code, "loginonly.td");

    const singleWordOpt = branchesWithIdentity.employee_options.find(
      (opt) => opt.app_user_id === singleWordNameStaffApp,
    );
    assert.ok(singleWordOpt);
    assert.equal(singleWordOpt.display_name, "nam");
    assert.equal(singleWordOpt.personnel_code, null);

    const matrixMatched = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-10', null, $3::uuid, null, 1, 25
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, loginStaffMatchedApp],
      ),
    );
    assert.ok(matrixMatched);
    assert.equal(matrixMatched.items[0].employee_display_name, "Nguyễn Thị Huệ");
    assert.equal(matrixMatched.items[0].personnel_code, "anhhn.td");

    const matrixUnmatched = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-10', null, $3::uuid, null, 1, 25
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, loginStaffUnmatchedApp],
      ),
    );
    assert.ok(matrixUnmatched);
    assert.equal(matrixUnmatched.items[0].employee_display_name, "Chưa cập nhật họ tên");
    assert.equal(matrixUnmatched.items[0].personnel_code, "loginonly.td");

    const matrixSingleWord = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-10', null, $3::uuid, null, 1, 25
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, singleWordNameStaffApp],
      ),
    );
    assert.ok(matrixSingleWord);
    assert.equal(matrixSingleWord.items[0].employee_display_name, "nam");
    assert.equal(matrixSingleWord.items[0].personnel_code, null);

    await recordCheckInAsServiceRole(db, {
      actor: { auth: loginStaffMatchedAuth, app: loginStaffMatchedApp },
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-10-15T01:00:00.000Z",
    });
    await recordCheckInAsServiceRole(db, {
      actor: { auth: singleWordNameStaffAuth, app: singleWordNameStaffApp },
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-10-15T01:05:00.000Z",
    });
    const adminReportIdentity = projectAttendanceAdminReport(
      await callAsServiceRole(
        db,
        `select public.attendance_admin_report(
          $1::uuid, $2::uuid, '2026-10-15'::date, '2026-10-15'::date, 1, 25, null, null
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
      ),
    );
    assert.ok(adminReportIdentity);
    const matchedDetailRow = adminReportIdentity.items.find(
      (item) => item.employee_display_name === "Nguyễn Thị Huệ",
    );
    assert.ok(matchedDetailRow);
    assert.equal(matchedDetailRow.personnel_code, "anhhn.td");
    const singleWordDetailRow = adminReportIdentity.items.find(
      (item) => item.employee_display_name === "nam",
    );
    assert.ok(singleWordDetailRow);
    assert.equal(singleWordDetailRow.personnel_code, null);
    assert.ok(
      adminReportIdentity.employee_options.some(
        (opt) => opt.app_user_id === loginStaffMatchedApp && opt.display_name === "Nguyễn Thị Huệ",
      ),
    );
    assert.ok(
      adminReportIdentity.employee_options.some(
        (opt) => opt.app_user_id === singleWordNameStaffApp && opt.display_name === "nam",
      ),
    );

    for (const sig of ATTENDANCE_EXPLANATIONS_WAVE2_RPC_SIGNATURES) {
      const { rows } = await db.query("select to_regprocedure($1)::text as oid_name", [sig]);
      assert.ok(rows[0].oid_name, `RPC ${sig} must exist`);
    }
    assert.ok(ATTENDANCE_EXPLANATIONS_WAVE2_MIGRATION_NAME.endsWith(".sql"));

    // -------------------------------------------------------------------------
    // 9. Multi-Profile Attendance Slot Policies & Historical Employee Assignments
    // -------------------------------------------------------------------------
    for (const sig of ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_RPC_SIGNATURES) {
      const { rows } = await db.query("select to_regprocedure($1)::text as oid_name", [sig]);
      assert.ok(rows[0].oid_name, `RPC ${sig} must exist`);
    }
    assert.ok(ATTENDANCE_MULTI_SLOT_POLICY_PROFILES_MIGRATION_NAME.endsWith(".sql"));

    // 9a. Create a named 2-slot profile "Hành chính" (08:00, 17:00) and a 3-slot profile "Tuyển dụng cơ động" (08:30, 13:30, 17:30)
    const hanhChinhSlotsV1 = [
      { slot_code: "SLOT_1", slot_index: 1, slot_label: "Ca sáng", session_code: "AM", target_time: "08:00", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_code: "SLOT_2", slot_index: 2, slot_label: "Ca chiều", session_code: "PM", target_time: "17:00", grace_before_minutes: 15, grace_after_minutes: 15 },
    ];
    const hcCreateKey = nextUuid();
    const hcCreateFp = computeSlotPolicyProfileUpsertRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      profile_id: null,
      profile_code: "HANH_CHINH",
      display_name: "Hành chính",
      description: "Khung giờ 2 mốc hành chính",
      active: true,
      expected_profile_version: 0,
      effective_from_date: "2026-10-01",
      slots: hanhChinhSlotsV1,
      expected_version: 0,
    });
    const hcCreatedRaw = await callAsServiceRole(
      db,
      `select public.attendance_upsert_slot_policy_profile_admin(
        $1::uuid, $2::uuid, null, 'HANH_CHINH', 'Hành chính', 'Khung giờ 2 mốc hành chính',
        true, '2026-10-01'::date, $3::jsonb, 0, 0, $4::uuid, $5::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        JSON.stringify(hanhChinhSlotsV1),
        hcCreateKey,
        hcCreateFp,
      ],
    );
    const hcCreated = projectUpsertSlotPolicyProfileResult(hcCreatedRaw);
    assert.ok(hcCreated, "create HANH_CHINH profile strict projection passes");
    assert.equal(hcCreated.replayed, false);
    assert.equal(hcCreated.profile.profile_code, "HANH_CHINH");
    assert.equal(hcCreated.profile.display_name, "Hành chính");
    assert.equal(hcCreated.profile.is_default, false);
    assert.equal(hcCreated.policy.version, 1);
    assert.equal(hcCreated.policy.slots.length, 2);
    const hcProfileId = hcCreated.profile.profile_id;

    const tuyenDungSlotsV1 = [
      { slot_code: "SLOT_1", slot_index: 1, slot_label: "Mốc 1", session_code: "AM", target_time: "08:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_code: "SLOT_2", slot_index: 2, slot_label: "Mốc 2", session_code: "PM", target_time: "13:30", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_code: "SLOT_3", slot_index: 3, slot_label: "Mốc 3", session_code: "PM", target_time: "17:30", grace_before_minutes: 15, grace_after_minutes: 15 },
    ];
    const tdCreateKey = nextUuid();
    const tdCreateFp = computeSlotPolicyProfileUpsertRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      profile_id: null,
      profile_code: "TUYEN_DUNG_3",
      display_name: "Tuyển dụng cơ động",
      description: "Khung giờ 3 mốc tuyển dụng",
      active: true,
      expected_profile_version: 0,
      effective_from_date: "2026-10-01",
      slots: tuyenDungSlotsV1,
      expected_version: 0,
    });
    const tdCreated = projectUpsertSlotPolicyProfileResult(
      await callAsServiceRole(
        db,
        `select public.attendance_upsert_slot_policy_profile_admin(
          $1::uuid, $2::uuid, null, 'TUYEN_DUNG_3', 'Tuyển dụng cơ động', 'Khung giờ 3 mốc tuyển dụng',
          true, '2026-10-01'::date, $3::jsonb, 0, 0, $4::uuid, $5::text
        ) as data`,
        [
          ACTORS.FULL_ADMIN.auth,
          ACTORS.FULL_ADMIN.app,
          JSON.stringify(tuyenDungSlotsV1),
          tdCreateKey,
          tdCreateFp,
        ],
      ),
    );
    assert.ok(tdCreated);
    const tdProfileId = tdCreated.profile.profile_id;

    // 9b. Add a date-effective version v2 (08:15, 17:15) to HANH_CHINH starting 2026-12-08 without affecting Default or TUYEN_DUNG_3
    const hanhChinhSlotsV2 = [
      { slot_code: "SLOT_1", slot_index: 1, slot_label: "Ca sáng", session_code: "AM", target_time: "08:15", grace_before_minutes: 15, grace_after_minutes: 15 },
      { slot_code: "SLOT_2", slot_index: 2, slot_label: "Ca chiều", session_code: "PM", target_time: "17:15", grace_before_minutes: 15, grace_after_minutes: 15 },
    ];
    const hcV2Key = nextUuid();
    const hcV2Fp = computeSlotPolicyProfileUpsertRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      profile_id: hcProfileId,
      profile_code: "HANH_CHINH",
      display_name: "Hành chính",
      description: "Khung giờ 2 mốc hành chính",
      active: true,
      expected_profile_version: 1,
      effective_from_date: "2026-12-08",
      slots: hanhChinhSlotsV2,
      expected_version: 1,
    });
    const hcV2Created = projectUpsertSlotPolicyProfileResult(
      await callAsServiceRole(
        db,
        `select public.attendance_upsert_slot_policy_profile_admin(
          $1::uuid, $2::uuid, $3::uuid, 'HANH_CHINH', 'Hành chính', 'Khung giờ 2 mốc hành chính',
          true, '2026-12-08'::date, $4::jsonb, 1, 1, $5::uuid, $6::text
        ) as data`,
        [
          ACTORS.FULL_ADMIN.auth,
          ACTORS.FULL_ADMIN.app,
          hcProfileId,
          JSON.stringify(hanhChinhSlotsV2),
          hcV2Key,
          hcV2Fp,
        ],
      ),
    );
    assert.ok(hcV2Created);
    assert.equal(hcV2Created.policy.profile_id, hcProfileId);
    assert.equal(hcV2Created.policy.version, 2);
    assert.equal(hcV2Created.profile.version, 2);
    assert.deepEqual(
      hcV2Created.policy.slots.map((s) => s.target_time),
      ["08:15", "17:15"],
    );

    // 9b-divergent. Regression test for divergent profile.version vs latest_policy.version:
    // Simulate a profile at profile.version = 1 while its latest slot policy (v2 starting 2026-12-08) is at version = 3.
    // After two new saves, profile.version = 3 and latest_policy.version = 5.
    // A delayed/stale save request carrying expected_version = 3 (matching profile.version = 3, but stale vs latest_policy.version = 5)
    // and an effective_from_date after the latest policy MUST be rejected with ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT (PT409).
    await db.query(
      "update public.attendance_slot_policy_profiles set version = 1 where profile_id = $1::uuid",
      [hcProfileId],
    );
    await db.query(
      "alter table public.attendance_slot_policy_versions disable trigger attendance_slot_policy_versions_immutable_tg",
    );
    await db.query(
      "update public.attendance_slot_policy_versions set version = 3 where profile_id = $1::uuid and version = 2",
      [hcProfileId],
    );
    await db.query(
      "alter table public.attendance_slot_policy_versions enable trigger attendance_slot_policy_versions_immutable_tg",
    );

    // Save 1 on divergent HC profile: expected_profile_version = 1, expected_version = 3 -> profile.version becomes 2, policy.version becomes 4
    const hcSave1Key = nextUuid();
    const hcSave1Fp = computeSlotPolicyProfileUpsertRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      profile_id: hcProfileId,
      profile_code: "HANH_CHINH",
      display_name: "Hành chính",
      description: "Khung giờ 2 mốc hành chính",
      active: true,
      expected_profile_version: 1,
      effective_from_date: "2026-12-10",
      slots: hanhChinhSlotsV2,
      expected_version: 3,
    });
    const hcSave1 = projectUpsertSlotPolicyProfileResult(
      await callAsServiceRole(
        db,
        `select public.attendance_upsert_slot_policy_profile_admin(
          $1::uuid, $2::uuid, $3::uuid, 'HANH_CHINH', 'Hành chính', 'Khung giờ 2 mốc hành chính',
          true, '2026-12-10'::date, $4::jsonb, 3, 1, $5::uuid, $6::text
        ) as data`,
        [
          ACTORS.FULL_ADMIN.auth,
          ACTORS.FULL_ADMIN.app,
          hcProfileId,
          JSON.stringify(hanhChinhSlotsV2),
          hcSave1Key,
          hcSave1Fp,
        ],
      ),
    );
    assert.ok(hcSave1);
    assert.equal(hcSave1.profile.version, 2);
    assert.equal(hcSave1.policy.version, 4);

    // Save 2 on divergent HC profile: expected_profile_version = 2, expected_version = 4 -> profile.version becomes 3, policy.version becomes 5
    const hcSave2Key = nextUuid();
    const hcSave2Fp = computeSlotPolicyProfileUpsertRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      profile_id: hcProfileId,
      profile_code: "HANH_CHINH",
      display_name: "Hành chính",
      description: "Khung giờ 2 mốc hành chính",
      active: true,
      expected_profile_version: 2,
      effective_from_date: "2026-12-15",
      slots: hanhChinhSlotsV2,
      expected_version: 4,
    });
    const hcSave2 = projectUpsertSlotPolicyProfileResult(
      await callAsServiceRole(
        db,
        `select public.attendance_upsert_slot_policy_profile_admin(
          $1::uuid, $2::uuid, $3::uuid, 'HANH_CHINH', 'Hành chính', 'Khung giờ 2 mốc hành chính',
          true, '2026-12-15'::date, $4::jsonb, 4, 2, $5::uuid, $6::text
        ) as data`,
        [
          ACTORS.FULL_ADMIN.auth,
          ACTORS.FULL_ADMIN.app,
          hcProfileId,
          JSON.stringify(hanhChinhSlotsV2),
          hcSave2Key,
          hcSave2Fp,
        ],
      ),
    );
    assert.ok(hcSave2);
    assert.equal(hcSave2.profile.version, 3);
    assert.equal(hcSave2.policy.version, 5);

    // Delayed/stale save request with expected_version = 3 (matches current profile.version = 3, but stale vs policy.version = 5)
    // and effective_from_date = 2026-12-20 (after latest policy 2026-12-15) MUST be rejected!
    for (const [stalePolicyVer, staleProfVer] of [
      [3, 1],
      [3, 3],
      [5, 1],
      [4, 3],
    ]) {
      await assert.rejects(
        () =>
          callAsServiceRole(
            db,
            `select public.attendance_upsert_slot_policy_profile_admin(
              $1::uuid, $2::uuid, $3::uuid, 'HANH_CHINH', 'Hành chính', 'Khung giờ 2 mốc hành chính',
              true, '2026-12-20'::date, $4::jsonb, $5::integer, $6::integer, $7::uuid, $8::text
            ) as data`,
            [
              ACTORS.FULL_ADMIN.auth,
              ACTORS.FULL_ADMIN.app,
              hcProfileId,
              JSON.stringify(hanhChinhSlotsV2),
              stalePolicyVer,
              staleProfVer,
              nextUuid(),
              "c".repeat(64),
            ],
          ),
        (err) => /ATTENDANCE_SLOT_POLICY_VERSION_CONFLICT/.test(err.message),
      );
    }

    // 9c. Reject future assignment dates (> today_vn), past assignment dates (< today_vn), Default profile assignment, and wrong assignment expected_version
    const { rows: todayVnRows } = await db.query(
      "select pg_catalog.to_char((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') as today_vn",
    );
    const todayVn = todayVnRows[0].today_vn;

    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_assign_employee_slot_policy_admin(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2099-01-01'::date, 0, $5::uuid, $6::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            ACTORS.STAFF_A.app,
            hcProfileId,
            nextUuid(),
            "7".repeat(64),
          ],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE/.test(err.message),
    );
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_assign_employee_slot_policy_admin(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-10-05'::date, 0, $5::uuid, $6::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            ACTORS.STAFF_A.app,
            hcProfileId,
            nextUuid(),
            "6".repeat(64),
          ],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_ASSIGNMENT_PAST_DATE/.test(err.message),
    );
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_assign_employee_slot_policy_admin(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 0, $5::uuid, $6::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            ACTORS.STAFF_A.app,
            DEFAULT_ATTENDANCE_SLOT_POLICY_PROFILE_ID,
            nextUuid(),
            "8".repeat(64),
          ],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_DEFAULT_ASSIGNMENT_REDUNDANT/.test(err.message),
    );

    // Reject assignment when employee has no open assignment (expected_version must be 0, NOT profile.version = 2)
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_assign_employee_slot_policy_admin(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 2, $5::uuid, $6::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            ACTORS.STAFF_A.app,
            hcProfileId,
            nextUuid(),
            "3".repeat(64),
          ],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT/.test(err.message),
    );

    // 9d. Live immediate-effect assign (todayVn / null, expected_version = 0 since unassigned), switch on same day, and unassign on todayVn
    const assignHcKey = nextUuid();
    const assignHcFp = computeSlotPolicyAssignRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      target_app_user_id: ACTORS.STAFF_A.app,
      profile_id: hcProfileId,
      valid_from: null,
      expected_version: 0,
    });
    const assignHcRes = projectAssignSlotPolicyResult(
      await callAsServiceRole(
        db,
        `select public.attendance_assign_employee_slot_policy_admin(
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, null, 0, $5::uuid, $6::text
        ) as data`,
        [
          ACTORS.FULL_ADMIN.auth,
          ACTORS.FULL_ADMIN.app,
          ACTORS.STAFF_A.app,
          hcProfileId,
          assignHcKey,
          assignHcFp,
        ],
      ),
    );
    assert.ok(assignHcRes);
    assert.equal(assignHcRes.assignment.profile_code, "HANH_CHINH");
    assert.equal(assignHcRes.assignment.valid_from, todayVn);
    assert.equal(assignHcRes.assignment.valid_to, null);
    assert.equal(assignHcRes.assignment.version, 1);

    // Reject switching STAFF_A to TUYEN_DUNG_3 when passing target profile.version (3) instead of open assignment.version (1)
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_assign_employee_slot_policy_admin(
            $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 3, $6::uuid, $7::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            ACTORS.STAFF_A.app,
            tdProfileId,
            todayVn,
            nextUuid(),
            "2".repeat(64),
          ],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT/.test(err.message),
    );

    // Reject unassign with past or future date
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_unassign_employee_slot_policy_admin(
            $1::uuid, $2::uuid, $3::uuid, '2026-10-05'::date, $4::integer, $5::uuid, $6::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            assignHcRes.assignment.assignment_id,
            assignHcRes.assignment.version,
            nextUuid(),
            "5".repeat(64),
          ],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_ASSIGNMENT_PAST_DATE/.test(err.message),
    );
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_unassign_employee_slot_policy_admin(
            $1::uuid, $2::uuid, $3::uuid, '2099-01-01'::date, $4::integer, $5::uuid, $6::text
          ) as data`,
          [
            ACTORS.FULL_ADMIN.auth,
            ACTORS.FULL_ADMIN.app,
            assignHcRes.assignment.assignment_id,
            assignHcRes.assignment.version,
            nextUuid(),
            "4".repeat(64),
          ],
        ),
      (err) => /ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE/.test(err.message),
    );

    // Switch STAFF_A to TUYEN_DUNG_3 today with open assignment.version = 1 (marks HANH_CHINH assignment as superseded_same_day = true)
    const assignTdKey = nextUuid();
    const assignTdFp = computeSlotPolicyAssignRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      target_app_user_id: ACTORS.STAFF_A.app,
      profile_id: tdProfileId,
      valid_from: todayVn,
      expected_version: assignHcRes.assignment.version,
    });
    const assignTdRes = projectAssignSlotPolicyResult(
      await callAsServiceRole(
        db,
        `select public.attendance_assign_employee_slot_policy_admin(
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::integer, $7::uuid, $8::text
        ) as data`,
        [
          ACTORS.FULL_ADMIN.auth,
          ACTORS.FULL_ADMIN.app,
          ACTORS.STAFF_A.app,
          tdProfileId,
          todayVn,
          assignHcRes.assignment.version,
          assignTdKey,
          assignTdFp,
        ],
      ),
    );
    assert.ok(assignTdRes);
    assert.equal(assignTdRes.assignment.profile_code, "TUYEN_DUNG_3");
    assert.equal(assignTdRes.assignment.valid_from, todayVn);

    // Unassign STAFF_A today so today returns to Default (5 slots)
    const unassignTdKey = nextUuid();
    const unassignTdFp = computeSlotPolicyUnassignRequestFingerprint({
      app_user_id: ACTORS.FULL_ADMIN.app,
      assignment_id: assignTdRes.assignment.assignment_id,
      valid_to: todayVn,
      expected_version: assignTdRes.assignment.version,
    });
    const unassignTdRes = projectUnassignSlotPolicyResult(
      await callAsServiceRole(
        db,
        `select public.attendance_unassign_employee_slot_policy_admin(
          $1::uuid, $2::uuid, $3::uuid, $4::date, $5::integer, $6::uuid, $7::text
        ) as data`,
        [
          ACTORS.FULL_ADMIN.auth,
          ACTORS.FULL_ADMIN.app,
          assignTdRes.assignment.assignment_id,
          todayVn,
          assignTdRes.assignment.version,
          unassignTdKey,
          unassignTdFp,
        ],
      ),
    );
    assert.ok(unassignTdRes);
    assert.equal(unassignTdRes.assignment.valid_to, todayVn);
    assert.equal(unassignTdRes.assignment.superseded_same_day, true);
    assert.equal(unassignTdRes.assignment.effective, false);

    // Seed historical October 2026 assignment intervals for STAFF_A (2026-10-05..11 on HANH_CHINH, 2026-10-12..19 on TUYEN_DUNG_3)
    // to verify historical multi-profile retention across past months while RPCs enforce immediate-effect todayVn
    await db.query(
      `insert into public.attendance_slot_policy_assignments (
        app_user_id, profile_id, valid_from, valid_to, superseded_same_day, version,
        assigned_by_user_id, revoked_by_user_id, revoked_at, idempotency_key, request_fingerprint
      ) values
      ($1::uuid, $2::uuid, '2026-10-05'::date, '2026-10-11'::date, false, 2, $4::uuid, $4::uuid, clock_timestamp(), $5::uuid, $6::text),
      ($1::uuid, $3::uuid, '2026-10-12'::date, '2026-10-19'::date, false, 2, $4::uuid, $4::uuid, clock_timestamp(), $7::uuid, $8::text)`,
      [
        ACTORS.STAFF_A.app,
        hcProfileId,
        tdProfileId,
        ACTORS.FULL_ADMIN.app,
        nextUuid(),
        "a".repeat(64),
        nextUuid(),
        "b".repeat(64),
      ],
    );

    // 9e. Record check-in for STAFF_A on 2026-10-06 at 08:05 VN (01:05 UTC)
    // Under Default (07:30 ±15m), 08:05 would be LATE (+35m), but under HANH_CHINH v1 (08:00 ±15m), 08:05 is ON_TIME!
    await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_A,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-10-06T01:05:00.000Z",
    });

    // Verify October 2026 Monthly Matrix Report for STAFF_A preserves historical profiles & versions per day
    const staffAOctMatrix = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-10', null, $3::uuid, null, 1, 25
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, ACTORS.STAFF_A.app],
      ),
    );
    assert.ok(staffAOctMatrix);
    const staffAOctRow = staffAOctMatrix.items[0];
    assert.ok(staffAOctRow);

    // 2026-10-02 (before assignment): Default v1 (5 slots), NO_CHECKIN -> 5 missing slots
    const oct02 = staffAOctRow.days.find((d) => d.business_date === "2026-10-02");
    assert.ok(oct02);
    assert.equal(oct02.policy_profile_code_used, "DEFAULT");
    assert.equal(oct02.policy_profile_name_used, "Mặc định");
    assert.equal(oct02.policy_version_used, 1);
    assert.equal(oct02.slots.length, 5);
    assert.equal(oct02.missing_slot_count, 5);

    // 2026-10-06 (assigned to HANH_CHINH, v1: 08:00 & 17:00): SLOT_1 is ON_TIME (08:05), SLOT_2 is MISSING -> 1 missing slot
    const oct06 = staffAOctRow.days.find((d) => d.business_date === "2026-10-06");
    assert.ok(oct06);
    assert.equal(oct06.policy_profile_id_used, hcProfileId);
    assert.equal(oct06.policy_profile_code_used, "HANH_CHINH");
    assert.equal(oct06.policy_profile_name_used, "Hành chính");
    assert.equal(oct06.policy_version_used, 1);
    assert.equal(oct06.slots.length, 2);
    assert.equal(oct06.slots[0].target_time, "08:00");
    assert.equal(oct06.slots[0].slot_status, "ON_TIME");
    assert.equal(oct06.slots[1].target_time, "17:00");
    assert.equal(oct06.slots[1].slot_status, "MISSING");
    assert.equal(oct06.missing_slot_count, 1);

    // 2026-10-09 (still assigned to HANH_CHINH, v1: 08:00 & 17:00 since v2 starts 2026-12-08, zero check-ins): 2 missing slots
    const oct09 = staffAOctRow.days.find((d) => d.business_date === "2026-10-09");
    assert.ok(oct09);
    assert.equal(oct09.policy_profile_code_used, "HANH_CHINH");
    assert.equal(oct09.policy_version_used, 1);
    assert.equal(oct09.slots.length, 2);
    assert.equal(oct09.slots[0].target_time, "08:00");
    assert.equal(oct09.slots[1].target_time, "17:00");
    assert.equal(oct09.missing_slot_count, 2);

    // 2026-10-15 (assigned to TUYEN_DUNG_3 v1: 08:30, 13:30, 17:30, zero check-ins): 3 missing slots
    const oct15 = staffAOctRow.days.find((d) => d.business_date === "2026-10-15");
    assert.ok(oct15);
    assert.equal(oct15.policy_profile_code_used, "TUYEN_DUNG_3");
    assert.equal(oct15.policy_profile_name_used, "Tuyển dụng cơ động");
    assert.equal(oct15.policy_version_used, 1);
    assert.equal(oct15.slots.length, 3);
    assert.equal(oct15.missing_slot_count, 3);

    // 2026-10-22 (after unassign on 2026-10-20 -> reverted to Default v1: 5 slots, zero check-ins): 5 missing slots
    const oct22 = staffAOctRow.days.find((d) => d.business_date === "2026-10-22");
    assert.ok(oct22);
    assert.equal(oct22.policy_profile_code_used, "DEFAULT");
    assert.equal(oct22.policy_profile_name_used, "Mặc định");
    assert.equal(oct22.slots.length, 5);
    assert.equal(oct22.missing_slot_count, 5);

    // 9f. Verify Wave 2 Attendance Explanations for STAFF_A on 2026-10-06 use HANH_CHINH v1 (2 slots)
    const staffAOverview = projectMyAttendanceExplanationsOverview(
      await callAsServiceRole(
        db,
        "select public.attendance_get_my_explanations_overview($1::uuid, $2::uuid, '2026-10-06'::date) as data",
        [ACTORS.STAFF_A.auth, ACTORS.STAFF_A.app],
      ),
    );
    assert.ok(staffAOverview);
    assert.equal(staffAOverview.day_evaluation.policy_profile_code_used, "HANH_CHINH");
    assert.equal(staffAOverview.day_evaluation.policy_profile_name_used, "Hành chính");
    assert.equal(staffAOverview.day_evaluation.policy_version_used, 1);
    assert.equal(staffAOverview.day_evaluation.slots.length, 2);
    assert.equal(staffAOverview.day_evaluation.slots[0].eligible_for_explanation, false); // SLOT_1 is ON_TIME
    assert.equal(staffAOverview.day_evaluation.slots[1].eligible_for_explanation, true); // SLOT_2 is MISSING

    // Submitting SLOT_3 on 2026-10-06 (which does not exist in 2-slot HANH_CHINH) is rejected
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_submit_explanation(
            $1::uuid, $2::uuid, '2026-10-06'::date, 'SLOT_3', 'Mốc không tồn tại trong cấu hình 2 mốc', $3::text, $4::text
          ) as data`,
          [ACTORS.STAFF_A.auth, ACTORS.STAFF_A.app, nextUuid(), "9".repeat(64)],
        ),
      (err) => /ATTENDANCE_EXPLANATION_SLOT_INVALID/.test(err.message),
    );

    // Submitting SLOT_2 on 2026-10-06 succeeds and snapshots HANH_CHINH v1
    const expHcBody = {
      app_user_id: ACTORS.STAFF_A.app,
      business_date: "2026-10-06",
      slot_code: "SLOT_2",
      reason: "Họp bàn giao hồ sơ tại chi nhánh đến cuối giờ chiều",
    };
    const expHcSub = projectSubmitAttendanceExplanationResult(
      await callAsServiceRole(
        db,
        `select public.attendance_submit_explanation(
          $1::uuid, $2::uuid, '2026-10-06'::date, 'SLOT_2', $3::text, $4::text, $5::text
        ) as data`,
        [
          ACTORS.STAFF_A.auth,
          ACTORS.STAFF_A.app,
          expHcBody.reason,
          nextUuid(),
          computeExplanationSubmitRequestFingerprint(expHcBody),
        ],
      ),
    );
    assert.ok(expHcSub);
    assert.equal(expHcSub.explanation.policy_profile_id_used, hcProfileId);
    assert.equal(expHcSub.explanation.policy_profile_code_used, "HANH_CHINH");
    assert.equal(expHcSub.explanation.policy_profile_name_used, "Hành chính");
    assert.equal(expHcSub.explanation.policy_version_used, 1);
    assert.equal(expHcSub.explanation.slot_label, "Ca chiều");
    assert.equal(expHcSub.explanation.target_time, "17:00");

    // 9g. Verify 1-char slot policy profile code ("A") and page_size=25 vs page_size=100 parity
    const oneCharSlots = [
      {
        slot_code: "SLOT_1",
        slot_order: 1,
        slot_label: "Ca A sáng",
        target_time: "08:00",
        grace_before_minutes: 30,
        grace_after_minutes: 15,
      },
    ];
    const oneCharBody = {
      app_user_id: ACTORS.FULL_ADMIN.app,
      profile_id: null,
      profile_code: "A",
      display_name: "Khung giờ A",
      description: "Khung giờ mã 1 ký tự",
      active: true,
      expected_profile_version: 0,
      effective_from_date: todayVn,
      slots: oneCharSlots,
      expected_version: 0,
    };
    const oneCharCreated = projectUpsertSlotPolicyProfileResult(
      await callAsServiceRole(
        db,
        `select public.attendance_upsert_slot_policy_profile_admin(
          $1::uuid, $2::uuid, null::uuid, $3::text, $4::text, $5::text, $6::boolean,
          $7::date, $8::jsonb, $9::integer, $10::integer, $11::uuid, $12::text
        ) as data`,
        [
          ACTORS.FULL_ADMIN.auth,
          ACTORS.FULL_ADMIN.app,
          oneCharBody.profile_code,
          oneCharBody.display_name,
          oneCharBody.description,
          oneCharBody.active,
          oneCharBody.effective_from_date,
          JSON.stringify(oneCharBody.slots),
          oneCharBody.expected_version,
          oneCharBody.expected_profile_version,
          nextUuid(),
          computeSlotPolicyProfileUpsertRequestFingerprint(oneCharBody),
        ],
      ),
    );
    assert.ok(oneCharCreated);
    assert.equal(oneCharCreated.profile.profile_code, "A");

    const assignOneCharBody = {
      app_user_id: ACTORS.FULL_ADMIN.app,
      target_app_user_id: ACTORS.STAFF_B.app,
      profile_id: oneCharCreated.profile.profile_id,
      valid_from: todayVn,
      expected_version: 0,
    };
    const assignedOneChar = projectAssignSlotPolicyResult(
      await callAsServiceRole(
        db,
        `select public.attendance_assign_employee_slot_policy_admin(
          $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::integer, $7::uuid, $8::text
        ) as data`,
        [
          ACTORS.FULL_ADMIN.auth,
          ACTORS.FULL_ADMIN.app,
          assignOneCharBody.target_app_user_id,
          assignOneCharBody.profile_id,
          assignOneCharBody.valid_from,
          assignOneCharBody.expected_version,
          nextUuid(),
          computeSlotPolicyAssignRequestFingerprint(assignOneCharBody),
        ],
      ),
    );
    assert.ok(assignedOneChar);

    const currentYearMonth = todayVn.slice(0, 7);
    const curReport25 = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, $3::text, null, null, null, 1, 25
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, currentYearMonth],
      ),
    );
    const curReport100 = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, $3::text, null, null, null, 1, 100
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, currentYearMonth],
      ),
    );
    assert.ok(curReport25);
    assert.ok(curReport100);
    assert.equal(
      curReport25.pagination.snapshot_token,
      curReport100.pagination.snapshot_token,
    );
    assert.deepEqual(curReport25.items, curReport100.items);
    const staffBCur = curReport100.items.find((r) => r.app_user_id === ACTORS.STAFF_B.app);
    assert.ok(staffBCur);
    const staffBToday = staffBCur.days.find((d) => d.business_date === todayVn);
    assert.ok(staffBToday);
    assert.equal(staffBToday.policy_profile_code_used, "A");

    // -------------------------------------------------------------------------
    // 10. Team Leader Monthly Matrix Scope, Branch Options Isolation, Admin RPC Denial & Revocation
    // -------------------------------------------------------------------------
    const TEAM_BETA = "32000000-0000-4000-8000-0000000000b2";
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'MAT_BETA', 'Nhóm Tuyển Dụng Beta', true)`,
      [TEAM_BETA],
    );
    // Ensure TEAM_LEADER has active hrp provider membership + TEAM_ALPHA membership (already linked + leader-assigned in section 8)
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2026-01-01', true)
       on conflict do nothing`,
      [teamLeaderRecruiterId],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, '2026-01-01', true)
       on conflict do nothing`,
      [teamLeaderRecruiterId, TEAM_ALPHA],
    );
    // Move STAFF_B to TEAM_BETA so STAFF_A + TEAM_LEADER are on TEAM_ALPHA and STAFF_B is on TEAM_BETA
    await db.query(
      `update public.recruiter_team_memberships
          set team_id = $2::uuid
        where recruiter_id = $1::uuid
          and is_current = true`,
      [ACTORS.STAFF_B.recruiter, TEAM_BETA],
    );

    // Create a branch for TEAM_BETA (HP_BETA_01), assign STAFF_B to it, and create an unassigned branch (CT_UNASSIGNED_01)
    const hpCreateBody = {
      app_user_id: ACTORS.FULL_ADMIN.app,
      branch_id: null,
      branch_code: "HP_BETA_01",
      display_name: "Chi nhánh Hải Phòng (Nhóm Beta)",
      address: "Ngô Quyền, Hải Phòng",
      latitude: 20.844912,
      longitude: 106.688084,
      active: true,
      expected_version: 0,
    };
    const hpCreated = projectUpsertBranchResult(
      await callAsServiceRole(
        db,
        `select public.attendance_upsert_branch_admin(
          $1::uuid, $2::uuid, null, 'HP_BETA_01', 'Chi nhánh Hải Phòng (Nhóm Beta)', 'Ngô Quyền, Hải Phòng',
          20.844912::double precision, 106.688084::double precision, true, 0, $3::uuid, $4::text
        ) as data`,
        [
          ACTORS.FULL_ADMIN.auth,
          ACTORS.FULL_ADMIN.app,
          nextUuid(),
          computeBranchUpsertRequestFingerprint(hpCreateBody),
        ],
      ),
    );
    assert.ok(hpCreated);
    const hpBetaBranchId = hpCreated.branch.branch_id;

    const assignBetaBranchBody = {
      app_user_id: ACTORS.FULL_ADMIN.app,
      target_app_user_id: ACTORS.STAFF_B.app,
      branch_id: hpBetaBranchId,
      valid_from: "2026-11-01",
      expected_version: 1,
    };
    await db.query(
      "select set_config('direct_entry.test_authorization_date', '2026-11-01', false)",
    );
    await callAsServiceRole(
      db,
      `select public.attendance_assign_employee_branch_admin(
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-11-01'::date, 1, $5::uuid, $6::text
      ) as data`,
      [
        ACTORS.FULL_ADMIN.auth,
        ACTORS.FULL_ADMIN.app,
        ACTORS.STAFF_B.app,
        hpBetaBranchId,
        nextUuid(),
        computeBranchAssignRequestFingerprint(assignBetaBranchBody),
      ],
    );
    await db.query(
      "select set_config('direct_entry.test_authorization_date', '', false)",
    );

    const ctCreateBody = {
      app_user_id: ACTORS.FULL_ADMIN.app,
      branch_id: null,
      branch_code: "CT_UNASSIGNED_01",
      display_name: "Chi nhánh Cần Thơ (Không gắn nhân sự)",
      address: "Ninh Kiều, Cần Thơ",
      latitude: 10.045162,
      longitude: 105.746857,
      active: true,
      expected_version: 0,
    };
    const ctCreated = projectUpsertBranchResult(
      await callAsServiceRole(
        db,
        `select public.attendance_upsert_branch_admin(
          $1::uuid, $2::uuid, null, 'CT_UNASSIGNED_01', 'Chi nhánh Cần Thơ (Không gắn nhân sự)', 'Ninh Kiều, Cần Thơ',
          10.045162::double precision, 105.746857::double precision, true, 0, $3::uuid, $4::text
        ) as data`,
        [
          ACTORS.FULL_ADMIN.auth,
          ACTORS.FULL_ADMIN.app,
          nextUuid(),
          computeBranchUpsertRequestFingerprint(ctCreateBody),
        ],
      ),
    );
    assert.ok(ctCreated);
    const ctUnassignedBranchId = ctCreated.branch.branch_id;

    // 10a. TEAM_LEADER reads November 2026 monthly matrix: sees only TEAM_ALPHA members & TEAM_ALPHA branches, and does NOT receive global current_hq or company-wide slot_policy.profiles
    const tlNovMatrixRaw = await callAsServiceRole(
      db,
      `select public.attendance_monthly_matrix_report(
        $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 25
      ) as data`,
      [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
    );
    assert.equal(
      tlNovMatrixRaw.current_hq,
      null,
      "Raw SQL payload for Team Leader must set current_hq = null",
    );
    assert.equal(
      "profiles" in tlNovMatrixRaw.slot_policy,
      false,
      "Raw SQL payload for Team Leader must omit company-wide slot_policy.profiles",
    );
    const tlNovMatrix = projectAttendanceMonthlyMatrixReport(tlNovMatrixRaw);
    assert.ok(tlNovMatrix, "Team Leader monthly matrix report projects cleanly");
    assert.deepEqual(tlNovMatrix.viewer, {
      can_configure_hq: false,
      can_manage_branches: false,
      can_manage_slot_policy: false,
    });
    assert.equal(tlNovMatrix.current_hq, null);
    assert.equal(tlNovMatrix.slot_policy.profiles, undefined);
    assert.deepEqual(
      tlNovMatrix.slot_policy.month_policies.map((p) => p.profile_code),
      ["DEFAULT"],
      "Team Leader month_policies must include only policies actually applied to TEAM_ALPHA in 2026-11 (never unused company profiles HANH_CHINH, TUYEN_DUNG_3, or A)",
    );
    assert.equal(
      tlNovMatrix.slot_policy.month_policies.some(
        (p) =>
          p.profile_code === "HANH_CHINH" ||
          p.profile_code === "TUYEN_DUNG_3" ||
          p.profile_code === "A",
      ),
      false,
    );
    assert.ok(
      tlNovMatrix.slot_policy.month_policies.every(
        (p) => p.configured_by_display_name === "Mặc định hệ thống",
      ),
      "Team Leader slot_policy must mask global configurator display name",
    );

    const tlXlsxBytes = await buildAttendanceMonthlyMatrixXlsx({
      year_month: tlNovMatrix.filters.year_month,
      from_date: tlNovMatrix.filters.from_date,
      to_date: tlNovMatrix.filters.to_date,
      calendar_days: tlNovMatrix.calendar_days,
      items: tlNovMatrix.items,
      slot_policy: tlNovMatrix.slot_policy,
    });
    assert.ok(tlXlsxBytes.byteLength > 0, "Team Leader Excel export builds cleanly from scoped payload");
    assert.deepEqual(
      tlNovMatrix.employee_options.map((opt) => opt.app_user_id).sort(),
      [ACTORS.STAFF_A.app, ACTORS.TEAM_LEADER.app].sort(),
      "Team Leader employee_options must contain only current TEAM_ALPHA members",
    );
    assert.deepEqual(
      tlNovMatrix.items.map((item) => item.app_user_id).sort(),
      [ACTORS.STAFF_A.app, ACTORS.TEAM_LEADER.app].sort(),
      "Team Leader items must contain only current TEAM_ALPHA members",
    );
    assert.equal(tlNovMatrix.overview.total_employees, 2);
    assert.equal(tlNovMatrix.pagination.total_rows, 2);
    assert.deepEqual(
      tlNovMatrix.branch_options.map((b) => b.branch_id).sort(),
      [bnBranchId, dnBranchId].sort(),
      "Team Leader branch_options must include only branches associated with TEAM_ALPHA members, never HP_BETA_01 or CT_UNASSIGNED_01",
    );
    assert.equal(
      tlNovMatrix.branch_options.some(
        (b) => b.branch_id === hpBetaBranchId || b.branch_id === ctUnassignedBranchId,
      ),
      false,
    );

    // 10b. Cross-team filter isolation on monthly matrix
    const tlSearchStaffB = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, $3::text, 1, 25
        ) as data`,
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app, ACTORS.STAFF_B.code],
      ),
    );
    assert.ok(tlSearchStaffB);
    assert.equal(tlSearchStaffB.pagination.total_rows, 0);
    assert.deepEqual(tlSearchStaffB.items, []);

    const tlFilterBetaBranch = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', $3::uuid, null, null, 1, 25
        ) as data`,
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app, hpBetaBranchId],
      ),
    );
    assert.ok(tlFilterBetaBranch);
    assert.equal(tlFilterBetaBranch.pagination.total_rows, 0);
    assert.deepEqual(tlFilterBetaBranch.items, []);

    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_monthly_matrix_report(
            $1::uuid, $2::uuid, '2026-11', null, $3::uuid, null, 1, 25
          ) as data`,
          [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app, ACTORS.STAFF_B.app],
        ),
      (err) =>
        err.code === "42501" &&
        String(err.message).includes("ATTENDANCE_REPORT_ACCESS_DENIED"),
      "Filtering monthly matrix by another team's employee_id must fail closed with 42501",
    );

    // 10c. Snapshot token stability across pages & page_size=25 vs 100 for TEAM_LEADER, and distinctness from FULL_ADMIN
    const tlPage1 = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 1
        ) as data`,
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
      ),
    );
    const tlPage2 = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 2, 1
        ) as data`,
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
      ),
    );
    const tlPage100 = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 100
        ) as data`,
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
      ),
    );
    const adminNovMatrix = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 25
        ) as data`,
        [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
      ),
    );
    const bodNovMatrix = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 25
        ) as data`,
        [ACTORS.BOD_PRIVILEGED.auth, ACTORS.BOD_PRIVILEGED.app],
      ),
    );
    assert.ok(tlPage1 && tlPage2 && tlPage100 && adminNovMatrix && bodNovMatrix);
    assert.ok(adminNovMatrix.current_hq !== null, "Full Admin receives full current_hq");
    assert.ok(
      Array.isArray(adminNovMatrix.slot_policy.profiles) &&
        adminNovMatrix.slot_policy.profiles.length >= 4,
      "Full Admin receives full company-wide slot_policy.profiles",
    );
    assert.ok(bodNovMatrix.current_hq !== null, "BoD receives full current_hq");
    assert.ok(
      Array.isArray(bodNovMatrix.slot_policy.profiles) &&
        bodNovMatrix.slot_policy.profiles.length >= 4,
      "BoD receives full company-wide slot_policy.profiles",
    );
    assert.equal(tlPage1.pagination.snapshot_token, tlPage2.pagination.snapshot_token);
    assert.equal(tlNovMatrix.pagination.snapshot_token, tlPage100.pagination.snapshot_token);
    assert.notEqual(
      tlNovMatrix.pagination.snapshot_token,
      adminNovMatrix.pagination.snapshot_token,
      "Team-scoped snapshot_token must be distinct from all-scope Full Admin snapshot_token",
    );

    // 10d. TEAM_LEADER is denied (42501) on all branch admin and slot policy admin RPCs
    for (const [label, sql, params] of [
      [
        "attendance_list_branches_admin",
        "select public.attendance_list_branches_admin($1::uuid, $2::uuid, true) as data",
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
      ],
      [
        "attendance_upsert_branch_admin",
        "select public.attendance_upsert_branch_admin($1::uuid, $2::uuid, null, 'TL_DENY', 'Deny', 'Deny', null, null, true, 0, $3::uuid, $4::text) as data",
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app, nextUuid(), "a".repeat(64)],
      ],
      [
        "attendance_assign_employee_branch_admin",
        "select public.attendance_assign_employee_branch_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-11-01'::date, 1, $5::uuid, $6::text) as data",
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app, ACTORS.STAFF_A.app, bnBranchId, nextUuid(), "b".repeat(64)],
      ],
      [
        "attendance_unassign_employee_branch_admin",
        "select public.attendance_unassign_employee_branch_admin($1::uuid, $2::uuid, $3::uuid, '2026-11-20'::date, 1, $4::uuid, $5::text) as data",
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app, nextUuid(), nextUuid(), "c".repeat(64)],
      ],
      [
        "attendance_get_slot_policies_admin",
        "select public.attendance_get_slot_policies_admin($1::uuid, $2::uuid) as data",
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
      ],
      [
        "attendance_create_slot_policy_admin",
        "select public.attendance_create_slot_policy_admin($1::uuid, $2::uuid, $3::date, '[]'::jsonb, 1, $4::uuid, $5::text) as data",
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app, todayVn, nextUuid(), "d".repeat(64)],
      ],
      [
        "attendance_upsert_slot_policy_profile_admin",
        "select public.attendance_upsert_slot_policy_profile_admin($1::uuid, $2::uuid, null::uuid, 'TL_DENY', 'Deny', null, true, $3::date, '[]'::jsonb, 0, 0, $4::uuid, $5::text) as data",
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app, todayVn, nextUuid(), "e".repeat(64)],
      ],
      [
        "attendance_assign_employee_slot_policy_admin",
        "select public.attendance_assign_employee_slot_policy_admin($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, 0, $6::uuid, $7::text) as data",
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app, ACTORS.STAFF_A.app, hcProfileId, todayVn, nextUuid(), "f".repeat(64)],
      ],
      [
        "attendance_unassign_employee_slot_policy_admin",
        "select public.attendance_unassign_employee_slot_policy_admin($1::uuid, $2::uuid, $3::uuid, $4::date, 1, $5::uuid, $6::text) as data",
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app, nextUuid(), todayVn, nextUuid(), "0".repeat(64)],
      ],
    ]) {
      await assert.rejects(
        () => callAsServiceRole(db, sql, params),
        (err) => err.code === "42501",
        `Team Leader must be denied 42501 on ${label}`,
      );
    }

    // 10e. Immediate revocation when STAFF_A transfers to TEAM_BETA, or when leader assignment / scope / report capability is revoked
    await db.query(
      `update public.recruiter_team_memberships
          set team_id = $2::uuid
        where recruiter_id = $1::uuid
          and is_current = true`,
      [ACTORS.STAFF_A.recruiter, TEAM_BETA],
    );
    const tlAfterStaffATransfer = projectAttendanceMonthlyMatrixReport(
      await callAsServiceRole(
        db,
        `select public.attendance_monthly_matrix_report(
          $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 25
        ) as data`,
        [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
      ),
    );
    assert.ok(tlAfterStaffATransfer);
    assert.deepEqual(
      tlAfterStaffATransfer.items.map((item) => item.app_user_id),
      [ACTORS.TEAM_LEADER.app],
    );
    assert.deepEqual(tlAfterStaffATransfer.branch_options, []);

    await db.query(
      `update public.direct_entry_team_leader_assignments
          set is_current = false
        where leader_app_user_id = $1::uuid`,
      [ACTORS.TEAM_LEADER.app],
    );
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_monthly_matrix_report(
            $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 25
          ) as data`,
          [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
        ),
      (err) =>
        err.code === "42501" &&
        String(err.message).includes("ATTENDANCE_REPORT_ACCESS_DENIED"),
    );
    await db.query(
      `update public.direct_entry_team_leader_assignments
          set is_current = true
        where leader_app_user_id = $1::uuid`,
      [ACTORS.TEAM_LEADER.app],
    );

    await db.query(
      `update public.direct_entry_scope_grants
          set valid_to = '2026-01-02',
              is_current = false
        where app_user_id = $1::uuid`,
      [ACTORS.TEAM_LEADER.app],
    );
    await assert.rejects(
      () =>
        callAsServiceRole(
          db,
          `select public.attendance_monthly_matrix_report(
            $1::uuid, $2::uuid, '2026-11', null, null, null, 1, 25
          ) as data`,
          [ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app],
        ),
      (err) =>
        err.code === "42501" &&
        String(err.message).includes("ATTENDANCE_REPORT_ACCESS_DENIED"),
    );
  } finally {
    await db.close();
  }
});
