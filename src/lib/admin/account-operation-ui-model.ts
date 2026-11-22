/**
 * PRE-W2-HF-D3-B - Pure UI model for account operations (create / edit display
 * name / reset password / reconcile). No I/O, no React. Builds the exact request
 * bodies for the D3-B routes and classifies the sanitized responses, including the
 * intent states that require operator handling (INDETERMINATE/BLOCKED/CONFLICT).
 * Password is never retained beyond the in-memory request and never echoed.
 */
import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_BYTES,
  projectEditNameEnvelope,
  projectEligibleAccountsEnvelope,
  projectFinalizeCreateEnvelope,
  projectIntentEnvelope,
  projectLinkRecruiterEnvelope,
  projectPersonnelFromAccountEnvelope,
  projectRecruiterLinkCandidatesEnvelope,
  projectRecruiterLinkStatusEnvelope,
  type EligibleAccountsEnvelope,
  type RecruiterLinkCandidatesEnvelope,
  type RecruiterLinkStatusEnvelope,
} from "./account-operation-contract.ts";
import {
  newIdempotencyKey,
  normalizeOptionalActionReason,
  validateReason,
  validateUuid,
  validateVersion,
  type RequestResult,
} from "../direct-entry/project-operations-model.ts";

const LOGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const NAME_MAX = 256;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VIETNAM_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function resolveBusinessTodayVn(todayVn?: string): string {
  return todayVn && DATE.test(todayVn)
    ? todayVn
    : VIETNAM_DATE_FORMATTER.format(new Date());
}

function passwordOk(password: string): string | null {
  if (password.length < MIN_PASSWORD_BYTES) return "Mật khẩu phải có ít nhất 8 ký tự.";
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_BYTES) {
    return "Mật khẩu quá dài.";
  }
  return null;
}

