import "server-only";

import type { WorkReportTemplateSchema } from "./contracts.ts";
import type { WorkReportActorRef, WorkReportRpcOutcome } from "./assignment-repository.ts";
import { validateWorkReportSchema } from "./schema-validator.ts";

type Rpc = (name: string, args: Record<string, unknown>) => Promise<{
  data: unknown;
  error: { code?: string; message?: string } | null;
}>;

export type WorkReportSubmissionRpcOutcome<T> =
  | WorkReportRpcOutcome<T>
  | { ok: false; kind: "deadline-passed" };

export type WorkReportObligation = {
  obligation_id: string;
  template_id: string;
  template_version_id: string;
  template_code: string;
  template_name: string;
  period_type: string;
  period_key: string;
  period_start_date: string;
  period_end_date: string;
  due_at: string;
  is_mandatory: boolean;
  obligation_status: "ACTIVE" | "EXEMPTED" | "CANCELLED";
  reopened_until: string | null;
  is_overdue: boolean;
  version: number;
  submission_id: string | null;
  submission_state: "NOT_STARTED" | "DRAFT" | "COMPLETED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  submission_version: number | null;
  schema_json: WorkReportTemplateSchema;
};

export type WorkReportLatestReviewEvent = {
  decision: "APPROVED" | "REJECTED";
  reason: string | null;
  reviewed_at: string;
};

export type WorkReportSubmissionDetail = {
  obligation: Record<string, unknown>;
  template: { template_code: string; display_name: string; schema_json: WorkReportTemplateSchema };
  submission: null | {
    submission_id: string; state: string; draft_payload_json: Record<string, unknown> | null;
    first_submitted_at: string | null; latest_submitted_at: string | null; is_late: boolean;
    has_post_deadline_amendment: boolean; current_revision_id: string | null; version: number;
  };
  latest_review_event?: WorkReportLatestReviewEvent | null;
  revisions: Array<{ revision_id: string; revision_no: number; payload_json: Record<string, unknown>; created_at: string }>;
};

export type WorkReportActiveObligationsProbe = {
  has_active_obligations: boolean;
};

export type SubmissionRepository = {
  hasActiveObligations(input: WorkReportActorRef): Promise<WorkReportSubmissionRpcOutcome<WorkReportActiveObligationsProbe>>;
  listMine(input: WorkReportActorRef & { status: string | null }): Promise<WorkReportSubmissionRpcOutcome<WorkReportObligation[]>>;
  get(input: WorkReportActorRef & { obligation_id: string }): Promise<WorkReportSubmissionRpcOutcome<WorkReportSubmissionDetail>>;
  saveDraft(input: WorkReportActorRef & { obligation_id: string; payload_json: Record<string, unknown>;
    expected_version: number | null; idempotency_key: string }): Promise<WorkReportSubmissionRpcOutcome<Record<string, unknown>>>;
  submit(input: WorkReportActorRef & { obligation_id: string; payload_json: Record<string, unknown>;
    expected_version: number | null; idempotency_key: string }): Promise<WorkReportSubmissionRpcOutcome<Record<string, unknown>>>;
};

