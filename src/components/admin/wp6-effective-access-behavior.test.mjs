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
    return reactShim.useRef(`pr28-ui-id-${activeHookInstance.id}-${activeHookInstance.cursor}`).current;
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
  if (request.startsWith("@/components/ui/") || request.startsWith("@/components/reporting/")) {
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
      for (const eff of effects) eff();
    }
    if (instance.dirty && !instance.unmounted) renderOnce();
  }

  const handle = {
    get tree() {
      return instance.tree;
    },
    async flush() {
      for (let i = 0; i < 6; i += 1) {
        runEffects();
        await new Promise((r) => setImmediate(r));
        runEffects();
      }
    },
    unmount() {
      if (instance.unmounted) return;
      instance.unmounted = true;
      activeMounts.delete(handle);
      for (const cleanup of [...instance.cleanups]) cleanup();
      instance.cleanups.clear();
    },
  };

  activeMounts.add(handle);
  runEffects();
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
    for (const [key, value] of Object.entries(props)) {
      if (key === "children" || key === "actions" || key === "footer" || key === "badge") {
        collectNodes(value, out);
      }
    }
  }
  return out;
}

function textOf(node) {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) {
    return [node.props?.title, node.props?.description, node.props?.children]
      .filter((v) => v !== undefined && v !== null)
      .map(textOf)
      .join(" ");
  }
  return "";
}

function findNode(handle, predicate) {
  const match = collectNodes(handle.tree).find(predicate);
  assert.ok(match, "Expected matching element in rendered tree");
  return match;
}

function findButton(handle, label) {
  return findNode(
    handle,
    (n) => (n.type === "button" || n.type?.name === "Button") && textOf(n).trim().includes(label),
  );
}

let requests = [];
function setupFetchMock() {
  requests = [];
  globalThis.fetch = (url, options = {}) => {
    const req = {
      url: String(url),
      method: String(options.method ?? "GET").toUpperCase(),
      options,
      signal: options.signal ?? null,
      settled: false,
    };
    const promise = new Promise((resolve, reject) => {
      req.resolve = resolve;
      req.reject = reject;
    });
    if (req.signal) {
      req.signal.addEventListener("abort", () => {
        if (!req.settled) {
          req.settled = true;
          req.reject(new DOMException("Aborted", "AbortError"));
        }
      });
    }
    requests.push(req);
    return promise;
  };
}

function respond(req, status, body) {
  assert.ok(req && !req.settled, `Expected unsettled request (${req?.url})`);
  req.settled = true;
  req.resolve({
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  });
}

function rejectNetwork(req) {
  assert.ok(req && !req.settled);
  req.settled = true;
  req.reject(new TypeError("Failed to fetch"));
}

function findLastRequest(predicate) {
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    if (predicate(requests[i])) return requests[i];
  }
  return null;
}

function makeWorkspaceGuard() {
  let epoch = 0;
  const controllers = new Set();
  return {
    getEpoch: () => epoch,
    invalidateSession() {
      epoch += 1;
      for (const c of controllers) c.abort();
      controllers.clear();
    },
    trackController() {
      const controller = new AbortController();
      const capturedEpoch = epoch;
      controllers.add(controller);
      return {
        epoch: capturedEpoch,
        controller,
        release: () => controllers.delete(controller),
      };
    },
    isActive: (capturedEpoch, controller) =>
      capturedEpoch === epoch && (!controller || !controller.signal.aborted),
  };
}

const { AccountGroupsSection } = repoRequire("./src/components/admin/account-groups-section.tsx");
const { PermissionGroupsManager } = repoRequire("./src/components/admin/permission-groups-manager.tsx");
const { AccountDirectoryDetailManager } = repoRequire(
  "./src/components/admin/account-directory-detail-manager.tsx",
);
const {
  parseAssignGroupMemberBody,
  parseCreateGroupBody,
  parseRemoveGroupMemberBody,
  projectAccountGroupsResponse,
  projectListGroupsResponse,
} = repoRequire("./src/lib/admin/permission-group-contract.ts");
const { CAPABILITIES } = repoRequire("./src/lib/auth/direct-entry-v2.ts");

