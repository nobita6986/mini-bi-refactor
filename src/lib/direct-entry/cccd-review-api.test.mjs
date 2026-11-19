import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION,
  SERVER_GENERATED_EMPLOYEE_CODE_CONTRACT_VERSION,
  parseFullProfilePayload,
} from "./full-profile-contract.ts";
import { buildCccdRequiredFullProfileRequestBody } from "./full-profile-batch.ts";
import { buildFormProfileValidation } from "./form-profile-validation.ts";
import { buildSpreadsheetValidation } from "./direct-entry-grid-validation.ts";
import { defaultCells } from "./spreadsheet-row-model.ts";
import {
  buildMissingDocumentWorkersQuery,
  isValidReviewEntryId,
  parseCccdReviewListQuery,
  parseCccdReviewResolveRequest,
  parseMissingDocumentWorkersQuery,
  projectMissingDocumentWorkersResponse,
} from "./cccd-review-contract.ts";
import { createCccdReviewRepository } from "./cccd-review-repository.ts";
import {
  getDirectEntryCccdReviewQueue,
  getDirectEntryMissingDocumentWorkers,
  postDirectEntryCccdReviewResolution,
} from "./cccd-review-api.ts";
import {
  parseWorkerEditHistorySearchQuery,
  projectWorkerEditHistoryRevision,
  projectWorkerEditHistorySearch,
} from "../admin/worker-edit-history-contract.ts";
import { createWorkerEditHistoryRepository } from "../admin/worker-edit-history-repository.ts";
import {
  getWorkerEditHistory,
  getWorkerEditHistoryRevision,
} from "../admin/worker-edit-history-api.ts";
import { decideWorkerEditHistoryPageAccess } from "../auth/direct-entry-page-access.ts";

const ENTRY_ID = "11111111-1111-4111-8111-111111111111";
const DOC_FRONT_ID = "22222222-2222-4222-8222-222222222222";
const RECRUITER_ID = "33333333-3333-4333-8333-333333333333";
const TEAM_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const AUTH_SUB = "66666666-6666-4666-8666-666666666666";

const PASTE_CATALOG = {
  projects: [{ id: "proj_alpha", label: "Dự Án Alpha", active: true }],
  recruiters: [{ id: RECRUITER_ID, label: "Nguyễn Tuyển Dụng", active: true, provider_type: "hrp" }],
  labor_types: [{ id: "TEMPORARY", label: "Thời vụ", active: true }],
};

