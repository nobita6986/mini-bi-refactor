"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import * as Dialog from "radix-ui/dialog";

import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { useNotify } from "@/components/ui/notify-provider";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { TeamLeaderManager } from "@/components/admin/team-leader-manager";
import { useWp4WorkspaceGuard } from "@/components/admin/wp4-workspace-guard";
import {
  buildTeamCreateRequest,
  buildTeamListQuery,
  buildTeamSetActiveRequest,
  buildTeamUpdateRequest,
  classifyTeamMutation,
  newTeamIntentKey,
  projectTeamItem,
  projectTeamListForQuery,
  setTeamConflictLock,
  teamListConfirmsCode,
  teamConflictsForDialog,
  type TeamMutationOutcome,
} from "@/lib/admin/team-catalog-model";
import { buildRecruitmentTeamsQuery, DEPARTMENT_UI_MAX_SEARCH_LENGTH, projectRecruitmentTeamsEnvelope } from "@/lib/admin/department-ui-model";
import type { RecruitmentTeamProjection } from "@/lib/departments/department-contract";
import type {
  AdminTeam,
  AdminTeamList,
} from "@/lib/direct-entry/team-catalog-contract";

type ListState =
  | { kind: "loading" }
  | { kind: "loaded"; departmentId?: string; list: Pick<AdminTeamList, "total" | "page_size"> & { teams: readonly RecruitmentTeamProjection[] } }
  | { kind: "denied" }
  | { kind: "unavailable" }
  | { kind: "error" };

type DialogState =
  | { kind: "create" }
  | { kind: "edit"; team: RecruitmentTeamProjection }
  | { kind: "active"; team: RecruitmentTeamProjection; active: boolean };

type TeamForm = {
  code: string;
  displayName: string;
  reason: string;
};

type MutationIntent = {
  url: string;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
  operation: "create" | "update" | "set-active";
  teamId: string | null;
  lockId: string;
  retryState: "ready" | "retry";
};

type ConflictEntry = { intent: MutationIntent; error: string | null };

const EMPTY_FORM: TeamForm = { code: "", displayName: "", reason: "" };

function messageForOutcome(outcome: Exclude<TeamMutationOutcome, { kind: "applied" }>): string {
  return outcome.message;
}

function ActiveBadge({ active }: { active: boolean }) {
  return (
    <StatusBadge tone={active ? "success" : "neutral"} dot>
      {active ? "Đang hoạt động" : "Ngừng hoạt động"}
    </StatusBadge>
  );
}

