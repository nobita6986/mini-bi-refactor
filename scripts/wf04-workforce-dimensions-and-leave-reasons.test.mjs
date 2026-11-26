/**
 * MBI-DA-2026-01 Chặng 2 / WF-04 (Items 2.7 & 2.8): Ephemeral PGlite database integration test
 * for `public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)` covering:
 *   - 2.7 Dimensional Quality by Recruiter / Team / HRP-Vendor / Project (including inactive teams & unknown buckets)
 *   - 2.8 Leave Reason Analysis (standardized categories, unclassified free-text, missing reason, supersession, period OFF events, and zero raw text leak)
 *   - 100% parity between the PostgreSQL RPC and the pure TypeScript evaluator `evaluateWorkforceSnapshotAndTransitions`
 *   - Scope isolation (`all`, `team`, `own`) and SECURITY DEFINER / ACL boundary checks.
 *
 * Applies all local migrations in `supabase/migrations` from scratch in an isolated
 * in-memory PGlite database; never connects to staging, TEST, or Production.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";
import {
  deriveWorkforceAttentionInsights,
  evaluateWorkforceSnapshotAndTransitions,
  parseWorkforceOverviewPayload,
  parseWorkforceReportingPayload,
  resolveWorkforceDeepReportingForActor,
  resolveWorkforceOverviewForActor,
  resolveWorkforceProjectPageForActor,
  resolveWorkforceReportingForActor,
} from "../src/lib/reporting/wf04-workforce-dimensions-leave-reasons.ts";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const OMITTED = { state: "omitted" };
function workerDetails(name) {
  return {
    display_name: name,
    date_of_birth: OMITTED,
    national_id: OMITTED,
    address: OMITTED,
    phone: OMITTED,
  };
}

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql") && n <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

async function insertEntry(
  db,
  {
    entry,
    sub,
    cand,
    createdBy,
    project,
    date,
    code,
    recruiter,
    team,
    provider = "hrp",
    labor = "TEMPORARY",
    submit = true,
  },
) {
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [cand]);
    await db.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1,$2,'DRAFT')",
      [sub, createdBy],
    );
    await db.query(
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id, project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type) " +
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        entry,
        sub,
        cand,
        createdBy,
        project,
        date,
        code,
        JSON.stringify(workerDetails("Worker " + code)),
        recruiter,
        team,
        provider,
        labor,
      ],
    );
    if (submit) {
      await seedLegacyReviewSubmission(db, sub);
      await db.query(
        "update public.direct_entry_submissions set state='SUBMITTED', version=3 where submission_id=$1",
        [sub],
      );
    }
    await db.exec("commit");
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

test("WF-04 ephemeral DB integration: 2.7 dimensional quality, 2.8 leave reasons, inactive team attribution, supersession, scopes, and 100% TS parity", async () => {
  const db = await buildDb();
  try {
    const AUTH_BOD = uuid(1);
    const USER_BOD = uuid(11);
    const AUTH_LEAD_A = uuid(2);
    const USER_LEAD_A = uuid(12);
    const AUTH_REC_A1 = uuid(3);
    const USER_REC_A1 = uuid(13);

    const TEAM_A_ID = uuid(21);
    const TEAM_B_ID = uuid(22);

    const REC_A1_ID = uuid(31);
    const REC_A2_ID = uuid(32);
    const REC_B1_ID = uuid(33);
    const REC_V1_ID = uuid(34);

    for (const u of [AUTH_BOD, AUTH_LEAD_A, AUTH_REC_A1]) {
      await db.query("insert into auth.users (id) values ($1)", [u]);
    }
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name) values " +
        "($1,$2,true,'BoD'), ($3,$4,true,'Lead A'), ($5,$6,true,'Rec A1')",
      [USER_BOD, AUTH_BOD, USER_LEAD_A, AUTH_LEAD_A, USER_REC_A1, AUTH_REC_A1],
    );
    await db.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1,'TEAM_A','Team Alpha',true), ($2,'TEAM_B','Team Beta Legacy',true)",
      [TEAM_A_ID, TEAM_B_ID],
    );
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1,'Rec A1'), ($2,'Rec A2'), ($3,'Rec B1'), ($4,'Vendor V1')",
      [REC_A1_ID, REC_A2_ID, REC_B1_ID, REC_V1_ID],
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)",
      [USER_REC_A1, REC_A1_ID],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values " +
        "($1,'hrp','2020-01-01',true), ($2,'hrp','2020-01-01',true), ($3,'hrp','2020-01-01',true), ($4,'vendor','2020-01-01',true)",
      [REC_A1_ID, REC_A2_ID, REC_B1_ID, REC_V1_ID],
    );
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values " +
        "($1,$4,'2020-01-01',true), ($2,$4,'2020-01-01',true), ($3,$5,'2020-01-01',true)",
      [REC_A1_ID, REC_A2_ID, REC_B1_ID, TEAM_A_ID, TEAM_B_ID],
    );
    await db.query(
      "insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from) values " +
        "($1,'rec a1','2020-01-01'), ($2,'rec a2','2020-01-01'), ($3,'rec b1','2020-01-01'), ($4,'vendor v1','2020-01-01')",
      [REC_A1_ID, REC_A2_ID, REC_B1_ID, REC_V1_ID],
    );
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ('proj_a','Project Alpha'), ('proj_b','Project Beta')",
    );
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values " +
        "($1,'all',null,'2020-01-01',true), ($2,'team',$4,'2020-01-01',true), ($3,'own',null,'2020-01-01',true)",
      [USER_BOD, USER_LEAD_A, USER_REC_A1, TEAM_A_ID],
    );
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values " +
        "($1,'entry_admin','2020-01-01',true), ($2,'entry_team','2020-01-01',true), ($3,'entry_own','2020-01-01',true)",
      [USER_BOD, USER_LEAD_A, USER_REC_A1],
    );

    const REASON_ID = uuid(99);
    await db.query(
      "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1, $2, 'WF-04 test fixture')",
      [REASON_ID, USER_BOD],
    );

    const EP_1 = uuid(101); // Team A, Rec A1, proj_a, hrp: ON 2026-06-01 -> still ON at 2026-10-15
    const EP_2 = uuid(102); // Team A, Rec A1, proj_a, hrp: ON 2026-06-01 -> OFF 2026-10-05 (superseded 'Lương thấp') -> OFF 2026-10-05 ('Về quê chăm con nhỏ' => personal_or_family)
    const EP_3 = uuid(103); // Team A, Rec A2, proj_a, hrp: UNCONFIRMED 2026-09-10 -> ON 2026-09-15 -> OFF 2026-10-08 ('Bị ốm phải nằm viện' => health)
    const EP_4 = uuid(104); // Team B (later deactivated!), Rec B1, proj_b, hrp: UNCONFIRMED 2026-10-02 -> OFF 2026-10-09 ('Nhà xa không có xe đưa đón' => relocation_or_distance, fromUnconfirmedWithoutOn)
    const EP_5 = uuid(105); // Team B, Rec B1, proj_b, hrp: ON 2026-09-20 -> OFF 2026-10-11 ('Ghi chú riêng ngoài từ khóa' => unclassified_free_text)
    const EP_6 = uuid(106); // Team A, Rec A2, proj_b, hrp: ON 2026-09-25 -> OFF 2026-10-12 (null reason => missing_or_unknown)
    const EP_7 = uuid(107); // Team A, Rec A1, proj_a, hrp: UNCONFIRMED 2026-10-10 (currently waiting)
    const EP_8 = uuid(108); // No team (unknown team bucket), Vendor V1, proj_b, vendor: ON 2026-10-01 -> OFF 2026-10-04 ('Chê lương thấp' => compensation_or_benefits) -> ON 2026-10-07 (currently ON at 10-15, but OFF transition is in period!)

    const { rows: reservedRows } = await db.query(
      "select public.direct_entry_system_vendor_team_id() as team_id",
    );
    const RESERVED_VENDOR_TEAM_ID = reservedRows[0].team_id;

    const entriesToInsert = [
      { entry: EP_1, sub: uuid(201), cand: uuid(301), project: "proj_a", date: "2026-06-01", code: "hrp-2026-000401", recruiter: REC_A1_ID, team: TEAM_A_ID, provider: "hrp" },
      { entry: EP_2, sub: uuid(202), cand: uuid(302), project: "proj_a", date: "2026-06-01", code: "hrp-2026-000402", recruiter: REC_A1_ID, team: TEAM_A_ID, provider: "hrp" },
      { entry: EP_3, sub: uuid(203), cand: uuid(303), project: "proj_a", date: "2026-09-10", code: "hrp-2026-000403", recruiter: REC_A2_ID, team: TEAM_A_ID, provider: "hrp" },
      { entry: EP_4, sub: uuid(204), cand: uuid(304), project: "proj_b", date: "2026-10-02", code: "hrp-2026-000404", recruiter: REC_B1_ID, team: TEAM_B_ID, provider: "hrp" },
      { entry: EP_5, sub: uuid(205), cand: uuid(305), project: "proj_b", date: "2026-09-20", code: "hrp-2026-000405", recruiter: REC_B1_ID, team: TEAM_B_ID, provider: "hrp" },
      { entry: EP_6, sub: uuid(206), cand: uuid(306), project: "proj_b", date: "2026-09-25", code: "hrp-2026-000406", recruiter: REC_A2_ID, team: TEAM_A_ID, provider: "hrp" },
      { entry: EP_7, sub: uuid(207), cand: uuid(307), project: "proj_a", date: "2026-10-10", code: "hrp-2026-000407", recruiter: REC_A1_ID, team: TEAM_A_ID, provider: "hrp" },
      { entry: EP_8, sub: uuid(208), cand: uuid(308), project: "proj_b", date: "2026-10-01", code: "hrp-2026-000408", recruiter: REC_V1_ID, team: RESERVED_VENDOR_TEAM_ID, provider: "vendor" },
    ];

    for (const item of entriesToInsert) {
      await insertEntry(db, { ...item, createdBy: USER_BOD });
    }

    // Now deactivate TEAM_B after historical entries were submitted so TEAM_B is inactive (`active = false`)
    await db.query("update public.teams set active = false where team_id = $1", [TEAM_B_ID]);

    const statusEvents = [
      { event_id: uuid(501), entry_id: EP_1, status: "ON", effective_date: "2026-06-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },

      { event_id: uuid(511), entry_id: EP_2, status: "ON", effective_date: "2026-06-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(512), entry_id: EP_2, status: "OFF", effective_date: "2026-10-03", leave_date: "2026-10-03", reason: "Chê lương thấp", version: 2, supersedes_event_id: null },
      { event_id: uuid(513), entry_id: EP_2, status: "ON", effective_date: "2026-10-03", leave_date: null, reason: null, version: 3, supersedes_event_id: uuid(512) },
      { event_id: uuid(514), entry_id: EP_2, status: "OFF", effective_date: "2026-10-05", leave_date: "2026-10-05", reason: "Về quê chăm con nhỏ", version: 4, supersedes_event_id: null },

      { event_id: uuid(521), entry_id: EP_3, status: "UNCONFIRMED", effective_date: "2026-09-10", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(522), entry_id: EP_3, status: "ON", effective_date: "2026-09-15", leave_date: null, reason: null, version: 2, supersedes_event_id: null },
      { event_id: uuid(523), entry_id: EP_3, status: "OFF", effective_date: "2026-10-08", leave_date: "2026-10-08", reason: "Bị ốm phải nằm viện", version: 3, supersedes_event_id: null },

      { event_id: uuid(531), entry_id: EP_4, status: "UNCONFIRMED", effective_date: "2026-10-02", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(532), entry_id: EP_4, status: "OFF", effective_date: "2026-10-09", leave_date: "2026-10-09", reason: "Nhà xa không có xe đưa đón", version: 2, supersedes_event_id: null },

      { event_id: uuid(541), entry_id: EP_5, status: "ON", effective_date: "2026-09-20", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(542), entry_id: EP_5, status: "OFF", effective_date: "2026-10-11", leave_date: "2026-10-11", reason: "Ghi chú riêng ngoài từ khóa", version: 2, supersedes_event_id: null },

      { event_id: uuid(551), entry_id: EP_6, status: "ON", effective_date: "2026-09-25", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(552), entry_id: EP_6, status: "OFF", effective_date: "2026-10-12", leave_date: "2026-10-12", reason: "Chưa rõ lý do", version: 2, supersedes_event_id: null },

      { event_id: uuid(561), entry_id: EP_7, status: "UNCONFIRMED", effective_date: "2026-10-10", leave_date: null, reason: null, version: 1, supersedes_event_id: null },

      { event_id: uuid(571), entry_id: EP_8, status: "ON", effective_date: "2026-10-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(572), entry_id: EP_8, status: "OFF", effective_date: "2026-10-04", leave_date: "2026-10-04", reason: "Chê lương thấp", version: 2, supersedes_event_id: null },
      { event_id: uuid(573), entry_id: EP_8, status: "ON", effective_date: "2026-10-07", leave_date: null, reason: null, version: 3, supersedes_event_id: null, legacyBypassGuard: true },
    ];

    for (const ev of statusEvents) {
      if (ev.legacyBypassGuard) {
        await db.exec("set session_replication_role = replica");
      }
      try {
        await db.query(
          `insert into public.direct_entry_employment_status_events (
             event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
             version, actor_user_id, reason_id, supersedes_event_id
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            ev.event_id,
            ev.entry_id,
            ev.status,
            ev.effective_date,
            ev.leave_date,
            ev.reason,
            ev.version,
            USER_BOD,
            REASON_ID,
            ev.supersedes_event_id,
          ],
        );
      } finally {
        if (ev.legacyBypassGuard) {
          await db.exec("set session_replication_role = origin");
        }
      }
    }

    const callRpc = async (authSubject, appUserId, filters) => {
      await db.exec("set role service_role");
      try {
        const { rows } = await db.query(
          "select public.direct_entry_workforce_reporting_scoped($1::uuid, $2::uuid, $3::jsonb) as payload",
          [authSubject, appUserId, JSON.stringify(filters)],
        );
        return rows[0].payload;
      } finally {
        await db.exec("reset role");
      }
    };

    const recruiterMeta = {
      [REC_A1_ID]: { key: "rec a1", display: "Rec A1" },
      [REC_A2_ID]: { key: "rec a2", display: "Rec A2" },
      [REC_B1_ID]: { key: "rec b1", display: "Rec B1" },
      [REC_V1_ID]: { key: "vendor v1", display: "Vendor V1" },
    };
    const teamMeta = {
      [TEAM_A_ID]: { code: "TEAM_A", display: "Team Alpha", active: true },
      [TEAM_B_ID]: { code: "TEAM_B", display: "Team Beta Legacy", active: false },
      [RESERVED_VENDOR_TEAM_ID]: { code: "__system_vendor__", display: "Vendor", active: true },
    };
    const projectMeta = {
      proj_a: { key: "project alpha", display: "Project Alpha" },
      proj_b: { key: "project beta", display: "Project Beta" },
    };

    const allEpisodesForTs = entriesToInsert.map((item) => ({
      entry_id: item.entry,
      first_work_date: item.date,
      submission_state: "SUBMITTED",
      deleted_at: null,
      voided_at: null,
      team_id: item.team,
      recruiter_id: item.recruiter,
      recruiter_key: recruiterMeta[item.recruiter].key,
      recruiter_display: recruiterMeta[item.recruiter].display,
      team_code: item.team ? teamMeta[item.team].code : null,
      team_display_name: item.team ? teamMeta[item.team].display : null,
      team_active: item.team ? teamMeta[item.team].active : null,
      provider_key: item.provider,
      project_key: projectMeta[item.project].key,
      project_display: projectMeta[item.project].display,
    }));

    const eventsForTs = statusEvents.map((ev) => ({
      event_id: ev.event_id,
      entry_id: ev.entry_id,
      status: ev.status,
      effective_date: ev.effective_date,
      leave_date: ev.leave_date,
      leave_reason_text: ev.reason,
      version: ev.version,
      supersedes_event_id: ev.supersedes_event_id,
    }));

    // 1. Verify 100% parity between DB RPC and pure TS across multiple windows for `all` scope:
    for (const [from, to] of [
      ["2026-09-01", "2026-09-30"],
      ["2026-10-01", "2026-10-15"],
    ]) {
      const dbRaw = await callRpc(AUTH_BOD, USER_BOD, { from, to });
      const parsed = parseWorkforceReportingPayload(dbRaw);
      assert.equal(parsed.status, "ready", `RPC payload for ${from}..${to} must be valid`);

      const tsExpected = evaluateWorkforceSnapshotAndTransitions({
        episodes: allEpisodesForTs,
        events: eventsForTs,
        filters: { from, to },
      });

      assert.deepEqual(parsed.snapshot, tsExpected.snapshot);
      assert.deepEqual(parsed.transitions, tsExpected.transitions);
      assert.deepEqual(parsed.balance, tsExpected.balance);
      assert.deepEqual(parsed.waiting, tsExpected.waiting);
      assert.deepEqual(parsed.duration, tsExpected.duration);
      assert.deepEqual(parsed.retention, tsExpected.retention);
      assert.deepEqual(parsed.dimensions, tsExpected.dimensions);
      assert.deepEqual(parsed.leaveReasons, tsExpected.leaveReasons);

      // Verify zero raw leave_reason_text leakage in DB JSON payload
      const rawJsonStr = JSON.stringify(dbRaw);
      assert.ok(!rawJsonStr.includes("Về quê chăm con nhỏ"));
      assert.ok(!rawJsonStr.includes("Ghi chú riêng ngoài từ khóa"));
      assert.ok(!rawJsonStr.includes("Nhà xa không có xe đưa đón"));
    }

    // 2. Assert exact WF-04 numbers on [2026-10-01 .. 2026-10-15] for `all` scope:
    const oct15 = parseWorkforceReportingPayload(
      await callRpc(AUTH_BOD, USER_BOD, { from: "2026-10-01", to: "2026-10-15" }),
    );
    assert.equal(oct15.status, "ready");
    if (oct15.status === "ready") {
      // Inactive team TEAM_B must preserve historical attribution and carry '(Ngừng hoạt động)'
      const teamB = oct15.dimensions.byTeam.buckets.find((b) => b.key === "team_b");
      assert.ok(teamB);
      assert.equal(teamB.active, false);
      assert.equal(teamB.display, "Team Beta Legacy (Ngừng hoạt động)");
      assert.equal(teamB.eligibleEpisodeCount, 2); // EP_4, EP_5

      const vendorTeam = oct15.dimensions.byTeam.buckets.find((b) => b.key === "__system_vendor__");
      assert.ok(vendorTeam);
      assert.equal(vendorTeam.display, "Vendor");
      assert.equal(vendorTeam.eligibleEpisodeCount, 1); // EP_8 (Vendor V1 on reserved vendor team)

      // Leave reasons at asOf 2026-10-15:
      // OFF episodes at 2026-10-15: EP_2 (personal_or_family), EP_3 (health), EP_4 (relocation_or_distance, fromUnconfirmed), EP_5 (unclassified_free_text), EP_6 (missing_or_unknown) => 5 total
      assert.equal(oct15.leaveReasons.offEpisodeTotal, 5);
      assert.equal(oct15.leaveReasons.withReasonEpisodeCount, 4);
      assert.equal(oct15.leaveReasons.standardizedEpisodeCount, 3);
      assert.equal(oct15.leaveReasons.unclassifiedFreeTextEpisodeCount, 1);
      assert.equal(oct15.leaveReasons.missingReasonEpisodeCount, 1);

      // Period leave reasons in [2026-10-01 .. 2026-10-15]:
      // Includes EP_2, EP_3, EP_4, EP_5, EP_6 AND EP_8's 2026-10-04 ON->OFF ('Chê lương thấp' => compensation_or_benefits)!
      assert.equal(oct15.leaveReasons.periodLeaveReasons.applicable, true);
      if (oct15.leaveReasons.periodLeaveReasons.applicable) {
        assert.equal(oct15.leaveReasons.periodLeaveReasons.offTransitionEventTotal, 6);
        assert.equal(oct15.leaveReasons.periodLeaveReasons.offTransitionEpisodeTotal, 6);
        assert.equal(oct15.leaveReasons.periodLeaveReasons.onToOffEventTotal, 5);
        assert.equal(oct15.leaveReasons.periodLeaveReasons.unconfirmedToOffEventTotal, 1);
      }

      const insights = deriveWorkforceAttentionInsights(oct15);
      assert.ok(insights.length >= 4);
    }

    // 3. Verify `team` scope (Lead A -> Team A only) and `own` scope (Rec A1 only):
    const teamRes = await resolveWorkforceReportingForActor({
      actor: { auth_subject: AUTH_LEAD_A, app_user_id: USER_LEAD_A },
      filters: { from: "2026-10-01", to: "2026-10-15" },
      expectedAudienceKind: "team",
      callWorkforceRpc: async (args) => ({
        data: await callRpc(args.p_auth_subject, args.p_app_user_id, args.p_filters),
      }),
    });
    assert.equal(teamRes.status, "ready");
    if (teamRes.status === "ready") {
      const teamEpisodes = allEpisodesForTs.filter((e) => e.team_id === TEAM_A_ID);
      const tsTeam = evaluateWorkforceSnapshotAndTransitions({
        episodes: teamEpisodes,
        events: eventsForTs,
        filters: { from: "2026-10-01", to: "2026-10-15" },
      });
      assert.deepEqual(teamRes.dimensions, tsTeam.dimensions);
      assert.deepEqual(teamRes.leaveReasons, tsTeam.leaveReasons);
    }

    const ownRes = await resolveWorkforceReportingForActor({
      actor: { auth_subject: AUTH_REC_A1, app_user_id: USER_REC_A1 },
      filters: { from: "2026-10-01", to: "2026-10-15" },
      expectedAudienceKind: "own",
      callWorkforceRpc: async (args) => ({
        data: await callRpc(args.p_auth_subject, args.p_app_user_id, args.p_filters),
      }),
    });
    assert.equal(ownRes.status, "ready");
    if (ownRes.status === "ready") {
      const ownEpisodes = allEpisodesForTs.filter((e) => e.recruiter_id === REC_A1_ID);
      const tsOwn = evaluateWorkforceSnapshotAndTransitions({
        episodes: ownEpisodes,
        events: eventsForTs,
        filters: { from: "2026-10-01", to: "2026-10-15" },
      });
      assert.deepEqual(ownRes.dimensions, tsOwn.dimensions);
      assert.deepEqual(ownRes.leaveReasons, tsOwn.leaveReasons);
    }

    // 4. WF-04 Post-Merge Hotfix:
    //    4a. `mode = 'overview'` returns ONLY snapshot (2.1) & transitions (2.2) for `all` scope,
    //        and never includes balance, waiting, duration, retention, dimensions, or leave_reasons:
    const overviewRaw = await callRpc(AUTH_BOD, USER_BOD, {
      from: "2026-10-01",
      to: "2026-10-15",
      mode: "overview",
    });
    assert.equal(overviewRaw.mode, "overview");
    assert.ok(overviewRaw.snapshot && overviewRaw.transitions);
    assert.equal("balance" in overviewRaw, false);
    assert.equal("waiting" in overviewRaw, false);
    assert.equal("duration" in overviewRaw, false);
    assert.equal("retention" in overviewRaw, false);
    assert.equal("dimensions" in overviewRaw, false);
    assert.equal("leave_reasons" in overviewRaw, false);

    const parsedOverview = parseWorkforceOverviewPayload(overviewRaw);
    assert.equal(parsedOverview.status, "ready");
    if (parsedOverview.status === "ready" && oct15.status === "ready") {
      assert.deepEqual(parsedOverview.snapshot, oct15.snapshot);
      assert.deepEqual(parsedOverview.transitions, oct15.transitions);
    }

    //    4b. `mode = 'overview' | 'deep' | 'project_page'` must reject `team` and `own` actors with 42501:
    for (const [authSub, appUser] of [
      [AUTH_LEAD_A, USER_LEAD_A],
      [AUTH_REC_A1, USER_REC_A1],
    ]) {
      for (const mode of ["overview", "deep", "project_page"]) {
        await assert.rejects(
          () => callRpc(authSub, appUser, { from: "2026-10-01", to: "2026-10-15", mode }),
          (err) => err && (err.code === "42501" || String(err.message).includes("require all scope")),
          `Actor ${appUser} must be denied mode=${mode} at PostgreSQL RPC boundary`,
        );
      }
      const deniedOverview = await resolveWorkforceOverviewForActor({
        actor: { auth_subject: authSub, app_user_id: appUser },
        filters: { from: "2026-10-01", to: "2026-10-15" },
        callWorkforceRpc: async (args) => {
          try {
            return { data: await callRpc(args.p_auth_subject, args.p_app_user_id, args.p_filters) };
          } catch (error) {
            return { error };
          }
        },
      });
      assert.equal(deniedOverview.status, "unavailable");
    }

    //    4c. Server-side pagination for `by_project` (5 rows per page + "Tải thêm" cursor paging):
    //        Seed 5 additional projects (total 7 projects) and verify page 1 returns 5 projects
    //        and page 2 returns the remaining 2 projects with zero duplicates and zero omissions.
    for (let idx = 1; idx <= 5; idx += 1) {
      const pCode = `proj_extra_${idx}`;
      const pName = `Project Extra ${idx}`;
      await db.query(
        "insert into public.direct_entry_projects (project_id, display_name) values ($1, $2)",
        [pCode, pName],
      );
      const epId = uuid(600 + idx);
      const subId = uuid(700 + idx);
      const candId = uuid(750 + idx);
      const evId = uuid(800 + idx);
      await insertEntry(db, {
        entry: epId,
        sub: subId,
        cand: candId,
        createdBy: USER_BOD,
        project: pCode,
        date: "2026-10-02",
        code: `hrp-2026-00050${idx}`,
        recruiter: REC_A1_ID,
        team: TEAM_A_ID,
        provider: "hrp",
      });
      await db.query(
        `insert into public.direct_entry_employment_status_events (
           event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
           version, actor_user_id, reason_id, supersedes_event_id
         ) values ($1::uuid, $2::uuid, 'ON', '2026-10-02'::date, null, null, 1, $3::uuid, $4::uuid, null)`,
        [evId, epId, USER_BOD, REASON_ID],
      );
    }

    const fullWith7Projects = parseWorkforceReportingPayload(
      await callRpc(AUTH_BOD, USER_BOD, { from: "2026-10-01", to: "2026-10-15" }),
    );
    assert.equal(fullWith7Projects.status, "ready");

    const deepPage1 = await resolveWorkforceDeepReportingForActor({
      actor: { auth_subject: AUTH_BOD, app_user_id: USER_BOD },
      filters: { from: "2026-10-01", to: "2026-10-15" },
      callWorkforceRpc: async (args) => ({
        data: await callRpc(args.p_auth_subject, args.p_app_user_id, args.p_filters),
      }),
    });
    assert.equal(deepPage1.status, "ready");

    if (fullWith7Projects.status === "ready" && deepPage1.status === "ready") {
      assert.equal(fullWith7Projects.dimensions.byProject.buckets.length, 7);
      assert.equal(deepPage1.dimensions.byProject.buckets.length, 5);
      assert.ok(deepPage1.dimensions.byProject.pagination);
      assert.equal(deepPage1.dimensions.byProject.pagination.totalCount, 7);
      assert.equal(deepPage1.dimensions.byProject.pagination.pageSize, 5);
      assert.equal(deepPage1.dimensions.byProject.pagination.hasMore, true);
      assert.ok(deepPage1.dimensions.byProject.pagination.nextCursor);

      const page2 = await resolveWorkforceProjectPageForActor({
        actor: { auth_subject: AUTH_BOD, app_user_id: USER_BOD },
        filters: { from: "2026-10-01", to: "2026-10-15" },
        cursor: deepPage1.dimensions.byProject.pagination.nextCursor,
        callWorkforceRpc: async (args) => ({
          data: await callRpc(args.p_auth_subject, args.p_app_user_id, args.p_filters),
        }),
      });
      assert.equal(page2.status, "ready");
      if (page2.status === "ready") {
        assert.equal(page2.totalCount, 7);
        assert.equal(page2.pageSize, 5);
        assert.equal(page2.hasMore, false);
        assert.equal(page2.nextCursor, null);
        assert.equal(page2.rows.length, 2);

        const combined = [...deepPage1.dimensions.byProject.buckets, ...page2.rows];
        assert.deepEqual(combined, fullWith7Projects.dimensions.byProject.buckets);
      }

      // Attention insights on paged deepPage1 must match fullWith7Projects 100%
      assert.deepEqual(
        deriveWorkforceAttentionInsights(deepPage1),
        deriveWorkforceAttentionInsights(fullWith7Projects),
      );
    }
  } finally {
    await db.close();
  }
});
