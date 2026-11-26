/**
 * P3.1-W01C-A - Team master catalog backend (#69) DB acceptance.
 *
 * Proves the single catalog guard reused from #68, the team master contract over
 * public.teams, the reserved __system_vendor__ boundary, and the
 * reason / OCC / idempotency / revision / audit / ACL invariants of migration #69.
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
const NEW_MIGRATION = "20261009050000_p3_1_w01c_a_team_catalog.sql";
const PREVIOUS_MIGRATION = "20261009040000_p3_1_w01b_personnel_catalog.sql";

const FULL_ADMIN = { auth: "10000000-0000-4000-8000-0000000000b1", app: "20000000-0000-4000-8000-0000000000b1" };
const CATALOG = { auth: "10000000-0000-4000-8000-0000000000b2", app: "20000000-0000-4000-8000-0000000000b2" };
const ENTRY_ADMIN_ONLY = { auth: "10000000-0000-4000-8000-0000000000b3", app: "20000000-0000-4000-8000-0000000000b3" };
const CATALOG_NO_ALL = { auth: "10000000-0000-4000-8000-0000000000b4", app: "20000000-0000-4000-8000-0000000000b4" };
const LEADER = { auth: "10000000-0000-4000-8000-0000000000b5", app: "20000000-0000-4000-8000-0000000000b5" };
const STAFF = { auth: "10000000-0000-4000-8000-0000000000b6", app: "20000000-0000-4000-8000-0000000000b6" };
const DISABLED_ADMIN = { auth: "10000000-0000-4000-8000-0000000000b7", app: "20000000-0000-4000-8000-0000000000b7" };
const TEAM_FIXTURE_ID = "94000000-0000-4000-8000-0000000000e1";
const MISSING_TEAM = "94000000-0000-4000-8000-0000000000ff";
const MISSING_APP = "20000000-0000-4000-8000-0000000000ff";
const RESERVED_CODE = "__system_vendor__";
const REASON = "Synthetic team catalog reason";
const KEY = (suffix) => "40000000-0000-4000-8000-0000000000" + suffix;

const RPC_PARAMS = {
  direct_entry_list_teams_admin: ["p_auth_subject", "p_app_user_id", "p_search",
    "p_include_inactive", "p_page", "p_page_size"],
  direct_entry_get_team_admin: ["p_auth_subject", "p_app_user_id", "p_team_id"],
  direct_entry_create_team: ["p_auth_subject", "p_app_user_id", "p_expected_version",
    "p_code", "p_display_name", "p_reason", "p_idempotency_key"],
  direct_entry_update_team: ["p_auth_subject", "p_app_user_id", "p_team_id",
    "p_expected_version", "p_display_name", "p_reason", "p_idempotency_key"],
  direct_entry_set_team_active: ["p_auth_subject", "p_app_user_id", "p_team_id",
    "p_active", "p_expected_version", "p_reason", "p_idempotency_key"],
};

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql").sort();
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
      [actor.app, kind, kind === "team" ? TEAM_FIXTURE_ID : null],
    );
  }
}

async function counts(db) {
  const { rows } = await db.query(
    "select (select count(*)::int from public.teams) as teams,"
    + " (select count(*)::int from public.direct_entry_team_revisions) as revisions,"
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

const ITEM_KEYS = ["team_id", "code", "display_name", "active", "version", "revision_count"];
const SNAPSHOT_KEYS = ["team_id", "code", "display_name", "active", "version"].sort();

function sortedKeys(value) {
  return Object.keys(value).sort().join(",");
}

/** FIX: one fixed revision schema - exactly these five keys, for every action. */
function assertSnapshotShape(snapshot, label) {
  assert.ok(snapshot, label + " snapshot must exist");
  assert.deepEqual(Object.keys(snapshot).sort(), SNAPSHOT_KEYS, label + " snapshot key set");
}

async function createTeam(db, actor, { code, name, key = KEY("c1"), reason = REASON, expected = 0 }) {
  return rpc(db, "direct_entry_create_team", {
    p_auth_subject: actor.auth,
    p_app_user_id: actor.app,
    p_expected_version: expected,
    p_code: code,
    p_display_name: name,
    p_reason: reason,
    p_idempotency_key: key,
  });
}

