import {
  workerProfileField,
  type WorkerProfileFieldSpec,
} from "./worker-profile-import-contract.ts";

export type DirectEntryGridColumnGroup =
  | "entry"
  | "worker"
  | "employment"
  | "payment"
  | "derived"
  | "action";

export type DirectEntryGridPasteMode = "write" | "validate-only" | "ignore";

export type DirectEntryGridEditor =
  | "text"
  | "date"
  | "select"
  | "catalog"
  | "readonly"
  | "action";

export type DirectEntryGridColumn = {
  key: string;
  label: string;
  group: DirectEntryGridColumnGroup;
  editable: boolean;
  pasteMode: DirectEntryGridPasteMode;
  required: boolean;
  width: number;
  visibleByDefault: boolean;
  editor: DirectEntryGridEditor;
  /** Contract source of truth; null only for UI-only columns. */
  contractField: WorkerProfileFieldSpec | null;
};

/**
 * P1.7-H05 - Bo cot mac dinh cho Direct Entry Production UI.
 *
 * Thu tu 18 cot mac dinh gom them trạng thái làm việc. STT chi la hien thi, Mã NLĐ
 * khong xuat hien o day va them khong cho nhap; việc cấp mã định danh vẫn do server
 * (migration #39) đảm nhiệm và hiện ở action rail/drawer. Tuổi suy ra từ DOB; lifecycle
 * Ngày nghỉ/lý do nghỉ vẫn là dữ liệu lịch sử nội bộ; trạng thái làm việc được
 * hiển thị để người nhập có thể chọn khác mặc định Đang làm việc.
 *
 * P3-W07C-R3: thứ tự mặc định đã đảo để ba cột ngay sau `Dự án` là
 * `HRP/Vendor → Người tuyển / Vendor → Loại hình LĐ` (theo brief). Cột
 * `national_id_issued_place` đã được bỏ khỏi mặc định vì giá trị do
 * server-authoritative migration #46 ghi ("Bộ Công An") và cũng không
 * còn xuất hiện trong template Excel mới. Trường này vẫn còn trong
 * `DIRECT_ENTRY_GRID_COLUMNS` để xử lý template/legacy paste; client
 * không ghi đè được default ở RPC boundary.
 *
 * P3-W07E-R1: trên grid nhập liệu, `Số điện thoại` và `CMT/CCCD` nằm ngay
 * sau `Họ và tên` để người dùng đối chiếu định danh nhanh hơn. Thay đổi này
 * chỉ là thứ tự hiển thị; key payload, registry vật lý và template Excel giữ nguyên.
 *
 * Registry tong `DIRECT_ENTRY_GRID_COLUMNS` van giu day du cac truong de ho tro
 * drawer/projection, validation va mo rong sau nay; chỉ danh sach default visible bi
 * gioi han theo yeu cau H05 + R3.
 */
export const DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS: readonly string[] = Object.freeze([
  "row_index",
  "project_id",
  "provider_type",
  "recruiter_id",
  "collaborator_id",
  "labor_type",
  "first_work_date",
  "initial_status",
  "display_name",
  "phone",
  "national_id",
  "gender",
  "date_of_birth",
  "national_id_issued_at",
  "address",
  "account_number",
  "bank_name",
  "account_holder_name",
  "general_note",
]);

/**
 * Action rail dat NGOAI grid: chi gom trang thai luu va thao tac tren dong.
 * Cot `cccd_documents` da duoc loai khoi rail theo yeu cau H05 — hồ sơ CCCD mo qua
 * drawer/dialog rieng cua row (`DirectEntryCccdManager` / `DirectEntryDocumentEditor`)
 * va khong con la data header cua bang.
 */
export const DIRECT_ENTRY_ACTION_RAIL_COLUMN_KEYS: readonly string[] = Object.freeze([
  "save_status",
  "row_actions",
]);

export const DIRECT_ENTRY_GENDER_OPTIONS: readonly string[] = Object.freeze(["Nam", "Nữ"]);
export const DIRECT_ENTRY_PROVIDER_OPTIONS: readonly string[] = Object.freeze(["HRP", "Vendor", "CTV"]);

