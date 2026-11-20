/**
 * WP8C-2 — Direct Entry / Draft / Create / Catalog / Submission / Document / Portrait /
 * CCCD / Duplicate CCCD / Change Requests / TS API / Session / N8N End-to-End PGlite Suite.
 *
 * Covers:
 *   1. Migration #230 hygiene (0 '@', 0 SAVEPOINT, 0 ALTER DEFAULT PRIVILEGES, 0 '40001',
 *      single outer BEGIN/COMMIT, LF===CRLF SHA-256), atomic rollback safety, exact 337
 *      service_role RPCs (+0 new RPCs), 0 client/PUBLIC EXECUTE, exact STABLE volatility,
 *      direct_entry_catalog_bootstrap_executor ownership & ACL hygiene, and T1B-owned
 *      functions (`direct_entry_resolve_actor_context`,
 *      `direct_entry_authz__internal_resolve_effective_grants`) strictly UNTOUCHED.
 *   2. Group 1 (Draft / Create / Catalog / Submission / Read Projection / Catalog Bootstrap):
 *      BEFORE (#229) vs AFTER (#230) diff on mirror-cleared canonical managed accounts
 *      (RECRUITER, ADMIN, quarantine operational account with 0 person links), stale legacy
 *      blocking on managed EMPLOYEE_BASE, ADMIN own-draft delete fix, `worker-profile/1.2`,
 *      `created_by.login_id` via `chr(64)`, idempotency replay & `PT409` OCC.
 *   3. Group 2 (Document / Portrait Stage / CCCD QR / CCCD Review / Missing Docs /
 *      Duplicate CCCD): BEFORE (#229) vs AFTER (#230) on mirror-cleared canonical actors,
 *      cross-scope dual-role escalation blocks (`HR_OPERATOR + RECRUITER`,
 *      `change_review@ALL + RECRUITER@OWN`), canonical TL/PM+RECRUITER document parity,
 *      suspended/SERVICE hardening on `list_missing_document_workers`, and `PT409` conflicts.
 *   4. Group 3 (Change Requests): BEFORE (#229) vs AFTER (#230) across `resolve_change_request_scope`,
 *      `change_request_audience`, `list_change_requests`, `read_change_request`,
 *      `list_global_change_request_history`, `approve`/`reject`, `ENTRY_VOID`, and
 *      cross-scope `DOCUMENT` CR lock (HR_OPERATOR+RECRUITER+change_review@ALL & TL+RECRUITER
 *      blocked; ADMIN@ALL allowed; `read_change_request` document redaction paired per item).
 *   5. Real SQL (`direct_entry_resolve_actor_context`) -> TS `resolveActor` -> real Direct Entry
 *      APIs (`document-api`, `document-finalize-api`, `cccd-qr-api`, `cccd-review-api`,
 *      `full-profile-api`, `worker-portrait-stage-api`) + `session-bootstrap` +
 *      `auth-session-core` + `resolveN8nBodServiceActor` (`n8n/auth.ts`) + D10 disable/re-enable
 *      + Pre-cutover (`authz_managed = false`) R1 compatibility parity.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { createAuthSessionResponse } from "../src/lib/auth/auth-session-core.ts";
import { canManageProjectMasterFromActor } from "../src/lib/auth/direct-entry-page-access.ts";
import {
  projectClientCapabilities,
  projectClientScopes,
  resolveActor,
} from "../src/lib/auth/direct-entry-v2.ts";
import { getDirectEntryCccdQr } from "../src/lib/direct-entry/cccd-qr-api.ts";
import { getDirectEntryCccdReviewQueue } from "../src/lib/direct-entry/cccd-review-api.ts";
import { resolveActor as resolveDocumentApiActor } from "../src/lib/direct-entry/document-api.ts";
import { previewCccdDocument } from "../src/lib/direct-entry/document-finalize-api.ts";
import { postFullProfileBatch } from "../src/lib/direct-entry/full-profile-api.ts";
import { createDirectEntrySessionResponse } from "../src/lib/direct-entry/session-bootstrap.ts";
import { postWorkerPortraitStage } from "../src/lib/direct-entry/worker-portrait-stage-api.ts";
import { resolveN8nBodServiceActor } from "../src/lib/integrations/n8n/auth.ts";
import { migrationChecksum } from "./lib/migration-validation.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const WP8C1_MIGRATION_NAME = "20261120150000_wp8c1_contextual_tl_pm_guards.sql";
const WP8C2_MIGRATION_NAME = "20261120160000_wp8c2_entry_worker_access.sql";

const PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text);";

const OWNER = {
  auth: "18c20000-0000-4000-8000-000000000001",
  app: "28c20000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner WP8C2",
};
const LUANPT = {
  auth: "18c20000-0000-4000-8000-000000000002",
  app: "28c20000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "18c20000-0000-4000-8000-000000000003",
  app: "28c20000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "18c20000-0000-4000-8000-000000000004",
  app: "28c20000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const ADMIN_M = {
  auth: "18c20000-0000-4000-8000-000000000010",
  app: "28c20000-0000-4000-8000-000000000010",
  email: "admin.m.wp8c2@hrpartner.vn",
  name: "Managed Admin Mirror Cleared",
};
const REC_M = {
  auth: "18c20000-0000-4000-8000-000000000011",
  app: "28c20000-0000-4000-8000-000000000011",
  recruiter: "38c20000-0000-4000-8000-000000000011",
  email: "rec.m.wp8c2@hrpartner.vn",
  name: "Managed Recruiter T1",
};
const QUAR_REC = {
  auth: "18c20000-0000-4000-8000-000000000012",
  app: "28c20000-0000-4000-8000-000000000012",
  recruiter: "38c20000-0000-4000-8000-000000000012",
  email: "quar.rec.wp8c2@hrpartner.vn",
  name: "Quarantine Recruiter No Person",
};
const TL_M = {
  auth: "18c20000-0000-4000-8000-000000000013",
  app: "28c20000-0000-4000-8000-000000000013",
  recruiter: "38c20000-0000-4000-8000-000000000013",
  email: "tl.m.wp8c2@hrpartner.vn",
  name: "Managed TL Plus Recruiter T1",
};
const PM_M = {
  auth: "18c20000-0000-4000-8000-000000000014",
  app: "28c20000-0000-4000-8000-000000000014",
  recruiter: "38c20000-0000-4000-8000-000000000014",
  email: "pm.m.wp8c2@hrpartner.vn",
  name: "Managed PM Plus Recruiter P1",
};
const HR_REC = {
  auth: "18c20000-0000-4000-8000-000000000015",
  app: "28c20000-0000-4000-8000-000000000015",
  recruiter: "38c20000-0000-4000-8000-000000000015",
  email: "hr.rec.wp8c2@hrpartner.vn",
  name: "Dual Role HR Operator Plus Recruiter",
};
const REVIEW_REC = {
  auth: "18c20000-0000-4000-8000-000000000016",
  app: "28c20000-0000-4000-8000-000000000016",
  recruiter: "38c20000-0000-4000-8000-000000000016",
  email: "rev.rec.wp8c2@hrpartner.vn",
  name: "Change Review All Plus Recruiter Own",
};
const EMP_STALE = {
  auth: "18c20000-0000-4000-8000-000000000017",
  app: "28c20000-0000-4000-8000-000000000017",
  email: "emp.stale.wp8c2@hrpartner.vn",
  name: "Employee Base With Stale Legacy",
};
const PRE_CUT = {
  auth: "18c20000-0000-4000-8000-000000000018",
  app: "28c20000-0000-4000-8000-000000000018",
  recruiter: "38c20000-0000-4000-8000-000000000018",
  email: "precut.wp8c2@hrpartner.vn",
  name: "Pre-Cutover Unmanaged Actor",
};
const HR_ONLY = {
  auth: "18c20000-0000-4000-8000-000000000019",
  app: "28c20000-0000-4000-8000-000000000019",
  email: "hr.only.wp8c2@hrpartner.vn",
  name: "Managed HR Operator Only",
};
const SVC_ACC = {
  auth: "18c20000-0000-4000-8000-000000000020",
  app: "28c20000-0000-4000-8000-000000000020",
  recruiter: "38c20000-0000-4000-8000-000000000020",
  email: "svc.wp8c2@hrpartner.vn",
  name: "Service Account WP8C2",
};

const TEAM_1 = "48c20000-0000-4000-8000-000000000001";
const TEAM_2 = "48c20000-0000-4000-8000-000000000002";
const PRJ_1 = "wp8c2-prj-1";
const PRJ_2 = "wp8c2-prj-2";

let seq = 1;
function nextUuid() {
  return `98c20000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
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

async function createDbUpTo(migrations, stopAtName) {
  const db = new PGlite();
  await db.exec(PROLOGUE);
  for (const m of migrations) {
    await db.exec(m.sql);
    if (m.name === stopAtName) break;
  }
  return db;
}

function stripOuterTransaction(sql) {
  const trimmed = sql.trim();
  const withoutBegin = trimmed.replace(/^(?:\s*--[^\r\n]*\r?\n)*\s*begin\s*;\s*/i, "");
  return withoutBegin.replace(/\s*commit\s*;\s*$/i, "\n");
}

async function serviceRpc(db, fnName, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await db.exec("begin");
  try {
    await db.exec("set local role service_role");
    const res = await db.query(`select public.${fnName}(${placeholders}) as res`, args);
    await db.exec("commit");
    return res.rows[0]?.res;
  } catch (err) {
    await db.exec("rollback");
    throw err;
  }
}

async function expectServiceRpcError(db, fnName, args, expectedCode, expectedPattern) {
  let caught = null;
  try {
    await serviceRpc(db, fnName, args);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `Expected ${fnName} to fail with SQLSTATE ${expectedCode}, but it succeeded`);
  assert.equal(
    caught.code,
    expectedCode,
    `Expected SQLSTATE ${expectedCode} on ${fnName}, got ${caught.code}: ${caught.message}`,
  );
  if (expectedPattern) {
    assert.match(caught.message, expectedPattern, `Unexpected message on ${fnName}: ${caught.message}`);
  }
  return caught;
}

async function expectInternalError(db, sql, params, expectedCode, expectedPattern) {
  let caught = null;
  try {
    await db.query(sql, params);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, `Expected query to fail with SQLSTATE ${expectedCode}, but it succeeded`);
  assert.equal(
    caught.code,
    expectedCode,
    `Expected SQLSTATE ${expectedCode}, got ${caught.code}: ${caught.message}`,
  );
  if (expectedPattern) {
    assert.match(caught.message, expectedPattern, `Unexpected message: ${caught.message}`);
  }
  return caught;
}

async function seedAccount(db, user, { enabled = true, accountType = "NORMAL" } = {}) {
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, account_type) values ($1::uuid, $2::uuid, $3, $4, $5)",
    [user.app, user.auth, user.name, enabled, accountType],
  );
}

async function seedRecruiterAndTeam(db, user, teamId) {
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, $2, true)",
    [user.recruiter, user.name],
  );
  await db.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2026-01-01', true)",
    [user.recruiter],
  );
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
    [user.recruiter, teamId],
  );
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
    [user.app, user.recruiter],
  );
}

