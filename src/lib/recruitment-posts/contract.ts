import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";

export const MAX_RECRUITMENT_POST_BODY_BYTES = 96 * 1024;
export const DEFAULT_RECRUITMENT_POST_PAGE_SIZE = 15;
export const MIN_RECRUITMENT_POST_PAGE_SIZE = 1;
export const MAX_RECRUITMENT_POST_PAGE_SIZE = 15;

export const RECRUITMENT_POST_AGE_MIN = 15;
export const RECRUITMENT_POST_AGE_MAX = 70;
export const RECRUITMENT_POST_MAX_EXPECTED_HEADCOUNT = 1_000_000;
export const RECRUITMENT_POST_MAX_SAFE_VND = 9_007_199_254_740_991;

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROJECT_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const CATALOG_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
export const LABOR_TYPE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MANAGER_PHONE_PATTERN = /^[0-9+(). -]{6,32}$/;
export const VND_STRING_PATTERN = /^(0|[1-9][0-9]*)$/;
export const ISO_UTC_MICROS_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
export const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

export const RECRUITMENT_POST_SNAPSHOT_TOKEN_PATTERN =
  /^S1\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{32})$/;
export const RECRUITMENT_POST_CURSOR_PATTERN =
  /^C1\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{32})\.(0|[1-9][0-9]{0,17})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const RECRUITMENT_POST_STATUSES = ["PUBLISHED", "WITHDRAWN"] as const;
export type RecruitmentPostStatus = (typeof RECRUITMENT_POST_STATUSES)[number];

export const RECRUITMENT_POST_ENVIRONMENT_TYPES = [
  "CLEAN_ROOM",
  "NORMAL_ROOM",
  "SEMI_CLEAN_ROOM",
] as const;
export type RecruitmentPostEnvironmentType =
  (typeof RECRUITMENT_POST_ENVIRONMENT_TYPES)[number];

export const RECRUITMENT_POST_WORK_POSTURES = ["STANDING", "SITTING"] as const;
export type RecruitmentPostWorkPosture =
  (typeof RECRUITMENT_POST_WORK_POSTURES)[number];

export const RECRUITMENT_POST_SHIFT_PATTERNS = [
  "DAY_ONLY",
  "TWO_SHIFTS",
  "THREE_SHIFTS",
  "OTHER",
] as const;
export type RecruitmentPostShiftPattern =
  (typeof RECRUITMENT_POST_SHIFT_PATTERNS)[number];

export const RECRUITMENT_POST_GENDER_REQUIREMENTS = [
  "FEMALE",
  "MALE",
  "ANY",
] as const;
export type RecruitmentPostGenderRequirement =
  (typeof RECRUITMENT_POST_GENDER_REQUIREMENTS)[number];

export const RECRUITMENT_POST_EDUCATION_REQUIREMENTS = [
  "SECONDARY",
  "HIGH_SCHOOL",
  "NONE",
] as const;
export type RecruitmentPostEducationRequirement =
  (typeof RECRUITMENT_POST_EDUCATION_REQUIREMENTS)[number];

export const RECRUITMENT_POST_ERROR_CODES = [
  "NOT_FOUND",
  "UNAUTHENTICATED",
  "ACTOR_NOT_AVAILABLE",
  "CSRF_ORIGIN_DENIED",
  "CLIENT_AUTHORITY_FIELD_FORBIDDEN",
  "INVALID_JSON",
  "REQUEST_BODY_TOO_LARGE",
  "RECRUITMENT_POST_IDEMPOTENCY_INVALID",
  "RECRUITMENT_POST_INPUT_INVALID",
  "RECRUITMENT_POST_SNAPSHOT_INVALID",
  "RECRUITMENT_POST_CONTENT_INVALID",
  "RECRUITMENT_POST_ACCESS_DENIED",
  "RECRUITMENT_POST_NOT_FOUND",
  "RECRUITMENT_POST_STALE",
  "RECRUITMENT_POST_ALREADY_WITHDRAWN",
  "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT",
  "RECRUITMENT_POST_UNAVAILABLE",
] as const;

export type RecruitmentPostErrorCode =
  (typeof RECRUITMENT_POST_ERROR_CODES)[number];

export function recruitmentPostHttpStatusForError(
  code: RecruitmentPostErrorCode,
): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "ACTOR_NOT_AVAILABLE":
    case "CSRF_ORIGIN_DENIED":
    case "RECRUITMENT_POST_ACCESS_DENIED":
      return 403;
    case "NOT_FOUND":
    case "RECRUITMENT_POST_NOT_FOUND":
      return 404;
    case "RECRUITMENT_POST_STALE":
    case "RECRUITMENT_POST_ALREADY_WITHDRAWN":
    case "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT":
      return 409;
    case "REQUEST_BODY_TOO_LARGE":
      return 413;
    case "RECRUITMENT_POST_CONTENT_INVALID":
      return 422;
    case "CLIENT_AUTHORITY_FIELD_FORBIDDEN":
    case "INVALID_JSON":
    case "RECRUITMENT_POST_IDEMPOTENCY_INVALID":
    case "RECRUITMENT_POST_INPUT_INVALID":
    case "RECRUITMENT_POST_SNAPSHOT_INVALID":
      return 400;
    case "RECRUITMENT_POST_UNAVAILABLE":
    default:
      return 503;
  }
}

export type RecruitmentPostProjectOption = {
  project_id: string;
  display_name: string;
};

export type RecruitmentPostProvinceOption = {
  province_id: string;
  province_code: string;
  display_name: string;
  active: boolean;
};

export type RecruitmentPostIndustrialParkOption = {
  industrial_park_id: string;
  industrial_park_code: string;
  province_id: string;
  display_name: string;
  active: boolean;
};

export type RecruitmentPostLaborTypeOption = {
  labor_type_key: string;
  display_name: string;
  active: boolean;
};

export type RecruitmentPostContext = {
  can_create: boolean;
  managed_projects: RecruitmentPostProjectOption[];
  filter_projects: RecruitmentPostProjectOption[];
  provinces: RecruitmentPostProvinceOption[];
  industrial_parks: RecruitmentPostIndustrialParkOption[];
  labor_types: RecruitmentPostLaborTypeOption[];
};

export type RecruitmentPostGeneralInput = {
  customer_name: string;
  investment_origin: string | null;
  manufacturing_industry: string | null;
  job_description: string;
  environment_types: RecruitmentPostEnvironmentType[];
  work_postures: RecruitmentPostWorkPosture[];
  shift_pattern: RecruitmentPostShiftPattern;
  shift_details: string | null;
  manager_name: string;
  manager_phone: string;
  labor_type_keys: string[];
  supply_schedule_text: string | null;
  expected_headcount: number | null;
};

export type RecruitmentPostGeneralProjection = Omit<
  RecruitmentPostGeneralInput,
  "labor_type_keys"
> & {
  labor_types: Array<{
    labor_type_key: string;
    display_name: string;
  }>;
};

export type RecruitmentPostCandidateSection = {
  age_min: number | null;
  age_max: number | null;
  gender_requirement: RecruitmentPostGenderRequirement;
  education_requirement: RecruitmentPostEducationRequirement;
  experience_required: boolean;
  experience_details: string | null;
  accept_former_customer_workers: boolean;
  entry_assessment_text: string | null;
  other_requirements_text: string | null;
};

export type RecruitmentPostCompensationSection = {
  base_salary_vnd: string | null;
  base_salary_conditions: string | null;
  attendance_bonus_vnd: string | null;
  attendance_bonus_conditions: string | null;
  living_allowance_vnd: string | null;
  living_allowance_conditions: string | null;
  seniority_allowance_vnd: string | null;
  seniority_allowance_conditions: string | null;
  eyesight_allowance_vnd: string | null;
  eyesight_allowance_conditions: string | null;
  other_allowance_text: string | null;
  average_income_min_vnd: string | null;
  average_income_max_vnd: string | null;
  salary_payment_schedule: string | null;
  salary_advance_available: boolean;
  salary_advance_amount_vnd: string | null;
  salary_advance_schedule: string | null;
  weekly_salary_available: boolean;
  weekly_salary_payment_schedule: string | null;
  day_shift_8h_vnd: string | null;
  day_shift_11h_vnd: string | null;
  night_shift_8h_vnd: string | null;
  night_shift_11h_vnd: string | null;
  sunday_day_11h_vnd: string | null;
  sunday_night_11h_vnd: string | null;
  holiday_day_11h_vnd: string | null;
  holiday_night_11h_vnd: string | null;
  ppe_provided: boolean;
  ppe_details: string | null;
  other_benefits: string | null;
};

export type RecruitmentPostDocumentsSection = {
  require_original_cccd_and_copy: boolean;
  require_certified_resume: boolean;
  require_health_certificate_within_6_months: boolean;
  require_photo_3x4: boolean;
  require_degree_or_certificate: boolean;
  require_social_insurance_book: boolean;
  require_other_documents: boolean;
  other_documents_text: string | null;
};

export type RecruitmentPostContentInput = {
  general: RecruitmentPostGeneralInput;
  candidate: RecruitmentPostCandidateSection;
  compensation: RecruitmentPostCompensationSection;
  documents: RecruitmentPostDocumentsSection;
};

