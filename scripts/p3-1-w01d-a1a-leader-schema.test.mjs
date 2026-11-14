/**
 * P3.1-W01D-A1a2 - Team leader lifecycle schema foundation (#71) DB regression.
 *
 * Applies all 93 migrations from scratch in PGlite and asserts the 30 items of the
 * A1a2 contract: append-only ledger, the two widened grant interval CHECKs, the
 * marker-excluding partial unique indexes, the assignment/revision table shapes,
 * forced RLS and deny-by-default ACL, the three internal helpers, marker write
 * guards, the fixed eight-key snapshot, the bounded projection, the immutable
 * revision contract and the closing self-check.
 *
 * Cardinality wording (mandatory): the indexes asserted here are key/start-date
 * foundations only. Nothing in this file claims they resolve interval overlap;
 * A1b still owes the team-row lock plus the advisory/overlap guard and its
 * postconditions (one effective leader per team, one team per effective leader).
 *
 * No Production access, no network, no browser: PGlite applies the real local
 * migrations. Every rejection is reduced to its SQLSTATE, never a raw message.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const NEW_MIGRATION = "20261009070000_p3_1_w01d_team_leader_lifecycle.sql";
const PREVIOUS_MIGRATION = "20261009060000_p3_1_w01c_b_team_membership.sql";
const W02A_MIGRATION = "20261009080000_p3_1_w02a_team_leader_project_manager_authority.sql";

const TEAM_A = "94000000-0000-4000-8000-0000000000a1";
const TEAM_B = "94000000-0000-4000-8000-0000000000a2";
const LEADER_A = { auth: "10000000-0000-4000-8000-0000000000c1", app: "20000000-0000-4000-8000-0000000000c1" };
const LEADER_B = { auth: "10000000-0000-4000-8000-0000000000c2", app: "20000000-0000-4000-8000-0000000000c2" };
const RECRUITER_A = "93000000-0000-4000-8000-0000000000b1";
const RECRUITER_B = "93000000-0000-4000-8000-0000000000b2";

const PAST = "2020-01-01";
const REPLACE_DAY = "2020-02-01";

const SNAPSHOT_KEYS = ["change", "leader_app_user_id", "leader_recruiter_id",
  "previous_leader_recruiter_id", "team_id", "valid_from", "valid_to", "version"].sort();
const PROJECTION_KEYS = ["assignment_id", "team_id", "team_display_name", "leader_app_user_id",
  "leader_recruiter_id", "leader_display_name", "valid_from", "valid_to", "state"].sort();

const SNAPSHOT_SIG = "public.direct_entry_team_leader_snapshot(uuid,uuid,uuid,date,date,uuid,integer,text)";
const PROJECTION_SIG = "public.direct_entry_team_leader_projection(public.direct_entry_team_leader_assignments,text,text)";

const ASSIGNMENT_TABLE = "direct_entry_team_leader_assignments";
const REVISION_TABLE = "direct_entry_team_leader_revisions";

/** Every rejection captured during the suite, reduced to its SQLSTATE (no message). */
const CAPTURED = [];

async function readMigrationNames() {
  return (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
}

async function readMigration(name) {
  return readFile(path.join(MIGRATION_DIR, name), "utf8");
}

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  for (const name of await readMigrationNames()) {
    await db.exec(await readMigration(name));
  }
  return db;
}

/** Expect fn to reject with the exact SQLSTATE; record only the code. */
async function expectSqlstate(fn, code) {
  let error = null;
  try {
    await fn;
  } catch (caught) {
    error = caught;
  }
  if (error === null) assert.fail("expected SQLSTATE " + code + " but the operation succeeded");
  CAPTURED.push(error.code);
  assert.equal(error.code, code);
}

const db = await database();

await db.query("insert into auth.users (id) values ($1::uuid), ($2::uuid)",
  [LEADER_A.auth, LEADER_B.auth]);
await db.query(
  "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)"
  + " values ($1::uuid, $2::uuid, true, 'Synthetic Leader A'),"
  + " ($3::uuid, $4::uuid, true, 'Synthetic Leader B')",
  [LEADER_A.app, LEADER_A.auth, LEADER_B.app, LEADER_B.auth]);
