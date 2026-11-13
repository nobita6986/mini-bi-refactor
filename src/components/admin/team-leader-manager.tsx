"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import * as Dialog from "radix-ui/dialog";

import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { useNotify } from "@/components/ui/notify-provider";
import {
  buildTeamLeaderCandidateQuery,
  buildTeamLeaderDesignation,
  buildTeamLeaderListQuery,
  buildTeamLeaderRevocation,
  classifyTeamLeaderMutation,
  newTeamLeaderIntentKey,
  projectTeamLeaderCandidates,
  projectTeamLeaderList,
  projectTeamLeaderSnapshot,
  TEAM_LEADER_CANDIDATE_PAGE_SIZE,
  type TeamLeaderIntent,
} from "@/lib/admin/team-leader-model";
import type { AdminTeam } from "@/lib/direct-entry/team-catalog-contract";
import type {
  TeamLeaderCandidateList,
  TeamLeaderList,
  TeamLeaderState,
} from "@/lib/direct-entry/team-leader-contract";

type ReadState<T> =
  | { kind: "loading" }
  | { kind: "loaded"; value: T }
  | { kind: ReadErrorKind };
type LeaderLists = Record<TeamLeaderState, ReadState<TeamLeaderList>>;
type CandidateState =
  | { kind: "idle" | "loading" }
  | { kind: "loaded"; value: TeamLeaderCandidateList }
  | { kind: ReadErrorKind };
type ReadErrorKind = "unauthenticated" | "denied" | "not-found" | "unavailable" | "error";
type LeaderForm =
  | { kind: "designate" | "replace"; appUserId: string; effectiveDate: string; reason: string }
  | { kind: "revoke"; effectiveDate: string; reason: string };
type Workflow = {
  phase: "idle" | "sending" | "retry" | "reload" | "reload-error";
  intent: TeamLeaderIntent | null;
  message: string | null;
};

const STATES: readonly TeamLeaderState[] = ["CURRENT", "SCHEDULED", "HISTORY"];
const INITIAL_LISTS: LeaderLists = {
  CURRENT: { kind: "loading" },
  SCHEDULED: { kind: "loading" },
  HISTORY: { kind: "loading" },
};
const INITIAL_WORKFLOW: Workflow = { phase: "idle", intent: null, message: null };

function stateLabel(state: TeamLeaderState): string {
  if (state === "CURRENT") return "Hiện tại";
  if (state === "SCHEDULED") return "Đã lên lịch";
  return "Lịch sử";
}

