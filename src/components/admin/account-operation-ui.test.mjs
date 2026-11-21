/**
 * PRE-W2-HF-D3-B - source/structure test for the Account Manager D3-B UI.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./account-manager.tsx", import.meta.url), "utf8");
const model = readFileSync(new URL("../../lib/admin/account-operation-ui-model.ts", import.meta.url), "utf8");

test("D3-B: create/edit/reset dialogs wire the D3-B routes and optional reason", () => {
  assert.match(source, /Tạo tài khoản/);
  assert.match(source, /Sửa tên/);
  assert.match(source, /Đặt lại mật khẩu/);
  assert.match(source, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(accountRef\)\}\/display-name/);
  assert.match(source, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(accountRef\)\}\/reset-password/);
  assert.match(source, /\/api\/admin\/access\/accounts"$/m);
  assert.match(source, /buildCreateAccountRequest/);
  assert.match(source, /buildEditDisplayNameRequest/);
  assert.match(source, /buildResetPasswordRequest/);
  assert.match(source, /ReasonField/);
  assert.match(source, /Lý do thao tác \(không bắt buộc\)/);
});

test("D3-B: passwords are typed password and never logged", () => {
  assert.match(source, /type="password"/);
  assert.match(source, /autoComplete="new-password"/);
  // No console logging of password/body anywhere in the component.
  assert.doesNotMatch(source, /console\.(log|error|warn|debug|info)/);
  // Password never appears as plain JSX text (only as a masked input value).
  assert.doesNotMatch(source, /<td[^>]*>\s*\{password\}|<span[^>]*>\s*\{password\}|\{passwordConfirm\}\s*<\/td>/);
});

test("D3-B: reconcile surface shows BLOCKED/INDETERMINATE handling, no auto-retry", () => {
  assert.match(source, /Đối soát/);
  assert.match(source, /Operation cần xử lý/);
  assert.match(source, /Không tự retry Auth/);
  assert.match(source, /\/api\/admin\/access\/accounts\/intents\/\$\{encodeURIComponent\(intentId\)\}\/reconcile/);
  assert.match(source, /classifyAccountOperationResponse/);
});

test("D3-B: reclassify is wired to the retention RPC route, no cron", () => {
  assert.match(source, /Phân loại lại/);
  assert.match(source, /\/api\/admin\/access\/accounts\/reclassify/);
  assert.match(source, /reclassified/);
  assert.doesNotMatch(source, /setTimeout|cron|setInterval/);
});

test("D3-B: reclassify fires once on list mount via ref guard, not on filter/page/search", () => {
  assert.match(source, /reclassifyFiredRef = useRef\(false\)/);
  assert.match(source, /if \(reclassifyFiredRef\.current\) return;/);
  assert.match(source, /reclassifyFiredRef\.current = true;/);
  assert.match(source, /\/api\/admin\/access\/accounts\/reclassify/);
  // Sanitized error copy, no intent/PII detail.
  assert.match(source, /Không phân loại lại được intent tồn đọng/);
  // The list load keeps only search/page/filter/view/reload as its dependency (never reclassify).
  assert.match(source, /\[enabledFilter, page, reloadToken, search, viewAccountType, viewLinkState\]/);
});

test("D3-B: no auth_subject/intent_token/raw identity rendered in the UI surface", () => {
  for (const file of [source, model]) {
    assert.doesNotMatch(file, /\{intent_token\}|\{auth_subject\}/);
    assert.doesNotMatch(file, /app_metadata|account_intent/);
  }
});

test("hotfix retry: AccountOperationDialogs locks password/inputs/close on uncertain error and never persists secrets", () => {
  assert.match(source, /type AccountOperationPendingRequest/);
  assert.match(source, /disabled=\{fieldsDisabled\}/);
  assert.match(source, /function PasswordField\([^)]*disabled = false/);
  assert.match(source, /if \(isDialogLocked\) event\.preventDefault\(\)/);
  assert.match(source, /Thử gửi lại cùng yêu cầu/);
  assert.match(source, /Tải lại đối chiếu/);
  assert.doesNotMatch(source, /sessionStorage|localStorage/);
});