const db = await database();
await db.exec("insert into public.teams (team_id, code, display_name, active) values ('"
  + TEAM_FIXTURE_ID + "', 'FX_TEAM', 'Synthetic Fixture Team', true)");
// The reserved Vendor system team is created exactly as the canonical #65 helper
// would create it: identified by its reserved CODE, never by a hard-coded UUID.
await db.exec("insert into public.teams (code, display_name, active) values ('"
  + RESERVED_CODE + "', 'Vendor', true)");
await addActor(db, { ...FULL_ADMIN, display_name: "Synthetic Full Admin",
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: ["all"] });
await addActor(db, { ...CATALOG, capabilities: ["catalog_master_manage"], scopes: ["all"] });
await addActor(db, { ...ENTRY_ADMIN_ONLY, capabilities: ["entry_admin"], scopes: ["all"] });
await addActor(db, { ...CATALOG_NO_ALL, capabilities: ["catalog_master_manage"], scopes: ["own"] });
await addActor(db, { ...LEADER, capabilities: ["team_manager_assign"], scopes: ["team"] });
await addActor(db, { ...STAFF, capabilities: ["entry_own"], scopes: ["own"] });
await addActor(db, { ...DISABLED_ADMIN, enabled: false, capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"], scopes: ["all"] });

test("both catalog authority paths can read the team catalog", async () => {
  for (const [actor, label] of [[FULL_ADMIN, "legacy full admin"], [CATALOG, "catalog_master_manage"]]) {
    const list = await rpc(db, "direct_entry_list_teams_admin", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app,
    });
    assert.equal(list.include_inactive, true, label);
    assert.equal(Array.isArray(list.teams), true, label);
    assert.equal(list.page, 1, label);
    assert.equal(list.page_size, 25, label);
  }
});

test("the guard denies every non-operator authority without residue", async () => {
  const before = await counts(db);
  const denied = [
    [ENTRY_ADMIN_ONLY, "entry_admin@all alone"],
    [CATALOG_NO_ALL, "catalog token without all scope"],
    [LEADER, "team leader"],
    [STAFF, "staff"],
    [DISABLED_ADMIN, "disabled actor"],
    [{ auth: FULL_ADMIN.auth, app: STAFF.app }, "forged auth/app pair"],
    [{ auth: FULL_ADMIN.auth, app: MISSING_APP }, "unmapped app user"],
  ];
  for (const [actor, label] of denied) {
    for (const name of ["direct_entry_list_teams_admin", "direct_entry_get_team_admin",
      "direct_entry_set_team_active"]) {
      const error = await rpcError(db, name, {
        p_auth_subject: actor.auth, p_app_user_id: actor.app, p_team_id: TEAM_FIXTURE_ID,
        p_active: false, p_expected_version: 1, p_reason: REASON, p_idempotency_key: KEY("d1"),
      });
      assert.ok(error, label + " / " + name + " must be denied");
      assert.equal(error.code, "42501", label + " / " + name);
    }
    const createError = await rpcError(db, "direct_entry_create_team", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app, p_expected_version: 0,
      p_code: "DENIED_" + label.length, p_display_name: "Denied Team", p_reason: REASON,
      p_idempotency_key: KEY("d2"),
    });
    assert.equal(createError.code, "42501", label + " create must be denied");
  }
  assert.deepEqual(await counts(db), before, "denials leave zero residue");
});

