import {
  isRealCalendarDate,
  isWithinInterval,
  normalizeReportingKey,
} from "../analytics/identity/identity-shared.mjs";
import { isCanonicalNationalId } from "./national-id.ts";
import type {
  ProviderMembership,
  RecruiterIdentity,
  TeamIdentity,
  TeamMembership,
} from "../analytics/identity/contracts.ts";

export const DIRECT_ENTRY_CONTRACT_VERSION = "direct-entry/1.1" as const;
export const DEFAULT_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DOCUMENT_MAX_BYTES_HARD_LIMIT = 10 * 1024 * 1024;
export const DOCUMENT_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;

export type ProviderType = "hrp" | "vendor";
/**
 * P3.1-W02C-R1: labor type is a DYNAMIC catalog, so the shared contract validates
 * only the canonical key SHAPE. Whether a key exists, and whether it is still
 * active, is decided by the database active-catalog guard
 * (public.direct_entry_is_active_labor_type) together with the hard RESTRICT
 * foreign key on direct_entries.labor_type - never by a closed list in a server,
 * route, repository or CLI boundary. `isCanonicalLaborTypeKey` is the single
 * predicate every backend and CLI consumer must reuse; a second copy of the
 * vocabulary anywhere in those layers is a defect.
 */
export const LABOR_TYPE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export type LaborType = string;
export function isCanonicalLaborTypeKey(value: unknown): value is LaborType {
  return typeof value === "string" && LABOR_TYPE_KEY_PATTERN.test(value);
}
export type WorkerStatus = "UNCONFIRMED" | "ON" | "OFF";
export type OptionalState = "omitted" | "unknown" | "intentionally_blank";
export type OptionalValue<T> =
  | { state: OptionalState }
  | { state: "provided"; value: T };

export type PaymentDetails =
  | { state: OptionalState }
  | {
      state: "provided";
      value: {
        account_number: string;
        bank_id: string;
        account_holder_name: string;
      };
    };

export type ExplicitRecruiterLink = {
  app_user_id: string;
  recruiter_id: string;
  verified: boolean;
  valid_from: string;
  valid_to: string | null;
};

export type EntryIdentityCatalog = {
  recruiters: RecruiterIdentity[];
  provider_memberships: ProviderMembership[];
  teams: TeamIdentity[];
  team_memberships: TeamMembership[];
  app_user_recruiter_links: ExplicitRecruiterLink[];
};

export type ProjectMaster = { project_id: string; active: boolean };
export type BankMaster = { bank_id: string; active: boolean };
export type EntryValidationContext = {
  projects: readonly ProjectMaster[];
  banks: readonly BankMaster[];
  catalog: EntryIdentityCatalog;
  today: string;
};

export type WorkerDetails = {
  display_name: string;
  gender?: OptionalValue<"MALE" | "FEMALE" | "OTHER">;
  date_of_birth: OptionalValue<string>;
  national_id: OptionalValue<string>;
  national_id_issued_at?: OptionalValue<string>;
  national_id_issued_place?: OptionalValue<string>;
  address: OptionalValue<string>;
  phone: OptionalValue<string>;
};

export type EmploymentStatusEvent = {
  event_id: string;
  status: WorkerStatus;
  effective_date: string;
  leave_date: string | null;
  leave_reason_text: string | null;
  version: number;
  actor_id: string;
  reason: string;
  supersedes_event_id: string | null;
  applied_at: string;
};

export type DocumentType = "CCCD_FRONT" | "CCCD_BACK" | "EMPLOYMENT_CONTRACT";
export type DirectEntryDocumentType = DocumentType | "WORKER_PORTRAIT";
export type DocumentUploadStatus =
  | "QUEUED"
  | "UPLOADING"
  | "QUARANTINED"
  | "SCANNING"
  | "READY"
  | "FAILED"
  | "SUPERSEDED";

export type DocumentVersion = {
  document_id: string;
  candidate_ref: string;
  document_type: DocumentType;
  version: number;
  idempotency_key: string;
  checksum_sha256: string;
  size_bytes: number;
  mime_type: typeof DOCUMENT_MIME_TYPES[number];
  storage_key: string;
  upload_status: DocumentUploadStatus;
  scan_status: "PENDING" | "CLEAN" | "REJECTED";
  attempts: number;
  created_by: string;
  created_at: string;
  supersedes_version: number | null;
};

export type DocumentCompleteness = Record<DocumentType, {
  status: "MISSING" | "PRESENT";
  ready_versions: number;
}>;

export type DirectEntry = {
  entry_id: string;
  candidate_id: string;
  app_user_id: string;
  project_id: string;
  first_work_date: string;
  employee_code: string;
  worker: WorkerDetails;
  recruiter_id: string;
  provider_type: ProviderType;
  labor_type: LaborType;
  payment: PaymentDetails;
  documents: DocumentVersion[];
  employment_events: EmploymentStatusEvent[];
  version: number;
};

export type Capability =
  | "entry_create"
  | "entry_own"
  | "entry_team"
  | "entry_admin"
  | "entry_restore"
  | "submission_create"
  | "change_request_create"
  | "change_review"
  | "entry_privileged_edit"
  | "employment_status.request"
  | "employment_status.review"
  | "employment_status.apply"
  | "document_upload"
  | "document_view"
  | "recruiter_master_manage"
  | "team_master_manage"
  | "audit_view"
  | "catalog_master_manage"
  | "team_manager_assign"
  | "report_form_manage"
  | "report_assign"
  | "report_view"
  | "report_analytics_view"
  | "report_review"
  | "report_delegate"
  | "vendor_finance_view"
  | "vendor_finance_record"
  | "vendor_referrer_manage"
  | "duplicate_cccd_withdraw"
  | "worker_edit_history_view";

