import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import {
  isCanonicalLaborTypeKey,
  validateEmployeeCode,
  type LaborType,
} from "../contracts/direct-entry-v1.ts";

export type DraftProfileField =
  | { state: "provided"; value: string }
  | { state: "omitted" | "unknown" | "intentionally_blank" }
  | { state: "redacted"; present: boolean };

export type DraftPaymentAccountField =
  | DraftProfileField
  | { state: "masked"; value: string };

export type DraftProfileProjection = {
  contract_version: "worker-profile/1.0";
  worker_details: {
    display_name: DraftProfileField;
    gender: DraftProfileField;
    date_of_birth: DraftProfileField;
    national_id: DraftProfileField;
    national_id_issued_at: DraftProfileField;
    national_id_issued_place: DraftProfileField;
    address: DraftProfileField;
    phone: DraftProfileField;
  };
  general_note: DraftProfileField;
  employment: {
    status: "UNCONFIRMED" | "ON" | "OFF";
    effective_date: string;
    version: number;
    leave_date: DraftProfileField;
    leave_reason_text: DraftProfileField;
  } | null;
  payment: {
    state: "provided" | "omitted" | "unknown" | "intentionally_blank" | "not_provided";
    account_number: DraftPaymentAccountField;
    bank_name: DraftProfileField;
    account_holder_name: DraftProfileField;
    version: number;
  } | null;
};

export type OwnDraft = {
  submission_id: string;
  submission_version: number;
  entry_id: string;
  entry_version: number;
  employee_code: string;
  first_work_date: string;
  worker_display_name: string;
  project_id: string;
  project_display_name: string;
  recruiter_id: string;
  recruiter_display_name: string;
  provider_type: "hrp" | "vendor";
  collaborator_id?: string | null;
  collaborator_display_name?: string | null;
  team_id: string;
  team_display_name: string;
  labor_type: LaborType;
  /**
   * P3.1-W02C-R3: nhan do server resolve tu public.direct_entry_labor_types theo
   * stored key, KHONG loc active. Bat buoc la string khong rong: draft dung mot
   * type da inactive van phai hien nhan that, va client khong bao gio duoc tu
   * map key sang nhan hay render raw key.
   */
  labor_type_display: string;
  employment_status: "UNCONFIRMED" | "ON" | "OFF" | null;
  created_at: string;
  updated_at: string;
  profile: DraftProfileProjection;
};

/**
 * P3.1-W02C-R3: /2 them labor_type_display BAT BUOC tren moi draft. Client build
 * con mong doi shape /1 phai tu choi payload thay vi lang le render draft khong
 * co nhan.
 */
