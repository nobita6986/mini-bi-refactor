"use client";

/**
 * P2.5-W06A - Project Operations UI.
 *
 * Nguyen tac:
 * - Server response/RPC la nguon duy nhat ve quyen: UI chi hien/disable (UX),
 *   KHONG suy dien quyen tu role/email/recruiter/team/created_by.
 * - Client khong bao gio gui actor/capability/scope/role.
 * - Moi thao tac thay doi deu BAT BUOC co ly do.
 * - Moi mutation deu gui dung version (OCC). Xung dot 409 => bat buoc tai lai,
 *   KHONG ghi de ngam.
 */

import {
  Building2,
  History,
  MapPin,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Trash2,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Dialog } from "radix-ui";

import { AccessDenied } from "@/components/auth/access-denied";
import { TemporaryUnavailable } from "@/components/auth/temporary-unavailable";
import { useNotify } from "@/components/ui/notify-provider";
import {
  buildAssignRequest,
  buildCreateRequest,
  buildRenameRequest,
  buildSetActiveRequest,
  buildUnassignRequest,
  buildUpdateProjectLocationRequest,
  candidateLabel,
  executeProjectRequest,
  filterProjects,
  mutationProjectVersion,
  newIdempotencyKey,
  paginateProjects,
  parseCandidatesResponse,
  parseDetailResponse,
  parseListResponse,
  PROJECT_LOCATION_ADDRESS_MAX,
  PROJECT_LOCATION_DEFAULT_RADIUS_METERS,
  PROJECT_LOCATION_MAX_RADIUS_METERS,
  PROJECT_LOCATION_MIN_RADIUS_METERS,
  projectStatusLabel,
  REASON_MAX,
  splitAssignments,
  validatePendingAssignments,
  type AssignmentView,
  type ManagerCandidate,
  type Outcome,
  type PendingAssignment,
  type ProjectDetailView,
  type ProjectLocationView,
  type ProjectStatusFilter,
  type ProjectView,
  type RequestResult,
} from "@/lib/direct-entry/project-operations-model";

const API = "/api/direct-entry/projects";

type ViewState = "loading" | "ready" | "empty" | "denied" | "unavailable" | "error";
type DetailState = "idle" | "loading" | "ready" | "error";
type CandidateState = "idle" | "loading" | "ready" | "error";

type DialogState =
  | { kind: "none" }
  | { kind: "create" }
  | { kind: "rename" }
  | { kind: "set-active"; active: boolean }
  | { kind: "location" }
  | { kind: "assign" }
  | { kind: "unassign"; assignment: AssignmentView };

const buttonClass =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-border " +
  "bg-surface px-3 text-sm font-medium text-foreground shadow-sm transition-colors " +
  "hover:bg-muted/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-50";
const primaryClass =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm " +
  "font-semibold text-on-primary shadow-sm transition-colors hover:bg-primary/90 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 " +
  "disabled:cursor-not-allowed disabled:opacity-50";
const dangerClass =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-red-500 " +
  "bg-surface px-3 text-sm font-medium text-red-700 shadow-sm transition-colors hover:bg-red-50 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 " +
  "disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-950/40";
const inputClass =
  "h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground " +
  "placeholder:text-muted focus:border-primary focus:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60";

function Field({
  id, label, hint, children,
}: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children}
      {hint ? <span id={id + "-hint"} className="text-xs text-muted">{hint}</span> : null}
    </div>
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

type ListResult = { status: number; payload: unknown };

/** Goi API list (module-level: effect chi cam ket promise, khong cham setState). */
async function fetchProjectList(): Promise<ListResult> {
  const response = await fetch(API + "?include_inactive=true", {
    headers: { accept: "application/json" },
  });
  return { status: response.status, payload: await readJson(response) };
}