function formatDate(value: string | null): string {
  if (!value) return "Không có ngày kết thúc";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function readFailure(status: number): ReadErrorKind {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "denied";
  if (status === 404) return "not-found";
  if (status >= 500) return "unavailable";
  return "error";
}

function readFailureMessage(kind: Exclude<CandidateState["kind"], "idle" | "loading" | "loaded">): string {
  if (kind === "unauthenticated") return "Phiên đăng nhập không còn hiệu lực.";
  if (kind === "denied") return "Bạn không có quyền xem dữ liệu trưởng nhóm.";
  if (kind === "not-found") return "Nhóm hoặc dữ liệu trưởng nhóm không còn khả dụng.";
  if (kind === "unavailable") return "Dịch vụ hiện chưa khả dụng.";
  return "Phản hồi không đúng hợp đồng; dữ liệu chưa được hiển thị.";
}

async function readLeaderList(
  teamId: string,
  state: TeamLeaderState,
  page: number,
  signal?: AbortSignal,
): Promise<ReadState<TeamLeaderList>> {
  const query = buildTeamLeaderListQuery(teamId, state, page);
  if (!query) return { kind: "error" };
  try {
    const response = await fetch(`/api/admin/catalog/team-leaders?${query.toString()}`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.status !== 200) return { kind: readFailure(response.status) };
    const value = projectTeamLeaderList(await response.json(), { teamId, state, page });
    return value ? { kind: "loaded", value } : { kind: "error" };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return { kind: "loading" };
    return { kind: "unavailable" };
  }
}

export function TeamLeaderManager({
  team,
  teamOperationLocked,
  onClose,
  onTeamReloaded,
  onTeamUnavailable,
  onLockChange,
}: {
  team: AdminTeam | null;
  teamOperationLocked: boolean;
  onClose(): void;
  onTeamReloaded(team: AdminTeam): void;
  onTeamUnavailable(teamId: string): void;
  onLockChange(teamId: string, locked: boolean): void;
}) {
  const teamId = team?.team_id ?? null;
  const [listTeamId, setListTeamId] = useState<string | null>(null);
  const [lists, setLists] = useState<LeaderLists>(INITIAL_LISTS);
  const [pages, setPages] = useState<Record<TeamLeaderState, number>>({
    CURRENT: 1, SCHEDULED: 1, HISTORY: 1,
  });
  const [selectedState, setActiveState] = useState<TeamLeaderState>("CURRENT");
  const [candidateSnapshot, setCandidateSnapshot] = useState<{
    key: string;
    state: CandidateState;
  } | null>(null);
  const [candidateSearch, setCandidateSearch] = useState("");
  const [candidateSearchInput, setCandidateSearchInput] = useState("");
  const [candidatePage, setCandidatePage] = useState(1);
  const [candidateReloadToken, setCandidateReloadToken] = useState(0);
  const [form, setForm] = useState<LeaderForm | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<ReadonlyMap<string, Workflow>>(new Map());
  const [busyTeam, setBusyTeam] = useState<string | null>(null);
  const notify = useNotify();
  const generation = useRef(0);
  const visibleLists = listTeamId === teamId ? lists : INITIAL_LISTS;
  const workflow = teamId ? workflows.get(teamId) ?? INITIAL_WORKFLOW : INITIAL_WORKFLOW;
  const candidateEnabled = form !== null && form.kind !== "revoke";
  const candidateQuery = teamId && candidateEnabled
    ? buildTeamLeaderCandidateQuery(teamId, candidateSearch, candidatePage) : null;
  const candidateQueryString = candidateQuery?.toString() ?? null;
  const candidateKey = `${teamId ?? ""}:${candidateSearch}:${candidatePage}:${candidateReloadToken}`;
  const candidateState: CandidateState = !candidateEnabled
    ? { kind: "idle" }
    : !candidateQuery
      ? { kind: "error" }
      : candidateSnapshot?.key === candidateKey
        ? candidateSnapshot.state : { kind: "loading" };
  const currentList = visibleLists.CURRENT.kind === "loaded" ? visibleLists.CURRENT.value : null;
  const currentLeaders = currentList?.leaders ?? [];
  const scheduledList = visibleLists.SCHEDULED.kind === "loaded" ? visibleLists.SCHEDULED.value : null;
  const hasScheduledLeaders = (scheduledList?.leaders.length ?? 0) > 0;
  const showScheduledState = hasScheduledLeaders
    || (scheduledList?.total ?? 0) > 0
    || (visibleLists.SCHEDULED.kind !== "loading" && visibleLists.SCHEDULED.kind !== "loaded");
  const visibleStates = STATES.filter((state) => state !== "SCHEDULED" || showScheduledState);
  const activeState: TeamLeaderState = selectedState === "SCHEDULED" && !showScheduledState
    ? "CURRENT"
    : selectedState;
  const activeReadError = visibleLists[activeState].kind;
  const activeList = visibleLists[activeState].kind === "loaded"
    ? visibleLists[activeState].value : null;

  const updateWorkflow = useCallback((id: string, value: Workflow) => {
    setWorkflows((current) => {
      const next = new Map(current);
      if (value.phase === "idle" && value.intent === null && value.message === null) next.delete(id);
      else next.set(id, value);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!teamId) return;
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    void Promise.all(STATES.map((state) => readLeaderList(teamId, state, 1, controller.signal)))
      .then((results) => {
        if (generation.current !== requestGeneration || controller.signal.aborted) return;
        setListTeamId(teamId);
        setLists({
          CURRENT: results[0]!, SCHEDULED: results[1]!, HISTORY: results[2]!,
        });
        setPages({ CURRENT: 1, SCHEDULED: 1, HISTORY: 1 });
        setActiveState("CURRENT");
      });
    return () => {
      controller.abort();
      if (generation.current === requestGeneration) generation.current += 1;
    };
  }, [teamId]);

  useEffect(() => {
    if (!teamId || !candidateEnabled || !candidateQueryString) return;
    let cancelled = false;
    void fetch(`/api/admin/catalog/team-leader-candidates?${candidateQueryString}`, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    }).then(async (response) => {
      if (response.status !== 200) return { kind: readFailure(response.status) } as const;
      const value = projectTeamLeaderCandidates(await response.json(), candidatePage);
      return value ? { kind: "loaded", value } as const : { kind: "error" } as const;
    }).catch(() => ({ kind: "unavailable" }) as const)
      .then((result) => {
        if (!cancelled) setCandidateSnapshot({ key: candidateKey, state: result });
      });
    return () => { cancelled = true; };
  }, [candidateEnabled, candidateKey, candidatePage, candidateQueryString, candidateSearch, teamId]);

  const loadPage = useCallback(async (state: TeamLeaderState, page: number) => {
    if (!teamId) return;
    const requestGeneration = generation.current;
    setPages((current) => ({ ...current, [state]: page }));
    setLists((current) => ({ ...current, [state]: { kind: "loading" } }));
    const result = await readLeaderList(teamId, state, page);
    if (generation.current === requestGeneration) {
      setLists((current) => ({ ...current, [state]: result }));
    }
  }, [teamId]);

  const reloadAuthoritative = useCallback(async (
    id: string,
    intent: TeamLeaderIntent,
    successMessage = "Đã tải lại dữ liệu có thẩm quyền.",
  ) => {
    updateWorkflow(id, {
      phase: "reload", intent,
      message: "Đã ghi nhận thao tác. Đang xác minh dữ liệu mới nhất.",
    });
    setBusyTeam(id);
    try {
      const [teamResponse, current, scheduled, history] = await Promise.all([
        fetch(`/api/admin/catalog/teams/${encodeURIComponent(id)}`, {
          method: "GET", cache: "no-store", headers: { Accept: "application/json" },
        }),
        ...STATES.map((state) => readLeaderList(id, state, 1)),
      ]);
      if (teamResponse.status === 404) {
        updateWorkflow(id, { phase: "idle", intent: null, message: null });
        onLockChange(id, false);
        onTeamUnavailable(id);
        onClose();
        notify.warning({ title: "Nhóm không còn tồn tại hoặc không còn khả dụng." });
        return;
      }
      if (teamResponse.status !== 200) throw new Error("reload");
      const snapshot = projectTeamLeaderSnapshot(id, await teamResponse.json(), {
        CURRENT: current.kind === "loaded" ? { ok: true, list: current.value } : null,
        SCHEDULED: scheduled.kind === "loaded" ? { ok: true, list: scheduled.value } : null,
        HISTORY: history.kind === "loaded" ? { ok: true, list: history.value } : null,
      });
      if (!snapshot) throw new Error("reload");
      onTeamReloaded(snapshot.team);
      setListTeamId(id);
      setLists({
        CURRENT: { kind: "loaded", value: snapshot.lists.CURRENT },
        SCHEDULED: { kind: "loaded", value: snapshot.lists.SCHEDULED },
        HISTORY: { kind: "loaded", value: snapshot.lists.HISTORY },
      });
      setPages({ CURRENT: 1, SCHEDULED: 1, HISTORY: 1 });
      updateWorkflow(id, { phase: "idle", intent: null, message: null });
      if (successMessage === "Đã lưu thay đổi và xác nhận dữ liệu mới nhất.") {
        notify.success({ title: successMessage });
      } else if (successMessage.includes("Dữ liệu có thẩm quyền đã được tải lại.")) {
        notify.warning({ title: successMessage });
      } else {
        notify.info({ title: successMessage });
      }
      onLockChange(id, false);
      setForm(null);
      setFormError(null);
    } catch {
      const reloadErr = "Không tải được dữ liệu có thẩm quyền. Nhóm vẫn bị khóa; hãy thử tải lại.";
      updateWorkflow(id, {
        phase: "reload-error",
        intent,
        message: reloadErr,
      });
      notify.error({ title: reloadErr });
    } finally {
      setBusyTeam(null);
    }
  }, [notify, onClose, onLockChange, onTeamReloaded, onTeamUnavailable, updateWorkflow]);

  const sendIntent = useCallback(async (intent: TeamLeaderIntent) => {
    setBusyTeam(intent.teamId);
    onLockChange(intent.teamId, true);
    updateWorkflow(intent.teamId, {
      phase: "sending", intent, message: null,
    });
    let response: Response;
    try {
      response = await fetch(intent.url, {
        method: "POST",
        cache: "no-store",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": String(intent.body.idempotency_key),
        },
        body: JSON.stringify(intent.body),
      });
    } catch {
      const noReplyMsg = "Không nhận được phản hồi. Có thể thử lại đúng thao tác này bằng cùng khóa.";
      updateWorkflow(intent.teamId, {
        phase: "retry", intent,
        message: noReplyMsg,
      });
      notify.warning({ title: noReplyMsg });
      setBusyTeam(null);
      return;
    }
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const outcome = classifyTeamLeaderMutation(response.status, payload, intent);
    if (outcome.kind === "applied" || outcome.kind === "conflict") {
      const successMessage = outcome.kind === "conflict"
        ? `${outcome.message} Dữ liệu có thẩm quyền đã được tải lại.`
        : "Đã lưu thay đổi và xác nhận dữ liệu mới nhất.";
      await reloadAuthoritative(intent.teamId, intent, successMessage);
      return;
    }
    if (outcome.kind === "unavailable") {
      updateWorkflow(intent.teamId, { phase: "retry", intent, message: outcome.message });
      notify.warning({ title: outcome.message });
      setBusyTeam(null);
      return;
    }
    updateWorkflow(intent.teamId, { phase: "idle", intent: null, message: null });
    setFormError(outcome.message);
    notify.error({ title: outcome.message });
    onLockChange(intent.teamId, false);
    setBusyTeam(null);
  }, [notify, onLockChange, reloadAuthoritative, updateWorkflow]);

  const startDesignation = () => {
    if (!team?.active || hasScheduledLeaders || workflow.phase !== "idle" || teamOperationLocked) return;
    setForm({
      kind: currentLeaders.length ? "replace" : "designate",
      appUserId: "",
      effectiveDate: "",
      reason: "",
    });
    setFormError(null);
    setCandidatePage(1);
    setCandidateSearch("");
    setCandidateSearchInput("");
    setCandidateReloadToken((value) => value + 1);
  };

  const startRevocation = () => {
    if (hasScheduledLeaders || workflow.phase !== "idle" || teamOperationLocked) return;
    setForm({ kind: "revoke", effectiveDate: "", reason: "" });
    setFormError(null);
  };

  const submitMutation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!team || !form || workflow.phase !== "idle" || teamOperationLocked) return;
    setFormError(null);
    const idempotencyKey = newTeamLeaderIntentKey();
    const request = form.kind === "revoke"
      ? buildTeamLeaderRevocation({
          teamId: team.team_id,
          effectiveDate: form.effectiveDate,
          expectedVersion: team.version,
          reason: form.reason,
          idempotencyKey,
        })
      : buildTeamLeaderDesignation({
          teamId: team.team_id,
          leaderAppUserId: form.appUserId,
          effectiveDate: form.effectiveDate,
          expectedVersion: team.version,
          reason: form.reason,
          idempotencyKey,
          change: form.kind,
        });
    if (!request.ok) {
      setFormError(request.message);
      return;
    }
    void sendIntent(request.intent);
  };

  const reloadWorkflow = () => {
    if (!teamId || !workflow.intent) return;
    void reloadAuthoritative(teamId, workflow.intent);
  };

  const readReady = STATES.every((state) => visibleLists[state].kind === "loaded");
  const pageCount = activeList
    ? Math.max(1, Math.ceil(activeList.total / activeList.page_size))
    : 1;
  const candidateList = candidateState.kind === "loaded" ? candidateState.value : null;
  const candidatePageCount = candidateList
    ? Math.max(1, Math.ceil(candidateList.total / TEAM_LEADER_CANDIDATE_PAGE_SIZE))
    : 1;

  return (
    <Dialog.Root open={team !== null} onOpenChange={(open) => {
      if (!open && workflow.phase !== "sending" && workflow.phase !== "reload") onClose();
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          onCloseAutoFocus={(event) => { if (busyTeam !== null) event.preventDefault(); }}
          aria-describedby="team-leader-description"
          className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[min(52rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl focus:outline-none sm:p-6"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-xl font-semibold text-foreground">
                Trưởng nhóm{team ? ` · ${team.display_name}` : ""}
              </Dialog.Title>
              <Dialog.Description id="team-leader-description" className="mt-1 text-sm text-muted">
                Lịch sử và thao tác trưởng nhóm được xác nhận lại từ dữ liệu có thẩm quyền.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Đóng hộp thoại"
                disabled={workflow.phase === "sending" || workflow.phase === "reload"}
                className="min-h-10 rounded-md border border-border px-3 disabled:opacity-50">
                Đóng
              </button>
            </Dialog.Close>
          </div>

          {team && workflow.phase !== "idle" ? (
            <Alert tone={workflow.phase === "retry" || workflow.phase === "reload-error" ? "warning" : "info"}
              title={workflow.phase === "sending" ? "Đang lưu thao tác" :
                workflow.phase === "retry" ? "Thao tác chưa có kết quả xác nhận" :
                  workflow.phase === "reload-error" ? "Thao tác vẫn đang bị khóa" : "Cần xác minh dữ liệu"}>
              <p>{workflow.message}</p>
              {workflow.phase === "retry" && workflow.intent ? (
                <button type="button" disabled={busyTeam !== null} onClick={() => void sendIntent(workflow.intent!)}
                  className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50">
                  Thử lại đúng thao tác
                </button>
              ) : null}
              {workflow.phase === "reload-error" || workflow.phase === "reload" ? (
                <button type="button" disabled={busyTeam !== null} onClick={reloadWorkflow}
                  className="mt-2 min-h-10 rounded-md border border-current px-3 font-medium disabled:opacity-50">
                  Tải lại dữ liệu có thẩm quyền
                </button>
              ) : null}
            </Alert>
          ) : null}

          {team ? (
            <div className="mt-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted">
                  {team.active ? "Nhóm đang hoạt động" : "Nhóm ngừng hoạt động"}
                </p>
                <button type="button" onClick={startDesignation}
                  disabled={!team.active || !readReady || hasScheduledLeaders || workflow.phase !== "idle" || teamOperationLocked}
                  className="min-h-11 whitespace-nowrap shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-50">
                  {currentLeaders.length ? "Thay thế trưởng nhóm" : "Chỉ định trưởng nhóm"}
                </button>
              </div>

              {hasScheduledLeaders ? (
                <Alert tone="warning" title="Lịch trưởng nhóm tương lai cũ đang cản thao tác gán hoặc thu hồi ngay">
                  <p>
                    Nhóm này còn lịch trưởng nhóm tương lai từ giai đoạn trước (xem ở mục Đã lên lịch để đối chiếu).
                    Luồng tự hủy lịch tương lai trên giao diện đã khóa theo chính sách hiệu lực tức thì (WP1/S1); vui lòng đối chiếu và xử lý lịch tồn đọng trước khi chỉ định, thay thế hoặc thu hồi trưởng nhóm.
                  </p>
                </Alert>
              ) : null}

              <div role="tablist" aria-label="Lịch sử trưởng nhóm" className="flex flex-wrap gap-2 overflow-x-auto whitespace-nowrap border-b border-border">
                {visibleStates.map((state) => (
                  <button key={state} type="button" role="tab" aria-selected={activeState === state}
                    onClick={() => setActiveState(state)}
                    className={`min-h-11 sm:min-h-10 whitespace-nowrap shrink-0 border-b-2 px-3 text-sm ${activeState === state
                      ? "border-primary font-semibold text-primary" : "border-transparent text-muted"}`}>
                    {stateLabel(state)}
                  </button>
                ))}
              </div>

              {activeReadError === "loading" ? <p role="status">Đang tải {stateLabel(activeState).toLowerCase()}…</p> : null}
              {activeReadError !== "loading" && activeReadError !== "loaded" ? (
                <Alert tone={activeReadError === "denied" ? "error" : "warning"}
                  role={activeReadError === "denied" ? "alert" : "status"}
                  title={activeReadError === "denied" ? "Không có quyền xem dữ liệu trưởng nhóm" : "Không thể tải dữ liệu trưởng nhóm"}>
                  {readFailureMessage(activeReadError)}
                  <button type="button" onClick={() => void loadPage(activeState, pages[activeState])}
                    className="mt-2 min-h-10 rounded-md border border-current px-3">Thử tải lại</button>
                </Alert>
              ) : null}
              {activeList?.leaders.length === 0 ? (
                <Card className="p-5 text-sm text-muted">Chưa có trưởng nhóm trong mục này.</Card>
              ) : null}
              {activeList && activeList.leaders.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-2xs">
                  <table className="r22-card-table w-full min-w-[430px] border-collapse text-left text-sm">
                    <caption className="sr-only">{stateLabel(activeState)} của nhóm {team.display_name}</caption>
                    <thead className="border-b border-border bg-surface-muted text-xs font-semibold uppercase tracking-wider text-muted">
                      <tr>
                        <th scope="col" className="px-3.5 py-3">Trưởng nhóm</th>
                        <th scope="col" className="px-3.5 py-3">Từ ngày</th>
                        <th scope="col" className="px-3.5 py-3">Đến ngày</th>
                        {activeState === "CURRENT" ? <th scope="col" className="px-3.5 py-3 text-right">Thao tác</th> : null}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {activeList.leaders.map((leader) => (
                        <tr key={leader.assignment_id} className="transition-colors hover:bg-surface-hover">
                          <th scope="row" data-card-header="true" className="px-3.5 py-2.5 font-medium">{leader.leader_display_name}</th>
                          <td data-label="Từ ngày" className="px-3.5 py-2.5 font-mono tabular-nums whitespace-nowrap">{formatDate(leader.valid_from)}</td>
                          <td data-label="Đến ngày" className="px-3.5 py-2.5 font-mono tabular-nums whitespace-nowrap">{formatDate(leader.valid_to)}</td>
                          {activeState === "CURRENT" ? (
                            <td data-card-actions="true" className="px-3.5 py-2.5 text-right">
                              <div className="inline-flex flex-wrap md:flex-nowrap items-center justify-end gap-1.5 whitespace-nowrap">
                                <button type="button" disabled={hasScheduledLeaders || workflow.phase !== "idle" || teamOperationLocked}
                                  onClick={() => startRevocation()}
                                  className="min-h-11 md:min-h-8 whitespace-nowrap shrink-0 rounded-md border border-border px-3 text-xs font-medium disabled:opacity-50">
                                  Thu hồi
                                </button>
                              </div>
                            </td>
                          ) : null}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {activeList ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-muted">Trang {pages[activeState]} / {pageCount}</p>
                  <div className="flex gap-2">
                    <button type="button" disabled={pages[activeState] <= 1}
                      onClick={() => void loadPage(activeState, pages[activeState] - 1)}
                      className="min-h-11 sm:min-h-10 whitespace-nowrap shrink-0 rounded-md border border-border px-3 disabled:opacity-50">Trang trước</button>
                    <button type="button" disabled={pages[activeState] >= pageCount}
                      onClick={() => void loadPage(activeState, pages[activeState] + 1)}
                      className="min-h-11 sm:min-h-10 whitespace-nowrap shrink-0 rounded-md border border-border px-3 disabled:opacity-50">Trang sau</button>
                  </div>
                </div>
              ) : null}

              {form ? (
                <Card className="space-y-4 p-4">
                  <h3 className="font-semibold">
                    {form.kind === "revoke" ? "Thu hồi trưởng nhóm" :
                      form.kind === "replace" ? "Thay thế trưởng nhóm" : "Chỉ định trưởng nhóm"}
                  </h3>
                  <form onSubmit={submitMutation} className="space-y-4">
                    {form.kind !== "revoke" ? (
                      <>
                        <label htmlFor="team-leader-search" className="block text-sm font-medium">
                          Tìm nhân sự đăng nhập
                          <span className="mt-1 flex flex-col gap-2 sm:flex-row">
                            <input id="team-leader-search" value={candidateSearchInput} maxLength={256}
                              onChange={(event) => setCandidateSearchInput(event.currentTarget.value)}
                              className="min-h-11 sm:min-h-10 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-base sm:text-sm" />
                            <button type="button" onClick={() => {
                              setCandidateSearch(candidateSearchInput.trim());
                              setCandidatePage(1);
                              setCandidateReloadToken((value) => value + 1);
                            }} className="min-h-11 sm:min-h-10 whitespace-nowrap shrink-0 rounded-md border border-border px-3">Tìm</button>
                          </span>
                        </label>
                        {candidateState.kind === "loading" ? <p role="status">Đang tải nhân sự đủ điều kiện…</p> : null}
                        {candidateState.kind !== "idle" && candidateState.kind !== "loading" &&
                          candidateState.kind !== "loaded" ? (
                            <Alert tone={candidateState.kind === "denied" ? "error" : "warning"}
                              role={candidateState.kind === "denied" ? "alert" : "status"}
                              title="Không thể tải nhân sự đủ điều kiện">
                              {readFailureMessage(candidateState.kind)}
                              <button type="button" onClick={() => setCandidateReloadToken((value) => value + 1)}
                                className="mt-2 min-h-10 rounded-md border border-current px-3">Thử lại</button>
                            </Alert>
                          ) : null}
                        {candidateList?.candidates.length === 0 ? (
                          <p className="text-sm text-muted">Không có nhân sự phù hợp. Thử từ khóa khác.</p>
                        ) : null}
                        {candidateList && candidateList.candidates.length > 0 ? (
                          <>
                            <label htmlFor="team-leader-candidate" className="block text-sm font-medium">
                              Nhân sự
                              <select id="team-leader-candidate" value={form.appUserId}
                                onChange={(event) => setForm({ ...form, appUserId: event.currentTarget.value })}
                                required
                                className="mt-1 block min-h-11 sm:min-h-10 w-full rounded-md border border-border bg-background px-3 text-base sm:text-sm">
                                <option value="">Chọn nhân sự</option>
                                {candidateList.candidates.map((candidate) => (
                                  <option key={candidate.app_user_id} value={candidate.app_user_id}>
                                    {candidate.display_name}{candidate.personnel_code
                                      ? ` · ${candidate.personnel_code}` : ""}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <div className="flex justify-end gap-2">
                              <button type="button" disabled={candidatePage <= 1}
                                onClick={() => setCandidatePage((value) => value - 1)}
                                className="min-h-10 whitespace-nowrap shrink-0 rounded-md border border-border px-3 disabled:opacity-50">Trước</button>
                              <span className="self-center text-sm text-muted">
                                Trang {candidatePage} / {candidatePageCount}
                              </span>
                              <button type="button" disabled={candidatePage >= candidatePageCount}
                                onClick={() => setCandidatePage((value) => value + 1)}
                                className="min-h-10 whitespace-nowrap shrink-0 rounded-md border border-border px-3 disabled:opacity-50">Sau</button>
                            </div>
                          </>
                        ) : null}
                      </>
                    ) : null}
                    <div className="rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs text-muted">
                      Ngày hiệu lực hệ thống: <span className="font-mono font-semibold text-foreground">{form.effectiveDate || currentList?.authorization_date || "Hôm nay (giờ Việt Nam)"}</span> (áp dụng ngay khi lưu).
                    </div>
                    <label htmlFor="team-leader-reason" className="block text-sm font-medium">
                      Lý do thay đổi (không bắt buộc)
                      <textarea id="team-leader-reason" value={form.reason} maxLength={4000} rows={3}
                        onChange={(event) => setForm({ ...form, reason: event.currentTarget.value })}
                        className="mt-1 block w-full rounded-md border border-border bg-background px-3 py-2 text-base sm:text-sm" />
                    </label>
                    {formError ? <p role="alert" className="text-sm text-red-700">{formError}</p> : null}
                    <div className="flex flex-wrap justify-end gap-2">
                      <button type="button" onClick={() => setForm(null)}
                        className="min-h-11 whitespace-nowrap shrink-0 rounded-md border border-border px-4">Hủy</button>
                      <button type="submit" disabled={busyTeam !== null || workflow.phase !== "idle" ||
                        teamOperationLocked ||
                        (form.kind !== "revoke" && candidateState.kind !== "loaded")}
                        className="min-h-11 whitespace-nowrap shrink-0 rounded-md bg-primary px-4 font-medium text-on-primary disabled:opacity-50">
                        {busyTeam !== null ? "Đang lưu…" : form.kind === "revoke" ? "Xác nhận thu hồi" : "Xác nhận"}
                      </button>
                    </div>
                  </form>
                </Card>
              ) : null}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
