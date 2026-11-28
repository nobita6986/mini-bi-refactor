"use client";

/**
 * P1.7-W02 - Spreadsheet-lite grid cho Direct Entry.
 *
 * Component nay CHI lo phan trinh bay + tuong tac luoi:
 *   - render bo cot nhap lieu mac dinh va action rail bang react-data-grid dang co;
 *   - giu o neo (anchor) cua lan paste/copy/keyboard;
 *   - bat su kien copy/paste do nguoi dung chu dong tao va goi pure mapper cua W01;
 *   - thao tac dong (lam trong / xoa / nhan ban / ho so CCCD).
 *
 * Component KHONG goi API, KHONG doc/ghi localStorage, KHONG tu parse nghiep vu,
 * KHONG dung Clipboard permission API va KHONG giu state cua row model. Moi thay doi
 * du lieu duoc bao nguoc len orchestrator qua callback, nen paste chi doi React state
 * o tang cha.
 */
import {
  memo, useCallback, useEffect, useMemo, useRef, useState,
  type ClipboardEvent, type KeyboardEvent, type ReactNode,
} from "react";
import {
  DataGrid,
  type CellCopyArgs,
  type CellKeyDownArgs,
  type CellPasteArgs,
  type Column,
  type RenderCellProps,
  type RenderEditCellProps,
} from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { createPortal } from "react-dom";

import { DdmmDateInput } from "./direct-entry-ddmm-date-input";

import {
  DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS,
  DIRECT_ENTRY_GENDER_OPTIONS,
  recruitersForProvider,
  directEntryGridColumn,
  type DirectEntryGridColumn,
} from "@/lib/direct-entry/direct-entry-grid-columns";
import {
  activeLaborTypeLabel,
  sortedActiveLaborTypes,
} from "@/lib/direct-entry/labor-type-catalog-ui";
import type { DraftCatalogLaborType } from "@/lib/direct-entry/write-repository";
import { workStatusUiLabel } from "@/lib/direct-entry/display-labels";
import {
  formatDateToDDMM,
  formatFreeDateText,
} from "@/lib/direct-entry/direct-entry-date-format";
import {
  moveTypeaheadIndex,
  typeaheadKeyAction,
} from "@/lib/direct-entry/typeahead";
import {
  SEARCH_POPUP_MAX_HEIGHT,
  computeSearchPopupPosition,
  findCatalogOptionByStoredValue,
  filterCatalogSearchOptions,
  type CatalogSearchOption,
  type SearchPopupLayout,
} from "@/lib/direct-entry/catalog-search";
import {
  mapClipboardFromAnchor,
  parseClipboardTsv,
  serializeClipboardTsv,
  type ClipboardMapResult,
} from "@/lib/direct-entry/direct-entry-grid-clipboard";
import {
  commitTextCellCompositionEnd,
  commitTextCellValue,
} from "@/components/direct-entry/text-cell-state";
import type { SpreadsheetValidation } from "@/lib/direct-entry/direct-entry-grid-validation";

import styles from "./direct-entry-spreadsheet-grid.module.css";

export const SPREADSHEET_GRID_ARIA_LABEL = "Bảng nhập liệu Direct Entry";

/**
 * P3-W07C-R1 zoom: cac muc zoom co dinh cho khu vuc bang nhap lieu Direct
 * Entry. Mac dinh 100%. KHONG persistence; chi dieu khien in-memory.
 * Khong dung CSS `transform: scale()` hay thuoc tinh `zoom`.
 */
export const DIRECT_ENTRY_GRID_ZOOM_LEVELS: readonly number[] = Object.freeze([
  80, 90, 100, 110, 120,
]);
export const DIRECT_ENTRY_GRID_DEFAULT_ZOOM = 100;
export const DIRECT_ENTRY_GRID_BASE_ROW_HEIGHT = 40;
export const DIRECT_ENTRY_GRID_BASE_HEADER_ROW_HEIGHT = 38;
export const DIRECT_ENTRY_GRID_BASE_FONT_PX = 13;
export const DIRECT_ENTRY_GRID_BASE_CELL_PADDING_Y_PX = 2;
export const DIRECT_ENTRY_GRID_BASE_CELL_PADDING_X_PX = 4;

export type SpreadsheetGridRow = {
  clientRowId: string;
  /** true khi dong da ton tai tren server, khong phai placeholder. */
  persisted: boolean;
  /** true chi voi row nam trong staged batch W02. */
  clientStaged: boolean;
  /** true khi submission state khoa dong (REVIEW/SUBMITTED). */
  locked: boolean;
  providerType: "hrp" | "vendor" | "ctv" | "";
  cells: Readonly<Record<string, string>>;
  catalogOptions?: SpreadsheetCatalogOptions;
  /** Sanitized display-only labels; these values are never copied or written. */
  displayValues?: Readonly<Record<string, string>>;
  /** Field key duoc phep sua truc tiep; rong nghia la read-only. */
  editableFields: readonly string[];
  cccdStatus: string;
  canManageCccd: boolean;
  employeeCode: string;
  displayName: string;
  projectLabel: string;
  recruiterLabel: string;
  collaboratorLabel?: string;
  saveStatus: string;
};

export type SpreadsheetCatalogOptions = {
  projects: readonly { id: string; label: string; keywords?: string }[];
  laborTypes: readonly DraftCatalogLaborType[];
  recruiters: readonly {
    id: string;
    label: string;
    provider_type: "hrp" | "vendor";
    /** P3-W07A: business identifier (e.g. vinht.td); null for Vendor rows. */
    personnel_code: string | null;
    /** P3-W07A: vendor id for Vendor rows; null for HRP rows. */
    vendor_id: string | null;
  }[];
  collaborators?: readonly {
    id: string;
    label: string;
    active?: boolean;
  }[];
};

