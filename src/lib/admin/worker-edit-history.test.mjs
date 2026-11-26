import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import test, { after } from "node:test";
import ts from "typescript";

import {
  MISSING_RECRUITER_NAME_LABEL,
  MISSING_TEAM_NAME_LABEL,
  normalizeWorkerEditHistoryEmployeeCode,
  parseWorkerEditHistorySearchQuery,
  projectWorkerEditHistoryRevision,
  resolveSnapshotRecruiterDisplay,
  resolveSnapshotTeamDisplay,
} from "./worker-edit-history-contract.ts";
import { createWorkerEditHistoryRepository } from "./worker-edit-history-repository.ts";
import {
  getWorkerEditHistory,
  getWorkerEditHistoryRevision,
} from "./worker-edit-history-api.ts";

const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const REV_ID = "22222222-2222-4222-8222-222222222222";
const REV_ID_2 = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";
const AUTH_SUB = "55555555-5555-4555-8555-555555555555";
const REC_A_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REC_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REC_C_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REC_INACTIVE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REC_ORPHAN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TEAM_1_ID = "10101010-1010-4010-8010-101010101010";
const TEAM_2_ID = "20202020-2020-4020-8020-202020202020";
const TEAM_3_ID = "30303030-3030-4030-8030-303030303030";
const TEAM_INACTIVE_ID = "40404040-4040-4040-8040-404040404040";
const TEAM_ORPHAN_ID = "50505050-5050-4050-8050-505050505050";

function makeSearchRow(overrides = {}) {
  return {
    revision_id: REV_ID,
    entry_id: ENTRY_ID,
    version: 2,
    employee_code: "hrp-2026-000123",
    display_name: "Nguyễn Văn Mẫu",
    national_id: "079095008811",
    project_id: "proj_alpha",
    project_name: "Dự Án Alpha",
    recruiter_id: REC_B_ID,
    recruiter_name: "Trần Thị B",
    actor_user_id: USER_ID,
    actor_display_name: "Admin Mẫu",
    reason_text: "Cập nhật người tuyển và nhóm",
    created_at: "2026-11-10T03:00:00.000Z",
    action_group: "PROFILE_EDIT",
    changed_fields: ["recruiter_id", "recruiter_name", "team_id", "team_name"],
    audit_actions: ["entry_privileged_edit"],
    snapshot_state: "COMPLETE",
    ...overrides,
  };
}

function makeRevisionPayload(overrides = {}) {
  return {
    revision_id: REV_ID,
    entry_id: ENTRY_ID,
    version: 2,
    created_at: "2026-11-10T03:00:00.000Z",
    actor_user_id: USER_ID,
    reason_text: "Cập nhật người tuyển và nhóm",
    snapshot_state: "COMPLETE",
    before_snapshot: {
      entry_id: ENTRY_ID,
      employee_code: "hrp-2026-000123",
      recruiter_id: REC_A_ID,
      recruiter_name: "Nguyễn Văn A",
      team_id: TEAM_1_ID,
      team_name: "Nhóm 1",
      worker_details: { display_name: "Nguyễn Văn Mẫu" },
    },
    after_snapshot: {
      entry_id: ENTRY_ID,
      employee_code: "hrp-2026-000123",
      recruiter_id: REC_B_ID,
      recruiter_name: "Trần Thị B",
      team_id: TEAM_2_ID,
      team_name: "Nhóm 2",
      worker_details: { display_name: "Nguyễn Văn Mẫu" },
    },
    current_snapshot: {
      entry_id: ENTRY_ID,
      employee_code: "hrp-2026-000123",
      project_name: "Dự Án Alpha",
      recruiter_id: REC_C_ID,
      recruiter_name: "Lê Văn C",
      team_id: TEAM_3_ID,
      team_name: "Nhóm 3",
      provider_type: "hrp",
      labor_type: "TEMPORARY",
      first_work_date: "2026-11-01",
      worker_details: { display_name: "Nguyễn Văn Mẫu" },
      employment_status: { status: "ON" },
      payment: { state: "omitted" },
    },
    resolved_recruiters: {
      [REC_A_ID]: "Nguyễn Văn A (Hiện tại)",
      [REC_B_ID]: "Trần Thị B",
      [REC_C_ID]: "Lê Văn C",
      [REC_INACTIVE_ID]: "Phạm Văn Cũ (Đã khóa)",
    },
    resolved_teams: {
      [TEAM_1_ID]: "Nhóm 1",
      [TEAM_2_ID]: "Nhóm 2",
      [TEAM_3_ID]: "Nhóm 3",
      [TEAM_INACTIVE_ID]: "Nhóm Cũ (Đã khóa)",
    },
    audit_events: [],
    employment_status_events: [],
    document_events: [],
    ...overrides,
  };
}

test("contract: parseWorkerEditHistorySearchQuery handles optional employee_code trimming, length, whitespace, and control chars", () => {
  const withoutCode = parseWorkerEditHistorySearchQuery(
    new URL("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31"),
  );
  assert.deepEqual(withoutCode, {
    ok: true,
    value: {
      from_date: "2026-10-01",
      to_date: "2026-10-31",
      action_group: null,
      project_id: null,
      recruiter_id: null,
      employee_code: null,
      page_size: 50,
      cursor: null,
    },
  });

  const blankCode = parseWorkerEditHistorySearchQuery(
    new URL("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31&employee_code=%20%20%20"),
  );
  assert.equal(blankCode.ok, true);
  assert.equal(blankCode.value.employee_code, null);

  const trimmedPreservedCase = parseWorkerEditHistorySearchQuery(
    new URL("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31&employee_code=%20%20HRP-2026-000123%20%20"),
  );
  assert.equal(trimmedPreservedCase.ok, true);
  assert.equal(trimmedPreservedCase.value.employee_code, "HRP-2026-000123");

  const max64 = "A".repeat(64);
  const atLimit = parseWorkerEditHistorySearchQuery(
    new URL(`https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31&employee_code=${max64}`),
  );
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.value.employee_code, max64);

  for (const bad of ["A".repeat(65), "HRP 2026", "HRP\t2026", "HRP\n2026", "HRP\u00002026", "HRP\u007f2026"]) {
    assert.deepEqual(normalizeWorkerEditHistoryEmployeeCode(bad), {
      ok: false,
      code: "WORKER_EDIT_HISTORY_QUERY_INVALID",
    });
    const parsed = parseWorkerEditHistorySearchQuery(
      new URL(`https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31&employee_code=${encodeURIComponent(bad)}`),
    );
    assert.deepEqual(parsed, { ok: false, code: "WORKER_EDIT_HISTORY_QUERY_INVALID" });
  }

  const dupCode = parseWorkerEditHistorySearchQuery(
    new URL("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31&employee_code=a&employee_code=b"),
  );
  assert.deepEqual(dupCode, { ok: false, code: "WORKER_EDIT_HISTORY_QUERY_INVALID" });

  // 93-day cap still enforced
  assert.equal(
    parseWorkerEditHistorySearchQuery(
      new URL("https://app.example/api/admin/worker-edit-history?from_date=2026-01-01&to_date=2026-04-03&employee_code=hrp-2026-000123"),
    ).ok,
    true,
  );
  assert.equal(
    parseWorkerEditHistorySearchQuery(
      new URL("https://app.example/api/admin/worker-edit-history?from_date=2026-01-01&to_date=2026-04-04&employee_code=hrp-2026-000123"),
    ).ok,
    false,
  );
});

