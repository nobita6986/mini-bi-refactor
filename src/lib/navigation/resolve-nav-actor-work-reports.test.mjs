/**
 * WP8D (Nav Readonly Slice) — Runtime Behavioral Tests for `resolveNavActorForAppShell`
 * and `resolveWorkReportObligationsAccessForRequest`.
 *
 * Executes the real `src/lib/navigation/resolve-nav-actor.ts` module with a per-request
 * React `cache()` harness and stubbed server dependencies to prove:
 *   1. Feature flag `WORK_REPORTS_API_ENABLED` gating (off -> 0 probe calls).
 *   2. Short-circuit when `workReportsNavPredicate(projection)` is already true.
 *   3. Read-only probe (`hasActiveObligations`) invoked at most once per request via
 *      React `cache()`; `listMine` is NEVER called.
 *   4. Fail-closed without breaking AppShell on denied, unavailable, malformed, or
 *      thrown RPC / repository errors while preserving Leave/other nav probes.
 *   5. Zero cross-request / cross-user caching (User A -> User B isolation).
 *   6. Zero PII/admin/schema_json leakage onto `NavActorProjection`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

let currentRequestCache = null;

function runInRequest(fn) {
  const prev = currentRequestCache;
  currentRequestCache = new Map();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      currentRequestCache = prev;
    });
}

function requestScopedCache(fn) {
  return function cachedWrapper(...args) {
    if (!currentRequestCache) {
      return fn(...args);
    }
    let fnMap = currentRequestCache.get(fn);
    if (!fnMap) {
      fnMap = new Map();
      currentRequestCache.set(fn, fnMap);
    }
    const key = args.length === 0 ? "__noargs__" : JSON.stringify(args);
    if (fnMap.has(key)) {
      return fnMap.get(key);
    }
    const result = fn(...args);
    fnMap.set(key, result);
    return result;
  };
}

function loadTsModule(relativePath, overrides = {}) {
  const fullPath = path.join(repoRoot, relativePath);
  const source = readFileSync(fullPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: fullPath,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const mod = { exports: {} };
  const localRequire = Module.createRequire(fullPath);
  const customRequire = (specifier) => {
    if (Object.prototype.hasOwnProperty.call(overrides, specifier)) {
      return overrides[specifier];
    }
    if (specifier.startsWith("@/")) {
      const resolved = path.join(repoRoot, "src", specifier.slice(2));
      if (Object.prototype.hasOwnProperty.call(overrides, resolved)) {
        return overrides[resolved];
      }
    }
    return localRequire(specifier);
  };
  const fn = new Function("exports", "require", "module", "__filename", "__dirname", outputText);
  fn(mod.exports, customRequire, mod, fullPath, path.dirname(fullPath));
  return mod.exports;
}

const USER_A = {
  auth_subject: "18800000-0000-4000-8000-000000000001",
  app_user_id: "28800000-0000-4000-8000-000000000001",
  capabilities: [],
  scopes: [],
  effective_grants: [],
  assigned_roles: [{ role_code: "STAFF", status: "ACTIVE" }],
};

const USER_B = {
  auth_subject: "18800000-0000-4000-8000-000000000002",
  app_user_id: "28800000-0000-4000-8000-000000000002",
  capabilities: [],
  scopes: [],
  effective_grants: [],
};

const REPORT_ADMIN = {
  auth_subject: "18800000-0000-4000-8000-000000000003",
  app_user_id: "28800000-0000-4000-8000-000000000003",
  capabilities: ["report_assign"],
  scopes: [{ kind: "all" }],
};

function createHarness() {
  const state = {
    actorResult: { ok: true, actor: USER_A },
    workReportCalls: [],
    listMineCalls: [],
    leaveCalls: [],
    createSubmissionRepoImpl: null,
    hasActiveObligationsImpl: async () => ({
      ok: true,
      data: { has_active_obligations: false },
    }),
    leaveAccessImpl: async () => ({
      ok: true,
      data: {
        can_access: false,
        can_manage_config: false,
        can_view_monthly_report: false,
      },
    }),
  };

  const registryCapability = loadTsModule("src/lib/navigation/registry-capability.ts", {
    "server-only": {},
  });

  const submissionRepoModule = loadTsModule("src/lib/work-reports/submission-repository.ts", {
    "server-only": {},
    "./contracts.ts": {},
    "./assignment-repository.ts": {},
    "./schema-validator.ts": { validateWorkReportSchema: () => ({ ok: true }) },
  });

  const navModule = loadTsModule("src/lib/navigation/resolve-nav-actor.ts", {
    "server-only": {},
    react: { cache: requestScopedCache },
    "@/lib/navigation/registry-capability": registryCapability,
    "@/lib/auth/direct-entry-page-access": {
      EMPTY_CHANGE_REQUEST_HISTORICAL_PROBE: { hasHistoricalRequests: false },
      probeHistoricalChangeRequestAccess: async () => ({ hasHistoricalRequests: false }),
    },
    "@/lib/auth/direct-entry-session": {
      getDirectEntryActor: async () => state.actorResult,
    },
    "@/lib/auth/direct-entry-session-retry": {
      resolveSessionWithBoundedRetry: async (loader) => ({ actor: await loader() }),
    },
    "@/lib/direct-entry/actor-context-repository": {
      createDirectEntryActorRepository: () => ({}),
    },
    "@/lib/direct-entry/change-request-read-repository": {
      createChangeRequestReadRepository: () => ({
        listChangeRequests: async () => ({ ok: true, data: { items: [] } }),
      }),
    },
    "@/lib/leave/leave-repository": {
      createLeaveRepository: () => ({
        getActorAccess: async (input) => {
          state.leaveCalls.push(input);
          return state.leaveAccessImpl(input);
        },
        getMySummary: async () => {
          throw new Error("FORBIDDEN_LEGACY_LEAVE_WRITE_PATH");
        },
      }),
    },
    "@/lib/salary-advance/salary-advance-repository": {
      createSalaryAdvanceRepository: () => ({
        getActorAccess: async () => ({ ok: true, data: { can_access: false } }),
      }),
    },
    "@/lib/vendor-finance/vendor-finance-repository": {
      createVendorFinanceRepository: () => ({
        getActorAccess: async () => ({
          ok: true,
          data: {
            can_view: false,
            can_record: false,
            can_reconcile: false,
            can_manage_project_assignments: false,
          },
        }),
      }),
    },
    "@/lib/work-reports/submission-repository": {
      createSubmissionRepository: () => {
        if (state.createSubmissionRepoImpl) {
          return state.createSubmissionRepoImpl();
        }
        return {
          hasActiveObligations: async (input) => {
            state.workReportCalls.push(input);
            return state.hasActiveObligationsImpl(input);
          },
          listMine: async (input) => {
            state.listMineCalls.push(input);
            throw new Error("FORBIDDEN_LIST_MINE_IN_NAVBAR");
          },
        };
      },
    },
  });

  return { state, navModule, registryCapability, submissionRepoModule };
}

function withEnv(vars, fn) {
  const previous = {};
  for (const [key, val] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, val] of Object.entries(previous)) {
        if (val === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = val;
        }
      }
    });
}

test("WP8D nav runtime: skips probe completely when WORK_REPORTS_API_ENABLED is not true", async () => {
  const { state, navModule, registryCapability } = createHarness();
  state.hasActiveObligationsImpl = async () => ({
    ok: true,
    data: { has_active_obligations: true },
  });

  await withEnv({ WORK_REPORTS_API_ENABLED: "false", DIRECT_ENTRY_API_ENABLED: "false" }, async () => {
    const projection = await runInRequest(() =>
      navModule.resolveNavActorForAppShell({ directEntryEnabled: true }),
    );
    assert.ok(projection);
    assert.equal(state.workReportCalls.length, 0);
    assert.equal(state.listMineCalls.length, 0);
    assert.equal(projection.hasWorkReportObligations, undefined);
    assert.equal(registryCapability.workReportsNavPredicate(projection), false);
  });
});

test("WP8D nav runtime: short-circuits probe when actor already satisfies workReportsNavPredicate", async () => {
  const { state, navModule, registryCapability } = createHarness();
  state.actorResult = { ok: true, actor: REPORT_ADMIN };

  await withEnv({ WORK_REPORTS_API_ENABLED: "true", DIRECT_ENTRY_API_ENABLED: "false" }, async () => {
    const projection = await runInRequest(() =>
      navModule.resolveNavActorForAppShell({ directEntryEnabled: true }),
    );
    assert.ok(projection);
    assert.equal(state.workReportCalls.length, 0);
    assert.equal(state.listMineCalls.length, 0);
    assert.equal(registryCapability.workReportsNavPredicate(projection), true);
  });
});

test("WP8D nav runtime: calls read-only hasActiveObligations once per request, projects minimal boolean, and leaks zero PII/admin data", async () => {
  const { state, navModule, registryCapability } = createHarness();
  state.hasActiveObligationsImpl = async () => ({
    ok: true,
    data: { has_active_obligations: true },
  });

  await withEnv({ WORK_REPORTS_API_ENABLED: "true", DIRECT_ENTRY_API_ENABLED: "false" }, async () => {
    await runInRequest(async () => {
      const projection = await navModule.resolveNavActorForAppShell({ directEntryEnabled: true });
      const secondRead = await navModule.resolveWorkReportObligationsAccessForRequest();
      assert.ok(projection);
      assert.equal(projection.hasWorkReportObligations, true);
      assert.equal(secondRead.hasActiveObligations, true);
      assert.equal(registryCapability.workReportsNavPredicate(projection), true);
      assert.equal(state.workReportCalls.length, 1, "React cache deduplicates probe within same request");
      assert.deepEqual(state.workReportCalls[0], {
        auth_subject: USER_A.auth_subject,
        app_user_id: USER_A.app_user_id,
      });
      assert.equal(state.listMineCalls.length, 0, "listMine must never be called");
      assert.equal("app_user_id" in projection, false, "zero app_user_id PII leak");
      assert.equal("auth_subject" in projection, false, "zero auth_subject PII leak");
      assert.equal("assigned_roles" in projection, false, "zero assigned_roles leak");
      assert.equal("schema_json" in projection, false, "zero schema_json leak");
      assert.equal("obligations" in projection, false, "zero obligation rows leak");
    });
  });
});

test("WP8D nav runtime: fails closed without breaking AppShell or Leave probe on denied, unavailable, malformed, or thrown errors", async () => {
  const failureCases = [
    {
      name: "RPC denied (42501)",
      setup: (state) => {
        state.hasActiveObligationsImpl = async () => ({ ok: false, kind: "denied" });
      },
    },
    {
      name: "RPC unavailable",
      setup: (state) => {
        state.hasActiveObligationsImpl = async () => ({ ok: false, kind: "unavailable" });
      },
    },
    {
      name: "hasActiveObligations throws",
      setup: (state) => {
        state.hasActiveObligationsImpl = async () => {
          throw new Error("DB connection lost");
        };
      },
    },
    {
      name: "createSubmissionRepository throws (e.g. missing env)",
      setup: (state) => {
        state.createSubmissionRepoImpl = () => {
          throw new Error("SUPABASE_SECRET_KEY missing");
        };
      },
    },
    {
      name: "malformed RPC payload via real repository parser",
      setup: (state, submissionRepoModule) => {
        state.createSubmissionRepoImpl = () =>
          submissionRepoModule.createSubmissionRepository(async () => ({
            data: { has_active_obligations: true, extra_admin_flag: true },
            error: null,
          }));
      },
    },
  ];

  for (const tc of failureCases) {
    const { state, navModule, registryCapability, submissionRepoModule } = createHarness();
    state.leaveAccessImpl = async () => ({
      ok: true,
      data: {
        can_access: true,
        can_manage_config: false,
        can_view_monthly_report: false,
      },
    });
    tc.setup(state, submissionRepoModule);

    await withEnv({ WORK_REPORTS_API_ENABLED: "true", DIRECT_ENTRY_API_ENABLED: "true" }, async () => {
      const projection = await runInRequest(() =>
        navModule.resolveNavActorForAppShell({ directEntryEnabled: true }),
      );
      assert.ok(projection, `${tc.name}: AppShell projection must still render`);
      assert.equal(
        projection.hasWorkReportObligations,
        undefined,
        `${tc.name}: Work Reports nav flag must fail closed`,
      );
      assert.equal(
        registryCapability.workReportsNavPredicate(projection),
        false,
        `${tc.name}: Work Reports nav entry must stay hidden`,
      );
      assert.equal(
        projection.hasLeaveManagementAccess,
        true,
        `${tc.name}: Leave probe must remain unaffected`,
      );
      assert.equal(state.listMineCalls.length, 0);
    });
  }
});

test("WP8D nav runtime: zero cross-request or cross-user cache leakage", async () => {
  const { state, navModule } = createHarness();
  const responsesByUser = new Map([
    [USER_A.app_user_id, true],
    [USER_B.app_user_id, false],
  ]);
  state.hasActiveObligationsImpl = async (input) => ({
    ok: true,
    data: { has_active_obligations: responsesByUser.get(input.app_user_id) === true },
  });

  await withEnv({ WORK_REPORTS_API_ENABLED: "true", DIRECT_ENTRY_API_ENABLED: "false" }, async () => {
    // Request 1: User A -> true
    state.actorResult = { ok: true, actor: USER_A };
    const projA1 = await runInRequest(() =>
      navModule.resolveNavActorForAppShell({ directEntryEnabled: true }),
    );
    assert.equal(projA1.hasWorkReportObligations, true);

    // Request 2: User B -> false (must NOT inherit User A's cached true)
    state.actorResult = { ok: true, actor: USER_B };
    const projB = await runInRequest(() =>
      navModule.resolveNavActorForAppShell({ directEntryEnabled: true }),
    );
    assert.equal(projB.hasWorkReportObligations, undefined);

    // Request 3: User A after revocation -> false (must re-probe on new request)
    responsesByUser.set(USER_A.app_user_id, false);
    state.actorResult = { ok: true, actor: USER_A };
    const projA2 = await runInRequest(() =>
      navModule.resolveNavActorForAppShell({ directEntryEnabled: true }),
    );
    assert.equal(projA2.hasWorkReportObligations, undefined);

    assert.equal(state.workReportCalls.length, 3);
    assert.deepEqual(
      state.workReportCalls.map((c) => c.app_user_id),
      [USER_A.app_user_id, USER_B.app_user_id, USER_A.app_user_id],
    );
  });
});
