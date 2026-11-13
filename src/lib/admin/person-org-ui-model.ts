/**
 * WP4 — Pure, browser-safe UI model for Internal Organization Persons Administration.
 *
 * Imports DTOs, constants, parsers, and projectors directly from
 * `src/lib/organization/person-contract.ts` and `src/lib/departments/department-contract.ts`
 * without duplicating a second contract or pulling `node:crypto` fingerprint helpers
 * into browser bundles.
 */
import type { BadgeTone } from "../../components/ui/badge.tsx";
import {
  parseAssignPersonMemberBody,
  parseEndPersonMemberBody,
  projectDepartmentPersonMemberMutationResponse,
  type DepartmentPersonMemberMutationProjection,
  type PersonDeptMembershipProjection,
} from "../departments/department-contract.ts";
import { newIdempotencyKey } from "../direct-entry/project-operations-model.ts";
import {
  ACCOUNT_TYPES,
  CONTROL_CHAR_PATTERN,
  DEFAULT_ORG_PAGE_SIZE,
  EMPLOYEE_CODE_MAX_LENGTH,
  EMPLOYEE_CODE_MIN_LENGTH,
  EMPLOYEE_CODE_PROJECT_WORKER_PATTERN,
  FULL_NAME_MAX_LENGTH,
  FULL_NAME_MIN_LENGTH,
  MAX_ORG_PAGE,
  ORGANIZATION_ERROR_CODES,
  PERSON_FILTER_STATUSES,
  PERSON_LINK_STATES,
  PERSON_SOURCE_KINDS,
  PERSON_STATUSES,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  SEARCH_MAX_LENGTH,
  isValidIsoDate,
  isValidUuid,
  organizationErrorStatus,
  parseCreatePersonBody,
  parseEmployeeCode,
  parseFullName,
  parseListPersonsQuery,
  parseSafeReason,
  parseTransferPersonDepartmentBody,
  parseUpdatePersonBody,
  projectGetPersonResponse,
  projectListPersonsResponse,
  projectMutatePersonResponse,
  projectTransferPersonDepartmentResponse,
  type AccountType,
  type CreatePersonBody,
  type GetPersonRpcProjection,
  type ListPersonsQuery,
  type ListPersonsRpcProjection,
  type MutatePersonRpcProjection,
  type OrganizationErrorCode,
  type PersonActiveAccountLinkProjection,
  type PersonActiveDepartmentProjection,
  type PersonDepartmentHistoryProjection,
  type PersonDetailProjection,
  type PersonFilterStatus,
  type PersonHeadHistoryProjection,
  type PersonLinkState,
  type PersonSourceKind,
  type PersonStatus,
  type PersonSummaryProjection,
  type TransferPersonDepartmentBody,
  type TransferPersonDepartmentRpcProjection,
  type UpdatePersonBody,
} from "../organization/person-contract.ts";

export {
  ACCOUNT_TYPES,
  DEFAULT_ORG_PAGE_SIZE,
  EMPLOYEE_CODE_MAX_LENGTH,
  EMPLOYEE_CODE_MIN_LENGTH,
  EMPLOYEE_CODE_PROJECT_WORKER_PATTERN,
  FULL_NAME_MAX_LENGTH,
  FULL_NAME_MIN_LENGTH,
  MAX_ORG_PAGE,
  ORGANIZATION_ERROR_CODES,
  PERSON_FILTER_STATUSES,
  PERSON_LINK_STATES,
  PERSON_SOURCE_KINDS,
  PERSON_STATUSES,
  REASON_MAX_LENGTH,
  REASON_MIN_LENGTH,
  SEARCH_MAX_LENGTH,
  organizationErrorStatus,
  type AccountType,
  type DepartmentPersonMemberMutationProjection,
  type GetPersonRpcProjection,
  type ListPersonsQuery,
  type ListPersonsRpcProjection,
  type MutatePersonRpcProjection,
  type OrganizationErrorCode,
  type PersonActiveAccountLinkProjection,
  type PersonActiveDepartmentProjection,
  type PersonDepartmentHistoryProjection,
  type PersonDeptMembershipProjection,
  type PersonDetailProjection,
  type PersonFilterStatus,
  type PersonHeadHistoryProjection,
  type PersonLinkState,
  type PersonSourceKind,
  type PersonStatus,
  type PersonSummaryProjection,
  type TransferPersonDepartmentRpcProjection,
};

