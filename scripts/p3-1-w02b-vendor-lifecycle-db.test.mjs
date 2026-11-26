/**
 * P3.1-W02-B - Vendor catalog lifecycle backend (#75) DB acceptance.
 *
 * Proves the single catalog-operator guard reused from #68, the atomic Vendor
 * create (vendors + representation recruiter + vendor provider membership, never
 * a team membership), the immutable vendor_id / mutable display_name contract,
 * OCC + reason + idempotency + revision + audit invariants, the reserved system
 * namespace boundary, the fail-closed deactivation dependency handling, bounded
 * stable list/search/paging, the ACL/RLS/search_path posture and zero residue.
 *
 * No Production access, no network, no browser: PGlite applies the real local
 * migrations and the RPCs are called exactly as the service-role repository does.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");
const NEW_MIGRATION = "20261009110000_p3_1_w02b_vendor_lifecycle.sql";
const LEGACY_SCOPE_HOTFIX = "20261009120000_p3_1_hf_legacy_team_leader_scope.sql";
const PREVIOUS_MIGRATION = "20261009100000_p3_1_hf_duplicate_cccd_reporting.sql";

const FULL_ADMIN = { auth: "10000000-0000-4000-8000-0000000000c1", app: "20000000-0000-4000-8000-0000000000c1" };
const CATALOG = { auth: "10000000-0000-4000-8000-0000000000c2", app: "20000000-0000-4000-8000-0000000000c2" };
const ENTRY_ADMIN_ONLY = { auth: "10000000-0000-4000-8000-0000000000c3", app: "20000000-0000-4000-8000-0000000000c3" };
const CATALOG_NO_ALL = { auth: "10000000-0000-4000-8000-0000000000c4", app: "20000000-0000-4000-8000-0000000000c4" };
const LEADER = { auth: "10000000-0000-4000-8000-0000000000c5", app: "20000000-0000-4000-8000-0000000000c5" };
const STAFF = { auth: "10000000-0000-4000-8000-0000000000c6", app: "20000000-0000-4000-8000-0000000000c6" };
const DISABLED_ADMIN = { auth: "10000000-0000-4000-8000-0000000000c7", app: "20000000-0000-4000-8000-0000000000c7" };
const ENTRY_OPERATOR = { auth: "10000000-0000-4000-8000-0000000000c8", app: "20000000-0000-4000-8000-0000000000c8" };
const TEAM_FIXTURE_ID = "94000000-0000-4000-8000-0000000000e1";
/** A team that never exists, so the Direct Entry identity gate always stops on it. */
const PROBE_TEAM_ID = "94000000-0000-4000-8000-0000000000ff";
const MISSING_APP = "20000000-0000-4000-8000-0000000000ff";
const RESERVED = "__system_vendor__";
const REASON = "Synthetic vendor catalog reason";
const VALID_FROM = "2024-01-01";
const KEY = (suffix) => "50000000-0000-4000-8000-0000000000" + suffix;

const RPC_PARAMS = {
  direct_entry_list_vendors_admin: ["p_auth_subject", "p_app_user_id", "p_search",
    "p_include_inactive", "p_page", "p_page_size"],
  direct_entry_get_vendor_admin: ["p_auth_subject", "p_app_user_id", "p_vendor_id"],
  direct_entry_create_vendor: ["p_auth_subject", "p_app_user_id", "p_expected_version",
    "p_vendor_id", "p_display_name", "p_valid_from", "p_reason", "p_idempotency_key"],
  direct_entry_update_vendor: ["p_auth_subject", "p_app_user_id", "p_vendor_id",
    "p_expected_version", "p_display_name", "p_reason", "p_idempotency_key"],
  direct_entry_set_vendor_active: ["p_auth_subject", "p_app_user_id", "p_vendor_id",
    "p_active", "p_expected_version", "p_reason", "p_idempotency_key"],
};

async function database() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")
    .sort();
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
    "select (select count(*)::int from public.vendors) as vendors,"
    + " (select count(*)::int from public.recruiters) as recruiters,"
    + " (select count(*)::int from public.recruiter_provider_memberships) as provider_memberships,"
    + " (select count(*)::int from public.direct_entry_vendor_revisions) as vendor_revisions,"
    + " (select count(*)::int from public.direct_entry_audit_events) as audits,"
    + " (select count(*)::int from public.direct_entry_restricted_reasons) as reasons,"
    + " (select count(*)::int from public.direct_entry_capability_grants) as capability_grants,"
    + " (select count(*)::int from public.direct_entry_scope_grants) as scope_grants,"
    + " (select count(*)::int from public.direct_entry_app_user_recruiter_links) as links,"
    + " (select count(*)::int from public.recruiter_team_memberships) as team_memberships,"
    + " (select count(*)::int from public.teams) as teams,"
    + " (select count(*)::int from public.direct_entry_app_users) as app_users,"
    + " (select count(*)::int from public.direct_entry_rpc_idempotency) as idempotency",
  );
  return rows[0];
}

const ITEM_KEYS = ["vendor_id", "display_name", "active", "version", "revision_count", "recruiter_id"];
const MUTATION_KEYS = ["vendor_id", "display_name", "active", "version", "revision_id", "recruiter_id"];
const CREATE_KEYS = [...MUTATION_KEYS, "created"];
const SNAPSHOT_KEYS = ["vendor_id", "display_name", "active", "version"].sort();

function sortedKeys(value) {
  return Object.keys(value).sort().join(",");
}

function assertSnapshotShape(snapshot, label) {
  assert.ok(snapshot, label + " snapshot must exist");
  assert.deepEqual(Object.keys(snapshot).sort(), SNAPSHOT_KEYS, label + " snapshot key set");
}

async function createVendor(db, actor, { id, name, key = KEY("01"), reason = REASON,
  validFrom = VALID_FROM, expected = 0 }) {
  return rpc(db, "direct_entry_create_vendor", {
    p_auth_subject: actor.auth,
    p_app_user_id: actor.app,
    p_expected_version: expected,
    p_vendor_id: id,
    p_display_name: name,
    p_valid_from: validFrom,
    p_reason: reason,
    p_idempotency_key: key,
  });
}

async function createVendorError(db, actor, options) {
  return rpcError(db, "direct_entry_create_vendor", {
    p_auth_subject: actor.auth,
    p_app_user_id: actor.app,
    p_expected_version: options.expected ?? 0,
    p_vendor_id: options.id,
    p_display_name: options.name,
    p_valid_from: options.validFrom === undefined ? VALID_FROM : options.validFrom,
    p_reason: options.reason === undefined ? REASON : options.reason,
    p_idempotency_key: options.key,
  });
}

const db = await database();
await db.exec("insert into public.teams (team_id, code, display_name, active) values ('"
  + TEAM_FIXTURE_ID + "', 'FX_TEAM', 'Synthetic Fixture Team', true)");
// The reserved Vendor system team is created exactly as the canonical #65 helper
// would create it: identified by its reserved CODE, never by a hard-coded UUID.
await db.exec("insert into public.teams (code, display_name, active) values ('"
  + RESERVED + "', 'Vendor', true)");
