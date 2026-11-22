/**
 * PRE-W2-HF-D3-B & PR #28 — source/structure security test for unified Account Operation UI.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const detailSource = readFileSync(
  new URL("./account-directory-detail-manager.tsx", import.meta.url),
  "utf8",
);
const personDetailSource = readFileSync(
  new URL("./person-detail-manager.tsx", import.meta.url),
  "utf8",
);
const stepperSource = readFileSync(
  new URL("./account-provision-and-link-stepper.tsx", import.meta.url),
  "utf8",
);
const model = readFileSync(
  new URL("../../lib/admin/account-operation-ui-model.ts", import.meta.url),
  "utf8",
);

test("D3-B + PR #28: unified user UI wires create, edit display name, reset password & reconcile routes", () => {
  assert.match(stepperSource, /buildCreateAccountRequest/);
  assert.match(stepperSource, /\/api\/admin\/access\/accounts\/intents\/\$\{encodeURIComponent\(intentId\)\}\/reconcile/);
  assert.match(detailSource, /Sửa tên hiển thị/);
  assert.match(detailSource, /Đặt lại mật khẩu/);
  assert.match(detailSource, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(account\.account_ref\)\}\/display-name/);
  assert.match(detailSource, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(account\.account_ref\)\}\/reset-password/);
  assert.match(detailSource, /buildEditDisplayNameRequest/);
  assert.match(detailSource, /buildResetPasswordRequest/);
  assert.match(personDetailSource, /buildResetPasswordRequest/);
  assert.match(personDetailSource, /classifyAccountOperationResponse/);
});

test("D3-B + PR #28: passwords stay RAM-only, typed password, and are never logged or persisted", () => {
  for (const src of [detailSource, personDetailSource, stepperSource]) {
    assert.match(src, /type="password"/);
    assert.match(src, /autoComplete="new-password"/);
    assert.doesNotMatch(src, /console\.(log|error|warn|debug|info)/);
  }
  assert.doesNotMatch(detailSource, /sessionStorage|localStorage/);
  assert.doesNotMatch(detailSource, /\{intent_token\}|\{auth_subject\}/);
  assert.doesNotMatch(model, /\{intent_token\}|\{auth_subject\}/);
});
