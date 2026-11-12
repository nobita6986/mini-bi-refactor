/**
 * PRE-W2-HF-D3-A - Account/Personnel DB foundation (DB regression, PGlite over the migration ledger).
 *
 * Covers the durable account-operation intent, the narrow RPCs (begin/claim/read/finish,
 * finalize, update display name, create personnel from account, list eligible accounts,
 * reclassify), the locked state machine, the symmetric 1:1 cardinality, the revision
 * action extension and the no-password / deny-by-default / OCC / idempotency / audit guarantees.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { PGlite } from "@electric-sql/pglite";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const D3A_MIGRATION = "20261014180000_pre_w2_hf_d3_a_account_personnel_db.sql";
const DEFAULT_CAPABILITIES_MIGRATION = "20261015150000_pre_w2_worker_data_capabilities_default.sql";
const PERSONNEL_DEFAULT_ACCESS_MIGRATION = "20261016160000_pre_w2_personnel_from_account_default_access.sql";

const AUTH_PROLOGUE =
  "create role anon; create role authenticated; create role service_role;" +
  " create schema auth; create table auth.users (id uuid primary key, email text unique);";

function uuid(n) {
  return "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
}
function loginForAuth(auth) { return "u" + auth.slice(-6); }

const ADMIN_AUTH = uuid(31), ADMIN_APP = uuid(41);
const LONE_AUTH = uuid(32), LONE_APP = uuid(42);   // entry_admin only
const ACC_AUTH = uuid(33), ACC_APP = uuid(43);      // catalog_master_manage only
const DISABLED_AUTH = uuid(34), DISABLED_APP = uuid(44);
const UNMAPPED_AUTH = uuid(35), UNMAPPED_APP = uuid(45);
const TARGET_AUTH = uuid(51), TARGET_APP = uuid(61);

async function buildDb() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`migration ${name} failed to install: ${error.message}`, { cause: error });
    }
  }
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(D3A_MIGRATION), 91, "the D3-A migration stays #92 immediately before PRE-W2-HF-G #93");
  assert.equal(names.indexOf(DEFAULT_CAPABILITIES_MIGRATION), 99, "migration chronology remains append-only");
  return db;
}

async function buildDbBeforeDefaultCapabilities() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(names.indexOf(DEFAULT_CAPABILITIES_MIGRATION), 99, "migration chronology remains append-only");
  const beforePortraitStageBatchLimit = names.indexOf(
    "20261018170000_w2_s1_multi_document_stage_batch_limit.sql",
  );
  assert.notEqual(beforePortraitStageBatchLimit, -1,
    "the test baseline ends before the portrait-stage batch-limit migration");
  for (const name of names.slice(0, beforePortraitStageBatchLimit)) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }

  const auth = uuid(901), app = uuid(902);
  await db.query("insert into auth.users (id) values ($1)", [auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,true,'Existing Account')", [app, auth]);
  const today = (await db.query(
    "select public.direct_entry_authorization_date()::text as today")).rows[0].today;
  const future = new Date(Date.parse(today + "T00:00:00Z") + 10 * 86400000)
    .toISOString().slice(0, 10);
  await db.query(
    "insert into public.direct_entry_capability_grants (app_user_id,capability,valid_from)" +
    " values ($1,'pii_view','2020-01-01')", [app]);
  await db.query(
    "insert into public.direct_entry_capability_grants (app_user_id,capability,valid_from,valid_to)" +
    " values ($1,'payment_view','2020-01-01',$2::date)", [app, today]);
  await db.query(
    "insert into public.direct_entry_capability_grants (app_user_id,capability,valid_from)" +
    " values ($1,'pii_export',$2::date)", [app, future]);
  await db.query(
    "insert into public.direct_entry_scope_grants (app_user_id,scope_kind,valid_from)" +
    " values ($1,'own','2020-01-01')", [app]);

  await db.exec(await readFile(path.join(MIGRATION_DIR, DEFAULT_CAPABILITIES_MIGRATION), "utf8"));
  return { db, app, today, future };
}

async function buildDbBeforePersonnelDefaultAccess() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  const migrationIndex = names.indexOf(PERSONNEL_DEFAULT_ACCESS_MIGRATION);
  assert.notEqual(migrationIndex, -1, "the personnel default-access migration is present in the ledger");
  for (const name of names.slice(0, migrationIndex)) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return { db, migration: await readFile(path.join(MIGRATION_DIR, PERSONNEL_DEFAULT_ACCESS_MIGRATION), "utf8") };
}

async function insertActor(db, auth, app, { capabilities = [], scopes = [], enabled = true } = {}) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [auth, loginForAuth(auth) + "@hrpartner.vn"]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
    " values ($1,$2,$3,'D3A Account')", [app, auth, enabled]);
  for (const capability of capabilities) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)" +
      " values ($1,$2,'2020-01-01',true)", [app, capability]);
  }
  for (const scopeKind of scopes) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)" +
      " values ($1,$2,$3,'2020-01-01',true)", [app, scopeKind, null]);
  }
}

const FULL_ADMIN = ["entry_admin", "recruiter_master_manage", "team_master_manage"];

async function seed(db) {
  await insertActor(db, ADMIN_AUTH, ADMIN_APP, { capabilities: FULL_ADMIN, scopes: ["all"] });
  await insertActor(db, LONE_AUTH, LONE_APP, { capabilities: ["entry_admin"], scopes: ["all"] });
  await insertActor(db, ACC_AUTH, ACC_APP, { capabilities: ["catalog_master_manage"], scopes: ["all"] });
  await insertActor(db, DISABLED_AUTH, DISABLED_APP, { capabilities: FULL_ADMIN, scopes: ["all"], enabled: false });
  await insertActor(db, TARGET_AUTH, TARGET_APP, { capabilities: ["entry_create"], scopes: ["own"] });
}

let keySeq = 0;
function idemKey() {
  keySeq += 1;
  return "d3a-key-" + String(900000 + keySeq);
}

async function rpc(db, name, args) {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(",");
  const res = await db.query(`select ${name}(${placeholders}) as data`, args);
  return res.rows[0].data;
}

const begin = (db, args) => rpc(db, "public.direct_entry_account_operation_begin", args);
const claim = (db, args) => rpc(db, "public.direct_entry_account_operation_claim", args);
const read = (db, args) => rpc(db, "public.direct_entry_account_operation_read", args);
const finish = (db, args) => rpc(db, "public.direct_entry_account_operation_finish", args);
const finalize = (db, args) => rpc(db, "public.direct_entry_account_operation_finalize_create", args);
const updateName = (db, args) => rpc(db, "public.direct_entry_account_operation_update_display_name", args);
const createPersonnel = (db, args) => rpc(db, "public.direct_entry_account_operation_create_personnel", args);
const listEligible = (db, args) => rpc(db, "public.direct_entry_account_operation_list_eligible_accounts", args);
const recruiterLinkStatus = (db, args) => rpc(db, "public.direct_entry_account_operation_recruiter_link_status", args);
const recruiterLinkCandidates = (db, args) => rpc(db, "public.direct_entry_account_operation_recruiter_link_candidates", args);
const linkRecruiter = (db, args) => rpc(db, "public.direct_entry_account_operation_link_recruiter", args);
const reclassify = (db, args) => rpc(db, "public.direct_entry_account_operation_reclassify", args);

async function count(db, sql, params = []) {
  const res = await db.query(sql, params);
  return Number(Object.values(res.rows[0])[0]);
}

async function expectDenied(db, fn) {
  await assert.rejects(fn, (error) => error.code === "42501");
}

test("worker-data defaults cover existing accounts without changing their scopes or grant history", async () => {
  const { db, app, today, future } = await buildDbBeforeDefaultCapabilities();
  try {
    for (const capability of ["pii_view", "payment_view", "pii_export"]) {
      assert.equal(await count(db,
        "select count(*) from public.direct_entry_capability_grants" +
        " where app_user_id=$1 and capability=$2 and valid_from <= $3::date" +
        " and (valid_to is null or $3::date < valid_to)", [app, capability, today]), 1,
        `${capability} is effective on the baseline date`);
    }
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_capability_grants" +
      " where app_user_id=$1 and capability='pii_export' and valid_from=$2::date and valid_to is null",
      [app, future]), 1, "a pre-existing future grant remains unchanged and contiguous");
    assert.deepEqual((await db.query(
      "select scope_kind from public.direct_entry_scope_grants where app_user_id=$1 order by scope_kind",
      [app])).rows.map((row) => row.scope_kind), ["own"], "capability baseline does not add row scope");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_audit_events" +
      " where action='capability_default_grant' and outcome='APPLIED'"), 2,
    "only the two missing grant intervals are recorded by the migration");
  } finally {
    await db.close();
  }
});

test("PRE-W2-HF: backfill default HRP access only for effective linked accounts", async () => {
  const { db, migration } = await buildDbBeforePersonnelDefaultAccess();
  try {
    const auth = uuid(911), app = uuid(912), recruiter = uuid(913);
    const today = (await db.query("select public.direct_entry_authorization_date()::text as today")).rows[0].today;
    await db.query("insert into auth.users (id,email) values ($1,$2)",
      [auth, `${loginForAuth(auth)}@hrpartner.vn`]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id,auth_subject,enabled,display_name)" +
      " values ($1,$2,true,'Existing HRP Account')", [app, auth]);
    await db.query(
      "insert into public.recruiters (recruiter_id,display_name,personnel_code,personnel_position,active)" +
      " values ($1,'Existing HRP Worker',$2,'STAFF',true)", [recruiter, loginForAuth(auth)]);
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id,provider_type,valid_from)" +
      " values ($1,'hrp',$2::date)", [recruiter, today]);
    await db.query(
      "insert into public.direct_entry_app_user_recruiter_links (app_user_id,recruiter_id,verified,valid_from)"+
      " values ($1,$2,true,$3::date)", [app, recruiter, today]);

    await db.exec(migration);

    assert.equal(await count(db,
      "select count(*) from public.direct_entry_capability_grants where app_user_id=$1 and valid_from <= $2::date"+
      " and (valid_to is null or $2::date < valid_to)", [app, today]), 10);
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_scope_grants where app_user_id=$1 and scope_kind='own'"+
      " and valid_from <= $2::date and (valid_to is null or $2::date < valid_to)", [app, today]), 1);
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_scope_grants where app_user_id=$1 and scope_kind in ('team','all')", [app]), 0);
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_capability_grants where app_user_id=$1"+
      " and capability in ('team_manager_assign','entry_admin','change_review')", [app]), 0);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 1. Intent lifecycle + idempotent begin.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: begin/claim/read/finish and idempotent begin", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const b = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", idemKey()]);
    assert.equal(b.kind, "CREATE_ACCOUNT");
    assert.equal(b.state, "PENDING");
    assert.ok(b.intent_id);
    assert.ok(b.intent_token);

    const key = idemKey();
    const b2 = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "xyz789", "Charlie",
      null, "create", key]);
    const replay = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "xyz789", "Charlie",
      null, "create", key]);
    assert.deepEqual(replay, b2);

    const c = await claim(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token]);
    assert.equal(c.claimed, true);
    assert.equal(c.state, "IN_FLIGHT");

    const c2 = await claim(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token]);
    assert.equal(c2.claimed, false);
    assert.equal(c2.state, "IN_FLIGHT");

    const r = await read(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id]);
    assert.equal(r.state, "IN_FLIGHT");
    assert.equal(r.login_id, "abc123");
    assert.equal(r.display_name, "Alpha Beta");

    const f = await finish(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, "FAILED", "auth_failed"]);
    assert.equal(f.state, "FAILED");
    assert.ok(f.resolved_at);

    // Idempotent begin replay with different input is rejected.
    await assert.rejects(
      () => begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "xyz789", "Different",
        null, "create", key]),
      (error) => error.code === "22023");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 2. RESET begin stores the target auth_subject for the Auth call.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: reset begin stores the target auth_subject", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const b = await begin(db, [ADMIN_AUTH, ADMIN_APP, "RESET_PASSWORD", null, null,
      TARGET_APP, "reset password", idemKey()]);
    assert.equal(b.kind, "RESET_PASSWORD");
    const r = await read(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id]);
    assert.equal(r.auth_subject, TARGET_AUTH);
    assert.equal(r.account_ref, TARGET_APP);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 3. Two concurrent creates for one login_id: only one live intent.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: two concurrent creates for one login_id leave only one live intent", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create", idemKey()]);
    await assert.rejects(
      () => begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Another Name",
        null, "create", idemKey()]),
      (error) => error.code === "23505");
    assert.equal(await count(db, "select count(*) from public.direct_entry_account_operation_intents"), 1);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 4. finalize create (correct provenance) + default worker-data capabilities.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: finalize creates the app user with default data capabilities", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const b = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", idemKey()]);
    await claim(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token]);

    const createdAuth = uuid(70);
    await db.query("insert into auth.users (id, email) values ($1, $2)",
      [createdAuth, `${loginForAuth(createdAuth)}@hrpartner.vn`]);

    const finalizeKey = idemKey();
    const f = await finalize(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token,
      createdAuth, finalizeKey]);
    assert.equal(f.intent_state, "APPLIED");
    assert.equal(f.auth_subject, createdAuth);
    assert.equal(f.display_name, "Alpha Beta");

    const appUser = (await db.query(
      "select enabled, display_name from public.direct_entry_app_users where app_user_id = $1",
      [f.app_user_id])).rows[0];
    assert.equal(appUser.enabled, true);
    assert.equal(appUser.display_name, "Alpha Beta");

    const appliedIntent = await read(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id]);
    assert.equal(appliedIntent.account_ref, f.app_user_id,
      "an APPLIED create intent keeps the created app-user reference for reconciliation");

    const capabilities = (await db.query(
      "select capability from public.direct_entry_capability_grants where app_user_id=$1 order by capability",
      [f.app_user_id])).rows.map((row) => row.capability);
    assert.deepEqual(capabilities, [], "field capabilities are no longer provisioned");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_audit_events where app_user_id=$1" +
      " and action='capability_default_grant' and outcome='APPLIED'", [ADMIN_APP]), 0,
    "retired field capabilities produce no default grant audit");
    assert.equal(await count(db, "select count(*) from public.direct_entry_scope_grants where app_user_id = $1", [f.app_user_id]), 0);
    assert.equal(await count(db, "select count(*) from public.direct_entry_app_user_recruiter_links where app_user_id = $1", [f.app_user_id]), 0);

    await createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, f.app_user_id, f.version,
      loginForAuth(createdAuth), "STAFF", null, "create personnel", idemKey()]);
    for (const capability of [
      "entry_create", "entry_own", "submission_create", "change_request_create",
      "employment_status.request", "document_upload", "document_view",
    ]) {
      assert.equal(await count(db,
        "select count(*) from public.direct_entry_capability_grants" +
        " where app_user_id=$1 and capability=$2 and is_current", [f.app_user_id, capability]), 1,
        `${capability} is effective after account creation followed by personnel creation`);
    }
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_capability_grants" +
      " where app_user_id=$1 and capability in ('pii_view','pii_export','payment_view','payment_edit')",
      [f.app_user_id]), 0, "retired field capabilities are not provisioned");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_scope_grants" +
      " where app_user_id=$1 and scope_kind='own' and valid_from <= public.direct_entry_authorization_date()" +
      " and (valid_to is null or public.direct_entry_authorization_date() < valid_to)", [f.app_user_id]), 1);

    const revision = (await db.query(
      "select action from public.direct_entry_app_user_revisions where app_user_id = $1", [f.app_user_id])).rows[0];
    assert.equal(revision.action, "account_created");

    // A late reconcile with another key is terminal/idempotent and closes that key.
    const lateKey = idemKey();
    const terminal = await finalize(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token,
      createdAuth, lateKey]);
    assert.equal(terminal.intent_state, "APPLIED");
    assert.equal(terminal.account_ref, f.app_user_id);
    const lateResult = (await db.query(
      "select result from public.direct_entry_rpc_idempotency where app_user_id=$1 and action='account_created' and idempotency_key=$2",
      [ADMIN_APP, lateKey])).rows[0]?.result;
    assert.deepEqual(lateResult, terminal, "terminal finalize must finish its idempotency record");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 5. finalize blocks a mismatched provenance token; terminal is immutable.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: finalize blocks a mismatched token and terminal is immutable", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const b = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", idemKey()]);
    await claim(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token]);

    const createdAuth = uuid(71);
    await db.query("insert into auth.users (id) values ($1)", [createdAuth]);
    const wrongToken = uuid(72);

    const blocked = await finalize(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, wrongToken, createdAuth, idemKey()]);
    assert.equal(blocked.intent_state, "BLOCKED");
    const state = (await db.query(
      "select state from public.direct_entry_account_operation_intents where intent_id = $1",
      [b.intent_id])).rows[0].state;
    assert.equal(state, "BLOCKED");
    assert.equal(await count(db, "select count(*) from public.direct_entry_app_users"), 5);

    // BLOCKED is terminal: a later correct token cannot revive it.
    const still = await finalize(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token,
      createdAuth, idemKey()]);
    assert.equal(still.intent_state, "BLOCKED");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. finalize reconciles an INDETERMINATE create (after timeout).
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: finalize reconciles an INDETERMINATE create", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const b = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", idemKey()]);
    await claim(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token]);
    await db.query("update public.direct_entry_account_operation_intents set state = 'INDETERMINATE', resolved_at = now() where intent_id = $1", [b.intent_id]);

    const createdAuth = uuid(73);
    await db.query("insert into auth.users (id) values ($1)", [createdAuth]);

    const f = await finalize(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token,
      createdAuth, idemKey()]);
    assert.equal(f.intent_state, "APPLIED");
    assert.equal(f.auth_subject, createdAuth);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 7. finish transition matrix: CREATE cannot be APPLIED via finish; terminal immutable.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: finish enforces the transition matrix", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const b = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", idemKey()]);
    await claim(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, b.intent_token]);

    // CREATE APPLIED is finalize-only.
    await assert.rejects(
      () => finish(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, "APPLIED", null]),
      (error) => error.code === "22023");

    const f = await finish(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, "FAILED", "auth_failed"]);
    assert.equal(f.state, "FAILED");

    // FAILED is terminal.
    await assert.rejects(
      () => finish(db, [ADMIN_AUTH, ADMIN_APP, b.intent_id, "INDETERMINATE", null]),
      (error) => error.code === "22023");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 8. update display name: unlinked + linked + OCC + idempotent.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: update display name updates the app user and its linked recruiter", async () => {
  const db = await buildDb();
  try {
    await seed(db);

    const u1 = await updateName(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "New Name", 1,
      "rename", idemKey()]);
    assert.equal(u1.version, 2);
    assert.equal(u1.recruiter_id, null);

    const p = await createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 2, loginForAuth(TARGET_AUTH), "STAFF",
      null, "create personnel", idemKey()]);
    assert.equal(p.display_name, "New Name");

    const u2 = await updateName(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "Renamed Again", 3,
      "rename again", idemKey()]);
    assert.equal(u2.version, 4);
    assert.equal(u2.recruiter_id, p.recruiter_id);
    assert.equal(u2.recruiter_version, 2);

    const recruiter = (await db.query(
      "select display_name from public.recruiters where recruiter_id = $1", [p.recruiter_id])).rows[0];
    assert.equal(recruiter.display_name, "Renamed Again");
  } finally {
    await db.close();
  }
});

test("PRE-W2-HF-D3-A: update display name honours OCC and idempotency", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const key = idemKey();
    const first = await updateName(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "New Name", 1, "rename", key]);
    const replay = await updateName(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "New Name", 1, "rename", key]);
    assert.deepEqual(replay, first);

    await assert.rejects(
      () => updateName(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, "Stale", 1, "rename", idemKey()]),
      (error) => error.code === "PT409");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 9. create personnel: atomic, account lifecycle (version + link_create revision),
//    conflict rollback.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: create personnel is atomic and records the account lifecycle", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const p = await createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, loginForAuth(TARGET_AUTH), "STAFF",
      null, "create personnel", idemKey()]);
    assert.equal(p.display_name, "D3A Account");
    assert.equal(p.personnel_code, loginForAuth(TARGET_AUTH));
    assert.equal(p.app_user_version, 2);
    assert.ok(p.recruiter_id);
    assert.ok(p.link_id);
    assert.ok(p.membership_id);
    assert.ok(p.app_user_revision_id);

    assert.equal(await count(db, "select count(*) from public.recruiters"), 1);
    assert.equal(await count(db, "select count(*) from public.recruiter_provider_memberships"), 1);
    assert.equal(await count(db, "select count(*) from public.direct_entry_app_user_recruiter_links"), 1);

    const linkRev = (await db.query(
      "select action from public.direct_entry_app_user_revisions where app_user_id = $1 and action = 'link_create'",
      [TARGET_APP])).rows;
    assert.equal(linkRev.length, 1);
    const linkAudit = (await db.query(
      "select count(*)::int as n from public.direct_entry_audit_events where action = 'link_create' and app_user_id = $1",
      [ADMIN_APP])).rows[0].n;
    assert.equal(linkAudit, 1);
    for (const capability of [
      "entry_create", "entry_own", "submission_create", "change_request_create",
      "employment_status.request", "document_upload", "document_view",
    ]) {
      assert.equal(await count(db,
        "select count(*) from public.direct_entry_capability_grants" +
        " where app_user_id=$1 and capability=$2 and is_current", [TARGET_APP, capability]), 1,
        `${capability} is granted to account-created HRP personnel`);
    }
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_capability_grants" +
      " where app_user_id=$1 and capability in ('pii_view','pii_export','payment_view','payment_edit')",
      [TARGET_APP]), 0, "retired field capabilities are not provisioned");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_scope_grants" +
      " where app_user_id=$1 and scope_kind='own' and valid_from <= public.direct_entry_authorization_date()" +
      " and (valid_to is null or public.direct_entry_authorization_date() < valid_to)", [TARGET_APP]), 1,
    "account-created HRP personnel has own scope");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_audit_events" +
      " where app_user_id=$1 and action='capability_default_grant' and outcome='APPLIED'", [ADMIN_APP]), 6,
    "each missing baseline capability is audited under the creating admin");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_audit_events" +
      " where app_user_id=$1 and action='scope_default_grant' and outcome='APPLIED'", [ADMIN_APP]), 0,
    "the existing own scope is preserved without duplicate audit");

    // Legacy personnel-code collision still fails atomically.
    const secondAuth = uuid(82), secondApp = uuid(83);
    await insertActor(db, secondAuth, secondApp, { capabilities: ["entry_create"], scopes: ["own"] });
    await db.query("insert into public.recruiters (display_name, personnel_code, personnel_position, active) values ('Existing', $1, 'STAFF', true)", [loginForAuth(secondAuth)]);
    const before = await count(db, "select count(*) from public.recruiters");
    await assert.rejects(
      () => createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, secondApp, 1, loginForAuth(secondAuth), "STAFF",
        null, "create personnel again", idemKey()]),
      (error) => error.code === "23505");
    assert.equal(await count(db, "select count(*) from public.recruiters"), before);
  } finally {
    await db.close();
  }
});

test("PRE-W2-HF: account-created team leaders get only the HRP own-entry baseline", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const auth = uuid(85), app = uuid(86);
    await insertActor(db, auth, app);
    await createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, app, 1, loginForAuth(auth), "TEAM_LEADER",
      null, "create team leader", idemKey()]);

    for (const capability of [
      "entry_create", "entry_own", "submission_create", "change_request_create",
      "employment_status.request", "document_upload", "document_view",
    ]) {
      assert.equal(await count(db,
        "select count(*) from public.direct_entry_capability_grants" +
        " where app_user_id=$1 and capability=$2 and is_current", [app, capability]), 1);
    }
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_capability_grants" +
      " where app_user_id=$1 and capability in ('pii_view','pii_export','payment_view','payment_edit')",
      [app]), 0, "retired field capabilities are not provisioned");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_scope_grants" +
      " where app_user_id=$1 and scope_kind='own' and valid_from <= public.direct_entry_authorization_date()" +
      " and (valid_to is null or public.direct_entry_authorization_date() < valid_to)", [app]), 1);
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_capability_grants" +
      " where app_user_id=$1 and capability in ('team_manager_assign','entry_admin','change_review')", [app]), 0,
    "catalog title TEAM_LEADER does not grant team/admin/reviewer authority");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_scope_grants where app_user_id=$1 and scope_kind in ('team','all')", [app]), 0,
    "team-leader team authority must be assigned through its dedicated workflow");
  } finally {
    await db.close();
  }
});

test("PRE-W2-HF-D3-A: create personnel rejects disabled, already-linked, unknown accounts and empty code", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await assert.rejects(
      () => createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, uuid(99), 1, "PC-002", "STAFF", null, "r", idemKey()]),
      (error) => error.code === "P0002");

    await assert.rejects(
      () => createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, "wrong-login", "STAFF", null, "r", idemKey()]),
      (error) => error.code === "22023");

    // Empty personnel code -> input-invalid 22023, not 23514/23505.
    await assert.rejects(
      () => createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, "   ", "STAFF", null, "r", idemKey()]),
      (error) => error.code === "22023");

    await db.query("update public.direct_entry_app_users set display_name = $1 where app_user_id = $2",
      [loginForAuth(TARGET_AUTH), TARGET_APP]);
    await assert.rejects(
      () => createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, loginForAuth(TARGET_AUTH), "STAFF", null, "r", idemKey()]),
      (error) => error.code === "23514");
    await db.query("update public.direct_entry_app_users set display_name = 'D3A Account' where app_user_id = $1", [TARGET_APP]);

    await createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, loginForAuth(TARGET_AUTH), "STAFF", null, "r", idemKey()]);
    await assert.rejects(
      () => createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 2, loginForAuth(TARGET_AUTH), "STAFF", null, "r", idemKey()]),
      (error) => error.code === "23514");

    await db.query("update public.direct_entry_app_users set enabled = false, version = version + 1 where app_user_id = $1", [TARGET_APP]);
    await assert.rejects(
      () => createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 3, loginForAuth(TARGET_AUTH), "STAFF", null, "r", idemKey()]),
      (error) => error.code === "23514");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 10. Symmetric 1:1 cardinality.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: a recruiter cannot gain a second verified app-user link", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, loginForAuth(TARGET_AUTH), "STAFF", null, "r", idemKey()]);
    const secondAuth = uuid(80), secondApp = uuid(81);
    await insertActor(db, secondAuth, secondApp, { capabilities: ["entry_create"], scopes: ["own"] });
    const recruiter = (await db.query("select recruiter_id from public.recruiters")).rows[0].recruiter_id;

    await assert.rejects(
      () => db.query(
        "insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from) values ($1,$2,true,'2026-01-05')",
        [secondApp, recruiter]),
      (error) => error.code === "23P01");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 11. list eligible accounts: enabled + unlinked only, no auth_subject/email/link ids.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: list eligible accounts returns only enabled unlinked accounts", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    // TARGET is eligible; create a second eligible + link TARGET via personnel.
    const secondAuth = uuid(84), secondApp = uuid(85);
    await insertActor(db, secondAuth, secondApp, { capabilities: ["entry_create"], scopes: ["own"] });

    const all = await listEligible(db, [ADMIN_AUTH, ADMIN_APP, 1, 25]);
    assert.ok(all.total >= 2);
    const target = all.accounts.find((account) => account.app_user_id === TARGET_APP);
    assert.equal(target.display_name, "D3A Account");
    assert.equal(target.login_id, loginForAuth(TARGET_AUTH));

    const serialized = JSON.stringify(all);
    assert.ok(!serialized.includes(TARGET_AUTH), "auth_subject must not leak");
    assert.ok(!serialized.includes(secondAuth), "auth_subject must not leak");

    // Link TARGET, it drops out of the eligible set.
    await createPersonnel(db, [ADMIN_AUTH, ADMIN_APP, TARGET_APP, 1, loginForAuth(TARGET_AUTH), "STAFF", null, "r", idemKey()]);
    const after = await listEligible(db, [ADMIN_AUTH, ADMIN_APP, 1, 25]);
    const ids = after.accounts.map((a) => a.app_user_id);
    assert.equal(ids.includes(TARGET_APP), false, "linked account is no longer eligible");
    assert.equal(ids.includes(secondApp), true);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 12. Authority: only Full Admin triple + all scope; disabled / narrower / unmapped denied.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: only the Full Admin triple with all scope may mutate", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    await expectDenied(db, () => begin(db, [LONE_AUTH, LONE_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta", null, "create", idemKey()]));
    await expectDenied(db, () => begin(db, [ACC_AUTH, ACC_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta", null, "create", idemKey()]));
    await expectDenied(db, () => begin(db, [DISABLED_AUTH, DISABLED_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta", null, "create", idemKey()]));
    await expectDenied(db, () => begin(db, [UNMAPPED_AUTH, UNMAPPED_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta", null, "create", idemKey()]));
    await expectDenied(db, () => createPersonnel(db, [LONE_AUTH, LONE_APP, TARGET_APP, 1, loginForAuth(TARGET_AUTH), "STAFF", null, "r", idemKey()]));
    await expectDenied(db, () => updateName(db, [ACC_AUTH, ACC_APP, TARGET_APP, "X", 1, "r", idemKey()]));
    await expectDenied(db, () => listEligible(db, [ACC_AUTH, ACC_APP, 1, 25]));
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 13. No password/hash in schema, audit or projection.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: no password or hash is ever stored or projected", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const b = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create account", idemKey()]);
    assert.ok(!/password|secret|hash/i.test(JSON.stringify(b)));

    const cols = (await db.query(
      "select column_name from information_schema.columns where table_schema='public' and table_name='direct_entry_account_operation_intents'"))
      .rows.map((r) => r.column_name);
    assert.equal(cols.some((c) => /password|secret|hash/i.test(c)), false);

    const audit = (await db.query(
      "select action, resource_ref from public.direct_entry_audit_events where action = 'account_operation_begin' order by created_at desc limit 1"))
      .rows[0];
    assert.ok(!/password|secret|hash/i.test(audit.resource_ref));
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 14. Reclassify.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: reclassify moves stale intents to their terminal states", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const pending = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "abc123", "Alpha Beta",
      null, "create", idemKey()]);
    await db.query("update public.direct_entry_account_operation_intents set created_at = now() - interval '20 minutes' where intent_id = $1", [pending.intent_id]);

    const inFlight = await begin(db, [ADMIN_AUTH, ADMIN_APP, "CREATE_ACCOUNT", "xyz789", "Charlie",
      null, "create", idemKey()]);
    await claim(db, [ADMIN_AUTH, ADMIN_APP, inFlight.intent_id, inFlight.intent_token]);
    await db.query("update public.direct_entry_account_operation_intents set claimed_at = now() - interval '20 minutes' where intent_id = $1", [inFlight.intent_id]);

    const result = await reclassify(db, [ADMIN_AUTH, ADMIN_APP]);
    assert.ok(result.reclassified >= 2);

    const s1 = (await db.query("select state from public.direct_entry_account_operation_intents where intent_id = $1", [pending.intent_id])).rows[0].state;
    const s2 = (await db.query("select state from public.direct_entry_account_operation_intents where intent_id = $1", [inFlight.intent_id])).rows[0].state;
    assert.equal(s1, "EXPIRED");
    assert.equal(s2, "INDETERMINATE");
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 15. Migration self-check: ACL, search_path, signature posture.
// ---------------------------------------------------------------------------
test("PRE-W2-HF-D3-A: the migration locks the RPC boundary and revision action vocabulary", async () => {
  const db = await buildDb();
  try {
    const report = (await db.query(
      "select p.prosecdef, p.proconfig::text as config from pg_proc p" +
      " where p.oid = 'public.direct_entry_account_operation_claim(uuid,uuid,uuid,uuid)'::regprocedure")).rows[0];
    assert.equal(report.prosecdef, true);
    assert.ok(report.config.includes("search_path=pg_catalog, public"));

    const acl = (await db.query(
      "select has_function_privilege('service_role', p.oid, 'EXECUTE') as s," +
      " has_function_privilege('anon', p.oid, 'EXECUTE') as a," +
      " has_function_privilege('authenticated', p.oid, 'EXECUTE') as u" +
      " from pg_proc p where p.oid = 'public.direct_entry_account_operation_begin(uuid,uuid,text,text,text,uuid,text,text)'::regprocedure")).rows[0];
    assert.deepEqual(acl, { s: true, a: false, u: false });

    const actions = (await db.query(
      "select pg_get_constraintdef(oid) as d from pg_constraint" +
      " where conname = 'direct_entry_app_user_revisions_action_check'")).rows[0].d;
    assert.ok(actions.includes("account_created"));
    assert.ok(actions.includes("display_name_update"));
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 16. Link existing HRP personnel (e.g. mkt.vp - Marketing Vĩnh Phúc) to an
//     existing enabled account: preserves recruiter/team/history, grants only
//     minimal HRP own-entry baseline, enforces 1:1, OCC, idempotency & Full Admin.
// ---------------------------------------------------------------------------
test("Admin link existing personnel to existing account: links mkt.vp without creating new recruiter or mutating profile/team/history", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const today = (await db.query("select public.direct_entry_authorization_date()::text as today")).rows[0].today;
    const mktRecruiterId = uuid(701);
    const mktAuth = uuid(702);
    const mktApp = uuid(703);
    const teamId = uuid(704);

    // Existing active HRP personnel profile with team membership and historical data.
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active, version)" +
      " values ($1, 'Marketing Vĩnh Phúc', 'mkt.vp', 'TEAM_LEADER', true, 3)",
      [mktRecruiterId],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
      " values ($1, 'hrp', '2025-01-01', true)",
      [mktRecruiterId],
    );
    await db.query(
      "insert into public.teams (team_id, code, display_name) values ($1, 'MKT-VP', 'Team Marketing VP')",
      [teamId],
    );
    await db.query(
      "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)" +
      " values ($1, $2, '2025-02-01', true)",
      [mktRecruiterId, teamId],
    );

    // Before account exists: link-status shows unlinked, link-candidates returns empty candidates.
    const statusBefore = await recruiterLinkStatus(db, [ADMIN_AUTH, ADMIN_APP, [mktRecruiterId]]);
    assert.deepEqual(statusBefore, { linked_recruiter_ids: [] });

    const candsBeforeAccount = await recruiterLinkCandidates(db, [ADMIN_AUTH, ADMIN_APP, mktRecruiterId]);
    assert.deepEqual(candsBeforeAccount, {
      recruiter_id: mktRecruiterId,
      display_name: "Marketing Vĩnh Phúc",
      personnel_code: "mkt.vp",
      personnel_position: "TEAM_LEADER",
      active: true,
      version: 3,
      already_linked: false,
      candidates: [],
    });

    // Create existing account mkt.vp (no capabilities/scopes yet) + unrelated account that must NOT appear in candidates.
    await db.query("insert into auth.users (id, email) values ($1, 'mkt.vp@hrpartner.vn')", [mktAuth]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name, version)" +
      " values ($1, $2, true, 'Marketing Vĩnh Phúc TK', 2)",
      [mktApp, mktAuth],
    );

    const candsReady = await recruiterLinkCandidates(db, [ADMIN_AUTH, ADMIN_APP, mktRecruiterId]);
    assert.equal(candsReady.already_linked, false);
    assert.equal(candsReady.candidates.length, 1, "only the account matching personnel_code = mkt.vp is returned");
    assert.deepEqual(candsReady.candidates[0], {
      app_user_id: mktApp,
      display_name: "Marketing Vĩnh Phúc TK",
      login_id: "mkt.vp",
      version: 2,
    });
    assert.equal(JSON.stringify(candsReady).includes(mktAuth), false, "auth_subject must never leak");
    assert.equal(JSON.stringify(candsReady).includes("@hrpartner.vn"), false, "email must never leak");

    const recruitersCountBefore = await count(db, "select count(*) from public.recruiters");
    const providerMembershipsBefore = await count(db, "select count(*) from public.recruiter_provider_memberships where recruiter_id = $1", [mktRecruiterId]);
    const teamMembershipsBefore = await count(db, "select count(*) from public.recruiter_team_memberships where recruiter_id = $1", [mktRecruiterId]);

    const key = idemKey();
    const linked = await linkRecruiter(db, [
      ADMIN_AUTH, ADMIN_APP, mktRecruiterId, 3, mktApp, 2, "Liên kết tài khoản mkt.vp", key,
    ]);
    assert.equal(linked.app_user_id, mktApp);
    assert.equal(linked.app_user_version, 3);
    assert.equal(linked.recruiter_id, mktRecruiterId);
    assert.equal(linked.recruiter_version, 3, "recruiter version is preserved");
    assert.equal(linked.personnel_code, "mkt.vp");
    assert.equal(linked.valid_from, today);
    assert.ok(linked.link_id);
    assert.ok(linked.app_user_revision_id);

    // Idempotent replay with same key and inputs returns identical envelope.
    const replay = await linkRecruiter(db, [
      ADMIN_AUTH, ADMIN_APP, mktRecruiterId, 3, mktApp, 2, "Liên kết tài khoản mkt.vp", key,
    ]);
    assert.deepEqual(replay, linked);

    // Replay with same key but different input fails with 22023.
    await assert.rejects(
      () => linkRecruiter(db, [
        ADMIN_AUTH, ADMIN_APP, mktRecruiterId, 3, mktApp, 2, "Lý do khác", key,
      ]),
      (error) => error.code === "22023",
    );

    // Recruiter row, provider memberships, and team memberships are untouched; no duplicate recruiter created.
    assert.equal(await count(db, "select count(*) from public.recruiters"), recruitersCountBefore);
    assert.equal(await count(db, "select count(*) from public.recruiter_provider_memberships where recruiter_id = $1", [mktRecruiterId]), providerMembershipsBefore);
    assert.equal(await count(db, "select count(*) from public.recruiter_team_memberships where recruiter_id = $1", [mktRecruiterId]), teamMembershipsBefore);

    const recruiterRow = (await db.query(
      "select display_name, personnel_code, personnel_position, active, version from public.recruiters where recruiter_id = $1",
      [mktRecruiterId],
    )).rows[0];
    assert.deepEqual(recruiterRow, {
      display_name: "Marketing Vĩnh Phúc",
      personnel_code: "mkt.vp",
      personnel_position: "TEAM_LEADER",
      active: true,
      version: 3,
    });

    // Link row is verified and current.
    const linkRows = (await db.query(
      "select app_user_id, recruiter_id, verified, is_current, valid_from::text as valid_from, valid_to" +
      " from public.direct_entry_app_user_recruiter_links where link_id = $1",
      [linked.link_id],
    )).rows;
    assert.deepEqual(linkRows, [{
      app_user_id: mktApp,
      recruiter_id: mktRecruiterId,
      verified: true,
      is_current: true,
      valid_from: today,
      valid_to: null,
    }]);

    // Minimal HRP own-entry capabilities + own scope granted; NO team/all scope and NO team_manager_assign/entry_admin/change_review.
    for (const capability of [
      "entry_create", "entry_own", "submission_create", "change_request_create",
      "employment_status.request", "document_upload", "document_view",
    ]) {
      assert.equal(await count(db,
        "select count(*) from public.direct_entry_capability_grants where app_user_id = $1 and capability = $2 and is_current",
        [mktApp, capability]), 1, `${capability} granted`);
    }
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_capability_grants" +
      " where app_user_id = $1 and capability in ('team_manager_assign','entry_admin','change_review','recruiter_master_manage','team_master_manage','catalog_master_manage')",
      [mktApp]), 0, "no elevated capability granted even when personnel_position is TEAM_LEADER");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_scope_grants where app_user_id = $1 and scope_kind = 'own' and is_current",
      [mktApp]), 1, "own scope is granted");
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_scope_grants where app_user_id = $1 and scope_kind in ('team','all')",
      [mktApp]), 0, "no team or all scope granted");

    // Audit & revision recorded.
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_app_user_revisions where app_user_id = $1 and action = 'link_create'",
      [mktApp]), 1);
    assert.equal(await count(db,
      "select count(*) from public.direct_entry_app_user_revisions rev" +
      " join public.direct_entry_restricted_reasons r on r.reason_id = rev.reason_id" +
      " where rev.revision_id = $1",
      [linked.app_user_revision_id]), 1);

    // Link status and candidates reflect linked state.
    const statusAfter = await recruiterLinkStatus(db, [ADMIN_AUTH, ADMIN_APP, [mktRecruiterId]]);
    assert.deepEqual(statusAfter, { linked_recruiter_ids: [mktRecruiterId] });
    const candsAfter = await recruiterLinkCandidates(db, [ADMIN_AUTH, ADMIN_APP, mktRecruiterId]);
    assert.equal(candsAfter.already_linked, true);
    assert.deepEqual(candsAfter.candidates, []);
  } finally {
    await db.close();
  }
});

test("Admin link existing personnel to existing account: enforces Full Admin, code equality, active state, HRP-only, 1:1 and OCC", async () => {
  const db = await buildDb();
  try {
    await seed(db);
    const recId = uuid(710);
    const vendorRecId = uuid(711);
    const vendorId = uuid(712);
    const matchAuth = uuid(713), matchApp = uuid(714);
    const otherAuth = uuid(715), otherApp = uuid(716);

    await db.query(
      "insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)" +
      " values ($1, 'Nhân sự HRP', 'hrp.nv01', null, true)",
      [recId],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)" +
      " values ($1, 'hrp', '2025-01-01', true)",
      [recId],
    );

    await db.query("insert into public.vendors (vendor_id, display_name, active) values ($1, 'Vendor A', true)", [vendorId]);
    await db.query(
      "insert into public.recruiters (recruiter_id, display_name, personnel_code, active)" +
      " values ($1, 'Vendor Recruiter', 'vnd.01', true)",
      [vendorRecId],
    );
    await db.query(
      "insert into public.recruiter_provider_memberships (recruiter_id, provider_type, vendor_id, valid_from, is_current)" +
      " values ($1, 'vendor', $2, '2025-01-01', true)",
      [vendorRecId, vendorId],
    );

    await db.query("insert into auth.users (id, email) values ($1, 'hrp.nv01@hrpartner.vn')", [matchAuth]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)" +
      " values ($1, $2, true, 'HRP NV01')",
      [matchApp, matchAuth],
    );
    await db.query("insert into auth.users (id, email) values ($1, 'other.login@hrpartner.vn')", [otherAuth]);
    await db.query(
      "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)" +
      " values ($1, $2, true, 'Other Account')",
      [otherApp, otherAuth],
    );

    // 1. Non-Full-Admin actors denied on all 3 RPCs.
    for (const [authSub, appId] of [
      [LONE_AUTH, LONE_APP],
      [ACC_AUTH, ACC_APP],
      [DISABLED_AUTH, DISABLED_APP],
      [UNMAPPED_AUTH, UNMAPPED_APP],
    ]) {
      await expectDenied(db, () => recruiterLinkStatus(db, [authSub, appId, [recId]]));
      await expectDenied(db, () => recruiterLinkCandidates(db, [authSub, appId, recId]));
      await expectDenied(db, () => linkRecruiter(db, [authSub, appId, recId, 1, matchApp, 1, null, idemKey()]));
    }

    // 2. Vendor recruiter rejected with P0002.
    await assert.rejects(
      () => recruiterLinkCandidates(db, [ADMIN_AUTH, ADMIN_APP, vendorRecId]),
      (error) => error.code === "P0002",
    );
    await assert.rejects(
      () => linkRecruiter(db, [ADMIN_AUTH, ADMIN_APP, vendorRecId, 1, matchApp, 1, null, idemKey()]),
      (error) => error.code === "P0002",
    );

    // 3. Mismatched login_id vs personnel_code rejected with 22023.
    await assert.rejects(
      () => linkRecruiter(db, [ADMIN_AUTH, ADMIN_APP, recId, 1, otherApp, 1, null, idemKey()]),
      (error) => error.code === "22023",
    );

    // 4. Stale recruiter version or stale account version rejected with PT409.
    await assert.rejects(
      () => linkRecruiter(db, [ADMIN_AUTH, ADMIN_APP, recId, 99, matchApp, 1, null, idemKey()]),
      (error) => error.code === "PT409",
    );
    await assert.rejects(
      () => linkRecruiter(db, [ADMIN_AUTH, ADMIN_APP, recId, 1, matchApp, 99, null, idemKey()]),
      (error) => error.code === "PT409",
    );

    // 5. Disabled account rejected with 23514.
    await db.query("update public.direct_entry_app_users set enabled = false where app_user_id = $1", [matchApp]);
    await assert.rejects(
      () => linkRecruiter(db, [ADMIN_AUTH, ADMIN_APP, recId, 1, matchApp, 1, null, idemKey()]),
      (error) => error.code === "23514",
    );
    await db.query("update public.direct_entry_app_users set enabled = true where app_user_id = $1", [matchApp]);

    // 6. Inactive personnel rejected with 23514.
    await db.query("update public.recruiters set active = false where recruiter_id = $1", [recId]);
    await assert.rejects(
      () => linkRecruiter(db, [ADMIN_AUTH, ADMIN_APP, recId, 1, matchApp, 1, null, idemKey()]),
      (error) => error.code === "23514",
    );
    await db.query("update public.recruiters set active = true where recruiter_id = $1", [recId]);

    // 7. Link succeeds with null reason and null personnel_position (legacy HRP row).
    const linked = await linkRecruiter(db, [ADMIN_AUTH, ADMIN_APP, recId, 1, matchApp, 1, null, idemKey()]);
    assert.equal(linked.app_user_id, matchApp);
    assert.equal(linked.recruiter_id, recId);

    // 8. Linking an already-linked personnel or already-linked account fails with 23P01.
    await assert.rejects(
      () => linkRecruiter(db, [ADMIN_AUTH, ADMIN_APP, recId, 1, matchApp, 2, null, idemKey()]),
      (error) => error.code === "23P01",
    );
  } finally {
    await db.close();
  }
});
