import { WORKER_PROFILE_FIELDS } from "./worker-profile-import-contract.ts";

export const SPREADSHEET_INITIAL_ROW_COUNT = 30;
export const SPREADSHEET_SPARE_ROW_COUNT = 10;
export const SPREADSHEET_MAX_DATA_ROWS = 100;

const CLIENT_ROW_ID_PREFIX = "spreadsheet-row";

/** First-work-date default la ngay hien tai theo Asia/Ho_Chi_Minh (GMT+7). */
export const SPREADSHEET_DEFAULT_DATE_FIELD_KEY = "first_work_date";

/**
 * P3-W07C-R3: không còn lazy default cho `national_id_issued_place`. Giá
 * trị "Bộ Công An" do server-authoritative migration #46 ghi tại RPC
 * create-batch; client không cần (và không nên) nhập trường này nữa. Các
 * key còn lại trong row (date_of_birth, national_id, ...) vẫn do user
 * nhập và không tự điền.
 */

/**
 * Tra ve ngay hien tai (YYYY-MM-DD) theo timezone Asia/Ho_Chi_Minh. Tranh
 * dung `toISOString()` vi mac dinh la UTC, gay lech ngay khi may o GMT-/+ khac.
 */
export function spreadsheetDefaultFirstWorkDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * The persisted worker-profile fields are the only user-entered values owned by
 * this model. Derived, status, document and action columns remain outside it.
 */
export const SPREADSHEET_WRITABLE_FIELD_KEYS: readonly string[] = Object.freeze(
  WORKER_PROFILE_FIELDS.filter((field) => field.persisted && field.key !== "employee_code")
    .map((field) => field.key),
);

const WRITABLE_FIELD_KEYS = new Set([...SPREADSHEET_WRITABLE_FIELD_KEYS, "collaborator_id"]);

export type SpreadsheetStagedRow = {
  /** Client-only stable identity. It is never a server entry identifier. */
  clientRowId: string;
  /**
   * Raw cell text as entered or pasted. Validation happens in a separate adapter.
   *
   * P3-W07C-R3: chỉ còn `first_work_date` là lazy default (CHỦ khi row
   * được kích hoạt lần đầu). Trước khi kích hoạt, ô giữ string rỗng;
   * render layer hiện placeholder mờ. `national_id_issued_place` không
   * còn tự điền ở client — server-authoritative migration #46 ghi
   * "Bộ Công An" tại RPC create-batch.
   */
  cells: Readonly<Record<string, string>>;
  /** Key preselected from the active catalog; ignored while identifying a blank row. */
  defaultLaborType: string;
  /**
   * P3-W07C: client-only cờ row đã được kích hoạt lazy defaults chưa. Một lần
   * kích hoạt mỗi row, không tự khởi tạo. Import/paste giữ giá trị người
   * dùng nhập (có thể trùng lazy default nếu giá trị trùng ngày hôm nay,
   * nhưng row đó có `lazyDefaultsApplied: true` vì row đã nhận giá trị).
   */
  lazyDefaultsApplied: boolean;
  /** Client-only recruiter filter/assertion; never serialized as a worker-profile field. */
  providerType: "hrp" | "vendor" | "ctv" | "";
  /** Client-only CTV collaborator ID when providerType === "ctv". */
  collaboratorId?: string;
};

export type SpreadsheetRowModel = {
  rows: readonly SpreadsheetStagedRow[];
  /** Monotonic client-only sequence used to avoid recycling IDs after deletion. */
  nextClientRowSequence: number;
};

export class SpreadsheetDataRowLimitError extends RangeError {
  constructor() {
    super(`A spreadsheet batch accepts at most ${SPREADSHEET_MAX_DATA_ROWS} data rows.`);
    this.name = "SpreadsheetDataRowLimitError";
  }
}

/**
 * P3-W07C: tra ve cells TRONG (tat ca field empty) cho staged row moi.
 * Lazy default (`first_work_date = today`) CHI duoc chen vao sau khi
 * user tuong tac lan dau voi row (click, focus, mo quick editor, sua o).
 * Truoc do render layer hien placeholder mo. P3-W07C-R3: khong con lazy
 * default cho `national_id_issued_place` (server migration #46 ghi).
 *
 * Cells o day KHONG can `lazyDefaultsApplied: true`; row moi sinh ra voi
 * `lazyDefaultsApplied: false` de phan biet voi row da duoc kich hoat.
 */
