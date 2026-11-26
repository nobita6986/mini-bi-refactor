import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

import {
  HF_WORKER_EDIT_HISTORY_ADDED_RPC_SIGNATURES,
  HF_WORKER_EDIT_HISTORY_NAMES_AND_EMPLOYEE_CODE_MIGRATION_NAME,
  HF_WORKER_EDIT_HISTORY_RETIRED_RPC_SIGNATURES,
  S0_T1_C_MIGRATION_NAME,
  migrationSqlForTransaction,
  verifyS0T1CSecurityPostconditions,
} from "./lib/migration-validation.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const ADMIN = {
  auth: "14000000-0000-4000-8000-000000000001",
  app: "24000000-0000-4000-8000-000000000001",
  email: "lienvu@hrpartner.vn",
  name: "Admin History Viewer",
};

const NON_ADMIN = {
  auth: "14000000-0000-4000-8000-000000000002",
  app: "24000000-0000-4000-8000-000000000002",
  email: "plain.admin@hrpartner.vn",
  name: "Admin Without History Cap",
};

const RECRUITER_ACTOR = {
  auth: "14000000-0000-4000-8000-000000000003",
  app: "24000000-0000-4000-8000-000000000003",
  email: "recruiter.only@hrpartner.vn",
  name: "Recruiter Only",
};

const TEAM_1 = "94000000-0000-4000-8000-000000000101";
const TEAM_2 = "94000000-0000-4000-8000-000000000102";
const TEAM_3 = "94000000-0000-4000-8000-000000000103";
const TEAM_INACTIVE = "94000000-0000-4000-8000-000000000104";
const TEAM_ORPHAN = "94000000-0000-4000-8000-000000000199";

const REC_A = "93000000-0000-4000-8000-000000000101";
const REC_B = "93000000-0000-4000-8000-000000000102";
const REC_C = "93000000-0000-4000-8000-000000000103";
const REC_INACTIVE = "93000000-0000-4000-8000-000000000104";
const REC_ORPHAN = "93000000-0000-4000-8000-000000000199";

const PROJECT_1 = "hf_proj_alpha";
const PROJECT_2 = "hf_proj_beta";

let seq = 1;
function nextUuid(prefix = "aa000000-0000-4000-8000") {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `${prefix}-${hex}`;
}

async function createMigratedDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const appliedMap = new Map();
  let s0Sql = "";
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    if (name === S0_T1_C_MIGRATION_NAME) {
      s0Sql = sql;
    }
    await db.exec(migrationSqlForTransaction(sql));
    appliedMap.set(name, "applied");
  }
  return { db, names, appliedMap, s0Sql };
}