await db.query(
  "insert into public.teams (team_id, code, display_name, active)"
  + " values ($1::uuid, 'LDR_A', 'Synthetic Leader Team A', true),"
  + " ($2::uuid, 'LDR_B', 'Synthetic Leader Team B', true)",
  [TEAM_A, TEAM_B]);
await db.query(
  "insert into public.recruiters (recruiter_id, display_name, active)"
  + " values ($1::uuid, 'Synthetic Recruiter A', true), ($2::uuid, 'Synthetic Recruiter B', true)",
  [RECRUITER_A, RECRUITER_B]);

// ---------------------------------------------------------------------------
// Assertions 1-2: ledger inventory and append-only discipline.
// ---------------------------------------------------------------------------
test("assertions 1-2: the migration chain includes #71 and #72 remains W02-A", async () => {
  const names = await readMigrationNames();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.ok(names.includes(NEW_MIGRATION), "the W01D migration remains in the inventory");
  assert.ok(names.includes(W02A_MIGRATION), "the W02-A migration remains in the inventory");
  assert.equal(names.filter((name) => name.startsWith("20261009070000")).length, 1,
    "exactly one migration occupies the #71 slot");
  assert.equal(names.filter((name) => name.startsWith("20261009060000")).length, 1,
    "#70 still occupies exactly one slot");

  const symbols = [
    ASSIGNMENT_TABLE,
    REVISION_TABLE,
    "direct_entry_team_leader_marker",
    "direct_entry_team_leader_snapshot",
    "direct_entry_team_leader_projection",
    "direct_entry_team_leader_assignment_marker_guard",
    "direct_entry_scope_grant_marker_guard",
    "direct_entry_capability_grant_marker_guard",
    "direct_entry_capability_grants_open_start_uidx",
    "direct_entry_team_leader_assignments_team_open_uidx",
    "direct_entry_team_leader_assignments_leader_open_uidx",
    "leader_revision_id",
  ];
  for (const name of names) {
    if (name >= NEW_MIGRATION) continue;
    const sql = await readMigration(name);
    for (const symbol of symbols) {
      assert.equal(sql.includes(symbol), false, symbol + " must not appear in " + name);
    }
  }
});

