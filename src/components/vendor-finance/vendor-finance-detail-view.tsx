"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Eye,
  FileSpreadsheet,
  ImagePlus,
  Layers,
  Plus,
  Printer,
  RefreshCw,
  RotateCcw,
  Scale,
} from "lucide-react";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CursorLoadMore } from "@/components/ui/cursor-load-more";
import {
  DATA_TABLE_CLASS,
  DATA_TABLE_HEAD_CLASS,
  DATA_TABLE_ROW_CLASS,
  DATA_TABLE_TD_CLASS,
  DATA_TABLE_TH_CLASS,
  DataTableContainer,
  RowActionCluster,
} from "@/components/ui/data-table";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { OffsetPager } from "@/components/ui/offset-pager";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import type {
  VendorFinanceActorContextOptionsResponse,
  VendorFinanceContractType,
  VendorFinanceDetailSubLedger,
  VendorFinanceEntryProjection,
  VendorFinanceEntryType,
  VendorFinanceEvidenceSummary,
  VendorFinanceEvidenceTargetKind,
  VendorFinanceLedgerScope,
  VendorFinanceReconciliationProjection,
  VendorFinanceReconciliationsPageResponse,
  VendorFinanceSharedAdvanceMovementProjection,
  VendorFinanceSharedAdvanceMovementType,
  VendorFinanceVendorDetailResponse,
} from "@/lib/vendor-finance/vendor-finance-contract";
import {
  buildVendorDetailUrl,
  buildVendorEntriesUrl,
  buildVendorFinanceContextUrl,
  buildVendorReconciliationsUrl,
  buildVendorSharedAdvancesUrl,
  classifyVendorFinanceError,
  CONTRACT_TYPE_BADGE_TONES,
  CONTRACT_TYPE_LABELS_VI,
  ENTRY_TYPE_LABELS_VI,
  formatSignedVndDelta,
  formatTimestampVi,
  formatVendorBalancePresentation,
  formatVietnamDateLabel,
  formatVndMinor,
  isCanonicalUiProjectId,
  isUuidString,
  mergeUniqueSharedAdvanceMovements,
  parseVendorDetailEnvelope,
  parseVendorEntriesPageEnvelope,
  parseVendorFinanceContextEnvelope,
  parseVendorReconciliationsPageEnvelope,
  parseVendorSharedAdvancesPageEnvelope,
  SHARED_ADVANCE_MOVEMENT_TYPE_LABELS_VI,
  shouldCommitSharedAdvanceLoadMore,
  VFIN_UI_CONTRACT_TYPES,
  VFIN_UI_ENTRY_TYPES,
  VFIN_UI_REDACTED_FIELD_LABEL_VI,
  VFIN_UI_REFERENCE_TOTAL_LABEL_VI,
  VFIN_UI_SHARED_ADVANCE_MOVEMENT_TYPES,
  type DialogRecordVendorFinanceEntryType,
} from "@/lib/vendor-finance/ui-model";

import {
  ClassifyVendorSubLedgerDialog,
  CreateVendorReconciliationDialog,
  FundVendorSharedAdvanceDialog,
  RecordVendorEntryDialog,
  RecordVendorRefundDialog,
  ReverseVendorEntryDialog,
  ReverseVendorSharedAdvanceMovementDialog,
} from "./vendor-finance-entry-dialogs";
import {
  VendorEvidenceAttachDialog,
  VendorEvidenceViewerDialog,
} from "./vendor-finance-evidence-dialog";

const ENTRIES_PAGE_SIZE = 25;
const RECONCILIATIONS_PAGE_SIZE = 15;
const SHARED_ADVANCES_PAGE_SIZE = 25;

type DetailTab = "ledger" | "reconciliations" | "shared_advances";

type SelectedScopeFilter = {
  ledgerScope: VendorFinanceLedgerScope | null;
  projectId: string | null;
  accountantRef: string | null;
  contractType: VendorFinanceContractType | null;
};

function parseInitialScopeFilter(searchParams: URLSearchParams): SelectedScopeFilter {
  const rawScope = searchParams.get("ledgerScope");
  const rawProject = searchParams.get("projectId");
  const rawAccountant = searchParams.get("accountantRef");
  const rawContractType = searchParams.get("contractType");

  if (rawScope === "LEGACY_UNALLOCATED") {
    return {
      ledgerScope: "LEGACY_UNALLOCATED",
      projectId: null,
      accountantRef: null,
      contractType: "UNCLASSIFIED",
    };
  }
  const projectId = rawProject && isCanonicalUiProjectId(rawProject) ? rawProject : null;
  const accountantRef =
    rawAccountant && isUuidString(rawAccountant) ? rawAccountant.toLowerCase() : null;
  const contractType =
    rawContractType && (VFIN_UI_CONTRACT_TYPES as readonly string[]).includes(rawContractType)
      ? (rawContractType as VendorFinanceContractType)
      : null;
  if (rawScope === "PROJECT_ACCOUNTANT" || projectId || accountantRef || contractType) {
    return {
      ledgerScope: "PROJECT_ACCOUNTANT",
      projectId,
      accountantRef,
      contractType,
    };
  }
  return { ledgerScope: null, projectId: null, accountantRef: null, contractType: null };
}

function subLedgerKey(sub: VendorFinanceDetailSubLedger): string {
  return `${sub.ledger_scope}:${sub.project_id ?? "legacy"}:${sub.accountant_ref ?? "none"}:${sub.contract_type}`;
}

