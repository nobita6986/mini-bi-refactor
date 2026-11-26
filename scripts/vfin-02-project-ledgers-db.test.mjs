/**
 * VFIN-02 — Project-Scoped Vendor Finance Sub-Ledgers, Implicit Vendor–Project Eligibility,
 * Accountant Handover Isolation, Narrow Global Reconciler & Monthly Debt Report DB Suite.
 *
 * Applies the full repository migration stack on ephemeral PGlite (including pre-existing
 * VFIN-01 legacy rows migrated forward) and exercises both PostgreSQL RPCs and the
 * fail-closed TypeScript `createVendorFinanceRepository` projections end-to-end:
 *   1. Atomic migration rollback on failure + LF/CRLF-deterministic SHA-256 checksum.
 *   2. Zero schema/constraint/trigger/data drift on untouched recruitment, Direct Entry,
 *      Team Leader, Project-Team scope, Organization Department, and Work Reports tables.
 *   3. Safe preservation of pre-existing VFIN-01 rows in `LEGACY_UNALLOCATED` without
 *      guessed allocation, mutation, or double counting; hidden from project-scoped
 *      accountants and isolated for global viewers.
 *   4. Controlled governance by Canonical Full Admin (`1 project = 1 active accountant`,
 *      project accountant assignments and global role designations) and
 *      fail-closed rejection of non-admin actors.
 *   5. Any active Vendor may be used on an active Project with an active accountant,
 *      without creating manual Vendor–Project links.
 *   6. Hierarchy `Company -> Responsible Accountant -> Project -> Vendor` & ZERO cross-netting:
 *      same Vendor across 2 Projects & 2 Accountants (including opposite `+10M` payable vs
 *      `-4M` advance) never nets into `+6M`.
 *   7. 4-Role authorization matrix + Cash-Holder record-on-behalf ownership invariant
 *      (`responsible_accountant_user_id` stays on the project's active accountant while
 *      `created_by_user_id` records the actor) + narrow BoD `GLOBAL_RECONCILER` without
 *      `can_record`.
 *   8. Project accountant handover (`A -> B` on `PRJ_1`): `A`'s historical `(V, PRJ_1, A)`
 *      book stays owned by `A` (read-only to `A`, zero leakage of `B`'s `(V, PRJ_1, B)` book).
 *   9. Monthly Project Debt Report (`MISSING_CANONICAL_SOURCE` revenue honesty, non-netted
 *      component totals, `month=YYYY-MM` drill-down, and `LEGACY_UNALLOCATED` isolation).
 *  10. Forced RLS, zero direct table grants across all 10 `vendor_finance_*` tables, and
 *      `service_role`-only EXECUTE ACL matching the post-hotfix RPC signatures.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { computeAssignAccountingMemberFingerprint } from "../src/lib/departments/department-contract.ts";
import {
  computeApplyOpeningBatchFingerprint,
  computeAssignGlobalRoleFingerprint,
  computeAssignProjectAccountantFingerprint,
  computeClassifySubLedgerFingerprint,
  computeCreateReconciliationFingerprint,
  computeEndGlobalRoleFingerprint,
  computeEndProjectAccountantFingerprint,
  computeRecordEntryFingerprint,
  computeReserveEvidenceFingerprint,
  computeReverseEntryFingerprint,
} from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import { createVendorFinanceRepository } from "../src/lib/vendor-finance/vendor-finance-repository.ts";
import { parseMonthlyReportEnvelope } from "../src/lib/vendor-finance/ui-model.ts";
import {
  VFIN_02_PROJECT_LEDGERS_MIGRATION_NAME,
  VFIN_03_CONTRACT_TYPE_LEDGERS_MIGRATION_NAME,
  VFIN_03_CONTRACT_TYPE_LEDGERS_RPC_SIGNATURES,
  migrationChecksum,
  migrationSqlForTransaction,
} from "./lib/migration-validation.mjs";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const TEAM_ALPHA = "99500000-0000-4000-8000-00000000000a";
const PRJ_1 = "vfin_02_prj_north";
const PRJ_2 = "vfin_02_prj_south";

const FULL_ADMIN = {
  auth: "19500000-0000-4000-8000-000000000001",
  app: "29500000-0000-4000-8000-000000000001",
  name: "Quản Trị Toàn Quyền VFIN-02",
};
const ACCT_A = {
  auth: "19500000-0000-4000-8000-000000000002",
  app: "29500000-0000-4000-8000-000000000002",
  recruiter: "39500000-0000-4000-8000-000000000002",
  name: "Kế Toán Dự Án A",
  code: "KT-201",
};
const ACCT_B = {
  auth: "19500000-0000-4000-8000-000000000003",
  app: "29500000-0000-4000-8000-000000000003",
  recruiter: "39500000-0000-4000-8000-000000000003",
  name: "Kế Toán Dự Án B",
  code: "KT-202",
};
const CASH_HOLDER_VIEW = {
  auth: "19500000-0000-4000-8000-000000000004",
  app: "29500000-0000-4000-8000-000000000004",
  name: "Kế Toán Cầm Tiền Theo Dõi",
};
const CASH_HOLDER_BEHALF = {
  auth: "19500000-0000-4000-8000-000000000005",
  app: "29500000-0000-4000-8000-000000000005",
  name: "Kế Toán Cầm Tiền Nhập Hộ",
};
const BOD_RECONCILER = {
  auth: "19500000-0000-4000-8000-000000000006",
  app: "29500000-0000-4000-8000-000000000006",
  name: "Ban Giám Đốc Đối Soát",
};
const BOD_VIEWER = {
  auth: "19500000-0000-4000-8000-000000000007",
  app: "29500000-0000-4000-8000-000000000007",
  name: "Ban Giám Đốc Chỉ Xem",
};
const TEAM_LEADER = {
  auth: "19500000-0000-4000-8000-000000000008",
  app: "29500000-0000-4000-8000-000000000008",
  recruiter: "39500000-0000-4000-8000-000000000008",
  name: "Trưởng Nhóm Tuyển Dụng",
  code: "TL-208",
};
const STAFF_MEMBER = {
  auth: "19500000-0000-4000-8000-000000000009",
  app: "29500000-0000-4000-8000-000000000009",
  recruiter: "39500000-0000-4000-8000-000000000009",
  name: "Nhân Viên Tuyển Dụng",
  code: "NV-209",
};

let uuidSeq = 0;
function nextUuid() {
  uuidSeq += 1;
  return `79500000-0000-4000-8000-${String(uuidSeq).padStart(12, "0")}`;
}

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR))
    .filter((n) => n.endsWith(".sql") && n <= VFIN_03_CONTRACT_TYPE_LEDGERS_MIGRATION_NAME)
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function createPreVfin02Database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const migrations = await loadMigrations();
  const targetIdx = migrations.findIndex((m) => m.name === VFIN_02_PROJECT_LEDGERS_MIGRATION_NAME);
  assert.ok(targetIdx >= 0, "VFIN-02 migration must exist in supabase/migrations");
  for (const m of migrations.slice(0, targetIdx)) {
    await db.exec(m.sql);
  }
  return { db, targetMigration: migrations[targetIdx], restMigrations: migrations.slice(targetIdx + 1) };
}

const UNTOUCHED_TABLES = [
  "teams",
  "recruiter_team_memberships",
  "direct_entry_team_leader_assignments",
  "direct_entry_project_team_scopes",
  "direct_entry_scope_grants",
  "organization_departments",
  "organization_department_memberships",
];

async function captureUntouchedSnapshot(db) {
  const { rows: columns } = await db.query(
    `select table_name, ordinal_position::int as pos, column_name, data_type, udt_name, is_nullable
       from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])
      order by table_name, ordinal_position`,
    [UNTOUCHED_TABLES],
  );
  const { rows: constraints } = await db.query(
    `select rel.relname as table_name, con.conname, con.contype, pg_get_constraintdef(con.oid, true) as def
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace n on n.oid = rel.relnamespace
      where n.nspname = 'public' and rel.relname = any($1::text[])
      order by rel.relname, con.conname`,
    [UNTOUCHED_TABLES],
  );
  const { rows: triggers } = await db.query(
    `select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid, true) as def
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal and c.relname = any($1::text[])
      order by c.relname, t.tgname`,
    [UNTOUCHED_TABLES],
  );
  const data = {};
  for (const tbl of UNTOUCHED_TABLES) {
    const { rows } = await db.query(
      `select to_jsonb(r) as row from public.${tbl} r order by to_jsonb(r)::text`,
    );
    data[tbl] = rows;
  }
  return { columns, constraints, triggers, data };
}

/**
 * Maps `createVendorFinanceRepository` RPC calls onto PGlite with exact parameter order/casts.
 */
const VFIN_02_RPC_BINDINGS = {
  vendor_finance_get_actor_access: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
  ],
  vendor_finance_list_actor_context_options: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
  ],
  vendor_finance_list_vendors: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_search", "text"],
    ["p_active_filter", "text"],
    ["p_balance_filter", "text"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_ledger_scope", "text"],
    ["p_contract_type", "text"],
    ["p_page", "integer"],
    ["p_page_size", "integer"],
  ],
  vendor_finance_get_vendor: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_ledger_scope", "text"],
    ["p_contract_type", "text"],
  ],
  vendor_finance_list_vendor_entries: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_before_sequence", "bigint"],
    ["p_entry_type", "text"],
    ["p_page_size", "integer"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_ledger_scope", "text"],
    ["p_month", "text"],
    ["p_contract_type", "text"],
  ],
  vendor_finance_get_entry: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_entry_id", "uuid"],
  ],
  vendor_finance_list_vendor_reconciliations: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_page", "integer"],
    ["p_page_size", "integer"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_ledger_scope", "text"],
    ["p_contract_type", "text"],
  ],
  vendor_finance_record_entry: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_project_id", "text"],
    ["p_contract_type", "text"],
    ["p_entry_type", "text"],
    ["p_amount_minor", "text"],
    ["p_effective_date", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_reverse_entry: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_entry_id", "uuid"],
    ["p_effective_date", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_preview_opening_batch: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_project_id", "text"],
    ["p_contract_type", "text"],
    ["p_cutoff_date", "date"],
    ["p_items", "jsonb"],
  ],
  vendor_finance_apply_opening_batch: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_project_id", "text"],
    ["p_contract_type", "text"],
    ["p_cutoff_date", "date"],
    ["p_items", "jsonb"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_create_reconciliation: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_contract_type", "text"],
    ["p_as_of_date", "date"],
    ["p_confirmed_balance_minor", "text"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_classify_unclassified_subledger: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_target_contract_type", "text"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_get_monthly_report: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_month", "text"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_contract_type", "text"],
  ],
  vendor_finance_list_project_accountants_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_search", "text"],
    ["p_include_history", "boolean"],
    ["p_page", "integer"],
    ["p_page_size", "integer"],
  ],
  vendor_finance_assign_project_accountant_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_project_id", "text"],
    ["p_accountant_user_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_valid_from", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_end_project_accountant_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_assignment_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_valid_to", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_list_global_roles_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_search", "text"],
    ["p_include_history", "boolean"],
    ["p_page", "integer"],
    ["p_page_size", "integer"],
  ],
  vendor_finance_assign_global_role_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_target_user_id", "uuid"],
    ["p_role_code", "text"],
    ["p_expected_version", "integer"],
    ["p_valid_from", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_end_global_role_admin: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_role_grant_id", "uuid"],
    ["p_expected_version", "integer"],
    ["p_valid_to", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_reserve_evidence: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_target_kind", "text"],
    ["p_target_id", "uuid"],
    ["p_mime_type", "text"],
    ["p_size_bytes", "integer"],
    ["p_checksum_sha256", "text"],
    ["p_ttl_seconds", "integer"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_complete_evidence: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_evidence_id", "uuid"],
    ["p_outcome", "text"],
    ["p_failure_code", "text"],
  ],
  vendor_finance_get_evidence_download: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_evidence_id", "uuid"],
  ],
  vendor_finance_mark_evidence_cleaned: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_evidence_id", "uuid"],
  ],
};

async function callVfinRpc(db, fnName, params) {
  const spec = VFIN_02_RPC_BINDINGS[fnName];
  assert.ok(spec, `Unbound RPC in PGlite adapter: ${fnName}`);
  const placeholders = spec.map(([, pgType], idx) => `$${idx + 1}::${pgType}`).join(", ");
  const values = spec.map(([paramName, pgType]) => {
    const val = params[paramName];
    if (val === undefined || val === null) return null;
    return pgType === "jsonb" ? JSON.stringify(val) : val;
  });
  const { rows } = await db.query(
    `select public.${fnName}(${placeholders}) as data`,
    values,
  );
  return rows[0]?.data ?? null;
}

function createPgliteVfinRepo(db) {
  return createVendorFinanceRepository(async (fnName, params) => {
    const spec = VFIN_02_RPC_BINDINGS[fnName];
    assert.ok(spec, `Unbound RPC in PGlite adapter: ${fnName}`);
    const placeholders = spec.map(([, pgType], idx) => `$${idx + 1}::${pgType}`).join(", ");
    const values = spec.map(([paramName, pgType]) => {
      const val = params[paramName];
      if (val === undefined || val === null) return null;
      return pgType === "jsonb" ? JSON.stringify(val) : val;
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
          code: err.code ?? null,
          message: err.message ?? String(err),
          details: err.detail ?? null,
        },
      };
    }
  });
}

