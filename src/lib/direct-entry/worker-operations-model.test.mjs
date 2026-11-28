import assert from "node:assert/strict";
import test from "node:test";

import {
  BANK_ACCOUNT_SECTION_LABEL,
  DIRECT_EDIT_DOCUMENT_MAX_BYTES,
  DIRECT_EDIT_DOCUMENT_TYPES,
  WORKER_OPERATIONS_TABS,
  WORKER_OPERATIONS_TAB_LABELS,
  WORKER_PROPOSE_TARGETS,
  WORKER_PROPOSE_TARGET_LABELS,
  appendUnique,
  applyPage,
  bankAccountSummary,
  beginLoad,
  canAccessUploaderSubmissionsTab,
  canSelectQuickOffboardingWorker,
  canReviewChangeRequests,
  canViewGlobalChangeRequestHistory,
  checkDirectEditDocumentFile,
  directEditDocumentErrorMessage,
  emptyTabPage,
  EMPTY_WORKER_DIRECTORY_FILTERS,
  failLoad,
  fallbackWorkerTab,
  hasActiveWorkerDirectoryFilters,
  initialWorkerTab,
  isWorkerOperationsTab,
  parseChangeRequestPageResponse,
  parseSessionWorkerPermissionsResponse,
  reconcileWorkerOperationsPermissions,
  requestRowKey,
  requestsQuery,
  resetTabPage,
  resolveInitialWorkerTab,
  runDirectEditDocumentUploads,
  submissionRowKey,
  submissionsQuery,
  uploadDirectEditDocument,
  validateWorkerDirectoryDateRange,
  workerProviderTypeLabel,
  workerRowKey,
  workersQuery,
  lastDecisionLabel,
  parseSubmissionPageResponse,
  parseWorkerPageResponse,
  pendingRequestLabel,
  proposeCta,
  relationDenialIsEmpty,
  tabScope,
  visibleWorkerTabs,
  workerDenialMessage,
  workerListErrorMessage,
  workerStatusLabel,
  WORKER_LOAD_FAILED_MESSAGE,
  WORKER_NO_USABLE_TAB_MESSAGE,
  WORKER_OPERATIONS_INITIAL_TAB_PRIORITY,
  updateWorkerDirectoryFilter,
  VIETQR_BANK_CATALOG,
  buildDirectEditEntryFieldProposal,
  buildDirectEditPaymentPatch,
  buildDirectEditWorkerDetailsProposal,
  buildWorkerEditProjectOptions,
  buildWorkerEditRecruiterOptions,
  directEditWorkerFormFromBaseline,
  formatBankReferenceDisplay,
  initialDirectEditBankQueryText,
  mergeVietQrBankCatalog,
  resolveBankCatalogOption,
  toDirectEditDateInputValue,
} from "./worker-operations-model.ts";
import {
  resolveActor,
  validateClientBusinessPayload,
} from "../auth/direct-entry-v2.ts";
import {
  canReadWorkerDirectoryCatalog,
  directEntryNavPredicate,
  resolveAllowedWorkerOperationsTabs,
  workerOperationsNavPredicate,
} from "../navigation/registry-capability.ts";
import {
  decideDirectEntryPageAccess,
  decideWorkerOperationsPageAccess,
} from "../auth/direct-entry-page-access.ts";
import { createDirectEntrySessionResponse } from "./session-bootstrap.ts";
import { listWorkers } from "./worker-directory-api.ts";
import { listOwnSubmissions } from "./submission-read-api.ts";

const AUTH = "2026-10-08";
const ENTRY = "11111111-1111-4111-8111-111111111111";
const RECRUITER = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";

function actions(overrides = {}) {
  return { view: true, view_pii: true, view_payment: true,
    propose_change: false, propose_change_code: "NOT_PROJECT_MANAGER", direct_edit: false, ...overrides };
}
function row(overrides = {}) {
  return {
    entry_id: ENTRY, entry_version: 3, submission_state: "SUBMITTED",
    employee_code: "hrp-2026-300001", display_name: "Nguyen Van A",
    project_id: "proj_1", project_display: "Du an 1", first_work_date: "2026-10-01",
    labor_type: "TEMPORARY", labor_type_display: "Thời vụ",
    employment_status: "ON", recruiter_id: RECRUITER,
    recruiter_display: "Tran Thi B", payment: null, pending_request: null,
    last_decision: null, is_project_manager: false, allowed_actions: actions(),
    ...overrides,
  };
}
function page(items) {
  return { ok: true, items, scope: "recruited", page_size: 25, has_more: false,
    next_cursor: null, authorization_date: AUTH,
    summary: { total_workers: items.length, project_count: 1, recruiter_count: 1 } };
}

test("W06-R1: bon view khong tron quan he; scope=all chi khi server cho phep", () => {
  assert.deepEqual([...WORKER_OPERATIONS_TABS], ["uploader", "recruited", "managed", "team", "all"]);
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.uploader, "Tôi đã nhập");
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.recruited, "Người tôi tuyển");
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.managed, "Dự án tôi quản lý");
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.team, "Team tôi quản lý");
  assert.equal(WORKER_OPERATIONS_TAB_LABELS.all, "Toàn bộ NLĐ");
  assert.equal(tabScope("uploader"), null);
  assert.equal(tabScope("recruited"), "recruited");
  assert.equal(tabScope("managed"), "managed");
  assert.equal(tabScope("team"), "team");
  assert.equal(tabScope("all"), "all");
  assert.equal(isWorkerOperationsTab("recruited"), true);
  // Chi OFFER cac tab ma server xac nhan quyen doc that su; khong mac dinh bat uploader/recruited/managed.
  assert.deepEqual([...visibleWorkerTabs(false)], []);
  assert.deepEqual([...visibleWorkerTabs(true)], ["all"]);
  assert.deepEqual([...visibleWorkerTabs(false, true)], ["team"]);
  assert.deepEqual([...visibleWorkerTabs(true, true, true, true, true)], ["uploader", "recruited", "managed", "team", "all"]);
  assert.deepEqual([...visibleWorkerTabs({ allowedTabs: ["recruited", "team"] })], ["recruited", "team"]);
});

test("quick offboarding only selects editable ON or UNCONFIRMED workers", () => {
  assert.equal(canSelectQuickOffboardingWorker(row({
    employment_status: "ON", allowed_actions: actions({ direct_edit: true }),
  })), true);
  assert.equal(canSelectQuickOffboardingWorker(row({
    employment_status: "UNCONFIRMED", allowed_actions: actions({ direct_edit: true }),
  })), true);
  assert.equal(canSelectQuickOffboardingWorker(row({
    employment_status: "OFF", allowed_actions: actions({ direct_edit: true }),
  })), false);
  assert.equal(canSelectQuickOffboardingWorker(row({
    employment_status: "ON", allowed_actions: actions({ direct_edit: false }),
  })), false);
});

test("W06-R1: review queue chi khi change_review + all scope", () => {
  assert.equal(canReviewChangeRequests(null), false);
  assert.equal(canReviewChangeRequests({ capabilities: [], scopes: [{ kind: "all" }] }), false,
    "all scope thieu capability => khong mo");
  assert.equal(canReviewChangeRequests({ capabilities: ["change_review"], scopes: [{ kind: "team" }] }), false);
  assert.equal(canReviewChangeRequests({ capabilities: ["change_review"], scopes: [{ kind: "all" }] }), true);
});

test("PRE-W2 global change history is limited to global reviewers and admins", () => {
  assert.equal(canViewGlobalChangeRequestHistory(null), false);
  assert.equal(canViewGlobalChangeRequestHistory(["change_review"], [{ kind: "team" }]), false);
  assert.equal(canViewGlobalChangeRequestHistory(["team_manager_assign"], [{ kind: "all" }]), false);
  assert.equal(canViewGlobalChangeRequestHistory(["change_review"], [{ kind: "all" }]), true);
  assert.equal(canViewGlobalChangeRequestHistory(["entry_admin"], [{ kind: "all" }]), true);
});

test("W06-R2: helper phan trang ton tai (0e2cbba khong co -> test that bai that su)", () => {
  // Cac ham nay duoc them o R2; o 0e2cbba khong ton tai nen assertion se fail.
  for (const fn of [initialWorkerTab, applyPage, beginLoad, failLoad, resetTabPage, emptyTabPage,
    appendUnique, workersQuery, submissionsQuery, requestsQuery, workerRowKey, submissionRowKey,
    requestRowKey, parseChangeRequestPageResponse]) {
    assert.equal(typeof fn, "function");
  }
});

test("W06-R2: initial tab tu actor projection — uu tien managed -> all -> team -> recruited -> uploader theo quyen that", () => {
  const all = [{ kind: "all" }];
  // Khong bao gio mac dinh managed = true hoac uploader = true khi server chua xac nhan.
  assert.equal(initialWorkerTab({ capabilities: ["change_review"], scopes: all }, true), "all");
  assert.equal(initialWorkerTab({ capabilities: ["entry_admin"], scopes: all }, true), "all");
  assert.equal(initialWorkerTab({ capabilities: ["change_request_create"], scopes: [{ kind: "own" }] }, false), null);
  assert.equal(initialWorkerTab({ capabilities: ["team_manager_assign"], scopes: [{ kind: "team" }] }, false, true), "team");
  assert.equal(initialWorkerTab({ capabilities: ["team_manager_assign"], scopes: [{ kind: "team" }] }, false), null);
  assert.equal(initialWorkerTab({ capabilities: ["entry_own"], scopes: [{ kind: "own" }] }, false), null);
  assert.equal(initialWorkerTab({ capabilities: ["entry_team"], scopes: [{ kind: "team" }] }, false), null);
  assert.equal(initialWorkerTab({ capabilities: ["change_review"], scopes: all }, false), null);
  // Khi co quyen managed that su => uu tien managed dau tien:
  assert.equal(initialWorkerTab({ capabilities: ["change_review"], scopes: all }, true, true, true, true, true), "managed");
  assert.equal(initialWorkerTab({ capabilities: ["change_review"], scopes: all }, true, false, false), "all");
  assert.equal(initialWorkerTab({ capabilities: ["team_manager_assign"], scopes: [{ kind: "team" }] }, false, true, false), "team");
  assert.equal(initialWorkerTab({ capabilities: ["entry_own"], scopes: [{ kind: "own" }] }, false, false, false, true, false), "recruited");
  assert.equal(initialWorkerTab({ capabilities: ["submission_create"], scopes: [{ kind: "own" }] }, false, false, false, false, true), "uploader");
  assert.equal(initialWorkerTab(null, false), null);
  assert.equal(fallbackWorkerTab({ capabilities: ["entry_admin"], scopes: all }, true, false), "all");
});

