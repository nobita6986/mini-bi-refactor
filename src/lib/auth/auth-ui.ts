/**
 * P3-W03-S01B - Pure helpers cho login UI (khong I/O, khong framework).
 */
export const SAFE_AUTH_DESTINATIONS = ["/dashboard", "/direct-entry"] as const;
export const SAFE_PARTNER_DESTINATIONS = [
  "/partner",
  "/partner/recruitment",
  "/partner/workers",
  "/partner/profile",
  "/partner/change-password",
] as const;

function extractPathname(next: string | null | undefined): string | null {
  if (typeof next !== "string" || next.length === 0) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  return next.split(/[?#]/)[0];
}

/** Chi cho phep destination noi bo exact trong allowlist; moi thu khac ve /dashboard. */
export function resolveSafeAuthDestination(next: string | null | undefined): string {
  const path = extractPathname(next);
  if (!path) return "/dashboard";
  return (SAFE_AUTH_DESTINATIONS as readonly string[]).includes(path) ? path : "/dashboard";
}

export type PostLoginActorLike = {
  partner_account?: {
    partner_kind?: string;
    account_state?: string;
    must_change_password?: boolean;
  } | null;
};

export type PostLoginActorInput =
  | { ok: true; actor: PostLoginActorLike }
  | { ok: false; reason?: string }
  | { actor: PostLoginActorLike }
  | PostLoginActorLike
  | null
  | undefined;

function extractPartnerAccount(input: PostLoginActorInput): PostLoginActorLike["partner_account"] {
  if (!input || typeof input !== "object") return undefined;
  if ("ok" in input && typeof input.ok === "boolean") {
    return input.ok ? input.actor?.partner_account : undefined;
  }
  if ("actor" in input && input.actor && typeof input.actor === "object") {
    return input.actor.partner_account;
  }
  if ("partner_account" in input) {
    return input.partner_account;
  }
  return undefined;
}

/**
 * Resolves the safe post-login redirect path for both BI employees and Partner accounts.
 * - BI employees (no `partner_account`): delegates strictly to `resolveSafeAuthDestination`.
 * - Partner accounts requiring password change: forces `/partner/change-password`.
 * - Active VENDOR accounts: allows `SAFE_PARTNER_DESTINATIONS`, defaulting to `/partner/recruitment`.
 * - Active COLLABORATOR accounts: allows `/partner`, `/partner/profile`, `/partner/change-password`, defaulting to `/partner/profile`.
 */
export function resolvePostLoginDestination(
  actorProjectionOrResolution: PostLoginActorInput,
  next?: string | null | undefined,
): string {
  const partnerAccount = extractPartnerAccount(actorProjectionOrResolution);
  if (!partnerAccount) {
    return resolveSafeAuthDestination(next);
  }
  if (
    partnerAccount.must_change_password === true ||
    partnerAccount.account_state === "ACTIVE_MUST_CHANGE_PASSWORD"
  ) {
    return "/partner/change-password";
  }
  const defaultDest =
    partnerAccount.partner_kind === "VENDOR"
      ? "/partner/recruitment"
      : partnerAccount.partner_kind === "COLLABORATOR"
        ? "/partner/profile"
        : "/partner";
  const path = extractPathname(next);
  if (path && (SAFE_PARTNER_DESTINATIONS as readonly string[]).includes(path)) {
    if (
      partnerAccount.partner_kind === "COLLABORATOR" &&
      (path === "/partner/recruitment" || path === "/partner/workers")
    ) {
      return "/partner/profile";
    }
    return path;
  }
  return defaultDest;
}

export const AUTH_UI_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  AUTH_REQUEST_INVALID: "Thông tin đăng nhập chưa hợp lệ.",
  AUTH_INVALID_CREDENTIALS: "Email hoặc mật khẩu không đúng.",
  AUTH_INVALID_CURRENT_PASSWORD: "Mật khẩu hiện tại không đúng.",
  AUTH_PASSWORD_TOO_WEAK: "Mật khẩu mới cần tối thiểu 8 ký tự và khác mật khẩu hiện tại.",
  AUTH_UNAUTHENTICATED: "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.",
  ACCOUNT_NOT_AVAILABLE: "Tài khoản chưa được cấp quyền sử dụng hệ thống.",
  ACCOUNT_PENDING_ACTIVATION: "Tài khoản đối tác chưa được kích hoạt. Vui lòng nhập mã kích hoạt trước khi đăng nhập.",
  PARTNER_ACTIVATION_INVALID: "Mã đối tác hoặc mã kích hoạt không hợp lệ hoặc đã hết hạn.",
  PASSWORD_CHANGE_REQUIRED: "Vui lòng đổi mật khẩu lần đầu trước khi sử dụng cổng đối tác.",
  PARTNER_FORBIDDEN: "Tài khoản của bạn không có quyền truy cập chức năng cổng đối tác này.",
  PARTNER_CODE_CONFLICT: "Mã đối tác bị trùng giữa danh mục Vendor và Cộng tác viên.",
  AUTH_UNAVAILABLE: "Hệ thống xác thực tạm thời không khả dụng.",
  CSRF_REJECTED: "Phiên hoặc yêu cầu không hợp lệ. Vui lòng tải lại trang.",
});

/** P3-W03-S02B: auth hop le nhung thieu capability cho resource. */
export const ACCESS_DENIED_MESSAGE = "Bạn không có quyền truy cập chức năng này.";

export function authUiErrorMessage(code: string): string {
  return AUTH_UI_ERROR_MESSAGES[code] ?? AUTH_UI_ERROR_MESSAGES.AUTH_UNAVAILABLE;
}
