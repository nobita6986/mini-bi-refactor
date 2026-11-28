"use client";

import * as AlertDialog from "radix-ui/alert-dialog";
import {
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
} from "react";

import { DdmmDateInput } from "@/components/direct-entry/direct-entry-ddmm-date-input";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";
import type { SpreadsheetValidation } from "@/lib/direct-entry/direct-entry-grid-validation";
import type { SpreadsheetRowModel } from "@/lib/direct-entry/spreadsheet-row-model";
import { formatFreeDateText } from "@/lib/direct-entry/direct-entry-date-format";
import {
  FORM_DOCUMENT_HINTS,
  FORM_DOCUMENT_LABELS,
  FORM_DOCUMENT_TYPES,
  formUploadSlotStatusLabel,
  formatFormFileSize,
  getDefaultFormSaveUploadJobManager,
  type FormDocumentType,
  type FormSaveUploadJobManager,
  type FormUploadSlotState,
} from "@/lib/direct-entry/form-save-upload-job-manager";
import type { WorkerPortraitStagesController } from "./use-worker-portrait-stages";
import styles from "./direct-entry-shell.module.css";

const FORM_EMPLOYMENT_STATUS_CHOICES = ["Đang làm", "Đang chờ việc"] as const;

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return <label className={styles.field}><span>{label}</span>{children}</label>;
}

function statusLabel(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("vi-VN");
  if (["on", "đang làm", "đang làm việc"].includes(normalized)) return "Đang làm";
  if (["unconfirmed", "đang chờ việc"].includes(normalized)) return "Đang chờ việc";
  if (["off", "đã nghỉ", "đang nghỉ"].includes(normalized)) return "Đã nghỉ";
  return value;
}

type FormDocumentUploadSlotProps = {
  documentType: FormDocumentType;
  testIdSuffix: string;
  slot: FormUploadSlotState;
  busy: boolean;
  onSelectFile(file: File): void;
  onCancel?(): void;
  onRetry?(): void;
};

export function FormDocumentUploadSlot({
  documentType,
  testIdSuffix,
  slot,
  busy,
  onSelectFile,
  onCancel,
  onRetry,
}: FormDocumentUploadSlotProps) {
  const docKey = documentType.toLowerCase();
  const inputId = `form-upload-input-${docKey}-${testIdSuffix}`;
  const isPortrait = documentType === "WORKER_PORTRAIT";
  const label = FORM_DOCUMENT_LABELS[documentType];
  const hint = FORM_DOCUMENT_HINTS[documentType];
  const badgeText = formUploadSlotStatusLabel(slot);
  const uploading = slot.status === "uploading";
  const hasFileName = slot.fileName.trim() !== "";
  const formattedSize = formatFormFileSize(slot.sizeBytes);

  return (
    <div
      className={styles.formUploadCard}
      data-testid={`form-upload-slot-${docKey}-${testIdSuffix}`}
    >
      <div className={styles.formUploadSlotHeader}>
        <h4>{label}</h4>
        <span
          className={styles.formUploadStatusBadge}
          data-status={slot.status}
          data-testid={`form-upload-badge-${docKey}-${testIdSuffix}`}
        >
          {badgeText}
        </span>
      </div>

      <label className={styles.field} htmlFor={inputId}>
        <span>{hint}</span>
        <span className={styles.filePickerControl}>
          <input
            id={inputId}
            className={styles.filePickerInput}
            type="file"
            accept={isPortrait ? "image/jpeg,image/png" : "image/jpeg,image/png,application/pdf"}
            disabled={busy || uploading}
            data-testid={`form-upload-input-${docKey}-${testIdSuffix}`}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0] ?? null;
              event.currentTarget.value = "";
              if (file !== null) {
                onSelectFile(file);
              }
            }}
          />
          <span className={styles.filePickerButton} aria-hidden="true">
            {slot.status === "idle" ? "Chọn tệp" : "Thay tệp"}
          </span>
        </span>
      </label>

      {hasFileName && (
        <div className={styles.formUploadFileMeta}>
          <span
            className={styles.formUploadFileName}
            title={slot.fileName}
            data-testid={`form-upload-filename-${docKey}-${testIdSuffix}`}
          >
            {slot.fileName}
          </span>
          <span className="sr-only">{`Tên tệp đã chọn cho ${label}: ${slot.fileName}`}</span>
          {formattedSize !== "" && (
            <span className={styles.formUploadFileSize}>({formattedSize})</span>
          )}
        </div>
      )}

      <p
        className={slot.status === "error" ? styles.documentError : styles.documentStatus}
        role={slot.status === "error" ? "alert" : "status"}
        data-testid={`form-upload-status-${docKey}-${testIdSuffix}`}
      >
        {slot.status === "idle" && "Chưa chọn tệp cho mục này."}
        {slot.status === "selected" &&
          "Đã chọn tệp · chờ lưu hồ sơ để tải ngầm lên máy chủ."}
        {slot.status === "uploading" && "Đang tải tệp lên và gắn vào hồ sơ NLĐ…"}
        {slot.status === "uploaded" && "Tải thành công · đã gắn vào hồ sơ NLĐ."}
        {slot.status === "error" &&
          (slot.errorMessage ?? "Tải tệp bị lỗi — có thể thử tải lại.")}
      </p>

      <div className={styles.formUploadSlotActions}>
        {slot.status === "error" && slot.retryable && onRetry && (
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy || uploading}
            data-testid={`form-upload-retry-${docKey}-${testIdSuffix}`}
            onClick={onRetry}
          >
            Thử tải lại
          </button>
        )}
        {(slot.status === "selected" || slot.status === "error") && onCancel && (
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={busy || uploading}
            data-testid={`form-upload-cancel-${docKey}-${testIdSuffix}`}
            onClick={onCancel}
          >
            Hủy tệp
          </button>
        )}
      </div>
    </div>
  );
}

