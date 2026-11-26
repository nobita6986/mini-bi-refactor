/**
 * P2.5-HF-R5B-R2 - importer regression: manifest .csv -> canonical RPC (#57-#61).
 * Moi assert di qua chinh runImport/transaction/RPC; khong mock canonical data.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

import { parseImportArgs, runImport } from "./t0-import-workers.mjs";
import {
  IMPORT_REQUIRED_MIGRATIONS, IMPORT_WORKER_DETAIL_KEYS, buildImportPlan, deterministicUuid,
  readImportSource, resolveOperator, validateManifest, toContractRow,
} from "./lib/t0-operator-import.mjs";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BATCH_A = "00000000-0000-4000-8000-000000009001";
const BATCH_B = "00000000-0000-4000-8000-000000009002";
const BATCH_C = "00000000-0000-4000-8000-000000009003";
const OPERATOR_LOGIN = "t0-ops@example.test";
const UPLOADER_LOGIN = "t0-uploader@example.test";
const UPLOADER2_LOGIN = "t0-uploader-two@example.test";
const MGR_LOGIN = "t0-mgr@example.test";
const CCCD = "012345678901";
const OTHER_CCCD = "999888777666";
const REASON = "T0 operator bulk import run";
const MIGRATION_DIR = path.resolve("supabase/migrations");
const COLUMNS = ["source_row_id", "uploader_login", "project_id", "first_work_date",
  "display_name", "national_id", "provider_type", "recruiter_code", "labor_type", "target_state",
  "date_of_birth_text", "address", "phone"];

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}

const TEAM = uuid(11);
const PROJ_A = "t0_proj_a", PROJ_B = "t0_proj_b", PROJ_C = "t0_proj_c", PROJ_D = "t0_proj_d";
const REC_A = "Rec A", REC_B = "Rec B", REC_C = "Rec C", REC_D = "Rec D",
  REC_FUTURE = "Rec Future", REC_NO_ACCESS = "Rec No Access";
const UP3_AUTH = uuid(35), UP3_APP = uuid(45);
const UP4_AUTH = uuid(36), UP4_APP = uuid(46);
const UP3_LOGIN = "t0-pm-future@example.test", UP4_LOGIN = "t0-pm-expired@example.test";
const UP5_AUTH = uuid(37), UP5_APP = uuid(47);
const UP5_LOGIN = "t0-pm-no-own-scope@example.test";
const STATUS_AUTH = uuid(38), STATUS_APP = uuid(48);
const OPS_AUTH = uuid(31), OPS_APP = uuid(41);
const UP_AUTH = uuid(32), UP_APP = uuid(42);
const UP2_AUTH = uuid(33), UP2_APP = uuid(43);
const MGR_AUTH = uuid(34), MGR_APP = uuid(44);

const UP5_GROUP_CODE = "T0_ENTRY_CREATE_ONLY";
const MGR_GROUP_CODE = "T0_CHANGE_REQUEST_ONLY";
const HR_OPS_LOGIN = "t0-hr-ops@example.test";
const HR_OPS_AUTH = uuid(39), HR_OPS_APP = uuid(49);
const DISABLED_OPS_LOGIN = "t0-disabled-ops@example.test";
const DISABLED_OPS_AUTH = uuid(50), DISABLED_OPS_APP = uuid(51);

async function buildDb(ledger = IMPORT_REQUIRED_MIGRATIONS) {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role;" +
    " create schema auth; create table auth.users (id uuid primary key, email text);");
  for (const name of (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort()) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  await db.exec("create table public.schema_migrations (version text primary key, checksum text)");
  for (const version of ledger) {
    await db.query("insert into public.schema_migrations (version, checksum) values ($1,'x')",
      [version]);
  }
  return db;
}

async function ensureCustomGroup(db, code, name, capabilities) {
  const existing = await db.query(
    "select group_id::text as group_id from public.authz_user_groups where code = $1",
    [code],
  );
  if (existing.rows.length === 1) return existing.rows[0].group_id;
  const inserted = await db.query(
    "insert into public.authz_user_groups (code, name, description, department_id, team_id, is_system_admin, active)" +
    " select $1, $2, $2, d.department_id, null, false, true" +
    "   from public.organization_departments d where d.system_key = 'RECRUITMENT' limit 1" +
    " returning group_id::text as group_id",
    [code, name],
  );
  const groupId = inserted.rows[0].group_id;
  for (const capability of capabilities) {
    await db.query(
      "insert into public.authz_user_group_capabilities (group_id, capability, reason)" +
      " values ($1::uuid, $2, 'T0 import test fixture group')",
      [groupId, capability],
    );
  }
  return groupId;
}

async function assignGroupMember(db, appUserId, groupCode, options = {}) {
  const {
    startedAt = "2020-01-01T00:00:00Z",
    endedAt = null,
    endedByAppUserId = null,
    endedReason = null,
  } = options;
  await db.query(
    "insert into public.authz_user_group_members" +
    " (group_id, app_user_id, source_kind, reason, started_at, ended_at, ended_by_app_user_id, ended_reason)" +
    " select g.group_id, $1::uuid, 'ADMIN_ASSIGNMENT', 'T0 import test membership', $3::timestamptz, $4::timestamptz, $5::uuid, $6" +
    "   from public.authz_user_groups g where g.code = $2",
    [appUserId, groupCode, startedAt, endedAt, endedByAppUserId, endedReason],
  );
}

async function insertActor(db, auth, app, email, groupCodes, { enabled = true } = {}) {
  await db.query("insert into auth.users (id, email) values ($1,$2)", [auth, email]);
  await db.query("insert into public.direct_entry_app_users" +
    " (app_user_id, auth_subject, enabled, authz_managed, display_name) values ($1,$2,$3,true,$4)",
    [app, auth, enabled, email.split("@")[0]]);
  for (const groupCode of groupCodes) {
    await assignGroupMember(db, app, groupCode);
  }
}

async function seed(db) {
  await db.query("insert into public.teams (team_id, code, display_name)" +
    " values ($1,'T0OPS','Team T0 Ops')", [TEAM]);
  for (const [project, name] of [[PROJ_A, "T0 Project A"], [PROJ_B, "T0 Project B"],
    [PROJ_C, "T0 Project C"], [PROJ_D, "T0 Project D"]]) {
    await db.query("insert into public.direct_entry_projects (project_id, display_name)" +
      " values ($1,$2)", [project, name]);
  }
  for (const name of [REC_A, REC_B, REC_C, REC_D, REC_FUTURE, REC_NO_ACCESS]) {
    await db.query("insert into public.recruiters (recruiter_id, display_name) values" +
      " (gen_random_uuid(),$1)", [name]);
    await db.query("insert into public.recruiter_provider_memberships" +
      " (recruiter_id, provider_type, valid_from, is_current)" +
      " select recruiter_id,'hrp','2020-01-01',true from public.recruiters where display_name = $1",
      [name]);
    await db.query("insert into public.recruiter_team_memberships" +
      " (recruiter_id, team_id, valid_from, is_current)" +
      " select recruiter_id,$2,'2020-01-01',true from public.recruiters where display_name = $1",
      [name, TEAM]);
  }
  await ensureCustomGroup(db, UP5_GROUP_CODE, "T0 Entry Create Only", ["entry_create"]);
  await ensureCustomGroup(db, MGR_GROUP_CODE, "T0 Change Request Only", ["change_request_create"]);

  await insertActor(db, OPS_AUTH, OPS_APP, OPERATOR_LOGIN, ["SYSTEM_ADMIN"]);
  // Business uploaders are project managers: assigned PM grants project create authority, while
  // RECRUITER_OPERATIONS provides submission_create @ OWN for direct_entry_transition_submission.
  await insertActor(db, UP_AUTH, UP_APP, UPLOADER_LOGIN, ["RECRUITER_OPERATIONS"]);
  await insertActor(db, UP2_AUTH, UP2_APP, UPLOADER2_LOGIN, ["RECRUITER_OPERATIONS"]);
  // Negative fixture: PM of project A with entry_create only (NO submission_create permission).
  await insertActor(db, UP5_AUTH, UP5_APP, UP5_LOGIN, [UP5_GROUP_CODE]);
  await assignProject(db, { project: PROJ_A, recruiterName: REC_C, app: UP5_APP });
  // Status fixture: separate canonical actor for closing an episode (not the importer flow).
  await insertActor(db, STATUS_AUTH, STATUS_APP, "t0-status-admin@example.test", ["SYSTEM_ADMIN"]);
  await assignProject(db, { project: PROJ_A, recruiterName: REC_A, app: UP_APP });
  await assignProject(db, { project: PROJ_B, recruiterName: REC_B, app: UP2_APP });
  // Negative fixtures: future and expired assignments on projects C and D.
  await insertActor(db, UP3_AUTH, UP3_APP, UP3_LOGIN, ["RECRUITER_OPERATIONS"]);
  await insertActor(db, UP4_AUTH, UP4_APP, UP4_LOGIN, ["RECRUITER_OPERATIONS"]);
  // Each negative fixture lives on its own project: the canonical assignment guard forbids
  // overlapping intervals on one project, and a single assignment per project is a valid seed.
  await assignProject(db, { project: PROJ_C, recruiterName: REC_FUTURE, app: UP3_APP,
    validFrom: "2027-01-01", isCurrent: false });
  await assignProject(db, { project: PROJ_D, recruiterName: REC_D, app: UP4_APP,
    validFrom: "2020-01-01", validTo: "2020-06-01", isCurrent: false });
  // Manager fixture without assignment and without ALL/entry_admin access.
  await insertActor(db, MGR_AUTH, MGR_APP, MGR_LOGIN, [MGR_GROUP_CODE]);
  // HR catalog fixture: has ALL scope capabilities (e.g. recruiter_master_manage) but NOT entry_admin.
  await insertActor(db, HR_OPS_AUTH, HR_OPS_APP, HR_OPS_LOGIN, ["HR_CATALOG_OPERATOR"]);
  // Disabled operator fixture: even with SYSTEM_ADMIN membership, disabled account is rejected.
  await insertActor(db, DISABLED_OPS_AUTH, DISABLED_OPS_APP, DISABLED_OPS_LOGIN, ["SYSTEM_ADMIN"], {
    enabled: false,
  });
  // MGR keeps a verified link but NO assignment: the negative fixture for "no project access".
  await db.query("insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from, is_current)" +
    " select $1, recruiter_id, true, '2020-01-01', true from public.recruiters where display_name = $2",
    [MGR_APP, REC_NO_ACCESS]);
}

/** Assignment + verified link, seeded trong mot lan (valid_to di kem revoked_at). */
async function assignProject(db, { project, recruiterName, app, validFrom = "2020-01-01",
  validTo = null, isCurrent = true }) {
  await db.query("insert into public.direct_entry_app_user_recruiter_links" +
    " (app_user_id, recruiter_id, verified, valid_from, is_current)" +
    " select $1, recruiter_id, true, '2020-01-01', true from public.recruiters where display_name = $2",
    [app, recruiterName]);
  await db.query("insert into public.direct_entry_project_manager_assignments" +
    " (project_id, manager_recruiter_id, valid_from, valid_to, revoked_at, is_current)" +
    " select $1, recruiter_id, $3::date, $4::date," +
    " case when $4::date is null then null else now() end" +
    " ,$5::boolean" +
    " from public.recruiters where display_name = $2",
    [project, recruiterName, validFrom, validTo, isCurrent]);
}

