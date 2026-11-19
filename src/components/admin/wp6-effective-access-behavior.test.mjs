import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const repoRequire = Module.createRequire(path.join(repoRoot, "package.json"));
const fixtures = JSON.parse(
  readFileSync(
    path.join(repoRoot, "docs/contracts/fixtures/wp5b1-role-access/role-access-fixtures.json"),
    "utf8",
  ),
);

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
    return reactShim.useRef(`wp6-test-id-${activeHookInstance.id}-${activeHookInstance.cursor}`)
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
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    });
    mod._compile(compiled.outputText, filename);
  };
}

let nextInstanceId = 1;
const activeMounts = new Set();

function mount(Component, props = {}) {
  const handle = {
    id: nextInstanceId++,
    Component,
    props,
    slots: [],
    cursor: 0,
    dirty: true,
    pendingEffects: [],
    cleanups: new Set(),
    tree: null,
    unmounted: false,
    render() {
      if (handle.unmounted) return;
      handle.cursor = 0;
      handle.dirty = false;
      handle.pendingEffects = [];
      activeHookInstance = handle;
      try {
        handle.tree = handle.Component(handle.props);
      } finally {
        activeHookInstance = null;
      }
      for (const runEffect of handle.pendingEffects) {
        runEffect();
      }
    },
    async flush() {
      for (let i = 0; i < 40; i += 1) {
        if (handle.unmounted) return;
        if (handle.dirty) handle.render();
        await new Promise((resolve) => setImmediate(resolve));
        if (!handle.dirty) return;
      }
      throw new Error(`Component ${Component.name || "anonymous"} did not settle`);
    },
    async rerender(nextProps) {
      handle.props = nextProps;
      handle.dirty = true;
      await handle.flush();
    },
    async replayStrictEffects() {
      if (handle.unmounted) return;
      for (const slot of handle.slots) {
        if (slot && typeof slot.setupFn === "function" && typeof slot.cleanup === "function") {
          const runCleanup = slot.cleanup;
          slot.cleanup = null;
          runCleanup();
        }
      }
      for (const slot of handle.slots) {
        if (slot && typeof slot.setupFn === "function") {
          const cleanup = slot.setupFn();
          slot.cleanup = typeof cleanup === "function" ? cleanup : null;
        }
      }
      await handle.flush();
    },
    unmount() {
      if (handle.unmounted) return;
      handle.unmounted = true;
      for (const cleanup of handle.cleanups) {
        cleanup();
      }
      handle.cleanups.clear();
      activeMounts.delete(handle);
    },
  };
  activeMounts.add(handle);
  return handle;
}

const STATELESS_EXPAND = new Set(["EffectiveAccessDetailPanel"]);

function expandNode(node) {
  if (
    node &&
    typeof node === "object" &&
    typeof node.type === "function" &&
    STATELESS_EXPAND.has(node.type.name)
  ) {
    return node.type(node.props ?? {});
  }
  return node;
}

