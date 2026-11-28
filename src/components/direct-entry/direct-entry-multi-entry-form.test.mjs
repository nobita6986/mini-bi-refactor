import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createNotifyStore,
  syncNotifyPathname,
} from "../ui/notify-store.ts";
import { buildSpreadsheetValidation } from "../../lib/direct-entry/direct-entry-grid-validation.ts";
import { buildFormProfileValidation } from "../../lib/direct-entry/form-profile-validation.ts";
import {
  buildCccdRequiredFullProfileRequestBody,
  fullProfileErrorMessage,
} from "../../lib/direct-entry/full-profile-batch.ts";
import {
  createFormSaveUploadJobManager,
  formUploadCompletionForEntries,
  FORM_DOCUMENT_LABELS,
  FORM_DOCUMENT_TYPES,
  formUploadSlotStatusLabel,
} from "../../lib/direct-entry/form-save-upload-job-manager.ts";
import {
  createSpreadsheetRowModel,
} from "../../lib/direct-entry/spreadsheet-row-model.ts";

const form = await readFile(new URL("./direct-entry-multi-entry-form.tsx", import.meta.url), "utf8");
const live = await readFile(new URL("./direct-entry-live.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("./direct-entry-shell.module.css", import.meta.url), "utf8");
const uploads = await readFile(new URL("./direct-entry-initial-worker-uploads.tsx", import.meta.url), "utf8");
const documentEditor = await readFile(new URL("./direct-entry-document-editor.tsx", import.meta.url), "utf8");
const stageSlots = await readFile(new URL("./worker-portrait-stage-slot.tsx", import.meta.url), "utf8");

const SAMPLE_CATALOG = {
  projects: [{ id: "proj_alpha", label: "Dự án Alpha" }],
  recruiters: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      label: "Nguyễn Tuyển Dụng HRP",
      provider_type: "hrp",
      personnel_code: "HRP001",
      vendor_id: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      label: "Nhà Cung Ứng Vendor B",
      provider_type: "vendor",
      personnel_code: null,
      vendor_id: "vendor_b",
    },
  ],
  labor_types: [{ id: "TEMPORARY", label: "Thời vụ" }],
};

function createBaseStagedRow(overrides = {}) {
  const baseRow = createSpreadsheetRowModel().rows[0];
  return {
    ...baseRow,
    clientRowId: overrides.clientRowId ?? "row-1",
    providerType: overrides.providerType ?? "",
    lazyDefaultsApplied: true,
    cells: {
      ...baseRow.cells,
      first_work_date: "2026-04-10",
      labor_type: "TEMPORARY",
      initial_status: "Đang làm",
      ...(overrides.cells ?? {}),
    },
  };
}