function serviceRpc(): Rpc {
  const client = import("../supabase/server").then(({ createServiceSupabaseClient }) => createServiceSupabaseClient());
  return async (name, args) => (await client).rpc(name, args);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function classify(error: { code?: string; message?: string }): WorkReportSubmissionRpcOutcome<never> {
  if (error.code === "PT409" || error.code === "40001" || error.code === "23505") return { ok: false, kind: "conflict" };
  if (error.code === "42501" && error.message?.includes("WORK_REPORT_DEADLINE_PASSED")) {
    return { ok: false, kind: "deadline-passed" };
  }
  if (error.code === "42501") return { ok: false, kind: "denied" };
  if (error.code === "P0002") return { ok: false, kind: "not-found" };
  if (error.code === "22023") return { ok: false, kind: "invalid" };
  return { ok: false, kind: "unavailable" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isObligation(value: unknown): value is WorkReportObligation {
  return isRecord(value) && typeof value.obligation_id === "string" && UUID.test(value.obligation_id) &&
    typeof value.template_id === "string" && UUID.test(value.template_id) &&
    typeof value.template_version_id === "string" && UUID.test(value.template_version_id) &&
    typeof value.template_code === "string" && typeof value.template_name === "string" &&
    typeof value.period_type === "string" && typeof value.period_key === "string" &&
    typeof value.period_start_date === "string" && typeof value.period_end_date === "string" &&
    typeof value.due_at === "string" && typeof value.is_mandatory === "boolean" &&
    ["ACTIVE", "EXEMPTED", "CANCELLED"].includes(String(value.obligation_status)) &&
    (value.reopened_until === null || typeof value.reopened_until === "string") &&
    (value.is_overdue === undefined || typeof value.is_overdue === "boolean") &&
    Number.isInteger(value.version) &&
    (value.submission_id === null || (typeof value.submission_id === "string" && UUID.test(value.submission_id))) &&
    ["NOT_STARTED", "DRAFT", "COMPLETED", "PENDING_REVIEW", "APPROVED", "REJECTED"].includes(String(value.submission_state)) &&
    (value.submission_version === null || Number.isInteger(value.submission_version)) &&
    validateWorkReportSchema(value.schema_json).ok;
}

function isLatestReviewEvent(value: unknown): value is WorkReportLatestReviewEvent {
  return isRecord(value) &&
    (value.decision === "APPROVED" || value.decision === "REJECTED") &&
    (value.reason === null || typeof value.reason === "string") &&
    typeof value.reviewed_at === "string";
}

function isDetail(value: unknown): value is WorkReportSubmissionDetail {
  return isRecord(value) && isRecord(value.obligation) &&
    (value.obligation.is_overdue === undefined || typeof value.obligation.is_overdue === "boolean") &&
    isRecord(value.template) &&
    typeof value.template.template_code === "string" && typeof value.template.display_name === "string" &&
    validateWorkReportSchema(value.template.schema_json).ok && Array.isArray(value.revisions) && value.revisions.every((revision) =>
      isRecord(revision) && typeof revision.revision_id === "string" && UUID.test(revision.revision_id) &&
      Number.isInteger(revision.revision_no) && isRecord(revision.payload_json) && typeof revision.created_at === "string") &&
    (value.latest_review_event === undefined || value.latest_review_event === null || isLatestReviewEvent(value.latest_review_event)) &&
    (value.submission === null || (isRecord(value.submission) && typeof value.submission.submission_id === "string" &&
      UUID.test(value.submission.submission_id) && typeof value.submission.state === "string" &&
      (value.submission.draft_payload_json === null || isRecord(value.submission.draft_payload_json)) &&
      (value.submission.first_submitted_at === null || typeof value.submission.first_submitted_at === "string") &&
      (value.submission.latest_submitted_at === null || typeof value.submission.latest_submitted_at === "string") &&
      typeof value.submission.is_late === "boolean" && typeof value.submission.has_post_deadline_amendment === "boolean" &&
      (value.submission.current_revision_id === null || (typeof value.submission.current_revision_id === "string" && UUID.test(value.submission.current_revision_id))) &&
      Number.isInteger(value.submission.version)));
}

function isActiveObligationsProbe(value: unknown): value is WorkReportActiveObligationsProbe {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "has_active_obligations" && typeof value.has_active_obligations === "boolean";
}

function isObligationList(value: unknown): value is { items: WorkReportObligation[] } {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isObligation);
}

function validWrite(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0 &&
    (value.version === undefined || Number.isInteger(value.version));
}

export function createSubmissionRepository(rpc?: Rpc): SubmissionRepository {
  let call = rpc;
  const invoke: Rpc = async (name, args) => { call ??= serviceRpc(); return call(name, args); };
  const run = async <T>(name: string, args: Record<string, unknown>, valid: (value: unknown) => value is T): Promise<WorkReportSubmissionRpcOutcome<T>> => {
    try {
      const { data, error } = await invoke(name, args);
      if (error) return classify(error);
      return valid(data) ? { ok: true, data } : { ok: false, kind: "unavailable" };
    } catch {
      console.error(`[work-reports] ${name} RPC failed`);
      return { ok: false, kind: "unavailable" };
    }
  };
  return {
    hasActiveObligations(input) {
      return run("work_report_has_active_obligations", {
        p_auth_subject: input.auth_subject,
        p_app_user_id: input.app_user_id,
      }, isActiveObligationsProbe);
    },
    listMine(input) {
      return run("work_report_list_my_obligations", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id, p_status: input.status,
      }, isObligationList).then((result) => result.ok ? {
        ok: true,
        data: result.data.items.map((item) => ({
          ...item,
          is_overdue: Boolean(item.is_overdue),
        })),
      } : result);
    },
    get(input) {
      return run("work_report_get_submission", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id, p_obligation_id: input.obligation_id,
      }, isDetail).then((result) => result.ok ? {
        ok: true,
        data: {
          ...result.data,
          obligation: {
            ...result.data.obligation,
            is_overdue: Boolean(result.data.obligation.is_overdue),
          },
        },
      } : result);
    },
    saveDraft(input) {
      return run("work_report_save_draft", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id, p_obligation_id: input.obligation_id,
        p_payload_json: input.payload_json, p_expected_version: input.expected_version, p_idempotency_key: input.idempotency_key,
      }, validWrite);
    },
    submit(input) {
      return run("work_report_submit", {
        p_auth_subject: input.auth_subject, p_app_user_id: input.app_user_id, p_obligation_id: input.obligation_id,
        p_payload_json: input.payload_json, p_expected_version: input.expected_version, p_idempotency_key: input.idempotency_key,
      }, validWrite);
    },
  };
}
