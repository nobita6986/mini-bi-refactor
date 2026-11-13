import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assignAccountingMemberAdmin,
  assignDepartmentPersonMemberAdmin,
  createDepartmentAdmin,
  designateDepartmentHeadAdmin,
  endAccountingMemberAdmin,
  endDepartmentHeadAdmin,
  endDepartmentPersonMemberAdmin,
  getDepartmentAdmin,
  listAccountingCandidatesAdmin,
  listAccountingMembershipsAdmin,
  listDepartmentHeadsAdmin,
  listDepartmentPersonMembershipsAdmin,
  listDepartmentsAdmin,
  listRecruitmentTeamsAdmin,
  updateDepartmentAdmin,
} from "./department-api.ts";
import { createServiceDepartmentRepository } from "./department-repository.ts";

const HOST = "bi.local";
const ORIGIN = `https://${HOST}`;
const SAME_ORIGIN_POST_HEADERS = Object.freeze({
  host: HOST,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
});
const ADMIN_AUTH = "10000000-0000-4000-8000-000000000001";
const ADMIN_APP = "20000000-0000-4000-8000-000000000001";
const USER_REF = "30000000-0000-4000-8000-000000000002";
const DEPT_ACCOUNTING = "40000000-0000-4000-8000-000000000003";
const DEPT_RECRUITMENT = "40000000-0000-4000-8000-000000000004";
const MEMBERSHIP_ID = "50000000-0000-4000-8000-000000000005";
const IDEM_KEY = "60000000-0000-4000-8000-000000000006";
const TEAM_ID = "70000000-0000-4000-8000-000000000007";

test("department OCC conflicts accept both legacy 40001 and PostgREST-safe PT409", async () => {
  for (const code of ["40001", "PT409"]) {
    const repository = createServiceDepartmentRepository(async () => ({
      data: null,
      error: { code },
    }));
    assert.deepEqual(await repository.assignAccountingMember({
      auth_subject: ADMIN_AUTH,
      app_user_id: ADMIN_APP,
      account_ref: USER_REF,
      expected_pair_version: 1,
      effective_from: null,
      reason: "test",
      idempotency_key: IDEM_KEY,
      request_fingerprint: "test",
    }), { ok: false, code: "DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT" });
  }
});

const HTTP_VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

const DEPARTMENT_ROUTE_REGISTRY = Object.freeze({
  "src/app/api/admin/departments/route.ts": Object.freeze({
    GET: "listDepartmentsAdmin",
    POST: "createDepartmentAdmin",
  }),
  "src/app/api/admin/departments/[departmentId]/route.ts": Object.freeze({
    GET: "getDepartmentAdmin",
    PATCH: "updateDepartmentAdmin",
  }),
  "src/app/api/admin/departments/[departmentId]/memberships/route.ts": Object.freeze({
    GET: "listDepartmentPersonMembershipsAdmin",
    POST: "assignDepartmentPersonMemberAdmin",
  }),
  "src/app/api/admin/departments/[departmentId]/memberships/[membershipId]/end/route.ts":
    Object.freeze({
      POST: "endDepartmentPersonMemberAdmin",
    }),
  "src/app/api/admin/departments/[departmentId]/head/route.ts": Object.freeze({
    GET: "listDepartmentHeadsAdmin",
    POST: "designateDepartmentHeadAdmin",
  }),
  "src/app/api/admin/departments/[departmentId]/head/end/route.ts": Object.freeze({
    POST: "endDepartmentHeadAdmin",
  }),
  "src/app/api/admin/departments/recruitment/teams/route.ts": Object.freeze({
    GET: "listRecruitmentTeamsAdmin",
  }),
  "src/app/api/admin/departments/accounting/candidates/route.ts": Object.freeze({
    GET: "listAccountingCandidatesAdmin",
  }),
  "src/app/api/admin/departments/accounting/memberships/route.ts": Object.freeze({
    GET: "listAccountingMembershipsAdmin",
    POST: "assignAccountingMemberAdmin",
  }),
  "src/app/api/admin/departments/accounting/memberships/[membershipId]/end/route.ts":
    Object.freeze({
      POST: "endAccountingMemberAdmin",
    }),
});