export const DRAFT_LIST_PROJECTION_VERSION = "direct-entry-draft-list/2" as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function isPositiveVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function projectOwnDrafts(value: unknown): OwnDraft[] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["projection_version", "drafts"]) ||
      value.projection_version !== DRAFT_LIST_PROJECTION_VERSION || !Array.isArray(value.drafts) ||
      value.drafts.length > 500) return null;
  const drafts: OwnDraft[] = [];
  const entryIds = new Set<string>();
  const requiredDraftKeys = [
    "submission_id", "submission_version", "entry_id", "entry_version", "employee_code",
    "first_work_date", "worker_display_name", "project_id", "project_display_name",
    "recruiter_id", "recruiter_display_name", "provider_type", "team_id", "team_display_name",
    "labor_type", "labor_type_display", "employment_status", "created_at", "updated_at", "profile",
  ];
  const allowedDraftKeys = new Set([...requiredDraftKeys, "collaborator_id", "collaborator_display_name"]);
  for (const draft of value.drafts) {
    if (!isRecord(draft) ||
        !requiredDraftKeys.every((key) => Object.hasOwn(draft, key)) ||
        Object.keys(draft).some((key) => !allowedDraftKeys.has(key)) ||
        (Object.hasOwn(draft, "collaborator_id") && draft.collaborator_id !== null &&
          (typeof draft.collaborator_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(draft.collaborator_id))) ||
        (Object.hasOwn(draft, "collaborator_display_name") && draft.collaborator_display_name !== null &&
          (typeof draft.collaborator_display_name !== "string" || draft.collaborator_display_name.trim().length === 0)) ||
        typeof draft.submission_id !== "string" || !UUID.test(draft.submission_id) ||
        !isPositiveVersion(draft.submission_version) ||
        typeof draft.entry_id !== "string" || !UUID.test(draft.entry_id) ||
        !isPositiveVersion(draft.entry_version) ||
        typeof draft.employee_code !== "string" || typeof draft.first_work_date !== "string" ||
        typeof draft.worker_display_name !== "string" ||
        typeof draft.project_id !== "string" || typeof draft.project_display_name !== "string" ||
        typeof draft.recruiter_id !== "string" || !UUID.test(draft.recruiter_id) ||
        typeof draft.recruiter_display_name !== "string" ||
        (draft.provider_type !== "hrp" && draft.provider_type !== "vendor") ||
        typeof draft.team_id !== "string" || !UUID.test(draft.team_id) ||
        typeof draft.team_display_name !== "string" ||
        !isCanonicalLaborTypeKey(draft.labor_type) ||
        typeof draft.labor_type_display !== "string" || draft.labor_type_display.length < 1 ||
        (draft.employment_status !== null && draft.employment_status !== "UNCONFIRMED" &&
          draft.employment_status !== "ON" && draft.employment_status !== "OFF") ||
        !isRealCalendarDate(draft.first_work_date) ||
        validateEmployeeCode(draft.employee_code, draft.first_work_date).length > 0 ||
        typeof draft.created_at !== "string" || !Number.isFinite(Date.parse(draft.created_at)) ||
        typeof draft.updated_at !== "string" || !Number.isFinite(Date.parse(draft.updated_at))) return null;
    const profile = projectDraftProfile(draft.profile);
    if (!profile) return null;
    const projectedDisplayName = profile.worker_details.display_name;
    if ((projectedDisplayName.state === "provided" &&
        draft.worker_display_name !== projectedDisplayName.value) ||
        (projectedDisplayName.state === "redacted" && draft.worker_display_name !== "") ||
        (projectedDisplayName.state !== "provided" && projectedDisplayName.state !== "redacted")) {
      return null;
    }
    if (entryIds.has(draft.entry_id)) return null;
    entryIds.add(draft.entry_id);
    drafts.push({
      submission_id: draft.submission_id,
      submission_version: draft.submission_version,
      entry_id: draft.entry_id,
      entry_version: draft.entry_version,
      employee_code: draft.employee_code,
      first_work_date: draft.first_work_date,
      worker_display_name: draft.worker_display_name,
      project_id: draft.project_id,
      project_display_name: draft.project_display_name,
      recruiter_id: draft.recruiter_id,
      recruiter_display_name: draft.recruiter_display_name,
      provider_type: draft.provider_type,
      ...(Object.hasOwn(draft, "collaborator_id") ? { collaborator_id: draft.collaborator_id as string | null } : {}),
      ...(Object.hasOwn(draft, "collaborator_display_name")
        ? { collaborator_display_name: draft.collaborator_display_name as string | null }
        : {}),
      team_id: draft.team_id,
      team_display_name: draft.team_display_name,
      labor_type: draft.labor_type,
      labor_type_display: draft.labor_type_display,
      employment_status: draft.employment_status,
      created_at: draft.created_at,
      updated_at: draft.updated_at,
      profile,
    });
  }
  return drafts;
}

