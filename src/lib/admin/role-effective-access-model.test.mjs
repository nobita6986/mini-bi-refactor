import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CAPABILITIES } from "../auth/direct-entry-v2.ts";
import {
  buildAccountsSummaryUrlQuery,
  buildAssignGlobalRoleRequest,
  buildRevokeGlobalRoleRequest,
  canAssignNewGlobalRoleToAccount,
  CAPABILITY_PRESENTATION_MAP,
  classifyRoleMutationResponse,
  classifyRoleReadFailure,
  describeCannotRevokeReason,
  describeInactiveOrBlockingReason,
  formatAccountDisplayIdentity,
  formatAuthzTimestampVi,
  groupEffectiveGrantsByDomain,
  isStaleMutationReplay,
  newRoleMutationIdempotencyKey,
  projectAccountAccessForTarget,
  projectAccountsSummaryForQuery,
  projectRoleMutationEnvelope,
  projectRolesCatalogEnvelope,
  resolveAssignableGlobalRoles,
  resolveContextualAssignmentPresentation,
  resolveModuleAuthorityPresentation,
  resolveRoleCatalogFilters,
  splitOpenAndEndedDirectExceptions,
  splitOpenAndEndedGlobalRoles,
} from "./role-effective-access-model.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const fixtures = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs/contracts/fixtures/wp5b1-role-access/role-access-fixtures.json"),
    "utf8",
  ),
);

test("buildAccountsSummaryUrlQuery omits empty search and all role_code while keeping canonical pagination", () => {
  const defaultQuery = buildAccountsSummaryUrlQuery({
    search: "   ",
    enabled: "all",
    roleCode: "all",
    page: 1,
    pageSize: 20,
  });
  assert.equal(defaultQuery.ok, true);
  assert.equal(defaultQuery.params.has("search"), false);
  assert.equal(defaultQuery.params.has("role_code"), false);
  assert.equal(defaultQuery.params.get("enabled"), "all");
  assert.equal(defaultQuery.params.get("page"), "1");
  assert.equal(defaultQuery.params.get("page_size"), "20");
  assert.deepEqual(defaultQuery.query, fixtures.requests.list_accounts_summary.default);

  const filteredQuery = buildAccountsSummaryUrlQuery({
    search: " Minh ",
    enabled: "true",
    roleCode: "ADMIN",
    page: 1,
    pageSize: 10,
  });
  assert.equal(filteredQuery.ok, true);
  assert.equal(filteredQuery.params.get("search"), "Minh");
  assert.equal(filteredQuery.params.get("role_code"), "ADMIN");
  assert.deepEqual(filteredQuery.query, fixtures.requests.list_accounts_summary.filtered_admin);

  const badControl = buildAccountsSummaryUrlQuery({
    search: "bad\u0007term",
    enabled: "all",
    roleCode: "all",
    page: 1,
  });
  assert.equal(badControl.ok, false);
});

test("API envelope projectors accept valid contract payloads and fail closed on query/target mismatches", () => {
  const rolesEnvelope = projectRolesCatalogEnvelope({
    ok: true,
    ...fixtures.responses.roles_catalog,
  });
  assert.ok(rolesEnvelope);
  assert.equal(rolesEnvelope.roles.length, 8);
  assert.equal(projectRolesCatalogEnvelope({ ok: false, error: { code: "NOT_FOUND" } }), null);

  const summaryRes = buildAccountsSummaryUrlQuery({
    search: "",
    enabled: "all",
    roleCode: "all",
    page: 1,
    pageSize: 20,
  });
  assert.equal(summaryRes.ok, true);
  const projectedSummary = projectAccountsSummaryForQuery(
    { ok: true, list: fixtures.responses.accounts_summary },
    summaryRes.query,
  );
  assert.ok(projectedSummary);
  assert.equal(projectedSummary.accounts.length, 3);

  // Echo mismatch (e.g., server returned page 2 while client queried page 1) fails closed
  assert.equal(
    projectAccountsSummaryForQuery(
      { ok: true, list: { ...fixtures.responses.accounts_summary, page: 2 } },
      summaryRes.query,
    ),
    null,
  );

  const memberFixture =
    fixtures.responses.account_access_detail.member_admin_revocable_with_contextual_and_exception;
  const projectedDetail = projectAccountAccessForTarget(
    { ok: true, ...memberFixture },
    memberFixture.account.account_ref,
  );
  assert.ok(projectedDetail);
  assert.equal(projectedDetail.account.version, 3);
  assert.equal(
    projectAccountAccessForTarget(
      { ok: true, ...memberFixture },
      "11111111-1111-4111-8111-111111111111",
    ),
    null,
  );

  const createdMutation = projectRoleMutationEnvelope(
    { ok: true, ...fixtures.responses.mutations.assign_global_role_created },
    memberFixture.account.account_ref,
  );
  assert.ok(createdMutation);
  assert.equal(createdMutation.replayed, false);
  assert.equal(createdMutation.account_version, 4);
  assert.equal(
    projectRoleMutationEnvelope(
      { ok: true, ...fixtures.responses.mutations.assign_global_role_created },
      "11111111-1111-4111-8111-111111111111",
    ),
    null,
  );
});

