/**
 * P3.1-W01B - Personnel catalog backend (#68) DB acceptance.
 *
 * Proves the single canonical catalog-operator guard (legacy Full Admin triple OR
 * catalog_master_manage, both requiring effective all scope), the personnel data
 * contract on public.recruiters + recruiter_provider_memberships, and the
 * reason / OCC / idempotency / revision / audit / ACL invariants of migration #68.
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
const NEW_MIGRATION = "20261009040000_p3_1_w01b_personnel_catalog.sql";

const FULL_ADMIN = { auth: "10000000-0000-4000-8000-0000000000a1", app: "20000000-0000-4000-8000-0000000000a1" };
const CATALOG = { auth: "10000000-0000-4000-8000-0000000000a2", app: "20000000-0000-4000-8000-0000000000a2" };
const ENTRY_ADMIN_ONLY = { auth: "10000000-0000-4000-8000-0000000000a3", app: "20000000-0000-4000-8000-0000000000a3" };
const CATALOG_NO_ALL = { auth: "10000000-0000-4000-8000-0000000000a4", app: "20000000-0000-4000-8000-0000000000a4" };
const LEADER = { auth: "10000000-0000-4000-8000-0000000000a5", app: "20000000-0000-4000-8000-0000000000a5" };
const STAFF = { auth: "10000000-0000-4000-8000-0000000000a6", app: "20000000-0000-4000-8000-0000000000a6" };
const DISABLED_ADMIN = { auth: "10000000-0000-4000-8000-0000000000a7", app: "20000000-0000-4000-8000-0000000000a7" };
const TEAM_ID = "94000000-0000-4000-8000-0000000000b1";
const MISSING_APP = "20000000-0000-4000-8000-0000000000ff";
const VENDOR_ID = "vendor.w01b.r1";
const VENDOR_RECRUITER = "93000000-0000-4000-8000-0000000000c1";
const NO_MEMBERSHIP_RECRUITER = "93000000-0000-4000-8000-0000000000c2";
const EXPIRED_HRP_RECRUITER = "93000000-0000-4000-8000-0000000000c3";
const REASON = "Synthetic personnel catalog reason";
const KEY = (suffix) => "30000000-0000-4000-8000-0000000000" + suffix;

const RPC_PARAMS = {
  direct_entry_list_personnel_admin: ["p_auth_subject", "p_app_user_id", "p_search",
    "p_include_inactive", "p_page", "p_page_size"],
  direct_entry_get_personnel_admin: ["p_auth_subject", "p_app_user_id", "p_recruiter_id"],
  direct_entry_create_personnel: ["p_auth_subject", "p_app_user_id", "p_expected_version",
    "p_personnel_code", "p_display_name", "p_personnel_position", "p_valid_from",
    "p_reason", "p_idempotency_key"],
  direct_entry_update_personnel: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_expected_version", "p_display_name", "p_personnel_code", "p_personnel_position",
    "p_reason", "p_idempotency_key"],
  direct_entry_set_personnel_active: ["p_auth_subject", "p_app_user_id", "p_recruiter_id",
    "p_active", "p_expected_version", "p_reason", "p_idempotency_key"],
};

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
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
    [actor.app, actor.auth, actor.enabled !== false, actor.display_name ?? "Synthetic Actor"],
  );
  for (const capability of actor.capabilities ?? []) {
    await db.query(
      "insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)"
      + " values ($1::uuid, $2, '2020-01-01', true)",
      [actor.app, capability],
    );
  }
  for (const kind of actor.scopes ?? []) {
    await db.query(
      "insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)"
      + " values ($1::uuid, $2, $3::uuid, '2020-01-01', true)",
      [actor.app, kind, kind === "team" ? TEAM_ID : null],
    );
  }
}

async function seedActors(db) {
  await addActor(db, { ...FULL_ADMIN, capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"], scopes: ["all"] });
  await addActor(db, { ...CATALOG, capabilities: ["catalog_master_manage"], scopes: ["all"] });
  await addActor(db, { ...ENTRY_ADMIN_ONLY, capabilities: ["entry_admin"], scopes: ["all"] });
  await addActor(db, { ...CATALOG_NO_ALL, capabilities: ["catalog_master_manage"], scopes: ["own"] });
  await addActor(db, { ...LEADER, capabilities: ["team_manager_assign"], scopes: ["team"] });
  await addActor(db, { ...STAFF, capabilities: ["entry_own"], scopes: ["own"] });
  await addActor(db, { ...DISABLED_ADMIN, enabled: false, capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"], scopes: ["all"] });
}

async function counts(db) {
  const { rows } = await db.query(
    "select (select count(*)::int from public.recruiters) as recruiters,"
    + " (select count(*)::int from public.recruiter_provider_memberships) as memberships,"
    + " (select count(*)::int from public.direct_entry_personnel_revisions) as revisions,"
    + " (select count(*)::int from public.direct_entry_audit_events) as audits,"
    + " (select count(*)::int from public.direct_entry_restricted_reasons) as reasons,"
    + " (select count(*)::int from public.direct_entry_capability_grants) as capability_grants,"
    + " (select count(*)::int from public.direct_entry_scope_grants) as scope_grants,"
    + " (select count(*)::int from public.direct_entry_app_user_recruiter_links) as links,"
    + " (select count(*)::int from public.recruiter_team_memberships) as team_memberships,"
    + " (select count(*)::int from public.direct_entry_app_users) as app_users,"
    + " (select count(*)::int from public.direct_entry_rpc_idempotency) as idempotency",
  );
  return rows[0];
}

async function createPersonnel(db, actor, { code, name, position = "STAFF", validFrom = "2026-01-05", key = KEY("c1"), reason = REASON, expected = 0 }) {
  return rpc(db, "direct_entry_create_personnel", {
    p_auth_subject: actor.auth,
    p_app_user_id: actor.app,
    p_expected_version: expected,
    p_personnel_code: code,
    p_display_name: name,
    p_personnel_position: position,
    p_valid_from: validFrom,
    p_reason: reason,
    p_idempotency_key: key,
  });
}

const db = await database();
await db.exec("insert into public.teams (team_id, code, display_name) values ('"
  + TEAM_ID + "', 'SYNTH', 'Synthetic Team')");
await seedActors(db);

// FIX R1 fixtures: a real active Vendor with its own Vendor recruiter and an
// effective Vendor provider membership, plus two HRP-boundary controls (a
// recruiter with no provider membership at all and one whose HRP membership
// already expired). None of them belong to the W01B personnel catalog.
await db.exec("insert into public.vendors (vendor_id, display_name, active) values ('"
  + VENDOR_ID + "', 'Synthetic Vendor R1', true)");
for (const [recruiterId, displayName] of [
  [VENDOR_RECRUITER, "Synthetic Vendor Recruiter"],
  [NO_MEMBERSHIP_RECRUITER, "Synthetic No Membership"],
  [EXPIRED_HRP_RECRUITER, "Synthetic Expired HRP"],
]) {
  await db.query(
    "insert into public.recruiters (recruiter_id, display_name, active, version)"
    + " values ($1::uuid, $2, true, 1)", [recruiterId, displayName]);
}
await db.query(
  "insert into public.recruiter_provider_memberships"
  + " (recruiter_id, provider_type, valid_from, vendor_id, is_current)"
  + " values ($1::uuid, 'vendor', '2026-01-01', $2, true)",
  [VENDOR_RECRUITER, VENDOR_ID]);
await db.query(
  "insert into public.recruiter_provider_memberships"
  + " (recruiter_id, provider_type, valid_from, valid_to, vendor_id)"
  + " values ($1::uuid, 'hrp', '2020-01-01', '2021-01-01', null)",
  [EXPIRED_HRP_RECRUITER]);

const ITEM_KEYS = ["recruiter_id", "display_name", "personnel_code", "personnel_position",
  "active", "version", "hrp_valid_from", "revision_count", "team_names"];

function sortedKeys(value) {
  return Object.keys(value).sort().join(",");
}

/** FIX R1: one fixed revision schema - exactly these six keys, for every action. */
const SNAPSHOT_KEYS = ["active", "display_name", "personnel_code", "personnel_position",
  "recruiter_id", "version"].sort();