function collectNodes(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, out);
  } else if (node && typeof node === "object") {
    const resolved = expandNode(node);
    if (Array.isArray(resolved)) {
      collectNodes(resolved, out);
      return out;
    }
    if (resolved && typeof resolved === "object" && resolved.type && resolved.props) {
      out.push(resolved);
      for (const value of Object.values(resolved.props)) {
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
  const resolved = expandNode(node);
  if (Array.isArray(resolved)) return resolved.map(textOf).join("");
  if (resolved && typeof resolved === "object" && resolved.props) {
    return [
      resolved.props.title,
      resolved.props.detail,
      resolved.props.description,
      resolved.props.children,
    ]
      .filter((part) => part !== undefined && part !== null && part !== false)
      .map(textOf)
      .join("");
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

function findDialogForm(handle) {
  const dialogNode = findNode(handle, (n) => n.type?.name === "FormDialog");
  const formNode = collectNodes(dialogNode.props.children).find(
    (n) => n.type === "form" && typeof n.props?.onSubmit === "function",
  );
  assert.ok(formNode, "Expected <form> inside FormDialog");
  return formNode;
}

function findSubmitButton(handle, label) {
  return findNode(
    handle,
    (node) => node.props?.type === "submit" && textOf(node).trim() === label,
  );
}

function componentNode(handle, componentFnOrName, id) {
  const name = typeof componentFnOrName === "string" ? componentFnOrName : componentFnOrName.name;
  return findNode(
    handle,
    (node) =>
      typeof node.type === "function" &&
      node.type.name === name &&
      (id === undefined || node.props?.id === id),
  );
}

async function syncChildFromTree(parent, Component, currentChild, filterId) {
  const vnode = componentNode(parent, Component, filterId);
  const nextKey = vnode.key ?? null;
  if (!currentChild || currentChild.__reactKey !== nextKey || currentChild.unmounted) {
    currentChild?.unmount();
    const next = mount(vnode.type, vnode.props);
    next.__reactKey = nextKey;
    await next.flush();
    return next;
  }
  await currentChild.rerender(vnode.props);
  return currentChild;
}

let requests = [];

function setupFetchMock() {
  requests = [];
  globalThis.fetch = (url, options = {}) =>
    new Promise((resolve, reject) => {
      requests.push({
        url: String(url),
        method: (options.method ?? "GET").toUpperCase(),
        options,
        signal: options.signal ?? null,
        resolve,
        reject,
        settled: false,
      });
    });
}

function respond(req, status, payload) {
  assert.ok(req && !req.settled, `Expected unsettled request to settle (${req?.url})`);
  req.settled = true;
  req.resolve({
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  });
}

function rejectRequest(req, error) {
  assert.ok(req && !req.settled, `Expected unsettled request to reject (${req?.url})`);
  req.settled = true;
  req.reject(error);
}

function findLastRequest(predicate) {
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    if (!requests[i].settled && predicate(requests[i])) {
      return requests[i];
    }
  }
  return null;
}

function clearNotifications() {
  notifications.success.length = 0;
  notifications.error.length = 0;
  notifications.warning.length = 0;
  notifications.info.length = 0;
}

const OWNER_REF = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_REF = "aaaaaaaa-aaaa-4aaa-8aaa-000000000002";
const DISABLED_REF = "aaaaaaaa-aaaa-4aaa-8aaa-000000000003";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRolesEnvelope() {
  return { ok: true, ...cloneJson(fixtures.responses.roles_catalog) };
}

function makeSummaryList(overrides = {}) {
  return {
    ...cloneJson(fixtures.responses.accounts_summary),
    page_size: 25,
    ...overrides,
  };
}

function makeDetailEnvelope(keyOrCustom) {
  if (typeof keyOrCustom === "string") {
    return {
      ok: true,
      ...cloneJson(fixtures.responses.account_access_detail[keyOrCustom]),
    };
  }
  return { ok: true, ...cloneJson(keyOrCustom) };
}

function respondDefaultReads({
  detailMap = {
    [OWNER_REF]: makeDetailEnvelope("canonical_owner_protected"),
    [MEMBER_REF]: makeDetailEnvelope("member_admin_revocable_with_contextual_and_exception"),
    [DISABLED_REF]: makeDetailEnvelope("disabled_account_d10_zero_effective_grants"),
  },
  summaryList = makeSummaryList(),
} = {}) {
  let settledAny = false;
  for (const req of requests) {
    if (req.settled) continue;
    if (req.url === "/api/admin/access/roles") {
      respond(req, 200, makeRolesEnvelope());
      settledAny = true;
    } else if (req.url.startsWith("/api/admin/access/accounts-summary?")) {
      respond(req, 200, { ok: true, list: summaryList });
      settledAny = true;
    } else if (/^\/api\/admin\/access\/accounts\/[^/]+\/access$/.test(req.url)) {
      const target = decodeURIComponent(req.url.split("/")[5]);
      if (detailMap[target]) {
        respond(req, 200, detailMap[target]);
        settledAny = true;
      }
    }
  }
  return settledAny;
}

async function drainDefaultReads(panel, ws, opts = {}) {
  for (let i = 0; i < 6; i += 1) {
    const settled = respondDefaultReads(opts);
    await panel.flush();
    if (ws) await ws.flush();
    if (!settled) break;
  }
}

const { EffectiveAccessWorkspace } = repoRequire(
  "./src/components/admin/effective-access-workspace.tsx",
);
const { AccountAccessWorkspace } = repoRequire(
  "./src/components/admin/account-access-workspace.tsx",
);
const { AccountGlobalRolesPanel } = repoRequire(
  "./src/components/admin/account-global-roles-panel.tsx",
);
const { AccountManager } = repoRequire("./src/components/admin/account-manager.tsx");

beforeEach(() => {
  clearNotifications();
  setupFetchMock();
  for (const h of [...activeMounts]) {
    h.unmount();
  }
});

after(() => {
  for (const h of [...activeMounts]) {
    h.unmount();
  }
  Module._load = originalModuleLoad;
  Module._extensions[".ts"] = originalTsExt;
  Module._extensions[".tsx"] = originalTsxExt;
  globalThis.fetch = originalFetch;
});

// ===========================================================================
// Surface A — /admin/access/effective (EffectiveAccessWorkspace)
// ===========================================================================

test("EffectiveAccessWorkspace renders roles, contextual/module links, D10 disabled separation, filters, pagination & aborts slow switches", async () => {
  const w = mount(EffectiveAccessWorkspace, {});
  await w.flush();

  const rolesReq = findLastRequest((r) => r.url === "/api/admin/access/roles");
  const summaryReq = findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts-summary?"));
  assert.ok(rolesReq && summaryReq);
  assert.equal(summaryReq.url.includes("search="), false);
  assert.equal(summaryReq.url.includes("role_code="), false);

  respond(rolesReq, 200, makeRolesEnvelope());
  respond(summaryReq, 200, { ok: true, list: makeSummaryList() });
  await w.flush();

  // Auto-selected first account (Owner) detail fetch starts immediately
  const ownerDetailReq = findLastRequest((r) => r.url.endsWith(`/${OWNER_REF}/access`));
  assert.ok(ownerDetailReq);
  respond(ownerDetailReq, 200, makeDetailEnvelope("canonical_owner_protected"));
  await w.flush();

  const ownerTreeText = textOf(w.tree);
  assert.match(ownerTreeText, /BoD\/Admin/);
  assert.match(ownerTreeText, /Chủ sở hữu hệ thống|Owner/i);

  // Race: click Member Admin -> hold slow response -> immediately click Disabled account D10
  const memberSelectBtn = findNode(
    w,
    (n) =>
      typeof n.props?.onClick === "function" &&
      String(n.props["aria-label"] ?? "").includes("Minh") &&
      String(n.props["aria-label"] ?? "").includes("Xem chi tiết quyền hiệu lực"),
  );
  memberSelectBtn.props.onClick();
  await w.flush();
  const slowMemberReq = findLastRequest((r) => r.url.endsWith(`/${MEMBER_REF}/access`));
  assert.ok(slowMemberReq);

  const disabledSelectBtn = findNode(
    w,
    (n) =>
      typeof n.props?.onClick === "function" &&
      String(n.props["aria-label"] ?? "").includes("Tran Van Tam") &&
      String(n.props["aria-label"] ?? "").includes("Xem chi tiết quyền hiệu lực"),
  );
  disabledSelectBtn.props.onClick();
  await w.flush();
  assert.equal(slowMemberReq.signal.aborted, true);

  const d10Req = findLastRequest((r) => r.url.endsWith(`/${DISABLED_REF}/access`));
  assert.ok(d10Req);
  respond(d10Req, 200, makeDetailEnvelope("disabled_account_d10_zero_effective_grants"));
  // Deliver slow Member Admin response late — must be ignored!
  respond(slowMemberReq, 200, makeDetailEnvelope("member_admin_revocable_with_contextual_and_exception"));
  await w.flush();

  const d10Text = textOf(w.tree);
  assert.match(d10Text, /0 quyền hiệu lực/);
  assert.match(d10Text, /Tuyển dụng \(Recruiter\)/);
  assert.match(d10Text, /Ngừng hoạt động|bị khóa/i);

  // Switch cleanly to Member Admin and verify read-only contextual + module links + zero mutation buttons
  memberSelectBtn.props.onClick();
  await w.flush();
  respond(
    findLastRequest((r) => r.url.endsWith(`/${MEMBER_REF}/access`)),
    200,
    makeDetailEnvelope("member_admin_revocable_with_contextual_and_exception"),
  );
  await w.flush();

  const memberLinks = collectNodes(w.tree)
    .filter((n) => n.type?.name === "Link")
    .map((n) => n.props.href);
  assert.equal(memberLinks.includes("/admin/catalog/teams"), true);
  assert.equal(memberLinks.includes("/direct-entry/projects"), true);
  assert.equal(memberLinks.includes("/work-reports/delegations"), true);

  const buttonsText = collectNodes(w.tree)
    .filter((n) => n.type?.name === "Button" || n.type === "button")
    .map((n) => textOf(n).trim());
  assert.equal(
    buttonsText.some((label) => /Cấp vai trò|Thu hồi vai trò/.test(label)),
    false,
  );

  // Filters reset page to 1 & omit empty search; OffsetPager requests page 2
  const pager = findNode(w, (n) => n.type?.name === "OffsetPager");
  pager.props.onPageChange(2);
  await w.flush();
  const page2Req = findLastRequest((r) => r.url.includes("page=2"));
  assert.ok(page2Req);
  respond(page2Req, 200, { ok: true, list: makeSummaryList({ page: 2, total: 40 }) });
  await w.flush();

  findNode(w, (n) => n.props?.id === "eff-search-input").props.onChange({
    target: { value: "  Minh  " },
  });
  findNode(w, (n) => n.props?.id === "eff-enabled-select").props.onChange({
    target: { value: "true" },
  });
  findNode(w, (n) => n.props?.id === "eff-role-select").props.onChange({
    target: { value: "ADMIN" },
  });
  await w.flush();
  const filterForm = findNode(
    w,
    (n) => n.type === "form" && typeof n.props?.onSubmit === "function",
  );
  filterForm.props.onSubmit({ preventDefault() {} });
  await w.flush();

  const filteredReq = findLastRequest((r) =>
    r.url.includes("search=Minh") && r.url.includes("enabled=true") && r.url.includes("role_code=ADMIN"),
  );
  assert.ok(filteredReq);
  assert.match(filteredReq.url, /page=1/);
  respond(filteredReq, 200, {
    ok: true,
    list: makeSummaryList({
      search: "Minh",
      enabled: "true",
      role_code: "ADMIN",
      page: 1,
      total: 1,
      accounts: fixtures.responses.accounts_summary.accounts.slice(1, 2),
    }),
  });
  await w.flush();
});

test("EffectiveAccessWorkspace handles 503 retry and 401/403 session loss invalidating in-flight requests", async () => {
  const w = mount(EffectiveAccessWorkspace, {});
  await w.flush();

  respond(findLastRequest((r) => r.url === "/api/admin/access/roles"), 200, makeRolesEnvelope());
  respond(
    findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts-summary?")),
    503,
    { ok: false, error: { code: "AUTHZ_UNAVAILABLE", message: "Service unavailable" } },
  );
  await w.flush();
  assert.match(textOf(w.tree), /Không tải được danh sách tài khoản/);

  findButton(w, "Thử tải lại").props.onClick();
  await w.flush();
  respondDefaultReads();
  await w.flush();
  assert.match(textOf(w.tree), /Canonical Owner/);

  // Trigger a detail fetch, then receive 403 while summary reload returns 401/403 -> clears workspace
  const memberBtn = findNode(
    w,
    (n) =>
      typeof n.props?.onClick === "function" &&
      String(n.props["aria-label"] ?? "").includes("Minh"),
  );
  memberBtn.props.onClick();
  await w.flush();
  const detailReq = findLastRequest((r) => r.url.endsWith(`/${MEMBER_REF}/access`));
  assert.ok(detailReq);
  respond(detailReq, 403, { ok: false, error: { code: "FORBIDDEN", message: "Denied" } });
  await w.flush();
  assert.match(textOf(w.tree), /Không có quyền xem quyền hiệu lực tài khoản/);
});

// ===========================================================================
// Surface B — Tablist keyboard nav, AccountManager shortcut & Owner preservation
// ===========================================================================

test("AccountAccessWorkspace supports ARIA keyboard tab switching, AccountManager row 'Vai trò' shortcut, and preserves Owner actions", async () => {
  const ws = mount(AccountAccessWorkspace, {
    canManageGlobalRoles: true,
    initialTab: "accounts",
    initialAccountRef: null,
  });
  await ws.flush();

  let mgr = await syncChildFromTree(ws, AccountManager, null);
  const mgrListReq = findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?"));
  const reclassifyReq = findLastRequest((r) => r.url === "/api/admin/access/accounts/reclassify");
  assert.ok(mgrListReq);
  respond(mgrListReq, 200, {
    ok: true,
    list: {
      search: null,
      enabled: "all",
      page: 1,
      page_size: 25,
      total: 2,
      accounts: [
        {
          account_ref: OWNER_REF,
          display_name: "Canonical Owner",
          login_id: "owner",
          enabled: true,
          version: 4,
          account_type: "NORMAL",
          active_person_link: null,
        },
        {
          account_ref: MEMBER_REF,
          display_name: "Minh Admin",
          login_id: "minh.admin",
          enabled: true,
          version: 3,
          account_type: "NORMAL",
          active_person_link: null,
        },
      ],
    },
  });
  if (reclassifyReq) {
    respond(reclassifyReq, 200, { ok: true, reclassified: 0, skipped: 0 });
  }
  await mgr.flush();

  // Existing Owner actions (Ngừng hoạt động / Đặt lại mật khẩu) remain present & usable
  assert.ok(findNode(mgr, (n) => textOf(n).trim() === "Ngừng hoạt động"));
  assert.ok(findNode(mgr, (n) => textOf(n).trim() === "Đặt lại mật khẩu"));

  // Clicking row shortcut "Vai trò" on Minh Admin opens Global Roles tab pre-selected to Minh Admin
  const memberRoleShortcut = findNode(
    mgr,
    (n) =>
      typeof n.props?.onClick === "function" &&
      String(n.props["aria-label"] ?? "").includes("Minh Admin") &&
      textOf(n).trim() === "Vai trò",
  );
  memberRoleShortcut.props.onClick();
  await ws.flush();

  const tabGlobalRoles = findNode(ws, (n) => n.props?.id === "tab-accounts-global-roles");
  assert.equal(tabGlobalRoles.props["aria-selected"], true);
  assert.equal(tabGlobalRoles.props.tabIndex, 0);

  // Sync AccountGlobalRolesPanel child & confirm selectedAccountRef is MEMBER_REF
  const panel = await syncChildFromTree(ws, AccountGlobalRolesPanel, null);
  assert.equal(panel.props.selectedAccountRef, MEMBER_REF);
  respondDefaultReads();
  await panel.flush();
  assert.match(textOf(panel.tree), /Minh/);

  // Keyboard ArrowLeft / End / Home / ArrowRight on tabs
  const tabGlobal = findNode(ws, (n) => n.props?.id === "tab-accounts-global-roles");
  tabGlobal.props.onKeyDown({ key: "ArrowLeft", preventDefault() {} });
  await ws.flush();
  assert.equal(
    findNode(ws, (n) => n.props?.id === "tab-accounts-overview").props["aria-selected"],
    true,
  );
  findNode(ws, (n) => n.props?.id === "tab-accounts-overview").props.onKeyDown({
    key: "End",
    preventDefault() {},
  });
  await ws.flush();
  assert.equal(
    findNode(ws, (n) => n.props?.id === "tab-accounts-global-roles").props["aria-selected"],
    true,
  );
  findNode(ws, (n) => n.props?.id === "tab-accounts-global-roles").props.onKeyDown({
    key: "Home",
    preventDefault() {},
  });
  await ws.flush();
  assert.equal(
    findNode(ws, (n) => n.props?.id === "tab-accounts-overview").props["aria-selected"],
    true,
  );
});

// ===========================================================================
// Surface B — Owner protection, 4 global roles, mutations, OCC, 503, stale replay, gates, Strict Mode
// ===========================================================================

async function mountWorkspaceOnGlobalRoles(initialAccountRef = OWNER_REF, canManageGlobalRoles = true) {
  const ws = mount(AccountAccessWorkspace, {
    canManageGlobalRoles,
    initialTab: "global-roles",
    initialAccountRef,
  });
  await ws.flush();
  let panel = await syncChildFromTree(ws, AccountGlobalRolesPanel, null);
  for (let i = 0; i < 4; i += 1) {
    const settled = respondDefaultReads();
    await panel.flush();
    await ws.flush();
    panel = await syncChildFromTree(ws, AccountGlobalRolesPanel, panel);
    if (!settled) break;
  }
  return { ws, panel };
}

test("AccountGlobalRolesPanel enforces server Owner protection, non-Owner ADMIN revoke, 4-role assign list, and read-only lock", async () => {
  // Read-only lock when canManageGlobalRoles=false
  const readOnly = await mountWorkspaceOnGlobalRoles(MEMBER_REF, false);
  assert.equal(findButton(readOnly.panel, "Cấp vai trò toàn cục").props.disabled, true);
  assert.equal(findButton(readOnly.panel, "Thu hồi vai trò").props.disabled, true);
  readOnly.ws.unmount();

  // Owner account: protected ADMIN has no revoke button + displays Protected banner
  clearNotifications();
  setupFetchMock();
  const { ws, panel } = await mountWorkspaceOnGlobalRoles(OWNER_REF, true);
  assert.equal(
    maybeNode(
      panel,
      (n) => typeof n.props?.onClick === "function" && textOf(n).trim() === "Thu hồi vai trò",
    ),
    null,
  );
  assert.match(textOf(panel.tree), /Owner.*bảo vệ|bảo vệ cố định/i);

  // Open Assign dialog on Owner: strictly 4 global roles, ADMIN = "BoD/Admin", never contextual roles
  findButton(panel, "Cấp vai trò toàn cục").props.onClick();
  await panel.flush();
  const roleSelect = findNode(panel, (n) => n.props?.id === "assign-global-role-select");
  const optionNodes = collectNodes(roleSelect.props.children).filter((n) => n.type === "option");
  const optionValues = optionNodes.map((n) => n.props.value).filter(Boolean);
  assert.deepEqual(optionValues, ["EMPLOYEE_BASE", "RECRUITER", "HR_OPERATOR", "ADMIN"]);
  const adminOpt = optionNodes.find((n) => n.props.value === "ADMIN");
  assert.match(textOf(adminOpt), /BoD\/Admin/);

  findButton(panel, "Hủy").props.onClick();
  await panel.flush();

  // Switch to non-Owner Member Admin -> "Thu hồi vai trò" IS available regardless of count
  findNode(
    panel,
    (n) =>
      typeof n.props?.onClick === "function" &&
      String(n.props["aria-label"] ?? "").includes("Minh") &&
      textOf(n).trim() === "Quản lý vai trò",
  ).props.onClick();
  await ws.flush();
  await syncChildFromTree(ws, AccountGlobalRolesPanel, panel);
  respondDefaultReads();
  await panel.flush();

  const memberRevokeBtn = findButton(panel, "Thu hồi vai trò");
  assert.equal(memberRevokeBtn.props.disabled, false);
  ws.unmount();
});

test("Assign 201 blocks synchronous double-submit and performs authoritative reload before closing & notifying", async () => {
  const { ws, panel } = await mountWorkspaceOnGlobalRoles(MEMBER_REF, true);

  findButton(panel, "Cấp vai trò toàn cục").props.onClick();
  await panel.flush();

  findNode(panel, (n) => n.props?.id === "assign-global-role-select").props.onChange({
    target: { value: "HR_OPERATOR" },
  });
  findNode(panel, (n) => n.props?.id === "role-mutation-reason-input").props.onChange({
    target: { value: "Grant HR Operator role for onboarding" },
  });
  await panel.flush();

  const form = findDialogForm(panel);
  form.props.onSubmit({ preventDefault() {} });
  // Immediate second synchronous submit must be ignored by mutationInFlightRef
  form.props.onSubmit({ preventDefault() {} });
  await panel.flush();

  const posts = requests.filter(
    (r) => r.method === "POST" && r.url.endsWith(`/${MEMBER_REF}/roles`),
  );
  assert.equal(posts.length, 1);
  assert.ok(posts[0].options.headers["Idempotency-Key"]);
  const body = JSON.parse(posts[0].options.body);
  assert.equal(body.role_code, "HR_OPERATOR");
  assert.equal(body.expected_version, 3);
  assert.equal(body.idempotency_key, posts[0].options.headers["Idempotency-Key"]);

  respond(posts[0], 201, {
    ok: true,
    ...cloneJson(fixtures.responses.mutations.assign_global_role_created),
  });
  await panel.flush();

  // Before authoritative reload completes, dialog stays open and no success toast has fired
  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, true);
  assert.equal(notifications.success.length, 0);

  const reloadDetailReq = findLastRequest(
    (r) => r.method === "GET" && r.url.endsWith(`/${MEMBER_REF}/access`),
  );
  assert.ok(reloadDetailReq);
  const updatedMember = makeDetailEnvelope("member_admin_revocable_with_contextual_and_exception");
  updatedMember.account.version = 4;
  respond(reloadDetailReq, 200, updatedMember);
  await panel.flush();

  const reloadSummaryReq = findLastRequest(
    (r) => r.method === "GET" && r.url.startsWith("/api/admin/access/accounts-summary?"),
  );
  assert.ok(reloadSummaryReq);
  respond(reloadSummaryReq, 200, { ok: true, list: makeSummaryList() });
  await panel.flush();

  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, false);
  assert.equal(notifications.success.length, 1);
  ws.unmount();
});

test("503 uncertain outcome locks close & preserves exact Idempotency-Key; failed reconcile clears reconciling while keeping lock until retry succeeds", async () => {
  const { ws, panel } = await mountWorkspaceOnGlobalRoles(MEMBER_REF, true);

  findButton(panel, "Thu hồi vai trò").props.onClick();
  await panel.flush();
  findNode(panel, (n) => n.props?.id === "role-mutation-reason-input").props.onChange({
    target: { value: "Thu hồi quyền admin tạm thời" },
  });
  await panel.flush();

  const submitForm = () => findDialogForm(panel);
  submitForm().props.onSubmit({ preventDefault() {} });
  await panel.flush();

  const delReq1 = findLastRequest((r) => r.method === "DELETE");
  assert.ok(delReq1);
  const firstKey = delReq1.options.headers["Idempotency-Key"];
  const firstBody = delReq1.options.body;

  respond(delReq1, 503, { ok: false, error: { code: "AUTHZ_UNAVAILABLE" } });
  await panel.flush();

  // Uncertain lock: Cancel & FormDialog closeDisabled must be true; Hủy click must not close
  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.closeDisabled, true);
  assert.equal(findButton(panel, "Hủy").props.disabled, true);
  findButton(panel, "Hủy").props.onClick();
  await panel.flush();
  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, true);

  // Reconcile attempt fails with 503 -> must clear reconciling (not stuck!) while keeping uncertain lock & retry
  findButton(panel, "Tải lại đối chiếu").props.onClick();
  await panel.flush();
  const failedReconcileReq = findLastRequest(
    (r) => r.method === "GET" && r.url.endsWith(`/${MEMBER_REF}/access`),
  );
  assert.ok(failedReconcileReq);
  respond(failedReconcileReq, 503, { ok: false, error: { code: "AUTHZ_UNAVAILABLE" } });
  await panel.flush();

  assert.equal(findButton(panel, "Tải lại đối chiếu").props.disabled, false);
  assert.equal(findButton(panel, "Hủy").props.disabled, true);

  // Retrying submission MUST reuse exact same Idempotency-Key & body
  submitForm().props.onSubmit({ preventDefault() {} });
  await panel.flush();
  const delReq2 = findLastRequest((r) => r.method === "DELETE");
  assert.ok(delReq2);
  assert.equal(delReq2.options.headers["Idempotency-Key"], firstKey);
  assert.equal(delReq2.options.body, firstBody);

  respond(delReq2, 200, {
    ok: true,
    ...cloneJson(fixtures.responses.mutations.revoke_global_role_ok),
  });
  await panel.flush();
  await drainDefaultReads(panel, ws, {
    detailMap: {
      [MEMBER_REF]: {
        ...makeDetailEnvelope("member_admin_revocable_with_contextual_and_exception"),
        account: {
          ...fixtures.responses.account_access_detail.member_admin_revocable_with_contextual_and_exception.account,
          version: 5,
        },
      },
    },
  });

  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, false);
  assert.equal(notifications.success.length, 1);
  ws.unmount();
});

