"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import { useWp4WorkspaceGuard } from "@/components/admin/wp4-workspace-guard";
import { EmptyState } from "@/components/reporting/empty-state";
import { ErrorState } from "@/components/reporting/error-state";
import { Alert } from "@/components/ui/alert";
import { StatusBadge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterToolbar } from "@/components/ui/filter-toolbar";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { PageHeader, PageShell } from "@/components/ui/page-shell";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  classifyPermissionGroupMutationResponse,
  classifyPermissionGroupReadError,
  DEPARTMENT_GROUP_ALLOWED_CAPABILITIES,
  groupDescriptorsByCategory,
  groupModuleRoleDescriptorsByCategory,
  newGroupMutationIdempotencyKey,
  projectPermissionGroupsEnvelope,
  suggestGroupCodeFromName,
  summarizeGroupBusinessActions,
  TEAM_GROUP_ALLOWED_CAPABILITIES,
  type Capability,
  type PermissionGroupModuleRole,
  type PermissionGroupSummary,
} from "@/lib/admin/permission-group-ui-model";
import {
  projectUserDirectoryListEnvelope,
  resolveUserDirectoryDetailHref,
  type UserDirectoryEntrySummary,
} from "@/lib/admin/user-directory-ui-model";
import {
  projectDepartmentListResponse,
  type DepartmentProjection,
} from "@/lib/departments/department-contract";

type TeamOption = {
  team_id: string;
  code: string;
  name: string;
  active: boolean;
};

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; groups: readonly PermissionGroupSummary[] }
  | { kind: "denied"; message: string; unauthenticated: boolean }
  | { kind: "error"; message: string; retryable: boolean };

type EditorMode =
  | { kind: "create" }
  | { kind: "edit"; group: PermissionGroupSummary };

function unwrapDepartmentsOk(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return null;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== "ok") rest[k] = v;
  }
  return rest;
}

function extractTeams(payload: unknown): TeamOption[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const rec = payload as Record<string, unknown>;
  const rawList = Array.isArray(rec.teams)
    ? rec.teams
    : typeof rec.list === "object" &&
        rec.list !== null &&
        Array.isArray((rec.list as Record<string, unknown>).teams)
      ? ((rec.list as Record<string, unknown>).teams as unknown[])
      : [];
  const out: TeamOption[] = [];
  for (const item of rawList) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const teamId = typeof row.team_id === "string" ? row.team_id : typeof row.id === "string" ? row.id : null;
    const code = typeof row.code === "string" ? row.code : typeof row.team_code === "string" ? row.team_code : "";
    const name = typeof row.name === "string" ? row.name : typeof row.team_name === "string" ? row.team_name : "";
    const active = row.active !== false && row.is_active !== false;
    if (teamId && name) {
      out.push({ team_id: teamId, code, name, active });
    }
  }
  return out;
}

function moduleRoleKey(role: PermissionGroupModuleRole): string {
  return `${role.module_code}:${role.role_code}`;
}

