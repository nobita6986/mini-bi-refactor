"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "radix-ui/dialog";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { useNotify } from "@/components/ui/notify-provider";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { PersonnelTeamMembershipManager } from "@/components/admin/personnel-team-membership-manager";
import {
  buildPersonnelListQuery,
  buildPersonnelSetActiveRequest,
  buildPersonnelUpdateRequest,
  classifyPersonnelMutation,
  newPersonnelIntentKey,
  personnelConflictsForDialog,
  projectPersonnelItem,
  projectPersonnelListForQuery,
  setPersonnelConflictLock,
  type PersonnelMutationOutcome,
} from "@/lib/admin/personnel-catalog-model";
import {
  buildEligibleAccountsQuery,
  buildLinkRecruiterAccountRequest,
  buildPersonnelFromAccountRequest,
  buildRecruiterLinkStatusQuery,
  classifyAccountOperationResponse,
  projectEligibleAccounts,
  projectRecruiterLinkCandidates,
  projectRecruiterLinkStatus,
} from "@/lib/admin/account-operation-ui-model";
import { projectAccountItem } from "@/lib/admin/account-access-model";
import type {
  AdminPersonnel,
  AdminPersonnelList,
  PersonnelPosition,
} from "@/lib/direct-entry/personnel-catalog-contract";
import type {
  EligibleAccount,
  RecruiterLinkCandidate,
  RecruiterLinkCandidatesEnvelope,
} from "@/lib/admin/account-operation-contract";

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; list: AdminPersonnelList }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; personnel: AdminPersonnel }
  | { kind: "active"; personnel: AdminPersonnel; active: boolean }
  | { kind: "link"; personnel: AdminPersonnel };

type PersonnelForm = {
  personnelCode: string;
  displayName: string;
  personnelPosition: PersonnelPosition | "";
  validFrom: string;
  reason: string;
};

type MutationIntent = {
  url: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
  operation: "create" | "update" | "set-active" | "link";
  recruiterId: string | null;
  lockId: string;
  retryState: "ready" | "retry";
};

type ConflictEntry = { intent: MutationIntent; error: string | null };

const EMPTY_FORM: PersonnelForm = {
  personnelCode: "",
  displayName: "",
  personnelPosition: "",
  validFrom: "",
  reason: "",
};

function responseOutcome(status: number, payload: unknown, intent: MutationIntent): PersonnelMutationOutcome {
  if (intent.operation === "create" || intent.operation === "link") {
    const outcome = classifyAccountOperationResponse(status, payload);
    if (outcome.kind === "applied") return { kind: "applied" } as unknown as PersonnelMutationOutcome;
    if (intent.operation === "link" && outcome.kind === "conflict") {
      return {
        kind: "conflict",
        message: "Hồ sơ nhân sự hoặc tài khoản đã có liên kết hiệu lực hoặc dữ liệu đã thay đổi. Vui lòng tải lại.",
      } as unknown as PersonnelMutationOutcome;
    }
    return {
      kind: outcome.kind === "needs-reconcile" ? "unavailable" : outcome.kind,
      message: outcome.message,
    } as unknown as PersonnelMutationOutcome;
  }
  return classifyPersonnelMutation(status, payload, intent.operation);
}

function messageForOutcome(outcome: Exclude<PersonnelMutationOutcome, { kind: "applied" }>): string {
  return outcome.message;
}

function formatHrpDate(value: string | null): string {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function positionLabel(value: PersonnelPosition | null): string {
  if (value === "TEAM_LEADER") return "Trưởng nhóm";
  if (value === "STAFF") return "Nhân viên";
  return "Chưa xác định";
}

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <StatusBadge tone={active ? "success" : "neutral"} dot>
      {active ? "Đang hoạt động" : "Ngừng hoạt động"}
    </StatusBadge>
  );
}

