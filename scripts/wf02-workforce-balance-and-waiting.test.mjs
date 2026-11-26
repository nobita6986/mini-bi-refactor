/**
 * MBI-DA-2026-01 Chặng 2 / WF-02 (Items 2.3 & 2.4): Ephemeral PGlite database integration test
 * for `public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)` covering:
 *   - 2.3 Opening (from - 1 day) & Closing (to) Snapshot Reconciliation and Per-Status Balance Conservation
 *   - 2.4 Contiguous UNCONFIRMED Waiting Time Intervals, Sample Denominators, Placement Rate, and Period Waiting
 *   - 100% parity between the PostgreSQL RPC and the pure TypeScript evaluator `evaluateWorkforceSnapshotAndTransitions`.
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
  evaluateWorkforceSnapshotAndTransitions,
  parseWorkforceReportingPayload,
  resolveWorkforceReportingForActor,
} from "../src/lib/reporting/wf02-workforce-balance-waiting.ts";

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
    deletedAt = null,
    voidedAt = null,
    voidReasonId = null,
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
      "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id, project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type, deleted_at, voided_at, voided_by_user_id, void_reason_id) " +
        "values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
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
        deletedAt,
        voidedAt,
        voidedAt !== null ? createdBy : null,
        voidedAt !== null ? voidReasonId : null,
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

test("WF-02 ephemeral DB integration: 2.3 period balance reconciliation, 2.4 waiting intervals & placement rates, scopes, and TS parity", async () => {
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

    for (const u of [AUTH_BOD, AUTH_LEAD_A, AUTH_REC_A1]) {
      await db.query("insert into auth.users (id) values ($1)", [u]);
    }
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name) values " +
        "($1,$2,true,'BoD'), ($3,$4,true,'Lead A'), ($5,$6,true,'Rec A1')",
      [USER_BOD, AUTH_BOD, USER_LEAD_A, AUTH_LEAD_A, USER_REC_A1, AUTH_REC_A1],
    );
    await db.query(
      "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_A','Team Alpha'), ($2,'TEAM_B','Team Beta')",
      [TEAM_A_ID, TEAM_B_ID],
    );
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1,'Rec A1'), ($2,'Rec A2'), ($3,'Rec B1')",
      [REC_A1_ID, REC_A2_ID, REC_B1_ID],
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)",
      [USER_REC_A1, REC_A1_ID],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values " +
        "($1,'hrp','2020-01-01',true), ($2,'hrp','2020-01-01',true), ($3,'hrp','2020-01-01',true)",
      [REC_A1_ID, REC_A2_ID, REC_B1_ID],
    );
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values " +
        "($1,$4,'2020-01-01',true), ($2,$4,'2020-01-01',true), ($3,$5,'2020-01-01',true)",
      [REC_A1_ID, REC_A2_ID, REC_B1_ID, TEAM_A_ID, TEAM_B_ID],
    );
    await db.query(
      "insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from) values " +
        "($1,'rec a1','2020-01-01'), ($2,'rec a2','2020-01-01'), ($3,'rec b1','2020-01-01')",
      [REC_A1_ID, REC_A2_ID, REC_B1_ID],
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
      "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1, $2, 'WF-02 test fixture')",
      [REASON_ID, USER_BOD],
    );

    // Seed 7 episodes covering pre-period, in-period new, direct-ON, placed-to-ON, exited-without-ON, currently-waiting, and unknown:
    const EP_PRE_UNC = uuid(101); // Team A, Rec A1: first_work_date 2026-02-25, UNCONFIRMED (02-25) -> repeat UNCONFIRMED (02-28) -> ON (03-04) -> OFF (03-12)
    const EP_PRE_ON = uuid(102); // Team B, Rec B1: first_work_date 2026-02-20, ON (02-20) -> OFF (03-06)
    const EP_NEW_PLACED = uuid(103); // Team A, Rec A1: first_work_date 2026-03-02, UNCONFIRMED (03-02) -> ON (03-07)
    const EP_NEW_EXITED = uuid(104); // Team A, Rec A2: first_work_date 2026-03-03, UNCONFIRMED (03-03) -> OFF (03-09)
    const EP_NEW_STILL_WAITING = uuid(105); // Team A, Rec A1: first_work_date 2026-03-10, UNCONFIRMED (03-10)
    const EP_NEW_DIRECT_ON = uuid(106); // Team B, Rec B1: first_work_date 2026-03-05, ON (03-05)
    const EP_NEW_UNKNOWN = uuid(107); // Team A, Rec A2: first_work_date 2026-03-08, no status event

    const entriesToInsert = [
      { entry: EP_PRE_UNC, sub: uuid(201), cand: uuid(301), project: "proj_a", date: "2026-02-25", code: "hrp-2026-000201", recruiter: REC_A1_ID, team: TEAM_A_ID },
      { entry: EP_PRE_ON, sub: uuid(202), cand: uuid(302), project: "proj_b", date: "2026-02-20", code: "hrp-2026-000202", recruiter: REC_B1_ID, team: TEAM_B_ID },
      { entry: EP_NEW_PLACED, sub: uuid(203), cand: uuid(303), project: "proj_a", date: "2026-03-02", code: "hrp-2026-000203", recruiter: REC_A1_ID, team: TEAM_A_ID },
      { entry: EP_NEW_EXITED, sub: uuid(204), cand: uuid(304), project: "proj_a", date: "2026-03-03", code: "hrp-2026-000204", recruiter: REC_A2_ID, team: TEAM_A_ID },
      { entry: EP_NEW_STILL_WAITING, sub: uuid(205), cand: uuid(305), project: "proj_a", date: "2026-03-10", code: "hrp-2026-000205", recruiter: REC_A1_ID, team: TEAM_A_ID },
      { entry: EP_NEW_DIRECT_ON, sub: uuid(206), cand: uuid(306), project: "proj_b", date: "2026-03-05", code: "hrp-2026-000206", recruiter: REC_B1_ID, team: TEAM_B_ID },
      { entry: EP_NEW_UNKNOWN, sub: uuid(207), cand: uuid(307), project: "proj_a", date: "2026-03-08", code: "hrp-2026-000207", recruiter: REC_A2_ID, team: TEAM_A_ID },
    ];

    for (const item of entriesToInsert) {
      await insertEntry(db, { ...item, createdBy: USER_BOD });
    }

    const statusEvents = [
      // EP_PRE_UNC: UNCONFIRMED (02-25) -> ON (02-28, superseded by v3) -> UNCONFIRMED (02-28, supersedes v2 -> creates consecutive active UNCONFIRMED -> UNCONFIRMED) -> ON (03-04) -> OFF (03-12)
      // Wait duration: [02-25 .. 03-04] = 7 days (2026 is non-leap year: Feb has 28 days => 3 days in Feb + 4 days in Mar = 7 days).
      { event_id: uuid(401), entry_id: EP_PRE_UNC, status: "UNCONFIRMED", effective_date: "2026-02-25", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(402), entry_id: EP_PRE_UNC, status: "ON", effective_date: "2026-02-28", leave_date: null, reason: null, version: 2, supersedes_event_id: null },
      { event_id: uuid(403), entry_id: EP_PRE_UNC, status: "UNCONFIRMED", effective_date: "2026-02-28", leave_date: null, reason: null, version: 3, supersedes_event_id: uuid(402) },
      { event_id: uuid(404), entry_id: EP_PRE_UNC, status: "ON", effective_date: "2026-03-04", leave_date: null, reason: null, version: 4, supersedes_event_id: null },
      { event_id: uuid(405), entry_id: EP_PRE_UNC, status: "OFF", effective_date: "2026-03-12", leave_date: "2026-03-12", reason: "Hết việc", version: 5, supersedes_event_id: null },

      // EP_PRE_ON: ON (02-20) -> OFF (03-06)
      { event_id: uuid(411), entry_id: EP_PRE_ON, status: "ON", effective_date: "2026-02-20", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(412), entry_id: EP_PRE_ON, status: "OFF", effective_date: "2026-03-06", leave_date: "2026-03-06", reason: "Nghỉ", version: 2, supersedes_event_id: null },

      // EP_NEW_PLACED: UNCONFIRMED (03-02) -> ON (03-07) => 5 days waiting
      { event_id: uuid(421), entry_id: EP_NEW_PLACED, status: "UNCONFIRMED", effective_date: "2026-03-02", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(422), entry_id: EP_NEW_PLACED, status: "ON", effective_date: "2026-03-07", leave_date: null, reason: null, version: 2, supersedes_event_id: null },

      // EP_NEW_EXITED: UNCONFIRMED (03-03) -> OFF (03-09) => 6 days waiting
      { event_id: uuid(431), entry_id: EP_NEW_EXITED, status: "UNCONFIRMED", effective_date: "2026-03-03", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(432), entry_id: EP_NEW_EXITED, status: "OFF", effective_date: "2026-03-09", leave_date: "2026-03-09", reason: "Từ chối chờ", version: 2, supersedes_event_id: null },

      // EP_NEW_STILL_WAITING: UNCONFIRMED (03-10) => at 03-15 has 5 days waiting
      { event_id: uuid(441), entry_id: EP_NEW_STILL_WAITING, status: "UNCONFIRMED", effective_date: "2026-03-10", leave_date: null, reason: null, version: 1, supersedes_event_id: null },

      // EP_NEW_DIRECT_ON: ON (03-05) => direct ON, 0 waiting
      { event_id: uuid(451), entry_id: EP_NEW_DIRECT_ON, status: "ON", effective_date: "2026-03-05", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
    ];

    for (const ev of statusEvents) {
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

    const allEpisodesForTs = entriesToInsert.map((item) => ({
      entry_id: item.entry,
      first_work_date: item.date,
      submission_state: "SUBMITTED",
      deleted_at: null,
      voided_at: null,
      team_id: item.team,
      recruiter_id: item.recruiter,
    }));

    // 1. Verify full parity between DB RPC and pure TS across multiple windows for `all` scope:
    for (const [from, to] of [
      ["2026-03-01", "2026-03-03"],
      ["2026-03-01", "2026-03-07"],
      ["2026-03-01", "2026-03-15"],
      ["2026-03-04", "2026-03-12"],
    ]) {
      const dbRaw = await callRpc(AUTH_BOD, USER_BOD, { from, to });
      const parsed = parseWorkforceReportingPayload(dbRaw);
      assert.equal(parsed.status, "ready", `RPC payload for ${from}..${to} must be valid`);

      const tsExpected = evaluateWorkforceSnapshotAndTransitions({
        episodes: allEpisodesForTs,
        events: statusEvents,
        filters: { from, to },
      });

      assert.deepEqual(parsed.snapshot, tsExpected.snapshot);
      assert.deepEqual(parsed.transitions, tsExpected.transitions);
      assert.deepEqual(parsed.balance, tsExpected.balance);
      assert.deepEqual(parsed.waiting, tsExpected.waiting);
    }

    // 2. Assert exact WF-02 numbers on [2026-03-01 .. 2026-03-15] for `all` scope:
    const march15 = parseWorkforceReportingPayload(
      await callRpc(AUTH_BOD, USER_BOD, { from: "2026-03-01", to: "2026-03-15" }),
    );
    assert.equal(march15.status, "ready");
    if (march15.status === "ready" && march15.balance.applicable && march15.waiting.periodWaiting.applicable) {
      // Opening at 2026-02-28: EP_PRE_UNC (UNCONFIRMED), EP_PRE_ON (ON) => total 2
      assert.equal(march15.balance.openingAsOfDate, "2026-02-28");
      assert.equal(march15.balance.openingSnapshot.eligibleEpisodeTotal, 2);
      assert.equal(march15.balance.openingSnapshot.onCount, 1);
      assert.equal(march15.balance.openingSnapshot.unconfirmedCount, 1);

      // New episodes in [03-01 .. 03-15]: 5 total (1 ON, 3 UNCONFIRMED, 1 UNKNOWN)
      assert.deepEqual(march15.balance.newEpisodesInPeriod, {
        total: 5,
        initialOn: 1,
        initialUnconfirmed: 3,
        initialOff: 0,
        initialUnknown: 1,
      });

      // ON balance: opening=1 + new=1 + transIn=2 (EP_PRE_UNC, EP_NEW_PLACED) - outflow=2 (EP_PRE_ON, EP_PRE_UNC) = closing=2 (EP_NEW_PLACED, EP_NEW_DIRECT_ON)
      assert.equal(march15.balance.byStatus.on.openingCount, 1);
      assert.equal(march15.balance.byStatus.on.newEpisodeInflowCount, 1);
      assert.equal(march15.balance.byStatus.on.transitionInflowCount, 2);
      assert.equal(march15.balance.byStatus.on.outflowCount, 2);
      assert.equal(march15.balance.byStatus.on.closingCount, 2);

      // UNCONFIRMED balance: opening=1 + new=3 + transIn=0 - outflow=3 (EP_PRE_UNC->ON, EP_NEW_PLACED->ON, EP_NEW_EXITED->OFF) = closing=1 (EP_NEW_STILL_WAITING)
      assert.equal(march15.balance.byStatus.unconfirmed.openingCount, 1);
      assert.equal(march15.balance.byStatus.unconfirmed.newEpisodeInflowCount, 3);
      assert.equal(march15.balance.byStatus.unconfirmed.transitionInflowCount, 0);
      assert.equal(march15.balance.byStatus.unconfirmed.outflowCount, 3);
      assert.equal(march15.balance.byStatus.unconfirmed.closingCount, 1);

      // OFF balance: opening=0 + new=0 + transIn=3 (EP_PRE_ON, EP_PRE_UNC, EP_NEW_EXITED) - outflow=0 = closing=3
      assert.equal(march15.balance.byStatus.off.openingCount, 0);
      assert.equal(march15.balance.byStatus.off.transitionInflowCount, 3);
      assert.equal(march15.balance.byStatus.off.closingCount, 3);

      // Waiting metrics at 2026-03-15:
      // Eligible = 7: waitingEpisodeTotal = 4 (EP_PRE_UNC=7d, EP_NEW_PLACED=5d, EP_NEW_EXITED=6d, EP_NEW_STILL_WAITING=5d),
      //               directOnEpisodeCount = 2 (EP_PRE_ON, EP_NEW_DIRECT_ON),
      //               unknownEpisodeCount = 1 (EP_NEW_UNKNOWN)
      assert.equal(march15.waiting.eligibleEpisodeTotal, 7);
      assert.equal(march15.waiting.waitingEpisodeTotal, 4);
      assert.equal(march15.waiting.directOnEpisodeCount, 2);
      assert.equal(march15.waiting.unknownEpisodeCount, 1);
      assert.equal(march15.waiting.allWaiting.totalWaitingDays, 7 + 5 + 6 + 5); // 23 days
      assert.equal(march15.waiting.placedToOn.episodeCount, 2); // EP_PRE_UNC (7d), EP_NEW_PLACED (5d)
      assert.equal(march15.waiting.placedToOn.totalWaitingDays, 12);
      assert.equal(march15.waiting.placedToOn.avgWaitingDaysPerEpisode, 6);
      assert.equal(march15.waiting.exitedWithoutOn.episodeCount, 1); // EP_NEW_EXITED (6d)
      assert.equal(march15.waiting.exitedWithoutOn.totalWaitingDays, 6);
      assert.equal(march15.waiting.currentlyWaiting.episodeCount, 1); // EP_NEW_STILL_WAITING (5d)
      assert.equal(march15.waiting.currentlyWaiting.totalWaitingDays, 5);
      assert.equal(march15.waiting.placementRateOfWaiting, 2 / 4);
      assert.equal(march15.waiting.placementRateOfCompletedWaiting, 2 / 3);

      // Period waiting in [2026-03-01 .. 2026-03-15]:
      // EP_PRE_UNC clipped to [03-01 .. 03-04] = 3 days in period (full interval = 7 days).
      // EP_NEW_PLACED = 5 days, EP_NEW_EXITED = 6 days, EP_NEW_STILL_WAITING = 5 days => total 19 clipped days!
      assert.equal(march15.waiting.periodWaiting.activeWaitingEpisodeCount, 4);
      assert.equal(march15.waiting.periodWaiting.inPeriodWaitingDays, 3 + 5 + 6 + 5);
      assert.equal(march15.waiting.periodWaiting.placedInPeriod.eventCount, 2);
      assert.equal(march15.waiting.periodWaiting.placedInPeriod.totalWaitingDays, 12);
    }

    // 3. Verify `team` scope (Lead A -> Team A only) and `own` scope (Rec A1 only) via resolveWorkforceReportingForActor:
    const teamRes = await resolveWorkforceReportingForActor({
      actor: { auth_subject: AUTH_LEAD_A, app_user_id: USER_LEAD_A },
      filters: { from: "2026-03-01", to: "2026-03-15" },
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
        events: statusEvents,
        filters: { from: "2026-03-01", to: "2026-03-15" },
      });
      assert.deepEqual(teamRes.balance, tsTeam.balance);
      assert.deepEqual(teamRes.waiting, tsTeam.waiting);
    }

    const ownRes = await resolveWorkforceReportingForActor({
      actor: { auth_subject: AUTH_REC_A1, app_user_id: USER_REC_A1 },
      filters: { from: "2026-03-01", to: "2026-03-15" },
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
        events: statusEvents,
        filters: { from: "2026-03-01", to: "2026-03-15" },
      });
      assert.deepEqual(ownRes.balance, tsOwn.balance);
      assert.deepEqual(ownRes.waiting, tsOwn.waiting);
    }
  } finally {
    await db.close();
  }
});
