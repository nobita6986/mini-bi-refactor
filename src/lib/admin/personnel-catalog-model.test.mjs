import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPersonnelCreateRequest,
  buildPersonnelListQuery,
  buildPersonnelSetActiveRequest,
  buildPersonnelUpdateRequest,
  classifyPersonnelMutation,
  projectPersonnelCreate,
  projectPersonnelItem,
  projectPersonnelList,
  projectPersonnelListForQuery,
  projectPersonnelMutation,
  personnelConflictsForDialog,
  setPersonnelConflictLock,
} from "./personnel-catalog-model.ts";

const KEY = "91f6f4f5-5d32-4e59-8243-e1f8333dc801";

function personnel(overrides = {}) {
  return {
    recruiter_id: "80fd8d2a-f45a-4596-9ebd-213fb6246041",
    display_name: "Nguyen Van A",
    personnel_code: "HR-001",
    personnel_position: "STAFF",
    active: true,
    version: 3,
    hrp_valid_from: "2026-10-01",
    revision_count: 1,
    team_names: [],
    ...overrides,
  };
}

function validList() {
  return {
    authorization_date: "2026-10-09",
    include_inactive: false,
    search: null,
    page: 2,
    page_size: 25,
    total: 31,
    personnel: [personnel()],
  };
}

test("strict personnel list and item projectors reject malformed or widened payloads", () => {
  assert.equal(projectPersonnelList({ ok: true, list: validList() })?.personnel.length, 1);
  assert.equal(projectPersonnelList({ ok: true, list: validList(), debug: "unexpected" }), null);
  assert.equal(projectPersonnelList({ ok: true, list: { ...validList(), personnel: [personnel({ version: -1 })] } }), null);
  assert.equal(projectPersonnelListForQuery(
    { ok: true, list: validList() },
    { search: "", includeInactive: false, page: 2 },
  )?.page_size, 25);
  assert.equal(projectPersonnelListForQuery(
    { ok: true, list: validList() },
    { search: "", includeInactive: true, page: 2 },
  ), null);
  assert.equal(projectPersonnelListForQuery(
    { ok: true, list: validList() },
    { search: "Nguyen", includeInactive: false, page: 2 },
  ), null);
  assert.equal(projectPersonnelItem({ ok: true, personnel: personnel() })?.display_name, "Nguyen Van A");
  assert.equal(projectPersonnelItem({ ok: true, personnel: personnel(), user_email: "not-allowed" }), null);
  assert.equal(projectPersonnelItem({ ok: true, personnel: personnel({ active: "true" }) }), null);
});

test("list query always bounds page size and preserves search, inactive and page filters", () => {
  const query = buildPersonnelListQuery({ search: "  Nguyen  ", includeInactive: true, page: 2 });
  assert.ok(query);
  assert.equal(query.get("search"), "Nguyen");
  assert.equal(query.get("include_inactive"), "true");
  assert.equal(query.get("page"), "2");
  assert.equal(query.get("page_size"), "25");
  assert.equal(query.has("team_id"), false);
  const filters = { search: "Thu", includeInactive: false, page: 2 };
  assert.equal(buildPersonnelListQuery({ ...filters, teamId: KEY })?.get("team_id"), KEY);
  assert.equal(buildPersonnelListQuery({ ...filters, teamId: "invalid" }), null);
  assert.equal(buildPersonnelListQuery({ search: "x".repeat(257), includeInactive: false, page: 1 }), null);
  assert.equal(buildPersonnelListQuery({ search: "", includeInactive: false, page: 1001 }), null);
});

test("create request sends only the canonical W01B create keys and requires date/key", () => {
  const request = buildPersonnelCreateRequest({
    personnelCode: "HR/001",
    displayName: "Nguyen Van A",
    personnelPosition: "TEAM_LEADER",
    validFrom: "2024-02-29",
    reason: "Bổ sung hồ sơ",
    idempotencyKey: KEY,
  });
  assert.equal(request.ok, true);
  if (!request.ok) return;
  assert.deepEqual(Object.keys(request.body).sort(), [
    "display_name", "expected_version", "idempotency_key", "personnel_code",
    "personnel_position", "reason", "valid_from",
  ]);
  assert.equal(request.body.expected_version, 0);
  assert.equal(request.body.reason, "Bổ sung hồ sơ");
  assert.equal(request.body.idempotency_key, KEY);
  assert.equal(buildPersonnelCreateRequest({
    personnelCode: "HR-1",
    displayName: "A",
    personnelPosition: "STAFF",
    validFrom: "2026-02-30",
    reason: "Lý do",
    idempotencyKey: KEY,
  }).ok, false);
  const withoutReason = buildPersonnelCreateRequest({
    personnelCode: "HR-1", displayName: "A", personnelPosition: "STAFF",
    validFrom: "2026-02-28", idempotencyKey: KEY,
  });
  assert.equal(withoutReason.ok, true);
  if (withoutReason.ok) assert.equal(withoutReason.body.reason, null);
  const blankReason = buildPersonnelCreateRequest({
    personnelCode: "HR-1",
    displayName: "A",
    personnelPosition: "STAFF",
    validFrom: "2026-02-28",
    reason: " ",
    idempotencyKey: KEY,
  });
  assert.equal(blankReason.ok, true);
  if (blankReason.ok) assert.equal(blankReason.body.reason, null);
  assert.equal(buildPersonnelCreateRequest({
    personnelCode: "HR-1", displayName: "A", personnelPosition: "STAFF",
    validFrom: "2026-02-28", reason: "x".repeat(4001), idempotencyKey: KEY,
  }).ok, false);
});