test("409 VERSION_CONFLICT keeps conflict lock without attaching new version to old draft until explicit reconcile; stale replay suppresses false success", async () => {
  const { ws, panel } = await mountWorkspaceOnGlobalRoles(OWNER_REF, true);

  // Test 409 OCC first
  findButton(panel, "Cấp vai trò toàn cục").props.onClick();
  await panel.flush();
  findNode(panel, (n) => n.props?.id === "assign-global-role-select").props.onChange({
    target: { value: "HR_OPERATOR" },
  });
  findNode(panel, (n) => n.props?.id === "role-mutation-reason-input").props.onChange({
    target: { value: "Cấp HR Operator từ v4" },
  });
  await panel.flush();

  const submitForm = () => findDialogForm(panel);
  submitForm().props.onSubmit({ preventDefault() {} });
  await panel.flush();

  const post1 = findLastRequest((r) => r.method === "POST");
  assert.equal(JSON.parse(post1.options.body).expected_version, 4);
  respond(post1, 409, cloneJson(fixtures.errors.VERSION_CONFLICT));
  await panel.flush();

  // Conflict-locked: extra submit emits ZERO POSTs
  const postCountBefore = requests.filter((r) => r.method === "POST").length;
  submitForm().props.onSubmit({ preventDefault() {} });
  await panel.flush();
  assert.equal(requests.filter((r) => r.method === "POST").length, postCountBefore);

  // Explicit reconcile brings fresh version 5 from server & unlocks for user review
  findButton(panel, "Tải lại đối chiếu").props.onClick();
  await panel.flush();
  const ownerV5 = makeDetailEnvelope("canonical_owner_protected");
  ownerV5.account.version = 5;
  await drainDefaultReads(panel, ws, { detailMap: { [OWNER_REF]: ownerV5 } });

  // Now submit sends expected_version: 5 with fresh snapshot
  submitForm().props.onSubmit({ preventDefault() {} });
  await panel.flush();
  const post2 = findLastRequest((r) => r.method === "POST");
  assert.equal(JSON.parse(post2.options.body).expected_version, 5);

  // Server replies with stale replayed account_version 4 (< current known 5) -> must suppress close & emit NO success toast!
  const staleReplay = cloneJson(fixtures.responses.mutations.assign_global_role_created);
  staleReplay.account_ref = OWNER_REF;
  staleReplay.account_version = 4;
  staleReplay.replayed = true;
  respond(post2, 200, { ok: true, ...staleReplay });
  await panel.flush();

  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, true);
  assert.equal(notifications.success.length, 0);
  assert.match(textOf(panel.tree), /phiên bản cũ hơn hiện tại/i);

  // Reconciling after staleReplayLocked closes safely with info toast (NEVER false success!)
  findButton(panel, "Tải lại đối chiếu").props.onClick();
  await panel.flush();
  await drainDefaultReads(panel, ws, { detailMap: { [OWNER_REF]: ownerV5 } });
  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, false);
  assert.equal(notifications.success.length, 0);
  assert.equal(notifications.info.length, 1);
  ws.unmount();
});

