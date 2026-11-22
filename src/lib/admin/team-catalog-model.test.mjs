import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildTeamCreateRequest,
  buildTeamListQuery,
  buildTeamSetActiveRequest,
  buildTeamUpdateRequest,
  classifyTeamMutation,
  parseActiveTeamCatalogOptions,
  projectTeamListForQuery,
  setTeamConflictLock,
  teamConflictsForDialog,
  teamListConfirmsCode,
  validateTeamCode,
} from "./team-catalog-model.ts";

const key = "55555555-5555-4555-8555-555555555555";
const teamId = "11111111-1111-4111-8111-111111111111";
const team = {
  team_id: teamId,
  code: "sales",
  display_name: "Sales",
  active: true,
  version: 2,
  revision_count: 2,
};

function listPayload(overrides = {}) {
  return {
    ok: true,
    list: {
      authorization_date: "2026-10-09",
      include_inactive: false,
      search: null,
      page: 1,
      page_size: 25,
      total: 1,
      teams: [team],
      ...overrides,
    },
  };
}

test("list query is bounded and always requests 25 rows", () => {
  const query = buildTeamListQuery({ search: " sales ", includeInactive: true, page: 1000 });
  assert.equal(query.get("search"), "sales");
  assert.equal(query.get("include_inactive"), "true");
  assert.equal(query.get("page"), "1000");
  assert.equal(query.get("page_size"), "25");
  assert.equal(buildTeamListQuery({ search: "x".repeat(257), includeInactive: false, page: 1 }), null);
  assert.equal(buildTeamListQuery({ search: "", includeInactive: false, page: 0 }), null);
  assert.equal(buildTeamListQuery({ search: "", includeInactive: false, page: 1001 }), null);
});

test("list projection checks exact envelope, query echo, page size, and reserved-team boundary", () => {
  const expected = { search: "", includeInactive: false, page: 1 };
  assert.ok(projectTeamListForQuery(listPayload(), expected));
  assert.equal(projectTeamListForQuery({ ...listPayload(), extra: true }, expected), null);
  assert.equal(projectTeamListForQuery(listPayload({ page_size: 20 }), expected), null);
  assert.equal(projectTeamListForQuery(listPayload({ search: "wrong" }), expected), null);
  assert.equal(projectTeamListForQuery(listPayload({
    teams: [{ ...team, code: "__system_vendor__" }],
  }), expected), null);
  const projected = projectTeamListForQuery(listPayload(), expected);
  assert.ok(projected);
  assert.equal(teamListConfirmsCode(projected, "sales"), true);
  assert.equal(teamListConfirmsCode(projected, "other"), false);
});

