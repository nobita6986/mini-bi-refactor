import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import {
  isCanonicalLaborTypeKey,
  validateEmployeeCode,
  type DocumentType,
  type LaborType,
} from "../contracts/direct-entry-v1.ts";
import { isCanonicalNationalId } from "../contracts/national-id.ts";

export const WORKER_PROFILE_CONTRACT_VERSION = "worker-profile/1.0" as const;
export const SERVER_GENERATED_EMPLOYEE_CODE_CONTRACT_VERSION = "worker-profile/1.1" as const;
export const CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION = "worker-profile/1.2" as const;
export const FULL_PROFILE_MAX_ROWS = 100;
export const FULL_PROFILE_MAX_BODY_BYTES = 4 * 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// P2.5-HF-R2: CMT/CCCD theo dung quy tac canonical dung chung (xem contracts/national-id.ts).
const ROOT_KEYS = new Set(["contract_version", "rows"]);
const ROW_KEYS = new Set([
  "project_id", "first_work_date", "employee_code", "recruiter_id", "labor_type", "collaborator_id",
  "display_name", "worker", "general_note", "payment", "employment", "portrait_stage_id",
  "document_stage_ids",
]);
const SERVER_GENERATED_ROW_KEYS = new Set([
  "project_id", "first_work_date", "provider_type", "recruiter_id", "labor_type", "collaborator_id",
  "display_name", "worker", "general_note", "payment", "employment", "portrait_stage_id",
  "document_stage_ids",
]);
const WORKER_KEYS = new Set([
  "gender", "date_of_birth", "national_id", "national_id_issued_at",
  "national_id_issued_place", "address", "phone",
]);
const FORBIDDEN_KEYS = new Set([
  "actor", "actor_id", "app_user_id", "auth_subject", "capability", "capabilities",
  "scope", "scope_kind", "scope_team_id", "audit", "audit_event", "revision",
  "revision_id", "state", "entry_id", "submission_id", "candidate_id",
  "provider_type", "team", "team_id", "team_hint", "provider_hint", "row_index",
  "effective_month", "age_years", "payment_state", "bank", "bank_label",
]);

export type OptionalText =
  | { state: "omitted" | "unknown" | "intentionally_blank" }
  | { state: "provided"; value: string };

export type FullProfileRpcRow = {
  portrait_stage_id?: string;
  document_stage_ids?: Partial<Record<DocumentType, string>>;
  project_id: string;
  first_work_date: string;
  employee_code: string;
  recruiter_id: string;
  labor_type: LaborType;
  collaborator_id?: string | null;
  display_name: string;
  worker_details: {
    gender: OptionalText;
    date_of_birth: OptionalText;
    national_id: OptionalText;
    national_id_issued_at: OptionalText;
    national_id_issued_place: OptionalText;
    address: OptionalText;
    phone: OptionalText;
  };
  general_note: OptionalText;
  payment: null | {
    state: "omitted" | "unknown" | "intentionally_blank" | "provided";
    account_number?: string | null;
    bank_id?: string;
    bank_name?: string | null;
    account_holder_name?: string | null;
  };
  employment: null | {
    initial_status: "UNCONFIRMED" | "ON";
  } | {
    initial_status: "OFF";
    leave_date: string;
    leave_reason_text: string;
  };
};

export type ServerGeneratedFullProfileRpcRow = Omit<FullProfileRpcRow, "employee_code"> & {
  provider_type: "hrp" | "vendor";
};

export type CccdRequiredFullProfileRpcRow = ServerGeneratedFullProfileRpcRow;

export type FullProfilePayload =
  | {
    contract_version: typeof WORKER_PROFILE_CONTRACT_VERSION;
    rows: FullProfileRpcRow[];
  }
  | {
    contract_version: typeof SERVER_GENERATED_EMPLOYEE_CODE_CONTRACT_VERSION;
    rows: ServerGeneratedFullProfileRpcRow[];
  }
  | {
    contract_version: typeof CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION;
    rows: CccdRequiredFullProfileRpcRow[];
  };

export type ContractIssue = {
  code: string;
  path: string;
};