function clientOf(db, override = null) {
  return { query: (sql, params) => (override ? override(sql, params, db) : db.query(sql, params)),
    end: async () => {} };
}

function dependenciesFor(db, override = null) {
  const calls = { connect: 0 };
  return { calls, deps: { loadConfig: async () => ({ databaseUrl: "unused" }),
    createClient: () => { calls.connect += 1; return clientOf(db, override); } } };
}

function csvCell(value) {
  const raw = value === undefined || value === null ? "" : String(value);
  return /[",\n]/.test(raw) ? '"' + raw.replace(/"/g, '""') + '"' : raw;
}

async function manifestFile(rows) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "t0-import-"));
  const file = path.join(directory, "manifest.csv");
  const lines = [COLUMNS.join(",")];
  for (const row of rows) lines.push(COLUMNS.map((column) => csvCell(row[column])).join(","));
  await writeFile(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function row(overrides = {}) {
  return {
    source_row_id: "1", uploader_login: UPLOADER_LOGIN, project_id: PROJ_A,
    first_work_date: "2026-10-01", display_name: "T0 Worker", national_id: CCCD,
    provider_type: "hrp", recruiter_code: REC_A, labor_type: "TEMPORARY", target_state: "DRAFT",
    date_of_birth_text: "1990-01-01", address: "T0 address", phone: "0900000000",
    ...overrides,
  };
}

async function optionsFor(input, batchId, mode = "apply", operator = OPERATOR_LOGIN) {
  const base = { mode, input, batchId, operator, reason: REASON, confirm: null };
  if (mode === "apply") {
    base.confirm = (await import("./lib/t0-operator-import.mjs"))
      .confirmationToken((await readImportSource(path.resolve(input))).fingerprint);
  }
  return base;
}

async function entryCount(db) {
  return Number((await db.query("select count(*)::int as n from public.direct_entries")).rows[0].n);
}

function assertNoLeak(payload, extra = []) {
  const serialized = JSON.stringify(payload);
  assert.equal(UUID_RE.test(serialized), false, "no UUID in output");
  assert.equal(serialized.includes("@"), false, "no email in output");
  for (const secret of [...extra, CCCD, OTHER_CCCD, "T0 Worker", "T0 address", "0900000000",
    REASON, "violates", "constraint"]) {
    assert.equal(serialized.includes(secret), false, "leaked: " + secret);
  }
}

test("R5B-R2: worker_details is a canonical subset and never carries display_name", () => {
  const base = {
    source_row_id: "1", uploader_login: UPLOADER_LOGIN, project_id: PROJ_A,
    first_work_date: "2026-10-01", display_name: "T0 Worker", national_id: CCCD,
    provider_type: "hrp", recruiter_code: REC_A, labor_type: "TEMPORARY", target_state: "DRAFT",
  };
  const minimal = toContractRow({ ...validateManifest([base]).rows[0], project_id: PROJ_A,
    recruiter_id: uuid(99) });
  const minimalKeys = Object.keys(minimal.worker_details);
  assert.ok(minimalKeys.every((key) => IMPORT_WORKER_DETAIL_KEYS.includes(key)),
    "every key must be canonical");
  assert.equal(minimalKeys.includes("display_name"), false, "display_name is top-level only");
  assert.equal(minimal.display_name, "T0 Worker");
  for (const key of ["national_id", "date_of_birth", "address", "phone"]) {
    assert.ok(minimalKeys.includes(key), key + " must always be present");
  }
  assert.equal(minimalKeys.includes("national_id_issued_at"), false,
    "a blank optional field stays absent");

  const full = toContractRow({ ...validateManifest([{ ...base, gender: "MALE",
    date_of_birth_text: "1990-01-01", national_id_issued_at_text: "2020-06-01",
    national_id_issued_place: "Noi cap", address: "T0 address", phone: "0900000000" }]).rows[0],
    project_id: PROJ_A, recruiter_id: uuid(99) });
  assert.deepEqual(Object.keys(full.worker_details).sort(),
    [...IMPORT_WORKER_DETAIL_KEYS].sort(), "the full optional set equals the allowlist");
  assert.equal(full.worker_details.gender.value, "MALE");
  assert.equal(full.worker_details.national_id_issued_at.value, "2020-06-01");
  assert.equal(full.worker_details.national_id.value, CCCD, "leading zero preserved as text");

  // Mutation check: display_name or an unknown key inside worker_details must fail the rule.
  for (const injected of [{ display_name: "T0 Worker" }, { nickname: "T0" }]) {
    const mutated = { ...full, worker_details: { ...full.worker_details, ...injected } };
    assert.equal(Object.keys(mutated.worker_details)
      .every((key) => IMPORT_WORKER_DETAIL_KEYS.includes(key)), false,
    "mutation must be detected: " + Object.keys(injected)[0]);
  }
});

test("R5B-R2: deterministic keys are unique per chunk and per transition", () => {
  const uploaderA = { app_user_id: UP_APP, auth_subject: UP_AUTH };
  const uploaderB = { app_user_id: UP2_APP, auth_subject: UP2_AUTH };
  const plan = buildImportPlan([
    { sourceRowId: "1", uploaderLogin: UPLOADER_LOGIN, uploader: uploaderA, target_state: "DRAFT" },
    { sourceRowId: "2", uploaderLogin: UPLOADER_LOGIN, uploader: uploaderA,
      target_state: "SUBMITTED" },
    { sourceRowId: "3", uploaderLogin: UPLOADER2_LOGIN, uploader: uploaderB,
      target_state: "DRAFT" },
    { sourceRowId: "4", uploaderLogin: UPLOADER2_LOGIN, uploader: uploaderB,
      target_state: "SUBMITTED" },
  ], BATCH_A);
  assert.equal(plan.length, 4, "uploader + target_state groups are deterministic");
  const keys = new Set(plan.map((chunk) => chunk.idempotencyKey));
  assert.equal(keys.size, 4, "each create chunk has its own idempotency key");
  const first = "11111111-1111-4111-8111-111111111111";
  const submitted = deterministicUuid("t0-import-transition", BATCH_A, first, "SUBMITTED");
  assert.equal(submitted, deterministicUuid("t0-import-transition", BATCH_A, first, "SUBMITTED"));
  assert.equal(keys.has(submitted), false);
});

test("R5B-R2: reason is validated before any connection", async () => {
  const db = await buildDb();
  try {
    const input = await manifestFile([row()]);
    assert.throws(() => parseImportArgs(["--check", "--input"]), /ARGUMENTS_INVALID/);
    for (const bad of ["short", "mail me at t0@example.test now",
      "batch 00000000-0000-4000-8000-000000009001 done", "reply to 012345678901 please",
      "bad\u0007reason"]) {
      const deps = dependenciesFor(db);
      const result = await runImport({ ...(await optionsFor(input, BATCH_A, "check")),
        reason: bad }, deps.deps);
      assert.equal(result.code, "OPERATOR_INPUT_INVALID", bad);
      assert.equal(deps.calls.connect, 0, "reason screening happens before the DB");
      assertNoLeak(result, [bad]);
    }
    const missingToken = dependenciesFor(db);
    const denied = await runImport({ ...(await optionsFor(input, BATCH_A, "check")),
      mode: "apply", confirm: null }, missingToken.deps);
    assert.equal(denied.code, "CONFIRMATION_REQUIRED");
    assert.equal(missingToken.calls.connect, 0);
    assertNoLeak(denied);
  } finally {
    await db.close();
  }
});

test("R1 / WP10-7-3C: operator import authorization follows canonical Permission Groups", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const resolved = await resolveOperator(clientOf(db), OPERATOR_LOGIN);
    assert.equal(resolved.ok, true, "active SYSTEM_ADMIN operator resolves cleanly");
    assert.deepEqual(Object.keys(resolved.operator).sort(),
      ["app_user_id", "auth_subject", "capabilities", "scopes"]);
    assert.equal(resolved.operator.capabilities.includes("entry_admin"), true);
    assert.equal(resolved.operator.scopes.includes("all"), true);

    const input = await manifestFile([row()]);
    const result = await runImport(await optionsFor(input, BATCH_C, "check"),
      dependenciesFor(db).deps);
    assert.equal(result.ok, true, JSON.stringify(result));

    // Negative: missing entry_admin (HR_CATALOG_OPERATOR has ALL scope, no entry_admin)
    assert.deepEqual(await resolveOperator(clientOf(db), HR_OPS_LOGIN),
      { ok: false, code: "OPERATOR_NOT_AUTHORIZED" });
    // Negative: OWN scope only (RECRUITER_OPERATIONS)
    assert.deepEqual(await resolveOperator(clientOf(db), UPLOADER_LOGIN),
      { ok: false, code: "OPERATOR_NOT_AUTHORIZED" });
    // Negative: disabled operator even with active SYSTEM_ADMIN membership
    assert.deepEqual(await resolveOperator(clientOf(db), DISABLED_OPS_LOGIN),
      { ok: false, code: "OPERATOR_NOT_FOUND" });

    // Negative: future-dated SYSTEM_ADMIN membership is rejected
    const futureAuth = uuid(52), futureApp = uuid(53);
    const futureLogin = "t0-future-ops@example.test";
    await insertActor(db, futureAuth, futureApp, futureLogin, []);
    await assignGroupMember(db, futureApp, "SYSTEM_ADMIN", { startedAt: "2099-01-01T00:00:00Z" });
    assert.deepEqual(await resolveOperator(clientOf(db), futureLogin),
      { ok: false, code: "OPERATOR_NOT_AUTHORIZED" });

    // Negative: ended/expired SYSTEM_ADMIN membership is rejected
    const expiredAuth = uuid(54), expiredApp = uuid(55);
    const expiredLogin = "t0-expired-ops@example.test";
    await insertActor(db, expiredAuth, expiredApp, expiredLogin, []);
    await assignGroupMember(db, expiredApp, "SYSTEM_ADMIN", {
      startedAt: "2020-01-01T00:00:00Z",
      endedAt: "2020-06-01T00:00:00Z",
      endedByAppUserId: OPS_APP,
      endedReason: "Expired test membership",
    });
    assert.deepEqual(await resolveOperator(clientOf(db), expiredLogin),
      { ok: false, code: "OPERATOR_NOT_AUTHORIZED" });
  } finally {
    await db.close();
  }
});

