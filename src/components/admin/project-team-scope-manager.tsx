"use client";

import { useEffect, useRef, useState } from "react";
import * as Dialog from "radix-ui/dialog";

import { Alert } from "@/components/ui/alert";
import { StatusBadge, scopeMappingStateBadgeProps } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { OffsetPager } from "@/components/ui/offset-pager";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import {
  buildGrantRequest,
  buildMappingListQuery,
  buildRevokeRequest,
  classifyGrantResponse,
  classifyRevokeResponse,
  filterActiveProjects,
  MAX_BATCH_PROJECTS,
  newMappingKey,
  paginateProjects,
  PROJECT_PICKER_PAGE_SIZE,
  toggleProjectSelection,
} from "@/lib/admin/project-team-scope-ui-model";
import type {
  ProjectTeamScopeMapping,
  ProjectTeamScopeList,
} from "@/lib/admin/project-team-scope-contract";
import { parseListResponse, type ProjectView } from "@/lib/direct-entry/project-operations-model";
import {
  buildTeamListQuery,
  projectTeamListForQuery,
} from "@/lib/admin/team-catalog-model";
import type { AdminTeam, AdminTeamList } from "@/lib/direct-entry/team-catalog-contract";

const button = "inline-flex min-h-11 md:min-h-8 items-center justify-center whitespace-nowrap shrink-0 rounded-md border border-border bg-surface px-3 text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const primary = "inline-flex min-h-11 sm:min-h-10 items-center justify-center whitespace-nowrap shrink-0 rounded-md bg-primary px-4 text-sm font-medium text-on-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50";
const input = "min-h-11 sm:min-h-10 w-full rounded-md border border-border bg-surface px-3 text-base sm:text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

type DialogState =
  | { kind: "grant" }
  | { kind: "revoke"; mapping: ProjectTeamScopeMapping }
  | null;

type PickerState<T> =
  | { kind: "loading" }
  | { kind: "ready"; value: T }
  | { kind: "denied" }
  | { kind: "error" };