test("W06-R2: append page dedupe theo stable id, khong trung/khong sot", () => {
  const page1 = { items: [row(), row({ entry_id: "22222222-2222-4222-8222-222222222222" })],
    next_cursor: "2026-10-08T12:00:00.000000Z|11111111-1111-4111-8111-111111111111", has_more: true };
  const after1 = applyPage(emptyTabPage(), page1, workerRowKey, false);
  assert.equal(after1.items.length, 2);
  assert.equal(after1.hasMore, true);
  assert.equal(after1.cursor, page1.next_cursor);
  assert.equal(after1.state, "ready");
  // Page 2 lap lai row dau + them row moi => khong trung, khong sot.
  const page2 = { items: [row(), row({ entry_id: "33333333-3333-4333-8333-333333333333" })],
    next_cursor: null, has_more: false };
  const after2 = applyPage(after1, page2, workerRowKey, true);
  assert.equal(after2.items.length, 3);
  assert.deepEqual(after2.items.map(workerRowKey), [
    row().entry_id, "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333"]);
  assert.equal(after2.hasMore, false);
  assert.equal(after2.cursor, null);
  // Khong append => thay the hoan toan.
  const replaced = applyPage(after2, page2, workerRowKey, false);
  assert.equal(replaced.items.length, 2);
});

test("W06-R2: doi tab/filter reset cursor; beginLoad(append) giu items", () => {
  const loaded = applyPage(emptyTabPage(), { items: [row()],
    next_cursor: "2026-10-08T12:00:00.000000Z|11111111-1111-4111-8111-111111111111", has_more: true },
    workerRowKey, false);
  const reset = resetTabPage();
  assert.deepEqual(reset.items, []);
  assert.equal(reset.cursor, null);
  assert.equal(reset.hasMore, false);
  assert.equal(reset.state, "loading");
  assert.equal(beginLoad(loaded, true).items.length, 1, "tai them giu items");
  assert.equal(beginLoad(loaded, true).cursor, loaded.cursor);
  assert.equal(beginLoad(loaded, false).items.length, 0, "tai lai xoa items");
  assert.equal(beginLoad(loaded, false).cursor, null);
});

test("W06-R2: loi khi tai KHONG xoa page da tai thanh cong", () => {
  const loaded = applyPage(emptyTabPage(), { items: [row()], next_cursor: null, has_more: false },
    workerRowKey, false);
  const failed = failLoad(loaded, "error", "loi tam thoi");
  assert.equal(failed.items.length, 1, "giu du lieu da tai");
  assert.equal(failed.state, "ready");
  assert.equal(failed.message, "loi tam thoi");
  // Page rong thi giu trang thai loi.
  const emptyFailed = failLoad(emptyTabPage(), "denied", "khong co quyen");
  assert.equal(emptyFailed.state, "denied");
  assert.equal(emptyFailed.items.length, 0);
});

test("W06-R2: query builder chi gui cursor khi co (khong mang cursor scope cu)", () => {
  assert.equal(workersQuery({ scope: "recruited", status: "", cursor: null }),
    "?scope=recruited&page_size=25");
  assert.equal(workersQuery({ scope: "all", status: "ON", cursor: "c1" }),
    "?scope=all&page_size=25&employment_status=ON&cursor=c1");
  assert.equal(workersQuery({ scope: "managed", search: "  Nguyễn  ", status: "ON",
    projectId: "proj_a", recruiterId: RECRUITER,
    firstWorkDateFrom: "2026-10-01", firstWorkDateTo: "2026-10-31", providerType: "hrp",
    laborType: "SEASONAL_ONCALL",
    cursor: null }),
  "?scope=managed&page_size=25&employment_status=ON&search=Nguy%E1%BB%85n&project_id=proj_a&recruiter_id=" +
    RECRUITER + "&first_work_date_from=2026-10-01&first_work_date_to=2026-10-31&provider_type=hrp&labor_type=SEASONAL_ONCALL");
  assert.equal(submissionsQuery(null), "?page_size=25");
  assert.equal(submissionsQuery("c2"), "?page_size=25&cursor=c2");
  assert.equal(requestsQuery(null), "?page_size=20&state=PENDING");
  assert.equal(requestsQuery("c3"), "?page_size=20&state=PENDING&cursor=c3");
  assert.equal(requestsQuery(null, "RESOLVED"), "?page_size=20&state=RESOLVED");
  assert.equal(workersQuery({ scope: "managed", status: "", cursor: null }).includes("cursor"), false);
  assert.equal(validateWorkerDirectoryDateRange({ firstWorkDateFrom: "", firstWorkDateTo: "" }), null);
  assert.equal(validateWorkerDirectoryDateRange({ firstWorkDateFrom: "2026-10-01", firstWorkDateTo: "2026-10-31" }), null);
  assert.match(
    validateWorkerDirectoryDateRange({ firstWorkDateFrom: "2026-10-31", firstWorkDateTo: "2026-10-01" }) ?? "",
    /Từ ngày.*Đến ngày/,
  );
  assert.equal(hasActiveWorkerDirectoryFilters(EMPTY_WORKER_DIRECTORY_FILTERS), false);
  assert.equal(hasActiveWorkerDirectoryFilters({ ...EMPTY_WORKER_DIRECTORY_FILTERS, providerType: "vendor" }), true);
  assert.equal(hasActiveWorkerDirectoryFilters({ ...EMPTY_WORKER_DIRECTORY_FILTERS, laborType: "TEMPORARY" }), true);
  assert.equal(workerProviderTypeLabel("hrp"), "HRP");
  assert.equal(workerProviderTypeLabel("vendor"), "Vendor");
  assert.equal(workerProviderTypeLabel(""), "Tất cả");
});

test("HF-R4: project, recruiter, and laborType filters stay server-side and reset the page cursor", () => {
  const loaded = applyPage(emptyTabPage(), {
    items: [row()], next_cursor: "2026-10-08T12:00:00.000000Z|11111111-1111-4111-8111-111111111111",
    has_more: true,
  }, workerRowKey, false);
  const changed = updateWorkerDirectoryFilter({
    page: loaded,
    filters: { search: "000021", status: "ON", projectId: "old-project", recruiterId: RECRUITER, laborType: "" },
    field: "projectId",
    value: "new-project",
  });
  assert.deepEqual(changed.filters, {
    search: "000021", status: "ON", projectId: "new-project", recruiterId: RECRUITER, laborType: "",
  });
  assert.deepEqual(changed.page, {
    items: [], cursor: null, hasMore: false, state: "loading", message: null,
  });
  assert.equal(workersQuery({ scope: "managed", ...changed.filters,
    cursor: "next:cursor" }),
  "?scope=managed&page_size=25&employment_status=ON&search=000021&project_id=new-project&recruiter_id=" +
    RECRUITER + "&cursor=next%3Acursor");

  const laborChanged = updateWorkerDirectoryFilter({
    page: loaded,
    filters: changed.filters,
    field: "laborType",
    value: "PERMANENT",
  });
  assert.equal(laborChanged.filters.laborType, "PERMANENT");
  assert.equal(laborChanged.page.cursor, null, "laborType change resets the pagination cursor");
  assert.deepEqual(laborChanged.page.items, []);

  const searchChanged = updateWorkerDirectoryFilter({
    page: loaded,
    filters: laborChanged.filters,
    field: "search",
    value: "Nguyễn",
  });
  assert.equal(searchChanged.filters.search, "Nguyễn");
  assert.equal(searchChanged.page.cursor, null, "search change resets the pagination cursor");
  assert.deepEqual(searchChanged.page.items, []);
});

test("W06-R2: review payload phai qua projectChangeRequestListPage, fail-closed", () => {
  const valid = { ok: true, requests: [{
    request_id: REQUEST, state: "PENDING", version: 2,
    created_at: "2026-10-01T00:00:00.000000Z", item_count: 1, entry_ids: [ENTRY],
    can_withdraw: false, can_decide: true,
    proposer_display_name: "Admin", summary: "Trạng thái làm việc" }],
    page_size: 20, has_more: false, next_cursor: null };
  const parsed = parseChangeRequestPageResponse(valid, { page_size: 20 });
  assert.equal(parsed.requests.length, 1);
  assert.equal(parsed.requests[0].can_decide, true);
  // Malformed envelope / item / cursor => null (khong cast raw).
  assert.equal(parseChangeRequestPageResponse({ ok: false }, { page_size: 20 }), null);
  assert.equal(parseChangeRequestPageResponse({ ok: true, requests: [{}], page_size: 20,
    has_more: false, next_cursor: null }, { page_size: 20 }), null);
  assert.equal(parseChangeRequestPageResponse({ ok: true, requests: [], page_size: 20,
    has_more: true, next_cursor: null }, { page_size: 20 }), null, "has_more phai co cursor");
  assert.equal(parseChangeRequestPageResponse({ ok: true, requests: [], page_size: 20,
    has_more: false, next_cursor: "raw" }, { page_size: 20 }), null, "cursor sai dinh dang");
  assert.equal(parseChangeRequestPageResponse({ ok: true, requests: [], page_size: 20,
    has_more: false }, { page_size: 20 }), null, "thieu next_cursor");
});

