/**
 * Leave Management WP1 — Comprehensive Database, Policy, Ledger/FIFO, Routing & Non-Regression Suite.
 *
 * Verifies on ephemeral PGlite across the full repository migration chain:
 *   1. Migration apply, transaction atomicity, FORCE RLS on all 13 `leave_*` tables,
 *      zero direct table grants, `service_role`-only EXECUTE on the 13 public RPCs,
 *      and append-only immutability triggers on audit/ledger/revision/batch/idempotency tables.
 *   2. Zero regression on existing `direct_entry_*`, `teams`, `recruiters`, and `organization_departments`
 *      schemas, data, and `direct_entry_resolve_actor_context`.
 *   3. Unconfigured personal account (`UNCONFIGURED` / missing `work_start_date`):
 *      can view summary (`available_units = 0`, `profile_configured = false`) and submit leave requests
 *      marked `UNPAID_UNCONFIGURED_PROFILE`, routed to `ADMIN_BOD_FALLBACK` (`PROFILE_UNCONFIGURED_OR_UNMAPPED`).
 *   4. Shared Marketing non-employee account (`is_shared_non_employee = true`):
 *      blocked from `get_my_summary`, `create_request`, `withdraw_request`, `decide_request`,
 *      excluded from `monthly_report`, and rejected in `preview/apply_opening_batch`.
 *   5. Monthly accrual & mid-month hire date:
 *      - Base 12 days/year (24 half-day units); month M unlocks at most M days (M=3 -> 6 units, M=12 -> 24 units);
 *        future months > M are never unlocked early.
 *      - Mid-month start date (e.g. `2026-03-20`) still earns the full 1 day (2 units) for month 3.
 *   6. Probation & transition to Official:
 *      - `PROBATION` employee has 0 paid units, submits requests as `UNPAID_PROBATION`, approval does not consume lots.
 *      - Transition `PROBATION -> OFFICIAL` backfills catch-up lots (`PROBATION_CATCHUP`) from `work_start_date`
 *        month through current month with `usable_from_date >= official_effective_date`; repeated syncs are idempotent.
 *   7. Seniority leave:
 *      - Default +1 day (2 units) per 5 years of service.
 *      - Admin/BoD per-employee `next_seniority_effective_date` & `next_seniority_units` (with HR operator blocked
 *        by `LEAVE_SENIORITY_CONFIG_FORBIDDEN`), unlocking only on/after `next_seniority_effective_date`.
 *   8. Carry-over expiry (`X` / `X + 1`) & FIFO lot consumption:
 *      - Initial policy has `carry_over_expiry_month = NULL, carry_over_expiry_day = NULL`; applying `CARRY_OVER`
 *        opening balance fails closed (`LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED`) until Admin/BoD configures `X`.
 *      - Once configured as `2026-03-31`, `CARRY_OVER` is usable through `2026-03-31` and consumed first (FIFO)
 *        before monthly accrual lots.
 *      - Starting `2026-04-01` (`X + 1`), remaining `CARRY_OVER` units automatically expire (`EXPIRE_CARRY_OVER`).
 *   9. Half-day sessions (`FULL = 2`, `AM = 1`, `PM = 1`) & overlap guard:
 *      - `AM` + `PM` on the same date is allowed; `AM` + `AM`, `PM` + `PM`, or `FULL` + `AM`/`PM` is rejected (`LEAVE_REQUEST_OVERLAP`).
 *  10. Approval routing, self-approval prohibition, reservation (`RESERVE`/`CONSUME`), withdrawal, and post-approval cancellation:
 *      - Recruitment employee routes to active `TEAM_LEADER`; Marketing/IT routes to configured `DEPARTMENT_HEAD`
 *        (or `ADMIN_BOD_FALLBACK` if unconfigured); Team Leader / Department Head routes to `ADMIN_BOD_DIRECT`.
 *      - Self-approval is strictly rejected (`LEAVE_SELF_APPROVAL_FORBIDDEN`).
 *      - Requester can withdraw `PENDING` (`WITHDRAWN`), freeing the dates, but cannot withdraw `APPROVED`.
 *      - Authorized approver or Admin/BoD can cancel `APPROVED` (`CANCEL_APPROVED` with mandatory reason),
 *        reversing/releasing units back to the exact original `lot_id` (and immediately expiring returned carry-over
 *        units if cancelled after `X`).
 *  11. Single & bulk opening balance preview + atomic apply.
 *  12. Narrow `HR_REPORT_VIEWER` grant/revoke by Full Admin and monthly report accuracy.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import {
  LEAVE_MANAGEMENT_WP1_MIGRATION_NAME,
  LEAVE_MANAGEMENT_WP1_RPC_SIGNATURES,
  LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_RPC_SIGNATURE,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const TEAM_ALPHA = "99000000-0000-4000-8000-00000000000a";
const TEAM_BETA = "99000000-0000-4000-8000-00000000000b";

const ACTORS = {
  fullAdmin: {
    auth: "19000000-0000-4000-8000-000000000001",
    app: "29000000-0000-4000-8000-000000000001",
    email: "admin@company.local",
    name: "Full Admin",
  },
  bodUser: {
    auth: "19000000-0000-4000-8000-000000000002",
    app: "29000000-0000-4000-8000-000000000002",
    email: "bod@company.local",
    name: "Ban Giám Đốc",
  },
  hrOperator: {
    auth: "19000000-0000-4000-8000-000000000003",
    app: "29000000-0000-4000-8000-000000000003",
    email: "hr.operator@company.local",
    name: "HR Vận Hành Phép",
  },
  hrViewer: {
    auth: "19000000-0000-4000-8000-000000000004",
    app: "29000000-0000-4000-8000-000000000004",
    email: "hr.report@company.local",
    name: "HR Xem Báo Cáo",
  },
  leaderAlpha: {
    auth: "19000000-0000-4000-8000-000000000005",
    app: "29000000-0000-4000-8000-000000000005",
    recruiter: "39000000-0000-4000-8000-000000000005",
    email: "leader.alpha@company.local",
    name: "Trưởng Nhóm Alpha",
    code: "TL-A",
  },
  leaderBeta: {
    auth: "19000000-0000-4000-8000-000000000006",
    app: "29000000-0000-4000-8000-000000000006",
    recruiter: "39000000-0000-4000-8000-000000000006",
    email: "leader.beta@company.local",
    name: "Trưởng Nhóm Beta",
    code: "TL-B",
  },
  recruiterOfficial: {
    auth: "19000000-0000-4000-8000-000000000007",
    app: "29000000-0000-4000-8000-000000000007",
    recruiter: "39000000-0000-4000-8000-000000000007",
    email: "recruiter.official@company.local",
    name: "Chuyên Viên Tuyển Dụng Chính Thức",
    code: "NV-TD-01",
  },
  recruiterMidMonth: {
    auth: "19000000-0000-4000-8000-000000000008",
    app: "29000000-0000-4000-8000-000000000008",
    recruiter: "39000000-0000-4000-8000-000000000008",
    email: "recruiter.midmonth@company.local",
    name: "Nhân Viên Vào Giữa Tháng",
    code: "NV-TD-02",
  },
  probationUser: {
    auth: "19000000-0000-4000-8000-000000000009",
    app: "29000000-0000-4000-8000-000000000009",
    recruiter: "39000000-0000-4000-8000-000000000009",
    email: "probation@company.local",
    name: "Nhân Viên Thử Việc",
    code: "NV-TV-01",
  },
  marketingHead: {
    auth: "19000000-0000-4000-8000-000000000010",
    app: "29000000-0000-4000-8000-000000000010",
    email: "mkt.head@company.local",
    name: "Trưởng Phòng Marketing",
  },
  marketingStaff: {
    auth: "19000000-0000-4000-8000-000000000011",
    app: "29000000-0000-4000-8000-000000000011",
    email: "mkt.staff@company.local",
    name: "Nhân Viên Marketing",
  },
  sharedMarketing: {
    auth: "19000000-0000-4000-8000-000000000012",
    app: "29000000-0000-4000-8000-000000000012",
    email: "marketing@company.local",
    name: "Tài Khoản Marketing Dùng Chung",
  },
  unconfiguredUser: {
    auth: "19000000-0000-4000-8000-000000000013",
    app: "29000000-0000-4000-8000-000000000013",
    email: "unconfigured@company.local",
    name: "Nhân Viên Chưa Cấu Hình Hồ Sơ",
  },
  inactiveAccount: {
    auth: "19000000-0000-4000-8000-000000000014",
    app: "29000000-0000-4000-8000-000000000014",
    email: "inactive@company.local",
    name: "Tài Khoản Đã Ngừng",
  },
};

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

async function setBusinessDate(db, isoDate) {
  await db.exec(`
    create or replace function public.direct_entry_authorization_date()
    returns date
    language sql
    stable
    security definer
    set search_path = pg_catalog, public
    as $function$
      select '${isoDate}'::date
    $function$;
    revoke all on function public.direct_entry_authorization_date() from public, anon, authenticated, service_role;
  `);
}

let idemCounter = 0;
function nextIdem(prefix = "leave") {
  idemCounter += 1;
  return `${prefix}-idem-${idemCounter}`;
}

test("Leave Management WP1 full PGlite integration & business rule verification", async () => {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  await db.exec("alter table auth.users add column email text;");

  const migrations = await loadMigrations();
  const wp1Index = migrations.findIndex(
    (m) => m.name === LEAVE_MANAGEMENT_WP1_MIGRATION_NAME,
  );
  assert.ok(wp1Index >= 0, "WP1 migration must exist");

  for (const m of migrations.slice(0, wp1Index)) {
    await db.exec(m.sql);
  }

  // Seed actors & teams before WP1 migration to verify non-regression
  for (const actor of Object.values(ACTORS)) {
    await db.query(
      "insert into auth.users (id, email) values ($1, $2)",
      [actor.auth, actor.email],
    );
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name) values ($1, $2, true, $3)",
      [actor.app, actor.auth, actor.name],
    );
  }
  await db.query(
    "update public.direct_entry_app_users set enabled = false where app_user_id = $1",
    [ACTORS.inactiveAccount.app],
  );

  // Grant Full Admin capabilities + all scope
  for (const cap of [
    "entry_admin",
    "recruiter_master_manage",
    "team_master_manage",
    "report_view",
    "report_analytics_view",
  ]) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1, $2, '2025-01-01', true)",
      [ACTORS.fullAdmin.app, cap],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1, 'all', null, '2025-01-01', true)",
    [ACTORS.fullAdmin.app],
  );

  // Grant BoD capabilities + all scope
  for (const cap of ["report_view", "report_analytics_view"]) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1, $2, '2025-01-01', true)",
      [ACTORS.bodUser.app, cap],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1, 'all', null, '2025-01-01', true)",
    [ACTORS.bodUser.app],
  );

  // Seed Teams, Recruiters, Links, Team Memberships, and Team Leaders
  await db.query(
    "insert into public.teams (team_id, code, display_name, active) values ($1, 'TEAM_A', 'Team Alpha', true), ($2, 'TEAM_B', 'Team Beta', true)",
    [TEAM_ALPHA, TEAM_BETA],
  );

  for (const [actor, teamId] of [
    [ACTORS.leaderAlpha, TEAM_ALPHA],
    [ACTORS.leaderBeta, TEAM_BETA],
    [ACTORS.recruiterOfficial, TEAM_ALPHA],
    [ACTORS.recruiterMidMonth, TEAM_ALPHA],
    [ACTORS.probationUser, TEAM_ALPHA],
  ]) {
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name, personnel_code, active) values ($1, $2, $3, true)",
      [actor.recruiter, actor.name, actor.code],
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1, $2, true, '2025-01-01', true)",
      [actor.app, actor.recruiter],
    );
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1, $2, '2025-01-01', true)",
      [actor.recruiter, teamId],
    );
  }

  await db.query(
    "insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current) values ($1, $2, $3, '2025-01-01', true), ($4, $5, $6, '2025-01-01', true)",
    [
      TEAM_ALPHA,
      ACTORS.leaderAlpha.app,
      ACTORS.leaderAlpha.recruiter,
      TEAM_BETA,
      ACTORS.leaderBeta.app,
      ACTORS.leaderBeta.recruiter,
    ],
  );

  const { rows: preContextRows } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
    [ACTORS.recruiterOfficial.auth],
  );

  // Apply WP1 migration and verify non-regression before applying later migrations
  await db.exec(migrations[wp1Index].sql);

  // 1. Verify non-regression of direct_entry_resolve_actor_context and organization_departments
  const { rows: postContextRows } = await db.query(
    "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
    [ACTORS.recruiterOfficial.auth],
  );
  assert.deepEqual(
    postContextRows[0].ctx,
    preContextRows[0].ctx,
    "WP1 migration must not alter direct_entry_resolve_actor_context output",
  );

  // Apply any subsequent migrations in the chain
  for (const m of migrations.slice(wp1Index + 1)) {
    await db.exec(m.sql);
  }

  const { rows: sysDepts } = await db.query(
    "select system_key from public.organization_departments order by system_key",
  );
  assert.deepEqual(
    sysDepts.map((r) => r.system_key),
    ["ACCOUNTING", "RECRUITMENT"],
    "WP1 migration must not alter system organization_departments",
  );

  // Verify 13 public RPC signatures exist and are granted only to service_role
  for (const sig of LEAVE_MANAGEMENT_WP1_RPC_SIGNATURES) {
    const { rows } = await db.query(
      `select pg_catalog.has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as srv,
              pg_catalog.has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth,
              pg_catalog.has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon`,
      [sig],
    );
    assert.equal(rows[0].srv, true, `${sig} must be executable by service_role`);
    assert.equal(rows[0].auth, false, `${sig} must not be executable by authenticated`);
    assert.equal(rows[0].anon, false, `${sig} must not be executable by anon`);
  }
  {
    const { rows } = await db.query(
      `select pg_catalog.has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as srv,
              pg_catalog.has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth,
              pg_catalog.has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon`,
      [LEAVE_ADMIN_ACCOUNT_STATUS_FILTER_RPC_SIGNATURE],
    );
    assert.equal(rows[0].srv, true, "filtered leave admin overview is executable by service_role");
    assert.equal(rows[0].auth, false, "filtered leave admin overview is not executable by authenticated");
    assert.equal(rows[0].anon, false, "filtered leave admin overview is not executable by anon");
  }

  // Set business date to 2026-03-15 (Month 3)
  await setBusinessDate(db, "2026-03-15");

  // Helper to invoke RPC as service_role
  async function rpc(fnName, params) {
    const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
    await db.exec("set role service_role");
    try {
      const { rows } = await db.query(
        `select public.${fnName}(${placeholders}) as res`,
        params,
      );
      return rows[0]?.res;
    } finally {
      await db.exec("reset role");
    }
  }

  const activeAccounts = await rpc("leave_management_get_admin_overview", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    null,
    1,
    0,
    "ACTIVE",
  ]);
  const inactiveAccounts = await rpc("leave_management_get_admin_overview", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    null,
    100,
    0,
    "INACTIVE",
  ]);
  const allAccounts = await rpc("leave_management_get_admin_overview", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    null,
    100,
    0,
    "ALL",
  ]);
  assert.ok(activeAccounts.total_employees > 0);
  assert.equal(activeAccounts.employees.length, 1, "limit applies after the active-account filter");
  assert.equal(
    activeAccounts.total_employees + inactiveAccounts.total_employees,
    allAccounts.total_employees,
    "status-specific totals add up to the unfiltered total",
  );
  assert.deepEqual(
    inactiveAccounts.employees.map((row) => row.account.app_user_id),
    [ACTORS.inactiveAccount.app],
    "inactive filter returns the disabled account",
  );
  assert.equal(inactiveAccounts.employees[0].account.account_enabled, false);
  assert.equal(
    allAccounts.employees.some((row) => row.account.app_user_id === ACTORS.inactiveAccount.app),
    true,
    "ALL filter retains disabled accounts for history and administration",
  );

  // 2. Verify append-only immutability triggers on audit/revision tables
  await assert.rejects(
    db.query("delete from public.leave_policy_revisions"),
    (err) => err?.code === "P0001" && String(err?.message).includes("append-only"),
    "leave_policy_revisions must be append-only",
  );

  // 3. Unconfigured personal account can view summary (0 paid units) and submit unpaid request routed to Admin/BoD fallback
  const unconfSummary = await rpc("leave_management_get_my_summary", [
    ACTORS.unconfiguredUser.auth,
    ACTORS.unconfiguredUser.app,
    2026,
  ]);
  assert.equal(unconfSummary.balance.profile_configured, false);
  assert.equal(unconfSummary.balance.available_units, 0);
  assert.equal(unconfSummary.routing.route_kind, "ADMIN_BOD_FALLBACK");
  assert.equal(
    unconfSummary.routing.fallback_reason,
    "PROFILE_UNCONFIGURED_OR_UNMAPPED",
  );

  // Requesting ANNUAL leave with 0 available units must reject with LEAVE_INSUFFICIENT_BALANCE
  await assert.rejects(
    rpc("leave_management_create_request", [
      ACTORS.unconfiguredUser.auth,
      ACTORS.unconfiguredUser.app,
      JSON.stringify([{ leave_date: "2026-03-18", session_code: "FULL", leave_type: "ANNUAL" }]),
      "Xin nghỉ phép năm khi chưa có quỹ phép năm",
      nextIdem("unconf-annual-fail"),
      "fp-unconf-annual-fail",
    ]),
    (err) => String(err?.message).includes("LEAVE_INSUFFICIENT_BALANCE"),
    "Unconfigured account with 0 annual leave cannot submit ANNUAL leave",
  );

  const unconfReq = await rpc("leave_management_create_request", [
    ACTORS.unconfiguredUser.auth,
    ACTORS.unconfiguredUser.app,
    JSON.stringify([{ leave_date: "2026-03-18", session_code: "FULL", leave_type: "UNPAID" }]),
    "Xin nghỉ việc cá nhân không lương khi chưa cấu hình hồ sơ",
    nextIdem("unconf"),
    "fp-unconf-1",
  ]);
  assert.equal(unconfReq.request.pay_treatment, undefined);
  assert.deepEqual(unconfReq.request.leave_types, ["UNPAID"]);
  assert.equal(unconfReq.request.profile_configured_at_submit, false);
  assert.equal(unconfReq.request.route_kind, "ADMIN_BOD_FALLBACK");

  // 4. Full Admin grants HR_LEAVE_OPERATOR to hrOperator and marks sharedMarketing as shared non-employee
  await rpc("leave_management_manage_module_grant_admin", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    "GRANT",
    ACTORS.hrOperator.app,
    "HR_LEAVE_OPERATOR",
    0,
    "Cấp quyền vận hành hồ sơ phép cho HR",
    nextIdem("grant-hrop"),
    "fp-grant-hrop",
  ]);

  await rpc("leave_management_upsert_employee_profile_admin", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    ACTORS.sharedMarketing.app,
    true, // is_shared_non_employee
    "UNCONFIGURED",
    "MARKETING",
    null,
    null,
    null,
    0,
    0,
    "Đánh dấu tài khoản Marketing dùng chung",
    nextIdem("shared-mkt"),
    "fp-shared-mkt",
  ]);

  await assert.rejects(
    rpc("leave_management_get_my_summary", [
      ACTORS.sharedMarketing.auth,
      ACTORS.sharedMarketing.app,
      2026,
    ]),
    (err) => String(err?.message).includes("LEAVE_SHARED_ACCOUNT_FORBIDDEN"),
    "Shared non-employee account must be blocked from get_my_summary",
  );

  await assert.rejects(
    rpc("leave_management_create_request", [
      ACTORS.sharedMarketing.auth,
      ACTORS.sharedMarketing.app,
      JSON.stringify([{ leave_date: "2026-03-19", session_code: "AM" }]),
      "Thử tạo đơn từ tài khoản dùng chung",
      nextIdem("shared-req"),
      "fp-shared-req",
    ]),
    (err) => String(err?.message).includes("LEAVE_SHARED_ACCOUNT_FORBIDDEN"),
    "Shared non-employee account must be blocked from create_request",
  );

  // 5. Monthly accrual boundary at M=3 (2026-03-15) and mid-month hire date
  await rpc("leave_management_upsert_employee_profile_admin", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    ACTORS.recruiterOfficial.app,
    false,
    "OFFICIAL",
    "RECRUITMENT",
    "2025-01-01",
    "2025-03-01",
    null,
    0,
    0,
    "Cấu hình hồ sơ chính thức cho chuyên viên tuyển dụng",
    nextIdem("prof-rec1"),
    "fp-prof-rec1",
  ]);

  const recSummaryM3 = await rpc("leave_management_get_my_summary", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    2026,
  ]);
  assert.equal(
    recSummaryM3.balance.monthly_accrued_units,
    6,
    "At M=3 (March), monthly accrued units must be 6 half-day units (3.0 days), not 24 (12 days)",
  );
  assert.equal(recSummaryM3.balance.available_units, 6);
  assert.equal(recSummaryM3.routing.route_kind, "TEAM_LEADER");
  assert.equal(
    recSummaryM3.routing.primary_approver_app_user_id,
    ACTORS.leaderAlpha.app,
  );

  // Requesting 3.5 days (7 units) in March must fail closed with LEAVE_INSUFFICIENT_BALANCE
  await assert.rejects(
    rpc("leave_management_create_request", [
      ACTORS.recruiterOfficial.auth,
      ACTORS.recruiterOfficial.app,
      JSON.stringify([
        { leave_date: "2026-03-23", session_code: "FULL" },
        { leave_date: "2026-03-24", session_code: "FULL" },
        { leave_date: "2026-03-25", session_code: "FULL" },
        { leave_date: "2026-03-26", session_code: "AM" },
      ]),
      "Xin nghỉ 3.5 ngày vượt quá 3 ngày phép tháng 3",
      nextIdem("over-m3"),
      "fp-over-m3",
    ]),
    (err) => String(err?.message).includes("LEAVE_INSUFFICIENT_BALANCE"),
    "Cannot use future months' leave before accrued",
  );

  // Mid-month hire date: started 2026-03-20 as OFFICIAL -> at 2026-03-20 receives full 1 day (2 units) for March
  await setBusinessDate(db, "2026-03-20");
  const midMonthProf = await rpc("leave_management_upsert_employee_profile_admin", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    ACTORS.recruiterMidMonth.app,
    false,
    "OFFICIAL",
    "RECRUITMENT",
    "2026-03-20",
    "2026-03-20",
    null,
    0,
    0,
    "Nhân viên vào làm giữa tháng 20/03/2026",
    nextIdem("prof-mid"),
    "fp-prof-mid",
  ]);
  assert.equal(
    midMonthProf.balance.monthly_accrued_units,
    2,
    "Employee starting mid-month on 2026-03-20 still earns full 1 day (2 half-day units) for March",
  );
  assert.equal(midMonthProf.balance.available_units, 2);

  // 6. Probation unpaid leave & transition to Official catch-up accrual
  const probProf = await rpc("leave_management_upsert_employee_profile_admin", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    ACTORS.probationUser.app,
    false,
    "PROBATION",
    "RECRUITMENT",
    "2026-01-15",
    null,
    null,
    0,
    0,
    "Nhân viên thử việc từ 15/01/2026",
    nextIdem("prof-prob"),
    "fp-prof-prob",
  ]);
  assert.equal(probProf.balance.available_units, 0);

  const probReq = await rpc("leave_management_create_request", [
    ACTORS.probationUser.auth,
    ACTORS.probationUser.app,
    JSON.stringify([{ leave_date: "2026-02-10", session_code: "AM", leave_type: "UNPAID" }]),
    "Xin nghỉ nửa ngày không lương thời gian thử việc",
    nextIdem("prob-req"),
    "fp-prob-req",
  ]);
  assert.equal(probReq.request.pay_treatment, undefined);
  assert.deepEqual(probReq.request.leave_types, ["UNPAID"]);

  // Team Leader Alpha approves probation request -> 0 lots consumed
  const probApproved = await rpc("leave_management_decide_request", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    probReq.request.request_id,
    "APPROVE",
    probReq.request.row_version,
    "Duyệt nghỉ không lương",
    nextIdem("prob-app"),
    "fp-prob-app",
  ]);
  assert.equal(probApproved.request.status, "APPROVED");
  assert.equal(probApproved.requester_balance.consumed_units, 0);
  assert.equal(probApproved.requester_balance.approved_unpaid_units, 1);

  // Transition probationUser to OFFICIAL effective 2026-03-15 (while business date is 2026-03-20)
  const officialTransition = await rpc(
    "leave_management_upsert_employee_profile_admin",
    [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      ACTORS.probationUser.app,
      false,
      "OFFICIAL",
      "RECRUITMENT",
      "2026-01-15",
      "2026-03-15",
      null,
      0,
      probProf.profile.row_version,
      "Chuyển chính thức từ 15/03/2026",
      nextIdem("prof-prob-off"),
      "fp-prof-prob-off",
    ],
  );
  assert.equal(
    officialTransition.balance.monthly_accrued_units,
    6,
    "Transition to OFFICIAL in March backfills Jan + Feb (PROBATION_CATCHUP) + Mar (MONTHLY_ACCRUAL) = 6 units",
  );
  assert.equal(officialTransition.balance.available_units, 6);
  const catchupLots = officialTransition.balance.lots.filter(
    (l) => l.lot_kind === "PROBATION_CATCHUP",
  );
  assert.equal(catchupLots.length, 2, "Jan and Feb lots are PROBATION_CATCHUP");
  assert.ok(
    catchupLots.every((l) => l.usable_from_date === "2026-03-15"),
    "Catch-up lots are only usable from official_effective_date (2026-03-15)",
  );

  // Calling get_my_summary again must not duplicate catch-up lots
  const probAfterRetry = await rpc("leave_management_get_my_summary", [
    ACTORS.probationUser.auth,
    ACTORS.probationUser.app,
    2026,
  ]);
  assert.equal(probAfterRetry.balance.monthly_accrued_units, 6);

  // 7. Seniority configuration authority & effective date unlocking
  // HR Operator cannot configure seniority fields -> LEAVE_SENIORITY_CONFIG_FORBIDDEN
  await assert.rejects(
    rpc("leave_management_upsert_employee_profile_admin", [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      ACTORS.recruiterOfficial.app,
      false,
      "OFFICIAL",
      "RECRUITMENT",
      "2025-01-01",
      "2025-03-01",
      "2026-03-25",
      2,
      1,
      "HR tự thử cấu hình thâm niên",
      nextIdem("hr-sen-forbid"),
      "fp-hr-sen-forbid",
    ]),
    (err) => String(err?.message).includes("LEAVE_SENIORITY_CONFIG_FORBIDDEN"),
    "Only Admin/BoD may configure next_seniority_effective_date / next_seniority_units",
  );

  // BoD configures next_seniority_effective_date = 2026-03-25, next_seniority_units = 2 for recruiterOfficial
  const bodSenBeforeDate = await rpc(
    "leave_management_upsert_employee_profile_admin",
    [
      ACTORS.bodUser.auth,
      ACTORS.bodUser.app,
      ACTORS.recruiterOfficial.app,
      false,
      "OFFICIAL",
      "RECRUITMENT",
      "2025-01-01",
      "2025-03-01",
      "2026-03-25",
      2,
      1,
      "BoD cấu hình ngày tăng phép thâm niên 25/03/2026 (+1 ngày)",
      nextIdem("bod-sen"),
      "fp-bod-sen",
    ],
  );
  assert.equal(
    bodSenBeforeDate.balance.seniority_granted_units,
    0,
    "Before 2026-03-25, seniority units are not yet unlocked",
  );

  await setBusinessDate(db, "2026-03-25");
  const recOnSenDate = await rpc("leave_management_get_my_summary", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    2026,
  ]);
  assert.equal(
    recOnSenDate.balance.seniority_granted_units,
    2,
    "On 2026-03-25, seniority grant (+2 half-day units) unlocks automatically",
  );
  assert.equal(recOnSenDate.balance.available_units, 8); // 6 monthly + 2 seniority

  // 8. Carry-over unconfigured guard, policy update, FIFO consumption, and X+1 expiration
  await setBusinessDate(db, "2026-03-20");

  // Preview opening batch with carry_over_units > 0 while carry_over_expiry is NULL -> invalid with LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED
  const previewBeforePolicy = await rpc(
    "leave_management_preview_opening_batch",
    [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      2026,
      JSON.stringify([
        {
          app_user_id: ACTORS.recruiterOfficial.app,
          carry_over_units: 4,
          opening_current_year_units: 0,
          seniority_units: 0,
          note: "Phép tồn 2025 chuyển sang",
        },
      ]),
    ],
  );
  assert.equal(previewBeforePolicy.valid, false);
  assert.equal(previewBeforePolicy.has_carry_over_expiry_error, true);

  await assert.rejects(
    rpc("leave_management_apply_opening_batch", [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      2026,
      JSON.stringify([
        {
          app_user_id: ACTORS.recruiterOfficial.app,
          carry_over_units: 4,
          opening_current_year_units: 0,
          seniority_units: 0,
        },
      ]),
      "Thử áp dụng phép năm cũ khi chưa đặt hạn dùng",
      nextIdem("apply-no-exp"),
      "fp-apply-no-exp",
    ]),
    (err) =>
      String(err?.message).includes("LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED"),
    "Applying CARRY_OVER before configuring expiry date must fail closed",
  );

  // Full Admin configures carry-over expiry date to 31/03 (month=3, day=31)
  const policyUpdated = await rpc("leave_management_update_policy_admin", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    3,
    31,
    1,
    "Chốt hạn dùng phép chuyển năm là 31/03",
    nextIdem("pol-3103"),
    "fp-pol-3103",
  ]);
  assert.equal(
    policyUpdated.policy.carry_over_expires_after_date,
    "2026-03-31",
  );

  // Preview and apply opening batch must reject UNCONFIGURED and PROBATION employees with EMPLOYEE_NOT_OFFICIAL
  const leaderAlphaProbation = await rpc(
    "leave_management_upsert_employee_profile_admin",
    [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      ACTORS.leaderAlpha.app,
      false,
      "PROBATION",
      "RECRUITMENT",
      "2026-02-01",
      null,
      null,
      0,
      0,
      "Cấu hình tạm trạng thái thử việc cho Trưởng nhóm Alpha để kiểm tra chặn khởi tạo phép đầu kỳ",
      nextIdem("prof-tl-prob"),
      "fp-prof-tl-prob",
    ],
  );
  assert.equal(leaderAlphaProbation.profile.employment_status, "PROBATION");

  const previewNonOfficial = await rpc(
    "leave_management_preview_opening_batch",
    [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      2026,
      JSON.stringify([
        {
          app_user_id: ACTORS.unconfiguredUser.app,
          carry_over_units: 0,
          opening_current_year_units: 2,
          seniority_units: 0,
          note: "Nhân sự chưa cấu hình hồ sơ",
        },
        {
          app_user_id: ACTORS.leaderAlpha.app,
          carry_over_units: 0,
          opening_current_year_units: 2,
          seniority_units: 0,
          note: "Nhân sự đang thử việc",
        },
      ]),
    ],
  );
  assert.equal(previewNonOfficial.valid, false);
  assert.equal(previewNonOfficial.error_row_count, 2);
  assert.deepEqual(previewNonOfficial.rows[0].errors, ["EMPLOYEE_NOT_OFFICIAL"]);
  assert.deepEqual(previewNonOfficial.rows[1].errors, ["EMPLOYEE_NOT_OFFICIAL"]);

  await assert.rejects(
    rpc("leave_management_apply_opening_batch", [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      2026,
      JSON.stringify([
        {
          app_user_id: ACTORS.leaderAlpha.app,
          carry_over_units: 0,
          opening_current_year_units: 2,
          seniority_units: 0,
          note: "Thử áp dụng trực tiếp cho nhân sự thử việc",
        },
      ]),
      "Thử áp dụng số dư đầu kỳ cho nhân sự thử việc",
      nextIdem("apply-probation-fail"),
      "fp-apply-probation-fail",
    ]),
    (err) =>
      String(err?.message).includes("LEAVE_OPENING_BATCH_VALIDATION_FAILED"),
    "Applying opening balance to a PROBATION employee must fail closed at the RPC boundary",
  );

  await assert.rejects(
    rpc("leave_management_apply_opening_batch", [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      2026,
      JSON.stringify([
        {
          app_user_id: ACTORS.unconfiguredUser.app,
          carry_over_units: 0,
          opening_current_year_units: 2,
          seniority_units: 0,
          note: "Thử áp dụng trực tiếp cho nhân sự chưa cấu hình",
        },
      ]),
      "Thử áp dụng số dư đầu kỳ cho nhân sự chưa cấu hình",
      nextIdem("apply-unconf-fail"),
      "fp-apply-unconf-fail",
    ]),
    (err) =>
      String(err?.message).includes("LEAVE_OPENING_BATCH_VALIDATION_FAILED"),
    "Applying opening balance to an UNCONFIGURED employee must fail closed at the RPC boundary",
  );

  // Transition leaderAlpha to OFFICIAL so opening batch can be applied
  await rpc("leave_management_upsert_employee_profile_admin", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    ACTORS.leaderAlpha.app,
    false,
    "OFFICIAL",
    "RECRUITMENT",
    "2024-01-01",
    "2024-03-01",
    null,
    0,
    leaderAlphaProbation.profile.row_version,
    "Cấu hình hồ sơ chính thức cho Trưởng nhóm Alpha",
    nextIdem("prof-tl-off"),
    "fp-prof-tl-off",
  ]);

  // Now apply opening batch (bulk of 2 rows: recruiterOfficial gets 4 carry_over_units + confirms 6 target current-year units, leaderAlpha reconciles current-year target to 2 units)
  const batchApplied = await rpc("leave_management_apply_opening_batch", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    2026,
    JSON.stringify([
      {
        app_user_id: ACTORS.recruiterOfficial.app,
        carry_over_units: 4,
        opening_current_year_units: 6,
        seniority_units: 0,
        note: "Phép chuyển năm 2 ngày và chốt số dư năm nay 3 ngày",
      },
      {
        app_user_id: ACTORS.leaderAlpha.app,
        carry_over_units: 0,
        opening_current_year_units: 2,
        seniority_units: 0,
        note: "Số dư mục tiêu đầu kỳ 1 ngày sau đối soát",
      },
    ]),
    "Áp dụng lô số dư đầu kỳ 2026",
    nextIdem("apply-batch-1"),
    "fp-apply-batch-1",
  ]);
  assert.equal(batchApplied.batch.batch_kind, "BULK");
  assert.equal(batchApplied.batch.row_count, 2);
  assert.equal(batchApplied.applied_row_count, 2);
  assert.equal(batchApplied.batch_id, batchApplied.batch.batch_id);
  assert.equal(batchApplied.batch.total_carry_over_units, 4);

  const leaderAlphaAfterReconcile = await rpc("leave_management_get_my_summary", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    2026,
  ]);
  assert.equal(
    leaderAlphaAfterReconcile.balance.monthly_accrued_units,
    6,
    "leaderAlpha retains 6 units of original monthly accrual history",
  );
  assert.equal(
    leaderAlphaAfterReconcile.balance.opening_or_adjustment_units,
    -4,
    "leaderAlpha opening reconciliation adjustment is -4 units (from 6 accrued to target 2)",
  );
  assert.equal(
    leaderAlphaAfterReconcile.balance.available_units,
    2,
    "leaderAlpha post-reconciliation available current-year balance matches target 2 units (1 day)",
  );

  // At 2026-03-20, recruiterOfficial has: 4 carry-over + 6 monthly + 2 seniority = 12 available units
  // Submit a request for 2.5 days (5 units): 2026-03-19 (FULL, past/current -> CONSUME), 2026-03-26 (FULL, future -> RESERVE), 2026-03-27 (AM, future -> RESERVE)
  const fifoReq = await rpc("leave_management_create_request", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    JSON.stringify([
      { leave_date: "2026-03-19", session_code: "FULL" },
      { leave_date: "2026-03-26", session_code: "FULL" },
      { leave_date: "2026-03-27", session_code: "AM" },
    ]),
    "Nghỉ 2.5 ngày kiểm tra FIFO và RESERVE/CONSUME",
    nextIdem("fifo-req"),
    "fp-fifo-req",
  ]);
  assert.equal(fifoReq.request.requested_units, 5);
  assert.equal(
    fifoReq.balance.reserved_units,
    0,
    "PENDING request must not reserve units before approval",
  );
  assert.equal(fifoReq.balance.pending_annual_units, 5);

  // Team Leader Beta (wrong team) cannot approve Team Alpha request
  await assert.rejects(
    rpc("leave_management_decide_request", [
      ACTORS.leaderBeta.auth,
      ACTORS.leaderBeta.app,
      fifoReq.request.request_id,
      "APPROVE",
      fifoReq.request.row_version,
      "Duyệt nhầm nhóm",
      nextIdem("wrong-tl"),
      "fp-wrong-tl",
    ]),
    (err) => String(err?.message).includes("LEAVE_APPROVAL_FORBIDDEN"),
    "Team Leader of another team must be rejected",
  );

  // Team Leader Alpha approves fifoReq
  const fifoApproved = await rpc("leave_management_decide_request", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    fifoReq.request.request_id,
    "APPROVE",
    fifoReq.request.row_version,
    "Đồng ý duyệt 2.5 ngày phép",
    nextIdem("tl-approve-fifo"),
    "fp-tl-approve-fifo",
  ]);
  assert.equal(fifoApproved.request.status, "APPROVED");
  assert.equal(
    fifoApproved.requester_balance.consumed_units,
    2,
    "2026-03-19 (<= 2026-03-20) is immediately CONSUMED (2 units)",
  );
  assert.equal(
    fifoApproved.requester_balance.reserved_units,
    3,
    "2026-03-26 (FULL=2) and 2026-03-27 (AM=1) (> 2026-03-20) are RESERVED (3 units)",
  );
  assert.equal(
    fifoApproved.requester_balance.carry_over_available_units,
    0,
    "FIFO must allocate all 4 CARRY_OVER units first before touching MONTHLY_ACCRUAL",
  );
  const allocByKind = fifoApproved.request.allocations.map((a) => ({
    date: a.leave_date,
    kind: a.lot_kind,
    units: a.allocated_units,
    status: a.status,
  }));
  assert.deepEqual(allocByKind, [
    { date: "2026-03-19", kind: "CARRY_OVER", units: 2, status: "CONSUMED" },
    { date: "2026-03-26", kind: "CARRY_OVER", units: 2, status: "RESERVED" },
    { date: "2026-03-27", kind: "MONTHLY_ACCRUAL", units: 1, status: "RESERVED" },
  ]);

  // 9. Half-day session overlap check on 2026-03-27 (AM is already active, so PM is allowed, but AM or FULL is rejected!)
  await assert.rejects(
    rpc("leave_management_create_request", [
      ACTORS.recruiterOfficial.auth,
      ACTORS.recruiterOfficial.app,
      JSON.stringify([{ leave_date: "2026-03-27", session_code: "AM" }]),
      "Trùng buổi sáng 27/03",
      nextIdem("overlap-am"),
      "fp-overlap-am",
    ]),
    (err) => String(err?.message).includes("LEAVE_REQUEST_OVERLAP"),
    "AM + AM on the same date must be rejected",
  );

  await assert.rejects(
    rpc("leave_management_create_request", [
      ACTORS.recruiterOfficial.auth,
      ACTORS.recruiterOfficial.app,
      JSON.stringify([{ leave_date: "2026-03-27", session_code: "FULL" }]),
      "Trùng cả ngày 27/03",
      nextIdem("overlap-full"),
      "fp-overlap-full",
    ]),
    (err) => String(err?.message).includes("LEAVE_REQUEST_OVERLAP"),
    "FULL overlapping existing AM on the same date must be rejected",
  );

  // Requesting PM on 2026-03-27 succeeds!
  const pmReq = await rpc("leave_management_create_request", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    JSON.stringify([{ leave_date: "2026-03-27", session_code: "PM" }]),
    "Xin nghỉ thêm buổi chiều 27/03",
    nextIdem("pm-2703"),
    "fp-pm-2703",
  ]);
  assert.equal(pmReq.request.status, "PENDING");
  assert.equal(pmReq.request.requested_units, 1);

  // Requester withdraws PENDING pmReq -> status becomes WITHDRAWN, freeing 2026-03-27 PM
  const pmWithdrawn = await rpc("leave_management_withdraw_request", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    pmReq.request.request_id,
    pmReq.request.row_version,
    "Tự rút đơn buổi chiều 27/03",
    nextIdem("withdraw-pm"),
    "fp-withdraw-pm",
  ]);
  assert.equal(pmWithdrawn.request.status, "WITHDRAWN");

  // Requester CANNOT withdraw already-APPROVED fifoReq
  await assert.rejects(
    rpc("leave_management_withdraw_request", [
      ACTORS.recruiterOfficial.auth,
      ACTORS.recruiterOfficial.app,
      fifoReq.request.request_id,
      fifoApproved.request.row_version,
      "Thử tự rút đơn đã duyệt",
      nextIdem("withdraw-approved-fail"),
      "fp-withdraw-approved-fail",
    ]),
    (err) => String(err?.message).includes("LEAVE_INVALID_STATE_TRANSITION"),
    "Requester cannot self-withdraw an APPROVED request",
  );

  // 10. Advance business date to 2026-03-31 (day X): RESERVED allocations for 26 & 27 March settle to CONSUMED
  await setBusinessDate(db, "2026-03-31");
  const summaryOnX = await rpc("leave_management_get_my_summary", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    2026,
  ]);
  assert.equal(
    summaryOnX.balance.reserved_units,
    0,
    "By 2026-03-31, reserved allocations for 2026-03-26..27 are settled into CONSUMED",
  );
  assert.equal(summaryOnX.balance.consumed_units, 5);

  // Advance business date to 2026-04-01 (day X + 1, Month 4)
  await setBusinessDate(db, "2026-04-01");

  // Now Team Leader Alpha cancels the APPROVED fifoReq on 2026-04-01 (after carry-over expiry 2026-03-31!)
  // The 4 units returned to CARRY_OVER lot must immediately expire (expired_units = 4), while the 1 unit returned to MONTHLY_ACCRUAL becomes available again!
  const cancelledAfterX = await rpc("leave_management_decide_request", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    fifoReq.request.request_id,
    "CANCEL_APPROVED",
    fifoApproved.request.row_version,
    "Hủy đơn đã duyệt do nhân sự đi làm lại",
    nextIdem("cancel-after-x"),
    "fp-cancel-after-x",
  ]);
  assert.equal(cancelledAfterX.request.status, "CANCELLED");
  assert.equal(cancelledAfterX.requester_balance.consumed_units, 0);
  assert.equal(
    cancelledAfterX.requester_balance.expired_units,
    4,
    "4 units returned to CARRY_OVER lot after 2026-03-31 must expire immediately so expired carry-over cannot be reused",
  );
  // At 2026-04-01 (M=4), monthly_accrued_units = 8 (4 months * 2) + 2 seniority = 10 available units
  assert.equal(cancelledAfterX.requester_balance.monthly_accrued_units, 8);
  assert.equal(cancelledAfterX.requester_balance.available_units, 10);

  // 11. Marketing Department Head routing & self-approval prohibition
  await rpc("leave_management_upsert_employee_profile_admin", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    ACTORS.marketingHead.app,
    false,
    "OFFICIAL",
    "MARKETING",
    "2024-01-01",
    "2024-03-01",
    null,
    0,
    0,
    "Cấu hình hồ sơ Trưởng phòng Marketing",
    nextIdem("prof-mkt-head"),
    "fp-prof-mkt-head",
  ]);
  await rpc("leave_management_upsert_employee_profile_admin", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    ACTORS.marketingStaff.app,
    false,
    "OFFICIAL",
    "MARKETING",
    "2025-06-01",
    "2025-08-01",
    null,
    0,
    0,
    "Cấu hình hồ sơ Nhân viên Marketing",
    nextIdem("prof-mkt-staff"),
    "fp-mkt-staff",
  ]);

  // Before configuring Marketing department approver, marketingStaff routes to ADMIN_BOD_FALLBACK
  const mktBeforeHead = await rpc("leave_management_get_my_summary", [
    ACTORS.marketingStaff.auth,
    ACTORS.marketingStaff.app,
    2026,
  ]);
  assert.equal(mktBeforeHead.routing.route_kind, "ADMIN_BOD_FALLBACK");
  assert.equal(
    mktBeforeHead.routing.fallback_reason,
    "DEPARTMENT_APPROVER_NOT_CONFIGURED",
  );

  // Admin configures marketingHead as DEPARTMENT_HEAD for MARKETING
  await rpc("leave_management_set_department_approver_admin", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    "MARKETING",
    ACTORS.marketingHead.app,
    null,
    0,
    "Bổ nhiệm Trưởng phòng duyệt phép khối Marketing",
    nextIdem("set-mkt-head"),
    "fp-set-mkt-head",
  ]);

  const mktAfterHead = await rpc("leave_management_get_my_summary", [
    ACTORS.marketingStaff.auth,
    ACTORS.marketingStaff.app,
    2026,
  ]);
  assert.equal(mktAfterHead.routing.route_kind, "DEPARTMENT_HEAD");
  assert.equal(
    mktAfterHead.routing.primary_approver_app_user_id,
    ACTORS.marketingHead.app,
  );

  // Marketing Head's own request routes to ADMIN_BOD_DIRECT and cannot be self-approved
  const headOwnReq = await rpc("leave_management_create_request", [
    ACTORS.marketingHead.auth,
    ACTORS.marketingHead.app,
    JSON.stringify([{ leave_date: "2026-04-10", session_code: "FULL" }]),
    "Trưởng phòng Marketing xin nghỉ 1 ngày",
    nextIdem("head-own-req"),
    "fp-head-own-req",
  ]);
  assert.equal(headOwnReq.request.route_kind, "ADMIN_BOD_DIRECT");

  await assert.rejects(
    rpc("leave_management_decide_request", [
      ACTORS.marketingHead.auth,
      ACTORS.marketingHead.app,
      headOwnReq.request.request_id,
      "APPROVE",
      headOwnReq.request.row_version,
      "Tự duyệt đơn của mình",
      nextIdem("self-approve-fail"),
      "fp-self-approve-fail",
    ]),
    (err) => String(err?.message).includes("LEAVE_SELF_APPROVAL_FORBIDDEN"),
    "Approver must never self-approve their own leave request",
  );

  // BoD approves Marketing Head's request
  const headApprovedByBod = await rpc("leave_management_decide_request", [
    ACTORS.bodUser.auth,
    ACTORS.bodUser.app,
    headOwnReq.request.request_id,
    "APPROVE",
    headOwnReq.request.row_version,
    "BoD duyệt đơn Trưởng phòng Marketing",
    nextIdem("bod-approve-head"),
    "fp-bod-approve-head",
  ]);
  assert.equal(headApprovedByBod.request.status, "APPROVED");

  // 12. HR Monthly Report narrow authority grant & revoke + M=12 check
  await assert.rejects(
    rpc("leave_management_monthly_report", [
      ACTORS.hrViewer.auth,
      ACTORS.hrViewer.app,
      "2026-04",
      "ALL",
      null,
      100,
      0,
    ]),
    (err) => String(err?.message).includes("LEAVE_REPORT_FORBIDDEN"),
    "Account without HR_REPORT_VIEWER grant cannot read monthly leave report",
  );

  const hrViewerGrant = await rpc("leave_management_manage_module_grant_admin", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    "GRANT",
    ACTORS.hrViewer.app,
    "HR_REPORT_VIEWER",
    0,
    "Cấp quyền xem báo cáo phép tháng cho HR Viewer",
    nextIdem("grant-hr-viewer"),
    "fp-grant-hr-viewer",
  ]);
  assert.equal(hrViewerGrant.grant.is_current, true);

  const aprilReport = await rpc("leave_management_monthly_report", [
    ACTORS.hrViewer.auth,
    ACTORS.hrViewer.app,
    "2026-04",
    "ALL",
    null,
    100,
    0,
  ]);
  assert.equal(aprilReport.year_month, "2026-04");
  assert.ok(
    !aprilReport.rows.some((r) => r.app_user_id === ACTORS.sharedMarketing.app),
    "Shared non-employee Marketing account is excluded from monthly report",
  );
  const mktHeadRow = aprilReport.rows.find(
    (r) => r.app_user_id === ACTORS.marketingHead.app,
  );
  assert.equal(mktHeadRow.month_annual_leave_units, 2);

  // HR_REPORT_VIEWER still cannot access admin overview or approve requests
  await assert.rejects(
    rpc("leave_management_get_admin_overview", [
      ACTORS.hrViewer.auth,
      ACTORS.hrViewer.app,
      null,
      50,
      0,
    ]),
    (err) => String(err?.message).includes("LEAVE_ADMIN_FORBIDDEN"),
    "HR_REPORT_VIEWER must not gain admin config authority",
  );

  // Revoke HR_REPORT_VIEWER -> immediately loses report access
  await rpc("leave_management_manage_module_grant_admin", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    "REVOKE",
    ACTORS.hrViewer.app,
    "HR_REPORT_VIEWER",
    hrViewerGrant.grant.row_version,
    "Thu hồi quyền xem báo cáo phép tháng",
    nextIdem("revoke-hr-viewer"),
    "fp-revoke-hr-viewer",
  ]);

  await assert.rejects(
    rpc("leave_management_monthly_report", [
      ACTORS.hrViewer.auth,
      ACTORS.hrViewer.app,
      "2026-04",
      "ALL",
      null,
      100,
      0,
    ]),
    (err) => String(err?.message).includes("LEAVE_REPORT_FORBIDDEN"),
    "Revoked HR_REPORT_VIEWER immediately loses monthly report access",
  );

  // Finally advance to 2026-12-10 (M=12) and verify full 12 days (24 monthly units) accrued
  await setBusinessDate(db, "2026-12-10");
  const decSummary = await rpc("leave_management_get_my_summary", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    2026,
  ]);
  assert.equal(
    decSummary.balance.monthly_accrued_units,
    24,
    "At M=12 (December), full 12 days (24 half-day units) of monthly accrual are unlocked",
  );

  // 13. Department Approver handover rejects future valid_from and transitions immediately on handover date (zero routing gap)
  const currentMktApproverRows = await db.query(
    "select row_version from public.leave_department_approvers where unit_kind = 'MARKETING' and is_current = true",
  );
  const currentMktRowVersion = currentMktApproverRows.rows[0].row_version;

  // On 2026-12-10, attempting to schedule hrViewer as the new MARKETING approver effective 2026-12-20 or backdate to 2026-12-01 is rejected under WP1
  await assert.rejects(
    () =>
      rpc("leave_management_set_department_approver_admin", [
        ACTORS.fullAdmin.auth,
        ACTORS.fullAdmin.app,
        "MARKETING",
        ACTORS.hrViewer.app,
        "2026-12-20",
        currentMktRowVersion,
        "Lên lịch bàn giao người duyệt Marketing từ ngày 20/12/2026",
        nextIdem("sched-mkt-head-reject"),
        "fp-sched-mkt-head-reject",
      ]),
    (err) =>
      err.code === "22023" &&
      String(err.message).includes("LEAVE_DEPARTMENT_APPROVER_FUTURE_DATE_FORBIDDEN"),
  );
  await assert.rejects(
    () =>
      rpc("leave_management_set_department_approver_admin", [
        ACTORS.fullAdmin.auth,
        ACTORS.fullAdmin.app,
        "MARKETING",
        ACTORS.hrViewer.app,
        "2026-12-01",
        currentMktRowVersion,
        "Gán lùi ngày người duyệt Marketing về 01/12/2026",
        nextIdem("past-mkt-head-reject"),
        "fp-past-mkt-head-reject",
      ]),
    (err) =>
      err.code === "22023" &&
      String(err.message).includes("LEAVE_DEPARTMENT_APPROVER_PAST_DATE_FORBIDDEN"),
  );

  // On 2026-12-15 (before 2026-12-20 handover), marketingHead remains active approver
  await setBusinessDate(db, "2026-12-15");
  const mktDuringHandoverWait = await rpc("leave_management_get_my_summary", [
    ACTORS.marketingStaff.auth,
    ACTORS.marketingStaff.app,
    2026,
  ]);
  assert.equal(
    mktDuringHandoverWait.routing.route_kind,
    "DEPARTMENT_HEAD",
    "Previous Marketing approver remains active before handover",
  );
  assert.equal(
    mktDuringHandoverWait.routing.primary_approver_app_user_id,
    ACTORS.marketingHead.app,
    "Previous Marketing approver remains active until handover is executed",
  );

  const oldHeadSummaryBeforeHandover = await rpc("leave_management_get_my_summary", [
    ACTORS.marketingHead.auth,
    ACTORS.marketingHead.app,
    2026,
  ]);
  assert.equal(oldHeadSummaryBeforeHandover.authority.is_department_approver, true);

  // On 2026-12-20 (handover effective date), execute immediate handover to hrViewer
  await setBusinessDate(db, "2026-12-20");
  await rpc("leave_management_set_department_approver_admin", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    "MARKETING",
    ACTORS.hrViewer.app,
    "2026-12-20",
    currentMktRowVersion,
    "Bàn giao tức thời người duyệt Marketing ngày 20/12/2026",
    nextIdem("sched-mkt-head"),
    "fp-sched-mkt-head",
  ]);
  const mktOnHandoverDate = await rpc("leave_management_get_my_summary", [
    ACTORS.marketingStaff.auth,
    ACTORS.marketingStaff.app,
    2026,
  ]);
  assert.equal(mktOnHandoverDate.routing.route_kind, "DEPARTMENT_HEAD");
  assert.equal(
    mktOnHandoverDate.routing.primary_approver_app_user_id,
    ACTORS.hrViewer.app,
    "New Marketing approver takes over immediately on 2026-12-20",
  );

  const oldHeadSummaryOnHandover = await rpc("leave_management_get_my_summary", [
    ACTORS.marketingHead.auth,
    ACTORS.marketingHead.app,
    2026,
  ]);
  assert.equal(oldHeadSummaryOnHandover.authority.is_department_approver, false);

  // 14. One-time seniority configuration must NOT repeat in subsequent years (2027, 2028)
  // recruiterOfficial had next_seniority_effective_date = '2026-03-25', next_seniority_units = 2
  await setBusinessDate(db, "2027-03-15");
  const recOfficial2027 = await rpc("leave_management_get_my_summary", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    2027,
  ]);
  assert.equal(
    recOfficial2027.balance.seniority_granted_units,
    0,
    "One-time next_seniority_effective_date (2026-03-25) must not be re-granted in 2027",
  );
  assert.equal(recOfficial2027.balance.monthly_accrued_units, 6);

  await setBusinessDate(db, "2028-03-15");
  const recOfficial2028 = await rpc("leave_management_get_my_summary", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    2028,
  ]);
  assert.equal(
    recOfficial2028.balance.seniority_granted_units,
    0,
    "One-time next_seniority_effective_date (2026-03-25) must not be re-granted in 2028",
  );

  const { rows: recOfficialSenLots } = await db.query(
    `select count(*)::int as lot_count, coalesce(sum(granted_units), 0)::int as total_units
       from public.leave_lots
      where app_user_id = $1 and lot_kind = 'SENIORITY_GRANT'`,
    [ACTORS.recruiterOfficial.app],
  );
  assert.deepEqual(
    recOfficialSenLots[0],
    { lot_count: 1, total_units: 2 },
    "Configured next seniority grant must only ever create 1 lot across 2026..2028",
  );

  // 15. Scoped monthly report sync: filtering by MARKETING in 2028-03 only syncs MARKETING rows, not untouched RECRUITMENT accounts
  const { rows: preReportRecLots2028 } = await db.query(
    `select count(*)::int as cnt from public.leave_lots where app_user_id = $1 and leave_year = 2028`,
    [ACTORS.recruiterMidMonth.app],
  );
  assert.equal(preReportRecLots2028[0].cnt, 0);

  const mktReport2028 = await rpc("leave_management_monthly_report", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    "2028-03",
    "MARKETING",
    null,
    50,
    0,
  ]);
  assert.equal(mktReport2028.rows.length, 2);

  const { rows: postReportRecLots2028 } = await db.query(
    `select count(*)::int as cnt from public.leave_lots where app_user_id = $1 and leave_year = 2028`,
    [ACTORS.recruiterMidMonth.app],
  );
  assert.equal(
    postReportRecLots2028[0].cnt,
    0,
    "Monthly report filtered to MARKETING must not lock or materialize lots for RECRUITMENT accounts outside the page",
  );

  // 16. Explicit leave types & per-request duration limits:
  // BEREAVEMENT & MARRIAGE max 3 days (6 half-day units); SICK & UNPAID max 7 days (14 half-day units)
  await setBusinessDate(db, "2028-03-15");

  await assert.rejects(
    rpc("leave_management_create_request", [
      ACTORS.recruiterOfficial.auth,
      ACTORS.recruiterOfficial.app,
      JSON.stringify([
        { leave_date: "2028-03-01", session_code: "FULL", leave_type: "BEREAVEMENT" },
        { leave_date: "2028-03-02", session_code: "FULL", leave_type: "BEREAVEMENT" },
        { leave_date: "2028-03-03", session_code: "FULL", leave_type: "BEREAVEMENT" },
        { leave_date: "2028-03-04", session_code: "AM", leave_type: "BEREAVEMENT" },
      ]),
      "Nghỉ tang 3.5 ngày vượt trần 3 ngày",
      nextIdem("bereavement-over"),
      "fp-bereavement-over",
    ]),
    (err) => String(err?.message).includes("LEAVE_TYPE_LIMIT_EXCEEDED"),
    "BEREAVEMENT > 3 days (6 half-day units) per request must be rejected",
  );

  await assert.rejects(
    rpc("leave_management_create_request", [
      ACTORS.recruiterOfficial.auth,
      ACTORS.recruiterOfficial.app,
      JSON.stringify([
        { leave_date: "2028-03-01", session_code: "FULL", leave_type: "MARRIAGE" },
        { leave_date: "2028-03-02", session_code: "FULL", leave_type: "MARRIAGE" },
        { leave_date: "2028-03-03", session_code: "FULL", leave_type: "MARRIAGE" },
        { leave_date: "2028-03-04", session_code: "PM", leave_type: "MARRIAGE" },
      ]),
      "Nghỉ cưới 3.5 ngày vượt trần 3 ngày",
      nextIdem("marriage-over"),
      "fp-marriage-over",
    ]),
    (err) => String(err?.message).includes("LEAVE_TYPE_LIMIT_EXCEEDED"),
    "MARRIAGE > 3 days (6 half-day units) per request must be rejected",
  );

  await assert.rejects(
    rpc("leave_management_create_request", [
      ACTORS.recruiterOfficial.auth,
      ACTORS.recruiterOfficial.app,
      JSON.stringify([
        { leave_date: "2028-03-01", session_code: "FULL", leave_type: "SICK" },
        { leave_date: "2028-03-02", session_code: "FULL", leave_type: "SICK" },
        { leave_date: "2028-03-03", session_code: "FULL", leave_type: "SICK" },
        { leave_date: "2028-03-04", session_code: "FULL", leave_type: "SICK" },
        { leave_date: "2028-03-05", session_code: "FULL", leave_type: "SICK" },
        { leave_date: "2028-03-06", session_code: "FULL", leave_type: "SICK" },
        { leave_date: "2028-03-07", session_code: "FULL", leave_type: "SICK" },
        { leave_date: "2028-03-08", session_code: "AM", leave_type: "SICK" },
      ]),
      "Nghỉ ốm 7.5 ngày vượt trần 7 ngày",
      nextIdem("sick-over"),
      "fp-sick-over",
    ]),
    (err) => String(err?.message).includes("LEAVE_TYPE_LIMIT_EXCEEDED"),
    "SICK > 7 days (14 half-day units) per request must be rejected",
  );

  await assert.rejects(
    rpc("leave_management_create_request", [
      ACTORS.recruiterOfficial.auth,
      ACTORS.recruiterOfficial.app,
      JSON.stringify([
        { leave_date: "2028-03-01", session_code: "FULL", leave_type: "UNPAID" },
        { leave_date: "2028-03-02", session_code: "FULL", leave_type: "UNPAID" },
        { leave_date: "2028-03-03", session_code: "FULL", leave_type: "UNPAID" },
        { leave_date: "2028-03-04", session_code: "FULL", leave_type: "UNPAID" },
        { leave_date: "2028-03-05", session_code: "FULL", leave_type: "UNPAID" },
        { leave_date: "2028-03-06", session_code: "FULL", leave_type: "UNPAID" },
        { leave_date: "2028-03-07", session_code: "FULL", leave_type: "UNPAID" },
        { leave_date: "2028-03-08", session_code: "PM", leave_type: "UNPAID" },
      ]),
      "Nghỉ không lương 7.5 ngày vượt trần 7 ngày",
      nextIdem("unpaid-over"),
      "fp-unpaid-over",
    ]),
    (err) => String(err?.message).includes("LEAVE_TYPE_LIMIT_EXCEEDED"),
    "UNPAID > 7 days (14 half-day units) per request must be rejected",
  );

  // 17. Non-annual leave types (MARRIAGE = 3 days, SICK = 1.5 days) do NOT deduct from annual leave balance
  const marriageReq = await rpc("leave_management_create_request", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    JSON.stringify([
      { leave_date: "2028-03-06", session_code: "FULL", leave_type: "MARRIAGE" },
      { leave_date: "2028-03-07", session_code: "FULL", leave_type: "MARRIAGE" },
      { leave_date: "2028-03-08", session_code: "FULL", leave_type: "MARRIAGE" },
    ]),
    "Xin nghỉ cưới 3 ngày",
    nextIdem("marriage-ok"),
    "fp-marriage-ok",
  ]);
  assert.equal(marriageReq.request.requested_units, 6);
  assert.equal(marriageReq.request.requested_annual_units, 0);
  assert.equal(marriageReq.request.requested_non_annual_units, 6);
  assert.deepEqual(marriageReq.request.leave_types, ["MARRIAGE"]);

  const marriageApproved = await rpc("leave_management_decide_request", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    marriageReq.request.request_id,
    "APPROVE",
    marriageReq.request.row_version,
    null, // optional reason
    nextIdem("approve-marriage"),
    "fp-approve-marriage",
  ]);
  assert.equal(marriageApproved.request.status, "APPROVED");
  assert.equal(
    marriageApproved.requester_balance.available_units,
    6,
    "MARRIAGE leave approval must NOT deduct any annual leave units (remains 6 units = 3 days)",
  );
  assert.equal(marriageApproved.requester_balance.consumed_units, 0);
  assert.equal(marriageApproved.requester_balance.approved_marriage_units, 6);
  assert.equal(marriageApproved.request.allocations.length, 0);

  // 18. Multi-type allocation in a single request:
  // recruiterOfficial has 3 days (6 half-day units) of ANNUAL leave available in March 2028.
  // Requests 4 days (8 half-day units): 3 days ANNUAL (2028-03-13..15) + 1 day UNPAID (2028-03-16),
  // plus a half-day split on 2028-03-17 (AM = BEREAVEMENT, PM = SICK).
  const splitReq = await rpc("leave_management_create_request", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    JSON.stringify([
      { leave_date: "2028-03-13", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2028-03-14", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2028-03-15", session_code: "FULL", leave_type: "ANNUAL" },
      { leave_date: "2028-03-16", session_code: "FULL", leave_type: "UNPAID" },
      { leave_date: "2028-03-17", session_code: "AM", leave_type: "BEREAVEMENT" },
      { leave_date: "2028-03-17", session_code: "PM", leave_type: "SICK" },
    ]),
    "Xin nghỉ gộp nhiều loại: 3 ngày phép năm + 1 ngày không lương + sáng nghỉ tang + chiều nghỉ ốm",
    nextIdem("split-req"),
    "fp-split-req",
  ]);
  assert.equal(splitReq.request.requested_units, 10);
  assert.equal(splitReq.request.requested_annual_units, 6);
  assert.equal(splitReq.request.requested_non_annual_units, 4);
  assert.deepEqual(splitReq.request.leave_types, [
    "ANNUAL",
    "UNPAID",
    "BEREAVEMENT",
    "SICK",
  ]);

  const splitApproved = await rpc("leave_management_decide_request", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    splitReq.request.request_id,
    "APPROVE",
    splitReq.request.row_version,
    null,
    nextIdem("approve-split"),
    "fp-approve-split",
  ]);
  assert.equal(splitApproved.request.status, "APPROVED");
  assert.equal(
    splitApproved.requester_balance.consumed_units,
    6,
    "Only the 3 ANNUAL days (6 units) are deducted from annual leave lots",
  );
  assert.equal(splitApproved.requester_balance.available_units, 0);
  assert.equal(splitApproved.requester_balance.approved_unpaid_units, 2);
  assert.equal(splitApproved.requester_balance.approved_bereavement_units, 1);
  assert.equal(splitApproved.requester_balance.approved_sick_units, 1);
  assert.equal(
    splitApproved.request.allocations.reduce((acc, a) => acc + a.allocated_units, 0),
    6,
    "FIFO lot allocations must only be created for the 6 ANNUAL half-day units",
  );

  // 19. Admin operations with optional reason (reason = null) succeed and preserve audit log
  const currentPolicyRows = await db.query(
    "select row_version from public.leave_policy_configs where config_key = 'default'",
  );
  const policyNoReason = await rpc("leave_management_update_policy_admin", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    3,
    31,
    currentPolicyRows.rows[0].row_version,
    null, // optional reason
    nextIdem("policy-no-reason"),
    "fp-policy-no-reason",
  ]);
  assert.equal(policyNoReason.policy.carry_over_expiry_month, 3);

  const { rows: auditRowsNoReason } = await db.query(
    `select actor_app_user_id, event_type, reason, payload
       from public.leave_audit_events
      where event_type = 'POLICY_UPDATED'
      order by created_at desc
      limit 1`,
  );
  assert.equal(auditRowsNoReason[0].actor_app_user_id, ACTORS.fullAdmin.app);
  assert.equal(auditRowsNoReason[0].reason, null);
  assert.ok(auditRowsNoReason[0].payload);

  // 20. Monthly attendance & leave closing report includes attendance check-in dates + explicit leave types & sessions
  const checkinDates = [
    {
      idem: "e2800000-0000-4000-8000-000000000001",
      anchor: "2028-03-01T01:15:00.000Z",
      claimed: "2028-03-01T01:20:00.000Z",
      received: "2028-03-01T01:20:01.000Z",
      sha: "1".repeat(64),
    },
    {
      idem: "e2800000-0000-4000-8000-000000000002",
      anchor: "2028-03-02T01:15:00.000Z",
      claimed: "2028-03-02T01:20:00.000Z",
      received: "2028-03-02T01:20:01.000Z",
      sha: "2".repeat(64),
    },
    {
      idem: "e2800000-0000-4000-8000-000000000003",
      anchor: "2028-03-17T01:15:00.000Z",
      claimed: "2028-03-17T01:20:00.000Z",
      received: "2028-03-17T01:20:01.000Z",
      sha: "3".repeat(64),
    },
  ];
  for (const ck of checkinDates) {
    await rpc("attendance_record_checkin", [
      ACTORS.recruiterOfficial.auth,
      ACTORS.recruiterOfficial.app,
      ck.idem,
      ck.sha,
      21.0285,
      105.8542,
      8.5,
      "Hà Nội",
      "Chấm công sáng",
      ck.claimed,
      "SERVER_ANCHORED",
      ck.anchor,
      300_000,
      "c".repeat(64),
      `preview/attendance-checkins/${ACTORS.recruiterOfficial.app}/${ck.idem}.jpg`,
      ck.sha,
      4096,
      "image/jpeg",
      ck.received,
    ]);
  }

  const closingReport202803 = await rpc("leave_management_monthly_report", [
    ACTORS.fullAdmin.auth,
    ACTORS.fullAdmin.app,
    "2028-03",
    "RECRUITMENT",
    "NV-TD-01",
    50,
    0,
  ]);
  assert.equal(closingReport202803.rows.length, 1);
  const recRow = closingReport202803.rows[0];
  assert.equal(recRow.attendance_day_count, 3);
  assert.deepEqual(recRow.attendance_dates, [
    "2028-03-01",
    "2028-03-02",
    "2028-03-17",
  ]);
  assert.equal(recRow.month_annual_leave_units, 6);
  assert.equal(recRow.month_marriage_leave_units, 6);
  assert.equal(recRow.month_unpaid_leave_units, 2);
  assert.equal(recRow.month_bereavement_leave_units, 1);
  assert.equal(recRow.month_sick_leave_units, 1);
  assert.equal(recRow.leave_days.length, 9);
  assert.deepEqual(
    recRow.leave_days.map((d) => ({
      leave_date: d.leave_date,
      session_code: d.session_code,
      leave_type: d.leave_type,
      half_day_units: d.half_day_units,
    })),
    [
      { leave_date: "2028-03-06", session_code: "FULL", leave_type: "MARRIAGE", half_day_units: 2 },
      { leave_date: "2028-03-07", session_code: "FULL", leave_type: "MARRIAGE", half_day_units: 2 },
      { leave_date: "2028-03-08", session_code: "FULL", leave_type: "MARRIAGE", half_day_units: 2 },
      { leave_date: "2028-03-13", session_code: "FULL", leave_type: "ANNUAL", half_day_units: 2 },
      { leave_date: "2028-03-14", session_code: "FULL", leave_type: "ANNUAL", half_day_units: 2 },
      { leave_date: "2028-03-15", session_code: "FULL", leave_type: "ANNUAL", half_day_units: 2 },
      { leave_date: "2028-03-16", session_code: "FULL", leave_type: "UNPAID", half_day_units: 2 },
      { leave_date: "2028-03-17", session_code: "AM", leave_type: "BEREAVEMENT", half_day_units: 1 },
      { leave_date: "2028-03-17", session_code: "PM", leave_type: "SICK", half_day_units: 1 },
    ],
  );

  // 21. Opening Balance Target Reconciliation Regression Suite (2028):
  //   - Reconcile OFFICIAL employee with existing monthly accruals down to 0 and non-zero targets
  //   - Protect consumed/reserved units when target < locked balance (OPENING_TARGET_BELOW_LOCKED_BALANCE)
  //   - Subsequent month accrues strictly once (+2 units) without re-granting earlier months
  //   - Re-applying / editing an already-applied opening balance works with append-only ledger & idempotency
  //   - Stale preview rejection (LEAVE_OPENING_PREVIEW_STALE) when state changes between preview and apply
  await setBusinessDate(db, "2028-03-20");

  // At 2028-03-20, leaderAlpha has 3 months of 2028 monthly accruals = 6 units (3 days), 0 consumed/reserved.
  const tlSummary2028Before = await rpc("leave_management_get_my_summary", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    2028,
  ]);
  assert.equal(tlSummary2028Before.balance.monthly_accrued_units, 6);
  assert.equal(tlSummary2028Before.balance.available_units, 6);

  // Reconcile leaderAlpha down to 0 units (took all 3 days before BI tracking)
  const previewZeroTarget = await rpc("leave_management_preview_opening_batch", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    2028,
    JSON.stringify([
      {
        app_user_id: ACTORS.leaderAlpha.app,
        carry_over_units: 0,
        opening_current_year_units: 0,
        seniority_units: 0,
        note: "Đã nghỉ hết 3 ngày phép đầu năm trước khi lên BI",
      },
    ]),
  ]);
  assert.equal(previewZeroTarget.valid, true);
  assert.equal(previewZeroTarget.as_of_date, "2028-03-20");
  assert.equal(previewZeroTarget.rows[0].current_year_accrued_units, 6);
  assert.equal(previewZeroTarget.rows[0].current_year_granted_units, 6);
  assert.equal(previewZeroTarget.rows[0].delta_current_year_units, -6);
  assert.equal(previewZeroTarget.rows[0].reconciled_current_year_available_units, 0);

  const applyZeroTarget = await rpc("leave_management_apply_opening_batch", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    2028,
    JSON.stringify([
      {
        app_user_id: ACTORS.leaderAlpha.app,
        carry_over_units: 0,
        opening_current_year_units: 0,
        seniority_units: 0,
        note: "Đã nghỉ hết 3 ngày phép đầu năm trước khi lên BI",
        expected_as_of_date: previewZeroTarget.rows[0].as_of_date,
        expected_current_year_granted_units:
          previewZeroTarget.rows[0].current_year_granted_units,
        expected_current_year_locked_units:
          previewZeroTarget.rows[0].current_year_locked_units,
        expected_profile_row_version:
          previewZeroTarget.rows[0].profile_row_version,
      },
    ]),
    "Đối soát số dư mục tiêu = 0 ngày",
    nextIdem("reconcile-2028-zero"),
    "fp-reconcile-2028-zero",
  ]);
  assert.equal(applyZeroTarget.replayed, false);
  assert.equal(applyZeroTarget.applied_row_count, 1);
  assert.equal(applyZeroTarget.batch_id, applyZeroTarget.batch.batch_id);
  assert.equal(applyZeroTarget.applied_rows[0].balance.available_units, 0);
  assert.equal(applyZeroTarget.applied_rows[0].balance.total_granted_units, 0);
  assert.equal(applyZeroTarget.applied_rows[0].balance.monthly_accrued_units, 6);
  assert.equal(applyZeroTarget.applied_rows[0].balance.opening_or_adjustment_units, -6);

  // Verify ledger records explicit ADJUST_OPENING_CURRENT_YEAR_DECREASE entry type for downward reconciliation
  const tlSummaryAfterZero = await rpc("leave_management_get_my_summary", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    2028,
  ]);
  const decreaseLedgerEntries = tlSummaryAfterZero.ledger_entries.filter(
    (e) =>
      e.entry_type === "ADJUST_OPENING_CURRENT_YEAR_DECREASE" &&
      e.effective_date === "2028-03-20",
  );
  assert.ok(
    decreaseLedgerEntries.length > 0,
    "Downward opening balance reconciliation must write ADJUST_OPENING_CURRENT_YEAR_DECREASE ledger entries",
  );
  assert.equal(
    decreaseLedgerEntries.reduce((sum, e) => sum + e.delta_available_units, 0),
    -6,
  );

  // Re-applying the same preview with a new idempotency key (without re-previewing) must fail with LEAVE_OPENING_PREVIEW_STALE
  await assert.rejects(
    rpc("leave_management_apply_opening_batch", [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      2028,
      JSON.stringify([
        {
          app_user_id: ACTORS.leaderAlpha.app,
          carry_over_units: 0,
          opening_current_year_units: 0,
          seniority_units: 0,
          note: "Đã nghỉ hết 3 ngày phép đầu năm trước khi lên BI",
        },
      ]),
      "Thử dùng lại bản preview cũ đã áp dụng",
      nextIdem("reconcile-2028-stale-replay"),
      "fp-reconcile-2028-stale-replay",
    ]),
    (err) => String(err?.message).includes("LEAVE_OPENING_PREVIEW_STALE"),
    "Applying a consumed/stale preview without re-previewing must reject with LEAVE_OPENING_PREVIEW_STALE",
  );

  // Re-preview and edit/re-apply leaderAlpha's opening balance upward from 0 to 4 units (2 days), then to 8 units (4 days)
  const previewEditTo4 = await rpc("leave_management_preview_opening_batch", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    2028,
    JSON.stringify([
      {
        app_user_id: ACTORS.leaderAlpha.app,
        carry_over_units: 0,
        opening_current_year_units: 4,
        seniority_units: 0,
        note: "Điều chỉnh lại số dư sau đối soát = 2 ngày",
      },
    ]),
  ]);
  assert.equal(previewEditTo4.valid, true);
  assert.equal(previewEditTo4.rows[0].current_year_granted_units, 0);
  assert.equal(previewEditTo4.rows[0].delta_current_year_units, 4);

  const applyEditTo4Idem = nextIdem("reconcile-2028-edit-4");
  const applyEditTo4 = await rpc("leave_management_apply_opening_batch", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    2028,
    JSON.stringify([
      {
        app_user_id: ACTORS.leaderAlpha.app,
        carry_over_units: 0,
        opening_current_year_units: 4,
        seniority_units: 0,
        note: "Điều chỉnh lại số dư sau đối soát = 2 ngày",
      },
    ]),
    "Hiệu chỉnh số dư mục tiêu lên 2 ngày",
    applyEditTo4Idem,
    "fp-reconcile-2028-edit-4",
  ]);
  assert.equal(applyEditTo4.applied_rows[0].balance.available_units, 4);
  assert.equal(applyEditTo4.applied_rows[0].balance.opening_or_adjustment_units, -2);

  // Verify upward reconciliation after reduction writes ADJUST_OPENING_CURRENT_YEAR_INCREASE ledger entries
  const tlSummaryAfterEditTo4 = await rpc("leave_management_get_my_summary", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    2028,
  ]);
  const increaseLedgerEntries = tlSummaryAfterEditTo4.ledger_entries.filter(
    (e) =>
      e.entry_type === "ADJUST_OPENING_CURRENT_YEAR_INCREASE" &&
      e.effective_date === "2028-03-20",
  );
  assert.ok(
    increaseLedgerEntries.length > 0,
    "Upward opening balance reconciliation must write ADJUST_OPENING_CURRENT_YEAR_INCREASE ledger entries",
  );
  assert.equal(
    increaseLedgerEntries.reduce((sum, e) => sum + e.delta_available_units, 0),
    4,
  );

  // Applying seniority_units > 0 once succeeds, and re-applying seniority_units > 0 in the same year is blocked with SENIORITY_LOT_ALREADY_EXISTS
  const previewWithSeniority = await rpc("leave_management_preview_opening_batch", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    2028,
    JSON.stringify([
      {
        app_user_id: ACTORS.leaderAlpha.app,
        carry_over_units: 0,
        opening_current_year_units: 4,
        seniority_units: 2,
        note: "Khởi tạo thêm 1 ngày phép thâm niên năm 2028",
      },
    ]),
  ]);
  assert.equal(previewWithSeniority.valid, true);

  const applyWithSeniority = await rpc("leave_management_apply_opening_batch", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    2028,
    JSON.stringify([
      {
        app_user_id: ACTORS.leaderAlpha.app,
        carry_over_units: 0,
        opening_current_year_units: 4,
        seniority_units: 2,
        note: "Khởi tạo thêm 1 ngày phép thâm niên năm 2028",
      },
    ]),
    "Cấp phép thâm niên 2028 cho leaderAlpha",
    nextIdem("reconcile-2028-sen-once"),
    "fp-reconcile-2028-sen-once",
  ]);
  assert.equal(applyWithSeniority.applied_rows[0].balance.seniority_granted_units, 2);
  assert.equal(applyWithSeniority.applied_rows[0].balance.available_units, 6);

  // Attempting to re-apply with seniority_units > 0 for the same employee & year must fail with SENIORITY_LOT_ALREADY_EXISTS
  const previewDuplicateSeniority = await rpc("leave_management_preview_opening_batch", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    2028,
    JSON.stringify([
      {
        app_user_id: ACTORS.leaderAlpha.app,
        carry_over_units: 0,
        opening_current_year_units: 4,
        seniority_units: 2,
        note: "Thử cấp trùng phép thâm niên khi đối soát lại",
      },
    ]),
  ]);
  assert.equal(previewDuplicateSeniority.valid, false);
  assert.deepEqual(previewDuplicateSeniority.rows[0].errors, [
    "SENIORITY_LOT_ALREADY_EXISTS",
  ]);

  await assert.rejects(
    rpc("leave_management_apply_opening_batch", [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      2028,
      JSON.stringify([
        {
          app_user_id: ACTORS.leaderAlpha.app,
          carry_over_units: 0,
          opening_current_year_units: 4,
          seniority_units: 2,
          note: "Thử cấp trùng phép thâm niên khi đối soát lại",
        },
      ]),
      "Thử áp dụng lặp phép thâm niên",
      nextIdem("reconcile-2028-sen-dup-fail"),
      "fp-reconcile-2028-sen-dup-fail",
    ]),
    (err) =>
      String(err?.message).includes("LEAVE_OPENING_BATCH_VALIDATION_FAILED"),
    "Re-applying opening balance with seniority_units > 0 when SENIORITY_GRANT already exists must fail closed",
  );

  // Idempotent replay with the same idempotency key & fingerprint returns replayed=true and preserves top-level applied_row_count
  const replayEditTo4 = await rpc("leave_management_apply_opening_batch", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    2028,
    JSON.stringify([
      {
        app_user_id: ACTORS.leaderAlpha.app,
        carry_over_units: 0,
        opening_current_year_units: 4,
        seniority_units: 0,
        note: "Điều chỉnh lại số dư sau đối soát = 2 ngày",
      },
    ]),
    "Hiệu chỉnh số dư mục tiêu lên 2 ngày",
    applyEditTo4Idem,
    "fp-reconcile-2028-edit-4",
  ]);
  assert.equal(replayEditTo4.replayed, true);
  assert.equal(replayEditTo4.applied_row_count, 1);
  assert.equal(replayEditTo4.batch_id, applyEditTo4.batch_id);

  // Advance business date to next month (2028-04-15): month 4 must accrue strictly once (+2 units -> available becomes 4 current-year + 2 seniority + 2 April = 8)
  await setBusinessDate(db, "2028-04-15");
  const tlSummary2028April1 = await rpc("leave_management_get_my_summary", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    2028,
  ]);
  assert.equal(tlSummary2028April1.balance.monthly_accrued_units, 8);
  assert.equal(tlSummary2028April1.balance.seniority_granted_units, 2);
  assert.equal(tlSummary2028April1.balance.opening_or_adjustment_units, -2);
  assert.equal(tlSummary2028April1.balance.available_units, 8);

  // Calling summary again in April does not duplicate month 4 accrual
  const tlSummary2028April2 = await rpc("leave_management_get_my_summary", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    2028,
  ]);
  assert.equal(tlSummary2028April2.balance.available_units, 8);

  // Test locked balance protection: recruiterOfficial in 2028-03 already has 6 consumed ANNUAL units (from splitApproved).
  // At 2028-04-15, recruiterOfficial has 8 granted (4 months * 2), 6 consumed (locked), 2 available.
  // Setting target below 6 locked units (e.g. target = 4 units) must fail with OPENING_TARGET_BELOW_LOCKED_BALANCE!
  const previewBelowLocked = await rpc("leave_management_preview_opening_batch", [
    ACTORS.hrOperator.auth,
    ACTORS.hrOperator.app,
    2028,
    JSON.stringify([
      {
        app_user_id: ACTORS.recruiterOfficial.app,
        carry_over_units: 0,
        opening_current_year_units: 4,
        seniority_units: 0,
        note: "Thử đặt mục tiêu 2 ngày thấp hơn 3 ngày đã nghỉ trên app",
      },
    ]),
  ]);
  assert.equal(previewBelowLocked.valid, false);
  assert.deepEqual(previewBelowLocked.rows[0].errors, [
    "OPENING_TARGET_BELOW_LOCKED_BALANCE",
  ]);
  assert.equal(previewBelowLocked.rows[0].current_year_locked_units, 6);

  await assert.rejects(
    rpc("leave_management_apply_opening_batch", [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      2028,
      JSON.stringify([
        {
          app_user_id: ACTORS.recruiterOfficial.app,
          carry_over_units: 0,
          opening_current_year_units: 4,
          seniority_units: 0,
          note: "Thử đặt mục tiêu 2 ngày thấp hơn 3 ngày đã nghỉ trên app",
        },
      ]),
      "Thử áp dụng mục tiêu thấp hơn số phép đã dùng",
      nextIdem("reconcile-below-locked-fail"),
      "fp-reconcile-below-locked-fail",
    ]),
    (err) =>
      String(err?.message).includes("LEAVE_OPENING_BATCH_VALIDATION_FAILED"),
    "Applying target below locked (consumed/reserved) balance must fail closed",
  );

  // Test stale preview rejection when employee state changes between preview and apply:
  // 1. HR previews reconciling recruiterOfficial from 8 granted (6 consumed, 2 available) down to 6 granted (0 available)
  const previewBeforeStateChange = await rpc(
    "leave_management_preview_opening_batch",
    [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      2028,
      JSON.stringify([
        {
          app_user_id: ACTORS.recruiterOfficial.app,
          carry_over_units: 0,
          opening_current_year_units: 6,
          seniority_units: 0,
          note: "Chốt số dư mục tiêu 3 ngày",
        },
      ]),
    ],
  );
  assert.equal(previewBeforeStateChange.valid, true);
  assert.equal(previewBeforeStateChange.rows[0].current_year_locked_units, 6);

  // 2. Before HR clicks Apply, recruiterOfficial submits & gets approved 1 day (2 units) of ANNUAL leave on 2028-04-20 (reserved_units increases by 2 -> locked becomes 8)
  const interveningReq = await rpc("leave_management_create_request", [
    ACTORS.recruiterOfficial.auth,
    ACTORS.recruiterOfficial.app,
    JSON.stringify([
      { leave_date: "2028-04-20", session_code: "FULL", leave_type: "ANNUAL" },
    ]),
    "Xin nghỉ phép năm phát sinh giữa preview và apply",
    nextIdem("intervening-req-2028"),
    "fp-intervening-req-2028",
  ]);
  await rpc("leave_management_decide_request", [
    ACTORS.leaderAlpha.auth,
    ACTORS.leaderAlpha.app,
    interveningReq.request.request_id,
    "APPROVE",
    interveningReq.request.row_version,
    "Duyệt phép phát sinh",
    nextIdem("approve-intervening-2028"),
    "fp-approve-intervening-2028",
  ]);

  // 3. HR now attempts to apply the stale preview -> rejected with LEAVE_OPENING_PREVIEW_STALE
  await assert.rejects(
    rpc("leave_management_apply_opening_batch", [
      ACTORS.hrOperator.auth,
      ACTORS.hrOperator.app,
      2028,
      JSON.stringify([
        {
          app_user_id: ACTORS.recruiterOfficial.app,
          carry_over_units: 0,
          opening_current_year_units: 6,
          seniority_units: 0,
          note: "Chốt số dư mục tiêu 3 ngày",
        },
      ]),
      "Áp dụng bản preview cũ sau khi nhân viên vừa được duyệt thêm phép",
      nextIdem("apply-stale-after-req"),
      "fp-apply-stale-after-req",
    ]),
    (err) => String(err?.message).includes("LEAVE_OPENING_PREVIEW_STALE"),
    "Applying opening balance after underlying locked balance changed since preview must reject with LEAVE_OPENING_PREVIEW_STALE",
  );
});