export type PersonOrgRequestResult<T> =
  | { ok: true; body: T; idempotencyKey: string }
  | { ok: false; message: string };

export type PersonOrgMutationOp =
  | "create"
  | "update"
  | "assign-department"
  | "transfer-department"
  | "end-department";

export type PersonOrgReadError = {
  kind: "unauthenticated" | "denied" | "not-found" | "unavailable";
  message: string;
  retryable: boolean;
};

export type PersonOrgMutationOutcome<T = unknown> =
  | {
      kind: "applied";
      replayed: boolean;
      data: T;
      message: string;
    }
  | {
      kind: "session-lost";
      sessionState: "unauthenticated" | "denied";
      message: string;
      preserveIdempotencyKey: false;
    }
  | {
      kind: "conflict";
      message: string;
      preserveIdempotencyKey: false;
    }
  | {
      kind: "active-head-block";
      message: string;
      preserveIdempotencyKey: false;
    }
  | {
      kind: "business-error";
      code: string;
      message: string;
      preserveIdempotencyKey: false;
    }
  | {
      kind: "not-found";
      message: string;
      preserveIdempotencyKey: false;
    }
  | {
      kind: "invalid";
      message: string;
      preserveIdempotencyKey: false;
    }
  | {
      kind: "uncertain";
      message: string;
      preserveIdempotencyKey: true;
    };

export function normalizeOrgUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!isValidUuid(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function newOrgIdempotencyKey(): string {
  return newIdempotencyKey();
}

export function sanitizeOrgSearchInput(value: string): string {
  return value.replace(/[\x00-\x1F\x7F]/g, "").slice(0, SEARCH_MAX_LENGTH);
}

export function formatOrgTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatOrgDate(isoDate: string | null): string {
  if (!isoDate) return "—";
  if (!isValidIsoDate(isoDate)) return "—";
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

export function personStatusBadge(status: PersonStatus): {
  label: string;
  tone: BadgeTone;
} {
  return status === "ACTIVE"
    ? { label: "Đang hoạt động", tone: "success" }
    : { label: "Ngừng hoạt động", tone: "neutral" };
}

export function formatPersonSourceKind(
  sourceKind: PersonSourceKind,
  evidenceDate: string | null,
): string {
  switch (sourceKind) {
    case "ADMIN_MUTATION":
      return "Thao tác quản trị";
    case "BACKFILL_DATE_EVIDENCE":
      return evidenceDate
        ? `Đối chiếu chứng từ (${formatOrgDate(evidenceDate)})`
        : "Đối chiếu chứng từ";
    case "BACKFILL_CURRENT_STATE_ONLY":
      return "Khởi tạo hiện trạng";
  }
}

export function accountTypeLabel(accountType: AccountType): {
  label: string;
  shortLabel: string;
  tone: BadgeTone;
} {
  switch (accountType) {
    case "NORMAL":
      return { label: "Cá nhân (NORMAL)", shortLabel: "Cá nhân", tone: "info" };
    case "SHARED":
      return { label: "Dùng chung (SHARED)", shortLabel: "Dùng chung", tone: "warning" };
    case "SERVICE":
      return { label: "Dịch vụ (SERVICE)", shortLabel: "Dịch vụ", tone: "neutral" };
  }
}

export type PersonListFilterState = {
  search: string;
  status: PersonFilterStatus;
  departmentId: string | null;
  linkState: PersonLinkState;
  page: number;
  pageSize?: number;
};

/**
 * Xây dựng query chuẩn cho GET /api/admin/organization/persons.
 * - Khi `departmentId` là null/rỗng/"all", bỏ hẳn tham số `department_id` (tuyệt đối không gửi "unassigned").
 * - Kiểm tra chéo qua `parseListPersonsQuery` của contract.
 */
export function buildPersonListQuery(
  input: PersonListFilterState,
): URLSearchParams | null {
  if (CONTROL_CHAR_PATTERN.test(input.search)) return null;
  const trimmedSearch = input.search.trim();
  if (trimmedSearch.length > SEARCH_MAX_LENGTH) return null;

  let normalizedDeptId: string | null = null;
  if (input.departmentId !== null && input.departmentId !== "" && input.departmentId !== "all") {
    normalizedDeptId = normalizeOrgUuid(input.departmentId);
    if (!normalizedDeptId) return null;
  }

  const pageSize = input.pageSize ?? DEFAULT_ORG_PAGE_SIZE;
  const params = new URLSearchParams();
  if (trimmedSearch !== "") {
    params.set("search", trimmedSearch);
  }
  params.set("status", input.status);
  if (normalizedDeptId !== null) {
    params.set("department_id", normalizedDeptId);
  }
  params.set("link_state", input.linkState);
  params.set("page", String(input.page));
  params.set("page_size", String(pageSize));

  const checked = parseListPersonsQuery(
    new URL(`http://localhost/api/admin/organization/persons?${params.toString()}`),
  );
  if (!checked.ok) return null;
  return params;
}

function unwrapOkPayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return null;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) {
    if (k !== "ok") rest[k] = v;
  }
  return rest;
}