export type RecruitmentPostItem = {
  brief_id: string;
  version: number;
  status: RecruitmentPostStatus;
  project: {
    project_id: string;
    display_name: string;
  };
  industrial_park: {
    industrial_park_id: string;
    industrial_park_code: string;
    display_name: string;
    active: boolean;
  };
  province: {
    province_id: string;
    province_code: string;
    display_name: string;
  };
  published_at: string;
  updated_at: string;
  withdrawn_at: string | null;
  created_by_display_name: string;
  updated_by_display_name: string;
  withdrawn_by_display_name: string | null;
  general: RecruitmentPostGeneralProjection;
  candidate: RecruitmentPostCandidateSection;
  compensation: RecruitmentPostCompensationSection;
  documents: RecruitmentPostDocumentsSection;
  allowed_actions: {
    can_edit: boolean;
    can_withdraw: boolean;
  };
};

export type RecruitmentPostList = {
  items: RecruitmentPostItem[];
  page_size: number;
  has_more: boolean;
  next_cursor: string | null;
  snapshot_token: string;
};

export type RecruitmentPostIndustrialParkFacet = {
  industrial_park_id: string;
  industrial_park_code: string;
  display_name: string;
  active: true;
  job_count: number;
};

export type RecruitmentPostLaborTypeFacet = {
  labor_type_key: string;
  display_name: string;
  job_count: number;
};

export type RecruitmentPostListWithFacets = RecruitmentPostList & {
  total_count: number;
  industrial_parks: RecruitmentPostIndustrialParkFacet[];
  labor_types: RecruitmentPostLaborTypeFacet[];
};

export type RecruitmentPostGetResult = {
  post: RecruitmentPostItem;
};

export type RecruitmentPostMutationResult = {
  post: RecruitmentPostItem;
  changed: boolean;
  replayed: boolean;
};

export type RecruitmentPostParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: RecruitmentPostErrorCode };

const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "authsubject",
  "appuser",
  "appuserid",
  "actorid",
  "userid",
  "createdby",
  "createdbyuserid",
  "createdbyappuserid",
  "creator",
  "creatorid",
  "creatoruserid",
  "creatorappuserid",
  "updatedbyappuserid",
  "withdrawnbyappuserid",
  "owner",
  "ownerid",
  "owneruserid",
  "ownerappuserid",
  "email",
  "useremail",
  "actoremail",
  "username",
  "login",
  "actor",
  "role",
  "roles",
  "capability",
  "capabilities",
  "scope",
  "scopes",
  "scopekind",
  "team",
  "teamid",
  "provider",
  "providertype",
  "effectivescope",
  "effectivescopes",
  "selfrecruitersuggestion",
  "allowedworkertabs",
  "authoritysource",
  "departmentid",
  "departmentkey",
]);

const CONTENT_SECTION_KEYS = [
  "general",
  "candidate",
  "compensation",
  "documents",
] as const;

const GENERAL_INPUT_KEYS = [
  "customer_name",
  "investment_origin",
  "manufacturing_industry",
  "job_description",
  "environment_types",
  "work_postures",
  "shift_pattern",
  "shift_details",
  "manager_name",
  "manager_phone",
  "labor_type_keys",
  "supply_schedule_text",
  "expected_headcount",
] as const;

const GENERAL_PROJECTION_KEYS = [
  "customer_name",
  "investment_origin",
  "manufacturing_industry",
  "job_description",
  "environment_types",
  "work_postures",
  "shift_pattern",
  "shift_details",
  "manager_name",
  "manager_phone",
  "labor_types",
  "supply_schedule_text",
  "expected_headcount",
] as const;

const CANDIDATE_KEYS = [
  "age_min",
  "age_max",
  "gender_requirement",
  "education_requirement",
  "experience_required",
  "experience_details",
  "accept_former_customer_workers",
  "entry_assessment_text",
  "other_requirements_text",
] as const;

const COMPENSATION_KEYS = [
  "base_salary_vnd",
  "base_salary_conditions",
  "attendance_bonus_vnd",
  "attendance_bonus_conditions",
  "living_allowance_vnd",
  "living_allowance_conditions",
  "seniority_allowance_vnd",
  "seniority_allowance_conditions",
  "eyesight_allowance_vnd",
  "eyesight_allowance_conditions",
  "other_allowance_text",
  "average_income_min_vnd",
  "average_income_max_vnd",
  "salary_payment_schedule",
  "salary_advance_available",
  "salary_advance_amount_vnd",
  "salary_advance_schedule",
  "weekly_salary_available",
  "weekly_salary_payment_schedule",
  "day_shift_8h_vnd",
  "day_shift_11h_vnd",
  "night_shift_8h_vnd",
  "night_shift_11h_vnd",
  "sunday_day_11h_vnd",
  "sunday_night_11h_vnd",
  "holiday_day_11h_vnd",
  "holiday_night_11h_vnd",
  "ppe_provided",
  "ppe_details",
  "other_benefits",
] as const;

const DOCUMENTS_KEYS = [
  "require_original_cccd_and_copy",
  "require_certified_resume",
  "require_health_certificate_within_6_months",
  "require_photo_3x4",
  "require_degree_or_certificate",
  "require_social_insurance_book",
  "require_other_documents",
  "other_documents_text",
] as const;

const VND_FIELD_KEYS = [
  "base_salary_vnd",
  "attendance_bonus_vnd",
  "living_allowance_vnd",
  "seniority_allowance_vnd",
  "eyesight_allowance_vnd",
  "average_income_min_vnd",
  "average_income_max_vnd",
  "salary_advance_amount_vnd",
  "day_shift_8h_vnd",
  "day_shift_11h_vnd",
  "night_shift_8h_vnd",
  "night_shift_11h_vnd",
  "sunday_day_11h_vnd",
  "sunday_night_11h_vnd",
  "holiday_day_11h_vnd",
  "holiday_night_11h_vnd",
] as const;

const DOCUMENT_BOOLEAN_KEYS = [
  "require_original_cccd_and_copy",
  "require_certified_resume",
  "require_health_certificate_within_6_months",
  "require_photo_3x4",
  "require_degree_or_certificate",
  "require_social_insurance_book",
  "require_other_documents",
] as const;

const ITEM_KEYS = [
  "brief_id",
  "version",
  "status",
  "project",
  "industrial_park",
  "province",
  "published_at",
  "updated_at",
  "withdrawn_at",
  "created_by_display_name",
  "updated_by_display_name",
  "withdrawn_by_display_name",
  "general",
  "candidate",
  "compensation",
  "documents",
  "allowed_actions",
] as const;

const CONTEXT_KEYS = [
  "can_create",
  "managed_projects",
  "filter_projects",
  "provinces",
  "industrial_parks",
  "labor_types",
] as const;

const LIST_KEYS = [
  "items",
  "page_size",
  "has_more",
  "next_cursor",
  "snapshot_token",
] as const;

const LIST_WITH_FACETS_KEYS = [
  "items",
  "page_size",
  "has_more",
  "next_cursor",
  "snapshot_token",
  "total_count",
  "industrial_parks",
  "labor_types",
] as const;

const INDUSTRIAL_PARK_FACET_KEYS = [
  "industrial_park_id",
  "industrial_park_code",
  "display_name",
  "active",
  "job_count",
] as const;

const LABOR_TYPE_FACET_KEYS = [
  "labor_type_key",
  "display_name",
  "job_count",
] as const;

const GET_KEYS = ["post"] as const;
const MUTATION_KEYS = ["post", "changed", "replayed"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === expectedKeys.length &&
    expectedKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(record, key),
    )
  );
}

function normalizeAuthorityKey(key: string): string {
  return key.replace(/[-_]/g, "").toLowerCase();
}

export function containsForbiddenClientAuthorityKey(
  value: unknown,
  depth = 0,
): boolean {
  if (depth > 8) return true;
  if (Array.isArray(value)) {
    return value.some((item) =>
      containsForbiddenClientAuthorityKey(item, depth + 1),
    );
  }
  if (!isPlainRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(normalizeAuthorityKey(key))) {
      return true;
    }
    if (containsForbiddenClientAuthorityKey(nested, depth + 1)) {
      return true;
    }
  }
  return false;
}

function readUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UUID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

function readProjectId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return PROJECT_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function readCatalogCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CATALOG_CODE_PATTERN.test(trimmed) ? trimmed : null;
}

function readLaborTypeKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return LABOR_TYPE_KEY_PATTERN.test(trimmed) ? trimmed : null;
}

function readNonEmptyDisplayText(
  value: unknown,
  maxLength = 256,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > maxLength ||
    CONTROL_CHAR_PATTERN.test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

function readIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return ISO_UTC_MICROS_PATTERN.test(value) ? value : null;
}

export function parseUuidParam(
  raw: unknown,
): RecruitmentPostParseResult<string> {
  const uuid = readUuid(raw);
  if (!uuid) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }
  return { ok: true, value: uuid };
}

export function parseIdempotencyKeyHeader(
  raw: string | null | undefined,
): RecruitmentPostParseResult<string> {
  if (typeof raw !== "string") {
    return { ok: false, code: "RECRUITMENT_POST_IDEMPOTENCY_INVALID" };
  }
  const uuid = readUuid(raw);
  if (!uuid) {
    return { ok: false, code: "RECRUITMENT_POST_IDEMPOTENCY_INVALID" };
  }
  return { ok: true, value: uuid };
}

export function parseNoQueryParams(
  url: URL,
): RecruitmentPostParseResult<Record<string, never>> {
  for (const _key of url.searchParams.keys()) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }
  return { ok: true, value: {} };
}

export type ListRecruitmentPostsQuery = {
  project_id: string | null;
  province_id: string | null;
  industrial_park_id: string | null;
  labor_type_key: string | null;
  updated_from: string | null;
  updated_to: string | null;
  cursor: string | null;
  snapshot_token: string | null;
  page_size: number;
  include_facets?: boolean;
};

