import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ADMIN_NON_AUTO_GRANT_TOKENS,
  AUTHZ_CANONICAL_ROLE_CATALOG,
  AUTHZ_CANONICAL_ROLE_MAP,
  AUTHZ_CONTEXTUAL_ROLE_CODES,
  AUTHZ_GLOBAL_ROLE_CODES,
  AUTHZ_ROLE_CODES,
  ROLE_ACCESS_ERROR_CODES,
  RoleAccessValidationError,
  assertNoForbiddenAuthorityFields,
  classifyRoleMutationFailure,
  findForbiddenAuthorityField,
  parseAccountRefParam,
  parseAccountsSummaryQuery,
  parseAssignGlobalRoleBody,
  parseAssignmentIdParam,
  parseEmptyRoleAccessQuery,
  parseRevokeGlobalRoleBody,
  projectAccountAccessDetail,
  projectAccountsSummaryResponse,
  projectAssignedGlobalRoleItem,
  projectRoleMutationResult,
  projectRolesCatalogResponse,
} from "./role-access-contract.ts";
import { CAPABILITIES } from "./direct-entry-v2.ts";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../../../docs/contracts/fixtures/wp5b1-role-access/role-access-fixtures.json", import.meta.url),
    "utf8",
  ),
);

function assertZeroEmailLeak(value, label) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes("@"), false, `${label}: serialized payload must not contain @`);
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
    } else if (current && typeof current === "object") {
      for (const [key, nested] of Object.entries(current)) {
        assert.equal(/email/i.test(key), false, `${label}: forbidden key matching /email/i (${key})`);
        stack.push(nested);
      }
    }
  }
}

test("canonical 8-role catalog has zero BOD aliases and partitions ADMIN 21 vs 8 non-auto tokens", () => {
  assert.deepEqual(AUTHZ_GLOBAL_ROLE_CODES, [
    "EMPLOYEE_BASE",
    "RECRUITER",
    "HR_OPERATOR",
    "ADMIN",
  ]);
  assert.deepEqual(AUTHZ_CONTEXTUAL_ROLE_CODES, [
    "TEAM_LEADER",
    "DEPARTMENT_HEAD",
    "PROJECT_MANAGER",
    "PROJECT_ACCOUNTANT",
  ]);
  assert.deepEqual(AUTHZ_ROLE_CODES, [
    ...AUTHZ_GLOBAL_ROLE_CODES,
    ...AUTHZ_CONTEXTUAL_ROLE_CODES,
  ]);
  assert.equal(AUTHZ_CANONICAL_ROLE_CATALOG.length, 8);
  assert.equal(Object.hasOwn(AUTHZ_CANONICAL_ROLE_MAP, "BOD"), false);
  assert.equal(Object.hasOwn(AUTHZ_CANONICAL_ROLE_MAP, "BOD_ADMIN"), false);

  const admin = AUTHZ_CANONICAL_ROLE_MAP.ADMIN;
  assert.equal(admin.display_name, "BoD/Admin");
  assert.equal(admin.assignment_mode, "GLOBAL");
  assert.equal(admin.is_assignable_global, true);
  assert.equal(admin.capabilities.length, 21);

  const adminOwn = admin.capabilities.filter((c) => c.scope_template === "OWN");
  const adminAll = admin.capabilities.filter((c) => c.scope_template === "ALL");
  assert.deepEqual(adminOwn.map((c) => c.capability), ["entry_own"]);
  assert.equal(adminAll.length, 20);

  const adminCapSet = new Set(admin.capabilities.map((c) => c.capability));
  const excludedSet = new Set(ADMIN_NON_AUTO_GRANT_TOKENS);
  assert.equal(excludedSet.size, 8);
  for (const excluded of excludedSet) {
    assert.equal(adminCapSet.has(excluded), false, `ADMIN must exclude ${excluded}`);
  }
  const union = new Set([...adminCapSet, ...excludedSet]);
  assert.equal(union.size, 29);
  for (const cap of CAPABILITIES) {
    assert.equal(union.has(cap), true, `21+8 partition missing active capability ${cap}`);
  }

  assert.equal(AUTHZ_CANONICAL_ROLE_MAP.EMPLOYEE_BASE.capabilities.length, 0);
  assert.equal(AUTHZ_CANONICAL_ROLE_MAP.RECRUITER.capabilities.length, 7);
  assert.equal(AUTHZ_CANONICAL_ROLE_MAP.HR_OPERATOR.capabilities.length, 5);
  assert.equal(AUTHZ_CANONICAL_ROLE_MAP.TEAM_LEADER.capabilities.length, 5);
  assert.equal(
    AUTHZ_CANONICAL_ROLE_MAP.TEAM_LEADER.capabilities.every((c) => c.scope_template === "CONTEXT_TEAM"),
    true,
  );
  assert.equal(AUTHZ_CANONICAL_ROLE_MAP.DEPARTMENT_HEAD.capabilities.length, 0);
  assert.equal(AUTHZ_CANONICAL_ROLE_MAP.DEPARTMENT_HEAD.requires_active_person, true);
  assert.equal(AUTHZ_CANONICAL_ROLE_MAP.PROJECT_MANAGER.capabilities.length, 0);
  assert.deepEqual(AUTHZ_CANONICAL_ROLE_MAP.PROJECT_ACCOUNTANT.capabilities, [
    { capability: "vendor_finance_view", scope_template: "CONTEXT_PROJECT", retired_compat: false },
  ]);
});

