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
      const slot = { deps, cleanup: prev?.cleanup ?? null };
      instance.slots[index] = slot;
      instance.pendingEffects.push(() => {
        if (typeof slot.cleanup === "function") {
          const runCleanup = slot.cleanup;
          slot.cleanup = null;
          runCleanup();
        }
        if (instance.unmounted) return;
        const cleanup = effect();
        slot.cleanup = typeof cleanup === "function" ? cleanup : null;
        instance.cleanups.add(() => {
          if (typeof slot.cleanup === "function") {
            const fn = slot.cleanup;
            slot.cleanup = null;
            fn();
          }
        });
      });
    }
  },
  useId() {
    return reactShim.useRef(`wp4-test-id-${activeHookInstance.id}-${activeHookInstance.cursor}`)
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

function collectNodes(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, out);
  } else if (node && typeof node === "object") {
    if (node.type && node.props) {
      out.push(node);
      for (const value of Object.values(node.props)) {
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
  if (node.props) return textOf(node.props.children);
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

function rejectNetwork(req, err = new TypeError("Failed to fetch")) {
  assert.ok(req && !req.settled, `Expected unsettled request to reject (${req?.url})`);
  req.settled = true;
  req.reject(err);
}

function findLastRequest(predicate) {
  for (let i = requests.length - 1; i >= 0; i -= 1) {
    if (predicate(requests[i])) return requests[i];
  }
  return null;
}

function clearNotifications() {
  notifications.success.length = 0;
  notifications.error.length = 0;
  notifications.warning.length = 0;
  notifications.info.length = 0;
}

// Shared valid UUIDs & fixtures matching strict WP3B contracts
const AS_OF = "2026-11-14T08:00:00Z";
const AUTH_DATE = "2026-11-14";

const DEPT_OPS_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEPT_SALES_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PERSON_A_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_B_ID = "22222222-2222-4222-8222-222222222222";
const MEMBERSHIP_A_ID = "33333333-3333-4333-8333-333333333333";
const HEAD_A_ID = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_A_REF = "55555555-5555-4555-8555-555555555555";
const RECRUITER_A_ID = "77777777-7777-4777-8777-777777777777";

function makeDept(overrides = {}) {
  return {
    department_id: DEPT_OPS_ID,
    system_key: null,
    code: "OPS_CUSTOM",
    name: "Vận hành Miền Nam",
    is_active: true,
    version: 2,
    membership_mode: "MANAGED_MEMBERSHIP",
    default_policy_code: "ORGANIZATIONAL_MEMBERSHIP_ONLY",
    active_member_count: 1,
    team_count: null,
    active_team_count: null,
    active_head: null,
    created_at: AS_OF,
    updated_at: AS_OF,
    ...overrides,
  };
}

function makeDeptListEnvelope(departments = [makeDept(), makeDept({ department_id: DEPT_SALES_ID, code: "CSKH", name: "Chăm sóc KH" })]) {
  return {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    departments,
  };
}

function makeDeptDetailEnvelope(dept = makeDept()) {
  return {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    department: dept,
  };
}

function makePersonDetail(overrides = {}) {
  return {
    person_id: PERSON_A_ID,
    employee_code: "NS-001",
    full_name: "Tên cũ A",
    status: "ACTIVE",
    joined_on: "2026-10-01",
    recruiter_id: null,
    version: 2,
    active_account_link: null,
    active_department: null,
    department_history: [],
    head_assignments: [],
    ...overrides,
  };
}

function makePersonSummary(overrides = {}) {
  const full = makePersonDetail(overrides);
  delete full.department_history;
  delete full.head_assignments;
  return full;
}

function makePersonListEnvelope(persons = [makePersonSummary()], filter = {}) {
  return {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    search: filter.search ?? null,
    status: filter.status ?? "active",
    department_id: filter.department_id ?? null,
    link_state: filter.link_state ?? "all",
    page: filter.page ?? 1,
    page_size: filter.page_size ?? 25,
    total: filter.total ?? persons.length,
    has_more: false,
    persons,
  };
}

function makeHeadsEnvelope(departmentId = DEPT_OPS_ID, activeHead = null, history = []) {
  return {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    department_id: departmentId,
    include_history: true,
    active_head: activeHead,
    page: 1,
    page_size: 25,
    total: history.length,
    has_more: false,
    history,
  };
}

function makeHeadProjection(overrides = {}) {
  return {
    head_assignment_id: HEAD_A_ID,
    department_id: DEPT_OPS_ID,
    person_id: PERSON_A_ID,
    employee_code: "NS-001",
    full_name: "Tên cũ A",
    started_at: AS_OF,
    ended_at: null,
    source_kind: "ADMIN_MUTATION",
    evidence_date: null,
    version: 2,
    ...overrides,
  };
}

function makePersonMemberProjection(overrides = {}) {
  return {
    membership_id: MEMBERSHIP_A_ID,
    department_id: DEPT_OPS_ID,
    person_id: PERSON_A_ID,
    employee_code: "NS-001",
    full_name: "Tên cũ A",
    person_status: "ACTIVE",
    person_version: 2,
    active_account_ref: null,
    is_department_head: false,
    started_at: AS_OF,
    ended_at: null,
    source_kind: "ADMIN_MUTATION",
    evidence_date: null,
    version: 2,
    ...overrides,
  };
}

function makeDeptMembersEnvelope(
  departmentId = DEPT_OPS_ID,
  memberships = [makePersonMemberProjection()],
  search = null,
) {
  return {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    department_id: departmentId,
    status: "active",
    search,
    page: 1,
    page_size: 25,
    total: memberships.length,
    has_more: false,
    memberships,
  };
}

function makeAccount(overrides = {}) {
  return {
    account_ref: ACCOUNT_A_REF,
    display_name: "Nguyễn Văn An",
    login_id: "annv",
    enabled: true,
    version: 2,
    account_type: "NORMAL",
    active_person_link: null,
    ...overrides,
  };
}

function makeAccountListEnvelope(accounts = [makeAccount()], query = {}) {
  return {
    ok: true,
    list: {
      search: query.search ?? null,
      enabled: query.enabled ?? "all",
      page: query.page ?? 1,
      page_size: 25,
      total: query.total ?? accounts.length,
      accounts,
    },
  };
}

function makePersonnelListEnvelope(personnel, search = null) {
  return {
    ok: true,
    list: {
      authorization_date: AUTH_DATE,
      include_inactive: true,
      search,
      page: 1,
      page_size: 25,
      total: personnel.length,
      personnel,
    },
  };
}

const { PersonListManager } = repoRequire("./src/components/admin/person-list-manager.tsx");
const { PersonDetailManager } = repoRequire("./src/components/admin/person-detail-manager.tsx");
const { DepartmentListManager } = repoRequire("./src/components/admin/department-list-manager.tsx");
const { DepartmentDetailManager } = repoRequire(
  "./src/components/admin/department-detail-manager.tsx",
);
const { AccountManager } = repoRequire("./src/components/admin/account-manager.tsx");
const { DepartmentSelectPicker, PersonSearchPicker, AccountSearchPicker, RecruiterConfirmPicker } =
  repoRequire("./src/components/admin/org-entity-picker.tsx");

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
// Finding 1 — OCC baseline snapshot & conflict lock across 409 -> reload
// ===========================================================================

test("Finding 1 [PersonDetailManager]: v2 -> Admin B v3 -> 409 -> failed reload keeps lock -> reload v3 closes/resets without attaching v3 to old draft", async () => {
  const h = mount(PersonDetailManager, { personId: PERSON_A_ID });
  await h.flush();
  respond(requests[0], 200, {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    person: makePersonDetail({ version: 2, full_name: "Tên cũ A" }),
  });
  await h.flush();

  findButton(h, "Sửa hồ sơ").props.onClick();
  await h.flush();
  findNode(h, (n) => n.props?.id === "person-detail-reason").props.onChange({
    target: { value: "Sửa theo draft v2" },
  });
  await h.flush();

  const submitForm = () => findNode(h, (n) => n.type === "form");
  submitForm().props.onSubmit({ preventDefault() {} });
  await h.flush();

  const patchReq = findLastRequest((r) => r.method === "PATCH");
  assert.ok(patchReq);
  assert.equal(JSON.parse(patchReq.options.body).expected_person_version, 2);

  // Server rejects stale version 2 (Admin B saved version 3)
  respond(patchReq, 409, { ok: false, code: "VERSION_CONFLICT" });
  await h.flush();

  // Attempting to resubmit while conflictLocked must emit ZERO PATCH requests
  const reqCountBeforeBlockedSubmit = requests.length;
  submitForm().props.onSubmit({ preventDefault() {} });
  await h.flush();
  assert.equal(requests.length, reqCountBeforeBlockedSubmit);

  // Clicking Tải bản mới nhất while GET fails (503) must keep dialog open & locked
  findButton(h, "Tải bản mới nhất").props.onClick();
  await h.flush();
  const failedGet = findLastRequest((r) => r.method === "GET");
  respond(failedGet, 503, { ok: false, code: "ORG_UNAVAILABLE" });
  await h.flush();
  assert.equal(findNode(h, (n) => n.type?.name === "FormDialog").props.open, true);
  const reqCountAfterFailedReload = requests.length;
  submitForm().props.onSubmit({ preventDefault() {} });
  await h.flush();
  assert.equal(requests.length, reqCountAfterFailedReload);

  // Successful reload returns v3 from Admin B -> dialog resets/closes, never sends v3 + "Tên cũ A"
  findButton(h, "Tải bản mới nhất").props.onClick();
  await h.flush();
  const okGet = findLastRequest((r) => r.method === "GET");
  respond(okGet, 200, {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    person: makePersonDetail({ version: 3, full_name: "Tên mới do Admin B lưu" }),
  });
  await h.flush();

  assert.equal(findNode(h, (n) => n.type?.name === "FormDialog").props.open, false);

  // Reopen edit dialog: draft starts from v3 "Tên mới do Admin B lưu", never "Tên cũ A"
  findButton(h, "Sửa hồ sơ").props.onClick();
  await h.flush();
  assert.equal(
    findNode(h, (n) => n.props?.id === "edit-person-full-name").props.value,
    "Tên mới do Admin B lưu",
  );
  findNode(h, (n) => n.props?.id === "person-detail-reason").props.onChange({
    target: { value: "Cập nhật hợp lệ trên v3" },
  });
  await h.flush();
  findNode(h, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await h.flush();

  const freshPatch = findLastRequest((r) => r.method === "PATCH");
  const freshBody = JSON.parse(freshPatch.options.body);
  assert.equal(freshBody.expected_person_version, 3);
  assert.equal(freshBody.full_name, "Tên mới do Admin B lưu");
});

test("Finding 1 [DepartmentDetailManager Header/HEAD/Members]: 409 locks submit until authoritative reload, and reloads close/reset instead of attaching v3 to v2 draft", async () => {
  const deptV2 = makeDept({
    version: 2,
    name: "Tên phòng v2",
    active_head: {
      head_assignment_id: HEAD_A_ID,
      person_id: PERSON_A_ID,
      employee_code: "NS-001",
      full_name: "Tên cũ A",
      started_at: AS_OF,
      version: 2,
    },
  });
  const detailHandle = mount(DepartmentDetailManager, { departmentId: DEPT_OPS_ID });
  await detailHandle.flush();
  respond(requests[0], 200, makeDeptDetailEnvelope(deptV2));
  await detailHandle.flush();

  // Mount real header card with real parent callbacks
  const headerCard = await syncChildFromTree(detailHandle, "DepartmentGovernanceHeaderCard", null);
  const headSection = await syncChildFromTree(detailHandle, "DepartmentHeadManagementSection", null);
  const membersSection = await syncChildFromTree(
    detailHandle,
    "DepartmentPersonMembershipsSection",
    null,
  );
  // Settle initial HEAD + Memberships GETs
  const headGet = findLastRequest((r) => r.url.includes("/head?"));
  const membersGet = findLastRequest((r) => r.url.includes("/memberships?"));
  respond(
    headGet,
    200,
    makeHeadsEnvelope(DEPT_OPS_ID, deptV2.active_head, [makeHeadProjection()]),
  );
  respond(membersGet, 200, makeDeptMembersEnvelope(DEPT_OPS_ID));
  await headSection.flush();
  await membersSection.flush();

  // 1a) Header rename v2 -> parent background updates to v3 -> submit still uses frozen v2 -> 409 -> reload closes
  findButton(headerCard, "Đổi tên").props.onClick();
  await headerCard.flush();
  findNode(headerCard, (n) => n.type === "input").props.onChange({
    target: { value: "Tên nháp cũ v2" },
  });
  findNode(headerCard, (n) => n.type === "textarea").props.onChange({
    target: { value: "Đổi tên phòng ban" },
  });
  await headerCard.flush();

  // Simulate background parent refresh to version 3 while header rename dialog is open
  await headerCard.rerender({
    ...headerCard.props,
    department: makeDept({ version: 3, name: "Tên phòng Admin B lưu ở v3" }),
  });
  findNode(headerCard, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await headerCard.flush();
  const headerPatch = findLastRequest((r) => r.method === "PATCH");
  assert.equal(JSON.parse(headerPatch.options.body).expected_department_version, 2);

  respond(headerPatch, 409, { ok: false, code: "VERSION_CONFLICT" });
  await headerCard.flush();
  // Blocked while conflictLocked
  const beforeHeaderBlocked = requests.length;
  findNode(headerCard, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await headerCard.flush();
  assert.equal(requests.length, beforeHeaderBlocked);

  // Reconcile GET succeeds -> resets/closes dialog cleanly
  findButton(headerCard, "Tải lại để đối chiếu").props.onClick();
  await headerCard.flush();
  const reconcileDetailReq = findLastRequest(
    (r) => r.method === "GET" && r.url === `/api/admin/departments/${DEPT_OPS_ID}`,
  );
  respond(
    reconcileDetailReq,
    200,
    makeDeptDetailEnvelope(makeDept({ version: 3, name: "Tên phòng Admin B lưu ở v3" })),
  );
  await headerCard.flush();
  assert.equal(
    findNode(headerCard, (n) => n.props?.dataTestId === "department-header-dialog").props.open,
    false,
  );

  // 1b) HEAD end assignment v2 -> 409 -> reload closes/resets
  findButton(headSection, "Kết thúc chức danh Trưởng phòng").props.onClick();
  await headSection.flush();
  findNode(headSection, (n) => n.type === "textarea").props.onChange({
    target: { value: "Miễn nhiệm trưởng phòng" },
  });
  await headSection.flush();
  findNode(headSection, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await headSection.flush();
  const endHeadPost = findLastRequest((r) => r.url.endsWith("/head/end"));
  assert.equal(JSON.parse(endHeadPost.options.body).expected_department_version, 2);
  respond(endHeadPost, 409, { ok: false, code: "VERSION_CONFLICT" });
  await headSection.flush();

  const beforeHeadBlocked = requests.length;
  findNode(headSection, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await headSection.flush();
  assert.equal(requests.length, beforeHeadBlocked);

  findButton(headSection, "Tải lại để đối chiếu").props.onClick();
  await headSection.flush();
  const headReloadDetail = findLastRequest(
    (r) => r.method === "GET" && r.url === `/api/admin/departments/${DEPT_OPS_ID}`,
  );
  const headReloadList = findLastRequest((r) => r.method === "GET" && r.url.includes("/head?"));
  respond(headReloadDetail, 200, makeDeptDetailEnvelope(makeDept({ version: 3, active_head: null })));
  respond(headReloadList, 200, makeHeadsEnvelope(DEPT_OPS_ID, null, []));
  await headSection.flush();
  assert.equal(
    findNode(headSection, (n) => n.props?.dataTestId === "department-head-dialog").props.open,
    false,
  );

  // 1c) Person member end v2 -> 409 -> reload resets/closes
  findButton(membersSection, "Kết thúc thành viên").props.onClick();
  await membersSection.flush();
  findNode(membersSection, (n) => n.type === "textarea").props.onChange({
    target: { value: "Kết thúc thành viên" },
  });
  await membersSection.flush();
  const memberDlgForm = () => {
    const memberDlg = findNode(
      membersSection,
      (n) => n.props?.dataTestId === "department-person-member-dialog",
    );
    const form = collectNodes(memberDlg).find((n) => n.type === "form");
    assert.ok(form);
    return form;
  };
  memberDlgForm().props.onSubmit({ preventDefault() {} });
  await membersSection.flush();
  const endMemberPost = findLastRequest((r) =>
    r.url.includes(`/memberships/${MEMBERSHIP_A_ID}/end`),
  );
  assert.equal(JSON.parse(endMemberPost.options.body).expected_person_version, 2);
  respond(endMemberPost, 409, { ok: false, code: "VERSION_CONFLICT" });
  await membersSection.flush();

  const beforeMemberBlocked = requests.length;
  memberDlgForm().props.onSubmit({ preventDefault() {} });
  await membersSection.flush();
  assert.equal(requests.length, beforeMemberBlocked);

  findButton(membersSection, "Tải lại để đối chiếu").props.onClick();
  await membersSection.flush();
  const memberReloadDetail = findLastRequest(
    (r) => r.method === "GET" && r.url === `/api/admin/departments/${DEPT_OPS_ID}`,
  );
  const memberReloadList = findLastRequest(
    (r) => r.method === "GET" && r.url.includes("/memberships?"),
  );
  respond(memberReloadDetail, 200, makeDeptDetailEnvelope(makeDept({ version: 3 })));
  respond(memberReloadList, 200, makeDeptMembersEnvelope(DEPT_OPS_ID, []));
  await membersSection.flush();
  assert.equal(
    findNode(membersSection, (n) => n.props?.dataTestId === "department-person-member-dialog").props
      .open,
    false,
  );
});

test("Finding 1 [AccountManager AccountOrgDialogs]: freezes snapshot version, blocks 409 resubmit until authoritative GET succeeds, and preserves RECRUITER_LINK_MISMATCH step 2", async () => {
  const accV2 = makeAccount({ version: 2, account_type: "NORMAL", active_person_link: null });
  const am = mount(AccountManager);
  await am.flush();

  const reclassifyReq = findLastRequest((r) => r.url.endsWith("/reclassify"));
  const listReq = findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?"));
  respond(reclassifyReq, 200, { ok: true, reclassified: { reclassified: 0, purged: 0, deleted: 0 } });
  respond(listReq, 200, makeAccountListEnvelope([accV2]));
  await am.flush();

  // Open classification dialog
  findButton(am, "Phân loại").props.onClick();
  await am.flush();
  let orgDialog = await syncChildFromTree(am, "AccountOrgDialogs", null);
  assert.equal(orgDialog.props.operation.kind, "classification");

  findNode(orgDialog, (n) => n.type === "select").props.onChange({
    target: { value: "SHARED" },
  });
  findNode(orgDialog, (n) => n.type === "textarea").props.onChange({
    target: { value: "Đổi sang SHARED ở v2" },
  });
  await orgDialog.flush();

  // Background list refresh updates account version to 3 -> open dialog must STILL use frozen v2!
  findNode(am, (n) => n.type === "select").props.onChange({ target: { value: "true" } });
  await am.flush();
  const bgListGet = findLastRequest((r) => r.method === "GET" && r.url.includes("enabled=true"));
  respond(bgListGet, 200, makeAccountListEnvelope([makeAccount({ version: 3 })], { enabled: "true" }));
  await am.flush();
  orgDialog = await syncChildFromTree(am, "AccountOrgDialogs", orgDialog);
  findNode(orgDialog, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await orgDialog.flush();

  const classPost = findLastRequest((r) => r.url.endsWith("/classification"));
  assert.equal(JSON.parse(classPost.options.body).expected_account_version, 2);

  // Server responds 409 VERSION_CONFLICT -> dialog locks submit
  respond(classPost, 409, { ok: false, code: "VERSION_CONFLICT" });
  await orgDialog.flush();

  const beforeConflictResubmit = requests.length;
  findNode(orgDialog, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await orgDialog.flush();
  assert.equal(requests.length, beforeConflictResubmit);

  // Failed reload keeps conflictLocked + dialog open
  findButton(orgDialog, "Tải lại dữ liệu mới nhất").props.onClick();
  await orgDialog.flush();
  const failedReloadGet = findLastRequest((r) => r.method === "GET");
  respond(failedReloadGet, 500, { ok: false });
  await orgDialog.flush();
  assert.equal(
    findNode(orgDialog, (n) => n.props?.dataTestId === "account-org-dialog").props.open,
    true,
  );
  const beforeSecondBlocked = requests.length;
  findNode(orgDialog, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await orgDialog.flush();
  assert.equal(requests.length, beforeSecondBlocked);

  // Authoritative reload GET succeeds with v3 -> closes/resets cleanly
  findButton(orgDialog, "Tải lại dữ liệu mới nhất").props.onClick();
  await orgDialog.flush();
  const okReloadGet = findLastRequest((r) => r.method === "GET");
  respond(okReloadGet, 200, makeAccountListEnvelope([makeAccount({ version: 3 })], { enabled: "true" }));
  await orgDialog.flush();
  await am.flush();
  assert.equal(componentNode(am, "AccountOrgDialogs").props.operation, null);

  // Now verify RECRUITER_LINK_MISMATCH still allows step 2 confirmation (not treated as conflictLocked!)
  findButton(am, "Liên kết người").props.onClick();
  await am.flush();
  orgDialog = await syncChildFromTree(am, "AccountOrgDialogs", null);
  const personPicker = componentNode(orgDialog, "PersonSearchPicker");
  personPicker.props.onSelect(makePersonSummary({ version: 4 }));
  findNode(orgDialog, (n) => n.type === "textarea").props.onChange({
    target: { value: "Liên kết hồ sơ" },
  });
  await orgDialog.flush();

  findNode(orgDialog, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await orgDialog.flush();
  const firstLink = findLastRequest((r) => r.url.endsWith("/person-link"));
  assert.equal(JSON.parse(firstLink.options.body).confirmed_recruiter_id, null);

  respond(firstLink, 409, { ok: false, code: "RECRUITER_LINK_MISMATCH" });
  await orgDialog.flush();

  const recruiterPicker = componentNode(orgDialog, "RecruiterConfirmPicker");
  recruiterPicker.props.onSelect({
    recruiter_id: RECRUITER_A_ID,
    display_name: "Nguyễn Văn An",
    personnel_code: "NS-001",
    personnel_position: "STAFF",
    active: true,
    version: 1,
    hrp_valid_from: "2026-01-01",
    revision_count: 1,
    team_names: [],
  });
  await orgDialog.flush();
  findNode(orgDialog, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await orgDialog.flush();
  const confirmedLink = findLastRequest((r) => r.url.endsWith("/person-link"));
  assert.equal(JSON.parse(confirmedLink.options.body).confirmed_recruiter_id, RECRUITER_A_ID);
});

// ===========================================================================
// Finding 2 — 401/403 aborts all in-flight workspace requests & blocks delayed 200
// ===========================================================================

test("Finding 2 [PersonListManager]: 403 aborts sibling list GET + blocks delayed 200 data & mutation success toasts, plus unmount aborts", async () => {
  const h = mount(PersonListManager);
  await h.flush();

  const deptGet = requests.find((r) => r.url.startsWith("/api/admin/departments"));
  const personsGet = requests.find((r) => r.url.startsWith("/api/admin/organization/persons"));
  assert.ok(deptGet && personsGet);

  // Departments returns 403 first -> must abort personsGet and switch to denied immediately
  respond(deptGet, 403, { ok: false, code: "FORBIDDEN" });
  await h.flush();

  assert.equal(personsGet.signal.aborted, true);
  assert.ok(maybeNode(h, (n) => n.props?.title === "Không có quyền truy cập"));
  assert.equal(maybeNode(h, (n) => n.type?.name === "FilterToolbar"), null);

  // Even if delayed HTTP 200 resolves on personsGet after abort/denial, NO person row is rendered
  respond(personsGet, 200, makePersonListEnvelope([makePersonSummary({ full_name: "Tên bí mật" })]));
  await h.flush();

  assert.equal(textOf(h.tree).includes("Tên bí mật"), false);
  assert.ok(maybeNode(h, (n) => n.props?.title === "Không có quyền truy cập"));
  assert.equal(maybeNode(h, (n) => n.type?.name === "FilterToolbar"), null);

  // Test in-flight mutation race with 403 -> delayed mutation 200 must NEVER emit notify.success
  const h2 = mount(PersonListManager);
  await h2.flush();
  const d2 = requests.at(-2);
  const p2 = requests.at(-1);
  respond(d2, 200, makeDeptListEnvelope());
  respond(p2, 200, makePersonListEnvelope());
  await h2.flush();

  findButton(h2, "Tạo hồ sơ nhân sự").props.onClick();
  await h2.flush();
  findNode(h2, (n) => n.props?.id === "create-person-employee-code").props.onChange({
    target: { value: "NS-777" },
  });
  findNode(h2, (n) => n.props?.id === "create-person-full-name").props.onChange({
    target: { value: "Trần Thị B" },
  });
  findNode(h2, (n) => n.props?.id === "create-person-reason").props.onChange({
    target: { value: "Tạo mới" },
  });
  await h2.flush();

  const createForm = findNode(
    h2,
    (n) => n.type === "form" && collectNodes(n).some((c) => c.props?.id === "create-person-full-name"),
  );
  createForm.props.onSubmit({ preventDefault() {} });
  await h2.flush();
  const createPost = findLastRequest((r) => r.method === "POST");
  assert.ok(createPost);

  // Meanwhile filter change triggers a GET that returns 403
  findNode(h2, (n) => n.props?.id === "person-status-filter").props.onChange({
    target: { value: "inactive" },
  });
  await h2.flush();
  const filterGet = findLastRequest((r) => r.method === "GET");
  respond(filterGet, 403, { ok: false, code: "FORBIDDEN" });
  await h2.flush();

  assert.equal(createPost.signal.aborted, true);
  // Delayed 201 resolves on createPost
  respond(createPost, 201, {
    ok: true,
    replayed: false,
    person: makePersonDetail({ employee_code: "NS-777", full_name: "Trần Thị B" }),
  });
  await h2.flush();

  assert.equal(notifications.success.length, 0);
  assert.ok(maybeNode(h2, (n) => n.props?.title === "Không có quyền truy cập"));

  // Unmount with in-flight request aborts it cleanly
  const h3 = mount(PersonListManager);
  await h3.flush();
  const p3 = findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons"));
  h3.unmount();
  assert.equal(p3.signal.aborted, true);
});

test("Finding 2 [AccountManager]: 401/403 on reclassify or org dialog aborts all in-flight workspace fetches, clears list/dialog, and suppresses delayed 200", async () => {
  const am = mount(AccountManager);
  await am.flush();

  const reclassifyReq = findLastRequest((r) => r.url.endsWith("/reclassify"));
  const listReq = findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?"));
  assert.ok(reclassifyReq && listReq);

  // Reclassify gets 403 while listReq is still in flight -> listReq must abort & delayed 200 must NOT render rows
  respond(reclassifyReq, 403, { ok: false, code: "FORBIDDEN" });
  await am.flush();

  assert.equal(listReq.signal.aborted, true);
  assert.ok(maybeNode(am, (n) => n.props?.title === "Không có quyền xem danh sách tài khoản"));

  respond(listReq, 200, makeAccountListEnvelope([makeAccount({ display_name: "Tài khoản Bị Thu Hồi" })]));
  await am.flush();

  assert.equal(textOf(am.tree).includes("Tài khoản Bị Thu Hồi"), false);
  assert.ok(maybeNode(am, (n) => n.props?.title === "Không có quyền xem danh sách tài khoản"));

  // Fresh AccountManager: start org mutation + trigger session loss from delayed list 401
  const am2 = mount(AccountManager);
  await am2.flush();
  respond(
    findLastRequest((r) => r.url.endsWith("/reclassify")),
    200,
    { ok: true, reclassified: { reclassified: 0, purged: 0, deleted: 0 } },
  );
  respond(
    findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?")),
    200,
    makeAccountListEnvelope([makeAccount()]),
  );
  await am2.flush();

  findButton(am2, "Phân loại").props.onClick();
  await am2.flush();
  const orgDialog = await syncChildFromTree(am2, "AccountOrgDialogs", null);
  findNode(orgDialog, (n) => n.type === "select").props.onChange({ target: { value: "SHARED" } });
  findNode(orgDialog, (n) => n.type === "textarea").props.onChange({
    target: { value: "Đổi loại" },
  });
  await orgDialog.flush();

  findNode(orgDialog, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await orgDialog.flush();
  const classPost = findLastRequest((r) => r.url.endsWith("/classification"));
  assert.ok(classPost);

  // Trigger another read via search submit that returns 401
  findNode(am2, (n) => n.type === "input").props.onChange({ target: { value: "find-me" } });
  await am2.flush();
  findNode(am2, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await am2.flush();
  const searchGet = findLastRequest((r) => r.method === "GET" && r.url.includes("search=find-me"));
  respond(searchGet, 401, { ok: false, code: "UNAUTHENTICATED" });
  await am2.flush();

  assert.equal(classPost.signal.aborted, true);
  assert.equal(componentNode(am2, "AccountOrgDialogs").props.operation, null);

  // Delayed 200 on classPost must NOT emit notify.success or reopen rows
  respond(classPost, 200, {
    ok: true,
    replayed: false,
    account: { account_ref: ACCOUNT_A_REF, account_type: "SHARED", version: 3 },
  });
  await am2.flush();
  await orgDialog.flush();

  assert.equal(notifications.success.length, 0);
  assert.ok(maybeNode(am2, (n) => n.props?.title === "Không có quyền xem danh sách tài khoản"));

  // Unmount aborts pending GET
  const am3 = mount(AccountManager);
  await am3.flush();
  const pendingListGet = findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?"));
  am3.unmount();
  assert.equal(pendingListGet.signal.aborted, true);
});

test("Finding 2 [PersonDetail & DepartmentDetail]: 403/entity-switch/unmount invalidates in-flight fetches and suppresses stale data & success toasts", async () => {
  // PersonDetail: in-flight mutation aborted + suppressed when entity changes or 403 fires
  const pd = mount(PersonDetailManager, { personId: PERSON_A_ID });
  await pd.flush();
  const pdGet1 = requests[0];
  respond(pdGet1, 200, {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    person: makePersonDetail(),
  });
  await pd.flush();

  findButton(pd, "Sửa hồ sơ").props.onClick();
  await pd.flush();
  findNode(pd, (n) => n.props?.id === "person-detail-reason").props.onChange({
    target: { value: "Sửa tên" },
  });
  await pd.flush();
  findNode(pd, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await pd.flush();
  const pdPatch = findLastRequest((r) => r.method === "PATCH");

  // Reconcile or prop change to PERSON_B_ID aborts previous generation and gets 403
  await pd.rerender({ personId: PERSON_B_ID });
  assert.equal(pdPatch.signal.aborted, true);
  const pdGet2 = findLastRequest((r) => r.url.endsWith(`/persons/${PERSON_B_ID}`));
  respond(pdGet2, 403, { ok: false, code: "FORBIDDEN" });
  await pd.flush();

  // Delayed 200 on pdPatch from PERSON_A_ID must NEVER emit notify.success or clear denied
  respond(pdPatch, 200, {
    ok: true,
    replayed: false,
    person: makePersonDetail({ version: 3, full_name: "Hồi sinh" }),
  });
  await pd.flush();
  assert.equal(notifications.success.length, 0);
  assert.ok(maybeNode(pd, (n) => n.props?.title === "Không có quyền truy cập"));

  // DepartmentDetail: child HEAD 403 invalidates parent + sibling memberships GET
  const dd = mount(DepartmentDetailManager, { departmentId: DEPT_OPS_ID });
  await dd.flush();
  respond(findLastRequest((r) => r.url.endsWith(`/departments/${DEPT_OPS_ID}`)), 200, makeDeptDetailEnvelope());
  await dd.flush();

  const head = await syncChildFromTree(dd, "DepartmentHeadManagementSection", null);
  const members = await syncChildFromTree(dd, "DepartmentPersonMembershipsSection", null);
  const hGet = findLastRequest((r) => r.url.includes("/head?"));
  const mGet = findLastRequest((r) => r.url.includes("/memberships?"));

  respond(hGet, 403, { ok: false, code: "DEPARTMENT_ACCESS_DENIED" });
  await head.flush();
  await dd.flush();

  assert.equal(mGet.signal.aborted, true);
  assert.ok(maybeNode(dd, (n) => n.props?.title === "Không có quyền truy cập"));
  respond(mGet, 200, makeDeptMembersEnvelope(DEPT_OPS_ID));
  await members.flush();
  await dd.flush();
  assert.equal(textOf(dd.tree).includes("Thành viên Nhân sự nội bộ"), false);

  dd.unmount();
  head.unmount();
  members.unmount();
});

// ===========================================================================
// Finding 3 — Uncertain writes (503 / IDEMPOTENCY_IN_PROGRESS / network error)
// persist payload & key across Đóng / Hủy / Escape & failed reconcile GETs
// ===========================================================================

test("Finding 3 [PersonDetail & PersonList]: uncertain write keeps payload + Idempotency-Key across Hủy/Đóng/Escape & failed reconcile GET", async () => {
  // 3a) PersonListManager create -> network rejection -> Escape / Đóng blocked -> failed GET keeps key -> retry sends exact key
  const pl = mount(PersonListManager);
  await pl.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
  await pl.flush();

  findButton(pl, "Tạo hồ sơ nhân sự").props.onClick();
  await pl.flush();
  findNode(pl, (n) => n.props?.id === "create-person-employee-code").props.onChange({
    target: { value: "NS-901" },
  });
  findNode(pl, (n) => n.props?.id === "create-person-full-name").props.onChange({
    target: { value: "Lê Văn C" },
  });
  findNode(pl, (n) => n.props?.id === "create-person-reason").props.onChange({
    target: { value: "Tuyển mới" },
  });
  await pl.flush();
  findNode(
    pl,
    (n) => n.type === "form" && collectNodes(n).some((c) => c.props?.id === "create-person-full-name"),
  ).props.onSubmit({ preventDefault() {} });
  await pl.flush();

  const createReq1 = findLastRequest((r) => r.method === "POST");
  const key1 = createReq1.options.headers["Idempotency-Key"];
  const body1 = createReq1.options.body;
  rejectNetwork(createReq1);
  await pl.flush();

  const createDialog = () => findNode(pl, (n) => n.type?.name === "FormDialog");
  assert.equal(createDialog().props.closeDisabled, true);
  createDialog().props.onOpenChange(false);
  findButton(pl, "Đóng").props.onClick();
  await pl.flush();
  assert.equal(createDialog().props.open, true);
  assert.ok(maybeButton(pl, "Thử lại đúng yêu cầu"));

  // Reconcile GET fails -> lock + key STILL preserved!
  findButton(pl, "Tải lại để đối chiếu").props.onClick();
  await pl.flush();
  const reconGetFail = findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons"));
  rejectNetwork(reconGetFail);
  await pl.flush();
  assert.equal(createDialog().props.open, true);
  assert.ok(maybeButton(pl, "Thử lại đúng yêu cầu"));

  // Retry sends EXACT same key & body!
  findButton(pl, "Thử lại đúng yêu cầu").props.onClick();
  await pl.flush();
  const createReq2 = findLastRequest((r) => r.method === "POST");
  assert.equal(createReq2.options.headers["Idempotency-Key"], key1);
  assert.equal(createReq2.options.body, body1);

  // 3b) PersonDetailManager PATCH -> 503 -> Hủy/Escape blocked -> failed reconcile keeps key -> retry sends exact key
  const pd = mount(PersonDetailManager, { personId: PERSON_A_ID });
  await pd.flush();
  respond(findLastRequest((r) => r.url.endsWith(`/persons/${PERSON_A_ID}`)), 200, {
    ok: true,
    authorization_date: AUTH_DATE,
    as_of: AS_OF,
    person: makePersonDetail(),
  });
  await pd.flush();

  findButton(pd, "Sửa hồ sơ").props.onClick();
  await pd.flush();
  findNode(pd, (n) => n.props?.id === "person-detail-reason").props.onChange({
    target: { value: "Cập nhật không chắc chắn" },
  });
  await pd.flush();
  findNode(pd, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await pd.flush();

  const patch1 = findLastRequest((r) => r.method === "PATCH");
  const pdKey = patch1.options.headers["Idempotency-Key"];
  const pdBody = patch1.options.body;
  respond(patch1, 503, { ok: false, code: "ORG_UNAVAILABLE" });
  await pd.flush();

  const pdDialog = () => findNode(pd, (n) => n.type?.name === "FormDialog");
  assert.equal(pdDialog().props.closeDisabled, true);
  pdDialog().props.onOpenChange(false);
  findButton(pd, "Hủy").props.onClick();
  await pd.flush();
  assert.equal(pdDialog().props.open, true);

  findButton(pd, "Tải lại để đối chiếu").props.onClick();
  await pd.flush();
  respond(findLastRequest((r) => r.method === "GET"), 500, { ok: false });
  await pd.flush();
  assert.equal(pdDialog().props.open, true);

  findButton(pd, "Thử lại đúng yêu cầu").props.onClick();
  await pd.flush();
  const patch2 = findLastRequest((r) => r.method === "PATCH");
  assert.equal(patch2.options.headers["Idempotency-Key"], pdKey);
  assert.equal(patch2.options.body, pdBody);
});

test("Finding 3 [Department HEAD/Memberships & AccountOrgDialogs]: 409 IDEMPOTENCY_IN_PROGRESS / 503 / network error retains key across Hủy/Escape & failed reconcile", async () => {
  // 3c) DepartmentList & DepartmentDetail HEAD & Members
  const dl = mount(DepartmentListManager);
  await dl.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments?")), 200, makeDeptListEnvelope());
  await dl.flush();

  findButton(dl, "Tạo phòng ban tùy chỉnh").props.onClick();
  await dl.flush();
  const dlInputs = collectNodes(dl.tree).filter((n) => n.type === "input");
  dlInputs[0].props.onChange({ target: { value: "NEW_DEPT" } });
  dlInputs[1].props.onChange({ target: { value: "Phòng Mới" } });
  findNode(dl, (n) => n.type === "textarea").props.onChange({ target: { value: "Tạo phòng" } });
  await dl.flush();
  findNode(dl, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await dl.flush();

  const dlPost1 = findLastRequest((r) => r.method === "POST");
  const dlKey = dlPost1.options.headers["Idempotency-Key"];
  const dlBody = dlPost1.options.body;
  respond(dlPost1, 503, { ok: false, code: "DEPARTMENT_UNAVAILABLE" });
  await dl.flush();

  assert.equal(findNode(dl, (n) => n.type?.name === "FormDialog").props.closeDisabled, true);
  findNode(dl, (n) => n.type?.name === "FormDialog").props.onOpenChange(false);
  findButton(dl, "Hủy").props.onClick();
  await dl.flush();
  assert.equal(findNode(dl, (n) => n.type?.name === "FormDialog").props.open, true);

  findButton(dl, "Tải lại để đối chiếu").props.onClick();
  await dl.flush();
  respond(findLastRequest((r) => r.method === "GET"), 503, { ok: false });
  await dl.flush();
  assert.equal(findNode(dl, (n) => n.type?.name === "FormDialog").props.open, true);

  const dlRetryBtn = findNode(dl, (n) => n.type?.name === "Button" && textOf(n).trim() === "Thử gửi lại cùng yêu cầu");
  assert.equal(Boolean(dlRetryBtn.props.disabled), false);
  findNode(dl, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await dl.flush();
  const dlPost2 = findLastRequest((r) => r.method === "POST");
  assert.equal(dlPost2.options.headers["Idempotency-Key"], dlKey);
  assert.equal(dlPost2.options.body, dlBody);

  // 3d) DepartmentHeadManagementSection with 409 IDEMPOTENCY_IN_PROGRESS
  const dept = makeDept({
    active_head: {
      head_assignment_id: HEAD_A_ID,
      person_id: PERSON_A_ID,
      employee_code: "NS-001",
      full_name: "Tên cũ A",
      started_at: AS_OF,
      version: 2,
    },
  });
  const dd = mount(DepartmentDetailManager, { departmentId: DEPT_OPS_ID });
  await dd.flush();
  respond(findLastRequest((r) => r.method === "GET"), 200, makeDeptDetailEnvelope(dept));
  await dd.flush();

  const head = await syncChildFromTree(dd, "DepartmentHeadManagementSection", null);
  respond(
    findLastRequest((r) => r.url.includes("/head?")),
    200,
    makeHeadsEnvelope(DEPT_OPS_ID, dept.active_head, [makeHeadProjection()]),
  );
  await head.flush();

  findButton(head, "Kết thúc chức danh Trưởng phòng").props.onClick();
  await head.flush();
  findNode(head, (n) => n.type === "textarea").props.onChange({ target: { value: "Thử in progress" } });
  await head.flush();
  findNode(head, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await head.flush();

  const headPost1 = findLastRequest((r) => r.url.endsWith("/head/end"));
  const headKey = headPost1.options.headers["Idempotency-Key"];
  respond(headPost1, 409, { ok: false, code: "IDEMPOTENCY_IN_PROGRESS" });
  await head.flush();

  assert.equal(findNode(head, (n) => n.props?.dataTestId === "department-head-dialog").props.closeDisabled, true);
  findNode(head, (n) => n.props?.dataTestId === "department-head-dialog").props.onOpenChange(false);
  findButton(head, "Hủy").props.onClick();
  await head.flush();
  assert.equal(findNode(head, (n) => n.props?.dataTestId === "department-head-dialog").props.open, true);

  // Failed reconcile GET keeps dialog & pending key
  findButton(head, "Tải lại để đối chiếu").props.onClick();
  await head.flush();
  const recDetailFail = findLastRequest((r) => r.url.endsWith(`/departments/${DEPT_OPS_ID}`));
  const recHeadFail = findLastRequest((r) => r.url.includes("/head?"));
  respond(recDetailFail, 503, { ok: false });
  respond(recHeadFail, 200, makeHeadsEnvelope(DEPT_OPS_ID, dept.active_head, [makeHeadProjection()]));
  await head.flush();
  assert.equal(findNode(head, (n) => n.props?.dataTestId === "department-head-dialog").props.open, true);

  const headRetryBtn = findNode(
    head,
    (n) => n.type?.name === "Button" && textOf(n).trim() === "Thử gửi lại cùng yêu cầu",
  );
  assert.equal(Boolean(headRetryBtn.props.disabled), false);
  findNode(head, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await head.flush();
  assert.equal(findLastRequest((r) => r.url.endsWith("/head/end")).options.headers["Idempotency-Key"], headKey);

  // 3d-bis) DepartmentPersonMembershipsSection uncertain write -> Hủy/Escape/failed GET keeps key
  const ddMem = mount(DepartmentDetailManager, { departmentId: DEPT_OPS_ID });
  await ddMem.flush();
  respond(findLastRequest((r) => r.url.endsWith(`/departments/${DEPT_OPS_ID}`)), 200, makeDeptDetailEnvelope(dept));
  await ddMem.flush();
  const memSec = await syncChildFromTree(ddMem, "DepartmentPersonMembershipsSection", null);
  respond(findLastRequest((r) => r.url.includes("/memberships?")), 200, makeDeptMembersEnvelope(DEPT_OPS_ID));
  await memSec.flush();

  findButton(memSec, "Kết thúc thành viên").props.onClick();
  await memSec.flush();
  findNode(memSec, (n) => n.type === "textarea").props.onChange({ target: { value: "Thử giữ key" } });
  await memSec.flush();
  const memDlgForm = () => {
    const dlg = findNode(memSec, (n) => n.props?.dataTestId === "department-person-member-dialog");
    return collectNodes(dlg).find((n) => n.type === "form");
  };
  memDlgForm().props.onSubmit({ preventDefault() {} });
  await memSec.flush();

  const memPost1 = findLastRequest((r) => r.url.includes(`/memberships/${MEMBERSHIP_A_ID}/end`));
  const memKey = memPost1.options.headers["Idempotency-Key"];
  const memBody = memPost1.options.body;
  respond(memPost1, 503, { ok: false, code: "TEMP_UNAVAILABLE" });
  await memSec.flush();

  const memDlg = () => findNode(memSec, (n) => n.props?.dataTestId === "department-person-member-dialog");
  assert.equal(memDlg().props.closeDisabled, true);
  memDlg().props.onOpenChange(false);
  findButton(memSec, "Hủy").props.onClick();
  await memSec.flush();
  assert.equal(memDlg().props.open, true);

  findButton(memSec, "Tải lại để đối chiếu").props.onClick();
  await memSec.flush();
  respond(findLastRequest((r) => r.url.endsWith(`/departments/${DEPT_OPS_ID}`)), 503, { ok: false });
  respond(findLastRequest((r) => r.url.includes("/memberships?")), 200, makeDeptMembersEnvelope(DEPT_OPS_ID));
  await memSec.flush();
  assert.equal(memDlg().props.open, true);

  const memRetryBtn = findNode(
    memSec,
    (n) => n.type?.name === "Button" && textOf(n).trim() === "Thử gửi lại cùng yêu cầu",
  );
  assert.equal(Boolean(memRetryBtn.props.disabled), false);
  memDlgForm().props.onSubmit({ preventDefault() {} });
  await memSec.flush();
  const memPost2 = findLastRequest((r) => r.url.includes(`/memberships/${MEMBERSHIP_A_ID}/end`));
  assert.equal(memPost2.options.headers["Idempotency-Key"], memKey);
  assert.equal(memPost2.options.body, memBody);

  // 3e) AccountOrgDialogs -> IDEMPOTENCY_IN_PROGRESS & network failure
  const am = mount(AccountManager);
  await am.flush();
  respond(findLastRequest((r) => r.url.endsWith("/reclassify")), 200, { ok: true, reclassified: {} });
  respond(
    findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?")),
    200,
    makeAccountListEnvelope([makeAccount()]),
  );
  await am.flush();

  findButton(am, "Phân loại").props.onClick();
  await am.flush();
  const orgDialog = await syncChildFromTree(am, "AccountOrgDialogs", null);
  findNode(orgDialog, (n) => n.type === "select").props.onChange({ target: { value: "SERVICE" } });
  findNode(orgDialog, (n) => n.type === "textarea").props.onChange({ target: { value: "Chuyển service" } });
  await orgDialog.flush();
  findNode(orgDialog, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await orgDialog.flush();

  const accPost1 = findLastRequest((r) => r.url.endsWith("/classification"));
  const accKey = accPost1.options.headers["Idempotency-Key"];
  const accBody = accPost1.options.body;
  respond(accPost1, 409, { ok: false, code: "IDEMPOTENCY_IN_PROGRESS" });
  await orgDialog.flush();

  const accDlg = () => findNode(orgDialog, (n) => n.props?.dataTestId === "account-org-dialog");
  assert.equal(accDlg().props.closeDisabled, true);
  accDlg().props.onOpenChange(false);
  findButton(orgDialog, "Hủy").props.onClick();
  await orgDialog.flush();
  assert.equal(accDlg().props.open, true);

  findButton(orgDialog, "Tải lại dữ liệu mới nhất").props.onClick();
  await orgDialog.flush();
  rejectNetwork(findLastRequest((r) => r.method === "GET"));
  await orgDialog.flush();
  assert.equal(accDlg().props.open, true);

  const accRetryBtn = findNode(
    orgDialog,
    (n) => n.type?.name === "Button" && textOf(n).trim() === "Thử gửi lại cùng yêu cầu",
  );
  assert.equal(Boolean(accRetryBtn.props.disabled), false);
  findNode(orgDialog, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await orgDialog.flush();
  const accPost2 = findLastRequest((r) => r.url.endsWith("/classification"));
  assert.equal(accPost2.options.headers["Idempotency-Key"], accKey);
  assert.equal(accPost2.options.body, accBody);
});

// ===========================================================================
// Finding 4 — Unrelated field edits do NOT re-fetch pickers; real search/page
// changes DO re-fetch & ignore stale earlier picker responses
// ===========================================================================

test("Finding 4 [Pickers across Person, Department Memberships, Account]: editing name/code/reason never refetches pickers; search/page changes do & drop stale responses", async () => {
  // 4a) PersonListManager + DepartmentSelectPicker + AccountSearchPicker
  const pl = mount(PersonListManager);
  await pl.flush();
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments")), 200, makeDeptListEnvelope());
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons")), 200, makePersonListEnvelope());
  await pl.flush();

  findButton(pl, "Tạo hồ sơ nhân sự").props.onClick();
  await pl.flush();

  const deptPicker = await syncChildFromTree(pl, DepartmentSelectPicker, null);
  const accountPicker = await syncChildFromTree(pl, AccountSearchPicker, null);

  const countPickerGets = () =>
    requests.filter(
      (r) =>
        r.method === "GET" &&
        (r.url.startsWith("/api/admin/departments") ||
          r.url.startsWith("/api/admin/access/accounts")),
    ).length;

  const initialAccountGet = findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?"));
  respond(findLastRequest((r) => r.url.includes("include_inactive=false")), 200, makeDeptListEnvelope());
  respond(initialAccountGet, 200, makeAccountListEnvelope([makeAccount({ display_name: "Init Account" })]));
  await deptPicker.flush();
  await accountPicker.flush();

  const baselineCount = countPickerGets();

  // Edit unrelated fields repeatedly across parent form
  for (const suffix of ["1", "12", "123"]) {
    findNode(pl, (n) => n.props?.id === "create-person-employee-code").props.onChange({
      target: { value: `NS-${suffix}` },
    });
    findNode(pl, (n) => n.props?.id === "create-person-full-name").props.onChange({
      target: { value: `Tên sửa ${suffix}` },
    });
    findNode(pl, (n) => n.props?.id === "create-person-joined-on").props.onChange({
      target: { value: "2026-11-01" },
    });
    findNode(pl, (n) => n.props?.id === "create-person-reason").props.onChange({
      target: { value: `Lý do ${suffix}` },
    });
    await pl.flush();
    await syncChildFromTree(pl, DepartmentSelectPicker, deptPicker);
    await syncChildFromTree(pl, AccountSearchPicker, accountPicker);
  }
  assert.equal(countPickerGets() - baselineCount, 0);

  // Real search change inside AccountSearchPicker triggers 1 GET & ignores out-of-order response
  findNode(accountPicker, (n) => n.type === "input").props.onChange({
    target: { value: "cu" },
  });
  await accountPicker.flush();
  const slowSearchReq = findLastRequest((r) => r.url.includes("search=cu"));
  assert.ok(slowSearchReq);

  findNode(accountPicker, (n) => n.type === "input").props.onChange({
    target: { value: "moi" },
  });
  await accountPicker.flush();
  assert.equal(slowSearchReq.signal.aborted, true);
  const latestSearchReq = findLastRequest((r) => r.url.includes("search=moi"));
  assert.ok(latestSearchReq);

  respond(latestSearchReq, 200, makeAccountListEnvelope([makeAccount({ display_name: "Account Mới Nhất" })], { search: "moi" }));
  await accountPicker.flush();
  respond(slowSearchReq, 200, makeAccountListEnvelope([makeAccount({ display_name: "Account Cũ Trễ" })], { search: "cu" }));
  await accountPicker.flush();

  assert.equal(textOf(accountPicker.tree).includes("Account Mới Nhất"), true);
  assert.equal(textOf(accountPicker.tree).includes("Account Cũ Trễ"), false);

  // 4b) PersonDetailManager + DepartmentSelectPicker (assign-dept reason edits -> 0 extra GETs)
  const pd = mount(PersonDetailManager, { personId: PERSON_A_ID });
  await pd.flush();
  respond(
    findLastRequest((r) => r.url.endsWith(`/persons/${PERSON_A_ID}`)),
    200,
    { ok: true, authorization_date: AUTH_DATE, as_of: AS_OF, person: makePersonDetail() },
  );
  await pd.flush();
  findButton(pd, "Gán phòng ban").props.onClick();
  await pd.flush();
  const pdDeptPicker = await syncChildFromTree(pd, DepartmentSelectPicker, null);
  respond(findLastRequest((r) => r.url.startsWith("/api/admin/departments?")), 200, makeDeptListEnvelope());
  await pdDeptPicker.flush();
  const pdBaseline = requests.filter((r) => r.url.startsWith("/api/admin/departments")).length;

  for (const r of ["Lý do A", "Lý do AB", "Lý do ABC"]) {
    findNode(pd, (n) => n.props?.id === "person-detail-reason").props.onChange({ target: { value: r } });
    await pd.flush();
    await syncChildFromTree(pd, DepartmentSelectPicker, pdDeptPicker);
  }
  assert.equal(requests.filter((r) => r.url.startsWith("/api/admin/departments")).length, pdBaseline);

  // 4c) DepartmentPersonMembershipsSection + PersonSearchPicker (reason edits -> 0 extra GETs)
  const dd = mount(DepartmentDetailManager, { departmentId: DEPT_OPS_ID });
  await dd.flush();
  respond(findLastRequest((r) => r.url.endsWith(`/departments/${DEPT_OPS_ID}`)), 200, makeDeptDetailEnvelope());
  await dd.flush();
  const membersSection = await syncChildFromTree(dd, "DepartmentPersonMembershipsSection", null);
  respond(findLastRequest((r) => r.url.includes("/memberships?")), 200, makeDeptMembersEnvelope(DEPT_OPS_ID));
  await membersSection.flush();

  findButton(membersSection, "Thêm hoặc chuyển thành viên").props.onClick();
  await membersSection.flush();
  const addMemberPicker = await syncChildFromTree(membersSection, PersonSearchPicker, null);
  respond(
    findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons?")),
    200,
    makePersonListEnvelope([makePersonSummary()], { page_size: 10 }),
  );
  await addMemberPicker.flush();
  const dmBaseline = requests.filter((r) => r.url.startsWith("/api/admin/organization/persons?")).length;

  for (const r of ["Điều chuyển 1", "Điều chuyển 12"]) {
    findNode(membersSection, (n) => n.type === "textarea").props.onChange({ target: { value: r } });
    await membersSection.flush();
    await syncChildFromTree(membersSection, PersonSearchPicker, addMemberPicker);
  }
  assert.equal(
    requests.filter((r) => r.url.startsWith("/api/admin/organization/persons?")).length,
    dmBaseline,
  );

  // 4d) AccountManager AccountOrgDialogs (link + mismatch recruiter picker, reason edits -> 0 extra GETs)
  const am = mount(AccountManager);
  await am.flush();
  respond(findLastRequest((r) => r.url.endsWith("/reclassify")), 200, { ok: true, reclassified: {} });
  respond(
    findLastRequest((r) => r.url.startsWith("/api/admin/access/accounts?")),
    200,
    makeAccountListEnvelope([makeAccount()]),
  );
  await am.flush();

  findButton(am, "Liên kết người").props.onClick();
  await am.flush();
  const orgDialog = await syncChildFromTree(am, "AccountOrgDialogs", null);
  const accPersonPicker = await syncChildFromTree(orgDialog, PersonSearchPicker, null);
  respond(
    findLastRequest((r) => r.url.startsWith("/api/admin/organization/persons?")),
    200,
    makePersonListEnvelope([makePersonSummary()], { link_state: "unlinked", page_size: 10 }),
  );
  await accPersonPicker.flush();

  // Trigger RECRUITER_LINK_MISMATCH so RecruiterConfirmPicker mounts too
  accPersonPicker.props.onSelect(makePersonSummary());
  findNode(orgDialog, (n) => n.type === "textarea").props.onChange({ target: { value: "Liên kết" } });
  await orgDialog.flush();
  findNode(orgDialog, (n) => n.type === "form").props.onSubmit({ preventDefault() {} });
  await orgDialog.flush();
  respond(findLastRequest((r) => r.url.endsWith("/person-link")), 409, {
    ok: false,
    code: "RECRUITER_LINK_MISMATCH",
  });
  await orgDialog.flush();

  const recPicker = await syncChildFromTree(orgDialog, RecruiterConfirmPicker, null);
  respond(
    findLastRequest((r) => r.url.startsWith("/api/admin/catalog/personnel?")),
    200,
    makePersonnelListEnvelope([], "Tên cũ A"),
  );
  await recPicker.flush();

  const accPickerBefore = requests.filter(
    (r) =>
      r.url.startsWith("/api/admin/organization/persons?") ||
      r.url.startsWith("/api/admin/catalog/personnel?"),
  ).length;

  for (const r of ["Xác nhận lý do 1", "Xác nhận lý do 12", "Xác nhận lý do 123"]) {
    findNode(orgDialog, (n) => n.type === "textarea").props.onChange({ target: { value: r } });
    await orgDialog.flush();
    await syncChildFromTree(orgDialog, PersonSearchPicker, accPersonPicker);
    await syncChildFromTree(orgDialog, RecruiterConfirmPicker, recPicker);
  }

  const accPickerAfter = requests.filter(
    (r) =>
      r.url.startsWith("/api/admin/organization/persons?") ||
      r.url.startsWith("/api/admin/catalog/personnel?"),
  ).length;
  assert.equal(accPickerAfter - accPickerBefore, 0);
});
