"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "radix-ui/dialog";

import { Alert } from "@/components/ui/alert";
import { Card, CardHeader } from "@/components/ui/card";
import { useNotify } from "@/components/ui/notify-provider";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import {
  buildAssignMembershipRequest,
  buildMembershipListQuery,
  buildTeamCatalogListQuery,
  buildUnassignMembershipRequest,
  beginMembershipReload,
  canAssignMembership,
  classifyMembershipMutation,
  finishMembershipReload,
  membershipNeedsAttention,
  membershipWorkflowEntry,
  membershipWorkflowLocked,
  MEMBERSHIP_PAGE_SIZE,
  newMembershipIntentKey,
  patchMembershipWorkflowEntry,
  projectActiveTeams,
  projectMembershipList,
  recordMembershipIntent,
  recordMembershipOutcome,
  type AdminTeam,
  type AdminTeamMembership,
  type AdminTeamMembershipList,
  type MembershipIntent,
  type MembershipWorkflow,
} from "@/lib/admin/team-membership-model";
import {
  projectPersonnelItem,
} from "@/lib/admin/personnel-catalog-model";
import type { AdminPersonnel } from "@/lib/direct-entry/personnel-catalog-contract";
import type { MembershipState } from "@/lib/direct-entry/team-membership-contract";

type ReadState<T> =
  | { kind: "loading" }
  | { kind: "loaded"; list: T }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
  | { kind: "not-found" }
  | { kind: "unavailable" }
  | { kind: "error" };

type MembershipLists = Record<MembershipState, ReadState<AdminTeamMembershipList>>;
type MembershipPages = Record<MembershipState, number>;
type TeamState =
  | { kind: "idle" | "loading" }
  | { kind: "loaded"; teams: readonly AdminTeam[]; total: number; page: number }
  | { kind: "unauthenticated" | "denied" | "not-found" | "unavailable" | "error" };

type Operation =
  | { kind: "assign" }
  | { kind: "move"; currentTeamId: string; expectedVersion: number; validTo: string | null }
  | { kind: "close"; membership: AdminTeamMembership };

type ScopedOperation = { recruiterId: string; value: Operation };
type ScopedForm = { recruiterId: string; value: typeof EMPTY_FORM };

const STATES: readonly MembershipState[] = ["CURRENT", "SCHEDULED", "HISTORY"];
const INITIAL_LISTS: MembershipLists = {
  CURRENT: { kind: "loading" },
  SCHEDULED: { kind: "loading" },
  HISTORY: { kind: "loading" },
};
const INITIAL_PAGES: MembershipPages = { CURRENT: 1, SCHEDULED: 1, HISTORY: 1 };
const EMPTY_FORM = { teamId: "", date: "", reason: "" };

function stateLabel(state: MembershipState): string {
  if (state === "CURRENT") return "Đang hiệu lực";
  if (state === "SCHEDULED") return "Đã lên lịch";
  return "Lịch sử";
}