export type ValidationIssue = { code: string; path: string };
export type ValidationResult =
  | { ok: true; canonical_employee_code: string }
  | { ok: false; issues: ValidationIssue[] };

export type EditableEntryField =
  | "project_id"
  | "first_work_date"
  | "employee_code"
  | "worker"
  | "recruiter_id"
  | "provider_type"
  | "labor_type"
  | "payment";

export type ChangeItem =
  | {
      target: "ENTRY_FIELD";
      row_id: string;
      field: EditableEntryField;
      proposed_value: unknown;
      expected_version: number;
    }
  | {
      target: "DOCUMENT";
      row_id: string;
      document: DocumentVersion;
      expected_version: number;
    }
  | {
      target: "WORK_STATUS";
      row_id: string;
      event: EmploymentStatusEvent;
      expected_version: number;
    };

export type ChangeRequest = {
  request_id: string;
  proposer_id: string;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
  items: ChangeItem[];
  created_at: string;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: string | null;
};

export type Revision = {
  revision_ref: string;
  entry_id: string;
  version: number;
  before: DirectEntry;
  after: DirectEntry;
  actor_id: string;
  reason: string;
  timestamp: string;
};

export type AuditEvent = {
  actor_id: string;
  action: string;
  entry_id: string;
  version: number;
  before_revision_ref: string;
  after_revision_ref: string;
  changed_fields: string[];
  reason: string;
  timestamp: string;
  outcome: "APPLIED" | "REJECTED";
};

export type Submission = {
  submission_id: string;
  created_by_user_id: string;
  entry_ids: string[];
  state: "DRAFT" | "REVIEW" | "SUBMITTED";
  version: number;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
};

export type StatusProposal = Pick<
  EmploymentStatusEvent,
  "event_id" | "status" | "effective_date" | "leave_date" | "leave_reason_text"
>;