const ALLOWED_LIST_QUERY_KEYS = new Set([
  "project_id",
  "province_id",
  "industrial_park_id",
  "labor_type_key",
  "updated_from",
  "updated_to",
  "cursor",
  "snapshot_token",
  "page_size",
  "include_facets",
]);

export function parseListRecruitmentPostsQuery(
  url: URL,
): RecruitmentPostParseResult<ListRecruitmentPostsQuery> {
  const seenKeys = new Set<string>();
  for (const [key] of url.searchParams.entries()) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(normalizeAuthorityKey(key))) {
      return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
    }
    if (!ALLOWED_LIST_QUERY_KEYS.has(key) || seenKeys.has(key)) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    seenKeys.add(key);
  }

  let project_id: string | null = null;
  const rawProjectId = url.searchParams.get("project_id");
  if (rawProjectId !== null && rawProjectId.trim() !== "") {
    project_id = readProjectId(rawProjectId);
    if (!project_id) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
  }

  let province_id: string | null = null;
  const rawProvinceId = url.searchParams.get("province_id");
  if (rawProvinceId !== null && rawProvinceId.trim() !== "") {
    province_id = readUuid(rawProvinceId);
    if (!province_id) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
  }

  let industrial_park_id: string | null = null;
  const rawIndustrialParkId = url.searchParams.get("industrial_park_id");
  if (rawIndustrialParkId !== null && rawIndustrialParkId.trim() !== "") {
    industrial_park_id = readUuid(rawIndustrialParkId);
    if (!industrial_park_id) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
  }

  let labor_type_key: string | null = null;
  const rawLaborTypeKey = url.searchParams.get("labor_type_key");
  if (rawLaborTypeKey !== null && rawLaborTypeKey.trim() !== "") {
    labor_type_key = readLaborTypeKey(rawLaborTypeKey);
    if (!labor_type_key) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
  }

  let updated_from: string | null = null;
  const rawUpdatedFrom = url.searchParams.get("updated_from");
  if (rawUpdatedFrom !== null && rawUpdatedFrom.trim() !== "") {
    const trimmed = rawUpdatedFrom.trim();
    if (!isRealCalendarDate(trimmed)) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    updated_from = trimmed;
  }

  let updated_to: string | null = null;
  const rawUpdatedTo = url.searchParams.get("updated_to");
  if (rawUpdatedTo !== null && rawUpdatedTo.trim() !== "") {
    const trimmed = rawUpdatedTo.trim();
    if (!isRealCalendarDate(trimmed)) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    updated_to = trimmed;
  }

  if (updated_from !== null && updated_to !== null && updated_from > updated_to) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }

  let page_size = DEFAULT_RECRUITMENT_POST_PAGE_SIZE;
  const rawPageSize = url.searchParams.get("page_size");
  if (rawPageSize !== null) {
    const trimmed = rawPageSize.trim();
    if (!/^\d{1,3}$/.test(trimmed)) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    const parsed = Number(trimmed);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < MIN_RECRUITMENT_POST_PAGE_SIZE ||
      parsed > MAX_RECRUITMENT_POST_PAGE_SIZE
    ) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    page_size = parsed;
  }

  let snapshot_token: string | null = null;
  const rawSnapshotToken = url.searchParams.get("snapshot_token");
  if (rawSnapshotToken !== null && rawSnapshotToken.trim() !== "") {
    const trimmed = rawSnapshotToken.trim();
    if (!RECRUITMENT_POST_SNAPSHOT_TOKEN_PATTERN.test(trimmed)) {
      return { ok: false, code: "RECRUITMENT_POST_SNAPSHOT_INVALID" };
    }
    snapshot_token = trimmed;
  }

  let cursor: string | null = null;
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && rawCursor.trim() !== "") {
    const trimmed = rawCursor.trim();
    if (!RECRUITMENT_POST_CURSOR_PATTERN.test(trimmed) || snapshot_token === null) {
      return { ok: false, code: "RECRUITMENT_POST_SNAPSHOT_INVALID" };
    }
    const tokenMatch = RECRUITMENT_POST_SNAPSHOT_TOKEN_PATTERN.exec(snapshot_token);
    const cursorMatch = RECRUITMENT_POST_CURSOR_PATTERN.exec(trimmed);
    if (
      !tokenMatch ||
      !cursorMatch ||
      tokenMatch[1] !== cursorMatch[1] ||
      tokenMatch[2] !== cursorMatch[2]
    ) {
      return { ok: false, code: "RECRUITMENT_POST_SNAPSHOT_INVALID" };
    }
    cursor = trimmed;
  }

  let include_facets = false;
  const rawIncludeFacets = url.searchParams.get("include_facets");
  if (rawIncludeFacets !== null) {
    const trimmed = rawIncludeFacets.trim();
    if (trimmed === "true") {
      include_facets = true;
    } else if (trimmed === "false") {
      include_facets = false;
    } else {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
  }

  return {
    ok: true,
    value: {
      project_id,
      province_id,
      industrial_park_id,
      labor_type_key,
      updated_from,
      updated_to,
      cursor,
      snapshot_token,
      page_size,
      include_facets,
    },
  };
}

export type ListMyRecruitmentPostsQuery = {
  cursor: string | null;
  snapshot_token: string | null;
  page_size: number;
};

const ALLOWED_LIST_MINE_QUERY_KEYS = new Set([
  "cursor",
  "snapshot_token",
  "page_size",
]);

export function parseListMyRecruitmentPostsQuery(
  url: URL,
): RecruitmentPostParseResult<ListMyRecruitmentPostsQuery> {
  const seenKeys = new Set<string>();
  for (const [key] of url.searchParams.entries()) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(normalizeAuthorityKey(key))) {
      return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
    }
    if (!ALLOWED_LIST_MINE_QUERY_KEYS.has(key) || seenKeys.has(key)) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    seenKeys.add(key);
  }

  let page_size = DEFAULT_RECRUITMENT_POST_PAGE_SIZE;
  const rawPageSize = url.searchParams.get("page_size");
  if (rawPageSize !== null) {
    const trimmed = rawPageSize.trim();
    if (!/^\d{1,3}$/.test(trimmed)) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    const parsed = Number(trimmed);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < MIN_RECRUITMENT_POST_PAGE_SIZE ||
      parsed > MAX_RECRUITMENT_POST_PAGE_SIZE
    ) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    page_size = parsed;
  }

  let snapshot_token: string | null = null;
  const rawSnapshotToken = url.searchParams.get("snapshot_token");
  if (rawSnapshotToken !== null && rawSnapshotToken.trim() !== "") {
    const trimmed = rawSnapshotToken.trim();
    if (!RECRUITMENT_POST_SNAPSHOT_TOKEN_PATTERN.test(trimmed)) {
      return { ok: false, code: "RECRUITMENT_POST_SNAPSHOT_INVALID" };
    }
    snapshot_token = trimmed;
  }

  let cursor: string | null = null;
  const rawCursor = url.searchParams.get("cursor");
  if (rawCursor !== null && rawCursor.trim() !== "") {
    const trimmed = rawCursor.trim();
    if (!RECRUITMENT_POST_CURSOR_PATTERN.test(trimmed) || snapshot_token === null) {
      return { ok: false, code: "RECRUITMENT_POST_SNAPSHOT_INVALID" };
    }
    const tokenMatch = RECRUITMENT_POST_SNAPSHOT_TOKEN_PATTERN.exec(snapshot_token);
    const cursorMatch = RECRUITMENT_POST_CURSOR_PATTERN.exec(trimmed);
    if (
      !tokenMatch ||
      !cursorMatch ||
      tokenMatch[1] !== cursorMatch[1] ||
      tokenMatch[2] !== cursorMatch[2]
    ) {
      return { ok: false, code: "RECRUITMENT_POST_SNAPSHOT_INVALID" };
    }
    cursor = trimmed;
  }

  return {
    ok: true,
    value: {
      cursor,
      snapshot_token,
      page_size,
    },
  };
}

function parseRequiredStringField(
  raw: unknown,
  maxLength: number,
): RecruitmentPostParseResult<string> {
  if (typeof raw !== "string") {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }
  const trimmed = raw.trim();
  if (
    trimmed.length < 1 ||
    trimmed.length > maxLength ||
    CONTROL_CHAR_PATTERN.test(raw)
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }
  return { ok: true, value: trimmed };
}

function parseOptionalStringField(
  raw: unknown,
  maxLength: number,
): RecruitmentPostParseResult<string | null> {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }
  if (CONTROL_CHAR_PATTERN.test(raw)) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > maxLength) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }
  return { ok: true, value: trimmed };
}

function parseOptionalVndField(
  raw: unknown,
): RecruitmentPostParseResult<string | null> {
  if (raw === null) {
    return { ok: true, value: null };
  }
  if (typeof raw !== "string") {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }
  const trimmed = raw.trim();
  if (!VND_STRING_PATTERN.test(trimmed)) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }
  if (trimmed.length > 16) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }
  const numericValue = BigInt(trimmed);
  if (
    numericValue < BigInt(0) ||
    numericValue > BigInt(RECRUITMENT_POST_MAX_SAFE_VND)
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }
  return { ok: true, value: trimmed };
}

