import {
  captureClipboardUndoSnapshot,
  type ClipboardMapResult,
  type ClipboardUndoSnapshot,
} from "./direct-entry-grid-clipboard.ts";
import {
  SPREADSHEET_MAX_DATA_ROWS,
  SPREADSHEET_WRITABLE_FIELD_KEYS,
  ensureSpreadsheetRowCount,
  updateSpreadsheetRowCells,
  type SpreadsheetRowModel,
} from "./spreadsheet-row-model.ts";
import {
  updateLiveDraftRow,
  type EditableDraftFields,
  type LiveDraftRow,
} from "./live-controller.ts";
import type {
  DraftCatalogRecruiter,
  DraftPaymentAccountField,
  DraftProfileField,
} from "./write-repository.ts";

export const DRAFT_EDITABLE_GRID_FIELDS = Object.freeze([
  "project_id", "first_work_date", "display_name", "provider_type", "recruiter_id", "collaborator_id",
  "labor_type", "initial_status", "phone", "national_id", "gender", "date_of_birth",
  "national_id_issued_at", "address", "account_number", "bank_name",
  "account_holder_name", "general_note",
]);

const GENDER_CODES: Record<string, string> = { Nam: "MALE", Nữ: "FEMALE", Khác: "OTHER" };
const WORK_STATUS_CODES: Record<string, "ON" | "UNCONFIRMED"> = {
  "Đang làm": "ON", "Đang làm việc": "ON", "Đang chờ việc": "UNCONFIRMED",
};
const STAGED_EDITABLE_FIELDS = Object.freeze([
  "provider_type", ...SPREADSHEET_WRITABLE_FIELD_KEYS, "collaborator_id",
]);

type GridRow = {
  clientRowId: string;
  persisted: boolean;
  clientStaged: boolean;
  locked: boolean;
  editableFields: readonly string[];
  cells: Readonly<Record<string, string>>;
};

export type LiveGridPasteUndoSnapshot = {
  clipboard: ClipboardUndoSnapshot;
  persistedRowIds: readonly string[];
  persistedRows: readonly LiveDraftRow[];
};

export type LiveGridPasteResult =
  | {
      ok: true;
      liveRows: LiveDraftRow[];
      stagedModel: SpreadsheetRowModel;
      undo: LiveGridPasteUndoSnapshot;
    }
  | {
      ok: false;
      code: "CLIPBOARD_PROTECTED_CELL" | "CLIPBOARD_TARGET_INVALID";
    };

function changedProfileField<T extends DraftProfileField | DraftPaymentAccountField>(
  field: T,
  value: string,
  canonical?: string,
): T {
  const next = canonical ?? value;
  if (field.state === "provided" && field.value === next) return field;
  if (next !== "") return { state: "provided" as const, value: next } as T;
  return (field.state === "provided" ? { state: "intentionally_blank" as const } : field) as T;
}

