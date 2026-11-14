import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decideAccountAccessPageAccess,
  decideAdminAreaAccess,
  decideChangeRequestsPageAccess,
  decideDirectEntryPageAccess,
  decideLaborTypeCatalogPageAccess,
  decideProjectOperationsPageAccess,
  decidePersonnelCatalogPageAccess,
  decideTeamCatalogPageAccess,
  decideVendorCatalogPageAccess,
  decideWorkerOperationsPageAccess,
  canManageProjectMasterFromActor,
  HISTORICAL_CHANGE_REQUEST_QUEUES,
  probeHistoricalChangeRequestAccess,
} from "./direct-entry-page-access.ts";
import {
  changeRequestsNavPredicate,
  workerOperationsNavPredicate,
} from "../navigation/registry-capability.ts";

function actor(capabilities) {
  return {
    ok: true,
    actor: {
      auth_subject: "s", app_user_id: "u", enabled: true,
      capabilities, scopes: [], self_recruiter_suggestion: null,
      session: { provider: "supabase", verification: "getUser", authenticated_at: null },
    },
  };
}

const reasons = [
  "UNAUTHENTICATED", "ACTOR_MAPPING_MISSING", "ACTOR_DISABLED",
  "ACTOR_REPOSITORY_MISSING", "ACTOR_REPOSITORY_INVALID",
  "AMBIGUOUS_RECRUITER_LINK", "AMBIGUOUS_TEAM_MEMBERSHIP",
];

function denied(reason) { return { ok: false, reason }; }

test("flag off -> NOT_FOUND", () => {
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: false, actor: actor(["entry_own"]) }), "NOT_FOUND");
});

test("resolution mapping", () => {
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("UNAUTHENTICATED") }), "REDIRECT_LOGIN");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("ACTOR_MAPPING_MISSING") }), "ACCOUNT_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("ACTOR_DISABLED") }), "ACCOUNT_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("ACTOR_REPOSITORY_MISSING") }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("ACTOR_REPOSITORY_INVALID") }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("AMBIGUOUS_RECRUITER_LINK") }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied("AMBIGUOUS_TEAM_MEMBERSHIP") }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: null }), "TEMPORARY_UNAVAILABLE");
});

test("capability gating: entry_own/team/admin ALLOW, khong co hoac khong lien quan -> ACCESS_DENIED", () => {
  for (const cap of ["entry_own", "entry_team", "entry_admin"]) {
    assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor([cap]) }), "ALLOW", cap);
  }
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor(["change_review"]) }), "ACCESS_DENIED");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor([
    "pii_view", "pii_export", "payment_view", "payment_edit",
  ]) }), "ACCESS_DENIED");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor([]) }), "ACCESS_DENIED");
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor(["entry_own", "change_review", "entry_admin"]) }), "ALLOW");
});

test("Worker Operations page gate mirrors the navigation predicate", () => {
  const cases = [
    [[], []],
    [["entry_admin"], [{ kind: "all", reference: "all" }]],
    [["change_review"], [{ kind: "all", reference: "all" }]],
    [["change_request_create"], [{ kind: "own", reference: "u" }]],
    [["team_manager_assign"], [{ kind: "team", reference: "t" }]],
    [["pii_view", "payment_view"], [{ kind: "all", reference: "all" }]],
  ];
  for (const [capabilities, scopes] of cases) {
    const resolved = actor(capabilities);
    resolved.actor.scopes = scopes;
    assert.equal(
      decideWorkerOperationsPageAccess({ uiEnabled: true, actor: resolved }) === "ALLOW",
      workerOperationsNavPredicate(resolved.actor),
    );
  }

  for (const tab of ["recruited", "uploader", "managed", "team", "all"]) {
    const tabOnlyActor = actor(tab === "uploader" ? ["submission_create"] : []);
    tabOnlyActor.actor.allowed_worker_tabs = [tab];
    assert.equal(
      decideWorkerOperationsPageAccess({ uiEnabled: true, actor: tabOnlyActor }),
      "ALLOW",
      `SQL-confirmed allowed_worker_tabs=[${tab}] must pass Worker Directory page gate`,
    );
    assert.equal(workerOperationsNavPredicate(tabOnlyActor.actor), true);
    assert.equal(
      decideDirectEntryPageAccess({ uiEnabled: true, actor: tabOnlyActor }),
      "ACCESS_DENIED",
      `allowed_worker_tabs=[${tab}] alone must not open /direct-entry input page`,
    );
  }

  const emptyTabsActor = actor(["submission_create"]);
  emptyTabsActor.actor.allowed_worker_tabs = [];
  assert.equal(
    decideWorkerOperationsPageAccess({ uiEnabled: true, actor: emptyTabsActor }),
    "ACCESS_DENIED",
  );
});