export function parseRecruitmentPostContent(
  raw: Record<string, unknown>,
  options?: { actorDisplayName?: string; managerNameOverride?: string },
): RecruitmentPostParseResult<RecruitmentPostContentInput> {
  const general = raw.general;
  const candidate = raw.candidate;
  const compensation = raw.compensation;
  const documents = raw.documents;

  if (
    !isPlainRecord(general) ||
    !isPlainRecord(candidate) ||
    !isPlainRecord(compensation) ||
    !isPlainRecord(documents) ||
    !hasExactKeys(general, GENERAL_INPUT_KEYS) ||
    !hasExactKeys(candidate, CANDIDATE_KEYS) ||
    !hasExactKeys(compensation, COMPENSATION_KEYS) ||
    !hasExactKeys(documents, DOCUMENTS_KEYS)
  ) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }

  // Section 1: General
  const customer_name = parseRequiredStringField(general.customer_name, 256);
  if (!customer_name.ok) return customer_name;

  const investment_origin = parseOptionalStringField(
    general.investment_origin,
    128,
  );
  if (!investment_origin.ok) return investment_origin;

  const manufacturing_industry = parseOptionalStringField(
    general.manufacturing_industry,
    256,
  );
  if (!manufacturing_industry.ok) return manufacturing_industry;

  const job_description = parseRequiredStringField(
    general.job_description,
    4000,
  );
  if (!job_description.ok) return job_description;

  if (
    !Array.isArray(general.environment_types) ||
    !general.environment_types.every((item) => typeof item === "string") ||
    !Array.isArray(general.work_postures) ||
    !general.work_postures.every((item) => typeof item === "string") ||
    !Array.isArray(general.labor_type_keys) ||
    !general.labor_type_keys.every((item) => typeof item === "string")
  ) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }

  const envTypesTrimmed = general.environment_types.map((item) => item.trim());
  const envTypesSet = new Set(envTypesTrimmed);
  if (
    envTypesTrimmed.length > 3 ||
    envTypesSet.size !== envTypesTrimmed.length ||
    !envTypesTrimmed.every((item) =>
      (RECRUITMENT_POST_ENVIRONMENT_TYPES as readonly string[]).includes(item),
    )
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }
  const environment_types = [...envTypesTrimmed].sort() as RecruitmentPostEnvironmentType[];

  const posturesTrimmed = general.work_postures.map((item) => item.trim());
  const posturesSet = new Set(posturesTrimmed);
  if (
    posturesTrimmed.length > 2 ||
    posturesSet.size !== posturesTrimmed.length ||
    !posturesTrimmed.every((item) =>
      (RECRUITMENT_POST_WORK_POSTURES as readonly string[]).includes(item),
    )
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }
  const work_postures = [...posturesTrimmed].sort() as RecruitmentPostWorkPosture[];

  if (typeof general.shift_pattern !== "string") {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }
  const shift_pattern = general.shift_pattern.trim();
  if (
    !(RECRUITMENT_POST_SHIFT_PATTERNS as readonly string[]).includes(
      shift_pattern,
    )
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }

  const shift_details = parseOptionalStringField(general.shift_details, 1000);
  if (!shift_details.ok) return shift_details;
  if (shift_pattern === "OTHER" && shift_details.value === null) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }

  if (typeof general.manager_name !== "string") {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }
  if (CONTROL_CHAR_PATTERN.test(general.manager_name)) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }
  const managerNameSource =
    options?.managerNameOverride !== undefined
      ? options.managerNameOverride
      : options?.actorDisplayName !== undefined
        ? options.actorDisplayName
        : general.manager_name;
  const manager_name = parseRequiredStringField(managerNameSource, 256);
  if (!manager_name.ok) return manager_name;

  if (typeof general.manager_phone !== "string") {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }
  const manager_phone = general.manager_phone.trim();
  const phoneDigits = manager_phone.replace(/[^0-9]/g, "");
  if (
    CONTROL_CHAR_PATTERN.test(general.manager_phone) ||
    !MANAGER_PHONE_PATTERN.test(manager_phone) ||
    phoneDigits.length < 6
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }

  const laborKeysTrimmed = general.labor_type_keys.map((item) => item.trim());
  const laborKeysSet = new Set(laborKeysTrimmed);
  if (
    laborKeysTrimmed.length < 1 ||
    laborKeysTrimmed.length > 64 ||
    laborKeysSet.size !== laborKeysTrimmed.length ||
    !laborKeysTrimmed.every((item) => LABOR_TYPE_KEY_PATTERN.test(item))
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }
  const labor_type_keys = [...laborKeysTrimmed].sort();

  const supply_schedule_text = parseOptionalStringField(
    general.supply_schedule_text,
    1000,
  );
  if (!supply_schedule_text.ok) return supply_schedule_text;

  let expected_headcount: number | null = null;
  if (general.expected_headcount !== null) {
    if (
      typeof general.expected_headcount !== "number" ||
      !Number.isSafeInteger(general.expected_headcount)
    ) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    if (
      general.expected_headcount < 0 ||
      general.expected_headcount > RECRUITMENT_POST_MAX_EXPECTED_HEADCOUNT
    ) {
      return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
    }
    expected_headcount = general.expected_headcount;
  }

  // Section 2: Candidate
  let age_min: number | null = null;
  if (candidate.age_min !== null) {
    if (
      typeof candidate.age_min !== "number" ||
      !Number.isSafeInteger(candidate.age_min)
    ) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    if (
      candidate.age_min < RECRUITMENT_POST_AGE_MIN ||
      candidate.age_min > RECRUITMENT_POST_AGE_MAX
    ) {
      return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
    }
    age_min = candidate.age_min;
  }

  let age_max: number | null = null;
  if (candidate.age_max !== null) {
    if (
      typeof candidate.age_max !== "number" ||
      !Number.isSafeInteger(candidate.age_max)
    ) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    if (
      candidate.age_max < RECRUITMENT_POST_AGE_MIN ||
      candidate.age_max > RECRUITMENT_POST_AGE_MAX
    ) {
      return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
    }
    age_max = candidate.age_max;
  }

  if (age_min !== null && age_max !== null && age_max < age_min) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }

  if (
    typeof candidate.gender_requirement !== "string" ||
    typeof candidate.education_requirement !== "string" ||
    typeof candidate.experience_required !== "boolean" ||
    typeof candidate.accept_former_customer_workers !== "boolean"
  ) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }

  const gender_requirement = candidate.gender_requirement.trim();
  if (
    !(RECRUITMENT_POST_GENDER_REQUIREMENTS as readonly string[]).includes(
      gender_requirement,
    )
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }

  const education_requirement = candidate.education_requirement.trim();
  if (
    !(RECRUITMENT_POST_EDUCATION_REQUIREMENTS as readonly string[]).includes(
      education_requirement,
    )
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }

  const experience_details = parseOptionalStringField(
    candidate.experience_details,
    1000,
  );
  if (!experience_details.ok) return experience_details;

  if (
    (candidate.experience_required && experience_details.value === null) ||
    (!candidate.experience_required && experience_details.value !== null)
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }

  const entry_assessment_text = parseOptionalStringField(
    candidate.entry_assessment_text,
    1000,
  );
  if (!entry_assessment_text.ok) return entry_assessment_text;

  const other_requirements_text = parseOptionalStringField(
    candidate.other_requirements_text,
    2000,
  );
  if (!other_requirements_text.ok) return other_requirements_text;

  // Section 3: Compensation
  if (
    typeof compensation.salary_advance_available !== "boolean" ||
    typeof compensation.weekly_salary_available !== "boolean" ||
    typeof compensation.ppe_provided !== "boolean"
  ) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }

  const parsedVnd: Record<string, string | null> = {};
  for (const key of VND_FIELD_KEYS) {
    const res = parseOptionalVndField(compensation[key]);
    if (!res.ok) return res;
    parsedVnd[key] = res.value;
  }

  if (
    parsedVnd.average_income_min_vnd !== null &&
    parsedVnd.average_income_max_vnd !== null &&
    BigInt(parsedVnd.average_income_max_vnd) <
      BigInt(parsedVnd.average_income_min_vnd)
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }

  const base_salary_conditions = parseOptionalStringField(
    compensation.base_salary_conditions,
    1000,
  );
  if (!base_salary_conditions.ok) return base_salary_conditions;

  const attendance_bonus_conditions = parseOptionalStringField(
    compensation.attendance_bonus_conditions,
    1000,
  );
  if (!attendance_bonus_conditions.ok) return attendance_bonus_conditions;

  const living_allowance_conditions = parseOptionalStringField(
    compensation.living_allowance_conditions,
    1000,
  );
  if (!living_allowance_conditions.ok) return living_allowance_conditions;

  const seniority_allowance_conditions = parseOptionalStringField(
    compensation.seniority_allowance_conditions,
    1000,
  );
  if (!seniority_allowance_conditions.ok) return seniority_allowance_conditions;

  const eyesight_allowance_conditions = parseOptionalStringField(
    compensation.eyesight_allowance_conditions,
    1000,
  );
  if (!eyesight_allowance_conditions.ok) return eyesight_allowance_conditions;

  const other_allowance_text = parseOptionalStringField(
    compensation.other_allowance_text,
    2000,
  );
  if (!other_allowance_text.ok) return other_allowance_text;

  const salary_payment_schedule = parseOptionalStringField(
    compensation.salary_payment_schedule,
    500,
  );
  if (!salary_payment_schedule.ok) return salary_payment_schedule;

  const salary_advance_schedule = parseOptionalStringField(
    compensation.salary_advance_schedule,
    500,
  );
  if (!salary_advance_schedule.ok) return salary_advance_schedule;

  const weekly_salary_payment_schedule = parseOptionalStringField(
    compensation.weekly_salary_payment_schedule,
    500,
  );
  if (!weekly_salary_payment_schedule.ok) return weekly_salary_payment_schedule;

  const ppe_details = parseOptionalStringField(compensation.ppe_details, 1000);
  if (!ppe_details.ok) return ppe_details;

  const other_benefits = parseOptionalStringField(
    compensation.other_benefits,
    2000,
  );
  if (!other_benefits.ok) return other_benefits;

  if (
    !compensation.salary_advance_available &&
    (parsedVnd.salary_advance_amount_vnd !== null ||
      salary_advance_schedule.value !== null)
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }

  if (
    !compensation.weekly_salary_available &&
    weekly_salary_payment_schedule.value !== null
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }

  // Section 4: Documents
  for (const key of DOCUMENT_BOOLEAN_KEYS) {
    if (typeof documents[key] !== "boolean") {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
  }

  const other_documents_text = parseOptionalStringField(
    documents.other_documents_text,
    1000,
  );
  if (!other_documents_text.ok) return other_documents_text;

  if (
    (documents.require_other_documents === true &&
      other_documents_text.value === null) ||
    (documents.require_other_documents === false &&
      other_documents_text.value !== null)
  ) {
    return { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" };
  }

  return {
    ok: true,
    value: {
      general: {
        customer_name: customer_name.value,
        investment_origin: investment_origin.value,
        manufacturing_industry: manufacturing_industry.value,
        job_description: job_description.value,
        environment_types,
        work_postures,
        shift_pattern: shift_pattern as RecruitmentPostShiftPattern,
        shift_details: shift_details.value,
        manager_name: manager_name.value,
        manager_phone,
        labor_type_keys,
        supply_schedule_text: supply_schedule_text.value,
        expected_headcount,
      },
      candidate: {
        age_min,
        age_max,
        gender_requirement:
          gender_requirement as RecruitmentPostGenderRequirement,
        education_requirement:
          education_requirement as RecruitmentPostEducationRequirement,
        experience_required: candidate.experience_required,
        experience_details: experience_details.value,
        accept_former_customer_workers:
          candidate.accept_former_customer_workers,
        entry_assessment_text: entry_assessment_text.value,
        other_requirements_text: other_requirements_text.value,
      },
      compensation: {
        base_salary_vnd: parsedVnd.base_salary_vnd,
        base_salary_conditions: base_salary_conditions.value,
        attendance_bonus_vnd: parsedVnd.attendance_bonus_vnd,
        attendance_bonus_conditions: attendance_bonus_conditions.value,
        living_allowance_vnd: parsedVnd.living_allowance_vnd,
        living_allowance_conditions: living_allowance_conditions.value,
        seniority_allowance_vnd: parsedVnd.seniority_allowance_vnd,
        seniority_allowance_conditions: seniority_allowance_conditions.value,
        eyesight_allowance_vnd: parsedVnd.eyesight_allowance_vnd,
        eyesight_allowance_conditions: eyesight_allowance_conditions.value,
        other_allowance_text: other_allowance_text.value,
        average_income_min_vnd: parsedVnd.average_income_min_vnd,
        average_income_max_vnd: parsedVnd.average_income_max_vnd,
        salary_payment_schedule: salary_payment_schedule.value,
        salary_advance_available: compensation.salary_advance_available,
        salary_advance_amount_vnd: parsedVnd.salary_advance_amount_vnd,
        salary_advance_schedule: salary_advance_schedule.value,
        weekly_salary_available: compensation.weekly_salary_available,
        weekly_salary_payment_schedule: weekly_salary_payment_schedule.value,
        day_shift_8h_vnd: parsedVnd.day_shift_8h_vnd,
        day_shift_11h_vnd: parsedVnd.day_shift_11h_vnd,
        night_shift_8h_vnd: parsedVnd.night_shift_8h_vnd,
        night_shift_11h_vnd: parsedVnd.night_shift_11h_vnd,
        sunday_day_11h_vnd: parsedVnd.sunday_day_11h_vnd,
        sunday_night_11h_vnd: parsedVnd.sunday_night_11h_vnd,
        holiday_day_11h_vnd: parsedVnd.holiday_day_11h_vnd,
        holiday_night_11h_vnd: parsedVnd.holiday_night_11h_vnd,
        ppe_provided: compensation.ppe_provided,
        ppe_details: ppe_details.value,
        other_benefits: other_benefits.value,
      },
      documents: {
        require_original_cccd_and_copy:
          documents.require_original_cccd_and_copy as boolean,
        require_certified_resume: documents.require_certified_resume as boolean,
        require_health_certificate_within_6_months:
          documents.require_health_certificate_within_6_months as boolean,
        require_photo_3x4: documents.require_photo_3x4 as boolean,
        require_degree_or_certificate:
          documents.require_degree_or_certificate as boolean,
        require_social_insurance_book:
          documents.require_social_insurance_book as boolean,
        require_other_documents: documents.require_other_documents as boolean,
        other_documents_text: other_documents_text.value,
      },
    },
  };
}

export type CreateRecruitmentPostRequest = {
  project_id: string;
  industrial_park_id: string;
  content: RecruitmentPostContentInput;
  rpc_payload: {
    project_id: string;
    industrial_park_id: string;
    general: RecruitmentPostGeneralInput;
    candidate: RecruitmentPostCandidateSection;
    compensation: RecruitmentPostCompensationSection;
    documents: RecruitmentPostDocumentsSection;
  };
};

export function parseCreateRecruitmentPostBody(
  body: unknown,
  options?: { actorDisplayName?: string },
): RecruitmentPostParseResult<CreateRecruitmentPostRequest> {
  if (containsForbiddenClientAuthorityKey(body)) {
    return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  }
  if (!isPlainRecord(body)) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }

  const isNestedContent = hasExactKeys(body, [
    "project_id",
    "industrial_park_id",
    "content",
  ]);
  const isFlatSections = hasExactKeys(body, [
    "project_id",
    "industrial_park_id",
    ...CONTENT_SECTION_KEYS,
  ]);

  if (!isNestedContent && !isFlatSections) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }

  const project_id = readProjectId(body.project_id);
  const industrial_park_id = readUuid(body.industrial_park_id);
  if (!project_id || !industrial_park_id) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }

  let rawContent: Record<string, unknown>;
  if (isNestedContent) {
    if (
      !isPlainRecord(body.content) ||
      !hasExactKeys(body.content, CONTENT_SECTION_KEYS)
    ) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    rawContent = body.content;
  } else {
    rawContent = body;
  }

  const parsedContent = parseRecruitmentPostContent(rawContent, options);
  if (!parsedContent.ok) return parsedContent;

  return {
    ok: true,
    value: {
      project_id,
      industrial_park_id,
      content: parsedContent.value,
      rpc_payload: {
        project_id,
        industrial_park_id,
        ...parsedContent.value,
      },
    },
  };
}

