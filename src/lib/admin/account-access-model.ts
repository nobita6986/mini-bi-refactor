/**
 * P3.1-W05-A Existing-account access UI projection and request helpers.
 *
 * The server/API (W03A lifecycle + R2 read) remains the sole authority; this
 * module only validates UI payloads and strictly projects responses. It reuses
 * the canonical contract projectors so the browser can never widen the shape.
 * There is no local account vocabulary, label map or raw-key fallback: only the
 * server-projected `display_name`, optional `login_id` and `enabled` flag are
 * the only identity/status fields surfaced. The
 * opaque `account_ref` is an internal route/request identity and `version` is
 * internal OCC state; neither is a display value.
 *
 * A mutation success is exactly `{ ok: true }` with NO projected row, so an
 * applied result never carries optimistic state — the caller must reload the
 * authoritative detail before unlocking.
 */
import type { BadgeTone } from "../../components/ui/badge.tsx";
import {
  ACCOUNT_TYPES,
  parseLinkAccountPersonBody,
  parseSafeReason,
  parseSetAccountTypeBody,
  parseUnlinkAccountPersonBody,
  projectLinkAccountPersonResponse,
  projectSetAccountTypeResponse,
  projectUnlinkAccountPersonResponse,
  type AccountType,
  type LinkAccountPersonBody,
  type LinkAccountPersonRpcProjection,
  type SetAccountTypeBody,
  type SetAccountTypeRpcProjection,
  type UnlinkAccountPersonBody,
  type UnlinkAccountPersonRpcProjection,
} from "../organization/person-contract.ts";
import {
  projectExistingAccount,
  projectExistingAccountList,
  type ExistingAccount,
  type ExistingAccountList,
} from "../direct-entry/app-user-access-contract.ts";
import {
  newIdempotencyKey,
  normalizeOptionalActionReason,
  validateReason,
  validateUuid,
  validateVersion,
  type RequestResult,
} from "../direct-entry/project-operations-model.ts";

export const ACCOUNT_LIST_PAGE_SIZE = 25;
const SEARCH_MAX = 256;

export type AccountEnabledFilter = "all" | "true" | "false";
export type AccountListQuery = {
  search: string;
  enabled: AccountEnabledFilter;
  page: number;
};

export type AccountMutationOutcome =
  | { kind: "applied" }
  | { kind: "conflict"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "actor-not-available"; message: string }
  | { kind: "unauthenticated"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "unavailable"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function errorCode(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.code === "string" ? payload.code : null;
}

export function projectAccountListForQuery(
  payload: unknown,
  query: AccountListQuery,
): ExistingAccountList | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "list"]) || payload.ok !== true) {
    return null;
  }
  const list = projectExistingAccountList(payload.list);
  if (!list) return null;
  const expectedSearch = query.search.trim() || null;
  if (list.search !== expectedSearch || list.enabled !== query.enabled ||
      list.page !== query.page || list.page_size !== ACCOUNT_LIST_PAGE_SIZE) {
    return null;
  }
  return list;
}

export function projectAccountItem(payload: unknown): ExistingAccount | null {
  if (!isRecord(payload) || !exactKeys(payload, ["ok", "account"]) || payload.ok !== true) {
    return null;
  }
  return projectExistingAccount(payload.account);
}

export function buildAccountListQuery(input: AccountListQuery): URLSearchParams | null {
  const search = input.search.trim();
  if (search.length > SEARCH_MAX) return null;
  if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 1000) return null;
  if (input.enabled !== "all" && input.enabled !== "true" && input.enabled !== "false") return null;
  const query = new URLSearchParams({
    enabled: input.enabled,
    page: String(input.page),
    page_size: String(ACCOUNT_LIST_PAGE_SIZE),
  });
  if (search) query.set("search", search);
  return query;
}

