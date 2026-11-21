/**
 * WP9 — Org Obligations (S6): Attendance & Work Reports
 * PGlite End-to-End Verification Suite.
 *
 * Covers:
 *   1. Migration hygiene & relative dependency order: 0 `@`, 0 literal `SAVEPOINT`, 0 `'40001'`,
 *      LF checksum, atomic rollback zero drift, dynamic S0-T1-C allowlist postconditions (+0 net
 *      new service_role RPCs relative to applied prefix), 0 client/PUBLIC grants, STABLE volatility
 *      on helpers/probes, and `direct_entry_catalog_bootstrap_executor` grant preservation on
 *      `leave_management__internal_resolve_authority`.
 *   2. Attendance Day-Boundary Matrix & Employment Status (UAT-WP9-01..03, D10, R5, DEC-T0-03,
 *      WP9-GAP01..03):
 *      - Before `joined_on` vs on `joined_on` vs in-period (`E_New`, linked retroactively ->
 *        zero inferred start date from `link.started_at` or `created_at`).
 *      - `E_Resigned` (`Person INACTIVE`, `deactivated_at`): pre-exit real history AND real
 *        pre-exit MISSING preserved; exit-day morning check-in visible with 0 fake MISSING;
 *        post-exit days 0 fake MISSING & `— Ngoài phạm vi` via UI model; next month excluded;
 *        blocked on new check-in / idempotency / branch & slot pickers & writes / non-obligated
 *        explanation submit.
 *      - `E_DisabledOnly` (`Person ACTIVE`, `enabled = false` per D10/R5): NOT treated as resigned,
 *        stays obligated in matrix; contrasted with old unlinked disabled account (excluded).
 *      - `E_MissingDate` (`Person ACTIVE`, `joined_on IS NULL` per DEC-T0-03) & `UNLINKED_NORMAL`
 *        (UAT-WP9-02): NOT auto-excluded, zero fabricated start date.
 *      - `CONFLICT_PERSON_SHARED` (WP9-GAP03 / D-WP7B-03): ACTIVE linked Person with stale
 *        `leave_employee_profiles.is_shared_non_employee = true` aligned across check-in,
 *        matrix, `leave_management_get_actor_access` (READ ONLY), explanations overview, and
 *        real explanation submit (without mutating the legacy flag).
 *      - Role mutation (`ADMIN` / `HR_OPERATOR` / `RECRUITER`) produces ZERO obligation drift.
 *      - Future-only slot policy fallback consistency (`attendance_monthly_matrix_report` matches
 *        `attendance__internal_resolve_employee_slot_policy`).
 *   3. Work Reports Special Accounts, Disabled/Inactive Targets, Role Isolation, Disabled Revoke,
 *      & Read-Only Nav Probe Parity (UAT-WP9-01..02, WP9-GAP04..05, R7):
 *      - `SHARED`, `SERVICE`, unconflicted legacy shared, `INACTIVE` Person, and `DISABLED`
 *        blocked from pickers, new `USER`/`USER_SET`/`GROUP`/delegation creation, and all 3
 *        materializers while preserving historical obligations/submissions/snapshots.
 *      - `work_report_has_active_obligations` runs inside `BEGIN TRANSACTION READ ONLY` with
 *        0 writes and 100% strict-boolean parity against `work_report_list_my_obligations`.
 *      - Managed `SERVICE` read-only (`D2-SERVICE-READ-01`) preserved.
 *      - Full Admin (`all` scope) can PAUSE/REVOKE `USER` assignment after target disable/team exit;
 *        team-scoped TL still fails closed (`42501`).
 *   4. Work Reports As-Of Team Transfer, GROUP Join-Date & Atomic Fail-Closed Contract,
 *      ONCE Singleton, ARCHIVED Guard, & CANCELLED/EXEMPTED Parity (UAT-WP9-04, WP9-GAP06..07, R6).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  S0_T1_C_MIGRATION_NAME,
  migrationChecksum,
  migrationSqlForTransaction,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";
import { projectAttendanceMonthlyMatrixReport } from "../src/lib/attendance/attendance-monthly-matrix-contract.ts";
import {
  describeMatrixDayCell,
  MATRIX_OUT_OF_SCOPE_LABEL,
} from "../src/lib/attendance/attendance-monthly-matrix-ui-model.ts";
import {
  buildAttendanceMonthlyMatrixXlsx,
  formatMatrixDayCellText,
} from "../src/lib/attendance/attendance-monthly-matrix-xlsx.ts";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP7B_MIGRATION_NAME = "20261119180000_wp7b_attendance_org_scope_and_leave_nav_probe.sql";
const WP8D_MIGRATION_NAME = "20261120140000_wp8d_nav_readonly.sql";
const WP8D2_MIGRATION_NAME = "20261120170000_wp8d2_work_report_access.sql";
const WP9_MIGRATION_NAME = "20261121090000_wp9_org_obligations.sql";

const ROLE_PREAMBLE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = { auth: "19000000-0000-4000-8000-000000000001", app: "29000000-0000-4000-8000-000000000001", email: "nobita6986@gmail.com", name: "Canonical Owner" };
const LUANPT = { auth: "19000000-0000-4000-8000-000000000002", app: "29000000-0000-4000-8000-000000000002", email: "luanpt@hrpartner.vn", name: "Luan PT" };
const LIENVU = { auth: "19000000-0000-4000-8000-000000000003", app: "29000000-0000-4000-8000-000000000003", email: "lienvu@hrpartner.vn", name: "Lien Vu" };
const NGATTT = { auth: "19000000-0000-4000-8000-000000000004", app: "29000000-0000-4000-8000-000000000004", email: "ngattt@hrpartner.vn", name: "Nga TTT" };

const TL_A = { auth: "19000000-0000-4000-8000-000000000010", app: "29000000-0000-4000-8000-000000000010", rec: "39000000-0000-4000-8000-000000000010", email: "tl.a@hrpartner.vn", name: "TL Team A" };
const E_NEW = { auth: "19000000-0000-4000-8000-000000000011", app: "29000000-0000-4000-8000-000000000011", rec: "39000000-0000-4000-8000-000000000011", email: "e.new@hrpartner.vn", name: "Nhân viên Mới" };
const E_RESIGNED = { auth: "19000000-0000-4000-8000-000000000012", app: "29000000-0000-4000-8000-000000000012", rec: "39000000-0000-4000-8000-000000000012", email: "e.resigned@hrpartner.vn", name: "Nhân viên Đã Nghỉ" };
const E_DISABLED_ONLY = { auth: "19000000-0000-4000-8000-000000000013", app: "29000000-0000-4000-8000-000000000013", rec: "39000000-0000-4000-8000-000000000013", email: "e.disabled@hrpartner.vn", name: "Nhân viên Khóa TK" };
const E_OLD_DISABLED_UNLINKED = { auth: "19000000-0000-4000-8000-000000000014", app: "29000000-0000-4000-8000-000000000014", email: "old.disabled@hrpartner.vn", name: "TK Cũ Đã Khóa" };
const E_MISSING_DATE = { auth: "19000000-0000-4000-8000-000000000015", app: "29000000-0000-4000-8000-000000000015", email: "e.missingdate@hrpartner.vn", name: "Nhân viên Thiếu Ngày" };
const UNLINKED_NORMAL = { auth: "19000000-0000-4000-8000-000000000016", app: "29000000-0000-4000-8000-000000000016", rec: "39000000-0000-4000-8000-000000000016", email: "unlinked.normal@hrpartner.vn", name: "NV Chưa Link Person" };
const CONFLICT_PERSON_SHARED = { auth: "19000000-0000-4000-8000-000000000017", app: "29000000-0000-4000-8000-000000000017", rec: "39000000-0000-4000-8000-000000000017", email: "conflict.person@hrpartner.vn", name: "NV Xung Đột Cờ Shared" };
const SHARED_ACC = { auth: "19000000-0000-4000-8000-000000000018", app: "29000000-0000-4000-8000-000000000018", rec: "39000000-0000-4000-8000-000000000018", email: "shared.kiosk@hrpartner.vn", name: "Tài khoản Dùng Chung" };
const SERVICE_ACC = { auth: "19000000-0000-4000-8000-000000000019", app: "29000000-0000-4000-8000-000000000019", email: "svc.bod@hrpartner.vn", name: "Service Account BoD" };
const LEGACY_SHARED_NORMAL = { auth: "19000000-0000-4000-8000-000000000020", app: "29000000-0000-4000-8000-000000000020", rec: "39000000-0000-4000-8000-000000000020", email: "legacy.shared@hrpartner.vn", name: "Legacy Shared Normal" };
const E_TRANSFER = { auth: "19000000-0000-4000-8000-000000000021", app: "29000000-0000-4000-8000-000000000021", rec: "39000000-0000-4000-8000-000000000021", email: "e.transfer@hrpartner.vn", name: "NV Chuyển Team" };
const E_ROLE_ISOLATION = { auth: "19000000-0000-4000-8000-000000000022", app: "29000000-0000-4000-8000-000000000022", rec: "39000000-0000-4000-8000-000000000022", email: "e.roleiso@hrpartner.vn", name: "NV Độc Lập Role" };
const E_GROUP_ORIG = { auth: "19000000-0000-4000-8000-000000000023", app: "29000000-0000-4000-8000-000000000023", rec: "39000000-0000-4000-8000-000000000023", email: "e.grporig@hrpartner.vn", name: "NV Nhóm Gốc" };
const E_GROUP_ADDED = { auth: "19000000-0000-4000-8000-000000000024", app: "29000000-0000-4000-8000-000000000024", rec: "39000000-0000-4000-8000-000000000024", email: "e.grpadded@hrpartner.vn", name: "NV Nhóm Mới Thêm" };
const E_TEAM_B_ONLY = { auth: "19000000-0000-4000-8000-000000000025", app: "29000000-0000-4000-8000-000000000025", rec: "39000000-0000-4000-8000-000000000025", email: "e.teamb@hrpartner.vn", name: "NV Team B" };
const E_ONCE_EMP = { auth: "19000000-0000-4000-8000-000000000026", app: "29000000-0000-4000-8000-000000000026", rec: "39000000-0000-4000-8000-000000000026", email: "e.once@hrpartner.vn", name: "NV Báo Cáo Một Lần" };
const E_HIST_RECLASS = { auth: "19000000-0000-4000-8000-000000000027", app: "29000000-0000-4000-8000-000000000027", rec: "39000000-0000-4000-8000-000000000027", email: "e.histreclass@hrpartner.vn", name: "NV Lịch Sử Chuyển Shared" };

const TEAM_A = "49000000-0000-4000-8000-000000000001";
const TEAM_B = "49000000-0000-4000-8000-000000000002";

const VALID_SCHEMA = RECRUITMENT_DAILY_TEMPLATE_SCHEMA;
const VALID_METRIC_CONTRACT = buildWorkReportMetricContract(VALID_SCHEMA);

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `99000000-0000-4000-8000-${hex}`;
}
function nextKey(prefix) {
  return `${prefix}_${seq++}`;
}
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

let cachedMigrations = null;
async function loadMigrations() {
  if (cachedMigrations) return cachedMigrations;
  const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  cachedMigrations = await Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
  return cachedMigrations;
}

async function createDb({ stopBefore = null } = {}) {
  const migrations = await loadMigrations();
  const db = new PGlite();
  await db.exec(ROLE_PREAMBLE);
  for (const m of migrations) {
    if (stopBefore && m.name === stopBefore) break;
    await db.exec(m.sql);
  }
  return { db, migrations };
}

async function serviceRpc(db, fnName, args = [], { readOnly = false } = {}) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await db.exec(readOnly ? "begin transaction read only; set local role service_role;" : "begin; set local role service_role;");
  try {
    const res = await db.query(`select public.${fnName}(${placeholders}) as data`, args);
    await db.exec("commit;");
    return res.rows[0]?.data;
  } catch (err) {
    await db.exec("rollback;");
    throw err;
  }
}

async function seedBaseUser(db, user, { enabled = true, accountType = "NORMAL" } = {}) {
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, account_type)
     values ($1::uuid, $2::uuid, $3, $4, $5)`,
    [user.app, user.auth, user.name, enabled, accountType],
  );
}

async function linkRecruiterAndTeam(db, user, teamId, validFrom = "2026-01-01") {
  await db.query(
    `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
     values ($1::uuid, $2, $3, 'STAFF', true)`,
    [user.rec, user.name, `REC_${user.rec.slice(-4)}`],
  );
  await db.query(
    `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
     values ($1::uuid, 'hrp', $2::date, true)`,
    [user.rec, validFrom],
  );
  await db.query(
    `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1::uuid, $2::uuid, true, $3::date, true)`,
    [user.app, user.rec, validFrom],
  );
  if (teamId) {
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::date, true)`,
      [user.rec, teamId, validFrom],
    );
  }
}

async function seedCheckin(db, appUserId, businessDate, timeLocalHHMM = "08:05") {
  const capturedAt = `${businessDate} ${timeLocalHHMM}:00+07`;
  const key = nextUuid();
  const { rows: [row] } = await db.query(
    `insert into public.attendance_checkins (
       app_user_id, business_date, sequence_in_day, latitude, longitude, accuracy_meters,
       address_hint, note, device_claimed_at, captured_at, received_at,
       time_source, time_verified, time_anchor_issued_at, elapsed_since_anchor_ms,
       sync_delay_seconds, time_token_digest, idempotency_key, request_fingerprint,
       photo_storage_key, photo_sha256, photo_size_bytes, photo_mime_type,
       distance_target_kind, distance_status, distance_meters
     )
     values (
       $1::uuid, $2::date,
       coalesce((select max(sequence_in_day) from public.attendance_checkins where app_user_id = $1::uuid and business_date = $2::date), 0) + 1,
       21.0285, 105.8542, 10, 'HQ', 'Test checkin',
       $3::timestamptz, $3::timestamptz, $3::timestamptz,
       'SERVER_ANCHORED', true, $3::timestamptz, 0,
       0, $8, $4::uuid, $5,
       $6, $7, 1024, 'image/jpeg', 'HQ', 'COMPUTED', 5.0
     )
     returning checkin_id`,
    [appUserId, businessDate, capturedAt, key, sha256(`fp:${key}`), `private/att/${key}.jpg`, sha256(`ph:${key}`), sha256(`tok:${key}`)],
  );
  return row.checkin_id;
}

async function createPublishedTemplate(db, actor, code, name, defaultFrequency = "DAILY") {
  const created = await serviceRpc(db, "work_report_create_template", [
    actor.auth, actor.app, code, name, `${name} desc`, defaultFrequency,
    JSON.stringify(VALID_SCHEMA), JSON.stringify(VALID_METRIC_CONTRACT), nextKey("tpl"),
  ]);
  await serviceRpc(db, "work_report_publish_template", [
    actor.auth, actor.app, created.template_id, created.draft_version_id, created.version, nextKey("pub"),
  ]);
  return created;
}

async function countWrTables(db) {
  const tables = [
    "work_report_obligations",
    "work_report_submissions",
    "work_report_submission_revisions",
    "work_report_audit_events",
    "work_report_assignments",
    "work_report_delegations",
  ];
  const counts = {};
  for (const t of tables) {
    const { rows: [{ cnt }] } = await db.query(`select count(*)::int as cnt from public.${t}`);
    counts[t] = cnt;
  }
  return counts;
}

async function setupCutoverCore(db) {
  for (const u of [OWNER, LUANPT, LIENVU, NGATTT]) {
    await seedBaseUser(db, u);
  }
  const adminCaps = [
    "entry_admin",
    "entry_team",
    "entry_own",
    "entry_create",
    "submission_create",
    "entry_privileged_edit",
    "entry_restore",
    "recruiter_master_manage",
    "team_master_manage",
    "audit_view",
    "worker_edit_history_view",
    "document_upload",
    "document_view",
    "employment_status.review",
    "employment_status.apply",
    "change_request_create",
    "change_review",
    "employment_status.request",
    "duplicate_cccd_withdraw",
  ];
  for (const adm of [OWNER, LIENVU, NGATTT]) {
    for (const cap of adminCaps) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, $2, '2026-01-01', true) on conflict do nothing`,
        [adm.app, cap],
      );
    }
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true), ($1::uuid, 'own', '2026-01-01', true) on conflict do nothing`,
      [adm.app],
    );
  }
  await db.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
     values ($1::uuid, 'all', '2026-01-01', true) on conflict do nothing`,
    [LUANPT.app],
  );
  await db.query(
    `insert into public.teams (team_id, code, display_name, active)
     values ($1::uuid, 'WP9_TEAM_A', 'Đội Tuyển dụng A', true),
            ($2::uuid, 'WP9_TEAM_B', 'Đội Tuyển dụng B', true)`,
    [TEAM_A, TEAM_B],
  );
  const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.equal(plan.action_diff.unexpected_diff_count, 0);
  const applied = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: plan.manifest_fingerprint,
  });
  assert.equal(applied.status, "APPLIED");
}

async function createLinkedPerson(db, target, { code, fullName, joinedOn, deptId }) {
  const { rows: [u] } = await db.query(
    "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
    [target.app],
  );
  const res = await serviceRpc(db, "org_department_create_person_admin", [
    OWNER.auth, OWNER.app, code, fullName, joinedOn, deptId, target.app, u.version,
    null, `Tạo hồ sơ ${code}`, nextUuid(), sha256(`person:${code}:${seq}`),
  ]);
  return res.person;
}

// ============================================================================
// TEST 1: Migration Hygiene, Relative Ordering, Rollback, Dynamic S0-T1-C ACLs (+0 Net)
// ============================================================================
test("WP9 [1/4]: Migration hygiene, relative dependency order, atomic rollback zero drift, dynamic S0-T1-C ACL postconditions (net +0 service_role RPCs, 0 client/PUBLIC), STABLE probes & bootstrap executor preservation", async () => {
  const { db, migrations } = await createDb({ stopBefore: WP9_MIGRATION_NAME });
  try {
    const wp7bIdx = migrations.findIndex((m) => m.name === WP7B_MIGRATION_NAME);
    const wp8dIdx = migrations.findIndex((m) => m.name === WP8D_MIGRATION_NAME);
    const wp8d2Idx = migrations.findIndex((m) => m.name === WP8D2_MIGRATION_NAME);
    const wp9Idx = migrations.findIndex((m) => m.name === WP9_MIGRATION_NAME);
    assert.ok(wp7bIdx >= 0, "WP7B migration must exist");
    assert.ok(wp8dIdx > wp7bIdx, "WP8D must follow WP7B");
    assert.ok(wp8d2Idx > wp8dIdx, "WP8D-2 must follow WP8D");
    assert.ok(wp9Idx > wp8d2Idx, "WP9 must follow WP8D-2");

    const s0Migration = migrations.find((m) => m.name === S0_T1_C_MIGRATION_NAME);
    assert.ok(s0Migration, "S0-T1-C ACL allowlist migration must exist");
    const wp9 = migrations[wp9Idx];
    assert.ok(wp9, "WP9 migration must exist");
    assert.equal(wp9.sql.includes("@"), false, "WP9 migration must contain 0 literal @");
    assert.equal(/savepoint/i.test(wp9.sql), false, "WP9 migration must contain 0 literal SAVEPOINT");
    assert.equal(wp9.sql.includes("'40001'"), false, "WP9 migration must use PT409 (never 40001)");
    assert.equal(/alter\s+default\s+privileges/i.test(wp9.sql), false, "WP9 migration must not use ALTER DEFAULT PRIVILEGES");

    const checksum = migrationChecksum(wp9.sql);
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.equal(migrationChecksum(wp9.sql.replace(/\n/g, "\r\n")), checksum, "LF-normalized checksum invariant");

    const beforeAppliedMap = new Map(
      migrations.slice(0, wp9Idx).map((m) => [m.name, migrationChecksum(m.sql)]),
    );
    const beforePost = await verifyS0T1CSecurityPostconditions(
      db,
      s0Migration.sql,
      beforeAppliedMap,
    );
    assert.equal(beforePost.ok, true, `Pre-WP9 S0-T1-C postconditions must pass: ${beforePost.reason ?? ""}`);
    assert.equal(beforePost.details.exposedClientOrPublicCount, 0);
    assert.equal(beforePost.details.missingOwnerExecCount, 0);
    assert.equal(beforePost.details.unsafeSecdefSearchPathCount, 0);
    assert.equal(beforePost.details.bootstrapExecutorIntact, true);
    assert.equal(beforePost.details.actualServiceCount, beforePost.details.expectedServiceCount);

    const { rows: [{ cnt: beforeSrCount }] } = await db.query(
      `select count(*)::int as cnt
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    );
    assert.equal(
      beforeSrCount,
      beforePost.details.actualServiceCount,
      "Baseline public service_role RPC count must match dynamic S0-T1-C allowlist for applied prefix",
    );

    await db.exec(`
      create table if not exists public.schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      );
    `);

    const failingSql = `${migrationSqlForTransaction(wp9.sql)}\nselect 1 / 0;\n`;
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(failingSql);
          await db.query("insert into public.schema_migrations (version, checksum) values ($1, $2)", [wp9.name, checksum]);
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      (err) => err.code === "22012",
    );

    const { rows: [{ n: rollbackNewFn }] } = await db.query(
      `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname in (
          'attendance__internal_is_person_inactive_as_of',
          'attendance__internal_is_employee_obligated_on_date',
          'attendance__internal_is_employee_slot_obligated',
          'work_report__internal_team_on_date',
          'work_report__internal_enforce_once_obligation'
        )`,
    );
    assert.equal(rollbackNewFn, 0, "Rolled-back WP9 migration leaves zero new helpers");

    const { rows: [{ n: rollbackTrig }] } = await db.query(
      `select count(*)::int as n from pg_trigger
        where tgname = 'work_report_obligations_once_singleton_guard'`,
    );
    assert.equal(rollbackTrig, 0, "Rolled-back WP9 migration leaves zero new trigger");

    const { rows: [{ cnt: afterRollbackSrCount }] } = await db.query(
      `select count(*)::int as cnt
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    );
    assert.equal(afterRollbackSrCount, beforeSrCount, "Rolled-back WP9 migration preserves exact pre-WP9 service_role count");

    // Clean apply
    await db.exec(wp9.sql);

    const afterAppliedMap = new Map(beforeAppliedMap);
    afterAppliedMap.set(wp9.name, checksum);
    const afterPost = await verifyS0T1CSecurityPostconditions(
      db,
      s0Migration.sql,
      afterAppliedMap,
    );
    assert.equal(afterPost.ok, true, `Post-WP9 S0-T1-C postconditions must pass: ${afterPost.reason ?? ""}`);
    assert.equal(afterPost.details.exposedClientOrPublicCount, 0);
    assert.equal(afterPost.details.missingOwnerExecCount, 0);
    assert.equal(afterPost.details.unsafeSecdefSearchPathCount, 0);
    assert.equal(afterPost.details.bootstrapExecutorIntact, true);
    assert.equal(afterPost.details.actualServiceCount, afterPost.details.expectedServiceCount);
    assert.equal(
      afterPost.details.actualServiceCount,
      beforePost.details.actualServiceCount,
      "WP9 adds net +0 service_role RPCs relative to applied prefix",
    );

    const { rows: [{ cnt: afterSrCount }] } = await db.query(
      `select count(*)::int as cnt
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and has_function_privilege('service_role', p.oid, 'EXECUTE')`,
    );
    assert.equal(afterSrCount, beforeSrCount, "WP9 adds net +0 new service_role RPCs");

    const { rows: [{ cnt: exposedClient }] } = await db.query(
      `select count(*)::int as cnt
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (
            has_function_privilege('public', p.oid, 'EXECUTE')
            or has_function_privilege('anon', p.oid, 'EXECUTE')
            or has_function_privilege('authenticated', p.oid, 'EXECUTE')
          )`,
    );
    assert.equal(exposedClient, 0, "Zero PUBLIC/anon/authenticated EXECUTE grants across public schema");

    // Verify all 15 internal/trigger WP9 helpers are revoked from service_role/client/PUBLIC & have expected volatility
    const helperChecks = [
      ["public.attendance__internal_is_non_employee_account(uuid,timestamptz)", "s"],
      ["public.attendance__internal_is_person_inactive_as_of(uuid,timestamptz)", "s"],
      ["public.attendance__internal_is_employee_obligated_on_date(uuid,date,date,timestamptz)", "s"],
      ["public.attendance__internal_is_employee_slot_obligated(uuid,date,timestamptz,date,timestamptz)", "s"],
      ["public.work_report__internal_team_on_date(uuid,date)", "s"],
      ["public.leave_management__internal_resolve_authority(uuid,uuid)", "s"],
      ["public.work_report__internal_is_eligible_assignee(uuid)", "s"],
      ["public.work_report_assert_actor(uuid,uuid,text)", "s"],
      ["public.work_report__internal_actor_materialization_candidates(uuid,date,integer)", "s"],
      ["public.work_report__internal_has_active_obligations_for_date(uuid,date,integer)", "s"],
      ["public.work_report__internal_is_delegation_effective(uuid,timestamptz)", "s"],
      ["public.attendance_explanation__internal_evaluate_employee_day_slots(uuid,date)", "v"],
      ["public.work_report__internal_materialize_actor_obligations(uuid,date,integer)", "v"],
      ["public.work_report__internal_materialize_assignment_for_date(uuid,date)", "v"],
      ["public.work_report__internal_enforce_once_obligation()", "v"],
    ];
    for (const [sig, expectedVol] of helperChecks) {
      const { rows: [r] } = await db.query(
        `select p.provolatile, p.prosecdef,
                has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as sr_exec
           from pg_proc p where p.oid = $1::regprocedure`,
        [sig],
      );
      assert.equal(r.provolatile, expectedVol, `${sig} volatility`);
      assert.equal(r.prosecdef, true, `${sig} must be SECURITY DEFINER`);
      assert.equal(r.pub_exec, false, `${sig} PUBLIC denied`);
      assert.equal(r.anon_exec, false, `${sig} anon denied`);
      assert.equal(r.auth_exec, false, `${sig} authenticated denied`);
      assert.equal(r.sr_exec, false, `${sig} service_role denied`);
    }

    // Verify all 18 service_role WP9 RPCs have SECURITY DEFINER, service_role EXECUTE, and 0 client/PUBLIC grants
    const serviceRpcChecks = [
      "public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)",
      "public.attendance_record_checkin(uuid,uuid,uuid,text,double precision,double precision,double precision,text,text,timestamptz,text,timestamptz,bigint,text,text,text,integer,text,timestamptz)",
      "public.attendance_lookup_checkin_idempotency(uuid,uuid,uuid,text)",
      "public.attendance_list_branches_admin(uuid,uuid,boolean)",
      "public.attendance_assign_employee_branch_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)",
      "public.attendance_get_slot_policies_admin(uuid,uuid)",
      "public.attendance_assign_employee_slot_policy_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)",
      "public.work_report_ensure_obligations_for_window(uuid,uuid,date)",
      "public.work_report_create_assignment(uuid,uuid,uuid,text,uuid,uuid,uuid[],text,boolean,integer,time without time zone,boolean,date,date,text)",
      "public.work_report_list_assignment_options(uuid,uuid,uuid)",
      "public.work_report_list_assignments(uuid,uuid,uuid)",
      "public.work_report_set_assignment_state(uuid,uuid,uuid,integer,text,text)",
      "public.work_report_create_group(uuid,uuid,text,text,uuid[],text)",
      "public.work_report_update_group(uuid,uuid,uuid,integer,text,text,uuid[],text)",
      "public.work_report_set_group_active(uuid,uuid,uuid,integer,boolean,text)",
      "public.work_report_create_group_assignment(uuid,uuid,uuid,uuid,text,boolean,integer,time without time zone,boolean,date,date,text)",
      "public.work_report_create_delegation(uuid,uuid,text,uuid,uuid,text,uuid,timestamptz,timestamptz,text)",
      "public.work_report_list_delegations(uuid,uuid)",
    ];
    for (const sig of serviceRpcChecks) {
      const { rows: [r] } = await db.query(
        `select p.prosecdef,
                has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as sr_exec
           from pg_proc p where p.oid = $1::regprocedure`,
        [sig],
      );
      assert.equal(r.prosecdef, true, `${sig} must be SECURITY DEFINER`);
      assert.equal(r.pub_exec, false, `${sig} PUBLIC denied`);
      assert.equal(r.anon_exec, false, `${sig} anon denied`);
      assert.equal(r.auth_exec, false, `${sig} authenticated denied`);
      assert.equal(r.sr_exec, true, `${sig} service_role allowed`);
    }

    // Verify ONCE singleton guard trigger is enabled ('O') on public.work_report_obligations
    const { rows: [onceTrig] } = await db.query(
      `select t.tgenabled, t.tgfoid::regprocedure::text as fn_sig
         from pg_trigger t
        where t.tgrelid = 'public.work_report_obligations'::regclass
          and t.tgname = 'work_report_obligations_once_singleton_guard'
          and not t.tgisinternal`,
    );
    assert.equal(onceTrig.tgenabled, "O");
    assert.equal(onceTrig.fn_sig, "work_report__internal_enforce_once_obligation()");

    // Preserve direct_entry_catalog_bootstrap_executor EXECUTE grant on leave_management__internal_resolve_authority
    const { rows: [leaveAuthAcl] } = await db.query(
      `select p.provolatile, p.prosecdef,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as sr_exec,
              has_function_privilege('direct_entry_catalog_bootstrap_executor', p.oid, 'EXECUTE') as boot_exec
         from pg_proc p
        where p.oid = 'public.leave_management__internal_resolve_authority(uuid,uuid)'::regprocedure`,
    );
    assert.equal(leaveAuthAcl.provolatile, "s");
    assert.equal(leaveAuthAcl.prosecdef, true);
    assert.equal(leaveAuthAcl.sr_exec, false);
    assert.equal(leaveAuthAcl.boot_exec, true, "direct_entry_catalog_bootstrap_executor EXECUTE grant must be preserved");
  } finally {
    await db.close();
  }
});

// ============================================================================
// TEST 2: Attendance Day Boundaries, Employment Status, D10, Conflict, Role Isolation
// ============================================================================
test("WP9 [2/4]: Attendance day-boundary matrix (joined_on, INACTIVE pre/on/post exit, D10 disabled active Person, DEC-T0-03 missing date & unlinked NORMAL, GAP03 conflict explanation, role isolation & future-only policy fallback)", async () => {
  const { db } = await createDb();
  try {
    await setupCutoverCore(db);

    const { rows: [mktDept] } = await db.query(
      "select department_id from public.organization_departments where system_key = 'MARKETING'",
    );
    assert.ok(mktDept?.department_id, "Seeded MARKETING department must exist");

    for (const u of [
      E_NEW, E_RESIGNED, E_DISABLED_ONLY, E_OLD_DISABLED_UNLINKED,
      E_MISSING_DATE, UNLINKED_NORMAL, CONFLICT_PERSON_SHARED,
      SHARED_ACC, SERVICE_ACC, LEGACY_SHARED_NORMAL, E_ROLE_ISOLATION,
    ]) {
      await seedBaseUser(db, u, {
        enabled: u !== E_OLD_DISABLED_UNLINKED,
        accountType: u === SHARED_ACC ? "SHARED" : u === SERVICE_ACC ? "SERVICE" : "NORMAL",
      });
    }

    // Seed legacy shared flags on LEGACY_SHARED_NORMAL and CONFLICT_PERSON_SHARED
    await db.exec("alter table public.leave_employee_profiles disable trigger user;");
    for (const u of [LEGACY_SHARED_NORMAL, CONFLICT_PERSON_SHARED]) {
      await db.query(
        `insert into public.leave_employee_profiles (
           app_user_id, is_shared_non_employee, employment_status, unit_kind, work_start_date, row_version, updated_by_app_user_id
         ) values ($1::uuid, true, 'OFFICIAL', 'MARKETING', '2026-01-01', 1, $2::uuid)
         on conflict (app_user_id) do update set is_shared_non_employee = true`,
        [u.app, OWNER.app],
      );
    }
    await db.exec("alter table public.leave_employee_profiles enable trigger user;");

    const pNew = await createLinkedPerson(db, E_NEW, { code: "WP9-NEW", fullName: "Nguyễn Mới Gia Nhập", joinedOn: "2026-10-15", deptId: mktDept.department_id });
    const pResigned = await createLinkedPerson(db, E_RESIGNED, { code: "WP9-RES", fullName: "Trần Đã Nghỉ Việc", joinedOn: "2026-01-01", deptId: mktDept.department_id });
    const pDisabledOnly = await createLinkedPerson(db, E_DISABLED_ONLY, { code: "WP9-DIS", fullName: "Lê Khóa Đăng Nhập", joinedOn: "2026-10-01", deptId: mktDept.department_id });
    const pMissingDate = await createLinkedPerson(db, E_MISSING_DATE, { code: "WP9-NODATE", fullName: "Phạm Thiếu Ngày", joinedOn: null, deptId: mktDept.department_id });
    const pConflict = await createLinkedPerson(db, CONFLICT_PERSON_SHARED, { code: "WP9-CONF", fullName: "Hoàng Xung Đột Shared", joinedOn: "2026-10-01", deptId: mktDept.department_id });
    const pRoleIso = await createLinkedPerson(db, E_ROLE_ISOLATION, { code: "WP9-RISO", fullName: "Đỗ Độc Lập Role", joinedOn: "2026-10-01", deptId: mktDept.department_id });

    // Re-set stale is_shared_non_employee = true on CONFLICT_PERSON_SHARED (simulating legacy drift)
    await db.exec("alter table public.leave_employee_profiles disable trigger user;");
    await db.query(
      "update public.leave_employee_profiles set is_shared_non_employee = true where app_user_id = $1::uuid",
      [CONFLICT_PERSON_SHARED.app],
    );
    await db.exec("alter table public.leave_employee_profiles enable trigger user;");

    // Backdate links/memberships cleanly for October 2026 testing:
    // - E_NEW & E_MISSING_DATE links intentionally have started_at = '2026-10-20' (AFTER 15/10 and 01/10)
    //   to prove we NEVER infer start date from link.started_at (DEC-T0-03)!
    await db.exec(`
      alter table public.organization_account_person_links disable trigger user;
      alter table public.organization_person_department_memberships disable trigger user;
    `);
    await db.query(
      `update public.organization_account_person_links
          set started_at = case
            when app_user_id in ($1::uuid, $2::uuid) then '2026-10-20 09:00:00+07'::timestamptz
            else '2026-10-01 00:00:00+07'::timestamptz
          end`,
      [E_NEW.app, E_MISSING_DATE.app],
    );
    await db.query(
      "update public.organization_person_department_memberships set started_at = '2026-10-01 00:00:00+07'::timestamptz",
    );
    await db.exec(`
      alter table public.organization_account_person_links enable trigger user;
      alter table public.organization_person_department_memberships enable trigger user;
    `);

    // E_NEW checks in on join date 2026-10-15
    await seedCheckin(db, E_NEW.app, "2026-10-15", "08:05");

    // E_RESIGNED: real check-ins 01..08, REAL absence on 09, full morning check-ins on exit day 10 (07:35 & 10:05)
    for (let d = 1; d <= 8; d += 1) {
      await seedCheckin(db, E_RESIGNED.app, `2026-10-${String(d).padStart(2, "0")}`, "08:05");
    }
    await seedCheckin(db, E_RESIGNED.app, "2026-10-10", "07:35");
    await seedCheckin(db, E_RESIGNED.app, "2026-10-10", "10:05");

    // Deactivate E_RESIGNED via canonical RPC, then pin deactivated_at = 2026-10-10 12:00+07 for noon cutoff proof
    const { rows: [pResVer] } = await db.query(
      "select version from public.organization_persons where person_id = $1::uuid",
      [pResigned.person_id],
    );
    await serviceRpc(db, "org_department_update_person_admin", [
      OWNER.auth, OWNER.app, pResigned.person_id, pResVer.version, "WP9-RES", "Trần Đã Nghỉ Việc", "2026-01-01",
      "INACTIVE", "Nghỉ việc từ 10/10 12:00", nextUuid(), sha256("deact-resigned"),
    ]);
    await db.query(
      "update public.organization_persons set deactivated_at = '2026-10-10 12:00:00+07'::timestamptz where person_id = $1::uuid",
      [pResigned.person_id],
    );

    // Disable E_DISABLED_ONLY login ONLY (Person stays ACTIVE — D10/R5)
    await db.query("update public.direct_entry_app_users set enabled = false where app_user_id = $1::uuid", [E_DISABLED_ONLY.app]);

    // Query October 2026 matrix (all days < today_vn 2026-11-21)
    const octRaw = await serviceRpc(db, "attendance_monthly_matrix_report", [
      OWNER.auth, OWNER.app, "2026-10", null, null, null, 1, 100,
    ]);
    const oct = projectAttendanceMonthlyMatrixReport(octRaw);
    assert.ok(oct, "October matrix must pass strict contract parser");
    const byId = new Map(oct.items.map((row) => [row.app_user_id, row]));

    // (a) E_NEW: 01..14 -> 0 fake MISSING, UI renders '— Ngoài phạm vi'; 15 -> CHECKED_IN; 16..31 -> 16 missing days
    const rowNew = byId.get(E_NEW.app);
    assert.ok(rowNew, "E_NEW must appear in 2026-10");
    for (let d = 1; d <= 14; d += 1) {
      const dateStr = `2026-10-${String(d).padStart(2, "0")}`;
      const cell = rowNew.days.find((x) => x.business_date === dateStr);
      assert.equal(cell.day_status, "UPCOMING", `E_NEW pre-join ${dateStr} must not be NO_CHECKIN`);
      assert.equal(cell.missing_slot_count, 0, `E_NEW pre-join ${dateStr} must have 0 missing slots`);
      const uiCell = describeMatrixDayCell(cell, { todayBusinessDate: "2026-11-21" });
      assert.equal(uiCell.isOutOfScopeOrExempt, true, `UI/XLSX cell on pre-join ${dateStr} must be out-of-scope/exempt`);
      assert.equal(uiCell.isRedHighlight, false, `UI/XLSX cell on pre-join ${dateStr} must not highlight red`);
      assert.equal(uiCell.statusLabel, MATRIX_OUT_OF_SCOPE_LABEL, `UI/XLSX cell on pre-join ${dateStr} must render ${MATRIX_OUT_OF_SCOPE_LABEL}`);
    }
    const day15New = rowNew.days.find((x) => x.business_date === "2026-10-15");
    assert.equal(day15New.day_status, "CHECKED_IN", "E_NEW join date check-in preserved");
    assert.equal(rowNew.summary.checkin_day_count, 1);
    assert.equal(rowNew.summary.no_checkin_day_count, 16, "E_NEW missing count strictly covers 16..31 (16 days), NOT 01..14");

    // E_NEW in 2026-09 (all days < joined_on, 0 check-ins) -> excluded!
    const sepRaw = await serviceRpc(db, "attendance_monthly_matrix_report", [
      OWNER.auth, OWNER.app, "2026-09", null, null, null, 1, 100,
    ]);
    assert.equal(sepRaw.items.some((r) => r.app_user_id === E_NEW.app), false, "E_NEW excluded from month entirely before joined_on");

    // (b) E_RESIGNED: 01..08 CHECKED_IN, 09 REAL MISSING preserved, 10 exit-day morning CHECKED_IN + 0 missing, 11..31 0 fake MISSING
    const rowRes = byId.get(E_RESIGNED.app);
    assert.ok(rowRes, "E_RESIGNED must appear in exit month 2026-10");
    assert.equal(rowRes.summary.checkin_day_count, 9, "All 9 historical check-in days (01..08 + exit day 10) preserved");
    assert.equal(rowRes.summary.no_checkin_day_count, 1, "Exact 1 real pre-exit missing day (09/10); ZERO post-exit fake missing");
    assert.equal(rowRes.days.find((x) => x.business_date === "2026-10-09").day_status, "NO_CHECKIN", "Pre-exit real absence 09/10 preserved");
    const day10Res = rowRes.days.find((x) => x.business_date === "2026-10-10");
    assert.equal(day10Res.day_status, "CHECKED_IN", "Exit day 10/10 morning check-ins preserved");
    assert.equal(day10Res.missing_slot_count, 0, "Exit day 10/10 with both AM check-ins before 12:00 has 0 MISSING");
    assert.deepEqual(
      day10Res.slots.map((s) => `${s.slot_code}:${s.slot_status}`),
      ["SLOT_1:ON_TIME", "SLOT_2:ON_TIME", "SLOT_3:UPCOMING", "SLOT_4:UPCOMING", "SLOT_5:UPCOMING"],
      "Exit day 10/10 noon cutoff preserves ON_TIME morning slots and exempts post-cutoff PM slots",
    );
    for (let d = 11; d <= 31; d += 1) {
      const dateStr = `2026-10-${String(d).padStart(2, "0")}`;
      const cell = rowRes.days.find((x) => x.business_date === dateStr);
      assert.equal(cell.day_status, "UPCOMING", `Post-exit ${dateStr} must not be NO_CHECKIN`);
      assert.equal(cell.missing_slot_count, 0, `Post-exit ${dateStr} must have 0 fake missing slots`);
      const postCell = describeMatrixDayCell(cell, { todayBusinessDate: "2026-11-21" });
      assert.equal(postCell.isOutOfScopeOrExempt, true);
      assert.equal(postCell.isRedHighlight, false);
      assert.equal(postCell.statusLabel, MATRIX_OUT_OF_SCOPE_LABEL);
    }

    // E_RESIGNED in next month (2026-11, all post-exit, 0 checkins) -> cleanly excluded!
    const novRaw = await serviceRpc(db, "attendance_monthly_matrix_report", [
      OWNER.auth, OWNER.app, "2026-11", null, null, null, 1, 100,
    ]);
    assert.equal(novRaw.items.some((r) => r.app_user_id === E_RESIGNED.app), false, "E_RESIGNED excluded from months after exit");

    // E_RESIGNED blocked on new check-in, lookup, branch/slot pickers & writes, and post-exit explanation submit
    const nowIso = new Date().toISOString();
    const anchorIso = new Date(Date.now() - 500).toISOString();
    await assert.rejects(
      () => serviceRpc(db, "attendance_record_checkin", [
        E_RESIGNED.auth, E_RESIGNED.app, nextUuid(), sha256("res-ci"), 21.0285, 105.8542, 10, "HQ", "try",
        nowIso, "SERVER_ANCHORED", anchorIso, 500, sha256("tok"), "private/att/res.jpg", sha256("ph"), 1024, "image/jpeg", nowIso,
      ]),
      (err) => err?.code === "42501" && String(err.message).includes("ACTOR_NOT_AVAILABLE"),
    );
    await assert.rejects(
      () => serviceRpc(db, "attendance_lookup_checkin_idempotency", [
        E_RESIGNED.auth, E_RESIGNED.app, nextUuid(), sha256("res-lk"),
      ]),
      (err) => err?.code === "42501" && String(err.message).includes("ACTOR_NOT_AVAILABLE"),
    );

    const br = await serviceRpc(db, "attendance_upsert_branch_admin", [
      OWNER.auth, OWNER.app, null, "WP9_BR", "Chi nhánh WP9", "HN", 21.0285, 105.8542, true, 0, nextUuid(), sha256("wp9-br"),
    ]);
    const branchList = await serviceRpc(db, "attendance_list_branches_admin", [OWNER.auth, OWNER.app, true]);
    assert.equal(branchList.employee_options.some((e) => e.app_user_id === E_RESIGNED.app), false, "INACTIVE Person excluded from branch employee_options");
    assert.equal(branchList.employee_options.some((e) => e.app_user_id === UNLINKED_NORMAL.app), true, "Unlinked NORMAL stays in branch employee_options");
    assert.equal(branchList.employee_options.some((e) => e.app_user_id === CONFLICT_PERSON_SHARED.app), true, "Conflict ACTIVE Person stays in branch employee_options");

    await assert.rejects(
      () => serviceRpc(db, "attendance_assign_employee_branch_admin", [
        OWNER.auth, OWNER.app, E_RESIGNED.app, br.branch.branch_id, null, br.branch.version, nextUuid(), sha256("ab-res"),
      ]),
      (err) => err?.code === "22023" && String(err.message).includes("ATTENDANCE_BRANCH_TARGET_USER_INVALID"),
    );

    const slotList = await serviceRpc(db, "attendance_get_slot_policies_admin", [OWNER.auth, OWNER.app]);
    assert.equal(slotList.employee_options.some((e) => e.app_user_id === E_RESIGNED.app), false, "INACTIVE Person excluded from slot policy employee_options");

    // Create a custom slot policy profile with two FUTURE versions to test both assign-reject & future-only fallback!
    const customProfile = await serviceRpc(db, "attendance_upsert_slot_policy_profile_admin", [
      OWNER.auth, OWNER.app, null, "WP9_FUT", "Ca Tương Lai", "Future test", true, "2099-01-01",
      JSON.stringify([
        { slot_code: "SLOT_1", slot_label: "Vào 1", session_code: "AM", target_time: "08:00", grace_before_minutes: 15, grace_after_minutes: 15 },
      ]),
      0, 0, nextUuid(), sha256("fut-v1"),
    ]);
    const customProfileId = customProfile.profile.profile_id;
    await serviceRpc(db, "attendance_upsert_slot_policy_profile_admin", [
      OWNER.auth, OWNER.app, customProfileId, "WP9_FUT", "Ca Tương Lai", "Future test v2", true, "2099-06-01",
      JSON.stringify([
        { slot_code: "SLOT_1", slot_label: "Vào 2", session_code: "AM", target_time: "09:00", grace_before_minutes: 15, grace_after_minutes: 15 },
      ]),
      customProfile.policy.version, customProfile.profile.version, nextUuid(), sha256("fut-v2"),
    ]);

    await assert.rejects(
      () => serviceRpc(db, "attendance_assign_employee_slot_policy_admin", [
        OWNER.auth, OWNER.app, E_RESIGNED.app, customProfileId, null, 0, nextUuid(), sha256("as-res"),
      ]),
      (err) => err?.code === "22023" && String(err.message).includes("ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID"),
    );

    // Verify future-only slot policy fallback matches attendance__internal_resolve_employee_slot_policy (v1 = version asc!)
    await db.query(
      `insert into public.attendance_slot_policy_assignments (
         app_user_id, profile_id, valid_from, valid_to, superseded_same_day, version, assigned_by_user_id, idempotency_key, request_fingerprint
       ) values ($1::uuid, $2::uuid, '2026-10-01', null, false, 1, $3::uuid, $4::uuid, $5)`,
      [E_ROLE_ISOLATION.app, customProfileId, OWNER.app, nextUuid(), sha256("fut-assign")],
    );
    const { rows: [resolvedPol] } = await db.query(
      "select policy_version from public.attendance__internal_resolve_employee_slot_policy($1::uuid, '2026-10-15'::date)",
      [E_ROLE_ISOLATION.app],
    );
    const futMatrix = await serviceRpc(db, "attendance_monthly_matrix_report", [
      OWNER.auth, OWNER.app, "2026-10", null, E_ROLE_ISOLATION.app, null, 1, 20,
    ]);
    assert.equal(
      futMatrix.items[0].days.find((d) => d.business_date === "2026-10-15").policy_version_used,
      resolvedPol.policy_version,
      "Matrix future-only slot policy fallback must match attendance__internal_resolve_employee_slot_policy (earliest version asc)",
    );

    // Post-exit day 2026-10-12 on E_RESIGNED cannot submit attendance explanation (slot_status = UPCOMING, eligible = false)
    await assert.rejects(
      () => serviceRpc(db, "attendance_submit_explanation", [
        E_RESIGNED.auth, E_RESIGNED.app, "2026-10-12", "SLOT_1", "Giải trình sau khi đã nghỉ", nextKey("exp-res-post"), sha256("exp-res-post"),
      ]),
      (err) => err?.code === "PT409" && String(err.message).includes("ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE"),
    );

    // (c) D10 / R5: E_DISABLED_ONLY (Person ACTIVE, enabled = false) stays obligated; OLD_DISABLED_UNLINKED excluded!
    const rowDis = byId.get(E_DISABLED_ONLY.app);
    assert.ok(rowDis, "E_DISABLED_ONLY (Person ACTIVE + enabled=false) must remain in matrix (D10: disable != resigned)");
    assert.equal(rowDis.summary.no_checkin_day_count, 31, "Disabling login NEVER exempts attendance obligations");
    assert.equal(byId.has(E_OLD_DISABLED_UNLINKED.app), false, "Old unlinked disabled legacy account with 0 activity stays excluded");

    // (d) DEC-T0-03 & UAT-WP9-02: E_MISSING_DATE (joined_on IS NULL) & UNLINKED_NORMAL stay obligated without inferred start date
    assert.equal(byId.get(E_MISSING_DATE.app)?.summary.no_checkin_day_count, 31, "E_MISSING_DATE must NOT infer start date from link.started_at (20/10) or created_at");
    assert.equal(byId.get(UNLINKED_NORMAL.app)?.summary.no_checkin_day_count, 31, "UNLINKED_NORMAL must NOT be auto-excluded");

    // (e) WP9-GAP03: CONFLICT_PERSON_SHARED (Person ACTIVE + stale is_shared_non_employee = true)
    assert.ok(byId.has(CONFLICT_PERSON_SHARED.app), "CONFLICT_PERSON_SHARED stays obligated in matrix");
    const conflictLeaveAccess = await serviceRpc(
      db,
      "leave_management_get_actor_access",
      [CONFLICT_PERSON_SHARED.auth, CONFLICT_PERSON_SHARED.app],
      { readOnly: true },
    );
    assert.equal(conflictLeaveAccess.is_shared_non_employee, false, "WP9-GAP03: ACTIVE linked Person overrides stale is_shared_non_employee in Leave nav probe");
    assert.equal(conflictLeaveAccess.can_submit_request, true);

    const conflictExpOverview = await serviceRpc(db, "attendance_get_my_explanations_overview", [
      CONFLICT_PERSON_SHARED.auth, CONFLICT_PERSON_SHARED.app, "2026-10-15", 20, 0,
    ]);
    assert.equal(conflictExpOverview.viewer.is_shared_non_employee, false);
    assert.equal(conflictExpOverview.viewer.can_submit_explanation, true);
    assert.equal(conflictExpOverview.day_evaluation.slots[0].eligible_for_explanation, true);

    const conflictExpSubmitted = await serviceRpc(db, "attendance_submit_explanation", [
      CONFLICT_PERSON_SHARED.auth, CONFLICT_PERSON_SHARED.app, "2026-10-15", "SLOT_1",
      "Quên chấm công do đi công tác", nextKey("exp-conf"), sha256("exp-conf"),
    ]);
    assert.equal(conflictExpSubmitted.explanation.status, "PENDING", "WP9-GAP03: CONFLICT_PERSON_SHARED can submit valid explanation");

    // Verify stale flag was NOT bulk-mutated automatically
    const { rows: [staleFlagAfter] } = await db.query(
      "select is_shared_non_employee from public.leave_employee_profiles where app_user_id = $1::uuid",
      [CONFLICT_PERSON_SHARED.app],
    );
    assert.equal(staleFlagAfter.is_shared_non_employee, true, "WP9 never bulk-mutates legacy is_shared_non_employee flag");

    // Unconflicted LEGACY_SHARED_NORMAL still blocked in Leave/Explanations & excluded from matrix
    assert.equal(byId.has(LEGACY_SHARED_NORMAL.app), false);
    const legacySharedAccess = await serviceRpc(
      db,
      "leave_management_get_actor_access",
      [LEGACY_SHARED_NORMAL.auth, LEGACY_SHARED_NORMAL.app],
      { readOnly: true },
    );
    assert.equal(legacySharedAccess.is_shared_non_employee, true);
    assert.equal(legacySharedAccess.can_submit_request, false);

    // (f) Role isolation: granting & revoking HR_OPERATOR / ADMIN does NOT alter E_ROLE_ISOLATION attendance obligation
    const beforeRoleMatrix = await serviceRpc(db, "attendance_monthly_matrix_report", [
      OWNER.auth, OWNER.app, "2026-10", null, E_ROLE_ISOLATION.app, null, 1, 20,
    ]);
    const { rows: [grantRow] } = await db.query(
      `insert into public.authz_account_role_assignments (app_user_id, role_code, source_kind, reason, assigned_by_app_user_id)
       values ($1::uuid, 'HR_OPERATOR', 'ADMIN_ASSIGNMENT', 'WP9 role isolation test', $2::uuid) returning assignment_id`,
      [E_ROLE_ISOLATION.app, OWNER.app],
    );
    const duringRoleMatrix = await serviceRpc(db, "attendance_monthly_matrix_report", [
      OWNER.auth, OWNER.app, "2026-10", null, E_ROLE_ISOLATION.app, null, 1, 20,
    ]);
    assert.equal(duringRoleMatrix.items[0].summary.no_checkin_day_count, beforeRoleMatrix.items[0].summary.no_checkin_day_count);
    assert.equal(duringRoleMatrix.pagination.snapshot_token, beforeRoleMatrix.pagination.snapshot_token);
    await db.query(
      "update public.authz_account_role_assignments set ended_at = now(), ended_by_app_user_id = $2::uuid, ended_reason = 'WP9 test end' where assignment_id = $1::uuid",
      [grantRow.assignment_id, OWNER.app],
    );
    const afterRoleMatrix = await serviceRpc(db, "attendance_monthly_matrix_report", [
      OWNER.auth, OWNER.app, "2026-10", null, E_ROLE_ISOLATION.app, null, 1, 20,
    ]);
    assert.equal(afterRoleMatrix.pagination.snapshot_token, beforeRoleMatrix.pagination.snapshot_token);

    // (g) R1/P2 Per-Slot Exit-Cutoff Boundary: Matrix + Evaluator + Summary + XLSX Export + Late Check-in + AM Leave
    const E_EXIT_NOON = { auth: "19000000-0000-4000-8000-000000000031", app: "29000000-0000-4000-8000-000000000031", email: "e.exit.noon@hrpartner.vn", name: "NV Nghỉ 12h00" };
    const E_EXIT_BOUNDARY = { auth: "19000000-0000-4000-8000-000000000032", app: "29000000-0000-4000-8000-000000000032", email: "e.exit.bound@hrpartner.vn", name: "NV Biên Grace" };
    const E_EXIT_LATE = { auth: "19000000-0000-4000-8000-000000000033", app: "29000000-0000-4000-8000-000000000033", email: "e.exit.late@hrpartner.vn", name: "NV Đi Muộn Ngày Nghỉ" };
    const E_EXIT_AM_LEAVE = { auth: "19000000-0000-4000-8000-000000000034", app: "29000000-0000-4000-8000-000000000034", email: "e.exit.amleave@hrpartner.vn", name: "NV Phép Sáng Ngày Nghỉ" };
    for (const u of [E_EXIT_NOON, E_EXIT_BOUNDARY, E_EXIT_LATE, E_EXIT_AM_LEAVE]) {
      await seedBaseUser(db, u);
    }
    const pExitNoon = await createLinkedPerson(db, E_EXIT_NOON, { code: "WP9-EXNOON", fullName: E_EXIT_NOON.name, joinedOn: null, deptId: mktDept.department_id });
    const pExitBound = await createLinkedPerson(db, E_EXIT_BOUNDARY, { code: "WP9-EXBND", fullName: E_EXIT_BOUNDARY.name, joinedOn: null, deptId: mktDept.department_id });
    const pExitLate = await createLinkedPerson(db, E_EXIT_LATE, { code: "WP9-EXLATE", fullName: E_EXIT_LATE.name, joinedOn: "2026-10-01", deptId: mktDept.department_id });
    const pExitAmLeave = await createLinkedPerson(db, E_EXIT_AM_LEAVE, { code: "WP9-EXAML", fullName: E_EXIT_AM_LEAVE.name, joinedOn: "2026-10-01", deptId: mktDept.department_id });

    // Seed late check-in (08:05 -> SLOT_1 OUT_OF_GRACE) for E_EXIT_LATE and approved AM leave for E_EXIT_AM_LEAVE BEFORE deactivation
    await seedCheckin(db, E_EXIT_LATE.app, "2026-10-10", "08:05");
    const amLeaveReq = await serviceRpc(db, "leave_management_create_request", [
      E_EXIT_AM_LEAVE.auth, E_EXIT_AM_LEAVE.app,
      JSON.stringify([{ leave_date: "2026-10-10", session_code: "AM", leave_type: "UNPAID" }]),
      "Nghỉ phép buổi sáng ngày bàn giao", nextKey("am-lv-req"), sha256("am-lv-req"),
    ]);
    await serviceRpc(db, "leave_management_decide_request", [
      OWNER.auth, OWNER.app, amLeaveReq.request.request_id, "APPROVE", amLeaveReq.request.row_version,
      "Duyệt phép sáng", nextKey("am-lv-app"), sha256("am-lv-app"),
    ]);

    // Deactivate all 4 via canonical org_department_update_person_admin, then pin local timestamps
    const deactivateAt = async (person, code, name, joinedOn, tsLocal) => {
      const { rows: [pv] } = await db.query("select version from public.organization_persons where person_id = $1::uuid", [person.person_id]);
      await serviceRpc(db, "org_department_update_person_admin", [
        OWNER.auth, OWNER.app, person.person_id, pv.version, code, name, joinedOn,
        "INACTIVE", `Ngừng hoạt động ${tsLocal}`, nextUuid(), sha256(`deact:${code}:${tsLocal}`),
      ]);
      await db.query("update public.organization_persons set deactivated_at = $2::timestamptz where person_id = $1::uuid", [person.person_id, tsLocal]);
    };
    await deactivateAt(pExitNoon, "WP9-EXNOON", E_EXIT_NOON.name, null, "2026-10-10 12:00:00+07");
    await deactivateAt(pExitBound, "WP9-EXBND", E_EXIT_BOUNDARY.name, null, "2026-10-10 10:15:00+07");
    await deactivateAt(pExitLate, "WP9-EXLATE", E_EXIT_LATE.name, "2026-10-01", "2026-10-10 12:00:00+07");
    await deactivateAt(pExitAmLeave, "WP9-EXAML", E_EXIT_AM_LEAVE.name, "2026-10-01", "2026-10-10 12:00:00+07");

    // (g1) T0 Canonical Noon Cutoff (2026-10-10 12:00+07, 0 check-ins, joined_on IS NULL):
    //      SLOT_1 (07:30+15m=07:45) & SLOT_2 (10:00+15m=10:15) -> MISSING + eligible; SLOT_3..5 -> UPCOMING + not eligible
    const noonMatrixBefore = projectAttendanceMonthlyMatrixReport(
      await serviceRpc(db, "attendance_monthly_matrix_report", [OWNER.auth, OWNER.app, "2026-10", null, E_EXIT_NOON.app, null, 1, 20]),
    );
    assert.ok(noonMatrixBefore);
    const noonRow = noonMatrixBefore.items[0];
    const noonDay10 = noonRow.days.find((d) => d.business_date === "2026-10-10");
    const noonDay11 = noonRow.days.find((d) => d.business_date === "2026-10-11");
    assert.equal(noonDay10.day_status, "NO_CHECKIN");
    assert.equal(noonDay10.missing_slot_count, 2, "R1: noon cutoff preserves exact 2 AM MISSING slots (SLOT_1, SLOT_2)");
    assert.deepEqual(
      noonDay10.slots.map((s) => `${s.slot_code}:${s.slot_status}`),
      ["SLOT_1:MISSING", "SLOT_2:MISSING", "SLOT_3:UPCOMING", "SLOT_4:UPCOMING", "SLOT_5:UPCOMING"],
    );
    assert.equal(noonRow.summary.no_checkin_day_count, 10, "R1: 01..10 obligated (10 days), 11..31 exempt (0 fake missing)");
    assert.equal(noonRow.summary.no_checkin_without_leave_day_count, 10);
    assert.equal(noonDay11.day_status, "UPCOMING");
    assert.equal(noonDay11.missing_slot_count, 0);

    const noonEvalBefore = await serviceRpc(db, "attendance_get_my_explanations_overview", [
      E_EXIT_NOON.auth, E_EXIT_NOON.app, "2026-10-10", 20, 0,
    ]);
    assert.deepEqual(
      noonEvalBefore.day_evaluation.slots.map((s) => `${s.slot_code}:${s.slot_status}:${s.eligible_for_explanation}`),
      [
        "SLOT_1:MISSING:true",
        "SLOT_2:MISSING:true",
        "SLOT_3:UPCOMING:false",
        "SLOT_4:UPCOMING:false",
        "SLOT_5:UPCOMING:false",
      ],
      "R1: Explanation evaluator matches matrix per-slot cutoff verbatim",
    );

    // Pre-cutoff historical slot SLOT_1 allows explanation submit; post-cutoff SLOT_3 rejects PT409!
    const noonExp1 = await serviceRpc(db, "attendance_submit_explanation", [
      E_EXIT_NOON.auth, E_EXIT_NOON.app, "2026-10-10", "SLOT_1",
      "Quên chấm công ca sáng trước khi bàn giao nghỉ việc", nextKey("exp-noon-s1"), sha256("exp-noon-s1"),
    ]);
    assert.equal(noonExp1.explanation.status, "PENDING", "R1: Historical pre-cutoff MISSING slot accepts explanation");
    await assert.rejects(
      () => serviceRpc(db, "attendance_submit_explanation", [
        E_EXIT_NOON.auth, E_EXIT_NOON.app, "2026-10-10", "SLOT_3",
        "Thử giải trình ca chiều sau giờ nghỉ", nextKey("exp-noon-s3"), sha256("exp-noon-s3"),
      ]),
      (err) => err?.code === "PT409" && String(err.message).includes("ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE"),
      "R1: Post-cutoff slot rejects explanation submit",
    );

    // Approve SLOT_1 explanation -> Matrix & Evaluator & XLSX export reflect EXPLAINED_APPROVED on SLOT_1, MISSING on SLOT_2, UPCOMING on SLOT_3..5!
    const noonDecided = await serviceRpc(db, "attendance_decide_explanation", [
      OWNER.auth, OWNER.app, noonExp1.explanation.explanation_id, "APPROVE",
      noonExp1.explanation.row_version, "Duyệt giải trình ca sáng", nextKey("dec-noon-s1"), sha256("dec-noon-s1"),
    ]);
    assert.equal(noonDecided.explanation.status, "APPROVED");

    const noonMatrixAfter = projectAttendanceMonthlyMatrixReport(
      await serviceRpc(db, "attendance_monthly_matrix_report", [OWNER.auth, OWNER.app, "2026-10", null, E_EXIT_NOON.app, null, 1, 20]),
    );
    const noonDay10After = noonMatrixAfter.items[0].days.find((d) => d.business_date === "2026-10-10");
    assert.equal(noonDay10After.missing_slot_count, 1, "Approving SLOT_1 reduces missing_slot_count 2 -> 1");
    assert.deepEqual(
      noonDay10After.slots.map((s) => `${s.slot_code}:${s.slot_status}`),
      ["SLOT_1:EXPLAINED_APPROVED", "SLOT_2:MISSING", "SLOT_3:UPCOMING", "SLOT_4:UPCOMING", "SLOT_5:UPCOMING"],
    );
    const noonEvalAfter = await serviceRpc(db, "attendance_get_my_explanations_overview", [
      E_EXIT_NOON.auth, E_EXIT_NOON.app, "2026-10-10", 20, 0,
    ]);
    assert.deepEqual(
      noonEvalAfter.day_evaluation.slots.map((s) => `${s.slot_code}:${s.slot_status}:${s.eligible_for_explanation}`),
      [
        "SLOT_1:EXPLAINED_APPROVED:false",
        "SLOT_2:MISSING:true",
        "SLOT_3:UPCOMING:false",
        "SLOT_4:UPCOMING:false",
        "SLOT_5:UPCOMING:false",
      ],
    );

    // Verify UI model & XLSX Export consistency for partial exit day + post-exit day!
    const noonDay10Text = formatMatrixDayCellText(noonDay10After, { todayBusinessDate: "2026-11-21" });
    assert.match(noonDay10Text, /Time 1 \(07:30\): Giải trình được duyệt/);
    assert.match(noonDay10Text, /Time 2 \(10:00\): Chưa có lượt chấm/);
    assert.match(noonDay10Text, /Time 3 \(13:00\): Ngoài phạm vi \/ Không áp dụng/);
    assert.equal(/Chưa đến giờ chấm/.test(noonDay10Text), false);
    const noonXlsxBytes = await buildAttendanceMonthlyMatrixXlsx(noonMatrixAfter, { todayBusinessDate: "2026-11-21" });
    assert.ok(noonXlsxBytes instanceof Uint8Array && noonXlsxBytes.byteLength > 1000, "XLSX export succeeds on partial exit day");

    // (g2) Exact Grace-End Cutoff Boundary Rule (deactivated_at <= slot_due_at -> UPCOMING; deactivated_at > slot_due_at -> MISSING):
    //      SLOT_1 due = 07:45:00+07; SLOT_2 due = 10:15:00+07
    const checkBoundary = async (tsLocal, expectedSlots, expectedMissing, expectedNoCheckinDays, expectDayExempt = false) => {
      await db.query("update public.organization_persons set deactivated_at = $2::timestamptz where person_id = $1::uuid", [pExitBound.person_id, tsLocal]);
      const mat = projectAttendanceMonthlyMatrixReport(
        await serviceRpc(db, "attendance_monthly_matrix_report", [OWNER.auth, OWNER.app, "2026-10", null, E_EXIT_BOUNDARY.app, null, 1, 20]),
      );
      const day10 = mat.items[0].days.find((d) => d.business_date === "2026-10-10");
      assert.deepEqual(
        day10.slots.map((s) => `${s.slot_code}:${s.slot_status}`),
        expectedSlots,
        `Matrix slots at cutoff ${tsLocal}`,
      );
      assert.equal(day10.missing_slot_count, expectedMissing, `missing_slot_count at cutoff ${tsLocal}`);
      assert.equal(mat.items[0].summary.no_checkin_day_count, expectedNoCheckinDays, `no_checkin_day_count at cutoff ${tsLocal}`);
      assert.equal(
        describeMatrixDayCell(day10, { todayBusinessDate: "2026-11-21" }).isOutOfScopeOrExempt,
        expectDayExempt,
        `isOutOfScopeOrExempt at cutoff ${tsLocal}`,
      );
      const ev = await serviceRpc(db, "attendance_get_my_explanations_overview", [
        E_EXIT_BOUNDARY.auth, E_EXIT_BOUNDARY.app, "2026-10-10", 20, 0,
      ]);
      assert.deepEqual(
        ev.day_evaluation.slots.map((s) => `${s.slot_code}:${s.slot_status}:${s.eligible_for_explanation}`),
        expectedSlots.map((pair) => `${pair}:${pair.endsWith(":MISSING")}`),
        `Evaluator slots at cutoff ${tsLocal}`,
      );
    };
    await checkBoundary(
      "2026-10-10 10:15:00+07",
      ["SLOT_1:MISSING", "SLOT_2:UPCOMING", "SLOT_3:UPCOMING", "SLOT_4:UPCOMING", "SLOT_5:UPCOMING"],
      1,
      10,
      false,
    );
    await checkBoundary(
      "2026-10-10 10:15:01+07",
      ["SLOT_1:MISSING", "SLOT_2:MISSING", "SLOT_3:UPCOMING", "SLOT_4:UPCOMING", "SLOT_5:UPCOMING"],
      2,
      10,
      false,
    );
    await checkBoundary(
      "2026-10-10 07:45:00+07",
      ["SLOT_1:UPCOMING", "SLOT_2:UPCOMING", "SLOT_3:UPCOMING", "SLOT_4:UPCOMING", "SLOT_5:UPCOMING"],
      0,
      9,
      true,
    );
    await checkBoundary(
      "2026-10-10 00:00:00+07",
      ["SLOT_1:UPCOMING", "SLOT_2:UPCOMING", "SLOT_3:UPCOMING", "SLOT_4:UPCOMING", "SLOT_5:UPCOMING"],
      0,
      9,
      true,
    );

    // (g3) Late check-in (08:05 -> SLOT_1 OUT_OF_GRACE) before 12:00 exit keeps OUT_OF_GRACE + explanation eligibility + SLOT_2 MISSING + SLOT_3..5 UPCOMING
    const lateMat = projectAttendanceMonthlyMatrixReport(
      await serviceRpc(db, "attendance_monthly_matrix_report", [OWNER.auth, OWNER.app, "2026-10", null, E_EXIT_LATE.app, null, 1, 20]),
    );
    const lateDay10 = lateMat.items[0].days.find((d) => d.business_date === "2026-10-10");
    assert.equal(lateDay10.day_status, "CHECKED_IN");
    assert.equal(lateDay10.missing_slot_count, 1);
    assert.equal(lateDay10.late_or_early_checkin_count, 1);
    assert.deepEqual(
      lateDay10.slots.map((s) => `${s.slot_code}:${s.slot_status}`),
      ["SLOT_1:OUT_OF_GRACE", "SLOT_2:MISSING", "SLOT_3:UPCOMING", "SLOT_4:UPCOMING", "SLOT_5:UPCOMING"],
    );
    const lateEval = await serviceRpc(db, "attendance_get_my_explanations_overview", [
      E_EXIT_LATE.auth, E_EXIT_LATE.app, "2026-10-10", 20, 0,
    ]);
    assert.deepEqual(
      lateEval.day_evaluation.slots.map((s) => `${s.slot_code}:${s.slot_status}:${s.eligible_for_explanation}`),
      [
        "SLOT_1:OUT_OF_GRACE:true",
        "SLOT_2:MISSING:true",
        "SLOT_3:UPCOMING:false",
        "SLOT_4:UPCOMING:false",
        "SLOT_5:UPCOMING:false",
      ],
    );
    const lateExp = await serviceRpc(db, "attendance_submit_explanation", [
      E_EXIT_LATE.auth, E_EXIT_LATE.app, "2026-10-10", "SLOT_1",
      "Kẹt xe buổi sáng ngày nghỉ việc", nextKey("exp-late-s1"), sha256("exp-late-s1"),
    ]);
    assert.equal(lateExp.explanation.status, "PENDING", "Late pre-cutoff check-in stays eligible for explanation");

    // (g4) Approved AM leave on 12:00 exit day covers SLOT_1..2 and leaves 0 missing, excluding 10/10 from no_checkin_without_leave_day_count
    const amLeaveMat = projectAttendanceMonthlyMatrixReport(
      await serviceRpc(db, "attendance_monthly_matrix_report", [OWNER.auth, OWNER.app, "2026-10", null, E_EXIT_AM_LEAVE.app, null, 1, 20]),
    );
    const amLeaveDay10 = amLeaveMat.items[0].days.find((d) => d.business_date === "2026-10-10");
    assert.equal(amLeaveDay10.day_status, "APPROVED_LEAVE");
    assert.equal(amLeaveDay10.missing_slot_count, 0);
    assert.deepEqual(
      amLeaveDay10.slots.map((s) => `${s.slot_code}:${s.slot_status}`),
      ["SLOT_1:LEAVE_COVERED", "SLOT_2:LEAVE_COVERED", "SLOT_3:UPCOMING", "SLOT_4:UPCOMING", "SLOT_5:UPCOMING"],
    );
    assert.equal(amLeaveMat.items[0].summary.no_checkin_without_leave_day_count, 9, "AM leave on exit day excludes 10/10 from no_checkin_without_leave_day_count");
    const amLeaveEval = await serviceRpc(db, "attendance_get_my_explanations_overview", [
      E_EXIT_AM_LEAVE.auth, E_EXIT_AM_LEAVE.app, "2026-10-10", 20, 0,
    ]);
    assert.deepEqual(
      amLeaveEval.day_evaluation.slots.map((s) => `${s.slot_code}:${s.slot_status}:${s.eligible_for_explanation}`),
      [
        "SLOT_1:LEAVE_COVERED:false",
        "SLOT_2:LEAVE_COVERED:false",
        "SLOT_3:UPCOMING:false",
        "SLOT_4:UPCOMING:false",
        "SLOT_5:UPCOMING:false",
      ],
    );

    // (g5) Non-monotonic mid-day link transition (INACTIVE P1 -> ACTIVE P2 at 09:00 on 2026-10-10)
    //      & disabled account with closed link covering day_as_of -> 100% parity between day cells, summary rollup, and eligible_month_users
    const E_MIDDAY_RELINK = { auth: "19000000-0000-4000-8000-000000000036", app: "29000000-0000-4000-8000-000000000036", email: "e.relink@hrpartner.vn", name: "NV Đổi Hồ Sơ Giữa Ngày" };
    const E_DIS_CLOSED_LINK = { auth: "19000000-0000-4000-8000-000000000037", app: "29000000-0000-4000-8000-000000000037", email: "e.dis.closedlink@hrpartner.vn", name: "NV Khóa TK Link Đã Đóng" };
    await seedBaseUser(db, E_MIDDAY_RELINK);
    await seedBaseUser(db, E_DIS_CLOSED_LINK, { enabled: false });

    const pRelink1 = await createLinkedPerson(db, E_MIDDAY_RELINK, { code: "WP9-RL1", fullName: "Hồ Sơ Cũ", joinedOn: "2026-10-01", deptId: mktDept.department_id });
    await deactivateAt(pRelink1, "WP9-RL1", "Hồ Sơ Cũ", "2026-10-01", "2026-10-05 12:00:00+07");
    const { rows: [pRelink2] } = await db.query(
      `insert into public.organization_persons (employee_code, full_name, joined_on, status, created_by_app_user_id, updated_by_app_user_id)
       values ('WP9-RL2', 'Hồ Sơ Mới', '2026-10-10', 'ACTIVE', $1::uuid, $1::uuid) returning person_id`,
      [OWNER.app],
    );
    const { rows: [pDisClosed] } = await db.query(
      `insert into public.organization_persons (employee_code, full_name, joined_on, status, created_by_app_user_id, updated_by_app_user_id)
       values ('WP9-DCL', 'NV Link Đóng', '2026-10-10', 'ACTIVE', $1::uuid, $1::uuid) returning person_id`,
      [OWNER.app],
    );
    await db.exec("alter table public.organization_account_person_links disable trigger user;");
    await db.query(
      `update public.organization_account_person_links
          set started_at = '2026-10-01 00:00:00+07'::timestamptz,
              ended_at = '2026-10-10 09:00:00+07'::timestamptz
        where app_user_id = $1::uuid`,
      [E_MIDDAY_RELINK.app],
    );
    await db.query(
      `insert into public.organization_account_person_links (app_user_id, person_id, started_at, ended_at, created_by_app_user_id, reason)
       values ($1::uuid, $2::uuid, '2026-10-10 09:00:00+07'::timestamptz, null, $3::uuid, 'Relink mid-day'),
              ($4::uuid, $5::uuid, '2026-10-10 09:00:00+07'::timestamptz, '2026-10-11 00:00:00+07'::timestamptz, $3::uuid, 'Closed link covering day_as_of')`,
      [E_MIDDAY_RELINK.app, pRelink2.person_id, OWNER.app, E_DIS_CLOSED_LINK.app, pDisClosed.person_id],
    );
    await db.exec("alter table public.organization_account_person_links enable trigger user;");

    const relinkMat = projectAttendanceMonthlyMatrixReport(
      await serviceRpc(db, "attendance_monthly_matrix_report", [OWNER.auth, OWNER.app, "2026-10", null, E_MIDDAY_RELINK.app, null, 1, 20]),
    );
    assert.ok(relinkMat && relinkMat.items.length === 1);
    const relinkRow = relinkMat.items[0];
    const relinkDay10 = relinkRow.days.find((d) => d.business_date === "2026-10-10");
    assert.equal(relinkDay10.day_status, "NO_CHECKIN");
    assert.equal(relinkDay10.missing_slot_count, 4, "Mid-day relink at 09:00 leaves SLOT_1 exempt and SLOT_2..5 MISSING");
    assert.deepEqual(
      relinkDay10.slots.map((s) => `${s.slot_code}:${s.slot_status}`),
      ["SLOT_1:UPCOMING", "SLOT_2:MISSING", "SLOT_3:MISSING", "SLOT_4:MISSING", "SLOT_5:MISSING"],
    );
    const relinkNoCheckinCells = relinkRow.days.filter((d) => d.day_status === "NO_CHECKIN").length;
    assert.equal(relinkRow.summary.no_checkin_day_count, relinkNoCheckinCells, "Summary no_checkin_day_count must match rendered NO_CHECKIN day cells (27)");
    assert.equal(relinkRow.summary.no_checkin_day_count, 27);

    const disClosedMat = projectAttendanceMonthlyMatrixReport(
      await serviceRpc(db, "attendance_monthly_matrix_report", [OWNER.auth, OWNER.app, "2026-10", null, E_DIS_CLOSED_LINK.app, null, 1, 20]),
    );
    assert.equal(disClosedMat.items.length, 1, "Disabled account with closed Person link covering day_as_of stays included in eligible_month_users");
    assert.equal(disClosedMat.items[0].days.find((d) => d.business_date === "2026-10-10").day_status, "NO_CHECKIN");

    assert.ok(pNew && pDisabledOnly && pMissingDate && pConflict && pRoleIso);
  } finally {
    await db.close();
  }
});

// ============================================================================
// TEST 3: Work Reports Special Accounts, Disabled/Inactive Targets, Probe Parity, Disabled Revoke
// ============================================================================
test("WP9 [3/4]: Work Reports blocks SHARED/SERVICE/legacy-shared/INACTIVE/DISABLED targets & materialization, preserves history & SERVICE read-only, keeps strict READ ONLY nav probe parity, allows all-scope disable revoke & isolates roles", async () => {
  const { db } = await createDb();
  try {
    await setupCutoverCore(db);

    const { rows: [{ today_vn: todayVn }] } = await db.query(
      "select (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as today_vn",
    );
    const { rows: [mktDept] } = await db.query(
      "select department_id from public.organization_departments where system_key = 'MARKETING'",
    );

    for (const u of [
      TL_A, E_RESIGNED, E_DISABLED_ONLY, UNLINKED_NORMAL, CONFLICT_PERSON_SHARED,
      SHARED_ACC, SERVICE_ACC, LEGACY_SHARED_NORMAL, E_HIST_RECLASS, E_ROLE_ISOLATION,
    ]) {
      await seedBaseUser(db, u, {
        enabled: u !== E_DISABLED_ONLY,
        accountType: u === SHARED_ACC ? "SHARED" : u === SERVICE_ACC ? "SERVICE" : "NORMAL",
      });
    }

    for (const u of [
      TL_A, E_RESIGNED, E_DISABLED_ONLY, UNLINKED_NORMAL, CONFLICT_PERSON_SHARED,
      SHARED_ACC, LEGACY_SHARED_NORMAL, E_HIST_RECLASS, E_ROLE_ISOLATION,
    ]) {
      await linkRecruiterAndTeam(db, u, TEAM_A, "2026-01-01");
    }

    // Make TL_A team leader of TEAM_A (and authz_managed=true for all new users)
    await db.query(
      "update public.direct_entry_app_users set authz_managed = true where app_user_id = $1::uuid",
      [TL_A.app],
    );
    await db.query(
      `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01', true)`,
      [TEAM_A, TL_A.app, TL_A.rec],
    );

    // Seed legacy shared flags
    await db.exec("alter table public.leave_employee_profiles disable trigger user;");
    for (const u of [LEGACY_SHARED_NORMAL, CONFLICT_PERSON_SHARED]) {
      await db.query(
        `insert into public.leave_employee_profiles (
           app_user_id, is_shared_non_employee, employment_status, unit_kind, work_start_date, row_version, updated_by_app_user_id
         ) values ($1::uuid, true, 'OFFICIAL', 'MARKETING', '2026-01-01', 1, $2::uuid)
         on conflict (app_user_id) do update set is_shared_non_employee = true`,
        [u.app, OWNER.app],
      );
    }
    await db.exec("alter table public.leave_employee_profiles enable trigger user;");

    // Create Persons for E_RESIGNED (then deactivate) & CONFLICT_PERSON_SHARED (ACTIVE)
    const pRes = await createLinkedPerson(db, E_RESIGNED, { code: "WR9-RES", fullName: "WR Đã Nghỉ", joinedOn: "2026-01-01", deptId: mktDept.department_id });
    await createLinkedPerson(db, CONFLICT_PERSON_SHARED, { code: "WR9-CONF", fullName: "WR Xung Đột", joinedOn: "2026-01-01", deptId: mktDept.department_id });
    await db.exec("alter table public.leave_employee_profiles disable trigger user;");
    await db.query(
      "update public.leave_employee_profiles set is_shared_non_employee = true where app_user_id = $1::uuid",
      [CONFLICT_PERSON_SHARED.app],
    );
    await db.exec("alter table public.leave_employee_profiles enable trigger user;");
    const { rows: [pResVer] } = await db.query(
      "select version from public.organization_persons where person_id = $1::uuid",
      [pRes.person_id],
    );
    await serviceRpc(db, "org_department_update_person_admin", [
      OWNER.auth, OWNER.app, pRes.person_id, pResVer.version, "WR9-RES", "WR Đã Nghỉ", "2026-01-01",
      "INACTIVE", "Nghỉ việc WR", nextUuid(), sha256("wr-deact"),
    ]);

    // Give SERVICE_ACC direct paired read-only report_view + report_analytics_view @ALL (D2-SERVICE-READ-01)
    await db.query(
      `update public.direct_entry_app_users set authz_managed = true where app_user_id in ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
      [TL_A.app, SHARED_ACC.app, SERVICE_ACC.app, E_ROLE_ISOLATION.app],
    );
    for (const cap of ["report_view", "report_analytics_view", "report_assign"]) {
      await db.query(
        `insert into public.authz_direct_capability_grants (app_user_id, capability, scope_kind, source_kind, granted_by_app_user_id, reason)
         values ($1::uuid, $2, 'ALL', 'EXCEPTION_GRANT', $3::uuid, 'WP9 service read-only test')`,
        [SERVICE_ACC.app, cap, OWNER.app],
      );
    }

    const tpl = await createPublishedTemplate(db, OWNER, "WP9_DAILY_T1", "Báo cáo ngày WP9", "DAILY");

    // 1. Pickers exclude SHARED, SERVICE, LEGACY_SHARED_NORMAL, INACTIVE Person, DISABLED — while keeping UNLINKED_NORMAL & CONFLICT_PERSON_SHARED
    const opts = await serviceRpc(db, "work_report_list_assignment_options", [OWNER.auth, OWNER.app, TEAM_A]);
    const optUserIds = opts.users.map((u) => u.app_user_id);
    for (const blocked of [SHARED_ACC, SERVICE_ACC, LEGACY_SHARED_NORMAL, E_RESIGNED, E_DISABLED_ONLY]) {
      assert.equal(optUserIds.includes(blocked.app), false, `${blocked.email} must be excluded from list_assignment_options`);
    }
    assert.equal(optUserIds.includes(UNLINKED_NORMAL.app), true, "UNLINKED_NORMAL included in list_assignment_options");
    assert.equal(optUserIds.includes(CONFLICT_PERSON_SHARED.app), true, "CONFLICT_PERSON_SHARED included in list_assignment_options");

    const grpList = await serviceRpc(db, "work_report_list_groups", [OWNER.auth, OWNER.app]);
    const eligibleGrpIds = grpList.eligible_users.map((u) => u.app_user_id);
    for (const blocked of [SHARED_ACC, SERVICE_ACC, LEGACY_SHARED_NORMAL, E_RESIGNED, E_DISABLED_ONLY]) {
      assert.equal(eligibleGrpIds.includes(blocked.app), false, `${blocked.email} must be excluded from list_groups.eligible_users`);
    }
    assert.equal(eligibleGrpIds.includes(UNLINKED_NORMAL.app), true);
    assert.equal(eligibleGrpIds.includes(CONFLICT_PERSON_SHARED.app), true);

    const delList = await serviceRpc(db, "work_report_list_delegations", [OWNER.auth, OWNER.app]);
    const delIds = delList.options.delegates.map((u) => u.app_user_id);
    for (const blocked of [SHARED_ACC, SERVICE_ACC, LEGACY_SHARED_NORMAL, E_RESIGNED, E_DISABLED_ONLY]) {
      assert.equal(delIds.includes(blocked.app), false, `${blocked.email} must be excluded from delegation options`);
    }

    // 2. Writers reject SHARED, SERVICE, LEGACY_SHARED_NORMAL, INACTIVE Person, DISABLED on USER, USER_SET, GROUP, and delegation
    for (const blocked of [SHARED_ACC, LEGACY_SHARED_NORMAL, E_RESIGNED, E_DISABLED_ONLY]) {
      await assert.rejects(
        () => serviceRpc(db, "work_report_create_assignment", [
          OWNER.auth, OWNER.app, tpl.template_id, "USER", blocked.app, null, null,
          "DAILY", true, 0, "18:00:00", false, todayVn, null, nextKey("asgn-u"),
        ]),
        (err) =>
          blocked === E_DISABLED_ONLY
            ? err?.code === "42501" && String(err.message).includes("WORK_REPORT_ASSIGNEE_TEAM_AMBIGUOUS")
            : err?.code === "22023" && String(err.message).includes("WORK_REPORT_ASSIGNMENT_TARGET_INVALID"),
        `${blocked.email} must be rejected on USER create_assignment`,
      );
      await assert.rejects(
        () => serviceRpc(db, "work_report_create_assignment", [
          OWNER.auth, OWNER.app, tpl.template_id, "USER_SET", null, null, [UNLINKED_NORMAL.app, blocked.app],
          "DAILY", true, 0, "18:00:00", false, todayVn, null, nextKey("asgn-us"),
        ]),
        (err) => err?.code === "22023" && String(err.message).includes("WORK_REPORT_ASSIGNMENT_TARGET_INVALID"),
        `${blocked.email} must be rejected on USER_SET create_assignment`,
      );
      await assert.rejects(
        () => serviceRpc(db, "work_report_create_group", [
          OWNER.auth, OWNER.app, `Bad Group ${blocked.name}`, null, [blocked.app], nextKey("grp-bad"),
        ]),
        (err) => err?.code === "22023" && String(err.message).includes("WORK_REPORT_GROUP_MEMBER_INELIGIBLE"),
        `${blocked.email} must be rejected on create_group`,
      );
      await assert.rejects(
        () => serviceRpc(db, "work_report_create_delegation", [
          OWNER.auth, OWNER.app, "report_assign", blocked.app, tpl.template_id, "all", null, null, null, nextKey("del-bad"),
        ]),
        (err) => err?.code === "42501" && String(err.message).includes("WORK_REPORT_DELEGATE_NOT_AVAILABLE"),
        `${blocked.email} must be rejected on create_delegation`,
      );
    }
    // SERVICE_ACC also blocked on USER_SET, GROUP, delegation
    await assert.rejects(
      () => serviceRpc(db, "work_report_create_assignment", [
        OWNER.auth, OWNER.app, tpl.template_id, "USER_SET", null, null, [SERVICE_ACC.app],
        "DAILY", true, 0, "18:00:00", false, todayVn, null, nextKey("asgn-svc"),
      ]),
      (err) => err?.code === "22023" && String(err.message).includes("WORK_REPORT_ASSIGNMENT_TARGET_INVALID"),
    );

    // 3. TEAM assignment creates obligations ONLY for eligible active employees (NOT SHARED/LEGACY_SHARED/INACTIVE/DISABLED)
    //    AND TEAM target_member_count matches eligible members only!
    const teamAsgn = await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tpl.template_id, "TEAM", null, TEAM_A, null,
      "DAILY", true, 0, "18:00:00", false, todayVn, null, nextKey("asgn-team-a"),
    ]);
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayVn]);

    const { rows: teamObs } = await db.query(
      "select assignee_app_user_id from public.work_report_obligations where assignment_id = $1::uuid",
      [teamAsgn.assignment_id],
    );
    const teamAssigneeIds = new Set(teamObs.map((r) => r.assignee_app_user_id));
    for (const blocked of [SHARED_ACC, SERVICE_ACC, LEGACY_SHARED_NORMAL, E_RESIGNED, E_DISABLED_ONLY]) {
      assert.equal(teamAssigneeIds.has(blocked.app), false, `${blocked.email} must receive 0 materialized obligations from TEAM assignment`);
    }
    assert.equal(teamAssigneeIds.has(UNLINKED_NORMAL.app), true, "UNLINKED_NORMAL receives obligation from TEAM assignment");
    assert.equal(teamAssigneeIds.has(CONFLICT_PERSON_SHARED.app), true, "CONFLICT_PERSON_SHARED receives obligation from TEAM assignment");
    assert.equal(teamAssigneeIds.has(E_HIST_RECLASS.app), true);

    const listedAsgns = await serviceRpc(db, "work_report_list_assignments", [OWNER.auth, OWNER.app, TEAM_A]);
    const trackedTeam = listedAsgns.items.find((i) => i.assignment_id === teamAsgn.assignment_id);
    assert.equal(trackedTeam.target_member_count, teamAssigneeIds.size, "TEAM target_member_count must count eligible members only");

    // 4. Historical obligation preservation when E_HIST_RECLASS submits, then is reclassified to SHARED (via unlink/reclass):
    const histMyObs = await serviceRpc(db, "work_report_list_my_obligations", [E_HIST_RECLASS.auth, E_HIST_RECLASS.app, "ACTIVE"]);
    const histObId = histMyObs.items[0].obligation_id;
    await serviceRpc(db, "work_report_submit", [
      E_HIST_RECLASS.auth, E_HIST_RECLASS.app, histObId, JSON.stringify({ calls_made: 7, interested_candidates: 2, workers_started: 1, notes: null }), null, nextKey("sub-hist"),
    ]);
    // Reclassify E_HIST_RECLASS to SHARED (simulating historical employee account converted later)
    await db.query("update public.direct_entry_app_users set account_type = 'SHARED' where app_user_id = $1::uuid", [E_HIST_RECLASS.app]);

    // Next day materialization creates 0 NEW obligations for E_HIST_RECLASS while preserving the submitted historical row!
    const tomorrowVn = addDaysIso(todayVn, 1);
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, tomorrowVn]);
    const { rows: histAfterRows } = await db.query(
      "select obligation_id, period_key from public.work_report_obligations where assignee_app_user_id = $1::uuid",
      [E_HIST_RECLASS.app],
    );
    assert.equal(histAfterRows.length, 1, "Reclassified SHARED account keeps its 1 historical obligation and gets 0 new obligations");
    assert.equal(histAfterRows[0].obligation_id, histObId);

    // 5. Strict READ ONLY nav probe parity (0 writes across all 6 WR tables)
    const beforeCounts = await countWrTables(db);
    for (const nonEmp of [SHARED_ACC, SERVICE_ACC, LEGACY_SHARED_NORMAL, E_HIST_RECLASS]) {
      const probe = await serviceRpc(
        db,
        "work_report_has_active_obligations",
        [nonEmp.auth, nonEmp.app],
        { readOnly: true },
      );
      assert.strictEqual(probe.has_active_obligations, false, `${nonEmp.email} read-only probe must return strict false even with historical ACTIVE row`);
      await assert.rejects(
        () => serviceRpc(db, "work_report_list_my_obligations", [nonEmp.auth, nonEmp.app, null]),
        (err) => err?.code === "42501" && String(err.message).includes("WORK_REPORT_ACTOR_DENIED"),
        `${nonEmp.email} must be denied on work_report_list_my_obligations`,
      );
    }
    const unlinkedProbe = await serviceRpc(
      db,
      "work_report_has_active_obligations",
      [UNLINKED_NORMAL.auth, UNLINKED_NORMAL.app],
      { readOnly: true },
    );
    assert.strictEqual(unlinkedProbe.has_active_obligations, true);
    const conflictProbe = await serviceRpc(
      db,
      "work_report_has_active_obligations",
      [CONFLICT_PERSON_SHARED.auth, CONFLICT_PERSON_SHARED.app],
      { readOnly: true },
    );
    assert.strictEqual(conflictProbe.has_active_obligations, true);
    const resignedProbe = await serviceRpc(
      db,
      "work_report_has_active_obligations",
      [E_RESIGNED.auth, E_RESIGNED.app],
      { readOnly: true },
    );
    assert.strictEqual(resignedProbe.has_active_obligations, false, "INACTIVE Person with 0 historical ACTIVE obligations gets strict false");
    assert.deepEqual(await countWrTables(db), beforeCounts, "Read-only probe calls perform ZERO writes across all WR tables");

    // 6. Managed SERVICE BoD read-only preserved (D2-SERVICE-READ-01)
    const svcAnalytics = await serviceRpc(
      db,
      "work_report_analytics_overview",
      [SERVICE_ACC.auth, SERVICE_ACC.app, tpl.template_id, null, addDaysIso(todayVn, -7), todayVn, null, null, "final"],
      { readOnly: true },
    );
    assert.ok(svcAnalytics && typeof svcAnalytics === "object", "SERVICE read-only analytics remains operational");
    const svcAssignments = await serviceRpc(
      db,
      "work_report_list_assignments",
      [SERVICE_ACC.auth, SERVICE_ACC.app, null],
      { readOnly: true },
    );
    assert.ok(Array.isArray(svcAssignments.items));

    // 7. Full Admin (all scope) can PAUSE/REVOKE a USER assignment AFTER target user is disabled/loses team; TL still 42501
    const tplUser = await createPublishedTemplate(db, OWNER, "WP9_USER_REV", "Báo cáo cá nhân thu hồi", "DAILY");
    const userAsgn = await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplUser.template_id, "USER", E_ROLE_ISOLATION.app, null, null,
      "DAILY", true, 0, "18:00:00", false, todayVn, null, nextKey("asgn-urole"),
    ]);
    // Remove recruiter team membership & disable target user
    await db.query(
      "update public.recruiter_team_memberships set is_current = false, valid_to = $1::date where recruiter_id = $2::uuid and is_current",
      [todayVn, E_ROLE_ISOLATION.rec],
    );
    await db.query("update public.direct_entry_app_users set enabled = false where app_user_id = $1::uuid", [E_ROLE_ISOLATION.app]);
    // TL_A (team scope) must STILL be denied
    await assert.rejects(
      () => serviceRpc(db, "work_report_set_assignment_state", [
        TL_A.auth, TL_A.app, userAsgn.assignment_id, 1, "PAUSED", nextKey("tl-pause-denied"),
      ]),
      (err) => err?.code === "42501" && String(err.message).includes("WORK_REPORT_SCOPE_DENIED"),
    );
    // OWNER (all scope) succeeds pausing & revoking!
    const paused = await serviceRpc(db, "work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, userAsgn.assignment_id, 1, "PAUSED", nextKey("own-pause"),
    ]);
    assert.equal(paused.state, "PAUSED");
    const revoked = await serviceRpc(db, "work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, userAsgn.assignment_id, 2, "REVOKED", nextKey("own-revoke"),
    ]);
    assert.equal(revoked.state, "REVOKED");

    // 8. Role isolation: granting ADMIN role to UNLINKED_NORMAL does NOT add or remove Work Report obligations
    const obsBeforeRole = await serviceRpc(db, "work_report_list_my_obligations", [UNLINKED_NORMAL.auth, UNLINKED_NORMAL.app, null]);
    await db.query(
      `insert into public.authz_account_role_assignments (app_user_id, role_code, source_kind, reason, assigned_by_app_user_id)
       values ($1::uuid, 'ADMIN', 'ADMIN_ASSIGNMENT', 'WP9 WR role isolation test', $2::uuid)`,
      [UNLINKED_NORMAL.app, OWNER.app],
    );
    const obsAfterRole = await serviceRpc(db, "work_report_list_my_obligations", [UNLINKED_NORMAL.auth, UNLINKED_NORMAL.app, null]);
    assert.deepEqual(
      obsAfterRole.items.map((i) => i.obligation_id),
      obsBeforeRole.items.map((i) => i.obligation_id),
      "Granting ADMIN role produces ZERO change to Work Report obligations",
    );
  } finally {
    await db.close();
  }
});

// ============================================================================
// TEST 4: As-Of Team Transfer, GROUP Join-Date & Atomic Fail-Closed, ONCE, ARCHIVED, CANCELLED/EXEMPTED
// ============================================================================
test("WP9 [4/4]: Work Reports as-of team transfer (zero retroactive Team B OVERDUE), GROUP join-date & atomic fail-closed contract, ONCE singleton + replacement, ARCHIVED guard & CANCELLED/EXEMPTED parity", async () => {
  const { db } = await createDb();
  try {
    await setupCutoverCore(db);

    const { rows: [{ today_vn: todayVn }] } = await db.query(
      "select (now() at time zone 'Asia/Ho_Chi_Minh')::date::text as today_vn",
    );
    const dMinus15 = addDaysIso(todayVn, -15);
    const dMinus5 = addDaysIso(todayVn, -5);
    const dMinus3 = addDaysIso(todayVn, -3);
    const dMinus1 = addDaysIso(todayVn, -1);
    const dPlus1 = addDaysIso(todayVn, 1);

    for (const u of [TL_A, E_TRANSFER, E_GROUP_ORIG, E_GROUP_ADDED, E_TEAM_B_ONLY, E_ONCE_EMP]) {
      await seedBaseUser(db, u);
    }
    await linkRecruiterAndTeam(db, TL_A, TEAM_A, "2026-01-01");
    await linkRecruiterAndTeam(db, E_TRANSFER, TEAM_A, "2026-01-01");
    await linkRecruiterAndTeam(db, E_GROUP_ORIG, TEAM_A, "2026-01-01");
    await linkRecruiterAndTeam(db, E_GROUP_ADDED, TEAM_A, "2026-01-01");
    await linkRecruiterAndTeam(db, E_TEAM_B_ONLY, TEAM_B, "2026-01-01");
    await linkRecruiterAndTeam(db, E_ONCE_EMP, TEAM_A, "2026-01-01");

    await db.query(
      "update public.direct_entry_app_users set authz_managed = true where app_user_id = $1::uuid",
      [TL_A.app],
    );
    await db.query(
      `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01', true)`,
      [TEAM_A, TL_A.app, TL_A.rec],
    );

    const tplTeamA = await createPublishedTemplate(db, OWNER, "WP9_TA_DAILY", "Báo cáo Team A", "DAILY");
    const tplTeamB = await createPublishedTemplate(db, OWNER, "WP9_TB_DAILY", "Báo cáo Team B", "DAILY");
    const tplTeamBOnce = await createPublishedTemplate(db, OWNER, "WP9_TB_ONCE", "Đột xuất Team B", "ONCE");
    const tplGroup = await createPublishedTemplate(db, OWNER, "WP9_GRP_DAILY", "Báo cáo Nhóm", "DAILY");
    const tplOnce = await createPublishedTemplate(db, OWNER, "WP9_ONCE_SINGLE", "Báo cáo Một Lần", "ONCE");
    const tplArch = await createPublishedTemplate(db, OWNER, "WP9_ARCH_GUARD", "Biểu mẫu Lưu Trữ", "DAILY");

    // 1. Team Transfer (UAT-WP9-04 / R6):
    //    Team A & Team B both have active DAILY assignments from today-15; Team B also has active ONCE from today-5.
    await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplTeamA.template_id, "TEAM", null, TEAM_A, null,
      "DAILY", true, 0, "18:00:00", false, dMinus15, null, nextKey("ta-daily"),
    ]);
    await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplTeamB.template_id, "TEAM", null, TEAM_B, null,
      "DAILY", true, 0, "18:00:00", false, dMinus15, null, nextKey("tb-daily"),
    ]);
    await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplTeamBOnce.template_id, "TEAM", null, TEAM_B, null,
      "ONCE", true, 0, "18:00:00", false, dMinus5, dPlus1, nextKey("tb-once"),
    ]);

    // Pre-transfer: ensure Team A obligation for today-3 & today-1 while E_TRANSFER is in Team A
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, dMinus3]);
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, dMinus1]);

    // Transfer E_TRANSFER: Team A -> Team B effective TODAY (half-open [valid_from, valid_to))
    await db.query(
      `update public.recruiter_team_memberships
          set is_current = false, valid_to = $1::date
        where recruiter_id = $2::uuid and is_current`,
      [todayVn, E_TRANSFER.rec],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::date, true)`,
      [E_TRANSFER.rec, TEAM_B, todayVn],
    );
    // Clean any auto-materialized today row from Team A before testing post-transfer materialization
    await db.query(
      "delete from public.work_report_obligations where assignee_app_user_id = $1::uuid and period_start_date = $2::date",
      [E_TRANSFER.app, todayVn],
    );

    // Now E_TRANSFER opens list_my_obligations on TODAY (7-day lookback: today-6 .. today)
    await serviceRpc(db, "work_report_list_my_obligations", [E_TRANSFER.auth, E_TRANSFER.app, null]);

    const { rows: trTeamBObs } = await db.query(
      `select template_id, period_type, period_key, period_start_date::text as start_date, snapshot_team_id
         from public.work_report_obligations
        where assignee_app_user_id = $1::uuid
          and template_id in ($2::uuid, $3::uuid)
        order by period_start_date asc`,
      [E_TRANSFER.app, tplTeamB.template_id, tplTeamBOnce.template_id],
    );
    assert.equal(trTeamBObs.length, 2, "E_TRANSFER gets ONLY today's DAILY + today's ONCE for Team B (zero retroactive Team B rows)");
    for (const row of trTeamBObs) {
      assert.equal(row.start_date, todayVn, `Team B obligation ${row.period_key} must start on transfer date ${todayVn}`);
      assert.equal(row.snapshot_team_id, TEAM_B, `Team B obligation ${row.period_key} must snapshot Team B`);
    }

    const { rows: trTeamAObs } = await db.query(
      `select period_start_date::text as start_date, snapshot_team_id
         from public.work_report_obligations
        where assignee_app_user_id = $1::uuid
          and template_id = $2::uuid
        order by period_start_date asc`,
      [E_TRANSFER.app, tplTeamA.template_id],
    );
    assert.ok(trTeamAObs.length >= 2, "Pre-transfer Team A obligations preserved");
    for (const row of trTeamAObs) {
      assert.ok(row.start_date < todayVn, `Team A must NOT create new obligation on transfer date ${todayVn} (got ${row.start_date})`);
      assert.equal(row.snapshot_team_id, TEAM_A, `Every pre-transfer Team A lookback row (${row.start_date}) must snapshot Team A, NEVER Team B`);
    }

    // 1b. Mid-week WEEKLY & MONTHLY Team A -> Team B transfer + pre-transfer USER WEEKLY + cross-team TL isolation:
    //     Pinned to fixed future Thursday 2099-10-15 (week 2099-W42 Mon 12..Sun 18, month 2099-10) for calendar-independent determinism & open submit deadline.
    const TL_B = { auth: "19000000-0000-4000-8000-000000000028", app: "29000000-0000-4000-8000-000000000028", rec: "39000000-0000-4000-8000-000000000028", email: "tl.b@hrpartner.vn", name: "TL Team B" };
    const E_MIDWEEK = { auth: "19000000-0000-4000-8000-000000000029", app: "29000000-0000-4000-8000-000000000029", rec: "39000000-0000-4000-8000-000000000029", email: "e.midweek@hrpartner.vn", name: "NV Chuyển Giữa Tuần" };
    await seedBaseUser(db, TL_B);
    await seedBaseUser(db, E_MIDWEEK);
    await linkRecruiterAndTeam(db, TL_B, TEAM_B, "2026-01-01");
    await linkRecruiterAndTeam(db, E_MIDWEEK, TEAM_A, "2026-01-01");
    await db.query("update public.direct_entry_app_users set authz_managed = true where app_user_id = $1::uuid", [TL_B.app]);
    await db.query(
      `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01', true)`,
      [TEAM_B, TL_B.app, TL_B.rec],
    );
    // Transfer E_MIDWEEK: TEAM_A [2026-01-01, 2099-10-15) -> TEAM_B [2099-10-15, null)
    await db.query(
      "update public.recruiter_team_memberships set is_current = false, valid_to = '2099-10-15' where recruiter_id = $1::uuid and is_current",
      [E_MIDWEEK.rec],
    );
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2099-10-15', true)",
      [E_MIDWEEK.rec, TEAM_B],
    );

    const tplTeamAWeekly = await createPublishedTemplate(db, OWNER, "WP9_TA_WK", "Báo cáo Tuần Team A", "WEEKLY");
    const tplTeamAMonthly = await createPublishedTemplate(db, OWNER, "WP9_TA_MO", "Báo cáo Tháng Team A", "MONTHLY");
    const tplUserPreWeekly = await createPublishedTemplate(db, OWNER, "WP9_U_PRE_WK", "Báo cáo Cá Nhân Trước Chuyển", "WEEKLY");
    await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplTeamAWeekly.template_id, "TEAM", null, TEAM_A, null,
      "WEEKLY", true, 0, "18:00:00", false, "2099-10-01", null, nextKey("ta-wk"),
    ]);
    await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplTeamAMonthly.template_id, "TEAM", null, TEAM_A, null,
      "MONTHLY", true, 0, "18:00:00", false, "2099-10-01", null, nextKey("ta-mo"),
    ]);
    await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplUserPreWeekly.template_id, "USER", E_MIDWEEK.app, null, null,
      "WEEKLY", true, 0, "18:00:00", false, "2099-10-12", "2099-10-14", nextKey("u-pre-wk"),
    ]);
    // Invoke actor lookback materialization on Thu 2099-10-15 (when E_MIDWEEK is already in TEAM_B)
    await db.query(
      "select public.work_report__internal_materialize_actor_obligations($1::uuid, '2099-10-15'::date, 7)",
      [E_MIDWEEK.app],
    );
    const { rows: midweekRows } = await db.query(
      `select obligation_id, template_id, period_key, snapshot_team_id
         from public.work_report_obligations
        where assignee_app_user_id = $1::uuid
          and template_id in ($2::uuid, $3::uuid, $4::uuid)
        order by period_key`,
      [E_MIDWEEK.app, tplTeamAWeekly.template_id, tplTeamAMonthly.template_id, tplUserPreWeekly.template_id],
    );
    assert.equal(midweekRows.length, 4, "7-day lookback (Oct 09..15) creates Team A WEEKLY (W41 + W42), Team A MONTHLY (2099-10), and pre-transfer USER WEEKLY (W42)");
    for (const r of midweekRows) {
      assert.equal(r.snapshot_team_id, TEAM_A, `Mid-week lookback obligation ${r.period_key} must stamp TEAM_A (never post-transfer TEAM_B)`);
    }
    // Cross-team read isolation: E_MIDWEEK submits Team A mid-week WEEKLY (2099-W42) -> TL_A reads cleanly, TL_B is strictly denied (42501)!
    const wkOb = midweekRows.find((r) => r.template_id === tplTeamAWeekly.template_id && r.period_key === "2099-W42");
    assert.ok(wkOb, "Team A mid-week 2099-W42 obligation must exist");
    await serviceRpc(db, "work_report_submit", [
      E_MIDWEEK.auth, E_MIDWEEK.app, wkOb.obligation_id,
      JSON.stringify({ calls_made: 5, interested_candidates: 2, workers_started: 1, notes: null }), null, nextKey("sub-midwk"),
    ]);
    const tlARead = await serviceRpc(db, "work_report_get_submission", [TL_A.auth, TL_A.app, wkOb.obligation_id]);
    assert.equal(tlARead.obligation.obligation_id, wkOb.obligation_id, "TL_A retains read access to Team A mid-week WEEKLY obligation");
    await assert.rejects(
      () => serviceRpc(db, "work_report_get_submission", [TL_B.auth, TL_B.app, wkOb.obligation_id]),
      (err) => err?.code === "42501",
      "TL_B must be strictly denied access to Team A mid-week WEEKLY obligation",
    );

    // 2. GROUP join-date (zero retroactive OVERDUE for newly added member) + WP9-GAP07 atomic fail-closed contract
    const grp1 = await serviceRpc(db, "work_report_create_group", [
      OWNER.auth, OWNER.app, "Nhóm WP9", "Nhóm kiểm thử ngày thêm", [E_GROUP_ORIG.app], nextKey("grp1"),
    ]);
    // Backdate group member & assignment created_at to 10 days ago so M_Orig is pre-existing and M_Added is added today
    const grpAsgn = await serviceRpc(db, "work_report_create_group_assignment", [
      OWNER.auth, OWNER.app, tplGroup.template_id, grp1.group_id,
      "DAILY", true, 0, "18:00:00", false, dMinus5, null, nextKey("grp1-asgn"),
    ]);
    await db.query(
      "update public.work_report_group_members set created_at = now() - interval '10 days' where group_id = $1::uuid and member_user_id = $2::uuid",
      [grp1.group_id, E_GROUP_ORIG.app],
    );
    await db.query(
      "update public.work_report_assignments set created_at = now() - interval '9 days' where assignment_id = $1::uuid",
      [grpAsgn.assignment_id],
    );

    // Add E_GROUP_ADDED to Group 1 today via work_report_update_group (preserves E_GROUP_ORIG.created_at!)
    await serviceRpc(db, "work_report_update_group", [
      OWNER.auth, OWNER.app, grp1.group_id, 1, "Nhóm WP9", "Thêm thành viên mới",
      [E_GROUP_ORIG.app, E_GROUP_ADDED.app], nextKey("grp1-upd"),
    ]);
    await serviceRpc(db, "work_report_list_my_obligations", [E_GROUP_ORIG.auth, E_GROUP_ORIG.app, null]);
    await serviceRpc(db, "work_report_list_my_obligations", [E_GROUP_ADDED.auth, E_GROUP_ADDED.app, null]);

    const { rows: origGrpObs } = await db.query(
      `select period_start_date::text as start_date from public.work_report_obligations
        where assignment_id = $1::uuid and assignee_app_user_id = $2::uuid order by period_start_date asc`,
      [grpAsgn.assignment_id, E_GROUP_ORIG.app],
    );
    const { rows: addedGrpObs } = await db.query(
      `select period_start_date::text as start_date from public.work_report_obligations
        where assignment_id = $1::uuid and assignee_app_user_id = $2::uuid order by period_start_date asc`,
      [grpAsgn.assignment_id, E_GROUP_ADDED.app],
    );
    assert.ok(origGrpObs.length >= 6, "Original group member keeps lookback from effective_from (today-5..today)");
    assert.deepEqual(
      addedGrpObs.map((r) => r.start_date),
      [todayVn],
      "Newly added group member receives ONLY today's obligation (ZERO retroactive fake OVERDUE)",
    );

    // WP9-GAP07: TL-assigned group keeps atomic fail-closed when an active member moves out of TL scope,
    // while already-materialized historical obligations are NOT deleted!
    const tplTlGrp = await createPublishedTemplate(db, OWNER, "WP9_TL_GRP", "Báo cáo Nhóm TL", "DAILY");
    const tlGrp = await serviceRpc(db, "work_report_create_group", [
      TL_A.auth, TL_A.app, "Nhóm TL A", null, [E_GROUP_ORIG.app, E_GROUP_ADDED.app], nextKey("tl-grp"),
    ]);
    const tlGrpAsgn = await serviceRpc(db, "work_report_create_group_assignment", [
      TL_A.auth, TL_A.app, tplTlGrp.template_id, tlGrp.group_id,
      "DAILY", true, 0, "18:00:00", false, todayVn, null, nextKey("tl-grp-asgn"),
    ]);
    // Move E_GROUP_ADDED out of TEAM_A into TEAM_B -> TL_A's group now contains out-of-scope member
    await db.query(
      "update public.recruiter_team_memberships set is_current = false, valid_to = $1::date where recruiter_id = $2::uuid and is_current",
      [todayVn, E_GROUP_ADDED.rec],
    );
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, $3::date, true)",
      [E_GROUP_ADDED.rec, TEAM_B, todayVn],
    );
    // Next day materialization by TL_A fails closed for the out-of-scope group atomically (0 new rows for E_GROUP_ORIG on today+1),
    // AND actor materialization (list_my_obligations) skips atomically because assigned_by_user_id = TL_A lost scope,
    // while today's existing historical obligation stays intact!
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [TL_A.auth, TL_A.app, dPlus1]);
    await serviceRpc(db, "work_report_list_my_obligations", [E_GROUP_ORIG.auth, E_GROUP_ORIG.app, null]);
    const { rows: tlGrpObsAfter } = await db.query(
      `select period_start_date::text as start_date from public.work_report_obligations
        where assignment_id = $1::uuid and assignee_app_user_id = $2::uuid order by period_start_date asc`,
      [tlGrpAsgn.assignment_id, E_GROUP_ORIG.app],
    );
    assert.deepEqual(
      tlGrpObsAfter.map((r) => r.start_date),
      [todayVn],
      "WP9-GAP07: atomic fail-closed blocks future materialization on out-of-scope group while preserving historical row",
    );

    // 3. WP9-GAP06: ONCE singleton across ensure_window(today+1), pause/resume, EXEMPTED/submitted protection,
    //    AND replacement ONCE assignment reactivation on unsubmitted CANCELLED!
    const onceAsgn1 = await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplOnce.template_id, "USER", E_ONCE_EMP.app, null, null,
      "ONCE", true, 0, "18:00:00", false, todayVn, dPlus1, nextKey("once-1"),
    ]);
    // Call ensure_obligations_for_window on today+1 -> MUST insert 0 duplicate ONCE-(today+1)!
    const ensureOnceNext = await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, dPlus1]);
    const { rows: onceRows1 } = await db.query(
      "select obligation_id, period_key, obligation_status from public.work_report_obligations where assignment_id = $1::uuid and assignee_app_user_id = $2::uuid",
      [onceAsgn1.assignment_id, E_ONCE_EMP.app],
    );
    assert.equal(onceRows1.length, 1, "ONCE assignment creates at most 1 obligation across ensure_window(today+1)");
    assert.equal(onceRows1[0].period_key, `ONCE-${todayVn}`);

    // Pause & resume on today+1 -> still 0 duplicates!
    await serviceRpc(db, "work_report_set_assignment_state", [OWNER.auth, OWNER.app, onceAsgn1.assignment_id, 1, "PAUSED", nextKey("once-p")]);
    await serviceRpc(db, "work_report_set_assignment_state", [OWNER.auth, OWNER.app, onceAsgn1.assignment_id, 2, "ACTIVE", nextKey("once-a")]);
    const { rows: onceRowsAfterResume } = await db.query(
      "select obligation_id from public.work_report_obligations where assignment_id = $1::uuid and assignee_app_user_id = $2::uuid",
      [onceAsgn1.assignment_id, E_ONCE_EMP.app],
    );
    assert.equal(onceRowsAfterResume.length, 1, "Pause/resume ONCE assignment creates 0 duplicate obligations");

    // EXEMPT the ONCE obligation -> ensure_window(today) and list_my_obligations MUST preserve EXEMPTED (never overwrite/duplicate)!
    await serviceRpc(db, "work_report_change_obligation_status", [
      OWNER.auth, OWNER.app, onceRows1[0].obligation_id, 1, "EXEMPT", "Miễn báo cáo đột xuất", null, nextKey("once-ex"),
    ]);
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayVn]);
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, dPlus1]);
    await serviceRpc(db, "work_report_list_my_obligations", [E_ONCE_EMP.auth, E_ONCE_EMP.app, null]);
    const { rows: onceExemptRows } = await db.query(
      "select obligation_status from public.work_report_obligations where assignment_id = $1::uuid and assignee_app_user_id = $2::uuid",
      [onceAsgn1.assignment_id, E_ONCE_EMP.app],
    );
    assert.deepEqual(onceExemptRows.map((r) => r.obligation_status), ["EXEMPTED"], "EXEMPTED ONCE obligation preserved with 0 duplicates");

    // 3b. R3/P2: Same-assignment ONCE REVOKED -> ACTIVE restores EXACT original unsubmitted CANCELLED
    //     obligation_id (same-day AND next-day), keeps READ ONLY nav probe parity, preserves submitted
    //     & EXEMPTED rows without creating any duplicate 2nd row!
    const TEAM_C = "49000000-0000-4000-8000-000000000003";
    await db.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'WP9_TEAM_C', 'Đội Kiểm Thử ONCE', true)",
      [TEAM_C],
    );
    const E_ONCE_RESTORE = { auth: "19000000-0000-4000-8000-000000000035", app: "29000000-0000-4000-8000-000000000035", rec: "39000000-0000-4000-8000-000000000035", email: "e.once.restore@hrpartner.vn", name: "NV Khôi Phục ONCE" };
    await seedBaseUser(db, E_ONCE_RESTORE);
    await linkRecruiterAndTeam(db, E_ONCE_RESTORE, TEAM_C, "2026-01-01");

    // (i) Same-day USER/ONCE: ACTIVE -> REVOKED -> ACTIVE (T0 canonical repro)
    const tplOnceSameDay = await createPublishedTemplate(db, OWNER, "WP9_ONCE_R3_SAME", "ONCE Khôi Phục Cùng Ngày", "ONCE");
    const onceSameAsgn = await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplOnceSameDay.template_id, "USER", E_ONCE_RESTORE.app, null, null,
      "ONCE", true, 0, "18:00:00", false, todayVn, dPlus1, nextKey("r3-same-create"),
    ]);
    const { rows: [sameOb1] } = await db.query(
      "select obligation_id, period_key, obligation_status, version from public.work_report_obligations where assignment_id = $1::uuid",
      [onceSameAsgn.assignment_id],
    );
    assert.equal(sameOb1.obligation_status, "ACTIVE");
    assert.equal(sameOb1.version, 1);

    const sameRevoked = await serviceRpc(db, "work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, onceSameAsgn.assignment_id, 1, "REVOKED", nextKey("r3-same-rev"),
    ]);
    assert.equal(sameRevoked.state, "REVOKED");
    assert.equal(sameRevoked.version, 2);
    const { rows: [sameOb2] } = await db.query(
      "select obligation_id, obligation_status, version from public.work_report_obligations where assignment_id = $1::uuid",
      [onceSameAsgn.assignment_id],
    );
    assert.equal(sameOb2.obligation_id, sameOb1.obligation_id);
    assert.equal(sameOb2.obligation_status, "CANCELLED");
    assert.equal(sameOb2.version, 2);
    const probeWhileRevoked = await serviceRpc(
      db,
      "work_report_has_active_obligations",
      [E_ONCE_RESTORE.auth, E_ONCE_RESTORE.app],
      { readOnly: true },
    );
    assert.strictEqual(probeWhileRevoked.has_active_obligations, false, "R3: READ ONLY probe is false while ONCE is REVOKED/CANCELLED");

    const sameRestored = await serviceRpc(db, "work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, onceSameAsgn.assignment_id, 2, "ACTIVE", nextKey("r3-same-act"),
    ]);
    assert.equal(sameRestored.state, "ACTIVE");
    assert.equal(sameRestored.version, 3);
    const { rows: sameOb3Rows } = await db.query(
      "select obligation_id, period_key, obligation_status, version, snapshot_team_id from public.work_report_obligations where assignment_id = $1::uuid",
      [onceSameAsgn.assignment_id],
    );
    assert.equal(sameOb3Rows.length, 1, "R3: Same-day REVOKED->ACTIVE keeps singleton (1 row)");
    assert.equal(sameOb3Rows[0].obligation_id, sameOb1.obligation_id, "R3: Exact original obligation_id restored");
    assert.equal(sameOb3Rows[0].obligation_status, "ACTIVE", "R3: Restored obligation is ACTIVE");
    assert.equal(sameOb3Rows[0].version, 3, "R3: Restored obligation version advances 2 -> 3");
    assert.equal(sameOb3Rows[0].snapshot_team_id, TEAM_C);

    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, todayVn]);
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, dPlus1]);
    await serviceRpc(db, "work_report_list_my_obligations", [E_ONCE_RESTORE.auth, E_ONCE_RESTORE.app, null]);
    const { rows: sameObAfterEnsure } = await db.query(
      "select obligation_id, obligation_status from public.work_report_obligations where assignment_id = $1::uuid",
      [onceSameAsgn.assignment_id],
    );
    assert.deepEqual(
      sameObAfterEnsure,
      [{ obligation_id: sameOb1.obligation_id, obligation_status: "ACTIVE" }],
      "R3: Subsequent ensure_window(today/today+1) and list_my_obligations create 0 duplicates",
    );
    const countsBeforeRoProbe = await countWrTables(db);
    const probeAfterRestore = await serviceRpc(
      db,
      "work_report_has_active_obligations",
      [E_ONCE_RESTORE.auth, E_ONCE_RESTORE.app],
      { readOnly: true },
    );
    assert.strictEqual(probeAfterRestore.has_active_obligations, true, "R3: READ ONLY probe returns true after restore");
    assert.deepEqual(await countWrTables(db), countsBeforeRoProbe, "R3: READ ONLY probe performs 0 writes");

    // (ii) Next-day ONCE restore: materialized on dMinus1 (ONCE-dMinus1), REVOKED, then reactivated on todayVn ->
    //      restores EXACT original ONCE-dMinus1 row with 0 duplicate ONCE-todayVn row!
    const tplOnceNextDay = await createPublishedTemplate(db, OWNER, "WP9_ONCE_R3_NEXT", "ONCE Khôi Phục Hôm Sau", "ONCE");
    const onceNextAsgn = await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplOnceNextDay.template_id, "USER", E_ONCE_RESTORE.app, null, null,
      "ONCE", true, 0, "18:00:00", false, dMinus1, dPlus1, nextKey("r3-next-create"),
    ]);
    // Re-key the materialized row to dMinus1 to simulate Day-1 creation prior to Day-2 reactivation
    const { rows: [nextObOrig] } = await db.query(
      `update public.work_report_obligations
          set period_key = $2,
              period_start_date = $3::date,
              period_end_date = $3::date
        where assignment_id = $1::uuid
        returning obligation_id, period_key`,
      [onceNextAsgn.assignment_id, `ONCE-${dMinus1}`, dMinus1],
    );
    await serviceRpc(db, "work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, onceNextAsgn.assignment_id, 1, "REVOKED", nextKey("r3-next-rev"),
    ]);
    await serviceRpc(db, "work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, onceNextAsgn.assignment_id, 2, "ACTIVE", nextKey("r3-next-act"),
    ]);
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, dPlus1]);
    await serviceRpc(db, "work_report_list_my_obligations", [E_ONCE_RESTORE.auth, E_ONCE_RESTORE.app, null]);
    const { rows: nextObRows } = await db.query(
      "select obligation_id, period_key, obligation_status, version, snapshot_team_id from public.work_report_obligations where assignment_id = $1::uuid",
      [onceNextAsgn.assignment_id],
    );
    assert.equal(nextObRows.length, 1, "R3: Next-day REVOKED->ACTIVE restores singleton (0 duplicate ONCE-todayVn)");
    assert.equal(nextObRows[0].obligation_id, nextObOrig.obligation_id);
    assert.equal(nextObRows[0].period_key, `ONCE-${dMinus1}`);
    assert.equal(nextObRows[0].obligation_status, "ACTIVE");
    assert.equal(nextObRows[0].version, 3);
    assert.equal(nextObRows[0].snapshot_team_id, TEAM_C);

    // (iii) Submitted ONCE across REVOKED -> ACTIVE keeps exact 1 submitted row and 0 duplicates
    const tplOnceSub = await createPublishedTemplate(db, OWNER, "WP9_ONCE_R3_SUB", "ONCE Đã Nộp", "ONCE");
    const onceSubAsgn = await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplOnceSub.template_id, "USER", E_ONCE_RESTORE.app, null, null,
      "ONCE", true, 0, "18:00:00", false, todayVn, dPlus1, nextKey("r3-sub-create"),
    ]);
    const { rows: [subObOrig] } = await db.query(
      "select obligation_id from public.work_report_obligations where assignment_id = $1::uuid",
      [onceSubAsgn.assignment_id],
    );
    await serviceRpc(db, "work_report_submit", [
      E_ONCE_RESTORE.auth, E_ONCE_RESTORE.app, subObOrig.obligation_id,
      JSON.stringify({ calls_made: 9, interested_candidates: 3, workers_started: 1, notes: null }), null, nextKey("r3-sub-submit"),
    ]);
    await serviceRpc(db, "work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, onceSubAsgn.assignment_id, 1, "REVOKED", nextKey("r3-sub-rev"),
    ]);
    await serviceRpc(db, "work_report_set_assignment_state", [
      OWNER.auth, OWNER.app, onceSubAsgn.assignment_id, 2, "ACTIVE", nextKey("r3-sub-act"),
    ]);
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, dPlus1]);
    await serviceRpc(db, "work_report_list_my_obligations", [E_ONCE_RESTORE.auth, E_ONCE_RESTORE.app, null]);
    const { rows: subObAfter } = await db.query(
      `select o.obligation_id, o.obligation_status, s.first_submitted_at is not null as is_submitted
         from public.work_report_obligations o
         left join public.work_report_submissions s on s.obligation_id = o.obligation_id
        where o.assignment_id = $1::uuid`,
      [onceSubAsgn.assignment_id],
    );
    assert.deepEqual(
      subObAfter,
      [{ obligation_id: subObOrig.obligation_id, obligation_status: "ACTIVE", is_submitted: true }],
      "R3: Submitted ONCE across REVOKED->ACTIVE keeps exact 1 submitted row and 0 duplicates",
    );

    // (iv) EXEMPTED ONCE across REVOKED -> ACTIVE stays EXEMPTED with 0 duplicates
    await serviceRpc(db, "work_report_set_assignment_state", [OWNER.auth, OWNER.app, onceAsgn1.assignment_id, 3, "REVOKED", nextKey("once-ex-rev")]);
    await serviceRpc(db, "work_report_set_assignment_state", [OWNER.auth, OWNER.app, onceAsgn1.assignment_id, 4, "ACTIVE", nextKey("once-ex-act")]);
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, dPlus1]);
    await serviceRpc(db, "work_report_list_my_obligations", [E_ONCE_EMP.auth, E_ONCE_EMP.app, null]);
    const { rows: onceExemptAfterRevokeReactivate } = await db.query(
      "select obligation_id, obligation_status from public.work_report_obligations where assignment_id = $1::uuid and assignee_app_user_id = $2::uuid",
      [onceAsgn1.assignment_id, E_ONCE_EMP.app],
    );
    assert.deepEqual(
      onceExemptAfterRevokeReactivate,
      [{ obligation_id: onceRows1[0].obligation_id, obligation_status: "EXEMPTED" }],
      "R3: EXEMPTED ONCE stays EXEMPTED across REVOKED->ACTIVE with 0 duplicates",
    );

    // Independent replacement ONCE after revoking an unsubmitted CANCELLED ONCE -> ensure_window reactivates cleanly!
    const tplOnceRepl = await createPublishedTemplate(db, OWNER, "WP9_ONCE_REPL", "Đột xuất thay thế", "ONCE");
    const onceOld = await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplOnceRepl.template_id, "USER", E_ONCE_EMP.app, null, null,
      "ONCE", true, 0, "18:00:00", false, todayVn, dPlus1, nextKey("once-old"),
    ]);
    await serviceRpc(db, "work_report_set_assignment_state", [OWNER.auth, OWNER.app, onceOld.assignment_id, 1, "REVOKED", nextKey("once-rev")]);
    const { rows: [cancelledRow] } = await db.query(
      "select obligation_id, obligation_status from public.work_report_obligations where assignment_id = $1::uuid",
      [onceOld.assignment_id],
    );
    assert.equal(cancelledRow.obligation_status, "CANCELLED");

    const onceRepl = await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplOnceRepl.template_id, "USER", E_ONCE_EMP.app, null, null,
      "ONCE", true, 0, "18:00:00", false, todayVn, dPlus1, nextKey("once-new"),
    ]);
    const { rows: [reactivatedRow] } = await db.query(
      "select obligation_id, assignment_id, obligation_status from public.work_report_obligations where obligation_id = $1::uuid",
      [cancelledRow.obligation_id],
    );
    assert.equal(reactivatedRow.assignment_id, onceRepl.assignment_id, "Replacement ONCE cleanly rebinds unsubmitted CANCELLED slot");
    assert.equal(reactivatedRow.obligation_status, "ACTIVE");

    // 4. WP9-GAP06: ARCHIVED template guard in ensure_obligations_for_window
    const archAsgn = await serviceRpc(db, "work_report_create_assignment", [
      OWNER.auth, OWNER.app, tplArch.template_id, "USER", E_ONCE_EMP.app, null, null,
      "DAILY", true, 0, "18:00:00", false, todayVn, null, nextKey("arch-asgn"),
    ]);
    await serviceRpc(db, "work_report_archive_template", [
      OWNER.auth, OWNER.app, tplArch.template_id, 2, nextKey("arch-tpl"),
    ]);
    await serviceRpc(db, "work_report_ensure_obligations_for_window", [OWNER.auth, OWNER.app, dPlus1]);
    const { rows: archNextRows } = await db.query(
      "select period_start_date::text as start_date from public.work_report_obligations where assignment_id = $1::uuid",
      [archAsgn.assignment_id],
    );
    assert.deepEqual(
      archNextRows.map((r) => r.start_date),
      [todayVn],
      "ARCHIVED template creates 0 new obligations via work_report_ensure_obligations_for_window while preserving historical row",
    );
    assert.ok(ensureOnceNext);
  } finally {
    await db.close();
  }
});
