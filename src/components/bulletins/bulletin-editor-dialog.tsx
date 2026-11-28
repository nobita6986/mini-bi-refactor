"use client";

import { useCallback, useState, type ChangeEvent } from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Eye,
  FileText,
  Image as ImageIcon,
  Plus,
  Send,
  Trash2,
  Upload,
} from "lucide-react";

import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  BULLETIN_CATEGORIES,
  BULLETIN_CATEGORY_LABELS,
  BULLETIN_DEFAULT_AUTHOR_DISPLAY,
  BULLETIN_STATUS_LABELS,
  bulletinUiErrorMessage,
  classifyBulletinAccessLoss,
  createBulletinFormValuesFromItem,
  createEmptyBulletinFormValues,
  extractBulletinErrorCode,
  formatBulletinFileSize,
  newIdempotencyKey,
  parseBulletinMutationEnvelope,
  validateAttachmentFileClient,
  validateBulletinFormValues,
  type BulletinAccessLossKind,
  type BulletinCategory,
  type BulletinCreatePayload,
  type BulletinFormValues,
  type BulletinItem,
} from "@/lib/bulletins/bulletin-ui-model";

import {
  BulletinArticlePreview,
  bulletinStatusBadgeTone,
} from "./bulletin-detail-dialog";

type EditorTab = "edit" | "preview";
type SavingAction = "draft" | "publish" | "archive" | null;

const INPUT_CLASS =
  "min-h-11 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

const TEXTAREA_CLASS =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

export function BulletinEditorDialog({
  open,
  onOpenChange,
  editingItem,
  onSaved,
  onBulletinMutated,
  onReloadConflict,
  onAccessRevoked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingItem: BulletinItem | null;
  onSaved: (item: BulletinItem, message: string) => void;
  onBulletinMutated?: (item: BulletinItem) => void;
  onReloadConflict?: () => void;
  onAccessRevoked?: (kind: BulletinAccessLossKind) => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      closeDisabled={busy}
      title={editingItem ? "Chỉnh sửa bản tin" : "Tạo bản tin mới"}
      description="Soạn thảo nội dung bản tin nhiều đoạn, đính kèm ảnh hoặc PDF và xem trước trước khi xuất bản."
      descriptionId="bulletin-editor-description"
      closeAriaLabel="Đóng hộp thoại soạn thảo bản tin"
      contentClassName="sm:w-[min(56rem,calc(100vw-2rem))] lg:w-[min(64rem,calc(100vw-2rem))]"
      dataTestId="bulletin-editor-dialog"
    >
      {open ? (
        <BulletinEditorContent
          key={editingItem?.bulletin_id ?? "new"}
          editingItem={editingItem}
          onClose={() => onOpenChange(false)}
          onBusyChange={setBusy}
          onSaved={onSaved}
          onBulletinMutated={onBulletinMutated}
          onReloadConflict={onReloadConflict}
          onAccessRevoked={onAccessRevoked}
        />
      ) : null}
    </FormDialog>
  );
}