async function seedActorsAndCatalog(db) {
  for (const actor of [ADMIN, NON_ADMIN, RECRUITER_ACTOR]) {
    await db.query("insert into auth.users(id, email) values ($1, $2)", [
      actor.auth,
      actor.email,
    ]);
    await db.query(
      "insert into public.direct_entry_app_users(app_user_id, auth_subject, enabled, display_name) values ($1, $2, true, $3)",
      [actor.app, actor.auth, actor.name],
    );
  }

  // ADMIN gets worker_edit_history_view @ ALL (paired)
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from, is_current) values " +
      "($1, 'entry_admin', '2020-01-01', true), " +
      "($1, 'worker_edit_history_view', '2020-01-01', true)",
    [ADMIN.app],
  );
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id, scope_kind, valid_from, is_current) values ($1, 'all', '2020-01-01', true)",
    [ADMIN.app],
  );

  // NON_ADMIN has entry_admin @ ALL, but NOT worker_edit_history_view
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from, is_current) values ($1, 'entry_admin', '2020-01-01', true)",
    [NON_ADMIN.app],
  );
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id, scope_kind, valid_from, is_current) values ($1, 'all', '2020-01-01', true)",
    [NON_ADMIN.app],
  );

  // RECRUITER_ACTOR has only own entry capabilities
  await db.query(
    "insert into public.direct_entry_capability_grants(app_user_id, capability, valid_from, is_current) values " +
      "($1, 'entry_create', '2020-01-01', true), ($1, 'entry_own', '2020-01-01', true)",
    [RECRUITER_ACTOR.app],
  );
  await db.query(
    "insert into public.direct_entry_scope_grants(app_user_id, scope_kind, valid_from, is_current) values ($1, 'own', '2020-01-01', true)",
    [RECRUITER_ACTOR.app],
  );

  // Projects
  await db.query(
    "insert into public.direct_entry_projects(project_id, display_name) values ($1, $2), ($3, $4)",
    [PROJECT_1, "Dự án Alpha", PROJECT_2, "Dự án Beta"],
  );

  // Teams (active + one that will be deactivated after historical entry creation)
  await db.query(
    "insert into public.teams(team_id, code, display_name, active) values " +
      "($1, 'hf_t1', 'Team T1', true), " +
      "($2, 'hf_t2', 'Team T2', true), " +
      "($3, 'hf_t3', 'Team T3', true), " +
      "($4, 'hf_t_inactive', 'Team Ngừng Hoạt Động', true)",
    [TEAM_1, TEAM_2, TEAM_3, TEAM_INACTIVE],
  );

  // Recruiters (active + one that will be deactivated after historical entry creation)
  await db.query(
    "insert into public.recruiters(recruiter_id, display_name, active) values " +
      "($1, 'Nguyễn Văn A', true), " +
      "($2, 'Trần Thị B', true), " +
      "($3, 'Lê Văn C', true), " +
      "($4, 'Phạm Thị Nghỉ Việc', true)",
    [REC_A, REC_B, REC_C, REC_INACTIVE],
  );

  for (const [recId, teamId] of [
    [REC_A, TEAM_1],
    [REC_B, TEAM_2],
    [REC_C, TEAM_3],
    [REC_INACTIVE, TEAM_INACTIVE],
  ]) {
    await db.query(
      "insert into public.recruiter_provider_memberships(recruiter_id, provider_type, valid_from, is_current) values ($1, 'hrp', '2020-01-01', true)",
      [recId],
    );
    await db.query(
      "insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from, is_current) values ($1, $2, '2020-01-01', true)",
      [recId, teamId],
    );
  }
}

async function seedWorkerEntry(
  db,
  {
    employeeCode,
    displayName,
    nationalId,
    projectId,
    recruiterId,
    teamId,
    firstWorkDate = "2026-11-01",
  },
) {
  const candId = nextUuid("cc000000-0000-4000-8000");
  const subId = nextUuid("dd000000-0000-4000-8000");
  const entryId = nextUuid("ee000000-0000-4000-8000");
  const workerDetails = {
    display_name: displayName,
    date_of_birth: { state: "provided", value: "1996-03-15" },
    national_id: { state: "provided", value: nationalId },
    address: { state: "provided", value: "TP.HCM" },
    phone: { state: "provided", value: "0901234567" },
  };
  await db.query("begin");
  try {
    await db.query("insert into public.direct_entry_candidates(candidate_id) values ($1)", [candId]);
    await db.query(
      "insert into public.direct_entry_submissions(submission_id, created_by_user_id, state) values ($1, $2, 'DRAFT')",
      [subId, ADMIN.app],
    );
    await db.query(
      `insert into public.direct_entries(
         entry_id, submission_id, candidate_id, created_by_user_id, project_id,
         first_work_date, employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type
       ) values ($1, $2, $3, $4, $5, $6::date, $7, $8::jsonb, $9, $10, 'hrp', 'TEMPORARY')`,
      [
        entryId,
        subId,
        candId,
        ADMIN.app,
        projectId,
        firstWorkDate,
        employeeCode,
        JSON.stringify(workerDetails),
        recruiterId,
        teamId,
      ],
    );
    await db.query("commit");
  } catch (err) {
    await db.query("rollback");
    throw err;
  }
  return { entryId, subId, candId, workerDetails };
}