function assertSnapshotShape(snapshot, label) {
  assert.ok(snapshot, label + " snapshot must exist");
  assert.deepEqual(Object.keys(snapshot).sort(), SNAPSHOT_KEYS, label + " snapshot key set");
  assert.equal("hrp_valid_from" in snapshot, false, label + " snapshot carries no provider history");
}

test("catalog operator guard allows exactly the two authority paths", async () => {
  for (const [actor, label] of [[FULL_ADMIN, "legacy full admin"], [CATALOG, "catalog_master_manage"]]) {
    const list = await rpc(db, "direct_entry_list_personnel_admin", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app,
    });
    assert.equal(list.include_inactive, true, label);
    assert.equal(Array.isArray(list.personnel), true, label);
    assert.equal(list.page, 1, label);
    assert.equal(list.page_size, 25, label);
  }
});

test("guard denies entry_admin@all alone, missing all scope, leader, staff, disabled and unmapped actors", async () => {
  const denied = [
    [ENTRY_ADMIN_ONLY, "entry_admin@all alone"],
    [CATALOG_NO_ALL, "catalog token without all scope"],
    [LEADER, "team leader"],
    [STAFF, "staff"],
    [DISABLED_ADMIN, "disabled actor"],
    [{ auth: FULL_ADMIN.auth, app: STAFF.app }, "mismatched auth/app pair"],
    [{ auth: FULL_ADMIN.auth, app: MISSING_APP }, "unmapped app user"],
  ];
  for (const [actor, label] of denied) {
    for (const name of ["direct_entry_list_personnel_admin", "direct_entry_get_personnel_admin",
      "direct_entry_set_personnel_active"]) {
      const error = await rpcError(db, name, {
        p_auth_subject: actor.auth, p_app_user_id: actor.app, p_recruiter_id: null,
        p_active: false, p_expected_version: 1, p_reason: REASON, p_idempotency_key: KEY("d1"),
      });
      assert.ok(error, label + " / " + name + " must be denied");
      assert.equal(error.code, "42501", label + " / " + name);
    }
    const createError = await rpcError(db, "direct_entry_create_personnel", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app, p_expected_version: 0,
      p_personnel_code: "denied." + label.length, p_display_name: "Denied Actor",
      p_personnel_position: "STAFF", p_valid_from: "2026-01-05", p_reason: REASON,
      p_idempotency_key: KEY("d2"),
    });
    assert.equal(createError.code, "42501", label + " create must be denied");
  }
});

