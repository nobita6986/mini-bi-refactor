import assert from "node:assert/strict";
import test from "node:test";

import {
  SAFE_PARTNER_DESTINATIONS,
  authUiErrorMessage,
  resolvePostLoginDestination,
  resolveSafeAuthDestination,
} from "./auth-ui.ts";

test("safe destination allowlist: chi /dashboard va /direct-entry", () => {
  assert.equal(resolveSafeAuthDestination(null), "/dashboard");
  assert.equal(resolveSafeAuthDestination(undefined), "/dashboard");
  assert.equal(resolveSafeAuthDestination(""), "/dashboard");
  assert.equal(resolveSafeAuthDestination("/dashboard"), "/dashboard");
  assert.equal(resolveSafeAuthDestination("/direct-entry"), "/direct-entry");
  assert.equal(resolveSafeAuthDestination("/dashboard?tab=1"), "/dashboard");
  assert.equal(resolveSafeAuthDestination("/direct-entry#top"), "/direct-entry");
});

test("reject absolute, protocol-relative, encoded and out-of-allowlist destinations", () => {
  for (const next of [
    "https://evil.example/", "http://evil.example", "//evil.example",
    "%2F%2Fevil.example", "%2Fdashboard", "/admin", "/direct-entry-extra",
    "/dashboard/../direct-entry", "javascript:alert(1)", "/dashboard%00",
  ]) {
    assert.equal(resolveSafeAuthDestination(next), "/dashboard", next);
  }
});

test("error-code mapping is sanitized and never echoes raw codes", () => {
  assert.equal(authUiErrorMessage("AUTH_REQUEST_INVALID"), "Thông tin đăng nhập chưa hợp lệ.");
  assert.equal(authUiErrorMessage("AUTH_INVALID_CREDENTIALS"), "Email hoặc mật khẩu không đúng.");
  assert.equal(authUiErrorMessage("ACCOUNT_NOT_AVAILABLE"), "Tài khoản chưa được cấp quyền sử dụng hệ thống.");
  assert.equal(authUiErrorMessage("AUTH_UNAVAILABLE"), "Hệ thống xác thực tạm thời không khả dụng.");
  assert.equal(authUiErrorMessage("UNKNOWN_CODE"), authUiErrorMessage("AUTH_UNAVAILABLE"));
  assert.equal(authUiErrorMessage("CSRF_REJECTED"), "Phiên hoặc yêu cầu không hợp lệ. Vui lòng tải lại trang.");
  assert.equal(authUiErrorMessage("CSRF_REJECTED").includes("CSRF_REJECTED"), false);

  for (const code of [
    "ACCOUNT_PENDING_ACTIVATION",
    "PARTNER_ACTIVATION_INVALID",
    "PASSWORD_CHANGE_REQUIRED",
    "PARTNER_FORBIDDEN",
    "PARTNER_CODE_CONFLICT",
  ]) {
    const msg = authUiErrorMessage(code);
    assert.ok(msg.length > 0, code);
    assert.equal(msg.includes(code), false, code);
    assert.notEqual(msg, authUiErrorMessage("AUTH_UNAVAILABLE"), code);
  }
});

test("resolvePostLoginDestination separates BI employees and partner accounts safely", () => {
  assert.deepEqual(SAFE_PARTNER_DESTINATIONS, [
    "/partner",
    "/partner/recruitment",
    "/partner/workers",
    "/partner/profile",
    "/partner/change-password",
  ]);

  // Regular BI employee stays on BI allowlist
  assert.equal(resolvePostLoginDestination({ partner_account: undefined }, "/direct-entry"), "/direct-entry");
  assert.equal(resolvePostLoginDestination({ partner_account: undefined }, "/partner"), "/dashboard");
  assert.equal(resolvePostLoginDestination({ partner_account: undefined }, "/partner/recruitment"), "/dashboard");
  assert.equal(resolvePostLoginDestination({ ok: true, actor: {} }, "//evil.example"), "/dashboard");

  // Partner with must_change_password=true is forced to /partner/change-password
  assert.equal(
    resolvePostLoginDestination(
      {
        partner_account: {
          partner_kind: "VENDOR",
          account_state: "ACTIVE_MUST_CHANGE_PASSWORD",
          must_change_password: true,
        },
      },
      "/partner",
    ),
    "/partner/change-password",
  );

  // Active VENDOR defaults to /partner/recruitment and allows vendor portal destinations
  const activeVendor = {
    ok: true,
    actor: {
      partner_account: {
        partner_kind: "VENDOR",
        account_state: "ACTIVE",
        must_change_password: false,
      },
    },
  };
  assert.equal(resolvePostLoginDestination(activeVendor, null), "/partner/recruitment");
  assert.equal(resolvePostLoginDestination(activeVendor, "/partner/workers?page=2"), "/partner/workers");
  assert.equal(resolvePostLoginDestination(activeVendor, "/partner/profile"), "/partner/profile");
  assert.equal(resolvePostLoginDestination(activeVendor, "/dashboard"), "/partner/recruitment");

  // Active COLLABORATOR defaults to /partner/profile and rejects BI/vendor-only/external routes
  const activeCollab = {
    actor: {
      partner_account: {
        partner_kind: "COLLABORATOR",
        account_state: "ACTIVE",
        must_change_password: false,
      },
    },
  };
  assert.equal(resolvePostLoginDestination(activeCollab, null), "/partner/profile");
  assert.equal(resolvePostLoginDestination(activeCollab, "/partner/profile?tab=1"), "/partner/profile");
  assert.equal(resolvePostLoginDestination(activeCollab, "/partner/recruitment"), "/partner/profile");
  assert.equal(resolvePostLoginDestination(activeCollab, "/partner/workers"), "/partner/profile");
  assert.equal(resolvePostLoginDestination(activeCollab, "/dashboard"), "/partner/profile");
  assert.equal(resolvePostLoginDestination(activeCollab, "/direct-entry"), "/partner/profile");
  assert.equal(resolvePostLoginDestination(activeCollab, "https://evil.example"), "/partner/profile");
});