function makeSession({
  unauthenticated = false,
  enabled = true,
  capabilities = ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes = [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
} = {}) {
  if (unauthenticated) {
    return async () => ({
      actor: { ok: false, reason: "UNAUTHENTICATED" },
    });
  }
  return async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: ADMIN_AUTH,
        app_user_id: ADMIN_APP,
        display_name: "Synthetic Actor",
        enabled,
        capabilities,
        scopes,
        self_recruiter_suggestion: null,
        session: {
          provider: "supabase",
          verification: "getUser",
          authenticated_at: "2026-10-24T00:00:00.000Z",
        },
      },
    },
  });
}

function failIfCalledRepository(counter) {
  const boom = async () => {
    if (counter) {
      counter.repository += 1;
    }
    throw new Error("Repository must not be called for unauthorized or invalid preflight");
  };
  return {
    listDepartments: boom,
    getDepartment: boom,
    listAccountingMemberships: boom,
    listAccountingCandidates: boom,
    assignAccountingMember: boom,
    endAccountingMember: boom,
    listRecruitmentTeams: boom,
    createDepartment: boom,
    updateDepartment: boom,
    listPersonMemberships: boom,
    assignPersonMember: boom,
    endPersonMember: boom,
    listDepartmentHeads: boom,
    designateHead: boom,
    endHead: boom,
  };
}

async function discoverRouteFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await discoverRouteFiles(fullPath)));
    } else if (entry.isFile() && /^route\.(?:ts|tsx|js|mjs|mts)$/.test(entry.name)) {
      found.push(path.relative(process.cwd(), fullPath).split(path.sep).join("/"));
    }
  }
  return found.sort();
}