test("multi-entry form reuses the staged row model, validation, and server catalog", () => {
  assert.match(live, /inputMode === "form" && editingDraftSubmissionId === null/);
  assert.match(live, /<DirectEntryMultiEntryForm/);
  assert.match(form, /model: SpreadsheetRowModel/);
  assert.match(form, /validation: SpreadsheetValidation/);
  assert.match(form, /catalog: DraftCatalog \| null/);
  assert.match(form, /onChange\(rowId, field, event\.currentTarget\.value\)/);
  assert.match(form, /onProviderTypeChange\(rowId/);
});

test("Form official submit saves staged rows first and waits for their background files; Grid retains its preflight", () => {
  assert.match(form, /className=\{styles\.secondaryButton\} data-testid="form-save-valid-rows"[\s\S]*?Lưu nháp/);
  assert.match(form, /data-testid="form-submit-official"[\s\S]*?Gửi chính thức/);
  assert.match(live, /onSave=\{\(\) => void onStagedSave\(\)\}/);
  assert.match(live, /const targetDraft = hasStagedRows \? await onStagedSave\(\) : lastSavedFormDraft/);
  assert.match(live, /waitForEntriesUploadCompletion\(targetDraft\.entryIds\)/);
  assert.match(live, /submitOfficialFormDraft\(targetDraft\.submissionId\)/);
  assert.doesNotMatch(live, /onStagedSave\(true\)/);
  assert.match(live, /preflightBeforeSubmit=\{inputMode !== "form"\}/);
  assert.match(form, /Đang lưu và gửi…/);
});

test("Form submission waits only for uploads bound to the submitted entries and stops on a failed job", () => {
  const job = (entryId, status) => ({
    jobId: "job", toastId: null, status, totalFiles: 1, uploadedFiles: 0, failedFiles: 0,
    entries: [{ entryId }],
  });
  const snapshot = (jobs) => ({ preSaveByRowId: {}, jobs });
  assert.equal(formUploadCompletionForEntries(snapshot([job("entry-a", "uploading")]), ["entry-a"]), "pending");
  assert.equal(formUploadCompletionForEntries(snapshot([job("entry-a", "completed")]), ["entry-a"]), "complete");
  assert.equal(formUploadCompletionForEntries(snapshot([job("entry-a", "error")]), ["entry-a"]), "error");
  assert.equal(formUploadCompletionForEntries(snapshot([job("other", "uploading")]), ["entry-a"]), "complete");
});

test("Requirement 1: Giới tính is placed at the end of the main personal info group (outside Thông tin thêm) and serializes Nam/Nữ/Khác", () => {
  for (const label of [
    "Dự án",
    "Nguồn tuyển",
    "Người tuyển / Vendor",
    "CTV",
    "Loại hình LĐ",
    "Ngày bắt đầu làm việc",
    "Trạng thái làm việc",
    "Số CCCD",
    "Họ và tên",
    "Số điện thoại",
    "Giới tính",
  ]) {
    assert.ok(form.includes(label), `missing ${label}`);
  }

  const cccdIdx = form.indexOf('fieldLabel("Số CCCD")');
  const nameIdx = form.indexOf('label="Họ và tên"');
  const phoneIdx = form.indexOf('label="Số điện thoại"');
  const genderIdx = form.indexOf('label="Giới tính"');
  const uploadSectionIdx = form.indexOf("<h3>Tải hồ sơ lên</h3>");
  const optionalDetailsIdx = form.indexOf("styles.formOptionalDetails");

  assert.ok(cccdIdx > 0 && nameIdx > cccdIdx, "Số CCCD precedes Họ và tên");
  assert.ok(phoneIdx > nameIdx && genderIdx > phoneIdx, "Giới tính is at the end of main personal info");
  assert.ok(
    genderIdx < uploadSectionIdx && genderIdx < optionalDetailsIdx,
    "Giới tính is outside the collapsed Thông tin thêm section",
  );

  // Verify optional + Nam / Nữ / Khác serialization in worker-profile/1.2
  for (const [uiChoice, expectedEnum] of [
    ["", { state: "omitted" }],
    ["Nam", { state: "provided", value: "MALE" }],
    ["Nữ", { state: "provided", value: "FEMALE" }],
    ["Khác", { state: "provided", value: "OTHER" }],
  ]) {
    const row = createBaseStagedRow({
      providerType: "hrp",
      cells: {
        project_id: "proj_alpha",
        recruiter_id: "11111111-1111-4111-8111-111111111111",
        national_id: "079095008811",
        gender: uiChoice,
      },
    });
    const validation = buildFormProfileValidation({
      rows: [row],
      referenceDate: "2026-04-10",
      catalogFor: () => SAMPLE_CATALOG,
    });
    assert.equal(validation.canSave, true, `gender="${uiChoice}" must be valid`);
    const body = buildCccdRequiredFullProfileRequestBody(validation.preview.rows);
    assert.ok(body);
    assert.deepEqual(body.rows[0].worker.gender, expectedEnum);
  }
});

test("Requirement 2: Selecting Dự án before HRP/Vendor does not emit premature recruiter_id catalog error, while keeping required and invalid recruiter checks", () => {
  // Step 1: User selects Dự án only (HRP/Vendor not chosen yet)
  const rowProjectOnly = createBaseStagedRow({
    providerType: "",
    cells: {
      project_id: "proj_alpha",
      recruiter_id: "",
      national_id: "079095008811",
    },
  });
  const validationStep1 = buildFormProfileValidation({
    rows: [rowProjectOnly],
    referenceDate: "2026-04-10",
    catalogFor: () => SAMPLE_CATALOG,
  });

  // Before clicking Save, stagedValidationForDisplay filters out PASTE_VALUE_REQUIRED
  const visibleErrorsBeforeSaveStep1 = validationStep1.cellIssues.filter(
    (issue) => issue.code !== "PASTE_VALUE_REQUIRED",
  );
  assert.equal(
    visibleErrorsBeforeSaveStep1.some((issue) => issue.columnKey === "recruiter_id"),
    false,
    "Must NOT show recruiter_id: Không có trong danh mục của ngày hiệu lực when only Dự án is selected",
  );
  // Required validation is still preserved so clicking Save is blocked and shows PASTE_VALUE_REQUIRED
  assert.equal(validationStep1.canSave, false);
  assert.ok(
    validationStep1.cellIssues.some(
      (issue) => issue.columnKey === "recruiter_id" && issue.code === "PASTE_VALUE_REQUIRED",
    ),
  );

  // Step 2: User selects HRP/Vendor = "hrp", still hasn't picked a recruiter
  const rowProviderSelectedOnly = createBaseStagedRow({
    providerType: "hrp",
    cells: {
      project_id: "proj_alpha",
      recruiter_id: "",
      national_id: "079095008811",
    },
  });
  const validationStep2 = buildFormProfileValidation({
    rows: [rowProviderSelectedOnly],
    referenceDate: "2026-04-10",
    catalogFor: () => SAMPLE_CATALOG,
  });
  const visibleErrorsBeforeSaveStep2 = validationStep2.cellIssues.filter(
    (issue) => issue.code !== "PASTE_VALUE_REQUIRED",
  );
  assert.equal(
    visibleErrorsBeforeSaveStep2.some((issue) => issue.columnKey === "recruiter_id"),
    false,
    "Must NOT show catalog error before recruiter is chosen",
  );
  assert.equal(validationStep2.canSave, false);

  // Step 3: User selects HRP/Vendor = "vendor" but recruiter_id is an HRP recruiter (or unknown)
  const rowMismatchedRecruiter = createBaseStagedRow({
    providerType: "vendor",
    cells: {
      project_id: "proj_alpha",
      recruiter_id: "11111111-1111-4111-8111-111111111111",
      national_id: "079095008811",
    },
  });
  const validationStep3 = buildFormProfileValidation({
    rows: [rowMismatchedRecruiter],
    referenceDate: "2026-04-10",
    catalogFor: () => SAMPLE_CATALOG,
  });
  assert.ok(
    validationStep3.cellIssues.some(
      (issue) => issue.columnKey === "recruiter_id" && issue.code === "PASTE_CATALOG_MISSING",
    ),
    "Must show PASTE_CATALOG_MISSING when HRP/Vendor is selected and recruiter is invalid for that provider",
  );
  assert.equal(validationStep3.canSave, false);

  // Grid mode behavior remains untouched
  const gridValidation = buildSpreadsheetValidation({
    rows: [rowProjectOnly],
    referenceDate: "2026-04-10",
    catalogFor: () => SAMPLE_CATALOG,
  });
  assert.ok(
    gridValidation.cellIssues.some(
      (issue) => issue.columnKey === "recruiter_id" && issue.code === "PASTE_CATALOG_MISSING",
    ),
    "Grid validation remains 100% untouched",
  );
});

test("Requirement 3: File slots display selected file names and clear statuses for all 4 document types and update on replace/cancel", () => {
  for (const docType of FORM_DOCUMENT_TYPES) {
    assert.ok(
      form.includes(FORM_DOCUMENT_LABELS[docType]) || form.includes("FORM_DOCUMENT_TYPES"),
      `form renders slot for ${docType}`,
    );
  }
  assert.match(form, /title=\{slot\.fileName\}/);
  assert.match(form, /className="sr-only">\{`Tên tệp đã chọn cho \$\{label\}: \$\{slot\.fileName\}`\}/);
  assert.match(css, /\.formUploadFileName\s*\{[\s\S]*?text-overflow:\s*ellipsis/);

  const notifyStore = createNotifyStore();
  const manager = createFormSaveUploadJobManager({ notify: notifyStore.api });

  // Initially idle
  const initialSlots = manager.getRowSlots("row-1");
  for (const docType of FORM_DOCUMENT_TYPES) {
    assert.equal(initialSlots[docType].status, "idle");
    assert.equal(formUploadSlotStatusLabel(initialSlots[docType]), "Chưa chọn tệp");
  }

  // Select all 4 document types including a very long file name
  const longFrontName =
    "cccd_mat_truoc_ung_vien_rat_dai_2026_ban_scan_chat_luong_cao_001.jpg";
  const portraitSlot = manager.selectPreSaveFile(
    "row-1",
    "WORKER_PORTRAIT",
    new File([new Uint8Array(1024)], "anh_chan_dung.png", { type: "image/png" }),
  );
  const frontSlot = manager.selectPreSaveFile(
    "row-1",
    "CCCD_FRONT",
    new File([new Uint8Array(2048)], longFrontName, { type: "image/jpeg" }),
  );
  const backSlot = manager.selectPreSaveFile(
    "row-1",
    "CCCD_BACK",
    new File([new Uint8Array(2048)], "cccd_mat_sau.pdf", { type: "application/pdf" }),
  );
  const contractSlot = manager.selectPreSaveFile(
    "row-1",
    "EMPLOYMENT_CONTRACT",
    new File([new Uint8Array(4096)], "hop_dong_lao_dong.pdf", { type: "application/pdf" }),
  );

  assert.equal(portraitSlot.fileName, "anh_chan_dung.png");
  assert.equal(portraitSlot.status, "selected");
  assert.equal(formUploadSlotStatusLabel(portraitSlot), "Đã chọn · chờ tải lên");

  assert.equal(frontSlot.fileName, longFrontName);
  assert.equal(backSlot.fileName, "cccd_mat_sau.pdf");
  assert.equal(contractSlot.fileName, "hop_dong_lao_dong.pdf");

  // Replace file updates fileName and status
  const replacedPortrait = manager.selectPreSaveFile(
    "row-1",
    "WORKER_PORTRAIT",
    new File([new Uint8Array(1536)], "anh_chan_dung_moi.jpg", { type: "image/jpeg" }),
  );
  assert.equal(replacedPortrait.fileName, "anh_chan_dung_moi.jpg");
  assert.equal(replacedPortrait.status, "selected");

  // Cancel file resets fileName and status to idle
  manager.cancelPreSaveFile("row-1", "CCCD_BACK");
  const afterCancel = manager.getRowSlots("row-1");
  assert.equal(afterCancel.CCCD_BACK.status, "idle");
  assert.equal(afterCancel.CCCD_BACK.fileName, "");
  assert.equal(formUploadSlotStatusLabel(afterCancel.CCCD_BACK), "Chưa chọn tệp");
});

test("Requirements 4 & 4.1: Save worker profile first, upload files in background across screen navigation with global toast progress, and retry failed files without re-creating worker profile", async () => {
  // Verify direct-entry-live.tsx saves Form rows without pre-save stage IDs and starts background job
  assert.match(
    live,
    /inputMode === "form"\s*\?\s*buildCccdRequiredFullProfileRequestBody\(\s*validPreviewRows,\s*undefined,\s*"ON",\s*undefined,\s*\)/,
  );
  assert.match(live, /formUploadJobManager\.beginSaveProgress\(\)/);
  assert.match(live, /formUploadJobManager\.startPostSaveUploadJob\(/);

  const notifyStore = createNotifyStore();
  const apiCalls = [];
  let failContractPutOnce = true;
  let releaseSecondFileUpload = null;
  const secondFileGate = new Promise((resolve) => {
    releaseSecondFileUpload = resolve;
  });

  const mockFetch = async (url, init = {}) => {
    const urlStr = String(url);
    apiCalls.push({ url: urlStr, method: init.method ?? "GET" });

    // Reserve endpoint
    const reserveMatch = /^\/api\/direct-entry\/entries\/([^/]+)\/documents$/.exec(urlStr);
    if (reserveMatch && init.method === "POST") {
      const entryId = decodeURIComponent(reserveMatch[1]);
      const body = JSON.parse(String(init.body));
      if (body.document_type === "CCCD_FRONT") {
        await secondFileGate;
      }
      const docId = `doc-${entryId}-${body.document_type.toLowerCase()}`;
      return Response.json(
        {
          ok: true,
          document_id: docId,
          entry_version: body.expected_entry_version + 1,
          upload: {
            method: "PUT",
            url: `https://r2.internal/upload/${docId}`,
            headers: { "Content-Type": body.mime_type },
          },
        },
        { status: 201 },
      );
    }

    // R2 PUT endpoint
    if (urlStr.startsWith("https://r2.internal/upload/") && init.method === "PUT") {
      if (urlStr.endsWith("employment_contract") && failContractPutOnce) {
        failContractPutOnce = false;
        return new Response("Storage error", { status: 503 });
      }
      return new Response(null, { status: 200 });
    }

    // Finalize endpoint
    const finalizeMatch =
      /^\/api\/direct-entry\/entries\/([^/]+)\/documents\/([^/]+)\/finalize$/.exec(urlStr);
    if (finalizeMatch && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      return Response.json(
        {
          ok: true,
          entry_version: body.expected_entry_version + 1,
        },
        { status: 200 },
      );
    }

    throw new Error(`Unexpected fetch: ${urlStr}`);
  };

  const manager = createFormSaveUploadJobManager({
    notify: notifyStore.api,
    fetchImpl: mockFetch,
  });

  // 1. User selects 3 files on row-1 (with sensitive filename containing CCCD digits to verify toast redaction)
  manager.selectPreSaveFile(
    "row-1",
    "WORKER_PORTRAIT",
    new File([new Uint8Array(512)], "portrait_079095008811.png", { type: "image/png" }),
  );
  manager.selectPreSaveFile(
    "row-1",
    "CCCD_FRONT",
    new File([new Uint8Array(1024)], "cccd_front_079095008811.jpg", { type: "image/jpeg" }),
  );
  manager.selectPreSaveFile(
    "row-1",
    "EMPLOYMENT_CONTRACT",
    new File([new Uint8Array(2048)], "contract_079095008811.pdf", { type: "application/pdf" }),
  );

  // No network call happened before saving the worker profile!
  assert.equal(apiCalls.length, 0);

  // 2. Begin saving worker profile -> global toast shows "Đang lưu hồ sơ…"
  const toastId = manager.beginSaveProgress();
  let visibleToasts = notifyStore.getSnapshot().visible;
  assert.equal(visibleToasts.length, 1);
  assert.equal(visibleToasts[0].title, "Đang lưu hồ sơ…");
  assert.equal(visibleToasts[0].pending, true);

  // 3. Server confirms worker profile saved with entry_id = "entry-saved-101"
  let settledPromiseResolve;
  const settledPromise = new Promise((resolve) => {
    settledPromiseResolve = resolve;
  });

  const job = manager.startPostSaveUploadJob({
    toastId,
    savedEntries: [
      { clientRowId: "row-1", entryId: "entry-saved-101", initialEntryVersion: 1 },
    ],
    onJobCompleted: (completedJob) => {
      settledPromiseResolve(completedJob);
    },
  });
  assert.ok(job);

  // Toast immediately reflects post-save upload progress and contains NO CCCD or filenames
  visibleToasts = notifyStore.getSnapshot().visible;
  assert.equal(visibleToasts.length, 1);
  assert.match(visibleToasts[0].title, /Đã lưu hồ sơ; đang tải ảnh và tài liệu \(\d+\/3 tệp\)/);
  assert.equal(visibleToasts[0].pending, true);
  assert.doesNotMatch(visibleToasts[0].title, /079095008811|portrait_|cccd_front|contract_/);
  assert.doesNotMatch(visibleToasts[0].description ?? "", /079095008811|portrait_|cccd_front|contract_/);

  // 4. User navigates away from /direct-entry to /dashboard while upload is in progress
  syncNotifyPathname(notifyStore, "/dashboard");
  manager.syncSessionPathname("/dashboard");

  // Toast is STILL visible on /dashboard and upload is NOT aborted!
  visibleToasts = notifyStore.getSnapshot().visible;
  assert.equal(visibleToasts.length, 1, "Global toast must persist across route navigation");

  // Release the gate so remaining uploads finish (EMPLOYMENT_CONTRACT will fail once)
  releaseSecondFileUpload();
  const firstPassJob = await settledPromise;

  // 5. Verify partial failure state: 2/3 uploaded, 1 failed (EMPLOYMENT_CONTRACT)
  assert.equal(firstPassJob.status, "error");
  assert.equal(firstPassJob.uploadedFiles, 2);
  assert.equal(firstPassJob.failedFiles, 1);
  assert.equal(
    firstPassJob.entries[0].slots.WORKER_PORTRAIT.status,
    "uploaded",
  );
  assert.equal(
    firstPassJob.entries[0].slots.CCCD_FRONT.status,
    "uploaded",
  );
  assert.equal(
    firstPassJob.entries[0].slots.EMPLOYMENT_CONTRACT.status,
    "error",
  );
  assert.equal(
    firstPassJob.entries[0].slots.EMPLOYMENT_CONTRACT.retryable,
    true,
  );

  // Global toast stays in error state (not reporting completion early!) and provides retry action
  visibleToasts = notifyStore.getSnapshot().visible;
  assert.equal(visibleToasts.length, 1);
  assert.equal(visibleToasts[0].tone, "error");
  assert.equal(visibleToasts[0].pending, false);
  assert.match(
    visibleToasts[0].title,
    /Đã lưu hồ sơ; tải tài liệu chưa hoàn tất \(2\/3 tệp\)/,
  );
  assert.ok(visibleToasts[0].action, "Error toast must expose a retry action");
  assert.equal(visibleToasts[0].action.label, "Thử lại tệp lỗi");

  // 6. Retry only the failed file via the toast action -> does NOT call full-profile batch again,
  // and only uploads the failed EMPLOYMENT_CONTRACT for entry-saved-101!
  const callsBeforeRetry = apiCalls.length;
  await manager.retryFailedJobUploads(job.jobId);
  const retryCalls = apiCalls.slice(callsBeforeRetry);

  assert.equal(
    retryCalls.some((call) => call.url.includes("/batches/full-profile")),
    false,
    "Retrying a failed file upload must NEVER re-create the worker profile",
  );
  assert.equal(retryCalls.length, 3, "Only reserve + PUT + finalize for the 1 failed file");

  const finalJob = manager.getSnapshot().jobs[0];
  assert.equal(finalJob.status, "completed");
  assert.equal(finalJob.uploadedFiles, 3);
  assert.equal(finalJob.failedFiles, 0);
  assert.equal(finalJob.entries[0].slots.EMPLOYMENT_CONTRACT.status, "uploaded");

  // Global toast now reports full completion!
  visibleToasts = notifyStore.getSnapshot().visible;
  assert.equal(visibleToasts.length, 1);
  assert.equal(visibleToasts[0].tone, "success");
  assert.equal(visibleToasts[0].pending, false);
  assert.equal(visibleToasts[0].title, "Đã lưu hồ sơ và tải xong tài liệu");

  // 7. Landing on /login (session end) clears any job state so files never leak to another user
  manager.selectPreSaveFile(
    "row-2",
    "WORKER_PORTRAIT",
    new File([new Uint8Array(256)], "other.png", { type: "image/png" }),
  );
  manager.syncSessionPathname("/login");
  assert.deepEqual(manager.getSnapshot().preSaveByRowId, {});
  assert.deepEqual(manager.getSnapshot().jobs, []);
});

test("Requirement 5: POST /api/direct-entry/batches/full-profile honest retry messages and server error handling", async () => {
  // 1. Honest retry message does not falsely claim 'Chưa dòng nào được lưu'
  const unavailableMsg = fullProfileErrorMessage("BATCH_UNAVAILABLE");
  const networkMsg = fullProfileErrorMessage("FULL_PROFILE_NETWORK");
  assert.doesNotMatch(unavailableMsg, /Chưa dòng nào được lưu/);
  assert.doesNotMatch(networkMsg, /Chưa dòng nào được lưu/);
  assert.match(unavailableMsg, /không tạo hồ sơ trùng/);

  // 2. Verify full-profile-repository.ts and full-profile-api.ts guards
  const repoSrc = await readFile(
    new URL("../../lib/direct-entry/full-profile-repository.ts", import.meta.url),
    "utf8",
  );
  const apiSrc = await readFile(
    new URL("../../lib/direct-entry/full-profile-api.ts", import.meta.url),
    "utf8",
  );
  assert.match(repoSrc, /"CONTRACT_VERSION_UNSUPPORTED"/);
  assert.match(repoSrc, /canFallbackV12ToV11/);
  assert.match(apiSrc, /post-commit stage promotion failed/);
});

test("Requirement 6: Deleting a row in Biểu mẫu opens AlertDialog with default focus on a larger, prominent 'Hủy' button and cleans up row files only on confirm", () => {
  assert.match(form, /import \* as AlertDialog from "radix-ui\/alert-dialog"/);
  assert.match(form, /data-testid="form-delete-row-dialog"/);
  assert.match(
    form,
    /onOpenAutoFocus=\{\(event\) => \{\s*event\.preventDefault\(\);\s*cancelDeleteButtonRef\.current\?\.focus\(\);\s*\}\}/,
    "Default focus must be placed on the Hủy button so pressing Enter does not delete data",
  );
  assert.match(form, /ref=\{cancelDeleteButtonRef\}[\s\S]*?className=\{styles\.formDeleteCancelButtonProminent\}[\s\S]*?data-testid="form-delete-row-cancel"/);
  assert.match(form, /className=\{styles\.formDeleteConfirmButtonSubtle\}[\s\S]*?data-testid="form-delete-row-confirm"/);
  assert.match(css, /\.formDeleteCancelButtonProminent\s*\{[\s\S]*?min-height:\s*48px[\s\S]*?min-width:\s*164px[\s\S]*?font-weight:\s*700/);
  assert.match(css, /\.formDeleteConfirmButtonSubtle\s*\{[\s\S]*?min-height:\s*38px/);
  assert.match(form, /const confirmDeleteRow = \(rowId: string\) => \{\s*manager\.clearRowFiles\(rowId\);/);

  // Verify manager.clearRowFiles removes only that row's files and preserves other rows
  const notifyStore = createNotifyStore();
  const manager = createFormSaveUploadJobManager({ notify: notifyStore.api });
  manager.selectPreSaveFile(
    "row-1",
    "WORKER_PORTRAIT",
    new File([new Uint8Array(512)], "row1.png", { type: "image/png" }),
  );
  manager.selectPreSaveFile(
    "row-2",
    "WORKER_PORTRAIT",
    new File([new Uint8Array(512)], "row2.png", { type: "image/png" }),
  );
  manager.clearRowFiles("row-1");
  assert.equal(manager.getRowSlots("row-1").WORKER_PORTRAIT.status, "idle");
  assert.equal(manager.getRowSlots("row-2").WORKER_PORTRAIT.status, "selected");
  assert.equal(manager.getRowSlots("row-2").WORKER_PORTRAIT.fileName, "row2.png");
});

test("Grid mode and shared stage controllers remain intact without regression", () => {
  assert.match(stageSlots, /if \(file !== null\) onStage\(rowKey, file\)/);
  assert.match(live, /const portraitStages = useWorkerPortraitStages\(/);
  for (const documentType of ["CCCD_FRONT", "CCCD_BACK", "EMPLOYMENT_CONTRACT"]) {
    assert.match(live, new RegExp(`documentType: "${documentType}"`));
  }
  assert.match(live, /documentStageIdsBySourceRow/);
  assert.match(uploads, /<DirectEntryCccdManager/);
  assert.match(uploads, /<DirectEntryDocumentEditor/);
  assert.match(documentEditor, /fetchEntryDetail\(entryId, fetch\)/);
});