test("W06-R2: malformed worker/submission envelope fail-closed", () => {
  assert.equal(parseWorkerPageResponse({ ok: true, items: [], scope: "all", page_size: 25,
    has_more: true, next_cursor: null, authorization_date: AUTH,
    summary: { total_workers: 0, project_count: 0, recruiter_count: 0 } },
    { scope: "all", page_size: 25 }), null, "has_more phai co cursor");
  assert.equal(parseWorkerPageResponse({ ok: true, items: [], scope: "all", page_size: 25,
    has_more: false, next_cursor: null, summary: { total_workers: 0, project_count: 0,
      recruiter_count: 0 } }, { scope: "all", page_size: 25 }), null,
    "thieu authorization_date");
  assert.equal(parseWorkerPageResponse({ ok: true, items: [], scope: "all", page_size: 25,
    has_more: false, next_cursor: null, authorization_date: AUTH },
  { scope: "all", page_size: 25 }), null, "missing summary fails closed");
  assert.equal(parseSubmissionPageResponse({ ok: true, items: [], page_size: 25,
    has_more: true, next_cursor: null }, { page_size: 25 }), null);
});
test("W06-R1: propose targets chi gom WORKER/PAYMENT/WORK_STATUS (khong DOCUMENT/CCCD)", () => {
  assert.deepEqual([...WORKER_PROPOSE_TARGETS], ["WORKER", "PAYMENT", "WORK_STATUS"]);
  for (const target of WORKER_PROPOSE_TARGETS) {
    const label = WORKER_PROPOSE_TARGET_LABELS[target];
    assert.ok(label.length > 0);
    assert.equal(/thanh toán|chi tiền|giao dịch|CCCD|tài liệu/i.test(label), false, label);
  }
  assert.equal(WORKER_PROPOSE_TARGET_LABELS.PAYMENT, "Thông tin tài khoản ngân hàng");
});

test("W06: CTA chi hien khi server tra propose_change=true; nguoc lai VANG MAT", () => {
  const pm = proposeCta(row({ is_project_manager: true,
    allowed_actions: actions({ propose_change: true, propose_change_code: null }) }));
  assert.equal(pm.show, true);
  assert.equal(pm.code, null);
  assert.equal(pm.message, null);

  const viewer = proposeCta(row());
  assert.equal(viewer.show, false, "khong co quyen => khong render CTA");
  assert.equal(viewer.code, "NOT_PROJECT_MANAGER");
  assert.match(viewer.message, /chỉ có thể xem/i);
  assert.equal(viewer.message.includes(REQUEST), false);
  assert.equal(viewer.message.includes(ENTRY), false);
});

test("W06: uploader/recruiter khong phai PM khong co CTA du co recruiter_id", () => {
  const uploader = row({ is_project_manager: false });
  assert.equal(proposeCta(uploader).show, false);
  const recruiter = row({ is_project_manager: false,
    allowed_actions: actions({ propose_change: false, propose_change_code: "NOT_PROJECT_MANAGER" }) });
  assert.equal(proposeCta(recruiter).show, false);
});

test("W06: copy tu choi sanitized, khong lo UUID/raw DB", () => {
  for (const code of ["NOT_PROJECT_MANAGER", "NOT_SUBMITTED", null, "SOMETHING_RAW"]) {
    const message = workerDenialMessage(code);
    assert.ok(message.length > 0);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(message), false, "khong lo UUID");
    assert.equal(/42501|P0002|SQLSTATE|postgres/i.test(message), false, "khong lo raw DB");
  }
  for (const status of [400, 401, 403, 500]) {
    const message = workerListErrorMessage(status);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(message), false);
  }
});

test("HF-R5A: moi loi tai du lieu deu co copy sanitized, khong bao gio im lang", () => {
  // Truoc R5A: 5xx/network tra message null => "Tai them" that bai khong hien gi.
  for (const status of [500, 502, 503, 504]) {
    assert.equal(workerListErrorMessage(status), WORKER_LOAD_FAILED_MESSAGE);
  }
  assert.ok(WORKER_LOAD_FAILED_MESSAGE.length > 0);
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/i.test(WORKER_LOAD_FAILED_MESSAGE), false);
  // Tai them that bai: GIU rows da tai (state ready) nhung VAN phai co message cho UI bao.
  const loaded = applyPage(emptyTabPage(), {
    items: [{ id: "a" }], next_cursor: "n", has_more: true,
  }, (item) => item.id, false);
  assert.equal(loaded.state, "ready");
  const failed = failLoad(loaded, "unavailable", WORKER_LOAD_FAILED_MESSAGE);
  assert.equal(failed.state, "ready");
  assert.deepEqual(failed.items, [{ id: "a" }]);
  assert.equal(failed.message, WORKER_LOAD_FAILED_MESSAGE);
  // Trang dau that bai: khong co du lieu thi giu nguyen state loi, van co message.
  const emptyFailure = failLoad(emptyTabPage(), "unavailable", WORKER_LOAD_FAILED_MESSAGE);
  assert.equal(emptyFailure.state, "unavailable");
  assert.equal(emptyFailure.message, WORKER_LOAD_FAILED_MESSAGE);
});

test("W06-R3 / T1A: HTTP 403 luon fail-closed la tu choi quyen, khong bien thanh danh sach rong", () => {
  assert.equal(relationDenialIsEmpty("recruited", 403), false);
  assert.equal(relationDenialIsEmpty("managed", 403), false);
  assert.equal(relationDenialIsEmpty("team", 403), false);
  assert.equal(relationDenialIsEmpty("all", 403), false);
  assert.equal(relationDenialIsEmpty("managed", 500), false);
});

test("W06: pending/last decision doc tu server data", () => {
  assert.equal(pendingRequestLabel(row()), null);
  assert.match(pendingRequestLabel(row({ pending_request: { request_id: REQUEST, state: "PENDING", version: 2 } })),
    /chờ duyệt/i);
  assert.equal(lastDecisionLabel(row()), null);
  assert.match(lastDecisionLabel(row({ last_decision: { state: "APPROVED", decided_at: "2026-10-05T01:02:03.000000Z" } })),
    /Đã duyệt ngày 2026-10-05/);
  assert.match(lastDecisionLabel(row({ last_decision: { state: "REJECTED", decided_at: "2026-10-06T01:02:03.000000Z" } })),
    /Đã từ chối ngày 2026-10-06/);
});

test("W06: bank account copy dung nghiep vu, chi STK/ngan hang/chu tai khoan", () => {
  assert.equal(BANK_ACCOUNT_SECTION_LABEL, "Thông tin tài khoản ngân hàng");
  assert.equal(/thanh toán|chi tiền|giao dịch/i.test(BANK_ACCOUNT_SECTION_LABEL), false);
  assert.equal(bankAccountSummary(null), null);
  const summary = bankAccountSummary({ state: "provided", account_number: "****1234",
    bank_id: "VCB", account_holder_name: "NGUYEN VAN A", version: 2 });
  assert.deepEqual(summary, { state: "provided", accountNumber: "****1234",
    bankId: "VCB", accountHolder: "NGUYEN VAN A" });
  assert.equal(Object.keys(summary).includes("version"), false, "khong lo version ra UI");
});

test("W06: trang thai lam viec co nhan tieng Viet", () => {
  assert.equal(workerStatusLabel("ON"), "Đang làm");
  assert.equal(workerStatusLabel("OFF"), "Đã nghỉ");
  assert.equal(workerStatusLabel("UNCONFIRMED"), "Đang chờ việc");
  assert.equal(workerStatusLabel(null), "Chưa có trạng thái");
});

test("W06: parse worker page fail-closed, khong nhan shape sai", () => {
  const parsed = parseWorkerPageResponse(page([row()]), { scope: "recruited", page_size: 25 });
  assert.equal(parsed.items.length, 1);
  assert.equal(parseWorkerPageResponse({ ok: false }, { scope: "recruited", page_size: 25 }), null);
  assert.equal(parseWorkerPageResponse(page([]), { scope: "managed", page_size: 25 }), null,
    "scope lech => null");
  assert.equal(parseWorkerPageResponse(page([{}]), { scope: "recruited", page_size: 25 }), null);
});

test("W06: parse submission page fail-closed", () => {
  const item = { submission_id: REQUEST, state: "DRAFT", version: 2, entry_count: 1,
    created_at: "2026-10-01T00:00:00.000000Z", updated_at: "2026-10-02T00:00:00.000000Z",
    submitted_at: null, allowed_transitions: ["SUBMITTED"],
    project_scoped: false };
  const parsed = parseSubmissionPageResponse({ ok: true, items: [item], page_size: 25,
    has_more: false, next_cursor: null }, { page_size: 25 });
  assert.equal(parsed.items.length, 1);
  assert.equal(parseSubmissionPageResponse({ ok: true, items: [{}], page_size: 25,
    has_more: false, next_cursor: null }, { page_size: 25 }), null);
});

test("HF Worker Profile: checkDirectEditDocumentFile validates MIME and size per document type", () => {
  assert.deepEqual(DIRECT_EDIT_DOCUMENT_TYPES, [
    "WORKER_PORTRAIT",
    "CCCD_FRONT",
    "CCCD_BACK",
    "EMPLOYMENT_CONTRACT",
  ]);
  assert.deepEqual(checkDirectEditDocumentFile("WORKER_PORTRAIT", null), {
    ok: false,
    code: "DOCUMENT_FILE_REQUIRED",
  });
  assert.deepEqual(
    checkDirectEditDocumentFile("WORKER_PORTRAIT", { size: 0, type: "image/jpeg" }),
    { ok: false, code: "DOCUMENT_SIZE_INVALID" },
  );
  assert.deepEqual(
    checkDirectEditDocumentFile("WORKER_PORTRAIT", {
      size: DIRECT_EDIT_DOCUMENT_MAX_BYTES + 1,
      type: "image/jpeg",
    }),
    { ok: false, code: "DOCUMENT_SIZE_INVALID" },
  );
  assert.deepEqual(
    checkDirectEditDocumentFile("WORKER_PORTRAIT", { size: 1024, type: "application/pdf" }),
    { ok: false, code: "DOCUMENT_MIME_INVALID" },
  );
  assert.deepEqual(
    checkDirectEditDocumentFile("WORKER_PORTRAIT", { size: 1024, type: "image/png" }),
    { ok: true, mimeType: "image/png", sizeBytes: 1024 },
  );
  assert.deepEqual(
    checkDirectEditDocumentFile("CCCD_FRONT", { size: 2048, type: "application/pdf" }),
    { ok: true, mimeType: "application/pdf", sizeBytes: 2048 },
  );
  assert.deepEqual(
    checkDirectEditDocumentFile("EMPLOYMENT_CONTRACT", {
      size: DIRECT_EDIT_DOCUMENT_MAX_BYTES,
      type: "application/pdf",
    }),
    {
      ok: true,
      mimeType: "application/pdf",
      sizeBytes: DIRECT_EDIT_DOCUMENT_MAX_BYTES,
    },
  );
  assert.match(
    directEditDocumentErrorMessage("CCCD_BACK", "DOCUMENT_MIME_INVALID"),
    /CCCD mặt sau/,
  );
});