export type UpdateRecruitmentPostRequest = {
  expected_version: number;
  content: RecruitmentPostContentInput;
  rpc_payload: RecruitmentPostContentInput;
};

export function parseUpdateRecruitmentPostBody(
  body: unknown,
  options?: { managerNameOverride?: string },
): RecruitmentPostParseResult<UpdateRecruitmentPostRequest> {
  if (containsForbiddenClientAuthorityKey(body)) {
    return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  }
  if (!isPlainRecord(body)) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }

  const isNestedContent = hasExactKeys(body, ["expected_version", "content"]);
  const isFlatSections = hasExactKeys(body, [
    "expected_version",
    ...CONTENT_SECTION_KEYS,
  ]);

  if (!isNestedContent && !isFlatSections) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }

  if (
    typeof body.expected_version !== "number" ||
    !Number.isSafeInteger(body.expected_version) ||
    body.expected_version < 1
  ) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }

  let rawContent: Record<string, unknown>;
  if (isNestedContent) {
    if (
      !isPlainRecord(body.content) ||
      !hasExactKeys(body.content, CONTENT_SECTION_KEYS)
    ) {
      return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
    }
    rawContent = body.content;
  } else {
    rawContent = body;
  }

  const parsedContent = parseRecruitmentPostContent(rawContent, options);
  if (!parsedContent.ok) return parsedContent;

  return {
    ok: true,
    value: {
      expected_version: body.expected_version,
      content: parsedContent.value,
      rpc_payload: parsedContent.value,
    },
  };
}

export type WithdrawRecruitmentPostRequest = {
  expected_version: number;
};

export function parseWithdrawRecruitmentPostBody(
  body: unknown,
): RecruitmentPostParseResult<WithdrawRecruitmentPostRequest> {
  if (containsForbiddenClientAuthorityKey(body)) {
    return { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" };
  }
  if (
    !isPlainRecord(body) ||
    !hasExactKeys(body, ["expected_version"]) ||
    typeof body.expected_version !== "number" ||
    !Number.isSafeInteger(body.expected_version) ||
    body.expected_version < 1
  ) {
    return { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" };
  }
  return {
    ok: true,
    value: { expected_version: body.expected_version },
  };
}

function projectProjectOption(raw: unknown): RecruitmentPostProjectOption | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, ["project_id", "display_name"])
  ) {
    return null;
  }
  const project_id = readProjectId(raw.project_id);
  const display_name = readNonEmptyDisplayText(raw.display_name, 256);
  if (!project_id || !display_name) return null;
  return { project_id, display_name };
}

