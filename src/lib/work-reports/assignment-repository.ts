import "server-only";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type WorkReportActorRef = { auth_subject: string; app_user_id: string };

export type AssignmentCreateInput = WorkReportActorRef & {
  template_id: string;
  target_kind: "USER" | "TEAM" | "USER_SET" | "GROUP";
  target_user_id: string | null;
  target_team_id: string | null;
  target_group_id?: string | null;
  target_user_ids: string[];
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "ONCE";
  is_mandatory: boolean;
  due_day_offset: number;
  due_time_local: string;
  exclude_sundays: boolean;
  effective_from?: string | null;
  effective_to?: string | null;
  idempotency_key: string;
};

export type WorkReportInvalidReasonCode =
  | "WORK_REPORT_ASSIGNMENT_INVALID"
  | "WORK_REPORT_GROUP_MEMBER_INELIGIBLE"
  | "WORK_REPORT_GROUP_INACTIVE"
  | "WORK_REPORT_TEMPLATE_NOT_ACTIVE";

export type WorkReportRpcOutcome<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      kind: "conflict" | "denied" | "invalid" | "not-found" | "unavailable";
      code?: WorkReportInvalidReasonCode;
    };

export type WorkReportAssignmentOptions = {
  templates: readonly {
    template_id: string; template_code: string; display_name: string;
    default_frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "ONCE";
    current_published_version_id: string;
  }[];
  teams: readonly { team_id: string; code: string; display_name: string }[];
  users: readonly { app_user_id: string; display_name: string }[];
};

export type WorkReportGroupMember = {
  app_user_id: string;
  display_name: string;
  enabled: boolean;
  team_id: string | null;
  team_code: string | null;
  team_display_name: string | null;
};

export type WorkReportGroupItem = {
  group_id: string;
  display_name: string;
  description: string | null;
  active: boolean;
  version: number;
  created_at: string;
  updated_at: string;
  assignment_count: number;
  members: readonly WorkReportGroupMember[];
};

export type WorkReportEligibleGroupUser = {
  app_user_id: string;
  display_name: string;
  team_id: string | null;
  team_code: string | null;
  team_display_name: string | null;
};

export type WorkReportGroupsDirectory = {
  scope_kind: "all" | "team";
  groups: readonly WorkReportGroupItem[];
  eligible_users: readonly WorkReportEligibleGroupUser[];
};

export type GroupCreateInput = WorkReportActorRef & {
  display_name: string;
  description: string | null;
  member_user_ids: string[];
  idempotency_key: string;
};

export type GroupUpdateInput = WorkReportActorRef & {
  group_id: string;
  expected_version: number;
  display_name: string;
  description: string | null;
  member_user_ids: string[];
  idempotency_key: string;
};

export type GroupSetActiveInput = WorkReportActorRef & {
  group_id: string;
  expected_version: number;
  active: boolean;
  idempotency_key: string;
};

export type WorkReportAssignmentProgressItem = {
  obligation_id: string;
  assignee_app_user_id: string;
  assignee_display_name: string;
  period_key: string;
  period_start_date: string;
  period_end_date: string;
  due_at: string;
  reopened_until: string | null;
  obligation_status: "ACTIVE" | "EXEMPTED" | "CANCELLED";
  submission_state: "NOT_STARTED" | "DRAFT" | "COMPLETED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  is_overdue: boolean;
  submitted_at: string | null;
  version: number;
};

export type WorkReportAssignmentAuditItem = {
  event_id: string;
  action: "ASSIGNMENT_CREATE" | "ASSIGNMENT_STATE";
  state: "ACTIVE" | "PAUSED" | "REVOKED";
  actor_user_id: string;
  actor_display_name: string;
  created_at: string;
};

export type WorkReportAssignmentSummary = {
  assignment_id: string;
  template_id: string;
  template_code: string;
  template_name: string;
  target_kind: "USER" | "TEAM" | "USER_SET" | "GROUP";
  target_group_id?: string | null;
  target_label: string;
  target_member_count?: number;
  frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "ONCE";
  is_mandatory: boolean;
  due_day_offset?: number;
  due_time_local?: string;
  exclude_sundays?: boolean;
  effective_from: string;
  effective_to: string | null;
  state: "ACTIVE" | "PAUSED" | "REVOKED";
  version: number;
  created_at: string;
  obligation_total: number;
  submitted_count: number;
  not_started_count: number;
  draft_count: number;
  overdue_count?: number;
  rejected_count?: number;
  exempted_count: number;
  cancelled_count: number;
  assignee_progress?: readonly WorkReportAssignmentProgressItem[];
  audit_history?: readonly WorkReportAssignmentAuditItem[];
};