test("contract: projectWorkerEditHistoryRevision defaults/validates resolved_recruiters and resolved_teams and blocks storage keys", () => {
  const legacyPayload = makeRevisionPayload();
  delete legacyPayload.resolved_recruiters;
  delete legacyPayload.resolved_teams;

  const projectedLegacy = projectWorkerEditHistoryRevision(legacyPayload);
  assert.ok(projectedLegacy);
  assert.deepEqual(projectedLegacy.resolved_recruiters, {});
  assert.deepEqual(projectedLegacy.resolved_teams, {});

  const projectedWithMaps = projectWorkerEditHistoryRevision(makeRevisionPayload());
  assert.ok(projectedWithMaps);
  assert.equal(projectedWithMaps.resolved_recruiters[REC_A_ID], "Nguyễn Văn A (Hiện tại)");
  assert.equal(projectedWithMaps.resolved_teams[TEAM_1_ID], "Nhóm 1");

  assert.equal(projectWorkerEditHistoryRevision(makeRevisionPayload({ resolved_recruiters: null })), null);
  assert.equal(projectWorkerEditHistoryRevision(makeRevisionPayload({ resolved_recruiters: ["bad"] })), null);
  assert.equal(projectWorkerEditHistoryRevision(makeRevisionPayload({ resolved_teams: { [TEAM_1_ID]: 123 } })), null);
  assert.equal(
    projectWorkerEditHistoryRevision(makeRevisionPayload({
      after_snapshot: { storage_key: "secret/key.jpg" },
    })),
    null,
  );
});

test("per-snapshot resolution: resolves A -> B while current is C, prefers valid saved name, supports inactive catalog, orphan fallback, UUID-as-name, and null team_id", () => {
  const payload = makeRevisionPayload({
    before_snapshot: {
      recruiter_id: REC_A_ID,
      recruiter_name: "Nguyễn Văn A (Tên lúc sửa)",
      team_id: TEAM_1_ID,
      team_name: "Nhóm 1 (Tên lúc sửa)",
    },
    after_snapshot: {
      recruiter_id: REC_B_ID,
      recruiter_name: "Trần Thị B",
      team_id: TEAM_2_ID,
      team_name: "Nhóm 2",
    },
    current_snapshot: {
      recruiter_id: REC_C_ID,
      recruiter_name: "Lê Văn C",
      team_id: TEAM_3_ID,
      team_name: "Nhóm 3",
    },
  });

  // 1. A -> B while current C; prefers valid saved name even when catalog was later renamed
  assert.equal(
    resolveSnapshotRecruiterDisplay(payload.before_snapshot, payload.resolved_recruiters),
    "Nguyễn Văn A (Tên lúc sửa)",
  );
  assert.equal(
    resolveSnapshotRecruiterDisplay(payload.after_snapshot, payload.resolved_recruiters),
    "Trần Thị B",
  );
  assert.equal(
    resolveSnapshotRecruiterDisplay(payload.current_snapshot, payload.resolved_recruiters),
    "Lê Văn C",
  );
  assert.equal(
    resolveSnapshotTeamDisplay(payload.before_snapshot, payload.resolved_teams),
    "Nhóm 1 (Tên lúc sửa)",
  );
  assert.equal(
    resolveSnapshotTeamDisplay(payload.after_snapshot, payload.resolved_teams),
    "Nhóm 2",
  );
  assert.equal(
    resolveSnapshotTeamDisplay(payload.current_snapshot, payload.resolved_teams),
    "Nhóm 3",
  );

  // 2. Legacy ID-only snapshot pointing to inactive catalog rows (case-insensitive UUID match)
  assert.equal(
    resolveSnapshotRecruiterDisplay({ recruiter_id: REC_INACTIVE_ID.toUpperCase() }, payload.resolved_recruiters),
    "Phạm Văn Cũ (Đã khóa)",
  );
  assert.equal(
    resolveSnapshotTeamDisplay({ team_id: TEAM_INACTIVE_ID.toUpperCase() }, payload.resolved_teams),
    "Nhóm Cũ (Đã khóa)",
  );

  // 3. UUID-as-name ignored -> falls back to resolved catalog if present, else missing label
  assert.equal(
    resolveSnapshotRecruiterDisplay(
      { recruiter_id: REC_INACTIVE_ID, recruiter_name: REC_INACTIVE_ID },
      payload.resolved_recruiters,
    ),
    "Phạm Văn Cũ (Đã khóa)",
  );
  assert.equal(
    resolveSnapshotRecruiterDisplay(
      { recruiter_id: REC_ORPHAN_ID, recruiter_name: REC_A_ID },
      payload.resolved_recruiters,
    ),
    MISSING_RECRUITER_NAME_LABEL,
  );
  assert.equal(
    resolveSnapshotTeamDisplay(
      { team_id: TEAM_ORPHAN_ID, team_name: TEAM_ORPHAN_ID },
      payload.resolved_teams,
    ),
    MISSING_TEAM_NAME_LABEL,
  );

  // 4. Orphan ID missing name & not in resolved map -> explicit missing label
  assert.equal(
    resolveSnapshotRecruiterDisplay({ recruiter_id: REC_ORPHAN_ID }, payload.resolved_recruiters),
    MISSING_RECRUITER_NAME_LABEL,
  );
  assert.equal(
    resolveSnapshotTeamDisplay({ team_id: TEAM_ORPHAN_ID }, payload.resolved_teams),
    MISSING_TEAM_NAME_LABEL,
  );

  // 5. Null/absent ID -> null (UI renders "—"), unless valid saved name exists; UUID saved name without ID still ignored
  assert.equal(resolveSnapshotTeamDisplay({ team_id: null }, payload.resolved_teams), null);
  assert.equal(resolveSnapshotTeamDisplay({ team_id: null, team_name: "  " }, payload.resolved_teams), null);
  assert.equal(resolveSnapshotTeamDisplay({ team_id: null, team_name: TEAM_1_ID }, payload.resolved_teams), null);
  assert.equal(resolveSnapshotTeamDisplay({ team_id: null, team_name: "Nhóm Thủ Công" }, payload.resolved_teams), "Nhóm Thủ Công");
  assert.equal(resolveSnapshotRecruiterDisplay(null, payload.resolved_recruiters), null);
});

