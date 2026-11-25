"use client";

import { useEffect, useState, type FormEvent } from "react";
import * as Dialog from "radix-ui/dialog";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { useNotify } from "@/components/ui/notify-provider";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import type {
  AdminLaborType,
  AdminLaborTypeList,
} from "@/lib/direct-entry/labor-type-catalog-contract";
import {
  buildLaborTypeCreateRequest,
  buildLaborTypeListQuery,
  buildLaborTypeSetActiveRequest,
  buildLaborTypeUpdateRequest,
  classifyLaborTypeMutation,
  laborTypeListConfirmsKey,
  newLaborTypeIntentKey,
  projectLaborTypeItem,
  projectLaborTypeListForQuery,
} from "@/lib/admin/labor-type-catalog-model";

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; list: AdminLaborTypeList }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; laborType: AdminLaborType }
  | { kind: "active"; laborType: AdminLaborType; active: boolean };

type FormState = { laborTypeKey: string; displayName: string; sortOrder: string; reason: string };
type MutationIntent = {
  url: string;
  method: "POST" | "PATCH";
  operation: "create" | "update" | "set-active";
  laborTypeKey: string | null;
  lockId: string;
  body: Record<string, unknown>;
  retry: boolean;
};

const EMPTY_FORM: FormState = { laborTypeKey: "", displayName: "", sortOrder: "", reason: "" };
const button = "inline-flex min-h-10 items-center justify-center rounded-md border border-border " +
  "bg-surface px-3 text-sm font-medium text-foreground focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = "inline-flex min-h-10 items-center justify-center rounded-md bg-primary " +
  "px-4 text-sm font-medium text-on-primary focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span className={active
      ? "inline-flex whitespace-nowrap rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
      : "inline-flex whitespace-nowrap rounded-full bg-slate-200 px-2.5 py-1 text-xs font-medium text-slate-900 dark:bg-slate-700 dark:text-slate-100"}>
      {active ? "Đang hoạt động" : "Ngừng hoạt động"}
    </span>
  );
}