const OWNER_ACCOUNT_REF = "11111111-1111-4111-8111-111111111111";
const GROUP_ADMIN_ID = "22222222-2222-4222-8222-222222222201";
const GROUP_ACC_ID = "22222222-2222-4222-8222-222222222202";
const DEPT_BOD_ID = "33333333-3333-4333-8333-333333333301";
const DEPT_ACC_ID = "33333333-3333-4333-8333-333333333302";
const MEMBERSHIP_OWNER_ID = "44444444-4444-4444-8444-444444444401";
const MEMBERSHIP_ACC_ID = "44444444-4444-4444-8444-444444444402";

const SAMPLE_GROUPS = [
  {
    group_id: GROUP_ADMIN_ID,
    code: "SYSTEM_ADMIN",
    name: "BoD/Admin",
    description: "Toàn quyền quản trị hệ thống",
    department_id: DEPT_BOD_ID,
    department_code: "MANAGEMENT_BOD",
    department_name: "Ban Giám đốc",
    department_system_key: "MANAGEMENT_BOD",
    team_id: null,
    team_code: null,
    team_name: null,
    is_system_admin: true,
    active: true,
    version: 1,
    capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
    module_roles: [],
    member_count: 1,
    member_account_refs: [OWNER_ACCOUNT_REF],
    updated_at: "2026-11-21T00:00:00Z",
  },
  {
    group_id: GROUP_ACC_ID,
    code: "ACCOUNTING_OPERATIONS",
    name: "Kế toán vận hành",
    description: "Quản lý công nợ nhà cung cấp",
    department_id: DEPT_ACC_ID,
    department_code: "ACCOUNTING",
    department_name: "Kế toán",
    department_system_key: "ACCOUNTING",
    team_id: null,
    team_code: null,
    team_name: null,
    is_system_admin: false,
    active: true,
    version: 1,
    capabilities: ["vendor_finance_view"],
    module_roles: [{ module_code: "vendor_finance", role_code: "GLOBAL_VIEWER" }],
    member_count: 0,
    member_account_refs: [],
    updated_at: "2026-11-21T00:00:00Z",
  },
];

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