test("R5B-R2: uploader is the created_by, operator is the batch audit actor", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const input = await manifestFile([row()]);
    const result = await runImport(await optionsFor(input, BATCH_A), dependenciesFor(db).deps);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.batch_audit.count, 1);
    assert.equal(result.checks.operator_audit, 1);
    const entry = (await db.query("select created_by_user_id::text as created_by from" +
      " public.direct_entries")).rows[0];
    assert.equal(entry.created_by, UP_APP, "created_by is the business uploader");
    const audit = (await db.query("select a.app_user_id::text as actor, a.action, a.outcome," +
      " a.scope_kind, a.resource_ref, r.actor_user_id::text as reason_actor," +
      " r.reason_text from public.direct_entry_audit_events a" +
      " join public.direct_entry_restricted_reasons r on r.reason_id = a.reason_id" +
      " where a.action = 't0_worker_import'")).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor, OPS_APP, "technical operator owns the batch audit");
    assert.equal(audit[0].reason_actor, OPS_APP);
    assert.equal(audit[0].scope_kind, "all");
    assert.equal(audit[0].outcome, "APPLIED");
    assert.equal(audit[0].resource_ref, BATCH_A);
    assert.ok(audit[0].reason_text.includes("fp " + result.fingerprint));
    assertNoLeak(result);

    // Replay: same batch + same source -> no extra reason/audit/rows.
    const replay = await runImport(await optionsFor(input, BATCH_A), dependenciesFor(db).deps);
    assert.equal(replay.ok, true);
    assert.equal(replay.batch_audit.replayed, true);
    assert.equal(await entryCount(db), 1);
    assert.equal(Number((await db.query("select count(*)::int as n from" +
      " public.direct_entry_audit_events where action = 't0_worker_import'")).rows[0].n), 1);

    // Same batch id with a different source -> conflict before mutation.
    const changed = await manifestFile([row({ display_name: "T0 Worker Changed" })]);
    const conflict = await runImport(await optionsFor(changed, BATCH_A), dependenciesFor(db).deps);
    assert.equal(conflict.code, "BATCH_ID_REUSED_WITH_DIFFERENT_SOURCE");
    assert.equal(await entryCount(db), 1);
    assertNoLeak(conflict, ["T0 Worker Changed"]);
  } finally {
    await db.close();
  }
});