function extractExportedFunctionBlock(source, verb) {
  const matcher = new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`);
  const match = matcher.exec(source);
  if (!match) return null;

  const signatureStart = match.index;
  const openParen = source.indexOf("(", signatureStart);
  assert.notEqual(openParen, -1, `Missing parameter list for ${verb}`);
  let parenDepth = 0;
  let paramsEnd = -1;
  for (let i = openParen; i < source.length; i += 1) {
    if (source[i] === "(") parenDepth += 1;
    else if (source[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        paramsEnd = i;
        break;
      }
    }
  }
  assert.notEqual(paramsEnd, -1, `Unclosed parameter list for ${verb}`);

  const bodyStart = source.indexOf("{", paramsEnd);
  assert.notEqual(bodyStart, -1, `Missing function body for ${verb}`);
  let braceDepth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") braceDepth += 1;
    else if (source[i] === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return source.slice(signatureStart, i + 1);
      }
    }
  }
  throw new Error(`Unclosed function body for ${verb}`);
}

test("DIRECT_ENTRY_API_ENABLED gate hides all 7 GET/POST department endpoints with 404 NOT_FOUND before session, repository, CSRF, or body reads", async () => {
  const disabledFlagValues = [undefined, "", "false", "0", "1", "TRUE", " true "];

  for (const disabledFlag of disabledFlagValues) {
    const calls = { session: 0, repository: 0, bodyReads: 0 };
    const deps = {
      resolveSession: async () => {
        calls.session += 1;
        throw new Error("resolveSession must not run when DIRECT_ENTRY_API_ENABLED !== 'true'");
      },
      repository: failIfCalledRepository(calls),
    };

    const makeUntouchedBodyStream = () =>
      new ReadableStream(
        {
          pull() {
            calls.bodyReads += 1;
            throw new Error("request body must not be read when DIRECT_ENTRY_API_ENABLED !== 'true'");
          },
        },
        { highWaterMark: 0 },
      );

    const responses = await Promise.all([
      listDepartmentsAdmin(
        new Request(`${ORIGIN}/api/admin/departments`, {
          headers: { "x-app-user-id": ADMIN_APP },
        }),
        disabledFlag,
        deps,
      ),
      getDepartmentAdmin(
        new Request(`${ORIGIN}/api/admin/departments/not-a-uuid`, {
          headers: { "x-app-user-id": ADMIN_APP },
        }),
        "not-a-uuid",
        disabledFlag,
        deps,
      ),
      listRecruitmentTeamsAdmin(
        new Request(`${ORIGIN}/api/admin/departments/recruitment/teams?unknown=1`, {
          headers: { "x-app-user-id": ADMIN_APP },
        }),
        disabledFlag,
        deps,
      ),
      listAccountingCandidatesAdmin(
        new Request(`${ORIGIN}/api/admin/departments/accounting/candidates?unknown=1`, {
          headers: { "x-app-user-id": ADMIN_APP },
        }),
        disabledFlag,
        deps,
      ),
      listAccountingMembershipsAdmin(
        new Request(`${ORIGIN}/api/admin/departments/accounting/memberships?unknown=1`, {
          headers: { "x-app-user-id": ADMIN_APP },
        }),
        disabledFlag,
        deps,
      ),
      assignAccountingMemberAdmin(
        new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
          method: "POST",
          headers: {
            host: HOST,
            origin: "https://evil.example",
            "sec-fetch-site": "cross-site",
            "content-type": "text/plain",
            "x-app-user-id": ADMIN_APP,
          },
          body: makeUntouchedBodyStream(),
          duplex: "half",
        }),
        disabledFlag,
        deps,
      ),
      endAccountingMemberAdmin(
        new Request(
          `${ORIGIN}/api/admin/departments/accounting/memberships/${MEMBERSHIP_ID}/end`,
          {
            method: "POST",
            headers: {
              host: HOST,
              origin: "https://evil.example",
              "sec-fetch-site": "cross-site",
              "content-type": "text/plain",
              "x-app-user-id": ADMIN_APP,
            },
            body: makeUntouchedBodyStream(),
            duplex: "half",
          },
        ),
        MEMBERSHIP_ID,
        disabledFlag,
        deps,
      ),
    ]);

    assert.equal(responses.length, 7);
    for (const response of responses) {
      assert.equal(
        response.status,
        404,
        `Expected 404 for disabled flag ${JSON.stringify(disabledFlag)}`,
      );
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.deepEqual(await response.json(), { ok: false, code: "NOT_FOUND" });
    }

    assert.equal(calls.session, 0, "resolveSession must not be called when gated off");
    assert.equal(calls.repository, 0, "repository must not be called when gated off");
    assert.equal(calls.bodyReads, 0, "POST body must not be read when gated off");
  }
});

test("when DIRECT_ENTRY_API_ENABLED is 'true', all 5 GET department endpoints return canonical 200 responses", async () => {
  const sampleDepartmentRecruitment = {
    department_id: DEPT_RECRUITMENT,
    system_key: "RECRUITMENT",
    code: "RECRUITMENT",
    name: "Phòng Tuyển dụng",
    is_active: true,
    version: 1,
    membership_mode: "MANAGED_MEMBERSHIP_AND_TEAMS",
    default_policy_code: "EXISTING_TEAM_AUTHORITY_READ_ONLY",
    active_member_count: 0,
    team_count: 3,
    active_team_count: 2,
    active_head: null,
    created_at: "2026-10-24T00:00:00.000Z",
    updated_at: "2026-10-24T00:00:00.000Z",
  };
  const sampleDepartmentAccounting = {
    department_id: DEPT_ACCOUNTING,
    system_key: "ACCOUNTING",
    code: "ACCOUNTING",
    name: "Phòng Kế toán",
    is_active: true,
    version: 1,
    membership_mode: "MANAGED_MEMBERSHIP",
    default_policy_code: "VENDOR_FINANCE_VIEW_AND_RECORD",
    active_member_count: 1,
    team_count: null,
    active_team_count: null,
    active_head: null,
    created_at: "2026-10-24T00:00:00.000Z",
    updated_at: "2026-10-24T00:00:00.000Z",
  };

  const repo = createServiceDepartmentRepository(async (fn) => {
    if (fn === "org_department_list_departments_admin") {
      return {
        data: {
          authorization_date: "2026-10-24",
          as_of: "2026-10-24T00:00:00.000Z",
          departments: [sampleDepartmentRecruitment, sampleDepartmentAccounting],
        },
        error: null,
      };
    }
    if (fn === "org_department_get_department_admin") {
      return {
        data: {
          authorization_date: "2026-10-24",
          as_of: "2026-10-24T00:00:00.000Z",
          department: sampleDepartmentAccounting,
        },
        error: null,
      };
    }
    if (fn === "org_department_list_recruitment_teams_admin") {
      return {
        data: {
          authorization_date: "2026-10-24",
          department_id: DEPT_RECRUITMENT,
          system_key: "RECRUITMENT",
          include_inactive: false,
          search: null,
          page: 1,
          page_size: 25,
          total: 1,
          has_more: false,
          teams: [
            {
              team_id: TEAM_ID,
              code: "TEAM_A",
              display_name: "Team Tuyển Dụng A",
              active: true,
              version: 1,
            },
          ],
        },
        error: null,
      };
    }
    if (fn === "org_department_list_accounting_candidates_admin") {
      return {
        data: {
          authorization_date: "2026-10-24",
          department_id: DEPT_ACCOUNTING,
          search: null,
          page: 1,
          page_size: 25,
          total: 1,
          has_more: false,
          candidates: [
            {
              account_ref: USER_REF,
              display_name: "Nguyễn Kế Toán",
              login_id: "ketoan.nguyen",
              personnel_code: "ketoan.nguyen",
              account_enabled: true,
              has_active_membership: false,
              open_membership_id: null,
              pair_version: 0,
            },
          ],
        },
        error: null,
      };
    }
    if (fn === "org_department_list_accounting_memberships_admin") {
      return {
        data: {
          authorization_date: "2026-10-24",
          department_id: DEPT_ACCOUNTING,
          include_history: false,
          search: null,
          page: 1,
          page_size: 25,
          total: 0,
          has_more: false,
          memberships: [],
        },
        error: null,
      };
    }
    return { data: null, error: { code: "XX000", message: "unexpected rpc" } };
  });

  const deps = {
    resolveSession: makeSession(),
    repository: repo,
  };

  const getResponses = await Promise.all([
    listDepartmentsAdmin(new Request(`${ORIGIN}/api/admin/departments`), "true", deps),
    getDepartmentAdmin(
      new Request(`${ORIGIN}/api/admin/departments/${DEPT_ACCOUNTING}`),
      DEPT_ACCOUNTING,
      "true",
      deps,
    ),
    listRecruitmentTeamsAdmin(
      new Request(`${ORIGIN}/api/admin/departments/recruitment/teams`),
      "true",
      deps,
    ),
    listAccountingCandidatesAdmin(
      new Request(`${ORIGIN}/api/admin/departments/accounting/candidates`),
      "true",
      deps,
    ),
    listAccountingMembershipsAdmin(
      new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`),
      "true",
      deps,
    ),
  ]);

  for (const response of getResponses) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const payload = await response.json();
    assert.equal(payload.ok, true);
  }
});

