import { isRealCalendarDate } from "../analytics/identity/identity-shared.mjs";
import type { ActorResolution } from "../auth/direct-entry-v2.ts";
import {
  decideSessionPageAccess,
  type SessionPageDecision,
} from "../auth/session-page-access.ts";
import { newIdempotencyKey } from "../direct-entry/project-operations-model.ts";
import {
  createLatestRequestTracker,
  type LatestRequestTicket,
  type LatestRequestTracker,
} from "../salary-advance/salary-advance-ui-model.ts";
import {
  formatVndMinor,
  normalizeNonNegativeVndInput,
} from "../vendor-finance/ui-model.ts";
import {
  DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
  MAX_RECRUITMENT_POST_PAGE_SIZE,
  RECRUITMENT_POST_AGE_MAX,
  RECRUITMENT_POST_AGE_MIN,
  RECRUITMENT_POST_CURSOR_PATTERN,
  RECRUITMENT_POST_EDUCATION_REQUIREMENTS,
  RECRUITMENT_POST_ENVIRONMENT_TYPES,
  RECRUITMENT_POST_GENDER_REQUIREMENTS,
  RECRUITMENT_POST_MAX_EXPECTED_HEADCOUNT,
  RECRUITMENT_POST_SHIFT_PATTERNS,
  RECRUITMENT_POST_SNAPSHOT_TOKEN_PATTERN,
  RECRUITMENT_POST_WORK_POSTURES,
  VND_STRING_PATTERN,
  parseCreateRecruitmentPostBody,
  parseUpdateRecruitmentPostBody,
  parseWithdrawRecruitmentPostBody,
  projectRecruitmentPostContext,
  projectRecruitmentPostGet,
  projectRecruitmentPostItem,
  projectRecruitmentPostList,
  projectRecruitmentPostListWithFacets,
  projectRecruitmentPostMutation,
  type RecruitmentPostContentInput,
  type RecruitmentPostContext,
  type RecruitmentPostEducationRequirement,
  type RecruitmentPostEnvironmentType,
  type RecruitmentPostErrorCode,
  type RecruitmentPostGenderRequirement,
  type RecruitmentPostGetResult,
  type RecruitmentPostIndustrialParkFacet,
  type RecruitmentPostIndustrialParkOption,
  type RecruitmentPostItem,
  type RecruitmentPostLaborTypeFacet,
  type RecruitmentPostLaborTypeOption,
  type RecruitmentPostList,
  type RecruitmentPostListWithFacets,
  type RecruitmentPostMutationResult,
  type RecruitmentPostProjectOption,
  type RecruitmentPostProvinceOption,
  type RecruitmentPostShiftPattern,
  type RecruitmentPostStatus,
  type RecruitmentPostWorkPosture,
} from "./contract.ts";

export {
  DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
  MAX_RECRUITMENT_POST_PAGE_SIZE,
  RECRUITMENT_POST_AGE_MAX,
  RECRUITMENT_POST_AGE_MIN,
  RECRUITMENT_POST_CURSOR_PATTERN,
  RECRUITMENT_POST_EDUCATION_REQUIREMENTS,
  RECRUITMENT_POST_ENVIRONMENT_TYPES,
  RECRUITMENT_POST_GENDER_REQUIREMENTS,
  RECRUITMENT_POST_MAX_EXPECTED_HEADCOUNT,
  RECRUITMENT_POST_SHIFT_PATTERNS,
  RECRUITMENT_POST_SNAPSHOT_TOKEN_PATTERN,
  RECRUITMENT_POST_WORK_POSTURES,
  createLatestRequestTracker,
  newIdempotencyKey,
  projectRecruitmentPostContext,
  projectRecruitmentPostGet,
  projectRecruitmentPostItem,
  projectRecruitmentPostList,
  projectRecruitmentPostListWithFacets,
  projectRecruitmentPostMutation,
};

export type {
  LatestRequestTicket,
  LatestRequestTracker,
  RecruitmentPostContentInput,
  RecruitmentPostContext,
  RecruitmentPostEducationRequirement,
  RecruitmentPostEnvironmentType,
  RecruitmentPostErrorCode,
  RecruitmentPostGenderRequirement,
  RecruitmentPostGetResult,
  RecruitmentPostIndustrialParkFacet,
  RecruitmentPostIndustrialParkOption,
  RecruitmentPostItem,
  RecruitmentPostLaborTypeFacet,
  RecruitmentPostLaborTypeOption,
  RecruitmentPostList,
  RecruitmentPostListWithFacets,
  RecruitmentPostMutationResult,
  RecruitmentPostProjectOption,
  RecruitmentPostProvinceOption,
  RecruitmentPostShiftPattern,
  RecruitmentPostStatus,
  RecruitmentPostWorkPosture,
};

export const RECRUITMENT_POST_UNPROVIDED_LABEL = "Chưa cung cấp";

export const ENVIRONMENT_TYPE_LABELS: Readonly<
  Record<RecruitmentPostEnvironmentType, string>
> = Object.freeze({
  CLEAN_ROOM: "Phòng sạch",
  NORMAL_ROOM: "Phòng thường",
  SEMI_CLEAN_ROOM: "Phòng bán sạch",
});

export const WORK_POSTURE_LABELS: Readonly<
  Record<RecruitmentPostWorkPosture, string>
> = Object.freeze({
  STANDING: "Đứng",
  SITTING: "Ngồi",
});

export const SHIFT_PATTERN_LABELS: Readonly<
  Record<RecruitmentPostShiftPattern, string>
> = Object.freeze({
  DAY_ONLY: "Chuyên ngày",
  TWO_SHIFTS: "Hai ca",
  THREE_SHIFTS: "Ba ca",
  OTHER: "Khác",
});

export const GENDER_REQUIREMENT_LABELS: Readonly<
  Record<RecruitmentPostGenderRequirement, string>
> = Object.freeze({
  FEMALE: "Nữ",
  MALE: "Nam",
  ANY: "Nam/Nữ",
});

export const EDUCATION_REQUIREMENT_LABELS: Readonly<
  Record<RecruitmentPostEducationRequirement, string>
> = Object.freeze({
  SECONDARY: "THCS (Cấp 2)",
  HIGH_SCHOOL: "THPT (Cấp 3)",
  NONE: "Không yêu cầu",
});

export type RecruitmentPostsPageAccessDecision =
  | "NOT_FOUND"
  | SessionPageDecision;

/**
 * Server boundary decision for `/recruitment-posts`.
 * - Checks `DIRECT_ENTRY_API_ENABLED` separately (`"NOT_FOUND"` when not `"true"`).
 * - Delegates session/account state to `decideSessionPageAccess(actor)`.
 */
export function decideRecruitmentPostsPageAccess(input: {
  enabledFlag: string | undefined;
  actor: ActorResolution | null;
}): RecruitmentPostsPageAccessDecision {
  if (input.enabledFlag !== "true") {
    return "NOT_FOUND";
  }
  return decideSessionPageAccess(input.actor);
}

export const RECRUITMENT_POST_FEED_TABS = ["published", "mine"] as const;

export type RecruitmentPostFeedTab =
  (typeof RECRUITMENT_POST_FEED_TABS)[number];

export const RECRUITMENT_POST_FEED_TAB_LABELS: Readonly<
  Record<RecruitmentPostFeedTab, string>
> = Object.freeze({
  published: "Tin đang tuyển",
  mine: "Tin của tôi",
});

export const RECRUITMENT_POST_STATUS_BADGE_LABELS: Readonly<
  Record<RecruitmentPostStatus, string>
> = Object.freeze({
  PUBLISHED: "Đang tuyển",
  WITHDRAWN: "Đã rút",
});

export function parseRecruitmentPostFeedTab(
  raw: string | readonly string[] | null | undefined,
): RecruitmentPostFeedTab {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate === "string" && candidate.trim().toLowerCase() === "mine") {
    return "mine";
  }
  return "published";
}

export function buildRecruitmentPostFeedTabHref(
  tab: RecruitmentPostFeedTab,
): string {
  return tab === "mine"
    ? "/recruitment-posts?tab=mine"
    : "/recruitment-posts?tab=published";
}

export type RecruitmentPostAllowedActionsViewModel = {
  readonly canEdit: boolean;
  readonly canWithdraw: boolean;
};

export type RecruitmentPostFeedFilterState = {
  readonly projectId: string;
  readonly provinceId: string;
  readonly industrialParkId: string;
  readonly laborTypeKey: string;
  readonly updatedFrom: string;
  readonly updatedTo: string;
};

export const EMPTY_RECRUITMENT_POST_FILTERS: RecruitmentPostFeedFilterState =
  Object.freeze({
    projectId: "",
    provinceId: "",
    industrialParkId: "",
    laborTypeKey: "",
    updatedFrom: "",
    updatedTo: "",
  });

export type RecruitmentPostCardViewModel = {
  readonly briefId: string;
  readonly version: number;
  readonly status: RecruitmentPostStatus;
  readonly statusBadgeLabel: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly customerNameDisplay: string;
  readonly provinceName: string;
  readonly industrialParkName: string;
  readonly locationDisplay: string;
  readonly jobDescriptionDisplay: string;
  readonly laborTypesDisplay: string;
  readonly expectedHeadcountDisplay: string;
  readonly genderDisplay: string;
  readonly ageRangeDisplay: string;
  readonly genderAndAgeDisplay: string;
  readonly baseSalaryDisplay: string;
  readonly incomeRangeDisplay: string;
  readonly baseSalaryAndIncomeDisplay: string;
  readonly managerNameDisplay: string;
  readonly managerPhoneDisplay: string;
  readonly managerContactDisplay: string;
  readonly createdByDisplayName: string;
  readonly updatedAtDisplay: string;
  readonly createdByAndUpdatedAtDisplay: string;
  readonly allowedActions: RecruitmentPostAllowedActionsViewModel;
};

export type RecruitmentPostDetailViewModel = {
  readonly briefId: string;
  readonly version: number;
  readonly status: RecruitmentPostStatus;
  readonly projectId: string;
  readonly industrialParkId: string;
  readonly createdByDisplayName: string;
  readonly updatedByDisplayName: string;
  readonly publishedAtDisplay: string;
  readonly updatedAtDisplay: string;
  readonly allowedActions: RecruitmentPostAllowedActionsViewModel;
  readonly section1General: {
    readonly projectName: string;
    readonly industrialParkName: string;
    readonly provinceName: string;
    readonly customerNameDisplay: string;
    readonly investmentOriginDisplay: string;
    readonly manufacturingIndustryDisplay: string;
    readonly jobDescriptionDisplay: string;
    readonly environmentTypesDisplay: string;
    readonly workPosturesDisplay: string;
    readonly shiftPatternDisplay: string;
    readonly shiftDetailsDisplay: string;
    readonly managerNameDisplay: string;
    readonly managerPhoneDisplay: string;
    readonly laborTypesDisplay: string;
    readonly supplyScheduleTextDisplay: string;
    readonly expectedHeadcountDisplay: string;
  };
  readonly section2CandidateRequirements: {
    readonly ageFromDisplay: string;
    readonly ageToDisplay: string;
    readonly genderDisplay: string;
    readonly minimumEducationDisplay: string;
    readonly experienceRequiredDisplay: string;
    readonly experienceDetailsDisplay: string;
    readonly acceptsFormerWorkersDisplay: string;
    readonly entryTestFormatDisplay: string;
    readonly otherRequirementsDisplay: string;
  };
  readonly section3CompensationBenefits: {
    readonly baseSalaryVndDisplay: string;
    readonly baseSalaryConditionsDisplay: string;
    readonly attendanceBonusVndDisplay: string;
    readonly attendanceBonusConditionsDisplay: string;
    readonly livingAllowanceVndDisplay: string;
    readonly livingAllowanceConditionsDisplay: string;
    readonly seniorityAllowanceVndDisplay: string;
    readonly seniorityAllowanceConditionsDisplay: string;
    readonly eyesightAllowanceVndDisplay: string;
    readonly eyesightAllowanceConditionsDisplay: string;
    readonly otherAllowanceTextDisplay: string;
    readonly averageIncomeMinVndDisplay: string;
    readonly averageIncomeMaxVndDisplay: string;
    readonly salaryPaymentScheduleDisplay: string;
    readonly salaryAdvanceAvailableDisplay: string;
    readonly salaryAdvanceAmountVndDisplay: string;
    readonly salaryAdvanceScheduleDisplay: string;
    readonly weeklySalaryAvailableDisplay: string;
    readonly weeklySalaryPaymentScheduleDisplay: string;
    readonly dayShift8hVndDisplay: string;
    readonly dayShift11hVndDisplay: string;
    readonly nightShift8hVndDisplay: string;
    readonly nightShift11hVndDisplay: string;
    readonly sundayDay11hVndDisplay: string;
    readonly sundayNight11hVndDisplay: string;
    readonly holidayDay11hVndDisplay: string;
    readonly holidayNight11hVndDisplay: string;
    readonly ppeProvidedDisplay: string;
    readonly ppeDetailsDisplay: string;
    readonly otherBenefitsDisplay: string;
  };
  readonly section4ApplicationDocuments: {
    readonly requireOriginalCccdAndCopy: boolean;
    readonly requireOriginalCccdAndCopyDisplay: string;
    readonly requireCertifiedResume: boolean;
    readonly requireCertifiedResumeDisplay: string;
    readonly requireHealthCertificateWithin6Months: boolean;
    readonly requireHealthCertificateWithin6MonthsDisplay: string;
    readonly requirePhoto3x4: boolean;
    readonly requirePhoto3x4Display: string;
    readonly requireDegreeOrCertificate: boolean;
    readonly requireDegreeOrCertificateDisplay: string;
    readonly requireSocialInsuranceBook: boolean;
    readonly requireSocialInsuranceBookDisplay: string;
    readonly requireOtherDocuments: boolean;
    readonly requireOtherDocumentsDisplay: string;
    readonly otherDocumentsTextDisplay: string;
  };
};

export type RecruitmentPostAccessLossKind =
  | "UNAUTHENTICATED"
  | "ACCESS_DENIED"
  | "ACCOUNT_UNAVAILABLE";