test("create writes exactly one recruiter and one HRP provider membership, and nothing else", async () => {
  const before = await counts(db);
  const result = await createPersonnel(db, CATALOG, {
    code: "nv.w01b.01", name: "Synthetic Personnel One", position: "STAFF",
    validFrom: "2026-01-05", key: KEY("01"),
  });

  assert.equal(sortedKeys(result), ["active", "created", "display_name", "hrp_valid_from",
    "personnel_code", "personnel_position", "recruiter_id", "revision_id", "version"].sort().join(","));
  assert.equal(result.created, true);
  assert.equal(result.version, 1);
  assert.equal(result.active, true);
  assert.equal(result.display_name, "Synthetic Personnel One");
  assert.equal(result.personnel_code, "nv.w01b.01");
  assert.equal(result.personnel_position, "STAFF");
  assert.equal(result.hrp_valid_from, "2026-01-05");

  const after = await counts(db);
  assert.equal(after.recruiters, before.recruiters + 1);
  assert.equal(after.memberships, before.memberships + 1);
  assert.equal(after.revisions, before.revisions + 1);
  assert.equal(after.audits, before.audits + 1);
  assert.equal(after.reasons, before.reasons + 1);
  assert.equal(after.capability_grants, before.capability_grants, "no capability grant is created");
  assert.equal(after.scope_grants, before.scope_grants, "no scope grant is created");
  assert.equal(after.links, before.links, "no recruiter link is created");
  assert.equal(after.team_memberships, before.team_memberships, "no team membership is created");
  assert.equal(after.app_users, before.app_users, "no app user is created");

  const membership = (await db.query(
    "select provider_type, vendor_id, valid_from::text as valid_from"
    + " from public.recruiter_provider_memberships where recruiter_id = $1::uuid",
    [result.recruiter_id])).rows;
  assert.equal(membership.length, 1);
  assert.equal(membership[0].provider_type, "hrp");
  assert.equal(membership[0].vendor_id, null);
  assert.equal(membership[0].valid_from, "2026-01-05");

  const revision = (await db.query(
    "select version, before_snapshot, after_snapshot, reason_id is not null as has_reason"
    + " from public.direct_entry_personnel_revisions where recruiter_id = $1::uuid",
    [result.recruiter_id])).rows;
  assert.equal(revision.length, 1);
  assert.equal(revision[0].version, 1);
  assert.equal(revision[0].before_snapshot, null);
  assert.equal(revision[0].has_reason, true);
  assertSnapshotShape(revision[0].after_snapshot, "create after");
  assert.deepEqual(revision[0].after_snapshot, {
    recruiter_id: result.recruiter_id,
    display_name: "Synthetic Personnel One",
    personnel_code: "nv.w01b.01",
    personnel_position: "STAFF",
    active: true,
    version: 1,
  });

  const audit = (await db.query(
    "select action, capability, scope_kind, outcome, changed_fields, resource_ref,"
    + " personnel_revision_id, reason_id from public.direct_entry_audit_events"
    + " where resource_ref = $1 order by created_at desc limit 1",
    [result.recruiter_id])).rows[0];
  assert.equal(audit.action, "personnel_create");
  assert.equal(audit.capability, "catalog_master_manage", "audit records the real authority");
  assert.equal(audit.scope_kind, "all");
  assert.equal(audit.outcome, "APPLIED");
  assert.deepEqual(audit.changed_fields.sort(),
    ["active", "display_name", "personnel_code", "personnel_position"]);
  assert.equal(audit.personnel_revision_id, result.revision_id);
  assert.ok(audit.reason_id);
});

test("create rejects a non-zero expected version and a non-canonical personnel code", async () => {
  const before = await counts(db);
  const wrongVersion = await rpcError(db, "direct_entry_create_personnel", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 1,
    p_personnel_code: "nv.w01b.bad", p_display_name: "Bad", p_personnel_position: "STAFF",
    p_valid_from: "2026-01-05", p_reason: REASON, p_idempotency_key: KEY("02"),
  });
  assert.equal(wrongVersion.code, "22023");

  for (const code of ["", "   ", "has space", "tab\tcode"]) {
    const error = await rpcError(db, "direct_entry_create_personnel", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
      p_personnel_code: code, p_display_name: "Bad", p_personnel_position: "STAFF",
      p_valid_from: "2026-01-05", p_reason: REASON, p_idempotency_key: KEY("03"),
    });
    assert.equal(error.code, "22023", "code shape " + JSON.stringify(code));
  }

  for (const position of ["MANAGER", "team_leader", "", null]) {
    const error = await rpcError(db, "direct_entry_create_personnel", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
      p_personnel_code: "nv.w01b.pos", p_display_name: "Bad", p_personnel_position: position,
      p_valid_from: "2026-01-05", p_reason: REASON, p_idempotency_key: KEY("04"),
    });
    assert.equal(error.code, "22023", "position " + JSON.stringify(position));
  }

  assert.deepEqual(await counts(db), before, "rejected input leaves zero residue");
});

test("duplicate personnel codes are rejected atomically on the canonical rule", async () => {
  await createPersonnel(db, CATALOG, {
    code: "nv.w01b.dup", name: "Synthetic Duplicate", key: KEY("05"),
  });
  const before = await counts(db);
  const exact = await rpcError(db, "direct_entry_create_personnel", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
    p_personnel_code: "nv.w01b.dup", p_display_name: "Duplicate", p_personnel_position: "STAFF",
    p_valid_from: "2026-01-05", p_reason: REASON, p_idempotency_key: KEY("06"),
  });
  assert.equal(exact.code, "23505");
  const caseVariant = await rpcError(db, "direct_entry_create_personnel", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
    p_personnel_code: "NV.W01B.DUP", p_display_name: "Duplicate Case", p_personnel_position: "STAFF",
    p_valid_from: "2026-01-05", p_reason: REASON, p_idempotency_key: KEY("07"),
  });
  assert.equal(caseVariant.code, "23505");
  assert.deepEqual(await counts(db), before, "duplicate create leaves zero residue");
});