export type WorkReportAssignmentDetail = {
  assignment_id: string;
  assignee_progress: readonly WorkReportAssignmentProgressItem[];
  audit_history: readonly WorkReportAssignmentAuditItem[];
};

export type AssignmentRepository = {
  hasAssignmentAccess(input: WorkReportActorRef): Promise<WorkReportRpcOutcome<boolean>>;
  listOptions(input: WorkReportActorRef & { team_id: string | null }): Promise<WorkReportRpcOutcome<WorkReportAssignmentOptions>>;
  listAssignments(input: WorkReportActorRef & { team_id: string | null }): Promise<WorkReportRpcOutcome<WorkReportAssignmentSummary[]>>;
  getAssignmentDetail?(input: WorkReportActorRef & { assignment_id: string }): Promise<WorkReportRpcOutcome<WorkReportAssignmentDetail>>;
  listGroups(input: WorkReportActorRef): Promise<WorkReportRpcOutcome<WorkReportGroupsDirectory>>;
  createGroup(input: GroupCreateInput): Promise<WorkReportRpcOutcome<{ group_id: string; version: number }>>;
  updateGroup(input: GroupUpdateInput): Promise<WorkReportRpcOutcome<{ group_id: string; version: number }>>;
  setGroupActive(input: GroupSetActiveInput): Promise<WorkReportRpcOutcome<{ group_id: string; active: boolean; version: number }>>;
  create(input: AssignmentCreateInput): Promise<WorkReportRpcOutcome<{ assignment_id: string; version: number }>>;
  setState(input: WorkReportActorRef & {
    assignment_id: string; expected_version: number; state: "ACTIVE" | "PAUSED" | "REVOKED"; idempotency_key: string;
  }): Promise<WorkReportRpcOutcome<Record<string, unknown>>>;
  changeObligation(input: WorkReportActorRef & {
    obligation_id: string; expected_version: number; action: "EXEMPT" | "REOPEN";
    reason: string; reopened_until: string | null; idempotency_key: string;
  }): Promise<WorkReportRpcOutcome<Record<string, unknown>>>;
  materialize(input: WorkReportActorRef & { business_date: string }): Promise<WorkReportRpcOutcome<Record<string, unknown>>>;
};

function serviceRoleRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) => createServiceSupabaseClient());
  return async (name, args) => (await client).rpc(name, args);
}