await addActor(db, { ...FULL_ADMIN, display_name: "Synthetic Full Admin",
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: ["all"] });
await addActor(db, { ...CATALOG, capabilities: ["catalog_master_manage"], scopes: ["all"] });
await addActor(db, { ...ENTRY_ADMIN_ONLY, capabilities: ["entry_admin"], scopes: ["all"] });
await addActor(db, { ...CATALOG_NO_ALL, capabilities: ["catalog_master_manage"], scopes: ["own"] });
await addActor(db, { ...LEADER, capabilities: ["team_manager_assign"], scopes: ["team"] });
await addActor(db, { ...STAFF, capabilities: ["entry_own"], scopes: ["own"] });
await addActor(db, { ...DISABLED_ADMIN, enabled: false,
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"], scopes: ["all"] });
await addActor(db, { ...ENTRY_OPERATOR, capabilities: ["entry_create"], scopes: ["all"] });

test("assertions 1: the ledger carries #75 append-only after the P3.1-HF report", async () => {
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(names.includes("20261019130000_pre_w2_hf_draft_submission_delete.sql"),
    "migration inventory includes the #122 baseline");
  assert.equal(names.indexOf(LEGACY_SCOPE_HOTFIX), 75, "#76 is the append-only leader-scope hotfix");
  assert.equal(names.indexOf(NEW_MIGRATION), 74, "#75 remains the P3.1-W02-B vendor lifecycle migration");
  assert.equal(names.indexOf(PREVIOUS_MIGRATION), 73, "#75 stays append-only after #74");
  assert.equal(names.indexOf("20261009090000_p3_1_hf_recruiter_alias_backfill.sql"), 72, "migration chronology remains append-only");
  assert.equal(names.indexOf("20261009080000_p3_1_w02a_team_leader_project_manager_authority.sql"), 71, "migration chronology remains append-only");
  assert.equal(names.indexOf("20261009020000_p3_w07a_r4_vendor_historical_team_backfill.sql"), 65, "migration chronology remains append-only");
  assert.equal(names.indexOf("20261009010000_p3_w07a_r3_vendor_hidden_team_and_document_upload.sql"), 64, "migration chronology remains append-only");
});

test("both catalog authority paths can read the vendor catalog", async () => {
  for (const [actor, label] of [[FULL_ADMIN, "legacy full admin"], [CATALOG, "catalog_master_manage"]]) {
    const list = await rpc(db, "direct_entry_list_vendors_admin", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app,
    });
    assert.equal(list.include_inactive, true, label);
    assert.equal(Array.isArray(list.vendors), true, label);
    assert.equal(list.page, 1, label);
    assert.equal(list.page_size, 25, label);
    assert.equal(list.search, null, label);
    assert.equal(typeof list.authorization_date, "string", label);
  }
});

test("the guard denies every non-operator authority without residue", async () => {
  const before = await counts(db);
  const denied = [
    [ENTRY_ADMIN_ONLY, "entry_admin@all alone"],
    [CATALOG_NO_ALL, "catalog token without all scope"],
    [LEADER, "team leader (team_manager_assign/team)"],
    [STAFF, "staff"],
    [DISABLED_ADMIN, "disabled actor"],
    [{ auth: FULL_ADMIN.auth, app: STAFF.app }, "forged auth/app pair"],
    [{ auth: FULL_ADMIN.auth, app: MISSING_APP }, "unmapped app user"],
  ];
  for (const [actor, label] of denied) {
    for (const name of ["direct_entry_list_vendors_admin", "direct_entry_get_vendor_admin",
      "direct_entry_set_vendor_active"]) {
      const error = await rpcError(db, name, {
        p_auth_subject: actor.auth, p_app_user_id: actor.app, p_vendor_id: "DENIED",
        p_active: false, p_expected_version: 1, p_reason: REASON, p_idempotency_key: KEY("d1"),
      });
      assert.ok(error, label + " / " + name + " must be denied");
      assert.equal(error.code, "42501", label + " / " + name);
    }
    const createError = await rpcError(db, "direct_entry_create_vendor", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app, p_expected_version: 0,
      p_vendor_id: "DENIED_" + label.length, p_display_name: "Denied Vendor",
      p_valid_from: VALID_FROM, p_reason: REASON, p_idempotency_key: KEY("d2"),
    });
    assert.equal(createError.code, "42501", label + " create must be denied");
    const updateError = await rpcError(db, "direct_entry_update_vendor", {
      p_auth_subject: actor.auth, p_app_user_id: actor.app, p_vendor_id: "DENIED",
      p_expected_version: 1, p_display_name: "Denied Vendor", p_reason: REASON,
      p_idempotency_key: KEY("d3"),
    });
    assert.equal(updateError.code, "42501", label + " update must be denied");
  }
  assert.deepEqual(await counts(db), before, "denials leave zero residue");
});

test("create writes the whole canonical Vendor aggregate atomically", async () => {
  const before = await counts(db);
  const result = await createVendor(db, CATALOG, {
    id: "W02B_ALPHA", name: "Synthetic Alpha Vendor", key: KEY("10"),
  });

  assert.equal(sortedKeys(result), [...CREATE_KEYS].sort().join(","));
  assert.equal(result.created, true);
  assert.equal(result.vendor_id, "W02B_ALPHA");
  assert.equal(result.display_name, "Synthetic Alpha Vendor");
  assert.equal(result.active, true);
  assert.equal(result.version, 1);

  const after = await counts(db);
  assert.equal(after.vendors, before.vendors + 1);
  assert.equal(after.recruiters, before.recruiters + 1, "exactly one representation recruiter");
  assert.equal(after.provider_memberships, before.provider_memberships + 1, "exactly one membership");
  assert.equal(after.vendor_revisions, before.vendor_revisions + 1);
  assert.equal(after.audits, before.audits + 1);
  assert.equal(after.reasons, before.reasons + 1);
  assert.equal(after.team_memberships, before.team_memberships, "no team membership");
  assert.equal(after.teams, before.teams, "no team row is created");
  assert.equal(after.capability_grants, before.capability_grants, "no capability grant");
  assert.equal(after.scope_grants, before.scope_grants, "no scope grant");
  assert.equal(after.links, before.links, "no recruiter link");
  assert.equal(after.app_users, before.app_users, "no app user");

  const vendor = (await db.query(
    "select vendor_id, display_name, active, version from public.vendors where vendor_id = $1",
    [result.vendor_id])).rows[0];
  assert.deepEqual(vendor, { vendor_id: "W02B_ALPHA",
    display_name: "Synthetic Alpha Vendor", active: true, version: 1 });

  const membership = (await db.query(
    "select m.provider_type, m.vendor_id, m.valid_from::text as valid_from, m.valid_to,"
    + " r.display_name, r.active"
    + " from public.recruiter_provider_memberships m"
    + " join public.recruiters r on r.recruiter_id = m.recruiter_id"
    + " where m.recruiter_id = $1::uuid", [result.recruiter_id])).rows[0];
  assert.deepEqual(membership, { provider_type: "vendor", vendor_id: "W02B_ALPHA",
    valid_from: VALID_FROM, valid_to: null, display_name: "Synthetic Alpha Vendor", active: true });

  const membershipCount = (await db.query(
    "select count(*)::int as c from public.recruiter_provider_memberships where recruiter_id = $1::uuid",
    [result.recruiter_id])).rows[0].c;
  assert.equal(membershipCount, 1, "the representation recruiter has exactly one provider membership");
  const teamMemberships = (await db.query(
    "select count(*)::int as c from public.recruiter_team_memberships where recruiter_id = $1::uuid",
    [result.recruiter_id])).rows[0].c;
  assert.equal(teamMemberships, 0, "create never writes a team membership");

  const revision = (await db.query(
    "select version, before_snapshot, after_snapshot from public.direct_entry_vendor_revisions"
    + " where vendor_id = $1", [result.vendor_id])).rows[0];
  assert.equal(revision.version, 1);
  assert.equal(revision.before_snapshot, null);
  assertSnapshotShape(revision.after_snapshot, "create after");
  assert.deepEqual(revision.after_snapshot, { vendor_id: "W02B_ALPHA",
    display_name: "Synthetic Alpha Vendor", active: true, version: 1 });

  const audit = (await db.query(
    "select action, capability, scope_kind, outcome, changed_fields, vendor_revision_id,"
    + " reason_id, resource_ref from public.direct_entry_audit_events"
    + " where resource_ref = $1 order by created_at desc limit 1", [result.vendor_id])).rows[0];
  assert.equal(audit.action, "vendor_create");
  assert.equal(audit.capability, "catalog_master_manage");
  assert.equal(audit.scope_kind, "all");
  assert.equal(audit.outcome, "APPLIED");
  assert.deepEqual(audit.changed_fields, ["vendor_id", "display_name", "active"]);
  assert.equal(audit.reason_id !== null, true, "the audit event is bound to the restricted reason");
  assert.equal(audit.vendor_revision_id, result.revision_id);

  const detail = await rpc(db, "direct_entry_get_vendor_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: result.vendor_id,
  });
  assert.equal(sortedKeys(detail), [...ITEM_KEYS].sort().join(","));
  assert.equal(detail.revision_count, 1);
  assert.equal(detail.recruiter_id, result.recruiter_id);
  assert.equal(detail.version, 1);
});