export function buildAccountStateRequest(input: {
  expectedVersion: number;
  reason?: string | null;
  idempotencyKey: string;
}): RequestResult {
  const failure = validateVersion(input.expectedVersion)
    ?? (input.expectedVersion < 1 ? "Dữ liệu chưa hợp lệ. Vui lòng tải lại." : null)
    ?? validateReason(input.reason)
    ?? validateUuid(input.idempotencyKey);
  if (failure) return { ok: false, message: failure };
  return {
    ok: true,
    body: {
      expected_version: input.expectedVersion,
      reason: normalizeOptionalActionReason(input.reason),
      idempotency_key: input.idempotencyKey,
    },
  };
}

export function classifyAccountMutation(
  status: number,
  payload: unknown,
): AccountMutationOutcome {
  if (status === 200) {
    // Success is exactly { ok: true } and carries NO projection. Any extra key
    // (an optimistic row) is treated as malformed so the caller never unlocks
    // on a fabricated state.
    return isRecord(payload) && exactKeys(payload, ["ok"]) && payload.ok === true
      ? { kind: "applied" }
      : { kind: "unavailable", message: "Phản hồi không hợp lệ. Có thể thử lại an toàn." };
  }
  if (status === 401) {
    return { kind: "unauthenticated", message: "Phiên đăng nhập không còn hiệu lực." };
  }
  if (status === 403) {
    return errorCode(payload) === "ACTOR_NOT_AVAILABLE"
      ? { kind: "actor-not-available", message: "Không xác định được tài khoản quản trị của bạn. Hãy tải lại trang." }
      : { kind: "denied", message: "Bạn không có quyền thực hiện thao tác này." };
  }
  if (status === 404) return { kind: "not-found", message: "Tài khoản không còn khả dụng." };
  if (status === 409) {
    return { kind: "conflict", message: "Tài khoản đã thay đổi ở nơi khác. Tải lại dữ liệu trước khi tiếp tục." };
  }
  if (status === 400 || status === 422) {
    return { kind: "invalid", message: "Thông tin gửi lên không hợp lệ. Kiểm tra lại các trường." };
  }
  return { kind: "unavailable", message: "Dịch vụ hiện không khả dụng. Có thể thử lại cùng thao tác." };
}

export function newAccountIntentKey(): string {
  return newIdempotencyKey();
}

// ---------------------------------------------------------------------------
// WP4 Extensions — Account Classification & Person Link / Unlink
// ---------------------------------------------------------------------------

export { ACCOUNT_TYPES };
export const ACCOUNT_ORG_MAX_REASON_LENGTH = 500;

export function accountTypeBadgeMeta(accountType: AccountType): {
  label: string;
  tone: BadgeTone;
} {
  switch (accountType) {
    case "NORMAL":
      return { label: "Cá nhân (NORMAL)", tone: "info" };
    case "SHARED":
      return { label: "Dùng chung (SHARED)", tone: "warning" };
    case "SERVICE":
      return { label: "Dịch vụ (SERVICE)", tone: "neutral" };
  }
}

export function canLinkPersonToAccount(
  account: Pick<ExistingAccount, "account_type" | "active_person_link">,
): boolean {
  return account.account_type === "NORMAL" && account.active_person_link === null;
}

export function buildSetAccountClassificationRequest(input: {
  expectedAccountVersion: number;
  accountType: AccountType;
  reason: string;
  idempotencyKey: string;
}):
  | { ok: true; idempotencyKey: string; body: SetAccountTypeBody }
  | { ok: false; message: string } {
  const verFailure =
    validateVersion(input.expectedAccountVersion) ??
    (input.expectedAccountVersion < 1 ? "Dữ liệu đồng bộ không hợp lệ. Vui lòng tải lại." : null);
  if (verFailure) return { ok: false, message: verFailure };

  const idemFailure = validateUuid(input.idempotencyKey);
  if (idemFailure) return { ok: false, message: idemFailure };

  const reasonCheck = parseSafeReason(input.reason);
  if (!reasonCheck.ok) {
    return {
      ok: false,
      message: "Lý do thao tác là bắt buộc (1–500 ký tự, không chứa ký tự điều khiển).",
    };
  }

  const candidate: SetAccountTypeBody = {
    account_type: input.accountType,
    expected_account_version: input.expectedAccountVersion,
    reason: reasonCheck.value,
    idempotency_key: input.idempotencyKey.toLowerCase(),
  };
  const verified = parseSetAccountTypeBody(candidate, candidate.idempotency_key);
  if (!verified.ok) {
    return { ok: false, message: verified.message };
  }
  return { ok: true, idempotencyKey: verified.value.idempotency_key, body: verified.value };
}