export type FullProfileParseResult =
  | { ok: true; payload: FullProfilePayload }
  | { ok: false; issues: ContractIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

function hasForbiddenKey(value: unknown, allowedRootKeys: ReadonlySet<string> = new Set()): boolean {
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) =>
    (FORBIDDEN_KEYS.has(key) && !allowedRootKeys.has(key)) || hasForbiddenKey(item)
  );
}

function optionalText(value: unknown, path: string, maxLength: number): {
  value: OptionalText;
  issue?: ContractIssue;
} {
  if (value === undefined) return { value: { state: "omitted" } };
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["state", "value"]))) {
    return { value: { state: "omitted" }, issue: { code: "BATCH_INVALID", path } };
  }
  if (value.state === "omitted" || value.state === "unknown" ||
      value.state === "intentionally_blank") {
    if (Object.hasOwn(value, "value")) {
      return { value: { state: "omitted" }, issue: { code: "BATCH_INVALID", path } };
    }
    return { value: { state: value.state } };
  }
  if (value.state !== "provided" || typeof value.value !== "string" ||
      value.value.length > maxLength) {
    return {
      value: { state: "omitted" },
      issue: {
        code: path.endsWith(".general_note") &&
          typeof value.value === "string" && value.value.length > maxLength
          ? "GENERAL_NOTE_TOO_LONG"
          : "BATCH_INVALID",
        path,
      },
    };
  }
  return { value: { state: "provided", value: value.value } };
}

// P3-W07C-R2: DOB va Ngay cap la text thuong. Chi gioi han kich thuoc payload
// (10 ky tu) va chan chuoi rong; khong parse/regex/validate ngay hay so sanh.
function optionalFreeDate(
  value: unknown,
  path: string,
): { value: OptionalText; issue?: ContractIssue } {
  const parsed = optionalText(value, path, 10);
  if (parsed.value.state === "provided" && parsed.value.value.trim().length === 0) {
    return { value: { state: "omitted" }, issue: { code: "PASTE_VALUE_FORMAT", path } };
  }
  return parsed;
}

function normalizeWorker(
  value: unknown,
  path: string,
  issues: ContractIssue[],
  options: { requireCccd12?: boolean } = {},
) {
  const input = value === undefined ? {} : value;
  if (!isRecord(input) || !hasOnlyKeys(input, WORKER_KEYS)) {
    issues.push({ code: "BATCH_INVALID", path });
    return null;
  }
  const gender = optionalText(input.gender, `${path}.gender`, 32);
  // P3-W07C-R2: validator o day chi check non-empty; khong parse/canonicalize.
  const dateOfBirth = optionalFreeDate(input.date_of_birth, `${path}.date_of_birth`);
  const nationalId = optionalText(input.national_id, `${path}.national_id`, 64);
  const issuedAt = optionalFreeDate(input.national_id_issued_at, `${path}.national_id_issued_at`);
  const issuedPlace = optionalText(input.national_id_issued_place, `${path}.national_id_issued_place`, 256);
  const address = optionalText(input.address, `${path}.address`, 1024);
  const phone = optionalText(input.phone, `${path}.phone`, 64);
  for (const parsed of [gender, dateOfBirth, nationalId, issuedAt, issuedPlace, address, phone]) {
    if (parsed.issue) issues.push(parsed.issue);
  }
  if (gender.value.state === "provided" &&
      !["MALE", "FEMALE", "OTHER"].includes(gender.value.value.trim().toUpperCase())) {
    issues.push({ code: "GENDER_VOCABULARY_INVALID", path: `${path}.gender` });
  } else if (gender.value.state === "intentionally_blank") {
    issues.push({ code: "GENDER_VOCABULARY_INVALID", path: `${path}.gender` });
  } else if (gender.value.state === "provided") {
    gender.value = { state: "provided", value: gender.value.value.trim().toUpperCase() };
  }
  if (options.requireCccd12) {
    if (
      nationalId.value.state !== "provided" ||
      !/^\d{12}$/.test(nationalId.value.value) ||
      nationalId.value.value === "000000000000"
    ) {
      if (!nationalId.issue) {
        issues.push({ code: "NATIONAL_ID_INVALID", path: `${path}.national_id` });
      }
    }
  } else if (nationalId.value.state === "provided" && !isCanonicalNationalId(nationalId.value.value)) {
    issues.push({ code: "NATIONAL_ID_INVALID", path: `${path}.national_id` });
  }
  if (issuedPlace.value.state === "provided" &&
      issuedPlace.value.value.trim().length === 0) {
    issues.push({ code: "NATIONAL_ID_ISSUED_PLACE_INVALID", path: `${path}.national_id_issued_place` });
  }
  return {
    gender: gender.value,
    date_of_birth: dateOfBirth.value,
    national_id: nationalId.value,
    national_id_issued_at: issuedAt.value,
    national_id_issued_place: issuedPlace.value,
    address: address.value,
    phone: phone.value,
  };
}