function projectProvinceOption(
  raw: unknown,
): RecruitmentPostProvinceOption | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, [
      "province_id",
      "province_code",
      "display_name",
      "active",
    ]) ||
    typeof raw.active !== "boolean"
  ) {
    return null;
  }
  const province_id = readUuid(raw.province_id);
  const province_code = readCatalogCode(raw.province_code);
  const display_name = readNonEmptyDisplayText(raw.display_name, 256);
  if (!province_id || !province_code || !display_name) return null;
  return {
    province_id,
    province_code,
    display_name,
    active: raw.active,
  };
}

function projectIndustrialParkOption(
  raw: unknown,
): RecruitmentPostIndustrialParkOption | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, [
      "industrial_park_id",
      "industrial_park_code",
      "province_id",
      "display_name",
      "active",
    ]) ||
    typeof raw.active !== "boolean"
  ) {
    return null;
  }
  const industrial_park_id = readUuid(raw.industrial_park_id);
  const industrial_park_code = readCatalogCode(raw.industrial_park_code);
  const province_id = readUuid(raw.province_id);
  const display_name = readNonEmptyDisplayText(raw.display_name, 256);
  if (
    !industrial_park_id ||
    !industrial_park_code ||
    !province_id ||
    !display_name
  ) {
    return null;
  }
  return {
    industrial_park_id,
    industrial_park_code,
    province_id,
    display_name,
    active: raw.active,
  };
}

function projectLaborTypeOption(
  raw: unknown,
): RecruitmentPostLaborTypeOption | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, ["labor_type_key", "display_name", "active"]) ||
    typeof raw.active !== "boolean"
  ) {
    return null;
  }
  const labor_type_key = readLaborTypeKey(raw.labor_type_key);
  const display_name = readNonEmptyDisplayText(raw.display_name, 256);
  if (!labor_type_key || !display_name) return null;
  return {
    labor_type_key,
    display_name,
    active: raw.active,
  };
}

export function projectRecruitmentPostContext(
  raw: unknown,
): RecruitmentPostContext | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, CONTEXT_KEYS) ||
    typeof raw.can_create !== "boolean" ||
    !Array.isArray(raw.managed_projects) ||
    !Array.isArray(raw.filter_projects) ||
    !Array.isArray(raw.provinces) ||
    !Array.isArray(raw.industrial_parks) ||
    !Array.isArray(raw.labor_types)
  ) {
    return null;
  }

  const managed_projects: RecruitmentPostProjectOption[] = [];
  for (const item of raw.managed_projects) {
    const projected = projectProjectOption(item);
    if (!projected) return null;
    managed_projects.push(projected);
  }

  const filter_projects: RecruitmentPostProjectOption[] = [];
  for (const item of raw.filter_projects) {
    const projected = projectProjectOption(item);
    if (!projected) return null;
    filter_projects.push(projected);
  }

  const provinces: RecruitmentPostProvinceOption[] = [];
  for (const item of raw.provinces) {
    const projected = projectProvinceOption(item);
    if (!projected) return null;
    provinces.push(projected);
  }

  const industrial_parks: RecruitmentPostIndustrialParkOption[] = [];
  for (const item of raw.industrial_parks) {
    const projected = projectIndustrialParkOption(item);
    if (!projected) return null;
    industrial_parks.push(projected);
  }

  const labor_types: RecruitmentPostLaborTypeOption[] = [];
  for (const item of raw.labor_types) {
    const projected = projectLaborTypeOption(item);
    if (!projected) return null;
    labor_types.push(projected);
  }

  return {
    can_create: raw.can_create,
    managed_projects,
    filter_projects,
    provinces,
    industrial_parks,
    labor_types,
  };
}

export function projectRecruitmentPostItem(
  raw: unknown,
): RecruitmentPostItem | null {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, ITEM_KEYS)) {
    return null;
  }

  const brief_id = readUuid(raw.brief_id);
  const version =
    typeof raw.version === "number" &&
    Number.isSafeInteger(raw.version) &&
    raw.version >= 1
      ? raw.version
      : null;
  const status =
    raw.status === "PUBLISHED" || raw.status === "WITHDRAWN"
      ? raw.status
      : null;

  if (
    !brief_id ||
    version === null ||
    !status ||
    !isPlainRecord(raw.project) ||
    !hasExactKeys(raw.project, ["project_id", "display_name"]) ||
    !isPlainRecord(raw.industrial_park) ||
    !hasExactKeys(raw.industrial_park, [
      "industrial_park_id",
      "industrial_park_code",
      "display_name",
      "active",
    ]) ||
    typeof raw.industrial_park.active !== "boolean" ||
    !isPlainRecord(raw.province) ||
    !hasExactKeys(raw.province, [
      "province_id",
      "province_code",
      "display_name",
    ]) ||
    !isPlainRecord(raw.general) ||
    !hasExactKeys(raw.general, GENERAL_PROJECTION_KEYS) ||
    !isPlainRecord(raw.candidate) ||
    !hasExactKeys(raw.candidate, CANDIDATE_KEYS) ||
    !isPlainRecord(raw.compensation) ||
    !hasExactKeys(raw.compensation, COMPENSATION_KEYS) ||
    !isPlainRecord(raw.documents) ||
    !hasExactKeys(raw.documents, DOCUMENTS_KEYS) ||
    !isPlainRecord(raw.allowed_actions) ||
    !hasExactKeys(raw.allowed_actions, ["can_edit", "can_withdraw"]) ||
    typeof raw.allowed_actions.can_edit !== "boolean" ||
    typeof raw.allowed_actions.can_withdraw !== "boolean"
  ) {
    return null;
  }

  const project_id = readProjectId(raw.project.project_id);
  const project_display_name = readNonEmptyDisplayText(
    raw.project.display_name,
    256,
  );
  const industrial_park_id = readUuid(raw.industrial_park.industrial_park_id);
  const industrial_park_code = readCatalogCode(
    raw.industrial_park.industrial_park_code,
  );
  const park_display_name = readNonEmptyDisplayText(
    raw.industrial_park.display_name,
    256,
  );
  const province_id = readUuid(raw.province.province_id);
  const province_code = readCatalogCode(raw.province.province_code);
  const province_display_name = readNonEmptyDisplayText(
    raw.province.display_name,
    256,
  );

  const published_at = readIsoTimestamp(raw.published_at);
  const updated_at = readIsoTimestamp(raw.updated_at);
  const withdrawn_at =
    raw.withdrawn_at === null ? null : readIsoTimestamp(raw.withdrawn_at);

  const created_by_display_name = readNonEmptyDisplayText(
    raw.created_by_display_name,
    256,
  );
  const updated_by_display_name = readNonEmptyDisplayText(
    raw.updated_by_display_name,
    256,
  );
  const withdrawn_by_display_name =
    raw.withdrawn_by_display_name === null
      ? null
      : readNonEmptyDisplayText(raw.withdrawn_by_display_name, 256);

  if (
    !project_id ||
    !project_display_name ||
    !industrial_park_id ||
    !industrial_park_code ||
    !park_display_name ||
    !province_id ||
    !province_code ||
    !province_display_name ||
    !published_at ||
    !updated_at ||
    (raw.withdrawn_at !== null && !withdrawn_at) ||
    !created_by_display_name ||
    !updated_by_display_name ||
    (raw.withdrawn_by_display_name !== null && !withdrawn_by_display_name)
  ) {
    return null;
  }

  if (!Array.isArray(raw.general.labor_types) || raw.general.labor_types.length < 1) {
    return null;
  }
  const labor_types: Array<{ labor_type_key: string; display_name: string }> =
    [];
  for (const lt of raw.general.labor_types) {
    if (
      !isPlainRecord(lt) ||
      !hasExactKeys(lt, ["labor_type_key", "display_name"])
    ) {
      return null;
    }
    const key = readLaborTypeKey(lt.labor_type_key);
    const name = readNonEmptyDisplayText(lt.display_name, 256);
    if (!key || !name) return null;
    labor_types.push({ labor_type_key: key, display_name: name });
  }

  const parsedContent = parseRecruitmentPostContent({
    general: {
      customer_name: raw.general.customer_name,
      investment_origin: raw.general.investment_origin,
      manufacturing_industry: raw.general.manufacturing_industry,
      job_description: raw.general.job_description,
      environment_types: raw.general.environment_types,
      work_postures: raw.general.work_postures,
      shift_pattern: raw.general.shift_pattern,
      shift_details: raw.general.shift_details,
      manager_name: raw.general.manager_name,
      manager_phone: raw.general.manager_phone,
      labor_type_keys: labor_types.map((lt) => lt.labor_type_key),
      supply_schedule_text: raw.general.supply_schedule_text,
      expected_headcount: raw.general.expected_headcount,
    },
    candidate: raw.candidate,
    compensation: raw.compensation,
    documents: raw.documents,
  });

  if (!parsedContent.ok) {
    return null;
  }

  const generalWithoutKeys = {
    customer_name: parsedContent.value.general.customer_name,
    investment_origin: parsedContent.value.general.investment_origin,
    manufacturing_industry: parsedContent.value.general.manufacturing_industry,
    job_description: parsedContent.value.general.job_description,
    environment_types: parsedContent.value.general.environment_types,
    work_postures: parsedContent.value.general.work_postures,
    shift_pattern: parsedContent.value.general.shift_pattern,
    shift_details: parsedContent.value.general.shift_details,
    manager_name: parsedContent.value.general.manager_name,
    manager_phone: parsedContent.value.general.manager_phone,
    supply_schedule_text: parsedContent.value.general.supply_schedule_text,
    expected_headcount: parsedContent.value.general.expected_headcount,
  };

  return {
    brief_id,
    version,
    status,
    project: {
      project_id,
      display_name: project_display_name,
    },
    industrial_park: {
      industrial_park_id,
      industrial_park_code,
      display_name: park_display_name,
      active: raw.industrial_park.active,
    },
    province: {
      province_id,
      province_code,
      display_name: province_display_name,
    },
    published_at,
    updated_at,
    withdrawn_at,
    created_by_display_name,
    updated_by_display_name,
    withdrawn_by_display_name,
    general: {
      ...generalWithoutKeys,
      labor_types,
    },
    candidate: parsedContent.value.candidate,
    compensation: parsedContent.value.compensation,
    documents: parsedContent.value.documents,
    allowed_actions: {
      can_edit: raw.allowed_actions.can_edit,
      can_withdraw: raw.allowed_actions.can_withdraw,
    },
  };
}