test("team code follows database bounds and rejects whitespace/control/reserved values", () => {
  assert.equal(validateTeamCode("A"), null);
  assert.equal(validateTeamCode("x".repeat(128)), null);
  assert.notEqual(validateTeamCode("x".repeat(129)), null);
  assert.notEqual(validateTeamCode("has space"), null);
  assert.notEqual(validateTeamCode(`x\u0085y`), null);
  assert.notEqual(validateTeamCode("__system_vendor__"), null);
  const source = readFileSync(new URL("./team-catalog-model.ts", import.meta.url));
  assert.equal(source.includes(0), false);
  assert.equal([...source].some((byte) => byte < 9 || (byte > 13 && byte < 32)), false);
  assert.match(source.toString(), /TEAM_CODE_PATTERN\s*=\s*\/\^\[\^\\s\\u0000-\\u001f\\u007f-\\u009f\]\+\$\//);
});

test("mutation builders emit exact least-authority bodies", () => {
  const create = buildTeamCreateRequest({
    code: "new-team", displayName: "New Team", reason: "Reason", idempotencyKey: key,
  });
  assert.equal(create.ok, true);
  assert.deepEqual(Object.keys(create.body).sort(), [
    "code", "display_name", "expected_version", "idempotency_key", "reason",
  ]);
  assert.equal(create.body.expected_version, 0);
  const noReason = buildTeamCreateRequest({ code: "new-team", displayName: "New Team", idempotencyKey: key });
  assert.equal(noReason.ok, true);
  if (noReason.ok) assert.equal(noReason.body.reason, null);

  const update = buildTeamUpdateRequest({
    displayName: "Renamed", expectedVersion: 2, reason: "Reason", idempotencyKey: key,
  });
  assert.equal(update.ok, true);
  assert.deepEqual(Object.keys(update.body).sort(), [
    "display_name", "expected_version", "idempotency_key", "reason",
  ]);
  assert.equal("code" in update.body, false);
  assert.equal("active" in update.body, false);

  const active = buildTeamSetActiveRequest({
    active: false, expectedVersion: 2, reason: "Reason", idempotencyKey: key,
  });
  assert.equal(active.ok, true);
  assert.deepEqual(Object.keys(active.body).sort(), [
    "active", "expected_version", "idempotency_key", "reason",
  ]);
  const blankReason = buildTeamCreateRequest({
    code: "valid", displayName: "Valid", reason: "", idempotencyKey: key,
  });
  assert.equal(blankReason.ok, true);
  if (blankReason.ok) assert.equal(blankReason.body.reason, null);
  assert.equal(buildTeamCreateRequest({
    code: "valid", displayName: "Valid", reason: "x".repeat(4001), idempotencyKey: key,
  }).ok, false);
});

test("sanitized mutation taxonomy distinguishes denied, missing, invalid, conflict, and unavailable", () => {
  assert.equal(classifyTeamMutation(401, null, "update").kind, "unauthenticated");
  assert.equal(classifyTeamMutation(403, null, "update").kind, "denied");
  assert.equal(classifyTeamMutation(404, null, "update").kind, "not-found");
  assert.equal(classifyTeamMutation(409, null, "update").kind, "conflict");
  assert.equal(classifyTeamMutation(400, null, "update").kind, "invalid");
  assert.equal(classifyTeamMutation(500, { message: "raw database detail" }, "update").kind, "unavailable");
});

test("conflict locks are entity scoped and dialog projection cannot leak another row", () => {
  const locks = setTeamConflictLock(setTeamConflictLock(new Set(), "A", true), "B", true);
  assert.deepEqual([...setTeamConflictLock(locks, "A", false)], ["B"]);
  const conflicts = new Map([["A", "conflict-A"], ["B", "conflict-B"]]);
  assert.deepEqual(teamConflictsForDialog(conflicts, "B"), ["conflict-B"]);
  assert.deepEqual(teamConflictsForDialog(conflicts, null), []);
});

test("UX-02: parseActiveTeamCatalogOptions parses canonical display_name contract, excludes inactive and __system_vendor__, and fails closed on fake/malformed shapes", () => {
  const activeA = {
    team_id: "11111111-1111-4111-8111-111111111111",
    code: "north",
    display_name: "Tổ Bắc",
    active: true,
    version: 1,
    revision_count: 1,
  };
  const activeB = {
    team_id: "22222222-2222-4222-8222-222222222222",
    code: "south",
    display_name: "Tổ Nam",
    active: true,
    version: 3,
    revision_count: 2,
  };
  const inactiveTeam = {
    team_id: "33333333-3333-4333-8333-333333333333",
    code: "legacy_inactive",
    display_name: "Tổ Ngừng",
    active: false,
    version: 2,
    revision_count: 2,
  };
  const systemVendorTeam = {
    team_id: "44444444-4444-4444-8444-444444444444",
    code: "__system_vendor__",
    display_name: "System Vendor",
    active: true,
    version: 1,
    revision_count: 1,
  };

  const parsed = parseActiveTeamCatalogOptions({
    ok: true,
    list: {
      authorization_date: "2026-11-22",
      include_inactive: false,
      search: null,
      page: 1,
      page_size: 100,
      total: 4,
      teams: [activeA, inactiveTeam, systemVendorTeam, activeB],
    },
  });
  assert.deepEqual(parsed, {
    ok: true,
    teams: [
      { team_id: activeA.team_id, code: "north", display_name: "Tổ Bắc", active: true },
      { team_id: activeB.team_id, code: "south", display_name: "Tổ Nam", active: true },
    ],
  });

  // Fails closed on legacy fake shape (`name`/`team_name` instead of canonical `display_name`) or malformed envelope
  assert.deepEqual(
    parseActiveTeamCatalogOptions({
      ok: true,
      list: {
        authorization_date: "2026-11-22",
        include_inactive: false,
        search: null,
        page: 1,
        page_size: 100,
        total: 1,
        teams: [{ team_id: activeA.team_id, code: "north", name: "Fake Name", active: true }],
      },
    }),
    { ok: false },
  );
  assert.deepEqual(parseActiveTeamCatalogOptions({ ok: false }), { ok: false });
  assert.deepEqual(parseActiveTeamCatalogOptions(null), { ok: false });
});
