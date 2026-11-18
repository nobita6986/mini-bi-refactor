import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REPORTING_AUDIENCE_ALL_LABEL,
  REPORTING_AUDIENCE_OWN_FALLBACK_LABEL,
  reportingAudienceFromDb,
  resolveReportingAudienceKind,
} from "./p3-w05a-audience.ts";

function derivePairedGrantsForAudienceTest(scopes, capabilities) {
  const caps = capabilities ?? [];
  const grants = [];
  for (const s of scopes) {
    if (s.kind === "all") {
      for (const cap of caps.length > 0 ? caps : ["entry_admin"]) {
        grants.push({
          capability: cap,
          scope_kind: "ALL",
          scope_id: null,
          source_type: "LEGACY_BRIDGE",
          source_id: "30000000-0000-4000-8000-000000000001",
        });
      }
    } else if (s.kind === "team") {
      for (const cap of caps.length > 0 ? caps : ["entry_team"]) {
        grants.push({
          capability: cap,
          scope_kind: "CONTEXT_TEAM",
          scope_id: s.reference,
          source_type: "LEGACY_BRIDGE",
          source_id: "30000000-0000-4000-8000-000000000002",
        });
      }
    } else if (s.kind === "own") {
      for (const cap of caps.length > 0 ? caps : ["entry_own"]) {
        grants.push({
          capability: cap,
          scope_kind: "OWN",
          scope_id: null,
          source_type: "LEGACY_BRIDGE",
          source_id: "30000000-0000-4000-8000-000000000003",
        });
      }
    }
  }
  return grants;
}

function actorWith(scopes, capabilities, explicitGrants) {
  return {
    auth_subject: "10000000-0000-4000-8000-000000000001",
    app_user_id: "20000000-0000-4000-8000-000000000001",
    enabled: true,
    capabilities: capabilities ?? [],
    scopes,
    effective_grants: explicitGrants ?? derivePairedGrantsForAudienceTest(scopes, capabilities),
    self_recruiter_suggestion: null,
    session: { provider: "supabase", verification: "getUser", authenticated_at: null },
  };
}

function scope(kind, reference, valid_from, valid_to = null) {
  return { kind, reference, valid_from, valid_to };
}

test("audience priority: all beats team and own", () => {
  const actor = actorWith([
    scope("own", "u1", "0001-01-01"),
    scope("team", "t1", "2020-01-01"),
    scope("all", "all", "2020-01-01"),
  ]);
  assert.equal(resolveReportingAudienceKind(actor), "all");
});

test("audience priority: team beats synthetic own", () => {
  const actor = actorWith([
    scope("own", "u1", "0001-01-01"),
    scope("team", "t1", "2020-01-01"),
  ]);
  assert.equal(resolveReportingAudienceKind(actor), "team");
});

test("audience: no all/team resolves to own", () => {
  const actor = actorWith([scope("own", "u1", "0001-01-01")]);
  assert.equal(resolveReportingAudienceKind(actor), "own");
});

test("historic report periods do not narrow an already-current team scope", () => {
  const actor = actorWith([
    scope("own", "u1", "0001-01-01"),
    scope("team", "t1", "2026-10-01", "2026-10-07"),
  ]);
  assert.equal(resolveReportingAudienceKind(actor), "team");
});

test("reportingAudienceFromDb: normalizes a team audience", () => {
  assert.deepEqual(
    reportingAudienceFromDb({ audience: "team", label: "TEAM1", team_ids: ["t1"] }),
    { kind: "team", label: "TEAM1" },
  );
});

test("reportingAudienceFromDb: all audience keeps the fixed label", () => {
  assert.deepEqual(
    reportingAudienceFromDb({ audience: "all", label: REPORTING_AUDIENCE_ALL_LABEL }),
    { kind: "all", label: REPORTING_AUDIENCE_ALL_LABEL },
  );
});

test("reportingAudienceFromDb: own audience with missing label falls back safely", () => {
  assert.deepEqual(
    reportingAudienceFromDb({ audience: "own", label: "" }),
    { kind: "own", label: REPORTING_AUDIENCE_OWN_FALLBACK_LABEL },
  );
});

test("audience: unpaired or orphan all scope cannot elevate to all/team (WP5B-2 Group A)", () => {
  const orphanAll = actorWith([scope("all", "all", "2020-01-01")], [], []);
  assert.equal(resolveReportingAudienceKind(orphanAll), "own");
  const catalogCrossGrant = actorWith(
    [scope("all", "all", "2020-01-01"), scope("own", "u1", "2020-01-01")],
    ["catalog_master_manage", "entry_own"],
    [
      {
        capability: "catalog_master_manage",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "LEGACY_BRIDGE",
        source_id: "30000000-0000-4000-8000-000000000001",
      },
      {
        capability: "entry_own",
        scope_kind: "OWN",
        scope_id: null,
        source_type: "LEGACY_BRIDGE",
        source_id: "30000000-0000-4000-8000-000000000002",
      },
    ],
  );
  assert.equal(resolveReportingAudienceKind(catalogCrossGrant), "own");
});

test("reportingAudienceFromDb: malformed payload returns null (fail closed)", () => {
  assert.equal(reportingAudienceFromDb(null), null);
  assert.equal(reportingAudienceFromDb({}), null);
  assert.equal(reportingAudienceFromDb({ audience: "unknown", label: "x" }), null);
});