test("unassigned personnel stay visible in the admin catalog with bounded search and paging", async () => {
  await createPersonnel(db, CATALOG, {
    code: "nv.w01b.unassigned", name: "Synthetic Unassigned", key: KEY("08"),
  });
  const list = await rpc(db, "direct_entry_list_personnel_admin", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app,
    p_search: "nv.w01b.unassigned", p_include_inactive: true, p_page: 1, p_page_size: 25,
  });
  assert.equal(list.total, 1);
  assert.equal(list.personnel.length, 1);
  assert.equal(sortedKeys(list.personnel[0]), ITEM_KEYS.slice().sort().join(","));
  assert.equal(list.personnel[0].personnel_code, "nv.w01b.unassigned");
  assert.equal(list.personnel[0].hrp_valid_from, "2026-01-05");
  assert.equal(list.personnel[0].revision_count, 1);
  assert.deepEqual(list.personnel[0].team_names, []);
  const teamMemberships = (await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships where recruiter_id = $1::uuid",
    [list.personnel[0].recruiter_id])).rows[0].n;
  assert.equal(teamMemberships, 0, "the listed person has no team membership");

  const firstPage = await rpc(db, "direct_entry_list_personnel_admin", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app,
    p_include_inactive: true, p_page: 1, p_page_size: 1,
  });
  const secondPage = await rpc(db, "direct_entry_list_personnel_admin", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app,
    p_include_inactive: true, p_page: 2, p_page_size: 1,
  });
  assert.equal(firstPage.personnel.length, 1);
  assert.equal(secondPage.personnel.length, 1);
  assert.notEqual(firstPage.personnel[0].recruiter_id, secondPage.personnel[0].recruiter_id);

  for (const args of [
    { p_page: 0, p_page_size: 25 },
    { p_page: 1, p_page_size: 0 },
    { p_page: 1, p_page_size: 101 },
    { p_page: 1, p_page_size: 25, p_search: "x".repeat(257) },
  ]) {
    const error = await rpcError(db, "direct_entry_list_personnel_admin", {
      p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app, ...args,
    });
    assert.equal(error.code, "22023", JSON.stringify(args));
  }

  const detail = await rpc(db, "direct_entry_get_personnel_admin", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app,
    p_recruiter_id: list.personnel[0].recruiter_id,
  });
  assert.equal(sortedKeys(detail), ITEM_KEYS.slice().sort().join(","));
  assert.equal(detail.personnel_code, "nv.w01b.unassigned");
  await db.exec("begin; savepoint personnel_team_names");
  await db.query(
    "insert into public.recruiter_team_memberships (recruiter_id,team_id,valid_from,is_current)"
      + " values ($1::uuid,$2::uuid,'2026-01-05',true)",
    [detail.recruiter_id, TEAM_ID]);
  const groupedDetail = await rpc(db, "direct_entry_get_personnel_admin", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app,
    p_recruiter_id: detail.recruiter_id,
  });
  assert.deepEqual(groupedDetail.team_names, ["Synthetic Team"]);
  await db.exec("rollback to savepoint personnel_team_names; release savepoint personnel_team_names; commit");

  const missing = await rpcError(db, "direct_entry_get_personnel_admin", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app,
    p_recruiter_id: MISSING_APP,
  });
  assert.equal(missing.code, "P0002");
});

test("update honours OCC and keeps recruiter_id plus provider history immutable", async () => {
  const created = await createPersonnel(db, CATALOG, {
    code: "nv.w01b.upd", name: "Synthetic Update Base", key: KEY("10"),
  });
  const membershipsBefore = (await db.query(
    "select membership_id, provider_type, valid_from::text as valid_from, vendor_id"
    + " from public.recruiter_provider_memberships where recruiter_id = $1::uuid",
    [created.recruiter_id])).rows;
  assert.equal(membershipsBefore.length, 1);

  const before = await counts(db);
  const stale = await rpcError(db, "direct_entry_update_personnel", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: created.recruiter_id,
    p_expected_version: created.version + 5, p_display_name: "Stale",
    p_personnel_code: "nv.w01b.stale", p_personnel_position: "STAFF",
    p_reason: REASON, p_idempotency_key: KEY("11"),
  });
  assert.equal(stale.code, "PT409");
  assert.deepEqual(await counts(db), before, "stale version leaves zero residue");

  const updated = await rpc(db, "direct_entry_update_personnel", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: created.recruiter_id,
    p_expected_version: created.version, p_display_name: "Synthetic Update Renamed",
    p_personnel_code: "nv.w01b.upd2", p_personnel_position: "TEAM_LEADER",
    p_reason: REASON, p_idempotency_key: KEY("12"),
  });
  assert.equal(updated.recruiter_id, created.recruiter_id, "recruiter_id is immutable");
  assert.equal(updated.version, created.version + 1);
  assert.equal(updated.display_name, "Synthetic Update Renamed");
  assert.equal(updated.personnel_code, "nv.w01b.upd2");
  assert.equal(updated.personnel_position, "TEAM_LEADER");
  assert.equal(updated.active, created.active);

  const membershipsAfter = (await db.query(
    "select membership_id, provider_type, valid_from::text as valid_from, vendor_id"
    + " from public.recruiter_provider_memberships where recruiter_id = $1::uuid",
    [created.recruiter_id])).rows;
  assert.deepEqual(membershipsAfter, membershipsBefore, "provider history is never rewritten");

  const audit = (await db.query(
    "select capability, changed_fields, action from public.direct_entry_audit_events"
    + " where resource_ref = $1 and action = 'personnel_update' order by created_at desc limit 1",
    [created.recruiter_id])).rows[0];
  assert.equal(audit.action, "personnel_update");
  assert.equal(audit.capability, "catalog_master_manage");
  assert.deepEqual(audit.changed_fields.sort(),
    ["display_name", "personnel_code", "personnel_position"]);

  const revision = (await db.query(
    "select before_snapshot, after_snapshot, version from public.direct_entry_personnel_revisions"
    + " where recruiter_id = $1::uuid order by version desc limit 1", [created.recruiter_id])).rows[0];
  assert.equal(revision.version, updated.version);
  assertSnapshotShape(revision.before_snapshot, "update before");
  assertSnapshotShape(revision.after_snapshot, "update after");
  assert.deepEqual(revision.before_snapshot, {
    recruiter_id: created.recruiter_id,
    display_name: "Synthetic Update Base",
    personnel_code: "nv.w01b.upd",
    personnel_position: "STAFF",
    active: true,
    version: created.version,
  });
  assert.deepEqual(revision.after_snapshot, {
    recruiter_id: created.recruiter_id,
    display_name: "Synthetic Update Renamed",
    personnel_code: "nv.w01b.upd2",
    personnel_position: "TEAM_LEADER",
    active: true,
    version: updated.version,
  });

  const noChange = await rpcError(db, "direct_entry_update_personnel", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: created.recruiter_id,
    p_expected_version: updated.version, p_display_name: "Synthetic Update Renamed",
    p_personnel_code: "nv.w01b.upd2", p_personnel_position: "TEAM_LEADER",
    p_reason: REASON, p_idempotency_key: KEY("13"),
  });
  assert.equal(noChange.code, "22023");

  const duplicate = await rpcError(db, "direct_entry_update_personnel", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: created.recruiter_id,
    p_expected_version: updated.version, p_display_name: "Duplicate Target",
    p_personnel_code: "nv.w01b.dup", p_personnel_position: "STAFF",
    p_reason: REASON, p_idempotency_key: KEY("14"),
  });
  assert.equal(duplicate.code, "23505");

  const fetched = await rpc(db, "direct_entry_get_personnel_admin", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app,
    p_recruiter_id: created.recruiter_id,
  });
  assert.equal(fetched.version, updated.version);
  assert.equal(fetched.personnel_code, "nv.w01b.upd2");
});