type Props = {
  model: SpreadsheetRowModel;
  visibleRowIds: readonly string[];
  validation: SpreadsheetValidation;
  catalog: DraftCatalog | null;
  busy: boolean;
  canSave: boolean;
  message: string;
  messageTone: "error" | "success" | "info" | "";
  portraitStages: WorkerPortraitStagesController;
  cccdFrontStages: WorkerPortraitStagesController;
  cccdBackStages: WorkerPortraitStagesController;
  contractStages: WorkerPortraitStagesController;
  uploadJobManager?: FormSaveUploadJobManager;
  officialEntryIds: readonly string[];
  canSubmitOfficial: boolean;
  officialSubmitBusy: boolean;
  onActivateRow(rowId: string): void;
  onChange(rowId: string, field: string, value: string): void;
  onProviderTypeChange(rowId: string, providerType: "hrp" | "vendor" | "ctv" | ""): void;
  onAddRow(): void;
  onDeleteRow(rowId: string): void;
  onSave(): void;
  onSubmitOfficial(): void;
};

export function DirectEntryMultiEntryForm({
  model,
  visibleRowIds,
  validation,
  catalog,
  busy,
  canSave,
  message,
  messageTone,
  portraitStages,
  cccdFrontStages,
  cccdBackStages,
  contractStages,
  uploadJobManager,
  officialEntryIds,
  canSubmitOfficial,
  officialSubmitBusy,
  onActivateRow,
  onChange,
  onProviderTypeChange,
  onAddRow,
  onDeleteRow,
  onSave,
  onSubmitOfficial,
}: Props) {
  const manager = uploadJobManager ?? getDefaultFormSaveUploadJobManager();
  const uploadSnapshot = useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot,
  );
  const [pendingDeleteRowId, setPendingDeleteRowId] = useState<string | null>(null);
  const cancelDeleteButtonRef = useRef<HTMLButtonElement | null>(null);

  const handleChange = (rowId: string, field: string) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      onChange(rowId, field, event.currentTarget.value);
  const formRowIds = Array.from(new Set([
    ...visibleRowIds,
    ...validation.rows.map((row) => row.clientRowId),
  ]));
  const hasUnsupportedEmploymentStatus = formRowIds.some((rowId) => {
    const row = model.rows.find((candidate) => candidate.clientRowId === rowId);
    if (!row) return false;
    const status = statusLabel(row.cells.initial_status ?? "");
    return status !== "" &&
      !(FORM_EMPLOYMENT_STATUS_CHOICES as readonly string[]).includes(status);
  });
  const hasInvalidPreSaveFiles = manager.hasInvalidSelectedFiles(formRowIds);
  const officialUploadJobs = uploadSnapshot.jobs.filter((job) =>
    job.entries.some((entry) => officialEntryIds.includes(entry.entryId)),
  );
  const officialUploadsPending = officialUploadJobs.some((job) => job.status !== "completed");

  const confirmDeleteRow = (rowId: string) => {
    manager.clearRowFiles(rowId);
    for (const controller of [portraitStages, cccdFrontStages, cccdBackStages, contractStages]) {
      const slot = controller.slots.get(rowId);
      if (slot && (slot.status === "staged" || slot.status === "stale")) {
        controller.cancel(rowId, slot.stageId);
      }
    }
    setPendingDeleteRowId(null);
    onDeleteRow(rowId);
  };

  const pendingDeleteRowIndex =
    pendingDeleteRowId !== null ? formRowIds.indexOf(pendingDeleteRowId) : -1;
  const pendingDeleteRow =
    pendingDeleteRowId !== null
      ? model.rows.find((candidate) => candidate.clientRowId === pendingDeleteRowId) ?? null
      : null;

  return (
    <section className={styles.multiEntryForm} aria-labelledby="multi-entry-form-title"
      data-testid="multi-entry-form">
      <header className={styles.multiEntryFormHeader}>
        <div>
          <h2 id="multi-entry-form-title">Nhập nhiều NLĐ</h2>
          <p>Hồ sơ hợp lệ được lưu trước; các tệp đính kèm sẽ tự động tải ngầm sau khi lưu thành công.</p>
        </div>
        <button type="button" className={styles.secondaryButton} disabled={busy}
          data-testid="multi-entry-add-row" onClick={onAddRow}>
          + Thêm NLĐ
        </button>
      </header>

      {uploadSnapshot.jobs.length > 0 && (
        <div
          className={styles.formPostSaveJobsSection}
          data-testid="form-post-save-upload-jobs"
          aria-label="Tiến trình tải tệp đính kèm cho hồ sơ vừa lưu"
        >
          <h3>Tiến trình tải tệp của hồ sơ đã lưu</h3>
          {uploadSnapshot.jobs.map((job) =>
            job.entries.map((entry) => (
              <div
                key={`${job.jobId}:${entry.entryId}`}
                className={styles.formPostSaveJobCard}
                data-testid={`form-post-save-entry-${entry.entryId}`}
              >
                <p className={styles.documentStatus} role="status">
                  {`Hồ sơ đã lưu #${entry.workerOrder} · Đã tải ${job.uploadedFiles}/${job.totalFiles} tệp`}
                  {job.failedFiles > 0
                    ? ` · ${job.failedFiles} tệp lỗi (hồ sơ đã lưu an toàn, có thể thử tải lại từng tệp)`
                    : ""}
                </p>
                <div className={styles.formUploadGrid}>
                  {FORM_DOCUMENT_TYPES.map((documentType) => (
                    <FormDocumentUploadSlot
                      key={`${entry.entryId}-${documentType}`}
                      documentType={documentType}
                      testIdSuffix={`saved-${entry.entryId}`}
                      slot={entry.slots[documentType]}
                      busy={false}
                      onSelectFile={(file) => {
                        void manager.replacePostSaveSlotFile(
                          job.jobId,
                          entry.entryId,
                          documentType,
                          file,
                        );
                      }}
                      onRetry={() => {
                        void manager.retryPostSaveSlot(
                          job.jobId,
                          entry.entryId,
                          documentType,
                        );
                      }}
                      onCancel={() => {
                        manager.cancelPostSaveSlot(
                          job.jobId,
                          entry.entryId,
                          documentType,
                        );
                      }}
                    />
                  ))}
                </div>
              </div>
            )),
          )}
        </div>
      )}

      {formRowIds.length === 0 && <p>Chưa có dòng mới. Chọn “Thêm NLĐ” để bắt đầu.</p>}
      <ol className={styles.mobileStagedList} data-testid="multi-entry-form-rows">
        {formRowIds.map((rowId, index) => {
          const row = model.rows.find((candidate) => candidate.clientRowId === rowId);
          if (!row) return null;
          const cells = row.cells;
          const validationRow = validation.rows.find((candidate) => candidate.clientRowId === rowId);
          const errors = validation.cellIssues.filter((issue) =>
            issue.clientRowId === rowId && issue.severity === "error");
          const rawStatus = statusLabel(cells.initial_status ?? "");
          const unsupportedStatus = rawStatus !== "" &&
            !(FORM_EMPLOYMENT_STATUS_CHOICES as readonly string[]).includes(rawStatus);
          const currentStatus = unsupportedStatus ? "" : rawStatus || "Đang làm";
          const rowSlots = uploadSnapshot.preSaveByRowId[rowId] ?? manager.getRowSlots(rowId);
          const fieldLabel = (label: string) => (
            <><span>{label}</span><span className={styles.requiredStar} aria-hidden="true"> *</span>
              <span className="sr-only"> (bắt buộc)</span></>
          );

          return (
            <li key={rowId} data-testid={`multi-entry-row-${index + 1}`}>
              <details className={styles.mobileStagedCard} open
                onToggle={(event) => {
                  if ((event.currentTarget as HTMLDetailsElement).open) onActivateRow(rowId);
                }}>
                <summary>
                  NLĐ {index + 1}: {cells.display_name || (cells.national_id ? `CCCD ${cells.national_id}` : "Chưa nhập họ tên")}
                  {" · "}{validationRow ? (validationRow.errorCount > 0
                    ? `${validationRow.errorCount} lỗi` : "Hợp lệ") : "Chưa nhập"}
                </summary>
                <fieldset className={styles.formFieldset} disabled={busy}>
                  {errors.length > 0 && (
                    <ul className={styles.quickErrorList} role="alert"
                      aria-label={`Lỗi cần sửa của NLĐ ${index + 1}`}>
                      {errors.map((issue, issueIndex) => (
                        <li key={`${issue.columnKey ?? "field"}-${issue.code}-${issueIndex}`}>
                          {issue.columnKey ?? "Thông tin"}: {issue.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  <Field label={fieldLabel("Dự án")}>
                    <select required value={cells.project_id ?? ""}
                      onChange={handleChange(rowId, "project_id")}>
                      <option value="">Chọn dự án</option>
                      {(catalog?.projects ?? []).map((project) =>
                        <option key={project.project_id} value={project.project_id}>{project.display_name}</option>)}
                    </select>
                  </Field>
                  <Field label={fieldLabel("Nguồn tuyển")}>
                    <select required aria-label="Nguồn" value={row.providerType}
                      onChange={(event) => onProviderTypeChange(rowId,
                        event.currentTarget.value === "hrp" ||
                        event.currentTarget.value === "vendor" ||
                        event.currentTarget.value === "ctv"
                          ? event.currentTarget.value : "")}>
                      <option value="">Chọn HRP, Vendor hoặc CTV</option>
                      <option value="hrp">HRP (trực tiếp)</option>
                      <option value="vendor">Vendor</option>
                      <option value="ctv">CTV</option>
                    </select>
                  </Field>
                  <Field label={fieldLabel("Người tuyển / Vendor")}>
                    <select required value={cells.recruiter_id ?? ""} disabled={row.providerType === ""}
                      onChange={handleChange(rowId, "recruiter_id")}>
                      <option value="">Chọn người tuyển / Vendor</option>
                      {(catalog?.recruiters ?? []).filter((recruiter) =>
                        row.providerType === "" ||
                        recruiter.provider_type === (row.providerType === "ctv" ? "hrp" : row.providerType))
                        .map((recruiter) => <option key={recruiter.recruiter_id}
                          value={recruiter.recruiter_id}>{recruiter.display_name}</option>)}
                    </select>
                  </Field>
                  <Field label={row.providerType === "ctv" ? fieldLabel("CTV") : "CTV"}>
                    <select
                      aria-label="CTV"
                      required={row.providerType === "ctv"}
                      disabled={row.providerType !== "ctv"}
                      value={row.providerType === "ctv" ? (cells.collaborator_id ?? "") : ""}
                      onChange={handleChange(rowId, "collaborator_id")}
                    >
                      <option value="">
                        {row.providerType === "ctv" ? "Chọn CTV" : "Chỉ áp dụng khi nguồn là CTV"}
                      </option>
                      {(catalog?.collaborators ?? [])
                        .filter((collaborator) => collaborator.active)
                        .map((collaborator) => (
                          <option key={collaborator.collaborator_id} value={collaborator.collaborator_id}>
                            {collaborator.display_name} ({collaborator.collaborator_id})
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label={fieldLabel("Loại hình LĐ")}>
                    <select required value={cells.labor_type ?? ""} onChange={handleChange(rowId, "labor_type")}>
                      <option value="">Chọn loại hình lao động</option>
                      {(catalog?.labor_types ?? []).map((option) =>
                        <option key={option.labor_type_key} value={option.labor_type_key}>{option.display_name}</option>)}
                    </select>
                  </Field>
                  <Field label={fieldLabel("Ngày bắt đầu làm việc")}>
                    <DdmmDateInput ariaLabel="Ngày bắt đầu làm việc" value={cells.first_work_date ?? ""}
                      required
                      onCommit={(iso) => onChange(rowId, "first_work_date", iso)} />
                  </Field>
                  <Field label="Trạng thái làm việc">
                    <select required value={currentStatus}
                      onChange={handleChange(rowId, "initial_status")}>
                      {unsupportedStatus && <option value="" disabled>Chọn lại trạng thái</option>}
                      <option value="Đang làm">Đang làm</option>
                      <option value="Đang chờ việc">Đang chờ việc</option>
                    </select>
                    {unsupportedStatus && <span role="alert">
                      Hãy chọn “Đang làm” hoặc “Đang chờ việc” để tiếp tục.
                    </span>}
                  </Field>
                  <Field label={fieldLabel("Số CCCD")}>
                    <input required maxLength={12} inputMode="numeric" autoComplete="off" value={cells.national_id ?? ""}
                      onChange={handleChange(rowId, "national_id")} />
                  </Field>
                  <Field label="Họ và tên">
                    <input autoComplete="name" value={cells.display_name ?? ""}
                      onChange={handleChange(rowId, "display_name")} />
                  </Field>
                  <Field label="Số điện thoại">
                    <input autoComplete="tel" inputMode="tel" value={cells.phone ?? ""}
                      onChange={handleChange(rowId, "phone")} />
                  </Field>
                  <Field label="Giới tính">
                    <select value={cells.gender ?? ""} onChange={handleChange(rowId, "gender")}>
                      <option value="">—</option><option value="Nam">Nam</option><option value="Nữ">Nữ</option><option value="Khác">Khác</option>
                      {(cells.gender ?? "") !== "" && !["Nam", "Nữ", "Khác"].includes(cells.gender ?? "") &&
                        <option value={cells.gender} disabled>{cells.gender}</option>}
                    </select>
                  </Field>

                  <div className={styles.formUploadSection}>
                    <h3>Tải hồ sơ lên</h3>
                    <div className={styles.formUploadGrid}>
                      {FORM_DOCUMENT_TYPES.map((documentType) => (
                        <FormDocumentUploadSlot
                          key={`${rowId}-${documentType}`}
                          documentType={documentType}
                          testIdSuffix={rowId}
                          slot={rowSlots[documentType]}
                          busy={busy}
                          onSelectFile={(file) => {
                            manager.selectPreSaveFile(rowId, documentType, file);
                          }}
                          onCancel={() => {
                            manager.cancelPreSaveFile(rowId, documentType);
                          }}
                        />
                      ))}
                    </div>
                  </div>

                  <details className={styles.formOptionalDetails}>
                    <summary>Thông tin thêm: tài khoản ngân hàng, ghi chú và ngày/nơi cấp, địa chỉ</summary>
                    <div className={`${styles.drawerFields} ${styles.formOptionalGrid}`}>
                      <Field label="STK">
                        <input inputMode="numeric" autoComplete="off" value={cells.account_number ?? ""}
                          onChange={handleChange(rowId, "account_number")} />
                      </Field>
                      <Field label="Tên chủ tài khoản">
                        <input autoComplete="name" value={cells.account_holder_name ?? ""}
                          onChange={handleChange(rowId, "account_holder_name")} />
                      </Field>
                      <Field label="Ngân hàng">
                        <input value={cells.bank_name ?? ""} onChange={handleChange(rowId, "bank_name")} />
                      </Field>
                      <Field label="Ghi chú">
                        <textarea value={cells.general_note ?? ""} onChange={handleChange(rowId, "general_note")} />
                      </Field>
                      <Field label="Ngày sinh">
                        <input inputMode="numeric" placeholder="DD/MM/YYYY"
                          value={formatFreeDateText(cells.date_of_birth ?? "")}
                          onChange={handleChange(rowId, "date_of_birth")} />
                      </Field>
                      <Field label="Ngày cấp CCCD">
                        <input inputMode="numeric" placeholder="DD/MM/YYYY"
                          value={formatFreeDateText(cells.national_id_issued_at ?? "")}
                          onChange={handleChange(rowId, "national_id_issued_at")} />
                      </Field>
                      <Field label="Địa chỉ">
                        <input autoComplete="street-address" value={cells.address ?? ""}
                          onChange={handleChange(rowId, "address")} />
                      </Field>
                    </div>
                  </details>
                </fieldset>
                <div className={styles.formRowActions}>
                  <button
                    type="button"
                    className={styles.secondaryButton}
                    disabled={busy}
                    data-testid={`form-delete-row-trigger-${rowId}`}
                    onClick={() => setPendingDeleteRowId(rowId)}
                  >
                    Xóa dòng này
                  </button>
                </div>
              </details>
            </li>
          );
        })}
      </ol>

      <AlertDialog.Root
        open={pendingDeleteRowId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteRowId(null);
        }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={styles.formDeleteConfirmOverlay} />
          <AlertDialog.Content
            className={styles.formDeleteConfirmDialog}
            data-testid="form-delete-row-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              cancelDeleteButtonRef.current?.focus();
            }}
          >
            <AlertDialog.Title className={styles.formDeleteConfirmTitle}>
              Xác nhận xóa dòng đang nhập?
            </AlertDialog.Title>
            <AlertDialog.Description className={styles.formDeleteConfirmDescription}>
              {pendingDeleteRow !== null
                ? `Bạn có chắc muốn xóa dòng NLĐ ${pendingDeleteRowIndex + 1} (${pendingDeleteRow.cells.display_name || (pendingDeleteRow.cells.national_id ? `CCCD ${pendingDeleteRow.cells.national_id}` : "Chưa nhập họ tên")})? Dữ liệu đã nhập và các tệp đã chọn ở dòng này sẽ bị hủy.`
                : "Dữ liệu đã nhập và các tệp đã chọn ở dòng này sẽ bị hủy."}
            </AlertDialog.Description>
            <div className={styles.formDeleteConfirmActions}>
              <AlertDialog.Cancel asChild>
                <button
                  ref={cancelDeleteButtonRef}
                  type="button"
                  className={styles.formDeleteCancelButtonProminent}
                  data-testid="form-delete-row-cancel"
                >
                  Hủy
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className={styles.formDeleteConfirmButtonSubtle}
                  data-testid="form-delete-row-confirm"
                  onClick={() => {
                    if (pendingDeleteRowId !== null) {
                      confirmDeleteRow(pendingDeleteRowId);
                    }
                  }}
                >
                  Xóa dòng
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      {portraitStages.staleCount > 0 && (
        <button type="button" className={styles.secondaryButton} data-testid="form-portrait-cleanup-retry"
          onClick={portraitStages.retryCleanup}>Thử dọn ảnh NLĐ cũ chưa hủy được</button>
      )}
      {portraitStages.message !== "" && <p className={styles.documentStatus} role="status">{portraitStages.message}</p>}
      {hasInvalidPreSaveFiles && (
        <p role="alert" className={styles.documentError} data-testid="form-invalid-files-error">
          Có tệp đính kèm không hợp lệ. Hãy thay tệp đúng định dạng/dung lượng hoặc bấm Hủy tệp trước khi lưu.
        </p>
      )}
      {hasUnsupportedEmploymentStatus && <p role="alert" className={styles.documentError}>
        Trạng thái chỉ nhận “Đang làm” hoặc “Đang chờ việc”. Hãy chọn lại ở các dòng được báo lỗi.
      </p>}
      <footer className={styles.multiEntryFormActions}>
        <button type="button" className={styles.secondaryButton} disabled={busy} onClick={onAddRow}>
          + Thêm NLĐ nữa
        </button>
        <button type="button" className={styles.secondaryButton} data-testid="form-save-valid-rows"
          disabled={busy || !canSave || hasUnsupportedEmploymentStatus || hasInvalidPreSaveFiles}
          aria-busy={busy} onClick={onSave}>
          {busy ? "Đang lưu…" : "Lưu nháp"}
        </button>
        <AlertDialog.Root>
          <AlertDialog.Trigger asChild>
            <button
              type="button"
              className={styles.primaryButton}
              data-testid="form-submit-official"
              disabled={busy || officialSubmitBusy || !canSubmitOfficial || officialUploadsPending ||
                hasUnsupportedEmploymentStatus || hasInvalidPreSaveFiles}
              aria-busy={officialSubmitBusy}
            >
              {officialSubmitBusy ? "Đang lưu và gửi…" : "Gửi chính thức"}
            </button>
          </AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className={styles.drawerOverlay} />
            <AlertDialog.Content className={styles.confirmDialog}>
              <AlertDialog.Title className={styles.drawerTitle}>
                Gửi chính thức đợt nhập liệu?
              </AlertDialog.Title>
              <AlertDialog.Description className={styles.drawerDescription}>
                Hồ sơ hợp lệ sẽ được lưu thành bản nháp rồi chuyển thẳng sang trạng thái đã gửi chính thức,
                không qua bước chờ người khác duyệt. Hãy kiểm tra thông tin trước khi tiếp tục.
              </AlertDialog.Description>
              <div className={styles.drawerActions}>
                <AlertDialog.Cancel asChild>
                  <button type="button" className={styles.secondaryButton}>Hủy</button>
                </AlertDialog.Cancel>
                <AlertDialog.Action asChild>
                  <button
                    type="button"
                    className={styles.primaryButton}
                    data-testid="form-submit-official-confirm"
                    disabled={officialSubmitBusy}
                    onClick={onSubmitOfficial}
                  >
                    Gửi chính thức
                  </button>
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </footer>
      {officialUploadsPending && (
        <p className={styles.documentStatus} role="status" data-testid="official-submit-waits-for-uploads">
          Ảnh của bản nháp đang tải hoặc cần thử lại. Hoàn tất tải ảnh trước khi gửi chính thức.
        </p>
      )}
      {message !== "" && <p className={messageTone === "error" ? styles.documentError : styles.documentStatus}
        role={messageTone === "error" ? "alert" : "status"}>{message}</p>}
    </section>
  );
}