function classify(error: { code?: string }): "conflict" | "denied" | "invalid" | "not-found" | "unavailable" {
  if (error.code === "PT409" || error.code === "40001" || error.code === "23505") return "conflict";
  if (error.code === "42501") return "denied";
  if (error.code === "P0002") return "not-found";
  if (error.code === "22023") return "invalid";
  return "unavailable";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const KNOWN_INVALID_REASON_CODES: readonly WorkReportInvalidReasonCode[] = [
  "WORK_REPORT_ASSIGNMENT_INVALID",
  "WORK_REPORT_GROUP_MEMBER_INELIGIBLE",
  "WORK_REPORT_GROUP_INACTIVE",
  "WORK_REPORT_TEMPLATE_NOT_ACTIVE",
];

function extractInvalidReasonCode(
  error: { code?: string; message?: string },
): WorkReportInvalidReasonCode | undefined {
  if (error.code !== "22023" || typeof error.message !== "string") return undefined;
  return KNOWN_INVALID_REASON_CODES.find((code) => error.message?.includes(code));
}

function outcome<T>(
  data: unknown,
  error: { code?: string; message?: string } | null,
  valid: (value: unknown) => value is T,
): WorkReportRpcOutcome<T> {
  if (error) {
    const kind = classify(error);
    const reasonCode = extractInvalidReasonCode(error);
    return reasonCode ? { ok: false, kind, code: reasonCode } : { ok: false, kind };
  }
  return valid(data) ? { ok: true, data } : { ok: false, kind: "unavailable" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versioned = (value: unknown): value is Record<string, unknown> => record(value) && Number.isInteger(value.version);

function assignmentOptions(value: unknown): value is WorkReportAssignmentOptions {
  if (!record(value) || !Array.isArray(value.templates) || !Array.isArray(value.teams) || !Array.isArray(value.users)) return false;
  return value.templates.every((item) => record(item) && UUID.test(String(item.template_id)) &&
      typeof item.template_code === "string" && typeof item.display_name === "string" &&
      ["DAILY", "WEEKLY", "MONTHLY", "ONCE"].includes(String(item.default_frequency)) &&
      UUID.test(String(item.current_published_version_id))) &&
    value.teams.every((item) => record(item) && UUID.test(String(item.team_id)) &&
      typeof item.code === "string" && typeof item.display_name === "string") &&
    value.users.every((item) => record(item) && UUID.test(String(item.app_user_id)) &&
      typeof item.display_name === "string");
}

function nullableUuid(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && UUID.test(value));
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function groupsDirectory(value: unknown): value is WorkReportGroupsDirectory {
  if (
    !record(value) ||
    !["all", "team"].includes(String(value.scope_kind)) ||
    !Array.isArray(value.groups) ||
    !Array.isArray(value.eligible_users)
  ) {
    return false;
  }
  return (
    value.groups.every(
      (group) =>
        record(group) &&
        UUID.test(String(group.group_id)) &&
        typeof group.display_name === "string" &&
        nullableString(group.description) &&
        typeof group.active === "boolean" &&
        Number.isInteger(group.version) &&
        Number(group.version) >= 1 &&
        typeof group.created_at === "string" &&
        typeof group.updated_at === "string" &&
        Number.isInteger(group.assignment_count) &&
        Number(group.assignment_count) >= 0 &&
        Array.isArray(group.members) &&
        group.members.every(
          (member) =>
            record(member) &&
            UUID.test(String(member.app_user_id)) &&
            typeof member.display_name === "string" &&
            typeof member.enabled === "boolean" &&
            nullableUuid(member.team_id) &&
            nullableString(member.team_code) &&
            nullableString(member.team_display_name),
        ),
    ) &&
    value.eligible_users.every(
      (user) =>
        record(user) &&
        UUID.test(String(user.app_user_id)) &&
        typeof user.display_name === "string" &&
        nullableUuid(user.team_id) &&
        nullableString(user.team_code) &&
        nullableString(user.team_display_name),
    )
  );
}

function assignmentList(value: unknown): value is { items: WorkReportAssignmentSummary[] } {
  return record(value) && Array.isArray(value.items) && value.items.every((item) => record(item) &&
    UUID.test(String(item.assignment_id)) && UUID.test(String(item.template_id)) &&
    typeof item.template_code === "string" && typeof item.template_name === "string" &&
    ["USER", "TEAM", "USER_SET", "GROUP"].includes(String(item.target_kind)) &&
    (item.target_group_id === undefined || nullableUuid(item.target_group_id)) &&
    typeof item.target_label === "string" &&
    (item.target_member_count === undefined || (Number.isInteger(item.target_member_count) && Number(item.target_member_count) >= 0)) &&
    ["DAILY", "WEEKLY", "MONTHLY", "ONCE"].includes(String(item.frequency)) &&
    typeof item.is_mandatory === "boolean" &&
    (item.due_day_offset === undefined || (Number.isInteger(item.due_day_offset) && Number(item.due_day_offset) >= 0)) &&
    (item.due_time_local === undefined || typeof item.due_time_local === "string") &&
    (item.exclude_sundays === undefined || typeof item.exclude_sundays === "boolean") &&
    typeof item.effective_from === "string" &&
    (item.effective_to === null || typeof item.effective_to === "string") &&
    ["ACTIVE", "PAUSED", "REVOKED"].includes(String(item.state)) && Number.isInteger(item.version) &&
    typeof item.created_at === "string" &&
    [item.obligation_total, item.submitted_count, item.not_started_count, item.draft_count,
      item.exempted_count, item.cancelled_count].every((count) => Number.isInteger(count) && Number(count) >= 0) &&
    (item.overdue_count === undefined || (Number.isInteger(item.overdue_count) && Number(item.overdue_count) >= 0)) &&
    (item.rejected_count === undefined || (Number.isInteger(item.rejected_count) && Number(item.rejected_count) >= 0)) &&
    (item.assignee_progress === undefined || Array.isArray(item.assignee_progress)) &&
    (item.audit_history === undefined || Array.isArray(item.audit_history)));
}

function assignmentDetail(value: unknown): value is WorkReportAssignmentDetail {
  return (
    record(value) &&
    typeof value.assignment_id === "string" &&
    UUID.test(value.assignment_id) &&
    Array.isArray(value.assignee_progress) &&
    value.assignee_progress.every(
      (item) =>
        record(item) &&
        UUID.test(String(item.obligation_id)) &&
        UUID.test(String(item.assignee_app_user_id)) &&
        typeof item.assignee_display_name === "string" &&
        typeof item.period_key === "string" &&
        typeof item.period_start_date === "string" &&
        typeof item.period_end_date === "string" &&
        typeof item.due_at === "string" &&
        nullableString(item.reopened_until) &&
        ["ACTIVE", "EXEMPTED", "CANCELLED"].includes(String(item.obligation_status)) &&
        ["NOT_STARTED", "DRAFT", "COMPLETED", "PENDING_REVIEW", "APPROVED", "REJECTED"].includes(String(item.submission_state)) &&
        typeof item.is_overdue === "boolean" &&
        nullableString(item.submitted_at) &&
        Number.isInteger(item.version),
    ) &&
    Array.isArray(value.audit_history) &&
    value.audit_history.every(
      (item) =>
        record(item) &&
        UUID.test(String(item.event_id)) &&
        ["ASSIGNMENT_CREATE", "ASSIGNMENT_STATE"].includes(String(item.action)) &&
        ["ACTIVE", "PAUSED", "REVOKED"].includes(String(item.state)) &&
        UUID.test(String(item.actor_user_id)) &&
        typeof item.actor_display_name === "string" &&
        typeof item.created_at === "string",
    )
  );
}

export function createAssignmentRepository(rpc?: Rpc): AssignmentRepository {
  let call = rpc;
  const invoke: Rpc = async (name, args) => {
    call ??= serviceRoleRpc();
    return call(name, args);
  };
  return {
    async hasAssignmentAccess(input) {
      try {
        const { data, error } = await invoke("work_report_has_assignment_access", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
        });
        return outcome(data, error, (value): value is boolean => typeof value === "boolean");
      } catch {
        console.error("[work-reports] assignment access RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async listOptions(input) {
      try {
        const { data, error } = await invoke("work_report_list_assignment_options", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id, p_team_id: input.team_id,
        });
        return outcome(data, error, assignmentOptions);
      } catch {
        console.error("[work-reports] assignment options RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async listAssignments(input) {
      try {
        const { data, error } = await invoke("work_report_list_assignments", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id, p_team_id: input.team_id,
        });
        const result = outcome(data, error, assignmentList);
        return result.ok ? { ok: true, data: result.data.items } : result;
      } catch {
        console.error("[work-reports] assignment list RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async getAssignmentDetail(input) {
      try {
        const { data, error } = await invoke("work_report_get_assignment_detail", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_assignment_id: input.assignment_id,
        });
        return outcome(data, error, assignmentDetail);
      } catch {
        console.error("[work-reports] assignment detail RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async listGroups(input) {
      try {
        const { data, error } = await invoke("work_report_list_groups", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
        });
        return outcome(data, error, groupsDirectory);
      } catch {
        console.error("[work-reports] group list RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async createGroup(input) {
      try {
        const { data, error } = await invoke("work_report_create_group", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_display_name: input.display_name,
          p_description: input.description,
          p_member_user_ids: input.member_user_ids,
          p_idempotency_key: input.idempotency_key,
        });
        return outcome(
          data,
          error,
          (value): value is { group_id: string; version: number } =>
            record(value) &&
            typeof value.group_id === "string" &&
            UUID.test(value.group_id) &&
            Number.isInteger(value.version) &&
            Number(value.version) >= 1,
        );
      } catch {
        console.error("[work-reports] group create RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async updateGroup(input) {
      try {
        const { data, error } = await invoke("work_report_update_group", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_group_id: input.group_id,
          p_expected_version: input.expected_version,
          p_display_name: input.display_name,
          p_description: input.description,
          p_member_user_ids: input.member_user_ids,
          p_idempotency_key: input.idempotency_key,
        });
        return outcome(
          data,
          error,
          (value): value is { group_id: string; version: number } =>
            record(value) &&
            typeof value.group_id === "string" &&
            UUID.test(value.group_id) &&
            Number.isInteger(value.version) &&
            Number(value.version) >= 1,
        );
      } catch {
        console.error("[work-reports] group update RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async setGroupActive(input) {
      try {
        const { data, error } = await invoke("work_report_set_group_active", {
          p_auth_subject: input.auth_subject,
          p_app_user_id: input.app_user_id,
          p_group_id: input.group_id,
          p_expected_version: input.expected_version,
          p_active: input.active,
          p_idempotency_key: input.idempotency_key,
        });
        return outcome(
          data,
          error,
          (value): value is { group_id: string; active: boolean; version: number } =>
            record(value) &&
            typeof value.group_id === "string" &&
            UUID.test(value.group_id) &&
            typeof value.active === "boolean" &&
            Number.isInteger(value.version) &&
            Number(value.version) >= 1,
        );
      } catch {
        console.error("[work-reports] group active RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async create(input) {
      try {
        const { data, error } = input.target_kind === "GROUP"
          ? await invoke("work_report_create_group_assignment", {
              p_auth_subject: input.auth_subject,
              p_app_user_id: input.app_user_id,
              p_template_id: input.template_id,
              p_target_group_id: input.target_group_id ?? null,
              p_frequency: input.frequency,
              p_is_mandatory: input.is_mandatory,
              p_due_day_offset: input.due_day_offset,
              p_due_time_local: input.due_time_local,
              p_exclude_sundays: input.exclude_sundays,
              p_effective_from: input.effective_from ?? null,
              p_effective_to: input.effective_to ?? null,
              p_idempotency_key: input.idempotency_key,
            })
          : await invoke("work_report_create_assignment", {
              p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
              p_template_id: input.template_id, p_target_kind: input.target_kind,
              p_target_user_id: input.target_user_id, p_target_team_id: input.target_team_id,
              p_target_user_ids: input.target_user_ids.length ? input.target_user_ids : null,
              p_frequency: input.frequency, p_is_mandatory: input.is_mandatory,
              p_due_day_offset: input.due_day_offset, p_due_time_local: input.due_time_local,
              p_exclude_sundays: input.exclude_sundays, p_effective_from: input.effective_from ?? null,
              p_effective_to: input.effective_to ?? null, p_idempotency_key: input.idempotency_key,
            });
        return outcome(data, error, (value): value is { assignment_id: string; version: number } =>
          record(value) && typeof value.assignment_id === "string" && UUID.test(value.assignment_id) && value.version === 1);
      } catch {
        console.error("[work-reports] assignment create RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async setState(input) {
      try {
        const { data, error } = await invoke("work_report_set_assignment_state", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
          p_assignment_id: input.assignment_id, p_expected_version: input.expected_version,
          p_state: input.state, p_idempotency_key: input.idempotency_key,
        });
        return outcome(data, error, versioned);
      } catch {
        console.error("[work-reports] assignment state RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async changeObligation(input) {
      try {
        const { data, error } = await invoke("work_report_change_obligation_status", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id,
          p_obligation_id: input.obligation_id, p_expected_version: input.expected_version,
          p_action: input.action, p_reason: input.reason, p_reopened_until: input.reopened_until,
          p_idempotency_key: input.idempotency_key,
        });
        return outcome(data, error, versioned);
      } catch {
        console.error("[work-reports] obligation status RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
    async materialize(input) {
      try {
        const { data, error } = await invoke("work_report_ensure_obligations_for_window", {
          p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id, p_business_date: input.business_date,
        });
        return outcome(data, error, record);
      } catch {
        console.error("[work-reports] obligation materialization RPC failed");
        return { ok: false, kind: "unavailable" };
      }
    },
  };
}
