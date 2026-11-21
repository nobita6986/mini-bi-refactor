import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const repoRequire = Module.createRequire(path.join(repoRoot, "package.json"));

const notifications = { success: [], error: [], warning: [], info: [] };
const notifyStub = {
  success: (item) => notifications.success.push(item),
  error: (item) => notifications.error.push(item),
  warning: (item) => notifications.warning.push(item),
  info: (item) => notifications.info.push(item),
  dismiss: () => {},
  clear: () => {},
};

const stubCache = new Map();
function stubComponent(name) {
  if (!stubCache.has(name)) {
    const component = () => null;
    Object.defineProperty(component, "name", { value: name });
    stubCache.set(name, component);
  }
  return stubCache.get(name);
}

const dialogStub = {
  __esModule: true,
  Root: stubComponent("DialogRoot"),
  Trigger: stubComponent("DialogTrigger"),
  Portal: stubComponent("DialogPortal"),
  Overlay: stubComponent("DialogOverlay"),
  Content: stubComponent("DialogContent"),
  Title: stubComponent("DialogTitle"),
  Description: stubComponent("DialogDescription"),
  Close: stubComponent("DialogClose"),
};

let activeHookInstance = null;

function equalDeps(prev, next) {
  return (
    Array.isArray(prev) &&
    Array.isArray(next) &&
    prev.length === next.length &&
    prev.every((value, index) => Object.is(value, next[index]))
  );
}

const reactShim = {
  __esModule: true,
  Fragment: "Fragment",
  useState(initial) {
    const instance = activeHookInstance;
    const index = instance.cursor++;
    if (!instance.slots[index]) {
      instance.slots[index] = {
        value: typeof initial === "function" ? initial() : initial,
      };
    }
    const slot = instance.slots[index];
    const setter = (next) => {
      if (instance.unmounted) return;
      const computed = typeof next === "function" ? next(slot.value) : next;
      if (!Object.is(computed, slot.value)) {
        slot.value = computed;
        instance.dirty = true;
      }
    };
    return [slot.value, setter];
  },
  useRef(initial) {
    const instance = activeHookInstance;
    const index = instance.cursor++;
    if (!instance.slots[index]) {
      instance.slots[index] = { current: initial };
    }
    return instance.slots[index];
  },
  useMemo(factory, deps) {
    const instance = activeHookInstance;
    const index = instance.cursor++;
    const slot = instance.slots[index];
    if (!slot || deps === undefined || !equalDeps(slot.deps, deps)) {
      const value = factory();
      instance.slots[index] = { deps, value };
      return value;
    }
    return slot.value;
  },
  useCallback(fn, deps) {
    return reactShim.useMemo(() => fn, deps);
  },
  useEffect(effect, deps) {
    const instance = activeHookInstance;
    const index = instance.cursor++;
    const prev = instance.slots[index];
    if (!prev || deps === undefined || !equalDeps(prev.deps, deps)) {
      const slot = {
        deps,
        cleanup: prev?.cleanup ?? null,
        setupFn: effect,
        cleanupRegistered: false,
      };
      instance.slots[index] = slot;
      instance.pendingEffects.push(() => {
        if (typeof slot.cleanup === "function") {
          const runCleanup = slot.cleanup;
          slot.cleanup = null;
          runCleanup();
        }
        if (instance.unmounted) return;
        const cleanup = slot.setupFn();
        slot.cleanup = typeof cleanup === "function" ? cleanup : null;
        if (!slot.cleanupRegistered) {
          slot.cleanupRegistered = true;
          instance.cleanups.add(() => {
            if (typeof slot.cleanup === "function") {
              const fn = slot.cleanup;
              slot.cleanup = null;
              fn();
            }
          });
        }
      });
    } else {
      prev.setupFn = effect;
    }
  },
  useId() {
    return reactShim.useRef(`wp13-pr2-id-${activeHookInstance.id}-${activeHookInstance.cursor}`)
      .current;
  },
};

function jsx(type, props, key) {
  return { type, props: props ?? {}, key: key ?? null };
}

const originalModuleLoad = Module._load;
const originalTsExt = Module._extensions[".ts"];
const originalTsxExt = Module._extensions[".tsx"];
const originalFetch = globalThis.fetch;

const uiProxyCache = new Map();
function uiModuleProxy(specifier) {
  if (!uiProxyCache.has(specifier)) {
    uiProxyCache.set(
      specifier,
      new Proxy(
        {},
        {
          get(_, prop) {
            if (prop === "__esModule") return true;
            if (prop === "useNotify") return () => notifyStub;
            if (prop === "buttonClasses") return () => "button";
            if (
              prop === "DATA_TABLE_CLASS" ||
              prop === "DATA_TABLE_HEAD_CLASS" ||
              prop === "DATA_TABLE_TH_CLASS" ||
              prop === "DATA_TABLE_ROW_CLASS" ||
              prop === "DATA_TABLE_TD_CLASS"
            ) {
              return String(prop);
            }
            return stubComponent(String(prop));
          },
        },
      ),
    );
  }
  return uiProxyCache.get(specifier);
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "react") return reactShim;
  if (request === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
  if (request === "server-only") return {};
  if (request === "next/link") return { __esModule: true, default: stubComponent("Link") };
  if (request === "lucide-react") return uiModuleProxy("lucide-react");
  if (request === "radix-ui/dialog") return dialogStub;
  if (
    request.startsWith("@/components/ui/") ||
    request.startsWith("@/components/reporting/") ||
    request === "@/components/admin/admin-subnav"
  ) {
    return uiModuleProxy(request);
  }
  if (request.startsWith("@/")) {
    const resolved = path.join(repoRoot, "src", request.slice(2));
    return originalModuleLoad.call(this, resolved, parent, isMain);
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

for (const ext of [".ts", ".tsx"]) {
  Module._extensions[ext] = (mod, filename) => {
    const source = readFileSync(filename, "utf8");
    const compiled = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
        allowImportingTsExtensions: true,
      },
    });
    mod._compile(compiled.outputText, filename);
  };
}

let nextInstanceId = 1;
const activeMounts = new Set();

function mount(Component, initialProps = {}) {
  const instance = {
    id: nextInstanceId++,
    props: initialProps,
    slots: [],
    cursor: 0,
    dirty: true,
    unmounted: false,
    pendingEffects: [],
    cleanups: new Set(),
    tree: null,
  };

  function renderOnce() {
    if (instance.unmounted) return;
    instance.cursor = 0;
    instance.dirty = false;
    const prev = activeHookInstance;
    activeHookInstance = instance;
    try {
      instance.tree = Component(instance.props);
    } finally {
      activeHookInstance = prev;
    }
  }

  function runEffects() {
    let guard = 0;
    while (!instance.unmounted && guard++ < 40) {
      if (instance.dirty) renderOnce();
      const effects = instance.pendingEffects.splice(0);
      if (effects.length === 0) break;
      for (const fn of effects) fn();
      if (instance.dirty) renderOnce();
    }
  }

  renderOnce();
  runEffects();

  const handle = {
    get tree() {
      return instance.tree;
    },
    setProps(nextProps) {
      instance.props = nextProps;
      instance.dirty = true;
      runEffects();
    },
    async flush(rounds = 8) {
      for (let i = 0; i < rounds; i += 1) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        runEffects();
      }
    },
    unmount() {
      if (instance.unmounted) return;
      instance.unmounted = true;
      for (const cleanup of instance.cleanups) cleanup();
      instance.cleanups.clear();
      activeMounts.delete(handle);
    },
  };
  activeMounts.add(handle);
  return handle;
}

function collectNodes(node, out = []) {
  if (node == null || typeof node === "boolean" || typeof node === "string" || typeof node === "number") {
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, out);
    return out;
  }
  if (typeof node === "object" && "type" in node) {
    out.push(node);
    const props = node.props ?? {};
    for (const key of Object.keys(props)) {
      if (key === "children" || typeof props[key] === "object") {
        collectNodes(props[key], out);
      }
    }
  }
  return out;
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node.props) {
    const titlePart = typeof node.props.title === "string" ? `${node.props.title} ` : "";
    return `${titlePart}${textOf(node.props.children)}`;
  }
  return "";
}

function findNode(handle, predicate) {
  const found = collectNodes(handle.tree).find(predicate);
  assert.ok(found, "Expected matching element in rendered tree");
  return found;
}

function maybeNode(handle, predicate) {
  return collectNodes(handle.tree).find(predicate) ?? null;
}

function findButton(handle, label) {
  return findNode(
    handle,
    (node) => typeof node.props?.onClick === "function" && textOf(node).trim() === label,
  );
}

function maybeButton(handle, label) {
  return maybeNode(
    handle,
    (node) => typeof node.props?.onClick === "function" && textOf(node).trim() === label,
  );
}

async function syncChildFromTree(parentHandle, ChildComponent, existingHandle) {
  const node = findNode(
    parentHandle,
    (n) => typeof n.type === "function" && n.type.name === ChildComponent.name,
  );
  if (!existingHandle) {
    const child = mount(ChildComponent, node.props);
    await child.flush();
    return child;
  }
  existingHandle.setProps(node.props);
  await existingHandle.flush();
  return existingHandle;
}