test("create writes exactly one team row with the contract shape", async () => {
  const before = await counts(db);
  const result = await createTeam(db, CATALOG, { code: "TEAM_ALPHA", name: "Synthetic Alpha", key: KEY("01") });

  assert.equal(sortedKeys(result), ["active", "code", "created", "display_name", "revision_id",
    "team_id", "version"].sort().join(","));
  assert.equal(result.created, true);
  assert.equal(result.version, 1);
  assert.equal(result.active, true);
  assert.equal(result.code, "TEAM_ALPHA");
  assert.equal(result.display_name, "Synthetic Alpha");

  const after = await counts(db);
  assert.equal(after.teams, before.teams + 1);
  assert.equal(after.revisions, before.revisions + 1);
  assert.equal(after.audits, before.audits + 1);
  assert.equal(after.reasons, before.reasons + 1);
  assert.equal(after.capability_grants, before.capability_grants, "no capability grant");
  assert.equal(after.scope_grants, before.scope_grants, "no scope grant");
  assert.equal(after.links, before.links, "no recruiter link");
  assert.equal(after.team_memberships, before.team_memberships, "no team membership");
  assert.equal(after.app_users, before.app_users, "no app user");

  const row = (await db.query(
    "select code, display_name, active, version from public.teams where team_id = $1::uuid",
    [result.team_id])).rows[0];
  assert.deepEqual(row, { code: "TEAM_ALPHA", display_name: "Synthetic Alpha", active: true, version: 1 });

  const revision = (await db.query(
    "select version, before_snapshot, after_snapshot from public.direct_entry_team_revisions"
    + " where team_id = $1::uuid", [result.team_id])).rows[0];
  assert.equal(revision.version, 1);
  assert.equal(revision.before_snapshot, null);
  assertSnapshotShape(revision.after_snapshot, "create after");
  assert.deepEqual(revision.after_snapshot, {
    team_id: result.team_id, code: "TEAM_ALPHA", display_name: "Synthetic Alpha",
    active: true, version: 1,
  });

  const audit = (await db.query(
    "select action, capability, scope_kind, outcome, changed_fields, team_revision_id, reason_id"
    + " from public.direct_entry_audit_events where resource_ref = $1 order by created_at desc limit 1",
    [result.team_id])).rows[0];
  assert.equal(audit.action, "team_create");
  assert.equal(audit.capability, "catalog_master_manage", "audit records the real authority");
  assert.equal(audit.scope_kind, "all");
  assert.equal(audit.outcome, "APPLIED");
  assert.deepEqual(audit.changed_fields.sort(), ["active", "code", "display_name"]);
  assert.equal(audit.team_revision_id, result.revision_id);
  assert.ok(audit.reason_id);
});

test("create rejects a non-zero expected version, a non-canonical code and the reserved code", async () => {
  const before = await counts(db);
  const wrongVersion = await rpcError(db, "direct_entry_create_team", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 1,
    p_code: "TEAM_BAD", p_display_name: "Bad", p_reason: REASON, p_idempotency_key: KEY("02"),
  });
  assert.equal(wrongVersion.code, "22023");

  for (const code of ["", "   ", "has space", "tab\tcode", RESERVED_CODE, " " + RESERVED_CODE]) {
    const error = await rpcError(db, "direct_entry_create_team", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
      p_code: code, p_display_name: "Bad", p_reason: REASON, p_idempotency_key: KEY("03"),
    });
    assert.equal(error.code, "22023", "code " + JSON.stringify(code));
  }
  const longName = await rpcError(db, "direct_entry_create_team", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
    p_code: "TEAM_LONG", p_display_name: "x".repeat(257), p_reason: REASON,
    p_idempotency_key: KEY("04"),
  });
  assert.equal(longName.code, "22023");
  assert.deepEqual(await counts(db), before, "rejected input leaves zero residue");
});

test("duplicate team codes are rejected atomically", async () => {
  await createTeam(db, CATALOG, { code: "TEAM_DUP", name: "Synthetic Dup", key: KEY("05") });
  const before = await counts(db);
  const duplicate = await rpcError(db, "direct_entry_create_team", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
    p_code: "TEAM_DUP", p_display_name: "Duplicate", p_reason: REASON,
    p_idempotency_key: KEY("06"),
  });
  assert.equal(duplicate.code, "23505");
  assert.deepEqual(await counts(db), before, "duplicate create leaves zero residue");
});

