/**
 * MBI-DA-2026-01 Chặng 2 / WF-01: Ephemeral PGlite database integration test for
 * `public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)` and its parity
 * with pure TypeScript evaluator `evaluateWorkforceSnapshotAndTransitions`.
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
} from "../src/lib/reporting/wf01-workforce-snapshot.ts";

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
    existingSubmission = false,
    deletedAt = null,
    voidedAt = null,
    voidReasonId = null,
  },
) {
  await db.exec("begin");
  try {
    await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1)", [cand]);
    if (!existingSubmission) {
      await db.query(
        "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1,$2,'DRAFT')",
        [sub, createdBy],
      );
    }
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
    if (submit && !existingSubmission) {
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

test("WF-01 ephemeral DB integration: snapshot as-of, status transitions, supersession, scopes, and TS parity", async () => {
  const db = await buildDb();
  try {
    // Regression assertions on SECURITY DEFINER owner, status events FORCE RLS/privileges, search_path, and EXECUTE ACL:
    const { rows: catalogRows } = await db.query(`
      select
        p.oid::pg_catalog.regprocedure::text as signature,
        p.prosecdef,
        p.proconfig,
        owner_role.rolname as proc_owner,
        owner_role.rolsuper as owner_is_super,
        owner_role.rolbypassrls as owner_bypassrls,
        table_owner_role.rolname as status_table_owner,
        facts_owner_role.rolname as facts_rpc_owner,
        c.relrowsecurity as status_rls_enabled,
        c.relforcerowsecurity as status_rls_forced,
        (
          select count(*)::int
          from pg_catalog.pg_policy pol
          where pol.polrelid = c.oid
        ) as status_policy_count,
        pg_catalog.has_table_privilege(p.proowner, c.oid, 'SELECT') as owner_status_select,
        pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anon_status_select,
        pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_status_select,
        pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT') as service_status_select,
        pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE') as owner_exec,
        pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
        pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
        pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_exec,
        pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') as public_role_exec,
        exists (
          select 1
          from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
          where a.grantee = 0
            and a.privilege_type = 'EXECUTE'
        ) as public_acl_exec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles owner_role on owner_role.oid = p.proowner
      join pg_catalog.pg_class c on c.oid = 'public.direct_entry_employment_status_events'::pg_catalog.regclass
      join pg_catalog.pg_roles table_owner_role on table_owner_role.oid = c.relowner
      join pg_catalog.pg_proc facts_proc on facts_proc.oid = 'public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)'::pg_catalog.regprocedure
      join pg_catalog.pg_roles facts_owner_role on facts_owner_role.oid = facts_proc.proowner
      where p.oid = 'public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)'::pg_catalog.regprocedure
    `);
    assert.equal(catalogRows.length, 1, "direct_entry_workforce_reporting_scoped must exist in pg_proc");
    const cat = catalogRows[0];
    assert.equal(cat.signature, "direct_entry_workforce_reporting_scoped(uuid,uuid,jsonb)");
    assert.equal(cat.prosecdef, true, "RPC must be SECURITY DEFINER");
    assert.equal(cat.proc_owner, "postgres", "RPC owner must be the privileged migration owner role");
    assert.equal(cat.proc_owner, cat.status_table_owner, "RPC owner must match direct_entry_employment_status_events table owner");
    assert.equal(cat.proc_owner, cat.facts_rpc_owner, "RPC owner must match direct_entry_reporting_scoped_facts RPC owner");
    assert.equal(cat.status_rls_enabled, true, "direct_entry_employment_status_events must have RLS enabled");
    assert.equal(cat.status_rls_forced, true, "direct_entry_employment_status_events must have FORCE RLS enabled");
    assert.equal(cat.status_policy_count, 0, "direct_entry_employment_status_events must remain default-deny (zero permissive RLS policies)");
    assert.equal(cat.owner_status_select, true, "RPC owner must hold SELECT privilege on direct_entry_employment_status_events");
    assert.equal(Boolean(cat.owner_is_super || cat.owner_bypassrls), true, "RPC owner must bypass FORCE RLS on direct_entry_employment_status_events");
    assert.equal(cat.anon_status_select, false, "anon must not have SELECT on direct_entry_employment_status_events");
    assert.equal(cat.authenticated_status_select, false, "authenticated must not have SELECT on direct_entry_employment_status_events");
    assert.equal(cat.service_status_select, false, "service_role must not have direct SELECT on direct_entry_employment_status_events");
    assert.deepEqual(cat.proconfig, ["search_path=pg_catalog, public"], "search_path must be locked to pg_catalog, public");
    assert.equal(cat.owner_exec, true, "RPC owner retains EXECUTE");
    assert.equal(cat.service_exec, true, "service_role must have EXECUTE");
    assert.equal(cat.anon_exec, false, "anon must not have EXECUTE");
    assert.equal(cat.authenticated_exec, false, "authenticated must not have EXECUTE");
    assert.equal(cat.public_role_exec, false, "PUBLIC must not have EXECUTE");
    assert.equal(cat.public_acl_exec, false, "proacl must not contain a PUBLIC (grantee=0) EXECUTE entry");

    const TEAM_A_ID = uuid(11);
    const TEAM_B_ID = uuid(12);
    const REC_A1_ID = uuid(21);
    const REC_A2_ID = uuid(22);
    const REC_B1_ID = uuid(23);

    const AUTH_BOD = uuid(31);
    const AUTH_TEAM_A = uuid(32);
    const AUTH_OWN_A1 = uuid(33);
    const AUTH_DISABLED = uuid(34);

    const USER_BOD = uuid(41);
    const USER_TEAM_A = uuid(42);
    const USER_OWN_A1 = uuid(43);
    const USER_DISABLED = uuid(44);

    const REASON_ID = uuid(51);

    const EP_1 = uuid(101);
    const EP_2 = uuid(102);
    const EP_3 = uuid(103);
    const EP_4 = uuid(104);
    const EP_5_MISSING_EVENT = uuid(105);
    const EP_6_FUTURE = uuid(106);
    const EP_7_DELETED = uuid(107);
    const EP_8_VOIDED = uuid(108);
    const EP_9_DRAFT = uuid(109);

    for (const id of [AUTH_BOD, AUTH_TEAM_A, AUTH_OWN_A1, AUTH_DISABLED]) {
      await db.query("insert into auth.users (id) values ($1)", [id]);
    }
    await db.query(
      `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
       values
         ($1, $2, true, 'BoD Actor'),
         ($3, $4, true, 'Team A Leader'),
         ($5, $6, true, 'Recruiter A1 User'),
         ($7, $8, false, 'Disabled User')`,
      [USER_BOD, AUTH_BOD, USER_TEAM_A, AUTH_TEAM_A, USER_OWN_A1, AUTH_OWN_A1, USER_DISABLED, AUTH_DISABLED],
    );

    await db.query(
      "insert into public.teams (team_id, code, display_name) values ($1,'TEAM_A','Team A'), ($2,'TEAM_B','Team B')",
      [TEAM_A_ID, TEAM_B_ID],
    );
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name) values ($1,'Recruiter A1'), ($2,'Recruiter A2'), ($3,'Recruiter B1')",
      [REC_A1_ID, REC_A2_ID, REC_B1_ID],
    );
    for (const [rec, team] of [
      [REC_A1_ID, TEAM_A_ID],
      [REC_A2_ID, TEAM_A_ID],
      [REC_B1_ID, TEAM_B_ID],
    ]) {
      await db.query(
        "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1,'hrp','2020-01-01',true)",
        [rec],
      );
      await db.query(
        "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1,$2,'2020-01-01',true)",
        [rec, team],
      );
    }
    for (const [rec, key] of [
      [REC_A1_ID, "rec a1"],
      [REC_A2_ID, "rec a2"],
      [REC_B1_ID, "rec b1"],
    ]) {
      await db.query(
        "insert into public.recruiter_aliases (recruiter_id, reporting_key, valid_from) values ($1,$2,'2020-01-01')",
        [rec, key],
      );
    }
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name) values ('proj_a','Project A'), ('proj_b','Project B')",
    );

    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1,'all',null,'2020-01-01',true)",
      [USER_BOD],
    );
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1,'entry_admin','2020-01-01',true)",
      [USER_BOD],
    );
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1,'team',$2,'2020-01-01',true)",
      [USER_TEAM_A, TEAM_A_ID],
    );
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1,'entry_team','2020-01-01',true)",
      [USER_TEAM_A],
    );
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1,$2,true,'2020-01-01',true)",
      [USER_OWN_A1, REC_A1_ID],
    );
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1,'own',null,'2020-01-01',true)",
      [USER_OWN_A1],
    );
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1,'entry_own','2020-01-01',true)",
      [USER_OWN_A1],
    );
    await db.query(
      "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1, $2, 'Synthetic WF-01 status reason')",
      [REASON_ID, USER_BOD],
    );

    await insertEntry(db, {
      entry: EP_1,
      sub: uuid(201),
      cand: uuid(301),
      createdBy: USER_BOD,
      project: "proj_a",
      date: "2026-03-01",
      code: "hrp-2026-000001",
      recruiter: REC_A1_ID,
      team: TEAM_A_ID,
      labor: "TEMPORARY",
    });
    await insertEntry(db, {
      entry: EP_2,
      sub: uuid(202),
      cand: uuid(302),
      createdBy: USER_BOD,
      project: "proj_a",
      date: "2026-03-02",
      code: "hrp-2026-000002",
      recruiter: REC_A1_ID,
      team: TEAM_A_ID,
      labor: "PERMANENT",
    });
    await insertEntry(db, {
      entry: EP_3,
      sub: uuid(203),
      cand: uuid(303),
      createdBy: USER_BOD,
      project: "proj_b",
      date: "2026-03-04",
      code: "hrp-2026-000003",
      recruiter: REC_A2_ID,
      team: TEAM_A_ID,
      labor: "TEMPORARY",
    });
    await insertEntry(db, {
      entry: EP_4,
      sub: uuid(204),
      cand: uuid(304),
      createdBy: USER_BOD,
      project: "proj_b",
      date: "2026-02-20",
      code: "hrp-2026-000004",
      recruiter: REC_B1_ID,
      team: TEAM_B_ID,
      labor: "TEMPORARY",
    });
    await insertEntry(db, {
      entry: EP_5_MISSING_EVENT,
      sub: uuid(205),
      cand: uuid(305),
      createdBy: USER_BOD,
      project: "proj_a",
      date: "2026-03-03",
      code: "hrp-2026-000005",
      recruiter: REC_A2_ID,
      team: TEAM_A_ID,
      labor: "TEMPORARY",
    });
    await insertEntry(db, {
      entry: EP_6_FUTURE,
      sub: uuid(206),
      cand: uuid(306),
      createdBy: USER_BOD,
      project: "proj_a",
      date: "2026-03-18",
      code: "hrp-2026-000006",
      recruiter: REC_A1_ID,
      team: TEAM_A_ID,
      labor: "TEMPORARY",
    });
    await insertEntry(db, {
      entry: EP_7_DELETED,
      sub: uuid(201),
      existingSubmission: true,
      cand: uuid(307),
      createdBy: USER_BOD,
      project: "proj_a",
      date: "2026-03-01",
      code: "hrp-2026-000007",
      recruiter: REC_A1_ID,
      team: TEAM_A_ID,
      labor: "TEMPORARY",
      deletedAt: "2026-03-02T00:00:00Z",
    });
    await insertEntry(db, {
      entry: EP_8_VOIDED,
      sub: uuid(208),
      cand: uuid(308),
      createdBy: USER_BOD,
      project: "proj_a",
      date: "2026-03-01",
      code: "hrp-2026-000008",
      recruiter: REC_A1_ID,
      team: TEAM_A_ID,
      labor: "TEMPORARY",
      voidedAt: "2026-03-02T00:00:00Z",
      voidReasonId: REASON_ID,
    });
    await insertEntry(db, {
      entry: EP_9_DRAFT,
      sub: uuid(209),
      cand: uuid(309),
      createdBy: USER_BOD,
      project: "proj_a",
      date: "2026-03-01",
      code: "hrp-2026-000009",
      recruiter: REC_A1_ID,
      team: TEAM_A_ID,
      labor: "TEMPORARY",
      submit: false,
    });

    const statusEvents = [
      // EP_1: UNCONFIRMED (03-01) -> ON (03-05) -> OFF (03-12)
      { event_id: uuid(5101), entry_id: EP_1, status: "UNCONFIRMED", effective_date: "2026-03-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(5102), entry_id: EP_1, status: "ON", effective_date: "2026-03-05", leave_date: null, reason: null, version: 2, supersedes_event_id: null },
      { event_id: uuid(5103), entry_id: EP_1, status: "OFF", effective_date: "2026-03-12", leave_date: "2026-03-12", reason: "Nghỉ cá nhân", version: 3, supersedes_event_id: null },

      // EP_2:
      // v1: UNCONFIRMED (03-02)
      // v2: ON (03-02) -> same-day transition UNCONFIRMED -> ON
      // v3: OFF (03-06)
      // v4: ON (03-06, supersedes v3) -> correction back to ON, creating consecutive active ON -> ON
      // v5: OFF (03-08) -> transition ON -> OFF #1
      { event_id: uuid(5201), entry_id: EP_2, status: "UNCONFIRMED", effective_date: "2026-03-02", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(5202), entry_id: EP_2, status: "ON", effective_date: "2026-03-02", leave_date: null, reason: null, version: 2, supersedes_event_id: null },
      { event_id: uuid(5203), entry_id: EP_2, status: "OFF", effective_date: "2026-03-06", leave_date: "2026-03-06", reason: "Nhầm", version: 3, supersedes_event_id: null },
      { event_id: uuid(5204), entry_id: EP_2, status: "ON", effective_date: "2026-03-06", leave_date: null, reason: null, version: 4, supersedes_event_id: uuid(5203) },
      { event_id: uuid(5205), entry_id: EP_2, status: "OFF", effective_date: "2026-03-08", leave_date: "2026-03-08", reason: "Nghỉ việc", version: 5, supersedes_event_id: null },

      // EP_3:
      // v1: UNCONFIRMED (03-04)
      // v2: ON (03-07)
      // v3: OFF (03-07, supersedes v2) -> active transition is UNCONFIRMED -> OFF on 03-07
      { event_id: uuid(5301), entry_id: EP_3, status: "UNCONFIRMED", effective_date: "2026-03-04", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(5302), entry_id: EP_3, status: "ON", effective_date: "2026-03-07", leave_date: null, reason: null, version: 2, supersedes_event_id: null },
      { event_id: uuid(5303), entry_id: EP_3, status: "OFF", effective_date: "2026-03-07", leave_date: "2026-03-07", reason: "Không nhận việc", version: 3, supersedes_event_id: uuid(5302) },

      // EP_4 (TEAM_B, started 2026-02-20):
      // v1: ON (02-20) -> initial ON in February
      // v2: OFF (03-09) -> transition ON -> OFF in March
      { event_id: uuid(5401), entry_id: EP_4, status: "ON", effective_date: "2026-02-20", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(5402), entry_id: EP_4, status: "OFF", effective_date: "2026-03-09", leave_date: "2026-03-09", reason: "Nghỉ", version: 2, supersedes_event_id: null },

      // EP_5_MISSING_EVENT has NO events in direct_entry_employment_status_events!

      // EP_6_FUTURE (first_work_date 2026-03-18):
      { event_id: uuid(5601), entry_id: EP_6_FUTURE, status: "ON", effective_date: "2026-03-18", leave_date: null, reason: null, version: 1, supersedes_event_id: null },

      // Excluded episodes (deleted, voided, draft) also have ON events that must NEVER be counted:
      { event_id: uuid(5701), entry_id: EP_7_DELETED, status: "ON", effective_date: "2026-03-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(5801), entry_id: EP_8_VOIDED, status: "ON", effective_date: "2026-03-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
      { event_id: uuid(5901), entry_id: EP_9_DRAFT, status: "ON", effective_date: "2026-03-01", leave_date: null, reason: null, version: 1, supersedes_event_id: null },
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

    // Verify current trigger `direct_entry_episode_status_guard` blocks non-superseding OFF -> ON
    // (`worker_episode_reopen_forbidden`, errcode 23505):
    const legacyOffToOnEvents = [
      { event_id: uuid(5206), entry_id: EP_2, status: "ON", effective_date: "2026-03-11", leave_date: null, reason: null, version: 6, supersedes_event_id: null },
      { event_id: uuid(5207), entry_id: EP_2, status: "OFF", effective_date: "2026-03-14", leave_date: "2026-03-14", reason: "Hết đợt", version: 7, supersedes_event_id: null },
    ];
    await assert.rejects(
      db.query(
        `insert into public.direct_entry_employment_status_events (
           event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
           version, actor_user_id, reason_id, supersedes_event_id
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          legacyOffToOnEvents[0].event_id,
          legacyOffToOnEvents[0].entry_id,
          legacyOffToOnEvents[0].status,
          legacyOffToOnEvents[0].effective_date,
          legacyOffToOnEvents[0].leave_date,
          legacyOffToOnEvents[0].reason,
          legacyOffToOnEvents[0].version,
          USER_BOD,
          REASON_ID,
          legacyOffToOnEvents[0].supersedes_event_id,
        ],
      ),
      (err) => err?.code === "23505" && String(err?.message).includes("worker_episode_reopen_forbidden"),
    );

    // Seed synthetic pre-#49 legacy OFF -> ON rows (temporarily disabling only `direct_entry_episode_status_guard`
    // in this ephemeral test DB, then immediately re-enabling it) to verify legacy OFF -> ON reporting parity:
    await db.exec(
      "alter table public.direct_entry_employment_status_events disable trigger direct_entry_episode_status_guard",
    );
    try {
      for (const ev of legacyOffToOnEvents) {
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
        statusEvents.push(ev);
      }
    } finally {
      await db.exec(
        "alter table public.direct_entry_employment_status_events enable trigger direct_entry_episode_status_guard",
      );
    }

    for (const clientRole of ["anon", "authenticated"]) {
      await db.exec(`set role ${clientRole}`);
      try {
        await assert.rejects(
          db.query(
            "select public.direct_entry_workforce_reporting_scoped($1::uuid, $2::uuid, '{}'::jsonb)",
            [AUTH_BOD, USER_BOD],
          ),
          (err) => err?.code === "42501",
          `${clientRole} must be denied EXECUTE on direct_entry_workforce_reporting_scoped`,
        );
      } finally {
        await db.exec("reset role");
      }
    }

    await db.exec("set role service_role");
    try {
      await assert.rejects(
        db.query("select count(*) from public.direct_entry_employment_status_events"),
        (err) => err?.code === "42501",
        "service_role must not have direct table SELECT on direct_entry_employment_status_events",
      );
    } finally {
      await db.exec("reset role");
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

    const allEpisodesForTs = [
      { entry_id: EP_1, first_work_date: "2026-03-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
      { entry_id: EP_2, first_work_date: "2026-03-02", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
      { entry_id: EP_3, first_work_date: "2026-03-04", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
      { entry_id: EP_4, first_work_date: "2026-02-20", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
      { entry_id: EP_5_MISSING_EVENT, first_work_date: "2026-03-03", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
      { entry_id: EP_6_FUTURE, first_work_date: "2026-03-18", submission_state: "SUBMITTED", deleted_at: null, voided_at: null },
      { entry_id: EP_7_DELETED, first_work_date: "2026-03-01", submission_state: "SUBMITTED", deleted_at: "2026-03-02T00:00:00Z", voided_at: null },
      { entry_id: EP_8_VOIDED, first_work_date: "2026-03-01", submission_state: "SUBMITTED", deleted_at: null, voided_at: "2026-03-02T00:00:00Z" },
      { entry_id: EP_9_DRAFT, first_work_date: "2026-03-01", submission_state: "DRAFT", deleted_at: null, voided_at: null },
    ];

    for (const [from, to] of [
      ["2026-03-01", "2026-03-03"],
      ["2026-03-01", "2026-03-07"],
      ["2026-03-01", "2026-03-15"],
    ]) {
      const dbRaw = await callRpc(AUTH_BOD, USER_BOD, { from, to });
      const parsed = parseWorkforceReportingPayload(dbRaw);
      assert.equal(parsed.status, "ready", `RPC payload for ${from}..${to} must be valid`);

      const tsExpected = evaluateWorkforceSnapshotAndTransitions({
        episodes: allEpisodesForTs,
        events: statusEvents,
        filters: { from, to },
      });

      assert.deepEqual(parsed.snapshot, tsExpected.snapshot, `DB snapshot must match TS evaluator at ${to}`);
      assert.deepEqual(
        parsed.transitions,
        tsExpected.transitions,
        `DB transitions must match TS evaluator for ${from}..${to}`,
      );
      assert.deepEqual(
        parsed.balance,
        tsExpected.balance,
        `DB balance must match TS evaluator for ${from}..${to}`,
      );
      assert.deepEqual(
        parsed.waiting,
        tsExpected.waiting,
        `DB waiting metrics must match TS evaluator for ${from}..${to}`,
      );
    }

    // Verify exact numbers on 2026-03-01 .. 2026-03-15 for `all`:
    const march15 = parseWorkforceReportingPayload(
      await callRpc(AUTH_BOD, USER_BOD, { from: "2026-03-01", to: "2026-03-15" }),
    );
    assert.equal(march15.status, "ready");
    if (march15.status === "ready") {
      assert.equal(march15.snapshot.eligibleEpisodeTotal, 5);
      assert.equal(march15.snapshot.onCount, 0);
      assert.equal(march15.snapshot.unconfirmedCount, 0);
      assert.equal(march15.snapshot.offCount, 4);
      assert.equal(march15.snapshot.unknownCount, 1);
      assert.equal(march15.snapshot.futureEpisodeCount, 1);

      assert.equal(march15.transitions.applicable, true);
      if (march15.transitions.applicable) {
        assert.deepEqual(march15.transitions.initial.total, { eventCount: 3, episodeCount: 3 });
        assert.deepEqual(march15.transitions.initial.unconfirmed, { eventCount: 3, episodeCount: 3 });
        assert.deepEqual(march15.transitions.initial.on, { eventCount: 0, episodeCount: 0 });
        assert.equal("off" in march15.transitions.initial, false);
        assert.deepEqual(march15.transitions.pairs.unconfirmedToOn, { eventCount: 2, episodeCount: 2 });
        assert.deepEqual(march15.transitions.pairs.unconfirmedToOff, { eventCount: 1, episodeCount: 1 });
        assert.deepEqual(march15.transitions.pairs.onToOff, { eventCount: 4, episodeCount: 3 });
        assert.deepEqual(march15.transitions.pairs.offToOn, { eventCount: 1, episodeCount: 1 });
        assert.equal(march15.transitions.totals.noopRepeatEventCount, 1);
        assert.equal(march15.transitions.totals.transitionEventCount, 8);
        assert.equal(march15.transitions.totals.transitionEpisodeCount, 4);
      }
    }

    // Verify table ACL, RLS, and append-only triggers on public.direct_entry_employment_status_events
    // and function EXECUTE ACL on public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb):
    const { rows: rlsRows } = await db.query(
      `select c.relrowsecurity, c.relforcerowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'direct_entry_employment_status_events'`,
    );
    assert.equal(rlsRows.length, 1);
    assert.equal(rlsRows[0].relrowsecurity, true);
    assert.equal(rlsRows[0].relforcerowsecurity, true);

    const { rows: tablePrivRows } = await db.query(
      `select
         r.rolname,
         has_table_privilege(r.rolname, 'public.direct_entry_employment_status_events', 'SELECT') as can_select,
         has_table_privilege(r.rolname, 'public.direct_entry_employment_status_events', 'INSERT') as can_insert,
         has_table_privilege(r.rolname, 'public.direct_entry_employment_status_events', 'UPDATE') as can_update,
         has_table_privilege(r.rolname, 'public.direct_entry_employment_status_events', 'DELETE') as can_delete
       from pg_roles r
       where r.rolname in ('anon', 'authenticated', 'service_role')
       order by r.rolname`,
    );
    for (const row of tablePrivRows) {
      assert.equal(row.can_select, false, `${row.rolname} must not have SELECT on direct_entry_employment_status_events`);
      assert.equal(row.can_insert, false, `${row.rolname} must not have INSERT on direct_entry_employment_status_events`);
      assert.equal(row.can_update, false, `${row.rolname} must not have UPDATE on direct_entry_employment_status_events`);
      assert.equal(row.can_delete, false, `${row.rolname} must not have DELETE on direct_entry_employment_status_events`);
    }

    const { rows: fnPrivRows } = await db.query(
      `select
         has_function_privilege('anon', 'public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)', 'EXECUTE') as anon_exec,
         has_function_privilege('authenticated', 'public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)', 'EXECUTE') as auth_exec,
         has_function_privilege('service_role', 'public.direct_entry_workforce_reporting_scoped(uuid, uuid, jsonb)', 'EXECUTE') as svc_exec`,
    );
    assert.equal(fnPrivRows[0].anon_exec, false);
    assert.equal(fnPrivRows[0].auth_exec, false);
    assert.equal(fnPrivRows[0].svc_exec, true);

    await assert.rejects(
      db.query(
        "update public.direct_entry_employment_status_events set status = 'OFF' where event_id = $1",
        [uuid(5101)],
      ),
      (err) => err?.code === "55000",
    );
    await assert.rejects(
      db.query(
        "delete from public.direct_entry_employment_status_events where event_id = $1",
        [uuid(5101)],
      ),
      (err) => err?.code === "55000",
    );

    // Scope isolation (`team` and `own` and `team_bucket`):
    const teamAMarch15 = parseWorkforceReportingPayload(
      await callRpc(AUTH_TEAM_A, USER_TEAM_A, { from: "2026-03-01", to: "2026-03-15" }),
    );
    assert.equal(teamAMarch15.status, "ready");
    if (teamAMarch15.status === "ready") {
      assert.equal(teamAMarch15.snapshot.eligibleEpisodeTotal, 4);
      assert.equal(teamAMarch15.snapshot.offCount, 3);
      assert.equal(teamAMarch15.snapshot.unknownCount, 1);
      assert.equal(teamAMarch15.snapshot.futureEpisodeCount, 1);
      if (teamAMarch15.transitions.applicable) {
        assert.deepEqual(teamAMarch15.transitions.pairs.onToOff, { eventCount: 3, episodeCount: 2 });
      }
    }

    const ownA1March15 = parseWorkforceReportingPayload(
      await callRpc(AUTH_OWN_A1, USER_OWN_A1, { from: "2026-03-01", to: "2026-03-15" }),
    );
    assert.equal(ownA1March15.status, "ready");
    if (ownA1March15.status === "ready") {
      assert.equal(ownA1March15.snapshot.eligibleEpisodeTotal, 2);
      assert.equal(ownA1March15.snapshot.offCount, 2);
      assert.equal(ownA1March15.snapshot.unknownCount, 0);
      assert.equal(ownA1March15.snapshot.futureEpisodeCount, 1);
    }

    const bodTeamB = parseWorkforceReportingPayload(
      await callRpc(AUTH_BOD, USER_BOD, {
        from: "2026-03-01",
        to: "2026-03-15",
        team_bucket: "team:TEAM_B",
      }),
    );
    assert.equal(bodTeamB.status, "ready");
    if (bodTeamB.status === "ready") {
      assert.equal(bodTeamB.snapshot.eligibleEpisodeTotal, 1);
      assert.equal(bodTeamB.snapshot.offCount, 1);
    }

    await assert.rejects(
      callRpc(AUTH_TEAM_A, USER_TEAM_A, {
        from: "2026-03-01",
        to: "2026-03-15",
        team_bucket: "team:TEAM_B",
      }),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      callRpc(AUTH_TEAM_A, USER_TEAM_A, {
        from: "2026-03-01",
        to: "2026-03-15",
        team_bucket: "unknown",
      }),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      callRpc(AUTH_OWN_A1, USER_OWN_A1, {
        from: "2026-03-01",
        to: "2026-03-15",
        team_bucket: "team:TEAM_A",
      }),
      (err) => err?.code === "42501",
    );
    await assert.rejects(callRpc(AUTH_DISABLED, USER_DISABLED, {}), (err) => err?.code === "42501");

    // All-time / current HCM date resolution:
    const allTimeRes = await resolveWorkforceReportingForActor({
      actor: { auth_subject: AUTH_BOD, app_user_id: USER_BOD },
      filters: {},
      expectedAudienceKind: "all",
      callWorkforceRpc: async (args) => ({
        data: await callRpc(args.p_auth_subject, args.p_app_user_id, args.p_filters),
      }),
    });
    assert.equal(allTimeRes.status, "ready");
    if (allTimeRes.status === "ready") {
      assert.equal(allTimeRes.snapshot.asOfSource, "current_hcm_date");
      assert.equal(allTimeRes.snapshot.eligibleEpisodeTotal, 6);
      assert.equal(allTimeRes.transitions.applicable, false);
      if (!allTimeRes.transitions.applicable) {
        assert.equal(allTimeRes.transitions.reason, "all_time");
      }
    }
  } finally {
    await db.close();
  }
});
