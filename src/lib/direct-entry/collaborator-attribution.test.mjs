import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseDirectEntryCatalogResponse } from "./catalog-response.ts";
import {
  buildProposerItems,
  projectProposerEntry,
  PROPOSER_FIELD_ORDER,
} from "./change-request-proposer.ts";
import {
  buildEntryFieldProposal,
  workerEntryFormFromBaseline,
} from "./change-request-proposal-builders.ts";
import { buildReviewerViewModel, catalogCollaboratorLabel } from "./change-request-reviewer.ts";
import {
  DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS,
  DIRECT_ENTRY_GRID_COLUMNS,
  DIRECT_ENTRY_PROVIDER_OPTIONS,
  recruitersForProvider,
} from "./direct-entry-grid-columns.ts";
import { buildSpreadsheetValidation } from "./direct-entry-grid-validation.ts";
import { buildFormProfileValidation } from "./form-profile-validation.ts";
import {
  buildCccdRequiredFullProfileRequestBody,
  buildServerGeneratedFullProfileRequestBody,
} from "./full-profile-batch.ts";
import { parseFullProfilePayload } from "./full-profile-contract.ts";
import {
  buildDraftUpdatePayload,
  draftRowFromProjection,
  updateLiveDraftRow,
} from "./live-controller.ts";
import { patchLiveDraftRowFromGrid } from "./live-grid-paste.ts";
import { projectPrivilegedEditRequest } from "./privileged-edit-api.ts";
import {
  createSpreadsheetRowModel,
  updateSpreadsheetRowCells,
  updateSpreadsheetRowProviderType,
} from "./spreadsheet-row-model.ts";
import { projectWorkerDetail } from "./worker-detail-projection.ts";
import {
  projectWorkerDirectoryRow,
  WORKER_PROVIDER_TYPES,
} from "./worker-directory-contract.ts";
import {
  projectWorkerExportRow,
  WORKER_EXPORT_COLUMNS,
} from "./worker-export-contract.ts";
import {
  buildDirectEditEntryFieldProposal,
  buildWorkerEditCollaboratorOptions,
  workerProviderTypeLabel,
} from "./worker-operations-model.ts";
import { projectDraftCatalog } from "./write-repository.ts";

const HRP_RECRUITER_ID = "93000000-0000-4000-8000-000000000001";
const VENDOR_RECRUITER_ID = "93000000-0000-4000-8000-000000000002";
const ENTRY_ID = "c1000000-0000-4000-8000-000000000001";
const SUBMISSION_ID = "b1000000-0000-4000-8000-000000000001";

function baseCatalogResponse(overrides = {}) {
  return {
    ok: true,
    catalog: {
      effective_date: "2026-11-28",
      projects: [{ project_id: "P1", display_name: "Compal" }],
      recruiters: [
        {
          recruiter_id: HRP_RECRUITER_ID,
          display_name: "Nguyễn An",
          label: "Nguyễn An · nvtd01 · Team 1",
          provider_type: "hrp",
          team_id: "94000000-0000-4000-8000-000000000001",
          team_display_name: "Team 1",
          personnel_code: "nvtd01",
          vendor_id: null,
        },
        {
          recruiter_id: VENDOR_RECRUITER_ID,
          display_name: "Vendor Alpha",
          label: "Vendor Alpha",
          provider_type: "vendor",
          team_id: null,
          team_display_name: null,
          personnel_code: null,
          vendor_id: "VENDOR_A",
        },
      ],
      banks: [{ bank_id: "VCB", display_name: "Vietcombank" }],
      labor_types: [{ labor_type_key: "PERMANENT", display_name: "Chính thức", sort_order: 1 }],
      collaborators: [
        { collaborator_id: "CTV001", display_name: "Trần CTV Một", active: true },
        { collaborator_id: "CTV002", display_name: "Lê CTV Ngừng", active: false },
      ],
      ...overrides,
    },
  };
}

test("catalog parsers keep backward compatibility when collaborators omitted and parse when present", () => {
  const withoutCtv = baseCatalogResponse();
  delete withoutCtv.catalog.collaborators;
  const parsedWithout = parseDirectEntryCatalogResponse(withoutCtv, "2026-11-28");
  assert.deepEqual(parsedWithout?.collaborators, []);

  const parsedWith = parseDirectEntryCatalogResponse(baseCatalogResponse(), "2026-11-28");
  assert.deepEqual(parsedWith?.collaborators, [
    { collaborator_id: "CTV001", display_name: "Trần CTV Một", active: true },
    { collaborator_id: "CTV002", display_name: "Lê CTV Ngừng", active: false },
  ]);

  const projectedRepo = projectDraftCatalog(baseCatalogResponse().catalog);
  assert.equal(projectedRepo?.collaborators?.length, 2);
});