test("Rollout gates (404 NOT_FOUND & 409 AUTHZ_CUTOVER_NOT_READY) lock global role mutations clearly", async () => {
  for (const [status, errPayload, expectedRegex] of [
    [
      404,
      { ok: false, error: { code: "NOT_FOUND", message: "Not found" } },
      /AUTHZ_ROLE_MUTATIONS_ENABLED|cổng môi trường/i,
    ],
    [
      409,
      cloneJson(fixtures.errors.AUTHZ_CUTOVER_NOT_READY),
      /AUTHZ_CUTOVER_NOT_READY|cutover/i,
    ],
  ]) {
    clearNotifications();
    setupFetchMock();
    const { ws, panel } = await mountWorkspaceOnGlobalRoles(MEMBER_REF, true);

    findButton(panel, "Thu hồi vai trò").props.onClick();
    await panel.flush();
    findNode(panel, (n) => n.props?.id === "role-mutation-reason-input").props.onChange({
      target: { value: "Thử khi cổng chưa mở" },
    });
    await panel.flush();
    findDialogForm(panel).props.onSubmit({ preventDefault() {} });
    await panel.flush();

    respond(findLastRequest((r) => r.method === "DELETE"), status, errPayload);
    await panel.flush();

    assert.match(textOf(panel.tree), expectedRegex);
    findButton(panel, "Hủy").props.onClick();
    await panel.flush();
    assert.equal(findButton(panel, "Cấp vai trò toàn cục").props.disabled, true);
    assert.equal(findButton(panel, "Thu hồi vai trò").props.disabled, true);
    ws.unmount();
  }
});