export function patchLiveDraftRowFromGrid(
  row: LiveDraftRow,
  patch: Readonly<Record<string, string>>,
  recruiters: readonly DraftCatalogRecruiter[],
): LiveDraftRow {
  const safePatch = patch.employee_code === undefined
    ? patch
    : Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "employee_code"));
  const draftPatch: Partial<EditableDraftFields> = {};
  if (safePatch.first_work_date !== undefined) draftPatch.firstWorkDate = safePatch.first_work_date;
  if (safePatch.display_name !== undefined) draftPatch.workerName = safePatch.display_name;
  if (safePatch.project_id !== undefined) draftPatch.projectId = safePatch.project_id;
  if (safePatch.recruiter_id !== undefined) {
    draftPatch.recruiterId = safePatch.recruiter_id;
    const recruiter = recruiters.find((option) => option.recruiter_id === safePatch.recruiter_id);
    if (recruiter) {
      if (recruiter.provider_type === "vendor") {
        draftPatch.providerType = recruiter.provider_type;
        draftPatch.collaboratorId = null;
      } else if (!row.collaboratorId && safePatch.collaborator_id === undefined) {
        draftPatch.providerType = recruiter.provider_type;
      }
    }
  }
  if (safePatch.labor_type !== undefined) draftPatch.laborType = safePatch.labor_type;
  if (safePatch.provider_type === "hrp" || safePatch.provider_type === "vendor" || safePatch.provider_type === "ctv") {
    const targetRecruiterProvider = safePatch.provider_type === "ctv" ? "hrp" : safePatch.provider_type;
    const recruiter = recruiters.find((option) => option.provider_type === targetRecruiterProvider);
    if (!recruiter) return row;
    draftPatch.providerType = safePatch.provider_type;
    draftPatch.recruiterId = recruiter.recruiter_id;
    if (safePatch.provider_type !== "ctv") draftPatch.collaboratorId = null;
  }
  if (safePatch.collaborator_id !== undefined) {
    draftPatch.collaboratorId = safePatch.collaborator_id.trim() || null;
  }
  const workerKeys = [
    "phone", "national_id", "gender", "date_of_birth", "national_id_issued_at",
    "national_id_issued_place", "address",
  ] as const;
  const worker = { ...row.profile.worker_details };
  let workerChanged = false;
  for (const key of workerKeys) {
    if (safePatch[key] === undefined) continue;
    const currentField = worker[key];
    const canonical = key === "gender" ? GENDER_CODES[safePatch[key]] : undefined;
    worker[key] = changedProfileField(currentField, safePatch[key], canonical) as typeof currentField;
    workerChanged = true;
  }
  if (safePatch.display_name !== undefined) {
    draftPatch.workerName = safePatch.display_name;
    worker.display_name = { state: "provided", value: safePatch.display_name };
    workerChanged = true;
  }
  let profile = row.profile;
  if (workerChanged) profile = { ...profile, worker_details: worker };
  if (safePatch.general_note !== undefined) {
    profile = {
      ...profile,
      general_note: safePatch.general_note === ""
        ? { state: "intentionally_blank" }
        : { state: "provided", value: safePatch.general_note },
    };
  }
  if (safePatch.initial_status !== undefined && profile.employment) {
    const status = WORK_STATUS_CODES[safePatch.initial_status];
    if (status) profile = { ...profile, employment: { ...profile.employment, status } };
  }
  const paymentKeys = ["account_number", "bank_name", "account_holder_name"] as const;
  if (paymentKeys.some((key) => safePatch[key] !== undefined)) {
    const previous = profile.payment;
    const payment = previous ?? {
      state: "intentionally_blank" as const,
      account_number: { state: "intentionally_blank" as const },
      bank_name: { state: "intentionally_blank" as const },
      account_holder_name: { state: "intentionally_blank" as const },
      version: 0,
    };
    profile = {
      ...profile,
      payment: {
        ...payment,
        account_number: safePatch.account_number === undefined
          ? payment.account_number
          : changedProfileField(payment.account_number, safePatch.account_number),
        bank_name: safePatch.bank_name === undefined
          ? payment.bank_name
          : changedProfileField(payment.bank_name, safePatch.bank_name) as DraftProfileField,
        account_holder_name: safePatch.account_holder_name === undefined
          ? payment.account_holder_name
          : changedProfileField(payment.account_holder_name, safePatch.account_holder_name) as DraftProfileField,
        state: "provided",
      },
    };
  }
  if (profile !== row.profile) draftPatch.profile = profile;
  if (Object.keys(draftPatch).length === 0) return row;
  return updateLiveDraftRow([row], row.rowId, draftPatch)[0] ?? row;
}