test("personnel_position is a catalog attribute and grants no authority", async () => {
  const leader = await createPersonnel(db, CATALOG, {
    code: "nv.w01b.leader", name: "Synthetic Leader", position: "TEAM_LEADER", key: KEY("15"),
  });
  const before = await counts(db);
  await db.query(
    "insert into public.direct_entry_app_user_recruiter_links"
    + " (app_user_id, recruiter_id, verified, valid_from, is_current)"
    + " values ($1::uuid, $2::uuid, true, '2026-01-01', true)",
    [STAFF.app, leader.recruiter_id],
  );
  const after = await counts(db);
  assert.equal(after.capability_grants, before.capability_grants,
    "TEAM_LEADER position creates no capability grant");
  assert.equal(after.scope_grants, before.scope_grants,
    "TEAM_LEADER position creates no scope grant");
  assert.equal(after.links, before.links + 1, "only the synthetic fixture link was added");

  for (const name of ["direct_entry_list_personnel_admin", "direct_entry_get_personnel_admin"]) {
    const denied = await rpcError(db, name, {
      p_auth_subject: STAFF.auth, p_app_user_id: STAFF.app, p_recruiter_id: leader.recruiter_id,
    });
    assert.equal(denied.code, "42501", "a linked leader-position actor still has no catalog authority");
  }
});

test("set-active is a soft state change that never deletes or rewrites history", async () => {
  const created = await createPersonnel(db, FULL_ADMIN, {
    code: "nv.w01b.active", name: "Synthetic Active", key: KEY("16"),
  });
  const membershipBefore = (await db.query(
    "select membership_id, valid_from::text as valid_from from public.recruiter_provider_memberships"
    + " where recruiter_id = $1::uuid", [created.recruiter_id])).rows;

  const deactivated = await rpc(db, "direct_entry_set_personnel_active", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app,
    p_recruiter_id: created.recruiter_id, p_active: false,
    p_expected_version: created.version, p_reason: REASON, p_idempotency_key: KEY("17"),
  });
  assert.equal(deactivated.active, false);
  assert.equal(deactivated.version, created.version + 1);

  const row = (await db.query(
    "select active, version from public.recruiters where recruiter_id = $1::uuid",
    [created.recruiter_id])).rows[0];
  assert.equal(row.active, false, "the recruiter row still exists after deactivation");
  assert.equal(row.version, created.version + 1);
  assert.deepEqual((await db.query(
    "select membership_id, valid_from::text as valid_from from public.recruiter_provider_memberships"
    + " where recruiter_id = $1::uuid", [created.recruiter_id])).rows, membershipBefore,
    "HRP provider history is untouched by deactivation");
  assert.equal((await db.query(
    "select is_current from public.recruiter_provider_memberships where recruiter_id = $1::uuid",
    [created.recruiter_id])).rows[0].is_current, false,
  "deactivation revokes the current provider mapping");

  const unchanged = await rpcError(db, "direct_entry_set_personnel_active", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app,
    p_recruiter_id: created.recruiter_id, p_active: false,
    p_expected_version: deactivated.version, p_reason: REASON, p_idempotency_key: KEY("18"),
  });
  assert.equal(unchanged.code, "22023");

  const stale = await rpcError(db, "direct_entry_set_personnel_active", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app,
    p_recruiter_id: created.recruiter_id, p_active: true,
    p_expected_version: created.version, p_reason: REASON, p_idempotency_key: KEY("19"),
  });
  assert.equal(stale.code, "PT409");

  const reactivated = await rpc(db, "direct_entry_set_personnel_active", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app,
    p_recruiter_id: created.recruiter_id, p_active: true,
    p_expected_version: deactivated.version, p_reason: REASON, p_idempotency_key: KEY("1a"),
  });
  assert.equal(reactivated.active, true);
  assert.equal(reactivated.version, created.version + 2);
  assert.equal((await db.query(
    "select is_current from public.recruiter_provider_memberships where recruiter_id = $1::uuid",
    [created.recruiter_id])).rows[0].is_current, true,
  "explicit activation restores only the open provider mapping");

  const revisions = (await db.query(
    "select version from public.direct_entry_personnel_revisions where recruiter_id = $1::uuid"
    + " order by version", [created.recruiter_id])).rows.map((r) => r.version);
  assert.deepEqual(revisions, [1, 2, 3], "every mutation appended exactly one revision");

  const setActiveRevisions = (await db.query(
    "select version, before_snapshot, after_snapshot from public.direct_entry_personnel_revisions"
    + " where recruiter_id = $1::uuid and version > 1 order by version",
    [created.recruiter_id])).rows;
  assert.equal(setActiveRevisions.length, 2);
  for (const row of setActiveRevisions) {
    assertSnapshotShape(row.before_snapshot, "set-active before v" + row.version);
    assertSnapshotShape(row.after_snapshot, "set-active after v" + row.version);
    assert.equal(row.before_snapshot.active, row.version === 2);
    assert.equal(row.after_snapshot.active, row.version === 3);
    assert.equal(row.after_snapshot.version, row.version);
  }

  const audit = (await db.query(
    "select capability, changed_fields from public.direct_entry_audit_events"
    + " where resource_ref = $1 and action = 'personnel_set_active' order by created_at desc limit 1",
    [created.recruiter_id])).rows[0];
  assert.equal(audit.capability, "entry_admin", "legacy full admin is labelled entry_admin");
  assert.deepEqual(audit.changed_fields, ["active"]);
});