// ---------------------------------------------------------------------------
// Assertions 3-5: interval CHECKs and capability vocabulary through F2.
// ---------------------------------------------------------------------------
test("assertions 3-5: grant CHECKs widened, membership still >=, F2 vocabulary retained", async () => {
  const grants = (await db.query(
    "select c.conname, pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " where c.conname in ('direct_entry_scope_grants_check', 'direct_entry_capability_grants_check')"
    + " order by c.conname")).rows;
  assert.equal(grants.length, 2, "exactly the two grant interval CHECKs exist");
  for (const row of grants) {
    assert.equal(row.definition.includes(">="), true, row.conname + " must be widened to >=");
    assert.match(row.definition, /valid_to >= valid_from/, row.conname);
  }

  const membership = (await db.query(
    "select pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " where c.conname = 'recruiter_team_memberships_check'")).rows;
  assert.equal(membership.length, 1);
  assert.equal(membership[0].definition.includes(">="), true,
    "recruiter_team_memberships_check keeps the W01C-B >= rule");

  const vocabulary = (await db.query(
    "select pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " where c.conname = 'direct_entry_capability_grants_capability_check'")).rows;
  const tokens = [...String(vocabulary[0].definition).matchAll(/'([^']+)'::text/g)]
    .map((match) => match[1]);
  assert.equal(tokens.length, 33, "the capability vocabulary includes W01A, F1, F2, VFIN-01, duplicate CCCD, and worker history tokens");
});

// ---------------------------------------------------------------------------
// Assertions 6-7: exact table shapes (columns, FKs, unique, checks).
// ---------------------------------------------------------------------------
test("assertions 6-7: assignment and revision tables carry the exact shape", async () => {
  const assignments = (await db.query(
    "select column_name, data_type, is_nullable from information_schema.columns"
    + " where table_schema = 'public' and table_name = $1 order by ordinal_position",
    [ASSIGNMENT_TABLE])).rows;
  assert.deepEqual(assignments.map((c) => [c.column_name, c.data_type, c.is_nullable]), [
    ["assignment_id", "uuid", "NO"],
    ["team_id", "uuid", "NO"],
    ["leader_app_user_id", "uuid", "NO"],
    ["leader_recruiter_id", "uuid", "NO"],
    ["valid_from", "date", "NO"],
    ["valid_to", "date", "YES"],
    ["created_at", "timestamp with time zone", "NO"],
    ["is_current", "boolean", "NO"],
    // WP5B-1 adds D10 temporary suspension marker without altering historical revision columns.
    ["suspended_by_account_disable", "boolean", "NO"],
  ]);

  const assignmentFks = (await db.query(
    "select kcu.column_name, ccu.table_name as referenced_table, rc.delete_rule"
    + " from information_schema.table_constraints tc"
    + " join information_schema.key_column_usage kcu"
    + "   on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema"
    + " join information_schema.constraint_column_usage ccu"
    + "   on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema"
    + " join information_schema.referential_constraints rc"
    + "   on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema"
    + " where tc.table_schema = 'public' and tc.table_name = $1 and tc.constraint_type = 'FOREIGN KEY'"
    + " order by kcu.column_name",
    [ASSIGNMENT_TABLE])).rows;
  assert.deepEqual(assignmentFks, [
    { column_name: "leader_app_user_id", referenced_table: "direct_entry_app_users", delete_rule: "RESTRICT" },
    { column_name: "leader_recruiter_id", referenced_table: "recruiters", delete_rule: "RESTRICT" },
    { column_name: "team_id", referenced_table: "teams", delete_rule: "RESTRICT" },
  ]);
  const assignmentCheck = (await db.query(
    "select pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " where c.conrelid = 'public." + ASSIGNMENT_TABLE + "'::regclass and c.contype = 'c'")).rows;
  assert.equal(assignmentCheck.length, 1);
  assert.match(assignmentCheck[0].definition, /valid_to >= valid_from/);

  const revisions = (await db.query(
    "select column_name, data_type, is_nullable from information_schema.columns"
    + " where table_schema = 'public' and table_name = $1 order by ordinal_position",
    [REVISION_TABLE])).rows;
  assert.deepEqual(revisions.map((c) => [c.column_name, c.data_type, c.is_nullable]), [
    ["revision_id", "uuid", "NO"],
    ["team_id", "uuid", "NO"],
    ["version", "integer", "NO"],
    ["actor_user_id", "uuid", "YES"],
    ["action", "text", "NO"],
    ["before_snapshot", "jsonb", "YES"],
    ["after_snapshot", "jsonb", "YES"],
    ["created_at", "timestamp with time zone", "NO"],
  ]);

  const revisionFks = (await db.query(
    "select kcu.column_name, ccu.table_name as referenced_table, rc.delete_rule"
    + " from information_schema.table_constraints tc"
    + " join information_schema.key_column_usage kcu"
    + "   on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema"
    + " join information_schema.constraint_column_usage ccu"
    + "   on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema"
    + " join information_schema.referential_constraints rc"
    + "   on rc.constraint_name = tc.constraint_name and rc.constraint_schema = tc.table_schema"
    + " where tc.table_schema = 'public' and tc.table_name = $1 and tc.constraint_type = 'FOREIGN KEY'"
    + " order by kcu.column_name",
    [REVISION_TABLE])).rows;
  assert.deepEqual(revisionFks, [
    { column_name: "actor_user_id", referenced_table: "direct_entry_app_users", delete_rule: "RESTRICT" },
    { column_name: "team_id", referenced_table: "teams", delete_rule: "RESTRICT" },
  ]);
  const revisionUnique = (await db.query(
    "select tc.constraint_name from information_schema.table_constraints tc"
    + " where tc.table_schema = 'public' and tc.table_name = $1 and tc.constraint_type = 'UNIQUE'",
    [REVISION_TABLE])).rows;
  assert.deepEqual(revisionUnique.map((r) => r.constraint_name),
    ["direct_entry_team_leader_revisions_team_id_version_key"]);
  const revisionCheck = (await db.query(
    "select pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " where c.conrelid = 'public." + REVISION_TABLE + "'::regclass and c.contype = 'c'")).rows;
  assert.equal(revisionCheck.length, 1);
  assert.match(revisionCheck[0].definition, /version >= 1/);
});

// ---------------------------------------------------------------------------
// Assertions 8-9: forced RLS and deny-by-default table ACL.
// ---------------------------------------------------------------------------
test("assertions 8-9: both tables force RLS and deny every role", async () => {
  const rls = (await db.query(
    "select relname, relrowsecurity, relforcerowsecurity from pg_class"
    + " where relname = any($1::text[]) order by relname",
    [[ASSIGNMENT_TABLE, REVISION_TABLE]])).rows;
  assert.equal(rls.length, 2);
  for (const row of rls) {
    assert.equal(row.relrowsecurity, true, row.relname + " enables RLS");
    assert.equal(row.relforcerowsecurity, true, row.relname + " forces RLS");
  }
  for (const table of [ASSIGNMENT_TABLE, REVISION_TABLE]) {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      const privilege = (await db.query(
        "select has_table_privilege($1::text, $2::text, 'SELECT,INSERT,UPDATE,DELETE') as held",
        [role, "public." + table])).rows[0].held;
      assert.equal(privilege, false, role + " must hold no DML on " + table);
    }
  }
});

// ---------------------------------------------------------------------------
// Assertion 10: four marker-excluding partial unique indexes.
// ---------------------------------------------------------------------------
test("assertion 10: the four partial indexes exclude zero-length markers", async () => {
  const indexNames = [
    "direct_entry_capability_grants_open_start_uidx",
    "direct_entry_scope_grants_start_uidx",
    "direct_entry_team_leader_assignments_team_open_uidx",
    "direct_entry_team_leader_assignments_leader_open_uidx",
  ];
  const rows = (await db.query(
    "select indexname, indexdef from pg_indexes where schemaname = 'public'"
    + " and indexname = any($1::text[]) order by indexname",
    [indexNames])).rows;
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.match(row.indexdef, /WHERE/i, row.indexname + " must be partial");
    assert.match(row.indexdef, /valid_to is null/i, row.indexname + " includes open intervals");
    assert.match(row.indexdef, /valid_to > valid_from/i, row.indexname + " excludes markers");
  }
});

// ---------------------------------------------------------------------------
// Assertion 11: three marker triggers on the right table/event.
// ---------------------------------------------------------------------------
test("assertion 11: the three marker triggers guard the right tables and events", async () => {
  const triggers = [
    ["direct_entry_team_leader_assignment_marker_guard", ASSIGNMENT_TABLE],
    ["direct_entry_scope_grant_marker_guard", "direct_entry_scope_grants"],
    ["direct_entry_capability_grant_marker_guard", "direct_entry_capability_grants"],
  ];
  for (const [triggerName, tableName] of triggers) {
    const rows = (await db.query(
      "select pg_get_triggerdef(tg.oid) as definition from pg_trigger tg"
      + " join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace"
      + " where n.nspname = 'public' and c.relname = $1 and tg.tgname = $2 and not tg.tgisinternal",
      [tableName, triggerName])).rows;
    assert.equal(rows.length, 1, triggerName + " must exist on " + tableName);
    assert.match(rows[0].definition, /BEFORE INSERT OR UPDATE OF valid_from, valid_to/i, triggerName);
    assert.match(rows[0].definition, /direct_entry_team_leader_marker/i, triggerName);
  }
});

// ---------------------------------------------------------------------------
// Assertion 12: internal helpers are SECURITY DEFINER, pinned, revoked.
// ---------------------------------------------------------------------------
test("assertion 12: the three helpers are SECURITY DEFINER, pinned and revoked", async () => {
  const helpers = [
    "public.direct_entry_team_leader_marker()",
    SNAPSHOT_SIG,
    PROJECTION_SIG,
  ];
  for (const signature of helpers) {
    const row = (await db.query(
      "select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config"
      + " from pg_proc p where p.oid = $1::regprocedure", [signature])).rows;
    assert.equal(row.length, 1, signature);
    assert.equal(row[0].prosecdef, true, signature + " must be SECURITY DEFINER");
    assert.equal(row[0].config, "search_path=pg_catalog, public", signature + " pinned search_path");
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      const held = (await db.query(
        "select has_function_privilege($1::text, $2::regprocedure, 'EXECUTE') as held",
        [role, signature])).rows[0].held;
      assert.equal(held, false, role + " must not EXECUTE " + signature);
    }
  }
});

// ---------------------------------------------------------------------------
// Assertions 13-15: raw zero-length markers are rejected with 23514.
// ---------------------------------------------------------------------------
test("assertions 13-15: raw marker writes are rejected with 23514", async () => {
  await expectSqlstate(
    db.query(
      "insert into public.direct_entry_team_leader_assignments"
      + " (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to)"
      + " values ($1::uuid, $2::uuid, $3::uuid, $4::date, $4::date)",
      [TEAM_A, LEADER_A.app, RECRUITER_A, PAST]),
    "23514");
  await expectSqlstate(
    db.query(
      "insert into public.direct_entry_scope_grants"
      + " (app_user_id, scope_kind, team_id, valid_from, valid_to)"
      + " values ($1::uuid, 'all', null, $2::date, $2::date)",
      [LEADER_A.app, PAST]),
    "23514");
  await expectSqlstate(
    db.query(
      "insert into public.direct_entry_capability_grants"
      + " (app_user_id, capability, valid_from, valid_to)"
      + " values ($1::uuid, 'entry_admin', $2::date, $2::date)",
      [LEADER_A.app, PAST]),
    "23514");
});

// ---------------------------------------------------------------------------
// Assertions 16-18: valid write accepted; key/start-date uniqueness enforced.
// ---------------------------------------------------------------------------
test("assertions 16-18: a valid assignment is accepted and the two open indexes reject duplicates", async () => {
  await db.exec("begin");
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
    + " (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to)"
    + " values ($1::uuid, $2::uuid, $3::uuid, $4::date, null)",
    [TEAM_A, LEADER_A.app, RECRUITER_A, PAST]);
  await db.exec("commit");
  const accepted = (await db.query(
    "select count(*)::int as n from public.direct_entry_team_leader_assignments"
    + " where team_id = $1::uuid and leader_app_user_id = $2::uuid",
    [TEAM_A, LEADER_A.app])).rows[0].n;
  assert.equal(accepted, 1);

  await expectSqlstate(
    db.query(
      "insert into public.direct_entry_team_leader_assignments"
      + " (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to)"
      + " values ($1::uuid, $2::uuid, $3::uuid, $4::date, null)",
      [TEAM_A, LEADER_B.app, RECRUITER_B, PAST]),
    "23505");

  await expectSqlstate(
    db.query(
      "insert into public.direct_entry_team_leader_assignments"
      + " (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to)"
      + " values ($1::uuid, $2::uuid, $3::uuid, $4::date, null)",
      [TEAM_B, LEADER_A.app, RECRUITER_B, PAST]),
    "23505");

  await db.query("delete from public.direct_entry_team_leader_assignments where team_id = $1::uuid",
    [TEAM_A]);
});

// ---------------------------------------------------------------------------
// Assertions 19-20: flag allows a same-day replacement; a marker is inert.
// ---------------------------------------------------------------------------
test("assertions 19-20: the marker flag allows a same-day replacement and the marker is inert", async () => {
  await db.exec("begin");
  await db.query("select set_config('direct_entry.team_leader_marker', 'on', true)");
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
    + " (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to)"
    + " values ($1::uuid, $2::uuid, $3::uuid, $4::date, null)",
    [TEAM_A, LEADER_A.app, RECRUITER_A, REPLACE_DAY]);
  await db.query(
    "update public.direct_entry_team_leader_assignments set valid_to = $3::date"
    + " where team_id = $1::uuid and leader_app_user_id = $2::uuid",
    [TEAM_A, LEADER_A.app, REPLACE_DAY]);
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
    + " (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to)"
    + " values ($1::uuid, $2::uuid, $3::uuid, $4::date, null)",
    [TEAM_A, LEADER_B.app, RECRUITER_B, REPLACE_DAY]);
  await db.exec("commit");

  const rows = (await db.query(
    "select leader_app_user_id, valid_from::text as valid_from, valid_to::text as valid_to"
    + " from public.direct_entry_team_leader_assignments where team_id = $1::uuid"
    + " order by leader_app_user_id", [TEAM_A])).rows;
  assert.equal(rows.length, 2, "the marker and the replacement coexist");
  assert.deepEqual(rows[0], { leader_app_user_id: LEADER_A.app, valid_from: REPLACE_DAY, valid_to: REPLACE_DAY });
  assert.deepEqual(rows[1], { leader_app_user_id: LEADER_B.app, valid_from: REPLACE_DAY, valid_to: null });

  const effective = (await db.query(
    "select count(*)::int as n from public.direct_entry_team_leader_assignments"
    + " where valid_to is not null and valid_to = valid_from"
    + " and valid_from <= public.direct_entry_authorization_date()"
    + " and (valid_to is null or public.direct_entry_authorization_date() < valid_to)")).rows[0].n;
  assert.equal(effective, 0, "a cancellation marker is effective on no date");
  const projected = (await db.query(
    "select public.direct_entry_team_leader_projection(a, 'Synthetic Leader Team A', 'Synthetic Leader A') as p"
    + " from public.direct_entry_team_leader_assignments a"
    + " where a.team_id = $1::uuid and a.leader_app_user_id = $2::uuid",
    [TEAM_A, LEADER_A.app])).rows[0].p;
  assert.equal(projected.state, "HISTORY");

  await db.query("delete from public.direct_entry_team_leader_assignments where team_id = $1::uuid",
    [TEAM_A]);
});

// ---------------------------------------------------------------------------
// Assertions 21-23: immutable revisions and the audit FK.
// ---------------------------------------------------------------------------
test("assertions 21-22: leader revisions are immutable (UPDATE/DELETE -> 55000)", async () => {
  await db.exec("begin");
  await db.query(
    "insert into public.direct_entry_team_leader_revisions (team_id, version, action)"
    + " values ($1::uuid, 1, 'designate')", [TEAM_A]);

  await db.exec("savepoint before_update");
  await expectSqlstate(
    db.query("update public.direct_entry_team_leader_revisions set action = 'replace'"), "55000");
  await db.exec("rollback to savepoint before_update");

  await db.exec("savepoint before_delete");
  await expectSqlstate(
    db.query("delete from public.direct_entry_team_leader_revisions"), "55000");
  await db.exec("rollback to savepoint before_delete");

  await db.exec("rollback");
});

test("assertion 23: the audit leader_revision_id FK is ON DELETE RESTRICT", async () => {
  const column = (await db.query(
    "select count(*)::int as n from information_schema.columns"
    + " where table_schema = 'public' and table_name = 'direct_entry_audit_events'"
    + " and column_name = 'leader_revision_id'")).rows[0].n;
  assert.equal(column, 1);
  const fk = (await db.query(
    "select pg_get_constraintdef(c.oid) as definition, c.confdeltype from pg_constraint c"
    + " where c.conrelid = 'public.direct_entry_audit_events'::regclass and c.contype = 'f'"
    + " and pg_get_constraintdef(c.oid) like '%leader_revision_id%'")).rows;
  assert.equal(fk.length, 1);
  assert.equal(fk[0].confdeltype, "r", "the audit link must be ON DELETE RESTRICT");
  assert.match(fk[0].definition, /direct_entry_team_leader_revisions/i);
});

// ---------------------------------------------------------------------------
// Assertions 24-25: the fixed eight-key snapshot leaks nothing.
// ---------------------------------------------------------------------------
test("assertions 24-25: the snapshot exposes exactly the eight fixed keys and leaks nothing", async () => {
  const populated = (await db.query(
    "select public.direct_entry_team_leader_snapshot($1::uuid,$2::uuid,$3::uuid,$4::date,$5::date,$6::uuid,$7::int,$8::text) as s",
    [TEAM_A, LEADER_A.app, RECRUITER_A, PAST, null, null, 1, "designate"])).rows[0].s;
  assert.deepEqual(Object.keys(populated).sort(), SNAPSHOT_KEYS);

  const nullInput = (await db.query(
    "select public.direct_entry_team_leader_snapshot(null::uuid,null::uuid,null::uuid,null::date,null::date,null::uuid,1,'designate') as s")).rows[0].s;
  assert.deepEqual(Object.keys(nullInput).sort(), SNAPSHOT_KEYS);

  const definition = (await db.query(
    "select pg_get_functiondef($1::regprocedure) as definition", [SNAPSHOT_SIG])).rows[0].definition;
  for (const forbidden of ["auth_subject", "email", "display_name", "reason", "grant_id", "scope", "capabilit"]) {
    assert.equal(definition.includes(forbidden), false, "snapshot leaks " + forbidden);
  }
});

// ---------------------------------------------------------------------------
// Assertions 26-27: the bounded projection leaks no authority/audit internals.
// ---------------------------------------------------------------------------
test("assertions 26-27: the projection returns exactly the bounded keys and leaks nothing", async () => {
  await db.exec("begin");
  await db.query(
    "insert into public.direct_entry_team_leader_assignments"
    + " (team_id, leader_app_user_id, leader_recruiter_id, valid_from, valid_to)"
    + " values ($1::uuid, $2::uuid, $3::uuid, $4::date, null)",
    [TEAM_A, LEADER_A.app, RECRUITER_A, PAST]);
  const projected = (await db.query(
    "select public.direct_entry_team_leader_projection(a, 'Synthetic Leader Team A', 'Synthetic Leader A') as p"
    + " from public.direct_entry_team_leader_assignments a where a.team_id = $1::uuid",
    [TEAM_A])).rows[0].p;
  assert.deepEqual(Object.keys(projected).sort(), PROJECTION_KEYS);
  await db.exec("rollback");

  const definition = (await db.query(
    "select pg_get_functiondef($1::regprocedure) as definition", [PROJECTION_SIG])).rows[0].definition;
  for (const forbidden of ["auth_subject", "email", "grant_id", "reason", "scope", "capabilit", "audit"]) {
    assert.equal(definition.includes(forbidden), false, "projection leaks " + forbidden);
  }
});

// ---------------------------------------------------------------------------
// Assertion 28: the closing self-check exists and fails the migration on drift.
// ---------------------------------------------------------------------------
test("assertion 28: the closing self-check fails the migration on contract drift", async () => {
  const sql = await readMigration(NEW_MIGRATION);
  assert.equal(sql.includes("v_helpers"), true, "the self-check block must exist");
  assert.equal(sql.includes("direct_entry_team_leader_assignment_marker_guard"), true);
  assert.equal(sql.includes("errcode = '55000'"), true);

  const start = sql.indexOf("create trigger direct_entry_scope_grant_marker_guard");
  assert.notEqual(start, -1, "the scope marker trigger block must exist");
  const semi = sql.indexOf(";", start);
  const drifted = sql.slice(0, start) + sql.slice(semi + 1);
  assert.notEqual(drifted, sql, "the drift mutation must actually remove the scope marker trigger");

  const db2 = new PGlite();
  await db2.exec(AUTH_PROLOGUE);
  for (const name of await readMigrationNames()) {
    if (name === NEW_MIGRATION) break;
    await db2.exec(await readMigration(name));
  }
  await expectSqlstate(db2.exec(drifted), "55000");
  await db2.close();
});

// ---------------------------------------------------------------------------
// Assertion 29: fixture rollback leaves zero residue in the leader tables.
// ---------------------------------------------------------------------------
test("assertion 29: the fixture leaves zero residue in the leader tables", async () => {
  const residue = (await db.query(
    "select (select count(*)::int from public.direct_entry_team_leader_assignments) as assignments,"
    + " (select count(*)::int from public.direct_entry_team_leader_revisions) as revisions")).rows[0];
  assert.deepEqual(residue, { assignments: 0, revisions: 0 });
});

// ---------------------------------------------------------------------------
// Assertion 30: no PII, email, real UUID or raw DB error text in any output.
// ---------------------------------------------------------------------------
test("assertion 30: the regression surfaces no PII, email or raw error text", async () => {
  // Every identifier in this file is a reserved synthetic range (10000000-...,
  // 20000000-..., 93000000-..., 94000000-...) and every display name is the
  // literal "Synthetic ...". No production UUID, email or PII is hardcoded.
  const source = await readFile(new URL(import.meta.url), "utf8");
  assert.equal(/@[a-z0-9.-]+[.](com|net|org|vn|io)/i.test(source), false,
    "no email-like literal in the source");
  assert.ok(CAPTURED.length > 0, "the suite actually exercised rejections");
  for (const code of CAPTURED) {
    assert.match(String(code), /^[A-Z0-9]{5}$/, "only a canonical SQLSTATE is surfaced");
  }
});