export type SpreadsheetPasteRejection =
  | "CLIPBOARD_ROW_OVERFLOW"
  | "CLIPBOARD_COLUMN_OVERFLOW"
  | "CLIPBOARD_ANCHOR_INVALID"
  | "CLIPBOARD_EMPTY"
  | "CLIPBOARD_PROTECTED_CELL"
  | "CLIPBOARD_TARGET_INVALID";

export type SpreadsheetPasteRequest = {
  mapping: Extract<ClipboardMapResult, { ok: true }>;
  rowCount: number;
  columnCount: number;
};

export type DirectEntrySpreadsheetGridProps = {
  rows: readonly SpreadsheetGridRow[];
  validation: SpreadsheetValidation;
  catalogOptions?: SpreadsheetCatalogOptions;
  onCellsChange(clientRowId: string, patch: Readonly<Record<string, string>>): void;
  onProviderTypeChange(clientRowId: string, providerType: "hrp" | "vendor" | "ctv" | ""): void;
  onPasteApplied(request: SpreadsheetPasteRequest): void;
  onPasteRejected(reason: SpreadsheetPasteRejection): void;
  onDeleteRow(clientRowId: string): void;
  notice: string;
  canUndo: boolean;
  onUndo(): void;
  saveMessage?: string;
  /**
   * P3-W07C: tone tuong minh cho saveMessage. `error` => chu do, role="alert".
   * `success` hoac `info` => khong do, role="status". Khong suy luan bang
   * cach do noi dung tieng Viet.
   */
  saveTone?: "error" | "success" | "info" | "";
  /**
   * P1.7-H06: clientRowId dang duoc chon de contextual action bar thao tac.
   * Chi truyen mot ID duy nhat moi luc; neu `null` thi khong co dong nao duoc chon.
   * Select chi thay doi focus/highlight, khong mutate data cell.
   */
  selectedClientRowId?: string | null;
  onSelectedClientRowChange(clientRowId: string | null): void;
  /**
   * P3-W07C-R1 zoom: ty le zoom (percent) chi tac dong len khu vuc bang
   * nhap lieu. 80 -> thu nho (gom cot), 120 -> phong to (de doc). Phai
   * nam trong `DIRECT_ENTRY_GRID_ZOOM_LEVELS`. Mac dinh 100.
   */
  zoomLevel?: number;
  onZoomChange?(level: number): void;
  toolbarActions?: ReactNode;
};

const PROVIDER_OPTIONS = ["hrp", "vendor", "ctv"] as const;

export function spreadsheetSelectOptions(
  columnKey: string,
  catalogs: SpreadsheetCatalogOptions | undefined,
  providerType: "hrp" | "vendor" | "ctv" | "" = "",
): readonly string[] | null {
  // The row model uses an empty string for an unselected cell. Native
  // <select> elements must therefore also have a matching empty option.
  // Without it the browser visually selects the first business option while
  // the row still stores ""; choosing that visible option emits no change and
  // the value disappears when the editor closes.
  if (columnKey === "gender") return ["", ...DIRECT_ENTRY_GENDER_OPTIONS];
  if (columnKey === "initial_status") return ["", "PENDING"];
  if (columnKey === "labor_type") {
    return ["", ...sortedActiveLaborTypes(catalogs?.laborTypes)
      .map((option) => option.labor_type_key)];
  }
  if (columnKey === "provider_type") return ["", ...PROVIDER_OPTIONS];
  if (columnKey === "project_id") {
    // Stable project IDs are stored; the searchable editor renders separate labels.
    return ["", ...(catalogs?.projects ?? []).map((option) => option.id)];
  }
  if (columnKey === "recruiter_id") {
    return recruitersForProvider(catalogs?.recruiters ?? [], providerType).map((option) => option.id);
  }
  if (columnKey === "collaborator_id") {
    return providerType === "ctv"
      ? (catalogs?.collaborators ?? []).filter((option) => option.active !== false).map((option) => option.id)
      : [];
  }
  return null;
}

export function spreadsheetColumnIndex(columnKey: string): number {
  return DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS.indexOf(columnKey);
}