export function buildLinkAccountPersonRequest(input: {
  personId: string;
  expectedAccountVersion: number;
  expectedPersonVersion: number;
  confirmedRecruiterId?: string | null;
  reason: string;
  idempotencyKey: string;
}):
  | { ok: true; idempotencyKey: string; body: LinkAccountPersonBody }
  | { ok: false; message: string } {
  if (validateUuid(input.personId)) {
    return { ok: false, message: "Vui lòng chọn hồ sơ nhân sự nội bộ từ danh sách." };
  }
  const accVerFailure =
    validateVersion(input.expectedAccountVersion) ??
    (input.expectedAccountVersion < 1 ? "Dữ liệu đồng bộ tài khoản không hợp lệ." : null);
  if (accVerFailure) return { ok: false, message: accVerFailure };

  const personVerFailure =
    validateVersion(input.expectedPersonVersion) ??
    (input.expectedPersonVersion < 1 ? "Dữ liệu đồng bộ nhân sự không hợp lệ." : null);
  if (personVerFailure) return { ok: false, message: personVerFailure };

  const idemFailure = validateUuid(input.idempotencyKey);
  if (idemFailure) return { ok: false, message: idemFailure };

  if (input.confirmedRecruiterId !== undefined && input.confirmedRecruiterId !== null) {
    if (validateUuid(input.confirmedRecruiterId)) {
      return { ok: false, message: "Vui lòng chọn hồ sơ tính công tuyển dụng cần xác nhận." };
    }
  }

  const reasonCheck = parseSafeReason(input.reason);
  if (!reasonCheck.ok) {
    return {
      ok: false,
      message: "Lý do liên kết là bắt buộc (1–500 ký tự, không chứa ký tự điều khiển).",
    };
  }

  const candidate: LinkAccountPersonBody = {
    person_id: input.personId.toLowerCase(),
    expected_account_version: input.expectedAccountVersion,
    expected_person_version: input.expectedPersonVersion,
    confirmed_recruiter_id: input.confirmedRecruiterId
      ? input.confirmedRecruiterId.toLowerCase()
      : null,
    reason: reasonCheck.value,
    idempotency_key: input.idempotencyKey.toLowerCase(),
  };
  const verified = parseLinkAccountPersonBody(candidate, candidate.idempotency_key);
  if (!verified.ok) {
    return { ok: false, message: verified.message };
  }
  return { ok: true, idempotencyKey: verified.value.idempotency_key, body: verified.value };
}

export function buildUnlinkAccountPersonRequest(input: {
  expectedAccountVersion: number;
  expectedPersonVersion: number;
  expectedLinkId: string;
  reason: string;
  idempotencyKey: string;
}):
  | { ok: true; idempotencyKey: string; body: UnlinkAccountPersonBody }
  | { ok: false; message: string } {
  const accVerFailure =
    validateVersion(input.expectedAccountVersion) ??
    (input.expectedAccountVersion < 1 ? "Dữ liệu đồng bộ tài khoản không hợp lệ." : null);
  if (accVerFailure) return { ok: false, message: accVerFailure };

  const personVerFailure =
    validateVersion(input.expectedPersonVersion) ??
    (input.expectedPersonVersion < 1 ? "Dữ liệu đồng bộ nhân sự không hợp lệ." : null);
  if (personVerFailure) return { ok: false, message: personVerFailure };

  if (validateUuid(input.expectedLinkId)) {
    return { ok: false, message: "Không xác định được liên kết hiện tại. Vui lòng tải lại." };
  }

  const idemFailure = validateUuid(input.idempotencyKey);
  if (idemFailure) return { ok: false, message: idemFailure };

  const reasonCheck = parseSafeReason(input.reason);
  if (!reasonCheck.ok) {
    return {
      ok: false,
      message: "Lý do ngắt liên kết là bắt buộc (1–500 ký tự, không chứa ký tự điều khiển).",
    };
  }

  const candidate: UnlinkAccountPersonBody = {
    expected_account_version: input.expectedAccountVersion,
    expected_person_version: input.expectedPersonVersion,
    expected_link_id: input.expectedLinkId.toLowerCase(),
    reason: reasonCheck.value,
    idempotency_key: input.idempotencyKey.toLowerCase(),
  };
  const verified = parseUnlinkAccountPersonBody(candidate, candidate.idempotency_key);
  if (!verified.ok) {
    return { ok: false, message: verified.message };
  }
  return { ok: true, idempotencyKey: verified.value.idempotency_key, body: verified.value };
}