test("React Strict Mode setup -> cleanup -> setup keeps mountedRef=true across 409, 503 retry, failed reconcile, and unmount safety", async () => {
  const { ws, panel } = await mountWorkspaceOnGlobalRoles(MEMBER_REF, true);

  // Trigger Strict Mode setup -> cleanup -> setup!
  await panel.replayStrictEffects();
  respondDefaultReads();
  await panel.flush();

  findButton(panel, "Thu hồi vai trò").props.onClick();
  await panel.flush();
  findNode(panel, (n) => n.props?.id === "role-mutation-reason-input").props.onChange({
    target: { value: "Kiểm thử Strict Mode" },
  });
  await panel.flush();

  const submitForm = () => findDialogForm(panel);
  submitForm().props.onSubmit({ preventDefault() {} });
  await panel.flush();

  // After 409 conflict: busy must clear so dialog can cancel or reconcile
  respond(findLastRequest((r) => r.method === "DELETE"), 409, cloneJson(fixtures.errors.VERSION_CONFLICT));
  await panel.flush();
  assert.equal(findSubmitButton(panel, "Xác nhận thu hồi").props.loading, false);
  assert.equal(findButton(panel, "Hủy").props.disabled, false);

  findButton(panel, "Tải lại đối chiếu").props.onClick();
  await panel.flush();
  await drainDefaultReads(panel, ws);

  // Network reject -> busy clears, uncertain lock allows retry & reconcile
  submitForm().props.onSubmit({ preventDefault() {} });
  await panel.flush();
  rejectRequest(findLastRequest((r) => r.method === "DELETE"), new Error("network down"));
  await panel.flush();

  assert.equal(findSubmitButton(panel, "Thử gửi lại cùng yêu cầu").props.loading, false);
  assert.equal(findSubmitButton(panel, "Thử gửi lại cùng yêu cầu").props.disabled, false);
  assert.equal(findButton(panel, "Tải lại đối chiếu").props.disabled, false);

  // Failed reconcile clears reconciling without releasing lock
  findButton(panel, "Tải lại đối chiếu").props.onClick();
  await panel.flush();
  rejectRequest(
    findLastRequest((r) => r.method === "GET" && r.url.endsWith(`/${MEMBER_REF}/access`)),
    new Error("offline"),
  );
  await panel.flush();
  assert.equal(findButton(panel, "Tải lại đối chiếu").props.disabled, false);
  assert.equal(findButton(panel, "Hủy").props.disabled, true);

  // Unmount mid-flight request must NOT trigger notifications after unmount
  submitForm().props.onSubmit({ preventDefault() {} });
  await panel.flush();
  const inFlightDelete = findLastRequest((r) => r.method === "DELETE");
  ws.unmount();
  respond(inFlightDelete, 200, {
    ok: true,
    ...cloneJson(fixtures.responses.mutations.revoke_global_role_ok),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(notifications.success.length, 0);
});

async function submitAssignHrOperator(panel, reasonText = "T0 retry verification") {
  findButton(panel, "Cấp vai trò toàn cục").props.onClick();
  await panel.flush();
  findNode(panel, (n) => n.props?.id === "assign-global-role-select").props.onChange({
    target: { value: "HR_OPERATOR" },
  });
  findNode(panel, (n) => n.props?.id === "role-mutation-reason-input").props.onChange({
    target: { value: reasonText },
  });
  await panel.flush();
  findDialogForm(panel).props.onSubmit({ preventDefault() {} });
  await panel.flush();
  return findLastRequest((r) => r.method === "POST");
}

test("R1: GET reconciliation after 503 preserves original Idempotency-Key & expected_version even when version moved (4 -> 6) and role is absent", async () => {
  const { ws, panel } = await mountWorkspaceOnGlobalRoles(OWNER_REF, true);
  const firstPost = await submitAssignHrOperator(panel);
  assert.ok(firstPost);
  const firstKey = firstPost.options.headers["Idempotency-Key"];
  const firstBody = JSON.parse(firstPost.options.body);
  assert.equal(firstBody.expected_version, 4);

  respond(firstPost, 503, { ok: false, error: { code: "AUTHZ_UNAVAILABLE" } });
  await panel.flush();
  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.closeDisabled, true);

  // Case A: GET at v4 still has no HR_OPERATOR (request may still be in flight) -> keeps uncertain lock
  findButton(panel, "Tải lại đối chiếu").props.onClick();
  await panel.flush();
  await drainDefaultReads(panel, ws, {
    detailMap: { [OWNER_REF]: makeDetailEnvelope("canonical_owner_protected") },
  });
  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, true);
  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.closeDisabled, true);
  assert.equal(findButton(panel, "Hủy").props.disabled, true);
  assert.equal(notifications.success.length, 0);

  // Case B: Original POST committed v5, then another Admin revoked HR_OPERATOR at v6 -> GET sees v6 absent
  findButton(panel, "Tải lại đối chiếu").props.onClick();
  await panel.flush();
  const freshV6 = makeDetailEnvelope("canonical_owner_protected");
  freshV6.account.version = 6;
  await drainDefaultReads(panel, ws, { detailMap: { [OWNER_REF]: freshV6 } });

  // Must STILL keep original request locked & NEVER rebase expected_version=4 to 6
  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.closeDisabled, true);
  assert.equal(findButton(panel, "Hủy").props.disabled, true);
  assert.equal(notifications.success.length, 0);

  // Retry sends exact same Idempotency-Key & expected_version=4 (never creates a new grant at v6!)
  findDialogForm(panel).props.onSubmit({ preventDefault() {} });
  await panel.flush();
  const secondPost = findLastRequest((r) => r.method === "POST");
  assert.ok(secondPost);
  assert.equal(secondPost.options.headers["Idempotency-Key"], firstKey);
  assert.equal(secondPost.options.body, firstPost.options.body);
  assert.equal(JSON.parse(secondPost.options.body).expected_version, 4);

  // Server ledger replays old commit from v5 (< current v6) -> stale replay guard triggers cleanly
  const replayedV5 = cloneJson(fixtures.responses.mutations.assign_global_role_created);
  replayedV5.account_ref = OWNER_REF;
  replayedV5.account_version = 5;
  replayedV5.replayed = true;
  replayedV5.assignment.assignment_id = "bbbbbbbb-bbbb-4bbb-8bbb-000000000099";
  replayedV5.assignment.role_code = "HR_OPERATOR";
  replayedV5.assignment.display_name = "Vận hành nhân sự (HR Operator)";
  respond(secondPost, 200, { ok: true, ...replayedV5 });
  await panel.flush();

  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, true);
  assert.equal(notifications.success.length, 0);
  assert.match(textOf(panel.tree), /phiên bản cũ hơn hiện tại/i);
  ws.unmount();
});

