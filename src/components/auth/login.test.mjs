import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative) {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const form = source("./login-form.tsx");
const gate = source("./login-gate.tsx");
const control = source("../app-shell/user-session-control.tsx");
const page = source("../../app/login/page.tsx");

test("login form: native form, mot POST, identifier trim, password khong trim", () => {
  assert.match(form, /<form onSubmit=/);
  assert.match(form, /\/api\/auth\/login/);
  assert.match(form, /method: "POST"/);
  assert.equal((form.match(/fetch\(/g) ?? []).length, 1);
  assert.match(form, /identifier\.trim\(\), password/);
  assert.match(form, /Mã đăng nhập hoặc Email/);
  assert.match(form, /href="\/activate"/);
  assert.match(form, /Kích hoạt tài khoản Vendor\/CTV lần đầu/);
  assert.match(form, /resolvePostLoginDestination/);
  assert.match(form, /type="text"/);
  assert.match(form, /type=\{showPassword \? "text" : "password"\}/);
  assert.match(form, /aria-label=\{showPassword \? "Ẩn mật khẩu" : "Hiện mật khẩu"\}/);
  assert.match(form, /autoComplete="username"/);
  assert.match(form, /autoComplete="current-password"/);
  assert.match(form, /spellCheck=\{false\}/);
});

test("login form: chan double submit, xoa password sau loi, khong luu tru/credential", () => {
  assert.match(form, /if \(busy\) return;/);
  assert.match(form, /disabled=\{busy\}/);
  assert.match(form, /aria-busy=\{busy\}/);
  assert.match(form, /setPassword\(""\)/);
  assert.doesNotMatch(form + gate + control, /localStorage|sessionStorage/);
  assert.doesNotMatch(form, /console\.(?:log|error|warn)\(/);
  assert.doesNotMatch(form + gate, /app_user_id|auth_subject|capabilit|scope_kind|self_recruiter/);
});

test("login gate: session goi mot lan, safe redirect, khong auto-loop", () => {
  assert.match(gate, /\/api\/auth\/session/);
  assert.equal((gate.match(/fetch\("\/api\/auth\/session"/g) ?? []).length, 1);
  assert.match(gate, /resolveSafeAuthDestination\(searchParams\.get\("next"\)\)/);
  assert.match(gate, /resolvePostLoginDestination/);
  assert.match(gate, /ACCOUNT_PENDING_ACTIVATION/);
  assert.match(gate, /href="\/activate"/);
  assert.match(gate, /router\.replace\(destination\)/);
  assert.match(gate, /res\.status === 401/);
  assert.match(gate, /res\.status === 403/);
  assert.match(gate, /setAttempt\(\(value\) => value \+ 1\)/);
  assert.doesNotMatch(gate, /setTimeout|setInterval/);
});

test("session control: logout 204 -> /login, khong gia vo thanh cong, 44px touch", () => {
  assert.match(control, /\/api\/auth\/logout/);
  assert.match(control, /res\.status === 204/);
  assert.match(control, /router\.replace\("\/login"\)/);
  assert.match(control, /Không thể đăng xuất lúc này/);
  assert.doesNotMatch(control, /app_user_id|capabilit|scope/);
  assert.match(control, /h-11/);
  assert.doesNotMatch(control, /localStorage|sessionStorage/);
});

test("login page la server page mong + Suspense", () => {
  assert.match(page, /export const metadata/);
  assert.match(page, /<Suspense/);
  assert.match(page, /<LoginGate \/>/);
});