test("PR #28 [AccountGroupsSection]: enforces Owner is_protected lock, assigns group with OCC + Idempotency-Key, preserves exact key on 503 retry, and blocks 409", async () => {
  const guard = makeWorkspaceGuard();
  const h = mount(AccountGroupsSection, {
    accountRef: OWNER_ACCOUNT_REF,
    canManageGroups: true,
    workspaceGuard: guard,
    onSessionLost: () => {},
  });
  await h.flush();

  respond(
    findLastRequest((r) => r.url.endsWith(`/accounts/${OWNER_ACCOUNT_REF}/groups`)),
    200,
    {
      ok: true,
      as_of: "2026-11-21T00:00:00Z",
      account_ref: OWNER_ACCOUNT_REF,
      account_version: 5,
      enabled: true,
      memberships: [
        {
          membership_id: MEMBERSHIP_OWNER_ID,
          group_id: GROUP_ADMIN_ID,
          group_code: "SYSTEM_ADMIN",
          group_name: "BoD/Admin",
          group_description: "Toàn quyền quản trị hệ thống",
          department_id: DEPT_BOD_ID,
          department_name: "Ban Giám đốc",
          team_id: null,
          team_name: null,
          is_system_admin: true,
          group_active: true,
          is_protected: true,
          can_remove: false,
          cannot_remove_reason: "PROTECTED_OWNER_ADMIN",
          started_at: "2026-11-21T00:00:00Z",
          capabilities: ["entry_admin"],
          module_roles: [],
        },
      ],
      resource_assignments: [
        { assignment_kind: "DEPARTMENT_HEAD", resource_ref: DEPT_BOD_ID, resource_label: "Ban Giám đốc" },
      ],
    },
  );
  respond(findLastRequest((r) => r.url.includes("/api/admin/access/groups?")), 200, {
    ok: true,
    as_of: "2026-11-21T00:00:00Z",
    groups: SAMPLE_GROUPS,
  });
  await h.flush();

  const rendered = textOf(h.tree);
  assert.ok(rendered.includes("BoD/Admin"));
  assert.ok(rendered.includes("Tài khoản chủ sở hữu được bảo vệ"));
  assert.ok(rendered.includes("Trưởng phòng ban"));
  assert.equal(rendered.includes("GLOBAL"), false);
  assert.equal(rendered.includes("CONTEXTUAL"), false);
  assert.equal(rendered.includes("Quyền hiệu lực"), false);

  // Protected Owner membership button must be disabled
  const protectedBtn = findButton(h, "Đang bảo vệ");
  assert.equal(protectedBtn.props.disabled, true);

  // Open Assign Group dialog -> submit -> 503 uncertain -> retry reuses exact Idempotency-Key -> 201 succeeds
  findButton(h, "+ Thêm vào nhóm quyền").props.onClick();
  await h.flush();
  findNode(h, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await h.flush();

  const post1 = findLastRequest((r) => r.method === "POST" && r.url.endsWith("/groups"));
  assert.ok(post1);
  const key1 = post1.options.headers["Idempotency-Key"];
  const parsedPost1 = parseAssignGroupMemberBody(JSON.parse(post1.options.body));
  assert.equal(parsedPost1.ok, true, "POST /groups body must strictly satisfy real server contract parser (no idempotency_key in body)");
  assert.equal(parsedPost1.value.expected_account_version, 5);
  assert.equal(parsedPost1.value.group_id, GROUP_ACC_ID);

  respond(post1, 503, { ok: false, code: "AUTHZ_UNAVAILABLE" });
  await h.flush();
  assert.ok(findButton(h, "Thử đồng bộ lại"));

  findNode(h, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await h.flush();
  const post2 = findLastRequest((r) => r.method === "POST" && r.url.endsWith("/groups"));
  assert.equal(post2.options.headers["Idempotency-Key"], key1);

  respond(post2, 201, {
    ok: true,
    membership: {
      membership_id: MEMBERSHIP_ACC_ID,
      group_id: GROUP_ACC_ID,
      group_code: "ACCOUNTING_OPERATIONS",
      group_name: "Kế toán vận hành",
      account_ref: OWNER_ACCOUNT_REF,
      account_version: 6,
      is_protected: false,
      started_at: "2026-11-21T01:00:00Z",
      replayed: false,
    },
  });
  await h.flush();
  assert.equal(notifications.success.length, 1);

  // Reload returns both protected Owner membership and newly assigned removable ACCOUNTING_OPERATIONS membership
  respond(
    findLastRequest((r) => r.method === "GET" && r.url.endsWith(`/accounts/${OWNER_ACCOUNT_REF}/groups`)),
    200,
    {
      ok: true,
      as_of: "2026-11-21T01:00:00Z",
      account_ref: OWNER_ACCOUNT_REF,
      account_version: 6,
      enabled: true,
      memberships: [
        {
          membership_id: MEMBERSHIP_OWNER_ID,
          group_id: GROUP_ADMIN_ID,
          group_code: "SYSTEM_ADMIN",
          group_name: "BoD/Admin",
          group_description: "Toàn quyền quản trị hệ thống",
          department_id: DEPT_BOD_ID,
          department_name: "Ban Giám đốc",
          team_id: null,
          team_name: null,
          is_system_admin: true,
          group_active: true,
          is_protected: true,
          can_remove: false,
          cannot_remove_reason: "PROTECTED_OWNER_ADMIN",
          started_at: "2026-11-21T00:00:00Z",
          capabilities: ["entry_admin"],
          module_roles: [],
        },
        {
          membership_id: MEMBERSHIP_ACC_ID,
          group_id: GROUP_ACC_ID,
          group_code: "ACCOUNTING_OPERATIONS",
          group_name: "Kế toán vận hành",
          group_description: "Quản lý công nợ nhà cung cấp",
          department_id: DEPT_ACC_ID,
          department_name: "Kế toán",
          team_id: null,
          team_name: null,
          is_system_admin: false,
          group_active: true,
          is_protected: false,
          can_remove: true,
          cannot_remove_reason: null,
          started_at: "2026-11-21T01:00:00Z",
          capabilities: ["vendor_finance_view"],
          module_roles: [{ module_code: "vendor_finance", role_code: "GLOBAL_VIEWER" }],
        },
      ],
      resource_assignments: [],
    },
  );
  respond(findLastRequest((r) => r.url.includes("/api/admin/access/groups?")), 200, {
    ok: true,
    as_of: "2026-11-21T01:00:00Z",
    groups: SAMPLE_GROUPS,
  });
  await h.flush();

  // P0-2: Removing non-protected membership calls DELETE /accounts/{ref}/groups/{membershipId} with clean body
  findButton(h, "Gỡ khỏi nhóm").props.onClick();
  await h.flush();
  findNode(h, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await h.flush();
  const delReq = findLastRequest(
    (r) =>
      r.method === "DELETE" &&
      r.url === `/api/admin/access/accounts/${OWNER_ACCOUNT_REF}/groups/${MEMBERSHIP_ACC_ID}`,
  );
  assert.ok(delReq, "DELETE must target /accounts/{ref}/groups/{membershipId}");
  assert.ok(delReq.options.headers["Idempotency-Key"]);
  const parsedDel = parseRemoveGroupMemberBody(JSON.parse(delReq.options.body));
  assert.equal(parsedDel.ok, true, "DELETE body must satisfy real parseRemoveGroupMemberBody (no membership_id/idempotency_key)");
  assert.equal(parsedDel.value.expected_account_version, 6);
  respond(delReq, 200, {
    ok: true,
    membership: {
      membership_id: MEMBERSHIP_ACC_ID,
      account_ref: OWNER_ACCOUNT_REF,
      account_version: 7,
      replayed: false,
    },
  });
  await h.flush();
  assert.equal(notifications.success.length, 2);
});

test("PR #28 [PermissionGroupsManager]: renders BoD/Admin as locked default, lists plain Vietnamese actions, and creates custom group with department", async () => {
  const h = mount(PermissionGroupsManager);
  await h.flush();

  respond(findLastRequest((r) => r.url.startsWith("/api/admin/access/groups?")), 200, {
    ok: true,
    as_of: "2026-11-21T00:00:00Z",
    groups: SAMPLE_GROUPS,
  });
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments?")), 200, {
    ok: true,
    authorization_date: "2026-11-21",
    as_of: "2026-11-21T00:00:00Z",
    departments: [
      {
        department_id: DEPT_ACC_ID,
        code: "ACCOUNTING",
        name: "Kế toán",
        system_key: "ACCOUNTING",
        is_active: true,
        version: 1,
        active_member_count: 1,
        active_head: null,
      },
    ],
  });
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/catalog/teams?")), 200, {
    ok: true,
    teams: [],
  });
  await h.flush();

  const text = textOf(h.tree);
  assert.ok(text.includes("BoD/Admin"));
  assert.ok(text.includes("Cấu hình cố định"));
  assert.ok(text.includes("Xem công nợ nhà cung cấp"));
  assert.ok(text.includes("Xem Tài chính NCC toàn công ty"));
  // Raw capability names must never be exposed in customer UI
  assert.equal(text.includes("vendor_finance_view"), false);
  assert.equal(text.includes("GLOBAL_VIEWER"), false);
  assert.equal(text.includes("scope_template"), false);
});