export function PersonnelCatalogManager() {
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [membershipPersonnel, setMembershipPersonnel] = useState<AdminPersonnel | null>(null);
  const membershipTrigger = useRef<HTMLButtonElement | null>(null);
  const [form, setForm] = useState<PersonnelForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingIntent, setPendingIntent] = useState<MutationIntent | null>(null);
  const [conflictIntents, setConflictIntents] = useState<ReadonlyMap<string, ConflictEntry>>(new Map());
  const [busy, setBusy] = useState(false);
  const [conflictLocks, setConflictLocks] = useState<ReadonlySet<string>>(new Set());
  const notify = useNotify();
  const [eligibleAccounts, setEligibleAccounts] = useState<EligibleAccount[]>([]);
  const [eligibleState, setEligibleState] = useState<"idle" | "loading" | "ready" | "empty" | "error">("idle");
  const [eligiblePage, setEligiblePage] = useState(1);
  const [eligibleHasMore, setEligibleHasMore] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<EligibleAccount | null>(null);
  const [accountVersion, setAccountVersion] = useState<number | null>(null);
  const selectedAccountRef = useRef<string | null>(null);
  const [linkedRecruiterIds, setLinkedRecruiterIds] = useState<ReadonlySet<string>>(new Set());
  const [canLinkAccounts, setCanLinkAccounts] = useState(true);
  const [linkCandidatesState, setLinkCandidatesState] = useState<
    "idle" | "loading" | "ready" | "empty" | "already-linked" | "error"
  >("idle");
  const [linkCandidateEnvelope, setLinkCandidateEnvelope] = useState<RecruiterLinkCandidatesEnvelope | null>(null);
  const [selectedLinkCandidate, setSelectedLinkCandidate] = useState<RecruiterLinkCandidate | null>(null);
  const linkCandidatesRecruiterRef = useRef<string | null>(null);

  const loadLinkCandidates = useCallback(async (recruiterId: string) => {
    linkCandidatesRecruiterRef.current = recruiterId;
    setLinkCandidatesState("loading");
    setLinkCandidateEnvelope(null);
    setSelectedLinkCandidate(null);
    try {
      const response = await fetch(
        `/api/admin/catalog/personnel/${encodeURIComponent(recruiterId)}/link-account`,
        { method: "GET", cache: "no-store", headers: { Accept: "application/json" } },
      );
      if (linkCandidatesRecruiterRef.current !== recruiterId) return;
      if (response.status === 401 || response.status === 403) {
        setCanLinkAccounts(false);
        setLinkCandidatesState("error");
        return;
      }
      if (response.status !== 200) {
        setLinkCandidatesState("error");
        return;
      }
      const projected = projectRecruiterLinkCandidates(await response.json());
      if (linkCandidatesRecruiterRef.current !== recruiterId) return;
      if (!projected || projected.recruiter_id !== recruiterId) {
        setLinkCandidatesState("error");
        return;
      }
      setLinkCandidateEnvelope(projected);
      if (projected.already_linked) {
        setLinkedRecruiterIds((current) => {
          const next = new Set(current);
          next.add(recruiterId);
          return next;
        });
        setLinkCandidatesState("already-linked");
        return;
      }
      if (projected.candidates.length === 0) {
        setLinkCandidatesState("empty");
        return;
      }
      setSelectedLinkCandidate(projected.candidates[0]);
      setLinkCandidatesState("ready");
    } catch {
      if (linkCandidatesRecruiterRef.current !== recruiterId) return;
      setLinkCandidatesState("error");
    }
  }, []);

  const loadEligibleAccounts = useCallback(async (targetPage: number) => {
    const query = buildEligibleAccountsQuery(targetPage);
    if (!query) return;
    setEligibleState("loading");
    setSelectedAccount(null);
    setAccountVersion(null);
    selectedAccountRef.current = null;
    try {
      const response = await fetch(`/api/admin/catalog/personnel/eligible-accounts?${query.toString()}`, {
        method: "GET", cache: "no-store", headers: { Accept: "application/json" },
      });
      if (response.status === 401 || response.status === 403) { setEligibleState("error"); return; }
      if (response.status !== 200) { setEligibleState("error"); return; }
      const list = projectEligibleAccounts(await response.json());
      if (!list) { setEligibleState("error"); return; }
      setEligibleAccounts(list.accounts);
      setEligiblePage(list.page);
      setEligibleHasMore(list.has_more);
      setEligibleState(list.accounts.length === 0 ? "empty" : "ready");
    } catch {
      setEligibleState("error");
    }
  }, []);

  const selectEligibleAccount = useCallback(async (account: EligibleAccount) => {
    selectedAccountRef.current = account.app_user_id;
    setSelectedAccount(account);
    setAccountVersion(null);
    try {
      const response = await fetch(`/api/admin/access/accounts/${encodeURIComponent(account.app_user_id)}`, {
        method: "GET", cache: "no-store", headers: { Accept: "application/json" },
      });
      const detail = response.status === 200 ? projectAccountItem(await response.json()) : null;
      // Stale response guard: only apply the version if this is still the selected account.
      if (selectedAccountRef.current !== account.app_user_id) return;
      if (!detail || detail.account_ref !== account.app_user_id || !detail.enabled) {
        setAccountVersion(null);
        return;
      }
      setAccountVersion(detail.version);
    } catch {
      if (selectedAccountRef.current !== account.app_user_id) return;
      setAccountVersion(null);
    }
  }, []);

  const changeEligiblePage = useCallback((nextPage: number) => {
    if (!Number.isSafeInteger(nextPage) || nextPage < 1 || nextPage > 1000) return;
    setEligiblePage(nextPage);
    void loadEligibleAccounts(nextPage);
  }, [loadEligibleAccounts]);

  useEffect(() => {
    const listQuery = buildPersonnelListQuery({ search, includeInactive, page });
    if (!listQuery) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      let response: Response;
      try {
        response = await fetch(`/api/admin/catalog/personnel?${listQuery.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setListState({ kind: "unavailable" });
        return;
      }
      if (response.status === 401 || response.status === 403) {
        setListState({ kind: "denied" });
        return;
      }
      if (response.status !== 200) {
        setListState(response.status === 404 || response.status >= 500
          ? { kind: "unavailable" }
          : { kind: "error" });
        return;
      }
      try {
        const list = projectPersonnelListForQuery(await response.json(), {
          search,
          includeInactive,
          page,
        });
        if (!list) {
          setListState({ kind: "error" });
          return;
        }
        const pages = Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size)));
        if (page > pages) {
          setPage(Math.min(1000, pages));
          return;
        }
        setListState({ kind: "loaded", list });
      } catch {
        setListState({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [includeInactive, page, reloadToken, search]);

  useEffect(() => {
    if (listState.kind !== "loaded") return;
    const recruiterIds = listState.list.personnel.map((row) => row.recruiter_id);
    const statusQuery = buildRecruiterLinkStatusQuery(recruiterIds);
    if (!statusQuery) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/admin/catalog/personnel/link-status?${statusQuery.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (response.status === 401 || response.status === 403) {
          setCanLinkAccounts(false);
          setLinkedRecruiterIds(new Set());
          return;
        }
        if (response.status !== 200) return;
        const projected = projectRecruiterLinkStatus(await response.json());
        if (!projected) return;
        setCanLinkAccounts(true);
        setLinkedRecruiterIds(new Set(projected.linked_recruiter_ids));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    })();
    return () => controller.abort();
  }, [listState]);

  const reloadList = () => {
    setListState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const changeForm = useCallback(<K extends keyof PersonnelForm>(field: K, value: PersonnelForm[K]) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFormError(null);
  }, []);

  const startCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setSelectedAccount(null);
    setAccountVersion(null);
    selectedAccountRef.current = null;
    setEligibleAccounts([]);
    setEligiblePage(1);
    setEligibleHasMore(false);
    setEligibleState("loading");
    setDialog({ kind: "create" });
    void loadEligibleAccounts(1);
  };

  const startEdit = (personnel: AdminPersonnel) => {
    setForm({
      personnelCode: personnel.personnel_code ?? "",
      displayName: personnel.display_name,
      personnelPosition: personnel.personnel_position ?? "",
      validFrom: "",
      reason: "",
    });
    setFormError(null);
    setDialog({ kind: "edit", personnel });
  };

  const startActiveChange = (personnel: AdminPersonnel, active: boolean) => {
    setForm({ ...EMPTY_FORM, reason: "" });
    setFormError(null);
    setDialog({ kind: "active", personnel, active });
  };

  const startLinkAccount = (personnel: AdminPersonnel) => {
    setForm({ ...EMPTY_FORM, reason: "" });
    setFormError(null);
    setDialog({ kind: "link", personnel });
    void loadLinkCandidates(personnel.recruiter_id);
  };

  const reloadConflictedEntity = useCallback(async (intent: MutationIntent) => {
    setConflictIntents((current) => {
      const next = new Map(current);
      const entry = next.get(intent.lockId);
      if (entry) next.set(intent.lockId, { ...entry, error: null });
      return next;
    });
    setBusy(true);
    try {
      if (intent.recruiterId) {
        const response = await fetch(
          `/api/admin/catalog/personnel/${encodeURIComponent(intent.recruiterId)}`,
          { method: "GET", cache: "no-store", headers: { Accept: "application/json" } },
        );
        if (response.status === 404) {
          setConflictLocks((current) => setPersonnelConflictLock(current, intent.lockId, false));
          setConflictIntents((current) => {
            const next = new Map(current);
            next.delete(intent.lockId);
            return next;
          });
          notify.warning({ title: "Hồ sơ nhân sự không còn tồn tại hoặc không còn khả dụng. Danh sách đang được cập nhật." });
          setPendingIntent(null);
          setDialog(null);
          setListState({ kind: "loading" });
          setReloadToken((value) => value + 1);
          return;
        }
        if (response.status !== 200) throw new Error("reload");
        const personnel = projectPersonnelItem(await response.json());
        if (!personnel) throw new Error("reload");
        setListState((current) => current.kind === "loaded"
          ? {
              ...current,
              list: {
                ...current.list,
                personnel: current.list.personnel.map((row) =>
                  row.recruiter_id === personnel.recruiter_id ? personnel : row),
              },
            }
          : current);
      } else {
        const code = String(intent.body.personnel_code ?? "");
        const query = buildPersonnelListQuery({
          search: code,
          includeInactive: true,
          page: 1,
        });
        if (!query) throw new Error("reload");
        const response = await fetch(`/api/admin/catalog/personnel?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        if (response.status !== 200 || !projectPersonnelListForQuery(await response.json(), {
          search: code,
          includeInactive: true,
          page: 1,
        })) {
          throw new Error("reload");
        }
      }
      setConflictLocks((current) => setPersonnelConflictLock(current, intent.lockId, false));
      setConflictIntents((current) => {
        const next = new Map(current);
        next.delete(intent.lockId);
        return next;
      });
      notify.info({ title: "Đã tải dữ liệu mới nhất. Bạn có thể bắt đầu thao tác mới." });
      setPendingIntent(null);
      setDialog(null);
      setListState({ kind: "loading" });
      setReloadToken((value) => value + 1);
    } catch {
      const reloadError = "Không tải được dữ liệu có thẩm quyền. Thao tác vẫn đang bị khóa; hãy thử tải lại.";
      setConflictIntents((current) => {
        const next = new Map(current);
        const entry = next.get(intent.lockId);
        if (entry) {
          next.set(intent.lockId, {
            ...entry,
            error: reloadError,
          });
        }
        return next;
      });
      notify.error({ title: reloadError });
    } finally {
      setBusy(false);
    }
  }, [notify]);

  const sendIntent = useCallback(async (intent: MutationIntent) => {
    setBusy(true);
    try {
      let response: Response;
      try {
        response = await fetch(intent.url, {
          method: intent.method,
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(intent.body),
        });
      } catch {
        setPendingIntent({ ...intent, retryState: "retry" });
        notify.warning({ title: "Không nhận được phản hồi. Có thể thử lại đúng thao tác này." });
        return;
      }
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const outcome = responseOutcome(response.status, payload, intent);
      if (outcome.kind === "applied") {
        setPendingIntent(null);
        setDialog(null);
        setForm(EMPTY_FORM);
        notify.success({ title: "Đã lưu thay đổi. Danh sách đang được cập nhật." });
        setListState({ kind: "loading" });
        setReloadToken((value) => value + 1);
        return;
      }
      if (outcome.kind === "conflict") {
        setPendingIntent(null);
        setConflictIntents((current) => new Map(current).set(intent.lockId, { intent, error: null }));
        setConflictLocks((current) => setPersonnelConflictLock(current, intent.lockId, true));
        notify.warning({ title: messageForOutcome(outcome) });
        return;
      }
      if (outcome.kind === "unavailable") {
        setPendingIntent({ ...intent, retryState: "retry" });
        notify.warning({ title: messageForOutcome(outcome) });
      } else {
        setPendingIntent(null);
        setFormError(messageForOutcome(outcome));
        notify.error({ title: messageForOutcome(outcome) });
      }
    } finally {
      setBusy(false);
    }
  }, [notify]);

  const submitMutation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!dialog) return;
    if (isConflictLocked) {
      setFormError("Hồ sơ đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền.");
      return;
    }
    if (pendingIntent) {
      setFormError("Có thao tác chưa nhận được kết quả. Hãy thử lại thao tác đó trước.");
      return;
    }

    const idempotencyKey = newPersonnelIntentKey();
    let request;
    let intent: MutationIntent;
    if (dialog.kind === "create") {
      if (!selectedAccount || accountVersion === null) {
        setFormError("Chọn một tài khoản đang hoạt động và chưa liên kết để tạo nhân sự.");
        return;
      }
      if (selectedAccount.display_name.trim().toLowerCase() === selectedAccount.login_id.toLowerCase()) {
        setFormError("Tài khoản chưa có tên thật. Hãy cập nhật tên hiển thị trong mục Tài khoản trước.");
        return;
      }
      request = buildPersonnelFromAccountRequest({
        accountRef: selectedAccount.app_user_id,
        expectedAccountVersion: accountVersion,
        loginId: selectedAccount.login_id,
        personnelPosition: form.personnelPosition,
        validFrom: form.validFrom,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: "/api/admin/catalog/personnel/from-account",
        method: "POST",
        body: request.body,
        operation: "create",
        recruiterId: null,
        lockId: "create",
        retryState: "ready",
      };
    } else if (dialog.kind === "edit") {
      if (conflictLocks.has(dialog.personnel.recruiter_id)) {
        setFormError("Hồ sơ đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền.");
        return;
      }
      request = buildPersonnelUpdateRequest({
        personnelCode: form.personnelCode,
        displayName: form.displayName,
        personnelPosition: form.personnelPosition,
        expectedVersion: dialog.personnel.version,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: `/api/admin/catalog/personnel/${encodeURIComponent(dialog.personnel.recruiter_id)}`,
        method: "PATCH",
        body: request.body,
        operation: "update",
        recruiterId: dialog.personnel.recruiter_id,
        lockId: dialog.personnel.recruiter_id,
        retryState: "ready",
      };
    } else if (dialog.kind === "link") {
      if (conflictLocks.has(dialog.personnel.recruiter_id)) {
        setFormError("Hồ sơ đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền.");
        return;
      }
      if (!selectedLinkCandidate || !linkCandidateEnvelope ||
          linkCandidateEnvelope.recruiter_id !== dialog.personnel.recruiter_id) {
        setFormError("Chọn tài khoản truy cập đang hoạt động, chưa liên kết và khớp mã nhân sự để liên kết.");
        return;
      }
      request = buildLinkRecruiterAccountRequest({
        accountRef: selectedLinkCandidate.app_user_id,
        expectedAccountVersion: selectedLinkCandidate.version,
        expectedRecruiterVersion: linkCandidateEnvelope.version,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: `/api/admin/catalog/personnel/${encodeURIComponent(dialog.personnel.recruiter_id)}/link-account`,
        method: "POST",
        body: request.body,
        operation: "link",
        recruiterId: dialog.personnel.recruiter_id,
        lockId: dialog.personnel.recruiter_id,
        retryState: "ready",
      };
    } else {
      if (conflictLocks.has(dialog.personnel.recruiter_id)) {
        setFormError("Hồ sơ đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền.");
        return;
      }
      request = buildPersonnelSetActiveRequest({
        active: dialog.active,
        expectedVersion: dialog.personnel.version,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: `/api/admin/catalog/personnel/${encodeURIComponent(dialog.personnel.recruiter_id)}/active`,
        method: "POST",
        body: request.body,
        operation: "set-active",
        recruiterId: dialog.personnel.recruiter_id,
        lockId: dialog.personnel.recruiter_id,
        retryState: "ready",
      };
    }
    setPendingIntent(intent);
    void sendIntent(intent);
  };

  const list = listState.kind === "loaded" ? listState.list : null;
  const pageCount = list
    ? Math.min(1000, Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))))
    : 1;
  const dialogLockId = dialog === null
    ? null
    : dialog.kind === "create"
      ? "create"
      : dialog.personnel.recruiter_id;
  const isConflictLocked = dialogLockId !== null && conflictLocks.has(dialogLockId);
  const updateMembershipConflictLock = useCallback((recruiterId: string, locked: boolean) => {
    setConflictLocks((current) => setPersonnelConflictLock(current, recruiterId, locked));
  }, []);
  const updateReloadedPersonnel = useCallback((personnel: AdminPersonnel) => {
    setListState((current) => current.kind === "loaded"
      ? {
          ...current,
          list: {
            ...current.list,
            personnel: current.list.personnel.map((row) =>
              row.recruiter_id === personnel.recruiter_id ? personnel : row),
          },
        }
      : current);
    setMembershipPersonnel((current) => current?.recruiter_id === personnel.recruiter_id
      ? personnel
      : current);
  }, []);

  return (
    <Dialog.Root
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open && !busy) setDialog(null);
      }}
    >
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Danh mục nhân sự</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Quản lý thông tin hồ sơ HRP. Vị trí trong hồ sơ chỉ là thuộc tính nghiệp vụ,
            không cấp quyền truy cập.
          </p>
        </div>
          <Dialog.Trigger asChild>
            <button
              type="button"
              onClick={startCreate}
              className="inline-flex min-h-11 whitespace-nowrap shrink-0 items-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              Tạo nhân sự từ tài khoản
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
            <Dialog.Content
              onCloseAutoFocus={(event) => {
                if (busy) event.preventDefault();
              }}
              className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl focus:outline-none sm:p-6"
              aria-describedby="personnel-dialog-description"
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="text-xl font-semibold text-foreground">
                    {dialog?.kind === "create" ? "Tạo nhân sự từ tài khoản" :
                      dialog?.kind === "edit" ? "Chỉnh sửa nhân sự" :
                        dialog?.kind === "link" ? "Liên kết tài khoản truy cập" :
                          dialog?.active ? "Kích hoạt hồ sơ" : "Ngừng hoạt động hồ sơ"}
                  </Dialog.Title>
                  <Dialog.Description id="personnel-dialog-description" className="mt-1 text-sm text-muted">
                    Lý do thao tác không bắt buộc. Dữ liệu được kiểm tra lại trước khi lưu.
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Đóng hộp thoại"
                    disabled={busy}
                    className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </Dialog.Close>
              </div>

              {pendingIntent?.retryState === "retry" ? (
                <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
                  <p>Thử lại đúng thao tác này bằng cùng một khóa để tránh thay đổi trùng lặp.</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void sendIntent(pendingIntent)}
                    className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50"
                  >
                    Thử lại thao tác
                  </button>
                </Alert>
              ) : null}
              {personnelConflictsForDialog(conflictIntents, dialogLockId).map(({ intent, error }) => (
                <ConflictReload
                  key={intent.lockId}
                  message={error}
                  busy={busy}
                  onReload={() => void reloadConflictedEntity(intent)}
                />
              ))}

              {dialog?.kind === "active" ? (
                <div className="mt-5 space-y-4">
                  <p>
                    {dialog.active ? "Bạn sắp kích hoạt hồ sơ" : "Bạn sắp ngừng hoạt động hồ sơ"}{" "}
                    <strong>{dialog.personnel.display_name}</strong>
                    {dialog.personnel.personnel_code
                      ? ` (${dialog.personnel.personnel_code})`
                      : ""}. Thao tác này không xóa dữ liệu.
                  </p>
                  <form onSubmit={submitMutation} className="space-y-4">
                    <ReasonField value={form.reason} onChange={(value) => changeForm("reason", value)} />
                    {formError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{formError}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                      <Dialog.Close asChild>
                        <button type="button" disabled={busy} className="min-h-11 rounded-md border border-border px-4 text-sm">
                          Hủy
                        </button>
                      </Dialog.Close>
                      <button
                        type="submit"
                        disabled={busy || isConflictLocked || pendingIntent !== null}
                        className="min-h-11 whitespace-nowrap shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-50"
                      >
                        {busy ? "Đang lưu…" : dialog.active ? "Xác nhận kích hoạt" : "Xác nhận ngừng"}
                      </button>
                    </div>
                  </form>
                </div>
              ) : dialog?.kind === "link" ? (
                <div className="mt-5 space-y-4">
                  <div className="rounded-lg border border-border bg-surface-muted/50 p-3.5 text-sm space-y-1.5">
                    <p className="font-semibold text-foreground">Hồ sơ nhân sự được liên kết</p>
                    <p>
                      Họ và tên: <strong>{dialog.personnel.display_name}</strong>
                    </p>
                    <p>
                      Mã nhân sự: <span className="font-mono font-semibold">{dialog.personnel.personnel_code ?? "Chưa có mã nhân sự"}</span>
                    </p>
                    <p>
                      Vị trí: {positionLabel(dialog.personnel.personnel_position)} · Nhóm:{" "}
                      {dialog.personnel.team_names.join(", ") || "Chưa xếp nhóm"}
                    </p>
                  </div>

                  {linkCandidatesState === "loading" ? (
                    <p role="status" className="text-sm text-muted">
                      Đang kiểm tra tài khoản truy cập khớp mã nhân sự…
                    </p>
                  ) : null}
                  {linkCandidatesState === "already-linked" ? (
                    <Alert tone="warning" title="Hồ sơ nhân sự đã có tài khoản liên kết">
                      Hồ sơ này đã được liên kết với một tài khoản truy cập đang hiệu lực. Không thể tạo liên kết trùng.
                    </Alert>
                  ) : null}
                  {linkCandidatesState === "empty" ? (
                    <Alert tone="warning" title="Chưa có tài khoản khớp mã nhân sự">
                      Chưa có tài khoản truy cập đang hoạt động và chưa liên kết có mã đăng nhập khớp với mã nhân sự{" "}
                      <strong className="font-mono">{dialog.personnel.personnel_code ?? "—"}</strong>. Hãy tạo tài khoản trong mục{" "}
                      <strong>Tài khoản truy cập</strong> trước rồi quay lại thực hiện liên kết.
                    </Alert>
                  ) : null}
                  {linkCandidatesState === "error" ? (
                    <Alert tone="error" title="Không tải được tài khoản phù hợp">
                      Không thể kiểm tra danh sách tài khoản khớp mã nhân sự. Hãy thử lại.
                    </Alert>
                  ) : null}
                  {linkCandidatesState === "ready" && linkCandidateEnvelope ? (
                    <div className="space-y-3">
                      <label className="block text-sm font-medium text-foreground" htmlFor="personnel-link-account">
                        Tài khoản truy cập khớp mã nhân sự
                        <select
                          id="personnel-link-account"
                          value={selectedLinkCandidate?.app_user_id ?? ""}
                          required
                          onChange={(event) => {
                            const found = linkCandidateEnvelope.candidates.find(
                              (candidate) => candidate.app_user_id === event.currentTarget.value,
                            );
                            setSelectedLinkCandidate(found ?? null);
                          }}
                          className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                        >
                          {linkCandidateEnvelope.candidates.map((candidate) => (
                            <option key={candidate.app_user_id} value={candidate.app_user_id}>
                              {candidate.display_name} · {candidate.login_id}
                            </option>
                          ))}
                        </select>
                      </label>
                      {selectedLinkCandidate ? (
                        <div className="rounded-lg border border-border bg-surface p-3.5 text-xs text-muted space-y-1">
                          <p className="font-medium text-foreground">
                            Xác nhận liên kết 1-1: Tài khoản <span className="font-mono">{selectedLinkCandidate.login_id}</span> ({selectedLinkCandidate.display_name}) ↔ Hồ sơ nhân sự <span className="font-mono">{dialog.personnel.personnel_code}</span> ({dialog.personnel.display_name})
                          </p>
                          <p>
                            Thao tác này chỉ liên kết hai bản ghi hiện có, giữ nguyên mã nhân sự, tên hiển thị, vị trí, nhóm công tác và lịch sử hồ sơ. Tài khoản chỉ được cấp quyền nhập liệu HRP cơ bản của cá nhân (scope own), không tự động cấp quyền quản trị hoặc trưởng nhóm.
                          </p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  <form onSubmit={submitMutation} className="space-y-4">
                    <ReasonField value={form.reason} onChange={(value) => changeForm("reason", value)} />
                    {formError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{formError}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                      <Dialog.Close asChild>
                        <button type="button" disabled={busy} className="min-h-11 rounded-md border border-border px-4 text-sm">
                          Hủy
                        </button>
                      </Dialog.Close>
                      <button
                        type="submit"
                        disabled={
                          busy ||
                          isConflictLocked ||
                          pendingIntent !== null ||
                          linkCandidatesState !== "ready" ||
                          selectedLinkCandidate === null
                        }
                        className="min-h-11 whitespace-nowrap shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-50"
                      >
                        {busy ? "Đang lưu…" : "Xác nhận liên kết"}
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <form onSubmit={submitMutation} className="mt-5 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {dialog?.kind === "edit" ? (
                      <Field
                        id="personnel-code"
                        label="Mã nhân sự"
                        value={form.personnelCode}
                        maxLength={64}
                        required
                        onChange={(value) => changeForm("personnelCode", value)}
                      />
                    ) : null}
                    {dialog?.kind === "create" ? (
                      <label className="block text-sm font-medium text-foreground" htmlFor="personnel-account">
                        Tài khoản
                        <select
                          id="personnel-account"
                          value={selectedAccount?.app_user_id ?? ""}
                          required
                          disabled={eligibleState !== "ready"}
                          onChange={(event) => {
                            const found = eligibleAccounts.find((account) =>
                              account.app_user_id === event.currentTarget.value);
                            if (found) void selectEligibleAccount(found);
                          }}
                          className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                        >
                          <option value="">Chọn tài khoản</option>
                          {eligibleAccounts.map((account) => (
                            <option key={account.app_user_id} value={account.app_user_id}>
                              {account.display_name.trim().toLowerCase() === account.login_id.toLowerCase()
                                ? `Chưa cập nhật tên thật · ${account.login_id}`
                                : `${account.display_name} · ${account.login_id}`}
                            </option>
                          ))}
                        </select>
                        {eligibleState === "loading" ? (
                          <span className="mt-1 block text-xs text-muted">Đang tải tài khoản đủ điều kiện…</span>
                        ) : null}
                        {eligibleState === "empty" ? (
                          <span className="mt-1 block text-xs text-muted">
                            Không có tài khoản đang hoạt động và chưa liên kết nhân sự.
                          </span>
                        ) : null}
                        {eligibleState === "error" ? (
                          <span role="alert" className="mt-1 block text-xs text-red-700">
                            Không tải được danh sách tài khoản. Hãy thử lại.
                          </span>
                        ) : null}
                        {eligibleState === "ready" && (eligiblePage > 1 || eligibleHasMore) ? (
                          <span className="mt-2 flex items-center gap-2 text-xs font-normal text-muted">
                            <button type="button" disabled={eligiblePage <= 1 || eligibleState !== "ready"}
                              onClick={() => changeEligiblePage(eligiblePage - 1)}
                              className="rounded-md border border-border px-2 py-1 disabled:opacity-50">
                              Trang trước
                            </button>
                            <span aria-live="polite">Trang {eligiblePage}</span>
                            <button type="button" disabled={!eligibleHasMore || eligibleState !== "ready"}
                              onClick={() => changeEligiblePage(eligiblePage + 1)}
                              className="rounded-md border border-border px-2 py-1 disabled:opacity-50">
                              Trang sau
                            </button>
                          </span>
                        ) : null}
                      </label>
                    ) : (
                      <Field
                        id="personnel-name"
                        label="Họ và tên"
                        value={form.displayName}
                        maxLength={256}
                        required
                        onChange={(value) => changeForm("displayName", value)}
                      />
                    )}
                    <label className="block text-sm font-medium text-foreground" htmlFor="personnel-position">
                      Vị trí
                      <select
                        id="personnel-position"
                        value={form.personnelPosition}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          changeForm("personnelPosition", value === "STAFF" || value === "TEAM_LEADER" ? value : "");
                        }}
                        required
                        className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                      >
                        <option value="">Chọn vị trí</option>
                        <option value="STAFF">Nhân viên</option>
                        <option value="TEAM_LEADER">Trưởng nhóm</option>
                      </select>
                      <span className="mt-1 block text-xs font-normal text-muted">
                        Vị trí không tự cấp quyền trong hệ thống.
                      </span>
                    </label>
                    {dialog?.kind === "create" ? (
                      <div className="rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs text-muted sm:col-span-2">
                        Ngày hiệu lực HRP được hệ thống áp dụng ngay theo ngày nghiệp vụ hiện tại (giờ Việt Nam).
                      </div>
                    ) : null}
                  </div>
                  <ReasonField value={form.reason} onChange={(value) => changeForm("reason", value)} />
                  {formError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{formError}</p> : null}
                  <div className="flex flex-wrap justify-end gap-2">
                    <Dialog.Close asChild>
                      <button type="button" disabled={busy} className="min-h-11 rounded-md border border-border px-4 text-sm">
                        Hủy
                      </button>
                    </Dialog.Close>
                    <button
                      type="submit"
                      disabled={busy || isConflictLocked || pendingIntent !== null}
                      className="min-h-11 whitespace-nowrap shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-50"
                    >
                      {busy ? "Đang lưu…" : dialog?.kind === "create" ? "Tạo nhân sự" : "Lưu thay đổi"}
                    </button>
                  </div>
                </form>
              )}
            </Dialog.Content>
          </Dialog.Portal>

      </header>

      {pendingIntent?.retryState === "retry" ? (
        <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
          <p>Thử lại cùng khóa thao tác để tránh tạo thay đổi trùng lặp.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void sendIntent(pendingIntent)}
            className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50"
          >
            Thử lại thao tác
          </button>
        </Alert>
      ) : null}

      {dialog === null ? (
        Array.from(conflictIntents.values(), ({ intent, error }) => (
          <ConflictReload
            key={intent.lockId}
            message={error}
            busy={busy}
            onReload={() => void reloadConflictedEntity(intent)}
          />
        ))
      ) : null}

      <Card>
        <CardHeader
          title="Danh sách nhân sự"
          description={list ? `${list.total} hồ sơ phù hợp` : "Tìm kiếm và lọc hồ sơ nhân sự."}
        />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const query = buildPersonnelListQuery({ search: searchInput, includeInactive, page: 1 });
            if (!query) {
              setListState({ kind: "error" });
              return;
            }
            setListState({ kind: "loading" });
            setPage(1);
            setSearch(searchInput.trim());
            setReloadToken((value) => value + 1);
          }}
          className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <label htmlFor="personnel-search" className="min-w-0 flex-1 text-sm font-medium">
            Tìm theo tên hoặc mã nhân sự
            <input
              id="personnel-search"
              value={searchInput}
              maxLength={256}
              onChange={(event) => setSearchInput(event.currentTarget.value)}
              className="mt-1 block min-h-11 sm:min-h-10 w-full rounded-md border border-border bg-background px-3 text-base sm:text-sm"
            />
          </label>
          <label className="flex min-h-11 sm:min-h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => {
                setIncludeInactive(event.currentTarget.checked);
                setListState({ kind: "loading" });
                setPage(1);
              }}
              className="size-4 accent-primary"
            />
            Hiển thị hồ sơ ngừng hoạt động
          </label>
          <button type="submit" className="min-h-11 sm:min-h-10 whitespace-nowrap shrink-0 rounded-md border border-border px-4 text-sm font-medium">
            Tìm kiếm
          </button>
        </form>

        {listState.kind === "loading" ? (
          <p role="status" className="py-8 text-center text-sm text-muted">Đang tải danh sách nhân sự…</p>
        ) : null}
        {listState.kind === "denied" ? (
          <Alert tone="error" title="Không có quyền xem danh sách">
            Tài khoản hiện tại không được phép xem danh mục nhân sự.
          </Alert>
        ) : null}
        {listState.kind === "unavailable" ? (
          <div className="space-y-3">
            <Alert tone="warning" title="Danh sách hiện chưa khả dụng">
              Không thể kết nối hoặc dịch vụ chưa sẵn sàng. Dữ liệu không được thay bằng danh sách rỗng.
            </Alert>
            <button type="button" onClick={reloadList} className="min-h-11 rounded-md border border-border px-4 text-sm">
              Thử tải lại
            </button>
          </div>
        ) : null}
        {listState.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState title="Không thể đọc dữ liệu nhân sự" detail="Phản hồi không đúng hợp đồng API hoặc bộ lọc không hợp lệ." />
            <button type="button" onClick={reloadList} className="min-h-11 rounded-md border border-border px-4 text-sm">
              Thử tải lại
            </button>
          </div>
        ) : null}
        {list ? (
          list.personnel.length === 0 ? (
            <EmptyState
              title="Không có hồ sơ phù hợp"
              description="Thử đổi từ khóa hoặc bật hiển thị hồ sơ ngừng hoạt động."
            />
          ) : (
            <>
              <div role="region" aria-label="Bảng danh sách nhân sự" tabIndex={0} className="overflow-x-auto rounded-xl border border-border bg-surface shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                <table className="r22-card-table w-full min-w-[860px] border-collapse text-left text-sm">
                  <caption className="sr-only">Danh sách hồ sơ nhân sự</caption>
                  <thead className="border-b border-border bg-surface-muted text-xs font-semibold uppercase tracking-wider text-muted">
                    <tr>
                      <th scope="col" className="px-3.5 py-3 font-semibold">Nhân sự</th>
                      <th scope="col" className="px-3.5 py-3 font-semibold">Nhóm</th>
                      <th scope="col" className="px-3.5 py-3 font-semibold">Vị trí</th>
                      <th scope="col" className="px-3.5 py-3 font-semibold">Trạng thái</th>
                      <th scope="col" className="px-3.5 py-3 font-semibold">Hiệu lực HRP</th>
                      <th scope="col" className="px-3.5 py-3 font-semibold text-right">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {list.personnel.map((personnel) => (
                      <tr key={personnel.recruiter_id} className="align-middle transition-colors hover:bg-surface-hover">
                        <td data-card-header="true" className="px-3.5 py-2.5 font-medium">
                          <span className="block">{personnel.display_name}</span>
                          <span className="mt-1 block text-xs text-muted font-mono">
                            {personnel.personnel_code ?? "Chưa có mã nhân sự"}
                          </span>
                        </td>
                        <td data-label="Nhóm công tác" className="px-3.5 py-2.5">{personnel.team_names.join(", ") || "Chưa xếp nhóm"}</td>
                        <td data-label="Vị trí" className="px-3.5 py-2.5">{positionLabel(personnel.personnel_position)}</td>
                        <td data-label="Trạng thái" className="px-3.5 py-2.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <ActiveBadge active={personnel.active} />
                            {linkedRecruiterIds.has(personnel.recruiter_id) ? (
                              <StatusBadge tone="info">Đã liên kết TK</StatusBadge>
                            ) : null}
                          </div>
                        </td>
                        <td data-label="Hiệu lực HRP" className="px-3.5 py-2.5 font-mono tabular-nums whitespace-nowrap">{formatHrpDate(personnel.hrp_valid_from)}</td>
                        <td data-card-actions="true" className="px-3.5 py-2.5 text-right">
                          <div className="inline-flex flex-wrap md:flex-nowrap items-center justify-end gap-1.5 whitespace-nowrap">
                            {canLinkAccounts &&
                            personnel.active &&
                            Boolean(personnel.personnel_code) &&
                            !linkedRecruiterIds.has(personnel.recruiter_id) ? (
                              <Dialog.Trigger asChild>
                                <button
                                  type="button"
                                  onClick={() => startLinkAccount(personnel)}
                                  disabled={conflictLocks.has(personnel.recruiter_id)}
                                  className="min-h-11 md:min-h-8 whitespace-nowrap shrink-0 rounded-md border border-primary/40 bg-primary/10 px-3 text-xs font-medium text-primary disabled:opacity-50"
                                >
                                  Liên kết tài khoản
                                </button>
                              </Dialog.Trigger>
                            ) : null}
                            <Dialog.Trigger asChild>
                              <button
                                type="button"
                                onClick={() => startEdit(personnel)}
                                disabled={conflictLocks.has(personnel.recruiter_id)}
                                className="min-h-11 md:min-h-8 whitespace-nowrap shrink-0 rounded-md border border-border px-3 text-xs font-medium disabled:opacity-50"
                              >
                                Chỉnh sửa
                              </button>
                            </Dialog.Trigger>
                            <Dialog.Trigger asChild>
                              <button
                                type="button"
                                onClick={() => startActiveChange(personnel, !personnel.active)}
                                disabled={conflictLocks.has(personnel.recruiter_id)}
                                className="min-h-11 md:min-h-8 whitespace-nowrap shrink-0 rounded-md border border-border px-3 text-xs font-medium disabled:opacity-50"
                              >
                                {personnel.active ? "Ngừng hoạt động" : "Kích hoạt"}
                              </button>
                            </Dialog.Trigger>
                            <button
                              type="button"
                              onClick={(event) => {
                                membershipTrigger.current = event.currentTarget;
                                setMembershipPersonnel(personnel);
                              }}
                              className="min-h-11 md:min-h-8 whitespace-nowrap shrink-0 rounded-md border border-border px-3 text-xs font-medium"
                            >
                              Quản lý nhóm
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted">Trang {page} / {pageCount}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => {
                      setListState({ kind: "loading" });
                      setPage((value) => Math.max(1, value - 1));
                    }}
                    className="min-h-11 rounded-md border border-border px-4 text-sm disabled:opacity-50"
                  >
                    Trang trước
                  </button>
                  <button
                    type="button"
                    disabled={page >= pageCount}
                    onClick={() => {
                      setListState({ kind: "loading" });
                      setPage((value) => Math.min(1000, value + 1));
                    }}
                    className="min-h-11 rounded-md border border-border px-4 text-sm disabled:opacity-50"
                  >
                    Trang sau
                  </button>
                </div>
              </div>
            </>
          )
        ) : null}
      </Card>
      <PersonnelTeamMembershipManager
        personnel={membershipPersonnel}
        onClose={() => {
          setMembershipPersonnel(null);
          window.requestAnimationFrame(() => membershipTrigger.current?.focus());
        }}
        onOpen={(selectedPersonnel, trigger) => {
          membershipTrigger.current = trigger;
          setMembershipPersonnel(selectedPersonnel);
        }}
        onConflictLock={updateMembershipConflictLock}
        onPersonnelReloaded={updateReloadedPersonnel}
        onPersonnelUnavailable={(recruiterId) => {
          setMembershipPersonnel((current) => current?.recruiter_id === recruiterId ? null : current);
          reloadList();
        }}
      />
    </div>
    </Dialog.Root>
  );

}

