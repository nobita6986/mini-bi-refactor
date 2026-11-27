"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  CheckCheck,
  Edit3,
  FileText,
  Image as ImageIcon,
  Pin,
  PinOff,
  Plus,
  Search,
  Send,
} from "lucide-react";

import { AccountUnavailable } from "@/components/auth/access-denied";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  BULLETIN_CATEGORY_FILTER_OPTIONS,
  BULLETIN_CATEGORY_LABELS,
  BULLETIN_STATUS_FILTER_OPTIONS,
  BULLETIN_STATUS_LABELS,
  EMPTY_BULLETIN_ARCHIVE_FILTERS,
  buildBulletinArchiveUrl,
  bulletinUiErrorMessage,
  classifyBulletinAccessLoss,
  createBulletinLatestRequestTracker,
  extractBulletinErrorCode,
  newIdempotencyKey,
  parseBulletinArchiveEnvelope,
  parseBulletinDetailEnvelope,
  parseBulletinMutationEnvelope,
  parseMarkAllReadEnvelope,
  parseMarkReadEnvelope,
  validateBulletinArchiveFilters,
  type BulletinAccessLossKind,
  type BulletinArchiveFilterState,
  type BulletinArchiveStatusFilter,
  type BulletinAuthorOption,
  type BulletinCategory,
  type BulletinItem,
  type LatestRequestTracker,
} from "@/lib/bulletins/bulletin-ui-model";

import {
  BulletinDetailDialog,
  bulletinStatusBadgeTone,
} from "./bulletin-detail-dialog";
import { BulletinEditorDialog } from "./bulletin-editor-dialog";

const FILTER_CONTROL_CLASS =
  "min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

const FILTER_DATE_CLASS =
  "min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm font-mono tabular-nums text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-60";

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error !== null &&
      typeof error === "object" &&
      "name" in error &&
      (error as { name?: unknown }).name === "AbortError")
  );
}

function getTracker(ref: {
  current: LatestRequestTracker | null;
}): LatestRequestTracker {
  if (!ref.current) {
    ref.current = createBulletinLatestRequestTracker();
  }
  return ref.current;
}

function createInitialFilters(canManage: boolean): BulletinArchiveFilterState {
  return {
    ...EMPTY_BULLETIN_ARCHIVE_FILTERS,
    status: canManage ? "ALL" : "",
  };
}