test("query and route parameter parsers validate and fail closed", () => {
  assert.doesNotThrow(() => parseEmptyRoleAccessQuery(new URLSearchParams("")));
  assert.throws(
    () => parseEmptyRoleAccessQuery(new URLSearchParams("unexpected=1")),
    (err) => err instanceof RoleAccessValidationError && err.code === "AUTHZ_VALIDATION_ERROR" && err.status === 400,
  );

  assert.deepEqual(parseAccountsSummaryQuery(new URLSearchParams("")), {
    search: null,
    enabled: "all",
    role_code: null,
    page: 1,
    page_size: 25,
  });
  assert.deepEqual(
    parseAccountsSummaryQuery(new URLSearchParams("search=%20Minh%20&enabled=true&role_code=ADMIN&page=2&page_size=50")),
    {
      search: "Minh",
      enabled: "true",
      role_code: "ADMIN",
      page: 2,
      page_size: 50,
    },
  );
  for (const badQuery of [
    "enabled=maybe",
    "role_code=BOD_ADMIN",
    "page=0",
    "page_size=101",
    "extra=foo",
  ]) {
    assert.throws(
      () => parseAccountsSummaryQuery(new URLSearchParams(badQuery)),
      (err) => err instanceof RoleAccessValidationError && err.code === "AUTHZ_VALIDATION_ERROR",
      badQuery,
    );
  }

  const validUuid = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  assert.equal(parseAccountRefParam(validUuid), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(parseAssignmentIdParam(validUuid), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.throws(
    () => parseAccountRefParam("not-a-uuid"),
    (err) => err instanceof RoleAccessValidationError && err.code === "AUTHZ_VALIDATION_ERROR",
  );
  assert.throws(
    () => parseAssignmentIdParam("not-a-uuid"),
    (err) => err instanceof RoleAccessValidationError && err.code === "AUTHZ_VALIDATION_ERROR",
  );
});

test("mutation body parsers enforce idempotency, global-only roles, reason length, and forbid authority spoofing", () => {
  const assignKey = fixtures.requests.assign_global_role.idempotency_key;
  const revokeKey = fixtures.requests.revoke_global_role.idempotency_key;

  const assignReq = parseAssignGlobalRoleBody(
    fixtures.requests.assign_global_role,
    assignKey.toUpperCase(),
  );
  assert.deepEqual(assignReq, {
    role_code: "ADMIN",
    expected_version: 3,
    reason: "Grant BoD/Admin workspace governance role",
    idempotency_key: "11111111-1111-4111-8111-111111111111",
  });

  const revokeReq = parseRevokeGlobalRoleBody(
    fixtures.requests.revoke_global_role,
    revokeKey,
  );
  assert.deepEqual(revokeReq, {
    expected_version: 4,
    reason: "Remove temporary global role assignment",
    idempotency_key: "22222222-2222-4222-8222-222222222222",
  });

  // Missing Idempotency-Key header is rejected fail-closed
  assert.throws(
    () => parseRevokeGlobalRoleBody(fixtures.requests.revoke_global_role, null),
    (err) => err instanceof RoleAccessValidationError && err.code === "IDEMPOTENCY_KEY_INVALID" && err.status === 400,
  );

  // Idempotency-Key header vs body mismatch
  assert.throws(
    () =>
      parseAssignGlobalRoleBody(
        fixtures.requests.assign_global_role,
        "99999999-9999-4999-8999-999999999999",
      ),
    (err) => err instanceof RoleAccessValidationError && err.code === "IDEMPOTENCY_KEY_MISMATCH" && err.status === 400,
  );

  // Reject contextual roles or invalid role codes
  for (const roleCode of ["TEAM_LEADER", "DEPARTMENT_HEAD", "PROJECT_MANAGER", "PROJECT_ACCOUNTANT", "BOD"]) {
    assert.throws(
      () =>
        parseAssignGlobalRoleBody(
          {
            ...fixtures.requests.assign_global_role,
            role_code: roleCode,
          },
          assignKey,
        ),
      (err) => err instanceof RoleAccessValidationError && err.code === "AUTHZ_VALIDATION_ERROR" && err.status === 400,
      roleCode,
    );
  }

  // Reason must be trimmed 3..500 chars
  for (const badReason of ["", "ab", "  a ", "x".repeat(501)]) {
    assert.throws(
      () =>
        parseRevokeGlobalRoleBody(
          { ...fixtures.requests.revoke_global_role, reason: badReason },
          revokeKey,
        ),
      (err) => err instanceof RoleAccessValidationError && err.code === "AUTHZ_VALIDATION_ERROR" && err.status === 400,
    );
  }

  // Forbidden client authority spoofing (top-level & nested)
  for (const badPayload of [
    fixtures.requests.forbidden_authority_payloads.assign_with_is_protected,
    fixtures.requests.forbidden_authority_payloads.revoke_with_protected_reason,
    { ...fixtures.requests.assign_global_role, source_kind: "BACKFILL_SNAPSHOT" },
    { ...fixtures.requests.assign_global_role, meta: { authz_managed: false } },
    { ...fixtures.requests.assign_global_role, actor_app_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  ]) {
    assert.notEqual(findForbiddenAuthorityField(badPayload), null);
    assert.throws(
      () => assertNoForbiddenAuthorityFields(badPayload),
      (err) => err instanceof RoleAccessValidationError && err.code === "AUTHORITY_FIELD_FORBIDDEN" && err.status === 400,
    );
  }
  assert.throws(
    () =>
      parseAssignGlobalRoleBody(
        fixtures.requests.forbidden_authority_payloads.assign_with_is_protected,
        fixtures.requests.forbidden_authority_payloads.assign_with_is_protected.idempotency_key,
      ),
    (err) => err instanceof RoleAccessValidationError && err.code === "AUTHORITY_FIELD_FORBIDDEN",
  );
  assert.throws(
    () =>
      parseRevokeGlobalRoleBody(
        fixtures.requests.forbidden_authority_payloads.revoke_with_protected_reason,
        fixtures.requests.forbidden_authority_payloads.revoke_with_protected_reason.idempotency_key,
      ),
    (err) => err instanceof RoleAccessValidationError && err.code === "AUTHORITY_FIELD_FORBIDDEN",
  );
});

test("strict projectors match fixture envelopes, fail closed on extra fields, enforce zero email/@ leaks, and enforce D10 disabled grants", () => {
  const projectedCatalog = projectRolesCatalogResponse(structuredClone(fixtures.responses.roles_catalog));
  assert.ok(projectedCatalog);
  assert.equal(projectedCatalog.roles.length, 8);
  assertZeroEmailLeak(projectedCatalog, "roles_catalog");

  assert.equal(
    projectRolesCatalogResponse({
      ...structuredClone(fixtures.responses.roles_catalog),
      unexpected_extra: "reject-me",
    }),
    null,
  );

  const projectedSummary = projectAccountsSummaryResponse(structuredClone(fixtures.responses.accounts_summary));
  assert.ok(projectedSummary);
  assert.equal(projectedSummary.total, 3);
  assertZeroEmailLeak(projectedSummary, "accounts_summary");

  assert.equal(
    projectAccountsSummaryResponse({
      ...structuredClone(fixtures.responses.accounts_summary),
      secret_email: "hidden@example.com",
    }),
    null,
  );

  for (const [name, detailFixture] of Object.entries(fixtures.responses.account_access_detail)) {
    const projectedDetail = projectAccountAccessDetail(structuredClone(detailFixture));
    assert.ok(projectedDetail, `fixture ${name} should project cleanly`);
    assertZeroEmailLeak(projectedDetail, name);
  }

  const disabledDetail = projectAccountAccessDetail(
    fixtures.responses.account_access_detail.disabled_account_d10_zero_effective_grants,
  );
  assert.ok(disabledDetail);
  assert.equal(disabledDetail.account.enabled, false);
  assert.deepEqual(disabledDetail.blocking_reasons, ["ACCOUNT_DISABLED"]);
  assert.deepEqual(disabledDetail.effective_grants, []);

  // Disabled account with non-empty effective_grants MUST fail projection closed
  const forgedDisabled = structuredClone(
    fixtures.responses.account_access_detail.disabled_account_d10_zero_effective_grants,
  );
  forgedDisabled.effective_grants = [
    {
      capability: "entry_own",
      scope_kind: "OWN",
      scope_id: null,
      source_type: "ROLE_BUNDLE",
      source_id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000003",
      scope_label: "OWN",
    },
  ];
  assert.equal(projectAccountAccessDetail(forgedDisabled), null);

  const singleAssignment = projectAssignedGlobalRoleItem(
    fixtures.responses.mutations.assign_global_role_created.assignment,
  );
  assert.ok(singleAssignment);
  assert.equal(singleAssignment.role_code, "ADMIN");

  for (const [key, mutationFixture] of Object.entries(fixtures.responses.mutations)) {
    const projectedMutation = projectRoleMutationResult(structuredClone(mutationFixture));
    assert.ok(projectedMutation, key);
    assert.deepEqual(Object.keys(projectedMutation).sort(), [
      "account_ref",
      "account_version",
      "assignment",
      "replayed",
    ]);
    assertZeroEmailLeak(projectedMutation, key);
  }

  assert.equal(ROLE_ACCESS_ERROR_CODES.includes("AUTHZ_PROTECTED_ASSIGNMENT"), true);
  assert.equal(ROLE_ACCESS_ERROR_CODES.includes("AUTHZ_CUTOVER_NOT_READY"), true);
  assert.ok(classifyRoleMutationFailure(409, "VERSION_CONFLICT"));
  assert.ok(classifyRoleMutationFailure(409, "AUTHZ_PROTECTED_ASSIGNMENT"));
  assert.ok(classifyRoleMutationFailure(409, "AUTHZ_CUTOVER_NOT_READY"));
  assert.ok(classifyRoleMutationFailure(403, "AUTHZ_FORBIDDEN"));
});
