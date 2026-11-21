"use client";

import Link from "next/link";
import {
  useRouter as readNextAppRouter,
  useSearchParams,
} from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import { AccessDenied, AccountUnavailable } from "@/components/auth/access-denied";
import { Button } from "@/components/ui/button";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
  EMPTY_RECRUITMENT_POST_FILTERS,
  RECRUITMENT_POST_FEED_TABS,
  RECRUITMENT_POST_FEED_TAB_LABELS,
  applyIndustrialParkFilterChange,
  applyProvinceFilterChange,
  applyRecruitmentPostFirstPageOutcome,
  applyWithdrawnPostToFeedItems,
  beginRecruitmentPostContextRequest,
  buildRecruitmentPostFeedTabHref,
  buildRecruitmentPostListUrl,
  buildRecruitmentPostMineListUrl,
  canRepostWithdrawnRecruitmentPost,
  classifyRecruitmentPostAccessLoss,
  clearRecruitmentPostFeedItemsPreservingContext,
  createEmptyRecruitmentPostDataState,
  createLatestRequestTracker,
  exportRecruitmentPostDetailMarkdown,
  extractRecruitmentPostErrorCode,
  hasActiveRecruitmentPostFilters,
  mergeUniqueRecruitmentPostItems,
  parseRecruitmentPostDetailEnvelope,
  parseRecruitmentPostFeedTab,
  parseRecruitmentPostListEnvelope,
  recruitmentPostContextErrorMessage,
  recruitmentPostErrorMessage,
  resolveRecruitmentPostContextOutcome,
  resolveRecruitmentPostListOutcome,
  settleRecruitmentPostContextRequest,
  toRecruitmentPostCardViewModel,
  toRecruitmentPostDetailViewModel,
  validateRecruitmentPostFeedFilters,
  visibleIndustrialParksForFilter,
  visibleLaborTypesForFilter,
  visibleProvincesForFilter,
  type LatestRequestTracker,
  type RecruitmentPostAccessLossKind,
  type RecruitmentPostCardViewModel,
  type RecruitmentPostContextRequestState,
  type RecruitmentPostDataState,
  type RecruitmentPostDetailViewModel,
  type RecruitmentPostFeedFilterState,
  type RecruitmentPostFeedTab,
  type RecruitmentPostItem,
  type RecruitmentPostMarkdownExportFile,
} from "@/lib/recruitment-posts/recruitment-post-ui-model";

import { RecruitmentPostCard } from "./recruitment-post-card";
import { RecruitmentPostDetailDialog } from "./recruitment-post-detail-dialog";
import {
  RecruitmentPostWithdrawDialog,
  type RecruitmentPostWithdrawTarget,
} from "./recruitment-post-withdraw-dialog";

function getOptionalAppRouter() {
  try {
    return readNextAppRouter();
  } catch {
    return null;
  }
}

const FILTER_SELECT_CLASS =
  "h-11 w-full rounded-lg border border-border bg-surface px-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60";

const FILTER_DATE_INPUT_CLASS =
  "h-11 w-full rounded-lg border border-border bg-surface px-2.5 text-sm font-mono tabular-nums text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60";

function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function getRequestTracker(
  ref: { current: LatestRequestTracker | null },
): LatestRequestTracker {
  if (!ref.current) {
    ref.current = createLatestRequestTracker();
  }
  return ref.current;
}

function triggerBrowserMarkdownDownload(
  file: RecruitmentPostMarkdownExportFile,
): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const blob = new Blob([file.content], { type: file.mimeType });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = file.filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

export type RecruitmentPostExportErrorState = {
  readonly briefId: string;
  readonly message: string;
};

export type RecruitmentPostFeedWorkspaceInitialTestState = {
  readonly activeTab?: RecruitmentPostFeedTab;
  readonly loadedTab?: RecruitmentPostFeedTab | null;
  readonly filters?: RecruitmentPostFeedFilterState;
  readonly dataState?: RecruitmentPostDataState;
  readonly accessLoss?: RecruitmentPostAccessLossKind | null;
  readonly contextLoading?: boolean;
  readonly contextError?: string | null;
  readonly initialLoading?: boolean;
  readonly loadingMore?: boolean;
  readonly feedError?: string | null;
  readonly loadMoreError?: string | null;
  readonly detailLoading?: boolean;
  readonly exportingBriefId?: string | null;
  readonly exportError?: RecruitmentPostExportErrorState | null;
  readonly withdrawTarget?: RecruitmentPostWithdrawTarget | null;
  readonly withdrawSuccessBanner?: string | null;
};