test("update and set-active request bodies use authoritative version and exact keys", () => {
  const update = buildPersonnelUpdateRequest({
    personnelCode: "HR-001",
    displayName: "Nguyen Van A",
    personnelPosition: "STAFF",
    expectedVersion: 3,
    reason: "Điều chỉnh hồ sơ",
    idempotencyKey: KEY,
  });
  assert.equal(update.ok, true);
  if (update.ok) {
    assert.deepEqual(Object.keys(update.body).sort(), [
      "display_name", "expected_version", "idempotency_key", "personnel_code",
      "personnel_position", "reason",
    ]);
    assert.equal(update.body.expected_version, 3);
    assert.equal("active" in update.body, false);
  }
  assert.equal(buildPersonnelUpdateRequest({
    personnelCode: "HR-001",
    displayName: "Nguyen Van A",
    personnelPosition: "STAFF",
    expectedVersion: 0,
    reason: "Lý do",
    idempotencyKey: KEY,
  }).ok, false);

  const active = buildPersonnelSetActiveRequest({
    active: false,
    expectedVersion: 3,
    reason: "Hồ sơ không còn hiệu lực",
    idempotencyKey: KEY,
  });
  assert.equal(active.ok, true);
  if (active.ok) {
    assert.deepEqual(Object.keys(active.body).sort(), [
      "active", "expected_version", "idempotency_key", "reason",
    ]);
    assert.equal(active.body.active, false);
    assert.equal(active.body.expected_version, 3);
  }
});

test("strict mutation projections and sanitized conflict/error outcomes", () => {
  const mutation = {
    recruiter_id: personnel().recruiter_id,
    display_name: personnel().display_name,
    personnel_code: personnel().personnel_code,
    personnel_position: "STAFF",
    active: true,
    version: 4,
    revision_id: "2bfde843-e01a-4ba7-8ea1-8a3b4128741a",
  };
  assert.ok(projectPersonnelMutation({ ok: true, personnel: mutation }));
  assert.equal(projectPersonnelMutation({ ok: true, personnel: { ...mutation, raw_error: "db" } }), null);
  assert.equal(projectPersonnelCreate({ ok: true, personnel: { ...mutation, hrp_valid_from: "2026-10-09", created: true } })?.created, true);
  assert.equal(projectPersonnelCreate({ ok: true, personnel: { ...mutation, created: true } }), null);
  assert.equal(classifyPersonnelMutation(409, null, "update").kind, "conflict");
  assert.equal(classifyPersonnelMutation(403, null, "update").kind, "denied");
  assert.equal(classifyPersonnelMutation(200, {}, "update").kind, "unavailable");
  assert.equal(classifyPersonnelMutation(200, { ok: true, personnel: mutation }, "update").kind, "applied");
});

test("conflict locks remain until an explicit successful authoritative unlock", () => {
  const initial = new Set();
  const locked = setPersonnelConflictLock(initial, "entity-1", true);
  assert.equal(locked.has("entity-1"), true);
  assert.equal(initial.has("entity-1"), false);
  const unlocked = setPersonnelConflictLock(locked, "entity-1", false);
  assert.equal(unlocked.has("entity-1"), false);
});

test("dialog conflict selection isolates entity B from entity A", () => {
  const conflicts = new Map([
    ["personnel-A", { lockId: "personnel-A", error: "A reload failed" }],
    ["personnel-B", { lockId: "personnel-B", error: null }],
  ]);

  assert.deepEqual(personnelConflictsForDialog(conflicts, "personnel-B"), [
    { lockId: "personnel-B", error: null },
  ]);
  assert.deepEqual(personnelConflictsForDialog(conflicts, "personnel-A"), [
    { lockId: "personnel-A", error: "A reload failed" },
  ]);
  assert.deepEqual(personnelConflictsForDialog(conflicts, null), []);
  assert.deepEqual(personnelConflictsForDialog(conflicts, "personnel-C"), []);
});