export function ProjectOperations({ canManageProjectMasterForEmptyList }: { canManageProjectMasterForEmptyList: boolean }) {
  const notify = useNotify();
  const [state, setState] = useState<ViewState>("loading");
  const [projects, setProjects] = useState<ProjectView[]>([]);
  const canManageProjectMaster = projects.length > 0
    ? projects[0]?.can_manage_project_master === true
    : state === "empty" && canManageProjectMasterForEmptyList;
  const [detail, setDetail] = useState<ProjectDetailView | null>(null);
  const [detailState, setDetailState] = useState<DetailState>("idle");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectActionId, setProjectActionId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const [busy, setBusy] = useState(false);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [locationAddress, setLocationAddress] = useState("");
  const [locationLatitude, setLocationLatitude] = useState("");
  const [locationLongitude, setLocationLongitude] = useState("");
  const [locationRadius, setLocationRadius] = useState(
    String(PROJECT_LOCATION_DEFAULT_RADIUS_METERS),
  );
  const [pending, setPending] = useState<PendingAssignment[]>([]);
  const [managerId, setManagerId] = useState("");
  const [candidates, setCandidates] = useState<ManagerCandidate[]>([]);
  const [candidateLabels, setCandidateLabels] = useState<Record<string, string>>({});
  const [candidateState, setCandidateState] = useState<CandidateState>("idle");
  const [candidateSearch, setCandidateSearch] = useState("");
  const [activeCandidateIndex, setActiveCandidateIndex] = useState(0);
  const [projectSearch, setProjectSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ProjectStatusFilter>("all");
  const [projectPage, setProjectPage] = useState(1);
  const detailSectionRef = useRef<HTMLElement>(null);
  const dialogFocusRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const detailRequestRef = useRef(0);
  const candidateRequestRef = useRef(0);
  const focusDialogInput = useCallback((element: HTMLInputElement | HTMLTextAreaElement | null) => {
    dialogFocusRef.current = element;
  }, []);

  const loadCandidates = useCallback(async (search: string) => {
    const requestId = ++candidateRequestRef.current;
    setCandidateState("loading");
    try {
      const query = search.trim() === "" ? "" : "?search=" + encodeURIComponent(search.trim());
      const response = await fetch("/api/direct-entry/manager-candidates" + query, {
        headers: { accept: "application/json" },
      });
      if (requestId !== candidateRequestRef.current) return;
      if (response.status !== 200) {
        setCandidates([]);
        setCandidateState("error");
        return;
      }
      const parsed = parseCandidatesResponse(await readJson(response));
      if (requestId !== candidateRequestRef.current) return;
      if (parsed === null) {
        setCandidates([]);
        setCandidateState("error");
        return;
      }
      setCandidates(parsed);
      setActiveCandidateIndex(0);
      setCandidateLabels((current) => {
        const next = { ...current };
        for (const candidate of parsed) next[candidate.recruiter_id] = candidateLabel(candidate);
        return next;
      });
      setCandidateState("ready");
    } catch {
      if (requestId !== candidateRequestRef.current) return;
      setCandidates([]);
      setCandidateState("error");
    }
  }, []);

  const managerLabel = useCallback((recruiterId: string): string => {
    // P2.5-HF-R5A: khong bao gio hien UUID (ke ca rut gon) cho nguoi dung. Khi khong
    // tra duoc ten (quan ly khong con trong danh sach ung vien hop le), dung nhan nghiep vu
    // trung tinh; khong suy dien danh tinh tu id.
    return candidateLabels[recruiterId] ?? "Quản lý dự án (chưa tra được tên)";
  }, [candidateLabels]);

  /**
   * Ap ket qua list vao state. Chi duoc goi tu callback BAT DONG BO
   * (promise then/catch) hoac tu event handler — khong goi dong bo trong effect.
   */
  const applyListResult = useCallback((result: ListResult): boolean => {
    if (result.status === 403) { setState("denied"); return false; }
    if (result.status >= 500) { setState("unavailable"); return false; }
    const parsed = parseListResponse(result.payload);
    if (result.status !== 200 || parsed === null) { setState("error"); return false; }
    setProjects(parsed);
    setState(parsed.length === 0 ? "empty" : "ready");
    return true;
  }, []);

  /** Nap lai danh sach theo yeu cau nguoi dung / sau mutation. */
  const loadList = useCallback(async (): Promise<boolean> => {
    try {
      return applyListResult(await fetchProjectList());
    } catch {
      setState("unavailable");
      return false;
    }
  }, [applyListResult]);

  const loadDetail = useCallback(async (id: string): Promise<ProjectDetailView | null> => {
    const requestId = ++detailRequestRef.current;
    setSelectedProjectId(id);
    setDetailState("loading");
    setDetail(null);
    try {
      const response = await fetch(API + "/" + encodeURIComponent(id), {
        headers: { accept: "application/json" },
      });
      if (requestId !== detailRequestRef.current) return null;
      if (response.status !== 200) {
        setDetailState("error");
        return null;
      }
      const parsed = parseDetailResponse(await readJson(response));
      if (requestId !== detailRequestRef.current) return null;
      if (parsed === null) {
        setDetailState("error");
        return null;
      }
      setDetail(parsed);
      setDetailState("ready");
      // Tên quản lý được bổ sung nền; không bắt nút Xem/Đổi tên phải chờ
      // endpoint candidate vốn không cần thiết cho project master.
      void loadCandidates("");
      return parsed;
    } catch {
      if (requestId === detailRequestRef.current) setDetailState("error");
      return null;
    }
  }, [loadCandidates]);

  async function openProjectAction(
    project: ProjectView,
    action: "view" | "rename" | "set-active",
  ) {
    setNotice(null);
    setProjectActionId(project.project_id);
    const loaded = await loadDetail(project.project_id);
    setProjectActionId(null);
    if (!loaded) {
      const msg = "Không tải được dữ liệu dự án. Vui lòng thử lại.";
      setNotice(msg);
      notify.error({ title: msg });
      detailSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }
    if (action === "rename") {
      openDialog({ kind: "rename" }, { displayName: loaded.display_name });
      return;
    }
    if (action === "set-active") {
      openDialog({ kind: "set-active", active: !loaded.project_active });
      return;
    }
    detailSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    detailSectionRef.current?.focus({ preventScroll: true });
  }

  // Nap lan dau: state chi duoc cap nhat trong callback cua promise (khong
  // setState dong bo trong effect body).
  useEffect(() => {
    let active = true;
    fetchProjectList().then(
      (result) => { if (active) applyListResult(result); },
      () => { if (active) setState("unavailable"); },
    );
    return () => { active = false; };
  }, [applyListResult]);

  const closeDialog = useCallback(() => {
    setDialog({ kind: "none" });
    setReason("");
    setDisplayName("");
    setProjectId("");
    setLocationAddress("");
    setLocationLatitude("");
    setLocationLongitude("");
    setLocationRadius(String(PROJECT_LOCATION_DEFAULT_RADIUS_METERS));
    setPending([]);
    setManagerId("");
  }, []);

  /** Tai lai day du sau xung dot: khong ghi de ngam bat ky thay doi cuc bo nao. */
  const reloadAfterConflict = useCallback(async () => {
    if (reloadBusy) return;
    setReloadBusy(true);
    const detailReloaded = detail ? (await loadDetail(detail.project_id)) !== null : true;
    const listReloaded = await loadList();
    setReloadBusy(false);
    if (detailReloaded && listReloaded) setConflict(null);
    if (detailReloaded && listReloaded) notify.info({ title: "Đã tải lại dữ liệu dự án." });
  }, [detail, loadDetail, loadList, notify, reloadBusy]);

  const applyOutcome = useCallback((outcome: Outcome): boolean => {
    if (outcome.kind === "applied") return true;
    if (outcome.kind === "reload-required") {
      setConflict(outcome.message);
      notify.warning({ title: outcome.message });
      return false;
    }
    if (outcome.kind === "denied") {
      setNotice(outcome.message);
      notify.error({ title: outcome.message });
      return false;
    }
    setNotice(outcome.message);
    if (outcome.kind !== "invalid") {
      notify.error({ title: outcome.message });
    }
    return false;
  }, [notify]);

  async function send(
    url: string, method: "POST" | "PATCH" | "PUT", request: RequestResult, key: string,
  ): Promise<{ outcome: Outcome; payload: unknown }> {
    if (conflict) return { outcome: { kind: "reload-required", message: conflict }, payload: null };
    return executeProjectRequest(url, method, request, key);
  }

  async function afterSuccess(projectIdToRefresh: string | null) {
    if (projectIdToRefresh) await loadDetail(projectIdToRefresh);
    await loadList();
  }

  async function submitCreate() {
    const key = newIdempotencyKey();
    const request = buildCreateRequest({ projectId, displayName, reason, idempotencyKey: key });
    setBusy(true);
    const { outcome } = await send(API, "POST", request, key);
    setBusy(false);
    if (!applyOutcome(outcome)) return;
    notify.success({ title: "Đã tạo dự án." });
    closeDialog();
    await afterSuccess(null);
  }

  async function submitRename() {
    if (!detail) return;
    const key = newIdempotencyKey();
    const request = buildRenameRequest({
      displayName, reason, expectedVersion: detail.project_version, idempotencyKey: key,
    });
    setBusy(true);
    const { outcome } = await send(API + "/" + encodeURIComponent(detail.project_id),
      "PATCH", request, key);
    setBusy(false);
    if (!applyOutcome(outcome)) return;
    notify.success({ title: "Đã đổi tên dự án." });
    closeDialog();
    await afterSuccess(detail.project_id);
  }

  async function submitSetActive(active: boolean) {
    if (!detail) return;
    const key = newIdempotencyKey();
    const request = buildSetActiveRequest({
      active, reason, expectedVersion: detail.project_version, idempotencyKey: key,
    });
    setBusy(true);
    const { outcome } = await send(
      API + "/" + encodeURIComponent(detail.project_id) + "/active", "POST", request, key);
    setBusy(false);
    if (!applyOutcome(outcome)) return;
    notify.success({ title: active ? "Đã kích hoạt dự án." : "Đã ngừng hoạt động dự án." });
    closeDialog();
    await afterSuccess(detail.project_id);
  }

  /** Gan NHIEU quan ly: moi lan gui dung version du an moi nhat (OCC tuan tu). */
  async function submitAssign() {
    if (!detail) return;
    const rowsToAssign: PendingAssignment[] =
      pending.length > 0
        ? pending
        : managerId
          ? [{ managerRecruiterId: managerId, validFrom: null }]
          : [];
    const invalid = validatePendingAssignments(rowsToAssign);
    if (invalid) { setNotice(invalid); return; }
    setBusy(true);
    let version = detail.project_version;
    for (const row of rowsToAssign) {
      const key = newIdempotencyKey();
      const request = buildAssignRequest({
        managerRecruiterId: row.managerRecruiterId, validFrom: row.validFrom ?? null, reason,
        expectedProjectVersion: version, idempotencyKey: key,
      });
      const { outcome, payload } = await send(
        API + "/" + encodeURIComponent(detail.project_id) + "/managers", "POST", request, key);
      if (!applyOutcome(outcome)) { setBusy(false); await afterSuccess(detail.project_id); return; }
      // OCC dung project_version (khong phai version = assignment version).
      const next = mutationProjectVersion(payload);
      if (next === null) {
        const msg = "Phản hồi từ hệ thống không hợp lệ. Dữ liệu đã được tải lại để đối soát.";
        setNotice(msg);
        notify.error({ title: msg });
        setBusy(false);
        await afterSuccess(detail.project_id);
        return;
      }
      version = next;
    }
    setBusy(false);
    notify.success({ title: "Đã gán quản lý dự án." });
    closeDialog();
    await afterSuccess(detail.project_id);
  }

  async function submitUnassign(assignment: AssignmentView) {
    if (!detail) return;
    const key = newIdempotencyKey();
    const request = buildUnassignRequest({
      reason, expectedVersion: assignment.version,
      expectedProjectVersion: detail.project_version, idempotencyKey: key,
    });
    setBusy(true);
    const { outcome } = await send(
      API + "/" + encodeURIComponent(detail.project_id) + "/managers/" +
        encodeURIComponent(assignment.assignment_id), "POST", request, key);
    setBusy(false);
    if (!applyOutcome(outcome)) return;
    notify.success({ title: "Đã thu hồi phân công quản lý." });
    closeDialog();
    await afterSuccess(detail.project_id);
  }

  async function submitUpdateLocation(clearLocation = false) {
    if (!detail) return;
    const key = newIdempotencyKey();
    const request = buildUpdateProjectLocationRequest({
      address: clearLocation ? null : locationAddress,
      latitudeInput: clearLocation ? null : locationLatitude,
      longitudeInput: clearLocation ? null : locationLongitude,
      radiusInput: clearLocation ? null : locationRadius,
      clear: clearLocation,
      reason,
      expectedVersion: detail.project_version,
      idempotencyKey: key,
    });
    setBusy(true);
    const { outcome } = await send(
      API + "/" + encodeURIComponent(detail.project_id) + "/location",
      "PUT",
      request,
      key,
    );
    setBusy(false);
    if (!applyOutcome(outcome)) return;
    const isCleared =
      clearLocation ||
      (locationLatitude.trim() === "" && locationLongitude.trim() === "");
    notify.success({
      title: isCleared ? "Đã xóa tọa độ vị trí dự án." : "Đã cập nhật tọa độ vị trí dự án.",
    });
    closeDialog();
    await afterSuccess(detail.project_id);
  }

  function openDialog(
    next: DialogState,
    seed?: { displayName?: string; location?: ProjectLocationView | null },
  ) {
    setNotice(null);
    setReason("");
    setPending([]);
    setManagerId("");
    setDisplayName(seed && seed.displayName ? seed.displayName : "");
    const seededLocation =
      seed && "location" in seed ? seed.location : (detail?.location ?? null);
    setLocationAddress(seededLocation?.address ?? "");
    setLocationLatitude(
      seededLocation ? String(seededLocation.latitude) : "",
    );
    setLocationLongitude(
      seededLocation ? String(seededLocation.longitude) : "",
    );
    setLocationRadius(
      String(seededLocation?.radius_meters ?? PROJECT_LOCATION_DEFAULT_RADIUS_METERS),
    );
    setCandidateSearch("");
    setActiveCandidateIndex(0);
    if (next.kind === "assign") {
      setCandidates([]);
      setCandidateState("loading");
      void loadCandidates("");
    }
    setDialog(next);
  }

  if (state === "denied") return <AccessDenied />;
  if (state === "unavailable") return <TemporaryUnavailable />;

  const view = detail ? splitAssignments(detail.assignments) : { current: [], future: [], history: [] };
  const visibleProjects = filterProjects(projects, projectSearch, statusFilter);
  const page = paginateProjects(visibleProjects, projectPage);
  const activeCount = projects.filter((project) => project.active).length;
  const assignedCount = detail?.active_assignment_count ?? 0;

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 sm:px-6">
      <header className="rounded-2xl border border-border bg-gradient-to-r from-primary/10 via-surface to-secondary/10 p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">
              Danh mục vận hành
            </p>
            <h1 className="mt-1 text-2xl font-bold text-foreground">Quản lý dự án</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              Tạo và cập nhật dự án, theo dõi phân công hiện tại, lịch sắp hiệu lực và lịch sử quản lý.
            </p>
          </div>
          {canManageProjectMaster ? (<button type="button" className={primaryClass} disabled={conflict !== null || reloadBusy}
            onClick={() => openDialog({ kind: "create" })}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            Tạo dự án
          </button>) : null}
        </div>
        <dl className="mt-5 grid gap-3 sm:grid-cols-3">
          <SummaryMetric label="Tổng dự án" value={projects.length} />
          <SummaryMetric label="Đang hoạt động" value={activeCount} tone="success" />
          <SummaryMetric label="Đã ngừng" value={projects.length - activeCount} tone="muted" />
        </dl>
      </header>

      {conflict ? (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-amber-400 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100 sm:flex-row sm:items-center sm:justify-between">
          <span>{conflict}</span>
          <button type="button" className={buttonClass} disabled={reloadBusy}
            onClick={() => void reloadAfterConflict()}>
            <RefreshCw aria-hidden="true" className="h-4 w-4" />
            {reloadBusy ? "Đang tải lại…" : "Tải lại dữ liệu"}
          </button>
        </div>
      ) : null}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <section aria-labelledby="project-list-heading"
          className="min-w-0 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm"
          aria-busy={state === "loading"}>
          <div className="border-b border-border p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 id="project-list-heading" className="text-base font-semibold">Danh sách dự án</h2>
                <p className="mt-0.5 text-xs text-muted">Chọn dự án để xem và quản lý phân công.</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(13rem,1fr)_10rem]">
                <label className="relative block">
                  <span className="sr-only">Tìm dự án</span>
                  <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 h-4 w-4 text-muted" />
                  <input className={inputClass + " pl-9"} value={projectSearch}
                    placeholder="Tìm theo mã hoặc tên…"
                    onChange={(event) => { setProjectSearch(event.target.value); setProjectPage(1); }} />
                </label>
                <label>
                  <span className="sr-only">Lọc trạng thái</span>
                  <select className={inputClass} value={statusFilter}
                    onChange={(event) => {
                      setStatusFilter(event.target.value as ProjectStatusFilter);
                      setProjectPage(1);
                    }}>
                    <option value="all">Tất cả</option>
                    <option value="active">Đang hoạt động</option>
                    <option value="inactive">Đã ngừng</option>
                  </select>
                </label>
              </div>
            </div>
          </div>
          {state === "loading" ? (
            <p className="p-5 text-sm text-muted" role="status">Đang tải dữ liệu…</p>
          ) : null}
          {state === "error" ? (
            <div className="flex flex-col gap-3 p-5 text-sm" role="alert">
              <span className="font-medium text-red-700 dark:text-red-300">Không tải được danh sách dự án.</span>
              <button type="button" className={buttonClass}
                onClick={() => { setNotice(null); setState("loading"); void loadList(); }}>
                <RefreshCw aria-hidden="true" className="h-4 w-4" />
                Thử lại
              </button>
            </div>
          ) : null}
          {state === "ready" || state === "empty" ? (
            <div className="max-h-[46rem] overflow-x-auto overflow-y-auto">
              <table className="w-full table-fixed r22-card-table border-collapse text-sm">
                <caption className="sr-only">Danh sách dự án và trạng thái</caption>
                <colgroup>
                  <col />
                  <col className="w-40" />
                  <col className="w-[300px]" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-surface text-left text-xs uppercase tracking-wide text-muted shadow-[0_1px_0_var(--border)]">
                  <tr>
                    <th scope="col" className="px-3 py-3">Dự án</th>
                    <th scope="col" className="px-3 py-3">Trạng thái</th>
                    <th scope="col" className="px-3 py-3">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((project) => {
                    const actionBusy = projectActionId === project.project_id;
                    const selected = selectedProjectId === project.project_id;
                    return (
                      <tr key={project.project_id}
                        className={(selected ? "bg-primary/5 " : "") + "border-b border-border/70 last:border-0"}>
                        <td className="px-3 py-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <span className="min-w-0 break-words font-semibold text-foreground">{project.display_name}</span>
                            {project.can_manage_project_master ? (
                            <button type="button"
                              aria-label={`Chỉnh sửa dự án ${project.display_name}`}
                              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted transition-colors hover:bg-muted/10 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
                              disabled={projectActionId !== null || conflict !== null || reloadBusy}
                              onClick={() => { void openProjectAction(project, "rename"); }}>
                              <Pencil aria-hidden="true" className="h-4 w-4" />
                            </button>
                            ) : null}
                          </div>
                          <span className="mt-0.5 block font-mono text-xs text-muted">{project.project_id}</span>
                          {project.location ? (
                            <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted">
                              <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-primary" />
                              {project.location.latitude.toFixed(6)}, {project.location.longitude.toFixed(6)} · {project.location.radius_meters} m
                            </span>
                          ) : null}
                        </td>
                        <td data-label="Trạng thái" className="px-3 py-3"><ProjectStatusBadge active={project.active} /></td>
                        <td className="px-3 py-3">
                          <div className="flex justify-start gap-2 whitespace-nowrap">
                            <button type="button" className={buttonClass}
                              disabled={projectActionId !== null || conflict !== null || reloadBusy}
                              onClick={() => { void openProjectAction(project, "view"); }}>
                              {actionBusy ? <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin" /> :
                                <UsersRound aria-hidden="true" className="h-4 w-4" />}
                              Xem quản lý
                            </button>
                            {project.can_manage_project_master ? (
                            <button type="button" className={project.active ? dangerClass : buttonClass}
                              disabled={projectActionId !== null || conflict !== null || reloadBusy}
                              onClick={() => { void openProjectAction(project, "set-active"); }}>
                              <Power aria-hidden="true" className="h-4 w-4" />
                              {project.active ? "Ngừng" : "Kích hoạt"}
                            </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {visibleProjects.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-4 py-10 text-center text-sm text-muted">
                        {projects.length === 0
                          ? "Chưa có dự án nào. Hãy tạo dự án đầu tiên."
                          : "Không có dự án phù hợp với bộ lọc."}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
              <div className="flex flex-col gap-2 border-t border-border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <p aria-live="polite" aria-atomic="true" className="text-muted">
                  {page.total === 0
                    ? "Không có dự án phù hợp."
                    : `Hiển thị ${page.from}–${page.to} trong ${page.total} dự án phù hợp.`}
                </p>
                {page.pageCount > 1 ? (
                  <nav aria-label="Phân trang danh sách dự án" className="flex items-center gap-2">
                    <button type="button" className={buttonClass} disabled={page.page <= 1}
                      onClick={() => setProjectPage(page.page - 1)}>
                      Trang trước
                    </button>
                    <span aria-current="page" className="min-w-16 text-center text-xs text-muted">
                      {page.page}/{page.pageCount}
                    </span>
                    <button type="button" className={buttonClass}
                      disabled={page.page >= page.pageCount || conflict !== null || reloadBusy}
                      onClick={() => setProjectPage(page.page + 1)}>
                      Trang sau
                    </button>
                  </nav>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        <section ref={detailSectionRef} tabIndex={-1} aria-labelledby="project-detail-heading"
          aria-busy={detailState === "loading"}
          className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 xl:sticky xl:top-4">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-primary">Phân công</p>
              <h2 id="project-detail-heading" className="text-base font-semibold">Quản lý dự án</h2>
            </div>
            {detail ? (
              <span className="rounded-full bg-muted/10 px-2.5 py-1 text-xs font-medium text-muted">
                {assignedCount} hiệu lực
              </span>
            ) : null}
          </div>
          {detailState === "idle" ? (
            <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
              <Building2 aria-hidden="true" className="h-9 w-9 text-muted" />
              <p className="text-sm text-muted">Chọn “Xem quản lý” để mở đầy đủ phân công của dự án.</p>
            </div>
          ) : null}
          {detailState === "loading" ? (
            <p className="flex items-center gap-2 p-5 text-sm text-muted" role="status">
              <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin" />
              Đang tải phân công…
            </p>
          ) : null}
          {detailState === "error" ? (
            <div className="flex flex-col gap-3 p-5 text-sm" role="alert">
              <span className="font-medium text-red-700 dark:text-red-300">Không tải được dữ liệu quản lý dự án.</span>
              {selectedProjectId ? (
                <button type="button" className={buttonClass}
                  onClick={() => { void loadDetail(selectedProjectId); }}>
                  <RefreshCw aria-hidden="true" className="h-4 w-4" />
                  Thử lại
                </button>
              ) : null}
            </div>
          ) : null}
          {detailState === "ready" && detail ? (
            <div className="flex max-h-[42rem] flex-col gap-4 overflow-y-auto p-4">
              <div>
                <p className="font-semibold text-foreground">{detail.display_name}</p>
                <p className="mt-0.5 font-mono text-xs text-muted">{detail.project_id}</p>
                <div className="mt-2 flex items-center gap-2">
                  <ProjectStatusBadge active={detail.project_active} />
                </div>
              </div>
              <ProjectLocationSection
                location={detail.location ?? null}
                canManageProjectMaster={detail.can_manage_project_master}
                actionsDisabled={conflict !== null || reloadBusy}
                onOpenLocationDialog={() =>
                  openDialog({ kind: "location" }, { location: detail.location ?? null })
                }
              />
              {detail.can_assign_managers ? (
              <button type="button" className={primaryClass}
                disabled={conflict !== null || reloadBusy}
                onClick={() => openDialog({ kind: "assign" })}>
                <UserPlus aria-hidden="true" className="h-4 w-4" />
                Gán quản lý
              </button>
              ) : null}
              <AssignmentGroup title="Đang phụ trách" assignments={view.current}
                empty="Chưa có quản lý nào đang phụ trách." icon="current"
                managerLabel={managerLabel}
                actionsDisabled={conflict !== null || reloadBusy}
                onRevoke={detail.can_assign_managers
                  ? (assignment) => openDialog({ kind: "unassign", assignment }) : undefined} />
              <AssignmentGroup title="Sắp hiệu lực" assignments={view.future}
                empty="Chưa có phân công nào chờ ngày bắt đầu." icon="future"
                managerLabel={managerLabel}
                actionsDisabled={conflict !== null || reloadBusy}
                onRevoke={detail.can_assign_managers
                  ? (assignment) => openDialog({ kind: "unassign", assignment }) : undefined} />
              <AssignmentGroup title="Lịch sử phân công" assignments={view.history}
                empty="Chưa có lịch sử phân công." icon="history"
                managerLabel={managerLabel} actionsDisabled={conflict !== null || reloadBusy} />
            </div>
          ) : null}
        </section>
      </div>

      <Dialog.Root open={dialog.kind !== "none"}
        onOpenChange={(open) => { if (!open && !busy) closeDialog(); }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[1px]" />
          <Dialog.Content
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              dialogFocusRef.current?.focus();
            }}
            className="fixed inset-x-2 top-[max(env(safe-area-inset-top),0.5rem)] bottom-[max(env(safe-area-inset-bottom),0.5rem)] z-50 mx-auto flex w-auto max-w-xl flex-col overflow-y-auto rounded-2xl border border-border bg-surface p-4 text-foreground shadow-2xl outline-none sm:inset-x-6 sm:top-1/2 sm:bottom-auto sm:max-h-[min(90dvh,48rem)] sm:w-[min(94vw,36rem)] sm:-translate-y-1/2 sm:p-6">
            <Dialog.Close asChild>
              <button type="button" aria-label="Đóng hộp thoại"
                className="absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-muted/10 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                disabled={busy || reloadBusy}>
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </Dialog.Close>
            {notice ? (
              <p id="project-dialog-error" role="alert" aria-live="assertive"
                className="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 pr-10 text-sm font-medium text-red-800 dark:bg-red-950/30 dark:text-red-200">
                {notice}
              </p>
            ) : null}
            {dialog.kind === "create" ? (
              <form className="flex flex-col gap-4"
                onSubmit={(event) => { event.preventDefault(); void submitCreate(); }}>
                <Dialog.Title className="pr-10 text-lg font-semibold">Tạo dự án</Dialog.Title>
                <Dialog.Description className="text-sm text-muted">
                  Mã dự án không thể đổi sau khi tạo.
                </Dialog.Description>
                <Field id="project-id" label="Mã dự án">
                  <input ref={focusDialogInput} id="project-id" className={inputClass} required
                    maxLength={128} autoComplete="off" value={projectId}
                    onChange={(event) => setProjectId(event.target.value)} />
                </Field>
                <Field id="project-name" label="Tên dự án">
                  <input id="project-name" className={inputClass} required maxLength={200} value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)} />
                </Field>
                <ReasonField id={reasonId} value={reason} onChange={setReason} />
                <DialogActions busy={busy || reloadBusy} locked={conflict !== null}
                  onCancel={closeDialog} submitLabel="Tạo dự án" />
              </form>
            ) : null}

            {dialog.kind === "rename" ? (
              <form className="flex flex-col gap-4"
                onSubmit={(event) => { event.preventDefault(); void submitRename(); }}>
                <Dialog.Title className="pr-10 text-lg font-semibold">Đổi tên dự án</Dialog.Title>
                <Dialog.Description className="text-sm text-muted">
                  Nhập tên mới. Lý do thao tác không bắt buộc.
                </Dialog.Description>
                <Field id="rename-name" label="Tên dự án">
                  <input ref={focusDialogInput} id="rename-name" className={inputClass}
                    required maxLength={200} value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)} />
                </Field>
                <ReasonField id={reasonId} value={reason} onChange={setReason} />
                <DialogActions busy={busy || reloadBusy} locked={conflict !== null}
                  onCancel={closeDialog} submitLabel="Lưu" />
              </form>
            ) : null}

            {dialog.kind === "set-active" ? (
              <form className="flex flex-col gap-4"
                onSubmit={(event) => { event.preventDefault(); void submitSetActive(dialog.active); }}>
                <Dialog.Title className="pr-10 text-lg font-semibold">
                  {dialog.active ? "Kích hoạt dự án" : "Ngừng hoạt động dự án"}
                </Dialog.Title>
                <Dialog.Description className="text-sm text-muted">
                  {dialog.active
                    ? "Dự án sẽ xuất hiện trở lại trong các danh mục đang hoạt động."
                    : "Dự án được giữ nguyên lịch sử và có thể kích hoạt lại sau này."}
                </Dialog.Description>
                <ReasonField id={reasonId} value={reason} onChange={setReason} inputRef={focusDialogInput} />
                <DialogActions busy={busy || reloadBusy} locked={conflict !== null} onCancel={closeDialog}
                  submitLabel={dialog.active ? "Kích hoạt" : "Ngừng hoạt động"} />
              </form>
            ) : null}

            {dialog.kind === "location" ? (
              <form className="flex flex-col gap-4"
                onSubmit={(event) => { event.preventDefault(); void submitUpdateLocation(false); }}>
                <Dialog.Title className="pr-10 text-lg font-semibold">Tọa độ dự án</Dialog.Title>
                <Dialog.Description className="text-sm text-muted">
                  Cấu hình địa chỉ, tọa độ GPS và bán kính chấm công cho dự án ({PROJECT_LOCATION_MIN_RADIUS_METERS}–{PROJECT_LOCATION_MAX_RADIUS_METERS} m, mặc định {PROJECT_LOCATION_DEFAULT_RADIUS_METERS} m). Vĩ độ và kinh độ phải cùng có hoặc cùng để trống.
                </Dialog.Description>
                {detail?.location?.confirmed_at ? (
                  <p className="rounded-lg border border-border bg-muted/5 px-3 py-2 text-xs text-muted">
                    Thời điểm xác nhận tọa độ: <span className="font-medium text-foreground">{formatProjectLocationTimestamp(detail.location.confirmed_at)}</span>
                  </p>
                ) : null}
                <Field id="project-location-address" label="Địa chỉ dự án" hint="Tối đa 500 ký tự.">
                  <input
                    ref={focusDialogInput}
                    id="project-location-address"
                    className={inputClass}
                    maxLength={PROJECT_LOCATION_ADDRESS_MAX}
                    value={locationAddress}
                    placeholder="Số nhà, đường, phường/xã, quận/huyện, tỉnh/thành…"
                    onChange={(event) => setLocationAddress(event.target.value)}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field id="project-location-latitude" label="Vĩ độ (Latitude)" hint="-90 đến 90">
                    <input
                      id="project-location-latitude"
                      className={inputClass}
                      inputMode="decimal"
                      value={locationLatitude}
                      placeholder="10.776889"
                      onChange={(event) => setLocationLatitude(event.target.value)}
                    />
                  </Field>
                  <Field id="project-location-longitude" label="Kinh độ (Longitude)" hint="-180 đến 180">
                    <input
                      id="project-location-longitude"
                      className={inputClass}
                      inputMode="decimal"
                      value={locationLongitude}
                      placeholder="106.700806"
                      onChange={(event) => setLocationLongitude(event.target.value)}
                    />
                  </Field>
                </div>
                <Field
                  id="project-location-radius"
                  label="Bán kính chấm công (m)"
                  hint={`Từ ${PROJECT_LOCATION_MIN_RADIUS_METERS} đến ${PROJECT_LOCATION_MAX_RADIUS_METERS} m (mặc định ${PROJECT_LOCATION_DEFAULT_RADIUS_METERS} m).`}
                >
                  <input
                    id="project-location-radius"
                    type="number"
                    min={PROJECT_LOCATION_MIN_RADIUS_METERS}
                    max={PROJECT_LOCATION_MAX_RADIUS_METERS}
                    step={1}
                    className={inputClass}
                    value={locationRadius}
                    onChange={(event) => setLocationRadius(event.target.value)}
                  />
                </Field>
                {detail?.location ? (
                  <div className="flex justify-start">
                    <button
                      type="button"
                      className={dangerClass}
                      disabled={busy || reloadBusy || conflict !== null}
                      onClick={() => { void submitUpdateLocation(true); }}
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                      Xóa vị trí dự án
                    </button>
                  </div>
                ) : null}
                <ReasonField id={reasonId} value={reason} onChange={setReason} />
                <DialogActions busy={busy || reloadBusy} locked={conflict !== null}
                  onCancel={closeDialog} submitLabel="Lưu tọa độ" />
              </form>
            ) : null}

            {dialog.kind === "assign" ? (
              <form className="flex flex-col gap-4"
                onSubmit={(event) => { event.preventDefault(); void submitAssign(); }}>
                <Dialog.Title className="pr-10 text-lg font-semibold">Gán quản lý dự án</Dialog.Title>
                <Dialog.Description className="text-sm text-muted">
                  Các phân công được xử lý lần lượt; nếu một bước lỗi, hãy tải lại để xem phần đã áp dụng.
                </Dialog.Description>
                <Field id="manager-search" label="Tìm quản lý (tên hoặc mã)"
                  hint="Chọn một người trong danh sách; giá trị lưu là recruiter_id (server enforce verified link).">
                  <input ref={focusDialogInput} id="manager-search" className={inputClass}
                    value={candidateSearch} maxLength={256} autoComplete="off" role="combobox"
                    aria-autocomplete="list" aria-expanded={candidates.length > 0}
                    aria-controls="manager-candidate-list"
                    aria-activedescendant={candidates[activeCandidateIndex]
                      ? "manager-option-" + candidates[activeCandidateIndex].recruiter_id : undefined}
                    aria-describedby={"manager-search-hint" +
                      (candidateState === "error" ? " manager-search-error" : "")}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown" && candidates.length > 0) {
                        event.preventDefault();
                        setActiveCandidateIndex((activeCandidateIndex + 1) % candidates.length);
                      } else if (event.key === "ArrowUp" && candidates.length > 0) {
                        event.preventDefault();
                        setActiveCandidateIndex((activeCandidateIndex - 1 + candidates.length) % candidates.length);
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        const candidate = candidates[activeCandidateIndex];
                        if (candidate) {
                          setManagerId(candidate.recruiter_id);
                          setCandidateSearch(candidateLabel(candidate));
                          setCandidates([]);
                        }
                      } else if (event.key === "Escape" && candidates.length > 0) {
                        event.preventDefault();
                        candidateRequestRef.current += 1;
                        setCandidates([]);
                      }
                    }}
                    onChange={(event) => {
                      setCandidateSearch(event.target.value);
                      setManagerId("");
                      setCandidates([]);
                      setActiveCandidateIndex(0);
                      void loadCandidates(event.target.value);
                    }} />
                  {candidateState === "loading" ? (
                    <span className="text-xs text-muted" role="status">Đang tìm tài khoản quản lý…</span>
                  ) : null}
                  {candidates.length > 0 ? (
                    <ul id="manager-candidate-list" role="listbox" aria-label="Danh sách ứng viên"
                      className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-lg border border-border bg-surface p-1 text-sm shadow-sm">
                      {candidates.map((candidate, index) => (
                        <li key={candidate.recruiter_id}
                          id={"manager-option-" + candidate.recruiter_id}
                          role="option" aria-selected={index === activeCandidateIndex}
                          className="cursor-pointer rounded-md px-2 py-2 hover:bg-muted/10"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setManagerId(candidate.recruiter_id);
                            setCandidateSearch(candidateLabel(candidate));
                            setCandidates([]);
                          }}>
                          {candidateLabel(candidate)}
                          {candidate.personnel_position ? " · " + candidate.personnel_position : ""}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {candidateState === "ready" && candidates.length === 0 && managerId === "" && candidateSearch.trim() !== "" ? (
                    <span className="text-xs text-muted" role="status" aria-live="polite">
                      Không tìm thấy tài khoản phù hợp.
                    </span>
                  ) : null}
                  {candidateState === "error" ? (
                    <span id="manager-search-error" className="text-xs font-medium text-red-700 dark:text-red-300"
                      role="alert" aria-live="polite">
                      Không tải được danh sách quản lý. Hãy thử tìm lại.
                    </span>
                  ) : null}
                  {managerId ? (
                    <span className="text-xs font-medium text-emerald-700 dark:text-emerald-300" role="status">
                      Đã chọn: {managerLabel(managerId)}
                    </span>
                  ) : null}
                </Field>
                <div className="rounded-md border border-border bg-surface-muted/40 px-3 py-2 text-xs text-muted">
                  Ngày hiệu lực phân công được hệ thống áp dụng ngay theo ngày nghiệp vụ hiện tại (giờ Việt Nam).
                </div>
                <button type="button" className={buttonClass}
                  disabled={!managerId}
                  onClick={() => {
                    setPending([...pending, { managerRecruiterId: managerId, validFrom: null }]);
                    setManagerId("");
                    setCandidateSearch("");
                  }}>
                  Thêm vào danh sách
                </button>
                <ul aria-label="Danh sách quản lý sẽ gán" className="flex flex-col gap-1 text-sm">
                  {pending.map((row, index) => (
                    <li key={row.managerRecruiterId + String(index)}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/5 p-2">
                      <span>{managerLabel(row.managerRecruiterId) + (row.validFrom ? " · " + row.validFrom : "")}</span>
                      <button type="button" className={buttonClass}
                        onClick={() => setPending(pending.filter((_, i) => i !== index))}>
                        Bỏ
                      </button>
                    </li>
                  ))}
                </ul>
                <ReasonField id={reasonId} value={reason} onChange={setReason} />
                <DialogActions busy={busy || reloadBusy} locked={conflict !== null}
                  onCancel={closeDialog} submitLabel="Gán quản lý" />
              </form>
            ) : null}

            {dialog.kind === "unassign" ? (
              <form className="flex flex-col gap-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitUnassign(dialog.assignment);
                }}>
                <Dialog.Title className="pr-10 text-lg font-semibold">Thu hồi phân công</Dialog.Title>
                <Dialog.Description className="text-sm text-muted">
                  {"Quản lý: " + managerLabel(dialog.assignment.manager_recruiter_id)}
                </Dialog.Description>
                <ReasonField id={reasonId} value={reason} onChange={setReason} inputRef={focusDialogInput} />
                <DialogActions busy={busy || reloadBusy} locked={conflict !== null}
                  onCancel={closeDialog} submitLabel="Thu hồi" />
              </form>
            ) : null}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </main>
  );
}

function ReasonField({
  id, value, onChange, inputRef,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  inputRef?: (element: HTMLTextAreaElement | null) => void;
}) {
  return (
    <Field id={id} label="Lý do thao tác (không bắt buộc)" hint="Không bắt buộc.">
      <textarea ref={inputRef} id={id} maxLength={REASON_MAX} aria-describedby={id + "-hint"}
        className="min-h-24 w-full rounded-lg border border-border bg-surface p-3 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        value={value}
        onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}

function DialogActions({
  busy, locked, onCancel, submitLabel,
}: { busy: boolean; locked: boolean; onCancel: () => void; submitLabel: string }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 -mb-4 mt-1 flex flex-col-reverse gap-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:mb-0 sm:flex-row sm:justify-end sm:bg-transparent sm:px-0 sm:py-0">
      <button type="button" className={buttonClass} onClick={onCancel} disabled={busy}>
        Huỷ
      </button>
      <button type="submit" className={primaryClass} disabled={busy || locked} aria-busy={busy}>
        {busy ? <RefreshCw aria-hidden="true" className="h-4 w-4 animate-spin" /> : null}
        {busy ? "Đang xử lý…" : submitLabel}
      </button>
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  tone = "primary",
}: {
  label: string;
  value: number;
  tone?: "primary" | "success" | "muted";
}) {
  const toneClass = tone === "success"
    ? "text-emerald-700 dark:text-emerald-300"
    : tone === "muted" ? "text-muted" : "text-primary";
  return (
    <div className="rounded-xl border border-border bg-surface/80 px-4 py-3 shadow-sm">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className={"mt-1 text-2xl font-bold " + toneClass}>{value}</dd>
    </div>
  );
}

function ProjectStatusBadge({ active }: { active: boolean }) {
  return (
    <span className={
      "inline-flex whitespace-nowrap items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold " +
      (active
        ? "border-emerald-500/25 bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200"
        : "border-border bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200")
    }>
      <span aria-hidden="true" className={"h-1.5 w-1.5 shrink-0 rounded-full " + (active ? "bg-emerald-500" : "bg-slate-400")} />
      {projectStatusLabel(active)}
    </span>
  );
}

function formatProjectLocationTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    dateStyle: "short",
    timeStyle: "short",
  }).format(parsed);
}