function normalizePayment(value: unknown, path: string, issues: ContractIssue[]): FullProfileRpcRow["payment"] {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) ||
      !hasOnlyKeys(value, new Set([
        "state", "account_number", "bank_id", "bank_name", "account_holder_name",
      ])) ||
      !["omitted", "unknown", "intentionally_blank", "provided"].includes(String(value.state))) {
    issues.push({ code: "BATCH_INVALID", path });
    return null;
  }
  const normalizeText = (key: "account_number" | "bank_name" | "account_holder_name",
    maxLength: number): string | null => {
    const field = value[key];
    if (field === undefined || field === null) return null;
    if (typeof field !== "string") {
      issues.push({ code: "PAYMENT_DETAILS_INVALID", path });
      return null;
    }
    const normalized = field.trim();
    if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
      issues.push({ code: "PAYMENT_DETAILS_INVALID", path });
      return null;
    }
    return normalized || null;
  };
  const accountNumber = normalizeText("account_number", 64);
  const bankName = normalizeText("bank_name", 256);
  const accountHolderName = normalizeText("account_holder_name", 256);
  const bankIdValue = value.bank_id;
  const bankId = bankIdValue == null ? null
    : typeof bankIdValue === "string" && CATALOG_ID.test(bankIdValue.trim())
      ? bankIdValue.trim()
      : null;
  if (bankIdValue != null && bankId === null) {
    issues.push({ code: "PAYMENT_DETAILS_INVALID", path });
  }
  const hasMetadata = accountNumber !== null || bankName !== null || accountHolderName !== null;
  if (value.state !== "provided") {
    if (hasMetadata || bankId !== null) issues.push({ code: "PAYMENT_DETAILS_INVALID", path });
    return { state: value.state as "omitted" | "unknown" | "intentionally_blank" };
  }
  if (!hasMetadata) {
    if (bankId !== null) issues.push({ code: "PAYMENT_DETAILS_INVALID", path });
    return { state: "omitted" };
  }
  if (issues.some((issue) => issue.path === path)) return null;
  return {
    state: "provided",
    ...(accountNumber === null ? {} : { account_number: accountNumber }),
    ...(bankId === null ? {} : { bank_id: bankId }),
    ...(bankName === null ? {} : { bank_name: bankName }),
    ...(accountHolderName === null ? {} : { account_holder_name: accountHolderName }),
  };
}

function normalizeEmployment(
  value: unknown,
  path: string,
  issues: ContractIssue[],
  options: { requireActiveInitialStatus?: boolean } = {},
): FullProfileRpcRow["employment"] {
  if (value === undefined || value === null) {
    if (options.requireActiveInitialStatus) {
      issues.push({ code: "BATCH_INVALID", path });
    }
    return null;
  }
  if (!isRecord(value) ||
      !hasOnlyKeys(value, new Set(["initial_status", "leave_date", "leave_reason_text"]))) {
    issues.push({ code: "BATCH_INVALID", path });
    return null;
  }
  const status = value.initial_status == null ||
    (typeof value.initial_status === "string" && value.initial_status.trim() === "")
    ? "ON" : value.initial_status;
  if (options.requireActiveInitialStatus && status !== "UNCONFIRMED" && status !== "ON") {
    issues.push({ code: "BATCH_INVALID", path });
    return null;
  }
  if (status !== "UNCONFIRMED" && status !== "ON" && status !== "OFF") {
    issues.push({ code: "BATCH_INVALID", path });
    return null;
  }
  const leaveDate = value.leave_date;
  const leaveReason = value.leave_reason_text;
  if (status === "OFF") {
    if (typeof leaveDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(leaveDate) ||
        !isRealCalendarDate(leaveDate) || typeof leaveReason !== "string" ||
        leaveReason.trim().length < 1 || leaveReason.length > 4000) {
      issues.push({ code: "OFF_REQUIRES_DATE_AND_REASON", path });
      return null;
    }
    return {
      initial_status: status,
      leave_date: leaveDate,
      leave_reason_text: leaveReason,
    };
  }
  if (leaveDate !== undefined || leaveReason !== undefined) {
    issues.push({ code: "BATCH_INVALID", path });
    return null;
  }
  return { initial_status: status };
}