export function projectPersonListEnvelope(
  payload: unknown,
  expectedQuery: PersonListFilterState,
): ListPersonsRpcProjection | null {
  const rest = unwrapOkPayload(payload);
  if (!rest) return null;
  const projected = projectListPersonsResponse(rest);
  if (!projected) return null;

  const expectedSearch = expectedQuery.search.trim() || null;
  const expectedDept =
    expectedQuery.departmentId && expectedQuery.departmentId !== "all"
      ? normalizeOrgUuid(expectedQuery.departmentId)
      : null;
  const expectedPageSize = expectedQuery.pageSize ?? DEFAULT_ORG_PAGE_SIZE;

  if (
    projected.search !== expectedSearch ||
    projected.status !== expectedQuery.status ||
    projected.department_id !== expectedDept ||
    projected.link_state !== expectedQuery.linkState ||
    projected.page !== expectedQuery.page ||
    projected.page_size !== expectedPageSize
  ) {
    return null;
  }
  return projected;
}

export function projectPersonDetailEnvelope(
  payload: unknown,
  expectedPersonId: string,
): GetPersonRpcProjection | null {
  const normalizedId = normalizeOrgUuid(expectedPersonId);
  if (!normalizedId) return null;
  const rest = unwrapOkPayload(payload);
  if (!rest) return null;
  const projected = projectGetPersonResponse(rest);
  if (!projected || projected.person.person_id !== normalizedId) return null;
  return projected;
}

function validateJoinedOnInput(raw: string | null | undefined):
  | { ok: true; value: string | null }
  | { ok: false; message: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  if (!isValidIsoDate(trimmed)) {
    return { ok: false, message: "Ngày gia nhập phải đúng định dạng YYYY-MM-DD." };
  }
  return { ok: true, value: trimmed };
}