test("R1: GET reconciliation after 503 does not falsely celebrate when another Admin added the role; retry confirms via 409/ledger", async () => {
  const { ws, panel } = await mountWorkspaceOnGlobalRoles(OWNER_REF, true);
  const firstPost = await submitAssignHrOperator(panel, "Original request might not have landed");
  const firstKey = firstPost.options.headers["Idempotency-Key"];

  respond(firstPost, 503, { ok: false, error: { code: "AUTHZ_UNAVAILABLE" } });
  await panel.flush();

  // Another Admin independently granted HR_OPERATOR at v5
  findButton(panel, "Tải lại đối chiếu").props.onClick();
  await panel.flush();
  const otherAdminV5 = makeDetailEnvelope("canonical_owner_protected");
  otherAdminV5.account.version = 5;
  otherAdminV5.assigned_global_roles.push({
    assignment_id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000088",
    role_code: "HR_OPERATOR",
    display_name: "Vận hành nhân sự (HR Operator)",
    source_kind: "ADMIN_ASSIGNMENT",
    reason: "Granted by another admin",
    started_at: "2026-11-14T08:30:00+07:00",
    ended_at: null,
    ended_reason: null,
    assigned_by_display: "Other Admin",
    is_effective: true,
    inactive_reason: null,
    is_protected: false,
    can_revoke: true,
    cannot_revoke_reason: null,
  });
  await drainDefaultReads(panel, ws, { detailMap: { [OWNER_REF]: otherAdminV5 } });

  // MUST NOT infer "request succeeded" and MUST keep Idempotency-Key locked until retry
  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, true);
  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.closeDisabled, true);
  assert.equal(notifications.success.length, 0);

  // Retry confirms original request did not run (server returns 409 VERSION_CONFLICT at v5)
  findDialogForm(panel).props.onSubmit({ preventDefault() {} });
  await panel.flush();
  const retryPost = findLastRequest((r) => r.method === "POST");
  assert.ok(retryPost);
  assert.equal(retryPost.options.headers["Idempotency-Key"], firstKey);
  assert.equal(JSON.parse(retryPost.options.body).expected_version, 4);

  respond(retryPost, 409, cloneJson(fixtures.errors.VERSION_CONFLICT));
  await panel.flush();
  assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.closeDisabled, false);
  assert.equal(findButton(panel, "Hủy").props.disabled, false);
  assert.equal(notifications.success.length, 0);
  ws.unmount();
});