test("(#1) VFIN-02 migration rolls back atomically on failure and produces LF/CRLF-identical SHA-256 checksum", async () => {
  const { db, targetMigration } = await createPreVfin02Database();
  try {
    const checksum = migrationChecksum(targetMigration.sql);
    assert.match(checksum, /^[0-9a-f]{64}$/);
    assert.equal(
      migrationChecksum(targetMigration.sql.replace(/\n/g, "\r\n")),
      checksum,
      "checksum must be identical across LF and CRLF checkouts",
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

    const { rows: leakedTables } = await db.query(
      `select tablename from pg_tables
        where schemaname = 'public'
          and tablename in (
            'vendor_finance_project_accountants',
            'vendor_finance_project_vendors',
            'vendor_finance_global_roles',
            'vendor_finance_subledger_heads'
          )`,
    );
    assert.equal(leakedTables.length, 0, "failed transaction must leave zero VFIN-02 tables");
  } finally {
    await db.close();
  }
});

test("(#2) Full VFIN-02 acceptance: legacy isolation, controlled governance, non-netting sub-ledgers, 4-role matrix, cash-holder record-on-behalf, accountant handover, monthly debt report & ACLs", async () => {
  const { db, targetMigration, restMigrations } = await createPreVfin02Database();
  try {
    // -------------------------------------------------------------------------
    // 1. Seed canonical actors, projects, vendors, and PRE-EXISTING VFIN-01
    //    ledger rows BEFORE applying VFIN-02 migration!
    // -------------------------------------------------------------------------
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ($1::uuid, 'TD_VFIN02_ALPHA', 'Nhóm Tuyển Dụng Alpha', true),
              ('99500000-0000-4000-8000-00000000000f'::uuid, '__system_vendor__', 'System Vendor Internal', true)
       on conflict (code) do nothing`,
      [TEAM_ALPHA],
    );

    for (const actor of [
      FULL_ADMIN,
      ACCT_A,
      ACCT_B,
      CASH_HOLDER_VIEW,
      CASH_HOLDER_BEHALF,
      BOD_RECONCILER,
      BOD_VIEWER,
      TEAM_LEADER,
      STAFF_MEMBER,
    ]) {
      await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
      await db.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
         values ($1::uuid, $2::uuid, true, $3)`,
        [actor.app, actor.auth, actor.name],
      );
    }

    // Canonical Full Admin grants
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_admin', '2026-01-01', true),
              ($1::uuid, 'recruiter_master_manage', '2026-01-01', true),
              ($1::uuid, 'team_master_manage', '2026-01-01', true),
              ($1::uuid, 'catalog_master_manage', '2026-01-01', true)`,
      [FULL_ADMIN.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [FULL_ADMIN.app],
    );

    // Staff & Team Leader baseline grants (non-finance domains)
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_own', '2026-01-01', true)`,
      [STAFF_MEMBER.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'own', '2026-01-01', true)`,
      [STAFF_MEMBER.app],
    );

    for (const person of [ACCT_A, ACCT_B, TEAM_LEADER, STAFF_MEMBER]) {
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
      if (person === TEAM_LEADER || person === STAFF_MEMBER) {
        await db.query(
          `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
           values ($1::uuid, $2::uuid, '2026-01-01', true)`,
          [person.recruiter, TEAM_ALPHA],
        );
      }
      await db.query(
        `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
         values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
        [person.app, person.recruiter],
      );
    }

    await db.query(
      `select public.direct_entry_designate_team_leader(
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-01-15'::date, 1, 'Designate TL', 'vfin02_tl_1'
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, TEAM_ALPHA, TEAM_LEADER.app],
    );

    // Canonical Projects (`PRJ_1` and `PRJ_2`)
    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự Án Miền Bắc (PRJ-1)', true, 1),
              ($2, 'Dự Án Miền Nam (PRJ-2)', true, 1)`,
      [PRJ_1, PRJ_2],
    );
    await db.query(
      `select public.direct_entry_grant_project_team_scope(
         $1::uuid, $2::uuid, $3, $4::uuid, 0, '2026-01-15'::date, 'Grant PRJ_1 Scope', 'vfin02_pts_1'
       )`,
      [FULL_ADMIN.auth, FULL_ADMIN.app, PRJ_1, TEAM_ALPHA],
    );

    // Assign ACCT_A and ACCT_B to canonical `ACCOUNTING` department
    for (const acct of [ACCT_A, ACCT_B]) {
      const reason = `Bổ nhiệm ${acct.name} vào phòng Kế toán`;
      await db.query(
        `select public.org_department_assign_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 0, '2026-01-01'::date, $4::text, $5::uuid, $6::text
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
            effective_from: "2026-01-01",
            reason,
          }),
        ],
      );
    }

    // Create canonical Vendors
    for (const [vid, vname] of [
      ["VND_SHARED", "Công ty Cung Ứng Chung Bắc Nam"],
      ["VND_OPPOSITE", "Công ty Đối Dấu Phải Trả & Dư Ứng"],
      ["VND_LEGACY", "Công ty Dữ Liệu Lịch Sử VFIN-01"],
      ["VND_UNLINKED", "Công ty Chưa Khai Báo Quan Hệ Dự Án"],
    ]) {
      await db.query(
        `select public.direct_entry_create_vendor(
           $1::uuid, $2::uuid, 0, $3::text, $4::text, '2026-01-01'::date, 'Tạo NCC chuẩn', $5::text
         )`,
        [FULL_ADMIN.auth, FULL_ADMIN.app, vid, vname, nextUuid()],
      );
    }

    // Seed pre-existing VFIN-01 legacy entry on `VND_LEGACY` & `VND_SHARED` BEFORE VFIN-02!
    const legReason1 = "Công nợ lịch sử trước VFIN-02 (chưa gắn dự án)";
    await db.query(
      `select public.vendor_finance_record_entry(
         $1::uuid, $2::uuid, 'VND_LEGACY', 'DEBT_RECORDED', '15000000',
         '2026-09-20'::date, $3::text, $4::uuid, $5::text
       )`,
      [
        ACCT_A.auth,
        ACCT_A.app,
        legReason1,
        nextUuid(),
        computeRecordEntryFingerprint({
          vendor_id: "VND_LEGACY",
          entry_type: "DEBT_RECORDED",
          amount_minor: "15000000",
          effective_date: "2026-09-20",
          reason: legReason1,
        }),
      ],
    );

    const legSharedReason = "Khoản cũ VFIN-01 trên VND_SHARED trước khi có phân sổ dự án";
    await db.query(
      `select public.vendor_finance_record_entry(
         $1::uuid, $2::uuid, 'VND_SHARED', 'DEBT_RECORDED', '2000000',
         '2026-10-01'::date, $3::text, $4::uuid, $5::text
       )`,
      [
        ACCT_A.auth,
        ACCT_A.app,
        legSharedReason,
        nextUuid(),
        computeRecordEntryFingerprint({
          vendor_id: "VND_SHARED",
          entry_type: "DEBT_RECORDED",
          amount_minor: "2000000",
          effective_date: "2026-10-01",
          reason: legSharedReason,
        }),
      ],
    );

    const preVfin02Snapshot = await captureUntouchedSnapshot(db);

    // -------------------------------------------------------------------------
    // 2. Apply VFIN-02 migration (and any subsequent migrations)
    // -------------------------------------------------------------------------
    await db.exec(targetMigration.sql);
    await db.exec(
      `begin;
       select pg_catalog.set_config('vendor_finance.admin_write_marker', 'on', true);
       insert into public.vendor_finance_project_vendors (
         project_id, vendor_id, active, version, created_by_user_id, updated_by_user_id, reason
       ) values ('${PRJ_1}', 'VND_SHARED', true, 1, '${FULL_ADMIN.app}'::uuid, '${FULL_ADMIN.app}'::uuid,
         'Lịch sử mapping trước hotfix');
       commit;`,
    );
    for (const m of restMigrations) {
      await db.exec(m.sql);
    }
    const { rows: preservedVendorLinkHistory } = await db.query(
      `select project_id, vendor_id, active, version, reason
         from public.vendor_finance_project_vendors
        where project_id = $1 and vendor_id = $2`,
      [PRJ_1, "VND_SHARED"],
    );
    assert.deepEqual(preservedVendorLinkHistory, [
      {
        project_id: PRJ_1,
        vendor_id: "VND_SHARED",
        active: true,
        version: 1,
        reason: "Lịch sử mapping trước hotfix",
      },
    ]);

    const postVfin02Snapshot = await captureUntouchedSnapshot(db);
    assert.deepEqual(
      postVfin02Snapshot,
      preVfin02Snapshot,
      "VFIN-02 migration must have zero drift on teams, recruiters, Team Leader, project-team scopes, scope grants, and org_departments",
    );

    const repo = createPgliteVfinRepo(db);

    // -------------------------------------------------------------------------
    // 3. Verify Legacy Isolation (`LEGACY_UNALLOCATED`) Immediately Post-Migration
    // -------------------------------------------------------------------------
    const { rows: legacyRows } = await db.query(
      `select vendor_id, ledger_scope, project_id, responsible_accountant_user_id,
              amount_minor::text as amount_minor, balance_after_minor::text as balance_after_minor
         from public.vendor_finance_entries
        order by vendor_id`,
    );
    assert.deepEqual(legacyRows, [
      {
        vendor_id: "VND_LEGACY",
        ledger_scope: "LEGACY_UNALLOCATED",
        project_id: null,
        responsible_accountant_user_id: null,
        amount_minor: "15000000",
        balance_after_minor: "15000000",
      },
      {
        vendor_id: "VND_SHARED",
        ledger_scope: "LEGACY_UNALLOCATED",
        project_id: null,
        responsible_accountant_user_id: null,
        amount_minor: "2000000",
        balance_after_minor: "2000000",
      },
    ]);

    // Project-scoped accountant ACCT_A (before project assignment) has PROJECT_SCOPED visibility
    // and MUST NOT see LEGACY_UNALLOCATED rows even if ACCT_A originally entered them in VFIN-01!
    const acctAInitialAccess = await repo.getActorAccess({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
    });
    assert.equal(acctAInitialAccess.ok, true);
    assert.equal(acctAInitialAccess.data.visibility_scope, "PROJECT_SCOPED");
    assert.equal(acctAInitialAccess.data.record_scope, "ASSIGNED_PROJECTS");
    assert.equal(acctAInitialAccess.data.reconcile_scope, "ASSIGNED_PROJECTS");
    assert.equal(acctAInitialAccess.data.active_assigned_project_count, 0);
    assert.equal(acctAInitialAccess.data.can_manage_project_assignments, false);

    const acctAInitialVendors = await repo.listVendors({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      search: null,
      active: "all",
      balance_filter: "all",
      project_id: null,
      accountant_ref: null,
      ledger_scope: "all",
      page: 1,
      page_size: 25,
    });
    assert.equal(acctAInitialVendors.ok, true);
    assert.equal(
      acctAInitialVendors.data.vendors.length,
      0,
      "unassigned project accountant must see 0 vendors and 0 legacy rows",
    );

    // -------------------------------------------------------------------------
    // 4. Governance & Controlled Relationships by Canonical Full Admin
    // -------------------------------------------------------------------------
    // Non-admins are denied governance access
    for (const nonAdmin of [ACCT_A, TEAM_LEADER, STAFF_MEMBER]) {
      const deniedGov = await repo.listProjectAccountantsAdmin({
        auth_subject: nonAdmin.auth,
        app_user_id: nonAdmin.app,
        search: null,
        include_history: true,
        page: 1,
        page_size: 25,
      });
      assert.equal(deniedGov.ok, false);
    }

    // Assign ACCT_A -> PRJ_1 (`valid_from = 2026-10-01`)
    const assignAReason = "Phân công Kế toán A phụ trách sổ thu/chi PRJ_1";
    const assignARes = await repo.assignProjectAccountantAdmin({
      auth_subject: FULL_ADMIN.auth,
      app_user_id: FULL_ADMIN.app,
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      expected_version: 0,
      valid_from: "2026-10-01",
      reason: assignAReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeAssignProjectAccountantFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_A.app,
        valid_from: "2026-10-01",
        expected_version: 0,
        reason: assignAReason,
      }),
    });
    assert.equal(assignARes.ok, true, JSON.stringify(assignARes));
    assert.equal(assignARes.data.project_id, PRJ_1);
    assert.equal(assignARes.data.version, 1);

    // Invariant: 1 project = 1 active responsible accountant at a time!
    // Attempting to assign ACCT_B to PRJ_1 while ACCT_A is active MUST fail!
    const dupAssignReason = "Thử gán trùng kế toán thứ 2 cho cùng dự án PRJ_1";
    const dupAssignRes = await repo.assignProjectAccountantAdmin({
      auth_subject: FULL_ADMIN.auth,
      app_user_id: FULL_ADMIN.app,
      project_id: PRJ_1,
      accountant_ref: ACCT_B.app,
      expected_version: 1,
      valid_from: "2026-10-05",
      reason: dupAssignReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeAssignProjectAccountantFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_B.app,
        valid_from: "2026-10-05",
        expected_version: 1,
        reason: dupAssignReason,
      }),
    });
    assert.equal(dupAssignRes.ok, false);
    assert.equal(dupAssignRes.code, "VENDOR_FINANCE_PROJECT_ALREADY_ASSIGNED");

    // Assign ACCT_B -> PRJ_2 (`valid_from = 2026-10-01`)
    const assignBReason = "Phân công Kế toán B phụ trách sổ thu/chi PRJ_2";
    const assignBRes = await repo.assignProjectAccountantAdmin({
      auth_subject: FULL_ADMIN.auth,
      app_user_id: FULL_ADMIN.app,
      project_id: PRJ_2,
      accountant_ref: ACCT_B.app,
      expected_version: 0,
      valid_from: "2026-10-01",
      reason: assignBReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeAssignProjectAccountantFingerprint({
        project_id: PRJ_2,
        accountant_ref: ACCT_B.app,
        valid_from: "2026-10-01",
        expected_version: 0,
        reason: assignBReason,
      }),
    });
    assert.equal(assignBRes.ok, true);

    // Designate Global VFIN Roles:
    // - CASH_HOLDER_VIEW -> CASH_HOLDER (view + reconcile globally, NO record)
    // - CASH_HOLDER_BEHALF -> CASH_HOLDER_RECORD_BEHALF (view + reconcile + record on behalf globally)
    // - BOD_RECONCILER -> GLOBAL_RECONCILER (BoD view + narrow reconcile globally, NO record)
    // - BOD_VIEWER -> GLOBAL_VIEWER (BoD view-only globally)
    for (const [person, roleCode] of [
      [CASH_HOLDER_VIEW, "CASH_HOLDER"],
      [CASH_HOLDER_BEHALF, "CASH_HOLDER_RECORD_BEHALF"],
      [BOD_RECONCILER, "GLOBAL_RECONCILER"],
      [BOD_VIEWER, "GLOBAL_VIEWER"],
    ]) {
      const roleReason = `Chỉ định vai trò ${roleCode} cho ${person.name}`;
      const roleData = await callVfinRpc(db, "vendor_finance_assign_global_role_admin", {
        p_auth_subject: FULL_ADMIN.auth,
        p_app_user_id: FULL_ADMIN.app,
        p_target_user_id: person.app,
        p_role_code: roleCode,
        p_expected_version: 0,
        p_valid_from: "2026-10-01",
        p_reason: roleReason,
        p_idempotency_key: nextUuid(),
        p_request_fingerprint: computeAssignGlobalRoleFingerprint({
          account_ref: person.app,
          role_code: roleCode,
          valid_from: "2026-10-01",
          expected_version: 0,
          reason: roleReason,
        }),
      });
      assert.equal(roleData.role_code, roleCode);
    }

    // Verify Governance Read projections work cleanly
    const adminAssignList = await repo.listProjectAccountantsAdmin({
      auth_subject: FULL_ADMIN.auth,
      app_user_id: FULL_ADMIN.app,
      search: null,
      include_history: true,
      page: 1,
      page_size: 25,
    });
    assert.equal(adminAssignList.ok, true, JSON.stringify(adminAssignList));
    assert.equal(adminAssignList.data.projects.length, 2);

    const adminRolesListData = await callVfinRpc(db, "vendor_finance_list_global_roles_admin", {
      p_auth_subject: FULL_ADMIN.auth,
      p_app_user_id: FULL_ADMIN.app,
      p_search: null,
      p_include_history: true,
      p_page: 1,
      p_page_size: 25,
    });
    assert.equal(adminRolesListData.roles.length, 4);

    // -------------------------------------------------------------------------
    // 5. Verify 4-Role Actor Access & Scoped Context Options
    // -------------------------------------------------------------------------
    const accessA = await repo.getActorAccess({ auth_subject: ACCT_A.auth, app_user_id: ACCT_A.app });
    assert.equal(accessA.ok, true);
    assert.deepEqual(
      {
        can_view: accessA.data.can_view,
        can_record: accessA.data.can_record,
        can_reconcile: accessA.data.can_reconcile,
        can_manage: accessA.data.can_manage_project_assignments,
        vis: accessA.data.visibility_scope,
        rec: accessA.data.record_scope,
        recon: accessA.data.reconcile_scope,
        active_assigned_project_count: accessA.data.active_assigned_project_count,
      },
      {
        can_view: true,
        can_record: true,
        can_reconcile: true,
        can_manage: false,
        vis: "PROJECT_SCOPED",
        rec: "ASSIGNED_PROJECTS",
        recon: "ASSIGNED_PROJECTS",
        active_assigned_project_count: 1,
      },
    );

    // ACCT_A sees only PRJ_1; vendor eligibility is implicit, not a manual link list.
    const ctxA = await repo.listContextOptions({ auth_subject: ACCT_A.auth, app_user_id: ACCT_A.app });
    assert.equal(ctxA.ok, true, JSON.stringify(ctxA));
    assert.deepEqual(
      ctxA.data.projects.map((p) => p.project_id),
      [PRJ_1],
    );
    assert.equal(ctxA.data.vendors.some((v) => v.vendor_id === "VND_SHARED"), true);
    assert.equal(ctxA.data.projects[0].linked_vendors, undefined);
    const implicitVendorPreview = await repo.previewOpeningBatch({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      cutoff_date: "2026-10-01",
      items: [{ vendor_id: "VND_UNLINKED", entry_type: "OPENING_PAYABLE", amount_minor: "1000000" }],
    });
    assert.equal(implicitVendorPreview.ok, true, JSON.stringify(implicitVendorPreview));

    // Cash-Holder (view + reconcile, no record)
    const accessCashView = await repo.getActorAccess({
      auth_subject: CASH_HOLDER_VIEW.auth,
      app_user_id: CASH_HOLDER_VIEW.app,
    });
    assert.equal(accessCashView.ok, true);
    assert.equal(accessCashView.data.visibility_scope, "ALL");
    assert.equal(accessCashView.data.reconcile_scope, "ALL");
    assert.equal(accessCashView.data.record_scope, "NONE");
    assert.equal(accessCashView.data.can_reconcile, true);
    assert.equal(accessCashView.data.can_record, false);

    // Cash-Holder Record-on-Behalf
    const accessCashBehalf = await repo.getActorAccess({
      auth_subject: CASH_HOLDER_BEHALF.auth,
      app_user_id: CASH_HOLDER_BEHALF.app,
    });
    assert.equal(accessCashBehalf.ok, true);
    assert.equal(accessCashBehalf.data.visibility_scope, "ALL");
    assert.equal(accessCashBehalf.data.reconcile_scope, "ALL");
    assert.equal(accessCashBehalf.data.record_scope, "ALL");
    assert.equal(accessCashBehalf.data.can_record, true);

    // BoD Narrow Reconciler (can_reconcile = true WITHOUT can_record!)
    const accessBodRecon = await repo.getActorAccess({
      auth_subject: BOD_RECONCILER.auth,
      app_user_id: BOD_RECONCILER.app,
    });
    assert.equal(accessBodRecon.ok, true);
    assert.equal(accessBodRecon.data.visibility_scope, "ALL");
    assert.equal(accessBodRecon.data.reconcile_scope, "ALL");
    assert.equal(accessBodRecon.data.record_scope, "NONE");
    assert.equal(accessBodRecon.data.can_reconcile, true);
    assert.equal(accessBodRecon.data.can_record, false);

    // BoD Global Viewer (strictly read-only)
    const accessBodView = await repo.getActorAccess({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
    });
    assert.equal(accessBodView.ok, true);
    assert.equal(accessBodView.data.can_view, true);
    assert.equal(accessBodView.data.can_reconcile, false);
    assert.equal(accessBodView.data.can_record, false);

    // Team Leader & Staff remain denied in VFIN
    for (const deniedActor of [TEAM_LEADER, STAFF_MEMBER]) {
      const deniedAcc = await repo.getActorAccess({
        auth_subject: deniedActor.auth,
        app_user_id: deniedActor.app,
      });
      assert.equal(deniedAcc.ok, true);
      assert.equal(deniedAcc.data.allowed, false);
      assert.equal(deniedAcc.data.can_view, false);
    }

    // -------------------------------------------------------------------------
    // 7. Hierarchy `Company -> Accountant -> Project -> Vendor` & ZERO Netting
    // -------------------------------------------------------------------------
    // Masterplan concrete example:
    // - ACCT_A on PRJ_1 records 10,000,000 payable for VND_SHARED
    // - ACCT_B on PRJ_2 records 20,000,000 payable for VND_SHARED
    const recA1Reason = "Phí cung ứng nhân sự tháng 10 dự án Miền Bắc";
    const recA1 = await repo.recordEntry({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_SHARED",
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "10000000",
      effective_date: "2026-10-05",
      reason: recA1Reason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_1,
        vendor_id: "VND_SHARED",
        contract_type: "OFFICIAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "10000000",
        effective_date: "2026-10-05",
        reason: recA1Reason,
      }),
    });
    assert.equal(recA1.ok, true, JSON.stringify(recA1));
    assert.equal(recA1.data.entry.ledger_scope, "PROJECT_ACCOUNTANT");
    assert.equal(recA1.data.entry.project_id, PRJ_1);
    assert.equal(recA1.data.entry.accountant_ref, ACCT_A.app);
    assert.equal(recA1.data.entry.contract_type, "OFFICIAL");
    assert.equal(recA1.data.entry.created_by_display_name, ACCT_A.name);
    assert.equal(recA1.data.entry.vendor_sequence, 1);
    assert.equal(recA1.data.entry.balance_after_minor, "10000000");

    // ACCT_A attempting to record on PRJ_2 MUST be rejected (`VENDOR_FINANCE_PROJECT_ACCESS_DENIED`)
    const crossReason = "Kế toán A thử ghi trái phép sang PRJ_2";
    const crossWrite = await repo.recordEntry({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_SHARED",
      project_id: PRJ_2,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "1000000",
      effective_date: "2026-10-05",
      reason: crossReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_2,
        vendor_id: "VND_SHARED",
        contract_type: "OFFICIAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "1000000",
        effective_date: "2026-10-05",
        reason: crossReason,
      }),
    });
    assert.equal(crossWrite.ok, false);
    assert.equal(crossWrite.code, "VENDOR_FINANCE_PROJECT_ACCESS_DENIED");

    // ACCT_B records 20,000,000 payable for VND_SHARED on PRJ_2
    const recB1Reason = "Phí cung ứng nhân sự tháng 10 dự án Miền Nam";
    const recB1 = await repo.recordEntry({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      vendor_id: "VND_SHARED",
      project_id: PRJ_2,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "20000000",
      effective_date: "2026-10-06",
      reason: recB1Reason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_2,
        vendor_id: "VND_SHARED",
        contract_type: "OFFICIAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "20000000",
        effective_date: "2026-10-06",
        reason: recB1Reason,
      }),
    });
    assert.equal(recB1.ok, true, JSON.stringify(recB1));
    assert.equal(recB1.data.entry.vendor_sequence, 1);
    assert.equal(recB1.data.entry.balance_after_minor, "20000000");

    // Opposite-sign sub-ledgers on `VND_OPPOSITE` via Opening Balance Batch:
    // - PRJ_1 (ACCT_A): OPENING_PAYABLE = +10,000,000
    // - PRJ_2 (ACCT_B): OPENING_ADVANCE = -4,000,000
    const openAItems = [{ vendor_id: "VND_OPPOSITE", entry_type: "OPENING_PAYABLE", amount_minor: "10000000" }];
    const openAReason = "Khởi tạo số dư đầu kỳ PRJ_1 cho VND_OPPOSITE";
    const previewOpenA = await repo.previewOpeningBatch({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      cutoff_date: "2026-10-01",
      items: openAItems,
    });
    assert.equal(previewOpenA.ok, true, JSON.stringify(previewOpenA));
    assert.equal(previewOpenA.data.project_id, PRJ_1);
    assert.equal(previewOpenA.data.accountant_ref, ACCT_A.app);
    assert.equal(previewOpenA.data.contract_type, "OFFICIAL");
    assert.equal(previewOpenA.data.total_payable_minor, "10000000");

    const applyOpenA = await repo.applyOpeningBatch({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      cutoff_date: "2026-10-01",
      items: openAItems,
      reason: openAReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeApplyOpeningBatchFingerprint({
        project_id: PRJ_1,
        contract_type: "OFFICIAL",
        cutoff_date: "2026-10-01",
        items: openAItems,
        reason: openAReason,
      }),
    });
    assert.equal(applyOpenA.ok, true, JSON.stringify(applyOpenA));

    const openBItems = [{ vendor_id: "VND_OPPOSITE", entry_type: "OPENING_ADVANCE", amount_minor: "4000000" }];
    const openBReason = "Khởi tạo dư ứng đầu kỳ PRJ_2 cho VND_OPPOSITE (cùng NCC khác dự án vẫn cho phép!)";
    const applyOpenB = await repo.applyOpeningBatch({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      project_id: PRJ_2,
      contract_type: "OFFICIAL",
      cutoff_date: "2026-10-01",
      items: openBItems,
      reason: openBReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeApplyOpeningBatchFingerprint({
        project_id: PRJ_2,
        contract_type: "OFFICIAL",
        cutoff_date: "2026-10-01",
        items: openBItems,
        reason: openBReason,
      }),
    });
    assert.equal(applyOpenB.ok, true, JSON.stringify(applyOpenB));

    // Verify ZERO CROSS-NETTING on `VND_OPPOSITE` when viewed globally by BoD!
    // MUST NOT net +10,000,000 and -4,000,000 into +6,000,000!
    const bodListVendors = await repo.listVendors({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      search: "VND_OPPOSITE",
      active: "all",
      balance_filter: "all",
      project_id: null,
      accountant_ref: null,
      ledger_scope: "all",
      page: 1,
      page_size: 25,
    });
    assert.equal(bodListVendors.ok, true, JSON.stringify(bodListVendors));
    const oppositeListItem = bodListVendors.data.vendors.find((v) => v.vendor_id === "VND_OPPOSITE");
    assert.ok(oppositeListItem);
    assert.equal(oppositeListItem.balance_direction, "MULTI_LEDGER");
    assert.equal(oppositeListItem.current_balance_minor, "0"); // Sentinel when MULTI_LEDGER; payable & advance kept separate!
    assert.equal(oppositeListItem.payable_total_minor, "10000000");
    assert.equal(oppositeListItem.advance_total_minor, "4000000");
    assert.equal(oppositeListItem.sub_ledgers.length, 2);

    const bodOppositeDetail = await repo.getVendor({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      vendor_id: "VND_OPPOSITE",
      project_id: null,
      accountant_ref: null,
      ledger_scope: null,
    });
    assert.equal(bodOppositeDetail.ok, true, JSON.stringify(bodOppositeDetail));
    assert.notEqual(
      bodOppositeDetail.data.vendor.current_balance_minor,
      "6000000",
      "getVendor must NEVER net +10M payable and -4M advance into +6M",
    );
    assert.equal(bodOppositeDetail.data.selected_sub_ledger?.project_id, PRJ_1);
    assert.equal(bodOppositeDetail.data.vendor.current_balance_minor, "10000000");
    assert.equal(bodOppositeDetail.data.vendor.balance_direction, "PAYABLE");
    assert.equal(bodOppositeDetail.data.sub_ledgers.length, 2);

    const bodOppositePrj2Detail = await repo.getVendor({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      vendor_id: "VND_OPPOSITE",
      project_id: PRJ_2,
      accountant_ref: ACCT_B.app,
      ledger_scope: "PROJECT_ACCOUNTANT",
    });
    assert.equal(bodOppositePrj2Detail.ok, true, JSON.stringify(bodOppositePrj2Detail));
    assert.equal(bodOppositePrj2Detail.data.selected_sub_ledger?.project_id, PRJ_2);
    assert.equal(bodOppositePrj2Detail.data.vendor.current_balance_minor, "-4000000");
    assert.equal(bodOppositePrj2Detail.data.vendor.balance_direction, "ADVANCE");

    // Meanwhile ACCT_A sees ONLY ACCT_A's PRJ_1 sub-ledger (10,000,000 PAYABLE)
    // and ZERO rows of ACCT_B's PRJ_2 or `LEGACY_UNALLOCATED`!
    const acctASharedDetail = await repo.getVendor({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_SHARED",
      project_id: null,
      accountant_ref: null,
      ledger_scope: null,
    });
    assert.equal(acctASharedDetail.ok, true, JSON.stringify(acctASharedDetail));
    assert.equal(acctASharedDetail.data.vendor.balance_direction, "PAYABLE");
    assert.equal(acctASharedDetail.data.vendor.current_balance_minor, "10000000");
    assert.equal(acctASharedDetail.data.sub_ledgers.length, 2);
    for (const sl of acctASharedDetail.data.sub_ledgers) {
      assert.equal(sl.project_id, PRJ_1);
      assert.equal(sl.accountant_ref, ACCT_A.app);
    }

    // ACCT_A cannot fetch ACCT_B's entry by ID (`getEntry` fails closed)
    const acctAGetBEntry = await repo.getEntry({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      entry_id: recB1.data.entry.entry_id,
    });
    assert.equal(acctAGetBEntry.ok, false);

    // -------------------------------------------------------------------------
    // 8. Cash-Holder Record-on-Behalf Invariant & Narrow BoD Reconciler
    // -------------------------------------------------------------------------
    // CASH_HOLDER_VIEW cannot record money entries
    const cashViewDeniedReason = "Cầm tiền chỉ theo dõi đối soát thử ghi sổ";
    const cashViewRec = await repo.recordEntry({
      auth_subject: CASH_HOLDER_VIEW.auth,
      app_user_id: CASH_HOLDER_VIEW.app,
      vendor_id: "VND_SHARED",
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "PAYMENT_RECORDED",
      amount_minor: "1000000",
      effective_date: "2026-10-08",
      reason: cashViewDeniedReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_1,
        vendor_id: "VND_SHARED",
        contract_type: "OFFICIAL",
        entry_type: "PAYMENT_RECORDED",
        amount_minor: "1000000",
        effective_date: "2026-10-08",
        reason: cashViewDeniedReason,
      }),
    });
    assert.equal(cashViewRec.ok, false);
    assert.equal(cashViewRec.code, "VENDOR_FINANCE_RECORD_DENIED");

    // CASH_HOLDER_BEHALF records 3,000,000 payment on PRJ_1 on behalf of ACCT_A:
    // Ownership (`accountant_ref` / `responsible_accountant_user_id`) MUST remain ACCT_A,
    // while `created_by_user_id` is CASH_HOLDER_BEHALF!
    const behalfReason = "Kế toán cầm tiền chi trả hộ sổ PRJ_1 đợt 1";
    const behalfRec = await repo.recordEntry({
      auth_subject: CASH_HOLDER_BEHALF.auth,
      app_user_id: CASH_HOLDER_BEHALF.app,
      vendor_id: "VND_SHARED",
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "PAYMENT_RECORDED",
      amount_minor: "3000000",
      effective_date: "2026-10-08",
      reason: behalfReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_1,
        vendor_id: "VND_SHARED",
        contract_type: "OFFICIAL",
        entry_type: "PAYMENT_RECORDED",
        amount_minor: "3000000",
        effective_date: "2026-10-08",
        reason: behalfReason,
      }),
    });
    assert.equal(behalfRec.ok, true, JSON.stringify(behalfRec));
    assert.equal(
      behalfRec.data.entry.accountant_ref,
      ACCT_A.app,
      "record-on-behalf MUST keep ownership on PRJ_1's active accountant ACCT_A (never Cash-Holder's personal book)",
    );
    assert.equal(
      behalfRec.data.entry.created_by_display_name,
      CASH_HOLDER_BEHALF.name,
      "created_by must accurately audit the Cash-Holder who entered the transaction",
    );
    const {
      rows: [behalfDbRow],
    } = await db.query(
      `select responsible_accountant_user_id::text as owner_id, created_by_user_id::text as creator_id
         from public.vendor_finance_entries
        where entry_id = $1::uuid`,
      [behalfRec.data.entry.entry_id],
    );
    assert.deepEqual(behalfDbRow, {
      owner_id: ACCT_A.app,
      creator_id: CASH_HOLDER_BEHALF.app,
    });
    assert.equal(behalfRec.data.entry.vendor_sequence, 2);
    assert.equal(behalfRec.data.entry.balance_before_minor, "10000000");
    assert.equal(behalfRec.data.entry.balance_delta_minor, "-3000000");
    assert.equal(behalfRec.data.entry.balance_after_minor, "7000000");

    // Narrow BoD Reconciler (`BOD_RECONCILER`):
    // - Rejected on `recordEntry` (`VENDOR_FINANCE_RECORD_DENIED`)
    // - Permitted on `createReconciliation` for `(VND_SHARED, PRJ_1, ACCT_A)` independently!
    const bodRecDeniedReason = "BoD đối soát thử ghi bút toán tiền";
    const bodRecDenied = await repo.recordEntry({
      auth_subject: BOD_RECONCILER.auth,
      app_user_id: BOD_RECONCILER.app,
      vendor_id: "VND_SHARED",
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "PAYMENT_RECORDED",
      amount_minor: "500000",
      effective_date: "2026-10-09",
      reason: bodRecDeniedReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_1,
        vendor_id: "VND_SHARED",
        contract_type: "OFFICIAL",
        entry_type: "PAYMENT_RECORDED",
        amount_minor: "500000",
        effective_date: "2026-10-09",
        reason: bodRecDeniedReason,
      }),
    });
    assert.equal(bodRecDenied.ok, false);
    assert.equal(bodRecDenied.code, "VENDOR_FINANCE_RECORD_DENIED");

    const reconP1Reason = "BoD đối soát cuối tuần sổ PRJ_1 của Kế toán A";
    const reconP1 = await repo.createReconciliation({
      auth_subject: BOD_RECONCILER.auth,
      app_user_id: BOD_RECONCILER.app,
      vendor_id: "VND_SHARED",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      contract_type: "OFFICIAL",
      as_of_date: "2026-10-10",
      confirmed_balance_minor: "7000000",
      reason: reconP1Reason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeCreateReconciliationFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_A.app,
        vendor_id: "VND_SHARED",
        contract_type: "OFFICIAL",
        as_of_date: "2026-10-10",
        confirmed_balance_minor: "7000000",
        reason: reconP1Reason,
      }),
    });
    assert.equal(reconP1.ok, true, JSON.stringify(reconP1));
    assert.equal(reconP1.data.reconciliation.system_balance_minor, "7000000");
    assert.equal(reconP1.data.reconciliation.difference_minor, "0");
    assert.equal(reconP1.data.reconciliation.project_id, PRJ_1);
    assert.equal(reconP1.data.reconciliation.accountant_ref, ACCT_A.app);
    assert.equal(reconP1.data.reconciliation.contract_type, "OFFICIAL");
    assert.equal(reconP1.data.reconciliation.created_by_display_name, BOD_RECONCILER.name);

    // BOD_VIEWER (view-only) MUST be denied on `createReconciliation`
    const bodViewReconReason = "BoD chỉ xem thử tạo đối soát";
    const bodViewRecon = await repo.createReconciliation({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      vendor_id: "VND_SHARED",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      contract_type: "OFFICIAL",
      as_of_date: "2026-10-10",
      confirmed_balance_minor: "7000000",
      reason: bodViewReconReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeCreateReconciliationFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_A.app,
        vendor_id: "VND_SHARED",
        contract_type: "OFFICIAL",
        as_of_date: "2026-10-10",
        confirmed_balance_minor: "7000000",
        reason: bodViewReconReason,
      }),
    });
    assert.equal(bodViewRecon.ok, false);
    assert.equal(bodViewRecon.code, "VENDOR_FINANCE_RECONCILE_DENIED");

    // -------------------------------------------------------------------------
    // 9. Project Accountant Handover (`ACCT_A -> ACCT_B` on `PRJ_1`)
    // -------------------------------------------------------------------------
    const endAReason = "Bàn giao dự án PRJ_1 từ Kế toán A sang Kế toán B từ 15/10/2026";
    const endARes = await repo.endProjectAccountantAdmin({
      auth_subject: FULL_ADMIN.auth,
      app_user_id: FULL_ADMIN.app,
      assignment_id: assignARes.data.assignment_id,
      expected_version: 1,
      valid_to: "2026-10-15",
      reason: endAReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeEndProjectAccountantFingerprint({
        assignment_id: assignARes.data.assignment_id,
        expected_version: 1,
        valid_to: "2026-10-15",
        reason: endAReason,
      }),
    });
    assert.equal(endARes.ok, true, JSON.stringify(endARes));
    assert.equal(endARes.data.valid_to, "2026-10-15");

    const handoverBReason = "Phân công Kế toán B tiếp nhận phụ trách dự án PRJ_1";
    const handoverBRes = await repo.assignProjectAccountantAdmin({
      auth_subject: FULL_ADMIN.auth,
      app_user_id: FULL_ADMIN.app,
      project_id: PRJ_1,
      accountant_ref: ACCT_B.app,
      expected_version: 1,
      valid_from: "2026-10-15",
      reason: handoverBReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeAssignProjectAccountantFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_B.app,
        valid_from: "2026-10-15",
        expected_version: 1,
        reason: handoverBReason,
      }),
    });
    assert.equal(handoverBRes.ok, true, JSON.stringify(handoverBRes));
    assert.equal(handoverBRes.data.version, 2);

    // ACCT_B records 5,000,000 payroll on PRJ_1 after handover:
    // Creates a NEW independent sub-ledger `(VND_SHARED, PRJ_1, ACCT_B)` starting at sequence 1!
    const recBHandoverReason = "Lương công nhân đợt 2 trên PRJ_1 do Kế toán B phụ trách";
    const recBHandover = await repo.recordEntry({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      vendor_id: "VND_SHARED",
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "PAYROLL_RECORDED",
      amount_minor: "5000000",
      effective_date: "2026-10-18",
      reason: recBHandoverReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_1,
        vendor_id: "VND_SHARED",
        contract_type: "OFFICIAL",
        entry_type: "PAYROLL_RECORDED",
        amount_minor: "5000000",
        effective_date: "2026-10-18",
        reason: recBHandoverReason,
      }),
    });
    assert.equal(recBHandover.ok, true, JSON.stringify(recBHandover));
    assert.equal(recBHandover.data.entry.accountant_ref, ACCT_B.app);
    assert.equal(recBHandover.data.entry.vendor_sequence, 1);
    assert.equal(recBHandover.data.entry.balance_after_minor, "5000000");

    // Former project accountant ACCT_A (still active in ACCOUNTING):
    // - Retains read-only visibility of `(VND_SHARED, PRJ_1, ACCT_A)` = 7,000,000
    // - Sees ZERO rows of `(VND_SHARED, PRJ_1, ACCT_B)` or `(VND_SHARED, PRJ_2, ACCT_B)`
    // - Cannot record new entries on PRJ_1 (`active_assigned_project_count = 0`, `VENDOR_FINANCE_PROJECT_ACCESS_DENIED`)
    const accessAAfterHandover = await repo.getActorAccess({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
    });
    assert.equal(accessAAfterHandover.ok, true);
    assert.equal(accessAAfterHandover.data.can_view, true);
    assert.equal(accessAAfterHandover.data.active_assigned_project_count, 0);

    const aWriteAfterHandoverReason = "Kế toán A thử ghi sổ sau khi đã bàn giao PRJ_1";
    const aWriteAfterHandover = await repo.recordEntry({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_SHARED",
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "100000",
      effective_date: "2026-10-19",
      reason: aWriteAfterHandoverReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_1,
        vendor_id: "VND_SHARED",
        contract_type: "OFFICIAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "100000",
        effective_date: "2026-10-19",
        reason: aWriteAfterHandoverReason,
      }),
    });
    assert.equal(aWriteAfterHandover.ok, false);
    assert.equal(aWriteAfterHandover.code, "VENDOR_FINANCE_PROJECT_ACCESS_DENIED");

    const detailAAfterHandover = await repo.getVendor({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_SHARED",
      project_id: null,
      accountant_ref: null,
      ledger_scope: null,
    });
    assert.equal(detailAAfterHandover.ok, true, JSON.stringify(detailAAfterHandover));
    assert.equal(detailAAfterHandover.data.vendor.current_balance_minor, "7000000");
    assert.equal(detailAAfterHandover.data.sub_ledgers.length, 1);
    assert.equal(detailAAfterHandover.data.sub_ledgers[0].is_active_assignment, false);
    assert.equal(detailAAfterHandover.data.sub_ledgers[0].can_record_entry, false);

    const entriesAAfterHandover = await repo.listVendorEntries({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_SHARED",
      before_sequence: null,
      entry_type: null,
      page_size: 25,
      project_id: PRJ_1,
      accountant_ref: null,
      ledger_scope: null,
      month: "2026-10",
    });
    assert.equal(entriesAAfterHandover.ok, true);
    assert.equal(entriesAAfterHandover.data.entries.length, 2);
    for (const e of entriesAAfterHandover.data.entries) {
      assert.equal(e.accountant_ref, ACCT_A.app);
    }

    // Reversal preserves the target entry's `(project_id, responsible_accountant_user_id, contract_type)` sub-ledger!
    const adjReason = "Điều chỉnh tăng phí phát sinh thêm trên PRJ_2";
    const adjEntry = await repo.recordEntry({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      vendor_id: "VND_SHARED",
      project_id: PRJ_2,
      contract_type: "OFFICIAL",
      entry_type: "ADJUSTMENT_INCREASE",
      amount_minor: "1500000",
      effective_date: "2026-10-19",
      reason: adjReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_2,
        vendor_id: "VND_SHARED",
        contract_type: "OFFICIAL",
        entry_type: "ADJUSTMENT_INCREASE",
        amount_minor: "1500000",
        effective_date: "2026-10-19",
        reason: adjReason,
      }),
    });
    assert.equal(adjEntry.ok, true);
    assert.equal(adjEntry.data.entry.balance_after_minor, "21500000");

    const revReason = "Hoàn tác điều chỉnh nhầm số tiền trên PRJ_2";
    const revEntry = await repo.reverseEntry({
      auth_subject: CASH_HOLDER_BEHALF.auth,
      app_user_id: CASH_HOLDER_BEHALF.app,
      entry_id: adjEntry.data.entry.entry_id,
      effective_date: "2026-10-19",
      reason: revReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeReverseEntryFingerprint({
        entry_id: adjEntry.data.entry.entry_id,
        effective_date: "2026-10-19",
        reason: revReason,
      }),
    });
    assert.equal(revEntry.ok, true, JSON.stringify(revEntry));
    assert.equal(revEntry.data.reversal_entry.project_id, PRJ_2);
    assert.equal(revEntry.data.reversal_entry.accountant_ref, ACCT_B.app);
    assert.equal(revEntry.data.reversal_entry.contract_type, "OFFICIAL");
    assert.equal(revEntry.data.reversal_entry.created_by_display_name, CASH_HOLDER_BEHALF.name);
    assert.equal(revEntry.data.reversal_entry.balance_after_minor, "20000000");

    // -------------------------------------------------------------------------
    // 10. Project & Monthly Debt Report (`getMonthlyReport` + `month=YYYY-MM`)
    // -------------------------------------------------------------------------
    const bodReport = await repo.getMonthlyReport({
      auth_subject: BOD_RECONCILER.auth,
      app_user_id: BOD_RECONCILER.app,
      month: "2026-10",
      project_id: null,
      accountant_ref: null,
      vendor_id: null,
    });
    assert.equal(bodReport.ok, true, JSON.stringify(bodReport));
    assert.equal(bodReport.data.filters.month, "2026-10");
    assert.equal(bodReport.data.totals.project_revenue_status, "MISSING_CANONICAL_SOURCE");
    assert.equal(bodReport.data.totals.project_revenue_minor, null);

    // Every project×accountant summary MUST report `MISSING_CANONICAL_SOURCE` and `null` revenue (never fake `0`!)
    for (const ps of bodReport.data.project_accountant_summaries) {
      assert.equal(ps.project_revenue_status, "MISSING_CANONICAL_SOURCE");
      assert.equal(ps.project_revenue_minor, null);
    }

    // Verify `VND_SHARED` has 3 distinct project×accountant rows in `rows`
    // (`(PRJ_1, ACCT_A)` = 7,000,000; `(PRJ_1, ACCT_B)` = 5,000,000; `(PRJ_2, ACCT_B)` = 20,000,000)
    // and 1 isolated `legacy_unallocated_rows` item (`2,000,000`), NEVER merged or netted!
    const sharedReportRows = bodReport.data.rows
      .filter((r) => r.vendor_id === "VND_SHARED")
      .map((r) => ({
        project_id: r.project_id,
        accountant: r.accountant_ref,
        closing_balance_minor: r.closing_balance_minor,
        paid_in_month_minor: r.paid_in_month_minor,
      }))
      .sort((a, b) =>
        `${a.project_id}:${a.accountant}`.localeCompare(`${b.project_id}:${b.accountant}`),
      );
    assert.deepEqual(sharedReportRows, [
      {
        project_id: PRJ_1,
        accountant: ACCT_A.app,
        closing_balance_minor: "7000000",
        paid_in_month_minor: "3000000",
      },
      {
        project_id: PRJ_1,
        accountant: ACCT_B.app,
        closing_balance_minor: "5000000",
        paid_in_month_minor: "0",
      },
      {
        project_id: PRJ_2,
        accountant: ACCT_B.app,
        closing_balance_minor: "20000000",
        paid_in_month_minor: "0",
      },
    ]);

    // Verify `VND_OPPOSITE` closing payable (10M) and closing advance (4M) stay un-netted in totals!
    // Total closing payable across project sub-ledgers = 7M + 5M + 20M (VND_SHARED) + 10M (VND_OPPOSITE) = 42,000,000
    // Total closing advance across project sub-ledgers = 4,000,000 (VND_OPPOSITE on PRJ_2)
    assert.equal(bodReport.data.totals.closing_payable_minor, "42000000");
    assert.equal(bodReport.data.totals.closing_advance_minor, "4000000");

    // Legacy rows stay isolated in `legacy_unallocated_rows` (`VND_LEGACY` 15M + `VND_SHARED` 2M)
    assert.deepEqual(
      bodReport.data.legacy_unallocated_rows
        .map((r) => ({ vendor_id: r.vendor_id, closing: r.closing_balance_minor }))
        .sort((a, b) => a.vendor_id.localeCompare(b.vendor_id)),
      [
        { vendor_id: "VND_LEGACY", closing: "15000000" },
        { vendor_id: "VND_SHARED", closing: "2000000" },
      ],
    );

    // Project-scoped report for ACCT_A shows ONLY ACCT_A's sub-ledgers and ZERO legacy rows
    const acctAReport = await repo.getMonthlyReport({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      month: "2026-10",
      project_id: null,
      accountant_ref: null,
      vendor_id: null,
    });
    assert.equal(acctAReport.ok, true);
    assert.equal(acctAReport.data.legacy_unallocated_rows.length, 0);
    for (const r of acctAReport.data.rows) {
      assert.equal(r.accountant_ref, ACCT_A.app);
    }

    // -------------------------------------------------------------------------
    // 10b. Project-Scoped Evidence Lifecycle + Global Role Termination
    // -------------------------------------------------------------------------
    const sampleChecksum = "a".repeat(64);
    const prj2EntryId = recB1.data.entry.entry_id;

    // ACCT_A (unassigned to PRJ_2) CANNOT reserve evidence on PRJ_2's entry
    const evDenied = await repo.reserveEvidence({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      target_kind: "ENTRY",
      target_id: prj2EntryId,
      mime_type: "image/png",
      size_bytes: 2048,
      checksum_sha256: sampleChecksum,
      idempotency_key: nextUuid(),
      request_fingerprint: computeReserveEvidenceFingerprint({
        target_kind: "ENTRY",
        target_id: prj2EntryId,
        mime_type: "image/png",
        size_bytes: 2048,
        checksum_sha256: sampleChecksum,
      }),
    });
    assert.ok(!evDenied.ok, "ACCT_A must be denied evidence reservation on PRJ_2");
    assert.ok(
      evDenied.code === "VENDOR_FINANCE_ENTRY_NOT_FOUND" ||
        evDenied.code === "VENDOR_FINANCE_PROJECT_ACCESS_DENIED",
      `Unexpected denial code: ${evDenied.code}`,
    );

    // CASH_HOLDER_BEHALF reserves & finalizes evidence on PRJ_2 entry; ACCT_B & BoD can download, ACCT_A cannot
    const evReserve = await repo.reserveEvidence({
      auth_subject: CASH_HOLDER_BEHALF.auth,
      app_user_id: CASH_HOLDER_BEHALF.app,
      target_kind: "ENTRY",
      target_id: prj2EntryId,
      mime_type: "image/png",
      size_bytes: 2048,
      checksum_sha256: sampleChecksum,
      idempotency_key: nextUuid(),
      request_fingerprint: computeReserveEvidenceFingerprint({
        target_kind: "ENTRY",
        target_id: prj2EntryId,
        mime_type: "image/png",
        size_bytes: 2048,
        checksum_sha256: sampleChecksum,
      }),
    });
    assert.equal(evReserve.ok, true, JSON.stringify(evReserve));
    const reservedEvidenceId = evReserve.data.reservation.evidence_id;

    const evFinal = await repo.finalizeEvidenceReady({
      auth_subject: CASH_HOLDER_BEHALF.auth,
      app_user_id: CASH_HOLDER_BEHALF.app,
      evidence_id: reservedEvidenceId,
    });
    assert.equal(evFinal.ok, true, JSON.stringify(evFinal));
    assert.equal(evFinal.data.evidence.status, "READY");

    const evDlAcctA = await repo.getEvidenceDownload({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      evidence_id: reservedEvidenceId,
    });
    assert.ok(!evDlAcctA.ok, "ACCT_A must not download PRJ_2 evidence");
    assert.ok(
      evDlAcctA.code === "VENDOR_FINANCE_EVIDENCE_NOT_FOUND" ||
        evDlAcctA.code === "VENDOR_FINANCE_ACCESS_DENIED" ||
        evDlAcctA.code === "VENDOR_FINANCE_PROJECT_ACCESS_DENIED",
      `Unexpected denial code: ${evDlAcctA.code}`,
    );

    for (const allowedReader of [ACCT_B, BOD_RECONCILER]) {
      const evDlOk = await repo.getEvidenceDownload({
        auth_subject: allowedReader.auth,
        app_user_id: allowedReader.app,
        evidence_id: reservedEvidenceId,
      });
      assert.equal(evDlOk.ok, true, JSON.stringify(evDlOk));
      assert.equal(evDlOk.data.checksum_sha256, sampleChecksum);
    }

    // End CASH_HOLDER_VIEW global role via Full Admin -> falls back to PROJECT_SCOPED (0 assigned projects)
    const cashViewRoleRow = adminRolesListData.roles.find(
      (r) => r.account.account_ref === CASH_HOLDER_VIEW.app && r.state === "ACTIVE",
    );
    assert.ok(cashViewRoleRow, "Expected active CASH_HOLDER role row");
    const endGlobalReason = "Kết thúc phân công cầm tiền tạm thời cho nhân sự đối soát";
    const endGlobalData = await callVfinRpc(db, "vendor_finance_end_global_role_admin", {
      p_auth_subject: FULL_ADMIN.auth,
      p_app_user_id: FULL_ADMIN.app,
      p_role_grant_id: cashViewRoleRow.role_grant_id,
      p_expected_version: cashViewRoleRow.version,
      p_valid_to: adminRolesListData.authorization_date,
      p_reason: endGlobalReason,
      p_idempotency_key: nextUuid(),
      p_request_fingerprint: computeEndGlobalRoleFingerprint({
        role_grant_id: cashViewRoleRow.role_grant_id,
        expected_version: cashViewRoleRow.version,
        valid_to: adminRolesListData.authorization_date,
        reason: endGlobalReason,
      }),
    });
    assert.ok(endGlobalData?.role_grant_id);
    const accessCashViewAfterEnd = await repo.getActorAccess({
      auth_subject: CASH_HOLDER_VIEW.auth,
      app_user_id: CASH_HOLDER_VIEW.app,
    });
    assert.equal(accessCashViewAfterEnd.ok, true);
    assert.equal(accessCashViewAfterEnd.data.allowed, false);
    assert.equal(accessCashViewAfterEnd.data.visibility_scope, "NONE");
    assert.equal(accessCashViewAfterEnd.data.reconcile_scope, "NONE");
    assert.equal(accessCashViewAfterEnd.data.can_reconcile, false);

    // Untouched tables remain 100% unchanged after all VFIN-02 governance & ledger operations
    const finalUntouchedSnapshot = await captureUntouchedSnapshot(db);
    assert.deepEqual(
      finalUntouchedSnapshot,
      preVfin02Snapshot,
      "All VFIN-02 governance & ledger mutations must leave untouched tables 100% unchanged",
    );

    // -------------------------------------------------------------------------
    // 11. Forced RLS, Zero Direct Table Grants & Exact 25-RPC Allowlist
    // -------------------------------------------------------------------------
    const { rows: tableSec } = await db.query(
      `select c.relname,
              c.relrowsecurity,
              c.relforcerowsecurity,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policy_count,
              has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as anon_priv,
              has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as auth_priv,
              has_table_privilege('service_role', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as svc_priv
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname like 'vendor_finance_%' and c.relkind = 'r'
        order by c.relname`,
    );
    assert.ok(tableSec.length >= 11, `expected >= 11 vendor_finance_* tables, got ${tableSec.length}`);
    for (const row of tableSec) {
      assert.equal(row.relrowsecurity, true, `${row.relname} must enable RLS`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} must force RLS`);
      assert.equal(row.policy_count, 0, `${row.relname} must have 0 permissive policies`);
      assert.equal(row.anon_priv, false, `${row.relname} anon priv`);
      assert.equal(row.auth_priv, false, `${row.relname} authenticated priv`);
      assert.equal(row.svc_priv, false, `${row.relname} service_role direct table priv`);
    }

    const { rows: rpcAcl } = await db.query(
      `select format('public.%I(%s)', p.proname, oidvectortypes(p.proargtypes)) as sig,
              has_function_privilege('public', p.oid, 'EXECUTE') as pub_exec,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as svc_exec
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname like 'vendor_finance%'
        order by 1`,
    );
    const allowlistSet = new Set(VFIN_03_CONTRACT_TYPE_LEDGERS_RPC_SIGNATURES);
    const grantedSvc = [];
    for (const r of rpcAcl) {
      assert.equal(r.pub_exec, false, `PUBLIC must not execute ${r.sig}`);
      assert.equal(r.anon_exec, false, `anon must not execute ${r.sig}`);
      assert.equal(r.auth_exec, false, `authenticated must not execute ${r.sig}`);
      if (r.svc_exec) {
        grantedSvc.push(r.sig);
      }
    }
    assert.deepEqual(grantedSvc.sort(), [...allowlistSet].sort());
  } finally {
    await db.close();
  }
});