export function LaborTypeCatalogManager() {
  const notify = useNotify();
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingIntent, setPendingIntent] = useState<MutationIntent | null>(null);
  const [conflictIntent, setConflictIntent] = useState<MutationIntent | null>(null);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const query = buildLaborTypeListQuery({ search, includeInactive, page });
      if (!query) {
        setListState({ kind: "error" });
        return;
      }
      let response: Response;
      try {
        response = await fetch(`/api/admin/catalog/labor-types?${query.toString()}`, {
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
        const list = projectLaborTypeListForQuery(await response.json(), {
          search, includeInactive, page,
        });
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
        setListState({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [includeInactive, page, reloadToken, search]);

  const reloadList = () => {
    setListState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const changeForm = (field: keyof FormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setFormError(null);
  };

  const startCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setDialog({ kind: "create" });
  };

  const startEdit = (laborType: AdminLaborType) => {
    setForm({
      laborTypeKey: laborType.labor_type_key,
      displayName: laborType.display_name,
      sortOrder: String(laborType.sort_order),
      reason: "",
    });
    setFormError(null);
    setDialog({ kind: "edit", laborType });
  };

  const startActive = (laborType: AdminLaborType, active: boolean) => {
    setForm({ ...EMPTY_FORM, reason: "" });
    setFormError(null);
    setDialog({ kind: "active", laborType, active });
  };

  const reloadAuthoritative = async (intent: MutationIntent): Promise<boolean> => {
    setConflictError(null);
    setBusy(true);
    try {
      if (intent.laborTypeKey !== null) {
        const response = await fetch(
          `/api/admin/catalog/labor-types/${encodeURIComponent(intent.laborTypeKey)}`,
          { method: "GET", cache: "no-store", headers: { Accept: "application/json" } },
        );
        if (response.status === 404) {
          setConflictIntent(null);
          setPendingIntent(null);
          setDialog(null);
          notify.warning({ title: "Loại hình lao động không còn khả dụng. Danh sách đang được cập nhật." });
          reloadList();
          return false;
        }
        const laborType = response.status === 200
          ? projectLaborTypeItem(await response.json())
          : null;
        if (!laborType || laborType.labor_type_key !== intent.laborTypeKey) {
          throw new Error("authoritative reload failed");
        }
      } else {
        const laborTypeKey = String(intent.body.labor_type_key ?? "");
        const query = buildLaborTypeListQuery({
          search: laborTypeKey, includeInactive: true, page: 1,
        });
        if (!query) throw new Error("invalid exact-key query");
        const response = await fetch(`/api/admin/catalog/labor-types?${query.toString()}`, {
          method: "GET", cache: "no-store", headers: { Accept: "application/json" },
        });
        const list = response.status === 200
          ? projectLaborTypeListForQuery(await response.json(), {
              search: laborTypeKey, includeInactive: true, page: 1,
            })
          : null;
        if (!list || !laborTypeListConfirmsKey(list, laborTypeKey)) {
          throw new Error("authoritative create reload failed");
        }
      }
      setConflictIntent(null);
      setConflictError(null);
      setPendingIntent(null);
      setDialog(null);
      reloadList();
      return true;
    } catch {
      const errMsg = "Không tải được dữ liệu có thẩm quyền. Thao tác vẫn đang bị khóa; hãy thử tải lại.";
      setConflictError(errMsg);
      notify.error({ title: errMsg });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const sendIntent = async (intent: MutationIntent) => {
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
            "Idempotency-Key": String(intent.body.idempotency_key),
          },
          body: JSON.stringify(intent.body),
        });
      } catch {
        setPendingIntent({ ...intent, retry: true });
        notify.error({ title: "Không nhận được phản hồi. Có thể thử lại đúng thao tác với cùng khóa idempotency." });
        return;
      }
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const outcome = classifyLaborTypeMutation(response.status, payload, intent.operation);
      if (outcome.kind === "applied" || outcome.kind === "conflict") {
        setPendingIntent(null);
        setConflictIntent(intent);
        setConflictError(null);
        if (outcome.kind === "conflict") {
          notify.warning({ title: outcome.message });
        }
        const reloaded = await reloadAuthoritative(intent);
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
      setFormError(outcome.message);
      if (outcome.kind === "not-found" && intent.laborTypeKey !== null) {
        notify.warning({ title: outcome.message });
        setDialog(null);
        reloadList();
        return;
      }
      notify.error({ title: outcome.message });
    } finally {
      setBusy(false);
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
    const idempotencyKey = newLaborTypeIntentKey();
    let request;
    let intent: MutationIntent;
    if (dialog.kind === "create") {
      request = buildLaborTypeCreateRequest({
        laborTypeKey: form.laborTypeKey,
        displayName: form.displayName,
        sortOrder: form.sortOrder,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: "/api/admin/catalog/labor-types", method: "POST", operation: "create",
        laborTypeKey: null, lockId: "create", body: request.body, retry: false,
      };
    } else if (dialog.kind === "edit") {
      request = buildLaborTypeUpdateRequest({
        displayName: form.displayName,
        sortOrder: form.sortOrder,
        expectedVersion: dialog.laborType.version,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: `/api/admin/catalog/labor-types/${encodeURIComponent(dialog.laborType.labor_type_key)}`,
        method: "PATCH", operation: "update", laborTypeKey: dialog.laborType.labor_type_key,
        lockId: dialog.laborType.labor_type_key, body: request.body, retry: false,
      };
    } else {
      request = buildLaborTypeSetActiveRequest({
        active: dialog.active,
        expectedVersion: dialog.laborType.version,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: `/api/admin/catalog/labor-types/${encodeURIComponent(dialog.laborType.labor_type_key)}/active`,
        method: "POST", operation: "set-active", laborTypeKey: dialog.laborType.labor_type_key,
        lockId: dialog.laborType.labor_type_key, body: request.body, retry: false,
      };
    }
    setPendingIntent(intent);
    void sendIntent(intent);
  };

  const list = listState.kind === "loaded" ? listState.list : null;
  const pageCount = list
    ? Math.min(1000, Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))))
    : 1;

  return (
    <>
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Danh mục loại hình lao động</h1>
          <p className="mt-1 text-sm text-muted">Quản lý tên hiển thị, thứ tự và trạng thái loại hình lao động.</p>
        </div>
        <Dialog.Root open={dialog?.kind === "create" || dialog?.kind === "edit" || dialog?.kind === "active"}
          onOpenChange={(open) => { if (!open && !busy && !conflictIntent) setDialog(null); }}>
          <Dialog.Trigger asChild>
            <button type="button" onClick={startCreate}
              disabled={busy || conflictIntent !== null || pendingIntent !== null}
              className={primaryButton}>
              Thêm loại hình lao động
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay
              data-ui-overlay-motion="true"
              className="fixed inset-0 z-40 bg-[var(--backdrop)] backdrop-blur-[7px]"
            />
            <Dialog.Content
              data-ui-dialog-motion="true"
              onCloseAutoFocus={(event) => { if (busy || conflictIntent) event.preventDefault(); }}
              className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(38rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border border-t-2 border-t-primary bg-surface p-5 text-foreground shadow-[var(--shadow-dialog)] focus:outline-none sm:p-6"
              aria-describedby="labor-type-dialog-description"
            >
              <div className="flex items-start justify-between gap-4 border-b border-border pb-3.5">
                <div>
                  <Dialog.Title className="text-xl font-semibold tracking-tight text-[var(--navy)]">
                    {dialog?.kind === "create" ? "Thêm loại hình lao động"
                      : dialog?.kind === "edit" ? "Chỉnh sửa loại hình lao động"
                        : dialog?.active ? "Kích hoạt loại hình lao động" : "Ngừng hoạt động loại hình lao động"}
                  </Dialog.Title>
                  <Dialog.Description id="labor-type-dialog-description" className="mt-1 text-sm text-muted">
                    Lý do thao tác không bắt buộc; mã loại hình lao động không thể thay đổi sau khi tạo.
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button type="button" aria-label="Đóng hộp thoại" disabled={busy || conflictIntent !== null}
                    className="inline-flex min-h-11 min-w-11 sm:min-h-9 sm:min-w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-muted px-3 text-sm font-medium text-[var(--navy)] transition-colors hover:border-primary hover:bg-surface hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50">×</button>
                </Dialog.Close>
              </div>
              {pendingIntent?.retry && (dialog?.kind === "create"
                ? pendingIntent.lockId === "create"
                : dialog && "laborType" in dialog && pendingIntent.lockId === dialog.laborType.labor_type_key) ? (
                <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
                  <p>Thử lại đúng thao tác với cùng khóa idempotency.</p>
                  <button type="button" disabled={busy} className={`${button} mt-2`}
                    onClick={() => void sendIntent(pendingIntent)}>Thử lại thao tác</button>
                </Alert>
              ) : null}
              {conflictIntent && dialog && conflictIntent.lockId ===
                (dialog.kind === "create" ? "create" : dialog.laborType.labor_type_key) ? (
                <ConflictReload
                  message={conflictError}
                  busy={busy}
                  onReload={() => void reloadAuthoritative(conflictIntent).then((ok) => {
                    if (ok) notify.success({ title: "Đã tải dữ liệu mới nhất từ máy chủ." });
                  })}
                />
              ) : null}
              {dialog?.kind === "active" ? (
                <div className="mt-5 space-y-4">
                  <p>
                    Bạn sắp {dialog.active ? "kích hoạt" : "ngừng hoạt động"} loại hình lao động{" "}
                    <strong>{dialog.laborType.display_name}</strong> ({dialog.laborType.labor_type_key}).
                    Thao tác này không xóa dữ liệu hay lịch sử.
                  </p>
                  <form onSubmit={submit} className="space-y-4">
                    <ReasonField value={form.reason} onChange={(value) => changeForm("reason", value)} />
                    {formError ? <p role="alert" className="text-sm text-red-700">{formError}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                      <Dialog.Close asChild>
                        <button type="button" disabled={busy || conflictIntent !== null} className={button}>
                          Hủy
                        </button>
                      </Dialog.Close>
                      <button type="submit" disabled={busy || pendingIntent !== null || conflictIntent !== null}
                        className={primaryButton}>
                        {busy ? "Đang lưu…" : dialog.active ? "Xác nhận kích hoạt" : "Xác nhận ngừng"}
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <form onSubmit={submit} className="mt-5 space-y-4">
                  {dialog?.kind === "create" ? (
                    <Field id="labor-type-key" label="Mã loại hình lao động" value={form.laborTypeKey}
                      maxLength={64} required onChange={(value) => changeForm("laborTypeKey", value)} />
                  ) : (
                    <div className="text-sm">
                      <span className="font-medium text-foreground">Mã loại hình lao động</span>
                      <p className="mt-1 text-muted">{dialog?.kind === "edit" ? dialog.laborType.labor_type_key : "—"}</p>
                      <span className="mt-1 block text-xs text-muted">Mã không thể thay đổi sau khi tạo.</span>
                    </div>
                  )}
                  <Field id="labor-type-name" label="Tên hiển thị" value={form.displayName}
                    maxLength={256} required onChange={(value) => changeForm("displayName", value)} />
                  <Field id="labor-type-sort-order" label="Thứ tự sắp xếp" type="number"
                    value={form.sortOrder} maxLength={6} required
                    onChange={(value) => changeForm("sortOrder", value)} />
                  <ReasonField value={form.reason} onChange={(value) => changeForm("reason", value)} />
                  {formError ? <p role="alert" className="text-sm text-red-700">{formError}</p> : null}
                  <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                    <Dialog.Close asChild>
                      <button type="button" disabled={busy || conflictIntent !== null} className={button}>
                        Hủy
                      </button>
                    </Dialog.Close>
                    <button type="submit" disabled={busy || pendingIntent !== null || conflictIntent !== null}
                      className={primaryButton}>
                      {busy ? "Đang lưu…" : dialog?.kind === "create" ? "Tạo loại hình lao động" : "Lưu thay đổi"}
                    </button>
                  </div>
                </form>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </header>

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
        <CardHeader title="Danh sách loại hình lao động"
          description={list ? `${list.total} loại hình lao động phù hợp` : "Tìm kiếm và lọc danh mục loại hình lao động."} />
        <form className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]" onSubmit={(event) => {
          event.preventDefault();
          const query = buildLaborTypeListQuery({ search: searchInput, includeInactive, page: 1 });
          if (!query) {
            setListState({ kind: "error" });
            return;
          }
          setPage(1);
          setSearch(searchInput.trim());
          setListState({ kind: "loading" });
        }}>
          <label className="flex flex-col gap-1 text-sm font-medium">
            Tìm kiếm
            <input value={searchInput} maxLength={256} onChange={(event) => setSearchInput(event.target.value)}
              className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={includeInactive} onChange={(event) => {
              setIncludeInactive(event.target.checked);
              setPage(1);
              setListState({ kind: "loading" });
            }} />
            Bao gồm loại hình lao động ngừng hoạt động
          </label>
          <button type="submit" className={`${button} min-h-11 sm:min-h-10 self-end`}>Tìm kiếm</button>
        </form>

        {listState.kind === "loading" ? <p role="status" className="py-8 text-center text-sm text-muted">Đang tải danh sách loại hình lao động…</p> : null}
        {listState.kind === "denied" ? <ErrorState title="Không có quyền xem danh mục loại hình lao động" /> : null}
        {listState.kind === "unavailable" ? (
          <div className="space-y-3">
            <ErrorState title="Dịch vụ danh mục loại hình lao động hiện không khả dụng" />
            <button type="button" className={button} onClick={reloadList}>Thử tải lại</button>
          </div>
        ) : null}
        {listState.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState title="Không tải được danh sách loại hình lao động" detail="Phản hồi không hợp lệ. Hãy thử tải lại." />
            <button type="button" className={button} onClick={reloadList}>Thử tải lại</button>
          </div>
        ) : null}
        {list ? list.labor_types.length === 0 ? (
          <EmptyState title="Chưa có loại hình lao động phù hợp" description="Thay đổi bộ lọc hoặc thêm loại hình lao động mới." />
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-2xs">
              <table className="r22-card-table w-full border-collapse text-left text-sm">
                <caption className="sr-only">Danh sách loại hình lao động và trạng thái</caption>
                <thead className="border-b border-border bg-surface-muted text-xs uppercase text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-3">Mã loại hình</th>
                    <th scope="col" className="px-3 py-3">Tên hiển thị</th>
                    <th scope="col" className="px-3 py-3 text-right">Thứ tự</th>
                    <th scope="col" className="px-3 py-3">Trạng thái</th>
                    <th scope="col" className="px-3 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {list.labor_types.map((laborType) => {
                    const locked = busy || pendingIntent !== null || conflictIntent !== null;
                    return (
                      <tr key={laborType.labor_type_key} className="border-b border-border/70 last:border-0 hover:bg-surface-hover">
                        <td data-card-header="true" className="px-3 py-3 font-mono text-xs">{laborType.labor_type_key}</td>
                        <td data-label="Tên hiển thị" className="px-3 py-3 font-medium">{laborType.display_name}</td>
                        <td data-label="Thứ tự" className="px-3 py-3 text-right font-mono tabular-nums">{laborType.sort_order}</td>
                        <td data-label="Trạng thái" className="px-3 py-3"><ActiveBadge active={laborType.active} /></td>
                        <td data-card-actions="true" className="px-3 py-3">
                          <div className="flex flex-wrap justify-end gap-2 whitespace-nowrap">
                            <button type="button" className={`${button} min-h-11 md:min-h-8 whitespace-nowrap shrink-0`} disabled={locked}
                              onClick={() => startEdit(laborType)}>Chỉnh sửa</button>
                            <button type="button" className={`${button} min-h-11 md:min-h-8 whitespace-nowrap shrink-0`} disabled={locked}
                              onClick={() => startActive(laborType, !laborType.active)}>
                              {laborType.active ? "Ngừng" : "Kích hoạt"}
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
              <nav aria-label="Phân trang danh sách loại hình lao động" className="flex items-center gap-2">
                <button type="button" className={button} disabled={page <= 1}
                  onClick={() => { setPage((value) => value - 1); setListState({ kind: "loading" }); }}>
                  Trang trước
                </button>
                <button type="button" className={button} disabled={page >= pageCount}
                  onClick={() => { setPage((value) => value + 1); setListState({ kind: "loading" }); }}>
                  Trang sau
                </button>
              </nav>
            </div>
          </>
        ) : null}
      </Card>
    </>
  );
}

function Field({ id, label, value, maxLength, required, type = "text", onChange }: {
  id: string; label: string; value: string; maxLength: number; required: boolean;
  type?: "text" | "number";
  onChange(value: string): void;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <input id={id} type={type} value={value} maxLength={maxLength} required={required}
        min={type === "number" ? 0 : undefined} max={type === "number" ? 100000 : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 rounded-md border border-border bg-surface px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50" />
    </label>
  );
}

function ReasonField({ value, onChange }: { value: string; onChange(value: string): void }) {
  return (
    <label htmlFor="labor-type-reason" className="flex flex-col gap-1 text-sm font-medium">
      Lý do thay đổi (không bắt buộc)
      <textarea id="labor-type-reason" value={value} maxLength={4000} rows={3}
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
