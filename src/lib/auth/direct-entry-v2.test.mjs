import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CAPABILITIES,
  DIRECT_ENTRY_AUTH_CONTRACT_VERSION,
  authorizeDirectEntry,
  hasPairedCapability,
  resolveActor,
  resolveSelfRecruiterSuggestion,
  validateClientBusinessPayload,
} from "./direct-entry-v2.ts";
import { resolveDirectEntrySession } from "./direct-entry-session-core.ts";

const fixture = JSON.parse(readFileSync(
  new URL("../../../docs/contracts/fixtures/p1.6-w02/auth-fixture.json", import.meta.url),
  "utf8",
));
const timestamp = fixture.as_of;
const resourceRef = "00000000-0000-4000-8000-00000000a001";

test("authorization hardening is versioned", () => {
  assert.equal(DIRECT_ENTRY_AUTH_CONTRACT_VERSION, "direct-entry-auth/1.7");
  const retired = ["pii_view", "pii_export", "payment_view", "payment_edit"];
  assert.equal(CAPABILITIES.some((capability) => retired.includes(capability)), false);
  assert.ok(CAPABILITIES.includes("duplicate_cccd_withdraw"));
  assert.ok(CAPABILITIES.includes("worker_edit_history_view"));
});

function repositoryFor(person) {
  return {
    async loadByAuthSubject(authSubject) {
      return authSubject === person.auth_subject ? structuredClone(person.record) : null;
    },
  };
}

async function actorFor(person) {
  const result = await resolveActor({
    session: {
      auth_subject: person.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: repositoryFor(person),
    at: timestamp,
  });
  assert.equal(result.ok, true);
  return result.actor;
}

function ownResource(appUserId, currentVersion = 1) {
  return {
    reference: resourceRef,
    created_by_user_id: appUserId,
    current_version: currentVersion,
    scope: {
      kind: "own",
      reference: appUserId,
      effective_date: "2026-10-02",
    },
  };
}

function teamResource(teamId = "team_synthetic_01", date = "2026-10-02") {
  return {
    reference: resourceRef,
    created_by_user_id: null,
    current_version: 1,
    scope: { kind: "team", reference: teamId, effective_date: date },
  };
}

test("versioned actor contract resolves only trusted Supabase subject mapping", async () => {
  const actor = await actorFor(fixture.staff);
  assert.equal(actor.app_user_id, fixture.staff.record.app_user_id);
  assert.equal(actor.auth_subject, fixture.staff.auth_subject);
  assert.equal(actor.enabled, true);
  assert.equal(actor.session.provider, "supabase");
  assert.equal(actor.session.verification, "getUser");
  assert.equal("role" in actor, false);
});

test("legacy field grants resolve during compatibility but are inert", async () => {
  const actor = await actorFor(fixture.admin);
  assert.equal(actor.capabilities.includes("pii_view"), false);
  assert.equal(actor.capabilities.includes("pii_export"), false);
  assert.equal(actor.capabilities.includes("payment_view"), false);
  assert.equal(actor.capabilities.includes("payment_edit"), false);
  for (const action of ["pii_view", "pii_export", "payment_view", "payment_edit"]) {
    const decision = authorizeDirectEntry({
      actor: { ...actor, capabilities: [...actor.capabilities, action] },
      action,
      resource: {
        ...ownResource(fixture.staff.record.app_user_id),
        scope: { kind: "all", reference: "all", effective_date: "2020-01-01" },
      },
      timestamp,
      reason_ref: "reason_synthetic_01",
      expected_version: 1,
    });
    assert.equal(decision.code, "CAPABILITY_DENIED", action);
  }
});

test("missing authentication, disabled actor, and repository failures deny closed", async () => {
  assert.deepEqual(await resolveActor({
    session: null,
    repository: repositoryFor(fixture.admin),
    at: timestamp,
  }), { ok: false, reason: "UNAUTHENTICATED" });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: fixture.disabled.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: repositoryFor(fixture.disabled),
    at: timestamp,
  }), { ok: false, reason: "ACTOR_DISABLED" });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: fixture.staff.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: undefined,
    at: timestamp,
  }), { ok: false, reason: "ACTOR_REPOSITORY_MISSING" });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: fixture.staff.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: { async loadByAuthSubject() { return { app_user_id: "bad" }; } },
    at: timestamp,
  }), { ok: false, reason: "ACTOR_REPOSITORY_INVALID" });
  const wrongMapping = structuredClone(fixture.staff.record);
  wrongMapping.auth_subject = fixture.admin.auth_subject;
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: fixture.staff.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: { async loadByAuthSubject() { return wrongMapping; } },
    at: timestamp,
  }), { ok: false, reason: "ACTOR_REPOSITORY_INVALID" });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: fixture.staff.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: repositoryFor(fixture.admin),
    at: timestamp,
  }), { ok: false, reason: "ACTOR_MAPPING_MISSING" });
});