test("create rejects invalid inputs without residue and accepts a missing action reason", async () => {
  const before = await counts(db);

  const duplicate = await createVendorError(db, CATALOG, {
    id: "W02B_ALPHA", name: "Duplicate Vendor", key: KEY("20"),
  });
  assert.equal(duplicate.code, "23505", "a duplicate vendor id is a conflict");

  const reserved = await createVendorError(db, CATALOG, {
    id: RESERVED, name: "Reserved Vendor", key: KEY("21"),
  });
  assert.equal(reserved.code, "22023");
  assert.equal(reserved.message, "vendor id is reserved");

  const malformed = await createVendorError(db, CATALOG, {
    id: "-bad vendor", name: "Malformed", key: KEY("22"),
  });
  assert.equal(malformed.code, "22023");
  assert.equal(malformed.message, "vendor id is not canonical");

  const wrongVersion = await createVendorError(db, CATALOG, {
    id: "W02B_NOVERSION", name: "Wrong Version", key: KEY("23"), expected: 1,
  });
  assert.equal(wrongVersion.code, "22023");
  assert.equal(wrongVersion.message, "create expected version must be zero");

  const noValidFrom = await createVendorError(db, CATALOG, {
    id: "W02B_NOVALID", name: "No Valid From", key: KEY("24"), validFrom: null,
  });
  assert.equal(noValidFrom.code, "22023");
  assert.equal(noValidFrom.message, "vendor valid from required");

  const noKey = await createVendorError(db, CATALOG, {
    id: "W02B_NOKEY", name: "No Key", key: null,
  });
  assert.equal(noKey.code, "22023");

  const noName = await createVendorError(db, CATALOG, {
    id: "W02B_NONAME", name: "", key: KEY("26"),
  });
  assert.equal(noName.code, "22023");

  assert.deepEqual(await counts(db), before, "rejected creates leave zero residue");

  const noReason = await rpc(db, "direct_entry_create_vendor", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_expected_version: 0, p_vendor_id: "W02B_NOREASON",
    p_display_name: "No Reason", p_valid_from: VALID_FROM,
    p_reason: null, p_idempotency_key: KEY("25"),
  });
  assert.equal(noReason.vendor_id, "W02B_NOREASON");
  assert.equal(noReason.version, 1);
  const reasonRefs = (await db.query(
    "select (select reason_id from public.direct_entry_vendor_revisions"
    + " where vendor_id='W02B_NOREASON' and version=1) as revision_reason_id,"
    + " (select reason_id from public.direct_entry_audit_events"
    + " where resource_ref='W02B_NOREASON' and action='vendor_create') as audit_reason_id",
  )).rows[0];
  assert.equal(reasonRefs.revision_reason_id, null);
  assert.equal(reasonRefs.audit_reason_id, null);
  const after = await counts(db);
  assert.equal(after.vendors, before.vendors + 1);
  assert.equal(after.recruiters, before.recruiters + 1);
  assert.equal(after.provider_memberships, before.provider_memberships + 1);
  assert.equal(after.vendor_revisions, before.vendor_revisions + 1);
  assert.equal(after.audits, before.audits + 1);
  assert.equal(after.reasons, before.reasons, "optional reasons do not create restricted-reason placeholders");
  assert.equal(after.idempotency, before.idempotency + 1);
});

test("create rolls back completely when a late step fails", async () => {
  const before = await counts(db);
  await db.exec(
    "create function public.w02b_fault_injection() returns trigger language plpgsql as $$"
    + " begin if new.vendor_id = 'W02B_FAULT' then raise exception 'injected membership failure';"
    + " end if; return new; end $$;"
    + " create trigger w02b_fault_injection before insert on public.recruiter_provider_memberships"
    + " for each row execute function public.w02b_fault_injection();",
  );
  try {
    const faulted = await createVendorError(db, CATALOG, {
      id: "W02B_FAULT", name: "Fault Vendor", key: KEY("30"),
    });
    assert.equal(faulted.code, "P0001", "the injected fault must surface");
  } finally {
    await db.exec("drop trigger w02b_fault_injection on public.recruiter_provider_memberships;"
      + " drop function public.w02b_fault_injection();");
  }
  assert.deepEqual(await counts(db), before,
    "a failed create leaves no vendor, recruiter, membership, revision, audit or idempotency row");
  assert.equal((await db.query(
    "select count(*)::int as c from public.vendors where vendor_id = 'W02B_FAULT'")).rows[0].c, 0);
  assert.equal((await db.query(
    "select count(*)::int as c from public.recruiters where display_name = 'Fault Vendor'")).rows[0].c, 0);
});

test("an exact idempotent replay returns the stored result and writes nothing new", async () => {
  const result = await createVendor(db, CATALOG, {
    id: "W02B_REPLAY", name: "Replay Vendor", key: KEY("40"),
  });
  const before = await counts(db);
  const replay = await createVendor(db, CATALOG, {
    id: "W02B_REPLAY", name: "Replay Vendor", key: KEY("40"),
  });
  assert.deepEqual(replay, result, "the replay returns the stored result");
  assert.deepEqual(await counts(db), before, "the replay writes nothing");

  const conflicting = await createVendorError(db, CATALOG, {
    id: "W02B_REPLAY", name: "Different Display Name", key: KEY("40"),
  });
  assert.equal(conflicting.code, "22023");
  assert.equal(conflicting.message, "idempotency key reused with different input");
  assert.deepEqual(await counts(db), before, "a conflicting replay leaves zero residue");
});