export function buildCreatePersonRequest(input: {
  employeeCode: string;
  fullName: string;
  joinedOn?: string | null;
  initialDepartmentRef?: string | null;
  accountRef?: string | null;
  expectedAccountVersion?: number | null;
  recruiterId?: string | null;
  reason: string;
  idempotencyKey: string;
}): PersonOrgRequestResult<CreatePersonBody> {
  const idem = normalizeOrgUuid(input.idempotencyKey);
  if (!idem) return { ok: false, message: "Khóa thao tác không hợp lệ." };

  const codeCheck = parseEmployeeCode(input.employeeCode);
  if (!codeCheck.ok) return { ok: false, message: codeCheck.message };

  const nameCheck = parseFullName(input.fullName);
  if (!nameCheck.ok) return { ok: false, message: nameCheck.message };

  const joinedCheck = validateJoinedOnInput(input.joinedOn);
  if (!joinedCheck.ok) return joinedCheck;

  const reasonCheck = parseSafeReason(input.reason);
  if (!reasonCheck.ok) return { ok: false, message: reasonCheck.message };

  let initialDepartmentRef: string | null = null;
  if (input.initialDepartmentRef && input.initialDepartmentRef.trim() !== "") {
    initialDepartmentRef = normalizeOrgUuid(input.initialDepartmentRef);
    if (!initialDepartmentRef) {
      return { ok: false, message: "Phòng ban khởi tạo không hợp lệ." };
    }
  }

  let accountRef: string | null = null;
  let expectedAccountVersion: number | null = null;
  if (input.accountRef && input.accountRef.trim() !== "") {
    accountRef = normalizeOrgUuid(input.accountRef);
    if (!accountRef) {
      return { ok: false, message: "Tài khoản liên kết không hợp lệ." };
    }
    if (
      typeof input.expectedAccountVersion !== "number" ||
      !Number.isSafeInteger(input.expectedAccountVersion) ||
      input.expectedAccountVersion < 1
    ) {
      return {
        ok: false,
        message: "Thiếu phiên bản tài khoản hợp lệ; hãy chọn lại tài khoản từ danh sách.",
      };
    }
    expectedAccountVersion = input.expectedAccountVersion;
  }

  let recruiterId: string | null = null;
  if (input.recruiterId && input.recruiterId.trim() !== "") {
    recruiterId = normalizeOrgUuid(input.recruiterId);
    if (!recruiterId) {
      return { ok: false, message: "Hồ sơ tính công tuyển dụng không hợp lệ." };
    }
  }

  const candidate: CreatePersonBody = {
    employee_code: codeCheck.value,
    full_name: nameCheck.value,
    joined_on: joinedCheck.value,
    initial_department_ref: initialDepartmentRef,
    account_ref: accountRef,
    expected_account_version: expectedAccountVersion,
    recruiter_id: recruiterId,
    reason: reasonCheck.value,
    idempotency_key: idem,
  };

  const parsed = parseCreatePersonBody(candidate, idem);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, body: parsed.value, idempotencyKey: idem };
}

export function buildUpdatePersonRequest(input: {
  expectedPersonVersion: number;
  employeeCode: string;
  fullName: string;
  joinedOn?: string | null;
  status: PersonStatus;
  reason: string;
  idempotencyKey: string;
}): PersonOrgRequestResult<UpdatePersonBody> {
  const idem = normalizeOrgUuid(input.idempotencyKey);
  if (!idem) return { ok: false, message: "Khóa thao tác không hợp lệ." };

  const codeCheck = parseEmployeeCode(input.employeeCode);
  if (!codeCheck.ok) return { ok: false, message: codeCheck.message };

  const nameCheck = parseFullName(input.fullName);
  if (!nameCheck.ok) return { ok: false, message: nameCheck.message };

  const joinedCheck = validateJoinedOnInput(input.joinedOn);
  if (!joinedCheck.ok) return joinedCheck;

  const reasonCheck = parseSafeReason(input.reason);
  if (!reasonCheck.ok) return { ok: false, message: reasonCheck.message };

  const candidate = {
    expected_person_version: input.expectedPersonVersion,
    employee_code: codeCheck.value,
    full_name: nameCheck.value,
    joined_on: joinedCheck.value,
    status: input.status,
    reason: reasonCheck.value,
    idempotency_key: idem,
  };
  const parsed = parseUpdatePersonBody(candidate, idem);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, body: parsed.value, idempotencyKey: idem };
}