test("resolveAssignableGlobalRoles restricts assignments to 4 global roles and displays ADMIN as BoD/Admin", () => {
  const assignable = resolveAssignableGlobalRoles(fixtures.responses.roles_catalog.roles);
  assert.deepEqual(
    assignable.map((r) => r.role_code),
    ["EMPLOYEE_BASE", "RECRUITER", "HR_OPERATOR", "ADMIN"],
  );
  const adminRole = assignable.find((r) => r.role_code === "ADMIN");
  assert.equal(adminRole?.display_name, "BoD/Admin");

  const filterGroups = resolveRoleCatalogFilters(fixtures.responses.roles_catalog.roles);
  assert.equal(filterGroups.globalRoles.length, 4);
  assert.deepEqual(
    filterGroups.contextualRoles.map((r) => r.role_code),
    ["TEAM_LEADER", "DEPARTMENT_HEAD", "PROJECT_MANAGER", "PROJECT_ACCOUNTANT"],
  );
});

test("CAPABILITY_PRESENTATION_MAP covers all 30 canonical capabilities and groups effective grants cleanly", () => {
  assert.equal(CAPABILITIES.length, 30);
  for (const cap of CAPABILITIES) {
    const meta = CAPABILITY_PRESENTATION_MAP[cap];
    assert.ok(meta, `Missing presentation for capability ${cap}`);
    assert.ok(meta.label.trim().length > 0);
    assert.notEqual(meta.label, cap);
  }

  const memberDetail = projectAccountAccessForTarget(
    {
      ok: true,
      ...fixtures.responses.account_access_detail
        .member_admin_revocable_with_contextual_and_exception,
    },
    "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
  );
  assert.ok(memberDetail);
  const groups = groupEffectiveGrantsByDomain(memberDetail);
  assert.ok(groups.length >= 1);
  assert.ok(groups.every((g) => g.items.length > 0 && g.domain.title.length > 0));

  const disabledDetail = projectAccountAccessForTarget(
    {
      ok: true,
      ...fixtures.responses.account_access_detail.disabled_account_d10_zero_effective_grants,
    },
    "aaaaaaaa-aaaa-4aaa-8aaa-000000000003",
  );
  assert.ok(disabledDetail);
  assert.equal(disabledDetail.assigned_global_roles.length, 1);
  assert.deepEqual(groupEffectiveGrantsByDomain(disabledDetail), []);
  assert.match(describeInactiveOrBlockingReason("ACCOUNT_DISABLED"), /0 quyền hiệu lực/i);
});

test("Owner protection vs member ADMIN uniformity and D10 assignment eligibility rules", () => {
  const owner = fixtures.responses.account_access_detail.canonical_owner_protected;
  const memberAdmin =
    fixtures.responses.account_access_detail.member_admin_revocable_with_contextual_and_exception;
  const disabled = fixtures.responses.account_access_detail.disabled_account_d10_zero_effective_grants;

  assert.equal(owner.assigned_global_roles[0].is_protected, true);
  assert.equal(owner.assigned_global_roles[0].can_revoke, false);
  assert.match(
    describeCannotRevokeReason(owner.assigned_global_roles[0].cannot_revoke_reason) ?? "",
    /Owner|Chủ sở hữu/i,
  );
  assert.equal(describeCannotRevokeReason(null), null);

  assert.equal(memberAdmin.assigned_global_roles[0].is_protected, false);
  assert.equal(memberAdmin.assigned_global_roles[0].can_revoke, true);

  // Assign eligibility depends strictly on manager gate, rollout gate, and enabled status
  assert.equal(canAssignNewGlobalRoleToAccount(owner.account, true, false).allowed, true);
  assert.equal(canAssignNewGlobalRoleToAccount(memberAdmin.account, true, false).allowed, true);
  assert.equal(canAssignNewGlobalRoleToAccount(disabled.account, true, false).allowed, false);
  assert.equal(canAssignNewGlobalRoleToAccount(memberAdmin.account, false, false).allowed, false);
  assert.equal(canAssignNewGlobalRoleToAccount(memberAdmin.account, true, true).allowed, false);
});