export function projectRecruitmentPostList(
  raw: unknown,
): RecruitmentPostList | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, LIST_KEYS) ||
    !Array.isArray(raw.items) ||
    typeof raw.page_size !== "number" ||
    !Number.isSafeInteger(raw.page_size) ||
    raw.page_size < MIN_RECRUITMENT_POST_PAGE_SIZE ||
    raw.page_size > MAX_RECRUITMENT_POST_PAGE_SIZE ||
    typeof raw.has_more !== "boolean" ||
    typeof raw.snapshot_token !== "string" ||
    !RECRUITMENT_POST_SNAPSHOT_TOKEN_PATTERN.test(raw.snapshot_token)
  ) {
    return null;
  }

  const next_cursor =
    raw.next_cursor === null
      ? null
      : typeof raw.next_cursor === "string" &&
          RECRUITMENT_POST_CURSOR_PATTERN.test(raw.next_cursor)
        ? raw.next_cursor
        : undefined;
  if (next_cursor === undefined) return null;
  if (raw.has_more && next_cursor === null) return null;
  if (!raw.has_more && next_cursor !== null) return null;

  const items: RecruitmentPostItem[] = [];
  for (const item of raw.items) {
    const projected = projectRecruitmentPostItem(item);
    if (!projected) return null;
    items.push(projected);
  }

  return {
    items,
    page_size: raw.page_size,
    has_more: raw.has_more,
    next_cursor,
    snapshot_token: raw.snapshot_token,
  };
}

const VIETNAMESE_COLLATOR = new Intl.Collator("vi");

export function compareRecruitmentPostIndustrialParkFacets(
  a: Pick<
    RecruitmentPostIndustrialParkFacet,
    "display_name" | "industrial_park_code" | "industrial_park_id"
  >,
  b: Pick<
    RecruitmentPostIndustrialParkFacet,
    "display_name" | "industrial_park_code" | "industrial_park_id"
  >,
): number {
  const byName = VIETNAMESE_COLLATOR.compare(a.display_name, b.display_name);
  if (byName !== 0) {
    return byName;
  }
  if (a.industrial_park_code !== b.industrial_park_code) {
    return a.industrial_park_code < b.industrial_park_code ? -1 : 1;
  }
  if (a.industrial_park_id !== b.industrial_park_id) {
    return a.industrial_park_id < b.industrial_park_id ? -1 : 1;
  }
  return 0;
}

export function projectRecruitmentPostIndustrialParkFacet(
  raw: unknown,
): RecruitmentPostIndustrialParkFacet | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, INDUSTRIAL_PARK_FACET_KEYS) ||
    raw.active !== true ||
    typeof raw.job_count !== "number" ||
    !Number.isSafeInteger(raw.job_count) ||
    raw.job_count < 1
  ) {
    return null;
  }
  const industrial_park_id = readUuid(raw.industrial_park_id);
  const industrial_park_code = readCatalogCode(raw.industrial_park_code);
  const display_name = readNonEmptyDisplayText(raw.display_name, 256);
  if (!industrial_park_id || !industrial_park_code || !display_name) {
    return null;
  }
  return {
    industrial_park_id,
    industrial_park_code,
    display_name,
    active: true,
    job_count: raw.job_count,
  };
}

export function projectRecruitmentPostLaborTypeFacet(
  raw: unknown,
): RecruitmentPostLaborTypeFacet | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, LABOR_TYPE_FACET_KEYS) ||
    typeof raw.job_count !== "number" ||
    !Number.isSafeInteger(raw.job_count) ||
    raw.job_count < 1
  ) {
    return null;
  }
  const labor_type_key = readLaborTypeKey(raw.labor_type_key);
  const display_name = readNonEmptyDisplayText(raw.display_name, 256);
  if (!labor_type_key || !display_name) {
    return null;
  }
  return {
    labor_type_key,
    display_name,
    job_count: raw.job_count,
  };
}

export function projectRecruitmentPostListWithFacets(
  raw: unknown,
): RecruitmentPostListWithFacets | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, LIST_WITH_FACETS_KEYS) ||
    typeof raw.total_count !== "number" ||
    !Number.isSafeInteger(raw.total_count) ||
    raw.total_count < 0 ||
    !Array.isArray(raw.industrial_parks) ||
    !Array.isArray(raw.labor_types)
  ) {
    return null;
  }

  const base = projectRecruitmentPostList({
    items: raw.items,
    page_size: raw.page_size,
    has_more: raw.has_more,
    next_cursor: raw.next_cursor,
    snapshot_token: raw.snapshot_token,
  });
  if (!base) return null;

  const industrial_parks: RecruitmentPostIndustrialParkFacet[] = [];
  const seenParkIds = new Set<string>();
  let sumParkJobs = 0;
  for (const item of raw.industrial_parks) {
    const projected = projectRecruitmentPostIndustrialParkFacet(item);
    if (!projected || seenParkIds.has(projected.industrial_park_id)) {
      return null;
    }
    seenParkIds.add(projected.industrial_park_id);
    sumParkJobs += projected.job_count;
    industrial_parks.push(projected);
  }
  industrial_parks.sort(compareRecruitmentPostIndustrialParkFacets);

  const labor_types: RecruitmentPostLaborTypeFacet[] = [];
  const seenLaborKeys = new Set<string>();
  let sumLaborJobs = 0;
  for (const item of raw.labor_types) {
    const projected = projectRecruitmentPostLaborTypeFacet(item);
    if (
      !projected ||
      seenLaborKeys.has(projected.labor_type_key) ||
      projected.job_count > raw.total_count
    ) {
      return null;
    }
    seenLaborKeys.add(projected.labor_type_key);
    sumLaborJobs += projected.job_count;
    labor_types.push(projected);
  }

  if (raw.total_count === 0) {
    if (industrial_parks.length !== 0 || labor_types.length !== 0) {
      return null;
    }
  } else {
    if (
      industrial_parks.length === 0 ||
      labor_types.length === 0 ||
      sumParkJobs !== raw.total_count ||
      sumLaborJobs < raw.total_count
    ) {
      return null;
    }
  }

  return {
    ...base,
    total_count: raw.total_count,
    industrial_parks,
    labor_types,
  };
}

export function projectRecruitmentPostGet(
  raw: unknown,
): RecruitmentPostGetResult | null {
  if (!isPlainRecord(raw) || !hasExactKeys(raw, GET_KEYS)) {
    return null;
  }
  const post = projectRecruitmentPostItem(raw.post);
  if (!post) return null;
  return { post };
}

export function projectRecruitmentPostMutation(
  raw: unknown,
): RecruitmentPostMutationResult | null {
  if (
    !isPlainRecord(raw) ||
    !hasExactKeys(raw, MUTATION_KEYS) ||
    typeof raw.changed !== "boolean" ||
    typeof raw.replayed !== "boolean"
  ) {
    return null;
  }
  const post = projectRecruitmentPostItem(raw.post);
  if (!post) return null;
  return {
    post,
    changed: raw.changed,
    replayed: raw.replayed,
  };
}

export const PUBLIC_JOBS_FEED_V1_SCHEMA_VERSION = 1 as const;

export const PUBLIC_JOBS_FEED_V1_TOP_KEYS = Object.freeze([
  "schema_version",
  "jobs",
] as const);

export const PUBLIC_JOBS_FEED_V1_ITEM_KEYS = Object.freeze([
  "id",
  "brief_id",
  "version",
  "published_at",
  "updated_at",
  "location",
  "general",
  "candidate",
  "compensation",
  "documents",
] as const);

export const PUBLIC_JOBS_FEED_V1_LOCATION_KEYS = Object.freeze([
  "province_code",
  "province_name",
  "industrial_park_code",
  "industrial_park_name",
] as const);

export const PUBLIC_JOBS_FEED_V1_GENERAL_KEYS = Object.freeze([
  "customer_name",
  "investment_origin",
  "manufacturing_industry",
  "job_description",
  "environment_types",
  "work_postures",
  "shift_pattern",
  "shift_details",
  "labor_types",
  "supply_schedule_text",
  "expected_headcount",
] as const);

export const PUBLIC_JOBS_FEED_V1_CANDIDATE_KEYS = Object.freeze([
  "age_min",
  "age_max",
  "gender_requirement",
  "gender_label",
  "education_requirement",
  "experience_required",
  "experience_details",
  "accept_former_customer_workers",
  "entry_assessment_text",
  "other_requirements_text",
] as const);

export const PUBLIC_JOBS_FEED_V1_FORBIDDEN_INTERNAL_KEYS = Object.freeze([
  "manager_name",
  "manager_phone",
  "project",
  "project_id",
  "industrial_park_id",
  "province_id",
  "created_by_app_user_id",
  "created_by_display_name",
  "updated_by_app_user_id",
  "updated_by_display_name",
  "withdrawn_by_app_user_id",
  "withdrawn_by_display_name",
  "withdrawn_at",
  "allowed_actions",
  "can_edit",
  "can_withdraw",
] as const);