test("audit records the authority actually exercised and reasons stay restricted", async () => {
  const asCatalog = await createPersonnel(db, CATALOG, {
    code: "nv.w01b.audit1", name: "Audit One", key: KEY("20"),
  });
  const asAdmin = await createPersonnel(db, FULL_ADMIN, {
    code: "nv.w01b.audit2", name: "Audit Two", key: KEY("21"),
  });
  const audits = (await db.query(
    "select resource_ref, capability, scope_kind, reason_id from public.direct_entry_audit_events"
    + " where action = 'personnel_create' and resource_ref = any($1::text[])",
    [[asCatalog.recruiter_id, asAdmin.recruiter_id]])).rows;
  const byResource = Object.fromEntries(audits.map((row) => [row.resource_ref, row]));
  assert.equal(byResource[asCatalog.recruiter_id].capability, "catalog_master_manage");
  assert.equal(byResource[asAdmin.recruiter_id].capability, "entry_admin");
  for (const row of audits) assert.equal(row.scope_kind, "all");

  const reason = (await db.query(
    "select reason_text from public.direct_entry_restricted_reasons where reason_id = $1::uuid",
    [byResource[asCatalog.recruiter_id].reason_id])).rows[0];
  assert.equal(reason.reason_text, REASON,
    "the raw reason is stored only in the restricted reason row");

  const snapshots = (await db.query(
    "select before_snapshot, after_snapshot from public.direct_entry_personnel_revisions"
    + " where recruiter_id = any($1::uuid[])",
    [[asCatalog.recruiter_id, asAdmin.recruiter_id]])).rows;
  for (const row of snapshots) {
    for (const snapshot of [row.before_snapshot, row.after_snapshot]) {
      if (snapshot === null) continue;
      assertSnapshotShape(snapshot, "audited");
    }
  }
});

test("idempotent replay returns the same result and a reused key with different input conflicts", async () => {
  const first = await createPersonnel(db, CATALOG, {
    code: "nv.w01b.idem", name: "Synthetic Idempotent", key: KEY("30"),
  });
  const before = await counts(db);
  const replay = await createPersonnel(db, CATALOG, {
    code: "nv.w01b.idem", name: "Synthetic Idempotent", key: KEY("30"),
  });
  assert.deepEqual(replay, first);
  assert.deepEqual(await counts(db), before, "replay adds no row, revision, audit or reason");

  const conflict = await rpcError(db, "direct_entry_create_personnel", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
    p_personnel_code: "nv.w01b.idem", p_display_name: "Different Payload",
    p_personnel_position: "STAFF", p_valid_from: "2026-01-05", p_reason: REASON,
    p_idempotency_key: KEY("30"),
  });
  assert.equal(conflict.code, "22023");
  assert.equal(conflict.message, "idempotency key reused with different input");
  assert.deepEqual(await counts(db), before, "a conflicting replay leaves zero residue");

  const deactivated = await rpc(db, "direct_entry_set_personnel_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_recruiter_id: first.recruiter_id, p_active: false, p_expected_version: first.version,
    p_reason: REASON, p_idempotency_key: KEY("31"),
  });
  const afterDeactivate = await counts(db);
  const deactivateReplay = await rpc(db, "direct_entry_set_personnel_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_recruiter_id: first.recruiter_id, p_active: false, p_expected_version: first.version,
    p_reason: REASON, p_idempotency_key: KEY("31"),
  });
  assert.deepEqual(deactivateReplay, deactivated);
  assert.deepEqual(await counts(db), afterDeactivate);
});

test("a failing audit or revision write rolls the whole mutation back", async () => {
  const before = await counts(db);
  await db.exec("create function public.test_w01b_fail_audit() returns trigger language plpgsql as"
    + " $x$ begin raise exception 'synthetic audit failure' using errcode = '23514'; end $x$;"
    + " create trigger test_w01b_fail_audit before insert on public.direct_entry_audit_events"
    + " for each row execute function public.test_w01b_fail_audit();");
  try {
    const error = await rpcError(db, "direct_entry_create_personnel", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
      p_personnel_code: "nv.w01b.rollback1", p_display_name: "Rollback One",
      p_personnel_position: "STAFF", p_valid_from: "2026-01-05", p_reason: REASON,
      p_idempotency_key: KEY("40"),
    });
    assert.equal(error.code, "23514");
  } finally {
    await db.exec("drop trigger test_w01b_fail_audit on public.direct_entry_audit_events;"
      + " drop function public.test_w01b_fail_audit();");
  }
  assert.deepEqual(await counts(db), before, "audit failure leaves zero residue");

  await db.exec("create function public.test_w01b_fail_revision() returns trigger language plpgsql as"
    + " $x$ begin raise exception 'synthetic revision failure' using errcode = '23514'; end $x$;"
    + " create trigger test_w01b_fail_revision before insert on public.direct_entry_personnel_revisions"
    + " for each row execute function public.test_w01b_fail_revision();");
  try {
    const error = await rpcError(db, "direct_entry_create_personnel", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
      p_personnel_code: "nv.w01b.rollback2", p_display_name: "Rollback Two",
      p_personnel_position: "STAFF", p_valid_from: "2026-01-05", p_reason: REASON,
      p_idempotency_key: KEY("41"),
    });
    assert.equal(error.code, "23514");
  } finally {
    await db.exec("drop trigger test_w01b_fail_revision on public.direct_entry_personnel_revisions;"
      + " drop function public.test_w01b_fail_revision();");
  }
  assert.deepEqual(await counts(db), before, "revision failure leaves zero residue");
});

