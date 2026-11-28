"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { OffsetPager } from "@/components/ui/offset-pager";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import {
  buildCollaboratorCreateRequest,
  buildCollaboratorListQuery,
  buildCollaboratorSetActiveRequest,
  buildCollaboratorUpdateRequest,
  classifyCollaboratorMutation,
  collaboratorListConfirmsId,
  newCollaboratorIntentKey,
  projectCollaboratorItem,
  projectCollaboratorListForQuery,
  type AdminCollaborator,
  type AdminCollaboratorList,
} from "@/lib/direct-entry/collaborator-catalog-contract";

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; list: AdminCollaboratorList }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; collaborator: AdminCollaborator }
  | { kind: "active"; collaborator: AdminCollaborator; active: boolean };

type FormState = { collaboratorId: string; displayName: string; reason: string };

type MutationIntent = {
  url: string;
  method: "POST" | "PATCH";
  operation: "create" | "update" | "set-active";
  collaboratorId: string | null;
  lockId: string;
  body: Record<string, unknown>;
  retry: boolean;
};

const EMPTY_FORM: FormState = { collaboratorId: "", displayName: "", reason: "" };
const button =
  "inline-flex min-h-10 items-center justify-center rounded-md border border-border " +
  "bg-surface px-3 text-sm font-medium text-foreground focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton =
  "inline-flex min-h-10 items-center justify-center rounded-md bg-primary " +
  "px-4 text-sm font-medium text-on-primary focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <span
      className={
        active
          ? "inline-flex whitespace-nowrap rounded-full border border-status-success-border bg-status-success-bg px-2.5 py-1 text-xs font-medium text-status-success-text"
          : "inline-flex whitespace-nowrap rounded-full border border-border bg-surface-muted px-2.5 py-1 text-xs font-medium text-muted"
      }
    >
      {active ? "Đang hoạt động" : "Ngừng hoạt động"}
    </span>
  );
}