test("HF Worker Profile: runDirectEditDocumentUploads chains entry_version and isolates per-file errors", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
    if (String(url).endsWith("/documents") && init?.method === "POST") {
      const parsed = JSON.parse(String(init.body));
      if (parsed.document_type === "WORKER_PORTRAIT") {
        assert.equal(parsed.expected_entry_version, 4);
        return new Response(
          JSON.stringify({
            ok: true,
            document_id: "doc-portrait-1",
            version: 1,
            entry_version: 5,
            upload: {
              method: "PUT",
              url: "https://storage.example.test/put/portrait",
              headers: { "Content-Type": "image/jpeg" },
            },
          }),
          { status: 200 },
        );
      }
      if (parsed.document_type === "CCCD_FRONT") {
        // Must receive entry_version 5 from the succeeded portrait upload!
        assert.equal(parsed.expected_entry_version, 5);
        return new Response(
          JSON.stringify({
            ok: true,
            document_id: "doc-cccd-1",
            version: 2,
            entry_version: 6,
            upload: {
              method: "PUT",
              url: "https://storage.example.test/put/cccd-fail",
              headers: { "Content-Type": "image/png" },
            },
          }),
          { status: 200 },
        );
      }
      if (parsed.document_type === "EMPLOYMENT_CONTRACT") {
        // Even after CCCD_FRONT PUT failed, entry_version had advanced to 6 on reserve!
        assert.equal(parsed.expected_entry_version, 6);
        return new Response(
          JSON.stringify({
            ok: true,
            document_id: "doc-contract-1",
            version: 1,
            entry_version: 7,
            upload: {
              method: "PUT",
              url: "https://storage.example.test/put/contract",
              headers: { "Content-Type": "application/pdf" },
            },
          }),
          { status: 200 },
        );
      }
    }
    if (init?.method === "PUT") {
      if (String(url).includes("cccd-fail")) {
        return new Response("Storage error", { status: 503 });
      }
      return new Response("", { status: 200 });
    }
    if (String(url).endsWith("/finalize")) {
      const parsed = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          ok: true,
          entry_version: parsed.expected_entry_version,
        }),
        { status: 200 },
      );
    }
    return new Response("Not found", { status: 404 });
  };

  const portraitFile = new File([new Uint8Array([1, 2, 3])], "portrait.jpg", { type: "image/jpeg" });
  const cccdFile = new File([new Uint8Array([4, 5, 6])], "cccd.png", { type: "image/png" });
  const contractFile = new File([new Uint8Array([7, 8, 9])], "contract.pdf", { type: "application/pdf" });

  const result = await runDirectEditDocumentUploads({
    entryId: ENTRY,
    initialEntryVersion: 4,
    items: [
      { docType: "WORKER_PORTRAIT", file: portraitFile },
      { docType: "CCCD_FRONT", file: cccdFile },
      { docType: "EMPLOYMENT_CONTRACT", file: contractFile },
    ],
    reason: "Bo sung ho so",
    fetchImpl: fakeFetch,
  });

  assert.equal(result.entryVersion, 7);
  assert.equal(result.allSucceeded, false);
  assert.equal(result.results.length, 3);
  assert.equal(result.results[0]?.ok, true);
  assert.equal(result.results[1]?.ok, false);
  assert.equal(result.results[1]?.code, "DOCUMENT_STORAGE_UNAVAILABLE");
  assert.equal(result.results[2]?.ok, true);

  // Retrying only the failed CCCD_FRONT file starts from result.entryVersion (7)
  const retryOutcome = await uploadDirectEditDocument({
    entryId: ENTRY,
    expectedEntryVersion: result.entryVersion,
    docType: "CCCD_FRONT",
    file: cccdFile,
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/documents") && init?.method === "POST") {
        const parsed = JSON.parse(String(init.body));
        assert.equal(parsed.expected_entry_version, 7);
        return new Response(
          JSON.stringify({
            ok: true,
            document_id: "doc-cccd-2",
            version: 3,
            entry_version: 8,
            upload: {
              method: "PUT",
              url: "https://storage.example.test/put/cccd-ok",
              headers: { "Content-Type": "image/png" },
            },
          }),
          { status: 200 },
        );
      }
      if (init?.method === "PUT") return new Response("", { status: 200 });
      if (String(url).endsWith("/finalize")) {
        return new Response(JSON.stringify({ ok: true, entry_version: 8 }), { status: 200 });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  assert.equal(retryOutcome.ok, true);
  assert.equal(retryOutcome.entryVersion, 8);
  assert.equal(retryOutcome.documentVersion, 3);
});

test("HF Edit Values: personal fields preserve untouched empty state and transition cleared provided values to intentionally_blank", () => {
  const baselineDetails = {
    display_name: "Nguyễn Văn A",
    gender: { state: "omitted" },
    date_of_birth: { state: "unknown" },
    national_id: { state: "provided", value: "079095000123" },
    national_id_issued_at: { state: "provided", value: "15/06/2021" },
    // national_id_issued_place is undefined on baselineDetails
    address: { state: "intentionally_blank" },
    phone: { state: "provided", value: "0901234567" },
  };
  const baselineEntry = {
    project_id: "proj-1",
    first_work_date: "2026-03-01",
    employee_code: "hrp-2026-000001",
    recruiter_id: RECRUITER,
    labor_type: "TEMPORARY",
    worker_details: baselineDetails,
  };

  const entryForm = directEditWorkerFormFromBaseline(baselineEntry);
  const form = entryForm.workerDetails;
  assert.equal(form.display_name, "Nguyễn Văn A");
  assert.equal(form.gender.text, "");
  assert.equal(form.date_of_birth.text, "");
  assert.equal(form.national_id.text, "079095000123");
  assert.equal(
    form.national_id_issued_at.text,
    "2021-06-15",
    "DD/MM/YYYY baseline date is normalized to YYYY-MM-DD for native <input type='date'>",
  );
  assert.equal(form.national_id_issued_place.text, "");
  assert.equal(form.address.text, "");
  assert.equal(form.phone.text, "0901234567");
  assert.equal(toDirectEditDateInputValue("2021-06-15"), "2021-06-15");
  assert.equal(toDirectEditDateInputValue("15/06/2021"), "2021-06-15");

  // 1. Untouched form produces WORKER_UNCHANGED and preserves exact baseline states (including DD/MM/YYYY raw value and undefined national_id_issued_place)
  const unchangedBuilt = buildDirectEditWorkerDetailsProposal(baselineDetails, form);
  assert.deepEqual(unchangedBuilt, { ok: false, code: "WORKER_UNCHANGED" });

  // 2. Updating only display_name keeps omitted/unknown/intentionally_blank/undefined fields in their exact baseline states
  const renamedBuilt = buildDirectEditWorkerDetailsProposal(baselineDetails, {
    ...form,
    display_name: "Nguyễn Văn A Mới",
  });
  assert.equal(renamedBuilt.ok, true);
  if (renamedBuilt.ok) {
    assert.deepEqual(renamedBuilt.proposal, {
      worker_details: {
        display_name: "Nguyễn Văn A Mới",
        gender: { state: "omitted" },
        date_of_birth: { state: "unknown" },
        national_id: { state: "provided", value: "079095000123" },
        national_id_issued_at: { state: "provided", value: "15/06/2021" },
        address: { state: "intentionally_blank" },
        phone: { state: "provided", value: "0901234567" },
      },
    });
    assert.equal("national_id_issued_place" in renamedBuilt.proposal.worker_details, false);
  }

  // 3. Clearing existing provided fields (including gender, national_id, national_id_issued_at, phone) transitions them to intentionally_blank
  const baselineWithGender = {
    ...baselineDetails,
    gender: { state: "provided", value: "MALE" },
  };
  const entryFormWithGender = directEditWorkerFormFromBaseline({
    ...baselineEntry,
    worker_details: baselineWithGender,
  });
  assert.equal(entryFormWithGender.workerDetails.gender.text, "MALE");

  const clearedBuilt = buildDirectEditEntryFieldProposal({
    baseline: {
      ...baselineEntry,
      worker_details: baselineWithGender,
    },
    form: {
      ...entryFormWithGender,
      workerDetails: {
        ...entryFormWithGender.workerDetails,
        gender: { state: "provided", text: "" },
        national_id: { state: "provided", text: "   " },
        national_id_issued_at: { state: "provided", text: "" },
        phone: { state: "provided", text: "" },
        date_of_birth: { state: "provided", text: "1995-08-20" },
        address: { state: "provided", text: "Quận 7, TP.HCM" },
      },
    },
  });
  assert.equal(clearedBuilt.ok, true);
  if (clearedBuilt.ok) {
    assert.deepEqual(clearedBuilt.proposal, {
      worker_details: {
        display_name: "Nguyễn Văn A",
        gender: { state: "intentionally_blank" },
        date_of_birth: { state: "provided", value: "1995-08-20" },
        national_id: { state: "intentionally_blank" },
        national_id_issued_at: { state: "intentionally_blank" },
        address: { state: "provided", value: "Quận 7, TP.HCM" },
        phone: { state: "intentionally_blank" },
      },
    });
  }
});

