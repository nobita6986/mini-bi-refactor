import assert from "node:assert/strict";
import { test } from "node:test";

import { CAPABILITIES } from "../auth/direct-entry-v2.ts";
import {
  assignAccountGroupAdmin,
  createPermissionGroupAdmin,
  getAccountGroupsAdmin,
  listPermissionGroupsAdmin,
  removeAccountGroupAdmin,
  updatePermissionGroupAdmin,
} from "./permission-group-api.ts";
import {
  CAPABILITY_BUSINESS_DESCRIPTORS,
  MODULE_ROLE_BUSINESS_DESCRIPTORS,
  parseAssignGroupMemberBody,
  parseCreateGroupBody,
  parseListGroupsQuery,
  parseRemoveGroupMemberBody,
  parseUpdateGroupBody,
  projectAccountGroupsResponse,
  projectListGroupsResponse,
} from "./permission-group-contract.ts";

const DEPT_ID = "00000000-0000-4000-8000-000000000101";
const TEAM_ID = "00000000-0000-4000-8000-000000000201";
const GROUP_ID = "00000000-0000-4000-8000-000000000301";
const MEMBER_ID = "00000000-0000-4000-8000-000000000401";
const ACCOUNT_REF = "00000000-0000-4000-8000-000000000501";
const ACTOR_AUTH = "00000000-0000-4000-8000-000000000601";
const ACTOR_APP = "00000000-0000-4000-8000-000000000602";
const IDEM_KEY = "00000000-0000-4000-8000-000000000701";

function makeFullAdminSession() {
  return async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: ACTOR_AUTH,
        app_user_id: ACTOR_APP,
        display_name: "Admin Test",
        enabled: true,
        capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
        scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
        effective_grants: [
          { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: GROUP_ID },
          { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: GROUP_ID },
          { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: GROUP_ID },
        ],
      },
    },
  });
}

test("business descriptors cover all 29 verbatim CAPABILITIES and 7 D4 module roles with zero technical scope jargon", () => {
  assert.equal(CAPABILITY_BUSINESS_DESCRIPTORS.length, 29);
  const described = new Set(CAPABILITY_BUSINESS_DESCRIPTORS.map((d) => d.capability));
  assert.deepEqual([...described].sort(), [...CAPABILITIES].sort());
  for (const d of CAPABILITY_BUSINESS_DESCRIPTORS) {
    assert.ok(d.label.trim().length > 0 && d.category.trim().length > 0);
    assert.doesNotMatch(d.label, /GLOBAL|CONTEXTUAL|scope|NORMAL|SHARED|SERVICE/i);
  }
  assert.equal(MODULE_ROLE_BUSINESS_DESCRIPTORS.length, 7);
});

