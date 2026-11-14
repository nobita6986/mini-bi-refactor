import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createPersonAdmin,
  getPersonAdmin,
  linkAccountPersonAdmin,
  listPersonsAdmin,
  setAccountTypeAdmin,
  transferPersonDepartmentAdmin,
  unlinkAccountPersonAdmin,
  updatePersonAdmin,
} from "./person-api.ts";

const HOST = "bi.local";
const ORIGIN = `https://${HOST}`;
const SAME_ORIGIN_POST_HEADERS = Object.freeze({
  host: HOST,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
});

const ACTOR_USER_ID = "10000000-0000-4000-8000-000000000001";
const ACTOR_AUTH_SUBJECT = "10000000-0000-4000-8000-000000000101";
const PERSON_ID = "20000000-0000-4000-8000-000000000002";
const DEPT_ID = "30000000-0000-4000-8000-000000000003";
const DEPT_ID_2 = "30000000-0000-4000-8000-000000000004";
const ACCOUNT_ID = "40000000-0000-4000-8000-000000000005";
const MEMBERSHIP_ID = "50000000-0000-4000-8000-000000000006";
const MEMBERSHIP_ID_2 = "50000000-0000-4000-8000-000000000007";
const LINK_ID = "60000000-0000-4000-8000-000000000008";
const IDEMP_KEY = "70000000-0000-4000-8000-000000000009";

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
      },
    },
  };
}

function makeScopedSession() {
  return {
    actor: {
      ok: true,
      actor: {
        auth_subject: ACTOR_AUTH_SUBJECT,
        app_user_id: ACTOR_USER_ID,
        enabled: true,
        capabilities: ["entry_admin"],
        scopes: [{ kind: "team", team_id: "80000000-0000-4000-8000-000000000001" }],
      },
    },
  };
}

function failIfCalledRepository() {
  const fail = () => {
    throw new Error("repository should not be called");
  };
  return {
    listPersons: fail,
    getPerson: fail,
    createPerson: fail,
    updatePerson: fail,
    transferPersonDepartment: fail,
    setAccountType: fail,
    linkAccountPerson: fail,
    unlinkAccountPerson: fail,
  };
}

function samplePersonSummary() {
  return {
    person_id: PERSON_ID,
    employee_code: "TD-001",
    full_name: "Nguyễn Văn An",
    status: "ACTIVE",
    joined_on: "2026-01-10",
    recruiter_id: null,
    version: 1,
    active_account_link: {
      link_id: LINK_ID,
      account_ref: ACCOUNT_ID,
      login_id: "an.nv",
      display_name: "Nguyễn Văn An",
      enabled: true,
      account_version: 1,
      started_at: "2026-11-13T02:00:00.000Z",
      source_kind: "ADMIN_MUTATION",
      evidence_date: null,
      version: 1,
    },
    active_department: {
      membership_id: MEMBERSHIP_ID,
      department_id: DEPT_ID,
      system_key: "RECRUITMENT",
      code: "RECRUITMENT",
      name: "Phòng Tuyển dụng",
      started_at: "2026-11-13T02:00:00.000Z",
      source_kind: "ADMIN_MUTATION",
      evidence_date: null,
      version: 1,
    },
  };
}

function samplePersonDetail() {
  const summary = samplePersonSummary();
  return {
    ...summary,
    department_history: [{ ...summary.active_department, ended_at: null }],
    head_assignments: [],
  };
}

function makeSuccessRepository() {
  return {
    async listPersons() {
      return {
        ok: true,
        data: {
          authorization_date: "2026-11-13",
          as_of: "2026-11-13T09:00:00.000Z",
          search: null,
          status: "active",
          department_id: null,
          link_state: "all",
          page: 1,
          page_size: 25,
          total: 1,
          has_more: false,
          persons: [samplePersonSummary()],
        },
      };
    },
    async getPerson() {
      return {
        ok: true,
        data: {
          authorization_date: "2026-11-13",
          as_of: "2026-11-13T09:00:00.000Z",
          person: samplePersonDetail(),
        },
      };
    },
    async createPerson() {
      return { ok: true, data: { replayed: false, person: samplePersonDetail() } };
    },
    async updatePerson() {
      return { ok: true, data: { replayed: false, person: samplePersonDetail() } };
    },
    async transferPersonDepartment() {
      return {
        ok: true,
        data: {
          replayed: false,
          person_version: 2,
          closed_membership: {
            membership_id: MEMBERSHIP_ID,
            department_id: DEPT_ID,
            started_at: "2026-11-13T02:00:00.000Z",
            ended_at: "2026-11-13T04:00:00.000Z",
            version: 2,
          },
          active_membership: {
            membership_id: MEMBERSHIP_ID_2,
            department_id: DEPT_ID_2,
            system_key: "MARKETING",
            code: "MARKETING",
            name: "Phòng Marketing",
            started_at: "2026-11-13T04:00:00.000Z",
            ended_at: null,
            source_kind: "ADMIN_MUTATION",
            evidence_date: null,
            version: 1,
          },
        },
      };
    },
    async setAccountType() {
      return {
        ok: true,
        data: {
          replayed: false,
          account: { account_ref: ACCOUNT_ID, account_type: "SHARED", version: 2 },
        },
      };
    },
    async linkAccountPerson() {
      return {
        ok: true,
        data: {
          replayed: false,
          account_version: 2,
          person_version: 2,
          link: {
            link_id: LINK_ID,
            account_ref: ACCOUNT_ID,
            person_id: PERSON_ID,
            employee_code: "TD-001",
            full_name: "Nguyễn Văn An",
            started_at: "2026-11-13T02:00:00.000Z",
            source_kind: "ADMIN_MUTATION",
            evidence_date: null,
            version: 1,
          },
        },
      };
    },
    async unlinkAccountPerson() {
      return {
        ok: true,
        data: {
          replayed: false,
          account_version: 3,
          person_version: 3,
          ended_link: {
            link_id: LINK_ID,
            account_ref: ACCOUNT_ID,
            person_id: PERSON_ID,
            started_at: "2026-11-13T02:00:00.000Z",
            ended_at: "2026-11-13T05:00:00.000Z",
            version: 2,
          },
        },
      };
    },
  };
}