function formatDate(value: string | null): string {
  if (!value) return "Không có ngày kết thúc";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

async function readMembershipList(
  recruiterId: string,
  state: MembershipState,
  page: number,
): Promise<ReadState<AdminTeamMembershipList>> {
  const query = buildMembershipListQuery(recruiterId, state, page);
  if (!query) return { kind: "error" };
  let response: Response;
  try {
    response = await fetch(`/api/admin/catalog/team-memberships?${query.toString()}`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    return { kind: "unavailable" };
  }
  if (response.status === 401) return { kind: "unauthenticated" };
  if (response.status === 403) return { kind: "denied" };
  if (response.status === 404) return { kind: "not-found" };
  if (response.status >= 500) return { kind: "unavailable" };
  if (response.status !== 200) return { kind: "error" };
  try {
    const list = projectMembershipList(await response.json(), { recruiterId, state, page });
    return list ? { kind: "loaded", list } : { kind: "error" };
  } catch {
    return { kind: "error" };
  }
}

function statusDescription(kind: Exclude<ReadState<unknown>, { kind: "loaded" | "loading" }>["kind"]): string {
  if (kind === "unauthenticated") return "Phiên đăng nhập không còn hiệu lực.";
  if (kind === "denied") return "Bạn không có quyền xem dữ liệu nhóm.";
  if (kind === "not-found") return "Dữ liệu không còn khả dụng.";
  if (kind === "unavailable") return "Dịch vụ hiện chưa khả dụng.";
  return "Phản hồi không hợp lệ; dữ liệu chưa được hiển thị.";
}

export function PersonnelTeamMembershipManager({
  personnel,
  onClose,
  onOpen,
  onConflictLock,
  onPersonnelReloaded,
  onPersonnelUnavailable,
}: {
  personnel: AdminPersonnel | null;
  onClose(): void;
  onOpen(personnel: AdminPersonnel, trigger: HTMLButtonElement): void;
  onConflictLock(recruiterId: string, locked: boolean): void;
  onPersonnelReloaded(personnel: AdminPersonnel): void;
  onPersonnelUnavailable(recruiterId: string): void;
}) {
  const [lists, setLists] = useState<MembershipLists>(INITIAL_LISTS);
  const [listsRecruiterId, setListsRecruiterId] = useState<string | null>(null);
  const [pages, setPages] = useState<MembershipPages>(INITIAL_PAGES);
  const [teamState, setTeamState] = useState<TeamState>({ kind: "idle" });
  const [operationState, setOperationState] = useState<ScopedOperation | null>(null);
  const [formState, setFormState] = useState<ScopedForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [workflow, setWorkflow] = useState<MembershipWorkflow>(new Map());
  const notify = useNotify();
  const generation = useRef(0);
  const recruiterId = personnel?.recruiter_id;
  const visibleLists = listsRecruiterId === recruiterId ? lists : INITIAL_LISTS;
  const visiblePages = listsRecruiterId === recruiterId ? pages : INITIAL_PAGES;
  const operation = operationState && operationState.recruiterId === recruiterId ? operationState.value : null;
  const form = formState && formState.recruiterId === recruiterId ? formState.value : EMPTY_FORM;
  const activeEntry = personnel ? membershipWorkflowEntry(workflow, personnel.recruiter_id) : null;
  const formError = activeEntry?.formError ?? null;
  const message = activeEntry?.message ?? null;
  const pendingIntent = activeEntry?.pendingIntent ?? null;
  const activeConflict = activeEntry?.reloadRequired
    ? { personnel: activeEntry.personnel, error: activeEntry.reloadError }
    : undefined;
  const locked = personnel ? membershipWorkflowLocked(activeEntry) : false;
  const otherAttentionEntries = Array.from(workflow.entries())
    .filter(([id, entry]) => id !== recruiterId && membershipNeedsAttention(entry));

  const setActiveWorkflow = useCallback((patch: Parameters<typeof patchMembershipWorkflowEntry>[2]) => {
    if (!personnel) return;
    setWorkflow((current) => patchMembershipWorkflowEntry(current, personnel, patch));
  }, [personnel]);

  const setActiveForm = useCallback((update: (value: typeof EMPTY_FORM) => typeof EMPTY_FORM) => {
    if (!recruiterId) return;
    setFormState((current) => ({
      recruiterId,
      value: update(current?.recruiterId === recruiterId ? current.value : EMPTY_FORM),
    }));
  }, [recruiterId]);

  const setActiveOperation = (value: Operation | null) => {
    if (!recruiterId) return;
    setOperationState(value ? { recruiterId, value } : null);
  };

  const lockEntity = useCallback((recruiterId: string, locked: boolean) => {
    onConflictLock(recruiterId, locked);
  }, [onConflictLock]);

  useEffect(() => {
    if (!recruiterId) return;
    const requestGeneration = ++generation.current;
    void Promise.all(STATES.map((state) => readMembershipList(recruiterId, state, 1)))
      .then((results) => {
        if (generation.current !== requestGeneration) return;
        setLists({
          CURRENT: results[0]!,
          SCHEDULED: results[1]!,
          HISTORY: results[2]!,
        });
        setListsRecruiterId(recruiterId);
        setPages(INITIAL_PAGES);
      });
    return () => {
      if (generation.current === requestGeneration) generation.current += 1;
    };
  }, [recruiterId]);

  const loadOneState = useCallback(async (state: MembershipState, page: number) => {
    if (!personnel) return;
    const recruiterId = personnel.recruiter_id;
    const requestGeneration = generation.current;
    setPages((current) => ({ ...current, [state]: page }));
    setLists((current) => ({ ...current, [state]: { kind: "loading" } }));
    const result = await readMembershipList(recruiterId, state, page);
    if (generation.current === requestGeneration) {
      setLists((current) => ({ ...current, [state]: result }));
    }
  }, [personnel]);

  const loadTeamPage = useCallback(async (page: number, append: boolean) => {
    const existingTeams = append && teamState.kind === "loaded" ? teamState.teams : [];
    const query = buildTeamCatalogListQuery(page);
    if (!query) {
      setTeamState({ kind: "error" });
      return;
    }
    setTeamState({ kind: "loading" });
    let response: Response;
    try {
      response = await fetch(`/api/admin/catalog/teams?${query.toString()}`, {
        method: "GET",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
    } catch {
      setTeamState({ kind: "unavailable" });
      return;
    }
    if (response.status === 401) return setTeamState({ kind: "unauthenticated" });
    if (response.status === 403) return setTeamState({ kind: "denied" });
    if (response.status === 404) return setTeamState({ kind: "not-found" });
    if (response.status >= 500) return setTeamState({ kind: "unavailable" });
    if (response.status !== 200) return setTeamState({ kind: "error" });
    try {
      const list = projectActiveTeams(await response.json(), page);
      if (!list) return setTeamState({ kind: "error" });
      const byId = new Map(existingTeams.map((team) => [team.team_id, team]));
      for (const team of list.teams) byId.set(team.team_id, team);
      setTeamState({ kind: "loaded", teams: Array.from(byId.values()), total: list.total, page });
    } catch {
      setTeamState({ kind: "error" });
    }
  }, [teamState]);

  const ensureTeams = useCallback(() => {
    if (teamState.kind === "idle" || teamState.kind === "unavailable" ||
        teamState.kind === "error" || teamState.kind === "not-found") {
      void loadTeamPage(1, false);
    }
  }, [loadTeamPage, teamState.kind]);

  const refreshAuthoritative = useCallback(async (
    recruiterId: string,
    requestGeneration: number,
  ): Promise<{ detail: "loaded" | "not-found" | "failed"; listsLoaded: boolean }> => {
    setListsRecruiterId(null);
    setLists({ CURRENT: { kind: "loading" }, SCHEDULED: { kind: "loading" }, HISTORY: { kind: "loading" } });
    setPages(INITIAL_PAGES);
    const detailPromise = (async () => {
      try {
        const response = await fetch(
          `/api/admin/catalog/personnel/${encodeURIComponent(recruiterId)}`,
          { method: "GET", cache: "no-store", headers: { Accept: "application/json" } },
        );
        if (response.status === 404) return { kind: "not-found" as const };
        if (response.status === 401) return { kind: "unauthenticated" as const };
        if (response.status === 403) return { kind: "denied" as const };
        if (response.status !== 200) return { kind: "error" as const };
        const authoritative = projectPersonnelItem(await response.json());
        return authoritative?.recruiter_id === recruiterId
          ? { kind: "loaded" as const, personnel: authoritative }
          : { kind: "error" as const };
      } catch {
        return { kind: "error" as const };
      }
    })();
    const listPromise = Promise.all(STATES.map((state) => readMembershipList(recruiterId, state, 1)));
    const [detail, results] = await Promise.all([detailPromise, listPromise]);
    if (generation.current !== requestGeneration) return { detail: "failed", listsLoaded: false };
    const nextLists: MembershipLists = {
      CURRENT: results[0]!,
      SCHEDULED: results[1]!,
      HISTORY: results[2]!,
    };
    setListsRecruiterId(recruiterId);
    setLists(nextLists);
    if (detail.kind === "loaded") onPersonnelReloaded(detail.personnel);
    if (detail.kind === "not-found") {
      setLists({
        CURRENT: { kind: "not-found" },
        SCHEDULED: { kind: "not-found" },
        HISTORY: { kind: "not-found" },
      });
      return { detail: "not-found", listsLoaded: false };
    }
    return {
      detail: detail.kind === "loaded" ? "loaded" : "failed",
      listsLoaded: results.every((result) => result.kind === "loaded"),
    };
  }, [onPersonnelReloaded]);

  const reloadConflictedPersonnel = useCallback(async (recruiterId: string) => {
    const entry = membershipWorkflowEntry(workflow, recruiterId);
    if (!entry?.reloadRequired) return;
    setWorkflow((current) => beginMembershipReload(current, recruiterId));
    setBusy(true);
    const requestGeneration = generation.current;
    try {
      const result = await refreshAuthoritative(recruiterId, requestGeneration);
      if (generation.current !== requestGeneration) return;
      setWorkflow((current) => finishMembershipReload(current, recruiterId, result).workflow);
      if (result.detail === "not-found") {
        lockEntity(recruiterId, false);
        onPersonnelUnavailable(recruiterId);
        notify.warning({ title: "Hồ sơ nhân sự không còn tồn tại hoặc không còn khả dụng." });
        return;
      }
      if (result.detail === "loaded" && result.listsLoaded) {
        lockEntity(recruiterId, false);
        notify.info({ title: "Đã tải lại hồ sơ và các phân công." });
      } else {
        notify.error({ title: "Chưa tải đủ hồ sơ và các phân công. Hãy tải lại trước khi tiếp tục." });
      }
    } finally {
      setBusy(false);
    }
  }, [lockEntity, notify, onPersonnelUnavailable, refreshAuthoritative, workflow]);

  const sendIntent = useCallback(async (intent: MembershipIntent) => {
    setBusy(true);
    lockEntity(intent.recruiterId, true);
    setWorkflow((current) => patchMembershipWorkflowEntry(current, intent.personnel, {
      formError: null,
      message: null,
    }));
    let response: Response;
    try {
      response = await fetch(intent.url, {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": intent.idempotencyKey,
        },
        body: JSON.stringify(intent.body),
      });
    } catch {
      const unavailableMsg = "Không nhận được phản hồi. Có thể thử lại cùng thao tác và khóa.";
      setWorkflow((current) => recordMembershipOutcome(current, intent, {
        kind: "unavailable",
        message: unavailableMsg,
      }));
      notify.warning({ title: unavailableMsg });
      setBusy(false);
      return;
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const outcome = classifyMembershipMutation(
      response.status,
      payload,
      intent.recruiterId,
      intent.operation,
    );
    setWorkflow((current) => recordMembershipOutcome(current, intent, outcome));
    if (outcome.kind === "conflict") {
      lockEntity(intent.recruiterId, true);
      setOperationState((current) => current?.recruiterId === intent.recruiterId ? null : current);
      setFormState((current) => current?.recruiterId === intent.recruiterId ? null : current);
      notify.warning({ title: outcome.message });
      setBusy(false);
      return;
    }
    if (outcome.kind !== "applied") {
      if (outcome.kind !== "unavailable") lockEntity(intent.recruiterId, false);
      if (outcome.kind === "unavailable") {
        notify.warning({ title: outcome.message });
      } else {
        notify.error({ title: outcome.message });
      }
      setBusy(false);
      return;
    }
    lockEntity(intent.recruiterId, true);
    setWorkflow((current) => beginMembershipReload(current, intent.recruiterId));
    setOperationState((current) => current?.recruiterId === intent.recruiterId ? null : current);
    setFormState((current) => current?.recruiterId === intent.recruiterId ? null : current);
    const requestGeneration = generation.current;
    const refresh = await refreshAuthoritative(intent.recruiterId, requestGeneration);
    if (generation.current === requestGeneration) {
      setWorkflow((current) => finishMembershipReload(current, intent.recruiterId, refresh).workflow);
      if (refresh.detail === "not-found") {
        lockEntity(intent.recruiterId, false);
        onPersonnelUnavailable(intent.recruiterId);
        notify.warning({ title: "Hồ sơ nhân sự không còn tồn tại hoặc không còn khả dụng." });
      } else if (refresh.detail === "loaded" && refresh.listsLoaded) {
        lockEntity(intent.recruiterId, false);
        notify.success({ title: "Đã lưu thay đổi và cập nhật danh sách phân công." });
      } else {
        notify.error({ title: "Chưa tải đủ hồ sơ và các phân công. Hãy tải lại trước khi tiếp tục." });
      }
    }
    setBusy(false);
  }, [lockEntity, notify, onPersonnelUnavailable, refreshAuthoritative]);

  const startAssign = () => {
    if (!personnel || !canAssignMembership(visibleLists.CURRENT, visibleLists.SCHEDULED) || locked) return;
    setActiveOperation({ kind: "assign" });
    setActiveForm(() => EMPTY_FORM);
    setActiveWorkflow({ formError: null, message: null });
    ensureTeams();
  };

  const startMove = (membership: AdminTeamMembership) => {
    setActiveOperation({
      kind: "move",
      currentTeamId: membership.team_id,
      expectedVersion: membership.recruiter_version,
      validTo: membership.valid_to,
    });
    setActiveForm(() => EMPTY_FORM);
    setActiveWorkflow({ formError: null, message: null });
    ensureTeams();
  };

  const startClose = (membership: AdminTeamMembership) => {
    setActiveOperation({ kind: "close", membership });
    setActiveForm(() => EMPTY_FORM);
    setActiveWorkflow({ formError: null, message: null });
  };

  const submitOperation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setActiveWorkflow({ formError: null });
    if (!personnel || !operation) return;
    if (locked) {
      setActiveWorkflow({ formError: "Hồ sơ đang bị khóa cho đến khi tải lại dữ liệu có thẩm quyền." });
      return;
    }
    if (pendingIntent) {
      setActiveWorkflow({ formError: "Thao tác trước chưa có kết quả xác nhận. Hãy thử lại thao tác đó." });
      return;
    }
    const idempotencyKey = newMembershipIntentKey();
    const request = operation.kind === "close"
      ? buildUnassignMembershipRequest({
          recruiterId: personnel.recruiter_id,
          validTo: form.date,
          expectedVersion: operation.membership.recruiter_version,
          reason: form.reason,
          idempotencyKey,
        })
      : buildAssignMembershipRequest({
          recruiterId: personnel.recruiter_id,
          teamId: form.teamId,
          validFrom: form.date,
          expectedVersion: operation.kind === "move" ? operation.expectedVersion : personnel.version,
          reason: form.reason,
          idempotencyKey,
          move: operation.kind === "move",
        });
    if (!request.ok) {
      setActiveWorkflow({ formError: request.message });
      return;
    }
    const intent: MembershipIntent = {
      ...request.request,
      operation: operation.kind === "close" ? "unassign" : operation.kind,
      recruiterId: personnel.recruiter_id,
      personnel,
      retry: false,
    };
    setWorkflow((current) => recordMembershipIntent(current, intent));
    void sendIntent(intent);
  };

  const canAssign = canAssignMembership(visibleLists.CURRENT, visibleLists.SCHEDULED);
  const hasScheduledConflict = visibleLists.SCHEDULED.kind === "loaded"
    && visibleLists.SCHEDULED.list.memberships.length > 0;
  const showScheduledSection = hasScheduledConflict
    || (visibleLists.SCHEDULED.kind === "loaded" && visibleLists.SCHEDULED.list.total > 0)
    || (visibleLists.SCHEDULED.kind !== "loading" && visibleLists.SCHEDULED.kind !== "loaded");
  const visibleStates = STATES.filter((state) => state !== "SCHEDULED" || showScheduledSection);
  const activeListLock = locked;
  const closeDialog = () => {
    if (busy) return;
    setOperationState((value) => value?.recruiterId === recruiterId ? null : value);
    setFormState((value) => value?.recruiterId === recruiterId ? null : value);
    setActiveWorkflow({ message: null, formError: null });
    onClose();
  };

  return (
    <>
      {personnel ? (
        <Dialog.Root
          open
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
            <Dialog.Content
              onCloseAutoFocus={(event) => event.preventDefault()}
              aria-describedby="membership-dialog-description"
              className="fixed left-1/2 top-1/2 z-50 max-h-[92dvh] w-[min(64rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl focus:outline-none sm:p-6"
            >
              <header className="flex items-start justify-between gap-4">
                <div>
                  <Dialog.Title className="text-xl font-semibold">Quản lý nhóm</Dialog.Title>
                  <Dialog.Description id="membership-dialog-description" className="mt-1 text-sm text-muted">
                    {personnel.display_name}
                    {personnel.personnel_code ? ` · ${personnel.personnel_code}` : ""}
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <button type="button" aria-label="Đóng quản lý nhóm" disabled={busy}
                    className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
                    <span aria-hidden="true">×</span>
                  </button>
                </Dialog.Close>
              </header>

              {otherAttentionEntries.length > 0 ? (
                <div className="mt-4">
                  <Alert tone="warning" title="Có hồ sơ khác cần xử lý">
                    <p>Đóng cửa sổ này để mở lại đúng hồ sơ và tiếp tục thao tác đang chờ.</p>
                    <button type="button" disabled={busy} onClick={closeDialog}
                      className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium">
                      Đóng cửa sổ
                    </button>
                  </Alert>
                </div>
              ) : null}

              {activeConflict && busy ? (
                <div className="mt-4" role="status">
                  <Alert tone="info" title="Đang cập nhật danh sách">
                    {message ?? "Đang tải lại hồ sơ và các phân công…"}
                  </Alert>
                </div>
              ) : activeConflict ? (
                <div className="mt-4">
                  <Alert tone="warning" title="Cần tải lại dữ liệu trước khi tiếp tục">
                    {formError ? <p>{formError}</p> : null}
                    <p>{activeConflict.error ?? "Tải lại hồ sơ và cả ba nhóm phân công trước khi tiếp tục."}</p>
                    <button type="button" disabled={busy}
                      onClick={() => void reloadConflictedPersonnel(personnel.recruiter_id)}
                      className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50">
                      {busy ? "Đang tải…" : "Tải lại hồ sơ"}
                    </button>
                  </Alert>
                </div>
              ) : null}
              {pendingIntent?.retry ? (
                <div className="mt-4">
                  <Alert tone="warning" title="Thao tác chưa có kết quả xác nhận">
                    <p>Thử lại đúng thao tác này bằng cùng khóa idempotency.</p>
                    <button type="button" disabled={busy || pendingIntent.recruiterId !== personnel.recruiter_id}
                      onClick={() => {
                        setWorkflow((current) => recordMembershipIntent(current, pendingIntent));
                        void sendIntent(pendingIntent);
                      }}
                      className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium">
                      Thử lại thao tác
                    </button>
                  </Alert>
                </div>
              ) : null}

              <div className="mt-5 flex flex-wrap gap-2">
                {canAssign && personnel.active ? (
                  <button type="button" disabled={activeListLock}
                    onClick={startAssign}
                    className="min-h-11 whitespace-nowrap shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-50">
                    Gán nhóm
                  </button>
                ) : null}
                {!personnel.active && canAssign ? (
                  <p className="self-center text-sm text-muted">Hồ sơ ngừng hoạt động; chỉ có thể xem lịch sử hoặc đóng phân công hiện có.</p>
                ) : null}
              </div>

              {hasScheduledConflict ? (
                <div className="mt-4" role="status">
                  <Alert tone="warning" title="Lịch phân công tương lai cũ đang cản thao tác gán hoặc chuyển nhóm ngay">
                    <p>
                      Hồ sơ này còn lịch phân công tương lai từ giai đoạn trước (hiển thị ở mục Đã lên lịch để đối chiếu).
                      Luồng tự hủy lịch tương lai trên giao diện đã khóa theo chính sách hiệu lực tức thì (WP1/S1); vui lòng đối chiếu và xử lý lịch tồn đọng trước khi gán hoặc chuyển nhóm mới.
                    </p>
                  </Alert>
                </div>
              ) : null}

              <div className="mt-5 grid gap-4">
                {visibleStates.map((state) => (
                  <MembershipSection
                    key={state}
                    state={state}
                    readState={visibleLists[state]}
                    page={visiblePages[state]}
                    onPage={(page) => void loadOneState(state, page)}
                    onRetry={() => void loadOneState(state, visiblePages[state])}
                    onMove={personnel.active && state === "CURRENT" && !hasScheduledConflict
                      ? (membership) => startMove(membership) : undefined}
                    onClose={state === "CURRENT"
                      ? (membership) => startClose(membership) : undefined}
                    disabled={busy || activeListLock}
                  />
                ))}
              </div>

              {operation ? (
                <Card className="mt-5">
                  <CardHeader
                    title={operation.kind === "assign" ? "Gán nhóm"
                      : operation.kind === "move" ? "Chuyển nhóm" : "Bỏ gán nhóm"}
                    description="Lý do thao tác không bắt buộc. Dữ liệu được kiểm tra lại trước khi lưu thay đổi."
                  />
                  {operation.kind !== "close" ? (
                    <div className="mb-4">
                      {teamState.kind === "loading" ? <p role="status">Đang tải nhóm khả dụng…</p> : null}
                      {teamState.kind === "unauthenticated" || teamState.kind === "denied" ||
                        teamState.kind === "not-found" || teamState.kind === "unavailable" ||
                        teamState.kind === "error" ? (
                          <div className="space-y-2">
                            <Alert tone="error" title="Không thể tải danh sách nhóm">
                              {statusDescription(teamState.kind)}
                            </Alert>
                            <button type="button" onClick={() => void loadTeamPage(1, false)}
                              className="min-h-10 rounded-md border border-border px-3 text-sm">Thử tải lại nhóm</button>
                          </div>
                        ) : null}
                      {teamState.kind === "loaded" ? (
                        <div className="flex flex-wrap items-center gap-3">
                          <p className="text-sm text-muted" role="status">
                            Đang hiển thị {teamState.teams.length} nhóm đang hoạt động.
                          </p>
                          {teamState.teams.length === 0 ? (
                            <p role="status" className="text-sm">Không có nhóm đang hoạt động để chọn.</p>
                          ) : null}
                          {teamState.teams.length < teamState.total ? (
                            <button type="button" onClick={() => void loadTeamPage(teamState.page + 1, true)}
                              className="min-h-10 rounded-md border border-border px-3 text-sm">
                              Tải thêm nhóm
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <form onSubmit={submitOperation} className="space-y-4">
                    {operation.kind === "move" && operation.validTo ? (
                      <p className="text-sm text-muted">
                        Phân công hiện tại kết thúc trước ngày {formatDate(operation.validTo)}.
                        Chọn ngày chuyển trong khoảng còn hiệu lực. Phân công mới không có ngày kết thúc,
                        cho đến khi chuyển nhóm hoặc bỏ gán tiếp theo; lịch khác trùng thời gian sẽ bị từ chối.
                      </p>
                    ) : null}
                    {operation.kind !== "close" ? (
                      <label htmlFor="membership-team" className="block text-sm font-medium">
                        Nhóm đang hoạt động <span aria-hidden="true">*</span>
                        <select id="membership-team" required value={form.teamId}
                          onChange={(event) => {
                            const teamId = event.currentTarget.value;
                            setActiveForm((value) => ({ ...value, teamId }));
                          }}
                          disabled={teamState.kind !== "loaded" || activeListLock}
                          className="mt-1 block min-h-11 w-full rounded-md border border-border bg-background px-3">
                          <option value="">Chọn nhóm</option>
                          {teamState.kind === "loaded" ? teamState.teams
                            .filter((team) => operation.kind !== "move" || team.team_id !== operation.currentTeamId)
                            .map((team) => <option key={team.team_id} value={team.team_id}>{team.display_name} ({team.code})</option>)
                            : null}
                        </select>
                      </label>
                    ) : (
                      <p className="text-sm">
                        {`Nhóm: ${operation.membership.team_display_name}. Hồ sơ vẫn được giữ; không có dữ liệu nào bị xóa.`}
                      </p>
                    )}
                    <div className="rounded-md border border-border bg-surface-muted/60 px-3 py-2 text-sm text-muted">
                      {operation.kind === "close"
                        ? "Có hiệu lực đến ngày: Áp dụng ngay theo ngày nghiệp vụ hệ thống"
                        : "Có hiệu lực từ ngày: Áp dụng ngay theo ngày nghiệp vụ hệ thống"}
                    </div>
                    <label htmlFor="membership-reason" className="block text-sm font-medium">
                      Lý do thao tác (không bắt buộc)
                      <textarea id="membership-reason" maxLength={4000} rows={3} value={form.reason}
                        onChange={(event) => {
                          const reason = event.currentTarget.value;
                          setActiveForm((value) => ({ ...value, reason }));
                        }}
                        className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2" />
                    </label>
                    {formError ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{formError}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                      <button type="button" disabled={busy} onClick={() => setActiveOperation(null)}
                        className="min-h-11 whitespace-nowrap shrink-0 rounded-md border border-border px-4 text-sm">Hủy thao tác</button>
                      <button type="submit"
                        disabled={busy || activeListLock || pendingIntent !== null ||
                          (operation.kind !== "close" && teamState.kind !== "loaded")}
                        className="min-h-11 whitespace-nowrap shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-50">
                        {busy ? "Đang xử lý…" : operation.kind === "assign" ? "Xác nhận gán"
                          : operation.kind === "move" ? "Xác nhận chuyển" : "Xác nhận bỏ gán"}
                      </button>
                    </div>
                  </form>
                </Card>
              ) : null}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}

      {personnel === null && Array.from(workflow.values()).some(membershipNeedsAttention) ? (
        <section aria-label="Phân công cần xử lý" className="space-y-3">
          {Array.from(workflow.entries())
            .filter(([, entry]) => membershipNeedsAttention(entry))
            .map(([pendingRecruiterId, entry]) => (
            <Alert key={pendingRecruiterId} tone="warning" title="Phân công cần xử lý">
              <p>{entry.personnel.display_name}: {entry.pendingIntent
                ? "thao tác chưa có kết quả xác nhận; hãy mở lại hồ sơ để thử lại cùng khóa."
                : "cần tải lại dữ liệu có thẩm quyền trước khi thao tác."}</p>
              <button type="button" onClick={(event) => onOpen(entry.personnel, event.currentTarget)}
                className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium">
                Mở quản lý nhóm
              </button>
            </Alert>
          ))}
        </section>
      ) : null}
    </>
  );
}

function MembershipSection({
  state,
  readState,
  page,
  onPage,
  onRetry,
  onMove,
  onClose,
  disabled,
}: {
  state: MembershipState;
  readState: ReadState<AdminTeamMembershipList>;
  page: number;
  onPage(page: number): void;
  onRetry(): void;
  onMove?: (membership: AdminTeamMembership) => void;
  onClose?: (membership: AdminTeamMembership) => void;
  disabled: boolean;
}) {
  const list = readState.kind === "loaded" ? readState.list : null;
  const pageCount = list
    ? Math.max(1, Math.ceil(list.total / MEMBERSHIP_PAGE_SIZE))
    : 1;
  return (
    <Card>
      <CardHeader
        title={stateLabel(state)}
        description={list ? `${list.total} mục phân công` : "Dữ liệu được tải riêng theo từng trạng thái."}
      />
      {readState.kind === "loading" ? <p role="status" className="py-5 text-sm">Đang tải {stateLabel(state).toLowerCase()}…</p> : null}
      {readState.kind === "unauthenticated" || readState.kind === "denied" ||
        readState.kind === "not-found" || readState.kind === "unavailable" ? (
          <div className="space-y-3">
            <Alert tone={readState.kind === "denied" || readState.kind === "unauthenticated" ? "error" : "warning"}
              title="Không thể đọc dữ liệu phân công">
              {statusDescription(readState.kind)}
            </Alert>
            <button type="button" onClick={onRetry} disabled={disabled}
              className="min-h-10 rounded-md border border-border px-3 text-sm">Thử tải lại</button>
          </div>
        ) : null}
      {readState.kind === "error" ? (
        <div className="space-y-3">
          <ErrorState title="Phản hồi dữ liệu phân công không hợp lệ" detail="Không hiển thị dữ liệu một phần." />
          <button type="button" onClick={onRetry} disabled={disabled}
            className="min-h-10 rounded-md border border-border px-3 text-sm">Thử tải lại</button>
        </div>
      ) : null}
      {list ? list.memberships.length === 0 ? (
        <EmptyState title={`Chưa có mục phân công ${stateLabel(state).toLowerCase()}.`} />
      ) : (
        <>
          <div role="region" aria-label={`Bảng ${stateLabel(state).toLowerCase()}`} tabIndex={0}
            className="overflow-x-auto rounded-xl border border-border bg-surface shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
            <table className="r22-card-table w-full min-w-[640px] border-collapse text-left text-sm">
              <caption className="sr-only">{stateLabel(state)} của hồ sơ</caption>
              <thead className="border-b border-border bg-surface-muted text-xs font-semibold uppercase tracking-wider text-muted"><tr>
                <th scope="col" className="px-3.5 py-3">Nhóm</th>
                <th scope="col" className="px-3.5 py-3">Hiệu lực từ</th>
                <th scope="col" className="px-3.5 py-3">Hiệu lực đến</th>
                <th scope="col" className="px-3.5 py-3">Trạng thái</th>
                {state === "CURRENT" ? <th scope="col" className="px-3.5 py-3 text-right">Thao tác</th> : null}
              </tr></thead>
              <tbody className="divide-y divide-border">
                {list.memberships.map((membership) => (
                  <tr key={membership.membership_id} className="transition-colors hover:bg-surface-hover">
                    <td data-card-header="true" className="px-3.5 py-2.5 font-medium">{membership.team_display_name}</td>
                    <td data-label="Hiệu lực từ" className="px-3.5 py-2.5 font-mono tabular-nums whitespace-nowrap">{formatDate(membership.valid_from)}</td>
                    <td data-label="Hiệu lực đến" className="px-3.5 py-2.5 font-mono tabular-nums whitespace-nowrap">{membership.valid_to ? formatDate(membership.valid_to) : "Chưa có ngày kết thúc"}</td>
                    <td data-label="Trạng thái" className="px-3.5 py-2.5">{membership.valid_to === membership.valid_from ? "Đã hủy lịch" : stateLabel(membership.state)}</td>
                    {state === "CURRENT" ? (
                      <td data-card-actions="true" className="px-3.5 py-2.5 text-right">
                        <div className="inline-flex flex-wrap md:flex-nowrap items-center justify-end gap-1.5 whitespace-nowrap">
                          {onMove ? <button type="button" disabled={disabled} onClick={() => onMove(membership)}
                            className="min-h-11 md:min-h-8 whitespace-nowrap shrink-0 rounded-md border border-border px-3 text-xs font-medium disabled:opacity-50">Chuyển nhóm</button> : null}
                          {onClose ? <button type="button" disabled={disabled} onClick={() => onClose(membership)}
                            className="min-h-11 md:min-h-8 whitespace-nowrap shrink-0 rounded-md border border-border px-3 text-xs font-medium disabled:opacity-50">Bỏ gán</button> : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">Trang {page} / {pageCount}</p>
            <div className="flex gap-2">
              <button type="button" disabled={disabled || page <= 1} onClick={() => onPage(page - 1)}
                className="min-h-10 rounded-md border border-border px-3 text-sm disabled:opacity-50">Trang trước</button>
              <button type="button" disabled={disabled || page >= pageCount} onClick={() => onPage(page + 1)}
                className="min-h-10 rounded-md border border-border px-3 text-sm disabled:opacity-50">Trang sau</button>
            </div>
          </div>
        </>
      ) : null}
    </Card>
  );
}
