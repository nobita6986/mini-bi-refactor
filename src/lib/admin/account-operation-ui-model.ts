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
  projectEligibleAccountsEnvelope,
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
  | { kind: "unavailable"; message: string };

export function accountOperationStateMessage(state: string): string {
  if (state === "BLOCKED") return "Auth user tồn tại nhưng không khớp provenance — cần T0/Admin xử lý thủ công.";
  if (state === "INDETERMINATE") return "Không xác định được kết quả Auth. Không tự thử lại; dùng Đối soát hoặc phát hành thao tác mới.";
  if (state === "CONFLICT") return "Trùng mã đăng nhập hoặc xung đột. Hãy kiểm tra lại.";
  if (state === "FAILED") return "Thao tác Auth đã thất bại.";
  return "Trạng thái: " + state + ".";
}

export function classifyAccountOperationResponse(
  status: number,
  payload: unknown,
): AccountOperationUiOutcome {
  const record = typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : null;
  if (status === 200 && record && record.ok === true) {
    const intent = record.intent as Record<string, unknown> | undefined;
    if (intent && typeof intent.state === "string" && intent.state !== "APPLIED") {
      const state = intent.state as "BLOCKED" | "INDETERMINATE" | "CONFLICT" | "FAILED";
      return {
        kind: "needs-reconcile",
        intentId: typeof intent.intent_id === "string" ? intent.intent_id : "",
        state,
        message: accountOperationStateMessage(state),
      };
    }
    return { kind: "applied", message: "Đã lưu thao tác." };
  }
  if (status === 401) return { kind: "denied", message: "Phiên đăng nhập không còn hiệu lực." };
  if (status === 403) return { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  if (status === 409) return { kind: "conflict", message: "Có xung đột hoặc thao tác đang được xử lý." };
  if (status === 400 || status === 422) return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ." };
  if (status === 500 && record?.code === "ACCOUNT_OPERATION_AUTH_APPLIED_UNRECORDED") {
    return { kind: "unavailable", message: "Supabase Auth đã xác nhận đổi mật khẩu nhưng ứng dụng chưa ghi nhận kết quả. Không gửi lại yêu cầu này; hãy thử đăng nhập bằng mật khẩu mới trước." };
  }
  if (status === 500 && (record?.code === "ACCOUNT_OPERATION_INDETERMINATE" ||
      record?.code === "ACCOUNT_OPERATION_RESULT_UNRECORDED")) {
    return { kind: "unavailable", message: "Chưa xác định được kết quả đổi mật khẩu. Không gửi lại ngay; Admin cần kiểm tra trạng thái yêu cầu trước khi tạo yêu cầu mới." };
  }
  return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng." };
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