export function buildCreateAccountRequest(input: {
  loginId: string;
  displayName: string;
  password: string;
  passwordConfirm: string;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const loginId = input.loginId.trim();
  const displayName = input.displayName.trim();
  const failure = !LOGIN_ID.test(loginId)
    ? "Mã đăng nhập không hợp lệ (chữ thường/số/._-, 1..64 ký tự)."
    : (displayName === "" ? "Tên hiển thị là bắt buộc." : displayName.length > NAME_MAX
      ? "Tên hiển thị tối đa 256 ký tự." : null)
    ?? (input.password !== input.passwordConfirm ? "Mật khẩu nhập lại không khớp." : passwordOk(input.password))
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      login_id: loginId,
      display_name: displayName,
      password: input.password,
      password_confirm: input.passwordConfirm,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildEditDisplayNameRequest(input: {
  displayName: string;
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const displayName = input.displayName.trim();
  const failure = (displayName === "" ? "Tên hiển thị là bắt buộc." : displayName.length > NAME_MAX
    ? "Tên hiển thị tối đa 256 ký tự." : null)
    ?? validateVersion(input.expectedVersion) ?? (input.expectedVersion < 1
      ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null)
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      display_name: displayName,
      expected_version: input.expectedVersion,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildResetPasswordRequest(input: {
  password: string;
  passwordConfirm: string;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = (input.password !== input.passwordConfirm ? "Mật khẩu nhập lại không khớp." : passwordOk(input.password))
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      password: input.password,
      password_confirm: input.passwordConfirm,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildReconcileRequest(idempotencyKey: string): RequestResult {
  const failure = validateUuid(idempotencyKey);
  return failure ? { ok: false, message: failure } : { ok: true, body: { idempotency_key: idempotencyKey } };
}

export function buildPersonnelFromAccountRequest(input: {
  accountRef: string;
  expectedAccountVersion: number;
  loginId: string;
  personnelPosition: string;
  validFrom?: string | null;
  todayVn?: string;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const businessToday = resolveBusinessTodayVn(input.todayVn);
  const validFrom = typeof input.validFrom === "string" && input.validFrom.trim() !== ""
    ? input.validFrom.trim()
    : null;
  const dateFailure = validFrom === null
    ? null
    : !DATE.test(validFrom)
      ? "Ngày hiệu lực HRP không hợp lệ."
      : validFrom > businessToday
        ? "Ngày hiệu lực HRP không được ở tương lai."
        : validFrom < businessToday
          ? "Ngày hiệu lực HRP không được ở quá khứ."
          : null;
  const failure = validateUuid(input.accountRef)
    ?? validateVersion(input.expectedAccountVersion) ?? (input.expectedAccountVersion < 1
      ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null)
    ?? (LOGIN_ID.test(input.loginId) ? null : "Tài khoản không có mã đăng nhập hợp lệ.")
    ?? (input.personnelPosition !== "STAFF" && input.personnelPosition !== "TEAM_LEADER"
      ? "Vị trí nhân sự không hợp lệ." : null)
    ?? dateFailure
    ?? validateReason(input.reason) ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      account_ref: input.accountRef,
      expected_account_version: input.expectedAccountVersion,
      personnel_code: input.loginId,
      personnel_position: input.personnelPosition,
      valid_from: validFrom,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export type AccountOperationUiOutcome =
  | { kind: "applied"; message: string }
  | { kind: "needs-reconcile"; intentId: string; state: string; message: string }
  | { kind: "denied"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "invalid"; message: string }
  | {
      kind: "unavailable";
      message: string;
      preserveIdempotencyKey: boolean;
      manualCheckRequired?: boolean;
    };

export function accountOperationStateMessage(state: string): string {
  if (state === "BLOCKED") {
    return "Tài khoản đăng nhập đã tồn tại nhưng thông tin liên kết chưa trùng khớp — vui lòng liên hệ quản trị hệ thống để kiểm tra trước khi tiếp tục.";
  }
  if (state === "INDETERMINATE") {
    return "Chưa xác định được kết quả mở tài khoản đăng nhập. Không tự tạo lại; hãy bấm \"Kiểm tra lại kết quả mở đăng nhập\" để đối chiếu với máy chủ.";
  }
  if (state === "IN_FLIGHT") {
    return "Yêu cầu mở tài khoản đăng nhập đang được xử lý. Hãy bấm \"Kiểm tra lại kết quả mở đăng nhập\" để cập nhật.";
  }
  if (state === "PENDING") {
    return "Yêu cầu mở tài khoản đăng nhập đang chờ xử lý. Không tạo yêu cầu mới; hãy bấm \"Kiểm tra lại kết quả mở đăng nhập\".";
  }
  if (state === "CONFLICT") {
    return "Tên đăng nhập đã tồn tại hoặc bị trùng lặp. Vui lòng kiểm tra lại.";
  }
  if (state === "FAILED") {
    return "Mở tài khoản đăng nhập chưa thành công. Vui lòng kiểm tra lại thông tin và thử lại.";
  }
  if (state === "EXPIRED") {
    return "Phiên xử lý mở tài khoản đã hết hạn. Vui lòng mở lại biểu mẫu để thực hiện mới.";
  }
  return "Trạng thái xử lý chưa hoàn tất. Vui lòng kiểm tra lại kết quả với máy chủ.";
}

export type AccountOperationResponseContext =
  | { operation: "create_account" }
  | { operation: "reconcile_create_account"; expectedIntentId?: string }
  | { operation: "edit_display_name"; expectedAccountRef: string }
  | { operation: "reset_password" }
  | { operation: "personnel_from_account"; expectedPersonnelCode?: string }
  | { operation: "link_recruiter_account"; expectedRecruiterId: string; expectedAccountRef: string };

const RECONCILABLE_CREATE_INTENT_STATES = new Set([
  "PENDING",
  "IN_FLIGHT",
  "INDETERMINATE",
  "BLOCKED",
  "CONFLICT",
  "FAILED",
  "EXPIRED",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidUuid(value: unknown): value is string {
  return typeof value === "string" && validateUuid(value) === null;
}

function uncertainMalformedOutcome(message?: string): AccountOperationUiOutcome {
  return {
    kind: "unavailable",
    preserveIdempotencyKey: true,
    message:
      message ??
      "Phản hồi không hợp lệ. Giữ nguyên khóa để thử lại đúng yêu cầu hoặc tải lại đối chiếu.",
  };
}

type ProjectedCreateAccountResult = {
  app_user_id: string;
  intent_id: string;
};

/**
 * Projects a CREATE_ACCOUNT / reconcile account result from either:
 * 1) Strict FinalizeCreateEnvelope (fresh finalize or finalizeCreate replay cache), or
 * 2) PR #13 fallback from accountAccess.getAccount (allows revision_id: null,
 *    auth_subject: string | null, display_name: string | null) while still
 *    requiring valid UUID app_user_id, valid UUID intent_id, version >= 1,
 *    and intent_state === "APPLIED".
 */
function projectCreateAccountResult(value: unknown): ProjectedCreateAccountResult | null {
  const strict = projectFinalizeCreateEnvelope(value);
  if (strict) {
    return strict.intent_state === "APPLIED"
      ? { app_user_id: strict.app_user_id, intent_id: strict.intent_id }
      : null;
  }
  if (!isPlainRecord(value)) return null;
  if (
    Object.keys(value).sort().join(",") !==
    "app_user_id,auth_subject,display_name,intent_id,intent_state,revision_id,version"
  ) {
    return null;
  }
  if (!isValidUuid(value.app_user_id) || !isValidUuid(value.intent_id)) return null;
  if (value.intent_state !== "APPLIED") return null;
  if (value.auth_subject !== null && !isValidUuid(value.auth_subject)) return null;
  if (value.revision_id !== null && !isValidUuid(value.revision_id)) return null;
  if (value.display_name !== null && typeof value.display_name !== "string") return null;
  if (typeof value.version !== "number" || !Number.isSafeInteger(value.version) || value.version < 1) {
    return null;
  }
  return { app_user_id: value.app_user_id, intent_id: value.intent_id };
}

type ProjectedCreateIntent = {
  intent_id: string;
  state: string;
  account_ref: string | null;
};

/**
 * Projects a CREATE_ACCOUNT intent envelope from current main (4 keys) or PR #13
 * (5 keys with account_ref), enforcing kind === "CREATE_ACCOUNT", valid UUIDs,
 * canonical state enum, and non-null UUID account_ref when state === "APPLIED".
 */
function projectCreateIntentResult(value: unknown): ProjectedCreateIntent | null {
  if (!isPlainRecord(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  const hasAccountRef = keys === "account_ref,intent_id,intent_token,kind,state";
  if (!hasAccountRef && keys !== "intent_id,intent_token,kind,state") return null;
  const base = projectIntentEnvelope({
    intent_id: value.intent_id,
    intent_token: value.intent_token,
    kind: value.kind,
    state: value.state,
  });
  if (!base || base.kind !== "CREATE_ACCOUNT") return null;
  const accountRef = hasAccountRef ? value.account_ref : null;
  if (accountRef !== null && !isValidUuid(accountRef)) return null;
  if (base.state === "APPLIED") {
    if (!isValidUuid(accountRef)) return null;
    return { intent_id: base.intent_id, state: "APPLIED", account_ref: accountRef };
  }
  if (!RECONCILABLE_CREATE_INTENT_STATES.has(base.state)) return null;
  return { intent_id: base.intent_id, state: base.state, account_ref: accountRef };
}

function classifyCreateOrReconcile200(
  record: Record<string, unknown>,
  expectedIntentId?: string,
): AccountOperationUiOutcome {
  for (const key of Object.keys(record)) {
    if (key !== "ok" && key !== "replayed" && key !== "account" && key !== "intent") {
      return uncertainMalformedOutcome();
    }
  }
  if ("replayed" in record && typeof record.replayed !== "boolean") {
    return uncertainMalformedOutcome();
  }
  const hasAccount = "account" in record && record.account !== undefined;
  const hasIntent = "intent" in record && record.intent !== undefined;
  if (!hasAccount && !hasIntent) {
    return uncertainMalformedOutcome();
  }

  let account: ProjectedCreateAccountResult | null = null;
  if (hasAccount) {
    account = projectCreateAccountResult(record.account);
    if (!account) return uncertainMalformedOutcome();
    if (expectedIntentId && account.intent_id !== expectedIntentId) {
      return uncertainMalformedOutcome();
    }
  }

  let intent: ProjectedCreateIntent | null = null;
  if (hasIntent) {
    intent = projectCreateIntentResult(record.intent);
    if (!intent) {
      return uncertainMalformedOutcome(
        "Phản hồi trạng thái thao tác không hợp lệ. Giữ nguyên khóa để thử lại hoặc đối chiếu.",
      );
    }
    if (expectedIntentId && intent.intent_id !== expectedIntentId) {
      return uncertainMalformedOutcome(
        "Phản hồi không khớp mã đối soát đang xử lý. Giữ nguyên khóa để thử lại hoặc đối chiếu.",
      );
    }
  }

  if (intent && intent.state !== "APPLIED") {
    if (account) return uncertainMalformedOutcome();
    return {
      kind: "needs-reconcile",
      intentId: intent.intent_id,
      state: intent.state,
      message: accountOperationStateMessage(intent.state),
    };
  }

  if (account && intent) {
    if (account.app_user_id !== intent.account_ref || account.intent_id !== intent.intent_id) {
      return uncertainMalformedOutcome();
    }
  }

  return { kind: "applied", message: "Đã lưu thao tác." };
}

function classifyEditDisplayName200(
  record: Record<string, unknown>,
  expectedAccountRef: string,
): AccountOperationUiOutcome {
  if (!isValidUuid(expectedAccountRef)) return uncertainMalformedOutcome();
  if (Object.keys(record).sort().join(",") !== "account,ok") {
    return uncertainMalformedOutcome();
  }
  const edited = projectEditNameEnvelope(record.account);
  if (!edited || edited.app_user_id !== expectedAccountRef) {
    return uncertainMalformedOutcome();
  }
  return { kind: "applied", message: "Đã lưu thao tác." };
}

function classifyResetPassword200(record: Record<string, unknown>): AccountOperationUiOutcome {
  if (Object.keys(record).length !== 1 || record.ok !== true) {
    return uncertainMalformedOutcome();
  }
  return { kind: "applied", message: "Đã lưu thao tác." };
}

function classifyPersonnelFromAccount200(
  record: Record<string, unknown>,
  expectedPersonnelCode?: string,
): AccountOperationUiOutcome {
  if (Object.keys(record).sort().join(",") !== "ok,personnel") {
    return uncertainMalformedOutcome();
  }
  const personnel = projectPersonnelFromAccountEnvelope(record.personnel);
  if (!personnel) return uncertainMalformedOutcome();
  if (expectedPersonnelCode !== undefined && personnel.personnel_code !== expectedPersonnelCode) {
    return uncertainMalformedOutcome();
  }
  return { kind: "applied", message: "Đã lưu thao tác." };
}

function classifyLinkRecruiter200(
  record: Record<string, unknown>,
  expectedRecruiterId: string,
  expectedAccountRef: string,
): AccountOperationUiOutcome {
  if (!isValidUuid(expectedRecruiterId) || !isValidUuid(expectedAccountRef)) {
    return uncertainMalformedOutcome();
  }
  if (Object.keys(record).sort().join(",") !== "link,ok") {
    return uncertainMalformedOutcome();
  }
  const link = projectLinkRecruiterEnvelope(record.link);
  if (!link || link.recruiter_id !== expectedRecruiterId || link.app_user_id !== expectedAccountRef) {
    return uncertainMalformedOutcome();
  }
  return { kind: "applied", message: "Đã lưu thao tác." };
}

function classifyContextless200(record: Record<string, unknown>): AccountOperationUiOutcome {
  const hasIntent = "intent" in record && record.intent !== undefined;
  const hasAccount = "account" in record && record.account !== undefined;
  const hasPersonnel = "personnel" in record && record.personnel !== undefined;
  const hasLink = "link" in record && record.link !== undefined;

  if (hasIntent) {
    return classifyCreateOrReconcile200(record);
  }
  if (hasAccount) {
    if (hasPersonnel || hasLink) return uncertainMalformedOutcome();
    const keys = Object.keys(record).sort().join(",");
    if (keys !== "account,ok" && keys !== "account,ok,replayed") return uncertainMalformedOutcome();
    if ("replayed" in record && typeof record.replayed !== "boolean") return uncertainMalformedOutcome();
    if (projectCreateAccountResult(record.account)) {
      return { kind: "applied", message: "Đã lưu thao tác." };
    }
    if (keys === "account,ok" && projectEditNameEnvelope(record.account)) {
      return { kind: "applied", message: "Đã lưu thao tác." };
    }
    return uncertainMalformedOutcome();
  }
  if (hasPersonnel) {
    return classifyPersonnelFromAccount200(record);
  }
  if (hasLink) {
    if (Object.keys(record).sort().join(",") !== "link,ok") return uncertainMalformedOutcome();
    return projectLinkRecruiterEnvelope(record.link)
      ? { kind: "applied", message: "Đã lưu thao tác." }
      : uncertainMalformedOutcome();
  }
  // Exact { ok: true } matches RESET_PASSWORD 200 contract.
  return classifyResetPassword200(record);
}

export function classifyAccountOperationResponse(
  status: number,
  payload: unknown,
  context?: AccountOperationResponseContext,
): AccountOperationUiOutcome {
  const record = isPlainRecord(payload) ? payload : null;
  if (status === 200) {
    if (!record || record.ok !== true) {
      return uncertainMalformedOutcome();
    }
    if (!context) return classifyContextless200(record);
    if (context.operation === "create_account") {
      return classifyCreateOrReconcile200(record);
    }
    if (context.operation === "reconcile_create_account") {
      return classifyCreateOrReconcile200(record, context.expectedIntentId);
    }
    if (context.operation === "edit_display_name") {
      return classifyEditDisplayName200(record, context.expectedAccountRef);
    }
    if (context.operation === "reset_password") {
      return classifyResetPassword200(record);
    }
    if (context.operation === "personnel_from_account") {
      return classifyPersonnelFromAccount200(record, context.expectedPersonnelCode);
    }
    return classifyLinkRecruiter200(record, context.expectedRecruiterId, context.expectedAccountRef);
  }
  if (status === 401) return { kind: "denied", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  if (status === 409) return { kind: "conflict", message: "Có xung đột hoặc thao tác đang được xử lý." };
  if (status === 400 || status === 422) return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ." };
  if (status === 404) return { kind: "invalid", message: "Không tìm thấy tài khoản hoặc chức năng chưa được bật." };
  if (status === 500 && record?.code === "ACCOUNT_OPERATION_AUTH_APPLIED_UNRECORDED") {
    return {
      kind: "unavailable",
      preserveIdempotencyKey: false,
      manualCheckRequired: true,
      message: "Mật khẩu mới có thể đã được cập nhật nhưng hệ thống chưa ghi nhận hoàn tất. Không gửi lại yêu cầu này; hãy thử đăng nhập bằng mật khẩu mới trước.",
    };
  }
  if (status === 500 && (record?.code === "ACCOUNT_OPERATION_INDETERMINATE" ||
      record?.code === "ACCOUNT_OPERATION_RESULT_UNRECORDED")) {
    return {
      kind: "unavailable",
      preserveIdempotencyKey: false,
      manualCheckRequired: true,
      message: "Chưa xác định được kết quả đặt lại mật khẩu. Không gửi lại ngay; hãy kiểm tra đăng nhập thực tế của người dùng trước khi tạo yêu cầu mới.",
    };
  }
  return { kind: "unavailable", preserveIdempotencyKey: true, message: "Dịch vụ hiện không khả dụng." };
}

export function newAccountOperationKey(): string {
  return newIdempotencyKey();
}

export const ELIGIBLE_ACCOUNTS_PAGE_SIZE = 25;

export function buildEligibleAccountsQuery(page: number): URLSearchParams | null {
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000) return null;
  return new URLSearchParams({
    page: String(page),
    page_size: String(ELIGIBLE_ACCOUNTS_PAGE_SIZE),
  });
}

/** Strict-project the eligible account UUID, real name and login ID only. */
export function projectEligibleAccounts(payload: unknown): EligibleAccountsEnvelope | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return null;
  return projectEligibleAccountsEnvelope(record.list);
}

export function buildLinkRecruiterAccountRequest(input: {
  accountRef: string;
  expectedAccountVersion: number;
  expectedRecruiterVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = validateUuid(input.accountRef)
    ?? validateVersion(input.expectedAccountVersion)
    ?? (input.expectedAccountVersion < 1 ? "Dữ liệu tài khoản chưa hợp lệ. Vui lòng tải lại." : null)
    ?? validateVersion(input.expectedRecruiterVersion)
    ?? (input.expectedRecruiterVersion < 1 ? "Dữ liệu nhân sự chưa hợp lệ. Vui lòng tải lại." : null)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      account_ref: input.accountRef,
      expected_account_version: input.expectedAccountVersion,
      expected_recruiter_version: input.expectedRecruiterVersion,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function buildRecruiterLinkStatusQuery(recruiterIds: readonly string[]): URLSearchParams | null {
  if (recruiterIds.length > 100) return null;
  const cleaned: string[] = [];
  for (const id of recruiterIds) {
    if (validateUuid(id) !== null) return null;
    cleaned.push(id);
  }
  return new URLSearchParams({
    recruiter_ids: cleaned.join(","),
  });
}

export function projectRecruiterLinkStatus(payload: unknown): RecruiterLinkStatusEnvelope | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return null;
  return projectRecruiterLinkStatusEnvelope(record.status);
}

export function projectRecruiterLinkCandidates(payload: unknown): RecruiterLinkCandidatesEnvelope | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.ok !== true) return null;
  return projectRecruiterLinkCandidatesEnvelope(record.candidates);
}