export type RecruitmentPostDataState = {
  readonly context: RecruitmentPostContext | null;
  readonly items: readonly RecruitmentPostItem[];
  readonly selectedDetail: RecruitmentPostItem | null;
  readonly detailOpen: boolean;
  readonly detailBriefId: string | null;
  readonly detailError: string | null;
  readonly nextCursor: string | null;
  readonly snapshotToken: string | null;
  readonly hasMore: boolean;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Formats nullable/optional strings with `"Chưa cung cấp"` when empty or null.
 */
export function formatRecruitmentPostText(
  value: string | null | undefined,
): string {
  if (typeof value !== "string") {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : RECRUITMENT_POST_UNPROVIDED_LABEL;
}

/**
 * Formats a canonical integer VND string (`"5500000"`) via `formatVndMinor` (`"5.500.000 ₫"`).
 * Never appends an extra `" đ"` unit. Returns `"Chưa cung cấp"` when null or invalid.
 */
export function formatRecruitmentPostVnd(
  canonicalVnd: string | null | undefined,
): string {
  if (typeof canonicalVnd !== "string") {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  const trimmed = canonicalVnd.trim();
  if (!VND_STRING_PATTERN.test(trimmed)) {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  return formatVndMinor(trimmed);
}

export function formatRecruitmentPostHeadcount(
  headcount: number | null | undefined,
): string {
  if (
    typeof headcount !== "number" ||
    !Number.isInteger(headcount) ||
    headcount < 0
  ) {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  return `${new Intl.NumberFormat("vi-VN").format(headcount)} người`;
}

export function formatRecruitmentPostAgeBound(
  age: number | null | undefined,
): string {
  if (typeof age !== "number" || !Number.isInteger(age) || age < 15 || age > 70) {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  return `${age} tuổi`;
}

export function formatRecruitmentPostAgeRange(
  ageMin: number | null | undefined,
  ageMax: number | null | undefined,
): string {
  const hasMin =
    typeof ageMin === "number" &&
    Number.isInteger(ageMin) &&
    ageMin >= 15 &&
    ageMin <= 70;
  const hasMax =
    typeof ageMax === "number" &&
    Number.isInteger(ageMax) &&
    ageMax >= 15 &&
    ageMax <= 70;
  if (hasMin && hasMax) {
    return ageMin === ageMax
      ? `${ageMin} tuổi`
      : `${ageMin} – ${ageMax} tuổi`;
  }
  if (hasMin) {
    return `Từ ${ageMin} tuổi`;
  }
  if (hasMax) {
    return `Đến ${ageMax} tuổi`;
  }
  return RECRUITMENT_POST_UNPROVIDED_LABEL;
}

export function formatRecruitmentPostIncomeRange(
  minVnd: string | null | undefined,
  maxVnd: string | null | undefined,
): string {
  const minFormatted = formatRecruitmentPostVnd(minVnd);
  const maxFormatted = formatRecruitmentPostVnd(maxVnd);
  const hasMin = minFormatted !== RECRUITMENT_POST_UNPROVIDED_LABEL;
  const hasMax = maxFormatted !== RECRUITMENT_POST_UNPROVIDED_LABEL;
  if (hasMin && hasMax) {
    return minFormatted === maxFormatted
      ? minFormatted
      : `${minFormatted} – ${maxFormatted}`;
  }
  if (hasMin) {
    return `Từ ${minFormatted}`;
  }
  if (hasMax) {
    return `Đến ${maxFormatted}`;
  }
  return RECRUITMENT_POST_UNPROVIDED_LABEL;
}

export function formatRecruitmentPostTimestampVi(
  isoUtc: string | null | undefined,
): string {
  if (typeof isoUtc !== "string" || isoUtc.trim().length === 0) {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  const date = new Date(isoUtc.trim());
  if (Number.isNaN(date.getTime())) {
    return RECRUITMENT_POST_UNPROVIDED_LABEL;
  }
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

/**
 * Maps a validated `RecruitmentPostItem` into the compact 10-item summary card view-model
 * defined in Master Plan lines 585–599.
 */
export function toRecruitmentPostCardViewModel(
  item: RecruitmentPostItem,
): RecruitmentPostCardViewModel {
  const projectName = formatRecruitmentPostText(item.project.display_name);
  const customerNameDisplay = formatRecruitmentPostText(
    item.general.customer_name,
  );
  const provinceName = formatRecruitmentPostText(item.province.display_name);
  const industrialParkName = formatRecruitmentPostText(
    item.industrial_park.display_name,
  );
  const locationDisplay = `${provinceName} · ${industrialParkName}`;
  const jobDescriptionDisplay = formatRecruitmentPostText(
    item.general.job_description,
  );
  const laborTypesDisplay =
    item.general.labor_types.length > 0
      ? item.general.labor_types.map((lt) => lt.display_name).join(", ")
      : RECRUITMENT_POST_UNPROVIDED_LABEL;
  const expectedHeadcountDisplay = formatRecruitmentPostHeadcount(
    item.general.expected_headcount,
  );
  const genderDisplay =
    GENDER_REQUIREMENT_LABELS[item.candidate.gender_requirement] ??
    RECRUITMENT_POST_UNPROVIDED_LABEL;
  const ageRangeDisplay = formatRecruitmentPostAgeRange(
    item.candidate.age_min,
    item.candidate.age_max,
  );
  const genderAndAgeDisplay = `${genderDisplay} · Độ tuổi: ${ageRangeDisplay}`;
  const baseSalaryDisplay = formatRecruitmentPostVnd(
    item.compensation.base_salary_vnd,
  );
  const incomeRangeDisplay = formatRecruitmentPostIncomeRange(
    item.compensation.average_income_min_vnd,
    item.compensation.average_income_max_vnd,
  );
  const baseSalaryAndIncomeDisplay = `LCB: ${baseSalaryDisplay} · Thu nhập: ${incomeRangeDisplay}`;
  const createdByDisplayName = formatRecruitmentPostText(
    item.created_by_display_name,
  );
  const managerNameDisplay = createdByDisplayName;
  const managerPhoneDisplay = formatRecruitmentPostText(
    item.general.manager_phone,
  );
  const managerContactDisplay = `${managerNameDisplay} · ${managerPhoneDisplay}`;
  const updatedAtDisplay = formatRecruitmentPostTimestampVi(item.updated_at);
  const createdByAndUpdatedAtDisplay = `${createdByDisplayName} · ${updatedAtDisplay}`;
  const isPublished = item.status === "PUBLISHED";

  return {
    briefId: item.brief_id,
    version: item.version,
    status: item.status,
    statusBadgeLabel:
      RECRUITMENT_POST_STATUS_BADGE_LABELS[item.status] ??
      (item.status === "WITHDRAWN" ? "Đã rút" : "Đang tuyển"),
    projectId: item.project.project_id,
    projectName,
    customerNameDisplay,
    provinceName,
    industrialParkName,
    locationDisplay,
    jobDescriptionDisplay,
    laborTypesDisplay,
    expectedHeadcountDisplay,
    genderDisplay,
    ageRangeDisplay,
    genderAndAgeDisplay,
    baseSalaryDisplay,
    incomeRangeDisplay,
    baseSalaryAndIncomeDisplay,
    managerNameDisplay,
    managerPhoneDisplay,
    managerContactDisplay,
    createdByDisplayName,
    updatedAtDisplay,
    createdByAndUpdatedAtDisplay,
    allowedActions: {
      canEdit: isPublished && item.allowed_actions.can_edit,
      canWithdraw: isPublished && item.allowed_actions.can_withdraw,
    },
  };
}

/**
 * Maps a validated `RecruitmentPostItem` into the 4-section BOD detail view-model
 * defined in Master Plan lines 276–383 and 609–619.
 */
export function toRecruitmentPostDetailViewModel(
  item: RecruitmentPostItem,
): RecruitmentPostDetailViewModel {
  const environmentTypesDisplay =
    item.general.environment_types.length > 0
      ? item.general.environment_types
          .map((code) => ENVIRONMENT_TYPE_LABELS[code] ?? code)
          .join(", ")
      : RECRUITMENT_POST_UNPROVIDED_LABEL;

  const workPosturesDisplay =
    item.general.work_postures.length > 0
      ? item.general.work_postures
          .map((code) => WORK_POSTURE_LABELS[code] ?? code)
          .join(", ")
      : RECRUITMENT_POST_UNPROVIDED_LABEL;

  const shiftPatternDisplay =
    SHIFT_PATTERN_LABELS[item.general.shift_pattern] ??
    RECRUITMENT_POST_UNPROVIDED_LABEL;

  const laborTypesDisplay =
    item.general.labor_types.length > 0
      ? item.general.labor_types.map((lt) => lt.display_name).join(", ")
      : RECRUITMENT_POST_UNPROVIDED_LABEL;

  const formatDocRequired = (required: boolean): string =>
    required ? "Có yêu cầu" : "Không";

  return {
    briefId: item.brief_id,
    version: item.version,
    status: item.status,
    projectId: item.project.project_id,
    industrialParkId: item.industrial_park.industrial_park_id,
    createdByDisplayName: formatRecruitmentPostText(
      item.created_by_display_name,
    ),
    updatedByDisplayName: formatRecruitmentPostText(
      item.updated_by_display_name,
    ),
    publishedAtDisplay: formatRecruitmentPostTimestampVi(item.published_at),
    updatedAtDisplay: formatRecruitmentPostTimestampVi(item.updated_at),
    allowedActions: {
      canEdit: item.allowed_actions.can_edit,
      canWithdraw: item.allowed_actions.can_withdraw,
    },
    section1General: {
      projectName: formatRecruitmentPostText(item.project.display_name),
      industrialParkName: formatRecruitmentPostText(
        item.industrial_park.display_name,
      ),
      provinceName: formatRecruitmentPostText(item.province.display_name),
      customerNameDisplay: formatRecruitmentPostText(
        item.general.customer_name,
      ),
      investmentOriginDisplay: formatRecruitmentPostText(
        item.general.investment_origin,
      ),
      manufacturingIndustryDisplay: formatRecruitmentPostText(
        item.general.manufacturing_industry,
      ),
      jobDescriptionDisplay: formatRecruitmentPostText(
        item.general.job_description,
      ),
      environmentTypesDisplay,
      workPosturesDisplay,
      shiftPatternDisplay,
      shiftDetailsDisplay: formatRecruitmentPostText(
        item.general.shift_details,
      ),
      managerNameDisplay: formatRecruitmentPostText(
        item.created_by_display_name,
      ),
      managerPhoneDisplay: formatRecruitmentPostText(
        item.general.manager_phone,
      ),
      laborTypesDisplay,
      supplyScheduleTextDisplay: formatRecruitmentPostText(
        item.general.supply_schedule_text,
      ),
      expectedHeadcountDisplay: formatRecruitmentPostHeadcount(
        item.general.expected_headcount,
      ),
    },
    section2CandidateRequirements: {
      ageFromDisplay: formatRecruitmentPostAgeBound(item.candidate.age_min),
      ageToDisplay: formatRecruitmentPostAgeBound(item.candidate.age_max),
      genderDisplay:
        GENDER_REQUIREMENT_LABELS[item.candidate.gender_requirement] ??
        RECRUITMENT_POST_UNPROVIDED_LABEL,
      minimumEducationDisplay:
        EDUCATION_REQUIREMENT_LABELS[item.candidate.education_requirement] ??
        RECRUITMENT_POST_UNPROVIDED_LABEL,
      experienceRequiredDisplay: item.candidate.experience_required
        ? "Có"
        : "Không",
      experienceDetailsDisplay: item.candidate.experience_required
        ? formatRecruitmentPostText(item.candidate.experience_details)
        : "Không yêu cầu kinh nghiệm",
      acceptsFormerWorkersDisplay: item.candidate.accept_former_customer_workers
        ? "Có nhận"
        : "Không nhận",
      entryTestFormatDisplay: formatRecruitmentPostText(
        item.candidate.entry_assessment_text,
      ),
      otherRequirementsDisplay: formatRecruitmentPostText(
        item.candidate.other_requirements_text,
      ),
    },
    section3CompensationBenefits: {
      baseSalaryVndDisplay: formatRecruitmentPostVnd(
        item.compensation.base_salary_vnd,
      ),
      baseSalaryConditionsDisplay: formatRecruitmentPostText(
        item.compensation.base_salary_conditions,
      ),
      attendanceBonusVndDisplay: formatRecruitmentPostVnd(
        item.compensation.attendance_bonus_vnd,
      ),
      attendanceBonusConditionsDisplay: formatRecruitmentPostText(
        item.compensation.attendance_bonus_conditions,
      ),
      livingAllowanceVndDisplay: formatRecruitmentPostVnd(
        item.compensation.living_allowance_vnd,
      ),
      livingAllowanceConditionsDisplay: formatRecruitmentPostText(
        item.compensation.living_allowance_conditions,
      ),
      seniorityAllowanceVndDisplay: formatRecruitmentPostVnd(
        item.compensation.seniority_allowance_vnd,
      ),
      seniorityAllowanceConditionsDisplay: formatRecruitmentPostText(
        item.compensation.seniority_allowance_conditions,
      ),
      eyesightAllowanceVndDisplay: formatRecruitmentPostVnd(
        item.compensation.eyesight_allowance_vnd,
      ),
      eyesightAllowanceConditionsDisplay: formatRecruitmentPostText(
        item.compensation.eyesight_allowance_conditions,
      ),
      otherAllowanceTextDisplay: formatRecruitmentPostText(
        item.compensation.other_allowance_text,
      ),
      averageIncomeMinVndDisplay: formatRecruitmentPostVnd(
        item.compensation.average_income_min_vnd,
      ),
      averageIncomeMaxVndDisplay: formatRecruitmentPostVnd(
        item.compensation.average_income_max_vnd,
      ),
      salaryPaymentScheduleDisplay: formatRecruitmentPostText(
        item.compensation.salary_payment_schedule,
      ),
      salaryAdvanceAvailableDisplay: item.compensation.salary_advance_available
        ? "Có"
        : "Không",
      salaryAdvanceAmountVndDisplay: item.compensation.salary_advance_available
        ? formatRecruitmentPostVnd(item.compensation.salary_advance_amount_vnd)
        : RECRUITMENT_POST_UNPROVIDED_LABEL,
      salaryAdvanceScheduleDisplay: item.compensation.salary_advance_available
        ? formatRecruitmentPostText(item.compensation.salary_advance_schedule)
        : RECRUITMENT_POST_UNPROVIDED_LABEL,
      weeklySalaryAvailableDisplay: item.compensation.weekly_salary_available
        ? "Có"
        : "Không",
      weeklySalaryPaymentScheduleDisplay: item.compensation
        .weekly_salary_available
        ? formatRecruitmentPostText(
            item.compensation.weekly_salary_payment_schedule,
          )
        : RECRUITMENT_POST_UNPROVIDED_LABEL,
      dayShift8hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.day_shift_8h_vnd,
      ),
      dayShift11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.day_shift_11h_vnd,
      ),
      nightShift8hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.night_shift_8h_vnd,
      ),
      nightShift11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.night_shift_11h_vnd,
      ),
      sundayDay11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.sunday_day_11h_vnd,
      ),
      sundayNight11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.sunday_night_11h_vnd,
      ),
      holidayDay11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.holiday_day_11h_vnd,
      ),
      holidayNight11hVndDisplay: formatRecruitmentPostVnd(
        item.compensation.holiday_night_11h_vnd,
      ),
      ppeProvidedDisplay: item.compensation.ppe_provided
        ? "Có cấp phát"
        : "Không",
      ppeDetailsDisplay: formatRecruitmentPostText(
        item.compensation.ppe_details,
      ),
      otherBenefitsDisplay: formatRecruitmentPostText(
        item.compensation.other_benefits,
      ),
    },
    section4ApplicationDocuments: {
      requireOriginalCccdAndCopy:
        item.documents.require_original_cccd_and_copy,
      requireOriginalCccdAndCopyDisplay: formatDocRequired(
        item.documents.require_original_cccd_and_copy,
      ),
      requireCertifiedResume: item.documents.require_certified_resume,
      requireCertifiedResumeDisplay: formatDocRequired(
        item.documents.require_certified_resume,
      ),
      requireHealthCertificateWithin6Months:
        item.documents.require_health_certificate_within_6_months,
      requireHealthCertificateWithin6MonthsDisplay: formatDocRequired(
        item.documents.require_health_certificate_within_6_months,
      ),
      requirePhoto3x4: item.documents.require_photo_3x4,
      requirePhoto3x4Display: formatDocRequired(
        item.documents.require_photo_3x4,
      ),
      requireDegreeOrCertificate: item.documents.require_degree_or_certificate,
      requireDegreeOrCertificateDisplay: formatDocRequired(
        item.documents.require_degree_or_certificate,
      ),
      requireSocialInsuranceBook: item.documents.require_social_insurance_book,
      requireSocialInsuranceBookDisplay: formatDocRequired(
        item.documents.require_social_insurance_book,
      ),
      requireOtherDocuments: item.documents.require_other_documents,
      requireOtherDocumentsDisplay: formatDocRequired(
        item.documents.require_other_documents,
      ),
      otherDocumentsTextDisplay: item.documents.require_other_documents
        ? formatRecruitmentPostText(item.documents.other_documents_text)
        : "Không yêu cầu giấy tờ khác",
    },
  };
}

// -----------------------------------------------------------------------------
// Filter synchronization & URL query builders
// -----------------------------------------------------------------------------

export function hasActiveRecruitmentPostFilters(
  filters: RecruitmentPostFeedFilterState,
): boolean {
  return (
    filters.projectId.trim() !== "" ||
    filters.provinceId.trim() !== "" ||
    filters.industrialParkId.trim() !== "" ||
    filters.laborTypeKey.trim() !== "" ||
    filters.updatedFrom.trim() !== "" ||
    filters.updatedTo.trim() !== ""
  );
}

/**
 * Returns active provinces for filter selection.
 */
export function visibleProvincesForFilter(
  provinces: readonly RecruitmentPostProvinceOption[],
): RecruitmentPostProvinceOption[] {
  return provinces.filter((province) => province.active === true);
}

/**
 * Returns active industrial parks for filter selection, restricted to `provinceId`
 * when a province is selected (Master Plan lines 578–581).
 */
export function visibleIndustrialParksForFilter(
  industrialParks: readonly RecruitmentPostIndustrialParkOption[],
  provinceId: string,
): RecruitmentPostIndustrialParkOption[] {
  const normalizedProvinceId = provinceId.trim();
  return industrialParks.filter((park) => {
    if (!park.active) return false;
    if (normalizedProvinceId !== "" && park.province_id !== normalizedProvinceId) {
      return false;
    }
    return true;
  });
}

/**
 * Returns active labor types for filter selection.
 */
export function visibleLaborTypesForFilter(
  laborTypes: readonly RecruitmentPostLaborTypeOption[],
): RecruitmentPostLaborTypeOption[] {
  return laborTypes.filter((laborType) => laborType.active === true);
}

/**
 * Applies a Province filter change:
 * - Updates `provinceId`.
 * - Clears `industrialParkId` if it does not belong to the newly selected province
 *   (Master Plan line 580: "Đổi tỉnh làm mất KCN không tương thích").
 */
export function applyProvinceFilterChange(
  current: RecruitmentPostFeedFilterState,
  nextProvinceId: string,
  industrialParks: readonly RecruitmentPostIndustrialParkOption[],
): RecruitmentPostFeedFilterState {
  const normalizedProvinceId = nextProvinceId.trim();
  if (normalizedProvinceId === "") {
    return {
      ...current,
      provinceId: "",
    };
  }
  const selectedPark = industrialParks.find(
    (park) =>
      park.active && park.industrial_park_id === current.industrialParkId,
  );
  const keepPark =
    selectedPark !== undefined &&
    selectedPark.province_id === normalizedProvinceId;
  return {
    ...current,
    provinceId: normalizedProvinceId,
    industrialParkId: keepPark ? current.industrialParkId : "",
  };
}

/**
 * Applies an Industrial Park filter change:
 * - Updates `industrialParkId`.
 * - Automatically derives and synchronizes `provinceId` from the selected industrial park
 *   (Master Plan line 579: "Chọn KCN thì tỉnh được suy ra và đồng bộ").
 */
export function applyIndustrialParkFilterChange(
  current: RecruitmentPostFeedFilterState,
  nextIndustrialParkId: string,
  industrialParks: readonly RecruitmentPostIndustrialParkOption[],
): RecruitmentPostFeedFilterState {
  const normalizedParkId = nextIndustrialParkId.trim();
  if (normalizedParkId === "") {
    return {
      ...current,
      industrialParkId: "",
    };
  }
  const matchedPark = industrialParks.find(
    (park) => park.active && park.industrial_park_id === normalizedParkId,
  );
  if (!matchedPark) {
    return {
      ...current,
      industrialParkId: "",
    };
  }
  return {
    ...current,
    industrialParkId: matchedPark.industrial_park_id,
    provinceId: matchedPark.province_id,
  };
}

export function validateRecruitmentPostFeedFilters(
  filters: RecruitmentPostFeedFilterState,
): { ok: true } | { ok: false; message: string } {
  const from = filters.updatedFrom.trim();
  const to = filters.updatedTo.trim();
  if (from !== "" && !isRealCalendarDate(from)) {
    return {
      ok: false,
      message: "Ngày bắt đầu cập nhật không hợp lệ.",
    };
  }
  if (to !== "" && !isRealCalendarDate(to)) {
    return {
      ok: false,
      message: "Ngày kết thúc cập nhật không hợp lệ.",
    };
  }
  if (from !== "" && to !== "" && from > to) {
    return {
      ok: false,
      message:
        "Khoảng ngày cập nhật không hợp lệ: 'Từ ngày' không được lớn hơn 'Đến ngày'.",
    };
  }
  return { ok: true };
}

/**
 * Builds the `GET /api/recruitment-posts` URL adhering strictly to `parseListRecruitmentPostsQuery`.
 * - Uses `page_size=15` (`DEFAULT_RECRUITMENT_POST_PAGE_SIZE`).
 * - Includes both `snapshot_token` and `cursor` when loading subsequent batches.
 */
export function buildRecruitmentPostListUrl(
  filters: RecruitmentPostFeedFilterState,
  pagination?: {
    cursor?: string | null;
    snapshotToken?: string | null;
    pageSize?: number;
  },
): string {
  const params = new URLSearchParams();
  const projectId = filters.projectId.trim();
  const provinceId = filters.provinceId.trim();
  const industrialParkId = filters.industrialParkId.trim();
  const laborTypeKey = filters.laborTypeKey.trim();
  const updatedFrom = filters.updatedFrom.trim();
  const updatedTo = filters.updatedTo.trim();

  if (projectId !== "") params.set("project_id", projectId);
  if (provinceId !== "") params.set("province_id", provinceId);
  if (industrialParkId !== "") {
    params.set("industrial_park_id", industrialParkId);
  }
  if (laborTypeKey !== "") params.set("labor_type_key", laborTypeKey);
  if (updatedFrom !== "") params.set("updated_from", updatedFrom);
  if (updatedTo !== "") params.set("updated_to", updatedTo);

  const pageSize = pagination?.pageSize ?? DEFAULT_RECRUITMENT_POST_PAGE_SIZE;
  params.set("page_size", String(pageSize));

  const cursor = pagination?.cursor?.trim() ?? "";
  const snapshotToken = pagination?.snapshotToken?.trim() ?? "";
  if (cursor !== "" && snapshotToken !== "") {
    params.set("snapshot_token", snapshotToken);
    params.set("cursor", cursor);
  }

  return `/api/recruitment-posts?${params.toString()}`;
}

/**
 * Builds the `GET /api/recruitment-posts/mine` URL adhering strictly to `parseListMyRecruitmentPostsQuery`.
 * - Uses `page_size=15` (`DEFAULT_RECRUITMENT_POST_PAGE_SIZE`).
 * - Includes both `snapshot_token` and `cursor` when loading subsequent batches.
 */
export function buildRecruitmentPostMineListUrl(pagination?: {
  cursor?: string | null;
  snapshotToken?: string | null;
  pageSize?: number;
}): string {
  const params = new URLSearchParams();
  const pageSize = pagination?.pageSize ?? DEFAULT_RECRUITMENT_POST_PAGE_SIZE;
  params.set("page_size", String(pageSize));

  const cursor = pagination?.cursor?.trim() ?? "";
  const snapshotToken = pagination?.snapshotToken?.trim() ?? "";
  if (cursor !== "" && snapshotToken !== "") {
    params.set("snapshot_token", snapshotToken);
    params.set("cursor", cursor);
  }

  return `/api/recruitment-posts/mine?${params.toString()}`;
}

/**
 * Updates feed items after a post is withdrawn:
 * - In `published` (`Tin đang tuyển`), removes the withdrawn card from the feed.
 * - In `mine` (`Tin của tôi`), keeps the card in-place and updates it with the `WITHDRAWN` projection.
 */
export function applyWithdrawnPostToFeedItems(
  items: readonly RecruitmentPostItem[],
  withdrawnPost: RecruitmentPostItem,
  tab: RecruitmentPostFeedTab,
): RecruitmentPostItem[] {
  if (tab === "mine") {
    return items.map((item) =>
      item.brief_id === withdrawnPost.brief_id ? withdrawnPost : item,
    );
  }
  return items.filter((item) => item.brief_id !== withdrawnPost.brief_id);
}

export function isSourceProjectManagedForRepost(
  projectId: string,
  managedProjects:
    | ReadonlyArray<{ readonly project_id: string }>
    | null
    | undefined,
): boolean {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId || !Array.isArray(managedProjects)) {
    return false;
  }
  return managedProjects.some(
    (project) => project.project_id === normalizedProjectId,
  );
}