async function assignGlobalRole(db, actor, target, roleCode, reason) {
  const ver = (
    await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [target.app])
  ).rows[0].version;
  const key = nextUuid();
  return serviceRpc(db, "direct_entry_authz_assign_global_role_admin", [
    actor.auth,
    actor.app,
    target.app,
    roleCode,
    ver,
    reason,
    key,
    sha256(`assign:${target.app}:${roleCode}:${key}`),
  ]);
}

async function createDirectGrant(db, actor, target, items, reason) {
  for (const item of items) {
    await db.query(
      `insert into public.authz_direct_capability_grants
         (app_user_id, capability, scope_kind, scope_id, source_kind, reason, granted_by_app_user_id)
       values ($1::uuid, $2, $3, $4, 'EXCEPTION_GRANT', $5, $6::uuid)`,
      [target.app, item.capability, item.scope_kind, item.scope_id ?? null, reason, actor.app],
    );
  }
}

async function clearLegacyMirrors(db, appUserIds) {
  await db.query("select set_config('direct_entry.team_leader_marker', 'on', false)");
  for (const appId of appUserIds) {
    await db.query(
      "update public.direct_entry_capability_grants set is_current = false, valid_to = valid_from where app_user_id = $1::uuid and is_current",
      [appId],
    );
    await db.query(
      "update public.direct_entry_scope_grants set is_current = false, valid_to = valid_from where app_user_id = $1::uuid and is_current",
      [appId],
    );
  }
  await db.query("select set_config('direct_entry.team_leader_marker', 'off', false)");
}

async function seedWorld(db) {
  await db.query(
    "insert into public.teams (team_id, code, display_name, active) values ($1::uuid, 't1_wp8c2', 'Team 1 WP8C2', true), ($2::uuid, 't2_wp8c2', 'Team 2 WP8C2', true)",
    [TEAM_1, TEAM_2],
  );
  await db.query(
    "insert into public.direct_entry_projects (project_id, display_name, active) values ($1, 'Project One WP8C2', true), ($2, 'Project Two WP8C2', true)",
    [PRJ_1, PRJ_2],
  );
  await db.query(
    "insert into public.direct_entry_banks (bank_id, display_name, active) values ('vcb', 'Vietcombank', true)",
  );

  for (const u of [OWNER, LUANPT, LIENVU, NGATTT, ADMIN_M, REC_M, QUAR_REC, TL_M, PM_M, HR_REC, REVIEW_REC, EMP_STALE, HR_ONLY]) {
    await seedAccount(db, u);
  }
  await seedAccount(db, SVC_ACC, { accountType: "SERVICE" });

  await db.query(
    "insert into public.direct_entry_project_team_scopes (project_id, team_id, valid_from, is_current, version, granted_by_user_id) values ($1, $2::uuid, '2026-01-01', true, 1, $5::uuid), ($3, $4::uuid, '2026-01-01', true, 1, $5::uuid)",
    [PRJ_1, TEAM_1, PRJ_2, TEAM_2, OWNER.app],
  );

  // Bootstrap canonical Owner/BoD legacy grants before WP5 cutover (matches WP5 manifest exact 0 unexpected diffs)
  const adminSeedCaps = [
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
  ];
  for (const adm of [OWNER, LIENVU, NGATTT]) {
    for (const cap of adminSeedCaps) {
      await db.query(
        "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
        [adm.app, cap],
      );
    }
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2026-01-01', true), ($1::uuid, 'own', null, '2026-01-01', true)",
      [adm.app],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2026-01-01', true)",
    [LUANPT.app],
  );

  // Run canonical WP5 cutover for all seeded accounts above
  const cutoverPlan = await runWp5Cutover(db, { mode: "read-only-plan" });
  assert.equal(cutoverPlan.action_diff.unexpected_diff_count, 0, "WP5 cutover plan must have 0 unexpected diffs");
  const cutoverResult = await runWp5Cutover(db, {
    mode: "apply",
    confirmApply: true,
    expectedFingerprint: cutoverPlan.manifest_fingerprint,
  });
  assert.equal(cutoverResult.status, "APPLIED", "WP5 cutover must succeed");

  for (const u of [REC_M, QUAR_REC, TL_M, PM_M, HR_REC, REVIEW_REC]) {
    await seedRecruiterAndTeam(db, u, TEAM_1);
  }

  // Assign canonical roles via WP5 admin RPCs
  await assignGlobalRole(db, OWNER, ADMIN_M, "ADMIN", "WP8C2 seed managed admin");
  await assignGlobalRole(db, OWNER, REC_M, "RECRUITER", "WP8C2 seed managed recruiter");
  await assignGlobalRole(db, OWNER, QUAR_REC, "RECRUITER", "WP8C2 seed quarantine recruiter");
  await assignGlobalRole(db, OWNER, TL_M, "RECRUITER", "WP8C2 seed TL+recruiter");
  await assignGlobalRole(db, OWNER, PM_M, "RECRUITER", "WP8C2 seed PM+recruiter");
  await assignGlobalRole(db, OWNER, HR_REC, "HR_OPERATOR", "WP8C2 seed HR+recruiter");
  await assignGlobalRole(db, OWNER, HR_REC, "RECRUITER", "WP8C2 seed HR+recruiter");
  await assignGlobalRole(db, OWNER, REVIEW_REC, "RECRUITER", "WP8C2 seed review+recruiter");
  await assignGlobalRole(db, OWNER, HR_ONLY, "HR_OPERATOR", "WP8C2 seed HR only");

  // Direct grant change_review @ ALL (WITHOUT document_view/document_upload @ ALL) for REVIEW_REC
  await createDirectGrant(
    db,
    OWNER,
    REVIEW_REC,
    [{ capability: "change_review", scope_kind: "ALL", scope_id: null }],
    "WP8C2 change_review@ALL without doc@ALL",
  );

  // Assign TL_M as canonical Team Leader of TEAM_1
  const teamVer = (
    await db.query("select version from public.teams where team_id = $1::uuid", [TEAM_1])
  ).rows[0].version;
  await serviceRpc(db, "direct_entry_designate_team_leader", [
    OWNER.auth,
    OWNER.app,
    TEAM_1,
    TL_M.app,
    null,
    teamVer,
    "WP8C2 assign TL_M",
    nextUuid(),
  ]);

  // Assign PM_M as canonical Project Manager of PRJ_1
  const prjVer = (
    await db.query("select version from public.direct_entry_projects where project_id = $1", [PRJ_1])
  ).rows[0].version;
  await serviceRpc(db, "direct_entry_assign_project_manager", [
    OWNER.auth,
    OWNER.app,
    PRJ_1,
    PM_M.recruiter,
    null,
    prjVer,
    "WP8C2 assign PM_M",
    nextUuid(),
  ]);

  // Seed SVC_ACC with raw drifted recruiter link + PM assignment on PRJ_2 post-cutover (must be ignored by canonical PM guard!)
  await seedRecruiterAndTeam(db, SVC_ACC, TEAM_2);
  await db.query(
    "insert into public.direct_entry_project_manager_assignments (project_id, manager_recruiter_id, valid_from, is_current) values ($1, $2::uuid, '2026-01-01', true)",
    [PRJ_2, SVC_ACC.recruiter],
  );

  // Ensure QUAR_REC truly has 0 organization_account_person_links rows (quarantine operational account)
  const quarPersonLinks = await db.query(
    "select count(*)::int as cnt from public.organization_account_person_links where app_user_id = $1::uuid",
    [QUAR_REC.app],
  );
  assert.equal(quarPersonLinks.rows[0].cnt, 0, "QUAR_REC must have 0 person links");

  // Clear ALL legacy mirrors for every managed test account
  await clearLegacyMirrors(db, [
    ADMIN_M.app,
    REC_M.app,
    QUAR_REC.app,
    TL_M.app,
    PM_M.app,
    HR_REC.app,
    REVIEW_REC.app,
    HR_ONLY.app,
    EMP_STALE.app,
  ]);

  // Inject STALE legacy capability & scope grants on managed EMP_STALE (authz_managed=true, effective_grants=[])
  for (const cap of [
    "entry_admin",
    "entry_create",
    "entry_own",
    "submission_create",
    "document_upload",
    "document_view",
    "change_review",
    "change_request_create",
    "entry_privileged_edit",
    "duplicate_cccd_withdraw",
    "recruiter_master_manage",
    "team_master_manage",
  ]) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
      [EMP_STALE.app, cap],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'all', null, '2026-01-01', true), ($1::uuid, 'own', null, '2026-01-01', true)",
    [EMP_STALE.app],
  );

  // Seed pre-cutover unmanaged account AFTER WP5 cutover (`authz_managed = false`)
  await seedAccount(db, PRE_CUT);
  await seedRecruiterAndTeam(db, PRE_CUT, TEAM_1);
  for (const cap of [
    "entry_create",
    "entry_own",
    "submission_create",
    "document_upload",
    "document_view",
    "change_request_create",
    "duplicate_cccd_withdraw",
  ]) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
      [PRE_CUT.app, cap],
    );
  }
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current) values ($1::uuid, 'own', null, '2026-01-01', true)",
    [PRE_CUT.app],
  );
}

