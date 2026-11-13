"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "radix-ui/dialog";

import {
  PersonSearchPicker,
  RecruiterConfirmPicker,
} from "@/components/admin/org-entity-picker";
import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import type {
  ExistingAccount,
  ExistingAccountList,
} from "@/lib/direct-entry/app-user-access-contract";
import type { AdminPersonnel } from "@/lib/direct-entry/personnel-catalog-contract";
import {
  ACCOUNT_ORG_MAX_REASON_LENGTH,
  ACCOUNT_TYPES,
  accountTypeBadgeMeta,
  buildAccountListQuery,
  buildAccountStateRequest,
  buildLinkAccountPersonRequest,
  buildSetAccountClassificationRequest,
  buildUnlinkAccountPersonRequest,
  canLinkPersonToAccount,
  classifyAccountMutation,
  classifyAccountOrgMutation,
  newAccountIntentKey,
  projectAccountItem,
  projectAccountListForQuery,
  type AccountEnabledFilter,
  type AccountType,
} from "@/lib/admin/account-access-model";
import {
  buildCreateAccountRequest,
  buildEditDisplayNameRequest,
  buildReconcileRequest,
  buildResetPasswordRequest,
  classifyAccountOperationResponse,
  newAccountOperationKey,
} from "@/lib/admin/account-operation-ui-model";
import type { PersonSummaryProjection } from "@/lib/admin/person-org-ui-model";

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; list: ExistingAccountList }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

type DialogState = { account: ExistingAccount; nextEnabled: boolean };

type MutationIntent = {
  url: string;
  method: "POST";
  operation: "enable" | "disable";
  accountRef: string;
  lockId: string;
  body: Record<string, unknown>;
  retry: boolean;
};

const button = "inline-flex min-h-10 items-center justify-center rounded-md border border-border " +
  "bg-surface px-3 text-sm font-medium text-foreground focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = "inline-flex min-h-10 items-center justify-center rounded-md bg-primary " +
  "px-4 text-sm font-medium text-on-primary focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";

type AccountTrackedRequest = {
  readonly epoch: number;
  readonly controller: AbortController;
  readonly release: () => void;
};

function invalidateAccountWorkspaceRefs(
  epochRef: { current: number },
  controllersRef: { current: Set<AbortController> },
  listSeqRef: { current: number },
): void {
  epochRef.current += 1;
  listSeqRef.current += 1;
  for (const ctrl of controllersRef.current) {
    ctrl.abort();
  }
  controllersRef.current.clear();
}

function EnabledBadge({ enabled }: { enabled: boolean }) {
  return (
    <StatusBadge tone={enabled ? "success" : "neutral"} dot>
      {enabled ? "Đang hoạt động" : "Ngừng hoạt động"}
    </StatusBadge>
  );
}