test("Change Requests page gate mirrors navigation predicate and admits active historical proposers", () => {
  const cases = [
    [[], []],
    [["entry_admin"], [{ kind: "all", reference: "all" }]],
    [["change_review"], [{ kind: "team", reference: "t" }]],
    [["change_request_create"], [{ kind: "own", reference: "u" }]],
    [["team_manager_assign"], [{ kind: "team", reference: "t" }]],
    [["pii_view", "payment_view"], [{ kind: "all", reference: "all" }]],
  ];
  for (const [capabilities, scopes] of cases) {
    const resolved = actor(capabilities);
    resolved.actor.scopes = scopes;
    assert.equal(
      decideChangeRequestsPageAccess({ uiEnabled: true, actor: resolved }) === "ALLOW",
      changeRequestsNavPredicate(resolved.actor),
    );
  }
  const reassignedProposer = actor([]);
  assert.equal(
    decideChangeRequestsPageAccess({ uiEnabled: true, actor: reassignedProposer, hasHistoricalRequests: true }),
    "ALLOW",
    "active actor with historical requests retains read-only access to their request history",
  );
  assert.equal(
    decideChangeRequestsPageAccess({ uiEnabled: true, actor: denied("ACTOR_DISABLED"), hasHistoricalRequests: true }),
    "ACCOUNT_UNAVAILABLE",
    "disabled actor never bypasses account status via historical requests",
  );
  assert.equal(
    decideChangeRequestsPageAccess({ uiEnabled: true, actor: denied("ACTOR_MAPPING_MISSING"), hasHistoricalRequests: true }),
    "ACCOUNT_UNAVAILABLE",
    "unmapped actor never bypasses account status via historical requests",
  );
});

test("probeHistoricalChangeRequestAccess queries explicit R2.1 queues and never state=null", async () => {
  assert.deepEqual(HISTORICAL_CHANGE_REQUEST_QUEUES, [
    "PROPOSER_PENDING",
    "PROPOSER_RESOLVED",
    "REVIEWER_RESOLVED",
  ]);

  for (const activeQueue of HISTORICAL_CHANGE_REQUEST_QUEUES) {
    const queriedStates = [];
    const probe = await probeHistoricalChangeRequestAccess({
      auth_subject: "sub-hist",
      app_user_id: "user-hist",
      listChangeRequests: async (query) => {
        assert.notEqual(query.state, null, "must never probe with state=null");
        assert.equal(query.page_size, 1);
        queriedStates.push(query.state);
        return {
          ok: true,
          data: {
            requests: query.state === activeQueue ? [{ request_id: "req-1" }] : [],
          },
        };
      },
    });
    assert.deepEqual(queriedStates.sort(), [...HISTORICAL_CHANGE_REQUEST_QUEUES].sort());
    assert.equal(probe.hasHistoricalRequests, true, `active queue ${activeQueue} grants historical access`);
    assert.equal(probe.hasProposerPending, activeQueue === "PROPOSER_PENDING");
    assert.equal(probe.hasProposerResolved, activeQueue === "PROPOSER_RESOLVED");
    assert.equal(probe.hasReviewerResolved, activeQueue === "REVIEWER_RESOLVED");
    assert.equal(
      decideChangeRequestsPageAccess({
        uiEnabled: true,
        actor: actor([]),
        historicalProbe: probe,
      }),
      "ALLOW",
    );
  }

  const emptyProbe = await probeHistoricalChangeRequestAccess({
    auth_subject: "sub-none",
    app_user_id: "user-none",
    listChangeRequests: async () => ({ ok: true, data: { requests: [] } }),
  });
  assert.equal(emptyProbe.hasHistoricalRequests, false);
  assert.equal(
    decideChangeRequestsPageAccess({
      uiEnabled: true,
      actor: actor([]),
      historicalProbe: emptyProbe,
    }),
    "ACCESS_DENIED",
  );
});