export function RecruitmentPostFeedWorkspace({
  initialTab,
  initialStateForTest,
}: {
  initialTab?: RecruitmentPostFeedTab;
  initialStateForTest?: RecruitmentPostFeedWorkspaceInitialTestState;
} = {}) {
  const router = getOptionalAppRouter();
  const searchParams = useSearchParams();
  const hasLiveSearchParams =
    searchParams !== null && initialStateForTest?.activeTab === undefined;
  const searchTabParam = searchParams?.get("tab");

  const [localTab, setLocalTab] = useState<RecruitmentPostFeedTab>(() => {
    if (initialStateForTest?.activeTab) {
      return initialStateForTest.activeTab;
    }
    if (initialTab) {
      return initialTab;
    }
    return parseRecruitmentPostFeedTab(searchTabParam);
  });
  const activeTab: RecruitmentPostFeedTab = hasLiveSearchParams
    ? parseRecruitmentPostFeedTab(searchTabParam)
    : localTab;
  const [loadedTab, setLoadedTab] = useState<RecruitmentPostFeedTab | null>(
    () => {
      if (initialStateForTest) {
        return initialStateForTest.loadedTab !== undefined
          ? initialStateForTest.loadedTab
          : activeTab;
      }
      return null;
    },
  );
  const [isTabTransitionPending, startTabTransition] = useTransition();
  const isTabMismatch = loadedTab !== activeTab;
  const [filters, setFilters] = useState<RecruitmentPostFeedFilterState>(
    () => initialStateForTest?.filters ?? EMPTY_RECRUITMENT_POST_FILTERS,
  );
  const [dataState, setDataState] = useState<RecruitmentPostDataState>(() =>
    initialStateForTest?.dataState ?? createEmptyRecruitmentPostDataState(),
  );
  const [accessLoss, setAccessLoss] =
    useState<RecruitmentPostAccessLossKind | null>(
      () => initialStateForTest?.accessLoss ?? null,
    );
  const [contextRequestState, setContextRequestState] =
    useState<RecruitmentPostContextRequestState>(() => ({
      contextLoading: initialStateForTest?.contextLoading ?? true,
      contextError: initialStateForTest?.contextError ?? null,
    }));
  const { contextLoading, contextError } = contextRequestState;
  const [initialLoading, setInitialLoading] = useState<boolean>(
    () => initialStateForTest?.initialLoading ?? true,
  );
  const [loadingMore, setLoadingMore] = useState<boolean>(
    () => initialStateForTest?.loadingMore ?? false,
  );
  const [feedError, setFeedError] = useState<string | null>(
    () => initialStateForTest?.feedError ?? null,
  );
  const [loadMoreError, setLoadMoreError] = useState<string | null>(
    () => initialStateForTest?.loadMoreError ?? null,
  );
  const [detailLoading, setDetailLoading] = useState<boolean>(
    () => initialStateForTest?.detailLoading ?? false,
  );
  const [exportingBriefId, setExportingBriefId] = useState<string | null>(
    () => initialStateForTest?.exportingBriefId ?? null,
  );
  const [exportError, setExportError] =
    useState<RecruitmentPostExportErrorState | null>(
      () => initialStateForTest?.exportError ?? null,
    );
  const [withdrawTarget, setWithdrawTarget] =
    useState<RecruitmentPostWithdrawTarget | null>(
      () => initialStateForTest?.withdrawTarget ?? null,
    );
  const [withdrawSuccessBanner, setWithdrawSuccessBanner] = useState<
    string | null
  >(() => initialStateForTest?.withdrawSuccessBanner ?? null);

  const contextTrackerRef = useRef<LatestRequestTracker | null>(null);
  const feedTrackerRef = useRef<LatestRequestTracker | null>(null);
  const detailTrackerRef = useRef<LatestRequestTracker | null>(null);
  const exportTrackerRef = useRef<LatestRequestTracker | null>(null);

  const handleAccessRevoked = useCallback(
    (lossKind: RecruitmentPostAccessLossKind) => {
      getRequestTracker(contextTrackerRef).cancelAll();
      getRequestTracker(feedTrackerRef).cancelAll();
      getRequestTracker(detailTrackerRef).cancelAll();
      getRequestTracker(exportTrackerRef).cancelAll();
      setDataState(createEmptyRecruitmentPostDataState());
      setContextRequestState({
        contextLoading: false,
        contextError: null,
      });
      setInitialLoading(false);
      setLoadingMore(false);
      setDetailLoading(false);
      setExportingBriefId(null);
      setExportError(null);
      setFeedError(null);
      setLoadMoreError(null);
      setWithdrawTarget(null);
      setWithdrawSuccessBanner(null);
      setAccessLoss(lossKind);
    },
    [],
  );

  const loadContext = useCallback(async () => {
    const ticket = getRequestTracker(contextTrackerRef).begin();
    setContextRequestState((prev) => beginRecruitmentPostContextRequest(prev));

    try {
      const response = await fetch("/api/recruitment-posts/context", {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: ticket.signal,
      });
      if (!ticket.isCurrent()) return;

      const rawPayload = await response.json().catch(() => null);
      if (!ticket.isCurrent()) return;

      const outcome = resolveRecruitmentPostContextOutcome({
        status: response.status,
        payload: rawPayload,
      });

      if (outcome.kind === "access_loss") {
        handleAccessRevoked(outcome.accessLoss);
        return;
      }

      setContextRequestState(settleRecruitmentPostContextRequest(outcome));

      if (outcome.kind === "error") {
        setDataState((prev) => ({
          ...prev,
          context: null,
        }));
        return;
      }

      setDataState((prev) => ({
        ...prev,
        context: outcome.context,
      }));
    } catch (error) {
      if (isAbortError(error) || !ticket.isCurrent()) return;
      setContextRequestState(
        settleRecruitmentPostContextRequest({
          kind: "error",
          code: "RECRUITMENT_POST_UNAVAILABLE",
          message: recruitmentPostContextErrorMessage(
            "RECRUITMENT_POST_UNAVAILABLE",
          ),
        }),
      );
      setDataState((prev) => ({
        ...prev,
        context: null,
      }));
    }
  }, [handleAccessRevoked]);

  const tabButtonRefs = useRef<
    Record<RecruitmentPostFeedTab, HTMLButtonElement | null>
  >({
    published: null,
    mine: null,
  });

  const showFeedLoading =
    initialLoading || isTabMismatch || isTabTransitionPending;

  const handleSelectTab = useCallback(
    (nextTab: RecruitmentPostFeedTab, focusButton = false) => {
      if (focusButton) {
        tabButtonRefs.current[nextTab]?.focus();
      }
      if (hasLiveSearchParams) {
        if (nextTab === activeTab && !isTabTransitionPending) return;
        const href = buildRecruitmentPostFeedTabHref(nextTab);
        startTabTransition(() => {
          if (router) {
            router.push(href, { scroll: false });
          } else if (
            typeof window !== "undefined" &&
            window.history?.pushState
          ) {
            window.history.pushState(null, "", href);
          }
        });
        return;
      }
      if (nextTab === activeTab) return;
      getRequestTracker(feedTrackerRef).cancelAll();
      getRequestTracker(detailTrackerRef).cancelAll();
      setDetailLoading(false);
      setLoadingMore(false);
      setWithdrawTarget(null);
      setWithdrawSuccessBanner(null);
      setExportError(null);
      setFeedError(null);
      setLoadMoreError(null);
      setLocalTab(nextTab);
      const href = buildRecruitmentPostFeedTabHref(nextTab);
      if (router) {
        router.push(href, { scroll: false });
      } else if (typeof window !== "undefined" && window.history?.pushState) {
        window.history.pushState(null, "", href);
      }
    },
    [activeTab, hasLiveSearchParams, isTabTransitionPending, router],
  );

  const handleTabKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLButtonElement>,
      currentTab: RecruitmentPostFeedTab,
    ) => {
      const currentIndex = RECRUITMENT_POST_FEED_TABS.indexOf(currentTab);
      if (currentIndex < 0) return;

      if (event.key === "ArrowRight") {
        event.preventDefault();
        const nextIndex =
          (currentIndex + 1) % RECRUITMENT_POST_FEED_TABS.length;
        handleSelectTab(RECRUITMENT_POST_FEED_TABS[nextIndex], true);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        const prevIndex =
          (currentIndex - 1 + RECRUITMENT_POST_FEED_TABS.length) %
          RECRUITMENT_POST_FEED_TABS.length;
        handleSelectTab(RECRUITMENT_POST_FEED_TABS[prevIndex], true);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        handleSelectTab(RECRUITMENT_POST_FEED_TABS[0], true);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        handleSelectTab(
          RECRUITMENT_POST_FEED_TABS[RECRUITMENT_POST_FEED_TABS.length - 1],
          true,
        );
      }
    },
    [handleSelectTab],
  );

  const loadFirstPage = useCallback(
    async (
      activeFilters: RecruitmentPostFeedFilterState,
      tab: RecruitmentPostFeedTab,
    ) => {
      getRequestTracker(detailTrackerRef).cancelAll();
      setDetailLoading(false);
      setWithdrawTarget(null);
      setWithdrawSuccessBanner(null);
      setExportError(null);

      if (tab === "published") {
        const validation = validateRecruitmentPostFeedFilters(activeFilters);
        if (!validation.ok) {
          getRequestTracker(feedTrackerRef).cancelAll();
          setLoadedTab(tab);
          setInitialLoading(false);
          setLoadingMore(false);
          setFeedError(validation.message);
          setLoadMoreError(null);
          setDataState((prev) =>
            clearRecruitmentPostFeedItemsPreservingContext(prev),
          );
          return;
        }
      }

      const ticket = getRequestTracker(feedTrackerRef).begin();

      setInitialLoading(true);
      setLoadingMore(false);
      setFeedError(null);
      setLoadMoreError(null);
      setDataState((prev) =>
        clearRecruitmentPostFeedItemsPreservingContext(prev),
      );

      const url =
        tab === "mine"
          ? buildRecruitmentPostMineListUrl({
              pageSize: DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
            })
          : buildRecruitmentPostListUrl(activeFilters, {
              pageSize: DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
            });

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

        const outcome = resolveRecruitmentPostListOutcome({
          status: response.status,
          payload: rawPayload,
        });

        if (outcome.kind === "access_loss") {
          handleAccessRevoked(outcome.accessLoss);
          return;
        }

        if (outcome.kind === "error") {
          setLoadedTab(tab);
          setInitialLoading(false);
          setFeedError(outcome.message);
          setDataState((prev) =>
            applyRecruitmentPostFirstPageOutcome(prev, outcome),
          );
          return;
        }

        setAccessLoss(null);
        setLoadedTab(tab);
        setInitialLoading(false);
        setFeedError(null);
        setDataState((prev) =>
          applyRecruitmentPostFirstPageOutcome(prev, outcome),
        );
      } catch (error) {
        if (isAbortError(error) || !ticket.isCurrent()) return;
        setLoadedTab(tab);
        setInitialLoading(false);
        setFeedError(
          recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
        );
        setDataState((prev) =>
          clearRecruitmentPostFeedItemsPreservingContext(prev),
        );
      }
    },
    [handleAccessRevoked],
  );

  const handleLoadMore = useCallback(async () => {
    if (
      showFeedLoading ||
      loadingMore ||
      !dataState.hasMore ||
      !dataState.nextCursor ||
      !dataState.snapshotToken
    ) {
      return;
    }

    const ticket = getRequestTracker(feedTrackerRef).begin();

    setLoadingMore(true);
    setLoadMoreError(null);

    const url =
      activeTab === "mine"
        ? buildRecruitmentPostMineListUrl({
            cursor: dataState.nextCursor,
            snapshotToken: dataState.snapshotToken,
            pageSize: DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
          })
        : buildRecruitmentPostListUrl(filters, {
            cursor: dataState.nextCursor,
            snapshotToken: dataState.snapshotToken,
            pageSize: DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
          });

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

      const errorCode = extractRecruitmentPostErrorCode(rawPayload);
      const revoked = classifyRecruitmentPostAccessLoss(
        response.status,
        errorCode,
      );
      if (revoked) {
        handleAccessRevoked(revoked);
        return;
      }

      if (!response.ok) {
        setLoadingMore(false);
        setLoadMoreError(recruitmentPostErrorMessage(errorCode));
        return;
      }

      const parsedList = parseRecruitmentPostListEnvelope(rawPayload);
      if (!parsedList) {
        setLoadingMore(false);
        setLoadMoreError(
          recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
        );
        return;
      }

      setLoadingMore(false);
      setLoadMoreError(null);
      setDataState((prev) => ({
        ...prev,
        items: mergeUniqueRecruitmentPostItems(prev.items, parsedList.items),
        nextCursor: parsedList.next_cursor,
        snapshotToken: parsedList.snapshot_token,
        hasMore: parsedList.has_more && parsedList.next_cursor !== null,
      }));
    } catch (error) {
      if (isAbortError(error) || !ticket.isCurrent()) return;
      setLoadingMore(false);
      setLoadMoreError(
        recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
      );
    }
  }, [
    activeTab,
    dataState.hasMore,
    dataState.nextCursor,
    dataState.snapshotToken,
    filters,
    handleAccessRevoked,
    showFeedLoading,
    loadingMore,
  ]);

  const fetchDetail = useCallback(
    async (briefId: string) => {
      const ticket = getRequestTracker(detailTrackerRef).begin();

      setDetailLoading(true);
      setDataState((prev) => ({
        ...prev,
        detailError: null,
      }));

      try {
        const response = await fetch(
          `/api/recruitment-posts/${encodeURIComponent(briefId)}`,
          {
            method: "GET",
            cache: "no-store",
            credentials: "same-origin",
            signal: ticket.signal,
          },
        );
        if (!ticket.isCurrent()) return;

        const rawPayload = await response.json().catch(() => null);
        if (!ticket.isCurrent()) return;

        const errorCode = extractRecruitmentPostErrorCode(rawPayload);
        const revoked = classifyRecruitmentPostAccessLoss(
          response.status,
          errorCode,
        );
        if (revoked) {
          handleAccessRevoked(revoked);
          return;
        }

        if (!response.ok) {
          setDetailLoading(false);
          setDataState((prev) => ({
            ...prev,
            selectedDetail:
              response.status === 404 ? null : prev.selectedDetail,
            items:
              response.status === 404
                ? prev.items.filter((item) => item.brief_id !== briefId)
                : prev.items,
            detailError: recruitmentPostErrorMessage(errorCode),
          }));
          return;
        }

        const parsedDetail = parseRecruitmentPostDetailEnvelope(rawPayload);
        if (!parsedDetail) {
          setDetailLoading(false);
          setDataState((prev) => ({
            ...prev,
            detailError: recruitmentPostErrorMessage(
              "RECRUITMENT_POST_UNAVAILABLE",
            ),
          }));
          return;
        }

        setDetailLoading(false);
        setDataState((prev) => ({
          ...prev,
          selectedDetail: parsedDetail.post,
          detailError: null,
          items: prev.items.map((item) =>
            item.brief_id === parsedDetail.post.brief_id
              ? parsedDetail.post
              : item,
          ),
        }));
      } catch (error) {
        if (isAbortError(error) || !ticket.isCurrent()) return;
        setDetailLoading(false);
        setDataState((prev) => ({
          ...prev,
          detailError: recruitmentPostErrorMessage(
            "RECRUITMENT_POST_UNAVAILABLE",
          ),
        }));
      }
    },
    [handleAccessRevoked],
  );

  const handleOpenDetail = useCallback(
    (briefId: string) => {
      setDataState((prev) => {
        const existingItem =
          prev.items.find((item) => item.brief_id === briefId) ?? null;
        return {
          ...prev,
          detailOpen: true,
          detailBriefId: briefId,
          selectedDetail: existingItem,
          detailError: null,
        };
      });
      void fetchDetail(briefId);
    },
    [fetchDetail],
  );

  const handleDetailOpenChange = useCallback((open: boolean) => {
    if (!open) {
      getRequestTracker(detailTrackerRef).cancelAll();
      setDetailLoading(false);
      setDataState((prev) => ({
        ...prev,
        detailOpen: false,
        detailBriefId: null,
        selectedDetail: null,
        detailError: null,
      }));
    }
  }, []);

  const handleRetryDetail = useCallback(() => {
    if (!dataState.detailBriefId) return;
    void fetchDetail(dataState.detailBriefId);
  }, [dataState.detailBriefId, fetchDetail]);

  const handleExportPost = useCallback(
    async (briefId: string) => {
      if (exportingBriefId !== null) return;

      const ticket = getRequestTracker(exportTrackerRef).begin();
      setExportingBriefId(briefId);
      setExportError(null);

      const outcome = await exportRecruitmentPostDetailMarkdown({
        briefId,
        signal: ticket.signal,
        onDownload: (file) => {
          if (!ticket.isCurrent()) return;
          triggerBrowserMarkdownDownload(file);
        },
      });

      if (!ticket.isCurrent()) return;

      if (outcome.kind === "access_loss") {
        handleAccessRevoked(outcome.accessLoss);
        return;
      }

      if (outcome.kind === "error") {
        setExportingBriefId(null);
        setExportError({
          briefId,
          message: outcome.message,
        });
        if (outcome.status === 404) {
          setDataState((prev) => ({
            ...prev,
            items: prev.items.filter((item) => item.brief_id !== briefId),
          }));
        }
        return;
      }

      setExportingBriefId(null);
      setExportError(null);
      setDataState((prev) => ({
        ...prev,
        items: prev.items.map((item) =>
          item.brief_id === outcome.post.brief_id ? outcome.post : item,
        ),
        selectedDetail:
          prev.selectedDetail?.brief_id === outcome.post.brief_id
            ? outcome.post
            : prev.selectedDetail,
      }));
    },
    [exportingBriefId, handleAccessRevoked],
  );

  const handleOpenWithdrawFromCard = useCallback(
    (card: RecruitmentPostCardViewModel) => {
      setWithdrawSuccessBanner(null);
      setWithdrawTarget({
        briefId: card.briefId,
        expectedVersion: card.version,
        projectName: card.projectName,
        industrialParkName: card.industrialParkName,
        provinceName: card.provinceName,
        jobDescriptionDisplay: card.jobDescriptionDisplay,
      });
    },
    [],
  );

  const handleOpenWithdrawFromDetail = useCallback(
    (detail: RecruitmentPostDetailViewModel) => {
      setWithdrawSuccessBanner(null);
      setWithdrawTarget({
        briefId: detail.briefId,
        expectedVersion: detail.version,
        projectName: detail.section1General.projectName,
        industrialParkName: detail.section1General.industrialParkName,
        provinceName: detail.section1General.provinceName,
        jobDescriptionDisplay: detail.section1General.jobDescriptionDisplay,
      });
    },
    [],
  );

  const handlePostWithdrawn = useCallback(
    (withdrawnPost: RecruitmentPostItem) => {
      setWithdrawTarget(null);
      setWithdrawSuccessBanner(
        `Đã rút phiếu tuyển dụng dự án "${withdrawnPost.project.display_name}" tại ${withdrawnPost.industrial_park.display_name}.`,
      );
      setDataState((prev) => {
        const isCurrentDetail = prev.detailBriefId === withdrawnPost.brief_id;
        return {
          ...prev,
          items: applyWithdrawnPostToFeedItems(
            prev.items,
            withdrawnPost,
            activeTab,
          ),
          detailOpen: isCurrentDetail ? false : prev.detailOpen,
          detailBriefId: isCurrentDetail ? null : prev.detailBriefId,
          selectedDetail: isCurrentDetail ? null : prev.selectedDetail,
          detailError: isCurrentDetail ? null : prev.detailError,
        };
      });
    },
    [activeTab],
  );

  const handleLatestServerPostLoaded = useCallback(
    (latestPost: RecruitmentPostItem) => {
      setDataState((prev) => ({
        ...prev,
        items: prev.items.map((item) =>
          item.brief_id === latestPost.brief_id ? latestPost : item,
        ),
        selectedDetail:
          prev.selectedDetail?.brief_id === latestPost.brief_id
            ? latestPost
            : prev.selectedDetail,
      }));
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadContext();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadContext]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void loadFirstPage(filters, activeTab);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activeTab, filters, loadFirstPage]);

  useEffect(() => {
    return () => {
      getRequestTracker(contextTrackerRef).cancelAll();
      getRequestTracker(feedTrackerRef).cancelAll();
      getRequestTracker(detailTrackerRef).cancelAll();
      getRequestTracker(exportTrackerRef).cancelAll();
    };
  }, []);

  const filterProjects = useMemo(
    () => dataState.context?.filter_projects ?? [],
    [dataState.context],
  );

  const activeProvinces = useMemo(
    () => visibleProvincesForFilter(dataState.context?.provinces ?? []),
    [dataState.context],
  );

  const activeIndustrialParks = useMemo(
    () =>
      visibleIndustrialParksForFilter(
        dataState.context?.industrial_parks ?? [],
        filters.provinceId,
      ),
    [dataState.context, filters.provinceId],
  );

  const activeLaborTypes = useMemo(
    () => visibleLaborTypesForFilter(dataState.context?.labor_types ?? []),
    [dataState.context],
  );

  const cardViewModels = useMemo(
    () => dataState.items.map((item) => toRecruitmentPostCardViewModel(item)),
    [dataState.items],
  );

  const detailViewModel = useMemo(
    () =>
      dataState.selectedDetail
        ? toRecruitmentPostDetailViewModel(dataState.selectedDetail)
        : null,
    [dataState.selectedDetail],
  );

  const hasFilters = hasActiveRecruitmentPostFilters(filters);
  const canCreatePost =
    Boolean(dataState.context?.can_create) &&
    (dataState.context?.managed_projects.length ?? 0) > 0;

  if (accessLoss === "ACCESS_DENIED") {
    return <AccessDenied />;
  }

  if (accessLoss === "ACCOUNT_UNAVAILABLE") {
    return <AccountUnavailable />;
  }

  if (accessLoss === "UNAUTHENTICATED") {
    return (
      <main
        data-testid="recruitment-posts-unauthenticated"
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
            Dữ liệu trên màn hình đã được xóa để bảo mật. Vui lòng đăng nhập lại
            để tiếp tục xem tin tuyển dụng.
          </p>
          <div className="flex flex-col gap-2">
            <Link
              href="/login?next=%2Frecruitment-posts"
              className="inline-flex min-h-11 h-11 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              Đăng nhập lại
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <PageShell dataTestId="recruitment-posts-workspace">
      <PageHeader
        title="Tin tuyển dụng"
        description="Tra cứu thông tin các phiếu yêu cầu tuyển dụng đang hiệu lực theo dự án, khu công nghiệp và hình thức tuyển dụng."
        actions={
          canCreatePost ? (
            <Link
              href="/recruitment-posts/new"
              data-testid="recruitment-posts-create-button"
              className="inline-flex min-h-11 h-10 items-center justify-center rounded-md bg-primary px-3.5 text-sm font-medium text-on-primary transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              Tạo phiếu tuyển dụng
            </Link>
          ) : null
        }
      />

      {withdrawSuccessBanner ? (
        <StatusBanner
          tone="success"
          title="Đã rút phiếu tuyển dụng"
          dataTestId="recruitment-posts-withdraw-success"
        >
          {withdrawSuccessBanner}
        </StatusBanner>
      ) : null}

      <div
        role="tablist"
        aria-label="Phân loại danh sách tin tuyển dụng"
        data-testid="recruitment-posts-tabs"
        className="flex flex-wrap items-center gap-2 border-b border-border pb-2"
      >
        {RECRUITMENT_POST_FEED_TABS.map((tab) => {
          const isSelected = activeTab === tab;
          return (
            <button
              key={tab}
              ref={(el) => {
                tabButtonRefs.current[tab] = el;
              }}
              type="button"
              role="tab"
              id={`recruitment-posts-tab-${tab}`}
              data-testid={`recruitment-posts-tab-${tab}`}
              aria-selected={isSelected}
              aria-controls="recruitment-posts-tabpanel"
              tabIndex={isSelected ? 0 : -1}
              onClick={() => handleSelectTab(tab)}
              onKeyDown={(event) => handleTabKeyDown(event, tab)}
              className={
                isSelected
                  ? "inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-on-primary shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  : "inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              }
            >
              {RECRUITMENT_POST_FEED_TAB_LABELS[tab]}
            </button>
          );
        })}
      </div>

      <div
        id="recruitment-posts-tabpanel"
        role="tabpanel"
        aria-labelledby={`recruitment-posts-tab-${activeTab}`}
        className="space-y-4"
      >
        {activeTab === "published" ? (
          <FilterToolbar
            dataTestId="recruitment-posts-filter-toolbar"
            actions={
              hasFilters ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  data-testid="recruitment-posts-clear-filters"
                  onClick={() => setFilters(EMPTY_RECRUITMENT_POST_FILTERS)}
                >
                  Xóa bộ lọc
                </Button>
              ) : null
            }
            summary={
              <span>
                Hiển thị{" "}
                <strong className="font-mono tabular-nums text-foreground">
                  {cardViewModels.length}
                </strong>{" "}
                tin tuyển dụng đang hiệu lực (tối đa{" "}
                {DEFAULT_RECRUITMENT_POST_PAGE_SIZE} tin mỗi lượt tải).
              </span>
            }
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="recruitment-posts-filter-project"
                  className="font-medium text-muted"
                >
                  Dự án
                </label>
                <select
                  id="recruitment-posts-filter-project"
                  data-testid="recruitment-posts-filter-project"
                  value={filters.projectId}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      projectId: event.target.value,
                    }))
                  }
                  className={FILTER_SELECT_CLASS}
                >
                  <option value="">Tất cả dự án</option>
                  {filterProjects.map((project) => (
                    <option key={project.project_id} value={project.project_id}>
                      {project.display_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="recruitment-posts-filter-province"
                  className="font-medium text-muted"
                >
                  Tỉnh/Thành
                </label>
                <select
                  id="recruitment-posts-filter-province"
                  data-testid="recruitment-posts-filter-province"
                  value={filters.provinceId}
                  onChange={(event) =>
                    setFilters((prev) =>
                      applyProvinceFilterChange(
                        prev,
                        event.target.value,
                        dataState.context?.industrial_parks ?? [],
                      ),
                    )
                  }
                  className={FILTER_SELECT_CLASS}
                >
                  <option value="">Tất cả tỉnh/thành</option>
                  {activeProvinces.map((province) => (
                    <option
                      key={province.province_id}
                      value={province.province_id}
                    >
                      {province.display_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="recruitment-posts-filter-park"
                  className="font-medium text-muted"
                >
                  Khu công nghiệp
                </label>
                <select
                  id="recruitment-posts-filter-park"
                  data-testid="recruitment-posts-filter-park"
                  value={filters.industrialParkId}
                  onChange={(event) =>
                    setFilters((prev) =>
                      applyIndustrialParkFilterChange(
                        prev,
                        event.target.value,
                        dataState.context?.industrial_parks ?? [],
                      ),
                    )
                  }
                  className={FILTER_SELECT_CLASS}
                >
                  <option value="">Tất cả KCN</option>
                  {activeIndustrialParks.map((park) => (
                    <option
                      key={park.industrial_park_id}
                      value={park.industrial_park_id}
                    >
                      {park.display_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="recruitment-posts-filter-labor-type"
                  className="font-medium text-muted"
                >
                  Hình thức tuyển dụng
                </label>
                <select
                  id="recruitment-posts-filter-labor-type"
                  data-testid="recruitment-posts-filter-labor-type"
                  value={filters.laborTypeKey}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      laborTypeKey: event.target.value,
                    }))
                  }
                  className={FILTER_SELECT_CLASS}
                >
                  <option value="">Tất cả hình thức</option>
                  {activeLaborTypes.map((laborType) => (
                    <option
                      key={laborType.labor_type_key}
                      value={laborType.labor_type_key}
                    >
                      {laborType.display_name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="recruitment-posts-filter-updated-from"
                  className="font-medium text-muted"
                >
                  Từ ngày cập nhật
                </label>
                <input
                  id="recruitment-posts-filter-updated-from"
                  data-testid="recruitment-posts-filter-updated-from"
                  type="date"
                  value={filters.updatedFrom}
                  max={filters.updatedTo || undefined}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      updatedFrom: event.target.value,
                    }))
                  }
                  className={FILTER_DATE_INPUT_CLASS}
                />
              </div>

              <div className="flex min-w-0 flex-col gap-1 text-sm">
                <label
                  htmlFor="recruitment-posts-filter-updated-to"
                  className="font-medium text-muted"
                >
                  Đến ngày cập nhật
                </label>
                <input
                  id="recruitment-posts-filter-updated-to"
                  data-testid="recruitment-posts-filter-updated-to"
                  type="date"
                  value={filters.updatedTo}
                  min={filters.updatedFrom || undefined}
                  onChange={(event) =>
                    setFilters((prev) => ({
                      ...prev,
                      updatedTo: event.target.value,
                    }))
                  }
                  className={FILTER_DATE_INPUT_CLASS}
                />
              </div>
            </div>
          </FilterToolbar>
        ) : (
          <div
            data-testid="recruitment-posts-mine-summary"
            className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-muted"
          >
            Hiển thị{" "}
            <strong className="font-mono tabular-nums text-foreground">
              {cardViewModels.length}
            </strong>{" "}
            tin tuyển dụng do bạn tạo gồm cả tin đang tuyển và đã rút (tối đa{" "}
            {DEFAULT_RECRUITMENT_POST_PAGE_SIZE} tin mỗi lượt tải).
          </div>
        )}

        {contextError ? (
          <StatusBanner
            tone="warning"
            title="Không thể tải ngữ cảnh bộ lọc"
            dataTestId="recruitment-posts-context-error"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{contextError}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="recruitment-posts-context-retry"
                onClick={() => {
                  void loadContext();
                }}
                disabled={contextLoading}
              >
                {contextLoading ? "Đang tải lại…" : "Thử tải lại ngữ cảnh"}
              </Button>
            </div>
          </StatusBanner>
        ) : null}

        {!isTabMismatch && !isTabTransitionPending && feedError ? (
          <StatusBanner
            tone="error"
            title="Không thể tải danh sách tin tuyển dụng"
            dataTestId="recruitment-posts-feed-error"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{feedError}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="recruitment-posts-feed-retry"
                onClick={() => {
                  void loadContext();
                  void loadFirstPage(filters, activeTab);
                }}
              >
                Thử lại
              </Button>
            </div>
          </StatusBanner>
        ) : null}

        {exportError ? (
          <StatusBanner
            tone="error"
            title="Không thể xuất bản tin tuyển dụng"
            dataTestId="recruitment-posts-export-error"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>{exportError.message}</span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                data-testid="recruitment-posts-export-retry"
                disabled={exportingBriefId !== null}
                onClick={() => {
                  void handleExportPost(exportError.briefId);
                }}
              >
                {exportingBriefId === exportError.briefId
                  ? "Đang xuất…"
                  : "Thử lại"}
              </Button>
            </div>
          </StatusBanner>
        ) : null}

        {showFeedLoading ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="recruitment-posts-loading"
            className="rounded-xl border border-border bg-surface p-8 text-center text-sm text-muted"
          >
            Đang tải danh sách tin tuyển dụng…
          </div>
        ) : null}

        {!showFeedLoading && !feedError && cardViewModels.length === 0 ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="recruitment-posts-empty"
            className="rounded-xl border border-border bg-surface p-8 text-center space-y-3"
          >
            <p className="text-sm font-medium text-foreground">
              {activeTab === "mine"
                ? "Bạn chưa tạo phiếu tuyển dụng nào."
                : hasFilters
                  ? "Không có phiếu tuyển dụng nào khớp với bộ lọc."
                  : "Hiện chưa có phiếu tuyển dụng nào đang hiệu lực."}
            </p>
            {activeTab === "published" && hasFilters ? (
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setFilters(EMPTY_RECRUITMENT_POST_FILTERS)}
                >
                  Xóa bộ lọc
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {!showFeedLoading && cardViewModels.length > 0 ? (
          <div className="space-y-4">
            <div
              data-testid="recruitment-posts-list"
              className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
            >
              {cardViewModels.map((card) => (
                <RecruitmentPostCard
                  key={card.briefId}
                  card={card}
                  onViewDetail={handleOpenDetail}
                  onExport={handleExportPost}
                  isExporting={exportingBriefId === card.briefId}
                  onWithdraw={handleOpenWithdrawFromCard}
                  showStatusBadge={activeTab === "mine"}
                  canRepost={canRepostWithdrawnRecruitmentPost({
                    tab: activeTab,
                    status: card.status,
                    projectId: card.projectId,
                    managedProjects: dataState.context?.managed_projects,
                  })}
                />
              ))}
            </div>

            {loadMoreError ? (
              <StatusBanner
                tone="error"
                title="Không thể tải thêm tin tuyển dụng"
                dataTestId="recruitment-posts-load-more-error"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>{loadMoreError}</span>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid="recruitment-posts-load-more-retry"
                    onClick={() => {
                      void handleLoadMore();
                    }}
                    disabled={loadingMore}
                  >
                    Thử lại
                  </Button>
                </div>
              </StatusBanner>
            ) : null}

            <div className="flex justify-center pt-2">
              <CursorLoadMore
                hasMore={dataState.hasMore}
                loading={loadingMore}
                onLoadMore={() => {
                  void handleLoadMore();
                }}
                label="Tải thêm"
                loadingLabel="Đang tải thêm…"
              />
            </div>
          </div>
        ) : null}
      </div>

      <RecruitmentPostDetailDialog
        open={dataState.detailOpen}
        onOpenChange={handleDetailOpenChange}
        detail={detailViewModel}
        loading={detailLoading}
        error={dataState.detailError}
        onRetry={handleRetryDetail}
        onWithdraw={handleOpenWithdrawFromDetail}
      />

      <RecruitmentPostWithdrawDialog
        open={withdrawTarget !== null}
        target={withdrawTarget}
        onOpenChange={(open) => {
          if (!open) {
            setWithdrawTarget(null);
          }
        }}
        onWithdrawn={handlePostWithdrawn}
        onAccessRevoked={handleAccessRevoked}
        onLatestServerPostLoaded={handleLatestServerPostLoaded}
      />
    </PageShell>
  );
}