test("generic update is field-scoped: only display_name changes", async () => {
  const created = await createTeam(db, FULL_ADMIN, { code: "TEAM_UPD", name: "Synthetic Update Base", key: KEY("10") });
  const before = await counts(db);

  const stale = await rpcError(db, "direct_entry_update_team", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app, p_team_id: created.team_id,
    p_expected_version: created.version + 5, p_display_name: "Stale", p_reason: REASON,
    p_idempotency_key: KEY("11"),
  });
  assert.equal(stale.code, "PT409");
  assert.deepEqual(await counts(db), before, "stale version leaves zero residue");

  const updated = await rpc(db, "direct_entry_update_team", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app, p_team_id: created.team_id,
    p_expected_version: created.version, p_display_name: "Synthetic Update Renamed",
    p_reason: REASON, p_idempotency_key: KEY("12"),
  });
  assert.equal(updated.team_id, created.team_id);
  assert.equal(updated.version, created.version + 1);
  assert.equal(updated.display_name, "Synthetic Update Renamed");
  assert.equal(updated.code, created.code, "code is immutable after create");
  assert.equal(updated.active, created.active, "active is never reachable from the generic update");

  const row = (await db.query(
    "select code, active, version from public.teams where team_id = $1::uuid", [created.team_id])).rows[0];
  assert.deepEqual(row, { code: "TEAM_UPD", active: true, version: created.version + 1 });

  const noChange = await rpcError(db, "direct_entry_update_team", {
    p_auth_subject: FULL_ADMIN.auth, p_app_user_id: FULL_ADMIN.app, p_team_id: created.team_id,
    p_expected_version: updated.version, p_display_name: "Synthetic Update Renamed",
    p_reason: REASON, p_idempotency_key: KEY("13"),
  });
  assert.equal(noChange.code, "22023");

  const audit = (await db.query(
    "select capability, changed_fields from public.direct_entry_audit_events"
    + " where resource_ref = $1 and action = 'team_update' order by created_at desc limit 1",
    [created.team_id])).rows[0];
  assert.equal(audit.capability, "entry_admin", "legacy full admin is labelled entry_admin");
  assert.deepEqual(audit.changed_fields, ["display_name"]);

  const revision = (await db.query(
    "select before_snapshot, after_snapshot, version from public.direct_entry_team_revisions"
    + " where team_id = $1::uuid order by version desc limit 1", [created.team_id])).rows[0];
  assert.equal(revision.version, updated.version);
  assertSnapshotShape(revision.before_snapshot, "update before");
  assertSnapshotShape(revision.after_snapshot, "update after");
  assert.deepEqual(revision.before_snapshot, {
    team_id: created.team_id, code: "TEAM_UPD", display_name: "Synthetic Update Base",
    active: true, version: created.version,
  });
  assert.deepEqual(revision.after_snapshot, {
    team_id: created.team_id, code: "TEAM_UPD", display_name: "Synthetic Update Renamed",
    active: true, version: updated.version,
  });
});

test("set-active is a soft state change that keeps every reference and history", async () => {
  const created = await createTeam(db, CATALOG, { code: "TEAM_ACTIVE", name: "Synthetic Active", key: KEY("16") });
  const membershipsBefore = (await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships where team_id = $1::uuid",
    [created.team_id])).rows[0].n;
  const scopesBefore = (await db.query(
    "select count(*)::int as n from public.direct_entry_scope_grants where team_id = $1::uuid",
    [created.team_id])).rows[0].n;

  const deactivated = await rpc(db, "direct_entry_set_team_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: created.team_id,
    p_active: false, p_expected_version: created.version, p_reason: REASON,
    p_idempotency_key: KEY("17"),
  });
  assert.equal(deactivated.active, false);
  assert.equal(deactivated.version, created.version + 1);
  assert.equal(deactivated.code, created.code);

  const row = (await db.query(
    "select active, version, code from public.teams where team_id = $1::uuid", [created.team_id])).rows[0];
  assert.equal(row.active, false, "the team row still exists after deactivation");
  assert.equal(row.code, created.code);

  const unchanged = await rpcError(db, "direct_entry_set_team_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: created.team_id,
    p_active: false, p_expected_version: deactivated.version, p_reason: REASON,
    p_idempotency_key: KEY("18"),
  });
  assert.equal(unchanged.code, "22023");

  const reactivated = await rpc(db, "direct_entry_set_team_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: created.team_id,
    p_active: true, p_expected_version: deactivated.version, p_reason: REASON,
    p_idempotency_key: KEY("19"),
  });
  assert.equal(reactivated.active, true);
  assert.equal(reactivated.version, created.version + 2);

  assert.equal((await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships where team_id = $1::uuid",
    [created.team_id])).rows[0].n, membershipsBefore, "membership rows are untouched");
  assert.equal((await db.query(
    "select count(*)::int as n from public.direct_entry_scope_grants where team_id = $1::uuid",
    [created.team_id])).rows[0].n, scopesBefore, "scope rows are untouched");

  const revisions = (await db.query(
    "select version, before_snapshot, after_snapshot from public.direct_entry_team_revisions"
    + " where team_id = $1::uuid order by version", [created.team_id])).rows;
  assert.deepEqual(revisions.map((r) => r.version), [1, 2, 3]);
  for (const revision of revisions.slice(1)) {
    assertSnapshotShape(revision.before_snapshot, "set-active before v" + revision.version);
    assertSnapshotShape(revision.after_snapshot, "set-active after v" + revision.version);
  }
  assert.equal(revisions[1].before_snapshot.active, true);
  assert.equal(revisions[1].after_snapshot.active, false);
  assert.equal(revisions[2].before_snapshot.active, false);
  assert.equal(revisions[2].after_snapshot.active, true);

  const audit = (await db.query(
    "select changed_fields, capability from public.direct_entry_audit_events"
    + " where resource_ref = $1 and action = 'team_set_active' order by created_at desc limit 1",
    [created.team_id])).rows[0];
  assert.deepEqual(audit.changed_fields, ["active"]);
  assert.equal(audit.capability, "catalog_master_manage");
});