let requests = [];
function setupFetchMock() {
  requests = [];
  globalThis.fetch = (url, options = {}) => {
    const signal = options.signal ?? null;
    let resolveFn;
    let rejectFn;
    const promise = new Promise((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    const entry = {
      url: String(url),
      method: String(options.method ?? "GET").toUpperCase(),
      options,
      signal,
      settled: false,
      resolve: resolveFn,
      reject: rejectFn,
    };
    if (signal) {
      const onAbort = () => {
        if (!entry.settled) {
          entry.settled = true;
          rejectFn(new DOMException("Aborted", "AbortError"));
        }
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    requests.push(entry);
    return promise;
  };
}

function respond(req, status, body) {
  assert.ok(req, "Expected pending fetch request");
  if (req.settled) return;
  req.settled = true;
  req.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  });
}

function rejectNetwork(req, message = "network failure") {
  assert.ok(req, "Expected pending fetch request");
  if (req.settled) return;
  req.settled = true;
  req.reject(new TypeError(message));
}

function findLastRequest(predicate) {
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    if (predicate(requests[i])) return requests[i];
  }
  return null;
}

function makeMemoryStorage(overrides = {}) {
  const store = new Map();
  return {
    store,
    getItem(key) {
      if (overrides.getItem) return overrides.getItem(key, store);
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      if (overrides.setItem) return overrides.setItem(key, value, store);
      store.set(key, String(value));
    },
    removeItem(key) {
      if (overrides.removeItem) return overrides.removeItem(key, store);
      store.delete(key);
    },
  };
}

const ORIGIN = "https://hrp.example.test";
const ADMIN_A_ID = "10000000-0000-4000-8000-000000000001";
const ADMIN_B_ID = "10000000-0000-4000-8000-000000000002";
const PERSON_ID = "40000000-0000-4000-8000-000000000011";
const ACCOUNT_ID = "20000000-0000-4000-8000-000000000011";
const ACCOUNT_SPECIAL_ID = "20000000-0000-4000-8000-000000000022";
const LINK_ID = "50000000-0000-4000-8000-000000000011";
const INTENT_ID = "60000000-0000-4000-8000-000000000011";
const INTENT_TOKEN = "62000000-0000-4000-8000-000000000011";
const AUTH_SUBJECT_UUID = "63000000-0000-4000-8000-000000000011";
const REVISION_ID = "61000000-0000-4000-8000-000000000011";

function makeFinalizeCreateAccount(overrides = {}) {
  return {
    app_user_id: ACCOUNT_ID,
    auth_subject: AUTH_SUBJECT_UUID,
    display_name: "Nguyễn Văn An",
    version: 1,
    revision_id: REVISION_ID,
    intent_id: INTENT_ID,
    intent_state: "APPLIED",
    ...overrides,
  };
}

function makeIntentEnvelope(state = "INDETERMINATE", overrides = {}) {
  return {
    intent_id: INTENT_ID,
    intent_token: INTENT_TOKEN,
    kind: "CREATE_ACCOUNT",
    state,
    ...overrides,
  };
}
const RECRUITER_ID = "70000000-0000-4000-8000-000000000011";
const RECRUITER_PAGE2_ID = "70000000-0000-4000-8000-000000000099";
const DEPT_ID = "30000000-0000-4000-8000-000000000011";
const AUTH_DATE = "2026-11-21";
const AS_OF = "2026-11-21T08:00:00.000Z";

function makeDeptListEnvelope() {
  return {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    departments: [
      {
        department_id: DEPT_ID,
        system_key: "recruitment",
        code: "RECRUITMENT",
        name: "Phòng Tuyển dụng",
        status: "ACTIVE",
        version: 1,
        active_member_count: 3,
        active_head: null,
      },
    ],
  };
}

function makePersonSummary(overrides = {}) {
  return {
    person_id: PERSON_ID,
    employee_code: "NS-101",
    full_name: "Nguyễn Văn An",
    status: "ACTIVE",
    joined_on: "2026-01-10",
    recruiter_id: null,
    version: 1,
    active_account_link: null,
    active_department: null,
    ...overrides,
  };
}

function makePersonDetail(overrides = {}) {
  return {
    ...makePersonSummary(),
    department_history: [],
    head_assignments: [],
    ...overrides,
  };
}

function makePersonListEnvelope(persons = [], overrides = {}) {
  return {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    search: null,
    status: "active",
    department_id: null,
    link_state: "all",
    page: 1,
    page_size: 25,
    total: persons.length,
    has_more: false,
    persons,
    ...overrides,
  };
}

function makeAccount(overrides = {}) {
  return {
    account_ref: ACCOUNT_ID,
    display_name: "Nguyễn Văn An",
    login_id: "an.nv",
    enabled: true,
    version: 1,
    account_type: "NORMAL",
    active_person_link: null,
    ...overrides,
  };
}

function makeAccountListEnvelope(accounts = [], overrides = {}) {
  return {
    ok: true,
    list: {
      search: null,
      enabled: "all",
      page: 1,
      page_size: 25,
      total: accounts.length,
      accounts,
      ...overrides,
    },
  };
}

function makeLinkPersonEnvelope(overrides = {}) {
  return {
    ok: true,
    replayed: false,
    account_version: overrides.account_version ?? 2,
    person_version: overrides.person_version ?? 2,
    link: {
      link_id: LINK_ID,
      account_ref: ACCOUNT_ID,
      person_id: PERSON_ID,
      employee_code: "NS-101",
      full_name: "Nguyễn Văn An",
      started_at: AS_OF,
      source_kind: "ADMIN_MUTATION",
      evidence_date: null,
      version: 1,
      ...(overrides.link ?? {}),
    },
  };
}

function makeAssignRoleEnvelope(roleCode, accountVersion, assignmentId = "80000000-0000-4000-8000-000000000009") {
  return {
    ok: true,
    replayed: false,
    account_ref: ACCOUNT_ID,
    account_version: accountVersion,
    assignment: {
      assignment_id: assignmentId,
      role_code: roleCode,
      display_name: roleCode === "ADMIN" ? "BoD/Admin" : "Tuyển dụng",
      is_effective: true,
      inactive_reason: null,
      is_protected: false,
      can_revoke: true,
      cannot_revoke_reason: null,
      source_kind: "ADMIN_ASSIGNMENT",
      started_at: AS_OF,
      ended_at: null,
      reason: "Cấp vai trò khởi tạo",
      ended_reason: null,
      assigned_by_display: "Owner",
    },
  };
}

function makeEffectiveAccessEnvelope(overrides = {}) {
  const accountRef = overrides.accountRef ?? ACCOUNT_ID;
  return {
    ok: true,
    as_of: AS_OF,
    account: {
      account_ref: accountRef,
      login_id: "an.nv",
      display_name: "Nguyễn Văn An",
      enabled: true,
      account_type: "NORMAL",
      authz_managed: true,
      version: overrides.version ?? 2,
      person: {
        person_id: PERSON_ID,
        employee_code: "NS-101",
        full_name: "Nguyễn Văn An",
        status: "ACTIVE",
        department_id: DEPT_ID,
        department_name: "Phòng Tuyển dụng",
      },
      ...(overrides.account ?? {}),
    },
    blocking_reasons: [],
    assigned_global_roles: [
      {
        assignment_id: "80000000-0000-4000-8000-000000000001",
        role_code: "EMPLOYEE_BASE",
        display_name: "Nhân viên cơ bản",
        is_effective: true,
        inactive_reason: null,
        is_protected: false,
        can_revoke: true,
        cannot_revoke_reason: null,
        source_kind: "ADMIN_ASSIGNMENT",
        started_at: AS_OF,
        ended_at: null,
        reason: "Khởi tạo",
        ended_reason: null,
        assigned_by_display: "Owner",
      },
    ],
    contextual_assignments: [],
    direct_exceptions: [],
    module_authorities: [],
    effective_grants: [],
    ...(overrides.detail ?? {}),
  };
}

function makePersonnel(overrides = {}) {
  return {
    recruiter_id: RECRUITER_ID,
    personnel_code: "an.nv",
    display_name: "Nguyễn Văn An",
    personnel_position: "STAFF",
    active: true,
    version: 1,
    hrp_valid_from: "2026-01-10",
    revision_count: 1,
    team_names: ["Nhóm 1"],
    ...overrides,
  };
}

const { computeCheckpointActorScope } = repoRequire("./src/lib/admin/checkpoint-actor-scope.ts");
const {
  PROVISION_CHECKPOINT_STORAGE_KEY,
  classifyProvisionStep2Response,
  clearVerifiedCheckpoint,
  getProvisionCheckpointStorageKey,
  parseProvisionCheckpointV2,
  persistAndVerifyCheckpoint,
  readVerifiedCheckpoint,
  resolveNextStep4AccountVersion,
} = repoRequire("./src/lib/admin/provision-checkpoint-v2.ts");
const {
  buildAccountListQuery,
  parseAccountManagementView,
  resolveAccountViewFilters,
} = repoRequire("./src/lib/admin/account-access-model.ts");
const {
  ADMIN_SECTIONS,
  groupAdminSections,
  isAdminSectionActive,
  visibleAdminSections,
} = repoRequire("./src/lib/admin/admin-navigation.ts");
const { PersonListManager } = repoRequire("./src/components/admin/person-list-manager.tsx");
const { PersonDetailManager } = repoRequire("./src/components/admin/person-detail-manager.tsx");
const { AccountProvisionAndLinkStepper } = repoRequire(
  "./src/components/admin/account-provision-and-link-stepper.tsx",
);
const { AccountRolesEmbeddedSection } = repoRequire(
  "./src/components/admin/account-roles-embedded-section.tsx",
);
const { AccountManager } = repoRequire("./src/components/admin/account-manager.tsx");
const {
  AccountSpecialCreateDialog,
  AccountLegacyCreatePersonDialog,
} = repoRequire("./src/components/admin/account-auxiliary-dialogs.tsx");
const { PersonnelCatalogManager } = repoRequire(
  "./src/components/admin/personnel-catalog-manager.tsx",
);
const { EffectiveAccessWorkspace } = repoRequire(
  "./src/components/admin/effective-access-workspace.tsx",
);

const ACTOR_A_SCOPE = computeCheckpointActorScope(ADMIN_A_ID);
const ACTOR_B_SCOPE = computeCheckpointActorScope(ADMIN_B_ID);
const ACTOR_A_STORAGE_KEY = getProvisionCheckpointStorageKey(ACTOR_A_SCOPE);
const ACTOR_B_STORAGE_KEY = getProvisionCheckpointStorageKey(ACTOR_B_SCOPE);

beforeEach(() => {
  notifications.success.length = 0;
  notifications.error.length = 0;
  notifications.warning.length = 0;
  notifications.info.length = 0;
  setupFetchMock();
  for (const h of [...activeMounts]) h.unmount();
});

after(() => {
  for (const h of [...activeMounts]) h.unmount();
  Module._load = originalModuleLoad;
  Module._extensions[".ts"] = originalTsExt;
  Module._extensions[".tsx"] = originalTsxExt;
  globalThis.fetch = originalFetch;
});

// ============================================================================
// 1. Pure Security, Actor Scope, Checkpoint V2 & Query Filter Contracts
// ============================================================================

test("Checkpoint V2 actor scope is opaque, deterministic, isolated per admin, and never leaks raw identity or role labels", () => {
  assert.match(ACTOR_A_SCOPE, /^act_[0-9a-f]{24}$/);
  assert.match(ACTOR_B_SCOPE, /^act_[0-9a-f]{24}$/);
  assert.notEqual(ACTOR_A_SCOPE, ACTOR_B_SCOPE);
  assert.equal(computeCheckpointActorScope(ADMIN_A_ID.toUpperCase()), ACTOR_A_SCOPE);
  assert.equal(ACTOR_A_SCOPE.includes(ADMIN_A_ID), false);
  assert.equal(ACTOR_A_SCOPE.toLowerCase().includes("admin"), false);
  assert.throws(() => computeCheckpointActorScope("not-a-uuid"));
  assert.throws(() => computeCheckpointActorScope("ADMIN"));
});

test("Checkpoint V2 rejects secrets, fails closed on storage quota/readback mismatch, and isolates two admins without deleting foreign checkpoint", () => {
  const validCp = {
    schema_version: 2,
    client_flow_id: "90000000-0000-4000-8000-000000000001",
    env_origin: ORIGIN,
    actor_scope: ACTOR_A_SCOPE,
    flow_kind: "CREATE_EMPLOYEE_WITH_LOGIN",
    updated_at: AS_OF,
    step1_person: {
      status: "IN_FLIGHT",
      idempotency_key: "91000000-0000-4000-8000-000000000001",
      payload_snapshot: {
        employee_code: "NS-101",
        full_name: "Nguyễn Văn An",
        joined_on: "2026-01-10",
        initial_department_ref: null,
        reason: "Tiếp nhận mới",
      },
      committed_person_id: null,
      committed_person_version: null,
      existing_employee_code: null,
      existing_full_name: null,
      existing_recruiter_id: null,
    },
    step2_account: {
      status: "IDLE",
      idempotency_key: "92000000-0000-4000-8000-000000000001",
      non_secret_snapshot: { login_id: "an.nv", display_name: "Nguyễn Văn An", reason: "Tiếp nhận mới" },
      intent_id: null,
      intent_state: null,
      reconcile_idempotency_key: null,
      committed_account_ref: null,
      committed_account_version: null,
    },
    step3_link: {
      status: "IDLE",
      idempotency_key: "93000000-0000-4000-8000-000000000001",
      payload_snapshot: null,
      post_link_account_version: null,
      post_link_person_version: null,
    },
    step4_roles: [],
  };

  // Quota error blocks write
  const quotaStorage = makeMemoryStorage({
    setItem() {
      throw new Error("QuotaExceededError");
    },
  });
  const qRes = persistAndVerifyCheckpoint(validCp, quotaStorage);
  assert.equal(qRes.ok, false);
  assert.equal(qRes.reason, "WRITE_ERROR");

  // Read-back mismatch blocks write
  const mismatchStorage = makeMemoryStorage({
    getItem() {
      return null;
    },
  });
  const mRes = persistAndVerifyCheckpoint(validCp, mismatchStorage);
  assert.equal(mRes.ok, false);
  assert.equal(mRes.reason, "READBACK_MISMATCH");

  // Secret injection rejected
  const storage = makeMemoryStorage();
  const dirtyCp = { ...validCp, password: "SecretPassword123!" };
  const sRes = persistAndVerifyCheckpoint(dirtyCp, storage);
  assert.equal(sRes.ok, false);
  assert.equal(storage.store.size, 0);

  // Valid write + read-back passes onto actor-scoped key; zero forbidden keys serialized
  const okRes = persistAndVerifyCheckpoint(validCp, storage);
  assert.equal(okRes.ok, true);
  const rawJson = storage.store.get(ACTOR_A_STORAGE_KEY);
  assert.ok(rawJson);
  assert.doesNotMatch(rawJson, /password|auth_subject|access_token|refresh_token|jwt/i);
  assert.equal(rawJson.includes(ADMIN_A_ID), false);
  assert.equal(ACTOR_A_STORAGE_KEY.includes(ADMIN_A_ID), false);

  // Admin B cannot read OR clear Admin A's checkpoint!
  const readByB = readVerifiedCheckpoint({
    expectedOrigin: ORIGIN,
    expectedActorScope: ACTOR_B_SCOPE,
    storage,
  });
  assert.equal(readByB.kind, "none");
  clearVerifiedCheckpoint({
    expectedOrigin: ORIGIN,
    expectedActorScope: ACTOR_B_SCOPE,
    storage,
  });
  // Still present for Admin A!
  const readByA = readVerifiedCheckpoint({
    expectedOrigin: ORIGIN,
    expectedActorScope: ACTOR_A_SCOPE,
    storage,
  });
  assert.equal(readByA.kind, "valid");

  // Wrong origin also isolated
  const readWrongOrigin = readVerifiedCheckpoint({
    expectedOrigin: "https://other.example.test",
    expectedActorScope: ACTOR_A_SCOPE,
    storage,
  });
  assert.equal(readWrongOrigin.kind, "foreign_actor_or_origin");

  // Backward-compatible legacy shared key also enforces foreign_actor_or_origin & refuses B's clear!
  const legacyStorage = makeMemoryStorage();
  legacyStorage.setItem(PROVISION_CHECKPOINT_STORAGE_KEY, JSON.stringify(validCp));
  assert.equal(
    readVerifiedCheckpoint({ expectedOrigin: ORIGIN, expectedActorScope: ACTOR_B_SCOPE, storage: legacyStorage }).kind,
    "foreign_actor_or_origin",
  );
  clearVerifiedCheckpoint({ expectedOrigin: ORIGIN, expectedActorScope: ACTOR_B_SCOPE, storage: legacyStorage });
  assert.equal(
    readVerifiedCheckpoint({ expectedOrigin: ORIGIN, expectedActorScope: ACTOR_A_SCOPE, storage: legacyStorage }).kind,
    "valid",
  );
});

test("Step 2 response classifier rejects malformed 200 and accepts strict FinalizeCreate & PR #13 fallback", () => {
  // Malformed 200 (missing app_user_id) -> uncertain, never applied
  const bad1 = classifyProvisionStep2Response(200, { ok: true, account: { version: 1, intent_state: "APPLIED" } }, { operation: "create_account" });
  assert.equal(bad1.kind, "unavailable");
  assert.equal(bad1.preserveIdempotencyKey, true);

  // Malformed 200 (intent_state !== APPLIED)
  const bad2 = classifyProvisionStep2Response(200, {
    ok: true,
    account: { app_user_id: ACCOUNT_ID, intent_id: INTENT_ID, version: 1, intent_state: "IN_FLIGHT" },
  }, { operation: "create_account" });
  assert.equal(bad2.kind, "unavailable");

  // Strict FinalizeCreateEnvelope -> applied
  const okStrict = classifyProvisionStep2Response(200, {
    ok: true,
    account: makeFinalizeCreateAccount(),
  }, { operation: "create_account" });
  assert.equal(okStrict.kind, "applied");
  assert.equal(okStrict.account.accountRef, ACCOUNT_ID);
  assert.equal(okStrict.account.accountVersion, 1);

  // PR #13 fallback (revision_id: null) -> applied
  const okFallback = classifyProvisionStep2Response(200, {
    ok: true,
    replayed: true,
    account: makeFinalizeCreateAccount({
      auth_subject: null,
      version: 2,
      revision_id: null,
    }),
  }, { operation: "create_account" });
  assert.equal(okFallback.kind, "applied");
  assert.equal(okFallback.account.accountVersion, 2);
  assert.equal(okFallback.account.replayed, true);
});

test("Account view filters map ?view=special and ?view=unlinked strictly to PR-0 API params without leaking UI params", () => {
  assert.equal(parseAccountManagementView("special"), "special");
  assert.equal(parseAccountManagementView("unlinked"), "unlinked");
  assert.equal(parseAccountManagementView("unknown"), "all");
  assert.equal(parseAccountManagementView(undefined), "all");

  const specialParams = buildAccountListQuery({
    search: "",
    enabled: "all",
    page: 2,
    ...resolveAccountViewFilters("special"),
  });
  assert.equal(specialParams.get("account_type"), "SPECIAL");
  assert.equal(specialParams.has("link_state"), false);
  assert.equal(specialParams.has("view"), false);
  assert.equal(specialParams.get("page"), "2");

  const unlinkedParams = buildAccountListQuery({
    search: "an",
    enabled: "true",
    page: 1,
    ...resolveAccountViewFilters("unlinked"),
  });
  assert.equal(unlinkedParams.get("account_type"), "NORMAL");
  assert.equal(unlinkedParams.get("link_state"), "unlinked");
  assert.equal(unlinkedParams.has("view"), false);
  assert.equal(unlinkedParams.has("tab"), false);

  const allParams = buildAccountListQuery({
    search: "",
    enabled: "all",
    page: 1,
    ...resolveAccountViewFilters("all"),
  });
  assert.equal(allParams.has("account_type"), false);
  assert.equal(allParams.has("link_state"), false);
});

test("AdminSubnav §5.2 order renames Nhân sự, drops standalone accounts, keeps teams, and highlights Nhân sự on /admin/access/accounts", () => {
  const fullAdmin = {
    capabilities: [
      "entry_admin",
      "recruiter_master_manage",
      "team_master_manage",
      "worker_edit_history_view",
    ],
    scopes: [{ kind: "all" }],
    effective_grants: [
      { capability: "entry_admin", scope_kind: "ALL", scope_id: null },
      { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null },
      { capability: "team_master_manage", scope_kind: "ALL", scope_id: null },
      { capability: "worker_edit_history_view", scope_kind: "ALL", scope_id: null },
    ],
  };
  const visible = visibleAdminSections(fullAdmin);
  const grouped = groupAdminSections(visible);
  assert.deepEqual(
    grouped.map((item) => (item.type === "group" ? `group:${item.label}` : `${item.section.id}:${item.section.label}`)),
    [
      "organization-persons:Nhân sự",
      "departments:Phòng ban",
      "effective-access:Quyền hiệu lực",
      "group:Danh mục tuyển dụng",
      "attendance:Báo cáo chấm công",
      "worker-edit-history:Lịch sử chỉnh sửa NLĐ",
    ],
  );
  assert.equal(ADMIN_SECTIONS.some((s) => s.id === "accounts"), false);
  assert.equal(ADMIN_SECTIONS.some((s) => s.id === "teams" && s.href === "/admin/catalog/teams"), true);
  assert.equal(isAdminSectionActive("/admin/access/accounts", "/admin/organization/persons"), true);
  assert.equal(isAdminSectionActive("/admin/access/accounts?view=special", "/admin/organization/persons"), true);
});

// ============================================================================
// 2. Unified Provision Stepper: Happy Paths + Pre-Step-1 Faults + Reload Recovery
// ============================================================================

test("Pre-Step-1 checkpoint persist failure (QuotaExceeded & read-back mismatch) aborts BEFORE POST /persons with 0 network calls", async () => {
  const brokenStorage = makeMemoryStorage({
    setItem() {
      throw new Error("QuotaExceededError");
    },
  });
  const pl = mount(PersonListManager, {
    checkpointActorScope: ACTOR_A_SCOPE,
    storage: brokenStorage,
    originOverride: ORIGIN,
  });
  await pl.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
  await pl.flush();

  findButton(pl, "+ Thêm nhân viên").props.onClick();
  await pl.flush();
  const stepper = await syncChildFromTree(pl, AccountProvisionAndLinkStepper, null);
  findNode(stepper, (n) => n.props?.id === "create-person-employee-code").props.onChange({ target: { value: "NS-200" } });
  findNode(stepper, (n) => n.props?.id === "create-person-full-name").props.onChange({ target: { value: "Trần An" } });
  findNode(stepper, (n) => n.props?.id === "create-person-reason").props.onChange({ target: { value: "Tiếp nhận" } });
  await stepper.flush();

  const postCountBefore = requests.filter((r) => r.method === "POST").length;
  findNode(stepper, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepper.flush();
  assert.equal(requests.filter((r) => r.method === "POST").length, postCountBefore);
  assert.equal(textOf(stepper.tree).includes("Không thể lưu checkpoint phục hồi trước khi gửi"), true);
});

test("Happy path: Create employee WITH login + optional role executes Person -> Account -> Link -> Role, clears RAM password & checkpoint", async () => {
  const storage = makeMemoryStorage();
  const pl = mount(PersonListManager, {
    checkpointActorScope: ACTOR_A_SCOPE,
    canManageGlobalRoles: true,
    storage,
    originOverride: ORIGIN,
  });
  await pl.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
  await pl.flush();

  findButton(pl, "+ Thêm nhân viên").props.onClick();
  await pl.flush();
  const stepper = await syncChildFromTree(pl, AccountProvisionAndLinkStepper, null);

  findNode(stepper, (n) => n.props?.id === "create-person-employee-code").props.onChange({ target: { value: "NS-101" } });
  findNode(stepper, (n) => n.props?.id === "create-person-full-name").props.onChange({ target: { value: "Nguyễn Văn An" } });
  findNode(stepper, (n) => n.props?.id === "create-person-reason").props.onChange({ target: { value: "Tiếp nhận mới" } });
  findNode(stepper, (n) => n.props?.id === "provision-want-login-toggle").props.onChange({ target: { checked: true } });
  await stepper.flush();

  findNode(stepper, (n) => n.props?.id === "provision-login-id").props.onChange({ target: { value: "an.nv" } });
  findNode(stepper, (n) => n.props?.id === "provision-password").props.onChange({ target: { value: "TempPass!123" } });
  findNode(stepper, (n) => n.props?.id === "provision-password-confirm").props.onChange({ target: { value: "TempPass!123" } });
  // Select optional RECRUITER role checkbox
  const checkboxes = collectNodes(stepper.tree).filter((n) => n.type === "input" && n.props?.type === "checkbox");
  // checkboxes[0] is want-login toggle, checkboxes[1] is RECRUITER
  checkboxes[1].props.onChange({ target: { checked: true } });
  await stepper.flush();

  findNode(stepper, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepper.flush();

  // Checkpoint MUST already exist in storage right before/during Step 1 and contain ZERO passwords!
  const cpBeforeStep1Done = storage.store.get(ACTOR_A_STORAGE_KEY);
  assert.ok(cpBeforeStep1Done);
  assert.equal(cpBeforeStep1Done.includes("TempPass!123"), false);

  // Step 1: POST /api/admin/organization/persons
  const req1 = findLastRequest((r) => r.method === "POST" && r.url === "/api/admin/organization/persons");
  assert.ok(req1);
  respond(req1, 201, { ok: true, replayed: false, person: makePersonDetail() });
  await stepper.flush();

  // Step 2: POST /api/admin/access/accounts
  const req2 = findLastRequest((r) => r.method === "POST" && r.url === "/api/admin/access/accounts");
  assert.ok(req2);
  respond(req2, 200, {
    ok: true,
    account: makeFinalizeCreateAccount(),
  });
  await stepper.flush();

  // Step 3: POST /api/admin/access/accounts/[id]/person-link
  const req3 = findLastRequest((r) => r.method === "POST" && r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/person-link`);
  assert.ok(req3);
  respond(req3, 201, makeLinkPersonEnvelope({ account_version: 2, person_version: 2 }));
  await stepper.flush();

  // Step 4: POST /api/admin/access/accounts/[id]/roles (RECRUITER)
  const req4 = findLastRequest((r) => r.method === "POST" && r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/roles`);
  assert.ok(req4);
  const req4Body = JSON.parse(req4.options.body);
  assert.equal(req4Body.role_code, "RECRUITER");
  assert.equal(req4Body.expected_version, 2);
  respond(req4, 201, makeAssignRoleEnvelope("RECRUITER", 3));
  await stepper.flush();

  // Checkpoint cleared after full completion & success toast emitted
  assert.equal(storage.store.has(ACTOR_A_STORAGE_KEY), false);
  assert.equal(storage.store.has(PROVISION_CHECKPOINT_STORAGE_KEY), false);
  assert.equal(notifications.success.length >= 1, true);
});

test("Fault recovery: Step 1 disconnect -> reload -> Admin B sees NO banner -> Admin A resumes with exact K_person; Step 2 INDETERMINATE with intent_id reconciles with 0 password & 0 second Auth call", async () => {
  const storage = makeMemoryStorage();
  const plA = mount(PersonListManager, {
    checkpointActorScope: ACTOR_A_SCOPE,
    storage,
    originOverride: ORIGIN,
  });
  await plA.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
  await plA.flush();

  findButton(plA, "+ Thêm nhân viên").props.onClick();
  await plA.flush();
  const stepperA = await syncChildFromTree(plA, AccountProvisionAndLinkStepper, null);
  findNode(stepperA, (n) => n.props?.id === "create-person-employee-code").props.onChange({ target: { value: "NS-501" } });
  findNode(stepperA, (n) => n.props?.id === "create-person-full-name").props.onChange({ target: { value: "Phạm Thị Bình" } });
  findNode(stepperA, (n) => n.props?.id === "create-person-reason").props.onChange({ target: { value: "Tiếp nhận" } });
  findNode(stepperA, (n) => n.props?.id === "provision-want-login-toggle").props.onChange({ target: { checked: true } });
  await stepperA.flush();
  findNode(stepperA, (n) => n.props?.id === "provision-login-id").props.onChange({ target: { value: "binh.pt" } });
  findNode(stepperA, (n) => n.props?.id === "provision-password").props.onChange({ target: { value: "PassWord#999" } });
  findNode(stepperA, (n) => n.props?.id === "provision-password-confirm").props.onChange({ target: { value: "PassWord#999" } });
  await stepperA.flush();

  findNode(stepperA, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepperA.flush();

  const step1Req1 = findLastRequest((r) => r.url === "/api/admin/organization/persons" && r.method === "POST");
  const kPerson = step1Req1.options.headers["Idempotency-Key"];
  const step1Body = step1Req1.options.body;
  // Network drops right after Step 1 committed on server!
  rejectNetwork(step1Req1);
  await stepperA.flush();

  // Simulate full browser reload (unmount Admin A)
  stepperA.unmount();
  plA.unmount();

  // Admin B opens page on same browser -> MUST NOT see Admin A's banner and MUST NOT delete storage
  const plB = mount(PersonListManager, {
    checkpointActorScope: ACTOR_B_SCOPE,
    storage,
    originOverride: ORIGIN,
  });
  await plB.flush();
  assert.equal(maybeButton(plB, "Tiếp tục / Đối chiếu"), null);
  assert.equal(storage.store.has(ACTOR_A_STORAGE_KEY), true);
  plB.unmount();

  // Admin A reloads page -> sees resume banner!
  const plA2 = mount(PersonListManager, {
    checkpointActorScope: ACTOR_A_SCOPE,
    storage,
    originOverride: ORIGIN,
  });
  await plA2.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
  await plA2.flush();

  findButton(plA2, "Tiếp tục / Đối chiếu").props.onClick();
  await plA2.flush();
  const stepperA2 = await syncChildFromTree(plA2, AccountProvisionAndLinkStepper, null);
  await stepperA2.flush();

  // Submit replays EXACT K_person & body -> server returns replayed: true (no duplicate person!)
  findNode(stepperA2, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepperA2.flush();
  const step1Replay = findLastRequest((r) => r.url === "/api/admin/organization/persons" && r.method === "POST");
  assert.equal(step1Replay.options.headers["Idempotency-Key"], kPerson);
  assert.equal(step1Replay.options.body, step1Body);
  respond(step1Replay, 200, {
    ok: true,
    replayed: true,
    person: makePersonDetail({ employee_code: "NS-501", full_name: "Phạm Thị Bình" }),
  });
  await stepperA2.flush();

  // After Step 1 replay post-reload, password was NOT in storage -> Stepper asks to re-enter password (0 auto-search by login_id!)
  assert.equal(requests.some((r) => r.url.includes("search=binh.pt")), false);
  findNode(stepperA2, (n) => n.props?.id === "provision-password").props.onChange({ target: { value: "PassWord#999" } });
  findNode(stepperA2, (n) => n.props?.id === "provision-password-confirm").props.onChange({ target: { value: "PassWord#999" } });
  await stepperA2.flush();

  findNode(stepperA2, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepperA2.flush();

  // Step 2 returns INDETERMINATE with intent_id -> password cleared, NEEDS_RECONCILE saved
  const step2Req = findLastRequest((r) => r.url === "/api/admin/access/accounts" && r.method === "POST");
  assert.ok(step2Req);
  respond(step2Req, 200, {
    ok: true,
    intent: makeIntentEnvelope("INDETERMINATE"),
  });
  await stepperA2.flush();

  // Password inputs must now be hidden (0 password needed for reconcile) & storage has zero secret
  assert.equal(maybeNode(stepperA2, (n) => n.props?.id === "provision-password"), null);
  assert.equal(storage.store.get(ACTOR_A_STORAGE_KEY).includes("PassWord#999"), false);

  // Trigger reconcile -> calls POST /api/admin/access/accounts/intents/[id]/reconcile (0 second POST /accounts!)
  const createAccountCountBeforeReconcile = requests.filter(
    (r) => r.url === "/api/admin/access/accounts" && r.method === "POST",
  ).length;
  findNode(stepperA2, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepperA2.flush();
  const reconcileReq = findLastRequest(
    (r) => r.url === `/api/admin/access/accounts/intents/${INTENT_ID}/reconcile`,
  );
  assert.ok(reconcileReq);
  assert.equal(
    requests.filter((r) => r.url === "/api/admin/access/accounts" && r.method === "POST").length,
    createAccountCountBeforeReconcile,
  );

  respond(reconcileReq, 200, {
    ok: true,
    account: makeFinalizeCreateAccount({ display_name: "Phạm Thị Bình" }),
  });
  await stepperA2.flush();

  // Automatically continues to Step 3 person-link!
  const linkReq = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/person-link`);
  assert.ok(linkReq);
  respond(linkReq, 201, makeLinkPersonEnvelope({
    account_version: 2,
    person_version: 2,
    link: { employee_code: "NS-501", full_name: "Phạm Thị Bình" },
  }));
  await stepperA2.flush();
  assert.equal(storage.store.has(ACTOR_A_STORAGE_KEY), false);
  assert.equal(storage.store.has(PROVISION_CHECKPOINT_STORAGE_KEY), false);
});

test("Fault recovery: Step 2 disconnect BEFORE intent_id + reload keeps frozen K_account (0 login_id search), Step 3 RECRUITER_LINK_MISMATCH + 409 reload + Step 4 partial failure never repeat committed steps", async () => {
  const storage = makeMemoryStorage();
  const pl = mount(PersonListManager, {
    checkpointActorScope: ACTOR_A_SCOPE,
    canManageGlobalRoles: true,
    storage,
    originOverride: ORIGIN,
  });
  await pl.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope([makePersonSummary()]));
  await pl.flush();

  // Open login for existing active employee -> skips POST /persons completely!
  findButton(pl, "Mở đăng nhập").props.onClick();
  await pl.flush();
  const stepper1 = await syncChildFromTree(pl, AccountProvisionAndLinkStepper, null);
  findNode(stepper1, (n) => n.props?.id === "open-login-reason").props.onChange({ target: { value: "Mở đăng nhập nhân viên" } });
  findNode(stepper1, (n) => n.props?.id === "provision-login-id").props.onChange({ target: { value: "an.nv" } });
  findNode(stepper1, (n) => n.props?.id === "provision-password").props.onChange({ target: { value: "InitPass!11" } });
  findNode(stepper1, (n) => n.props?.id === "provision-password-confirm").props.onChange({ target: { value: "InitPass!11" } });
  // Check two roles: RECRUITER and ADMIN
  const roleChecks = collectNodes(stepper1.tree).filter((n) => n.type === "input" && n.props?.type === "checkbox");
  roleChecks[0].props.onChange({ target: { checked: true } });
  roleChecks[2].props.onChange({ target: { checked: true } });
  await stepper1.flush();

  findNode(stepper1, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepper1.flush();
  // Zero POST /persons calls in open-login-existing mode!
  assert.equal(requests.some((r) => r.method === "POST" && r.url === "/api/admin/organization/persons"), false);

  const acctReq1 = findLastRequest((r) => r.method === "POST" && r.url === "/api/admin/access/accounts");
  const kAccount = acctReq1.options.headers["Idempotency-Key"];
  // Disconnect BEFORE receiving intent_id!
  rejectNetwork(acctReq1);
  await stepper1.flush();

  // Password must NEVER be in storage
  assert.equal(storage.store.get(ACTOR_A_STORAGE_KEY).includes("InitPass!11"), false);

  // Full reload (unmount & remount)
  stepper1.unmount();
  pl.unmount();

  const plReload = mount(PersonListManager, {
    checkpointActorScope: ACTOR_A_SCOPE,
    canManageGlobalRoles: true,
    storage,
    originOverride: ORIGIN,
  });
  await plReload.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope([makePersonSummary()]));
  await plReload.flush();

  findButton(plReload, "Tiếp tục / Đối chiếu").props.onClick();
  await plReload.flush();
  const stepper2 = await syncChildFromTree(plReload, AccountProvisionAndLinkStepper, null);
  // Server verification GET /persons/[id] runs automatically on resume
  const verifyGet = findLastRequest((r) => r.method === "GET" && r.url === `/api/admin/organization/persons/${PERSON_ID}`);
  assert.ok(verifyGet);
  respond(verifyGet, 200, { ok: true, authorization_date: AUTH_DATE, as_of: AS_OF, person: makePersonDetail() });
  await stepper2.flush();

  // Zero auto-search of /accounts?search=an.nv!
  assert.equal(requests.some((r) => r.url.includes("/api/admin/access/accounts?")), false);
  assert.equal(textOf(stepper2.tree).includes("Chưa có mã đối chiếu (intent_id)"), true);

  // Re-enter password -> replays EXACT frozen K_account!
  findNode(stepper2, (n) => n.props?.id === "provision-password").props.onChange({ target: { value: "InitPass!11" } });
  findNode(stepper2, (n) => n.props?.id === "provision-password-confirm").props.onChange({ target: { value: "InitPass!11" } });
  await stepper2.flush();
  findNode(stepper2, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepper2.flush();

  const acctReq2 = findLastRequest((r) => r.method === "POST" && r.url === "/api/admin/access/accounts");
  assert.equal(acctReq2.options.headers["Idempotency-Key"], kAccount);

  // First test malformed 200 -> stays uncertain, does NOT advance to Step 3!
  respond(acctReq2, 200, { ok: true, account: { version: 1 } });
  await stepper2.flush();
  assert.equal(requests.some((r) => r.url.includes("/person-link")), false);

  // Retry exact same K_account -> valid APPLIED response
  findNode(stepper2, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepper2.flush();
  const acctReq3 = findLastRequest((r) => r.method === "POST" && r.url === "/api/admin/access/accounts");
  assert.equal(acctReq3.options.headers["Idempotency-Key"], kAccount);
  respond(acctReq3, 200, {
    ok: true,
    account: makeFinalizeCreateAccount(),
  });
  await stepper2.flush();

  // Step 3: first return 409 VERSION_CONFLICT -> reload versions -> retry without repeating Step 2!
  const linkReq1 = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/person-link`);
  assert.ok(linkReq1);
  respond(linkReq1, 409, { ok: false, code: "VERSION_CONFLICT" });
  await stepper2.flush();

  const accountPostCountAfterStep2 = requests.filter(
    (r) => r.method === "POST" && r.url === "/api/admin/access/accounts",
  ).length;

  findButton(stepper2, "Tải lại phiên bản mới nhất từ máy chủ").props.onClick();
  await stepper2.flush();
  respond(findLastRequest((r) => r.method === "GET" && r.url === `/api/admin/organization/persons/${PERSON_ID}`), 200, {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    person: makePersonDetail({ version: 2 }),
  });
  respond(findLastRequest((r) => r.method === "GET" && r.url === `/api/admin/access/accounts/${ACCOUNT_ID}`), 200, {
    ok: true,
    account: makeAccount({ version: 2 }),
  });
  await stepper2.flush();

  // Retry Step 3 -> returns 409 RECRUITER_LINK_MISMATCH -> displays RecruiterConfirmPicker
  findNode(stepper2, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepper2.flush();
  const linkReq2 = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/person-link`);
  assert.equal(JSON.parse(linkReq2.options.body).expected_person_version, 2);
  assert.equal(JSON.parse(linkReq2.options.body).expected_account_version, 2);
  respond(linkReq2, 409, { ok: false, code: "RECRUITER_LINK_MISMATCH" });
  await stepper2.flush();

  const pickerNode = findNode(stepper2, (n) => n.props?.id === "provision-recruiter-confirm-picker");
  pickerNode.props.onSelect(makePersonnel({ recruiter_id: RECRUITER_ID }));
  await stepper2.flush();
  findNode(stepper2, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepper2.flush();

  const linkReq3 = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/person-link`);
  assert.equal(JSON.parse(linkReq3.options.body).confirmed_recruiter_id, RECRUITER_ID);
  respond(linkReq3, 201, makeLinkPersonEnvelope({ account_version: 3, person_version: 3 }));
  await stepper2.flush();

  // Step 4: role 1 (RECRUITER) -> 201; role 2 (ADMIN) -> 503 uncertain!
  const roleReq1 = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/roles`);
  assert.equal(JSON.parse(roleReq1.options.body).role_code, "RECRUITER");
  respond(roleReq1, 201, makeAssignRoleEnvelope("RECRUITER", 4, "80000000-0000-4000-8000-000000000010"));
  await stepper2.flush();

  const roleReq2 = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/roles`);
  const kRoleAdmin = roleReq2.options.headers["Idempotency-Key"];
  assert.equal(JSON.parse(roleReq2.options.body).role_code, "ADMIN");
  assert.equal(JSON.parse(roleReq2.options.body).expected_version, 4);
  respond(roleReq2, 503, { ok: false, code: "AUTHZ_UNAVAILABLE" });
  await stepper2.flush();

  // Retry Step 4 -> NEVER repeats Step 2, Step 3, or Role 1; replays ONLY ADMIN with EXACT K_role!
  const linkCountBeforeRoleRetry = requests.filter((r) => r.url.includes("/person-link")).length;
  findNode(stepper2, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepper2.flush();
  const roleReq2Retry = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/roles`);
  assert.equal(JSON.parse(roleReq2Retry.options.body).role_code, "ADMIN");
  assert.equal(roleReq2Retry.options.headers["Idempotency-Key"], kRoleAdmin);
  assert.equal(
    requests.filter((r) => r.method === "POST" && r.url === "/api/admin/access/accounts").length,
    accountPostCountAfterStep2,
  );
  assert.equal(
    requests.filter((r) => r.url.includes("/person-link")).length,
    linkCountBeforeRoleRetry,
  );

  respond(roleReq2Retry, 201, makeAssignRoleEnvelope("ADMIN", 5, "80000000-0000-4000-8000-000000000011"));
  await stepper2.flush();
  assert.equal(storage.store.has(ACTOR_A_STORAGE_KEY), false);
  assert.equal(storage.store.has(PROVISION_CHECKPOINT_STORAGE_KEY), false);
});

// ============================================================================
// 3. PersonDetailManager: 4 Blocks, Isolated RESET_PASSWORD, Local 503 Degrade
// ============================================================================

test("PersonDetailManager renders 4 blocks on 1 page, hides NORMAL/SHARED/SERVICE, isolates RESET_PASSWORD with 0 Auth retry, and degrades Block 3/4 503 locally", async () => {
  const storage = makeMemoryStorage();
  const pd = mount(PersonDetailManager, {
    personId: PERSON_ID,
    checkpointActorScope: ACTOR_A_SCOPE,
    canManageGlobalRoles: true,
    storage,
    originOverride: ORIGIN,
  });
  await pd.flush();

  respond(
    findLastRequest((r) => r.url === `/api/admin/organization/persons/${PERSON_ID}`),
    200,
    {
      ok: true,
      authorization_date: AUTH_DATE,
      as_of: AS_OF,
      person: makePersonDetail({
        recruiter_id: RECRUITER_ID,
        active_account_link: {
          link_id: LINK_ID,
          account_ref: ACCOUNT_ID,
          login_id: "an.nv",
          display_name: "Nguyễn Văn An",
          enabled: true,
          account_version: 2,
          started_at: AS_OF,
          source_kind: "ADMIN_MUTATION",
          evidence_date: null,
          version: 1,
        },
      }),
    },
  );
  await pd.flush();

  // Verify all 4 blocks exist on 1 page, zero NORMAL/SHARED/SERVICE in Block 2, zero create recruiter button
  assert.ok(maybeNode(pd, (n) => n.props?.["data-testid"] === "person-block-1-org"));
  const block2 = findNode(pd, (n) => n.props?.["data-testid"] === "person-block-2-login");
  assert.equal(/\b(NORMAL|SHARED|SERVICE)\b/.test(textOf(block2)), false);
  assert.equal(textOf(block2).includes("Phân loại"), false);
  assert.ok(maybeNode(pd, (n) => n.props?.["data-testid"] === "person-block-3-roles"));
  assert.ok(maybeNode(pd, (n) => n.props?.["data-testid"] === "person-block-4-recruitment"));
  assert.equal(maybeButton(pd, "Kích hoạt nghiệp vụ tuyển dụng"), null);

  // Block 4 fetches GET /api/admin/catalog/personnel/[recruiterId] -> simulate 503 local degrade
  const recReq = findLastRequest((r) => r.url === `/api/admin/catalog/personnel/${RECRUITER_ID}`);
  assert.ok(recReq);
  respond(recReq, 503, { ok: false, code: "UNAVAILABLE" });
  await pd.flush();
  // Blocks 1 & 2 stay completely usable while Block 4 shows local retry!
  assert.ok(maybeButton(pd, "Thử tải lại khối Tuyển dụng"));
  assert.ok(maybeButton(pd, "Đặt lại mật khẩu"));
  assert.ok(maybeButton(pd, "Khóa đăng nhập"));

  // Retry Block 4 -> succeeds and shows recruiter summary + deep link ?recruiter=<id>
  findButton(pd, "Thử tải lại khối Tuyển dụng").props.onClick();
  await pd.flush();
  respond(
    findLastRequest((r) => r.url === `/api/admin/catalog/personnel/${RECRUITER_ID}`),
    200,
    { ok: true, personnel: makePersonnel() },
  );
  await pd.flush();
  assert.equal(
    collectNodes(pd.tree).some((n) => n.props?.href === `/admin/catalog/personnel?recruiter=${RECRUITER_ID}`),
    true,
  );

  // Mount Block 3 AccountRolesEmbeddedSection and simulate 503 local degrade
  const block3Child = await syncChildFromTree(pd, AccountRolesEmbeddedSection, null);
  const effReq = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/access`);
  assert.ok(effReq);
  respond(effReq, 503, { ok: false, code: "UNAVAILABLE" });
  await block3Child.flush();
  // Parent PersonDetailManager stays ready (not broken!)
  assert.ok(maybeButton(pd, "Sửa hồ sơ"));

  // Isolated RESET_PASSWORD: 500 ACCOUNT_OPERATION_AUTH_APPLIED_UNRECORDED -> clears RAM password, 0 retry, 0 reconcile, 0 storage writes
  findButton(pd, "Đặt lại mật khẩu").props.onClick();
  await pd.flush();
  findNode(pd, (n) => n.props?.id === "person-reset-password").props.onChange({ target: { value: "NewPass!888" } });
  findNode(pd, (n) => n.props?.id === "person-reset-password-confirm").props.onChange({ target: { value: "NewPass!888" } });
  await pd.flush();

  findNode(pd, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await pd.flush();
  const resetReq = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/reset-password`);
  assert.ok(resetReq);
  respond(resetReq, 500, { ok: false, code: "ACCOUNT_OPERATION_AUTH_APPLIED_UNRECORDED" });
  await pd.flush();

  // Passwords cleared, submit hidden (manualCheckLocked), 0 reconcile calls, 0 storage writes!
  assert.equal(findNode(pd, (n) => n.props?.id === "person-reset-password").props.value, "");
  assert.equal(maybeNode(pd, (n) => n.props?.type === "submit"), null);
  assert.equal(requests.some((r) => r.url.includes("/reconcile")), false);
  assert.equal(storage.store.size, 0);
});

// ============================================================================
// 4. Auxiliary Tools (/admin/access/accounts ?view=special / ?view=unlinked + Effective Link)
// ============================================================================

test("AccountManager ?view=special and ?view=unlinked use PR-0 server filters + pagination, 2-step special create, and 3 legacy flows", async () => {
  // 4a) view=special with 30 server-filtered rows across pages 1 and 2
  const amSpecial = mount(AccountManager, { initialView: "special", embedded: true });
  await amSpecial.flush();
  const listReq1 = findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?"));
  assert.ok(listReq1);
  assert.equal(listReq1.url.includes("account_type=SPECIAL"), true);
  assert.equal(listReq1.url.includes("view="), false);
  respond(listReq1, 200, makeAccountListEnvelope(
    [makeAccount({ account_ref: ACCOUNT_SPECIAL_ID, display_name: "Máy chấm công 1", login_id: "kiosk.1", account_type: "SHARED" })],
    { total: 30, page: 1 },
  ));
  await amSpecial.flush();

  // Link Person is hidden in special view; '+ Tạo tài khoản đặc biệt' is visible
  assert.equal(maybeButton(amSpecial, "Liên kết người"), null);
  assert.ok(maybeButton(amSpecial, "+ Tạo tài khoản đặc biệt"));

  // Next page sends page=2&account_type=SPECIAL (server pagination, NOT page-1 client filter!)
  findButton(amSpecial, "Trang sau").props.onClick();
  await amSpecial.flush();
  const listReq2 = findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?"));
  assert.equal(listReq2.url.includes("page=2"), true);
  assert.equal(listReq2.url.includes("account_type=SPECIAL"), true);

  // 2-step special create: POST /accounts -> POST /accounts/[id]/classification (SERVICE)
  findButton(amSpecial, "+ Tạo tài khoản đặc biệt").props.onClick();
  await amSpecial.flush();
  const specialDlg = await syncChildFromTree(amSpecial, AccountSpecialCreateDialog, null);
  findNode(specialDlg, (n) => n.props?.id === "special-account-type").props.onChange({ target: { value: "SERVICE" } });
  findNode(specialDlg, (n) => n.props?.id === "special-account-login-id").props.onChange({ target: { value: "n8n.sync" } });
  findNode(specialDlg, (n) => n.props?.id === "special-account-display-name").props.onChange({ target: { value: "N8N Sync" } });
  findNode(specialDlg, (n) => n.props?.id === "special-account-password").props.onChange({ target: { value: "SvcPass!123" } });
  findNode(specialDlg, (n) => n.props?.id === "special-account-password-confirm").props.onChange({ target: { value: "SvcPass!123" } });
  findNode(specialDlg, (n) => n.props?.id === "special-account-reason").props.onChange({ target: { value: "Tích hợp báo cáo" } });
  await specialDlg.flush();

  findNode(specialDlg, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await specialDlg.flush();
  const spCreate = findLastRequest((r) => r.method === "POST" && r.url === "/api/admin/access/accounts");
  assert.ok(spCreate);
  respond(spCreate, 200, {
    ok: true,
    account: makeFinalizeCreateAccount({
      app_user_id: ACCOUNT_SPECIAL_ID,
      display_name: "N8N Sync",
    }),
  });
  await specialDlg.flush();
  const spClassify = findLastRequest(
    (r) => r.method === "POST" && r.url === `/api/admin/access/accounts/${ACCOUNT_SPECIAL_ID}/classification`,
  );
  assert.ok(spClassify);
  assert.equal(JSON.parse(spClassify.options.body).account_type, "SERVICE");
  respond(spClassify, 200, {
    ok: true,
    replayed: false,
    account: {
      account_ref: ACCOUNT_SPECIAL_ID,
      account_type: "SERVICE",
      version: 2,
    },
  });
  await specialDlg.flush();
  await amSpecial.flush();
  // Confirm Step 2 settled cleanly (dialog closed & success notification emitted)
  assert.equal(notifications.success.some((n) => n.title.includes("SERVICE")), true);
  amSpecial.unmount();

  // 4b) view=unlinked sends account_type=NORMAL&link_state=unlinked and exposes 3 legacy flows
  const amUnlinked = mount(AccountManager, { initialView: "unlinked", embedded: true });
  await amUnlinked.flush();
  const unlinkedReq = findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?"));
  assert.equal(unlinkedReq.url.includes("account_type=NORMAL"), true);
  assert.equal(unlinkedReq.url.includes("link_state=unlinked"), true);
  assert.equal(unlinkedReq.url.includes("view="), false);
  respond(unlinkedReq, 200, makeAccountListEnvelope([makeAccount({ version: 4 })]));
  await amUnlinked.flush();

  assert.ok(maybeButton(amUnlinked, "Gắn nhân viên có sẵn"));
  assert.ok(maybeButton(amUnlinked, "Tạo hồ sơ nhân viên"));
  assert.ok(maybeButton(amUnlinked, "Đánh dấu Đặc biệt"));

  // Legacy Create Person prefills account_ref & expected_account_version
  findButton(amUnlinked, "Tạo hồ sơ nhân viên").props.onClick();
  await amUnlinked.flush();
  const legacyDlg = await syncChildFromTree(amUnlinked, AccountLegacyCreatePersonDialog, null);
  findNode(legacyDlg, (n) => n.props?.id === "legacy-person-code").props.onChange({ target: { value: "NS-OLD-1" } });
  findNode(legacyDlg, (n) => n.props?.id === "legacy-person-reason").props.onChange({ target: { value: "Đối chiếu dữ liệu cũ" } });
  await legacyDlg.flush();
  findNode(legacyDlg, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await legacyDlg.flush();
  const legacyPost = findLastRequest((r) => r.method === "POST" && r.url === "/api/admin/organization/persons");
  assert.ok(legacyPost);
  const legacyBody = JSON.parse(legacyPost.options.body);
  assert.equal(legacyBody.account_ref, ACCOUNT_ID);
  assert.equal(legacyBody.expected_account_version, 4);
  assert.equal(legacyBody.employee_code, "NS-OLD-1");
});

test("EffectiveAccessWorkspace displays 'Mở hồ sơ nhân viên' link when account is linked to a Person", async () => {
  const eff = mount(EffectiveAccessWorkspace, {
    canManageGlobalRoles: true,
    initialAccountRef: ACCOUNT_ID,
  });
  await eff.flush();
  const detailReq = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/access`);
  assert.ok(detailReq);
  respond(detailReq, 200, makeEffectiveAccessEnvelope());
  await eff.flush();
  const detailPanelNode = findNode(
    eff,
    (n) => typeof n.type === "function" && n.type.name === "EffectiveAccessDetailPanel",
  );
  const detailPanel = mount(detailPanelNode.type, detailPanelNode.props);
  await detailPanel.flush();
  const personLink = collectNodes(detailPanel.tree).find(
    (n) => n.props?.href === `/admin/organization/persons/${PERSON_ID}` && textOf(n).includes("Mở hồ sơ nhân viên"),
  );
  assert.ok(personLink);
});

// ============================================================================
// 5. Personnel Catalog UX Gate (HR_OPERATOR / Catalog-only) & ?recruiter=<uuid>
// ============================================================================

test("PersonnelCatalogManager hides create-from-account & link buttons with 0 link-status calls for HR_OPERATOR/Catalog-only, and loads ?recruiter=<uuid> directly outside page 1", async () => {
  // 5a) HR_OPERATOR / Catalog-only (canManageAccountLinks = false)
  const pcmHr = mount(PersonnelCatalogManager, {
    canManageAccountLinks: false,
    initialRecruiterId: RECRUITER_PAGE2_ID,
  });
  await pcmHr.flush();

  // Direct detail fetch for ?recruiter=<uuid> outside page 1!
  const directRecReq = findLastRequest((r) => r.url === `/api/admin/catalog/personnel/${RECRUITER_PAGE2_ID}`);
  assert.ok(directRecReq);
  const listReq = findLastRequest((r) => r.url.startsWith("/api/admin/catalog/personnel?"));
  assert.ok(listReq);

  // Page 1 returns a DIFFERENT recruiter (does NOT contain RECRUITER_PAGE2_ID)
  respond(listReq, 200, {
    ok: true,
    list: {
      authorization_date: AUTH_DATE,
      search: null,
      include_inactive: false,
      page: 1,
      page_size: 25,
      total: 30,
      personnel: [makePersonnel({ recruiter_id: RECRUITER_ID, display_name: "Trang 1 User" })],
    },
  });
  respond(directRecReq, 200, {
    ok: true,
    personnel: makePersonnel({
      recruiter_id: RECRUITER_PAGE2_ID,
      personnel_code: "trang2.user",
      display_name: "Nhân Sự Trang 2",
      team_names: ["Nhóm Bắc"],
    }),
  });
  await pcmHr.flush();

  // ZERO calls to /api/admin/catalog/personnel/link-status (eliminating 403 noise!)
  assert.equal(
    requests.some((r) => r.url.includes("/api/admin/catalog/personnel/link-status")),
    false,
  );
  // Create-from-account and Link Account buttons are hidden!
  assert.equal(maybeButton(pcmHr, "Tạo nhân sự từ tài khoản"), null);
  assert.equal(maybeButton(pcmHr, "Liên kết tài khoản"), null);

  // Focused card displays item loaded directly from page 2+
  const focusedCard = findNode(pcmHr, (n) => n.props?.["data-testid"] === "focused-personnel-card");
  assert.equal(textOf(focusedCard).includes("Nhân Sự Trang 2"), true);
  assert.equal(textOf(focusedCard).includes("Nhóm Bắc"), true);
});

test("Regression: PersonListManager parent re-render and fresh inline callbacks during Step 1/2 never reset active stepper or reconcile feedback", async () => {
  const storage = makeMemoryStorage();
  const pl = mount(PersonListManager, {
    checkpointActorScope: ACTOR_A_SCOPE,
    canManageGlobalRoles: true,
    storage,
    originOverride: ORIGIN,
  });
  await pl.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
  await pl.flush();

  findButton(pl, "+ Thêm nhân viên").props.onClick();
  await pl.flush();
  const initialStepperNode = findNode(
    pl,
    (n) => typeof n.type === "function" && n.type.name === AccountProvisionAndLinkStepper.name,
  );
  const stepper = await syncChildFromTree(pl, AccountProvisionAndLinkStepper, null);

  findNode(stepper, (n) => n.props?.id === "create-person-employee-code").props.onChange({
    target: { value: "NS-777" },
  });
  findNode(stepper, (n) => n.props?.id === "create-person-full-name").props.onChange({
    target: { value: "Lê Minh Đức" },
  });
  findNode(stepper, (n) => n.props?.id === "create-person-reason").props.onChange({
    target: { value: "Kiểm thử không reset stepper" },
  });
  findNode(stepper, (n) => n.props?.id === "provision-want-login-toggle").props.onChange({
    target: { checked: true },
  });
  await stepper.flush();

  findNode(stepper, (n) => n.props?.id === "provision-login-id").props.onChange({
    target: { value: "duc.lm" },
  });
  findNode(stepper, (n) => n.props?.id === "provision-password").props.onChange({
    target: { value: "StayStable!123" },
  });
  findNode(stepper, (n) => n.props?.id === "provision-password-confirm").props.onChange({
    target: { value: "StayStable!123" },
  });
  await stepper.flush();

  findNode(stepper, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await stepper.flush();

  // Parent re-renders after pre-Step-1 checkpoint write (`onCheckpointChanged` -> `checkpointTick`++):
  // verify PersonListManager keeps stable callbacks AND sync props into active stepper.
  await pl.flush();
  const midStepperNode = findNode(
    pl,
    (n) => typeof n.type === "function" && n.type.name === AccountProvisionAndLinkStepper.name,
  );
  assert.equal(midStepperNode.props.onCompleted, initialStepperNode.props.onCompleted);
  assert.equal(midStepperNode.props.onClose, initialStepperNode.props.onClose);

  // Settle Step 1 -> Step 2 INDETERMINATE
  respond(
    findLastRequest((r) => r.url === "/api/admin/organization/persons" && r.method === "POST"),
    201,
    {
      ok: true,
      replayed: false,
      person: makePersonDetail({ person_id: PERSON_ID, employee_code: "NS-777", full_name: "Lê Minh Đức" }),
    },
  );
  await stepper.flush();
  await pl.flush();

  respond(
    findLastRequest((r) => r.url === "/api/admin/access/accounts" && r.method === "POST"),
    200,
    { ok: true, intent: makeIntentEnvelope("INDETERMINATE") },
  );
  await stepper.flush();
  await pl.flush();

  // Even if a caller passes brand-new inline callback closures on parent re-render,
  // AccountProvisionAndLinkStepper must keep its active Step 2 reconcile state intact.
  stepper.setProps({
    ...midStepperNode.props,
    onCompleted: () => {},
    onClose: () => {},
    onCheckpointChanged: () => {},
    onSessionLost: () => {},
  });
  await stepper.flush();

  const dialogText = textOf(stepper.tree);
  assert.equal(dialogText.includes("Đối chiếu kết quả tạo tài khoản"), true);
  assert.equal(dialogText.includes("NS-777"), true);
  assert.equal(
    maybeNode(stepper, (n) => n.props?.id === "provision-password"),
    null,
    "RAM password input must be removed once Step 2 enters NEEDS_RECONCILE",
  );
});

test("Ponytail regressions (P1 #1-#5 & P2 #12): Step 1 resume hides required password, 409 clears cleanly without no-op, Step 2 BLOCKED & 409 unlock cleanly, Step 3/4 settle out of IN_FLIGHT, and INACTIVE/linked person blocks orphan Auth", async () => {
  const storage = makeMemoryStorage();

  // (a) P1 #1 + #5: Step 1 UNCERTAIN in CREATE_EMPLOYEE_WITH_LOGIN -> resume hides password inputs & warning, locks close,
  //     and after Step 1 commits with empty RAM password -> CTA says 'Tiếp tục bước 2: Mở tài khoản đăng nhập' (not Step 3!)
  const step1UncertainCp = {
    schema_version: 2,
    client_flow_id: "90000000-0000-4000-8000-000000000101",
    env_origin: ORIGIN,
    actor_scope: ACTOR_A_SCOPE,
    flow_kind: "CREATE_EMPLOYEE_WITH_LOGIN",
    updated_at: AS_OF,
    step1_person: {
      status: "UNCERTAIN",
      idempotency_key: "91000000-0000-4000-8000-000000000101",
      payload_snapshot: {
        employee_code: "NS-801",
        full_name: "Đỗ Thị Lan",
        joined_on: null,
        initial_department_ref: null,
        reason: "Tiếp nhận thử P1-1",
      },
      committed_person_id: null,
      committed_person_version: null,
      existing_employee_code: null,
      existing_full_name: null,
      existing_recruiter_id: null,
    },
    step2_account: {
      status: "IDLE",
      idempotency_key: "92000000-0000-4000-8000-000000000101",
      non_secret_snapshot: { login_id: "lan.dt", display_name: "Đỗ Thị Lan", reason: "Tiếp nhận thử P1-1" },
      intent_id: null,
      intent_state: null,
      reconcile_idempotency_key: null,
      committed_account_ref: null,
      committed_account_version: null,
    },
    step3_link: {
      status: "IDLE",
      idempotency_key: "93000000-0000-4000-8000-000000000101",
      payload_snapshot: null,
      post_link_account_version: null,
      post_link_person_version: null,
    },
    step4_roles: [],
  };
  persistAndVerifyCheckpoint(step1UncertainCp, storage);

  const pl1 = mount(PersonListManager, {
    checkpointActorScope: ACTOR_A_SCOPE,
    storage,
    originOverride: ORIGIN,
  });
  await pl1.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
  await pl1.flush();

  findButton(pl1, "Tiếp tục / Đối chiếu").props.onClick();
  await pl1.flush();
  const s1 = await syncChildFromTree(pl1, AccountProvisionAndLinkStepper, null);
  assert.equal(maybeNode(s1, (n) => n.props?.id === "provision-password"), null, "Password input must NOT block Step 1 replay");
  assert.equal(textOf(s1.tree).includes("Chưa có mã đối chiếu (intent_id)"), false);
  assert.equal(findNode(s1, (n) => n.type?.name === "FormDialog").props.closeDisabled, true);

  // (b) P1 #2: Deterministic 409 DUPLICATE_CODE during Step 1 resume keeps Part 1 visible & allows fresh submit!
  findNode(s1, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await s1.flush();
  respond(
    findLastRequest((r) => r.url === "/api/admin/organization/persons" && r.method === "POST"),
    409,
    { ok: false, code: "DUPLICATE_CODE", message: "Mã nhân viên đã tồn tại." },
  );
  await s1.flush();
  const codeFieldAfter409 = findNode(s1, (n) => n.props?.id === "create-person-employee-code");
  codeFieldAfter409.props.onChange({ target: { value: "NS-802" } });
  findNode(s1, (n) => n.props?.id === "provision-password").props.onChange({ target: { value: "FreshPass!123" } });
  findNode(s1, (n) => n.props?.id === "provision-password-confirm").props.onChange({ target: { value: "FreshPass!123" } });
  await s1.flush();
  const postsBeforeFresh = requests.filter((r) => r.url === "/api/admin/organization/persons" && r.method === "POST").length;
  findNode(s1, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await s1.flush();
  assert.equal(
    requests.filter((r) => r.url === "/api/admin/organization/persons" && r.method === "POST").length,
    postsBeforeFresh + 1,
    "Fresh submit after deterministic Step 1 rejection during resume MUST dispatch (not silent no-op)",
  );

  // Settle Step 1 -> Step 2 BLOCKED (P1 #4): must unlock close & allow new login_id!
  respond(
    findLastRequest((r) => r.url === "/api/admin/organization/persons" && r.method === "POST"),
    201,
    { ok: true, replayed: false, person: makePersonDetail({ person_id: PERSON_ID, employee_code: "NS-802", full_name: "Đỗ Thị Lan" }) },
  );
  await s1.flush();
  respond(
    findLastRequest((r) => r.url === "/api/admin/access/accounts" && r.method === "POST"),
    200,
    { ok: true, intent: makeIntentEnvelope("BLOCKED") },
  );
  await s1.flush();
  assert.equal(findNode(s1, (n) => n.type?.name === "FormDialog").props.closeDisabled, false, "BLOCKED intent must unlock close");
  assert.equal(findNode(s1, (n) => n.props?.id === "provision-login-id").props.disabled, false, "BLOCKED intent must allow editing login_id");
  assert.ok(maybeButton(s1, "Đã đối chiếu thủ công · Xóa bản nháp cục bộ"));

  // (c) P1 #5: Step 2 deterministic 409 clears idempotency_key in storage -> reloading keeps login_id editable!
  findNode(s1, (n) => n.props?.id === "provision-login-id").props.onChange({ target: { value: "lan.dup" } });
  findNode(s1, (n) => n.props?.id === "provision-password").props.onChange({ target: { value: "FreshPass!123" } });
  findNode(s1, (n) => n.props?.id === "provision-password-confirm").props.onChange({ target: { value: "FreshPass!123" } });
  await s1.flush();
  findNode(s1, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await s1.flush();
  respond(
    findLastRequest((r) => r.url === "/api/admin/access/accounts" && r.method === "POST"),
    409,
    { ok: false, code: "ACCOUNT_OPERATION_CONFLICT", message: "Tên đăng nhập đã tồn tại." },
  );
  await s1.flush();
  const after409Cp = readVerifiedCheckpoint({ expectedOrigin: ORIGIN, expectedActorScope: ACTOR_A_SCOPE, storage });
  assert.equal(after409Cp.kind, "valid");
  assert.equal(after409Cp.checkpoint.step2_account.status, "IDLE");
  assert.equal(after409Cp.checkpoint.step2_account.idempotency_key, null);
  s1.unmount();
  pl1.unmount();

  // Reload after Step 2 409 -> server returns ACTIVE unlinked person -> login_id MUST stay editable!
  const pl2 = mount(PersonListManager, {
    checkpointActorScope: ACTOR_A_SCOPE,
    storage,
    originOverride: ORIGIN,
  });
  await pl2.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
  await pl2.flush();
  findButton(pl2, "Tiếp tục / Đối chiếu").props.onClick();
  await pl2.flush();
  const s2 = await syncChildFromTree(pl2, AccountProvisionAndLinkStepper, null);
  respond(
    findLastRequest((r) => r.url === `/api/admin/organization/persons/${PERSON_ID}` && r.method === "GET"),
    200,
    { ok: true, authorization_date: AUTH_DATE, as_of: AS_OF, person: makePersonDetail({ person_id: PERSON_ID, status: "ACTIVE" }) },
  );
  await s2.flush();
  assert.equal(findNode(s2, (n) => n.props?.id === "provision-login-id").props.disabled, false);
  assert.equal(textOf(s2.tree).includes("Tạo tài khoản với tên đăng nhập mới"), true);

  // (d) P1 #3: Step 3 RECRUITER_LINK_MISMATCH transitions step3_link.status out of IN_FLIGHT -> IDLE & unlocks close!
  findNode(s2, (n) => n.props?.id === "provision-login-id").props.onChange({ target: { value: "lan.ok" } });
  findNode(s2, (n) => n.props?.id === "provision-password").props.onChange({ target: { value: "FreshPass!123" } });
  findNode(s2, (n) => n.props?.id === "provision-password-confirm").props.onChange({ target: { value: "FreshPass!123" } });
  await s2.flush();
  findNode(s2, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await s2.flush();
  respond(
    findLastRequest((r) => r.url === "/api/admin/access/accounts" && r.method === "POST"),
    200,
    { ok: true, account: makeFinalizeCreateAccount({ app_user_id: ACCOUNT_ID }) },
  );
  await s2.flush();
  respond(
    findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/person-link` && r.method === "POST"),
    409,
    { ok: false, code: "RECRUITER_LINK_MISMATCH", message: "Cần xác nhận hồ sơ tính công." },
  );
  await s2.flush();
  const cpAfterMismatch = readVerifiedCheckpoint({ expectedOrigin: ORIGIN, expectedActorScope: ACTOR_A_SCOPE, storage });
  assert.equal(cpAfterMismatch.kind, "valid");
  assert.equal(cpAfterMismatch.checkpoint.step3_link.status, "IDLE");
  assert.equal(findNode(s2, (n) => n.type?.name === "FormDialog").props.closeDisabled, false);
  s2.unmount();
  pl2.unmount();

  // (e) P2 #12: Resuming Step 2 IDLE when server reports person INACTIVE blocks Step 2 (0 orphan Auth accounts!)
  const storageInactive = makeMemoryStorage();
  persistAndVerifyCheckpoint(
    {
      ...step1UncertainCp,
      step1_person: {
        ...step1UncertainCp.step1_person,
        status: "COMMITTED",
        committed_person_id: PERSON_ID,
        committed_person_version: 2,
      },
    },
    storageInactive,
  );
  const pl3 = mount(PersonListManager, {
    checkpointActorScope: ACTOR_A_SCOPE,
    storage: storageInactive,
    originOverride: ORIGIN,
  });
  await pl3.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
  await pl3.flush();
  findButton(pl3, "Tiếp tục / Đối chiếu").props.onClick();
  await pl3.flush();
  const s3 = await syncChildFromTree(pl3, AccountProvisionAndLinkStepper, null);
  respond(
    findLastRequest((r) => r.url === `/api/admin/organization/persons/${PERSON_ID}` && r.method === "GET"),
    200,
    { ok: true, authorization_date: AUTH_DATE, as_of: AS_OF, person: makePersonDetail({ person_id: PERSON_ID, status: "INACTIVE" }) },
  );
  await s3.flush();
  assert.equal(textOf(s3.tree).includes("tài khoản đăng nhập mồ côi"), true);
  assert.equal(findNode(s3, (n) => n.type?.name === "FormDialog").props.closeDisabled, false);
  s3.unmount();
  pl3.unmount();
});

test("Ponytail regressions (P1 #4, #6, #7, #8 & P2 #10, #11): SpecialDialog locks reason + handles BLOCKED, uncertain reload preserves pendingIntent key, non-paired Block 3 does 0 access fetches", async () => {
  // (a) P1 #6 & #4: AccountSpecialCreateDialog locks reason on 503 uncertain & unlocks on terminal BLOCKED intent
  const am = mount(AccountManager, { initialView: "special", embedded: true });
  await am.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?")), 200, makeAccountListEnvelope([]));
  await am.flush();

  findButton(am, "+ Tạo tài khoản đặc biệt").props.onClick();
  await am.flush();
  const specialDlg = await syncChildFromTree(am, AccountSpecialCreateDialog, null);
  findNode(specialDlg, (n) => n.props?.id === "special-account-login-id").props.onChange({ target: { value: "svc.lock" } });
  findNode(specialDlg, (n) => n.props?.id === "special-account-display-name").props.onChange({ target: { value: "Svc Lock" } });
  findNode(specialDlg, (n) => n.props?.id === "special-account-password").props.onChange({ target: { value: "SvcPass!123" } });
  findNode(specialDlg, (n) => n.props?.id === "special-account-password-confirm").props.onChange({ target: { value: "SvcPass!123" } });
  findNode(specialDlg, (n) => n.props?.id === "special-account-reason").props.onChange({ target: { value: "Tích hợp khóa lý do" } });
  await specialDlg.flush();

  findNode(specialDlg, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await specialDlg.flush();
  const firstPost = findLastRequest((r) => r.method === "POST" && r.url === "/api/admin/access/accounts");
  const key1 = firstPost.options.headers["Idempotency-Key"];
  respond(firstPost, 503, { ok: false, code: "ACCOUNT_OPERATION_UNAVAILABLE" });
  await specialDlg.flush();
  assert.equal(
    findNode(specialDlg, (n) => n.props?.id === "special-account-reason").props.disabled,
    true,
    "Reason textarea MUST be locked during Step 1 uncertain to prevent payload mismatch key wipe",
  );

  // Retry sends exact same K1 -> server returns BLOCKED intent -> must unlock close (zero deadlock!)
  findNode(specialDlg, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await specialDlg.flush();
  const secondPost = findLastRequest((r) => r.method === "POST" && r.url === "/api/admin/access/accounts");
  assert.equal(secondPost.options.headers["Idempotency-Key"], key1);
  respond(secondPost, 200, { ok: true, intent: makeIntentEnvelope("BLOCKED") });
  await specialDlg.flush();
  assert.equal(findNode(specialDlg, (n) => n.type?.name === "FormDialog").props.closeDisabled, false);
  specialDlg.unmount();
  am.unmount();

  // (b) P1 #7: PersonDetailManager uncertain toggle-login reload preserves frozen Idempotency-Key & expected_version
  const pd = mount(PersonDetailManager, {
    personId: PERSON_ID,
    checkpointActorScope: ACTOR_A_SCOPE,
    canManageGlobalRoles: false, // P1 #8: unpaired actor must NOT fetch /roles or /access!
    storage: makeMemoryStorage(),
    originOverride: ORIGIN,
  });
  await pd.flush();
  respond(
    findLastRequest((r) => r.url === `/api/admin/organization/persons/${PERSON_ID}` && r.method === "GET"),
    200,
    {
      ok: true,
      authorization_date: AUTH_DATE,
      as_of: AS_OF,
      person: makePersonDetail({
        active_account_link: {
          link_id: LINK_ID,
          account_ref: ACCOUNT_ID,
          login_id: "an.nv",
          display_name: "Nguyễn Văn An",
          enabled: true,
          account_version: 5,
          started_at: AS_OF,
          source_kind: "ADMIN_MUTATION",
          evidence_date: null,
          version: 1,
        },
      }),
    },
  );
  await pd.flush();
  // P1 #8 check: 0 calls to /roles or /access when canManageGlobalRoles === false!
  assert.equal(requests.some((r) => r.url.includes("/api/admin/access/roles") || r.url.endsWith("/access")), false);
  assert.equal(textOf(pd.tree).includes("paired Full Admin"), true);

  // Trigger toggle-login -> 503 uncertain -> 'Tải lại để đối chiếu' -> MUST preserve pendingIntent & retry with exact key + expected_version=5!
  findButton(pd, "Khóa đăng nhập").props.onClick();
  await pd.flush();
  findNode(pd, (n) => n.props?.id === "person-detail-reason").props.onChange({ target: { value: "Khóa thử đối chiếu" } });
  await pd.flush();
  findNode(pd, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await pd.flush();
  const disable1 = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/disable`);
  const disableKey = disable1.options.headers["Idempotency-Key"];
  const disableBody = disable1.options.body;
  respond(disable1, 503, { ok: false, code: "ACCOUNT_OPERATION_UNAVAILABLE" });
  await pd.flush();

  findButton(pd, "Tải lại để đối chiếu").props.onClick();
  await pd.flush();
  respond(
    findLastRequest((r) => r.url === `/api/admin/organization/persons/${PERSON_ID}` && r.method === "GET"),
    200,
    { ok: true, authorization_date: AUTH_DATE, as_of: AS_OF, person: makePersonDetail({ version: 2 }) },
  );
  await pd.flush();
  // Dialog MUST remain open with 'Thử lại đúng yêu cầu' preserving exact key & body!
  findButton(pd, "Thử lại đúng yêu cầu").props.onClick();
  await pd.flush();
  const disable2 = findLastRequest((r) => r.url === `/api/admin/access/accounts/${ACCOUNT_ID}/disable`);
  assert.equal(disable2.options.headers["Idempotency-Key"], disableKey);
  assert.equal(disable2.options.body, disableBody);
  pd.unmount();

  // (c) P1 #8 & P2 #11 static server page checks
  const personsPage = readFileSync(path.join(repoRoot, "src/app/admin/organization/persons/page.tsx"), "utf8");
  const personDetailPage = readFileSync(path.join(repoRoot, "src/app/admin/organization/persons/[personId]/page.tsx"), "utf8");
  const accountsPage = readFileSync(path.join(repoRoot, "src/app/admin/access/accounts/page.tsx"), "utf8");
  const personnelPage = readFileSync(path.join(repoRoot, "src/app/admin/catalog/personnel/page.tsx"), "utf8");
  assert.match(personsPage, /hasPairedFullAdminAuthority/);
  assert.match(personDetailPage, /hasPairedFullAdminAuthority/);
  assert.match(accountsPage, /key=\{`\$\{initialTab\}:\$\{initialView\}:\$\{initialAccountRef \?\? ""\}`\}/);
  assert.match(personnelPage, /key=\{initialRecruiterId \?\? "all"\}/);
});

test("PR27-R1/P1 regression: unresolved checkpoint of Admin A is NEVER overwritten or cleared by fresh flow from Admin A (List/Detail/Stepper) OR Admin B (scoped & legacy keys), and A still resumes exact K_person/snapshot", async () => {
  const originalFlowId = "90000000-0000-4000-8000-000000000777";
  const originalKPerson = "91000000-0000-4000-8000-000000000777";
  const makeUnresolvedFlowA = () => ({
    schema_version: 2,
    client_flow_id: originalFlowId,
    env_origin: ORIGIN,
    actor_scope: ACTOR_A_SCOPE,
    flow_kind: "CREATE_EMPLOYEE_WITH_LOGIN",
    updated_at: AS_OF,
    step1_person: {
      status: "UNCERTAIN",
      idempotency_key: originalKPerson,
      payload_snapshot: {
        employee_code: "NS-ORIG-A",
        full_name: "Nguyễn Nguyên Bản A",
        joined_on: "2026-01-10",
        initial_department_ref: null,
        reason: "Tiếp nhận gốc Admin A",
      },
      committed_person_id: null,
      committed_person_version: null,
      existing_employee_code: null,
      existing_full_name: null,
      existing_recruiter_id: null,
    },
    step2_account: {
      status: "IDLE",
      idempotency_key: "92000000-0000-4000-8000-000000000777",
      non_secret_snapshot: { login_id: "orig.a", display_name: "Nguyễn Nguyên Bản A", reason: "Tiếp nhận gốc Admin A" },
      intent_id: null,
      intent_state: null,
      reconcile_idempotency_key: null,
      committed_account_ref: null,
      committed_account_version: null,
    },
    step3_link: {
      status: "IDLE",
      idempotency_key: "93000000-0000-4000-8000-000000000777",
      payload_snapshot: null,
      post_link_account_version: null,
      post_link_person_version: null,
    },
    step4_roles: [],
  });

  // Test BOTH storage layouts: (1) new actor-scoped key AND (2) legacy shared PROVISION_CHECKPOINT_STORAGE_KEY
  for (const seedMode of ["scoped", "legacy"]) {
    const storage = makeMemoryStorage();
    const originalA = makeUnresolvedFlowA();
    const expectedKey = seedMode === "scoped" ? ACTOR_A_STORAGE_KEY : PROVISION_CHECKPOINT_STORAGE_KEY;
    if (seedMode === "scoped") {
      assert.equal(persistAndVerifyCheckpoint(originalA, storage).ok, true);
    } else {
      storage.setItem(PROVISION_CHECKPOINT_STORAGE_KEY, JSON.stringify(originalA));
    }
    const originalBytes = storage.store.get(expectedKey);
    assert.ok(originalBytes);

    // 1) SAME ACTOR A on PersonListManager: '+ Thêm nhân viên' and row 'Mở đăng nhập' MUST be disabled & blocked!
    const plA = mount(PersonListManager, {
      checkpointActorScope: ACTOR_A_SCOPE,
      canManageGlobalRoles: true,
      storage,
      originOverride: ORIGIN,
    });
    await plA.flush();
    respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
    respond(
      findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")),
      200,
      makePersonListEnvelope([makePersonSummary({ active_account_link: null })]),
    );
    await plA.flush();

    const addBtnA = findButton(plA, "+ Thêm nhân viên");
    const quickOpenBtnA = findButton(plA, "Mở đăng nhập");
    assert.equal(addBtnA.props.disabled, true, `[${seedMode}] + Thêm nhân viên must be disabled while checkpoint active`);
    assert.equal(quickOpenBtnA.props.disabled, true, `[${seedMode}] Mở đăng nhập must be disabled while checkpoint active`);
    addBtnA.props.onClick();
    quickOpenBtnA.props.onClick();
    await plA.flush();
    assert.equal(storage.store.get(expectedKey), originalBytes);
    plA.unmount();

    // 2) SAME ACTOR A on PersonDetailManager: Block 2 'Mở tài khoản đăng nhập' MUST be disabled & blocked!
    const pdA = mount(PersonDetailManager, {
      personId: PERSON_ID,
      checkpointActorScope: ACTOR_A_SCOPE,
      canManageGlobalRoles: true,
      storage,
      originOverride: ORIGIN,
    });
    await pdA.flush();
    respond(
      findLastRequest((r) => r.url === `/api/admin/organization/persons/${PERSON_ID}` && r.method === "GET"),
      200,
      { ok: true, authorization_date: AUTH_DATE, as_of: AS_OF, person: makePersonDetail({ active_account_link: null }) },
    );
    await pdA.flush();
    const detailOpenBtn = findButton(pdA, "Mở tài khoản đăng nhập");
    assert.equal(detailOpenBtn.props.disabled, true, `[${seedMode}] Detail Mở tài khoản đăng nhập must be disabled`);
    detailOpenBtn.props.onClick();
    await pdA.flush();
    assert.equal(storage.store.get(expectedKey), originalBytes);
    pdA.unmount();

    // 3) SAME ACTOR A direct stepper bypass in fresh create-person mode: persist MUST fail closed with 0 POST!
    const postsBeforeBypass = requests.filter((r) => r.method === "POST").length;
    const directStepper = mount(AccountProvisionAndLinkStepper, {
      open: true,
      mode: { kind: "create-person" },
      checkpointActorScope: ACTOR_A_SCOPE,
      workspaceGuard: {
        getEpoch: () => 1,
        isActive: () => true,
        trackController: () => ({ epoch: 1, controller: new AbortController(), release: () => {} }),
        invalidateSession: () => {},
      },
      canManageGlobalRoles: true,
      storage,
      originOverride: ORIGIN,
      onClose: () => {},
      onCompleted: () => {},
      onSessionLost: () => {},
    });
    await directStepper.flush();
    findNode(directStepper, (n) => n.props?.id === "create-person-employee-code").props.onChange({ target: { value: "NS-BYPASS" } });
    findNode(directStepper, (n) => n.props?.id === "create-person-full-name").props.onChange({ target: { value: "Bypass Người" } });
    findNode(directStepper, (n) => n.props?.id === "create-person-reason").props.onChange({ target: { value: "Thử ghi đè cùng actor" } });
    await directStepper.flush();
    findNode(directStepper, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
    await directStepper.flush();
    assert.equal(
      requests.filter((r) => r.method === "POST").length,
      postsBeforeBypass,
      `[${seedMode}] Direct fresh stepper bypass for same actor must dispatch 0 POST`,
    );
    assert.equal(storage.store.get(expectedKey), originalBytes);
    assert.equal(textOf(directStepper.tree).includes("Tiếp tục / Đối chiếu"), true);
    directStepper.unmount();

    // 4) Stale/mismatched client_flow_id clear MUST NOT delete Admin A's checkpoint!
    clearVerifiedCheckpoint({
      expectedOrigin: ORIGIN,
      expectedActorScope: ACTOR_A_SCOPE,
      expectedClientFlowId: "90000000-0000-4000-8000-000000000999",
      storage,
    });
    assert.equal(storage.store.get(expectedKey), originalBytes);

    // 5) OTHER ACTOR B on the SAME tab: B sees NO banner for A, creates & finishes a brand new employee,
    //    and Admin A's checkpoint stays 100% byte-for-byte intact BOTH during B's POST and after B completes!
    const plB = mount(PersonListManager, {
      checkpointActorScope: ACTOR_B_SCOPE,
      canManageGlobalRoles: true,
      storage,
      originOverride: ORIGIN,
    });
    await plB.flush();
    respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
    respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
    await plB.flush();
    assert.equal(maybeButton(plB, "Tiếp tục / Đối chiếu"), null);
    const addBtnB = findButton(plB, "+ Thêm nhân viên");
    assert.equal(Boolean(addBtnB.props.disabled), false);
    addBtnB.props.onClick();
    await plB.flush();
    const stepperB = await syncChildFromTree(plB, AccountProvisionAndLinkStepper, null);
    findNode(stepperB, (n) => n.props?.id === "create-person-employee-code").props.onChange({ target: { value: "NS-B-202" } });
    findNode(stepperB, (n) => n.props?.id === "create-person-full-name").props.onChange({ target: { value: "Nhân Viên Của B" } });
    findNode(stepperB, (n) => n.props?.id === "create-person-reason").props.onChange({ target: { value: "Admin B tạo mới độc lập" } });
    await stepperB.flush();
    findNode(stepperB, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
    await stepperB.flush();

    // During Admin B's in-flight POST: B wrote ONLY to ACTOR_B_STORAGE_KEY; A's key is 100% untouched!
    assert.equal(storage.store.has(ACTOR_B_STORAGE_KEY), true);
    assert.equal(storage.store.get(expectedKey), originalBytes);

    const postB = findLastRequest((r) => r.method === "POST" && r.url === "/api/admin/organization/persons");
    assert.ok(postB);
    respond(postB, 201, {
      ok: true,
      replayed: false,
      person: makePersonDetail({ person_id: "40000000-0000-4000-8000-000000000202", employee_code: "NS-B-202", full_name: "Nhân Viên Của B" }),
    });
    await stepperB.flush();
    await plB.flush();

    // After Admin B finishes: B's scoped key is cleared, A's checkpoint is STILL 100% byte-for-byte intact!
    assert.equal(storage.store.has(ACTOR_B_STORAGE_KEY), false);
    assert.equal(storage.store.get(expectedKey), originalBytes);
    stepperB.unmount();
    plB.unmount();

    // 6) Admin A returns on the same storage -> recovers EXACT originalFlowId, originalKPerson, and snapshot!
    const plA2 = mount(PersonListManager, {
      checkpointActorScope: ACTOR_A_SCOPE,
      canManageGlobalRoles: true,
      storage,
      originOverride: ORIGIN,
    });
    await plA2.flush();
    respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
    respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
    await plA2.flush();
    // EmptyState '+ Thêm nhân viên' button MUST ALSO be disabled while blocking checkpoint exists!
    const allAddButtonsEmpty = collectNodes(plA2.tree).filter(
      (n) => typeof n.props?.onClick === "function" && textOf(n).trim() === "+ Thêm nhân viên",
    );
    assert.equal(allAddButtonsEmpty.length, 2, "Expected both header and EmptyState + Thêm nhân viên buttons");
    for (const btn of allAddButtonsEmpty) {
      assert.equal(btn.props.disabled, true, `[${seedMode}] Every + Thêm nhân viên button (incl. EmptyState) must be disabled`);
    }

    findButton(plA2, "Tiếp tục / Đối chiếu").props.onClick();
    await plA2.flush();
    const stepperA2 = await syncChildFromTree(plA2, AccountProvisionAndLinkStepper, null);
    findNode(stepperA2, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
    await stepperA2.flush();
    const replayA = findLastRequest((r) => r.method === "POST" && r.url === "/api/admin/organization/persons");
    assert.equal(replayA.options.headers["Idempotency-Key"], originalKPerson);
    assert.equal(JSON.parse(replayA.options.body).employee_code, "NS-ORIG-A");
    stepperA2.unmount();
    plA2.unmount();
  }

  // 7) Residual-hardening checks:
  //    (a) Explicit expectedClientFlowId: null or non-UUID MUST fail closed (never wildcard-delete valid checkpoints!)
  //    (b) Corrupt scopedKey(A) + valid legacyKey(A): corrupt cleanup removes ONLY corrupt scopedKey & reveals valid legacy checkpoint!
  //    (c) Corrupt legacyKey when scopedKey(A) is empty: persistAndVerifyCheckpoint fails closed with ACTIVE_CHECKPOINT_CONFLICT!
  const mixedStorage = makeMemoryStorage();
  const validLegacyA = makeUnresolvedFlowA();
  const validLegacyBytes = JSON.stringify(validLegacyA);
  mixedStorage.setItem(PROVISION_CHECKPOINT_STORAGE_KEY, validLegacyBytes);
  mixedStorage.setItem(ACTOR_A_STORAGE_KEY, "{corrupt-scoped-json");

  clearVerifiedCheckpoint({ expectedOrigin: ORIGIN, expectedActorScope: ACTOR_A_SCOPE, expectedClientFlowId: null, storage: mixedStorage });
  clearVerifiedCheckpoint({ expectedOrigin: ORIGIN, expectedActorScope: ACTOR_A_SCOPE, expectedClientFlowId: "not-a-uuid", storage: mixedStorage });
  assert.equal(mixedStorage.store.get(PROVISION_CHECKPOINT_STORAGE_KEY), validLegacyBytes);

  const plCorrupt = mount(PersonListManager, {
    checkpointActorScope: ACTOR_A_SCOPE,
    canManageGlobalRoles: true,
    storage: mixedStorage,
    originOverride: ORIGIN,
  });
  await plCorrupt.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
  await plCorrupt.flush();
  findButton(plCorrupt, "Đã đối chiếu thủ công · Xóa bản nháp lỗi").props.onClick();
  await plCorrupt.flush();
  // Corrupt scoped entry removed; unseen valid legacy checkpoint preserved & now surfaced for resume!
  assert.equal(mixedStorage.store.has(ACTOR_A_STORAGE_KEY), false);
  assert.equal(mixedStorage.store.get(PROVISION_CHECKPOINT_STORAGE_KEY), validLegacyBytes);
  assert.ok(maybeButton(plCorrupt, "Tiếp tục / Đối chiếu"));
  plCorrupt.unmount();

  const corruptLegacyStorage = makeMemoryStorage();
  corruptLegacyStorage.setItem(PROVISION_CHECKPOINT_STORAGE_KEY, "{corrupt-legacy");
  const blockedOnCorruptLegacy = persistAndVerifyCheckpoint(makeUnresolvedFlowA(), corruptLegacyStorage);
  assert.equal(blockedOnCorruptLegacy.ok, false);
  assert.equal(blockedOnCorruptLegacy.reason, "ACTIVE_CHECKPOINT_CONFLICT");
});

test("PR27-R2/P2 regression: committed Step 4 role version survives storage quota + reload (and legacy checkpoints + 409 reload), while dispatched UNCERTAIN roles keep exact frozen version/key", async () => {
  const makeTwoRolesCheckpoint = () => ({
    schema_version: 2,
    client_flow_id: "90000000-0000-4000-8000-000000000888",
    env_origin: ORIGIN,
    actor_scope: ACTOR_A_SCOPE,
    flow_kind: "CREATE_EMPLOYEE_WITH_LOGIN",
    updated_at: AS_OF,
    step1_person: {
      status: "COMMITTED",
      idempotency_key: "91000000-0000-4000-8000-000000000888",
      payload_snapshot: {
        employee_code: "NS-101",
        full_name: "Nguyễn Văn An",
        joined_on: "2026-01-10",
        initial_department_ref: null,
        reason: "Tiếp nhận mới",
      },
      committed_person_id: PERSON_ID,
      committed_person_version: 1,
      existing_employee_code: "NS-101",
      existing_full_name: "Nguyễn Văn An",
      existing_recruiter_id: null,
    },
    step2_account: {
      status: "COMMITTED",
      idempotency_key: "92000000-0000-4000-8000-000000000888",
      non_secret_snapshot: { login_id: "an.nv", display_name: "Nguyễn Văn An", reason: "Tiếp nhận mới" },
      intent_id: INTENT_ID,
      intent_state: "APPLIED",
      reconcile_idempotency_key: null,
      committed_account_ref: ACCOUNT_ID,
      committed_account_version: 1,
    },
    step3_link: {
      status: "COMMITTED",
      idempotency_key: "93000000-0000-4000-8000-000000000888",
      payload_snapshot: {
        person_id: PERSON_ID,
        account_ref: ACCOUNT_ID,
        expected_account_version: 1,
        expected_person_version: 1,
        confirmed_recruiter_id: null,
        reason: "Tiếp nhận mới",
      },
      post_link_account_version: 2,
      post_link_person_version: 2,
    },
    step4_roles: [
      {
        role_code: "RECRUITER",
        status: "IDLE",
        idempotency_key: "94000000-0000-4000-8000-000000000881",
        payload_snapshot: null,
      },
      {
        role_code: "ADMIN",
        status: "IDLE",
        idempotency_key: "94000000-0000-4000-8000-000000000882",
        payload_snapshot: null,
      },
    ],
  });

  const resumeWithServerAccountVersion = async (storage, accountVersion) => {
    const pl = mount(PersonListManager, {
      checkpointActorScope: ACTOR_A_SCOPE,
      canManageGlobalRoles: true,
      storage,
      originOverride: ORIGIN,
    });
    await pl.flush();
    respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
    respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
    await pl.flush();
    findButton(pl, "Tiếp tục / Đối chiếu").props.onClick();
    await pl.flush();
    const stepper = await syncChildFromTree(pl, AccountProvisionAndLinkStepper, null);
    const verify = findLastRequest((r) => r.method === "GET" && r.url === `/api/admin/organization/persons/${PERSON_ID}`);
    assert.ok(verify);
    respond(verify, 200, {
      ok: true,
      authorization_date: AUTH_DATE,
      as_of: AS_OF,
      person: makePersonDetail({
        version: 2,
        active_account_link: {
          link_id: LINK_ID,
          account_ref: ACCOUNT_ID,
          login_id: "an.nv",
          display_name: "Nguyễn Văn An",
          enabled: true,
          account_version: accountVersion,
          started_at: AS_OF,
          source_kind: "ADMIN_MUTATION",
          evidence_date: null,
          version: 1,
        },
      }),
    });
    await stepper.flush();
    return { pl, stepper };
  };

  // (a) Exact T0 quota scenario: Role 1 commits v3 -> persist Role 1 COMMITTED succeeds ->
  //     QuotaExceededError right when persisting Role 2 IN_FLIGHT -> reload -> Role 2 sends expected_version = 3!
  let failSecondRoleSnapshot = false;
  const storage = makeMemoryStorage({
    setItem(key, value, store) {
      const candidate = JSON.parse(value);
      if (
        failSecondRoleSnapshot &&
        candidate.step4_roles[0]?.status === "COMMITTED" &&
        candidate.step4_roles[1]?.status === "IN_FLIGHT"
      ) {
        throw new DOMException("quota for second role snapshot", "QuotaExceededError");
      }
      store.set(key, String(value));
    },
  });
  assert.equal(persistAndVerifyCheckpoint(makeTwoRolesCheckpoint(), storage).ok, true);

  const run1 = await resumeWithServerAccountVersion(storage, 2);
  findNode(run1.stepper, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await run1.stepper.flush();

  const role1Req = findLastRequest((r) => r.method === "POST" && r.url.endsWith("/roles"));
  assert.equal(JSON.parse(role1Req.options.body).role_code, "RECRUITER");
  assert.equal(JSON.parse(role1Req.options.body).expected_version, 2);

  failSecondRoleSnapshot = true;
  respond(role1Req, 201, makeAssignRoleEnvelope("RECRUITER", 3));
  await run1.stepper.flush();

  // Role 1 persisted as COMMITTED WITH committed_account_version = 3; Role 2 blocked before POST!
  const storedMid = readVerifiedCheckpoint({ expectedOrigin: ORIGIN, expectedActorScope: ACTOR_A_SCOPE, storage });
  assert.equal(storedMid.kind, "valid");
  assert.equal(storedMid.checkpoint.step4_roles[0].status, "COMMITTED");
  assert.equal(storedMid.checkpoint.step4_roles[0].committed_account_version, 3);
  assert.equal(storedMid.checkpoint.step4_roles[1].status, "IDLE");
  assert.equal(storedMid.checkpoint.step4_roles[1].payload_snapshot, null);
  assert.equal(requests.filter((r) => r.method === "POST" && r.url.endsWith("/roles")).length, 1);

  run1.stepper.unmount();
  run1.pl.unmount();
  failSecondRoleSnapshot = false;

  // Reload & resume -> 0 repeat of Person/Account/Link/RECRUITER; ADMIN MUST send expected_version = 3!
  const run2 = await resumeWithServerAccountVersion(storage, 3);
  findNode(run2.stepper, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await run2.stepper.flush();

  const role2Req = findLastRequest((r) => r.method === "POST" && r.url.endsWith("/roles"));
  const role2Body = JSON.parse(role2Req.options.body);
  assert.equal(role2Body.role_code, "ADMIN");
  assert.equal(role2Body.expected_version, 3);
  assert.equal(
    requests.filter((r) => r.method === "POST" && r.url.endsWith("/roles") && JSON.parse(r.options.body).role_code === "RECRUITER").length,
    1,
    "RECRUITER must only be posted once",
  );
  assert.equal(requests.some((r) => r.method === "POST" && (r.url === "/api/admin/organization/persons" || r.url === "/api/admin/access/accounts" || r.url.includes("/person-link"))), false);

  // (b) Step 4 409 VERSION_CONFLICT -> explicit reload fetches authoritative v4 & rotates IDLE key cleanly
  const rejectedRole2Key = role2Req.options.headers["Idempotency-Key"];
  respond(role2Req, 409, {
    ok: false,
    error: {
      code: "VERSION_CONFLICT",
      message: "Phiên bản tài khoản vừa thay đổi.",
      current_version: 4,
    },
  });
  await run2.stepper.flush();
  findButton(run2.stepper, "Tải lại phiên bản tài khoản mới nhất").props.onClick();
  await run2.stepper.flush();
  const reloadAccountReq = findLastRequest((r) => r.method === "GET" && r.url === `/api/admin/access/accounts/${ACCOUNT_ID}`);
  assert.ok(reloadAccountReq);
  respond(reloadAccountReq, 200, { ok: true, account: makeAccount({ version: 4 }) });
  await run2.stepper.flush();

  // Even if the browser reloads AGAIN after 409 reload before clicking Submit, rotated key + v4 MUST survive!
  run2.stepper.unmount();
  run2.pl.unmount();
  const run2Reloaded = await resumeWithServerAccountVersion(storage, 4);
  findNode(run2Reloaded.stepper, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await run2Reloaded.stepper.flush();
  const role2AfterReload = findLastRequest((r) => r.method === "POST" && r.url.endsWith("/roles"));
  assert.equal(JSON.parse(role2AfterReload.options.body).role_code, "ADMIN");
  assert.equal(JSON.parse(role2AfterReload.options.body).expected_version, 4);
  assert.notEqual(role2AfterReload.options.headers["Idempotency-Key"], rejectedRole2Key);
  respond(role2AfterReload, 201, makeAssignRoleEnvelope("ADMIN", 5));
  await run2Reloaded.stepper.flush();
  assert.equal(storage.store.has(ACTOR_A_STORAGE_KEY), false);
  run2Reloaded.stepper.unmount();
  run2Reloaded.pl.unmount();

  // (b2) Same-session retry WITHOUT reload after Role 1 commits v3 and quota fails on Role 2 IN_FLIGHT -> sends v3!
  let failOnceQuota = false;
  const sameSessionStorage = makeMemoryStorage({
    setItem(key, value, store) {
      const candidate = JSON.parse(value);
      if (
        failOnceQuota &&
        candidate.step4_roles[0]?.status === "COMMITTED" &&
        candidate.step4_roles[1]?.status === "IN_FLIGHT"
      ) {
        throw new DOMException("transient quota", "QuotaExceededError");
      }
      store.set(key, String(value));
    },
  });
  assert.equal(persistAndVerifyCheckpoint(makeTwoRolesCheckpoint(), sameSessionStorage).ok, true);
  const runSameSession = await resumeWithServerAccountVersion(sameSessionStorage, 2);
  findNode(runSameSession.stepper, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await runSameSession.stepper.flush();
  failOnceQuota = true;
  respond(findLastRequest((r) => r.method === "POST" && r.url.endsWith("/roles")), 201, makeAssignRoleEnvelope("RECRUITER", 3));
  await runSameSession.stepper.flush();
  // Free space and click Submit in the SAME session without reloading!
  failOnceQuota = false;
  findNode(runSameSession.stepper, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await runSameSession.stepper.flush();
  const sameSessionRole2 = findLastRequest((r) => r.method === "POST" && r.url.endsWith("/roles"));
  assert.equal(JSON.parse(sameSessionRole2.options.body).role_code, "ADMIN");
  assert.equal(JSON.parse(sameSessionRole2.options.body).expected_version, 3);
  respond(sameSessionRole2, 201, makeAssignRoleEnvelope("ADMIN", 4));
  await runSameSession.stepper.flush();
  assert.equal(sameSessionStorage.store.has(ACTOR_A_STORAGE_KEY), false);
  runSameSession.stepper.unmount();
  runSameSession.pl.unmount();

  // (c) Pure helper & legacy 4-key checkpoint compatibility: NEVER reuses obsolete post_link_account_version or guesses +1!
  const legacyCp = makeTwoRolesCheckpoint();
  legacyCp.step4_roles[0].status = "COMMITTED"; // legacy 4-key object without committed_account_version!
  const parsedLegacy = parseProvisionCheckpointV2(legacyCp);
  assert.ok(parsedLegacy);
  assert.equal(parsedLegacy.step4_roles[0].committed_account_version, null);
  assert.equal(resolveNextStep4AccountVersion(parsedLegacy, null), null, "Must NOT fall back to obsolete link version or guess +1");
  assert.equal(resolveNextStep4AccountVersion(parsedLegacy, 3), 3, "Must adopt verified server version 3");

  // (d) Already-dispatched Role 2 UNCERTAIN (503) MUST keep exact frozen expected_version & idempotency_key even if server moved ahead!
  const uncertainStorage = makeMemoryStorage();
  const uncertainCp = makeTwoRolesCheckpoint();
  uncertainCp.step4_roles[0] = {
    ...uncertainCp.step4_roles[0],
    status: "COMMITTED",
    committed_account_version: 3,
  };
  const frozenRole2Key = "94000000-0000-4000-8000-000000000882";
  uncertainCp.step4_roles[1] = {
    role_code: "ADMIN",
    status: "UNCERTAIN",
    idempotency_key: frozenRole2Key,
    payload_snapshot: { role_code: "ADMIN", expected_version: 3, reason: "Tiếp nhận mới" },
    committed_account_version: null,
  };
  assert.equal(persistAndVerifyCheckpoint(uncertainCp, uncertainStorage).ok, true);
  const runUncertain = await resumeWithServerAccountVersion(uncertainStorage, 5);
  findNode(runUncertain.stepper, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await runUncertain.stepper.flush();
  const uncertainReplay = findLastRequest((r) => r.method === "POST" && r.url.endsWith("/roles"));
  assert.equal(uncertainReplay.options.headers["Idempotency-Key"], frozenRole2Key);
  assert.equal(JSON.parse(uncertainReplay.options.body).expected_version, 3, "Dispatched UNCERTAIN role MUST replay exact frozen expected_version without masking OCC");
  runUncertain.stepper.unmount();
  runUncertain.pl.unmount();
});

// ============================================================================
// 6. Web-only PR-2 Static Scope & Hygiene Guard
// ============================================================================

test("WP13 PR-2 web-only files have zero simulator hacks, zero server-only leaks into client bundles, and preserve /admin/access/accounts & /admin/catalog/teams", () => {
  const clientFiles = [
    "src/lib/admin/provision-checkpoint-v2.ts",
    "src/components/admin/account-provision-and-link-stepper.tsx",
    "src/components/admin/account-roles-embedded-section.tsx",
    "src/components/admin/account-auxiliary-dialogs.tsx",
    "src/components/admin/person-list-manager.tsx",
    "src/components/admin/person-detail-manager.tsx",
    "src/components/admin/account-access-workspace.tsx",
    "src/components/admin/account-manager.tsx",
    "src/components/admin/personnel-catalog-manager.tsx",
  ];
  for (const rel of clientFiles) {
    const src = readFileSync(path.join(repoRoot, rel), "utf8");
    assert.doesNotMatch(src, /MOCK_SERVER_KEY/, `${rel} must not contain mock simulator keys`);
    assert.doesNotMatch(src, /from\s+["'](?:node:|server-only)/, `${rel} must remain browser-safe`);
  }

  // Server helper stays server-only and computes opaque SHA-256 scope
  const serverScopeSrc = readFileSync(
    path.join(repoRoot, "src/lib/admin/checkpoint-actor-scope.ts"),
    "utf8",
  );
  assert.match(serverScopeSrc, /import "server-only"/);
  assert.match(serverScopeSrc, /createHash\("sha256"\)/);

  // /admin/access/accounts page NEVER redirects to /admin/organization/persons
  const accountsPageSrc = readFileSync(
    path.join(repoRoot, "src/app/admin/access/accounts/page.tsx"),
    "utf8",
  );
  assert.doesNotMatch(accountsPageSrc, /redirect\(["']\/admin\/organization\/persons/);
  assert.match(accountsPageSrc, /parseAccountManagementView/);

  // /admin/catalog/personnel page computes canManageAccountLinks & initialRecruiterId server-side
  const personnelPageSrc = readFileSync(
    path.join(repoRoot, "src/app/admin/catalog/personnel/page.tsx"),
    "utf8",
  );
  assert.match(personnelPageSrc, /decideAccountAccessPageAccess/);
  assert.match(personnelPageSrc, /normalizeOrgUuid/);
});