test("PR #28 [AccountDirectoryDetailManager]: manages unlinked legacy accounts (edit display name, lock/unlock, zero-Auth-retry reset password) & clears on 403", async () => {
  const h = mount(AccountDirectoryDetailManager, {
    accountRef: OWNER_ACCOUNT_REF,
    canManageGroups: true,
  });
  await h.flush();

  respond(
    findLastRequest((r) => r.url.includes(`/user-directory/detail?account_ref=${OWNER_ACCOUNT_REF}`)),
    200,
    {
      ok: true,
      authorization_date: "2026-11-21",
      as_of: "2026-11-21T00:00:00Z",
      entry: {
        directory_entry_key: `account:${OWNER_ACCOUNT_REF}`,
        record_kind: "UNLINKED_ACCOUNT",
        display_name: "Tài Khoản Cá Nhân Cũ 01",
        login_state: "ENABLED",
        person_id: null,
        account_ref: OWNER_ACCOUNT_REF,
        active_link_id: null,
        link_conflict: false,
        identity_mutation_blocked: false,
        conflict_details: null,
        person: null,
        account: {
          account_ref: OWNER_ACCOUNT_REF,
          login_id: "legacy01",
          display_name: "Tài Khoản Cá Nhân Cũ 01",
          enabled: true,
          version: 3,
          auth_user_present: true,
        },
        active_link: null,
        department_history: [],
        head_assignments: [],
        link_history: [],
      },
    },
  );
  await h.flush();

  assert.ok(textOf(h.tree).includes("Tài Khoản Cá Nhân Cũ 01"));
  assert.ok(findButton(h, "Sửa tên hiển thị"));
  assert.ok(findButton(h, "Khóa đăng nhập"));
  assert.ok(findButton(h, "Đặt lại mật khẩu"));

  // P0-1: Edit display name submits POST (not PATCH) to /display-name
  findButton(h, "Sửa tên hiển thị").props.onClick();
  await h.flush();
  const nameInput = findNode(h, (n) => n.type === "input" && n.props?.type === "text");
  nameInput.props.onChange({ target: { value: "Nguyễn Thị Lan" } });
  await h.flush();
  findNode(h, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await h.flush();
  const renameReq = findLastRequest(
    (r) => r.method === "POST" && r.url === `/api/admin/access/accounts/${OWNER_ACCOUNT_REF}/display-name`,
  );
  assert.ok(renameReq, "edit display name must use POST /display-name");
  respond(renameReq, 200, {
    ok: true,
    account: {
      app_user_id: OWNER_ACCOUNT_REF,
      version: 4,
      revision_id: "55555555-5555-4555-8555-555555555551",
      recruiter_id: null,
      recruiter_version: null,
      recruiter_revision_id: null,
    },
  });
  await h.flush();
  // Drain the triggered reload GET /user-directory/detail
  respond(
    findLastRequest((r) => r.method === "GET" && r.url.includes(`/user-directory/detail?account_ref=${OWNER_ACCOUNT_REF}`)),
    200,
    {
      ok: true,
      authorization_date: "2026-11-21",
      as_of: "2026-11-21T00:05:00Z",
      entry: {
        directory_entry_key: `account:${OWNER_ACCOUNT_REF}`,
        record_kind: "UNLINKED_ACCOUNT",
        display_name: "Nguyễn Thị Lan",
        login_state: "ENABLED",
        person_id: null,
        account_ref: OWNER_ACCOUNT_REF,
        active_link_id: null,
        link_conflict: false,
        identity_mutation_blocked: false,
        conflict_details: null,
        person: null,
        account: {
          account_ref: OWNER_ACCOUNT_REF,
          login_id: "legacy01",
          display_name: "Nguyễn Thị Lan",
          enabled: true,
          version: 4,
          auth_user_present: true,
        },
        active_link: null,
        department_history: [],
        head_assignments: [],
        link_history: [],
      },
    },
  );
  await h.flush();

  // Open Reset Password -> network failure locks dialog without blind Auth retry
  findButton(h, "Đặt lại mật khẩu").props.onClick();
  await h.flush();
  const pwdInputs = collectNodes(h.tree).filter((n) => n.type === "input" && n.props?.type === "password");
  assert.equal(pwdInputs.length, 2);
  pwdInputs[0].props.onChange({ target: { value: "NewPass123!" } });
  pwdInputs[1].props.onChange({ target: { value: "NewPass123!" } });
  await h.flush();

  findNode(h, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await h.flush();
  const resetReq = findLastRequest((r) => r.url.endsWith("/reset-password"));
  assert.ok(resetReq);
  rejectNetwork(resetReq);
  await h.flush();

  const submitAfterDrop = findButton(h, "Xác nhận đặt lại mật khẩu");
  assert.equal(submitAfterDrop.props.disabled, true);
  assert.ok(textOf(h.tree).includes("không tự gửi lại yêu cầu đổi mật khẩu"));
});

test("PR #28 Zero-Forbidden-Jargon Guard: customer UI components contain no technical internal copy", () => {
  const files = [
    "src/components/admin/person-list-manager.tsx",
    "src/components/admin/account-groups-section.tsx",
    "src/components/admin/account-directory-detail-manager.tsx",
    "src/components/admin/permission-groups-manager.tsx",
    "src/components/admin/person-detail-manager.tsx",
    "src/components/admin/account-provision-and-link-stepper.tsx",
    "src/components/leave/leave-management-workspace.tsx",
  ];
  for (const rel of files) {
    const src = readFileSync(path.join(repoRoot, rel), "utf8");
    assert.doesNotMatch(
      src,
      /Tài khoản đặc biệt|Đối chiếu dữ liệu cũ|Quyền hiệu lực|Tra cứu quyền hiệu lực|\(D10\)|Gỡ liên kết tài khoản/,
      `${rel} leaked forbidden legacy screen text`,
    );
    assert.doesNotMatch(src, /leave-shared-account-banner|leave-profile-shared-checkbox|Đánh dấu là tài khoản dùng chung/, `${rel} leaked shared-account Leave UI`);
  }
  assert.equal(typeof parseCreateGroupBody, "function");
});

test("PR28-T0-R4 API -> Component: migrated direct-grant groups render plain Vietnamese labels across PermissionGroupsManager (list + edit modal) and AccountGroupsSection (coexisting independent sources)", async () => {
  const DEPT_REC_ID = "33333333-3333-4333-8333-333333333303";
  const TEAM_NORTH_ID = "aabbccdd-1111-4111-8111-111111111111";
  const GROUP_HR_ID = "22222222-2222-4222-8222-222222222210";
  const GROUP_MIG_DEPT_ID = "22222222-2222-4222-8222-222222222211";
  const GROUP_MIG_OWN_ID = "22222222-2222-4222-8222-222222222212";
  const GROUP_MIG_TEAM_ID = "22222222-2222-4222-8222-222222222213";
  const TARGET_USER_REF = "11111111-1111-4111-8111-111111111199";

  const rawGroupsPayload = {
    as_of: "2026-11-22T00:00:00Z",
    groups: [
      {
        group_id: GROUP_HR_ID,
        code: "HR_CATALOG_OPERATOR",
        name: "Vận hành Nhân sự & Danh mục",
        description: "Quản trị danh mục tuyển dụng, tổ đội, nhân sự tuyển dụng, nhật ký kiểm toán và xem chứng từ.",
        department_id: DEPT_REC_ID,
        department_code: "RECRUITMENT",
        department_name: "Phòng Tuyển dụng",
        department_system_key: "RECRUITMENT",
        team_id: null,
        team_code: null,
        team_name: null,
        is_system_admin: false,
        active: true,
        version: 1,
        capabilities: [
          "catalog_master_manage",
          "recruiter_master_manage",
          "team_master_manage",
          "audit_view",
          "document_view",
        ],
        module_roles: [],
        member_count: 1,
        member_account_refs: [TARGET_USER_REF],
        updated_at: "2026-11-22T00:00:00Z",
      },
      {
        group_id: GROUP_MIG_DEPT_ID,
        code: "MIGRATED_DEPT_CATALOG_MASTER_MANAGE",
        name: "Quản lý danh mục dự án và NCC (Cấp riêng)",
        description: "Nhóm quyền nghiệp vụ cấp riêng theo đơn vị: Quản lý danh mục dự án và NCC.",
        department_id: DEPT_REC_ID,
        department_code: "RECRUITMENT",
        department_name: "Phòng Tuyển dụng",
        department_system_key: "RECRUITMENT",
        team_id: null,
        team_code: null,
        team_name: null,
        is_system_admin: false,
        active: true,
        version: 1,
        capabilities: ["catalog_master_manage"],
        module_roles: [],
        member_count: 1,
        member_account_refs: [TARGET_USER_REF],
        updated_at: "2026-11-22T00:00:00Z",
      },
      {
        group_id: GROUP_MIG_OWN_ID,
        code: "MIGRATED_OWN_ENTRY_CREATE",
        name: "Tạo hồ sơ tuyển dụng (Cá nhân)",
        description: "Nhóm quyền nghiệp vụ cấp riêng theo hồ sơ cá nhân: Tạo hồ sơ tuyển dụng.",
        department_id: DEPT_REC_ID,
        department_code: "RECRUITMENT",
        department_name: "Phòng Tuyển dụng",
        department_system_key: "RECRUITMENT",
        team_id: null,
        team_code: null,
        team_name: null,
        is_system_admin: false,
        active: true,
        version: 1,
        capabilities: ["entry_create"],
        module_roles: [],
        member_count: 1,
        member_account_refs: [TARGET_USER_REF],
        updated_at: "2026-11-22T00:00:00Z",
      },
      {
        group_id: GROUP_MIG_TEAM_ID,
        code: "MIGRATED_TEAM_AABBCCDD_ENTRY_TEAM",
        name: "Theo dõi tuyển dụng tổ đội — Tổ Miền Bắc",
        description: "Nhóm quyền nghiệp vụ cấp riêng theo tổ đội: Theo dõi tuyển dụng tổ đội.",
        department_id: DEPT_REC_ID,
        department_code: "RECRUITMENT",
        department_name: "Phòng Tuyển dụng",
        department_system_key: "RECRUITMENT",
        team_id: TEAM_NORTH_ID,
        team_code: "to-mien-bac",
        team_name: "Tổ Miền Bắc",
        is_system_admin: false,
        active: true,
        version: 1,
        capabilities: ["entry_team"],
        module_roles: [],
        member_count: 1,
        member_account_refs: [TARGET_USER_REF],
        updated_at: "2026-11-22T00:00:00Z",
      },
    ],
  };

  const projectedList = projectListGroupsResponse(rawGroupsPayload);
  assert.ok(projectedList, "migrated groups API payload must pass real projectListGroupsResponse contract");

  const rawAccountGroupsPayload = {
    as_of: "2026-11-22T00:00:00Z",
    account_ref: TARGET_USER_REF,
    account_version: 3,
    enabled: true,
    memberships: [
      {
        membership_id: "44444444-4444-4444-8444-444444444410",
        group_id: GROUP_HR_ID,
        group_code: "HR_CATALOG_OPERATOR",
        group_name: "Vận hành Nhân sự & Danh mục",
        group_description: "Quản trị danh mục tuyển dụng, tổ đội, nhân sự tuyển dụng, nhật ký kiểm toán và xem chứng từ.",
        department_id: DEPT_REC_ID,
        department_name: "Phòng Tuyển dụng",
        team_id: null,
        team_name: null,
        is_system_admin: false,
        group_active: true,
        is_protected: false,
        can_remove: true,
        cannot_remove_reason: null,
        started_at: "2026-11-22T00:00:00Z",
        capabilities: ["catalog_master_manage", "recruiter_master_manage", "team_master_manage", "audit_view", "document_view"],
        module_roles: [],
      },
      {
        membership_id: "44444444-4444-4444-8444-444444444411",
        group_id: GROUP_MIG_DEPT_ID,
        group_code: "MIGRATED_DEPT_CATALOG_MASTER_MANAGE",
        group_name: "Quản lý danh mục dự án và NCC (Cấp riêng)",
        group_description: "Nhóm quyền nghiệp vụ cấp riêng theo đơn vị: Quản lý danh mục dự án và NCC.",
        department_id: DEPT_REC_ID,
        department_name: "Phòng Tuyển dụng",
        team_id: null,
        team_name: null,
        is_system_admin: false,
        group_active: true,
        is_protected: false,
        can_remove: true,
        cannot_remove_reason: null,
        started_at: "2026-11-22T00:00:00Z",
        capabilities: ["catalog_master_manage"],
        module_roles: [],
      },
      {
        membership_id: "44444444-4444-4444-8444-444444444412",
        group_id: GROUP_MIG_OWN_ID,
        group_code: "MIGRATED_OWN_ENTRY_CREATE",
        group_name: "Tạo hồ sơ tuyển dụng (Cá nhân)",
        group_description: "Nhóm quyền nghiệp vụ cấp riêng theo hồ sơ cá nhân: Tạo hồ sơ tuyển dụng.",
        department_id: DEPT_REC_ID,
        department_name: "Phòng Tuyển dụng",
        team_id: null,
        team_name: null,
        is_system_admin: false,
        group_active: true,
        is_protected: false,
        can_remove: true,
        cannot_remove_reason: null,
        started_at: "2026-11-22T00:00:00Z",
        capabilities: ["entry_create"],
        module_roles: [],
      },
      {
        membership_id: "44444444-4444-4444-8444-444444444413",
        group_id: GROUP_MIG_TEAM_ID,
        group_code: "MIGRATED_TEAM_AABBCCDD_ENTRY_TEAM",
        group_name: "Theo dõi tuyển dụng tổ đội — Tổ Miền Bắc",
        group_description: "Nhóm quyền nghiệp vụ cấp riêng theo tổ đội: Theo dõi tuyển dụng tổ đội.",
        department_id: DEPT_REC_ID,
        department_name: "Phòng Tuyển dụng",
        team_id: TEAM_NORTH_ID,
        team_name: "Tổ Miền Bắc",
        is_system_admin: false,
        group_active: true,
        is_protected: false,
        can_remove: true,
        cannot_remove_reason: null,
        started_at: "2026-11-22T00:00:00Z",
        capabilities: ["entry_team"],
        module_roles: [],
      },
    ],
    resource_assignments: [],
  };

  const projectedAccount = projectAccountGroupsResponse(rawAccountGroupsPayload);
  assert.ok(projectedAccount, "migrated account groups API payload must pass real projectAccountGroupsResponse contract");

  const assertZeroRawTokens = (surfaceText, surfaceLabel) => {
    for (const cap of CAPABILITIES) {
      assert.equal(
        surfaceText.includes(cap),
        false,
        `${surfaceLabel} leaked raw capability token: ${cap}`,
      );
    }
    assert.doesNotMatch(
      surfaceText,
      /MIGRATED_|chuyển đổi|quyền trực tiếp/i,
      `${surfaceLabel} leaked technical migration copy`,
    );
  };

  // 1) PermissionGroupsManager: list view + Edit modal on MIGRATED_DEPT_CATALOG_MASTER_MANAGE
  const groupsMount = mount(PermissionGroupsManager);
  await groupsMount.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/access/groups?")), 200, {
    ok: true,
    ...projectedList,
  });
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments?")), 200, {
    ok: true,
    authorization_date: "2026-11-22",
    as_of: "2026-11-22T00:00:00Z",
    departments: [
      {
        department_id: DEPT_REC_ID,
        code: "RECRUITMENT",
        name: "Phòng Tuyển dụng",
        system_key: "RECRUITMENT",
        is_active: true,
        version: 1,
        active_member_count: 1,
        active_head: null,
      },
    ],
  });
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/catalog/teams?")), 200, {
    ok: true,
    teams: [
      {
        team_id: TEAM_NORTH_ID,
        code: "to-mien-bac",
        display_name: "Tổ Miền Bắc",
        active: true,
        version: 1,
        updated_at: "2026-11-22T00:00:00Z",
      },
    ],
  });
  await groupsMount.flush();

  const listText = textOf(groupsMount.tree);
  assert.ok(listText.includes("Quản lý danh mục dự án và NCC (Cấp riêng)"));
  assert.ok(listText.includes("Tạo hồ sơ tuyển dụng (Cá nhân)"));
  assert.ok(listText.includes("Theo dõi tuyển dụng tổ đội — Tổ Miền Bắc"));
  assert.ok(listText.includes("Tổ đội: Tổ Miền Bắc"));
  assertZeroRawTokens(listText, "PermissionGroupsManager list");

  // Open Edit dialog on the migrated dept group (2nd "Chỉnh sửa" button: index 1 after HR_CATALOG_OPERATOR)
  const editButtons = collectNodes(groupsMount.tree).filter(
    (n) => (n.type === "button" || n.type?.name === "Button") && textOf(n).trim() === "Chỉnh sửa",
  );
  assert.equal(editButtons.length, 4);
  editButtons[1].props.onClick();
  await groupsMount.flush();

  const editModalText = textOf(groupsMount.tree);
  const editInputValues = collectNodes(groupsMount.tree)
    .filter((n) => n.type === "input")
    .map((n) => String(n.props?.value ?? ""))
    .join("\n");
  assert.equal(editModalText.includes("Mã nhóm"), false, "Edit modal must hide technical Mã nhóm field");
  assert.ok(editInputValues.includes("Quản lý danh mục dự án và NCC (Cấp riêng)"));
  assertZeroRawTokens(`${editModalText}\n${editInputValues}`, "PermissionGroupsManager edit modal");

  // 2) AccountGroupsSection: coexisting HR_CATALOG_OPERATOR + 3 migrated independent memberships
  const guard = makeWorkspaceGuard();
  const acctMount = mount(AccountGroupsSection, {
    accountRef: TARGET_USER_REF,
    canManageGroups: true,
    workspaceGuard: guard,
    onSessionLost: () => {},
  });
  await acctMount.flush();
  respond(findLastRequest((r) => r.url.endsWith(`/accounts/${TARGET_USER_REF}/groups`)), 200, {
    ok: true,
    ...projectedAccount,
  });
  respond(findLastRequest((r) => r.url.includes("/api/admin/access/groups?")), 200, {
    ok: true,
    ...projectedList,
  });
  await acctMount.flush();

  const acctText = textOf(acctMount.tree);
  assert.ok(acctText.includes("Vận hành Nhân sự & Danh mục"));
  assert.ok(acctText.includes("Quản lý danh mục dự án và NCC (Cấp riêng)"));
  assert.ok(acctText.includes("Tạo hồ sơ tuyển dụng (Cá nhân)"));
  assert.ok(acctText.includes("Theo dõi tuyển dụng tổ đội — Tổ Miền Bắc"));
  assert.ok(acctText.includes("Tổ đội: Tổ Miền Bắc"));
  assertZeroRawTokens(acctText, "AccountGroupsSection migrated memberships");

  const removeButtons = collectNodes(acctMount.tree).filter(
    (n) => (n.type === "button" || n.type?.name === "Button") && textOf(n).trim() === "Gỡ khỏi nhóm",
  );
  assert.equal(removeButtons.length, 4, "Every coexisting independent membership must remain independently removable");
});
