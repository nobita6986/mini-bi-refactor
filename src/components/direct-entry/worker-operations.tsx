"use client";

/**
 * P2.5-W06-R2 - Worker Operations UI.
 *
 * Cac view KHONG tron quyen. Moi tab giu page state rieng: 403 cua mot audience chi la
 * loi CUC BO trong tab do, khong thao ca trang/tab khac.
 *
 * Pagination: projectSubmissionListPage / projectWorkerDirectoryPage;
 * append dedupe theo stable id; doi tab/filter reset cursor.
 * Direct-edit and proposal CTAs use their server-projected row actions.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";

import { WorkerDetailDialog } from "@/components/direct-entry/worker-detail-dialog";
import { StatusBadge, submissionStateBadgeProps } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { CatalogFilterCombobox, type CatalogFilterOption } from "@/components/ui/catalog-filter-combobox";
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
import { PageHeader } from "@/components/ui/page-shell";
import { useNotify } from "@/components/ui/notify-provider";
import { formatHcmDateTime, shortRef } from "@/lib/direct-entry/submission-lifecycle";
import {
  BANK_ACCOUNT_SECTION_LABEL,
  DIRECT_EDIT_DOCUMENT_ACCEPT,
  DIRECT_EDIT_DOCUMENT_LABELS,
  DIRECT_EDIT_DOCUMENT_TYPES,
  EMPTY_WORKER_DIRECTORY_FILTERS,
  WORKER_CONFLICT_MESSAGE,
  WORKER_OPERATIONS_TAB_HINTS,
  WORKER_OPERATIONS_TAB_LABELS,
  WORKER_PAGE_SIZE,
  WORKER_PROPOSE_TARGETS,
  WORKER_PROPOSE_TARGET_LABELS,
  WORKER_PROVIDER_TYPES,
  applyPage,
  bankAccountSummary,
  canSelectQuickOffboardingWorker,
  buildDirectEditEntryFieldProposal,
  buildDirectEditPaymentPatch,
  buildWorkerEditProjectOptions,
  buildWorkerEditRecruiterOptions,
  checkDirectEditDocumentFile,
  directEditDocumentErrorMessage,
  directEditWorkerFormFromBaseline,
  emptyTabPage,
  failLoad,
  hasActiveWorkerDirectoryFilters,
  initialDirectEditBankQueryText,
  initialWorkerTab,
  mergeVietQrBankCatalog,
  parseSessionWorkerPermissionsResponse,
  parseSubmissionPageResponse,
  parseWorkerPageResponse,
  privilegedEditErrorMessage,
  proposeCta,
  reconcileWorkerOperationsPermissions,
  resetTabPage,
  resolveBankCatalogOption,
  resolveInitialWorkerTab,
  submissionRowKey,
  submissionsQuery,
  tabScope,
  updateWorkerDirectoryFilter,
  uploadDirectEditDocument,
  validateWorkerDirectoryDateRange,
  visibleWorkerTabs,
  workerListErrorMessage,
  WORKER_LOAD_FAILED_MESSAGE,
  WORKER_NO_USABLE_TAB_MESSAGE,
  workerNameAvailability,
  workerProviderTypeLabel,
  workerRowKey,
  workerStatusLabel,
  workersQuery,
  type DirectEditDocumentType,
  type MergedBankCatalogOption,
  type PageState,
  type TabPage,
  type WorkerOperationsActor,
  type WorkerOperationsTab,
  type WorkerDirectoryFilters,
  type WorkerProposeTarget,
} from "@/lib/direct-entry/worker-operations-model";
import { filterCatalogSearchOptions } from "@/lib/direct-entry/catalog-search";
import { moveTypeaheadIndex, typeaheadKeyAction } from "@/lib/direct-entry/typeahead";
import {
  buildWorkerExportRequest,
  exportScopeForTab,
  isUsableWorkerExportBlob,
  workerExportErrorMessage,
  workerExportFilename,
  workerExportRequestMessage,
  WORKER_EXPORT_EMPTY_FILE_MESSAGE,
  WORKER_EXPORT_REASON_MAX,
  type WorkerExportScope,
} from "@/lib/direct-entry/worker-export-ui-model";
import type { SubmissionReadItem, WorkerDirectoryRow } from "@/lib/direct-entry/worker-operations-model";
import {
  WORKER_EMPLOYMENT_STATUSES,
  type WorkerDirectorySummary,
} from "@/lib/direct-entry/worker-directory-contract.ts";
import {
  buildChangeRequestItem,
  buildEntryFieldProposal,
  buildPaymentProposal,
  buildWorkStatusProposal,
  allowedWorkStatusTargets,
  hcmTodayDate,
  proposalErrorMessage,
  projectWorkerDetailsForProposal,
  workerEntryFormFromBaseline,
  WORKER_FORM_FIELDS,
  type WorkerFieldForm,
  type WorkerEntryFieldBaseline,
  type WorkerEntryFieldForm,
} from "@/lib/direct-entry/change-request-proposal-builders";
import { parseDirectEntryCatalogResponse } from "@/lib/direct-entry/catalog-response";
import {
  OPTIONAL_STATE_LABELS,
  PAYMENT_STATE_LABELS,
  WORKER_FIELD_LABELS,
} from "@/lib/direct-entry/change-request-read-projection";
import type { DraftCatalog } from "@/lib/direct-entry/write-repository";
import { projectPaymentInput, type PaymentState } from "@/lib/direct-entry/payment-contract";
import type { WorkerDetails, WorkerStatus } from "@/lib/contracts/direct-entry-v1";
import { isCanonicalLaborTypeKey } from "@/lib/contracts/direct-entry-v1";
import { sortedActiveLaborTypes } from "@/lib/direct-entry/labor-type-catalog-ui";

const API = "/api/direct-entry";

type WorkerScopeTab = "recruited" | "managed" | "team" | "all";
type Incoming<T> = {
  items: readonly T[];
  next_cursor: string | null;
  has_more: boolean;
  summary?: WorkerDirectorySummary;
};
type FetchOutcome<T> = { ok: true; page: Incoming<T> } | { ok: false; state: PageState; message: string | null };

const tabClass =
  "inline-flex min-h-11 items-center rounded-t-lg px-3.5 text-sm font-medium whitespace-nowrap " +
  "transition-colors duration-[var(--ui-motion-tab,200ms)] ease-[var(--ui-motion-ease,cubic-bezier(0.22,1,0.36,1))] " +
  "motion-reduce:transition-none outline-none focus-visible:ring-2 focus-visible:ring-ring/40";
const buttonClass = buttonClasses({ variant: "secondary", size: "md" });
const primaryClass = buttonClasses({ variant: "primary", size: "md" });
const inputClass =
  "min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-base sm:text-sm text-foreground " +
  "outline-none transition-colors duration-[var(--ui-motion-hover,160ms)] motion-reduce:transition-none " +
  "focus:border-primary focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed " +
  "disabled:bg-muted/10 disabled:text-muted";
const errorClass =
  "rounded-lg border border-red-500/40 bg-red-50 p-3 text-sm text-red-700 " +
  "dark:bg-red-950/40 dark:text-red-300";
/** Thong tin/huong dan: mau khac han voi loi (do) va voi thanh cong (xanh la). */
const infoClass =
  "rounded-lg border border-sky-500/40 bg-sky-50 p-3 text-sm text-sky-800 " +
  "dark:bg-sky-950/40 dark:text-sky-200";
/** P2.5-HF-R5A: 403 (khong co quyen doc danh muc) KHAC 5xx/network (loi that). */
const CATALOG_DENIED = "CATALOG_DENIED";
const CATALOG_UNAVAILABLE = "CATALOG_UNAVAILABLE";

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function httpFailure(status: number): FetchOutcome<never> {
  if (status === 403) return { ok: false, state: "denied", message: workerListErrorMessage(403) };
  if (status >= 500) return { ok: false, state: "unavailable", message: workerListErrorMessage(500) };
  return { ok: false, state: "error", message: workerListErrorMessage(status) };
}