function makeFullProfileRow({
  projectId = PRJ_1,
  recruiterId = REC_M.recruiter,
  code = "hrp-2026-000101",
  name = "Nguyen Van Mot",
  cccd = "012345678901",
  firstWorkDate = "2026-03-01",
  employment = null,
} = {}) {
  return {
    project_id: projectId,
    first_work_date: firstWorkDate,
    employee_code: code,
    recruiter_id: recruiterId,
    labor_type: "TEMPORARY",
    display_name: name,
    worker_details: {
      gender: { state: "provided", value: "OTHER" },
      date_of_birth: { state: "omitted" },
      national_id: { state: "provided", value: cccd },
      national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    general_note: { state: "omitted" },
    payment: null,
    employment,
  };
}

async function resolveViaRealRpc(db, authSubject) {
  const raw = await serviceRpc(db, "direct_entry_resolve_actor_context", [authSubject]);
  const at = new Date().toISOString();
  const resolution = await resolveActor({
    session: { provider: "supabase", auth_subject: authSubject, authenticated_at: at },
    at,
    repository: {
      loadByAuthSubject: async (sub) => {
        assert.equal(sub, authSubject);
        return raw;
      },
    },
  });
  return { raw, resolution };
}

test("WP8C-2 #1: Migration #230 hygiene, atomic rollback, exact 337 RPCs, executor ACL & T1B untouched", async () => {
  const migrations = await loadMigrations();
  const wp8c2 = migrations.find((m) => m.name === WP8C2_MIGRATION_NAME);
  assert.ok(wp8c2, `Missing migration ${WP8C2_MIGRATION_NAME}`);

  // Hygiene checks (strip SQL line comments so header prose never false-positives)
  const sqlNoComments = wp8c2.sql.replace(/--[^\r\n]*/g, "");
  const sqlBeforeSelfCheck = sqlNoComments.split("do $check_wp8c2$")[0];
  assert.equal(wp8c2.sql.includes("@"), false, "Migration #230 must contain zero literal '@' characters");
  assert.equal(/\bsavepoint\b/i.test(sqlNoComments), false, "Migration #230 must contain zero SAVEPOINT");
  assert.equal(/\balter\s+default\s+privileges\b/i.test(sqlNoComments), false, "Zero ALTER DEFAULT PRIVILEGES");
  assert.equal(/'40001'/.test(sqlBeforeSelfCheck), false, "Zero '40001' SQLSTATE regressions (must use PT409)");
  const lfHash = migrationChecksum(wp8c2.sql.replace(/\r\n/g, "\n"));
  const crlfHash = migrationChecksum(wp8c2.sql.replace(/\r?\n/g, "\r\n"));
  assert.equal(lfHash, crlfHash, "LF and CRLF checksums must match");

  const db = await createDbUpTo(migrations, WP8C1_MIGRATION_NAME);
  try {
    const beforeSr = (
      await db.query(
        "select count(*)::int as c from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('service_role', p.oid, 'EXECUTE')",
      )
    ).rows[0].c;
    assert.equal(beforeSr, 337);

    const beforeT1bActor = (
      await db.query(
        "select pg_get_functiondef('public.direct_entry_resolve_actor_context(uuid)'::regprocedure) as d",
      )
    ).rows[0].d;
    const beforeT1bGrants = (
      await db.query(
        "select pg_get_functiondef('public.direct_entry_authz__internal_resolve_effective_grants(uuid)'::regprocedure) as d",
      )
    ).rows[0].d;
    const beforeDraftDef = (
      await db.query(
        "select pg_get_functiondef('public.direct_entry_assert_draft_access(uuid,uuid,uuid,uuid,date,text)'::regprocedure) as d",
      )
    ).rows[0].d;

    // Atomic rollback test
    await db.exec("begin;\n" + stripOuterTransaction(wp8c2.sql) + "\nrollback;");
    const afterRollbackDraftDef = (
      await db.query(
        "select pg_get_functiondef('public.direct_entry_assert_draft_access(uuid,uuid,uuid,uuid,date,text)'::regprocedure) as d",
      )
    ).rows[0].d;
    assert.equal(afterRollbackDraftDef, beforeDraftDef, "Rollback must leave DB byte-identical");

    // Apply #230 cleanly
    await db.exec(wp8c2.sql);

    const afterSr = (
      await db.query(
        "select count(*)::int as c from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and has_function_privilege('service_role', p.oid, 'EXECUTE')",
      )
    ).rows[0].c;
    assert.equal(afterSr, 337, "WP8C-2 must add +0 new service_role RPCs (exact 337)");

    const clientLeaks = (
      await db.query(
        "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and (has_function_privilege('public', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))",
      )
    ).rows;
    assert.deepEqual(clientLeaks, [], "Zero PUBLIC/anon/authenticated EXECUTE grants allowed");

    // Verify T1B-owned functions are byte-for-byte untouched
    const afterT1bActor = (
      await db.query(
        "select pg_get_functiondef('public.direct_entry_resolve_actor_context(uuid)'::regprocedure) as d",
      )
    ).rows[0].d;
    const afterT1bGrants = (
      await db.query(
        "select pg_get_functiondef('public.direct_entry_authz__internal_resolve_effective_grants(uuid)'::regprocedure) as d",
      )
    ).rows[0].d;
    assert.equal(afterT1bActor, beforeT1bActor, "T1B direct_entry_resolve_actor_context must stay untouched");
    assert.equal(afterT1bGrants, beforeT1bGrants, "T1B direct_entry_authz__internal_resolve_effective_grants must stay untouched");

    // Verify executor ownership & hygiene
    const execCheck = (
      await db.query(`
        select pg_get_userbyid(p1.proowner) as plan_owner,
               pg_get_userbyid(p2.proowner) as apply_owner,
               has_schema_privilege('direct_entry_catalog_bootstrap_executor', 'public', 'CREATE') as has_create,
               has_function_privilege('direct_entry_catalog_bootstrap_executor', 'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)'::regprocedure, 'EXECUTE') as exec_paired
          from pg_proc p1, pg_proc p2
         where p1.oid = 'public.direct_entry_catalog_bootstrap_plan(uuid,uuid)'::regprocedure
           and p2.oid = 'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)'::regprocedure
      `)
    ).rows[0];
    assert.deepEqual(execCheck, {
      plan_owner: "direct_entry_catalog_bootstrap_executor",
      apply_owner: "direct_entry_catalog_bootstrap_executor",
      has_create: false,
      exec_paired: true,
    });
  } finally {
    await db.close();
  }
});

test("WP8C-2 #2: Group 1 (Draft / Create / Catalog / Submission / Read Projection / Bootstrap) BEFORE #229 vs AFTER #230", async () => {
  const migrations = await loadMigrations();
  const wp8c2 = migrations.find((m) => m.name === WP8C2_MIGRATION_NAME);
  const db = await createDbUpTo(migrations, WP8C1_MIGRATION_NAME);

  try {
    await seedWorld(db);

    // --- BEFORE (#229): Mirror-cleared canonical RECRUITER & ADMIN FAIL ---
    await expectInternalError(
      db,
      "select public.direct_entry_create_authority($1::uuid, $2::uuid, $3, '2026-03-01'::date)",
      [REC_M.auth, REC_M.app, PRJ_1],
      "42501",
      /worker create authority denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_input_catalog",
      [REC_M.auth, REC_M.app, "2026-03-01"],
      "42501",
      /actor capability denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_create_full_profile_batch",
      [ADMIN_M.auth, ADMIN_M.app, "worker-profile/1.0", JSON.stringify([makeFullProfileRow()]), nextUuid()],
      "42501",
      /worker create authority denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_catalog_bootstrap_plan",
      [ADMIN_M.auth, ADMIN_M.app],
      "42501",
      /catalog bootstrap capability denied/,
    );

    // --- APPLY #230 ---
    await db.exec(wp8c2.sql);

    // --- AFTER (#230): Mirror-cleared canonical RECRUITER, QUARANTINE RECRUITER & ADMIN SUCCEED ---
    const recAuth = (
      await db.query(
        "select public.direct_entry_create_authority($1::uuid, $2::uuid, $3, '2026-03-01'::date) as a",
        [REC_M.auth, REC_M.app, PRJ_1],
      )
    ).rows[0].a;
    assert.equal(recAuth, "legacy");
    const quarAuth = (
      await db.query(
        "select public.direct_entry_create_authority($1::uuid, $2::uuid, $3, '2026-03-01'::date) as a",
        [QUAR_REC.auth, QUAR_REC.app, PRJ_1],
      )
    ).rows[0].a;
    assert.equal(quarAuth, "legacy", "Quarantine operational account (0 person links) retains create authority");
    const adminAuth = (
      await db.query(
        "select public.direct_entry_create_authority($1::uuid, $2::uuid, $3, '2026-03-01'::date) as a",
        [ADMIN_M.auth, ADMIN_M.app, PRJ_1],
      )
    ).rows[0].a;
    assert.equal(adminAuth, "legacy");

    // Catalog read succeeds for mirror-cleared RECRUITER, PM & ADMIN, denied for EMP_STALE & HR_ONLY
    const recCatalog = await serviceRpc(db, "direct_entry_input_catalog", [REC_M.auth, REC_M.app, "2026-03-01"]);
    assert.ok(Array.isArray(recCatalog.recruiters) && recCatalog.recruiters.length >= 1);
    assert.ok(Array.isArray(recCatalog.projects) && recCatalog.projects.length === 0, "Non-PM RECRUITER has 0 direct-access projects");
    const pmCatalog = await serviceRpc(db, "direct_entry_input_catalog", [PM_M.auth, PM_M.app, "2026-03-01"]);
    assert.ok(Array.isArray(pmCatalog.projects) && pmCatalog.projects.some((p) => p.project_id === PRJ_1));
    const adminCatalog = await serviceRpc(db, "direct_entry_input_catalog", [ADMIN_M.auth, ADMIN_M.app, "2026-03-01"]);
    assert.ok(Array.isArray(adminCatalog.projects) && adminCatalog.projects.length >= 2);
    await expectServiceRpcError(
      db,
      "direct_entry_input_catalog",
      [EMP_STALE.auth, EMP_STALE.app, "2026-03-01"],
      "42501",
      /actor capability denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_input_catalog",
      [HR_ONLY.auth, HR_ONLY.app, "2026-03-01"],
      "42501",
      /actor capability denied/,
    );

    // Catalog bootstrap plan succeeds for mirror-cleared ADMIN, denied for RECRUITER & EMP_STALE
    const plan = await serviceRpc(db, "direct_entry_catalog_bootstrap_plan", [ADMIN_M.auth, ADMIN_M.app]);
    assert.equal(plan.catalog_empty, false);
    await expectServiceRpcError(
      db,
      "direct_entry_catalog_bootstrap_plan",
      [REC_M.auth, REC_M.app],
      "42501",
      /catalog bootstrap capability denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_catalog_bootstrap_plan",
      [EMP_STALE.auth, EMP_STALE.app],
      "42501",
      /catalog bootstrap capability denied/,
    );

    // Full-profile batch create (1.2 + idempotent replay + OFF status gate)
    const batchKey1 = nextUuid();
    const batch1 = await serviceRpc(db, "direct_entry_create_full_profile_batch", [
      REC_M.auth,
      REC_M.app,
      "worker-profile/1.2",
      JSON.stringify([makeFullProfileRow({ code: "hrp-2026-000101", cccd: "012345678901" })]),
      batchKey1,
    ]);
    assert.equal(batch1.state, "DRAFT");
    assert.equal(batch1.replayed, false);
    const batch1Replay = await serviceRpc(db, "direct_entry_create_full_profile_batch", [
      REC_M.auth,
      REC_M.app,
      "worker-profile/1.2",
      JSON.stringify([makeFullProfileRow({ code: "hrp-2026-000101", cccd: "012345678901" })]),
      batchKey1,
    ]);
    assert.equal(batch1Replay.replayed, true);
    assert.equal(batch1Replay.submission_id, batch1.submission_id);

    // RECRUITER cannot create with initial_status=OFF (lacks employment_status.apply), ADMIN_M CAN!
    await expectServiceRpcError(
      db,
      "direct_entry_create_full_profile_batch",
      [
        REC_M.auth,
        REC_M.app,
        "worker-profile/1.0",
        JSON.stringify([
          makeFullProfileRow({
            code: "hrp-2026-000102",
            cccd: "012345678902",
            employment: { initial_status: "OFF", leave_date: "2026-03-02", leave_reason_text: "Resigned" },
          }),
        ]),
        nextUuid(),
      ],
      "42501",
      /capability denied/,
    );
    const adminDraftBatch = await serviceRpc(db, "direct_entry_create_full_profile_batch", [
      ADMIN_M.auth,
      ADMIN_M.app,
      "worker-profile/1.0",
      JSON.stringify([
        makeFullProfileRow({
          code: "hrp-2026-000102",
          cccd: "012345678902",
          employment: { initial_status: "OFF", leave_date: "2026-03-02", leave_reason_text: "Resigned" },
        }),
      ]),
      nextUuid(),
    ]);
    assert.equal(adminDraftBatch.state, "DRAFT");

    // List own drafts + update payment + apply draft employment status on REC_M's own draft
    const ownDrafts = await serviceRpc(db, "direct_entry_list_own_drafts", [REC_M.auth, REC_M.app]);
    assert.ok(ownDrafts.drafts.some((d) => d.entry_id === batch1.entry_ids[0]));

    const payRes = await serviceRpc(db, "direct_entry_update_payment", [
      REC_M.auth,
      REC_M.app,
      batch1.entry_ids[0],
      1,
      0,
      JSON.stringify({
        state: "provided",
        account_number: "1234567890",
        bank_id: "vcb",
        account_holder_name: "NGUYEN VAN MOT",
      }),
      "Update draft payment",
      nextUuid(),
    ]);
    assert.equal(payRes.entry_version, 2);

    const statusRes = await serviceRpc(db, "direct_entry_apply_draft_employment_status", [
      REC_M.auth,
      REC_M.app,
      batch1.entry_ids[0],
      2,
      "OFF",
      "2026-03-02",
      "Draft off check",
      "Draft status check",
      nextUuid(),
    ]);
    assert.equal(statusRes.status, "OFF");

    // Read projection: verifies `created_by.login_id` parsed cleanly via `chr(64)` and `worker_portrait` exposed
    const proj = await serviceRpc(db, "direct_entry_read_projection", [REC_M.auth, REC_M.app, batch1.entry_ids[0]]);
    assert.equal(proj.created_by.login_id, "rec.m.wp8c2");
    assert.notEqual(proj.worker_portrait, null, "Mirror-cleared RECRUITER sees worker_portrait via document_view@OWN");

    // Preflight + Transition DRAFT -> SUBMITTED + OCC PT409 check
    const preflight = await serviceRpc(db, "direct_entry_submission_duplicate_cccd_preflight", [
      REC_M.auth,
      REC_M.app,
      batch1.submission_id,
    ]);
    assert.equal(preflight.conflict_count, 0);

    // Wrong version -> exact PT409 (NEVER 40001!)
    await expectServiceRpcError(
      db,
      "direct_entry_transition_submission",
      [REC_M.auth, REC_M.app, batch1.submission_id, 99, "SUBMITTED", nextUuid()],
      "PT409",
      /submission version conflict/,
    );

    const trans = await serviceRpc(db, "direct_entry_transition_submission", [
      REC_M.auth,
      REC_M.app,
      batch1.submission_id,
      1,
      "SUBMITTED",
      nextUuid(),
    ]);
    assert.equal(trans.state, "SUBMITTED");

    // ADMIN_M deleting their own draft (verifies 'all' < 'own' shadowing fix + PT409 on wrong version!)
    await expectServiceRpcError(
      db,
      "direct_entry_delete_draft_submission",
      [ADMIN_M.auth, ADMIN_M.app, adminDraftBatch.submission_id, 99, nextUuid()],
      "PT409",
      /submission version conflict/,
    );
    const delRes = await serviceRpc(db, "direct_entry_delete_draft_submission", [
      ADMIN_M.auth,
      ADMIN_M.app,
      adminDraftBatch.submission_id,
      1,
      nextUuid(),
    ]);
    assert.equal(delRes.deleted, true);

    // EMP_STALE (authz_managed=true, effective_grants=[], stale legacy grants present) -> DENIED everywhere!
    await expectInternalError(
      db,
      "select public.direct_entry_assert_draft_access($1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-03-01'::date)",
      [EMP_STALE.auth, EMP_STALE.app, REC_M.app, TEAM_1],
      "42501",
      /draft scope\/capability denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_create_full_profile_batch",
      [
        EMP_STALE.auth,
        EMP_STALE.app,
        "worker-profile/1.0",
        JSON.stringify([makeFullProfileRow({ code: "hrp-2026-000199", cccd: "012345678999" })]),
        nextUuid(),
      ],
      "42501",
      /worker create authority denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_read_projection",
      [EMP_STALE.auth, EMP_STALE.app, batch1.entry_ids[0]],
      "42501",
      /capability denied|resource scope denied/,
    );
  } finally {
    await db.close();
  }
});

test("WP8C-2 #3: Group 2 (Documents, Portrait Stages, CCCD QR/Review, Missing Docs, Duplicate CCCD) BEFORE #229 vs AFTER #230 + Dual-Role Escalation Lock", async () => {
  const migrations = await loadMigrations();
  const wp8c2 = migrations.find((m) => m.name === WP8C2_MIGRATION_NAME);
  const db = await createDbUpTo(migrations, WP8C1_MIGRATION_NAME);

  try {
    await seedWorld(db);

    // Seed a submitted entry owned by REC_M via OWNER first so we can compare BEFORE (#229) vs AFTER (#230)
    // Create a duplicate CCCD cluster owned by PRE_CUT on PRJ_1/2026-03-05
    const dupCccd = "098765432109";
    const dupBatch = await serviceRpc(db, "direct_entry_create_full_profile_batch", [
      PRE_CUT.auth,
      PRE_CUT.app,
      "worker-profile/1.2",
      JSON.stringify([
        makeFullProfileRow({ code: "hrp-2026-000201", cccd: dupCccd, firstWorkDate: "2026-03-05", recruiterId: PRE_CUT.recruiter }),
        makeFullProfileRow({ code: "hrp-2026-000202", cccd: dupCccd, firstWorkDate: "2026-03-05", recruiterId: PRE_CUT.recruiter }),
      ]),
      nextUuid(),
    ]);
    const entryA = dupBatch.entry_ids[0];
    const entryB = dupBatch.entry_ids[1];

    // Reserve & finalize a CCCD_FRONT document on entryA while still DRAFT as PRE_CUT
    const docChecksum = sha256("synthetic-cccd-front-image-bytes");
    const docRes = await serviceRpc(db, "direct_entry_reserve_document_direct_upload", [
      PRE_CUT.auth,
      PRE_CUT.app,
      entryA,
      1,
      "CCCD_FRONT",
      nextUuid(),
      2048,
      "image/jpeg",
      null,
    ]);
    await serviceRpc(db, "direct_entry_finalize_document_direct_upload", [
      PRE_CUT.auth,
      PRE_CUT.app,
      entryA,
      docRes.document_id,
      docRes.entry_version,
      nextUuid(),
      "validated",
      docChecksum,
      2048,
      "image/jpeg",
    ]);

    // Submit the duplicate CCCD batch with confirmed acknowledgement
    const dupPre = await serviceRpc(db, "direct_entry_submission_duplicate_cccd_preflight", [
      PRE_CUT.auth,
      PRE_CUT.app,
      dupBatch.submission_id,
    ]);
    await serviceRpc(db, "direct_entry_transition_submission_duplicate_cccd_confirmed", [
      PRE_CUT.auth,
      PRE_CUT.app,
      dupBatch.submission_id,
      1,
      "SUBMITTED",
      nextUuid(),
      dupPre.fingerprint,
      dupPre.conflict_count,
    ]);

    // --- BEFORE (#229): Mirror-cleared canonical RECRUITER & ADMIN FAIL ---
    await expectServiceRpcError(
      db,
      "direct_entry_create_worker_document_stage_idempotent",
      [REC_M.auth, REC_M.app, nextUuid(), "WORKER_PORTRAIT", "image/jpeg", 1024, sha256("p1"), nextUuid()],
      "42501",
      /capability denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_document_direct_context",
      [ADMIN_M.auth, ADMIN_M.app, entryA, docRes.document_id, "cccd_preview"],
      "42501",
      /document view denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_self_withdraw_duplicate_cccd",
      [ADMIN_M.auth, ADMIN_M.app, entryA, 3, "Admin withdraw duplicate", nextUuid()],
      "42501",
      /self withdraw requires/,
    );
    const beforeDupReport = await serviceRpc(db, "direct_entry_duplicate_cccd_report", [ADMIN_M.auth, ADMIN_M.app, 1, 25, false]);
    assert.equal(beforeDupReport.groups[0].episodes[0].can_self_withdraw, false, "BEFORE #229 mirror-cleared ADMIN loses can_self_withdraw");

    // --- APPLY #230 ---
    await db.exec(wp8c2.sql);

    // --- AFTER (#230): Mirror-cleared Stage Create (REC_M & PM_M) -> Claim -> Batch With Stages -> Complete + PT409 ---
    const recStageId = nextUuid();
    const recStageRes = await serviceRpc(db, "direct_entry_create_worker_document_stage_idempotent", [
      REC_M.auth,
      REC_M.app,
      recStageId,
      "WORKER_PORTRAIT",
      "image/jpeg",
      2048,
      sha256("rec-portrait-bytes-wp8c2"),
      nextUuid(),
    ]);
    assert.equal(recStageRes.replayed, false);

    const stageId = nextUuid();
    const stageCreateKey = nextUuid();
    const stageSha = sha256("portrait-bytes-wp8c2");
    const staged = await serviceRpc(db, "direct_entry_create_worker_document_stage_idempotent", [
      PM_M.auth,
      PM_M.app,
      stageId,
      "WORKER_PORTRAIT",
      "image/jpeg",
      2048,
      stageSha,
      stageCreateKey,
    ]);
    assert.equal(staged.replayed, false);
    const stagedReplay = await serviceRpc(db, "direct_entry_create_worker_document_stage_idempotent", [
      PM_M.auth,
      PM_M.app,
      nextUuid(),
      "WORKER_PORTRAIT",
      "image/jpeg",
      2048,
      stageSha,
      stageCreateKey,
    ]);
    assert.equal(stagedReplay.replayed, true);
    // Conflicting stage payload with same key -> exact PT409!
    await expectServiceRpcError(
      db,
      "direct_entry_create_worker_document_stage_idempotent",
      [PM_M.auth, PM_M.app, nextUuid(), "WORKER_PORTRAIT", "image/jpeg", 4096, sha256("different"), stageCreateKey],
      "PT409",
      /idempotency conflict/,
    );

    const claimKey = nextUuid();
    const claimed = await serviceRpc(db, "direct_entry_claim_worker_portrait_stage", [
      PM_M.auth,
      PM_M.app,
      stageId,
      claimKey,
    ]);
    assert.equal(claimed.status, "CLAIMED");

    const { employee_code: _omitCode, ...v11Row } = makeFullProfileRow({
      code: "hrp-2026-000205",
      cccd: "011122233344",
      recruiterId: PM_M.recruiter,
    });
    void _omitCode;
    const stagedBatch = await serviceRpc(db, "direct_entry_create_full_profile_batch_with_portrait_stages", [
      PM_M.auth,
      PM_M.app,
      "worker-profile/1.1",
      JSON.stringify([{ ...v11Row, provider_type: "hrp" }]),
      claimKey,
      [stageId],
    ]);
    assert.equal(stagedBatch.state, "DRAFT");

    const pRes = await serviceRpc(db, "direct_entry_reserve_document_direct_upload", [
      PM_M.auth,
      PM_M.app,
      stagedBatch.entry_ids[0],
      1,
      "WORKER_PORTRAIT",
      nextUuid(),
      2048,
      "image/jpeg",
      "Stage finalize portrait",
    ]);
    await serviceRpc(db, "direct_entry_finalize_document_direct_upload", [
      PM_M.auth,
      PM_M.app,
      stagedBatch.entry_ids[0],
      pRes.document_id,
      pRes.entry_version,
      nextUuid(),
      "validated",
      stageSha,
      2048,
      "image/jpeg",
    ]);
    const completed = await serviceRpc(db, "direct_entry_complete_worker_document_stage", [
      PM_M.auth,
      PM_M.app,
      stageId,
      claimKey,
      stagedBatch.entry_ids[0],
      pRes.document_id,
    ]);
    assert.equal(completed, true);

    // Document context & CCCD QR read access
    const adminCtx = await serviceRpc(db, "direct_entry_document_direct_context", [
      ADMIN_M.auth,
      ADMIN_M.app,
      entryA,
      docRes.document_id,
      "cccd_preview",
    ]);
    assert.equal(adminCtx.document_id, docRes.document_id);

    // Canonical TL_M + RECRUITER and PM_M + RECRUITER can view & upload on their team / project entries!
    const pmCtx = await serviceRpc(db, "direct_entry_document_direct_context", [
      PM_M.auth,
      PM_M.app,
      entryA,
      docRes.document_id,
      "cccd_preview",
    ]);
    assert.equal(pmCtx.document_id, docRes.document_id);
    const tlCtx = await serviceRpc(db, "direct_entry_document_direct_context", [
      TL_M.auth,
      TL_M.app,
      entryA,
      docRes.document_id,
      "cccd_preview",
    ]);
    assert.equal(tlCtx.document_id, docRes.document_id);
    const pmUploadScope = (
      await db.query(
        "select public.direct_entry_assert_document_upload_access($1::uuid, $2::uuid, $3::uuid) as s",
        [PM_M.auth, PM_M.app, entryA],
      )
    ).rows[0].s;
    assert.equal(pmUploadScope, "project");
    const tlUploadScope = (
      await db.query(
        "select public.direct_entry_assert_document_upload_access($1::uuid, $2::uuid, $3::uuid) as s",
        [TL_M.auth, TL_M.app, entryA],
      )
    ).rows[0].s;
    assert.equal(tlUploadScope, "team");

    // --- CRITICAL CROSS-SCOPE DUAL-ROLE ESCALATION BLOCKS ---
    // 1. HR_REC (`HR_OPERATOR @ ALL` + `RECRUITER @ OWN`) has `document_view @ ALL` and `document_upload @ OWN`,
    //    NOT `document_upload @ ALL`. Even on another user's entry (entryA), HR_REC MUST NOT upload!
    await expectInternalError(
      db,
      "select public.direct_entry_assert_document_upload_access($1::uuid, $2::uuid, $3::uuid)",
      [HR_REC.auth, HR_REC.app, entryA],
      "42501",
      /capability denied|resource scope denied/,
    );
    // 2. REVIEW_REC (`change_review @ ALL` + `RECRUITER @ OWN` -> `document_view @ OWN`, NO `document_view @ ALL`):
    //    Can read entryA via `resolve_submission_read_scope = 'all'`, MUST NOT escalate `document_view @ OWN`
    //    onto entryA (created by PRE_CUT)!
    await expectServiceRpcError(
      db,
      "direct_entry_document_direct_context",
      [REVIEW_REC.auth, REVIEW_REC.app, entryA, docRes.document_id, "cccd_preview"],
      "42501",
      /document view denied/,
    );
    await expectInternalError(
      db,
      "select public.direct_entry__internal_assert_cccd_qr_read_access($1::uuid, $2::uuid, $3::uuid)",
      [REVIEW_REC.auth, REVIEW_REC.app, entryA],
      "42501",
      /cccd qr read denied/,
    );
    const reviewRecProj = await serviceRpc(db, "direct_entry_read_projection", [REVIEW_REC.auth, REVIEW_REC.app, entryA]);
    assert.equal(reviewRecProj.worker_portrait, null, "REVIEW_REC without document_view@ALL must not view other user's portrait metadata");
    assert.deepEqual(reviewRecProj.documents, [], "REVIEW_REC without document_view@ALL must not view other user's documents");
    await expectInternalError(
      db,
      "select public.direct_entry_assert_document_upload_access($1::uuid, $2::uuid, $3::uuid)",
      [REVIEW_REC.auth, REVIEW_REC.app, entryA],
      "42501",
      /capability denied|resource scope denied/,
    );

    // CCCD Review Queue & Missing Document Workers
    const cccdQueueAdmin = await serviceRpc(db, "direct_entry_list_cccd_review_queue", [
      ADMIN_M.auth,
      ADMIN_M.app,
      "ALL",
      1,
      25,
    ]);
    assert.ok(cccdQueueAdmin.total_items >= 2);
    const cccdQueuePm = await serviceRpc(db, "direct_entry_list_cccd_review_queue", [
      PM_M.auth,
      PM_M.app,
      "ALL",
      1,
      25,
    ]);
    assert.ok(cccdQueuePm.total_items >= 2);
    await expectServiceRpcError(
      db,
      "direct_entry_list_cccd_review_queue",
      [EMP_STALE.auth, EMP_STALE.app, "ALL", 1, 25],
      "42501",
      /cccd review queue denied/,
    );

    const missingPm = await serviceRpc(db, "direct_entry_list_missing_document_workers", [
      PM_M.auth,
      PM_M.app,
      "ALL",
      null,
      "ALL",
      null,
      1,
      25,
    ]);
    assert.equal(missingPm.scope_kind, "project");
    assert.equal(missingPm.can_upload, true);
    // P1-1: Managed SERVICE account with drifted raw PM assignment & recruiter link MUST fail closed on BOTH
    // `list_missing_document_workers` and `resolve_submission_read_scope` (aligned with WP8C-1 `worker_directory_audience`).
    await expectServiceRpcError(
      db,
      "direct_entry_list_missing_document_workers",
      [SVC_ACC.auth, SVC_ACC.app, "ALL", null, "ALL", null, 1, 25],
      "42501",
      /MISSING_DOCUMENTS_ACCESS_DENIED/,
    );
    const svcAttributedBatch = await serviceRpc(db, "direct_entry_create_full_profile_batch", [
      ADMIN_M.auth,
      ADMIN_M.app,
      "worker-profile/1.0",
      JSON.stringify([
        makeFullProfileRow({
          projectId: PRJ_2,
          code: "hrp-2026-000291",
          cccd: "077766655541",
          recruiterId: SVC_ACC.recruiter,
        }),
      ]),
      nextUuid(),
    ]);
    await serviceRpc(db, "direct_entry_transition_submission", [
      ADMIN_M.auth,
      ADMIN_M.app,
      svcAttributedBatch.submission_id,
      1,
      "SUBMITTED",
      nextUuid(),
    ]);
    const svcReadScope = (
      await db.query(
        "select public.direct_entry_resolve_submission_read_scope($1::uuid, $2::uuid, $3::uuid) as s",
        [SVC_ACC.auth, SVC_ACC.app, svcAttributedBatch.entry_ids[0]],
      )
    ).rows[0].s;
    assert.equal(svcReadScope, null, "P1-1: Managed SERVICE account must NEVER receive recruited read scope");

    // P1-1 (expired link): Managed NORMAL user with expired (`valid_to <= today`, `is_current=true`) recruiter link
    // MUST fail closed on BOTH `list_missing_document_workers` and `resolve_submission_read_scope`.
    const recAttributedBatch = await serviceRpc(db, "direct_entry_create_full_profile_batch", [
      ADMIN_M.auth,
      ADMIN_M.app,
      "worker-profile/1.0",
      JSON.stringify([
        makeFullProfileRow({
          projectId: PRJ_1,
          code: "hrp-2026-000292",
          cccd: "077766655542",
          recruiterId: REC_M.recruiter,
        }),
      ]),
      nextUuid(),
    ]);
    await serviceRpc(db, "direct_entry_transition_submission", [
      ADMIN_M.auth,
      ADMIN_M.app,
      recAttributedBatch.submission_id,
      1,
      "SUBMITTED",
      nextUuid(),
    ]);
    const recReadScopeActive = (
      await db.query(
        "select public.direct_entry_resolve_submission_read_scope($1::uuid, $2::uuid, $3::uuid) as s",
        [REC_M.auth, REC_M.app, recAttributedBatch.entry_ids[0]],
      )
    ).rows[0].s;
    assert.equal(recReadScopeActive, "recruited", "Active verified link grants recruited scope");
    await db.query(
      "update public.direct_entry_app_user_recruiter_links set valid_to = public.direct_entry_authorization_date() where app_user_id = $1::uuid and is_current",
      [REC_M.app],
    );
    await expectServiceRpcError(
      db,
      "direct_entry_list_missing_document_workers",
      [REC_M.auth, REC_M.app, "ALL", null, "ALL", null, 1, 25],
      "42501",
      /MISSING_DOCUMENTS_ACCESS_DENIED/,
    );
    const recReadScopeExpired = (
      await db.query(
        "select public.direct_entry_resolve_submission_read_scope($1::uuid, $2::uuid, $3::uuid) as s",
        [REC_M.auth, REC_M.app, recAttributedBatch.entry_ids[0]],
      )
    ).rows[0].s;
    assert.equal(recReadScopeExpired, null, "P1-1: Expired verified recruiter link must fail closed");
    await db.query(
      "update public.direct_entry_app_user_recruiter_links set valid_to = null where app_user_id = $1::uuid and is_current",
      [REC_M.app],
    );

    // P2-1: Non-TL `privileged_team` (`entry_privileged_edit @ CONTEXT_TEAM`) + `RECRUITER` (`document_upload @ OWN`)
    // MUST NOT escalate to upload documents onto another user's submitted entry in TEAM_1.
    await createDirectGrant(
      db,
      OWNER,
      REC_M,
      [{ capability: "entry_privileged_edit", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1 }],
      "P2-1 non-TL privileged_team without document_upload@CONTEXT_TEAM",
    );
    await expectInternalError(
      db,
      "select public.direct_entry_assert_document_upload_access($1::uuid, $2::uuid, $3::uuid)",
      [REC_M.auth, REC_M.app, entryA],
      "42501",
      /capability denied/,
    );
    await db.query(
      "update public.authz_direct_capability_grants set ended_at = now(), ended_by_app_user_id = $2::uuid, ended_reason = 'Cleanup P2-1' where app_user_id = $1::uuid and capability = 'entry_privileged_edit' and ended_at is null",
      [REC_M.app, OWNER.app],
    );

    // P2-2: Broader scope shadowing (`entry_admin @ ALL` WITHOUT `document_view/upload @ ALL`) MUST NOT deny creator's OWN entry,
    // while still denying OTHER users' entries. Also verify PM with direct `document_upload @ CONTEXT_PROJECT` on own SUBMITTED entry.
    const recOwnDraftBatch = await serviceRpc(db, "direct_entry_create_full_profile_batch", [
      REC_M.auth,
      REC_M.app,
      "worker-profile/1.2",
      JSON.stringify([makeFullProfileRow({ code: "hrp-2026-000293", cccd: "077766655543" })]),
      nextUuid(),
    ]);
    const recOwnEntryId = recOwnDraftBatch.entry_ids[0];
    const recOwnDocRes = await serviceRpc(db, "direct_entry_reserve_document_direct_upload", [
      REC_M.auth,
      REC_M.app,
      recOwnEntryId,
      1,
      "CCCD_FRONT",
      nextUuid(),
      2048,
      "image/jpeg",
      null,
    ]);
    await serviceRpc(db, "direct_entry_finalize_document_direct_upload", [
      REC_M.auth,
      REC_M.app,
      recOwnEntryId,
      recOwnDocRes.document_id,
      recOwnDocRes.entry_version,
      nextUuid(),
      "validated",
      sha256("rec-own-doc-p2-2"),
      2048,
      "image/jpeg",
    ]);
    await createDirectGrant(
      db,
      OWNER,
      REC_M,
      [{ capability: "entry_admin", scope_kind: "ALL", scope_id: null }],
      "P2-2 entry_admin@ALL without document_*@ALL shadowing test",
    );
    // Own DRAFT entry succeeds across upload, document_direct_context & cccd_qr_read_access despite `v_scope='all'`!
    const ownShadowUploadScope = (
      await db.query(
        "select public.direct_entry_assert_document_upload_access($1::uuid, $2::uuid, $3::uuid) as s",
        [REC_M.auth, REC_M.app, recOwnEntryId],
      )
    ).rows[0].s;
    assert.equal(ownShadowUploadScope, "all");
    const ownShadowCtx = await serviceRpc(db, "direct_entry_document_direct_context", [
      REC_M.auth,
      REC_M.app,
      recOwnEntryId,
      recOwnDocRes.document_id,
      "cccd_preview",
    ]);
    assert.equal(ownShadowCtx.document_id, recOwnDocRes.document_id);
    const ownShadowQrScope = (
      await db.query(
        "select public.direct_entry__internal_assert_cccd_qr_read_access($1::uuid, $2::uuid, $3::uuid) as s",
        [REC_M.auth, REC_M.app, recOwnEntryId],
      )
    ).rows[0].s;
    assert.equal(ownShadowQrScope, "all");
    // Other user's entry (`entryA`) MUST STILL BE DENIED!
    await expectServiceRpcError(
      db,
      "direct_entry_document_direct_context",
      [REC_M.auth, REC_M.app, entryA, docRes.document_id, "cccd_preview"],
      "42501",
      /document view denied/,
    );
    await expectInternalError(
      db,
      "select public.direct_entry__internal_assert_cccd_qr_read_access($1::uuid, $2::uuid, $3::uuid)",
      [REC_M.auth, REC_M.app, entryA],
      "42501",
      /cccd qr read denied/,
    );
    await db.query(
      "update public.authz_direct_capability_grants set ended_at = now(), ended_by_app_user_id = $2::uuid, ended_reason = 'Cleanup P2-2' where app_user_id = $1::uuid and capability = 'entry_admin' and ended_at is null",
      [REC_M.app, OWNER.app],
    );

    // P2-2 (CONTEXT_PROJECT on own SUBMITTED entry): Submit PM_M's own entry, revoke PM_M's RECRUITER role,
    // grant direct `document_upload @ CONTEXT_PROJECT(PRJ_1)` -> MUST succeed on PM_M's OWN submitted entry!
    await serviceRpc(db, "direct_entry_transition_submission", [
      PM_M.auth,
      PM_M.app,
      stagedBatch.submission_id,
      1,
      "SUBMITTED",
      nextUuid(),
    ]);
    const pmRecAssignId = (
      await db.query(
        "select assignment_id from public.authz_account_role_assignments where app_user_id = $1::uuid and role_code = 'RECRUITER' and ended_at is null",
        [PM_M.app],
      )
    ).rows[0].assignment_id;
    await db.query(
      "update public.authz_account_role_assignments set ended_at = now(), ended_by_app_user_id = $2::uuid, ended_reason = 'P2-2 test' where assignment_id = $1::uuid",
      [pmRecAssignId, OWNER.app],
    );
    await createDirectGrant(
      db,
      OWNER,
      PM_M,
      [{ capability: "document_upload", scope_kind: "CONTEXT_PROJECT", scope_id: PRJ_1 }],
      "P2-2 CONTEXT_PROJECT document_upload on own submitted entry",
    );
    const pmOwnSubmittedUploadScope = (
      await db.query(
        "select public.direct_entry_assert_document_upload_access($1::uuid, $2::uuid, $3::uuid) as s",
        [PM_M.auth, PM_M.app, stagedBatch.entry_ids[0]],
      )
    ).rows[0].s;
    assert.equal(pmOwnSubmittedUploadScope, "project", "P2-2: PM with document_upload@CONTEXT_PROJECT can upload to own submitted entry");
    await db.query(
      "update public.authz_direct_capability_grants set ended_at = now(), ended_by_app_user_id = $2::uuid, ended_reason = 'Cleanup P2-2 PM' where app_user_id = $1::uuid and capability = 'document_upload' and ended_at is null",
      [PM_M.app, OWNER.app],
    );
    await assignGlobalRole(db, OWNER, PM_M, "RECRUITER", "Restore PM_M RECRUITER after P2-2");
    await clearLegacyMirrors(db, [PM_M.app]);

    // P2-3: Drifted `TEAM_LEADER` (recruiter moved to TEAM_2 while TL assignment remains TEAM_1) MUST fail closed
    // on `direct_entry_assert_draft_access`, `direct_entry_resolve_submission_read_scope`, and DRAFT upload on another user's TEAM_1 entry,
    // while retaining `own` access on their OWN entry!
    const tlOwnDraftBatch = await serviceRpc(db, "direct_entry_create_full_profile_batch", [
      TL_M.auth,
      TL_M.app,
      "worker-profile/1.0",
      JSON.stringify([makeFullProfileRow({ code: "hrp-2026-000294", cccd: "077766655544", recruiterId: TL_M.recruiter })]),
      nextUuid(),
    ]);
    await db.query(
      "update public.recruiter_team_memberships set team_id = $2::uuid where recruiter_id = $1::uuid and is_current",
      [TL_M.recruiter, TEAM_2],
    );
    await expectInternalError(
      db,
      "select public.direct_entry_assert_draft_access($1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-03-01'::date)",
      [TL_M.auth, TL_M.app, REC_M.app, TEAM_1],
      "42501",
      /draft scope\/capability denied/,
    );
    const driftedTlReadScope = (
      await db.query(
        "select public.direct_entry_resolve_submission_read_scope($1::uuid, $2::uuid, $3::uuid) as s",
        [TL_M.auth, TL_M.app, recOwnEntryId],
      )
    ).rows[0].s;
    assert.equal(driftedTlReadScope, null, "P2-3: Drifted TL must NOT read another user's TEAM_1 entry");
    await expectInternalError(
      db,
      "select public.direct_entry_assert_document_upload_access($1::uuid, $2::uuid, $3::uuid)",
      [TL_M.auth, TL_M.app, recOwnEntryId],
      "42501",
      /capability denied|resource scope denied|draft scope/,
    );
    const driftedTlOwnScope = (
      await db.query(
        "select public.direct_entry_assert_draft_access($1::uuid, $2::uuid, $3::uuid, $4::uuid, '2026-03-01'::date)",
        [TL_M.auth, TL_M.app, TL_M.app, TEAM_1],
      )
    ).rows[0].direct_entry_assert_draft_access;
    assert.equal(driftedTlOwnScope, "own", "P2-3: Drifted TL still retains own scope on own entry");
    assert.ok(tlOwnDraftBatch.entry_ids[0]);
    await db.query(
      "update public.recruiter_team_memberships set team_id = $2::uuid where recruiter_id = $1::uuid and is_current",
      [TL_M.recruiter, TEAM_1],
    );

    // Duplicate CCCD Report + Self-Withdraw (mirror-cleared ADMIN_M succeeds, 2nd row gets PT409!)
    const afterDupReport = await serviceRpc(db, "direct_entry_duplicate_cccd_report", [ADMIN_M.auth, ADMIN_M.app, 1, 25, false]);
    assert.equal(afterDupReport.groups[0].episodes[0].can_self_withdraw, true, "AFTER #230 mirror-cleared ADMIN has can_self_withdraw");
    const entryAVer = (
      await db.query("select version from public.direct_entries where entry_id = $1::uuid", [entryA])
    ).rows[0].version;
    const withdrawRes = await serviceRpc(db, "direct_entry_self_withdraw_duplicate_cccd", [
      ADMIN_M.auth,
      ADMIN_M.app,
      entryA,
      entryAVer,
      "Admin withdraws duplicate",
      nextUuid(),
    ]);
    assert.equal(withdrawRes.entry_id, entryA);
    const withdrawAudit = (
      await db.query(
        "select capability, scope_kind from public.direct_entry_audit_events where action = 'entry_self_withdraw_duplicate_cccd' and resource_ref = $1 order by created_at desc limit 1",
        [entryA],
      )
    ).rows[0];
    assert.deepEqual(withdrawAudit, { capability: "duplicate_cccd_withdraw", scope_kind: "all" });

    // Remaining single row in cluster cannot be withdrawn -> exact PT409 (NEVER 40001!)
    await expectServiceRpcError(
      db,
      "direct_entry_self_withdraw_duplicate_cccd",
      [ADMIN_M.auth, ADMIN_M.app, entryB, 1, "Cannot withdraw last remaining row", nextUuid()],
      "PT409",
      /not an active duplicate/,
    );
  } finally {
    await db.close();
  }
});

test("WP8C-2 #4: Group 3 (Change Requests, ENTRY_VOID, Global History & DOCUMENT Cross-Scope Lock) BEFORE #229 vs AFTER #230", async () => {
  const migrations = await loadMigrations();
  const wp8c2 = migrations.find((m) => m.name === WP8C2_MIGRATION_NAME);
  const db = await createDbUpTo(migrations, WP8C1_MIGRATION_NAME);

  try {
    await seedWorld(db);

    // Seed two SUBMITTED entries by PRE_CUT on PRJ_1 (team TEAM_1)
    const batch = await serviceRpc(db, "direct_entry_create_full_profile_batch", [
      PRE_CUT.auth,
      PRE_CUT.app,
      "worker-profile/1.0",
      JSON.stringify([
        makeFullProfileRow({ code: "hrp-2026-000301", cccd: "031111111111", recruiterId: PRE_CUT.recruiter }),
        makeFullProfileRow({ code: "hrp-2026-000302", cccd: "032222222222", recruiterId: PRE_CUT.recruiter }),
      ]),
      nextUuid(),
    ]);
    await serviceRpc(db, "direct_entry_transition_submission", [
      PRE_CUT.auth,
      PRE_CUT.app,
      batch.submission_id,
      1,
      "SUBMITTED",
      nextUuid(),
    ]);
    const entry1 = batch.entry_ids[0];
    const entry2 = batch.entry_ids[1];

    // PM_M proposes an ENTRY_FIELD change request on entry1 (works under #229 because PM guard is WP8C-1)
    const crField = await serviceRpc(db, "direct_entry_create_change_request", [
      PM_M.auth,
      PM_M.app,
      JSON.stringify([
        {
          entry_id: entry1,
          target_kind: "ENTRY_FIELD",
          expected_version: 1,
          proposal: { employee_code: "hrp-2026-000399" },
        },
      ]),
      "Fix employee code",
      nextUuid(),
    ]);

    // --- BEFORE (#229): Mirror-cleared ADMIN_M & TL_M FAIL on CR review & global history ---
    await expectServiceRpcError(
      db,
      "direct_entry_list_global_change_request_history",
      [ADMIN_M.auth, ADMIN_M.app, 20, null, 30],
      "42501",
      /global change request history denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_approve_change_request",
      [TL_M.auth, TL_M.app, crField.request_id, 1, "TL approve before 230", nextUuid()],
      "42501",
      /capability denied/,
    );
    await expectServiceRpcError(
      db,
      "direct_entry_approve_change_request",
      [ADMIN_M.auth, ADMIN_M.app, crField.request_id, 1, "Admin approve before 230", nextUuid()],
      "42501",
      /capability denied/,
    );

    // --- APPLY #230 ---
    await db.exec(wp8c2.sql);

    // --- AFTER (#230): Mirror-cleared TL_M sees REVIEWER and approves ENTRY_FIELD CR ---
    const tlRead = await serviceRpc(db, "direct_entry_read_change_request", [TL_M.auth, TL_M.app, crField.request_id]);
    assert.equal(tlRead.can_decide, true);
    // OCC wrong version -> exact PT409!
    await expectServiceRpcError(
      db,
      "direct_entry_approve_change_request",
      [TL_M.auth, TL_M.app, crField.request_id, 99, "Stale OCC", nextUuid()],
      "PT409",
      /change request version conflict/,
    );
    const tlApproved = await serviceRpc(db, "direct_entry_approve_change_request", [
      TL_M.auth,
      TL_M.app,
      crField.request_id,
      1,
      "TL canonical approval",
      nextUuid(),
    ]);
    assert.equal(tlApproved.state, "APPROVED");

    // Global CR history + AUDITOR read succeed for mirror-cleared ADMIN_M, denied for EMP_STALE
    const globalHist = await serviceRpc(db, "direct_entry_list_global_change_request_history", [
      ADMIN_M.auth,
      ADMIN_M.app,
      20,
      null,
      30,
    ]);
    assert.ok(globalHist.requests.some((r) => r.request_id === crField.request_id));
    const adminAuditRead = await serviceRpc(db, "direct_entry_read_change_request", [
      ADMIN_M.auth,
      ADMIN_M.app,
      crField.request_id,
    ]);
    assert.equal(adminAuditRead.request_id, crField.request_id);
    await expectServiceRpcError(
      db,
      "direct_entry_list_global_change_request_history",
      [EMP_STALE.auth, EMP_STALE.app, 20, null, 30],
      "42501",
      /global change request history denied/,
    );

    // Mirror-cleared REC_M creates own entry -> submits -> proposes ENTRY_VOID CR -> ADMIN_M approves!
    const recBatch = await serviceRpc(db, "direct_entry_create_full_profile_batch", [
      REC_M.auth,
      REC_M.app,
      "worker-profile/1.0",
      JSON.stringify([makeFullProfileRow({ code: "hrp-2026-000305", cccd: "035555555555" })]),
      nextUuid(),
    ]);
    await serviceRpc(db, "direct_entry_transition_submission", [
      REC_M.auth,
      REC_M.app,
      recBatch.submission_id,
      1,
      "SUBMITTED",
      nextUuid(),
    ]);
    const crVoid = await serviceRpc(db, "direct_entry_create_change_request", [
      REC_M.auth,
      REC_M.app,
      JSON.stringify([
        {
          entry_id: recBatch.entry_ids[0],
          target_kind: "ENTRY_VOID",
          expected_version: 1,
          proposal: {},
        },
      ]),
      "Entered duplicate by mistake",
      nextUuid(),
    ]);
    const voidApproved = await serviceRpc(db, "direct_entry_approve_change_request", [
      ADMIN_M.auth,
      ADMIN_M.app,
      crVoid.request_id,
      1,
      "Admin approves ENTRY_VOID",
      nextUuid(),
    ]);
    assert.equal(voidApproved.state, "APPROVED");
    const voidAudit = (
      await db.query(
        "select capability from public.direct_entry_audit_events where action = 'change_request_approved' and resource_ref = $1 order by created_at desc limit 1",
        [crVoid.request_id],
      )
    ).rows[0];
    assert.equal(voidAudit.capability, "entry_admin");

    // --- CRITICAL CROSS-SCOPE `DOCUMENT` CR LOCK (defense-in-depth on historical/synthetic DOCUMENT CR) ---
    // Temporarily lift #34 check constraint inside this isolated test DB to exercise SQL DOCUMENT CR paths
    await db.exec("alter table public.direct_entry_change_request_items drop constraint direct_entry_change_request_items_document_scope_lock");
    const docCrReasonId = nextUuid();
    await db.query(
      "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1::uuid, $2::uuid, 'Synthetic DOCUMENT CR test')",
      [docCrReasonId, PM_M.app],
    );
    const docCrId = nextUuid();
    const docCrKey = nextUuid();
    await db.query(
      "insert into public.direct_entry_change_requests (request_id, proposer_user_id, state, version, idempotency_key, request_hash, reason_id) values ($1::uuid, $2::uuid, 'PENDING', 1, $3, $4, $5::uuid)",
      [docCrId, PM_M.app, docCrKey, sha256(`doc-cr:${docCrId}`), docCrReasonId],
    );
    await db.query(
      "insert into public.direct_entry_change_request_items (request_id, entry_id, target_kind, expected_version, proposal) values ($1::uuid, $2::uuid, 'DOCUMENT', 1, $3::jsonb)",
      [
        docCrId,
        entry2,
        JSON.stringify({
          document_type: "CCCD_FRONT",
          idempotency_key: nextUuid(),
          checksum_sha256: sha256("doc-cr-payload"),
          size_bytes: 1234,
          mime_type: "image/jpeg",
        }),
      ],
    );

    // 1. REVIEW_REC (`change_review @ ALL` + `RECRUITER @ OWN`, NO `document_view/document_upload @ ALL`):
    //    read_change_request redacts document metadata (size_bytes/mime_type hidden), and approve MUST DENY!
    const revReadDocCr = await serviceRpc(db, "direct_entry_read_change_request", [
      REVIEW_REC.auth,
      REVIEW_REC.app,
      docCrId,
    ]);
    assert.equal(revReadDocCr.items[0].proposal.size_bytes, undefined, "REVIEW_REC without document_view@ALL must not see DOCUMENT size_bytes on other user's entry");
    await expectServiceRpcError(
      db,
      "direct_entry_approve_change_request",
      [REVIEW_REC.auth, REVIEW_REC.app, docCrId, 1, "Cross-scope doc escalation attempt", nextUuid()],
      "42501",
      /capability denied/,
    );

    // 2. Grant HR_REC (`document_view @ ALL` + `document_upload @ OWN`) `change_review @ ALL` -> STILL DENIED because `document_upload` is only `@ OWN`, NOT `@ ALL`!
    await createDirectGrant(
      db,
      OWNER,
      HR_REC,
      [{ capability: "change_review", scope_kind: "ALL", scope_id: null }],
      "Test HR_REC + change_review@ALL without document_upload@ALL",
    );
    await clearLegacyMirrors(db, [HR_REC.app]);
    await expectServiceRpcError(
      db,
      "direct_entry_approve_change_request",
      [HR_REC.auth, HR_REC.app, docCrId, 1, "HR_OPERATOR+RECRUITER doc upload escalation attempt", nextUuid()],
      "42501",
      /capability denied/,
    );

    // 3. TL_M (`TEAM_LEADER @ TEAM_1` + `RECRUITER @ OWN` -> `document_upload @ OWN` only, NOT `CONTEXT_TEAM`/`ALL`) -> DENIED!
    await expectServiceRpcError(
      db,
      "direct_entry_approve_change_request",
      [TL_M.auth, TL_M.app, docCrId, 1, "TL+RECRUITER doc CR escalation attempt", nextUuid()],
      "42501",
      /capability denied/,
    );

    // 4. Mirror-cleared ADMIN_M (`change_review @ ALL`, `document_view @ ALL`, `document_upload @ ALL`) -> sees full metadata AND approves!
    const adminReadDocCr = await serviceRpc(db, "direct_entry_read_change_request", [
      ADMIN_M.auth,
      ADMIN_M.app,
      docCrId,
    ]);
    assert.equal(adminReadDocCr.items[0].proposal.size_bytes, 1234);
    const adminDocApproved = await serviceRpc(db, "direct_entry_approve_change_request", [
      ADMIN_M.auth,
      ADMIN_M.app,
      docCrId,
      1,
      "Canonical Admin approves DOCUMENT CR",
      nextUuid(),
    ]);
    assert.equal(adminDocApproved.state, "APPROVED");
  } finally {
    await db.close();
  }
});

test("WP8C-2 #5: Real SQL -> Actor RPC -> TS APIs / Session / N8N + D10 Disable/Re-Enable + Pre-Cutover R1 Parity", async () => {
  const migrations = await loadMigrations();
  const db = await createDbUpTo(migrations, WP8C2_MIGRATION_NAME);

  try {
    await seedWorld(db);

    // 1. Real SQL `direct_entry_resolve_actor_context` -> TS `resolveActor` for mirror-cleared actors
    const { resolution: adminRes } = await resolveViaRealRpc(db, ADMIN_M.auth);
    const { resolution: recRes } = await resolveViaRealRpc(db, REC_M.auth);
    const { resolution: pmRes } = await resolveViaRealRpc(db, PM_M.auth);
    const { resolution: staleRes } = await resolveViaRealRpc(db, EMP_STALE.auth);
    const { resolution: hrOnlyRes } = await resolveViaRealRpc(db, HR_ONLY.auth);
    assert.equal(adminRes.ok, true);
    assert.equal(recRes.ok, true);
    assert.equal(pmRes.ok, true);
    assert.equal(staleRes.ok, true);
    assert.equal(hrOnlyRes.ok, true);

    // Verify canManageProjectMasterFromActor fails closed on stale legacy & allows mirror-cleared ADMIN_M
    assert.equal(canManageProjectMasterFromActor(adminRes), true);
    assert.equal(canManageProjectMasterFromActor(staleRes), false);

    // 2. Session bootstrap & auth-session-core project paired capabilities/scopes WITHOUT leaking effective_grants!
    const adminSessionResp = await createDirectEntrySessionResponse("true", async () => ({
      actor: adminRes,
      response_headers: { pragma: "no-cache" },
    }));
    assert.equal(adminSessionResp.status, 200);
    const adminSessionBody = await adminSessionResp.json();
    assert.ok(adminSessionBody.actor.capabilities.includes("entry_admin"));
    assert.ok(adminSessionBody.actor.capabilities.includes("document_upload"));
    assert.ok(adminSessionBody.actor.scopes.some((s) => s.kind === "all"));
    assert.equal(JSON.stringify(adminSessionBody).includes("effective_grants"), false);
    assert.equal(JSON.stringify(adminSessionBody).includes("source_type"), false);

    const staleSessionResp = await createAuthSessionResponse(async () => ({ actor: staleRes }));
    assert.equal(staleSessionResp.status, 200);
    const staleSessionBody = await staleSessionResp.json();
    assert.deepEqual(staleSessionBody.actor.capabilities, [], "EMP_STALE stale legacy must NOT project into client capabilities");
    assert.deepEqual(
      staleSessionBody.actor.scopes.map((s) => s.kind),
      ["own"],
      "EMP_STALE stale legacy must NOT project 'all' scope into client scopes",
    );
    assert.equal(JSON.stringify(staleSessionBody).includes("effective_grants"), false);

    // Direct helper check for server page projection (`workers/page.tsx`)
    assert.ok(projectClientCapabilities(adminRes.actor).includes("entry_admin"));
    assert.ok(projectClientScopes(adminRes.actor).some((s) => s.kind === "all"));
    assert.deepEqual(projectClientCapabilities(staleRes.actor), []);
    assert.deepEqual(projectClientScopes(staleRes.actor).map((s) => s.kind), ["own"]);

    // 3. Direct Entry TS API preflights wired to real SQL actor resolution
    const docUpRec = await resolveDocumentApiActor(
      { resolveSession: async () => ({ actor: recRes, response_headers: {} }), repository: {}, storage: {} },
      "document_upload",
    );
    assert.equal(docUpRec.ok, true);
    const docUpStale = await resolveDocumentApiActor(
      { resolveSession: async () => ({ actor: staleRes, response_headers: {} }), repository: {}, storage: {} },
      "document_upload",
    );
    assert.equal(docUpStale.ok, false);
    assert.equal(docUpStale.response.status, 403);

    const docUpPm = await resolveDocumentApiActor(
      { resolveSession: async () => ({ actor: pmRes, response_headers: {} }), repository: {}, storage: {} },
      "document_upload",
    );
    assert.equal(docUpPm.ok, true);

    // CCCD preview / QR / Review preflight reject EMP_STALE (403) and pass mirror-cleared ADMIN_M
    const stalePreview = await previewCccdDocument(
      new Request("https://bi.test/api/direct-entry/entries/doc"),
      nextUuid(),
      nextUuid(),
      "true",
      { resolveSession: async () => ({ actor: staleRes, response_headers: {} }), repository: {}, storage: { available: () => true } },
    );
    assert.equal(stalePreview.status, 403);

    const staleQr = await getDirectEntryCccdQr(
      new Request("https://bi.test/api/direct-entry/entries/qr"),
      nextUuid(),
      "true",
      { resolveSession: async () => ({ actor: staleRes, response_headers: {} }), qrRepository: {}, storage: { available: () => true } },
    );
    assert.equal(staleQr.status, 403);

    const staleReview = await getDirectEntryCccdReviewQueue(
      new Request("https://bi.test/api/direct-entry/cccd-review"),
      "true",
      { resolveSession: async () => ({ actor: staleRes, response_headers: {} }), reviewRepository: {} },
    );
    assert.equal(staleReview.status, 403);

    let reviewCalled = false;
    const adminReview = await getDirectEntryCccdReviewQueue(
      new Request("https://bi.test/api/direct-entry/cccd-review"),
      "true",
      {
        resolveSession: async () => ({ actor: adminRes, response_headers: {} }),
        reviewRepository: {
          async listReviewQueue() {
            reviewCalled = true;
            return {
              ok: true,
              data: {
                status_filter: "NEEDS_REVIEW",
                page: 1,
                page_size: 25,
                total_items: 0,
                has_more: false,
                counts: { needs_review: 0, mismatch: 0, qr_unreadable: 0, pending: 0, resolved: 0, all: 0 },
                items: [],
              },
            };
          },
        },
      },
    );
    assert.equal(adminReview.status, 200);
    assert.equal(reviewCalled, true);

    // Portrait stage & full-profile APIs block HR_ONLY (no document_upload) & EMP_STALE
    const hrStageRes = await postWorkerPortraitStage(
      new Request("https://bi.test/api/direct-entry/portrait-stages", {
        method: "POST",
        headers: {
          origin: "https://bi.test",
          host: "bi.test",
          "content-type": "multipart/form-data; boundary=---test",
          "idempotency-key": nextUuid(),
        },
        body: "test",
      }),
      "true",
      { resolveSession: async () => ({ actor: hrOnlyRes, response_headers: {} }), repository: {}, storage: { available: () => true } },
    );
    assert.equal(hrStageRes.status, 403);

    const staleBatchRes = await postFullProfileBatch(
      new Request("https://bi.test/api/direct-entry/full-profile", {
        method: "POST",
        headers: {
          origin: "https://bi.test",
          host: "bi.test",
          "content-type": "application/json",
          "idempotency-key": nextUuid(),
        },
        body: JSON.stringify({
          contract_version: "worker-profile/1.0",
          rows: [{
            project_id: PRJ_1,
            first_work_date: "2026-03-01",
            employee_code: "hrp-2026-000901",
            recruiter_id: REC_M.recruiter,
            labor_type: "CHINH_THUC",
            display_name: "Stale Check",
            portrait_stage_id: nextUuid(),
            worker: { national_id: { state: "provided", value: "099988877766" } },
          }],
        }),
      }),
      "true",
      { resolveSession: async () => ({ actor: staleRes, response_headers: {} }), repository: {} },
    );
    assert.equal(staleBatchRes.status, 403);

    // 4. N8N Service Actor Resolution wired directly to real PGlite `direct_entry_resolve_actor_context`!
    const n8nAdmin = await resolveN8nBodServiceActor({
      env: { authSubject: ADMIN_M.auth, appUserId: ADMIN_M.app },
      resolveActorContextRpc: async (sub) => ({
        data: await serviceRpc(db, "direct_entry_resolve_actor_context", [sub]),
        error: null,
      }),
    });
    assert.equal(n8nAdmin.ok, true, "Mirror-cleared canonical ADMIN_M must work for n8n even with all_scope_grants=[]");
    assert.ok(n8nAdmin.capabilities.includes("entry_admin"));

    const n8nHrOnly = await resolveN8nBodServiceActor({
      env: { authSubject: HR_ONLY.auth, appUserId: HR_ONLY.app },
      resolveActorContextRpc: async (sub) => ({
        data: await serviceRpc(db, "direct_entry_resolve_actor_context", [sub]),
        error: null,
      }),
    });
    assert.equal(n8nHrOnly.ok, false, "HR_OPERATOR lacks entry_admin/report_analytics_view@ALL and must be rejected by n8n");

    // Direct-granted report_analytics_view @ ALL on SERVICE account succeeds with strictly paired @ALL capabilities
    await createDirectGrant(
      db,
      OWNER,
      SVC_ACC,
      [{ capability: "report_analytics_view", scope_kind: "ALL", scope_id: null }],
      "WP8C2 n8n service report_analytics_view@ALL",
    );
    const n8nSvc = await resolveN8nBodServiceActor({
      env: { authSubject: SVC_ACC.auth, appUserId: SVC_ACC.app },
      resolveActorContextRpc: async (sub) => ({
        data: await serviceRpc(db, "direct_entry_resolve_actor_context", [sub]),
        error: null,
      }),
    });
    assert.equal(n8nSvc.ok, true, "SERVICE account with paired report_analytics_view@ALL must succeed for n8n");
    assert.deepEqual(n8nSvc.capabilities, ["report_analytics_view"]);

    const n8nStale = await resolveN8nBodServiceActor({
      env: { authSubject: EMP_STALE.auth, appUserId: EMP_STALE.app },
      resolveActorContextRpc: async (sub) => ({
        data: await serviceRpc(db, "direct_entry_resolve_actor_context", [sub]),
        error: null,
      }),
    });
    assert.equal(n8nStale.ok, false, "EMP_STALE with stale legacy all_scope_grants must be rejected by n8n");

    // 5. D10 Disable & Re-Enable lifecycle on mirror-cleared managed REC_M
    const recVer1 = (
      await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [REC_M.app])
    ).rows[0].version;
    await serviceRpc(db, "direct_entry_disable_app_user", [
      OWNER.auth,
      OWNER.app,
      REC_M.app,
      recVer1,
      "D10 disable REC_M",
      nextUuid(),
    ]);
    await expectServiceRpcError(
      db,
      "direct_entry_input_catalog",
      [REC_M.auth, REC_M.app, "2026-03-01"],
      "42501",
      /actor capability denied/,
    );
    const { resolution: disabledRes } = await resolveViaRealRpc(db, REC_M.auth);
    assert.equal(disabledRes.ok, false);
    assert.equal(disabledRes.reason, "ACTOR_DISABLED");

    const recVer2 = (
      await db.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [REC_M.app])
    ).rows[0].version;
    await serviceRpc(db, "direct_entry_enable_app_user", [
      OWNER.auth,
      OWNER.app,
      REC_M.app,
      recVer2,
      "D10 re-enable REC_M",
      nextUuid(),
    ]);
    await clearLegacyMirrors(db, [REC_M.app]);
    const recCatalogAfterEnable = await serviceRpc(db, "direct_entry_input_catalog", [REC_M.auth, REC_M.app, "2026-03-01"]);
    assert.ok(recCatalogAfterEnable.recruiters.length >= 1, "D10 re-enable restores canonical RECRUITER access");

    // 6. Pre-cutover (`authz_managed = false`) R1 compatibility parity
    const preAuth = (
      await db.query(
        "select public.direct_entry_create_authority($1::uuid, $2::uuid, $3, '2026-03-01'::date) as a",
        [PRE_CUT.auth, PRE_CUT.app, PRJ_1],
      )
    ).rows[0].a;
    assert.equal(preAuth, "legacy");
    const preStage = await serviceRpc(db, "direct_entry_create_worker_document_stage_idempotent", [
      PRE_CUT.auth,
      PRE_CUT.app,
      nextUuid(),
      "WORKER_PORTRAIT",
      "image/jpeg",
      1024,
      sha256("precut-stage"),
      nextUuid(),
    ]);
    assert.equal(preStage.replayed, false);
    const preBatch = await serviceRpc(db, "direct_entry_create_full_profile_batch", [
      PRE_CUT.auth,
      PRE_CUT.app,
      "worker-profile/1.0",
      JSON.stringify([makeFullProfileRow({ code: "hrp-2026-000801", cccd: "088877766655", recruiterId: PRE_CUT.recruiter })]),
      nextUuid(),
    ]);
    assert.equal(preBatch.state, "DRAFT");
    const preDel = await serviceRpc(db, "direct_entry_delete_draft_submission", [
      PRE_CUT.auth,
      PRE_CUT.app,
      preBatch.submission_id,
      1,
      nextUuid(),
    ]);
    assert.equal(preDel.deleted, true);
  } finally {
    await db.close();
  }
});
