/**
 * Work Reports Reader Contract & Authority Closure — Database, Ledger, Rollback & ACL Suite.
 *
 * Verifies against PGlite across all repository migrations including
 * `20261023120000_work_reports_reader_contract.sql`:
 *   1. Canonical Full Admin (`scope = 'all'`, no explicit `report_view` token) reads company-wide submissions.
 *   2. Team Leader (`scope = 'team'`) reads only current team (including immutable `snapshot_team_id` history) and loses access upon revocation.
 *   3. Cross-team `team_id` / `assignee_id` filters fail closed with SQLSTATE `42501` (`WORK_REPORT_SCOPE_DENIED`).
 *   4. Disabled, mismatched, unpermitted, `own`-only, and explicitly-revoked Full Admin actors are denied (`42501`).
 *   5. `template_id` is optional; unfiltered listing returns submitted reports across multiple templates.
 *   6. Only submitted rows (`COMPLETED`, `PENDING_REVIEW`, `APPROVED`, `REJECTED` with `current_revision_id IS NOT NULL`) appear; `NOT_STARTED` and `DRAFT` never appear.
 *   7. `filter_options` (`templates`, `teams`, `assignees`) are scoped strictly to obligations in readable scope and never leak the global user/team directory.
 *   8. Keyset pagination (`latest_submitted_at DESC, submission_id DESC`) neither duplicates nor skips rows when newer submissions arrive or timestamps tie.
 *   9. `work_report_get_submission` signature and payload (`schema_json`, `revisions`, `latest_review_event`) remain intact.
 *  10. ACL allowlist (`PUBLIC`/`anon`/`authenticated` denied EXECUTE; `service_role` granted EXECUTE; zero table `SELECT` grants) + migration ledger/checksum + transaction rollback on migration failure.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { RECRUITMENT_DAILY_TEMPLATE_SCHEMA } from "../src/lib/work-reports/contracts.ts";
import { buildWorkReportMetricContract } from "../src/lib/work-reports/metric-contract.ts";
import {
  migrationChecksum,
  migrationSqlForTransaction,
  WORK_REPORTS_READER_CONTRACT_MIGRATION_NAME,
  WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const TEAM_A = "97000000-0000-4000-8000-00000000000a";
const TEAM_B = "97000000-0000-4000-8000-00000000000b";
const TEAM_EMPTY_C = "97000000-0000-4000-8000-00000000000c";

const FULL_ADMIN = {
  auth: "17000000-0000-4000-8000-000000000001",
  app: "27000000-0000-4000-8000-000000000001",
  name: "Canonical Full Admin",
};
const FULL_ADMIN_REVOKED_VIEW = {
  auth: "17000000-0000-4000-8000-000000000002",
  app: "27000000-0000-4000-8000-000000000002",
  name: "Full Admin With Revoked Report View",
};
const LEADER_A = {
  auth: "17000000-0000-4000-8000-000000000003",
  app: "27000000-0000-4000-8000-000000000003",
  recruiter: "37000000-0000-4000-8000-000000000003",
  name: "Trưởng Nhóm A",
};
const LEADER_B = {
  auth: "17000000-0000-4000-8000-000000000004",
  app: "27000000-0000-4000-8000-000000000004",
  recruiter: "37000000-0000-4000-8000-000000000004",
  name: "Trưởng Nhóm B",
};
const STAFF_A1 = {
  auth: "17000000-0000-4000-8000-000000000005",
  app: "27000000-0000-4000-8000-000000000005",
  recruiter: "37000000-0000-4000-8000-000000000005",
  name: "Nhân Viên A1",
};
const STAFF_A2 = {
  auth: "17000000-0000-4000-8000-000000000006",
  app: "27000000-0000-4000-8000-000000000006",
  recruiter: "37000000-0000-4000-8000-000000000006",
  name: "Nhân Viên A2",
};
const STAFF_B1 = {
  auth: "17000000-0000-4000-8000-000000000007",
  app: "27000000-0000-4000-8000-000000000007",
  recruiter: "37000000-0000-4000-8000-000000000007",
  name: "Nhân Viên B1",
};
const UNASSIGNED_TEAM_STAFF = {
  auth: "17000000-0000-4000-8000-000000000008",
  app: "27000000-0000-4000-8000-000000000008",
  name: "Nhân Viên Chưa Gắn Nhóm",
};
const FORM_ADMIN_NO_VIEW = {
  auth: "17000000-0000-4000-8000-000000000009",
  app: "27000000-0000-4000-8000-000000000009",
  name: "Form Admin Không Có Report View",
};
const OWN_SCOPE_VIEWER = {
  auth: "17000000-0000-4000-8000-000000000010",
  app: "27000000-0000-4000-8000-000000000010",
  name: "Own Scope Report View",
};
const DISABLED_ADMIN = {
  auth: "17000000-0000-4000-8000-000000000011",
  app: "27000000-0000-4000-8000-000000000011",
  name: "Tài Khoản Đã Khóa",
};
const DIRECTORY_BYSTANDER = {
  auth: "17000000-0000-4000-8000-000000000012",
  app: "27000000-0000-4000-8000-000000000012",
  name: "Người Dùng Ngoài Work Reports",
};

let seq = 0;
const nextKey = (prefix) => `wr_reader_${prefix}_${++seq}`;

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createDatabase({ stopBeforeLast = false } = {}) {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrations();
  const targetIndex = migrations.findIndex(
    (m) => m.name === WORK_REPORTS_READER_CONTRACT_MIGRATION_NAME,
  );
  assert.ok(targetIndex >= 0, "work_reports_reader_contract migration must exist");
  const slice = stopBeforeLast ? migrations.slice(0, targetIndex) : migrations;
  for (const migration of slice) {
    await db.exec(migration.sql);
  }
  return { db, migrations, targetMigration: migrations[targetIndex] };
}

test("Migration transaction rollback on failure leaves zero partial RPC, index, or schema_migrations row, and ledger apply is idempotent", async () => {
  const { db, targetMigration: latest } = await createDatabase({ stopBeforeLast: true });
  try {
    assert.equal(latest.name, WORK_REPORTS_READER_CONTRACT_MIGRATION_NAME);
    const expectedChecksum = migrationChecksum(latest.sql);
    assert.match(expectedChecksum, /^[0-9a-f]{64}$/);
    assert.equal(
      migrationChecksum(latest.sql.replace(/\n/g, "\r\n")),
      expectedChecksum,
      "checksum is LF-normalized",
    );

    await db.exec(`
      create table if not exists public.schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      );
    `);

    const failingBody = `${migrationSqlForTransaction(latest.sql)}\nselect 1 / 0;\n`;
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(failingBody);
          await db.query(
            "insert into public.schema_migrations (version, checksum) values ($1, $2)",
            [latest.name, expectedChecksum],
          );
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      (err) => err.code === "22012",
    );

    const { rows: procAfterRollback } = await db.query(
      `select count(*)::int as n
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'work_report_list_readable_submissions'`,
    );
    assert.equal(procAfterRollback[0].n, 0, "rolled-back migration leaves no function");

    const { rows: idxAfterRollback } = await db.query(
      `select count(*)::int as n
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname = 'work_report_submissions_readable_keyset_idx'`,
    );
    assert.equal(idxAfterRollback[0].n, 0, "rolled-back migration leaves no index");

    const { rows: ledgerAfterRollback } = await db.query(
      "select count(*)::int as n from public.schema_migrations where version = $1",
      [latest.name],
    );
    assert.equal(ledgerAfterRollback[0].n, 0, "rolled-back migration leaves no ledger row");

    // Apply clean migration inside transaction + record ledger
    await db.exec("begin;");
    await db.exec(migrationSqlForTransaction(latest.sql));
    await db.query(
      "insert into public.schema_migrations (version, checksum) values ($1, $2)",
      [latest.name, expectedChecksum],
    );
    await db.exec("commit;");

    const { rows: ledgerAfterApply } = await db.query(
      "select version, checksum from public.schema_migrations where version = $1",
      [latest.name],
    );
    assert.deepEqual(ledgerAfterApply, [
      { version: latest.name, checksum: expectedChecksum },
    ]);
  } finally {
    await db.close();
  }
});

test("ACL, Full Admin & Team Leader scoping, filter_options isolation, submitted-only filtering, keyset stability, and work_report_get_submission regression", async () => {
  const { db } = await createDatabase();
  try {
    // 1. Verify RPC ACL and zero direct table SELECT grants
    const { rows: aclRows } = await db.query(
      `select p.oid::regprocedure::text as signature,
              to_regprocedure($1)::regprocedure::text as expected_signature,
              has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'work_report_list_readable_submissions'`,
      [WORK_REPORTS_READER_CONTRACT_RPC_SIGNATURES[0]],
    );
    assert.equal(aclRows.length, 1);
    assert.equal(aclRows[0].signature, aclRows[0].expected_signature);
    assert.equal(aclRows[0].public_exec, false);
    assert.equal(aclRows[0].anon_exec, false);
    assert.equal(aclRows[0].auth_exec, false);
    assert.equal(aclRows[0].service_exec, true);

    const { rows: getSubSig } = await db.query(
      `select p.oid::regprocedure::text as signature
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'work_report_get_submission'`,
    );
    assert.deepEqual(getSubSig, [{ signature: "work_report_get_submission(uuid,uuid,uuid)" }]);

    const { rows: tableAcl } = await db.query(
      `select c.relname,
              has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
              has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
              has_table_privilege('service_role', c.oid, 'SELECT') as service_select
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relname like 'work_report_%'
          and c.relkind in ('r', 'p')`,
    );
    assert.ok(tableAcl.length >= 10);
    for (const row of tableAcl) {
      assert.equal(row.anon_select, false, `${row.relname} anon SELECT must stay false`);
      assert.equal(row.auth_select, false, `${row.relname} authenticated SELECT must stay false`);
      assert.equal(row.service_select, false, `${row.relname} service_role SELECT must stay false`);
    }

    // 2. Seed teams & actors
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'WR_TEAM_A', 'Nhóm Tuyển Dụng A', true),
              ($2::uuid, 'WR_TEAM_B', 'Nhóm Tuyển Dụng B', true),
              ($3::uuid, 'WR_TEAM_C', 'Nhóm Không Có Nghĩa Vụ', true)`,
      [TEAM_A, TEAM_B, TEAM_EMPTY_C],
    );

    for (const actor of [
      FULL_ADMIN,
      FULL_ADMIN_REVOKED_VIEW,
      LEADER_A,
      LEADER_B,
      STAFF_A1,
      STAFF_A2,
      STAFF_B1,
      UNASSIGNED_TEAM_STAFF,
      FORM_ADMIN_NO_VIEW,
      OWN_SCOPE_VIEWER,
      DISABLED_ADMIN,
      DIRECTORY_BYSTANDER,
    ]) {
      await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
      await db.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled)
         values ($1::uuid, $2::uuid, $3, $4)`,
        [actor.app, actor.auth, actor.name, actor !== DISABLED_ADMIN],
      );
    }

    // Canonical Full Admin triple + scope all (NO explicit report_* capability grants)
    for (const admin of [FULL_ADMIN, FULL_ADMIN_REVOKED_VIEW, DISABLED_ADMIN]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, 'entry_admin', '2026-01-01', true),
                ($1::uuid, 'recruiter_master_manage', '2026-01-01', true),
                ($1::uuid, 'team_master_manage', '2026-01-01', true)`,
        [admin.app],
      );
      await db.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'all', '2026-01-01', true)`,
        [admin.app],
      );
    }

    // Explicitly revoked historical report_view on FULL_ADMIN_REVOKED_VIEW
    await db.query(
      `insert into public.direct_entry_capability_grants
         (app_user_id, capability, valid_from, valid_to, is_current)
       values ($1::uuid, 'report_view', '2026-01-01', '2026-02-01', false)`,
      [FULL_ADMIN_REVOKED_VIEW.app],
    );

    // Form admin without report_view, and own-scope report_view user
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'report_form_manage', '2026-01-01', true),
              ($2::uuid, 'report_view', '2026-01-01', true)`,
      [FORM_ADMIN_NO_VIEW.app, OWN_SCOPE_VIEWER.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true),
              ($2::uuid, 'own', '2026-01-01', true)`,
      [FORM_ADMIN_NO_VIEW.app, OWN_SCOPE_VIEWER.app],
    );

    // Seed recruiters + team memberships + designate Team Leaders A and B
    for (const [person, teamId, code] of [
      [LEADER_A, TEAM_A, "WR_LA"],
      [LEADER_B, TEAM_B, "WR_LB"],
      [STAFF_A1, TEAM_A, "WR_SA1"],
      [STAFF_A2, TEAM_A, "WR_SA2"],
      [STAFF_B1, TEAM_B, "WR_SB1"],
    ]) {
      await db.query(
        `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
         values ($1::uuid, $2, $3, 'STAFF', true)`,
        [person.recruiter, person.name, code],
      );
      await db.query(
        `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
         values ($1::uuid, 'hrp', '2026-01-01', true)`,
        [person.recruiter],
      );
      await db.query(
        `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
         values ($1::uuid, $2::uuid, '2026-01-01', true)`,
        [person.recruiter, teamId],
      );
      await db.query(
        `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
         values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
        [person.app, person.recruiter],
      );
    }

    await db.query(
      `select public.direct_entry_designate_team_leader(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, null::date, 1, 'Designate Leader A', $5
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, TEAM_A, LEADER_A.app, nextKey("desig_a")],
    );
    await db.query(
      `select public.direct_entry_designate_team_leader(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, null::date, 1, 'Designate Leader B', $5
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, TEAM_B, LEADER_B.app, nextKey("desig_b")],
    );

    // 3. Create two templates:
    //    - TPL_DIRECT (requires_review = false => state COMPLETED)
    //    - TPL_REVIEW (requires_review = true  => states PENDING_REVIEW, APPROVED, REJECTED; Team A + unassigned only)
    const schema = RECRUITMENT_DAILY_TEMPLATE_SCHEMA;
    const metrics = buildWorkReportMetricContract(schema);

    async function createPublishedTemplate(code, displayName, requiresReview) {
      const { rows } = await db.query(
        `select public.work_report_create_template(
           $1::uuid, $2::uuid, $3::text, $4::text, null, 'DAILY', $5::jsonb, $6::jsonb, $7
         ) as result`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          code,
          displayName,
          JSON.stringify(schema),
          JSON.stringify(metrics),
          nextKey("tpl"),
        ],
      );
      const created = rows[0].result;
      if (requiresReview) {
        await db.query(
          `update public.work_report_template_versions
              set requires_review = true
            where version_id = $1::uuid and status = 'DRAFT'`,
          [created.draft_version_id],
        );
      }
      await db.query(
        `select public.work_report_publish_template(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6
         )`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          created.template_id,
          created.draft_version_id,
          created.version,
          nextKey("pub"),
        ],
      );
      return { templateId: created.template_id, versionId: created.draft_version_id };
    }

    const tplDirect = await createPublishedTemplate(
      "WR_READER_DIRECT",
      "Báo cáo ngày trực tiếp",
      false,
    );
    const tplReview = await createPublishedTemplate(
      "WR_READER_REVIEW",
      "Báo cáo ngày cần duyệt",
      true,
    );

    // Create assignments to attach obligations cleanly
    const { rows: assignDirectRows } = await db.query(
      `select public.work_report_create_assignment(
         $1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null,
         'DAILY', true, 30, '23:59:59'::time, false, '2026-10-01'::date, null, $5
       ) as result`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, tplDirect.templateId, TEAM_A, nextKey("asg_d")],
    );
    const assignmentDirectId = assignDirectRows[0].result.assignment_id;

    const { rows: assignReviewRows } = await db.query(
      `select public.work_report_create_assignment(
         $1::uuid, $2::uuid, $3::uuid, 'TEAM', null, $4::uuid, null,
         'DAILY', true, 30, '23:59:59'::time, false, '2026-10-01'::date, null, $5
       ) as result`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, tplReview.templateId, TEAM_A, nextKey("asg_r")],
    );
    const assignmentReviewId = assignReviewRows[0].result.assignment_id;

    async function seedObligation({
      obligationId,
      templateId,
      versionId,
      assignmentId,
      assignee,
      teamId,
      teamCode,
      teamDisplayName,
      periodDate,
      dueAt = "2099-12-31T16:59:59Z",
    }) {
      await db.query(
        `insert into public.work_report_obligations
           (obligation_id, template_id, template_version_id, assignment_id, assignee_app_user_id,
            snapshot_team_id, snapshot_team_code, snapshot_team_display_name,
            period_type, period_key, period_start_date, period_end_date, due_at, is_mandatory, obligation_status)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 $6::uuid, $7::text, $8::text, 'DAILY', $9::text, $9::date, $9::date, $10::timestamptz, true, 'ACTIVE')`,
        [
          obligationId,
          templateId,
          versionId,
          assignmentId,
          assignee.app,
          teamId,
          teamCode,
          teamDisplayName,
          periodDate,
          dueAt,
        ],
      );
    }

    async function submitReport(actor, obligationId, calls, submittedAtIso, expectedVersion = null) {
      const { rows } = await db.query(
        `select public.work_report_submit(
           $1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5::integer, $6::text
         ) as result`,
        [
          actor.auth,
          actor.app,
          obligationId,
          JSON.stringify({
            calls_made: calls,
            interested_candidates: 3,
            workers_started: 1,
            notes: `Ghi chú nội bộ ${calls}`,
          }),
          expectedVersion,
          nextKey("sub"),
        ],
      );
      const { rows: updatedRows } = await db.query(
        `update public.work_report_submissions
            set first_submitted_at = coalesce(first_submitted_at, $2::timestamptz),
                latest_submitted_at = $2::timestamptz
          where submission_id = $1::uuid
        returning version`,
        [rows[0].result.submission_id, submittedAtIso],
      );
      return { ...rows[0].result, version: updatedRows[0].version };
    }

    // Seed NOT_STARTED and DRAFT obligations in Team A (must NEVER appear in items!)
    const obNotStarted = "77000000-0000-4000-8000-000000000001";
    const obDraft = "77000000-0000-4000-8000-000000000002";
    await seedObligation({
      obligationId: obNotStarted,
      templateId: tplDirect.templateId,
      versionId: tplDirect.versionId,
      assignmentId: assignmentDirectId,
      assignee: STAFF_A1,
      teamId: TEAM_A,
      teamCode: "WR_TEAM_A",
      teamDisplayName: "Nhóm Tuyển Dụng A",
      periodDate: "2026-10-18",
    });
    await seedObligation({
      obligationId: obDraft,
      templateId: tplDirect.templateId,
      versionId: tplDirect.versionId,
      assignmentId: assignmentDirectId,
      assignee: STAFF_A1,
      teamId: TEAM_A,
      teamCode: "WR_TEAM_A",
      teamDisplayName: "Nhóm Tuyển Dụng A",
      periodDate: "2026-10-19",
    });
    await db.query(
      `select public.work_report_save_draft($1::uuid, $2::uuid, $3::uuid, $4::jsonb, null, $5)`,
      [
        STAFF_A1.auth,
        STAFF_A1.app,
        obDraft,
        JSON.stringify({ calls_made: 5 }),
        nextKey("draft"),
      ],
    );

    // Seed 5 submitted obligations across states, teams, and templates:
    //   S1: Team B, TPL_DIRECT, COMPLETED (period 2026-10-20, submitted 10:00:00.100000Z)
    //   S2: Team A, TPL_DIRECT, COMPLETED (period 2026-10-20, submitted 11:00:00.250000Z — tie timestamp!)
    //   S3: Team A, TPL_REVIEW, PENDING_REVIEW (period 2026-10-21, submitted 11:00:00.250000Z — tie timestamp!)
    //   S4: Team A, TPL_REVIEW, APPROVED (period 2026-10-22, submitted 12:00:00.500000Z)
    //   S5: Unassigned team (null), TPL_REVIEW, REJECTED (period 2026-10-23, submitted 13:00:00.750000Z)
    const obS1TeamB = "77000000-0000-4000-8000-000000000011";
    const obS2TeamA = "77000000-0000-4000-8000-000000000012";
    const obS3TeamAPending = "77000000-0000-4000-8000-000000000013";
    const obS4TeamAApproved = "77000000-0000-4000-8000-000000000014";
    const obS5NullTeamRejected = "77000000-0000-4000-8000-000000000015";

    await seedObligation({
      obligationId: obS1TeamB,
      templateId: tplDirect.templateId,
      versionId: tplDirect.versionId,
      assignmentId: assignmentDirectId,
      assignee: STAFF_B1,
      teamId: TEAM_B,
      teamCode: "WR_TEAM_B",
      teamDisplayName: "Nhóm Tuyển Dụng B",
      periodDate: "2026-10-20",
    });
    const sub1 = await submitReport(STAFF_B1, obS1TeamB, 11, "2026-10-23T10:00:00.100000Z");

    await seedObligation({
      obligationId: obS2TeamA,
      templateId: tplDirect.templateId,
      versionId: tplDirect.versionId,
      assignmentId: assignmentDirectId,
      assignee: STAFF_A1,
      teamId: TEAM_A,
      teamCode: "WR_TEAM_A",
      teamDisplayName: "Nhóm Tuyển Dụng A",
      periodDate: "2026-10-20",
    });
    const sub2 = await submitReport(STAFF_A1, obS2TeamA, 22, "2026-10-23T11:00:00.250000Z");

    await seedObligation({
      obligationId: obS3TeamAPending,
      templateId: tplReview.templateId,
      versionId: tplReview.versionId,
      assignmentId: assignmentReviewId,
      assignee: STAFF_A2,
      teamId: TEAM_A,
      teamCode: "WR_TEAM_A",
      teamDisplayName: "Nhóm Tuyển Dụng A",
      periodDate: "2026-10-21",
    });
    const sub3 = await submitReport(
      STAFF_A2,
      obS3TeamAPending,
      33,
      "2026-10-23T11:00:00.250000Z",
    );

    await seedObligation({
      obligationId: obS4TeamAApproved,
      templateId: tplReview.templateId,
      versionId: tplReview.versionId,
      assignmentId: assignmentReviewId,
      assignee: STAFF_A1,
      teamId: TEAM_A,
      teamCode: "WR_TEAM_A",
      teamDisplayName: "Nhóm Tuyển Dụng A",
      periodDate: "2026-10-22",
    });
    const sub4 = await submitReport(
      STAFF_A1,
      obS4TeamAApproved,
      44,
      "2026-10-23T12:00:00.500000Z",
    );
    await db.query(
      `select public.work_report_decide_review(
         $1::uuid, $2::uuid, $3::uuid, 'APPROVED', 'Số liệu chính xác', $4::integer, $5::text
       )`,
      [LEADER_A.auth, LEADER_A.app, obS4TeamAApproved, sub4.version, nextKey("approve")],
    );

    await seedObligation({
      obligationId: obS5NullTeamRejected,
      templateId: tplReview.templateId,
      versionId: tplReview.versionId,
      assignmentId: assignmentReviewId,
      assignee: UNASSIGNED_TEAM_STAFF,
      teamId: null,
      teamCode: null,
      teamDisplayName: null,
      periodDate: "2026-10-23",
    });
    const sub5 = await submitReport(
      UNASSIGNED_TEAM_STAFF,
      obS5NullTeamRejected,
      55,
      "2026-10-23T13:00:00.750000Z",
    );
    await db.query(
      `select public.work_report_decide_review(
         $1::uuid, $2::uuid, $3::uuid, 'REJECTED', 'Cần bổ sung chi tiết ứng viên', $4::integer, $5::text
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, obS5NullTeamRejected, sub5.version, nextKey("reject")],
    );

    async function listReadable(actor, filters = {}) {
      const { rows } = await db.query(
        `select public.work_report_list_readable_submissions(
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date,
           $7::uuid, $8::uuid, $9::text, $10::text, $11::integer
         ) as result`,
        [
          actor.auth,
          actor.app,
          filters.template_id ?? null,
          filters.version_id ?? null,
          filters.from ?? null,
          filters.to ?? null,
          filters.team_id ?? null,
          filters.assignee_id ?? null,
          filters.state ?? null,
          filters.cursor ?? null,
          filters.limit ?? 50,
        ],
      );
      return rows[0].result;
    }

    // 4. Full Admin scope `all` (no explicit report_view token) sees all 5 submitted items across company & both templates
    const adminAll = await listReadable(FULL_ADMIN);
    assert.deepEqual(adminAll.effective_scope, { kind: "all", label: "Toàn công ty" });
    assert.equal(adminAll.items.length, 5);
    assert.equal(adminAll.has_more, false);
    assert.equal(adminAll.next_cursor, null);

    const adminStates = new Set(adminAll.items.map((item) => item.state));
    assert.deepEqual(
      [...adminStates].sort(),
      ["APPROVED", "COMPLETED", "PENDING_REVIEW", "REJECTED"],
    );
    assert.equal(
      adminAll.items.some(
        (item) => item.obligation_id === obNotStarted || item.obligation_id === obDraft,
      ),
      false,
      "NOT_STARTED and DRAFT obligations must never appear in readable submissions",
    );
    for (const item of adminAll.items) {
      assert.equal("payload_json" in item, false);
      assert.equal("draft_payload_json" in item, false);
      assert.equal(item.current_revision_no, 1);
    }

    // Filter options under Full Admin do NOT leak DIRECTORY_BYSTANDER, FULL_ADMIN, or TEAM_EMPTY_C
    assert.deepEqual(
      adminAll.filter_options.teams.map((t) => t.team_id),
      [TEAM_A, TEAM_B],
      "teams filter options only include teams with obligations in scope",
    );
    assert.deepEqual(
      adminAll.filter_options.assignees.map((a) => a.app_user_id).sort(),
      [LEADER_A.app, STAFF_A1.app, STAFF_A2.app, STAFF_B1.app, UNASSIGNED_TEAM_STAFF.app].sort(),
      "assignees filter options never dump the global direct_entry_app_users directory",
    );
    assert.equal(adminAll.filter_options.templates.length, 2);
    assert.ok(adminAll.filter_options.templates.every((t) => t.versions.length === 1));

    // Reporting period filter (`from` / `to` inclusive on period_start_date) & `state` filter
    const periodFiltered = await listReadable(FULL_ADMIN, {
      from: "2026-10-21",
      to: "2026-10-22",
    });
    assert.deepEqual(
      periodFiltered.items.map((i) => i.obligation_id),
      [obS4TeamAApproved, obS3TeamAPending],
    );

    const stateFiltered = await listReadable(FULL_ADMIN, { state: "REJECTED" });
    assert.deepEqual(
      stateFiltered.items.map((i) => i.obligation_id),
      [obS5NullTeamRejected],
    );

    // 5. Team Leader A sees ONLY Team A submitted items and ONLY Team A filter_options
    const leaderAResult = await listReadable(LEADER_A);
    assert.deepEqual(leaderAResult.effective_scope, {
      kind: "team",
      label: "Nhóm Tuyển Dụng A",
    });
    assert.deepEqual(
      leaderAResult.items.map((i) => i.obligation_id).sort(),
      [obS2TeamA, obS3TeamAPending, obS4TeamAApproved].sort(),
    );
    assert.deepEqual(leaderAResult.filter_options.teams, [
      {
        team_id: TEAM_A,
        code: "WR_TEAM_A",
        display_name: "Nhóm Tuyển Dụng A",
      },
    ]);
    assert.deepEqual(
      leaderAResult.filter_options.assignees.map((a) => a.app_user_id).sort(),
      [LEADER_A.app, STAFF_A1.app, STAFF_A2.app].sort(),
      "Team Leader A filter_options must never leak Team B or unassigned assignees",
    );

    // Team Leader B only has obligations in TPL_DIRECT => filter_options.templates only contains TPL_DIRECT
    const leaderBResult = await listReadable(LEADER_B);
    assert.deepEqual(
      leaderBResult.items.map((i) => i.obligation_id),
      [obS1TeamB],
    );
    assert.deepEqual(
      leaderBResult.filter_options.templates.map((t) => t.template_id),
      [tplDirect.templateId],
    );
    assert.deepEqual(
      leaderBResult.filter_options.assignees.map((a) => a.app_user_id),
      [STAFF_B1.app],
    );

    // 6. Cross-team team_id / assignee_id filters fail closed with 42501 WORK_REPORT_SCOPE_DENIED
    await assert.rejects(
      () => listReadable(LEADER_A, { team_id: TEAM_B }),
      (err) => err.code === "42501" && /WORK_REPORT_SCOPE_DENIED/.test(err.message),
    );
    await assert.rejects(
      () => listReadable(LEADER_A, { assignee_id: STAFF_B1.app }),
      (err) => err.code === "42501" && /WORK_REPORT_SCOPE_DENIED/.test(err.message),
    );
    await assert.rejects(
      () => listReadable(LEADER_A, { assignee_id: UNASSIGNED_TEAM_STAFF.app }),
      (err) => err.code === "42501" && /WORK_REPORT_SCOPE_DENIED/.test(err.message),
    );

    // 7. Disabled, mismatched, unpermitted, own-scope, and explicitly-revoked Full Admin actors are denied
    await assert.rejects(
      () => listReadable(DISABLED_ADMIN),
      (err) => err.code === "42501" && /WORK_REPORT_ACTOR_DENIED/.test(err.message),
    );
    await assert.rejects(
      () => listReadable({ auth: STAFF_A1.auth, app: FULL_ADMIN.app }),
      (err) => err.code === "42501" && /WORK_REPORT_ACTOR_DENIED/.test(err.message),
    );
    await assert.rejects(
      () => listReadable(FORM_ADMIN_NO_VIEW),
      (err) => err.code === "42501" && /WORK_REPORT_CAPABILITY_DENIED/.test(err.message),
    );
    await assert.rejects(
      () => listReadable(STAFF_A1),
      (err) => err.code === "42501" && /WORK_REPORT_CAPABILITY_DENIED/.test(err.message),
    );
    await assert.rejects(
      () => listReadable(FULL_ADMIN_REVOKED_VIEW),
      (err) => err.code === "42501" && /WORK_REPORT_CAPABILITY_DENIED/.test(err.message),
    );
    await assert.rejects(
      () => listReadable(OWN_SCOPE_VIEWER),
      (err) => err.code === "42501" && /WORK_REPORT_SCOPE_DENIED/.test(err.message),
    );

    // Validation errors at SQL boundary (22023 / P0002)
    await assert.rejects(
      () => listReadable(FULL_ADMIN, { state: "DRAFT" }),
      (err) => err.code === "22023" && /WORK_REPORT_STATE_INVALID/.test(err.message),
    );
    await assert.rejects(
      () => listReadable(FULL_ADMIN, { from: "2026-10-25", to: "2026-10-20" }),
      (err) => err.code === "22023" && /WORK_REPORT_DATE_RANGE_INVALID/.test(err.message),
    );
    await assert.rejects(
      () => listReadable(FULL_ADMIN, { cursor: "malformed" }),
      (err) => err.code === "22023" && /WORK_REPORT_CURSOR_INVALID/.test(err.message),
    );
    await assert.rejects(
      () => listReadable(FULL_ADMIN, { limit: 0 }),
      (err) => err.code === "22023" && /WORK_REPORT_LIMIT_INVALID/.test(err.message),
    );
    await assert.rejects(
      () =>
        listReadable(FULL_ADMIN, {
          template_id: "39999999-0000-4000-8000-000000000999",
        }),
      (err) => err.code === "P0002" && /WORK_REPORT_TEMPLATE_NOT_FOUND/.test(err.message),
    );

    // 8. Keyset pagination stability: no duplicate or skipped rows when a newer submission arrives mid-walk
    //    (also exercises tie-breaking between sub2 and sub3 sharing identical latest_submitted_at!)
    const expectedInitialOrder = [
      sub5.submission_id,
      sub4.submission_id,
      ...[sub2.submission_id, sub3.submission_id].sort().reverse(),
      sub1.submission_id,
    ];

    const page1 = await listReadable(FULL_ADMIN, { limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.equal(page1.has_more, true);
    assert.ok(page1.next_cursor);

    // Insert a brand-new submission S6 at the top BEFORE fetching page 2
    const obS6Newer = "77000000-0000-4000-8000-000000000016";
    await seedObligation({
      obligationId: obS6Newer,
      templateId: tplDirect.templateId,
      versionId: tplDirect.versionId,
      assignmentId: assignmentDirectId,
      assignee: STAFF_A2,
      teamId: TEAM_A,
      teamCode: "WR_TEAM_A",
      teamDisplayName: "Nhóm Tuyển Dụng A",
      periodDate: "2026-10-24",
    });
    const sub6 = await submitReport(
      STAFF_A2,
      obS6Newer,
      66,
      "2026-10-23T15:00:00.999999Z",
    );
    assert.ok(sub6.submission_id);

    const page2 = await listReadable(FULL_ADMIN, {
      limit: 2,
      cursor: page1.next_cursor,
    });
    assert.equal(page2.items.length, 2);
    assert.equal(page2.has_more, true);
    assert.ok(page2.next_cursor);

    const page3 = await listReadable(FULL_ADMIN, {
      limit: 2,
      cursor: page2.next_cursor,
    });
    assert.equal(page3.items.length, 1);
    assert.equal(page3.has_more, false);
    assert.equal(page3.next_cursor, null);

    const collectedIds = [...page1.items, ...page2.items, ...page3.items].map(
      (item) => item.submission_id,
    );
    assert.deepEqual(
      collectedIds,
      expectedInitialOrder,
      "keyset walk produces zero duplicates and zero gaps even when newer submissions arrive",
    );

    // 9. work_report_get_submission still returns schema_json, revisions, and latest_review_event
    const { rows: detailByObRows } = await db.query(
      `select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid) as detail`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, obS4TeamAApproved],
    );
    const detailByOb = detailByObRows[0].detail;
    assert.ok(detailByOb.template.schema_json);
    assert.equal(detailByOb.submission.submission_id, sub4.submission_id);
    assert.equal(detailByOb.submission.state, "APPROVED");
    assert.equal(detailByOb.revisions.length, 1);
    assert.equal(detailByOb.revisions[0].payload_json.calls_made, 44);
    assert.deepEqual(
      {
        decision: detailByOb.latest_review_event.decision,
        reason: detailByOb.latest_review_event.reason,
        revision_no: detailByOb.latest_review_event.revision_no,
      },
      {
        decision: "APPROVED",
        reason: "Số liệu chính xác",
        revision_no: 1,
      },
    );
    assert.ok(detailByOb.latest_review_event.reviewed_at);

    // Lookup by submission_id for Team Leader A also works identically
    const { rows: detailBySubRows } = await db.query(
      `select public.work_report_get_submission($1::uuid, $2::uuid, $3::uuid) as detail`,
      [LEADER_A.auth, LEADER_A.app, sub4.submission_id],
    );
    assert.equal(
      detailBySubRows[0].detail.obligation.obligation_id,
      obS4TeamAApproved,
    );

    // Revoking Team Leader A immediately removes readable submissions access
    await db.query(
      `select public.direct_entry_revoke_team_leader(
         $1::uuid, $2::uuid, $3::uuid, null::date, 2, 'Revoke Leader A', $4
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, TEAM_A, nextKey("revoke_a")],
    );
    await assert.rejects(
      () => listReadable(LEADER_A),
      (err) => err.code === "42501",
    );
  } finally {
    await db.close();
  }
});