export function canRepostWithdrawnRecruitmentPost(input: {
  readonly tab: RecruitmentPostFeedTab;
  readonly status: RecruitmentPostStatus;
  readonly projectId: string;
  readonly managedProjects:
    | ReadonlyArray<{ readonly project_id: string }>
    | null
    | undefined;
}): boolean {
  if (input.tab !== "mine" || input.status !== "WITHDRAWN") {
    return false;
  }
  return isSourceProjectManagedForRepost(
    input.projectId,
    input.managedProjects,
  );
}

/**
 * Appends a new cursor page of `RecruitmentPostItem`s without duplicating `brief_id`.
 * Never collapses distinct `brief_id`s that share `(project_id, industrial_park_id)`.
 */
export function mergeUniqueRecruitmentPostItems(
  current: readonly RecruitmentPostItem[],
  incoming: readonly RecruitmentPostItem[],
): RecruitmentPostItem[] {
  const result: RecruitmentPostItem[] = [];
  const indexById = new Map<string, number>();

  for (const item of current) {
    indexById.set(item.brief_id, result.length);
    result.push(item);
  }

  for (const item of incoming) {
    const existingIndex = indexById.get(item.brief_id);
    if (existingIndex !== undefined) {
      result[existingIndex] = item;
    } else {
      indexById.set(item.brief_id, result.length);
      result.push(item);
    }
  }

  return result;
}

// -----------------------------------------------------------------------------
// API Envelope Parsers & Fail-Closed Access Revocation Handling
// -----------------------------------------------------------------------------

export function extractRecruitmentPostErrorCode(
  payload: unknown,
): string | null {
  if (!isPlainRecord(payload)) return null;
  if (payload.ok !== false) return null;
  return typeof payload.code === "string" && payload.code.trim().length > 0
    ? payload.code.trim()
    : null;
}

export function parseRecruitmentPostContextEnvelope(
  payload: unknown,
): RecruitmentPostContext | null {
  if (!isPlainRecord(payload) || payload.ok !== true) return null;
  return projectRecruitmentPostContext(payload.data);
}

export function parseRecruitmentPostListEnvelope(
  payload: unknown,
): RecruitmentPostList | null {
  if (!isPlainRecord(payload) || payload.ok !== true) return null;
  return projectRecruitmentPostList(payload.data);
}

export function parseRecruitmentPostDetailEnvelope(
  payload: unknown,
): RecruitmentPostGetResult | null {
  if (!isPlainRecord(payload) || payload.ok !== true) return null;
  return projectRecruitmentPostGet(payload.data);
}

export function classifyRecruitmentPostAccessLoss(
  status: number,
  code: string | null,
): RecruitmentPostAccessLossKind | null {
  if (status === 401 || code === "UNAUTHENTICATED") {
    return "UNAUTHENTICATED";
  }
  if (status === 403) {
    if (code === "ACTOR_NOT_AVAILABLE") {
      return "ACCOUNT_UNAVAILABLE";
    }
    return "ACCESS_DENIED";
  }
  return null;
}

/**
 * Returns a clean empty state object used when `401` or `403` occurs so all feed items,
 * detail projections, customer names, and manager phone numbers are immediately purged from memory.
 */
export function createEmptyRecruitmentPostDataState(): RecruitmentPostDataState {
  return {
    context: null,
    items: [],
    selectedDetail: null,
    detailOpen: false,
    detailBriefId: null,
    detailError: null,
    nextCursor: null,
    snapshotToken: null,
    hasMore: false,
  };
}

/**
 * Clears feed items, pagination tokens, and any open/selected detail state belonging to the
 * previous feed or tab while preserving the loaded catalog `context` (if valid).
 */
export function clearRecruitmentPostFeedItemsPreservingContext(
  prev: RecruitmentPostDataState,
): RecruitmentPostDataState {
  return {
    ...prev,
    items: [],
    selectedDetail: null,
    detailOpen: false,
    detailBriefId: null,
    detailError: null,
    nextCursor: null,
    snapshotToken: null,
    hasMore: false,
  };
}

export type RecruitmentPostListOutcome =
  | {
      readonly kind: "ok";
      readonly list: RecruitmentPostList;
    }
  | {
      readonly kind: "access_loss";
      readonly accessLoss: RecruitmentPostAccessLossKind;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
    };

export function resolveRecruitmentPostListOutcome(input: {
  readonly status: number;
  readonly payload: unknown;
}): RecruitmentPostListOutcome {
  const errorCode = extractRecruitmentPostErrorCode(input.payload);
  const accessLoss = classifyRecruitmentPostAccessLoss(input.status, errorCode);
  if (accessLoss) {
    return {
      kind: "access_loss",
      accessLoss,
    };
  }

  if (input.status < 200 || input.status >= 300) {
    const resolvedCode = errorCode ?? "RECRUITMENT_POST_UNAVAILABLE";
    return {
      kind: "error",
      code: resolvedCode,
      message: recruitmentPostErrorMessage(resolvedCode),
    };
  }

  const parsedList = parseRecruitmentPostListEnvelope(input.payload);
  if (!parsedList) {
    return {
      kind: "error",
      code: "RECRUITMENT_POST_UNAVAILABLE",
      message: recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
    };
  }

  return {
    kind: "ok",
    list: parsedList,
  };
}

export function applyRecruitmentPostFirstPageOutcome(
  prev: RecruitmentPostDataState,
  outcome: RecruitmentPostListOutcome,
): RecruitmentPostDataState {
  if (outcome.kind === "access_loss") {
    return createEmptyRecruitmentPostDataState();
  }
  if (outcome.kind === "error") {
    return clearRecruitmentPostFeedItemsPreservingContext(prev);
  }
  return {
    ...clearRecruitmentPostFeedItemsPreservingContext(prev),
    items: mergeUniqueRecruitmentPostItems([], outcome.list.items),
    nextCursor: outcome.list.next_cursor,
    snapshotToken: outcome.list.snapshot_token,
    hasMore: outcome.list.has_more && outcome.list.next_cursor !== null,
  };
}

export type RecruitmentPostContextOutcome =
  | {
      readonly kind: "ok";
      readonly context: RecruitmentPostContext;
    }
  | {
      readonly kind: "access_loss";
      readonly accessLoss: RecruitmentPostAccessLossKind;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
    };

export function recruitmentPostContextErrorMessage(
  code: string | null,
): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    case "ACTOR_NOT_AVAILABLE":
      return "Tài khoản hiện không khả dụng.";
    case "RECRUITMENT_POST_ACCESS_DENIED":
      return "Bạn không có quyền truy cập ngữ cảnh bộ lọc tin tuyển dụng.";
    case "RECRUITMENT_POST_UNAVAILABLE":
    default:
      return "Không thể tải danh mục bộ lọc (Dự án, Tỉnh/Thành, KCN, Hình thức tuyển dụng) lúc này. Vui lòng thử tải lại ngữ cảnh.";
  }
}

/**
 * Evaluates the HTTP status + parsed JSON body of `GET /api/recruitment-posts/context`
 * fail-closed so `503` or malformed `200` payloads never fail silently while the feed list renders.
 */