test("repository & API: forwards p_employee_code, projects resolved maps, and preserves 401/403/400 authz guards", async () => {
  const rpcCalls = [];
  const repository = createWorkerEditHistoryRepository(async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === "worker_edit_history_search") {
      return {
        data: {
          rows: [makeSearchRow()],
          has_more: false,
          next_cursor: null,
        },
        error: null,
      };
    }
    if (name === "worker_edit_history_get_revision") {
      return { data: makeRevisionPayload(), error: null };
    }
    return { data: null, error: { code: "P0002" } };
  });

  const validSession = async () => ({
    actor: {
      ok: true,
      actor: {
        auth_subject: AUTH_SUB,
        app_user_id: USER_ID,
        capabilities: ["worker_edit_history_view"],
        scopes: [{ kind: "all" }],
        effective_grants: [
          { capability: "worker_edit_history_view", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE" },
        ],
      },
    },
  });

  // 401 unauthenticated
  const unauthRes = await getWorkerEditHistory(
    new Request("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31"),
    {
      resolveSession: async () => ({ actor: { ok: false, reason: "UNAUTHENTICATED" } }),
      repository,
    },
  );
  assert.equal(unauthRes.status, 401);

  // 403 actor unavailable
  const noActorRes = await getWorkerEditHistory(
    new Request("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31"),
    {
      resolveSession: async () => ({ actor: { ok: false, reason: "ACTOR_NOT_AVAILABLE" } }),
      repository,
    },
  );
  assert.equal(noActorRes.status, 403);

  // 403 access denied from RPC
  const deniedRepo = createWorkerEditHistoryRepository(async () => ({
    data: null,
    error: { code: "42501", message: "WORKER_EDIT_HISTORY_ACCESS_DENIED" },
  }));
  const deniedRes = await getWorkerEditHistory(
    new Request("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31"),
    { resolveSession: validSession, repository: deniedRepo },
  );
  assert.equal(deniedRes.status, 403);

  // 400 invalid employee_code stops before RPC
  const beforeRpcCount = rpcCalls.length;
  const badCodeRes = await getWorkerEditHistory(
    new Request("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31&employee_code=HRP%202026"),
    { resolveSession: validSession, repository },
  );
  assert.equal(badCodeRes.status, 400);
  assert.equal((await badCodeRes.json()).code, "WORKER_EDIT_HISTORY_QUERY_INVALID");
  assert.equal(rpcCalls.length, beforeRpcCount);

  // 400 disallowed authority header
  const spoofRes = await getWorkerEditHistory(
    new Request("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31", {
      headers: { "x-app-user-id": USER_ID },
    }),
    { resolveSession: validSession, repository },
  );
  assert.equal(spoofRes.status, 400);

  // 200 search without employee_code omits p_employee_code key completely
  const noCodeRes = await getWorkerEditHistory(
    new Request("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31"),
    { resolveSession: validSession, repository },
  );
  assert.equal(noCodeRes.status, 200);
  const noCodeCall = rpcCalls.at(-1);
  assert.equal(noCodeCall?.name, "worker_edit_history_search");
  assert.equal("p_employee_code" in noCodeCall.args, false);

  // 200 search with whitespace-only employee_code omits p_employee_code key completely
  const blankCodeRes = await getWorkerEditHistory(
    new Request("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31&employee_code=%20%20"),
    { resolveSession: validSession, repository },
  );
  assert.equal(blankCodeRes.status, 200);
  const blankCodeCall = rpcCalls.at(-1);
  assert.equal(blankCodeCall?.name, "worker_edit_history_search");
  assert.equal("p_employee_code" in blankCodeCall.args, false);

  // Direct repository.search with employee_code: null omits p_employee_code key completely
  const directNullResult = await repository.search({
    auth_subject: AUTH_SUB,
    app_user_id: USER_ID,
    from_date: "2026-10-01",
    to_date: "2026-10-31",
    action_group: null,
    project_id: null,
    recruiter_id: null,
    employee_code: null,
    page_size: 50,
    cursor: null,
  });
  assert.equal(directNullResult.ok, true);
  const directNullCall = rpcCalls.at(-1);
  assert.equal(directNullCall?.name, "worker_edit_history_search");
  assert.equal("p_employee_code" in directNullCall.args, false);

  // 200 search with trimmed employee_code forwards p_employee_code
  const okSearchRes = await getWorkerEditHistory(
    new Request("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31&employee_code=%20%20HRP-2026-000123%20%20"),
    { resolveSession: validSession, repository },
  );
  assert.equal(okSearchRes.status, 200);
  const searchCall = rpcCalls.at(-1);
  assert.equal(searchCall?.name, "worker_edit_history_search");
  assert.equal("p_employee_code" in searchCall.args, true);
  assert.equal(searchCall.args.p_employee_code, "HRP-2026-000123");

  // 200 revision detail includes resolved_recruiters and resolved_teams
  const okDetailRes = await getWorkerEditHistoryRevision(
    new Request(`https://app.example/api/admin/worker-edit-history/${ENTRY_ID}/${REV_ID}`),
    ENTRY_ID,
    REV_ID,
    { resolveSession: validSession, repository },
  );
  assert.equal(okDetailRes.status, 200);
  const detailBody = await okDetailRes.json();
  assert.equal(detailBody.ok, true);
  assert.equal(detailBody.data.resolved_recruiters[REC_A_ID], "Nguyễn Văn A (Hiện tại)");
  assert.equal(detailBody.data.resolved_teams[TEAM_1_ID], "Nhóm 1");
});

// --- UI component mount harness (verifies WorkerEditHistoryManager rendering, zero auto-load, Mã NLĐ filter, pagination, clear, and 3-panel snapshot resolution) ---
const repoRoot = path.resolve(import.meta.dirname, "../../..");
let activeHookInstance = null;

function equalDeps(prev, next) {
  return Array.isArray(prev) && Array.isArray(next) && prev.length === next.length && prev.every((v, i) => Object.is(v, next[i]));
}

const reactShim = {
  __esModule: true,
  Fragment: "Fragment",
  useState(initial) {
    const instance = activeHookInstance;
    const index = instance.cursor++;
    if (!instance.slots[index]) {
      instance.slots[index] = { value: typeof initial === "function" ? initial() : initial };
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
    if (!instance.slots[index]) instance.slots[index] = { current: initial };
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
  useEffect(effect, deps) {
    const instance = activeHookInstance;
    const index = instance.cursor++;
    const prev = instance.slots[index];
    if (!prev || deps === undefined || !equalDeps(prev.deps, deps)) {
      const slot = { deps, cleanup: prev?.cleanup ?? null, setupFn: effect };
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
        if (slot.cleanup) instance.cleanups.add(slot.cleanup);
      });
    } else {
      prev.setupFn = effect;
    }
  },
};