export function buildTransferPersonDepartmentRequest(input: {
  targetDepartmentRef: string;
  expectedPersonVersion: number;
  expectedCurrentMembershipId: string;
  reason: string;
  idempotencyKey: string;
}): PersonOrgRequestResult<TransferPersonDepartmentBody> {
  const idem = normalizeOrgUuid(input.idempotencyKey);
  if (!idem) return { ok: false, message: "Khóa thao tác không hợp lệ." };

  const targetDept = normalizeOrgUuid(input.targetDepartmentRef);
  if (!targetDept) {
    return { ok: false, message: "Hãy chọn phòng ban đích từ danh sách." };
  }
  const currentMembershipId = normalizeOrgUuid(input.expectedCurrentMembershipId);
  if (!currentMembershipId) {
    return { ok: false, message: "Không xác định được bản ghi phòng ban hiện hành." };
  }
  const reasonCheck = parseSafeReason(input.reason);
  if (!reasonCheck.ok) return { ok: false, message: reasonCheck.message };

  const candidate = {
    target_department_ref: targetDept,
    expected_person_version: input.expectedPersonVersion,
    expected_current_membership_id: currentMembershipId,
    reason: reasonCheck.value,
    idempotency_key: idem,
  };
  const parsed = parseTransferPersonDepartmentBody(candidate, idem);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, body: parsed.value, idempotencyKey: idem };
}

export function buildAssignPersonDepartmentRequest(input: {
  personId: string;
  expectedPersonVersion: number;
  reason: string;
  idempotencyKey: string;
}): PersonOrgRequestResult<{
  person_id: string;
  expected_person_version: number;
  reason: string;
  idempotency_key: string;
}> {
  const idem = normalizeOrgUuid(input.idempotencyKey);
  if (!idem) return { ok: false, message: "Khóa thao tác không hợp lệ." };

  const personId = normalizeOrgUuid(input.personId);
  if (!personId) return { ok: false, message: "Không xác định được hồ sơ nhân sự." };

  const reasonCheck = parseSafeReason(input.reason);
  if (!reasonCheck.ok) return { ok: false, message: reasonCheck.message };

  const candidate = {
    person_id: personId,
    expected_person_version: input.expectedPersonVersion,
    reason: reasonCheck.value,
    idempotency_key: idem,
  };
  const parsed = parseAssignPersonMemberBody(candidate, idem);
  if (!parsed.ok) {
    return {
      ok: false,
      message: "Dữ liệu gán phòng ban không hợp lệ. Vui lòng kiểm tra lý do và thử lại.",
    };
  }
  return { ok: true, body: parsed.value, idempotencyKey: idem };
}

export function buildEndPersonDepartmentRequest(input: {
  expectedPersonVersion: number;
  reason: string;
  idempotencyKey: string;
}): PersonOrgRequestResult<{
  expected_person_version: number;
  reason: string;
  idempotency_key: string;
}> {
  const idem = normalizeOrgUuid(input.idempotencyKey);
  if (!idem) return { ok: false, message: "Khóa thao tác không hợp lệ." };

  const reasonCheck = parseSafeReason(input.reason);
  if (!reasonCheck.ok) return { ok: false, message: reasonCheck.message };

  const candidate = {
    expected_person_version: input.expectedPersonVersion,
    reason: reasonCheck.value,
    idempotency_key: idem,
  };
  const parsed = parseEndPersonMemberBody(candidate, idem);
  if (!parsed.ok) {
    return {
      ok: false,
      message: "Dữ liệu kết thúc phòng ban không hợp lệ. Vui lòng kiểm tra lý do.",
    };
  }
  return { ok: true, body: parsed.value, idempotencyKey: idem };
}

function extractErrorCode(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const code = (payload as Record<string, unknown>).code;
  return typeof code === "string" && code.trim() !== "" ? code.trim() : null;
}