test("HF Edit Values: VietQR bank catalog merges existing bank_ids and resolves code/short_name/bank_name to a single bank", () => {
  assert.ok(VIETQR_BANK_CATALOG.length >= 60, "VietQR catalog includes full list of Vietnamese banks");

  const existingCatalog = [
    { bank_id: "VCB", display_name: "Vietcombank" },
    { bank_id: "BANK_CUSTOM_TCB", display_name: "Techcombank" },
  ];
  const merged = mergeVietQrBankCatalog(existingCatalog);

  // Existing bank_id is preserved when short_name/code matches
  const byCode = resolveBankCatalogOption(merged, "TCB");
  const byShortName = resolveBankCatalogOption(merged, "Techcombank");
  const byOfficialName = resolveBankCatalogOption(
    merged,
    "Ngân hàng TMCP Kỹ thương Việt Nam",
  );
  assert.ok(byCode);
  assert.equal(byCode.bank_id, "BANK_CUSTOM_TCB");
  assert.equal(byShortName?.bank_id, byCode.bank_id);
  assert.equal(byOfficialName?.bank_id, byCode.bank_id);

  // Only one entry exists for Techcombank in merged list
  const tcbMatches = merged.filter((item) => item.bank_code === "TCB");
  assert.equal(tcbMatches.length, 1);

  // Standard VietQR banks not in existingCatalog get stable canonical bank_id
  const mbByCode = resolveBankCatalogOption(merged, "MB");
  const mbByShort = resolveBankCatalogOption(merged, "MBBank");
  const mbByOfficial = resolveBankCatalogOption(merged, "Ngân hàng TMCP Quân đội");
  assert.ok(mbByCode);
  assert.equal(mbByCode.bank_id, "MB");
  assert.equal(mbByShort?.bank_id, "MB");
  assert.equal(mbByOfficial?.bank_id, "MB");

  assert.equal(
    formatBankReferenceDisplay("TCB", null, existingCatalog),
    "Techcombank",
  );
  assert.equal(
    formatBankReferenceDisplay(null, "Ngân hàng Hợp tác xã XYZ", existingCatalog),
    "Ngân hàng Hợp tác xã XYZ",
  );
});

test("HF Edit Values: buildDirectEditPaymentPatch preserves untouched empty state, clears provided to intentionally_blank, and supports custom reference bank_name", () => {
  const catalogBanks = [{ bank_id: "VCB", display_name: "Vietcombank" }];

  // 1. Untouched empty states (null, omitted, unknown, intentionally_blank) remain unchanged
  for (const emptyBaseline of [
    null,
    { state: "omitted", account_number: null, bank_id: null, bank_name: null, account_holder_name: null },
    { state: "unknown", account_number: null, bank_id: null, bank_name: null, account_holder_name: null },
    { state: "intentionally_blank", account_number: null, bank_id: null, bank_name: null, account_holder_name: null },
  ]) {
    assert.deepEqual(
      buildDirectEditPaymentPatch({
        baseline: emptyBaseline,
        accountNumber: "",
        bankId: "",
        bankQueryText: "",
        accountHolderName: "",
        catalogBanks,
      }),
      { kind: "unchanged" },
    );
  }

  // 2. Clearing an existing provided bank record transitions to intentionally_blank
  const providedBaseline = {
    state: "provided",
    account_number: "19038889990001",
    bank_id: "TCB",
    bank_name: "Techcombank",
    account_holder_name: "NGUYEN VAN A",
  };
  assert.equal(initialDirectEditBankQueryText(providedBaseline, catalogBanks), "Techcombank");
  assert.deepEqual(
    buildDirectEditPaymentPatch({
      baseline: providedBaseline,
      accountNumber: "  ",
      bankId: "",
      bankQueryText: "  ",
      accountHolderName: "",
      catalogBanks,
    }),
    {
      kind: "changed",
      proposal: {
        state: "intentionally_blank",
        account_number: null,
        bank_id: null,
        bank_name: null,
        account_holder_name: null,
      },
    },
  );

  // 3. Searching "TCB" or "Techcombank" resolves to the same bank_id ("TCB")
  const byCodePatch = buildDirectEditPaymentPatch({
    baseline: null,
    accountNumber: "19038889990001",
    bankId: "",
    bankQueryText: "TCB",
    accountHolderName: "NGUYEN VAN A",
    catalogBanks,
  });
  const byNamePatch = buildDirectEditPaymentPatch({
    baseline: null,
    accountNumber: "19038889990001",
    bankId: "",
    bankQueryText: "Techcombank",
    accountHolderName: "NGUYEN VAN A",
    catalogBanks,
  });
  assert.deepEqual(byCodePatch, {
    kind: "changed",
    proposal: {
      state: "provided",
      account_number: "19038889990001",
      bank_id: "TCB",
      bank_name: "Techcombank",
      account_holder_name: "NGUYEN VAN A",
    },
  });
  assert.deepEqual(byNamePatch, byCodePatch);

  // 4. Typing an unknown bank name not in catalog saves bank_id: null and bank_name as reference text
  const customBankPatch = buildDirectEditPaymentPatch({
    baseline: null,
    accountNumber: "123456789",
    bankId: "",
    bankQueryText: "Ngân hàng Nông thôn Xã A",
    accountHolderName: "NGUYEN VAN A",
    catalogBanks,
  });
  assert.deepEqual(customBankPatch, {
    kind: "changed",
    proposal: {
      state: "provided",
      account_number: "123456789",
      bank_id: null,
      bank_name: "Ngân hàng Nông thôn Xã A",
      account_holder_name: "NGUYEN VAN A",
    },
  });

  // 5. Account number + account holder without bank is valid (bank is for reference only)
  const noBankPatch = buildDirectEditPaymentPatch({
    baseline: null,
    accountNumber: "123456789",
    bankId: "",
    bankQueryText: "",
    accountHolderName: "NGUYEN VAN A",
    catalogBanks,
  });
  assert.deepEqual(noBankPatch, {
    kind: "changed",
    proposal: {
      state: "provided",
      account_number: "123456789",
      bank_id: null,
      bank_name: null,
      account_holder_name: "NGUYEN VAN A",
    },
  });
});