test("contextual assignment and module authority presenters provide read-only Vietnamese info and source links", () => {
  const member =
    fixtures.responses.account_access_detail.member_admin_revocable_with_contextual_and_exception;
  const owner = fixtures.responses.account_access_detail.canonical_owner_protected;
  for (const ctx of [...owner.contextual_assignments, ...member.contextual_assignments]) {
    const view = resolveContextualAssignmentPresentation(ctx);
    assert.ok(view.targetKindLabel.length > 0);
    assert.ok(view.sourceLink.href.startsWith("/"));
  }
  const headView = resolveContextualAssignmentPresentation({
    assignment_id: "11111111-1111-4111-8111-111111111199",
    role_code: "DEPARTMENT_HEAD",
    display_name: "Trưởng phòng ban",
    target_kind: "DEPARTMENT",
    target_ref: "22222222-2222-4222-8222-222222222299",
    target_label: "Phòng Tuyển dụng Miền Nam",
    scope_kind: "CONTEXT_DEPARTMENT",
    scope_id: "22222222-2222-4222-8222-222222222299",
    started_at: "2026-11-14T00:00:00+07:00",
    is_effective: true,
    inactive_reason: null,
    derived_capabilities: [],
    can_revoke: false,
    cannot_revoke_reason: "MANAGED_IN_SOURCE_MODULE",
  });
  assert.equal(
    headView.sourceLink.href,
    "/admin/departments/22222222-2222-4222-8222-222222222299",
  );
  const paView = resolveContextualAssignmentPresentation({
    assignment_id: "11111111-1111-4111-8111-111111111198",
    role_code: "PROJECT_ACCOUNTANT",
    display_name: "Kế toán dự án",
    target_kind: "PROJECT",
    target_ref: "prj_hcm_2026",
    target_label: "Dự án HCM 2026",
    scope_kind: "CONTEXT_PROJECT",
    scope_id: "prj_hcm_2026",
    started_at: "2026-11-14T00:00:00+07:00",
    is_effective: false,
    inactive_reason: "PROJECT_INACTIVE",
    derived_capabilities: ["vendor_finance_view"],
    can_revoke: false,
    cannot_revoke_reason: "MANAGED_IN_SOURCE_MODULE",
  });
  assert.equal(paView.sourceLink.href, "/finance/project-assignments");
  assert.match(paView.explanation, /Dự án liên quan/);

  for (const mod of member.module_authorities) {
    const view = resolveModuleAuthorityPresentation(mod);
    assert.ok(view.moduleLabel.length > 0);
    assert.ok(view.authorityTitle.length > 0);
    assert.ok(view.sourceLink?.href.startsWith("/"));
  }
});

test("mutation request builders enforce reason bounds, UUID idempotency, and authority field hygiene", () => {
  const key = newRoleMutationIdempotencyKey();
  assert.match(key, /^[0-9a-f-]{36}$/);

  const validAssign = buildAssignGlobalRoleRequest({
    roleCode: "ADMIN",
    expectedVersion: 3,
    reason: "Grant BoD/Admin workspace governance role",
    idempotencyKey: key,
  });
  assert.equal(validAssign.ok, true);
  assert.deepEqual(Object.keys(validAssign.body).sort(), [
    "expected_version",
    "idempotency_key",
    "reason",
    "role_code",
  ]);

  assert.equal(
    buildAssignGlobalRoleRequest({
      roleCode: "",
      expectedVersion: 3,
      reason: "Valid reason here",
      idempotencyKey: key,
    }).ok,
    false,
  );
  assert.equal(
    buildAssignGlobalRoleRequest({
      roleCode: "ADMIN",
      expectedVersion: 3,
      reason: "ab",
      idempotencyKey: key,
    }).ok,
    false,
  );
  assert.equal(
    buildRevokeGlobalRoleRequest({
      expectedVersion: 4,
      reason: "  ",
      idempotencyKey: key,
    }).ok,
    false,
  );
  assert.equal(
    buildRevokeGlobalRoleRequest({
      expectedVersion: 4,
      reason: "Remove temporary global role assignment",
      idempotencyKey: key,
    }).ok,
    true,
  );
});

