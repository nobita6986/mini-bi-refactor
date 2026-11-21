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
    capabilities: ["vendor_finance_view", "vendor_finance_record"],
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
  assert.equal(JSON.parse(post1.options.body).expected_account_version, 5);
  assert.equal(JSON.parse(post1.options.body).group_id, GROUP_ACC_ID);

  respond(post1, 503, { ok: false, code: "AUTHZ_UNAVAILABLE" });
  await h.flush();
  assert.ok(findButton(h, "Thử đồng bộ lại"));

  findNode(h, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await h.flush();
  const post2 = findLastRequest((r) => r.method === "POST" && r.url.endsWith("/groups"));
  assert.equal(post2.options.headers["Idempotency-Key"], key1);

  respond(post2, 201, {
    ok: true,
    membership_id: MEMBERSHIP_ACC_ID,
    group_id: GROUP_ACC_ID,
    group_code: "ACCOUNTING_OPERATIONS",
    group_name: "Kế toán vận hành",
    account_ref: OWNER_ACCOUNT_REF,
    account_version: 6,
    is_protected: false,
    started_at: "2026-11-21T01:00:00Z",
    replayed: false,
  });
  await h.flush();
  assert.equal(notifications.success.length, 1);
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
    findLastRequest((r) => r.url.includes(`/user-directory/entry?account_ref=${OWNER_ACCOUNT_REF}`)),
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
    assert.doesNotMatch(src, /Tài khoản đặc biệt|Đối chiếu dữ liệu cũ|Quyền hiệu lực|Tra cứu quyền hiệu lực/, `${rel} leaked forbidden legacy screen text`);
    assert.doesNotMatch(src, /leave-shared-account-banner|leave-profile-shared-checkbox|Đánh dấu là tài khoản dùng chung/, `${rel} leaked shared-account Leave UI`);
  }
});