export function TeamCatalogManager({
  departmentId,
  canManageCatalog = true,
  canManageTeamLeaders = false,
  onTeamMutated,
}: {
  departmentId?: string;
  canManageCatalog?: boolean;
  onTeamMutated?: () => Promise<boolean>;
  canManageTeamLeaders?: boolean;
} = {}) {
  const [listState, setListState] = useState<ListState>({ kind: "loading" });
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(Boolean(departmentId));
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [form, setForm] = useState<TeamForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [pendingIntent, setPendingIntent] = useState<MutationIntent | null>(null);
  const [conflictIntents, setConflictIntents] = useState<ReadonlyMap<string, ConflictEntry>>(new Map());
  const [busy, setBusy] = useState(false);
  const [conflictLocks, setConflictLocks] = useState<ReadonlySet<string>>(new Set());
  const [leaderLocks, setLeaderLocks] = useState<ReadonlySet<string>>(new Set());
  const [leaderTeam, setLeaderTeam] = useState<RecruitmentTeamProjection | null>(null);
  const notify = useNotify();
  const workspace = useWp4WorkspaceGuard();
  const sending = useRef(false);
  const list = listState.kind === "loaded" && listState.departmentId === departmentId ? listState.list : null;
  const canWrite = canManageCatalog && (!departmentId || list !== null);
  const formFrozen = busy || pendingIntent !== null;
  const dismissLocked = busy || (pendingIntent !== null && canWrite);

  const buildListQuery = departmentId ? buildRecruitmentTeamsQuery : buildTeamListQuery;
  useEffect(() => {
    const query = { search, includeInactive, page };
    const listQuery = buildListQuery(query);
    const endpoint = departmentId ? "/api/admin/departments/recruitment/teams" : "/api/admin/catalog/teams";
    if (!listQuery) return;
    const controller = new AbortController();
    void (async () => {
      let response: Response;
      try {
        response = await fetch(`${endpoint}?${listQuery.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
        setListState({ kind: "unavailable" });
        return;
      }
      if (controller.signal.aborted) return;
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
        const payload = await response.json();
        if (controller.signal.aborted) return;
        const list = departmentId
          ? projectRecruitmentTeamsEnvelope(payload, query, departmentId)
          : projectTeamListForQuery(payload, query);
        if (!list) {
          setListState({ kind: "error" });
          return;
        }
        const pages = Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size)));
        if (page > pages) {
          setPage(Math.min(1000, pages));
          return;
        }
        setListState({ kind: "loaded", departmentId, list });
      } catch {
        if (controller.signal.aborted) return;
        setListState({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [buildListQuery, departmentId, includeInactive, page, reloadToken, search]);

  const reloadList = () => {
    setListState({ kind: "loading" });
    setReloadToken((value) => value + 1);
  };

  const onLeaderLockChange = useCallback((teamId: string, locked: boolean) => {
    setLeaderLocks((current) => setTeamConflictLock(current, teamId, locked));
  }, []);

  const onLeaderTeamReloaded = useCallback((team: AdminTeam) => {
    setListState((current) => current.kind === "loaded"
      ? {
          ...current,
          list: {
            ...current.list,
            teams: current.list.teams.map((row) => row.team_id === team.team_id ? team : row),
          },
        }
      : current);
    setLeaderTeam((current) => current?.team_id === team.team_id ? team : current);
  }, []);

  const changeForm = useCallback(<K extends keyof TeamForm>(field: K, value: TeamForm[K]) => {
    if (formFrozen || sending.current) return;
    setForm((current) => ({ ...current, [field]: value }));
    setFormError(null);
  }, [formFrozen]);

  const startCreate = () => {
    if (!canWrite || formFrozen) return;
    setForm(EMPTY_FORM);
    setFormError(null);
    setDialog({ kind: "create" });
  };

  const startEdit = (team: RecruitmentTeamProjection) => {
    if (!canWrite || formFrozen) return;
    setForm({ code: team.code, displayName: team.display_name, reason: "" });
    setFormError(null);
    setDialog({ kind: "edit", team });
  };

  const startActiveChange = (team: RecruitmentTeamProjection, active: boolean) => {
    if (!canWrite || formFrozen) return;
    setForm({ ...EMPTY_FORM, reason: "" });
    setFormError(null);
    setDialog({ kind: "active", team, active });
  };

  const clearConflict = useCallback((lockId: string) => {
    setConflictLocks((current) => setTeamConflictLock(current, lockId, false));
    setConflictIntents((current) => {
      const next = new Map(current);
      next.delete(lockId);
      return next;
    });
  }, []);

  const reloadConflictedTeam = useCallback(async (intent: MutationIntent) => {
    const epoch = workspace.getEpoch();
    setConflictIntents((current) => {
      const next = new Map(current);
      const entry = next.get(intent.lockId);
      if (entry) next.set(intent.lockId, { ...entry, error: null });
      return next;
    });
    setBusy(true);
    try {
      if (intent.teamId) {
        const response = await fetch(
          `/api/admin/catalog/teams/${encodeURIComponent(intent.teamId)}`,
          { method: "GET", cache: "no-store", headers: { Accept: "application/json" } },
        );
        if (!workspace.isActive(epoch)) return;
        if (response.status === 404) {
          clearConflict(intent.lockId);
          if (onTeamMutated) void onTeamMutated();
          notify.warning({ title: "Nhóm không còn tồn tại hoặc không còn khả dụng. Danh sách đang được cập nhật." });
          setPendingIntent((current) => current?.lockId === intent.lockId ? null : current);
          setDialog((current) => current && (
            current.kind === "create" ? "create" : current.team.team_id
          ) === intent.lockId ? null : current);
          setListState({ kind: "loading" });
          setReloadToken((value) => value + 1);
          return;
        }
        if (response.status !== 200) throw new Error("reload");
        const team = projectTeamItem(await response.json());
        if (!workspace.isActive(epoch)) return;
        if (!team || team.team_id !== intent.teamId) throw new Error("reload");
        setListState((current) => current.kind === "loaded"
          ? {
              ...current,
              list: {
                ...current.list,
                teams: current.list.teams.map((row) =>
                  row.team_id === team.team_id ? team : row),
              },
            }
          : current);
      } else {
        const code = String(intent.body.code ?? "");
        const query = buildTeamListQuery({
          search: code,
          includeInactive: true,
          page: 1,
        });
        if (!query) throw new Error("reload");
        const response = await fetch(`/api/admin/catalog/teams?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const list = response.status === 200
          ? projectTeamListForQuery(await response.json(), {
              search: code,
              includeInactive: true,
              page: 1,
            })
          : null;
        if (!workspace.isActive(epoch)) return;
        if (!list || !teamListConfirmsCode(list, code)) {
          throw new Error("reload");
        }
      }
      if (onTeamMutated) void onTeamMutated();
      clearConflict(intent.lockId);
      notify.info({ title: "Đã tải dữ liệu mới nhất. Bạn có thể bắt đầu thao tác mới." });
      setPendingIntent((current) => current?.lockId === intent.lockId ? null : current);
      setDialog((current) => current && (
        current.kind === "create" ? "create" : current.team.team_id
      ) === intent.lockId ? null : current);
      setListState({ kind: "loading" });
      setReloadToken((value) => value + 1);
    } catch {
      if (!workspace.isActive(epoch)) return;
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
      if (workspace.isActive(epoch)) setBusy(false);
    }
  }, [clearConflict, notify, onTeamMutated, workspace]);

  const sendIntent = useCallback(async (intent: MutationIntent) => {
    if (!canWrite || sending.current) return;
    sending.current = true;
    const epoch = workspace.getEpoch();
    setPendingIntent(intent);
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
        if (!workspace.isActive(epoch)) return;
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
      if (!workspace.isActive(epoch)) return;
      const outcome = classifyTeamMutation(response.status, payload, intent.operation);
      if (outcome.kind === "applied") {
        setPendingIntent((current) => current?.lockId === intent.lockId ? null : current);
        setConflictIntents((current) => new Map(current).set(intent.lockId, { intent, error: null }));
        setConflictLocks((current) => setTeamConflictLock(current, intent.lockId, true));
        setForm(EMPTY_FORM);
        notify.success({ title: "Đã lưu thay đổi. Đang xác minh dữ liệu mới nhất." });
        await reloadConflictedTeam(intent);
        return;
      }
      if (outcome.kind === "conflict") {
        setPendingIntent(null);
        setConflictIntents((current) => new Map(current).set(intent.lockId, { intent, error: null }));
        setConflictLocks((current) => setTeamConflictLock(current, intent.lockId, true));
        notify.warning({ title: messageForOutcome(outcome) });
        return;
      }
      if (outcome.kind === "not-found" && intent.teamId !== null) {
        clearConflict(intent.lockId);
        if (onTeamMutated) void onTeamMutated();
        setPendingIntent((current) => current?.lockId === intent.lockId ? null : current);
        setDialog((current) => current && (
          current.kind === "create" ? "create" : current.team.team_id
        ) === intent.lockId ? null : current);
        notify.warning({ title: "Nhóm không còn tồn tại hoặc không còn khả dụng. Danh sách đang được cập nhật." });
        setListState({ kind: "loading" });
        setReloadToken((value) => value + 1);
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
      sending.current = false;
      if (workspace.isActive(epoch)) setBusy(false);
    }
  }, [canWrite, clearConflict, notify, onTeamMutated, reloadConflictedTeam, workspace]);

  const submitMutation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    if (!dialog || !canWrite || sending.current) return;
    if (isConflictLocked) {
      setFormError("Nhóm đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền.");
      return;
    }
    if (pendingIntent) {
      setFormError("Có thao tác chưa nhận được kết quả. Hãy thử lại thao tác đó trước.");
      return;
    }

    const idempotencyKey = newTeamIntentKey();
    let request;
    let intent: MutationIntent;
    if (dialog.kind === "create") {
      request = buildTeamCreateRequest({
        code: form.code,
        displayName: form.displayName,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: "/api/admin/catalog/teams",
        method: "POST",
        body: request.body,
        operation: "create",
        teamId: null,
        lockId: "create",
        retryState: "ready",
      };
    } else if (dialog.kind === "edit") {
      if (conflictLocks.has(dialog.team.team_id) || leaderLocks.has(dialog.team.team_id)) {
        setFormError("Nhóm đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền.");
        return;
      }
      request = buildTeamUpdateRequest({
        displayName: form.displayName,
        expectedVersion: dialog.team.version,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: `/api/admin/catalog/teams/${encodeURIComponent(dialog.team.team_id)}`,
        method: "PATCH",
        body: request.body,
        operation: "update",
        teamId: dialog.team.team_id,
        lockId: dialog.team.team_id,
        retryState: "ready",
      };
    } else {
      if (conflictLocks.has(dialog.team.team_id) || leaderLocks.has(dialog.team.team_id)) {
        setFormError("Nhóm đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền.");
        return;
      }
      request = buildTeamSetActiveRequest({
        active: dialog.active,
        expectedVersion: dialog.team.version,
        reason: form.reason,
        idempotencyKey,
      });
      if (!request.ok) {
        setFormError(request.message);
        return;
      }
      intent = {
        url: `/api/admin/catalog/teams/${encodeURIComponent(dialog.team.team_id)}/active`,
        method: "POST",
        body: request.body,
        operation: "set-active",
        teamId: dialog.team.team_id,
        lockId: dialog.team.team_id,
        retryState: "ready",
      };
    }
    void sendIntent(intent);
  };

  const pageCount = list
    ? Math.min(1000, Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))))
    : 1;
  const dialogLockId = dialog === null
    ? null
    : dialog.kind === "create"
      ? "create"
      : dialog.team.team_id;
  const isConflictLocked = dialogLockId !== null && conflictLocks.has(dialogLockId);

  return (
    <>
      <TeamLeaderManager
        team={leaderTeam}
        canManageLeaders={canManageTeamLeaders}
        teamOperationLocked={leaderTeam !== null &&
          (busy || conflictLocks.has(leaderTeam.team_id) ||
            (pendingIntent !== null && pendingIntent.lockId === leaderTeam.team_id))}
        onClose={() => setLeaderTeam(null)}
        onTeamReloaded={onLeaderTeamReloaded}
        onTeamUnavailable={(teamId) => {
          setLeaderTeam(null);
          setListState({ kind: "loading" });
          setReloadToken((value) => value + 1);
          setLeaderLocks((current) => setTeamConflictLock(current, teamId, false));
        }}
        onLockChange={onLeaderLockChange}
      />
    <Dialog.Root
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open && !dismissLocked && !sending.current) setDialog(null);
      }}
    >
      <div className="space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            {departmentId ? <h2 className="text-2xl font-semibold text-foreground">Tổ đội tuyển dụng</h2>
              : <h1 className="text-2xl font-semibold text-foreground">Danh mục Tổ đội tuyển dụng</h1>}
            <p className="mt-1 max-w-2xl text-sm text-muted">
              {canManageCatalog
                ? "Quản lý tổ đội, trưởng nhóm và phân công thành viên."
                : "Danh sách tổ đội trực thuộc Phòng Tuyển dụng."}
            </p>
          </div>
          {canWrite && <Dialog.Trigger asChild>
            <button
              type="button"
              onClick={startCreate}
              disabled={formFrozen || conflictLocks.has("create")}
              className="inline-flex min-h-11 whitespace-nowrap shrink-0 items-center rounded-md bg-primary px-4 text-sm font-medium text-on-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              Thêm nhóm
            </button>
          </Dialog.Trigger>}
          <Dialog.Portal>
            <Dialog.Overlay
              data-ui-overlay-motion="true"
              className="fixed inset-0 z-40 bg-[var(--backdrop)] backdrop-blur-[7px]"
            />
            <Dialog.Content
              data-ui-dialog-motion="true"
              onCloseAutoFocus={(event) => {
                if (busy) event.preventDefault();
              }}
              className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border border-t-2 border-t-primary bg-surface p-5 text-foreground shadow-[var(--shadow-dialog)] focus:outline-none sm:p-6"
              aria-describedby="team-dialog-description"
            >
              <div className="flex items-start justify-between gap-4 border-b border-border pb-3.5">
                <div>
                  <Dialog.Title className="text-xl font-semibold tracking-tight text-[var(--navy)]">
                    {dialog?.kind === "create" ? "Thêm tổ đội tuyển dụng" :
                      dialog?.kind === "edit" ? "Chỉnh sửa tổ đội tuyển dụng" :
                        dialog?.active ? "Kích hoạt tổ đội tuyển dụng" : "Ngừng hoạt động tổ đội"}
                  </Dialog.Title>
                  <Dialog.Description id="team-dialog-description" className="mt-1 text-sm text-muted">
                    Lý do thao tác không bắt buộc. Dữ liệu được kiểm tra lại trước khi lưu.
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="Đóng hộp thoại"
                    disabled={dismissLocked}
                    className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-muted text-sm font-medium text-[var(--navy)] transition-colors hover:border-primary hover:bg-surface hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 sm:size-10"
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </Dialog.Close>
              </div>

              {pendingIntent?.retryState === "retry" && pendingIntent.lockId === dialogLockId ? (
                <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
                  <p>Thử lại đúng thao tác này bằng cùng một khóa để tránh thay đổi trùng lặp.</p>
                  <button
                    type="button"
                    disabled={busy || !canWrite}
                    onClick={() => void sendIntent(pendingIntent)}
                    className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50"
                  >
                    Thử lại thao tác
                  </button>
                </Alert>
              ) : null}
              {teamConflictsForDialog(conflictIntents, dialogLockId).map(({ intent, error }) => (
                <ConflictReload
                  key={intent.lockId}
                  message={error}
                  busy={busy}
                  onReload={() => void reloadConflictedTeam(intent)}
                />
              ))}

              {dialog?.kind === "active" ? (
                <div className="mt-5 space-y-4">
                  <p>
                    {dialog.active ? "Bạn sắp kích hoạt tổ đội" : "Bạn sắp ngừng hoạt động tổ đội"}{" "}
                    <strong>{dialog.team.display_name}</strong> ({dialog.team.code}). Thao tác này
                    không xóa dữ liệu và lịch sử phân công vẫn đọc được.
                  </p>
                  <form onSubmit={submitMutation} className="space-y-4">
                    <ReasonField value={form.reason} readOnly={formFrozen} onChange={(value) => changeForm("reason", value)} />
                    {formError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{formError}</p> : null}
                    <DialogActions dismissLocked={dismissLocked} disabled={!canWrite || formFrozen || isConflictLocked}>
                      {busy ? "Đang lưu…" : dialog.active ? "Xác nhận kích hoạt" : "Xác nhận ngừng"}
                    </DialogActions>
                  </form>
                </div>
              ) : (
                <form onSubmit={submitMutation} className="mt-5 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {dialog?.kind === "create" ? (
                      <Field
                        id="team-code"
                        label="Mã nhóm"
                        value={form.code}
                        readOnly={formFrozen}
                        maxLength={128}
                        required
                        onChange={(value) => changeForm("code", value)}
                      />
                    ) : (
                      <div className="text-sm">
                        <span className="font-medium text-foreground">Mã nhóm</span>
                        <p className="mt-2 text-muted">
                          {dialog?.kind === "edit" ? dialog.team.code : "—"}
                        </p>
                        <span className="mt-1 block text-xs font-normal text-muted">
                          Mã nhóm không thay đổi sau khi tạo.
                        </span>
                      </div>
                    )}
                    <Field
                      id="team-name"
                      label="Tên hiển thị"
                      value={form.displayName}
                      readOnly={formFrozen}
                      maxLength={256}
                      required
                      onChange={(value) => changeForm("displayName", value)}
                    />
                  </div>
                  <ReasonField value={form.reason} readOnly={formFrozen} onChange={(value) => changeForm("reason", value)} />
                  {formError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{formError}</p> : null}
                  <DialogActions dismissLocked={dismissLocked} disabled={!canWrite || formFrozen || isConflictLocked}>
                    {busy ? "Đang lưu…" : dialog?.kind === "create" ? "Tạo nhóm" : "Lưu thay đổi"}
                  </DialogActions>
                </form>
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </header>

        {pendingIntent?.retryState === "retry" &&
        (dialog === null || pendingIntent.lockId !== dialogLockId) ? (
          <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
            <p>Thử lại cùng khóa thao tác để tránh tạo thay đổi trùng lặp.</p>
            <button
              type="button"
              disabled={busy || !canWrite}
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
              onReload={() => void reloadConflictedTeam(intent)}
            />
          ))
        ) : null}

        <Card>
          <CardHeader
            title="Danh sách nhóm"
            description={list ? `${list.total} nhóm phù hợp` : "Tìm kiếm và lọc danh mục nhóm."}
          />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const query = buildListQuery({ search: searchInput, includeInactive, page: 1 });
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
            <label htmlFor="team-search" className="min-w-0 flex-1 text-sm font-medium">
              Tìm theo tên hoặc mã nhóm
              <input
                id="team-search"
                value={searchInput}
                maxLength={departmentId ? DEPARTMENT_UI_MAX_SEARCH_LENGTH : 256}
                onChange={(event) => setSearchInput(event.currentTarget.value)}
                className="mt-1 block min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-base sm:text-sm"
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
              Hiển thị nhóm ngừng hoạt động
            </label>
            <button type="submit" className="min-h-11 sm:min-h-10 whitespace-nowrap shrink-0 rounded-md border border-border px-4 text-sm font-medium">
              Tìm kiếm
            </button>
          </form>

          {listState.kind === "loading" ? (
            <p role="status" className="py-8 text-center text-sm text-muted">Đang tải danh sách nhóm…</p>
          ) : null}
          {listState.kind === "denied" ? (
            <Alert tone="error" role="alert" title="Không có quyền xem danh sách">
              Tài khoản hiện tại không được phép xem danh mục nhóm.
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
              <ErrorState title="Không thể đọc dữ liệu nhóm" detail="Phản hồi không đúng hợp đồng API hoặc bộ lọc không hợp lệ." />
              <button type="button" onClick={reloadList} className="min-h-11 rounded-md border border-border px-4 text-sm">
                Thử tải lại
              </button>
            </div>
          ) : null}
          {list ? (
            list.teams.length === 0 ? (
              <EmptyState
                title="Không có tổ đội phù hợp"
                description="Thử đổi từ khóa hoặc bật hiển thị tổ đội ngừng hoạt động."
              />
            ) : (
              <>
                <div role="region" aria-label="Bảng danh sách tổ đội tuyển dụng" tabIndex={0} className="overflow-x-auto rounded-xl border border-border bg-surface shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                  <table className="r22-card-table w-full border-collapse text-left text-sm">
                    <caption className="sr-only">Danh sách tổ đội tuyển dụng</caption>
                    <thead className="border-b border-border bg-surface-muted text-xs font-semibold uppercase tracking-wider text-muted">
                      <tr>
                        <th scope="col" className="px-3.5 py-3 font-semibold">Tổ đội</th>
                        <th scope="col" className="px-3.5 py-3 font-semibold">Mã tổ đội</th>
                        <th scope="col" className="px-3.5 py-3 font-semibold">Trạng thái</th>
                        {canManageCatalog && <th scope="col" className="px-3.5 py-3 font-semibold text-right">Thao tác</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {list.teams.map((team) => (
                        <tr key={team.team_id} className="align-middle transition-colors hover:bg-surface-hover">
                          <td data-card-header="true" className="px-3.5 py-2.5 font-medium">{team.display_name}</td>
                          <td data-label="Mã tổ đội" className="px-3.5 py-2.5 font-mono text-xs">{team.code}</td>
                          <td data-label="Trạng thái" className="px-3.5 py-2.5"><ActiveBadge active={team.active} /></td>
                          {canManageCatalog && <td data-card-actions="true" className="px-3.5 py-2.5 text-right">
                            <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                              <Link
                                href={`/admin/catalog/personnel?team_id=${encodeURIComponent(team.team_id)}`}
                                className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-xs font-medium md:min-h-8"
                              >
                                Thành viên
                              </Link>
                              <Dialog.Trigger asChild>
                                <button
                                  type="button"
                                  onClick={() => startEdit(team)}
                                  disabled={formFrozen || conflictLocks.has(team.team_id) || leaderLocks.has(team.team_id)}
                                  className="min-h-11 md:min-h-8 whitespace-nowrap shrink-0 rounded-md border border-border px-3 text-xs font-medium disabled:opacity-50"
                                >
                                  Chỉnh sửa
                                </button>
                              </Dialog.Trigger>
                              <Dialog.Trigger asChild>
                                <button
                                  type="button"
                                  onClick={() => startActiveChange(team, !team.active)}
                                  disabled={formFrozen || conflictLocks.has(team.team_id) || leaderLocks.has(team.team_id)}
                                  className="min-h-11 md:min-h-8 whitespace-nowrap shrink-0 rounded-md border border-border px-3 text-xs font-medium disabled:opacity-50"
                                >
                                  {team.active ? "Ngừng hoạt động" : "Kích hoạt"}
                                </button>
                              </Dialog.Trigger>
                              <button
                                type="button"
                                onClick={() => setLeaderTeam(team)}
                                disabled={busy || conflictLocks.has(team.team_id) ||
                                  (pendingIntent !== null && pendingIntent.lockId === team.team_id)}
                                className="min-h-11 md:min-h-8 whitespace-nowrap shrink-0 rounded-md border border-border px-3 text-xs font-medium disabled:opacity-50"
                              >
                                Trưởng nhóm
                              </button>
                            </div>
                          </td>}
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
      </div>
    </Dialog.Root>
    </>
  );
}

function Field({
  id,
  label,
  value,
  maxLength,
  required = false,
  readOnly,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  maxLength?: number;
  required?: boolean;
  readOnly: boolean;
  onChange(value: string): void;
}) {
  return (
    <label htmlFor={id} className="block text-sm font-medium text-foreground">
      {label}
      <input
        id={id}
        type="text"
        value={value}
        maxLength={maxLength}
        required={required}
        readOnly={readOnly}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="mt-1 block min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm"
      />
    </label>
  );
}

function ReasonField({ value, readOnly, onChange }: { value: string; readOnly: boolean; onChange(value: string): void }) {
  return (
    <label htmlFor="team-reason" className="block text-sm font-medium text-foreground">
      Lý do thay đổi (không bắt buộc)
      <textarea
        id="team-reason"
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.currentTarget.value)}
        maxLength={4000}
        rows={3}
        className="mt-1 block w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
      />
    </label>
  );
}

function DialogActions({
  dismissLocked,
  disabled,
  children,
}: {
  dismissLocked: boolean;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
      <Dialog.Close asChild>
        <button type="button" disabled={dismissLocked} className="min-h-11 rounded-lg border border-border bg-surface px-4 text-sm font-medium text-[var(--navy)] hover:bg-surface-muted">
          Hủy
        </button>
      </Dialog.Close>
      <button
        type="submit"
        disabled={disabled}
        className="min-h-11 whitespace-nowrap shrink-0 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary shadow-2xs hover:bg-[var(--primary-hover)] disabled:opacity-50"
      >
        {children}
      </button>
    </div>
  );
}

function ConflictReload({ message, busy, onReload }: {
  message: string | null;
  busy: boolean;
  onReload(): void;
}) {
  return (
    <Alert tone="warning" title="Dữ liệu đã thay đổi. Cần tải lại trước khi tiếp tục.">
      <p>{message ?? "Tải lại nhóm có thẩm quyền trước khi bắt đầu thao tác mới."}</p>
      <button type="button" onClick={onReload} disabled={busy} className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50">
        {busy ? "Đang tải…" : "Tải lại nhóm"}
      </button>
    </Alert>
  );
}
