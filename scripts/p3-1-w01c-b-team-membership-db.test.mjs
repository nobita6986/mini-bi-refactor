/**
 * P3.1-W01C-B - Team membership lifecycle backend (#70) DB acceptance.
 *
 * Proves the single catalog guard reused from #68, the membership interval and
 * cancellation-marker semantics, the HRP eligibility boundary, the back-dated
 * attribution protection, and the OCC / idempotency / revision / audit / ACL
 * invariants of migration #70.
 *
 * No Production access, no network, no browser: PGlite applies the real local
 * migrations and the RPCs are called exactly as the service-role repository does.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const NEW_MIGRATION = "20261009060000_p3_1_w01c_b_team_membership.sql";
const PREVIOUS_MIGRATION = "20261009050000_p3_1_w01c_a_team_catalog.sql";

const FULL_ADMIN = { auth: "10000000-0000-4000-8000-0000000000c1", app: "20000000-0000-4000-8000-0000000000c1" };
const CATALOG = { auth: "10000000-0000-4000-8000-0000000000c2", app: "20000000-0000-4000-8000-0000000000c2" };
const ENTRY_ADMIN_ONLY = { auth: "10000000-0000-4000-8000-0000000000c3", app: "20000000-0000-4000-8000-0000000000c3" };
const CATALOG_NO_ALL = { auth: "10000000-0000-4000-8000-0000000000c4", app: "20000000-0000-4000-8000-0000000000c4" };
const LEADER = { auth: "10000000-0000-4000-8000-0000000000c5", app: "20000000-0000-4000-8000-0000000000c5" };
const PROJECT_MANAGER = { auth: "10000000-0000-4000-8000-0000000000c6", app: "20000000-0000-4000-8000-0000000000c6" };
const STAFF = { auth: "10000000-0000-4000-8000-0000000000c7", app: "20000000-0000-4000-8000-0000000000c7" };
const DISABLED_ADMIN = { auth: "10000000-0000-4000-8000-0000000000c8", app: "20000000-0000-4000-8000-0000000000c8" };

const TEAM_A = "94000000-0000-4000-8000-0000000000a1";
const TEAM_B = "94000000-0000-4000-8000-0000000000a2";
const TEAM_INACTIVE = "94000000-0000-4000-8000-0000000000a3";
const RESERVED_CODE = "__system_vendor__";
const MISSING_TEAM = "94000000-0000-4000-8000-0000000000ff";
const MISSING_APP = "20000000-0000-4000-8000-0000000000ff";

const HRP_A = "93000000-0000-4000-8000-0000000000b1";
const HRP_B = "93000000-0000-4000-8000-0000000000b2";
const INACTIVE = "93000000-0000-4000-8000-0000000000b3";
const NO_MEMBERSHIP = "93000000-0000-4000-8000-0000000000b4";
const VENDOR_RECRUITER = "93000000-0000-4000-8000-0000000000b5";
const EXPIRED_HRP = "93000000-0000-4000-8000-0000000000b6";
const FUTURE_HRP = "93000000-0000-4000-8000-0000000000b7";
const ENTRY_SUBJECT = "93000000-0000-4000-8000-0000000000b8";
const HRP_C = "93000000-0000-4000-8000-0000000000b9";
const HRP_D = "93000000-0000-4000-8000-0000000000ba";
const HRP_E = "93000000-0000-4000-8000-0000000000bb";
const HRP_F = "93000000-0000-4000-8000-0000000000bc";
const HRP_G = "93000000-0000-4000-8000-0000000000bd";
const HRP_H = "93000000-0000-4000-8000-0000000000be";

const VENDOR_ID = "vendor.w01cb";
const PROJECT_ID = "membership_proj";
const CANDIDATE_ID = "91000000-0000-4000-8000-0000000000d1";
const SUBMISSION_ID = "91000000-0000-4000-8000-0000000000d2";
const MEMBER_ENTRY_ID = "91000000-0000-4000-8000-0000000000d3";

const PAST = "2026-01-01";
const ENTRY_DATE = "2026-01-10";
const LATER = "2026-02-01";
const FUTURE = "2099-01-01";
const REASON = "Synthetic membership reason";
const KEY = (suffix) => "50000000-0000-4000-8000-0000000000" + suffix;

const RPC_PARAMS = {
  direct_entry_list_team_membership_current: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_team_id", "p_search", "p_page", "p_page_size"],
  direct_entry_list_team_membership_scheduled: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_team_id", "p_search", "p_page", "p_page_size"],
  direct_entry_list_team_membership_history: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_team_id", "p_search", "p_page", "p_page_size"],
  direct_entry_assign_team_membership: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_team_id", "p_valid_from", "p_expected_version", "p_reason", "p_idempotency_key"],
  direct_entry_move_team_membership: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_team_id", "p_valid_from", "p_expected_version", "p_reason", "p_idempotency_key"],
  direct_entry_unassign_team_membership: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_valid_to", "p_expected_version", "p_reason", "p_idempotency_key"],
};

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  for (const name of (await readdir(MIGRATION_DIR)).filter((n) => n.endsWith(".sql")).sort()) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

async function rpc(db, name, args = {}) {
  const order = RPC_PARAMS[name];
  assert.ok(order, "unknown rpc " + name);
  const values = order.map((key) => (key in args ? args[key] : null));
  const signature = order.map((_, index) => "$" + (index + 1)).join(", ");
  const { rows } = await db.query("select public." + name + "(" + signature + ") as result", values);
  return rows[0].result;
}

async function rpcError(db, name, args = {}) {
  try {
    await rpc(db, name, args);
    return null;
  } catch (error) {
    return { code: error.code, message: error.message };
  }
}

async function addActor(db, actor) {
  await db.query("insert into auth.users (id) values ($1::uuid)", [actor.auth]);
  await db.query(
    "insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)"
    + " values ($1::uuid, $2::uuid, $3, $4)",
    [actor.app, actor.auth, actor.enabled !== false, actor.display_name ?? "Synthetic Actor"]);
  for (const capability of actor.capabilities ?? []) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)"
      + " values ($1::uuid, $2, '2020-01-01', $3)", [actor.app, capability, actor.enabled !== false]);
  }
  for (const kind of actor.scopes ?? []) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)"
      + " values ($1::uuid, $2, $3::uuid, '2020-01-01', $4)",
      [actor.app, kind, kind === "team" ? TEAM_A : null, actor.enabled !== false]);
  }
}

async function counts(db) {
  const { rows } = await db.query(
    "select (select count(*)::int from public.recruiter_team_memberships) as memberships,"
    + " (select count(*)::int from public.direct_entry_team_membership_revisions) as revisions,"
    + " (select count(*)::int from public.direct_entry_audit_events) as audits,"
    + " (select count(*)::int from public.direct_entry_restricted_reasons) as reasons,"
    + " (select count(*)::int from public.direct_entry_capability_grants) as capability_grants,"
    + " (select count(*)::int from public.direct_entry_scope_grants) as scope_grants,"
    + " (select count(*)::int from public.direct_entry_rpc_idempotency) as idempotency,"
    + " (select count(*)::int from public.recruiters) as recruiters,"
    + " (select count(*)::int from public.teams) as teams,"
    + " (select count(*)::int from public.direct_entries) as entries");
  return rows[0];
}

const PROJECTION_KEYS = ["membership_id", "recruiter_id", "team_id", "team_display_name",
  "valid_from", "valid_to", "recruiter_version", "state"].sort();
const SNAPSHOT_KEYS = ["recruiter_id", "team_id", "valid_from", "valid_to", "version",
  "change"].sort();

function sortedKeys(value) {
  return Object.keys(value).sort().join(",");
}

async function assign(db, actor, { recruiter = HRP_A, team = TEAM_A, from = PAST,
  version = 1, key = KEY("a1"), reason = REASON }) {
  return rpc(db, "direct_entry_assign_team_membership", {
    p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: recruiter,
    p_team_id: team, p_valid_from: from, p_expected_version: version, p_reason: reason,
    p_idempotency_key: key,
  });
}

async function move(db, actor, { recruiter = HRP_A, team = TEAM_B, from = LATER,
  version = 2, key = KEY("m1"), reason = REASON }) {
  return rpc(db, "direct_entry_move_team_membership", {
    p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: recruiter,
    p_team_id: team, p_valid_from: from, p_expected_version: version, p_reason: reason,
    p_idempotency_key: key,
  });
}

async function unassign(db, actor, { recruiter = HRP_A, to = LATER, version = 2,
  key = KEY("u1"), reason = REASON }) {
  return rpc(db, "direct_entry_unassign_team_membership", {
    p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: recruiter,
    p_valid_to: to, p_expected_version: version, p_reason: reason,
    p_idempotency_key: key,
  });
}

async function readMemberships(db, state, args = {}) {
  const name = "direct_entry_list_team_membership_" + state;
  return rpc(db, name, {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_search: null,
    p_page: 1, p_page_size: 25, ...args,
  });
}

const db = await database();

async function recruiterVersion(database_, recruiterId) {
  const { rows } = await database_.query(
    "select version from public.recruiters where recruiter_id = $1::uuid", [recruiterId]);
  return rows[0].version;
}

await db.exec("insert into public.teams (team_id, code, display_name, active) values"
  + " ('" + TEAM_A + "', 'MEM_A', 'Synthetic Membership Team A', true),"
  + " ('" + TEAM_B + "', 'MEM_B', 'Synthetic Membership Team B', true),"
  + " ('" + TEAM_INACTIVE + "', 'MEM_OFF', 'Synthetic Membership Team Off', false)");
// The reserved Vendor system team, created exactly as the canonical #65 helper would.
await db.exec("insert into public.teams (code, display_name, active) values ('"
  + RESERVED_CODE + "', 'Vendor', true)");
await db.exec("insert into public.vendors (vendor_id, display_name, active) values ('"
  + VENDOR_ID + "', 'Synthetic Vendor', true)");

await addActor(db, { ...FULL_ADMIN, display_name: "Synthetic Full Admin",
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"], scopes: ["all"] });
await addActor(db, { ...CATALOG, display_name: "Synthetic Catalog Operator",
  capabilities: ["catalog_master_manage"], scopes: ["all"] });
await addActor(db, { ...ENTRY_ADMIN_ONLY, capabilities: ["entry_admin"], scopes: ["all"] });
await addActor(db, { ...CATALOG_NO_ALL, capabilities: ["catalog_master_manage"], scopes: ["own"] });
await addActor(db, { ...LEADER, capabilities: ["team_manager_assign"], scopes: ["team"] });
await addActor(db, { ...PROJECT_MANAGER, capabilities: ["entry_team", "change_request_create"],
  scopes: ["team"] });
await addActor(db, { ...STAFF, capabilities: ["entry_own"], scopes: ["own"] });
await addActor(db, { ...DISABLED_ADMIN, enabled: false,
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"], scopes: ["all"] });

for (const [recruiterId, displayName, active] of [
  [HRP_A, "Synthetic HRP A", true],
  [HRP_B, "Synthetic HRP B", true],
  [INACTIVE, "Synthetic Inactive Person", false],
  [NO_MEMBERSHIP, "Synthetic No Provider", true],
  [VENDOR_RECRUITER, "Synthetic Vendor Person", true],
  [EXPIRED_HRP, "Synthetic Expired HRP", true],
  [FUTURE_HRP, "Synthetic Future HRP", true],
  [ENTRY_SUBJECT, "Synthetic Entry Subject", true],
  [HRP_C, "Synthetic HRP C", true],
  [HRP_D, "Synthetic HRP D", true],
  [HRP_E, "Synthetic HRP E", true],
  [HRP_F, "Synthetic HRP F", true],
  [HRP_G, "Synthetic HRP G", true],
  [HRP_H, "Synthetic HRP H", true],
]) {
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name, active, version)"
    + " values ($1::uuid, $2, $3, 1)", [recruiterId, displayName, active]);
}
for (const recruiterId of [HRP_A, HRP_B, INACTIVE, ENTRY_SUBJECT, HRP_C, HRP_D, HRP_E, HRP_F, HRP_G,
  HRP_H]) {
  await db.query(
    "insert into public.recruiter_provider_memberships"
    + " (recruiter_id, provider_type, valid_from, valid_to, vendor_id, is_current)"
    + " values ($1::uuid, 'hrp', '2020-01-01', null, null, true)", [recruiterId]);
}
await db.query(
  "insert into public.recruiter_provider_memberships"
    + " (recruiter_id, provider_type, valid_from, valid_to, vendor_id, is_current)"
    + " values ($1::uuid, 'hrp', '2020-01-01', '2021-01-01', null, false)", [EXPIRED_HRP]);
await db.query(
  "insert into public.recruiter_provider_memberships"
    + " (recruiter_id, provider_type, valid_from, valid_to, vendor_id, is_current)"
    + " values ($1::uuid, 'hrp', '2099-01-01', null, null, false)", [FUTURE_HRP]);
await db.query(
  "insert into public.recruiter_provider_memberships"
    + " (recruiter_id, provider_type, valid_from, valid_to, vendor_id, is_current)"
    + " values ($1::uuid, 'vendor', '2020-01-01', null, $2, true)", [VENDOR_RECRUITER, VENDOR_ID]);

async function expectMutationError(operation, code) {
  await db.exec("savepoint expected_failure");
  try {
    await assert.rejects(operation, (error) => error.code === code);
  } finally {
    await db.exec("rollback to savepoint expected_failure; release savepoint expected_failure");
  }
}

async function installLegacyFutureMoveWriter(database_) {
  const legacyMigration = await readFile(
    path.join(MIGRATION_DIR, NEW_MIGRATION), "utf8");
  const start = legacyMigration.indexOf(
    "create or replace function public.direct_entry_move_team_membership(");
  const end = legacyMigration.indexOf(
    "revoke all on function public.direct_entry_move_team_membership(", start);
  assert.ok(start >= 0 && end > start, "legacy move writer is present for cutover fixtures");
  await database_.exec(legacyMigration.slice(start, end));

  const r1Migration = await readFile(
    path.join(MIGRATION_DIR, "20261020200000_r1_current_state_authorization.sql"), "utf8");
  const unassignStart = r1Migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.direct_entry_unassign_team_membership(");
  const unassignEnd = r1Migration.indexOf(
    "CREATE OR REPLACE FUNCTION public.direct_entry_update_draft_row(", unassignStart);
  assert.ok(unassignStart >= 0 && unassignEnd > unassignStart, "legacy unassign writer is present for cutover fixtures");
  await database_.exec(r1Migration.slice(unassignStart, unassignEnd));
}

async function installLegacyFutureTeamLeaderWriter(database_) {
  const hfMigration = await readFile(
    path.join(MIGRATION_DIR, "20261103180000_hf_hrp_membership_effective_interval_alignment.sql"), "utf8");
  const start = hfMigration.indexOf(
    "create or replace function public.direct_entry_apply_team_leader_mutation(");
  const end = hfMigration.indexOf(
    "revoke all on function public.direct_entry_apply_team_leader_mutation(", start);
  assert.ok(start >= 0 && end > start, "legacy team leader writer is present for cutover fixtures");
  await database_.exec(hfMigration.slice(start, end));
}

test("finite move excludes historical rows and markers on every date", async () => {
  await db.exec("begin");
  try {
    await assign(db, CATALOG, { recruiter: HRP_H, key: "history-assign" });
    await unassign(db, CATALOG, { recruiter: HRP_H, to: "2026-02-01", key: "history-close" });
    const before = await counts(db);
    await expectMutationError(() => move(db, CATALOG, { recruiter: HRP_H, from: "2026-01-15", version: 3,
      key: "history-move" }), "22023");
    assert.deepEqual(await counts(db), before);
  } finally { await db.exec("rollback"); }
});

test("assigning an eligible HRP person opens one interval with one revision and one audit", async () => {
  const before = await counts(db);
  const version = await recruiterVersion(db, HRP_A);
  const result = await assign(db, CATALOG, { version });

  assert.equal(sortedKeys(result), ["change", "membership_id", "recruiter_id", "recruiter_version",
    "revision_id", "team_id", "valid_from", "valid_to"].sort().join(","));
  assert.equal(result.change, "ASSIGN");
  assert.equal(result.recruiter_id, HRP_A);
  assert.equal(result.team_id, TEAM_A);
  assert.equal(result.valid_from, PAST);
  assert.equal(result.valid_to, null);
  assert.equal(result.recruiter_version, version + 1);

  const after = await counts(db);
  assert.equal(after.memberships, before.memberships + 1);
  assert.equal(after.revisions, before.revisions + 1);
  assert.equal(after.audits, before.audits + 1);
  assert.equal(after.reasons, before.reasons + 1);
  assert.equal(after.scope_grants, before.scope_grants, "no scope grant is created");
  assert.equal(after.capability_grants, before.capability_grants, "no capability grant is created");
  assert.equal(after.recruiters, before.recruiters, "no recruiter is created");

  const revision = (await db.query(
    "select version, before_snapshot, after_snapshot from public.direct_entry_team_membership_revisions"
    + " where recruiter_id = $1::uuid order by version desc limit 1", [HRP_A])).rows[0];
  assert.equal(revision.version, version + 1);
  assert.equal(revision.before_snapshot, null);
  assert.deepEqual(Object.keys(revision.after_snapshot).sort(), SNAPSHOT_KEYS);
  assert.equal(revision.after_snapshot.change, "ASSIGN");
  assert.equal(revision.after_snapshot.team_id, TEAM_A);

  const audit = (await db.query(
    "select action, capability, scope_kind, scope_team_id, changed_fields, outcome,"
    + " team_membership_revision_id from public.direct_entry_audit_events"
    + " where resource_ref = $1 order by created_at desc limit 1", [HRP_A])).rows[0];
  assert.equal(audit.action, "team_membership_assign");
  assert.equal(audit.capability, "catalog_master_manage");
  assert.equal(audit.scope_kind, "all");
  assert.equal(audit.scope_team_id, null);
  assert.equal(audit.outcome, "APPLIED");
  assert.deepEqual(audit.changed_fields.sort(), ["backdated", "team_id", "valid_from"]);
  assert.equal(audit.team_membership_revision_id, result.revision_id);
});

test("the eligibility boundary denies every non-eligible subject with zero residue", async () => {
  const before = await counts(db);
  for (const [recruiter, label] of [
    [NO_MEMBERSHIP, "no provider membership"],
    [VENDOR_RECRUITER, "vendor provider membership"],
    [EXPIRED_HRP, "expired HRP membership"],
    [FUTURE_HRP, "not yet effective HRP membership"],
    [INACTIVE, "inactive recruiter"],
  ]) {
    const error = await rpcError(db, "direct_entry_assign_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiter,
      p_team_id: TEAM_A, p_valid_from: PAST, p_expected_version: 1, p_reason: REASON,
      p_idempotency_key: KEY("e1"),
    });
    assert.ok(error, label + " must be denied");
    assert.equal(error.code, "P0002", label);
  }

  // Defense in depth: even a raw insert cannot give a Vendor provider recruiter a
  // business-team membership, independently of the RPC eligibility lock.
  await assert.rejects(
    db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)"
      + " values ($1::uuid, $2::uuid, '2026-01-01')", [VENDOR_RECRUITER, TEAM_A]),
    (error) => error.code === "23514");

  assert.deepEqual(await counts(db), before, "ineligible subjects leave zero residue");
});

test("the reserved Vendor system team rejects membership writes on both paths", async () => {
  const reservedId = (await db.query(
    "select team_id from public.teams where code = $1", [RESERVED_CODE])).rows[0].team_id;
  const before = await counts(db);

  // Raw insert path: the #65 trigger owns the reserved-team boundary.
  await assert.rejects(
    db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from)"
      + " values ($1::uuid, $2::uuid, '2026-01-01')", [HRP_B, reservedId]),
    (error) => error.code === "23514");

  // RPC path: the same trigger raises, so the RPC never special-cases the team.
  const error = await rpcError(db, "direct_entry_assign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_B,
    p_team_id: reservedId, p_valid_from: PAST, p_expected_version: 1, p_reason: REASON,
    p_idempotency_key: KEY("e2"),
  });
  assert.equal(error.code, "23514");
  assert.deepEqual(await counts(db), before, "the reserved team leaves zero residue");
});

test("target team validation rejects an inactive team and an unknown team", async () => {
  const before = await counts(db);
  const inactive = await rpcError(db, "direct_entry_assign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_B,
    p_team_id: TEAM_INACTIVE, p_valid_from: PAST, p_expected_version: 1, p_reason: REASON,
    p_idempotency_key: KEY("e3"),
  });
  assert.equal(inactive.code, "23514");
  const unknown = await rpcError(db, "direct_entry_assign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_B,
    p_team_id: MISSING_TEAM, p_valid_from: PAST, p_expected_version: 1, p_reason: REASON,
    p_idempotency_key: KEY("e4"),
  });
  assert.equal(unknown.code, "P0002");
  assert.deepEqual(await counts(db), before);
});

test("a second effective membership for the same person is rejected with 23P01", async () => {
  const before = await counts(db);
  const version = await recruiterVersion(db, HRP_A);
  const error = await rpcError(db, "direct_entry_assign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_A,
    p_team_id: TEAM_B, p_valid_from: "2026-03-01", p_expected_version: version,
    p_reason: REASON, p_idempotency_key: KEY("e5"),
  });
  assert.equal(error.code, "23P01");
  assert.deepEqual(await counts(db), before, "an overlapping assign leaves zero residue");
});

test("a move on a later date closes the outgoing interval and opens the incoming one", async () => {
  const before = await counts(db);
  const version = await recruiterVersion(db, HRP_A);
  const result = await move(db, CATALOG, { version });

  assert.equal(result.change, "MOVE");
  assert.equal(result.team_id, TEAM_B);
  assert.equal(result.valid_from, LATER);
  assert.equal(result.valid_to, null);
  assert.equal(result.recruiter_version, version + 1);

  const rows = (await db.query(
    "select team_id, valid_from::text as valid_from, valid_to::text as valid_to"
    + " from public.recruiter_team_memberships where recruiter_id = $1::uuid"
    + " order by valid_from", [HRP_A])).rows;
  assert.equal(rows.length, 2, "the outgoing interval is closed, not deleted");
  assert.deepEqual(rows[0], { team_id: TEAM_A, valid_from: PAST, valid_to: LATER });
  assert.deepEqual(rows[1], { team_id: TEAM_B, valid_from: LATER, valid_to: null });

  const after = await counts(db);
  assert.equal(after.memberships, before.memberships + 1);
  assert.equal(after.revisions, before.revisions + 1, "a move appends exactly one revision");
  assert.equal(after.audits, before.audits + 1);

  const revision = (await db.query(
    "select before_snapshot, after_snapshot, version from public.direct_entry_team_membership_revisions"
    + " where recruiter_id = $1::uuid order by version desc limit 1", [HRP_A])).rows[0];
  assert.deepEqual(Object.keys(revision.before_snapshot).sort(), SNAPSHOT_KEYS);
  assert.deepEqual(Object.keys(revision.after_snapshot).sort(), SNAPSHOT_KEYS);
  assert.equal(revision.before_snapshot.change, "MOVE");
  assert.equal(revision.before_snapshot.team_id, TEAM_A);
  assert.equal(revision.after_snapshot.team_id, TEAM_B);
  assert.equal(revision.after_snapshot.version, revision.version);
});

test("a same-day move leaves the outgoing interval as an inert cancellation marker", async () => {
  const before = await counts(db);
  const version = await recruiterVersion(db, HRP_B);
  await assign(db, CATALOG, { recruiter: HRP_B, team: TEAM_A, from: LATER, version,
    key: KEY("10") });
  const afterAssign = await recruiterVersion(db, HRP_B);
  const result = await move(db, CATALOG, { recruiter: HRP_B, team: TEAM_B, from: LATER,
    version: afterAssign, key: KEY("11") });

  assert.equal(result.change, "MOVE");
  const rows = (await db.query(
    "select team_id, valid_from::text as valid_from, valid_to::text as valid_to"
    + " from public.recruiter_team_memberships where recruiter_id = $1::uuid"
    + " order by valid_from, team_id", [HRP_B])).rows;
  assert.equal(rows.length, 2, "both the marker and the replacement exist");
  const marker = rows.find((row) => row.team_id === TEAM_A);
  const incoming = rows.find((row) => row.team_id === TEAM_B);
  assert.deepEqual(marker, { team_id: TEAM_A, valid_from: LATER, valid_to: LATER });
  assert.deepEqual(incoming, { team_id: TEAM_B, valid_from: LATER, valid_to: null });

  const after = await counts(db);
  assert.equal(after.memberships, before.memberships + 2, "assign plus same-day move");
  assert.equal(after.revisions, before.revisions + 2);

  const audit = (await db.query(
    "select changed_fields from public.direct_entry_audit_events"
    + " where resource_ref = $1 and action = 'team_membership_move' limit 1", [HRP_B])).rows[0];
  assert.deepEqual(audit.changed_fields.sort(),
    ["backdated", "cancellation_marker", "team_id", "valid_to"]);
});

test("future membership writes fail closed and leave no schedule or authority", async () => {
  const before = await counts(db);
  const version = await recruiterVersion(db, HRP_C);
  await assert.rejects(
    assign(db, CATALOG, { recruiter: HRP_C, team: TEAM_A, from: FUTURE, version, key: KEY("20") }),
    (error) => error.code === "22023" && /explicit activation/.test(error.message));
  await assert.rejects(
    move(db, CATALOG, { recruiter: HRP_C, team: TEAM_A, from: FUTURE, version, key: KEY("20-move") }),
    (error) => error.code === "22023" && /explicit activation/.test(error.message));
  await assert.rejects(
    unassign(db, CATALOG, { recruiter: HRP_C, to: FUTURE, version, key: KEY("20-unassign") }),
    (error) => error.code === "22023" && /explicit activation/.test(error.message));
  assert.deepEqual(await counts(db), before, "rejected future writes leave no residue");
  assert.equal((await readMemberships(db, "current", { p_recruiter_id: HRP_C })).total, 0);
  assert.equal((await readMemberships(db, "scheduled", { p_recruiter_id: HRP_C })).total, 0);
});

test("legacy scheduled moves remain auditable and cancellation never promotes a revoked predecessor", async () => {
  await db.exec("begin");
  try {
    await installLegacyFutureMoveWriter(db);

    const first = await assign(db, CATALOG, { recruiter: HRP_G, team: TEAM_A,
      from: PAST, key: "legacy-move-current" });
    const firstScheduled = await move(db, CATALOG, { recruiter: HRP_G, team: TEAM_B,
      from: FUTURE, version: first.recruiter_version, key: "legacy-move-future" });
    const firstRows = (await db.query(
      "select team_id,valid_from::text as valid_from,valid_to::text as valid_to,is_current"
      + " from public.recruiter_team_memberships where recruiter_id=$1 order by valid_from",
      [HRP_G])).rows;
    assert.equal(firstRows[0].is_current, true,
      "the snapshot-current predecessor remains authoritative across its legacy future end date");
    assert.equal(firstRows[1].is_current, false,
      "the pre-cutover future row is history/schedule metadata only");
    assert.equal((await readMemberships(db, "current", { p_recruiter_id: HRP_G })).memberships[0].team_id,
      TEAM_A);
    const countsBeforeCancel = await counts(db);
    const cancelled = await unassign(db, CATALOG, { recruiter: HRP_G, to: FUTURE,
      version: firstScheduled.recruiter_version, key: "legacy-move-cancel" });
    assert.equal(cancelled.change, "CANCEL");
    const countsAfterCancel = await counts(db);
    assert.equal(countsAfterCancel.audits, countsBeforeCancel.audits + 1);
    assert.equal(countsAfterCancel.revisions, countsBeforeCancel.revisions + 1);
    assert.deepEqual(await unassign(db, CATALOG, { recruiter: HRP_G, to: FUTURE,
      version: firstScheduled.recruiter_version, key: "legacy-move-cancel" }), cancelled);
    assert.deepEqual(await counts(db), countsAfterCancel, "replay writes no second audit or revision");
    assert.deepEqual((await db.query(
      "select team_id,valid_to::text as valid_to,is_current from public.recruiter_team_memberships"
      + " where recruiter_id=$1 order by valid_from", [HRP_G])).rows, [
      { team_id: TEAM_A, valid_to: null, is_current: true },
      { team_id: TEAM_B, valid_to: FUTURE, is_current: false },
    ], "cancelling a legacy scheduled MOVE restores the previously current predecessor");
    assert.equal((await readMemberships(db, "current", { p_recruiter_id: HRP_G })).memberships[0].team_id,
      TEAM_A, "the already-current predecessor remains current after explicit cancellation");

    const second = await assign(db, CATALOG, { recruiter: HRP_H, team: TEAM_A,
      from: PAST, key: "legacy-revoked-current" });
    const secondScheduled = await move(db, CATALOG, { recruiter: HRP_H, team: TEAM_B,
      from: FUTURE, version: second.recruiter_version, key: "legacy-revoked-future" });
    await db.query(
      "update public.recruiter_team_memberships set is_current=false"
      + " where recruiter_id=$1 and team_id=$2 and valid_from=$3", [HRP_H, TEAM_A, PAST]);
    const revokedBeforeCancel = (await db.query(
      "select is_current from public.recruiter_team_memberships"
      + " where recruiter_id=$1 and team_id=$2 and valid_from=$3", [HRP_H, TEAM_A, PAST])).rows[0];
    assert.equal(revokedBeforeCancel.is_current, false);
    await unassign(db, CATALOG, { recruiter: HRP_H, to: FUTURE,
      version: secondScheduled.recruiter_version, key: "legacy-revoked-cancel" });
    const afterRevokedCancel = (await db.query(
      "select team_id,valid_to::text as valid_to,is_current from public.recruiter_team_memberships"
      + " where recruiter_id=$1 order by valid_from", [HRP_H])).rows;
    assert.deepEqual(afterRevokedCancel, [
      { team_id: TEAM_A, valid_to: null, is_current: false },
      { team_id: TEAM_B, valid_to: FUTURE, is_current: false },
    ], "cancellation restores interval dates but never re-grants a marker cleared by explicit revocation");
    assert.equal((await readMemberships(db, "current", { p_recruiter_id: HRP_H })).total, 0);
  } finally {
    await db.exec("rollback");
  }
});

test("legacy future cancellation cannot restore authority to an inactive team or recruiter", async () => {
  await db.exec("begin");
  try {
    await installLegacyFutureMoveWriter(db);

    const teamStart = await assign(db, CATALOG, { recruiter: HRP_G, team: TEAM_A,
      from: PAST, key: "legacy-inactive-team-start" });
    const teamMove = await move(db, CATALOG, { recruiter: HRP_G, team: TEAM_B,
      from: FUTURE, version: teamStart.recruiter_version, key: "legacy-inactive-team-move" });
    await db.query("update public.teams set active=false where team_id=$1", [TEAM_A]);
    const beforeTeamCancel = await counts(db);
    await expectMutationError(() => unassign(db, CATALOG, { recruiter: HRP_G, to: FUTURE,
      version: teamMove.recruiter_version, key: "legacy-inactive-team-cancel" }), "23514");
    assert.deepEqual(await counts(db), beforeTeamCancel,
      "an inactive predecessor team prevents cancellation restore without residue");
    await db.query("update public.teams set active=true where team_id=$1", [TEAM_A]);

    const recruiterStart = await assign(db, CATALOG, { recruiter: HRP_H, team: TEAM_B,
      from: PAST, key: "legacy-inactive-recruiter-start" });
    const recruiterMove = await move(db, CATALOG, { recruiter: HRP_H, team: TEAM_A,
      from: FUTURE, version: recruiterStart.recruiter_version,
      key: "legacy-inactive-recruiter-move" });
    await db.query("update public.recruiters set active=false where recruiter_id=$1", [HRP_H]);
    const beforeRecruiterCancel = await counts(db);
    await expectMutationError(() => unassign(db, CATALOG, { recruiter: HRP_H, to: FUTURE,
      version: recruiterMove.recruiter_version, key: "legacy-inactive-recruiter-cancel" }), "P0002");
    assert.deepEqual(await counts(db), beforeRecruiterCancel,
      "an inactive recruiter prevents cancellation restore without residue");
  } finally {
    await db.exec("rollback");
  }
});

test("unassigning a live membership closes it and keeps the history readable", async () => {
  const version = await recruiterVersion(db, HRP_A);
  const result = await unassign(db, CATALOG, { recruiter: HRP_A, to: "2026-03-01", version,
    key: KEY("22") });

  assert.equal(result.change, "UNASSIGN");
  assert.equal(result.team_id, TEAM_B);
  assert.equal(result.valid_from, LATER);
  assert.equal(result.valid_to, "2026-03-01");

  assert.equal((await readMemberships(db, "current", { p_recruiter_id: HRP_A })).total, 0);
  const history = await readMemberships(db, "history", { p_recruiter_id: HRP_A });
  assert.equal(history.total, 2, "the closed interval and the earlier closed one are history");
  for (const row of history.memberships) {
    assert.equal(row.state, "HISTORY");
    assert.equal(row.valid_to !== null, true);
  }
  const revision = (await db.query(
    "select before_snapshot, after_snapshot from public.direct_entry_team_membership_revisions"
    + " where recruiter_id = $1::uuid order by version desc limit 1", [HRP_A])).rows[0];
  assert.deepEqual(Object.keys(revision.before_snapshot).sort(), SNAPSHOT_KEYS);
  assert.deepEqual(Object.keys(revision.after_snapshot).sort(), SNAPSHOT_KEYS);
  assert.equal(revision.before_snapshot.change, "UNASSIGN");
  assert.equal(revision.after_snapshot.valid_to, "2026-03-01");
});

test("a same-day unassign writes an inert cancellation marker", async () => {
  const version = await recruiterVersion(db, HRP_D);
  const assigned = await assign(db, CATALOG, { recruiter: HRP_D, team: TEAM_A, from: PAST,
    version, key: KEY("23") });
  const cancelled = await unassign(db, CATALOG, { recruiter: HRP_D, to: PAST,
    version: assigned.recruiter_version, key: KEY("24") });

  assert.equal(cancelled.change, "CANCEL");
  assert.equal(cancelled.valid_from, PAST);
  assert.equal(cancelled.valid_to, PAST);
  assert.equal((await readMemberships(db, "current", { p_recruiter_id: HRP_D })).total, 0,
    "a marker is never effective");
  assert.equal((await readMemberships(db, "scheduled", { p_recruiter_id: HRP_D })).total, 0);
  assert.equal((await readMemberships(db, "history", { p_recruiter_id: HRP_D })).total, 1);

  // A raw zero-length insert outside the audited mutation path fails closed.
  const before = await counts(db);
  await assert.rejects(
    db.query("insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, valid_to)"
      + " values ($1::uuid, $2::uuid, '2026-05-01', '2026-05-01')", [HRP_D, TEAM_A]),
    (error) => error.code === "23514");
  assert.deepEqual(await counts(db), before);
});

test("idempotent replay returns the stored result and a reused key with different input conflicts", async () => {
  const version = await recruiterVersion(db, NO_MEMBERSHIP);
  // NO_MEMBERSHIP is not eligible, so use a fresh eligible person for this test.
  const recruiter = HRP_D;
  const current = await recruiterVersion(db, recruiter);
  const first = await assign(db, CATALOG, { recruiter, team: TEAM_B, from: LATER,
    version: current, key: KEY("30") });
  const before = await counts(db);
  const replay = await assign(db, CATALOG, { recruiter, team: TEAM_B, from: LATER,
    version: current, key: KEY("30") });
  assert.deepEqual(replay, first);
  assert.deepEqual(await counts(db), before, "replay adds no interval, revision, audit or reason");

  const conflict = await rpcError(db, "direct_entry_assign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiter,
    p_team_id: TEAM_A, p_valid_from: LATER, p_expected_version: current,
    p_reason: REASON, p_idempotency_key: KEY("30"),
  });
  assert.equal(conflict.code, "22023");
  assert.equal(conflict.message, "idempotency key reused with different input");
  assert.deepEqual(await counts(db), before, "a conflicting replay leaves zero residue");
  assert.equal(version >= 1, true);
});

test("a stale expected version is rejected with PT409 and leaves the intervals unchanged", async () => {
  const version = await recruiterVersion(db, HRP_D);
  const before = await counts(db);
  const stale = await rpcError(db, "direct_entry_unassign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_D,
    p_valid_to: LATER, p_expected_version: version + 9, p_reason: REASON,
    p_idempotency_key: KEY("31"),
  });
  assert.equal(stale.code, "PT409");
  assert.deepEqual(await counts(db), before, "a stale version leaves zero residue");
});

test("a back-dated change cannot rewrite an existing worker attribution", async () => {
  // The person is assigned to TEAM_A, then an entry is written for a business date
  // inside that interval; the stored entry team must stay the attribution source.
  const version = await recruiterVersion(db, ENTRY_SUBJECT);
  await assign(db, CATALOG, { recruiter: ENTRY_SUBJECT, team: TEAM_A, from: PAST, version,
    key: KEY("40") });

  await db.query("insert into public.direct_entry_projects (project_id, display_name)"
    + " values ($1, 'Synthetic Membership Project')", [PROJECT_ID]);
  await db.query("insert into public.direct_entry_candidates (candidate_id) values ($1::uuid)",
    [CANDIDATE_ID]);
  // The submission non-empty constraint trigger is DEFERRABLE INITIALLY DEFERRED, so the
  // submission and its first entry must land in the same transaction.
  await db.exec("begin");
  await db.query("insert into public.direct_entry_submissions (submission_id, created_by_user_id)"
    + " values ($1::uuid, $2::uuid)", [SUBMISSION_ID, CATALOG.app]);
  await db.query(
    "insert into public.direct_entries (entry_id, submission_id, candidate_id, created_by_user_id,"
    + " project_id, first_work_date, employee_code, worker_details, recruiter_id, team_id,"
    + " provider_type, labor_type) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::date,"
    + " 'hrp-2026-000123', $7::jsonb, $8::uuid, $9::uuid, 'hrp', 'TEMPORARY')",
    [MEMBER_ENTRY_ID, SUBMISSION_ID, CANDIDATE_ID, CATALOG.app, PROJECT_ID, ENTRY_DATE,
      JSON.stringify({ display_name: "Synthetic Entry Worker",
        date_of_birth: { state: "omitted" },
        national_id: { state: "provided", value: "100000000777" },
        address: { state: "omitted" }, phone: { state: "omitted" } }),
      ENTRY_SUBJECT, TEAM_A]);
  await db.exec("commit");

  const entryBefore = (await db.query(
    "select team_id, first_work_date::text as first_work_date, version from public.direct_entries"
    + " where entry_id = $1::uuid", [MEMBER_ENTRY_ID])).rows[0];
  const before = await counts(db);

  // A move that would resolve a different team on the entry's business date.
  const version2 = await recruiterVersion(db, ENTRY_SUBJECT);
  const blockedMove = await rpcError(db, "direct_entry_move_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: ENTRY_SUBJECT,
    p_team_id: TEAM_B, p_valid_from: "2026-01-05", p_expected_version: version2,
    p_reason: REASON, p_idempotency_key: KEY("41"),
  });
  assert.equal(blockedMove.code, "23514");

  // A back-dated unassign that would leave the entry's business date unattributed.
  const blockedUnassign = await rpcError(db, "direct_entry_unassign_team_membership", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: ENTRY_SUBJECT,
    p_valid_to: "2026-01-05", p_expected_version: version2, p_reason: REASON,
    p_idempotency_key: KEY("42"),
  });
  assert.equal(blockedUnassign.code, "23514");
  assert.deepEqual(await counts(db), before, "a blocked back-date leaves zero residue");

  // A back-dated change that does NOT alter any used business date is allowed and is
  // recorded as backdated in the bounded changed_fields.
  const allowed = await move(db, CATALOG, { recruiter: ENTRY_SUBJECT, team: TEAM_B,
    from: LATER, version: version2, key: KEY("43") });
  assert.equal(allowed.change, "MOVE");
  const audit = (await db.query(
    "select changed_fields, action from public.direct_entry_audit_events"
    + " where resource_ref = $1 and changed_fields @> array['backdated'] limit 1",
    [ENTRY_SUBJECT])).rows[0];
  assert.equal(audit.action, "team_membership_move");
  assert.equal(audit.changed_fields.includes("backdated"), true);

  const entryAfter = (await db.query(
    "select team_id, first_work_date::text as first_work_date, version from public.direct_entries"
    + " where entry_id = $1::uuid", [MEMBER_ENTRY_ID])).rows[0];
  assert.deepEqual(entryAfter, entryBefore, "the stored entry is never rewritten");
});

test("a failing audit or revision write rolls the whole membership mutation back", async () => {
  const before = await counts(db);
  const version = await recruiterVersion(db, HRP_C);
  await db.exec("create function public.test_w01cb_fail_audit() returns trigger language plpgsql as"
    + " $x$ begin raise exception 'synthetic audit failure' using errcode = '23514'; end $x$;"
    + " create trigger test_w01cb_fail_audit before insert on public.direct_entry_audit_events"
    + " for each row execute function public.test_w01cb_fail_audit();");
  try {
    const error = await rpcError(db, "direct_entry_assign_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_C,
      p_team_id: TEAM_A, p_valid_from: "2026-06-01", p_expected_version: version,
      p_reason: REASON, p_idempotency_key: KEY("50"),
    });
    assert.equal(error.code, "23514");
  } finally {
    await db.exec("drop trigger test_w01cb_fail_audit on public.direct_entry_audit_events;"
      + " drop function public.test_w01cb_fail_audit();");
  }
  assert.deepEqual(await counts(db), before, "audit failure leaves zero residue");
  assert.equal(await recruiterVersion(db, HRP_C), version, "the version is not bumped");

  await db.exec("create function public.test_w01cb_fail_revision() returns trigger language plpgsql as"
    + " $x$ begin raise exception 'synthetic revision failure' using errcode = '23514'; end $x$;"
    + " create trigger test_w01cb_fail_revision before insert"
    + " on public.direct_entry_team_membership_revisions"
    + " for each row execute function public.test_w01cb_fail_revision();");
  try {
    const error = await rpcError(db, "direct_entry_assign_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: HRP_C,
      p_team_id: TEAM_A, p_valid_from: "2026-06-01", p_expected_version: version,
      p_reason: REASON, p_idempotency_key: KEY("51"),
    });
    assert.equal(error.code, "23514");
  } finally {
    await db.exec("drop trigger test_w01cb_fail_revision"
      + " on public.direct_entry_team_membership_revisions;"
      + " drop function public.test_w01cb_fail_revision();");
  }
  assert.deepEqual(await counts(db), before, "revision failure leaves zero residue");
  assert.equal(await recruiterVersion(db, HRP_C), version, "the version is not bumped");
});

test("both catalog authority paths are allowed and audit records the real capability", async () => {
  const adminVersion = await recruiterVersion(db, HRP_E);
  await assign(db, FULL_ADMIN, { recruiter: HRP_E, team: TEAM_A, from: PAST,
    version: adminVersion, key: KEY("60") });
  const catalogVersion = await recruiterVersion(db, HRP_F);
  await assign(db, CATALOG, { recruiter: HRP_F, team: TEAM_A, from: PAST,
    version: catalogVersion, key: KEY("61") });

  const rows = (await db.query(
    "select resource_ref, capability, scope_kind, scope_team_id from public.direct_entry_audit_events"
    + " where action = 'team_membership_assign' and resource_ref = any($1::text[])",
    [[HRP_E, HRP_F]])).rows;
  const byResource = Object.fromEntries(rows.map((row) => [row.resource_ref, row]));
  assert.equal(byResource[HRP_E].capability, "entry_admin");
  assert.equal(byResource[HRP_F].capability, "catalog_master_manage");
  for (const row of rows) {
    assert.equal(row.scope_kind, "all");
    assert.equal(row.scope_team_id, null);
  }
});

test("every non-operator authority is denied with zero residue", async () => {
  const before = await counts(db);
  const denied = [
    [ENTRY_ADMIN_ONLY, "entry_admin@all alone"],
    [CATALOG_NO_ALL, "catalog capability without all scope"],
    [LEADER, "team leader"],
    [PROJECT_MANAGER, "project manager"],
    [STAFF, "staff"],
    [DISABLED_ADMIN, "disabled actor"],
    [{ auth: CATALOG.auth, app: STAFF.app }, "forged auth/app pair"],
    [{ auth: CATALOG.auth, app: MISSING_APP }, "unmapped app user"],
  ];
  for (const [actor, label] of denied) {
    const assignError = await rpcError(db, "direct_entry_assign_team_membership", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: HRP_G,
      p_team_id: TEAM_A, p_valid_from: PAST, p_expected_version: 1, p_reason: REASON,
      p_idempotency_key: KEY("70"),
    });
    assert.equal(assignError.code, "42501", label + " assign");
    const moveError = await rpcError(db, "direct_entry_move_team_membership", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: HRP_G,
      p_team_id: TEAM_B, p_valid_from: LATER, p_expected_version: 1, p_reason: REASON,
      p_idempotency_key: KEY("71"),
    });
    assert.equal(moveError.code, "42501", label + " move");
    const unassignError = await rpcError(db, "direct_entry_unassign_team_membership", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: HRP_G,
      p_valid_to: LATER, p_expected_version: 1, p_reason: REASON,
      p_idempotency_key: KEY("72"),
    });
    assert.equal(unassignError.code, "42501", label + " unassign");
    for (const state of ["current", "scheduled", "history"]) {
      const readError = await rpcError(db, "direct_entry_list_team_membership_" + state, {
        p_auth_subject: actor.auth, p_app_user_id: actor.app, p_page: 1, p_page_size: 25,
      });
      assert.equal(readError.code, "42501", label + " read " + state);
    }
  }
  assert.deepEqual(await counts(db), before, "denials leave zero residue");
});

test("the three reads are disjoint, bounded and exactly projected", async () => {
  const version = await recruiterVersion(db, HRP_G);
  const assigned = await assign(db, CATALOG, { recruiter: HRP_G, team: TEAM_A, from: PAST,
    version, key: KEY("80") });
  await move(db, CATALOG, { recruiter: HRP_G, team: TEAM_B, from: "2026-06-01",
    version: assigned.recruiter_version, key: KEY("81") });

  const current = await readMemberships(db, "current", { p_recruiter_id: HRP_G });
  const scheduled = await readMemberships(db, "scheduled", { p_recruiter_id: HRP_G });
  const history = await readMemberships(db, "history", { p_recruiter_id: HRP_G });
  assert.equal(current.total, 1);
  assert.equal(scheduled.total, 0, "post-cutover authority does not schedule future memberships");
  assert.equal(history.total, 1, "the outgoing membership remains historical");
  assert.equal(sortedKeys(current), ["authorization_date", "memberships", "page", "page_size",
    "total"].sort().join(","));
  for (const row of [current.memberships[0], history.memberships[0]]) {
    assert.equal(sortedKeys(row), PROJECTION_KEYS.join(","));
  }
  assert.equal(current.memberships[0].state, "CURRENT");
  assert.equal(current.memberships[0].team_id, TEAM_B);
  assert.equal(current.memberships[0].team_display_name, "Synthetic Membership Team B");
  assert.equal(history.memberships[0].state, "HISTORY");
  assert.equal(history.memberships[0].team_id, TEAM_A);

  // Nothing sensitive or out of contract leaks.
  const text = JSON.stringify(current) + JSON.stringify(scheduled) + JSON.stringify(history);
  for (const forbidden of [CATALOG.auth, CATALOG.app, REASON, "reason_id", "auth_subject",
    "email", "capabilit", "scope", "app_user_id"]) {
    assert.equal(text.includes(forbidden), false, "projection leaked " + forbidden);
  }

  // Bounded paging and deterministic order.
  const pageOne = await readMemberships(db, "history", { p_recruiter_id: HRP_A, p_page: 1,
    p_page_size: 1 });
  const pageTwo = await readMemberships(db, "history", { p_recruiter_id: HRP_A, p_page: 2,
    p_page_size: 1 });
  assert.equal(pageOne.memberships.length, 1);
  assert.equal(pageTwo.memberships.length, 1);
  assert.notEqual(pageOne.memberships[0].membership_id, pageTwo.memberships[0].membership_id);
  for (const args of [{ p_page: 0 }, { p_page_size: 0 }, { p_page_size: 101 },
    { p_search: "x".repeat(257) }]) {
    const error = await rpcError(db, "direct_entry_list_team_membership_current", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, ...args,
    });
    assert.equal(error.code, "22023", JSON.stringify(args));
  }
});

test("zero-length markers stay guarded after W01D widens scope and capability", async () => {
  // W01D (#71) widens the two grant interval CHECKs from ">" to ">=" and adds the
  // marker trigger, so a raw zero-length scope/capability write is still rejected
  // with 23514 exactly as it was before #70 — now by the marker guard, not the CHECK.
  const markerActor = { auth: "10000000-0000-4000-8000-0000000000d9",
    app: "20000000-0000-4000-8000-0000000000d9" };
  await addActor(db, { ...markerActor, display_name: "Synthetic Marker Actor" });

  await assert.rejects(
    db.query("insert into public.direct_entry_capability_grants"
      + " (app_user_id, capability, valid_from, valid_to) values ($1::uuid,"
      + " 'catalog_master_manage', '2026-01-01', '2026-01-01')", [markerActor.app]),
    (error) => error.code === "23514", "a zero-length capability interval stays rejected");
  await assert.rejects(
    db.query("insert into public.direct_entry_scope_grants"
      + " (app_user_id, scope_kind, valid_from, valid_to) values ($1::uuid, 'all',"
      + " '2026-01-01', '2026-01-01')", [markerActor.app]),
    (error) => error.code === "23514", "a zero-length scope interval stays rejected");

  const definitions = (await db.query(
    "select c.conname, pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " where c.conname in ('direct_entry_scope_grants_check',"
    + " 'direct_entry_capability_grants_check')")).rows;
  assert.equal(definitions.length, 2);
  for (const row of definitions) {
    assert.equal(row.definition.includes(">="), true, row.conname + " is widened by W01D #71");
  }
  const membershipCheck = (await db.query(
    "select pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " where c.conname = 'recruiter_team_memberships_check'")).rows[0].definition;
  assert.equal(membershipCheck.includes(">="), true,
    "the membership interval keeps the W01C-B >= rule");

  // The pre-existing effective predicate still authorises a normal operator, so the
  // scope/capability behaviour is unchanged rather than merely un-tested.
  const operator = { auth: "10000000-0000-4000-8000-0000000000db",
    app: "20000000-0000-4000-8000-0000000000db" };
  await addActor(db, { ...operator, display_name: "Synthetic Predicate Operator",
    capabilities: ["catalog_master_manage"], scopes: ["all"] });
  const authorised = await rpc(db, "direct_entry_list_team_membership_current", {
    p_auth_subject: operator.auth, p_app_user_id: operator.app, p_page: 1, p_page_size: 25,
  });
  assert.equal(sortedKeys(authorised), ["authorization_date", "memberships", "page", "page_size",
    "total"].sort().join(","));

  // Membership markers exist (written by the audited RPC) and none is ever effective.
  const markerCount = (await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships"
    + " where valid_to is not null and valid_to = valid_from")).rows[0].n;
  assert.equal(markerCount > 0, true, "the audited RPC writes cancellation markers");
  const effectiveMarkers = (await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships"
    + " where valid_to is not null and valid_to = valid_from"
    + " and valid_from <= public.direct_entry_authorization_date()"
    + " and (valid_to is null or public.direct_entry_authorization_date() < valid_to)")).rows[0].n;
  assert.equal(effectiveMarkers, 0, "a cancellation marker is effective on no date");
});

test("closing an existing membership stays possible after creation eligibility is gone", async () => {
  // FIX R1: revocation must not depend on creation eligibility. Each subject below
  // holds an OPEN membership that was created while it was eligible, and is then made
  // ineligible in one of the three ways T0 named.
  const subjectVersion = async (recruiterId) => recruiterVersion(db, recruiterId);

  // 1. An inactive person with an open membership.
  const inactiveVersion = await subjectVersion(HRP_E);
  const inactiveOpen = (await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships"
    + " where recruiter_id = $1::uuid and valid_to is null", [HRP_E])).rows[0].n;
  assert.equal(inactiveOpen, 1, "the prefix condition is an open membership");
  await db.query("update public.recruiters set active = false where recruiter_id = $1::uuid", [HRP_E]);

  // 2. An HRP provider membership that has since expired.
  const expiredVersion = await subjectVersion(HRP_F);
  await db.query("update public.recruiter_provider_memberships set is_current = false"
    + " where recruiter_id = $1::uuid and provider_type = 'hrp'", [HRP_F]);

  // 3. A provider that has since switched to Vendor, with a legacy business membership.
  const vendorVersion = await subjectVersion(HRP_H);
  await assign(db, CATALOG, { recruiter: HRP_H, team: TEAM_A, from: PAST, version: vendorVersion,
    key: KEY("90") });
  const legacyVersion = await subjectVersion(HRP_H);
  await db.query("update public.recruiter_provider_memberships set provider_type = 'vendor',"
    + " vendor_id = $2, is_current = false where recruiter_id = $1::uuid and provider_type = 'hrp'",
  [HRP_H, VENDOR_ID]);

  const cases = [
    [HRP_E, "inactive person", await subjectVersion(HRP_E)],
    [HRP_F, "expired HRP provider", expiredVersion],
    [HRP_H, "provider switched to Vendor", legacyVersion],
  ];
  let caseIndex = 0;
  for (const [recruiter, label, version] of cases) {
    caseIndex += 1;
    const suffix = String(caseIndex);
    // assign and move are creation paths and must still deny.
    const assignError = await rpcError(db, "direct_entry_assign_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiter,
      p_team_id: TEAM_B, p_valid_from: "2026-06-01", p_expected_version: version,
      p_reason: REASON, p_idempotency_key: KEY("f" + suffix),
    });
    assert.equal(assignError.code, "P0002", label + " assign");
    const moveError = await rpcError(db, "direct_entry_move_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiter,
      p_team_id: TEAM_B, p_valid_from: "2026-06-01", p_expected_version: version,
      p_reason: REASON, p_idempotency_key: KEY("b" + suffix),
    });
    assert.equal(moveError.code, "P0002", label + " move");

    // A stale version is still rejected without residue on the close path too.
    const beforeStale = await counts(db);
    const stale = await rpcError(db, "direct_entry_unassign_team_membership", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiter,
      p_valid_to: "2026-06-01", p_expected_version: version + 7, p_reason: REASON,
      p_idempotency_key: KEY("c" + suffix),
    });
    assert.equal(stale.code, "PT409", label + " stale close");
    assert.deepEqual(await counts(db), beforeStale, label + " stale close residue");

    // Closing the open membership succeeds, without creating anything or re-dating.
    const openBefore = (await db.query(
      "select membership_id, team_id, valid_from::text as valid_from from"
      + " public.recruiter_team_memberships where recruiter_id = $1::uuid and valid_to is null",
      [recruiter])).rows;
    assert.equal(openBefore.length, 1, label + " has exactly one open membership");
    const closed = await unassign(db, CATALOG, { recruiter, to: "2026-06-01", version,
      key: KEY("d" + suffix) });
    assert.equal(closed.change, "UNASSIGN", label);
    assert.equal(closed.membership_id, openBefore[0].membership_id, label + " closes the same row");
    assert.equal(closed.team_id, openBefore[0].team_id, label + " never changes the team");
    assert.equal(closed.valid_from, openBefore[0].valid_from, label + " never re-dates valid_from");
    assert.equal(closed.valid_to, "2026-06-01", label);
    assert.equal(closed.recruiter_version, version + 1, label + " one version bump");

    const after = (await db.query(
      "select count(*)::int as n from public.recruiter_team_memberships"
      + " where recruiter_id = $1::uuid", [recruiter])).rows[0].n;
    assert.equal(after, (await db.query(
      "select count(*)::int as n from public.recruiter_team_memberships"
      + " where recruiter_id = $1::uuid and valid_to is not null", [recruiter])).rows[0].n,
    label + " creates no new membership row");
  }

  // The inactive subject was never re-activated by closing its membership.
  const inactiveRow = (await db.query(
    "select active from public.recruiters where recruiter_id = $1::uuid", [HRP_E])).rows[0];
  assert.equal(inactiveRow.active, false, "unassign never re-activates a person");
  assert.equal(inactiveVersion >= 1 && expiredVersion >= 1, true);
});

test("migration #70 is appended once and migrations #1-#69 are untouched", async () => {
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.includes(NEW_MIGRATION), "migration #70 must exist");
  assert.ok(NEW_MIGRATION > PREVIOUS_MIGRATION, "migration #70 applies after #69");
  assert.equal(names.filter((name) => name.startsWith("20261009060000")).length, 1,
    "exactly one migration occupies the #70 slot");
  assert.equal(names.filter((name) => name.startsWith("20261009050000")).length, 1);

  const symbols = [
    "direct_entry_team_membership_revisions",
    "direct_entry_list_team_membership_current",
    "direct_entry_list_team_membership_scheduled",
    "direct_entry_list_team_membership_history",
    "direct_entry_assign_team_membership",
    "direct_entry_move_team_membership",
    "direct_entry_unassign_team_membership",
    "direct_entry_guard_membership_cancel_marker",
    "direct_entry_reject_vendor_provider_team_membership",
    "recruiter_team_memberships_open_start_uidx",
  ];
  for (const name of names) {
    if (name >= NEW_MIGRATION) continue;
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    for (const symbol of symbols) {
      assert.equal(sql.includes(symbol), false, symbol + " must not appear in " + name);
    }
  }
});

test("W01A, W01B and W01C-A contracts keep their semantics", async () => {
  const { rows: capabilityRows } = await db.query(
    "select pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace"
    + " where n.nspname = 'public' and t.relname = 'direct_entry_capability_grants'"
    + " and c.conname = 'direct_entry_capability_grants_capability_check'");
  const tokens = [...String(capabilityRows[0].definition).matchAll(/'([^']+)'::text/g)]
    .map((match) => match[1]);
  assert.equal(tokens.length, 33, "the capability vocabulary includes W01A, F1, F2, VFIN-01, duplicate CCCD, and worker history tokens");

  const personnelSnapshot = (await db.query(
    "select pg_get_function_arguments(p.oid) as args from pg_proc p"
    + " join pg_namespace n on n.oid = p.pronamespace"
    + " where n.nspname = 'public' and p.proname = 'direct_entry_personnel_snapshot'")).rows;
  assert.deepEqual(personnelSnapshot.map((row) => row.args), ["p_recruiter recruiters"]);

  for (const signature of [
    "public.direct_entry_create_team(uuid,uuid,integer,text,text,text,text)",
    "public.direct_entry_set_team_active(uuid,uuid,uuid,boolean,integer,text,text)",
    "public.direct_entry_set_personnel_active(uuid,uuid,uuid,boolean,integer,text,text)",
  ]) {
    const { rows } = await db.query(
      "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec,"
      + " has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec"
      + " from pg_proc p where p.oid = $1::regprocedure", [signature]);
    assert.deepEqual([rows[0].service_exec, rows[0].anon_exec], [true, false], signature);
  }

  // The reserved Vendor team still carries no business membership and no team scope.
  assert.equal((await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships m"
    + " join public.teams t on t.team_id = m.team_id where t.code = $1", [RESERVED_CODE])).rows[0].n,
  0);
  assert.equal((await db.query(
    "select count(*)::int as n from public.direct_entry_scope_grants g"
    + " join public.teams t on t.team_id = g.team_id where t.code = $1", [RESERVED_CODE])).rows[0].n,
  0);
});

test("HRP profile creation, catalog, and current membership list align on [valid_from, valid_to) across scheduled moves, boundary dates, and cancelled schedules", async () => {
  await db.exec("begin");
  try {
    const authDate = (await db.query(
      "select public.direct_entry_authorization_date()::text as today"
    )).rows[0].today;
    const creator = {
      auth: "10000000-0000-4000-8000-0000000000e1",
      app: "20000000-0000-4000-8000-0000000000e1",
    };
    await addActor(db, {
      ...creator,
      display_name: "Synthetic Profile Creator",
      capabilities: ["entry_admin", "entry_create", "entry_own", "submission_create"],
      scopes: ["own", "all"],
    });
    const projectId = "hrp_membership_interval_proj";
    await db.query(
      "insert into public.direct_entry_projects (project_id, display_name, active)"
      + " values ($1, 'Synthetic Interval Project', true)"
      + " on conflict (project_id) do update set active = true",
      [projectId],
    );

    const recBeforeMove = "93000000-0000-4000-8000-0000000000f1";
    const recOnBoundary = "93000000-0000-4000-8000-0000000000f2";
    const recAfterMove = "93000000-0000-4000-8000-0000000000f3";
    const recExpiredCancelled = "93000000-0000-4000-8000-0000000000f4";
    for (const [id, name, code] of [
      [recBeforeMove, "Synthetic Before Move", "before.td"],
      [recOnBoundary, "Synthetic On Boundary", "boundary.td"],
      [recAfterMove, "Synthetic After Move", "after.td"],
      [recExpiredCancelled, "Synthetic Expired Cancelled", "expired.td"],
    ]) {
      await db.query(
        "insert into public.recruiters (recruiter_id, display_name, personnel_code, active, version)"
        + " values ($1::uuid, $2, $3, true, 1)",
        [id, name, code],
      );
      await db.query(
        "insert into public.recruiter_provider_memberships"
        + " (recruiter_id, provider_type, valid_from, valid_to, vendor_id, is_current)"
        + " values ($1::uuid, 'hrp', '2020-01-01', null, null, true)",
        [id],
      );
    }

    const createProfileV2 = async (recruiterId, keySuffix, workDate = authDate) => {
      const { rows } = await db.query(
        "select public.direct_entry_create_full_profile_batch_v2("
        + " $1::uuid, $2::uuid, 'worker-profile/1.1', $3::jsonb, $4::text) as result",
        [
          creator.auth,
          creator.app,
          JSON.stringify([{
            project_id: projectId,
            first_work_date: workDate,
            recruiter_id: recruiterId,
            provider_type: "hrp",
            labor_type: "TEMPORARY",
            display_name: "Synthetic Worker " + keySuffix,
            worker_details: {
              gender: { state: "omitted" },
              date_of_birth: { state: "omitted" },
              national_id: { state: "omitted" },
              national_id_issued_at: { state: "omitted" },
              national_id_issued_place: { state: "omitted" },
              address: { state: "omitted" },
              phone: { state: "omitted" },
            },
            general_note: { state: "omitted" },
            payment: null,
            employment: null,
          }]),
          KEY(keySuffix),
        ],
      );
      return rows[0].result;
    };

    const getCatalog = async (effectiveDate = authDate) => {
      const { rows } = await db.query(
        "select public.direct_entry_input_catalog($1::uuid, $2::uuid, $3::date) as catalog",
        [creator.auth, creator.app, effectiveDate],
      );
      return rows[0].catalog;
    };

    // 1. Before scheduled move date (`valid_from = FUTURE`): old team (TEAM_A) is used.
    await db.query(
      "insert into public.recruiter_team_memberships"
      + " (recruiter_id, team_id, valid_from, valid_to, is_current) values"
      + " ($1::uuid, $2::uuid, $4::date, $5::date, true),"
      + " ($1::uuid, $3::uuid, $5::date, null, false)",
      [recBeforeMove, TEAM_A, TEAM_B, PAST, FUTURE],
    );
    const catalogToday = await getCatalog(authDate);
    const catalogRecBefore = catalogToday.recruiters.find((r) => r.recruiter_id === recBeforeMove);
    assert.ok(catalogRecBefore, "recruiter before move date appears in catalog");
    assert.equal(catalogRecBefore.team_id, TEAM_A, "before move date catalog resolves old team");
    const currentBefore = await readMemberships(db, "current", { p_recruiter_id: recBeforeMove });
    assert.equal(currentBefore.total, 1);
    assert.equal(currentBefore.memberships[0].team_id, TEAM_A);
    assert.equal(currentBefore.memberships[0].state, "CURRENT");
    const createdBefore = await createProfileV2(recBeforeMove, "71");
    const entryBefore = (await db.query(
      "select team_id from public.direct_entries where entry_id = $1::uuid",
      [createdBefore.entry_ids[0]],
    )).rows[0];
    assert.equal(entryBefore.team_id, TEAM_A, "profile created before move date uses old team");

    // 2 & 3. On the exact move boundary date (`old.valid_to = next.valid_from = authDate`):
    // Even if legacy `is_current` was still true on the outgoing row and false on the incoming row,
    // half-open `[valid_from, valid_to)` resolves exactly the new team (TEAM_B) with no gap/overlap.
    await db.query(
      "insert into public.recruiter_team_memberships"
      + " (recruiter_id, team_id, valid_from, valid_to, is_current) values"
      + " ($1::uuid, $2::uuid, $4::date, $5::date, true),"
      + " ($1::uuid, $3::uuid, $5::date, null, false)",
      [recOnBoundary, TEAM_A, TEAM_B, PAST, authDate],
    );
    const catalogBoundary = (await getCatalog(authDate)).recruiters.find(
      (r) => r.recruiter_id === recOnBoundary,
    );
    assert.ok(catalogBoundary, "recruiter on move boundary date appears in catalog");
    assert.equal(catalogBoundary.team_id, TEAM_B, "on move date (valid_from) catalog resolves new team");
    const currentBoundary = await readMemberships(db, "current", { p_recruiter_id: recOnBoundary });
    assert.equal(currentBoundary.total, 1, "boundary date never yields 0 or 2 current rows");
    assert.equal(currentBoundary.memberships[0].team_id, TEAM_B);
    assert.equal(currentBoundary.memberships[0].state, "CURRENT");
    const createdOnBoundary = await createProfileV2(recOnBoundary, "72");
    const entryOnBoundary = (await db.query(
      "select team_id from public.direct_entries where entry_id = $1::uuid",
      [createdOnBoundary.entry_ids[0]],
    )).rows[0];
    assert.equal(entryOnBoundary.team_id, TEAM_B, "profile created on move date uses new team");

    // 3b. After move date (`old.valid_to = next.valid_from = LATER < authDate`) + cancelled marker
    // (`valid_to = valid_from`) on the same recruiter: cancelled marker is inert, new team is used.
    await db.exec("select set_config('direct_entry.membership_cancel_marker', 'on', true)");
    await db.query(
      "insert into public.recruiter_team_memberships"
      + " (recruiter_id, team_id, valid_from, valid_to, is_current) values"
      + " ($1::uuid, $2::uuid, $4::date, $5::date, true),"
      + " ($1::uuid, $2::uuid, '2026-01-15'::date, '2026-01-15'::date, false),"
      + " ($1::uuid, $3::uuid, $5::date, null, false)",
      [recAfterMove, TEAM_A, TEAM_B, PAST, LATER],
    );
    const catalogAfter = (await getCatalog(authDate)).recruiters.find(
      (r) => r.recruiter_id === recAfterMove,
    );
    assert.ok(catalogAfter, "recruiter after move date appears in catalog");
    assert.equal(catalogAfter.team_id, TEAM_B, "after move date catalog resolves new team");
    const currentAfter = await readMemberships(db, "current", { p_recruiter_id: recAfterMove });
    assert.equal(currentAfter.total, 1);
    assert.equal(currentAfter.memberships[0].team_id, TEAM_B);
    assert.equal(currentAfter.memberships[0].state, "CURRENT");
    const createdAfter = await createProfileV2(recAfterMove, "73");
    const entryAfter = (await db.query(
      "select team_id from public.direct_entries where entry_id = $1::uuid",
      [createdAfter.entry_ids[0]],
    )).rows[0];
    assert.equal(entryAfter.team_id, TEAM_B, "profile created after move date uses new team");

    // 4 & 5. Expired membership (`valid_to <= authDate` with stale `is_current = true`) + cancelled
    // schedule (`valid_to = valid_from`) and no active successor:
    // - excluded from input catalog;
    // - `direct_entry_list_team_membership_current` returns `total: 0` (never a HISTORY row);
    // - profile creation fails closed with `22023: RECRUITER_MEMBERSHIP_INVALID`;
    // - raw/trigger validation fails closed with `23514: team membership missing or ambiguous`.
    await db.exec("select set_config('direct_entry.membership_cancel_marker', 'on', true)");
    await db.query(
      "insert into public.recruiter_team_memberships"
      + " (recruiter_id, team_id, valid_from, valid_to, is_current) values"
      + " ($1::uuid, $2::uuid, '2026-07-10'::date, '2026-10-31'::date, true),"
      + " ($1::uuid, $2::uuid, '2026-10-05'::date, '2026-10-05'::date, false)",
      [recExpiredCancelled, TEAM_A],
    );
    const catalogExpired = (await getCatalog(authDate)).recruiters.find(
      (r) => r.recruiter_id === recExpiredCancelled,
    );
    assert.equal(catalogExpired, undefined, "expired + cancelled schedule recruiter is excluded from catalog");
    const currentExpired = await readMemberships(db, "current", { p_recruiter_id: recExpiredCancelled });
    assert.equal(currentExpired.total, 0, "current list never returns an expired HISTORY row");
    assert.deepEqual(currentExpired.memberships, []);

    await expectMutationError(
      () => createProfileV2(recExpiredCancelled, "74"),
      "22023",
    );
    await db.exec("savepoint check_invalid_message");
    try {
      await assert.rejects(
        () => createProfileV2(recExpiredCancelled, "75"),
        (error) => error.code === "22023" && error.message === "RECRUITER_MEMBERSHIP_INVALID",
      );
    } finally {
      await db.exec("rollback to savepoint check_invalid_message; release savepoint check_invalid_message");
    }

    await db.exec("savepoint check_trigger_23514");
    try {
      await assert.rejects(
        () => db.query(
          "insert into public.direct_entries ("
          + " submission_id, candidate_id, created_by_user_id, project_id, first_work_date,"
          + " employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type"
          + ") values ("
          + " $1::uuid, $2::uuid, $3::uuid, $4, $5::date, 'hrp-2026-999991',"
          + " '{\"display_name\":\"Trigger Test\"}'::jsonb, $6::uuid, $7::uuid, 'hrp', 'TEMPORARY'"
          + ")",
          [SUBMISSION_ID, CANDIDATE_ID, FULL_ADMIN.app, PROJECT_ID, authDate, recExpiredCancelled, TEAM_A],
        ),
        (error) => error.code === "23514" && error.message === "team membership missing or ambiguous",
      );
    } finally {
      await db.exec("rollback to savepoint check_trigger_23514; release savepoint check_trigger_23514");
    }

    // 6. Verify the migration's legacy `is_current` reconciliation rule deterministically promotes
    // rolled-over moves (`recOnBoundary`, `recAfterMove`) and clears expired/cancelled markers
    // (`recExpiredCancelled`).
    const alignMigration = await readFile(
      path.join(MIGRATION_DIR, "20261103180000_hf_hrp_membership_effective_interval_alignment.sql"),
      "utf8",
    );
    const reconcileEnd = alignMigration.indexOf("$reconcile_legacy_memberships$;")
      + "$reconcile_legacy_memberships$;".length;
    await db.exec(alignMigration.slice(0, reconcileEnd));

    assert.deepEqual(
      (await db.query(
        "select team_id, is_current from public.recruiter_team_memberships"
        + " where recruiter_id = $1::uuid order by valid_from",
        [recOnBoundary],
      )).rows,
      [
        { team_id: TEAM_A, is_current: false },
        { team_id: TEAM_B, is_current: true },
      ],
      "reconciliation promotes incoming boundary row and clears expired outgoing row",
    );
    assert.deepEqual(
      (await db.query(
        "select team_id, valid_from::text as valid_from, valid_to::text as valid_to, is_current"
        + " from public.recruiter_team_memberships"
        + " where recruiter_id = $1::uuid order by valid_from, valid_to nulls last",
        [recAfterMove],
      )).rows,
      [
        { team_id: TEAM_A, valid_from: PAST, valid_to: LATER, is_current: false },
        { team_id: TEAM_A, valid_from: "2026-01-15", valid_to: "2026-01-15", is_current: false },
        { team_id: TEAM_B, valid_from: LATER, valid_to: null, is_current: true },
      ],
      "reconciliation promotes rolled-over move and keeps cancellation marker false",
    );
    assert.deepEqual(
      (await db.query(
        "select is_current from public.recruiter_team_memberships"
        + " where recruiter_id = $1::uuid order by valid_from",
        [recExpiredCancelled],
      )).rows,
      [{ is_current: false }, { is_current: false }],
      "reconciliation clears expired marker when no active successor exists",
    );
  } finally {
    await db.exec("rollback");
  }
});

test("Team Leader scheduled succession, cancellation restoration, rollover, conflict guard, leave routing, and idempotent historical reconciliation", async () => {
  await db.exec("begin");
  try {
    const { rows: dateRows } = await db.query(
      "select public.direct_entry_authorization_date()::text as today,"
      + " (public.direct_entry_authorization_date() + 7)::text as future_date,"
      + " (public.direct_entry_authorization_date() - 3)::text as past_rollover",
    );
    const today = dateRows[0].today;
    const futureDate = dateRows[0].future_date;
    const pastRollover = dateRows[0].past_rollover;

    const teamLeaderTest = "94000000-0000-4000-8000-0000000000e1";
    const teamOther = "94000000-0000-4000-8000-0000000000e2";
    await db.query(
      "insert into public.teams (team_id, code, display_name, active, version) values"
      + " ($1::uuid, 'TL_TEST_1', 'Synthetic Team Leader 1', true, 1),"
      + " ($2::uuid, 'TL_TEST_2', 'Synthetic Team Leader 2', true, 1)",
      [teamLeaderTest, teamOther],
    );

    const leader1 = {
      auth: "10000000-0000-4000-8000-0000000000f1",
      app: "20000000-0000-4000-8000-0000000000f1",
      recruiter: "93000000-0000-4000-8000-0000000000e1",
    };
    const leader2 = {
      auth: "10000000-0000-4000-8000-0000000000f2",
      app: "20000000-0000-4000-8000-0000000000f2",
      recruiter: "93000000-0000-4000-8000-0000000000e2",
    };
    const teamMember = {
      auth: "10000000-0000-4000-8000-0000000000f3",
      app: "20000000-0000-4000-8000-0000000000f3",
      recruiter: "93000000-0000-4000-8000-0000000000e3",
    };

    for (const [person, name, code] of [
      [leader1, "Nguyen The Vinh Synthetic", "vinhnt.synthetic"],
      [leader2, "Do Duc Thuan Synthetic", "thuandd.synthetic"],
      [teamMember, "Team Member Synthetic", "member.synthetic"],
    ]) {
      await addActor(db, {
        auth: person.auth,
        app: person.app,
        display_name: name,
        capabilities: ["entry_own"],
        scopes: ["own"],
      });
      await db.query(
        "insert into public.recruiters (recruiter_id, display_name, personnel_code, active, version)"
        + " values ($1::uuid, $2, $3, true, 1)",
        [person.recruiter, name, code],
      );
      await db.query(
        "insert into public.recruiter_provider_memberships"
        + " (recruiter_id, provider_type, valid_from, valid_to, vendor_id, is_current)"
        + " values ($1::uuid, 'hrp', $2::date, null, null, true)",
        [person.recruiter, PAST],
      );
      await db.query(
        "insert into public.recruiter_team_memberships"
        + " (recruiter_id, team_id, valid_from, valid_to, is_current)"
        + " values ($1::uuid, $2::uuid, $3::date, null, true)",
        [person.recruiter, teamLeaderTest, PAST],
      );
      await db.query(
        "insert into public.direct_entry_app_user_recruiter_links"
        + " (app_user_id, recruiter_id, verified, valid_from, valid_to, is_current)"
        + " values ($1::uuid, $2::uuid, true, $3::date, null, true)",
        [person.app, person.recruiter, PAST],
      );
      await db.query(
        "insert into public.leave_employee_profiles"
        + " (app_user_id, unit_kind, employment_status, work_start_date, official_effective_date, is_shared_non_employee)"
        + " values ($1::uuid, 'RECRUITMENT', 'OFFICIAL', $2::date, $2::date, false)",
        [person.app, PAST],
      );
    }

    const designateLeader = async (teamId, targetAppUserId, effectiveDate, expectedVersion, keySuffix) => {
      const { rows } = await db.query(
        "select public.direct_entry_designate_team_leader("
        + " $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::int, $7::text, $8::text) as result",
        [CATALOG.auth, CATALOG.app, teamId, targetAppUserId, effectiveDate, expectedVersion, REASON, KEY(keySuffix)],
      );
      return rows[0].result;
    };

    const revokeLeader = async (teamId, effectiveDate, expectedVersion, keySuffix) => {
      const { rows } = await db.query(
        "select public.direct_entry_revoke_team_leader("
        + " $1::uuid, $2::uuid, $3::uuid, $4::date, $5::int, $6::text, $7::text) as result",
        [CATALOG.auth, CATALOG.app, teamId, effectiveDate, expectedVersion, REASON, KEY(keySuffix)],
      );
      return rows[0].result;
    };

    const listCurrentLeaders = async (teamId) => {
      const { rows } = await db.query(
        "select public.direct_entry_list_team_leaders_current($1::uuid, $2::uuid, $3::uuid, null, 1, 25) as result",
        [CATALOG.auth, CATALOG.app, teamId],
      );
      return rows[0].result;
    };

    const expectSavepointReject = async (fn, code, message) => {
      await db.exec("savepoint tl_expect_reject");
      try {
        await assert.rejects(fn, (err) => err.code === code, message);
      } finally {
        await db.exec("rollback to savepoint tl_expect_reject; release savepoint tl_expect_reject");
      }
    };

    // 1. Designate leader1 today; verify live WP1 RPC rejects future designate/revoke, then install legacy writer for cutover fixture assertions.
    const des1 = await designateLeader(teamLeaderTest, leader1.app, PAST, 1, "81");
    assert.equal(des1.change, "designate");
    await expectSavepointReject(
      () => designateLeader(teamLeaderTest, leader2.app, futureDate, 2, "82-future-reject"),
      "22023",
      "WP1 rejects future team leader designate",
    );
    await expectSavepointReject(
      () => revokeLeader(teamLeaderTest, futureDate, 2, "82-revoke-future-reject"),
      "22023",
      "WP1 rejects future team leader revoke",
    );
    await installLegacyFutureTeamLeaderWriter(db);
    const rep1 = await designateLeader(teamLeaderTest, leader2.app, futureDate, 2, "82");
    assert.equal(rep1.change, "replace");

    // While future successor schedule is active (`today < futureDate`), predecessor `leader1` remains in effect:
    const currentDuringSchedule = await listCurrentLeaders(teamLeaderTest);
    assert.equal(currentDuringSchedule.total, 1);
    assert.equal(currentDuringSchedule.leaders[0].leader_app_user_id, leader1.app);
    assert.equal(currentDuringSchedule.leaders[0].valid_to, futureDate);

    assert.equal(
      (await db.query(
        "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, $3::uuid)::text as team_id",
        [leader1.auth, leader1.app, teamLeaderTest],
      )).rows[0].team_id,
      teamLeaderTest,
      "predecessor retains current team authority before scheduled replacement date",
    );
    await expectSavepointReject(
      () => db.query(
        "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, $3::uuid)",
        [leader2.auth, leader2.app, teamLeaderTest],
      ),
      "42501",
      "future successor does not have current team authority before valid_from",
    );

    const ctxLeader1Before = (await db.query(
      "select public.direct_entry_resolve_actor_context($1::uuid) as ctx",
      [leader1.auth],
    )).rows[0].ctx;
    assert.ok(ctxLeader1Before.capabilities.includes("team_manager_assign"));
    assert.ok(ctxLeader1Before.capabilities.includes("report_review"));
    assert.deepEqual(
      ctxLeader1Before.teams.map((t) => t.team_id),
      [teamLeaderTest],
    );
    assert.deepEqual(
      ctxLeader1Before.effective_report_review_scopes.map((s) => ({ kind: s.kind, team_id: s.team_id })),
      [{ kind: "team", team_id: teamLeaderTest }],
    );

    const leaveAuth1Before = (await db.query(
      "select public.leave_management__internal_resolve_authority($1::uuid, $2::uuid) as auth",
      [leader1.auth, leader1.app],
    )).rows[0].auth;
    const leaveAuth2Before = (await db.query(
      "select public.leave_management__internal_resolve_authority($1::uuid, $2::uuid) as auth",
      [leader2.auth, leader2.app],
    )).rows[0].auth;
    assert.equal(leaveAuth1Before.is_team_leader, true);
    assert.equal(leaveAuth2Before.is_team_leader, false);

    const routingToday = (await db.query(
      "select public.leave_management__internal_resolve_routing($1::uuid, $2::date) as route",
      [teamMember.app, today],
    )).rows[0].route;
    assert.equal(routingToday.route_kind, "TEAM_LEADER");
    assert.equal(routingToday.primary_approver_app_user_id, leader1.app);

    const routingAtFutureDate = (await db.query(
      "select public.leave_management__internal_resolve_routing($1::uuid, $2::date) as route",
      [teamMember.app, futureDate],
    )).rows[0].route;
    assert.equal(routingAtFutureDate.route_kind, "TEAM_LEADER");
    assert.equal(routingAtFutureDate.primary_approver_app_user_id, leader2.app);

    // 2. Cancel the scheduled replacement (`revoke` at `futureDate`): predecessor `leader1` is restored (`valid_to = null`).
    const rev1 = await revokeLeader(teamLeaderTest, futureDate, 3, "83");
    assert.equal(rev1.change, "revoke");
    assert.equal(rev1.valid_from, futureDate);
    assert.equal(rev1.valid_to, futureDate);

    const currentAfterCancel = await listCurrentLeaders(teamLeaderTest);
    assert.equal(currentAfterCancel.total, 1);
    assert.equal(currentAfterCancel.leaders[0].leader_app_user_id, leader1.app);
    assert.equal(currentAfterCancel.leaders[0].valid_to, null, "predecessor valid_to is restored to null");

    const leader1GrantsAfterCancel = (await db.query(
      "select capability, valid_to, is_current from public.direct_entry_capability_grants"
      + " where app_user_id = $1::uuid and capability in ('team_manager_assign', 'report_view', 'report_analytics_view', 'report_assign', 'report_review')"
      + " order by capability",
      [leader1.app],
    )).rows;
    assert.equal(leader1GrantsAfterCancel.length, 5);
    for (const grant of leader1GrantsAfterCancel) {
      assert.equal(grant.valid_to, null, `${grant.capability} valid_to restored to null`);
      assert.equal(grant.is_current, true, `${grant.capability} is_current stays true`);
    }

    const routingAfterCancelAtFutureDate = (await db.query(
      "select public.leave_management__internal_resolve_routing($1::uuid, $2::date) as route",
      [teamMember.app, futureDate],
    )).rows[0].route;
    assert.equal(routingAfterCancelAtFutureDate.route_kind, "TEAM_LEADER");
    assert.equal(routingAfterCancelAtFutureDate.primary_approver_app_user_id, leader1.app);

    // 3. When a scheduled replacement reaches its start date (`pastRollover <= today`), authority transitions to `leader2`
    // even before any mutation flips the stored `is_current` flags.
    const rep2 = await designateLeader(teamLeaderTest, leader2.app, pastRollover, 4, "84");
    assert.equal(rep2.change, "replace");

    await db.query(
      "update public.direct_entry_team_leader_assignments"
      + " set is_current = (leader_app_user_id = $2::uuid)"
      + " where team_id = $1::uuid and (valid_to is null or valid_to > valid_from)",
      [teamLeaderTest, leader1.app],
    );
    await db.query(
      "update public.direct_entry_scope_grants"
      + " set is_current = (app_user_id = $2::uuid)"
      + " where team_id = $1::uuid and scope_kind = 'team' and (valid_to is null or valid_to > valid_from)",
      [teamLeaderTest, leader1.app],
    );
    await db.query(
      "update public.direct_entry_capability_grants"
      + " set is_current = (app_user_id = $1::uuid)"
      + " where app_user_id in ($1::uuid, $2::uuid)"
      + "   and capability in ('team_manager_assign', 'report_view', 'report_analytics_view', 'report_assign', 'report_review')"
      + "   and (valid_to is null or valid_to > valid_from)",
      [leader1.app, leader2.app],
    );

    const currentAfterRollover = await listCurrentLeaders(teamLeaderTest);
    assert.equal(currentAfterRollover.total, 1);
    assert.equal(currentAfterRollover.leaders[0].leader_app_user_id, leader2.app, "rolled-over successor is now current leader");

    assert.equal(
      (await db.query(
        "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, $3::uuid)::text as team_id",
        [leader2.auth, leader2.app, teamLeaderTest],
      )).rows[0].team_id,
      teamLeaderTest,
      "successor has current team authority once valid_from <= today",
    );
    await expectSavepointReject(
      () => db.query(
        "select public.direct_entry_assert_team_leader_current_team($1::uuid, $2::uuid, $3::uuid)",
        [leader1.auth, leader1.app, teamLeaderTest],
      ),
      "42501",
      "outgoing predecessor no longer has current team authority once valid_to <= today",
    );

    const routingAfterRollover = (await db.query(
      "select public.leave_management__internal_resolve_routing($1::uuid, $2::date) as route",
      [teamMember.app, today],
    )).rows[0].route;
    assert.equal(routingAfterRollover.route_kind, "TEAM_LEADER");
    assert.equal(routingAfterRollover.primary_approver_app_user_id, leader2.app);

    // 4. Do NOT restore predecessor if predecessor has a conflicting assignment on another team (`teamOther`).
    // First schedule `leader1` to replace `leader2` at `futureDate`, then give `leader2` a conflicting team scope on `teamOther`,
    // then cancel `leader1` at `futureDate`: `leader2` must NOT be reopened to `valid_to = null`.
    const rep3 = await designateLeader(teamLeaderTest, leader1.app, futureDate, 5, "85");
    assert.equal(rep3.change, "replace");
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current)"
      + " values ($1::uuid, 'team', $2::uuid, $3::date, null, false)",
      [leader2.app, teamOther, futureDate],
    );
    const revConflict = await revokeLeader(teamLeaderTest, futureDate, 6, "86");
    assert.equal(revConflict.change, "revoke");
    const leader2ClosedRow = (await db.query(
      "select valid_to::text as valid_to from public.direct_entry_team_leader_assignments"
      + " where team_id = $1::uuid and leader_app_user_id = $2::uuid and valid_from = $3::date",
      [teamLeaderTest, leader2.app, pastRollover],
    )).rows[0];
    assert.equal(
      leader2ClosedRow.valid_to,
      futureDate,
      "predecessor is NOT reopened when a conflicting future scope/assignment exists",
    );
    await db.query(
      "delete from public.direct_entry_scope_grants where app_user_id = $1::uuid and team_id = $2::uuid",
      [leader2.app, teamOther],
    );

    // 5. Historical reconciliation (`direct_entry__internal_reconcile_cancelled_team_leaders`):
    // Simulate the pre-fix state where `revoke` at `pastRollover` left `previous_leader_recruiter_id = null`
    // and left the predecessor (`leader2`) closed at `futureDate`.
    const reconcileFirst = (await db.query(
      "select public.direct_entry__internal_reconcile_cancelled_team_leaders($1::date) as res",
      [today],
    )).rows[0].res;
    assert.equal(reconcileFirst.restored_count, 1, "historical cancelled replacement is reconciled once");

    const leader2RestoredRow = (await db.query(
      "select valid_to, is_current from public.direct_entry_team_leader_assignments"
      + " where team_id = $1::uuid and leader_app_user_id = $2::uuid and valid_from = $3::date",
      [teamLeaderTest, leader2.app, pastRollover],
    )).rows[0];
    assert.deepEqual(leader2RestoredRow, { valid_to: null, is_current: true });

    const reconcileSecond = (await db.query(
      "select public.direct_entry__internal_reconcile_cancelled_team_leaders($1::date) as res",
      [today],
    )).rows[0].res;
    assert.equal(reconcileSecond.restored_count, 0, "reconciliation is idempotent on repeated runs");
  } finally {
    await db.exec("rollback");
  }
});