export function resolveRecruitmentPostContextOutcome(input: {
  readonly status: number;
  readonly payload: unknown;
}): RecruitmentPostContextOutcome {
  const errorCode = extractRecruitmentPostErrorCode(input.payload);
  const accessLoss = classifyRecruitmentPostAccessLoss(input.status, errorCode);
  if (accessLoss) {
    return {
      kind: "access_loss",
      accessLoss,
    };
  }

  if (input.status < 200 || input.status >= 300) {
    const resolvedCode = errorCode ?? "RECRUITMENT_POST_UNAVAILABLE";
    return {
      kind: "error",
      code: resolvedCode,
      message: recruitmentPostContextErrorMessage(resolvedCode),
    };
  }

  const parsedContext = parseRecruitmentPostContextEnvelope(input.payload);
  if (!parsedContext) {
    return {
      kind: "error",
      code: "RECRUITMENT_POST_UNAVAILABLE",
      message: recruitmentPostContextErrorMessage(
        "RECRUITMENT_POST_UNAVAILABLE",
      ),
    };
  }

  return {
    kind: "ok",
    context: parsedContext,
  };
}

export type RecruitmentPostContextRequestState = {
  readonly contextLoading: boolean;
  readonly contextError: string | null;
};

/**
 * Transitions context request state when `loadContext()` starts:
 * - On initial mount (`previous.contextError === null`), keeps `contextError: null` so no banner flashes.
 * - On retry after an error (`previous.contextError !== null`), preserves `contextError` while
 *   setting `contextLoading: true` so the banner stays visible and displays `"Đang tải lại…"`.
 */
export function beginRecruitmentPostContextRequest(
  previous: RecruitmentPostContextRequestState,
): RecruitmentPostContextRequestState {
  return {
    contextLoading: true,
    contextError: previous.contextError,
  };
}

/**
 * Transitions context request state when `loadContext()` finishes:
 * - On `error`, stops loading and sets `contextError` to `outcome.message`.
 * - On `ok` or `access_loss`, stops loading and clears `contextError` to `null`.
 */
export function settleRecruitmentPostContextRequest(
  outcome: RecruitmentPostContextOutcome,
): RecruitmentPostContextRequestState {
  if (outcome.kind === "error") {
    return {
      contextLoading: false,
      contextError: outcome.message,
    };
  }
  return {
    contextLoading: false,
    contextError: null,
  };
}

export function recruitmentPostErrorMessage(code: string | null): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
    case "ACTOR_NOT_AVAILABLE":
      return "Tài khoản hiện không khả dụng.";
    case "RECRUITMENT_POST_ACCESS_DENIED":
      return "Bạn không có quyền thực hiện thao tác này.";
    case "RECRUITMENT_POST_NOT_FOUND":
      return "Tin tuyển dụng không tồn tại hoặc đã bị rút.";
    case "RECRUITMENT_POST_STALE":
      return "Dữ liệu phiếu tuyển dụng đã được cập nhật ở nơi khác. Vui lòng tải bản mới nhất để đối chiếu trước khi gửi lại.";
    case "RECRUITMENT_POST_ALREADY_WITHDRAWN":
      return "Phiếu tuyển dụng này đã được rút và không thể chỉnh sửa hoặc rút lại.";
    case "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT":
      return "Khóa định danh thao tác đang được sử dụng cho một nội dung khác.";
    case "RECRUITMENT_POST_INPUT_INVALID":
    case "RECRUITMENT_POST_CONTENT_INVALID":
      return "Dữ liệu biểu mẫu chưa hợp lệ hoặc còn thiếu trường bắt buộc. Vui lòng kiểm tra lại.";
    case "RECRUITMENT_POST_UNAVAILABLE":
    default:
      return "Không thể tải dữ liệu tin tuyển dụng lúc này. Vui lòng thử lại.";
  }
}

// -----------------------------------------------------------------------------
// Markdown Export Builder & Detail-Fetch Export Orchestration
// -----------------------------------------------------------------------------

export type RecruitmentPostMarkdownExportFile = {
  readonly filename: string;
  readonly content: string;
  readonly mimeType: "text/markdown;charset=utf-8";
};