test("(#3) Full VFIN-03 acceptance: contract-type sub-ledgers (SEASONAL vs OFFICIAL), non-netting across contract types, pre-VFIN-03 UNCLASSIFIED preservation, and explicit idempotent legacy classification", async () => {
  const db = new PGlite();
  try {
    await db.exec(AUTH_PROLOGUE);
    const migrations = await loadMigrations();
    const vfin03Idx = migrations.findIndex(
      (m) => m.name === VFIN_03_CONTRACT_TYPE_LEDGERS_MIGRATION_NAME,
    );
    assert.ok(vfin03Idx >= 0, "VFIN-03 migration must exist in supabase/migrations");
    const vfin03Migration = migrations[vfin03Idx];

    // 1. Verify LF/CRLF-deterministic checksum and atomic rollback before applying VFIN-03
    const vfin03Checksum = migrationChecksum(vfin03Migration.sql);
    assert.match(vfin03Checksum, /^[0-9a-f]{64}$/);
    assert.equal(
      migrationChecksum(vfin03Migration.sql.replace(/\n/g, "\r\n")),
      vfin03Checksum,
      "VFIN-03 checksum must be identical across LF and CRLF checkouts",
    );

    for (const m of migrations.slice(0, vfin03Idx)) {
      await db.exec(m.sql);
    }

    const failingVfin03Body = `${migrationSqlForTransaction(vfin03Migration.sql)}\nselect 1 / 0;\n`;
    await assert.rejects(
      async () => {
        await db.exec("begin;");
        try {
          await db.exec(failingVfin03Body);
          await db.exec("commit;");
        } catch (err) {
          await db.exec("rollback;");
          throw err;
        }
      },
      (err) => err.code === "22012",
    );
    const { rows: leakedClassTables } = await db.query(
      `select tablename from pg_tables
        where schemaname = 'public'
          and tablename = 'vendor_finance_subledger_classifications'`,
    );
    assert.equal(leakedClassTables.length, 0, "failed VFIN-03 transaction must roll back cleanly");

    // 2. Seed actors, projects, vendors, and PRE-VFIN-03 project sub-ledger data
    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ('99500000-0000-4000-8000-00000000000f'::uuid, '__system_vendor__', 'System Vendor Internal', true)
       on conflict (code) do nothing`,
    );

    for (const actor of [
      FULL_ADMIN,
      ACCT_A,
      ACCT_B,
      CASH_HOLDER_VIEW,
      CASH_HOLDER_BEHALF,
      BOD_RECONCILER,
      BOD_VIEWER,
    ]) {
      await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
      await db.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
         values ($1::uuid, $2::uuid, true, $3)`,
        [actor.app, actor.auth, actor.name],
      );
    }

    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, 'entry_admin', '2026-01-01', true),
              ($1::uuid, 'recruiter_master_manage', '2026-01-01', true),
              ($1::uuid, 'team_master_manage', '2026-01-01', true),
              ($1::uuid, 'catalog_master_manage', '2026-01-01', true)`,
      [FULL_ADMIN.app],
    );
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current)
       values ($1::uuid, 'all', '2026-01-01', true)`,
      [FULL_ADMIN.app],
    );

    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự Án Miền Bắc (PRJ-1)', true, 1),
              ($2, 'Dự Án Miền Nam (PRJ-2)', true, 1)`,
      [PRJ_1, PRJ_2],
    );

    for (const acct of [ACCT_A, ACCT_B]) {
      const reason = `Bổ nhiệm ${acct.name} vào phòng Kế toán`;
      await db.query(
        `select public.org_department_assign_accounting_member(
           $1::uuid, $2::uuid, $3::uuid, 0, '2026-01-01'::date, $4::text, $5::uuid, $6::text
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
            effective_from: "2026-01-01",
            reason,
          }),
        ],
      );
    }

    for (const [vid, vname] of [
      ["VND_DUAL_CONTRACT", "Công ty Song Hành Thời Vụ & Chính Thức"],
      ["VND_PRE_VFIN03", "Công ty Dữ Liệu Sổ Dự Án Trước VFIN-03"],
      ["VND_PRE_COLLIDE", "Công ty Kiểm Tra Trùng Sổ Đích Khi Phân Loại"],
      ["VND_PRE_BATCH_MIX_A", "Công ty Lô Mở Sổ Cũ Khác Loại HĐ - A"],
      ["VND_PRE_BATCH_MIX_B", "Công ty Lô Mở Sổ Cũ Khác Loại HĐ - B"],
      ["VND_PRE_BATCH_SAME_A", "Công ty Lô Mở Sổ Cũ Cùng Loại HĐ - A"],
      ["VND_PRE_BATCH_SAME_B", "Công ty Lô Mở Sổ Cũ Cùng Loại HĐ - B"],
    ]) {
      await db.query(
        `select public.direct_entry_create_vendor(
           $1::uuid, $2::uuid, 0, $3::text, $4::text, '2026-01-01'::date, 'Tạo NCC VFIN-03', $5::text
         )`,
        [FULL_ADMIN.auth, FULL_ADMIN.app, vid, vname, nextUuid()],
      );
    }

    // Assign ACCT_A -> PRJ_1 and ACCT_B -> PRJ_2, plus global roles before VFIN-03
    for (const [prj, acct] of [
      [PRJ_1, ACCT_A],
      [PRJ_2, ACCT_B],
    ]) {
      const r = `Phân công ${acct.name} phụ trách ${prj}`;
      await db.query(
        `select public.vendor_finance_assign_project_accountant_admin(
           $1::uuid, $2::uuid, $3::text, $4::uuid, 0, '2026-10-01'::date, $5::text, $6::uuid, $7::text
         )`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          prj,
          acct.app,
          r,
          nextUuid(),
          computeAssignProjectAccountantFingerprint({
            project_id: prj,
            accountant_ref: acct.app,
            valid_from: "2026-10-01",
            expected_version: 0,
            reason: r,
          }),
        ],
      );
    }

    for (const [person, roleCode] of [
      [CASH_HOLDER_VIEW, "CASH_HOLDER"],
      [CASH_HOLDER_BEHALF, "CASH_HOLDER_RECORD_BEHALF"],
      [BOD_RECONCILER, "GLOBAL_RECONCILER"],
      [BOD_VIEWER, "GLOBAL_VIEWER"],
    ]) {
      const r = `Gán ${roleCode}`;
      await db.query(
        `select public.vendor_finance_assign_global_role_admin(
           $1::uuid, $2::uuid, $3::uuid, $4::text, 0, '2026-10-01'::date, $5::text, $6::uuid, $7::text
         )`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          person.app,
          roleCode,
          r,
          nextUuid(),
          computeAssignGlobalRoleFingerprint({
            account_ref: person.app,
            role_code: roleCode,
            valid_from: "2026-10-01",
            expected_version: 0,
            reason: r,
          }),
        ],
      );
    }

    // Seed pre-VFIN-03 entries & reconciliation on `(VND_PRE_VFIN03, PRJ_1, ACCT_A)` and `(VND_PRE_COLLIDE, PRJ_1, ACCT_A)`
    await db.query(
      `select public.vendor_finance_record_entry(
         $1::uuid, $2::uuid, 'VND_PRE_VFIN03', $3::text, 'DEBT_RECORDED', '12000000',
         '2026-10-02'::date, 'Công nợ VFIN-02 chưa có loại HĐ đợt 1', $4::uuid, $5::text
       )`,
      [ACCT_A.auth, ACCT_A.app, PRJ_1, nextUuid(), "1".repeat(64)],
    );
    await db.query(
      `select public.vendor_finance_record_entry(
         $1::uuid, $2::uuid, 'VND_PRE_VFIN03', $3::text, 'PAYMENT_RECORDED', '2000000',
         '2026-10-03'::date, 'Thanh toán VFIN-02 chưa có loại HĐ đợt 1', $4::uuid, $5::text
       )`,
      [ACCT_A.auth, ACCT_A.app, PRJ_1, nextUuid(), "2".repeat(64)],
    );
    await db.query(
      `select public.vendor_finance_create_reconciliation(
         $1::uuid, $2::uuid, 'VND_PRE_VFIN03', $3::text, $4::uuid,
         '2026-10-04'::date, '10000000', 'Đối soát VFIN-02 chưa có loại HĐ', $5::uuid, $6::text
       )`,
      [ACCT_A.auth, ACCT_A.app, PRJ_1, ACCT_A.app, nextUuid(), "3".repeat(64)],
    );
    await db.query(
      `select public.vendor_finance_record_entry(
         $1::uuid, $2::uuid, 'VND_PRE_COLLIDE', $3::text, 'DEBT_RECORDED', '5000000',
         '2026-10-02'::date, 'Công nợ VFIN-02 trên VND_PRE_COLLIDE', $4::uuid, $5::text
       )`,
      [ACCT_A.auth, ACCT_A.app, PRJ_1, nextUuid(), "4".repeat(64)],
    );

    // Seed two pre-VFIN-03 multi-vendor opening batches on PRJ_2 (ACCT_B) to test batch contract_type
    // classification when vendors in the same batch are classified into different vs identical contract types
    const { rows: mixedBatchSeed } = await db.query(
      `select public.vendor_finance_apply_opening_batch(
         $1::uuid, $2::uuid, $3::text, '2026-10-01'::date, $4::jsonb,
         'Lô mở đầu kỳ VFIN-02 gồm 2 NCC sẽ phân loại khác loại HĐ', $5::uuid, $6::text
       ) as payload`,
      [
        ACCT_B.auth,
        ACCT_B.app,
        PRJ_2,
        JSON.stringify([
          { vendor_id: "VND_PRE_BATCH_MIX_A", entry_type: "OPENING_PAYABLE", amount_minor: "3000000" },
          { vendor_id: "VND_PRE_BATCH_MIX_B", entry_type: "OPENING_PAYABLE", amount_minor: "4000000" },
        ]),
        nextUuid(),
        "5".repeat(64),
      ],
    );
    const mixedLegacyBatchId = mixedBatchSeed[0].payload.batch.batch_id;

    const { rows: sameBatchSeed } = await db.query(
      `select public.vendor_finance_apply_opening_batch(
         $1::uuid, $2::uuid, $3::text, '2026-10-01'::date, $4::jsonb,
         'Lô mở đầu kỳ VFIN-02 gồm 2 NCC sẽ phân loại cùng loại HĐ', $5::uuid, $6::text
       ) as payload`,
      [
        ACCT_B.auth,
        ACCT_B.app,
        PRJ_2,
        JSON.stringify([
          { vendor_id: "VND_PRE_BATCH_SAME_A", entry_type: "OPENING_PAYABLE", amount_minor: "1500000" },
          { vendor_id: "VND_PRE_BATCH_SAME_B", entry_type: "OPENING_PAYABLE", amount_minor: "2500000" },
        ]),
        nextUuid(),
        "6".repeat(64),
      ],
    );
    const sameLegacyBatchId = sameBatchSeed[0].payload.batch.batch_id;

    const { rows: preVfin03EntriesSnapshot } = await db.query(
      `select entry_id::text as entry_id, vendor_id, vendor_sequence::int as seq, document_no,
              effective_date::text as effective_date, amount_minor::text as amount_minor,
              balance_before_minor::text as before_minor, balance_delta_minor::text as delta_minor,
              balance_after_minor::text as after_minor
         from public.vendor_finance_entries
        where vendor_id = 'VND_PRE_VFIN03'
        order by vendor_sequence asc`,
    );
    assert.equal(preVfin03EntriesSnapshot.length, 2);

    const preVfin03Untouched = await captureUntouchedSnapshot(db);

    // 3. Apply VFIN-03 migration (and any subsequent migrations)
    for (const m of migrations.slice(vfin03Idx)) {
      await db.exec(m.sql);
    }

    const postVfin03Untouched = await captureUntouchedSnapshot(db);
    assert.deepEqual(
      postVfin03Untouched,
      preVfin03Untouched,
      "VFIN-03 migration must have zero drift on untouched tables",
    );

    const repo = createPgliteVfinRepo(db);

    // 4. Verify pre-VFIN-03 rows are preserved as `UNCLASSIFIED` (`Chưa phân loại`)
    //    with zero auto-guessed contract type and 100% intact amounts/dates/document_no!
    const { rows: postMigPreEntries } = await db.query(
      `select entry_id::text as entry_id, vendor_id, contract_type, vendor_sequence::int as seq, document_no,
              effective_date::text as effective_date, amount_minor::text as amount_minor,
              balance_before_minor::text as before_minor, balance_delta_minor::text as delta_minor,
              balance_after_minor::text as after_minor
         from public.vendor_finance_entries
        where vendor_id = 'VND_PRE_VFIN03'
        order by vendor_sequence asc`,
    );
    assert.deepEqual(
      postMigPreEntries.map(({ contract_type, ...rest }) => {
        assert.equal(contract_type, "UNCLASSIFIED");
        return rest;
      }),
      preVfin03EntriesSnapshot,
    );

    // Verify `UNCLASSIFIED` sub-ledger is visible in `listVendors`, `getVendor`, and `getMonthlyReport`
    const unclassifiedList = await repo.listVendors({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      search: "VND_PRE_VFIN03",
      active: "all",
      balance_filter: "all",
      project_id: PRJ_1,
      accountant_ref: null,
      ledger_scope: "all",
      contract_type: "UNCLASSIFIED",
      page: 1,
      page_size: 25,
    });
    assert.equal(unclassifiedList.ok, true, JSON.stringify(unclassifiedList));
    assert.equal(unclassifiedList.data.vendors.length, 1);
    assert.equal(unclassifiedList.data.vendors[0].current_balance_minor, "10000000");
    assert.equal(unclassifiedList.data.vendors[0].sub_ledgers[0].contract_type, "UNCLASSIFIED");

    const unclassifiedDetail = await repo.getVendor({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_PRE_VFIN03",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      ledger_scope: "PROJECT_ACCOUNTANT",
      contract_type: "UNCLASSIFIED",
    });
    assert.equal(unclassifiedDetail.ok, true, JSON.stringify(unclassifiedDetail));
    assert.equal(unclassifiedDetail.data.selected_sub_ledger?.contract_type, "UNCLASSIFIED");
    assert.equal(unclassifiedDetail.data.selected_sub_ledger?.can_classify_contract_type, true);
    assert.equal(unclassifiedDetail.data.selected_sub_ledger?.classification, null);

    // 5. Independent `SEASONAL` (Thời vụ) and `OFFICIAL` (Chính thức) sub-ledgers on the same
    //    `(VND_DUAL_CONTRACT, PRJ_1, ACCT_A)` — zero cross-netting!
    const seasonalOpenItems = [
      { vendor_id: "VND_DUAL_CONTRACT", entry_type: "OPENING_PAYABLE", amount_minor: "8000000" },
    ];
    const seasonalOpenReason = "Khởi tạo đầu kỳ sổ Thời vụ cho VND_DUAL_CONTRACT trên PRJ_1";
    const applySeasonalOpen = await repo.applyOpeningBatch({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      project_id: PRJ_1,
      contract_type: "SEASONAL",
      cutoff_date: "2026-10-01",
      items: seasonalOpenItems,
      reason: seasonalOpenReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeApplyOpeningBatchFingerprint({
        project_id: PRJ_1,
        contract_type: "SEASONAL",
        cutoff_date: "2026-10-01",
        items: seasonalOpenItems,
        reason: seasonalOpenReason,
      }),
    });
    assert.equal(applySeasonalOpen.ok, true, JSON.stringify(applySeasonalOpen));
    assert.equal(applySeasonalOpen.data.batch.contract_type, "SEASONAL");

    // Re-initializing SEASONAL on the same `(VND_DUAL_CONTRACT, PRJ_1)` MUST fail
    const dupSeasonalReason = "Thử khởi tạo đầu kỳ lần 2 trên cùng sổ Thời vụ";
    const dupSeasonalOpen = await repo.applyOpeningBatch({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      project_id: PRJ_1,
      contract_type: "SEASONAL",
      cutoff_date: "2026-10-01",
      items: seasonalOpenItems,
      reason: dupSeasonalReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeApplyOpeningBatchFingerprint({
        project_id: PRJ_1,
        contract_type: "SEASONAL",
        cutoff_date: "2026-10-01",
        items: seasonalOpenItems,
        reason: dupSeasonalReason,
      }),
    });
    assert.equal(dupSeasonalOpen.ok, false);
    assert.equal(dupSeasonalOpen.code, "VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED");

    // Initializing `OFFICIAL` on the SAME `(VND_DUAL_CONTRACT, PRJ_1)` succeeds independently!
    const officialOpenItems = [
      { vendor_id: "VND_DUAL_CONTRACT", entry_type: "OPENING_ADVANCE", amount_minor: "3000000" },
    ];
    const officialOpenReason = "Khởi tạo dư ứng đầu kỳ sổ Chính thức cho VND_DUAL_CONTRACT trên PRJ_1";
    const applyOfficialOpen = await repo.applyOpeningBatch({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      cutoff_date: "2026-10-01",
      items: officialOpenItems,
      reason: officialOpenReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeApplyOpeningBatchFingerprint({
        project_id: PRJ_1,
        contract_type: "OFFICIAL",
        cutoff_date: "2026-10-01",
        items: officialOpenItems,
        reason: officialOpenReason,
      }),
    });
    assert.equal(applyOfficialOpen.ok, true, JSON.stringify(applyOfficialOpen));
    assert.equal(applyOfficialOpen.data.batch.contract_type, "OFFICIAL");

    // Record normal entries on SEASONAL (+4,000,000 -> +12,000,000, seq 2) and OFFICIAL (+1,000,000 -> -2,000,000, seq 2)
    const seasonalRecReason = "Bảng lương công nhân thời vụ đợt 1 tháng 10";
    const seasonalRec = await repo.recordEntry({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_DUAL_CONTRACT",
      project_id: PRJ_1,
      contract_type: "SEASONAL",
      entry_type: "PAYROLL_RECORDED",
      amount_minor: "4000000",
      effective_date: "2026-10-06",
      reason: seasonalRecReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_1,
        vendor_id: "VND_DUAL_CONTRACT",
        contract_type: "SEASONAL",
        entry_type: "PAYROLL_RECORDED",
        amount_minor: "4000000",
        effective_date: "2026-10-06",
        reason: seasonalRecReason,
      }),
    });
    assert.equal(seasonalRec.ok, true, JSON.stringify(seasonalRec));
    assert.equal(seasonalRec.data.entry.contract_type, "SEASONAL");
    assert.equal(seasonalRec.data.entry.vendor_sequence, 2);
    assert.equal(seasonalRec.data.entry.balance_after_minor, "12000000");

    const officialRecReason = "Phí tuyển dụng nhân sự chính thức đợt 1 tháng 10";
    const officialRec = await repo.recordEntry({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_DUAL_CONTRACT",
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "1000000",
      effective_date: "2026-10-06",
      reason: officialRecReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_1,
        vendor_id: "VND_DUAL_CONTRACT",
        contract_type: "OFFICIAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "1000000",
        effective_date: "2026-10-06",
        reason: officialRecReason,
      }),
    });
    assert.equal(officialRec.ok, true, JSON.stringify(officialRec));
    assert.equal(officialRec.data.entry.contract_type, "OFFICIAL");
    assert.equal(officialRec.data.entry.vendor_sequence, 2);
    assert.equal(officialRec.data.entry.balance_after_minor, "-2000000");

    // Verify ZERO cross-netting between SEASONAL (+12M) and OFFICIAL (-2M) on the SAME Project & Vendor!
    const dualList = await repo.listVendors({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      search: "VND_DUAL_CONTRACT",
      active: "all",
      balance_filter: "all",
      project_id: PRJ_1,
      accountant_ref: null,
      ledger_scope: "all",
      contract_type: "all",
      page: 1,
      page_size: 25,
    });
    assert.equal(dualList.ok, true, JSON.stringify(dualList));
    const dualItem = dualList.data.vendors.find((v) => v.vendor_id === "VND_DUAL_CONTRACT");
    assert.ok(dualItem);
    assert.equal(dualItem.balance_direction, "MULTI_LEDGER");
    assert.equal(dualItem.current_balance_minor, "0", "MUST NOT net +12M SEASONAL and -2M OFFICIAL into +10M");
    assert.equal(dualItem.payable_total_minor, "12000000");
    assert.equal(dualItem.advance_total_minor, "2000000");
    assert.equal(dualItem.sub_ledgers.length, 2);

    // Filtering by `contract_type: "SEASONAL"` isolates the SEASONAL sub-ledger (+12M)
    const seasonalOnlyList = await repo.listVendors({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      search: "VND_DUAL_CONTRACT",
      active: "all",
      balance_filter: "all",
      project_id: PRJ_1,
      accountant_ref: null,
      ledger_scope: "all",
      contract_type: "SEASONAL",
      page: 1,
      page_size: 25,
    });
    assert.equal(seasonalOnlyList.ok, true);
    assert.equal(seasonalOnlyList.data.vendors[0].balance_direction, "PAYABLE");
    assert.equal(seasonalOnlyList.data.vendors[0].current_balance_minor, "12000000");
    assert.equal(seasonalOnlyList.data.vendors[0].sub_ledgers.length, 1);
    assert.equal(seasonalOnlyList.data.vendors[0].sub_ledgers[0].contract_type, "SEASONAL");

    // Reconciliations on SEASONAL vs OFFICIAL compute independent system balances
    const reconSeasonalReason = "Đối soát sổ Thời vụ của VND_DUAL_CONTRACT";
    const reconSeasonal = await repo.createReconciliation({
      auth_subject: BOD_RECONCILER.auth,
      app_user_id: BOD_RECONCILER.app,
      vendor_id: "VND_DUAL_CONTRACT",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      contract_type: "SEASONAL",
      as_of_date: "2026-10-10",
      confirmed_balance_minor: "12000000",
      reason: reconSeasonalReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeCreateReconciliationFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_A.app,
        vendor_id: "VND_DUAL_CONTRACT",
        contract_type: "SEASONAL",
        as_of_date: "2026-10-10",
        confirmed_balance_minor: "12000000",
        reason: reconSeasonalReason,
      }),
    });
    assert.equal(reconSeasonal.ok, true, JSON.stringify(reconSeasonal));
    assert.equal(reconSeasonal.data.reconciliation.contract_type, "SEASONAL");
    assert.equal(reconSeasonal.data.reconciliation.system_balance_minor, "12000000");
    assert.equal(reconSeasonal.data.reconciliation.difference_minor, "0");

    const reconOfficialReason = "Đối soát sổ Chính thức của VND_DUAL_CONTRACT";
    const reconOfficial = await repo.createReconciliation({
      auth_subject: BOD_RECONCILER.auth,
      app_user_id: BOD_RECONCILER.app,
      vendor_id: "VND_DUAL_CONTRACT",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      contract_type: "OFFICIAL",
      as_of_date: "2026-10-10",
      confirmed_balance_minor: "-2000000",
      reason: reconOfficialReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeCreateReconciliationFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_A.app,
        vendor_id: "VND_DUAL_CONTRACT",
        contract_type: "OFFICIAL",
        as_of_date: "2026-10-10",
        confirmed_balance_minor: "-2000000",
        reason: reconOfficialReason,
      }),
    });
    assert.equal(reconOfficial.ok, true, JSON.stringify(reconOfficial));
    assert.equal(reconOfficial.data.reconciliation.contract_type, "OFFICIAL");
    assert.equal(reconOfficial.data.reconciliation.system_balance_minor, "-2000000");
    assert.equal(reconOfficial.data.reconciliation.difference_minor, "0");

    // Reversal on SEASONAL entry automatically inherits `contract_type = "SEASONAL"`
    const seasonalAdjReason = "Điều chỉnh tăng tạm sổ Thời vụ";
    const seasonalAdj = await repo.recordEntry({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_DUAL_CONTRACT",
      project_id: PRJ_1,
      contract_type: "SEASONAL",
      entry_type: "ADJUSTMENT_INCREASE",
      amount_minor: "500000",
      effective_date: "2026-10-11",
      reason: seasonalAdjReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_1,
        vendor_id: "VND_DUAL_CONTRACT",
        contract_type: "SEASONAL",
        entry_type: "ADJUSTMENT_INCREASE",
        amount_minor: "500000",
        effective_date: "2026-10-11",
        reason: seasonalAdjReason,
      }),
    });
    assert.equal(seasonalAdj.ok, true);
    assert.equal(seasonalAdj.data.entry.balance_after_minor, "12500000");

    const seasonalRevReason = "Hoàn tác điều chỉnh sổ Thời vụ (kế thừa cố định loại HĐ)";
    const seasonalRev = await repo.reverseEntry({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      entry_id: seasonalAdj.data.entry.entry_id,
      effective_date: "2026-10-11",
      reason: seasonalRevReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeReverseEntryFingerprint({
        entry_id: seasonalAdj.data.entry.entry_id,
        effective_date: "2026-10-11",
        reason: seasonalRevReason,
      }),
    });
    assert.equal(seasonalRev.ok, true, JSON.stringify(seasonalRev));
    assert.equal(seasonalRev.data.reversal_entry.contract_type, "SEASONAL");
    assert.equal(seasonalRev.data.reversal_entry.project_id, PRJ_1);
    assert.equal(seasonalRev.data.reversal_entry.accountant_ref, ACCT_A.app);
    assert.equal(seasonalRev.data.reversal_entry.balance_after_minor, "12000000");

    // 6. Explicit Legacy Sub-Ledger Classification (`UNCLASSIFIED -> SEASONAL | OFFICIAL`)
    // 6a. Unauthorized actors (`ACCT_B` on `PRJ_1`, `BOD_VIEWER`, `BOD_RECONCILER`) are rejected
    const unauthClassReason = "Kế toán B thử phân loại sổ của Kế toán A";
    const unauthClassB = await repo.classifyUnclassifiedSubLedger({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      vendor_id: "VND_PRE_VFIN03",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      target_contract_type: "SEASONAL",
      reason: unauthClassReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeClassifySubLedgerFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_A.app,
        vendor_id: "VND_PRE_VFIN03",
        target_contract_type: "SEASONAL",
        reason: unauthClassReason,
      }),
    });
    assert.equal(unauthClassB.ok, false);
    assert.equal(unauthClassB.code, "VENDOR_FINANCE_PROJECT_ACCESS_DENIED");

    const unauthClassBod = await repo.classifyUnclassifiedSubLedger({
      auth_subject: BOD_RECONCILER.auth,
      app_user_id: BOD_RECONCILER.app,
      vendor_id: "VND_PRE_VFIN03",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      target_contract_type: "SEASONAL",
      reason: unauthClassReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeClassifySubLedgerFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_A.app,
        vendor_id: "VND_PRE_VFIN03",
        target_contract_type: "SEASONAL",
        reason: unauthClassReason,
      }),
    });
    assert.equal(unauthClassBod.ok, false);
    assert.equal(unauthClassBod.code, "VENDOR_FINANCE_RECORD_DENIED");

    // 6b. Responsible accountant ACCT_A classifies `(VND_PRE_VFIN03, PRJ_1, ACCT_A)` -> `SEASONAL`
    const classifyKey = nextUuid();
    const classifyReason = "Xác nhận hồ sơ hợp đồng cung ứng lao động thời vụ đợt 1 trên PRJ_1";
    const classifyFp = computeClassifySubLedgerFingerprint({
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      vendor_id: "VND_PRE_VFIN03",
      target_contract_type: "SEASONAL",
      reason: classifyReason,
    });
    const classifyRes = await repo.classifyUnclassifiedSubLedger({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_PRE_VFIN03",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      target_contract_type: "SEASONAL",
      reason: classifyReason,
      idempotency_key: classifyKey,
      request_fingerprint: classifyFp,
    });
    assert.equal(classifyRes.ok, true, JSON.stringify(classifyRes));
    assert.equal(classifyRes.data.replayed, false);
    assert.equal(classifyRes.data.classification.source_contract_type, "UNCLASSIFIED");
    assert.equal(classifyRes.data.classification.target_contract_type, "SEASONAL");
    assert.equal(classifyRes.data.classification.classified_entry_count, 2);
    assert.equal(classifyRes.data.classification.classified_reconciliation_count, 1);
    assert.equal(classifyRes.data.classification.closing_balance_minor, "10000000");
    assert.equal(classifyRes.data.classification.classified_by_display_name, ACCT_A.name);

    // Verify all entries of `VND_PRE_VFIN03` are now `SEASONAL` with 100% identical amounts, dates, document_no, and sequences!
    const { rows: postClassEntries } = await db.query(
      `select entry_id::text as entry_id, vendor_id, contract_type, vendor_sequence::int as seq, document_no,
              effective_date::text as effective_date, amount_minor::text as amount_minor,
              balance_before_minor::text as before_minor, balance_delta_minor::text as delta_minor,
              balance_after_minor::text as after_minor
         from public.vendor_finance_entries
        where vendor_id = 'VND_PRE_VFIN03'
        order by vendor_sequence asc`,
    );
    assert.deepEqual(
      postClassEntries.map(({ contract_type, ...rest }) => {
        assert.equal(contract_type, "SEASONAL");
        return rest;
      }),
      preVfin03EntriesSnapshot,
      "Classification must preserve exact amounts, effective_date, document_no, and sequence history",
    );

    // Verify idempotent replay with the same key & fingerprint returns `replayed: true`
    const classifyReplay = await repo.classifyUnclassifiedSubLedger({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_PRE_VFIN03",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      target_contract_type: "SEASONAL",
      reason: classifyReason,
      idempotency_key: classifyKey,
      request_fingerprint: classifyFp,
    });
    assert.equal(classifyReplay.ok, true, JSON.stringify(classifyReplay));
    assert.equal(classifyReplay.data.replayed, true);
    assert.deepEqual(classifyReplay.data.classification, classifyRes.data.classification);

    // Verify reusing the same idempotency key with a different payload fails with `VENDOR_FINANCE_IDEMPOTENCY_CONFLICT`
    const conflictReason = "Thử đổi sang OFFICIAL nhưng dùng lại idempotency_key";
    const classifyIdemConflict = await repo.classifyUnclassifiedSubLedger({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_PRE_VFIN03",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      target_contract_type: "OFFICIAL",
      reason: conflictReason,
      idempotency_key: classifyKey,
      request_fingerprint: computeClassifySubLedgerFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_A.app,
        vendor_id: "VND_PRE_VFIN03",
        target_contract_type: "OFFICIAL",
        reason: conflictReason,
      }),
    });
    assert.equal(classifyIdemConflict.ok, false);
    assert.equal(classifyIdemConflict.code, "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT");

    // Verify duplicate classification with a new idempotency key is rejected (`VENDOR_FINANCE_CONTRACT_TYPE_ALREADY_CLASSIFIED`)
    const reclassifyReason = "Thử phân loại lại sổ đã phân loại";
    const reclassifyAttempt = await repo.classifyUnclassifiedSubLedger({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_PRE_VFIN03",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      target_contract_type: "OFFICIAL",
      reason: reclassifyReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeClassifySubLedgerFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_A.app,
        vendor_id: "VND_PRE_VFIN03",
        target_contract_type: "OFFICIAL",
        reason: reclassifyReason,
      }),
    });
    assert.equal(reclassifyAttempt.ok, false);
    assert.equal(reclassifyAttempt.code, "VENDOR_FINANCE_CONTRACT_TYPE_ALREADY_CLASSIFIED");

    // Verify `getVendor` exposes the classification audit trail on the classified `SEASONAL` sub-ledger
    const classifiedVendorDetail = await repo.getVendor({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_PRE_VFIN03",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      ledger_scope: "PROJECT_ACCOUNTANT",
      contract_type: "SEASONAL",
    });
    assert.equal(classifiedVendorDetail.ok, true, JSON.stringify(classifiedVendorDetail));
    assert.equal(classifiedVendorDetail.data.selected_sub_ledger?.contract_type, "SEASONAL");
    assert.equal(classifiedVendorDetail.data.selected_sub_ledger?.can_classify_contract_type, false);
    assert.equal(
      classifiedVendorDetail.data.selected_sub_ledger?.classification?.target_contract_type,
      "SEASONAL",
    );
    assert.equal(
      classifiedVendorDetail.data.selected_sub_ledger?.classification?.classified_by_display_name,
      ACCT_A.name,
    );

    // 6c. Collision protection (`VENDOR_FINANCE_CONTRACT_TYPE_TARGET_NOT_EMPTY`):
    // Record a new `OFFICIAL` entry on `VND_PRE_COLLIDE`, then attempt to classify its `UNCLASSIFIED` sub-ledger -> `OFFICIAL`
    const collideNewReason = "Bút toán mới trên sổ Chính thức của VND_PRE_COLLIDE";
    const collideNewEntry = await repo.recordEntry({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_PRE_COLLIDE",
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "1000000",
      effective_date: "2026-10-07",
      reason: collideNewReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        project_id: PRJ_1,
        vendor_id: "VND_PRE_COLLIDE",
        contract_type: "OFFICIAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "1000000",
        effective_date: "2026-10-07",
        reason: collideNewReason,
      }),
    });
    assert.equal(collideNewEntry.ok, true);

    const collideAttemptReason = "Thử gộp sổ UNCLASSIFIED vào sổ OFFICIAL đã có bút toán";
    const collideAttempt = await repo.classifyUnclassifiedSubLedger({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      vendor_id: "VND_PRE_COLLIDE",
      project_id: PRJ_1,
      accountant_ref: ACCT_A.app,
      target_contract_type: "OFFICIAL",
      reason: collideAttemptReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeClassifySubLedgerFingerprint({
        project_id: PRJ_1,
        accountant_ref: ACCT_A.app,
        vendor_id: "VND_PRE_COLLIDE",
        target_contract_type: "OFFICIAL",
        reason: collideAttemptReason,
      }),
    });
    assert.equal(collideAttempt.ok, false);
    assert.equal(collideAttempt.code, "VENDOR_FINANCE_CONTRACT_TYPE_TARGET_NOT_EMPTY");

    // Meanwhile `VND_PRE_COLLIDE`'s `UNCLASSIFIED` sub-ledger remains intact (`5,000,000`) and visible in Monthly Report!
    const monthlySeasonal = await repo.getMonthlyReport({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      month: "2026-10",
      project_id: PRJ_1,
      accountant_ref: null,
      vendor_id: null,
      contract_type: "SEASONAL",
    });
    assert.equal(monthlySeasonal.ok, true, JSON.stringify(monthlySeasonal));
    assert.deepEqual(
      monthlySeasonal.data.rows.map((r) => `${r.vendor_id}:${r.contract_type}:${r.closing_balance_minor}`).sort(),
      ["VND_DUAL_CONTRACT:SEASONAL:12000000", "VND_PRE_VFIN03:SEASONAL:10000000"],
    );

    const monthlyUnclassified = await repo.getMonthlyReport({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      month: "2026-10",
      project_id: PRJ_1,
      accountant_ref: null,
      vendor_id: null,
      contract_type: "UNCLASSIFIED",
    });
    assert.equal(monthlyUnclassified.ok, true, JSON.stringify(monthlyUnclassified));
    assert.deepEqual(
      monthlyUnclassified.data.rows.map((r) => `${r.vendor_id}:${r.contract_type}:${r.closing_balance_minor}`),
      ["VND_PRE_COLLIDE:UNCLASSIFIED:5000000"],
    );

    // 6d. Multi-vendor legacy opening batch metadata regression:
    // - When a pre-VFIN-03 opening batch contains 2 vendors classified into DIFFERENT contract types
    //   (`VND_PRE_BATCH_MIX_A -> SEASONAL`, `VND_PRE_BATCH_MIX_B -> OFFICIAL`), the batch row in
    //   `vendor_finance_opening_batches` MUST remain `UNCLASSIFIED` (never falsely labeled `OFFICIAL`).
    // - When all vendors in a pre-VFIN-03 opening batch are classified into the SAME contract type
    //   (`VND_PRE_BATCH_SAME_A -> SEASONAL`, `VND_PRE_BATCH_SAME_B -> SEASONAL`), the batch row transitions
    //   to `SEASONAL` only after every entry in the batch has `contract_type = 'SEASONAL'`.
    for (const [vid, targetType] of [
      ["VND_PRE_BATCH_MIX_A", "SEASONAL"],
      ["VND_PRE_BATCH_MIX_B", "OFFICIAL"],
    ]) {
      const r = `Phân loại ${vid} sang ${targetType} trên PRJ_2`;
      const res = await repo.classifyUnclassifiedSubLedger({
        auth_subject: ACCT_B.auth,
        app_user_id: ACCT_B.app,
        vendor_id: vid,
        project_id: PRJ_2,
        accountant_ref: ACCT_B.app,
        target_contract_type: targetType,
        reason: r,
        idempotency_key: nextUuid(),
        request_fingerprint: computeClassifySubLedgerFingerprint({
          project_id: PRJ_2,
          accountant_ref: ACCT_B.app,
          vendor_id: vid,
          target_contract_type: targetType,
          reason: r,
        }),
      });
      assert.equal(res.ok, true, JSON.stringify(res));
    }

    const { rows: mixedBatchRow } = await db.query(
      `select contract_type from public.vendor_finance_opening_batches where batch_id = $1::uuid`,
      [mixedLegacyBatchId],
    );
    assert.equal(
      mixedBatchRow[0].contract_type,
      "UNCLASSIFIED",
      "Mixed-contract-type legacy opening batch must remain UNCLASSIFIED instead of taking the last vendor's target contract type",
    );
    const { rows: mixedBatchEntries } = await db.query(
      `select vendor_id, contract_type
         from public.vendor_finance_entries
        where opening_batch_id = $1::uuid
        order by vendor_id asc`,
      [mixedLegacyBatchId],
    );
    assert.deepEqual(mixedBatchEntries, [
      { vendor_id: "VND_PRE_BATCH_MIX_A", contract_type: "SEASONAL" },
      { vendor_id: "VND_PRE_BATCH_MIX_B", contract_type: "OFFICIAL" },
    ]);

    const sameReasonA = "Phân loại VND_PRE_BATCH_SAME_A sang SEASONAL trên PRJ_2";
    const sameResA = await repo.classifyUnclassifiedSubLedger({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      vendor_id: "VND_PRE_BATCH_SAME_A",
      project_id: PRJ_2,
      accountant_ref: ACCT_B.app,
      target_contract_type: "SEASONAL",
      reason: sameReasonA,
      idempotency_key: nextUuid(),
      request_fingerprint: computeClassifySubLedgerFingerprint({
        project_id: PRJ_2,
        accountant_ref: ACCT_B.app,
        vendor_id: "VND_PRE_BATCH_SAME_A",
        target_contract_type: "SEASONAL",
        reason: sameReasonA,
      }),
    });
    assert.equal(sameResA.ok, true, JSON.stringify(sameResA));

    const { rows: sameBatchAfterFirst } = await db.query(
      `select contract_type from public.vendor_finance_opening_batches where batch_id = $1::uuid`,
      [sameLegacyBatchId],
    );
    assert.equal(sameBatchAfterFirst[0].contract_type, "UNCLASSIFIED");

    const sameReasonB = "Phân loại VND_PRE_BATCH_SAME_B sang SEASONAL trên PRJ_2";
    const sameResB = await repo.classifyUnclassifiedSubLedger({
      auth_subject: ACCT_B.auth,
      app_user_id: ACCT_B.app,
      vendor_id: "VND_PRE_BATCH_SAME_B",
      project_id: PRJ_2,
      accountant_ref: ACCT_B.app,
      target_contract_type: "SEASONAL",
      reason: sameReasonB,
      idempotency_key: nextUuid(),
      request_fingerprint: computeClassifySubLedgerFingerprint({
        project_id: PRJ_2,
        accountant_ref: ACCT_B.app,
        vendor_id: "VND_PRE_BATCH_SAME_B",
        target_contract_type: "SEASONAL",
        reason: sameReasonB,
      }),
    });
    assert.equal(sameResB.ok, true, JSON.stringify(sameResB));

    const { rows: sameBatchAfterSecond } = await db.query(
      `select contract_type from public.vendor_finance_opening_batches where batch_id = $1::uuid`,
      [sameLegacyBatchId],
    );
    assert.equal(
      sameBatchAfterSecond[0].contract_type,
      "SEASONAL",
      "Homogeneous legacy opening batch must update to SEASONAL once all entries in the batch are SEASONAL",
    );
  } finally {
    await db.close();
  }
});