export function BulletinWorkspace({
  canManage = false,
}: {
  canManage?: boolean;
}) {
  const [filters, setFilters] = useState<BulletinArchiveFilterState>(() =>
    createInitialFilters(canManage),
  );
  const [qInput, setQInput] = useState("");
  const [authorInput, setAuthorInput] = useState("");

  const [items, setItems] = useState<BulletinItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [authors, setAuthors] = useState<BulletinAuthorOption[]>([]);

  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBanner, setActionBanner] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const [accessLoss, setAccessLoss] = useState<BulletinAccessLossKind | null>(null);

  const [markingAllRead, setMarkingAllRead] = useState(false);
  const [busyCardActionId, setBusyCardActionId] = useState<string | null>(null);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailBulletinId, setDetailBulletinId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<BulletinItem | null>(
    null,
  );
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<BulletinItem | null>(null);

  const listTrackerRef = useRef<LatestRequestTracker | null>(null);
  const detailTrackerRef = useRef<LatestRequestTracker | null>(null);

  const handleAccessRevoked = useCallback((kind: BulletinAccessLossKind) => {
    getTracker(listTrackerRef).cancelAll();
    getTracker(detailTrackerRef).cancelAll();
    setItems([]);
    setTotalCount(0);
    setUnreadCount(0);
    setLoading(false);
    setDetailOpen(false);
    setEditorOpen(false);
    setAccessLoss(kind);
  }, []);

  const loadArchive = useCallback(
    async (activeFilters: BulletinArchiveFilterState) => {
      const validation = validateBulletinArchiveFilters(activeFilters);
      if (!validation.ok) {
        getTracker(listTrackerRef).cancelAll();
        setLoading(false);
        setListError(validation.message);
        return;
      }

      const ticket = getTracker(listTrackerRef).begin();
      setLoading(true);
      setListError(null);
      setLiveAnnouncement("Đang tải danh sách bản tin HRPartner…");

      const url = buildBulletinArchiveUrl(activeFilters, { canManage });

      try {
        const response = await fetch(url, {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: ticket.signal,
        });
        if (!ticket.isCurrent()) return;

        const rawPayload = await response.json().catch(() => null);
        if (!ticket.isCurrent()) return;

        const errorCode = extractBulletinErrorCode(rawPayload);
        const revoked = classifyBulletinAccessLoss(response.status, errorCode);
        if (revoked) {
          handleAccessRevoked(revoked);
          return;
        }

        if (!response.ok) {
          setLoading(false);
          setListError(bulletinUiErrorMessage(errorCode));
          setLiveAnnouncement("Không thể tải danh sách bản tin.");
          return;
        }

        const parsed = parseBulletinArchiveEnvelope(rawPayload);
        if (!parsed) {
          setLoading(false);
          setListError(bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"));
          setLiveAnnouncement("Không thể tải danh sách bản tin.");
          return;
        }

        setLoading(false);
        setListError(null);
        setItems(parsed.items);
        setTotalCount(parsed.total_count);
        setUnreadCount(parsed.unread_count);
        setAuthors(parsed.authors);
        setLiveAnnouncement(
          `Đã tải ${parsed.items.length} bản tin trên trang ${parsed.page}.`,
        );
      } catch (error) {
        if (isAbortError(error) || !ticket.isCurrent()) return;
        setLoading(false);
        setListError(bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"));
        setLiveAnnouncement("Không thể tải danh sách bản tin.");
      }
    },
    [canManage, handleAccessRevoked],
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadArchive(filters);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filters, loadArchive]);

  useEffect(() => {
    return () => {
      getTracker(listTrackerRef).cancelAll();
      getTracker(detailTrackerRef).cancelAll();
    };
  }, []);

  // Debounce free-text inputs (q & author) so typing triggers archive query cleanly
  useEffect(() => {
    const trimmedQ = qInput.trim();
    const trimmedAuthor = authorInput.trim();
    if (trimmedQ === filters.q && trimmedAuthor === filters.author) {
      return;
    }
    const timer = window.setTimeout(() => {
      setFilters((prev) => {
        if (prev.q === trimmedQ && prev.author === trimmedAuthor) {
          return prev;
        }
        return {
          ...prev,
          q: trimmedQ,
          author: trimmedAuthor,
          page: 1,
        };
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [qInput, authorInput, filters.q, filters.author]);

  const handleFilterFormSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedQ = qInput.trim();
      const trimmedAuthor = authorInput.trim();
      setFilters((prev) => {
        if (prev.q === trimmedQ && prev.author === trimmedAuthor) {
          void loadArchive(prev);
          return prev;
        }
        return {
          ...prev,
          q: trimmedQ,
          author: trimmedAuthor,
          page: 1,
        };
      });
    },
    [authorInput, loadArchive, qInput],
  );

  const handleResetFilters = useCallback(() => {
    setQInput("");
    setAuthorInput("");
    setFilters(createInitialFilters(canManage));
  }, [canManage]);

  const fetchDetail = useCallback(
    async (bulletinId: string) => {
      const ticket = getTracker(detailTrackerRef).begin();
      setDetailLoading(true);
      setDetailError(null);

      const endpoint = canManage
        ? `/api/admin/bulletins/${encodeURIComponent(bulletinId)}`
        : `/api/bulletins/${encodeURIComponent(bulletinId)}`;

      try {
        const response = await fetch(endpoint, {
          method: "GET",
          cache: "no-store",
          credentials: "same-origin",
          signal: ticket.signal,
        });
        if (!ticket.isCurrent()) return;

        const rawPayload = await response.json().catch(() => null);
        if (!ticket.isCurrent()) return;

        const errorCode = extractBulletinErrorCode(rawPayload);
        const revoked = classifyBulletinAccessLoss(response.status, errorCode);
        if (revoked) {
          handleAccessRevoked(revoked);
          return;
        }

        if (!response.ok) {
          setDetailLoading(false);
          setDetailError(bulletinUiErrorMessage(errorCode));
          return;
        }

        const parsed = parseBulletinDetailEnvelope(rawPayload);
        if (!parsed) {
          setDetailLoading(false);
          setDetailError(bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"));
          return;
        }

        setDetailLoading(false);
        setDetailError(null);
        setSelectedDetail(parsed.item);
        setItems((prev) =>
          prev.map((item) =>
            item.bulletin_id === parsed.item.bulletin_id ? parsed.item : item,
          ),
        );
      } catch (error) {
        if (isAbortError(error) || !ticket.isCurrent()) return;
        setDetailLoading(false);
        setDetailError(bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"));
      }
    },
    [canManage, handleAccessRevoked],
  );

  const handleOpenDetail = useCallback(
    (item: BulletinItem) => {
      setDetailBulletinId(item.bulletin_id);
      setSelectedDetail(item);
      setDetailError(null);
      setDetailOpen(true);
      void fetchDetail(item.bulletin_id);
    },
    [fetchDetail],
  );

  const handleDetailOpenChange = useCallback((nextOpen: boolean) => {
    setDetailOpen(nextOpen);
    if (!nextOpen) {
      getTracker(detailTrackerRef).cancelAll();
      setDetailLoading(false);
      setDetailError(null);
    }
  }, []);

  const handleMarkRead = useCallback(
    async (bulletinId: string) => {
      try {
        const response = await fetch(
          `/api/bulletins/${encodeURIComponent(bulletinId)}/read`,
          {
            method: "POST",
            cache: "no-store",
            credentials: "same-origin",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: "{}",
          },
        );
        const rawPayload = await response.json().catch(() => null);
        const errorCode = extractBulletinErrorCode(rawPayload);
        const revoked = classifyBulletinAccessLoss(response.status, errorCode);
        if (revoked) {
          handleAccessRevoked(revoked);
          return;
        }
        if (!response.ok) return;

        const parsed = parseMarkReadEnvelope(rawPayload);
        if (!parsed) return;

        setUnreadCount(parsed.unread_count);
        setItems((prev) =>
          prev.map((item) =>
            item.bulletin_id === bulletinId ? { ...item, is_read: true } : item,
          ),
        );
        setSelectedDetail((prev) =>
          prev && prev.bulletin_id === bulletinId
            ? { ...prev, is_read: true }
            : prev,
        );
        setLiveAnnouncement(
          `Đã đánh dấu đã đọc bản tin. Còn ${parsed.unread_count} bản tin chưa đọc.`,
        );
      } catch {
        // Non-blocking read receipt failure
      }
    },
    [handleAccessRevoked],
  );

  const handleMarkAllRead = useCallback(async () => {
    if (markingAllRead || unreadCount === 0) return;
    setMarkingAllRead(true);
    setActionError(null);
    setActionBanner(null);

    try {
      const response = await fetch("/api/bulletins/read-all", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const rawPayload = await response.json().catch(() => null);
      const errorCode = extractBulletinErrorCode(rawPayload);
      const revoked = classifyBulletinAccessLoss(response.status, errorCode);
      if (revoked) {
        handleAccessRevoked(revoked);
        return;
      }

      if (!response.ok) {
        setActionError(bulletinUiErrorMessage(errorCode));
        return;
      }

      const parsed = parseMarkAllReadEnvelope(rawPayload);
      if (!parsed) {
        setActionError(bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"));
        return;
      }

      setUnreadCount(parsed.unread_count);
      setItems((prev) =>
        prev.map((item) =>
          item.status === undefined || item.status === "PUBLISHED"
            ? { ...item, is_read: true }
            : item,
        ),
      );
      setSelectedDetail((prev) =>
        prev && (prev.status === undefined || prev.status === "PUBLISHED")
          ? { ...prev, is_read: true }
          : prev,
      );
      setActionBanner("Đã đánh dấu tất cả bản tin là đã đọc.");
      setLiveAnnouncement("Đã đánh dấu tất cả bản tin là đã đọc.");
    } catch {
      setActionError(bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"));
    } finally {
      setMarkingAllRead(false);
    }
  }, [handleAccessRevoked, markingAllRead, unreadCount]);

  const runCardAdminMutation = useCallback(
    async (
      item: BulletinItem,
      endpointPath: string,
      bodyPayload: Record<string, unknown>,
      successMessage: string,
    ) => {
      if (!canManage || busyCardActionId !== null) return;
      setBusyCardActionId(item.bulletin_id);
      setActionError(null);
      setActionBanner(null);

      try {
        const response = await fetch(endpointPath, {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": newIdempotencyKey(),
          },
          body: JSON.stringify({
            expected_row_version: item.row_version ?? 1,
            ...bodyPayload,
          }),
        });
        const rawPayload = await response.json().catch(() => null);
        const errorCode = extractBulletinErrorCode(rawPayload);
        const revoked = classifyBulletinAccessLoss(response.status, errorCode);
        if (revoked) {
          handleAccessRevoked(revoked);
          return;
        }

        if (!response.ok) {
          setActionError(bulletinUiErrorMessage(errorCode));
          if (errorCode === "VERSION_CONFLICT") {
            void loadArchive(filters);
          }
          return;
        }

        const parsed = parseBulletinMutationEnvelope(rawPayload);
        if (!parsed) {
          setActionError(bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"));
          return;
        }

        setActionBanner(successMessage);
        setLiveAnnouncement(successMessage);
        void loadArchive(filters);
      } catch {
        setActionError(bulletinUiErrorMessage("BULLETIN_UNAVAILABLE"));
      } finally {
        setBusyCardActionId(null);
      }
    },
    [busyCardActionId, canManage, filters, handleAccessRevoked, loadArchive],
  );

  const handleOpenCreate = useCallback(() => {
    if (!canManage) return;
    setEditingItem(null);
    setEditorOpen(true);
  }, [canManage]);

  const handleOpenEdit = useCallback(
    (item: BulletinItem) => {
      if (!canManage) return;
      setDetailOpen(false);
      setEditingItem(item);
      setEditorOpen(true);
    },
    [canManage],
  );

  const handleEditorSaved = useCallback(
    (savedItem: BulletinItem, message: string) => {
      setEditorOpen(false);
      setEditingItem(null);
      setActionError(null);
      setActionBanner(message);
      setLiveAnnouncement(message);
      setSelectedDetail((prev) =>
        prev?.bulletin_id === savedItem.bulletin_id ? savedItem : prev,
      );
      void loadArchive(filters);
    },
    [filters, loadArchive],
  );

  const handleEditorMutated = useCallback(
    (mutatedItem: BulletinItem) => {
      setItems((prev) => {
        const exists = prev.some(
          (item) => item.bulletin_id === mutatedItem.bulletin_id,
        );
        return exists
          ? prev.map((item) =>
              item.bulletin_id === mutatedItem.bulletin_id ? mutatedItem : item,
            )
          : [mutatedItem, ...prev];
      });
      setSelectedDetail((prev) =>
        prev?.bulletin_id === mutatedItem.bulletin_id ? mutatedItem : prev,
      );
    },
    [],
  );

  const uniqueAuthorOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: BulletinAuthorOption[] = [];
    for (const author of authors) {
      const normalized = author.display_name.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      options.push({ ...author, display_name: normalized });
    }
    return options;
  }, [authors]);

  const selectedAuthorDropdownValue = useMemo(() => {
    const trimmed = authorInput.trim();
    if (!trimmed) return "";
    return uniqueAuthorOptions.some((opt) => opt.display_name === trimmed)
      ? trimmed
      : "__CUSTOM__";
  }, [authorInput, uniqueAuthorOptions]);

  const hasActiveFilters = Boolean(
    filters.fromDate ||
      filters.toDate ||
      filters.category ||
      filters.author ||
      filters.q ||
      (canManage && filters.status !== "" && filters.status !== "ALL"),
  );

  const pageCount = Math.max(1, Math.ceil(totalCount / filters.pageSize));

  if (accessLoss === "ACTOR_NOT_AVAILABLE") {
    return <AccountUnavailable />;
  }

  if (accessLoss === "UNAUTHENTICATED") {
    return (
      <main
        data-testid="bulletins-unauthenticated"
        className="flex min-h-full flex-1 items-center justify-center p-4"
      >
        <div
          role="alert"
          className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 text-center shadow-xs"
        >
          <h1 className="mb-2 text-lg font-semibold text-foreground">
            Phiên đăng nhập đã hết hạn
          </h1>
          <p className="mb-5 text-sm text-muted">
            Vui lòng đăng nhập lại để tiếp tục xem Bản tin HRPartner.
          </p>
          <Link
            href="/login?next=%2Fbulletins"
            className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            Đăng nhập lại
          </Link>
        </div>
      </main>
    );
  }

  return (
    <PageShell dataTestId="bulletins-workspace">
      <div
        role="status"
        aria-live="polite"
        className="sr-only"
        data-testid="bulletins-live-status"
      >
        {liveAnnouncement}
      </div>

      <PageHeader
        eyebrow="Lưu trữ vĩnh viễn · HRPartner"
        title="Bản tin HRPartner"
        badge={
          <StatusBadge
            tone={unreadCount > 0 ? "primary" : "neutral"}
            dot={unreadCount > 0}
            dataTestId="bulletins-unread-badge"
          >
            {unreadCount > 0
              ? `${unreadCount} chưa đọc`
              : "Không có tin chưa đọc"}
          </StatusBadge>
        }
        description="Tra cứu toàn bộ bản tin nhân sự, lịch nghỉ lễ, quy định vận hành và thông báo nội bộ đã lưu trữ lâu dài."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="md"
              className="min-h-11"
              loading={markingAllRead}
              disabled={markingAllRead || unreadCount === 0 || loading}
              data-testid="bulletins-mark-all-read"
              onClick={() => {
                void handleMarkAllRead();
              }}
            >
              <CheckCheck className="h-4 w-4" aria-hidden="true" />
              <span>Đánh dấu tất cả đã đọc</span>
            </Button>
            {canManage ? (
              <Button
                type="button"
                variant="primary"
                size="md"
                className="min-h-11"
                data-testid="bulletins-create-button"
                onClick={handleOpenCreate}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>Tạo bản tin mới</span>
              </Button>
            ) : null}
          </div>
        }
      />

      {actionBanner ? (
        <StatusBanner
          tone="success"
          dataTestId="bulletins-action-success"
          onDismiss={() => setActionBanner(null)}
        >
          {actionBanner}
        </StatusBanner>
      ) : null}

      {actionError ? (
        <StatusBanner
          tone="error"
          title="Không thể thực hiện thao tác"
          dataTestId="bulletins-action-error"
          onDismiss={() => setActionError(null)}
        >
          {actionError}
        </StatusBanner>
      ) : null}

      <search aria-label="Tìm kiếm và lọc bản tin HRPartner">
        <form onSubmit={handleFilterFormSubmit}>
          <FilterToolbar
            dataTestId="bulletins-filter-toolbar"
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="submit"
                  variant="primary"
                  size="md"
                  className="min-h-11"
                  data-testid="bulletins-filter-submit"
                >
                  <Search className="h-4 w-4" aria-hidden="true" />
                  <span>Tìm kiếm</span>
                </Button>
                {hasActiveFilters ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    className="min-h-11"
                    data-testid="bulletins-clear-filters"
                    onClick={handleResetFilters}
                  >
                    Xóa bộ lọc
                  </Button>
                ) : null}
              </div>
            }
            summary={
              <span>
                Hiển thị{" "}
                <strong className="font-mono tabular-nums text-foreground">
                  {items.length}
                </strong>{" "}
                /{" "}
                <strong className="font-mono tabular-nums text-foreground">
                  {totalCount}
                </strong>{" "}
                bản tin trong kho lưu trữ.
              </span>
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="bulletins-filter-from-date"
                  className="font-medium text-muted"
                >
                  Từ ngày phát hành
                </label>
                <input
                  id="bulletins-filter-from-date"
                  data-testid="bulletins-filter-from-date"
                  type="date"
                  value={filters.fromDate}
                  max={filters.toDate || undefined}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      fromDate: event.target.value,
                      page: 1,
                    }))
                  }
                  className={FILTER_DATE_CLASS}
                />
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="bulletins-filter-to-date"
                  className="font-medium text-muted"
                >
                  Đến ngày phát hành
                </label>
                <input
                  id="bulletins-filter-to-date"
                  data-testid="bulletins-filter-to-date"
                  type="date"
                  value={filters.toDate}
                  min={filters.fromDate || undefined}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      toDate: event.target.value,
                      page: 1,
                    }))
                  }
                  className={FILTER_DATE_CLASS}
                />
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="bulletins-filter-category"
                  className="font-medium text-muted"
                >
                  Chuyên mục
                </label>
                <select
                  id="bulletins-filter-category"
                  data-testid="bulletins-filter-category"
                  value={filters.category}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      category: event.target.value as BulletinCategory | "",
                      page: 1,
                    }))
                  }
                  className={FILTER_CONTROL_CLASS}
                >
                  {BULLETIN_CATEGORY_FILTER_OPTIONS.map((opt) => (
                    <option key={opt.value || "ALL"} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="bulletins-filter-author-select"
                  className="font-medium text-muted"
                >
                  Người / Bộ phận phát hành
                </label>
                <select
                  id="bulletins-filter-author-select"
                  data-testid="bulletins-filter-author-select"
                  value={selectedAuthorDropdownValue}
                  onChange={(event) => {
                    const nextVal = event.target.value;
                    if (nextVal === "__CUSTOM__") return;
                    setAuthorInput(nextVal);
                    setFilters((prev) => ({
                      ...prev,
                      author: nextVal,
                      page: 1,
                    }));
                  }}
                  className={FILTER_CONTROL_CLASS}
                >
                  <option value="">Tất cả người phát hành</option>
                  {uniqueAuthorOptions.map((author) => (
                    <option key={author.app_user_id} value={author.display_name}>
                      {author.display_name}
                    </option>
                  ))}
                  {selectedAuthorDropdownValue === "__CUSTOM__" ? (
                    <option value="__CUSTOM__">
                      Tùy chỉnh: {authorInput.trim()}
                    </option>
                  ) : null}
                </select>
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="bulletins-filter-author"
                  className="font-medium text-muted"
                >
                  Lọc tên người phát hành
                </label>
                <input
                  id="bulletins-filter-author"
                  data-testid="bulletins-filter-author"
                  type="text"
                  maxLength={160}
                  value={authorInput}
                  onChange={(event) => setAuthorInput(event.target.value)}
                  placeholder="Nhập tên phòng ban / tác giả…"
                  className={FILTER_CONTROL_CLASS}
                />
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="bulletins-filter-q"
                  className="font-medium text-muted"
                >
                  Từ khóa (Tiêu đề / Nội dung)
                </label>
                <input
                  id="bulletins-filter-q"
                  data-testid="bulletins-filter-q"
                  type="search"
                  maxLength={200}
                  value={qInput}
                  onChange={(event) => setQInput(event.target.value)}
                  placeholder="Tìm tiêu đề, tóm tắt, nội dung…"
                  className={FILTER_CONTROL_CLASS}
                />
              </div>

              {canManage ? (
                <div className="flex min-w-0 flex-col gap-1 text-sm sm:col-span-2 lg:col-span-1">
                  <label
                    htmlFor="bulletins-filter-status"
                    className="font-medium text-muted"
                  >
                    Trạng thái (Quản trị)
                  </label>
                  <select
                    id="bulletins-filter-status"
                    data-testid="bulletins-filter-status"
                    value={filters.status || "ALL"}
                    onChange={(event) =>
                      setFilters((prev) => ({
                        ...prev,
                        status: event.target.value as BulletinArchiveStatusFilter,
                        page: 1,
                      }))
                    }
                    className={FILTER_CONTROL_CLASS}
                  >
                    {BULLETIN_STATUS_FILTER_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
          </FilterToolbar>
        </form>
      </search>

      {listError ? (
        <StatusBanner
          tone="error"
          title="Không thể tải danh sách bản tin"
          dataTestId="bulletins-list-error"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{listError}</span>
            <Button
              type="button"
              variant="secondary"
              size="md"
              className="min-h-11"
              data-testid="bulletins-list-retry"
              onClick={() => {
                void loadArchive(filters);
              }}
            >
              Thử lại
            </Button>
          </div>
        </StatusBanner>
      ) : null}

      {loading ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="bulletins-loading"
          className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-muted"
        >
          Đang tải danh sách bản tin HRPartner…
        </div>
      ) : null}

      {!loading && !listError && items.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          data-testid="bulletins-empty"
          className="rounded-xl border border-border bg-surface p-8 text-center space-y-3"
        >
          <p className="text-sm font-medium text-foreground">
            {hasActiveFilters
              ? "Không có bản tin nào khớp với điều kiện lọc hiện tại."
              : "Hiện chưa có bản tin nào trong hệ thống lưu trữ."}
          </p>
          {hasActiveFilters ? (
            <div>
              <Button
                type="button"
                variant="secondary"
                size="md"
                className="min-h-11"
                onClick={handleResetFilters}
              >
                Xóa bộ lọc
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {!loading && items.length > 0 ? (
        <div className="space-y-4">
          <div
            data-testid="bulletins-list"
            className="grid grid-cols-1 gap-4 md:grid-cols-2"
          >
            {items.map((item) => {
              const isUnread =
                item.is_read === false &&
                (item.status === undefined || item.status === "PUBLISHED");
              const isBusyCard = busyCardActionId === item.bulletin_id;
              const imageCount =
                item.attachment_summary?.image_count ?? item.image_count ?? 0;
              const pdfCount =
                item.attachment_summary?.pdf_count ?? item.pdf_count ?? 0;
              const previewText =
                item.summary.trim() || item.content_sections[0] || "";

              return (
                <Card
                  key={item.bulletin_id}
                  className={`flex h-full flex-col justify-between gap-4 rounded-[16px] border-border bg-surface p-4 sm:p-5 shadow-[var(--shadow-card)] transition-[border-color,box-shadow] hover:border-[var(--line-strong)] hover:shadow-[var(--shadow-card-hover)] ${
                    isUnread ? "border-l-4 border-l-primary" : ""
                  }`}
                >
                  <article
                    data-testid={`bulletin-card-${item.bulletin_id}`}
                    className="flex h-full flex-col justify-between gap-4"
                  >
                    <div className="space-y-3">
                      {/* Chips row */}
                      <div className="flex flex-wrap items-center gap-1.5">
                        {isUnread ? (
                          <StatusBadge
                            tone="primary"
                            dot
                            dataTestId={`bulletin-unread-dot-${item.bulletin_id}`}
                          >
                            Chưa đọc
                          </StatusBadge>
                        ) : null}
                        {item.is_pinned ? (
                          <StatusBadge
                            tone="warning"
                            dataTestId={`bulletin-pinned-badge-${item.bulletin_id}`}
                          >
                            <Pin className="h-3 w-3" aria-hidden="true" />
                            <span>Đã ghim</span>
                          </StatusBadge>
                        ) : null}
                        <StatusBadge tone="info">
                          {item.category_display ||
                            BULLETIN_CATEGORY_LABELS[item.category]}
                        </StatusBadge>
                        {item.badge_text ? (
                          <StatusBadge tone="primary">
                            {item.badge_text}
                          </StatusBadge>
                        ) : null}
                        {canManage && item.status ? (
                          <StatusBadge
                            tone={bulletinStatusBadgeTone(item.status)}
                            dot={item.status === "PUBLISHED"}
                            dataTestId={`bulletin-status-badge-${item.bulletin_id}`}
                          >
                            {BULLETIN_STATUS_LABELS[item.status]}
                          </StatusBadge>
                        ) : null}
                      </div>

                      {/* Title */}
                      <h2 className="text-base font-semibold tracking-tight text-[var(--navy)] sm:text-lg leading-snug break-words">
                        <button
                          type="button"
                          onClick={() => handleOpenDetail(item)}
                          className="min-h-11 w-full text-left hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-md"
                        >
                          {item.title}
                        </button>
                      </h2>

                      {/* Metadata */}
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                        <span className="font-mono tabular-nums">
                          {item.published_date_display || "Chưa xuất bản"}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="break-words">{item.author_display}</span>
                      </div>

                      {/* Summary / Snippet */}
                      {previewText ? (
                        <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-line break-words line-clamp-3">
                          {previewText}
                        </p>
                      ) : null}

                      {/* Attachment summary */}
                      {imageCount > 0 || pdfCount > 0 ? (
                        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                          {imageCount > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-muted px-2.5 py-1 font-medium text-foreground">
                              <ImageIcon
                                className="h-3.5 w-3.5 text-primary"
                                aria-hidden="true"
                              />
                              <span>{imageCount} ảnh</span>
                            </span>
                          ) : null}
                          {pdfCount > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-muted px-2.5 py-1 font-medium text-foreground">
                              <FileText
                                className="h-3.5 w-3.5 text-primary"
                                aria-hidden="true"
                              />
                              <span>{pdfCount} PDF</span>
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    {/* Actions */}
                    <div className="flex flex-wrap items-center gap-2 border-t border-border/80 pt-3">
                      <Button
                        type="button"
                        variant="soft"
                        size="md"
                        className="min-h-11"
                        data-testid={`bulletin-view-detail-${item.bulletin_id}`}
                        onClick={() => handleOpenDetail(item)}
                      >
                        Xem chi tiết
                      </Button>

                      {canManage ? (
                        <>
                          <Button
                            type="button"
                            variant="secondary"
                            size="md"
                            className="min-h-11"
                            disabled={isBusyCard}
                            data-testid={`bulletin-edit-${item.bulletin_id}`}
                            onClick={() => handleOpenEdit(item)}
                          >
                            <Edit3 className="h-4 w-4" aria-hidden="true" />
                            <span>Sửa</span>
                          </Button>
                          <Button
                            type="button"
                            variant="secondary"
                            size="md"
                            className="min-h-11"
                            disabled={isBusyCard}
                            data-testid={`bulletin-pin-toggle-${item.bulletin_id}`}
                            onClick={() => {
                              void runCardAdminMutation(
                                item,
                                `/api/admin/bulletins/${encodeURIComponent(item.bulletin_id)}/pin`,
                                { is_pinned: !item.is_pinned },
                                item.is_pinned
                                  ? "Đã bỏ ghim bản tin."
                                  : "Đã ghim bản tin lên đầu danh sách.",
                              );
                            }}
                          >
                            {item.is_pinned ? (
                              <PinOff className="h-4 w-4" aria-hidden="true" />
                            ) : (
                              <Pin className="h-4 w-4" aria-hidden="true" />
                            )}
                            <span>{item.is_pinned ? "Bỏ ghim" : "Ghim"}</span>
                          </Button>
                          {item.status !== "PUBLISHED" ? (
                            <Button
                              type="button"
                              variant="primary"
                              size="md"
                              className="min-h-11"
                              disabled={isBusyCard}
                              data-testid={`bulletin-publish-${item.bulletin_id}`}
                              onClick={() => {
                                void runCardAdminMutation(
                                  item,
                                  `/api/admin/bulletins/${encodeURIComponent(item.bulletin_id)}/publish`,
                                  {},
                                  "Đã xuất bản bản tin.",
                                );
                              }}
                            >
                              <Send className="h-4 w-4" aria-hidden="true" />
                              <span>Xuất bản</span>
                            </Button>
                          ) : null}
                          {item.status !== "ARCHIVED" ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="md"
                              className="min-h-11"
                              disabled={isBusyCard}
                              data-testid={`bulletin-archive-${item.bulletin_id}`}
                              onClick={() => {
                                void runCardAdminMutation(
                                  item,
                                  `/api/admin/bulletins/${encodeURIComponent(item.bulletin_id)}/archive`,
                                  {},
                                  "Đã lưu trữ bản tin.",
                                );
                              }}
                            >
                              <Archive className="h-4 w-4" aria-hidden="true" />
                              <span>Lưu trữ</span>
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                  </article>
                </Card>
              );
            })}
          </div>

          <OffsetPager
            page={filters.page}
            pageCount={pageCount}
            total={totalCount}
            disabled={loading}
            ariaLabel="Phân trang kho lưu trữ bản tin"
            onPageChange={(nextPage) =>
              setFilters((prev) => ({
                ...prev,
                page: nextPage,
              }))
            }
          />
        </div>
      ) : null}

      <BulletinDetailDialog
        open={detailOpen}
        onOpenChange={handleDetailOpenChange}
        bulletin={selectedDetail}
        loading={detailLoading}
        error={detailError}
        onRetry={
          detailBulletinId
            ? () => {
                void fetchDetail(detailBulletinId);
              }
            : undefined
        }
        onMarkRead={handleMarkRead}
        canManage={canManage}
        onEdit={canManage ? handleOpenEdit : undefined}
      />

      {canManage ? (
        <BulletinEditorDialog
          open={editorOpen}
          onOpenChange={(nextOpen) => {
            setEditorOpen(nextOpen);
            if (!nextOpen) {
              setEditingItem(null);
            }
          }}
          editingItem={editingItem}
          onSaved={handleEditorSaved}
          onBulletinMutated={handleEditorMutated}
          onReloadConflict={() => {
            void loadArchive(filters);
          }}
          onAccessRevoked={handleAccessRevoked}
        />
      ) : null}
    </PageShell>
  );
}
