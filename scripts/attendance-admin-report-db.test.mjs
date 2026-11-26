/**
 * Attendance Admin Report & HQ Location — PGlite Behavioral, Authorization Matrix,
 * Historical HQ Revision Distance, Timezone Filtering, Pagination & ACL Test Suite.
 *
 * Verifies against the full repository migration stack in PGlite:
 *   1. Migration rollback atomicity, checksum stability, Forced RLS, table/helper/RPC ACLs,
 *      and append-only immutability trigger on `public.attendance_hq_location_revisions`.
 *   2. Full SQL authorization matrix on `public.attendance_admin_report` and
 *      `public.attendance_set_hq_location`, including live grant/account revocation.
 *   3. HQ coordinate validation, optimistic concurrency (`expected_version`), idempotent replay,
 *      and same-key different-payload conflict (`23505 IDEMPOTENCY_CONFLICT`).
 *   4. Deterministic point-in-time distance calculation across multiple HQ revisions:
 *      - Pre-HQ check-in stays `HQ_NOT_CONFIGURED` even after HQ v1 and v2 are configured.
 *      - Check-ins during HQ v1 retain exact v1 Haversine distances and `hq_version_used = 1`
 *        after Admin updates HQ to v2 (~1,140 km away).
 *      - Offline delayed `SERVER_ANCHORED` (`time_verified = true`) check-in captured during v1
 *        and synced after v2 binds to `captured_at` (`hq_version_used = 1`).
 *      - `DEVICE_CLOCK_UNVERIFIED` (`time_verified = false`) check-in with device clock backdated
 *        during v1 and synced after v2 binds to `received_at` (`hq_version_used = 2`).
 *      - Degraded GPS (`accuracy_meters > 100000`) reports `INVALID_GPS` with null coordinates/distance.
 *   5. `Asia/Ho_Chi_Minh` business-date boundary filtering, `personnel_code` + `display_name`
 *      wildcard-safe search, server pagination with invariant overview aggregates, and strict
 *      projection safety (no `photo_storage_key`, `app_user_id`, or `auth_subject` leakage).
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  ATTENDANCE_PHOTO_MIME_TYPE,
  computeAttendanceRequestFingerprint,
} from "../src/lib/attendance/attendance-contract.ts";
import { computeHqLocationRequestFingerprint } from "../src/lib/attendance/attendance-report-api.ts";
import { projectAttendanceAdminReport } from "../src/lib/attendance/attendance-report-contract.ts";
import {
  ATTENDANCE_ADMIN_REPORT_MIGRATION_NAME,
  ATTENDANCE_ADMIN_REPORT_RPC_SIGNATURES,
  ATTENDANCE_SELF_HISTORY_MIGRATION_NAME,
  ATTENDANCE_SELF_HISTORY_RPC_SIGNATURES,
  migrationChecksum,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const TEAM_ALPHA = "98000000-0000-4000-8000-0000000000a1";

const ACTORS = {
  FULL_ADMIN: {
    auth: "18100000-0000-4000-8000-000000000001",
    app: "28100000-0000-4000-8000-000000000001",
    name: "Quản Trị Toàn Hệ Thống",
  },
  BOD_PRIVILEGED: {
    auth: "18100000-0000-4000-8000-000000000002",
    app: "28100000-0000-4000-8000-000000000002",
    name: "Ban Giám Đốc (Direct Entry)",
  },
  BOD_EXECUTIVE_REPORTS: {
    auth: "18100000-0000-4000-8000-000000000003",
    app: "28100000-0000-4000-8000-000000000003",
    name: "Ban Giám Đốc (Work Reports)",
  },
  TEAM_LEADER: {
    auth: "18100000-0000-4000-8000-000000000004",
    app: "28100000-0000-4000-8000-000000000004",
    name: "Trưởng Nhóm Alpha",
  },
  ACCOUNTING: {
    auth: "18100000-0000-4000-8000-000000000005",
    app: "28100000-0000-4000-8000-000000000005",
    name: "Kế Toán Danh Mục",
  },
  PROJECT_ADMIN: {
    auth: "18100000-0000-4000-8000-000000000006",
    app: "28100000-0000-4000-8000-000000000006",
    name: "Quản Trị Dự Án",
  },
  FORM_ADMIN: {
    auth: "18100000-0000-4000-8000-000000000007",
    app: "28100000-0000-4000-8000-000000000007",
    name: "Quản Trị Biểu Mẫu",
  },
  ANALYTICS_ONLY: {
    auth: "18100000-0000-4000-8000-000000000008",
    app: "28100000-0000-4000-8000-000000000008",
    name: "Chỉ Xem Tổng Hợp KPI",
  },
  REPORT_VIEW_ONLY: {
    auth: "18100000-0000-4000-8000-000000000009",
    app: "28100000-0000-4000-8000-000000000009",
    name: "Chỉ Đọc Bài Nộp Lẻ",
  },
  REVIEWER: {
    auth: "18100000-0000-4000-8000-000000000010",
    app: "28100000-0000-4000-8000-000000000010",
    name: "Người Duyệt Thay Đổi",
  },
  STAFF_A: {
    auth: "18100000-0000-4000-8000-000000000011",
    app: "28100000-0000-4000-8000-000000000011",
    recruiter: "38100000-0000-4000-8000-000000000011",
    code: "NV_ATT_01",
    name: "Nhân Viên 100% _Alpha",
  },
  STAFF_B: {
    auth: "18100000-0000-4000-8000-000000000012",
    app: "28100000-0000-4000-8000-000000000012",
    recruiter: "38100000-0000-4000-8000-000000000012",
    code: "NV_ATT_02",
    name: "Nhân Viên 1000 Beta",
  },
  ADMIN_TRIPLE_TEAM_ONLY: {
    auth: "18100000-0000-4000-8000-000000000013",
    app: "28100000-0000-4000-8000-000000000013",
    name: "Admin Triple Nhưng Scope Team",
  },
  BOD_PRIVILEGED_TEAM_ONLY: {
    auth: "18100000-0000-4000-8000-000000000014",
    app: "28100000-0000-4000-8000-000000000014",
    name: "BoD Token Nhưng Scope Team",
  },
  DISABLED_ADMIN: {
    auth: "18100000-0000-4000-8000-000000000015",
    app: "28100000-0000-4000-8000-000000000015",
    name: "Admin Đã Bị Vô Hiệu Hóa",
  },
};

const PHOTO_SHA = "a".repeat(64);
const TOKEN_DIGEST = "b".repeat(64);

const HQ_HANOI = { latitude: 21.028511, longitude: 105.804817 };
const HQ_HCMC = { latitude: 10.776889, longitude: 106.700806 };

let uuidSeq = 0;
function nextUuid() {
  uuidSeq += 1;
  return `f8100000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function createDatabase({ stopBeforeTarget = false, targetMigrationName = ATTENDANCE_ADMIN_REPORT_MIGRATION_NAME } = {}) {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrations();
  const targetIndex = migrations.findIndex(
    (m) => m.name === targetMigrationName,
  );
  assert.ok(targetIndex >= 0, "Attendance Admin Report migration must exist");
  const slice = stopBeforeTarget ? migrations.slice(0, targetIndex) : migrations;
  for (const m of slice) {
    await db.exec(m.sql);
  }
  return { db, migrations, targetMigration: migrations[targetIndex] };
}

async function seedRoleMatrixActors(db) {
  await db.query(
    `insert into public.teams (team_id, code, display_name, active)
     values ($1::uuid, 'ATT_ALPHA', 'Nhóm Chấm Công Alpha', true)`,
    [TEAM_ALPHA],
  );

  for (const actor of Object.values(ACTORS)) {
    await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
       values ($1::uuid, $2::uuid, $3, $4)`,
      [actor.app, actor.auth, actor.name, actor !== ACTORS.DISABLED_ADMIN],
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

  // Allowed readers
  for (const admin of [ACTORS.FULL_ADMIN, ACTORS.DISABLED_ADMIN]) {
    await grantCaps(admin, ["entry_admin", "recruiter_master_manage", "team_master_manage"]);
    await grantScope(admin, "all");
  }
  await grantCaps(ACTORS.BOD_PRIVILEGED, ["entry_privileged_edit"]);
  await grantScope(ACTORS.BOD_PRIVILEGED, "all");

  await grantCaps(ACTORS.BOD_EXECUTIVE_REPORTS, ["report_analytics_view", "report_view"]);
  await grantScope(ACTORS.BOD_EXECUTIVE_REPORTS, "all");

  // Denied roles
  await grantCaps(ACTORS.TEAM_LEADER, [
    "team_manager_assign",
    "report_view",
    "report_analytics_view",
    "report_assign",
    "report_review",
  ]);
  await grantScope(ACTORS.TEAM_LEADER, "team", TEAM_ALPHA);

  await grantCaps(ACTORS.ACCOUNTING, ["catalog_master_manage", "change_review", "entry_admin"]);
  await grantScope(ACTORS.ACCOUNTING, "all");

  await grantCaps(ACTORS.PROJECT_ADMIN, ["entry_admin", "recruiter_master_manage"]);
  await grantScope(ACTORS.PROJECT_ADMIN, "all");

  await grantCaps(ACTORS.FORM_ADMIN, ["report_form_manage"]);
  await grantScope(ACTORS.FORM_ADMIN, "all");

  await grantCaps(ACTORS.ANALYTICS_ONLY, ["report_analytics_view"]);
  await grantScope(ACTORS.ANALYTICS_ONLY, "all");

  await grantCaps(ACTORS.REPORT_VIEW_ONLY, ["report_view"]);
  await grantScope(ACTORS.REPORT_VIEW_ONLY, "all");

  await grantCaps(ACTORS.REVIEWER, ["change_review"]);
  await grantScope(ACTORS.REVIEWER, "all");

  await grantCaps(ACTORS.STAFF_A, ["entry_create", "entry_own", "submission_create"]);
  await grantScope(ACTORS.STAFF_A, "own");

  await grantCaps(ACTORS.STAFF_B, ["entry_create", "entry_own", "submission_create"]);
  await grantScope(ACTORS.STAFF_B, "own");

  await grantCaps(ACTORS.ADMIN_TRIPLE_TEAM_ONLY, [
    "entry_admin",
    "recruiter_master_manage",
    "team_master_manage",
  ]);
  await grantScope(ACTORS.ADMIN_TRIPLE_TEAM_ONLY, "team", TEAM_ALPHA);

  await grantCaps(ACTORS.BOD_PRIVILEGED_TEAM_ONLY, ["entry_privileged_edit"]);
  await grantScope(ACTORS.BOD_PRIVILEGED_TEAM_ONLY, "team", TEAM_ALPHA);

  // Seed recruiter links for STAFF_A (linked) while leaving STAFF_B unlinked to verify nullable personnel_code
  await db.query(
    `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
     values ($1::uuid, $2, $3, 'STAFF', true)`,
    [ACTORS.STAFF_A.recruiter, ACTORS.STAFF_A.name, ACTORS.STAFF_A.code],
  );
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links
       (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
    [ACTORS.STAFF_A.app, ACTORS.STAFF_A.recruiter],
  );
}

async function callReportAsServiceRole(db, args) {
  const useEightArg = "employee_id" in args || args.use_eight_arg === true;
  await db.exec("begin; set local role service_role;");
  try {
    const res = useEightArg
      ? await db.query(
          `select public.attendance_admin_report(
            $1::uuid,
            $2::uuid,
            $3::date,
            $4::date,
            $5::integer,
            $6::integer,
            $7::text,
            $8::uuid
          ) as data`,
          [
            args.auth_subject,
            args.app_user_id,
            args.from_date ?? null,
            args.to_date ?? null,
            args.page ?? 1,
            args.page_size ?? 25,
            args.search ?? null,
            args.employee_id ?? null,
          ],
        )
      : await db.query(
          `select public.attendance_admin_report(
            $1::uuid,
            $2::uuid,
            $3::date,
            $4::date,
            $5::integer,
            $6::integer,
            $7::text
          ) as data`,
          [
            args.auth_subject,
            args.app_user_id,
            args.from_date ?? null,
            args.to_date ?? null,
            args.page ?? 1,
            args.page_size ?? 25,
            args.search ?? null,
          ],
        );
    await db.exec("commit;");
    return res.rows[0].data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

async function callPhotoAsServiceRole(db, args) {
  await db.exec("begin; set local role service_role;");
  try {
    const res = await db.query(
      `select public.attendance_admin_checkin_photo(
        $1::uuid, $2::uuid, $3::uuid
      ) as data`,
      [args.auth_subject, args.app_user_id, args.checkin_id],
    );
    await db.exec("commit;");
    return res.rows[0].data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

async function callSelfHistoryAsServiceRole(db, args) {
  await db.exec("begin; set local role service_role;");
  try {
    const res = await db.query(
      `select public.attendance_self_history($1::uuid, $2::uuid, $3::date, $4::date, $5::integer, $6::integer) as data`,
      [args.auth_subject, args.app_user_id, args.from_date ?? null, args.to_date ?? null, args.page ?? 1, args.page_size ?? 100],
    );
    await db.exec("commit;");
    return res.rows[0].data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

async function callSelfPhotoAsServiceRole(db, args) {
  await db.exec("begin; set local role service_role;");
  try {
    const res = await db.query(
      "select public.attendance_self_checkin_photo($1::uuid, $2::uuid, $3::uuid) as data",
      [args.auth_subject, args.app_user_id, args.checkin_id],
    );
    await db.exec("commit;");
    return res.rows[0].data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

async function callSetHqAsServiceRole(db, args) {
  const idempotencyKey = args.idempotency_key ?? nextUuid();
  const fingerprint =
    args.request_fingerprint ??
    (Number.isFinite(args.latitude) &&
    Number.isFinite(args.longitude) &&
    typeof args.expected_version === "number" &&
    args.app_user_id
      ? computeHqLocationRequestFingerprint({
          app_user_id: args.app_user_id,
          expected_version: args.expected_version,
          latitude: args.latitude,
          longitude: args.longitude,
        })
      : "0".repeat(64));

  await db.exec("begin; set local role service_role;");
  try {
    const res = await db.query(
      `select public.attendance_set_hq_location(
        $1::uuid,
        $2::uuid,
        $3::double precision,
        $4::double precision,
        $5::integer,
        $6::uuid,
        $7::text
      ) as data`,
      [
        args.auth_subject,
        args.app_user_id,
        args.latitude,
        args.longitude,
        args.expected_version,
        idempotencyKey,
        fingerprint,
      ],
    );
    await db.exec("commit;");
    return res.rows[0].data;
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
  const accuracyMeters = input.accuracy_meters ?? 10.5;

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

  await db.exec("begin; set local role service_role;");
  try {
    const res = await db.query(
      `select public.attendance_record_checkin(
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::text,
        $5::double precision,
        $6::double precision,
        $7::double precision,
        $8::text,
        $9::text,
        $10::timestamptz,
        $11::text,
        $12::timestamptz,
        $13::bigint,
        $14::text,
        $15::text,
        $16::text,
        $17::integer,
        $18::text,
        $19::timestamptz
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
        `preview/attendance/2026-10-23/${input.actor.app}/${idempotencyKey}.jpg`,
        PHOTO_SHA,
        4096,
        ATTENDANCE_PHOTO_MIME_TYPE,
        receivedIso,
      ],
    );
    await db.exec("commit;");
    return res.rows[0].data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

test("Attendance Admin Report migration rolls back atomically on failure and records clean LF-normalized checksum", async () => {
  const { db, targetMigration } = await createDatabase({ stopBeforeTarget: true });
  try {
    assert.equal(targetMigration.name, ATTENDANCE_ADMIN_REPORT_MIGRATION_NAME);
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

    const { rows: leftoverTable } = await db.query(
      `select count(*)::int as n
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'attendance_hq_location_revisions'`,
    );
    assert.equal(leftoverTable[0].n, 0, "rollback leaves zero HQ table");

    const { rows: leftoverFuncs } = await db.query(
      `select count(*)::int as n
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'attendance__internal_assert_report_reader',
            'attendance_admin_report',
            'attendance_set_hq_location'
          )`,
    );
    assert.equal(leftoverFuncs[0].n, 0, "rollback leaves zero RPC/helper functions");

    await db.exec("begin;");
    await db.exec(migrationSqlForTransaction(targetMigration.sql));
    await db.exec("commit;");

    for (const sig of ATTENDANCE_ADMIN_REPORT_RPC_SIGNATURES) {
      const { rows } = await db.query("select to_regprocedure($1)::text as oid_name", [sig]);
      assert.ok(rows[0].oid_name, `RPC ${sig} must exist after commit`);
    }
  } finally {
    await db.close();
  }
});

test("Attendance self-history migration rolls back atomically and exposes only service-role RPC signatures", async () => {
  const { db, targetMigration } = await createDatabase({
    stopBeforeTarget: true,
    targetMigrationName: ATTENDANCE_SELF_HISTORY_MIGRATION_NAME,
  });
  try {
    assert.equal(targetMigration.name, ATTENDANCE_SELF_HISTORY_MIGRATION_NAME);
    const checksum = migrationChecksum(targetMigration.sql);
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.equal(migrationChecksum(targetMigration.sql.replace(/\n/g, "\r\n")), checksum);

    await assert.rejects(async () => {
      await db.exec("begin;");
      try {
        await db.exec(`${migrationSqlForTransaction(targetMigration.sql)}\nselect 1 / 0;\n`);
        await db.exec("commit;");
      } catch (err) {
        await db.exec("rollback;");
        throw err;
      }
    }, (err) => err.code === "22012");

    const { rows: rolledBack } = await db.query(
      `select count(*)::int as n from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('attendance_self_history', 'attendance_self_checkin_photo')`,
    );
    assert.equal(rolledBack[0].n, 0);

    await db.exec("begin;");
    await db.exec(migrationSqlForTransaction(targetMigration.sql));
    await db.exec("commit;");
    for (const signature of ATTENDANCE_SELF_HISTORY_RPC_SIGNATURES) {
      const { rows } = await db.query("select pg_catalog.to_regprocedure($1)::text as name", [signature]);
      assert.ok(rows[0].name, `${signature} exists after applying its migration`);
    }
  } finally {
    await db.close();
  }
});

test("Attendance Admin Report SQL enforces ACL/immutability, role matrix, HQ revision history, point-in-time distances, business-date filter, search, and pagination", async () => {
  const { db } = await createDatabase();
  try {
    await seedRoleMatrixActors(db);

    // -------------------------------------------------------------------------
    // 1. Direct table, helper, and RPC ACL boundaries
    // -------------------------------------------------------------------------
    for (const role of ["anon", "authenticated", "service_role"]) {
      await assert.rejects(
        async () => {
          await db.exec(`begin; set local role ${role};`);
          try {
            await db.query("select * from public.attendance_hq_location_revisions");
            await db.exec("commit;");
          } catch (err) {
            await db.exec("rollback;");
            throw err;
          }
        },
        (err) => err.code === "42501",
        `${role} must not have direct SELECT on attendance_hq_location_revisions`,
      );

      await assert.rejects(
        async () => {
          await db.exec(`begin; set local role ${role};`);
          try {
            await db.query(
              "select public.attendance__internal_assert_report_reader($1::uuid, $2::uuid)",
              [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
            );
            await db.exec("commit;");
          } catch (err) {
            await db.exec("rollback;");
            throw err;
          }
        },
        (err) => err.code === "42501",
        `${role} must not EXECUTE internal helper attendance__internal_assert_report_reader`,
      );
    }

    for (const role of ["anon", "authenticated"]) {
      await assert.rejects(
        async () => {
          await db.exec(`begin; set local role ${role};`);
          try {
            await db.query(
              "select public.attendance_admin_report($1::uuid, $2::uuid, null, null, 1, 25, null)",
              [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
            );
            await db.exec("commit;");
          } catch (err) {
            await db.exec("rollback;");
            throw err;
          }
        },
        (err) => err.code === "42501",
      );

      for (const sql of [
        "select public.attendance_self_history($1::uuid, $2::uuid, null, null, 1, 100)",
        "select public.attendance_self_checkin_photo($1::uuid, $2::uuid, $3::uuid)",
      ]) {
        await assert.rejects(async () => {
          await db.exec(`begin; set local role ${role};`);
          try {
            const params = sql.includes("attendance_self_checkin_photo")
              ? [ACTORS.STAFF_A.auth, ACTORS.STAFF_A.app, nextUuid()]
              : [ACTORS.STAFF_A.auth, ACTORS.STAFF_A.app];
            await db.query(sql, params);
            await db.exec("commit;");
          } catch (err) {
            await db.exec("rollback;");
            throw err;
          }
        }, (err) => err.code === "42501");
      }

      await assert.rejects(
        async () => {
          await db.exec(`begin; set local role ${role};`);
          try {
            await db.query(
              "select public.attendance_admin_checkin_photo($1::uuid, $2::uuid, $3::uuid)",
              [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, nextUuid()],
            );
            await db.exec("commit;");
          } catch (err) {
            await db.exec("rollback;");
            throw err;
          }
        },
        (err) => err.code === "42501",
      );

      await assert.rejects(
        async () => {
          await db.exec(`begin; set local role ${role};`);
          try {
            await db.query(
              "select public.attendance_set_hq_location($1::uuid, $2::uuid, 21.0, 105.8, 0, $3::uuid, $4::text)",
              [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app, nextUuid(), "a".repeat(64)],
            );
            await db.exec("commit;");
          } catch (err) {
            await db.exec("rollback;");
            throw err;
          }
        },
        (err) => err.code === "42501",
      );
    }

    // -------------------------------------------------------------------------
    // 2. Full Role & Capability Matrix on Report Read & HQ Write
    // -------------------------------------------------------------------------
    for (const [label, actor, expectedCanConfigure] of [
      ["FULL_ADMIN", ACTORS.FULL_ADMIN, true],
      ["BOD_PRIVILEGED", ACTORS.BOD_PRIVILEGED, false],
      ["BOD_EXECUTIVE_REPORTS", ACTORS.BOD_EXECUTIVE_REPORTS, false],
    ]) {
      const report = await callReportAsServiceRole(db, {
        auth_subject: actor.auth,
        app_user_id: actor.app,
      });
      assert.equal(report.viewer.can_configure_hq, expectedCanConfigure, label);
      assert.equal(report.current_hq, null, label);
      assert.ok(projectAttendanceAdminReport(report), `strict projection passes for ${label}`);
      assert.deepEqual(
        await callPhotoAsServiceRole(db, {
          auth_subject: actor.auth,
          app_user_id: actor.app,
          checkin_id: nextUuid(),
        }),
        { found: false },
        `${label} may resolve a private photo only through the guarded RPC`,
      );
    }

    for (const [label, authSubject, appUserId, expectedToken] of [
      ["TEAM_LEADER", ACTORS.TEAM_LEADER.auth, ACTORS.TEAM_LEADER.app, "ATTENDANCE_REPORT_ACCESS_DENIED"],
      ["ACCOUNTING", ACTORS.ACCOUNTING.auth, ACTORS.ACCOUNTING.app, "ATTENDANCE_REPORT_ACCESS_DENIED"],
      ["PROJECT_ADMIN", ACTORS.PROJECT_ADMIN.auth, ACTORS.PROJECT_ADMIN.app, "ATTENDANCE_REPORT_ACCESS_DENIED"],
      ["FORM_ADMIN", ACTORS.FORM_ADMIN.auth, ACTORS.FORM_ADMIN.app, "ATTENDANCE_REPORT_ACCESS_DENIED"],
      ["ANALYTICS_ONLY", ACTORS.ANALYTICS_ONLY.auth, ACTORS.ANALYTICS_ONLY.app, "ATTENDANCE_REPORT_ACCESS_DENIED"],
      ["REPORT_VIEW_ONLY", ACTORS.REPORT_VIEW_ONLY.auth, ACTORS.REPORT_VIEW_ONLY.app, "ATTENDANCE_REPORT_ACCESS_DENIED"],
      ["REVIEWER", ACTORS.REVIEWER.auth, ACTORS.REVIEWER.app, "ATTENDANCE_REPORT_ACCESS_DENIED"],
      ["STAFF_A", ACTORS.STAFF_A.auth, ACTORS.STAFF_A.app, "ATTENDANCE_REPORT_ACCESS_DENIED"],
      ["ADMIN_TRIPLE_TEAM_ONLY", ACTORS.ADMIN_TRIPLE_TEAM_ONLY.auth, ACTORS.ADMIN_TRIPLE_TEAM_ONLY.app, "ATTENDANCE_REPORT_ACCESS_DENIED"],
      ["BOD_PRIVILEGED_TEAM_ONLY", ACTORS.BOD_PRIVILEGED_TEAM_ONLY.auth, ACTORS.BOD_PRIVILEGED_TEAM_ONLY.app, "ATTENDANCE_REPORT_ACCESS_DENIED"],
      ["DISABLED_ADMIN", ACTORS.DISABLED_ADMIN.auth, ACTORS.DISABLED_ADMIN.app, "ATTENDANCE_ACTOR_DENIED"],
      ["MISMATCHED_AUTH_SUBJECT", ACTORS.FULL_ADMIN.auth, ACTORS.BOD_PRIVILEGED.app, "ATTENDANCE_ACTOR_DENIED"],
      ["UNKNOWN_APP_USER", ACTORS.FULL_ADMIN.auth, "99999999-0000-4000-8000-000000000999", "ATTENDANCE_ACTOR_DENIED"],
      ["NULL_ACTOR", null, ACTORS.FULL_ADMIN.app, "ATTENDANCE_ACTOR_DENIED"],
    ]) {
      await assert.rejects(
        () =>
          callReportAsServiceRole(db, {
            auth_subject: authSubject,
            app_user_id: appUserId,
          }),
        (err) => err.code === "42501" && String(err.message).includes(expectedToken),
        `report read must deny ${label}`,
      );
      await assert.rejects(
        () => callPhotoAsServiceRole(db, {
          auth_subject: authSubject,
          app_user_id: appUserId,
          checkin_id: nextUuid(),
        }),
        (err) => err.code === "42501" && String(err.message).includes(expectedToken),
        `private photo read must deny ${label}`,
      );
    }

    // Immediate revocation check: revoking BoD's `all` scope denies next request immediately
    await db.query(
      "update public.direct_entry_scope_grants set is_current = false where app_user_id = $1::uuid",
      [ACTORS.BOD_EXECUTIVE_REPORTS.app],
    );
    await assert.rejects(
      () =>
        callReportAsServiceRole(db, {
          auth_subject: ACTORS.BOD_EXECUTIVE_REPORTS.auth,
          app_user_id: ACTORS.BOD_EXECUTIVE_REPORTS.app,
        }),
      (err) => err.code === "42501",
    );
    await db.query(
      "update public.direct_entry_scope_grants set is_current = true where app_user_id = $1::uuid",
      [ACTORS.BOD_EXECUTIVE_REPORTS.app],
    );

    // HQ configuration denied for BoD (both forms), Accounting, Team Leader, Project Admin, Staff, Disabled Admin
    for (const [label, actor] of [
      ["BOD_PRIVILEGED", ACTORS.BOD_PRIVILEGED],
      ["BOD_EXECUTIVE_REPORTS", ACTORS.BOD_EXECUTIVE_REPORTS],
      ["ACCOUNTING", ACTORS.ACCOUNTING],
      ["TEAM_LEADER", ACTORS.TEAM_LEADER],
      ["PROJECT_ADMIN", ACTORS.PROJECT_ADMIN],
      ["STAFF_A", ACTORS.STAFF_A],
      ["DISABLED_ADMIN", ACTORS.DISABLED_ADMIN],
    ]) {
      await assert.rejects(
        () =>
          callSetHqAsServiceRole(db, {
            auth_subject: actor.auth,
            app_user_id: actor.app,
            latitude: HQ_HANOI.latitude,
            longitude: HQ_HANOI.longitude,
            expected_version: 0,
          }),
        (err) => err.code === "42501",
        `HQ write must deny ${label}`,
      );
    }

    const { rows: zeroHqAfterDenied } = await db.query(
      "select count(*)::int as n from public.attendance_hq_location_revisions",
    );
    assert.equal(zeroHqAfterDenied[0].n, 0, "denied writes leave zero HQ revisions");

    // -------------------------------------------------------------------------
    // 3. Point-in-time HQ Revisions, OCC, Idempotency & Distance Stability
    // -------------------------------------------------------------------------
    // Phase 0: Check-in C0 recorded on 2026-10-22T17:30:00Z (= 2026-10-23 00:30:00 ICT) BEFORE any HQ exists
    const c0PreHq = await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_A,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: "2026-10-22T17:30:00.000Z",
      received_at: "2026-10-22T17:30:05.000Z",
      note: "Chấm công đầu ca trước khi cấu hình trụ sở",
    });
    assert.equal(c0PreHq.business_date, "2026-10-23", "17:30 UTC maps to next day in Asia/Ho_Chi_Minh");

    // Coordinate & OCC validation on attendance_set_hq_location
    for (const badArgs of [
      { latitude: Number.NaN, longitude: 105.8, expected_version: 0 },
      { latitude: Number.POSITIVE_INFINITY, longitude: 105.8, expected_version: 0 },
      { latitude: 90.001, longitude: 105.8, expected_version: 0 },
      { latitude: -90.001, longitude: 105.8, expected_version: 0 },
      { latitude: 21.0, longitude: 180.001, expected_version: 0 },
      { latitude: 21.0, longitude: -180.001, expected_version: 0 },
      { latitude: 21.0, longitude: 105.8, expected_version: -1 },
    ]) {
      await assert.rejects(
        () =>
          callSetHqAsServiceRole(db, {
            auth_subject: ACTORS.FULL_ADMIN.auth,
            app_user_id: ACTORS.FULL_ADMIN.app,
            ...badArgs,
          }),
        (err) => err.code === "22023" && String(err.message).includes("ATTENDANCE_HQ_COORDINATES_INVALID"),
      );
    }

    await assert.rejects(
      () =>
        callSetHqAsServiceRole(db, {
          auth_subject: ACTORS.FULL_ADMIN.auth,
          app_user_id: ACTORS.FULL_ADMIN.app,
          latitude: HQ_HANOI.latitude,
          longitude: HQ_HANOI.longitude,
          expected_version: 1,
        }),
      (err) => err.code === "PT409" && String(err.message).includes("ATTENDANCE_HQ_VERSION_CONFLICT"),
    );

    // Phase 1: Full Admin configures HQ v1 (Hanoi)
    const v1Key = nextUuid();
    const v1Created = await callSetHqAsServiceRole(db, {
      auth_subject: ACTORS.FULL_ADMIN.auth,
      app_user_id: ACTORS.FULL_ADMIN.app,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      expected_version: 0,
      idempotency_key: v1Key,
    });
    assert.equal(v1Created.replayed, false);
    assert.equal(v1Created.hq.version, 1);
    assert.equal(v1Created.hq.configured_by_display_name, ACTORS.FULL_ADMIN.name);

    // Append-only immutability trigger blocks UPDATE and DELETE on attendance_hq_location_revisions
    await assert.rejects(
      () => db.query("update public.attendance_hq_location_revisions set latitude = 0 where version = 1"),
      (err) => err.code === "55000" && String(err.message).includes("ATTENDANCE_CHECKINS_IMMUTABLE"),
    );
    await assert.rejects(
      () => db.query("delete from public.attendance_hq_location_revisions where version = 1"),
      (err) => err.code === "55000" && String(err.message).includes("ATTENDANCE_CHECKINS_IMMUTABLE"),
    );

    // Same idempotency_key + different coordinates -> 23505 IDEMPOTENCY_CONFLICT
    await assert.rejects(
      () =>
        callSetHqAsServiceRole(db, {
          auth_subject: ACTORS.FULL_ADMIN.auth,
          app_user_id: ACTORS.FULL_ADMIN.app,
          latitude: HQ_HCMC.latitude,
          longitude: HQ_HCMC.longitude,
          expected_version: 0,
          idempotency_key: v1Key,
        }),
      (err) => err.code === "23505" && String(err.message).includes("IDEMPOTENCY_CONFLICT"),
    );

    await sleep(40);
    const duringV1Ms = Date.now();
    const duringV1IsoA = new Date(duringV1Ms).toISOString();
    const duringV1IsoB = new Date(duringV1Ms + 5).toISOString();
    const duringV1IsoOfflineCapture = new Date(duringV1Ms + 10).toISOString();
    const duringV1VietnamDate = (
      await db.query(
        "select ($1::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date::text as d",
        [duringV1IsoA],
      )
    ).rows[0].d;

    // Check-in C1 (exact HQ v1 -> 0 m) and C2 (+0.01 deg lat north of HQ v1 -> ~1111.9 m)
    const c1ExactV1 = await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_A,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: duringV1IsoA,
      received_at: duringV1IsoA,
      note: "Tại sảnh trụ sở Hà Nội",
    });

    const c2NorthV1Lat = HQ_HANOI.latitude + 0.01;
    const expectedC2Meters = haversineMetersOracle(
      HQ_HANOI.latitude,
      HQ_HANOI.longitude,
      c2NorthV1Lat,
      HQ_HANOI.longitude,
    );
    const c2OffsetV1 = await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: c2NorthV1Lat,
      longitude: HQ_HANOI.longitude,
      captured_at: duringV1IsoB,
      received_at: duringV1IsoB,
      note: "Đi khách hàng cách trụ sở ~1.1km",
    });

    await sleep(50);

    // Stale expected_version = 0 when current is 1 -> PT409 ATTENDANCE_HQ_VERSION_CONFLICT
    await assert.rejects(
      () =>
        callSetHqAsServiceRole(db, {
          auth_subject: ACTORS.FULL_ADMIN.auth,
          app_user_id: ACTORS.FULL_ADMIN.app,
          latitude: HQ_HCMC.latitude,
          longitude: HQ_HCMC.longitude,
          expected_version: 0,
        }),
      (err) => err.code === "PT409" && String(err.message).includes("ATTENDANCE_HQ_VERSION_CONFLICT"),
    );

    // Phase 2: Full Admin updates HQ to v2 (Ho Chi Minh City, ~1,140 km away)
    const v2Created = await callSetHqAsServiceRole(db, {
      auth_subject: ACTORS.FULL_ADMIN.auth,
      app_user_id: ACTORS.FULL_ADMIN.app,
      latitude: HQ_HCMC.latitude,
      longitude: HQ_HCMC.longitude,
      expected_version: 1,
    });
    assert.equal(v2Created.replayed, false);
    assert.equal(v2Created.hq.version, 2);

    // Replaying v1's original idempotency_key + fingerprint STILL replays v1 cleanly without creating v3!
    const v1Replayed = await callSetHqAsServiceRole(db, {
      auth_subject: ACTORS.FULL_ADMIN.auth,
      app_user_id: ACTORS.FULL_ADMIN.app,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      expected_version: 0,
      idempotency_key: v1Key,
    });
    assert.equal(v1Replayed.replayed, true);
    assert.equal(v1Replayed.hq.version, 1);

    await sleep(40);
    const afterV2Ms = Date.now();
    const afterV2IsoA = new Date(afterV2Ms).toISOString();
    const afterV2IsoB = new Date(afterV2Ms + 5).toISOString();
    const afterV2IsoC = new Date(afterV2Ms + 10).toISOString();

    // C3: Offline delayed SERVER_ANCHORED check-in captured during v1, synced AFTER v2 -> must use v1!
    const c3DelayedVerified = await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_A,
      latitude: HQ_HANOI.latitude,
      longitude: HQ_HANOI.longitude,
      captured_at: duringV1IsoOfflineCapture,
      received_at: afterV2IsoA,
      time_source: "SERVER_ANCHORED",
      note: "Đồng bộ ngoại tuyến sau khi đổi trụ sở",
    });

    // C4: DEVICE_CLOCK_UNVERIFIED check-in with device clock backdated during v1, received AFTER v2 -> must use v2 (received_at)!
    const c4UnverifiedClock = await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: HQ_HCMC.latitude,
      longitude: HQ_HCMC.longitude,
      captured_at: duringV1IsoOfflineCapture,
      received_at: afterV2IsoB,
      time_source: "DEVICE_CLOCK_UNVERIFIED",
      note: "Đồng hồ máy lệch về quá khứ",
    });

    // C5: Post-v2 SERVER_ANCHORED check-in ~500m north of HCMC HQ v2
    const c5NorthV2Lat = HQ_HCMC.latitude + 0.0045;
    const expectedC5Meters = haversineMetersOracle(
      HQ_HCMC.latitude,
      HQ_HCMC.longitude,
      c5NorthV2Lat,
      HQ_HCMC.longitude,
    );
    const c5PostV2 = await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_A,
      latitude: c5NorthV2Lat,
      longitude: HQ_HCMC.longitude,
      captured_at: afterV2IsoB,
      received_at: afterV2IsoB,
      note: "Chấm công tại chi nhánh TP.HCM",
    });

    // C6: Degraded GPS accuracy (> 100,000 m) -> INVALID_GPS, null distance & coordinates
    const c6InvalidGps = await recordCheckInAsServiceRole(db, {
      actor: ACTORS.STAFF_B,
      latitude: HQ_HCMC.latitude,
      longitude: HQ_HCMC.longitude,
      accuracy_meters: 150_000,
      captured_at: afterV2IsoC,
      received_at: afterV2IsoC,
      note: "Mất sóng GPS trong tầng hầm",
    });

    const minDate = "2026-10-22" < duringV1VietnamDate ? "2026-10-22" : duringV1VietnamDate;
    const maxDate = "2026-10-23" > duringV1VietnamDate ? "2026-10-23" : duringV1VietnamDate;

    const fullReport = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.BOD_PRIVILEGED.auth,
      app_user_id: ACTORS.BOD_PRIVILEGED.app,
      from_date: minDate,
      to_date: maxDate,
      page: 1,
      page_size: 25,
    });

    assert.ok(projectAttendanceAdminReport(fullReport), "report satisfies strict TypeScript projector");
    assert.equal(fullReport.viewer.can_configure_hq, false);
    assert.equal(fullReport.current_hq.version, 2);
    assert.equal(fullReport.current_hq.latitude, HQ_HCMC.latitude);
    assert.equal(fullReport.current_hq.longitude, HQ_HCMC.longitude);

    const byId = new Map(fullReport.items.map((item) => [item.checkin_id, item]));
    assert.equal(fullReport.items.length, 7);

    // Verify C0 (before any HQ): still HQ_NOT_CONFIGURED!
    assert.equal(byId.get(c0PreHq.checkin_id).distance_status, "HQ_NOT_CONFIGURED");
    assert.equal(byId.get(c0PreHq.checkin_id).distance_meters, null);
    assert.equal(byId.get(c0PreHq.checkin_id).hq_version_used, null);
    assert.equal(byId.get(c0PreHq.checkin_id).personnel_code, ACTORS.STAFF_A.code);
    const c0StoredPhoto = (await db.query(
      "select photo_storage_key from public.attendance_checkins where checkin_id=$1::uuid",
      [c0PreHq.checkin_id],
    )).rows[0].photo_storage_key;
    assert.deepEqual(
      await callPhotoAsServiceRole(db, {
        auth_subject: ACTORS.BOD_PRIVILEGED.auth,
        app_user_id: ACTORS.BOD_PRIVILEGED.app,
        checkin_id: c0PreHq.checkin_id,
      }),
      { found: true, photo_storage_key: c0StoredPhoto },
      "guarded RPC resolves the exact private key without adding it to report rows",
    );

    // Verify C1 & C2 (during v1): preserved exact v1 distances, NOT recomputed against HCMC v2!
    assert.equal(byId.get(c1ExactV1.checkin_id).distance_status, "COMPUTED");
    assert.equal(byId.get(c1ExactV1.checkin_id).hq_version_used, 1);
    assert.equal(byId.get(c1ExactV1.checkin_id).distance_meters, 0);

    assert.equal(byId.get(c2OffsetV1.checkin_id).distance_status, "COMPUTED");
    assert.equal(byId.get(c2OffsetV1.checkin_id).hq_version_used, 1);
    assert.ok(
      Math.abs(byId.get(c2OffsetV1.checkin_id).distance_meters - expectedC2Meters) <= 0.2,
      `expected ~${expectedC2Meters}m, got ${byId.get(c2OffsetV1.checkin_id).distance_meters}m`,
    );
    assert.equal(byId.get(c2OffsetV1.checkin_id).personnel_code, null, "unlinked user has null personnel_code");

    // Verify C3 (verified offline sync captured during v1, received after v2): bound to v1!
    assert.equal(byId.get(c3DelayedVerified.checkin_id).time_verified, true);
    assert.equal(byId.get(c3DelayedVerified.checkin_id).hq_version_used, 1);
    assert.equal(byId.get(c3DelayedVerified.checkin_id).distance_meters, 0);
    assert.ok(byId.get(c3DelayedVerified.checkin_id).sync_delay_seconds >= 0);

    // Verify C4 (unverified device clock backdated during v1, received after v2): bound to v2 via received_at!
    assert.equal(byId.get(c4UnverifiedClock.checkin_id).time_verified, false);
    assert.equal(byId.get(c4UnverifiedClock.checkin_id).time_source, "DEVICE_CLOCK_UNVERIFIED");
    assert.equal(byId.get(c4UnverifiedClock.checkin_id).hq_version_used, 2);
    assert.equal(byId.get(c4UnverifiedClock.checkin_id).distance_meters, 0);

    // Verify C5 (post-v2 verified): bound to v2!
    assert.equal(byId.get(c5PostV2.checkin_id).hq_version_used, 2);
    assert.ok(
      Math.abs(byId.get(c5PostV2.checkin_id).distance_meters - expectedC5Meters) <= 0.2,
    );

    // Verify C6 (accuracy 150,000m > 100,000m): INVALID_GPS with scrubbed coordinates
    assert.equal(byId.get(c6InvalidGps.checkin_id).distance_status, "INVALID_GPS");
    assert.equal(byId.get(c6InvalidGps.checkin_id).distance_meters, null);
    assert.equal(byId.get(c6InvalidGps.checkin_id).hq_version_used, null);
    assert.equal(byId.get(c6InvalidGps.checkin_id).latitude, null);
    assert.equal(byId.get(c6InvalidGps.checkin_id).longitude, null);
    assert.equal(byId.get(c6InvalidGps.checkin_id).accuracy_meters, null);

    // Verify overview aggregates across all 7 rows (5 COMPUTED, 2 unavailable: C0 + C6; 6 verified, 1 unverified)
    assert.equal(fullReport.overview.total_checkins, 7);
    assert.equal(fullReport.overview.unique_employees, 2);
    assert.equal(fullReport.overview.verified_time_count, 6);
    assert.equal(fullReport.overview.unverified_time_count, 1);
    assert.equal(fullReport.overview.distance_computed_count, 5);
    assert.equal(fullReport.overview.distance_unavailable_count, 2);
    assert.ok(Math.abs(fullReport.overview.max_distance_meters - expectedC2Meters) <= 0.2);

    // -------------------------------------------------------------------------
    // 4. Business-date timezone boundary, wildcard-safe search & server pagination
    // -------------------------------------------------------------------------
    // 2026-10-22T17:30:00Z is 2026-10-23 in Asia/Ho_Chi_Minh -> absent on 2026-10-22!
    if (duringV1VietnamDate !== "2026-10-22") {
      const oct22Report = await callReportAsServiceRole(db, {
        auth_subject: ACTORS.FULL_ADMIN.auth,
        app_user_id: ACTORS.FULL_ADMIN.app,
        from_date: "2026-10-22",
        to_date: "2026-10-22",
      });
      assert.equal(oct22Report.overview.total_checkins, 0);
      assert.deepEqual(oct22Report.items, []);
    }

    // Wildcard-safe search: searching literal "100%" matches STAFF_A ("Nhân Viên 100% _Alpha") and NOT STAFF_B ("Nhân Viên 1000 Beta")
    const wildcardSearch = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.FULL_ADMIN.auth,
      app_user_id: ACTORS.FULL_ADMIN.app,
      from_date: minDate,
      to_date: maxDate,
      search: "100%",
    });
    assert.equal(wildcardSearch.overview.unique_employees, 1);
    assert.ok(wildcardSearch.items.length >= 1);
    assert.ok(
      wildcardSearch.items.every((item) => item.employee_display_name === ACTORS.STAFF_A.name),
    );

    // Search by personnel_code ("NV_ATT_01")
    const codeSearch = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.FULL_ADMIN.auth,
      app_user_id: ACTORS.FULL_ADMIN.app,
      from_date: minDate,
      to_date: maxDate,
      search: "nv_att_01",
    });
    assert.equal(codeSearch.overview.total_checkins, 4);
    assert.ok(codeSearch.items.every((item) => item.personnel_code === "NV_ATT_01"));

    // Server pagination: page 1 (size 3), page 2 (size 3), page 3 (size 3 -> 1 item); overview remains invariant
    const page1 = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.FULL_ADMIN.auth,
      app_user_id: ACTORS.FULL_ADMIN.app,
      from_date: minDate,
      to_date: maxDate,
      page: 1,
      page_size: 3,
    });
    const page2 = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.FULL_ADMIN.auth,
      app_user_id: ACTORS.FULL_ADMIN.app,
      from_date: minDate,
      to_date: maxDate,
      page: 2,
      page_size: 3,
    });
    const page3 = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.FULL_ADMIN.auth,
      app_user_id: ACTORS.FULL_ADMIN.app,
      from_date: minDate,
      to_date: maxDate,
      page: 3,
      page_size: 3,
    });

    assert.deepEqual(page1.pagination, {
      page: 1,
      page_size: 3,
      total_rows: 7,
      total_pages: 3,
      has_more: true,
    });
    assert.deepEqual(page2.pagination, {
      page: 2,
      page_size: 3,
      total_rows: 7,
      total_pages: 3,
      has_more: true,
    });
    assert.deepEqual(page3.pagination, {
      page: 3,
      page_size: 3,
      total_rows: 7,
      total_pages: 3,
      has_more: false,
    });
    assert.equal(page1.items.length, 3);
    assert.equal(page2.items.length, 3);
    assert.equal(page3.items.length, 1);
    assert.deepEqual(page1.overview, fullReport.overview);
    assert.deepEqual(page2.overview, fullReport.overview);
    assert.deepEqual(page3.overview, fullReport.overview);

    const pagedIds = [...page1.items, ...page2.items, ...page3.items].map((i) => i.checkin_id);
    assert.deepEqual(pagedIds, fullReport.items.map((i) => i.checkin_id));

    // Verify SQL-level range/pagination/search/employee_id guards, employee_options contract & zero internal field leakage
    const expectedEmployeeOptions = [
      {
        app_user_id: ACTORS.STAFF_A.app,
        display_name: ACTORS.STAFF_A.name,
        personnel_code: ACTORS.STAFF_A.code,
      },
      {
        app_user_id: ACTORS.STAFF_B.app,
        display_name: ACTORS.STAFF_B.name,
        personnel_code: null,
      },
    ];
    assert.deepEqual(fullReport.employee_options, expectedEmployeeOptions);
    assert.deepEqual(
      wildcardSearch.employee_options,
      expectedEmployeeOptions,
      "employee_options stays scoped to [from_date, to_date] and is not narrowed by search",
    );

    const staffAFiltered = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.FULL_ADMIN.auth,
      app_user_id: ACTORS.FULL_ADMIN.app,
      from_date: minDate,
      to_date: maxDate,
      employee_id: ACTORS.STAFF_A.app,
    });
    assert.ok(projectAttendanceAdminReport(staffAFiltered) !== null);
    assert.equal(staffAFiltered.filters.employee_id, ACTORS.STAFF_A.app);
    assert.equal(staffAFiltered.filters.search, null);
    assert.equal(staffAFiltered.overview.total_checkins, 4);
    assert.equal(staffAFiltered.overview.unique_employees, 1);
    assert.equal(staffAFiltered.pagination.total_rows, 4);
    assert.ok(
      staffAFiltered.items.every((item) => item.employee_display_name === ACTORS.STAFF_A.name),
    );
    assert.deepEqual(
      staffAFiltered.employee_options,
      expectedEmployeeOptions,
      "employee_options includes all date-range employees even when filtered by employee_id",
    );

    const noCheckinEmployeeFiltered = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.BOD_EXECUTIVE_REPORTS.auth,
      app_user_id: ACTORS.BOD_EXECUTIVE_REPORTS.app,
      from_date: minDate,
      to_date: maxDate,
      employee_id: ACTORS.FULL_ADMIN.app,
    });
    assert.equal(noCheckinEmployeeFiltered.overview.total_checkins, 0);
    assert.equal(noCheckinEmployeeFiltered.pagination.total_rows, 0);
    assert.deepEqual(noCheckinEmployeeFiltered.items, []);
    assert.deepEqual(noCheckinEmployeeFiltered.employee_options, expectedEmployeeOptions);

    await assert.rejects(
      () =>
        callReportAsServiceRole(db, {
          auth_subject: ACTORS.FULL_ADMIN.auth,
          app_user_id: ACTORS.FULL_ADMIN.app,
          from_date: minDate,
          to_date: maxDate,
          search: "NV",
          employee_id: ACTORS.STAFF_A.app,
        }),
      (err) =>
        err.code === "22023" &&
        String(err.message).includes("ATTENDANCE_REPORT_FILTER_CONFLICT"),
    );

    await assert.rejects(
      () =>
        callReportAsServiceRole(db, {
          auth_subject: ACTORS.TEAM_LEADER.auth,
          app_user_id: ACTORS.TEAM_LEADER.app,
          from_date: minDate,
          to_date: maxDate,
          employee_id: ACTORS.STAFF_A.app,
        }),
      (err) =>
        err.code === "42501" &&
        String(err.message).includes("ATTENDANCE_REPORT_ACCESS_DENIED"),
    );

    await assert.rejects(
      () =>
        callReportAsServiceRole(db, {
          auth_subject: ACTORS.FULL_ADMIN.auth,
          app_user_id: ACTORS.FULL_ADMIN.app,
          from_date: "2026-10-24",
          to_date: "2026-10-23",
        }),
      (err) => err.code === "22023" && String(err.message).includes("ATTENDANCE_REPORT_RANGE_INVALID"),
    );

    // Ordinary enabled employees can restore only their own rows and photos.
    const staffASelfHistory = await callSelfHistoryAsServiceRole(db, {
      auth_subject: ACTORS.STAFF_A.auth,
      app_user_id: ACTORS.STAFF_A.app,
      from_date: minDate,
      to_date: maxDate,
      page_size: 100,
    });
    assert.equal(staffASelfHistory.pagination.total_rows, 4);
    assert.ok(staffASelfHistory.items.every((item) => item.employee_display_name === ACTORS.STAFF_A.name));
    const serializedSelfHistory = JSON.stringify(staffASelfHistory);
    assert.equal(serializedSelfHistory.includes("photo_storage_key"), false);
    assert.equal(serializedSelfHistory.includes(ACTORS.STAFF_A.app), false);
    assert.equal(serializedSelfHistory.includes(ACTORS.STAFF_A.auth), false);

    const staffBSelfHistory = await callSelfHistoryAsServiceRole(db, {
      auth_subject: ACTORS.STAFF_B.auth,
      app_user_id: ACTORS.STAFF_B.app,
      from_date: minDate,
      to_date: maxDate,
    });
    assert.equal(staffBSelfHistory.pagination.total_rows, 3);
    assert.ok(staffBSelfHistory.items.every((item) => item.employee_display_name === ACTORS.STAFF_B.name));
    assert.ok(staffBSelfHistory.items.every((item) => item.employee_display_name !== ACTORS.STAFF_A.name));

    await assert.rejects(
      () => callSelfHistoryAsServiceRole(db, {
        auth_subject: ACTORS.STAFF_B.auth,
        app_user_id: ACTORS.STAFF_A.app,
        from_date: minDate,
        to_date: maxDate,
      }),
      (err) => err.code === "42501" && String(err.message).includes("ATTENDANCE_ACTOR_DENIED"),
    );
    await assert.rejects(
      () => callSelfHistoryAsServiceRole(db, {
        auth_subject: ACTORS.DISABLED_ADMIN.auth,
        app_user_id: ACTORS.DISABLED_ADMIN.app,
        from_date: minDate,
        to_date: maxDate,
      }),
      (err) => err.code === "42501" && String(err.message).includes("ATTENDANCE_ACTOR_DENIED"),
    );

    const ownPhoto = await callSelfPhotoAsServiceRole(db, {
      auth_subject: ACTORS.STAFF_A.auth,
      app_user_id: ACTORS.STAFF_A.app,
      checkin_id: c0PreHq.checkin_id,
    });
    assert.equal(ownPhoto.found, true);
    assert.match(ownPhoto.photo_storage_key, /^preview\/attendance\//);
    const anotherUsersPhoto = await callSelfPhotoAsServiceRole(db, {
      auth_subject: ACTORS.STAFF_B.auth,
      app_user_id: ACTORS.STAFF_B.app,
      checkin_id: c0PreHq.checkin_id,
    });
    assert.deepEqual(anotherUsersPhoto, { found: false });

    const serialized = JSON.stringify(fullReport);
    assert.equal(serialized.includes("photo_storage_key"), false);
    assert.equal(JSON.stringify(fullReport.items).includes(ACTORS.STAFF_A.app), false);
    assert.equal(serialized.includes(ACTORS.STAFF_A.auth), false);
    assert.equal(serialized.includes(TOKEN_DIGEST), false);

    // -------------------------------------------------------------------------
    // 10. Team Leader current-team scope, cross-team denial, photo guard & immediate revocation
    // -------------------------------------------------------------------------
    const TEAM_BETA = "31000000-0000-4000-8000-0000000000b2";
    const LEADER_RECRUITER_ID = "41000000-0000-4000-8000-000000000006";
    const STAFF_B_RECRUITER_ID = "41000000-0000-4000-8000-000000000012";

    // Internal scope resolver helper must not be directly executable by anon, authenticated, or service_role
    for (const role of ["anon", "authenticated", "service_role"]) {
      await assert.rejects(
        async () => {
          await db.exec(`begin; set local role ${role};`);
          try {
            await db.query(
              "select public.attendance__internal_resolve_report_scope($1::uuid, $2::uuid)",
              [ACTORS.FULL_ADMIN.auth, ACTORS.FULL_ADMIN.app],
            );
            await db.exec("commit;");
          } catch (err) {
            await db.exec("rollback;");
            throw err;
          }
        },
        (err) => err.code === "42501",
        `${role} must not have EXECUTE on public.attendance__internal_resolve_report_scope`,
      );
    }

    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'ATT_BETA', 'Nhóm Chấm Công Beta', true)`,
      [TEAM_BETA],
    );

    // Provision STAFF_A on TEAM_ALPHA and STAFF_B on TEAM_BETA, plus TEAM_LEADER as leader of TEAM_ALPHA
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, $2, 'NV_TL_ALPHA', 'TEAM_LEADER', true),
              ($3::uuid, $4, 'NV_ATT_02', 'STAFF', true)`,
      [LEADER_RECRUITER_ID, ACTORS.TEAM_LEADER.name, STAFF_B_RECRUITER_ID, ACTORS.STAFF_B.name],
    );
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links
         (app_user_id, recruiter_id, verified, valid_from, is_current)
       values ($1::uuid, $2::uuid, true, '2026-01-01', true),
              ($3::uuid, $4::uuid, true, '2026-01-01', true)`,
      [ACTORS.TEAM_LEADER.app, LEADER_RECRUITER_ID, ACTORS.STAFF_B.app, STAFF_B_RECRUITER_ID],
    );
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
       values ($1::uuid, 'hrp', '2026-01-01', true),
              ($2::uuid, 'hrp', '2026-01-01', true),
              ($3::uuid, 'hrp', '2026-01-01', true)`,
      [ACTORS.STAFF_A.recruiter, LEADER_RECRUITER_ID, STAFF_B_RECRUITER_ID],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, '2026-01-01', true),
              ($3::uuid, $2::uuid, '2026-01-01', true),
              ($4::uuid, $5::uuid, '2026-01-01', true)`,
      [ACTORS.STAFF_A.recruiter, TEAM_ALPHA, LEADER_RECRUITER_ID, STAFF_B_RECRUITER_ID, TEAM_BETA],
    );
    await db.query(
      `insert into public.direct_entry_team_leader_assignments
         (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01', true)`,
      [TEAM_ALPHA, ACTORS.TEAM_LEADER.app, LEADER_RECRUITER_ID],
    );

    // Record a check-in for TEAM_LEADER (who is also a current member of TEAM_ALPHA)
    const cLeaderAlpha = await recordCheckInAsServiceRole(db, {
      actor: ACTORS.TEAM_LEADER,
      latitude: HQ_HCMC.latitude,
      longitude: HQ_HCMC.longitude,
      captured_at: `${maxDate}T02:00:00.000Z`,
      note: "Check-in trưởng nhóm Alpha",
    });

    // 10a. TEAM_LEADER sees ONLY current members of TEAM_ALPHA (STAFF_A + TEAM_LEADER), never STAFF_B (TEAM_BETA)
    const tlReportRaw = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.TEAM_LEADER.auth,
      app_user_id: ACTORS.TEAM_LEADER.app,
      from_date: minDate,
      to_date: maxDate,
      page: 1,
      page_size: 25,
    });
    const tlReport = projectAttendanceAdminReport(tlReportRaw);
    assert.ok(tlReport, "Team Leader report must pass strict projection");
    assert.equal(tlReport.viewer.can_configure_hq, false);
    assert.equal(
      tlReport.current_hq,
      null,
      "Team Leader attendance_admin_report must not expose global current_hq",
    );
    assert.deepEqual(
      tlReport.employee_options.map((opt) => opt.app_user_id).sort(),
      [ACTORS.STAFF_A.app, ACTORS.TEAM_LEADER.app].sort(),
      "employee_options for Team Leader must contain only current TEAM_ALPHA members",
    );
    assert.equal(
      tlReport.employee_options.some((opt) => opt.app_user_id === ACTORS.STAFF_B.app),
      false,
    );
    assert.equal(tlReport.overview.total_checkins, 5); // 4 from STAFF_A + 1 from TEAM_LEADER
    assert.equal(tlReport.overview.unique_employees, 2);
    assert.equal(tlReport.pagination.total_rows, 5);
    assert.ok(
      tlReport.items.every((item) =>
        [ACTORS.STAFF_A.name, ACTORS.TEAM_LEADER.name].includes(item.employee_display_name),
      ),
    );
    assert.equal(
      tlReport.items.some((item) => item.employee_display_name === ACTORS.STAFF_B.name),
      false,
    );
    const tlComputedCheckinItem = tlReport.items.find(
      (item) => item.checkin_id === c1ExactV1.checkin_id,
    );
    assert.ok(tlComputedCheckinItem);
    assert.equal(tlComputedCheckinItem.distance_status, "COMPUTED");
    assert.equal(tlComputedCheckinItem.hq_version_used, 1);

    // Full Admin and BoD still receive full current_hq metadata
    const adminAfterTlReport = projectAttendanceAdminReport(
      await callReportAsServiceRole(db, {
        auth_subject: ACTORS.FULL_ADMIN.auth,
        app_user_id: ACTORS.FULL_ADMIN.app,
        from_date: minDate,
        to_date: maxDate,
      }),
    );
    assert.ok(adminAfterTlReport?.current_hq);
    assert.equal(adminAfterTlReport.current_hq.version, 2);
    const bodAfterTlReport = projectAttendanceAdminReport(
      await callReportAsServiceRole(db, {
        auth_subject: ACTORS.BOD_PRIVILEGED.auth,
        app_user_id: ACTORS.BOD_PRIVILEGED.app,
        from_date: minDate,
        to_date: maxDate,
      }),
    );
    assert.ok(bodAfterTlReport?.current_hq);
    assert.equal(bodAfterTlReport.current_hq.version, 2);

    // 10b. Searching for STAFF_B (TEAM_BETA) as TEAM_LEADER returns 0 rows
    const tlSearchBeta = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.TEAM_LEADER.auth,
      app_user_id: ACTORS.TEAM_LEADER.app,
      from_date: minDate,
      to_date: maxDate,
      search: "Phạm Thị B",
    });
    assert.equal(tlSearchBeta.overview.total_checkins, 0);
    assert.equal(tlSearchBeta.pagination.total_rows, 0);
    assert.deepEqual(tlSearchBeta.items, []);

    // 10c. Filtering by own-team employee_id succeeds; filtering by TEAM_BETA or unlinked employee_id raises 42501
    const tlOwnEmpFiltered = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.TEAM_LEADER.auth,
      app_user_id: ACTORS.TEAM_LEADER.app,
      from_date: minDate,
      to_date: maxDate,
      employee_id: ACTORS.STAFF_A.app,
    });
    assert.equal(tlOwnEmpFiltered.overview.total_checkins, 4);
    assert.equal(tlOwnEmpFiltered.pagination.total_rows, 4);

    for (const crossEmployeeId of [ACTORS.STAFF_B.app, ACTORS.FULL_ADMIN.app]) {
      await assert.rejects(
        () =>
          callReportAsServiceRole(db, {
            auth_subject: ACTORS.TEAM_LEADER.auth,
            app_user_id: ACTORS.TEAM_LEADER.app,
            from_date: minDate,
            to_date: maxDate,
            employee_id: crossEmployeeId,
          }),
        (err) =>
          err.code === "42501" &&
          String(err.message).includes("ATTENDANCE_REPORT_ACCESS_DENIED"),
      );
    }

    // 10d. Photo access: TEAM_LEADER can read TEAM_ALPHA check-in photos (STAFF_A + self), denied 42501 on TEAM_BETA check-in photo
    const tlAlphaPhoto = await callPhotoAsServiceRole(db, {
      auth_subject: ACTORS.TEAM_LEADER.auth,
      app_user_id: ACTORS.TEAM_LEADER.app,
      checkin_id: c0PreHq.checkin_id,
    });
    assert.equal(tlAlphaPhoto.found, true);

    const tlSelfPhoto = await callPhotoAsServiceRole(db, {
      auth_subject: ACTORS.TEAM_LEADER.auth,
      app_user_id: ACTORS.TEAM_LEADER.app,
      checkin_id: cLeaderAlpha.checkin_id,
    });
    assert.equal(tlSelfPhoto.found, true);

    await assert.rejects(
      () =>
        callPhotoAsServiceRole(db, {
          auth_subject: ACTORS.TEAM_LEADER.auth,
          app_user_id: ACTORS.TEAM_LEADER.app,
          checkin_id: c2OffsetV1.checkin_id, // belongs to STAFF_B (TEAM_BETA)
        }),
      (err) =>
        err.code === "42501" &&
        String(err.message).includes("ATTENDANCE_REPORT_ACCESS_DENIED"),
      "Team Leader must receive 42501 (not found:false) for another team's check-in photo",
    );

    // 10e. Provisioned TEAM_LEADER is still denied on attendance_set_hq_location
    await assert.rejects(
      () =>
        callSetHqAsServiceRole(db, {
          auth_subject: ACTORS.TEAM_LEADER.auth,
          app_user_id: ACTORS.TEAM_LEADER.app,
          latitude: HQ_HANOI.latitude,
          longitude: HQ_HANOI.longitude,
          expected_version: 2,
          idempotency_key: nextUuid(),
        }),
      (err) => err.code === "42501",
    );

    // 10f. When STAFF_A transfers from TEAM_ALPHA to TEAM_BETA, TEAM_ALPHA leader immediately loses access to STAFF_A's rows & photos
    await db.query(
      `update public.recruiter_team_memberships
          set team_id = $2::uuid
        where recruiter_id = $1::uuid
          and is_current = true`,
      [ACTORS.STAFF_A.recruiter, TEAM_BETA],
    );
    const tlAfterTransfer = await callReportAsServiceRole(db, {
      auth_subject: ACTORS.TEAM_LEADER.auth,
      app_user_id: ACTORS.TEAM_LEADER.app,
      from_date: minDate,
      to_date: maxDate,
    });
    assert.deepEqual(
      tlAfterTransfer.employee_options.map((opt) => opt.app_user_id),
      [ACTORS.TEAM_LEADER.app],
    );
    assert.equal(tlAfterTransfer.overview.total_checkins, 1);
    assert.equal(tlAfterTransfer.pagination.total_rows, 1);
    await assert.rejects(
      () =>
        callPhotoAsServiceRole(db, {
          auth_subject: ACTORS.TEAM_LEADER.auth,
          app_user_id: ACTORS.TEAM_LEADER.app,
          checkin_id: c0PreHq.checkin_id,
        }),
      (err) =>
        err.code === "42501" &&
        String(err.message).includes("ATTENDANCE_REPORT_ACCESS_DENIED"),
    );
    // Restore STAFF_A to TEAM_ALPHA
    await db.query(
      `update public.recruiter_team_memberships
          set team_id = $2::uuid
        where recruiter_id = $1::uuid
          and is_current = true`,
      [ACTORS.STAFF_A.recruiter, TEAM_ALPHA],
    );

    // 10g. Missing report bundle (report_view or report_analytics_view) or revoked leader assignment / link / membership / duplicate assignment fails closed with 42501
    for (const missingCap of ["report_view", "report_analytics_view"]) {
      await db.query(
        `update public.direct_entry_capability_grants
            set is_current = false
          where app_user_id = $1::uuid
            and capability = $2`,
        [ACTORS.TEAM_LEADER.app, missingCap],
      );
      await assert.rejects(
        () =>
          callReportAsServiceRole(db, {
            auth_subject: ACTORS.TEAM_LEADER.auth,
            app_user_id: ACTORS.TEAM_LEADER.app,
          }),
        (err) =>
          err.code === "42501" &&
          String(err.message).includes("ATTENDANCE_REPORT_ACCESS_DENIED"),
        `Team Leader missing ${missingCap} must fail closed`,
      );
      await db.query(
        `update public.direct_entry_capability_grants
            set is_current = true
          where app_user_id = $1::uuid
            and capability = $2`,
        [ACTORS.TEAM_LEADER.app, missingCap],
      );
    }

    // Revoke direct_entry_team_leader_assignments -> immediate 42501
    await db.query(
      `update public.direct_entry_team_leader_assignments
          set is_current = false
        where leader_app_user_id = $1::uuid`,
      [ACTORS.TEAM_LEADER.app],
    );
    await assert.rejects(
      () =>
        callReportAsServiceRole(db, {
          auth_subject: ACTORS.TEAM_LEADER.auth,
          app_user_id: ACTORS.TEAM_LEADER.app,
        }),
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

    // Revoke verified recruiter link -> immediate 42501
    await db.query(
      "alter table public.direct_entry_app_user_recruiter_links disable trigger user",
    );
    await db.query(
      `update public.direct_entry_app_user_recruiter_links
          set verified = false
        where app_user_id = $1::uuid`,
      [ACTORS.TEAM_LEADER.app],
    );
    await db.query(
      "alter table public.direct_entry_app_user_recruiter_links enable trigger user",
    );
    await assert.rejects(
      () =>
        callReportAsServiceRole(db, {
          auth_subject: ACTORS.TEAM_LEADER.auth,
          app_user_id: ACTORS.TEAM_LEADER.app,
        }),
      (err) =>
        err.code === "42501" &&
        String(err.message).includes("ATTENDANCE_REPORT_ACCESS_DENIED"),
    );
    await db.query(
      "alter table public.direct_entry_app_user_recruiter_links disable trigger user",
    );
    await db.query(
      `update public.direct_entry_app_user_recruiter_links
          set verified = true
        where app_user_id = $1::uuid`,
      [ACTORS.TEAM_LEADER.app],
    );
    await db.query(
      "alter table public.direct_entry_app_user_recruiter_links enable trigger user",
    );

    // Ambiguous / multi-team scope for leader -> fail closed with 42501
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)`,
      [ACTORS.TEAM_LEADER.app, TEAM_BETA],
    );
    await assert.rejects(
      () =>
        callReportAsServiceRole(db, {
          auth_subject: ACTORS.TEAM_LEADER.auth,
          app_user_id: ACTORS.TEAM_LEADER.app,
        }),
      (err) =>
        err.code === "42501" &&
        String(err.message).includes("ATTENDANCE_REPORT_ACCESS_DENIED"),
    );
    await db.query(
      "delete from public.direct_entry_scope_grants where app_user_id = $1::uuid and team_id = $2::uuid",
      [ACTORS.TEAM_LEADER.app, TEAM_BETA],
    );
  } finally {
    await db.close();
  }
});