test("the team list is bounded, deterministic, searchable and pageable", async () => {
  await createTeam(db, CATALOG, { code: "TEAM_LIST_A", name: "Synthetic List Alpha", key: KEY("20") });
  await createTeam(db, CATALOG, { code: "TEAM_LIST_B", name: "Synthetic List Bravo", key: KEY("21") });

  const list = await rpc(db, "direct_entry_list_teams_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_search: "Synthetic List",
  });
  assert.equal(list.total, 2);
  assert.deepEqual(list.teams.map((row) => row.display_name),
    ["Synthetic List Alpha", "Synthetic List Bravo"], "deterministic display_name order");
  for (const item of list.teams) {
    assert.equal(sortedKeys(item), ITEM_KEYS.slice().sort().join(","));
    assert.equal(item.revision_count, 1);
  }
  const repeat = await rpc(db, "direct_entry_list_teams_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_search: "Synthetic List",
  });
  assert.deepEqual(repeat.teams.map((row) => row.team_id), list.teams.map((row) => row.team_id));

  const byCode = await rpc(db, "direct_entry_list_teams_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_search: "TEAM_LIST_B",
  });
  assert.equal(byCode.total, 1);
  assert.equal(byCode.teams[0].code, "TEAM_LIST_B");

  const firstPage = await rpc(db, "direct_entry_list_teams_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_search: "Synthetic List",
    p_page: 1, p_page_size: 1,
  });
  const secondPage = await rpc(db, "direct_entry_list_teams_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_search: "Synthetic List",
    p_page: 2, p_page_size: 1,
  });
  assert.equal(firstPage.teams.length, 1);
  assert.equal(secondPage.teams.length, 1);
  assert.notEqual(firstPage.teams[0].team_id, secondPage.teams[0].team_id);

  // Active filter: a deactivated team disappears unless inactive rows are asked for.
  const created = await createTeam(db, CATALOG, { code: "TEAM_LIST_C", name: "Synthetic List Charlie", key: KEY("22") });
  await rpc(db, "direct_entry_set_team_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: created.team_id,
    p_active: false, p_expected_version: created.version, p_reason: REASON,
    p_idempotency_key: KEY("23"),
  });
  const activeOnly = await rpc(db, "direct_entry_list_teams_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_search: "Synthetic List",
    p_include_inactive: false,
  });
  const withInactive = await rpc(db, "direct_entry_list_teams_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_search: "Synthetic List",
    p_include_inactive: true,
  });
  assert.equal(activeOnly.total, 2);
  assert.equal(withInactive.total, 3);

  for (const args of [
    { p_page: 0 }, { p_page: 1001 }, { p_page_size: 0 }, { p_page_size: 101 },
    { p_search: "x".repeat(257) },
  ]) {
    const error = await rpcError(db, "direct_entry_list_teams_admin", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, ...args,
    });
    assert.equal(error.code, "22023", JSON.stringify(args));
  }

  const detail = await rpc(db, "direct_entry_get_team_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: created.team_id,
  });
  assert.equal(sortedKeys(detail), ITEM_KEYS.slice().sort().join(","));
  assert.equal(detail.code, "TEAM_LIST_C");
  assert.equal(detail.revision_count, 2);
  assert.equal((await rpcError(db, "direct_entry_get_team_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: MISSING_TEAM,
  })).code, "P0002");
});