export function defaultCells(): Record<string, string> {
  return Object.fromEntries(SPREADSHEET_WRITABLE_FIELD_KEYS.map((key) => [key, ""]));
}

/**
 * P3-W07C: mot row duoc goi la blank neu KHONG co du lieu nguoi dung nao.
 * Mot row la blank neu:
 *  - tat ca writable fields empty; HOAC
 *  - row co lazy default cho first_work_date (hom nay) va khong co business
 *    field nao khac.
 *
 * P3-W07C-R3: chỉ còn lazy default cho `first_work_date`. Mọi giá trị
 * khác (kể cả `national_id_issued_place` nếu legacy template gửi lên)
 * đều tính là dữ liệu người dùng.
 *
 * Cu the: row se khong la blank neu co it nhat MOT writable field co gia
 * tri non-empty KHONG PHAI lazy default. Row chi chua first_work_date =
 * today (hoac chi empty) van la blank, duoc loai khoi save/validate.
 *
 * `now` chi dung de resolve "hom nay" (Asia/Ho_Chi_Minh) khi so sanh
 * first_work_date co phai default. Production goi khong truyen now
 * (de lay hien tai); test truyen co dinh de khoa hanh vi.
 */
export function spreadsheetRowIsBlank(
  row: SpreadsheetStagedRow,
  now: Date = new Date(),
): boolean {
  if ((row.collaboratorId ?? "").trim().length > 0 ||
      (row.cells.collaborator_id ?? "").trim().length > 0) return false;
  const today = spreadsheetDefaultFirstWorkDate(now);
  return SPREADSHEET_WRITABLE_FIELD_KEYS.every((key) => {
    const value = (row.cells[key] ?? "").trim();
    if (value.length === 0) return true;
    if (key === "labor_type" && row.defaultLaborType !== "" &&
        value === row.defaultLaborType) return true;
    if (key === SPREADSHEET_DEFAULT_DATE_FIELD_KEY) {
      return value === today;
    }
    return false;
  });
}

/**
 * P3-W07C: kich hoat lazy defaults cho mot row. Idempotent: neu row da duoc
 * kich hoat, tra ve model giu nguyen. Neu row chua co trong model, tra ve
 * nguyen model.
 *
 * P3-W07C-R3: chỉ còn lazy default cho `first_work_date` (hôm nay theo
 * Asia/Ho_Chi_Minh). `national_id_issued_place` đã do server-authoritative
 * migration #46 ghi tại RPC, không còn tự điền ở client.
 *
 * Sau khi kich hoat:
 *  - cell `first_work_date` được set nếu EMPTY (không ghi đè user/paste/import).
 *  - `lazyDefaultsApplied = true` để row không bị kích hoạt nhiều lần.
 *  - Row vẫn là blank (theo `spreadsheetRowIsBlank`) nếu không có business
 *    field nào.
 */
export function activateSpreadsheetRowLazyDefaults(
  model: SpreadsheetRowModel,
  clientRowId: string,
  now: Date = new Date(),
  laborTypeDefault = "",
): SpreadsheetRowModel {
  let changed = false;
  const today = spreadsheetDefaultFirstWorkDate(now);
  const rows = model.rows.map((row) => {
    if (row.clientRowId !== clientRowId) return row;
    if (row.lazyDefaultsApplied) return row;
    changed = true;
    const cells = { ...row.cells };
    if ((cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY] ?? "").trim() === "") {
      cells[SPREADSHEET_DEFAULT_DATE_FIELD_KEY] = today;
    }
    if ((cells.labor_type ?? "").trim() === "" && laborTypeDefault !== "") {
      cells.labor_type = laborTypeDefault;
    }
    return {
      ...row,
      cells,
      defaultLaborType: cells.labor_type ?? "",
      lazyDefaultsApplied: true,
    };
  });
  if (!changed) return model;
  return { ...model, rows };
}

/**
 * P3-W07C: import/paste mot row batch vao staged row set. Nguon du lieu
 * (paste, Excel) cung cap toan bo writable fields. Row duoc danh dau
 * `lazyDefaultsApplied: true` vi no da nhan gia tri tu nguon ngoai (nguoi
 * dung da co y thuc dien). Mot so cell co the trung lazy default neu nguoi
 * dung dan nhu vay; `spreadsheetRowIsBlank` van phan biet duoc.
 */
