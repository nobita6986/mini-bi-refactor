/**
 * WP8D (Nav Slice) — Read-Only Work Reports Navbar Probe PGlite Verification Suite.
 *
 * Covers:
 *   1. Migration hygiene (0 `@`, 0 literal `SAVEPOINT`, atomic `BEGIN; ...; ROLLBACK;`
 *      zero drift, `STABLE` volatility, `SECURITY DEFINER`, pinned `search_path`,
 *      strict ACLs on public RPC & internal helpers).
 *   2. Strict `BEGIN TRANSACTION READ ONLY; SET LOCAL ROLE service_role;` execution +
 *      SHA-256 hash & row-count immutability proof across all 6 Work Reports tables
 *      (and negative proof that `work_report_list_my_obligations` fails with `25006`
 *      inside `READ ONLY` when materialization would write).
 *   3. Full local oracle comparing READ ONLY `work_report_has_active_obligations` vs
 *      rolled-back real `work_report_list_my_obligations(..., 'ACTIVE')` across:
 *      - Zero obligations / zero assignments
 *      - Existing ACTIVE obligations (historical > 7d, ended assignment, archived template,
 *        submitted/completed/approved)
 *      - Unmaterialized USER, USER_SET, TEAM (verified/unverified/non-current/other team),
 *        GROUP (active eligible, inactive group, ineligible assignee, group member out of
 *        assigner scope)
 *      - DRAFT/ARCHIVED templates, PAUSED/REVOKED/non-current assignments, future/expired
 *      - ONCE frequency (in window, effective_from < window_start, future, already materialized
 *        EXEMPTED/CANCELLED, revoked + replacement ONCE)
 *      - EXEMPTED vs CANCELLED (unsubmitted no-submission, unsubmitted DRAFT `first_submitted_at is null`,
 *        submitted `first_submitted_at is not null`, ended/revoked without replacement)
 *      - 7-day materialization lookback window edges & Vietnam (`Asia/Ho_Chi_Minh`) date boundary
 *   4. Actor guard parity: wrong `auth_subject`, unknown `app_user_id`, NULL args, disabled user
 *      all raise `42501 WORK_REPORT_ACTOR_DENIED`.
 *   5. Business endpoint regression: after probe returns `true` with 0 writes, real
 *      `work_report_list_my_obligations` still materializes new obligations, returns
 *      `schema_json`, and reactivates unsubmitted CANCELLED rows.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";
import {
  WP8D_NAV_READONLY_MIGRATION_NAME,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const MONITORED_TABLES = [
  "work_report_obligations",
  "work_report_submissions",
  "work_report_submission_revisions",
  "work_report_metric_values",
  "work_report_assignments",
  "work_report_audit_events",
];

let uuidSeq = 1;
function nextUuid(prefix = "8d000000") {
  const n = (uuidSeq++).toString(16).padStart(12, "0");
  return `${prefix}-0000-4000-8000-${n}`;
}

function makeUser(tag) {
  return {
    auth: nextUuid("18d00000"),
    app: nextUuid("28d00000"),
    recruiter: nextUuid("38d00000"),
    name: tag,
  };
}

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createMigratedDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrations();
  for (const m of migrations) {
    await db.exec(m.sql);
  }
  return db;
}

async function seedUser(db, user, { enabled = true, capabilities = [], scopes = [] } = {}) {
  await db.query("insert into auth.users (id) values ($1::uuid)", [user.auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name) values ($1::uuid, $2::uuid, $3, $4)",
    [user.app, user.auth, enabled, user.name],
  );
  for (const cap of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
      [user.app, cap],
    );
  }
  for (const scope of scopes) {
    if (typeof scope === "string") {
      await db.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
        [user.app, scope],
      );
    } else {
      await db.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, $2, $3::uuid, '2026-01-01', true)",
        [user.app, scope.kind, scope.teamId],
      );
    }
  }
}

async function linkRecruiterToTeam(
  db,
  user,
  teamId,
  { verified = true, isCurrentLink = true, recruiterActive = true, isCurrentTeam = true } = {},
) {
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, $2, $3)",
    [user.recruiter, user.name, recruiterActive],
  );
  if (!verified) {
    // `direct_entry_guard_effective_interval` expects verified=true on normal inserts;
    // temporarily bypass only in this test fixture to cover legacy unverified link rows.
    await db.query("alter table public.direct_entry_app_user_recruiter_links disable trigger direct_entry_recruiter_link_no_overlap");
  }
  try {
    await db.query(
      `insert into public.direct_entry_app_user_recruiter_links (
         app_user_id, recruiter_id, verified, is_current, valid_from, valid_to
       ) values ($1::uuid, $2::uuid, $3, $4, '2026-01-01', $5::date)`,
      [user.app, user.recruiter, verified, isCurrentLink, isCurrentLink ? null : "2026-02-01"],
    );
  } finally {
    if (!verified) {
      await db.query("alter table public.direct_entry_app_user_recruiter_links enable trigger direct_entry_recruiter_link_no_overlap");
    }
  }
  if (teamId) {
    await db.query(
      `insert into public.recruiter_team_memberships (
         recruiter_id, team_id, valid_from, valid_to, is_current
       ) values ($1::uuid, $2::uuid, '2026-01-01', $3::date, $4)`,
      [user.recruiter, teamId, isCurrentTeam ? null : "2026-02-01", isCurrentTeam],
    );
  }
}

async function createPublishedTemplate(db, admin, code, { archiveAfter = false, keepDraft = false } = {}) {
  const metricContract = buildWorkReportMetricContract(RECRUITMENT_DAILY_TEMPLATE_SCHEMA);
  const { rows: [created] } = await db.query(
    `select public.work_report_create_template(
       $1::uuid, $2::uuid, $3, $4, 'WP8D test template', 'DAILY', $5::jsonb, $6::jsonb, $7
     ) as result`,
    [
      admin.auth,
      admin.app,
      code,
      `Template ${code}`,
      JSON.stringify(RECRUITMENT_DAILY_TEMPLATE_SCHEMA),
      JSON.stringify(metricContract),
      `create-tpl-${code}-${nextUuid()}`,
    ],
  );
  const templateId = created.result.template_id;
  const versionId = created.result.draft_version_id;
  if (!keepDraft) {
    await db.query(
      "select public.work_report_publish_template($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, $5)",
      [admin.auth, admin.app, templateId, versionId, `pub-${code}-${nextUuid()}`],
    );
    if (archiveAfter) {
      await db.query(
        "select public.work_report_archive_template($1::uuid, $2::uuid, $3::uuid, 2, $4)",
        [admin.auth, admin.app, templateId, `arch-${code}-${nextUuid()}`],
      );
    }
  }
  return { templateId, versionId };
}

async function insertAssignmentRow(
  db,
  {
    templateId,
    versionId,
    assignedByUserId,
    targetKind,
    targetUserId = null,
    targetTeamId = null,
    targetGroupId = null,
    userSetIds = [],
    frequency = "DAILY",
    excludeSundays = false,
    effectiveFrom,
    effectiveTo = null,
    state = "ACTIVE",
    isCurrent = true,
  },
) {
  const assignmentId = nextUuid("48d00000");
  await db.query(
    `insert into public.work_report_assignments (
       assignment_id, template_id, template_version_id, target_kind,
       target_user_id, target_team_id, target_group_id,
       frequency, is_mandatory, timezone, due_day_offset, due_time_local,
       exclude_sundays, effective_from, effective_to, state, is_current, assigned_by_user_id
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4,
       $5::uuid, $6::uuid, $7::uuid,
       $8, true, 'Asia/Ho_Chi_Minh', 0, '23:59:59',
       $9, $10::date, $11::date, $12, $13, $14::uuid
     )`,
    [
      assignmentId,
      templateId,
      versionId,
      targetKind,
      targetUserId,
      targetTeamId,
      targetGroupId,
      frequency,
      excludeSundays,
      effectiveFrom,
      effectiveTo,
      state,
      isCurrent,
      assignedByUserId,
    ],
  );
  for (const uid of userSetIds) {
    await db.query(
      "insert into public.work_report_assignment_targets (assignment_id, target_user_id) values ($1::uuid, $2::uuid)",
      [assignmentId, uid],
    );
  }
  return assignmentId;
}

async function insertObligationRow(
  db,
  {
    obligationId = nextUuid("58d00000"),
    templateId,
    versionId,
    assignmentId,
    assigneeAppUserId,
    periodType = "DAILY",
    periodDate,
    periodKey = periodType === "ONCE" ? `ONCE-${periodDate}` : periodDate,
    status = "ACTIVE",
  },
) {
  await db.query(
    `insert into public.work_report_obligations (
       obligation_id, template_id, template_version_id, assignment_id, assignee_app_user_id,
       period_type, period_key, period_start_date, period_end_date, due_at, obligation_status
     ) values (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
       $6::text, $7::text, $8::date, $8::date,
       ($8::date::timestamp + interval '23 hours') at time zone 'Asia/Ho_Chi_Minh', $9::text
     )`,
    [obligationId, templateId, versionId, assignmentId, assigneeAppUserId, periodType, periodKey, periodDate, status],
  );
  return obligationId;
}

async function captureTableDigest(db) {
  const counts = {};
  const hasher = createHash("sha256");
  for (const table of MONITORED_TABLES) {
    const { rows } = await db.query(
      `select count(*)::integer as cnt,
              coalesce(string_agg(row_to_json(t)::text, E'\n' order by row_to_json(t)::text), '') as body
         from public.${table} t`,
    );
    counts[table] = rows[0].cnt;
    hasher.update(`${table}:${rows[0].cnt}:${rows[0].body}\n`);
  }
  return { counts, hash: hasher.digest("hex") };
}

async function runReadOnlyProbe(db, actor) {
  await db.query("begin transaction read only");
  try {
    await db.query("set local role service_role");
    const { rows } = await db.query(
      "select public.work_report_has_active_obligations($1::uuid, $2::uuid) as result",
      [actor.auth, actor.app],
    );
    await db.query("commit");
    return rows[0].result;
  } catch (err) {
    await db.query("rollback").catch(() => {});
    throw err;
  }
}

async function runOracleListActive(db, actor) {
  await db.query("begin");
  try {
    await db.query("set local role service_role");
    const { rows } = await db.query(
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as result",
      [actor.auth, actor.app],
    );
    await db.query("rollback");
    const items = rows[0]?.result?.items ?? [];
    return items.length > 0;
  } catch (err) {
    await db.query("rollback").catch(() => {});
    throw err;
  }
}

async function assertOracleParity(db, actor, expectedBool, label) {
  const before = await captureTableDigest(db);
  const probePayload = await runReadOnlyProbe(db, actor);
  const after = await captureTableDigest(db);

  assert.deepEqual(
    Object.keys(probePayload),
    ["has_active_obligations"],
    `${label}: probe must return strictly { has_active_obligations }`,
  );
  assert.equal(
    typeof probePayload.has_active_obligations,
    "boolean",
    `${label}: probe value must be boolean`,
  );
  assert.equal(
    after.hash,
    before.hash,
    `${label}: READ ONLY probe must leave all 6 Work Reports tables byte-identical`,
  );
  assert.deepEqual(
    after.counts,
    before.counts,
    `${label}: READ ONLY probe must leave all 6 Work Reports table row counts unchanged`,
  );

  const oracleBool = await runOracleListActive(db, actor);
  assert.equal(
    probePayload.has_active_obligations,
    oracleBool,
    `${label}: probe (${probePayload.has_active_obligations}) must match rolled-back list_my_obligations('ACTIVE') (${oracleBool})`,
  );
  assert.equal(
    probePayload.has_active_obligations,
    expectedBool,
    `${label}: expected ${expectedBool}, got ${probePayload.has_active_obligations}`,
  );
}

test("1. WP8D nav readonly migration hygiene: 0 at-signs, 0 SAVEPOINT, atomic rollback zero drift, STABLE volatility & strict ACLs", async () => {
  const sql = await readFile(path.join(MIGRATION_DIR, WP8D_NAV_READONLY_MIGRATION_NAME), "utf8");
  assert.equal(sql.includes("@"), false, "WP8D migration must contain zero @ characters");
  assert.equal(/\bSAVEPOINT\b/i.test(sql), false, "WP8D migration must contain zero literal SAVEPOINT");

  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    const migrations = await loadMigrations();
    const wp8dIdx = migrations.findIndex((m) => m.name === WP8D_NAV_READONLY_MIGRATION_NAME);
    assert.ok(wp8dIdx > 0, "WP8D nav readonly migration must exist in supabase/migrations");
    for (const m of migrations.slice(0, wp8dIdx)) {
      await db.exec(m.sql);
    }

    // Atomic rollback rehearsal
    await db.exec(`begin;\n${migrationSqlForTransaction(migrations[wp8dIdx].sql)}\nrollback;`);
    const { rows: afterRb } = await db.query(
      `select p.proname
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'work_report_has_active_obligations',
            'work_report__internal_actor_materialization_candidates',
            'work_report__internal_has_active_obligations_for_date'
          )`,
    );
    assert.equal(afterRb.length, 0, "Rolled-back WP8D rehearsal must leave zero drift");

    // Clean apply and catalog invariant checks
    await db.exec(migrations[wp8dIdx].sql);
    const { rows: fns } = await db.query(
      `select p.proname,
              p.provolatile,
              p.prosecdef,
              coalesce(array_to_string(p.proconfig, ','), '') as config_str,
              has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in (
            'work_report_has_active_obligations',
            'work_report__internal_actor_materialization_candidates',
            'work_report__internal_has_active_obligations_for_date',
            'work_report__internal_materialize_actor_obligations'
          )
        order by p.proname`,
    );
    assert.equal(fns.length, 4);
    const byName = Object.fromEntries(fns.map((r) => [r.proname, r]));

    for (const name of [
      "work_report_has_active_obligations",
      "work_report__internal_actor_materialization_candidates",
      "work_report__internal_has_active_obligations_for_date",
    ]) {
      assert.equal(byName[name].provolatile, "s", `${name} must be STABLE`);
      assert.equal(byName[name].prosecdef, true, `${name} must be SECURITY DEFINER`);
      assert.equal(byName[name].config_str, "search_path=pg_catalog, public");
      assert.equal(byName[name].pub_exec, false, `${name} PUBLIC EXECUTE revoked`);
      assert.equal(byName[name].anon_exec, false, `${name} anon EXECUTE revoked`);
      assert.equal(byName[name].auth_exec, false, `${name} authenticated EXECUTE revoked`);
    }
    assert.equal(byName.work_report_has_active_obligations.svc_exec, true, "probe grants EXECUTE to service_role");
    assert.equal(byName.work_report__internal_actor_materialization_candidates.svc_exec, false);
    assert.equal(byName.work_report__internal_has_active_obligations_for_date.svc_exec, false);
    assert.equal(byName.work_report__internal_materialize_actor_obligations.svc_exec, false);
    assert.equal(byName.work_report__internal_materialize_actor_obligations.provolatile, "v");
  } finally {
    await db.close();
  }
});

test("2. Local oracle parity, READ ONLY zero-write immutability, all assignment/obligation/ONCE/CANCELLED/EXEMPTED/window/TZ/actor cases, and business materialization regression", async () => {
  const db = await createMigratedDb();
  try {
    const { rows: [{ vn_today: today }] } = await db.query(
      "select (pg_catalog.now() at time zone 'Asia/Ho_Chi_Minh')::date::text as vn_today",
    );
    const shiftDate = async (days) => {
      const { rows: [{ d }] } = await db.query("select ($1::date + $2::integer)::text as d", [today, days]);
      return d;
    };

    const dMinus30 = await shiftDate(-30);
    const dMinus20 = await shiftDate(-20);
    const dMinus8 = await shiftDate(-8);
    const dMinus6 = await shiftDate(-6);
    const dMinus1 = await shiftDate(-1);
    const dPlus1 = await shiftDate(1);

    // Seed teams (teamA/teamB for TEAM target tests; teamC/teamD isolated for GROUP target tests)
    const teamA = nextUuid("98d00000");
    const teamB = nextUuid("98d00000");
    const teamC = nextUuid("98d00000");
    const teamD = nextUuid("98d00000");
    await db.query(
      `insert into public.teams (team_id, code, display_name)
       values ($1::uuid, 'WP8D_TEAM_A', 'WP8D Team A'),
              ($2::uuid, 'WP8D_TEAM_B', 'WP8D Team B'),
              ($3::uuid, 'WP8D_TEAM_C', 'WP8D Team C'),
              ($4::uuid, 'WP8D_TEAM_D', 'WP8D Team D')`,
      [teamA, teamB, teamC, teamD],
    );

    // Seed admin & team leader C (isolated from TEAM A assignment)
    const admin = makeUser("WP8D Admin");
    await seedUser(db, admin, {
      capabilities: ["entry_admin", "report_form_manage", "report_assign", "report_view"],
      scopes: ["all"],
    });
    const leaderC = makeUser("WP8D Leader C");
    await seedUser(db, leaderC, {
      capabilities: ["report_assign", "report_view"],
      scopes: [{ kind: "team", teamId: teamC }],
    });
    await linkRecruiterToTeam(db, leaderC, teamC);

    // Seed dedicated test actors so each scenario is cleanly isolated
    const uEmpty = makeUser("Empty User");
    const uHistActive = makeUser("Historical Active");
    const uSubmittedActive = makeUser("Submitted Active");
    const uArchivedTplActive = makeUser("Archived Tpl Active");
    const uDirectTarget = makeUser("USER Target");
    const uDirectOther = makeUser("USER NonTarget");
    const uSetMember = makeUser("USER_SET Member");
    const uSetNonMember = makeUser("USER_SET NonMember");
    const uTeamValid = makeUser("TEAM Valid");
    const uTeamUnverified = makeUser("TEAM Unverified");
    const uTeamEndedLink = makeUser("TEAM EndedLink");
    const uTeamOther = makeUser("TEAM Other");
    const uGroupEligible = makeUser("GROUP Eligible");
    const uGroupNonMember = makeUser("GROUP NonMember");
    const uGroupInactive = makeUser("GROUP InactiveGrp");
    const uGroupIneligible = makeUser("GROUP Ineligible");
    const uGroupScopeMemberA = makeUser("GROUP ScopeMemberA");
    const uGroupScopeOutB = makeUser("GROUP ScopeOutB");
    const uDraftTpl = makeUser("Draft Template");
    const uArchivedTplUnmat = makeUser("Archived Template Unmat");
    const uPausedAssign = makeUser("Paused Assignment");
    const uRevokedAssign = makeUser("Revoked Assignment");
    const uFutureAssign = makeUser("Future Assignment");
    const uExpiredAssign = makeUser("Expired Outside 7d");
    const uRecentEndAssign = makeUser("Ended Inside 7d");
    const uOnceToday = makeUser("ONCE Today");
    const uOnceOldStart = makeUser("ONCE Old Start");
    const uOnceFuture = makeUser("ONCE Future");
    const uOnceExempted = makeUser("ONCE Exempted");
    const uOnceReactivate = makeUser("ONCE Reactivate");
    const uOnceReplaceExempted = makeUser("ONCE Replace Exempted");
    const uOnceReplaceSubmitted = makeUser("ONCE Replace Submitted");
    const uWeeklyCross = makeUser("WEEKLY Cross Window");
    const uMonthlyCross = makeUser("MONTHLY Cross Window");
    const uExemptedDaily = makeUser("EXEMPTED Daily");
    const uCancelledNoSub = makeUser("CANCELLED NoSub Replace");
    const uCancelledDraftSub = makeUser("CANCELLED DraftSub Replace");
    const uCancelledSubmitted = makeUser("CANCELLED Submitted Replace");
    const uCancelledNoReplace = makeUser("CANCELLED NoReplace");
    const uDisabledWithActive = makeUser("Disabled With Active");
    const uWindowBoundary = makeUser("Window Boundary");

    for (const u of [
      uEmpty, uHistActive, uSubmittedActive, uArchivedTplActive,
      uDirectTarget, uDirectOther, uSetMember, uSetNonMember,
      uTeamValid, uTeamUnverified, uTeamEndedLink, uTeamOther,
      uGroupEligible, uGroupNonMember, uGroupInactive, uGroupIneligible,
      uGroupScopeMemberA, uGroupScopeOutB,
      uDraftTpl, uArchivedTplUnmat, uPausedAssign, uRevokedAssign,
      uFutureAssign, uExpiredAssign, uRecentEndAssign,
      uOnceToday, uOnceOldStart, uOnceFuture, uOnceExempted, uOnceReactivate,
      uOnceReplaceExempted, uOnceReplaceSubmitted, uWeeklyCross, uMonthlyCross,
      uExemptedDaily, uCancelledNoSub, uCancelledDraftSub, uCancelledSubmitted, uCancelledNoReplace,
      uWindowBoundary,
    ]) {
      await seedUser(db, u);
    }
    await seedUser(db, uDisabledWithActive, { enabled: false });

    // Team links for TEAM (teamA/teamB) and GROUP (isolated on teamC/teamD) scenarios
    await linkRecruiterToTeam(db, uTeamValid, teamA, { verified: true, isCurrentLink: true, isCurrentTeam: true });
    await linkRecruiterToTeam(db, uTeamUnverified, teamA, { verified: false, isCurrentLink: true, isCurrentTeam: true });
    await linkRecruiterToTeam(db, uTeamEndedLink, teamA, { verified: true, isCurrentLink: false, isCurrentTeam: true });
    await linkRecruiterToTeam(db, uTeamOther, teamB, { verified: true, isCurrentLink: true, isCurrentTeam: true });
    await linkRecruiterToTeam(db, uGroupEligible, teamC);
    await linkRecruiterToTeam(db, uGroupInactive, teamC);
    // Ineligible assignee: active verified current recruiter link with NO current team membership
    await linkRecruiterToTeam(db, uGroupIneligible, null);
    await linkRecruiterToTeam(db, uGroupScopeMemberA, teamC);
    await linkRecruiterToTeam(db, uGroupScopeOutB, teamD);

    // Templates
    const tplActive = await createPublishedTemplate(db, admin, "WP8D_ACTIVE");
    const tplDraft = await createPublishedTemplate(db, admin, "WP8D_DRAFT", { keepDraft: true });
    const tplArchived = await createPublishedTemplate(db, admin, "WP8D_ARCH", { archiveAfter: true });
    const tplOnce = await createPublishedTemplate(db, admin, "WP8D_ONCE");
    const tplCancel = await createPublishedTemplate(db, admin, "WP8D_CANCEL");
    const tplBoundary = await createPublishedTemplate(db, admin, "WP8D_BOUND");

    // -------------------------------------------------------------------------
    // (a) Empty user -> false
    // -------------------------------------------------------------------------
    await assertOracleParity(db, uEmpty, false, "empty user (no obligations, no assignments)");

    // -------------------------------------------------------------------------
    // (b) Existing ACTIVE obligations (historical > 7d, submitted/completed, archived tpl)
    // -------------------------------------------------------------------------
    const aHist = await insertAssignmentRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uHistActive.app,
      effectiveFrom: dMinus30,
      effectiveTo: dMinus20,
      state: "REVOKED",
      isCurrent: false,
    });
    await insertObligationRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignmentId: aHist,
      assigneeAppUserId: uHistActive.app,
      periodDate: dMinus30,
      status: "ACTIVE",
    });
    await assertOracleParity(db, uHistActive, true, "historical ACTIVE obligation (>7d, revoked assignment)");

    // Submitted/completed ACTIVE obligation
    const aSub = await insertAssignmentRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uSubmittedActive.app,
      effectiveFrom: dMinus20,
      effectiveTo: dMinus20,
      state: "REVOKED",
      isCurrent: false,
    });
    const obSubId = await insertObligationRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignmentId: aSub,
      assigneeAppUserId: uSubmittedActive.app,
      periodDate: dMinus20,
      status: "ACTIVE",
    });
    await db.query(
      `insert into public.work_report_submissions (
         obligation_id, template_id, template_version_id, assignee_app_user_id,
         state, first_submitted_at, latest_submitted_at
       ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'APPROVED', now(), now())`,
      [obSubId, tplActive.templateId, tplActive.versionId, uSubmittedActive.app],
    );
    await assertOracleParity(db, uSubmittedActive, true, "existing ACTIVE obligation with APPROVED submission");

    // Existing ACTIVE obligation whose template is ARCHIVED
    const aArchExist = await insertAssignmentRow(db, {
      templateId: tplArchived.templateId,
      versionId: tplArchived.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uArchivedTplActive.app,
      effectiveFrom: dMinus20,
      effectiveTo: dMinus20,
      state: "REVOKED",
      isCurrent: false,
    });
    await insertObligationRow(db, {
      templateId: tplArchived.templateId,
      versionId: tplArchived.versionId,
      assignmentId: aArchExist,
      assigneeAppUserId: uArchivedTplActive.app,
      periodDate: dMinus20,
      status: "ACTIVE",
    });
    await assertOracleParity(db, uArchivedTplActive, true, "existing ACTIVE obligation on ARCHIVED template");

    // -------------------------------------------------------------------------
    // (c) Unmaterialized valid assignments: USER, USER_SET, TEAM, GROUP
    // -------------------------------------------------------------------------
    await insertAssignmentRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uDirectTarget.app,
      effectiveFrom: today,
    });
    // Negative READ ONLY harness proof: work_report_list_my_obligations MUST fail with 25006 inside READ ONLY
    await db.query("begin transaction read only");
    try {
      await db.query("set local role service_role");
      await assert.rejects(
        db.query("select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE')", [
          uDirectTarget.auth,
          uDirectTarget.app,
        ]),
        (err) => err?.code === "25006" || /read-only/i.test(String(err?.message)),
        "legacy list_my_obligations must fail inside READ ONLY transaction when unmaterialized",
      );
    } finally {
      await db.query("rollback");
    }
    await assertOracleParity(db, uDirectTarget, true, "unmaterialized USER assignment");
    await assertOracleParity(db, uDirectOther, false, "untargeted user");

    // USER_SET
    await insertAssignmentRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER_SET",
      userSetIds: [uSetMember.app],
      effectiveFrom: today,
    });
    await assertOracleParity(db, uSetMember, true, "unmaterialized USER_SET member");
    await assertOracleParity(db, uSetNonMember, false, "USER_SET non-member");

    // TEAM
    await insertAssignmentRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignedByUserId: admin.app,
      targetKind: "TEAM",
      targetTeamId: teamA,
      effectiveFrom: today,
    });
    await assertOracleParity(db, uTeamValid, true, "unmaterialized TEAM verified current member");
    await assertOracleParity(db, uTeamUnverified, false, "TEAM unverified recruiter link");
    await assertOracleParity(db, uTeamEndedLink, false, "TEAM ended recruiter link");
    await assertOracleParity(db, uTeamOther, false, "TEAM member of different team");

    // GROUP (isolated on teamC/teamD so TEAM A assignment cannot interfere)
    const tplGroup = await createPublishedTemplate(db, admin, "WP8D_GRP");
    const grpActive = nextUuid("68d00000");
    const grpInactive = nextUuid("68d00000");
    const grpOutOfScope = nextUuid("68d00000");
    await db.query(
      `insert into public.work_report_groups (group_id, display_name, active, created_by_user_id, updated_by_user_id)
       values ($1::uuid, 'WP8D Active Group', true, $4::uuid, $4::uuid),
              ($2::uuid, 'WP8D Inactive Group', false, $4::uuid, $4::uuid),
              ($3::uuid, 'WP8D OutOfScope Group', true, $5::uuid, $5::uuid)`,
      [grpActive, grpInactive, grpOutOfScope, admin.app, leaderC.app],
    );
    await db.query(
      `insert into public.work_report_group_members (group_id, member_user_id, added_by_user_id)
       values ($1::uuid, $2::uuid, $6::uuid),
              ($1::uuid, $3::uuid, $6::uuid),
              ($4::uuid, $5::uuid, $6::uuid),
              ($7::uuid, $8::uuid, $9::uuid),
              ($7::uuid, $10::uuid, $9::uuid)`,
      [
        grpActive, uGroupEligible.app, uGroupIneligible.app,
        grpInactive, uGroupInactive.app, admin.app,
        grpOutOfScope, uGroupScopeMemberA.app, leaderC.app, uGroupScopeOutB.app,
      ],
    );
    await insertAssignmentRow(db, {
      templateId: tplGroup.templateId,
      versionId: tplGroup.versionId,
      assignedByUserId: admin.app,
      targetKind: "GROUP",
      targetGroupId: grpActive,
      effectiveFrom: today,
    });
    await insertAssignmentRow(db, {
      templateId: tplGroup.templateId,
      versionId: tplGroup.versionId,
      assignedByUserId: admin.app,
      targetKind: "GROUP",
      targetGroupId: grpInactive,
      effectiveFrom: today,
    });
    await insertAssignmentRow(db, {
      templateId: tplGroup.templateId,
      versionId: tplGroup.versionId,
      assignedByUserId: leaderC.app,
      targetKind: "GROUP",
      targetGroupId: grpOutOfScope,
      effectiveFrom: today,
    });
    await assertOracleParity(db, uGroupEligible, true, "unmaterialized GROUP active & eligible member");
    await assertOracleParity(db, uGroupNonMember, false, "GROUP non-member");
    await assertOracleParity(db, uGroupInactive, false, "GROUP inactive group");
    await assertOracleParity(db, uGroupIneligible, false, "GROUP ineligible member (recruiter link without current team)");
    await assertOracleParity(
      db,
      uGroupScopeMemberA,
      false,
      "GROUP fails closed when another group member is outside assigner scope",
    );

    // -------------------------------------------------------------------------
    // (d) DRAFT / ARCHIVED template, PAUSED / REVOKED, future / expired / inside-7d
    // -------------------------------------------------------------------------
    await insertAssignmentRow(db, {
      templateId: tplDraft.templateId,
      versionId: tplDraft.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uDraftTpl.app,
      effectiveFrom: today,
    });
    await assertOracleParity(db, uDraftTpl, false, "assignment on DRAFT template");

    await insertAssignmentRow(db, {
      templateId: tplArchived.templateId,
      versionId: tplArchived.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uArchivedTplUnmat.app,
      effectiveFrom: today,
    });
    await assertOracleParity(db, uArchivedTplUnmat, false, "unmaterialized assignment on ARCHIVED template");

    await insertAssignmentRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uPausedAssign.app,
      effectiveFrom: today,
      state: "PAUSED",
    });
    await assertOracleParity(db, uPausedAssign, false, "PAUSED assignment");

    await insertAssignmentRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uRevokedAssign.app,
      effectiveFrom: today,
      state: "REVOKED",
      isCurrent: false,
    });
    await assertOracleParity(db, uRevokedAssign, false, "REVOKED assignment");

    await insertAssignmentRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uFutureAssign.app,
      effectiveFrom: dPlus1,
    });
    await assertOracleParity(db, uFutureAssign, false, "future assignment (effective_from = today + 1)");

    await insertAssignmentRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uExpiredAssign.app,
      effectiveFrom: dMinus20,
      effectiveTo: dMinus8,
    });
    await assertOracleParity(db, uExpiredAssign, false, "expired assignment outside 7-day lookback (effective_to = today - 8)");

    await insertAssignmentRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uRecentEndAssign.app,
      effectiveFrom: dMinus20,
      effectiveTo: dMinus6,
    });
    await assertOracleParity(db, uRecentEndAssign, true, "assignment ended on 7-day lookback boundary (effective_to = today - 6)");

    // -------------------------------------------------------------------------
    // (e) ONCE frequency edge cases
    // -------------------------------------------------------------------------
    await insertAssignmentRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uOnceToday.app,
      frequency: "ONCE",
      effectiveFrom: today,
    });
    await assertOracleParity(db, uOnceToday, true, "unmaterialized ONCE effective_from = today");

    await insertAssignmentRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uOnceOldStart.app,
      frequency: "ONCE",
      effectiveFrom: dMinus20,
      effectiveTo: null,
    });
    await assertOracleParity(db, uOnceOldStart, true, "unmaterialized ONCE effective_from < window_start with null effective_to");

    await insertAssignmentRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uOnceFuture.app,
      frequency: "ONCE",
      effectiveFrom: dPlus1,
    });
    await assertOracleParity(db, uOnceFuture, false, "unmaterialized ONCE in the future");

    const aOnceEx = await insertAssignmentRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uOnceExempted.app,
      frequency: "ONCE",
      effectiveFrom: today,
    });
    await insertObligationRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignmentId: aOnceEx,
      assigneeAppUserId: uOnceExempted.app,
      periodType: "ONCE",
      periodDate: today,
      status: "EXEMPTED",
    });
    await assertOracleParity(db, uOnceExempted, false, "ONCE already materialized as EXEMPTED");

    // ONCE revoked (cancelled unsubmitted) + replacement ONCE active -> true!
    const aOnceOld = await insertAssignmentRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uOnceReactivate.app,
      frequency: "ONCE",
      effectiveFrom: today,
      state: "REVOKED",
      isCurrent: false,
    });
    const obOnceReactivateId = await insertObligationRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignmentId: aOnceOld,
      assigneeAppUserId: uOnceReactivate.app,
      periodType: "ONCE",
      periodDate: today,
      status: "CANCELLED",
    });
    await insertAssignmentRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uOnceReactivate.app,
      frequency: "ONCE",
      effectiveFrom: today,
      state: "ACTIVE",
      isCurrent: true,
    });
    await assertOracleParity(db, uOnceReactivate, true, "ONCE CANCELLED unsubmitted + replacement ONCE active (exact ONCE-YYYY-MM-DD key)");

    // ONCE revoked with EXEMPTED row + active replacement ONCE on same ONCE-YYYY-MM-DD key -> false
    const aOnceExOld = await insertAssignmentRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uOnceReplaceExempted.app,
      frequency: "ONCE",
      effectiveFrom: today,
      state: "REVOKED",
      isCurrent: false,
    });
    await insertObligationRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignmentId: aOnceExOld,
      assigneeAppUserId: uOnceReplaceExempted.app,
      periodType: "ONCE",
      periodDate: today,
      status: "EXEMPTED",
    });
    await insertAssignmentRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uOnceReplaceExempted.app,
      frequency: "ONCE",
      effectiveFrom: today,
      state: "ACTIVE",
      isCurrent: true,
    });
    await assertOracleParity(db, uOnceReplaceExempted, false, "ONCE EXEMPTED on revoked assignment + active replacement ONCE on same key");

    // ONCE revoked with submitted CANCELLED row + active replacement ONCE on same ONCE-YYYY-MM-DD key -> false
    const aOnceSubOld = await insertAssignmentRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uOnceReplaceSubmitted.app,
      frequency: "ONCE",
      effectiveFrom: today,
      state: "REVOKED",
      isCurrent: false,
    });
    const obOnceSubOldId = await insertObligationRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignmentId: aOnceSubOld,
      assigneeAppUserId: uOnceReplaceSubmitted.app,
      periodType: "ONCE",
      periodDate: today,
      status: "CANCELLED",
    });
    await db.query(
      `insert into public.work_report_submissions (
         obligation_id, template_id, template_version_id, assignee_app_user_id,
         state, first_submitted_at, latest_submitted_at
       ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'COMPLETED', now(), now())`,
      [obOnceSubOldId, tplOnce.templateId, tplOnce.versionId, uOnceReplaceSubmitted.app],
    );
    await insertAssignmentRow(db, {
      templateId: tplOnce.templateId,
      versionId: tplOnce.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uOnceReplaceSubmitted.app,
      frequency: "ONCE",
      effectiveFrom: today,
      state: "ACTIVE",
      isCurrent: true,
    });
    await assertOracleParity(db, uOnceReplaceSubmitted, false, "ONCE submitted CANCELLED on revoked assignment + active replacement ONCE on same key");

    // -------------------------------------------------------------------------
    // (f) EXEMPTED vs CANCELLED (no-sub / draft-sub / submitted / no-replacement)
    // -------------------------------------------------------------------------
    const aExDaily = await insertAssignmentRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uExemptedDaily.app,
      frequency: "DAILY",
      effectiveFrom: today,
      effectiveTo: today,
    });
    await insertObligationRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignmentId: aExDaily,
      assigneeAppUserId: uExemptedDaily.app,
      periodDate: today,
      status: "EXEMPTED",
    });
    await assertOracleParity(db, uExemptedDaily, false, "EXEMPTED obligation with active assignment on same period");

    // CANCELLED (never submitted, no submission row) + active replacement -> true
    const aCanNoSubOld = await insertAssignmentRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uCancelledNoSub.app,
      effectiveFrom: today,
      effectiveTo: today,
      state: "REVOKED",
      isCurrent: false,
    });
    const obCanNoSubId = await insertObligationRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignmentId: aCanNoSubOld,
      assigneeAppUserId: uCancelledNoSub.app,
      periodDate: today,
      status: "CANCELLED",
    });
    await insertAssignmentRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uCancelledNoSub.app,
      effectiveFrom: today,
      effectiveTo: today,
      state: "ACTIVE",
      isCurrent: true,
    });
    await assertOracleParity(db, uCancelledNoSub, true, "CANCELLED unsubmitted (no sub row) + replacement active");

    // CANCELLED (DRAFT submission only, first_submitted_at is null) + active replacement -> true
    const aCanDraftOld = await insertAssignmentRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uCancelledDraftSub.app,
      effectiveFrom: today,
      effectiveTo: today,
      state: "REVOKED",
      isCurrent: false,
    });
    const obCanDraftId = await insertObligationRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignmentId: aCanDraftOld,
      assigneeAppUserId: uCancelledDraftSub.app,
      periodDate: today,
      status: "CANCELLED",
    });
    await db.query(
      `insert into public.work_report_submissions (
         obligation_id, template_id, template_version_id, assignee_app_user_id,
         state, first_submitted_at, latest_submitted_at
       ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DRAFT', null, null)`,
      [obCanDraftId, tplCancel.templateId, tplCancel.versionId, uCancelledDraftSub.app],
    );
    await insertAssignmentRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uCancelledDraftSub.app,
      effectiveFrom: today,
      effectiveTo: today,
      state: "ACTIVE",
      isCurrent: true,
    });
    await assertOracleParity(db, uCancelledDraftSub, true, "CANCELLED with DRAFT (first_submitted_at null) + replacement active");

    // CANCELLED (already submitted: first_submitted_at is not null) + active replacement -> false
    const aCanSubOld = await insertAssignmentRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uCancelledSubmitted.app,
      effectiveFrom: today,
      effectiveTo: today,
      state: "REVOKED",
      isCurrent: false,
    });
    const obCanSubId = await insertObligationRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignmentId: aCanSubOld,
      assigneeAppUserId: uCancelledSubmitted.app,
      periodDate: today,
      status: "CANCELLED",
    });
    await db.query(
      `insert into public.work_report_submissions (
         obligation_id, template_id, template_version_id, assignee_app_user_id,
         state, first_submitted_at, latest_submitted_at
       ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'COMPLETED', now(), now())`,
      [obCanSubId, tplCancel.templateId, tplCancel.versionId, uCancelledSubmitted.app],
    );
    await insertAssignmentRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uCancelledSubmitted.app,
      effectiveFrom: today,
      effectiveTo: today,
      state: "ACTIVE",
      isCurrent: true,
    });
    await assertOracleParity(db, uCancelledSubmitted, false, "CANCELLED already submitted (first_submitted_at not null) + replacement active");

    // CANCELLED unsubmitted WITHOUT replacement -> false
    const aCanOnly = await insertAssignmentRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uCancelledNoReplace.app,
      effectiveFrom: today,
      effectiveTo: today,
      state: "REVOKED",
      isCurrent: false,
    });
    await insertObligationRow(db, {
      templateId: tplCancel.templateId,
      versionId: tplCancel.versionId,
      assignmentId: aCanOnly,
      assigneeAppUserId: uCancelledNoReplace.app,
      periodDate: today,
      status: "CANCELLED",
    });
    await assertOracleParity(db, uCancelledNoReplace, false, "CANCELLED unsubmitted with revoked assignment only");

    // -------------------------------------------------------------------------
    // (g) 7-day lookback window exact edges & session TimeZone invariance (VN TZ)
    // -------------------------------------------------------------------------
    await insertAssignmentRow(db, {
      templateId: tplBoundary.templateId,
      versionId: tplBoundary.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uWindowBoundary.app,
      effectiveFrom: "2026-11-10",
      effectiveTo: "2026-11-12",
    });
    const boundaryChecks = [
      ["2026-11-09", false, "effective_from - 1"],
      ["2026-11-10", true, "effective_from"],
      ["2026-11-12", true, "effective_to"],
      ["2026-11-18", true, "effective_to + 6 (exact 7-day lookback inclusive)"],
      ["2026-11-19", false, "effective_to + 7 (outside 7-day lookback)"],
    ];
    for (const [bDate, expected, label] of boundaryChecks) {
      await db.query("begin transaction read only");
      const { rows: [{ probe_val }] } = await db.query(
        "select public.work_report__internal_has_active_obligations_for_date($1::uuid, $2::date, 7) as probe_val",
        [uWindowBoundary.app, bDate],
      );
      await db.query("commit");

      await db.query("begin");
      await db.query(
        "select public.work_report__internal_materialize_actor_obligations($1::uuid, $2::date, 7)",
        [uWindowBoundary.app, bDate],
      );
      const { rows: [{ has_active }] } = await db.query(
        "select exists (select 1 from public.work_report_obligations where assignee_app_user_id = $1::uuid and obligation_status = 'ACTIVE') as has_active",
        [uWindowBoundary.app],
      );
      await db.query("rollback");

      assert.equal(probe_val, has_active, `7-day boundary (${label}): probe must equal rolled-back materializer`);
      assert.equal(probe_val, expected, `7-day boundary (${label}): expected ${expected}`);
    }

    // WEEKLY (with exclude_sundays=true) & MONTHLY crossing the 7-day lookback window:
    // On 2026-11-04 (Wed), lookback [2026-10-29 .. 2026-11-04] spans ISO weeks 2026-W44 and 2026-W45
    // AND calendar months 2026-10 and 2026-11.
    const aWeekly = await insertAssignmentRow(db, {
      templateId: tplBoundary.templateId,
      versionId: tplBoundary.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uWeeklyCross.app,
      frequency: "WEEKLY",
      excludeSundays: true,
      effectiveFrom: "2026-10-26",
    });
    const { rows: [wkCurr] } = await db.query(
      "select period_key, period_start_date::text as start_d from public.work_report_period('WEEKLY', '2026-11-04'::date)",
    );
    const { rows: [wkPrev] } = await db.query(
      "select period_key, period_start_date::text as start_d from public.work_report_period('WEEKLY', '2026-10-29'::date)",
    );
    await insertObligationRow(db, {
      templateId: tplBoundary.templateId,
      versionId: tplBoundary.versionId,
      assignmentId: aWeekly,
      assigneeAppUserId: uWeeklyCross.app,
      periodType: "WEEKLY",
      periodDate: wkCurr.start_d,
      periodKey: wkCurr.period_key,
      status: "EXEMPTED",
    });
    const checkDateOracle = async (user, bDate, expected, label) => {
      await db.query("begin transaction read only");
      const { rows: [{ probe_val }] } = await db.query(
        "select public.work_report__internal_has_active_obligations_for_date($1::uuid, $2::date, 7) as probe_val",
        [user.app, bDate],
      );
      await db.query("commit");
      await db.query("begin");
      await db.query(
        "select public.work_report__internal_materialize_actor_obligations($1::uuid, $2::date, 7)",
        [user.app, bDate],
      );
      const { rows: [{ has_active }] } = await db.query(
        "select exists (select 1 from public.work_report_obligations where assignee_app_user_id = $1::uuid and obligation_status = 'ACTIVE') as has_active",
        [user.app],
      );
      await db.query("rollback");
      assert.equal(probe_val, has_active, `${label}: probe must match rolled-back materializer`);
      assert.equal(probe_val, expected, `${label}: expected ${expected}`);
    };
    await checkDateOracle(
      uWeeklyCross,
      "2026-11-04",
      true,
      "WEEKLY exclude_sundays=true with current week EXEMPTED and prior in-window week unmaterialized",
    );
    await insertObligationRow(db, {
      templateId: tplBoundary.templateId,
      versionId: tplBoundary.versionId,
      assignmentId: aWeekly,
      assigneeAppUserId: uWeeklyCross.app,
      periodType: "WEEKLY",
      periodDate: wkPrev.start_d,
      periodKey: wkPrev.period_key,
      status: "EXEMPTED",
    });
    await checkDateOracle(
      uWeeklyCross,
      "2026-11-04",
      false,
      "WEEKLY exclude_sundays=true with both in-window weeks EXEMPTED",
    );

    const aMonthly = await insertAssignmentRow(db, {
      templateId: tplBoundary.templateId,
      versionId: tplBoundary.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uMonthlyCross.app,
      frequency: "MONTHLY",
      effectiveFrom: "2026-10-01",
    });
    await insertObligationRow(db, {
      templateId: tplBoundary.templateId,
      versionId: tplBoundary.versionId,
      assignmentId: aMonthly,
      assigneeAppUserId: uMonthlyCross.app,
      periodType: "MONTHLY",
      periodDate: "2026-11-01",
      periodKey: "2026-11",
      status: "EXEMPTED",
    });
    await checkDateOracle(
      uMonthlyCross,
      "2026-11-02",
      true,
      "MONTHLY crossing month boundary: 2026-11 EXEMPTED but 2026-10 still unmaterialized in 7-day window",
    );
    await insertObligationRow(db, {
      templateId: tplBoundary.templateId,
      versionId: tplBoundary.versionId,
      assignmentId: aMonthly,
      assigneeAppUserId: uMonthlyCross.app,
      periodType: "MONTHLY",
      periodDate: "2026-10-01",
      periodKey: "2026-10",
      status: "EXEMPTED",
    });
    await checkDateOracle(
      uMonthlyCross,
      "2026-11-02",
      false,
      "MONTHLY crossing month boundary: both 2026-10 and 2026-11 EXEMPTED",
    );

    // Session TimeZone invariance (Vietnam Asia/Ho_Chi_Minh date used regardless of session TZ)
    for (const tz of ["UTC", "America/New_York", "Asia/Ho_Chi_Minh"]) {
      await db.query(`set time zone '${tz}'`);
      await assertOracleParity(db, uDirectTarget, true, `session TimeZone=${tz} parity (today)`);
      await assertOracleParity(db, uFutureAssign, false, `session TimeZone=${tz} parity (tomorrow)`);
    }
    await db.query("set time zone 'UTC'");

    // -------------------------------------------------------------------------
    // (h) Actor auth/authz parity: wrong auth_subject, unknown user, NULL, disabled user
    // -------------------------------------------------------------------------
    const aDisabled = await insertAssignmentRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignedByUserId: admin.app,
      targetKind: "USER",
      targetUserId: uDisabledWithActive.app,
      effectiveFrom: dMinus1,
    });
    await insertObligationRow(db, {
      templateId: tplActive.templateId,
      versionId: tplActive.versionId,
      assignmentId: aDisabled,
      assigneeAppUserId: uDisabledWithActive.app,
      periodDate: dMinus1,
      status: "ACTIVE",
    });

    const deniedCases = [
      ["mismatched auth_subject", { auth: nextUuid(), app: uDirectTarget.app }],
      ["unknown app_user_id", { auth: uDirectTarget.auth, app: nextUuid() }],
      ["null auth_subject", { auth: null, app: uDirectTarget.app }],
      ["null app_user_id", { auth: uDirectTarget.auth, app: null }],
      ["disabled user with ACTIVE obligation", uDisabledWithActive],
    ];
    for (const [label, badActor] of deniedCases) {
      await assert.rejects(
        runReadOnlyProbe(db, badActor),
        (err) => err?.code === "42501" && /WORK_REPORT_ACTOR_DENIED/.test(String(err?.message)),
        `${label}: probe must raise 42501 WORK_REPORT_ACTOR_DENIED`,
      );
      await assert.rejects(
        runOracleListActive(db, badActor),
        (err) => err?.code === "42501" && /WORK_REPORT_ACTOR_DENIED/.test(String(err?.message)),
        `${label}: list_my_obligations raises matching 42501 WORK_REPORT_ACTOR_DENIED`,
      );
    }

    // -------------------------------------------------------------------------
    // (i) Business endpoint materialization regression
    // -------------------------------------------------------------------------
    // Confirm uDirectTarget still has 0 materialized rows after all probes above
    const { rows: beforeMat } = await db.query(
      "select obligation_id from public.work_report_obligations where assignee_app_user_id = $1::uuid",
      [uDirectTarget.app],
    );
    assert.equal(beforeMat.length, 0, "probe calls created zero obligations for uDirectTarget");

    // Calling business RPC work_report_list_my_obligations DOES materialize & returns schema_json
    await db.query("begin");
    await db.query("set local role service_role");
    const { rows: [{ result: listPayload }] } = await db.query(
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as result",
      [uDirectTarget.auth, uDirectTarget.app],
    );
    await db.query("commit");
    assert.equal(listPayload.items.length, 1);
    assert.equal(listPayload.items[0].obligation_status, "ACTIVE");
    assert.ok(listPayload.items[0].schema_json?.sections?.length > 0, "business endpoint still returns schema_json");

    const { rows: afterMat } = await db.query(
      "select obligation_id, obligation_status from public.work_report_obligations where assignee_app_user_id = $1::uuid",
      [uDirectTarget.app],
    );
    assert.equal(afterMat.length, 1, "business endpoint materialized obligation into DB");
    assert.equal(afterMat[0].obligation_status, "ACTIVE");

    // Confirm business RPC reactivates unsubmitted CANCELLED obligation (preserving obligation_id & incrementing version)
    await db.query("begin");
    await db.query("set local role service_role");
    const { rows: [{ result: reactPayload }] } = await db.query(
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as result",
      [uCancelledNoSub.auth, uCancelledNoSub.app],
    );
    await db.query("commit");
    assert.equal(reactPayload.items.length, 1);
    assert.equal(reactPayload.items[0].obligation_id, obCanNoSubId);
    assert.equal(reactPayload.items[0].obligation_status, "ACTIVE");
    assert.equal(reactPayload.items[0].version, 2, "reactivated row increments OCC version");

    // Confirm business RPC reactivates unsubmitted CANCELLED ONCE obligation in-place (preserving obligation_id & version=2)
    await db.query("begin");
    await db.query("set local role service_role");
    const { rows: [{ result: onceReactPayload }] } = await db.query(
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as result",
      [uOnceReactivate.auth, uOnceReactivate.app],
    );
    await db.query("commit");
    assert.equal(onceReactPayload.items.length, 1);
    assert.equal(onceReactPayload.items[0].obligation_id, obOnceReactivateId, "ONCE reactivation preserves existing row");
    assert.equal(onceReactPayload.items[0].obligation_status, "ACTIVE");
    assert.equal(onceReactPayload.items[0].version, 2, "ONCE reactivated row increments OCC version");

    // Confirm business RPC does NOT reactivate submitted CANCELLED or EXEMPTED rows
    await db.query("begin");
    await db.query("set local role service_role");
    const { rows: [{ result: subCanRes }] } = await db.query(
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as result",
      [uCancelledSubmitted.auth, uCancelledSubmitted.app],
    );
    const { rows: [{ result: exRes }] } = await db.query(
      "select public.work_report_list_my_obligations($1::uuid, $2::uuid, 'ACTIVE') as result",
      [uExemptedDaily.auth, uExemptedDaily.app],
    );
    await db.query("commit");
    assert.equal(subCanRes.items.length, 0, "submitted CANCELLED stays CANCELLED");
    assert.equal(exRes.items.length, 0, "EXEMPTED stays EXEMPTED");
  } finally {
    await db.close();
  }
});