test("update mutates display_name only, under OCC, with one revision and one audit event", async () => {
  const created = await createVendor(db, CATALOG, {
    id: "W02B_BETA", name: "Beta Vendor", key: KEY("50"),
  });
  const before = await counts(db);

  const updated = await rpc(db, "direct_entry_update_vendor", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: "W02B_BETA",
    p_expected_version: created.version, p_display_name: "Beta Vendor Renamed",
    p_reason: REASON, p_idempotency_key: KEY("51"),
  });
  assert.equal(sortedKeys(updated), [...MUTATION_KEYS].sort().join(","));
  assert.equal(updated.vendor_id, "W02B_BETA", "vendor_id is immutable");
  assert.equal(updated.display_name, "Beta Vendor Renamed");
  assert.equal(updated.active, true, "update never flips active");
  assert.equal(updated.version, created.version + 1);
  assert.equal(updated.recruiter_id, created.recruiter_id, "the representation recruiter is untouched");

  const after = await counts(db);
  assert.equal(after.vendors, before.vendors, "no vendor row is added or removed");
  assert.equal(after.recruiters, before.recruiters);
  assert.equal(after.provider_memberships, before.provider_memberships);
  assert.equal(after.vendor_revisions, before.vendor_revisions + 1);
  assert.equal(after.audits, before.audits + 1);
  assert.equal(after.reasons, before.reasons + 1);

  const row = (await db.query(
    "select vendor_id, display_name, active, version from public.vendors where vendor_id = 'W02B_BETA'")).rows[0];
  assert.deepEqual(row, { vendor_id: "W02B_BETA",
    display_name: "Beta Vendor Renamed", active: true, version: 2 });

  const revisions = (await db.query(
    "select version, before_snapshot, after_snapshot from public.direct_entry_vendor_revisions"
    + " where vendor_id = 'W02B_BETA' order by version")).rows;
  assert.equal(revisions.length, 2, "history keeps the create revision and appends exactly one update revision");
  assert.equal(revisions[0].before_snapshot, null);
  assertSnapshotShape(revisions[1].before_snapshot, "update before");
  assertSnapshotShape(revisions[1].after_snapshot, "update after");
  assert.deepEqual(revisions[1].before_snapshot, { vendor_id: "W02B_BETA",
    display_name: "Beta Vendor", active: true, version: 1 });
  assert.deepEqual(revisions[1].after_snapshot, { vendor_id: "W02B_BETA",
    display_name: "Beta Vendor Renamed", active: true, version: 2 });

  const audit = (await db.query(
    "select action, capability, changed_fields, vendor_revision_id, outcome from public.direct_entry_audit_events"
    + " where resource_ref = 'W02B_BETA' and action = 'vendor_update'")).rows[0];
  assert.equal(audit.capability, "catalog_master_manage");
  assert.equal(audit.outcome, "APPLIED");
  assert.deepEqual(audit.changed_fields, ["display_name"]);
  assert.equal(audit.vendor_revision_id, updated.revision_id);

  const detail = await rpc(db, "direct_entry_get_vendor_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: "W02B_BETA",
  });
  assert.equal(detail.display_name, "Beta Vendor Renamed");
  assert.equal(detail.version, 2);
  assert.equal(detail.revision_count, 2);
});

test("update fails closed on stale versions, no-ops, unknown and reserved vendors; action reason is optional", async () => {
  const before = await counts(db);
  const update = (options) => rpcError(db, "direct_entry_update_vendor", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_vendor_id: options.id, p_expected_version: options.expected,
    p_display_name: options.name, p_reason: options.reason === undefined ? REASON : options.reason,
    p_idempotency_key: options.key,
  });

  const stale = await update({ id: "W02B_BETA", expected: 1, name: "Stale Rename", key: KEY("52") });
  assert.equal(stale.code, "PT409", "a stale expected_version is a conflict, never a silent overwrite");

  const noop = await update({ id: "W02B_BETA", expected: 2, name: "Beta Vendor Renamed", key: KEY("53") });
  assert.equal(noop.code, "22023");
  assert.equal(noop.message, "vendor display name is unchanged");

  const unknown = await update({ id: "W02B_UNKNOWN", expected: 1, name: "Unknown Rename", key: KEY("54") });
  assert.equal(unknown.code, "P0002");

  const reserved = await update({ id: RESERVED, expected: 1, name: "Reserved Rename", key: KEY("55") });
  assert.equal(reserved.code, "P0002", "the reserved system namespace is never lockable or writable");

  const missing = await update({ id: "W02B_BETA", expected: null, name: "Missing Version", key: KEY("56") });
  assert.equal(missing.code, "22023");
  assert.equal(missing.message, "expected vendor version required");

  const noReason = await rpc(db, "direct_entry_update_vendor", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_vendor_id: "W02B_BETA", p_expected_version: 2,
    p_display_name: "No Reason Rename", p_reason: null,
    p_idempotency_key: KEY("57"),
  });
  assert.equal(noReason.display_name, "No Reason Rename");
  assert.equal(noReason.version, 3);
  const noReasonHistory = (await db.query(
    "select reason_id from public.direct_entry_vendor_revisions"
    + " where vendor_id='W02B_BETA' and version=3",
  )).rows[0];
  assert.equal(noReasonHistory.reason_id, null, "a null action reason creates no restricted-reason reference");
  const noReasonAudit = (await db.query(
    "select reason_id from public.direct_entry_audit_events"
    + " where resource_ref='W02B_BETA' and action='vendor_update' order by created_at desc limit 1",
  )).rows[0];
  assert.equal(noReasonAudit.reason_id, null, "the audit event remains present with a null action reason");

  const noKey = await update({ id: "W02B_BETA", expected: 3, name: "No Key Rename", key: null });
  assert.equal(noKey.code, "22023");
  assert.equal(noKey.message, "idempotency key required");

  const deniedActor = await rpcError(db, "direct_entry_update_vendor", {
    p_auth_subject: STAFF.auth, p_app_user_id: STAFF.app, p_vendor_id: "W02B_BETA",
    p_expected_version: 3, p_display_name: "Denied Rename", p_reason: REASON,
    p_idempotency_key: KEY("58"),
  });
  assert.equal(deniedActor.code, "42501", "authorization is evaluated before the input");

  const after = await counts(db);
  assert.deepEqual({ ...after,
    vendor_revisions: after.vendor_revisions - 1,
    audits: after.audits - 1,
    idempotency: after.idempotency - 1,
  }, before, "only the successful optional-reason update adds its revision, audit and idempotency record");
});

async function directEntryProbe(db, recruiterId) {
  try {
    await db.query(
      "insert into public.direct_entries"
      + " (recruiter_id, project_id, first_work_date, team_id, provider_type)"
      + " values ($1::uuid, 'W02B_PROBE', $2::date, $3::uuid, 'vendor')",
      [recruiterId, VALID_FROM, PROBE_TEAM_ID],
    );
    return null;
  } catch (error) {
    return { code: error.code, message: error.message };
  }
}