export function messageForOrgErrorCode(code: string | null, status: number): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Phiên đăng nhập đã hết hạn. Dữ liệu đã được dọn; vui lòng đăng nhập lại.";
    case "ACTOR_NOT_AVAILABLE":
    case "FORBIDDEN":
    case "DEPARTMENT_ACCESS_DENIED":
    case "CSRF_REJECTED":
      return "Bạn không còn quyền thực hiện thao tác quản trị Nhân sự nội bộ.";
    case "PERSON_NOT_FOUND":
    case "NOT_FOUND":
      return "Không tìm thấy hồ sơ Nhân sự nội bộ tương ứng.";
    case "DEPARTMENT_NOT_FOUND":
      return "Không tìm thấy phòng ban đã chọn.";
    case "TARGET_ACCOUNT_NOT_FOUND":
      return "Không tìm thấy tài khoản truy cập đã chọn.";
    case "VERSION_CONFLICT":
    case "DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT":
      return "Hồ sơ hoặc phòng ban vừa được cập nhật bởi thao tác khác. Vui lòng tải bản mới từ máy chủ trước khi sửa lại.";
    case "PERSON_IS_ACTIVE_DEPARTMENT_HEAD":
      return "Nhân sự này đang giữ chức danh Trưởng phòng. Hãy kết thúc hoặc thay chức danh Trưởng phòng trước khi chuyển phòng, kết thúc thành viên hoặc ngừng hoạt động hồ sơ người.";
    case "DUPLICATE_CODE":
      return "Mã nhân sự nội bộ này đã tồn tại trên hệ thống. Vui lòng kiểm tra lại.";
    case "PERSON_INACTIVE":
      return "Hồ sơ nhân sự nội bộ đang ngừng hoạt động nên không thể gán phòng ban hoặc thực hiện thay đổi này.";
    case "DEPARTMENT_INACTIVE":
      return "Phòng ban đã chọn đang ngừng hoạt động nên không thể gán nhân sự mới.";
    case "PERSON_ALREADY_IN_DEPARTMENT":
      return "Nhân sự này hiện đã thuộc phòng ban này rồi.";
    case "PERSON_ALREADY_IN_OTHER_DEPARTMENT":
      return "Nhân sự đang thuộc một phòng ban khác. Vui lòng dùng thao tác Chuyển phòng ban thay vì gán mới.";
    case "SAME_TARGET_DEPARTMENT":
      return "Phòng ban đích đang trùng với phòng ban hiện hành của nhân sự.";
    case "ACCOUNT_TYPE_LINK_FORBIDDEN":
      return "Tài khoản phân loại Dùng chung (SHARED) hoặc Dịch vụ (SERVICE) không được liên kết hồ sơ nhân sự nội bộ.";
    case "ACCOUNT_OR_PERSON_ALREADY_LINKED":
      return "Tài khoản hoặc hồ sơ nhân sự đã có liên kết hiệu lực với đối tượng khác. Hãy tải lại dữ liệu mới nhất.";
    case "RECRUITER_IDENTITY_CONFLICT":
      return "Xung đột hồ sơ tính công tuyển dụng giữa tài khoản và nhân sự này. Không thể tự ghi đè danh tính.";
    case "RECRUITER_LINK_MISMATCH":
      return "Hồ sơ tính công tuyển dụng đang gắn với tài khoản chưa khớp với hồ sơ nhân sự. Vui lòng xác nhận đúng hồ sơ tại trang Tài khoản truy cập.";
    case "RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT":
      return "Hồ sơ tính công tuyển dụng này đang được liên kết với một tài khoản truy cập khác.";
    case "CLIENT_SCHEDULE_FIELD_FORBIDDEN":
      return "Không hỗ trợ nhập ngày hiệu lực hoặc đặt lịch; các thay đổi tổ chức áp dụng ngay thời điểm xác nhận.";
    case "IDEMPOTENCY_CONFLICT":
      return "Khóa thao tác bị trùng với một yêu cầu có nội dung khác. Hãy đóng và mở lại hộp thoại để tạo yêu cầu mới.";
    case "IDEMPOTENCY_KEY_INVALID":
    case "IDEMPOTENCY_KEY_MISMATCH":
    case "ORG_VALIDATION_ERROR":
    case "INVALID_JSON":
    case "CONTENT_TYPE_INVALID":
    case "BODY_TOO_LARGE":
      return "Dữ liệu gửi lên chưa hợp lệ theo quy tắc kiểm tra của hệ thống.";
    case "ORG_UNAVAILABLE":
    case "DEPARTMENT_UNAVAILABLE":
      return "Máy chủ chưa trả về xác nhận cho thao tác vừa gửi. Hãy giữ nguyên biểu mẫu để thử lại đúng yêu cầu hoặc tải lại dữ liệu đối chiếu.";
    default:
      if (status === 401) {
        return "Phiên đăng nhập đã hết hạn. Dữ liệu đã được dọn; vui lòng đăng nhập lại.";
      }
      if (status === 403) {
        return "Bạn không có quyền truy cập chức năng quản trị Nhân sự nội bộ.";
      }
      if (status === 404) {
        return "Dữ liệu yêu cầu không tồn tại hoặc đã thay đổi.";
      }
      if (status === 409) {
        return "Dữ liệu vừa thay đổi ở phiên làm việc khác. Vui lòng tải lại bản mới nhất để đối chiếu.";
      }
      if (status >= 500) {
        return "Máy chủ chưa phản hồi xác nhận. Bạn có thể thử lại đúng yêu cầu này hoặc tải lại để đối chiếu.";
      }
      return "Không thể hoàn tất yêu cầu. Vui lòng kiểm tra lại dữ liệu.";
  }
}