export function CollaboratorCatalogManager() {
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
      const query = buildCollaboratorListQuery({ search, includeInactive, page });
      if (!query) {
        setListState({ kind: "error" });
        return;
      }
      let response: Response;
      try {
        response = await fetch(`/api/admin/catalog/collaborators?${query.toString()}`, {
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
        setListState(
          response.status === 404 || response.status >= 500
            ? { kind: "unavailable" }
            : { kind: "error" },
        );
        return;
      }
      try {
        const list = projectCollaboratorListForQuery(await response.json(), {
          search,
          includeInactive,
          page,
        });
        if (!list) {
          setListState({ kind: "error" });
          return;
        }
        const pageCount = Math.min(
          1000,
          Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))),
        );
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

  const startEdit = (collaborator: AdminCollaborator) => {
    setForm({
      collaboratorId: collaborator.collaborator_id,
      displayName: collaborator.display_name,
      reason: "",
    });
    setFormError(null);
    setDialog({ kind: "edit", collaborator });
  };

  const startActive = (collaborator: AdminCollaborator, active: boolean) => {
    setForm({ ...EMPTY_FORM, reason: "" });
    setFormError(null);
    setDialog({ kind: "active", collaborator, active });
  };

  const reloadAuthoritative = async (intent: MutationIntent): Promise<boolean> => {
    setConflictError(null);
    setBusy(true);
    try {
      if (intent.collaboratorId !== null) {
        const response = await fetch(
          `/api/admin/catalog/collaborators/${encodeURIComponent(intent.collaboratorId)}`,
          { method: "GET", cache: "no-store", headers: { Accept: "application/json" } },
        );
        if (response.status === 404) {
          setConflictIntent(null);
          setPendingIntent(null);
          setDialog(null);
          notify.warning({ title: "Cộng tác viên không còn khả dụng. Danh sách đang được cập nhật." });
          reloadList();
          return false;
        }
        const item = response.status === 200 ? projectCollaboratorItem(await response.json()) : null;
        if (!item || item.collaborator_id !== intent.collaboratorId) {
          throw new Error("authoritative reload failed");
        }
      } else {
        const createdId = String(intent.body.collaborator_id ?? "");
        const query = buildCollaboratorListQuery({
          search: createdId,
          includeInactive: true,
          page: 1,
        });
        if (!query) throw new Error("invalid exact-code query");
        const response = await fetch(`/api/admin/catalog/collaborators?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const list =
          response.status === 200
            ? projectCollaboratorListForQuery(await response.json(), {
                search: createdId,
                includeInactive: true,
                page: 1,
              })
            : null;
        if (!list || !collaboratorListConfirmsId(list, createdId)) {
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
        notify.error({
          title: "Không nhận được phản hồi. Có thể thử lại đúng thao tác với cùng khóa idempotency.",
        });
        return;
      }
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const outcome = classifyCollaboratorMutation(response.status, payload);
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
      if (outcome.kind === "not-found" && intent.collaboratorId !== null) {
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
    const idempotencyKey = newCollaboratorIntentKey();
    let request;
    let intent: MutationIntent;
    if (dialog.kind === "create") {
      request = buildCollaboratorCreateRequest({
        collaboratorId: form.collaboratorId,
        displayName: form.displayName,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: "/api/admin/catalog/collaborators",
        method: "POST",
        operation: "create",
        collaboratorId: null,
        lockId: "create",
        body: request.body,
        retry: false,
      };
    } else if (dialog.kind === "edit") {
      request = buildCollaboratorUpdateRequest({
        displayName: form.displayName,
        expectedVersion: dialog.collaborator.version,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: `/api/admin/catalog/collaborators/${encodeURIComponent(dialog.collaborator.collaborator_id)}`,
        method: "PATCH",
        operation: "update",
        collaboratorId: dialog.collaborator.collaborator_id,
        lockId: dialog.collaborator.collaborator_id,
        body: request.body,
        retry: false,
      };
    } else {
      request = buildCollaboratorSetActiveRequest({
        active: dialog.active,
        expectedVersion: dialog.collaborator.version,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: `/api/admin/catalog/collaborators/${encodeURIComponent(dialog.collaborator.collaborator_id)}/active`,
        method: "POST",
        operation: "set-active",
        collaboratorId: dialog.collaborator.collaborator_id,
        lockId: dialog.collaborator.collaborator_id,
        body: request.body,
        retry: false,
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
    <div className="space-y-4">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Danh mục cộng tác viên</h1>
          <p className="mt-1 text-sm text-muted">
            Quản lý thông tin hiển thị và trạng thái cộng tác viên (CTV).
          </p>
        </div>
        <FormDialog
          open={dialog?.kind === "create" || dialog?.kind === "edit" || dialog?.kind === "active"}
          onOpenChange={(open) => {
            if (!open && !busy && !conflictIntent) setDialog(null);
          }}
          onCloseAutoFocus={(event) => {
            if (busy || conflictIntent) event.preventDefault();
          }}
          descriptionId="collaborator-dialog-description"
          closeDisabled={busy || conflictIntent !== null}
          title={
            dialog?.kind === "create"
              ? "Thêm cộng tác viên"
              : dialog?.kind === "edit"
                ? "Chỉnh sửa cộng tác viên"
                : dialog?.active
                  ? "Kích hoạt cộng tác viên"
                  : "Ngừng hoạt động cộng tác viên"
          }
          description="Lý do thao tác không bắt buộc; mã cộng tác viên không thể thay đổi sau khi tạo."
          trigger={
            <button
              type="button"
              onClick={startCreate}
              disabled={busy || conflictIntent !== null || pendingIntent !== null || list === null}
              className={primaryButton}
            >
              Thêm cộng tác viên
            </button>
          }
        >
          {pendingIntent?.retry &&
          (dialog?.kind === "create"
            ? pendingIntent.lockId === "create"
            : dialog && "collaborator" in dialog && pendingIntent.lockId === dialog.collaborator.collaborator_id) ? (
            <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
              <p>Thử lại đúng thao tác với cùng khóa idempotency.</p>
              <button
                type="button"
                disabled={busy}
                className={`${button} mt-2`}
                onClick={() => void sendIntent(pendingIntent)}
              >
                Thử lại thao tác
              </button>
            </Alert>
          ) : null}
          {conflictIntent &&
          dialog &&
          conflictIntent.lockId ===
            (dialog.kind === "create" ? "create" : dialog.collaborator.collaborator_id) ? (
            <ConflictReload
              message={conflictError}
              busy={busy}
              onReload={() =>
                void reloadAuthoritative(conflictIntent).then((ok) => {
                  if (ok) notify.success({ title: "Đã tải dữ liệu mới nhất từ máy chủ." });
                })
              }
            />
          ) : null}
          {dialog?.kind === "active" ? (
            <div className="mt-5 space-y-4">
              <p>
                Bạn sắp {dialog.active ? "kích hoạt" : "ngừng hoạt động"} cộng tác viên{" "}
                <strong>{dialog.collaborator.display_name}</strong> (
                {dialog.collaborator.collaborator_id}). Thao tác này không xóa dữ liệu hay lịch sử.
              </p>
              <form onSubmit={submit} className="space-y-4">
                <ReasonField
                  value={form.reason}
                  onChange={(value) => changeForm("reason", value)}
                />
                {formError ? (
                  <p role="alert" className="text-sm text-red-700">
                    {formError}
                  </p>
                ) : null}
                <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                  <button
                    type="button"
                    disabled={busy || conflictIntent !== null}
                    onClick={() => setDialog(null)}
                    className={button}
                  >
                    Hủy
                  </button>
                  <button
                    type="submit"
                    disabled={busy || pendingIntent !== null || conflictIntent !== null}
                    className={primaryButton}
                  >
                    {busy ? "Đang lưu…" : dialog.active ? "Xác nhận kích hoạt" : "Xác nhận ngừng"}
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <form onSubmit={submit} className="mt-5 space-y-4">
              {dialog?.kind === "create" ? (
                <Field
                  id="collaborator-id"
                  label="Mã cộng tác viên"
                  value={form.collaboratorId}
                  maxLength={128}
                  required
                  onChange={(value) => changeForm("collaboratorId", value)}
                />
              ) : (
                <div className="text-sm">
                  <span className="font-medium text-foreground">Mã cộng tác viên</span>
                  <p className="mt-1 text-muted">
                    {dialog?.kind === "edit" ? dialog.collaborator.collaborator_id : "—"}
                  </p>
                  <span className="mt-1 block text-xs text-muted">
                    Mã không thể thay đổi sau khi tạo.
                  </span>
                </div>
              )}
              <Field
                id="collaborator-name"
                label="Tên cộng tác viên"
                value={form.displayName}
                maxLength={256}
                required
                onChange={(value) => changeForm("displayName", value)}
              />
              <ReasonField value={form.reason} onChange={(value) => changeForm("reason", value)} />
              {formError ? (
                <p role="alert" className="text-sm text-red-700">
                  {formError}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
                <button
                  type="button"
                  disabled={busy || conflictIntent !== null}
                  onClick={() => setDialog(null)}
                  className={button}
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  disabled={busy || pendingIntent !== null || conflictIntent !== null}
                  className={primaryButton}
                >
                  {busy
                    ? "Đang lưu…"
                    : dialog?.kind === "create"
                      ? "Tạo cộng tác viên"
                      : "Lưu thay đổi"}
                </button>
              </div>
            </form>
          )}
        </FormDialog>
      </header>

      {pendingIntent?.retry && dialog === null ? (
        <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
          <p>Thử lại cùng thao tác với cùng khóa idempotency.</p>
          <button
            type="button"
            disabled={busy}
            className={`${button} mt-2`}
            onClick={() => void sendIntent(pendingIntent)}
          >
            Thử lại thao tác
          </button>
        </Alert>
      ) : null}
      {conflictIntent && dialog === null ? (
        <ConflictReload
          message={conflictError}
          busy={busy}
          onReload={() =>
            void reloadAuthoritative(conflictIntent).then((ok) => {
              if (ok) notify.success({ title: "Đã tải dữ liệu mới nhất từ máy chủ." });
            })
          }
        />
      ) : null}

      <Card>
        <CardHeader
          title="Danh sách cộng tác viên"
          description={
            list ? `${list.total} cộng tác viên phù hợp` : "Tìm kiếm và lọc danh mục cộng tác viên."
          }
        />
        <form
          className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]"
          onSubmit={(event) => {
            event.preventDefault();
            const query = buildCollaboratorListQuery({
              search: searchInput,
              includeInactive,
              page: 1,
            });
            if (!query) {
              setListState({ kind: "error" });
              return;
            }
            setPage(1);
            setSearch(searchInput.trim());
            setListState({ kind: "loading" });
          }}
        >
          <label className="flex flex-col gap-1 text-sm font-medium">
            Tìm kiếm
            <input
              value={searchInput}
              maxLength={256}
              onChange={(event) => setSearchInput(event.target.value)}
              className="min-h-11 sm:min-h-10 rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </label>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(event) => {
                setIncludeInactive(event.target.checked);
                setPage(1);
                setListState({ kind: "loading" });
              }}
            />
            Bao gồm cộng tác viên ngừng hoạt động
          </label>
          <button type="submit" className={`${button} min-h-11 sm:min-h-10 self-end`}>
            Tìm kiếm
          </button>
        </form>

        {listState.kind === "loading" ? (
          <p role="status" className="py-8 text-center text-sm text-muted">
            Đang tải danh sách cộng tác viên…
          </p>
        ) : null}
        {listState.kind === "denied" ? (
          <ErrorState title="Không có quyền xem danh mục cộng tác viên" />
        ) : null}
        {listState.kind === "unavailable" ? (
          <div className="space-y-3">
            <ErrorState title="Dịch vụ danh mục cộng tác viên hiện không khả dụng" />
            <button type="button" className={button} onClick={reloadList}>
              Thử tải lại
            </button>
          </div>
        ) : null}
        {listState.kind === "error" ? (
          <div className="space-y-3">
            <ErrorState
              title="Không tải được danh sách cộng tác viên"
              detail="Phản hồi không hợp lệ. Hãy thử tải lại."
            />
            <button type="button" className={button} onClick={reloadList}>
              Thử tải lại
            </button>
          </div>
        ) : null}
        {list ? (
          list.items.length === 0 ? (
            <EmptyState
              title="Chưa có cộng tác viên phù hợp"
              description="Thay đổi bộ lọc hoặc thêm cộng tác viên mới."
            />
          ) : (
            <>
              <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-2xs">
                <table className="r22-card-table w-full border-collapse text-left text-sm">
                  <caption className="sr-only">Danh sách cộng tác viên và trạng thái</caption>
                  <thead className="border-b border-border bg-surface-muted text-xs uppercase text-muted">
                    <tr>
                      <th scope="col" className="px-3 py-3">
                        Mã cộng tác viên
                      </th>
                      <th scope="col" className="px-3 py-3">
                        Tên cộng tác viên
                      </th>
                      <th scope="col" className="px-3 py-3">
                        Trạng thái
                      </th>
                      <th scope="col" className="px-3 py-3 text-right">
                        Thao tác
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((collaborator) => {
                      const locked = busy || pendingIntent !== null || conflictIntent !== null;
                      return (
                        <tr
                          key={collaborator.collaborator_id}
                          className="border-b border-border/70 last:border-0 hover:bg-surface-hover"
                        >
                          <td data-card-header="true" className="px-3 py-3 font-mono text-xs">
                            {collaborator.collaborator_id}
                          </td>
                          <td data-label="Tên cộng tác viên" className="px-3 py-3 font-medium">
                            {collaborator.display_name}
                          </td>
                          <td data-label="Trạng thái" className="px-3 py-3">
                            <ActiveBadge active={collaborator.active} />
                          </td>
                          <td data-card-actions="true" className="px-3 py-3">
                            <div className="flex flex-wrap justify-end gap-2 whitespace-nowrap">
                              <button
                                type="button"
                                className={`${button} min-h-11 md:min-h-8 whitespace-nowrap shrink-0`}
                                disabled={locked}
                                onClick={() => startEdit(collaborator)}
                              >
                                Chỉnh sửa
                              </button>
                              <button
                                type="button"
                                className={`${button} min-h-11 md:min-h-8 whitespace-nowrap shrink-0`}
                                disabled={locked}
                                onClick={() => startActive(collaborator, !collaborator.active)}
                              >
                                {collaborator.active ? "Ngừng" : "Kích hoạt"}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <OffsetPager
                page={page}
                pageCount={pageCount}
                total={list.total}
                ariaLabel="Phân trang danh sách cộng tác viên"
                previousLabel="Trang trước"
                nextLabel="Trang sau"
                onPageChange={(nextPage) => {
                  setPage(nextPage);
                  setListState({ kind: "loading" });
                }}
              />
            </>
          )
        ) : null}
      </Card>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  maxLength,
  required,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  required: boolean;
  onChange(value: string): void;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm font-medium">
      {label}
      <input
        id={id}
        type="text"
        value={value}
        maxLength={maxLength}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 rounded-md border border-border bg-surface px-3 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
      />
    </label>
  );
}

function ReasonField({
  value,
  onChange,
}: {
  value: string;
  onChange(value: string): void;
}) {
  return (
    <label htmlFor="collaborator-reason" className="flex flex-col gap-1 text-sm font-medium">
      Lý do thay đổi (không bắt buộc)
      <textarea
        id="collaborator-reason"
        value={value}
        maxLength={4000}
        rows={3}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-border bg-surface px-3 py-2 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      />
    </label>
  );
}

function ConflictReload({
  message,
  busy,
  onReload,
}: {
  message: string | null;
  busy: boolean;
  onReload(): void;
}) {
  return (
    <Alert tone="warning" title="Cần tải lại dữ liệu có thẩm quyền">
      <p>Thao tác đang bị khóa để tránh ghi đè thay đổi mới hơn.</p>
      {message ? <p role="alert">{message}</p> : null}
      <button
        type="button"
        disabled={busy}
        onClick={onReload}
        className="mt-2 inline-flex min-h-10 items-center rounded-md border border-current px-3 font-medium disabled:opacity-50"
      >
        {busy ? "Đang tải…" : "Tải lại dữ liệu"}
      </button>
    </Alert>
  );
}