export function VendorFinanceDetailView({
  vendorId,
  initialCanRecord = false,
  initialCanReconcile = false,
  initialCanManageProjectAssignments = false,
}: {
  vendorId: string;
  initialCanRecord?: boolean;
  initialCanReconcile?: boolean;
  initialCanManageProjectAssignments?: boolean;
}) {
  const searchParams = useSearchParams();
  const entryTypeFilterId = useId();
  const movementTypeFilterId = useId();
  const ledgerTabId = useId();
  const recTabId = useId();
  const sharedAdvTabId = useId();
  const ledgerPanelId = useId();
  const recPanelId = useId();
  const sharedAdvPanelId = useId();
  const ledgerTabRef = useRef<HTMLButtonElement | null>(null);
  const recTabRef = useRef<HTMLButtonElement | null>(null);
  const sharedAdvTabRef = useRef<HTMLButtonElement | null>(null);

  const [scopeFilter, setScopeFilter] = useState<SelectedScopeFilter>(() =>
    parseInitialScopeFilter(searchParams),
  );
  const [activeTab, setActiveTab] = useState<DetailTab>("ledger");
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Context options (recordable projects + linked vendors)
  const [contextData, setContextData] =
    useState<VendorFinanceActorContextOptionsResponse | null>(null);

  // Vendor detail summary state
  const [detail, setDetail] = useState<VendorFinanceVendorDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Keyset-paginated ledger state
  const [entryTypeFilter, setEntryTypeFilter] = useState<VendorFinanceEntryType | "">("");
  const [entries, setEntries] = useState<VendorFinanceEntryProjection[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMoreEntries, setHasMoreEntries] = useState(false);
  const [entriesLoading, setEntriesLoading] = useState(true);
  const [loadingMoreEntries, setLoadingMoreEntries] = useState(false);
  const [entriesError, setEntriesError] = useState<string | null>(null);

  // Offset-paginated reconciliations state
  const [recPage, setRecPage] = useState(1);
  const [recData, setRecData] = useState<VendorFinanceReconciliationsPageResponse | null>(null);
  const [recLoading, setRecLoading] = useState(true);
  const [recError, setRecError] = useState<string | null>(null);

  // Keyset-paginated shared advance movements state
  const [movementTypeFilter, setMovementTypeFilter] =
    useState<VendorFinanceSharedAdvanceMovementType | "">("");
  const [sharedMovements, setSharedMovements] = useState<
    VendorFinanceSharedAdvanceMovementProjection[]
  >([]);
  const [sharedNextCursor, setSharedNextCursor] = useState<string | null>(null);
  const [hasMoreSharedMovements, setHasMoreSharedMovements] = useState(false);
  const [sharedMovementsLoading, setSharedMovementsLoading] = useState(false);
  const [loadingMoreSharedMovements, setLoadingMoreSharedMovements] = useState(false);
  const [sharedMovementsError, setSharedMovementsError] = useState<string | null>(null);

  const entriesRequestGenRef = useRef(0);
  const entriesLoadMoreAbortRef = useRef<AbortController | null>(null);
  const sharedMovementsRequestGenRef = useRef(0);
  const sharedLoadMoreAbortRef = useRef<AbortController | null>(null);

  // Dialog states
  const [recordDialogOpen, setRecordDialogOpen] = useState(false);
  const [recordInitialType, setRecordInitialType] =
    useState<DialogRecordVendorFinanceEntryType | undefined>(undefined);
  const [reversingEntry, setReversingEntry] = useState<VendorFinanceEntryProjection | null>(null);
  const [reconcileDialogOpen, setReconcileDialogOpen] = useState(false);
  const [classifyingSubLedger, setClassifyingSubLedger] =
    useState<VendorFinanceDetailSubLedger | null>(null);
  const [fundAdvanceDialogOpen, setFundAdvanceDialogOpen] = useState(false);
  const [refundDialogOpen, setRefundDialogOpen] = useState(false);
  const [reversingSharedMovement, setReversingSharedMovement] =
    useState<VendorFinanceSharedAdvanceMovementProjection | null>(null);

  const [viewingEvidence, setViewingEvidence] = useState<{
    evidence: VendorFinanceEvidenceSummary;
    label: string;
  } | null>(null);
  const [attachingEvidence, setAttachingEvidence] = useState<{
    targetKind: VendorFinanceEvidenceTargetKind;
    targetId: string;
    label: string;
  } | null>(null);

  const triggerReloadAll = () => setRefreshNonce((n) => n + 1);

  // 0. Load Actor Context Options
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadContext() {
      await Promise.resolve();
      if (cancelled) return;
      try {
        const res = await fetch(buildVendorFinanceContextUrl(), {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const json: unknown = await res.json().catch(() => null);
        if (cancelled) return;
        const parsed = parseVendorFinanceContextEnvelope(json);
        if (parsed) {
          setContextData(parsed);
        }
      } catch {
        // Supplementary context
      }
    }

    void loadContext();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [refreshNonce]);

  // 1. Load Vendor Detail Summary (with sub-ledger scope)
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadDetail() {
      await Promise.resolve();
      if (cancelled) return;
      setDetailLoading(true);
      setDetailError(null);

      try {
        const res = await fetch(
          buildVendorDetailUrl(vendorId, {
            ledger_scope: scopeFilter.ledgerScope,
            project_id: scopeFilter.projectId,
            accountant_ref: scopeFilter.accountantRef,
            contract_type: scopeFilter.contractType,
          }),
          {
            method: "GET",
            signal: controller.signal,
            cache: "no-store",
          },
        );
        const json: unknown = await res.json().catch(() => null);
        if (cancelled) return;

        if (!res.ok) {
          const classified = classifyVendorFinanceError(json, res.status);
          setDetailError(classified.message);
          setDetailLoading(false);
          return;
        }

        const parsed = parseVendorDetailEnvelope(json);
        if (!parsed) {
          setDetailError("Dữ liệu chi tiết Vendor từ máy chủ không đúng chuẩn hợp đồng.");
          setDetailLoading(false);
          return;
        }
        setDetail(parsed);
        setDetailLoading(false);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setDetailError("Không thể tải thông tin Vendor do lỗi kết nối mạng.");
        setDetailLoading(false);
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [vendorId, scopeFilter, refreshNonce]);

  // 2. Load First Page of Ledger Entries (strictly bound to current scopeFilter)
  useEffect(() => {
    let cancelled = false;
    entriesRequestGenRef.current += 1;
    const requestGen = entriesRequestGenRef.current;
    entriesLoadMoreAbortRef.current?.abort();
    entriesLoadMoreAbortRef.current = null;
    const controller = new AbortController();

    async function loadFirstEntriesPage() {
      await Promise.resolve();
      if (cancelled || entriesRequestGenRef.current !== requestGen) return;
      setEntriesLoading(true);
      setLoadingMoreEntries(false);
      setEntriesError(null);

      try {
        const url = buildVendorEntriesUrl(vendorId, {
          entry_type: entryTypeFilter || null,
          page_size: ENTRIES_PAGE_SIZE,
          ledger_scope: scopeFilter.ledgerScope,
          project_id: scopeFilter.projectId,
          accountant_ref: scopeFilter.accountantRef,
          contract_type: scopeFilter.contractType,
        });
        const res = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        const json: unknown = await res.json().catch(() => null);
        if (cancelled || entriesRequestGenRef.current !== requestGen) return;

        if (!res.ok) {
          const classified = classifyVendorFinanceError(json, res.status);
          setEntriesError(classified.message);
          setEntriesLoading(false);
          return;
        }

        const parsed = parseVendorEntriesPageEnvelope(json);
        if (!parsed || parsed.vendor_id !== vendorId) {
          setEntriesError("Dữ liệu sổ cái giao dịch từ máy chủ không hợp lệ.");
          setEntriesLoading(false);
          return;
        }

        setEntries([...parsed.entries]);
        setNextCursor(parsed.next_cursor);
        setHasMoreEntries(parsed.has_more);
        setEntriesLoading(false);
      } catch (err) {
        if (
          cancelled ||
          entriesRequestGenRef.current !== requestGen ||
          (err instanceof DOMException && err.name === "AbortError")
        ) {
          return;
        }
        setEntriesError("Không thể tải sổ cái giao dịch do lỗi kết nối mạng.");
        setEntriesLoading(false);
      }
    }

    void loadFirstEntriesPage();
    return () => {
      cancelled = true;
      controller.abort();
      entriesLoadMoreAbortRef.current?.abort();
    };
  }, [vendorId, scopeFilter, entryTypeFilter, refreshNonce]);

  // 3. Load Reconciliations Page (strictly bound to current scopeFilter)
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function loadReconciliations() {
      await Promise.resolve();
      if (cancelled) return;
      setRecLoading(true);
      setRecError(null);

      try {
        const url = buildVendorReconciliationsUrl(vendorId, {
          page: recPage,
          page_size: RECONCILIATIONS_PAGE_SIZE,
          ledger_scope: scopeFilter.ledgerScope,
          project_id: scopeFilter.projectId,
          accountant_ref: scopeFilter.accountantRef,
          contract_type: scopeFilter.contractType,
        });
        const res = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        const json: unknown = await res.json().catch(() => null);
        if (cancelled) return;

        if (!res.ok) {
          const classified = classifyVendorFinanceError(json, res.status);
          setRecError(classified.message);
          setRecLoading(false);
          return;
        }

        const parsed = parseVendorReconciliationsPageEnvelope(json);
        if (!parsed) {
          setRecError("Dữ liệu lịch sử đối soát từ máy chủ không hợp lệ.");
          setRecLoading(false);
          return;
        }

        setRecData(parsed);
        setRecLoading(false);
      } catch (err) {
        if (cancelled || (err instanceof DOMException && err.name === "AbortError")) {
          return;
        }
        setRecError("Không thể tải lịch sử đối soát do lỗi kết nối mạng.");
        setRecLoading(false);
      }
    }

    void loadReconciliations();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [vendorId, scopeFilter, recPage, refreshNonce]);

  const canViewSharedAdvance =
    detail !== null &&
    detail.vendor.vendor_id === vendorId &&
    detail.allowed_actions.can_view_shared_advance === true;

  const resolvedActiveTab: DetailTab =
    activeTab === "shared_advances" && !canViewSharedAdvance ? "ledger" : activeTab;

  // 4. Load First Page of Shared Advance Movements (strictly when can_view_shared_advance === true)
  useEffect(() => {
    let cancelled = false;
    sharedMovementsRequestGenRef.current += 1;
    const requestGen = sharedMovementsRequestGenRef.current;
    sharedLoadMoreAbortRef.current?.abort();
    sharedLoadMoreAbortRef.current = null;
    const controller = new AbortController();

    async function loadFirstSharedAdvancesPage() {
      await Promise.resolve();
      if (cancelled || sharedMovementsRequestGenRef.current !== requestGen) return;

      if (!canViewSharedAdvance) {
        setSharedMovements([]);
        setSharedNextCursor(null);
        setHasMoreSharedMovements(false);
        setSharedMovementsLoading(false);
        setLoadingMoreSharedMovements(false);
        setSharedMovementsError(null);
        setActiveTab((prev) => (prev === "shared_advances" ? "ledger" : prev));
        return;
      }

      setSharedMovementsLoading(true);
      setLoadingMoreSharedMovements(false);
      setSharedMovementsError(null);

      try {
        const url = buildVendorSharedAdvancesUrl(vendorId, {
          movement_type: movementTypeFilter || null,
          page_size: SHARED_ADVANCES_PAGE_SIZE,
        });
        const res = await fetch(url, {
          method: "GET",
          signal: controller.signal,
          cache: "no-store",
        });
        const json: unknown = await res.json().catch(() => null);
        if (cancelled || sharedMovementsRequestGenRef.current !== requestGen) return;

        if (!res.ok) {
          const classified = classifyVendorFinanceError(json, res.status);
          setSharedMovementsError(classified.message);
          setSharedMovementsLoading(false);
          return;
        }

        const parsed = parseVendorSharedAdvancesPageEnvelope(json);
        if (!parsed || parsed.vendor_id !== vendorId) {
          setSharedMovementsError("Dữ liệu lịch sử ứng dùng chung từ máy chủ không hợp lệ.");
          setSharedMovementsLoading(false);
          return;
        }

        setSharedMovements([...parsed.movements]);
        setSharedNextCursor(parsed.next_cursor);
        setHasMoreSharedMovements(parsed.has_more);
        setSharedMovementsLoading(false);
      } catch (err) {
        if (
          cancelled ||
          sharedMovementsRequestGenRef.current !== requestGen ||
          (err instanceof DOMException && err.name === "AbortError")
        ) {
          return;
        }
        setSharedMovementsError("Không thể tải lịch sử ứng dùng chung do lỗi kết nối mạng.");
        setSharedMovementsLoading(false);
      }
    }

    void loadFirstSharedAdvancesPage();
    return () => {
      cancelled = true;
      controller.abort();
      sharedLoadMoreAbortRef.current?.abort();
    };
  }, [vendorId, canViewSharedAdvance, movementTypeFilter, refreshNonce]);

  const handleLoadMoreEntries = async () => {
    if (!nextCursor || entriesLoading || loadingMoreEntries) return;
    const requestGen = entriesRequestGenRef.current;
    const requestVendorId = vendorId;
    entriesLoadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    entriesLoadMoreAbortRef.current = controller;

    setLoadingMoreEntries(true);
    setEntriesError(null);

    try {
      const url = buildVendorEntriesUrl(requestVendorId, {
        cursor: nextCursor,
        entry_type: entryTypeFilter || null,
        page_size: ENTRIES_PAGE_SIZE,
        ledger_scope: scopeFilter.ledgerScope,
        project_id: scopeFilter.projectId,
        accountant_ref: scopeFilter.accountantRef,
        contract_type: scopeFilter.contractType,
      });
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        cache: "no-store",
      });
      const json: unknown = await res.json().catch(() => null);
      if (
        controller.signal.aborted ||
        entriesRequestGenRef.current !== requestGen ||
        vendorId !== requestVendorId
      ) {
        return;
      }

      if (!res.ok) {
        const classified = classifyVendorFinanceError(json, res.status);
        setEntriesError(classified.message);
        setLoadingMoreEntries(false);
        return;
      }

      const parsed = parseVendorEntriesPageEnvelope(json);
      if (!parsed || parsed.vendor_id !== requestVendorId) {
        setEntriesError("Phản hồi phân trang sổ cái từ máy chủ không hợp lệ.");
        setLoadingMoreEntries(false);
        return;
      }

      setEntries((prev) => {
        const existingIds = new Set(prev.map((item) => item.entry_id));
        const merged = [...prev];
        for (const item of parsed.entries) {
          if (!existingIds.has(item.entry_id)) {
            existingIds.add(item.entry_id);
            merged.push(item);
          }
        }
        return merged;
      });
      setNextCursor(parsed.next_cursor);
      setHasMoreEntries(parsed.has_more);
      setLoadingMoreEntries(false);
    } catch (err) {
      if (
        controller.signal.aborted ||
        entriesRequestGenRef.current !== requestGen ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setEntriesError("Mất kết nối mạng khi tải thêm bút toán sổ cái.");
      setLoadingMoreEntries(false);
    }
  };

  const handleLoadMoreSharedMovements = async () => {
    if (
      !canViewSharedAdvance ||
      !sharedNextCursor ||
      sharedMovementsLoading ||
      loadingMoreSharedMovements
    ) {
      return;
    }
    const requestGen = sharedMovementsRequestGenRef.current;
    const requestVendorId = vendorId;
    sharedLoadMoreAbortRef.current?.abort();
    const controller = new AbortController();
    sharedLoadMoreAbortRef.current = controller;

    setLoadingMoreSharedMovements(true);
    setSharedMovementsError(null);

    try {
      const url = buildVendorSharedAdvancesUrl(requestVendorId, {
        cursor: sharedNextCursor,
        movement_type: movementTypeFilter || null,
        page_size: SHARED_ADVANCES_PAGE_SIZE,
      });
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        cache: "no-store",
      });
      const json: unknown = await res.json().catch(() => null);
      if (
        !shouldCommitSharedAdvanceLoadMore({
          requestGeneration: requestGen,
          currentGeneration: sharedMovementsRequestGenRef.current,
          aborted: controller.signal.aborted,
          canViewSharedAdvance,
          requestVendorId,
          currentVendorId: vendorId,
          responseVendorId: requestVendorId,
        })
      ) {
        return;
      }

      if (!res.ok) {
        const classified = classifyVendorFinanceError(json, res.status);
        setSharedMovementsError(classified.message);
        setLoadingMoreSharedMovements(false);
        return;
      }

      const parsed = parseVendorSharedAdvancesPageEnvelope(json);
      if (!parsed) {
        setSharedMovementsError("Phản hồi phân trang ứng dùng chung từ máy chủ không hợp lệ.");
        setLoadingMoreSharedMovements(false);
        return;
      }

      if (
        !shouldCommitSharedAdvanceLoadMore({
          requestGeneration: requestGen,
          currentGeneration: sharedMovementsRequestGenRef.current,
          aborted: controller.signal.aborted,
          canViewSharedAdvance,
          requestVendorId,
          currentVendorId: vendorId,
          responseVendorId: parsed.vendor_id,
        })
      ) {
        return;
      }

      setSharedMovements((prev) => mergeUniqueSharedAdvanceMovements(prev, parsed.movements));
      setSharedNextCursor(parsed.next_cursor);
      setHasMoreSharedMovements(parsed.has_more);
      setLoadingMoreSharedMovements(false);
    } catch (err) {
      if (
        controller.signal.aborted ||
        sharedMovementsRequestGenRef.current !== requestGen ||
        (err instanceof DOMException && err.name === "AbortError")
      ) {
        return;
      }
      setSharedMovementsError("Mất kết nối mạng khi tải thêm giao dịch ứng dùng chung.");
      setLoadingMoreSharedMovements(false);
    }
  };

  const focusTabRef = (tab: DetailTab) => {
    if (tab === "ledger") {
      ledgerTabRef.current?.focus();
    } else if (tab === "reconciliations") {
      recTabRef.current?.focus();
    } else {
      sharedAdvTabRef.current?.focus();
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const visibleTabs: DetailTab[] = canViewSharedAdvance
      ? ["ledger", "reconciliations", "shared_advances"]
      : ["ledger", "reconciliations"];
    const currentIndex = Math.max(0, visibleTabs.indexOf(resolvedActiveTab));

    if (event.key === "ArrowRight") {
      event.preventDefault();
      const next = visibleTabs[(currentIndex + 1) % visibleTabs.length]!;
      setActiveTab(next);
      focusTabRef(next);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      const next = visibleTabs[(currentIndex - 1 + visibleTabs.length) % visibleTabs.length]!;
      setActiveTab(next);
      focusTabRef(next);
    } else if (event.key === "Home") {
      event.preventDefault();
      const first = visibleTabs[0]!;
      setActiveTab(first);
      focusTabRef(first);
    } else if (event.key === "End") {
      event.preventDefault();
      const last = visibleTabs[visibleTabs.length - 1]!;
      setActiveTab(last);
      focusTabRef(last);
    }
  };

  const handleSelectSubLedger = (sub: VendorFinanceDetailSubLedger | null) => {
    setRecPage(1);
    if (!sub) {
      setScopeFilter({ ledgerScope: null, projectId: null, accountantRef: null, contractType: null });
      return;
    }
    setScopeFilter({
      ledgerScope: sub.ledger_scope,
      projectId: sub.project_id,
      accountantRef: sub.accountant_ref,
      contractType: sub.contract_type,
    });
  };

  const vendor = detail?.vendor ?? null;
  const subLedgers = detail?.sub_ledgers ?? [];
  const selectedSubLedger = detail?.selected_sub_ledger ?? null;
  const allowedActions = detail?.allowed_actions ?? null;
  const canRecord = allowedActions ? allowedActions.can_record : initialCanRecord;
  const canReconcile = allowedActions ? allowedActions.can_reconcile : initialCanReconcile;
  const canManageProjectAssignments = allowedActions
    ? allowedActions.can_manage_project_assignments
    : initialCanManageProjectAssignments;
  const canFundVendorAdvance = allowedActions?.can_fund_vendor_advance === true;
  const canRecordVendorRefund = allowedActions?.can_record_vendor_refund === true;
  const allowedEntryTypes = (allowedActions?.allowed_entry_types ?? []).filter(
    (t) => t !== "ADVANCE_RECORDED",
  );
  const sharedAdvanceBalanceMinor = vendor?.shared_advance_balance_minor ?? "0";
  const canApplySharedAdvanceOffset = Boolean(
    allowedActions?.can_apply_vendor_advance === true &&
      BigInt(sharedAdvanceBalanceMinor) > BigInt(0) &&
      ((selectedSubLedger !== null &&
        selectedSubLedger.can_apply_vendor_advance === true &&
        selectedSubLedger.project_id !== null &&
        isCanonicalUiProjectId(selectedSubLedger.project_id) &&
        (selectedSubLedger.contract_type === "SEASONAL" ||
          selectedSubLedger.contract_type === "OFFICIAL") &&
        BigInt(selectedSubLedger.current_balance_minor) > BigInt(0)) ||
        subLedgers.some(
          (sub) =>
            sub.can_apply_vendor_advance === true &&
            sub.project_id !== null &&
            isCanonicalUiProjectId(sub.project_id) &&
            (sub.contract_type === "SEASONAL" || sub.contract_type === "OFFICIAL") &&
            BigInt(sub.current_balance_minor) > BigInt(0),
        )),
  );

  const vendorIsActive = (contextData?.vendors ?? []).some(
    (item) => item.vendor_id === vendorId && item.active,
  );

  // Include active combinations and existing books that are limited to settlement adjustments.
  const recordableProjectsForVendor = (contextData?.projects ?? []).filter(
    (p) =>
      p.can_record_for_project &&
      p.has_active_accountant &&
      ((p.active && vendorIsActive) ||
        subLedgers.some(
          (sub) =>
            sub.ledger_scope === "PROJECT_ACCOUNTANT" &&
            sub.project_id === p.project_id &&
            sub.accountant_ref === p.active_accountant_ref &&
            sub.entry_count > 0 &&
            (sub.can_record_entry || sub.can_apply_vendor_advance),
        )),
  );

  const openUnifiedOffsetDialog = () => {
    setRecordInitialType("ADVANCE_OFFSET_RECORDED");
    setRecordDialogOpen(true);
  };

  // Sub-ledgers where current actor can reconcile
  const reconcilableSubLedgers = subLedgers.filter(
    (s) => s.ledger_scope === "PROJECT_ACCOUNTANT" && s.can_reconcile && s.project_id !== null,
  );

  const openingTargetSubLedger =
    selectedSubLedger?.eligible_for_opening && selectedSubLedger.project_id
      ? selectedSubLedger
      : subLedgers.find((s) => s.eligible_for_opening && s.project_id) ?? null;
  const openingTargetProjectId = openingTargetSubLedger?.project_id ?? null;
  const openingTargetContractType =
    openingTargetSubLedger &&
    (openingTargetSubLedger.contract_type === "SEASONAL" ||
      openingTargetSubLedger.contract_type === "OFFICIAL")
      ? openingTargetSubLedger.contract_type
      : null;

  const balancePresentation = vendor
    ? formatVendorBalancePresentation({
        current_balance_minor: vendor.current_balance_minor,
        balance_direction: vendor.balance_direction,
        entry_count: vendor.entry_count,
        has_opening_entry: vendor.has_opening_entry,
        sub_ledger_count: subLedgers.length,
      })
    : null;

  const recPageCount = recData ? Math.max(1, Math.ceil(recData.total / recData.page_size)) : 1;

  return (
    <PageShell dataTestId="vfin-vendor-detail-page">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/finance/vendors"
          className="inline-flex min-h-11 sm:min-h-8 items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Danh sách tài chính Vendor
        </Link>
        {canManageProjectAssignments ? (
          <Link
            href="/finance/project-assignments"
            className="text-xs font-medium text-primary hover:underline"
          >
            Quản lý phân công dự án & liên kết Vendor →
          </Link>
        ) : null}
      </div>

      <PageHeader
        title={vendor ? vendor.display_name : "Chi tiết tài chính Vendor"}
        badge={
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-md border border-border bg-surface-muted px-2 py-0.5 font-mono text-xs text-muted">
              Mã Vendor: {vendorId}
            </span>
            {vendor ? (
              <StatusBadge tone={vendor.active ? "success" : "neutral"} dot>
                {vendor.active ? "Đang hoạt động" : "Ngừng hoạt động"}
              </StatusBadge>
            ) : null}
            {balancePresentation ? (
              <StatusBadge tone={balancePresentation.tone}>
                {balancePresentation.statusLabel}
              </StatusBadge>
            ) : null}
            {!canRecord ? (
              <StatusBadge tone="info" dataTestId="vfin-detail-view-only-badge">
                {canReconcile ? "Xem & Đối soát (Không ghi sổ)" : "Chế độ chỉ xem"}
              </StatusBadge>
            ) : null}
          </div>
        }
        actions={
          <>
            <Button
              variant="secondary"
              disabled={detailLoading || entriesLoading || recLoading || sharedMovementsLoading}
              onClick={triggerReloadAll}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Làm mới
            </Button>

            {vendor && vendor.eligible_for_opening && canRecord ? (
              <Link
                href={
                  openingTargetProjectId
                    ? `/finance/opening-balance?projectId=${encodeURIComponent(openingTargetProjectId)}&vendorId=${encodeURIComponent(vendor.vendor_id)}${openingTargetContractType ? `&contractType=${encodeURIComponent(openingTargetContractType)}` : ""}`
                    : `/finance/opening-balance?vendorId=${encodeURIComponent(vendor.vendor_id)}`
                }
                className={buttonClasses({ variant: "soft", size: "md" })}
              >
                <FileSpreadsheet className="h-4 w-4" aria-hidden />
                Khởi tạo đầu kỳ
              </Link>
            ) : null}

            {vendor && canReconcile ? (
              <Button
                variant="secondary"
                disabled={reconcilableSubLedgers.length === 0}
                data-testid="vfin-open-reconcile-btn"
                onClick={() => setReconcileDialogOpen(true)}
              >
                <Scale className="h-4 w-4" aria-hidden />
                Đối soát theo ngày
              </Button>
            ) : null}

            {vendor && canRecord && allowedEntryTypes.length > 0 ? (
              <Button
                variant="primary"
                data-testid="vfin-open-record-entry-btn"
                onClick={() => {
                  setRecordInitialType(allowedEntryTypes[0]);
                  setRecordDialogOpen(true);
                }}
              >
                <Plus className="h-4 w-4" aria-hidden />
                Ghi nhận khoản tiền
              </Button>
            ) : null}
          </>
        }
      />

      {detailError ? (
        <div className="space-y-3">
          <Alert tone="error" role="alert" title="Không thể tải chi tiết tài chính Vendor">
            <p>{detailError}</p>
          </Alert>
          <div>
            <Button variant="primary" onClick={triggerReloadAll}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Thử lại
            </Button>
          </div>
        </div>
      ) : null}

      {vendor && !vendor.active ? (
        <Alert tone="warning" title="Vendor đang ở trạng thái Ngừng hoạt động">
          <p>
            Không phát sinh mới công nợ hoặc lương trên Vendor ngừng hoạt động; hệ thống chỉ mở các
            bút toán tất toán / điều chỉnh theo danh sách loại bút toán được máy chủ cấp phép.
          </p>
        </Alert>
      ) : null}

      {/* =====================================================================
          VENDOR SHARED ADVANCE BALANCE CARD (Ứng dùng chung cấp Vendor)
         ===================================================================== */}
      {canViewSharedAdvance && vendor ? (
        <Card className="p-4 border-primary/30 bg-surface" data-testid="vfin-detail-shared-advance-card">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Số dư ứng dùng chung (Cấp Vendor)
                </p>
                <StatusBadge tone="info">
                  {vendor.shared_advance_movement_count ?? 0} giao dịch sổ ứng
                </StatusBadge>
              </div>
              <p
                data-testid="vfin-detail-shared-advance-balance"
                className="whitespace-nowrap font-mono text-2xl font-bold tabular-nums text-foreground"
              >
                {formatVndMinor(sharedAdvanceBalanceMinor)}
              </p>
              <p className="text-xs text-muted">
                Số dư ứng dùng chung cấp Vendor độc lập với số dư phải trả của từng sổ dự án. Đã khấu trừ vào dự án lũy kế:{" "}
                <strong className="whitespace-nowrap font-mono text-foreground">
                  {formatVndMinor(vendor.totals.advance_offset_recorded_minor)}
                </strong>
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {canFundVendorAdvance ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!vendor.active}
                  data-testid="vfin-open-fund-advance-btn"
                  onClick={() => setFundAdvanceDialogOpen(true)}
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  Ứng tiền cho Vendor
                </Button>
              ) : null}

              {canRecordVendorRefund ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={BigInt(sharedAdvanceBalanceMinor) <= BigInt(0)}
                  data-testid="vfin-open-vendor-refund-btn"
                  onClick={() => setRefundDialogOpen(true)}
                >
                  Vendor hoàn ứng
                </Button>
              ) : null}

              {canApplySharedAdvanceOffset ? (
                <Button
                  variant="soft"
                  size="sm"
                  data-testid="vfin-open-apply-offset-btn"
                  onClick={openUnifiedOffsetDialog}
                >
                  Khấu trừ ứng
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      {/* =====================================================================
          SUB-LEDGER SWITCHER (Dự án × Kế toán phụ trách × Loại hợp đồng — Không bù trừ chéo)
         ===================================================================== */}
      {subLedgers.length > 0 ? (
        <Card className="p-4">
          <div data-testid="vfin-subledger-switcher" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-primary" aria-hidden />
              <h2 className="text-sm font-semibold text-foreground">
                Sổ chi tiết theo Dự án × Kế toán phụ trách × Loại hợp đồng ({subLedgers.length} sổ độc lập)
              </h2>
            </div>
            <p className="text-xs text-muted">
              Chọn từng sổ để xem đúng số dư, lịch sử chứng từ và đối soát riêng; không gộp hoặc bù trừ chéo giữa Thời vụ và Chính thức.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {subLedgers.length > 1 ? (
              <button
                type="button"
                onClick={() => handleSelectSubLedger(null)}
                className={`rounded-xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                  selectedSubLedger === null
                    ? "border-primary bg-primary/10"
                    : "border-border bg-surface hover:border-primary/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-foreground">
                    Tất cả sổ trong phạm vi xem
                  </span>
                  <StatusBadge tone="info">{subLedgers.length} sổ riêng</StatusBadge>
                </div>
                <p className="mt-1 text-xs text-muted">
                  Xem dòng thời gian chung — không gộp số dư giữa các kế toán, dự án hoặc loại hợp đồng
                </p>
              </button>
            ) : null}

            {subLedgers.map((sub) => {
              const isSelected =
                selectedSubLedger !== null &&
                subLedgerKey(selectedSubLedger) === subLedgerKey(sub);
              const subPresentation = formatVendorBalancePresentation({
                current_balance_minor: sub.current_balance_minor,
                balance_direction: sub.balance_direction,
                entry_count: sub.entry_count,
                has_opening_entry: sub.has_opening_entry,
              });
              return (
                <div
                  key={subLedgerKey(sub)}
                  className={`rounded-xl border p-3 transition ${
                    isSelected
                      ? "border-primary bg-primary/10"
                      : "border-border bg-surface hover:border-primary/40"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleSelectSubLedger(sub)}
                    className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge tone={CONTRACT_TYPE_BADGE_TONES[sub.contract_type]}>
                            {CONTRACT_TYPE_LABELS_VI[sub.contract_type]}
                          </StatusBadge>
                          <span className="text-xs font-semibold text-foreground">
                            {sub.ledger_scope === "LEGACY_UNALLOCATED"
                              ? "Sổ lịch sử VFIN-01 (Chỉ đọc)"
                              : `${sub.project_display_name ?? sub.project_id}`}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted">
                          {sub.ledger_scope === "LEGACY_UNALLOCATED"
                            ? "Bút toán trước khi phân tách dự án"
                            : `Kế toán sổ: ${sub.responsible_accountant_display_name ?? "—"}${
                                sub.is_active_assignment ? "" : " (Sổ bàn giao cũ)"
                              }`}
                        </p>
                        {sub.classification ? (
                          <p
                            data-testid="vfin-subledger-classification-audit"
                            className="text-[11px] text-emerald-700 dark:text-emerald-300"
                          >
                            Đã phân loại từ Chưa phân loại bởi{" "}
                            <strong>{sub.classification.classified_by_display_name}</strong> (
                            {formatTimestampVi(sub.classification.classified_at)})
                          </p>
                        ) : null}
                      </div>
                      <StatusBadge tone={subPresentation.tone}>
                        {subPresentation.statusLabel}
                      </StatusBadge>
                    </div>
                    <div className="mt-2 flex items-baseline justify-between gap-2 border-t border-border/60 pt-1.5">
                      <span className="whitespace-nowrap font-mono text-sm font-bold tabular-nums text-foreground">
                        {subPresentation.signedText}
                      </span>
                      <span className="whitespace-nowrap font-mono text-[11px] text-muted">
                        {sub.entry_count} bút toán
                      </span>
                    </div>
                  </button>
                  {sub.can_classify_contract_type ? (
                    <div className="mt-2 border-t border-border/60 pt-2 flex justify-end">
                      <Button
                        variant="soft"
                        size="sm"
                        data-testid="vfin-open-classify-subledger-btn"
                        onClick={() => setClassifyingSubLedger(sub)}
                      >
                        <Layers className="h-3.5 w-3.5" aria-hidden />
                        Phân loại loại HĐ (Thời vụ / Chính thức)
                      </Button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          </div>
        </Card>
      ) : null}

      {/* Summary KPI Cards */}
      <section
        aria-label="Tổng hợp số dư và lũy kế theo nhóm giao dịch"
        className="space-y-3"
        data-testid="vfin-vendor-detail-kpis"
      >
        {selectedSubLedger === null && subLedgers.length > 1 ? (
          <Alert tone="info" title={VFIN_UI_REFERENCE_TOTAL_LABEL_VI}>
            <p data-testid="vfin-reference-total-disclosure">
              Đang hiển thị dòng thời gian chung của {subLedgers.length} sổ riêng. Các chỉ số lũy kế
              bên dưới là <strong>tổng tham khảo</strong> giữa các sổ thành phần và tuyệt đối không
              dùng để bù trừ chéo số dư giữa hợp đồng Thời vụ, Chính thức hay giữa các dự án / kế
              toán khác nhau.
            </p>
          </Alert>
        ) : null}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Card className="p-4 border-primary/25 bg-surface">
            <p className="text-xs font-medium text-muted">
              {selectedSubLedger
                ? selectedSubLedger.ledger_scope === "LEGACY_UNALLOCATED"
                  ? "Số dư sổ lịch sử VFIN-01"
                  : `Số dư sổ ${selectedSubLedger.project_display_name ?? selectedSubLedger.project_id} · ${CONTRACT_TYPE_LABELS_VI[selectedSubLedger.contract_type]}`
                : "Trạng thái số dư các sổ"}
            </p>
            <p
              data-testid="vfin-detail-current-balance"
              className="mt-1.5 whitespace-nowrap font-mono text-xl font-semibold tabular-nums text-foreground"
            >
              {balancePresentation ? balancePresentation.signedText : "—"}
            </p>
            <p className="mt-1 text-xs text-muted">
              {selectedSubLedger && selectedSubLedger.responsible_accountant_display_name
                ? `KT phụ trách: ${selectedSubLedger.responsible_accountant_display_name}`
                : vendor
                  ? `${vendor.entry_count} bút toán trong phạm vi đang xem`
                  : "Đang tải…"}
            </p>
          </Card>

          <Card className="p-4">
            <p className="text-xs font-medium text-muted">Tổng phát sinh công nợ</p>
            <p className="mt-1.5 whitespace-nowrap font-mono text-lg font-semibold tabular-nums text-foreground">
              {vendor ? formatVndMinor(vendor.totals.debt_recorded_minor) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted">Ghi nhận phát sinh (+)</p>
          </Card>

          <Card className="p-4">
            <p className="text-xs font-medium text-muted">Lương đã ghi nhận</p>
            <p className="mt-1.5 whitespace-nowrap font-mono text-lg font-semibold tabular-nums text-foreground">
              {vendor ? formatVndMinor(vendor.totals.payroll_recorded_minor) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted">Bảng lương phải trả (+)</p>
          </Card>

          <Card className="p-4">
            <p className="text-xs font-medium text-muted">Đã thanh toán</p>
            <p className="mt-1.5 whitespace-nowrap font-mono text-lg font-semibold tabular-nums text-foreground">
              {vendor ? formatVndMinor(vendor.totals.payment_recorded_minor) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted">Thanh toán cho Vendor (-)</p>
          </Card>

          <Card className="p-4">
            <p className="text-xs font-medium text-muted">Đã tạm ứng</p>
            <p className="mt-1.5 whitespace-nowrap font-mono text-lg font-semibold tabular-nums text-foreground">
              {vendor ? formatVndMinor(vendor.totals.advance_recorded_minor) : "—"}
            </p>
            <p className="mt-1 text-xs text-muted">Chi tạm ứng (-)</p>
          </Card>
        </div>

        {vendor ? (
          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-surface px-4 py-3 text-xs sm:grid-cols-6">
            <div>
              <span className="text-muted">Đầu kỳ phải trả: </span>
              <strong className="whitespace-nowrap font-mono tabular-nums text-foreground">
                {formatVndMinor(vendor.totals.opening_payable_minor)}
              </strong>
            </div>
            <div>
              <span className="text-muted">Đầu kỳ dư ứng: </span>
              <strong className="whitespace-nowrap font-mono tabular-nums text-foreground">
                {formatVndMinor(vendor.totals.opening_advance_minor)}
              </strong>
            </div>
            <div>
              <span className="text-muted">Đã khấu trừ ứng: </span>
              <strong
                data-testid="vfin-detail-total-advance-offset"
                className="whitespace-nowrap font-mono tabular-nums text-foreground"
              >
                {formatVndMinor(vendor.totals.advance_offset_recorded_minor)}
              </strong>
            </div>
            <div>
              <span className="text-muted">Điều chỉnh tăng: </span>
              <strong className="whitespace-nowrap font-mono tabular-nums text-foreground">
                {formatVndMinor(vendor.totals.adjustment_increase_minor)}
              </strong>
            </div>
            <div>
              <span className="text-muted">Điều chỉnh giảm: </span>
              <strong className="whitespace-nowrap font-mono tabular-nums text-foreground">
                {formatVndMinor(vendor.totals.adjustment_decrease_minor)}
              </strong>
            </div>
            <div>
              <span className="text-muted">Đã hoàn tác: </span>
              <strong className="whitespace-nowrap font-mono tabular-nums text-foreground">
                {vendor.totals.reversed_entry_count} bút toán
              </strong>
            </div>
          </div>
        ) : null}
      </section>

      {/* Accessible Tab Switcher: Ledger vs Reconciliations vs Shared Advances */}
      <div
        role="tablist"
        aria-label="Chế độ xem chi tiết tài chính Vendor"
        className="flex flex-wrap items-center gap-2 border-b border-border pb-2"
      >
        <button
          ref={ledgerTabRef}
          id={ledgerTabId}
          type="button"
          role="tab"
          aria-selected={resolvedActiveTab === "ledger"}
          aria-controls={ledgerPanelId}
          tabIndex={resolvedActiveTab === "ledger" ? 0 : -1}
          onKeyDown={handleTabKeyDown}
          onClick={() => setActiveTab("ledger")}
          className={buttonClasses({
            variant: resolvedActiveTab === "ledger" ? "soft" : "ghost",
            size: "md",
          })}
        >
          Sổ cái giao dịch {vendor ? `(${vendor.entry_count})` : ""}
        </button>

        <button
          ref={recTabRef}
          id={recTabId}
          type="button"
          role="tab"
          aria-selected={resolvedActiveTab === "reconciliations"}
          aria-controls={recPanelId}
          tabIndex={resolvedActiveTab === "reconciliations" ? 0 : -1}
          onKeyDown={handleTabKeyDown}
          onClick={() => setActiveTab("reconciliations")}
          className={buttonClasses({
            variant: resolvedActiveTab === "reconciliations" ? "soft" : "ghost",
            size: "md",
          })}
        >
          Đối soát theo ngày {recData ? `(${recData.total})` : ""}
        </button>

        {canViewSharedAdvance ? (
          <button
            ref={sharedAdvTabRef}
            id={sharedAdvTabId}
            type="button"
            role="tab"
            data-testid="vfin-tab-shared-advances"
            aria-selected={resolvedActiveTab === "shared_advances"}
            aria-controls={sharedAdvPanelId}
            tabIndex={resolvedActiveTab === "shared_advances" ? 0 : -1}
            onKeyDown={handleTabKeyDown}
            onClick={() => setActiveTab("shared_advances")}
            className={buttonClasses({
              variant: resolvedActiveTab === "shared_advances" ? "soft" : "ghost",
              size: "md",
            })}
          >
            Ứng dùng chung {vendor ? `(${vendor.shared_advance_movement_count ?? 0})` : ""}
          </button>
        ) : null}
      </div>

      {/* =====================================================================
          TAB 1: LEDGER ENTRIES (Keyset Paginated)
         ===================================================================== */}
      <section
        id={ledgerPanelId}
        role="tabpanel"
        aria-labelledby={ledgerTabId}
        hidden={resolvedActiveTab !== "ledger"}
        data-ui-panel-motion="true"
        className="space-y-4"
      >
        <FilterToolbar
          summary={
            <span aria-live="polite" className="font-mono tabular-nums">
              {entriesLoading
                ? "Đang tải sổ cái giao dịch…"
                : `Đang hiển thị ${entries.length} bút toán${hasMoreEntries ? " (còn trang tiếp)" : ""}`}
            </span>
          }
          actions={
            (canRecord && allowedEntryTypes.length > 0) || canApplySharedAdvanceOffset ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {canRecord && allowedEntryTypes.includes("PAYMENT_RECORDED") ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRecordInitialType("PAYMENT_RECORDED");
                      setRecordDialogOpen(true);
                    }}
                  >
                    + Thanh toán
                  </Button>
                ) : null}
                {canApplySharedAdvanceOffset ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    data-testid="vfin-quick-apply-offset-btn"
                    onClick={openUnifiedOffsetDialog}
                  >
                    + Khấu trừ ứng
                  </Button>
                ) : null}
                {canRecord && allowedEntryTypes.includes("PAYROLL_RECORDED") ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRecordInitialType("PAYROLL_RECORDED");
                      setRecordDialogOpen(true);
                    }}
                  >
                    + Lương
                  </Button>
                ) : null}
              </div>
            ) : null
          }
        >
          <div className="max-w-xs space-y-1.5">
            <label
              htmlFor={entryTypeFilterId}
              className="block text-xs sm:text-sm font-semibold text-foreground"
            >
              Lọc theo loại bút toán
            </label>
            <select
              id={entryTypeFilterId}
              value={entryTypeFilter}
              onChange={(e) => setEntryTypeFilter(e.target.value as VendorFinanceEntryType | "")}
              className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <option value="">Tất cả loại bút toán</option>
              {VFIN_UI_ENTRY_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ENTRY_TYPE_LABELS_VI[type]}
                </option>
              ))}
            </select>
          </div>
        </FilterToolbar>

        {entriesError ? (
          <div className="space-y-3">
            <Alert tone="error" role="alert" title="Không thể tải sổ cái giao dịch">
              <p>{entriesError}</p>
            </Alert>
            <Button variant="secondary" onClick={triggerReloadAll}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Thử lại
            </Button>
          </div>
        ) : entriesLoading && entries.length === 0 ? (
          <Card className="p-8 text-center">
            <p role="status" aria-live="polite" className="text-sm text-muted">
              Đang tải sổ cái giao dịch…
            </p>
          </Card>
        ) : entries.length === 0 ? (
          <Card className="p-8 text-center space-y-2">
            <p className="text-sm font-medium text-foreground">
              Chưa có bút toán nào phù hợp trong sổ đang chọn.
            </p>
            <p className="text-xs text-muted">
              {canRecord
                ? "Bạn có thể khởi tạo số dư đầu kỳ cho sổ dự án (nếu chưa mở kỳ) hoặc ghi nhận khoản tiền mới."
                : "Khi kế toán ghi nhận giao dịch vào sổ dự án, lịch sử sổ cái sẽ hiển thị tại đây."}
            </p>
          </Card>
        ) : (
          <DataTableContainer
            dataTestId="vfin-ledger-table"
            footer={
              hasMoreEntries ? (
                <div className="flex justify-center">
                  <CursorLoadMore
                    hasMore={hasMoreEntries}
                    loading={loadingMoreEntries}
                    onLoadMore={() => void handleLoadMoreEntries()}
                    label="Tải thêm bút toán cũ hơn"
                  />
                </div>
              ) : null
            }
          >
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} !px-2.5 !py-2.5 md:max-w-[16rem] !whitespace-normal`}>
                    Chứng từ / Sổ dự án
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} !px-2.5 !py-2.5 whitespace-nowrap`}>
                    Ngày hiệu lực
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} !px-2.5 !py-2.5 !whitespace-normal`}>
                    Loại bút toán & Lý do
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} !px-2.5 !py-2.5 text-right whitespace-nowrap`}>
                    Biến động (VND)
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} !px-2.5 !py-2.5 text-right whitespace-nowrap`}>
                    Số dư sổ sau GD
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} !px-2.5 !py-2.5 whitespace-nowrap`}>
                    Bằng chứng
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} !px-2.5 !py-2.5 text-right whitespace-nowrap`}>
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const isReversed = entry.reversed_by_entry_id !== null;
                  const isReversal = entry.entry_type === "REVERSAL";
                  const recordedOnBehalf =
                    entry.responsible_accountant_display_name !== null &&
                    entry.created_by_display_name !== entry.responsible_accountant_display_name;

                  return (
                    <tr key={entry.entry_id} className={DATA_TABLE_ROW_CLASS}>
                      <td
                        data-card-header="true"
                        className={`${DATA_TABLE_TD_CLASS} !px-2.5 !py-2.5 md:max-w-[16rem] whitespace-normal break-words`}
                      >
                        <div className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Link
                              href={`/finance/documents/${encodeURIComponent(entry.entry_id)}`}
                              className="font-mono text-xs sm:text-sm font-semibold text-primary hover:underline"
                            >
                              {entry.document_no}
                            </Link>
                            <StatusBadge tone={CONTRACT_TYPE_BADGE_TONES[entry.contract_type]}>
                              {CONTRACT_TYPE_LABELS_VI[entry.contract_type]}
                            </StatusBadge>
                          </div>
                          <p className="text-xs font-medium text-foreground break-words">
                            {entry.ledger_scope === "LEGACY_UNALLOCATED"
                              ? "Sổ lịch sử VFIN-01"
                              : `${entry.project_display_name_snapshot ?? entry.project_id} · KT: ${entry.responsible_accountant_display_name ?? "—"}`}
                          </p>
                          <p className="font-mono text-[11px] text-muted">
                            #{entry.vendor_sequence} · Người nhập: {entry.created_by_display_name}
                            {recordedOnBehalf ? " (Ghi hộ)" : ""}
                          </p>
                        </div>
                      </td>

                      <td data-label="Ngày hiệu lực" className={`${DATA_TABLE_TD_CLASS} !px-2.5 !py-2.5`}>
                        <div className="space-y-0.5 text-xs">
                          <p className="font-mono font-medium text-foreground">
                            {formatVietnamDateLabel(entry.effective_date)}
                          </p>
                          <p className="text-muted">{formatTimestampVi(entry.created_at)}</p>
                        </div>
                      </td>

                      <td data-label="Loại & Lý do" className={`${DATA_TABLE_TD_CLASS} !px-2.5 !py-2.5`}>
                        <div className="space-y-1 max-w-md">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusBadge tone={isReversal ? "danger" : "primary"}>
                              {ENTRY_TYPE_LABELS_VI[entry.entry_type]}
                            </StatusBadge>
                            {isReversed ? (
                              <StatusBadge tone="warning">
                                Đã hoàn tác bởi {entry.reversed_by_document_no}
                              </StatusBadge>
                            ) : null}
                            {entry.reverses_document_no ? (
                              <StatusBadge tone="neutral">
                                Đảo cho {entry.reverses_document_no}
                              </StatusBadge>
                            ) : null}
                          </div>
                          <p className="text-xs text-foreground break-words">{entry.reason}</p>
                        </div>
                      </td>

                      <td
                        data-label="Biến động (VND)"
                        className={`${DATA_TABLE_TD_CLASS} !px-2.5 !py-2.5 text-right font-mono tabular-nums`}
                      >
                        <div className="space-y-0.5">
                          <p className="whitespace-nowrap font-semibold text-foreground">
                            {formatSignedVndDelta(entry.balance_delta_minor)}
                          </p>
                          <p className="whitespace-nowrap text-xs text-muted">
                            Gốc: {formatVndMinor(entry.amount_minor)}
                          </p>
                        </div>
                      </td>

                      <td
                        data-label="Số dư sổ sau GD"
                        className={`${DATA_TABLE_TD_CLASS} !px-2.5 !py-2.5 text-right font-mono tabular-nums`}
                      >
                        <div className="space-y-0.5">
                          <p className="whitespace-nowrap font-semibold text-foreground">
                            {formatVndMinor(entry.balance_after_minor)}
                          </p>
                          <p className="whitespace-nowrap text-xs text-muted">
                            Trước: {formatVndMinor(entry.balance_before_minor)}
                          </p>
                        </div>
                      </td>

                      <td data-label="Bằng chứng" className={`${DATA_TABLE_TD_CLASS} !px-2.5 !py-2.5`}>
                        {entry.evidence ? (
                          <StatusBadge tone="success" dot>
                            Có ảnh
                          </StatusBadge>
                        ) : (
                          <span className="text-xs text-muted">Chưa có</span>
                        )}
                      </td>

                      <td
                        data-card-actions="true"
                        className={`${DATA_TABLE_TD_CLASS} !px-2.5 !py-2.5 text-right`}
                      >
                        <RowActionCluster>
                          <Link
                            href={`/finance/documents/${encodeURIComponent(entry.entry_id)}`}
                            className={buttonClasses({ variant: "secondary", size: "sm" })}
                          >
                            <Printer className="h-3.5 w-3.5" aria-hidden />
                            Chứng từ
                          </Link>

                          {entry.evidence ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                setViewingEvidence({
                                  evidence: entry.evidence!,
                                  label: `Chứng từ ${entry.document_no} (${vendor?.display_name ?? vendorId})`,
                                })
                              }
                            >
                              <Eye className="h-3.5 w-3.5" aria-hidden />
                              Xem ảnh
                            </Button>
                          ) : canRecord && entry.can_attach_evidence ? (
                            <Button
                              variant="soft"
                              size="sm"
                              onClick={() =>
                                setAttachingEvidence({
                                  targetKind: "ENTRY",
                                  targetId: entry.entry_id,
                                  label: `Chứng từ ${entry.document_no}`,
                                })
                              }
                            >
                              <ImagePlus className="h-3.5 w-3.5" aria-hidden />
                              Đính kèm ảnh
                            </Button>
                          ) : null}

                          {canRecord && entry.can_reverse ? (
                            <Button
                              variant="danger-outline"
                              size="sm"
                              onClick={() => setReversingEntry(entry)}
                            >
                              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                              Hoàn tác
                            </Button>
                          ) : null}
                        </RowActionCluster>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTableContainer>
        )}
      </section>

      {/* =====================================================================
          TAB 2: DAILY RECONCILIATIONS (Offset Paginated)
         ===================================================================== */}
      <section
        id={recPanelId}
        role="tabpanel"
        aria-labelledby={recTabId}
        hidden={resolvedActiveTab !== "reconciliations"}
        data-ui-panel-motion="true"
        className="space-y-4"
      >
        <Alert tone="info" title="Nguyên tắc đối soát công nợ theo sổ dự án">
          <p>
            Biên bản đối soát lưu lại <strong>Số dư hệ thống của đúng sổ Dự án × Kế toán</strong>,{" "}
            <strong>Số dư Vendor xác nhận</strong> và <strong>Chênh lệch</strong> tại ngày chốt; hệ
            thống không tự động tạo bút toán điều chỉnh vào sổ cái.
          </p>
        </Alert>

        {vendor?.latest_reconciliation ? (
          <Card className="p-4 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-foreground">
                Kỳ đối soát gần nhất:{" "}
                <span className="font-mono">
                  {formatVietnamDateLabel(vendor.latest_reconciliation.as_of_date)}
                </span>
                {vendor.latest_reconciliation.project_display_name_snapshot ? (
                  <span className="ml-2 text-xs font-normal text-muted">
                    ({vendor.latest_reconciliation.project_display_name_snapshot} ·{" "}
                    {CONTRACT_TYPE_LABELS_VI[vendor.latest_reconciliation.contract_type]} · KT:{" "}
                    {vendor.latest_reconciliation.responsible_accountant_display_name ?? "—"})
                  </span>
                ) : null}
              </p>
              <StatusBadge
                tone={vendor.latest_reconciliation.difference_minor === "0" ? "success" : "warning"}
              >
                {vendor.latest_reconciliation.difference_minor === "0"
                  ? "Khớp số dư"
                  : `Lệch ${formatSignedVndDelta(vendor.latest_reconciliation.difference_minor)}`}
              </StatusBadge>
            </div>
            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-3">
              <div>
                <span className="text-muted">Số hệ thống: </span>
                <strong className="whitespace-nowrap font-mono text-foreground">
                  {formatVndMinor(vendor.latest_reconciliation.system_balance_minor)}
                </strong>
              </div>
              <div>
                <span className="text-muted">Số xác nhận: </span>
                <strong className="whitespace-nowrap font-mono text-foreground">
                  {formatVndMinor(vendor.latest_reconciliation.confirmed_balance_minor)}
                </strong>
              </div>
              <div>
                <span className="text-muted">Chênh lệch: </span>
                <strong className="whitespace-nowrap font-mono text-foreground">
                  {formatSignedVndDelta(vendor.latest_reconciliation.difference_minor)}
                </strong>
              </div>
            </div>
          </Card>
        ) : null}

        {recError ? (
          <div className="space-y-3">
            <Alert tone="error" role="alert" title="Không thể tải lịch sử đối soát">
              <p>{recError}</p>
            </Alert>
            <Button variant="secondary" onClick={triggerReloadAll}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Thử lại
            </Button>
          </div>
        ) : recLoading && !recData ? (
          <Card className="p-8 text-center">
            <p role="status" aria-live="polite" className="text-sm text-muted">
              Đang tải lịch sử đối soát…
            </p>
          </Card>
        ) : recData && recData.reconciliations.length === 0 ? (
          <Card className="p-8 text-center space-y-3">
            <p className="text-sm font-medium text-foreground">
              Chưa có biên bản đối soát nào trong phạm vi sổ đang xem.
            </p>
            {canReconcile && reconcilableSubLedgers.length > 0 ? (
              <div className="flex justify-center">
                <Button variant="primary" onClick={() => setReconcileDialogOpen(true)}>
                  <Scale className="h-4 w-4" aria-hidden />
                  Tạo đối soát đầu tiên
                </Button>
              </div>
            ) : null}
          </Card>
        ) : recData ? (
          <DataTableContainer
            dataTestId="vfin-reconciliations-table"
            footer={
              <OffsetPager
                page={recData.page}
                pageCount={recPageCount}
                total={recData.total}
                ariaLabel="Phân trang lịch sử đối soát"
                disabled={recLoading}
                nextDisabled={recLoading || (!recData.has_more && recData.page >= recPageCount)}
                onPageChange={(next) => setRecPage(next)}
                className="mt-0 border-t-0 pt-0"
              />
            }
          >
            <table className={DATA_TABLE_CLASS}>
              <thead className={DATA_TABLE_HEAD_CLASS}>
                <tr>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Ngày đối soát & Sổ dự án
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Số dư hệ thống
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Số dư xác nhận
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Chênh lệch
                  </th>
                  <th scope="col" className={DATA_TABLE_TH_CLASS}>
                    Ghi chú & Người chốt
                  </th>
                  <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                    Bằng chứng
                  </th>
                </tr>
              </thead>
              <tbody>
                {recData.reconciliations.map((rec: VendorFinanceReconciliationProjection) => {
                  const isMatched = rec.difference_minor === "0";
                  return (
                    <tr key={rec.reconciliation_id} className={DATA_TABLE_ROW_CLASS}>
                      <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono font-semibold text-foreground">
                              {formatVietnamDateLabel(rec.as_of_date)}
                            </span>
                            <StatusBadge tone={CONTRACT_TYPE_BADGE_TONES[rec.contract_type]}>
                              {CONTRACT_TYPE_LABELS_VI[rec.contract_type]}
                            </StatusBadge>
                          </div>
                          <p className="text-xs font-medium text-foreground">
                            {rec.ledger_scope === "LEGACY_UNALLOCATED"
                              ? "Sổ lịch sử VFIN-01"
                              : `${rec.project_display_name_snapshot ?? rec.project_id} · KT: ${rec.responsible_accountant_display_name ?? "—"}`}
                          </p>
                          <p className="font-mono text-[11px] text-muted">
                            Đến bút toán #{rec.ledger_sequence_at_reconciliation}
                          </p>
                        </div>
                      </td>

                      <td
                        data-label="Số dư hệ thống"
                        className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums whitespace-nowrap`}
                      >
                        <span className="whitespace-nowrap">
                          {formatVndMinor(rec.system_balance_minor)}
                        </span>
                      </td>

                      <td
                        data-label="Số dư xác nhận"
                        className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums whitespace-nowrap`}
                      >
                        <span className="whitespace-nowrap">
                          {formatVndMinor(rec.confirmed_balance_minor)}
                        </span>
                      </td>

                      <td
                        data-label="Chênh lệch"
                        className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                      >
                        <div className="inline-flex flex-col items-end gap-1">
                          <span className="whitespace-nowrap font-semibold">
                            {formatSignedVndDelta(rec.difference_minor)}
                          </span>
                          <StatusBadge tone={isMatched ? "success" : "warning"}>
                            {isMatched ? "Khớp" : "Có chênh lệch"}
                          </StatusBadge>
                        </div>
                      </td>

                      <td data-label="Ghi chú" className={DATA_TABLE_TD_CLASS}>
                        <div className="space-y-0.5 max-w-md text-xs">
                          <p className="text-foreground break-words">{rec.reason}</p>
                          <p className="text-muted">
                            Người đối soát: {rec.created_by_display_name} ·{" "}
                            {formatTimestampVi(rec.created_at)}
                          </p>
                        </div>
                      </td>

                      <td
                        data-card-actions="true"
                        className={`${DATA_TABLE_TD_CLASS} text-right`}
                      >
                        <RowActionCluster>
                          {rec.evidence ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() =>
                                setViewingEvidence({
                                  evidence: rec.evidence!,
                                  label: `Đối soát ngày ${formatVietnamDateLabel(rec.as_of_date)} (${vendor?.display_name ?? vendorId})`,
                                })
                              }
                            >
                              <Eye className="h-3.5 w-3.5" aria-hidden />
                              Xem ảnh
                            </Button>
                          ) : canReconcile && rec.can_attach_evidence ? (
                            <Button
                              variant="soft"
                              size="sm"
                              onClick={() =>
                                setAttachingEvidence({
                                  targetKind: "RECONCILIATION",
                                  targetId: rec.reconciliation_id,
                                  label: `Đối soát ngày ${formatVietnamDateLabel(rec.as_of_date)}`,
                                })
                              }
                            >
                              <ImagePlus className="h-3.5 w-3.5" aria-hidden />
                              Đính kèm ảnh
                            </Button>
                          ) : (
                            <span className="text-xs text-muted">Chưa có ảnh</span>
                          )}
                        </RowActionCluster>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DataTableContainer>
        ) : null}
      </section>

      {/* =====================================================================
          TAB 3: SHARED ADVANCES LEDGER (Keyset Paginated)
         ===================================================================== */}
      {canViewSharedAdvance ? (
        <section
          id={sharedAdvPanelId}
          role="tabpanel"
          aria-labelledby={sharedAdvTabId}
          hidden={resolvedActiveTab !== "shared_advances"}
          data-ui-panel-motion="true"
          className="space-y-4"
        >
          <FilterToolbar
            summary={
              <span aria-live="polite" className="font-mono tabular-nums">
                {sharedMovementsLoading
                  ? "Đang tải sổ ứng dùng chung…"
                  : `Đang hiển thị ${sharedMovements.length} giao dịch ứng dùng chung${hasMoreSharedMovements ? " (còn trang tiếp)" : ""}`}
              </span>
            }
            actions={
              canFundVendorAdvance || canRecordVendorRefund || canApplySharedAdvanceOffset ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {canFundVendorAdvance && vendor ? (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!vendor.active}
                      onClick={() => setFundAdvanceDialogOpen(true)}
                    >
                      + Ứng tiền cho Vendor
                    </Button>
                  ) : null}
                  {canRecordVendorRefund ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={BigInt(sharedAdvanceBalanceMinor) <= BigInt(0)}
                      onClick={() => setRefundDialogOpen(true)}
                    >
                      + Vendor hoàn ứng
                    </Button>
                  ) : null}
                  {canApplySharedAdvanceOffset ? (
                    <Button
                      variant="soft"
                      size="sm"
                      onClick={openUnifiedOffsetDialog}
                    >
                      + Khấu trừ ứng
                    </Button>
                  ) : null}
                </div>
              ) : null
            }
          >
            <div className="max-w-xs space-y-1.5">
              <label
                htmlFor={movementTypeFilterId}
                className="block text-xs sm:text-sm font-semibold text-foreground"
              >
                Lọc theo loại giao dịch ứng
              </label>
              <select
                id={movementTypeFilterId}
                data-testid="vfin-shared-advance-type-filter"
                value={movementTypeFilter}
                onChange={(e) =>
                  setMovementTypeFilter(e.target.value as VendorFinanceSharedAdvanceMovementType | "")
                }
                className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <option value="">Tất cả giao dịch ứng</option>
                {VFIN_UI_SHARED_ADVANCE_MOVEMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {SHARED_ADVANCE_MOVEMENT_TYPE_LABELS_VI[type]}
                  </option>
                ))}
              </select>
            </div>
          </FilterToolbar>

          {sharedMovementsError ? (
            <div className="space-y-3">
              <Alert tone="error" role="alert" title="Không thể tải lịch sử ứng dùng chung">
                <p>{sharedMovementsError}</p>
              </Alert>
              <Button variant="secondary" onClick={triggerReloadAll}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                Thử lại
              </Button>
            </div>
          ) : sharedMovementsLoading && sharedMovements.length === 0 ? (
            <Card className="p-8 text-center">
              <p role="status" aria-live="polite" className="text-sm text-muted">
                Đang tải lịch sử ứng dùng chung…
              </p>
            </Card>
          ) : sharedMovements.length === 0 ? (
            <Card className="p-8 text-center space-y-2">
              <p className="text-sm font-medium text-foreground">
                Chưa có giao dịch ứng dùng chung nào phù hợp với bộ lọc.
              </p>
              <p className="text-xs text-muted">
                Các giao dịch ứng tiền cho Vendor, hoàn ứng và khấu trừ ứng vào sổ dự án sẽ hiển thị tại đây.
              </p>
            </Card>
          ) : (
            <DataTableContainer
              dataTestId="vfin-shared-advances-table"
              footer={
                hasMoreSharedMovements ? (
                  <div className="flex justify-center">
                    <CursorLoadMore
                      hasMore={hasMoreSharedMovements}
                      loading={loadingMoreSharedMovements}
                      onLoadMore={() => void handleLoadMoreSharedMovements()}
                      label="Tải thêm giao dịch ứng cũ hơn"
                    />
                  </div>
                ) : null
              }
            >
              <table className={DATA_TABLE_CLASS}>
                <thead className={DATA_TABLE_HEAD_CLASS}>
                  <tr>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Chứng từ sổ ứng
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Ngày hiệu lực
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Loại giao dịch & Lý do
                    </th>
                    <th scope="col" className={DATA_TABLE_TH_CLASS}>
                      Sổ dự án / Hợp đồng liên kết
                    </th>
                    <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                      Biến động (VND)
                    </th>
                    <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                      Số dư ứng sau GD
                    </th>
                    <th scope="col" className={`${DATA_TABLE_TH_CLASS} text-right`}>
                      Thao tác
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sharedMovements.map((movement) => {
                    const isReversed = movement.reversed_by_movement_id !== null;
                    const isReversal = movement.movement_type === "REVERSAL";
                    const isRedactedCrossProject =
                      movement.reason === null || movement.created_by_display_name === null;

                    return (
                      <tr key={movement.movement_id} className={DATA_TABLE_ROW_CLASS}>
                        <td data-card-header="true" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5">
                            <span className="font-mono text-xs sm:text-sm font-semibold text-foreground">
                              {movement.document_no}
                            </span>
                            <p className="font-mono text-[11px] text-muted">
                              #{movement.vendor_advance_sequence} · Người tạo:{" "}
                              {movement.created_by_display_name ?? VFIN_UI_REDACTED_FIELD_LABEL_VI}
                            </p>
                          </div>
                        </td>

                        <td data-label="Ngày hiệu lực" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-0.5 text-xs">
                            <p className="font-mono font-medium text-foreground">
                              {formatVietnamDateLabel(movement.effective_date)}
                            </p>
                            <p className="text-muted">{formatTimestampVi(movement.created_at)}</p>
                          </div>
                        </td>

                        <td data-label="Loại & Lý do" className={DATA_TABLE_TD_CLASS}>
                          <div className="space-y-1 max-w-md">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <StatusBadge tone={isReversal ? "danger" : "primary"}>
                                {SHARED_ADVANCE_MOVEMENT_TYPE_LABELS_VI[movement.movement_type]}
                              </StatusBadge>
                              {isReversed ? (
                                <StatusBadge tone="warning">
                                  Đã hoàn tác bởi {movement.reversed_by_document_no}
                                </StatusBadge>
                              ) : null}
                              {movement.reverses_document_no ? (
                                <StatusBadge tone="neutral">
                                  Đảo cho {movement.reverses_document_no}
                                </StatusBadge>
                              ) : null}
                            </div>
                            <p className="text-xs text-foreground break-words">
                              {movement.reason ?? VFIN_UI_REDACTED_FIELD_LABEL_VI}
                            </p>
                          </div>
                        </td>

                        <td data-label="Sổ dự án liên kết" className={DATA_TABLE_TD_CLASS}>
                          {movement.project_id ? (
                            <div className="space-y-0.5 text-xs">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-medium text-foreground">
                                  {movement.project_display_name_snapshot ?? movement.project_id}
                                </span>
                                {movement.contract_type ? (
                                  <StatusBadge tone={CONTRACT_TYPE_BADGE_TONES[movement.contract_type]}>
                                    {CONTRACT_TYPE_LABELS_VI[movement.contract_type]}
                                  </StatusBadge>
                                ) : null}
                              </div>
                              {movement.project_entry_id ? (
                                <p className="font-mono text-[11px] text-muted">
                                  Bút toán sổ:{" "}
                                  <Link
                                    href={`/finance/documents/${encodeURIComponent(movement.project_entry_id)}`}
                                    className="text-primary hover:underline"
                                  >
                                    Xem chứng từ công nợ
                                  </Link>
                                </p>
                              ) : null}
                            </div>
                          ) : isRedactedCrossProject ? (
                            <span className="text-xs italic text-muted">
                              {VFIN_UI_REDACTED_FIELD_LABEL_VI}
                            </span>
                          ) : (
                            <span className="text-xs text-muted">Cấp Vendor (Dùng chung)</span>
                          )}
                        </td>

                        <td
                          data-label="Biến động (VND)"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                        >
                          <div className="space-y-0.5">
                            <p className="whitespace-nowrap font-semibold text-foreground">
                              {formatSignedVndDelta(movement.balance_delta_minor)}
                            </p>
                            <p className="whitespace-nowrap text-xs text-muted">
                              Gốc: {formatVndMinor(movement.amount_minor)}
                            </p>
                          </div>
                        </td>

                        <td
                          data-label="Số dư ứng sau GD"
                          className={`${DATA_TABLE_TD_CLASS} text-right font-mono tabular-nums`}
                        >
                          <div className="space-y-0.5">
                            <p className="whitespace-nowrap font-semibold text-foreground">
                              {formatVndMinor(movement.balance_after_minor)}
                            </p>
                            <p className="whitespace-nowrap text-xs text-muted">
                              Trước: {formatVndMinor(movement.balance_before_minor)}
                            </p>
                          </div>
                        </td>

                        <td
                          data-card-actions="true"
                          className={`${DATA_TABLE_TD_CLASS} text-right`}
                        >
                          <RowActionCluster>
                            {movement.can_reverse ? (
                              <Button
                                variant="danger-outline"
                                size="sm"
                                data-testid="vfin-reverse-shared-movement-btn"
                                onClick={() => setReversingSharedMovement(movement)}
                              >
                                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                                Hoàn tác
                              </Button>
                            ) : (
                              <span className="text-xs text-muted">—</span>
                            )}
                          </RowActionCluster>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </DataTableContainer>
          )}
        </section>
      ) : null}

      {/* Modals (mounted conditionally so defaults always reflect fresh server state) */}
      {vendor && recordDialogOpen ? (
        <RecordVendorEntryDialog
          open={recordDialogOpen}
          onOpenChange={setRecordDialogOpen}
          vendorId={vendor.vendor_id}
          vendorDisplayName={vendor.display_name}
          vendorActive={vendor.active}
          recordableProjects={recordableProjectsForVendor}
          subLedgers={subLedgers}
          currentSharedAdvanceMinor={sharedAdvanceBalanceMinor}
          canApplyVendorAdvance={allowedActions?.can_apply_vendor_advance === true}
          initialProjectId={selectedSubLedger?.project_id ?? scopeFilter.projectId}
          initialContractType={
            selectedSubLedger &&
            (selectedSubLedger.contract_type === "SEASONAL" ||
              selectedSubLedger.contract_type === "OFFICIAL")
              ? selectedSubLedger.contract_type
              : scopeFilter.contractType === "SEASONAL" || scopeFilter.contractType === "OFFICIAL"
                ? scopeFilter.contractType
                : null
          }
          defaultDate={detail?.authorization_date ?? ""}
          allowedEntryTypes={allowedEntryTypes}
          initialEntryType={recordInitialType}
          onDataChanged={triggerReloadAll}
        />
      ) : null}

      {reversingEntry ? (
        <ReverseVendorEntryDialog
          open={Boolean(reversingEntry)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setReversingEntry(null);
          }}
          entry={reversingEntry}
          defaultDate={detail?.authorization_date ?? ""}
          onReversed={triggerReloadAll}
        />
      ) : null}

      {vendor && reconcileDialogOpen ? (
        <CreateVendorReconciliationDialog
          open={reconcileDialogOpen}
          onOpenChange={setReconcileDialogOpen}
          vendorId={vendor.vendor_id}
          vendorDisplayName={vendor.display_name}
          reconcilableSubLedgers={reconcilableSubLedgers}
          initialSubLedgerKey={
            selectedSubLedger && selectedSubLedger.project_id
              ? `${selectedSubLedger.project_id}:${selectedSubLedger.accountant_ref ?? ""}:${selectedSubLedger.contract_type}`
              : null
          }
          defaultAsOfDate={detail?.authorization_date ?? ""}
          onDataChanged={triggerReloadAll}
        />
      ) : null}

      {vendor && classifyingSubLedger ? (
        <ClassifyVendorSubLedgerDialog
          open={Boolean(classifyingSubLedger)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setClassifyingSubLedger(null);
          }}
          vendorId={vendor.vendor_id}
          vendorDisplayName={vendor.display_name}
          subLedger={classifyingSubLedger}
          onClassified={(targetContractType) => {
            const prevSub = classifyingSubLedger;
            setClassifyingSubLedger(null);
            if (prevSub && prevSub.project_id) {
              setScopeFilter({
                ledgerScope: "PROJECT_ACCOUNTANT",
                projectId: prevSub.project_id,
                accountantRef: prevSub.accountant_ref,
                contractType: targetContractType,
              });
            }
            triggerReloadAll();
          }}
        />
      ) : null}

      <VendorEvidenceViewerDialog
        open={Boolean(viewingEvidence)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setViewingEvidence(null);
        }}
        evidence={viewingEvidence?.evidence ?? null}
        contextLabel={viewingEvidence?.label ?? ""}
      />

      {attachingEvidence ? (
        <VendorEvidenceAttachDialog
          open={Boolean(attachingEvidence)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setAttachingEvidence(null);
          }}
          targetKind={attachingEvidence.targetKind}
          targetId={attachingEvidence.targetId}
          contextLabel={attachingEvidence.label}
          onUploaded={() => triggerReloadAll()}
        />
      ) : null}

      {vendor && fundAdvanceDialogOpen ? (
        <FundVendorSharedAdvanceDialog
          open={fundAdvanceDialogOpen}
          onOpenChange={setFundAdvanceDialogOpen}
          vendorId={vendor.vendor_id}
          vendorDisplayName={vendor.display_name}
          currentSharedAdvanceMinor={sharedAdvanceBalanceMinor}
          defaultDate={detail?.authorization_date ?? ""}
          onDataChanged={triggerReloadAll}
        />
      ) : null}

      {vendor && refundDialogOpen ? (
        <RecordVendorRefundDialog
          open={refundDialogOpen}
          onOpenChange={setRefundDialogOpen}
          vendorId={vendor.vendor_id}
          vendorDisplayName={vendor.display_name}
          currentSharedAdvanceMinor={sharedAdvanceBalanceMinor}
          defaultDate={detail?.authorization_date ?? ""}
          onDataChanged={triggerReloadAll}
        />
      ) : null}

      {reversingSharedMovement ? (
        <ReverseVendorSharedAdvanceMovementDialog
          open={Boolean(reversingSharedMovement)}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) setReversingSharedMovement(null);
          }}
          movement={reversingSharedMovement}
          defaultDate={detail?.authorization_date ?? ""}
          onReversed={triggerReloadAll}
        />
      ) : null}
    </PageShell>
  );
}