function SelectCellEditor(
  props: RenderEditCellProps<SpreadsheetGridRow> & {
    columnKey: string;
    catalogs: SpreadsheetCatalogOptions | undefined;
  },
) {
  const rowCatalogs = props.row.catalogOptions ?? props.catalogs;
  const options = spreadsheetSelectOptions(
    props.columnKey, rowCatalogs, props.row.providerType,
  ) ?? [];
  const recruiter = rowCatalogs?.recruiters.find((option) =>
    option.id === props.row.cells.recruiter_id);
  const value = props.columnKey === "provider_type"
    ? props.row.providerType
    : props.columnKey === "recruiter_id"
      ? recruiter?.id ?? ""
      : props.row.cells[props.columnKey] ?? "";

  // P3-W07A dropdown contract:
  //   1. Selecting an option commits via `onRowChange(row, true)`.
  //   2. Re-selecting the SAME option must still commit (no clobbering when
  //      the value is unchanged).
  //   3. Blur (click-outside) commits the current `value` even if the user
  //      never changed it. This protects the case where the dropdown is
  //      opened and dismissed without selection.
  //   4. The contract applies uniformly to provider_type, recruiter_id,
  //      project_id, gender, labor_type and every other dropdown column.
  const commit = (nextValue: string) => {
    props.onRowChange(
      { ...props.row, cells: { ...props.row.cells, [props.columnKey]: nextValue } },
      true,
    );
  };
  const commitBlur = () => props.onClose(true, false);

  if (props.columnKey === "provider_type") {
    return (
      <select aria-label="Nguồn" autoFocus value={value}
        onChange={(event) => {
          const next = event.currentTarget.value;
          const providerType =
            next === "hrp" || next === "vendor" || next === "ctv" ? next : "";
          props.onRowChange(
            providerType === "ctv"
              ? { ...props.row, providerType }
              : {
                  ...props.row,
                  providerType,
                  cells: { ...props.row.cells, collaborator_id: "" },
                },
            true,
          );
        }}
        onBlur={commitBlur}>
        <option value="">—</option>
        <option value="hrp">HRP (trực tiếp)</option>
        <option value="vendor">Vendor</option>
        <option value="ctv">CTV</option>
      </select>
    );
  }
  if (props.columnKey === "recruiter_id") {
    const recruiters = recruitersForProvider(rowCatalogs?.recruiters ?? [], props.row.providerType);
    return (
      <select aria-label="Người tuyển / Vendor" autoFocus value={value}
        disabled={props.row.providerType === ""}
        onChange={(event) => commit(event.currentTarget.value)}
        onBlur={commitBlur}>
        <option value="">—</option>
        {recruiters.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    );
  }
  if (props.columnKey === "labor_type") {
    const selectedIsInactive = value !== "" && !options.includes(value);
    return (
      <select aria-label="Loại hình LĐ" autoFocus value={value}
        onChange={(event) => commit(event.currentTarget.value)}
        onBlur={commitBlur}>
        <option value="">—</option>
        {selectedIsInactive && <option value={value} disabled>
          {props.row.displayValues?.labor_type || "Loại hình không còn hoạt động"}
        </option>}
        {sortedActiveLaborTypes(rowCatalogs?.laborTypes).map((option) =>
          <option key={option.labor_type_key} value={option.labor_type_key}>
            {option.display_name}
          </option>)}
      </select>
    );
  }
  if (props.columnKey === "project_id") {
    // P1.7-H07: dropdown Dự án phai mo va co options khi `first_work_date`
    // chua co (mac dinh dung fallback catalog da set o `row.catalogOptions`).
    // Khi user nhap ngay sau do, live component se re-resolve catalog qua
    // `onCellsChange` => `ensureCatalog` va truyen option moi.
    return (
      <select aria-label="Dự án" autoFocus value={value}
        onChange={(event) => commit(event.currentTarget.value)}
        onBlur={commitBlur}>
        {options.map((option) =>
          <option key={option} value={option}>{option === "" ? "—" : option}</option>)}
      </select>
    );
  }
  return (
    <select
      aria-label={props.columnKey}
      autoFocus
      value={value}
      onChange={(event) => commit(event.currentTarget.value)}
      onBlur={commitBlur}
    >
      {options.map((option) => <option key={option} value={option}>
        {props.columnKey === "initial_status"
          ? option === "" ? "Đang làm việc (mặc định)"
            : workStatusUiLabel(option)
          : option === "" ? "—" : option}
      </option>)}
      {value !== "" && !options.includes(value) && (
        // PRE-W2-HF-UI-LABELS: du lieu cu ngoai danh muc (vd gioi tinh Khác) van hien
        // nhan cua no; chi cho CHON cac option trong danh muc.
        <option value={value} disabled>{props.columnKey === "initial_status"
          ? workStatusUiLabel(value === "UNCONFIRMED" ? "PENDING" : value) : value}</option>
      )}
    </select>
  );
}

/**
 * P3-W07C-R4: dropdown co TIM KIEM cho Dự án / Người tuyển.
 *
 * Giu nguyen commit contract cua `SelectCellEditor`:
 *  - chi commit khi nguoi dung that su chon (click hoac Enter) => khong bao gio
 *    tu dong chon option dau tien;
 *  - blur/Tab khong lam mat gia tri da luu (onClose(true,false) giu nguyen row);
 *  - Escape dong ma khong doi gia tri.
 */
function SearchableCatalogCellEditor(
  props: RenderEditCellProps<SpreadsheetGridRow> & {
    columnKey: "project_id" | "recruiter_id" | "collaborator_id";
    catalogs: SpreadsheetCatalogOptions | undefined;
  },
) {
  const rowCatalogs = props.row.catalogOptions ?? props.catalogs;
  const storedValue = props.row.cells[props.columnKey] ?? "";

  const options = useMemo<readonly CatalogSearchOption[]>(() => {
    if (props.columnKey === "project_id") {
      return (rowCatalogs?.projects ?? []).map((project) => ({
        id: project.id, label: project.label, keywords: project.keywords,
      }));
    }
    if (props.columnKey === "collaborator_id") {
      if (props.row.providerType !== "ctv") return [];
      return (rowCatalogs?.collaborators ?? [])
        .filter((collaborator) => collaborator.active !== false)
        .map((collaborator) => ({
          id: collaborator.id,
          label: collaborator.label,
          keywords: collaborator.id,
        }));
    }
    return recruitersForProvider(rowCatalogs?.recruiters ?? [], props.row.providerType)
      .map((recruiter) => ({
        id: recruiter.id,
        label: recruiter.label,
        keywords: [recruiter.personnel_code, recruiter.vendor_id].filter(Boolean).join(" "),
      }));
  }, [props.columnKey, props.row.providerType, rowCatalogs]);

  /** Ca hai cot deu luu stable catalog ID; label/keywords chi de hien thi/nhan dien row cu. */
  const selected = findCatalogOptionByStoredValue(options, storedValue);

  const [query, setQuery] = useState(selected?.label ?? "");
  const [activeIndex, setActiveIndex] = useState(-1);
  const composing = useRef(false);
  const queryInput = useRef<HTMLInputElement | null>(null);

  /**
   * P3-W07C-R4-R1: query khoi tao bang NHAN dang chon. Neu khong chon het text khi
   * focus thi ky tu nguoi dung go se noi vao nhan cu ("Compal" + "C" = "CompalC")
   * nen loc ra rong. Chon het text ngay khi mo o de ky tu dau tien THAY THE nhan cu.
   *
   * Khi query van dung bang nhan goc (nguoi dung chua go gi) thi hien TOAN BO option
   * de con xem va chon lai, thay vi thu ve mot muc.
   */
  const pristineQuery = selected?.label ?? "";
  const browsing = query === pristineQuery;
  const visible = useMemo(
    () => (browsing ? [...options] : filterCatalogSearchOptions(options, query)),
    [browsing, options, query],
  );

  const selectAll = () => {
    const node = queryInput.current;
    if (node) node.select();
  };
  useEffect(() => { selectAll(); }, []);

  /**
   * P3-W07C-R4-R2: o cua react-data-grid co overflow: clip, nen danh sach goi y
   * render BEN TRONG cell se bi cat khoi o du search co ket qua. Danh sach duoc
   * render qua portal ra document.body va dat bang position: fixed, neo theo
   * input dang sua; toa do duoc tinh lai khi grid cuon hoac viewport doi kich thuoc.
   */
  const [popup, setPopup] = useState<SearchPopupLayout | null>(null);
  const listHeight = Math.min(visible.length * 32 + 8, SEARCH_POPUP_MAX_HEIGHT);

  const updatePopup = useCallback(() => {
    const node = queryInput.current;
    if (!node || typeof window === "undefined") return;
    const rect = node.getBoundingClientRect();
    setPopup(computeSearchPopupPosition({
      anchor: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      listHeight,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    }));
  }, [listHeight]);

  useEffect(() => { updatePopup(); }, [updatePopup, query]);
  useEffect(() => {
    const onViewportChange = () => updatePopup();
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [updatePopup]);

  const commit = (option: CatalogSearchOption) => {
    props.onRowChange({
      ...props.row,
      cells: { ...props.row.cells, [props.columnKey]: option.id },
    }, true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const action = typeaheadKeyAction(
      event.key,
      event.nativeEvent.isComposing || composing.current,
    );
    if (action === null || action === "ignore") return;
    if (action === "up" || action === "down") {
      event.preventDefault();
      setActiveIndex((current) => moveTypeaheadIndex(current, visible.length, action));
      return;
    }
    if (action === "commit") {
      event.preventDefault();
      // Chi commit khi nguoi dung da chon ro rang (click, hoac mui ten roi Enter).
      // KHONG tu commit chi vi ket qua loc con dung mot muc.
      const target = activeIndex >= 0 ? visible[activeIndex] : undefined;
      if (target) commit(target);
      else props.onClose(true, false);
      return;
    }
    if (action === "close") {
      event.preventDefault();
      props.onClose(false, false);
    }
  };

  return (
    <div className={styles.searchEditor}>
      <input
        aria-label={
          props.columnKey === "project_id"
            ? "Dự án"
            : props.columnKey === "collaborator_id"
              ? "CTV"
              : "Người tuyển / Vendor"
        }
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls={"search-options-" + props.columnKey}
        ref={queryInput}
        value={query}
        onChange={(event) => { setQuery(event.currentTarget.value); setActiveIndex(-1); }}
        onKeyDown={onKeyDown}
        onFocus={selectAll}
        onBlur={() => props.onClose(true, false)}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
      />
      {popup !== null && typeof document !== "undefined" && createPortal(
        <ul
          data-testid="catalog-search-popup"
          id={"search-options-" + props.columnKey}
          role="listbox"
          className={styles.searchList}
          style={{
            position: "fixed",
            top: popup.top,
            left: popup.left,
            width: popup.width,
            maxHeight: popup.maxHeight,
          }}>
          {visible.map((option, index) => (
            <li key={option.id} role="option" aria-selected={index === activeIndex}>
              <button
                type="button"
                className={index === activeIndex ? styles.searchOptionActive : undefined}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(option)}>
                {option.label}
              </button>
            </li>
          ))}
        </ul>,
        document.body,
      )}
    </div>
  );
}

/**
 * P3-W07C-R6: KHONG dung input type="date" (trinh duyet hien theo locale may, vd
 * MM/DD/YYYY). Dung editor text DD/MM/YYYY dung chung, commit ve ISO khi hop le.
 */
function DateCellEditor(props: RenderEditCellProps<SpreadsheetGridRow> & { columnKey: string }) {
  return (
    <DdmmDateInput
      ariaLabel={props.columnKey}
      autoFocus
      value={props.row.cells[props.columnKey] ?? ""}
      onDraftChange={(iso) => {
        if (iso === null || iso === (props.row.cells[props.columnKey] ?? "")) return;
        props.onRowChange(
          { ...props.row, cells: { ...props.row.cells, [props.columnKey]: iso } },
          false,
        );
      }}
      onCommit={(iso) => props.onRowChange(
        { ...props.row, cells: { ...props.row.cells, [props.columnKey]: iso } }, true)}
      onClose={(commitChanges) => props.onClose(commitChanges, false)}
    />
  );
}

/**
 * P1.7-H07 + P3-W06A Scope C: text editor cho cac cell editable co gia tri
 * nam trong `row.cells[column.key]`.
 *
 * Bug cu (P1.7-RESIDUAL-TEXT-CELL_SINGLE_CHARACTER_INPUT):
 * - Editor truoc su dung `ref={(node) => { if (node) { node.focus(); node.select(); } }}`
 *   voi arrow function inline. Moi React re-render (do `onChange` goi `onRowChange`)
 *   se unmount + remount callback ref → goi lai `node.select()` → highlight toan
 *   bo text → keystroke tiep theo thay the toan bo, chi thay 1 ky tu.
 *
 * Fix (P3-W06A Scope C):
 * - Dung `useRef` + `useEffect` (empty deps) de focus + select CHI 1 LAN khi
 *   component mount. Subsequent re-render KHONG re-mount input, KHONG re-select.
 * - Dung `applyTextCellKeystroke` / `applyTextCellCompositionEnd` tu file
 *   `text-cell-state.ts` de test duoc contract bang `node:test` (khong can
 *   jsdom). Component chi la "DOM shell" de gan contract vao <input>.
 * - Vietnamese IME: compositionstart/update KHONG commit vao row (giu pre-edit
 *   trong local controlled state); compositionend moi goi `onRowChange` mot lan
 *   voi committed value. Tranh viec tung composing char (vd "t", "ti", "tie",
 *   "tiế", "tiến", "tiếng") gay onRowChange lien tuc va ghi de nhau.
 *
 * Contract van giu nguyen H07:
 *   - Doc/ghi `row.cells[column.key]`.
 *   - Moi keystroke: `onRowChange(next, false)` (commitChanges=false).
 *   - Blur/Enter/Tab: `onClose(true, ...)` commit.
 */
function CellsTextEditorComponent(
  props: RenderEditCellProps<SpreadsheetGridRow>,
) {
  const { row, column, onRowChange, onClose } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  // Controlled value rieng cho input; dong bo voi row.cells khi row thay doi
  // (vd parent re-mount editor, hoac external value patch). Trong khi IME
  // composition dang dien ra, day la gia tri visible (pre-edit). Khi
  // compositionend, parent nhan onRowChange va row prop cap nhat → effect
  // duoi se dong bo lai.
  const [value, setValue] = useState(() => row.cells[column.key] ?? "");

  // Sync local value voi row prop khi row thay doi tu ben ngoai (paste, undo,
  // chon row khac). Khong sync trong khi dang typing hay dang composing.
  const isComposingRef = useRef(false);
  useEffect(() => {
    if (isComposingRef.current) return;
    const next = row.cells[column.key] ?? "";
    setValue((current) => (current === next ? current : next));
  }, [row.cells, column.key]);

  // Focus + select CHI 1 LAN khi mount. Re-render se khong goi lai effect nay
  // (deps rong). Day la phan fix chinh cua bug "select moi render".
  useEffect(() => {
    const node = inputRef.current;
    if (node) {
      node.focus();
      node.select();
    }
  }, []);

  // P3-W06A R1: commit transition goi `commitTextCellValue` / `commitTextCellCompositionEnd`
  // (text-cell-state.ts). Cung helper do test suite goi de xac minh production
  // di theo cung contract. Khong con logic inline duplicate.
  function commit(nextValue: string) {
    const transition = commitTextCellValue({ row, value: nextValue, columnKey: column.key });
    setValue(transition.value);
    onRowChange(
      { ...row, cells: { ...row.cells, [column.key]: transition.value } },
      false,
    );
  }
  function commitComposition(nextValue: string) {
    const transition = commitTextCellCompositionEnd({
      row,
      committedValue: nextValue,
      columnKey: column.key,
    });
    setValue(transition.value);
    onRowChange(
      { ...row, cells: { ...row.cells, [column.key]: transition.value } },
      false,
    );
  }

  return (
    <input
      className="rdg-text-editor"
      ref={inputRef}
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        // Trong khi composition dang dien ra, onChange co the tra ve
        // pre-edit value khac voi gia tri se committed cuoi cung. Van cap
        // nhat local state de user thay ro pre-edit nhung KHONG goi
        // onRowChange (tranh patch 5 lan cho 1 composition).
        if (isComposingRef.current) {
          setValue(next);
          return;
        }
        commit(next);
      }}
      onCompositionStart={() => {
        isComposingRef.current = true;
      }}
      onCompositionEnd={(event) => {
        isComposingRef.current = false;
        // Lay gia tri committed tu currentTarget (data) hoac target (final value).
        const finalValue = (event.currentTarget as HTMLInputElement).value;
        commitComposition(finalValue);
      }}
      onBlur={() => onClose(true, false)}
    />
  );
}