test("HF Catalog Effective Date: worker starting before a recruiter's membership valid_from sees and saves that currently active recruiter; inactive current selection remains separately visible", () => {
  const CURRENT_RECRUITER_ID = "22222222-2222-4222-8222-222222222222";
  const MAY_RECRUITER_ID = "77777777-7777-4777-8777-777777777777";
  const INACTIVE_RECRUITER_ID = "88888888-8888-4888-8888-888888888888";

  // Worker hrp-2026-002553 started 2026-09-28; Nguyễn Thị Mây (maynt.td) has membership from 2026-10-06
  // and is active in today's catalog (2026-11-05).
  const todayCatalogRecruiters = [
    { recruiter_id: CURRENT_RECRUITER_ID, label: "Trần Thị B · B-01" },
    { recruiter_id: MAY_RECRUITER_ID, label: "Nguyễn Thị Mây · maynt.td" },
  ];
  const todayCatalogProjects = [
    { project_id: "proj-current", display_name: "Dự án Bắc Ninh" },
    { project_id: "proj-new", display_name: "Dự án Hải Phòng" },
  ];

  // 1. When current recruiter is active today, today's catalog lists both current recruiter and Nguyễn Thị Mây (without duplicate fallback option)
  const optionsWhenCurrentActive = buildWorkerEditRecruiterOptions({
    catalogRecruiters: todayCatalogRecruiters,
    currentRecruiterId: CURRENT_RECRUITER_ID,
    currentRecruiterDisplay: "Trần Thị B · B-01",
  });
  assert.deepEqual(optionsWhenCurrentActive, [
    { value: CURRENT_RECRUITER_ID, label: "Trần Thị B · B-01", isCurrentFallback: false },
    { value: MAY_RECRUITER_ID, label: "Nguyễn Thị Mây · maynt.td", isCurrentFallback: false },
  ]);

  // Selecting Nguyễn Thị Mây and saving on worker with first_work_date = 2026-09-28 produces a valid recruiter_id patch
  const baselineEntry = {
    project_id: "proj-current",
    first_work_date: "2026-09-28",
    employee_code: "hrp-2026-002553",
    recruiter_id: CURRENT_RECRUITER_ID,
    labor_type: "TEMPORARY",
    worker_details: {
      display_name: "Lê Văn Công",
      date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
  };
  const form = directEditWorkerFormFromBaseline(baselineEntry);
  const savedBuilt = buildDirectEditEntryFieldProposal({
    baseline: baselineEntry,
    form: {
      ...form,
      recruiter_id: MAY_RECRUITER_ID,
    },
  });
  assert.deepEqual(savedBuilt, {
    ok: true,
    proposal: {
      recruiter_id: MAY_RECRUITER_ID,
    },
  });

  // 2. When current recruiter (or project) is no longer eligible in today's catalog for new selection,
  // it is preserved as a separate "(hiện tại)" option ahead of today's active catalog options.
  const optionsWhenCurrentInactive = buildWorkerEditRecruiterOptions({
    catalogRecruiters: todayCatalogRecruiters,
    currentRecruiterId: INACTIVE_RECRUITER_ID,
    currentRecruiterDisplay: "Phạm Văn Cũ · cu.td",
  });
  assert.deepEqual(optionsWhenCurrentInactive, [
    {
      value: INACTIVE_RECRUITER_ID,
      label: "Phạm Văn Cũ · cu.td (hiện tại)",
      isCurrentFallback: true,
    },
    { value: CURRENT_RECRUITER_ID, label: "Trần Thị B · B-01", isCurrentFallback: false },
    { value: MAY_RECRUITER_ID, label: "Nguyễn Thị Mây · maynt.td", isCurrentFallback: false },
  ]);

  const projectOptionsWhenCurrentInactive = buildWorkerEditProjectOptions({
    catalogProjects: todayCatalogProjects,
    currentProjectId: "proj-expired",
    currentProjectDisplay: "Dự án Cũ",
  });
  assert.deepEqual(projectOptionsWhenCurrentInactive, [
    {
      value: "proj-expired",
      label: "Dự án Cũ (hiện tại)",
      isCurrentFallback: true,
    },
    { value: "proj-current", label: "Dự án Bắc Ninh", isCurrentFallback: false },
    { value: "proj-new", label: "Dự án Hải Phòng", isCurrentFallback: false },
  ]);

  // Editing another field while keeping the inactive recruiter preserves the current recruiter (omits recruiter_id from patch)
  const baselineWithInactiveRecruiter = {
    ...baselineEntry,
    recruiter_id: INACTIVE_RECRUITER_ID,
  };
  const formWithInactiveRecruiter = directEditWorkerFormFromBaseline(baselineWithInactiveRecruiter);
  const keepInactiveRecruiterPatch = buildDirectEditEntryFieldProposal({
    baseline: baselineWithInactiveRecruiter,
    form: {
      ...formWithInactiveRecruiter,
      project_id: "proj-new",
    },
  });
  assert.deepEqual(keepInactiveRecruiterPatch, {
    ok: true,
    proposal: {
      project_id: "proj-new",
    },
  });
});

const AUTH_SUBJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_USER_ID = "55555555-5555-4555-8555-555555555555";
const TEAM_ID = "44444444-4444-4444-8444-444444444444";
const AT_TIMESTAMP = "2026-10-08T08:00:00.000Z";

function baseActorRecord(overrides = {}) {
  return {
    auth_subject: AUTH_SUBJECT,
    app_user_id: APP_USER_ID,
    display_name: "Nguyen Test Actor",
    enabled: true,
    capabilities: [],
    recruiter_links: [],
    teams: [],
    team_scope_grants: [],
    all_scope_grants: [],
    ...overrides,
  };
}

async function resolveTestActor(recordOverrides = {}) {
  const record = baseActorRecord(recordOverrides);
  return resolveActor({
    session: {
      auth_subject: AUTH_SUBJECT,
      provider: "supabase",
      authenticated_at: AT_TIMESTAMP,
    },
    repository: {
      async loadByAuthSubject(subject) {
        return subject === AUTH_SUBJECT ? structuredClone(record) : null;
      },
    },
    at: AT_TIMESTAMP,
  });
}

test("T1A-1: uploader tab authority uses server-resolved allowed_worker_tabs, gates catalog by entry_create|entry_own, and handles 0 usable tabs cleanly", async () => {
  // 1a. Actor with submission_create + server-confirmed allowed_worker_tabs = ["uploader"] (no entry_create/entry_own)
  const resolvedOwn = await resolveTestActor({
    capabilities: ["submission_create"],
    allowed_worker_tabs: ["uploader"],
  });
  assert.equal(resolvedOwn.ok, true);
  const allowedOwn = resolveAllowedWorkerOperationsTabs(resolvedOwn.actor);
  assert.deepEqual(allowedOwn, ["uploader"]);
  assert.equal(canReadWorkerDirectoryCatalog(resolvedOwn.actor), false);
  assert.equal(initialWorkerTab(resolvedOwn.actor), "uploader");

  // Real listOwnSubmissions API succeeds for uploader and returns valid page for parseSubmissionPageResponse
  const subResponse = await listOwnSubmissions(
    new Request("https://bi.internal/api/direct-entry/submissions?page_size=25"),
    "true",
    {
      resolveSession: async () => ({ actor: resolvedOwn, response_headers: {} }),
      repository: {
        listOwnSubmissions: async () => ({
          ok: true,
          data: {
            items: [
              {
                submission_id: REQUEST,
                state: "DRAFT",
                version: 1,
                entry_count: 1,
                created_at: "2026-10-01T00:00:00.000000Z",
                updated_at: "2026-10-02T00:00:00.000000Z",
                submitted_at: null,
                allowed_transitions: ["SUBMITTED"],
                project_scoped: false,
              },
            ],
            page_size: 25,
            has_more: false,
            next_cursor: null,
          },
        }),
        readOwnSubmission: async () => ({ ok: false, kind: "not-found" }),
      },
    },
  );
  assert.equal(subResponse.status, 200);
  const parsedSub = parseSubmissionPageResponse(await subResponse.json(), { page_size: 25 });
  assert.ok(parsedSub !== null);
  assert.equal(parsedSub.items.length, 1);

  // 1b. Actor who passes workerOperationsNavPredicate (e.g. entry_own) but has 0 usable tabs (allowed_worker_tabs: [])
  const resolvedZero = await resolveTestActor({
    capabilities: ["entry_own"],
    allowed_worker_tabs: [],
  });
  assert.equal(resolvedZero.ok, true);
  assert.equal(workerOperationsNavPredicate(resolvedZero.actor), true);
  assert.deepEqual(resolveAllowedWorkerOperationsTabs(resolvedZero.actor), []);
  assert.deepEqual(visibleWorkerTabs(resolveAllowedWorkerOperationsTabs(resolvedZero.actor)), []);
  assert.equal(initialWorkerTab(resolvedZero.actor), null);
  assert.ok(WORKER_NO_USABLE_TAB_MESSAGE.length > 0);

  // 1c. Legacy DB payload missing allowed_worker_tabs fails closed to [] (no client/TS guessing)
  const resolvedLegacy = await resolveTestActor({
    capabilities: ["entry_own", "submission_create"],
  });
  assert.equal(resolvedLegacy.ok, true);
  assert.equal(resolvedLegacy.actor.allowed_worker_tabs, undefined);
  assert.deepEqual(resolveAllowedWorkerOperationsTabs(resolvedLegacy.actor), []);
});

test("T1A-2: recruited tab authority uses server-confirmed allowed_worker_tabs and rejects malformed/duplicate tab payloads", async () => {
  const resolvedRecruiter = await resolveTestActor({
    capabilities: ["entry_own"],
    recruiter_links: [
      {
        recruiter_id: RECRUITER,
        app_user_id: APP_USER_ID,
        verified: true,
      },
    ],
    allowed_worker_tabs: ["recruited"],
  });
  assert.equal(resolvedRecruiter.ok, true);
  assert.deepEqual(resolveAllowedWorkerOperationsTabs(resolvedRecruiter.actor), ["recruited"]);
  assert.equal(canReadWorkerDirectoryCatalog(resolvedRecruiter.actor), true);
  assert.equal(initialWorkerTab(resolvedRecruiter.actor), "recruited");

  // Real listWorkers API succeeds for scope=recruited
  const recResponse = await listWorkers(
    new Request("https://bi.internal/api/direct-entry/workers?scope=recruited&page_size=25"),
    "true",
    {
      resolveSession: async () => ({ actor: resolvedRecruiter, response_headers: {} }),
      repository: {
        listWorkers: async (query) => ({
          ok: true,
          data: {
            ...page([row()]),
            scope: query.scope,
          },
        }),
      },
    },
  );
  assert.equal(recResponse.status, 200);
  const parsedRec = parseWorkerPageResponse(await recResponse.json(), {
    scope: "recruited",
    page_size: 25,
  });
  assert.ok(parsedRec !== null);
  assert.equal(parsedRec.items.length, 1);

  // Malformed or duplicate allowed_worker_tabs in DB record fails actor resolution closed
  for (const invalidTabs of [
    "recruited",
    ["invalid_tab"],
    ["recruited", "recruited"],
    [null],
  ]) {
    const bad = await resolveTestActor({
      capabilities: ["entry_own"],
      allowed_worker_tabs: invalidTabs,
    });
    assert.deepEqual(bad, { ok: false, reason: "ACTOR_REPOSITORY_INVALID" });
  }
});

test("T1A-3: team tab authority requires server-confirmed team in allowed_worker_tabs; team_manager_assign @ team without team leader authority does not open team tab", async () => {
  // Actor with team_manager_assign + team scope where SQL direct_entry_assert_team_leader_current_team failed (e.g. missing leader assignment)
  const incompleteLeader = await resolveTestActor({
    capabilities: ["entry_team", "team_manager_assign"],
    teams: [{ team_id: TEAM_ID, code: "TEAM_NORTH", display: "Team North", active: true }],
    team_scope_grants: [{ team_id: TEAM_ID, valid_from: "2026-01-01", valid_to: null }],
    allowed_worker_tabs: ["recruited"],
  });
  assert.equal(incompleteLeader.ok, true);
  // Navigation guard still allows entering /direct-entry/workers, but team tab is NOT in allowedTabs
  assert.equal(workerOperationsNavPredicate(incompleteLeader.actor), true);
  const allowedIncomplete = resolveAllowedWorkerOperationsTabs(incompleteLeader.actor);
  assert.deepEqual(allowedIncomplete, ["recruited"]);
  assert.equal(allowedIncomplete.includes("team"), false);
  assert.equal(initialWorkerTab(incompleteLeader.actor), "recruited");

  // Full Team Leader where SQL confirmed team authority
  const validLeader = await resolveTestActor({
    capabilities: ["entry_team", "team_manager_assign"],
    teams: [{ team_id: TEAM_ID, code: "TEAM_NORTH", display: "Team North", active: true }],
    team_scope_grants: [{ team_id: TEAM_ID, valid_from: "2026-01-01", valid_to: null }],
    allowed_worker_tabs: ["team", "recruited"],
  });
  assert.equal(validLeader.ok, true);
  // Canonical tab bar order is ["recruited", "team"], while initial tab selection picks "team"
  assert.deepEqual(resolveAllowedWorkerOperationsTabs(validLeader.actor), ["recruited", "team"]);
  assert.equal(initialWorkerTab(validLeader.actor), "team");
});

test("T1A-4: managed tab authority requires server-confirmed managed in allowed_worker_tabs; change_request_create alone does not open managed tab", async () => {
  const withoutProjectAssignment = await resolveTestActor({
    capabilities: ["change_request_create"],
    allowed_worker_tabs: [],
  });
  assert.equal(withoutProjectAssignment.ok, true);
  assert.deepEqual(resolveAllowedWorkerOperationsTabs(withoutProjectAssignment.actor), []);
  assert.equal(initialWorkerTab(withoutProjectAssignment.actor), null);

  const activePm = await resolveTestActor({
    capabilities: ["change_request_create"],
    allowed_worker_tabs: ["managed", "recruited", "uploader"],
  });
  assert.equal(activePm.ok, true);
  assert.deepEqual(resolveAllowedWorkerOperationsTabs(activePm.actor), [
    "uploader",
    "recruited",
    "managed",
  ]);
  assert.equal(initialWorkerTab(activePm.actor), "managed");
});

test("T1A-5: all tab authority requires server-confirmed all in allowed_worker_tabs", async () => {
  const reviewerAll = await resolveTestActor({
    capabilities: ["change_review"],
    all_scope_grants: [{ valid_from: "2026-01-01", valid_to: null }],
    allowed_worker_tabs: ["all"],
  });
  assert.equal(reviewerAll.ok, true);
  assert.deepEqual(resolveAllowedWorkerOperationsTabs(reviewerAll.actor), ["all"]);
  assert.equal(initialWorkerTab(reviewerAll.actor), "all");
  assert.equal(canReadWorkerDirectoryCatalog(reviewerAll.actor), false);
});

test("T1A-6: actor with multiple permissions simultaneously follows initialWorkerTab/fallbackWorkerTab priority (managed -> all -> team -> recruited -> uploader)", async () => {
  assert.deepEqual(
    [...WORKER_OPERATIONS_INITIAL_TAB_PRIORITY],
    ["managed", "all", "team", "recruited", "uploader"],
  );

  const multiActor = await resolveTestActor({
    capabilities: ["submission_create", "entry_own", "entry_team", "team_manager_assign", "change_review"],
    all_scope_grants: [{ valid_from: "2026-01-01", valid_to: null }],
    allowed_worker_tabs: ["uploader", "recruited", "managed", "team", "all"],
  });
  assert.equal(multiActor.ok, true);
  const allTabs = resolveAllowedWorkerOperationsTabs(multiActor.actor);
  assert.deepEqual(allTabs, ["uploader", "recruited", "managed", "team", "all"]);
  assert.equal(initialWorkerTab(allTabs), "managed");
  assert.equal(fallbackWorkerTab(multiActor.actor, undefined, undefined, undefined, undefined, allTabs), "all");
  assert.equal(resolveInitialWorkerTab(["uploader", "recruited", "team"]), "team");
  assert.equal(resolveInitialWorkerTab(["uploader", "recruited"]), "recruited");
  assert.equal(resolveInitialWorkerTab(["uploader"]), "uploader");
  assert.equal(resolveInitialWorkerTab([]), null);
});

test("T1A-7: mid-session permission revocation (HTTP 403 + GET /api/direct-entry/session refresh) clears stale data, shows denial, updates allowed tabs, and does not retry rejected scope", async () => {
  // 1. Initial state: actor has ["recruited", "managed"] and has loaded 1 worker on "managed" + 1 worker on "recruited"
  const initialState = {
    allowedTabs: ["recruited", "managed"],
    activeTab: "managed",
    workerPages: {
      recruited: applyPage(emptyTabPage(), page([row({ entry_id: RECRUITER })]), workerRowKey, false),
      managed: applyPage(emptyTabPage(), { ...page([row()]), scope: "managed" }, workerRowKey, false),
      team: emptyTabPage(),
      all: emptyTabPage(),
    },
    submissionPage: emptyTabPage(),
    workerSummary: { total_workers: 1, project_count: 1, recruiter_count: 1 },
  };

  // 2. PM assignment is revoked mid-session; GET /api/direct-entry/workers?scope=managed returns HTTP 403
  const currentActorTabs = ["recruited"];
  const deniedManagedRes = await listWorkers(
    new Request("https://bi.internal/api/direct-entry/workers?scope=managed&page_size=25"),
    "true",
    {
      resolveSession: async () => ({
        actor: await resolveTestActor({
          capabilities: ["entry_own", "change_request_create"],
          allowed_worker_tabs: currentActorTabs,
        }),
        response_headers: {},
      }),
      repository: {
        listWorkers: async () => ({ ok: false, kind: "denied" }),
      },
    },
  );
  assert.equal(deniedManagedRes.status, 403);

  // 3. Component immediately reconciles the 403 denial on "managed"
  const afterDenial = reconcileWorkerOperationsPermissions(initialState, {
    revokedTab: "managed",
    denialMessage: workerListErrorMessage(403),
  });
  assert.equal(afterDenial.workerPages.managed.state, "denied");
  assert.equal(afterDenial.workerPages.managed.items.length, 0, "Stale items on revoked tab must be cleared");
  assert.equal(afterDenial.workerPages.managed.cursor, null);
  assert.equal(afterDenial.workerPages.managed.hasMore, false);
  assert.equal(afterDenial.workerSummary, null, "Stale workerSummary on revoked tab must be cleared");
  assert.deepEqual(afterDenial.allowedTabs, ["recruited"]);
  assert.equal(afterDenial.activeTab, "managed", "Keeps denied tab visible so user sees explicit 403 message");
  assert.equal(afterDenial.shouldFetchNextActiveTab, false, "Must not auto-retry or hop without user action");

  // 4. Component calls GET /api/direct-entry/session (real createDirectEntrySessionResponse) to sync latest permissions
  // Suppose "recruited" was ALSO revoked on the server, leaving only ["uploader"]
  const sessionResponse = await createDirectEntrySessionResponse("true", async () => ({
    actor: await resolveTestActor({
      capabilities: ["submission_create"],
      allowed_worker_tabs: ["uploader"],
    }),
    response_headers: {},
  }));
  assert.equal(sessionResponse.status, 200);
  const parsedSession = parseSessionWorkerPermissionsResponse(await sessionResponse.json());
  assert.deepEqual(parsedSession, {
    allowedTabs: ["uploader"],
    canReadCatalog: false,
  });

  // 5. Reconciling with session response wipes cached data on "recruited" (newly revoked) while preserving the "denied" message on "managed"
  const afterSessionSync = reconcileWorkerOperationsPermissions(afterDenial, {
    nextAllowedTabs: parsedSession.allowedTabs,
    preserveDeniedActiveTab: true,
  });
  assert.deepEqual(afterSessionSync.allowedTabs, ["uploader"]);
  assert.equal(afterSessionSync.workerPages.recruited.items.length, 0, "Newly revoked tab cache is wiped");
  assert.equal(afterSessionSync.workerPages.managed.state, "denied", "Denied state on active tab stays visible");
  assert.equal(afterSessionSync.workerPages.managed.items.length, 0);
  assert.equal(afterSessionSync.shouldFetchNextActiveTab, false);
});

test("T1A-8: forged scope request to API/RPC is rejected with HTTP 403 and client payload validator blocks allowed_worker_tabs spoofing", async () => {
  assert.equal(
    validateClientBusinessPayload({ allowed_worker_tabs: ["all"] }).ok,
    false,
  );
  assert.equal(
    validateClientBusinessPayload({ allowedWorkerTabs: ["all"] }).ok,
    false,
  );

  const SESSION_ACTOR = {
    auth_subject: AUTH_SUBJECT,
    app_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    display_name: "Staff Actor",
    enabled: true,
    capabilities: ["entry_own"],
    scopes: [{ kind: "own", reference: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", valid_from: "0001-01-01", valid_to: null }],
    self_recruiter_suggestion: null,
    allowed_worker_tabs: [],
    session: {
      provider: "supabase",
      verification: "getUser",
      authenticated_at: AT_TIMESTAMP,
    },
  };

  const resolveSession = async () => ({
    actor: {
      ok: true,
      actor: SESSION_ACTOR,
    },
    response_headers: {},
  });

  const observedCalls = [];
  const fakeRepo = {
    listWorkers: async (query) => {
      observedCalls.push({ fn: "listWorkers", query });
      return { ok: false, kind: "denied" };
    },
    listOwnSubmissions: async (query) => {
      observedCalls.push({ fn: "listOwnSubmissions", query });
      return { ok: false, kind: "denied" };
    },
    readOwnSubmission: async () => ({ ok: false, kind: "denied" }),
  };

  // 1. Spoofed auth_subject in query string is rejected before session (400 WORKER_QUERY_INVALID)
  const spoofedQueryRes = await listWorkers(
    new Request(
      "https://bi.internal/api/direct-entry/workers?scope=all&page_size=25&auth_subject=99999999-9999-4999-8999-999999999999",
    ),
    "true",
    { resolveSession, repository: fakeRepo },
  );
  assert.equal(spoofedQueryRes.status, 400);
  const spoofedBody = await spoofedQueryRes.json();
  assert.equal(spoofedBody.ok, false);
  assert.equal(spoofedBody.code, "WORKER_QUERY_INVALID");
  assert.equal(observedCalls.length, 0);

  // 2. Client forges scope=managed / team / all -> binds SESSION_ACTOR and returns HTTP 403 WORKER_DIRECTORY_DENIED
  for (const forgedScope of ["managed", "team", "all"]) {
    const res = await listWorkers(
      new Request(
        `https://bi.internal/api/direct-entry/workers?scope=${forgedScope}&page_size=25`,
      ),
      "true",
      { resolveSession, repository: fakeRepo },
    );
    assert.equal(res.status, 403, `Forged scope=${forgedScope} must return HTTP 403`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "WORKER_DIRECTORY_DENIED");
  }
  assert.equal(observedCalls.length, 0, "denied tabs never call the worker directory RPC");

  // 3. Client without submission_create/PM authority calls /api/direct-entry/submissions -> returns HTTP 403 SUBMISSION_READ_DENIED
  const subRes = await listOwnSubmissions(
    new Request("https://bi.internal/api/direct-entry/submissions?page_size=25"),
    "true",
    { resolveSession, repository: fakeRepo },
  );
  assert.equal(subRes.status, 403);
  const subBody = await subRes.json();
  assert.equal(subBody.ok, false);
  assert.equal(subBody.code, "SUBMISSION_READ_DENIED");

  assert.equal(observedCalls.length, 1);
  assert.equal(observedCalls[0].fn, "listOwnSubmissions");
  assert.equal(observedCalls[0].query.auth_subject, SESSION_ACTOR.auth_subject);
  assert.equal(observedCalls[0].query.app_user_id, SESSION_ACTOR.app_user_id);
});

test("T1A-9: uploader tab authority matches direct_entry_list_own_submissions in R1 (submission_create capability, exactly 1 current own scope with team_id=null, valid_from/valid_to inert metadata, or project assignment)", () => {
  const validOwnScope = {
    scope_kind: "own",
    team_id: null,
    valid_from: "2026-01-01",
    valid_to: "2026-10-09",
    is_current: true,
  };

  // 1. Capability check: submission_create is required when hasProjectAssignment is false
  assert.equal(
    canAccessUploaderSubmissionsTab({
      enabled: true,
      authorizationDate: AUTH,
      capabilities: ["submission_create"],
      scopeGrants: [validOwnScope],
      hasProjectAssignment: false,
    }),
    true,
  );
  for (const nonUploaderCap of ["entry_create", "entry_own", "entry_admin", "change_review"]) {
    assert.equal(
      canAccessUploaderSubmissionsTab({
        enabled: true,
        authorizationDate: AUTH,
        capabilities: [nonUploaderCap],
        scopeGrants: [validOwnScope],
        hasProjectAssignment: false,
      }),
      false,
      `Capability ${nonUploaderCap} alone must not open uploader tab without submission_create or PM assignment`,
    );
  }
  assert.equal(
    canAccessUploaderSubmissionsTab({
      enabled: true,
      authorizationDate: AUTH,
      capabilities: [],
      scopeGrants: [],
      hasProjectAssignment: true,
    }),
    true,
    "Effective project manager assignment satisfies direct_entry_list_own_submissions",
  );
  assert.equal(
    canAccessUploaderSubmissionsTab({
      enabled: false,
      authorizationDate: AUTH,
      capabilities: ["submission_create"],
      scopeGrants: [validOwnScope],
      hasProjectAssignment: true,
    }),
    false,
    "Disabled actor is always denied",
  );

  // 2. Scope uniqueness and shape: requires count(*) = 1 of scope_kind='own' AND team_id IS NULL AND is_current
  assert.equal(
    canAccessUploaderSubmissionsTab({
      enabled: true,
      authorizationDate: AUTH,
      capabilities: ["submission_create"],
      scopeGrants: [],
    }),
    false,
    "0 own scope grants -> denied",
  );
  assert.equal(
    canAccessUploaderSubmissionsTab({
      enabled: true,
      authorizationDate: AUTH,
      capabilities: ["submission_create"],
      scopeGrants: [validOwnScope, { ...validOwnScope, valid_from: "2026-02-01" }],
    }),
    false,
    "Duplicate (2) current own scope grants -> count <> 1 -> denied",
  );
  assert.equal(
    canAccessUploaderSubmissionsTab({
      enabled: true,
      authorizationDate: AUTH,
      capabilities: ["submission_create"],
      scopeGrants: [{ ...validOwnScope, team_id: "team_synthetic_01" }],
    }),
    false,
    "own scope grant with non-null team_id -> denied",
  );
  assert.equal(
    canAccessUploaderSubmissionsTab({
      enabled: true,
      authorizationDate: AUTH,
      capabilities: ["submission_create"],
      scopeGrants: [{ ...validOwnScope, is_current: false }],
    }),
    false,
    "non-current own scope grant -> denied",
  );
  assert.equal(
    canAccessUploaderSubmissionsTab({
      enabled: true,
      authorizationDate: AUTH,
      capabilities: [{ capability: "submission_create", is_current: false }],
      scopeGrants: [validOwnScope],
    }),
    false,
    "non-current submission_create capability grant -> denied",
  );

  // 3. R1 current-state semantics: valid_from / valid_to are inert metadata when is_current = true
  assert.equal(
    canAccessUploaderSubmissionsTab({
      enabled: true,
      authorizationDate: AUTH,
      capabilities: [
        {
          capability: "submission_create",
          valid_from: "2099-01-01",
          valid_to: "2099-12-31",
          is_current: true,
        },
      ],
      scopeGrants: [{ ...validOwnScope, valid_from: "2020-01-01", valid_to: "2020-06-01", is_current: true }],
    }),
    true,
    "R1 current-state authorization uses is_current=true regardless of historical valid_from/valid_to metadata",
  );
});

test("T1A-10: page gate and nav predicate allow Worker Directory (/direct-entry/workers) when SQL returns at least one allowed_worker_tabs entry (recruited or uploader only) without opening /direct-entry", async () => {
  const recruitedOnly = await resolveTestActor({
    capabilities: [],
    recruiter_links: [
      {
        app_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        recruiter_id: RECRUITER,
        verified: true,
        valid_from: "2026-01-01",
        valid_to: null,
      },
    ],
    allowed_worker_tabs: ["recruited"],
  });
  assert.equal(recruitedOnly.ok, true);
  assert.equal(decideWorkerOperationsPageAccess({ uiEnabled: true, actor: recruitedOnly }), "ALLOW");
  assert.equal(workerOperationsNavPredicate(recruitedOnly.actor), true);
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: recruitedOnly }), "ACCESS_DENIED");
  assert.equal(directEntryNavPredicate(recruitedOnly.actor), false);

  const uploaderOnly = await resolveTestActor({
    capabilities: ["submission_create"],
    allowed_worker_tabs: ["uploader"],
  });
  assert.equal(uploaderOnly.ok, true);
  assert.equal(decideWorkerOperationsPageAccess({ uiEnabled: true, actor: uploaderOnly }), "ALLOW");
  assert.equal(workerOperationsNavPredicate(uploaderOnly.actor), true);
  assert.equal(decideDirectEntryPageAccess({ uiEnabled: true, actor: uploaderOnly }), "ACCESS_DENIED");
  assert.equal(directEntryNavPredicate(uploaderOnly.actor), false);

  const noTabsNoEntryCaps = await resolveTestActor({
    capabilities: ["submission_create"],
    allowed_worker_tabs: [],
  });
  assert.equal(noTabsNoEntryCaps.ok, true);
  assert.equal(decideWorkerOperationsPageAccess({ uiEnabled: true, actor: noTabsNoEntryCaps }), "ACCESS_DENIED");
  assert.equal(workerOperationsNavPredicate(noTabsNoEntryCaps.actor), false);
});