const EMPLOYEE_CODE = /^hrp-(\d{4})-(\d{6})$/;
const LEGACY_EMPLOYEE_CODE = /^hrp-\d{4}-\d+$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OPAQUE_REF = UUID;
const SAFE_DOCUMENT_ID = /^doc_[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const OPTIONAL_STATES = new Set<OptionalState>([
  "omitted",
  "unknown",
  "intentionally_blank",
]);
const EDITABLE_FIELDS = new Set<EditableEntryField>([
  "project_id",
  "first_work_date",
  "employee_code",
  "worker",
  "recruiter_id",
  "provider_type",
  "labor_type",
  "payment",
]);

function validOptional<T>(
  value: OptionalValue<T>,
  isValid: (item: T) => boolean,
): boolean {
  if (!value || typeof value !== "object") return false;
  if (value.state === "provided") return isValid(value.value);
  return OPTIONAL_STATES.has(value.state) && !("value" in value);
}

function foldSearchKey(value: string): string {
  return (normalizeReportingKey(value) ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d");
}

export function canonicalizeEmployeeCode(value: string): string | null {
  if (typeof value !== "string") return null;
  const match = EMPLOYEE_CODE.exec(value);
  return match ? value : null;
}

export function isLegacyEmployeeCode(value: string): boolean {
  return typeof value === "string" &&
    LEGACY_EMPLOYEE_CODE.test(value) &&
    !EMPLOYEE_CODE.test(value);
}

export function validateEmployeeCode(
  code: string,
  _firstWorkDate?: string,
  existingCodes: readonly string[] = [],
): ValidationIssue[] {
  const canonical = canonicalizeEmployeeCode(code);
  if (!canonical) {
    return [{
      code: isLegacyEmployeeCode(code)
        ? "EMPLOYEE_CODE_LEGACY_QUARANTINE"
        : "EMPLOYEE_CODE_FORMAT",
      path: "employee_code",
    }];
  }
  const duplicate = existingCodes.some((existing) =>
    canonicalizeEmployeeCode(existing) === canonical
  );
  if (duplicate) return [{ code: "EMPLOYEE_CODE_DUPLICATE", path: "employee_code" }];
  return [];
}

function activeMemberships<T extends { valid_from: string; valid_to: string | null }>(
  memberships: readonly T[],
  date: string,
): T[] {
  return memberships.filter((membership) =>
    isRealCalendarDate(membership.valid_from) &&
    (membership.valid_to === null ||
      isRealCalendarDate(membership.valid_to) &&
      membership.valid_to > membership.valid_from) &&
    isWithinInterval(date, membership.valid_from, membership.valid_to)
  );
}

export function validateRecruiterSelection(input: {
  recruiter_id: string;
  provider_type: ProviderType;
  business_date: string;
  catalog: EntryIdentityCatalog;
}): ValidationIssue[] {
  const { recruiter_id, provider_type, business_date, catalog } = input;
  if (!isRealCalendarDate(business_date)) {
    return [{ code: "BUSINESS_DATE_INVALID", path: "business_date" }];
  }
  const recruiter = catalog.recruiters.find((item) => item.recruiter_id === recruiter_id);
  if (!recruiter || !recruiter.active) {
    return [{ code: "RECRUITER_NOT_ACTIVE", path: "recruiter_id" }];
  }
  const providers = activeMemberships(
    catalog.provider_memberships.filter((item) => item.recruiter_id === recruiter_id),
    business_date,
  );
  if (providers.length !== 1) {
    return [{
      code: providers.length === 0 ? "PROVIDER_MEMBERSHIP_NOT_FOUND" : "PROVIDER_MEMBERSHIP_AMBIGUOUS",
      path: "provider_type",
    }];
  }
  if (providers[0].provider_type !== provider_type) {
    return [{ code: "PROVIDER_TYPE_MISMATCH", path: "provider_type" }];
  }
  const teams = activeMemberships(
    catalog.team_memberships.filter((item) => item.recruiter_id === recruiter_id),
    business_date,
  );
  if (teams.length !== 1) {
    return [{
      code: teams.length === 0 ? "TEAM_MEMBERSHIP_NOT_FOUND" : "TEAM_MEMBERSHIP_AMBIGUOUS",
      path: "recruiter_id",
    }];
  }
  const team = catalog.teams.find((item) => item.team_id === teams[0].team_id);
  if (!team || !team.active) {
    return [{ code: "TEAM_NOT_ACTIVE", path: "recruiter_id" }];
  }
  return [];
}

export function resolveExplicitRecruiterLink(input: {
  app_user_id: string;
  date: string;
  links: readonly ExplicitRecruiterLink[];
}): string | null {
  if (!isRealCalendarDate(input.date)) return null;
  const matches = input.links.filter((link) =>
    link.app_user_id === input.app_user_id &&
    link.verified &&
    isWithinInterval(input.date, link.valid_from, link.valid_to)
  );
  return matches.length === 1 ? matches[0].recruiter_id : null;
}

export function searchEligibleRecruiters(input: {
  query: string;
  provider_type: ProviderType;
  business_date: string;
  catalog: EntryIdentityCatalog;
}): RecruiterIdentity[] {
  const query = foldSearchKey(input.query.trim());
  return input.catalog.recruiters
    .filter((recruiter) =>
      recruiter.active &&
      validateRecruiterSelection({
        recruiter_id: recruiter.recruiter_id,
        provider_type: input.provider_type,
        business_date: input.business_date,
        catalog: input.catalog,
      }).length === 0 &&
      (query === "" ||
        foldSearchKey(recruiter.display).startsWith(query) ||
        foldSearchKey(recruiter.recruiter_id).startsWith(query))
    )
    .sort((a, b) => a.recruiter_id < b.recruiter_id ? -1 : a.recruiter_id > b.recruiter_id ? 1 : 0);
}

export function validatePaymentDetails(
  payment: PaymentDetails,
  banks: readonly BankMaster[],
): ValidationIssue[] {
  if (!payment || typeof payment !== "object") {
    return [{ code: "PAYMENT_STATE_INVALID", path: "payment" }];
  }
  if (payment.state !== "provided") {
    return OPTIONAL_STATES.has(payment.state) && !("value" in payment)
      ? []
      : [{ code: "PAYMENT_STATE_INVALID", path: "payment" }];
  }
  const value = payment.value;
  if (
    typeof value.account_number !== "string" ||
    value.account_number.length === 0 ||
    value.account_number.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(value.account_number) ||
    !banks.some((bank) => bank.active && bank.bank_id === value.bank_id) ||
    typeof value.account_holder_name !== "string" ||
    value.account_holder_name.trim() === "" ||
    value.account_holder_name.length > 256
  ) {
    return [{ code: "PAYMENT_DETAILS_INVALID", path: "payment" }];
  }
  return [];
}

// P3-W07C-R2: DOB/Ngay cap la text thuong, chi chan rong va qua 10 ky tu.
// Khong parse, regex, canonicalize hay so sanh nhu mot ngay.
export function isValidFreeDate(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 10;
}

export function validateWorkerDetails(worker: WorkerDetails): ValidationIssue[] {
  if (
    !worker ||
    typeof worker.display_name !== "string" ||
    worker.display_name.trim() === "" ||
    worker.display_name.length > 256 ||
    (worker.gender !== undefined &&
      !validOptional(worker.gender, (value) =>
        value === "MALE" || value === "FEMALE" || value === "OTHER"
      )) ||
    !validOptional(worker.date_of_birth, isValidFreeDate) ||
    // P2.5-HF-R2: CMT/CCCD dung mot quy tac canonical duy nhat (chi ASCII digits, 9 hoac 12
    // ky tu, giu so 0 dau). Ky tu dinh dang bi tu choi ngay tai contract, khong doi DB tu choi.
    !validOptional(worker.national_id, isCanonicalNationalId) ||
    (worker.national_id_issued_at !== undefined &&
      !validOptional(worker.national_id_issued_at, isValidFreeDate)) ||
    (worker.national_id_issued_place !== undefined &&
      !validOptional(worker.national_id_issued_place, (value) =>
        typeof value === "string" && value.trim().length > 0 && value.length <= 256
      )) ||
    !validOptional(worker.address, (value) => typeof value === "string" && value.length <= 1024) ||
    !validOptional(worker.phone, (value) => typeof value === "string" && value.length <= 64)
  ) {
    return [{ code: "WORKER_DETAILS_INVALID", path: "worker" }];
  }
  return [];
}

export function validateEntry(input: {
  entry: unknown;
  existing_codes?: readonly string[];
  projects: readonly ProjectMaster[];
  banks: readonly BankMaster[];
  catalog: EntryIdentityCatalog;
  today?: string;
}): ValidationResult {
  if (!input.entry || typeof input.entry !== "object" || Array.isArray(input.entry)) {
    return { ok: false, issues: [{ code: "ENTRY_INVALID", path: "entry" }] };
  }
  const entry = input.entry as DirectEntry;
  const issues: ValidationIssue[] = [];
  if (!UUID.test(entry.entry_id) || !UUID.test(entry.candidate_id) ||
      !UUID.test(entry.app_user_id)) {
    issues.push({ code: "IDENTITY_INVALID", path: "entry_id" });
  }
  if (!input.projects.some((project) => project.active && project.project_id === entry.project_id)) {
    issues.push({ code: "PROJECT_NOT_ACTIVE", path: "project_id" });
  }
  if (!isRealCalendarDate(entry.first_work_date)) {
    issues.push({ code: "FIRST_WORK_DATE_INVALID", path: "first_work_date" });
  }
  issues.push(...validateEmployeeCode(
    entry.employee_code,
    entry.first_work_date,
    input.existing_codes ?? [],
  ));
  issues.push(...validateWorkerDetails(entry.worker));
  if (entry.provider_type !== "hrp" && entry.provider_type !== "vendor") {
    issues.push({ code: "PROVIDER_TYPE_INVALID", path: "provider_type" });
  } else {
    issues.push(...validateRecruiterSelection({
      recruiter_id: entry.recruiter_id,
      provider_type: entry.provider_type,
      business_date: entry.first_work_date,
      catalog: input.catalog,
    }));
  }
  if (!isCanonicalLaborTypeKey(entry.labor_type)) {
    issues.push({ code: "LABOR_TYPE_INVALID", path: "labor_type" });
  }
  issues.push(...validatePaymentDetails(entry.payment, input.banks));
  if (
    !Array.isArray(entry.employment_events) ||
    entry.employment_events.length === 0 ||
    !["UNCONFIRMED", "ON"].includes(entry.employment_events[0]?.status ?? "")
  ) {
    issues.push({ code: "INITIAL_STATUS_REQUIRED", path: "employment_events" });
  } else if (input.today !== undefined && !isRealCalendarDate(input.today)) {
    issues.push({ code: "VALIDATION_DATE_INVALID", path: "today" });
  } else if (input.today !== undefined) {
    for (const event of entry.employment_events) {
      issues.push(...validateStatusProposal(event, entry.first_work_date, input.today));
    }
  }
  if (!Number.isSafeInteger(entry.version) || entry.version < 1) {
    issues.push({ code: "ROW_VERSION_INVALID", path: "version" });
  }
  return issues.length > 0
    ? { ok: false, issues }
    : {
        ok: true,
        canonical_employee_code: canonicalizeEmployeeCode(entry.employee_code)!,
      };
}

function isValidEntryAgainstContext(
  entry: DirectEntry,
  entries: readonly DirectEntry[],
  context: EntryValidationContext,
): boolean {
  const existingCodes = entries
      .filter((candidate) => candidate.entry_id !== entry.entry_id)
      .map((candidate) => candidate.employee_code);
  return validateEntry({
      entry,
      existing_codes: existingCodes,
      projects: context.projects,
      banks: context.banks,
      catalog: context.catalog,
      today: context.today,
  }).ok;
}

export function transitionSubmission(
  submission: Submission,
  action: "BEGIN_REVIEW" | "RETURN_TO_DRAFT" | "SUBMIT",
  expectedVersion: number,
  timestamp: string,
): Submission | null {
  if (
    !submission ||
    submission.version !== expectedVersion ||
    !Number.isSafeInteger(submission.version) ||
    submission.version < 1 ||
    submission.entry_ids.length < 1 ||
    new Set(submission.entry_ids).size !== submission.entry_ids.length ||
    !submission.entry_ids.every((id) => SAFE_ID.test(id)) ||
    !SAFE_ID.test(submission.submission_id) ||
    !SAFE_ID.test(submission.created_by_user_id) ||
    !isValidTimestamp(timestamp)
  ) return null;
  const next = action === "BEGIN_REVIEW" && submission.state === "DRAFT"
    ? "REVIEW"
    : action === "RETURN_TO_DRAFT" && submission.state === "REVIEW"
      ? "DRAFT"
      : action === "SUBMIT" && submission.state === "REVIEW"
        ? "SUBMITTED"
        : null;
  return next
    ? {
        ...submission,
        state: next,
        version: submission.version + 1,
        updated_at: timestamp,
        submitted_at: next === "SUBMITTED" ? timestamp : submission.submitted_at,
      }
    : null;
}

function isValidTimestamp(value: string): boolean {
  return typeof value === "string" &&
    isRealCalendarDate(value.slice(0, 10)) &&
    Number.isFinite(Date.parse(value));
}

export function createSubmission(input: {
  submission_id: string;
  created_by_user_id: string;
  entry_ids: readonly string[];
  created_at: string;
}): Submission | null {
  if (
    !SAFE_ID.test(input.submission_id) ||
    !SAFE_ID.test(input.created_by_user_id) ||
    input.entry_ids.length < 1 ||
    !input.entry_ids.every((id) => SAFE_ID.test(id)) ||
    new Set(input.entry_ids).size !== input.entry_ids.length ||
    !isValidTimestamp(input.created_at)
  ) return null;
  return {
    submission_id: input.submission_id,
    created_by_user_id: input.created_by_user_id,
    entry_ids: [...input.entry_ids],
    state: "DRAFT",
    version: 1,
    created_at: input.created_at,
    updated_at: input.created_at,
    submitted_at: null,
  };
}

export function canEditRows(state: Submission["state"]): boolean {
  return state === "DRAFT";
}

export function validateStatusProposal(
  proposal: StatusProposal,
  firstWorkDate?: string,
  today?: string,
): ValidationIssue[] {
  if (
    !SAFE_ID.test(proposal.event_id) ||
    !isRealCalendarDate(proposal.effective_date) ||
    !["UNCONFIRMED", "ON", "OFF"].includes(proposal.status)
  ) {
    return [{ code: "STATUS_EVENT_INVALID", path: "employment_events" }];
  }
  if (
    (firstWorkDate !== undefined || today !== undefined) &&
    (!isRealCalendarDate(firstWorkDate ?? "") ||
      !isRealCalendarDate(today ?? "") ||
      proposal.effective_date < firstWorkDate! ||
      proposal.effective_date > today!)
  ) {
    return [{ code: "STATUS_EFFECTIVE_DATE_INVALID", path: "employment_events" }];
  }
  if (proposal.status === "OFF") {
    if (
      !proposal.leave_date ||
      !isRealCalendarDate(proposal.leave_date) ||
      typeof proposal.leave_reason_text !== "string" ||
      proposal.leave_reason_text.trim() === "" ||
      proposal.leave_reason_text.trim().length > 4000 ||
      proposal.leave_date !== proposal.effective_date
    ) {
      return [{ code: "OFF_REQUIRES_DATE_AND_REASON", path: "employment_events" }];
    }
  } else if (proposal.leave_date !== null || proposal.leave_reason_text !== null) {
    return [{ code: "NON_OFF_LEAVE_FIELDS", path: "employment_events" }];
  }
  return [];
}

function activeStatusEvents(events: readonly EmploymentStatusEvent[]): EmploymentStatusEvent[] {
  const superseded = new Set(events.map((event) => event.supersedes_event_id).filter(Boolean));
  return events.filter((event) => !superseded.has(event.event_id));
}

export function deriveCurrentStatus(events: readonly EmploymentStatusEvent[]): WorkerStatus {
  const ordered = activeStatusEvents(events).slice().sort((a, b) =>
    a.effective_date.localeCompare(b.effective_date) || a.version - b.version
  );
  return ordered.at(-1)?.status ?? "UNCONFIRMED";
}

const ALLOWED_STATUS_TRANSITIONS: Record<WorkerStatus, readonly WorkerStatus[]> = {
  UNCONFIRMED: ["ON", "OFF"],
  ON: ["OFF"],
  OFF: ["ON"],
};

export function appendStatusEvent(input: {
  events: readonly EmploymentStatusEvent[];
  proposal: StatusProposal;
  first_work_date: string;
  today: string;
  actor_id: string;
  reason: string;
  applied_at: string;
}): EmploymentStatusEvent[] | null {
  const { events, proposal } = input;
  if (
    validateStatusProposal(proposal, input.first_work_date, input.today).length ||
    !SAFE_ID.test(input.actor_id) ||
    input.reason.trim() === "" ||
    !isRealCalendarDate(input.applied_at.slice(0, 10)) ||
    events.some((event) => event.event_id === proposal.event_id)
  ) return null;
  const active = activeStatusEvents(events).slice().sort((a, b) =>
    a.effective_date.localeCompare(b.effective_date) || a.version - b.version
  );
  const current = active.at(-1);
  const previousStatus = current?.status ?? "UNCONFIRMED";
  if (
    proposal.status === previousStatus ||
    !ALLOWED_STATUS_TRANSITIONS[previousStatus].includes(proposal.status) ||
    (current && proposal.effective_date < current.effective_date)
  ) return null;
  const event: EmploymentStatusEvent = {
    ...proposal,
    leave_reason_text: proposal.status === "OFF" ? proposal.leave_reason_text!.trim() : null,
    version: Math.max(0, ...events.map((item) => item.version)) + 1,
    actor_id: input.actor_id,
    reason: input.reason.trim(),
    supersedes_event_id: null,
    applied_at: input.applied_at,
  };
  return [...events, event];
}

export function correctLatestStatusEvent(input: {
  events: readonly EmploymentStatusEvent[];
  event_id: string;
  replacement: StatusProposal;
  first_work_date: string;
  today: string;
  actor_id: string;
  reason: string;
  applied_at: string;
}): EmploymentStatusEvent[] | null {
  const latest = activeStatusEvents(input.events).slice().sort((a, b) =>
    a.effective_date.localeCompare(b.effective_date) || a.version - b.version
  ).at(-1);
  const reason = input.reason.trim();
  if (
    !latest ||
    latest.event_id !== input.event_id ||
    validateStatusProposal(input.replacement, input.first_work_date, input.today).length > 0 ||
    !SAFE_ID.test(input.actor_id) ||
    reason === "" ||
    !isRealCalendarDate(input.applied_at.slice(0, 10)) ||
    input.events.some((event) => event.event_id === input.replacement.event_id)
  ) return null;
  const priorEvents = input.events.filter((event) => event.event_id !== latest.event_id);
  const previous = activeStatusEvents(priorEvents).slice().sort((a, b) =>
    a.effective_date.localeCompare(b.effective_date) || a.version - b.version
  ).at(-1);
  const previousStatus = previous?.status ?? "UNCONFIRMED";
  if (
    input.replacement.status !== previousStatus &&
    !ALLOWED_STATUS_TRANSITIONS[previousStatus].includes(input.replacement.status)
  ) return null;
  return [...input.events, {
    ...input.replacement,
    effective_date: latest.effective_date,
    leave_reason_text: input.replacement.status === "OFF"
      ? input.replacement.leave_reason_text!.trim()
      : null,
    version: Math.max(0, ...input.events.map((event) => event.version)) + 1,
    actor_id: input.actor_id,
    reason,
    supersedes_event_id: latest.event_id,
    applied_at: input.applied_at,
  }];
}

export function createDocumentVersion(input: {
  existing: readonly DocumentVersion[];
  document_id: string;
  candidate_ref: string;
  document_type: DocumentType;
  idempotency_key: string;
  checksum_sha256: string;
  size_bytes: number;
  mime_type: string;
  created_by: string;
  created_at: string;
  max_bytes?: number;
}): DocumentVersion | null {
  const maxBytes = input.max_bytes ?? DEFAULT_DOCUMENT_MAX_BYTES;
  if (
    !SAFE_DOCUMENT_ID.test(input.document_id) ||
    !SAFE_OPAQUE_REF.test(input.candidate_ref) ||
    !["CCCD_FRONT", "CCCD_BACK", "EMPLOYMENT_CONTRACT"].includes(input.document_type) ||
    !SAFE_ID.test(input.idempotency_key) ||
    !SAFE_ID.test(input.created_by) ||
    Number.isNaN(Date.parse(input.created_at)) ||
    !SHA256.test(input.checksum_sha256) ||
    !Number.isSafeInteger(input.size_bytes) ||
    input.size_bytes < 1 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > DOCUMENT_MAX_BYTES_HARD_LIMIT ||
    input.size_bytes > maxBytes ||
    !(DOCUMENT_MIME_TYPES as readonly string[]).includes(input.mime_type)
  ) return null;

  const scope = input.existing.filter((document) =>
    document.candidate_ref === input.candidate_ref &&
    document.document_type === input.document_type
  );
  const retry = scope.find((document) => document.idempotency_key === input.idempotency_key);
  if (retry) {
    return retry.checksum_sha256 === input.checksum_sha256
      ? retry
      : null;
  }
  const version = Math.max(0, ...scope.map((document) => document.version)) + 1;
  const superseded = Math.max(0, ...scope.map((document) => document.version)) || null;
  return {
    document_id: input.document_id,
    candidate_ref: input.candidate_ref,
    document_type: input.document_type,
    version,
    idempotency_key: input.idempotency_key,
    checksum_sha256: input.checksum_sha256,
    size_bytes: input.size_bytes,
    mime_type: input.mime_type as DocumentVersion["mime_type"],
    storage_key: `${input.candidate_ref}/${input.document_type.toLowerCase()}/${input.document_id}/v${version}`,
    upload_status: "QUEUED",
    scan_status: "PENDING",
    attempts: 0,
    created_by: input.created_by,
    created_at: input.created_at,
    supersedes_version: superseded,
  };
}

export function documentCompleteness(
  documents: readonly DocumentVersion[],
): DocumentCompleteness {
  return Object.fromEntries(
    (["CCCD_FRONT", "CCCD_BACK", "EMPLOYMENT_CONTRACT"] as const).map((type) => {
      const readyVersions = documents.filter((document) =>
        document.document_type === type &&
        document.upload_status === "READY" &&
        document.scan_status === "CLEAN"
      ).length;
      return [type, {
        status: readyVersions > 0 ? "PRESENT" : "MISSING",
        ready_versions: readyVersions,
      }];
    }),
  ) as DocumentCompleteness;
}

export function transitionDocumentUpload(
  document: DocumentVersion,
  action: "START" | "QUARANTINE" | "SCAN" | "SCAN_CLEAN" | "SCAN_REJECT" | "FAIL" | "RETRY" | "SUPERSEDE",
): DocumentVersion | null {
  const next: Record<typeof action, DocumentUploadStatus> = {
    START: "UPLOADING",
    QUARANTINE: "QUARANTINED",
    SCAN: "SCANNING",
    SCAN_CLEAN: "READY",
    SCAN_REJECT: "FAILED",
    FAIL: "FAILED",
    RETRY: "QUEUED",
    SUPERSEDE: "SUPERSEDED",
  };
  const allowed: Record<typeof action, readonly DocumentUploadStatus[]> = {
    START: ["QUEUED"],
    QUARANTINE: ["UPLOADING"],
    SCAN: ["QUARANTINED"],
    SCAN_CLEAN: ["SCANNING"],
    SCAN_REJECT: ["SCANNING"],
    FAIL: ["UPLOADING"],
    RETRY: ["FAILED"],
    SUPERSEDE: ["READY"],
  };
  if (!allowed[action].includes(document.upload_status)) return null;
  return {
    ...document,
    upload_status: next[action],
    scan_status: action === "SCAN_CLEAN"
      ? "CLEAN"
      : action === "SCAN_REJECT"
        ? "REJECTED"
        : document.scan_status,
    attempts: document.attempts + (action === "START" ? 1 : 0),
  };
}

function cloneEntry(entry: DirectEntry): DirectEntry {
  return structuredClone(entry);
}

function applyChangeItems(
  entry: DirectEntry,
  items: readonly ChangeItem[],
  actorId: string,
  reason: string,
  timestamp: string,
): DirectEntry | null {
  const next = cloneEntry(entry);
  for (const item of items) {
    if (item.row_id !== entry.entry_id) continue;
    if (item.target === "ENTRY_FIELD") {
      if (!EDITABLE_FIELDS.has(item.field)) return null;
      const value = item.field === "employee_code"
        ? canonicalizeEmployeeCode(item.proposed_value as string)
        : structuredClone(item.proposed_value);
      if (value === null) return null;
      (next[item.field] as unknown) = value;
    } else if (item.target === "DOCUMENT") {
      const doc = item.document;
      if (doc.candidate_ref !== entry.candidate_id) return null;
      const previous = next.documents.filter((version) =>
        version.candidate_ref === doc.candidate_ref &&
        version.document_type === doc.document_type
      );
      const expected = Math.max(0, ...previous.map((version) => version.version)) + 1;
      if (doc.version !== expected || doc.upload_status !== "READY" || doc.scan_status !== "CLEAN") {
        return null;
      }
      next.documents = next.documents.map((version) =>
        version.candidate_ref === doc.candidate_ref &&
        version.document_type === doc.document_type &&
        version.upload_status === "READY"
          ? { ...version, upload_status: "SUPERSEDED" }
          : version
      );
      next.documents.push(structuredClone(doc));
    } else {
      const appended = appendStatusEvent({
        events: next.employment_events,
        proposal: item.event,
        first_work_date: entry.first_work_date,
        today: timestamp.slice(0, 10),
        actor_id: actorId,
        reason,
        applied_at: timestamp,
      });
      if (!appended) return null;
      next.employment_events = appended;
    }
  }
  next.version += 1;
  return next;
}

function buildRevision(
  before: DirectEntry,
  after: DirectEntry,
  actorId: string,
  reason: string,
  timestamp: string,
  changedFields: string[],
): { revision: Revision; audit: AuditEvent } {
  const beforeRef = `${before.entry_id}:v${before.version}`;
  const afterRef = `${after.entry_id}:v${after.version}`;
  return {
    revision: {
      revision_ref: afterRef,
      entry_id: before.entry_id,
      version: after.version,
      before: cloneEntry(before),
      after: cloneEntry(after),
      actor_id: actorId,
      reason,
      timestamp,
    },
    audit: {
      actor_id: actorId,
      action: "CANONICAL_CHANGE_APPLIED",
      entry_id: before.entry_id,
      version: after.version,
      before_revision_ref: beforeRef,
      after_revision_ref: afterRef,
      changed_fields: changedFields,
      reason,
      timestamp,
      outcome: "APPLIED",
    },
  };
}

export function createChangeRequest(input: {
  submission_state: Submission["state"];
  request_id: string;
  proposer_id: string;
  capabilities: readonly Capability[];
  reason: string;
  items: ChangeItem[];
  created_at: string;
}): ChangeRequest | null {
  if (
    input.submission_state !== "SUBMITTED" ||
    !input.capabilities.includes("change_request_create") ||
    !SAFE_ID.test(input.request_id) ||
    !SAFE_ID.test(input.proposer_id) ||
    input.reason.trim() === "" ||
    input.items.length === 0 ||
    input.items.some((item) =>
      !item ||
      typeof item !== "object" ||
      !SAFE_ID.test(item.row_id) ||
      !Number.isSafeInteger(item.expected_version) ||
      item.expected_version < 1 ||
      item.target === "ENTRY_FIELD" && !EDITABLE_FIELDS.has(item.field) ||
      item.target === "DOCUMENT" &&
        (!item.document ||
          !SAFE_DOCUMENT_ID.test(item.document.document_id) ||
          !SAFE_OPAQUE_REF.test(item.document.candidate_ref)) ||
      item.target === "WORK_STATUS" &&
        (!item.event || validateStatusProposal(item.event).length > 0) ||
      !["ENTRY_FIELD", "DOCUMENT", "WORK_STATUS"].includes(item.target)
    ) ||
    !isRealCalendarDate(input.created_at.slice(0, 10))
  ) return null;
  return {
    request_id: input.request_id,
    proposer_id: input.proposer_id,
    reason: input.reason.trim(),
    status: "PENDING",
    items: structuredClone(input.items),
    created_at: input.created_at,
    decision_reason: null,
    decided_by: null,
    decided_at: null,
  };
}

export function withdrawChangeRequest(input: {
  request: ChangeRequest;
  actor_id: string;
  timestamp: string;
}): ChangeRequest | null {
  if (
    input.request.status !== "PENDING" ||
    input.actor_id !== input.request.proposer_id ||
    !SAFE_ID.test(input.actor_id) ||
    !isValidTimestamp(input.timestamp)
  ) return null;
  return {
    ...input.request,
    status: "WITHDRAWN",
    decision_reason: "WITHDRAWN_BY_PROPOSER",
    decided_by: input.actor_id,
    decided_at: input.timestamp,
  };
}

export function decideChangeRequest(input: {
  entries: readonly DirectEntry[];
  request: ChangeRequest;
  decision: "APPROVE" | "REJECT";
  reviewer_id: string;
  capabilities: readonly Capability[];
  reason: string;
  timestamp: string;
  validation_context: EntryValidationContext;
}): {
  entries: DirectEntry[];
  request: ChangeRequest;
  revisions: Revision[];
  audit: AuditEvent[];
} | null {
  if (
    input.request.status !== "PENDING" ||
    input.request.items.length === 0 ||
    input.request.items.some((item) =>
      !item ||
      typeof item !== "object" ||
      !SAFE_ID.test(item.row_id) ||
      !Number.isSafeInteger(item.expected_version) ||
      item.expected_version < 1 ||
      item.target === "ENTRY_FIELD" && !EDITABLE_FIELDS.has(item.field) ||
      !["ENTRY_FIELD", "DOCUMENT", "WORK_STATUS"].includes(item.target)
    ) ||
    !input.capabilities.includes("change_review") ||
    !SAFE_ID.test(input.reviewer_id) ||
    input.reason.trim() === "" ||
    !isRealCalendarDate(input.timestamp.slice(0, 10))
  ) return null;
  const decidedRequest = {
    ...input.request,
    decided_by: input.reviewer_id,
    decided_at: input.timestamp,
    decision_reason: input.reason.trim(),
  };
  if (input.decision === "REJECT") {
    return {
      entries: input.entries.map(cloneEntry),
      request: { ...decidedRequest, status: "REJECTED" },
      revisions: [],
      audit: input.request.items.map((item) => ({
        actor_id: input.reviewer_id,
        action: "CHANGE_REQUEST_REJECTED",
        entry_id: item.row_id,
        version: item.expected_version,
        before_revision_ref: `${item.row_id}:v${item.expected_version}`,
        after_revision_ref: `${item.row_id}:v${item.expected_version}`,
        changed_fields: [item.target === "ENTRY_FIELD" ? item.field : item.target],
        reason: input.reason.trim(),
        timestamp: input.timestamp,
        outcome: "REJECTED",
      })),
    };
  }

  const rowIds = [...new Set(input.request.items.map((item) => item.row_id))];
  const originals = new Map(rowIds.map((id) => [id, input.entries.find((entry) => entry.entry_id === id)]));
  if (rowIds.some((id) => !originals.get(id))) return null;
  for (const id of rowIds) {
    const current = originals.get(id)!;
    const items = input.request.items.filter((item) => item.row_id === id);
    if (items.some((item) => item.expected_version !== current.version)) return null;
  }

  const staged = new Map<string, DirectEntry>();
  for (const id of rowIds) {
    const original = originals.get(id)!;
    const next = applyChangeItems(
      original,
      input.request.items.filter((item) => item.row_id === id),
      input.reviewer_id,
      input.reason.trim(),
      input.timestamp,
    );
    if (!next) return null;
    staged.set(id, next);
  }
  const finalEntries = input.entries.map((entry) => staged.get(entry.entry_id) ?? cloneEntry(entry));
  if (rowIds.some((id) =>
    !isValidEntryAgainstContext(staged.get(id)!, finalEntries, input.validation_context)
  )) return null;
  const codes = new Map<string, number>();
  for (const entry of finalEntries) {
    const code = canonicalizeEmployeeCode(entry.employee_code);
    if (!code || codes.has(code)) return null;
    codes.set(code, 1);
  }
  const revisions: Revision[] = [];
  const audit: AuditEvent[] = [];
  for (const id of rowIds) {
    const pair = buildRevision(
      originals.get(id)!,
      staged.get(id)!,
      input.reviewer_id,
      input.reason.trim(),
      input.timestamp,
      input.request.items
        .filter((item) => item.row_id === id)
        .map((item) => item.target === "ENTRY_FIELD" ? item.field : item.target),
    );
    revisions.push(pair.revision);
    audit.push(pair.audit);
  }
  return {
    entries: finalEntries,
    request: { ...decidedRequest, status: "APPROVED" },
    revisions,
    audit,
  };
}

export function applyPrivilegedDirectEdit(input: {
  entries: readonly DirectEntry[];
  row_id: string;
  patch: Partial<Pick<DirectEntry, EditableEntryField>>;
  expected_version: number;
  actor_id: string;
  capabilities: readonly Capability[];
  reason: string;
  timestamp: string;
  submission_state: Submission["state"];
  validation_context: EntryValidationContext;
}): {
  entries: DirectEntry[];
  revision: Revision;
  audit: AuditEvent;
} | null {
  if (
    !input.capabilities.includes("entry_privileged_edit") ||
    input.submission_state !== "SUBMITTED" ||
    !SAFE_ID.test(input.actor_id) ||
    input.reason.trim() === "" ||
    !isRealCalendarDate(input.timestamp.slice(0, 10))
  ) return null;
  const before = input.entries.find((entry) => entry.entry_id === input.row_id);
  if (!before || before.version !== input.expected_version) return null;
  const items = Object.entries(input.patch).map(([field, proposed_value]) => ({
    target: "ENTRY_FIELD" as const,
    row_id: before.entry_id,
    field: field as EditableEntryField,
    proposed_value,
    expected_version: input.expected_version,
  }));
  if (items.length === 0) return null;
  const after = applyChangeItems(before, items, input.actor_id, input.reason.trim(), input.timestamp);
  if (!after) return null;
  const entries = input.entries.map((entry) => entry.entry_id === before.entry_id ? after : cloneEntry(entry));
  if (!isValidEntryAgainstContext(after, entries, input.validation_context)) return null;
  const codeKeys = entries.map((entry) => canonicalizeEmployeeCode(entry.employee_code));
  if (codeKeys.some((code, index) => !code || codeKeys.indexOf(code) !== index)) return null;
  const pair = buildRevision(
    before,
    after,
    input.actor_id,
    input.reason.trim(),
    input.timestamp,
    Object.keys(input.patch),
  );
  return { entries, ...pair };
}