test("grid columns and spreadsheet row model handle 3 sources and clear CTV on source switch", () => {
  assert.deepEqual([...DIRECT_ENTRY_PROVIDER_OPTIONS], ["HRP", "Vendor", "CTV"]);
  const colIdx = DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.indexOf("collaborator_id");
  const recIdx = DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.indexOf("recruiter_id");
  assert.equal(colIdx, recIdx + 1);
  assert.equal(DIRECT_ENTRY_GRID_COLUMNS.length, 29);

  const recruiters = [
    { id: HRP_RECRUITER_ID, label: "An", provider_type: "hrp" },
    { id: VENDOR_RECRUITER_ID, label: "Vendor A", provider_type: "vendor" },
  ];
  assert.deepEqual(recruitersForProvider(recruiters, "ctv"), [recruiters[0]]);

  let model = createSpreadsheetRowModel();
  const rowId = model.rows[0].clientRowId;
  model = updateSpreadsheetRowProviderType(model, rowId, "ctv");
  model = updateSpreadsheetRowCells(model, rowId, {
    recruiter_id: HRP_RECRUITER_ID,
    collaborator_id: "CTV001",
  });
  assert.equal(model.rows[0].providerType, "ctv");
  assert.equal(model.rows[0].cells.collaborator_id, "CTV001");

  // Switching CTV -> HRP preserves HRP recruiter and clears collaborator_id
  model = updateSpreadsheetRowProviderType(model, rowId, "hrp");
  assert.equal(model.rows[0].providerType, "hrp");
  assert.equal(model.rows[0].cells.recruiter_id, HRP_RECRUITER_ID);
  assert.equal(model.rows[0].cells.collaborator_id, "");

  // Switching CTV -> Vendor clears BOTH recruiter_id and collaborator_id
  model = updateSpreadsheetRowProviderType(model, rowId, "ctv");
  model = updateSpreadsheetRowCells(model, rowId, {
    recruiter_id: HRP_RECRUITER_ID,
    collaborator_id: "CTV001",
  });
  model = updateSpreadsheetRowProviderType(model, rowId, "vendor");
  assert.equal(model.rows[0].providerType, "vendor");
  assert.equal(model.rows[0].cells.recruiter_id, "");
  assert.equal(model.rows[0].cells.collaborator_id, "");
});

test("grid and form validation enforce active CTV when providerType === ctv", () => {
  const catalogFor = () => ({
    projects: [{ id: "P1", label: "Compal" }],
    recruiters: [
      { id: HRP_RECRUITER_ID, label: "Nguyễn An", provider_type: "hrp", personnel_code: "nvtd01", vendor_id: null },
      { id: VENDOR_RECRUITER_ID, label: "Vendor Alpha", provider_type: "vendor", personnel_code: null, vendor_id: "VENDOR_A" },
    ],
    labor_types: [{ id: "PERMANENT", label: "Chính thức" }],
    collaborators: [
      { id: "CTV001", label: "Trần CTV Một (CTV001)", active: true },
      { id: "CTV002", label: "Lê CTV Ngừng (CTV002)", active: false },
    ],
  });

  let model = createSpreadsheetRowModel();
  const rowId = model.rows[0].clientRowId;
  model = updateSpreadsheetRowProviderType(model, rowId, "ctv");
  model = updateSpreadsheetRowCells(model, rowId, {
    project_id: "P1",
    recruiter_id: HRP_RECRUITER_ID,
    labor_type: "PERMANENT",
    first_work_date: "2026-11-28",
    display_name: "Nguyễn Văn A",
    national_id: "012345678901",
  });

  const missingCtv = buildSpreadsheetValidation({
    rows: [model.rows[0]],
    referenceDate: "2026-11-28",
    catalogFor,
    existing: [],
  });
  assert.equal(missingCtv.canSave, false);
  assert.ok(missingCtv.cellIssues.some((i) => i.columnKey === "collaborator_id" && i.code === "CTV_REQUIRED"));

  const missingCtvForm = buildFormProfileValidation({
    rows: [model.rows[0]],
    referenceDate: "2026-11-28",
    catalogFor,
    existing: [],
  });
  assert.equal(missingCtvForm.canSave, false);
  assert.ok(missingCtvForm.cellIssues.some((i) => i.columnKey === "collaborator_id" && i.code === "CTV_REQUIRED"));

  const inactiveModel = updateSpreadsheetRowCells(model, rowId, { collaborator_id: "CTV002" });
  const inactiveCtv = buildSpreadsheetValidation({
    rows: [inactiveModel.rows[0]],
    referenceDate: "2026-11-28",
    catalogFor,
    existing: [],
  });
  assert.equal(inactiveCtv.canSave, false);
  assert.ok(inactiveCtv.cellIssues.some((i) => i.columnKey === "collaborator_id"));

  const validModel = updateSpreadsheetRowCells(model, rowId, { collaborator_id: "CTV001" });
  const validGrid = buildSpreadsheetValidation({
    rows: [validModel.rows[0]],
    referenceDate: "2026-11-28",
    catalogFor,
    existing: [],
  });
  assert.equal(validGrid.canSave, true);
  assert.equal(validGrid.preview?.rows[0]?.resolved.collaborator_id, "CTV001");

  const validForm = buildFormProfileValidation({
    rows: [validModel.rows[0]],
    referenceDate: "2026-11-28",
    catalogFor,
    existing: [],
  });
  assert.equal(validForm.canSave, true);
  assert.equal(validForm.preview?.rows[0]?.resolved.collaborator_id, "CTV001");

  const serverBody = buildServerGeneratedFullProfileRequestBody(validGrid.preview.rows);
  assert.equal(serverBody?.rows[0]?.collaborator_id, "CTV001");
  const cccdBody = buildCccdRequiredFullProfileRequestBody(validForm.preview.rows);
  assert.equal(cccdBody?.rows[0]?.collaborator_id, "CTV001");
});