test("output union la gioi han va exhaustive", () => {
  const seen = new Set();
  for (const reason of reasons) seen.add(decideDirectEntryPageAccess({ uiEnabled: true, actor: denied(reason) }));
  seen.add(decideDirectEntryPageAccess({ uiEnabled: false, actor: null }));
  seen.add(decideDirectEntryPageAccess({ uiEnabled: true, actor: null }));
  seen.add(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor([]) }));
  seen.add(decideDirectEntryPageAccess({ uiEnabled: true, actor: actor(["entry_own"]) }));
  for (const value of seen) {
    assert.ok([
      "NOT_FOUND", "REDIRECT_LOGIN", "ACCOUNT_UNAVAILABLE",
      "TEMPORARY_UNAVAILABLE", "ACCESS_DENIED", "ALLOW",
    ].includes(value), value);
  }
});

test("Admin route decisions use all-scope catalog operator OR canonical Full Admin", () => {
  const fullAdmin = {
    ...actor(["entry_admin", "recruiter_master_manage", "team_master_manage"]),
    actor: {
      ...actor(["entry_admin", "recruiter_master_manage", "team_master_manage"]).actor,
      scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
    },
  };
  const accounting = {
    ...actor(["catalog_master_manage"]),
    actor: {
      ...actor(["catalog_master_manage"]).actor,
      scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
    },
  };
  for (const decide of [
    decideAdminAreaAccess,
    decidePersonnelCatalogPageAccess,
    decideTeamCatalogPageAccess,
    decideVendorCatalogPageAccess,
    decideLaborTypeCatalogPageAccess,
  ]) {
    assert.equal(decide({ actor: fullAdmin }), "ALLOW");
    assert.equal(decide({ actor: accounting }), "ALLOW");
    assert.equal(decide({ actor: actor(["catalog_master_manage"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: actor(["entry_admin"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: actor(["team_manager_assign"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: actor(["entry_own"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: actor(["entry_team"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: actor(["change_request_create"]) }), "ACCESS_DENIED");
    assert.equal(decide({ actor: { ok: false, reason: "ACTOR_DISABLED" } }), "ACCOUNT_UNAVAILABLE");
    assert.equal(decide({ actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" } }), "ACCOUNT_UNAVAILABLE");
    assert.equal(decide({ actor: { ok: false, reason: "AMBIGUOUS_TEAM_MEMBERSHIP" } }), "TEMPORARY_UNAVAILABLE");
    assert.equal(decide({ actor: { ok: false, reason: "AMBIGUOUS_RECRUITER_LINK" } }), "TEMPORARY_UNAVAILABLE");
  }
});

test("Account access decision allows only the canonical Full Admin triple at effective all", () => {
  const withAllScope = (capabilities) => ({
    ...actor(capabilities),
    actor: {
      ...actor(capabilities).actor,
      scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
    },
  });
  const triple = ["entry_admin", "recruiter_master_manage", "team_master_manage"];
  assert.equal(decideAccountAccessPageAccess({ actor: withAllScope(triple) }), "ALLOW");
  // Accounting catalog operator is DENIED: the broader Admin-area predicate must not apply here.
  assert.equal(decideAccountAccessPageAccess({ actor: withAllScope(["catalog_master_manage"]) }), "ACCESS_DENIED");
  // Project Admin (entry_admin@all without the triple) is DENIED.
  assert.equal(decideAccountAccessPageAccess({ actor: withAllScope(["entry_admin"]) }), "ACCESS_DENIED");
  // A partial triple is DENIED.
  assert.equal(decideAccountAccessPageAccess({ actor: withAllScope(["entry_admin", "recruiter_master_manage"]) }), "ACCESS_DENIED");
  // The triple without effective all scope is DENIED (actor() has empty scopes).
  assert.equal(decideAccountAccessPageAccess({ actor: actor(triple) }), "ACCESS_DENIED");
  // Leader and ordinary staff are DENIED.
  assert.equal(decideAccountAccessPageAccess({ actor: withAllScope(["team_manager_assign"]) }), "ACCESS_DENIED");
  assert.equal(decideAccountAccessPageAccess({ actor: withAllScope(["entry_own"]) }), "ACCESS_DENIED");
  assert.equal(decideAccountAccessPageAccess({ actor: withAllScope(["change_request_create"]) }), "ACCESS_DENIED");
  // Resolution failures fail closed with the shared decision taxonomy.
  assert.equal(decideAccountAccessPageAccess({ actor: { ok: false, reason: "UNAUTHENTICATED" } }), "REDIRECT_LOGIN");
  assert.equal(decideAccountAccessPageAccess({ actor: { ok: false, reason: "ACTOR_DISABLED" } }), "ACCOUNT_UNAVAILABLE");
  assert.equal(decideAccountAccessPageAccess({ actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" } }), "ACCOUNT_UNAVAILABLE");
  assert.equal(decideAccountAccessPageAccess({ actor: { ok: false, reason: "AMBIGUOUS_TEAM_MEMBERSHIP" } }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideAccountAccessPageAccess({ actor: { ok: false, reason: "AMBIGUOUS_RECRUITER_LINK" } }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideAccountAccessPageAccess({ actor: null }), "TEMPORARY_UNAVAILABLE");
});

test("Project Operations page admits Team Leader; mapping page stays Full Admin-only", () => {
  const all = [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }];
  const team = [{ kind: "team", reference: "team-1", valid_from: "2026-01-01", valid_to: null }];
  const withScopes = (capabilities, scopes) => ({
    ...actor(capabilities), actor: { ...actor(capabilities).actor, scopes },
  });
  assert.equal(decideProjectOperationsPageAccess({ uiEnabled: true,
    actor: withScopes(["team_manager_assign"], team) }), "ALLOW");
  assert.equal(canManageProjectMasterFromActor(withScopes(["entry_admin"], all)), true,
    "an Admin may create the first project after the empty list is loaded");
  assert.equal(canManageProjectMasterFromActor(withScopes(["catalog_master_manage"], all)), true,
    "a catalog operator may create the first project, matching the #72 authority order");
  assert.equal(canManageProjectMasterFromActor(withScopes(["team_manager_assign"], team)), false,
    "a Team Leader never receives project-master authority from an empty list");
  assert.equal(decideProjectOperationsPageAccess({ uiEnabled: true,
    actor: withScopes(["entry_admin"], all) }), "ALLOW");
  assert.equal(decideProjectOperationsPageAccess({ uiEnabled: true,
    actor: withScopes(["entry_team"], team) }), "ACCESS_DENIED");
  assert.equal(decideProjectOperationsPageAccess({ uiEnabled: true,
    actor: { ok: false, reason: "UNAUTHENTICATED" } }), "REDIRECT_LOGIN");
  assert.equal(decideProjectOperationsPageAccess({ uiEnabled: true,
    actor: { ok: false, reason: "ACTOR_DISABLED" } }), "ACCOUNT_UNAVAILABLE");

  const source = readFileSync(new URL("../../app/admin/catalog/project-team-scopes/page.tsx", import.meta.url), "utf8");
  assert.match(source, /decideAccountAccessPageAccess\(\{ actor \}\)/);
  assert.doesNotMatch(source, /decideAdminAreaAccess/);
  assert.match(source, /case "ACCESS_DENIED":\s*return <AccessDenied \/>/);
  const operationsPage = readFileSync(new URL("../../app/direct-entry/projects/page.tsx", import.meta.url), "utf8");
  assert.match(operationsPage, /canManageProjectMasterForEmptyList=\{canManageProjectMasterFromActor\(actor\)\}/);
});

test("WP4 Organization Persons page decision mirrors Full Admin triple and rejects BoD, Team Leader, Accounting, and Project Admin", async () => {
  const { decideOrganizationPersonsPageAccess } = await import("./direct-entry-page-access.ts");
  const withAll = (capabilities) => ({
    ...actor(capabilities),
    actor: {
      ...actor(capabilities).actor,
      scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
    },
  });
  const triple = ["entry_admin", "recruiter_master_manage", "team_master_manage"];
  assert.equal(decideOrganizationPersonsPageAccess({ actor: withAll(triple) }), "ALLOW");
  assert.equal(decideOrganizationPersonsPageAccess({ actor: withAll(["entry_privileged_edit"]) }), "ACCESS_DENIED");
  assert.equal(decideOrganizationPersonsPageAccess({ actor: withAll(["report_analytics_view", "report_view"]) }), "ACCESS_DENIED");
  assert.equal(decideOrganizationPersonsPageAccess({ actor: withAll(["catalog_master_manage"]) }), "ACCESS_DENIED");
  assert.equal(decideOrganizationPersonsPageAccess({ actor: withAll(["entry_admin"]) }), "ACCESS_DENIED");
  assert.equal(decideOrganizationPersonsPageAccess({ actor: withAll(["team_manager_assign"]) }), "ACCESS_DENIED");
  assert.equal(decideOrganizationPersonsPageAccess({ actor: { ok: false, reason: "UNAUTHENTICATED" } }), "REDIRECT_LOGIN");
  assert.equal(decideOrganizationPersonsPageAccess({ actor: { ok: false, reason: "ACTOR_DISABLED" } }), "ACCOUNT_UNAVAILABLE");
  assert.equal(decideOrganizationPersonsPageAccess({ actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" } }), "ACCOUNT_UNAVAILABLE");
});