test("P2.5-HF-R5: a malformed display_name fails the actor projection closed", async () => {
  const malformed = [
    undefined, null, "", "   ", " padded", "padded ", "x".repeat(257), 42, {}, [],
  ];
  for (const bad of malformed) {
    const person = structuredClone(fixture.staff);
    if (bad === undefined) delete person.record.display_name;
    else person.record.display_name = bad;
    const result = await resolveActor({
      session: {
        auth_subject: person.auth_subject,
        provider: "supabase",
        authenticated_at: null,
      },
      repository: repositoryFor(person),
      at: timestamp,
    });
    assert.equal(result.ok, false, "must reject: " + JSON.stringify(bad));
    assert.equal(result.reason, "ACTOR_REPOSITORY_INVALID", JSON.stringify(bad));
  }
  const actor = await actorFor(fixture.staff);
  assert.equal(actor.display_name, "Synthetic Staff");
  assert.equal(JSON.stringify(actor).includes("@"), false, "no email may leak");
});

test("an ordinary staff member can create and act only in own scope", async () => {
  const actor = await actorFor(fixture.staff);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "entry_create",
    resource: { ...ownResource(actor.app_user_id, null), current_version: null },
    timestamp,
  }).allowed, true);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "entry_own",
    resource: ownResource(actor.app_user_id),
    timestamp,
    expected_version: 1,
  }).allowed, true);
  for (const action of ["submission_create", "change_request_create"]) {
    assert.equal(authorizeDirectEntry({
      actor,
      action,
      resource: ownResource(actor.app_user_id),
      timestamp,
      expected_version: 1,
    }).allowed, true, action);
  }

  const outside = authorizeDirectEntry({
    actor,
    action: "entry_own",
    resource: ownResource(fixture.admin.record.app_user_id),
    timestamp,
    expected_version: 1,
  });
  assert.equal(outside.allowed, false);
  assert.equal(outside.code, "SCOPE_DENIED");
});

test("client-supplied actor, role, capability, and scope fields are rejected", () => {
  assert.deepEqual(validateClientBusinessPayload({
    project_id: "project_synthetic_01",
    worker: { display_name: "Synthetic Person" },
  }), { ok: true });
  for (const payload of [
    { app_user_id: fixture.admin.record.app_user_id },
    { app_user: fixture.admin.record.app_user_id },
    { auth_subject: fixture.admin.auth_subject },
    { actor: { auth_subject: fixture.admin.auth_subject } },
    { rows: [{ worker: [{ created_by_user_id: fixture.admin.record.app_user_id }] }] },
    { rows: [{ team_id: "94000000-0000-4000-8000-000000000001" }] },
    { team: "94000000-0000-4000-8000-000000000001" },
    { rows: [{ provider_type: "vendor" }] },
    { provider: "vendor" },
    { created_by: fixture.admin.record.app_user_id },
    { role: "admin" },
    { capabilities: ["entry_admin"] },
    { scope: { kind: "all", reference: "all" } },
    { entry: { actor_id: fixture.admin.record.app_user_id } },
    { entry: { appUserId: fixture.admin.record.app_user_id } },
    { owner_user_id: fixture.admin.record.app_user_id },
    { owner: fixture.admin.record.app_user_id },
    { ownerUserId: fixture.admin.record.app_user_id },
    { "owner-user-id": fixture.admin.record.app_user_id },
    { row: { owner_user_id: fixture.admin.record.app_user_id } },
    { row: { ownerUserId: fixture.admin.record.app_user_id } },
    { rows: [{ "owner-user-id": fixture.admin.record.app_user_id }] },
  ]) {
    assert.equal(validateClientBusinessPayload(payload).ok, false);
  }
  assert.deepEqual(validateClientBusinessPayload({
    owner_label: "Synthetic value",
    ownership_note: "Business note",
  }), { ok: true });
});

test("ID equality never links recruiter and app user without a verified current link", async () => {
  const actor = await actorFor(fixture.staff);
  assert.equal(actor.self_recruiter_suggestion, null);
  assert.equal(resolveSelfRecruiterSuggestion({
    app_user_id: fixture.staff.record.app_user_id,
    links: [],
  }).kind, "none");
  assert.equal(resolveSelfRecruiterSuggestion({
    app_user_id: fixture.staff.record.app_user_id,
    links: [{
      app_user_id: fixture.staff.record.app_user_id,
      recruiter_id: fixture.staff.record.app_user_id,
      verified: false,
    }],
  }).kind, "none");
});

