/**
 * WP8A — Salary Advance + Vendor Finance on Canonical WP3 Org & WP5 Paired Effective Access
 * PGlite End-to-End Database, Data Preservation, Authorization Matrix, Financial Invariants &
 * Old-Web Strict Repository Parser Suite.
 *
 * Covers:
 *   1. Migration #225 atomic rollback, LF/CRLF-identical SHA-256 checksum, zero new public
 *      service_role RPCs (exact 336 allowlist), strict internal helper ACL revoke, locked search_path.
 *   2. Pre-migration (#224) -> Upgrade (#225) data preservation: pending/approved Salary Advance
 *      requests, events, Vendor Finance opening batch, sub-ledgers, shared advances, doc numbers,
 *      reconciliations, audit logs, and protected Owner ADMIN role remain 100% intact.
 *   3. Canonical WP3 `organization_person_department_memberships` + `organization_persons.status`:
 *      add, end, transfer (`ACCOUNTING -> MARKETING -> ACCOUNTING`), and `INACTIVE` person (even
 *      when `pm.ended_at IS NULL` or stale legacy `organization_department_memberships` exists)
 *      reflect immediately in both Salary Advance & Vendor Finance without breaking independent
 *      roles (`CASH_HOLDER_RECORD_BEHALF`, `PROJECT_MANAGER`).
 *   4. Canonical WP5 paired effective access (`direct_entry_authz__internal_has_paired_capability`):
 *      - No cross-scope escalation (`HR_OPERATOR + TEAM_LEADER`, `HR_OPERATOR + PROJECT_ACCOUNTANT`).
 *      - PM1 (P1) vs PM2 (P2) isolation, PM-only denied Vendor Finance, canonical WP5B-1 R2 PM
 *        predicate (revoked, same-day close, suspended_by_account_disable).
 *      - Dual-role PM+PA self-approval prevention (`created_by_user_id IS DISTINCT FROM actor`)
 *        and `post_message` role attribution (`PROJECT_MANAGER`).
 *      - Supervisory viewers (`ADMIN` protected Owner & `BOD`) read-only on Salary Advance.
 *   5. Account type & status rules:
 *      - Valid unlinked `NORMAL` `.kt` compat account (`dungnq.kt`) continues working.
 *      - `SHARED` accounts blocked across Salary Advance & Vendor Finance; active PA / VFIN global
 *        role blocks reclassification to `SHARED` or `SERVICE` (`ACCOUNT_TYPE_CONFLICT`).
 *      - `SERVICE` account (`n8n_bod_readonly`) read-only on Vendor Finance (all writes denied).
 *      - `enabled = false` immediately blocks all reads & writes.
 *   6. Financial invariants, display names & old-Web repository parsers:
 *      - Lossless VND `bigint` > `Number.MAX_SAFE_INTEGER` (`9007199254740993`), non-netting across
 *        projects/accountants/contract types, idempotency replay & conflict, OCC version conflict,
 *        bad state / spoofed IDs fail closed.
 *      - WP3 `organization_persons.full_name` display name priority for read projections & new
 *        entries without mutating historical snapshots.
 *      - Real `createVendorFinanceRepository` & `createSalaryAdvanceRepository` strict parsers pass
 *        end-to-end against migrated #225 RPC payloads.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { computeAssignAccountingMemberFingerprint } from "../src/lib/departments/department-contract.ts";
import {
  computeCreateRequestFingerprint,
  computeTransitionRequestFingerprint,
} from "../src/lib/salary-advance/salary-advance-contract.ts";
import { createSalaryAdvanceRepository } from "../src/lib/salary-advance/salary-advance-repository.ts";
import {
  computeApplyOpeningBatchFingerprint,
  computeAssignGlobalRoleFingerprint,
  computeAssignProjectAccountantFingerprint,
  computeEndGlobalRoleFingerprint,
  computeEndProjectAccountantFingerprint,
  computeFundSharedAdvanceFingerprint,
  computeRecordEntryFingerprint,
  computeRecordPaymentWithOffsetFingerprint,
} from "../src/lib/vendor-finance/vendor-finance-contract.ts";
import { createVendorFinanceRepository } from "../src/lib/vendor-finance/vendor-finance-repository.ts";
import { migrationChecksum } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const WP8A_MIGRATION_NAME = "20261120090000_wp8a_finance_org_authz.sql";

const PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = {
  auth: "18800000-0000-4000-8000-000000000001",
  app: "28800000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Canonical",
};
const LUANPT = {
  auth: "18800000-0000-4000-8000-000000000002",
  app: "28800000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "18800000-0000-4000-8000-000000000003",
  app: "28800000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "18800000-0000-4000-8000-000000000004",
  app: "28800000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const BOD_USER = {
  auth: "18800000-0000-4000-8000-000000000005",
  app: "28800000-0000-4000-8000-000000000005",
  email: "bod.wp8a@hrpartner.vn",
  name: "BoD Supervisory WP8A",
};
const PM_1 = {
  auth: "18800000-0000-4000-8000-000000000006",
  app: "28800000-0000-4000-8000-000000000006",
  recruiter: "38800000-0000-4000-8000-000000000006",
  email: "pm1.wp8a@hrpartner.vn",
  name: "QLDA Dự Án 1",
};
const PM_1B = {
  auth: "18800000-0000-4000-8000-000000000007",
  app: "28800000-0000-4000-8000-000000000007",
  recruiter: "38800000-0000-4000-8000-000000000007",
  email: "pm1b.wp8a@hrpartner.vn",
  name: "QLDA Dự Án 1B",
};
const PM_2 = {
  auth: "18800000-0000-4000-8000-000000000008",
  app: "28800000-0000-4000-8000-000000000008",
  recruiter: "38800000-0000-4000-8000-000000000008",
  email: "pm2.wp8a@hrpartner.vn",
  name: "QLDA Dự Án 2",
};
const PA_1 = {
  auth: "18800000-0000-4000-8000-000000000009",
  app: "28800000-0000-4000-8000-000000000009",
  email: "pa1.wp8a@hrpartner.vn",
  name: "Kế Toán Dự Án 1 (Legacy)",
};
const PA_2 = {
  auth: "18800000-0000-4000-8000-000000000010",
  app: "28800000-0000-4000-8000-000000000010",
  email: "pa2.wp8a@hrpartner.vn",
  name: "Kế Toán Dự Án 2",
};
const PA_UNLINKED_KT = {
  auth: "18800000-0000-4000-8000-000000000011",
  app: "28800000-0000-4000-8000-000000000011",
  email: "dungnq.kt@hrpartner.vn",
  name: "Kế Toán Unlinked KT",
};
const DUAL_PM_PA = {
  auth: "18800000-0000-4000-8000-000000000012",
  app: "28800000-0000-4000-8000-000000000012",
  recruiter: "38800000-0000-4000-8000-000000000012",
  email: "dual.pmpa.wp8a@hrpartner.vn",
  name: "Kiêm Nhiệm PM Và PA",
};
const HR_TL_COMBO = {
  auth: "18800000-0000-4000-8000-000000000013",
  app: "28800000-0000-4000-8000-000000000013",
  recruiter: "38800000-0000-4000-8000-000000000013",
  email: "hr.tl.wp8a@hrpartner.vn",
  name: "HR Operator Plus TL",
};
const HR_STALE_PA = {
  auth: "18800000-0000-4000-8000-000000000014",
  app: "28800000-0000-4000-8000-000000000014",
  email: "hr.stalepa.wp8a@hrpartner.vn",
  name: "HR Operator Plus Stale PA",
};
const CASH_HOLDER_USER = {
  auth: "18800000-0000-4000-8000-000000000015",
  app: "28800000-0000-4000-8000-000000000015",
  email: "cashholder.wp8a@hrpartner.vn",
  name: "Người Cầm Tiền WP8A",
};
const SHARED_ACC = {
  auth: "18800000-0000-4000-8000-000000000016",
  app: "28800000-0000-4000-8000-000000000016",
  email: "shared.kiosk.wp8a@hrpartner.vn",
  name: "Tài Khoản Dùng Chung",
};
const SERVICE_N8N = {
  auth: "18800000-0000-4000-8000-000000000017",
  app: "28800000-0000-4000-8000-000000000017",
  email: "n8n_bod_readonly@hrpartner.vn",
  name: "n8n BoD Readonly Service",
};
const UNASSIGNED_ACCT = {
  auth: "18800000-0000-4000-8000-000000000018",
  app: "28800000-0000-4000-8000-000000000018",
  email: "unassigned.acct.wp8a@hrpartner.vn",
  name: "Kế Toán Chưa Phân Công",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  BOD_USER,
  PM_1,
  PM_1B,
  PM_2,
  PA_1,
  PA_2,
  PA_UNLINKED_KT,
  DUAL_PM_PA,
  HR_TL_COMBO,
  HR_STALE_PA,
  CASH_HOLDER_USER,
  SHARED_ACC,
  SERVICE_N8N,
  UNASSIGNED_ACCT,
];

const TEAM_ALPHA = "48800000-0000-4000-8000-000000000001";
const PRJ_1 = "wp8a_prj_1";
const PRJ_2 = "wp8a_prj_2";
const PRJ_3 = "wp8a_prj_3";
const PRJ_DUAL = "wp8a_prj_dual";
const PRJ_STALE_PA = "wp8a_prj_stale_pa";
const VENDOR_1 = "wp8a_vendor_1";

let seq = 1;
function nextUuid() {
  const hex = (seq++).toString(16).padStart(12, "0");
  return `98800000-0000-4000-8000-${hex}`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function stripOuterTransaction(sql) {
  return sql.replace(/^\s*begin\s*;/i, "").replace(/commit\s*;\s*$/i, "");
}

async function loadMigrations() {
  const names = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql") && f < "20261121160000_pr28_retire_integrations_and_account_type_cleanup.sql").sort();
  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(path.join(MIGRATION_DIR, name), "utf8"),
    })),
  );
}

async function serviceRpc(db, fnName, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await db.exec("set role service_role;");
  try {
    const { rows } = await db.query(
      `select public.${fnName}(${placeholders}) as res`,
      args,
    );
    return rows[0]?.res;
  } finally {
    await db.exec("reset role;");
  }
}

async function expectServiceRpcError(db, fnName, args, expectedCode, expectedPattern) {
  await assert.rejects(
    () => serviceRpc(db, fnName, args),
    (err) => {
      assert.equal(err.code, expectedCode, `Expected SQLSTATE ${expectedCode}, got ${err.code}: ${err.message}`);
      if (expectedPattern) {
        assert.match(err.message, expectedPattern);
      }
      return true;
    },
  );
}

const RPC_PARAM_BINDINGS = {
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
  vendor_finance_fund_shared_advance: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_amount_minor", "text"],
    ["p_effective_date", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_apply_shared_advance_offset: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_project_id", "text"],
    ["p_contract_type", "text"],
    ["p_amount_minor", "text"],
    ["p_effective_date", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
  ],
  vendor_finance_record_payment_with_offset: [
    ["p_auth_subject", "uuid"],
    ["p_app_user_id", "uuid"],
    ["p_vendor_id", "text"],
    ["p_project_id", "text"],
    ["p_contract_type", "text"],
    ["p_payment_amount_minor", "text"],
    ["p_offset_amount_minor", "text"],
    ["p_effective_date", "date"],
    ["p_reason", "text"],
    ["p_idempotency_key", "uuid"],
    ["p_request_fingerprint", "text"],
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
  vendor_finance_list_global_roles_admin: [
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
};

function makePgliteSupabaseRpcClient(db) {
  return {
    async rpc(fnName, params) {
      const binding = RPC_PARAM_BINDINGS[fnName];
      assert.ok(binding, `Missing RPC binding in test harness for ${fnName}`);
      const placeholders = binding.map(([, pgType], i) => `$${i + 1}::${pgType}`).join(", ");
      const values = binding.map(([paramName, pgType]) => {
        const val = params?.[paramName];
        if (val === undefined) return null;
        if (pgType === "jsonb" && val !== null) return JSON.stringify(val);
        return val;
      });
      await db.exec("set role service_role;");
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
            code: err.code ?? "P0001",
            message: err.message ?? String(err),
          },
        };
      } finally {
        await db.exec("reset role;");
      }
    },
  };
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

async function seedSubmittedWorker(db, pm, projectId, employeeCode, displayName) {
  const batch = await serviceRpc(db, "direct_entry_create_batch", [
    pm.auth,
    pm.app,
    JSON.stringify([
      {
        project_id: projectId,
        first_work_date: "2026-10-01",
        employee_code: employeeCode,
        worker_details: makeWorkerDetails(displayName),
        recruiter_id: pm.recruiter,
        labor_type: "TEMPORARY",
      },
    ]),
    `wp8a-batch-${nextUuid()}`,
  ]);
  const submissionId = batch.submission_id;
  await serviceRpc(db, "direct_entry_transition_submission", [
    pm.auth,
    pm.app,
    submissionId,
    1,
    "SUBMITTED",
    `wp8a-submit-${nextUuid()}`,
  ]);
  const { rows: [entry] } = await db.query(
    "select entry_id from public.direct_entries where submission_id = $1::uuid limit 1",
    [submissionId],
  );
  return entry.entry_id;
}

test("(#1) WP8A migration atomic rollback, LF/CRLF checksum, zero new public service_role RPCs & strict internal ACL", async () => {
  const migrations = await loadMigrations();
  const targetIdx = migrations.findIndex((m) => m.name === WP8A_MIGRATION_NAME);
  assert.ok(targetIdx >= 0, `${WP8A_MIGRATION_NAME} must exist in supabase/migrations`);
  const target = migrations[targetIdx];

  // LF/CRLF identical SHA-256 checksum
  const lfChecksum = migrationChecksum(target.sql.replace(/\r\n?/g, "\n"));
  const crlfChecksum = migrationChecksum(target.sql.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"));
  assert.equal(lfChecksum, crlfChecksum);

  const db = new PGlite();
  try {
    await db.exec(PROLOGUE);
    for (const m of migrations.slice(0, targetIdx)) {
      await db.exec(m.sql);
    }

    const { rows: [beforeCnt] } = await db.query(`
      select count(*)::int as cnt
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
    `);

    // Atomic rollback when failure is injected before commit
    const brokenSql = `${stripOuterTransaction(target.sql)}\nselect 1 / 0;`;
    await assert.rejects(async () => {
      await db.exec(`begin;\n${brokenSql}\ncommit;`);
    });
    await db.exec("rollback;");
    const { rows: [rolledBackFn] } = await db.query(`
      select count(*)::int as cnt
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in (
           'salary_advance__internal_is_effective_project_manager',
           'vendor_finance__internal_lock_actor_and_assert_authority'
         )
    `);
    assert.equal(rolledBackFn.cnt, 0, "Rolled-back WP8A migration must leave zero new helpers");

    // Clean apply
    await db.exec(target.sql);

    const { rows: [afterCnt] } = await db.query(`
      select count(*)::int as cnt
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
    `);
    assert.equal(
      afterCnt.cnt,
      beforeCnt.cnt,
      `WP8A must add ZERO new service_role RPCs (before=${beforeCnt.cnt}, after=${afterCnt.cnt})`,
    );

    // Every internal helper touched/created by WP8A must be revoked from public/anon/authenticated/service_role
    const { rows: badInternal } = await db.query(`
      select p.oid::pg_catalog.regprocedure::text as sig
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in (
           'org_department__internal_has_active_membership',
           'org_department__internal_resolve_vfin_default_authority',
           'org_department__internal_has_personal_assignments',
           'org_department__internal_account_summary',
           'salary_advance__internal_is_effective_project_manager',
           'salary_advance__internal_actor_display_name',
           'salary_advance__internal_resolve_authority',
           'salary_advance__internal_request_access',
           'vendor_finance__internal_actor_display_name',
           'vendor_finance__internal_lock_project',
           'vendor_finance__internal_resolve_active_project_accountant',
           'vendor_finance__internal_can_actor_write_subledger',
           'vendor_finance__internal_resolve_authority',
           'vendor_finance__internal_lock_actor_and_assert_authority'
         )
         and (
           pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
           or pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
           or not p.prosecdef
           or coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=pg_catalog, public%'
         )
    `);
    assert.deepEqual(badInternal, [], "All 14 internal WP8A helpers must be locked SECURITY DEFINER & revoked");
  } finally {
    await db.close();
  }
});

test("(#2) WP8A E2E: Pre-migration data preservation, WP3 Org + WP5 paired authz, self-approval block, VND bigint, SHARED/SERVICE & old-Web parsers", async () => {
  const migrations = await loadMigrations();
  const targetIdx = migrations.findIndex((m) => m.name === WP8A_MIGRATION_NAME);
  assert.ok(targetIdx >= 0);

  const db = new PGlite();
  try {
    await db.exec(PROLOGUE);
    // Apply ONLY up to migration #224 (pre-WP8A) to verify real upgrade & data preservation!
    for (const m of migrations.slice(0, targetIdx)) {
      await db.exec(m.sql);
    }

    // Seed all accounts
    for (const u of ALL_USERS) {
      await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await db.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
        [u.app, u.auth, u.name],
      );
    }

    // Bootstrap 4 canonical admins for WP5B-2 cutover
    for (const adm of [OWNER, LIENVU, NGATTT]) {
      for (const cap of [
        "entry_admin",
        "entry_team",
        "entry_own",
        "entry_create",
        "submission_create",
        "entry_privileged_edit",
        "entry_restore",
        "recruiter_master_manage",
        "team_master_manage",
        "audit_view",
        "worker_edit_history_view",
        "document_upload",
        "document_view",
        "employment_status.review",
        "employment_status.apply",
        "change_request_create",
        "change_review",
        "employment_status.request",
        "duplicate_cccd_withdraw",
      ]) {
        await db.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
          [adm.app, cap],
        );
      }
      await db.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true), ($1::uuid, 'own', '2026-01-01', true)",
        [adm.app],
      );
    }
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true)",
      [LUANPT.app],
    );

    // Reclassify SHARED and SERVICE accounts BEFORE WP5 cutover (matching WP3 -> WP5 production sequence)
    await db.query("update public.direct_entry_app_users set account_type = 'SHARED' where app_user_id = $1::uuid", [
      SHARED_ACC.app,
    ]);
    await db.query("update public.direct_entry_app_users set account_type = 'SERVICE' where app_user_id = $1::uuid", [
      SERVICE_N8N.app,
    ]);

    // Run WP5B-2 cutover on pre-WP8A DB (matching NWC state!)
    const plan = await runWp5Cutover(db, { mode: "read-only-plan" });
    assert.equal(plan.action_diff.unexpected_diff_count, 0);
    const applied = await runWp5Cutover(db, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: plan.manifest_fingerprint,
    });
    assert.equal(applied.status, "APPLIED");

    // Assign WP5 global roles: HR_OPERATOR (for escalation tests), RECRUITER (for PMs)
    async function assignWp5Role(target, roleCode) {
      const { rows: [u] } = await db.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [target.app],
      );
      return serviceRpc(db, "direct_entry_authz_assign_global_role_admin", [
        OWNER.auth,
        OWNER.app,
        target.app,
        roleCode,
        u.version,
        `Assign ${roleCode} WP8A`,
        nextUuid(),
        sha256(`assign:${target.app}:${roleCode}:${seq}`),
      ]);
    }
    // Grant canonical BoD direct paired capabilities (`report_analytics_view` + `report_view` @ `ALL`)
    await db.query(
      `insert into public.authz_direct_capability_grants
         (app_user_id, capability, scope_kind, source_kind, granted_by_app_user_id, reason)
       values ($1::uuid, 'report_analytics_view', 'ALL', 'EXCEPTION_GRANT', $2::uuid, 'BoD supervisory view'),
              ($1::uuid, 'report_view', 'ALL', 'EXCEPTION_GRANT', $2::uuid, 'BoD supervisory view')`,
      [BOD_USER.app, OWNER.app],
    );
    await assignWp5Role(HR_TL_COMBO, "HR_OPERATOR");
    await assignWp5Role(HR_STALE_PA, "HR_OPERATOR");

    // Give SERVICE_N8N direct paired vendor_finance_view @ ALL (read-only service token like n8n_bod_readonly)
    await db.query(
      `insert into public.authz_direct_capability_grants
         (app_user_id, capability, scope_kind, source_kind, granted_by_app_user_id, reason)
       values ($1::uuid, 'vendor_finance_view', 'ALL', 'EXCEPTION_GRANT', $2::uuid, 'n8n readonly VFIN view')`,
      [SERVICE_N8N.app, OWNER.app],
    );

    // Seed Team, Recruiters, Projects, Vendor
    await db.query(
      "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 'WP8A_TEAM', 'Đội WP8A', true)",
      [TEAM_ALPHA],
    );
    for (const [pm, code, pos] of [
      [PM_1, "PM-801", "STAFF"],
      [PM_1B, "PM-802", "STAFF"],
      [PM_2, "PM-803", "STAFF"],
      [DUAL_PM_PA, "PM-804", "STAFF"],
      [HR_TL_COMBO, "TL-805", "TEAM_LEADER"],
    ]) {
      await db.query(
        "insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active) values ($1::uuid, $2, $3, $4, true)",
        [pm.recruiter, pm.name, code, pos],
      );
      await db.query(
        "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2026-01-01', true)",
        [pm.recruiter],
      );
      await db.query(
        "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
        [pm.recruiter, TEAM_ALPHA],
      );
      await db.query(
        "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
        [pm.app, pm.recruiter],
      );
      await assignWp5Role(pm, "RECRUITER");
    }

    // Make HR_TL_COMBO active Team Leader on TEAM_ALPHA (grants report_view + report_analytics_view @ CONTEXT_TEAM)
    await db.query(
      `insert into public.direct_entry_team_leader_assignments (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, $3::uuid, '2026-01-01', true)`,
      [TEAM_ALPHA, HR_TL_COMBO.app, HR_TL_COMBO.recruiter],
    );
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'team', $2::uuid, '2026-01-01', true)",
      [HR_TL_COMBO.app, TEAM_ALPHA],
    );
    await db.query("select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)", [HR_TL_COMBO.app]);

    await db.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự Án 1', true, 1),
              ($2, 'Dự Án 2', true, 1),
              ($3, 'Dự Án 3 (Unlinked KT)', true, 1),
              ($4, 'Dự Án Kiêm Nhiệm', true, 1),
              ($5, 'Dự Án Stale PA', true, 1)`,
      [PRJ_1, PRJ_2, PRJ_3, PRJ_DUAL, PRJ_STALE_PA],
    );
    await db.query(
      `insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current)
       values ($1, $2::uuid, '2026-01-01', true),
              ($1, $3::uuid, '2026-01-01', true),
              ($4, $5::uuid, '2026-01-01', true),
              ($6, $2::uuid, '2026-01-01', true),
              ($7, $8::uuid, '2026-01-01', true)`,
      [PRJ_1, PM_1.recruiter, PM_1B.recruiter, PRJ_2, PM_2.recruiter, PRJ_3, PRJ_DUAL, DUAL_PM_PA.recruiter],
    );

    await db.query(
      `insert into public.vendors (vendor_id, display_name, active)
       values ($1, 'NCC Đối Tác WP8A', true)`,
      [VENDOR_1],
    );

    // Get ACCOUNTING & MARKETING department IDs
    const { rows: [acctDept] } = await db.query(
      "select department_id from public.organization_departments where system_key = 'ACCOUNTING'",
    );
    const { rows: [mktDept] } = await db.query(
      "select department_id from public.organization_departments where system_key = 'MARKETING'",
    );

    // Create WP3 Persons in ACCOUNTING for PA_1, PA_2, DUAL_PM_PA, UNASSIGNED_ACCT
    async function createLinkedPerson(target, code, fullName, deptId) {
      const { rows: [u] } = await db.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [target.app],
      );
      const res = await serviceRpc(db, "org_department_create_person_admin", [
        OWNER.auth,
        OWNER.app,
        code,
        fullName,
        "2025-01-01",
        deptId,
        target.app,
        u.version,
        null,
        `Tạo hồ sơ ${code}`,
        nextUuid(),
        sha256(`person:${code}:${seq}`),
      ]);
      return res.person;
    }

    const pPa1 = await createLinkedPerson(PA_1, "KT-WP8A-01", "Nguyễn Thị Kế Toán Một (WP3)", acctDept.department_id);
    await createLinkedPerson(PA_2, "KT-WP8A-02", "Trần Thị Kế Toán Hai (WP3)", acctDept.department_id);
    await createLinkedPerson(DUAL_PM_PA, "KT-WP8A-DUAL", "Lê Văn Kiêm Nhiệm (WP3)", acctDept.department_id);
    await createLinkedPerson(UNASSIGNED_ACCT, "KT-WP8A-UN", "Phạm Thị Chưa Phân Công (WP3)", acctDept.department_id);

    // Unlinked valid NORMAL `.kt` compat account via legacy org_department_assign_accounting_member
    const ktReason = "Bổ nhiệm tài khoản .kt unlinked";
    await serviceRpc(db, "org_department_assign_accounting_member", [
      OWNER.auth,
      OWNER.app,
      PA_UNLINKED_KT.app,
      0,
      null,
      ktReason,
      nextUuid(),
      computeAssignAccountingMemberFingerprint({
        actor_app_user_id: OWNER.app,
        account_ref: PA_UNLINKED_KT.app,
        expected_pair_version: 0,
        effective_from: null,
        reason: ktReason,
      }),
    ]);

    // Assign Project Accountants (pre-migration!)
    async function assignPa(projectId, targetUser, expectedVersion = 0) {
      const reason = `Phân công ${targetUser.name} phụ trách ${projectId}`;
      return serviceRpc(db, "vendor_finance_assign_project_accountant_admin", [
        OWNER.auth,
        OWNER.app,
        projectId,
        targetUser.app,
        expectedVersion,
        null,
        reason,
        nextUuid(),
        computeAssignProjectAccountantFingerprint({
          actor_app_user_id: OWNER.app,
          project_id: projectId,
          accountant_user_id: targetUser.app,
          expected_version: expectedVersion,
          valid_from: null,
          reason,
        }),
      ]);
    }
    const pa1Assign = await assignPa(PRJ_1, PA_1, 0);
    await assignPa(PRJ_2, PA_2, 0);
    await assignPa(PRJ_3, PA_UNLINKED_KT, 0);
    await assignPa(PRJ_DUAL, DUAL_PM_PA, 0);

    // Seed HR_STALE_PA with a stale PA assignment row (WITHOUT ACCOUNTING membership) -> WP5 projects vendor_finance_view @ CONTEXT_PROJECT!
    await db.query("select set_config('vendor_finance.admin_write_marker', 'on', false)");
    await db.query(
      `insert into public.vendor_finance_project_accountants
         (project_id, accountant_user_id, version, valid_from, assigned_by_user_id, assign_reason)
       values ($1, $2::uuid, 1, '2026-01-01', $3::uuid, 'Historical PA row without ACCOUNTING membership')`,
      [PRJ_STALE_PA, HR_STALE_PA.app, OWNER.app],
    );
    await db.query("select set_config('vendor_finance.admin_write_marker', 'off', false)");

    // Assign CASH_HOLDER_RECORD_BEHALF global role to CASH_HOLDER_USER & PA_1 (dual independent grant test)
    async function assignGlobalVfinRole(targetUser, roleCode, expectedVersion = 0) {
      const reason = `Cấp ${roleCode} cho ${targetUser.name}`;
      return serviceRpc(db, "vendor_finance_assign_global_role_admin", [
        OWNER.auth,
        OWNER.app,
        targetUser.app,
        roleCode,
        expectedVersion,
        null,
        reason,
        nextUuid(),
        computeAssignGlobalRoleFingerprint({
          actor_app_user_id: OWNER.app,
          target_user_id: targetUser.app,
          role_code: roleCode,
          expected_version: expectedVersion,
          valid_from: null,
          reason,
        }),
      ]);
    }
    const cashHolderRoleRes = await assignGlobalVfinRole(CASH_HOLDER_USER, "CASH_HOLDER_RECORD_BEHALF", 0);
    const pa1CashHolderRes = await assignGlobalVfinRole(PA_1, "CASH_HOLDER_RECORD_BEHALF", 0);
    const pa1CashHolderGrantId = pa1CashHolderRes.role_grant_id;

    // Seed PRE-MIGRATION Workers, Salary Advance Requests & Vendor Finance Ledger Data!
    const workerP1 = await seedSubmittedWorker(db, PM_1, PRJ_1, "hrp-2026-880001", "Nguyễn Công Nhân Một");
    await seedSubmittedWorker(db, PM_2, PRJ_2, "hrp-2026-880002", "Trần Công Nhân Hai");
    const workerP3 = await seedSubmittedWorker(db, PM_1, PRJ_3, "hrp-2026-880003", "Lê Công Nhân Ba");
    const workerDual = await seedSubmittedWorker(db, DUAL_PM_PA, PRJ_DUAL, "hrp-2026-880004", "Phạm Công Nhân Kiêm Nhiệm");

    const preSalReqRes = await serviceRpc(db, "salary_advance_create_request", [
      PM_1.auth,
      PM_1.app,
      PRJ_1,
      workerP1,
      "12500000",
      "Yêu cầu ứng lương trước migration WP8A",
      "wp8a-pre-sal-req-01",
      computeCreateRequestFingerprint({
        project_id: PRJ_1,
        worker_entry_id: workerP1,
        requested_amount_vnd: "12500000",
        initial_content: "Yêu cầu ứng lương trước migration WP8A",
      }),
      "CASH",
    ]);
    const preSalReqId = preSalReqRes.request.request_id;

    const preOpeningReason = "Số dư đầu kỳ trước WP8A";
    await serviceRpc(db, "vendor_finance_apply_opening_batch", [
      OWNER.auth,
      OWNER.app,
      PRJ_1,
      "SEASONAL",
      "2026-10-01",
      JSON.stringify([{ vendor_id: VENDOR_1, entry_type: "OPENING_PAYABLE", amount_minor: "50000000" }]),
      preOpeningReason,
      nextUuid(),
      computeApplyOpeningBatchFingerprint({
        actor_app_user_id: OWNER.app,
        project_id: PRJ_1,
        contract_type: "SEASONAL",
        cutoff_date: "2026-10-01",
        items: [{ vendor_id: VENDOR_1, entry_type: "OPENING_PAYABLE", amount_minor: "50000000" }],
        reason: preOpeningReason,
      }),
    ]);

    const preEntryReason = "Phát sinh nợ trước WP8A";
    const preEntryRes = await serviceRpc(db, "vendor_finance_record_entry", [
      PA_1.auth,
      PA_1.app,
      VENDOR_1,
      PRJ_1,
      "SEASONAL",
      "DEBT_RECORDED",
      "15000000",
      "2026-10-05",
      preEntryReason,
      nextUuid(),
      computeRecordEntryFingerprint({
        actor_app_user_id: PA_1.app,
        vendor_id: VENDOR_1,
        project_id: PRJ_1,
        contract_type: "SEASONAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "15000000",
        effective_date: "2026-10-05",
        reason: preEntryReason,
      }),
    ]);
    const preEntryId = preEntryRes.entry.entry_id;
    const preEntryDocNumber = preEntryRes.entry.document_no;
    const preEntryRecordedName = preEntryRes.entry.created_by_display_name;

    const preFundReason = "Ứng trước NCC trước WP8A";
    await serviceRpc(db, "vendor_finance_fund_shared_advance", [
      CASH_HOLDER_USER.auth,
      CASH_HOLDER_USER.app,
      VENDOR_1,
      "20000000",
      "2026-10-06",
      preFundReason,
      nextUuid(),
      computeFundSharedAdvanceFingerprint({
        actor_app_user_id: CASH_HOLDER_USER.app,
        vendor_id: VENDOR_1,
        amount_minor: "20000000",
        effective_date: "2026-10-06",
        reason: preFundReason,
      }),
    ]);

    // Capture exact pre-migration snapshot counts & balances
    const snapshotQuery = `
      select
        (select count(*)::int from public.salary_advance_requests) as sal_req_cnt,
        (select count(*)::int from public.salary_advance_events) as sal_ev_cnt,
        (select count(*)::int from public.vendor_finance_entries) as vfin_ent_cnt,
        (select count(*)::int from public.vendor_finance_shared_advance_movements) as vfin_adv_cnt,
        (select coalesce(sum(balance_delta_minor), 0)::text from public.vendor_finance_entries) as vfin_ent_sum,
        (select coalesce(sum(balance_delta_minor), 0)::text from public.vendor_finance_shared_advance_movements) as vfin_adv_sum,
        (select count(*)::int from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'ADMIN' and ended_at is null) as owner_admin_cnt
    `;
    const { rows: [preSnap] } = await db.query(snapshotQuery, [OWNER.app]);
    assert.equal(preSnap.sal_req_cnt, 1);
    assert.equal(preSnap.vfin_ent_sum, "65000000");
    assert.equal(preSnap.vfin_adv_sum, "20000000");
    assert.equal(preSnap.owner_admin_cnt, 1);

    // =========================================================================
    // APPLY WP8A MIGRATION #225 ON LIVE PRE-MIGRATION DATABASE!
    // =========================================================================
    await db.exec(migrations[targetIdx].sql);

    const { rows: [postSnap] } = await db.query(snapshotQuery, [OWNER.app]);
    assert.deepEqual(postSnap, preSnap, "Migration #225 must preserve 100% of existing financial rows, balances & Owner ADMIN");

    // Verify historical entry doc_number & recorded display name remain untouched
    const { rows: [histEntry] } = await db.query(
      "select document_no, created_by_display_name_snapshot from public.vendor_finance_entries where entry_id = $1::uuid",
      [preEntryId],
    );
    assert.equal(histEntry.document_no, preEntryDocNumber);
    assert.equal(histEntry.created_by_display_name_snapshot, preEntryRecordedName);

    // Wire REAL strict old-Web repositories against PGlite!
    const rpcClient = makePgliteSupabaseRpcClient(db);
    const vfinRepo = createVendorFinanceRepository((fn, args) => rpcClient.rpc(fn, args));
    const salRepo = createSalaryAdvanceRepository((fn, args) => rpcClient.rpc(fn, args));

    // =========================================================================
    // A. Old-Web Repository Parsers + Supervisory + PM/PA Isolation
    // =========================================================================
    // Protected Owner (ADMIN) & BoD: read-only supervisory on Salary Advance
    for (const sup of [OWNER, BOD_USER]) {
      const ctx = await salRepo.getActorContext({ auth_subject: sup.auth, app_user_id: sup.app });
      assert.equal(ctx.ok, true, `${sup.name} context must parse cleanly`);
      assert.equal(ctx.data.is_supervisory_viewer, true);
      const det = await salRepo.getRequestDetail({
        auth_subject: sup.auth,
        app_user_id: sup.app,
        request_id: preSalReqId,
      });
      assert.equal(det.ok, true);
      assert.equal(det.data.request.allowed_actions.can_approve, false);
      assert.equal(det.data.request.allowed_actions.can_reject, false);
      const badApprove = await salRepo.transitionRequest({
        auth_subject: sup.auth,
        app_user_id: sup.app,
        request_id: preSalReqId,
        action: "APPROVE",
        expected_version: 1,
        message_text: null,
        idempotency_key: `wp8a-sup-deny-${nextUuid()}`,
        request_fingerprint: computeTransitionRequestFingerprint({
          request_id: preSalReqId,
          action: "APPROVE",
          expected_version: 1,
          message_text: null,
        }),
      });
      assert.deepEqual(badApprove, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });
    }

    // PM_1 vs PM_2 isolation & PM_1B isolation on P1
    const pm1Workers = await salRepo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_1,
      search: null,
      cursor: null,
      page_size: 25,
    });
    assert.equal(pm1Workers.ok, true);
    assert.equal(pm1Workers.data.workers.length, 1);

    const pm1WrongPrj = await salRepo.listProjectWorkers({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_2,
      search: null,
      cursor: null,
      page_size: 25,
    });
    assert.deepEqual(pm1WrongPrj, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });

    const pm1bRead = await salRepo.getRequestDetail({
      auth_subject: PM_1B.auth,
      app_user_id: PM_1B.app,
      request_id: preSalReqId,
    });
    assert.deepEqual(pm1bRead, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });

    // PM-only strictly denied Vendor Finance
    const pm1VfinAccess = await vfinRepo.getActorAccess({ auth_subject: PM_1.auth, app_user_id: PM_1.app });
    assert.equal(pm1VfinAccess.ok, true);
    assert.equal(pm1VfinAccess.data.allowed, false);
    const pm1VfinList = await vfinRepo.listVendors({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      search: null,
      active: "all",
      balance_filter: "all",
      project_id: null,
      accountant_ref: null,
      ledger_scope: null,
      contract_type: "all",
      page: 1,
      page_size: 25,
    });
    assert.equal(pm1VfinList.ok, false);
    assert.equal(pm1VfinList.code, "VENDOR_FINANCE_ACCESS_DENIED");

    // PA_2 (assigned to PRJ_2) CANNOT view or approve PRJ_1 request
    const pa2ReadP1 = await salRepo.getRequestDetail({
      auth_subject: PA_2.auth,
      app_user_id: PA_2.app,
      request_id: preSalReqId,
    });
    assert.deepEqual(pa2ReadP1, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });

    // =========================================================================
    // B. No Cross-Scope Escalation (HR_OPERATOR+TL & HR_OPERATOR+Stale PA)
    // =========================================================================
    for (const attacker of [HR_TL_COMBO, HR_STALE_PA]) {
      const saCtx = await salRepo.getActorContext({ auth_subject: attacker.auth, app_user_id: attacker.app });
      assert.deepEqual(saCtx, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });

      const vfAccess = await vfinRepo.getActorAccess({ auth_subject: attacker.auth, app_user_id: attacker.app });
      assert.equal(vfAccess.ok, true);
      assert.equal(vfAccess.data.allowed, false, `${attacker.name} must NOT escalate to Vendor Finance`);
      assert.equal(vfAccess.data.can_view, false);
      assert.equal(vfAccess.data.can_record, false);
      assert.equal(vfAccess.data.can_manage_project_assignments, false);

      // Direct governance admin RPC must fail closed with 42501
      const adminList = await vfinRepo.listProjectAccountantsAdmin({
        auth_subject: attacker.auth,
        app_user_id: attacker.app,
        search: null,
        include_history: true,
        page: 1,
        page_size: 25,
      });
      assert.equal(adminList.ok, false);
      assert.equal(adminList.code, "VENDOR_FINANCE_ADMIN_DENIED");
    }

    // =========================================================================
    // C. Dual-Role PM + PA Self-Approval Prevention & Role Attribution
    // =========================================================================
    const dualCreateRes = await salRepo.createRequest({
      auth_subject: DUAL_PM_PA.auth,
      app_user_id: DUAL_PM_PA.app,
      project_id: PRJ_DUAL,
      worker_entry_id: workerDual,
      requested_amount_vnd: "3000000",
      initial_content: "Tự tạo trên dự án kiêm nhiệm",
      idempotency_key: "wp8a-dual-create-01",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_DUAL,
        worker_entry_id: workerDual,
        requested_amount_vnd: "3000000",
        initial_content: "Tự tạo trên dự án kiêm nhiệm",
      }),
      payment_method: "CASH",
    });
    assert.equal(dualCreateRes.ok, true);
    const dualReqId = dualCreateRes.data.request.request_id;
    assert.equal(dualCreateRes.data.request.allowed_actions.can_approve, false);
    assert.equal(dualCreateRes.data.request.allowed_actions.can_reject, false);
    assert.equal(dualCreateRes.data.request.allowed_actions.can_request_info, false);
    assert.equal(dualCreateRes.data.request.allowed_actions.can_review_evidence, false);
    assert.equal(dualCreateRes.data.request.allowed_actions.can_withdraw, true);

    for (const forbiddenAction of ["APPROVE", "REJECT", "REQUEST_INFO"]) {
      const selfAct = await salRepo.transitionRequest({
        auth_subject: DUAL_PM_PA.auth,
        app_user_id: DUAL_PM_PA.app,
        request_id: dualReqId,
        action: forbiddenAction,
        expected_version: 1,
        message_text: "Cố tự duyệt",
        idempotency_key: `wp8a-self-${forbiddenAction}-${nextUuid()}`,
        request_fingerprint: computeTransitionRequestFingerprint({
          request_id: dualReqId,
          action: forbiddenAction,
          expected_version: 1,
          message_text: "Cố tự duyệt",
        }),
      });
      assert.deepEqual(selfAct, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });
    }

    // post_message by dual-role creator logs PROJECT_MANAGER (not PROJECT_ACCOUNTANT)
    const dualMsgRes = await serviceRpc(db, "salary_advance_post_message", [
      DUAL_PM_PA.auth,
      DUAL_PM_PA.app,
      dualReqId,
      1,
      "Ghi chú từ người tạo kiêm nhiệm",
      "wp8a-dual-msg-01",
      sha256("dual-msg-01"),
    ]);
    const latestEvent = dualMsgRes.events[dualMsgRes.events.length - 1];
    assert.equal(latestEvent.actor_role, "PROJECT_MANAGER");

    // =========================================================================
    // D. WP3 Org Live Reflection: End, Transfer, Person INACTIVE + Independent Role Preservation
    // =========================================================================
    // D1. Transfer PA_1 person ACCOUNTING -> MARKETING via WP3 RPC -> PA_1 immediately loses PA access on PRJ_1,
    //     BUT retains independent CASH_HOLDER_RECORD_BEHALF global role!
    const { rows: [pa1Mem] } = await db.query(
      `select pm.membership_id, p.version as person_version
         from public.organization_person_department_memberships pm
         join public.organization_persons p on p.person_id = pm.person_id
        where pm.person_id = $1::uuid and pm.ended_at is null`,
      [pPa1.person_id],
    );
    await serviceRpc(db, "org_department_transfer_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      pPa1.person_id,
      mktDept.department_id,
      pa1Mem.person_version,
      pa1Mem.membership_id,
      "Chuyển PA_1 sang Marketing",
      nextUuid(),
      sha256(`transfer-mkt:${seq}`),
    ]);

    // Inject a stale legacy organization_department_memberships row AFTER transfer to prove WP3 is sole source of truth for linked persons!
    await db.query("select set_config('org_department.write_marker', 'on', false)");
    await db.query(
      `insert into public.organization_department_memberships
         (department_id, app_user_id, valid_from, valid_to, granted_by_user_id, grant_reason, version)
       values ($1::uuid, $2::uuid, '2026-01-01', null, $3::uuid, 'Stale legacy compat row', 99)
       on conflict do nothing`,
      [acctDept.department_id, PA_1.app, OWNER.app],
    );
    await db.query("select set_config('org_department.write_marker', 'off', false)");

    // Salary Advance PA access revoked immediately (even with stale legacy row!)
    const pa1SalAfterTransfer = await salRepo.getRequestDetail({
      auth_subject: PA_1.auth,
      app_user_id: PA_1.app,
      request_id: preSalReqId,
    });
    assert.deepEqual(pa1SalAfterTransfer, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });

    // Vendor Finance PA access revoked, while independent CASH_HOLDER_RECORD_BEHALF stays active!
    const pa1VfAfterTransfer = await vfinRepo.getActorAccess({ auth_subject: PA_1.auth, app_user_id: PA_1.app });
    assert.equal(pa1VfAfterTransfer.ok, true);
    assert.equal(pa1VfAfterTransfer.data.can_fund_vendor_advance, true, "Independent CASH_HOLDER_RECORD_BEHALF must remain active");
    assert.equal(pa1VfAfterTransfer.data.active_assigned_project_count, 0, "PA project scope dropped immediately on transfer out of ACCOUNTING");

    // End CASH_HOLDER_RECORD_BEHALF on PA_1 -> now PA_1 has ZERO VFIN access
    await serviceRpc(db, "vendor_finance_end_global_role_admin", [
      OWNER.auth,
      OWNER.app,
      pa1CashHolderGrantId,
      1,
      null,
      "Thu hồi CASH_HOLDER_RECORD_BEHALF của PA_1",
      nextUuid(),
      computeEndGlobalRoleFingerprint({
        actor_app_user_id: OWNER.app,
        role_grant_id: pa1CashHolderGrantId,
        expected_version: 1,
        valid_to: null,
        reason: "Thu hồi CASH_HOLDER_RECORD_BEHALF của PA_1",
      }),
    ]);
    const pa1VfNone = await vfinRepo.getActorAccess({ auth_subject: PA_1.auth, app_user_id: PA_1.app });
    assert.equal(pa1VfNone.ok, true);
    assert.equal(pa1VfNone.data.allowed, false);

    // D2. Transfer PA_1 back MARKETING -> ACCOUNTING -> immediately regains PA access on PRJ_1!
    const { rows: [pa1MktMem] } = await db.query(
      `select pm.membership_id, p.version as person_version
         from public.organization_person_department_memberships pm
         join public.organization_persons p on p.person_id = pm.person_id
        where pm.person_id = $1::uuid and pm.ended_at is null`,
      [pPa1.person_id],
    );
    await serviceRpc(db, "org_department_transfer_person_member_admin", [
      OWNER.auth,
      OWNER.app,
      pPa1.person_id,
      acctDept.department_id,
      pa1MktMem.person_version,
      pa1MktMem.membership_id,
      "Chuyển PA_1 trở lại Kế toán",
      nextUuid(),
      sha256(`transfer-acct:${seq}`),
    ]);
    const pa1SalRestored = await salRepo.getRequestDetail({
      auth_subject: PA_1.auth,
      app_user_id: PA_1.app,
      request_id: preSalReqId,
    });
    assert.equal(pa1SalRestored.ok, true);
    assert.equal(pa1SalRestored.data.request.allowed_actions.can_approve, true);

    // D3. Mark PA_1 Person status = INACTIVE (membership ended_at stays NULL) -> immediately blocks PA access!
    const { rows: [pa1PersonRow] } = await db.query(
      "select version from public.organization_persons where person_id = $1::uuid",
      [pPa1.person_id],
    );
    await serviceRpc(db, "org_department_update_person_admin", [
      OWNER.auth,
      OWNER.app,
      pPa1.person_id,
      pa1PersonRow.version,
      "KT-WP8A-01",
      "Nguyễn Thị Kế Toán Một (WP3)",
      "2025-01-01",
      "INACTIVE",
      "Tạm ngừng hồ sơ nhân sự PA_1",
      nextUuid(),
      sha256(`inactive-pa1:${seq}`),
    ]);
    const pa1InactiveSal = await salRepo.getRequestDetail({
      auth_subject: PA_1.auth,
      app_user_id: PA_1.app,
      request_id: preSalReqId,
    });
    assert.deepEqual(pa1InactiveSal, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });
    const pa1InactiveVf = await vfinRepo.getActorAccess({ auth_subject: PA_1.auth, app_user_id: PA_1.app });
    assert.equal(pa1InactiveVf.data.allowed, false);

    // Reactivate PA_1 AND rename WP3 Person full_name -> reflects immediately in projections & new entries without touching history!
    const { rows: [pa1PersonInactiveRow] } = await db.query(
      "select version from public.organization_persons where person_id = $1::uuid",
      [pPa1.person_id],
    );
    const updatedPersonName = "Nguyễn Thị Kế Toán Một (Tên WP3 Mới)";
    await serviceRpc(db, "org_department_update_person_admin", [
      OWNER.auth,
      OWNER.app,
      pPa1.person_id,
      pa1PersonInactiveRow.version,
      "KT-WP8A-01",
      updatedPersonName,
      "2025-01-01",
      "ACTIVE",
      "Kích hoạt lại và cập nhật tên WP3",
      nextUuid(),
      sha256(`reactivate-pa1:${seq}`),
    ]);

    const pa1RenamedDetail = await salRepo.getRequestDetail({
      auth_subject: PA_1.auth,
      app_user_id: PA_1.app,
      request_id: preSalReqId,
    });
    assert.equal(pa1RenamedDetail.ok, true);
    assert.equal(pa1RenamedDetail.data.request.current_project_accountant.display_name, updatedPersonName);

    // Historical pre-migration VFIN entry snapshot must remain immutable!
    const { rows: [histAfterRename] } = await db.query(
      "select created_by_display_name_snapshot from public.vendor_finance_entries where entry_id = $1::uuid",
      [preEntryId],
    );
    assert.equal(histAfterRename.created_by_display_name_snapshot, preEntryRecordedName);

    // =========================================================================
    // E. Unlinked `.kt` Compat Account + Unassigned Accounting + SHARED + SERVICE (`n8n_bod_readonly`)
    // =========================================================================
    // E1. Valid unlinked `.kt` account works on both Salary Advance & Vendor Finance
    const ktReqRes = await salRepo.createRequest({
      auth_subject: PM_1.auth,
      app_user_id: PM_1.app,
      project_id: PRJ_3,
      worker_entry_id: workerP3,
      requested_amount_vnd: "1500000",
      initial_content: "Ứng lương dự án 3 cho unlinked .kt",
      idempotency_key: "wp8a-kt-req-01",
      request_fingerprint: computeCreateRequestFingerprint({
        project_id: PRJ_3,
        worker_entry_id: workerP3,
        requested_amount_vnd: "1500000",
        initial_content: "Ứng lương dự án 3 cho unlinked .kt",
      }),
      payment_method: "CASH",
    });
    assert.equal(ktReqRes.ok, true);
    const ktApprove = await salRepo.transitionRequest({
      auth_subject: PA_UNLINKED_KT.auth,
      app_user_id: PA_UNLINKED_KT.app,
      request_id: ktReqRes.data.request.request_id,
      action: "APPROVE",
      expected_version: 1,
      message_text: "Unlinked .kt duyệt hợp lệ",
      idempotency_key: "wp8a-kt-approve-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: ktReqRes.data.request.request_id,
        action: "APPROVE",
        expected_version: 1,
        message_text: "Unlinked .kt duyệt hợp lệ",
      }),
    });
    assert.equal(ktApprove.ok, true);
    assert.equal(ktApprove.data.request.request_state, "APPROVED");

    const ktVfAccess = await vfinRepo.getActorAccess({ auth_subject: PA_UNLINKED_KT.auth, app_user_id: PA_UNLINKED_KT.app });
    assert.equal(ktVfAccess.ok, true);
    assert.equal(ktVfAccess.data.allowed, true);
    assert.equal(ktVfAccess.data.active_assigned_project_count, 1);

    // E2. Unassigned ACCOUNTING member: Salary Advance denied; VFIN sees 0 assigned projects & 0 vendors, writes denied
    const unSal = await salRepo.getActorContext({ auth_subject: UNASSIGNED_ACCT.auth, app_user_id: UNASSIGNED_ACCT.app });
    assert.deepEqual(unSal, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });
    const unVfAccess = await vfinRepo.getActorAccess({ auth_subject: UNASSIGNED_ACCT.auth, app_user_id: UNASSIGNED_ACCT.app });
    assert.equal(unVfAccess.ok, true);
    assert.equal(unVfAccess.data.active_assigned_project_count, 0);
    assert.equal(unVfAccess.data.can_view_shared_advance, false);
    const unVfVendors = await vfinRepo.listVendors({
      auth_subject: UNASSIGNED_ACCT.auth,
      app_user_id: UNASSIGNED_ACCT.app,
      search: null,
      active: "all",
      balance_filter: "all",
      project_id: null,
      accountant_ref: null,
      ledger_scope: null,
      contract_type: "all",
      page: 1,
      page_size: 25,
    });
    assert.equal(unVfVendors.ok, true);
    assert.equal(unVfVendors.data.vendors.length, 0);

    // E3. SHARED account blocked everywhere & active PA / Cash Holder cannot be reclassified to SHARED/SERVICE
    const sharedSal = await salRepo.getActorContext({ auth_subject: SHARED_ACC.auth, app_user_id: SHARED_ACC.app });
    assert.deepEqual(sharedSal, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });
    const sharedVf = await vfinRepo.getActorAccess({ auth_subject: SHARED_ACC.auth, app_user_id: SHARED_ACC.app });
    assert.equal(sharedVf.ok, true);
    assert.equal(sharedVf.data.allowed, false);

    // Blocking SHARED/SERVICE reclassification when active VFIN global role or active PA exists
    for (const protectedTarget of [PA_UNLINKED_KT, CASH_HOLDER_USER]) {
      const { rows: [uRow] } = await db.query(
        "select version from public.direct_entry_app_users where app_user_id = $1::uuid",
        [protectedTarget.app],
      );
      await expectServiceRpcError(
        db,
        "org_department_set_account_type_admin",
        [
          OWNER.auth,
          OWNER.app,
          protectedTarget.app,
          "SHARED",
          uRow.version,
          "Thử đổi sang SHARED khi còn phân công tài chính",
          nextUuid(),
          sha256(`block-shared:${protectedTarget.app}:${seq}`),
        ],
        "PT409",
        /ACCOUNT_HAS_PERSON_OR_PERSONAL_ASSIGNMENTS/,
      );
    }

    // E4. SERVICE account (`n8n_bod_readonly`): read-only VFIN succeeds, all VFIN writes fail closed, Salary Advance denied
    const svcSal = await salRepo.getActorContext({ auth_subject: SERVICE_N8N.auth, app_user_id: SERVICE_N8N.app });
    assert.deepEqual(svcSal, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });

    const svcVfAccess = await vfinRepo.getActorAccess({ auth_subject: SERVICE_N8N.auth, app_user_id: SERVICE_N8N.app });
    assert.equal(svcVfAccess.ok, true);
    assert.equal(svcVfAccess.data.allowed, true);
    assert.equal(svcVfAccess.data.can_view, true);
    assert.equal(svcVfAccess.data.can_record, false);
    assert.equal(svcVfAccess.data.can_reconcile, false);
    assert.equal(svcVfAccess.data.can_fund_vendor_advance, false);
    assert.equal(svcVfAccess.data.can_manage_project_assignments, false);

    const svcVendors = await vfinRepo.listVendors({
      auth_subject: SERVICE_N8N.auth,
      app_user_id: SERVICE_N8N.app,
      search: null,
      active: "all",
      balance_filter: "all",
      project_id: null,
      accountant_ref: null,
      ledger_scope: null,
      contract_type: "all",
      page: 1,
      page_size: 25,
    });
    assert.equal(svcVendors.ok, true);
    assert.equal(svcVendors.data.vendors.length, 1);

    const svcMonthly = await vfinRepo.getMonthlyReport({
      auth_subject: SERVICE_N8N.auth,
      app_user_id: SERVICE_N8N.app,
      month: "2026-10",
      project_id: null,
      accountant_ref: null,
      vendor_id: null,
      contract_type: "all",
    });
    assert.equal(svcMonthly.ok, true);

    const svcRecordDenied = await vfinRepo.recordEntry({
      auth_subject: SERVICE_N8N.auth,
      app_user_id: SERVICE_N8N.app,
      vendor_id: VENDOR_1,
      project_id: PRJ_1,
      contract_type: "SEASONAL",
      entry_type: "PAYMENT_RECORDED",
      amount_minor: "1000000",
      effective_date: "2026-10-10",
      reason: "Service account thử ghi sổ",
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordEntryFingerprint({
        actor_app_user_id: SERVICE_N8N.app,
        vendor_id: VENDOR_1,
        project_id: PRJ_1,
        contract_type: "SEASONAL",
        entry_type: "PAYMENT_RECORDED",
        amount_minor: "1000000",
        effective_date: "2026-10-10",
        reason: "Service account thử ghi sổ",
      }),
    });
    assert.equal(svcRecordDenied.ok, false);
    assert.equal(svcRecordDenied.code, "VENDOR_FINANCE_RECORD_DENIED");

    // =========================================================================
    // F. Exact VND BigInt (> Number.MAX_SAFE_INTEGER), Idempotency, OCC & Bad-State Guards
    // =========================================================================
    const BIG_DEBT = "9007199254740993"; // 2^53 + 1
    const BIG_PAY = "1000000000000001";
    const BIG_OFFSET = "5000000";
    const bigDebtKey = nextUuid();
    const bigDebtReason = "Phát sinh nợ vượt MAX_SAFE_INTEGER";
    const bigDebtFp = computeRecordEntryFingerprint({
      actor_app_user_id: PA_1.app,
      vendor_id: VENDOR_1,
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: BIG_DEBT,
      effective_date: "2026-10-12",
      reason: bigDebtReason,
    });
    const bigDebtRes = await vfinRepo.recordEntry({
      auth_subject: PA_1.auth,
      app_user_id: PA_1.app,
      vendor_id: VENDOR_1,
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: BIG_DEBT,
      effective_date: "2026-10-12",
      reason: bigDebtReason,
      idempotency_key: bigDebtKey,
      request_fingerprint: bigDebtFp,
    });
    assert.equal(bigDebtRes.ok, true);
    assert.equal(bigDebtRes.data.replayed, false);
    assert.equal(bigDebtRes.data.entry.amount_minor, BIG_DEBT);
    assert.equal(bigDebtRes.data.entry.created_by_display_name, updatedPersonName, "New entry snapshots updated WP3 Person name");

    // Idempotent replay returns replayed=true
    const bigDebtReplay = await vfinRepo.recordEntry({
      auth_subject: PA_1.auth,
      app_user_id: PA_1.app,
      vendor_id: VENDOR_1,
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: BIG_DEBT,
      effective_date: "2026-10-12",
      reason: bigDebtReason,
      idempotency_key: bigDebtKey,
      request_fingerprint: bigDebtFp,
    });
    assert.equal(bigDebtReplay.ok, true);
    assert.equal(bigDebtReplay.data.replayed, true);
    assert.equal(bigDebtReplay.data.entry.entry_id, bigDebtRes.data.entry.entry_id);

    // Same key + different payload -> idempotency conflict
    const bigDebtConflict = await vfinRepo.recordEntry({
      auth_subject: PA_1.auth,
      app_user_id: PA_1.app,
      vendor_id: VENDOR_1,
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      entry_type: "DEBT_RECORDED",
      amount_minor: "9007199254740995",
      effective_date: "2026-10-12",
      reason: bigDebtReason,
      idempotency_key: bigDebtKey,
      request_fingerprint: computeRecordEntryFingerprint({
        actor_app_user_id: PA_1.app,
        vendor_id: VENDOR_1,
        project_id: PRJ_1,
        contract_type: "OFFICIAL",
        entry_type: "DEBT_RECORDED",
        amount_minor: "9007199254740995",
        effective_date: "2026-10-12",
        reason: bigDebtReason,
      }),
    });
    assert.equal(bigDebtConflict.ok, false);
    assert.equal(bigDebtConflict.code, "VENDOR_FINANCE_IDEMPOTENCY_CONFLICT");

    // Combined payment + shared advance offset with exact bigint arithmetic
    const combReason = "Thanh toán kết hợp khấu trừ ứng chính xác bigint";
    const combRes = await vfinRepo.recordPaymentWithOffset({
      auth_subject: PA_1.auth,
      app_user_id: PA_1.app,
      vendor_id: VENDOR_1,
      project_id: PRJ_1,
      contract_type: "OFFICIAL",
      payment_amount_minor: BIG_PAY,
      offset_amount_minor: BIG_OFFSET,
      effective_date: "2026-10-15",
      reason: combReason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeRecordPaymentWithOffsetFingerprint({
        actor_app_user_id: PA_1.app,
        vendor_id: VENDOR_1,
        project_id: PRJ_1,
        contract_type: "OFFICIAL",
        payment_amount_minor: BIG_PAY,
        offset_amount_minor: BIG_OFFSET,
        effective_date: "2026-10-15",
        reason: combReason,
      }),
    });
    assert.equal(combRes.ok, true);
    const expectedOfficialBalance = (BigInt(BIG_DEBT) - BigInt(BIG_PAY) - BigInt(BIG_OFFSET)).toString();
    assert.equal(combRes.data.payment_entry.amount_minor, BIG_PAY);
    assert.equal(combRes.data.offset_entry.amount_minor, BIG_OFFSET);
    assert.equal(combRes.data.movement.amount_minor, BIG_OFFSET);
    assert.equal(combRes.data.offset_entry.balance_after_minor, expectedOfficialBalance);
    assert.equal(combRes.data.shared_advance_balance_minor, "15000000");

    // Verify SEASONAL sub-ledger was NOT cross-netted (still exact 65,000,000)
    const seasonalDetail = await vfinRepo.getVendor({
      auth_subject: PA_1.auth,
      app_user_id: PA_1.app,
      vendor_id: VENDOR_1,
      project_id: PRJ_1,
      accountant_ref: PA_1.app,
      ledger_scope: "PROJECT_ACCOUNTANT",
      contract_type: "SEASONAL",
    });
    assert.equal(seasonalDetail.ok, true);
    assert.equal(seasonalDetail.data.vendor.current_balance_minor, "65000000");

    // Governance admin list parsers (old-Web compatibility)
    const paAdminList = await vfinRepo.listProjectAccountantsAdmin({
      auth_subject: OWNER.auth,
      app_user_id: OWNER.app,
      search: null,
      include_history: true,
      page: 1,
      page_size: 25,
    });
    assert.equal(paAdminList.ok, true);
    assert.ok(paAdminList.data.eligible_accountants.some((a) => a.account_ref === PA_1.app && a.display_name === updatedPersonName));

    const grAdminList = await serviceRpc(db, "vendor_finance_list_global_roles_admin", [
      OWNER.auth,
      OWNER.app,
      null,
      true,
      1,
      25,
    ]);
    assert.ok(grAdminList.roles.some((r) => r.role_grant_id === cashHolderRoleRes.role_grant_id));

    // Salary Advance OCC conflict + bad state + spoofed auth_subject fail closed
    const staleVersionRes = await salRepo.transitionRequest({
      auth_subject: PA_1.auth,
      app_user_id: PA_1.app,
      request_id: preSalReqId,
      action: "APPROVE",
      expected_version: 99,
      message_text: null,
      idempotency_key: "wp8a-stale-occ-01",
      request_fingerprint: computeTransitionRequestFingerprint({
        request_id: preSalReqId,
        action: "APPROVE",
        expected_version: 99,
        message_text: null,
      }),
    });
    assert.deepEqual(staleVersionRes, { ok: false, code: "SALARY_ADVANCE_VERSION_CONFLICT" });

    // Spoofed auth_subject (PM_1 auth_subject paired with PA_1 app_user_id) must fail closed
    await expectServiceRpcError(
      db,
      "salary_advance_get_actor_context",
      [PM_1.auth, PA_1.app],
      "42501",
    );
    await expectServiceRpcError(
      db,
      "vendor_finance_get_actor_access",
      [PM_1.auth, PA_1.app],
      "42501",
    );

    // =========================================================================
    // G. `enabled = false` Hard Block Across All Roles (PA, PM, Cash Holder, Admin)
    // =========================================================================
    await db.query("update public.direct_entry_app_users set enabled = false where app_user_id = $1::uuid", [PA_1.app]);
    await expectServiceRpcError(db, "salary_advance_get_actor_context", [PA_1.auth, PA_1.app], "42501");
    await expectServiceRpcError(db, "vendor_finance_get_actor_access", [PA_1.auth, PA_1.app], "42501");
    await db.query("update public.direct_entry_app_users set enabled = true where app_user_id = $1::uuid", [PA_1.app]);

    // Future valid_from PM assignment is NOT effective PM under WP5B-1 R2 predicate
    await db.query(
      `update public.direct_entry_project_manager_assignments
          set valid_from = public.direct_entry_authorization_date() + 5
        where project_id = $1 and manager_recruiter_id = $2::uuid and is_current = true`,
      [PRJ_2, PM_2.recruiter],
    );
    const pm2FutureStart = await salRepo.listProjectWorkers({
      auth_subject: PM_2.auth,
      app_user_id: PM_2.app,
      project_id: PRJ_2,
      search: null,
      cursor: null,
      page_size: 25,
    });
    assert.deepEqual(pm2FutureStart, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });

    // Restore valid_from and revoke via real direct_entry_unassign_project_manager -> blocked immediately
    await db.query(
      `update public.direct_entry_project_manager_assignments
          set valid_from = '2026-01-01'
        where project_id = $1 and manager_recruiter_id = $2::uuid and is_current = true`,
      [PRJ_2, PM_2.recruiter],
    );
    const { rows: [pm2Assign] } = await db.query(
      `select a.assignment_id, a.version, p.version as project_version
         from public.direct_entry_project_manager_assignments a
         join public.direct_entry_projects p on p.project_id = a.project_id
        where a.project_id = $1 and a.manager_recruiter_id = $2::uuid and a.is_current = true`,
      [PRJ_2, PM_2.recruiter],
    );
    await serviceRpc(db, "direct_entry_unassign_project_manager", [
      OWNER.auth,
      OWNER.app,
      pm2Assign.assignment_id,
      pm2Assign.version,
      pm2Assign.project_version,
      "Thu hồi QLDA dự án 2 kiểm tra WP8A",
      `wp8a-unassign-pm2-${nextUuid()}`,
    ]);
    const pm2Revoked = await salRepo.listProjectWorkers({
      auth_subject: PM_2.auth,
      app_user_id: PM_2.app,
      project_id: PRJ_2,
      search: null,
      cursor: null,
      page_size: 25,
    });
    assert.deepEqual(pm2Revoked, { ok: false, code: "SALARY_ADVANCE_ACCESS_DENIED" });

    // Verify PA_1 assignment ID cleanup works cleanly with OCC
    const endPa1Reason = "Kết thúc phân công PA_1 để kiểm tra governance end";
    const endPa1Res = await vfinRepo.endProjectAccountantAdmin({
      auth_subject: OWNER.auth,
      app_user_id: OWNER.app,
      assignment_id: pa1Assign.assignment_id,
      expected_version: 1,
      valid_to: null,
      reason: endPa1Reason,
      idempotency_key: nextUuid(),
      request_fingerprint: computeEndProjectAccountantFingerprint({
        actor_app_user_id: OWNER.app,
        assignment_id: pa1Assign.assignment_id,
        expected_version: 1,
        valid_to: null,
        reason: endPa1Reason,
      }),
    });
    assert.equal(endPa1Res.ok, true);
  } finally {
    await db.close();
  }
});