export type RecruitmentPostExportOutcome =
  | {
      readonly kind: "ok";
      readonly post: RecruitmentPostItem;
      readonly file: RecruitmentPostMarkdownExportFile;
    }
  | {
      readonly kind: "access_loss";
      readonly accessLoss: RecruitmentPostAccessLossKind;
    }
  | {
      readonly kind: "error";
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

/**
 * Normalizes and sanitizes `briefId` into a safe `.md` filename without special characters
 * or path separators: `tin-tuyen-dung-<brief-id>.md`.
 */
export function sanitizeRecruitmentPostExportFilename(briefId: string): string {
  const safeId = briefId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `tin-tuyen-dung-${safeId || "ban-tin"}.md`;
}

/**
 * Builds the complete `.md` export file from a server-validated `RecruitmentPostItem`.
 * Includes all 4 BOD sections + section 5 metadata, using `created_by_display_name` and
 * `general.manager_phone` for contact info, and never exposing `general.manager_name`,
 * internal location UUIDs, snapshot tokens, or permission flags.
 */
export function buildRecruitmentPostMarkdownExport(
  item: RecruitmentPostItem,
): RecruitmentPostMarkdownExportFile {
  const detail = toRecruitmentPostDetailViewModel(item);
  const ageRangeDisplay = formatRecruitmentPostAgeRange(
    item.candidate.age_min,
    item.candidate.age_max,
  );
  const incomeRangeDisplay = formatRecruitmentPostIncomeRange(
    item.compensation.average_income_min_vnd,
    item.compensation.average_income_max_vnd,
  );

  const lines: string[] = [
    `# Phiếu tin tuyển dụng — ${detail.section1General.projectName}`,
    "",
    "## 1. Thông tin chung dự án",
    `- **Tên dự án:** ${detail.section1General.projectName}`,
    `- **Tên khách hàng:** ${detail.section1General.customerNameDisplay}`,
    `- **Tỉnh/Thành:** ${detail.section1General.provinceName}`,
    `- **Khu công nghiệp:** ${detail.section1General.industrialParkName}`,
    `- **Vốn đầu tư:** ${detail.section1General.investmentOriginDisplay}`,
    `- **Ngành nghề sản xuất:** ${detail.section1General.manufacturingIndustryDisplay}`,
    `- **Hình thức tuyển dụng:** ${detail.section1General.laborTypesDisplay}`,
    `- **Công việc:** ${detail.section1General.jobDescriptionDisplay}`,
    `- **Môi trường:** ${detail.section1General.environmentTypesDisplay} (Tư thế: ${detail.section1General.workPosturesDisplay})`,
    `- **Thời gian/ca làm:** ${detail.section1General.shiftPatternDisplay} (${detail.section1General.shiftDetailsDisplay})`,
    `- **Lịch cung ứng:** ${detail.section1General.supplyScheduleTextDisplay}`,
    `- **Số lượng dự kiến:** ${detail.section1General.expectedHeadcountDisplay}`,
    `- **Liên hệ người phụ trách:** ${detail.section1General.managerNameDisplay} · ${detail.section1General.managerPhoneDisplay}`,
    "",
    "## 2. Yêu cầu ứng viên",
    `- **Độ tuổi:** ${ageRangeDisplay} (Từ: ${detail.section2CandidateRequirements.ageFromDisplay} — Đến: ${detail.section2CandidateRequirements.ageToDisplay})`,
    `- **Giới tính:** ${detail.section2CandidateRequirements.genderDisplay}`,
    `- **Trình độ tối thiểu:** ${detail.section2CandidateRequirements.minimumEducationDisplay}`,
    `- **Kinh nghiệm:** ${detail.section2CandidateRequirements.experienceRequiredDisplay} (${detail.section2CandidateRequirements.experienceDetailsDisplay})`,
    `- **Nhận người từng làm tại khách hàng:** ${detail.section2CandidateRequirements.acceptsFormerWorkersDisplay}`,
    `- **Hình thức kiểm tra đầu vào:** ${detail.section2CandidateRequirements.entryTestFormatDisplay}`,
    `- **Yêu cầu khác:** ${detail.section2CandidateRequirements.otherRequirementsDisplay}`,
    "",
    "## 3. Lương, thưởng, phụ cấp và phúc lợi",
    `- **Lương cơ bản:** ${detail.section3CompensationBenefits.baseSalaryVndDisplay} (Điều kiện: ${detail.section3CompensationBenefits.baseSalaryConditionsDisplay})`,
    "- **Các khoản thưởng/phụ cấp:**",
    `  - **Thưởng chuyên cần:** ${detail.section3CompensationBenefits.attendanceBonusVndDisplay} (Điều kiện: ${detail.section3CompensationBenefits.attendanceBonusConditionsDisplay})`,
    `  - **Phụ cấp đời sống:** ${detail.section3CompensationBenefits.livingAllowanceVndDisplay} (Điều kiện: ${detail.section3CompensationBenefits.livingAllowanceConditionsDisplay})`,
    `  - **Phụ cấp thâm niên:** ${detail.section3CompensationBenefits.seniorityAllowanceVndDisplay} (Điều kiện: ${detail.section3CompensationBenefits.seniorityAllowanceConditionsDisplay})`,
    `  - **Phụ cấp độc hại/kính hiển vi:** ${detail.section3CompensationBenefits.eyesightAllowanceVndDisplay} (Điều kiện: ${detail.section3CompensationBenefits.eyesightAllowanceConditionsDisplay})`,
    `  - **Phụ cấp khác:** ${detail.section3CompensationBenefits.otherAllowanceTextDisplay}`,
    `- **Thu nhập bình quân dự kiến:** ${incomeRangeDisplay} (Tối thiểu: ${detail.section3CompensationBenefits.averageIncomeMinVndDisplay} — Tối đa: ${detail.section3CompensationBenefits.averageIncomeMaxVndDisplay})`,
    `- **Ngày thanh toán:** ${detail.section3CompensationBenefits.salaryPaymentScheduleDisplay}`,
    `- **Ứng lương:** ${detail.section3CompensationBenefits.salaryAdvanceAvailableDisplay} (Mức ứng: ${detail.section3CompensationBenefits.salaryAdvanceAmountVndDisplay} — Lịch ứng: ${detail.section3CompensationBenefits.salaryAdvanceScheduleDisplay})`,
    `- **Lương tuần:** ${detail.section3CompensationBenefits.weeklySalaryAvailableDisplay} (Lịch trả: ${detail.section3CompensationBenefits.weeklySalaryPaymentScheduleDisplay})`,
    "- **Đủ 8 mức tiền ca:**",
    `  - **Ca ngày 8h:** ${detail.section3CompensationBenefits.dayShift8hVndDisplay}`,
    `  - **Ca ngày 11h:** ${detail.section3CompensationBenefits.dayShift11hVndDisplay}`,
    `  - **Ca đêm 8h:** ${detail.section3CompensationBenefits.nightShift8hVndDisplay}`,
    `  - **Ca đêm 11h:** ${detail.section3CompensationBenefits.nightShift11hVndDisplay}`,
    `  - **Chủ nhật ca ngày 11h:** ${detail.section3CompensationBenefits.sundayDay11hVndDisplay}`,
    `  - **Chủ nhật ca đêm 11h:** ${detail.section3CompensationBenefits.sundayNight11hVndDisplay}`,
    `  - **Ngày lễ ca ngày 11h:** ${detail.section3CompensationBenefits.holidayDay11hVndDisplay}`,
    `  - **Ngày lễ ca đêm 11h:** ${detail.section3CompensationBenefits.holidayNight11hVndDisplay}`,
    `- **Đồng phục/bảo hộ:** ${detail.section3CompensationBenefits.ppeProvidedDisplay} (${detail.section3CompensationBenefits.ppeDetailsDisplay})`,
    `- **Phúc lợi khác:** ${detail.section3CompensationBenefits.otherBenefitsDisplay}`,
    "",
    "## 4. Hồ sơ ứng viên cần chuẩn bị",
    `- **CCCD:** ${detail.section4ApplicationDocuments.requireOriginalCccdAndCopyDisplay}`,
    `- **Sơ yếu lý lịch:** ${detail.section4ApplicationDocuments.requireCertifiedResumeDisplay}`,
    `- **Giấy khám sức khỏe:** ${detail.section4ApplicationDocuments.requireHealthCertificateWithin6MonthsDisplay}`,
    `- **Ảnh 3x4:** ${detail.section4ApplicationDocuments.requirePhoto3x4Display}`,
    `- **Bằng cấp/chứng chỉ:** ${detail.section4ApplicationDocuments.requireDegreeOrCertificateDisplay}`,
    `- **Sổ BHXH:** ${detail.section4ApplicationDocuments.requireSocialInsuranceBookDisplay}`,
    `- **Giấy tờ khác:** ${detail.section4ApplicationDocuments.requireOtherDocumentsDisplay} (${detail.section4ApplicationDocuments.otherDocumentsTextDisplay})`,
    "",
    "## 5. Thông tin bản tin (Metadata)",
    `- **Người đăng:** ${detail.createdByDisplayName}`,
    `- **Thời gian đăng:** ${detail.publishedAtDisplay}`,
    `- **Người cập nhật gần nhất:** ${detail.updatedByDisplayName}`,
    `- **Thời gian cập nhật:** ${detail.updatedAtDisplay}`,
    `- **Mã tin đối chiếu:** ${detail.briefId}`,
    "",
  ];

  return {
    filename: sanitizeRecruitmentPostExportFilename(detail.briefId),
    content: lines.join("\n"),
    mimeType: "text/markdown;charset=utf-8",
  };
}

/**
 * Evaluates the HTTP status + parsed JSON body of `GET /api/recruitment-posts/[briefId]`
 * for the export flow fail-closed:
 * - 401/403 returns `access_loss` and never produces a file.
 * - Non-2xx or invalid/corrupted payload returns `error` and never produces a file.
 * - Valid contract envelope builds the `.md` export file.
 */
export function resolveRecruitmentPostExportOutcome(input: {
  readonly status: number;
  readonly payload: unknown;
}): RecruitmentPostExportOutcome {
  const errorCode = extractRecruitmentPostErrorCode(input.payload);
  const accessLoss = classifyRecruitmentPostAccessLoss(input.status, errorCode);
  if (accessLoss) {
    return {
      kind: "access_loss",
      accessLoss,
    };
  }

  if (input.status < 200 || input.status >= 300) {
    const resolvedCode = errorCode ?? "RECRUITMENT_POST_UNAVAILABLE";
    return {
      kind: "error",
      status: input.status,
      code: resolvedCode,
      message: recruitmentPostErrorMessage(resolvedCode),
    };
  }

  const parsedDetail = parseRecruitmentPostDetailEnvelope(input.payload);
  if (!parsedDetail) {
    return {
      kind: "error",
      status: input.status,
      code: "RECRUITMENT_POST_UNAVAILABLE",
      message: recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
    };
  }

  return {
    kind: "ok",
    post: parsedDetail.post,
    file: buildRecruitmentPostMarkdownExport(parsedDetail.post),
  };
}

/**
 * Fetches the full detail from `GET /api/recruitment-posts/[briefId]`, validates the contract
 * envelope fail-closed, and invokes `onDownload` only when the detail succeeds.
 */
export async function exportRecruitmentPostDetailMarkdown(options: {
  readonly briefId: string;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly onDownload?: (file: RecruitmentPostMarkdownExportFile) => void;
}): Promise<RecruitmentPostExportOutcome> {
  const fetcher = options.fetchImpl ?? fetch;
  try {
    const response = await fetcher(
      `/api/recruitment-posts/${encodeURIComponent(options.briefId)}`,
      {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: options.signal,
      },
    );
    const rawPayload = await response.json().catch(() => null);
    const outcome = resolveRecruitmentPostExportOutcome({
      status: response.status,
      payload: rawPayload,
    });
    if (outcome.kind === "ok") {
      options.onDownload?.(outcome.file);
    }
    return outcome;
  } catch {
    return {
      kind: "error",
      status: 0,
      code: "RECRUITMENT_POST_UNAVAILABLE",
      message: recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
    };
  }
}

// =============================================================================
// PHASE 4 — Authoring Form Draft, Pre-Submit Confirmation, Write Payloads & OCC
// =============================================================================

export type RecruitmentPostFormMode = "create" | "edit";

export type CreateRecruitmentPostRequestBody = {
  readonly project_id: string;
  readonly industrial_park_id: string;
  readonly content: RecruitmentPostContentInput;
};

export type UpdateRecruitmentPostRequestBody = {
  readonly expected_version: number;
  readonly content: RecruitmentPostContentInput;
};

export type WithdrawRecruitmentPostRequestBody = {
  readonly expected_version: number;
};

export const RECRUITMENT_POST_REPOST_BANNER_TEXT =
  "Đang tạo tin mới từ một tin đã rút";

export const RECRUITMENT_POST_REPOST_UNMANAGED_PROJECT_MESSAGE =
  "Bạn không còn phụ trách dự án của tin tuyển dụng này nên không còn quyền đăng lại.";

export const RECRUITMENT_POST_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidRecruitmentPostUuid(
  value: string | null | undefined,
): boolean {
  if (typeof value !== "string") return false;
  return RECRUITMENT_POST_UUID_PATTERN.test(value.trim());
}

export type RecruitmentPostCopyFromOutcome =
  | {
      readonly kind: "ok";
      readonly post: RecruitmentPostItem;
    }
  | {
      readonly kind: "access_loss";
      readonly accessLoss: RecruitmentPostAccessLossKind;
    }
  | {
      readonly kind: "invalid_source";
      readonly code: string;
      readonly message: string;
    };

export function resolveRecruitmentPostCopyFromOutcome(input: {
  readonly status: number;
  readonly payload: unknown;
  readonly context?: RecruitmentPostContext | null;
}): RecruitmentPostCopyFromOutcome {
  const errorCode = extractRecruitmentPostErrorCode(input.payload);
  const accessLoss = classifyRecruitmentPostAccessLoss(input.status, errorCode);
  if (accessLoss) {
    return {
      kind: "access_loss",
      accessLoss,
    };
  }

  if (input.status < 200 || input.status >= 300) {
    const resolvedCode = errorCode ?? "RECRUITMENT_POST_NOT_FOUND";
    return {
      kind: "invalid_source",
      code: resolvedCode,
      message:
        "Không thể sao chép tin tuyển dụng này. Chỉ có thể đăng lại từ một tin đã rút hợp lệ.",
    };
  }

  const parsedDetail = parseRecruitmentPostDetailEnvelope(input.payload);
  if (!parsedDetail) {
    return {
      kind: "invalid_source",
      code: "RECRUITMENT_POST_UNAVAILABLE",
      message: recruitmentPostErrorMessage("RECRUITMENT_POST_UNAVAILABLE"),
    };
  }

  if (parsedDetail.post.status !== "WITHDRAWN") {
    return {
      kind: "invalid_source",
      code: "RECRUITMENT_POST_COPY_SOURCE_NOT_WITHDRAWN",
      message: "Chỉ có thể đăng lại từ tin tuyển dụng ở trạng thái Đã rút.",
    };
  }

  if (
    input.context !== undefined &&
    !isSourceProjectManagedForRepost(
      parsedDetail.post.project.project_id,
      input.context?.managed_projects,
    )
  ) {
    return {
      kind: "invalid_source",
      code: "RECRUITMENT_POST_REPOST_PROJECT_NOT_MANAGED",
      message: RECRUITMENT_POST_REPOST_UNMANAGED_PROJECT_MESSAGE,
    };
  }

  return {
    kind: "ok",
    post: parsedDetail.post,
  };
}

export type RecruitmentPostFormDraftState = {
  readonly mode: RecruitmentPostFormMode;
  readonly expectedVersion: number;
  readonly projectId: string;
  readonly industrialParkId: string;
  readonly lockedProjectDisplayName: string;
  readonly lockedIndustrialParkDisplayName: string;
  readonly lockedProvinceDisplayName: string;
  readonly lockedManagerName?: string;
  readonly lockedHistoricalLaborTypes: ReadonlyArray<{
    readonly labor_type_key: string;
    readonly display_name: string;
  }>;
  readonly repostFromBriefId?: string;
  readonly repostSourceProjectId?: string;
  readonly repostSourceProjectDisplayName?: string;
  readonly repostSourceIndustrialParkId?: string;
  readonly repostSourceIndustrialParkDisplayName?: string;
  readonly repostSourceLaborTypes?: ReadonlyArray<{
    readonly labor_type_key: string;
    readonly display_name: string;
  }>;
  // Section 1: Thông tin chung dự án
  readonly customerName: string;
  readonly investmentOrigin: string;
  readonly manufacturingIndustry: string;
  readonly jobDescription: string;
  readonly environmentTypes: readonly RecruitmentPostEnvironmentType[];
  readonly workPostures: readonly RecruitmentPostWorkPosture[];
  readonly shiftPattern: RecruitmentPostShiftPattern;
  readonly shiftDetails: string;
  readonly managerName: string;
  readonly managerPhone: string;
  readonly laborTypeKeys: readonly string[];
  readonly supplyScheduleText: string;
  readonly expectedHeadcount: string;
  // Section 2: Yêu cầu ứng viên
  readonly ageMin: string;
  readonly ageMax: string;
  readonly genderRequirement: RecruitmentPostGenderRequirement;
  readonly educationRequirement: RecruitmentPostEducationRequirement;
  readonly experienceRequired: boolean;
  readonly experienceDetails: string;
  readonly acceptFormerCustomerWorkers: boolean;
  readonly entryAssessmentText: string;
  readonly otherRequirementsText: string;
  // Section 3: Lương, thưởng và phúc lợi
  readonly baseSalaryVnd: string;
  readonly baseSalaryConditions: string;
  readonly attendanceBonusVnd: string;
  readonly attendanceBonusConditions: string;
  readonly livingAllowanceVnd: string;
  readonly livingAllowanceConditions: string;
  readonly seniorityAllowanceVnd: string;
  readonly seniorityAllowanceConditions: string;
  readonly eyesightAllowanceVnd: string;
  readonly eyesightAllowanceConditions: string;
  readonly otherAllowanceText: string;
  readonly averageIncomeMinVnd: string;
  readonly averageIncomeMaxVnd: string;
  readonly salaryPaymentSchedule: string;
  readonly salaryAdvanceAvailable: boolean;
  readonly salaryAdvanceAmountVnd: string;
  readonly salaryAdvanceSchedule: string;
  readonly weeklySalaryAvailable: boolean;
  readonly weeklySalaryPaymentSchedule: string;
  readonly dayShift8hVnd: string;
  readonly dayShift11hVnd: string;
  readonly nightShift8hVnd: string;
  readonly nightShift11hVnd: string;
  readonly sundayDay11hVnd: string;
  readonly sundayNight11hVnd: string;
  readonly holidayDay11hVnd: string;
  readonly holidayNight11hVnd: string;
  readonly ppeProvided: boolean;
  readonly ppeDetails: string;
  readonly otherBenefits: string;
  // Section 4: Hồ sơ ứng viên cần chuẩn bị
  readonly requireOriginalCccdAndCopy: boolean;
  readonly requireCertifiedResume: boolean;
  readonly requireHealthCertificateWithin6Months: boolean;
  readonly requirePhoto3x4: boolean;
  readonly requireDegreeOrCertificate: boolean;
  readonly requireSocialInsuranceBook: boolean;
  readonly requireOtherDocuments: boolean;
  readonly otherDocumentsText: string;
};

export function createEmptyRecruitmentPostFormDraft(
  mode: RecruitmentPostFormMode = "create",
  options?: { readonly actorDisplayName?: string },
): RecruitmentPostFormDraftState {
  const actorManagerName =
    mode === "create" && typeof options?.actorDisplayName === "string"
      ? options.actorDisplayName.trim()
      : "";
  return {
    mode,
    expectedVersion: 1,
    projectId: "",
    industrialParkId: "",
    lockedProjectDisplayName: "",
    lockedIndustrialParkDisplayName: "",
    lockedProvinceDisplayName: "",
    lockedManagerName: actorManagerName,
    lockedHistoricalLaborTypes: [],
    customerName: "",
    investmentOrigin: "",
    manufacturingIndustry: "",
    jobDescription: "",
    environmentTypes: [],
    workPostures: [],
    shiftPattern: "TWO_SHIFTS",
    shiftDetails: "",
    managerName: actorManagerName,
    managerPhone: "",
    laborTypeKeys: [],
    supplyScheduleText: "",
    expectedHeadcount: "",
    ageMin: "18",
    ageMax: "40",
    genderRequirement: "ANY",
    educationRequirement: "NONE",
    experienceRequired: false,
    experienceDetails: "",
    acceptFormerCustomerWorkers: true,
    entryAssessmentText: "",
    otherRequirementsText: "",
    baseSalaryVnd: "",
    baseSalaryConditions: "",
    attendanceBonusVnd: "",
    attendanceBonusConditions: "",
    livingAllowanceVnd: "",
    livingAllowanceConditions: "",
    seniorityAllowanceVnd: "",
    seniorityAllowanceConditions: "",
    eyesightAllowanceVnd: "",
    eyesightAllowanceConditions: "",
    otherAllowanceText: "",
    averageIncomeMinVnd: "",
    averageIncomeMaxVnd: "",
    salaryPaymentSchedule: "",
    salaryAdvanceAvailable: false,
    salaryAdvanceAmountVnd: "",
    salaryAdvanceSchedule: "",
    weeklySalaryAvailable: false,
    weeklySalaryPaymentSchedule: "",
    dayShift8hVnd: "",
    dayShift11hVnd: "",
    nightShift8hVnd: "",
    nightShift11hVnd: "",
    sundayDay11hVnd: "",
    sundayNight11hVnd: "",
    holidayDay11hVnd: "",
    holidayNight11hVnd: "",
    ppeProvided: false,
    ppeDetails: "",
    otherBenefits: "",
    requireOriginalCccdAndCopy: true,
    requireCertifiedResume: false,
    requireHealthCertificateWithin6Months: false,
    requirePhoto3x4: false,
    requireDegreeOrCertificate: false,
    requireSocialInsuranceBook: false,
    requireOtherDocuments: false,
    otherDocumentsText: "",
  };
}

export function createEditRecruitmentPostFormDraftFromItem(
  item: RecruitmentPostItem,
): RecruitmentPostFormDraftState {
  return {
    mode: "edit",
    expectedVersion: item.version,
    projectId: item.project.project_id,
    industrialParkId: item.industrial_park.industrial_park_id,
    lockedProjectDisplayName: item.project.display_name,
    lockedIndustrialParkDisplayName: item.industrial_park.display_name,
    lockedProvinceDisplayName: item.province.display_name,
    lockedManagerName: item.general.manager_name,
    lockedHistoricalLaborTypes: item.general.labor_types.map((lt) => ({
      labor_type_key: lt.labor_type_key,
      display_name: lt.display_name,
    })),
    customerName: item.general.customer_name,
    investmentOrigin: item.general.investment_origin ?? "",
    manufacturingIndustry: item.general.manufacturing_industry ?? "",
    jobDescription: item.general.job_description,
    environmentTypes: [...item.general.environment_types],
    workPostures: [...item.general.work_postures],
    shiftPattern: item.general.shift_pattern,
    shiftDetails: item.general.shift_details ?? "",
    managerName: item.general.manager_name,
    managerPhone: item.general.manager_phone,
    laborTypeKeys: item.general.labor_types.map((lt) => lt.labor_type_key),
    supplyScheduleText: item.general.supply_schedule_text ?? "",
    expectedHeadcount:
      item.general.expected_headcount !== null
        ? String(item.general.expected_headcount)
        : "",
    ageMin: item.candidate.age_min !== null ? String(item.candidate.age_min) : "",
    ageMax: item.candidate.age_max !== null ? String(item.candidate.age_max) : "",
    genderRequirement: item.candidate.gender_requirement,
    educationRequirement: item.candidate.education_requirement,
    experienceRequired: item.candidate.experience_required,
    experienceDetails: item.candidate.experience_details ?? "",
    acceptFormerCustomerWorkers: item.candidate.accept_former_customer_workers,
    entryAssessmentText: item.candidate.entry_assessment_text ?? "",
    otherRequirementsText: item.candidate.other_requirements_text ?? "",
    baseSalaryVnd: item.compensation.base_salary_vnd ?? "",
    baseSalaryConditions: item.compensation.base_salary_conditions ?? "",
    attendanceBonusVnd: item.compensation.attendance_bonus_vnd ?? "",
    attendanceBonusConditions:
      item.compensation.attendance_bonus_conditions ?? "",
    livingAllowanceVnd: item.compensation.living_allowance_vnd ?? "",
    livingAllowanceConditions:
      item.compensation.living_allowance_conditions ?? "",
    seniorityAllowanceVnd: item.compensation.seniority_allowance_vnd ?? "",
    seniorityAllowanceConditions:
      item.compensation.seniority_allowance_conditions ?? "",
    eyesightAllowanceVnd: item.compensation.eyesight_allowance_vnd ?? "",
    eyesightAllowanceConditions:
      item.compensation.eyesight_allowance_conditions ?? "",
    otherAllowanceText: item.compensation.other_allowance_text ?? "",
    averageIncomeMinVnd: item.compensation.average_income_min_vnd ?? "",
    averageIncomeMaxVnd: item.compensation.average_income_max_vnd ?? "",
    salaryPaymentSchedule: item.compensation.salary_payment_schedule ?? "",
    salaryAdvanceAvailable: item.compensation.salary_advance_available,
    salaryAdvanceAmountVnd: item.compensation.salary_advance_amount_vnd ?? "",
    salaryAdvanceSchedule: item.compensation.salary_advance_schedule ?? "",
    weeklySalaryAvailable: item.compensation.weekly_salary_available,
    weeklySalaryPaymentSchedule:
      item.compensation.weekly_salary_payment_schedule ?? "",
    dayShift8hVnd: item.compensation.day_shift_8h_vnd ?? "",
    dayShift11hVnd: item.compensation.day_shift_11h_vnd ?? "",
    nightShift8hVnd: item.compensation.night_shift_8h_vnd ?? "",
    nightShift11hVnd: item.compensation.night_shift_11h_vnd ?? "",
    sundayDay11hVnd: item.compensation.sunday_day_11h_vnd ?? "",
    sundayNight11hVnd: item.compensation.sunday_night_11h_vnd ?? "",
    holidayDay11hVnd: item.compensation.holiday_day_11h_vnd ?? "",
    holidayNight11hVnd: item.compensation.holiday_night_11h_vnd ?? "",
    ppeProvided: item.compensation.ppe_provided,
    ppeDetails: item.compensation.ppe_details ?? "",
    otherBenefits: item.compensation.other_benefits ?? "",
    requireOriginalCccdAndCopy: item.documents.require_original_cccd_and_copy,
    requireCertifiedResume: item.documents.require_certified_resume,
    requireHealthCertificateWithin6Months:
      item.documents.require_health_certificate_within_6_months,
    requirePhoto3x4: item.documents.require_photo_3x4,
    requireDegreeOrCertificate: item.documents.require_degree_or_certificate,
    requireSocialInsuranceBook: item.documents.require_social_insurance_book,
    requireOtherDocuments: item.documents.require_other_documents,
    otherDocumentsText: item.documents.other_documents_text ?? "",
  };
}

/**
 * Pure helper to build a `mode="create"` form draft from a `WITHDRAWN` `RecruitmentPostItem`.
 * - Copies all 4 sections of content.
 * - Never copies `brief_id`, `version` (resets to 1), `status`, timestamps, old creator/updater/withdrawer,
 *   `allowed_actions`, old `Idempotency-Key`, or historical `general.manager_name`.
 * - Uses `actorDisplayName` for `managerName` / `lockedManagerName`.
 * - When `context` is provided:
 *   - Copies `projectId` only if `item.project.project_id` is in `context.managed_projects` (otherwise sets `""`
 *     so the user cannot auto-repost into an unmanaged project and must select an active managed project).
 *   - Copies `industrialParkId` only if both the park and its province are `active` in `context` (otherwise sets `""`
 *     so the user must select an active industrial park).
 */
export function createCreateRecruitmentPostFormDraftFromItem(
  item: RecruitmentPostItem,
  options?: {
    readonly actorDisplayName?: string;
    readonly context?: RecruitmentPostContext | null;
  },
): RecruitmentPostFormDraftState {
  const actorManagerName =
    typeof options?.actorDisplayName === "string"
      ? options.actorDisplayName.trim()
      : "";
  const context = options?.context ?? null;

  let projectId = item.project.project_id;
  let industrialParkId = item.industrial_park.industrial_park_id;

  if (context) {
    const isManagedProject = context.managed_projects.some(
      (project) => project.project_id === item.project.project_id,
    );
    projectId = isManagedProject ? item.project.project_id : "";

    const activeParks = selectableIndustrialParksForCreate(
      context.industrial_parks,
      context.provinces,
    );
    const isActivePark = activeParks.some(
      (park) =>
        park.industrial_park_id.toLowerCase() ===
        item.industrial_park.industrial_park_id.toLowerCase(),
    );
    industrialParkId = isActivePark
      ? item.industrial_park.industrial_park_id
      : "";
  }

  const repostSourceLaborTypes = item.general.labor_types.map((lt) => ({
    labor_type_key: lt.labor_type_key,
    display_name: lt.display_name,
  }));

  return {
    mode: "create",
    expectedVersion: 1,
    projectId,
    industrialParkId,
    lockedProjectDisplayName: "",
    lockedIndustrialParkDisplayName: "",
    lockedProvinceDisplayName: "",
    lockedManagerName: actorManagerName,
    lockedHistoricalLaborTypes: [],
    repostFromBriefId: item.brief_id,
    repostSourceProjectId: item.project.project_id,
    repostSourceProjectDisplayName: item.project.display_name,
    repostSourceIndustrialParkId: item.industrial_park.industrial_park_id,
    repostSourceIndustrialParkDisplayName: item.industrial_park.display_name,
    repostSourceLaborTypes,
    customerName: item.general.customer_name,
    investmentOrigin: item.general.investment_origin ?? "",
    manufacturingIndustry: item.general.manufacturing_industry ?? "",
    jobDescription: item.general.job_description,
    environmentTypes: [...item.general.environment_types],
    workPostures: [...item.general.work_postures],
    shiftPattern: item.general.shift_pattern,
    shiftDetails: item.general.shift_details ?? "",
    managerName: actorManagerName,
    managerPhone: item.general.manager_phone,
    laborTypeKeys: item.general.labor_types.map((lt) => lt.labor_type_key),
    supplyScheduleText: item.general.supply_schedule_text ?? "",
    expectedHeadcount:
      item.general.expected_headcount !== null
        ? String(item.general.expected_headcount)
        : "",
    ageMin:
      item.candidate.age_min !== null ? String(item.candidate.age_min) : "",
    ageMax:
      item.candidate.age_max !== null ? String(item.candidate.age_max) : "",
    genderRequirement: item.candidate.gender_requirement,
    educationRequirement: item.candidate.education_requirement,
    experienceRequired: item.candidate.experience_required,
    experienceDetails: item.candidate.experience_details ?? "",
    acceptFormerCustomerWorkers: item.candidate.accept_former_customer_workers,
    entryAssessmentText: item.candidate.entry_assessment_text ?? "",
    otherRequirementsText: item.candidate.other_requirements_text ?? "",
    baseSalaryVnd: item.compensation.base_salary_vnd ?? "",
    baseSalaryConditions: item.compensation.base_salary_conditions ?? "",
    attendanceBonusVnd: item.compensation.attendance_bonus_vnd ?? "",
    attendanceBonusConditions:
      item.compensation.attendance_bonus_conditions ?? "",
    livingAllowanceVnd: item.compensation.living_allowance_vnd ?? "",
    livingAllowanceConditions:
      item.compensation.living_allowance_conditions ?? "",
    seniorityAllowanceVnd: item.compensation.seniority_allowance_vnd ?? "",
    seniorityAllowanceConditions:
      item.compensation.seniority_allowance_conditions ?? "",
    eyesightAllowanceVnd: item.compensation.eyesight_allowance_vnd ?? "",
    eyesightAllowanceConditions:
      item.compensation.eyesight_allowance_conditions ?? "",
    otherAllowanceText: item.compensation.other_allowance_text ?? "",
    averageIncomeMinVnd: item.compensation.average_income_min_vnd ?? "",
    averageIncomeMaxVnd: item.compensation.average_income_max_vnd ?? "",
    salaryPaymentSchedule: item.compensation.salary_payment_schedule ?? "",
    salaryAdvanceAvailable: item.compensation.salary_advance_available,
    salaryAdvanceAmountVnd: item.compensation.salary_advance_amount_vnd ?? "",
    salaryAdvanceSchedule: item.compensation.salary_advance_schedule ?? "",
    weeklySalaryAvailable: item.compensation.weekly_salary_available,
    weeklySalaryPaymentSchedule:
      item.compensation.weekly_salary_payment_schedule ?? "",
    dayShift8hVnd: item.compensation.day_shift_8h_vnd ?? "",
    dayShift11hVnd: item.compensation.day_shift_11h_vnd ?? "",
    nightShift8hVnd: item.compensation.night_shift_8h_vnd ?? "",
    nightShift11hVnd: item.compensation.night_shift_11h_vnd ?? "",
    sundayDay11hVnd: item.compensation.sunday_day_11h_vnd ?? "",
    sundayNight11hVnd: item.compensation.sunday_night_11h_vnd ?? "",
    holidayDay11hVnd: item.compensation.holiday_day_11h_vnd ?? "",
    holidayNight11hVnd: item.compensation.holiday_night_11h_vnd ?? "",
    ppeProvided: item.compensation.ppe_provided,
    ppeDetails: item.compensation.ppe_details ?? "",
    otherBenefits: item.compensation.other_benefits ?? "",
    requireOriginalCccdAndCopy: item.documents.require_original_cccd_and_copy,
    requireCertifiedResume: item.documents.require_certified_resume,
    requireHealthCertificateWithin6Months:
      item.documents.require_health_certificate_within_6_months,
    requirePhoto3x4: item.documents.require_photo_3x4,
    requireDegreeOrCertificate: item.documents.require_degree_or_certificate,
    requireSocialInsuranceBook: item.documents.require_social_insurance_book,
    requireOtherDocuments: item.documents.require_other_documents,
    otherDocumentsText: item.documents.other_documents_text ?? "",
  };
}

export type RepostDraftCompatibility = {
  readonly isRepost: boolean;
  readonly projectNotManaged: boolean;
  readonly industrialParkInactive: boolean;
  readonly inactiveLaborTypeKeys: readonly string[];
  readonly warnings: readonly string[];
};

export function inspectRepostDraftCompatibility(
  draft: RecruitmentPostFormDraftState,
  context: RecruitmentPostContext | null,
): RepostDraftCompatibility {
  const isRepost =
    draft.mode === "create" && Boolean(draft.repostFromBriefId);
  if (!isRepost) {
    return {
      isRepost: false,
      projectNotManaged: false,
      industrialParkInactive: false,
      inactiveLaborTypeKeys: [],
      warnings: [],
    };
  }
  if (!context) {
    return {
      isRepost: true,
      projectNotManaged: true,
      industrialParkInactive: false,
      inactiveLaborTypeKeys: [],
      warnings: [RECRUITMENT_POST_REPOST_UNMANAGED_PROJECT_MESSAGE],
    };
  }

  const warnings: string[] = [];

  const sourceProjectId = (
    draft.repostSourceProjectId ?? draft.projectId
  ).trim();
  const sourceProjectManaged = isSourceProjectManagedForRepost(
    sourceProjectId,
    context.managed_projects,
  );
  const projectNotManaged = !sourceProjectManaged;
  if (projectNotManaged) {
    warnings.push(RECRUITMENT_POST_REPOST_UNMANAGED_PROJECT_MESSAGE);
  }

  const activeParks = selectableIndustrialParksForCreate(
    context.industrial_parks,
    context.provinces,
  );
  const sourceParkId = (draft.repostSourceIndustrialParkId ?? "")
    .trim()
    .toLowerCase();
  const sourceParkActive =
    sourceParkId === "" ||
    activeParks.some(
      (park) => park.industrial_park_id.toLowerCase() === sourceParkId,
    );
  const currentParkId = draft.industrialParkId.trim().toLowerCase();
  const currentParkActive =
    currentParkId !== "" &&
    activeParks.some(
      (park) => park.industrial_park_id.toLowerCase() === currentParkId,
    );
  const industrialParkInactive = !sourceParkActive && !currentParkActive;
  if (industrialParkInactive) {
    warnings.push(
      "Khu công nghiệp hoặc Tỉnh/Thành của tin cũ đã ngừng hoạt động. Vui lòng chọn lại Khu công nghiệp đang hoạt động.",
    );
  }

  const activeLaborTypeKeys = new Set(
    context.labor_types
      .filter((item) => item.active)
      .map((item) => item.labor_type_key),
  );
  const inactiveLaborTypeKeys = draft.laborTypeKeys.filter(
    (key) => !activeLaborTypeKeys.has(key),
  );
  if (inactiveLaborTypeKeys.length > 0) {
    warnings.push(
      "Một số hình thức tuyển dụng của tin cũ đã ngừng hoạt động. Vui lòng bỏ chọn mục ngừng hoạt động và chọn lại hình thức đang hoạt động.",
    );
  }

  return {
    isRepost: true,
    projectNotManaged,
    industrialParkInactive,
    inactiveLaborTypeKeys,
    warnings,
  };
}

/**
 * When the user actively changes the Project dropdown in `mode="create"`,
 * updates `projectId` and defaults `customerName` to the selected project's `display_name`.
 * In `mode="edit"`, returns the draft unchanged.
 */
export function applyCreateFormProjectSelection(
  draft: RecruitmentPostFormDraftState,
  nextProjectId: string,
  managedProjects: readonly RecruitmentPostProjectOption[],
): RecruitmentPostFormDraftState {
  if (draft.mode !== "create") {
    return draft;
  }
  const normalizedProjectId = nextProjectId.trim();
  if (!normalizedProjectId) {
    return {
      ...draft,
      projectId: "",
      customerName: "",
    };
  }
  const matchedProject = managedProjects.find(
    (project) => project.project_id === normalizedProjectId,
  );
  return {
    ...draft,
    projectId: normalizedProjectId,
    customerName: matchedProject
      ? matchedProject.display_name
      : draft.customerName,
  };
}

/**
 * Applies context-load defaults in `mode="create"`:
 * - When `draft.projectId` is empty and `context.managed_projects.length === 1`,
 *   auto-selects that single project and defaults `customerName` to its `display_name`
 *   (only if `draft.customerName` has not already been edited by the user).
 * - Never overwrites a user-edited `customerName` when reloading context.
 * - Locks `managerName` to the server-authenticated `actorDisplayName` when provided.
 * - In `mode="edit"`, returns the draft unchanged.
 */
export function applyCreateFormContextDefaults(
  draft: RecruitmentPostFormDraftState,
  context: RecruitmentPostContext,
  actorDisplayName?: string,
): RecruitmentPostFormDraftState {
  if (draft.mode !== "create") {
    return draft;
  }
  const normalizedActorName =
    typeof actorDisplayName === "string" ? actorDisplayName.trim() : "";
  const nextManagerName = normalizedActorName || draft.managerName;

  if (draft.repostFromBriefId) {
    const isManagedProject = context.managed_projects.some(
      (project) => project.project_id === draft.projectId.trim(),
    );
    const activeParks = selectableIndustrialParksForCreate(
      context.industrial_parks,
      context.provinces,
    );
    const isActivePark = activeParks.some(
      (park) =>
        park.industrial_park_id.toLowerCase() ===
        draft.industrialParkId.trim().toLowerCase(),
    );
    return {
      ...draft,
      projectId: isManagedProject ? draft.projectId : "",
      industrialParkId: isActivePark ? draft.industrialParkId : "",
      managerName: nextManagerName,
      lockedManagerName: nextManagerName,
    };
  }

  const singleManagedProject =
    !draft.projectId.trim() && context.managed_projects.length === 1
      ? context.managed_projects[0]
      : null;

  const nextProjectId = singleManagedProject
    ? singleManagedProject.project_id
    : draft.projectId;
  const nextCustomerName =
    singleManagedProject && !draft.customerName.trim()
      ? singleManagedProject.display_name
      : draft.customerName;

  return {
    ...draft,
    projectId: nextProjectId,
    customerName: nextCustomerName,
    managerName: nextManagerName,
    lockedManagerName: nextManagerName,
  };
}

export function setRecruitmentPostExperienceRequired(
  draft: RecruitmentPostFormDraftState,
  experienceRequired: boolean,
): RecruitmentPostFormDraftState {
  return {
    ...draft,
    experienceRequired,
    experienceDetails: experienceRequired ? draft.experienceDetails : "",
  };
}

export function setRecruitmentPostSalaryAdvanceAvailable(
  draft: RecruitmentPostFormDraftState,
  salaryAdvanceAvailable: boolean,
): RecruitmentPostFormDraftState {
  return {
    ...draft,
    salaryAdvanceAvailable,
    salaryAdvanceAmountVnd: salaryAdvanceAvailable
      ? draft.salaryAdvanceAmountVnd
      : "",
    salaryAdvanceSchedule: salaryAdvanceAvailable
      ? draft.salaryAdvanceSchedule
      : "",
  };
}

export function setRecruitmentPostWeeklySalaryAvailable(
  draft: RecruitmentPostFormDraftState,
  weeklySalaryAvailable: boolean,
): RecruitmentPostFormDraftState {
  return {
    ...draft,
    weeklySalaryAvailable,
    weeklySalaryPaymentSchedule: weeklySalaryAvailable
      ? draft.weeklySalaryPaymentSchedule
      : "",
  };
}

export function setRecruitmentPostPpeProvided(
  draft: RecruitmentPostFormDraftState,
  ppeProvided: boolean,
): RecruitmentPostFormDraftState {
  return {
    ...draft,
    ppeProvided,
    ppeDetails: ppeProvided ? draft.ppeDetails : "",
  };
}

export function setRecruitmentPostRequireOtherDocuments(
  draft: RecruitmentPostFormDraftState,
  requireOtherDocuments: boolean,
): RecruitmentPostFormDraftState {
  return {
    ...draft,
    requireOtherDocuments,
    otherDocumentsText: requireOtherDocuments ? draft.otherDocumentsText : "",
  };
}

export function toggleRecruitmentPostEnvironmentType(
  draft: RecruitmentPostFormDraftState,
  envType: RecruitmentPostEnvironmentType,
): RecruitmentPostFormDraftState {
  const exists = draft.environmentTypes.includes(envType);
  const next = exists
    ? draft.environmentTypes.filter((item) => item !== envType)
    : [...draft.environmentTypes, envType];
  return { ...draft, environmentTypes: next };
}

export function toggleRecruitmentPostWorkPosture(
  draft: RecruitmentPostFormDraftState,
  posture: RecruitmentPostWorkPosture,
): RecruitmentPostFormDraftState {
  const exists = draft.workPostures.includes(posture);
  const next = exists
    ? draft.workPostures.filter((item) => item !== posture)
    : [...draft.workPostures, posture];
  return { ...draft, workPostures: next };
}

export function toggleRecruitmentPostLaborTypeKey(
  draft: RecruitmentPostFormDraftState,
  laborTypeKey: string,
): RecruitmentPostFormDraftState {
  const normalized = laborTypeKey.trim();
  if (!normalized) return draft;
  const exists = draft.laborTypeKeys.includes(normalized);
  const next = exists
    ? draft.laborTypeKeys.filter((item) => item !== normalized)
    : [...draft.laborTypeKeys, normalized];
  return { ...draft, laborTypeKeys: next };
}

export function selectableIndustrialParksForCreate(
  industrialParks: readonly RecruitmentPostIndustrialParkOption[],
  provinces: readonly RecruitmentPostProvinceOption[],
): RecruitmentPostIndustrialParkOption[] {
  const activeProvinceIds = new Set(
    provinces.filter((p) => p.active).map((p) => p.province_id),
  );
  return industrialParks.filter(
    (park) => park.active && activeProvinceIds.has(park.province_id),
  );
}

export function deriveProvinceDisplayNameForDraft(
  draft: RecruitmentPostFormDraftState,
  industrialParks: readonly RecruitmentPostIndustrialParkOption[],
  provinces: readonly RecruitmentPostProvinceOption[],
): string {
  if (draft.mode === "edit") {
    return draft.lockedProvinceDisplayName;
  }
  const parkId = draft.industrialParkId.trim().toLowerCase();
  if (!parkId) return "";
  const matchedPark = industrialParks.find(
    (park) => park.industrial_park_id.toLowerCase() === parkId,
  );
  if (!matchedPark) return "";
  const matchedProvince = provinces.find(
    (province) =>
      province.province_id.toLowerCase() ===
      matchedPark.province_id.toLowerCase(),
  );
  return matchedProvince?.display_name ?? "";
}

export function selectableLaborTypesForDraft(
  contextLaborTypes: readonly RecruitmentPostLaborTypeOption[],
  draft: RecruitmentPostFormDraftState,
): RecruitmentPostLaborTypeOption[] {
  const activeList = contextLaborTypes.filter((item) => item.active);
  const repostInactiveSource =
    draft.mode === "create"
      ? (draft.repostSourceLaborTypes ?? []).filter((hist) =>
          draft.laborTypeKeys.includes(hist.labor_type_key),
        )
      : [];
  if (draft.mode !== "edit" && repostInactiveSource.length === 0) {
    return activeList;
  }
  const seenKeys = new Set(activeList.map((item) => item.labor_type_key));
  const merged = [...activeList];
  const historicalItems =
    draft.mode === "edit"
      ? draft.lockedHistoricalLaborTypes
      : repostInactiveSource;
  for (const hist of historicalItems) {
    if (!seenKeys.has(hist.labor_type_key)) {
      const fromCatalog = contextLaborTypes.find(
        (item) => item.labor_type_key === hist.labor_type_key,
      );
      merged.push(
        fromCatalog ?? {
          labor_type_key: hist.labor_type_key,
          display_name: hist.display_name,
          active: false,
        },
      );
      seenKeys.add(hist.labor_type_key);
    }
  }
  return merged;
}

export type NormalizedRecruitmentPostVndResult =
  | {
      readonly ok: true;
      readonly canonical: string;
      readonly formatted: string;
    }
  | {
      readonly ok: false;
      readonly code: "RECRUITMENT_POST_VND_INVALID";
      readonly message: string;
    };

export function normalizeRecruitmentPostVndInput(
  raw: string,
  fieldLabel = "Số tiền",
): NormalizedRecruitmentPostVndResult {
  const res = normalizeNonNegativeVndInput(raw);
  if (!res.ok) {
    return {
      ok: false,
      code: "RECRUITMENT_POST_VND_INVALID",
      message: `${fieldLabel} phải là số nguyên đồng VNĐ không âm hợp lệ.`,
    };
  }
  return {
    ok: true,
    canonical: res.canonical,
    formatted: formatVndMinor(res.canonical),
  };
}

export type RecruitmentPostPreSubmitSummaryViewModel = {
  readonly projectDisplay: string;
  readonly industrialParkAndProvinceDisplay: string;
  readonly jobDescriptionDisplay: string;
  readonly expectedHeadcountDisplay: string;
  readonly expectedIncomeDisplay: string;
  readonly managerContactDisplay: string;
};

/**
 * Builds the 6-item pre-submit confirmation summary block locked in Master Plan lines 601–608:
 * 1. Dự án
 * 2. Khu công nghiệp & Tỉnh/Thành
 * 3. Công việc
 * 4. Số lượng dự kiến
 * 5. Thu nhập bình quân dự kiến
 * 6. Liên hệ người phụ trách
 */
export function buildRecruitmentPostPreSubmitSummary(input: {
  readonly draft: RecruitmentPostFormDraftState;
  readonly managedProjects: readonly RecruitmentPostProjectOption[];
  readonly industrialParks: readonly RecruitmentPostIndustrialParkOption[];
  readonly provinces: readonly RecruitmentPostProvinceOption[];
}): RecruitmentPostPreSubmitSummaryViewModel {
  const { draft, managedProjects, industrialParks, provinces } = input;

  let projectDisplay = "Chưa chọn dự án";
  if (draft.mode === "edit") {
    projectDisplay = draft.lockedProjectDisplayName || "Chưa chọn dự án";
  } else if (draft.projectId.trim()) {
    const matchedProject = managedProjects.find(
      (project) => project.project_id === draft.projectId.trim(),
    );
    projectDisplay = matchedProject
      ? matchedProject.display_name
      : draft.projectId.trim();
  }

  let industrialParkAndProvinceDisplay = "Chưa chọn Khu công nghiệp";
  if (draft.mode === "edit") {
    industrialParkAndProvinceDisplay =
      draft.lockedIndustrialParkDisplayName && draft.lockedProvinceDisplayName
        ? `${draft.lockedIndustrialParkDisplayName} — ${draft.lockedProvinceDisplayName}`
        : draft.lockedIndustrialParkDisplayName || "Chưa chọn Khu công nghiệp";
  } else if (draft.industrialParkId.trim()) {
    const matchedPark = industrialParks.find(
      (park) =>
        park.industrial_park_id.toLowerCase() ===
        draft.industrialParkId.trim().toLowerCase(),
    );
    if (matchedPark) {
      const matchedProvince = provinces.find(
        (prov) =>
          prov.province_id.toLowerCase() ===
          matchedPark.province_id.toLowerCase(),
      );
      industrialParkAndProvinceDisplay = matchedProvince
        ? `${matchedPark.display_name} — ${matchedProvince.display_name}`
        : matchedPark.display_name;
    }
  }

  const jobDescriptionDisplay =
    draft.jobDescription.trim() || "Chưa nhập mô tả công việc";

  const trimmedHeadcount = draft.expectedHeadcount.trim();
  const expectedHeadcountDisplay =
    /^\d+$/.test(trimmedHeadcount) && Number(trimmedHeadcount) >= 0
      ? formatRecruitmentPostHeadcount(Number(trimmedHeadcount))
      : RECRUITMENT_POST_UNPROVIDED_LABEL;

  const minRes = draft.averageIncomeMinVnd.trim()
    ? normalizeRecruitmentPostVndInput(draft.averageIncomeMinVnd)
    : null;
  const maxRes = draft.averageIncomeMaxVnd.trim()
    ? normalizeRecruitmentPostVndInput(draft.averageIncomeMaxVnd)
    : null;
  const expectedIncomeDisplay = formatRecruitmentPostIncomeRange(
    minRes?.ok ? minRes.canonical : null,
    maxRes?.ok ? maxRes.canonical : null,
  );

  const managerPhone = draft.managerPhone.trim();
  const managerContactDisplay =
    managerPhone || "Chưa nhập số điện thoại liên hệ";

  return {
    projectDisplay,
    industrialParkAndProvinceDisplay,
    jobDescriptionDisplay,
    expectedHeadcountDisplay,
    expectedIncomeDisplay,
    managerContactDisplay,
  };
}

export type BuiltRecruitmentPostWriteRequest =
  | {
      readonly ok: true;
      readonly mode: "create";
      readonly requestBody: CreateRecruitmentPostRequestBody;
    }
  | {
      readonly ok: true;
      readonly mode: "edit";
      readonly requestBody: UpdateRecruitmentPostRequestBody;
    }
  | {
      readonly ok: false;
      readonly code: RecruitmentPostErrorCode;
      readonly message: string;
      readonly fieldErrors: Readonly<Record<string, string>>;
    };

function normalizeOptionalDraftText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalDraftVnd(
  raw: string,
  fieldKey: string,
  fieldLabel: string,
  fieldErrors: Record<string, string>,
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const res = normalizeRecruitmentPostVndInput(trimmed, fieldLabel);
  if (!res.ok) {
    fieldErrors[fieldKey] = res.message;
    return null;
  }
  return res.canonical;
}

export function validateAndBuildRecruitmentPostWritePayload(
  draft: RecruitmentPostFormDraftState,
  options?: {
    readonly actorDisplayName?: string;
    readonly context?: RecruitmentPostContext | null;
  },
): BuiltRecruitmentPostWriteRequest {
  const fieldErrors: Record<string, string> = {};
  const context = options?.context ?? null;
  const effectiveManagerName =
    draft.mode === "create" &&
    typeof options?.actorDisplayName === "string" &&
    options.actorDisplayName.trim().length > 0
      ? options.actorDisplayName.trim()
      : draft.mode === "edit" &&
          typeof draft.lockedManagerName === "string" &&
          draft.lockedManagerName.trim().length > 0
        ? draft.lockedManagerName.trim()
        : draft.managerName.trim() || "Người đăng tin";

  if (draft.mode === "create") {
    const trimmedProjectId = draft.projectId.trim();
    if (!trimmedProjectId) {
      if (
        draft.repostFromBriefId &&
        context &&
        draft.repostSourceProjectId &&
        !context.managed_projects.some(
          (p) => p.project_id === draft.repostSourceProjectId,
        )
      ) {
        fieldErrors.projectId = RECRUITMENT_POST_REPOST_UNMANAGED_PROJECT_MESSAGE;
      } else {
        fieldErrors.projectId = "Vui lòng chọn dự án bạn đang quản lý.";
      }
    } else if (
      context &&
      !context.managed_projects.some((p) => p.project_id === trimmedProjectId)
    ) {
      fieldErrors.projectId = RECRUITMENT_POST_REPOST_UNMANAGED_PROJECT_MESSAGE;
    }

    const trimmedParkId = draft.industrialParkId.trim().toLowerCase();
    if (!trimmedParkId) {
      fieldErrors.industrialParkId = "Vui lòng chọn Khu công nghiệp.";
    } else if (context) {
      const activeParks = selectableIndustrialParksForCreate(
        context.industrial_parks,
        context.provinces,
      );
      if (
        !activeParks.some(
          (park) => park.industrial_park_id.toLowerCase() === trimmedParkId,
        )
      ) {
        fieldErrors.industrialParkId =
          "Khu công nghiệp hoặc Tỉnh/Thành đã ngừng hoạt động. Vui lòng chọn lại Khu công nghiệp đang hoạt động.";
      }
    }
  } else if (
    !Number.isSafeInteger(draft.expectedVersion) ||
    draft.expectedVersion < 1
  ) {
    fieldErrors.expectedVersion = "Phiên bản đối chiếu không hợp lệ.";
  }

  if (!draft.customerName.trim()) {
    fieldErrors.customerName = "Vui lòng nhập tên khách hàng.";
  }
  if (!draft.jobDescription.trim()) {
    fieldErrors.jobDescription = "Vui lòng nhập mô tả công việc.";
  }
  if (draft.shiftPattern === "OTHER" && !draft.shiftDetails.trim()) {
    fieldErrors.shiftDetails =
      "Vui lòng nhập chi tiết ca làm việc khi chọn Khác.";
  }
  const phoneDigits = draft.managerPhone.trim().replace(/[^0-9]/g, "");
  if (!draft.managerPhone.trim() || phoneDigits.length < 6) {
    fieldErrors.managerPhone =
      "Vui lòng nhập số điện thoại liên hệ hợp lệ (tối thiểu 6 chữ số).";
  }
  if (draft.laborTypeKeys.length === 0) {
    fieldErrors.laborTypeKeys =
      "Vui lòng chọn ít nhất một hình thức tuyển dụng.";
  } else if (draft.mode === "create" && context) {
    const activeLaborKeys = new Set(
      context.labor_types
        .filter((item) => item.active)
        .map((item) => item.labor_type_key),
    );
    const hasInactiveLaborType = draft.laborTypeKeys.some(
      (key) => !activeLaborKeys.has(key),
    );
    if (hasInactiveLaborType) {
      fieldErrors.laborTypeKeys =
        "Hình thức tuyển dụng có mục đã ngừng hoạt động. Vui lòng bỏ chọn mục ngừng hoạt động và chọn lại hình thức đang hoạt động.";
    }
  }

  let expectedHeadcount: number | null = null;
  const trimmedHeadcount = draft.expectedHeadcount.trim();
  if (trimmedHeadcount !== "") {
    if (
      !/^\d+$/.test(trimmedHeadcount) ||
      Number(trimmedHeadcount) < 0 ||
      Number(trimmedHeadcount) > RECRUITMENT_POST_MAX_EXPECTED_HEADCOUNT
    ) {
      fieldErrors.expectedHeadcount = `Số lượng dự kiến phải là số nguyên từ 0 đến ${RECRUITMENT_POST_MAX_EXPECTED_HEADCOUNT}.`;
    } else {
      expectedHeadcount = Number(trimmedHeadcount);
    }
  }

  let ageMin: number | null = null;
  const trimmedAgeMin = draft.ageMin.trim();
  if (trimmedAgeMin !== "") {
    if (
      !/^\d+$/.test(trimmedAgeMin) ||
      Number(trimmedAgeMin) < RECRUITMENT_POST_AGE_MIN ||
      Number(trimmedAgeMin) > RECRUITMENT_POST_AGE_MAX
    ) {
      fieldErrors.ageMin = `Độ tuổi tối thiểu phải từ ${RECRUITMENT_POST_AGE_MIN} đến ${RECRUITMENT_POST_AGE_MAX}.`;
    } else {
      ageMin = Number(trimmedAgeMin);
    }
  }

  let ageMax: number | null = null;
  const trimmedAgeMax = draft.ageMax.trim();
  if (trimmedAgeMax !== "") {
    if (
      !/^\d+$/.test(trimmedAgeMax) ||
      Number(trimmedAgeMax) < RECRUITMENT_POST_AGE_MIN ||
      Number(trimmedAgeMax) > RECRUITMENT_POST_AGE_MAX
    ) {
      fieldErrors.ageMax = `Độ tuổi tối đa phải từ ${RECRUITMENT_POST_AGE_MIN} đến ${RECRUITMENT_POST_AGE_MAX}.`;
    } else {
      ageMax = Number(trimmedAgeMax);
    }
  }

  if (ageMin !== null && ageMax !== null && ageMax < ageMin) {
    fieldErrors.ageMax =
      "Độ tuổi tối đa phải lớn hơn hoặc bằng độ tuổi tối thiểu.";
  }

  if (draft.experienceRequired && !draft.experienceDetails.trim()) {
    fieldErrors.experienceDetails =
      "Vui lòng nhập chi tiết yêu cầu kinh nghiệm.";
  }

  const baseSalaryVnd = normalizeOptionalDraftVnd(
    draft.baseSalaryVnd,
    "baseSalaryVnd",
    "Lương cơ bản",
    fieldErrors,
  );
  const attendanceBonusVnd = normalizeOptionalDraftVnd(
    draft.attendanceBonusVnd,
    "attendanceBonusVnd",
    "Thưởng chuyên cần",
    fieldErrors,
  );
  const livingAllowanceVnd = normalizeOptionalDraftVnd(
    draft.livingAllowanceVnd,
    "livingAllowanceVnd",
    "Phụ cấp đời sống",
    fieldErrors,
  );
  const seniorityAllowanceVnd = normalizeOptionalDraftVnd(
    draft.seniorityAllowanceVnd,
    "seniorityAllowanceVnd",
    "Phụ cấp thâm niên",
    fieldErrors,
  );
  const eyesightAllowanceVnd = normalizeOptionalDraftVnd(
    draft.eyesightAllowanceVnd,
    "eyesightAllowanceVnd",
    "Phụ cấp soi kính",
    fieldErrors,
  );
  const averageIncomeMinVnd = normalizeOptionalDraftVnd(
    draft.averageIncomeMinVnd,
    "averageIncomeMinVnd",
    "Thu nhập bình quân tối thiểu",
    fieldErrors,
  );
  const averageIncomeMaxVnd = normalizeOptionalDraftVnd(
    draft.averageIncomeMaxVnd,
    "averageIncomeMaxVnd",
    "Thu nhập bình quân tối đa",
    fieldErrors,
  );
  if (
    averageIncomeMinVnd !== null &&
    averageIncomeMaxVnd !== null &&
    BigInt(averageIncomeMaxVnd) < BigInt(averageIncomeMinVnd)
  ) {
    fieldErrors.averageIncomeMaxVnd =
      "Thu nhập bình quân tối đa phải lớn hơn hoặc bằng mức tối thiểu.";
  }

  const salaryAdvanceAmountVnd = draft.salaryAdvanceAvailable
    ? normalizeOptionalDraftVnd(
        draft.salaryAdvanceAmountVnd,
        "salaryAdvanceAmountVnd",
        "Mức ứng lương",
        fieldErrors,
      )
    : null;

  const dayShift8hVnd = normalizeOptionalDraftVnd(
    draft.dayShift8hVnd,
    "dayShift8hVnd",
    "Ca ngày 8 giờ",
    fieldErrors,
  );
  const dayShift11hVnd = normalizeOptionalDraftVnd(
    draft.dayShift11hVnd,
    "dayShift11hVnd",
    "Ca ngày 11 giờ",
    fieldErrors,
  );
  const nightShift8hVnd = normalizeOptionalDraftVnd(
    draft.nightShift8hVnd,
    "nightShift8hVnd",
    "Ca đêm 8 giờ",
    fieldErrors,
  );
  const nightShift11hVnd = normalizeOptionalDraftVnd(
    draft.nightShift11hVnd,
    "nightShift11hVnd",
    "Ca đêm 11 giờ",
    fieldErrors,
  );
  const sundayDay11hVnd = normalizeOptionalDraftVnd(
    draft.sundayDay11hVnd,
    "sundayDay11hVnd",
    "Chủ nhật ngày 11 giờ",
    fieldErrors,
  );
  const sundayNight11hVnd = normalizeOptionalDraftVnd(
    draft.sundayNight11hVnd,
    "sundayNight11hVnd",
    "Chủ nhật đêm 11 giờ",
    fieldErrors,
  );
  const holidayDay11hVnd = normalizeOptionalDraftVnd(
    draft.holidayDay11hVnd,
    "holidayDay11hVnd",
    "Lễ ngày 11 giờ",
    fieldErrors,
  );
  const holidayNight11hVnd = normalizeOptionalDraftVnd(
    draft.holidayNight11hVnd,
    "holidayNight11hVnd",
    "Lễ đêm 11 giờ",
    fieldErrors,
  );

  if (draft.requireOtherDocuments && !draft.otherDocumentsText.trim()) {
    fieldErrors.otherDocumentsText =
      "Vui lòng nhập nội dung giấy tờ khác cần chuẩn bị.";
  }

  if (Object.keys(fieldErrors).length > 0) {
    const firstMessage = Object.values(fieldErrors)[0];
    return {
      ok: false,
      code: "RECRUITMENT_POST_CONTENT_INVALID",
      message: firstMessage,
      fieldErrors,
    };
  }

  const contentCandidate: RecruitmentPostContentInput = {
    general: {
      customer_name: draft.customerName.trim(),
      investment_origin: normalizeOptionalDraftText(draft.investmentOrigin),
      manufacturing_industry: normalizeOptionalDraftText(
        draft.manufacturingIndustry,
      ),
      job_description: draft.jobDescription.trim(),
      environment_types: [...draft.environmentTypes],
      work_postures: [...draft.workPostures],
      shift_pattern: draft.shiftPattern,
      shift_details: normalizeOptionalDraftText(draft.shiftDetails),
      manager_name: effectiveManagerName,
      manager_phone: draft.managerPhone.trim(),
      labor_type_keys: [...draft.laborTypeKeys],
      supply_schedule_text: normalizeOptionalDraftText(
        draft.supplyScheduleText,
      ),
      expected_headcount: expectedHeadcount,
    },
    candidate: {
      age_min: ageMin,
      age_max: ageMax,
      gender_requirement: draft.genderRequirement,
      education_requirement: draft.educationRequirement,
      experience_required: draft.experienceRequired,
      experience_details: draft.experienceRequired
        ? normalizeOptionalDraftText(draft.experienceDetails)
        : null,
      accept_former_customer_workers: draft.acceptFormerCustomerWorkers,
      entry_assessment_text: normalizeOptionalDraftText(
        draft.entryAssessmentText,
      ),
      other_requirements_text: normalizeOptionalDraftText(
        draft.otherRequirementsText,
      ),
    },
    compensation: {
      base_salary_vnd: baseSalaryVnd,
      base_salary_conditions: normalizeOptionalDraftText(
        draft.baseSalaryConditions,
      ),
      attendance_bonus_vnd: attendanceBonusVnd,
      attendance_bonus_conditions: normalizeOptionalDraftText(
        draft.attendanceBonusConditions,
      ),
      living_allowance_vnd: livingAllowanceVnd,
      living_allowance_conditions: normalizeOptionalDraftText(
        draft.livingAllowanceConditions,
      ),
      seniority_allowance_vnd: seniorityAllowanceVnd,
      seniority_allowance_conditions: normalizeOptionalDraftText(
        draft.seniorityAllowanceConditions,
      ),
      eyesight_allowance_vnd: eyesightAllowanceVnd,
      eyesight_allowance_conditions: normalizeOptionalDraftText(
        draft.eyesightAllowanceConditions,
      ),
      other_allowance_text: normalizeOptionalDraftText(
        draft.otherAllowanceText,
      ),
      average_income_min_vnd: averageIncomeMinVnd,
      average_income_max_vnd: averageIncomeMaxVnd,
      salary_payment_schedule: normalizeOptionalDraftText(
        draft.salaryPaymentSchedule,
      ),
      salary_advance_available: draft.salaryAdvanceAvailable,
      salary_advance_amount_vnd: salaryAdvanceAmountVnd,
      salary_advance_schedule: draft.salaryAdvanceAvailable
        ? normalizeOptionalDraftText(draft.salaryAdvanceSchedule)
        : null,
      weekly_salary_available: draft.weeklySalaryAvailable,
      weekly_salary_payment_schedule: draft.weeklySalaryAvailable
        ? normalizeOptionalDraftText(draft.weeklySalaryPaymentSchedule)
        : null,
      day_shift_8h_vnd: dayShift8hVnd,
      day_shift_11h_vnd: dayShift11hVnd,
      night_shift_8h_vnd: nightShift8hVnd,
      night_shift_11h_vnd: nightShift11hVnd,
      sunday_day_11h_vnd: sundayDay11hVnd,
      sunday_night_11h_vnd: sundayNight11hVnd,
      holiday_day_11h_vnd: holidayDay11hVnd,
      holiday_night_11h_vnd: holidayNight11hVnd,
      ppe_provided: draft.ppeProvided,
      ppe_details: draft.ppeProvided
        ? normalizeOptionalDraftText(draft.ppeDetails)
        : null,
      other_benefits: normalizeOptionalDraftText(draft.otherBenefits),
    },
    documents: {
      require_original_cccd_and_copy: draft.requireOriginalCccdAndCopy,
      require_certified_resume: draft.requireCertifiedResume,
      require_health_certificate_within_6_months:
        draft.requireHealthCertificateWithin6Months,
      require_photo_3x4: draft.requirePhoto3x4,
      require_degree_or_certificate: draft.requireDegreeOrCertificate,
      require_social_insurance_book: draft.requireSocialInsuranceBook,
      require_other_documents: draft.requireOtherDocuments,
      other_documents_text: draft.requireOtherDocuments
        ? normalizeOptionalDraftText(draft.otherDocumentsText)
        : null,
    },
  };

  if (draft.mode === "create") {
    const rawBody = {
      project_id: draft.projectId.trim(),
      industrial_park_id: draft.industrialParkId.trim().toLowerCase(),
      content: contentCandidate,
    };
    const parsed = parseCreateRecruitmentPostBody(rawBody);
    if (!parsed.ok) {
      return {
        ok: false,
        code: parsed.code,
        message: recruitmentPostErrorMessage(parsed.code),
        fieldErrors: {},
      };
    }
    return {
      ok: true,
      mode: "create",
      requestBody: {
        project_id: parsed.value.project_id,
        industrial_park_id: parsed.value.industrial_park_id,
        content: parsed.value.content,
      },
    };
  }

  const rawBody = {
    expected_version: draft.expectedVersion,
    content: contentCandidate,
  };
  const parsed = parseUpdateRecruitmentPostBody(rawBody);
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code,
      message: recruitmentPostErrorMessage(parsed.code),
      fieldErrors: {},
    };
  }
  return {
    ok: true,
    mode: "edit",
    requestBody: {
      expected_version: parsed.value.expected_version,
      content: parsed.value.content,
    },
  };
}