function projectDraftProfile(value: unknown): DraftProfileProjection | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contract_version", "worker_details", "general_note", "employment", "payment",
  ]) || value.contract_version !== "worker-profile/1.0" ||
      !isRecord(value.worker_details) || !hasExactKeys(value.worker_details, [
        "display_name", "gender", "date_of_birth", "national_id", "national_id_issued_at",
        "national_id_issued_place", "address", "phone",
      ])) return null;
  const workerFields = {
    display_name: projectDraftField(value.worker_details.display_name),
    gender: projectDraftField(value.worker_details.gender),
    date_of_birth: projectDraftField(value.worker_details.date_of_birth),
    national_id: projectDraftField(value.worker_details.national_id),
    national_id_issued_at: projectDraftField(value.worker_details.national_id_issued_at),
    national_id_issued_place: projectDraftField(value.worker_details.national_id_issued_place),
    address: projectDraftField(value.worker_details.address),
    phone: projectDraftField(value.worker_details.phone),
  };
  if (workerFields.display_name === null || workerFields.gender === null ||
      workerFields.date_of_birth === null || workerFields.national_id === null ||
      workerFields.national_id_issued_at === null ||
      workerFields.national_id_issued_place === null || workerFields.address === null ||
      workerFields.phone === null) return null;
  const generalNote = projectDraftField(value.general_note);
  const employment = projectDraftEmployment(value.employment);
  const payment = projectDraftPayment(value.payment);
  if (!generalNote || (value.employment !== null && !employment) ||
      (value.payment !== null && !payment)) return null;
  return {
    contract_version: "worker-profile/1.0",
    worker_details: {
      display_name: workerFields.display_name,
      gender: workerFields.gender,
      date_of_birth: workerFields.date_of_birth,
      national_id: workerFields.national_id,
      national_id_issued_at: workerFields.national_id_issued_at,
      national_id_issued_place: workerFields.national_id_issued_place,
      address: workerFields.address,
      phone: workerFields.phone,
    },
    general_note: generalNote,
    employment,
    payment,
  };
}

function projectDraftField(value: unknown): DraftProfileField | null {
  if (!isRecord(value) || typeof value.state !== "string") return null;
  if (value.state === "provided") {
    return hasExactKeys(value, ["state", "value"]) && typeof value.value === "string"
      ? { state: "provided", value: value.value }
      : null;
  }
  if (value.state === "redacted") {
    return hasExactKeys(value, ["state", "present"]) && typeof value.present === "boolean"
      ? { state: "redacted", present: value.present }
      : null;
  }
  return ["omitted", "unknown", "intentionally_blank"].includes(value.state) &&
    hasExactKeys(value, ["state"])
    ? { state: value.state as "omitted" | "unknown" | "intentionally_blank" }
    : null;
}

function projectDraftEmployment(value: unknown): DraftProfileProjection["employment"] | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, [
    "status", "effective_date", "version", "leave_date", "leave_reason_text",
  ]) || (value.status !== "UNCONFIRMED" && value.status !== "ON" && value.status !== "OFF") ||
      typeof value.effective_date !== "string" || !isRealCalendarDate(value.effective_date) ||
      !isPositiveVersion(value.version)) return null;
  const leaveDate = projectDraftField(value.leave_date);
  const leaveReason = projectDraftField(value.leave_reason_text);
  return leaveDate && leaveReason
    ? {
      status: value.status,
      effective_date: value.effective_date,
      version: value.version,
      leave_date: leaveDate,
      leave_reason_text: leaveReason,
    }
    : null;
}

function projectDraftPayment(value: unknown): DraftProfileProjection["payment"] | null {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, [
    "state", "account_number", "bank_name", "account_holder_name", "version",
  ]) || (value.state !== "provided" && value.state !== "omitted" && value.state !== "unknown" &&
      value.state !== "intentionally_blank" && value.state !== "not_provided") ||
      !isPositiveVersion(value.version)) return null;
  const accountNumber = projectDraftPaymentAccount(value.account_number);
  const bankName = projectDraftField(value.bank_name);
  const accountHolderName = projectDraftField(value.account_holder_name);
  return accountNumber && bankName && accountHolderName
    ? {
      state: value.state,
      account_number: accountNumber,
      bank_name: bankName,
      account_holder_name: accountHolderName,
      version: value.version,
    }
    : null;
}

function projectDraftPaymentAccount(value: unknown): DraftPaymentAccountField | null {
  if (!isRecord(value) || typeof value.state !== "string") return null;
  if (value.state === "masked") {
    if (!hasExactKeys(value, ["state", "value"]) || typeof value.value !== "string") return null;
    const match = /^(?:•{1,60})?([0-9]{1,4})( *)$/.exec(value.value);
    return match && match[1].length + match[2].length <= 4
      ? { state: "masked", value: value.value }
      : { state: "redacted", present: true };
  }
  const field = projectDraftField(value);
  return !field || field.state !== "provided" || /^[0-9]{1,64}$/.test(field.value)
    ? field
    : { state: "redacted", present: true };
}