test("the reserved Vendor system team is invisible and immutable through the catalog", async () => {
  const reservedId = (await db.query(
    "select team_id from public.teams where code = $1", [RESERVED_CODE])).rows[0].team_id;
  const reservedBefore = (await db.query(
    "select code, display_name, active, version from public.teams where team_id = $1::uuid",
    [reservedId])).rows[0];

  const listed = await rpc(db, "direct_entry_list_teams_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_search: "Vendor",
    p_include_inactive: true,
  });
  assert.equal(listed.teams.some((row) => row.code === RESERVED_CODE), false);
  assert.equal(listed.total, 0, "the reserved team is never counted");

  const all = await rpc(db, "direct_entry_list_teams_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_include_inactive: true,
    p_page: 1, p_page_size: 100,
  });
  assert.equal(all.teams.some((row) => row.team_id === reservedId), false);
  const businessTeams = (await db.query(
    "select count(*)::int as n from public.teams where code <> $1", [RESERVED_CODE])).rows[0].n;
  assert.equal(all.total, businessTeams, "the count covers business teams only");

  assert.equal((await rpcError(db, "direct_entry_get_team_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: reservedId,
  })).code, "P0002");
  assert.equal((await rpcError(db, "direct_entry_update_team", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: reservedId,
    p_expected_version: 1, p_display_name: "Hijacked", p_reason: REASON,
    p_idempotency_key: KEY("30"),
  })).code, "P0002");
  assert.equal((await rpcError(db, "direct_entry_set_team_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: reservedId,
    p_active: false, p_expected_version: 1, p_reason: REASON, p_idempotency_key: KEY("31"),
  })).code, "P0002");
  assert.equal((await rpcError(db, "direct_entry_create_team", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
    p_code: RESERVED_CODE, p_display_name: "Reserved Clone", p_reason: REASON,
    p_idempotency_key: KEY("32"),
  })).code, "22023");

  assert.deepEqual((await db.query(
    "select code, display_name, active, version from public.teams where team_id = $1::uuid",
    [reservedId])).rows[0], reservedBefore, "the reserved row is unchanged");
  assert.equal((await db.query(
    "select count(*)::int as n from public.recruiter_team_memberships m"
    + " join public.teams t on t.team_id = m.team_id where t.code = $1", [RESERVED_CODE])).rows[0].n,
  0, "the reserved team still has no business membership");
  assert.equal((await db.query(
    "select count(*)::int as n from public.direct_entry_scope_grants g"
    + " join public.teams t on t.team_id = g.team_id where t.code = $1", [RESERVED_CODE])).rows[0].n,
  0, "the reserved team still has no team scope");
});

test("team mutations never write membership, scope, capability or link residue", async () => {
  const before = await counts(db);
  const created = await createTeam(db, CATALOG, { code: "TEAM_RESIDUE", name: "Synthetic Residue", key: KEY("40") });
  const updated = await rpc(db, "direct_entry_update_team", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: created.team_id,
    p_expected_version: created.version, p_display_name: "Synthetic Residue Renamed",
    p_reason: REASON, p_idempotency_key: KEY("41"),
  });
  await rpc(db, "direct_entry_set_team_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: created.team_id,
    p_active: false, p_expected_version: updated.version, p_reason: REASON,
    p_idempotency_key: KEY("42"),
  });
  const after = await counts(db);
  assert.equal(after.teams, before.teams + 1);
  assert.equal(after.revisions, before.revisions + 3);
  assert.equal(after.audits, before.audits + 3);
  assert.equal(after.reasons, before.reasons + 3);
  assert.equal(after.capability_grants, before.capability_grants);
  assert.equal(after.scope_grants, before.scope_grants);
  assert.equal(after.links, before.links);
  assert.equal(after.team_memberships, before.team_memberships);
  assert.equal(after.app_users, before.app_users);
});