export function AccountManager() {
  const notify = useNotify();
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [enabledFilter, setEnabledFilter] = useState<AccountEnabledFilter>("all");
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingIntent, setPendingIntent] = useState<MutationIntent | null>(null);
  const [conflictIntent, setConflictIntent] = useState<MutationIntent | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<
    | "create"
    | { kind: "edit"; account: ExistingAccount }
    | { kind: "reset"; account: ExistingAccount }
    | null
  >(null);
  const [orgOperation, setOrgOperation] = useState<
    | { kind: "classification"; account: ExistingAccount }
    | { kind: "link"; account: ExistingAccount }
    | { kind: "unlink"; account: ExistingAccount }
    | null
  >(null);
  const [orgDialogLocked, setOrgDialogLocked] = useState(false);
  const [reconcileIntent, setReconcileIntent] = useState<{ intentId: string; state: string } | null>(null);
  const [opBusy, setOpBusy] = useState(false);

  const workspaceEpochRef = useRef(0);
  const workspaceControllersRef = useRef<Set<AbortController>>(new Set());
  const listReqSeqRef = useRef(0);

  useEffect(() => {
    const epochRef = workspaceEpochRef;
    const controllersRef = workspaceControllersRef;
    const listSeqRef = listReqSeqRef;
    return () => {
      invalidateAccountWorkspaceRefs(epochRef, controllersRef, listSeqRef);
    };
  }, []);

  const trackWorkspaceRequest = useCallback((): AccountTrackedRequest => {
    const epoch = workspaceEpochRef.current;
    const controller = new AbortController();
    workspaceControllersRef.current.add(controller);
    const release = () => {
      workspaceControllersRef.current.delete(controller);
    };
    return { epoch, controller, release };
  }, []);

  const isWorkspaceRequestActive = useCallback(
    (epoch: number, controller?: AbortController): boolean =>
      workspaceEpochRef.current === epoch && !(controller?.signal.aborted ?? false),
    [],
  );

  const handleOrgSessionLost = useCallback(() => {
    invalidateAccountWorkspaceRefs(workspaceEpochRef, workspaceControllersRef, listReqSeqRef);
    setOrgOperation(null);
    setOrgDialogLocked(false);
    setOperation(null);
    setDialog(null);
    setPendingIntent(null);
    setConflictIntent(null);
    setConflictError(null);
    setReconcileIntent(null);
    setBusy(false);
    setOpBusy(false);
    setListState({ kind: "denied" });
  }, []);

  // PRE-W2-HF-D3-B: Full Admin mở danh sách tài khoản thì chạy RPC reclassify một lần
  // (qua route có session + CSRF) để xử lý intent tồn đọng kể cả sau process crash. Không
  // chạy lại khi đổi search/page/filter; ref guard tránh vòng lặp/StrictMode double-fire.
  const reclassifyFiredRef = useRef(false);
  useEffect(() => {
    if (reclassifyFiredRef.current) return;
    reclassifyFiredRef.current = true;
    const epoch = workspaceEpochRef.current;
    const controller = new AbortController();
    workspaceControllersRef.current.add(controller);
    void (async () => {
      try {
        const response = await fetch("/api/admin/access/accounts/reclassify", {
          method: "POST",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: "{}",
        });
        if (controller.signal.aborted || workspaceEpochRef.current !== epoch) return;
        if (response.status === 401 || response.status === 403) {
          invalidateAccountWorkspaceRefs(workspaceEpochRef, workspaceControllersRef, listReqSeqRef);
          setOrgOperation(null);
          setOrgDialogLocked(false);
          setOperation(null);
          setDialog(null);
          setPendingIntent(null);
          setConflictIntent(null);
          setConflictError(null);
          setReconcileIntent(null);
          setBusy(false);
          setOpBusy(false);
          setListState({ kind: "denied" });
          return;
        }
        if (!response.ok) notify.warning({ title: "Không phân loại lại được intent tồn đọng. Hãy thử lại sau." });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (controller.signal.aborted || workspaceEpochRef.current !== epoch) return;
        notify.warning({ title: "Không phân loại lại được intent tồn đọng. Hãy thử lại sau." });
      } finally {
        workspaceControllersRef.current.delete(controller);
      }
    })();
  }, [notify]);

  useEffect(() => {
    const controllers = workspaceControllersRef.current;
    const epoch = workspaceEpochRef.current;
    const reqSeq = ++listReqSeqRef.current;
    const controller = new AbortController();
    controllers.add(controller);
    const isStale = () =>
      controller.signal.aborted ||
      workspaceEpochRef.current !== epoch ||
      listReqSeqRef.current !== reqSeq;

    void (async () => {
      const query = buildAccountListQuery({ search, enabled: enabledFilter, page });
      if (!query) {
        controllers.delete(controller);
        if (!isStale()) setListState({ kind: "error" });
        return;
      }
      let response: Response;
      try {
        response = await fetch(`/api/admin/access/accounts?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        controllers.delete(controller);
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (isStale()) return;
        setListState({ kind: "unavailable" });
        return;
      }
      if (isStale()) {
        controllers.delete(controller);
        return;
      }
      if (response.status === 401 || response.status === 403) {
        controllers.delete(controller);
        invalidateAccountWorkspaceRefs(workspaceEpochRef, workspaceControllersRef, listReqSeqRef);
        setOrgOperation(null);
        setOrgDialogLocked(false);
        setOperation(null);
        setDialog(null);
        setPendingIntent(null);
        setConflictIntent(null);
        setConflictError(null);
        setReconcileIntent(null);
        setBusy(false);
        setOpBusy(false);
        setListState({ kind: "denied" });
        return;
      }
      if (response.status !== 200) {
        controllers.delete(controller);
        setListState(response.status === 404 || response.status >= 500
          ? { kind: "unavailable" }
          : { kind: "error" });
        return;
      }
      try {
        const list = projectAccountListForQuery(await response.json(), {
          search, enabled: enabledFilter, page,
        });
        if (isStale()) return;
        if (!list) {
          setListState({ kind: "error" });
          return;
        }
        const pageCount = Math.min(1000, Math.max(1,
          Math.ceil(list.total / Math.max(1, list.page_size))));
        if (page > pageCount) {
          setPage(pageCount);
          return;
        }
        setListState({ kind: "loaded", list });
      } catch {
        if (isStale()) return;
        setListState({ kind: "error" });
      } finally {
        controllers.delete(controller);
      }
    })();
    return () => {
      controller.abort();
      controllers.delete(controller);
    };
  }, [enabledFilter, page, reloadToken, search]);

  const reloadList = useCallback(() => {
    setListState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  }, []);

  const reloadAccountsAuthoritative = useCallback(async (): Promise<boolean> => {
    const query = buildAccountListQuery({ search, enabled: enabledFilter, page });
    if (!query) return false;
    const reqSeq = ++listReqSeqRef.current;
    const tracked = trackWorkspaceRequest();
    try {
      const response = await fetch(`/api/admin/access/accounts?${query.toString()}`, {
        method: "GET",
        cache: "no-store",
        signal: tracked.controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!isWorkspaceRequestActive(tracked.epoch, tracked.controller) || reqSeq !== listReqSeqRef.current) {
        return false;
      }
      if (response.status === 401 || response.status === 403) {
        handleOrgSessionLost();
        return false;
      }
      if (response.status !== 200) return false;
      const list = projectAccountListForQuery(await response.json().catch(() => null), {
        search,
        enabled: enabledFilter,
        page,
      });
      if (!isWorkspaceRequestActive(tracked.epoch, tracked.controller) || reqSeq !== listReqSeqRef.current) {
        return false;
      }
      if (!list) return false;
      const pageCount = Math.min(
        1000,
        Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))),
      );
      if (page > pageCount) {
        setPage(pageCount);
        setListState({ kind: "loading" });
        setReloadToken((value) => value + 1);
        return true;
      }
      setListState({ kind: "loaded", list });
      return true;
    } catch {
      return false;
    } finally {
      tracked.release();
    }
  }, [enabledFilter, handleOrgSessionLost, isWorkspaceRequestActive, page, search, trackWorkspaceRequest]);

  const startStateChange = (account: ExistingAccount, nextEnabled: boolean) => {
    setReason("");
    setFormError(null);
    setDialog({ account, nextEnabled });
  };

  const reloadAuthoritative = async (intent: MutationIntent): Promise<boolean> => {
    setConflictError(null);
    setBusy(true);
    const tracked = trackWorkspaceRequest();
    try {
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(intent.accountRef)}`,
        {
          method: "GET",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: { Accept: "application/json" },
        },
      );
      if (!isWorkspaceRequestActive(tracked.epoch, tracked.controller)) return false;
      if (response.status === 401 || response.status === 403) {
        handleOrgSessionLost();
        return false;
      }
      if (response.status === 404) {
        setConflictIntent(null);
        setPendingIntent(null);
        setDialog(null);
        notify.warning({ title: "Tài khoản không còn khả dụng. Danh sách đang được cập nhật." });
        reloadList();
        return false;
      }
      const account = response.status === 200 ? projectAccountItem(await response.json()) : null;
      if (!isWorkspaceRequestActive(tracked.epoch, tracked.controller)) return false;
      if (!account || account.account_ref !== intent.accountRef) {
        throw new Error("authoritative reload failed");
      }
      setConflictIntent(null);
      setConflictError(null);
      setPendingIntent(null);
      setDialog(null);
      reloadList();
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return false;
      if (!isWorkspaceRequestActive(tracked.epoch, tracked.controller)) return false;
      const errMsg = "Không tải được dữ liệu có thẩm quyền. Thao tác vẫn đang bị khóa; hãy thử tải lại.";
      setConflictError(errMsg);
      notify.error({ title: errMsg });
      return false;
    } finally {
      tracked.release();
      if (isWorkspaceRequestActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  const sendIntent = async (intent: MutationIntent) => {
    setBusy(true);
    const tracked = trackWorkspaceRequest();
    try {
      let response: Response;
      try {
        response = await fetch(intent.url, {
          method: intent.method,
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": String(intent.body.idempotency_key),
          },
          body: JSON.stringify(intent.body),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!isWorkspaceRequestActive(tracked.epoch, tracked.controller)) return;
        setPendingIntent({ ...intent, retry: true });
        notify.error({ title: "Không nhận được phản hồi. Có thể thử lại đúng thao tác với cùng khóa idempotency." });
        return;
      }
      if (!isWorkspaceRequestActive(tracked.epoch, tracked.controller)) return;
      let rawJson: unknown = null;
      try {
        rawJson = await response.json();
      } catch {
        rawJson = null;
      }
      if (!isWorkspaceRequestActive(tracked.epoch, tracked.controller)) return;
      const outcome = classifyAccountMutation(response.status, rawJson);
      if (
        outcome.kind === "unauthenticated" ||
        outcome.kind === "denied" ||
        outcome.kind === "actor-not-available"
      ) {
        handleOrgSessionLost();
        return;
      }
      if (outcome.kind === "applied" || outcome.kind === "conflict") {
        setPendingIntent(null);
        setConflictIntent(intent);
        setConflictError(null);
        if (outcome.kind === "conflict") {
          notify.warning({ title: outcome.message });
        }
        const reloaded = await reloadAuthoritative(intent);
        if (!isWorkspaceRequestActive(tracked.epoch, tracked.controller)) return;
        if (outcome.kind === "applied" && reloaded) {
          notify.success({ title: "Đã lưu thay đổi. Đã tải dữ liệu mới nhất từ máy chủ." });
        }
        return;
      }
      if (outcome.kind === "unavailable") {
        setPendingIntent({ ...intent, retry: true });
        notify.error({ title: outcome.message });
        return;
      }
      setPendingIntent(null);
      if (outcome.kind === "not-found") {
        notify.warning({ title: outcome.message });
        setDialog(null);
        reloadList();
        return;
      }
      notify.error({ title: outcome.message });
      setFormError(outcome.message);
    } finally {
      tracked.release();
      if (isWorkspaceRequestActive(tracked.epoch)) {
        setBusy(false);
      }
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!dialog) return;
    if (pendingIntent || conflictIntent) {
      setFormError("Thao tác trước vẫn cần được xác nhận hoặc tải lại dữ liệu.");
      return;
    }
    const request = buildAccountStateRequest({
      expectedVersion: dialog.account.version,
      reason,
      idempotencyKey: newAccountIntentKey(),
    });
    if (!request.ok) {
      setFormError(request.message);
      return;
    }
    const intent: MutationIntent = {
      url: `/api/admin/access/accounts/${encodeURIComponent(dialog.account.account_ref)}/${dialog.nextEnabled ? "enable" : "disable"}`,
      method: "POST",
      operation: dialog.nextEnabled ? "enable" : "disable",
      accountRef: dialog.account.account_ref,
      lockId: dialog.account.account_ref,
      body: request.body,
      retry: false,
    };
    setPendingIntent(intent);
    void sendIntent(intent);
  };

  const list = listState.kind === "loaded" ? listState.list : null;
  const pageCount = list
    ? Math.min(1000, Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))))
    : 1;
  const locked = busy || pendingIntent !== null || conflictIntent !== null;
  const rowActionsDisabled = locked || orgDialogLocked || opBusy || listState.kind === "denied";

  return (
    <>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Tài khoản</h1>
          <p className="mt-1 text-sm text-muted">Quản lý trạng thái hoạt động của tài khoản hiện có. Lý do thao tác không bắt buộc.</p>
        </div>
        <div className="flex gap-2">
          {listState.kind !== "denied" ? (
            <button type="button" className={primaryButton} disabled={rowActionsDisabled}
              onClick={() => { setOperation("create"); }}>
              Tạo tài khoản
            </button>
          ) : null}
        </div>
      </header>

      <Dialog.Root open={dialog !== null}
        onOpenChange={(open) => { if (!open && !locked) setDialog(null); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content
            onEscapeKeyDown={(event) => { if (locked) event.preventDefault(); }}
            onPointerDownOutside={(event) => { if (locked) event.preventDefault(); }}
            onCloseAutoFocus={(event) => { if (locked) event.preventDefault(); }}
            className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-xl focus:outline-none sm:p-6"
            aria-describedby="account-dialog-description"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <Dialog.Title className="text-xl font-semibold text-foreground">
                  {dialog?.nextEnabled ? "Kích hoạt tài khoản" : "Ngừng hoạt động tài khoản"}
                </Dialog.Title>
                <Dialog.Description id="account-dialog-description" className="mt-1 text-sm text-muted">
                  Lý do thao tác không bắt buộc; thao tác không xóa dữ liệu hay lịch sử.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button type="button" aria-label="Đóng hộp thoại" disabled={locked}
                  className={button}>×</button>
              </Dialog.Close>
            </div>
            {pendingIntent?.retry && dialog && pendingIntent.lockId === dialog.account.account_ref ? (
              <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
                <p>Thử lại đúng thao tác với cùng khóa idempotency.</p>
                <button type="button" disabled={busy} className={`${button} mt-2`}
                  onClick={() => void sendIntent(pendingIntent)}>Thử lại thao tác</button>
              </Alert>
            ) : null}
            {conflictIntent && dialog && conflictIntent.lockId === dialog.account.account_ref ? (
              <ConflictReload
                message={conflictError}
                busy={busy}
                onReload={() => void reloadAuthoritative(conflictIntent).then((ok) => {
                  if (ok) notify.success({ title: "Đã tải dữ liệu mới nhất từ máy chủ." });
                })}
              />
            ) : null}
            {dialog ? (
              <div className="mt-5 space-y-4">
                <p>
                  Bạn sắp {dialog.nextEnabled ? "kích hoạt" : "ngừng hoạt động"} tài khoản{" "}
                  <strong>{dialog.account.display_name ?? "Chưa cập nhật tên thật"}</strong>.
                </p>
                <form onSubmit={submit} className="space-y-4">
                  <ReasonField value={reason} disabled={locked} onChange={(value) => { setReason(value); setFormError(null); }} />
                  {formError ? <p role="alert" className="text-sm text-red-700">{formError}</p> : null}
                  <button type="submit" disabled={locked} className={primaryButton}>
                    {busy ? "Đang lưu…" : dialog.nextEnabled ? "Xác nhận kích hoạt" : "Xác nhận ngừng"}
                  </button>
                </form>
              </div>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {pendingIntent?.retry && dialog === null ? (
        <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
          <p>Thử lại cùng thao tác với cùng khóa idempotency.</p>
          <button type="button" disabled={busy} className={`${button} mt-2`}
            onClick={() => void sendIntent(pendingIntent)}>Thử lại thao tác</button>
        </Alert>
      ) : null}
      {conflictIntent && dialog === null ? (
        <ConflictReload message={conflictError} busy={busy}
          onReload={() => void reloadAuthoritative(conflictIntent).then((ok) => {
            if (ok) notify.success({ title: "Đã tải dữ liệu mới nhất từ máy chủ." });
          })} />
      ) : null}

      <Card>
        <CardHeader title="Danh sách tài khoản"
          description={list ? `${list.total} tài khoản phù hợp` : "Tìm kiếm theo tên hiển thị và lọc theo trạng thái."} />
        {listState.kind !== "denied" ? (
          <form className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]" onSubmit={(event) => {
            event.preventDefault();
            const query = buildAccountListQuery({ search: searchInput, enabled: enabledFilter, page: 1 });
            if (!query) {
              setListState({ kind: "error" });
              return;
            }
            setPage(1);
            setSearch(searchInput.trim());
            setListState({ kind: "loading" });
          }}>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Tìm kiếm theo tên hiển thị
              <input value={searchInput} maxLength={256} onChange={(event) => setSearchInput(event.target.value)}
                className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium">
              Trạng thái
              <select value={enabledFilter} onChange={(event) => {
                setEnabledFilter(event.target.value as AccountEnabledFilter);
                setPage(1);
                setListState({ kind: "loading" });
              }}
                className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                <option value="all">Tất cả</option>
                <option value="true">Đang hoạt động</option>
                <option value="false">Ngừng hoạt động</option>
              </select>
            </label>
            <button type="submit" className={`${button} min-h-11 sm:min-h-10 self-end`}>Tìm kiếm</button>
          </form>
        ) : null}

        {listState.kind === "loading" ? <p role="status" className="py-8 text-center text-sm text-muted">Đang tải danh sách tài khoản…</p> : null}
        {listState.kind === "denied" ? <ErrorState title="Không có quyền xem danh sách tài khoản" /> : null}
        {listState.kind === "unavailable" ? (
          <div className="space-y-3">
            <ErrorState title="Dịch vụ tài khoản hiện không khả dụng" />
            <button type="button" className={button} onClick={reloadList}>Thử tải lại</button>
          </div>
        ) : null}
        {listState.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState title="Không tải được danh sách tài khoản" detail="Phản hồi không hợp lệ. Hãy thử tải lại." />
            <button type="button" className={button} onClick={reloadList}>Thử tải lại</button>
          </div>
        ) : null}
        {list ? list.accounts.length === 0 ? (
          <EmptyState title="Chưa có tài khoản phù hợp" description="Thay đổi từ khóa tìm kiếm hoặc bộ lọc trạng thái." />
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-2xs">
              <table className="r22-card-table w-full min-w-[780px] border-collapse text-left text-sm">
                <caption className="sr-only">Danh sách tài khoản và trạng thái hoạt động</caption>
                <thead className="border-b border-border bg-surface-muted text-xs uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-3">Tên hiển thị</th>
                    <th scope="col" className="px-3 py-3">Phân loại</th>
                    <th scope="col" className="px-3 py-3">Hồ sơ người liên kết</th>
                    <th scope="col" className="px-3 py-3">Trạng thái</th>
                    <th scope="col" className="px-3 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {list.accounts.map((account) => {
                    const typeMeta = accountTypeBadgeMeta(account.account_type);
                    const canLink = canLinkPersonToAccount(account);
                    return (
                      <tr key={account.account_ref} className="border-b border-border/70 last:border-0 hover:bg-surface-hover">
                        <td data-card-header="true" className="px-3 py-3">
                          <span className="block font-medium">{account.display_name ?? "Chưa cập nhật tên thật"}</span>
                          {account.login_id ? <span className="block text-xs text-muted">{account.login_id}</span> : null}
                        </td>
                        <td data-label="Phân loại" className="px-3 py-3">
                          <StatusBadge tone={typeMeta.tone}>{typeMeta.label}</StatusBadge>
                        </td>
                        <td data-label="Hồ sơ người liên kết" className="px-3 py-3">
                          {account.active_person_link ? (
                            <div>
                              <Link
                                href={`/admin/organization/persons/${encodeURIComponent(account.active_person_link.person_id)}`}
                                className="font-medium text-primary hover:underline"
                              >
                                {account.active_person_link.full_name}
                              </Link>
                              <div className="font-mono text-xs text-muted">
                                {account.active_person_link.employee_code}
                              </div>
                            </div>
                          ) : account.account_type !== "NORMAL" ? (
                            <span className="text-xs text-muted">Không áp dụng ({account.account_type})</span>
                          ) : (
                            <span className="text-xs text-muted">Chưa liên kết</span>
                          )}
                        </td>
                        <td data-label="Trạng thái" className="px-3 py-3">
                          <EnabledBadge enabled={account.enabled} />
                          <span className="mt-1 block text-[11px] text-muted">
                            Khóa tài khoản không làm ngừng hồ sơ nhân sự
                          </span>
                        </td>
                        <td data-card-actions="true" className="px-3 py-3">
                          <div className="flex flex-wrap justify-end gap-2 whitespace-nowrap">
                            <button type="button" className={`${button} min-h-11 md:min-h-8 whitespace-nowrap shrink-0`} disabled={rowActionsDisabled}
                              onClick={() => { setOrgOperation({ kind: "classification", account }); }}>
                              Phân loại
                            </button>
                            {account.active_person_link ? (
                              <button type="button" className={`${button} min-h-11 md:min-h-8 whitespace-nowrap shrink-0`} disabled={rowActionsDisabled}
                                onClick={() => { setOrgOperation({ kind: "unlink", account }); }}>
                                Ngắt liên kết
                              </button>
                            ) : (
                              <button
                                type="button"
                                className={`${button} min-h-11 md:min-h-8 whitespace-nowrap shrink-0`}
                                disabled={rowActionsDisabled || !canLink}
                                title={!canLink ? "Tài khoản SHARED/SERVICE không nối hồ sơ người" : undefined}
                                onClick={() => { if (canLink) setOrgOperation({ kind: "link", account }); }}
                              >
                                Liên kết người
                              </button>
                            )}
                            <button type="button" className={`${button} min-h-11 md:min-h-8 whitespace-nowrap shrink-0`} disabled={rowActionsDisabled}
                              onClick={() => { setOperation({ kind: "edit", account }); }}>
                              Sửa tên
                            </button>
                            <button type="button" className={`${button} min-h-11 md:min-h-8 whitespace-nowrap shrink-0`} disabled={rowActionsDisabled}
                              onClick={() => { setOperation({ kind: "reset", account }); }}>
                              Đặt lại mật khẩu
                            </button>
                            <button type="button" className={`${button} min-h-11 md:min-h-8 whitespace-nowrap shrink-0`} disabled={rowActionsDisabled}
                              onClick={() => startStateChange(account, !account.enabled)}>
                              {account.enabled ? "Ngừng hoạt động" : "Kích hoạt"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex flex-col gap-3 border-t border-border pt-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <p aria-live="polite">Trang {page} / {pageCount} · {list.total} kết quả</p>
              <nav aria-label="Phân trang danh sách tài khoản" className="flex items-center gap-2">
                <button type="button" className={button} disabled={page <= 1 || rowActionsDisabled}
                  onClick={() => { setPage((value) => value - 1); setListState({ kind: "loading" }); }}>
                  Trang trước
                </button>
                <button type="button" className={button} disabled={page >= pageCount || rowActionsDisabled}
                  onClick={() => { setPage((value) => value + 1); setListState({ kind: "loading" }); }}>
                  Trang sau
                </button>
              </nav>
            </div>
          </>
        ) : null}
      </Card>

      <AccountOperationDialogs
        key={operation === null ? "none" : operation === "create" ? "create" : operation.kind + ":" + operation.account.account_ref}
        operation={operation}
        busy={opBusy}
        onBusyChange={setOpBusy}
        trackRequest={trackWorkspaceRequest}
        isRequestActive={isWorkspaceRequestActive}
        onSessionLost={handleOrgSessionLost}
        onClose={() => { setOperation(null); }}
        onApplied={() => { setOperation(null); reloadList(); }}
        onNeedsReconcile={(intentId, state) => {
          setOperation(null);
          setReconcileIntent({ intentId, state });
          reloadList();
        }}
      />
      <AccountOrgDialogs
        key={orgOperation === null ? "org-none" : `${orgOperation.kind}:${orgOperation.account.account_ref}`}
        operation={orgOperation}
        trackRequest={trackWorkspaceRequest}
        isRequestActive={isWorkspaceRequestActive}
        onLockChange={setOrgDialogLocked}
        onClose={() => { setOrgOperation(null); }}
        onApplied={() => { setOrgOperation(null); reloadList(); }}
        onReloadRequested={reloadAccountsAuthoritative}
        onSessionLost={handleOrgSessionLost}
      />
      <AccountReconcileSurface
        intent={reconcileIntent}
        busy={opBusy}
        onBusyChange={setOpBusy}
        trackRequest={trackWorkspaceRequest}
        isRequestActive={isWorkspaceRequestActive}
        onSessionLost={handleOrgSessionLost}
        onClose={() => { setReconcileIntent(null); }}
        onDone={() => { setReconcileIntent(null); reloadList(); }}
      />
    </>
  );
}

function ReasonField({ value, disabled, onChange }: { value: string; disabled: boolean; onChange(value: string): void }) {
  return (
    <label htmlFor="account-reason" className="flex flex-col gap-1 text-sm font-medium">
      Lý do thao tác (không bắt buộc)
      <textarea id="account-reason" value={value} maxLength={4000} rows={3} disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-border bg-surface px-3 py-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
    </label>
  );
}

function ConflictReload({ message, busy, onReload }: {
  message: string | null; busy: boolean; onReload(): void;
}) {
  return (
    <Alert tone="warning" title="Cần tải lại dữ liệu có thẩm quyền">
      <p>Thao tác đang bị khóa để tránh ghi đè thay đổi mới hơn.</p>
      {message ? <p role="alert">{message}</p> : null}
      <button type="button" disabled={busy} onClick={onReload}
        className="mt-2 inline-flex min-h-10 items-center rounded-md border border-current px-3 font-medium disabled:opacity-50">
        {busy ? "Đang tải…" : "Tải lại dữ liệu"}
      </button>
    </Alert>
  );
}

const opButton = "inline-flex min-h-10 items-center justify-center rounded-md border border-border bg-surface px-3 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const opPrimary = "inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const opInput = "min-h-10 w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

function PasswordField({ id, label, value, onChange }: {
  id: string; label: string; value: string; onChange(value: string): void;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <input id={id} type="password" value={value} autoComplete="new-password"
        onChange={(event) => onChange(event.target.value)} className={opInput} />
    </label>
  );
}

function AccountOperationDialogs({
  operation,
  busy,
  onBusyChange,
  trackRequest,
  isRequestActive,
  onSessionLost,
  onClose,
  onApplied,
  onNeedsReconcile,
}: {
  operation: "create" | { kind: "edit"; account: ExistingAccount } | { kind: "reset"; account: ExistingAccount } | null;
  busy: boolean;
  onBusyChange(v: boolean): void;
  trackRequest(): AccountTrackedRequest;
  isRequestActive(epoch: number, controller?: AbortController): boolean;
  onSessionLost(): void;
  onClose(): void;
  onApplied(): void;
  onNeedsReconcile(intentId: string, state: string): void;
}) {
  const notify = useNotify();
  const [snapshotAccount] = useState<ExistingAccount | null>(() =>
    operation !== null && operation !== "create" ? operation.account : null,
  );
  const [loginId, setLoginId] = useState("");
  const [displayName, setDisplayName] = useState(snapshotAccount?.display_name ?? "");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [conflictLocked, setConflictLocked] = useState(false);

  const isCreate = operation === "create";
  const isEdit = operation !== null && operation !== "create" && operation.kind === "edit";
  const isReset = operation !== null && operation !== "create" && operation.kind === "reset";
  const accountRef = snapshotAccount?.account_ref ?? "";

  async function submit() {
    setFormError(null);
    if (operation === null || conflictLocked) return;
    const key = newAccountOperationKey();
    const request = isCreate
      ? buildCreateAccountRequest({ loginId, displayName, password, passwordConfirm, reason, idempotencyKey: key })
      : isEdit
        ? buildEditDisplayNameRequest({ displayName, expectedVersion: snapshotAccount?.version ?? 0, reason, idempotencyKey: key })
        : buildResetPasswordRequest({ password, passwordConfirm, reason, idempotencyKey: key });
    if (!request.ok) { setFormError(request.message); return; }

    const url = isCreate
      ? "/api/admin/access/accounts"
      : isEdit
        ? `/api/admin/access/accounts/${encodeURIComponent(accountRef)}/display-name`
        : `/api/admin/access/accounts/${encodeURIComponent(accountRef)}/reset-password`;

    onBusyChange(true);
    const tracked = trackRequest();
    try {
      const response = await fetch(url, {
        method: "POST",
        cache: "no-store",
        signal: tracked.controller.signal,
        headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(request.body),
      });
      if (!isRequestActive(tracked.epoch, tracked.controller)) return;
      const outcome = classifyAccountOperationResponse(response.status, await response.json().catch(() => null));
      if (!isRequestActive(tracked.epoch, tracked.controller)) return;
      if (outcome.kind === "denied") {
        onSessionLost();
        return;
      }
      onBusyChange(false);
      if (outcome.kind === "applied") {
        notify.success({ title: outcome.message });
        onApplied();
      } else if (outcome.kind === "needs-reconcile") {
        notify.warning({ title: outcome.message });
        onNeedsReconcile(outcome.intentId, outcome.state);
      } else if (outcome.kind === "conflict") {
        setConflictLocked(true);
        notify.warning({ title: outcome.message });
        setFormError(outcome.message);
      } else {
        notify.error({ title: outcome.message });
        setFormError(outcome.message);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!isRequestActive(tracked.epoch, tracked.controller)) return;
      onBusyChange(false);
      const errMsg = "Không nhận được phản hồi. Có thể thử lại đúng thao tác với cùng khóa idempotency.";
      notify.error({ title: errMsg });
      setFormError(errMsg);
    } finally {
      tracked.release();
      if (isRequestActive(tracked.epoch)) {
        onBusyChange(false);
      }
    }
  }

  const fieldsDisabled = busy || conflictLocked;

  return (
    <Dialog.Root open={operation !== null} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
          onPointerDownOutside={(event) => { if (busy) event.preventDefault(); }}
          className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-surface p-5 shadow-xl focus:outline-none sm:p-6"
          aria-describedby="account-op-dialog-description">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-xl font-semibold text-foreground">
                {isCreate ? "Tạo tài khoản" : isReset ? "Đặt lại mật khẩu" : "Sửa tên hiển thị"}
              </Dialog.Title>
              <Dialog.Description id="account-op-dialog-description" className="mt-1 text-sm text-muted">
                {isCreate
                  ? "Tài khoản được tạo với email <mã đăng nhập>@hrpartner.vn và mật khẩu riêng."
                  : "Lý do thao tác không bắt buộc; không đổi email/login và không lưu mật khẩu."}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Đóng hộp thoại" disabled={busy} className={opButton}>×</button>
            </Dialog.Close>
          </div>

          <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            {isCreate ? (
              <label className="flex flex-col gap-1 text-sm font-medium">
                Mã đăng nhập
                <input value={loginId} maxLength={64} disabled={fieldsDisabled} onChange={(event) => setLoginId(event.target.value)} className={opInput} />
              </label>
            ) : null}
            {!isReset ? (
              <label className="flex flex-col gap-1 text-sm font-medium">
                Tên hiển thị
                <input value={displayName} maxLength={256} disabled={fieldsDisabled} onChange={(event) => setDisplayName(event.target.value)} className={opInput} />
              </label>
            ) : null}
            {!isEdit ? (
              <>
                <PasswordField id="account-op-password" label="Mật khẩu" value={password} onChange={setPassword} />
                <PasswordField id="account-op-password-confirm" label="Nhập lại mật khẩu" value={passwordConfirm} onChange={setPasswordConfirm} />
              </>
            ) : null}
            <ReasonField value={reason} disabled={fieldsDisabled} onChange={(value) => { setReason(value); setFormError(null); }} />
            {formError ? <p role="alert" className="text-sm text-red-700">{formError}</p> : null}
            <button type="submit" disabled={fieldsDisabled} className={opPrimary}>
              {busy ? "Đang xử lý…" : isCreate ? "Tạo tài khoản" : isReset ? "Đặt lại mật khẩu" : "Lưu tên hiển thị"}
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AccountReconcileSurface({
  intent,
  busy,
  onBusyChange,
  trackRequest,
  isRequestActive,
  onSessionLost,
  onClose,
  onDone,
}: {
  intent: { intentId: string; state: string } | null;
  busy: boolean;
  onBusyChange(v: boolean): void;
  trackRequest(): AccountTrackedRequest;
  isRequestActive(epoch: number, controller?: AbortController): boolean;
  onSessionLost(): void;
  onClose(): void;
  onDone(): void;
}) {
  const notify = useNotify();
  if (intent === null) return null;
  const intentId = intent.intentId;

  async function reconcile() {
    const key = newAccountOperationKey();
    const request = buildReconcileRequest(key);
    if (!request.ok) { notify.error({ title: request.message }); return; }
    onBusyChange(true);
    const tracked = trackRequest();
    try {
      const response = await fetch(`/api/admin/access/accounts/intents/${encodeURIComponent(intentId)}/reconcile`, {
        method: "POST",
        cache: "no-store",
        signal: tracked.controller.signal,
        headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(request.body),
      });
      if (!isRequestActive(tracked.epoch, tracked.controller)) return;
      const outcome = classifyAccountOperationResponse(response.status, await response.json().catch(() => null));
      if (!isRequestActive(tracked.epoch, tracked.controller)) return;
      if (outcome.kind === "denied") {
        onSessionLost();
        return;
      }
      onBusyChange(false);
      if (outcome.kind === "applied") {
        notify.success({ title: outcome.message });
        onDone();
      } else if (outcome.kind === "needs-reconcile" || outcome.kind === "conflict") {
        notify.warning({ title: outcome.message });
      } else {
        notify.error({ title: outcome.message });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!isRequestActive(tracked.epoch, tracked.controller)) return;
      onBusyChange(false);
      notify.error({ title: "Dịch vụ hiện không khả dụng." });
    } finally {
      tracked.release();
      if (isRequestActive(tracked.epoch)) {
        onBusyChange(false);
      }
    }
  }

  async function reclassify() {
    onBusyChange(true);
    const tracked = trackRequest();
    try {
      const response = await fetch("/api/admin/access/accounts/reclassify", {
        method: "POST",
        cache: "no-store",
        signal: tracked.controller.signal,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: "{}",
      });
      if (!isRequestActive(tracked.epoch, tracked.controller)) return;
      if (response.status === 401 || response.status === 403) {
        onSessionLost();
        return;
      }
      const bodyJson = await response.json().catch(() => null);
      if (!isRequestActive(tracked.epoch, tracked.controller)) return;
      onBusyChange(false);
      if (response.ok && bodyJson && typeof bodyJson.reclassified === "object") {
        notify.success({
          title:
            "Đã phân loại lại " + String(bodyJson.reclassified.reclassified ?? 0) +
            " intent; purged " + String(bodyJson.reclassified.purged ?? 0) +
            "; deleted " + String(bodyJson.reclassified.deleted ?? 0) + ".",
        });
      } else {
        notify.error({ title: "Không phân loại lại được. Hãy thử lại." });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!isRequestActive(tracked.epoch, tracked.controller)) return;
      onBusyChange(false);
      notify.error({ title: "Dịch vụ hiện không khả dụng." });
    } finally {
      tracked.release();
      if (isRequestActive(tracked.epoch)) {
        onBusyChange(false);
      }
    }
  }

  return (
    <Alert tone="warning" title="Operation cần xử lý">
      <p>Intent đang ở trạng thái {intent.state}. Không tự retry Auth; chỉ Đối soát để xác minh qua Admin API.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void reconcile()} className={opPrimary}>
          {busy ? "Đang đối soát…" : "Đối soát"}
        </button>
        <button type="button" disabled={busy} onClick={() => void reclassify()} className={opButton}>
          {busy ? "Đang phân loại…" : "Phân loại lại"}
        </button>
        <button type="button" disabled={busy} onClick={onClose} className={opButton}>Đóng</button>
      </div>
    </Alert>
  );
}

type OrgDialogPendingIntent = {
  url: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  op: "classification" | "link" | "unlink";
  successMessage: string;
  uncertain: boolean;
};

type OrgDialogFeedback = {
  tone: "error" | "warning";
  message: string;
  needsReload: boolean;
} | null;

function AccountOrgDialogs({
  operation,
  trackRequest,
  isRequestActive,
  onLockChange,
  onClose,
  onApplied,
  onReloadRequested,
  onSessionLost,
}: {
  operation:
    | { kind: "classification"; account: ExistingAccount }
    | { kind: "link"; account: ExistingAccount }
    | { kind: "unlink"; account: ExistingAccount }
    | null;
  trackRequest: () => AccountTrackedRequest;
  isRequestActive: (epoch: number, controller?: AbortController) => boolean;
  onLockChange?: (locked: boolean) => void;
  onClose: () => void;
  onApplied: () => void;
  onReloadRequested: () => Promise<boolean>;
  onSessionLost: () => void;
}) {
  const notify = useNotify();
  const [targetAccount] = useState<ExistingAccount | null>(() => operation?.account ?? null);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const [selectedType, setSelectedType] = useState<AccountType>(
    targetAccount?.account_type ?? "NORMAL",
  );
  const [selectedPerson, setSelectedPerson] = useState<PersonSummaryProjection | null>(null);
  const [mismatchConfirmRequired, setMismatchConfirmRequired] = useState(false);
  const [confirmedRecruiter, setConfirmedRecruiter] = useState<AdminPersonnel | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [conflictLocked, setConflictLocked] = useState(false);
  const [pendingIntent, setPendingIntent] = useState<OrgDialogPendingIntent | null>(null);
  const [feedback, setFeedback] = useState<OrgDialogFeedback>(null);

  const isUncertainLocked = pendingIntent?.uncertain === true;
  const isDialogLocked = busy || reconciling || isUncertainLocked;
  const fieldsLocked = isDialogLocked || conflictLocked;
  const fieldsLockedRef = useRef(fieldsLocked);
  useEffect(() => {
    fieldsLockedRef.current = fieldsLocked;
  }, [fieldsLocked]);

  useEffect(() => {
    onLockChange?.(isDialogLocked);
    return () => {
      onLockChange?.(false);
    };
  }, [isDialogLocked, onLockChange]);

  const resetAndClose = () => {
    setPendingIntent(null);
    setFeedback(null);
    setConflictLocked(false);
    setMismatchConfirmRequired(false);
    setConfirmedRecruiter(null);
    onClose();
  };

  const handleSelectPerson = useCallback((person: PersonSummaryProjection | null) => {
    if (fieldsLockedRef.current) return;
    setPendingIntent(null);
    setMismatchConfirmRequired(false);
    setConfirmedRecruiter(null);
    setSelectedPerson(person);
  }, []);

  const handleSelectRecruiter = useCallback((recruiter: AdminPersonnel | null) => {
    if (fieldsLockedRef.current) return;
    setPendingIntent(null);
    setConfirmedRecruiter(recruiter);
  }, []);

  const handleReload = async () => {
    if (busy || reconciling) return;
    setReconciling(true);
    try {
      const ok = await onReloadRequested();
      if (!mountedRef.current) return;
      if (!ok) {
        setFeedback((prev) => ({
          tone: "warning",
          message: isUncertainLocked
            ? "Không thể tải dữ liệu đối chiếu lúc này. Yêu cầu và khóa gửi trùng vẫn được giữ nguyên."
            : prev?.message ??
              "Không thể tải dữ liệu mới nhất lúc này. Biểu mẫu vẫn đang khóa để tránh ghi đè.",
          needsReload: true,
        }));
        return;
      }
      resetAndClose();
    } finally {
      if (mountedRef.current) {
        setReconciling(false);
      }
    }
  };

  const executeIntent = async (intent: OrgDialogPendingIntent) => {
    setBusy(true);
    setFeedback(null);
    const tracked = trackRequest();
    try {
      let response: Response;
      try {
        response = await fetch(intent.url, {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "Idempotency-Key": intent.idempotencyKey,
          },
          body: JSON.stringify(intent.body),
        });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!isRequestActive(tracked.epoch, tracked.controller)) return;
        setPendingIntent({ ...intent, uncertain: true });
        setFeedback({
          tone: "warning",
          message:
            "Mất kết nối hoặc hết thời gian chờ phản hồi. Nội dung và khóa gửi trùng được giữ nguyên để thử gửi lại đúng yêu cầu hoặc tải lại đối chiếu.",
          needsReload: true,
        });
        return;
      }

      if (!isRequestActive(tracked.epoch, tracked.controller)) return;
      const rawJson: unknown = await response.json().catch(() => null);
      if (!isRequestActive(tracked.epoch, tracked.controller)) return;
      const outcome =
        intent.op === "classification"
          ? classifyAccountOrgMutation(response.status, rawJson, "classification")
          : intent.op === "link"
            ? classifyAccountOrgMutation(response.status, rawJson, "link")
            : classifyAccountOrgMutation(response.status, rawJson, "unlink");

      if (outcome.kind === "applied") {
        notify.success({ title: intent.successMessage });
        resetAndClose();
        onApplied();
        return;
      }

      if (outcome.kind === "session-lost") {
        resetAndClose();
        onSessionLost();
        return;
      }

      if (outcome.kind === "uncertain" && outcome.preserveIdempotencyKey) {
        setPendingIntent({ ...intent, uncertain: true });
        setFeedback({
          tone: "warning",
          message: outcome.message,
          needsReload: true,
        });
        return;
      }

      setPendingIntent(null);

      if (outcome.kind === "recruiter-mismatch") {
        setMismatchConfirmRequired(true);
        setConfirmedRecruiter(null);
        setFeedback({
          tone: "warning",
          message: outcome.message,
          needsReload: false,
        });
        return;
      }

      if (outcome.kind === "conflict") {
        setConflictLocked(true);
      }

      setFeedback({
        tone: outcome.kind === "conflict" ? "warning" : "error",
        message: outcome.message,
        needsReload: outcome.kind === "conflict",
      });
    } finally {
      tracked.release();
      if (isRequestActive(tracked.epoch) && mountedRef.current) {
        setBusy(false);
      }
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!operation || !targetAccount || busy || reconciling) return;

    if (pendingIntent?.uncertain) {
      void executeIntent(pendingIntent);
      return;
    }

    if (conflictLocked) return;

    const idempotencyKey = pendingIntent?.idempotencyKey ?? newAccountIntentKey();

    if (operation.kind === "classification") {
      const built = buildSetAccountClassificationRequest({
        expectedAccountVersion: targetAccount.version,
        accountType: selectedType,
        reason,
        idempotencyKey,
      });
      if (!built.ok) {
        setFeedback({ tone: "error", message: built.message, needsReload: false });
        return;
      }
      const intent: OrgDialogPendingIntent = {
        url: `/api/admin/access/accounts/${encodeURIComponent(targetAccount.account_ref)}/classification`,
        idempotencyKey: built.idempotencyKey,
        body: built.body,
        op: "classification",
        successMessage: `Đã cập nhật phân loại tài khoản sang ${selectedType}.`,
        uncertain: false,
      };
      setPendingIntent(intent);
      void executeIntent(intent);
      return;
    }

    if (operation.kind === "link") {
      if (!selectedPerson) {
        setFeedback({
          tone: "error",
          message: "Vui lòng tìm và chọn hồ sơ nhân sự nội bộ chưa liên kết.",
          needsReload: false,
        });
        return;
      }
      if (mismatchConfirmRequired && !confirmedRecruiter) {
        setFeedback({
          tone: "warning",
          message:
            "Vui lòng tìm và chọn đúng hồ sơ tính công tuyển dụng để xác nhận rõ ràng trước khi gửi lại.",
          needsReload: false,
        });
        return;
      }
      const built = buildLinkAccountPersonRequest({
        personId: selectedPerson.person_id,
        expectedAccountVersion: targetAccount.version,
        expectedPersonVersion: selectedPerson.version,
        confirmedRecruiterId: mismatchConfirmRequired ? confirmedRecruiter?.recruiter_id ?? null : null,
        reason,
        idempotencyKey,
      });
      if (!built.ok) {
        setFeedback({ tone: "error", message: built.message, needsReload: false });
        return;
      }
      const intent: OrgDialogPendingIntent = {
        url: `/api/admin/access/accounts/${encodeURIComponent(targetAccount.account_ref)}/person-link`,
        idempotencyKey: built.idempotencyKey,
        body: built.body,
        op: "link",
        successMessage: `Đã liên kết tài khoản với hồ sơ ${selectedPerson.full_name} (${selectedPerson.employee_code}).`,
        uncertain: false,
      };
      setPendingIntent(intent);
      void executeIntent(intent);
      return;
    }

    const activeLink = targetAccount.active_person_link;
    if (!activeLink) {
      setFeedback({
        tone: "warning",
        message: "Tài khoản hiện không còn liên kết hồ sơ người đang hiệu lực. Hãy tải lại danh sách.",
        needsReload: true,
      });
      return;
    }
    const built = buildUnlinkAccountPersonRequest({
      expectedAccountVersion: targetAccount.version,
      expectedPersonVersion: activeLink.person_version,
      expectedLinkId: activeLink.link_id,
      reason,
      idempotencyKey,
    });
    if (!built.ok) {
      setFeedback({ tone: "error", message: built.message, needsReload: false });
      return;
    }
    const intent: OrgDialogPendingIntent = {
      url: `/api/admin/access/accounts/${encodeURIComponent(targetAccount.account_ref)}/person-link/end`,
      idempotencyKey: built.idempotencyKey,
      body: built.body,
      op: "unlink",
      successMessage: `Đã ngắt liên kết giữa tài khoản và hồ sơ ${activeLink.full_name}.`,
      uncertain: false,
    };
    setPendingIntent(intent);
    void executeIntent(intent);
  };

  const isUnlinkingFromClassification =
    operation?.kind === "classification" &&
    targetAccount?.active_person_link !== null &&
    selectedType !== "NORMAL";

  return (
    <FormDialog
      open={operation !== null}
      onOpenChange={(open) => {
        if (!open && !isDialogLocked) resetAndClose();
      }}
      title={
        operation?.kind === "classification"
          ? "Đổi phân loại tài khoản"
          : operation?.kind === "link"
            ? "Liên kết tài khoản với Nhân sự nội bộ"
            : operation?.kind === "unlink"
              ? "Ngắt liên kết hồ sơ Nhân sự nội bộ"
              : "Quản trị tài khoản"
      }
      description={
        targetAccount
          ? `Tài khoản: ${targetAccount.display_name ?? "Chưa cập nhật tên thật"}${targetAccount.login_id ? ` (${targetAccount.login_id})` : ""}`
          : undefined
      }
      descriptionId="account-org-dialog-desc"
      closeDisabled={isDialogLocked}
      dataTestId="account-org-dialog"
    >
      {operation && targetAccount ? (
        <form className="space-y-4" onSubmit={handleSubmit}>
          {operation.kind === "classification" ? (
            <div className="space-y-3">
              <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
                Phân loại tài khoản
                <select
                  value={selectedType}
                  disabled={fieldsLocked}
                  onChange={(event) => {
                    if (fieldsLocked) return;
                    setPendingIntent(null);
                    setSelectedType(event.target.value as AccountType);
                  }}
                  className={opInput}
                >
                  {ACCOUNT_TYPES.map((typeOption) => (
                    <option key={typeOption} value={typeOption}>
                      {accountTypeBadgeMeta(typeOption).label}
                    </option>
                  ))}
                </select>
              </label>
              {selectedType !== "NORMAL" ? (
                <Alert
                  tone={isUnlinkingFromClassification ? "warning" : "info"}
                  title="Lưu ý phân loại SHARED / SERVICE"
                >
                  Tài khoản SHARED hoặc SERVICE không được nối hồ sơ Nhân sự nội bộ. Nếu tài khoản vẫn còn liên kết người hoặc phân công cá nhân đang hiệu lực, hệ thống sẽ từ chối đổi loại và không tự thu hồi phân công.
                </Alert>
              ) : null}
            </div>
          ) : null}

          {operation.kind === "link" ? (
            <div className="space-y-3">
              {targetAccount.account_type !== "NORMAL" ? (
                <Alert tone="error" title="Không thể liên kết">
                  Chỉ tài khoản phân loại Cá nhân (NORMAL) mới được liên kết hồ sơ nhân sự nội bộ.
                </Alert>
              ) : (
                <>
                  <PersonSearchPicker
                    id="account-link-person-picker"
                    label="Tìm và chọn hồ sơ nhân sự nội bộ (chưa liên kết tài khoản)"
                    selectedPersonId={selectedPerson?.person_id ?? null}
                    linkState="unlinked"
                    disabled={fieldsLocked || mismatchConfirmRequired}
                    onSelect={handleSelectPerson}
                    onSessionLost={onSessionLost}
                  />
                  {mismatchConfirmRequired ? (
                    <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/60 p-3 dark:border-amber-700/60 dark:bg-amber-950/30">
                      <Alert tone="warning" title="Xác nhận thủ công hồ sơ tính công tuyển dụng">
                        Phát hiện sai khác với liên kết tính công tuyển dụng hiện có. Vui lòng tự tìm và chọn đúng hồ sơ tính công tuyển dụng để gửi xác nhận (`confirmed_recruiter_id`), hệ thống không tự ghi đè.
                      </Alert>
                      <RecruiterConfirmPicker
                        id="account-link-recruiter-confirm-picker"
                        label="Chọn hồ sơ tính công tuyển dụng cần xác nhận"
                        selectedRecruiterId={confirmedRecruiter?.recruiter_id ?? null}
                        initialSearch={selectedPerson?.full_name ?? ""}
                        disabled={fieldsLocked}
                        onSelect={handleSelectRecruiter}
                        onSessionLost={onSessionLost}
                      />
                    </div>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {operation.kind === "unlink" && targetAccount.active_person_link ? (
            <Alert tone="warning" title="Xác nhận ngắt liên kết hồ sơ nhân sự">
              Ngắt liên kết giữa tài khoản này và{" "}
              <strong>
                {targetAccount.active_person_link.full_name} (
                {targetAccount.active_person_link.employee_code})
              </strong>
              . Thao tác này không làm ngừng hoạt động hồ sơ nhân sự hoặc khóa tài khoản.
            </Alert>
          ) : null}

          <label className="flex flex-col gap-1 text-sm font-medium text-foreground">
            Lý do thao tác (bắt buộc)
            <textarea
              required
              rows={3}
              value={reason}
              disabled={fieldsLocked}
              maxLength={ACCOUNT_ORG_MAX_REASON_LENGTH}
              placeholder="Nhập lý do phân loại hoặc liên kết tài khoản…"
              onChange={(event) => {
                if (fieldsLocked) return;
                setPendingIntent(null);
                setReason(event.target.value);
              }}
              className="rounded-md border border-border bg-surface px-3 py-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
            />
          </label>

          {feedback ? (
            <Alert
              tone={feedback.tone}
              role="alert"
              title={feedback.tone === "warning" ? "Cần xác nhận hoặc tải lại" : "Không thể thực hiện"}
            >
              <p>{feedback.message}</p>
              {feedback.needsReload ? (
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || reconciling}
                    onClick={() => void handleReload()}
                  >
                    {reconciling ? "Đang tải đối chiếu…" : "Tải lại dữ liệu mới nhất"}
                  </Button>
                </div>
              ) : null}
            </Alert>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button
              variant="secondary"
              size="md"
              disabled={isDialogLocked}
              onClick={() => {
                if (!isDialogLocked) resetAndClose();
              }}
            >
              Hủy
            </Button>
            <Button
              type="submit"
              variant={operation.kind === "unlink" ? "danger" : "primary"}
              size="md"
              loading={busy}
              disabled={
                busy ||
                reconciling ||
                (conflictLocked && !pendingIntent?.uncertain) ||
                (operation.kind === "link" &&
                  targetAccount.account_type !== "NORMAL") ||
                (operation.kind === "link" &&
                  (!selectedPerson ||
                    (mismatchConfirmRequired && !confirmedRecruiter)) &&
                  !pendingIntent?.uncertain)
              }
            >
              {pendingIntent?.uncertain
                ? "Thử gửi lại cùng yêu cầu"
                : operation.kind === "link" && mismatchConfirmRequired
                  ? "Xác nhận liên kết kèm hồ sơ đã chọn"
                  : operation.kind === "classification"
                    ? "Lưu phân loại"
                    : operation.kind === "link"
                      ? "Xác nhận liên kết"
                      : "Xác nhận ngắt liên kết"}
            </Button>
          </div>
        </form>
      ) : null}
    </FormDialog>
  );
}