function BulletinEditorContent({
  editingItem,
  onClose,
  onBusyChange,
  onSaved,
  onBulletinMutated,
  onReloadConflict,
  onAccessRevoked,
}: {
  editingItem: BulletinItem | null;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onSaved: (item: BulletinItem, message: string) => void;
  onBulletinMutated?: (item: BulletinItem) => void;
  onReloadConflict?: () => void;
  onAccessRevoked?: (kind: BulletinAccessLossKind) => void;
}) {
  const [activeTab, setActiveTab] = useState<EditorTab>("edit");
  const [activeBulletin, setActiveBulletin] = useState<BulletinItem | null>(
    editingItem,
  );
  const [values, setValues] = useState<BulletinFormValues>(() =>
    editingItem
      ? createBulletinFormValuesFromItem(editingItem)
      : createEmptyBulletinFormValues(),
  );
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof BulletinFormValues, string>>
  >({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [savingAction, setSavingAction] = useState<SavingAction>(null);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [deletingAttachmentId, setDeletingAttachmentId] = useState<
    string | null
  >(null);

  const busy =
    savingAction !== null || uploadingFiles || deletingAttachmentId !== null;

  const setSavingState = useCallback(
    (action: SavingAction) => {
      setSavingAction(action);
      onBusyChange(action !== null);
    },
    [onBusyChange],
  );

  const setUploadingState = useCallback(
    (uploading: boolean) => {
      setUploadingFiles(uploading);
      onBusyChange(uploading);
    },
    [onBusyChange],
  );

  const setDeletingState = useCallback(
    (attId: string | null) => {
      setDeletingAttachmentId(attId);
      onBusyChange(attId !== null);
    },
    [onBusyChange],
  );

  const handleMutationResponse = useCallback(
    async (response: Response): Promise<BulletinItem | null> => {
      const rawPayload = await response.json().catch(() => null);
      const errorCode = extractBulletinErrorCode(rawPayload);
      const accessLoss = classifyBulletinAccessLoss(
        response.status,
        errorCode,
      );
      if (accessLoss) {
        onAccessRevoked?.(accessLoss);
        return null;
      }

      if (!response.ok) {
        if (errorCode === "VERSION_CONFLICT") {
          onReloadConflict?.();
        }
        setErrorMessage(bulletinUiErrorMessage(errorCode));
        return null;
      }

      const parsed = parseBulletinMutationEnvelope(rawPayload);
      if (!parsed) {
        setErrorMessage(bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"));
        return null;
      }

      return parsed.item;
    },
    [onAccessRevoked, onReloadConflict],
  );

  const persistDraftOrUpdate = useCallback(
    async (
      currentBulletin: BulletinItem | null,
      payload: BulletinCreatePayload,
    ): Promise<BulletinItem | null> => {
      if (!currentBulletin) {
        const response = await fetch("/api/admin/bulletins", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": newIdempotencyKey(),
          },
          body: JSON.stringify(payload),
        });
        const created = await handleMutationResponse(response);
        if (created) {
          setActiveBulletin(created);
          onBulletinMutated?.(created);
        }
        return created;
      }

      const response = await fetch(
        `/api/admin/bulletins/${encodeURIComponent(currentBulletin.bulletin_id)}`,
        {
          method: "PATCH",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": newIdempotencyKey(),
          },
          body: JSON.stringify({
            expected_row_version: currentBulletin.row_version ?? 1,
            ...payload,
          }),
        },
      );
      const updated = await handleMutationResponse(response);
      if (updated) {
        setActiveBulletin(updated);
        onBulletinMutated?.(updated);
      }
      return updated;
    },
    [handleMutationResponse, onBulletinMutated],
  );

  const handleSaveAction = useCallback(
    async (action: Exclude<SavingAction, null>) => {
      if (busy) return;
      setErrorMessage(null);
      setStatusMessage(null);
      setFieldErrors({});

      const validationIntent = action === "publish" ? "publish" : "draft";
      const validation = validateBulletinFormValues(values, {
        intent: validationIntent,
      });
      if (!validation.ok) {
        setFieldErrors(validation.fieldErrors);
        setErrorMessage(validation.message);
        setActiveTab("edit");
        return;
      }

      setSavingState(action);
      try {
        const savedItem = await persistDraftOrUpdate(
          activeBulletin,
          validation.payload,
        );
        if (!savedItem) {
          return;
        }

        if (action === "draft") {
          const message =
            activeBulletin && activeBulletin.status !== "DRAFT"
              ? "Đã cập nhật nội dung bản tin."
              : "Đã lưu bản nháp bản tin.";
          onSaved(savedItem, message);
          return;
        }

        const targetEndpoint = action === "publish" ? "publish" : "archive";
        const targetStatus = action === "publish" ? "PUBLISHED" : "ARCHIVED";

        if (savedItem.status === targetStatus) {
          onSaved(
            savedItem,
            action === "publish"
              ? "Đã cập nhật bản tin đã xuất bản."
              : "Đã cập nhật bản tin lưu trữ.",
          );
          return;
        }

        const transitionRes = await fetch(
          `/api/admin/bulletins/${encodeURIComponent(savedItem.bulletin_id)}/${targetEndpoint}`,
          {
            method: "POST",
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Idempotency-Key": newIdempotencyKey(),
            },
            body: JSON.stringify({
              expected_row_version: savedItem.row_version ?? 1,
            }),
          },
        );
        const transitioned = await handleMutationResponse(transitionRes);
        if (!transitioned) {
          return;
        }
        setActiveBulletin(transitioned);
        onSaved(
          transitioned,
          action === "publish"
            ? "Đã xuất bản bản tin thành công."
            : "Đã chuyển bản tin sang trạng thái lưu trữ.",
        );
      } catch {
        setErrorMessage(bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"));
      } finally {
        setSavingState(null);
      }
    },
    [
      activeBulletin,
      busy,
      handleMutationResponse,
      onSaved,
      persistDraftOrUpdate,
      setSavingState,
      values,
    ],
  );

  const handleUploadFiles = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const inputEl = event.currentTarget;
      const selectedFiles = Array.from(inputEl.files ?? []);
      inputEl.value = "";
      if (selectedFiles.length === 0 || busy) return;

      setErrorMessage(null);
      setStatusMessage(null);
      setFieldErrors({});

      // Client-side validation for every selected file first
      for (const file of selectedFiles) {
        const fileCheck = validateAttachmentFileClient(file);
        if (!fileCheck.ok) {
          setErrorMessage(`${file.name}: ${fileCheck.message}`);
          return;
        }
      }

      let workingBulletin = activeBulletin;
      if (!workingBulletin) {
        const draftValidation = validateBulletinFormValues(values, {
          intent: "draft",
        });
        if (!draftValidation.ok) {
          setFieldErrors(draftValidation.fieldErrors);
          setErrorMessage(
            draftValidation.fieldErrors.title
              ? "Vui lòng nhập tiêu đề bản tin trước khi tải lên tệp đính kèm."
              : draftValidation.message,
          );
          return;
        }

        setUploadingState(true);
        try {
          const created = await persistDraftOrUpdate(
            null,
            draftValidation.payload,
          );
          if (!created) {
            setUploadingState(false);
            return;
          }
          workingBulletin = created;
        } catch {
          setErrorMessage(bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"));
          setUploadingState(false);
          return;
        }
      } else {
        setUploadingState(true);
      }

      try {
        let uploadedCount = 0;
        for (const file of selectedFiles) {
          const formData = new FormData();
          formData.append("file", file);
          formData.append("title", file.name);
          formData.append(
            "expected_row_version",
            String(workingBulletin.row_version ?? 1),
          );

          const response = await fetch(
            `/api/admin/bulletins/${encodeURIComponent(workingBulletin.bulletin_id)}/attachments`,
            {
              method: "POST",
              cache: "no-store",
              credentials: "same-origin",
              headers: {
                Accept: "application/json",
                "Idempotency-Key": newIdempotencyKey(),
              },
              body: formData,
            },
          );

          const updated = await handleMutationResponse(response);
          if (!updated) {
            return;
          }
          workingBulletin = updated;
          setActiveBulletin(updated);
          onBulletinMutated?.(updated);
          uploadedCount += 1;
        }
        setStatusMessage(
          `Đã tải lên ${uploadedCount} tệp đính kèm thành công.`,
        );
      } catch {
        setErrorMessage(bulletinUiErrorMessage("BULLETIN_STORAGE_UNAVAILABLE"));
      } finally {
        setUploadingState(false);
      }
    },
    [
      activeBulletin,
      busy,
      handleMutationResponse,
      onBulletinMutated,
      persistDraftOrUpdate,
      setUploadingState,
      values,
    ],
  );

  const handleDeleteAttachment = useCallback(
    async (attachmentId: string) => {
      if (!activeBulletin || busy) return;
      setErrorMessage(null);
      setStatusMessage(null);
      setDeletingState(attachmentId);

      try {
        const response = await fetch(
          `/api/admin/bulletins/${encodeURIComponent(activeBulletin.bulletin_id)}/attachments/${encodeURIComponent(attachmentId)}`,
          {
            method: "DELETE",
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
              "Idempotency-Key": newIdempotencyKey(),
            },
            body: JSON.stringify({
              expected_row_version: activeBulletin.row_version ?? 1,
            }),
          },
        );

        const updated = await handleMutationResponse(response);
        if (!updated) return;

        setActiveBulletin(updated);
        onBulletinMutated?.(updated);
        setStatusMessage("Đã xóa tệp đính kèm.");
      } catch {
        setErrorMessage(bulletinUiErrorMessage("BULLETIN_STORAGE_UNAVAILABLE"));
      } finally {
        setDeletingState(null);
      }
    },
    [
      activeBulletin,
      busy,
      handleMutationResponse,
      onBulletinMutated,
      setDeletingState,
    ],
  );

  const updateSection = (index: number, nextValue: string) => {
    setValues((prev) => ({
      ...prev,
      contentSections: prev.contentSections.map((sec, idx) =>
        idx === index ? nextValue : sec,
      ),
    }));
  };

  const addSection = () => {
    setValues((prev) => {
      if (prev.contentSections.length >= 50) return prev;
      return {
        ...prev,
        contentSections: [...prev.contentSections, ""],
      };
    });
  };

  const removeSection = (index: number) => {
    setValues((prev) => {
      if (prev.contentSections.length <= 1) return prev;
      return {
        ...prev,
        contentSections: prev.contentSections.filter((_, idx) => idx !== index),
      };
    });
  };

  const moveSection = (index: number, direction: -1 | 1) => {
    setValues((prev) => {
      const targetIndex = index + direction;
      if (targetIndex < 0 || targetIndex >= prev.contentSections.length) {
        return prev;
      }
      const next = [...prev.contentSections];
      const temp = next[index];
      next[index] = next[targetIndex];
      next[targetIndex] = temp;
      return {
        ...prev,
        contentSections: next,
      };
    });
  };

  const previewSections = values.contentSections
    .map((sec) => sec.trim())
    .filter((sec) => sec.length > 0);
  const currentAttachments = activeBulletin?.attachments ?? [];

  return (
    <div className="space-y-4">
        {/* Status & mode switcher */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <div
            role="tablist"
            aria-label="Chế độ trình soạn thảo bản tin"
            className="flex items-center gap-2"
          >
            <button
              type="button"
              role="tab"
              id="bulletin-editor-tab-edit"
              data-testid="bulletin-editor-tab-edit"
              aria-selected={activeTab === "edit"}
              aria-controls="bulletin-editor-panel-edit"
              onClick={() => setActiveTab("edit")}
              className={
                activeTab === "edit"
                  ? "inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  : "inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              }
            >
              Soạn thảo
            </button>
            <button
              type="button"
              role="tab"
              id="bulletin-editor-tab-preview"
              data-testid="bulletin-editor-tab-preview"
              aria-selected={activeTab === "preview"}
              aria-controls="bulletin-editor-panel-preview"
              onClick={() => setActiveTab("preview")}
              className={
                activeTab === "preview"
                  ? "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-on-primary shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  : "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-full border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              }
            >
              <Eye className="h-4 w-4" aria-hidden="true" />
              <span>Xem trước</span>
            </button>
          </div>

          {activeBulletin?.status ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              <StatusBadge
                tone={bulletinStatusBadgeTone(activeBulletin.status)}
                dot={activeBulletin.status === "PUBLISHED"}
              >
                {BULLETIN_STATUS_LABELS[activeBulletin.status]}
              </StatusBadge>
              {typeof activeBulletin.row_version === "number" ? (
                <span className="font-mono tabular-nums">
                  v{activeBulletin.row_version}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {errorMessage ? (
          <StatusBanner
            tone="error"
            title="Không thể xử lý thao tác bản tin"
            dataTestId="bulletin-editor-error"
            onDismiss={() => setErrorMessage(null)}
          >
            {errorMessage}
          </StatusBanner>
        ) : null}

        {statusMessage ? (
          <StatusBanner
            tone="success"
            dataTestId="bulletin-editor-status"
            onDismiss={() => setStatusMessage(null)}
          >
            {statusMessage}
          </StatusBanner>
        ) : null}

        {activeTab === "edit" ? (
          <div
            id="bulletin-editor-panel-edit"
            role="tabpanel"
            aria-labelledby="bulletin-editor-tab-edit"
            className="space-y-5"
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2 flex flex-col gap-1.5">
                <label
                  htmlFor="bulletin-editor-title"
                  className="text-sm font-medium text-foreground"
                >
                  Tiêu đề bản tin <span className="text-rose-600">*</span>
                </label>
                <input
                  id="bulletin-editor-title"
                  data-testid="bulletin-editor-title"
                  type="text"
                  maxLength={300}
                  disabled={busy}
                  value={values.title}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, title: e.target.value }))
                  }
                  placeholder="Ví dụ: Thông báo lịch nghỉ lễ Quốc khánh 02/09"
                  className={INPUT_CLASS}
                />
                {fieldErrors.title ? (
                  <p className="text-xs text-rose-600">{fieldErrors.title}</p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="bulletin-editor-category"
                  className="text-sm font-medium text-foreground"
                >
                  Chuyên mục <span className="text-rose-600">*</span>
                </label>
                <select
                  id="bulletin-editor-category"
                  data-testid="bulletin-editor-category"
                  disabled={busy}
                  value={values.category}
                  onChange={(e) =>
                    setValues((prev) => ({
                      ...prev,
                      category: e.target.value as BulletinCategory,
                    }))
                  }
                  className={INPUT_CLASS}
                >
                  {BULLETIN_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {BULLETIN_CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
                {fieldErrors.category ? (
                  <p className="text-xs text-rose-600">{fieldErrors.category}</p>
                ) : null}
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="bulletin-editor-badge"
                  className="text-sm font-medium text-foreground"
                >
                  Nhãn nổi bật (tùy chọn)
                </label>
                <input
                  id="bulletin-editor-badge"
                  data-testid="bulletin-editor-badge"
                  type="text"
                  maxLength={40}
                  disabled={busy}
                  value={values.badgeText}
                  onChange={(e) =>
                    setValues((prev) => ({
                      ...prev,
                      badgeText: e.target.value,
                    }))
                  }
                  placeholder="Ví dụ: Quan trọng, Mới"
                  className={INPUT_CLASS}
                />
                {fieldErrors.badgeText ? (
                  <p className="text-xs text-rose-600">
                    {fieldErrors.badgeText}
                  </p>
                ) : null}
              </div>

              <div className="sm:col-span-2 flex flex-col gap-1.5">
                <label
                  htmlFor="bulletin-editor-author"
                  className="text-sm font-medium text-foreground"
                >
                  Người / Bộ phận phát hành <span className="text-rose-600">*</span>
                </label>
                <input
                  id="bulletin-editor-author"
                  data-testid="bulletin-editor-author"
                  type="text"
                  maxLength={160}
                  disabled={busy}
                  value={values.authorDisplay}
                  onChange={(e) =>
                    setValues((prev) => ({
                      ...prev,
                      authorDisplay: e.target.value,
                    }))
                  }
                  placeholder={BULLETIN_DEFAULT_AUTHOR_DISPLAY}
                  className={INPUT_CLASS}
                />
                {fieldErrors.authorDisplay ? (
                  <p className="text-xs text-rose-600">
                    {fieldErrors.authorDisplay}
                  </p>
                ) : null}
              </div>

              <div className="sm:col-span-2 flex flex-col gap-1.5">
                <label
                  htmlFor="bulletin-editor-summary"
                  className="text-sm font-medium text-foreground"
                >
                  Tóm tắt ngắn (tùy chọn)
                </label>
                <textarea
                  id="bulletin-editor-summary"
                  data-testid="bulletin-editor-summary"
                  rows={2}
                  maxLength={600}
                  disabled={busy}
                  value={values.summary}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, summary: e.target.value }))
                  }
                  placeholder="Tóm tắt nội dung chính hiển thị trên thẻ danh sách bản tin…"
                  className={TEXTAREA_CLASS}
                />
                {fieldErrors.summary ? (
                  <p className="text-xs text-rose-600">{fieldErrors.summary}</p>
                ) : null}
              </div>

              <div className="sm:col-span-2 flex items-center gap-3 rounded-xl border border-border bg-surface-muted/50 px-3.5 py-2.5">
                <input
                  id="bulletin-editor-pinned"
                  data-testid="bulletin-editor-pinned"
                  type="checkbox"
                  disabled={busy}
                  checked={values.isPinned}
                  onChange={(e) =>
                    setValues((prev) => ({
                      ...prev,
                      isPinned: e.target.checked,
                    }))
                  }
                  className="h-5 w-5 rounded border-border text-primary focus:ring-2 focus:ring-ring/40"
                />
                <label
                  htmlFor="bulletin-editor-pinned"
                  className="text-sm font-medium text-foreground cursor-pointer select-none"
                >
                  Ghim bản tin lên đầu danh sách
                </label>
              </div>
            </div>

            {/* Multi-section body */}
            <section
              aria-labelledby="bulletin-editor-sections-heading"
              className="space-y-3 rounded-xl border border-border bg-surface-muted/30 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3
                  id="bulletin-editor-sections-heading"
                  className="text-sm font-semibold text-[var(--navy)]"
                >
                  Các đoạn nội dung chi tiết
                </h3>
                <Button
                  type="button"
                  variant="soft"
                  size="md"
                  className="min-h-11"
                  data-testid="bulletin-editor-add-section"
                  disabled={busy || values.contentSections.length >= 50}
                  onClick={addSection}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  <span>Thêm đoạn</span>
                </Button>
              </div>

              {fieldErrors.contentSections ? (
                <p className="text-xs text-rose-600">
                  {fieldErrors.contentSections}
                </p>
              ) : null}

              <div className="space-y-3">
                {values.contentSections.map((section, index) => (
                  <div
                    key={`editor-section-${index}`}
                    className="space-y-2 rounded-xl border border-border bg-surface p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <label
                        htmlFor={`bulletin-editor-section-${index}`}
                        className="text-xs font-semibold uppercase tracking-wider text-muted"
                      >
                        Đoạn {index + 1}
                      </label>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          type="button"
                          variant="secondary"
                          size="md"
                          className="min-h-11 px-3"
                          aria-label={`Di chuyển đoạn ${index + 1} lên trên`}
                          disabled={busy || index === 0}
                          onClick={() => moveSection(index, -1)}
                        >
                          <ArrowUp className="h-4 w-4" aria-hidden="true" />
                          <span>Lên</span>
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="md"
                          className="min-h-11 px-3"
                          aria-label={`Di chuyển đoạn ${index + 1} xuống dưới`}
                          disabled={
                            busy || index === values.contentSections.length - 1
                          }
                          onClick={() => moveSection(index, 1)}
                        >
                          <ArrowDown className="h-4 w-4" aria-hidden="true" />
                          <span>Xuống</span>
                        </Button>
                        <Button
                          type="button"
                          variant="danger-outline"
                          size="md"
                          className="min-h-11 px-3"
                          data-testid={`bulletin-editor-remove-section-${index}`}
                          disabled={busy || values.contentSections.length <= 1}
                          onClick={() => removeSection(index)}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                          <span>Xóa đoạn</span>
                        </Button>
                      </div>
                    </div>
                    <textarea
                      id={`bulletin-editor-section-${index}`}
                      data-testid={`bulletin-editor-section-${index}`}
                      rows={3}
                      maxLength={8000}
                      disabled={busy}
                      value={section}
                      onChange={(e) => updateSection(index, e.target.value)}
                      placeholder="Nhập nội dung đoạn văn bản…"
                      className={TEXTAREA_CLASS}
                    />
                  </div>
                ))}
              </div>
            </section>

            {/* Attachments uploader */}
            <section
              aria-labelledby="bulletin-editor-attachments-heading"
              className="space-y-3 rounded-xl border border-border bg-surface-muted/30 p-4"
            >
              <div className="space-y-1">
                <h3
                  id="bulletin-editor-attachments-heading"
                  className="text-sm font-semibold text-[var(--navy)]"
                >
                  Tệp đính kèm (Ảnh &amp; PDF, tối đa 15 MB/tệp)
                </h3>
                <p className="text-xs text-muted">
                  Nếu bản tin chưa được lưu, hệ thống sẽ tự động tạo bản nháp
                  trước khi tải tệp lên.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border bg-surface p-3">
                  <label
                    htmlFor="bulletin-editor-upload-images"
                    className="flex items-center gap-1.5 text-sm font-medium text-foreground"
                  >
                    <ImageIcon
                      className="h-4 w-4 text-primary"
                      aria-hidden="true"
                    />
                    <span>Tải lên hình ảnh (JPEG, PNG, WEBP)</span>
                  </label>
                  <input
                    id="bulletin-editor-upload-images"
                    data-testid="bulletin-editor-upload-images"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    disabled={busy}
                    onChange={(e) => {
                      void handleUploadFiles(e);
                    }}
                    className="min-h-11 w-full cursor-pointer text-xs text-muted file:mr-3 file:min-h-9 file:rounded-full file:border file:border-border file:bg-surface-muted file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-surface"
                  />
                </div>

                <div className="flex flex-col gap-1.5 rounded-xl border border-dashed border-border bg-surface p-3">
                  <label
                    htmlFor="bulletin-editor-upload-pdfs"
                    className="flex items-center gap-1.5 text-sm font-medium text-foreground"
                  >
                    <FileText
                      className="h-4 w-4 text-primary"
                      aria-hidden="true"
                    />
                    <span>Tải lên tài liệu PDF</span>
                  </label>
                  <input
                    id="bulletin-editor-upload-pdfs"
                    data-testid="bulletin-editor-upload-pdfs"
                    type="file"
                    accept="application/pdf"
                    multiple
                    disabled={busy}
                    onChange={(e) => {
                      void handleUploadFiles(e);
                    }}
                    className="min-h-11 w-full cursor-pointer text-xs text-muted file:mr-3 file:min-h-9 file:rounded-full file:border file:border-border file:bg-surface-muted file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-surface"
                  />
                </div>
              </div>

              {uploadingFiles ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="flex items-center gap-2 text-xs font-medium text-primary"
                >
                  <Upload className="h-4 w-4 animate-pulse" aria-hidden="true" />
                  <span>Đang tải tệp đính kèm lên hệ thống…</span>
                </div>
              ) : null}

              {currentAttachments.length > 0 ? (
                <ul className="space-y-2">
                  {currentAttachments.map((att) => (
                    <li
                      key={att.attachment_id}
                      data-testid={`bulletin-editor-attachment-${att.attachment_id}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-2"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge
                            tone={att.kind === "IMAGE" ? "info" : "neutral"}
                          >
                            {att.kind === "IMAGE" ? "Ảnh" : "PDF"}
                          </StatusBadge>
                          <a
                            href={att.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-medium text-primary hover:underline break-all"
                          >
                            {att.title || att.file_name}
                          </a>
                        </div>
                        <p className="text-xs text-muted font-mono tabular-nums">
                          {formatBulletinFileSize(att.file_size_bytes)}
                          {att.page_count ? ` · ${att.page_count} trang` : ""}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="danger-outline"
                        size="md"
                        className="min-h-11"
                        loading={deletingAttachmentId === att.attachment_id}
                        disabled={busy}
                        data-testid={`bulletin-editor-delete-attachment-${att.attachment_id}`}
                        onClick={() => {
                          void handleDeleteAttachment(att.attachment_id);
                        }}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        <span>Xóa tệp</span>
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">
                  Chưa có tệp đính kèm nào trên bản tin này.
                </p>
              )}
            </section>
          </div>
        ) : (
          <div
            id="bulletin-editor-panel-preview"
            role="tabpanel"
            aria-labelledby="bulletin-editor-tab-preview"
            data-testid="bulletin-editor-preview-panel"
            className="rounded-xl border border-border bg-surface p-4 sm:p-5"
          >
            <BulletinArticlePreview
              title={values.title}
              category={values.category}
              badgeText={values.badgeText.trim() || null}
              status={activeBulletin?.status ?? "DRAFT"}
              showStatus
              isPinned={values.isPinned}
              publishedDateDisplay={activeBulletin?.published_date_display}
              authorDisplay={values.authorDisplay}
              summary={values.summary}
              contentSections={previewSections}
              attachments={currentAttachments}
              emptyBodyHint="Chưa có đoạn nội dung nào. Quay lại tab Soạn thảo để nhập nội dung."
            />
          </div>
        )}

        {/* Footer actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="secondary"
            size="md"
            className="min-h-11"
            disabled={busy}
            data-testid="bulletin-editor-cancel"
            onClick={onClose}
          >
            Đóng
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            {!activeBulletin || activeBulletin.status !== "ARCHIVED" ? (
              <Button
                type="button"
                variant="outline"
                size="md"
                className="min-h-11"
                loading={savingAction === "archive"}
                disabled={busy}
                data-testid="bulletin-editor-archive"
                onClick={() => {
                  void handleSaveAction("archive");
                }}
              >
                <Archive className="h-4 w-4" aria-hidden="true" />
                <span>Lưu trữ</span>
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="md"
              className="min-h-11"
              loading={savingAction === "draft"}
              disabled={busy}
              data-testid="bulletin-editor-save-draft"
              onClick={() => {
                void handleSaveAction("draft");
              }}
            >
              <span>
                {activeBulletin && activeBulletin.status !== "DRAFT"
                  ? "Lưu thay đổi"
                  : "Lưu nháp"}
              </span>
            </Button>
            <Button
              type="button"
              variant="primary"
              size="md"
              className="min-h-11"
              loading={savingAction === "publish"}
              disabled={busy}
              data-testid="bulletin-editor-publish"
              onClick={() => {
                void handleSaveAction("publish");
              }}
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              <span>Xuất bản</span>
            </Button>
          </div>
        </div>
      </div>
  );
}