test("set-active follows the canonical representation recruiter and deletes nothing", async () => {
  const created = await createVendor(db, CATALOG, {
    id: "W02B_GAMMA", name: "Gamma Vendor", key: KEY("60"),
  });
  const before = await counts(db);

  // Baseline: with the representation recruiter active the Direct Entry identity
  // gate passes the recruiter check and stops on the non-existent probe team, so
  // the before/after contrast is exactly the Vendor active flag.
  assert.equal((await db.query("select 1 from public.teams where team_id = $1::uuid",
    [PROBE_TEAM_ID])).rows.length, 0, "the probe team must not exist");
  const activeProbe = await directEntryProbe(db, created.recruiter_id);
  assert.equal(activeProbe.code, "23514");
  assert.equal(activeProbe.message, "team is not active");

  const off = await rpc(db, "direct_entry_set_vendor_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: "W02B_GAMMA",
    p_active: false, p_expected_version: created.version, p_reason: REASON,
    p_idempotency_key: KEY("61"),
  });
  assert.equal(sortedKeys(off), [...MUTATION_KEYS].sort().join(","));
  assert.equal(off.active, false);
  assert.equal(off.version, created.version + 1);
  assert.equal(off.vendor_id, "W02B_GAMMA");
  assert.equal(off.recruiter_id, created.recruiter_id, "an inactive vendor still resolves its representation");

  const vendorRow = (await db.query(
    "select vendor_id, display_name, active, version from public.vendors where vendor_id = 'W02B_GAMMA'")).rows[0];
  assert.deepEqual(vendorRow, { vendor_id: "W02B_GAMMA",
    display_name: "Gamma Vendor", active: false, version: 2 });

  const recruiterRow = (await db.query(
    "select display_name, active, version from public.recruiters where recruiter_id = $1::uuid",
    [created.recruiter_id])).rows[0];
  assert.deepEqual(recruiterRow, { display_name: "Gamma Vendor", active: false, version: 2 },
    "the representation recruiter follows the vendor state in the same transaction");

  const memberships = (await db.query(
    "select provider_type, vendor_id, valid_to from public.recruiter_provider_memberships"
    + " where recruiter_id = $1::uuid", [created.recruiter_id])).rows;
  assert.deepEqual(memberships, [{ provider_type: "vendor", vendor_id: "W02B_GAMMA", valid_to: null }],
    "the membership interval row is kept, never deleted or closed");

  const afterOff = await counts(db);
  assert.equal(afterOff.vendors, before.vendors, "deactivation never deletes a vendor");
  assert.equal(afterOff.recruiters, before.recruiters, "deactivation never deletes a recruiter");
  assert.equal(afterOff.provider_memberships, before.provider_memberships);
  assert.equal(afterOff.vendor_revisions, before.vendor_revisions + 1);
  assert.equal(afterOff.audits, before.audits + 1);

  const audit = (await db.query(
    "select changed_fields from public.direct_entry_audit_events"
    + " where resource_ref = 'W02B_GAMMA' and action = 'vendor_set_active'")).rows[0];
  assert.deepEqual(audit.changed_fields, ["active", "representation_recruiter_active"]);

  const revision = (await db.query(
    "select version, before_snapshot, after_snapshot from public.direct_entry_vendor_revisions"
    + " where vendor_id = 'W02B_GAMMA' order by version desc limit 1")).rows[0];
  assert.equal(revision.version, 2);
  assertSnapshotShape(revision.before_snapshot, "set-active before");
  assert.deepEqual(revision.before_snapshot, { vendor_id: "W02B_GAMMA",
    display_name: "Gamma Vendor", active: true, version: 1 });
  assert.deepEqual(revision.after_snapshot, { vendor_id: "W02B_GAMMA",
    display_name: "Gamma Vendor", active: false, version: 2 });

  // Fail closed: the deactivated Vendor can no longer back a new Direct Entry row.
  const deactivatedProbe = await directEntryProbe(db, created.recruiter_id);
  assert.equal(deactivatedProbe.code, "23514");
  assert.equal(deactivatedProbe.message, "recruiter is not active");

  const hidden = await rpc(db, "direct_entry_list_vendors_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_search: "W02B_GAMMA", p_include_inactive: false, p_page: 1, p_page_size: 25,
  });
  assert.equal(hidden.total, 0, "an inactive vendor is not offered unless inactive rows are requested");

  const replay = await rpc(db, "direct_entry_set_vendor_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: "W02B_GAMMA",
    p_active: false, p_expected_version: created.version, p_reason: REASON,
    p_idempotency_key: KEY("61"),
  });
  assert.deepEqual(replay, off);
  assert.deepEqual(await counts(db), afterOff, "the replay writes nothing");

  // Reactivation restores exactly the same representation rows.
  const on = await rpc(db, "direct_entry_set_vendor_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: "W02B_GAMMA",
    p_active: true, p_expected_version: off.version, p_reason: REASON,
    p_idempotency_key: KEY("62"),
  });
  assert.equal(on.active, true);
  assert.equal(on.version, off.version + 1);
  assert.equal(on.recruiter_id, created.recruiter_id);

  const recruiterAgain = (await db.query(
    "select display_name, active from public.recruiters where recruiter_id = $1::uuid",
    [created.recruiter_id])).rows[0];
  assert.deepEqual(recruiterAgain, { display_name: "Gamma Vendor", active: true });
  assert.equal((await db.query(
    "select count(*)::int as c from public.recruiter_provider_memberships where recruiter_id = $1::uuid",
    [created.recruiter_id])).rows[0].c, 1, "reactivation adds no second membership");

  const afterOn = await counts(db);
  assert.equal(afterOn.vendors, afterOff.vendors);
  assert.equal(afterOn.recruiters, afterOff.recruiters);
  assert.equal(afterOn.vendor_revisions, afterOff.vendor_revisions + 1);
  assert.equal(afterOn.audits, afterOff.audits + 1);

  const activeAgain = await directEntryProbe(db, created.recruiter_id);
  assert.equal(activeAgain.message, "team is not active",
    "reactivation makes the representation recruiter usable again");
});