test("request parsers reject forbidden authority/scope fields, SYSTEM_ADMIN creation, and malformed payloads", () => {
  assert.equal(parseListGroupsQuery(new URLSearchParams("department_id=bad")).ok, false);
  assert.equal(parseListGroupsQuery(new URLSearchParams(`department_id=${DEPT_ID}&department_id=${DEPT_ID}`)).ok, false);
  assert.equal(parseListGroupsQuery(new URLSearchParams("scope_kind=ALL")).ok, false);
  assert.deepEqual(parseListGroupsQuery(new URLSearchParams(`department_id=${DEPT_ID}&include_inactive=true`)), {
    ok: true,
    value: { department_id: DEPT_ID, include_inactive: true },
  });

  // Forbidden client keys (is_protected, scope_kind, scope_template, assignment_mode, project_id, is_system_admin)
  for (const forbidden of [
    { is_protected: true },
    { scope_kind: "ALL" },
    { scope_template: "ALL" },
    { assignment_mode: "GLOBAL" },
    { project_id: "proj-1" },
    { is_system_admin: true },
  ]) {
    const res = parseCreateGroupBody({
      code: "TEST_GRP",
      name: "Nhóm kiểm thử",
      department_id: DEPT_ID,
      ...forbidden,
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");
  }

  // Cannot create SYSTEM_ADMIN
  const sysRes = parseCreateGroupBody({
    code: "system_admin",
    name: "Fake Admin",
    department_id: DEPT_ID,
  });
  assert.equal(sysRes.ok, false);
  assert.equal(sysRes.code, "GROUP_CODE_INVALID");

  // Valid create body normalizes code, deduplicates capabilities & module_roles
  const validCreate = parseCreateGroupBody({
    code: " vfin_cash ",
    name: "  Thủ quỹ kế toán  ",
    description: "Quản lý thu chi",
    department_id: DEPT_ID,
    team_id: null,
    capabilities: ["vendor_finance_view", "vendor_finance_view"],
    module_roles: [{ module_code: "vendor_finance", role_code: "CASH_HOLDER" }],
    reason: "Tạo nhóm thủ quỹ",
  });
  assert.equal(validCreate.ok, true);
  assert.equal(validCreate.value.code, "VFIN_CASH");
  assert.deepEqual(validCreate.value.capabilities, ["vendor_finance_view"]);

  // Rejects unknown capability (no capability #30!) and unknown module role
  assert.equal(
    parseCreateGroupBody({ code: "BAD_CAP", name: "Bad", department_id: DEPT_ID, capabilities: ["cap_30_fake"] }).ok,
    false,
  );
  assert.equal(
    parseCreateGroupBody({
      code: "BAD_MR",
      name: "Bad",
      department_id: DEPT_ID,
      module_roles: [{ module_code: "generic", role_code: "SUPER" }],
    }).ok,
    false,
  );

  assert.equal(parseUpdateGroupBody({ expected_version: 0, name: "X", department_id: DEPT_ID, active: true }).ok, false);
  assert.equal(parseAssignGroupMemberBody({ group_id: GROUP_ID, expected_account_version: 1, is_protected: true }).ok, false);
  assert.equal(parseRemoveGroupMemberBody({ expected_account_version: 2, reason: "ab" }).ok, false);
  assert.deepEqual(parseRemoveGroupMemberBody({ expected_account_version: 2, reason: "  " }), {
    ok: true,
    value: { expected_account_version: 2, reason: null },
  });
});

test("response projections fail closed on malformed or incomplete payloads", () => {
  assert.equal(projectListGroupsResponse({ as_of: "2026-11-22T00:00:00Z", groups: [{ group_id: "not-uuid" }] }), null);
  assert.equal(projectAccountGroupsResponse({ as_of: "2026-11-22T00:00:00Z" }), null);
  const okList = projectListGroupsResponse({
    as_of: "2026-11-22T00:00:00Z",
    groups: [
      {
        group_id: GROUP_ID,
        code: "TEAM_A_REC",
        name: "Đội Tuyển dụng A",
        description: "",
        department_id: DEPT_ID,
        department_code: "REC",
        department_name: "Tuyển dụng",
        department_system_key: "RECRUITMENT",
        team_id: TEAM_ID,
        team_code: "T1",
        team_name: "Đội 1",
        is_system_admin: false,
        active: true,
        version: 1,
        capabilities: ["entry_team"],
        module_roles: [],
        member_count: 1,
        member_account_refs: [ACCOUNT_REF],
        updated_at: "2026-11-22T00:00:00Z",
      },
    ],
  });
  assert.ok(okList && okList.groups.length === 1);
});

test("HTTP handlers enforce feature gate, authority headers, idempotency key, Full Admin RBAC, and conflict status codes", async () => {
  const stubRepo = {
    async listGroups() {
      return { ok: true, data: { as_of: "2026-11-22T00:00:00Z", groups: [] } };
    },
    async createGroup() {
      return { ok: false, code: "GROUP_CODE_CONFLICT" };
    },
    async updateGroup() {
      return { ok: false, code: "VERSION_CONFLICT", current_version: 4 };
    },
    async getAccountGroups() {
      return {
        ok: true,
        data: {
          as_of: "2026-11-22T00:00:00Z",
          account_ref: ACCOUNT_REF,
          account_version: 2,
          enabled: true,
          memberships: [],
          resource_assignments: [],
        },
      };
    },
    async assignGroupMember() {
      return { ok: false, code: "GROUP_MEMBER_ALREADY_ASSIGNED" };
    },
    async removeGroupMember() {
      return { ok: false, code: "AUTHZ_PROTECTED_ASSIGNMENT" };
    },
  };
  const deps = { resolveSession: makeFullAdminSession(), repository: stubRepo };

  // Feature gate OFF -> 404
  const offRes = await listPermissionGroupsAdmin(
    new Request("https://bi.local/api/admin/access/groups"),
    "false",
    deps,
  );
  assert.equal(offRes.status, 404);

  // Disallowed authority header -> 400
  const hdrRes = await listPermissionGroupsAdmin(
    new Request("https://bi.local/api/admin/access/groups", { headers: { "x-app-user-id": ACTOR_APP } }),
    "true",
    deps,
  );
  assert.equal(hdrRes.status, 400);

  // Non-admin actor -> 403
  const nonAdminDeps = {
    resolveSession: async () => ({
      actor: {
        ok: true,
        actor: {
          auth_subject: ACTOR_AUTH,
          app_user_id: ACTOR_APP,
          display_name: "Recruiter",
          enabled: true,
          capabilities: ["entry_create"],
          scopes: [{ kind: "own", reference: "own", valid_from: "2026-01-01", valid_to: null }],
          effective_grants: [{ capability: "entry_create", scope_kind: "OWN", scope_id: null, source_type: "ROLE_BUNDLE", source_id: GROUP_ID }],
        },
      },
    }),
    repository: stubRepo,
  };
  const forbRes = await listPermissionGroupsAdmin(
    new Request("https://bi.local/api/admin/access/groups"),
    "true",
    nonAdminDeps,
  );
  assert.equal(forbRes.status, 403);

  // Missing Idempotency-Key -> 400
  const missingKeyRes = await createPermissionGroupAdmin(
    new Request("https://bi.local/api/admin/access/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "NEW_GRP", name: "Nhóm mới", department_id: DEPT_ID }),
    }),
    "true",
    deps,
  );
  assert.equal(missingKeyRes.status, 400);

  // VERSION_CONFLICT preserves current_version
  const verRes = await updatePermissionGroupAdmin(
    new Request(`https://bi.local/api/admin/access/groups/${GROUP_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": IDEM_KEY },
      body: JSON.stringify({
        expected_version: 3,
        name: "Updated",
        department_id: DEPT_ID,
        active: true,
        capabilities: [],
        module_roles: [],
      }),
    }),
    GROUP_ID,
    "true",
    deps,
  );
  assert.equal(verRes.status, 409);
  const verBody = await verRes.json();
  assert.equal(verBody.code, "VERSION_CONFLICT");
  assert.equal(verBody.current_version, 4);

  // Owner protection -> 409 AUTHZ_PROTECTED_ASSIGNMENT
  const protRes = await removeAccountGroupAdmin(
    new Request(`https://bi.local/api/admin/access/accounts/${ACCOUNT_REF}/groups/${MEMBER_ID}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "idempotency-key": IDEM_KEY },
      body: JSON.stringify({ expected_account_version: 2 }),
    }),
    ACCOUNT_REF,
    MEMBER_ID,
    "true",
    deps,
  );
  assert.equal(protRes.status, 409);
  assert.equal((await protRes.json()).code, "AUTHZ_PROTECTED_ASSIGNMENT");

  // GET account groups -> 200 + no-store
  const getRes = await getAccountGroupsAdmin(
    new Request(`https://bi.local/api/admin/access/accounts/${ACCOUNT_REF}/groups`),
    ACCOUNT_REF,
    "true",
    deps,
  );
  assert.equal(getRes.status, 200);
  assert.match(getRes.headers.get("cache-control") ?? "", /no-store/i);

  // Assign conflict -> 409
  const dupAssign = await assignAccountGroupAdmin(
    new Request(`https://bi.local/api/admin/access/accounts/${ACCOUNT_REF}/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": IDEM_KEY },
      body: JSON.stringify({ group_id: GROUP_ID, expected_account_version: 2 }),
    }),
    ACCOUNT_REF,
    "true",
    deps,
  );
  assert.equal(dupAssign.status, 409);
});