export function PermissionGroupsManager() {
  const notify = useNotify();
  const workspaceGuard = useWp4WorkspaceGuard();

  const searchId = useId();
  const deptFilterId = useId();
  const nameId = useId();
  const codeId = useId();
  const descId = useId();
  const deptSelectId = useId();
  const teamSelectId = useId();
  const reasonId = useId();
  const memberSearchId = useId();

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [departments, setDepartments] = useState<readonly DepartmentProjection[]>([]);
  const [teams, setTeams] = useState<readonly TeamOption[]>([]);
  const [reloadToken, setReloadToken] = useState(0);

  const [searchInput, setSearchInput] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  const [includeInactive, setIncludeInactive] = useState(false);

  // Editor state
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupCode, setGroupCode] = useState("");
  const [codeEditedManually, setCodeEditedManually] = useState(false);
  const [groupDescription, setGroupDescription] = useState("");
  const [selectedDepartmentId, setSelectedDepartmentId] = useState("");
  const [selectedTeamId, setSelectedTeamId] = useState("");
  const [groupActive, setGroupActive] = useState(true);
  const [selectedCaps, setSelectedCaps] = useState<Capability[]>([]);
  const [selectedModuleRoles, setSelectedModuleRoles] = useState<PermissionGroupModuleRole[]>([]);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflictLocked, setConflictLocked] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "error" | "warning" | "info";
    title: string;
    message: string;
  } | null>(null);

  // Members modal state
  const [membersGroup, setMembersGroup] = useState<PermissionGroupSummary | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [candidateEntries, setCandidateEntries] = useState<readonly UserDirectoryEntrySummary[]>([]);
  const [loadingCandidates, setLoadingCandidates] = useState(false);
  const [memberBusyRef, setMemberBusyRef] = useState<string | null>(null);
  const [memberFeedback, setMemberFeedback] = useState<{
    tone: "error" | "warning" | "info";
    title: string;
    message: string;
  } | null>(null);

  const seqRef = useRef(0);
  const inFlightRef = useRef(false);

  const handleSessionLost = useCallback(
    (message: string, unauthenticated = false) => {
      inFlightRef.current = false;
      workspaceGuard.invalidateSession();
      seqRef.current += 1;
      setEditor(null);
      setMembersGroup(null);
      setBusy(false);
      setState({ kind: "denied", message, unauthenticated });
    },
    [workspaceGuard],
  );

  // Load groups
  useEffect(() => {
    const reqSeq = ++seqRef.current;
    const tracked = workspaceGuard.trackController();

    void (async () => {
      await Promise.resolve();
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== seqRef.current) {
        tracked.release();
        return;
      }
      setState({ kind: "loading" });
      try {
        const qs = new URLSearchParams({
          include_inactive: includeInactive ? "true" : "false",
        });
        if (departmentFilter !== "all") {
          qs.set("department_id", departmentFilter);
        }
        const response = await fetch(`/api/admin/access/groups?${qs.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== seqRef.current) {
          return;
        }
        const payload = await response.json().catch(() => null);
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== seqRef.current) {
          return;
        }
        if (response.status !== 200) {
          const failure = classifyPermissionGroupReadError(response.status, payload);
          if (failure.kind === "unauthenticated" || failure.kind === "denied") {
            handleSessionLost(failure.message, failure.kind === "unauthenticated");
            return;
          }
          setState({ kind: "error", message: failure.message, retryable: failure.retryable });
          return;
        }
        const projected = projectPermissionGroupsEnvelope(payload);
        if (!projected) {
          setState({
            kind: "error",
            message: "Dữ liệu danh sách nhóm quyền không hợp lệ.",
            retryable: true,
          });
          return;
        }
        setState({ kind: "ready", groups: projected.groups });
        setMembersGroup((prev) =>
          prev ? projected.groups.find((g) => g.group_id === prev.group_id) ?? prev : null,
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller) || reqSeq !== seqRef.current) {
          return;
        }
        setState({
          kind: "error",
          message: "Không thể kết nối máy chủ để tải danh sách nhóm quyền.",
          retryable: true,
        });
      } finally {
        tracked.release();
      }
    })();

    return () => {
      seqRef.current += 1;
      tracked.controller.abort();
      tracked.release();
    };
  }, [departmentFilter, handleSessionLost, includeInactive, reloadToken, workspaceGuard]);

  // Load departments & recruitment teams once
  useEffect(() => {
    const tracked = workspaceGuard.trackController();
    void (async () => {
      try {
        const [deptRes, teamRes] = await Promise.all([
          fetch("/api/admin/departments?include_inactive=true", {
            method: "GET",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: { Accept: "application/json" },
          }),
          fetch("/api/admin/catalog/teams?page=1&page_size=100", {
            method: "GET",
            cache: "no-store",
            signal: tracked.controller.signal,
            headers: { Accept: "application/json" },
          }),
        ]);
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
        if (deptRes.status === 200) {
          const deptPayload = await deptRes.json().catch(() => null);
          const rest = unwrapDepartmentsOk(deptPayload);
          const projected = rest ? projectDepartmentListResponse(rest) : null;
          if (projected) setDepartments(projected.departments);
        }
        if (teamRes.status === 200) {
          const teamPayload = await teamRes.json().catch(() => null);
          setTeams(extractTeams(teamPayload));
        }
      } catch {
        // Optional dropdowns degrade cleanly.
      } finally {
        tracked.release();
      }
    })();
    return () => {
      tracked.controller.abort();
      tracked.release();
    };
  }, [workspaceGuard]);

  // Load candidate users when members modal is open
  useEffect(() => {
    if (!membersGroup) return;
    const tracked = workspaceGuard.trackController();
    void (async () => {
      await Promise.resolve();
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) {
        tracked.release();
        return;
      }
      setLoadingCandidates(true);
      try {
        const qs = new URLSearchParams({
          login_state: "enabled",
          page: "1",
          page_size: "50",
        });
        const term = memberSearch.trim();
        if (term.length > 0) qs.set("search", term);
        const response = await fetch(`/api/admin/organization/user-directory?${qs.toString()}`, {
          method: "GET",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
        if (response.status === 200) {
          const payload = await response.json().catch(() => null);
          const projected = projectUserDirectoryListEnvelope(payload);
          if (projected) {
            setCandidateEntries(projected.entries);
          }
        }
      } catch {
        // Handled cleanly in modal state
      } finally {
        tracked.release();
        setLoadingCandidates(false);
      }
    })();
    return () => {
      tracked.controller.abort();
      tracked.release();
    };
  }, [memberSearch, membersGroup, reloadToken, workspaceGuard]);

  const reloadNow = useCallback(() => {
    setReloadToken((v) => v + 1);
  }, []);

  const selectedDeptObj = useMemo(
    () => departments.find((d) => d.department_id === selectedDepartmentId) ?? null,
    [departments, selectedDepartmentId],
  );
  const canSelectTeam = selectedDeptObj?.system_key === "RECRUITMENT";
  const isTeamScoped = canSelectTeam && selectedTeamId.trim().length > 0;

  const allowedCapabilities = isTeamScoped
    ? TEAM_GROUP_ALLOWED_CAPABILITIES
    : DEPARTMENT_GROUP_ALLOWED_CAPABILITIES;
  const capabilityCategories = useMemo(
    () => groupDescriptorsByCategory(allowedCapabilities),
    [allowedCapabilities],
  );
  const moduleRoleCategories = useMemo(() => groupModuleRoleDescriptorsByCategory(), []);

  const openCreateModal = () => {
    const firstActiveDept = departments.find((d) => d.is_active) ?? departments[0] ?? null;
    setGroupName("");
    setGroupCode("");
    setCodeEditedManually(false);
    setGroupDescription("");
    setSelectedDepartmentId(firstActiveDept?.department_id ?? "");
    setSelectedTeamId("");
    setGroupActive(true);
    setSelectedCaps([]);
    setSelectedModuleRoles([]);
    setReason("");
    setPendingKey(null);
    setConflictLocked(false);
    setFeedback(null);
    setEditor({ kind: "create" });
  };

  const openEditModal = (group: PermissionGroupSummary) => {
    if (group.is_system_admin) return;
    setGroupName(group.name);
    setGroupCode(group.code);
    setCodeEditedManually(true);
    setGroupDescription(group.description);
    setSelectedDepartmentId(group.department_id);
    setSelectedTeamId(group.team_id ?? "");
    setGroupActive(group.active);
    setSelectedCaps([...group.capabilities]);
    setSelectedModuleRoles([...group.module_roles]);
    setReason("");
    setPendingKey(null);
    setConflictLocked(false);
    setFeedback(null);
    setEditor({ kind: "edit", group });
  };

  const closeEditor = () => {
    if (busy) return;
    setEditor(null);
    setFeedback(null);
    setPendingKey(null);
    setConflictLocked(false);
  };

  const toggleCapability = (cap: Capability) => {
    setSelectedCaps((prev) =>
      prev.includes(cap) ? prev.filter((item) => item !== cap) : [...prev, cap],
    );
  };

  const toggleModuleRole = (role: PermissionGroupModuleRole) => {
    const targetKey = moduleRoleKey(role);
    setSelectedModuleRoles((prev) =>
      prev.some((item) => moduleRoleKey(item) === targetKey)
        ? prev.filter((item) => moduleRoleKey(item) !== targetKey)
        : [...prev, role],
    );
  };

  const submitGroupForm = async (event: FormEvent) => {
    event.preventDefault();
    if (!editor || inFlightRef.current || busy || conflictLocked) return;

    const trimmedName = groupName.trim();
    const trimmedCode = groupCode.trim().toUpperCase();
    const trimmedDesc = groupDescription.trim();
    const trimmedReason = reason.trim();

    if (trimmedName.length < 2) {
      setFeedback({
        tone: "error",
        title: "Thiếu tên nhóm quyền",
        message: "Tên nhóm quyền cần tối thiểu 2 ký tự.",
      });
      return;
    }
    if (editor.kind === "create" && !/^[A-Z][A-Z0-9_]{2,63}$/.test(trimmedCode)) {
      setFeedback({
        tone: "error",
        title: "Mã nhóm chưa hợp lệ",
        message: "Mã nhóm gồm 3–64 ký tự in hoa, số hoặc gạch dưới (bắt đầu bằng chữ cái).",
      });
      return;
    }
    if (!selectedDepartmentId) {
      setFeedback({
        tone: "error",
        title: "Chưa chọn phòng ban",
        message: "Mỗi nhóm quyền bắt buộc gắn với một phòng ban.",
      });
      return;
    }

    const allowedSet = new Set<Capability>(allowedCapabilities);
    const filteredCaps = selectedCaps.filter((c) => allowedSet.has(c));
    const filteredModuleRoles = isTeamScoped ? [] : selectedModuleRoles;
    const idempotencyKey = pendingKey ?? newGroupMutationIdempotencyKey();

    setPendingKey(idempotencyKey);
    setFeedback(null);
    inFlightRef.current = true;
    setBusy(true);
    const tracked = workspaceGuard.trackController();

    try {
      const url =
        editor.kind === "create"
          ? "/api/admin/access/groups"
          : `/api/admin/access/groups/${encodeURIComponent(editor.group.group_id)}`;
      const method = editor.kind === "create" ? "POST" : "PATCH";
      const body =
        editor.kind === "create"
          ? {
              code: trimmedCode,
              name: trimmedName,
              description: trimmedDesc,
              department_id: selectedDepartmentId,
              team_id: canSelectTeam && selectedTeamId ? selectedTeamId : null,
              capabilities: filteredCaps,
              module_roles: filteredModuleRoles,
              reason: trimmedReason.length > 0 ? trimmedReason : null,
              idempotency_key: idempotencyKey,
            }
          : {
              name: trimmedName,
              description: trimmedDesc,
              department_id: selectedDepartmentId,
              team_id: canSelectTeam && selectedTeamId ? selectedTeamId : null,
              active: groupActive,
              capabilities: filteredCaps,
              module_roles: filteredModuleRoles,
              expected_version: editor.group.version,
              reason: trimmedReason.length > 0 ? trimmedReason : null,
              idempotency_key: idempotencyKey,
            };

      const response = await fetch(url, {
        method,
        cache: "no-store",
        signal: tracked.controller.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
      });
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      const payload = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;

      const outcome = classifyPermissionGroupMutationResponse(response.status, payload);
      if (outcome.kind === "session-lost") {
        handleSessionLost(outcome.message, outcome.unauthenticated);
        return;
      }
      if (outcome.kind === "applied") {
        setPendingKey(null);
        setEditor(null);
        notify.success({
          title: editor.kind === "create" ? "Đã tạo nhóm quyền mới" : "Đã cập nhật nhóm quyền",
          description: "Thay đổi sẽ áp dụng cho thành viên của nhóm từ yêu cầu tiếp theo.",
        });
        reloadNow();
        return;
      }
      if (outcome.kind === "conflict") {
        setPendingKey(null);
        setConflictLocked(outcome.needsReload);
        setFeedback({ tone: "warning", title: "Dữ liệu đã thay đổi", message: outcome.message });
        return;
      }
      if (outcome.kind === "invalid") {
        setPendingKey(null);
        setFeedback({ tone: "error", title: "Không lưu được nhóm quyền", message: outcome.message });
        return;
      }
      setFeedback({
        tone: "warning",
        title: "Chưa nhận được xác nhận từ máy chủ",
        message: outcome.message,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      setFeedback({
        tone: "warning",
        title: "Mất kết nối mạng",
        message: "Bấm lưu lần nữa để đồng bộ an toàn mà không tạo trùng nhóm quyền.",
      });
    } finally {
      tracked.release();
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const quickAssignMember = async (entry: UserDirectoryEntrySummary) => {
    if (!membersGroup || !entry.account || memberBusyRef) return;
    setMemberFeedback(null);
    setMemberBusyRef(entry.account.account_ref);
    const idempotencyKey = newGroupMutationIdempotencyKey();
    const tracked = workspaceGuard.trackController();
    try {
      const response = await fetch(
        `/api/admin/access/accounts/${encodeURIComponent(entry.account.account_ref)}/groups`,
        {
          method: "POST",
          cache: "no-store",
          signal: tracked.controller.signal,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            group_id: membersGroup.group_id,
            expected_account_version: entry.account.version,
            reason: `Thêm vào nhóm ${membersGroup.name}`,
            idempotency_key: idempotencyKey,
          }),
        },
      );
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      const payload = await response.json().catch(() => null);
      if (!workspaceGuard.isActive(tracked.epoch, tracked.controller)) return;
      const outcome = classifyPermissionGroupMutationResponse(response.status, payload);
      if (outcome.kind === "session-lost") {
        handleSessionLost(outcome.message, outcome.unauthenticated);
        return;
      }
      if (outcome.kind === "applied") {
        notify.success({
          title: `Đã thêm ${entry.display_name} vào nhóm ${membersGroup.name}`,
        });
        reloadNow();
        return;
      }
      setMemberFeedback({
        tone: "warning",
        title: "Không thêm được thành viên",
        message: outcome.message,
      });
    } catch {
      setMemberFeedback({
        tone: "warning",
        title: "Mất kết nối mạng",
        message: "Không thể cập nhật thành viên lúc này. Vui lòng thử lại.",
      });
    } finally {
      tracked.release();
      setMemberBusyRef(null);
    }
  };

  const visibleGroups = useMemo(() => {
    if (state.kind !== "ready") return [];
    const term = searchInput.trim().toLowerCase();
    if (!term) return state.groups;
    return state.groups.filter(
      (g) =>
        g.name.toLowerCase().includes(term) ||
        g.department_name.toLowerCase().includes(term) ||
        (g.team_name?.toLowerCase().includes(term) ?? false) ||
        g.description.toLowerCase().includes(term),
    );
  }, [searchInput, state]);

  return (
    <PageShell
      dataTestId="permission-groups-page"
      className="max-w-none px-0 py-0 sm:px-0 sm:py-0 lg:px-0"
    >
      <PageHeader
        eyebrow="Quản trị hệ thống · Phân quyền"
        title="Nhóm quyền"
        badge={
          state.kind === "ready" ? (
            <StatusBadge tone="primary">{state.groups.length} nhóm quyền</StatusBadge>
          ) : null
        }
        description="Quản lý các nhóm quyền theo phòng ban và tổ đội. Thêm người dùng vào nhóm để cấp đúng quyền thao tác nghiệp vụ."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              size="md"
              onClick={reloadNow}
              disabled={state.kind === "loading" || state.kind === "denied"}
            >
              Làm mới
            </Button>
            <Button
              type="button"
              variant="primary"
              size="md"
              onClick={openCreateModal}
              disabled={state.kind === "denied"}
            >
              + Tạo nhóm quyền
            </Button>
          </div>
        }
      />

      <StatusBanner tone="info" title="Nguyên tắc phân quyền theo nhóm">
        Mỗi nhóm quyền gắn với một phòng ban (và tối đa một tổ đội tuyển dụng). Quyền thao tác trên
        từng dự án, trưởng nhóm hoặc trưởng phòng tiếp tục được quản lý theo phân công công việc
        tương ứng.
      </StatusBanner>

      {state.kind !== "denied" ? (
        <FilterToolbar
          dataTestId="permission-groups-filter-toolbar"
          summary={
            state.kind === "ready" ? (
              <span>
                Hiển thị {visibleGroups.length} / {state.groups.length} nhóm quyền
              </span>
            ) : (
              <span>Lọc nhóm quyền theo từ khóa và phòng ban</span>
            )
          }
          actions={
            <label className="inline-flex items-center gap-2 text-xs text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={includeInactive}
                onChange={(e) => setIncludeInactive(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <span>Hiện nhóm đã ngừng</span>
            </label>
          }
        >
          <search>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor={searchId} className="mb-1 block text-xs font-medium text-muted">
                  Tìm kiếm nhóm quyền
                </label>
                <input
                  id={searchId}
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Tìm theo tên nhóm, phòng ban hoặc tổ đội…"
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                />
              </div>
              <div>
                <label htmlFor={deptFilterId} className="mb-1 block text-xs font-medium text-muted">
                  Phòng ban
                </label>
                <select
                  id={deptFilterId}
                  value={departmentFilter}
                  onChange={(e) => setDepartmentFilter(e.target.value)}
                  className="min-h-11 sm:min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                >
                  <option value="all">Tất cả phòng ban</option>
                  {departments.map((dept) => (
                    <option key={dept.department_id} value={dept.department_id}>
                      {dept.name} ({dept.code})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </search>
        </FilterToolbar>
      ) : null}

      {state.kind === "loading" ? (
        <Card>
          <p role="status" className="py-10 text-center text-sm text-muted">
            Đang tải danh sách nhóm quyền…
          </p>
        </Card>
      ) : null}

      {state.kind === "denied" ? (
        <Alert
          tone="error"
          role="alert"
          title={state.unauthenticated ? "Phiên đăng nhập đã hết hạn" : "Không có quyền truy cập"}
        >
          <p>{state.message}</p>
        </Alert>
      ) : null}

      {state.kind === "error" ? (
        <Card>
          <div className="space-y-3">
            <ErrorState title="Không tải được danh sách nhóm quyền" detail={state.message} />
            {state.retryable ? (
              <Button type="button" variant="secondary" onClick={reloadNow}>
                Thử tải lại
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}

      {state.kind === "ready" && visibleGroups.length === 0 ? (
        <Card>
          <EmptyState
            title="Chưa có nhóm quyền phù hợp"
            description="Thử thay đổi bộ lọc hoặc tạo nhóm quyền mới cho phòng ban."
          />
        </Card>
      ) : null}

      {state.kind === "ready" && visibleGroups.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="permission-groups-list">
          {visibleGroups.map((group) => {
            const actionLabels = summarizeGroupBusinessActions(group);
            return (
              <Card key={group.group_id} className="flex flex-col justify-between gap-4">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-foreground">{group.name}</h2>
                        {group.is_system_admin ? (
                          <StatusBadge tone="primary">Mặc định hệ thống</StatusBadge>
                        ) : null}
                        <StatusBadge tone={group.active ? "success" : "neutral"} dot>
                          {group.active ? "Đang hoạt động" : "Ngừng hoạt động"}
                        </StatusBadge>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge tone="info">{group.department_name}</StatusBadge>
                        {group.team_name ? (
                          <StatusBadge tone="neutral">Tổ đội: {group.team_name}</StatusBadge>
                        ) : null}
                        <StatusBadge tone="neutral">{group.member_count} thành viên</StatusBadge>
                      </div>
                    </div>
                  </div>

                  {group.description ? (
                    <p className="text-xs text-muted">{group.description}</p>
                  ) : null}

                  <div className="space-y-1.5">
                    <p className="text-xs font-medium text-muted">Thao tác nghiệp vụ được phép:</p>
                    {actionLabels.length === 0 ? (
                      <p className="text-xs text-muted italic">Chưa chọn thao tác nghiệp vụ nào.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {actionLabels.map((label) => (
                          <span
                            key={label}
                            className="inline-flex rounded-md border border-border/80 bg-surface-muted/35 px-2 py-0.5 text-xs text-foreground"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setMemberSearch("");
                      setMemberFeedback(null);
                      setMembersGroup(group);
                    }}
                  >
                    Thành viên ({group.member_count})
                  </Button>
                  {group.is_system_admin ? (
                    <Button type="button" variant="ghost" size="sm" disabled>
                      Cấu hình cố định
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="soft"
                      size="sm"
                      onClick={() => openEditModal(group)}
                    >
                      Chỉnh sửa
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      ) : null}

      {/* Create / Edit Group Dialog */}
      <FormDialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
        title={editor?.kind === "create" ? "Tạo nhóm quyền mới" : `Chỉnh sửa nhóm "${editor?.group.name ?? ""}"`}
        description="Chọn phòng ban (và tổ đội tuyển dụng nếu cần), sau đó đánh dấu các thao tác nghiệp vụ cho nhóm."
        closeDisabled={busy}
      >
        {editor ? (
          <form onSubmit={submitGroupForm} className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
            {feedback ? (
              <Alert tone={feedback.tone} role="alert" title={feedback.title}>
                <p>{feedback.message}</p>
                {conflictLocked ? (
                  <div className="mt-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        closeEditor();
                        reloadNow();
                      }}
                    >
                      Tải lại danh sách
                    </Button>
                  </div>
                ) : null}
              </Alert>
            ) : null}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor={nameId} className="block text-sm font-medium text-foreground">
                  Tên nhóm quyền <span aria-hidden="true">*</span>
                </label>
                <input
                  id={nameId}
                  type="text"
                  required
                  maxLength={120}
                  value={groupName}
                  disabled={busy || conflictLocked}
                  onChange={(e) => {
                    const nextName = e.target.value;
                    setGroupName(nextName);
                    if (editor.kind === "create" && !codeEditedManually) {
                      setGroupCode(suggestGroupCodeFromName(nextName));
                    }
                  }}
                  placeholder="Ví dụ: Kế toán công nợ"
                  className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                />
              </div>

              <div className="space-y-1">
                <label htmlFor={codeId} className="block text-sm font-medium text-foreground">
                  Mã nhóm <span aria-hidden="true">*</span>
                </label>
                <input
                  id={codeId}
                  type="text"
                  required
                  maxLength={64}
                  value={groupCode}
                  disabled={busy || conflictLocked || editor.kind === "edit"}
                  onChange={(e) => {
                    setCodeEditedManually(true);
                    setGroupCode(e.target.value.toUpperCase());
                  }}
                  placeholder="VI_DU_KE_TOAN"
                  className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-mono text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
                />
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor={descId} className="block text-sm font-medium text-foreground">
                Mô tả ngắn
              </label>
              <input
                id={descId}
                type="text"
                maxLength={500}
                value={groupDescription}
                disabled={busy || conflictLocked}
                onChange={(e) => setGroupDescription(e.target.value)}
                placeholder="Mô tả mục đích sử dụng của nhóm quyền…"
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor={deptSelectId} className="block text-sm font-medium text-foreground">
                  Phòng ban <span aria-hidden="true">*</span>
                </label>
                <select
                  id={deptSelectId}
                  required
                  value={selectedDepartmentId}
                  disabled={busy || conflictLocked}
                  onChange={(e) => {
                    const nextDeptId = e.target.value;
                    setSelectedDepartmentId(nextDeptId);
                    const nextDept = departments.find((d) => d.department_id === nextDeptId);
                    if (nextDept?.system_key !== "RECRUITMENT") {
                      setSelectedTeamId("");
                    }
                  }}
                  className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                >
                  <option value="">Chọn phòng ban…</option>
                  {departments.map((dept) => (
                    <option key={dept.department_id} value={dept.department_id}>
                      {dept.name} ({dept.code})
                    </option>
                  ))}
                </select>
              </div>

              {canSelectTeam ? (
                <div className="space-y-1">
                  <label htmlFor={teamSelectId} className="block text-sm font-medium text-foreground">
                    Giới hạn theo tổ đội tuyển dụng (tùy chọn)
                  </label>
                  <select
                    id={teamSelectId}
                    value={selectedTeamId}
                    disabled={busy || conflictLocked}
                    onChange={(e) => {
                      const nextTeam = e.target.value;
                      setSelectedTeamId(nextTeam);
                      if (nextTeam) {
                        const teamAllowed = new Set<Capability>(TEAM_GROUP_ALLOWED_CAPABILITIES);
                        setSelectedCaps((prev) => prev.filter((c) => teamAllowed.has(c)));
                        setSelectedModuleRoles([]);
                      }
                    }}
                    className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
                  >
                    <option value="">Toàn phòng Tuyển dụng (không giới hạn tổ)</option>
                    {teams.map((team) => (
                      <option key={team.team_id} value={team.team_id}>
                        {team.name} {team.code ? `(${team.code})` : ""}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>

            {editor.kind === "edit" ? (
              <label className="inline-flex items-center gap-2 text-sm text-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={groupActive}
                  disabled={busy || conflictLocked}
                  onChange={(e) => setGroupActive(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <span>Nhóm đang hoạt động</span>
              </label>
            ) : null}

            <div className="space-y-3 border-t border-border pt-3">
              <p className="text-sm font-semibold text-foreground">
                Thao tác nghiệp vụ của nhóm
              </p>
              {capabilityCategories.map(({ category, items }) => (
                <fieldset
                  key={category}
                  className="space-y-2 rounded-lg border border-border p-3"
                >
                  <legend className="px-1 text-xs font-semibold text-muted">{category}</legend>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {items.map((item) => {
                      const checked = selectedCaps.includes(item.capability);
                      const checkId = `cap-${item.capability}`;
                      return (
                        <div key={item.capability} className="flex items-start gap-2.5">
                          <input
                            id={checkId}
                            type="checkbox"
                            checked={checked}
                            disabled={busy || conflictLocked}
                            onChange={() => toggleCapability(item.capability)}
                            className="mt-1 h-4 w-4 shrink-0 rounded border-border"
                          />
                          <label htmlFor={checkId} className="cursor-pointer text-xs">
                            <span className="block font-medium text-foreground">{item.label}</span>
                            <span className="block text-muted">{item.description}</span>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                </fieldset>
              ))}

              {!isTeamScoped ? (
                <div className="space-y-2 pt-2">
                  <p className="text-sm font-semibold text-foreground">
                    Quyền toàn công ty theo phân hệ (Tài chính NCC &amp; Nghỉ phép)
                  </p>
                  {moduleRoleCategories.map(({ category, items }) => (
                    <fieldset
                      key={category}
                      className="space-y-2 rounded-lg border border-border p-3"
                    >
                      <legend className="px-1 text-xs font-semibold text-muted">{category}</legend>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {items.map((item) => {
                          const roleObj: PermissionGroupModuleRole =
                            item.module_code === "vendor_finance"
                              ? { module_code: "vendor_finance", role_code: item.role_code as never }
                              : { module_code: "leave", role_code: item.role_code as never };
                          const key = moduleRoleKey(roleObj);
                          const checked = selectedModuleRoles.some(
                            (r) => moduleRoleKey(r) === key,
                          );
                          const checkId = `mod-${key}`;
                          return (
                            <div key={key} className="flex items-start gap-2.5">
                              <input
                                id={checkId}
                                type="checkbox"
                                checked={checked}
                                disabled={busy || conflictLocked}
                                onChange={() => toggleModuleRole(roleObj)}
                                className="mt-1 h-4 w-4 shrink-0 rounded border-border"
                              />
                              <label htmlFor={checkId} className="cursor-pointer text-xs">
                                <span className="block font-medium text-foreground">
                                  {item.label}
                                </span>
                                <span className="block text-muted">{item.description}</span>
                              </label>
                            </div>
                          );
                        })}
                      </div>
                    </fieldset>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="space-y-1">
              <label htmlFor={reasonId} className="block text-sm font-medium text-foreground">
                Lý do thay đổi (không bắt buộc)
              </label>
              <input
                id={reasonId}
                type="text"
                maxLength={500}
                value={reason}
                disabled={busy || conflictLocked}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Ghi chú thay đổi nếu cần…"
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
              <Button type="button" variant="secondary" disabled={busy} onClick={closeEditor}>
                Đóng
              </Button>
              <Button type="submit" variant="primary" disabled={busy || conflictLocked}>
                {busy
                  ? "Đang lưu…"
                  : editor.kind === "create"
                    ? "Tạo nhóm quyền"
                    : "Lưu thay đổi"}
              </Button>
            </div>
          </form>
        ) : null}
      </FormDialog>

      {/* Group Members Dialog */}
      <FormDialog
        open={membersGroup !== null}
        onOpenChange={(open) => {
          if (!open && !memberBusyRef) setMembersGroup(null);
        }}
        title={membersGroup ? `Thành viên nhóm "${membersGroup.name}"` : ""}
        description="Thêm nhanh người dùng đang mở đăng nhập vào nhóm, hoặc mở trang chi tiết người dùng để điều chỉnh đầy đủ."
        closeDisabled={memberBusyRef !== null}
      >
        {membersGroup ? (
          <div className="space-y-4">
            {memberFeedback ? (
              <Alert tone={memberFeedback.tone} role="alert" title={memberFeedback.title}>
                {memberFeedback.message}
              </Alert>
            ) : null}

            <div className="space-y-1">
              <label htmlFor={memberSearchId} className="block text-xs font-medium text-muted">
                Tìm người dùng đang mở đăng nhập để thêm vào nhóm
              </label>
              <input
                id={memberSearchId}
                type="search"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
                placeholder="Tìm theo họ tên, mã nhân viên hoặc tên đăng nhập…"
                className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30"
              />
            </div>

            {loadingCandidates ? (
              <p role="status" className="py-4 text-center text-xs text-muted">
                Đang tải danh sách người dùng…
              </p>
            ) : candidateEntries.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted">
                Không tìm thấy người dùng đang mở đăng nhập phù hợp.
              </p>
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {candidateEntries.map((entry) => {
                  const accountRef = entry.account?.account_ref ?? null;
                  const alreadyInGroup =
                    accountRef !== null && membersGroup.member_account_refs.includes(accountRef);
                  return (
                    <div
                      key={entry.directory_entry_key}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5 text-sm"
                    >
                      <div className="min-w-0">
                        <Link
                          href={resolveUserDirectoryDetailHref(entry)}
                          className="font-medium text-foreground hover:text-primary hover:underline"
                        >
                          {entry.display_name}
                        </Link>
                        <p className="font-mono text-xs text-muted">
                          {entry.account?.login_id ?? "—"}
                          {entry.person ? ` · ${entry.person.employee_code}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {alreadyInGroup ? (
                          <StatusBadge tone="success">Đã thuộc nhóm</StatusBadge>
                        ) : (
                          <Button
                            type="button"
                            variant="soft"
                            size="sm"
                            disabled={!membersGroup.active || memberBusyRef !== null}
                            onClick={() => void quickAssignMember(entry)}
                          >
                            {memberBusyRef === accountRef ? "Đang thêm…" : "+ Thêm"}
                          </Button>
                        )}
                        <Link
                          href={resolveUserDirectoryDetailHref(entry)}
                          className={buttonClasses({ variant: "ghost", size: "sm" })}
                        >
                          Chi tiết
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex justify-end border-t border-border pt-3">
              <Button
                type="button"
                variant="secondary"
                disabled={memberBusyRef !== null}
                onClick={() => setMembersGroup(null)}
              >
                Đóng
              </Button>
            </div>
          </div>
        ) : null}
      </FormDialog>
    </PageShell>
  );
}