export type GridRecruiterOption = {
  id: string;
  label: string;
  provider_type: "hrp" | "vendor";
  /** P3-W07A: business identifier (e.g. vinht.td); null for Vendor rows. */
  personnel_code: string | null;
  /** P3-W07A: vendor id for Vendor rows; null for HRP rows. */
  vendor_id: string | null;
};

/**
 * P3-W07A-R1: locked UI label mapping for the canonical `personnel_position`
 * enum. W07A is data-only and does not add a role token; the helper just
 * renders the catalog position in Vietnamese. A `TEAM_LEADER` row is a
 * catalog/membership fact, not an authenticated app user. Account,
 * capability and team dashboard creation live in P3-W07B.
 */
export const PERSONNEL_POSITION_UI_LABELS: Readonly<Record<"STAFF" | "TEAM_LEADER", string>> =
  Object.freeze({
    STAFF: "Nhân viên",
    TEAM_LEADER: "Trưởng nhóm",
  });

export function personnelPositionUiLabel(position: "STAFF" | "TEAM_LEADER" | null): string {
  if (position === null) return "—";
  return PERSONNEL_POSITION_UI_LABELS[position];
}

export function recruitersForProvider(
  recruiters: readonly GridRecruiterOption[],
  providerType: "hrp" | "vendor" | "ctv" | "",
): readonly GridRecruiterOption[] {
  if (providerType === "") return [];
  const effectiveProvider = providerType === "ctv" ? "hrp" : providerType;
  return recruiters.filter((recruiter) => recruiter.provider_type === effectiveProvider);
}

type FieldColumnOptions = Pick<DirectEntryGridColumn, "group" | "pasteMode" | "width" | "editor"> &
  Partial<Pick<DirectEntryGridColumn, "editable" | "visibleByDefault" | "label">>;

function fieldColumn(key: string, options: FieldColumnOptions): DirectEntryGridColumn {
  const contractField = workerProfileField(key);
  if (!contractField) throw new Error(`Unknown worker-profile field: ${key}`);
  return Object.freeze({
    key,
    label: options.label ?? contractField.canonicalHeader,
    group: options.group,
    editable: options.editable ?? options.pasteMode === "write",
    pasteMode: options.pasteMode,
    required: contractField.requirement === "required",
    width: options.width,
    visibleByDefault: options.visibleByDefault ?? true,
    editor: options.editor,
    contractField,
  });
}

function uiColumn(input: Omit<DirectEntryGridColumn, "contractField">): DirectEntryGridColumn {
  return Object.freeze({ ...input, contractField: null });
}

/**
 * Physical order is the clipboard coordinate contract. Keep this list ordered and append/reorder only
 * through an explicit P1.7 contract change.
 */
