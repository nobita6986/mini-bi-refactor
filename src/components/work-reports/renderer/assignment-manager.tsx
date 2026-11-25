"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useRouter as readNextAppRouter,
  useSearchParams,
} from "next/navigation";
import { StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { FormDialog } from "@/components/ui/form-dialog";
import { useNotify } from "@/components/ui/notify-provider";
import { StatusBanner } from "@/components/ui/status-banner";
import {
  buildWorkReportAssignmentTabHref,
  parseWorkReportAssignmentTab,
  type WorkReportAssignmentSubTab,
} from "@/lib/work-reports/assignment-tab-model";
import type {
  WorkReportAssignmentAuditItem,
  WorkReportAssignmentProgressItem,
  WorkReportAssignmentSummary,
  WorkReportEligibleGroupUser,
  WorkReportGroupItem,
} from "@/lib/work-reports/assignment-repository";

function getOptionalAppRouter() {
  try {
    return readNextAppRouter();
  } catch {
    return null;
  }
}

type Template = {
  template_id: string;
  template_code: string;
  display_name: string;
  default_frequency: string;
  current_published_version_id: string;
};
type Team = { team_id: string; code: string; display_name: string };
type User = { app_user_id: string; display_name: string };

type GroupEditorState = {
  group: WorkReportGroupItem | null;
  display_name: string;
  description: string;
  member_user_ids: string[];
};

const controlClass =
  "min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40";

export function AssignmentManager({
  initialSubView = "assignments",
}: {
  initialSubView?: WorkReportAssignmentSubTab;
} = {}) {
  const notify = useNotify();
  const router = getOptionalAppRouter();
  const searchParams = useSearchParams();
  const [localSubView, setLocalSubView] = useState<WorkReportAssignmentSubTab>(initialSubView);
  const activeSubView: WorkReportAssignmentSubTab =
    searchParams !== null
      ? parseWorkReportAssignmentTab(searchParams.get("tab"))
      : localSubView;
  const [showCreateForm, setShowCreateForm] = useState(true);
  const [confirmingCreate, setConfirmingCreate] = useState(false);
  const [stateFilter, setStateFilter] = useState<"ACTIVE" | "PAUSED" | "REVOKED">("ACTIVE");
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null);
  const [revokeConfirmAssignment, setRevokeConfirmAssignment] =
    useState<WorkReportAssignmentSummary | null>(null);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [assignments, setAssignments] = useState<WorkReportAssignmentSummary[]>([]);
  const [groups, setGroups] = useState<WorkReportGroupItem[]>([]);
  const [eligibleUsers, setEligibleUsers] = useState<WorkReportEligibleGroupUser[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupEditor, setGroupEditor] = useState<GroupEditorState | null>(null);
  const [groupFormError, setGroupFormError] = useState<string | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [memberTeamFilter, setMemberTeamFilter] = useState("");

  const [teamId, setTeamId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [loadedTeamId, setLoadedTeamId] = useState<string | null>(null);
  const [targetKind, setTargetKind] = useState<"USER" | "TEAM" | "USER_SET" | "GROUP">("USER");
  const [targetId, setTargetId] = useState("");
  const [targetUsers, setTargetUsers] = useState<string[]>([]);
  const [targetGroupId, setTargetGroupId] = useState("");
  const [frequency, setFrequency] = useState("DAILY");
  const [dueDayOffset, setDueDayOffset] = useState("0");
  const [dueTime, setDueTime] = useState("23:59:59");
  const [effectiveFrom, setEffectiveFrom] = useState(() =>
    new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trackingLoadedTeamId, setTrackingLoadedTeamId] = useState<string | null>(null);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const [trackingBusy, setTrackingBusy] = useState(false);
  const templatesLoaded = loadedTeamId === teamId;

  function switchSubView(next: WorkReportAssignmentSubTab) {
    if (next === activeSubView) return;
    if (searchParams === null) {
      setLocalSubView(next);
    }
    const href = buildWorkReportAssignmentTabHref(next);
    if (router) {
      router.push(href, { scroll: false });
    } else if (typeof window !== "undefined" && window.history?.pushState) {
      window.history.pushState(null, "", href);
    }
  }

  const fetchGroupsPayload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/work-reports/groups", { cache: "no-store", signal });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.ok !== true || !Array.isArray(result.groups) || !Array.isArray(result.eligible_users)) {
      const cause = new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      if (response.status === 403) cause.message = "WORK_REPORT_ACCESS_DENIED";
      throw cause;
    }
    return {
      groups: result.groups as WorkReportGroupItem[],
      eligibleUsers: result.eligible_users as WorkReportEligibleGroupUser[],
    };
  }, []);

  const reloadGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const next = await fetchGroupsPayload();
      setGroups(next.groups);
      setEligibleUsers(next.eligibleUsers);
      setGroupsError(null);
    } catch (cause: unknown) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      setGroups([]);
      setEligibleUsers([]);
      setGroupsError(
        code === "WORK_REPORT_ACCESS_DENIED"
          ? "Bạn không có quyền quản lý nhóm báo cáo trong phạm vi hiện tại."
          : "Không tải được danh sách nhóm báo cáo tùy chỉnh. Vui lòng thử lại.",
      );
    } finally {
      setGroupsLoading(false);
    }
  }, [fetchGroupsPayload]);

  useEffect(() => {
    const controller = new AbortController();
    fetchGroupsPayload(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setGroups(next.groups);
        setEligibleUsers(next.eligibleUsers);
        setGroupsError(null);
        setGroupsLoading(false);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
        setGroups([]);
        setEligibleUsers([]);
        setGroupsError(
          code === "WORK_REPORT_ACCESS_DENIED"
            ? "Bạn không có quyền quản lý nhóm báo cáo trong phạm vi hiện tại."
            : "Không tải được danh sách nhóm báo cáo tùy chỉnh. Vui lòng thử lại.",
        );
        setGroupsLoading(false);
      });
    return () => controller.abort();
  }, [fetchGroupsPayload]);

  useEffect(() => {
    const controller = new AbortController();
    const query = teamId ? `?team_id=${encodeURIComponent(teamId)}` : "";
    fetch(`/api/work-reports/assignments${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (
          !response.ok ||
          result?.ok !== true ||
          !Array.isArray(result.templates) ||
          !Array.isArray(result.teams) ||
          !Array.isArray(result.users)
        ) {
          const cause = new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
          if (response.status === 403) cause.message = "WORK_REPORT_ACCESS_DENIED";
          throw cause;
        }
        setTemplates(result.templates);
        setTeams(result.teams);
        setUsers(result.users);
        if (!teamId && result.teams.length === 1) setTeamId(result.teams[0].team_id);
        setError(null);
        setLoadedTeamId(teamId);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
        setTemplates([]);
        setTeams([]);
        setUsers([]);
        setError(
          code === "WORK_REPORT_ACCESS_DENIED"
            ? "Không thể tải mẫu và đối tượng giao báo cáo trong phạm vi quyền hiện tại."
            : "Không tải được dữ liệu giao báo cáo. Vui lòng thử lại.",
        );
        setLoadedTeamId(teamId);
      });
    fetch(`/api/work-reports/assignments/tracking${query}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (!response.ok || result?.ok !== true || !Array.isArray(result.items)) {
          throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
        }
        setAssignments(result.items);
        setTrackingError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
        setAssignments([]);
        setTrackingError(
          code === "WORK_REPORT_ACCESS_DENIED"
            ? "Bạn không có quyền theo dõi assignment trong phạm vi này."
            : "Không tải được danh sách giao báo cáo. Vui lòng thử lại.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setTrackingLoadedTeamId(teamId);
      });
    return () => controller.abort();
  }, [teamId]);

  const activeGroups = useMemo(() => groups.filter((group) => group.active), [groups]);
  const selectedGroup = useMemo(
    () => activeGroups.find((group) => group.group_id === targetGroupId) ?? null,
    [activeGroups, targetGroupId],
  );
  const selectedTemplate = useMemo(
    () => templates.find((item) => item.template_id === templateId) ?? null,
    [templates, templateId],
  );
  const selectedTeam = useMemo(
    () => teams.find((item) => item.team_id === teamId) ?? null,
    [teams, teamId],
  );
  const selectedUser = useMemo(
    () => users.find((item) => item.app_user_id === targetId) ?? null,
    [users, targetId],
  );

  const summaryTargetDescription = useMemo(() => {
    if (targetKind === "GROUP") {
      return selectedGroup ? `Nhóm báo cáo: ${selectedGroup.display_name}` : "Chưa chọn nhóm báo cáo";
    }
    if (targetKind === "TEAM") {
      return selectedTeam ? `Team: ${selectedTeam.display_name} (${selectedTeam.code})` : "Chưa chọn Team";
    }
    if (targetKind === "USER") {
      return selectedUser ? `Nhân viên: ${selectedUser.display_name}` : "Chưa chọn nhân viên";
    }
    return targetUsers.length > 0 ? `Danh sách nhân viên đã chọn (${targetUsers.length} người)` : "Chưa chọn danh sách nhân viên";
  }, [targetKind, selectedGroup, selectedTeam, selectedUser, targetUsers.length]);

  const summaryMemberCount = useMemo(() => {
    if (targetKind === "GROUP") {
      if (!selectedGroup) return 0;
      return selectedGroup.members.filter((member) => member.enabled).length;
    }
    if (targetKind === "USER") return targetId ? 1 : 0;
    if (targetKind === "USER_SET") return targetUsers.length;
    if (targetKind === "TEAM") return teamId ? users.length : 0;
    return 0;
  }, [targetKind, selectedGroup, targetId, targetUsers.length, teamId, users.length]);

  const selectedAssignment = useMemo(
    () => assignments.find((item) => item.assignment_id === selectedAssignmentId) ?? null,
    [assignments, selectedAssignmentId],
  );

  const filteredAssignments = useMemo(
    () => assignments.filter((item) => item.state === stateFilter),
    [assignments, stateFilter],
  );

  const assignmentCountsByState = useMemo(() => {
    return {
      ACTIVE: assignments.filter((item) => item.state === "ACTIVE").length,
      PAUSED: assignments.filter((item) => item.state === "PAUSED").length,
      REVOKED: assignments.filter((item) => item.state === "REVOKED").length,
    };
  }, [assignments]);

  const memberCandidateTeams = useMemo(() => {
    const map = new Map<string, string>();
    for (const user of eligibleUsers) {
      if (user.team_id && user.team_display_name) {
        map.set(user.team_id, user.team_code ? `${user.team_display_name} (${user.team_code})` : user.team_display_name);
      }
    }
    return Array.from(map.entries())
      .map(([id, label]) => ({ team_id: id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, "vi"));
  }, [eligibleUsers]);

  const hasNoTeamEligibleUsers = useMemo(
    () => eligibleUsers.some((user) => user.team_id === null),
    [eligibleUsers],
  );

  const filteredEligibleUsers = useMemo(() => {
    const keyword = memberSearch.trim().toLocaleLowerCase("vi");
    return eligibleUsers.filter((user) => {
      if (memberTeamFilter === "__NO_TEAM__" && user.team_id !== null) return false;
      if (memberTeamFilter && memberTeamFilter !== "__NO_TEAM__" && user.team_id !== memberTeamFilter) return false;
      if (!keyword) return true;
      const teamText = `${user.team_display_name ?? ""} ${user.team_code ?? ""}`.toLocaleLowerCase("vi");
      return user.display_name.toLocaleLowerCase("vi").includes(keyword) || teamText.includes(keyword);
    });
  }, [eligibleUsers, memberSearch, memberTeamFilter]);

  async function reloadAssignments() {
    const query = teamId ? `?team_id=${encodeURIComponent(teamId)}` : "";
    try {
      const response = await fetch(`/api/work-reports/assignments/tracking${query}`, { cache: "no-store" });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true || !Array.isArray(result.items)) throw new Error("WORK_REPORT_UNAVAILABLE");
      setAssignments(result.items);
      setTrackingError(null);
    } catch {
      setTrackingError("Không tải được danh sách giao báo cáo. Vui lòng thử lại.");
    }
  }

  function openNewGroupDialog() {
    setGroupFormError(null);
    setMemberSearch("");
    setMemberTeamFilter("");
    setGroupEditor({
      group: null,
      display_name: "",
      description: "",
      member_user_ids: [],
    });
  }

  function openEditGroupDialog(group: WorkReportGroupItem) {
    setGroupFormError(null);
    setMemberSearch("");
    setMemberTeamFilter("");
    const eligibleSet = new Set(eligibleUsers.map((user) => user.app_user_id));
    setGroupEditor({
      group,
      display_name: group.display_name,
      description: group.description ?? "",
      member_user_ids: group.members
        .map((member) => member.app_user_id)
        .filter((id) => eligibleSet.has(id)),
    });
  }

  function toggleGroupMember(appUserId: string, checked: boolean) {
    setGroupEditor((current) => {
      if (!current) return current;
      const exists = current.member_user_ids.includes(appUserId);
      if (checked && !exists) {
        return { ...current, member_user_ids: [...current.member_user_ids, appUserId] };
      }
      if (!checked && exists) {
        return { ...current, member_user_ids: current.member_user_ids.filter((id) => id !== appUserId) };
      }
      return current;
    });
  }

  async function saveGroup() {
    if (!groupEditor) return;
    const trimmedName = groupEditor.display_name.trim();
    const trimmedDesc = groupEditor.description.trim();
    if (!trimmedName) {
      setGroupFormError("Vui lòng nhập tên nhóm báo cáo.");
      return;
    }
    if (groupEditor.member_user_ids.length === 0) {
      setGroupFormError("Vui lòng chọn ít nhất một thành viên đang hoạt động trong phạm vi quyền.");
      return;
    }
    setGroupBusy(true);
    setGroupFormError(null);
    try {
      const idempotency_key = crypto.randomUUID();
      const isEdit = groupEditor.group !== null;
      const url = isEdit ? `/api/work-reports/groups/${groupEditor.group!.group_id}` : "/api/work-reports/groups";
      const response = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify(
          isEdit
            ? {
                expected_version: groupEditor.group!.version,
                display_name: trimmedName,
                description: trimmedDesc || null,
                member_user_ids: groupEditor.member_user_ids,
                idempotency_key,
              }
            : {
                display_name: trimmedName,
                description: trimmedDesc || null,
                member_user_ids: groupEditor.member_user_ids,
                idempotency_key,
              },
        ),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      notify.success({
        title: isEdit ? "Đã cập nhật nhóm báo cáo." : "Đã tạo nhóm báo cáo mới.",
        dedupeKey: "work-report-group-save",
        countBurst: false,
      });
      if (!isEdit && typeof result.group_id === "string") {
        setTargetGroupId(result.group_id);
      }
      setGroupEditor(null);
      await Promise.all([reloadGroups(), reloadAssignments()]);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      const msg =
        code === "WORK_REPORT_SCOPE_DENIED" || code === "WORK_REPORT_ACCESS_DENIED"
          ? "Bạn không có quyền với toàn bộ thành viên trong nhóm. Thao tác đã bị từ chối toàn bộ."
          : code === "WORK_REPORT_VERSION_CONFLICT"
            ? "Nhóm báo cáo vừa được cập nhật ở nơi khác. Hãy đóng hộp thoại và tải lại."
            : code === "WORK_REPORT_GROUP_MEMBER_INELIGIBLE"
              ? "Nhóm chứa thành viên đã ngừng hoạt động hoặc không đủ điều kiện nhận báo cáo. Hãy bỏ các thành viên đó rồi lưu lại."
              : "Không lưu được nhóm báo cáo. Kiểm tra danh sách thành viên đủ điều kiện rồi thử lại.";
      setGroupFormError(msg);
      if (code === "WORK_REPORT_VERSION_CONFLICT") {
        notify.warning({ title: msg, dedupeKey: "work-report-group-save", countBurst: false });
      } else {
        notify.error({ title: msg, dedupeKey: "work-report-group-save", countBurst: false });
      }
    } finally {
      setGroupBusy(false);
    }
  }

  async function toggleGroupActive(group: WorkReportGroupItem, nextActive: boolean) {
    if (
      !nextActive &&
      !window.confirm(
        `Ngừng sử dụng nhóm "${group.display_name}"? Nhóm không bị xóa vật lý; nghĩa vụ và bài nộp đã phát sinh được giữ nguyên, các kỳ chưa phát sinh sẽ không tiếp tục tạo nghĩa vụ mới từ nhóm này.`,
      )
    ) {
      return;
    }
    setGroupBusy(true);
    setGroupsError(null);
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch(`/api/work-reports/groups/${group.group_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({
          expected_version: group.version,
          active: nextActive,
          idempotency_key,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      if (!nextActive && targetGroupId === group.group_id) {
        setTargetGroupId("");
      }
      notify.success({
        title: nextActive ? "Đã kích hoạt lại nhóm báo cáo." : "Đã ngừng sử dụng nhóm báo cáo.",
        dedupeKey: "work-report-group-active",
        countBurst: false,
      });
      await Promise.all([reloadGroups(), reloadAssignments()]);
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      const msg =
        code === "WORK_REPORT_SCOPE_DENIED" || code === "WORK_REPORT_ACCESS_DENIED"
          ? "Bạn không có quyền với toàn bộ thành viên trong nhóm này."
          : code === "WORK_REPORT_VERSION_CONFLICT"
            ? "Nhóm báo cáo vừa được thay đổi ở nơi khác. Đang tải lại danh sách."
            : code === "WORK_REPORT_GROUP_MEMBER_INELIGIBLE"
              ? "Nhóm không còn thành viên nào đang hoạt động đủ điều kiện nhận báo cáo. Hãy cập nhật thành viên của nhóm trước khi kích hoạt."
              : "Không cập nhật được trạng thái nhóm báo cáo. Kiểm tra thành viên đủ điều kiện rồi thử lại.";
      setGroupsError(msg);
      if (code === "WORK_REPORT_VERSION_CONFLICT") {
        notify.warning({ title: msg, dedupeKey: "work-report-group-active", countBurst: false });
        await reloadGroups();
      } else {
        notify.error({ title: msg, dedupeKey: "work-report-group-active", countBurst: false });
      }
    } finally {
      setGroupBusy(false);
    }
  }

  async function executeUpdateAssignment(
    assignment: WorkReportAssignmentSummary,
    state: "ACTIVE" | "PAUSED" | "REVOKED",
  ) {
    setTrackingBusy(true);
    setTrackingError(null);
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch(`/api/work-reports/assignments/${assignment.assignment_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({ expected_version: assignment.version, state, idempotency_key }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      notify.success({
        title:
          state === "PAUSED"
            ? "Đã tạm dừng đợt giao báo cáo."
            : state === "REVOKED"
              ? "Đã thu hồi đợt giao báo cáo."
              : "Đã kích hoạt lại đợt giao báo cáo.",
        dedupeKey: "work-report-assignment-state",
        countBurst: false,
      });
      setRevokeConfirmAssignment(null);
      await reloadAssignments();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      const isConflict = code === "WORK_REPORT_VERSION_CONFLICT";
      const msg = isConflict
        ? "Đợt giao vừa được thay đổi ở nơi khác. Danh sách đã cũ; vui lòng tải lại."
        : code === "WORK_REPORT_ACCESS_DENIED" || code === "WORK_REPORT_SCOPE_DENIED"
          ? "Bạn không có quyền với toàn bộ thành viên của đợt giao này."
          : code === "WORK_REPORT_GROUP_INACTIVE" || code === "WORK_REPORT_REQUEST_INVALID"
            ? "Không thể kích hoạt lại đợt giao khi nhóm nhận báo cáo đang ngừng sử dụng."
            : "Không cập nhật được đợt giao báo cáo. Vui lòng thử lại.";
      setTrackingError(msg);
      if (isConflict) notify.warning({ title: msg, dedupeKey: "work-report-assignment-state", countBurst: false });
      else notify.error({ title: msg, dedupeKey: "work-report-assignment-state", countBurst: false });
    } finally {
      setTrackingBusy(false);
    }
  }

  function requestUpdateAssignment(
    assignment: WorkReportAssignmentSummary,
    state: "ACTIVE" | "PAUSED" | "REVOKED",
  ) {
    if (state === "REVOKED") {
      setRevokeConfirmAssignment(assignment);
      return;
    }
    void executeUpdateAssignment(assignment, state);
  }

  async function refreshProgress() {
    setTrackingBusy(true);
    setTrackingError(null);
    try {
      const business_date = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
      const response = await fetch("/api/work-reports/assignments/materialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_date }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      notify.success({
        title: "Đã đồng bộ nghĩa vụ cho kỳ hiện tại.",
        dedupeKey: "work-report-assignment-materialize",
        countBurst: false,
      });
      await reloadAssignments();
    } catch {
      const msg = "Không cập nhật được tiến độ nghĩa vụ. Vui lòng thử lại.";
      setTrackingError(msg);
      notify.error({ title: msg, dedupeKey: "work-report-assignment-materialize", countBurst: false });
    } finally {
      setTrackingBusy(false);
    }
  }

  function validateCreateFields(): boolean {
    const ids = targetKind === "USER_SET" ? targetUsers : [];
    const missingRequired =
      !templateId ||
      (targetKind === "GROUP"
        ? !targetGroupId
        : !teamId || (targetKind === "USER" && !targetId) || (targetKind === "USER_SET" && ids.length === 0));
    if (missingRequired) {
      setError("Chọn mẫu báo cáo, nhóm và đối tượng nhận báo cáo trước khi xác nhận.");
      return false;
    }
    setError(null);
    return true;
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validateCreateFields()) return;
    if (!confirmingCreate) {
      setConfirmingCreate(true);
      return;
    }
    setBusy(true);
    setError(null);
    const ids = targetKind === "USER_SET" ? targetUsers : [];
    try {
      const idempotency_key = crypto.randomUUID();
      const response = await fetch("/api/work-reports/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotency_key },
        body: JSON.stringify({
          template_id: templateId,
          target_kind: targetKind,
          target_user_id: targetKind === "USER" ? targetId : null,
          target_team_id: targetKind === "TEAM" ? teamId : null,
          target_group_id: targetKind === "GROUP" ? targetGroupId : null,
          target_user_ids: ids,
          frequency,
          is_mandatory: true,
          due_day_offset: Number(dueDayOffset),
          due_time_local: dueTime,
          exclude_sundays: false,
          effective_from: effectiveFrom,
          effective_to: null,
          idempotency_key,
        }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
      notify.success({
        title: "Đã tạo đợt giao báo cáo và phát sinh nghĩa vụ kỳ hiện hành.",
        dedupeKey: "work-report-assignment-create",
        countBurst: false,
      });
      setConfirmingCreate(false);
      setStateFilter("ACTIVE");
      await Promise.all([reloadAssignments(), reloadGroups()]);
      if (typeof result.assignment_id === "string") {
        setSelectedAssignmentId(result.assignment_id);
      }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
      const msg =
        code === "WORK_REPORT_SCOPE_DENIED" || code === "WORK_REPORT_ACCESS_DENIED"
          ? "Bạn không có quyền giao báo cáo cho toàn bộ đối tượng đã chọn. Không có đợt giao nào được tạo."
          : code === "WORK_REPORT_VERSION_CONFLICT"
            ? "Đợt giao báo cáo cho đối tượng này đã tồn tại hoặc mẫu đã thay đổi. Tải lại và thử lại."
            : code === "WORK_REPORT_GROUP_MEMBER_INELIGIBLE"
              ? "Nhóm nhận báo cáo không còn thành viên đang hoạt động hoặc chứa thành viên không đủ điều kiện nhận báo cáo. Hãy mở tab Nhóm nhận báo cáo, bấm Sửa nhóm rồi Lưu thay đổi để cập nhật danh sách thành viên."
              : code === "WORK_REPORT_GROUP_INACTIVE"
                ? "Nhóm nhận báo cáo đang ngừng sử dụng. Hãy kích hoạt lại nhóm hoặc chọn nhóm khác."
                : code === "WORK_REPORT_TEMPLATE_NOT_ACTIVE"
                  ? "Mẫu báo cáo đã chọn không còn ở trạng thái phát hành. Hãy tải lại trang và chọn mẫu khác."
                  : "Không tạo được đợt giao. Vui lòng kiểm tra thông tin hoặc thử lại.";
      setError(msg);
      if (code === "WORK_REPORT_VERSION_CONFLICT") {
        notify.warning({ title: msg, dedupeKey: "work-report-assignment-create", countBurst: false });
      } else {
        notify.error({ title: msg, dedupeKey: "work-report-assignment-create", countBurst: false });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant={activeSubView === "assignments" ? "primary" : "secondary"}
            size="sm"
            aria-pressed={activeSubView === "assignments"}
            onClick={() => switchSubView("assignments")}
          >
            Đợt giao ({assignments.length})
          </Button>
          <Button
            type="button"
            variant={activeSubView === "groups" ? "primary" : "secondary"}
            size="sm"
            aria-pressed={activeSubView === "groups"}
            onClick={() => switchSubView("groups")}
          >
            Nhóm nhận báo cáo ({groups.length})
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {activeSubView === "assignments" ? (
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                setShowCreateForm((prev) => !prev);
                setConfirmingCreate(false);
              }}
            >
              {showCreateForm ? "Thu gọn biểu mẫu" : "Tạo đợt giao"}
            </Button>
          ) : (
            <Button type="button" variant="primary" disabled={groupBusy} onClick={openNewGroupDialog}>
              Tạo nhóm nhận báo cáo
            </Button>
          )}
        </div>
      </div>

      {error ? <StatusBanner tone="error">{error}</StatusBanner> : null}

      {activeSubView === "assignments" && showCreateForm ? (
        <Card className="w-full">
          <CardHeader
            title="Tạo đợt giao"
            description="Thiết lập mẫu báo cáo, đối tượng/nhóm nhận, chu kỳ và hạn nộp. Khi đợt giao có hiệu lực trong ngày, hệ thống tự động phát sinh ngay nghĩa vụ kỳ hiện tại cho nhân viên."
          />

          <form onSubmit={(event) => void create(event)} className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="team" className="text-sm font-medium">
                  {targetKind === "GROUP" ? "Lọc theo Team hành chính (tùy chọn)" : "Team trong phạm vi được giao"}
                </label>
                <select
                  id="team"
                  required={targetKind !== "GROUP"}
                  value={teamId}
                  onChange={(event) => {
                    setTeamId(event.target.value);
                    setTargetId("");
                    setTargetUsers([]);
                    setConfirmingCreate(false);
                  }}
                  className={controlClass}
                >
                  <option value="">
                    {targetKind === "GROUP" ? "Tất cả Team trong phạm vi" : "Chọn nhóm"}
                  </option>
                  {teams.map((team) => (
                    <option key={team.team_id} value={team.team_id}>
                      {team.display_name} ({team.code})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="template" className="text-sm font-medium">Mẫu báo cáo</label>
                <select
                  id="template"
                  required
                  value={templateId}
                  onChange={(event) => {
                    setTemplateId(event.target.value);
                    setConfirmingCreate(false);
                  }}
                  className={controlClass}
                >
                  <option value="">Chọn mẫu đang hoạt động</option>
                  {templates.map((template) => (
                    <option key={template.template_id} value={template.template_id}>
                      {template.display_name} ({template.template_code})
                    </option>
                  ))}
                </select>
                {templatesLoaded && !error && templates.length === 0 ? (
                  <p className="text-xs text-muted">Chưa có mẫu đã publish.</p>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <label htmlFor="target-kind" className="text-sm font-medium">Đối tượng nhận báo cáo</label>
                <select
                  id="target-kind"
                  value={targetKind}
                  onChange={(event) => {
                    setTargetKind(event.target.value as typeof targetKind);
                    setConfirmingCreate(false);
                  }}
                  className={controlClass}
                >
                  <option value="USER">Một nhân viên</option>
                  <option value="TEAM">Một nhóm (Team hành chính)</option>
                  <option value="USER_SET">Danh sách nhân viên</option>
                  <option value="GROUP">Nhóm báo cáo tùy chỉnh</option>
                </select>
              </div>

              {targetKind === "USER_SET" ? (
                <div className="space-y-1.5 md:col-span-2">
                  <label htmlFor="target-users" className="text-sm font-medium">Nhân viên</label>
                  <select
                    id="target-users"
                    required
                    multiple
                    value={targetUsers}
                    onChange={(event) => {
                      setTargetUsers(Array.from(event.target.selectedOptions, (option) => option.value));
                      setConfirmingCreate(false);
                    }}
                    className="min-h-32 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  >
                    {users.map((user) => (
                      <option key={user.app_user_id} value={user.app_user_id}>
                        {user.display_name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : targetKind === "USER" ? (
                <div className="space-y-1.5">
                  <label htmlFor="target-id" className="text-sm font-medium">Nhân viên</label>
                  <select
                    id="target-id"
                    required
                    value={targetId}
                    onChange={(event) => {
                      setTargetId(event.target.value);
                      setConfirmingCreate(false);
                    }}
                    className={controlClass}
                  >
                    <option value="">Chọn nhân viên</option>
                    {users.map((user) => (
                      <option key={user.app_user_id} value={user.app_user_id}>
                        {user.display_name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : targetKind === "GROUP" ? (
                <div className="space-y-2 md:col-span-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label htmlFor="target-group" className="text-sm font-medium">Nhóm báo cáo tùy chỉnh</label>
                    <Button type="button" size="sm" variant="secondary" onClick={openNewGroupDialog}>
                      Tạo nhóm báo cáo mới
                    </Button>
                  </div>
                  <select
                    id="target-group"
                    required
                    value={targetGroupId}
                    onChange={(event) => {
                      setTargetGroupId(event.target.value);
                      setConfirmingCreate(false);
                    }}
                    className={controlClass}
                  >
                    <option value="">Chọn nhóm báo cáo đang sử dụng</option>
                    {activeGroups.map((group) => (
                      <option key={group.group_id} value={group.group_id}>
                        {group.display_name} ({group.members.length} thành viên)
                      </option>
                    ))}
                  </select>
                  {!groupsLoading && activeGroups.length === 0 ? (
                    <p className="text-xs text-muted">
                      Chưa có nhóm báo cáo đang sử dụng trong phạm vi quyền. Hãy tạo nhóm báo cáo mới trước khi giao.
                    </p>
                  ) : null}
                  {selectedGroup ? (
                    <div className="rounded-lg bg-subtle p-3 text-xs text-muted">
                      <span className="font-medium text-foreground">
                        Thành viên đang hoạt động (
                        {selectedGroup.members.filter((member) => member.enabled).length}/
                        {selectedGroup.members.length}):
                      </span>{" "}
                      {selectedGroup.members
                        .map(
                          (member) =>
                            `${member.display_name}${member.team_display_name ? ` (${member.team_display_name})` : ""}${!member.enabled ? " · Ngừng hoạt động" : ""}`,
                        )
                        .join(", ")}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>

            <p className="text-xs text-muted">
              Danh sách nhân viên được xác định từ liên kết tài khoản và thành viên nhóm hiện hành. Scope vẫn được kiểm tra lại trong RPC khi tạo assignment.
            </p>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1.5 text-sm font-medium">
                Chu kỳ
                <select
                  value={frequency}
                  onChange={(event) => {
                    setFrequency(event.target.value);
                    setConfirmingCreate(false);
                  }}
                  className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal"
                >
                  <option value="DAILY">Hằng ngày</option>
                  <option value="WEEKLY">Hằng tuần</option>
                  <option value="MONTHLY">Hằng tháng</option>
                  <option value="ONCE">Một lần</option>
                </select>
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Ngày bắt đầu
                <input
                  type="date"
                  required
                  value={effectiveFrom}
                  onChange={(event) => {
                    setEffectiveFrom(event.target.value);
                    setConfirmingCreate(false);
                  }}
                  className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal"
                />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Số ngày cộng vào kỳ hạn
                <input
                  type="number"
                  min="0"
                  max="31"
                  required
                  value={dueDayOffset}
                  onChange={(event) => {
                    setDueDayOffset(event.target.value);
                    setConfirmingCreate(false);
                  }}
                  className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal"
                />
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Giờ đến hạn (giờ Việt Nam)
                <input
                  type="time"
                  step="1"
                  required
                  value={dueTime}
                  onChange={(event) => {
                    setDueTime(event.target.value);
                    setConfirmingCreate(false);
                  }}
                  className="min-h-11 w-full rounded-lg border border-border bg-surface px-3 font-normal"
                />
              </label>
            </div>

            <div
              aria-label="Tóm tắt trước khi xác nhận tạo đợt giao"
              className="rounded-xl border border-primary/25 bg-primary/5 p-4"
            >
              <h3 className="text-sm font-semibold text-foreground">
                Tóm tắt đợt giao trước khi xác nhận
              </h3>
              <dl className="mt-2.5 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted">Mẫu báo cáo</dt>
                  <dd className="font-medium text-foreground">
                    {selectedTemplate ? `${selectedTemplate.display_name} (${selectedTemplate.template_code})` : "Chưa chọn mẫu"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Đối tượng / Nhóm</dt>
                  <dd className="font-medium text-foreground">{summaryTargetDescription}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Số thành viên</dt>
                  <dd className="font-medium tabular-nums text-foreground">{summaryMemberCount} người</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Chu kỳ</dt>
                  <dd className="font-medium text-foreground">{frequencyLabel(frequency)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Ngày bắt đầu</dt>
                  <dd className="font-medium tabular-nums text-foreground">{effectiveFrom || "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Hạn nộp</dt>
                  <dd className="font-medium tabular-nums text-foreground">
                    +{dueDayOffset || "0"} ngày · {dueTime} (giờ VN)
                  </dd>
                </div>
              </dl>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                variant="primary"
                disabled={
                  busy ||
                  !templates.length ||
                  (!teamId && targetKind !== "GROUP") ||
                  (targetKind === "GROUP" && !targetGroupId) ||
                  !templatesLoaded
                }
              >
                {busy
                  ? "Đang tạo…"
                  : confirmingCreate
                    ? "Xác nhận tạo đợt giao"
                    : "Tạo đợt giao"}
              </Button>
              {confirmingCreate ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setConfirmingCreate(false)}
                >
                  Chỉnh sửa lại
                </Button>
              ) : null}
            </div>
          </form>
        </Card>
      ) : null}

      {activeSubView === "groups" ? (
        <section className="space-y-3" aria-labelledby="custom-groups-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="custom-groups-title" className="text-lg font-semibold">Nhóm nhận báo cáo</h2>
              <p className="text-sm text-muted">
                Danh sách người nhận tái sử dụng xuyên nhiều Team hành chính (ví dụ: Nhóm Tuyển dụng, Nhóm QLDA, Nhóm Tổ trưởng).
              </p>
              <p className="text-xs text-muted">
                Đây là nhóm phục vụ phân công báo cáo, không thay đổi Team hành chính, Phòng ban hay quyền dữ liệu. Thay đổi thành viên chỉ áp dụng cho nghĩa vụ chưa phát sinh; nghĩa vụ và bài nộp đã tạo được giữ nguyên.
              </p>
            </div>
            <Button type="button" variant="secondary" disabled={groupBusy} onClick={openNewGroupDialog}>
              Tạo nhóm báo cáo
            </Button>
          </div>

          {groupsError ? (
            <StatusBanner tone="error">
              <div className="flex flex-wrap items-center gap-2">
                <span>{groupsError}</span>
                <Button type="button" size="sm" variant="secondary" onClick={() => void reloadGroups()}>
                  Thử lại
                </Button>
              </div>
            </StatusBanner>
          ) : null}

          {groupsLoading ? (
            <p role="status" className="text-sm text-muted">Đang tải nhóm báo cáo tùy chỉnh…</p>
          ) : groups.length === 0 ? (
            <p className="rounded-lg border border-border p-4 text-sm text-muted">
              Chưa có nhóm báo cáo tùy chỉnh trong phạm vi quyền hiện tại.
            </p>
          ) : (
            <div className="space-y-3">
              {groups.map((group) => (
                <article key={group.group_id} className="rounded-xl border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold">{group.display_name}</h3>
                        <StatusBadge tone={group.active ? "success" : "neutral"}>
                          {group.active ? "Đang sử dụng" : "Ngừng sử dụng"}
                        </StatusBadge>
                      </div>
                      {group.description ? <p className="text-sm text-muted">{group.description}</p> : null}
                      <p className="text-xs text-muted">
                        {group.members.length} thành viên · {group.assignment_count} đợt giao tham chiếu · phiên bản v{group.version}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={groupBusy}
                        onClick={() => openEditGroupDialog(group)}
                      >
                        Sửa nhóm
                      </Button>
                      {group.active ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={groupBusy}
                          onClick={() => void toggleGroupActive(group, false)}
                        >
                          Ngừng sử dụng
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          disabled={groupBusy}
                          onClick={() => void toggleGroupActive(group, true)}
                        >
                          Sử dụng lại
                        </Button>
                      )}
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {group.members.map((member) => (
                      <span
                        key={member.app_user_id}
                        className="inline-flex items-center gap-1 rounded-md bg-subtle px-2.5 py-1 text-xs"
                      >
                        <span className="font-medium text-foreground">{member.display_name}</span>
                        <span className="text-muted">
                          ({member.team_display_name ?? "Chưa gắn Team"}
                          {!member.enabled ? " · Ngừng hoạt động" : ""})
                        </span>
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {activeSubView === "assignments" ? (
        <section className="space-y-4" aria-labelledby="assignment-tracking-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="assignment-tracking-title" className="text-lg font-semibold">Danh sách đợt giao</h2>
              <p className="text-sm text-muted">
                Lọc theo trạng thái đợt giao và chọn một đợt giao để xem tiến độ từng thành viên, lịch sử thay đổi hoặc thao tác Tạm dừng / Kích hoạt lại / Thu hồi.
              </p>
              <p className="text-xs text-muted">
                Nghĩa vụ kỳ hiện tại tự phát sinh khi tạo đợt giao hoặc khi nhân viên mở danh sách báo cáo (Web/Android). Dùng nút bên phải nếu cần đồng bộ ngay cho các thành viên chưa mở ứng dụng hôm nay.
              </p>
            </div>
            <Button type="button" variant="secondary" disabled={trackingBusy} onClick={() => void refreshProgress()}>
              {trackingBusy ? "Đang đồng bộ…" : "Đồng bộ nghĩa vụ kỳ hiện tại"}
            </Button>
          </div>

          <div
            role="tablist"
            aria-label="Lọc trạng thái đợt giao"
            className="flex flex-wrap gap-1.5 rounded-xl border border-border bg-surface p-1.5"
          >
            {(
              [
                { key: "ACTIVE", label: "Đang hoạt động", count: assignmentCountsByState.ACTIVE },
                { key: "PAUSED", label: "Tạm dừng", count: assignmentCountsByState.PAUSED },
                { key: "REVOKED", label: "Đã thu hồi", count: assignmentCountsByState.REVOKED },
              ] as const
            ).map((tab) => {
              const active = stateFilter === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setStateFilter(tab.key)}
                  className={
                    "inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors " +
                    (active
                      ? "bg-primary text-on-primary shadow-2xs"
                      : "text-muted hover:bg-muted/10 hover:text-foreground")
                  }
                >
                  <span>{tab.label}</span>
                  <span className="rounded-full bg-background/20 px-1.5 py-0.5 text-[11px] tabular-nums">
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>

          {trackingError ? <StatusBanner tone="error">{trackingError}</StatusBanner> : null}

          {trackingLoadedTeamId !== teamId ? (
            <p role="status" className="text-sm text-muted">Đang tải danh sách đợt giao…</p>
          ) : filteredAssignments.length === 0 ? (
            <p className="rounded-[22px] border border-border/80 bg-surface p-4 text-sm text-muted shadow-[var(--shadow-card)]">
              Không có đợt giao nào ở trạng thái {stateLabel(stateFilter)}.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="relative overflow-hidden rounded-xl [border-radius:22px] border border-border/80 bg-surface shadow-[var(--shadow-card)]">
                <div className="relative overflow-x-auto">
                  <table className="r22-card-table w-full border-collapse text-left text-sm">
                    <thead className="border-b border-border bg-surface-muted text-xs font-bold uppercase tracking-wider text-[var(--navy)]">
                      <tr>
                        <th scope="col" className="px-3.5 py-3 text-left font-bold whitespace-nowrap">Mẫu báo cáo & Đối tượng nhận</th>
                        <th scope="col" className="px-3.5 py-3 text-center font-bold whitespace-nowrap">Trạng thái</th>
                        <th scope="col" className="px-2.5 py-3 text-center font-bold whitespace-nowrap">Đã nộp</th>
                        <th scope="col" className="px-2.5 py-3 text-center font-bold whitespace-nowrap">Chưa hoàn thành</th>
                        <th scope="col" className="px-2.5 py-3 text-center font-bold whitespace-nowrap">Quá hạn chưa nộp</th>
                        <th scope="col" className="px-2.5 py-3 text-center font-bold whitespace-nowrap">Tổng nghĩa vụ</th>
                        <th scope="col" className="px-2.5 py-3 text-center font-bold whitespace-nowrap">Miễn / huỷ</th>
                        <th scope="col" className="px-3.5 py-3 text-right font-bold whitespace-nowrap">Thao tác</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAssignments.map((assignment) => {
                        const incompleteCount = assignment.not_started_count + assignment.draft_count;
                        const overdueCount = assignment.overdue_count ?? 0;
                        const exemptCancelCount = assignment.exempted_count + assignment.cancelled_count;
                        const isSelected = selectedAssignment?.assignment_id === assignment.assignment_id;
                        return (
                          <tr
                            key={assignment.assignment_id}
                            className={
                              "border-b border-border/65 last:border-b-0 transition-colors hover:bg-[var(--selected-bg)] align-middle " +
                              (isSelected ? "bg-[var(--selected-bg)]" : "")
                            }
                          >
                            <td className="px-3.5 py-3 align-middle text-foreground" data-card-header="true">
                              <div className="font-semibold text-[var(--navy)]">{assignment.template_name}</div>
                              <div className="mt-0.5 text-xs font-medium text-foreground/85">
                                {targetKindLabel(assignment.target_kind)}: {assignment.target_label}
                                {typeof assignment.target_member_count === "number"
                                  ? ` (${assignment.target_member_count} thành viên)`
                                  : ""}{" "}
                                · Tần suất: {frequencyLabel(assignment.frequency)}
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-muted">
                                Từ {assignment.effective_from}
                                {assignment.effective_to ? ` đến ${assignment.effective_to}` : " · không giới hạn ngày kết thúc"}
                                {typeof assignment.due_time_local === "string"
                                  ? ` · Hạn nộp +${assignment.due_day_offset ?? 0} ngày lúc ${assignment.due_time_local}`
                                  : ""}
                              </div>
                            </td>
                            <td className="px-3.5 py-3 align-middle text-center whitespace-nowrap" data-label="Trạng thái">
                              <StatusBadge
                                dot
                                tone={
                                  assignment.state === "ACTIVE"
                                    ? "success"
                                    : assignment.state === "PAUSED"
                                      ? "warning"
                                      : "neutral"
                                }
                              >
                                {stateLabel(assignment.state)}
                              </StatusBadge>
                            </td>
                            <td className="px-2.5 py-3 align-middle text-center whitespace-nowrap" data-label="Đã nộp">
                              <span
                                className={
                                  "inline-flex min-w-8 items-center justify-center rounded-full border px-2 py-0.5 font-mono text-xs font-bold tabular-nums " +
                                  (assignment.submitted_count > 0
                                    ? "border-emerald-500/30 bg-emerald-500/12 text-emerald-800 dark:text-emerald-200"
                                    : "border-border/80 bg-surface-muted/70 text-muted")
                                }
                              >
                                {assignment.submitted_count}
                              </span>
                            </td>
                            <td className="px-2.5 py-3 align-middle text-center whitespace-nowrap" data-label="Chưa hoàn thành">
                              <span
                                className={
                                  "inline-flex min-w-8 items-center justify-center rounded-full border px-2 py-0.5 font-mono text-xs font-bold tabular-nums " +
                                  (incompleteCount > 0
                                    ? "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-200"
                                    : "border-border/80 bg-surface-muted/70 text-muted")
                                }
                              >
                                {incompleteCount}
                              </span>
                            </td>
                            <td className="px-2.5 py-3 align-middle text-center whitespace-nowrap" data-label="Quá hạn chưa nộp">
                              <span
                                className={
                                  "inline-flex min-w-8 items-center justify-center rounded-full border px-2 py-0.5 font-mono text-xs font-bold tabular-nums " +
                                  (overdueCount > 0
                                    ? "border-rose-500/30 bg-rose-500/12 text-rose-800 dark:text-rose-200"
                                    : "border-border/80 bg-surface-muted/70 text-muted")
                                }
                              >
                                {overdueCount}
                              </span>
                            </td>
                            <td className="px-2.5 py-3 align-middle text-center whitespace-nowrap" data-label="Tổng nghĩa vụ">
                              <span className="inline-flex min-w-8 items-center justify-center rounded-full border border-primary/25 bg-[var(--selected-bg)] px-2.5 py-0.5 font-mono text-xs font-bold tabular-nums text-primary">
                                {assignment.obligation_total}
                              </span>
                            </td>
                            <td className="px-2.5 py-3 align-middle text-center font-mono text-xs tabular-nums text-muted whitespace-nowrap" data-label="Miễn / huỷ">
                              {exemptCancelCount}
                            </td>
                            <td className="px-3.5 py-3 align-middle text-right whitespace-nowrap" data-card-actions="true">
                              <div className="inline-flex flex-wrap md:flex-nowrap items-center justify-end gap-1.5 whitespace-nowrap">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant={isSelected ? "primary" : "soft"}
                                  onClick={() =>
                                    setSelectedAssignmentId(
                                      isSelected ? null : assignment.assignment_id,
                                    )
                                  }
                                >
                                  {isSelected ? "Đóng chi tiết" : "Xem chi tiết"}
                                </Button>
                                {assignment.state === "ACTIVE" ? (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    disabled={trackingBusy}
                                    onClick={() => requestUpdateAssignment(assignment, "PAUSED")}
                                  >
                                    Tạm dừng
                                  </Button>
                                ) : null}
                                {assignment.state === "PAUSED" ? (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="secondary"
                                    disabled={trackingBusy}
                                    onClick={() => requestUpdateAssignment(assignment, "ACTIVE")}
                                  >
                                    Kích hoạt lại
                                  </Button>
                                ) : null}
                                {assignment.state !== "REVOKED" ? (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="danger-outline"
                                    disabled={trackingBusy}
                                    onClick={() => requestUpdateAssignment(assignment, "REVOKED")}
                                  >
                                    Thu hồi
                                  </Button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {selectedAssignment ? (
                <div className="rounded-[22px] border border-primary/35 bg-surface p-5 shadow-[var(--shadow-card)]">
                  <AssignmentDetailPanel
                    assignment={selectedAssignment}
                    busy={trackingBusy}
                    onAction={(nextState) => requestUpdateAssignment(selectedAssignment, nextState)}
                  />
                </div>
              ) : null}
            </div>
          )}
        </section>
      ) : null}

      <FormDialog
        open={revokeConfirmAssignment !== null && (activeSubView === "assignments" || trackingBusy)}
        onOpenChange={(open) => {
          if (!open && !trackingBusy) {
            setRevokeConfirmAssignment(null);
          }
        }}
        title="Xác nhận thu hồi đợt giao báo cáo"
        description="Vui lòng kiểm tra kỹ tác động trước khi xác nhận thu hồi đợt giao."
        closeDisabled={trackingBusy}
      >
        {revokeConfirmAssignment ? (
          <div className="space-y-4 text-sm">
            <StatusBanner tone="warning" title="Ý nghĩa thu hồi đợt giao ở máy chủ">
              Thu hồi đợt giao sẽ chuyển trạng thái đợt giao sang <strong>Đã thu hồi</strong>, hủy toàn bộ các nghĩa vụ đang mở nhưng <strong>chưa nộp</strong> — bao gồm cả nghĩa vụ <strong>chưa bắt đầu</strong> (<code>NOT_STARTED</code> → <code>CANCELLED</code>) và nghĩa vụ <strong>đang lưu bản nháp chưa nộp</strong> (<code>DRAFT</code> → <code>CANCELLED</code>) — đồng thời ngừng phát sinh nghĩa vụ cho các kỳ tiếp theo.{" "}
              <strong>Các báo cáo đã nộp và toàn bộ lịch sử bài nộp được giữ nguyên, không bị xóa.</strong>
            </StatusBanner>
            <div className="rounded-lg border border-border bg-subtle p-3 space-y-1">
              <p className="font-medium text-foreground">{revokeConfirmAssignment.template_name}</p>
              <p className="text-xs text-muted">
                {targetKindLabel(revokeConfirmAssignment.target_kind)}: {revokeConfirmAssignment.target_label} · Chu kỳ{" "}
                {frequencyLabel(revokeConfirmAssignment.frequency)}
              </p>
              <p className="text-xs text-muted">
                Đã nộp (giữ nguyên): {revokeConfirmAssignment.submitted_count} · Chưa hoàn thành sẽ hủy:{" "}
                {revokeConfirmAssignment.not_started_count + revokeConfirmAssignment.draft_count} (Chưa bắt đầu:{" "}
                {revokeConfirmAssignment.not_started_count}, Bản nháp chưa nộp: {revokeConfirmAssignment.draft_count})
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button
                type="button"
                variant="secondary"
                disabled={trackingBusy}
                onClick={() => setRevokeConfirmAssignment(null)}
              >
                Giữ đợt giao
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={trackingBusy}
                onClick={() => void executeUpdateAssignment(revokeConfirmAssignment, "REVOKED")}
              >
                {trackingBusy ? "Đang thu hồi…" : "Xác nhận thu hồi"}
              </Button>
            </div>
          </div>
        ) : null}
      </FormDialog>

      <FormDialog
        open={groupEditor !== null && (activeSubView === "groups" || groupBusy)}
        onOpenChange={(open) => {
          if (!open && !groupBusy) {
            setGroupEditor(null);
            setGroupFormError(null);
          }
        }}
        title={groupEditor?.group ? "Chỉnh sửa nhóm báo cáo" : "Tạo nhóm báo cáo tùy chỉnh"}
        description="Chọn các tài khoản đang hoạt động thuộc phạm vi quyền quản lý báo cáo. Có thể chọn thành viên từ nhiều Team hành chính khác nhau."
        contentClassName="sm:w-[min(44rem,calc(100vw-2rem))]"
        closeDisabled={groupBusy}
      >
        {groupEditor ? (
          <div className="space-y-4">
            {groupFormError ? <StatusBanner tone="error">{groupFormError}</StatusBanner> : null}
            <label className="block space-y-1 text-sm font-medium">
              Tên nhóm báo cáo
              <input
                type="text"
                maxLength={160}
                required
                placeholder="Ví dụ: Nhóm Tuyển dụng, Nhóm QLDA, Nhóm Tổ trưởng"
                value={groupEditor.display_name}
                onChange={(event) =>
                  setGroupEditor((current) => (current ? { ...current, display_name: event.target.value } : current))
                }
                className={`${controlClass} font-normal`}
              />
            </label>
            <label className="block space-y-1 text-sm font-medium">
              Mô tả (tùy chọn)
              <textarea
                rows={2}
                maxLength={1000}
                placeholder="Mục đích sử dụng nhóm phân công báo cáo"
                value={groupEditor.description}
                onChange={(event) =>
                  setGroupEditor((current) => (current ? { ...current, description: event.target.value } : current))
                }
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm font-normal text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </label>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  Thành viên nhóm ({groupEditor.member_user_ids.length} đã chọn)
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={filteredEligibleUsers.length === 0}
                    onClick={() =>
                      setGroupEditor((current) => {
                        if (!current) return current;
                        const merged = new Set([
                          ...current.member_user_ids,
                          ...filteredEligibleUsers.map((user) => user.app_user_id),
                        ]);
                        return { ...current, member_user_ids: Array.from(merged) };
                      })
                    }
                  >
                    Chọn đang lọc
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={groupEditor.member_user_ids.length === 0}
                    onClick={() =>
                      setGroupEditor((current) => {
                        if (!current) return current;
                        const visible = new Set(filteredEligibleUsers.map((user) => user.app_user_id));
                        return {
                          ...current,
                          member_user_ids: current.member_user_ids.filter((id) => !visible.has(id)),
                        };
                      })
                    }
                  >
                    Bỏ chọn đang lọc
                  </Button>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <input
                  type="search"
                  aria-label="Tìm nhân viên theo tên"
                  placeholder="Tìm theo tên nhân viên hoặc Team…"
                  value={memberSearch}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  className="min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm"
                />
                <select
                  aria-label="Lọc nhân viên theo Team"
                  value={memberTeamFilter}
                  onChange={(event) => setMemberTeamFilter(event.target.value)}
                  className="min-h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm"
                >
                  <option value="">Tất cả Team trong phạm vi</option>
                  {memberCandidateTeams.map((team) => (
                    <option key={team.team_id} value={team.team_id}>
                      {team.label}
                    </option>
                  ))}
                  {hasNoTeamEligibleUsers ? <option value="__NO_TEAM__">Chưa gắn Team hành chính</option> : null}
                </select>
              </div>

              <div
                role="group"
                aria-label="Danh sách tài khoản đủ điều kiện nhận báo cáo"
                className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-2"
              >
                {filteredEligibleUsers.length === 0 ? (
                  <p className="p-2 text-xs text-muted">Không có tài khoản đủ điều kiện phù hợp bộ lọc.</p>
                ) : (
                  filteredEligibleUsers.map((user) => {
                    const checked = groupEditor.member_user_ids.includes(user.app_user_id);
                    return (
                      <label
                        key={user.app_user_id}
                        className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-subtle"
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => toggleGroupMember(user.app_user_id, event.target.checked)}
                          />
                          <span>{user.display_name}</span>
                        </span>
                        <span className="text-xs text-muted">
                          {user.team_display_name
                            ? user.team_code
                              ? `${user.team_display_name} (${user.team_code})`
                              : user.team_display_name
                            : "Chưa gắn Team"}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
              <p className="text-xs text-muted">
                Cập nhật thành viên chỉ áp dụng cho các kỳ nghĩa vụ chưa được phát sinh; lịch sử nghĩa vụ và bài nộp cũ không đổi.
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" disabled={groupBusy} onClick={() => setGroupEditor(null)}>
                Hủy
              </Button>
              <Button type="button" variant="primary" disabled={groupBusy} onClick={() => void saveGroup()}>
                {groupBusy ? "Đang lưu…" : groupEditor.group ? "Lưu thay đổi" : "Tạo nhóm"}
              </Button>
            </div>
          </div>
        ) : null}
      </FormDialog>
    </div>
  );
}

function AssignmentDetailPanel({
  assignment,
  busy,
  onAction,
}: {
  assignment: WorkReportAssignmentSummary;
  busy: boolean;
  onAction: (nextState: "ACTIVE" | "PAUSED" | "REVOKED") => void;
}) {
  const hasInlineDetail =
    Array.isArray(assignment.assignee_progress) && Array.isArray(assignment.audit_history);
  const [reloadTick, setReloadTick] = useState(0);
  const requestKey = `${assignment.assignment_id}:${assignment.version}:${assignment.state}:${assignment.obligation_total}:${assignment.submitted_count}:${assignment.not_started_count}:${assignment.draft_count}:${reloadTick}`;
  const [fetchedDetail, setFetchedDetail] = useState<{
    key: string;
    assignee_progress: readonly WorkReportAssignmentProgressItem[];
    audit_history: readonly WorkReportAssignmentAuditItem[];
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (hasInlineDetail) return;

    const controller = new AbortController();
    fetch(`/api/work-reports/assignments/${encodeURIComponent(assignment.assignment_id)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (
          !response.ok ||
          result?.ok !== true ||
          !Array.isArray(result.assignee_progress) ||
          !Array.isArray(result.audit_history)
        ) {
          throw new Error(result?.code ?? "WORK_REPORT_UNAVAILABLE");
        }
        if (controller.signal.aborted) return;
        setFetchedDetail({
          key: requestKey,
          assignee_progress: result.assignee_progress as WorkReportAssignmentProgressItem[],
          audit_history: result.audit_history as WorkReportAssignmentAuditItem[],
          error: null,
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const code = cause instanceof Error ? cause.message : "WORK_REPORT_UNAVAILABLE";
        setFetchedDetail({
          key: requestKey,
          assignee_progress: [],
          audit_history: [],
          error:
            code === "WORK_REPORT_ACCESS_DENIED" || code === "WORK_REPORT_SCOPE_DENIED"
              ? "Bạn không có quyền xem chi tiết đợt giao này."
              : "Không tải được chi tiết tiến độ thành viên và lịch sử đợt giao.",
        });
      });

    return () => controller.abort();
  }, [assignment.assignment_id, hasInlineDetail, requestKey]);

  const loading = !hasInlineDetail && fetchedDetail?.key !== requestKey;
  const detailError = !hasInlineDetail && fetchedDetail?.key === requestKey ? fetchedDetail.error : null;
  const assigneeProgress: readonly WorkReportAssignmentProgressItem[] = hasInlineDetail
    ? (assignment.assignee_progress ?? [])
    : (fetchedDetail?.assignee_progress ?? []);
  const auditHistory: readonly WorkReportAssignmentAuditItem[] = hasInlineDetail
    ? (assignment.audit_history ?? [])
    : (fetchedDetail?.audit_history ?? []);

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">Chi tiết đợt giao & Tiến độ từng người</h4>
        <div className="flex flex-wrap gap-2">
          {assignment.state === "ACTIVE" ? (
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onAction("PAUSED")}>
              Tạm dừng đợt giao
            </Button>
          ) : null}
          {assignment.state === "PAUSED" ? (
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onAction("ACTIVE")}>
              Kích hoạt lại đợt giao
            </Button>
          ) : null}
          {assignment.state !== "REVOKED" ? (
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => onAction("REVOKED")}>
              Thu hồi đợt giao
            </Button>
          ) : null}
        </div>
      </div>

      {detailError ? (
        <StatusBanner tone="error">
          <div className="flex flex-wrap items-center gap-2">
            <span>{detailError}</span>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => setReloadTick((prev) => prev + 1)}
            >
              Thử lại
            </Button>
          </div>
        </StatusBanner>
      ) : null}

      {loading ? (
        <p role="status" className="rounded-lg bg-subtle p-3 text-xs text-muted">
          Đang tải chi tiết tiến độ thành viên và lịch sử đợt giao…
        </p>
      ) : (
        <>
          <div className="space-y-2">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Tiến độ từng thành viên — kỳ gần nhất ({assigneeProgress.length})
            </h5>
            {assigneeProgress.length === 0 ? (
              <p className="rounded-lg bg-subtle p-3 text-xs text-muted">
                Chưa có nghĩa vụ nào được phát sinh cho đợt giao này.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-border bg-subtle text-muted">
                    <tr>
                      <th className="px-3 py-2 font-medium">Thành viên</th>
                      <th className="px-3 py-2 font-medium">Kỳ gần nhất</th>
                      <th className="px-3 py-2 font-medium">Hạn nộp</th>
                      <th className="px-3 py-2 font-medium">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {assigneeProgress.map((row) => (
                      <tr key={`${row.assignee_app_user_id}-${row.period_key}`}>
                        <td className="px-3 py-2 font-medium text-foreground">{row.assignee_display_name}</td>
                        <td className="px-3 py-2 tabular-nums text-muted">{row.period_key}</td>
                        <td className="px-3 py-2 tabular-nums text-muted">
                          {new Date(row.due_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge tone={progressBadgeTone(row)}>
                            {progressBadgeLabel(row)}
                          </StatusBadge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">
              Lịch sử thay đổi đợt giao gần nhất ({auditHistory.length})
            </h5>
            {auditHistory.length === 0 ? (
              <p className="rounded-lg bg-subtle p-3 text-xs text-muted">Chưa có lịch sử thay đổi.</p>
            ) : (
              <ol className="space-y-1.5 rounded-lg border border-border bg-subtle/40 p-3 text-xs">
                {auditHistory.map((item) => (
                  <li key={item.event_id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <strong className="font-medium text-foreground">{auditEventLabel(item)}</strong>
                      {item.actor_display_name ? ` · thực hiện bởi ${item.actor_display_name}` : ""}
                    </span>
                    <span className="tabular-nums text-muted">
                      {new Date(item.created_at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function progressBadgeTone(
  row: WorkReportAssignmentProgressItem,
): "success" | "warning" | "danger" | "neutral" {
  if (row.obligation_status !== "ACTIVE") return "neutral";
  if (row.is_overdue) return "danger";
  if (row.submission_state === "APPROVED" || row.submission_state === "COMPLETED" || row.submission_state === "PENDING_REVIEW") {
    return "success";
  }
  if (row.submission_state === "REJECTED" || row.submission_state === "DRAFT") {
    return "warning";
  }
  return "neutral";
}

function progressBadgeLabel(row: WorkReportAssignmentProgressItem): string {
  if (row.obligation_status === "CANCELLED") return "Đã hủy";
  if (row.obligation_status === "EXEMPTED") return "Được miễn";
  if (row.is_overdue) {
    return row.submission_state === "DRAFT" ? "Quá hạn (Đang nháp)" : "Quá hạn (Chưa nộp)";
  }
  switch (row.submission_state) {
    case "APPROVED":
      return "Đã duyệt";
    case "COMPLETED":
    case "PENDING_REVIEW":
      return "Đã nộp";
    case "REJECTED":
      return "Bị từ chối · Chờ nộp lại";
    case "DRAFT":
      return "Đang lưu nháp";
    default:
      return "Chưa bắt đầu";
  }
}

function auditEventLabel(item: WorkReportAssignmentAuditItem): string {
  if (item.action === "ASSIGNMENT_CREATE") return "Tạo đợt giao";
  if (item.state === "PAUSED") return "Tạm dừng đợt giao";
  if (item.state === "REVOKED") return "Thu hồi đợt giao";
  return "Kích hoạt lại đợt giao";
}

function targetKindLabel(value: string) {
  return (
    ({
      USER: "Nhân viên",
      TEAM: "Team",
      USER_SET: "Danh sách",
      GROUP: "Nhóm báo cáo",
    } as Record<string, string>)[value] ?? value
  );
}

function frequencyLabel(value: string) {
  return (
    ({ DAILY: "hằng ngày", WEEKLY: "hằng tuần", MONTHLY: "hằng tháng", ONCE: "một lần" } as Record<string, string>)[
      value
    ] ?? value
  );
}

function stateLabel(value: string) {
  return (
    ({ ACTIVE: "đang hoạt động", PAUSED: "tạm dừng", REVOKED: "đã thu hồi" } as Record<string, string>)[value] ??
    value
  );
}