export function ProjectTeamScopeManager() {
  const notify = useNotify();
  const [list, setList] = useState<ProjectTeamScopeList | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">("loading");
  const [searchInput, setSearchInput] = useState("");
  const [searchFilter, setSearchFilter] = useState("");
  const [includeHistory, setIncludeHistory] = useState(false);
  const [page, setPage] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [projectPicker, setProjectPicker] = useState<PickerState<ProjectView[]>>({ kind: "loading" });
  const [projectReloadToken, setProjectReloadToken] = useState(0);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectPage, setProjectPage] = useState(1);
  const [selectedProjectIds, setSelectedProjectIds] = useState<string[]>([]);
  const [teamPicker, setTeamPicker] = useState<PickerState<AdminTeamList>>({ kind: "loading" });
  const [teamSearch, setTeamSearch] = useState("");
  const [teamPage, setTeamPage] = useState(1);
  const [teamReloadToken, setTeamReloadToken] = useState(0);
  const [selectedTeam, setSelectedTeam] = useState<AdminTeam | null>(null);
  const [revokeEffectiveTo, setRevokeEffectiveTo] = useState("");
  const [reason, setReason] = useState("");
  const pendingIntent = useRef<{ signature: string; key: string } | null>(null);

  // Debounce the free-text search (250-350 ms) so typing does not fire one request per
  // keystroke, and apply exactly one filtered query once the operator pauses.
  useEffect(() => {
    const handle = setTimeout(() => { setSearchFilter(searchInput); setPage(1); }, 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  useEffect(() => {
    const query = buildMappingListQuery({ search: searchFilter, includeHistory, page });
    if (!query) return;
    const controller = new AbortController();
    void (async () => {
      setState("loading");
      try {
        const response = await fetch(`/api/admin/catalog/project-team-scopes?${query.toString()}`, {
          method: "GET", cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" },
        });
        if (response.status === 401 || response.status === 403) { setState("denied"); return; }
        if (response.status !== 200) { setState("error"); return; }
        const data = await response.json();
        if (data && typeof data === "object" && "list" in data) {
          setList((data as { list: ProjectTeamScopeList }).list);
          setState("ready");
        } else setState("error");
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState("error");
      }
    })();
    return () => controller.abort();
  }, [includeHistory, page, searchFilter, reloadToken]);

  useEffect(() => {
    if (dialog?.kind !== "grant") return;
    const controller = new AbortController();
    void (async () => {
      setProjectPicker({ kind: "loading" });
      try {
        const response = await fetch("/api/direct-entry/projects?include_inactive=true", {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (response.status === 401 || response.status === 403) {
          setProjectPicker({ kind: "denied" });
          return;
        }
        if (response.status !== 200) {
          setProjectPicker({ kind: "error" });
          return;
        }
        const projects = parseListResponse(await response.json());
        if (!projects) {
          setProjectPicker({ kind: "error" });
          return;
        }
        setProjectPicker({ kind: "ready", value: projects });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setProjectPicker({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [dialog?.kind, projectReloadToken]);

  useEffect(() => {
    if (dialog?.kind !== "grant") return;
    const query = buildTeamListQuery({ search: teamSearch, includeInactive: false, page: teamPage });
    if (!query) return;
    const controller = new AbortController();
    void (async () => {
      setTeamPicker({ kind: "loading" });
      try {
        const response = await fetch(`/api/admin/catalog/teams?${query.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (response.status === 401 || response.status === 403) {
          setTeamPicker({ kind: "denied" });
          return;
        }
        if (response.status !== 200) {
          setTeamPicker({ kind: "error" });
          return;
        }
        const list = projectTeamListForQuery(await response.json(), {
          search: teamSearch,
          includeInactive: false,
          page: teamPage,
        });
        if (!list || list.teams.some((team) => !team.active)) {
          setTeamPicker({ kind: "error" });
          return;
        }
        setTeamPicker({ kind: "ready", value: list });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setTeamPicker({ kind: "error" });
      }
    })();
    return () => controller.abort();
  }, [dialog?.kind, teamPage, teamReloadToken, teamSearch]);

  const reloadList = () => { setState("loading"); setReloadToken((v) => v + 1); };

  async function submitDialog() {
    setFormError(null);
    if (!dialog) return;
    const signature = JSON.stringify(dialog.kind === "grant"
      ? { kind: dialog.kind, projectIds: selectedProjectIds, teamId: selectedTeam?.team_id, reason: reason.trim() }
      : { kind: dialog.kind, mappingId: dialog.mapping.mapping_id, effectiveTo: revokeEffectiveTo, reason: reason.trim() });
    const key = pendingIntent.current?.signature === signature
      ? pendingIntent.current.key
      : newMappingKey();
    pendingIntent.current = { signature, key };
    const request = dialog.kind === "grant"
      ? buildGrantRequest({
          projectIds: selectedProjectIds,
          teamId: selectedTeam?.team_id ?? "",
          reason,
          idempotencyKey: key,
        })
      : buildRevokeRequest({
          mappingId: dialog.mapping.mapping_id,
          effectiveTo: revokeEffectiveTo,
          reason,
          idempotencyKey: key,
        });
    if (!request.ok) { setFormError(request.message); return; }
    const url = dialog.kind === "grant" ? "/api/admin/catalog/project-team-scopes" : `/api/admin/catalog/project-team-scopes/${encodeURIComponent(dialog.mapping.mapping_id)}/revoke`;
    setBusy(true);
    try {
      const response = await fetch(url, {
        method: "POST", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify(request.body),
      });
      const payload: unknown = await response.json().catch(() => null);
      const projectNames = new Map(
        (projectPicker.kind === "ready" ? projectPicker.value : [])
          .map((project) => [project.project_id, project.display_name] as const),
      );
      const outcome = dialog.kind === "grant"
        ? classifyGrantResponse(
            response.status,
            payload,
            selectedTeam?.team_id ?? "",
            selectedProjectIds,
            projectNames,
          )
        : classifyRevokeResponse(response.status, payload, dialog.mapping.mapping_id);
      setBusy(false);
      if (outcome.kind === "applied") {
        notify.success({ title: outcome.message });
        pendingIntent.current = null;
        setDialog(null);
        setSelectedProjectIds([]);
        setSelectedTeam(null);
        reloadList();
      } else if (outcome.kind === "conflict") {
        notify.warning({ title: outcome.message });
        setFormError(outcome.message);
      } else {
        notify.error({ title: outcome.message });
        setFormError(outcome.message);
      }
    } catch {
      setBusy(false);
      const errMsg = "Không nhận được phản hồi. Có thể thử lại.";
      notify.error({ title: errMsg });
      setFormError(errMsg);
    }
  }

  const mappings = list?.mappings ?? [];
  const pageCount = list ? Math.max(1, Math.ceil(list.total / Math.max(1, list.page_size))) : 1;
  const allProjects = projectPicker.kind === "ready" ? projectPicker.value : [];
  const activeProjects = filterActiveProjects(allProjects, projectSearch);
  const visibleProjects = paginateProjects(activeProjects, projectPage);
  const projectPickerPageCount = Math.max(1, Math.ceil(activeProjects.length / PROJECT_PICKER_PAGE_SIZE));
  const projectNames = new Map(allProjects.map((project) => [project.project_id, project.display_name] as const));
  const teamList = teamPicker.kind === "ready" ? teamPicker.value : null;
  const teamPageCount = teamList ? Math.max(1, Math.ceil(teamList.total / Math.max(1, teamList.page_size))) : 1;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">Mapping Dự án ↔ Nhóm</h1>
        <p className="mt-1 text-sm text-muted">Cấp và thu hồi mapping Project↔Team. Chỉ Full Admin.</p>
      </header>

      <Card>
        <CardHeader title="Danh sách mapping" description={list ? `${list.total} mapping` : "Tìm theo mã hoặc tên dự án / nhóm, hoặc xem lịch sử."} />
        <form className="mb-4 flex flex-wrap gap-3 items-end" onSubmit={(e) => { e.preventDefault(); setSearchFilter(searchInput); setPage(1); reloadList(); }}>
          <label className="flex flex-col gap-1 text-sm font-medium flex-1">Tìm dự án hoặc nhóm
            <input type="search" value={searchInput} maxLength={256}
              placeholder="Nhập một phần mã hoặc tên dự án / nhóm"
              onChange={(e) => setSearchInput(e.target.value)} className={input} />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeHistory} onChange={(e) => { setIncludeHistory(e.target.checked); setPage(1); reloadList(); }} className="size-4 accent-primary" />
            Bao gồm lịch sử
          </label>
          <button type="submit" className={button}>Lọc</button>
          <button type="button" className={primary} onClick={() => {
            setReason("");
            setSelectedProjectIds([]);
            setSelectedTeam(null);
            setProjectSearch("");
            setProjectPage(1);
            setTeamSearch("");
            setTeamPage(1);
            pendingIntent.current = null;
            setFormError(null);
            setDialog({ kind: "grant" });
          }}>Cấp mapping</button>
        </form>

        {state === "loading" ? <p role="status" className="py-8 text-center text-sm text-muted">Đang tải…</p> : null}
        {state === "denied" ? <Alert tone="error" title="Không có quyền">Chỉ Full Admin được xem mapping.</Alert> : null}
        {state === "error" ? (
          <div className="space-y-2">
            <ErrorState title="Không tải được danh sách mapping" />
            <button type="button" className={button} onClick={reloadList}>Thử tải lại</button>
          </div>
        ) : null}
        {state === "ready" && mappings.length === 0 ? <EmptyState title="Chưa có mapping nào" /> : null}
        {state === "ready" && mappings.length > 0 ? (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-2xs">
            <table className="r22-card-table w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs font-semibold uppercase tracking-wider text-muted"><tr>
                <th scope="col" className="px-3.5 py-3 font-semibold">Dự án</th>
                <th scope="col" className="px-3.5 py-3 font-semibold">Nhóm</th>
                <th scope="col" className="px-3.5 py-3 font-semibold">Hiệu lực</th>
                <th scope="col" className="px-3.5 py-3 font-semibold">Trạng thái</th>
                <th scope="col" className="px-3.5 py-3 font-semibold">Phiên bản cặp</th>
                <th scope="col" className="px-3.5 py-3 text-right">Thao tác</th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {mappings.map((m) => (
                  <tr key={m.mapping_id} className="border-b border-border/80 last:border-0 transition-colors hover:bg-surface-hover">
                    <td data-card-header="true" className="px-3.5 py-2.5 font-medium">{m.project_display_name}</td>
                    <td data-label="Nhóm" className="px-3.5 py-2.5">{m.team_display_name} ({m.team_code})</td>
                    <td data-label="Hiệu lực" className="px-3.5 py-2.5 font-mono tabular-nums whitespace-nowrap">{m.valid_from} → {m.valid_to ?? "∞"}</td>
                    <td data-label="Trạng thái" className="px-3.5 py-2.5">
                      <StatusBadge tone={scopeMappingStateBadgeProps(m.state).tone} dot>
                        {scopeMappingStateBadgeProps(m.state).label}
                      </StatusBadge>
                    </td>
                    <td data-label="Phiên bản cặp" className="px-3.5 py-2.5 font-mono tabular-nums">{m.version}</td>
                    <td data-card-actions="true" className="px-3.5 py-2.5 text-right">
                      <div className="inline-flex flex-wrap md:flex-nowrap items-center justify-end gap-1.5 whitespace-nowrap">
                        {m.valid_to === null ? (
                          <button type="button" className={button} disabled={busy}
                            onClick={() => { pendingIntent.current = null; setRevokeEffectiveTo(""); setReason(""); setFormError(null); setDialog({ kind: "revoke", mapping: m }); }}>
                            Thu hồi
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {state === "ready" && list && list.total > 0 ? (
          <OffsetPager
            page={page}
            pageCount={pageCount}
            total={list.total}
            ariaLabel="Phân trang danh sách mapping"
            nextDisabled={!list.has_more}
            onPageChange={(nextPage) => {
              setPage(Math.min(1000, nextPage));
              reloadList();
            }}
          />
        ) : null}
      </Card>

      <FormDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy) {
            pendingIntent.current = null;
            setDialog(null);
          }
        }}
        title={dialog?.kind === "grant" ? "Cấp mapping Dự án ↔ Nhóm" : "Thu hồi mapping Dự án ↔ Nhóm"}
        description="Lý do thao tác không bắt buộc; mọi thay đổi đều có audit."
        descriptionId="mapping-dialog-desc"
        closeDisabled={busy}
        closeAriaLabel="Đóng"
      >
            <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); void submitDialog(); }}>
              {dialog?.kind === "grant" ? (
                <>
                  <section aria-labelledby="project-picker-title" className="space-y-3">
                    <label className="flex flex-col gap-1 text-sm font-medium">Tìm dự án
                      <input type="search" value={projectSearch} disabled={busy}
                        onChange={(e) => { setProjectSearch(e.target.value); setProjectPage(1); }}
                        className={input} />
                    </label>
                    <h3 id="project-picker-title" className="text-sm font-semibold">
                      Chọn dự án ({selectedProjectIds.length}/{MAX_BATCH_PROJECTS})
                    </h3>
                    {projectPicker.kind === "loading" ? <p role="status" className="text-sm text-muted">Đang tải dự án…</p> : null}
                    {projectPicker.kind === "denied" ? <Alert tone="error" title="Không có quyền">Không thể tải danh sách dự án.</Alert> : null}
                    {projectPicker.kind === "error" ? (
                      <div className="space-y-2">
                        <ErrorState title="Không tải được danh sách dự án" />
                        <button type="button" className={button} disabled={busy}
                          onClick={() => setProjectReloadToken((value) => value + 1)}>Thử tải lại</button>
                      </div>
                    ) : null}
                    {projectPicker.kind === "ready" ? (
                      <>
                        <fieldset className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-3">
                          <legend className="px-1 text-xs text-muted">Dự án đang hoạt động</legend>
                          {visibleProjects.map((project) => {
                            const checked = selectedProjectIds.includes(project.project_id);
                            return (
                              <label key={project.project_id} className="flex items-center gap-2 py-1 text-sm">
                                <input type="checkbox" checked={checked} disabled={busy || (!checked && selectedProjectIds.length >= MAX_BATCH_PROJECTS)}
                                  aria-label={`Chọn dự án ${project.display_name}`}
                                  onChange={(event) => {
                                    setFormError(null);
                                    setSelectedProjectIds((current) =>
                                      toggleProjectSelection(current, project.project_id, event.target.checked));
                                  }}
                                  className="size-4 accent-primary" />
                                <span>{project.display_name}</span>
                              </label>
                            );
                          })}
                          {visibleProjects.length === 0 ? (
                            <p className="py-2 text-sm text-muted">
                              {allProjects.some((project) => project.active)
                                ? "Không có dự án phù hợp với nội dung tìm kiếm."
                                : "Chưa có dự án đang hoạt động."}
                            </p>
                          ) : null}
                        </fieldset>
                        <div className="flex items-center gap-2 text-sm text-muted">
                          <button type="button" className={button} disabled={busy || projectPage <= 1}
                            onClick={() => setProjectPage((value) => Math.max(1, value - 1))}>Trang trước</button>
                          <span>Trang {projectPage} / {projectPickerPageCount}</span>
                          <button type="button" className={button}
                            disabled={busy || projectPage >= projectPickerPageCount}
                            onClick={() => setProjectPage((value) => Math.min(projectPickerPageCount, value + 1))}>Trang sau</button>
                        </div>
                        <p className="text-xs text-muted">
                          Đã chọn: {selectedProjectIds.map((id) => projectNames.get(id)).filter(Boolean).join(", ") || "chưa có dự án"}.
                        </p>
                      </>
                    ) : null}
                  </section>
                  <section className="space-y-3" aria-labelledby="team-picker-title">
                    <h3 id="team-picker-title" className="text-sm font-semibold">Chọn một nhóm</h3>
                    <label className="flex flex-col gap-1 text-sm font-medium">Tìm nhóm
                      <input type="search" value={teamSearch} disabled={busy}
                        maxLength={256}
                        onChange={(e) => { setTeamSearch(e.target.value); setTeamPage(1); }}
                        className={input} />
                    </label>
                    {teamPicker.kind === "loading" ? <p role="status" className="text-sm text-muted">Đang tải nhóm…</p> : null}
                    {teamPicker.kind === "denied" ? <Alert tone="error" title="Không có quyền">Không thể tải danh sách nhóm.</Alert> : null}
                    {teamPicker.kind === "error" ? (
                      <div className="space-y-2">
                        <ErrorState title="Không tải được danh sách nhóm" />
                        <button type="button" className={button} disabled={busy}
                          onClick={() => setTeamReloadToken((value) => value + 1)}>Thử tải lại</button>
                      </div>
                    ) : null}
                    {teamPicker.kind === "ready" ? (
                      <>
                        <label className="flex flex-col gap-1 text-sm font-medium">Nhóm
                          <select required value={selectedTeam?.team_id ?? ""} disabled={busy} className={input}
                            onChange={(event) => {
                              setFormError(null);
                              setSelectedTeam(
                                teamList?.teams.find((team) => team.team_id === event.target.value) ?? null,
                              );
                            }}>
                            <option value="">Chọn nhóm</option>
                            {selectedTeam && !teamList?.teams.some((team) => team.team_id === selectedTeam.team_id)
                              ? <option value={selectedTeam.team_id}>{selectedTeam.display_name}</option>
                              : null}
                            {teamList?.teams.filter((team) => team.active).map((team) => (
                              <option key={team.team_id} value={team.team_id}>{team.display_name} ({team.code})</option>
                            ))}
                          </select>
                        </label>
                        {teamList?.teams.length === 0 ? <p className="text-sm text-muted">Không có nhóm đang hoạt động phù hợp.</p> : null}
                        <div className="flex items-center gap-2 text-sm text-muted">
                          <button type="button" className={button} disabled={busy || teamPage <= 1}
                            onClick={() => setTeamPage((value) => Math.max(1, value - 1))}>Trang trước</button>
                          <span>Trang {teamPage} / {teamPageCount}</span>
                          <button type="button" className={button} disabled={busy || teamPage >= teamPageCount}
                            onClick={() => setTeamPage((value) => Math.min(teamPageCount, value + 1))}>Trang sau</button>
                        </div>
                      </>
                    ) : null}
                  </section>
                </>
              ) : dialog ? (
                <>
                  <p>Bạn sắp thu hồi mapping <strong>{dialog.mapping.project_display_name}</strong> ↔ <strong>{dialog.mapping.team_display_name}</strong> (version {dialog.mapping.version}).</p>
                  <div className="rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs text-muted">
                    Hiệu lực thu hồi được hệ thống áp dụng ngay theo ngày nghiệp vụ hiện tại (giờ Việt Nam).
                  </div>
                </>
              ) : null}
              <label className="flex flex-col gap-1 text-sm font-medium">Lý do thao tác (không bắt buộc)
                <textarea value={reason} maxLength={4000} rows={3} onChange={(e) => { setReason(e.target.value); setFormError(null); }} className={input} />
              </label>
              {formError ? <p role="alert" className="text-sm text-red-700">{formError}</p> : null}
              <div className="flex justify-end gap-2">
                <Dialog.Close asChild><button type="button" disabled={busy} className={button}>Hủy</button></Dialog.Close>
                <button type="submit" disabled={busy || (dialog?.kind === "grant" && (
                  projectPicker.kind !== "ready" || teamPicker.kind !== "ready" ||
                  selectedProjectIds.length < 1 || selectedProjectIds.length > MAX_BATCH_PROJECTS || !selectedTeam
                ))} className={primary}>{busy ? "Đang lưu…" : dialog?.kind === "grant" ? "Cấp mapping" : "Xác nhận thu hồi"}</button>
              </div>
            </form>
      </FormDialog>
    </div>
  );
}