export type AccountOrgMutationOutcome<T> =
  | { kind: "applied"; replayed: boolean; projection: T }
  | { kind: "session-lost"; message: string; preserveIdempotencyKey: false }
  | { kind: "recruiter-mismatch"; message: string; preserveIdempotencyKey: false }
  | { kind: "hard-conflict"; code: string; message: string; preserveIdempotencyKey: false }
  | { kind: "personal-assignments-block"; message: string; preserveIdempotencyKey: false }
  | { kind: "link-forbidden"; message: string; preserveIdempotencyKey: false }
  | { kind: "conflict"; code: string | null; message: string; preserveIdempotencyKey: false; needsReload: true }
  | { kind: "invalid"; code: string | null; message: string; preserveIdempotencyKey: false }
  | { kind: "uncertain"; message: string; preserveIdempotencyKey: true };

function unwrapAccountOrgOkData(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload) || payload.ok !== true) return null;
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k !== "ok") copy[k] = v;
  }
  return copy;
}

export function classifyAccountOrgMutation(
  status: number,
  payload: unknown,
  operation: "classification",
): AccountOrgMutationOutcome<SetAccountTypeRpcProjection>;
export function classifyAccountOrgMutation(
  status: number,
  payload: unknown,
  operation: "link",
): AccountOrgMutationOutcome<LinkAccountPersonRpcProjection>;
export function classifyAccountOrgMutation(
  status: number,
  payload: unknown,
  operation: "unlink",
): AccountOrgMutationOutcome<UnlinkAccountPersonRpcProjection>;
export function classifyAccountOrgMutation(
  status: number,
  payload: unknown,
  operation: "classification" | "link" | "unlink",
): AccountOrgMutationOutcome<
  SetAccountTypeRpcProjection | LinkAccountPersonRpcProjection | UnlinkAccountPersonRpcProjection