test("HF Worker Edit History: migration hygiene, ACL postconditions, per-snapshot name resolution, and employee_code search", async () => {
  const { db, names, appliedMap, s0Sql } = await createMigratedDb();
  assert.ok(
    names.includes(HF_WORKER_EDIT_HISTORY_NAMES_AND_EMPLOYEE_CODE_MIGRATION_NAME),
    "migration file must exist in supabase/migrations",
  );

  // 1. S0-T1-C dynamic postconditions, index & single-overload verification
  const postconditions = await verifyS0T1CSecurityPostconditions(db, s0Sql, appliedMap);
  assert.equal(postconditions.ok, true, `S0-T1-C postconditions failed: ${postconditions.reason}`);

  const { rows: idxRows } = await db.query(
    "select indexname from pg_indexes where schemaname = 'public' and tablename = 'direct_entries' and indexname = 'direct_entries_employee_code_lower_idx'",
  );
  assert.equal(idxRows.length, 1, "direct_entries_employee_code_lower_idx must exist");

  for (const retiredSig of HF_WORKER_EDIT_HISTORY_RETIRED_RPC_SIGNATURES) {
    const { rows } = await db.query("select pg_catalog.to_regprocedure($1)::text as sig", [retiredSig]);
    assert.equal(rows[0].sig, null, `retired signature must be dropped: ${retiredSig}`);
  }
  for (const addedSig of HF_WORKER_EDIT_HISTORY_ADDED_RPC_SIGNATURES) {
    const { rows } = await db.query("select pg_catalog.to_regprocedure($1)::text as sig", [addedSig]);
    assert.ok(rows[0].sig, `added signature must exist: ${addedSig}`);
  }

  await seedActorsAndCatalog(db);

  const { rows: [{ today_str: todayStr, from_str: fromStr, over93_from_str: over93FromStr }] } = await db.query(
    `select to_char((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') as today_str,
            to_char((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 30, 'YYYY-MM-DD') as from_str,
            to_char((clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date - 100, 'YYYY-MM-DD') as over93_from_str`,
  );
  const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

  // 2. Entry 1: Recruiter A -> B (team T1 -> T2), then later B -> C (team T2 -> T3)
  const worker1 = await seedWorkerEntry(db, {
    employeeCode: "hrp-2026-000123",
    displayName: "Nguyễn Văn Một",
    nationalId: "079096000123",
    projectId: PROJECT_1,
    recruiterId: REC_A,
    teamId: TEAM_1,
  });

  const reason1Id = nextUuid("f1000000-0000-4000-8000");
  const reason2Id = nextUuid("f2000000-0000-4000-8000");
  const reason3Id = nextUuid("f3000000-0000-4000-8000");
  await db.query(
    "insert into public.direct_entry_restricted_reasons(reason_id, actor_user_id, reason_text) values " +
      "($1, $4, 'Khởi tạo'), ($2, $4, 'Chuyển người tuyển A -> B'), ($3, $4, 'Chuyển người tuyển B -> C')",
    [reason1Id, reason2Id, reason3Id, ADMIN.app],
  );

  // Rev 1 (NEW_ENTRY @ A / T1)
  const { rows: rev1Rows } = await db.query(
    "select public.direct_entry_write_revision($1::uuid, $2::uuid, $3::uuid, null::jsonb, public.worker_edit_history_snapshot($1::uuid), 1) as revision_id",
    [worker1.entryId, ADMIN.app, reason1Id],
  );
  const rev1Id = rev1Rows[0].revision_id;
  await pause();

  // Update A/T1 -> B/T2 in a single statement/tx so capture_before trigger records before_snapshot (A/T1)
  await db.query("begin");
  await db.query(
    "update public.direct_entries set recruiter_id = $2, team_id = $3, version = 2 where entry_id = $1",
    [worker1.entryId, REC_B, TEAM_2],
  );
  const { rows: rev2Rows } = await db.query(
    `select public.direct_entry_write_revision(
       $1::uuid, $2::uuid, $3::uuid,
       jsonb_build_object('recruiter_id', $4::uuid, 'team_id', $5::uuid),
       jsonb_build_object('recruiter_id', $6::uuid, 'team_id', $7::uuid),
       2
     ) as revision_id`,
    [worker1.entryId, ADMIN.app, reason2Id, REC_A, TEAM_1, REC_B, TEAM_2],
  );
  const rev2Id = rev2Rows[0].revision_id;
  await db.query(
    `insert into public.direct_entry_audit_events(
       revision_id, resource_ref, app_user_id, action, capability, scope_kind, outcome, reason_id, changed_fields
     ) values ($1, $2, $3, 'entry_privileged_edit', 'entry_privileged_edit', 'all', 'APPLIED', $4, array['recruiter_id', 'team_id'])`,
    [rev2Id, worker1.entryId, ADMIN.app, reason2Id],
  );
  await db.query("commit");
  await pause();

  // Interleaved revision for another worker (placed between rev2 and rev3)
  const workerOther = await seedWorkerEntry(db, {
    employeeCode: "hrp-2026-000124",
    displayName: "Lê Thị Khác",
    nationalId: "079096000124",
    projectId: PROJECT_1,
    recruiterId: REC_C,
    teamId: TEAM_3,
  });
  await db.query(
    "select public.direct_entry_write_revision($1::uuid, $2::uuid, $3::uuid, null::jsonb, public.worker_edit_history_snapshot($1::uuid), 1) as revision_id",
    [workerOther.entryId, ADMIN.app, reason1Id],
  );
  await pause();

  // Update B/T2 -> C/T3 so current entry is C / T3 (rev3 is latest)
  await db.query("begin");
  await db.query(
    "update public.direct_entries set recruiter_id = $2, team_id = $3, version = 3 where entry_id = $1",
    [worker1.entryId, REC_C, TEAM_3],
  );
  const { rows: rev3Rows } = await db.query(
    `select public.direct_entry_write_revision(
       $1::uuid, $2::uuid, $3::uuid,
       jsonb_build_object('recruiter_id', $4::uuid, 'team_id', $5::uuid),
       jsonb_build_object('recruiter_id', $6::uuid, 'team_id', $7::uuid),
       3
     ) as revision_id`,
    [worker1.entryId, ADMIN.app, reason3Id, REC_B, TEAM_2, REC_C, TEAM_3],
  );
  const rev3Id = rev3Rows[0].revision_id;
  await db.query("commit");

  // Capture raw stored rows before reading revision detail
  const { rows: snapBeforeRead } = await db.query(
    "select before_snapshot, after_snapshot from public.direct_entry_worker_revision_snapshots where revision_id = $1",
    [rev2Id],
  );
  const { rows: revRowBeforeRead } = await db.query(
    "select before_snapshot, after_snapshot from public.direct_entry_revisions where revision_id = $1",
    [rev2Id],
  );
  const { rows: auditBeforeRead } = await db.query(
    "select event_id, action, changed_fields from public.direct_entry_audit_events where revision_id = $1",
    [rev2Id],
  );

  // Read rev2 detail (A->B while current is C, T1->T2 while current is T3)
  const { rows: [{ detail: rev2Detail }] } = await db.query(
    "select public.worker_edit_history_get_revision($1::uuid, $2::uuid, $3::uuid, $4::uuid) as detail",
    [ADMIN.auth, ADMIN.app, worker1.entryId, rev2Id],
  );
  assert.equal(rev2Detail.before_snapshot.recruiter_id, REC_A);
  assert.equal(rev2Detail.before_snapshot.recruiter_name, "Nguyễn Văn A");
  assert.equal(rev2Detail.before_snapshot.team_id, TEAM_1);
  assert.equal(rev2Detail.before_snapshot.team_name, "Team T1");

  assert.equal(rev2Detail.after_snapshot.recruiter_id, REC_B);
  assert.equal(rev2Detail.after_snapshot.recruiter_name, "Trần Thị B");
  assert.equal(rev2Detail.after_snapshot.team_id, TEAM_2);
  assert.equal(rev2Detail.after_snapshot.team_name, "Team T2");

  assert.equal(rev2Detail.current_snapshot.recruiter_id, REC_C);
  assert.equal(rev2Detail.current_snapshot.recruiter_name, "Lê Văn C");
  assert.equal(rev2Detail.current_snapshot.team_id, TEAM_3);
  assert.equal(rev2Detail.current_snapshot.team_name, "Team T3");

  assert.deepEqual(rev2Detail.resolved_recruiters, {
    [REC_A]: "Nguyễn Văn A",
    [REC_B]: "Trần Thị B",
    [REC_C]: "Lê Văn C",
  });
  assert.deepEqual(rev2Detail.resolved_teams, {
    [TEAM_1]: "Team T1",
    [TEAM_2]: "Team T2",
    [TEAM_3]: "Team T3",
  });

  // Assert original snapshot rows & audit rows remain untouched
  const { rows: snapAfterRead } = await db.query(
    "select before_snapshot, after_snapshot from public.direct_entry_worker_revision_snapshots where revision_id = $1",
    [rev2Id],
  );
  const { rows: revRowAfterRead } = await db.query(
    "select before_snapshot, after_snapshot from public.direct_entry_revisions where revision_id = $1",
    [rev2Id],
  );
  const { rows: auditAfterRead } = await db.query(
    "select event_id, action, changed_fields from public.direct_entry_audit_events where revision_id = $1",
    [rev2Id],
  );
  assert.deepEqual(snapAfterRead, snapBeforeRead, "stored snapshot row must remain untouched");
  assert.deepEqual(revRowAfterRead, revRowBeforeRead, "stored revision row must remain untouched");
  assert.deepEqual(auditAfterRead, auditBeforeRead, "stored audit rows must remain untouched");

  // 3. Legacy snapshot with ONLY recruiter_id / team_id where recruiter & team are inactive (active = false)
  //    AND orphan/malformed UUIDs in snapshots
  const workerInactive = await seedWorkerEntry(db, {
    employeeCode: "hrp-2026-000456",
    displayName: "Trần Văn Ngừng",
    nationalId: "079096000456",
    projectId: PROJECT_2,
    recruiterId: REC_INACTIVE,
    teamId: TEAM_INACTIVE,
  });

  // Deactivate recruiter and team after entry creation to simulate historical inactive catalog items
  await db.query("update public.recruiters set active = false where recruiter_id = $1", [REC_INACTIVE]);
  await db.query("update public.teams set active = false where team_id = $1", [TEAM_INACTIVE]);

  const legacyRevRes = await db.query(
    `insert into public.direct_entry_revisions(
       entry_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot, created_at
     ) values (
       $1, 10, $2, $3,
       jsonb_build_object('recruiter_id', $4::text, 'team_id', $5::text),
       jsonb_build_object('recruiter_id', $6::text, 'team_id', $7::text),
       clock_timestamp() - interval '2 days'
     ) returning revision_id`,
    [
      workerInactive.entryId,
      ADMIN.app,
      reason1Id,
      REC_ORPHAN,
      TEAM_ORPHAN,
      REC_INACTIVE,
      TEAM_INACTIVE,
    ],
  );
  const legacyRevId = legacyRevRes.rows[0].revision_id;

  const { rows: [{ detail: legacyDetail }] } = await db.query(
    "select public.worker_edit_history_get_revision($1::uuid, $2::uuid, $3::uuid, $4::uuid) as detail",
    [ADMIN.auth, ADMIN.app, workerInactive.entryId, legacyRevId],
  );
  assert.equal(legacyDetail.snapshot_state, "LEGACY_LIMITED");
  assert.deepEqual(
    legacyDetail.resolved_recruiters,
    { [REC_INACTIVE]: "Phạm Thị Nghỉ Việc" },
    "inactive recruiter must be resolved and orphan recruiter UUID omitted",
  );
  assert.deepEqual(
    legacyDetail.resolved_teams,
    { [TEAM_INACTIVE]: "Team Ngừng Hoạt Động" },
    "inactive team must be resolved and orphan team UUID omitted",
  );
  assert.equal(legacyDetail.resolved_recruiters[REC_ORPHAN], undefined);
  assert.equal(legacyDetail.resolved_teams[TEAM_ORPHAN], undefined);

  // Also test malformed non-UUID string in legacy snapshot does not raise 22P02
  const malformedRevRes = await db.query(
    `insert into public.direct_entry_revisions(
       entry_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot, created_at
     ) values (
       $1, 11, $2, $3,
       '{"recruiter_id":"not-a-uuid","team_id":"also-bad"}'::jsonb,
       '{"recruiter_id":"","team_id":null}'::jsonb,
       clock_timestamp() - interval '1 day'
     ) returning revision_id`,
    [workerInactive.entryId, ADMIN.app, reason1Id],
  );
  const { rows: [{ detail: malformedDetail }] } = await db.query(
    "select public.worker_edit_history_get_revision($1::uuid, $2::uuid, $3::uuid, $4::uuid) as detail",
    [ADMIN.auth, ADMIN.app, workerInactive.entryId, malformedRevRes.rows[0].revision_id],
  );
  assert.deepEqual(malformedDetail.resolved_recruiters, { [REC_INACTIVE]: "Phạm Thị Nghỉ Việc" });
  assert.deepEqual(malformedDetail.resolved_teams, { [TEAM_INACTIVE]: "Team Ngừng Hoạt Động" });

  // 4. Employee code exact/trimmed/case-insensitive/prefix/invalid/combined/pagination checks
  const { rows: [{ res: exactRes }] } = await db.query(
    `select public.worker_edit_history_search(
       p_auth_subject => $1::uuid,
       p_app_user_id => $2::uuid,
       p_from_date => $3::date,
       p_to_date => $4::date,
       p_employee_code => 'hrp-2026-000123'
     ) as res`,
    [ADMIN.auth, ADMIN.app, fromStr, todayStr],
  );
  assert.equal(exactRes.rows.length, 3);
  assert.ok(exactRes.rows.every((r) => r.employee_code === "hrp-2026-000123"));

  const { rows: [{ res: trimmedCaseRes }] } = await db.query(
    `select public.worker_edit_history_search(
       p_auth_subject => $1::uuid,
       p_app_user_id => $2::uuid,
       p_from_date => $3::date,
       p_to_date => $4::date,
       p_employee_code => '  HRP-2026-000123  '
     ) as res`,
    [ADMIN.auth, ADMIN.app, fromStr, todayStr],
  );
  assert.equal(trimmedCaseRes.rows.length, 3);
  assert.deepEqual(
    trimmedCaseRes.rows.map((r) => r.revision_id),
    exactRes.rows.map((r) => r.revision_id),
  );

  // Blank whitespace-only employee_code behaves as no filter
  const { rows: [{ res: blankCodeRes }] } = await db.query(
    `select public.worker_edit_history_search(
       p_auth_subject => $1::uuid,
       p_app_user_id => $2::uuid,
       p_from_date => $3::date,
       p_to_date => $4::date,
       p_employee_code => '   '
     ) as res`,
    [ADMIN.auth, ADMIN.app, fromStr, todayStr],
  );
  assert.equal(blankCodeRes.rows.length, 6, "blank employee_code must act as null/no filter");

  // Near-miss prefix & non-existent must return 0 rows
  for (const probeCode of ["hrp-2026-00012", "HRP-2026-999999"]) {
    const { rows: [{ res: emptyRes }] } = await db.query(
      `select public.worker_edit_history_search(
         p_auth_subject => $1::uuid,
         p_app_user_id => $2::uuid,
         p_from_date => $3::date,
         p_to_date => $4::date,
         p_employee_code => $5
       ) as res`,
      [ADMIN.auth, ADMIN.app, fromStr, todayStr, probeCode],
    );
    assert.equal(emptyRes.rows.length, 0, `${probeCode} must return 0 rows`);
    assert.equal(emptyRes.has_more, false);
    assert.equal(emptyRes.next_cursor, null);
  }

  // Invalid employee_code chars/length -> 22023
  for (const invalidCode of ["a".repeat(65), "hrp 2026", "hrp\t2026", "hrp\n2026", "hrp\u001f2026"]) {
    await assert.rejects(
      db.query(
        `select public.worker_edit_history_search(
           p_auth_subject => $1::uuid,
           p_app_user_id => $2::uuid,
           p_from_date => $3::date,
           p_to_date => $4::date,
           p_employee_code => $5
         )`,
        [ADMIN.auth, ADMIN.app, fromStr, todayStr, invalidCode],
      ),
      (err) => err?.code === "22023" && String(err?.message).includes("WORKER_EDIT_HISTORY_QUERY_INVALID"),
      `invalid employee_code ${JSON.stringify(invalidCode)} must reject with 22023`,
    );
  }

  // Combined filters: project + recruiter + action_group + 93-day window + employee_code
  const { rows: [{ res: comboMatch }] } = await db.query(
    `select public.worker_edit_history_search(
       p_auth_subject => $1::uuid,
       p_app_user_id => $2::uuid,
       p_from_date => $3::date,
       p_to_date => $4::date,
       p_project_query => $5,
       p_recruiter_query => $6,
       p_action_group => 'PROFILE_EDIT',
       p_employee_code => 'HRP-2026-000123'
     ) as res`,
    [ADMIN.auth, ADMIN.app, fromStr, todayStr, PROJECT_1, REC_C],
  );
  assert.equal(comboMatch.rows.length, 2, "rev2 and rev3 are PROFILE_EDIT for worker1");

  // Window > 93 days (to - from > 92) still rejected with 22023
  await assert.rejects(
    db.query(
      `select public.worker_edit_history_search(
         p_auth_subject => $1::uuid,
         p_app_user_id => $2::uuid,
         p_from_date => $3::date,
         p_to_date => $4::date,
         p_employee_code => 'hrp-2026-000123'
       )`,
      [ADMIN.auth, ADMIN.app, over93FromStr, todayStr],
    ),
    (err) => err?.code === "22023",
  );

  // Pagination BEFORE limit: page_size = 2 across interleaved revisions (rev3, workerOther, rev2, rev1)
  const { rows: [{ res: page1 }] } = await db.query(
    `select public.worker_edit_history_search(
       p_auth_subject => $1::uuid,
       p_app_user_id => $2::uuid,
       p_from_date => $3::date,
       p_to_date => $4::date,
       p_page_size => 2,
       p_employee_code => 'HRP-2026-000123'
     ) as res`,
    [ADMIN.auth, ADMIN.app, fromStr, todayStr],
  );
  assert.equal(page1.rows.length, 2);
  assert.equal(page1.has_more, true);
  assert.ok(page1.next_cursor);
  assert.deepEqual(page1.rows.map((r) => r.revision_id), [rev3Id, rev2Id]);

  const { rows: [{ res: page2 }] } = await db.query(
    `select public.worker_edit_history_search(
       p_auth_subject => $1::uuid,
       p_app_user_id => $2::uuid,
       p_from_date => $3::date,
       p_to_date => $4::date,
       p_page_size => 2,
       p_cursor => $5,
       p_employee_code => 'HRP-2026-000123'
     ) as res`,
    [ADMIN.auth, ADMIN.app, fromStr, todayStr, page1.next_cursor],
  );
  assert.equal(page2.rows.length, 1);
  assert.equal(page2.has_more, false);
  assert.equal(page2.next_cursor, null);
  assert.deepEqual(page2.rows.map((r) => r.revision_id), [rev1Id]);

  // Inactive recruiter name still shown cleanly in search list rows
  const { rows: [{ res: inactiveListRes }] } = await db.query(
    `select public.worker_edit_history_search(
       p_auth_subject => $1::uuid,
       p_app_user_id => $2::uuid,
       p_from_date => $3::date,
       p_to_date => $4::date,
       p_employee_code => 'hrp-2026-000456'
     ) as res`,
    [ADMIN.auth, ADMIN.app, fromStr, todayStr],
  );
  assert.equal(inactiveListRes.rows.length, 2);
  assert.ok(inactiveListRes.rows.every((r) => r.recruiter_name === "Phạm Thị Nghỉ Việc"));

  // List row fallback when recruiter row is missing (orphan recruiter_id on direct_entries)
  await db.query("begin");
  await db.query("alter table public.direct_entries disable trigger all");
  await db.query("alter table public.direct_entries drop constraint direct_entries_recruiter_id_fkey");
  await db.query("update public.direct_entries set recruiter_id = $2 where entry_id = $1", [
    workerInactive.entryId,
    REC_ORPHAN,
  ]);
  const { rows: [{ res: orphanListRes }] } = await db.query(
    `select public.worker_edit_history_search(
       p_auth_subject => $1::uuid,
       p_app_user_id => $2::uuid,
       p_from_date => $3::date,
       p_to_date => $4::date,
       p_employee_code => 'hrp-2026-000456'
     ) as res`,
    [ADMIN.auth, ADMIN.app, fromStr, todayStr],
  );
  assert.equal(orphanListRes.rows.length, 2);
  assert.ok(
    orphanListRes.rows.every((r) => r.recruiter_name === "Không tìm thấy tên người tuyển"),
    "missing recruiter in list view must fall back to 'Không tìm thấy tên người tuyển'",
  );
  await db.query("rollback");

  // 5. 6-arg positional, 11-arg positional & 11-arg named backward compatibility without 42725 ambiguity
  const { rows: [{ res: pos6 }] } = await db.query(
    "select public.worker_edit_history_search($1::uuid, $2::uuid, null, null, $3::date, $4::date) as res",
    [ADMIN.auth, ADMIN.app, fromStr, todayStr],
  );
  assert.equal(pos6.rows.length, 6);

  const { rows: [{ res: pos11 }] } = await db.query(
    "select public.worker_edit_history_search($1::uuid, $2::uuid, null, null, $3::date, $4::date, $5::text, null, null, 10, null) as res",
    [ADMIN.auth, ADMIN.app, fromStr, todayStr, PROJECT_2],
  );
  assert.equal(pos11.rows.length, 2);

  const { rows: [{ res: named11 }] } = await db.query(
    `select public.worker_edit_history_search(
       p_auth_subject => $1::uuid,
       p_app_user_id => $2::uuid,
       p_national_id => null,
       p_full_name => null,
       p_from_date => $3::date,
       p_to_date => $4::date,
       p_project_query => $5::text,
       p_recruiter_query => null,
       p_action_group => null,
       p_page_size => 10,
       p_cursor => null
     ) as res`,
    [ADMIN.auth, ADMIN.app, fromStr, todayStr, PROJECT_2],
  );
  assert.equal(named11.rows.length, 2);

  // 6. Unauthorized actors rejected with 42501
  for (const denied of [NON_ADMIN, RECRUITER_ACTOR]) {
    await assert.rejects(
      db.query(
        `select public.worker_edit_history_search(
           p_auth_subject => $1::uuid,
           p_app_user_id => $2::uuid,
           p_from_date => $3::date,
           p_to_date => $4::date,
           p_employee_code => 'hrp-2026-000123'
         )`,
        [denied.auth, denied.app, fromStr, todayStr],
      ),
      (err) => err?.code === "42501",
    );
    await assert.rejects(
      db.query(
        "select public.worker_edit_history_get_revision($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
        [denied.auth, denied.app, worker1.entryId, rev2Id],
      ),
      (err) => err?.code === "42501",
    );
  }
});