// Memo hoa de tranh re-render thua khi row/column/onRowChange/onClose giu
// cung tham chieu (parent onRowsChange chi emit patch, khong tao row moi).
// React.moi can stable identity de khong remount DOM node → giu focus.
const CellsTextEditor = memo(CellsTextEditorComponent);

function cellsTextEditor(
  { row, column, rowIdx, onRowChange, onClose }: RenderEditCellProps<SpreadsheetGridRow>,
) {
  return (
    <CellsTextEditor
      row={row}
      column={column}
      rowIdx={rowIdx}
      onRowChange={onRowChange}
      onClose={onClose}
    />
  );
}

export function DirectEntrySpreadsheetGrid(props: DirectEntrySpreadsheetGridProps) {
  const {
    rows, validation, catalogOptions, onCellsChange, onPasteApplied, onPasteRejected,
    onProviderTypeChange,
    notice, canUndo, onUndo, saveMessage, saveTone,
    selectedClientRowId, onSelectedClientRowChange,
    zoomLevel, onZoomChange, toolbarActions,
  } = props;

  // P3-W07C-R1 zoom: chi chap nhan cac muc co dinh; mac dinh 100.
  const effectiveZoom = DIRECT_ENTRY_GRID_ZOOM_LEVELS.includes(zoomLevel ?? DIRECT_ENTRY_GRID_DEFAULT_ZOOM)
    ? (zoomLevel ?? DIRECT_ENTRY_GRID_DEFAULT_ZOOM)
    : DIRECT_ENTRY_GRID_DEFAULT_ZOOM;
  const zoomFactor = effectiveZoom / 100;

  const onZoomDecrease = useCallback(() => {
    if (!onZoomChange) return;
    const idx = DIRECT_ENTRY_GRID_ZOOM_LEVELS.indexOf(effectiveZoom);
    if (idx <= 0) return;
    const next = DIRECT_ENTRY_GRID_ZOOM_LEVELS[idx - 1];
    if (typeof next === "number") onZoomChange(next);
  }, [effectiveZoom, onZoomChange]);

  const onZoomIncrease = useCallback(() => {
    if (!onZoomChange) return;
    const idx = DIRECT_ENTRY_GRID_ZOOM_LEVELS.indexOf(effectiveZoom);
    if (idx < 0 || idx >= DIRECT_ENTRY_GRID_ZOOM_LEVELS.length - 1) return;
    const next = DIRECT_ENTRY_GRID_ZOOM_LEVELS[idx + 1];
    if (typeof next === "number") onZoomChange(next);
  }, [effectiveZoom, onZoomChange]);

  const onZoomReset = useCallback(() => {
    if (!onZoomChange) return;
    onZoomChange(DIRECT_ENTRY_GRID_DEFAULT_ZOOM);
  }, [onZoomChange]);

  const zoomCanDecrease = DIRECT_ENTRY_GRID_ZOOM_LEVELS.indexOf(effectiveZoom) > 0;
  const zoomCanIncrease = DIRECT_ENTRY_GRID_ZOOM_LEVELS.indexOf(effectiveZoom)
    < DIRECT_ENTRY_GRID_ZOOM_LEVELS.length - 1;

  const rowIndexOf = useCallback((clientRowId: string) =>
    rows.findIndex((row) => row.clientRowId === clientRowId), [rows]);

  const isEditable = useCallback((row: SpreadsheetGridRow, columnKey: string) =>
    !row.locked && row.editableFields.includes(columnKey), []);

  const issueFor = useCallback((row: SpreadsheetGridRow, columnKey: string) =>
    validation.cellIssues.find((issue) =>
      issue.clientRowId === row.clientRowId && issue.columnKey === columnKey) ?? null, [validation]);

  const columns = useMemo<readonly Column<SpreadsheetGridRow>[]>(() => {
    const build = (column: DirectEntryGridColumn): Column<SpreadsheetGridRow> => {
      const editable = column.editor !== "readonly" && column.editor !== "action" &&
        (column.key === "provider_type" || column.key === "collaborator_id" ||
          column.pasteMode === "write");
      const headerLabel = column.required
        ? <span><span>{column.label}</span><span className={styles.requiredMark} aria-hidden="true"> *</span><span className={styles.srOnly}> (bắt buộc)</span></span>
        : column.label;
      // P3-W07C-R1 zoom: do rong cot scale theo `effectiveZoom`. Pixel goc
      // giu trong `DIRECT_ENTRY_GRID_COLUMNS`; chi scale tai thoi diem render
      // (khong mutate registry).
      const scaledWidth = Math.max(32, Math.round(column.width * zoomFactor));


      const renderCell = ({ row }: RenderCellProps<SpreadsheetGridRow>) => {
        const issue = issueFor(row, column.key);
        const display = (() => {
          const status = row.cells.initial_status ?? "";
          if (column.key === "initial_status" &&
            ["ON", "OFF", "UNCONFIRMED", "PENDING"].includes(status)) {
            return status === "ON" ? "Đang làm việc" : workStatusUiLabel(status);
          }
          if (row.displayValues && Object.hasOwn(row.displayValues, column.key)) {
            return row.displayValues[column.key];
          }
          if (column.key === "display_name") return row.displayName;
          if (column.key === "project_id") return row.projectLabel;
          if (column.key === "provider_type") {
            if (row.providerType === "ctv") return "CTV";
            if (row.providerType === "hrp") return "HRP";
            if (row.providerType === "vendor") return "Vendor";
            return "";
          }
          if (column.key === "recruiter_id") return row.recruiterLabel;
          if (column.key === "collaborator_id") {
            const code = row.cells.collaborator_id ?? "";
            if (code === "") return "";
            const match = (row.catalogOptions?.collaborators ?? catalogOptions?.collaborators)
              ?.find((item) => item.id === code);
            return row.collaboratorLabel || match?.label || code;
          }
          if (column.key === "labor_type") {
            const key = row.cells.labor_type ?? "";
            return key === ""
              ? ""
              : activeLaborTypeLabel(row.catalogOptions?.laborTypes ?? catalogOptions?.laborTypes, key) ??
                "Loại hình không còn hoạt động";
          }
          if (column.key === "row_index") return String(rowIndexOf(row.clientRowId) + 1);
          // `first_work_date` retains its ISO contract and renders DD/MM/YYYY.
          // DOB/CCCD issue date are ordinary text and render exactly as stored.
          if (column.editor === "date") {
            const iso = row.cells[column.key] ?? "";
            return iso === "" ? "" : formatDateToDDMM(iso);
          }
          if (column.key === "date_of_birth" || column.key === "national_id_issued_at") {
            // P3-W07C-R2: text editor writes the exact string to row.cells;
            // closed-cell display is an identity projection, no date format.
            return formatFreeDateText(row.cells[column.key] ?? "");
          }
          return row.cells[column.key] ?? "";
        })();
        const isPlaceholder = row.displayValues !== undefined
          && Object.hasOwn(row.displayValues, column.key)
          && (row.cells[column.key] ?? "") === "";
        return (
          <span data-cell-state={issue ? issue.severity : "ok"}
            data-placeholder={isPlaceholder ? "true" : undefined}
            title={issue ? issue.message : undefined}
            className={[
              issue ? styles.cellError : undefined,
              isPlaceholder ? styles.cellPlaceholder : undefined,
            ].filter(Boolean).join(" ")}>
            {display}
          </span>
        );
      };

      if (!editable) {
        return {
          key: column.key, name: headerLabel, width: scaledWidth, resizable: true,
          renderCell,
        };
      }

      if (column.editor === "select" || column.editor === "catalog") {
        return {
          key: column.key, name: headerLabel, width: scaledWidth, resizable: true,
          editable: (row: SpreadsheetGridRow) => isEditable(row, column.key) &&
            (column.key !== "recruiter_id" || row.providerType !== "") &&
            (column.key !== "collaborator_id" || row.providerType === "ctv"),
          renderCell,
          renderEditCell: (editProps: RenderEditCellProps<SpreadsheetGridRow>) => (
            column.key === "project_id" || column.key === "recruiter_id" ||
            column.key === "collaborator_id"
              // P3-W07C-R4: cac cot catalog dung dropdown co tim kiem.
              ? <SearchableCatalogCellEditor {...editProps} columnKey={column.key}
                  catalogs={catalogOptions} />
              : <SelectCellEditor {...editProps} columnKey={column.key} catalogs={catalogOptions} />
          ),
        };
      }
      if (column.editor === "date") {
        return {
          key: column.key, name: headerLabel, width: scaledWidth, resizable: true,
          // Keep the default outside-click commit. DateCellEditor mirrors each
          // valid ISO draft into RDG's active row so even clicks on non-focusable
          // cells (which do not fire input blur) commit the latest date.
          editorOptions: { commitOnOutsideClick: true },
          editable: (row: SpreadsheetGridRow) => isEditable(row, column.key),
          renderCell,
          renderEditCell: (editProps: RenderEditCellProps<SpreadsheetGridRow>) => (
            <DateCellEditor {...editProps} columnKey={column.key} />
          ),
        };
      }
      return {
        key: column.key, name: headerLabel, width: scaledWidth, resizable: true,
        editable: (row: SpreadsheetGridRow) => isEditable(row, column.key),
        renderCell,
        // P1.7-H07: dung `cellsTextEditor` thay vi `renderTextEditor` mac
        // dinh vi row model dat gia tri trong `row.cells[column.key]`, khong
        // phai `row[column.key]`. Mac dinh se dan den gia tri typed bien mat
        // khi blur/Enter/Tab.
        // P3-W07C-R2: date_of_birth and national_id_issued_at use the common
        // text editor and remain plain text through preview and save.
        renderEditCell: cellsTextEditor,
      };
    };
    const dataColumns = DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS
      .map((key) => directEntryGridColumn(key))
      .filter((column): column is DirectEntryGridColumn => column !== undefined);
    return dataColumns.map(build);
  }, [catalogOptions, isEditable, issueFor, rowIndexOf, zoomFactor]);

  const onRowsChange = useCallback((next: SpreadsheetGridRow[]) => {
    for (const row of next) {
      const current = rows.find((candidate) => candidate.clientRowId === row.clientRowId);
      if (!current) continue;
      const patch: Record<string, string> = {};
      for (const key of row.editableFields) {
        const value = row.cells[key] ?? "";
        if (value !== (current.cells[key] ?? "")) patch[key] = value;
      }
      if (Object.keys(patch).length > 0) onCellsChange(row.clientRowId, patch);
      if (row.providerType !== current.providerType) {
        onProviderTypeChange(row.clientRowId, row.providerType);
      }
    }
  }, [onCellsChange, onProviderTypeChange, rows]);

  /**
   * Paste do nguoi dung chu dong tao tren o dang active. Ma tran duoc map tu o neo;
   * khong co request mang nao o day.
   */
  const onCellPaste = useCallback((args: CellPasteArgs<SpreadsheetGridRow>, event: ClipboardEvent<HTMLDivElement>) => {
    const columnIndex = spreadsheetColumnIndex(args.column.key);
    const rowIndex = rowIndexOf(args.row.clientRowId);
    event.preventDefault();
    if (columnIndex < 0 || rowIndex < 0) {
      onPasteRejected("CLIPBOARD_ANCHOR_INVALID");
      return args.row;
    }
    const text = event.clipboardData.getData("text/plain");
    if (text === "") { onPasteRejected("CLIPBOARD_EMPTY"); return args.row; }
    const parsed = parseClipboardTsv(text);
    if (!parsed.ok) { onPasteRejected("CLIPBOARD_ROW_OVERFLOW"); return args.row; }
    const liveDraftRows = rows.filter((row) => !row.clientStaged).length;
    const mapping = mapClipboardFromAnchor({
      matrix: parsed.matrix,
      anchor: { rowIndex, columnIndex },
      columns: DIRECT_ENTRY_DEFAULT_GRID_COLUMN_KEYS
        .map((key) => directEntryGridColumn(key))
        .filter((column): column is DirectEntryGridColumn => column !== undefined),
      maxRows: liveDraftRows + 100,
    });
    if (!mapping.ok) { onPasteRejected(mapping.code); return args.row; }
    onPasteApplied({ mapping, rowCount: mapping.rowCount, columnCount: mapping.columnCount });
    return args.row;
  }, [onPasteApplied, onPasteRejected, rowIndexOf, rows]);

  const onCellCopy = useCallback((args: CellCopyArgs<SpreadsheetGridRow>, event: ClipboardEvent<HTMLDivElement>) => {
    const value = args.row.cells[args.column.key] ?? "";
    event.clipboardData.setData("text/plain", serializeClipboardTsv([[value]]));
    event.preventDefault();
  }, []);

  const onCellKeyDown = useCallback((args: CellKeyDownArgs<SpreadsheetGridRow>, event: { key: string; preventGridDefault: () => void }) => {
    if (args.mode !== "ACTIVE") return;
    // P1.7-H07: phim dieu huong (mũi tên, Tab, Enter, Home, End, PageUp/Down)
    // cung cap nhat selected row theo `args.row.clientRowId` hien tai. Viec
    // cap nhat chi xay ra neu row thuc su ton tai va khac selection hien tai
    // (tranh re-render thua khi giu phim).
    if (args.row && args.row.clientRowId !== selectedClientRowId) {
      const navigationKeys = new Set([
        "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
        "Tab", "Enter", "Home", "End", "PageUp", "PageDown",
      ]);
      if (navigationKeys.has(event.key)) {
        onSelectedClientRowChange(args.row.clientRowId);
      }
    }
    if (event.key !== "Delete" && event.key !== "Backspace") return;
    const column = args.column;
    const row = args.row;
    if (!column || !row) return;
    if (!isEditable(row, column.key)) return;
    event.preventGridDefault();
    onCellsChange(row.clientRowId, { [column.key]: "" });
  }, [isEditable, onCellsChange, onSelectedClientRowChange, selectedClientRowId]);

  const onCellClick = useCallback((args: { row: SpreadsheetGridRow }) => {
    // P1.7-H07: click cell dong thoi chon row chua cell do, cap nhat
    // contextual action bar. Bo qua neu row khong co clientRowId.
    if (args.row && args.row.clientRowId !== selectedClientRowId) {
      onSelectedClientRowChange(args.row.clientRowId);
    }
  }, [onSelectedClientRowChange, selectedClientRowId]);

  const errorRowCount = validation.rows.filter((row) => row.errorCount > 0).length;

  // P3-W07C-R1 zoom: ty le de truyen vao CSS variables (font-size, padding,
  // row height). Pixel tuyet/constrain bi clamp de tranh gia tri qua nho.
  const scaledRowHeight = Math.max(28,
    Math.round(DIRECT_ENTRY_GRID_BASE_ROW_HEIGHT * zoomFactor));
  const scaledHeaderRowHeight = Math.max(28,
    Math.round(DIRECT_ENTRY_GRID_BASE_HEADER_ROW_HEIGHT * zoomFactor));
  const scaledFontPx = Math.max(10,
    Math.round(DIRECT_ENTRY_GRID_BASE_FONT_PX * zoomFactor));
  const scaledCellPaddingY = Math.max(1,
    Math.round(DIRECT_ENTRY_GRID_BASE_CELL_PADDING_Y_PX * zoomFactor));
  const scaledCellPaddingX = Math.max(2,
    Math.round(DIRECT_ENTRY_GRID_BASE_CELL_PADDING_X_PX * zoomFactor));

  return (
    <div
      className={styles.spreadsheet}
      data-testid="spreadsheet-grid"
      data-zoom-level={effectiveZoom}
      style={{
        ["--direct-entry-grid-font-size" as string]: `${scaledFontPx}px`,
        ["--direct-entry-grid-cell-padding-y" as string]: `${scaledCellPaddingY}px`,
        ["--direct-entry-grid-cell-padding-x" as string]: `${scaledCellPaddingX}px`,
        ["--direct-entry-grid-row-height" as string]: `${scaledRowHeight}px`,
        ["--direct-entry-grid-header-row-height" as string]: `${scaledHeaderRowHeight}px`,
      }}>
      <div className={styles.toolbar}>
        {onZoomChange !== undefined && (
          <span className={styles.zoomControls} role="group" aria-label="Phóng to thu nhỏ bảng nhập liệu">
            <button
              type="button"
              data-testid="spreadsheet-zoom-decrease"
              onClick={onZoomDecrease}
              disabled={!zoomCanDecrease}
              aria-label="Thu nhỏ bảng nhập liệu">
              −
            </button>
            <button
              type="button"
              data-testid="spreadsheet-zoom-reset"
              onClick={onZoomReset}
              aria-label="Đặt lại tỷ lệ bảng nhập liệu">
              Đặt lại
            </button>
            <button
              type="button"
              data-testid="spreadsheet-zoom-increase"
              onClick={onZoomIncrease}
              disabled={!zoomCanIncrease}
              aria-label="Phóng to bảng nhập liệu">
              +
            </button>
            <span
              data-testid="spreadsheet-zoom-level"
              data-zoom-level={effectiveZoom}
              aria-live="polite">
              {`${effectiveZoom}%`}
            </span>
          </span>
        )}
        {notice !== "" && (
          <span data-testid="spreadsheet-paste-notice" role="status">
            <span>{notice}</span>
            {canUndo && (
              <button type="button" data-testid="spreadsheet-undo" onClick={onUndo}>Hoàn tác</button>
            )}
          </span>
        )}
        <div className={styles.toolbarRightCluster} data-testid="spreadsheet-toolbar-right">
          <div className={styles.toolbarValidationCluster} data-testid="spreadsheet-validation-cluster">
            {errorRowCount > 0 && (
              <span className={styles.errorSummaryBadge} data-testid="spreadsheet-error-summary" role="status">{errorRowCount} dòng có lỗi</span>
            )}
            {validation.headerIssues.length > 0 && (
              <span className={styles.toolbarErrorNotice} data-testid="spreadsheet-header-issues" role="alert">
                {validation.headerIssues.map((issue) => issue.message).join(" ")}
              </span>
            )}
            {saveMessage !== undefined && saveMessage !== "" && (
              <span
                data-testid="spreadsheet-save-message"
                data-tone={saveTone === "error" ? "error" : saveTone === "success" ? "success" : "info"}
                className={
                  saveTone === "error"
                    ? styles.spreadsheetSaveMessageError
                    : saveTone === "success"
                      ? styles.spreadsheetSaveMessageSuccess
                      : styles.spreadsheetSaveMessageInfo
                }
                role={saveTone === "error" ? "alert" : "status"}>
                {saveMessage}
              </span>
            )}
          </div>
          {toolbarActions !== undefined && (
            <div className={styles.toolbarActions}>{toolbarActions}</div>
          )}
        </div>
      </div>
      <div className={styles.viewport}>
        <DataGrid<SpreadsheetGridRow>
          aria-label={SPREADSHEET_GRID_ARIA_LABEL}
          columns={columns}
          rows={rows as SpreadsheetGridRow[]}
          rowKeyGetter={(row) => row.clientRowId}
          onRowsChange={onRowsChange}
          onCellPaste={onCellPaste}
          onCellCopy={onCellCopy}
          onCellKeyDown={onCellKeyDown}
          onCellClick={onCellClick}
          // P1.7-H07: highlight toan bo row duoc chon (khong phai chi cell
          // active) de nguoi dung thay ro context cua action bar.
          rowClass={(row) => row.clientRowId === selectedClientRowId
            ? `${styles.rowHighlight ?? ""}`.trim() || "rdg-row-selected"
            : undefined}
          rowHeight={scaledRowHeight}
          headerRowHeight={scaledHeaderRowHeight}
          selectedRows={selectedClientRowId === null || selectedClientRowId === undefined
            ? new Set<string>()
            : new Set<string>([selectedClientRowId])}
          onSelectedRowsChange={(next) => {
            // P1.7-H06: chi giu mot clientRowId duy nhat cho contextual action
            // bar; nhieu selection (cheking box) duoc xem nhuf khong chon.
            if (next.size === 0) {
              if (selectedClientRowId !== null) onSelectedClientRowChange(null);
              return;
            }
            const only = next.values().next().value;
            if (typeof only === "string" && only !== selectedClientRowId) {
              onSelectedClientRowChange(only);
            }
          }}
        />
      </div>
    </div>
  );
}