export function WorkerOperations({
  allowedTabs,
  canReadCatalog,
  canSeeAllWorkers = false,
  canSeeTeamWorkers = false,
  canExport = false,
  canExportAll = false,
  actor = null,
}: {
  /** Server-authorized list of genuinely usable tabs; client never assumes `managed` or `uploader`. */
  allowedTabs?: readonly WorkerOperationsTab[];
  /** Server-resolved catalog read capability (`entry_create` | `entry_own`). */
  canReadCatalog?: boolean;
  canSeeAllWorkers?: boolean;
  /** Server-projected team audience controls only tab visibility; the RPC rechecks access. */
  canSeeTeamWorkers?: boolean;
  /** Resolved business actor may use recruited/managed/team export; the RPC enforces row authority. */
  canExport?: boolean;
  /** Admin/BoD/Kế toán xuat toan bo (all scope): export caps + all scope + (entry_admin|change_review). */
  canExportAll?: boolean;
  actor?: WorkerOperationsActor | null;
}) {
  const [revokedTabs, setRevokedTabs] = useState<readonly WorkerOperationsTab[]>([]);
  const propAllowedTabs = useMemo(
    () =>
      allowedTabs !== undefined
        ? visibleWorkerTabs(allowedTabs)
        : visibleWorkerTabs({
            ...(actor ?? {}),
            canSeeAllWorkers,
            canSeeTeamWorkers,
          }),
    [allowedTabs, actor, canSeeAllWorkers, canSeeTeamWorkers],
  );
  const propAllowedTabsKey = propAllowedTabs.join(",");
  const propCanReadCatalog =
    canReadCatalog !== undefined
      ? canReadCatalog
      : actor?.capabilities.includes("entry_create") === true ||
        actor?.capabilities.includes("entry_own") === true;
  const propCanUploadDocuments = actor?.capabilities.includes("document_upload") === true;
  const [sessionPermissionOverride, setSessionPermissionOverride] = useState<{
    baseKey: string;
    allowedTabs: readonly WorkerOperationsTab[];
    canReadCatalog: boolean;
    canUploadDocuments: boolean;
  } | null>(null);
  const activeSessionOverride =
    sessionPermissionOverride !== null && sessionPermissionOverride.baseKey === propAllowedTabsKey
      ? sessionPermissionOverride
      : null;
  const serverTabs = activeSessionOverride ? activeSessionOverride.allowedTabs : propAllowedTabs;
  const tabs = useMemo(
    () => serverTabs.filter((value) => !revokedTabs.includes(value)),
    [serverTabs, revokedTabs],
  );
  /** W2S1: capability document_upload do server-resolved actor quyet dinh, khong suy tu tab/role. */
  const canUploadDocuments = activeSessionOverride
    ? activeSessionOverride.canUploadDocuments
    : propCanUploadDocuments;
  const mayReadCatalog = activeSessionOverride
    ? activeSessionOverride.canReadCatalog
    : propCanReadCatalog;
  const [selectedTab, setTab] = useState<WorkerOperationsTab | null>(() =>
    initialWorkerTab(actor, canSeeAllWorkers, canSeeTeamWorkers, undefined, undefined, undefined, allowedTabs),
  );
  const tab: WorkerOperationsTab | null =
    selectedTab !== null && (tabs.includes(selectedTab) || revokedTabs.includes(selectedTab))
      ? selectedTab
      : resolveInitialWorkerTab(tabs);
  const [filters, setFilters] = useState<WorkerDirectoryFilters>(
    () => ({ ...EMPTY_WORKER_DIRECTORY_FILTERS }));
  const [filterCatalogState, setFilterCatalogState] =
    useState<"loading" | "ready" | "denied" | "unavailable">(
      () => (mayReadCatalog ? "loading" : "denied"),
    );
  const [workerPages, setWorkerPages] = useState<Record<WorkerScopeTab, TabPage<WorkerDirectoryRow>>>(
    () => ({ recruited: emptyTabPage(), managed: emptyTabPage(), team: emptyTabPage(), all: emptyTabPage() }));
  const [workerSummary, setWorkerSummary] = useState<WorkerDirectorySummary | null>(null);
  const [submissionPage, setSubmissionPage] =
    useState<TabPage<SubmissionReadItem>>(emptyTabPage);
  const notify = useNotify();
  const [conflict, setConflict] = useState<string | null>(null);
  const [drawerRow, setDrawerRow] = useState<WorkerDirectoryRow | null>(null);
  const [drawerMode, setDrawerMode] = useState<"proposal" | "correction">("proposal");
  /** W2S1: mot dialog chi tiet NLĐ dung chung cho moi danh sach; khong route thu hai. */
  const [detailRow, setDetailRow] = useState<WorkerDirectoryRow | null>(null);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [quickOffboardingMode, setQuickOffboardingMode] = useState(false);
  const [quickOffboardingIds, setQuickOffboardingIds] = useState<Set<string>>(() => new Set());
  const [quickOffboardingOpen, setQuickOffboardingOpen] = useState(false);
  const [quickOffboardingReason, setQuickOffboardingReason] = useState("");
  const [quickOffboardingBusy, setQuickOffboardingBusy] = useState(false);
  const [quickOffboardingProgress, setQuickOffboardingProgress] = useState(0);
  const [catalogs, setCatalogs] = useState<Record<string, DraftCatalog>>({});
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  /** Radix Dialog khong tu tra focus khi khong dung Dialog.Trigger. */
  const drawerOpenerRef = useRef<HTMLElement | null>(null);
  const detailOpenerRef = useRef<HTMLElement | null>(null);
  const quickOffboardingOpenerRef = useRef<HTMLElement | null>(null);
  const filterId = useId();
  const providerTypeFilterId = useId();
  const firstWorkDateFromId = useId();
  const firstWorkDateToId = useId();
  const projectFilterId = useId();
  const recruiterFilterId = useId();
  const laborTypeFilterId = useId();
  const searchId = useId();
  const workerQueryGeneration = useRef(0);
  const today = hcmTodayDate();
  const filterCatalog = catalogs[today];
  const projectFilterOptions = useMemo<CatalogFilterOption[]>(
    () => (filterCatalog?.projects ?? []).map((project) => ({
      id: project.project_id, label: project.display_name, keywords: project.project_id,
    })),
    [filterCatalog],
  );
  const recruiterFilterOptions = useMemo<CatalogFilterOption[]>(
    () => (filterCatalog?.recruiters ?? []).map((recruiter) => ({
      id: recruiter.recruiter_id,
      label: recruiter.label,
      keywords: `${recruiter.display_name} ${recruiter.personnel_code ?? ""}`,
    })),
    [filterCatalog],
  );
  const laborTypeFilterOptions = useMemo(
    () => sortedActiveLaborTypes(filterCatalog?.labor_types),
    [filterCatalog],
  );

  const catalogFor = useCallback((date: string) => catalogs[date], [catalogs]);
  const ensureCatalog = useCallback((date: string): Promise<DraftCatalog> => {
    const cached = catalogs[date];
    if (cached) return Promise.resolve(cached);
    return fetch(API + "/catalog?effective_date=" + encodeURIComponent(date), {
      headers: { accept: "application/json" },
    })
      .then(async (response) => ({ status: response.status, body: await readJson(response) }))
      .then((result) => {
        if (result.status === 403) throw new Error(CATALOG_DENIED);
        const parsed = result.status === 200
          ? parseDirectEntryCatalogResponse(result.body, date) : null;
        if (parsed === null) throw new Error(CATALOG_UNAVAILABLE);
        setCatalogs((current) => ({ ...current, [date]: parsed }));
        return parsed;
      });
  }, [catalogs]);

  useEffect(() => {
    if (tab === null || tab === "uploader" || !mayReadCatalog || filterCatalog !== undefined) return;
    let active = true;
    ensureCatalog(today).then(
      () => { if (active) setFilterCatalogState("ready"); },
      (error: unknown) => {
        if (active) setFilterCatalogState(
          error instanceof Error && error.message === CATALOG_DENIED ? "denied" : "unavailable");
      },
    );
    return () => { active = false; };
  }, [tab, mayReadCatalog, filterCatalog, ensureCatalog, today]);

  /* ---------- fetchers (khong setState) ---------- */

  const fetchWorkers = useCallback(async (
    scope: WorkerScopeTab, workerFilters: WorkerDirectoryFilters, cursor: string | null,
  ): Promise<FetchOutcome<WorkerDirectoryRow>> => {
    const dateError = validateWorkerDirectoryDateRange(workerFilters);
    if (dateError !== null) {
      return { ok: false, state: "error", message: dateError };
    }
    const response = await fetch(API + "/workers" + workersQuery({
      scope, ...workerFilters, cursor,
    }),
      { headers: { accept: "application/json" } });
    const payload = await readJson(response);
    if (response.status !== 200) {
      return httpFailure(response.status);
    }
    const parsed = parseWorkerPageResponse(payload, { scope, page_size: WORKER_PAGE_SIZE });
    if (parsed === null) return { ok: false, state: "error", message: workerListErrorMessage(200) };
    return { ok: true, page: { items: parsed.items, next_cursor: parsed.next_cursor,
      has_more: parsed.has_more, summary: parsed.summary } };
  }, []);

  const fetchSubmissions = useCallback(async (
    cursor: string | null,
  ): Promise<FetchOutcome<SubmissionReadItem>> => {
    const response = await fetch(API + "/submissions" + submissionsQuery(cursor),
      { headers: { accept: "application/json" } });
    const payload = await readJson(response);
    if (response.status !== 200) return httpFailure(response.status);
    const parsed = parseSubmissionPageResponse(payload, { page_size: WORKER_PAGE_SIZE });
    if (parsed === null) return { ok: false, state: "error", message: workerListErrorMessage(200) };
    return { ok: true, page: { items: parsed.items, next_cursor: parsed.next_cursor,
      has_more: parsed.has_more } };
  }, []);

  /* ---------- appliers ---------- */

  const syncSessionPermissions = useCallback(async (
    revokedTab: WorkerOperationsTab,
    denialMessage: string | null,
  ): Promise<void> => {
    const response = await fetch(API + "/session", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    }).catch(() => null);
    if (response === null) return;
    if (response.status === 401 || response.status === 403) {
      setSessionPermissionOverride({
        baseKey: propAllowedTabsKey,
        allowedTabs: [],
        canReadCatalog: false,
        canUploadDocuments: false,
      });
      setFilterCatalogState("denied");
      return;
    }
    if (response.status !== 200) return;
    const sessionBody = await readJson(response);
    const parsed = parseSessionWorkerPermissionsResponse(sessionBody);
    if (parsed === null) return;
    const sessionActor =
      typeof sessionBody === "object" &&
      sessionBody !== null &&
      !Array.isArray(sessionBody) &&
      typeof (sessionBody as { actor?: unknown }).actor === "object" &&
      (sessionBody as { actor?: unknown }).actor !== null
        ? ((sessionBody as { actor: { capabilities?: unknown } }).actor)
        : null;
    const nextCanUploadDocuments =
      Array.isArray(sessionActor?.capabilities) &&
      sessionActor.capabilities.includes("document_upload");
    const effectiveAllowed = parsed.allowedTabs.filter((item) => item !== revokedTab);
    setSessionPermissionOverride({
      baseKey: propAllowedTabsKey,
      allowedTabs: effectiveAllowed,
      canReadCatalog: parsed.canReadCatalog,
      canUploadDocuments: nextCanUploadDocuments,
    });
    if (!parsed.canReadCatalog) {
      setFilterCatalogState("denied");
    }
    setWorkerPages((currentWorkerPages) => {
      const reconciled = reconcileWorkerOperationsPermissions(
        {
          allowedTabs: effectiveAllowed,
          activeTab: revokedTab,
          workerPages: currentWorkerPages,
          submissionPage: emptyTabPage(),
          workerSummary: null,
        },
        {
          nextAllowedTabs: effectiveAllowed,
          preserveDeniedActiveTab: true,
          denialMessage: denialMessage ?? undefined,
        },
      );
      return { ...reconciled.workerPages };
    });
    if (!effectiveAllowed.includes("uploader") && revokedTab !== "uploader") {
      setSubmissionPage(emptyTabPage());
    }
  }, [propAllowedTabsKey]);

  const applyWorkerPage = useCallback((
    scope: WorkerScopeTab, outcome: FetchOutcome<WorkerDirectoryRow>, append: boolean,
  ) => {
    if (outcome.ok) {
      setWorkerSummary(outcome.page.summary ?? null);
    } else if (!append || outcome.state === "denied") {
      setWorkerSummary(null);
    }
    if (!outcome.ok && outcome.state === "denied") {
      setDrawerRow(null);
      setDetailRow(null);
      setRevokedTabs((current) => (current.includes(scope) ? current : [...current, scope]));
      void syncSessionPermissions(scope, outcome.message);
    }
    setWorkerPages((pages) => ({
      ...pages,
      [scope]: outcome.ok
        ? applyPage(pages[scope], outcome.page, workerRowKey, append)
        : failLoad(pages[scope], outcome.state, outcome.message),
    }));
  }, [syncSessionPermissions]);

  const applySubmissionPage = useCallback((
    outcome: FetchOutcome<SubmissionReadItem>, append: boolean,
  ) => {
    if (!outcome.ok && outcome.state === "denied") {
      setRevokedTabs((current) => (current.includes("uploader") ? current : [...current, "uploader"]));
      void syncSessionPermissions("uploader", outcome.message);
    }
    setSubmissionPage((page) => outcome.ok
      ? applyPage(page, outcome.page, submissionRowKey, append)
      : failLoad(page, outcome.state, outcome.message));
  }, [syncSessionPermissions]);

  /* ---------- effect: page 1 cho tab hien tai (moi tab doc lap) ---------- */

  useEffect(() => {
    if (tab === null || !tabs.includes(tab)) return;
    let active = true;
    if (tab === "uploader") {
      fetchSubmissions(null).then(
        (outcome) => { if (active) applySubmissionPage(outcome, false); },
        () => { if (active) setSubmissionPage((page) => failLoad(page, "unavailable", WORKER_LOAD_FAILED_MESSAGE)); },
      );
    } else {
      const scope = tab as WorkerScopeTab;
      fetchWorkers(scope, filters, null).then(
        (outcome) => { if (active) applyWorkerPage(scope, outcome, false); },
        () => { if (active) applyWorkerPage(scope, { ok: false, state: "unavailable", message: WORKER_LOAD_FAILED_MESSAGE }, false); },
      );
    }
    return () => { active = false; };
  }, [tab, tabs, filters, fetchSubmissions, fetchWorkers, applySubmissionPage, applyWorkerPage]);

  /* ---------- load more ---------- */

  async function loadMore<T>(
    page: TabPage<T>, fetcher: (cursor: string | null) => Promise<FetchOutcome<T>>,
    apply: (outcome: FetchOutcome<T>, append: boolean) => void,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    if (quickOffboardingBusy || page.cursor === null || !page.hasMore) return;
    setBusyRequestId("more");
    const outcome = await fetcher(page.cursor).catch(
      () => ({ ok: false as const, state: "unavailable" as PageState, message: WORKER_LOAD_FAILED_MESSAGE }));
    setBusyRequestId(null);
    if (!isCurrent()) return;
    if (!outcome.ok) {
      notify.error({
        title: outcome.message ?? WORKER_LOAD_FAILED_MESSAGE,
        dedupeKey: "worker-load-more-err",
      });
    }
    apply(outcome, true);
  }

  function selectTab(next: WorkerOperationsTab, focus = true) {
    if (quickOffboardingBusy || !tabs.includes(next)) return;
    if (next === tab) {
      if (focus) tabRefs.current[tabs.indexOf(next)]?.focus();
      return;
    }
    workerQueryGeneration.current += 1;
    cancelQuickOffboarding();
    setWorkerSummary(null);
    setFilters({ ...EMPTY_WORKER_DIRECTORY_FILTERS });
    if (next === "uploader") setSubmissionPage(resetTabPage());
    else setWorkerPages((pages) => ({ ...pages, [next as WorkerScopeTab]: resetTabPage() }));
    setTab(next);
    if (focus) tabRefs.current[tabs.indexOf(next)]?.focus();
  }

  function changeFilter(field: keyof WorkerDirectoryFilters, value: string) {
    if (quickOffboardingBusy || tab === null) return;
    const scope = tabScope(tab);
    if (scope === null) return;
    workerQueryGeneration.current += 1;
    cancelQuickOffboarding();
    setWorkerSummary(null);
    const next = updateWorkerDirectoryFilter({
      page: workerPages[scope], filters, field, value,
    });
    setFilters(next.filters);
    setWorkerPages((pages) => ({ ...pages, [scope]: next.page }));
  }

  function clearFilters() {
    if (quickOffboardingBusy || tab === null) return;
    const scope = tabScope(tab);
    if (scope === null) return;
    workerQueryGeneration.current += 1;
    cancelQuickOffboarding();
    setWorkerSummary(null);
    setFilters({ ...EMPTY_WORKER_DIRECTORY_FILTERS });
    setWorkerPages((pages) => ({ ...pages, [scope]: resetTabPage() }));
  }

  const workerPageGeneration = workerQueryGeneration.current;

  async function reload(): Promise<void> {
    if (quickOffboardingBusy || tab === null || !tabs.includes(tab)) return;
    setConflict(null);
    cancelQuickOffboarding();
    if (tab === "uploader") {
      setSubmissionPage(resetTabPage());
      applySubmissionPage(await fetchSubmissions(null).catch(
        () => ({ ok: false as const, state: "unavailable" as PageState, message: WORKER_LOAD_FAILED_MESSAGE })), false);
    } else {
      const scope = tab as WorkerScopeTab;
      const dateError = validateWorkerDirectoryDateRange(filters);
      if (dateError !== null) {
        setWorkerSummary(null);
        setWorkerPages((pages) => ({
          ...pages,
          [scope]: failLoad(emptyTabPage(), "error", dateError),
        }));
        return;
      }
      workerQueryGeneration.current += 1;
      const generation = workerQueryGeneration.current;
      setWorkerSummary(null);
      setWorkerPages((pages) => ({ ...pages, [scope]: resetTabPage() }));
      const outcome = await fetchWorkers(scope, filters, null).catch(
        () => ({ ok: false as const, state: "unavailable" as PageState, message: WORKER_LOAD_FAILED_MESSAGE }));
      if (generation === workerQueryGeneration.current) applyWorkerPage(scope, outcome, false);
    }
  }

  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    if (tabs.length === 0) return;
    const last = tabs.length - 1;
    let next = -1;
    if (event.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next < 0) return;
    event.preventDefault();
    selectTab(tabs[next]);
  }

  const scope = tab === null ? null : tabScope(tab);
  const exportScope = exportScopeForTab(tab);
  const canExportThisTab = exportScope === "all" ? canExportAll : canExport;
  const workerPage =
    scope !== null && tabs.includes(scope)
      ? workerPages[scope as WorkerScopeTab]
      : scope !== null && revokedTabs.includes(scope)
        ? workerPages[scope as WorkerScopeTab]
        : null;
  const activePage: { state: PageState; message: string | null } =
    tab === null
      ? emptyTabPage()
      : workerPage ?? submissionPage;

  function cancelQuickOffboarding(): void {
    if (quickOffboardingBusy) return;
    setQuickOffboardingMode(false);
    setQuickOffboardingIds(new Set());
    setQuickOffboardingOpen(false);
    setQuickOffboardingReason("");
  }

  function toggleQuickOffboardingWorker(entryId: string): void {
    setQuickOffboardingIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  async function submitQuickOffboarding(): Promise<void> {
    if (quickOffboardingBusy || workerPage === null) return;
    const reason = quickOffboardingReason.trim();
    if (reason === "" || reason.length > 4000) return;
    const selected = workerPage.items.filter((row) =>
      quickOffboardingIds.has(row.entry_id) && canSelectQuickOffboardingWorker(row));
    if (selected.length === 0) return;

    setQuickOffboardingBusy(true);
    setQuickOffboardingProgress(0);
    let succeeded = 0;
    let failureMessage: string | null = null;
    for (const row of selected) {
      const status = buildWorkStatusProposal({
        baseline: row.employment_status === null ? null : {
          status: row.employment_status,
          effective_date: row.first_work_date,
        },
        status: "OFF",
        effectiveDate: today,
        leaveReason: reason,
        today,
      });
      if (!status.ok) {
        failureMessage = proposalErrorMessage(status.code);
        break;
      }
      try {
        const response = await fetch(API + "/entries/" + encodeURIComponent(row.entry_id) +
          "/privileged-edit", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          },
          credentials: "same-origin",
          body: JSON.stringify({
            expected_entry_version: row.entry_version,
            patch: { employment_status: status.proposal },
            reason,
          }),
        });
        const payload = await readJson(response);
        if (response.status !== 200) {
          const errorCode = typeof payload === "object" && payload !== null &&
              typeof (payload as { code?: unknown }).code === "string"
            ? (payload as { code: string }).code
            : undefined;
          failureMessage = privilegedEditErrorMessage(response.status, errorCode);
          break;
        }
        succeeded += 1;
        setQuickOffboardingProgress(succeeded);
      } catch {
        failureMessage = "Mất kết nối khi cập nhật. Hãy tải lại danh sách để kiểm tra trạng thái từng hồ sơ.";
        break;
      }
    }

    setQuickOffboardingBusy(false);
    setQuickOffboardingOpen(false);
    setQuickOffboardingMode(false);
    setQuickOffboardingIds(new Set());
    setQuickOffboardingReason("");
    await reload();
    if (failureMessage !== null) {
      notify.error({
        title: succeeded > 0
          ? `Đã cho nghỉ ${succeeded}/${selected.length} NLĐ. Dừng ở lỗi: ${failureMessage}`
          : failureMessage,
        dedupeKey: "worker-quick-offboarding-err",
      });
    } else {
      notify.success({
        title: `Đã cho nghỉ ${succeeded} NLĐ.`,
        dedupeKey: "worker-quick-offboarding-done",
      });
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-3.5 py-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:gap-5 sm:px-6 sm:py-6 lg:px-8 overflow-x-clip">
      <PageHeader
        title="Người lao động"
        badge={
          <StatusBadge tone="primary">
            {tab === "uploader"
              ? `${submissionPage.items.length} đợt`
              : workerSummary !== null
                ? `${workerSummary.total_workers.toLocaleString("vi-VN")} hồ sơ`
                : `${workerPage?.items.length ?? 0} hồ sơ`}
          </StatusBadge>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {canExportThisTab && exportScope !== null ? (
              <div className="flex flex-col items-start gap-1 sm:items-end">
                <button type="button" className={primaryClass} onClick={() => setExportOpen(true)}>
                  Xuất Excel
                </button>
              </div>
            ) : null}
          </div>
        }
      />

      <div role="tablist" aria-label="Quan hệ người lao động" className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((value, index) => (
          <button
            key={value}
            ref={(element) => { tabRefs.current[index] = element; }}
            type="button"
            role="tab"
            id={"workers-tab-" + value}
            aria-selected={tab === value}
            aria-controls={"workers-panel-" + value}
            tabIndex={tab === value ? 0 : -1}
            className={tabClass + (tab === value
              ? " border-b-2 border-primary bg-primary/5 text-foreground" : " text-muted hover:text-foreground")}
            onClick={() => selectTab(value, false)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
          >
            {WORKER_OPERATIONS_TAB_LABELS[value]}
          </button>
        ))}
      </div>

      {conflict ? (
        <div role="alert"
          className={"flex flex-col gap-2 " + errorClass}>
          <span>{conflict}</span>
          <button type="button" className={buttonClass} onClick={() => void reload()}>
            Tải lại dữ liệu
          </button>
        </div>
      ) : null}

      {tab === null ? (
        <section
          role="status"
          data-testid="worker-no-usable-tabs"
          className={infoClass}
        >
          {WORKER_NO_USABLE_TAB_MESSAGE}
        </section>
      ) : (
      <section
        role="tabpanel"
        id={"workers-panel-" + tab}
        aria-labelledby={"workers-tab-" + tab}
        data-ui-panel-motion="true"
        className="flex flex-col gap-3.5"
        aria-busy={activePage.state === "loading"}
      >
        <p className="sr-only">{WORKER_OPERATIONS_TAB_HINTS[tab]}</p>

        {tab === "uploader" ? null : (
          <>
            <FilterToolbar
              actions={
                <button
                  type="button"
                  data-testid="worker-clear-filters"
                  className={buttonClass}
                  disabled={!hasActiveWorkerDirectoryFilters(filters)}
                  onClick={clearFilters}
                >
                  Xóa bộ lọc
                </button>
              }
              summary={
                <>
                  <p role="status" aria-live="polite" data-testid="worker-filter-summary"
                    className="text-sm sm:text-base font-bold text-foreground">
                    {workerSummary === null ? "Đang tính tổng theo bộ lọc…" : (
                      <>
                        Tổng số NLĐ:{" "}
                        <span className="text-red-600 dark:text-red-400">
                          {workerSummary.total_workers.toLocaleString("vi-VN")}
                        </span>{" "}
                        — trong{" "}
                        <span className="text-red-600 dark:text-red-400">
                          {workerSummary.project_count.toLocaleString("vi-VN")}
                        </span>{" "}
                        dự án và{" "}
                        <span className="text-red-600 dark:text-red-400">
                          {workerSummary.recruiter_count.toLocaleString("vi-VN")}
                        </span>{" "}
                        người tuyển; trạng thái làm việc:{" "}
                        {filters.status === "" ? "Tất cả" : workerStatusLabel(filters.status)}; nguồn tuyển:{" "}
                        {workerProviderTypeLabel(filters.providerType)}.
                        {(filters.firstWorkDateFrom ?? "") !== "" || (filters.firstWorkDateTo ?? "") !== "" ? (
                          <>
                            {" "}Ngày vào làm:{" "}
                            {(filters.firstWorkDateFrom ?? "") !== "" ? filters.firstWorkDateFrom : "…"} →{" "}
                            {(filters.firstWorkDateTo ?? "") !== "" ? filters.firstWorkDateTo : "…"}.
                          </>
                        ) : null}
                        {filters.search.trim() === "" ? null : <> Từ khóa: “{filters.search.trim()}”.</>}
                      </>
                    )}
                  </p>
                  {workerPage !== null && workerPage.state === "ready" ? (
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-2 shrink-0">
                      {quickOffboardingMode ? (
                        <>
                          <span role="status" className="text-sm text-muted">
                            Đã chọn {quickOffboardingIds.size} NLĐ; lựa chọn được giữ khi tải thêm.
                          </span>
                          <button type="button" className={buttonClass}
                            disabled={quickOffboardingBusy} onClick={cancelQuickOffboarding}>
                            Hủy chọn
                          </button>
                          <button type="button" className={primaryClass}
                            data-testid="worker-quick-offboarding-submit"
                            disabled={quickOffboardingIds.size === 0 || quickOffboardingBusy}
                            onClick={(event) => {
                              quickOffboardingOpenerRef.current = event.currentTarget;
                              setQuickOffboardingReason("");
                              setQuickOffboardingOpen(true);
                            }}>
                            Cho nghỉ
                          </button>
                        </>
                      ) : (
                        <button type="button" className={buttonClass}
                          data-testid="worker-quick-offboarding-start"
                          onClick={(event) => {
                            quickOffboardingOpenerRef.current = event.currentTarget;
                            setQuickOffboardingIds(new Set());
                            setQuickOffboardingMode(true);
                          }}>
                          Cho nghỉ nhanh
                        </button>
                      )}
                    </div>
                  ) : null}
                </>
              }
            >
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-12 lg:items-end">
                <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-4">
                  <label htmlFor={searchId} className="text-xs font-medium text-muted">Tìm kiếm người lao động</label>
                  <div className="flex items-center gap-2">
                    <input id={searchId} type="search" className={inputClass}
                      placeholder="Tìm theo tên hoặc mã người lao động..."
                      maxLength={100} value={filters.search}
                      onChange={(event) => changeFilter("search", event.target.value)} />
                    <button type="button" className={buttonClass} disabled={filters.search === ""}
                      onClick={() => changeFilter("search", "")}>
                      Xóa tìm kiếm
                    </button>
                  </div>
                </div>
                <div className="flex flex-col gap-1 lg:col-span-2">
                  <label htmlFor={filterId} className="text-xs font-medium text-muted">Trạng thái làm việc</label>
                  <select id={filterId} className={inputClass} value={filters.status}
                    onChange={(event) => changeFilter("status", event.target.value)}>
                    <option value="">Tất cả</option>
                    {WORKER_EMPLOYMENT_STATUSES.map((status) => (
                      <option key={status} value={status}>{workerStatusLabel(status)}</option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1 lg:col-span-2">
                  <label htmlFor={providerTypeFilterId} className="text-xs font-medium text-muted">Nguồn tuyển</label>
                  <select
                    id={providerTypeFilterId}
                    data-testid="worker-filter-provider-type"
                    className={inputClass}
                    value={filters.providerType ?? ""}
                    onChange={(event) => changeFilter("providerType", event.target.value)}
                  >
                    <option value="">Tất cả</option>
                    {WORKER_PROVIDER_TYPES.map((providerType) => (
                      <option key={providerType} value={providerType}>
                        {workerProviderTypeLabel(providerType)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1 lg:col-span-2">
                  <label htmlFor={firstWorkDateFromId} className="text-xs font-medium text-muted">Từ ngày</label>
                  <input
                    id={firstWorkDateFromId}
                    data-testid="worker-filter-date-from"
                    type="date"
                    max={(filters.firstWorkDateTo ?? "") || undefined}
                    className={inputClass}
                    value={filters.firstWorkDateFrom ?? ""}
                    onChange={(event) => changeFilter("firstWorkDateFrom", event.target.value)}
                  />
                </div>
                <div className="flex flex-col gap-1 lg:col-span-2">
                  <label htmlFor={firstWorkDateToId} className="text-xs font-medium text-muted">Đến ngày</label>
                  <input
                    id={firstWorkDateToId}
                    data-testid="worker-filter-date-to"
                    type="date"
                    min={(filters.firstWorkDateFrom ?? "") || undefined}
                    className={inputClass}
                    value={filters.firstWorkDateTo ?? ""}
                    onChange={(event) => changeFilter("firstWorkDateTo", event.target.value)}
                  />
                </div>
                {filterCatalog ? (
                  <>
                    <div className="lg:col-span-4">
                      <CatalogFilterCombobox
                        id={projectFilterId}
                        label="Dự án"
                        allLabel="Tất cả dự án"
                        placeholder="Gõ tên hoặc mã dự án"
                        options={projectFilterOptions}
                        value={filters.projectId}
                        containerClassName="relative flex flex-col gap-1"
                        labelClassName="text-xs font-medium text-muted"
                        inputClassName={inputClass}
                        onChange={(nextValue) => changeFilter("projectId", nextValue)}
                      />
                    </div>
                    <div className="lg:col-span-4">
                      <CatalogFilterCombobox
                        id={recruiterFilterId}
                        label="Người tuyển"
                        allLabel="Tất cả người tuyển"
                        placeholder="Gõ tên, mã hoặc login người tuyển"
                        options={recruiterFilterOptions}
                        value={filters.recruiterId}
                        containerClassName="relative flex flex-col gap-1"
                        labelClassName="text-xs font-medium text-muted"
                        inputClassName={inputClass}
                        onChange={(nextValue) => changeFilter("recruiterId", nextValue)}
                      />
                    </div>
                    <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-4">
                      <label htmlFor={laborTypeFilterId} className="text-xs font-medium text-muted">
                        Loại hình lao động
                      </label>
                      <select
                        id={laborTypeFilterId}
                        data-testid="worker-filter-labor-type"
                        className={inputClass}
                        value={filters.laborType ?? ""}
                        onChange={(event) => changeFilter("laborType", event.target.value)}
                      >
                        <option value="">Tất cả</option>
                        {laborTypeFilterOptions.map((option) => (
                          <option key={option.labor_type_key} value={option.labor_type_key}>
                            {option.display_name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : null}
              </div>
            </FilterToolbar>
            {filterCatalog === undefined && filterCatalogState === "loading" ? (
              <p role="status" className="text-sm text-blue-700 dark:text-blue-300">
                Đang tải bộ lọc dự án và người tuyển…
              </p>
            ) : null}
            {filterCatalogState === "denied" ? (
              <p role="status" className={infoClass}>
                Vai trò hiện tại không có quyền đọc danh mục dự án và người tuyển, nên chỉ lọc được
                theo trạng thái làm việc. Đây là giới hạn quyền, không phải lỗi hệ thống.
              </p>
            ) : null}
            {filterCatalogState === "unavailable" ? (
              <p role="alert" className={errorClass}>
                Không tải được danh mục dự án và người tuyển. Bộ lọc trạng thái vẫn hoạt động.
              </p>
            ) : null}
          </>
        )}

        {activePage.state === "loading" || activePage.state === "idle" ? (
          <p role="status" className={infoClass}>Đang tải dữ liệu…</p>
        ) : null}
        {activePage.state === "empty" ? (
          <p role="status" className={infoClass}>
            {filters.search.trim() === ""
              ? "0 người lao động trong quan hệ này."
              : "Không tìm thấy người lao động phù hợp với từ khóa và bộ lọc hiện tại."}
          </p>
        ) : null}
        {activePage.state === "error" || activePage.state === "denied" ||
         activePage.state === "unavailable" ? (
          <div role="alert"
            className={"flex flex-col gap-2 " + errorClass}>
            <span>{activePage.message ?? "Không tải được danh sách trong quan hệ này."}</span>
            <button type="button" className={buttonClass} onClick={() => void reload()}>
              Thử lại
            </button>
          </div>
        ) : null}

        {/* P2.5-HF-R5A: "Tai them" loi thi GIU rows da tai va phai BAO cho nguoi dung. */}
        {activePage.state === "ready" && activePage.message !== null ? (
          <div role="alert" className={"flex flex-col gap-2 " + errorClass}>
            <span>{activePage.message}</span>
            <button type="button" className={buttonClass} onClick={() => void reload()}>
              Thử lại
            </button>
          </div>
        ) : null}

        {tab === "uploader" && submissionPage.state === "ready" ? (
          <>
            <SubmissionTable submissions={submissionPage.items} />
            <LoadMore state={submissionPage.state} hasMore={submissionPage.hasMore}
              busy={busyRequestId === "more"}
              onLoadMore={() => void loadMore(submissionPage, fetchSubmissions, applySubmissionPage)} />
          </>
        ) : null}
        {workerPage !== null && workerPage.state === "ready" ? (
          <>
            <WorkerTable rows={workerPage.items}
              quickOffboardingMode={quickOffboardingMode}
              selectedQuickOffboardingIds={quickOffboardingIds}
              onToggleQuickOffboarding={toggleQuickOffboardingWorker}
              onViewDetail={(row, opener) => {
                detailOpenerRef.current = opener;
                setDetailRow(row);
              }}
              onPropose={(row, opener) => {
                drawerOpenerRef.current = opener;
                setDrawerMode("proposal");
                setDrawerRow(row);
              }}
              onCorrect={(row, opener) => {
                drawerOpenerRef.current = opener;
                setDrawerMode("correction");
                setDrawerRow(row);
              }} />
            <LoadMore state={workerPage.state} hasMore={workerPage.hasMore}
              busy={busyRequestId === "more"}
              onLoadMore={() => void loadMore(workerPage, (cursor) =>
                fetchWorkers(tab as WorkerScopeTab, filters, cursor), (outcome, append) =>
                applyWorkerPage(tab as WorkerScopeTab, outcome, append),
              () => workerQueryGeneration.current === workerPageGeneration)} />
          </>
        ) : null}
      </section>
      )}

      <WorkerExportDialog
        key={exportOpen ? "export-open" : "export-closed"}
        open={exportOpen}
        scope={exportScope}
        filters={filters}
        onOpenChange={(open) => { if (!open) setExportOpen(false); }}
        onDone={(message) => {
          setExportOpen(false);
          notify.success({ title: message, dedupeKey: "worker-export-done" });
        }}
      />

      <ProposeDrawer
        key={drawerRow === null ? "none" : drawerRow.entry_id + ":" + drawerMode}
        row={drawerRow}
        mode={drawerMode}
        canUploadDocuments={canUploadDocuments}
        openerRef={drawerOpenerRef}
        catalogDenied={filterCatalogState === "denied"}
        catalogFor={catalogFor}
        ensureCatalog={ensureCatalog}
        onOpenChange={(open) => { if (!open) setDrawerRow(null); }}
        onSyncSuccess={() => { void reload(); }}
        onDone={(message) => {
          setDrawerRow(null);
          void reload();
          notify.success({
            title: message,
            dedupeKey: "worker-mutation:" + message,
            action: message.includes("Đã gửi yêu cầu thay đổi")
              ? {
                  label: "Mở Yêu cầu thay đổi",
                  href: "/direct-entry/change-requests",
                  dataTestId: "worker-change-request-module-link",
                }
              : undefined,
          });
        }}
        onConflict={() => {
          setDrawerRow(null);
          setConflict(WORKER_CONFLICT_MESSAGE);
          notify.warning({ title: WORKER_CONFLICT_MESSAGE, dedupeKey: "worker-conflict" });
        }}
      />

      <WorkerDetailDialog
        key={detailRow === null ? "none" : detailRow.entry_id}
        row={detailRow}
        openerRef={detailOpenerRef}
        onOpenChange={(open) => { if (!open) setDetailRow(null); }}
      />

      <Dialog.Root open={quickOffboardingOpen}
        onOpenChange={(open) => { if (!open && !quickOffboardingBusy) setQuickOffboardingOpen(false); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--backdrop)] backdrop-blur-[7px]" data-ui-overlay-motion="true" />
          <Dialog.Content
            data-ui-dialog-motion="true"
            onCloseAutoFocus={(event) => {
              const opener = quickOffboardingOpenerRef.current;
              if (opener && opener.isConnected) {
                event.preventDefault();
                opener.focus();
              }
            }}
            className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)]
              w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2
              overflow-hidden rounded-2xl border border-border bg-surface border-t-2 border-t-primary text-foreground shadow-[var(--shadow-dialog)] outline-none"
          >
            <form className="flex min-h-0 w-full flex-col"
              onSubmit={(event) => { event.preventDefault(); void submitQuickOffboarding(); }}>
              <header className="flex shrink-0 items-start justify-between gap-4 border-b-2 border-border
                bg-surface px-4 py-4 sm:px-5">
                <div>
                  <Dialog.Title className="text-xl font-semibold text-navy">Cho nghỉ {quickOffboardingIds.size} NLĐ</Dialog.Title>
                  <Dialog.Description className="mt-1 text-sm text-muted">
                    Trạng thái có hiệu lực từ hôm nay ({today}). Nếu một hồ sơ cập nhật lỗi, hệ thống dừng
                    tại hồ sơ đó và báo số hồ sơ đã xử lý.
                  </Dialog.Description>
                </div>
                <button type="button" aria-label="Đóng xác nhận cho nghỉ" disabled={quickOffboardingBusy}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-full
                    border border-border bg-surface text-xl text-muted hover:bg-muted/10
                    hover:text-foreground focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-ring/40 disabled:opacity-50"
                  onClick={() => setQuickOffboardingOpen(false)}>×</button>
              </header>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-surface-muted px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
                  <label htmlFor="worker-quick-offboarding-reason" className="text-sm font-medium text-navy">
                    Lý do nghỉ
                  </label>
                  <textarea id="worker-quick-offboarding-reason" required maxLength={4000}
                    disabled={quickOffboardingBusy}
                    className="min-h-24 w-full rounded-md border border-border bg-surface p-3 text-sm
                      text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
                    value={quickOffboardingReason}
                    onChange={(event) => setQuickOffboardingReason(event.target.value)} />
                </div>
                {quickOffboardingBusy ? (
                  <p role="status" aria-live="polite" className={infoClass}>
                    Đang xử lý {quickOffboardingProgress}/{quickOffboardingIds.size} hồ sơ…
                  </p>
                ) : null}
              </div>
              <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-surface px-4 py-3 sm:px-5">
                <button type="button" className={buttonClass} disabled={quickOffboardingBusy}
                  onClick={() => setQuickOffboardingOpen(false)}>Hủy</button>
                <button type="submit" className={primaryClass}
                  disabled={quickOffboardingBusy || quickOffboardingReason.trim() === ""}
                  aria-busy={quickOffboardingBusy}>
                  {quickOffboardingBusy ? "Đang xử lý…" : "Xác nhận cho nghỉ"}
                </button>
              </footer>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

    </main>
  );
}

function LoadMore({
  state, hasMore, busy, onLoadMore,
}: { state: PageState; hasMore: boolean; busy: boolean; onLoadMore: () => void }) {
  return (
    <div className="flex justify-center">
      <CursorLoadMore
        hasMore={hasMore}
        loading={busy || state === "loading"}
        label="Tải thêm"
        onLoadMore={onLoadMore}
      />
    </div>
  );
}

function SubmissionTable({ submissions }: { submissions: readonly SubmissionReadItem[] }) {
  return (
    <DataTableContainer className="max-w-5xl" scrollClassName="overflow-x-auto">
      <table className={DATA_TABLE_CLASS + " min-w-[640px]"}>
        <caption className="sr-only">Hồ sơ bạn đã nhập (chỉ tra cứu)</caption>
        <thead className={DATA_TABLE_HEAD_CLASS}>
          <tr>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Trạng thái</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Số dòng</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Cập nhật</th>
          </tr>
        </thead>
        <tbody>
          {submissions.map((item) => {
            const badge = submissionStateBadgeProps(item.state);
            const refCode = shortRef(item.submission_id);
            const formattedUpdatedAt = formatHcmDateTime(item.updated_at);
            return (
              <tr key={item.submission_id} className={DATA_TABLE_ROW_CLASS}>
                <td className={DATA_TABLE_TD_CLASS} data-card-header="true">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={badge.tone} dot>{badge.label}</StatusBadge>
                    <span className="font-mono text-xs text-muted" title="Mã đợt rút gọn">
                      #{refCode}
                    </span>
                  </div>
                </td>
                <td className={DATA_TABLE_TD_CLASS + " font-mono text-xs tabular-nums whitespace-nowrap"} data-label="Số dòng">
                  {item.entry_count} dòng
                </td>
                <td className={DATA_TABLE_TD_CLASS + " font-mono text-xs tabular-nums text-muted whitespace-nowrap"} data-label="Cập nhật">
                  {formattedUpdatedAt}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </DataTableContainer>
  );
}

function WorkerTable({
  rows, quickOffboardingMode, selectedQuickOffboardingIds, onToggleQuickOffboarding,
  onViewDetail, onPropose, onCorrect,
}: {
  rows: readonly WorkerDirectoryRow[];
  quickOffboardingMode: boolean;
  selectedQuickOffboardingIds: ReadonlySet<string>;
  onToggleQuickOffboarding: (entryId: string) => void;
  /** W2S1: mo dialog chi tiet dung chung; `allowed_actions.view` luon true theo server. */
  onViewDetail: (row: WorkerDirectoryRow, opener: HTMLElement | null) => void;
  /** P2.5-HF-R5A: nhan kem nut da bam de tra focus khi dong drawer. */
  onPropose: (row: WorkerDirectoryRow, opener: HTMLElement | null) => void;
  onCorrect: (row: WorkerDirectoryRow, opener: HTMLElement | null) => void;
}) {
  const compactActionClass = " md:!h-7 md:!min-h-7 md:!px-2.5 md:!py-0.5 md:!text-xs justify-center";
  const rowSecondaryBtn = buttonClasses({ variant: "secondary", size: "sm" }) + compactActionClass;
  const rowPrimaryBtn = buttonClasses({ variant: "soft", size: "sm" }) + compactActionClass;
  const rowSoftBtn = buttonClasses({ variant: "soft", size: "sm" }) + compactActionClass;
  return (
    <DataTableContainer scrollClassName="overflow-x-auto">
      <table className={DATA_TABLE_CLASS}>
        <caption className="sr-only">Danh sách người lao động theo quan hệ đã chọn</caption>
        <thead className={DATA_TABLE_HEAD_CLASS}>
          <tr>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Người lao động</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Mã</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Dự án</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Ngày đầu tiên</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Người tuyển</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Trạng thái</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS}>Loại hình</th>
            <th scope="col" className={DATA_TABLE_TH_CLASS + " text-right"}>Thao tác</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const cta = proposeCta(row);
            const canDirectEdit = row.allowed_actions.direct_edit;
            const canQuickOffboard = canSelectQuickOffboardingWorker(row);
            const bank = bankAccountSummary(row.payment);
            const statusTone = row.employment_status === "ON"
              ? "success"
              : row.employment_status === "UNCONFIRMED"
                ? "warning"
                : "neutral";
            return (
              <tr key={row.entry_id} className={DATA_TABLE_ROW_CLASS}>
                <td className={DATA_TABLE_TD_CLASS + " font-semibold text-[var(--navy)]"} data-card-header="true">
                  <span className="flex items-center gap-2">
                    {quickOffboardingMode ? (
                      <input type="checkbox" className="size-4 shrink-0 accent-primary"
                        aria-label={`Chọn ${row.display_name} (${row.employee_code}) để cho nghỉ`}
                        checked={selectedQuickOffboardingIds.has(row.entry_id)}
                        disabled={!canQuickOffboard}
                        title={!canQuickOffboard
                          ? row.employment_status === "OFF" ? "NLĐ đã nghỉ việc" : "Bạn không có quyền sửa trạng thái NLĐ này"
                          : undefined}
                        onChange={() => onToggleQuickOffboarding(row.entry_id)} />
                    ) : null}
                    <span>{row.display_name}</span>
                  </span>
                </td>
                <td className={DATA_TABLE_TD_CLASS + " whitespace-nowrap"} data-label="Mã NLĐ">
                  <span className="inline-flex items-center rounded-md border border-border/80 bg-surface-muted/75 px-2 py-0.5 font-mono text-xs font-medium text-[var(--navy)]">
                    {row.employee_code}
                  </span>
                </td>
                <td className={DATA_TABLE_TD_CLASS + " max-w-[18rem] font-medium text-foreground"} data-label="Dự án">
                  {row.project_display}
                </td>
                <td className={DATA_TABLE_TD_CLASS + " font-mono text-xs tabular-nums whitespace-nowrap text-muted"} data-label="Ngày đầu tiên">
                  {row.first_work_date}
                </td>
                <td className={DATA_TABLE_TD_CLASS + " whitespace-nowrap font-medium"} data-label="Người tuyển">
                  {row.recruiter_display}
                </td>
                <td className={DATA_TABLE_TD_CLASS + " whitespace-nowrap"} data-label="Trạng thái">
                  <StatusBadge tone={statusTone} dot>
                    {workerStatusLabel(row.employment_status)}
                  </StatusBadge>
                  {bank ? (
                    <div className="mt-1 text-xs text-muted line-clamp-1">
                      <span className="font-medium">{BANK_ACCOUNT_SECTION_LABEL}: </span>
                      {(bank.accountNumber ?? "chưa có") + " · " + (bank.bankId ?? "chưa có") +
                        " · " + (bank.accountHolder ?? "chưa có")}
                    </div>
                  ) : null}
                </td>
                <td className={DATA_TABLE_TD_CLASS} data-label="Loại hình">
                  {row.labor_type_display}
                </td>
                <td className={DATA_TABLE_TD_CLASS + " text-right whitespace-nowrap"} data-card-actions="true">
                  <RowActionCluster>
                    <button type="button" className={rowSecondaryBtn}
                      onClick={(event) => onViewDetail(row, event.currentTarget)}>
                      Xem chi tiết
                    </button>
                    {!canDirectEdit && cta.show ? (
                      <button type="button" className={rowSoftBtn}
                        onClick={(event) => onPropose(row, event.currentTarget)}>
                        Đề xuất thay đổi
                      </button>
                    ) : null}
                    {canDirectEdit ? (
                      <button type="button" className={rowPrimaryBtn}
                        onClick={(event) => onCorrect(row, event.currentTarget)}>
                        Sửa thông tin
                      </button>
                    ) : null}
                  </RowActionCluster>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </DataTableContainer>
  );
}

const DIRECT_EDIT_FILE_KINDS = DIRECT_EDIT_DOCUMENT_TYPES;
type DirectEditFileKind = DirectEditDocumentType;
type DirectEditFileStatus = {
  state: "selected" | "uploading" | "saved" | "error";
  text: string;
};
const successClass =
  "rounded-lg border border-emerald-500/40 bg-emerald-50 p-3 text-sm text-emerald-800 " +
  "dark:bg-emerald-950/40 dark:text-emerald-200";

type EntryBaseline = {
  version: number;
  projectId: string;
  firstWorkDate: string;
  employeeCode: string;
  recruiterId: string;
  laborType: string;
  laborTypeDisplay: string;
  workerDetails: WorkerDetails | null;
  providerType: "hrp" | "vendor" | null;
  status: WorkerStatus | null;
  effectiveDate: string | null;
  payment: { state: PaymentState; account_number: string | null; bank_id: string | null;
    bank_name: string | null; account_holder_name: string | null } | null;
  fileVersions: Readonly<Partial<Record<DirectEditFileKind, number>>>;
};

async function fetchBaseline(entryId: string): Promise<EntryBaseline | null> {
  try {
    const response = await fetch(API + "/entries/" + encodeURIComponent(entryId), {
      headers: { accept: "application/json" },
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.status !== 200) return null;
    const body = await readJson(response);
    if (typeof body !== "object" || body === null) return null;
    const entry = (body as Record<string, unknown>).entry;
    if (typeof entry !== "object" || entry === null) return null;
    const row = entry as Record<string, unknown>;
    if (typeof row.version !== "number" || typeof row.project_id !== "string" ||
        typeof row.first_work_date !== "string" || typeof row.employee_code !== "string" ||
        typeof row.recruiter_id !== "string" ||
        !isCanonicalLaborTypeKey(row.labor_type) ||
        typeof row.labor_type_display !== "string" || row.labor_type_display.length === 0) return null;
    const details = projectWorkerDetailsForProposal(row.worker_details);
    const status = typeof row.employment_status === "object" && row.employment_status !== null
      ? row.employment_status as Record<string, unknown> : null;
    const payment = typeof row.payment === "object" && row.payment !== null
      ? row.payment as Record<string, unknown> : null;
    const fileVersions: Partial<Record<DirectEditFileKind, number>> = {};
    if (typeof row.worker_portrait === "object" && row.worker_portrait !== null) {
      const currentPortrait = (row.worker_portrait as Record<string, unknown>).current;
      if (typeof currentPortrait === "object" && currentPortrait !== null &&
          typeof (currentPortrait as Record<string, unknown>).version === "number") {
        fileVersions.WORKER_PORTRAIT = (currentPortrait as { version: number }).version;
      }
    }
    if (Array.isArray(row.documents)) {
      for (const item of row.documents) {
        if (typeof item !== "object" || item === null) continue;
        const docRecord = item as Record<string, unknown>;
        const docType = docRecord.document_type;
        const docVersion = docRecord.version;
        if (typeof docType === "string" &&
            (DIRECT_EDIT_FILE_KINDS as readonly string[]).includes(docType) &&
            typeof docVersion === "number") {
          const kind = docType as DirectEditFileKind;
          fileVersions[kind] = Math.max(fileVersions[kind] ?? 0, docVersion);
        }
      }
    }
    return {
      version: row.version,
      projectId: row.project_id,
      firstWorkDate: row.first_work_date,
      employeeCode: row.employee_code,
      recruiterId: row.recruiter_id,
      laborType: row.labor_type,
      laborTypeDisplay: row.labor_type_display,
      workerDetails: details,
      providerType: row.provider_type === "hrp" || row.provider_type === "vendor"
        ? row.provider_type : null,
      status: status && typeof status.status === "string" ? status.status as WorkerStatus : null,
      effectiveDate: status && typeof status.effective_date === "string"
        ? status.effective_date : null,
      payment: payment === null ? null : {
        state: payment.state as PaymentState,
        account_number: typeof payment.account_number === "string" ? payment.account_number : null,
        bank_id: typeof payment.bank_id === "string" ? payment.bank_id : null,
        bank_name: typeof payment.bank_name === "string" ? payment.bank_name : null,
        account_holder_name: typeof payment.account_holder_name === "string"
          ? payment.account_holder_name : null,
      },
      fileVersions,
    };
  } catch {
    return null;
  }
}

function ProposeDrawer({
  row, mode, canUploadDocuments = false, openerRef, catalogDenied, catalogFor, ensureCatalog,
  onOpenChange, onSyncSuccess, onDone, onConflict,
}: {
  row: WorkerDirectoryRow | null;
  mode: "proposal" | "correction";
  canUploadDocuments?: boolean;
  openerRef: { current: HTMLElement | null };
  /** True khi catalog bi tu choi (403) — gap #2 da biet; copy phai la gioi han quyen, khong phai loi. */
  catalogDenied: boolean;
  catalogFor: (date: string) => DraftCatalog | undefined;
  ensureCatalog: (date: string) => Promise<DraftCatalog>;
  onOpenChange: (open: boolean) => void;
  onSyncSuccess?: () => void;
  onDone: (message: string) => void;
  onConflict: () => void;
}) {
  const reasonId = useId();
  const notify = useNotify();
  const [baseline, setBaseline] = useState<EntryBaseline | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [profileSaveNotice, setProfileSaveNotice] = useState("");
  const [selectedFiles, setSelectedFiles] =
    useState<Partial<Record<DirectEditFileKind, File>>>({});
  const [fileStatuses, setFileStatuses] =
    useState<Partial<Record<DirectEditFileKind, DirectEditFileStatus>>>({});
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState<WorkerProposeTarget>("WORKER");
  const [entryForm, setEntryForm] = useState<WorkerEntryFieldForm | null>(null);
  const [paymentState, setPaymentState] = useState<PaymentState>("omitted");
  const [accountNumber, setAccountNumber] = useState("");
  const [bankId, setBankId] = useState("");
  const [bankQuery, setBankQuery] = useState("");
  const [accountHolder, setAccountHolder] = useState("");
  const [targetStatus, setTargetStatus] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [leaveReason, setLeaveReason] = useState("");
  const today = hcmTodayDate();
  const catalog = catalogFor(today);
  const mergedBankOptions = useMemo<MergedBankCatalogOption[]>(
    () => mergeVietQrBankCatalog(catalog?.banks ?? []),
    [catalog],
  );
  // The row has already passed server-side worker view and scope; edits still require the existing action.
  const workerFieldMode = mode === "correction" || target === "WORKER";
  const nameAvailability = workerNameAvailability({
    proposeChange: mode === "correction" ? true : row?.allowed_actions.propose_change === true,
    hasBaseline: entryForm !== null,
  });

  useEffect(() => {
    if (row === null) return;
    let active = true;
    fetchBaseline(row.entry_id).then(
      (value) => {
        if (!active) return;
        setBaseline(value);
        setLoading(false);
        setEffectiveDate(hcmTodayDate());
        if (value?.workerDetails) {
          const entryBaseline: WorkerEntryFieldBaseline = {
            project_id: value.projectId,
            first_work_date: value.firstWorkDate,
            employee_code: value.employeeCode,
            recruiter_id: value.recruiterId,
            labor_type: value.laborType,
            worker_details: value.workerDetails,
          };
          setEntryForm(
            mode === "correction"
              ? directEditWorkerFormFromBaseline(entryBaseline)
              : workerEntryFormFromBaseline(entryBaseline),
          );
        }
        if (value?.payment) {
          setPaymentState(value.payment.state);
          setAccountNumber(
            value.payment.state === "provided"
              ? (value.payment.account_number ?? "")
              : "",
          );
          setBankId(
            value.payment.state === "provided"
              ? (value.payment.bank_id ?? "")
              : "",
          );
          setBankQuery(
            initialDirectEditBankQueryText(
              value.payment,
              catalogFor(today)?.banks ?? [],
            ),
          );
          setAccountHolder(
            value.payment.state === "provided"
              ? (value.payment.account_holder_name ?? "")
              : "",
          );
        }
      },
      () => { if (active) { setBaseline(null); setLoading(false); } },
    );
    return () => { active = false; };
  }, [row, mode, catalogFor, today]);

  useEffect(() => {
    if (row !== null) void ensureCatalog(today).catch(() => undefined);
  }, [row, ensureCatalog, today]);

  async function retrySingleFile(kind: DirectEditFileKind): Promise<void> {
    if (row === null || baseline === null || busy) return;
    const file = selectedFiles[kind];
    if (!file) return;
    if (!canUploadDocuments) {
      setMessage("Tài khoản hiện tại không có quyền tải tài liệu hồ sơ.");
      return;
    }
    const trimmed = reason.trim();
    const actionReason = trimmed === "" ? null : trimmed;
    setBusy(true);
    setMessage(null);
    setFileStatuses((prev) => ({
      ...prev,
      [kind]: { state: "uploading", text: "Đang tải và xác thực tệp…" },
    }));
    const outcome = await uploadDirectEditDocument({
      entryId: row.entry_id,
      expectedEntryVersion: baseline.version,
      docType: kind,
      file,
      reason: actionReason,
    });
    setBaseline((prev) => prev === null ? null : {
      ...prev,
      version: outcome.entryVersion,
      fileVersions: outcome.ok
        ? { ...prev.fileVersions, [kind]: outcome.documentVersion }
        : prev.fileVersions,
    });
    if (outcome.ok) {
      setSelectedFiles((prev) => {
        const next = { ...prev };
        delete next[kind];
        return next;
      });
      setFileStatuses((prev) => ({
        ...prev,
        [kind]: {
          state: "saved",
          text: "Đã lưu tài liệu thành công (v" + outcome.documentVersion + ").",
        },
      }));
      onSyncSuccess?.();
      notify.success({
        title: "Đã tải tài liệu hồ sơ thành công.",
        dedupeKey: "worker-file-retry:" + kind,
      });
    } else {
      setFileStatuses((prev) => ({
        ...prev,
        [kind]: { state: "error", text: outcome.message },
      }));
    }
    setBusy(false);
  }

  async function submit(): Promise<void> {
    if (row === null || baseline === null) return;
    const trimmed = reason.trim();
    const actionReason = trimmed === "" ? null : trimmed;
    let proposal: Record<string, unknown> | null = null;
    let targetKind: "ENTRY_FIELD" | "PAYMENT" | "WORK_STATUS" = "ENTRY_FIELD";
    if (mode === "correction" || target === "WORKER") {
      if (entryForm === null || baseline.workerDetails === null) {
        setMessage("Chưa đọc được thông tin người lao động.");
        return;
      }
      const entryBaseline: WorkerEntryFieldBaseline = {
        project_id: baseline.projectId,
        first_work_date: baseline.firstWorkDate,
        employee_code: baseline.employeeCode,
        recruiter_id: baseline.recruiterId,
        labor_type: baseline.laborType,
        worker_details: baseline.workerDetails,
      };
      const built = buildEntryFieldProposal({
        entryId: row.entry_id,
        expectedVersion: baseline.version,
        baseline: entryBaseline,
        form: entryForm,
      });
      if (mode === "correction") {
        const directBuilt = buildDirectEditEntryFieldProposal({
          baseline: entryBaseline,
          form: entryForm,
        });
        const patch: Record<string, unknown> = directBuilt.ok ? { ...directBuilt.proposal } : {};
        if (!directBuilt.ok && directBuilt.code !== "WORKER_UNCHANGED") {
          setMessage(proposalErrorMessage(directBuilt.code));
          return;
        }
        const paymentBuilt = buildDirectEditPaymentPatch({
          baseline: baseline.payment,
          accountNumber,
          bankId,
          bankQueryText: bankQuery,
          accountHolderName: accountHolder,
          catalogBanks: catalog?.banks ?? [],
        });
        if (paymentBuilt.kind === "invalid") {
          setMessage(paymentBuilt.message);
          return;
        }
        if (paymentBuilt.kind === "changed") {
          patch.payment = paymentBuilt.proposal;
        }
        if (targetStatus !== "") {
          const status = buildWorkStatusProposal({
            baseline: baseline.status === null ? null : {
              status: baseline.status, effective_date: baseline.effectiveDate ?? row.first_work_date,
            },
            status: targetStatus as WorkerStatus,
            effectiveDate: effectiveDate === ""
              ? (baseline.effectiveDate ?? row.first_work_date) : effectiveDate,
            leaveReason,
            today,
          });
          if (!status.ok) { setMessage(proposalErrorMessage(status.code)); return; }
          patch.employment_status = status.proposal;
        }
        const pendingFileKinds = DIRECT_EDIT_FILE_KINDS.filter(
          (kind) => selectedFiles[kind] !== undefined,
        );
        if (pendingFileKinds.length > 0 && !canUploadDocuments) {
          setMessage("Tài khoản hiện tại không có quyền tải tài liệu hồ sơ.");
          return;
        }
        const hasFieldPatch = Object.keys(patch).length > 0;
        if (!hasFieldPatch && pendingFileKinds.length === 0) {
          setMessage("Hồ sơ chưa có thay đổi.");
          return;
        }
        setBusy(true);
        setMessage(null);
        let currentVersion = baseline.version;
        if (hasFieldPatch) {
          try {
            const response = await fetch(API + "/entries/" + encodeURIComponent(row.entry_id) +
              "/privileged-edit", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": crypto.randomUUID(),
              },
              credentials: "same-origin",
              body: JSON.stringify({
                expected_entry_version: currentVersion,
                patch,
                reason: actionReason,
              }),
            });
            const payload = await response.json().catch(() => null);
            if (response.status !== 200) {
              setBusy(false);
              const errorCode =
                typeof payload === "object" &&
                payload !== null &&
                typeof (payload as { code?: unknown }).code === "string"
                  ? (payload as { code: string }).code
                  : undefined;
              if (response.status === 409 && (errorCode === undefined || errorCode === "VERSION_CONFLICT")) {
                onConflict();
                return;
              }
              notify.error({
                title: privilegedEditErrorMessage(response.status, errorCode),
                dedupeKey: "worker-privileged-edit-err",
              });
              return;
            }
            const nextVersion =
              typeof payload === "object" &&
              payload !== null &&
              typeof (payload as { version?: unknown }).version === "number"
                ? (payload as { version: number }).version
                : currentVersion + 1;
            currentVersion = nextVersion;
            const nextWorkerDetails: WorkerDetails =
              patch.worker_details !== undefined
                ? (patch.worker_details as WorkerDetails)
                : baseline.workerDetails;
            const nextStatus: WorkerStatus | null =
              targetStatus !== "" ? (targetStatus as WorkerStatus) : baseline.status;
            const nextEffectiveDate: string | null =
              targetStatus !== ""
                ? (effectiveDate === ""
                    ? (baseline.effectiveDate ?? row.first_work_date)
                    : effectiveDate)
                : baseline.effectiveDate;
            const nextPayment =
              paymentBuilt.kind === "changed"
                ? {
                    state: paymentBuilt.proposal.state,
                    account_number: paymentBuilt.proposal.account_number,
                    bank_id: paymentBuilt.proposal.bank_id,
                    bank_name: paymentBuilt.proposal.bank_name ?? null,
                    account_holder_name: paymentBuilt.proposal.account_holder_name,
                  }
                : baseline.payment;
            setBaseline((prev) => prev === null ? null : {
              ...prev,
              version: nextVersion,
              projectId: entryForm.project_id,
              firstWorkDate: entryForm.first_work_date,
              employeeCode: entryForm.employee_code,
              recruiterId: entryForm.recruiter_id,
              laborType: entryForm.labor_type,
              workerDetails: nextWorkerDetails,
              status: nextStatus,
              effectiveDate: nextEffectiveDate,
              payment: nextPayment,
            });
            if (targetStatus !== "") {
              setTargetStatus("");
              setLeaveReason("");
            }
            setProfileSaveNotice(
              "Thông tin hồ sơ (cá nhân, công việc, ngân hàng): Đã lưu thành công.",
            );
            if (pendingFileKinds.length > 0) {
              onSyncSuccess?.();
            }
          } catch {
            setBusy(false);
            notify.error({
              title: "Không lưu được chỉnh sửa trực tiếp. Vui lòng thử lại.",
              dedupeKey: "worker-privileged-edit-err",
            });
            return;
          }
        }
        if (pendingFileKinds.length === 0) {
          setBusy(false);
          onDone("Đã lưu chỉnh sửa trực tiếp.");
          return;
        }
        let failedCount = 0;
        for (const kind of pendingFileKinds) {
          const file = selectedFiles[kind];
          if (!file) continue;
          setFileStatuses((prev) => ({
            ...prev,
            [kind]: { state: "uploading", text: "Đang tải và xác thực tệp…" },
          }));
          const outcome = await uploadDirectEditDocument({
            entryId: row.entry_id,
            expectedEntryVersion: currentVersion,
            docType: kind,
            file,
            reason: actionReason,
          });
          currentVersion = outcome.entryVersion;
          setBaseline((prev) => prev === null ? null : {
            ...prev,
            version: outcome.entryVersion,
            fileVersions: outcome.ok
              ? { ...prev.fileVersions, [kind]: outcome.documentVersion }
              : prev.fileVersions,
          });
          if (outcome.ok) {
            setSelectedFiles((prev) => {
              const next = { ...prev };
              delete next[kind];
              return next;
            });
            setFileStatuses((prev) => ({
              ...prev,
              [kind]: {
                state: "saved",
                text: "Đã lưu tài liệu thành công (v" + outcome.documentVersion + ").",
              },
            }));
            onSyncSuccess?.();
          } else {
            failedCount += 1;
            setFileStatuses((prev) => ({
              ...prev,
              [kind]: { state: "error", text: outcome.message },
            }));
          }
        }
        setBusy(false);
        if (failedCount === 0) {
          onDone("Đã lưu chỉnh sửa trực tiếp.");
          return;
        }
        setMessage(
          hasFieldPatch
            ? "Thông tin hồ sơ đã được lưu. Một số tài liệu chưa tải lên được — vui lòng kiểm tra từng tệp bên dưới và thử lại."
            : "Một số tài liệu chưa tải lên được — vui lòng kiểm tra từng tệp bên dưới và thử lại.",
        );
        return;
      }
      if (!built.ok) { setMessage(proposalErrorMessage(built.code)); return; }
      proposal = built.proposal;
      targetKind = "ENTRY_FIELD";
    } else if (target === "PAYMENT") {
      const activeBankIds = new Set((catalog?.banks ?? []).map((bank) => bank.bank_id));
      const built = buildPaymentProposal({
        baseline: baseline.payment === null ? null : projectPaymentInput({
          state: baseline.payment.state,
          account_number: baseline.payment.account_number,
          bank_id: baseline.payment.bank_id,
          account_holder_name: baseline.payment.account_holder_name,
        }, activeBankIds),
        draft: { state: paymentState, account_number: accountNumber === "" ? null : accountNumber,
          bank_id: bankId === "" ? null : bankId,
          account_holder_name: accountHolder === "" ? null : accountHolder },
        activeBankIds,
      });
      if (!built.ok) { setMessage(proposalErrorMessage(built.code)); return; }
      proposal = built.proposal;
      targetKind = "PAYMENT";
    } else {
      if (targetStatus === "") { setMessage("Chọn trạng thái làm việc mới."); return; }
      const built = buildWorkStatusProposal({
        baseline: baseline.status === null ? null : {
          status: baseline.status, effective_date: baseline.effectiveDate ?? row.first_work_date },
        status: targetStatus as WorkerStatus,
        effectiveDate: effectiveDate === "" ? (baseline.effectiveDate ?? row.first_work_date) : effectiveDate,
        leaveReason,
        today,
      });
      if (!built.ok) { setMessage(proposalErrorMessage(built.code)); return; }
      proposal = built.proposal;
      targetKind = "WORK_STATUS";
    }
    const item = buildChangeRequestItem({
      entryId: row.entry_id, expectedVersion: baseline.version,
      targetKind, proposal: proposal as Record<string, unknown>,
    });
    if (item === null) { setMessage("Đề xuất không hợp lệ."); return; }
    setBusy(true);
    try {
      const response = await fetch(API + "/change-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items: [item], reason: actionReason, idempotency_key: crypto.randomUUID() }),
      });
      setBusy(false);
      if (response.status === 409) { onConflict(); return; }
      if (response.status === 403) {
        notify.error({
          title: "Bạn không còn quyền đề xuất thay đổi.",
          dedupeKey: "worker-propose-err",
        });
        return;
      }
      if (response.status !== 200 && response.status !== 201) {
        notify.error({
          title: "Không gửi được yêu cầu thay đổi. Vui lòng thử lại.",
          dedupeKey: "worker-propose-err",
        });
        return;
      }
      onDone("Đã gửi yêu cầu thay đổi.");
    } catch {
      setBusy(false);
      notify.error({
        title: "Không gửi được yêu cầu thay đổi. Vui lòng thử lại.",
        dedupeKey: "worker-propose-err",
      });
    }
  }

  return (
    <Dialog.Root open={row !== null} onOpenChange={(open) => { if (!open && !busy) onOpenChange(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--backdrop)] backdrop-blur-[7px]" data-ui-overlay-motion="true" />
        <Dialog.Content
          data-ui-dialog-motion="true"
          onCloseAutoFocus={(event) => {
            const opener = openerRef.current;
            if (opener && opener.isConnected) {
              event.preventDefault();
              opener.focus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)]
            w-[calc(100vw-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2
            overflow-hidden rounded-2xl border border-border bg-surface border-t-2 border-t-primary text-foreground shadow-[var(--shadow-dialog)]
            outline-none"
        >
          <form className="flex min-h-0 w-full flex-col"
            onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <header className="flex shrink-0 items-start justify-between gap-4 border-b-2 border-border
              bg-surface px-4 py-4 sm:px-6">
              <div>
                <Dialog.Title className="text-xl font-semibold text-navy">
                  {mode === "correction" ? "Sửa trực tiếp hồ sơ" : "Đề xuất thay đổi"}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted">
                  {mode === "correction"
                    ? "Dữ liệu hiện tại được nạp sẵn — chỉnh phần cần sửa. Lý do thao tác không bắt buộc."
                    : "Dữ liệu hiện tại được nạp sẵn — chỉnh phần cần đổi rồi gửi duyệt. Lý do thao tác không bắt buộc."}
                </Dialog.Description>
              </div>
              <button type="button" aria-label="Đóng đề xuất" disabled={busy}
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-full
                  border border-border bg-surface text-xl text-muted hover:bg-muted/10
                  hover:text-foreground focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-ring/40 disabled:opacity-50"
                onClick={() => onOpenChange(false)}>×</button>
            </header>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-surface-muted px-4 py-4 sm:px-6">
              {row !== null ? (
                <section aria-labelledby="proposal-current-profile"
                  className="rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/15 pb-2">
                    <h3 id="proposal-current-profile" className="text-[15px] font-semibold text-navy">Hồ sơ hiện tại</h3>
                  </div>
                  <dl className="mt-3 grid gap-x-5 gap-y-3 text-sm sm:grid-cols-2">
                    {[
                      ["Họ và tên", row.display_name],
                      ["Mã người lao động", row.employee_code],
                      ["Dự án", row.project_display],
                      ["Ngày bắt đầu làm việc", row.first_work_date],
                      ["Người tuyển / Vendor", row.recruiter_display],
                      ["HRP/Vendor", baseline?.providerType === "hrp" ? "HRP"
                        : baseline?.providerType === "vendor" ? "Vendor" : "—"],
                      ["Loại hình lao động", row.labor_type_display],
                      ["Trạng thái làm việc", workerStatusLabel(baseline?.status ?? row.employment_status)],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
                        <dd className="mt-0.5 break-words font-medium text-foreground">{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
      ) : null}
              <p className="rounded-lg border border-primary/25 bg-surface p-3 text-sm text-navy shadow-[var(--shadow-card)]">
                Các giá trị hiện tại được nạp sẵn. Chỉ nội dung đã thay đổi mới được gửi; dữ liệu khác
                giữ nguyên theo hồ sơ đang lưu.
              </p>
              {profileSaveNotice !== "" ? (
                <p role="status" data-testid="direct-edit-profile-status" className={successClass}>
                  {profileSaveNotice}
                </p>
              ) : null}
              {loading ? (
                <p role="status" className="rounded-lg border border-primary/25 bg-surface p-3 text-sm
                  text-navy shadow-[var(--shadow-card)]">
                  Đang tải dữ liệu…
                </p>
              ) : null}
              {!loading && baseline === null ? (
                <p role="alert" className={errorClass}>
                  Không đọc được dữ liệu hiện tại của dòng này. Vui lòng đóng và thử lại.
                </p>
              ) : null}

              {mode === "proposal" ? (
                <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
                  <label htmlFor="propose-target" className="text-sm font-medium text-navy">Nội dung đề xuất</label>
                  <select id="propose-target" className={inputClass} value={target}
                    disabled={loading || baseline === null}
                    onChange={(event) => { setTarget(event.target.value as WorkerProposeTarget); setMessage(null); }}>
                    {WORKER_PROPOSE_TARGETS.map((value) => (
                      <option key={value} value={value}>{WORKER_PROPOSE_TARGET_LABELS[value]}</option>
                    ))}
                  </select>
                </div>
              ) : null}

              {workerFieldMode ? (
                entryForm !== null && nameAvailability.available ? (
                <section aria-labelledby="worker-profile-fields" className="space-y-4 rounded-xl
                  border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
                  <div className="border-b border-primary/15 pb-2">
                    <h3 id="worker-profile-fields" className="text-[15px] font-semibold text-navy">Thông tin người lao động</h3>
                    <p className="mt-1 text-xs text-muted">Chỉnh trên giá trị hiện tại.</p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-display-name" className="text-sm font-medium">Họ và tên</label>
                    <input id="worker-display-name" className={inputClass}
                      value={entryForm.workerDetails.display_name}
                      onChange={(event) => setEntryForm({ ...entryForm,
                        workerDetails: { ...entryForm.workerDetails, display_name: event.target.value } })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-employee-code" className="text-sm font-medium">
                      Mã người lao động
                    </label>
                    <input id="worker-employee-code" className={inputClass}
                      value={entryForm.employee_code}
                      onChange={(event) => setEntryForm({ ...entryForm,
                        employee_code: event.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-project" className="text-sm font-medium">Dự án</label>
                    <select id="worker-project" className={inputClass} value={entryForm.project_id}
                      disabled={loading || catalog === undefined}
                      onChange={(event) => setEntryForm({ ...entryForm, project_id: event.target.value })}>
                      {buildWorkerEditProjectOptions({
                        catalogProjects: catalog?.projects,
                        currentProjectId: baseline?.projectId ?? entryForm.project_id,
                        currentProjectDisplay: row?.project_display,
                      }).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-first-work-date" className="text-sm font-medium">
                      Ngày bắt đầu làm việc
                    </label>
                    <input id="worker-first-work-date" type="date" className={inputClass}
                      value={entryForm.first_work_date}
                      onChange={(event) => setEntryForm({ ...entryForm,
                        first_work_date: event.target.value })} />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-recruiter" className="text-sm font-medium">
                      Người tuyển
                    </label>
                    <select id="worker-recruiter" className={inputClass} value={entryForm.recruiter_id}
                      disabled={loading || catalog === undefined}
                      onChange={(event) => setEntryForm({ ...entryForm,
                        recruiter_id: event.target.value })}>
                      {buildWorkerEditRecruiterOptions({
                        catalogRecruiters: catalog?.recruiters,
                        currentRecruiterId: baseline?.recruiterId ?? entryForm.recruiter_id,
                        currentRecruiterDisplay: row?.recruiter_display,
                      }).map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-labor-type" className="text-sm font-medium">
                      Loại hình lao động
                    </label>
                    <select id="worker-labor-type" className={inputClass}
                      value={(catalog?.labor_types ?? []).some((option) =>
                        option.labor_type_key === entryForm.labor_type) ? entryForm.labor_type : ""}
                      disabled={loading || catalog === undefined ||
                        (catalog.labor_types ?? []).length === 0}
                      onChange={(event) => setEntryForm({ ...entryForm,
                        labor_type: event.target.value })}>
                      <option value="">Chọn loại hình</option>
                      {sortedActiveLaborTypes(catalog?.labor_types).map((option) => (
                        <option key={option.labor_type_key} value={option.labor_type_key}>
                          {option.display_name}
                        </option>
                      ))}
                    </select>
                    {baseline !== null &&
                      !(catalog?.labor_types ?? []).some((option) =>
                        option.labor_type_key === baseline.laborType) && (
                      <small>Hiện tại: {baseline.laborTypeDisplay} · không còn hoạt động</small>
                    )}
                  </div>
                  {!loading && catalog === undefined && catalogDenied ? (
                    <p role="status" className={infoClass}>
                      Vai trò hiện tại không có quyền đọc danh mục; không thể chọn giá trị danh mục mới.
                    </p>
                  ) : null}
                  {!loading && catalog === undefined && !catalogDenied ? (
                    <p role="alert" className={errorClass}>
                      Không tải được danh mục hiện có. Không thể chọn dự án hoặc người tuyển mới.
                    </p>
                  ) : null}
                  {WORKER_FORM_FIELDS.map((field) => (
                    <div key={field} className="flex flex-col gap-1.5">
                      <label htmlFor={"worker-" + field} className="text-sm font-medium">
                        {WORKER_FIELD_LABELS[field]}
                      </label>
                      {mode === "correction" ? (
                        field === "gender" ? (
                          <select id="worker-gender" className={inputClass}
                            aria-label="Giới tính người lao động"
                            value={entryForm.workerDetails.gender.text}
                            onChange={(event) => setEntryForm({
                              ...entryForm,
                              workerDetails: {
                                ...entryForm.workerDetails,
                                gender: { state: "provided", text: event.target.value },
                              },
                            })}>
                            <option value="">Chưa chọn</option>
                            <option value="FEMALE">Nữ</option>
                            <option value="MALE">Nam</option>
                            <option value="OTHER">Khác</option>
                          </select>
                        ) : field === "date_of_birth" || field === "national_id_issued_at" ? (
                          <input id={"worker-" + field} type="date" className={inputClass}
                            aria-label={WORKER_FIELD_LABELS[field] + " người lao động"}
                            value={entryForm.workerDetails[field].text}
                            onChange={(event) => setEntryForm({
                              ...entryForm,
                              workerDetails: {
                                ...entryForm.workerDetails,
                                [field]: { state: "provided", text: event.target.value },
                              },
                            })} />
                        ) : (
                          <input id={"worker-" + field} className={inputClass}
                            aria-label={WORKER_FIELD_LABELS[field] + " người lao động"}
                            inputMode={field === "national_id" || field === "phone" ? "numeric" : undefined}
                            value={entryForm.workerDetails[field].text}
                            onChange={(event) => setEntryForm({
                              ...entryForm,
                              workerDetails: {
                                ...entryForm.workerDetails,
                                [field]: { state: "provided", text: event.target.value },
                              },
                            })} />
                        )
                      ) : (
                        <div className="grid gap-2 sm:grid-cols-[11rem_1fr]">
                          <select id={"worker-" + field + "-state"} className={inputClass}
                            aria-label={"Trạng thái " + WORKER_FIELD_LABELS[field]}
                            value={entryForm.workerDetails[field].state}
                            onChange={(event) => {
                              const state = event.target.value as WorkerFieldForm["state"];
                              setEntryForm({
                                ...entryForm,
                                workerDetails: {
                                  ...entryForm.workerDetails,
                                  [field]: { state, text: state === "provided"
                                    ? entryForm.workerDetails[field].text : "" },
                                },
                              });
                            }}>
                            <option value="provided">Có giá trị</option>
                            <option value="omitted">{OPTIONAL_STATE_LABELS.omitted}</option>
                            <option value="unknown">{OPTIONAL_STATE_LABELS.unknown}</option>
                             {field === "gender" ? null : (
                               <option value="intentionally_blank">
                                 {OPTIONAL_STATE_LABELS.intentionally_blank}
                               </option>
                             )}
                          </select>
                          {field === "gender" ? (
                            <select id="worker-gender" className={inputClass}
                              aria-label="Giới tính người lao động"
                              disabled={entryForm.workerDetails.gender.state !== "provided"}
                              value={entryForm.workerDetails.gender.text}
                              onChange={(event) => setEntryForm({ ...entryForm,
                                workerDetails: { ...entryForm.workerDetails,
                                  gender: { state: "provided", text: event.target.value } } })}>
                              <option value="">Chọn giới tính</option>
                              <option value="FEMALE">Nữ</option>
                              <option value="MALE">Nam</option>
                              <option value="OTHER">Khác</option>
                            </select>
                          ) : (
                            <input id={"worker-" + field} className={inputClass}
                              aria-label={WORKER_FIELD_LABELS[field] + " người lao động"}
                              inputMode={field === "national_id" || field === "phone" ? "numeric" : undefined}
                              placeholder={field === "date_of_birth" || field === "national_id_issued_at"
                                ? "DD/MM/YYYY" : undefined}
                              disabled={entryForm.workerDetails[field].state !== "provided"}
                              value={entryForm.workerDetails[field].text}
                              onChange={(event) => setEntryForm({
                                ...entryForm,
                                workerDetails: {
                                  ...entryForm.workerDetails,
                                  [field]: { state: "provided", text: event.target.value },
                                },
                              })} />
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </section>
                ) : (
                  <p role="status" className={infoClass} data-testid="propose-worker-unavailable">
                    {nameAvailability.message}
                  </p>
                )
              ) : null}

              {(mode === "correction" || (mode === "proposal" && target === "PAYMENT")) ? (
                <section aria-labelledby="worker-bank-fields" className="space-y-4 rounded-xl
                  border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
                  <div className="border-b border-primary/15 pb-2">
                    <h3 id="worker-bank-fields" className="text-[15px] font-semibold text-navy">{BANK_ACCOUNT_SECTION_LABEL}</h3>
                    <p className="mt-1 text-xs text-muted">
                      Cập nhật tên chủ tài khoản, số tài khoản và ngân hàng.
                    </p>
                  </div>
                  {mode === "correction" ? (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="bank-account" className="text-sm font-medium">Số tài khoản</label>
                        <input id="bank-account" className={inputClass} value={accountNumber}
                          inputMode="numeric"
                          placeholder="Nhập số tài khoản"
                          onChange={(event) => setAccountNumber(event.target.value)} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="bank-id" className="text-sm font-medium">Ngân hàng</label>
                        <DirectEditBankCombobox
                          id="bank-id"
                          options={mergedBankOptions}
                          selectedBankId={bankId}
                          queryText={bankQuery}
                          disabled={busy || loading}
                          onChange={(nextBankId, nextQueryText) => {
                            setBankId(nextBankId);
                            setBankQuery(nextQueryText);
                          }}
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="bank-holder" className="text-sm font-medium">Tên chủ tài khoản</label>
                        <input id="bank-holder" className={inputClass} value={accountHolder}
                          placeholder="Nhập tên chủ tài khoản"
                          onChange={(event) => setAccountHolder(event.target.value)} />
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="bank-state" className="text-sm font-medium">
                          Trạng thái thông tin tài khoản ngân hàng
                        </label>
                        <select id="bank-state" className={inputClass} value={paymentState}
                          onChange={(event) => setPaymentState(event.target.value as PaymentState)}>
                          <option value="omitted">{PAYMENT_STATE_LABELS.omitted}</option>
                          <option value="unknown">{PAYMENT_STATE_LABELS.unknown}</option>
                          <option value="intentionally_blank">{PAYMENT_STATE_LABELS.intentionally_blank}</option>
                          <option value="provided">{PAYMENT_STATE_LABELS.provided}</option>
                        </select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="bank-account" className="text-sm font-medium">Số tài khoản</label>
                        <input id="bank-account" className={inputClass} value={accountNumber}
                          disabled={paymentState !== "provided"}
                          onChange={(event) => setAccountNumber(event.target.value)} />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="bank-id" className="text-sm font-medium">Ngân hàng</label>
                        <select id="bank-id" className={inputClass} value={bankId}
                          disabled={paymentState !== "provided"}
                          onChange={(event) => setBankId(event.target.value)}>
                          <option value="">Chọn ngân hàng</option>
                          {bankId !== "" && !(catalog?.banks ?? []).some((bank) => bank.bank_id === bankId) ? (
                            <option value={bankId}>{baseline?.payment?.bank_name ?? "Ngân hàng hiện tại"}</option>
                          ) : null}
                          {(catalog?.banks ?? []).map((bank) => (
                            <option key={bank.bank_id} value={bank.bank_id}>{bank.display_name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="bank-holder" className="text-sm font-medium">Tên chủ tài khoản</label>
                        <input id="bank-holder" className={inputClass} value={accountHolder}
                          disabled={paymentState !== "provided"}
                          onChange={(event) => setAccountHolder(event.target.value)} />
                      </div>
                    </>
                  )}
                </section>
              ) : null}

              {(mode === "correction" || target === "WORK_STATUS") ? (
                <section aria-labelledby="worker-status-heading"
                  className="space-y-3 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/15 pb-2">
                    <h3 id="worker-status-heading" className="text-[15px] font-semibold text-navy">
                      Trạng thái làm việc
                    </h3>
                    <p className="text-sm text-muted">
                      Trạng thái hiện tại: <strong className="text-foreground">
                        {workerStatusLabel(baseline?.status ?? row?.employment_status ?? null)}
                      </strong>
                    </p>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-target-status" className="text-sm font-medium">
                      Trạng thái làm việc mới
                    </label>
                    <select id="worker-target-status" className={inputClass} value={targetStatus}
                      disabled={loading || baseline?.status == null}
                      onChange={(event) => { setTargetStatus(event.target.value); setMessage(null); }}>
                      <option value="">
                        {mode === "correction" ? "Giữ nguyên trạng thái" : "Chọn trạng thái"}
                      </option>
                      {allowedWorkStatusTargets(baseline?.status ?? null).map((status) => (
                        <option key={status} value={status}>{workerStatusLabel(status)}</option>
                      ))}
                    </select>
                  </div>
                  {targetStatus !== "" ? <div className="flex flex-col gap-1.5">
                    <label htmlFor="worker-effective-date" className="text-sm font-medium">Ngày hiệu lực</label>
                    <input id="worker-effective-date" type="date" className={inputClass}
                      min={baseline?.effectiveDate ?? row?.first_work_date ?? undefined}
                      max={today} value={effectiveDate}
                      disabled={loading || baseline === null}
                      onChange={(event) => setEffectiveDate(event.target.value)} />
                  </div> : null}
                  {targetStatus === "OFF" ? (
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="worker-leave-reason" className="text-sm font-medium">Lý do nghỉ</label>
                      <input id="worker-leave-reason" className={inputClass} value={leaveReason}
                        required aria-required="true"
                        onChange={(event) => setLeaveReason(event.target.value)} />
                    </div>
                  ) : null}
                </section>
              ) : null}

              {mode === "correction" ? (
                <DirectEditFilesSection
                  canUpload={canUploadDocuments}
                  disabled={busy || loading || baseline === null}
                  fileVersions={baseline?.fileVersions ?? {}}
                  selectedFiles={selectedFiles}
                  fileStatuses={fileStatuses}
                  onSelectFile={(kind, file) => {
                    setMessage(null);
                    if (file === null) {
                      setSelectedFiles((prev) => {
                        const next = { ...prev };
                        delete next[kind];
                        return next;
                      });
                      setFileStatuses((prev) => {
                        const next = { ...prev };
                        delete next[kind];
                        return next;
                      });
                      return;
                    }
                    const check = checkDirectEditDocumentFile(kind, file);
                    if (!check.ok) {
                      setSelectedFiles((prev) => {
                        const next = { ...prev };
                        delete next[kind];
                        return next;
                      });
                      setFileStatuses((prev) => ({
                        ...prev,
                        [kind]: {
                          state: "error",
                          text: directEditDocumentErrorMessage(kind, check.code),
                        },
                      }));
                      return;
                    }
                    const hasExisting = (baseline?.fileVersions?.[kind] ?? 0) > 0;
                    setSelectedFiles((prev) => ({ ...prev, [kind]: file }));
                    setFileStatuses((prev) => ({
                      ...prev,
                      [kind]: {
                        state: "selected",
                        text: hasExisting
                          ? "Đã chọn tệp mới để thay thế tài liệu hiện có."
                          : "Đã chọn tệp mới để tải lên.",
                      },
                    }));
                  }}
                  onRetryFile={(kind) => { void retrySingleFile(kind); }}
                />
              ) : null}

              <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
                <label htmlFor={reasonId} className="text-sm font-medium text-navy">
                  {mode === "correction" ? "Lý do chỉnh sửa (không bắt buộc)" : "Lý do đề xuất (không bắt buộc)"}
                </label>
                <textarea id={reasonId}
                  maxLength={mode === "correction" ? 1000 : 4000}
                  className="min-h-24 w-full rounded-md border border-border bg-surface-muted p-3 text-sm
                    text-foreground outline-none focus:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40"
                  value={reason} onChange={(event) => setReason(event.target.value)} />
              </div>
              {message ? <p role="alert" className={errorClass}>{message}</p> : null}
            </div>

            <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-surface px-4 py-3 sm:px-6">
              <button type="button" className={buttonClass} disabled={busy}
                onClick={() => onOpenChange(false)}>Huỷ</button>
              <button type="submit" className={primaryClass}
                disabled={busy || loading || baseline === null ||
                  (workerFieldMode && !nameAvailability.available)} aria-busy={busy}>
                {mode === "correction" ? "Lưu chỉnh sửa trực tiếp" : "Gửi đề xuất"}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Tai Blob tu response thanh file; khong dung XLSX phia client va khong doc PII tu bang. */
function downloadFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * PRE-W2-P1 (T1A): hop thoai "Xuat Excel".
 *
 * Chi gui `scope` + bo loc hien tai + optional `reason` toi POST /api/direct-entry/workers/export;
 * khong gui authority va khong gui PII tu bang. Thanh cong => tai .xlsx tu response Blob. 422
 * row-limit => bao ro gioi han, khong tai file thieu dong. Khong log reason/body/PII.
 */
function WorkerExportDialog({
  open, scope, filters, onOpenChange, onDone,
}: {
  open: boolean;
  scope: WorkerExportScope | null;
  filters: WorkerDirectoryFilters;
  onOpenChange: (open: boolean) => void;
  onDone: (message: string) => void;
}) {
  const reasonId = useId();
  const notify = useNotify();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (scope === null || busy) return;
    const request = buildWorkerExportRequest({
      scope, filters, reason: reason.trim() === "" ? null : reason.trim(),
    });
    if (!request.ok) { setMessage(workerExportRequestMessage(request.code)); return; }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(API + "/workers/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(request.body),
      });
      if (response.status === 200) {
        const blob = await response.blob();
        if (!(await isUsableWorkerExportBlob(blob, response.headers.get("content-type")))) {
          setBusy(false);
          notify.error({
            title: WORKER_EXPORT_EMPTY_FILE_MESSAGE,
            dedupeKey: "worker-export-err",
          });
          return;
        }
        downloadFile(blob, workerExportFilename(
          response.headers.get("content-disposition"), hcmTodayDate()));
        setBusy(false);
        onDone("Đã tải danh sách người lao động (.xlsx).");
        return;
      }
      const payload = await readJson(response);
      setBusy(false);
      notify.error({
        title: workerExportErrorMessage(response.status, payload),
        dedupeKey: "worker-export-err",
      });
    } catch {
      setBusy(false);
      notify.error({
        title: workerExportErrorMessage(0, null),
        dedupeKey: "worker-export-err",
      });
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onOpenChange(false); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[var(--backdrop)] backdrop-blur-[7px]" data-ui-overlay-motion="true" />
        <Dialog.Content
          data-ui-dialog-motion="true"
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)]
            w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2
            overflow-hidden rounded-2xl border border-border bg-surface border-t-2 border-t-primary text-foreground shadow-[var(--shadow-dialog)]
            outline-none"
        >
          <form className="flex min-h-0 w-full flex-col"
            onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <header className="flex shrink-0 items-start justify-between gap-4 border-b-2 border-border
              bg-surface px-4 py-4 sm:px-5">
              <div>
                <Dialog.Title className="text-xl font-semibold text-navy">Xuất Excel</Dialog.Title>
                <Dialog.Description className="mt-1 text-sm text-muted">
                  Xuất danh sách người lao động theo đúng quan hệ và bộ lọc đang chọn. Lý do không
                  bắt buộc; thao tác vẫn được ghi nhận vào nhật ký.
                </Dialog.Description>
              </div>
              <button type="button" aria-label="Đóng xuất Excel" disabled={busy}
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-full
                  border border-border bg-surface text-xl text-muted hover:bg-muted/10
                  hover:text-foreground focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-ring/40 disabled:opacity-50"
                onClick={() => onOpenChange(false)}>×</button>
            </header>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-surface-muted px-4 py-4 sm:px-5">
              <p className={infoClass}>
                File có thể chứa đầy đủ CCCD, ngày sinh, số điện thoại, địa chỉ và thông tin tài
                khoản ngân hàng. Chỉ lưu hoặc chia sẻ với người có thẩm quyền.
              </p>
              <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
                <label htmlFor={reasonId} className="text-sm font-medium text-navy">
                  Lý do xuất (không bắt buộc)
                </label>
                <textarea id={reasonId}
                  maxLength={WORKER_EXPORT_REASON_MAX}
                  disabled={busy}
                  className="min-h-24 w-full rounded-md border border-border bg-surface-muted p-3 text-sm
                    text-foreground outline-none focus:bg-surface focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
                  value={reason} onChange={(event) => setReason(event.target.value)} />
              </div>
              {busy ? (
                <div role="status" aria-live="polite" data-testid="worker-export-pending" className={infoClass}>
                  <p>Đang tổng hợp dữ liệu và tạo tệp Excel trên máy chủ…</p>
                  <progress aria-label="Đang xuất danh sách người lao động" className="mt-2 h-2 w-full" />
                </div>
              ) : null}
              {message ? <p role="alert" className={errorClass}>{message}</p> : null}
            </div>

            <footer className="flex shrink-0 justify-end gap-2 border-t border-border bg-surface px-4 py-3 sm:px-5">
              <button type="button" className={buttonClass} disabled={busy}
                onClick={() => onOpenChange(false)}>Huỷ</button>
              <button type="submit" className={primaryClass}
                disabled={busy || scope === null} aria-busy={busy}>
                {busy ? "Đang xuất…" : "Tải xuống"}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DirectEditFilesSection({
  canUpload,
  disabled,
  fileVersions,
  selectedFiles,
  fileStatuses,
  onSelectFile,
  onRetryFile,
}: {
  canUpload: boolean;
  disabled: boolean;
  fileVersions: Readonly<Partial<Record<DirectEditDocumentType, number>>>;
  selectedFiles: Readonly<Partial<Record<DirectEditDocumentType, File>>>;
  fileStatuses: Readonly<Partial<Record<DirectEditDocumentType, DirectEditFileStatus>>>;
  onSelectFile: (kind: DirectEditDocumentType, file: File | null) => void;
  onRetryFile: (kind: DirectEditDocumentType) => void;
}) {
  const smallBtnClass = buttonClasses({ variant: "secondary", size: "sm" });
  return (
    <section
      aria-labelledby="worker-files-heading"
      data-testid="direct-edit-documents-section"
      className="space-y-4 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]"
    >
      <div className="border-b border-primary/15 pb-2">
        <h3 id="worker-files-heading" className="text-[15px] font-semibold text-navy">Tài liệu hồ sơ</h3>
        <p className="mt-1 text-xs text-muted">
          Tải mới hoặc thay thế ảnh NLĐ, CCCD mặt trước, CCCD mặt sau và hợp đồng lao động. Mỗi tệp
          được tải lên kho lưu trữ riêng tư và xác thực độc lập.
        </p>
      </div>
      {!canUpload ? (
        <p role="status" data-testid="direct-edit-documents-denied" className={infoClass}>
          Tài khoản hiện tại chưa được cấp quyền tải tài liệu hồ sơ (document_upload). Bạn vẫn có
          thể lưu thông tin cá nhân, công việc và tài khoản ngân hàng.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        {DIRECT_EDIT_DOCUMENT_TYPES.map((kind) => {
          const currentVersion = fileVersions[kind] ?? 0;
          const selectedFile = selectedFiles[kind];
          const status = fileStatuses[kind];
          const inputId = "direct-edit-doc-" + kind;
          return (
            <div
              key={kind}
              data-testid={"direct-edit-doc-row-" + kind}
              className="rounded-lg border border-border bg-surface-muted p-3 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={inputId} className="text-sm font-medium text-navy">
                  {DIRECT_EDIT_DOCUMENT_LABELS[kind]}
                </label>
                <StatusBadge tone={currentVersion > 0 ? "success" : "neutral"}>
                  {currentVersion > 0
                    ? "Hiện có v" + currentVersion + " · Thay thế"
                    : "Chưa có · Tải mới"}
                </StatusBadge>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id={inputId}
                  data-testid={"direct-edit-doc-input-" + kind}
                  type="file"
                  accept={DIRECT_EDIT_DOCUMENT_ACCEPT[kind]}
                  disabled={disabled || !canUpload || status?.state === "uploading"}
                  className={
                    inputClass +
                    " py-1.5 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary/10 file:px-3 file:py-1 file:text-xs file:font-medium file:text-primary hover:file:bg-primary/15"
                  }
                  onChange={(event) => {
                    const nextFile = event.currentTarget.files?.[0] ?? null;
                    onSelectFile(kind, nextFile);
                    event.currentTarget.value = "";
                  }}
                />
                {selectedFile !== undefined && status?.state !== "uploading" ? (
                  <button
                    type="button"
                    className={smallBtnClass}
                    disabled={disabled}
                    onClick={() => onSelectFile(kind, null)}
                  >
                    Bỏ chọn
                  </button>
                ) : null}
              </div>
              {selectedFile !== undefined ? (
                <p className="text-xs text-muted">
                  Tệp đã chọn · {(selectedFile.size / (1024 * 1024)).toFixed(2)} MiB
                </p>
              ) : null}
              {status !== undefined ? (
                <div
                  role={status.state === "error" ? "alert" : "status"}
                  data-testid={"direct-edit-doc-status-" + kind}
                  className={
                    status.state === "error"
                      ? "flex flex-wrap items-center justify-between gap-2 " + errorClass
                      : status.state === "saved"
                        ? successClass
                        : infoClass
                  }
                >
                  <span>{status.text}</span>
                  {status.state === "error" && selectedFile !== undefined ? (
                    <button
                      type="button"
                      data-testid={"direct-edit-doc-retry-" + kind}
                      className={smallBtnClass}
                      disabled={disabled}
                      onClick={() => onRetryFile(kind)}
                    >
                      Thử lại tệp này
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DirectEditBankCombobox({
  id,
  options,
  selectedBankId,
  queryText,
  disabled,
  onChange,
}: {
  id: string;
  options: readonly MergedBankCatalogOption[];
  selectedBankId: string;
  queryText: string;
  disabled: boolean;
  onChange: (bankId: string, queryText: string) => void;
}) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const searchItems = useMemo(
    () =>
      options.map((option) => ({
        id: option.bank_id,
        label: option.label,
        keywords: option.keywords,
      })),
    [options],
  );

  const filteredItems = useMemo(
    () => filterCatalogSearchOptions(searchItems, queryText),
    [searchItems, queryText],
  );

  const optionById = useMemo(
    () => new Map(options.map((option) => [option.bank_id, option])),
    [options],
  );

  const selectedOption = useMemo(
    () =>
      (selectedBankId !== "" ? optionById.get(selectedBankId) : undefined) ??
      resolveBankCatalogOption(options, queryText),
    [optionById, options, queryText, selectedBankId],
  );

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function selectBankOption(option: MergedBankCatalogOption): void {
    onChange(option.bank_id, option.short_name);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative flex flex-col gap-1">
      <input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        className={inputClass}
        value={queryText}
        placeholder="Tìm mã ngân hàng, tên thường gọi hoặc tên đầy đủ (VD: TCB, Techcombank)"
        onFocus={() => {
          if (!disabled) {
            setOpen(true);
            setActiveIndex(0);
          }
        }}
        onChange={(event) => {
          const nextText = event.target.value;
          const resolved = resolveBankCatalogOption(options, nextText);
          onChange(resolved?.bank_id ?? "", nextText);
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={(event) => {
          const action = typeaheadKeyAction(event.key, event.nativeEvent.isComposing);
          if (action === "up" || action === "down") {
            event.preventDefault();
            setOpen(true);
            setActiveIndex((current) =>
              moveTypeaheadIndex(current, filteredItems.length, action),
            );
          } else if (action === "close" || action === "tab") {
            setOpen(false);
          } else if (action === "commit") {
            const candidate = filteredItems[activeIndex];
            const bankOption = candidate ? optionById.get(candidate.id) : undefined;
            if (bankOption !== undefined) {
              event.preventDefault();
              selectBankOption(bankOption);
            }
          }
        }}
      />
      {selectedOption !== null && selectedOption !== undefined ? (
        <p className="text-xs text-muted" data-testid="direct-edit-bank-resolved">
          {selectedOption.label}
        </p>
      ) : queryText.trim() !== "" ? (
        <p className="text-xs text-muted" data-testid="direct-edit-bank-custom">
          Chưa có trong danh mục — sẽ lưu tên ngân hàng dạng tham chiếu.
        </p>
      ) : null}
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Danh mục ngân hàng VietQR"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-y-auto rounded-xl border border-border bg-surface p-1 text-foreground shadow-lg"
        >
          {filteredItems.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted">
              Không khớp danh mục VietQR — nhấn Lưu để giữ tên ngân hàng đã nhập làm tham chiếu.
            </p>
          ) : (
            filteredItems.slice(0, 30).map((item, index) => {
              const bankOption = optionById.get(item.id);
              if (bankOption === undefined) return null;
              const isSelected = selectedOption?.bank_id === bankOption.bank_id;
              return (
                <button
                  key={bankOption.bank_id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={
                    "flex w-full flex-col items-start rounded-lg px-3 py-2 text-left text-sm " +
                    (index === activeIndex ? "bg-muted/15 font-medium" : "hover:bg-muted/10")
                  }
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectBankOption(bankOption)}
                >
                  <span>
                    {bankOption.short_name} ({bankOption.bank_code})
                  </span>
                  <span className="text-xs text-muted">{bankOption.official_name}</span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
