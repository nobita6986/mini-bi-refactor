/**
 * W2S2 Salary Advance (Ứng lương) WP1 — Comprehensive PGlite DB & Repository Suite.
 *
 * Covers all 7 mandatory verification areas:
 *   1. Authorization matrix (QLDA project/creator scope, Project Accountant scope,
 *      Project Accountant handover A -> B, Full Admin & Canonical BoD supervisory
 *      read-only access, and VFIN permission/role non-escalation guard).
 *   2. Separate `request_state` and `evidence_review_state` state machines.
 *   3. Cash-receipt evidence versioning (v1 -> RETAKE_REQUIRED -> v2 -> REVIEWED)
 *      and 4-way worker portrait OCC lock (`expected_version`, `evidence_version`,
 *      `expected_worker_portrait_document_id`, `expected_worker_portrait_version`).
 *   4. Positive integer VND amounts (`bigint`, no business cap) & zero duplicated
 *      worker PII snapshot columns in `salary_advance_*` tables.
 *   5. OCC version conflicts, idempotent replay/conflict, and superseded upload
 *      race protection.
 *   6. Evidence preview & worker portrait context scoping (including portrait
 *      rotation conflict check).
 *   7. RLS + FORCE RLS, zero anon/authenticated table grants, `service_role`-only
 *      RPC execute ACLs, and append-only `salary_advance_events` triggers.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { computeAssignAccountingMemberFingerprint } from "../src/lib/departments/department-contract.ts";
import {
  MAX_PG_BIGINT,
  computeCreateRequestFingerprint,
  computeFinalizeEvidenceFingerprint,
  computeReserveEvidenceFingerprint,
  computeReviewEvidenceFingerprint,
  computeTransitionRequestFingerprint,
} from "../src/lib/salary-advance/salary-advance-contract.ts";
import { createSalaryAdvanceRepository } from "../src/lib/salary-advance/salary-advance-repository.ts";
import {
   computeAssignGlobalRoleFingerprint,
  computeAssignProjectAccountantFingerprint,
  computeEndProjectAccountantFingerprint,
} from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import {
  SALARY_ADVANCE_WP1_MIGRATION_NAME,
  SALARY_ADVANCE_WP1_RPC_SIGNATURES,
  migrationChecksum,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const TEAM_ALPHA = "99800000-0000-4000-8000-00000000000a";
const PRJ_1 = "sal_adv_prj_north";
const PRJ_2 = "sal_adv_prj_south";
const PRJ_NO_ACCT = "sal_adv_prj_no_acct";

const FULL_ADMIN = {
  auth: "19800000-0000-4000-8000-000000000001",
  app: "29800000-0000-4000-8000-000000000001",
  name: "Quản Trị Toàn Quyền Ứng Lương",
};
const CANONICAL_BOD = {
  auth: "19800000-0000-4000-8000-000000000002",
  app: "29800000-0000-4000-8000-000000000002",
  name: "Ban Giám Đốc Chuẩn (BoD)",
};
const PM_1 = {
  auth: "19800000-0000-4000-8000-000000000003",
  app: "29800000-0000-4000-8000-000000000003",
  recruiter: "39800000-0000-4000-8000-000000000003",
  name: "QLDA Dự Án Bắc 01",
  code: "PM-801",
};
const PM_1B = {
  auth: "19800000-0000-4000-8000-000000000004",
  app: "29800000-0000-4000-8000-000000000004",
  recruiter: "39800000-0000-4000-8000-000000000004",
  name: "QLDA Dự Án Bắc 02",
  code: "PM-802",
};
const PM_2 = {
  auth: "19800000-0000-4000-8000-000000000005",
  app: "29800000-0000-4000-8000-000000000005",
  recruiter: "39800000-0000-4000-8000-000000000005",
  name: "QLDA Dự Án Nam",
  code: "PM-803",
};
const ACCT_A = {
  auth: "19800000-0000-4000-8000-000000000006",
  app: "29800000-0000-4000-8000-000000000006",
  recruiter: "39800000-0000-4000-8000-000000000006",
  name: "Kế Toán Dự Án A",
  code: "KT-806",
};
const ACCT_B = {
  auth: "19800000-0000-4000-8000-000000000007",
  app: "29800000-0000-4000-8000-000000000007",
  recruiter: "39800000-0000-4000-8000-000000000007",
  name: "Kế Toán Dự Án B",
  code: "KT-807",
};
const VFIN_ONLY_ACTOR = {
  auth: "19800000-0000-4000-8000-000000000008",
  app: "29800000-0000-4000-8000-000000000008",
  recruiter: "39800000-0000-4000-8000-000000000008",
  name: "Tài Khoản Chỉ Có Quyền VFIN Reconciler",
  code: "VF-808",
};
const VFIN_CASH_HOLDER_ACTOR = {
  auth: "19800000-0000-4000-8000-000000000009",
  app: "29800000-0000-4000-8000-000000000009",
  recruiter: "39800000-0000-4000-8000-000000000009",
  name: "Tài Khoản Chỉ Có Quyền VFIN Cash Holder",
  code: "VF-809",
};

let uuidSeq = 0;
function nextUuid() {
  uuidSeq += 1;
  return `79800000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
}

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR))
    .filter((n) => n.endsWith(".sql"))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createPreWp1Database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrations();
  const targetIdx = migrations.findIndex(
    (m) => m.name === SALARY_ADVANCE_WP1_MIGRATION_NAME,
  );
  assert.ok(
    targetIdx >= 0,
    `${SALARY_ADVANCE_WP1_MIGRATION_NAME} must exist in supabase/migrations`,
  );
  for (const m of migrations.slice(0, targetIdx)) {
    await db.exec(m.sql);
  }
  return {
    db,
    targetMigration: migrations[targetIdx],
    restMigrations: migrations.slice(targetIdx + 1),
  };
}

const SALARY_ADVANCE_RPC_BINDINGS = {
  salary_advance_get_actor_access: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
  ],
  salary_advance_get_actor_context: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
  ],
  salary_advance_list_project_workers: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_project_id", "text"],
    ["p_search", "text"],
    ["p_cursor", "text"],
    ["p_page_size", "integer"],
  ],
  salary_advance_list_requests: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_queue", "text"],
    ["p_project_id", "text"],
    ["p_request_state", "text"],
    ["p_evidence_review_state", "text"],
    ["p_search", "text"],
    ["p_cursor", "text"],
    ["p_page_size", "integer"],
  ],
  salary_advance_get_request_detail: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
  ],
  salary_advance_create_request: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_project_id", "text"],
    ["p_worker_entry_id", "uuid"],
    ["p_requested_amount_vnd", "text"],
    ["p_initial_content", "text"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
    ["p_payment_method", "text"],
  ],
  salary_advance_post_message: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_message_text", "text"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_transition_request: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_action", "text"],
    ["p_expected_version", "integer"],
    ["p_message_text", "text"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_reserve_evidence: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_mime_type", "text"],
    ["p_size_bytes", "integer"],
    ["p_checksum_sha256", "text"],
    ["p_caption_note", "text"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_get_evidence_finalize_context: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_upload_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_finalize_evidence: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_upload_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_review_evidence: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_evidence_version", "integer"],
    ["p_decision", "text"],
    ["p_expected_worker_portrait_document_id", "uuid"],
    ["p_expected_worker_portrait_version", "integer"],
    ["p_note", "text"],
    ["p_idempotency_key", "text"],
    ["p_request_fingerprint", "text"],
  ],
  salary_advance_get_evidence_preview_context: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_evidence_version", "integer"],
  ],
  salary_advance_get_worker_portrait_context: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_expected_document_id", "uuid"],
  ],
  salary_advance_list_worker_history: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_request_id", "uuid"],
    ["p_period_mode", "text"],
    ["p_month", "text"],
    ["p_from_date", "text"],
    ["p_to_date", "text"],
    ["p_cursor", "text"],
    ["p_page_size", "integer"],
  ],
  salary_advance_list_project_worker_history: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_project_id", "text"],
    ["p_worker_entry_id", "uuid"],
    ["p_period_mode", "text"],
    ["p_month", "text"],
    ["p_from_date", "text"],
    ["p_to_date", "text"],
    ["p_cursor", "text"],
    ["p_page_size", "integer"],
  ],
};

function createPgliteSalaryAdvanceRepo(db) {
  return createSalaryAdvanceRepository(async (fnName, params) => {
    const spec = SALARY_ADVANCE_RPC_BINDINGS[fnName];
    assert.ok(spec, `Unbound RPC in PGlite adapter: ${fnName}`);
    const placeholders = spec
      .map(([, pgType], idx) => `$${idx + 1}::${pgType}`)
      .join(", ");
    const values = spec.map(([paramName]) => {
      const val = params[paramName];
      return val === undefined ? null : val;
    });
    try {
      const { rows } = await db.query(
        `select public.${fnName}(${placeholders}) as data`,
        values,
      );
      return { data: rows[0]?.data ?? null, error: null };
    } catch (err) {
      return {
        data: null,
        error: {
          code: err.code ?? undefined,
          message: err.message ?? String(err),
        },
      };
    }
  });
}

function makeWorkerDetails(displayName) {
  const unknown = { state: "unknown" };
  return {
    display_name: displayName,
    date_of_birth: unknown,
    national_id: unknown,
    address: unknown,
    phone: unknown,
  };
}

async function seedWorkerPortraitVersion(db, actor, entryId, shaChar = "a") {
  const { rows: entryRows } = await db.query(
    "select version from public.direct_entries where entry_id = $1::uuid",
    [entryId],
  );
  const reserveKey = `portrait-reserve-${nextUuid()}`;
  const reserved = await db.query(
    `select public.direct_entry_reserve_document_direct_upload(
       $1::uuid, $2::uuid, $3::uuid, $4::integer, 'WORKER_PORTRAIT',
       $5::text, 512, 'image/jpeg', null
     ) as data`,
    [
      actor.auth,
      actor.app,
      entryId,
      entryRows[0].version,
      reserveKey,
    ],
  );
  const reservation = reserved.rows[0].data;
  const finalizeKey = `portrait-finalize-${nextUuid()}`;
  const finalized = await db.query(
    `select public.direct_entry_finalize_document_direct_upload(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer,
       $6::text, 'validated', $7::text, 512, 'image/jpeg'
     ) as data`,
    [
      actor.auth,
      actor.app,
      entryId,
      reservation.document_id,
      reservation.entry_version,
      finalizeKey,
      shaChar.repeat(64),
    ],
  );
  return finalized.rows[0].data;
}

test("(#1) W2S2 Salary Advance WP1 migration rolls back atomically on failure and has LF/CRLF-identical SHA-256 checksum", async () => {
  const { db, targetMigration } = await createPreWp1Database();
  try {
    const checksum = migrationChecksum(targetMigration.sql);
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.equal(
      migrationChecksum(targetMigration.sql.replace(/\n/g, "\r\n")),
      checksum,
    );

    const failingBody = `${migrationSqlForTransaction(targetMigration.sql)}\nselect 1 / 0;\n`;
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(failingBody);
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      (err) => err.code === "22012",
    );

    const { rows: leaked } = await db.query(
      `select tablename from pg_tables
        where schemaname = 'public'
          and tablename like 'salary_advance_%'`,
    );
    assert.equal(leaked.length, 0);
  } finally {
    await db.close();
  }
});

test("(#2) Full W2S2 Salary Advance WP1 acceptance across all 7 mandatory verification areas", async () => {
  const { db, targetMigration, restMigrations } = await createPreWp1Database();
  try {
    await db.exec(targetMigration.sql);
    for (const m of restMigrations) {
      await db.exec(m.sql);
    }

    const repo = createPgliteSalaryAdvanceRepo(db);

    // =========================================================================
    // AREA 7: Database RLS / FORCE RLS / Zero PII Columns / RPC ACL / Triggers
    // =========================================================================
    for (const table of [
      "salary_advance_requests",
      "salary_advance_events",
      "salary_advance_idempotency",
    ]) {
      const { rows: rlsRows } = await db.query(
        `select c.relrowsecurity, c.relforcerowsecurity
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = $1`,
        [table],
      );
      assert.deepEqual(rlsRows[0], {
        relrowsecurity: true,
        relforcerowsecurity: true,
      });

      const { rows: polRows } = await db.query(
        `select count(*)::int as cnt from pg_policies
          where schemaname = 'public' and tablename = $1`,
        [table],
      );
      assert.equal(polRows[0].cnt, 0);

      for (const role of ["anon", "authenticated"]) {
        for (const priv of [
          "SELECT",
          "INSERT",
          "UPDATE",
          "DELETE",
          "TRUNCATE",
          "REFERENCES",
          "TRIGGER",
        ]) {
          const { rows: privRows } = await db.query(
            `select has_table_privilege($1, $2, $3) as allowed`,
            [role, `public.${table}`, priv],
          );
          assert.equal(
            privRows[0].allowed,
            false,
            `${role} must not have ${priv} on ${table}`,
          );
        }
      }
    }

    // Zero duplicated worker PII columns in salary_advance_requests & salary_advance_events
    const { rows: piiCols } = await db.query(
      `select table_name, column_name
         from information_schema.columns
        where table_schema = 'public'
          and table_name in ('salary_advance_requests', 'salary_advance_events')
          and (
            column_name ilike '%worker_name%'
            or column_name ilike '%display_name%'
            or column_name ilike '%employee_code%'
            or column_name ilike '%national_id%'
            or column_name ilike '%cccd%'
            or column_name ilike '%phone%'
            or column_name ilike '%address%'
            or column_name ilike '%bank%'
          )`,
    );
    assert.deepEqual(
      piiCols,
      [],
      "salary_advance tables must store zero duplicated worker PII snapshot columns",
    );

    // RPC ACLs: all 13 public RPCs granted ONLY to service_role
    for (const sig of SALARY_ADVANCE_WP1_RPC_SIGNATURES) {
      const { rows } = await db.query(
        `select p.prosecdef,
                has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
                has_function_privilege('service_role', p.oid, 'EXECUTE') as srv_exec
           from pg_proc p
          where p.oid = $1::regprocedure`,
        [sig],
      );
      assert.deepEqual(rows[0], {
        prosecdef: true,
        pub_exec: false,
        anon_exec: false,
        auth_exec: false,
        srv_exec: true,
      });
    }

    // =========================================================================
    // SEED ACTORS, PROJECTS, PROJECT MANAGERS, ACCOUNTANTS & WORKERS
    // =========================================================================
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'TD_SAL_ADV_ALPHA', 'Nhóm Tuyển Dụng Alpha', true)
       on conflict (code) do nothing`,
      [TEAM_ALPHA],
    );

    for (const actor of [
      FULL_ADMIN,
      CANONICAL_BOD,
      PM_1,
      PM_1B,
      PM_2,
      ACCT_A,
      ACCT_B,
      VFIN_ONLY_ACTOR,
      VFIN_CASH_HOLDER_ACTOR,
    ]) {
      await db.query("insert into auth.users (id) values ($1::uuid)", [
        actor.auth,
      ]);
      await db.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
         values ($1::uuid, $2::uuid, true, $3)`,
        [actor.app, actor.auth, actor.name],
      );
    }

    // Full Admin grants
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_admin', '2026-01-01', true),
              ($1::uuid, 'recruiter_master_manage', '2026-01-01', true),
              ($1::uuid, 'team_master_manage', '2026-01-01', true),
              ($1::uuid, 'catalog_master_manage', '2026-01-01', true),
              ($1::uuid, 'document_upload', '2026-01-01', true),
              ($1::uuid, 'document_view', '2026-01-01', true)`,
      [FULL_ADMIN.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [FULL_ADMIN.app],
    );

    // Canonical BoD grants (`all` scope + `report_analytics_view` + `report_view`)
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'report_analytics_view', '2026-01-01', true),
              ($1::uuid, 'report_view', '2026-01-01', true)`,
      [CANONICAL_BOD.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [CANONICAL_BOD.app],
    );

    // VFIN-only actor grants (`vendor_finance_view`, `vendor_finance_record` @ `all` scope)
    // Must NEVER be misclassified as BoD or granted Salary Advance access!
    for (const vfinActor of [VFIN_ONLY_ACTOR, VFIN_CASH_HOLDER_ACTOR]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, 'vendor_finance_view', '2026-01-01', true),
                ($1::uuid, 'vendor_finance_record', '2026-01-01', true)`,
        [vfinActor.app],
      );
      await db.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'all', '2026-01-01', true)`,
        [vfinActor.app],
      );
    }

    // PMs capabilities for Direct Entry worker creation & portrait upload
    for (const pm of [PM_1, PM_1B, PM_2]) {
      await db.query(
        `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
         values ($1::uuid, 'entry_create', '2026-01-01', true),
                ($1::uuid, 'submission_create', '2026-01-01', true),
                ($1::uuid, 'entry_own', '2026-01-01', true),
                ($1::uuid, 'document_upload', '2026-01-01', true),
                ($1::uuid, 'document_view', '2026-01-01', true)`,
        [pm.app],
      );
      await db.query(
        `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
         values ($1::uuid, 'own', '2026-01-01', true)`,
        [pm.app],
      );
    }

    // Recruiters & verified links
    for (const person of [
      PM_1,
      PM_1B,
      PM_2,
      ACCT_A,
      ACCT_B,
      VFIN_ONLY_ACTOR,
      VFIN_CASH_HOLDER_ACTOR,
    ]) {
      await db.query(
        `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
         values ($1::uuid, $2, $3, 'STAFF', true)`,
        [person.recruiter, person.name, person.code],
      );
      await db.query(
        `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
         values ($1::uuid, 'hrp', '2026-01-01', true)`,
        [person.recruiter],
      );
      await db.query(
        `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
         values ($1::uuid, $2::uuid, '2026-01-01', true)`,
        [person.recruiter, TEAM_ALPHA],
      );
      await db.query(
        `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
         values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
        [person.app, person.recruiter],
      );
    }

    // Projects
    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự Án Miền Bắc', true, 1),
              ($2, 'Dự Án Miền Nam', true, 1),
              ($3, 'Dự Án Chưa Có Kế Toán', true, 1)`,
      [PRJ_1, PRJ_2, PRJ_NO_ACCT],
    );

    // Assign Project Managers:
    // PM_1 and PM_1B on PRJ_1; PM_1 on PRJ_NO_ACCT; PM_2 on PRJ_2
    await db.query(
      `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current)
       values ($1, $2::uuid, '2026-01-01', true),
              ($1, $3::uuid, '2026-01-01', true),
              ($4, $2::uuid, '2026-01-01', true),
              ($5, $6::uuid, '2026-01-01', true)`,
      [PRJ_1, PM_1.recruiter, PM_1B.recruiter, PRJ_NO_ACCT, PRJ_2, PM_2.recruiter],
    );

    // Assign ACCT_A, ACCT_B, VFIN_ONLY_ACTOR, and VFIN_CASH_HOLDER_ACTOR to ACCOUNTING department
    for (const acct of [
      ACCT_A,
      ACCT_B,
      VFIN_ONLY_ACTOR,
      VFIN_CASH_HOLDER_ACTOR,
    ]) {
      const reason = `Bổ nhiệm ${acct.name} vào phòng Kế toán`;
      await db.query(
        `select public.org_department_assign_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 0, null::date, $4::text, $5::uuid, $6::text
         )`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          acct.app,
          reason,
          nextUuid(),
          computeAssignAccountingMemberFingerprint({
            actor_app_user_id: FULL_ADMIN.app,
            account_ref: acct.app,
            expected_pair_version: 0,
            effective_from: null,
            reason,
          }),
        ],
      );
    }

    // Grant VFIN_ONLY_ACTOR (`GLOBAL_RECONCILER`) and VFIN_CASH_HOLDER_ACTOR (`CASH_HOLDER`)
    for (const [targetActor, roleCode] of [
      [VFIN_ONLY_ACTOR, "GLOBAL_RECONCILER"],
      [VFIN_CASH_HOLDER_ACTOR, "CASH_HOLDER"],
    ]) {
      const reason = `Cấp quyền VFIN ${roleCode}`;
      await db.query(
        `select public.vendor_finance_assign_global_role_admin(
           $1::uuid, $2::uuid, $3::uuid, $4::text, 0, null::date, $5::text, $6::uuid, $7::text
         )`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          targetActor.app,
          roleCode,
          reason,
          nextUuid(),
          computeAssignGlobalRoleFingerprint({
            account_ref: targetActor.app,
            role_code: roleCode,
            valid_from: null,
            expected_version: 0,
            reason,
          }),
        ],
      );
    }

    // Assign ACCT_A as Project Accountant for PRJ_1
    const assignAcctAReason = "Phân công Kế toán A phụ trách PRJ_1";
    const assignAcctARes = await db.query(
      `select public.vendor_finance_assign_project_accountant_admin(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 0, null::date, $5::text, $6::uuid, $7::text
       ) as data`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        PRJ_1,
        ACCT_A.app,
        assignAcctAReason,
        nextUuid(),
        computeAssignProjectAccountantFingerprint({
          project_id: PRJ_1,
          accountant_ref: ACCT_A.app,
          valid_from: null,
          expected_version: 0,
          reason: assignAcctAReason,
        }),
      ],
    );
    const acctAAssignmentId = assignAcctARes.rows[0].data.assignment_id;

    // Assign ACCT_B as Project Accountant for PRJ_2
    const assignAcctBPrj2Reason = "Phân công Kế toán B phụ trách PRJ_2";
    await db.query(
      `select public.vendor_finance_assign_project_accountant_admin(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 0, null::date, $5::text, $6::uuid, $7::text
       )`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        PRJ_2,
        ACCT_B.app,
        assignAcctBPrj2Reason,
        nextUuid(),
        computeAssignProjectAccountantFingerprint({
          project_id: PRJ_2,
          accountant_ref: ACCT_B.app,
          valid_from: null,
          expected_version: 0,
          reason: assignAcctBPrj2Reason,
        }),
      ],
    );

    // Seed SUBMITTED workers on PRJ_1 and PRJ_2, plus a DRAFT worker on PRJ_1
    const prj1Batch = await db.query(
      `select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data`,
      [
        PM_1.auth,
        PM_1.app,
        JSON.stringify([
          {
            project_id: PRJ_1,
            first_work_date: "2026-10-01",
            employee_code: "hrp-2026-800001",
            worker_details: makeWorkerDetails("Nguyễn Công Nhân Bắc 1"),
            recruiter_id: PM_1.recruiter,
            labor_type: "TEMPORARY",
          },
          {
            project_id: PRJ_1,
            first_work_date: "2026-10-02",
            employee_code: "hrp-2026-800002",
            worker_details: makeWorkerDetails("Trần Công Nhân Bắc 2"),
            recruiter_id: PM_1.recruiter,
            labor_type: "TEMPORARY",
          },
        ]),
        "sal_adv_batch_prj1",
      ],
    );
    const prj1SubmissionId = prj1Batch.rows[0].data.submission_id;
    await db.query(
      `select public.direct_entry_transition_submission($1::uuid, $2::uuid, $3::uuid, 1, 'SUBMITTED', 'sal_adv_submit_prj1')`,
      [PM_1.auth, PM_1.app, prj1SubmissionId],
    );

    const { rows: prj1Entries } = await db.query(
      `select entry_id, employee_code from public.direct_entries
        where submission_id = $1::uuid order by employee_code`,
      [prj1SubmissionId],
    );
    const workerPrj1A = prj1Entries[0].entry_id;
    const workerPrj1B = prj1Entries[1].entry_id;

    // DRAFT worker on PRJ_1 (not yet SUBMITTED)
    const draftBatch = await db.query(
      `select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data`,
      [
        PM_1.auth,
        PM_1.app,
        JSON.stringify([
          {
            project_id: PRJ_1,
            first_work_date: "2026-10-05",
            employee_code: "hrp-2026-800099",
            worker_details: makeWorkerDetails("Lê Công Nhân Nháp"),
            recruiter_id: PM_1.recruiter,
            labor_type: "TEMPORARY",
          },
        ]),
        "sal_adv_batch_draft",
      ],
    );
    const { rows: draftEntries } = await db.query(
      `select entry_id from public.direct_entries where submission_id = $1::uuid`,
      [draftBatch.rows[0].data.submission_id],
    );
    const draftWorkerPrj1 = draftEntries[0].entry_id;

    // SUBMITTED worker on PRJ_2
    const prj2Batch = await db.query(
      `select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data`,
      [
        PM_2.auth,
        PM_2.app,
        JSON.stringify([
          {
            project_id: PRJ_2,
            first_work_date: "2026-10-03",
            employee_code: "hrp-2026-800003",
            worker_details: makeWorkerDetails("Phạm Công Nhân Nam 1"),
            recruiter_id: PM_2.recruiter,
            labor_type: "TEMPORARY",
          },
        ]),
        "sal_adv_batch_prj2",
      ],
    );
    await db.query(
      `select public.direct_entry_transition_submission($1::uuid, $2::uuid, $3::uuid, 1, 'SUBMITTED', 'sal_adv_submit_prj2')`,
      [PM_2.auth, PM_2.app, prj2Batch.rows[0].data.submission_id],
    );
    const { rows: prj2Entries } = await db.query(
      `select entry_id from public.direct_entries where submission_id = $1::uuid`,
      [prj2Batch.rows[0].data.submission_id],
    );
    const workerPrj2 = prj2Entries[0].entry_id;

    // =========================================================================
    // AREA 1: Authorization Matrix & VFIN Non-Escalation Guard
    // =========================================================================
    for (const vfinActor of [VFIN_ONLY_ACTOR, VFIN_CASH_HOLDER_ACTOR]) {
      const { rows: internalAuthRows } = await db.query(
        `select public.salary_advance__internal_resolve_authority($1::uuid, $2::uuid) as auth`,
        [vfinActor.auth, vfinActor.app],
      );
      assert.deepEqual(
        {
          allowed: internalAuthRows[0].auth.allowed,
          is_project_manager: internalAuthRows[0].auth.is_project_manager,
          is_project_accountant: internalAuthRows[0].auth.is_project_accountant,
          is_supervisory_viewer: internalAuthRows[0].auth.is_supervisory_viewer,
          is_full_admin: internalAuthRows[0].auth.is_full_admin,
          is_bod: internalAuthRows[0].auth.is_bod,
        },
        {
          allowed: false,
          is_project_manager: false,
          is_project_accountant: false,
          is_supervisory_viewer: false,
          is_full_admin: false,
          is_bod: false,
        },
      );

      const vfinOnlyCtx = await repo.getActorContext({
        auth_subject: vfinActor.auth,
        app_user_id: vfinActor.app,
      });
      assert.deepEqual(vfinOnlyCtx, {
        ok: false,
        code: "SALARY_ADVANCE_ACCESS_DENIED",
      });

      const vfinOnlyList = await repo.listRequests({
        auth_subject: vfinActor.auth,
        app_user_id: vfinActor.app,
        queue: "ALL",
        project_id: null,
        request_state: null,
        evidence_review_state: null,
        search: null,
        cursor: null,
        page_size: 25,
      });
      assert.deepEqual(vfinOnlyList, {
        ok: false,
        code: "SALARY_ADVANCE_ACCESS_DENIED",
      });
    }

    // PM_1 can list SUBMITTED workers on PRJ_1 (excluding DRAFT worker)
    const pm1Workers = await repo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      search: null,
      cursor: null,
      page_size: 25,
    });
    assert.equal(pm1Workers.ok, true);
    if (pm1Workers.ok) {
      assert.equal(pm1Workers.data.workers.length, 2);
      assert.deepEqual(
        pm1Workers.data.workers.map((w) => w.worker_entry_id),
        [workerPrj1A, workerPrj1B],
      );
    }

    // PM_1 denied listing workers on PRJ_2
    const pm1WrongPrjWorkers = await repo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_2,
      search: null,
      cursor: null,
      page_size: 25,
    });
    assert.deepEqual(pm1WrongPrjWorkers, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    // PM_1 denied creating request on PRJ_2
    const createWrongPrj = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_2,
      worker_entry_id: workerPrj2,
      requested_amount_vnd: "2000000",
      initial_content: "Ứng lương trái dự án",
      idempotency_key: "idem-wrong-prj-01",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_2,
        worker_entry_id: workerPrj2,
        requested_amount_vnd: "2000000",
        initial_content: "Ứng lương trái dự án",
      }),
    });
    assert.deepEqual(createWrongPrj, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    // PM_1 denied creating request on PRJ_1 for worker belonging to PRJ_2
    const createMismatchWorker = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj2,
      requested_amount_vnd: "2000000",
      initial_content: "Ứng lương sai NLĐ",
      idempotency_key: "idem-mismatch-worker-01",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj2,
        requested_amount_vnd: "2000000",
        initial_content: "Ứng lương sai NLĐ",
      }),
    });
    assert.deepEqual(createMismatchWorker, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_PROJECT_MISMATCH",
    });

    // PM_1 denied creating request for DRAFT worker
    const createDraftWorker = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: draftWorkerPrj1,
      requested_amount_vnd: "2000000",
      initial_content: "Ứng lương NLĐ nháp",
      idempotency_key: "idem-draft-worker-01",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: draftWorkerPrj1,
        requested_amount_vnd: "2000000",
        initial_content: "Ứng lương NLĐ nháp",
      }),
    });
    assert.deepEqual(createDraftWorker, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_NOT_FOUND",
    });

    // PM_1 denied creating request on PRJ_NO_ACCT (no active project accountant)
    const createNoAcctPrj = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_NO_ACCT,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "2000000",
      initial_content: "Dự án chưa có kế toán",
      idempotency_key: "idem-no-acct-prj-01",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_NO_ACCT,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: "2000000",
        initial_content: "Dự án chưa có kế toán",
      }),
    });
    assert.deepEqual(createNoAcctPrj, {
      ok: false,
      code: "SALARY_ADVANCE_PROJECT_ACCOUNTANT_UNASSIGNED",
    });

    // =========================================================================
    // AREA 4: Positive Integer VND Amounts (No Business Cap) & Idempotency
    // =========================================================================
    for (const badAmount of ["0", "-500000", "12.34", "9223372036854775808"]) {
      const badRes = await repo.createRequest({
        auth_subject: PM_1.auth,
        app_user_id: PM_1.app,
        project_id: PRJ_1,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: badAmount,
        initial_content: "Số tiền không hợp lệ",
        idempotency_key: `idem-bad-amt-${badAmount}`,
        request_fingerprint: computeCreateRequestFingerprint({
          project_id: PRJ_1,
          worker_entry_id: workerPrj1A,
          requested_amount_vnd: badAmount,
          initial_content: "Số tiền không hợp lệ",
        }),
      });
      assert.deepEqual(badRes, {
        ok: false,
        code: "SALARY_ADVANCE_AMOUNT_INVALID",
      });
    }

    // Create main request with large positive amount (e.g. 250,000,000 VND — no business cap)
    const createFp1 = computeCreateRequestFingerprint({
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "250000000",
      initial_content: "Ứng lương đợt 1 cho công nhân Bắc 1",
    });
    const created1 = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "250000000",
      initial_content: "Ứng lương đợt 1 cho công nhân Bắc 1",
      idempotency_key: "idem-create-req-001",
      request_fingerprint: createFp1,
    });
    assert.equal(created1.ok, true);
    assert.equal(created1.data.replayed, false);
    assert.equal(created1.data.request.requested_amount_vnd, "250000000");
    assert.equal(created1.data.request.request_state, "OPEN");
    assert.equal(created1.data.request.evidence_review_state, "NOT_UPLOADED");
    assert.equal(created1.data.request.version, 1);
    assert.equal(created1.data.request.worker_employee_code, "hrp-2026-800001");
    assert.equal(
      created1.data.request.worker_display_name,
      "Nguyễn Công Nhân Bắc 1",
    );
    const req1Id = created1.data.request.request_id;

    // Idempotent replay with same key & payload returns replayed: true
    const created1Replay = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "250000000",
      initial_content: "Ứng lương đợt 1 cho công nhân Bắc 1",
      idempotency_key: "idem-create-req-001",
      request_fingerprint: createFp1,
    });
    assert.equal(created1Replay.ok, true);
    assert.equal(created1Replay.data.replayed, true);
    assert.equal(created1Replay.data.request.request_id, req1Id);

    // Same idempotency key with different payload -> 409 SALARY_ADVANCE_IDEMPOTENCY_CONFLICT
    const created1Conflict = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "300000000",
      initial_content: "Ứng lương đợt 1 cho công nhân Bắc 1",
      idempotency_key: "idem-create-req-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: "300000000",
        initial_content: "Ứng lương đợt 1 cho công nhân Bắc 1",
      }),
    });
    assert.deepEqual(created1Conflict, {
      ok: false,
      code: "SALARY_ADVANCE_IDEMPOTENCY_CONFLICT",
    });

    // PM_1B (another manager on PRJ_1, not creator of req1Id) cannot view or mutate req1Id
    const pm1bRead = await repo.getRequestDetail({
      auth_subject: PM_1B.auth,
      app_user_id: PM_1B.app,
      request_id: req1Id,
    });
    assert.deepEqual(pm1bRead, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    // Supervisory viewers (FULL_ADMIN & CANONICAL_BOD) can view req1Id, but CANNOT mutate/approve
    for (const sup of [FULL_ADMIN, CANONICAL_BOD]) {
      const supCtx = await repo.getActorContext({
        auth_subject: sup.auth,
        app_user_id: sup.app,
      });
      assert.equal(supCtx.ok, true);
      assert.equal(supCtx.data.is_supervisory_viewer, true);

      const supDetail = await repo.getRequestDetail({
        auth_subject: sup.auth,
        app_user_id: sup.app,
        request_id: req1Id,
      });
      assert.equal(supDetail.ok, true);
      assert.deepEqual(supDetail.data.request.allowed_actions, {
        can_post_message: false,
        can_provide_info: false,
        can_withdraw: false,
        can_upload_evidence: false,
        can_request_info: false,
        can_approve: false,
        can_reject: false,
        can_mark_handled_externally: false,
        can_review_evidence: false,
      });

      const supApprove = await repo.transitionRequest({
        auth_subject: sup.auth,
        app_user_id: sup.app,
        request_id: req1Id,
        action: "APPROVE",
        expected_version: 1,
        message_text: null,
        idempotency_key: `idem-sup-approve-${sup.app}`,
        request_fingerprint: computeTransitionRequestFingerprint({
          request_id: req1Id,
          action: "APPROVE",
          expected_version: 1,
          message_text: null,
        }),
      });
      assert.deepEqual(supApprove, {
        ok: false,
        code: "SALARY_ADVANCE_ACCESS_DENIED",
      });
    }

    // =========================================================================
    // AREA 2: State Machine (OPEN -> NEEDS_INFO -> OPEN -> APPROVED)
    // =========================================================================
    // Evidence upload BEFORE APPROVED must be rejected
    const earlyReserve = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      expected_version: 1,
      mime_type: "image/jpeg",
      size_bytes: 1024,
      checksum_sha256: "a".repeat(64),
      caption_note: null,
      idempotency_key: "idem-early-reserve-01",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 1,
        mime_type: "image/jpeg",
        size_bytes: 1024,
        checksum_sha256: "a".repeat(64),
        caption_note: null,
      }),
    });
    assert.deepEqual(earlyReserve, {
      ok: false,
      code: "SALARY_ADVANCE_STATE_CONFLICT",
    });

    // ACCT_A requests info (OPEN -> NEEDS_INFO, version 1 -> 2)
    const reqInfoRes = await repo.transitionRequest({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      request_id: req1Id,
      action: "REQUEST_INFO",
      expected_version: 1,
      message_text: "Đề nghị QLDA xác nhận lại bảng chấm công tuần 1",
      idempotency_key: "idem-acct-a-req-info-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req1Id,
        action: "REQUEST_INFO",
        expected_version: 1,
        message_text: "Đề nghị QLDA xác nhận lại bảng chấm công tuần 1",
      }),
    });
    assert.equal(reqInfoRes.ok, true);
    assert.equal(reqInfoRes.data.request.request_state, "NEEDS_INFO");
    assert.equal(reqInfoRes.data.request.version, 2);

    // PM_1 provides info (NEEDS_INFO -> OPEN, version 2 -> 3)
    const provideInfoRes = await repo.transitionRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      action: "PROVIDE_INFO",
      expected_version: 2,
      message_text: "Đã đối chiếu đủ 6 công tuần 1",
      idempotency_key: "idem-pm1-provide-info-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req1Id,
        action: "PROVIDE_INFO",
        expected_version: 2,
        message_text: "Đã đối chiếu đủ 6 công tuần 1",
      }),
    });
    assert.equal(provideInfoRes.ok, true);
    assert.equal(provideInfoRes.data.request.request_state, "OPEN");
    assert.equal(provideInfoRes.data.request.version, 3);

    // =========================================================================
    // AREA 1 (cont.): Project Accountant Handover (ACCT_A -> ACCT_B on PRJ_1)
    // =========================================================================
    const endAcctAReason = "Bàn giao dự án Bắc từ Kế toán A sang Kế toán B";
    await db.query(
      `select public.vendor_finance_end_project_accountant_admin(
         $1::uuid, $2::uuid, $3::uuid, 1, null::date, $4::text, $5::uuid, $6::text
       )`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        acctAAssignmentId,
        endAcctAReason,
        nextUuid(),
        computeEndProjectAccountantFingerprint({
          assignment_id: acctAAssignmentId,
          expected_version: 1,
          valid_to: null,
          reason: endAcctAReason,
        }),
      ],
    );

    const assignAcctBPrj1Reason = "Phân công Kế toán B tiếp nhận PRJ_1";
    await db.query(
      `select public.vendor_finance_assign_project_accountant_admin(
         $1::uuid, $2::uuid, $3::text, $4::uuid, 1, null::date, $5::text, $6::uuid, $7::text
       )`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        PRJ_1,
        ACCT_B.app,
        assignAcctBPrj1Reason,
        nextUuid(),
        computeAssignProjectAccountantFingerprint({
          project_id: PRJ_1,
          accountant_ref: ACCT_B.app,
          valid_from: null,
          expected_version: 1,
          reason: assignAcctBPrj1Reason,
        }),
      ],
    );

    // ACCT_A immediately loses access to PRJ_1 requests
    const acctADenied = await repo.getRequestDetail({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      request_id: req1Id,
    });
    assert.deepEqual(acctADenied, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    // ACCT_B now sees and approves req1Id (OPEN -> APPROVED, version 3 -> 4),
    // while ACCT_A's historical INFO_REQUESTED event still preserves ACCT_A's identity!
    const approveRes = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      action: "APPROVE",
      expected_version: 3,
      message_text: null,
      idempotency_key: "idem-acct-b-approve-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req1Id,
        action: "APPROVE",
        expected_version: 3,
        message_text: null,
      }),
    });
    assert.equal(approveRes.ok, true);
    assert.equal(approveRes.data.request.request_state, "APPROVED");
    assert.equal(approveRes.data.request.evidence_review_state, "NOT_UPLOADED");
    assert.equal(approveRes.data.request.version, 4);
    assert.equal(approveRes.data.request.decided_by_user_id, ACCT_B.app);

    const infoRequestedEvent = approveRes.data.events.find(
      (ev) => ev.event_type === "INFO_REQUESTED",
    );
    assert.ok(infoRequestedEvent);
    assert.equal(infoRequestedEvent.actor_user_id, ACCT_A.app);
    assert.equal(infoRequestedEvent.actor_display_name, ACCT_A.name);

    // After APPROVED, QLDA cannot withdraw
    const withdrawAfterApproved = await repo.transitionRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      action: "WITHDRAW",
      expected_version: 4,
      message_text: "Muốn rút sau khi đã duyệt",
      idempotency_key: "idem-withdraw-after-approve",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req1Id,
        action: "WITHDRAW",
        expected_version: 4,
        message_text: "Muốn rút sau khi đã duyệt",
      }),
    });
    assert.deepEqual(withdrawAfterApproved, {
      ok: false,
      code: "SALARY_ADVANCE_STATE_CONFLICT",
    });

    // =========================================================================
    // AREA 3, 5 & 6: Cash-Receipt Evidence Versioning, Superseded Race & 4-Way Portrait Lock
    // =========================================================================
    // Reserve Attempt 1 (will be superseded by Attempt 2 before finalizing)
    const reserve1 = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      expected_version: 4,
      mime_type: "image/jpeg",
      size_bytes: 2048,
      checksum_sha256: "1".repeat(64),
      caption_note: "Ảnh lần 1 (bị thay thế)",
      idempotency_key: "idem-reserve-ev-01",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 4,
        mime_type: "image/jpeg",
        size_bytes: 2048,
        checksum_sha256: "1".repeat(64),
        caption_note: "Ảnh lần 1 (bị thay thế)",
      }),
    });
    assert.equal(reserve1.ok, true);
    assert.equal(reserve1.data.superseded_storage_key, null);

    // Reserve Attempt 2 on same version 4 -> supersedes Attempt 1
    const reserve2 = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      expected_version: 4,
      mime_type: "image/jpeg",
      size_bytes: 4096,
      checksum_sha256: "2".repeat(64),
      caption_note: "Ảnh nhận tiền đợt 1 (v1)",
      idempotency_key: "idem-reserve-ev-02",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 4,
        mime_type: "image/jpeg",
        size_bytes: 4096,
        checksum_sha256: "2".repeat(64),
        caption_note: "Ảnh nhận tiền đợt 1 (v1)",
      }),
    });
    assert.equal(reserve2.ok, true);
    assert.equal(
      reserve2.data.superseded_storage_key,
      reserve1.data.storage_key,
    );

    // Attempt 1 tries to finalize -> rejected with 409 SALARY_ADVANCE_UPLOAD_SUPERSEDED
    const finalizeSuperseded = await repo.getEvidenceFinalizeContext({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      upload_id: reserve1.data.upload_id,
      expected_version: 4,
      idempotency_key: "idem-finalize-ev-01",
      request_fingerprint: computeFinalizeEvidenceFingerprint({
        request_id: req1Id,
        upload_id: reserve1.data.upload_id,
        expected_version: 4,
      }),
    });
    assert.deepEqual(finalizeSuperseded, {
      ok: false,
      code: "SALARY_ADVANCE_UPLOAD_SUPERSEDED",
    });

    // Attempt 2 finalizes -> commits evidence_version = 1, version 4 -> 5,
    // evidence_review_state = 'PENDING_REVIEW', request_state stays 'APPROVED'
    const finalize2Fp = computeFinalizeEvidenceFingerprint({
      request_id: req1Id,
      upload_id: reserve2.data.upload_id,
      expected_version: 4,
    });
    const finalize2Res = await repo.finalizeEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      upload_id: reserve2.data.upload_id,
      expected_version: 4,
      idempotency_key: "idem-finalize-ev-02",
      request_fingerprint: finalize2Fp,
    });
    assert.equal(finalize2Res.ok, true);
    assert.equal(finalize2Res.data.request.request_state, "APPROVED");
    assert.equal(
      finalize2Res.data.request.evidence_review_state,
      "PENDING_REVIEW",
    );
    assert.equal(finalize2Res.data.request.version, 5);
    assert.equal(
      finalize2Res.data.request.current_evidence?.evidence_version,
      1,
    );
    assert.equal(finalize2Res.data.evidence_versions.length, 1);

    // ACCT_B marks evidence RETAKE_REQUIRED with optional note = null (version 5 -> 6)
    // request_state stays APPROVED!
    const retakeRes = await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_version: 5,
      evidence_version: 1,
      decision: "RETAKE_REQUIRED",
      expected_worker_portrait_document_id: null,
      expected_worker_portrait_version: null,
      note: null,
      idempotency_key: "idem-review-retake-01",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 5,
        evidence_version: 1,
        decision: "RETAKE_REQUIRED",
        expected_worker_portrait_document_id: null,
        expected_worker_portrait_version: null,
        note: null,
      }),
    });
    assert.equal(retakeRes.ok, true);
    assert.equal(retakeRes.data.request.request_state, "APPROVED");
    assert.equal(
      retakeRes.data.request.evidence_review_state,
      "RETAKE_REQUIRED",
    );
    assert.equal(retakeRes.data.request.version, 6);

    // PM_1 uploads replacement evidence -> creates evidence_version = 2, preserves version 1 in history!
    const reserveV2 = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      expected_version: 6,
      mime_type: "image/png",
      size_bytes: 5120,
      checksum_sha256: "3".repeat(64),
      caption_note: "Ảnh chụp lại rõ mặt NLĐ (v2)",
      idempotency_key: "idem-reserve-ev-v2",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 6,
        mime_type: "image/png",
        size_bytes: 5120,
        checksum_sha256: "3".repeat(64),
        caption_note: "Ảnh chụp lại rõ mặt NLĐ (v2)",
      }),
    });
    assert.equal(reserveV2.ok, true);

    const finalizeV2 = await repo.finalizeEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
      upload_id: reserveV2.data.upload_id,
      expected_version: 6,
      idempotency_key: "idem-finalize-ev-v2",
      request_fingerprint: computeFinalizeEvidenceFingerprint({
        request_id: req1Id,
        upload_id: reserveV2.data.upload_id,
        expected_version: 6,
      }),
    });
    assert.equal(finalizeV2.ok, true);
    assert.equal(finalizeV2.data.request.request_state, "APPROVED");
    assert.equal(
      finalizeV2.data.request.evidence_review_state,
      "PENDING_REVIEW",
    );
    assert.equal(finalizeV2.data.request.version, 7);
    assert.equal(
      finalizeV2.data.request.current_evidence?.evidence_version,
      2,
    );
    assert.deepEqual(
      finalizeV2.data.evidence_versions.map((v) => v.evidence_version),
      [2, 1],
    );

    // Both version 1 and version 2 can be previewed by ACCT_B
    const previewV1 = await repo.getEvidencePreviewContext({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      evidence_version: 1,
    });
    assert.equal(previewV1.ok, true);
    assert.equal(previewV1.data.storage_key, reserve2.data.storage_key);

    const previewV2 = await repo.getEvidencePreviewContext({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      evidence_version: 2,
    });
    assert.equal(previewV2.ok, true);
    assert.equal(previewV2.data.storage_key, reserveV2.data.storage_key);

    // Reviewing as REVIEWED when worker has NO portrait yet -> 409 SALARY_ADVANCE_WORKER_PORTRAIT_MISSING
    const dummyPortraitId = nextUuid();
    const reviewNoPortrait = await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_version: 7,
      evidence_version: 2,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: dummyPortraitId,
      expected_worker_portrait_version: 1,
      note: null,
      idempotency_key: "idem-review-no-portrait",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 7,
        evidence_version: 2,
        decision: "REVIEWED",
        expected_worker_portrait_document_id: dummyPortraitId,
        expected_worker_portrait_version: 1,
        note: null,
      }),
    });
    assert.deepEqual(reviewNoPortrait, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_PORTRAIT_MISSING",
    });

    // Upload worker portrait v1 for workerPrj1A
    const portraitV1 = await seedWorkerPortraitVersion(
      db,
      PM_1,
      workerPrj1A,
      "b",
    );
    assert.equal(portraitV1.version, 1);

    // Rotate worker portrait to v2 BEFORE ACCT_B submits REVIEWED with v1 lock
    const portraitV2 = await seedWorkerPortraitVersion(
      db,
      PM_1,
      workerPrj1A,
      "c",
    );
    assert.equal(portraitV2.version, 2);

    // ACCT_B tries to review with stale portrait v1 lock -> 409 SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT
    const reviewStalePortrait = await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_version: 7,
      evidence_version: 2,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: portraitV1.document_id,
      expected_worker_portrait_version: 1,
      note: null,
      idempotency_key: "idem-review-stale-portrait",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 7,
        evidence_version: 2,
        decision: "REVIEWED",
        expected_worker_portrait_document_id: portraitV1.document_id,
        expected_worker_portrait_version: 1,
        note: null,
      }),
    });
    assert.deepEqual(reviewStalePortrait, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT",
    });

    // Worker portrait context with stale expected_document_id also returns 409 conflict
    const portraitCtxStale = await repo.getWorkerPortraitContext({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_document_id: portraitV1.document_id,
    });
    assert.deepEqual(portraitCtxStale, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT",
    });

    // Worker portrait context with current portraitV2 succeeds for ACCT_B
    const portraitCtxOk = await repo.getWorkerPortraitContext({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_document_id: portraitV2.document_id,
    });
    assert.equal(portraitCtxOk.ok, true);
    assert.equal(portraitCtxOk.data.document_id, portraitV2.document_id);
    assert.equal(portraitCtxOk.data.version, 2);

    // ACCT_B reviews evidence v2 with matching portraitV2 lock (note = null) -> REVIEWED!
    // request_state stays APPROVED!
    const reviewedOk = await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      expected_version: 7,
      evidence_version: 2,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: portraitV2.document_id,
      expected_worker_portrait_version: 2,
      note: null,
      idempotency_key: "idem-review-ok-v2",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: req1Id,
        expected_version: 7,
        evidence_version: 2,
        decision: "REVIEWED",
        expected_worker_portrait_document_id: portraitV2.document_id,
        expected_worker_portrait_version: 2,
        note: null,
      }),
    });
    assert.equal(reviewedOk.ok, true);
    assert.equal(reviewedOk.data.request.request_state, "APPROVED");
    assert.equal(reviewedOk.data.request.evidence_review_state, "REVIEWED");
    assert.equal(reviewedOk.data.request.version, 8);
    assert.equal(
      reviewedOk.data.request.current_evidence
        ?.reviewed_worker_portrait_document_id,
      portraitV2.document_id,
    );
    assert.equal(
      reviewedOk.data.request.current_evidence
        ?.reviewed_worker_portrait_version,
      2,
    );

    // ACCT_B marks request HANDLED_EXTERNALLY (APPROVED -> HANDLED_EXTERNALLY, version 8 -> 9)
    const handledRes = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req1Id,
      action: "MARK_HANDLED_EXTERNALLY",
      expected_version: 8,
      message_text: "Đã tất toán trên phần mềm kế toán ngoài BI",
      idempotency_key: "idem-handled-ext-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req1Id,
        action: "MARK_HANDLED_EXTERNALLY",
        expected_version: 8,
        message_text: "Đã tất toán trên phần mềm kế toán ngoài BI",
      }),
    });
    assert.equal(handledRes.ok, true);
    assert.equal(handledRes.data.request.request_state, "HANDLED_EXTERNALLY");
    assert.equal(handledRes.data.request.evidence_review_state, "REVIEWED");
    assert.equal(handledRes.data.request.version, 9);

    // Additional requests to test REJECT (requires reason) and WITHDRAW (before decision)
    // plus MAX_PG_BIGINT amount support
    const created2 = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: MAX_PG_BIGINT.toString(),
      initial_content: "Ứng lương kiểm tra số tiền lớn nhất bigint",
      idempotency_key: "idem-create-req-002",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: MAX_PG_BIGINT.toString(),
        initial_content: "Ứng lương kiểm tra số tiền lớn nhất bigint",
      }),
    });
    assert.equal(created2.ok, true);
    assert.equal(
      created2.data.request.requested_amount_vnd,
      MAX_PG_BIGINT.toString(),
    );
    const req2Id = created2.data.request.request_id;

    // REJECT without reason fails with SALARY_ADVANCE_REASON_REQUIRED
    const rejectNoReason = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req2Id,
      action: "REJECT",
      expected_version: 1,
      message_text: null,
      idempotency_key: "idem-reject-no-reason",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req2Id,
        action: "REJECT",
        expected_version: 1,
        message_text: null,
      }),
    });
    assert.deepEqual(rejectNoReason, {
      ok: false,
      code: "SALARY_ADVANCE_REASON_REQUIRED",
    });

    // REJECT with reason transitions OPEN -> REJECTED
    const rejectOk = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req2Id,
      action: "REJECT",
      expected_version: 1,
      message_text: "Chưa đủ ngày công thực tế trong kỳ",
      idempotency_key: "idem-reject-ok-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req2Id,
        action: "REJECT",
        expected_version: 1,
        message_text: "Chưa đủ ngày công thực tế trong kỳ",
      }),
    });
    assert.equal(rejectOk.ok, true);
    assert.equal(rejectOk.data.request.request_state, "REJECTED");

    // Request 3: QLDA withdraws before decision (OPEN -> WITHDRAWN)
    const created3 = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "3000000",
      initial_content: "Ứng lương sẽ rút trước khi duyệt",
      idempotency_key: "idem-create-req-003",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "3000000",
        initial_content: "Ứng lương sẽ rút trước khi duyệt",
      }),
    });
    assert.equal(created3.ok, true);
    const req3Id = created3.data.request.request_id;

    // Accountant cannot withdraw
    const acctWithdraw = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: req3Id,
      action: "WITHDRAW",
      expected_version: 1,
      message_text: null,
      idempotency_key: "idem-acct-withdraw-denied",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req3Id,
        action: "WITHDRAW",
        expected_version: 1,
        message_text: null,
      }),
    });
    assert.deepEqual(acctWithdraw, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    // Creating QLDA withdraws before decision -> WITHDRAWN
    const pmWithdraw = await repo.transitionRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req3Id,
      action: "WITHDRAW",
      expected_version: 1,
      message_text: "NLĐ báo không cần ứng nữa",
      idempotency_key: "idem-pm-withdraw-ok",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: req3Id,
        action: "WITHDRAW",
        expected_version: 1,
        message_text: "NLĐ báo không cần ứng nữa",
      }),
    });
    assert.equal(pmWithdraw.ok, true);
    assert.equal(pmWithdraw.data.request.request_state, "WITHDRAWN");

    // =========================================================================
    // HOTFIX VERIFICATION: Unified Actor Display Name Resolution
    //   1. Verified current linked recruiter display_name wins over login-id in
    //      direct_entry_app_users.display_name (e.g. 'yenlh.td' -> 'QLDA Dự Án Bắc 01').
    //   2. Unlinked account falls back to direct_entry_app_users.display_name.
    //   3. Blank or UUID direct_entry_app_users.display_name falls back to
    //      auth.users email local-part login_id (and never raw UUID).
    // =========================================================================
    await db.exec("alter table auth.users add column if not exists email text;");
    await db.query(
      "update auth.users set email = 'yenlh.td@hrpvietnam.com' where id = $1::uuid",
      [PM_1.auth],
    );
    await db.query(
      "update public.direct_entry_app_users set display_name = 'yenlh.td' where app_user_id = $1::uuid",
      [PM_1.app],
    );
    await db.query(
      "update auth.users set email = 'ketoan.b@hrpvietnam.com' where id = $1::uuid",
      [ACCT_B.auth],
    );
    await db.query(
      "update public.direct_entry_app_users set display_name = 'ketoan.b' where app_user_id = $1::uuid",
      [ACCT_B.app],
    );

    const pm1ContextAfterLoginId = await repo.getActorContext({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
    });
    assert.equal(pm1ContextAfterLoginId.ok, true);
    assert.equal(
      pm1ContextAfterLoginId.data.display_name,
      PM_1.name,
      "Actor context must resolve verified current linked recruiter name instead of account login-id display_name",
    );
    const prj1InContext = pm1ContextAfterLoginId.data.managed_projects.find(
      (p) => p.project_id === PRJ_1,
    );
    assert.equal(
      prj1InContext?.accountant_display_name,
      ACCT_B.name,
      "Managed project accountant_display_name must resolve verified current linked recruiter name",
    );

    const detailAfterLoginId = await repo.getRequestDetail({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: req1Id,
    });
    assert.equal(detailAfterLoginId.ok, true);
    assert.equal(
      detailAfterLoginId.data.request.created_by_display_name,
      PM_1.name,
      "Request created_by_display_name must resolve verified current linked recruiter name instead of 'yenlh.td'",
    );
    assert.equal(
      detailAfterLoginId.data.request.current_project_accountant?.display_name,
      ACCT_B.name,
      "Request current_project_accountant.display_name must resolve verified current linked recruiter name",
    );
    assert.equal(
      detailAfterLoginId.data.request.current_evidence?.uploaded_by_display_name,
      PM_1.name,
      "Evidence uploaded_by_display_name must resolve verified current linked recruiter name",
    );
    assert.equal(
      detailAfterLoginId.data.request.current_evidence?.reviewed_by_display_name,
      ACCT_B.name,
      "Evidence reviewed_by_display_name must resolve verified current linked recruiter name",
    );
    assert.ok(
      detailAfterLoginId.data.events.every(
        (ev) =>
          ev.actor_display_name === PM_1.name ||
          ev.actor_display_name === ACCT_A.name ||
          ev.actor_display_name === ACCT_B.name,
      ),
      "Timeline events must resolve verified current linked recruiter names consistently",
    );

    // Fallback tier 2 & 3 check on unlinked account (FULL_ADMIN has no recruiter link)
    await db.query(
      "update auth.users set email = 'admin.bi@hrpvietnam.com' where id = $1::uuid",
      [FULL_ADMIN.auth],
    );
    await db.query(
      "update public.direct_entry_app_users set display_name = $1 where app_user_id = $1::uuid",
      [FULL_ADMIN.app],
    );
    const adminCtxWithUuidDisplayName = await repo.getActorContext({
      auth_subject: FULL_ADMIN.auth,
      app_user_id: FULL_ADMIN.app,
    });
    assert.equal(adminCtxWithUuidDisplayName.ok, true);
    assert.equal(
      adminCtxWithUuidDisplayName.data.display_name,
      "admin.bi",
      "When unlinked and u.display_name is a raw UUID, actor display name must fall back to auth.users login_id ('admin.bi')",
    );

    // =========================================================================
    // HOTFIX VERIFICATION: Payment Method (CASH vs BANK_TRANSFER), Self-Owned
    // Bank Account Validation, Snapshot Immutability & Receipt Review
    // =========================================================================
    await db.query(
      `insert into public.direct_entry_banks (bank_id, display_name, active)
       values ('VCB_SAL_ADV', 'Vietcombank', true)
       on conflict (bank_id) do nothing`,
    );

    // 1. Creating BANK_TRANSFER when worker has no bank account fails with SALARY_ADVANCE_BANK_ACCOUNT_MISSING
    const bankMissingRes = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "2000000",
      payment_method: "BANK_TRANSFER",
      initial_content: "Ứng lương chuyển khoản khi chưa có TK",
      idempotency_key: "idem-bank-missing-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "2000000",
        payment_method: "BANK_TRANSFER",
        initial_content: "Ứng lương chuyển khoản khi chưa có TK",
      }),
    });
    assert.deepEqual(bankMissingRes, {
      ok: false,
      code: "SALARY_ADVANCE_BANK_ACCOUNT_MISSING",
    });

    // 2. Non-self-owned bank account (holder name != worker display_name) fails with SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED
    await db.query(
      `insert into public.direct_entry_payments (entry_id, state, account_number, bank_id, account_holder_name, version)
       values ($1::uuid, 'provided', '0123456789', 'VCB_SAL_ADV', 'NGUYEN VAN NGUOI KHAC', 1)
       on conflict (entry_id) do update
         set state = 'provided',
             account_number = excluded.account_number,
             bank_id = excluded.bank_id,
             account_holder_name = excluded.account_holder_name,
             version = public.direct_entry_payments.version + 1`,
      [workerPrj1B],
    );

    const bankNotSelfOwnedRes = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "2000000",
      payment_method: "BANK_TRANSFER",
      initial_content: "Ứng lương chuyển khoản không chính chủ",
      idempotency_key: "idem-bank-not-self-owned-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "2000000",
        payment_method: "BANK_TRANSFER",
        initial_content: "Ứng lương chuyển khoản không chính chủ",
      }),
    });
    assert.deepEqual(bankNotSelfOwnedRes, {
      ok: false,
      code: "SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED",
    });

    // 3. Self-owned bank account (normalized 'TRAN CONG NHAN BAC 2' matches 'Trần Công Nhân Bắc 2') succeeds
    await db.query(
      `update public.direct_entry_payments
          set account_holder_name = '  tran   cong nhan bac 2 ',
              version = version + 1
        where entry_id = $1::uuid`,
      [workerPrj1B],
    );

    const bankCreateOk = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "4500000",
      payment_method: "BANK_TRANSFER",
      initial_content: "Ứng lương chuyển khoản chính chủ",
      idempotency_key: "idem-bank-ok-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "4500000",
        payment_method: "BANK_TRANSFER",
        initial_content: "Ứng lương chuyển khoản chính chủ",
      }),
    });
    assert.equal(bankCreateOk.ok, true);
    assert.equal(bankCreateOk.data.request.payment_method, "BANK_TRANSFER");
    assert.equal(
      bankCreateOk.data.request.payment_destination_snapshot?.institution_name,
      "Vietcombank",
    );
    assert.equal(
      bankCreateOk.data.request.payment_destination_snapshot?.account_number,
      "0123456789",
    );
    const bankReqId = bankCreateOk.data.request.request_id;

    // Modify worker's bank account in direct_entry_payments afterwards -> existing request snapshot remains intact!
    await db.query(
      `update public.direct_entry_payments
          set account_number = '9999999999',
              version = version + 1
        where entry_id = $1::uuid`,
      [workerPrj1B],
    );
    const bankDetailAfterProfileChange = await repo.getRequestDetail({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: bankReqId,
    });
    assert.equal(bankDetailAfterProfileChange.ok, true);
    assert.equal(
      bankDetailAfterProfileChange.data.request.payment_destination_snapshot
        ?.account_number,
      "0123456789",
      "Existing BANK_TRANSFER request must preserve immutable payment_destination_snapshot when worker profile bank account changes",
    );

    // Approve BANK_TRANSFER request, upload transfer receipt, and review WITHOUT worker portrait (workerPrj1B has no portrait!)
    const approveBankReq = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: bankReqId,
      action: "APPROVE",
      expected_version: 1,
      message_text: "Chấp thuận chuyển khoản",
      idempotency_key: "idem-approve-bank-001",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: bankReqId,
        action: "APPROVE",
        expected_version: 1,
        message_text: "Chấp thuận chuyển khoản",
      }),
    });
    assert.equal(approveBankReq.ok, true);
    assert.equal(approveBankReq.data.request.request_state, "APPROVED");

    const bankReceiptSha = "e".repeat(64);
    const reserveBankReceipt = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: bankReqId,
      expected_version: 2,
      mime_type: "image/png",
      size_bytes: 2048,
      checksum_sha256: bankReceiptSha,
      caption_note: "Bill chuyển khoản VCB FT123456",
      idempotency_key: "idem-reserve-bank-receipt-001",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: bankReqId,
        expected_version: 2,
        mime_type: "image/png",
        size_bytes: 2048,
        checksum_sha256: bankReceiptSha,
        caption_note: "Bill chuyển khoản VCB FT123456",
      }),
    });
    assert.equal(reserveBankReceipt.ok, true);

    const finalizeBankReceipt = await repo.finalizeEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: bankReqId,
      upload_id: reserveBankReceipt.data.upload_id,
      expected_version: 2,
      idempotency_key: "idem-finalize-bank-receipt-001",
      request_fingerprint: computeFinalizeEvidenceFingerprint({
        request_id: bankReqId,
        upload_id: reserveBankReceipt.data.upload_id,
        expected_version: 2,
      }),
    });
    assert.equal(finalizeBankReceipt.ok, true);
    assert.equal(
      finalizeBankReceipt.data.request.current_evidence?.evidence_kind,
      "BANK_TRANSFER_RECEIPT",
    );

    const reviewBankReceipt = await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: bankReqId,
      expected_version: 3,
      evidence_version: 1,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: null,
      expected_worker_portrait_version: null,
      note: "Đã đối chiếu bill chuyển khoản khớp số tài khoản chính chủ",
      idempotency_key: "idem-review-bank-receipt-001",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: bankReqId,
        expected_version: 3,
        evidence_version: 1,
        decision: "REVIEWED",
        expected_worker_portrait_document_id: null,
        expected_worker_portrait_version: null,
        note: "Đã đối chiếu bill chuyển khoản khớp số tài khoản chính chủ",
      }),
    });
    assert.equal(reviewBankReceipt.ok, true);
    assert.equal(
      reviewBankReceipt.data.request.evidence_review_state,
      "REVIEWED",
      "BANK_TRANSFER_RECEIPT must allow REVIEWED confirmation without worker portrait lock",
    );

    // =========================================================================
    // HOTFIX VERIFICATION: Worker Eligibility Blocking in Picker, Create & Approve
    //   - OFF / UNCONFIRMED blocked
    //   - Active ON in >= 2 distinct projects blocked
    //   - Duplicate CCCD cluster (same_project_day_count >= 2) blocked
    //   - Raw CCCD never returned in worker picker or request projections
    //   - Existing requests never auto-deleted/cancelled when worker becomes ineligible,
    //     but APPROVE is blocked with clear error code
    // =========================================================================
    // Create an OPEN request for workerPrj1B while still eligible
    const openBeforeIneligible = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "1200000",
      payment_method: "CASH",
      initial_content: "Yêu cầu tạo khi NLĐ đang đủ điều kiện",
      idempotency_key: "idem-open-before-ineligible-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "1200000",
        payment_method: "CASH",
        initial_content: "Yêu cầu tạo khi NLĐ đang đủ điều kiện",
      }),
    });
    assert.equal(openBeforeIneligible.ok, true);
    const openReqBeforeIneligibleId =
      openBeforeIneligible.data.request.request_id;

    // Case A: Transition workerPrj1B to OFF -> blocked in picker, create, and APPROVE of existing request
    await db.query(
      `insert into public.direct_entry_employment_status_events
         (entry_id, status, effective_date, leave_date, leave_reason_text, version, actor_user_id, reason_id)
       select entry_id, 'OFF', '2026-10-20'::date, '2026-10-20'::date, 'Nghỉ việc tự nguyện',
              version + 1, $2::uuid, reason_id
         from public.direct_entry_employment_status_events
        where entry_id = $1::uuid
        order by version desc
        limit 1`,
      [workerPrj1B, PM_1.app],
    );

    const pickerAfterOff = await repo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      search: "hrp-2026-800002",
      cursor: null,
      page_size: 20,
    });
    assert.equal(pickerAfterOff.ok, true);
    const pickedOffWorker = pickerAfterOff.data.workers.find(
      (w) => w.worker_entry_id === workerPrj1B,
    );
    assert.equal(pickedOffWorker?.employment_status, "OFF");
    assert.equal(pickedOffWorker?.is_eligible, false);
    assert.ok(
      pickedOffWorker?.ineligible_reasons?.includes("WORKER_STATUS_OFF"),
    );

    const createWhenOff = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1B,
      requested_amount_vnd: "1000000",
      payment_method: "CASH",
      initial_content: "Thử tạo khi NLĐ đã OFF",
      idempotency_key: "idem-create-when-off-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1B,
        requested_amount_vnd: "1000000",
        payment_method: "CASH",
        initial_content: "Thử tạo khi NLĐ đã OFF",
      }),
    });
    assert.deepEqual(createWhenOff, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS",
    });

    // Existing OPEN request is NOT auto-deleted or auto-cancelled, but APPROVE is blocked!
    const approveWhenOff = await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: openReqBeforeIneligibleId,
      action: "APPROVE",
      expected_version: 1,
      message_text: null,
      idempotency_key: "idem-approve-when-off-001",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: openReqBeforeIneligibleId,
        action: "APPROVE",
        expected_version: 1,
        message_text: null,
      }),
    });
    assert.deepEqual(approveWhenOff, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS",
    });

    // Case B: Multi-project ON (worker active ON in >= 2 distinct projects)
    const multiCccd = "079099009911";
    await db.query(
      `update public.direct_entries
          set worker_details = jsonb_set(
                worker_details,
                '{national_id}',
                jsonb_build_object('state', 'provided', 'value', $1::text)
              ),
              version = version + 1
        where entry_id in ($2::uuid, $3::uuid)`,
      [multiCccd, workerPrj1A, workerPrj2],
    );

    const createWhenMultiProjectOn = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "1000000",
      payment_method: "CASH",
      initial_content: "Thử tạo khi NLĐ đang ON ở 2 dự án",
      idempotency_key: "idem-create-multi-prj-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: "1000000",
        payment_method: "CASH",
        initial_content: "Thử tạo khi NLĐ đang ON ở 2 dự án",
      }),
    });
    assert.deepEqual(createWhenMultiProjectOn, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON",
    });

    // Set workerPrj2 to OFF so workerPrj1A is only ON in 1 project, then test Case C: Duplicate CCCD cluster (same_project_day_count >= 2)
    await db.query(
      `insert into public.direct_entry_employment_status_events
         (entry_id, status, effective_date, leave_date, leave_reason_text, version, actor_user_id, reason_id)
       select entry_id, 'OFF', '2026-10-21'::date, '2026-10-21'::date, 'Kết thúc đợt',
              version + 1, $2::uuid, reason_id
         from public.direct_entry_employment_status_events
        where entry_id = $1::uuid
        order by version desc
        limit 1`,
      [workerPrj2, PM_2.app],
    );

    // Put draftWorkerPrj1 on the same project + same first_work_date ('2026-10-01') + same CCCD as workerPrj1A
    await db.query(
      `update public.direct_entries
          set first_work_date = '2026-10-01'::date,
              worker_details = jsonb_set(
                worker_details,
                '{national_id}',
                jsonb_build_object('state', 'provided', 'value', $1::text)
              ),
              version = version + 1
        where entry_id = $2::uuid`,
      [multiCccd, draftWorkerPrj1],
    );

    const pickerWithDupCccd = await repo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      search: "hrp-2026-800001",
      cursor: null,
      page_size: 20,
    });
    assert.equal(pickerWithDupCccd.ok, true);
    assert.equal(
      JSON.stringify(pickerWithDupCccd.data).includes(multiCccd),
      false,
      "Worker picker response must NEVER expose raw CCCD",
    );
    const pickedDupWorker = pickerWithDupCccd.data.workers.find(
      (w) => w.worker_entry_id === workerPrj1A,
    );
    assert.equal(pickedDupWorker?.has_duplicate_cccd, true);
    assert.equal(pickedDupWorker?.is_eligible, false);
    assert.ok(
      pickedDupWorker?.ineligible_reasons?.includes("WORKER_DUPLICATE_CCCD"),
    );

    const createWhenDupCccd = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "1000000",
      payment_method: "CASH",
      initial_content: "Thử tạo khi NLĐ thuộc nhóm trùng CCCD",
      idempotency_key: "idem-create-dup-cccd-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: "1000000",
        payment_method: "CASH",
        initial_content: "Thử tạo khi NLĐ thuộc nhóm trùng CCCD",
      }),
    });
    assert.deepEqual(createWhenDupCccd, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_DUPLICATE_CCCD",
    });

    // Clear duplicate CCCD on draftWorkerPrj1 so workerPrj1A is eligible again for history tests
    await db.query(
      `update public.direct_entries
          set worker_details = jsonb_set(
                worker_details,
                '{national_id}',
                jsonb_build_object('state', 'unknown')
              ),
              version = version + 1
        where entry_id = $1::uuid`,
      [draftWorkerPrj1],
    );

    // =========================================================================
    // HOTFIX VERIFICATION: Vendor-Recruited Worker Exclusion, Work Info,
    // 30-Day Advance Summary & Scoped Per-Worker Advance History
    // =========================================================================
    // 1. Vendor-recruited worker exclusion (both direct_entries.provider_type = 'vendor'
    //    and recruiter_provider_memberships with provider_type = 'vendor')
    const VENDOR_1_ID = "VND_SAL_ADV_01";
    const VENDOR_RECRUITER_1_ID = "39800000-0000-4000-8000-000000000098";
    const VENDOR_RECRUITER_2_ID = "39800000-0000-4000-8000-000000000099";
    await db.query(
      `insert into public.vendors (vendor_id, display_name, active, version)
       values ($1, 'Vendor Cung Ứng Minh Phát', true, 1)
       on conflict (vendor_id) do nothing`,
      [VENDOR_1_ID],
    );
    await db.query(
      `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
       values ($1::uuid, 'Nhân Sự Tuyển Dụng Thuộc Vendor 1', 'VND-REC-98', 'STAFF', true),
              ($2::uuid, 'Nhân Sự Tuyển Dụng Thuộc Vendor 2', 'VND-REC-99', 'STAFF', true)`,
      [VENDOR_RECRUITER_1_ID, VENDOR_RECRUITER_2_ID],
    );
    // VENDOR_RECRUITER_1_ID starts with provider_type = 'vendor' at entry creation time
    // VENDOR_RECRUITER_2_ID starts with provider_type = 'hrp' at entry creation time, then switches membership to 'vendor'
    await db.query(
      `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)
       values ($1::uuid, 'vendor', $3, '2026-01-01', true),
              ($2::uuid, 'hrp', null, '2026-01-01', true)`,
      [VENDOR_RECRUITER_1_ID, VENDOR_RECRUITER_2_ID, VENDOR_1_ID],
    );
    await db.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, '2026-01-01', true)`,
      [VENDOR_RECRUITER_2_ID, TEAM_ALPHA],
    );

    // Seed two ON workers on PRJ_1:
    // - vendorWorkerEntry1: created with VENDOR_RECRUITER_1_ID -> direct_entries.provider_type = 'vendor'
    // - vendorWorkerEntry2: created with VENDOR_RECRUITER_2_ID -> direct_entries.provider_type = 'hrp', then recruiter membership becomes 'vendor'
    const vendorBatch = await db.query(
      `select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data`,
      [
        PM_1.auth,
        PM_1.app,
        JSON.stringify([
          {
            project_id: PRJ_1,
            first_work_date: "2026-10-06",
            employee_code: "hrp-2026-800051",
            worker_details: makeWorkerDetails("Công Nhân Thuộc Vendor 1"),
            recruiter_id: VENDOR_RECRUITER_1_ID,
            labor_type: "TEMPORARY",
          },
          {
            project_id: PRJ_1,
            first_work_date: "2026-10-07",
            employee_code: "hrp-2026-800052",
            worker_details: makeWorkerDetails("Công Nhân Thuộc Vendor 2"),
            recruiter_id: VENDOR_RECRUITER_2_ID,
            labor_type: "TEMPORARY",
          },
        ]),
        "sal_adv_batch_vendor_workers",
      ],
    );
    const vendorSubId = vendorBatch.rows[0].data.submission_id;
    await db.query(
      `select public.direct_entry_transition_submission($1::uuid, $2::uuid, $3::uuid, 1, 'SUBMITTED', 'sal_adv_submit_vendor_workers')`,
      [PM_1.auth, PM_1.app, vendorSubId],
    );
    const { rows: vendorEntries } = await db.query(
      `select entry_id, employee_code, provider_type from public.direct_entries
        where submission_id = $1::uuid order by employee_code`,
      [vendorSubId],
    );
    const vendorWorkerEntry1 = vendorEntries[0].entry_id;
    const vendorWorkerEntry2 = vendorEntries[1].entry_id;
    assert.equal(vendorEntries[0].provider_type, "vendor");
    assert.equal(vendorEntries[1].provider_type, "hrp");

    // Create a historical request for vendorWorkerEntry2 while still HRP, then switch VENDOR_RECRUITER_2_ID membership to 'vendor'
    const historicalBeforeVendorRes = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: vendorWorkerEntry2,
      requested_amount_vnd: "1100000",
      payment_method: "CASH",
      initial_content: "Yêu cầu lịch sử trước khi người tuyển chuyển sang Vendor",
      idempotency_key: "idem-historical-before-vendor-001",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: vendorWorkerEntry2,
        requested_amount_vnd: "1100000",
        payment_method: "CASH",
        initial_content: "Yêu cầu lịch sử trước khi người tuyển chuyển sang Vendor",
      }),
    });
    assert.equal(historicalBeforeVendorRes.ok, true);
    const historicalVendorReqId =
      historicalBeforeVendorRes.data.request.request_id;

    // Now switch VENDOR_RECRUITER_2_ID current membership to 'vendor' (ending HRP team membership first)
    await db.query(
      `update public.recruiter_team_memberships
          set is_current = false,
              valid_to = '2026-06-01'
        where recruiter_id = $1::uuid and is_current = true`,
      [VENDOR_RECRUITER_2_ID],
    );
    await db.query(
      `update public.recruiter_provider_memberships
          set provider_type = 'vendor',
              vendor_id = $1
        where recruiter_id = $2::uuid and is_current = true`,
      [VENDOR_1_ID, VENDOR_RECRUITER_2_ID],
    );

    // Verify neither vendor-recruited worker appears in salary_advance_list_project_workers
    const pickerExcludingVendor = await repo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      search: "hrp-2026-80005",
      cursor: null,
      page_size: 20,
    });
    assert.equal(pickerExcludingVendor.ok, true);
    assert.deepEqual(
      pickerExcludingVendor.data.workers.map((w) => w.employee_code),
      [],
      "Vendor-recruited workers (both entry provider_type='vendor' and recruiter vendor membership) must be excluded from QLDA worker picker",
    );

    // Verify direct/API creation attempt for either vendor-recruited worker fails with SALARY_ADVANCE_WORKER_VENDOR_RECRUITED
    for (const [idx, vendorEntryId] of [
      [1, vendorWorkerEntry1],
      [2, vendorWorkerEntry2],
    ]) {
      const createForVendorRes = await repo.createRequest({
        auth_subject: PM_1.auth,
        app_user_id: PM_1.app,
        project_id: PRJ_1,
        worker_entry_id: vendorEntryId,
        requested_amount_vnd: "1500000",
        payment_method: "CASH",
        initial_content: `Thử tạo yêu cầu cho NLĐ Vendor ${idx}`,
        idempotency_key: `idem-create-vendor-worker-00${idx}`,
        request_fingerprint: computeCreateRequestFingerprint({
          project_id: PRJ_1,
          worker_entry_id: vendorEntryId,
          requested_amount_vnd: "1500000",
          payment_method: "CASH",
          initial_content: `Thử tạo yêu cầu cho NLĐ Vendor ${idx}`,
        }),
      });
      assert.deepEqual(createForVendorRes, {
        ok: false,
        code: "SALARY_ADVANCE_WORKER_VENDOR_RECRUITED",
      });
    }

    // Verify historical request preservation: historicalVendorReqId is NOT deleted, remains readable,
    // and surfaces WORKER_VENDOR_RECRUITED in worker_eligibility + vendor info in detail.
    const detailHistoricalVendorReq = await repo.getRequestDetail({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: historicalVendorReqId,
    });
    assert.equal(detailHistoricalVendorReq.ok, true);
    assert.equal(
      detailHistoricalVendorReq.data.request.worker_provider_type,
      "vendor",
    );
    assert.equal(
      detailHistoricalVendorReq.data.request.worker_recruiter_display_name,
      "Vendor Cung Ứng Minh Phát",
    );
    assert.equal(
      detailHistoricalVendorReq.data.request.worker_recruiter_code,
      "VND-REC-99",
    );
    assert.equal(
      detailHistoricalVendorReq.data.request.worker_eligibility?.is_eligible,
      false,
    );
    assert.ok(
      detailHistoricalVendorReq.data.request.worker_eligibility?.ineligible_reasons?.includes(
        "WORKER_VENDOR_RECRUITED",
      ),
    );

    // 2. Work information & 30-day advance summary in getRequestDetail:
    //    req1Id (on workerPrj1A, amount 2,500,000 VND) was APPROVED -> REVIEWED -> HANDLED_EXTERNALLY today.
    //    Because evidence_review_state = 'REVIEWED', wait: let's check our qualifying rule!
    //    Qualifying rule: request_state = 'APPROVED' AND evidence_review_state = 'REVIEWED'.
    //    Let's create two additional requests for workerPrj1A on PRJ_1:
    //    - histReqApprovedReviewed1 (1,800,000 VND): APPROVED + REVIEWED (within last 30 days)
    //    - histReqApprovedReviewed2 (3,200,000 VND): APPROVED + REVIEWED (45 days ago -> outside 30-day window, inside ALL / MONTH)
    //    - histReqOpen (900,000 VND): OPEN + NOT_UPLOADED (must NOT be counted in 30d summary or worker history)
    const createHistReq1 = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "1800000",
      payment_method: "CASH",
      initial_content: "Ứng lương hoàn tất trong 30 ngày gần nhất",
      idempotency_key: "idem-hist-req-1",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: "1800000",
        payment_method: "CASH",
        initial_content: "Ứng lương hoàn tất trong 30 ngày gần nhất",
      }),
    });
    assert.equal(createHistReq1.ok, true);
    const histReq1Id = createHistReq1.data.request.request_id;

    await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: histReq1Id,
      action: "APPROVE",
      expected_version: 1,
      message_text: "Duyệt đợt 1",
      idempotency_key: "idem-hist-approve-1",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: histReq1Id,
        action: "APPROVE",
        expected_version: 1,
        message_text: "Duyệt đợt 1",
      }),
    });
    const resEvHist1 = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: histReq1Id,
      expected_version: 2,
      mime_type: "image/jpeg",
      size_bytes: 1024,
      checksum_sha256: "a".repeat(64),
      caption_note: "Ảnh nhận tiền đợt 1",
      idempotency_key: "idem-hist-res-1",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: histReq1Id,
        expected_version: 2,
        mime_type: "image/jpeg",
        size_bytes: 1024,
        checksum_sha256: "a".repeat(64),
        caption_note: "Ảnh nhận tiền đợt 1",
      }),
    });
    await repo.finalizeEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: histReq1Id,
      upload_id: resEvHist1.data.upload_id,
      expected_version: 2,
      idempotency_key: "idem-hist-fin-1",
      request_fingerprint: computeFinalizeEvidenceFingerprint({
        request_id: histReq1Id,
        upload_id: resEvHist1.data.upload_id,
        expected_version: 2,
      }),
    });
    const revHist1 = await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: histReq1Id,
      expected_version: 3,
      evidence_version: 1,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: portraitV2.document_id,
      expected_worker_portrait_version: 2,
      note: "Đã đối chiếu đợt 1",
      idempotency_key: "idem-hist-rev-1",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: histReq1Id,
        expected_version: 3,
        evidence_version: 1,
        decision: "REVIEWED",
        expected_worker_portrait_document_id: portraitV2.document_id,
        expected_worker_portrait_version: 2,
        note: "Đã đối chiếu đợt 1",
      }),
    });
    assert.equal(revHist1.ok, true);

    // Create histReq2 (3,200,000 VND), approve & review it, then backdate its timestamps to 2026-08-15 (outside last 30 days)
    const createHistReq2 = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "3200000",
      payment_method: "CASH",
      initial_content: "Ứng lương tháng 08/2026",
      idempotency_key: "idem-hist-req-2",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: "3200000",
        payment_method: "CASH",
        initial_content: "Ứng lương tháng 08/2026",
      }),
    });
    assert.equal(createHistReq2.ok, true);
    const histReq2Id = createHistReq2.data.request.request_id;

    await repo.transitionRequest({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: histReq2Id,
      action: "APPROVE",
      expected_version: 1,
      message_text: "Duyệt tháng 8",
      idempotency_key: "idem-hist-approve-2",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: histReq2Id,
        action: "APPROVE",
        expected_version: 1,
        message_text: "Duyệt tháng 8",
      }),
    });
    const resEvHist2 = await repo.reserveEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: histReq2Id,
      expected_version: 2,
      mime_type: "image/jpeg",
      size_bytes: 1024,
      checksum_sha256: "a".repeat(64),
      caption_note: "Ảnh nhận tiền tháng 8",
      idempotency_key: "idem-hist-res-2",
      request_fingerprint: computeReserveEvidenceFingerprint({
        request_id: histReq2Id,
        expected_version: 2,
        mime_type: "image/jpeg",
        size_bytes: 1024,
        checksum_sha256: "a".repeat(64),
        caption_note: "Ảnh nhận tiền tháng 8",
      }),
    });
    await repo.finalizeEvidence({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: histReq2Id,
      upload_id: resEvHist2.data.upload_id,
      expected_version: 2,
      idempotency_key: "idem-hist-fin-2",
      request_fingerprint: computeFinalizeEvidenceFingerprint({
        request_id: histReq2Id,
        upload_id: resEvHist2.data.upload_id,
        expected_version: 2,
      }),
    });
    await repo.reviewEvidence({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: histReq2Id,
      expected_version: 3,
      evidence_version: 1,
      decision: "REVIEWED",
      expected_worker_portrait_document_id: portraitV2.document_id,
      expected_worker_portrait_version: 2,
      note: "Đã đối chiếu tháng 8",
      idempotency_key: "idem-hist-rev-2",
      request_fingerprint: computeReviewEvidenceFingerprint({
        request_id: histReq2Id,
        expected_version: 3,
        evidence_version: 1,
        decision: "REVIEWED",
        expected_worker_portrait_document_id: portraitV2.document_id,
        expected_worker_portrait_version: 2,
        note: "Đã đối chiếu tháng 8",
      }),
    });

    // Backdate histReq2 to 2026-08-15 in salary_advance_requests
    await db.exec("begin;");
    await db.exec(
      "select pg_catalog.set_config('salary_advance.write_marker', 'on', true);",
    );
    await db.query(
      `update public.salary_advance_requests
          set created_at = '2026-08-15T03:00:00Z'::timestamptz,
              decided_at = '2026-08-15T04:00:00Z'::timestamptz,
              current_evidence_uploaded_at = '2026-08-15T05:00:00Z'::timestamptz,
              evidence_reviewed_at = '2026-08-15T06:00:00Z'::timestamptz,
              last_activity_at = '2026-08-15T06:00:00Z'::timestamptz,
              updated_at = '2026-08-15T06:00:00Z'::timestamptz
        where request_id = $1::uuid`,
      [histReq2Id],
    );
    await db.exec("commit;");

    // Also create an OPEN request for workerPrj1A (900,000 VND) -> must NOT be counted in 30d summary or history
    const createHistOpen = await repo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      requested_amount_vnd: "900000",
      payment_method: "CASH",
      initial_content: "Ứng lương đang chờ duyệt",
      idempotency_key: "idem-hist-open-1",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerPrj1A,
        requested_amount_vnd: "900000",
        payment_method: "CASH",
        initial_content: "Ứng lương đang chờ duyệt",
      }),
    });
    assert.equal(createHistOpen.ok, true);
    const histOpenReqId = createHistOpen.data.request.request_id;

    // Verify getRequestDetail as ACCT_B (assigned Project Accountant for PRJ_1):
    // - includes worker_first_work_date ('2026-10-01'), worker_recruiter_display_name (PM_1.name), worker_recruiter_code (PM_1.code), worker_provider_type ('hrp')
    // - includes worker_advance_30d_summary with total_count = 1 and total_amount_vnd = '1800000'
    //   (counts histReq1 [APPROVED + REVIEWED within 30d]; excludes histReq2 [2026-08-15], histOpenReq [OPEN], and req1Id [HANDLED_EXTERNALLY])
    // - never leaks multiCccd
    const acctDetailWith30d = await repo.getRequestDetail({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: histOpenReqId,
    });
    assert.equal(acctDetailWith30d.ok, true);
    assert.equal(
      JSON.stringify(acctDetailWith30d.data).includes(multiCccd),
      false,
      "Request detail must NEVER leak worker CCCD",
    );
    assert.equal(
      acctDetailWith30d.data.request.worker_first_work_date,
      "2026-10-01",
    );
    assert.equal(
      acctDetailWith30d.data.request.worker_recruiter_display_name,
      PM_1.name,
    );
    assert.equal(
      acctDetailWith30d.data.request.worker_recruiter_code,
      PM_1.code,
    );
    assert.equal(acctDetailWith30d.data.request.worker_provider_type, "hrp");
    assert.ok(acctDetailWith30d.data.worker_advance_30d_summary);
    assert.equal(
      acctDetailWith30d.data.worker_advance_30d_summary.window_days,
      30,
    );
    assert.equal(
      acctDetailWith30d.data.worker_advance_30d_summary.qualifying_rule,
      "APPROVED_AND_EVIDENCE_REVIEWED",
    );
    assert.equal(
      acctDetailWith30d.data.worker_advance_30d_summary.total_count,
      1,
    );
    assert.equal(
      acctDetailWith30d.data.worker_advance_30d_summary.total_amount_vnd,
      "1800000",
    );

    // Verify getRequestDetail as PM_1 (creator QLDA on PRJ_1) receives worker_advance_30d_summary scoped to PM_1's managed projects
    const pmDetailWith30d = await repo.getRequestDetail({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: histOpenReqId,
    });
    assert.equal(pmDetailWith30d.ok, true);
    assert.ok(pmDetailWith30d.data.worker_advance_30d_summary);
    assert.equal(
      pmDetailWith30d.data.worker_advance_30d_summary.total_count,
      1,
    );
    assert.equal(
      pmDetailWith30d.data.worker_advance_30d_summary.total_amount_vnd,
      "1800000",
    );

    // 3. Per-worker advance history (listWorkerHistory & listProjectWorkerHistory) across filters, pagination, and authorization scopes:
    //    - PM_1 (creator QLDA on PRJ_1) can view worker history for their own request
    const pm1HistOk = await repo.listWorkerHistory({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: histOpenReqId,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.equal(pm1HistOk.ok, true);
    assert.equal(pm1HistOk.data.total_count, 2);
    assert.equal(pm1HistOk.data.total_amount_vnd, "5000000");

    //    - PM_1B (another QLDA on PRJ_1 who did NOT create histOpenReqId) and PM_2 (QLDA on PRJ_2) are denied listWorkerHistory on histOpenReqId
    for (const otherPm of [PM_1B, PM_2]) {
      const otherPmHistDenied = await repo.listWorkerHistory({
        auth_subject: otherPm.auth,
        app_user_id: otherPm.app,
        request_id: histOpenReqId,
        period_mode: "ALL",
        month: null,
        from_date: null,
        to_date: null,
        cursor: null,
        page_size: 20,
      });
      assert.deepEqual(otherPmHistDenied, {
        ok: false,
        code: "SALARY_ADVANCE_ACCESS_DENIED",
      });
    }

    //    - ACCT_A (not assigned to PRJ_1 anymore) is denied with SALARY_ADVANCE_ACCESS_DENIED
    const acctAHistDenied = await repo.listWorkerHistory({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      request_id: histOpenReqId,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.deepEqual(acctAHistDenied, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    //    - ACCT_B (assigned to PRJ_1) queries ALL -> returns both histReq1 (1,800,000) and histReq2 (3,200,000) = 2 items, 5,000,000 VND
    const acctBHistAllPage1 = await repo.listWorkerHistory({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: histOpenReqId,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 1,
    });
    assert.equal(acctBHistAllPage1.ok, true);
    assert.equal(acctBHistAllPage1.data.total_count, 2);
    assert.equal(acctBHistAllPage1.data.total_amount_vnd, "5000000");
    assert.equal(acctBHistAllPage1.data.items.length, 1);
    assert.equal(acctBHistAllPage1.data.has_more, true);
    assert.equal(acctBHistAllPage1.data.items[0].request_id, histReq1Id);

    // Page 2 with cursor preserves exact total_count (2) and total_amount_vnd ('5000000')
    const acctBHistAllPage2 = await repo.listWorkerHistory({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: histOpenReqId,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: acctBHistAllPage1.data.next_cursor,
      page_size: 1,
    });
    assert.equal(acctBHistAllPage2.ok, true);
    assert.equal(acctBHistAllPage2.data.total_count, 2);
    assert.equal(acctBHistAllPage2.data.total_amount_vnd, "5000000");
    assert.equal(acctBHistAllPage2.data.items.length, 1);
    assert.equal(acctBHistAllPage2.data.has_more, false);
    assert.equal(acctBHistAllPage2.data.items[0].request_id, histReq2Id);

    //    - ACCT_B queries MONTH = '2026-08' -> returns only histReq2 (1 item, 3,200,000 VND)
    const acctBHistMonthAug = await repo.listWorkerHistory({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: histOpenReqId,
      period_mode: "MONTH",
      month: "2026-08",
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.equal(acctBHistMonthAug.ok, true);
    assert.equal(acctBHistMonthAug.data.total_count, 1);
    assert.equal(acctBHistMonthAug.data.total_amount_vnd, "3200000");
    assert.equal(acctBHistMonthAug.data.items[0].request_id, histReq2Id);

    //    - ACCT_B queries CUSTOM_RANGE = '2026-08-01'..'2026-08-31' -> returns only histReq2
    const acctBHistCustomAug = await repo.listWorkerHistory({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: histOpenReqId,
      period_mode: "CUSTOM_RANGE",
      month: null,
      from_date: "2026-08-01",
      to_date: "2026-08-31",
      cursor: null,
      page_size: 20,
    });
    assert.equal(acctBHistCustomAug.ok, true);
    assert.equal(acctBHistCustomAug.data.total_count, 1);
    assert.equal(acctBHistCustomAug.data.total_amount_vnd, "3200000");

    //    - Supervisory Viewer (CANONICAL_BOD) can also view worker history
    const bodHistAll = await repo.listWorkerHistory({
      auth_subject: CANONICAL_BOD.auth,
      app_user_id: CANONICAL_BOD.app,
      request_id: histOpenReqId,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.equal(bodHistAll.ok, true);
    assert.equal(bodHistAll.data.total_count, 2);
    assert.equal(bodHistAll.data.total_amount_vnd, "5000000");

    // 4. Cross-episode same-CCCD matching (distinct worker_entry_id & candidate_id) + strict project scope:
    //    - Set workerPrj1B (on PRJ_1, first_work_date '2026-10-02' != '2026-10-01') to have the same canonical CCCD (multiCccd)
    //      so its existing bankReqId (4,500,000 VND on PRJ_1, already APPROVED + REVIEWED) matches the same worker by CCCD!
    //    - End ACCT_B's assignment on PRJ_2 so ACCT_B is scoped strictly to PRJ_1, then insert a completed
    //      APPROVED + REVIEWED advance (1,500,000 VND) on workerPrj2 (PRJ_2, which already has multiCccd, out of ACCT_B's scope).
    await db.query(
      `update public.direct_entries
          set worker_details = jsonb_set(
                worker_details,
                '{national_id}',
                jsonb_build_object('state', 'provided', 'value', $1::text)
              ),
              version = version + 1
        where entry_id = $2::uuid`,
      [multiCccd, workerPrj1B],
    );
    const { rows: acctBPrj2Rows } = await db.query(
      `select assignment_id, version
         from public.vendor_finance_project_accountants
        where project_id = $1 and accountant_user_id = $2::uuid and valid_to is null`,
      [PRJ_2, ACCT_B.app],
    );
    const endAcctBPrj2Reason = "Kết thúc phân công ACCT_B trên PRJ_2 để kiểm thử cô lập scope";
    await db.query(
      `select public.vendor_finance_end_project_accountant_admin(
         $1::uuid, $2::uuid, $3::uuid, $4::integer, null::date, $5::text, $6::uuid, $7::text
       )`,
      [
        FULL_ADMIN.auth,
        FULL_ADMIN.app,
        acctBPrj2Rows[0].assignment_id,
        acctBPrj2Rows[0].version,
        endAcctBPrj2Reason,
        nextUuid(),
        computeEndProjectAccountantFingerprint({
          assignment_id: acctBPrj2Rows[0].assignment_id,
          expected_version: acctBPrj2Rows[0].version,
          valid_to: null,
          reason: endAcctBPrj2Reason,
        }),
      ],
    );
    await db.exec("begin;");
    await db.exec(
      "select pg_catalog.set_config('salary_advance.write_marker', 'on', true);",
    );
    await db.query(
      `insert into public.salary_advance_requests (
         request_id, project_id, worker_entry_id, requested_amount_vnd, payment_method,
         initial_content, request_state, evidence_review_state, version,
         created_by_user_id, decided_by_user_id, decided_at,
         current_evidence_version, current_evidence_event_id, current_evidence_storage_key, current_evidence_mime_type,
         current_evidence_size_bytes, current_evidence_checksum_sha256,
         current_evidence_uploaded_by_user_id, current_evidence_uploaded_at,
         evidence_reviewed_by_user_id, evidence_reviewed_at,
         reviewed_worker_portrait_document_id, reviewed_worker_portrait_version,
         last_actor_user_id, last_activity_at, created_at, updated_at
       )
       select '88800000-0000-4000-8000-000000000999'::uuid,
              $1,
              $2::uuid,
              1500000,
              payment_method,
              'Ứng lương đợt trước ở dự án PRJ_2 cùng CCCD',
              request_state,
              evidence_review_state,
              version,
              $3::uuid,
              $4::uuid,
              decided_at,
              current_evidence_version,
              current_evidence_event_id,
              replace(current_evidence_storage_key, request_id::text, '88800000-0000-4000-8000-000000000999'),
              current_evidence_mime_type,
              current_evidence_size_bytes,
              current_evidence_checksum_sha256,
              $3::uuid,
              current_evidence_uploaded_at,
              $4::uuid,
              evidence_reviewed_at,
              reviewed_worker_portrait_document_id,
              reviewed_worker_portrait_version,
              $4::uuid,
              last_activity_at,
              created_at,
              updated_at
         from public.salary_advance_requests
        where request_id = $5::uuid`,
      [PRJ_2, workerPrj2, PM_2.app, ACCT_A.app, histReq1Id],
    );
    await db.exec("commit;");

    // ACCT_B (assigned to PRJ_1 only) now sees:
    // - 30d summary: histReq1 (1,800,000 on workerPrj1A) + bankReqId (4,500,000 on workerPrj1B via same CCCD) = 2 items, 6,300,000 VND
    // - ALL history: histReq1 + histReq2 + bankReqId = 3 items, 9,500,000 VND (excludes PRJ_2's 1,500,000 VND!)
    const acctBDetailSameCccd = await repo.getRequestDetail({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: histOpenReqId,
    });
    assert.equal(acctBDetailSameCccd.ok, true);
    assert.equal(
      acctBDetailSameCccd.data.worker_advance_30d_summary?.total_count,
      2,
    );
    assert.equal(
      acctBDetailSameCccd.data.worker_advance_30d_summary?.total_amount_vnd,
      "6300000",
    );

    const acctBHistSameCccdAll = await repo.listWorkerHistory({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      request_id: histOpenReqId,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.equal(acctBHistSameCccdAll.ok, true);
    assert.equal(acctBHistSameCccdAll.data.total_count, 3);
    assert.equal(acctBHistSameCccdAll.data.total_amount_vnd, "9500000");
    assert.equal(
      acctBHistSameCccdAll.data.items.some((item) => item.project_id === PRJ_2),
      false,
      "Accountant must NEVER see worker history from projects outside their assigned scope",
    );

    // CANONICAL_BOD (supervisory viewer across all projects) sees all 4 items across PRJ_1 and PRJ_2 = 11,000,000 VND
    const bodHistSameCccdAll = await repo.listWorkerHistory({
      auth_subject: CANONICAL_BOD.auth,
      app_user_id: CANONICAL_BOD.app,
      request_id: histOpenReqId,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.equal(bodHistSameCccdAll.ok, true);
    assert.equal(bodHistSameCccdAll.data.total_count, 4);
    assert.equal(bodHistSameCccdAll.data.total_amount_vnd, "11000000");

    // 5. QLDA pre-create worker picker (`listProjectWorkers`) & pre-create worker history (`listProjectWorkerHistory`)
    //    with multi-project QLDA scope isolation:
    //    - Seed a worker on PRJ_NO_ACCT (which PM_1 ALSO manages, while PM_1B and ACCT_B do NOT manage PRJ_NO_ACCT)
    //      with the same canonical CCCD (multiCccd) and a completed APPROVED + REVIEWED advance of 700,000 VND.
    const prjNoAcctBatch = await db.query(
      `select public.direct_entry_create_batch($1::uuid, $2::uuid, $3::jsonb, $4::text) as data`,
      [
        PM_1.auth,
        PM_1.app,
        JSON.stringify([
          {
            project_id: PRJ_NO_ACCT,
            first_work_date: "2026-09-10",
            employee_code: "hrp-2026-800955",
            worker_details: makeWorkerDetails(
              "Nguyễn Công Nhân Bắc 1 (Đợt Dự Án Phụ)",
            ),
            recruiter_id: PM_1.recruiter,
            labor_type: "TEMPORARY",
          },
        ]),
        "sal_adv_batch_prj_no_acct_worker",
      ],
    );
    const prjNoAcctSubId = prjNoAcctBatch.rows[0].data.submission_id;
    await db.query(
      `select public.direct_entry_transition_submission($1::uuid, $2::uuid, $3::uuid, 1, 'SUBMITTED', 'sal_adv_submit_prj_no_acct_worker')`,
      [PM_1.auth, PM_1.app, prjNoAcctSubId],
    );
    const { rows: prjNoAcctEntries } = await db.query(
      `select entry_id from public.direct_entries where submission_id = $1::uuid`,
      [prjNoAcctSubId],
    );
    const workerPrjNoAcct = prjNoAcctEntries[0].entry_id;
    await db.query(
      `update public.direct_entries
          set worker_details = jsonb_set(
                worker_details,
                '{national_id}',
                jsonb_build_object('state', 'provided', 'value', $1::text)
              ),
              version = version + 1
        where entry_id = $2::uuid`,
      [multiCccd, workerPrjNoAcct],
    );
    // Set workerPrjNoAcct to OFF so workerPrj1A remains ON in only 1 project
    await db.query(
      `insert into public.direct_entry_employment_status_events
         (entry_id, status, effective_date, leave_date, leave_reason_text, version, actor_user_id, reason_id)
       select entry_id, 'OFF', '2026-09-25'::date, '2026-09-25'::date, 'Kết thúc đợt dự án phụ',
              version + 1, $2::uuid, reason_id
         from public.direct_entry_employment_status_events
        where entry_id = $1::uuid
        order by version desc
        limit 1`,
      [workerPrjNoAcct, PM_1.app],
    );

    await db.exec("begin;");
    await db.exec(
      "select pg_catalog.set_config('salary_advance.write_marker', 'on', true);",
    );
    await db.query(
      `insert into public.salary_advance_requests (
         request_id, project_id, worker_entry_id, requested_amount_vnd, payment_method,
         initial_content, request_state, evidence_review_state, version,
         created_by_user_id, decided_by_user_id, decided_at,
         current_evidence_version, current_evidence_event_id, current_evidence_storage_key, current_evidence_mime_type,
         current_evidence_size_bytes, current_evidence_checksum_sha256,
         current_evidence_uploaded_by_user_id, current_evidence_uploaded_at,
         evidence_reviewed_by_user_id, evidence_reviewed_at,
         reviewed_worker_portrait_document_id, reviewed_worker_portrait_version,
         last_actor_user_id, last_activity_at, created_at, updated_at
       )
       select '88800000-0000-4000-8000-000000000888'::uuid,
              $1,
              $2::uuid,
              700000,
              payment_method,
              'Ứng lương ở dự án thứ 2 do PM_1 quản lý (cùng CCCD)',
              request_state,
              evidence_review_state,
              version,
              $3::uuid,
              $4::uuid,
              decided_at,
              current_evidence_version,
              current_evidence_event_id,
              replace(current_evidence_storage_key, request_id::text, '88800000-0000-4000-8000-000000000888'),
              current_evidence_mime_type,
              current_evidence_size_bytes,
              current_evidence_checksum_sha256,
              $3::uuid,
              current_evidence_uploaded_at,
              $4::uuid,
              evidence_reviewed_at,
              reviewed_worker_portrait_document_id,
              reviewed_worker_portrait_version,
              $4::uuid,
              last_activity_at,
              created_at,
              updated_at
         from public.salary_advance_requests
        where request_id = $5::uuid`,
      [PRJ_NO_ACCT, workerPrjNoAcct, PM_1.app, ACCT_A.app, histReq1Id],
    );
    await db.exec("commit;");

    // 5a. PM_1 (manages PRJ_1 and PRJ_NO_ACCT, does NOT manage PRJ_2):
    //     - In listProjectWorkers(PRJ_1), workerPrj1A's advance_30d_summary includes PRJ_1 (1,800,000 + 4,500,000) + PRJ_NO_ACCT (700,000) = 3 items, 7,000,000 VND (and excludes PRJ_2's 1,500,000 VND!)
    const pm1WorkersWith30d = await repo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      search: "hrp-2026-800001",
      cursor: null,
      page_size: 20,
    });
    assert.equal(pm1WorkersWith30d.ok, true);
    assert.equal(
      JSON.stringify(pm1WorkersWith30d.data).includes(multiCccd),
      false,
      "listProjectWorkers must NEVER leak raw CCCD",
    );
    const pm1PickedWorkerA = pm1WorkersWith30d.data.workers.find(
      (w) => w.worker_entry_id === workerPrj1A,
    );
    assert.ok(pm1PickedWorkerA);
    assert.equal(pm1PickedWorkerA.first_work_date, "2026-10-01");
    assert.equal(pm1PickedWorkerA.recruiter_display_name, PM_1.name);
    assert.equal(pm1PickedWorkerA.recruiter_code, PM_1.code);
    assert.equal(pm1PickedWorkerA.provider_type, "hrp");
    assert.equal(pm1PickedWorkerA.advance_30d_summary?.total_count, 3);
    assert.equal(
      pm1PickedWorkerA.advance_30d_summary?.total_amount_vnd,
      "7000000",
    );

    //     - In getRequestDetail(histOpenReqId), PM_1 also sees total_count = 3, total_amount_vnd = '7000000'
    const pm1DetailMultiManaged = await repo.getRequestDetail({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      request_id: histOpenReqId,
    });
    assert.equal(pm1DetailMultiManaged.ok, true);
    assert.equal(
      pm1DetailMultiManaged.data.worker_advance_30d_summary?.total_count,
      3,
    );
    assert.equal(
      pm1DetailMultiManaged.data.worker_advance_30d_summary?.total_amount_vnd,
      "7000000",
    );

    //     - In listProjectWorkerHistory(PRJ_1, workerPrj1A, ALL), PM_1 sees 4 items (histReq1 + histReq2 + bankReqId on PRJ_1, plus 700k on PRJ_NO_ACCT) = 10,200,000 VND, and NEVER sees PRJ_2!
    const pm1ProjectWorkerHistAll = await repo.listProjectWorkerHistory({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.equal(pm1ProjectWorkerHistAll.ok, true);
    assert.equal(pm1ProjectWorkerHistAll.data.request_id, null);
    assert.equal(pm1ProjectWorkerHistAll.data.worker_entry_id, workerPrj1A);
    assert.equal(pm1ProjectWorkerHistAll.data.total_count, 4);
    assert.equal(pm1ProjectWorkerHistAll.data.total_amount_vnd, "10200000");
    assert.equal(
      pm1ProjectWorkerHistAll.data.items.some((item) => item.project_id === PRJ_2),
      false,
      "QLDA must NEVER see worker history from projects they do not manage",
    );
    assert.equal(
      JSON.stringify(pm1ProjectWorkerHistAll.data).includes(multiCccd),
      false,
      "listProjectWorkerHistory must NEVER leak raw CCCD",
    );

    //     - In listProjectWorkerHistory(PRJ_1, workerPrj1A, LAST_30_DAYS), PM_1 sees 3 items = 7,000,000 VND
    const pm1ProjectWorkerHist30d = await repo.listProjectWorkerHistory({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      period_mode: "LAST_30_DAYS",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.equal(pm1ProjectWorkerHist30d.ok, true);
    assert.equal(pm1ProjectWorkerHist30d.data.total_count, 3);
    assert.equal(pm1ProjectWorkerHist30d.data.total_amount_vnd, "7000000");

    // 5b. PM_1B (manages ONLY PRJ_1, not PRJ_NO_ACCT and not PRJ_2):
    //     - In listProjectWorkers(PRJ_1), PM_1B sees only PRJ_1's 2 items in 30d = 6,300,000 VND
    const pm1bWorkersWith30d = await repo.listProjectWorkers({
      auth_subject: PM_1B.auth,
      app_user_id: PM_1B.app,
      project_id: PRJ_1,
      search: "hrp-2026-800001",
      cursor: null,
      page_size: 20,
    });
    assert.equal(pm1bWorkersWith30d.ok, true);
    const pm1bPickedWorkerA = pm1bWorkersWith30d.data.workers.find(
      (w) => w.worker_entry_id === workerPrj1A,
    );
    assert.equal(pm1bPickedWorkerA?.advance_30d_summary?.total_count, 2);
    assert.equal(
      pm1bPickedWorkerA?.advance_30d_summary?.total_amount_vnd,
      "6300000",
    );

    //     - In listProjectWorkerHistory(PRJ_1, workerPrj1A, ALL), PM_1B sees only PRJ_1's 3 items = 9,500,000 VND (excludes both PRJ_NO_ACCT and PRJ_2!)
    const pm1bProjectWorkerHistAll = await repo.listProjectWorkerHistory({
      auth_subject: PM_1B.auth,
      app_user_id: PM_1B.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.equal(pm1bProjectWorkerHistAll.ok, true);
    assert.equal(pm1bProjectWorkerHistAll.data.total_count, 3);
    assert.equal(pm1bProjectWorkerHistAll.data.total_amount_vnd, "9500000");
    assert.equal(
      pm1bProjectWorkerHistAll.data.items.every((item) => item.project_id === PRJ_1),
      true,
    );

    // 5c. Out-of-scope QLDA (`PM_2` on `PRJ_1`), cross-project worker mismatch, and vendor-recruited worker rejection:
    const pm2OutOfScopeProjectHist = await repo.listProjectWorkerHistory({
      auth_subject: PM_2.auth,
      app_user_id: PM_2.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj1A,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.deepEqual(pm2OutOfScopeProjectHist, {
      ok: false,
      code: "SALARY_ADVANCE_ACCESS_DENIED",
    });

    const crossProjectMismatchHist = await repo.listProjectWorkerHistory({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: workerPrj2,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.deepEqual(crossProjectMismatchHist, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_PROJECT_MISMATCH",
    });

    const vendorWorkerProjectHist = await repo.listProjectWorkerHistory({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      worker_entry_id: vendorWorkerEntry1,
      period_mode: "ALL",
      month: null,
      from_date: null,
      to_date: null,
      cursor: null,
      page_size: 20,
    });
    assert.deepEqual(vendorWorkerProjectHist, {
      ok: false,
      code: "SALARY_ADVANCE_WORKER_VENDOR_RECRUITED",
    });

    // =========================================================================
    // HOTFIX VERIFICATION: Non-Throwing `salary_advance_get_actor_access` Probe
    //   - Returns `{ can_access: false, ... }` WITHOUT raising `42501` for
    //     non-authorized actors (`VFIN_ONLY_ACTOR`, `VFIN_CASH_HOLDER_ACTOR`),
    //     while `salary_advance_get_actor_context` still raises `42501`!
    //   - Returns `{ can_access: true, ... }` for authorized PM, Project
    //     Accountant, Full Admin, and Canonical BoD actors.
    // =========================================================================
    for (const deniedActor of [VFIN_ONLY_ACTOR, VFIN_CASH_HOLDER_ACTOR]) {
      const accessProbe = await repo.getActorAccess({
        auth_subject: deniedActor.auth,
        app_user_id: deniedActor.app,
      });
      assert.deepEqual(
        accessProbe,
        {
          ok: true,
          data: {
            can_access: false,
            is_project_manager: false,
            is_project_accountant: false,
            is_supervisory_viewer: false,
          },
        },
        "salary_advance_get_actor_access must return can_access=false without throwing 42501",
      );

      const deniedContext = await repo.getActorContext({
        auth_subject: deniedActor.auth,
        app_user_id: deniedActor.app,
      });
      assert.deepEqual(
        deniedContext,
        {
          ok: false,
          code: "SALARY_ADVANCE_ACCESS_DENIED",
        },
        "salary_advance_get_actor_context must preserve 42501 SALARY_ADVANCE_ACCESS_DENIED",
      );
    }

    const pm1Access = await repo.getActorAccess({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
    });
    assert.deepEqual(pm1Access, {
      ok: true,
      data: {
        can_access: true,
        is_project_manager: true,
        is_project_accountant: false,
        is_supervisory_viewer: false,
      },
    });

    const acctBAccess = await repo.getActorAccess({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
    });
    assert.deepEqual(acctBAccess, {
      ok: true,
      data: {
        can_access: true,
        is_project_manager: false,
        is_project_accountant: true,
        is_supervisory_viewer: false,
      },
    });

    const bodAccess = await repo.getActorAccess({
      auth_subject: CANONICAL_BOD.auth,
      app_user_id: CANONICAL_BOD.app,
    });
    assert.deepEqual(bodAccess, {
      ok: true,
      data: {
        can_access: true,
        is_project_manager: false,
        is_project_accountant: false,
        is_supervisory_viewer: true,
      },
    });

    // Append-only trigger on salary_advance_events blocks UPDATE and DELETE even with write_marker
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(
            "select pg_catalog.set_config('salary_advance.write_marker', 'on', true);",
          );
          await db.exec(
            "update public.salary_advance_events set message_text = 'tampered';",
          );
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      /SALARY_ADVANCE_APPEND_ONLY_VIOLATION/,
    );

    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(
            "select pg_catalog.set_config('salary_advance.write_marker', 'on', true);",
          );
          await db.exec("delete from public.salary_advance_events;");
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      /SALARY_ADVANCE_APPEND_ONLY_VIOLATION/,
    );
  } finally {
    await db.close();
  }
});
