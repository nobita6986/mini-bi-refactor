/**
 * WP8C-2 — Direct Entry / Worker / Document / Portrait / CCCD / Duplicate CCCD /
 * Change Request SQL Guards on WP5 Paired Effective Access.
 * Real PostgreSQL 18 Concurrency Suite.
 *
 * Pure ESM (runs under plain `node --test` without `--conditions=react-server`)
 * against an isolated local PostgreSQL 18 cluster (`initdb` + `pg_ctl`).
 *
 * Verifies with ZERO `40P01` deadlocks, ZERO `0A000` volatility errors,
 * ZERO `40001` regressions (strictly `PT409`), ZERO `25006` READ ONLY write errors,
 * and ZERO flakes across all 230 migrations through `20261120160000_wp8c2_entry_worker_access.sql`:
 *
 *   Check 1 — Live PG18 Catalog, ACL, Owner, Volatility & T1B Boundary Verification:
 *     - Exact `337` `service_role` RPCs in `public` (+0 from #229), `0` client
 *       (`anon`/`authenticated`/`PUBLIC`) `EXECUTE` grants on any non-extension `public` routine.
 *     - `direct_entry_catalog_bootstrap_plan` & `direct_entry_apply_catalog_bootstrap` owned by
 *       `direct_entry_catalog_bootstrap_executor`, `SECURITY DEFINER`, `search_path=pg_catalog, public`,
 *       `service_role` EXECUTE = true, executor has NO `CREATE` on `public` and NO installer
 *       membership, and executor HAS `EXECUTE` on
 *       `direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)` while
 *       `PUBLIC`/`anon`/`authenticated`/`service_role` do NOT.
 *     - Exact `provolatile = 's'` (`STABLE`) on all 5 WP8C-2 `STABLE` functions plus T1B's
 *       `direct_entry_resolve_actor_context`, `direct_entry_authz__internal_resolve_effective_grants`,
 *       and `work_report_has_active_obligations`.
 *     - Zero `'40001'` SQLSTATE literals in any of the 35 WP8C-2 replaced functions.
 *
 *   Race 1 — Mirror-Cleared Managed Document & Portrait Stage Concurrency vs Disable + D10 Recovery:
 *     - Cut over managed `RECRUITER` (`REC_1`) & `ADMIN` (`ADMIN_1`) via `runWp5Cutover`, then
 *       explicitly DELETE all legacy `direct_entry_capability_grants` & `direct_entry_scope_grants` rows.
 *     - Concurrent `direct_entry_create_worker_document_stage_idempotent` with same key (1 creates,
 *       1 replays `replayed: true`) and conflicting payload (`PT409`, NEVER `40001`).
 *     - `direct_entry_claim_worker_portrait_stage` + `direct_entry_create_full_profile_batch_with_portrait_stages`
 *       + `direct_entry_reserve_document_direct_upload` / `direct_entry_document_direct_context(..., 'finalize')`
 *       racing against uncommitted `direct_entry_disable_app_user` (`BEGIN` -> `disable` -> `COMMIT`),
 *       followed by post-commit `42501` denial and D10 `direct_entry_enable_app_user` access recovery.
 *
 *   Race 2 — Mirror-Cleared Managed `direct_entry_self_withdraw_duplicate_cccd` Pair Race + Disable Race:
 *     - 2-row same-project same-day `ON` duplicate CCCD cluster owned by another user, targeted by
 *       mirror-cleared managed `ADMIN_DUP` (`duplicate_cccd_withdraw @ ALL` via canonical `ADMIN`).
 *     - Two concurrent `direct_entry_self_withdraw_duplicate_cccd` calls targeting row A and row B:
 *       deterministic `ORDER BY entry_id ASC FOR UPDATE` serializes cleanly -> EXACTLY 1 succeeds,
 *       EXACTLY 1 fails with `PT409`, 0 `40P01`, NEVER double-voids both rows.
 *     - Uncommitted `direct_entry_disable_app_user` on `ADMIN_DUP` racing with
 *       `direct_entry_self_withdraw_duplicate_cccd` -> blocks deterministically on `Lock`, post-commit
 *       fails closed with `42501`, 0 `40P01`, both rows stay unvoided.
 *
 *   Race 3 — Mirror-Cleared Managed Change Request Decision (`approve`/`reject` + `apply_change_item`)
 *            vs OCC Conflict, TL Revoke & Disable:
 *     - Mirror-cleared managed `PM_1` proposes `ENTRY_FIELD` and mirror-cleared `REC_1` proposes
 *       `ENTRY_VOID`; concurrent `approve`/`reject` by mirror-cleared `ADMIN_1` & `TL_1` with same
 *       `expected_version` -> EXACTLY 1 succeeds, EXACTLY 1 fails with `PT409`, 0 `40P01`.
 *     - Managed `TL_REV` `direct_entry_approve_change_request` racing against uncommitted
 *       `direct_entry_revoke_team_leader` -> blocks deterministically on `Lock`, post-commit fails
 *       closed with `42501`, zero partial apply, 0 `40P01`.
 *     - Mirror-cleared managed `TL_1` `direct_entry_approve_change_request` racing against uncommitted
 *       `direct_entry_disable_app_user` -> blocks deterministically on `Lock`, post-commit fails
 *       closed with `42501`, zero partial apply, 0 `40P01`.
 *
 *   Race 4 — Mirror-Cleared Managed Draft Submission Delete vs Transition Race:
 *     - Mirror-cleared managed `ADMIN_DRAFT` (`submission_create @ ALL`, `entry_own @ OWN`, 0 legacy rows)
 *       exercises the ADMIN own-draft delete fix, then races `direct_entry_delete_draft_submission` vs
 *       `direct_entry_transition_submission(..., 'SUBMITTED', ...)` (simultaneous + both deterministic
 *       lock orders) -> EXACTLY 1 succeeds, EXACTLY 1 fails with `PT409` or `55000`, 0 `40P01`,
 *       zero orphan states.
 *
 *   Race 5 — Concurrent `STABLE` Read Burst Under Active Mutations:
 *     - Deterministic MVCC non-blocking barrier under uncommitted `disable_app_user`, followed by
 *       40 concurrent `STABLE` reads (`direct_entry_create_authority`,
 *       `direct_entry_submission_duplicate_cccd_preflight`, `direct_entry_list_cccd_review_queue`,
 *       `direct_entry_duplicate_cccd_report`) inside `READ ONLY` transactions alongside concurrent
 *       `disable`/`enable`/`transition` mutations -> 0 `0A000`, 0 `40P01`, 0 `25006`, 0 `55P03`, 0 `40001`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import { S0_T1_C_TARGET_ROUTINE_PATTERN } from "./lib/migration-validation.mjs";
import { seedLegacyReviewSubmission } from "./lib/seed-legacy-review-submission.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const WP8C2_MIGRATION_NAME = "20261120160000_wp8c2_entry_worker_access.sql";
const EXPECTED_MIGRATION_COUNT = 230;

const OWNER = {
  auth: "18c40000-0000-4000-8000-000000000001",
  app: "28c40000-0000-4000-8000-000000000001",
  email: "nobita6986@gmail.com",
  name: "Owner Race WP8C2",
};
const LUANPT = {
  auth: "18c40000-0000-4000-8000-000000000002",
  app: "28c40000-0000-4000-8000-000000000002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "18c40000-0000-4000-8000-000000000003",
  app: "28c40000-0000-4000-8000-000000000003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "18c40000-0000-4000-8000-000000000004",
  app: "28c40000-0000-4000-8000-000000000004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};
const REC_1 = {
  auth: "18c40000-0000-4000-8000-000000000005",
  app: "28c40000-0000-4000-8000-000000000005",
  recruiter: "38c40000-0000-4000-8000-000000000005",
  email: "rec1.wp8c2@hrpartner.vn",
  name: "Managed Recruiter 1 Mirror Deleted",
};
const ADMIN_1 = {
  auth: "18c40000-0000-4000-8000-000000000006",
  app: "28c40000-0000-4000-8000-000000000006",
  email: "admin1.wp8c2@hrpartner.vn",
  name: "Managed Admin 1 Mirror Deleted",
};
const ADMIN_DUP = {
  auth: "18c40000-0000-4000-8000-000000000007",
  app: "28c40000-0000-4000-8000-000000000007",
  email: "admindup.wp8c2@hrpartner.vn",
  name: "Managed Admin Duplicate Withdraw",
};
const TL_1 = {
  auth: "18c40000-0000-4000-8000-000000000008",
  app: "28c40000-0000-4000-8000-000000000008",
  recruiter: "38c40000-0000-4000-8000-000000000008",
  email: "tl1.wp8c2@hrpartner.vn",
  name: "Managed TL 1 Mirror Deleted",
};
const PM_1 = {
  auth: "18c40000-0000-4000-8000-000000000009",
  app: "28c40000-0000-4000-8000-000000000009",
  recruiter: "38c40000-0000-4000-8000-000000000009",
  email: "pm1.wp8c2@hrpartner.vn",
  name: "Managed PM 1 Mirror Deleted",
};
const TL_REV = {
  auth: "18c40000-0000-4000-8000-000000000010",
  app: "28c40000-0000-4000-8000-000000000010",
  recruiter: "38c40000-0000-4000-8000-000000000010",
  email: "tlrev.wp8c2@hrpartner.vn",
  name: "Managed TL Revoke Race",
};
const PM_2 = {
  auth: "18c40000-0000-4000-8000-000000000011",
  app: "28c40000-0000-4000-8000-000000000011",
  recruiter: "38c40000-0000-4000-8000-000000000011",
  email: "pm2.wp8c2@hrpartner.vn",
  name: "Managed PM 2 Mirror Deleted",
};
const ADMIN_DRAFT = {
  auth: "18c40000-0000-4000-8000-000000000012",
  app: "28c40000-0000-4000-8000-000000000012",
  email: "admindraft.wp8c2@hrpartner.vn",
  name: "Managed Admin Draft Race",
};
const ADMIN_BURST = {
  auth: "18c40000-0000-4000-8000-000000000013",
  app: "28c40000-0000-4000-8000-000000000013",
  email: "adminburst.wp8c2@hrpartner.vn",
  name: "Managed Admin STABLE Burst",
};

const ALL_USERS = [
  OWNER,
  LUANPT,
  LIENVU,
  NGATTT,
  REC_1,
  ADMIN_1,
  ADMIN_DUP,
  TL_1,
  PM_1,
  TL_REV,
  PM_2,
  ADMIN_DRAFT,
  ADMIN_BURST,
];

const TEAM_1 = "48c40000-0000-4000-8000-000000000001";
const TEAM_2 = "48c40000-0000-4000-8000-000000000002";
const PRJ_1 = "wp8c2_race_prj1";
const PRJ_2 = "wp8c2_race_prj2";

const ADMIN_SEED_CAPS = [
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

const WP8C2_INTERNAL_SIGNATURES = [
  "public.direct_entry_assert_draft_access(uuid,uuid,uuid,uuid,date,text)",
  "public.direct_entry_create_authority(uuid,uuid,text,date)",
  "public.direct_entry_input_catalog_unscoped_v42(uuid,uuid,date)",
  "public.direct_entry_transition_submission_apply(uuid,uuid,uuid,integer,text,text,text,integer)",
  "public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)",
  "public.direct_entry_assert_payment_document_access(uuid,uuid,uuid,uuid,date,uuid,text)",
  "public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)",
  "public.direct_entry_create_worker_portrait_stage(uuid,uuid,uuid,text,bigint,text)",
  "public.direct_entry_create_worker_portrait_stage_idempotent(uuid,uuid,uuid,text,bigint,text,text)",
  "public.direct_entry_complete_worker_portrait_stage(uuid,uuid,uuid,text,uuid,uuid)",
  "public.direct_entry__internal_assert_cccd_qr_read_access(uuid,uuid,uuid)",
  "public.direct_entry__internal_resolve_cccd_review_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)",
  "public.direct_entry_assert_change_request_capabilities(uuid,uuid,uuid)",
  "public.direct_entry_change_request_audience(uuid,uuid,uuid)",
  "public.direct_entry_resolve_change_request_scope(uuid,uuid,uuid,text)",
  "public.direct_entry_decide_change_request(uuid,uuid,uuid,integer,text,text,text)",
  "public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)",
];

const WP8C2_SERVICE_SIGNATURES = [
  "public.direct_entry_catalog_bootstrap_plan(uuid,uuid)",
  "public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)",
  "public.direct_entry_list_own_drafts(uuid,uuid)",
  "public.direct_entry_delete_draft_submission(uuid,uuid,uuid,integer,text)",
  "public.direct_entry_submission_duplicate_cccd_preflight(uuid,uuid,uuid)",
  "public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)",
  "public.direct_entry_create_full_profile_batch_with_portrait_stages(uuid,uuid,text,jsonb,text,uuid[])",
  "public.direct_entry_read_projection(uuid,uuid,uuid)",
  "public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)",
  "public.direct_entry_create_worker_document_stage_idempotent(uuid,uuid,uuid,text,text,bigint,text,text)",
  "public.direct_entry_complete_worker_document_stage(uuid,uuid,uuid,text,uuid,uuid)",
  "public.direct_entry_claim_worker_portrait_stage(uuid,uuid,uuid,text)",
  "public.direct_entry_list_cccd_review_queue(uuid,uuid,text,integer,integer)",
  "public.direct_entry_list_missing_document_workers(uuid,uuid,text,text,text,text,integer,integer)",
  "public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)",
  "public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)",
  "public.direct_entry_list_global_change_request_history(uuid,uuid,integer,text,integer)",
  "public.direct_entry_read_change_request(uuid,uuid,uuid)",
];

const WP8C2_STABLE_SIGNATURES = [
  "public.direct_entry_create_authority(uuid,uuid,text,date)",
  "public.direct_entry_submission_duplicate_cccd_preflight(uuid,uuid,uuid)",
  "public.direct_entry__internal_resolve_cccd_review_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)",
  "public.direct_entry_list_cccd_review_queue(uuid,uuid,text,integer,integer)",
  "public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)",
];

const T1B_STABLE_SIGNATURES = [
  "public.direct_entry_resolve_actor_context(uuid)",
  "public.direct_entry_authz__internal_resolve_effective_grants(uuid)",
  "public.work_report_has_active_obligations(uuid,uuid)",
];

let seq = 1;
function nextUuid() {
  return `98c40000-0000-4000-8000-${(seq++).toString(16).padStart(12, "0")}`;
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  return result.error ? null : candidate;
}

function run(file, args, { ignoreOutput = false } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  assert.equal(result.status, 0, `${path.basename(file)} failed:\n${result.stderr || result.stdout}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function connect(port, appName) {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database: "postgres",
    application_name: appName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function serviceRpc(client, fnName, args = []) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await client.query("begin");
  try {
    await client.query("set local role service_role");
    const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
    await client.query("commit");
    return rows[0]?.res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function serviceRpcInTx(client, fnName, args = []) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await client.query("set local role service_role");
  const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
  return rows[0]?.res;
}

async function serviceRpcReadOnly(client, fnName, args = []) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await client.query("begin transaction read only");
  try {
    await client.query("set local lock_timeout = '500ms'");
    await client.query("set local role service_role");
    const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
    await client.query("commit");
    return rows[0]?.res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function ownerRpcReadOnly(client, fnName, args = []) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(", ");
  await client.query("begin transaction read only");
  try {
    await client.query("set local lock_timeout = '500ms'");
    const { rows } = await client.query(`select public.${fnName}(${placeholders}) as res`, args);
    await client.query("commit");
    return rows[0]?.res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

function asSettled(promise) {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
}

async function waitUntilBlocked(observer, appName, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      `select wait_event_type, wait_event
         from pg_stat_activity
        where application_name = $1
          and state = 'active'
          and wait_event_type = 'Lock'`,
      [appName],
    );
    if (rows.length > 0) return rows[0];
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${appName} to block on a PostgreSQL lock`);
}

async function seedRecruiterAndTeam(client, user, teamId) {
  await client.query(
    "insert into public.recruiters (recruiter_id, display_name, active) values ($1::uuid, $2, true)",
    [user.recruiter, user.name],
  );
  await client.query(
    "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current) values ($1::uuid, 'hrp', '2026-01-01', true)",
    [user.recruiter],
  );
  await client.query(
    "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
    [user.recruiter, teamId],
  );
  await client.query(
    "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current) values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
    [user.app, user.recruiter],
  );
}

async function assignGlobalRole(client, target, roleCode, reason) {
  const ver = (
    await client.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [target.app])
  ).rows[0].version;
  const key = nextUuid();
  return serviceRpc(client, "direct_entry_authz_assign_global_role_admin", [
    OWNER.auth,
    OWNER.app,
    target.app,
    roleCode,
    ver,
    reason,
    key,
    sha256(`wp8c2-assign:${target.app}:${roleCode}:${key}`),
  ]);
}

async function deleteLegacyMirror(client, appUserId) {
  await client.query("begin");
  try {
    await client.query("select set_config('direct_entry.team_leader_marker', 'on', true)");
    await client.query("delete from public.direct_entry_capability_grants where app_user_id = $1::uuid", [appUserId]);
    await client.query("delete from public.direct_entry_scope_grants where app_user_id = $1::uuid", [appUserId]);
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function assertMirrorDeleted(client, appUserId, { expectedTlTeamId = null } = {}) {
  const {
    rows: [state],
  } = await client.query(
    `select
       u.authz_managed,
       (select count(*)::int from public.direct_entry_capability_grants c
         where c.app_user_id = u.app_user_id) as total_legacy_caps,
       (select count(*)::int from public.direct_entry_scope_grants s
         where s.app_user_id = u.app_user_id) as total_legacy_scopes,
       (select count(*)::int from public.direct_entry_team_leader_assignments a
         where a.leader_app_user_id = u.app_user_id
           and ($2::uuid is null or a.team_id = $2::uuid)
           and a.is_current) as active_tl_assignments
     from public.direct_entry_app_users u
    where u.app_user_id = $1::uuid`,
    [appUserId, expectedTlTeamId],
  );
  assert.equal(state.authz_managed, true, `Expected authz_managed=true for ${appUserId}`);
  assert.equal(state.total_legacy_caps, 0, `Legacy capability mirror rows must be deleted for ${appUserId}`);
  assert.equal(state.total_legacy_scopes, 0, `Legacy scope mirror rows must be deleted for ${appUserId}`);
  if (expectedTlTeamId) {
    assert.equal(state.active_tl_assignments, 1, `Canonical TL assignment must remain intact for ${appUserId}`);
  }
}

function makeWorkerDetails(displayName, cccd) {
  return {
    display_name: displayName,
    date_of_birth: { state: "omitted" },
    national_id: { state: "provided", value: cccd },
    address: { state: "omitted" },
    phone: { state: "provided", value: "0909888777" },
  };
}

function makeBatchV2Row({ projectId, firstWorkDate, recruiterId, displayName, cccd, laborType = "TEMPORARY" }) {
  return {
    project_id: projectId,
    first_work_date: firstWorkDate,
    provider_type: "hrp",
    recruiter_id: recruiterId,
    labor_type: laborType,
    display_name: displayName,
    worker_details: {
      date_of_birth: { state: "omitted" },
      national_id: { state: "provided", value: cccd },
      address: { state: "omitted" },
      phone: { state: "provided", value: "0909888777" },
    },
    general_note: { state: "omitted" },
    payment: { state: "omitted" },
    employment: { initial_status: "ON" },
  };
}

function makeBatchV1Row({ projectId, firstWorkDate, employeeCode, recruiterId, displayName, cccd, laborType = "TEMPORARY" }) {
  return {
    project_id: projectId,
    first_work_date: firstWorkDate,
    employee_code: employeeCode,
    recruiter_id: recruiterId,
    labor_type: laborType,
    display_name: displayName,
    worker_details: {
      date_of_birth: { state: "omitted" },
      national_id: { state: "provided", value: cccd },
      address: { state: "omitted" },
      phone: { state: "provided", value: "0909888777" },
    },
    general_note: { state: "omitted" },
    payment: { state: "omitted" },
    employment: { initial_status: "ON" },
  };
}

async function seedSubmittedWorker(
  client,
  { projectId, recruiterId, teamId, codeDigits, cccd, startDate, createdByUserId = OWNER.app, withCccdReconciliation = false },
) {
  const entryYear = startDate.slice(0, 4);
  const code = `hrp-${entryYear}-${codeDigits}`;
  const entryId = nextUuid();
  const subId = nextUuid();
  const candId = nextUuid();
  const onId = nextUuid();
  const reasonId = nextUuid();
  await client.query("begin");
  try {
    await client.query(
      "insert into public.direct_entry_restricted_reasons (reason_id, actor_user_id, reason_text) values ($1::uuid, $2::uuid, 'WP8C2 concurrency seed')",
      [reasonId, createdByUserId],
    );
    await client.query("insert into public.direct_entry_candidates (candidate_id) values ($1::uuid)", [candId]);
    await client.query(
      "insert into public.direct_entry_submissions (submission_id, created_by_user_id, state) values ($1::uuid, $2::uuid, 'DRAFT')",
      [subId, createdByUserId],
    );
    await client.query(
      `insert into public.direct_entries (
         entry_id, submission_id, candidate_id, created_by_user_id, project_id,
         first_work_date, employee_code, worker_details, recruiter_id, team_id,
         provider_type, labor_type
       ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::date, $7, $8::jsonb, $9::uuid, $10::uuid, 'hrp', 'TEMPORARY')`,
      [
        entryId,
        subId,
        candId,
        createdByUserId,
        projectId,
        startDate,
        code,
        JSON.stringify(makeWorkerDetails(`Worker ${code}`, cccd)),
        recruiterId,
        teamId,
      ],
    );
    await seedLegacyReviewSubmission(
      { exec: (sql) => client.query(sql), query: (...args) => client.query(...args) },
      subId,
    );
    await client.query(
      "update public.direct_entry_submissions set state = 'SUBMITTED', submitted_at = now(), version = 3 where submission_id = $1::uuid",
      [subId],
    );
    await client.query(
      `insert into public.direct_entry_employment_status_events (
         event_id, entry_id, status, effective_date, leave_date, leave_reason_text,
         version, actor_user_id, reason_id, supersedes_event_id
       ) values ($1::uuid, $2::uuid, 'ON', $3::date, null, null, 1, $4::uuid, $5::uuid, null)`,
      [onId, entryId, startDate, createdByUserId, reasonId],
    );
    if (withCccdReconciliation) {
      await client.query(
        `insert into public.direct_entry_cccd_reconciliations (
           entry_id, candidate_id, status, entered_national_id
         ) values ($1::uuid, $2::uuid, 'PENDING', $3)`,
        [entryId, candId, cccd],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
  return { entryId, subId, candId, code, cccd };
}

test("WP8C-2 Real PostgreSQL 18 Concurrency Suite: Live Catalog/ACL/Volatility/Owner + Mirror-Cleared Document/Portrait, Duplicate CCCD Withdraw, Change Request OCC/TL Revoke, Draft Delete vs Transition & STABLE Read Burst", async (t) => {
  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  assert.ok(initdb && pgCtl, "PostgreSQL 18 initdb/pg_ctl binaries are required for concurrency verification");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp8c2-pg-race-"));
  const pgData = path.join(tmpDir, "data");
  const pgLog = path.join(tmpDir, "postgres.log");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    run(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"], {
      ignoreOutput: true,
    });
    run(
      pgCtl,
      [
        "-D",
        pgData,
        "-l",
        pgLog,
        "-w",
        "-o",
        `-F -h 127.0.0.1 -p ${port} -k "" -c deadlock_timeout=100ms -c log_min_messages=warning`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;

    const setup = await connect(port, "wp8c2_setup");
    const observer = await connect(port, "wp8c2_observer");
    const w1 = await connect(port, "wp8c2_w1");
    const w2 = await connect(port, "wp8c2_w2");
    const w3 = await connect(port, "wp8c2_w3");
    const w4 = await connect(port, "wp8c2_w4");
    const r1 = await connect(port, "wp8c2_r1");
    const r2 = await connect(port, "wp8c2_r2");
    const r3 = await connect(port, "wp8c2_r3");
    const r4 = await connect(port, "wp8c2_r4");
    clients.push(setup, observer, w1, w2, w3, w4, r1, r2, r3, r4);
    for (const worker of [w1, w2, w3, w4, r1, r2, r3, r4]) {
      await worker.query("set statement_timeout = '15s'");
    }

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text);",
    );

    const migrationFiles = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    assert.ok(migrationFiles.includes(WP8C2_MIGRATION_NAME), `${WP8C2_MIGRATION_NAME} must exist`);
    let appliedCount = 0;
    for (const file of migrationFiles) {
      const sql = await readFile(path.join(MIGRATION_DIR, file), "utf8");
      await setup.query(sql);
      appliedCount += 1;
      if (file === WP8C2_MIGRATION_NAME) break;
    }
    assert.equal(appliedCount, EXPECTED_MIGRATION_COUNT, `Expected exact ${EXPECTED_MIGRATION_COUNT} migrations applied`);

    // =========================================================================
    // CHECK 1: Live PG18 Catalog, ACL, Owner, Volatility & T1B Boundary
    // =========================================================================
    await t.test("Check 1 — Live PG18 Catalog, ACL, Owner, Volatility & T1B Boundary Verification", async () => {
      // 1A: Exact 337 service_role RPCs and 0 client/PUBLIC EXECUTE grants
      const {
        rows: [targetCatalog],
      } = await setup.query(
        `select
           count(*) filter (
             where pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
           )::int as service_rpc_count,
           count(*) filter (
             where pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
                or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
                or exists (
                  select 1
                    from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE'
                )
           )::int as exposed_client_or_public_count
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prokind in ('f', 'p')
          and p.proname ~ $1`,
        [S0_T1_C_TARGET_ROUTINE_PATTERN],
      );
      assert.equal(targetCatalog.service_rpc_count, 337, "Live PG18 catalog must have exact 337 service_role RPCs (+0 from #229)");
      assert.equal(
        targetCatalog.exposed_client_or_public_count,
        0,
        "Live PG18 catalog must expose 0 Mini BI routines to PUBLIC/anon/authenticated",
      );

      // Also assert across ALL non-extension routines in public
      const {
        rows: [allPublicCatalog],
      } = await setup.query(
        `select
           count(*) filter (
             where pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
           )::int as service_rpc_count,
           count(*) filter (
             where pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
                or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
                or exists (
                  select 1
                    from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                   where a.grantee = 0 and a.privilege_type = 'EXECUTE'
                )
           )::int as exposed_client_or_public_count
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.prokind in ('f', 'p')
          and not exists (
            select 1
              from pg_catalog.pg_depend d
             where d.classid = 'pg_catalog.pg_proc'::regclass
               and d.objid = p.oid
               and d.deptype = 'e'
          )`,
      );
      assert.equal(
        allPublicCatalog.service_rpc_count,
        337,
        "All non-extension public routines executable by service_role must equal exact 337",
      );
      assert.equal(
        allPublicCatalog.exposed_client_or_public_count,
        0,
        "Zero non-extension public routines may grant EXECUTE to PUBLIC/anon/authenticated",
      );

      const inspectFn = async (sig) => {
        const { rows } = await setup.query(
          `select
             p.oid,
             p.proname,
             p.provolatile,
             p.prosecdef,
             p.proconfig,
             p.prosrc,
             pg_catalog.pg_get_userbyid(p.proowner) as owner_name,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
             pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec,
             pg_catalog.has_function_privilege('direct_entry_catalog_bootstrap_executor', p.oid, 'EXECUTE') as executor_exec,
             exists (
               select 1
                 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE'
             ) as public_exec
           from pg_catalog.pg_proc p
          where p.oid = $1::pg_catalog.regprocedure`,
          [sig],
        );
        assert.equal(rows.length, 1, `Expected routine ${sig} to exist in pg_proc`);
        return rows[0];
      };

      // 1B: Restricted-owner catalog bootstrap RPCs & executor role boundary
      for (const sig of [
        "public.direct_entry_catalog_bootstrap_plan(uuid,uuid)",
        "public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)",
      ]) {
        const row = await inspectFn(sig);
        assert.equal(
          row.owner_name,
          "direct_entry_catalog_bootstrap_executor",
          `${sig} must be owned by direct_entry_catalog_bootstrap_executor`,
        );
        assert.equal(row.prosecdef, true, `${sig} must be SECURITY DEFINER`);
        assert.deepEqual(row.proconfig, ["search_path=pg_catalog, public"], `${sig} must lock search_path`);
        assert.equal(row.service_exec, true, `${sig} must grant EXECUTE to service_role`);
        assert.equal(row.public_exec, false, `${sig} must revoke PUBLIC EXECUTE`);
        assert.equal(row.anon_exec, false, `${sig} must revoke anon EXECUTE`);
        assert.equal(row.auth_exec, false, `${sig} must revoke authenticated EXECUTE`);
      }

      const {
        rows: [executorBoundary],
      } = await setup.query(
        `select
           pg_catalog.has_schema_privilege('direct_entry_catalog_bootstrap_executor', 'public', 'CREATE') as executor_has_create,
           (select count(*)::int
              from pg_catalog.pg_auth_members m
              join pg_catalog.pg_roles r on r.oid = m.roleid
             where r.rolname = 'direct_entry_catalog_bootstrap_executor') as executor_member_count`,
      );
      assert.equal(
        executorBoundary.executor_has_create,
        false,
        "direct_entry_catalog_bootstrap_executor must have NO CREATE privilege on public",
      );
      assert.equal(
        executorBoundary.executor_member_count,
        0,
        "direct_entry_catalog_bootstrap_executor must have NO installer/role memberships",
      );

      const pairedCapHelper = await inspectFn(
        "public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)",
      );
      assert.equal(
        pairedCapHelper.executor_exec,
        true,
        "direct_entry_catalog_bootstrap_executor must have EXECUTE on direct_entry_authz__internal_has_paired_capability",
      );
      assert.equal(pairedCapHelper.public_exec, false, "PUBLIC must NOT have EXECUTE on paired capability helper");
      assert.equal(pairedCapHelper.anon_exec, false, "anon must NOT have EXECUTE on paired capability helper");
      assert.equal(pairedCapHelper.auth_exec, false, "authenticated must NOT have EXECUTE on paired capability helper");
      assert.equal(pairedCapHelper.service_exec, false, "service_role must NOT have EXECUTE on paired capability helper");

      // 1C: Exact provolatile = 's' (STABLE) on all 5 WP8C-2 STABLE functions + 3 T1B STABLE functions
      for (const sig of [...WP8C2_STABLE_SIGNATURES, ...T1B_STABLE_SIGNATURES]) {
        const row = await inspectFn(sig);
        assert.equal(row.provolatile, "s", `${sig} must have provolatile='s' (STABLE)`);
        assert.equal(row.prosecdef, true, `${sig} must be SECURITY DEFINER`);
        assert.deepEqual(row.proconfig, ["search_path=pg_catalog, public"], `${sig} must lock search_path`);
      }

      // 1D: Verify all 35 WP8C-2 replaced functions (ACL, SECURITY DEFINER, search_path, ZERO '40001' literals)
      for (const sig of WP8C2_INTERNAL_SIGNATURES) {
        const row = await inspectFn(sig);
        assert.equal(row.prosecdef, true, `${sig} must be SECURITY DEFINER`);
        assert.deepEqual(row.proconfig, ["search_path=pg_catalog, public"], `${sig} must lock search_path`);
        assert.equal(row.public_exec, false, `${sig} must revoke PUBLIC EXECUTE`);
        assert.equal(row.anon_exec, false, `${sig} must revoke anon EXECUTE`);
        assert.equal(row.auth_exec, false, `${sig} must revoke authenticated EXECUTE`);
        assert.equal(row.service_exec, false, `${sig} internal helper must revoke service_role EXECUTE`);
        assert.equal(/'40001'/.test(row.prosrc), false, `${sig} must contain ZERO '40001' SQLSTATE literals`);
      }

      for (const sig of WP8C2_SERVICE_SIGNATURES) {
        const row = await inspectFn(sig);
        assert.equal(row.prosecdef, true, `${sig} must be SECURITY DEFINER`);
        assert.deepEqual(row.proconfig, ["search_path=pg_catalog, public"], `${sig} must lock search_path`);
        assert.equal(row.public_exec, false, `${sig} must revoke PUBLIC EXECUTE`);
        assert.equal(row.anon_exec, false, `${sig} must revoke anon EXECUTE`);
        assert.equal(row.auth_exec, false, `${sig} must revoke authenticated EXECUTE`);
        assert.equal(row.service_exec, true, `${sig} service RPC must grant EXECUTE to service_role`);
        assert.equal(/'40001'/.test(row.prosrc), false, `${sig} must contain ZERO '40001' SQLSTATE literals`);
      }
    });

    // =========================================================================
    // SEEDING & WP5 CUTOVER (ALL ACCOUNTS BECOME authz_managed = true)
    // =========================================================================
    for (const u of ALL_USERS) {
      await setup.query("insert into auth.users (id, email) values ($1::uuid, $2)", [u.auth, u.email]);
      await setup.query(
        "insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled) values ($1::uuid, $2::uuid, $3, true)",
        [u.app, u.auth, u.name],
      );
    }
    for (const adm of [OWNER, LIENVU, NGATTT]) {
      for (const cap of ADMIN_SEED_CAPS) {
        await setup.query(
          "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current) values ($1::uuid, $2, '2026-01-01', true)",
          [adm.app, cap],
        );
      }
      await setup.query(
        "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true), ($1::uuid, 'own', '2026-01-01', true)",
        [adm.app],
      );
    }
    await setup.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, is_current) values ($1::uuid, 'all', '2026-01-01', true)",
      [LUANPT.app],
    );

    await setup.query(
      `insert into public.teams (team_id, code, display_name, active) values
         ($1::uuid, 'WP8C2_T1', 'WP8C2 Race Team 1', true),
         ($2::uuid, 'WP8C2_T2', 'WP8C2 Race Team 2', true)`,
      [TEAM_1, TEAM_2],
    );
    await setup.query(
      `insert into public.direct_entry_projects (project_id, display_name, active) values
         ($1, 'WP8C2 Race Project 1', true),
         ($2, 'WP8C2 Race Project 2', true)`,
      [PRJ_1, PRJ_2],
    );
    await setup.query(
      `insert into public.direct_entry_labor_types (labor_type_key, display_name, reporting_key, sort_order, active)
       values ('TEMPORARY', 'Thời vụ', 'thoi_vu', 10, true)
       on conflict (labor_type_key) do update set active = true`,
    );

    const cutoverPlan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(cutoverPlan.action_diff.unexpected_diff_count, 0);
    const cutoverRes = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: cutoverPlan.manifest_fingerprint,
    });
    assert.equal(cutoverRes.status, "APPLIED");

    // Seed recruiters, HRP memberships, team memberships & verified links
    for (const u of [REC_1, TL_1, PM_1]) {
      await seedRecruiterAndTeam(setup, u, TEAM_1);
    }
    for (const u of [TL_REV, PM_2]) {
      await seedRecruiterAndTeam(setup, u, TEAM_2);
    }

    // Grant project-team scopes
    for (const [teamId, projectId] of [
      [TEAM_1, PRJ_1],
      [TEAM_2, PRJ_2],
    ]) {
      await serviceRpc(setup, "direct_entry_grant_project_team_scopes_batch", [
        OWNER.auth,
        OWNER.app,
        teamId,
        [projectId],
        `Seed scope ${projectId}`,
        `wp8c2-pts-${nextUuid()}`,
      ]);
    }

    // Assign canonical WP5 global roles
    await assignGlobalRole(setup, REC_1, "RECRUITER", "WP8C2 managed RECRUITER actor");
    await assignGlobalRole(setup, ADMIN_1, "ADMIN", "WP8C2 managed ADMIN actor 1");
    await assignGlobalRole(setup, ADMIN_DUP, "ADMIN", "WP8C2 managed ADMIN duplicate withdraw actor");
    await assignGlobalRole(setup, ADMIN_DRAFT, "ADMIN", "WP8C2 managed ADMIN draft delete/transition actor");
    await assignGlobalRole(setup, ADMIN_BURST, "ADMIN", "WP8C2 managed ADMIN STABLE burst actor");

    // Assign contextual PMs (REC_1 & PM_1 on PRJ_1; PM_2 on PRJ_2)
    for (const [projectId, pmUser] of [
      [PRJ_1, REC_1],
      [PRJ_1, PM_1],
      [PRJ_2, PM_2],
    ]) {
      const prjVer = (
        await setup.query("select version from public.direct_entry_projects where project_id = $1", [projectId])
      ).rows[0].version;
      await serviceRpc(setup, "direct_entry_assign_project_manager", [
        OWNER.auth,
        OWNER.app,
        projectId,
        pmUser.recruiter,
        null,
        prjVer,
        `Assign PM ${pmUser.name} on ${projectId}`,
        `wp8c2-pm-${nextUuid()}`,
      ]);
    }

    // Designate TLs (TL_1 on TEAM_1; TL_REV on TEAM_2)
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_1,
      TL_1.app,
      null,
      1,
      "Designate managed TL_1 on TEAM_1",
      `wp8c2-tl1-${nextUuid()}`,
    ]);
    await serviceRpc(setup, "direct_entry_designate_team_leader", [
      OWNER.auth,
      OWNER.app,
      TEAM_2,
      TL_REV.app,
      null,
      1,
      "Designate canonical managed TL_REV on TEAM_2",
      `wp8c2-tlrev-${nextUuid()}`,
    ]);

    // Explicitly DELETE ALL legacy capability & scope mirror rows on every mirror-cleared managed actor!
    for (const u of [REC_1, ADMIN_1, ADMIN_DUP, TL_1, PM_1, PM_2, ADMIN_DRAFT, ADMIN_BURST]) {
      await deleteLegacyMirror(setup, u.app);
      await assertMirrorDeleted(setup, u.app, {
        expectedTlTeamId: u === TL_1 ? TEAM_1 : null,
      });
    }
    // For TL_REV (which undergoes direct_entry_revoke_team_leader), delete all non-coextensive
    // legacy mirror rows while keeping only the single (team, team_manager_assign) interval pair
    // checked by direct_entry_apply_team_leader_mutation.
    await setup.query("begin");
    try {
      await setup.query("select set_config('direct_entry.team_leader_marker', 'on', true)");
      await setup.query(
        "delete from public.direct_entry_capability_grants where app_user_id = $1::uuid and capability <> 'team_manager_assign'",
        [TL_REV.app],
      );
      await setup.query(
        "delete from public.direct_entry_scope_grants where app_user_id = $1::uuid and scope_kind <> 'team'",
        [TL_REV.app],
      );
      await setup.query("commit");
    } catch (err) {
      await setup.query("rollback").catch(() => {});
      throw err;
    }

    const {
      rows: [dates],
    } = await setup.query(
      `select
         public.direct_entry_authorization_date()::text as today,
         (public.direct_entry_authorization_date() - 10)::text as start_d,
         (public.direct_entry_authorization_date() - 5)::text as start_d2`,
    );

    // =========================================================================
    // RACE 1: Mirror-Cleared Managed Document & Portrait Stage Concurrency
    //         vs Disable + D10 Enable Recovery
    // =========================================================================
    await t.test("Race 1 — Mirror-Cleared Managed Document & Portrait Stage Concurrency vs Disable & D10 Recovery", async () => {
      await assertMirrorDeleted(setup, REC_1.app);
      await assertMirrorDeleted(setup, ADMIN_1.app);

      // 1A-i: Concurrent direct_entry_create_worker_document_stage_idempotent with SAME idempotency key
      const sameStageKey = nextUuid();
      const portraitChecksum = sha256("wp8c2-portrait-bytes-v1");
      const [stageA, stageB] = await Promise.all([
        serviceRpc(w1, "direct_entry_create_worker_document_stage_idempotent", [
          REC_1.auth,
          REC_1.app,
          nextUuid(),
          "WORKER_PORTRAIT",
          "image/jpeg",
          1024,
          portraitChecksum,
          sameStageKey,
        ]),
        serviceRpc(w2, "direct_entry_create_worker_document_stage_idempotent", [
          REC_1.auth,
          REC_1.app,
          nextUuid(),
          "WORKER_PORTRAIT",
          "image/jpeg",
          1024,
          portraitChecksum,
          sameStageKey,
        ]),
      ]);
      const replayFlags = [stageA.replayed, stageB.replayed].sort();
      assert.deepEqual(replayFlags, [false, true], "Exactly one call must create and one must replay (replayed: true)");
      assert.equal(stageA.stage.stage_id, stageB.stage.stage_id, "Replayed call must return identical stage_id");

      // 1A-ii: Conflicting payload on SAME idempotency key -> PT409 (NEVER 40001!)
      await assert.rejects(
        () =>
          serviceRpc(w1, "direct_entry_create_worker_document_stage_idempotent", [
            REC_1.auth,
            REC_1.app,
            nextUuid(),
            "WORKER_PORTRAIT",
            "image/jpeg",
            2048,
            sha256("wp8c2-portrait-conflict-bytes"),
            sameStageKey,
          ]),
        (err) => {
          assert.notEqual(err.code, "40001", "Conflicting stage idempotency must NEVER regress to 40001");
          assert.notEqual(err.code, "40P01", "Conflicting stage idempotency must NEVER deadlock");
          assert.equal(err.code, "PT409", `Expected PT409, got ${err.code}: ${err.message}`);
          return true;
        },
      );

      // 1A-iii: Concurrent conflicting payload race on a fresh idempotency key -> 1 succeeds, 1 fails PT409
      const conflictRaceKey = nextUuid();
      const [confA, confB] = await Promise.allSettled([
        serviceRpc(w1, "direct_entry_create_worker_document_stage_idempotent", [
          REC_1.auth,
          REC_1.app,
          nextUuid(),
          "CCCD_FRONT",
          "image/jpeg",
          1500,
          sha256("wp8c2-conflict-a"),
          conflictRaceKey,
        ]),
        serviceRpc(w2, "direct_entry_create_worker_document_stage_idempotent", [
          REC_1.auth,
          REC_1.app,
          nextUuid(),
          "CCCD_FRONT",
          "image/jpeg",
          2500,
          sha256("wp8c2-conflict-b"),
          conflictRaceKey,
        ]),
      ]);
      const confSuccesses = [confA, confB].filter((r) => r.status === "fulfilled");
      const confFailures = [confA, confB].filter((r) => r.status === "rejected");
      assert.equal(confSuccesses.length, 1, "Exactly one conflicting stage create must succeed");
      assert.equal(confFailures.length, 1, "Exactly one conflicting stage create must fail");
      assert.notEqual(confFailures[0].reason.code, "40001", "Stage conflict race must NEVER raise 40001");
      assert.notEqual(confFailures[0].reason.code, "40P01", "Stage conflict race must NEVER deadlock");
      assert.equal(confFailures[0].reason.code, "PT409");

      // Mirror-cleared ADMIN_1 also creates a stage cleanly via document_upload @ ALL
      const adminStage = await serviceRpc(w3, "direct_entry_create_worker_document_stage_idempotent", [
        ADMIN_1.auth,
        ADMIN_1.app,
        nextUuid(),
        "WORKER_PORTRAIT",
        "image/png",
        2048,
        sha256("wp8c2-admin-stage"),
        nextUuid(),
      ]);
      assert.equal(adminStage.replayed, false);
      assert.equal(adminStage.stage.status, "STAGED");

      // 1B: Mirror-cleared REC_1 claims portrait stage + creates full profile batch with portrait stages
      //     + reserves direct upload + calls document_direct_context(..., 'finalize')
      const batchIdemKey = nextUuid();
      const claimed = await serviceRpc(w1, "direct_entry_claim_worker_portrait_stage", [
        REC_1.auth,
        REC_1.app,
        stageA.stage.stage_id,
        batchIdemKey,
      ]);
      assert.equal(claimed.status, "CLAIMED");

      const batchWithStage = await serviceRpc(w1, "direct_entry_create_full_profile_batch_with_portrait_stages", [
        REC_1.auth,
        REC_1.app,
        "worker-profile/1.2",
        JSON.stringify([
          makeBatchV2Row({
            projectId: PRJ_1,
            firstWorkDate: dates.start_d,
            recruiterId: REC_1.recruiter,
            displayName: "WP8C2 Race 1 Portrait Worker",
            cccd: "001099550001",
          }),
        ]),
        batchIdemKey,
        [stageA.stage.stage_id],
      ]);
      assert.equal(batchWithStage.state, "DRAFT");
      assert.equal(batchWithStage.entry_ids.length, 1);
      const race1EntryId = batchWithStage.entry_ids[0];

      const reserved1 = await serviceRpc(w1, "direct_entry_reserve_document_direct_upload", [
        REC_1.auth,
        REC_1.app,
        race1EntryId,
        1,
        "WORKER_PORTRAIT",
        `wp8c2-r1-res1-${nextUuid()}`,
        1024,
        "image/jpeg",
        null,
      ]);
      assert.ok(reserved1?.document_id);
      assert.equal(reserved1.entry_version, 2);

      const finalizeCtxOk = await serviceRpc(w1, "direct_entry_document_direct_context", [
        REC_1.auth,
        REC_1.app,
        race1EntryId,
        reserved1.document_id,
        "finalize",
      ]);
      assert.equal(finalizeCtxOk.document_id, reserved1.document_id);
      assert.equal(finalizeCtxOk.upload_status, "QUEUED");

      // 1C: Deterministic lock race — uncommitted disable_app_user on REC_1 while
      //     reserve_document_direct_upload & create_full_profile_batch_with_portrait_stages
      //     race on row locks -> 0 40P01, then post-commit 42501 on every doc/stage RPC!
      const stageForDisable = await serviceRpc(w1, "direct_entry_create_worker_document_stage_idempotent", [
        REC_1.auth,
        REC_1.app,
        nextUuid(),
        "WORKER_PORTRAIT",
        "image/jpeg",
        1024,
        sha256("wp8c2-disable-stage"),
        nextUuid(),
      ]);
      const rec1VerBeforeDis = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [REC_1.app])
      ).rows[0].version;

      await w1.query("begin");
      const disRec1 = await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        REC_1.app,
        rec1VerBeforeDis,
        "Race 1C uncommitted disable REC_1",
        `wp8c2-r1-dis-${nextUuid()}`,
      ]);
      assert.equal(disRec1.change, "disable");

      // w2 calls reserve_document_direct_upload -> passes MVCC check, then blocks on FK KEY SHARE
      // on direct_entry_app_users(REC_1) behind w1's FOR UPDATE!
      const reserveDuringDisablePromise = asSettled(
        serviceRpc(w2, "direct_entry_reserve_document_direct_upload", [
          REC_1.auth,
          REC_1.app,
          race1EntryId,
          reserved1.entry_version,
          "CCCD_FRONT",
          `wp8c2-r1-res-during-dis-${nextUuid()}`,
          1024,
          "image/jpeg",
          null,
        ]),
      );
      await waitUntilBlocked(observer, "wp8c2_w2");

      // w3 calls finalize context concurrently during uncommitted disable -> must not deadlock or hit 0A000
      const finalizeDuringDisablePromise = asSettled(
        serviceRpc(w3, "direct_entry_document_direct_context", [
          REC_1.auth,
          REC_1.app,
          race1EntryId,
          reserved1.document_id,
          "finalize",
        ]),
      );

      await w1.query("commit");

      const [reserveDuringRes, finalizeDuringRes] = await Promise.all([
        reserveDuringDisablePromise,
        finalizeDuringDisablePromise,
      ]);
      for (const [label, res] of [
        ["reserveDuringDisable", reserveDuringRes],
        ["finalizeDuringDisable", finalizeDuringRes],
      ]) {
        if (res.status === "rejected") {
          assert.notEqual(res.reason.code, "40P01", `${label} must never deadlock`);
          assert.notEqual(res.reason.code, "0A000", `${label} must never hit STABLE volatility violation`);
          assert.equal(res.reason.code, "42501", `${label} unexpected error ${res.reason.code}: ${res.reason.message}`);
        }
      }

      // Post-commit: disabled REC_1 MUST fail closed with 42501 across ALL stage/batch/upload/finalize RPCs!
      const entryVerAfterDis = (
        await setup.query("select version from public.direct_entries where entry_id = $1::uuid", [race1EntryId])
      ).rows[0].version;

      await assert.rejects(
        () =>
          serviceRpc(w2, "direct_entry_claim_worker_portrait_stage", [
            REC_1.auth,
            REC_1.app,
            stageForDisable.stage.stage_id,
            nextUuid(),
          ]),
        (err) => err.code === "42501",
      );
      await assert.rejects(
        () =>
          serviceRpc(w2, "direct_entry_create_full_profile_batch_with_portrait_stages", [
            REC_1.auth,
            REC_1.app,
            "worker-profile/1.2",
            JSON.stringify([
              makeBatchV2Row({
                projectId: PRJ_1,
                firstWorkDate: dates.start_d,
                recruiterId: REC_1.recruiter,
                displayName: "WP8C2 Disabled Denied",
                cccd: "001099550002",
              }),
            ]),
            nextUuid(),
            [stageForDisable.stage.stage_id],
          ]),
        (err) => err.code === "42501",
      );
      await assert.rejects(
        () =>
          serviceRpc(w2, "direct_entry_reserve_document_direct_upload", [
            REC_1.auth,
            REC_1.app,
            race1EntryId,
            entryVerAfterDis,
            "CCCD_BACK",
            `wp8c2-r1-post-dis-res-${nextUuid()}`,
            1024,
            "image/jpeg",
            null,
          ]),
        (err) => err.code === "42501",
      );
      await assert.rejects(
        () =>
          serviceRpc(w2, "direct_entry_document_direct_context", [
            REC_1.auth,
            REC_1.app,
            race1EntryId,
            reserved1.document_id,
            "finalize",
          ]),
        (err) => err.code === "42501",
      );

      // 1D: D10 direct_entry_enable_app_user restores REC_1 access cleanly (re-delete legacy mirror to prove canonical-only!)
      const enRec1 = await serviceRpc(setup, "direct_entry_enable_app_user", [
        OWNER.auth,
        OWNER.app,
        REC_1.app,
        disRec1.version,
        "Race 1D D10 enable REC_1",
        `wp8c2-r1-en-${nextUuid()}`,
      ]);
      assert.equal(enRec1.change, "enable");
      await deleteLegacyMirror(setup, REC_1.app);
      await assertMirrorDeleted(setup, REC_1.app);

      const claimedRecovered = await serviceRpc(w2, "direct_entry_claim_worker_portrait_stage", [
        REC_1.auth,
        REC_1.app,
        stageForDisable.stage.stage_id,
        nextUuid(),
      ]);
      assert.equal(claimedRecovered.status, "CLAIMED");

      const reservedRecovered = await serviceRpc(w2, "direct_entry_reserve_document_direct_upload", [
        REC_1.auth,
        REC_1.app,
        race1EntryId,
        entryVerAfterDis,
        "CCCD_BACK",
        `wp8c2-r1-rec-res-${nextUuid()}`,
        1024,
        "image/jpeg",
        null,
      ]);
      assert.ok(reservedRecovered?.document_id);

      const finalizeRecovered = await serviceRpc(w2, "direct_entry_document_direct_context", [
        REC_1.auth,
        REC_1.app,
        race1EntryId,
        reservedRecovered.document_id,
        "finalize",
      ]);
      assert.equal(finalizeRecovered.document_id, reservedRecovered.document_id);
    });

    // =========================================================================
    // RACE 2: Mirror-Cleared Managed `direct_entry_self_withdraw_duplicate_cccd`
    //         Pair Race + Uncommitted Disable Race
    // =========================================================================
    await t.test("Race 2 — Mirror-Cleared Managed self_withdraw_duplicate_cccd Pair Race & Disable Race", async () => {
      await assertMirrorDeleted(setup, ADMIN_DUP.app);

      // Seed 2-row same-project same-day ON duplicate CCCD cluster owned by OWNER (NOT ADMIN_DUP)
      const dupCccd1 = "001099660001";
      const dupA = await seedSubmittedWorker(setup, {
        projectId: PRJ_1,
        recruiterId: REC_1.recruiter,
        teamId: TEAM_1,
        codeDigits: "884001",
        cccd: dupCccd1,
        startDate: dates.start_d,
        createdByUserId: OWNER.app,
      });
      const dupB = await seedSubmittedWorker(setup, {
        projectId: PRJ_1,
        recruiterId: REC_1.recruiter,
        teamId: TEAM_1,
        codeDigits: "884002",
        cccd: dupCccd1,
        startDate: dates.start_d,
        createdByUserId: OWNER.app,
      });

      // Confirm mirror-cleared ADMIN_DUP sees both episodes as withdrawable via canonical ADMIN role
      const dupReportBefore = await serviceRpcReadOnly(r1, "direct_entry_duplicate_cccd_report", [
        ADMIN_DUP.auth,
        ADMIN_DUP.app,
        1,
        25,
        false,
      ]);
      assert.ok(dupReportBefore.total_groups >= 1, "Expected duplicate cluster in report");
      const targetGroup = dupReportBefore.groups.find((g) => g.cccd_last4 === "0001");
      assert.ok(targetGroup, "Expected seeded dupCccd1 group");
      assert.equal(targetGroup.episodes.length, 2);
      assert.equal(targetGroup.episodes[0].can_self_withdraw, true);
      assert.equal(targetGroup.episodes[1].can_self_withdraw, true);

      // 2A: Simultaneous pair race — w1 targets dupB (higher UUID), w2 targets dupA (lower UUID)
      //     Deterministic ORDER BY entry_id ASC FOR UPDATE serializes cleanly -> 1 succeeds, 1 fails PT409!
      const [wdB, wdA] = await Promise.allSettled([
        serviceRpc(w1, "direct_entry_self_withdraw_duplicate_cccd", [
          ADMIN_DUP.auth,
          ADMIN_DUP.app,
          dupB.entryId,
          1,
          "Race 2A withdraw row B",
          `wp8c2-r2a-b-${nextUuid()}`,
        ]),
        serviceRpc(w2, "direct_entry_self_withdraw_duplicate_cccd", [
          ADMIN_DUP.auth,
          ADMIN_DUP.app,
          dupA.entryId,
          1,
          "Race 2A withdraw row A",
          `wp8c2-r2a-a-${nextUuid()}`,
        ]),
      ]);

      const pairFulfilled = [wdB, wdA].filter((r) => r.status === "fulfilled");
      const pairRejected = [wdB, wdA].filter((r) => r.status === "rejected");
      assert.equal(pairFulfilled.length, 1, "Exactly 1 withdraw in the pair race must succeed");
      assert.equal(pairRejected.length, 1, "Exactly 1 withdraw in the pair race must fail");
      assert.equal(pairFulfilled[0].value.version, 2);
      assert.notEqual(pairRejected[0].reason.code, "40P01", "Pair withdraw race must NEVER deadlock");
      assert.notEqual(pairRejected[0].reason.code, "40001", "Pair withdraw race must NEVER raise 40001");
      assert.equal(
        pairRejected[0].reason.code,
        "PT409",
        `Expected PT409, got ${pairRejected[0].reason.code}: ${pairRejected[0].reason.message}`,
      );
      assert.match(
        pairRejected[0].reason.message,
        /self withdraw target is not an active duplicate|entry already voided/,
      );

      // Verify DB state: EXACTLY 1 row voided, EXACTLY 1 row remains active (NEVER double-voids!)
      const {
        rows: [pairCounts],
      } = await observer.query(
        `select
           count(*) filter (where voided_at is not null)::int as voided_count,
           count(*) filter (where voided_at is null)::int as active_count
         from public.direct_entries
        where entry_id = any($1::uuid[])`,
        [[dupA.entryId, dupB.entryId]],
      );
      assert.deepEqual(pairCounts, { voided_count: 1, active_count: 1 }, "Pair race must NEVER double-void both rows");

      // 2B: Race direct_entry_self_withdraw_duplicate_cccd against uncommitted direct_entry_disable_app_user
      const dupCccd2 = "001099660002";
      const dupC = await seedSubmittedWorker(setup, {
        projectId: PRJ_1,
        recruiterId: REC_1.recruiter,
        teamId: TEAM_1,
        codeDigits: "884003",
        cccd: dupCccd2,
        startDate: dates.start_d,
        createdByUserId: OWNER.app,
      });
      const dupD = await seedSubmittedWorker(setup, {
        projectId: PRJ_1,
        recruiterId: REC_1.recruiter,
        teamId: TEAM_1,
        codeDigits: "884004",
        cccd: dupCccd2,
        startDate: dates.start_d,
        createdByUserId: OWNER.app,
      });

      const adminDupVer = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [
          ADMIN_DUP.app,
        ])
      ).rows[0].version;

      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        ADMIN_DUP.app,
        adminDupVer,
        "Race 2B disable ADMIN_DUP concurrently with self withdraw",
        `wp8c2-r2b-dis-${nextUuid()}`,
      ]);

      const withdrawDisIdem = `wp8c2-r2b-wd-${nextUuid()}`;
      const withdrawDuringDisablePromise = asSettled(
        serviceRpc(w2, "direct_entry_self_withdraw_duplicate_cccd", [
          ADMIN_DUP.auth,
          ADMIN_DUP.app,
          dupC.entryId,
          1,
          "Race 2B withdraw during uncommitted disable",
          withdrawDisIdem,
        ]),
      );
      await waitUntilBlocked(observer, "wp8c2_w2");
      await w1.query("commit");

      const withdrawDuringDisRes = await withdrawDuringDisablePromise;
      assert.equal(
        withdrawDuringDisRes.status,
        "rejected",
        "self_withdraw_duplicate_cccd must fail closed after ADMIN_DUP is disabled",
      );
      assert.notEqual(withdrawDuringDisRes.reason.code, "40P01", "Race 2B must NEVER deadlock");
      assert.notEqual(withdrawDuringDisRes.reason.code, "40001", "Race 2B must NEVER raise 40001");
      assert.equal(
        withdrawDuringDisRes.reason.code,
        "42501",
        `Expected 42501 post-commit after disable, got ${withdrawDuringDisRes.reason.code}: ${withdrawDuringDisRes.reason.message}`,
      );

      // Confirm zero void & zero idempotency residue on dupC/dupD (and dupC/dupD stay active for Race 5!)
      const {
        rows: [r2bState],
      } = await observer.query(
        `select
           count(*) filter (where voided_at is not null)::int as voided_count,
           (select count(*)::int from public.direct_entry_rpc_idempotency where idempotency_key = $2) as idem_count
         from public.direct_entries
        where entry_id = any($1::uuid[])`,
        [[dupC.entryId, dupD.entryId], withdrawDisIdem],
      );
      assert.deepEqual(r2bState, { voided_count: 0, idem_count: 0 });

      // 2C (P1-2): Race ENTRY CREATOR self_withdraw_duplicate_cccd against uncommitted disable_app_user(creator)
      // Verifies unconditional post-lock `direct_entry_assert_actor_mapping` prevents a disabled creator from voiding post-disable!
      const dupCccd3 = "001099660003";
      const dupE = await seedSubmittedWorker(setup, {
        projectId: PRJ_1,
        recruiterId: REC_1.recruiter,
        teamId: TEAM_1,
        codeDigits: "884005",
        cccd: dupCccd3,
        startDate: dates.start_d,
        createdByUserId: REC_1.app,
      });
      const dupF = await seedSubmittedWorker(setup, {
        projectId: PRJ_1,
        recruiterId: REC_1.recruiter,
        teamId: TEAM_1,
        codeDigits: "884006",
        cccd: dupCccd3,
        startDate: dates.start_d,
        createdByUserId: REC_1.app,
      });

      const rec1VerForDisable = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [
          REC_1.app,
        ])
      ).rows[0].version;

      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        REC_1.app,
        rec1VerForDisable,
        "Race 2C disable creator REC_1 concurrently with own self withdraw",
        `wp8c2-r2c-dis-${nextUuid()}`,
      ]);

      const creatorWithdrawIdem = `wp8c2-r2c-wd-${nextUuid()}`;
      const creatorWithdrawPromise = asSettled(
        serviceRpc(w2, "direct_entry_self_withdraw_duplicate_cccd", [
          REC_1.auth,
          REC_1.app,
          dupE.entryId,
          1,
          "Race 2C creator self withdraw during uncommitted disable",
          creatorWithdrawIdem,
        ]),
      );
      await waitUntilBlocked(observer, "wp8c2_w2");
      await w1.query("commit");

      const creatorWithdrawRes = await creatorWithdrawPromise;
      assert.equal(
        creatorWithdrawRes.status,
        "rejected",
        "P1-2: creator self_withdraw_duplicate_cccd must fail closed after creator is disabled",
      );
      assert.notEqual(creatorWithdrawRes.reason.code, "40P01", "Race 2C must NEVER deadlock");
      assert.notEqual(creatorWithdrawRes.reason.code, "40001", "Race 2C must NEVER raise 40001");
      assert.equal(
        creatorWithdrawRes.reason.code,
        "42501",
        `Expected 42501 post-commit after creator disable, got ${creatorWithdrawRes.reason.code}: ${creatorWithdrawRes.reason.message}`,
      );

      const {
        rows: [r2cState],
      } = await observer.query(
        `select
           count(*) filter (where voided_at is not null)::int as voided_count,
           (select count(*)::int from public.direct_entry_rpc_idempotency where idempotency_key = $2) as idem_count
         from public.direct_entries
        where entry_id = any($1::uuid[])`,
        [[dupE.entryId, dupF.entryId], creatorWithdrawIdem],
      );
      assert.deepEqual(r2cState, { voided_count: 0, idem_count: 0 });

      // D10 Re-enable REC_1 and re-delete legacy mirrors so Race 3..5 retain enabled mirror-cleared REC_1
      const rec1VerForEnable = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [
          REC_1.app,
        ])
      ).rows[0].version;
      await serviceRpc(setup, "direct_entry_enable_app_user", [
        OWNER.auth,
        OWNER.app,
        REC_1.app,
        rec1VerForEnable,
        "Race 2C D10 re-enable REC_1",
        `wp8c2-r2c-en-${nextUuid()}`,
      ]);
      await deleteLegacyMirror(setup, REC_1.app);
      await assertMirrorDeleted(setup, REC_1.app);
    });

    // =========================================================================
    // RACE 3: Mirror-Cleared Managed Change Request Decision (`approve`/`reject`
    //         + `apply_change_item`) vs OCC Conflict, TL Revoke & Disable
    // =========================================================================
    await t.test("Race 3 — Mirror-Cleared Managed Change Request Decision vs OCC Conflict, TL Revoke & Disable", async () => {
      await assertMirrorDeleted(setup, PM_1.app);
      await assertMirrorDeleted(setup, REC_1.app);
      await assertMirrorDeleted(setup, ADMIN_1.app);
      await assertMirrorDeleted(setup, TL_1.app, { expectedTlTeamId: TEAM_1 });
      await assertMirrorDeleted(setup, PM_2.app);

      // Seed SUBMITTED entry in TEAM_1 / PRJ_1 for Race 3A (ENTRY_FIELD OCC conflict)
      const entryCr1 = await seedSubmittedWorker(setup, {
        projectId: PRJ_1,
        recruiterId: REC_1.recruiter,
        teamId: TEAM_1,
        codeDigits: "884101",
        cccd: "001099770001",
        startDate: dates.start_d,
        createdByUserId: OWNER.app,
      });

      // Mirror-cleared managed PM_1 proposes ENTRY_FIELD change request
      const reqField1 = await serviceRpc(w1, "direct_entry_create_change_request", [
        PM_1.auth,
        PM_1.app,
        JSON.stringify([
          {
            entry_id: entryCr1.entryId,
            target_kind: "ENTRY_FIELD",
            expected_version: 1,
            proposal: {
              worker_details: makeWorkerDetails("WP8C2 Race 3A Approved Name", entryCr1.cccd),
            },
          },
        ]),
        "Race 3A PM_1 ENTRY_FIELD proposal",
        `wp8c2-r3a-create-${nextUuid()}`,
      ]);
      assert.ok(reqField1?.request_id);

      // Verify both mirror-cleared ADMIN_1 and mirror-cleared TL_1 can read with can_decide = true
      const [readAdm, readTl] = await Promise.all([
        serviceRpc(w1, "direct_entry_read_change_request", [ADMIN_1.auth, ADMIN_1.app, reqField1.request_id]),
        serviceRpc(w2, "direct_entry_read_change_request", [TL_1.auth, TL_1.app, reqField1.request_id]),
      ]);
      assert.equal(readAdm.can_decide, true);
      assert.equal(readTl.can_decide, true);

      // 3A-i: Concurrent direct_entry_approve_change_request by mirror-cleared ADMIN_1 & TL_1
      //       with same expected_version = 1 -> EXACTLY 1 succeeds, EXACTLY 1 fails with PT409!
      const [appAdm, appTl] = await Promise.allSettled([
        serviceRpc(w1, "direct_entry_approve_change_request", [
          ADMIN_1.auth,
          ADMIN_1.app,
          reqField1.request_id,
          1,
          "Race 3A ADMIN_1 approve",
          `wp8c2-r3a-app-adm-${nextUuid()}`,
        ]),
        serviceRpc(w2, "direct_entry_approve_change_request", [
          TL_1.auth,
          TL_1.app,
          reqField1.request_id,
          1,
          "Race 3A TL_1 approve",
          `wp8c2-r3a-app-tl-${nextUuid()}`,
        ]),
      ]);
      const occWins = [appAdm, appTl].filter((r) => r.status === "fulfilled");
      const occLosses = [appAdm, appTl].filter((r) => r.status === "rejected");
      assert.equal(occWins.length, 1, "Exactly 1 concurrent approve must succeed");
      assert.equal(occLosses.length, 1, "Exactly 1 concurrent approve must fail");
      assert.equal(occWins[0].value.state, "APPROVED");
      assert.equal(occWins[0].value.version, 2);
      assert.notEqual(occLosses[0].reason.code, "40P01", "Race 3A-i must NEVER deadlock");
      assert.notEqual(occLosses[0].reason.code, "40001", "Race 3A-i must NEVER raise 40001");
      assert.equal(
        occLosses[0].reason.code,
        "PT409",
        `Expected PT409, got ${occLosses[0].reason.code}: ${occLosses[0].reason.message}`,
      );
      assert.match(occLosses[0].reason.message, /change request version conflict/);

      const {
        rows: [entryCr1After],
      } = await observer.query(
        "select version, worker_details->>'display_name' as display_name from public.direct_entries where entry_id = $1::uuid",
        [entryCr1.entryId],
      );
      assert.deepEqual(entryCr1After, { version: 2, display_name: "WP8C2 Race 3A Approved Name" });

      // 3A-ii: Mirror-cleared creator REC_1 proposes ENTRY_VOID; race approve (TL_1) vs reject (ADMIN_1)
      const entryVoid1 = await seedSubmittedWorker(setup, {
        projectId: PRJ_1,
        recruiterId: REC_1.recruiter,
        teamId: TEAM_1,
        codeDigits: "884102",
        cccd: "001099770002",
        startDate: dates.start_d,
        createdByUserId: REC_1.app,
      });
      const reqVoid1 = await serviceRpc(w1, "direct_entry_create_change_request", [
        REC_1.auth,
        REC_1.app,
        JSON.stringify([
          {
            entry_id: entryVoid1.entryId,
            target_kind: "ENTRY_VOID",
            expected_version: 1,
            proposal: {},
          },
        ]),
        "Race 3A-ii creator ENTRY_VOID proposal",
        `wp8c2-r3a-void-create-${nextUuid()}`,
      ]);
      assert.ok(reqVoid1?.request_id);

      const [voidApprove, voidReject] = await Promise.allSettled([
        serviceRpc(w1, "direct_entry_approve_change_request", [
          TL_1.auth,
          TL_1.app,
          reqVoid1.request_id,
          1,
          "Race 3A-ii TL_1 approve void",
          `wp8c2-r3a-void-app-${nextUuid()}`,
        ]),
        serviceRpc(w2, "direct_entry_reject_change_request", [
          ADMIN_1.auth,
          ADMIN_1.app,
          reqVoid1.request_id,
          1,
          "Race 3A-ii ADMIN_1 reject void",
          `wp8c2-r3a-void-rej-${nextUuid()}`,
        ]),
      ]);
      const voidWins = [voidApprove, voidReject].filter((r) => r.status === "fulfilled");
      const voidLosses = [voidApprove, voidReject].filter((r) => r.status === "rejected");
      assert.equal(voidWins.length, 1, "Exactly 1 of concurrent approve/reject on ENTRY_VOID must succeed");
      assert.equal(voidLosses.length, 1, "Exactly 1 of concurrent approve/reject on ENTRY_VOID must fail");
      assert.notEqual(voidLosses[0].reason.code, "40P01");
      assert.notEqual(voidLosses[0].reason.code, "40001");
      assert.equal(voidLosses[0].reason.code, "PT409");
      assert.match(voidLosses[0].reason.message, /change request version conflict/);

      // Mirror-cleared ADMIN_1 can read global change request history
      const historyRes = await serviceRpc(w1, "direct_entry_list_global_change_request_history", [
        ADMIN_1.auth,
        ADMIN_1.app,
        20,
        null,
        7,
      ]);
      assert.ok(Array.isArray(historyRes.requests) && historyRes.requests.length >= 2);

      // 3B: Managed TL_REV approve_change_request racing against uncommitted direct_entry_revoke_team_leader
      //     (TL_REV has 0 change_review/entry_admin grants; canonical coextensive TL rows allow revoke RPC)
      const {
        rows: [tlRevLegacyCheck],
      } = await setup.query(
        `select count(*) filter (where capability <> 'team_manager_assign')::int as non_tl_caps
           from public.direct_entry_capability_grants
          where app_user_id = $1::uuid`,
        [TL_REV.app],
      );
      assert.equal(tlRevLegacyCheck.non_tl_caps, 0, "TL_REV must hold zero non-TL capability grants");

      const entryCr2 = await seedSubmittedWorker(setup, {
        projectId: PRJ_2,
        recruiterId: PM_2.recruiter,
        teamId: TEAM_2,
        codeDigits: "884103",
        cccd: "001099770003",
        startDate: dates.start_d,
        createdByUserId: OWNER.app,
      });
      const reqTlRev = await serviceRpc(w1, "direct_entry_create_change_request", [
        PM_2.auth,
        PM_2.app,
        JSON.stringify([
          {
            entry_id: entryCr2.entryId,
            target_kind: "ENTRY_FIELD",
            expected_version: 1,
            proposal: {
              worker_details: makeWorkerDetails("WP8C2 Race 3B Should Not Apply", entryCr2.cccd),
            },
          },
        ]),
        "Race 3B PM_2 ENTRY_FIELD proposal for TL revoke race",
        `wp8c2-r3b-create-${nextUuid()}`,
      ]);
      const readTlRev = await serviceRpc(w2, "direct_entry_read_change_request", [
        TL_REV.auth,
        TL_REV.app,
        reqTlRev.request_id,
      ]);
      assert.equal(readTlRev.can_decide, true);

      const team2Ver = (
        await setup.query("select version from public.teams where team_id = $1::uuid", [TEAM_2])
      ).rows[0].version;

      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_revoke_team_leader", [
        OWNER.auth,
        OWNER.app,
        TEAM_2,
        null,
        team2Ver,
        "Race 3B revoke TL_REV on TEAM_2 concurrently with change request approve",
        `wp8c2-r3b-rev-${nextUuid()}`,
      ]);

      const approveRevIdem = `wp8c2-r3b-app-${nextUuid()}`;
      const approveDuringRevokePromise = asSettled(
        serviceRpc(w2, "direct_entry_approve_change_request", [
          TL_REV.auth,
          TL_REV.app,
          reqTlRev.request_id,
          1,
          "Race 3B TL_REV approve during uncommitted revoke",
          approveRevIdem,
        ]),
      );
      await waitUntilBlocked(observer, "wp8c2_w2");
      await w1.query("commit");

      const approveDuringRevokeRes = await approveDuringRevokePromise;
      assert.equal(approveDuringRevokeRes.status, "rejected", "Approve must fail closed after TL_REV revoked");
      assert.notEqual(approveDuringRevokeRes.reason.code, "40P01", "Race 3B must NEVER deadlock");
      assert.notEqual(approveDuringRevokeRes.reason.code, "40001", "Race 3B must NEVER raise 40001");
      assert.equal(
        approveDuringRevokeRes.reason.code,
        "42501",
        `Expected 42501 after TL revoke, got ${approveDuringRevokeRes.reason.code}: ${approveDuringRevokeRes.reason.message}`,
      );

      // Verify ZERO partial apply on entryCr2, reqTlRev, and idempotency
      const {
        rows: [r3bResidue],
      } = await observer.query(
        `select
           (select state from public.direct_entry_change_requests where request_id = $1::uuid) as req_state,
           (select version from public.direct_entry_change_requests where request_id = $1::uuid) as req_ver,
           (select version from public.direct_entries where entry_id = $2::uuid) as entry_ver,
           (select worker_details->>'display_name' from public.direct_entries where entry_id = $2::uuid) as entry_name,
           (select count(*)::int from public.direct_entry_rpc_idempotency where idempotency_key = $3) as idem_count`,
        [reqTlRev.request_id, entryCr2.entryId, approveRevIdem],
      );
      assert.deepEqual(r3bResidue, {
        req_state: "PENDING",
        req_ver: 1,
        entry_ver: 1,
        entry_name: `Worker ${entryCr2.code}`,
        idem_count: 0,
      });

      // 3C: Mirror-cleared managed TL_1 (0 legacy rows!) racing approve_change_request against
      //     uncommitted direct_entry_disable_app_user(TL_1) -> post-commit fails closed 42501, 0 partial apply!
      const entryCr3 = await seedSubmittedWorker(setup, {
        projectId: PRJ_1,
        recruiterId: REC_1.recruiter,
        teamId: TEAM_1,
        codeDigits: "884104",
        cccd: "001099770004",
        startDate: dates.start_d,
        createdByUserId: OWNER.app,
      });
      const reqTlDis = await serviceRpc(w1, "direct_entry_create_change_request", [
        PM_1.auth,
        PM_1.app,
        JSON.stringify([
          {
            entry_id: entryCr3.entryId,
            target_kind: "ENTRY_FIELD",
            expected_version: 1,
            proposal: {
              worker_details: makeWorkerDetails("WP8C2 Race 3C Should Not Apply", entryCr3.cccd),
            },
          },
        ]),
        "Race 3C PM_1 ENTRY_FIELD proposal for mirror-cleared TL_1 disable race",
        `wp8c2-r3c-create-${nextUuid()}`,
      ]);
      const tl1VerBeforeDis = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [TL_1.app])
      ).rows[0].version;

      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
        OWNER.auth,
        OWNER.app,
        TL_1.app,
        tl1VerBeforeDis,
        "Race 3C disable mirror-cleared TL_1 concurrently with change request approve",
        `wp8c2-r3c-dis-${nextUuid()}`,
      ]);

      const approveDisIdem = `wp8c2-r3c-app-${nextUuid()}`;
      const approveDuringDisPromise = asSettled(
        serviceRpc(w2, "direct_entry_approve_change_request", [
          TL_1.auth,
          TL_1.app,
          reqTlDis.request_id,
          1,
          "Race 3C mirror-cleared TL_1 approve during disable",
          approveDisIdem,
        ]),
      );
      await waitUntilBlocked(observer, "wp8c2_w2");
      await w1.query("commit");

      const approveDuringDisRes = await approveDuringDisPromise;
      assert.equal(approveDuringDisRes.status, "rejected");
      assert.notEqual(approveDuringDisRes.reason.code, "40P01");
      assert.notEqual(approveDuringDisRes.reason.code, "40001");
      assert.equal(approveDuringDisRes.reason.code, "42501");

      const {
        rows: [r3cResidue],
      } = await observer.query(
        `select
           (select state from public.direct_entry_change_requests where request_id = $1::uuid) as req_state,
           (select version from public.direct_entry_change_requests where request_id = $1::uuid) as req_ver,
           (select version from public.direct_entries where entry_id = $2::uuid) as entry_ver,
           (select count(*)::int from public.direct_entry_rpc_idempotency where idempotency_key = $3) as idem_count`,
        [reqTlDis.request_id, entryCr3.entryId, approveDisIdem],
      );
      assert.deepEqual(r3cResidue, { req_state: "PENDING", req_ver: 1, entry_ver: 1, idem_count: 0 });
    });

    // =========================================================================
    // RACE 4: Mirror-Cleared Managed Draft Submission Delete vs Transition Race
    //         (also explicitly verifies the ADMIN own-draft delete fix!)
    // =========================================================================
    await t.test("Race 4 — Mirror-Cleared Managed ADMIN Own-Draft Delete Fix & Delete vs Transition Race", async () => {
      await assertMirrorDeleted(setup, ADMIN_DRAFT.app);

      const createAdminDraft = async (codeDigits, cccd, label) => {
        const res = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
          ADMIN_DRAFT.auth,
          ADMIN_DRAFT.app,
          "worker-profile/1.2",
          JSON.stringify([
            makeBatchV1Row({
              projectId: PRJ_1,
              firstWorkDate: dates.start_d,
              employeeCode: `hrp-${dates.start_d.slice(0, 4)}-${codeDigits}`,
              recruiterId: REC_1.recruiter,
              displayName: label,
              cccd,
            }),
          ]),
          nextUuid(),
        ]);
        assert.equal(res.state, "DRAFT");
        assert.equal(res.version, 1);
        return res;
      };

      // 4-0: Explicit baseline verification of ADMIN own-draft delete fix (mirror deleted!)
      const draftBaseline = await createAdminDraft("884200", "001099880000", "WP8C2 ADMIN Draft Baseline Delete");
      const ownDrafts = await serviceRpc(w1, "direct_entry_list_own_drafts", [ADMIN_DRAFT.auth, ADMIN_DRAFT.app]);
      assert.ok(ownDrafts.drafts.some((d) => d.submission_id === draftBaseline.submission_id));

      const preflightBaseline = await serviceRpcReadOnly(r1, "direct_entry_submission_duplicate_cccd_preflight", [
        ADMIN_DRAFT.auth,
        ADMIN_DRAFT.app,
        draftBaseline.submission_id,
      ]);
      assert.equal(preflightBaseline.submission_id, draftBaseline.submission_id);

      const deletedBaseline = await serviceRpc(w1, "direct_entry_delete_draft_submission", [
        ADMIN_DRAFT.auth,
        ADMIN_DRAFT.app,
        draftBaseline.submission_id,
        1,
        `wp8c2-r4-base-del-${nextUuid()}`,
      ]);
      assert.equal(deletedBaseline.deleted, true);
      assert.equal(deletedBaseline.entries_deleted, 1);
      assert.equal(deletedBaseline.version, 2);

      // 4A: Simultaneous race — direct_entry_delete_draft_submission vs direct_entry_transition_submission('SUBMITTED')
      const draftRaceA = await createAdminDraft("884201", "001099880001", "WP8C2 Race 4A Simultaneous");
      const [delA, transA] = await Promise.allSettled([
        serviceRpc(w1, "direct_entry_delete_draft_submission", [
          ADMIN_DRAFT.auth,
          ADMIN_DRAFT.app,
          draftRaceA.submission_id,
          1,
          `wp8c2-r4a-del-${nextUuid()}`,
        ]),
        serviceRpc(w2, "direct_entry_transition_submission", [
          ADMIN_DRAFT.auth,
          ADMIN_DRAFT.app,
          draftRaceA.submission_id,
          1,
          "SUBMITTED",
          `wp8c2-r4a-trans-${nextUuid()}`,
        ]),
      ]);
      const r4aWins = [delA, transA].filter((r) => r.status === "fulfilled");
      const r4aLosses = [delA, transA].filter((r) => r.status === "rejected");
      assert.equal(r4aWins.length, 1, "Race 4A must have EXACTLY 1 winner");
      assert.equal(r4aLosses.length, 1, "Race 4A must have EXACTLY 1 loser");
      assert.notEqual(r4aLosses[0].reason.code, "40P01", "Race 4A must NEVER deadlock");
      assert.notEqual(r4aLosses[0].reason.code, "40001", "Race 4A must NEVER raise 40001");
      assert.ok(
        r4aLosses[0].reason.code === "PT409" || r4aLosses[0].reason.code === "55000",
        `Expected PT409 or 55000, got ${r4aLosses[0].reason.code}: ${r4aLosses[0].reason.message}`,
      );

      // Verify zero orphan states on draftRaceA
      const {
        rows: [r4aDbState],
      } = await observer.query(
        `select
           s.state,
           s.version,
           count(*) filter (where e.deleted_at is null)::int as live_entries,
           count(*) filter (where e.deleted_at is not null)::int as deleted_entries
         from public.direct_entry_submissions s
         join public.direct_entries e on e.submission_id = s.submission_id
        where s.submission_id = $1::uuid
        group by s.state, s.version`,
        [draftRaceA.submission_id],
      );
      assert.equal(r4aDbState.version, 2);
      if (delA.status === "fulfilled") {
        assert.deepEqual(r4aDbState, { state: "DELETED", version: 2, live_entries: 0, deleted_entries: 1 });
      } else {
        assert.deepEqual(r4aDbState, { state: "SUBMITTED", version: 2, live_entries: 1, deleted_entries: 0 });
      }

      // 4B: Deterministic Direction 1 — Delete holds uncommitted lock, Transition blocks -> Commit Delete -> Transition fails PT409
      const draftRaceB = await createAdminDraft("884202", "001099880002", "WP8C2 Race 4B Delete Wins");
      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_delete_draft_submission", [
        ADMIN_DRAFT.auth,
        ADMIN_DRAFT.app,
        draftRaceB.submission_id,
        1,
        `wp8c2-r4b-del-${nextUuid()}`,
      ]);
      const transAfterDelPromise = asSettled(
        serviceRpc(w2, "direct_entry_transition_submission", [
          ADMIN_DRAFT.auth,
          ADMIN_DRAFT.app,
          draftRaceB.submission_id,
          1,
          "SUBMITTED",
          `wp8c2-r4b-trans-${nextUuid()}`,
        ]),
      );
      await waitUntilBlocked(observer, "wp8c2_w2");
      await w1.query("commit");

      const transAfterDelRes = await transAfterDelPromise;
      assert.equal(transAfterDelRes.status, "rejected");
      assert.notEqual(transAfterDelRes.reason.code, "40P01");
      assert.notEqual(transAfterDelRes.reason.code, "40001");
      assert.equal(transAfterDelRes.reason.code, "PT409");

      const {
        rows: [r4bDbState],
      } = await observer.query(
        `select
           s.state,
           s.version,
           count(*) filter (where e.deleted_at is null)::int as live_entries,
           count(*) filter (where e.deleted_at is not null)::int as deleted_entries
         from public.direct_entry_submissions s
         join public.direct_entries e on e.submission_id = s.submission_id
        where s.submission_id = $1::uuid
        group by s.state, s.version`,
        [draftRaceB.submission_id],
      );
      assert.deepEqual(r4bDbState, { state: "DELETED", version: 2, live_entries: 0, deleted_entries: 1 });

      // 4C: Deterministic Direction 2 — Transition holds uncommitted lock, Delete blocks -> Commit Transition -> Delete fails 55000
      const draftRaceC = await createAdminDraft("884203", "001099880003", "WP8C2 Race 4C Transition Wins");
      await w1.query("begin");
      await serviceRpcInTx(w1, "direct_entry_transition_submission", [
        ADMIN_DRAFT.auth,
        ADMIN_DRAFT.app,
        draftRaceC.submission_id,
        1,
        "SUBMITTED",
        `wp8c2-r4c-trans-${nextUuid()}`,
      ]);
      const delAfterTransPromise = asSettled(
        serviceRpc(w2, "direct_entry_delete_draft_submission", [
          ADMIN_DRAFT.auth,
          ADMIN_DRAFT.app,
          draftRaceC.submission_id,
          1,
          `wp8c2-r4c-del-${nextUuid()}`,
        ]),
      );
      await waitUntilBlocked(observer, "wp8c2_w2");
      await w1.query("commit");

      const delAfterTransRes = await delAfterTransPromise;
      assert.equal(delAfterTransRes.status, "rejected");
      assert.notEqual(delAfterTransRes.reason.code, "40P01");
      assert.notEqual(delAfterTransRes.reason.code, "40001");
      assert.equal(delAfterTransRes.reason.code, "55000");
      assert.match(delAfterTransRes.reason.message, /submission is not a draft/);

      const {
        rows: [r4cDbState],
      } = await observer.query(
        `select
           s.state,
           s.version,
           count(*) filter (where e.deleted_at is null)::int as live_entries,
           count(*) filter (where e.deleted_at is not null)::int as deleted_entries
         from public.direct_entry_submissions s
         join public.direct_entries e on e.submission_id = s.submission_id
        where s.submission_id = $1::uuid
        group by s.state, s.version`,
        [draftRaceC.submission_id],
      );
      assert.deepEqual(r4cDbState, { state: "SUBMITTED", version: 2, live_entries: 1, deleted_entries: 0 });
    });

    // =========================================================================
    // RACE 5: Concurrent `STABLE` Read Burst Under Active Mutations
    // =========================================================================
    await t.test("Race 5 — Concurrent STABLE Read Burst Under Active Disable/Enable/Transition Mutations", async () => {
      await assertMirrorDeleted(setup, ADMIN_BURST.app);

      // Seed a DRAFT submission owned by mirror-cleared ADMIN_BURST (with worker-profile/1.2 so
      // CCCD reconciliation rows also exist) + a second DRAFT submission to transition concurrently
      const burstDraftStable = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
        ADMIN_BURST.auth,
        ADMIN_BURST.app,
        "worker-profile/1.2",
        JSON.stringify([
          makeBatchV1Row({
            projectId: PRJ_1,
            firstWorkDate: dates.start_d2,
            employeeCode: `hrp-${dates.start_d2.slice(0, 4)}-884301`,
            recruiterId: REC_1.recruiter,
            displayName: "WP8C2 Race 5 Stable Draft",
            cccd: "001099990001",
          }),
        ]),
        nextUuid(),
      ]);
      const burstDraftToTransition = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
        ADMIN_DRAFT.auth,
        ADMIN_DRAFT.app,
        "worker-profile/1.2",
        JSON.stringify([
          makeBatchV1Row({
            projectId: PRJ_1,
            firstWorkDate: dates.start_d2,
            employeeCode: `hrp-${dates.start_d2.slice(0, 4)}-884302`,
            recruiterId: REC_1.recruiter,
            displayName: "WP8C2 Race 5 Transitioning Draft 1",
            cccd: "001099990002",
          }),
        ]),
        nextUuid(),
      ]);
      const burstDraftToTransition2 = await serviceRpc(setup, "direct_entry_create_full_profile_batch", [
        ADMIN_DRAFT.auth,
        ADMIN_DRAFT.app,
        "worker-profile/1.2",
        JSON.stringify([
          makeBatchV1Row({
            projectId: PRJ_1,
            firstWorkDate: dates.start_d2,
            employeeCode: `hrp-${dates.start_d2.slice(0, 4)}-884303`,
            recruiterId: REC_1.recruiter,
            displayName: "WP8C2 Race 5 Transitioning Draft 2",
            cccd: "001099990003",
          }),
        ]),
        nextUuid(),
      ]);

      // 5A: Deterministic MVCC non-blocking barrier — while w1 holds uncommitted disable_app_user(ADMIN_BURST),
      //     all 4 STABLE reads execute inside READ ONLY + lock_timeout=500ms with 0 blocking and 0 0A000!
      const adminBurstVerBefore5a = (
        await setup.query("select version from public.direct_entry_app_users where app_user_id = $1::uuid", [
          ADMIN_BURST.app,
        ])
      ).rows[0].version;

      await w1.query("begin");
      try {
        await serviceRpcInTx(w1, "direct_entry_disable_app_user", [
          OWNER.auth,
          OWNER.app,
          ADMIN_BURST.app,
          adminBurstVerBefore5a,
          "Race 5A uncommitted disable barrier for STABLE MVCC proof",
          `wp8c2-r5a-mvcc-${nextUuid()}`,
        ]);

        const [authDuring, preflightDuring, queueDuring, dupDuring] = await Promise.all([
          ownerRpcReadOnly(r1, "direct_entry_create_authority", [
            ADMIN_BURST.auth,
            ADMIN_BURST.app,
            PRJ_1,
            dates.start_d2,
          ]),
          serviceRpcReadOnly(r2, "direct_entry_submission_duplicate_cccd_preflight", [
            ADMIN_BURST.auth,
            ADMIN_BURST.app,
            burstDraftStable.submission_id,
          ]),
          serviceRpcReadOnly(r3, "direct_entry_list_cccd_review_queue", [
            ADMIN_BURST.auth,
            ADMIN_BURST.app,
            "ALL",
            1,
            25,
          ]),
          serviceRpcReadOnly(r4, "direct_entry_duplicate_cccd_report", [
            ADMIN_BURST.auth,
            ADMIN_BURST.app,
            1,
            25,
            false,
          ]),
        ]);

        assert.equal(authDuring, "legacy");
        assert.equal(preflightDuring.submission_id, burstDraftStable.submission_id);
        assert.ok(queueDuring.counts.all >= 1, "Expected seeded CCCD reconciliation rows in review queue");
        assert.ok(dupDuring.total_groups >= 1, "Expected active duplicate CCCD cluster in report");
      } finally {
        await w1.query("rollback");
      }

      // 5B: 40 concurrent STABLE reads (10 iterations x 4 readers) racing against
      //     2 disable/enable cycles on ADMIN_BURST + concurrent submission transitions!
      let totalBurstReads = 0;
      const checkStableReadError = (label, err, allowedExtraCodes = []) => {
        assert.notEqual(err.code, "0A000", `${label} must NEVER raise 0A000 STABLE volatility violation`);
        assert.notEqual(err.code, "40P01", `${label} must NEVER deadlock`);
        assert.notEqual(err.code, "25006", `${label} must NEVER attempt write inside READ ONLY transaction`);
        assert.notEqual(err.code, "55P03", `${label} must NEVER block on lock_timeout`);
        assert.notEqual(err.code, "40001", `${label} must NEVER raise 40001`);
        const allowed = new Set(["42501", ...allowedExtraCodes]);
        assert.ok(allowed.has(err.code), `${label} unexpected SQLSTATE ${err.code}: ${err.message}`);
      };

      const burstOutcomes = await Promise.all([
        (async () => {
          for (let i = 0; i < 10; i += 1) {
            let authRes = null;
            try {
              authRes = await ownerRpcReadOnly(r1, "direct_entry_create_authority", [
                ADMIN_BURST.auth,
                ADMIN_BURST.app,
                PRJ_1,
                dates.start_d2,
              ]);
            } catch (err) {
              checkStableReadError("direct_entry_create_authority", err);
            }
            if (authRes !== null) {
              assert.equal(authRes, "legacy");
            }
            totalBurstReads += 1;
          }
          return "r1-ok";
        })(),
        (async () => {
          for (let i = 0; i < 10; i += 1) {
            let pf = null;
            try {
              pf = await serviceRpcReadOnly(r2, "direct_entry_submission_duplicate_cccd_preflight", [
                ADMIN_BURST.auth,
                ADMIN_BURST.app,
                burstDraftStable.submission_id,
              ]);
            } catch (err) {
              checkStableReadError("direct_entry_submission_duplicate_cccd_preflight", err);
            }
            if (pf !== null) {
              assert.equal(pf.submission_id, burstDraftStable.submission_id);
              assert.equal(typeof pf.conflict_count, "number");
            }
            totalBurstReads += 1;
          }
          return "r2-ok";
        })(),
        (async () => {
          for (let i = 0; i < 10; i += 1) {
            let q = null;
            try {
              q = await serviceRpcReadOnly(r3, "direct_entry_list_cccd_review_queue", [
                ADMIN_BURST.auth,
                ADMIN_BURST.app,
                "ALL",
                1,
                25,
              ]);
            } catch (err) {
              checkStableReadError("direct_entry_list_cccd_review_queue", err);
            }
            if (q !== null) {
              assert.ok(Array.isArray(q.items));
              assert.ok(q.counts.all >= 1);
            }
            totalBurstReads += 1;
          }
          return "r3-ok";
        })(),
        (async () => {
          for (let i = 0; i < 10; i += 1) {
            let rep = null;
            try {
              rep = await serviceRpcReadOnly(r4, "direct_entry_duplicate_cccd_report", [
                ADMIN_BURST.auth,
                ADMIN_BURST.app,
                1,
                25,
                false,
              ]);
            } catch (err) {
              checkStableReadError("direct_entry_duplicate_cccd_report", err);
            }
            if (rep !== null) {
              assert.equal(rep.authority, "business_actor");
              assert.ok(Array.isArray(rep.groups) && rep.total_groups >= 1);
            }
            totalBurstReads += 1;
          }
          return "r4-ok";
        })(),
        // Mutator 1: 2 disable -> enable cycles on ADMIN_BURST
        (async () => {
          let ver = adminBurstVerBefore5a;
          for (let cycle = 1; cycle <= 2; cycle += 1) {
            const dis = await serviceRpc(w1, "direct_entry_disable_app_user", [
              OWNER.auth,
              OWNER.app,
              ADMIN_BURST.app,
              ver,
              `Race 5B disable cycle ${cycle}`,
              `wp8c2-r5b-dis-${cycle}-${nextUuid()}`,
            ]);
            ver = dis.version;
            const en = await serviceRpc(w1, "direct_entry_enable_app_user", [
              OWNER.auth,
              OWNER.app,
              ADMIN_BURST.app,
              ver,
              `Race 5B enable cycle ${cycle}`,
              `wp8c2-r5b-en-${cycle}-${nextUuid()}`,
            ]);
            ver = en.version;
          }
          return "mutator-disable-enable-ok";
        })(),
        // Mutator 2: concurrent DRAFT -> SUBMITTED transitions
        (async () => {
          const t1 = await serviceRpc(w2, "direct_entry_transition_submission", [
            ADMIN_DRAFT.auth,
            ADMIN_DRAFT.app,
            burstDraftToTransition.submission_id,
            1,
            "SUBMITTED",
            `wp8c2-r5b-tr1-${nextUuid()}`,
          ]);
          assert.equal(t1.state, "SUBMITTED");
          const t2 = await serviceRpc(w2, "direct_entry_transition_submission", [
            ADMIN_DRAFT.auth,
            ADMIN_DRAFT.app,
            burstDraftToTransition2.submission_id,
            1,
            "SUBMITTED",
            `wp8c2-r5b-tr2-${nextUuid()}`,
          ]);
          assert.equal(t2.state, "SUBMITTED");
          return "mutator-transition-ok";
        })(),
      ]);

      assert.deepEqual(burstOutcomes, [
        "r1-ok",
        "r2-ok",
        "r3-ok",
        "r4-ok",
        "mutator-disable-enable-ok",
        "mutator-transition-ok",
      ]);
      assert.equal(totalBurstReads, 40, "Expected 40 concurrent STABLE reads during active mutations");

      // Post-burst: re-DELETE ADMIN_BURST legacy mirror and prove all 4 STABLE reads succeed cleanly
      await deleteLegacyMirror(setup, ADMIN_BURST.app);
      await assertMirrorDeleted(setup, ADMIN_BURST.app);

      const [authAfter, preflightAfter, queueAfter, dupAfter] = await Promise.all([
        ownerRpcReadOnly(r1, "direct_entry_create_authority", [
          ADMIN_BURST.auth,
          ADMIN_BURST.app,
          PRJ_1,
          dates.start_d2,
        ]),
        serviceRpcReadOnly(r2, "direct_entry_submission_duplicate_cccd_preflight", [
          ADMIN_BURST.auth,
          ADMIN_BURST.app,
          burstDraftStable.submission_id,
        ]),
        serviceRpcReadOnly(r3, "direct_entry_list_cccd_review_queue", [
          ADMIN_BURST.auth,
          ADMIN_BURST.app,
          "ALL",
          1,
          25,
        ]),
        serviceRpcReadOnly(r4, "direct_entry_duplicate_cccd_report", [
          ADMIN_BURST.auth,
          ADMIN_BURST.app,
          1,
          25,
          false,
        ]),
      ]);
      assert.equal(authAfter, "legacy");
      assert.equal(preflightAfter.submission_id, burstDraftStable.submission_id);
      assert.ok(queueAfter.counts.all >= 1);
      assert.ok(dupAfter.total_groups >= 1);
    });
  } finally {
    for (const c of clients) {
      await c.end().catch(() => {});
    }
    if (started && pgCtl) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "fast", "-w", "stop"], {
        encoding: "utf8",
        stdio: "ignore",
        windowsHide: true,
      });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