test("a verified recruiter link gives a suggestion but grants no capability", async () => {
  const noTeamScope = structuredClone(fixture.leader);
  noTeamScope.record.team_scope_grants = [];
  const actor = await actorFor(noTeamScope);
  assert.equal(actor.self_recruiter_suggestion, "rcr_synthetic_01");
  assert.deepEqual(actor.capabilities, ["entry_team", "change_review"]);
  assert.equal(actor.scopes.some((scope) => scope.kind === "team"), false);
  const leader = await actorFor(fixture.leader);
  assert.deepEqual(actor.scopes.filter((scope) => scope.kind === "team").map((scope) => ({
    reference: scope.reference,
    valid_from: scope.valid_from,
    valid_to: scope.valid_to,
  })), []);
  assert.deepEqual(leader.scopes.filter((scope) => scope.kind === "team").map((scope) => ({
    reference: scope.reference,
    valid_from: scope.valid_from,
    valid_to: scope.valid_to,
  })), [{
    reference: "team_synthetic_01",
    valid_from: "2026-09-01",
    valid_to: "2026-10-03",
  }]);
});

test("ambiguous current recruiter links and team scopes fail closed", async () => {
  const overlappingLinkPerson = structuredClone(fixture.leader);
  overlappingLinkPerson.record.recruiter_links.push({
    ...overlappingLinkPerson.record.recruiter_links[0],
    recruiter_id: "rcr_synthetic_02",
  });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: overlappingLinkPerson.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: repositoryFor(overlappingLinkPerson),
    at: timestamp,
  }), { ok: false, reason: "AMBIGUOUS_RECRUITER_LINK" });

  const overlappingTeamPerson = structuredClone(fixture.leader);
  overlappingTeamPerson.record.team_scope_grants.push({
    ...overlappingTeamPerson.record.team_scope_grants[0],
    valid_from: "2026-01-01",
  });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: overlappingTeamPerson.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: repositoryFor(overlappingTeamPerson),
    at: timestamp,
  }), { ok: false, reason: "AMBIGUOUS_TEAM_MEMBERSHIP" });

  const duplicateAllScope = structuredClone(fixture.admin);
  duplicateAllScope.record.all_scope_grants.push({
    ...duplicateAllScope.record.all_scope_grants[0],
  });
  assert.deepEqual(await resolveActor({
    session: {
      auth_subject: duplicateAllScope.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: repositoryFor(duplicateAllScope),
    at: timestamp,
  }), { ok: false, reason: "ACTOR_REPOSITORY_INVALID" });
});

test("current scope rows are authoritative; dates are inert metadata", async () => {
  const actor = await actorFor(fixture.leader);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "entry_team",
    resource: teamResource("team_synthetic_01", "1999-01-01"),
    timestamp,
    expected_version: 1,
  }).allowed, true);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "change_review",
    resource: teamResource("team_synthetic_01", "2020-01-01"),
    timestamp,
    reason_ref: "reason_synthetic_01",
    expected_version: 1,
  }).allowed, true);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "entry_team",
    resource: teamResource("team_synthetic_other"),
    timestamp,
    expected_version: 1,
  }).code, "SCOPE_DENIED");

  // Future or revoked rows are excluded by the actor RPC; they stay absent when time advances.
  const noCurrentGrant = structuredClone(fixture.leader);
  noCurrentGrant.record.team_scope_grants = [];
  for (const at of [timestamp, "2030-01-01T00:00:00.000Z"]) {
    const resolved = await resolveActor({
      session: {
        auth_subject: noCurrentGrant.auth_subject,
        provider: "supabase",
        authenticated_at: null,
      },
      repository: repositoryFor(noCurrentGrant),
      at,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.actor.scopes.some((scope) => scope.kind === "team"), false);
    assert.equal(authorizeDirectEntry({
      actor: resolved.actor,
      action: "entry_team",
      resource: teamResource("team_synthetic_01", "2020-01-01"),
      timestamp: at,
      expected_version: 1,
    }).code, "SCOPE_DENIED");
  }
});

test("accounting receives only explicitly granted review and status capabilities", async () => {
  const actor = await actorFor(fixture.accounting);
  for (const action of [
    "change_review",
    "entry_privileged_edit",
    "employment_status.apply",
  ]) {
    const decision = authorizeDirectEntry({
      actor,
      action,
      resource: { ...ownResource(fixture.admin.record.app_user_id, 3), scope: {
        kind: "all",
        reference: "all",
        effective_date: "2026-10-02",
      } },
      timestamp,
      reason_ref: "reason_synthetic_01",
      expected_version: 3,
    });
    assert.equal(decision.allowed, true, action);
  }
  assert.equal(authorizeDirectEntry({
    actor,
    action: "document_view",
    resource: teamResource(),
    timestamp,
  }).code, "CAPABILITY_DENIED");
});