function jsx(type, props, key) {
  return { type, props: props ?? {}, key: key ?? null };
}

function renderTree(node) {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) return node.map(renderTree);
  if (typeof node === "object" && typeof node.type === "function") {
    return renderTree(node.type(node.props));
  }
  if (typeof node === "object" && node.props) {
    return {
      type: node.type,
      props: {
        ...node.props,
        children: renderTree(node.props.children),
      },
    };
  }
  return node;
}

function findNodes(tree, predicate, results = []) {
  if (!tree) return results;
  if (Array.isArray(tree)) {
    for (const item of tree) findNodes(item, predicate, results);
    return results;
  }
  if (typeof tree === "object") {
    if (predicate(tree)) results.push(tree);
    if (tree.props && "children" in tree.props) findNodes(tree.props.children, predicate, results);
  }
  return results;
}

function collectText(node) {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (typeof node === "object" && node.props && "children" in node.props) return collectText(node.props.children);
  return "";
}

let pendingDialogCloseAutoFocus = null;

const uiStubs = {
  "@/components/ui/alert": {
    __esModule: true,
    Alert: ({ title, children, tone = "info" }) => jsx("div", { "data-ui": "Alert", "data-tone": tone, children: [jsx("p", { children: title }), children] }),
  },
  "@/components/ui/button": {
    __esModule: true,
    Button: ({ children, loading, ...rest }) => jsx("button", { ...rest, "data-loading": loading ? "true" : "false", children }),
  },
  "@/components/ui/card": {
    __esModule: true,
    Card: ({ children }) => jsx("div", { "data-ui": "Card", children }),
    CardHeader: ({ title, description }) => jsx("div", { "data-ui": "CardHeader", children: [jsx("h2", { children: title }), description ? jsx("p", { children: description }) : null] }),
  },
  "@/components/ui/data-table": {
    __esModule: true,
    DATA_TABLE_CLASS: "table",
    DATA_TABLE_HEAD_CLASS: "thead",
    DATA_TABLE_ROW_CLASS: "tr",
    DATA_TABLE_TD_CLASS: "td",
    DATA_TABLE_TH_CLASS: "th",
    DataTableContainer: ({ children }) => jsx("div", { "data-ui": "DataTableContainer", children }),
  },
  "@/components/ui/catalog-filter-combobox": {
    __esModule: true,
    CatalogFilterCombobox: ({ id, label, value }) => jsx("div", { "data-ui": "CatalogFilterCombobox", id, "data-label": label, "data-value": value }),
  },
  "@/components/ui/form-dialog": {
    __esModule: true,
    FormDialog: ({
      open,
      onOpenChange,
      title,
      description,
      descriptionId,
      closeAriaLabel = "Đóng hộp thoại",
      onCloseAutoFocus,
      children,
      contentClassName,
      dataTestId,
    }) => {
      if (!open) {
        if (typeof pendingDialogCloseAutoFocus === "function") {
          const closeAutoFocus = pendingDialogCloseAutoFocus;
          pendingDialogCloseAutoFocus = null;
          closeAutoFocus({
            defaultPrevented: false,
            preventDefault() {
              this.defaultPrevented = true;
            },
          });
        }
        return null;
      }
      pendingDialogCloseAutoFocus = onCloseAutoFocus ?? null;
      const triggerClose = () => {
        pendingDialogCloseAutoFocus = null;
        onOpenChange(false);
        if (typeof onCloseAutoFocus === "function") {
          onCloseAutoFocus({
            defaultPrevented: false,
            preventDefault() {
              this.defaultPrevented = true;
            },
          });
        }
      };
      return jsx("div", {
        "data-ui": "FormDialog",
        "data-testid": dataTestId,
        "data-open": "true",
        "data-content-class": contentClassName,
        onEscapeKeyDown: triggerClose,
        onOpenChange,
        onCloseAutoFocus,
        children: [
          jsx("div", {
            children: [
              jsx("h2", { children: title }),
              description ? jsx("p", { id: descriptionId, children: description }) : null,
              jsx("button", {
                type: "button",
                "aria-label": closeAriaLabel,
                onClick: triggerClose,
                children: "×",
              }),
            ],
          }),
          children,
        ],
      });
    },
  },
};

const originalLoad = Module._load;
const originalTs = Module._extensions[".ts"];
const originalTsx = Module._extensions[".tsx"];
const originalFetch = globalThis.fetch;

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "react") return reactShim;
  if (request === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "Fragment" };
  if (request === "server-only") return {};
  if (request in uiStubs) return uiStubs[request];
  if (request.startsWith("@/")) {
    return originalLoad.call(this, path.join(repoRoot, "src", request.slice(2)), parent, isMain);
  }
  return originalLoad.call(this, request, parent, isMain);
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

after(() => {
  Module._load = originalLoad;
  Module._extensions[".ts"] = originalTs;
  Module._extensions[".tsx"] = originalTsx;
  globalThis.fetch = originalFetch;
});

function mountComponent(Component) {
  pendingDialogCloseAutoFocus = null;
  const instance = { id: 1, slots: [], cursor: 0, dirty: true, unmounted: false, pendingEffects: [], cleanups: new Set(), tree: null };
  const renderOnce = () => {
    if (instance.unmounted) return;
    instance.cursor = 0;
    instance.dirty = false;
    const prev = activeHookInstance;
    activeHookInstance = instance;
    try {
      instance.tree = renderTree(Component({}));
    } finally {
      activeHookInstance = prev;
    }
  };
  const runEffects = () => {
    for (let i = 0; i < 20 && !instance.unmounted; i += 1) {
      if (instance.dirty) renderOnce();
      const effects = instance.pendingEffects.splice(0);
      if (!effects.length) break;
      for (const eff of effects) eff();
    }
    if (instance.dirty && !instance.unmounted) renderOnce();
  };
  renderOnce();
  return {
    get tree() { return instance.tree; },
    async flush() {
      for (let i = 0; i < 4; i += 1) {
        runEffects();
        await new Promise((r) => setImmediate(r));
        runEffects();
      }
    },
    unmount() {
      instance.unmounted = true;
      for (const cleanup of instance.cleanups) {
        try { cleanup(); } catch {}
      }
    },
  };
}

const repoRequire = Module.createRequire(path.join(repoRoot, "package.json"));