test("parseFullProfilePayload enforces 12-digit CCCD and allows blank display_name for worker-profile/1.2 while keeping worker-profile/1.1 untouched", () => {
  const baseRow = {
    project_id: "proj_alpha",
    first_work_date: "2026-04-10",
    recruiter_id: RECRUITER_ID,
    provider_type: "hrp",
    labor_type: "TEMPORARY",
    display_name: "",
    worker: {
      gender: { state: "omitted" },
      date_of_birth: { state: "omitted" },
      national_id: { state: "provided", value: "079095008811" },
      national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    general_note: { state: "omitted" },
    payment: { state: "omitted" },
    employment: { initial_status: "ON" },
  };

  // 1. worker-profile/1.2 accepts blank display_name when 12-digit national_id is provided
  const v12Valid = parseFullProfilePayload({
    contract_version: CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION,
    rows: [baseRow],
  });
  assert.equal(v12Valid.ok, true);
  assert.equal(v12Valid.payload.contract_version, "worker-profile/1.2");
  assert.equal(v12Valid.payload.rows[0].display_name, "");
  assert.deepEqual(v12Valid.payload.rows[0].worker_details.national_id, {
    state: "provided",
    value: "079095008811",
  });

  // 2. worker-profile/1.2 rejects omitted or 9-digit national_id
  const v12MissingCccd = parseFullProfilePayload({
    contract_version: CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION,
    rows: [
      {
        ...baseRow,
        display_name: "Có Tên Nhưng Thiếu CCCD",
        worker: { ...baseRow.worker, national_id: { state: "omitted" } },
      },
    ],
  });
  assert.equal(v12MissingCccd.ok, false);
  assert.ok(v12MissingCccd.issues.some((i) => i.code === "NATIONAL_ID_INVALID"));

  const v12NineDigit = parseFullProfilePayload({
    contract_version: CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION,
    rows: [
      {
        ...baseRow,
        worker: { ...baseRow.worker, national_id: { state: "provided", value: "123456789" } },
      },
    ],
  });
  assert.equal(v12NineDigit.ok, false);
  assert.ok(v12NineDigit.issues.some((i) => i.code === "NATIONAL_ID_INVALID"));

  // 3. worker-profile/1.1 (Grid mode) still rejects blank display_name and allows omitted national_id
  const v11BlankName = parseFullProfilePayload({
    contract_version: SERVER_GENERATED_EMPLOYEE_CODE_CONTRACT_VERSION,
    rows: [baseRow],
  });
  assert.equal(v11BlankName.ok, false);

  const v11ValidGrid = parseFullProfilePayload({
    contract_version: SERVER_GENERATED_EMPLOYEE_CODE_CONTRACT_VERSION,
    rows: [
      {
        ...baseRow,
        display_name: "Nguyễn Văn Lưới",
        worker: { ...baseRow.worker, national_id: { state: "omitted" } },
      },
    ],
  });
  assert.equal(v11ValidGrid.ok, true);
});

test("buildFormProfileValidation requires 12-digit CCCD and allows blank display_name in Form mode while buildSpreadsheetValidation (Grid mode) stays unchanged", () => {
  const rowBlankNameWithCccd = {
    clientRowId: "r1",
    defaultLaborType: "TEMPORARY",
    lazyDefaultsApplied: true,
    providerType: "hrp",
    cells: {
      ...defaultCells(),
      project_id: "proj_alpha",
      first_work_date: "2026-04-10",
      recruiter_id: RECRUITER_ID,
      labor_type: "TEMPORARY",
      display_name: "",
      national_id: "079095008811",
    },
  };

  // Form mode: valid with blank displayName and 12-digit CCCD
  const formValid = buildFormProfileValidation({
    rows: [rowBlankNameWithCccd],
    referenceDate: "2026-04-10",
    catalogFor: () => PASTE_CATALOG,
  });
  assert.equal(formValid.canSave, true);
  assert.equal(formValid.validRowCount, 1);

  const body = buildCccdRequiredFullProfileRequestBody(
    formValid.preview.rows,
  );
  assert.ok(body);
  assert.equal(body.contract_version, "worker-profile/1.2");
  assert.equal(body.rows[0].display_name, "");
  assert.deepEqual(body.rows[0].worker.national_id, {
    state: "provided",
    value: "079095008811",
  });

  // Form mode: invalid when CCCD is missing even if displayName is provided
  const rowNameWithoutCccd = {
    ...rowBlankNameWithCccd,
    cells: {
      ...rowBlankNameWithCccd.cells,
      display_name: "Nguyễn Văn Biểu Mẫu",
      national_id: "",
    },
  };
  const formMissingCccd = buildFormProfileValidation({
    rows: [rowNameWithoutCccd],
    referenceDate: "2026-04-10",
    catalogFor: () => PASTE_CATALOG,
  });
  assert.equal(formMissingCccd.canSave, false);
  assert.ok(
    formMissingCccd.cellIssues.some(
      (issue) => issue.clientRowId === "r1" && issue.columnKey === "national_id",
    ),
  );

  // Grid mode: still requires displayName and allows empty nationalId
  const gridWithBlankName = buildSpreadsheetValidation({
    rows: [rowBlankNameWithCccd],
    referenceDate: "2026-04-10",
    catalogFor: () => PASTE_CATALOG,
  });
  assert.equal(gridWithBlankName.canSave, false);
  assert.ok(
    gridWithBlankName.cellIssues.some(
      (issue) => issue.clientRowId === "r1" && issue.columnKey === "display_name",
    ),
  );

  const gridWithNameWithoutCccd = buildSpreadsheetValidation({
    rows: [rowNameWithoutCccd],
    referenceDate: "2026-04-10",
    catalogFor: () => PASTE_CATALOG,
  });
  assert.equal(gridWithNameWithoutCccd.canSave, true);
});

test("cccd-review-contract parses queue query and resolve requests", () => {
  assert.equal(isValidReviewEntryId(ENTRY_ID), true);
  assert.equal(isValidReviewEntryId("not-a-uuid"), false);

  const defaultQuery = parseCccdReviewListQuery(new URLSearchParams());
  assert.deepEqual(defaultQuery, {
    ok: true,
    value: { status_filter: "NEEDS_REVIEW", limit: 50, offset: 0 },
  });

  const invalidFilter = parseCccdReviewListQuery(new URLSearchParams("status=BOGUS"));
  assert.deepEqual(invalidFilter, { ok: false, code: "CCCD_REVIEW_FILTER_INVALID" });

  const updateReq = parseCccdReviewResolveRequest({
    expected_entry_version: 2,
    action: "UPDATE_ENTERED_CCCD",
    national_id: "079095008811",
    apply_blank_fields: true,
    reason: "Gõ nhầm số cuối",
  });
  assert.equal(updateReq.ok, true);

  const badCccdReq = parseCccdReviewResolveRequest({
    expected_entry_version: 2,
    action: "UPDATE_ENTERED_CCCD",
    national_id: "123456789",
  });
  assert.deepEqual(badCccdReq, { ok: false, code: "NATIONAL_ID_INVALID" });

  const stdReq = parseCccdReviewResolveRequest({
    expected_entry_version: 3,
    action: "STANDARDIZE_FROM_QR",
    fields: ["national_id", "display_name", "gender"],
    reason: "Chuẩn hóa theo QR",
  });
  assert.equal(stdReq.ok, true);

  const manualReq = parseCccdReviewResolveRequest({
    expected_entry_version: 4,
    action: "MANUAL_UPDATE_DETAILS",
    national_id: "079095008811",
    display_name: "Nguyễn Văn An",
    date_of_birth: "15/08/1995",
    gender: "MALE",
    address: "Hà Nội",
    national_id_issued_at: null,
    reason: "Đã đối chiếu bản chính",
  });
  assert.deepEqual(manualReq, {
    ok: true,
    value: {
      expected_entry_version: 4,
      action: "MANUAL_UPDATE_DETAILS",
      national_id: "079095008811",
      display_name: "Nguyễn Văn An",
      date_of_birth: "15/08/1995",
      gender: "MALE",
      address: "Hà Nội",
      national_id_issued_at: null,
      reason: "Đã đối chiếu bản chính",
    },
  });
  assert.deepEqual(
    parseCccdReviewResolveRequest({
      expected_entry_version: 4,
      action: "MANUAL_UPDATE_DETAILS",
      national_id: "123",
      display_name: "",
    }),
    { ok: false, code: "NATIONAL_ID_INVALID" },
  );
});

test("createCccdReviewRepository projects SQL RPC queue & resolution responses and get/post API handlers enforce security guards", async () => {
  const sqlQueuePayload = {
    status_filter: "NEEDS_REVIEW",
    page: 1,
    page_size: 50,
    total_items: 1,
    has_more: false,
    counts: {
      needs_review: 1,
      mismatch: 1,
      qr_unreadable: 0,
      pending: 0,
      resolved: 2,
      all: 3,
    },
    items: [
      {
        entry_id: ENTRY_ID,
        entry_version: 2,
        submission_state: "SUBMITTED",
        employee_code: "hrp-2026-000101",
        project_id: "proj_alpha",
        project_display: "Dự Án Alpha",
        recruiter_id: RECRUITER_ID,
        recruiter_display: "Nguyễn Tuyển Dụng",
        team_id: TEAM_ID,
        team_display: "Team 1",
        provider_type: "hrp",
        labor_type: "TEMPORARY",
        first_work_date: "2026-04-10",
        created_by_user_id: USER_ID,
        created_by_display: "Người Tạo Hồ Sơ",
        actor_authority: "creator_own",
        reconciliation_status: "MISMATCH",
        entered_national_id: "079095007733",
        entered_national_id_masked: "••••••••7733",
        qr_national_id: "079095008811",
        qr_national_id_masked: "••••••••8811",
        worker_details: {
          display_name: "",
          date_of_birth: { state: "omitted" },
          gender: { state: "omitted" },
          address: { state: "omitted" },
          phone: { state: "provided", value: "0909123456" },
          national_id_issued_at: { state: "omitted" },
          national_id_issued_place: { state: "omitted" },
        },
        extracted_fields: {
          source: "CCCD_QR",
          authenticity: "UNVERIFIED_QR_TEXT",
          national_id: "079095008811",
          display_name: "Lê Thị Hồng Nhung",
          date_of_birth: "12/04/1996",
          date_of_birth_iso: "1996-04-12",
          gender: "FEMALE",
          gender_label: "Nữ",
          address: "45 Lê Lợi, Quận 1, TP. Hồ Chí Minh",
          national_id_issued_at: "15/06/2022",
          national_id_issued_at_iso: "2022-06-15",
        },
        auto_applied_fields: [],
        matched_document_id: DOC_FRONT_ID,
        matched_document_type: "CCCD_FRONT",
        matched_document_version: 1,
        last_error_code: null,
        last_error_field: null,
        resolved_at: null,
        resolved_by_user_id: null,
        resolved_by_display: null,
        resolution_action: null,
        resolution_note: null,
        updated_at: "2026-04-10T08:00:00.000Z",
        documents: [
          {
            document_id: DOC_FRONT_ID,
            document_type: "CCCD_FRONT",
            document_version: 1,
            mime_type: "image/jpeg",
            size_bytes: 1024,
            qr_status: "SUCCEEDED",
            qr_reconciliation_status: "MISMATCH",
            qr_error_code: null,
            qr_error_field: null,
          },
        ],
      },
    ],
  };

  const sqlResolvePayload = {
    entry_id: ENTRY_ID,
    entry_version: 3,
    reused: false,
    changed_fields: ["national_id", "display_name"],
    reconciliation: {
      entry_id: ENTRY_ID,
      status: "RESOLVED_EDITED_CCCD",
      entered_national_id: "079095008811",
      entered_national_id_masked: "••••••••8811",
      qr_national_id: "079095008811",
      qr_national_id_masked: "••••••••8811",
      matched_document_id: DOC_FRONT_ID,
      matched_document_type: "CCCD_FRONT",
      matched_document_version: 1,
      resolved_at: "2026-04-10T08:05:00.000Z",
      resolved_by_user_id: USER_ID,
      resolution_action: "UPDATE_ENTERED_CCCD",
      resolution_note: "Sửa lại số CCCD",
      updated_at: "2026-04-10T08:05:00.000Z",
    },
  };

  const rpcCalls = [];
  const reviewRepository = createCccdReviewRepository(async (name, args) => {
    rpcCalls.push({ name, args });
    if (name === "direct_entry_list_cccd_review_queue") {
      return { data: sqlQueuePayload, error: null };
    }
    if (name === "direct_entry_resolve_cccd_review") {
      return { data: sqlResolvePayload, error: null };
    }
    if (name === "direct_entry_apply_cccd_manual_resolution") {
      return {
        data: {
          ...sqlResolvePayload,
          action: "MANUAL_UPDATE_DETAILS",
          reconciliation: {
            ...sqlResolvePayload.reconciliation,
            resolution_action: "MANUAL_UPDATE_DETAILS",
          },
        },
        error: null,
      };
    }
    return { data: null, error: { code: "P0002" } };
  });

  const dependencies = {
    resolveSession: async () => ({
      actor: {
        ok: true,
        actor: {
          auth_subject: AUTH_SUB,
          app_user_id: USER_ID,
          capabilities: ["entry_create", "document_upload"],
        },
      },
    }),
    reviewRepository,
  };

  // 1. Feature gate off -> 404
  const gateOff = await getDirectEntryCccdReviewQueue(
    new Request("https://app.example/api/direct-entry/cccd-review"),
    "false",
    dependencies,
  );
  assert.equal(gateOff.status, 404);

  // 2. GET review queue -> 200 with projected SQL items
  const queueRes = await getDirectEntryCccdReviewQueue(
    new Request("https://app.example/api/direct-entry/cccd-review?status=NEEDS_REVIEW"),
    "true",
    dependencies,
  );
  assert.equal(queueRes.status, 200);
  const queueBody = await queueRes.json();
  assert.equal(queueBody.ok, true);
  assert.equal(queueBody.summary.needs_review_count, 1);
  assert.equal(queueBody.rows.length, 1);
  assert.equal(queueBody.rows[0].entered.national_id_masked, "••••••••7733");
  assert.equal(queueBody.rows[0].qr.national_id_masked, "••••••••8811");
  assert.equal(queueBody.rows[0].documents.cccd_front.document_id, DOC_FRONT_ID);

  // 3. POST resolve -> 200 with normalized RESOLVED_UPDATED_CCCD
  const resolveRes = await postDirectEntryCccdReviewResolution(
    new Request(`https://app.example/api/direct-entry/entries/${ENTRY_ID}/cccd-review`, {
      method: "POST",
      headers: {
        origin: "https://app.example",
        host: "app.example",
        "content-type": "application/json",
        "idempotency-key": "idem-review-1",
      },
      body: JSON.stringify({
        expected_entry_version: 2,
        action: "UPDATE_ENTERED_CCCD",
        national_id: "079095008811",
        apply_blank_fields: true,
        reason: "Sửa lại số CCCD",
      }),
    }),
    ENTRY_ID,
    "true",
    dependencies,
  );
  assert.equal(resolveRes.status, 200);
  const resolveBody = await resolveRes.json();
  assert.equal(resolveBody.ok, true);
  assert.equal(resolveBody.reconciliation.status, "RESOLVED_UPDATED_CCCD");
  assert.deepEqual(resolveBody.changed_fields, ["national_id", "display_name"]);

  const manualResolveRes = await postDirectEntryCccdReviewResolution(
    new Request(`https://app.example/api/direct-entry/entries/${ENTRY_ID}/cccd-review`, {
      method: "POST",
      headers: {
        origin: "https://app.example",
        host: "app.example",
        "content-type": "application/json",
        "idempotency-key": "idem-review-manual-1",
      },
      body: JSON.stringify({
        expected_entry_version: 3,
        action: "MANUAL_UPDATE_DETAILS",
        national_id: "079095008811",
        display_name: "Nguyễn Văn An",
        date_of_birth: "15/08/1995",
        gender: "MALE",
        address: "Hà Nội",
        national_id_issued_at: null,
        reason: "Đã đối chiếu bản chính",
      }),
    }),
    ENTRY_ID,
    "true",
    dependencies,
  );
  assert.equal(manualResolveRes.status, 200);
  const manualResolveBody = await manualResolveRes.json();
  assert.equal(manualResolveBody.action, "MANUAL_UPDATE_DETAILS");
  assert.equal(manualResolveBody.reconciliation.status, "RESOLVED_UPDATED_CCCD");
  const manualRpcCall = rpcCalls.find((call) => call.name === "direct_entry_apply_cccd_manual_resolution");
  assert.ok(manualRpcCall);
  assert.equal("p_action" in manualRpcCall.args, false, "manual RPC uses its six-argument SQL signature");
  assert.equal(manualRpcCall.args.p_payload.display_name, "Nguyễn Văn An");
});

test("UI source guards: Form mode orders CCCD (required) before Họ và tên (optional) with Giới tính at the end, and Review panel shows full CCCD with confirmation and no bypass", async () => {
  const formSrc = await readFile(
    path.resolve("src/components/direct-entry/direct-entry-multi-entry-form.tsx"),
    "utf8",
  );
  const cccdIdx = formSrc.indexOf("Số CCCD");
  const nameIdx = formSrc.indexOf("Họ và tên");
  const phoneIdx = formSrc.indexOf("Số điện thoại");
  const genderIdx = formSrc.indexOf("Giới tính");

  assert.ok(cccdIdx > 0 && nameIdx > 0 && phoneIdx > 0 && genderIdx > 0);
  assert.ok(cccdIdx < nameIdx, "Số CCCD must be placed before Họ và tên in Biểu mẫu");
  assert.ok(phoneIdx < genderIdx, "Giới tính must be placed at the end of the personal info cluster");
  assert.match(formSrc, /label=\{fieldLabel\("Số CCCD"\)\}/);
  assert.match(formSrc, /label="Họ và tên"/);

  const panelSrc = await readFile(
    path.resolve("src/components/reporting/cccd-review-panel.tsx"),
    "utf8",
  );
  assert.doesNotMatch(panelSrc, /maskCccdValue|cccd-review-toggle-reveal|revealFullCccd/);
  assert.match(panelSrc, /item\.entered\.national_id/);
  assert.match(panelSrc, /item\.qr\.candidate_data\?\.national_id/);
  assert.match(panelSrc, /cccd-preview/);
  assert.match(panelSrc, /UPDATE_ENTERED_CCCD/);
  assert.match(panelSrc, /STANDARDIZE_FROM_QR/);
  assert.match(panelSrc, /MANUAL_UPDATE_DETAILS/);
  assert.match(panelSrc, /Địa chỉ thường trú/);
  assert.doesNotMatch(panelSrc, /IGNORE_MISMATCH/);

  const tabsSrc = await readFile(
    path.resolve("src/components/dashboard/bod-dashboard-tabs.tsx"),
    "utf8",
  );
  const reviewTabIdx = tabsSrc.indexOf('"cccd-review"');
  const dupTabIdx = tabsSrc.indexOf('"duplicate-cccd"');
  assert.ok(reviewTabIdx > 0 && dupTabIdx > 0 && reviewTabIdx < dupTabIdx, "Review thông tin NLĐ tab must appear immediately before Báo cáo CCCD trùng");
  assert.doesNotMatch(tabsSrc, /"missing-documents"/, "Must not add a separate top-level Dashboard tab for Hồ sơ thiếu");

  // Mode tabs inside Review thông tin NLĐ
  assert.match(panelSrc, /review-mode-tab-CCCD_RECONCILIATION/);
  assert.match(panelSrc, /review-mode-tab-MISSING_DOCUMENTS/);
  assert.match(panelSrc, /Đối chiếu CCCD/);
  assert.match(panelSrc, /Hồ sơ thiếu/);
  // Conditional load only when clicking Tải danh sách
  assert.match(panelSrc, /missing-documents-load-submit/);
  assert.match(panelSrc, /hasMissingDocumentWorkersFilter/);
  assert.match(panelSrc, /missingState\.kind === "idle"/);
  // Role-aware action rendering (can_upload vs read-only Recruiter badge)
  assert.match(panelSrc, /missing-documents-open-upload-/);
  assert.match(panelSrc, /missing-documents-readonly-/);
  assert.match(panelSrc, /Chỉ xem \(Người tuyển\)/);
  // Inline upload dialog supporting all 4 document types
  assert.match(panelSrc, /missing-documents-slot-/);
  assert.match(panelSrc, /missing-documents-input-/);
  assert.match(panelSrc, /WORKER_PORTRAIT/);
  assert.match(panelSrc, /EMPLOYMENT_CONTRACT/);
});

test("Hồ sơ thiếu contract & API: parses filters, projects missing document workers, and enforces server-side access", async () => {
  const defaultMissingQuery = parseMissingDocumentWorkersQuery(new URLSearchParams());
  assert.deepEqual(defaultMissingQuery, {
    ok: false,
    code: "MISSING_DOCUMENTS_FILTER_REQUIRED",
  });
  assert.equal(
    parseMissingDocumentWorkersQuery(new URLSearchParams("employment_status=ON")).ok,
    true,
    "A status-only filter is sufficient to load results",
  );

  const filteredQuery = parseMissingDocumentWorkersQuery(
    new URLSearchParams(
      buildMissingDocumentWorkersQuery({
        missing_type: "WORKER_PORTRAIT",
        employment_status: "UNCONFIRMED",
        project_id: "proj_alpha",
        q: "079095008811",
        page: 2,
        page_size: 50,
      }),
    ),
  );
  assert.deepEqual(filteredQuery, {
    ok: true,
    value: {
      missing_type: "WORKER_PORTRAIT",
      employment_status: "UNCONFIRMED",
      project_id: "proj_alpha",
      search: "079095008811",
      page: 2,
      page_size: 50,
    },
  });

  assert.deepEqual(
    parseMissingDocumentWorkersQuery(new URLSearchParams("missing_type=INVALID")),
    { ok: false, code: "MISSING_DOCUMENTS_FILTER_INVALID" },
  );
  assert.deepEqual(
    parseMissingDocumentWorkersQuery(
      new URLSearchParams("missing_type=ALL&employment_status=ALL"),
    ),
    { ok: false, code: "MISSING_DOCUMENTS_FILTER_REQUIRED" },
  );

  let unfilteredSessionCalls = 0;
  let unfilteredRepositoryCalls = 0;
  const unfilteredRes = await getDirectEntryMissingDocumentWorkers(
    new Request("https://app.example/api/direct-entry/cccd-review/missing-documents"),
    "true",
    {
      resolveSession: async () => {
        unfilteredSessionCalls += 1;
        return {
          actor: { ok: false, reason: "UNAUTHENTICATED" },
          response_headers: {},
        };
      },
      reviewRepository: createCccdReviewRepository(async () => {
        unfilteredRepositoryCalls += 1;
        return { data: null, error: null };
      }),
    },
  );
  assert.equal(unfilteredRes.status, 400);
  assert.equal((await unfilteredRes.json()).code, "MISSING_DOCUMENTS_FILTER_REQUIRED");
  assert.equal(unfilteredSessionCalls, 0);
  assert.equal(unfilteredRepositoryCalls, 0);

  const sqlMissingPayload = {
    scope_kind: "project",
    can_upload: true,
    filter_missing_type: "ALL",
    filter_employment_status: "ON",
    filter_project_id: null,
    filter_search: null,
    page: 1,
    page_size: 25,
    total_count: 1,
    has_more: false,
    summary: {
      total_workers: 1,
      missing_worker_portrait: 1,
      missing_cccd_front: 0,
      missing_cccd_back: 1,
      missing_employment_contract: 1,
    },
    project_options: [
      {
        project_id: "proj_alpha",
        project_display: "Dự Án Alpha",
      },
    ],
    items: [
      {
        entry_id: ENTRY_ID,
        entry_version: 3,
        employee_code: "hrp-2026-000101",
        display_name: "Lê Thị Hồng Nhung",
        national_id: "079095008811",
        project_id: "proj_alpha",
        project_display: "Dự Án Alpha",
        recruiter_id: RECRUITER_ID,
        recruiter_display: "Nguyễn Tuyển Dụng",
        first_work_date: "2026-04-10",
        employment_status: "ON",
        created_by_user_id: USER_ID,
        created_by_display: "QLDA Khác",
        missing_documents: ["WORKER_PORTRAIT", "CCCD_BACK", "EMPLOYMENT_CONTRACT"],
        can_upload: true,
        documents: [
          {
            document_id: DOC_FRONT_ID,
            document_type: "CCCD_FRONT",
            document_version: 1,
            mime_type: "image/jpeg",
            size_bytes: 1024,
            updated_at: "2026-04-10T08:00:00.000Z",
          },
        ],
      },
    ],
  };

  const projected = projectMissingDocumentWorkersResponse(sqlMissingPayload);
  assert.ok(projected);
  assert.equal(projected.scope_kind, "project");
  assert.equal(projected.can_upload, true);
  assert.equal(projected.items.length, 1);
  assert.equal(projected.items[0].national_id, "079095008811");
  assert.deepEqual(projected.items[0].missing_documents, [
    "WORKER_PORTRAIT",
    "CCCD_BACK",
    "EMPLOYMENT_CONTRACT",
  ]);
  assert.equal(projected.items[0].documents[0]?.document_id, DOC_FRONT_ID);

  const reviewRepository = createCccdReviewRepository(async (name) => {
    if (name === "direct_entry_list_missing_document_workers") {
      return { data: sqlMissingPayload, error: null };
    }
    return { data: null, error: { code: "P0002" } };
  });

  const okRes = await getDirectEntryMissingDocumentWorkers(
    new Request("https://app.example/api/direct-entry/cccd-review/missing-documents?employment_status=ON"),
    "true",
    {
      resolveSession: async () => ({
        actor: {
          ok: true,
          actor: {
            auth_subject: AUTH_SUB,
            app_user_id: USER_ID,
            capabilities: ["entry_create"],
          },
        },
      }),
      reviewRepository,
    },
  );
  assert.equal(okRes.status, 200);
  const okBody = await okRes.json();
  assert.equal(okBody.ok, true);
  assert.equal(okBody.scope_kind, "project");
  assert.equal(okBody.can_upload, true);
  assert.equal(okBody.items[0].national_id, "079095008811");

  const deniedRepo = createCccdReviewRepository(async () => ({
    data: null,
    error: { code: "42501", message: "MISSING_DOCUMENTS_DENIED" },
  }));
  const deniedRes = await getDirectEntryMissingDocumentWorkers(
    new Request("https://app.example/api/direct-entry/cccd-review/missing-documents?employment_status=ON"),
    "true",
    {
      resolveSession: async () => ({
        actor: {
          ok: true,
          actor: {
            auth_subject: AUTH_SUB,
            app_user_id: USER_ID,
            capabilities: ["entry_create"],
          },
        },
      }),
      reviewRepository: deniedRepo,
    },
  );
  assert.equal(deniedRes.status, 403);
});

test("Lịch sử chỉnh sửa NLĐ contract & API: enforces 3-Admin capability gate, requires a date window, and rejects storage_key leaks", async () => {
  // 1. Page & API gate only admits actor with worker_edit_history_view @ all
  assert.equal(
    decideWorkerEditHistoryPageAccess({
      actor: {
        ok: true,
        actor: {
          auth_subject: AUTH_SUB,
          app_user_id: USER_ID,
          capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
          scopes: [{ kind: "all" }],
          effective_grants: [
            { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE" },
            { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE" },
            { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE" },
          ],
        },
      },
    }),
    "ACCESS_DENIED",
  );
  assert.equal(
    decideWorkerEditHistoryPageAccess({
      actor: {
        ok: true,
        actor: {
          auth_subject: AUTH_SUB,
          app_user_id: USER_ID,
          capabilities: [
            "entry_admin",
            "recruiter_master_manage",
            "team_master_manage",
            "worker_edit_history_view",
          ],
          scopes: [{ kind: "all" }],
          effective_grants: [
            { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE" },
            { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE" },
            { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE" },
            { capability: "worker_edit_history_view", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE" },
          ],
        },
      },
    }),
    "ALLOW",
  );

  // 2. Global history is searched by date window and optional exact catalog filters.
  const emptyQuery = parseWorkerEditHistorySearchQuery(new URL("https://app.example/api/admin/worker-edit-history"));
  assert.deepEqual(emptyQuery, {
    ok: false,
    code: "WORKER_EDIT_HISTORY_QUERY_INVALID",
  });

  const globalQuery = parseWorkerEditHistorySearchQuery(
    new URL("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31"),
  );
  assert.deepEqual(globalQuery, {
    ok: true,
    value: {
      from_date: "2026-10-01",
      to_date: "2026-10-31",
      action_group: null,
      project_id: null,
      recruiter_id: null,
      page_size: 50,
      cursor: null,
    },
  });
  const filteredQuery = parseWorkerEditHistorySearchQuery(
    new URL(`https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31&project_id=project-1&recruiter_id=${USER_ID}&action_group=PROFILE_EDIT`),
  );
  assert.equal(filteredQuery.ok, true);
  assert.equal(filteredQuery.value.project_id, "project-1");
  assert.equal(filteredQuery.value.recruiter_id, USER_ID);
  assert.equal(filteredQuery.value.action_group, "PROFILE_EDIT");
  assert.equal(
    parseWorkerEditHistorySearchQuery(
      new URL("https://app.example/api/admin/worker-edit-history?national_id=079095008811"),
    ).ok,
    false,
  );

  // 3. Detail projection fails closed if storage_key is present, and succeeds when clean
  const REV_ID = "77777777-7777-4777-8777-777777777777";
  const cleanDetail = {
    revision_id: REV_ID,
    entry_id: ENTRY_ID,
    version: 2,
    created_at: "2026-04-10T09:00:00.000Z",
    actor_user_id: USER_ID,
    actor_display_name: "Liên Vũ",
    reason_text: "Bổ sung hồ sơ thiếu và cập nhật ngân hàng",
    snapshot_state: "COMPLETE",
    before_snapshot: {
      entry_id: ENTRY_ID,
      employee_code: "hrp-2026-000101",
      display_name: "Lê Thị Hồng Nhung",
      payment: { state: "omitted" },
      documents: [],
    },
    after_snapshot: {
      entry_id: ENTRY_ID,
      employee_code: "hrp-2026-000101",
      display_name: "Lê Thị Hồng Nhung",
      payment: {
        state: "provided",
        account_number: "1903888999001",
        bank_id: "VCB",
        bank_name: "Vietcombank",
        account_holder_name: "LE THI HONG NHUNG",
      },
      documents: [
        {
          document_id: DOC_FRONT_ID,
          document_type: "WORKER_PORTRAIT",
          version: 1,
          size_bytes: 2048,
          mime_type: "image/jpeg",
          upload_status: "READY",
          scan_status: "CLEAN",
          validation_status: "VALIDATED",
          created_by_user_id: USER_ID,
          uploader_display_name: "Liên Vũ",
          supersedes_document_id: null,
          created_at: "2026-04-10T09:00:00.000Z",
          updated_at: "2026-04-10T09:00:00.000Z",
        },
      ],
    },
    current_snapshot: {},
    audit_events: [
      {
        event_id: "88888888-8888-4888-8888-888888888888",
        action: "document_direct_finalize",
        capability: "document_upload",
        scope_kind: "all",
        outcome: "APPLIED",
        actor_user_id: USER_ID,
        actor_display_name: "Liên Vũ",
        reason_text: "Bổ sung hồ sơ thiếu",
        changed_fields: ["document_lifecycle"],
        created_at: "2026-04-10T09:00:00.000Z",
      },
    ],
    employment_status_events: [],
    document_events: [],
  };

  assert.equal(
    projectWorkerEditHistoryRevision({
      ...cleanDetail,
      after_snapshot: {
        ...cleanDetail.after_snapshot,
        storage_key: "p1.6/secret-should-never-leak",
      },
    }),
    null,
    "projectWorkerEditHistoryRevision must reject any payload containing storage_key",
  );

  const projectedDetail = projectWorkerEditHistoryRevision(cleanDetail);
  assert.ok(projectedDetail);
  assert.equal(JSON.stringify(projectedDetail).includes("storage_key"), false);

  const deniedRepository = createWorkerEditHistoryRepository(async () => ({
    data: null,
    error: { code: "42501", message: "WORKER_EDIT_HISTORY_DENIED" },
  }));

  const forbiddenList = await getWorkerEditHistory(
    new Request("https://app.example/api/admin/worker-edit-history?from_date=2026-10-01&to_date=2026-10-31"),
    {
      resolveSession: async () => ({
        actor: {
          ok: true,
          actor: {
            auth_subject: AUTH_SUB,
            app_user_id: USER_ID,
            capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
            scopes: [{ kind: "all" }],
            effective_grants: [
              { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE" },
              { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE" },
              { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "LEGACY_BRIDGE" },
            ],
          },
        },
      }),
      repository: deniedRepository,
    },
  );
  assert.equal(forbiddenList.status, 403);

  const allowedRepository = createWorkerEditHistoryRepository(async (name) => {
    if (name === "worker_edit_history_search") {
      return {
        data: projectWorkerEditHistorySearch({
          rows: [],
          has_more: false,
          next_cursor: null,
        }),
        error: null,
      };
    }
    if (name === "worker_edit_history_get_revision") {
      return { data: cleanDetail, error: null };
    }
    return { data: null, error: { code: "P0002" } };
  });

  const allowedDetail = await getWorkerEditHistoryRevision(
    new Request(`https://app.example/api/admin/worker-edit-history/${ENTRY_ID}/${REV_ID}`),
    ENTRY_ID,
    REV_ID,
    {
      resolveSession: async () => ({
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
      }),
      repository: allowedRepository,
    },
  );
  assert.equal(allowedDetail.status, 200);
});