function ProjectLocationSection({
  location,
  canManageProjectMaster,
  actionsDisabled,
  onOpenLocationDialog,
}: {
  location: ProjectLocationView | null;
  canManageProjectMaster: boolean;
  actionsDisabled: boolean;
  onOpenLocationDialog: () => void;
}) {
  return (
    <section className="rounded-xl border border-border bg-muted/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <MapPin aria-hidden="true" className="h-4 w-4 text-primary" />
          Tọa độ dự án
        </h3>
        {canManageProjectMaster ? (
          <button
            type="button"
            className={buttonClass + " min-h-9 px-2.5 text-xs"}
            disabled={actionsDisabled}
            onClick={onOpenLocationDialog}
          >
            <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
            {location ? "Cập nhật tọa độ" : "Cấu hình tọa độ"}
          </button>
        ) : null}
      </div>
      {location ? (
        <dl className="mt-2.5 grid gap-1.5 text-xs">
          <div>
            <dt className="text-muted">Địa chỉ</dt>
            <dd className="font-medium text-foreground">
              {location.address ?? "Chưa nhập địa chỉ"}
            </dd>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <dt className="text-muted">Tọa độ (Lat, Lon)</dt>
              <dd className="font-mono font-medium text-foreground">
                {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Bán kính</dt>
              <dd className="font-medium text-foreground">{location.radius_meters} m</dd>
            </div>
          </div>
          {location.confirmed_at ? (
            <div>
              <dt className="text-muted">Xác nhận lúc</dt>
              <dd className="font-medium text-foreground">
                {formatProjectLocationTimestamp(location.confirmed_at)}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="mt-2 text-xs text-muted">Chưa cấu hình tọa độ vị trí cho dự án này.</p>
      )}
    </section>
  );
}

function AssignmentGroup({
  title,
  assignments,
  empty,
  icon,
  managerLabel,
  actionsDisabled,
  onRevoke,
}: {
  title: string;
  assignments: AssignmentView[];
  empty: string;
  icon: "current" | "future" | "history";
  managerLabel: (recruiterId: string) => string;
  actionsDisabled: boolean;
  onRevoke?: (assignment: AssignmentView) => void;
}) {
  const Icon = icon === "history" ? History : UsersRound;
  return (
    <section className="rounded-xl border border-border bg-muted/5 p-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Icon aria-hidden="true" className="h-4 w-4 text-primary" />
        {title}
        <span className="ml-auto rounded-full bg-surface px-2 py-0.5 text-xs text-muted shadow-sm">
          {assignments.length}
        </span>
      </h3>
      {assignments.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{empty}</p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {assignments.map((assignment) => (
            <li key={assignment.assignment_id}
              className="rounded-lg border border-border bg-surface p-3 text-sm shadow-sm">
              <span className="block font-semibold text-foreground">
                {managerLabel(assignment.manager_recruiter_id)}
              </span>
              <span className="mt-1 block text-xs text-muted">
                {assignment.revoked_at !== null
                  ? "Đã thu hồi · " + assignment.valid_from + " → " + assignment.valid_to
                  : assignment.valid_to !== null
                    ? "Đã kết thúc · " + assignment.valid_from + " → " + assignment.valid_to
                    : assignment.effective
                      ? "Hiệu lực từ " + assignment.valid_from
                      : "Sắp hiệu lực từ " + assignment.valid_from}
              </span>
              {onRevoke ? (
                <div className="mt-2.5 flex justify-end">
                  <button type="button" className={dangerClass + " min-h-11 whitespace-nowrap px-3 text-xs sm:min-h-9"}
                    disabled={actionsDisabled}
                    onClick={() => onRevoke(assignment)}>
                    Thu hồi phân công
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
