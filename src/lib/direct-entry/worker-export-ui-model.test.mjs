/**
 * Pure model cho "Xuat Excel" (recruited / managed / all).
 *
 * Pham vi: dung scope, map filter/reason theo contract, defer row authority to the server,
 * taxonomy loi 400/401/403/404/422/5xx + loi mang, filename an toan. Khong lo PII/UUID/raw DB.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_XLSX_ZIP_BYTES,
  WORKER_EXPORT_FALLBACK_LIMIT,
  WORKER_EXPORT_REASON_MAX,
  WORKER_EXPORT_SCOPES,
  buildWorkerExportRequest,
  canExportAllWorkers,
  canExportWorkers,
  exportScopeForTab,
  hasXlsxZipSignature,
  isExportableScope,
  isUsableWorkerExportBlob,
  isWorkerExportScope,
  workerExportErrorMessage,
  workerExportFilename,
  workerExportRequestMessage,
  workerExportRowLimit,
} from "./worker-export-ui-model.ts";

const EMPTY_FILTERS = { status: "", projectId: "", recruiterId: "" };

test("T1A: recruited|managed|team|all duoc xuat, uploader thi khong", () => {
  assert.deepEqual([...WORKER_EXPORT_SCOPES], ["recruited", "managed", "team", "all"]);
  assert.equal(isWorkerExportScope("recruited"), true);
  assert.equal(isWorkerExportScope("managed"), true);
  assert.equal(isWorkerExportScope("team"), true);
  assert.equal(isWorkerExportScope("all"), true);
  assert.equal(isWorkerExportScope("uploader"), false);
  assert.equal(isWorkerExportScope(null), false);
  // Tab -> scope: uploader KHONG xuat; all xuat (quyen server se quyet).
  assert.equal(exportScopeForTab("recruited"), "recruited");
  assert.equal(exportScopeForTab("managed"), "managed");
  assert.equal(exportScopeForTab("team"), "team");
  assert.equal(exportScopeForTab("all"), "all");
  assert.equal(exportScopeForTab("uploader"), null);
  assert.equal(isExportableScope("managed"), true);
  assert.equal(isExportableScope("all"), true);
  assert.equal(isExportableScope(null), false);
});

test("T1A: recruited gui dung body, filter rong => null", () => {
  const built = buildWorkerExportRequest({
    scope: "recruited", filters: EMPTY_FILTERS, reason: "  Kiểm tra định kỳ  ",
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.body, {
    scope: "recruited",
    project_id: null,
    recruiter_id: null,
    employment_status: null,
    search: null,
    first_work_date_from: null,
    first_work_date_to: null,
    provider_type: null,
    labor_type: null,
    reason: "Kiểm tra định kỳ",
  });
  assert.deepEqual(Object.keys(built.body).sort(), [
    "employment_status", "first_work_date_from", "first_work_date_to",
    "labor_type", "project_id", "provider_type", "reason", "recruiter_id", "scope", "search",
  ]);
});

test("action reason may be omitted and is canonicalized before export submission", () => {
  assert.deepEqual(buildWorkerExportRequest({ scope: "team", filters: EMPTY_FILTERS }), {
    ok: true, body: {
      scope: "team", project_id: null, recruiter_id: null,
      employment_status: null, search: null,
      first_work_date_from: null, first_work_date_to: null, provider_type: null,
      labor_type: null,
      reason: null,
    },
  });
});

test("T1A: managed gui dung body voi bo loc hien tai", () => {
  const built = buildWorkerExportRequest({
    scope: "managed",
    filters: {
      search: "  Nguyễn  ",
      status: "ON",
      projectId: "proj_a",
      recruiterId: "22222222-2222-4222-8222-222222222222",
      firstWorkDateFrom: "2026-10-01",
      firstWorkDateTo: "2026-10-31",
      providerType: "hrp",
      laborType: "TEMPORARY",
    },
    reason: "Đối soát nhân sự dự án",
  });
  assert.equal(built.ok, true);
  assert.deepEqual(built.body, {
    scope: "managed",
    project_id: "proj_a",
    recruiter_id: "22222222-2222-4222-8222-222222222222",
    employment_status: "ON",
    search: "Nguyễn",
    first_work_date_from: "2026-10-01",
    first_work_date_to: "2026-10-31",
    provider_type: "hrp",
    labor_type: "TEMPORARY",
    reason: "Đối soát nhân sự dự án",
  });
});

test("T1A: scope all/team duoc gui; invalid scope va reason bi tu choi fail-closed", () => {
  const nullFilterBody = {
    project_id: null, recruiter_id: null, employment_status: null,
    search: null, first_work_date_from: null, first_work_date_to: null, provider_type: null,
    labor_type: null,
  };
  assert.deepEqual(buildWorkerExportRequest({ scope: "all", filters: EMPTY_FILTERS, reason: "x" }),
    { ok: true, body: { scope: "all", ...nullFilterBody, reason: "x" } });
  assert.deepEqual(buildWorkerExportRequest({ scope: "team", filters: EMPTY_FILTERS, reason: null }),
    { ok: true, body: { scope: "team", ...nullFilterBody, reason: null } });
  assert.deepEqual(buildWorkerExportRequest({ scope: "everything", filters: EMPTY_FILTERS, reason: "x" }),
    { ok: false, code: "SCOPE_INVALID" });
  assert.deepEqual(buildWorkerExportRequest({ scope: "", filters: EMPTY_FILTERS, reason: "x" }),
    { ok: false, code: "SCOPE_INVALID" });
  assert.deepEqual(buildWorkerExportRequest({ scope: "recruited", filters: EMPTY_FILTERS, reason: "   " }),
    { ok: true, body: { scope: "recruited", ...nullFilterBody, reason: null } });
  assert.deepEqual(buildWorkerExportRequest({ scope: "recruited", filters: EMPTY_FILTERS, reason: "" }),
    { ok: true, body: { scope: "recruited", ...nullFilterBody, reason: null } });
  assert.deepEqual(buildWorkerExportRequest({
    scope: "recruited", filters: EMPTY_FILTERS, reason: "x".repeat(WORKER_EXPORT_REASON_MAX + 1),
  }), { ok: false, code: "REASON_TOO_LONG" });
  // Mot status la se bi am tham loai bo => xuat thua; phai tu choi.
  assert.deepEqual(buildWorkerExportRequest({
    scope: "recruited", filters: { status: "MAYBE", projectId: "", recruiterId: "" }, reason: "x",
  }), { ok: false, code: "FILTER_INVALID" });
  assert.deepEqual(buildWorkerExportRequest({
    scope: "recruited",
    filters: {
      ...EMPTY_FILTERS,
      firstWorkDateFrom: "2026-10-15",
      firstWorkDateTo: "2026-10-01",
    },
    reason: "x",
  }), { ok: false, code: "FILTER_INVALID" });
  assert.deepEqual(buildWorkerExportRequest({
    scope: "recruited",
    filters: {
      ...EMPTY_FILTERS,
      laborType: "bad-key",
    },
    reason: "x",
  }), { ok: false, code: "FILTER_INVALID" });
});

test("T1A: request error copy sanitized", () => {
  for (const message of [
    workerExportRequestMessage("SCOPE_INVALID"),
    workerExportRequestMessage("REASON_INVALID"),
    workerExportRequestMessage("REASON_TOO_LONG"),
    workerExportRequestMessage("FILTER_INVALID"),
  ]) {
    assert.ok(message.length > 0);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(message), false, "khong lo UUID");
    assert.equal(/42501|P0002|SQLSTATE|postgres/i.test(message), false, "khong lo raw DB");
  }
  assert.ok(workerExportRequestMessage("REASON_TOO_LONG").includes(String(WORKER_EXPORT_REASON_MAX)));
});

test("export UI allows resolved actors to request directory export", () => {
  const scopes = [{ kind: "own" }];
  assert.equal(canExportWorkers(null), false);
  assert.equal(canExportWorkers({ capabilities: [], scopes }), true,
    "the server RPC enforces row authority, not export capability grants");
  assert.equal(canExportWorkers({ capabilities: ["entry_admin"], scopes: [{ kind: "all" }] }), true);
});

test("all-scope export needs current all scope and an existing admin/reviewer action", () => {
  assert.equal(canExportAllWorkers(null), false);
  assert.equal(canExportAllWorkers({ capabilities: ["entry_admin"], scopes: [{ kind: "own" }] }), false);
  assert.equal(canExportAllWorkers({ capabilities: [], scopes: [{ kind: "all" }] }), false,
    "thieu entry_admin/change_review => khong xuat all");
  assert.equal(canExportAllWorkers({
    capabilities: ["entry_admin"], scopes: [{ kind: "all" }] }), true);
  assert.equal(canExportAllWorkers({
    capabilities: ["change_review"], scopes: [{ kind: "all" }] }), true);
});

test("T1A: 422 row-limit bao ro gioi han, khong tai file thieu dong", () => {
  assert.equal(workerExportRowLimit({ ok: false, code: "WORKER_EXPORT_ROW_LIMIT_EXCEEDED", limit: 10000 }),
    WORKER_EXPORT_FALLBACK_LIMIT);
  assert.equal(workerExportRowLimit({ limit: 250 }), 250);
  // limit sai kieu/khong hop le => fallback, khong bao gio NaN.
  assert.equal(workerExportRowLimit({ limit: "10000" }), WORKER_EXPORT_FALLBACK_LIMIT);
  assert.equal(workerExportRowLimit({ limit: 0 }), WORKER_EXPORT_FALLBACK_LIMIT);
  assert.equal(workerExportRowLimit(null), WORKER_EXPORT_FALLBACK_LIMIT);
  const message = workerExportErrorMessage(422,
    { ok: false, code: "WORKER_EXPORT_ROW_LIMIT_EXCEEDED", limit: 10000 });
  assert.match(message, /10000/);
  assert.match(message, /vượt giới hạn/i);
  assert.match(message, /thu hẹp bộ lọc/i);
});

test("T1A: taxonomy loi 400/401/403/404/5xx/mang, khong lo PII/raw DB", () => {
  const cases = [
    [401, null], [403, { ok: false, code: "WORKER_EXPORT_DENIED" }],
    [404, { ok: false, code: "NOT_FOUND" }],
    [400, { ok: false, code: "WORKER_EXPORT_REQUEST_INVALID" }],
    [503, { ok: false, code: "WORKER_EXPORT_UNAVAILABLE" }],
    [0, null], [500, null],
  ];
  for (const [status, payload] of cases) {
    const message = workerExportErrorMessage(status, payload);
    assert.ok(message.length > 0, "status " + status);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(message), false, "khong lo UUID: " + message);
    assert.equal(/42501|P0002|SQLSTATE|postgres/i.test(message), false, "khong lo raw DB: " + message);
    // Khong bao gio echo raw response body.
    assert.equal(/WORKER_EXPORT_DENIED|NOT_FOUND/.test(message), false, "khong lo raw code: " + message);
  }
});

test("T1A: filename uu tien server, fallback co dinh, chan path traversal", () => {
  assert.equal(
    workerExportFilename('attachment; filename="danh-sach-nguoi-lao-dong-2026-10-13.xlsx"', "2026-10-13"),
    "danh-sach-nguoi-lao-dong-2026-10-13.xlsx");
  // Thieu header / header la => fallback theo ngay.
  assert.equal(workerExportFilename(null, "2026-10-13"), "danh-sach-nguoi-lao-dong-2026-10-13.xlsx");
  assert.equal(workerExportFilename("attachment", "2026-10-13"), "danh-sach-nguoi-lao-dong-2026-10-13.xlsx");
  // Path traversal / ten sai duoi => fallback, khong bao gio tra basename ngoai.
  assert.equal(workerExportFilename('attachment; filename="../../etc/passwd"', "2026-10-13"),
    "danh-sach-nguoi-lao-dong-2026-10-13.xlsx");
  assert.equal(workerExportFilename('attachment; filename="evil.exe"', "2026-10-13"),
    "danh-sach-nguoi-lao-dong-2026-10-13.xlsx");
  // fallbackDate sai => dung ngay hom nay (khong lo gia tri la).
  assert.match(workerExportFilename(null, "not-a-date"), /^danh-sach-nguoi-lao-dong-[0-9]{4}-[0-9]{2}-[0-9]{2}\.xlsx$/);
});

test("UIUX-S2-06: isUsableWorkerExportBlob verifies PK\\x03\\x04 ZIP header and rejects HTTP 200 corrupt binary or error octet-stream", async () => {
  const errOctetBlob = new Blob(
    ['{"ok":false,"code":"INTERNAL_ERROR","detail":"unexpected stream failure"}'],
    { type: "application/octet-stream" },
  );
  assert.equal(await isUsableWorkerExportBlob(errOctetBlob, "application/octet-stream"), false);

  const corruptXlsxBlob = new Blob([new Uint8Array(64).fill(0xab)], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  assert.equal(
    await isUsableWorkerExportBlob(
      corruptXlsxBlob,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    false,
  );

  const zipBytes = new Uint8Array(Math.max(48, MIN_XLSX_ZIP_BYTES));
  zipBytes.set([0x50, 0x4b, 0x03, 0x04], 0);
  assert.equal(hasXlsxZipSignature(zipBytes), true);
  assert.equal(
    await isUsableWorkerExportBlob(
      new Blob([zipBytes], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
    true,
  );
});

test("WP8C-1: canExportAllWorkers enforces paired (entry_admin | change_review) @ ALL when effective_grants is present", () => {
  const TEAM_1 = "11111111-1111-4111-8111-111111111111";

  // 1. Mirror-cleared legacy arrays with paired entry_admin @ ALL or change_review @ ALL -> true
  assert.equal(
    canExportAllWorkers({
      capabilities: [],
      scopes: [],
      effective_grants: [
        { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      ],
    }),
    true,
  );
  assert.equal(
    canExportAllWorkers({
      capabilities: [],
      scopes: [],
      effective_grants: [
        { capability: "change_review", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      ],
    }),
    true,
  );

  // 2. Cross-scope drift, stale legacy arrays, and malformed effective_grants -> false
  assert.equal(
    canExportAllWorkers({
      capabilities: ["entry_admin", "audit_view"],
      scopes: [{ kind: "all" }, { kind: "team" }],
      effective_grants: [
        { capability: "entry_admin", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "DIRECT_GRANT", source_id: null },
        { capability: "audit_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      ],
    }),
    false,
  );
  assert.equal(
    canExportAllWorkers({
      capabilities: ["change_review", "document_view"],
      scopes: [{ kind: "all" }, { kind: "team" }],
      effective_grants: [
        { capability: "change_review", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "DIRECT_GRANT", source_id: null },
        { capability: "document_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
      ],
    }),
    false,
  );
  assert.equal(
    canExportAllWorkers({
      capabilities: ["entry_admin", "change_review"],
      scopes: [{ kind: "all" }],
      effective_grants: [],
    }),
    false,
  );
  assert.equal(
    canExportAllWorkers({
      capabilities: ["entry_admin"],
      scopes: [{ kind: "all" }],
      effective_grants: [null, undefined, "bad"],
    }),
    false,
  );
  assert.equal(
    canExportAllWorkers({
      capabilities: ["entry_admin"],
      scopes: [{ kind: "all" }],
      effective_grants: null,
    }),
    false,
  );

  // 3. Dual-role HR_OPERATOR @ ALL + TEAM_LEADER @ CONTEXT_TEAM -> false
  assert.equal(
    canExportAllWorkers({
      capabilities: [
        "recruiter_master_manage",
        "team_master_manage",
        "catalog_master_manage",
        "audit_view",
        "document_view",
        "entry_team",
        "team_manager_assign",
      ],
      scopes: [{ kind: "all" }, { kind: "team" }],
      effective_grants: [
        { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
        { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
        { capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
        { capability: "audit_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
        { capability: "document_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
        { capability: "entry_team", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
        { capability: "team_manager_assign", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "CONTEXTUAL_ASSIGNMENT", source_id: null },
      ],
    }),
    false,
  );
});
