import assert from "node:assert/strict";
import test from "node:test";

import {
  getUserDirectoryEntryAdmin,
  listUserDirectoryAdmin,
} from "./user-directory-api.ts";
import {
  parseGetUserDirectoryEntryQuery,
  parseListUserDirectoryQuery,
  projectGetUserDirectoryEntryResponse,
  projectListUserDirectoryResponse,
} from "./user-directory-contract.ts";
import { createServiceUserDirectoryRepository } from "./user-directory-repository.ts";

const ACTOR_USER_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_AUTH_SUBJECT = "10000000-0000-4000-8000-000000000101";
const PERSON_ID = "20000000-0000-4000-8000-000000000002";
const ACCOUNT_ID = "40000000-0000-4000-8000-000000000005";
const LINK_ID = "60000000-0000-4000-8000-000000000008";
const DEPT_ID = "30000000-0000-4000-8000-000000000003";
const MEMBERSHIP_ID = "50000000-0000-4000-8000-000000000006";

function makeFullAdminSession() {
  return {
    actor: {
      ok: true,
      actor: {
        auth_subject: ACTOR_AUTH_SUBJECT,
        app_user_id: ACTOR_USER_ID,
        enabled: true,
        capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
        scopes: [{ kind: "all" }],
        effective_grants: [
          { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE" },
          { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE" },
          { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE" },
        ],
      },
    },
  };
}

function makeHrOperatorSession() {
  return {
    actor: {
      ok: true,
      actor: {
        auth_subject: ACTOR_AUTH_SUBJECT,
        app_user_id: ACTOR_USER_ID,
        enabled: true,
        capabilities: ["recruiter_master_manage", "team_master_manage", "catalog_master_manage"],
        scopes: [{ kind: "all" }],
        effective_grants: [
          { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE" },
          { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE" },
          { capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE" },
        ],
      },
    },
  };
}

function failIfCalledRepository() {
  const fail = () => {
    throw new Error("repository should not be called");
  };
  return {
    listUserDirectory: fail,
    getUserDirectoryEntry: fail,
  };
}

function makeLinkedEntrySummary() {
  return {
    directory_entry_key: `person:${PERSON_ID}`,
    record_kind: "LINKED_PERSON_ACCOUNT",
    display_name: "Nguyen Van A",
    login_state: "ENABLED",
    person_id: PERSON_ID,
    account_ref: ACCOUNT_ID,
    active_link_id: LINK_ID,
    link_conflict: false,
    identity_mutation_blocked: false,
    conflict_details: null,
    person: {
      person_id: PERSON_ID,
      employee_code: "EMP-001",
      full_name: "Nguyen Van A",
      status: "ACTIVE",
      joined_on: "2026-01-15",
      recruiter_id: null,
      version: 1,
      active_department: {
        membership_id: MEMBERSHIP_ID,
        department_id: DEPT_ID,
        system_key: "RECRUITMENT",
        code: "RECRUITMENT",
        name: "Tuyen dung",
        started_at: "2026-01-15T00:00:00.000Z",
        source_kind: "ADMIN_MUTATION",
        evidence_date: null,
        version: 1,
      },
    },
    account: {
      account_ref: ACCOUNT_ID,
      login_id: "nguyenvana",
      display_name: "Nguyen Van A",
      enabled: true,
      version: 2,
      auth_user_present: true,
    },
    active_link: {
      link_id: LINK_ID,
      started_at: "2026-01-15T00:00:00.000Z",
      source_kind: "ADMIN_MUTATION",
      evidence_date: null,
      version: 1,
    },
  };
}

test("parseListUserDirectoryQuery validates defaults, valid filters, duplicate params, and forbidden tokens", () => {
  const def = parseListUserDirectoryQuery(new URL("https://bi.local/api/admin/organization/user-directory"));
  assert.equal(def.ok, true);
  assert.deepEqual(def.value, {
    search: null,
    record_kind: "all",
    person_status: "all",
    login_state: "all",
    department_id: null,
    as_of: null,
    page: 1,
    page_size: 25,
  });

  const full = parseListUserDirectoryQuery(
    new URL(
      `https://bi.local/api/admin/organization/user-directory?search=%20n8n_bod%20&record_kind=unlinked_account&person_status=none&login_state=disabled&department_id=${DEPT_ID.toUpperCase()}&as_of=2026-06-01T12:00:00%2B07:00&page=2&page_size=10`,
    ),
  );
  assert.equal(full.ok, true);
  assert.deepEqual(full.value, {
    search: "n8n_bod",
    record_kind: "unlinked_account",
    person_status: "none",
    login_state: "disabled",
    department_id: DEPT_ID,
    as_of: "2026-06-01T05:00:00.000Z",
    page: 2,
    page_size: 10,
  });

  // Rejects account_type or unknown params, duplicate params, schedule & authority params
  const unknownAccountType = parseListUserDirectoryQuery(
    new URL("https://bi.local/api/admin/organization/user-directory?account_type=NORMAL"),
  );
  assert.equal(unknownAccountType.ok, false);
  assert.equal(unknownAccountType.code, "ORG_VALIDATION_ERROR");

  const dup = parseListUserDirectoryQuery(
    new URL("https://bi.local/api/admin/organization/user-directory?page=1&page=2"),
  );
  assert.equal(dup.ok, false);
  assert.equal(dup.code, "ORG_VALIDATION_ERROR");

  const sched = parseListUserDirectoryQuery(
    new URL("https://bi.local/api/admin/organization/user-directory?started_at=2026-01-01T00:00:00Z"),
  );
  assert.equal(sched.ok, false);
  assert.equal(sched.code, "CLIENT_SCHEDULE_FIELD_FORBIDDEN");

  const authz = parseListUserDirectoryQuery(
    new URL("https://bi.local/api/admin/organization/user-directory?role=ADMIN"),
  );
  assert.equal(authz.ok, false);
  assert.equal(authz.code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");

  const invalidLogin = parseListUserDirectoryQuery(
    new URL("https://bi.local/api/admin/organization/user-directory?login_state=active"),
  );
  assert.equal(invalidLogin.ok, false);
  assert.equal(invalidLogin.code, "ORG_VALIDATION_ERROR");
});

test("parseGetUserDirectoryEntryQuery enforces XOR(person_id, account_ref)", () => {
  const byPerson = parseGetUserDirectoryEntryQuery(
    new URL(`https://bi.local/api/admin/organization/user-directory/detail?person_id=${PERSON_ID}`),
  );
  assert.equal(byPerson.ok, true);
  assert.deepEqual(byPerson.value, { person_id: PERSON_ID, account_ref: null, as_of: null });

  const byAccount = parseGetUserDirectoryEntryQuery(
    new URL(`https://bi.local/api/admin/organization/user-directory/detail?account_ref=${ACCOUNT_ID}`),
  );
  assert.equal(byAccount.ok, true);
  assert.deepEqual(byAccount.value, { person_id: null, account_ref: ACCOUNT_ID, as_of: null });

  const neither = parseGetUserDirectoryEntryQuery(
    new URL("https://bi.local/api/admin/organization/user-directory/detail"),
  );
  assert.equal(neither.ok, false);
  assert.equal(neither.code, "ORG_VALIDATION_ERROR");

  const both = parseGetUserDirectoryEntryQuery(
    new URL(
      `https://bi.local/api/admin/organization/user-directory/detail?person_id=${PERSON_ID}&account_ref=${ACCOUNT_ID}`,
    ),
  );
  assert.equal(both.ok, false);
  assert.equal(both.code, "ORG_VALIDATION_ERROR");
});

test("projectListUserDirectoryResponse & projectGetUserDirectoryEntryResponse fail closed on structural or key drift", () => {
  const validList = {
    authorization_date: "2026-11-21",
    as_of: "2026-11-21T15:00:00.000Z",
    search: null,
    record_kind: "all",
    person_status: "all",
    login_state: "all",
    department_id: null,
    page: 1,
    page_size: 25,
    total: 1,
    has_more: false,
    summary: {
      total_all: 1,
      linked_count: 1,
      person_only_count: 0,
      unlinked_account_count: 0,
      conflict_count: 0,
    },
    entries: [makeLinkedEntrySummary()],
  };
  assert.ok(projectListUserDirectoryResponse(validList));

  // Extra account_type field on account must fail closed
  const leakedAccountType = structuredClone(validList);
  leakedAccountType.entries[0].account.account_type = "NORMAL";
  assert.equal(projectListUserDirectoryResponse(leakedAccountType), null);

  // Summary sum mismatch fails closed
  const badSummary = structuredClone(validList);
  badSummary.summary.total_all = 99;
  assert.equal(projectListUserDirectoryResponse(badSummary), null);

  // Conflict row without identity_mutation_blocked or conflict_details fails closed
  const badConflict = structuredClone(validList);
  badConflict.entries[0] = {
    ...makeLinkedEntrySummary(),
    directory_entry_key: `account:${ACCOUNT_ID}`,
    record_kind: "ACCOUNT_LINK_CONFLICT",
    person_id: null,
    active_link_id: null,
    person: null,
    active_link: null,
    link_conflict: true,
    identity_mutation_blocked: false,
    conflict_details: null,
  };
  assert.equal(projectListUserDirectoryResponse(badConflict), null);

  // Valid detail projection succeeds
  const validDetail = {
    authorization_date: "2026-11-21",
    as_of: "2026-11-21T15:00:00.000Z",
    entry: {
      ...makeLinkedEntrySummary(),
      department_history: [],
      head_assignments: [],
      link_history: [
        {
          link_id: LINK_ID,
          person_id: PERSON_ID,
          account_ref: ACCOUNT_ID,
          started_at: "2026-01-15T00:00:00.000Z",
          ended_at: null,
          source_kind: "ADMIN_MUTATION",
          evidence_date: null,
          version: 1,
        },
      ],
    },
  };
  assert.ok(projectGetUserDirectoryEntryResponse(validDetail));
});

test("HTTP handlers enforce feature gate, authority headers, Full Admin RBAC, and error classification", async () => {
  const req = new Request("https://bi.local/api/admin/organization/user-directory");

  // Feature disabled -> 404
  const offRes = await listUserDirectoryAdmin(req, "false", {
    resolveSession: async () => makeFullAdminSession(),
    repository: failIfCalledRepository(),
  });
  assert.equal(offRes.status, 404);

  // Disallowed authority header -> 400
  const spoofReq = new Request("https://bi.local/api/admin/organization/user-directory", {
    headers: { "x-app-user-id": ACTOR_USER_ID },
  });
  const spoofRes = await listUserDirectoryAdmin(spoofReq, "true", {
    resolveSession: async () => makeFullAdminSession(),
    repository: failIfCalledRepository(),
  });
  assert.equal(spoofRes.status, 400);
  assert.equal((await spoofRes.json()).code, "CLIENT_AUTHORITY_FIELD_FORBIDDEN");

  // Unauthenticated -> 401
  const unauthRes = await listUserDirectoryAdmin(req, "true", {
    resolveSession: async () => ({ actor: { ok: false, reason: "UNAUTHENTICATED" } }),
    repository: failIfCalledRepository(),
  });
  assert.equal(unauthRes.status, 401);

  // HR Operator (non Full Admin) -> 403
  const hrRes = await listUserDirectoryAdmin(req, "true", {
    resolveSession: async () => makeHrOperatorSession(),
    repository: failIfCalledRepository(),
  });
  assert.equal(hrRes.status, 403);

  // Detail 404 mapping through repository
  const repo = createServiceUserDirectoryRepository(async () => ({
    data: null,
    error: { code: "P0002", message: "USER_DIRECTORY_ENTRY_NOT_FOUND" },
  }));
  const detailReq = new Request(
    `https://bi.local/api/admin/organization/user-directory/detail?account_ref=${ACCOUNT_ID}`,
  );
  const notFoundRes = await getUserDirectoryEntryAdmin(detailReq, "true", {
    resolveSession: async () => makeFullAdminSession(),
    repository: repo,
  });
  assert.equal(notFoundRes.status, 404);
  assert.equal((await notFoundRes.json()).code, "NOT_FOUND");
});