const DEFAULT_PUBLIC_FEED_GENDER_LABELS: Readonly<
  Record<RecruitmentPostGenderRequirement, string>
> = Object.freeze({
  FEMALE: "Nữ",
  MALE: "Nam",
  ANY: "Nam/Nữ",
});

export type RecruitmentPostPublicJobLocationV1 = {
  province_code: string;
  province_name: string;
  industrial_park_code: string;
  industrial_park_name: string;
};

export type RecruitmentPostPublicJobGeneralV1 = {
  customer_name: string;
  investment_origin: string | null;
  manufacturing_industry: string | null;
  job_description: string;
  environment_types: RecruitmentPostEnvironmentType[];
  work_postures: RecruitmentPostWorkPosture[];
  shift_pattern: RecruitmentPostShiftPattern;
  shift_details: string | null;
  labor_types: Array<{
    labor_type_key: string;
    display_name: string;
  }>;
  supply_schedule_text: string | null;
  expected_headcount: number | null;
};

export type RecruitmentPostPublicJobCandidateV1 =
  RecruitmentPostCandidateSection & {
    gender_label: string;
  };

export type RecruitmentPostPublicJobItemV1 = {
  id: string;
  brief_id: string;
  version: number;
  published_at: string;
  updated_at: string;
  location: RecruitmentPostPublicJobLocationV1;
  general: RecruitmentPostPublicJobGeneralV1;
  candidate: RecruitmentPostPublicJobCandidateV1;
  compensation: RecruitmentPostCompensationSection;
  documents: RecruitmentPostDocumentsSection;
};

export type RecruitmentPostPublicFeedV1 = {
  schema_version: typeof PUBLIC_JOBS_FEED_V1_SCHEMA_VERSION;
  jobs: RecruitmentPostPublicJobItemV1[];
};

const FORBIDDEN_INTERNAL_KEY_SET = new Set<string>(
  PUBLIC_JOBS_FEED_V1_FORBIDDEN_INTERNAL_KEYS,
);

function containsForbiddenPublicFeedKey(
  value: unknown,
  depth = 0,
): boolean {
  if (depth > 8 || value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenPublicFeedKey(item, depth + 1));
  }
  if (!isPlainRecord(value)) {
    return true;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (
      FORBIDDEN_INTERNAL_KEY_SET.has(key) ||
      FORBIDDEN_AUTHORITY_KEYS.has(normalizeAuthorityKey(key))
    ) {
      return true;
    }
    if (containsForbiddenPublicFeedKey(nested, depth + 1)) {
      return true;
    }
  }
  return false;
}

export function projectRecruitmentPostPublicJobItemV1(
  raw: unknown,
  genderLabels: Readonly<
    Record<RecruitmentPostGenderRequirement, string>
  > = DEFAULT_PUBLIC_FEED_GENDER_LABELS,
): RecruitmentPostPublicJobItemV1 | null {
  if (
    !isPlainRecord(raw) ||
    containsForbiddenPublicFeedKey(raw) ||
    !hasExactKeys(raw, PUBLIC_JOBS_FEED_V1_ITEM_KEYS)
  ) {
    return null;
  }

  const id = readUuid(raw.id);
  const brief_id = readUuid(raw.brief_id);
  const version =
    typeof raw.version === "number" &&
    Number.isSafeInteger(raw.version) &&
    raw.version >= 1
      ? raw.version
      : null;
  const published_at = readIsoTimestamp(raw.published_at);
  const updated_at = readIsoTimestamp(raw.updated_at);

  if (
    !id ||
    !brief_id ||
    id !== brief_id ||
    version === null ||
    !published_at ||
    !updated_at ||
    !isPlainRecord(raw.location) ||
    !hasExactKeys(raw.location, PUBLIC_JOBS_FEED_V1_LOCATION_KEYS) ||
    !isPlainRecord(raw.general) ||
    !hasExactKeys(raw.general, PUBLIC_JOBS_FEED_V1_GENERAL_KEYS) ||
    !isPlainRecord(raw.candidate) ||
    !hasExactKeys(raw.candidate, PUBLIC_JOBS_FEED_V1_CANDIDATE_KEYS) ||
    !isPlainRecord(raw.compensation) ||
    !hasExactKeys(raw.compensation, COMPENSATION_KEYS) ||
    !isPlainRecord(raw.documents) ||
    !hasExactKeys(raw.documents, DOCUMENTS_KEYS)
  ) {
    return null;
  }

  const province_code = readCatalogCode(raw.location.province_code);
  const province_name = readNonEmptyDisplayText(raw.location.province_name, 256);
  const industrial_park_code = readCatalogCode(
    raw.location.industrial_park_code,
  );
  const industrial_park_name = readNonEmptyDisplayText(
    raw.location.industrial_park_name,
    256,
  );
  if (
    !province_code ||
    !province_name ||
    !industrial_park_code ||
    !industrial_park_name
  ) {
    return null;
  }

  if (
    !Array.isArray(raw.general.labor_types) ||
    raw.general.labor_types.length < 1
  ) {
    return null;
  }
  const labor_types: Array<{ labor_type_key: string; display_name: string }> =
    [];
  for (const lt of raw.general.labor_types) {
    if (
      !isPlainRecord(lt) ||
      !hasExactKeys(lt, ["labor_type_key", "display_name"])
    ) {
      return null;
    }
    const key = readLaborTypeKey(lt.labor_type_key);
    const name = readNonEmptyDisplayText(lt.display_name, 256);
    if (!key || !name) return null;
    labor_types.push({ labor_type_key: key, display_name: name });
  }

  const candidateWithoutLabel = {
    age_min: raw.candidate.age_min,
    age_max: raw.candidate.age_max,
    gender_requirement: raw.candidate.gender_requirement,
    education_requirement: raw.candidate.education_requirement,
    experience_required: raw.candidate.experience_required,
    experience_details: raw.candidate.experience_details,
    accept_former_customer_workers:
      raw.candidate.accept_former_customer_workers,
    entry_assessment_text: raw.candidate.entry_assessment_text,
    other_requirements_text: raw.candidate.other_requirements_text,
  };

  const parsedContent = parseRecruitmentPostContent({
    general: {
      customer_name: raw.general.customer_name,
      investment_origin: raw.general.investment_origin,
      manufacturing_industry: raw.general.manufacturing_industry,
      job_description: raw.general.job_description,
      environment_types: raw.general.environment_types,
      work_postures: raw.general.work_postures,
      shift_pattern: raw.general.shift_pattern,
      shift_details: raw.general.shift_details,
      manager_name: "Public Feed Internal Placeholder",
      manager_phone: "000000",
      labor_type_keys: labor_types.map((lt) => lt.labor_type_key),
      supply_schedule_text: raw.general.supply_schedule_text,
      expected_headcount: raw.general.expected_headcount,
    },
    candidate: candidateWithoutLabel,
    compensation: raw.compensation,
    documents: raw.documents,
  });

  if (!parsedContent.ok) {
    return null;
  }

  const expectedGenderLabel =
    genderLabels[parsedContent.value.candidate.gender_requirement];
  if (
    typeof raw.candidate.gender_label !== "string" ||
    raw.candidate.gender_label.trim() !== expectedGenderLabel
  ) {
    return null;
  }

  return {
    id,
    brief_id,
    version,
    published_at,
    updated_at,
    location: {
      province_code,
      province_name,
      industrial_park_code,
      industrial_park_name,
    },
    general: {
      customer_name: parsedContent.value.general.customer_name,
      investment_origin: parsedContent.value.general.investment_origin,
      manufacturing_industry: parsedContent.value.general.manufacturing_industry,
      job_description: parsedContent.value.general.job_description,
      environment_types: parsedContent.value.general.environment_types,
      work_postures: parsedContent.value.general.work_postures,
      shift_pattern: parsedContent.value.general.shift_pattern,
      shift_details: parsedContent.value.general.shift_details,
      labor_types,
      supply_schedule_text: parsedContent.value.general.supply_schedule_text,
      expected_headcount: parsedContent.value.general.expected_headcount,
    },
    candidate: {
      ...parsedContent.value.candidate,
      gender_label: expectedGenderLabel,
    },
    compensation: parsedContent.value.compensation,
    documents: parsedContent.value.documents,
  };
}

export function projectRecruitmentPostPublicFeedV1(
  raw: unknown,
  genderLabels: Readonly<
    Record<RecruitmentPostGenderRequirement, string>
  > = DEFAULT_PUBLIC_FEED_GENDER_LABELS,
): RecruitmentPostPublicFeedV1 | null {
  if (
    !isPlainRecord(raw) ||
    containsForbiddenPublicFeedKey(raw) ||
    !hasExactKeys(raw, PUBLIC_JOBS_FEED_V1_TOP_KEYS) ||
    raw.schema_version !== PUBLIC_JOBS_FEED_V1_SCHEMA_VERSION ||
    !Array.isArray(raw.jobs)
  ) {
    return null;
  }

  const jobs: RecruitmentPostPublicJobItemV1[] = [];
  for (const rawJob of raw.jobs) {
    const projected = projectRecruitmentPostPublicJobItemV1(
      rawJob,
      genderLabels,
    );
    if (!projected) {
      return null;
    }
    jobs.push(projected);
  }

  return {
    schema_version: PUBLIC_JOBS_FEED_V1_SCHEMA_VERSION,
    jobs,
  };
}