function discoverRouteFiles(rootDir) {
  if (!existsSync(rootDir)) return [];
  const results = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...discoverRouteFiles(full));
    } else if (entry.name === "route.ts") {
      results.push(full);
    }
  }
  return results;
}

function extractExportedFunctionBlock(source, verb) {
  const matcher = new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`);
  const match = matcher.exec(source);
  if (!match) return null;
  const openParen = source.indexOf("(", match.index);
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
  const bodyStart = source.indexOf("{", paramsEnd);
  let braceDepth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") braceDepth += 1;
    else if (source[i] === "}") {
      braceDepth -= 1;
      if (braceDepth === 0) {
        return source.slice(match.index, i + 1);
      }
    }
  }
  return null;
}

const ROUTE_REGISTRY = Object.freeze({
  "src/app/api/admin/organization/persons/route.ts": Object.freeze({
    GET: "listPersonsAdmin",
    POST: "createPersonAdmin",
  }),
  "src/app/api/admin/organization/persons/[personId]/route.ts": Object.freeze({
    GET: "getPersonAdmin",
    PATCH: "updatePersonAdmin",
  }),
  "src/app/api/admin/organization/persons/[personId]/transfer-department/route.ts": Object.freeze({
    POST: "transferPersonDepartmentAdmin",
  }),
  "src/app/api/admin/access/accounts/[accountRef]/classification/route.ts": Object.freeze({
    POST: "setAccountTypeAdmin",
  }),
  "src/app/api/admin/access/accounts/[accountRef]/person-link/route.ts": Object.freeze({
    POST: "linkAccountPersonAdmin",
  }),
  "src/app/api/admin/access/accounts/[accountRef]/person-link/end/route.ts": Object.freeze({
    POST: "unlinkAccountPersonAdmin",
  }),
});

test("WP3 organization & access link routes enforce server-only, nodejs, force-dynamic, and feature gate before params", () => {
  const discoveredOrg = discoverRouteFiles(path.resolve("src/app/api/admin/organization")).map((f) =>
    path.relative(process.cwd(), f).replaceAll("\\", "/"),
  );
  assert.deepEqual(
    discoveredOrg.sort(),
    Object.keys(ROUTE_REGISTRY)
      .filter((r) => r.includes("/organization/"))
      .sort(),
  );

  for (const [rel, expectedMethods] of Object.entries(ROUTE_REGISTRY)) {
    const source = readFileSync(path.resolve(rel), "utf8");
    assert.match(source, /import\s+"server-only";/);
    assert.match(source, /export\s+const\s+runtime\s*=\s*"nodejs";/);
    assert.match(source, /export\s+const\s+dynamic\s*=\s*"force-dynamic";/);

    const exportedVerbs = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((verb) =>
      new RegExp(`export\\s+(?:async\\s+)?function\\s+${verb}\\b`).test(source),
    );
    assert.deepEqual(exportedVerbs, Object.keys(expectedMethods));

    for (const [verb, handler] of Object.entries(expectedMethods)) {
      const fnBlock = extractExportedFunctionBlock(source, verb);
      assert.ok(fnBlock, `${rel} missing ${verb}`);
      const gateIdx = fnBlock.indexOf('process.env.DIRECT_ENTRY_API_ENABLED !== "true"');
      const notFoundIdx = fnBlock.indexOf('return failJson("NOT_FOUND", 404);');
      const delegateIdx = fnBlock.indexOf(`${handler}(`);
      const paramsAwaitIdx = fnBlock.indexOf("await context.params");
      assert.ok(gateIdx > 0);
      assert.ok(notFoundIdx > gateIdx);
      assert.ok(delegateIdx > notFoundIdx);
      if (paramsAwaitIdx !== -1) {
        assert.ok(paramsAwaitIdx > notFoundIdx);
      }
    }
  }
});

test("organization API handlers fail closed on disabled flag, auth, CSRF, content-type, and oversized bodies", async () => {
  const deps = {
    resolveSession: async () => makeFullAdminSession(),
    repository: failIfCalledRepository(),
  };

  assert.equal(
    (await listPersonsAdmin(new Request(`${ORIGIN}/api/admin/organization/persons`), "false", deps))
      .status,
    404,
  );
  assert.equal(
    (
      await listPersonsAdmin(new Request(`${ORIGIN}/api/admin/organization/persons`), "true", {
        resolveSession: async () => ({ actor: { ok: false, reason: "UNAUTHENTICATED" } }),
        repository: failIfCalledRepository(),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await listPersonsAdmin(new Request(`${ORIGIN}/api/admin/organization/persons`), "true", {
        resolveSession: async () => makeScopedSession(),
        repository: failIfCalledRepository(),
      })
    ).status,
    403,
  );

  // Cross-origin CSRF rejected
  const crossOrigin = await createPersonAdmin(
    new Request(`${ORIGIN}/api/admin/organization/persons`, {
      method: "POST",
      headers: {
        host: HOST,
        origin: "https://evil.example",
        "content-type": "application/json",
        "idempotency-key": IDEMP_KEY,
      },
      body: JSON.stringify({}),
    }),
    "true",
    deps,
  );
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(await crossOrigin.json(), { ok: false, code: "CSRF_REJECTED" });

  // Non-JSON content-type rejected
  const badContentType = await createPersonAdmin(
    new Request(`${ORIGIN}/api/admin/organization/persons`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "text/plain",
        "idempotency-key": IDEMP_KEY,
      },
      body: "{}",
    }),
    "true",
    deps,
  );
  assert.equal(badContentType.status, 400);
  assert.deepEqual(await badContentType.json(), { ok: false, code: "CONTENT_TYPE_INVALID" });

  // Invalid JSON rejected
  const badJson = await createPersonAdmin(
    new Request(`${ORIGIN}/api/admin/organization/persons`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEMP_KEY,
      },
      body: "{bad-json",
    }),
    "true",
    deps,
  );
  assert.equal(badJson.status, 400);
  assert.deepEqual(await badJson.json(), { ok: false, code: "INVALID_JSON" });

  // Body > 8 KiB rejected with 413 BODY_TOO_LARGE
  const huge = await createPersonAdmin(
    new Request(`${ORIGIN}/api/admin/organization/persons`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEMP_KEY,
      },
      body: JSON.stringify({
        employee_code: "TD-001",
        full_name: "A".repeat(9000),
        reason: "Too big",
        idempotency_key: IDEMP_KEY,
      }),
    }),
    "true",
    deps,
  );
  assert.equal(huge.status, 413);
  assert.deepEqual(await huge.json(), { ok: false, code: "BODY_TOO_LARGE" });

  // Disallowed header rejected
  const disallowedHeader = await listPersonsAdmin(
    new Request(`${ORIGIN}/api/admin/organization/persons`, {
      headers: { "x-app-user-id": ACTOR_USER_ID },
    }),
    "true",
    deps,
  );
  assert.equal(disallowedHeader.status, 400);
  assert.deepEqual(await disallowedHeader.json(), {
    ok: false,
    code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  });
});

test("organization API handlers return canonical status codes (200/201/replayed 200) and sanitized 503 on repository throw", async () => {
  const deps = {
    resolveSession: async () => makeFullAdminSession(),
    repository: makeSuccessRepository(),
  };

  assert.equal(
    (await listPersonsAdmin(new Request(`${ORIGIN}/api/admin/organization/persons`), "true", deps))
      .status,
    200,
  );
  assert.equal(
    (
      await getPersonAdmin(
        new Request(`${ORIGIN}/api/admin/organization/persons/${PERSON_ID}`),
        PERSON_ID,
        "true",
        deps,
      )
    ).status,
    200,
  );

  // Create returns 201 when not replayed, 200 when replayed
  const created = await createPersonAdmin(
    new Request(`${ORIGIN}/api/admin/organization/persons`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEMP_KEY,
      },
      body: JSON.stringify({
        employee_code: "TD-001",
        full_name: "Nguyễn Văn An",
        reason: "Tạo mới",
        idempotency_key: IDEMP_KEY,
      }),
    }),
    "true",
    deps,
  );
  assert.equal(created.status, 201);

  const replayed = await createPersonAdmin(
    new Request(`${ORIGIN}/api/admin/organization/persons`, {
      method: "POST",
      headers: {
        ...SAME_ORIGIN_POST_HEADERS,
        "content-type": "application/json",
        "idempotency-key": IDEMP_KEY,
      },
      body: JSON.stringify({
        employee_code: "TD-001",
        full_name: "Nguyễn Văn An",
        reason: "Tạo mới",
        idempotency_key: IDEMP_KEY,
      }),
    }),
    "true",
    {
      ...deps,
      repository: {
        ...deps.repository,
        async createPerson() {
          return { ok: true, data: { replayed: true, person: samplePersonDetail() } };
        },
      },
    },
  );
  assert.equal(replayed.status, 200);

  assert.equal(
    (
      await updatePersonAdmin(
        new Request(`${ORIGIN}/api/admin/organization/persons/${PERSON_ID}`, {
          method: "PATCH",
          headers: {
            ...SAME_ORIGIN_POST_HEADERS,
            "content-type": "application/json",
            "idempotency-key": IDEMP_KEY,
          },
          body: JSON.stringify({
            expected_person_version: 1,
            employee_code: "TD-001",
            full_name: "Nguyễn Văn An",
            joined_on: null,
            status: "ACTIVE",
            reason: "Cập nhật",
            idempotency_key: IDEMP_KEY,
          }),
        }),
        PERSON_ID,
        "true",
        deps,
      )
    ).status,
    200,
  );

  assert.equal(
    (
      await transferPersonDepartmentAdmin(
        new Request(`${ORIGIN}/api/admin/organization/persons/${PERSON_ID}/transfer-department`, {
          method: "POST",
          headers: {
            ...SAME_ORIGIN_POST_HEADERS,
            "content-type": "application/json",
            "idempotency-key": IDEMP_KEY,
          },
          body: JSON.stringify({
            target_department_ref: DEPT_ID_2,
            expected_person_version: 1,
            expected_current_membership_id: MEMBERSHIP_ID,
            reason: "Điều chuyển",
            idempotency_key: IDEMP_KEY,
          }),
        }),
        PERSON_ID,
        "true",
        deps,
      )
    ).status,
    200,
  );

  assert.equal(
    (
      await setAccountTypeAdmin(
        new Request(`${ORIGIN}/api/admin/access/accounts/${ACCOUNT_ID}/classification`, {
          method: "POST",
          headers: {
            ...SAME_ORIGIN_POST_HEADERS,
            "content-type": "application/json",
            "idempotency-key": IDEMP_KEY,
          },
          body: JSON.stringify({
            account_type: "SHARED",
            expected_account_version: 1,
            reason: "Phân loại tài khoản",
            idempotency_key: IDEMP_KEY,
          }),
        }),
        ACCOUNT_ID,
        "true",
        deps,
      )
    ).status,
    200,
  );

  assert.equal(
    (
      await linkAccountPersonAdmin(
        new Request(`${ORIGIN}/api/admin/access/accounts/${ACCOUNT_ID}/person-link`, {
          method: "POST",
          headers: {
            ...SAME_ORIGIN_POST_HEADERS,
            "content-type": "application/json",
            "idempotency-key": IDEMP_KEY,
          },
          body: JSON.stringify({
            person_id: PERSON_ID,
            expected_account_version: 1,
            expected_person_version: 1,
            reason: "Gán nhân sự",
            idempotency_key: IDEMP_KEY,
          }),
        }),
        ACCOUNT_ID,
        "true",
        deps,
      )
    ).status,
    201,
  );

  assert.equal(
    (
      await unlinkAccountPersonAdmin(
        new Request(`${ORIGIN}/api/admin/access/accounts/${ACCOUNT_ID}/person-link/end`, {
          method: "POST",
          headers: {
            ...SAME_ORIGIN_POST_HEADERS,
            "content-type": "application/json",
            "idempotency-key": IDEMP_KEY,
          },
          body: JSON.stringify({
            expected_account_version: 2,
            expected_person_version: 2,
            expected_link_id: LINK_ID,
            reason: "Gỡ gắn kết",
            idempotency_key: IDEMP_KEY,
          }),
        }),
        ACCOUNT_ID,
        "true",
        deps,
      )
    ).status,
    200,
  );

  // Repository failure sanitizes SQL details
  const repoFail = await listPersonsAdmin(
    new Request(`${ORIGIN}/api/admin/organization/persons`),
    "true",
    {
      resolveSession: async () => makeFullAdminSession(),
      repository: {
        ...deps.repository,
        async listPersons() {
          return { ok: false, code: "ORG_UNAVAILABLE" };
        },
      },
    },
  );
  assert.equal(repoFail.status, 503);
  const failBody = await repoFail.json();
  assert.deepEqual(failBody, { ok: false, code: "ORG_UNAVAILABLE" });
});