test("read actions ignore resource versions while still checking capability and scope", async () => {
  const admin = await actorFor(fixture.admin);
  for (const action of [
    "document_view",
    "audit_view",
  ]) {
    const decision = authorizeDirectEntry({
      actor: admin,
      action,
      resource: {
        ...ownResource(fixture.staff.record.app_user_id, 7),
        scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
      },
      timestamp,
    });
    assert.equal(decision.allowed, true, action);
  }
});

test("only version-listed mutations require valid and current versions", async () => {
  const admin = await actorFor(fixture.admin);
  const versionedActions = [
    "change_review",
    "entry_privileged_edit",
    "employment_status.apply",
    "recruiter_master_manage",
    "team_master_manage",
    "entry_restore",
  ];

  for (const action of versionedActions) {
    const common = {
      actor: admin,
      action,
      resource: {
        ...ownResource(fixture.staff.record.app_user_id, 2),
        scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
      },
      timestamp,
      reason_ref: "reason_synthetic_01",
    };
    assert.equal(authorizeDirectEntry(common).code, "EXPECTED_VERSION_REQUIRED", action);
    assert.equal(authorizeDirectEntry({ ...common, expected_version: -1 }).code,
      "EXPECTED_VERSION_INVALID", action);
    assert.equal(authorizeDirectEntry({ ...common, expected_version: "2" }).code,
      "EXPECTED_VERSION_INVALID", action);
    assert.equal(authorizeDirectEntry({ ...common, expected_version: 1 }).code,
      "VERSION_CONFLICT", action);
    assert.equal(authorizeDirectEntry({ ...common, expected_version: 2 }).allowed,
      true, action);
  }
  assert.equal(authorizeDirectEntry({
    actor: admin,
    action: "submission_create",
    resource: {
      ...ownResource(fixture.staff.record.app_user_id, null),
      current_version: null,
      scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
    },
    timestamp,
  }).allowed, true);
});

test("privileged direct edit and status apply require reason and version", async () => {
  const accounting = await actorFor(fixture.accounting);
  for (const action of [
    "entry_privileged_edit",
    "employment_status.apply",
  ]) {
    const common = {
      actor: accounting,
      action,
      resource: {
        ...ownResource(fixture.staff.record.app_user_id, 2),
        scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
      },
      timestamp,
    };
    assert.equal(authorizeDirectEntry({ ...common, expected_version: 2 }).code,
      "REASON_REQUIRED", action);
    assert.equal(authorizeDirectEntry({
      ...common,
      reason_ref: "reason_synthetic_01",
    }).code, "EXPECTED_VERSION_REQUIRED", action);
    assert.equal(authorizeDirectEntry({
      ...common,
      reason_ref: "reason_synthetic_01",
      expected_version: 1,
    }).code, "VERSION_CONFLICT", action);
  }
});

test("entry actions require their bound own/team/all scope kind", async () => {
  const admin = await actorFor(fixture.admin);
  const teamGrantedAdmin = {
    ...admin,
    scopes: [...admin.scopes, {
      kind: "team",
      reference: "team_synthetic_01",
      valid_from: "2026-01-01",
      valid_to: null,
    }],
  };
  const mismatchCases = [
    {
      actor: teamGrantedAdmin,
      action: "entry_own",
      resource: teamResource(),
    },
    {
      actor: admin,
      action: "entry_own",
      resource: {
        ...ownResource(fixture.staff.record.app_user_id),
        scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
      },
    },
    {
      actor: admin,
      action: "entry_team",
      resource: ownResource(admin.app_user_id),
    },
    {
      actor: admin,
      action: "entry_team",
      resource: {
        ...teamResource(),
        scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
      },
    },
    {
      actor: admin,
      action: "entry_admin",
      resource: ownResource(admin.app_user_id),
    },
    {
      actor: teamGrantedAdmin,
      action: "entry_admin",
      resource: teamResource(),
    },
  ];
  for (const input of mismatchCases) {
    const decision = authorizeDirectEntry({
      ...input,
      timestamp,
      reason_ref: "reason_synthetic_01",
      expected_version: 1,
    });
    assert.equal(decision.allowed, false, input.action);
    assert.equal(decision.code, "ACTION_SCOPE_MISMATCH", input.action);
    assert.equal(decision.audit.denial_code, "ACTION_SCOPE_MISMATCH", input.action);
  }

  const noAllGrant = {
    ...admin,
    scopes: admin.scopes.filter((scope) => scope.kind !== "all"),
  };
  const noAllDecision = authorizeDirectEntry({
    actor: noAllGrant,
    action: "entry_admin",
    resource: {
      ...ownResource(fixture.staff.record.app_user_id, 1),
      scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
    },
    timestamp,
    reason_ref: "reason_synthetic_01",
    expected_version: 1,
  });
  assert.equal(noAllDecision.code, "SCOPE_DENIED");
});