export function parseFullProfilePayload(value: unknown): FullProfileParseResult {
  if (!isRecord(value) || !hasOnlyKeys(value, ROOT_KEYS)) {
    return {
      ok: false,
      issues: [{ code: hasForbiddenKey(value) ? "CLIENT_AUTHORITY_FIELD_FORBIDDEN" : "BATCH_INVALID", path: "body" }],
    };
  }
  const cccdRequired = value.contract_version === CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION;
  const generatedCodes =
    value.contract_version === SERVER_GENERATED_EMPLOYEE_CODE_CONTRACT_VERSION ||
    cccdRequired;
  if (value.contract_version !== WORKER_PROFILE_CONTRACT_VERSION && !generatedCodes) {
    return { ok: false, issues: [{ code: "CONTRACT_VERSION_UNSUPPORTED", path: "contract_version" }] };
  }
  if (!Array.isArray(value.rows) || value.rows.length < 1 ||
      value.rows.length > FULL_PROFILE_MAX_ROWS) {
    return { ok: false, issues: [{ code: "BATCH_SIZE_INVALID", path: "rows" }] };
  }

  const issues: ContractIssue[] = [];
  const seenCodes = new Set<string>();
  const rows: (FullProfileRpcRow | ServerGeneratedFullProfileRpcRow)[] = [];
  value.rows.forEach((item, index) => {
    const path = `rows[${index}]`;
    const rowKeys = generatedCodes ? SERVER_GENERATED_ROW_KEYS : ROW_KEYS;
    if (!isRecord(item) || !hasOnlyKeys(item, rowKeys)) {
      issues.push({
        code: hasForbiddenKey(item, generatedCodes ? new Set(["provider_type"]) : undefined)
          ? "CLIENT_AUTHORITY_FIELD_FORBIDDEN" : "BATCH_INVALID",
        path,
      });
      return;
    }
    const {
      project_id, first_work_date, employee_code, recruiter_id, labor_type, display_name,
    } = item;
    const provider_type = item.provider_type;
    let collaboratorId: string | null | undefined;
    if (Object.hasOwn(item, "collaborator_id")) {
      if (item.collaborator_id === null) {
        collaboratorId = null;
      } else if (typeof item.collaborator_id === "string" &&
                 CATALOG_ID.test(item.collaborator_id.trim())) {
        collaboratorId = item.collaborator_id.trim();
      } else {
        issues.push({ code: "BATCH_INVALID", path: `${path}.collaborator_id` });
        return;
      }
    }
    if (generatedCodes && typeof collaboratorId === "string" && provider_type !== "hrp") {
      issues.push({ code: "BATCH_INVALID", path: `${path}.collaborator_id` });
      return;
    }
    const portraitStageId = item.portrait_stage_id;
    const documentStageValue = item.document_stage_ids;
    let documentStageIds: Partial<Record<DocumentType, string>> | undefined;
    if (documentStageValue !== undefined) {
      if (!isRecord(documentStageValue) || Object.keys(documentStageValue).length < 1 ||
          Object.keys(documentStageValue).some((key) =>
            !["CCCD_FRONT", "CCCD_BACK", "EMPLOYMENT_CONTRACT"].includes(key)) ||
          Object.values(documentStageValue).some((stageId) =>
            typeof stageId !== "string" || !UUID.test(stageId))) {
        issues.push({ code: "BATCH_INVALID", path: `${path}.document_stage_ids` });
      } else {
        documentStageIds = documentStageValue as Partial<Record<DocumentType, string>>;
      }
    }
    const displayNameValid =
      typeof display_name === "string" &&
      display_name.length <= 256 &&
      (cccdRequired
        ? display_name.length === 0 || display_name.trim().length >= 1
        : display_name.trim().length >= 1);
    if (typeof project_id !== "string" || !CATALOG_ID.test(project_id) ||
        typeof recruiter_id !== "string" || !UUID.test(recruiter_id) ||
        typeof first_work_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(first_work_date) ||
        !isRealCalendarDate(first_work_date) ||
        (!generatedCodes && typeof employee_code !== "string") ||
        (generatedCodes && provider_type !== "hrp" && provider_type !== "vendor") ||
        !displayNameValid ||
        (portraitStageId !== undefined &&
          (typeof portraitStageId !== "string" || !UUID.test(portraitStageId))) ||
        !isCanonicalLaborTypeKey(labor_type)) {
      issues.push({ code: "BATCH_INVALID", path });
      return;
    }
    if (!generatedCodes) {
      const employeeCodeIssue = validateEmployeeCode(employee_code as string, first_work_date)[0];
      if (employeeCodeIssue) {
        issues.push({ code: employeeCodeIssue.code, path: `${path}.employee_code` });
      }
      if (seenCodes.has(employee_code as string)) {
        issues.push({ code: "EMPLOYEE_CODE_DUPLICATE", path: `${path}.employee_code` });
      }
      seenCodes.add(employee_code as string);
    }

    const worker = normalizeWorker(item.worker, `${path}.worker`, issues, {
      requireCccd12: cccdRequired,
    });
    const generalNote = optionalText(item.general_note, `${path}.general_note`, 4000);
    if (generalNote.issue) issues.push(generalNote.issue);
    if (generalNote.value.state === "unknown" ||
        generalNote.value.state === "intentionally_blank") {
      issues.push({ code: "GENERAL_NOTE_INVALID", path: `${path}.general_note` });
    }
    if (generalNote.value.state === "provided" &&
        generalNote.value.value.trim().length === 0) {
      issues.push({ code: "GENERAL_NOTE_INVALID", path: `${path}.general_note` });
    }
    const payment = normalizePayment(item.payment, `${path}.payment`, issues);
    const employment = normalizeEmployment(item.employment, `${path}.employment`, issues, {
      requireActiveInitialStatus: cccdRequired,
    });
    const normalizedRow = {
      ...(typeof portraitStageId === "string" ? { portrait_stage_id: portraitStageId } : {}),
      ...(documentStageIds ? { document_stage_ids: documentStageIds } : {}),
      project_id,
      first_work_date,
      recruiter_id,
      labor_type: labor_type as LaborType,
      ...(collaboratorId !== undefined ? { collaborator_id: collaboratorId } : {}),
      display_name: (display_name as string).trim(),
      worker_details: worker ?? {
        gender: { state: "omitted" },
        date_of_birth: { state: "omitted" },
        national_id: { state: "omitted" },
        national_id_issued_at: { state: "omitted" },
        national_id_issued_place: { state: "omitted" },
        address: { state: "omitted" },
        phone: { state: "omitted" },
      },
      general_note: generalNote.value,
      payment,
      employment,
    };
    rows.push(generatedCodes
      ? { ...normalizedRow, provider_type: provider_type as "hrp" | "vendor" }
      : { ...normalizedRow, employee_code: employee_code as string });
  });

  if (issues.length > 0) return { ok: false, issues };
  if (cccdRequired) {
    return {
      ok: true,
      payload: {
        contract_version: CCCD_REQUIRED_FULL_PROFILE_CONTRACT_VERSION,
        rows: rows as CccdRequiredFullProfileRpcRow[],
      },
    };
  }
  return generatedCodes
    ? {
      ok: true,
      payload: {
        contract_version: SERVER_GENERATED_EMPLOYEE_CODE_CONTRACT_VERSION,
        rows: rows as ServerGeneratedFullProfileRpcRow[],
      },
    }
    : {
      ok: true,
      payload: {
        contract_version: WORKER_PROFILE_CONTRACT_VERSION,
        rows: rows as FullProfileRpcRow[],
      },
    };
}