export const DIRECT_ENTRY_GRID_COLUMNS: readonly DirectEntryGridColumn[] = Object.freeze([
  fieldColumn("row_index", { group: "derived", pasteMode: "validate-only", width: 72,
    editor: "readonly", editable: false }),
  fieldColumn("project_id", { group: "entry", pasteMode: "write", width: 210,
    editor: "catalog" }),
  fieldColumn("first_work_date", { group: "entry", pasteMode: "write", width: 178,
    editor: "date" }),
  fieldColumn("employee_code", { group: "entry", pasteMode: "validate-only", width: 150,
    editor: "readonly", editable: false }),
  fieldColumn("display_name", { group: "worker", pasteMode: "write", width: 220,
    editor: "text" }),
  fieldColumn("gender", { group: "worker", pasteMode: "write", width: 120,
    editor: "select" }),
  fieldColumn("date_of_birth", { group: "worker", pasteMode: "write", width: 130,
    // P3-W07C-R1: doi label UI tu "DOB" (contract canonicalHeader) sang "Ngày sinh"
    // (pho bien o VN). Payload key van la `date_of_birth`, chi thay doi header
    // hien thi tren grid, quick editor va mobile card.
    // P3-W07C-R2: ordinary text through cell/payload/JSONB/read; no date parse,
    // ISO conversion, calendar validation or chronology checks.
    editor: "text", label: "Ngày sinh" }),
  fieldColumn("age_years", { group: "derived", pasteMode: "validate-only", width: 88,
    editor: "readonly", editable: false }),
  fieldColumn("national_id", { group: "worker", pasteMode: "write", width: 150,
    editor: "text" }),
  fieldColumn("national_id_issued_at", { group: "worker", pasteMode: "write", width: 130,
    // P3-W07C-R2: ordinary text through cell/payload/JSONB/read; no date parsing.
    editor: "text" }),
  fieldColumn("national_id_issued_place", { group: "worker", pasteMode: "write", width: 180,
    // P3-W07C-R3: cột này không còn hiện trong mặc định nữa (DB/RPC luôn
    // ghi "Bộ Công An"). Trường vẫn có trong registry để legacy template
    // vẫn paste được; client gửi giá trị nào cũng bị RPC ghi đè bằng
    // server default.
    editor: "text", visibleByDefault: false }),
  fieldColumn("address", { group: "worker", pasteMode: "write", width: 260,
    editor: "text", label: "Địa chỉ" }),
  fieldColumn("phone", { group: "worker", pasteMode: "write", width: 150,
    editor: "text", label: "Số điện thoại" }),
  fieldColumn("provider_hint", { group: "derived", pasteMode: "validate-only", width: 150,
    editor: "readonly", editable: false, label: "HRP/Vendor" }),
  uiColumn({ key: "provider_type", label: "Nguồn", group: "entry", editable: true,
    pasteMode: "ignore", required: false, width: 140, visibleByDefault: true, editor: "select" }),
  fieldColumn("recruiter_id", { group: "entry", pasteMode: "write", width: 210,
    editor: "catalog", label: "Người tuyển / Vendor" }),
  uiColumn({ key: "collaborator_id", label: "CTV", group: "entry", editable: true,
    pasteMode: "ignore", required: false, width: 200, visibleByDefault: true, editor: "catalog" }),
  fieldColumn("team_hint", { group: "derived", pasteMode: "validate-only", width: 160,
    editor: "readonly", editable: false }),
  fieldColumn("labor_type", { group: "entry", pasteMode: "write", width: 140,
    editor: "select" }),
  fieldColumn("initial_status", { group: "employment", pasteMode: "write", width: 205,
    editor: "select", label: "Trạng thái làm việc" }),
  fieldColumn("leave_date", { group: "employment", pasteMode: "write", width: 150,
    editor: "date" }),
  fieldColumn("leave_reason_text", { group: "employment", pasteMode: "write", width: 240,
    editor: "text" }),
  fieldColumn("general_note", { group: "entry", pasteMode: "write", width: 240,
    editor: "text" }),
  fieldColumn("account_number", { group: "payment", pasteMode: "write", width: 170,
    editor: "text" }),
  fieldColumn("bank_name", { group: "payment", pasteMode: "write", width: 200,
    editor: "text" }),
  fieldColumn("account_holder_name", { group: "payment", pasteMode: "write", width: 200,
    editor: "text" }),
  uiColumn({ key: "cccd_documents", label: "Hồ sơ CCCD", group: "action", editable: false,
    pasteMode: "ignore", required: false, width: 150, visibleByDefault: true, editor: "action" }),
  uiColumn({ key: "save_status", label: "Trạng thái", group: "derived", editable: false,
    pasteMode: "ignore", required: false, width: 140, visibleByDefault: true,
    editor: "readonly" }),
  uiColumn({ key: "row_actions", label: "Thao tác", group: "action", editable: false,
    pasteMode: "ignore", required: false, width: 150, visibleByDefault: true, editor: "action" }),
]);

const COLUMN_BY_KEY = new Map(DIRECT_ENTRY_GRID_COLUMNS.map((column) => [column.key, column]));

export function directEntryGridColumn(key: string): DirectEntryGridColumn | undefined {
  return COLUMN_BY_KEY.get(key);
}

export function directEntryGridColumnIndex(key: string): number {
  return DIRECT_ENTRY_GRID_COLUMNS.findIndex((column) => column.key === key);
}