test("unauthenticated and non-Full-Admin actors are rejected with 401/403 before repository access", async () => {
  const unauthRes = await listDepartmentsAdmin(
    new Request(`${ORIGIN}/api/admin/departments`),
    "true",
    {
      resolveSession: makeSession({ unauthenticated: true }),
      repository: failIfCalledRepository(),
    },
  );
  assert.equal(unauthRes.status, 401);
  assert.deepEqual(await unauthRes.json(), { ok: false, code: "UNAUTHENTICATED" });
  assert.equal(unauthRes.headers.get("cache-control"), "private, no-store");

  const nonAdminPersonas = [
    {
      label: "BoD / direct-grant viewer",
      capabilities: ["report_analytics_view", "entry_privileged_edit", "catalog_master_manage"],
      scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
    },
    {
      label: "Catalog operator only",
      capabilities: ["catalog_master_manage"],
      scopes: [{ kind: "all", reference: "all", valid_from: "2026-01-01", valid_to: null }],
    },
    {
      label: "Team Leader",
      capabilities: ["entry_team", "team_manager_assign", "report_view"],
      scopes: [
        { kind: "team", reference: DEPT_RECRUITMENT, valid_from: "2026-01-01", valid_to: null },
      ],
    },
    {
      label: "Staff / Accounting member without Full Admin",
      capabilities: ["entry_own"],
      scopes: [{ kind: "own", reference: ADMIN_APP, valid_from: "2026-01-01", valid_to: null }],
    },
  ];

  for (const persona of nonAdminPersonas) {
    const deps = {
      resolveSession: makeSession({
        capabilities: persona.capabilities,
        scopes: persona.scopes,
      }),
      repository: failIfCalledRepository(),
    };

    const readChecks = await Promise.all([
      listDepartmentsAdmin(new Request(`${ORIGIN}/api/admin/departments`), "true", deps),
      getDepartmentAdmin(
        new Request(`${ORIGIN}/api/admin/departments/${DEPT_ACCOUNTING}`),
        DEPT_ACCOUNTING,
        "true",
        deps,
      ),
      listAccountingMembershipsAdmin(
        new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`),
        "true",
        deps,
      ),
      listAccountingCandidatesAdmin(
        new Request(`${ORIGIN}/api/admin/departments/accounting/candidates`),
        "true",
        deps,
      ),
      listRecruitmentTeamsAdmin(
        new Request(`${ORIGIN}/api/admin/departments/recruitment/teams`),
        "true",
        deps,
      ),
      assignAccountingMemberAdmin(
        new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
          method: "POST",
          headers: {
            ...SAME_ORIGIN_POST_HEADERS,
            "content-type": "application/json",
            "idempotency-key": IDEM_KEY,
          },
          body: JSON.stringify({
            account_ref: USER_REF,
            expected_pair_version: 0,
            reason: "Thử gán trái phép",
            idempotency_key: IDEM_KEY,
          }),
        }),
        "true",
        deps,
      ),
      endAccountingMemberAdmin(
        new Request(
          `${ORIGIN}/api/admin/departments/accounting/memberships/${MEMBERSHIP_ID}/end`,
          {
            method: "POST",
            headers: {
              ...SAME_ORIGIN_POST_HEADERS,
              "content-type": "application/json",
              "idempotency-key": IDEM_KEY,
            },
            body: JSON.stringify({
              expected_pair_version: 1,
              reason: "Thử thu hồi trái phép",
              idempotency_key: IDEM_KEY,
            }),
          },
        ),
        MEMBERSHIP_ID,
        "true",
        deps,
      ),
    ]);

    for (const response of readChecks) {
      assert.equal(response.status, 403, `${persona.label} must receive 403`);
      assert.deepEqual(await response.json(), {
        ok: false,
        code: "DEPARTMENT_ACCESS_DENIED",
      });
    }
  }
});

test("mutation endpoints enforce same-origin CSRF, disallowed header guard, Content-Type, and 8 KiB body cap", async () => {
  const deps = {
    resolveSession: makeSession(),
    repository: failIfCalledRepository(),
  };

  // Cross-origin POST rejected with 403 CSRF_REJECTED
  const csrfRes = await assignAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        account_ref: USER_REF,
        expected_pair_version: 0,
        reason: "CSRF probe",
        idempotency_key: IDEM_KEY,
      }),
    }),
    "true",
    deps,
  );
  assert.equal(csrfRes.status, 403);
  assert.deepEqual(await csrfRes.json(), { ok: false, code: "CSRF_REJECTED" });

  // Disallowed client authority header rejected with 400
  const headerRes = await listDepartmentsAdmin(
    new Request(`${ORIGIN}/api/admin/departments`, {
      headers: { "x-app-user-id": ADMIN_APP },
    }),
    "true",
    deps,
  );
  assert.equal(headerRes.status, 400);
  assert.deepEqual(await headerRes.json(), {
    ok: false,
    code: "DEPARTMENT_QUERY_INVALID",
  });

  // Wrong Content-Type rejected with 400
  const ctRes = await assignAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "text/plain",
        "idempotency-key": IDEM_KEY,
      },
      body: "{}",
    }),
    "true",
    deps,
  );
  assert.equal(ctRes.status, 400);
  assert.deepEqual(await ctRes.json(), { ok: false, code: "CONTENT_TYPE_INVALID" });

  // Oversized JSON body rejected with 413
  const bigRes = await assignAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        account_ref: USER_REF,
        expected_pair_version: 0,
        reason: "x".repeat(9000),
        idempotency_key: IDEM_KEY,
      }),
    }),
    "true",
    deps,
  );
  assert.equal(bigRes.status, 413);
  assert.deepEqual(await bigRes.json(), { ok: false, code: "BODY_TOO_LARGE" });
});

test("repository and API sanitize raw SQL errors and return canonical status codes on assign, replay, and end", async () => {
  const calls = [];
  const sampleMembership = {
    membership_id: MEMBERSHIP_ID,
    department_id: DEPT_ACCOUNTING,
    account_ref: USER_REF,
    display_name: "Trần Kế Toán",
    login_id: "ketoan.tran",
    personnel_code: "ketoan.tran",
    account_enabled: true,
    valid_from: "2026-10-24",
    valid_to: null,
    state: "CURRENT",
    effective: true,
    version: 1,
    pair_version: 1,
    granted_by_display_name: "Admin Gốc",
    revoked_by_display_name: null,
    revoked_at: null,
    created_at: "2026-10-24T02:00:00.000Z",
    updated_at: "2026-10-24T02:00:00.000Z",
  };

  let nextRpcResponse = { data: null, error: null };
  const repo = createServiceDepartmentRepository(async (fn, args) => {
    calls.push({ fn, args });
    return nextRpcResponse;
  });
  const deps = {
    resolveSession: makeSession(),
    repository: repo,
  };

  // Fresh assign -> 201
  nextRpcResponse = {
    data: { replayed: false, membership: sampleMembership },
    error: null,
  };
  const createdRes = await assignAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        account_ref: USER_REF,
        expected_pair_version: 0,
        reason: "Bổ nhiệm chính thức",
        idempotency_key: IDEM_KEY,
      }),
    }),
    "true",
    deps,
  );
  assert.equal(createdRes.status, 201);
  const createdJson = await createdRes.json();
  assert.equal(createdJson.ok, true);
  assert.equal(createdJson.replayed, false);
  assert.equal(calls.at(-1)?.fn, "org_department_assign_accounting_member");

  // Replayed assign -> 200
  nextRpcResponse = {
    data: { replayed: true, membership: sampleMembership },
    error: null,
  };
  const replayRes = await assignAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        account_ref: USER_REF,
        expected_pair_version: 0,
        reason: "Bổ nhiệm chính thức",
        idempotency_key: IDEM_KEY,
      }),
    }),
    "true",
    deps,
  );
  assert.equal(replayRes.status, 200);
  assert.equal((await replayRes.json()).replayed, true);

  // End membership -> 200
  nextRpcResponse = {
    data: {
      replayed: false,
      membership: {
        ...sampleMembership,
        valid_to: "2026-10-24",
        state: "HISTORY",
        effective: false,
        version: 2,
        pair_version: 2,
        revoked_by_display_name: "Admin Gốc",
        revoked_at: "2026-10-24T03:00:00.000Z",
      },
    },
    error: null,
  };
  const endedRes = await endAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships/${MEMBERSHIP_ID}/end`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        expected_pair_version: 1,
        reason: "Điều chuyển sang đơn vị khác",
        idempotency_key: IDEM_KEY,
      }),
    }),
    MEMBERSHIP_ID,
    "true",
    deps,
  );
  assert.equal(endedRes.status, 200);
  const endedJson = await endedRes.json();
  assert.equal(endedJson.ok, true);
  assert.equal(endedJson.membership.state, "HISTORY");
  assert.equal(endedJson.membership.effective, false);
  assert.equal(calls.at(-1)?.fn, "org_department_end_accounting_member");

  // Idempotency conflict -> 409 IDEMPOTENCY_CONFLICT
  nextRpcResponse = {
    data: null,
    error: { code: "23505", message: "IDEMPOTENCY_CONFLICT" },
  };
  const conflictRes = await endAccountingMemberAdmin(
    new Request(`${ORIGIN}/api/admin/departments/accounting/memberships/${MEMBERSHIP_ID}/end`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEM_KEY,
      },
      body: JSON.stringify({
        expected_pair_version: 1,
        reason: "Khác lý do với cùng key",
        idempotency_key: IDEM_KEY,
      }),
    }),
    MEMBERSHIP_ID,
    "true",
    deps,
  );
  assert.equal(conflictRes.status, 409);
  assert.deepEqual(await conflictRes.json(), {
    ok: false,
    code: "IDEMPOTENCY_CONFLICT",
  });

  // Raw unexpected SQL error never leaks table/column/SQL text to client
  nextRpcResponse = {
    data: null,
    error: {
      code: "XX000",
      message: 'internal postgres failure on relation "organization_department_memberships" secret@company.vn',
    },
  };
  const sanitizedRes = await listDepartmentsAdmin(
    new Request(`${ORIGIN}/api/admin/departments`),
    "true",
    deps,
  );
  assert.equal(sanitizedRes.status, 503);
  const sanitizedText = await sanitizedRes.text();
  assert.equal(sanitizedText.includes("organization_department_memberships"), false);
  assert.equal(sanitizedText.includes("secret@company.vn"), false);
  assert.deepEqual(JSON.parse(sanitizedText), {
    ok: false,
    code: "DEPARTMENT_UNAVAILABLE",
  });
});

