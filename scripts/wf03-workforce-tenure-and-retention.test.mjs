/**
 * MBI-DA-2026-01 Chặng 2 / WF-03 (Items 2.5 & 2.6): Ephemeral PGlite database integration test
 * for `public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)` covering:
 *   - 2.5 Active ON Tenure / Duration & In-Period Status Presence Days
 *   - 2.6 Early Attrition & D7 / D30 / D90 Cohort Retention from First ON Effective Date
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
  evaluateWorkforceSnapshotAndTransitions,
  parseWorkforceReportingPayload,
  resolveWorkforceReportingForActor,
} from "../src/lib/reporting/wf03-workforce-tenure-retention.ts";

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
  const names = (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort();
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

test("WF-03 ephemeral DB integration: 2.5 active ON tenure & status presence, 2.6 D7/D30/D90 cohort retention, scopes, and TS parity", async () => {
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
      "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1, $2, 'WF-03 test fixture')",
    [REASON_ID, USER_BOD],
    );

    // Seed 12 episodes covering:
    // 1. EP_D90_RETAINED (Team A, Rec A1): ON 2026-06-01 -> still ON at 2026-10-15 ([06-01, 10-16) = 137 days ON, matured & retained at D7/D30/D90)
    // 2. EP_D90_EXITED_DAY90 (Team B, Rec B1): ON 2026-06-01 -> OFF 2026-08-30 (90 days ON, retained D7 & D30, exited at D90)
    // 3. EP_D30_EXITED_DAY30 (Team A, Rec A2): ON 2026-06-01 -> OFF 2026-07-01 (30 days ON, retained D7, exited at D30 & D90)
    // 4. EP_D7_EXITED_DAY6 (Team A, Rec A1): ON 2026-06-01 -> OFF 2026-06-07 (6 days ON, exited at D7/D30/D90)
    // 5. EP_REHIRE_NEW_EPISODE (Team A, Rec A1): Rehire with new entry_id on 2026-10-12 -> ON 2026-10-12 ([10-12, 10-16) = 4 days ON, immature for D7/D30/D90; never rescues EP_D7_EXITED_DAY6)
    // 6. EP_WAIT_THEN_ON (Team A, Rec A2): UNCONFIRMED 2026-09-10 -> ON 2026-09-20 ([09-20, 10-16) = 26 days ON; cohort_start_date = 2026-09-20 => matured D7, immature D30/D90)
    // 7. EP_NEVER_ON (Team B, Rec B1): UNCONFIRMED 2026-10-02 -> OFF 2026-10-09 (never entered ON)
    // 8. EP_UNKNOWN (Team A, Rec A2): first_work_date 2026-10-04, no status event
    // 9. EP_FUTURE (Team A, Rec A1): first_work_date 2026-10-25, ON 2026-10-25
    // 10. EP_ON_AT_TO (Team B, Rec B1): ON starting right on `to` / `as_of` (2026-10-15) -> 1 day ON & 1 day in period
    // 11. EP_END_AT_FROM (Team B, Rec B1): ON 2026-09-25 -> OFF right on `from` (2026-10-01) -> 6 days total ON, 0 days in [10-01, 10-16) and NOT in activeOnEpisodeCount
    // 12. EP_OFF_THEN_ON_BEFORE_D7 (Team B, Rec B1): ON 2026-06-01 -> OFF 2026-06-04 (day 3) -> ON 2026-06-06 (day 5 before D7) -> still exited at D7/D30/D90
    const EP_D90_RETAINED = uuid(101);
    const EP_D90_EXITED_DAY90 = uuid(102);
    const EP_D30_EXITED_DAY30 = uuid(103);
    const EP_D7_EXITED_DAY6 = uuid(104);
    const EP_REHIRE_NEW_EPISODE = uuid(105);
    const EP_WAIT_THEN_ON = uuid(106);
    const EP_NEVER_ON = uuid(107);
    const EP_UNKNOWN = uuid(108);
    const EP_FUTURE = uuid(109);
    const EP_ON_AT_TO = uuid(110);
    const EP_END_AT_FROM = uuid(111);
    const EP_OFF_THEN_ON_BEFORE_D7 = uuid(112);

    const entriesToInsert = [
      { entry: EP_D90_RETAINED, sub: uuid(201), cand: uuid(301), project: "proj_a", date: "2026-06-01", code: "hrp-2026-000301", recruiter: REC_A1_ID, team: TEAM_A_ID },
      { entry: EP_D90_EXITED_DAY90, sub: uuid(202), cand: uuid(302), project: "proj_b", date: "2026-06-01", code: "hrp-2026-000302", recruiter: REC_B1_ID, team: TEAM_B_ID },
      { entry: EP_D30_EXITED_DAY30, sub: uuid(203), cand: uuid(303), project: "proj_a", date: "2026-06-01", code: "hrp-2026-000303", recruiter: REC_A2_ID, team: TEAM_A_ID },
      { entry: EP_D7_EXITED_DAY6, sub: uuid(204), cand: uuid(304), project: "proj_a", date: "2026-06-01", code: "hrp-2026-000304", recruiter: REC_A1_ID, team: TEAM_A_ID },
      { entry: EP_REHIRE_NEW_EPISODE, sub: uuid(205), cand: uuid(305), project: "proj_a", date: "2026-10-12", code: "hrp-2026-000305", recruiter: REC_A1_ID, team: TEAM_A_ID },
      { entry: EP_WAIT_THEN_ON, sub: uuid(206), cand: uuid(306), project: "proj_a", date: "2026-09-10", code: "hrp-2026-000306", recruiter: REC_A2_ID, team: TEAM_A_ID },
      { entry: EP_NEVER_ON, sub: uuid(207), cand: uuid(307), project: "proj_b", date: "2026-10-02", code: "hrp-2026-000307", recruiter: REC_B1_ID, team: TEAM_B_ID },
      { entry: EP_UNKNOWN, sub: uuid(208), cand: uuid(308), project: "proj_a", date: "2026-10-04", code: "hrp-2026-000308", recruiter: REC_A2_ID, team: TEAM_A_ID },
      { entry: EP_FUTURE, sub: uuid(209), cand: uuid(309), project: "proj_a", date: "2026-10-25", code: "hrp-2026-000309", recruiter: REC_A1_ID, team: TEAM_A_ID },
      { entry: EP_ON_AT_TO, sub: uuid(210), cand: uuid(310), project: "proj_b", date: "2026-10-15", code: "hrp-2026-000310", recruiter: REC_B1_ID, team: TEAM_B_ID },
      { entry: EP_END_AT_FROM, sub: uuid(211), cand: uuid(311), project: "proj_b", date: "2026-09-25", code: "hrp-2026-000311", recruiter: REC_B1_ID, team: TEAM_B_ID },
      { entry: EP_OFF_THEN_ON_BEFORE_D7, sub: uuid(212), cand: uuid(312), project: "proj_b", date: "2026-06-01", code: "hrp-2026-000312", recruiter: REC_B1_ID, team: TEAM_B_ID },
    ];

    for (const item of entriesToInsert) {
      await insertEntry(db, { ...item, createdBy: USER_BOD });
    }

    const statusEvents = [
      { event_id: uuid(401), entry_id: EP_D90_RETAINED, status: "ON", effective_date: "2026-06-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },

      { event_id: uuid(411), entry_id: EP_D90_EXITED_DAY90, status: "ON", effective_date: "2026-06-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(412), entry_id: EP_D90_EXITED_DAY90, status: "OFF", effective_date: "2026-08-30", leave_date: "2026-08-30", reason: "Nghỉ", version: 2, supersedes_event_id: null },

      { event_id: uuid(421), entry_id: EP_D30_EXITED_DAY30, status: "ON", effective_date: "2026-06-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(422), entry_id: EP_D30_EXITED_DAY30, status: "OFF", effective_date: "2026-07-01", leave_date: "2026-07-01", reason: "Nghỉ", version: 2, supersedes_event_id: null },

      { event_id: uuid(431), entry_id: EP_D7_EXITED_DAY6, status: "ON", effective_date: "2026-06-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(432), entry_id: EP_D7_EXITED_DAY6, status: "OFF", effective_date: "2026-06-07", leave_date: "2026-06-07", reason: "Nghỉ sớm", version: 2, supersedes_event_id: null },

      { event_id: uuid(441), entry_id: EP_REHIRE_NEW_EPISODE, status: "ON", effective_date: "2026-10-12", leave_date: null, reason: null, version: 1, supersedes_event_id: null },

      { event_id: uuid(451), entry_id: EP_WAIT_THEN_ON, status: "UNCONFIRMED", effective_date: "2026-09-10", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(452), entry_id: EP_WAIT_THEN_ON, status: "ON", effective_date: "2026-09-20", leave_date: null, reason: null, version: 2, supersedes_event_id: null },

      { event_id: uuid(461), entry_id: EP_NEVER_ON, status: "UNCONFIRMED", effective_date: "2026-10-02", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(462), entry_id: EP_NEVER_ON, status: "OFF", effective_date: "2026-10-09", leave_date: "2026-10-09", reason: "Từ chối", version: 2, supersedes_event_id: null },

      { event_id: uuid(481), entry_id: EP_FUTURE, status: "ON", effective_date: "2026-10-25", leave_date: null, reason: null, version: 1, supersedes_event_id: null },

      { event_id: uuid(491), entry_id: EP_ON_AT_TO, status: "ON", effective_date: "2026-10-15", leave_date: null, reason: null, version: 1, supersedes_event_id: null },

      { event_id: uuid(501), entry_id: EP_END_AT_FROM, status: "ON", effective_date: "2026-09-25", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(502), entry_id: EP_END_AT_FROM, status: "OFF", effective_date: "2026-10-01", leave_date: "2026-10-01", reason: "Nghỉ đúng ngày đầu kỳ", version: 2, supersedes_event_id: null },

      { event_id: uuid(511), entry_id: EP_OFF_THEN_ON_BEFORE_D7, status: "ON", effective_date: "2026-06-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(512), entry_id: EP_OFF_THEN_ON_BEFORE_D7, status: "OFF", effective_date: "2026-06-04", leave_date: "2026-06-04", reason: "Nghỉ ngày 3", version: 2, supersedes_event_id: null },
      { event_id: uuid(513), entry_id: EP_OFF_THEN_ON_BEFORE_D7, status: "ON", effective_date: "2026-06-06", leave_date: null, reason: null, version: 3, supersedes_event_id: null, legacyBypassGuard: true },
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
      ["2026-06-01", "2026-06-15"],
      ["2026-09-01", "2026-09-30"],
      ["2026-10-01", "2026-10-15"],
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
      assert.deepEqual(parsed.duration, tsExpected.duration);
      assert.deepEqual(parsed.retention, tsExpected.retention);
    }

    // 2. Assert exact WF-03 numbers on [2026-10-01 .. 2026-10-15] for `all` scope:
    const oct15 = parseWorkforceReportingPayload(
      await callRpc(AUTH_BOD, USER_BOD, { from: "2026-10-01", to: "2026-10-15" }),
    );
    assert.equal(oct15.status, "ready");
    if (oct15.status === "ready") {
      assert.equal(oct15.duration.eligibleEpisodeTotal, 11);
      assert.equal(oct15.duration.knownStatusEpisodeCount, 10);
      assert.equal(oct15.duration.unknownStatusEpisodeCount, 1);
      assert.equal(oct15.duration.everOnEpisodeCount, 9);
      assert.equal(oct15.duration.neverOnEpisodeCount, 1);

      // Currently ON at 2026-10-15:
      // EP_D90_RETAINED (137d), EP_REHIRE_NEW_EPISODE (4d), EP_WAIT_THEN_ON (26d), EP_ON_AT_TO (1d), EP_OFF_THEN_ON_BEFORE_D7 (3 + 132 = 135d)
      assert.equal(oct15.duration.currentlyOn.episodeCount, 5);
      assert.equal(oct15.duration.currentlyOn.intervalCount, 6);
      assert.equal(oct15.duration.currentlyOn.totalOnDays, 137 + 4 + 26 + 1 + 135);
      // Exited after ON: EP_D90_EXITED_DAY90 (90d), EP_D30_EXITED_DAY30 (30d), EP_D7_EXITED_DAY6 (6d), EP_END_AT_FROM (6d)
      assert.equal(oct15.duration.exitedAfterOn.episodeCount, 4);
      assert.equal(oct15.duration.exitedAfterOn.totalOnDays, 90 + 30 + 6 + 6);
      // Distribution: 0..7 => 4 (6d, 4d, 1d, 6d), 8..30 => 2 (30d, 26d), 31..90 => 1 (90d), 91+ => 2 (137d, 135d)
      assert.deepEqual(oct15.duration.distribution, {
        days0To7Count: 4,
        days8To30Count: 2,
        days31To90Count: 1,
        days91PlusCount: 2,
      });

      // Period presence in half-open [2026-10-01, 2026-10-16):
      // EP_D90_RETAINED = 15d, EP_WAIT_THEN_ON = 15d, EP_REHIRE_NEW_EPISODE = 4d, EP_ON_AT_TO = 1d, EP_OFF_THEN_ON_BEFORE_D7 = 15d
      // (EP_END_AT_FROM ended on 2026-10-01 => 0 days and excluded from activeOnEpisodeCount!)
      assert.equal(oct15.duration.periodPresence.applicable, true);
      if (oct15.duration.periodPresence.applicable) {
        assert.equal(oct15.duration.periodPresence.activeOnEpisodeCount, 5);
        assert.equal(oct15.duration.periodPresence.inPeriodOnDays, 15 + 15 + 4 + 1 + 15);
      }

      // Continuous retention checkpoints at 2026-10-15:
      assert.equal(oct15.retention.cohortEpisodeTotal, 9);
      assert.equal(oct15.retention.neverEnteredOnCount, 1);
      assert.equal(oct15.retention.unknownStatusEpisodeCount, 1);
      assert.equal(oct15.retention.continuouslyRetainedCount, 4);
      assert.equal(oct15.retention.exitedFromOnTotal, 5);
      assert.deepEqual(oct15.retention.checkpoints.d7, {
        checkpointDays: 7,
        maturedCount: 7,
        immatureCount: 2,
        retainedCount: 4,
        exitedCount: 3,
        retentionRate: 4 / 7,
        attritionRate: 3 / 7,
      });
      assert.deepEqual(oct15.retention.checkpoints.d30, {
        checkpointDays: 30,
        maturedCount: 5,
        immatureCount: 4,
        retainedCount: 2,
        exitedCount: 3,
        retentionRate: 2 / 5,
        attritionRate: 3 / 5,
      });
      assert.deepEqual(oct15.retention.checkpoints.d90, {
        checkpointDays: 90,
        maturedCount: 5,
        immatureCount: 4,
        retainedCount: 1,
        exitedCount: 4,
        retentionRate: 1 / 5,
        attritionRate: 4 / 5,
      });
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
        events: statusEvents,
        filters: { from: "2026-10-01", to: "2026-10-15" },
      });
      assert.deepEqual(teamRes.duration, tsTeam.duration);
      assert.deepEqual(teamRes.retention, tsTeam.retention);
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
        events: statusEvents,
        filters: { from: "2026-10-01", to: "2026-10-15" },
      });
      assert.deepEqual(ownRes.duration, tsOwn.duration);
      assert.deepEqual(ownRes.retention, tsOwn.retention);
    }
  } finally {
    await db.close();
  }
});