function Field({
  id,
  label,
  value,
  type = "text",
  maxLength,
  required = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  type?: string;
  maxLength?: number;
  required?: boolean;
  onChange(value: string): void;
}) {
  return (
    <label htmlFor={id} className="block text-sm font-medium text-foreground">
      {label}
      <input
        id={id}
        type={type}
        value={value}
        maxLength={maxLength}
        required={required}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
      />
    </label>
  );
}

function ReasonField({ value, onChange }: { value: string; onChange(value: string): void }) {
  return (
    <label htmlFor="personnel-reason" className="block text-sm font-medium text-foreground">
      Lý do thay đổi (không bắt buộc)
      <textarea
        id="personnel-reason"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        maxLength={4000}
        rows={3}
        className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      />
    </label>
  );
}

function ConflictReload({ message, busy, onReload }: {
  message: string | null;
  busy: boolean;
  onReload(): void;
}) {
  return (
    <Alert tone="warning" title="Dữ liệu đã thay đổi. Cần tải lại trước khi tiếp tục.">
      <p>{message ?? "Tải lại hồ sơ có thẩm quyền trước khi bắt đầu thao tác mới."}</p>
      <button type="button" onClick={onReload} disabled={busy} className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50">
        {busy ? "Đang tải…" : "Tải lại hồ sơ"}
      </button>
    </Alert>
  );
}