test("set-active rejects stale versions, no-ops and the reserved namespace with zero residue", async () => {
  const created = await createVendor(db, CATALOG, {
    id: "W02B_EPSILON", name: "Epsilon Vendor", key: KEY("69"),
  });
  const off = await rpc(db, "direct_entry_set_vendor_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: "W02B_EPSILON",
    p_active: false, p_expected_version: created.version, p_reason: REASON,
    p_idempotency_key: KEY("6a"),
  });
  const before = await counts(db);
  const setActive = (options) => rpcError(db, "direct_entry_set_vendor_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: options.id,
    p_active: options.active, p_expected_version: options.expected,
    p_reason: REASON, p_idempotency_key: options.key,
  });

  const stale = await setActive({ id: "W02B_EPSILON", active: true, expected: created.version,
    key: KEY("63") });
  assert.equal(stale.code, "PT409", "a stale expected_version is a conflict");

  const noop = await setActive({ id: "W02B_EPSILON", active: false, expected: off.version,
    key: KEY("64") });
  assert.equal(noop.code, "22023");
  assert.equal(noop.message, "vendor active state is unchanged");

  const reserved = await setActive({ id: RESERVED, active: false, expected: 1, key: KEY("65") });
  assert.equal(reserved.code, "P0002");

  const unknown = await setActive({ id: "W02B_UNKNOWN", active: false, expected: 1, key: KEY("66") });
  assert.equal(unknown.code, "P0002");

  const missingFlag = await rpcError(db, "direct_entry_set_vendor_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: "W02B_EPSILON",
    p_active: null, p_expected_version: off.version, p_reason: REASON, p_idempotency_key: KEY("67"),
  });
  assert.equal(missingFlag.code, "22023");
  assert.equal(missingFlag.message, "vendor active flag required");

  const denied = await rpcError(db, "direct_entry_set_vendor_active", {
    p_auth_subject: ENTRY_ADMIN_ONLY.auth, p_app_user_id: ENTRY_ADMIN_ONLY.app,
    p_vendor_id: "W02B_EPSILON", p_active: true, p_expected_version: off.version,
    p_reason: REASON, p_idempotency_key: KEY("68"),
  });
  assert.equal(denied.code, "42501");

  assert.deepEqual(await counts(db), before, "rejected set-active calls leave zero residue");
  assert.equal((await db.query("select active from public.vendors where vendor_id = 'W02B_EPSILON'"))
    .rows[0].active, false, "no rejected call mutated the vendor");
});

test("list and detail are bounded, stable, searchable and never expose the reserved namespace", async () => {
  const created = [];
  for (const [suffix, id, name] of [
    ["70", "W02B_L1", "List Alpha"],
    ["71", "W02B_L2", "List Beta"],
    ["72", "W02B_L3", "Zeta Alpha"],
    ["73", "W02B_L4", "List Delta"],
  ]) {
    created.push(await createVendor(db, CATALOG, { id, name, key: KEY(suffix) }));
  }

  const list = (params = {}) => rpc(db, "direct_entry_list_vendors_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app,
    p_search: params.search ?? "W02B", p_include_inactive: params.include_inactive ?? true,
    p_page: params.page ?? 1, p_page_size: params.page_size ?? 100,
  });

  const expected = (await db.query(
    "select vendor_id from public.vendors"
    + " where vendor_id <> '__system_vendor__'"
    + "   and (display_name ilike '%W02B%' or vendor_id ilike '%W02B%')"
    + " order by display_name, vendor_id")).rows.map((row) => row.vendor_id);

  const first = await list();
  assert.deepEqual(Object.keys(first).sort(),
    ["authorization_date", "include_inactive", "page", "page_size", "search", "total", "vendors"]);
  assert.equal(first.total, expected.length, "the total count matches the database");
  assert.deepEqual(first.vendors.map((vendor) => vendor.vendor_id), expected,
    "the list order is (display_name, vendor_id) and never drifts from the database");
  for (const vendor of first.vendors) {
    assert.equal(sortedKeys(vendor), [...ITEM_KEYS].sort().join(","));
    assert.equal(typeof vendor.recruiter_id, "string");
  }

  // Stability: identical input, identical bytes.
  assert.deepEqual(await list(), first, "the projection and the order are stable");
  assert.equal(typeof first.authorization_date, "string");
  assert.deepEqual(Object.values(first.vendors[0]).length, ITEM_KEYS.length);

  // Paging covers the bounded result exactly once, without overlap or gaps.
  const size = 2;
  const pages = Math.ceil(expected.length / size);
  const paged = [];
  for (let page = 1; page <= pages; page += 1) {
    const chunk = await list({ page, page_size: size });
    assert.equal(chunk.page, page);
    assert.equal(chunk.page_size, size);
    assert.equal(chunk.total, expected.length, "the total count is page independent");
    assert.ok(chunk.vendors.length <= size, "the page never exceeds page_size");
    paged.push(...chunk.vendors.map((vendor) => vendor.vendor_id));
  }
  assert.deepEqual(paged, expected, "paging is a partition of the deterministic order");

  // Search by vendor_id and by display_name, and the no-match case.
  const byId = await list({ search: "W02B_L3" });
  assert.deepEqual(byId.vendors.map((vendor) => vendor.vendor_id), ["W02B_L3"]);
  const byName = await list({ search: "zeta alpha" });
  assert.deepEqual(byName.vendors.map((vendor) => vendor.vendor_id), ["W02B_L3"]);
  assert.equal(byName.search, "zeta alpha", "the echo keeps the operator supplied search");
  assert.deepEqual(byName.vendors[0].display_name, "Zeta Alpha");
  const none = await list({ search: "W02B_NO_SUCH_VENDOR" });
  assert.equal(none.total, 0);
  assert.deepEqual(none.vendors, []);

  // The active filter hides an inactive vendor unless asked for.
  const deactivated = await rpc(db, "direct_entry_set_vendor_active", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: "W02B_L4",
    p_active: false, p_expected_version: created[3].version, p_reason: REASON,
    p_idempotency_key: KEY("74"),
  });
  const activeOnly = await list({ include_inactive: false });
  assert.ok(!activeOnly.vendors.some((vendor) => vendor.vendor_id === "W02B_L4"));
  assert.equal(activeOnly.include_inactive, false);
  const activeExpected = (await db.query(
    "select vendor_id from public.vendors"
    + " where vendor_id <> '__system_vendor__' and active"
    + "   and (display_name ilike '%W02B%' or vendor_id ilike '%W02B%')"
    + " order by display_name, vendor_id")).rows.map((row) => row.vendor_id);
  assert.deepEqual(activeOnly.vendors.map((vendor) => vendor.vendor_id), activeExpected);
  assert.equal(activeOnly.total, activeExpected.length);
  const all = await list({ include_inactive: true });
  assert.equal(all.total, expected.length);
  assert.ok(all.vendors.some((vendor) => vendor.vendor_id === "W02B_L4"));
  const detail = await rpc(db, "direct_entry_get_vendor_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: "W02B_L4",
  });
  assert.equal(sortedKeys(detail), [...ITEM_KEYS].sort().join(","));
  assert.equal(detail.active, false);
  assert.equal(detail.version, deactivated.version);

  // The reserved system namespace can never even be a business vendor row and is
  // never listed or readable.
  const reservedInsert = await rpcError(db, "direct_entry_get_vendor_admin", {
    p_auth_subject: CATALOG.auth, p_app_user_id: CATALOG.app, p_vendor_id: RESERVED,
  });
  assert.equal(reservedInsert.code, "P0002");
  let dbRejected = null;
  try {
    await db.query("insert into public.vendors (vendor_id, display_name, active, version)"
      + " values ($1, 'Reserved Vendor', true, 1)", [RESERVED]);
  } catch (error) {
    dbRejected = { code: error.code, message: error.message };
  }
  assert.equal(dbRejected?.code, "23514", "the #41 vendors check forbids the reserved vendor id");
  assert.equal((await db.query(
    "select count(*)::int as c from public.vendors where vendor_id = $1", [RESERVED])).rows[0].c, 0);
});