export function buildWithdrawRecruitmentPostRequestBody(
  expectedVersion: number,
):
  | {
      readonly ok: true;
      readonly requestBody: WithdrawRecruitmentPostRequestBody;
    }
  | {
      readonly ok: false;
      readonly code: RecruitmentPostErrorCode;
      readonly message: string;
    } {
  const parsed = parseWithdrawRecruitmentPostBody({
    expected_version: expectedVersion,
  });
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code,
      message: recruitmentPostErrorMessage(parsed.code),
    };
  }
  return {
    ok: true,
    requestBody: {
      expected_version: parsed.value.expected_version,
    },
  };
}

export function parseRecruitmentPostMutationEnvelope(
  payload: unknown,
): RecruitmentPostMutationResult | null {
  if (!isPlainRecord(payload) || payload.ok !== true) return null;
  return projectRecruitmentPostMutation(payload.data);
}

export type RecruitmentPostMutationOutcome =
  | {
      readonly kind: "ok";
      readonly result: RecruitmentPostMutationResult;
    }
  | {
      readonly kind: "access_loss";
      readonly accessLoss: RecruitmentPostAccessLossKind;
    }
  | {
      readonly kind: "conflict_stale";
      readonly code: "RECRUITMENT_POST_STALE";
      readonly message: string;
    }
  | {
      readonly kind: "already_withdrawn";
      readonly code: "RECRUITMENT_POST_ALREADY_WITHDRAWN";
      readonly message: string;
    }
  | {
      readonly kind: "ambiguous_retry_lock";
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "error";
      readonly code: string;
      readonly message: string;
    };