test("admin projections never leak authority, identity or the raw reason", async () => {
  const created = await createPersonnel(db, CATALOG, {
    code: "nv.w01b.leak", name: "Synthetic Leak Check", key: KEY("50"),
  });
  const list = await rpc(db, "direct_entry_list_personnel_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_search: "nv.w01b.leak",
  });
  const detail = await rpc(db, "direct_entry_get_personnel_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_recruiter_id: created.recruiter_id,
  });
  const text = JSON.stringify(list) + JSON.stringify(detail) + JSON.stringify(created);
  for (const forbidden of [CATALOG.auth, CATALOG.app, FULL_ADMIN.app, "catalog_master_manage",
    "entry_admin", "team_master_manage", REASON, "reason_id", "app_user_id", "auth_subject",
    "email", "scope", "capabilit", "provider_membership"]) {
    assert.equal(text.includes(forbidden), false, "projection leaked " + forbidden);
  }
  assert.equal(sortedKeys(list), ["authorization_date", "include_inactive", "page", "page_size",
    "personnel", "search", "total"].sort().join(","));
});

test("service-role only EXECUTE, revoked helpers, forced RLS and immutability", async () => {
  const rpcs = [
    "public.direct_entry_list_personnel_admin(uuid,uuid,text,boolean,integer,integer)",
    "public.direct_entry_get_personnel_admin(uuid,uuid,uuid)",
    "public.direct_entry_create_personnel(uuid,uuid,integer,text,text,text,date,text,text)",
    "public.direct_entry_update_personnel(uuid,uuid,uuid,integer,text,text,text,text,text)",
    "public.direct_entry_set_personnel_active(uuid,uuid,uuid,boolean,integer,text,text)",
  ];
  for (const signature of rpcs) {
    const { rows } = await db.query(
      "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec,"
      + " has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec,"
      + " has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth_exec,"
      + " p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') as config"
      + " from pg_proc p where p.oid = $1::regprocedure", [signature]);
    assert.equal(rows.length, 1, signature);
    assert.deepEqual([rows[0].service_exec, rows[0].anon_exec, rows[0].auth_exec],
      [true, false, false], signature);
    assert.equal(rows[0].prosecdef, true, signature);
    assert.equal(rows[0].config.includes("search_path=pg_catalog, public"), true, signature);
  }

  const helpers = [
    "public.direct_entry_assert_catalog_operator(uuid,uuid)",
    "public.direct_entry_lock_personnel(uuid,integer)",
    "public.direct_entry_personnel_snapshot(public.recruiters)",
    "public.direct_entry_personnel_admin_projection(public.recruiters,date,integer)",
    "public.direct_entry_write_personnel_revision(uuid,integer,uuid,uuid,jsonb,jsonb)",
    "public.direct_entry_bump_personnel_version(uuid,uuid,uuid,jsonb,jsonb)",
  ];
  for (const signature of helpers) {
    const { rows } = await db.query(
      "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec,"
      + " has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec,"
      + " has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth_exec"
      + " from pg_proc p where p.oid = $1::regprocedure", [signature]);
    assert.deepEqual([rows[0].service_exec, rows[0].anon_exec, rows[0].auth_exec],
      [false, false, false], signature);
  }

  const table = "public.direct_entry_personnel_revisions";
  const { rows } = await db.query(
    "select c.relrowsecurity, c.relforcerowsecurity,"
    + " has_table_privilege('service_role', c.oid, 'SELECT') as service_select,"
    + " has_table_privilege('anon', c.oid, 'SELECT') as anon_select,"
    + " has_table_privilege('authenticated', c.oid, 'INSERT') as auth_insert"
    + " from pg_class c join pg_namespace n on n.oid = c.relnamespace"
    + " where n.nspname = 'public' and c.oid = $1::regclass", [table]);
  assert.deepEqual(rows[0], { relrowsecurity: true, relforcerowsecurity: true,
    service_select: false, anon_select: false, auth_insert: false });

  const immutable = await rpcError(db, "direct_entry_get_personnel_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: null,
  });
  assert.equal(immutable.code, "22023");
  await assert.rejects(
    db.exec("update public.direct_entry_personnel_revisions set version = version"),
    (error) => error.code === "55000",
  );
  await assert.rejects(
    db.exec("delete from public.direct_entry_personnel_revisions"),
    (error) => error.code === "55000",
  );
});

test("migration #68 remains unique and the current capability vocabulary has 33 tokens", async () => {
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.includes(NEW_MIGRATION), "migration #68 must exist");
  assert.ok(NEW_MIGRATION > "20261009030000_p3_1_w01a_capability_contract_foundation.sql",
    "migration #68 must apply after W01A");
  assert.equal(names.filter((name) => name.startsWith("20261009040000")).length, 1,
    "exactly one migration occupies the #68 slot");

  const { rows } = await db.query(
    "select pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace"
    + " where n.nspname = 'public' and t.relname = 'direct_entry_capability_grants'"
    + " and c.conname = 'direct_entry_capability_grants_capability_check'");
  const tokens = [...String(rows[0].definition).matchAll(/'([^']+)'::text/g)].map((m) => m[1]);
  assert.equal(tokens.length, 33, "the capability vocabulary includes W01A, F1, F2, VFIN-01, duplicate CCCD, and worker history tokens");
  assert.ok(tokens.includes("catalog_master_manage"));
  assert.ok(tokens.includes("team_manager_assign"));

  const { rows: functionRows } = await db.query(
    "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace"
    + " where n.nspname = 'public' and p.proname like '%personnel%'");
  assert.equal(functionRows[0].n, 12, "the personnel surface is exactly the reviewed set");
});