test("R5B-R2: check rollback, apply commit, SUBMITTED transitions and zero residue", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // Two SUBMITTED rows share one uploader + target_state -> ONE chunk -> ONE submission and
    // one direct transition; the DRAFT row is a second chunk that never transitions.
    const mixed = await manifestFile([
      row({ source_row_id: "1", target_state: "SUBMITTED" }),
      row({ source_row_id: "3", target_state: "SUBMITTED", national_id: "123123123123",
        display_name: "T0 Worker Three" }),
      row({ source_row_id: "2", uploader_login: UPLOADER2_LOGIN, project_id: PROJ_B,
        recruiter_code: REC_B, national_id: OTHER_CCCD, display_name: "T0 Worker Two" }),
    ]);
    const check = await runImport(await optionsFor(mixed, BATCH_A, "check"), dependenciesFor(db).deps);
    assert.equal(check.ok, true, JSON.stringify(check));
    assert.equal(check.committed, false);
    assert.equal(check.groups, 2);
    assert.equal(check.chunks, 2);
    assert.equal(check.transitions, 1, "one submission transitions directly once");
    assert.equal(await entryCount(db), 0, "check mode rolls back");

    const apply = await runImport(await optionsFor(mixed, BATCH_A), dependenciesFor(db).deps);
    assert.equal(apply.ok, true, JSON.stringify(apply));
    assert.equal(await entryCount(db), 3);
    assert.equal(apply.transitions, 1);
    assert.equal(Number((await db.query("select count(*)::int as n from" +
      " public.direct_entry_submissions")).rows[0].n), 2, "one submission per chunk");
    const states = (await db.query("select s.state, count(*)::int as n from public.direct_entries e" +
      " join public.direct_entry_submissions s on s.submission_id = e.submission_id" +
      " group by 1 order by 1")).rows;
    assert.deepEqual(states, [{ state: "DRAFT", n: 1 }, { state: "SUBMITTED", n: 2 }]);
    assert.equal(Number((await db.query("select count(*)::int as n from" +
      " public.direct_entry_employment_status_events")).rows[0].n), 3);

    // Partial failure: one bad row fails the whole batch with zero residue.
    const bad = await manifestFile([row({ source_row_id: "1", national_id: "111111111111" }),
      row({ source_row_id: "2", project_id: "t0_missing_project", national_id: "222222222222" })]);
    const failed = await runImport(await optionsFor(bad, BATCH_B), dependenciesFor(db).deps);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, "REFERENCE_NOT_RESOLVED");
    assert.equal(await entryCount(db), 3, "no partial write");

    // PM of the right project but without the own scope: the create runs, the transition is
    // denied, and the OUTER transaction rolls everything back (entries, reason, operator audit).
    const auditBefore = Number((await db.query("select count(*)::int as n from" +
      " public.direct_entry_audit_events where action = 't0_worker_import'")).rows[0].n);
    const reasonsBefore = Number((await db.query("select count(*)::int as n from" +
      " public.direct_entry_restricted_reasons")).rows[0].n);
    const noOwnScope = await runImport(await optionsFor(await manifestFile([row({
      uploader_login: UP5_LOGIN, target_state: "SUBMITTED", national_id: "456456456456" })]),
      BATCH_B), dependenciesFor(db).deps);
    assert.equal(noOwnScope.code, "AUTHORITY_DENIED", "got " + noOwnScope.code);
    assert.equal(await entryCount(db), 3, "transition failure rolls the batch back");
    assert.equal(Number((await db.query("select count(*)::int as n from" +
      " public.direct_entry_audit_events where action = 't0_worker_import'")).rows[0].n),
    auditBefore, "no operator audit residue");
    assert.equal(Number((await db.query("select count(*)::int as n from" +
      " public.direct_entry_restricted_reasons")).rows[0].n), reasonsBefore,
    "no reason residue");
    assertNoLeak(noOwnScope, ["456456456456"]);
    assertNoLeak(failed, ["111111111111", "222222222222", "t0_missing_project"]);

    // Ledger gate fails closed in both modes.
    const oldDb = await buildDb(IMPORT_REQUIRED_MIGRATIONS.slice(0, -1));
    try {
      await seed(oldDb);
      const gate = await runImport(await optionsFor(mixed, BATCH_A), dependenciesFor(oldDb).deps);
      assert.equal(gate.code, "MIGRATION_LEDGER_PENDING");
      assert.deepEqual(gate.ledger.pending_names, [IMPORT_REQUIRED_MIGRATIONS.at(-1)]);
      assert.equal(await entryCount(oldDb), 0);
    } finally {
      await oldDb.close();
    }
  } finally {
    await db.close();
  }
});