/**
 * Classifies write outcomes (`POST /api/recruitment-posts`, `PATCH /api/recruitment-posts/[briefId]`,
 * `POST /api/recruitment-posts/[briefId]/withdraw`):
 * - `200`/`201` with valid `RecruitmentPostMutationResult` -> `ok`
 * - `401`/`403` -> `access_loss`
 * - `409 RECRUITMENT_POST_STALE` -> `conflict_stale` (keep draft, allow reload-to-compare, never auto-resubmit)
 * - `409 RECRUITMENT_POST_ALREADY_WITHDRAWN` -> `already_withdrawn`
 * - `0` (network error/timeout), `502`/`503`/`504`, `5xx`, or malformed `2xx` -> `ambiguous_retry_lock`
 *   (locks form editing and preserves exact payload + `Idempotency-Key` for safe retry or reload)
 */
export function resolveRecruitmentPostMutationOutcome(input: {
  readonly status: number;
  readonly payload: unknown;
}): RecruitmentPostMutationOutcome {
  const errorCode = extractRecruitmentPostErrorCode(input.payload);
  const accessLoss = classifyRecruitmentPostAccessLoss(input.status, errorCode);
  if (accessLoss) {
    return {
      kind: "access_loss",
      accessLoss,
    };
  }

  if (input.status >= 200 && input.status < 300) {
    const parsed = parseRecruitmentPostMutationEnvelope(input.payload);
    if (!parsed) {
      return {
        kind: "ambiguous_retry_lock",
        code: "RECRUITMENT_POST_UNAVAILABLE",
        message:
          "Máy chủ trả về phản hồi không thể xác minh sau khi gửi yêu cầu. Biểu mẫu đã được khóa tạm thời; vui lòng bấm 'Gửi lại đúng yêu cầu' hoặc 'Tải bản mới nhất để đối chiếu'.",
      };
    }
    return {
      kind: "ok",
      result: parsed,
    };
  }

  if (input.status === 409 && errorCode === "RECRUITMENT_POST_STALE") {
    return {
      kind: "conflict_stale",
      code: "RECRUITMENT_POST_STALE",
      message: recruitmentPostErrorMessage("RECRUITMENT_POST_STALE"),
    };
  }

  if (
    input.status === 409 &&
    errorCode === "RECRUITMENT_POST_ALREADY_WITHDRAWN"
  ) {
    return {
      kind: "already_withdrawn",
      code: "RECRUITMENT_POST_ALREADY_WITHDRAWN",
      message: recruitmentPostErrorMessage("RECRUITMENT_POST_ALREADY_WITHDRAWN"),
    };
  }

  if (
    input.status === 0 ||
    input.status === 408 ||
    input.status === 429 ||
    input.status >= 500 ||
    errorCode === "RECRUITMENT_POST_UNAVAILABLE"
  ) {
    return {
      kind: "ambiguous_retry_lock",
      code: errorCode ?? "RECRUITMENT_POST_UNAVAILABLE",
      message:
        "Mất kết nối hoặc chưa xác nhận được kết quả xử lý trên máy chủ. Để tránh tạo bản ghi trùng, biểu mẫu đang được khóa chỉnh sửa — bạn chỉ có thể gửi lại đúng yêu cầu với cùng khóa định danh hoặc tải bản mới nhất để đối chiếu.",
    };
  }

  const resolvedCode = errorCode ?? "RECRUITMENT_POST_INPUT_INVALID";
  return {
    kind: "error",
    code: resolvedCode,
    message: recruitmentPostErrorMessage(resolvedCode),
  };
}