test("the admin personnel catalog excludes Vendor recruiters from list, count and detail", async () => {
  const list = await rpc(db, "direct_entry_list_personnel_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_search: "Synthetic Vendor Recruiter", p_include_inactive: true,
    p_page: 1, p_page_size: 25,
  });
  assert.equal(list.total, 0, "a Vendor recruiter is never counted");
  assert.equal(list.personnel.length, 0, "a Vendor recruiter is never listed");

  const all = await rpc(db, "direct_entry_list_personnel_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_include_inactive: true, p_page: 1, p_page_size: 100,
  });
  const ids = all.personnel.map((row) => row.recruiter_id);
  for (const excluded of [VENDOR_RECRUITER, NO_MEMBERSHIP_RECRUITER, EXPIRED_HRP_RECRUITER]) {
    assert.equal(ids.includes(excluded), false, "excluded recruiter " + excluded);
  }

  const detail = await rpcError(db, "direct_entry_get_personnel_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_recruiter_id: VENDOR_RECRUITER,
  });
  assert.equal(detail.code, "P0002");

  // An HRP person with no team membership is still part of the catalog.
  const unassigned = await rpc(db, "direct_entry_list_personnel_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_search: "nv.w01b.unassigned", p_include_inactive: true, p_page: 1, p_page_size: 25,
  });
  assert.equal(unassigned.total, 1);
  const teamMemberships = (await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships where recruiter_id = $1::uuid",
    [unassigned.personnel[0].recruiter_id])).rows[0].n;
  assert.equal(teamMemberships, 0);
});

test("Vendor and non-HRP recruiters are rejected with zero residue and unchanged rows", async () => {
  const rowsBefore = (await db.query(
    "select * from public.recruiters where recruiter_id = any($1::uuid[]) order by recruiter_id",
    [[VENDOR_RECRUITER, NO_MEMBERSHIP_RECRUITER, EXPIRED_HRP_RECRUITER]])).rows;
  const membershipsBefore = (await db.query(
    "select * from public.recruiter_provider_memberships"
    + " where recruiter_id = any($1::uuid[]) order by recruiter_id, valid_from",
    [[VENDOR_RECRUITER, EXPIRED_HRP_RECRUITER]])).rows;
  const vendorBefore = (await db.query(
    "select * from public.vendors where vendor_id = $1", [VENDOR_ID])).rows[0];
  const before = await counts(db);

  for (const recruiterId of [VENDOR_RECRUITER, NO_MEMBERSHIP_RECRUITER, EXPIRED_HRP_RECRUITER]) {
    const read = await rpcError(db, "direct_entry_get_personnel_admin", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiterId,
    });
    assert.equal(read.code, "P0002", "get " + recruiterId);

    const update = await rpcError(db, "direct_entry_update_personnel", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiterId,
      p_expected_version: 1, p_display_name: "Hijacked", p_personnel_code: "nv.hijack",
      p_personnel_position: "STAFF", p_reason: REASON, p_idempotency_key: KEY("70"),
    });
    assert.equal(update.code, "P0002", "update " + recruiterId);

    const active = await rpcError(db, "direct_entry_set_personnel_active", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_recruiter_id: recruiterId,
      p_active: false, p_expected_version: 1, p_reason: REASON, p_idempotency_key: KEY("71"),
    });
    assert.equal(active.code, "P0002", "set-active " + recruiterId);
  }

  assert.deepEqual(await counts(db), before,
    "no revision, audit, reason or idempotency residue after the rejections");
  assert.deepEqual((await db.query(
    "select * from public.recruiters where recruiter_id = any($1::uuid[]) order by recruiter_id",
    [[VENDOR_RECRUITER, NO_MEMBERSHIP_RECRUITER, EXPIRED_HRP_RECRUITER]])).rows, rowsBefore,
    "recruiter rows are byte/value equivalent");
  assert.deepEqual((await db.query(
    "select * from public.recruiter_provider_memberships"
    + " where recruiter_id = any($1::uuid[]) order by recruiter_id, valid_from",
    [[VENDOR_RECRUITER, EXPIRED_HRP_RECRUITER]])).rows, membershipsBefore,
    "provider memberships are byte/value equivalent");
  assert.deepEqual((await db.query(
    "select * from public.vendors where vendor_id = $1", [VENDOR_ID])).rows[0], vendorBefore,
    "Vendor history is untouched");
  assert.equal((await db.query(
    "select count(*)::int as n from public.direct_entry_personnel_revisions"
    + " where recruiter_id = any($1::uuid[])",
    [[VENDOR_RECRUITER, NO_MEMBERSHIP_RECRUITER, EXPIRED_HRP_RECRUITER]])).rows[0].n, 0);
});

test("create requires an explicit valid_from and never invents a provider start date", async () => {
  const before = await counts(db);
  const missing = await rpcError(db, "direct_entry_create_personnel", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
    p_personnel_code: "nv.w01b.validfrom", p_display_name: "Missing Valid From",
    p_personnel_position: "STAFF", p_valid_from: null, p_reason: REASON,
    p_idempotency_key: KEY("60"),
  });
  assert.equal(missing.code, "22023");
  assert.equal(missing.message, "provider valid from required");

  const future = await rpcError(db, "direct_entry_create_personnel", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
    p_personnel_code: "nv.w01b.future", p_display_name: "Future Valid From",
    p_personnel_position: "STAFF", p_valid_from: "2999-01-01", p_reason: REASON,
    p_idempotency_key: KEY("61"),
  });
  assert.equal(future.code, "22023");

  const malformed = await rpcError(db, "direct_entry_create_personnel", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
    p_personnel_code: "nv.w01b.malformed", p_display_name: "Malformed Valid From",
    p_personnel_position: "STAFF", p_valid_from: "not-a-date", p_reason: REASON,
    p_idempotency_key: KEY("62"),
  });
  // The API layer additionally enforces strict YYYY-MM-DD before the RPC is reached.
  assert.ok(malformed, "a malformed date must fail");
  assert.deepEqual(await counts(db), before,
    "invalid valid_from leaves zero residue and creates no provider membership");
});