export function applyLiveGridPaste(input: {
  mapping: Extract<ClipboardMapResult, { ok: true }>;
  gridRows: readonly GridRow[];
  liveRows: readonly LiveDraftRow[];
  stagedModel: SpreadsheetRowModel;
  recruiters: readonly DraftCatalogRecruiter[];
  laborTypeDefault?: string;
  now?: Date;
}): LiveGridPasteResult {
  const persistedGridRows = input.gridRows.filter((row) => row.persisted && !row.clientStaged);
  const persistedRowIds = persistedGridRows.map((row) => row.clientRowId);
  const maximumRowIndex = input.mapping.cells.reduce(
    (maximum, cell) => Math.max(maximum, cell.rowIndex),
    -1,
  );
  const requiredStagedRows = maximumRowIndex + 1 - persistedGridRows.length;
  if (requiredStagedRows > SPREADSHEET_MAX_DATA_ROWS) {
    return { ok: false, code: "CLIPBOARD_TARGET_INVALID" };
  }
  const stagedModel = ensureSpreadsheetRowCount(
    input.stagedModel,
    Math.max(0, requiredStagedRows),
    input.laborTypeDefault,
  );
  const targets: GridRow[] = [
    ...persistedGridRows,
    ...stagedModel.rows.map((row) => ({
      clientRowId: row.clientRowId,
      persisted: false,
      clientStaged: true,
      locked: false,
      editableFields: STAGED_EDITABLE_FIELDS,
      cells: row.cells,
    })),
  ];
  for (const cell of input.mapping.cells) {
    const target = targets[cell.rowIndex];
    if (!target) return { ok: false, code: "CLIPBOARD_TARGET_INVALID" };
    if (target.locked || !target.editableFields.includes(cell.columnKey)) {
      return { ok: false, code: "CLIPBOARD_PROTECTED_CELL" };
    }
  }

  const undo = captureClipboardUndoSnapshot({
    mapping: input.mapping,
    currentRowCount: persistedGridRows.length + input.stagedModel.rows.length,
    readCell: (rowIndex, columnKey) => targets[rowIndex]?.cells[columnKey],
  });
  const patches = new Map<number, Record<string, string>>();
  for (const cell of input.mapping.writeCells) {
    const bucket = patches.get(cell.rowIndex) ?? {};
    bucket[cell.columnKey] = cell.value;
    patches.set(cell.rowIndex, bucket);
  }
  let liveRows = [...input.liveRows];
  let nextStagedModel = stagedModel;
  for (const [rowIndex, patch] of patches) {
    if (rowIndex < persistedGridRows.length) {
      const rowId = persistedGridRows[rowIndex]?.clientRowId;
      liveRows = liveRows.map((row) => row.rowId === rowId
        ? patchLiveDraftRowFromGrid(row, patch, input.recruiters)
        : row);
      continue;
    }
    const stagedRow = nextStagedModel.rows[rowIndex - persistedGridRows.length];
    if (!stagedRow) return { ok: false, code: "CLIPBOARD_TARGET_INVALID" };
    nextStagedModel = updateSpreadsheetRowCells(
      nextStagedModel,
      stagedRow.clientRowId,
      patch,
      input.now,
      input.laborTypeDefault,
    );
  }
  return {
    ok: true,
    liveRows,
    stagedModel: nextStagedModel,
    undo: {
      clipboard: undo,
      persistedRowIds: Object.freeze(persistedRowIds),
      persistedRows: Object.freeze(input.liveRows.filter((row) =>
        input.mapping.writeCells.some((cell) =>
          cell.rowIndex < persistedGridRows.length &&
          persistedGridRows[cell.rowIndex]?.clientRowId === row.rowId))),
    },
  };
}

export function undoLiveGridPaste(input: {
  snapshot: LiveGridPasteUndoSnapshot;
  liveRows: readonly LiveDraftRow[];
  stagedModel: SpreadsheetRowModel;
  laborTypeDefault?: string;
  now?: Date;
}): { liveRows: LiveDraftRow[]; stagedModel: SpreadsheetRowModel } {
  const patches = new Map<number, Record<string, string>>();
  for (const cell of input.snapshot.clipboard.cells) {
    const bucket = patches.get(cell.rowIndex) ?? {};
    bucket[cell.columnKey] = cell.previousValue ?? "";
    patches.set(cell.rowIndex, bucket);
  }
  const persistedRows = new Map(input.snapshot.persistedRows.map((row) => [row.rowId, row]));
  const liveRows = input.liveRows.map((row) => persistedRows.get(row.rowId) ?? row);
  const persistedCount = input.snapshot.persistedRowIds.length;
  const previousStagedCount = Math.max(
    0,
    input.snapshot.clipboard.previousRowCount - persistedCount,
  );
  let stagedModel: SpreadsheetRowModel = {
    ...input.stagedModel,
    rows: input.stagedModel.rows.slice(0, previousStagedCount),
  };
  for (const [rowIndex, patch] of patches) {
    if (rowIndex < persistedCount) {
      continue;
    }
    const stagedRow = stagedModel.rows[rowIndex - persistedCount];
    if (!stagedRow) continue;
    stagedModel = updateSpreadsheetRowCells(
      stagedModel,
      stagedRow.clientRowId,
      patch,
      input.now,
      input.laborTypeDefault,
    );
  }
  return { liveRows, stagedModel };
}