const RPC_SIGNATURES = [
  "public.direct_entry_list_vendors_admin(uuid,uuid,text,boolean,integer,integer)",
  "public.direct_entry_get_vendor_admin(uuid,uuid,text)",
  "public.direct_entry_create_vendor(uuid,uuid,integer,text,text,date,text,text)",
  "public.direct_entry_update_vendor(uuid,uuid,text,integer,text,text,text)",
  "public.direct_entry_set_vendor_active(uuid,uuid,text,boolean,integer,text,text)",
];
const HELPER_SIGNATURES = [
  "public.direct_entry_vendor_snapshot(public.vendors)",
  "public.direct_entry_vendor_representation_recruiter(text)",
  "public.direct_entry_vendor_admin_projection(public.vendors,integer,uuid)",
  "public.direct_entry_lock_vendor(text,integer)",
  "public.direct_entry_write_vendor_revision(text,integer,uuid,uuid,jsonb,jsonb)",
  "public.direct_entry_bump_vendor_version(text,uuid,uuid,jsonb)",
];
const CATALOG_TABLES = [
  "public.vendors", "public.recruiters", "public.recruiter_provider_memberships",
  "public.direct_entry_vendor_revisions",
];
const NO_DML_TABLES = CATALOG_TABLES;
const NO_READ_TABLES = ["public.vendors", "public.direct_entry_vendor_revisions"];

async function functionPrivilege(db, who, signature) {
  const { rows } = await db.query("select has_function_privilege($1, $2, 'EXECUTE') as granted",
    [who, signature]);
  return rows[0].granted;
}

async function tablePrivilege(db, who, table, privileges) {
  const { rows } = await db.query("select has_table_privilege($1, $2, $3) as granted",
    [who, table, privileges]);
  return rows[0].granted;
}

test("the ACL posture keeps vendor writes service-role only and the helpers unreachable", async () => {
  for (const signature of RPC_SIGNATURES) {
    assert.equal(await functionPrivilege(db, "service_role", signature), true, signature);
    assert.equal(await functionPrivilege(db, "anon", signature), false, signature);
    assert.equal(await functionPrivilege(db, "authenticated", signature), false, signature);
  }
  for (const signature of HELPER_SIGNATURES) {
    assert.equal(await functionPrivilege(db, "service_role", signature), false, signature);
    assert.equal(await functionPrivilege(db, "anon", signature), false, signature);
    assert.equal(await functionPrivilege(db, "authenticated", signature), false, signature);
  }
  // Every vendor write is a SECURITY DEFINER RPC: no role holds write DML on the
  // catalog tables themselves, and the revision history is unreadable to all.
  for (const table of NO_DML_TABLES) {
    for (const who of ["service_role", "anon", "authenticated"]) {
      assert.equal(await tablePrivilege(db, who, table, "INSERT,UPDATE,DELETE"), false, who + " " + table);
    }
  }
  for (const table of NO_READ_TABLES) {
    for (const who of ["service_role", "anon", "authenticated"]) {
      assert.equal(await tablePrivilege(db, who, table, "SELECT"), false, who + " " + table);
    }
  }

  const guardedNames = RPC_SIGNATURES.concat(HELPER_SIGNATURES)
    .map((signature) => signature.slice("public.".length).split("(")[0]);
  const guarded = (await db.query(
    "select p.proname, p.prosecdef, array_to_string(p.proconfig, ',') as config"
    + " from pg_proc p where p.proname = any($1::text[]) order by p.proname",
    [guardedNames])).rows;
  assert.equal(guarded.length, guardedNames.length);
  for (const row of guarded) {
    assert.equal(row.prosecdef, true, row.proname + " must be SECURITY DEFINER");
    assert.match(row.config, /search_path=pg_catalog, public/, row.proname);
  }

  const rls = (await db.query(
    "select relrowsecurity, relforcerowsecurity from pg_class"
    + " where oid = 'public.direct_entry_vendor_revisions'::regclass")).rows[0];
  assert.deepEqual(rls, { relrowsecurity: true, relforcerowsecurity: true });

  // A service-role session still cannot read or write the revision history, and an
  // anon session cannot call the administration RPCs at all.
  await db.query("begin");
  await db.query("set local role service_role");
  let revisionRead = null;
  try {
    await db.query("select count(*) from public.direct_entry_vendor_revisions");
  } catch (error) {
    revisionRead = error.code;
  }
  await db.query("rollback");
  assert.equal(revisionRead, "42501", "the revision history stays unreadable to service_role");

  await db.query("begin");
  await db.query("set local role anon");
  let anonCall = null;
  try {
    await db.query("select public.direct_entry_list_vendors_admin($1::uuid, $2::uuid, null, true, 1, 25)",
      [CATALOG.auth, CATALOG.app]);
  } catch (error) {
    anonCall = error.code;
  }
  await db.query("rollback");
  assert.equal(anonCall, "42501", "anon never reaches a vendor RPC");

  await db.query("begin");
  await db.query("set local role service_role");
  let directDml = null;
  try {
    await db.query("update public.vendors set display_name = 'Tampered' where vendor_id = 'W02B_L1'");
  } catch (error) {
    directDml = error.code;
  }
  await db.query("rollback");
  assert.equal(directDml, "42501", "service_role has no direct DML on the vendor catalog");
  assert.equal((await db.query(
    "select display_name from public.vendors where vendor_id = 'W02B_L1'")).rows[0].display_name, "List Alpha");
});