test("UI: WorkerEditHistoryManager renders Mã NLĐ filter inside <search>, enforces zero auto-load, forwards/preserves employee_code on submit & Tải thêm, clears on Xóa lọc, and resolves per-snapshot names across all 3 panels", async () => {
  const { WorkerEditHistoryManager } = repoRequire("./src/components/admin/worker-edit-history-manager.tsx");

  const fetchedUrls = [];
  const row1 = makeSearchRow({
    revision_id: REV_ID,
    version: 2,
    employee_code: "HRP-2026-000123",
    changed_fields: ["recruiter_id", "recruiter_name", "team_id", "team_name"],
  });
  const row2 = makeSearchRow({
    revision_id: REV_ID_2,
    version: 1,
    employee_code: "HRP-2026-000123",
    changed_fields: ["recruiter_id", "team_id"],
  });
  const detailPayload = makeRevisionPayload({
    before_snapshot: {
      recruiter_id: REC_A_ID,
      recruiter_name: "Nguyễn Văn A",
      team_id: TEAM_1_ID,
      team_name: "Đội 1",
    },
    after_snapshot: {
      recruiter_id: REC_B_ID,
      recruiter_name: "Trần Thị B",
      team_id: TEAM_2_ID,
      team_name: "Đội 2",
    },
    current_snapshot: {
      employee_code: "HRP-2026-000123",
      project_name: "Dự Án Alpha",
      recruiter_id: REC_C_ID,
      recruiter_name: "Lê Văn C",
      team_id: TEAM_INACTIVE_ID,
      worker_details: { display_name: "Nguyễn Văn Mẫu" },
      employment_status: { status: "ON" },
      payment: { state: "omitted" },
    },
  });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    fetchedUrls.push(urlStr);
    if (urlStr.startsWith("/api/direct-entry/catalog")) {
      return new Response(JSON.stringify({
        ok: true,
        projects: [{ project_id: "proj_alpha", display_name: "Dự Án Alpha" }],
        recruiters: [{ recruiter_id: REC_C_ID, display_name: "Lê Văn C", label: "Lê Văn C", provider_type: "hrp", personnel_code: "HRP-C", vendor_id: null, team_id: TEAM_3_ID, team_display_name: "Nhóm 3" }],
        banks: [],
      }), { status: 200 });
    }
    if (urlStr.startsWith("/api/admin/worker-edit-history?")) {
      const parsed = new URL(`https://app.example${urlStr}`);
      if (!parsed.searchParams.get("cursor")) {
        return new Response(JSON.stringify({
          ok: true,
          data: {
            rows: [row1],
            has_more: true,
            next_cursor: "2026-11-10T03:00:00.000000Z|22222222-2222-4222-8222-222222222222",
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        data: { rows: [row2], has_more: false, next_cursor: null },
      }), { status: 200 });
    }
    if (urlStr === `/api/admin/worker-edit-history/${ENTRY_ID}/${REV_ID}`) {
      return new Response(JSON.stringify({ ok: true, data: detailPayload }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, code: "NOT_FOUND" }), { status: 404 });
  };

  const mounted = mountComponent(WorkerEditHistoryManager);
  await mounted.flush();

  // 1. Zero auto-load on mount: only catalog fetched, never /api/admin/worker-edit-history
  assert.equal(fetchedUrls.some((u) => u.startsWith("/api/admin/worker-edit-history")), false);
  assert.match(collectText(mounted.tree), /bấm “Tải lịch sử”/);
  assert.match(collectText(mounted.tree), /mã NLĐ/i);

  // 2. <search> wraps <form>; Mã NLĐ label + input attributes present
  const searchEls = findNodes(mounted.tree, (n) => n.type === "search");
  assert.equal(searchEls.length, 1);
  assert.equal(findNodes(searchEls[0], (n) => n.type === "form").length, 1);
  const codeLabels = findNodes(searchEls[0], (n) => n.type === "label" && n.props.htmlFor === "worker-edit-history-employee-code");
  assert.equal(codeLabels.length, 1);
  assert.equal(collectText(codeLabels[0]), "Mã NLĐ");
  const codeInputs = findNodes(searchEls[0], (n) => n.type === "input" && n.props.id === "worker-edit-history-employee-code");
  assert.equal(codeInputs.length, 1);
  assert.equal(codeInputs[0].props.name, "employee_code");
  assert.equal(codeInputs[0].props.maxLength, 64);
  assert.equal(codeInputs[0].props.placeholder, "Ví dụ: hrp-2026-000123");

  // 3. Invalid employee_code with space triggers client error without calling API
  codeInputs[0].props.onChange({ target: { value: "HRP 2026" } });
  await mounted.flush();
  const form = findNodes(mounted.tree, (n) => n.type === "form")[0];
  form.props.onSubmit({ preventDefault() {} });
  await mounted.flush();
  assert.equal(fetchedUrls.some((u) => u.startsWith("/api/admin/worker-edit-history")), false);
  const errorAlerts = findNodes(mounted.tree, (n) => n.type === "div" && n.props["data-ui"] === "Alert" && n.props["data-tone"] === "error");
  assert.equal(errorAlerts.length, 1);

  // 4. Valid employee_code with outer spaces trims and sends employee_code=HRP-2026-000123
  findNodes(mounted.tree, (n) => n.type === "input" && n.props.id === "worker-edit-history-employee-code")[0]
    .props.onChange({ target: { value: "  HRP-2026-000123  " } });
  await mounted.flush();
  findNodes(mounted.tree, (n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  await mounted.flush();

  const firstHistoryFetch = fetchedUrls.find((u) => u.startsWith("/api/admin/worker-edit-history?"));
  assert.ok(firstHistoryFetch);
  assert.equal(new URL(`https://app.example${firstHistoryFetch}`).searchParams.get("employee_code"), "HRP-2026-000123");

  // 5. Clicking Tải thêm keeps employee_code and appends row 2
  const loadMoreBtn = findNodes(mounted.tree, (n) => n.type === "button" && collectText(n) === "Tải thêm")[0];
  assert.ok(loadMoreBtn);
  loadMoreBtn.props.onClick();
  await mounted.flush();
  const secondHistoryFetch = fetchedUrls.filter((u) => u.startsWith("/api/admin/worker-edit-history?"))[1];
  assert.ok(secondHistoryFetch);
  const secondParams = new URL(`https://app.example${secondHistoryFetch}`).searchParams;
  assert.equal(secondParams.get("employee_code"), "HRP-2026-000123");
  assert.ok(secondParams.get("cursor"));
  assert.equal(findNodes(mounted.tree, (n) => n.type === "tr").length, 3); // 1 header + 2 rows

  // 6. Opening detail opens FormDialog (with NO bottom detail Card outside it) and renders all 3 snapshot panels + status/docs/audit inside the dialog
  assert.equal(findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog").length, 0);
  const viewBtn = findNodes(mounted.tree, (n) => n.type === "button" && collectText(n) === "Xem v2")[0];
  viewBtn.props.onClick({ currentTarget: null });
  await mounted.flush();

  const dialogs = findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog");
  assert.equal(dialogs.length, 1);
  const dialog = dialogs[0];
  assert.equal(dialog.props["data-testid"], "worker-edit-history-detail-dialog");
  assert.equal(dialog.props["data-open"], "true");
  assert.match(dialog.props["data-content-class"], /overscroll-contain/);
  assert.doesNotMatch(dialog.props["data-content-class"], /overflow-y-auto/);
  const dialogTitle = collectText(findNodes(dialog, (n) => n.type === "h2")[0]);
  assert.match(dialogTitle, /v2/);
  assert.match(dialogTitle, /Nguyễn Văn Mẫu/);
  assert.match(dialogTitle, /HRP-2026-000123/);

  // No bottom detail Card exists outside FormDialog
  const cards = findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "Card");
  assert.equal(cards.length, 2); // filter card + results card only
  for (const card of cards) {
    assert.equal(collectText(card).includes("Thông tin hiện tại của NLĐ"), false);
    assert.equal(collectText(card).includes("Trước thay đổi"), false);
  }

  const sections = findNodes(dialog, (n) => n.type === "section");
  const panelByTitle = (title) => sections.find((s) => collectText(findNodes(s, (n) => n.type === "h4")[0]) === title);

  const currentPanel = panelByTitle("Thông tin hiện tại của NLĐ");
  const beforePanel = panelByTitle("Trước thay đổi");
  const afterPanel = panelByTitle("Sau thay đổi");
  assert.ok(currentPanel && beforePanel && afterPanel);

  const dialogText = collectText(dialog);
  assert.match(dialogText, /Trạng thái làm việc/);
  assert.match(dialogText, /Hồ sơ \/ ảnh và người tải/);
  assert.match(dialogText, /Audit/);

  const currentText = collectText(currentPanel);
  const beforeText = collectText(beforePanel);
  const afterText = collectText(afterPanel);

  assert.match(currentText, /Lê Văn C/);
  assert.match(currentText, /Nhóm Cũ \(Đã khóa\)/);
  assert.equal(currentText.includes(REC_C_ID), false);
  assert.equal(currentText.includes(TEAM_INACTIVE_ID), false);

  assert.match(beforeText, /Nguyễn Văn A/);
  assert.match(beforeText, /Đội 1/);
  assert.equal(beforeText.includes(REC_A_ID), false);
  assert.equal(beforeText.includes(TEAM_1_ID), false);

  assert.match(afterText, /Trần Thị B/);
  assert.match(afterText, /Đội 2/);
  assert.equal(afterText.includes(REC_B_ID), false);
  assert.equal(afterText.includes(TEAM_2_ID), false);

  // Deduplication: Trước thay đổi & Sau thay đổi each show exactly 1 "Người tuyển" row and 1 "Nhóm" row
  assert.equal(findNodes(beforePanel, (n) => n.type === "dt" && collectText(n) === "Người tuyển").length, 1);
  assert.equal(findNodes(beforePanel, (n) => n.type === "dt" && collectText(n) === "Nhóm").length, 1);
  assert.equal(findNodes(afterPanel, (n) => n.type === "dt" && collectText(n) === "Người tuyển").length, 1);
  assert.equal(findNodes(afterPanel, (n) => n.type === "dt" && collectText(n) === "Nhóm").length, 1);

  // 7. Clicking Xóa lọc resets employeeCode to "" and returns to idle state
  const clearBtn = findNodes(mounted.tree, (n) => n.type === "button" && collectText(n) === "Xóa lọc")[0];
  clearBtn.props.onClick();
  await mounted.flush();
  assert.equal(findNodes(mounted.tree, (n) => n.type === "FormDialog" || n.props?.["data-ui"] === "FormDialog").length, 0);
  assert.equal(findNodes(mounted.tree, (n) => n.type === "input" && n.props.id === "worker-edit-history-employee-code")[0].props.value, "");
  assert.match(collectText(mounted.tree), /bấm “Tải lịch sử”/);

  mounted.unmount();
});

test("UI: SnapshotPanel renders inactive catalog lookup, orphan missing-name labels, UUID-as-name fallback, and team_id null as —", async () => {
  const { WorkerEditHistoryManager } = repoRequire("./src/components/admin/worker-edit-history-manager.tsx");

  const row = makeSearchRow({
    revision_id: REV_ID,
    version: 3,
    changed_fields: ["recruiter_id", "team_id"],
  });
  const detailPayload = makeRevisionPayload({
    before_snapshot: {
      recruiter_id: REC_INACTIVE_ID,
      recruiter_name: REC_INACTIVE_ID, // legacy UUID stored in recruiter_name -> must be ignored and resolved via inactive catalog
      team_id: null,
    },
    after_snapshot: {
      recruiter_id: REC_ORPHAN_ID,
      recruiter_name: REC_ORPHAN_ID,
      team_id: TEAM_ORPHAN_ID,
    },
    current_snapshot: {
      employee_code: "hrp-2026-000123",
      project_name: "Dự Án Alpha",
      recruiter_id: REC_ORPHAN_ID,
      team_id: null,
      worker_details: { display_name: "Nguyễn Văn Mẫu" },
      employment_status: { status: "ON" },
      payment: { state: "omitted" },
    },
  });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.startsWith("/api/direct-entry/catalog")) {
      return new Response(JSON.stringify({ ok: true, projects: [], recruiters: [], banks: [] }), { status: 200 });
    }
    if (urlStr.startsWith("/api/admin/worker-edit-history?")) {
      return new Response(JSON.stringify({ ok: true, data: { rows: [row], has_more: false, next_cursor: null } }), { status: 200 });
    }
    if (urlStr === `/api/admin/worker-edit-history/${ENTRY_ID}/${REV_ID}`) {
      return new Response(JSON.stringify({ ok: true, data: detailPayload }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, code: "NOT_FOUND" }), { status: 404 });
  };

  const mounted = mountComponent(WorkerEditHistoryManager);
  await mounted.flush();

  findNodes(mounted.tree, (n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  await mounted.flush();
  findNodes(mounted.tree, (n) => n.type === "button" && collectText(n) === "Xem v3")[0].props.onClick({ currentTarget: null });
  await mounted.flush();

  const dialog = findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog")[0];
  assert.ok(dialog);
  const sections = findNodes(dialog, (n) => n.type === "section");
  const panelByTitle = (title) => sections.find((s) => collectText(findNodes(s, (n) => n.type === "h4")[0]) === title);
  const currentPanel = panelByTitle("Thông tin hiện tại của NLĐ");
  const beforePanel = panelByTitle("Trước thay đổi");
  const afterPanel = panelByTitle("Sau thay đổi");

  // before_snapshot: inactive recruiter resolved, team_id null -> "—"
  const beforeText = collectText(beforePanel);
  assert.match(beforeText, /Phạm Văn Cũ \(Đã khóa\)/);
  assert.equal(beforeText.includes(REC_INACTIVE_ID), false);
  const beforeTeamRow = findNodes(beforePanel, (n) => n.type === "div" && collectText(findNodes(n, (c) => c.type === "dt")[0]) === "Nhóm")[0];
  assert.equal(collectText(findNodes(beforeTeamRow, (c) => c.type === "dd")[0]), "—");

  // after_snapshot: orphan recruiter & orphan team -> missing labels, zero UUIDs
  const afterText = collectText(afterPanel);
  assert.match(afterText, /Không tìm thấy tên người tuyển/);
  assert.match(afterText, /Không tìm thấy tên nhóm/);
  assert.equal(afterText.includes(REC_ORPHAN_ID), false);
  assert.equal(afterText.includes(TEAM_ORPHAN_ID), false);

  // current_snapshot: orphan recruiter -> missing label, team_id null -> "—"
  const currentText = collectText(currentPanel);
  assert.match(currentText, /Không tìm thấy tên người tuyển/);
  const currentTeamRow = findNodes(currentPanel, (n) => n.type === "div" && collectText(findNodes(n, (c) => c.type === "dt")[0]) === "Nhóm")[0];
  assert.equal(collectText(findNodes(currentTeamRow, (c) => c.type === "dd")[0]), "—");

  mounted.unmount();
});

test("UI: FormDialog ignores late stale response when switching quickly from Row A to Row B (even ignoring abort)", async () => {
  const { WorkerEditHistoryManager } = repoRequire("./src/components/admin/worker-edit-history-manager.tsx");

  const rowA = makeSearchRow({
    revision_id: REV_ID,
    version: 3,
    display_name: "Người Lao Động A",
    employee_code: "HRP-2026-000111",
    project_name: "Dự Án Độc Quyền A",
    changed_fields: ["recruiter_id"],
  });
  const rowB = makeSearchRow({
    revision_id: REV_ID_2,
    version: 2,
    display_name: "Người Lao Động B",
    employee_code: "HRP-2026-000222",
    project_name: "Dự Án Độc Quyền B",
    changed_fields: ["recruiter_id"],
  });

  let resolveRowA;
  let resolveRowB;
  const payloadA = makeRevisionPayload({
    revision_id: REV_ID,
    version: 3,
    current_snapshot: {
      employee_code: "HRP-2026-000111",
      project_name: "Dự Án Độc Quyền A",
      recruiter_id: REC_A_ID,
      recruiter_name: "Chuyên Viên Độc Quyền A",
      worker_details: { display_name: "Người Lao Động A" },
      employment_status: { status: "ON" },
      payment: { state: "omitted" },
    },
  });
  const payloadB = makeRevisionPayload({
    revision_id: REV_ID_2,
    version: 2,
    current_snapshot: {
      employee_code: "HRP-2026-000222",
      project_name: "Dự Án Độc Quyền B",
      recruiter_id: REC_B_ID,
      recruiter_name: "Chuyên Viên Độc Quyền B",
      worker_details: { display_name: "Người Lao Động B" },
      employment_status: { status: "ON" },
      payment: { state: "omitted" },
    },
  });

  globalThis.fetch = (url) => {
    const urlStr = String(url);
    if (urlStr.startsWith("/api/direct-entry/catalog")) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, projects: [], recruiters: [], banks: [] }), { status: 200 }));
    }
    if (urlStr.startsWith("/api/admin/worker-edit-history?")) {
      return Promise.resolve(new Response(JSON.stringify({ ok: true, data: { rows: [rowA, rowB], has_more: false, next_cursor: null } }), { status: 200 }));
    }
    // Intentionally ignore init.signal abort to simulate an unabortable late response
    if (urlStr === `/api/admin/worker-edit-history/${ENTRY_ID}/${REV_ID}`) {
      return new Promise((resolve) => {
        resolveRowA = () => resolve(new Response(JSON.stringify({ ok: true, data: payloadA }), { status: 200 }));
      });
    }
    if (urlStr === `/api/admin/worker-edit-history/${ENTRY_ID}/${REV_ID_2}`) {
      return new Promise((resolve) => {
        resolveRowB = () => resolve(new Response(JSON.stringify({ ok: true, data: payloadB }), { status: 200 }));
      });
    }
    return Promise.resolve(new Response(JSON.stringify({ ok: false, code: "NOT_FOUND" }), { status: 404 }));
  };

  const mounted = mountComponent(WorkerEditHistoryManager);
  await mounted.flush();

  findNodes(mounted.tree, (n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  await mounted.flush();

  // Open Row A -> stays loading
  findNodes(mounted.tree, (n) => n.type === "button" && collectText(n) === "Xem v3")[0].props.onClick({ currentTarget: null });
  await mounted.flush();
  assert.ok(resolveRowA);
  let dialog = findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog")[0];
  assert.match(collectText(dialog), /Đang tải chi tiết/);

  // Close Row A, then immediately open Row B
  findNodes(dialog, (n) => n.type === "button" && collectText(n) === "Đóng")[0].props.onClick();
  await mounted.flush();
  assert.equal(findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog").length, 0);

  findNodes(mounted.tree, (n) => n.type === "button" && collectText(n) === "Xem v2")[0].props.onClick({ currentTarget: null });
  await mounted.flush();
  assert.ok(resolveRowB);

  // Resolve Row A late -> dialog MUST stay loading and NEVER render Row A data
  resolveRowA();
  await mounted.flush();
  dialog = findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog")[0];
  assert.ok(dialog);
  const dialogTextDuringRace = collectText(dialog);
  assert.match(dialogTextDuringRace, /Đang tải chi tiết/);
  assert.equal(dialogTextDuringRace.includes("Chuyên Viên Độc Quyền A"), false);
  assert.equal(dialogTextDuringRace.includes("Dự Án Độc Quyền A"), false);

  // Now resolve Row B -> dialog renders Row B cleanly
  resolveRowB();
  await mounted.flush();
  dialog = findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog")[0];
  const dialogTextAfterB = collectText(dialog);
  assert.match(dialogTextAfterB, /Chuyên Viên Độc Quyền B/);
  assert.equal(dialogTextAfterB.includes("Chuyên Viên Độc Quyền A"), false);

  mounted.unmount();
});

test("UI: FormDialog renders Alert tone=error on HTTP 500 detail failure while keeping list rows and filters intact", async () => {
  const { WorkerEditHistoryManager } = repoRequire("./src/components/admin/worker-edit-history-manager.tsx");

  const rowC = makeSearchRow({
    revision_id: REV_ID,
    version: 1,
    display_name: "Nguyễn Văn Lỗi",
    employee_code: "HRP-2026-000500",
  });

  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.startsWith("/api/direct-entry/catalog")) {
      return new Response(JSON.stringify({ ok: true, projects: [], recruiters: [], banks: [] }), { status: 200 });
    }
    if (urlStr.startsWith("/api/admin/worker-edit-history?")) {
      return new Response(JSON.stringify({ ok: true, data: { rows: [rowC], has_more: false, next_cursor: null } }), { status: 200 });
    }
    if (urlStr === `/api/admin/worker-edit-history/${ENTRY_ID}/${REV_ID}`) {
      return new Response(JSON.stringify({ ok: false, code: "INTERNAL_ERROR" }), { status: 500 });
    }
    return new Response(JSON.stringify({ ok: false, code: "NOT_FOUND" }), { status: 404 });
  };

  const mounted = mountComponent(WorkerEditHistoryManager);
  await mounted.flush();

  findNodes(mounted.tree, (n) => n.type === "input" && n.props.id === "worker-edit-history-employee-code")[0]
    .props.onChange({ target: { value: "HRP-2026-000500" } });
  await mounted.flush();
  findNodes(mounted.tree, (n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  await mounted.flush();

  findNodes(mounted.tree, (n) => n.type === "button" && collectText(n) === "Xem v1")[0].props.onClick({ currentTarget: null });
  await mounted.flush();

  const dialog = findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog")[0];
  assert.ok(dialog);
  const dialogAlerts = findNodes(dialog, (n) => n.props?.["data-ui"] === "Alert" && n.props?.["data-tone"] === "error");
  assert.equal(dialogAlerts.length, 1);
  assert.match(collectText(dialogAlerts[0]), /Không tải được dữ liệu lịch sử/);

  // List rows and filters remain intact behind the dialog
  assert.equal(findNodes(mounted.tree, (n) => n.type === "input" && n.props.id === "worker-edit-history-employee-code")[0].props.value, "HRP-2026-000500");
  assert.equal(findNodes(mounted.tree, (n) => n.type === "tr").length, 2); // header + rowC

  mounted.unmount();
});

test("UI: FormDialog restores focus with preventScroll=true on Đóng button and Esc close, and Tải thêm works after close", async () => {
  const { WorkerEditHistoryManager } = repoRequire("./src/components/admin/worker-edit-history-manager.tsx");

  const fetchedUrls = [];
  const row1 = makeSearchRow({
    revision_id: REV_ID,
    version: 2,
    employee_code: "HRP-2026-000777",
  });
  const row2 = makeSearchRow({
    revision_id: REV_ID_2,
    version: 1,
    employee_code: "HRP-2026-000777",
  });

  const page2Cursor = "2026-11-10T03:00:00.000000Z|22222222-2222-4222-8222-222222222222";
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    fetchedUrls.push(urlStr);
    if (urlStr.startsWith("/api/direct-entry/catalog")) {
      return new Response(JSON.stringify({ ok: true, projects: [], recruiters: [], banks: [] }), { status: 200 });
    }
    if (urlStr.startsWith("/api/admin/worker-edit-history?")) {
      const parsed = new URL(`https://app.example${urlStr}`);
      if (!parsed.searchParams.get("cursor")) {
        return new Response(JSON.stringify({
          ok: true,
          data: { rows: [row1], has_more: true, next_cursor: page2Cursor },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        data: { rows: [row2], has_more: false, next_cursor: null },
      }), { status: 200 });
    }
    if (urlStr === `/api/admin/worker-edit-history/${ENTRY_ID}/${REV_ID}`) {
      return new Response(JSON.stringify({ ok: true, data: makeRevisionPayload() }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, code: "NOT_FOUND" }), { status: 404 });
  };

  const mounted = mountComponent(WorkerEditHistoryManager);
  await mounted.flush();

  findNodes(mounted.tree, (n) => n.type === "input" && n.props.id === "worker-edit-history-employee-code")[0]
    .props.onChange({ target: { value: "HRP-2026-000777" } });
  await mounted.flush();
  findNodes(mounted.tree, (n) => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  await mounted.flush();

  const focusCalls = [];
  const mockOpenerButton = {
    isConnected: true,
    focus(opts) {
      focusCalls.push(opts);
    },
  };

  // 1. Open and close via sticky footer "Đóng" button -> focus restored with { preventScroll: true }
  findNodes(mounted.tree, (n) => n.type === "button" && collectText(n) === "Xem v2")[0].props.onClick({ currentTarget: mockOpenerButton });
  await mounted.flush();
  let dialog = findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog")[0];
  assert.ok(dialog);
  findNodes(dialog, (n) => n.type === "button" && collectText(n) === "Đóng")[0].props.onClick();
  await mounted.flush();
  assert.equal(findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog").length, 0);
  assert.deepEqual(focusCalls, [{ preventScroll: true }]);

  // 2. Open again and close via Esc (onEscapeKeyDown -> onOpenChange(false) + onCloseAutoFocus) -> focus restored with { preventScroll: true }
  findNodes(mounted.tree, (n) => n.type === "button" && collectText(n) === "Xem v2")[0].props.onClick({ currentTarget: mockOpenerButton });
  await mounted.flush();
  dialog = findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog")[0];
  assert.ok(dialog);
  dialog.props.onEscapeKeyDown();
  await mounted.flush();
  assert.equal(findNodes(mounted.tree, (n) => n.props?.["data-ui"] === "FormDialog").length, 0);
  assert.deepEqual(focusCalls, [{ preventScroll: true }, { preventScroll: true }]);

  // 3. Click Tải thêm after closing -> appends page 2 cleanly with preserved filters
  const loadMoreBtn = findNodes(mounted.tree, (n) => n.type === "button" && collectText(n) === "Tải thêm")[0];
  assert.ok(loadMoreBtn);
  loadMoreBtn.props.onClick();
  await mounted.flush();

  const historyFetches = fetchedUrls.filter((u) => u.startsWith("/api/admin/worker-edit-history?"));
  assert.equal(historyFetches.length, 2);
  const page2Params = new URL(`https://app.example${historyFetches[1]}`).searchParams;
  assert.equal(page2Params.get("employee_code"), "HRP-2026-000777");
  assert.equal(page2Params.get("cursor"), page2Cursor);
  assert.equal(findNodes(mounted.tree, (n) => n.type === "tr").length, 3); // header + row1 + row2

  mounted.unmount();
});