test("replay returns the stored result and a reused key with different input conflicts", async () => {
  const first = await createTeam(db, CATALOG, { code: "TEAM_IDEM", name: "Synthetic Idem", key: KEY("50") });
  const before = await counts(db);
  const replay = await createTeam(db, CATALOG, { code: "TEAM_IDEM", name: "Synthetic Idem", key: KEY("50") });
  assert.deepEqual(replay, first);
  assert.deepEqual(await counts(db), before, "replay adds no row, revision, audit or reason");

  const conflict = await rpcError(db, "direct_entry_create_team", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
    p_code: "TEAM_IDEM", p_display_name: "Different Payload", p_reason: REASON,
    p_idempotency_key: KEY("50"),
  });
  assert.equal(conflict.code, "22023");
  assert.equal(conflict.message, "idempotency key reused with different input");
  assert.deepEqual(await counts(db), before);

  const deactivated = await rpc(db, "direct_entry_set_team_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: first.team_id,
    p_active: false, p_expected_version: first.version, p_reason: REASON,
    p_idempotency_key: KEY("51"),
  });
  const afterDeactivate = await counts(db);
  const deactivateReplay = await rpc(db, "direct_entry_set_team_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_team_id: first.team_id,
    p_active: false, p_expected_version: first.version, p_reason: REASON,
    p_idempotency_key: KEY("51"),
  });
  assert.deepEqual(deactivateReplay, deactivated);
  assert.deepEqual(await counts(db), afterDeactivate);
});

test("a failing audit or revision write rolls the whole team mutation back", async () => {
  const before = await counts(db);
  await db.exec("create function public.test_w01c_fail_audit() returns trigger language plpgsql as"
    + " $x$ begin raise exception 'synthetic audit failure' using errcode = '23514'; end $x$;"
    + " create trigger test_w01c_fail_audit before insert on public.direct_entry_audit_events"
    + " for each row execute function public.test_w01c_fail_audit();");
  try {
    const error = await rpcError(db, "direct_entry_create_team", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
      p_code: "TEAM_ROLLBACK1", p_display_name: "Rollback One", p_reason: REASON,
      p_idempotency_key: KEY("60"),
    });
    assert.equal(error.code, "23514");
  } finally {
    await db.exec("drop trigger test_w01c_fail_audit on public.direct_entry_audit_events;"
      + " drop function public.test_w01c_fail_audit();");
  }
  assert.deepEqual(await counts(db), before, "audit failure leaves zero residue");

  await db.exec("create function public.test_w01c_fail_revision() returns trigger language plpgsql as"
    + " $x$ begin raise exception 'synthetic revision failure' using errcode = '23514'; end $x$;"
    + " create trigger test_w01c_fail_revision before insert on public.direct_entry_team_revisions"
    + " for each row execute function public.test_w01c_fail_revision();");
  try {
    const error = await rpcError(db, "direct_entry_create_team", {
      p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_expected_version: 0,
      p_code: "TEAM_ROLLBACK2", p_display_name: "Rollback Two", p_reason: REASON,
      p_idempotency_key: KEY("61"),
    });
    assert.equal(error.code, "23514");
  } finally {
    await db.exec("drop trigger test_w01c_fail_revision on public.direct_entry_team_revisions;"
      + " drop function public.test_w01c_fail_revision();");
  }
  assert.deepEqual(await counts(db), before, "revision failure leaves zero residue");
});