test("the vendor slot remains append-only and no earlier migration is touched", async (t) => {
  const names = (await readdir(MIGRATION_DIR)).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(names.indexOf(LEGACY_SCOPE_HOTFIX), 75, "the later #76 hotfix appends after W02-B");
  assert.equal(names.indexOf(NEW_MIGRATION), 74, "#75 remains the vendor lifecycle slot");
  assert.equal(names.indexOf(PREVIOUS_MIGRATION), 73, "#75 appends directly after the P3.1-HF report #74");
  assert.equal(new Set(names).size, names.length, "the ledger carries no duplicate slot");

  const git = spawnSync("git", ["status", "--porcelain", "--", "supabase/migrations"],
    { cwd: process.cwd(), encoding: "utf8" });
  if (git.error || git.status !== 0) {
    t.skip("git is not available in this environment");
    return;
  }
  const w03aMigration = "20261011150000_p3_1_w03a_app_user_lifecycle.sql";
  const w05bMigration = "20261011180000_p3_w05b_a_team_reporting.sql";
  const d2Migration = "20261013140000_pre_w2_hf_d2_active_duplicate_cccd_semantics.sql";
  const d3aMigration = "20261014180000_pre_w2_hf_d3_a_account_personnel_db.sql";
  const projectTeamMigration = "20261015100000_pre_w2_hf_project_team_authority.sql";
  const batchMappingMigration = "20261015130000_pre_w2_hf_project_team_batch_mapping.sql";
  const currentMigration = "20261015150000_pre_w2_worker_data_capabilities_default.sql";
  const directEntryWorkflowMigration = "20261015180000_pre_w2_hf_direct_entry_batch_workflow.sql";
  const changeRequestReviewHistoryMigration = "20261016110000_pre_w2_change_request_team_review_history.sql";
  const workerPortraitMigration = "20261017100000_pre_w2_s1_worker_portrait_private_projection.sql";
  const workerPortraitAccessGuardMigration =
    "20261017110000_pre_w2_s1_document_direct_context_access_guard.sql";
  const workerPortraitEnrollmentMigration =
    "20261018090000_w2_s1_worker_portrait_enrollment_staging.sql";
  const workerPortraitRecoveryMigration =
    "20261018110000_w2_s1_portrait_stage_recovery_cccd_scope.sql";
  const workerPortraitIdempotencyMigration =
    "20261018130000_w2_s1_portrait_stage_create_idempotency.sql";
  const workerPortraitTtlMigration =
    "20261018140000_w2_s1_portrait_stage_ttl_reaper.sql";
  const workerDetailReadScopeMigration =
    "20261018150000_w2_s1_worker_directory_detail_read_scope.sql";
  const workerDocumentStagingMigration =
    "20261018160000_w2_s1_worker_document_staging.sql";
  const multiDocumentBatchLimitMigration =
    "20261018170000_w2_s1_multi_document_stage_batch_limit.sql";
  const workerDirectoryFilteredSummaryMigration =
    "20261019120000_hf_worker_directory_filtered_summary.sql";
  const draftSubmissionDeleteMigration =
    "20261019130000_pre_w2_hf_draft_submission_delete.sql";
  const wf01Migration =
    "20261022090000_wf01_workforce_snapshot_and_transitions.sql";
  const wf02Migration =
    "20261022110000_wf02_workforce_balance_and_waiting_aging.sql";
  const wf03Migration =
    "20261022130000_wf03_workforce_tenure_presence_and_retention.sql";
  const wf04Migration =
    "20261022150000_wf04_workforce_dimensions_and_leave_reasons.sql";
  const wf04HotfixMigration =
    "20261022170000_wf04_hotfix_workforce_overview_and_project_pagination.sql";
  const dirty = git.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(dirty.filter((line) =>
    !line.endsWith(NEW_MIGRATION) &&
    !line.endsWith("20261020210000_r1_1_team_leader_direct_edit.sql") &&
    !line.endsWith("20261020220000_r1_1_optional_action_reasons.sql") &&
    !line.endsWith(directEntryWorkflowMigration) &&
    !line.endsWith(LEGACY_SCOPE_HOTFIX) &&
    !line.endsWith(w03aMigration) &&
    !line.endsWith(w05bMigration) &&
    !line.endsWith(d2Migration) &&
    !line.endsWith(d3aMigration) &&
    !line.endsWith(projectTeamMigration) &&
    !line.endsWith(batchMappingMigration) &&
    !line.endsWith(currentMigration) &&
    !line.endsWith(changeRequestReviewHistoryMigration) &&
    !line.endsWith(workerPortraitMigration) &&
    !line.endsWith(workerPortraitAccessGuardMigration) &&
    !line.endsWith(workerPortraitEnrollmentMigration) &&
    !line.endsWith(workerPortraitRecoveryMigration) &&
    !line.endsWith(workerPortraitIdempotencyMigration) &&
    !line.endsWith(workerPortraitTtlMigration) &&
    !line.endsWith(workerDetailReadScopeMigration) &&
    !line.endsWith(workerDocumentStagingMigration) &&
    !line.endsWith(multiDocumentBatchLimitMigration) &&
    !line.endsWith(workerDirectoryFilteredSummaryMigration) &&
    !line.endsWith(draftSubmissionDeleteMigration) &&
    !line.endsWith(wf01Migration) &&
    !line.endsWith(wf02Migration) &&
    !line.endsWith(wf03Migration) &&
    !line.endsWith(wf04Migration) &&
    !line.endsWith(wf04HotfixMigration) &&
    !line.endsWith("20261028100000_hf_postgrest_conflict_sqlstate_pt409.sql") &&
    !line.endsWith("20261030100000_hf_worker_profile_direct_edit_banking_and_documents.sql") &&
    !line.endsWith("20261025120000_vfin_01_vendor_finance_backend.sql") &&
    !line.endsWith("20261025150000_hf_work_reports_groups_and_analytics_options.sql") &&
    !line.endsWith("20261026090000_vfin_02_project_accountant_ledgers.sql")), [],
    "no earlier migration may be modified, deleted or renamed");

  const committed = spawnSync("git", ["show", `HEAD:supabase/migrations/${PREVIOUS_MIGRATION}`],
    { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (!committed.error && committed.status === 0) {
    const working = await readFile(path.join(MIGRATION_DIR, PREVIOUS_MIGRATION), "utf8");
    assert.equal(working.replace(/\r\n/g, "\n"), committed.stdout.replace(/\r\n/g, "\n"),
      "the previous migration is byte-identical to the committed revision");
  }
});

test("the new migration is additive only and never hard-codes the reserved namespace", async () => {
  const source = await readFile(path.join(MIGRATION_DIR, NEW_MIGRATION), "utf8");

  const tables = [...source.matchAll(/create table public\.([a-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual(tables, ["direct_entry_vendor_revisions"], "exactly one table is created");
  assert.ok(!/alter table public\.vendors/.test(source), "the #41 vendors table is never altered");
  const added = [...source.matchAll(/alter table public\.([a-z_]+)\s+add column ([a-z_]+)/g)]
    .map((match) => match[1] + "." + match[2]);
  assert.deepEqual(added, ["direct_entry_audit_events.vendor_revision_id"],
    "the only additive column is the audit binding");
  assert.ok(!/(drop table|drop column|alter column|truncate table|delete from)/i.test(source),
    "the migration is purely additive");
  assert.ok(!/disable row level security/i.test(source), "no RLS posture is weakened");

  const triggers = [...source.matchAll(/create trigger ([a-z_]+)/g)].map((match) => match[1]);
  assert.deepEqual(triggers, ["direct_entry_vendor_revisions_immutable"]);
  const functions = [...source.matchAll(/create or replace function public\.([a-z_]+)\(/g)]
    .map((match) => match[1]);
  assert.deepEqual(functions, [
    "direct_entry_vendor_snapshot",
    "direct_entry_vendor_representation_recruiter",
    "direct_entry_vendor_admin_projection",
    "direct_entry_lock_vendor",
    "direct_entry_write_vendor_revision",
    "direct_entry_bump_vendor_version",
    "direct_entry_list_vendors_admin",
    "direct_entry_get_vendor_admin",
    "direct_entry_create_vendor",
    "direct_entry_update_vendor",
    "direct_entry_set_vendor_active",
  ]);
  const granted = [...source.matchAll(/grant execute on function public\.([a-z_]+)\(/g)]
    .map((match) => match[1]);
  assert.equal(granted.length, 5, "only the five administration RPCs are granted");
  assert.equal(new Set(granted).size, 5);
  assert.ok(!granted.includes("direct_entry_assert_catalog_operator"),
    "the #68 guard is reused, never redefined or re-granted here");

  // The reserved namespace is a business key string, never a fixed UUID, and no
  // function body reaches the reserved system team helper (comments excluded).
  assert.ok(source.includes("'__system_vendor__'"));
  const executable = source.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.ok(!executable.includes("direct_entry_system_vendor_team_id("),
    "the reserved namespace is resolved by string, never through the system team id");
  assert.ok(!/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(source),
    "the migration hard-codes no UUID");
});