test("all grants do not substitute for own or matching team grants", async () => {
  const admin = await actorFor(fixture.admin);
  const onlyAllScope = {
    ...admin,
    scopes: admin.scopes.filter((scope) => scope.kind === "all"),
  };
  assert.equal(authorizeDirectEntry({
    actor: onlyAllScope,
    action: "entry_own",
    resource: ownResource(fixture.staff.record.app_user_id),
    timestamp,
    expected_version: 1,
    reason_ref: "reason_synthetic_01",
  }).code, "SCOPE_DENIED");
  assert.equal(authorizeDirectEntry({
    actor: onlyAllScope,
    action: "entry_team",
    resource: teamResource(),
    timestamp,
    expected_version: 1,
    reason_ref: "reason_synthetic_01",
  }).code, "SCOPE_DENIED");
});

test("entry action/scope bindings allow exact own, team, and all grants", async () => {
  const staff = await actorFor(fixture.staff);
  assert.equal(authorizeDirectEntry({
    actor: staff,
    action: "entry_own",
    resource: ownResource(staff.app_user_id),
    timestamp,
  }).allowed, true);

  const leader = await actorFor(fixture.leader);
  assert.equal(authorizeDirectEntry({
    actor: leader,
    action: "entry_team",
    resource: teamResource(),
    timestamp,
  }).allowed, true);

  const admin = await actorFor(fixture.admin);
  const allDecision = authorizeDirectEntry({
    actor: admin,
    action: "entry_admin",
    resource: {
      ...ownResource(fixture.staff.record.app_user_id, 2),
      scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
    },
    timestamp,
    reason_ref: "reason_synthetic_01",
    expected_version: 2,
  });
  assert.equal(allDecision.allowed, true);
});

test("missing capability is denied before checking action/scope binding", async () => {
  const staff = await actorFor(fixture.staff);
  const decision = authorizeDirectEntry({
    actor: staff,
    action: "entry_team",
    resource: ownResource(staff.app_user_id),
    timestamp,
  });
  assert.equal(decision.code, "CAPABILITY_DENIED");
  assert.equal(decision.audit.denial_code, "CAPABILITY_DENIED");
});

test("scope mismatch audit retains only sanitized action and denial metadata", async () => {
  const admin = await actorFor(fixture.admin);
  const decision = authorizeDirectEntry({
    actor: admin,
    action: "entry_admin",
    resource: {
      ...ownResource(fixture.admin.app_user_id),
      reference: "123456789012",
    },
    timestamp,
  });
  assert.equal(decision.code, "ACTION_SCOPE_MISMATCH");
  assert.equal(decision.audit.denial_code, "ACTION_SCOPE_MISMATCH");
  const audit = JSON.stringify(decision.audit);
  for (const forbidden of ["123456789012", "account_number", "token", "@"]) {
    assert.equal(audit.includes(forbidden), false, forbidden);
  }
});

test("ordinary users cannot invoke privileged edits and audit contains the policy result", async () => {
  const staff = await actorFor(fixture.staff);
  const staffDecision = authorizeDirectEntry({
    actor: staff,
    action: "entry_privileged_edit",
    resource: ownResource(staff.app_user_id),
    timestamp,
    reason_ref: "reason_synthetic_01",
    expected_version: 1,
  });
  assert.equal(staffDecision.code, "CAPABILITY_DENIED");

  const admin = await actorFor(fixture.admin);
  const adminResource = ownResource(admin.app_user_id, 2);
  assert.equal(authorizeDirectEntry({
    actor: admin,
    action: "entry_privileged_edit",
    resource: adminResource,
    timestamp,
    expected_version: 2,
  }).code, "REASON_REQUIRED");
  assert.equal(authorizeDirectEntry({
    actor: admin,
    action: "entry_privileged_edit",
    resource: adminResource,
    timestamp,
    reason_ref: "reason_synthetic_01",
  }).code, "EXPECTED_VERSION_REQUIRED");
  const stale = authorizeDirectEntry({
    actor: admin,
    action: "entry_privileged_edit",
    resource: adminResource,
    timestamp,
    expected_version: 1,
    reason_ref: "reason_synthetic_01",
  });
  assert.equal(stale.code, "VERSION_CONFLICT");
  assert.equal(stale.audit.outcome, "DENY");
  assert.equal(stale.audit.reason_ref, "reason_synthetic_01");
  assert.equal(stale.audit.app_user_id, admin.app_user_id);
  assert.equal(authorizeDirectEntry({
    actor: admin,
    action: "entry_privileged_edit",
    resource: { ...adminResource, current_version: -1 },
    timestamp,
    expected_version: 0,
    reason_ref: "reason_synthetic_01",
  }).code, "RESOURCE_VERSION_INVALID");
});