test("service-role only EXECUTE, revoked helpers, forced RLS and immutability", async () => {
  const rpcs = [
    "public.direct_entry_list_teams_admin(uuid,uuid,text,boolean,integer,integer)",
    "public.direct_entry_get_team_admin(uuid,uuid,uuid)",
    "public.direct_entry_create_team(uuid,uuid,integer,text,text,text,text)",
    "public.direct_entry_update_team(uuid,uuid,uuid,integer,text,text,text)",
    "public.direct_entry_set_team_active(uuid,uuid,uuid,boolean,integer,text,text)",
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
    "public.direct_entry_team_snapshot(public.teams)",
    "public.direct_entry_team_admin_projection(public.teams,integer)",
    "public.direct_entry_lock_team(uuid,integer)",
    "public.direct_entry_write_team_revision(uuid,integer,uuid,uuid,jsonb,jsonb)",
    "public.direct_entry_bump_team_version(uuid,uuid,uuid,jsonb,jsonb)",
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

  const { rows } = await db.query(
    "select c.relrowsecurity, c.relforcerowsecurity,"
    + " has_table_privilege('service_role', c.oid, 'SELECT') as service_select,"
    + " has_table_privilege('anon', c.oid, 'SELECT') as anon_select,"
    + " has_table_privilege('authenticated', c.oid, 'INSERT') as auth_insert"
    + " from pg_class c join pg_namespace n on n.oid = c.relnamespace"
    + " where n.nspname = 'public' and c.relname = 'direct_entry_team_revisions'");
  assert.deepEqual(rows[0], { relrowsecurity: true, relforcerowsecurity: true,
    service_select: false, anon_select: false, auth_insert: false });

  await assert.rejects(
    db.exec("update public.direct_entry_team_revisions set version = version"),
    (error) => error.code === "55000",
  );
  await assert.rejects(
    db.exec("delete from public.direct_entry_team_revisions"),
    (error) => error.code === "55000",
  );

  // The canonical teams table keeps its own deny-by-default posture.
  const teams = (await db.query(
    "select c.relrowsecurity, c.relforcerowsecurity,"
    + " has_table_privilege('service_role', c.oid, 'UPDATE') as service_update,"
    + " has_table_privilege('anon', c.oid, 'SELECT') as anon_select"
    + " from pg_class c where c.oid = 'public.teams'::regclass")).rows[0];
  assert.deepEqual(teams, { relrowsecurity: true, relforcerowsecurity: true,
    service_update: false, anon_select: false });
});

test("W01A and W01B contracts keep their semantics", async () => {
  const { rows: capabilityRows } = await db.query(
    "select pg_get_constraintdef(c.oid) as definition from pg_constraint c"
    + " join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace"
    + " where n.nspname = 'public' and t.relname = 'direct_entry_capability_grants'"
    + " and c.conname = 'direct_entry_capability_grants_capability_check'");
  const tokens = [...String(capabilityRows[0].definition).matchAll(/'([^']+)'::text/g)]
    .map((match) => match[1]);
  assert.equal(tokens.length, 33, "the capability vocabulary includes W01A, F1, F2, VFIN-01, duplicate CCCD, and worker history tokens");
  assert.ok(tokens.includes("catalog_master_manage"));
  assert.ok(tokens.includes("team_manager_assign"));

  for (const signature of [
    "public.direct_entry_list_personnel_admin(uuid,uuid,text,boolean,integer,integer)",
    "public.direct_entry_create_personnel(uuid,uuid,integer,text,text,text,date,text,text)",
    "public.direct_entry_set_personnel_active(uuid,uuid,uuid,boolean,integer,text,text)",
  ]) {
    const { rows } = await db.query(
      "select has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec,"
      + " has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec"
      + " from pg_proc p where p.oid = $1::regprocedure", [signature]);
    assert.deepEqual([rows[0].service_exec, rows[0].anon_exec], [true, false], signature);
  }
  const snapshot = (await db.query(
    "select pg_get_function_arguments(p.oid) as args from pg_proc p"
    + " join pg_namespace n on n.oid = p.pronamespace"
    + " where n.nspname = 'public' and p.proname = 'direct_entry_personnel_snapshot'")).rows;
  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].args, "p_recruiter recruiters",
    "the W01B fixed six-key personnel snapshot is unchanged");

  // Direct Entry behaviour that the team catalog must not disturb.
  const catalog = (await db.query(
    "select count(*)::int as n from public.direct_entry_projects")).rows[0].n;
  assert.equal(catalog, 0, "the team catalog touches no Direct Entry data");
});

test("migration #69 is appended once and migrations #1-#68 are untouched", async () => {
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.includes(NEW_MIGRATION), "migration #69 must exist");
  assert.ok(NEW_MIGRATION > PREVIOUS_MIGRATION, "migration #69 applies after #68");
  assert.equal(names.filter((name) => name.startsWith("20261009050000")).length, 1,
    "exactly one migration occupies the #69 slot");
  assert.equal(names.filter((name) => name.startsWith("20261009040000")).length, 1,
    "the #68 personnel migration is still a single file");

  const teamSymbols = [
    "direct_entry_team_revisions",
    "direct_entry_list_teams_admin",
    "direct_entry_get_team_admin",
    "direct_entry_create_team",
    "direct_entry_update_team",
    "direct_entry_set_team_active",
  ];
  for (const name of names) {
    if (name >= NEW_MIGRATION) continue;
    const sql = await readFile(path.join(MIGRATION_DIR, name), "utf8");
    for (const symbol of teamSymbols) {
      assert.equal(sql.includes(symbol), false, symbol + " must not appear in " + name);
    }
  }
});