test("department route registry discovers every route file under src/app/api/admin/departments and verifies every exported HTTP handler enforces DIRECT_ENTRY_API_ENABLED before params/session/repository", async () => {
  const discoveredRoutes = await discoverRouteFiles(
    path.resolve("src/app/api/admin/departments"),
  );
  const registeredRoutes = Object.keys(DEPARTMENT_ROUTE_REGISTRY).sort();
  assert.deepEqual(
    discoveredRoutes,
    registeredRoutes,
    "Every route file under src/app/api/admin/departments/** must be registered and covered by DIRECT_ENTRY_API_ENABLED gate tests",
  );

  let gatedEndpointCount = 0;
  for (const routeFile of discoveredRoutes) {
    const source = await readFile(path.resolve(routeFile), "utf8");
    const expectedMethods = DEPARTMENT_ROUTE_REGISTRY[routeFile];

    assert.match(source, /import\s+"server-only";/, `${routeFile} must import server-only`);
    assert.match(source, /export\s+const\s+runtime\s*=\s*"nodejs";/, `${routeFile} must use nodejs runtime`);
    assert.match(
      source,
      /export\s+const\s+dynamic\s*=\s*"force-dynamic";/,
      `${routeFile} must use force-dynamic`,
    );

    const exportedVerbs = HTTP_VERBS.filter((verb) =>
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`).test(source),
    );
    assert.deepEqual(
      exportedVerbs,
      Object.keys(expectedMethods),
      `${routeFile} exported HTTP verbs must match canonical registry`,
    );

    for (const [verb, expectedHandler] of Object.entries(expectedMethods)) {
      const fnBlock = extractExportedFunctionBlock(source, verb);
      assert.ok(fnBlock, `${routeFile} missing exported function ${verb}`);

      const gateIdx = fnBlock.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
      const notFoundIdx = fnBlock.indexOf('return failJson("NOT_FOUND", 404);');
      const delegateIdx = fnBlock.indexOf(`${expectedHandler}(`);
      const paramsAwaitIdx = fnBlock.indexOf("await context.params");

      assert.ok(gateIdx > 0, `${routeFile} ${verb} must check DIRECT_ENTRY_API_ENABLED !== "true"`);
      assert.ok(
        notFoundIdx > gateIdx,
        `${routeFile} ${verb} must return failJson("NOT_FOUND", 404) when gate is disabled`,
      );
      assert.ok(
        delegateIdx > notFoundIdx,
        `${routeFile} ${verb} must run feature gate before delegating to ${expectedHandler}`,
      );
      if (paramsAwaitIdx !== -1) {
        assert.ok(
          paramsAwaitIdx > notFoundIdx,
          `${routeFile} ${verb} must run feature gate before awaiting route params`,
        );
      }
      assert.match(
        fnBlock.slice(delegateIdx),
        new RegExp(`${expectedHandler}\\([\\s\\S]*?process\\.env\\.DIRECT_ENTRY_API_ENABLED`),
        `${routeFile} ${verb} must forward process.env.DIRECT_ENTRY_API_ENABLED to ${expectedHandler}`,
      );
      gatedEndpointCount += 1;
    }
  }

  assert.equal(gatedEndpointCount, 15, "All 15 department endpoints must be gated");
});

test("WP3 department create/update, person-membership, and HEAD handlers enforce feature gate and Full Admin", async () => {
  const calls = { session: 0, repository: 0 };
  const depsDisabled = {
    resolveSession: async () => {
      calls.session += 1;
      throw new Error("should not resolve session when gated off");
    },
    repository: failIfCalledRepository(calls),
  };
  const offResponses = await Promise.all([
    createDepartmentAdmin(new Request(`${ORIGIN}/api/admin/departments`, { method: "POST" }), "false", depsDisabled),
    updateDepartmentAdmin(new Request(`${ORIGIN}/api/admin/departments/${DEPT_ACCOUNTING}`, { method: "PATCH" }), DEPT_ACCOUNTING, "false", depsDisabled),
    listDepartmentPersonMembershipsAdmin(new Request(`${ORIGIN}/api/admin/departments/${DEPT_ACCOUNTING}/memberships`), DEPT_ACCOUNTING, "false", depsDisabled),
    assignDepartmentPersonMemberAdmin(new Request(`${ORIGIN}/api/admin/departments/${DEPT_ACCOUNTING}/memberships`, { method: "POST" }), DEPT_ACCOUNTING, "false", depsDisabled),
    endDepartmentPersonMemberAdmin(new Request(`${ORIGIN}/api/admin/departments/${DEPT_ACCOUNTING}/memberships/${MEMBERSHIP_ID}/end`, { method: "POST" }), DEPT_ACCOUNTING, MEMBERSHIP_ID, "false", depsDisabled),
    listDepartmentHeadsAdmin(new Request(`${ORIGIN}/api/admin/departments/${DEPT_ACCOUNTING}/head`), DEPT_ACCOUNTING, "false", depsDisabled),
    designateDepartmentHeadAdmin(new Request(`${ORIGIN}/api/admin/departments/${DEPT_ACCOUNTING}/head`, { method: "POST" }), DEPT_ACCOUNTING, "false", depsDisabled),
    endDepartmentHeadAdmin(new Request(`${ORIGIN}/api/admin/departments/${DEPT_ACCOUNTING}/head/end`, { method: "POST" }), DEPT_ACCOUNTING, "false", depsDisabled),
  ]);
  for (const res of offResponses) {
    assert.equal(res.status, 404);
  }
  assert.equal(calls.session, 0);
  assert.equal(calls.repository, 0);
});

test("Recruitment teams route exports GET only and exposes zero write methods", async () => {
  const routeSource = await readFile(
    path.resolve("src/app/api/admin/departments/recruitment/teams/route.ts"),
    "utf8",
  );
  assert.match(routeSource, /export\s+async\s+function\s+GET\b/);
  for (const forbiddenVerb of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.doesNotMatch(
      routeSource,
      new RegExp(`export\\s+(async\\s+)?function\\s+${forbiddenVerb}\\b`),
      `Recruitment teams route must not export ${forbiddenVerb}`,
    );
  }
});