test("Basic Auth is not a session or business actor", async () => {
  const decision = await resolveActor({
    session: null,
    repository: repositoryFor(fixture.admin),
    at: timestamp,
  });
  assert.deepEqual(decision, { ok: false, reason: "UNAUTHENTICATED" });
  const auditDecision = authorizeDirectEntry({
    actor: null,
    action: "entry_create",
    resource: ownResource(fixture.admin.record.app_user_id, null),
    timestamp,
  });
  assert.equal(auditDecision.allowed, false);
  assert.equal(auditDecision.audit.outcome, "DENY");
  assert.equal(auditDecision.audit.auth_subject, null);
  assert.equal(auditDecision.audit.app_user_id, null);
});

test("audit envelopes contain opaque references and no body, claim, token, or PII data", async () => {
  const actor = await actorFor(fixture.accounting);
  const decision = authorizeDirectEntry({
    actor,
    action: "entry_privileged_edit",
    resource: {
      ...ownResource(fixture.admin.record.app_user_id, 3),
      scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
    },
    timestamp,
    expected_version: 3,
    reason_ref: "reason_synthetic_01",
  });
  const serialized = JSON.stringify(decision.audit);
  for (const forbidden of ["@", "account_number", "auth_token", "refresh_token", "Synthetic Person"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(decision.audit).sort(), [
    "action",
    "app_user_id",
    "auth_subject",
    "capability",
    "denial_code",
    "outcome",
    "reason_ref",
    "resource_ref",
    "scope",
    "timestamp",
  ]);

  const rawIdentifier = authorizeDirectEntry({
    actor,
    action: "entry_privileged_edit",
    resource: {
      ...ownResource(fixture.admin.record.app_user_id, 3),
      reference: "123456789012",
      scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
    },
    timestamp,
    expected_version: 3,
    reason_ref: "reason_synthetic_01",
  });
  assert.equal(rawIdentifier.allowed, false);
  assert.equal(rawIdentifier.audit.resource_ref, null);
  assert.equal(authorizeDirectEntry({
    actor,
    action: "entry_privileged_edit",
    resource: {
      ...ownResource(fixture.admin.record.app_user_id, 3),
      scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
    },
    timestamp,
    expected_version: 3,
    reason_ref: "123456789012",
  }).code, "REASON_REQUIRED");
});

test("session adapter seam uses getUser and publishable key without exposing refreshed tokens", async () => {
  const fakeAccessToken = "synthetic-access-token-not-a-credential";
  const fakeRefreshToken = "synthetic-refresh-token-not-a-credential";
  const publishableKey = "synthetic-publishable-key";
  const serviceRoleKey = "synthetic-service-role-key";
  const storedCookies = [];
  let getUserCalls = 0;
  let getSessionCalls = 0;
  let clientKey = null;

  const result = await resolveDirectEntrySession({
    resolveActor,
    createClient: (_url, key, options) => {
      clientKey = key;
      return {
        auth: {
          async getUser() {
            getUserCalls += 1;
            options.cookies.setAll([
              {
                name: "sb-auth-token",
                value: fakeAccessToken,
                options: { httpOnly: true },
              },
              {
                name: "sb-refresh-token",
                value: fakeRefreshToken,
                options: { httpOnly: true },
              },
            ], {
              "Cache-Control": "private, no-store",
              Expires: "0",
              Pragma: "no-cache",
              "X-Private-Token": fakeRefreshToken,
            });
            return { data: { user: { id: fixture.admin.auth_subject } }, error: null };
          },
          async getSession() {
            getSessionCalls += 1;
            throw new Error("getSession must not be consulted");
          },
        },
      };
    },
    supabaseUrl: "https://synthetic.supabase.invalid",
    publishableKey,
    cookieStore: {
      getAll: () => [],
      set: (name, value, options) => storedCookies.push({ name, value, options }),
    },
    repository: repositoryFor(fixture.admin),
    at: timestamp,
  });

  assert.equal(clientKey, publishableKey);
  assert.notEqual(clientKey, serviceRoleKey);
  assert.equal(getUserCalls, 1);
  assert.equal(getSessionCalls, 0);
  assert.equal(result.actor.ok, true);
  assert.equal(storedCookies.length, 2);
  assert.deepEqual(result.response_headers, {
    "cache-control": "private, no-store",
    expires: "0",
    pragma: "no-cache",
  });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(fakeAccessToken), false);
  assert.equal(serialized.includes(fakeRefreshToken), false);
  assert.equal(serialized.includes(publishableKey), false);
});