test("R2: parallel 403/401 on catalog during reconcile GET invalidates epoch so aborted summary GET never reopens dialog", async () => {
  for (const status of [403, 401]) {
    clearNotifications();
    setupFetchMock();
    const panel = mount(AccountGlobalRolesPanel, {
      canManageGlobalRoles: true,
      selectedAccountRef: OWNER_REF,
      onSelectedAccountRefChange() {},
    });
    await panel.flush();

    const catalog = findLastRequest((r) => r.url === "/api/admin/access/roles");
    assert.ok(catalog);
    for (const req of requests) {
      if (req.settled || req === catalog) continue;
      if (req.url.includes("/accounts-summary?")) {
        respond(req, 200, { ok: true, list: makeSummaryList() });
      } else if (req.url.endsWith(`/${OWNER_REF}/access`)) {
        respond(req, 200, makeDetailEnvelope("canonical_owner_protected"));
      }
    }
    await panel.flush();

    const post = await submitAssignHrOperator(panel);
    respond(post, 503, { ok: false, error: { code: "AUTHZ_UNAVAILABLE" } });
    await panel.flush();

    findButton(panel, "Tải lại đối chiếu").props.onClick();
    await panel.flush();

    const reconcileDetail = findLastRequest(
      (r) => r.method === "GET" && r.url.endsWith(`/${OWNER_REF}/access`),
    );
    assert.ok(reconcileDetail);
    respond(reconcileDetail, 200, makeDetailEnvelope("canonical_owner_protected"));
    await panel.flush();

    const reconcileSummary = findLastRequest((r) => r.url.includes("/accounts-summary?"));
    assert.ok(reconcileSummary);

    // Parallel session loss via catalog metadata fetch
    respond(catalog, status, {
      ok: false,
      error: { code: status === 401 ? "UNAUTHENTICATED" : "AUTHZ_FORBIDDEN" },
    });
    await panel.flush();
    assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, false);
    assert.equal(reconcileSummary.signal.aborted, true);

    rejectRequest(reconcileSummary, new DOMException("Aborted", "AbortError"));
    await panel.flush();

    assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, false);
    assert.equal(notifications.success.length, 0);
    assert.match(
      textOf(panel.tree),
      status === 401 ? /Phiên đăng nhập đã hết hiệu lực/ : /Không có quyền truy cập quản trị vai trò toàn cục/,
    );
    panel.unmount();
  }
});

