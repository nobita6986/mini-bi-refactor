"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Pin,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

import { StatusBadge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  BULLETIN_CATEGORY_LABELS,
  BULLETIN_STATUS_LABELS,
  formatBulletinFileSize,
  type BulletinAttachment,
  type BulletinCategory,
  type BulletinItem,
  type BulletinStatus,
} from "@/lib/bulletins/bulletin-ui-model";

export function bulletinStatusBadgeTone(status: BulletinStatus): BadgeTone {
  switch (status) {
    case "PUBLISHED":
      return "success";
    case "DRAFT":
      return "warning";
    case "ARCHIVED":
    default:
      return "neutral";
  }
}

export function BulletinArticlePreview({
  title,
  category,
  categoryDisplay,
  badgeText,
  status,
  showStatus = false,
  isPinned,
  isRead,
  publishedDateDisplay,
  authorDisplay,
  summary,
  contentSections,
  attachments,
  emptyBodyHint = "Bản tin hiện chưa có nội dung chi tiết.",
}: {
  title: string;
  category: BulletinCategory;
  categoryDisplay?: string;
  badgeText?: string | null;
  status?: BulletinStatus;
  showStatus?: boolean;
  isPinned: boolean;
  isRead?: boolean;
  publishedDateDisplay?: string | null;
  authorDisplay: string;
  summary: string;
  contentSections: readonly string[];
  attachments: readonly BulletinAttachment[];
  emptyBodyHint?: string;
}) {
  const [zoomedImageId, setZoomedImageId] = useState<string | null>(null);
  const [expandedPdfIds, setExpandedPdfIds] = useState<Record<string, boolean>>({});

  const imageAttachments = attachments.filter((att) => att.kind === "IMAGE");
  const pdfAttachments = attachments.filter((att) => att.kind === "PDF");
  const zoomedImage =
    imageAttachments.find((att) => att.attachment_id === zoomedImageId) ?? null;

  useEffect(() => {
    if (!zoomedImage) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setZoomedImageId(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [zoomedImage]);

  const togglePdfPreview = useCallback((attachmentId: string) => {
    setExpandedPdfIds((prev) => ({
      ...prev,
      [attachmentId]: !prev[attachmentId],
    }));
  }, []);

  const resolvedCategoryLabel =
    categoryDisplay && categoryDisplay.trim().length > 0
      ? categoryDisplay
      : BULLETIN_CATEGORY_LABELS[category];

  return (
    <article className="space-y-5">
      {/* Header badges & metadata */}
      <header className="space-y-3 border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-2">
          {isPinned ? (
            <StatusBadge tone="warning" dataTestId="bulletin-detail-pinned-badge">
              <Pin className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Đã ghim</span>
            </StatusBadge>
          ) : null}
          <StatusBadge tone="info" dataTestId="bulletin-detail-category-badge">
            {resolvedCategoryLabel}
          </StatusBadge>
          {badgeText ? (
            <StatusBadge tone="primary" dataTestId="bulletin-detail-highlight-badge">
              {badgeText}
            </StatusBadge>
          ) : null}
          {showStatus && status ? (
            <StatusBadge
              tone={bulletinStatusBadgeTone(status)}
              dot={status === "PUBLISHED"}
              dataTestId="bulletin-detail-status-badge"
            >
              {BULLETIN_STATUS_LABELS[status]}
            </StatusBadge>
          ) : null}
          {isRead === false && (status === undefined || status === "PUBLISHED") ? (
            <StatusBadge tone="primary" dot dataTestId="bulletin-detail-unread-badge">
              Chưa đọc
            </StatusBadge>
          ) : null}
        </div>

        <h2 className="text-lg font-semibold tracking-tight text-[var(--navy)] sm:text-xl break-words">
          {title.trim() || "Chưa nhập tiêu đề bản tin"}
        </h2>

        <dl className="grid grid-cols-1 gap-2 rounded-xl bg-surface-muted/70 px-3.5 py-2.5 text-xs sm:grid-cols-2 sm:text-sm">
          <div className="min-w-0">
            <dt className="text-[11px] uppercase tracking-wider text-muted">
              Người / Bộ phận phát hành
            </dt>
            <dd className="font-medium text-foreground break-words">
              {authorDisplay.trim() || "Phòng Hành chính - Nhân sự HRPartner"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-[11px] uppercase tracking-wider text-muted">
              Ngày phát hành
            </dt>
            <dd className="font-mono tabular-nums font-medium text-foreground">
              {publishedDateDisplay && publishedDateDisplay.trim().length > 0
                ? publishedDateDisplay
                : "Chưa xuất bản"}
            </dd>
          </div>
        </dl>
      </header>

      {/* Summary */}
      {summary.trim().length > 0 ? (
        <section
          aria-label="Tóm tắt bản tin"
          className="rounded-xl border border-primary/20 bg-[var(--selected-bg)] px-4 py-3 text-sm leading-relaxed text-foreground whitespace-pre-line break-words"
        >
          {summary.trim()}
        </section>
      ) : null}

      {/* Content sections */}
      <section aria-label="Nội dung bản tin" className="space-y-3">
        {contentSections.length > 0 ? (
          contentSections.map((section, index) => (
            <p
              key={`section-${index}`}
              className="text-sm sm:text-[15px] leading-relaxed text-foreground whitespace-pre-line break-words"
            >
              {section}
            </p>
          ))
        ) : (
          <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted">
            {emptyBodyHint}
          </p>
        )}
      </section>

      {/* Inline Image Viewer */}
      {imageAttachments.length > 0 ? (
        <section
          aria-labelledby="bulletin-images-heading"
          className="space-y-3 border-t border-border pt-4"
        >
          <div className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-primary" aria-hidden="true" />
            <h3
              id="bulletin-images-heading"
              className="text-sm font-semibold text-[var(--navy)]"
            >
              Hình ảnh đính kèm ({imageAttachments.length})
            </h3>
          </div>

          {zoomedImage ? (
            <div
              role="region"
              aria-label={`Xem phóng to ảnh: ${zoomedImage.title || zoomedImage.file_name}`}
              data-testid="bulletin-image-lightbox"
              className="space-y-3 rounded-xl border-2 border-primary/50 bg-surface-muted p-3 sm:p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs sm:text-sm font-medium text-foreground break-words">
                  {zoomedImage.title || zoomedImage.file_name}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    className="min-h-11"
                    onClick={() => setZoomedImageId(null)}
                  >
                    <ZoomOut className="h-4 w-4" aria-hidden="true" />
                    <span>Thu nhỏ</span>
                  </Button>
                  <a
                    href={zoomedImage.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonClasses({
                      variant: "outline",
                      size: "md",
                      className: "min-h-11",
                    })}
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" />
                    <span>Mở ảnh gốc</span>
                  </a>
                </div>
              </div>
              <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-surface p-2">
                {/* eslint-disable-next-line @next/next/no-img-element -- Cookie-authenticated API route */}
                <img
                  src={zoomedImage.url}
                  alt={zoomedImage.title || zoomedImage.file_name}
                  width={zoomedImage.width ?? 1200}
                  height={zoomedImage.height ?? 800}
                  className="mx-auto h-auto max-w-full rounded object-contain"
                />
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {imageAttachments.map((att) => {
              const isZoomed = zoomedImageId === att.attachment_id;
              const altText = att.title || att.file_name;
              return (
                <figure
                  key={att.attachment_id}
                  data-testid={`bulletin-image-attachment-${att.attachment_id}`}
                  className="flex flex-col justify-between gap-3 rounded-xl border border-border bg-surface p-3 shadow-2xs"
                >
                  <div className="overflow-hidden rounded-lg border border-border/70 bg-surface-muted">
                    {/* eslint-disable-next-line @next/next/no-img-element -- Cookie-authenticated API route */}
                    <img
                      src={att.url}
                      alt={altText}
                      width={att.width ?? 1200}
                      height={att.height ?? 800}
                      loading="lazy"
                      className="h-auto max-h-72 w-full object-contain"
                    />
                  </div>
                  <figcaption className="space-y-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground break-words">
                        {altText}
                      </p>
                      <p className="text-xs text-muted font-mono tabular-nums">
                        {formatBulletinFileSize(att.file_size_bytes)}
                        {att.width && att.height ? ` · ${att.width}×${att.height}px` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant={isZoomed ? "primary" : "soft"}
                        size="md"
                        className="min-h-11"
                        aria-expanded={isZoomed}
                        onClick={() =>
                          setZoomedImageId(isZoomed ? null : att.attachment_id)
                        }
                      >
                        {isZoomed ? (
                          <ZoomOut className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <ZoomIn className="h-4 w-4" aria-hidden="true" />
                        )}
                        <span>{isZoomed ? "Thu nhỏ" : "Phóng to"}</span>
                      </Button>
                      <a
                        href={att.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonClasses({
                          variant: "secondary",
                          size: "md",
                          className: "min-h-11",
                        })}
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        <span>Mở ảnh gốc</span>
                      </a>
                    </div>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Inline PDF Viewer & Download */}
      {pdfAttachments.length > 0 ? (
        <section
          aria-labelledby="bulletin-pdfs-heading"
          className="space-y-3 border-t border-border pt-4"
        >
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" aria-hidden="true" />
            <h3
              id="bulletin-pdfs-heading"
              className="text-sm font-semibold text-[var(--navy)]"
            >
              Tài liệu PDF đính kèm ({pdfAttachments.length})
            </h3>
          </div>

          <div className="space-y-3">
            {pdfAttachments.map((att) => {
              const isExpanded = Boolean(expandedPdfIds[att.attachment_id]);
              const labelText = att.title || att.file_name;
              return (
                <div
                  key={att.attachment_id}
                  data-testid={`bulletin-pdf-attachment-${att.attachment_id}`}
                  className="rounded-xl border border-border bg-surface-muted/40 p-3.5 space-y-3"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-sm font-medium text-foreground break-words">
                        {labelText}
                      </p>
                      <p className="text-xs text-muted font-mono tabular-nums">
                        {att.page_count ? `${att.page_count} trang · ` : ""}
                        {formatBulletinFileSize(att.file_size_bytes)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      <Button
                        type="button"
                        variant={isExpanded ? "primary" : "soft"}
                        size="md"
                        className="min-h-11"
                        aria-expanded={isExpanded}
                        onClick={() => togglePdfPreview(att.attachment_id)}
                      >
                        <FileText className="h-4 w-4" aria-hidden="true" />
                        <span>
                          {isExpanded ? "Ẩn xem trước" : "Xem trước PDF"}
                        </span>
                      </Button>
                      <a
                        href={att.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonClasses({
                          variant: "secondary",
                          size: "md",
                          className: "min-h-11",
                        })}
                      >
                        <ExternalLink className="h-4 w-4" aria-hidden="true" />
                        <span>Mở PDF trong tab mới</span>
                      </a>
                      <a
                        href={att.url}
                        download={att.file_name}
                        className={buttonClasses({
                          variant: "outline",
                          size: "md",
                          className: "min-h-11",
                        })}
                      >
                        <Download className="h-4 w-4" aria-hidden="true" />
                        <span>Tải xuống PDF</span>
                      </a>
                    </div>
                  </div>

                  {isExpanded ? (
                    <div className="max-h-[560px] overflow-auto rounded-lg border border-border bg-white">
                      <iframe
                        title={`Xem trước PDF: ${labelText}`}
                        src={att.url}
                        className="h-[520px] w-full border-0"
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </article>
  );
}

export function BulletinDetailDialog({
  open,
  onOpenChange,
  bulletin,
  loading,
  error,
  onRetry,
  onMarkRead,
  canManage = false,
  onEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bulletin: BulletinItem | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  onMarkRead?: (bulletinId: string) => void | Promise<void>;
  canManage?: boolean;
  onEdit?: (bulletin: BulletinItem) => void;
}) {
  const autoMarkedIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      autoMarkedIdRef.current = null;
      return;
    }
    if (
      bulletin &&
      bulletin.is_read === false &&
      (bulletin.status === undefined || bulletin.status === "PUBLISHED") &&
      onMarkRead &&
      autoMarkedIdRef.current !== bulletin.bulletin_id
    ) {
      autoMarkedIdRef.current = bulletin.bulletin_id;
      void onMarkRead(bulletin.bulletin_id);
    }
  }, [open, bulletin, onMarkRead]);

  const dialogTitle = bulletin?.title || "Chi tiết bản tin HRPartner";
  const dialogDescription = bulletin
    ? `${bulletin.category_display || BULLETIN_CATEGORY_LABELS[bulletin.category]} · ${bulletin.author_display}`
    : "Thông tin chi tiết bản tin nội bộ từ Phòng Hành chính - Nhân sự HRPartner.";

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={dialogTitle}
      description={dialogDescription}
      descriptionId="bulletin-detail-description"
      closeAriaLabel="Đóng hộp thoại chi tiết bản tin"
      contentClassName="sm:w-[min(56rem,calc(100vw-2rem))] lg:w-[min(64rem,calc(100vw-2rem))]"
      dataTestId="bulletin-detail-dialog"
    >
      <div className="space-y-4">
        {error ? (
          <StatusBanner
            tone="error"
            title="Không thể tải chi tiết bản tin"
            dataTestId="bulletin-detail-error"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{error}</span>
              {onRetry ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  className="min-h-11"
                  onClick={onRetry}
                  disabled={loading}
                >
                  Thử lại
                </Button>
              ) : null}
            </div>
          </StatusBanner>
        ) : null}

        {loading && !bulletin ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="bulletin-detail-loading"
            className="rounded-xl border border-border bg-surface p-6 text-center text-sm text-muted"
          >
            Đang tải chi tiết bản tin…
          </div>
        ) : null}

        {bulletin ? (
          <BulletinArticlePreview
            title={bulletin.title}
            category={bulletin.category}
            categoryDisplay={bulletin.category_display}
            badgeText={bulletin.badge_text}
            status={bulletin.status}
            showStatus={canManage}
            isPinned={bulletin.is_pinned}
            isRead={bulletin.is_read}
            publishedDateDisplay={bulletin.published_date_display}
            authorDisplay={bulletin.author_display}
            summary={bulletin.summary}
            contentSections={bulletin.content_sections}
            attachments={bulletin.attachments}
          />
        ) : null}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          {canManage && bulletin && onEdit ? (
            <Button
              type="button"
              variant="soft"
              size="md"
              className="min-h-11"
              data-testid="bulletin-detail-edit"
              onClick={() => onEdit(bulletin)}
            >
              Chỉnh sửa bản tin
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="md"
            className="min-h-11"
            data-testid="bulletin-detail-close"
            onClick={() => onOpenChange(false)}
          >
            Đóng
          </Button>
        </div>
      </div>
    </FormDialog>
  );
}