test("R5B-R2: authority, expired assignment, episode rules and postcheck failure", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // Manager of project B only: no authority for project A.
    const denied = await runImport(await optionsFor(await manifestFile([row()]), BATCH_A, "check",
      MGR_LOGIN), dependenciesFor(db).deps);
    assert.equal(denied.code, "OPERATOR_NOT_AUTHORIZED");
    const noAccount = await runImport(await optionsFor(await manifestFile([row()]), BATCH_A, "check",
      "nobody@example.test"), dependenciesFor(db).deps);
    assert.equal(noAccount.code, "OPERATOR_NOT_FOUND");

    // Negative fixtures: legacy-bundle actor without assignment, then PM outside/future/expired.
    for (const [label, uploaderLogin, code, project] of [
      ["uploader without assignment", MGR_LOGIN, "UPLOADER_PROJECT_ACCESS_DENIED", PROJ_A],
      ["PM future assignment", UP3_LOGIN, "UPLOADER_PROJECT_ACCESS_DENIED", PROJ_C],
    ]) {
      const deniedRow = await runImport(
        await optionsFor(await manifestFile([row({ uploader_login: uploaderLogin,
          project_id: project })]), BATCH_A, "check"), dependenciesFor(db).deps);
      assert.equal(deniedRow.code, code, label + " got " + deniedRow.code);
      assert.equal(await entryCount(db), 0, label + " must leave zero residue");
      assertNoLeak(deniedRow);
    }
    // Expired assignment (valid_to + revoked_at seeded together): project D uploader denied.
    const expired = await runImport(await optionsFor(
      await manifestFile([row({ uploader_login: UP4_LOGIN, project_id: PROJ_D,
        recruiter_code: REC_D })]), BATCH_A, "check"), dependenciesFor(db).deps);
    assert.equal(expired.code, "UPLOADER_PROJECT_ACCESS_DENIED", "got " + expired.code);
    assert.equal(await entryCount(db), 0);
    // The correct-project PM is allowed: the same row with the project-A uploader passes.
    const allowed = await runImport(await optionsFor(await manifestFile([row()]), BATCH_A, "check"),
      dependenciesFor(db).deps);
    assert.equal(allowed.ok, true, JSON.stringify(allowed));

    // Active episode blocks a rehire, canonical OFF allows a new episode with a new code.
    const first = await runImport(await optionsFor(await manifestFile([row()]), BATCH_A),
      dependenciesFor(db).deps);
    assert.equal(first.ok, true, JSON.stringify(first));
    const created = (await db.query("select e.entry_id::text as id, e.employee_code, e.version," +
      " (select count(*)::int from public.direct_entry_employment_status_events st" +
      "   where st.entry_id = e.entry_id) as events," +
      " (select st.status from public.direct_entry_employment_status_events st" +
      "   where st.entry_id = e.entry_id order by st.version desc limit 1) as status," +
      " worker_details->'national_id'->>'value' as national_id from public.direct_entries e"))
      .rows[0];
    assert.equal(created.status, "ON", "R1: new profile starts ON without an extra event");
    assert.equal(Number(created.events), 1);
    assert.equal(created.national_id, CCCD, "leading zero preserved");
    // P3.1-HF: a second live episode for the same CCCD imports as a new row instead of
    // raising ACTIVE_EPISODE_EXISTS.
    const secondEpisode = await runImport(await optionsFor(
      await manifestFile([row({ source_row_id: "9" })]), BATCH_B), dependenciesFor(db).deps);
    assert.equal(secondEpisode.ok, true, JSON.stringify(secondEpisode));
    assert.equal(await entryCount(db), 2, "the second live episode is a new row");
    const second = (await db.query("select e.entry_id::text as id, e.employee_code," +
      " (select st.status from public.direct_entry_employment_status_events st" +
      "   where st.entry_id = e.entry_id order by st.version desc limit 1) as status" +
      " from public.direct_entries e where e.entry_id <> $1::uuid", [created.id])).rows[0];
    assert.ok(second, "the second episode row exists");
    assert.equal(second.status, "ON");
    assert.notEqual(second.employee_code, created.employee_code);

    // Canonical status path closes the episode (uploader actor, DRAFT submission, reason, OCC).
    await db.query("select public.direct_entry_apply_employment_status(" +
      "$1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::date,$7::text,$8::text,$9::text)",
      [STATUS_AUTH, STATUS_APP, created.id, Number(created.version), "OFF", "2026-10-05", "T0 leave",
        "T0 canonical leave", deterministicUuid("t0-test-off", created.id)]);
    const rehire = await runImport(await optionsFor(await manifestFile([row({ source_row_id: "9" })]),
      BATCH_B), dependenciesFor(db).deps);
    assert.equal(rehire.ok, true, JSON.stringify(rehire));
    const rows = (await db.query("select e.entry_id::text as id, e.employee_code," +
      " (select st.status from public.direct_entry_employment_status_events st" +
      "   where st.entry_id = e.entry_id order by st.version desc limit 1) as status" +
      " from public.direct_entries e")).rows;
    const old = rows.find((item) => item.id === created.id);
    assert.equal(old.status, "OFF");
    // P3.1-HF: a duplicate CCCD leaves more than one live episode, so every live row must be
    // ON with its own employee code instead of assuming exactly one fresh episode.
    const live = rows.filter((item) => item.id !== created.id);
    assert.ok(live.length >= 1, "at least one live episode remains");
    for (const item of live) {
      assert.notEqual(item.employee_code, old.employee_code);
      assert.equal(item.status, "ON");
    }

    // Postcheck failure rolls the batch back.
    const override = async (sql, params, inner) => {
      const result = await inner.query(sql, params);
      if (sql.includes("as latest_status")) {
        return { rows: result.rows.map((item) => ({ ...item, latest_status: "OFF" })) };
      }
      return result;
    };
    const entriesBeforePostcheck = await entryCount(db);
    const failing = await runImport(await optionsFor(await manifestFile([
      row({ source_row_id: "20", national_id: "333333333333" })]), BATCH_C),
      dependenciesFor(db, override).deps);
    assert.equal(failing.code, "POSTCHECK_FAILED");
    assert.deepEqual(failing.acceptance.problems, [
      { code: "POSTCHECK_STATUS_NOT_ON", source_row_id: "20", severity: "error" },
    ]);
    assert.equal(await entryCount(db), entriesBeforePostcheck,
      "postcheck failure leaves zero residue");
    assert.equal(entriesBeforePostcheck > 0, true);
    assertNoLeak(failing, ["333333333333"]);
  } finally {
    await db.close();
  }
});