test("R2: parallel 403/401 during post-apply reload prevents dialog/toast/data restoration after session loss", async () => {
  for (const status of [403, 401]) {
    clearNotifications();
    setupFetchMock();
    const panel = mount(AccountGlobalRolesPanel, {
      canManageGlobalRoles: true,
      selectedAccountRef: OWNER_REF,
      onSelectedAccountRefChange() {},
    });
    await panel.flush();

    const catalog = findLastRequest((r) => r.url === "/api/admin/access/roles");
    assert.ok(catalog);
    for (const req of requests) {
      if (req.settled || req === catalog) continue;
      if (req.url.includes("/accounts-summary?")) {
        respond(req, 200, { ok: true, list: makeSummaryList() });
      } else if (req.url.endsWith(`/${OWNER_REF}/access`)) {
        respond(req, 200, makeDetailEnvelope("canonical_owner_protected"));
      }
    }
    await panel.flush();

    const post = await submitAssignHrOperator(panel, "Post-apply epoch race");
    const created = cloneJson(fixtures.responses.mutations.assign_global_role_created);
    created.account_ref = OWNER_REF;
    created.account_version = 5;
    created.assignment.role_code = "HR_OPERATOR";
    created.assignment.display_name = "Vận hành nhân sự (HR Operator)";
    respond(post, 201, { ok: true, ...created });
    await panel.flush();

    const postApplyDetail = findLastRequest(
      (r) => r.method === "GET" && r.url.endsWith(`/${OWNER_REF}/access`),
    );
    assert.ok(postApplyDetail);
    const updatedOwner = makeDetailEnvelope("canonical_owner_protected");
    updatedOwner.account.version = 5;
    respond(postApplyDetail, 200, updatedOwner);
    await panel.flush();

    const postApplySummary = findLastRequest((r) => r.url.includes("/accounts-summary?"));
    assert.ok(postApplySummary);

    respond(catalog, status, {
      ok: false,
      error: { code: status === 401 ? "UNAUTHENTICATED" : "AUTHZ_FORBIDDEN" },
    });
    await panel.flush();
    assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, false);
    assert.equal(postApplySummary.signal.aborted, true);

    rejectRequest(postApplySummary, new DOMException("Aborted", "AbortError"));
    await panel.flush();

    assert.equal(findNode(panel, (n) => n.type?.name === "FormDialog").props.open, false);
    assert.equal(notifications.success.length, 0);
    assert.match(
      textOf(panel.tree),
      status === 401 ? /Phiên đăng nhập đã hết hiệu lực/ : /Không có quyền truy cập quản trị vai trò toàn cục/,
    );
    panel.unmount();
  }
});

test("WP6 UI source satisfies a11y, responsive table, contrast/theme guard, and zero authority/identity anti-patterns", () => {
  const files = [
    "src/components/admin/effective-access-workspace.tsx",
    "src/components/admin/account-global-roles-panel.tsx",
    "src/components/admin/account-access-workspace.tsx",
  ];
  for (const rel of files) {
    const src = readFileSync(path.join(repoRoot, rel), "utf8");
    assert.doesNotMatch(src, /indigo-\d+|transition-all|text-primary-foreground/, `${rel} theme guard`);
    assert.doesNotMatch(src, /console\.(log|warn|error)|dangerouslySetInnerHTML/, `${rel} hygiene`);
    assert.doesNotMatch(src, /@gmail\.com|@hrp|owner@|nv\.minh/i, `${rel} hardcoded identity`);
  }

  const effSrc = readFileSync(
    path.join(repoRoot, "src/components/admin/effective-access-workspace.tsx"),
    "utf8",
  );
  assert.match(effSrc, /<label htmlFor="eff-search-input">/);
  assert.match(effSrc, /role="region"/);
  assert.match(effSrc, /tabIndex=\{0\}/);
  assert.match(effSrc, /DATA_TABLE_CLASS/);

  const grSrc = readFileSync(
    path.join(repoRoot, "src/components/admin/account-global-roles-panel.tsx"),
    "utf8",
  );
  assert.match(grSrc, /<label htmlFor="assign-global-role-select">/);
  assert.match(grSrc, /<label htmlFor="role-mutation-reason-input">/);
  assert.match(grSrc, /aria-describedby/);
  assert.match(grSrc, /role="region"/);
  assert.match(grSrc, /tabIndex=\{0\}/);
  assert.match(grSrc, /DATA_TABLE_CLASS/);

  const wsSrc = readFileSync(
    path.join(repoRoot, "src/components/admin/account-access-workspace.tsx"),
    "utf8",
  );
  assert.match(wsSrc, /role="tablist"/);
  assert.match(wsSrc, /role="tab"/);
  assert.match(wsSrc, /role="tabpanel"/);
  assert.match(wsSrc, /after:border-b-\[3px\]/);
  assert.doesNotMatch(wsSrc, /aria-controls/);
});