> {
  if (status === 200 || (operation === "link" && status === 201)) {
    const data = unwrapAccountOrgOkData(payload);
    const projected = data
      ? operation === "classification"
        ? projectSetAccountTypeResponse(data)
        : operation === "link"
          ? projectLinkAccountPersonResponse(data)
          : projectUnlinkAccountPersonResponse(data)
      : null;

    if (projected) {
      return { kind: "applied", replayed: projected.replayed, projection: projected };
    }
    return {
      kind: "uncertain",
      message: "Phản hồi máy chủ không đúng định dạng chuẩn. Vui lòng tải lại để đối chiếu.",
      preserveIdempotencyKey: true,
    };
  }

  const code = errorCode(payload);

  if (
    status === 401 ||
    status === 403 ||
    code === "UNAUTHENTICATED" ||
    code === "ORG_ACCESS_DENIED" ||
    code === "ACTOR_NOT_AVAILABLE" ||
    code === "CSRF_REJECTED"
  ) {
    return {
      kind: "session-lost",
      message: "Phiên đăng nhập hoặc quyền quản trị không còn hiệu lực.",
      preserveIdempotencyKey: false,
    };
  }

  if (code === "RECRUITER_LINK_MISMATCH") {
    return {
      kind: "recruiter-mismatch",
      message:
        "Tài khoản đang gắn một hồ sơ tính công tuyển dụng khác với hồ sơ người được chọn. Vui lòng kiểm tra và chọn xác nhận đúng hồ sơ tính công (hoặc hủy thao tác), hệ thống không tự ghi đè danh tính.",
      preserveIdempotencyKey: false,
    };
  }

  if (
    code === "RECRUITER_IDENTITY_CONFLICT" ||
    code === "RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT"
  ) {
    return {
      kind: "hard-conflict",
      code,
      message:
        code === "RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT"
          ? "Hồ sơ tính công tuyển dụng này đã gắn với tài khoản khác nên không thể liên kết chéo."
          : "Xung đột danh tính hồ sơ tính công tuyển dụng giữa tài khoản và nhân sự nội bộ. Không thể tự ghi đè.",
      preserveIdempotencyKey: false,
    };
  }

  if (code === "ACCOUNT_HAS_PERSON_OR_PERSONAL_ASSIGNMENTS") {
    return {
      kind: "personal-assignments-block",
      message:
        "Tài khoản đang liên kết hồ sơ người hoặc còn phân công cá nhân đang hiệu lực nên không thể đổi sang SHARED/SERVICE. Vui lòng ngắt liên kết và xử lý phân công tại màn hình tương ứng; hệ thống không tự động thu hồi.",
      preserveIdempotencyKey: false,
    };
  }

  if (code === "ACCOUNT_TYPE_LINK_FORBIDDEN") {
    return {
      kind: "link-forbidden",
      message:
        "Tài khoản phân loại SHARED hoặc SERVICE không được phép liên kết hồ sơ nhân sự nội bộ.",
      preserveIdempotencyKey: false,
    };
  }

  if (code === "IDEMPOTENCY_IN_PROGRESS" || status >= 500 || status === 0) {
    return {
      kind: "uncertain",
      message:
        "Chưa nhận được kết quả xác nhận từ máy chủ. Dữ liệu và khóa gửi trùng được giữ nguyên để thử gửi lại đúng yêu cầu hoặc tải lại đối chiếu.",
      preserveIdempotencyKey: true,
    };
  }

  if (
    code === "VERSION_CONFLICT" ||
    code === "IDEMPOTENCY_CONFLICT" ||
    code === "ACCOUNT_ALREADY_LINKED" ||
    code === "PERSON_ALREADY_LINKED" ||
    code === "LINK_ALREADY_ENDED" ||
    status === 409
  ) {
    return {
      kind: "conflict",
      code,
      message:
        "Dữ liệu tài khoản hoặc nhân sự đã thay đổi ở nơi khác. Vui lòng tải lại dữ liệu mới nhất trước khi thực hiện tiếp.",
      preserveIdempotencyKey: false,
      needsReload: true,
    };
  }

  const invalidMessages: Record<string, string> = {
    PERSON_INACTIVE: "Nhân sự được chọn đã ngừng hoạt động (INACTIVE), không thể liên kết tài khoản.",
    ACCOUNT_NOT_FOUND: "Không tìm thấy tài khoản trên máy chủ.",
    PERSON_NOT_FOUND: "Không tìm thấy hồ sơ nhân sự được chọn.",
    ORG_VALIDATION_ERROR: "Thông tin gửi lên không hợp lệ. Vui lòng kiểm tra lại.",
  };

  return {
    kind: "invalid",
    code,
    message: (code && invalidMessages[code]) ?? "Không thể hoàn tất thao tác. Vui lòng kiểm tra lại.",
    preserveIdempotencyKey: false,
  };
}

export type {
  AccountType,
  LinkAccountPersonBody,
  LinkAccountPersonRpcProjection,
  SetAccountTypeBody,
  SetAccountTypeRpcProjection,
  UnlinkAccountPersonBody,
  UnlinkAccountPersonRpcProjection,
};