test("(#4) Monthly Debt Report obligations_in_month_minor reconciliation: active in-month obligations (> 0), valid business zero (0), and PROJECT_SCOPED accountant authority", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );
    const allNames = (await readdir(MIGRATION_DIR))
      .filter((n) => n.endsWith(".sql"))
      .sort();
    for (const name of allNames) {
      await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
    }

    const repo = createPgliteVfinRepo(db);

    await db.query(
      `insert into public.teams (team_id, code, display_name, active)
       values ('99500000-0000-4000-8000-00000000000f'::uuid, '__system_vendor__', 'System Vendor Internal', true)
       on conflict (code) do nothing`,
    );

    for (const actor of [
      { ...FULL_ADMIN, email: "fulladmin.m4@hrpartner.vn" },
      { ...ACCT_A, email: "accta.m4@hrpartner.vn" },
      { ...ACCT_B, email: "acctb.m4@hrpartner.vn" },
      { ...BOD_VIEWER, email: "bodviewer.m4@hrpartner.vn" },
    ]) {
      await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
        actor.auth,
        actor.email,
      ]);
      await db.query(
        `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
         values ($1::uuid, $2::uuid, true, $3)`,
        [actor.app, actor.auth, actor.name],
      );
    }

    // Grant FULL_ADMIN via canonical SYSTEM_ADMIN permission group
    const {
      rows: [sysAdminGrp],
    } = await db.query(
      `select group_id::text as id from public.authz_user_groups where code = 'SYSTEM_ADMIN' limit 1`,
    );
    assert.ok(sysAdminGrp?.id, "SYSTEM_ADMIN group must exist");
    await db.query(
      `insert into public.authz_user_group_members (group_id, app_user_id, source_kind, reason, assigned_by_app_user_id)
       values ($1::uuid, $2::uuid, 'ADMIN_ASSIGNMENT', 'Seed FULL_ADMIN for monthly report test', $2::uuid)`,
      [sysAdminGrp.id, FULL_ADMIN.app],
    );

    // Grant BOD_VIEWER via a canonical group with vendor_finance/GLOBAL_VIEWER module role
    const {
      rows: [bodDept],
    } = await db.query(
      `select department_id::text as id from public.organization_departments where system_key = 'MANAGEMENT_BOD' limit 1`,
    );
    const {
      rows: [acctDept],
    } = await db.query(
      `select department_id::text as id from public.organization_departments where system_key = 'ACCOUNTING' limit 1`,
    );
    assert.ok(bodDept?.id && acctDept?.id);

    const {
      rows: [bodViewerGrp],
    } = await db.query(
      `insert into public.authz_user_groups (code, name, description, department_id, team_id, is_system_admin, active)
       values ('TEST_BOD_VFIN_VIEWER', 'BoD Viewer Test', 'Test group for monthly report', $1::uuid, null, false, true)
       returning group_id::text as id`,
      [bodDept.id],
    );
    await db.query(
      `insert into public.authz_user_group_module_roles (group_id, module_code, role_code, reason, granted_by_app_user_id)
       values ($1::uuid, 'vendor_finance', 'GLOBAL_VIEWER', 'Seed GLOBAL_VIEWER for test', $2::uuid)`,
      [bodViewerGrp.id, FULL_ADMIN.app],
    );
    await db.query(
      `insert into public.authz_user_group_members (group_id, app_user_id, source_kind, reason, assigned_by_app_user_id)
       values ($1::uuid, $2::uuid, 'ADMIN_ASSIGNMENT', 'Assign BOD_VIEWER', $3::uuid)`,
      [bodViewerGrp.id, BOD_VIEWER.app, FULL_ADMIN.app],
    );

    // Seed ACCT_A and ACCT_B as active ACCOUNTING department persons
    for (const [idx, acct] of [ACCT_A, ACCT_B].entries()) {
      const {
        rows: [uRow],
      } = await db.query(
        `select version from public.direct_entry_app_users where app_user_id = $1::uuid`,
        [acct.app],
      );
      const createKey = nextUuid();
      await db.query(
        `select public.org_department_create_person_admin(
           $1::uuid, $2::uuid, $3::text, $4::text, '2026-01-01'::date,
           $5::uuid, $6::uuid, $7::integer, null::uuid, 'Seed accounting person', $8::uuid, $9::text
         )`,
        [
          FULL_ADMIN.auth,
          FULL_ADMIN.app,
          `M4-ACC-${idx + 1}`,
          acct.name,
          acctDept.id,
          acct.app,
          uRow.version,
          createKey,
          "a".repeat(64),
        ],
      );
    }

    // Seed projects and vendors
    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự Án Miền Bắc (PRJ-1)', true, 1),
              ($2, 'Dự Án Miền Nam (PRJ-2)', true, 1)`,
      [PRJ_1, PRJ_2],
    );

    for (const [vid, vname] of [
      ["VND_M4_ALPHA", "Công ty Alpha Phát Sinh"],
      ["VND_M4_BETA", "Công ty Beta Điều Chỉnh"],
      ["VND_M4_GAMMA", "Công ty Gamma Đầu Kỳ & Thanh Toán"],
      ["VND_M4_DELTA", "Công ty Delta Kỳ 10 Không Phát Sinh"],
    ]) {
      await db.query(
        `select public.direct_entry_create_vendor(
           $1::uuid, $2::uuid, 0, $3::text, $4::text, '2026-01-01'::date, 'Tạo NCC test M4', $5::text
         )`,
        [FULL_ADMIN.auth, FULL_ADMIN.app, vid, vname, nextUuid()],
      );
    }

    const adminAccess = await repo.getActorAccess({
      auth_subject: FULL_ADMIN.auth,
      app_user_id: FULL_ADMIN.app,
    });
    assert.equal(adminAccess.ok, true);
    const todayDate = adminAccess.data.authorization_date;

    for (const [prj, acct] of [
      [PRJ_1, ACCT_A],
      [PRJ_2, ACCT_B],
    ]) {
      const reason = `Phân công ${acct.name} phụ trách ${prj}`;
      const assignRes = await repo.assignProjectAccountantAdmin({
        auth_subject: FULL_ADMIN.auth,
        app_user_id: FULL_ADMIN.app,
        project_id: prj,
        accountant_ref: acct.app,
        expected_version: 0,
        valid_from: todayDate,
        reason,
        idempotency_key: nextUuid(),
        request_fingerprint: computeAssignProjectAccountantFingerprint({
          project_id: prj,
          accountant_ref: acct.app,
          valid_from: todayDate,
          expected_version: 0,
          reason,
        }),
      });
      assert.equal(assignRes.ok, true, JSON.stringify(assignRes));
    }

    const recordM4 = async (actor, payload) => {
      const res = await repo.recordEntry({
        auth_subject: actor.auth,
        app_user_id: actor.app,
        ...payload,
        idempotency_key: nextUuid(),
        request_fingerprint: computeRecordEntryFingerprint(payload),
      });
      assert.equal(res.ok, true, JSON.stringify(res));
      return res.data.entry;
    };

    const reverseM4 = async (actor, entryId, effectiveDate, reason) => {
      const res = await repo.reverseEntry({
        auth_subject: actor.auth,
        app_user_id: actor.app,
        entry_id: entryId,
        effective_date: effectiveDate,
        reason,
        idempotency_key: nextUuid(),
        request_fingerprint: computeReverseEntryFingerprint({
          entry_id: entryId,
          effective_date: effectiveDate,
          reason,
        }),
      });
      assert.equal(res.ok, true, JSON.stringify(res));
      return res.data.reversal_entry;
    };

    const applyOpeningM4 = async (actor, projectId, contractType, cutoffDate, items, reason) => {
      const res = await repo.applyOpeningBatch({
        auth_subject: actor.auth,
        app_user_id: actor.app,
        project_id: projectId,
        contract_type: contractType,
        cutoff_date: cutoffDate,
        items,
        reason,
        idempotency_key: nextUuid(),
        request_fingerprint: computeApplyOpeningBatchFingerprint({
          project_id: projectId,
          contract_type: contractType,
          cutoff_date: cutoffDate,
          items,
          reason,
        }),
      });
      assert.equal(res.ok, true, JSON.stringify(res));
      return res.data;
    };

    // -------------------------------------------------------------------------
    // Seed entries for Case A (month 2026-11) & Case B (2026-10 and VND_M4_GAMMA)
    // -------------------------------------------------------------------------
    // 1) VND_M4_ALPHA on PRJ_1 / SEASONAL (ACCT_A):
    //    - Prior month 2026-10 DEBT_RECORDED: 15,000,000 (must stay in balance_before_month_minor for 2026-11)
    //    - In-month 2026-11 DEBT_RECORDED: 12,000,000 (active -> counts in 2026-11 obligations)
    //    - In-month 2026-11 DEBT_RECORDED: 5,000,000 REVERSED in 2026-11 (excluded from obligations)
    await recordM4(ACCT_A, {
      vendor_id: "VND_M4_ALPHA",
      project_id: PRJ_1,
      contract_type: "SEASONAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "15000000",
      effective_date: "2026-10-20",
      reason: "Công nợ kỳ trước 2026-10 của VND_M4_ALPHA",
    });
    await recordM4(ACCT_A, {
      vendor_id: "VND_M4_ALPHA",
      project_id: PRJ_1,
      contract_type: "SEASONAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "12000000",
      effective_date: "2026-11-05",
      reason: "Công nợ phát sinh tháng 11 của VND_M4_ALPHA",
    });
    const revTargetAlpha = await recordM4(ACCT_A, {
      vendor_id: "VND_M4_ALPHA",
      project_id: PRJ_1,
      contract_type: "SEASONAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "5000000",
      effective_date: "2026-11-06",
      reason: "Công nợ ghi nhầm cần đảo của VND_M4_ALPHA",
    });
    await reverseM4(ACCT_A, revTargetAlpha.entry_id, "2026-11-07", "Đảo bút toán ghi nhầm 5tr");

    // 2) VND_M4_ALPHA on PRJ_1 / OFFICIAL (ACCT_A):
    //    - In-month 2026-11 PAYROLL_RECORDED: 8,000,000 (active -> counts in 2026-11 obligations)
    await recordM4(ACCT_A, {
      vendor_id: "VND_M4_ALPHA",
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "PAYROLL_RECORDED",
      amount_minor: "8000000",
      effective_date: "2026-11-08",
      reason: "Lương chính thức tháng 11 của VND_M4_ALPHA",
    });

    // 3) VND_M4_BETA on PRJ_2 / SEASONAL (ACCT_B):
    //    - In-month 2026-11 ADJUSTMENT_INCREASE: 3,000,000 (active -> counts in 2026-11 obligations)
    await recordM4(ACCT_B, {
      vendor_id: "VND_M4_BETA",
      project_id: PRJ_2,
      contract_type: "SEASONAL",
      entry_type: "ADJUSTMENT_INCREASE",
      amount_minor: "3000000",
      effective_date: "2026-11-10",
      reason: "Điều chỉnh tăng tháng 11 của VND_M4_BETA",
    });

    // 4) VND_M4_GAMMA on PRJ_1 / SEASONAL (ACCT_A):
    //    - In-month 2026-11 OPENING_PAYABLE: 20,000,000 (opening balance, NOT obligations)
    //    - In-month 2026-11 DEBT_RECORDED: 2,500,000 REVERSED in 2026-11 (excluded from obligations)
    //    - In-month 2026-11 PAYMENT_RECORDED: 4,000,000 (payment, NOT obligations)
    await applyOpeningM4(
      ACCT_A,
      PRJ_1,
      "SEASONAL",
      "2026-11-01",
      [{ vendor_id: "VND_M4_GAMMA", entry_type: "OPENING_PAYABLE", amount_minor: "20000000" }],
      "Mở dư nợ đầu kỳ tháng 11 cho VND_M4_GAMMA",
    );
    const revTargetGamma = await recordM4(ACCT_A, {
      vendor_id: "VND_M4_GAMMA",
      project_id: PRJ_1,
      contract_type: "SEASONAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "2500000",
      effective_date: "2026-11-09",
      reason: "Công nợ nhập nhầm trên VND_M4_GAMMA",
    });
    await reverseM4(ACCT_A, revTargetGamma.entry_id, "2026-11-10", "Đảo bút toán nhập nhầm VND_M4_GAMMA");
    await recordM4(ACCT_A, {
      vendor_id: "VND_M4_GAMMA",
      project_id: PRJ_1,
      contract_type: "SEASONAL",
      entry_type: "PAYMENT_RECORDED",
      amount_minor: "4000000",
      effective_date: "2026-11-12",
      reason: "Thanh toán một phần dư nợ đầu kỳ cho VND_M4_GAMMA",
    });

    // 5) VND_M4_DELTA on PRJ_2 / OFFICIAL (ACCT_B) for separate period 2026-10 (ONLY opening + payment + reversed debt):
    await applyOpeningM4(
      ACCT_B,
      PRJ_2,
      "OFFICIAL",
      "2026-10-01",
      [{ vendor_id: "VND_M4_DELTA", entry_type: "OPENING_PAYABLE", amount_minor: "9000000" }],
      "Mở dư nợ đầu kỳ tháng 10 cho VND_M4_DELTA",
    );
    const revTargetDelta = await recordM4(ACCT_B, {
      vendor_id: "VND_M4_DELTA",
      project_id: PRJ_2,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "6000000",
      effective_date: "2026-10-12",
      reason: "Công nợ nhập nhầm tháng 10 của VND_M4_DELTA",
    });
    await reverseM4(ACCT_B, revTargetDelta.entry_id, "2026-10-13", "Đảo bút toán nhập nhầm VND_M4_DELTA");
    await recordM4(ACCT_B, {
      vendor_id: "VND_M4_DELTA",
      project_id: PRJ_2,
      contract_type: "OFFICIAL",
      entry_type: "PAYMENT_RECORDED",
      amount_minor: "3000000",
      effective_date: "2026-10-15",
      reason: "Thanh toán tháng 10 của VND_M4_DELTA",
    });

    // -------------------------------------------------------------------------
    // Case A — Active in-month obligations (> 0) for month 2026-11 (BOD_VIEWER)
    // Expected obligations = 12,000,000 + 8,000,000 + 3,000,000 = 23,000,000
    // -------------------------------------------------------------------------
    const reportCaseA = await repo.getMonthlyReport({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      month: "2026-11",
      project_id: null,
      accountant_ref: null,
      vendor_id: null,
      contract_type: "all",
    });
    assert.equal(reportCaseA.ok, true, JSON.stringify(reportCaseA));
    assert.ok(
      parseMonthlyReportEnvelope({ ok: true, data: reportCaseA.data }),
      "parseMonthlyReportEnvelope must accept Case A live DB output",
    );
    assert.equal(reportCaseA.data.totals.project_revenue_status, "MISSING_CANONICAL_SOURCE");
    assert.equal(reportCaseA.data.totals.project_revenue_minor, null);
    assert.equal(reportCaseA.data.totals.obligations_in_month_minor, "23000000");

    const sumSummaryObligationsA = reportCaseA.data.project_accountant_summaries.reduce(
      (acc, s) => acc + BigInt(s.obligations_in_month_minor),
      0n,
    );
    const sumRowObligationsA = reportCaseA.data.rows.reduce(
      (acc, r) => acc + BigInt(r.obligations_in_month_minor),
      0n,
    );
    assert.equal(sumSummaryObligationsA, 23000000n);
    assert.equal(sumRowObligationsA, 23000000n);

    const alphaSeasonalRow = reportCaseA.data.rows.find(
      (r) => r.vendor_id === "VND_M4_ALPHA" && r.contract_type === "SEASONAL",
    );
    assert.ok(alphaSeasonalRow);
    assert.equal(alphaSeasonalRow.balance_before_month_minor, "15000000");
    assert.equal(alphaSeasonalRow.obligations_in_month_minor, "12000000");
    assert.equal(alphaSeasonalRow.closing_balance_minor, "27000000");

    const gammaRow = reportCaseA.data.rows.find((r) => r.vendor_id === "VND_M4_GAMMA");
    assert.ok(gammaRow);
    assert.equal(gammaRow.opening_payable_in_month_minor, "20000000");
    assert.equal(gammaRow.obligations_in_month_minor, "0");
    assert.equal(gammaRow.paid_in_month_minor, "4000000");
    assert.equal(gammaRow.closing_payable_minor, "16000000");

    // -------------------------------------------------------------------------
    // Case B — Valid business 0 (`obligations_in_month_minor === "0"`)
    // B1: Filtered vendor VND_M4_GAMMA in 2026-11 (OPENING_PAYABLE + PAYMENT + reversed DEBT)
    // B2: Separate period 2026-10 on PRJ_2 (VND_M4_DELTA: OPENING_PAYABLE + PAYMENT + reversed DEBT)
    // -------------------------------------------------------------------------
    const reportCaseB1 = await repo.getMonthlyReport({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      month: "2026-11",
      project_id: null,
      accountant_ref: null,
      vendor_id: "VND_M4_GAMMA",
      contract_type: "all",
    });
    assert.equal(reportCaseB1.ok, true, JSON.stringify(reportCaseB1));
    assert.equal(reportCaseB1.data.totals.obligations_in_month_minor, "0");
    assert.equal(reportCaseB1.data.totals.paid_in_month_minor, "4000000");
    assert.equal(reportCaseB1.data.totals.closing_payable_minor, "16000000");
    assert.equal(reportCaseB1.data.project_accountant_summaries.length, 1);
    assert.equal(reportCaseB1.data.project_accountant_summaries[0].obligations_in_month_minor, "0");
    assert.equal(reportCaseB1.data.project_accountant_summaries[0].paid_in_month_minor, "4000000");
    assert.equal(reportCaseB1.data.project_accountant_summaries[0].closing_payable_minor, "16000000");
    assert.equal(reportCaseB1.data.rows.length, 1);
    assert.equal(reportCaseB1.data.rows[0].obligations_in_month_minor, "0");
    assert.equal(reportCaseB1.data.rows[0].opening_payable_in_month_minor, "20000000");
    assert.equal(reportCaseB1.data.rows[0].paid_in_month_minor, "4000000");
    assert.equal(reportCaseB1.data.rows[0].closing_payable_minor, "16000000");

    const reportCaseB2 = await repo.getMonthlyReport({
      auth_subject: BOD_VIEWER.auth,
      app_user_id: BOD_VIEWER.app,
      month: "2026-10",
      project_id: PRJ_2,
      accountant_ref: null,
      vendor_id: null,
      contract_type: "all",
    });
    assert.equal(reportCaseB2.ok, true, JSON.stringify(reportCaseB2));
    assert.equal(reportCaseB2.data.totals.obligations_in_month_minor, "0");
    assert.equal(reportCaseB2.data.totals.paid_in_month_minor, "3000000");
    assert.equal(reportCaseB2.data.totals.closing_payable_minor, "6000000");
    assert.equal(reportCaseB2.data.project_accountant_summaries.length, 2);
    for (const s of reportCaseB2.data.project_accountant_summaries) {
      assert.equal(s.obligations_in_month_minor, "0");
    }
    assert.equal(reportCaseB2.data.rows.length, 2);
    for (const r of reportCaseB2.data.rows) {
      assert.equal(r.obligations_in_month_minor, "0");
    }
    const deltaRowB2 = reportCaseB2.data.rows.find((r) => r.vendor_id === "VND_M4_DELTA");
    assert.ok(deltaRowB2);
    assert.equal(deltaRowB2.obligations_in_month_minor, "0");
    assert.equal(deltaRowB2.opening_payable_in_month_minor, "9000000");
    assert.equal(deltaRowB2.paid_in_month_minor, "3000000");
    assert.equal(deltaRowB2.closing_payable_minor, "6000000");

    // -------------------------------------------------------------------------
    // Case C — PROJECT_SCOPED accountant authority (ACCT_A assigned only to PRJ_1)
    // -------------------------------------------------------------------------
    const reportCaseCAllowed = await repo.getMonthlyReport({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      month: "2026-11",
      project_id: null,
      accountant_ref: null,
      vendor_id: null,
      contract_type: "all",
    });
    assert.equal(reportCaseCAllowed.ok, true, JSON.stringify(reportCaseCAllowed));
    assert.equal(reportCaseCAllowed.data.allowed_actions.visibility_scope, "PROJECT_SCOPED");
    assert.equal(reportCaseCAllowed.data.totals.obligations_in_month_minor, "20000000");
    assert.ok(reportCaseCAllowed.data.rows.length > 0);
    for (const s of reportCaseCAllowed.data.project_accountant_summaries) {
      assert.equal(s.project_id, PRJ_1);
      assert.equal(s.accountant_ref, ACCT_A.app);
    }
    for (const r of reportCaseCAllowed.data.rows) {
      assert.equal(r.project_id, PRJ_1);
      assert.equal(r.accountant_ref, ACCT_A.app);
    }

    const reportCaseCDeniedRepo = await repo.getMonthlyReport({
      auth_subject: ACCT_A.auth,
      app_user_id: ACCT_A.app,
      month: "2026-11",
      project_id: PRJ_2,
      accountant_ref: null,
      vendor_id: null,
      contract_type: "all",
    });
    assert.equal(reportCaseCDeniedRepo.ok, false);
    assert.equal(reportCaseCDeniedRepo.code, "VENDOR_FINANCE_PROJECT_ACCESS_DENIED");

    await assert.rejects(
      () =>
        callVfinRpc(db, "vendor_finance_get_monthly_report", {
          p_auth_subject: ACCT_A.auth,
          p_app_user_id: ACCT_A.app,
          p_month: "2026-11",
          p_project_id: PRJ_2,
          p_accountant_user_id: null,
          p_vendor_id: null,
          p_contract_type: "all",
        }),
      (err) =>
        err.code === "42501" &&
        String(err.message ?? "").includes("VENDOR_FINANCE_PROJECT_ACCESS_DENIED"),
    );
  } finally {
    await db.close();
  }
});
