import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveAssignmentCreateAttempt } from "./assignment-create-idempotency.ts";

function baseFormInput(overrides = {}) {
  return {
    template_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    target_kind: "USER_SET",
    target_user_id: null,
    target_team_id: null,
    target_group_id: null,
    target_user_ids: [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ],
    frequency: "DAILY",
    is_mandatory: true,
    due_day_offset: 0,
    due_time_local: "23:59:59",
    exclude_sundays: false,
    ...overrides,
  };
}

test("assignment create retry helper omits dates and reuses exact key and payload on retries", () => {
  let seq = 0;
  const nextKey = () => `key-${++seq}`;
  const input = baseFormInput();

  const firstAttempt = resolveAssignmentCreateAttempt(null, input, nextKey);
  assert.equal(firstAttempt.idempotency_key, "key-1");
  assert.equal("effective_from" in firstAttempt.payload, false);
  assert.equal("effective_to" in firstAttempt.payload, false);
  assert.deepEqual(firstAttempt.payload.target_user_ids, input.target_user_ids);

  // Retry after network or server failure with unchanged fields reuses exact same key + payload
  const retryAttempt = resolveAssignmentCreateAttempt(firstAttempt, baseFormInput(), nextKey);
  assert.equal(retryAttempt, firstAttempt);
  assert.equal(retryAttempt.idempotency_key, "key-1");
  assert.equal(seq, 1);

  // Changing any form field rotates to a fresh idempotency key and payload
  const changedFieldAttempt = resolveAssignmentCreateAttempt(
    retryAttempt,
    baseFormInput({ frequency: "WEEKLY" }),
    nextKey,
  );
  assert.equal(changedFieldAttempt.idempotency_key, "key-2");
  assert.equal(changedFieldAttempt.payload.frequency, "WEEKLY");

  // Resetting pending attempt after create success rotates to a fresh key even with identical inputs
  const afterSuccessAttempt = resolveAssignmentCreateAttempt(
    null,
    baseFormInput({ frequency: "WEEKLY" }),
    nextKey,
  );
  assert.equal(afterSuccessAttempt.idempotency_key, "key-3");
});

test("assignment manager UI removes effective_from input, displays server-date summary, and wires idempotency retry ref", async () => {
  const source = await readFile(
    new URL("../../components/work-reports/renderer/assignment-manager.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /effectiveFrom|setEffectiveFrom/);
  assert.doesNotMatch(source, /type="date"/);
  assert.doesNotMatch(source, /effective_from:\s*effectiveFrom/);
  assert.doesNotMatch(source, /effective_to:\s*null/);
  assert.match(source, /Hiệu lực ngay khi lưu \(ngày VN trên máy chủ\)/);
  assert.match(source, /assignment\.effective_from/);
  assert.match(source, /pendingCreateAttemptRef/);
  assert.match(source, /resolveAssignmentCreateAttempt/);
  assert.match(source, /WORK_REPORT_ASSIGNMENT_INVALID/);
});