test("WP8C-1: canReviewChangeRequests and canViewGlobalChangeRequestHistory enforce paired @ ALL when effective_grants is present", () => {
  const TEAM_1 = "11111111-1111-4111-8111-111111111111";

  // 1. Mirror-cleared capabilities/scopes + paired change_review @ ALL -> both true
  const reviewerAllGrants = [
    { capability: "change_review", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
  ];
  assert.equal(
    canReviewChangeRequests({ capabilities: [], scopes: [], effective_grants: reviewerAllGrants }),
    true,
  );
  assert.equal(canViewGlobalChangeRequestHistory([], [], reviewerAllGrants), true);

  // 2. Mirror-cleared capabilities/scopes + paired entry_admin @ ALL -> review=false, global history=true
  const adminAllGrants = [
    { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
  ];
  assert.equal(
    canReviewChangeRequests({ capabilities: [], scopes: [], effective_grants: adminAllGrants }),
    false,
  );
  assert.equal(canViewGlobalChangeRequestHistory([], [], adminAllGrants), true);

  // 3. Cross-scope drift (change_review @ CONTEXT_TEAM + unrelated ALL) -> both false
  const crossScopeGrants = [
    { capability: "change_review", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "DIRECT_GRANT", source_id: null },
    { capability: "entry_admin", scope_kind: "CONTEXT_TEAM", scope_id: TEAM_1, source_type: "DIRECT_GRANT", source_id: null },
    { capability: "audit_view", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: null },
  ];
  assert.equal(
    canReviewChangeRequests({
      capabilities: ["change_review", "entry_admin", "audit_view"],
      scopes: [{ kind: "all" }, { kind: "team" }],
      effective_grants: crossScopeGrants,
    }),
    false,
  );
  assert.equal(
    canViewGlobalChangeRequestHistory(
      ["change_review", "entry_admin", "audit_view"],
      [{ kind: "all" }, { kind: "team" }],
      crossScopeGrants,
    ),
    false,
  );

  // 4. Stale legacy arrays with effective_grants: [] and malformed grants -> both false
  assert.equal(
    canReviewChangeRequests({
      capabilities: ["change_review", "entry_admin"],
      scopes: [{ kind: "all" }],
      effective_grants: [],
    }),
    false,
  );
  assert.equal(
    canViewGlobalChangeRequestHistory(["change_review", "entry_admin"], [{ kind: "all" }], []),
    false,
  );
  assert.equal(
    canReviewChangeRequests({
      capabilities: ["change_review"],
      scopes: [{ kind: "all" }],
      effective_grants: [null, undefined, "bad"],
    }),
    false,
  );
  assert.equal(
    canViewGlobalChangeRequestHistory(["change_review", "entry_admin"], [{ kind: "all" }], [null, undefined, "bad"]),
    false,
  );
  assert.equal(
    canReviewChangeRequests({
      capabilities: ["change_review"],
      scopes: [{ kind: "all" }],
      effective_grants: null,
    }),
    false,
  );
  assert.equal(
    canViewGlobalChangeRequestHistory(["change_review", "entry_admin"], [{ kind: "all" }], null),
    false,
  );
});