test("session boundary denies missing or malformed repository mappings", async () => {
  const resolveWithRepository = (repository) => resolveDirectEntrySession({
    resolveActor,
    createClient: () => ({
      auth: {
        async getUser() {
          return { data: { user: { id: fixture.staff.auth_subject } }, error: null };
        },
      },
    }),
    supabaseUrl: "https://synthetic.supabase.invalid",
    publishableKey: "synthetic-publishable-key",
    cookieStore: { getAll: () => [], set() {} },
    repository,
    at: timestamp,
  });

  assert.deepEqual((await resolveWithRepository(undefined)).actor, {
    ok: false,
    reason: "ACTOR_REPOSITORY_MISSING",
  });
  assert.deepEqual((await resolveWithRepository({
    async loadByAuthSubject() {
      return { auth_subject: fixture.admin.auth_subject };
    },
  })).actor, {
    ok: false,
    reason: "ACTOR_REPOSITORY_INVALID",
  });
});

test("WP5B-1 resolveActor parses effective_grants and assigned_roles and rejects malformed arrays", async () => {
  const teamId = "00000000-0000-4000-8000-000000000501";
  const assignmentId = "00000000-0000-4000-8000-000000000502";
  const recordWithPaired = {
    ...structuredClone(fixture.staff.record),
    effective_grants: [
      {
        capability: "entry_own",
        scope_kind: "OWN",
        scope_id: null,
        source_type: "ROLE_BUNDLE",
        source_id: assignmentId,
      },
      {
        capability: "entry_team",
        scope_kind: "CONTEXT_TEAM",
        scope_id: teamId,
        source_type: "CONTEXTUAL_ASSIGNMENT",
        source_id: "00000000-0000-4000-8000-000000000503",
      },
    ],
    assigned_roles: [
      {
        role_code: "RECRUITER",
        display_name: "Tuyển dụng (Recruiter)",
        assignment_mode: "GLOBAL",
        scope_kind: null,
        scope_id: null,
        assignment_id: assignmentId,
        is_protected: false,
        can_revoke: true,
        cannot_revoke_reason: null,
      },
    ],
  };

  const valid = await resolveActor({
    session: {
      auth_subject: fixture.staff.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: {
      async loadByAuthSubject() {
        return structuredClone(recordWithPaired);
      },
    },
    at: timestamp,
  });

  assert.equal(valid.ok, true);
  assert.deepEqual(valid.actor.effective_grants, recordWithPaired.effective_grants);
  assert.deepEqual(valid.actor.assigned_roles, recordWithPaired.assigned_roles);

  const malformedEffective = await resolveActor({
    session: {
      auth_subject: fixture.staff.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: {
      async loadByAuthSubject() {
        return {
          ...structuredClone(fixture.staff.record),
          effective_grants: [{ capability: "entry_own", scope_kind: "ALL", scope_id: null, source_type: "BOGUS", source_id: null }],
        };
      },
    },
    at: timestamp,
  });
  assert.deepEqual(malformedEffective, { ok: false, reason: "ACTOR_REPOSITORY_INVALID" });

  const malformedAssigned = await resolveActor({
    session: {
      auth_subject: fixture.staff.auth_subject,
      provider: "supabase",
      authenticated_at: null,
    },
    repository: {
      async loadByAuthSubject() {
        return {
          ...structuredClone(fixture.staff.record),
          assigned_roles: [{ role_code: "BOD_ADMIN", display_name: "Legacy" }],
        };
      },
    },
    at: timestamp,
  });
  assert.deepEqual(malformedAssigned, { ok: false, reason: "ACTOR_REPOSITORY_INVALID" });
});

test("WP5B-1 hasPairedCapability fails closed, blocks cross-capability scope leakage, and checks exact contextual scope_id", async () => {
  assert.equal(hasPairedCapability(null, "entry_admin", { kind: "all" }), false);
  assert.equal(hasPairedCapability(undefined, "entry_admin", { kind: "all" }), false);

  const baseActor = await actorFor(fixture.admin);
  assert.equal(
    hasPairedCapability({ ...baseActor, effective_grants: undefined }, "entry_admin", { kind: "all" }),
    false,
    "missing effective_grants must NOT fall back to legacy capabilities + all scope",
  );
  assert.equal(
    hasPairedCapability({ ...baseActor, effective_grants: [] }, "entry_admin", { kind: "all" }),
    false,
    "empty effective_grants must fail closed despite legacy capabilities + all scope",
  );

  const teamA = "00000000-0000-4000-8000-000000000601";
  const teamB = "00000000-0000-4000-8000-000000000602";
  const deptA = "00000000-0000-4000-8000-000000000603";
  const deptB = "00000000-0000-4000-8000-000000000604";

  const pairedActor = {
    ...baseActor,
    enabled: true,
    effective_grants: [
      {
        capability: "entry_own",
        scope_kind: "OWN",
        scope_id: null,
        source_type: "ROLE_BUNDLE",
        source_id: null,
      },
      {
        capability: "audit_view",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "ROLE_BUNDLE",
        source_id: null,
      },
      {
        capability: "entry_team",
        scope_kind: "CONTEXT_TEAM",
        scope_id: teamA,
        source_type: "CONTEXTUAL_ASSIGNMENT",
        source_id: null,
      },
      {
        capability: "report_view",
        scope_kind: "CONTEXT_DEPARTMENT",
        scope_id: deptA,
        source_type: "DIRECT_GRANT",
        source_id: null,
      },
      {
        capability: "vendor_finance_view",
        scope_kind: "CONTEXT_PROJECT",
        scope_id: "proj_alpha",
        source_type: "CONTEXTUAL_ASSIGNMENT",
        source_id: null,
      },
    ],
  };

  assert.equal(hasPairedCapability(pairedActor, "entry_own", { kind: "own" }), true);
  assert.equal(hasPairedCapability(pairedActor, "audit_view", { kind: "all" }), true);
  assert.equal(
    hasPairedCapability(pairedActor, "entry_own", { kind: "all" }),
    false,
    "audit_view@ALL must NOT elevate entry_own@OWN to ALL",
  );
  assert.equal(
    hasPairedCapability(pairedActor, "audit_view", { kind: "own" }),
    false,
    "audit_view@ALL is strictly paired with ALL unless OWN grant is explicitly present",
  );

  assert.equal(hasPairedCapability(pairedActor, "entry_team", { kind: "team", team_id: teamA }), true);
  assert.equal(hasPairedCapability(pairedActor, "entry_team", { kind: "team", team_id: teamB }), false);

  assert.equal(hasPairedCapability(pairedActor, "report_view", { kind: "department", department_id: deptA }), true);
  assert.equal(hasPairedCapability(pairedActor, "report_view", { kind: "department", department_id: deptB }), false);

  assert.equal(hasPairedCapability(pairedActor, "vendor_finance_view", { kind: "project", project_id: "proj_alpha" }), true);
  assert.equal(hasPairedCapability(pairedActor, "vendor_finance_view", { kind: "project", project_id: "proj_beta" }), false);

  assert.equal(
    hasPairedCapability({ ...pairedActor, enabled: false }, "audit_view", { kind: "all" }),
    false,
    "disabled actor must fail closed even with populated effective_grants",
  );
});

test("WP5B-1 authorizeDirectEntry uses paired effective_grants when present and legacy arrays only when undefined", async () => {
  const adminBase = await actorFor(fixture.admin);
  const staffId = fixture.staff.record.app_user_id;

  // Legacy path when effective_grants is undefined
  const legacyAllowed = authorizeDirectEntry({
    actor: {
      ...adminBase,
      capabilities: ["document_view"],
      scopes: [{ kind: "all", reference: "all", valid_from: "2020-01-01", valid_to: null }],
      effective_grants: undefined,
    },
    action: "document_view",
    resource: {
      ...ownResource(staffId),
      scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
    },
    timestamp,
  });
  assert.equal(legacyAllowed.allowed, true);

  // Paired path blocks cross-capability scope leakage even when legacy arrays are broad
  const pairedActor = {
    ...adminBase,
    capabilities: ["document_view", "audit_view"],
    scopes: [{ kind: "all", reference: "all", valid_from: "2020-01-01", valid_to: null }],
    effective_grants: [
      {
        capability: "document_view",
        scope_kind: "OWN",
        scope_id: null,
        source_type: "ROLE_BUNDLE",
        source_id: null,
      },
      {
        capability: "audit_view",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "ROLE_BUNDLE",
        source_id: null,
      },
    ],
  };

  const pairedDenied = authorizeDirectEntry({
    actor: pairedActor,
    action: "document_view",
    resource: {
      ...ownResource(adminBase.app_user_id),
      scope: { kind: "all", reference: "all", effective_date: "2026-10-02" },
    },
    timestamp,
  });
  assert.equal(pairedDenied.allowed, false);
  assert.equal(pairedDenied.code, "SCOPE_DENIED");

  const pairedOwnAllowed = authorizeDirectEntry({
    actor: pairedActor,
    action: "document_view",
    resource: ownResource(adminBase.app_user_id),
    timestamp,
  });
  assert.equal(pairedOwnAllowed.allowed, true);
});