export function classifyPersonOrgReadError(
  status: number,
  payload: unknown,
): PersonOrgReadError {
  const code = extractErrorCode(payload);
  if (status === 401 || code === "UNAUTHENTICATED") {
    return {
      kind: "unauthenticated",
      message: messageForOrgErrorCode(code ?? "UNAUTHENTICATED", status),
      retryable: false,
    };
  }
  if (
    status === 403 ||
    code === "ACTOR_NOT_AVAILABLE" ||
    code === "FORBIDDEN" ||
    code === "DEPARTMENT_ACCESS_DENIED"
  ) {
    return {
      kind: "denied",
      message: messageForOrgErrorCode(code ?? "FORBIDDEN", status),
      retryable: false,
    };
  }
  if (status === 404 || code === "PERSON_NOT_FOUND" || code === "NOT_FOUND") {
    return {
      kind: "not-found",
      message: messageForOrgErrorCode(code ?? "PERSON_NOT_FOUND", status),
      retryable: false,
    };
  }
  return {
    kind: "unavailable",
    message: messageForOrgErrorCode(code, status),
    retryable: true,
  };
}

export function classifyPersonOrgMutationResponse(
  status: number,
  payload: unknown,
  op: PersonOrgMutationOp,
):
  | PersonOrgMutationOutcome<MutatePersonRpcProjection>
  | PersonOrgMutationOutcome<TransferPersonDepartmentRpcProjection>
  | PersonOrgMutationOutcome<DepartmentPersonMemberMutationProjection> {
  const code = extractErrorCode(payload);
  const rest = unwrapOkPayload(payload);

  if (op === "create" || op === "update") {
    const validStatus = op === "create" ? status === 201 || status === 200 : status === 200;
    if (validStatus && rest) {
      const projected = projectMutatePersonResponse(rest);
      if (projected) {
        const replayed = projected.replayed;
        const actionLabel = op === "create" ? "tạo hồ sơ nhân sự" : "cập nhật hồ sơ nhân sự";
        return {
          kind: "applied",
          replayed,
          data: projected,
          message: replayed
            ? `Yêu cầu ${actionLabel} cho ${projected.person.full_name} đã được ghi nhận trước đó.`
            : op === "create"
              ? `Đã tạo hồ sơ ${projected.person.full_name} (${projected.person.employee_code}).`
              : `Đã cập nhật hồ sơ ${projected.person.full_name} (${projected.person.employee_code}).`,
        };
      }
      return {
        kind: "uncertain",
        message: "Phản hồi xác nhận từ máy chủ không khớp cấu trúc hợp lệ. Hãy tải lại để đối chiếu.",
        preserveIdempotencyKey: true,
      };
    }
  } else if (op === "transfer-department") {
    if (status === 200 && rest) {
      const projected = projectTransferPersonDepartmentResponse(rest);
      if (projected) {
        return {
          kind: "applied",
          replayed: projected.replayed,
          data: projected,
          message: projected.replayed
            ? "Yêu cầu chuyển phòng ban đã được ghi nhận trước đó."
            : `Đã chuyển nhân sự sang ${projected.active_membership.name}.`,
        };
      }
      return {
        kind: "uncertain",
        message: "Phản hồi chuyển phòng ban không khớp cấu trúc hợp lệ. Hãy tải lại để đối chiếu.",
        preserveIdempotencyKey: true,
      };
    }
  } else {
    const validStatus =
      op === "assign-department" ? status === 201 || status === 200 : status === 200;
    if (validStatus && rest) {
      const projected = projectDepartmentPersonMemberMutationResponse(rest);
      if (projected) {
        return {
          kind: "applied",
          replayed: projected.replayed,
          data: projected,
          message: projected.replayed
            ? "Thao tác phòng ban này đã được ghi nhận trước đó."
            : op === "assign-department"
              ? `Đã gán ${projected.membership.full_name} vào phòng ban.`
              : `Đã kết thúc thành viên phòng ban của ${projected.membership.full_name}.`,
        };
      }
      return {
        kind: "uncertain",
        message: "Phản hồi cập nhật phòng ban không khớp cấu trúc hợp lệ. Hãy tải lại để đối chiếu.",
        preserveIdempotencyKey: true,
      };
    }
  }

  if (status === 401 || code === "UNAUTHENTICATED") {
    return {
      kind: "session-lost",
      sessionState: "unauthenticated",
      message: messageForOrgErrorCode(code ?? "UNAUTHENTICATED", status),
      preserveIdempotencyKey: false,
    };
  }
  if (
    status === 403 ||
    code === "ACTOR_NOT_AVAILABLE" ||
    code === "FORBIDDEN" ||
    code === "DEPARTMENT_ACCESS_DENIED" ||
    code === "CSRF_REJECTED"
  ) {
    return {
      kind: "session-lost",
      sessionState: "denied",
      message: messageForOrgErrorCode(code ?? "FORBIDDEN", status),
      preserveIdempotencyKey: false,
    };
  }
  if (code === "PERSON_IS_ACTIVE_DEPARTMENT_HEAD") {
    return {
      kind: "active-head-block",
      message: messageForOrgErrorCode(code, status),
      preserveIdempotencyKey: false,
    };
  }
  if (code === "VERSION_CONFLICT" || code === "DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT") {
    return {
      kind: "conflict",
      message: messageForOrgErrorCode(code, status),
      preserveIdempotencyKey: false,
    };
  }
  if (status === 404 || code === "PERSON_NOT_FOUND" || code === "DEPARTMENT_NOT_FOUND" || code === "NOT_FOUND" || code === "TARGET_ACCOUNT_NOT_FOUND") {
    return {
      kind: "not-found",
      message: messageForOrgErrorCode(code, status),
      preserveIdempotencyKey: false,
    };
  }
  if (status === 400 || status === 413) {
    return {
      kind: "invalid",
      message: messageForOrgErrorCode(code, status),
      preserveIdempotencyKey: false,
    };
  }
  if (status === 409) {
    return {
      kind: "business-error",
      code: code ?? "ORG_CONFLICT",
      message: messageForOrgErrorCode(code, status),
      preserveIdempotencyKey: false,
    };
  }
  return {
    kind: "uncertain",
    message: messageForOrgErrorCode(code, status),
    preserveIdempotencyKey: true,
  };
}