test("read & mutation response classifiers cover rollout gates, OCC, Owner protection, uncertain 503, and stale replays", () => {
  const targetRef = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";

  assert.equal(classifyRoleReadFailure(401, null).kind, "unauthenticated");
  assert.equal(classifyRoleReadFailure(403, null).kind, "denied");
  assert.equal(classifyRoleReadFailure(404, { ok: false, error: { code: "NOT_FOUND" } }).kind, "not-found");
  assert.equal(classifyRoleReadFailure(503, null).kind, "unavailable");

  const created = classifyRoleMutationResponse(
    201,
    { ok: true, ...fixtures.responses.mutations.assign_global_role_created },
    targetRef,
  );
  assert.equal(created.kind, "applied");
  assert.equal(created.replayed, false);

  const replayed = classifyRoleMutationResponse(
    200,
    { ok: true, ...fixtures.responses.mutations.assign_global_role_replayed },
    targetRef,
  );
  assert.equal(replayed.kind, "applied");
  assert.equal(replayed.replayed, true);

  const gateEnv = classifyRoleMutationResponse(
    404,
    { ok: false, error: { code: "NOT_FOUND", message: "Not found" } },
    targetRef,
  );
  assert.equal(gateEnv.kind, "gate-closed");
  assert.equal(gateEnv.gateReason, "MUTATIONS_ENV_DISABLED");

  const gateCutover = classifyRoleMutationResponse(
    409,
    fixtures.errors.AUTHZ_CUTOVER_NOT_READY,
    targetRef,
  );
  assert.equal(gateCutover.kind, "gate-closed");
  assert.equal(gateCutover.gateReason, "CUTOVER_NOT_READY");

  const protectedErr = classifyRoleMutationResponse(
    409,
    fixtures.errors.AUTHZ_PROTECTED_ASSIGNMENT,
    targetRef,
  );
  assert.equal(protectedErr.kind, "protected-assignment");

  const occ = classifyRoleMutationResponse(409, fixtures.errors.VERSION_CONFLICT, targetRef);
  assert.equal(occ.kind, "version-conflict");
  assert.equal(occ.currentVersion, 5);
  assert.equal(occ.mustReloadAccount, true);

  const uncertain = classifyRoleMutationResponse(503, null, targetRef);
  assert.equal(uncertain.kind, "uncertain");
  assert.equal(uncertain.preserveIdempotencyKey, true);
  assert.equal(uncertain.lockForm, true);

  const forbiddenField = classifyRoleMutationResponse(
    400,
    fixtures.errors.AUTHORITY_FIELD_FORBIDDEN,
    targetRef,
  );
  assert.equal(forbiddenField.kind, "validation-error");
  assert.equal(forbiddenField.code, "AUTHORITY_FIELD_FORBIDDEN");

  assert.equal(isStaleMutationReplay(4, 5), true);
  assert.equal(isStaleMutationReplay(5, 5), false);
  assert.equal(isStaleMutationReplay(6, 5), false);

  const identity = formatAccountDisplayIdentity({ display_name: "Nguyễn Văn A", login_id: "nv.a" });
  assert.deepEqual(identity, { primary: "Nguyễn Văn A", secondary: "nv.a" });
  assert.match(formatAuthzTimestampVi("2026-11-14T08:00:00+07:00"), /\(\+07\)$/);

  const splitGlobal = splitOpenAndEndedGlobalRoles([
    fixtures.responses.mutations.assign_global_role_created.assignment,
    fixtures.responses.mutations.revoke_global_role_ok.assignment,
  ]);
  assert.equal(splitGlobal.activeAssigned.length, 1);
  assert.equal(splitGlobal.endedHistory.length, 1);

  const splitExc = splitOpenAndEndedDirectExceptions(
    fixtures.responses.account_access_detail.member_admin_revocable_with_contextual_and_exception
      .direct_exceptions,
  );
  assert.equal(splitExc.activeExceptions.length + splitExc.endedHistory.length, 1);
});