test("full-profile, draft controller, privileged-edit, and CR flows carry collaborator_id cleanly", () => {
  const parsed = parseFullProfilePayload({
    contract_version: "worker-profile/1.0",
    rows: [{
      first_work_date: "2026-11-28",
      employee_code: "hrp-2026-000001",
      project_id: "P1",
      recruiter_id: HRP_RECRUITER_ID,
      collaborator_id: "CTV001",
      labor_type: "PERMANENT",
      display_name: "Nguyễn Văn A",
      worker: {
        gender: { state: "omitted" },
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      general_note: { state: "omitted" },
      employment: { initial_status: "ON" },
      payment: { state: "omitted" },
    }],
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.payload.rows[0].collaborator_id, "CTV001");

  const draftRow = draftRowFromProjection({
    entry_id: ENTRY_ID,
    submission_id: SUBMISSION_ID,
    entry_version: 2,
    submission_version: 1,
    submission_state: "DRAFT",
    project_id: "P1",
    project_display_name: "Compal",
    first_work_date: "2026-11-28",
    employee_code: "hrp-2026-000001",
    worker_display_name: "Nguyễn Văn A",
    recruiter_id: HRP_RECRUITER_ID,
    recruiter_display_name: "Nguyễn An",
    provider_type: "hrp",
    team_id: "94000000-0000-4000-8000-000000000001",
    team_display_name: "Team 1",
    collaborator_id: "CTV001",
    collaborator_display_name: "Trần CTV Một",
    labor_type: "PERMANENT",
    labor_type_display: "Chính thức",
    employment_status: "ON",
    profile: {
      contract_version: "worker-profile/1.0",
      worker_details: {
        display_name: { state: "provided", value: "Nguyễn Văn A" },
        gender: { state: "omitted" },
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      general_note: { state: "omitted" },
      employment: null,
      payment: null,
    },
  });
  assert.equal(draftRow.providerType, "ctv");
  assert.equal(draftRow.collaboratorId, "CTV001");
  assert.equal(draftRow.collaboratorDisplayName, "Trần CTV Một");

  const cleared = updateLiveDraftRow([draftRow], draftRow.rowId, {
    collaboratorId: null,
    providerType: "hrp",
  })[0];
  assert.equal(cleared.state, "dirty");
  const patchPayload = buildDraftUpdatePayload(cleared, null);
  assert.equal(patchPayload?.collaborator_id, null);

  const patchedVendor = patchLiveDraftRowFromGrid(draftRow, { recruiter_id: VENDOR_RECRUITER_ID }, [
    {
      recruiter_id: HRP_RECRUITER_ID,
      display_name: "An",
      label: "An",
      provider_type: "hrp",
      team_id: null,
      team_display_name: null,
      personnel_code: "nvtd01",
      vendor_id: null,
      active: true,
    },
    {
      recruiter_id: VENDOR_RECRUITER_ID,
      display_name: "Vendor A",
      label: "Vendor A",
      provider_type: "vendor",
      team_id: null,
      team_display_name: null,
      personnel_code: null,
      vendor_id: "VA",
      active: true,
    },
  ]);
  assert.equal(patchedVendor.providerType, "vendor");
  assert.equal(patchedVendor.collaboratorId, null);

  const priv = projectPrivilegedEditRequest({
    expected_entry_version: 2,
    patch: { collaborator_id: "CTV001" },
  });
  assert.deepEqual(priv, {
    expected_entry_version: 2,
    patch: { collaborator_id: "CTV001" },
    reason: null,
  });

  assert.ok(PROPOSER_FIELD_ORDER.includes("collaborator_id"));
  const proposerEntry = projectProposerEntry({
    entry_id: ENTRY_ID,
    version: 3,
    project_id: "P1",
    first_work_date: "2026-11-28",
    employee_code: "hrp-2026-000001",
    recruiter_id: HRP_RECRUITER_ID,
    collaborator_id: "CTV001",
    collaborator_display_name: "Trần CTV Một",
    labor_type: "PERMANENT",
    labor_type_display: "Chính thức",
  });
  assert.equal(proposerEntry?.collaborator_id, "CTV001");

  const crBuilt = buildProposerItems([{
    entry_id: ENTRY_ID,
    expected_version: 3,
    baseline: {
      employee_code: "hrp-2026-000001",
      first_work_date: "2026-11-28",
      project_id: "P1",
      recruiter_id: HRP_RECRUITER_ID,
      collaborator_id: null,
      labor_type: "PERMANENT",
    },
    draft: {
      employee_code: "hrp-2026-000001",
      first_work_date: "2026-11-28",
      project_id: "P1",
      recruiter_id: HRP_RECRUITER_ID,
      collaborator_id: "CTV001",
      labor_type: "PERMANENT",
    },
  }]);
  assert.equal(crBuilt.ok, true);
  assert.deepEqual(crBuilt.items[0].proposal, { collaborator_id: "CTV001" });

  const workerBaseline = {
    project_id: "P1",
    first_work_date: "2026-11-28",
    employee_code: "hrp-2026-000001",
    recruiter_id: HRP_RECRUITER_ID,
    collaborator_id: "CTV001",
    labor_type: "PERMANENT",
    worker_details: {
      display_name: "Nguyễn Văn A",
      date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" },
      national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
  };
  const form = workerEntryFormFromBaseline(workerBaseline);
  form.collaborator_id = null;
  const proposal = buildEntryFieldProposal({
    entryId: ENTRY_ID,
    expectedVersion: 2,
    baseline: workerBaseline,
    form,
  });
  assert.equal(proposal.ok, true);
  assert.deepEqual(proposal.proposal, { collaborator_id: null });

  const directProposal = buildDirectEditEntryFieldProposal({
    baseline: workerBaseline,
    form,
  });
  assert.equal(directProposal.ok, true);
  assert.deepEqual(directProposal.proposal, { collaborator_id: null });

  assert.equal(
    catalogCollaboratorLabel({ collaborators: baseCatalogResponse().catalog.collaborators }, "CTV002"),
    "Lê CTV Ngừng (CTV002)",
  );

  const reviewerVm = buildReviewerViewModel({
    detail: {
      request_id: ENTRY_ID,
      state: "PENDING",
      version: 1,
      created_at: "2026-11-28T00:00:00Z",
      request_reason: null,
      can_withdraw: false,
      can_decide: true,
      items: [{
        item_id: ENTRY_ID,
        entry_id: ENTRY_ID,
        target_kind: "ENTRY_FIELD",
        expected_version: 3,
        proposal: { collaborator_id: "CTV002" },
        collaborator_display: "Lê CTV Ngừng (CTV002)",
      }],
    },
    entries: new Map([[ENTRY_ID, {
      ...proposerEntry,
      collaborator_id: null,
      collaborator_display_name: null,
    }]]),
    format: (_entry, field, value, authoritativeDisplay) => {
      if (field === "collaborator_id") {
        return value === "" ? "Không qua CTV" : (authoritativeDisplay ?? value);
      }
      return value;
    },
    contexts: new Map(),
    bankLabel: () => null,
  });
  assert.equal(reviewerVm.kind, "reviewable");
  assert.equal(reviewerVm.items[0].rows[0].before, "Không qua CTV");
  assert.equal(reviewerVm.items[0].rows[0].after, "Lê CTV Ngừng (CTV002)");
});

test("worker detail, directory, export, and edit options support active and deactivated CTVs", () => {
  const detail = projectWorkerDetail({
    ok: true,
    entry: {
      entry_id: ENTRY_ID,
      version: 2,
      created_at: "2026-11-28T00:00:00.000000Z",
      created_by: { display_name: "Tester", login_id: "tester" },
      project_id: "P1",
      first_work_date: "2026-11-28",
      employee_code: "hrp-2026-000001",
      recruiter_id: HRP_RECRUITER_ID,
      labor_type: "PERMANENT",
      labor_type_display: "Chính thức",
      provider_type: "hrp",
      collaborator_id: "CTV002",
      collaborator_display_name: "Lê CTV Ngừng",
      employment_status: { status: "ON", effective_date: "2026-11-28", version: 1 },
      documents: [],
      worker_portrait: null,
      worker_details: {
        display_name: "Nguyễn Văn A",
        gender: { state: "omitted" },
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
    },
  }, ENTRY_ID);
  assert.equal(detail?.collaboratorId, "CTV002");
  assert.equal(detail?.providerLabel, "CTV · Lê CTV Ngừng");

  assert.deepEqual([...WORKER_PROVIDER_TYPES], ["hrp", "hrp_direct", "hrp_ctv", "vendor"]);
  assert.equal(workerProviderTypeLabel("hrp_ctv"), "Qua CTV");

  const dirRow = projectWorkerDirectoryRow({
    entry_id: ENTRY_ID,
    entry_version: 2,
    submission_state: "SUBMITTED",
    display_name: "Nguyễn Văn A",
    employee_code: "hrp-2026-000001",
    project_id: "P1",
    project_display: "Compal",
    first_work_date: "2026-11-28",
    recruiter_id: HRP_RECRUITER_ID,
    recruiter_display: "Nguyễn An",
    provider_type: "hrp",
    collaborator_id: "CTV002",
    collaborator_display_name: "Lê CTV Ngừng",
    employment_status: "ON",
    labor_type: "PERMANENT",
    labor_type_display: "Chính thức",
    payment: null,
    pending_request: null,
    last_decision: null,
    is_project_manager: false,
    allowed_actions: {
      view: true,
      view_pii: true,
      view_payment: true,
      propose_change: false,
      propose_change_code: null,
      direct_edit: false,
    },
  });
  assert.equal(dirRow?.collaborator_id, "CTV002");
  assert.equal(dirRow?.collaborator_display_name, "Lê CTV Ngừng");

  assert.equal(WORKER_EXPORT_COLUMNS.length, 21);
  const expRow = projectWorkerExportRow({
    employee_code: "hrp-2026-000001",
    display_name: "Nguyễn Văn A",
    date_of_birth: null,
    national_id: null,
    national_id_issued_at: null,
    phone: null,
    address: null,
    project_display: "Compal",
    first_work_date: "2026-11-28",
    labor_type_display: "Chính thức",
    recruiter_display: "Nguyễn An",
    provider_type: "CTV",
    collaborator_id: "CTV002",
    collaborator_display_name: "Lê CTV Ngừng",
    employment_status: "ON",
    leave_date: null,
    leave_reason: null,
    account_number: null,
    bank_name: null,
    account_holder_name: null,
    payment_note: null,
    general_note: null,
  });
  assert.equal(expRow?.provider_type, "CTV");
  assert.equal(expRow?.collaborator_display_name, "Lê CTV Ngừng");

  const options = buildWorkerEditCollaboratorOptions({
    catalogCollaborators: baseCatalogResponse().catalog.collaborators,
    currentCollaboratorId: "CTV002",
    currentCollaboratorDisplay: "Lê CTV Ngừng",
  });
  assert.equal(options[0].value, "CTV002");
  assert.equal(options[0].isCurrentFallback, true);
  assert.match(options[0].label, /hiện tại/);
  assert.equal(options[1].value, "CTV001");
});

test("UI components wire 3 source options and dependent CTV controls", () => {
  const gridSrc = readFileSync(new URL("../../components/direct-entry/direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
  const formSrc = readFileSync(new URL("../../components/direct-entry/direct-entry-multi-entry-form.tsx", import.meta.url), "utf8");
  const liveSrc = readFileSync(new URL("../../components/direct-entry/direct-entry-live.tsx", import.meta.url), "utf8");
  assert.match(gridSrc, /<option value="ctv">CTV<\/option>/);
  assert.match(gridSrc, /column\.key !== "collaborator_id" \|\| row\.providerType === "ctv"/);
  assert.match(formSrc, /<option value="ctv">CTV<\/option>/);
  assert.match(formSrc, /disabled=\{row\.providerType !== "ctv"\}/);
  assert.match(liveSrc, /collaborator_id/);
});