function importedCells(cells: Readonly<Record<string, string>>): Record<string, string> {
  const out = defaultCells();
  for (const key of SPREADSHEET_WRITABLE_FIELD_KEYS) {
    const value = cells[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function nextBlankRow(sequence: number, laborTypeDefault = ""): SpreadsheetStagedRow {
  const cells = defaultCells();
  cells.labor_type = laborTypeDefault;
  return {
    clientRowId: `${CLIENT_ROW_ID_PREFIX}-${sequence}`,
    cells,
    defaultLaborType: laborTypeDefault,
    lazyDefaultsApplied: false,
    providerType: "",
    collaboratorId: "",
  };
}

function appendBlankRows(
  model: SpreadsheetRowModel,
  count: number,
  laborTypeDefault = "",
): SpreadsheetRowModel {
  if (count <= 0) return model;

  const added = Array.from({ length: count }, (_, index) =>
    nextBlankRow(model.nextClientRowSequence + index, laborTypeDefault));

  return {
    rows: [...model.rows, ...added],
    nextClientRowSequence: model.nextClientRowSequence + count,
  };
}

function assertWritablePatch(patch: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (!WRITABLE_FIELD_KEYS.has(key)) {
      throw new TypeError(`Unknown spreadsheet writable field: ${key}`);
    }
    if (typeof value !== "string") {
      throw new TypeError(`Spreadsheet cell ${key} must be a string.`);
    }
  }
}

export function selectNonEmptySpreadsheetRows(
  model: SpreadsheetRowModel,
  now: Date = new Date(),
): SpreadsheetStagedRow[] {
  return model.rows.filter((row) => !spreadsheetRowIsBlank(row, now));
}

/**
 * Keeps at least ten empty placeholders after the last row containing user data.
 * One hundred is the data-row limit; trailing placeholders are not batch data.
 */
export function ensureSpreadsheetSpareRows(model: SpreadsheetRowModel): SpreadsheetRowModel {
  const dataRows = selectNonEmptySpreadsheetRows(model);
  if (dataRows.length > SPREADSHEET_MAX_DATA_ROWS) throw new SpreadsheetDataRowLimitError();

  let lastDataIndex = -1;
  for (let index = model.rows.length - 1; index >= 0; index -= 1) {
    const row = model.rows[index];
    if (row && !spreadsheetRowIsBlank(row)) {
      lastDataIndex = index;
      break;
    }
  }

  const requiredLength = Math.max(
    SPREADSHEET_INITIAL_ROW_COUNT,
    lastDataIndex + 1 + SPREADSHEET_SPARE_ROW_COUNT,
  );

  return appendBlankRows(model, requiredLength - model.rows.length);
}

/**
 * Bao dam model co it nhat `minimumRowCount` dong hien thi.
 * Can cho paste bat dau gan cuoi bang: phai co dong trong de ghi truoc khi ap ma tran.
 * Day chi la placeholder client-side, khong tinh vao gioi han 100 dong du lieu.
 */
export function ensureSpreadsheetRowCount(
  model: SpreadsheetRowModel,
  minimumRowCount: number,
  laborTypeDefault = "",
): SpreadsheetRowModel {
  if (!Number.isFinite(minimumRowCount) || minimumRowCount <= model.rows.length) return model;
  return appendBlankRows(
    model, Math.ceil(minimumRowCount) - model.rows.length, laborTypeDefault,
  );
}

export function createSpreadsheetRowModel(): SpreadsheetRowModel {
  return appendBlankRows({ rows: [], nextClientRowSequence: 1 }, SPREADSHEET_INITIAL_ROW_COUNT);
}

/**
 * P3-W07C-R1: moi edit/provider cell vao row tu dong activate lazy defaults
 * truoc khi apply patch. Activation chen ngay hom nay (Asia/Ho_Chi_Minh)
 * vao o `first_work_date` neu o EMPTY. Patch cua user / paste / import
 * luon thang (apply sau cung).
 *
 * P3-W07C-R3: chi con lazy default cho `first_work_date`; khong con
 * lazy default cho `national_id_issued_place` (server migration #46 ghi).
 *
 * - Idempotent: row da activate thi activation khong doi gia tri.
 * - Khong overwrite gia tri first_work_date do user hoac file cung cap
 *   (chi chen khi cell EMPTY truoc patch).
 * - Tra ve model khong doi neu row khong ton tai.
 */
export function updateSpreadsheetRowCells(
  model: SpreadsheetRowModel,
  clientRowId: string,
  patch: Readonly<Record<string, string>>,
  now: Date = new Date(),
  laborTypeDefault = "",
): SpreadsheetRowModel {
  assertWritablePatch(patch);

  let found = false;
  let needsActivation = false;
  for (const row of model.rows) {
    if (row.clientRowId !== clientRowId) continue;
    found = true;
    if (!row.lazyDefaultsApplied) {
      needsActivation = true;
    }
    break;
  }
  if (!found) return model;

  const baseModel = needsActivation
    ? activateSpreadsheetRowLazyDefaults(model, clientRowId, now, laborTypeDefault)
    : model;
  const rows = baseModel.rows.map((row) => {
    if (row.clientRowId !== clientRowId) return row;
    return {
      ...row,
      cells: { ...row.cells, ...patch },
      ...(Object.hasOwn(patch, "collaborator_id")
        ? { collaboratorId: patch.collaborator_id }
        : {}),
      defaultLaborType: Object.hasOwn(patch, "labor_type") ? "" : row.defaultLaborType,
      lazyDefaultsApplied: true,
    };
  });

  return ensureSpreadsheetSpareRows({ ...baseModel, rows });
}

export function updateSpreadsheetRowProviderType(
  model: SpreadsheetRowModel,
  clientRowId: string,
  providerType: SpreadsheetStagedRow["providerType"],
  now: Date = new Date(),
  laborTypeDefault = "",
): SpreadsheetRowModel {
  // P3-W07C-R1: chon HRP/Vendor cung la tuong tac => activate lazy defaults truoc.
  let needsActivation = false;
  let found = false;
  for (const row of model.rows) {
    if (row.clientRowId !== clientRowId) continue;
    found = true;
    if (!row.lazyDefaultsApplied) {
      needsActivation = true;
    }
    break;
  }
  if (!found) return model;
  const baseModel = needsActivation
    ? activateSpreadsheetRowLazyDefaults(model, clientRowId, now, laborTypeDefault)
    : model;

  const rows = baseModel.rows.map((row) => {
    if (row.clientRowId !== clientRowId || row.providerType === providerType) return row;
    const prevRecruiterScope = row.providerType === "ctv" ? "hrp" : row.providerType;
    const nextRecruiterScope = providerType === "ctv" ? "hrp" : providerType;
    const keepRecruiter = prevRecruiterScope !== "" && prevRecruiterScope === nextRecruiterScope;
    const nextCollaboratorId = providerType === "ctv" ? (row.collaboratorId ?? "") : "";
    const nextCells: Record<string, string> = {
      ...row.cells,
      recruiter_id: keepRecruiter ? (row.cells.recruiter_id ?? "") : "",
    };
    if (providerType !== "ctv" && Object.hasOwn(nextCells, "collaborator_id")) {
      nextCells.collaborator_id = "";
    }
    return {
      ...row,
      providerType,
      collaboratorId: nextCollaboratorId,
      cells: nextCells,
      // P3-W07C-R1: danh dau activated de row khong reset ve placeholder.
      lazyDefaultsApplied: true,
    };
  });
  return rows.every((row, index) => row === baseModel.rows[index])
    ? baseModel
    : { ...baseModel, rows };
}

export function updateSpreadsheetRowCollaboratorId(
  model: SpreadsheetRowModel,
  clientRowId: string,
  collaboratorId: string,
  now: Date = new Date(),
  laborTypeDefault = "",
): SpreadsheetRowModel {
  let needsActivation = false;
  let found = false;
  for (const row of model.rows) {
    if (row.clientRowId !== clientRowId) continue;
    found = true;
    if (!row.lazyDefaultsApplied) needsActivation = true;
    break;
  }
  if (!found) return model;
  const baseModel = needsActivation
    ? activateSpreadsheetRowLazyDefaults(model, clientRowId, now, laborTypeDefault)
    : model;

  const rows = baseModel.rows.map((row) => {
    if (row.clientRowId !== clientRowId || (row.collaboratorId ?? "") === collaboratorId) return row;
    return {
      ...row,
      collaboratorId,
      cells: { ...row.cells, collaborator_id: collaboratorId },
      lazyDefaultsApplied: true,
    };
  });
  return rows.every((row, index) => row === baseModel.rows[index])
    ? baseModel
    : ensureSpreadsheetSpareRows({ ...baseModel, rows });
}

export function clearSpreadsheetRow(
  model: SpreadsheetRowModel,
  clientRowId: string,
): SpreadsheetRowModel {
  let found = false;
  const rows = model.rows.map((row) => {
    if (row.clientRowId !== clientRowId) return row;
    found = true;
    // P3-W07C: clear row RONG + chua kich hoat.
    return { ...row, cells: defaultCells(), collaboratorId: "", lazyDefaultsApplied: false };
  });
  if (!found) return model;

  return ensureSpreadsheetSpareRows({ ...model, rows });
}

export function deleteSpreadsheetRow(
  model: SpreadsheetRowModel,
  clientRowId: string,
): SpreadsheetRowModel {
  const rows = model.rows.filter((row) => row.clientRowId !== clientRowId);
  if (rows.length === model.rows.length) return model;
  return ensureSpreadsheetSpareRows({ ...model, rows });
}

export function duplicateSpreadsheetRow(
  model: SpreadsheetRowModel,
  clientRowId: string,
): SpreadsheetRowModel {
  const sourceIndex = model.rows.findIndex((row) => row.clientRowId === clientRowId);
  if (sourceIndex < 0) return model;

  const source = model.rows[sourceIndex];
  if (!source) return model;
  if (!spreadsheetRowIsBlank(source)
    && selectNonEmptySpreadsheetRows(model).length >= SPREADSHEET_MAX_DATA_ROWS) {
    throw new SpreadsheetDataRowLimitError();
  }

  const duplicate = {
    clientRowId: `${CLIENT_ROW_ID_PREFIX}-${model.nextClientRowSequence}`,
    // P3-W07C: duplicate copy nguyen cells nguon; neu nguon chua kich hoat,
    // duplicate cung chua kich hoat. Neu nguon da kich hoat hoac co gia
    // tri user, duplicate giu nguyen.
    cells: { ...source.cells },
    defaultLaborType: source.defaultLaborType,
    lazyDefaultsApplied: source.lazyDefaultsApplied,
    providerType: source.providerType,
    collaboratorId: source.collaboratorId ?? "",
  };
  const rows = [...model.rows];
  rows.splice(sourceIndex + 1, 0, duplicate);

  return ensureSpreadsheetSpareRows({
    rows,
    nextClientRowSequence: model.nextClientRowSequence + 1,
  });
}

/**
 * P3-W07C: import / paste batch rows vao model.
 * - Khong ghi de row nguoi dung da co gia tri; moi row import co
 *   `lazyDefaultsApplied: true` (vi nguon ngoai da cung cap gia tri).
 * - Row import chi dem vao batch neu khong phai blank (theo
 *   `spreadsheetRowIsBlank`).
 * - Khong them row moi neu so data row vuot qua `SPREADSHEET_MAX_DATA_ROWS`.
 */
export function importSpreadsheetRows(
  model: SpreadsheetRowModel,
  imported: ReadonlyArray<Readonly<Record<string, string>>>,
): SpreadsheetRowModel {
  if (imported.length === 0) return model;

  const currentDataRows = selectNonEmptySpreadsheetRows(model).length;
  let allowed = SPREADSHEET_MAX_DATA_ROWS - currentDataRows;
  if (allowed <= 0) return model;

  const newRows: SpreadsheetStagedRow[] = [];
  for (const cells of imported) {
    if (allowed <= 0) break;
    const nextCells = importedCells(cells);
    const candidate: SpreadsheetStagedRow = {
      clientRowId: `${CLIENT_ROW_ID_PREFIX}-${model.nextClientRowSequence + newRows.length}`,
      cells: nextCells,
      defaultLaborType: "",
      lazyDefaultsApplied: true,
      providerType: "",
      collaboratorId: "",
    };
    if (spreadsheetRowIsBlank(candidate)) continue;
    newRows.push(candidate);
    allowed -= 1;
  }

  if (newRows.length === 0) return model;
  return ensureSpreadsheetSpareRows({
    rows: [...model.rows, ...newRows],
    nextClientRowSequence: model.nextClientRowSequence + newRows.length,
  });
}