import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProposerItems,
  canWithdrawChangeRequest,
  changeRequestErrorMessage,
  changedProposerFields,
  CHANGE_REQUEST_STATE_LABELS,
  normalizeReason,
  projectProposerEntry,
  projectionSlice,
  proposalFromDraft,
  proposerErrorMessage,
  PROPOSER_FIELD_ORDER,
  summarizeProposal,
} from "./change-request-proposer.ts";

const entryA = "c1000000-0000-4000-8000-000000000001";
const workerPlaceholder = "worker" + "_details";
const entryB = "c1000000-0000-4000-8000-000000000002";

function fields(overrides = {}) {
  return {
    employee_code: "hrp-2026-000001",
    first_work_date: "2026-10-15",
    project_id: "project_synthetic_01",
    recruiter_id: "93000000-0000-4000-8000-000000000001",
    collaborator_id: null,
    labor_type: "TEMPORARY",
    ...overrides,
  };
}

function draft(entryId, overrides = {}) {
  return {
    entry_id: entryId,
    expected_version: 1,
    baseline: fields(),
    draft: fields(overrides),
  };
}

test("state labels cover the four change-request states", () => {
  assert.deepEqual(CHANGE_REQUEST_STATE_LABELS, {
    PENDING: "Chờ duyệt",
    APPROVED: "Đã duyệt",
    REJECTED: "Đã từ chối",
    WITHDRAWN: "Đã rút",
  });
  assert.deepEqual([...PROPOSER_FIELD_ORDER], [
    "employee_code", "first_work_date", "project_id", "recruiter_id", "collaborator_id", "labor_type",
  ]);
});

test("proposal only carries changed non-PII entry fields", () => {
  assert.deepEqual(proposalFromDraft(fields(), fields()), {});
  assert.deepEqual(proposalFromDraft(fields(), fields({ employee_code: "hrp-2026-000009" })), {
    employee_code: "hrp-2026-000009",
  });
  assert.deepEqual(proposalFromDraft(fields(), fields({
    labor_type: "PERMANENT",
    project_id: "project_synthetic_02",
  })), { project_id: "project_synthetic_02", labor_type: "PERMANENT" });
  assert.deepEqual(changedProposerFields(fields(), fields({ first_work_date: "2026-10-16" })),
    ["first_work_date"]);
  const proposal = proposalFromDraft(fields(), fields({ recruiter_id: entryA }));
  assert.deepEqual(Object.keys(proposal), ["recruiter_id"]);
  for (const forbidden of ["worker_details", "payment", "status", "document_type",
    "account_number", "national_id", "display_name", "capability", "scope"]) {
    assert.equal(forbidden in proposal, false, forbidden);
  }
});

test("multi-entry items are atomic in one payload with no duplicates", () => {
  const single = buildProposerItems([draft(entryA, { labor_type: "PERMANENT" })]);
  assert.equal(single.ok, true);
  assert.deepEqual(single.items, [{
    entry_id: entryA,
    target_kind: "ENTRY_FIELD",
    expected_version: 1,
    proposal: { labor_type: "PERMANENT" },
  }]);

  const multi = buildProposerItems([
    draft(entryA, { labor_type: "PERMANENT" }),
    draft(entryB, { employee_code: "hrp-2026-000002" }),
  ]);
  assert.equal(multi.ok, true);
  assert.equal(multi.items.length, 2);
  assert.deepEqual(multi.items.map((item) => item.target_kind), ["ENTRY_FIELD", "ENTRY_FIELD"]);

  assert.deepEqual(buildProposerItems([]), { ok: false, code: "NO_ENTRY" });
  assert.deepEqual(buildProposerItems([draft(entryA, { labor_type: "PERMANENT" }),
    draft(entryA, { employee_code: "hrp-2026-000003" })]), { ok: false, code: "DUPLICATE_ENTRY" });
  assert.deepEqual(buildProposerItems([draft(entryA)]), { ok: false, code: "NO_CHANGE" });
  assert.deepEqual(buildProposerItems([{
    entry_id: entryA,
    expected_version: 0,
    baseline: fields(),
    draft: fields({ labor_type: "PERMANENT" }),
  }]), { ok: false, code: "ENTRY_VERSION_INVALID" });
  assert.match(proposerErrorMessage("NO_CHANGE"), /ít nhất một thay đổi/);
  assert.match(proposerErrorMessage("DUPLICATE_ENTRY"), /một lần/);
});

test("reason is trimmed and bounded, withdraw follows server flags only", () => {
  assert.equal(normalizeReason("  Lý do thay đổi  "), "Lý do thay đổi");
  assert.equal(normalizeReason("   "), null);
  assert.equal(normalizeReason(""), null);
  assert.equal(normalizeReason(null), null);
  assert.equal(normalizeReason("x".repeat(4000)), "x".repeat(4000));
  assert.equal(normalizeReason("x".repeat(4001)), "x".repeat(4001));

  assert.equal(canWithdrawChangeRequest({ state: "PENDING", can_withdraw: true }), true);
  assert.equal(canWithdrawChangeRequest({ state: "PENDING", can_withdraw: false }), false);
  for (const state of ["APPROVED", "REJECTED", "WITHDRAWN"]) {
    assert.equal(canWithdrawChangeRequest({ state, can_withdraw: true }), false, state);
  }
});

test("entry projection reads only the five non-PII fields", () => {
  const projection = projectProposerEntry({
    entry_id: entryA,
    submission_id: "b1000000-0000-4000-8000-000000000001",
    version: 3,
    project_id: "project_synthetic_01",
    first_work_date: "2026-10-15",
    employee_code: "hrp-2026-000001",
    recruiter_id: "93000000-0000-4000-8000-000000000001",
    labor_type: "TEMPORARY",
    labor_type_display: "Nhãn loại hình",
    worker_details: { display_name: "Kín", national_id: { state: "provided", value: "0123" } },
    payment: { state: "provided", account_number: "000012340056" },
    documents: [{ document_id: entryA }],
    team_id: "94000000-0000-4000-8000-000000000001",
    provider_type: "hrp",
  });
  assert.deepEqual(projection, {
    entry_id: entryA,
    expected_version: 3,
    project_id: "project_synthetic_01",
    first_work_date: "2026-10-15",
    employee_code: "hrp-2026-000001",
    recruiter_id: "93000000-0000-4000-8000-000000000001",
    collaborator_id: null,
    collaborator_display_name: null,
    provider_type: "hrp",
    labor_type: "TEMPORARY",
    labor_type_display: "Nhãn loại hình",
  });
  const serialized = JSON.stringify(projection);
  for (const forbidden of [workerPlaceholder, "payment", "documents", "account_number", "submission_id"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(projectProposerEntry({ ...{ entry_id: entryA, version: 0 } }), null);
  assert.equal(projectProposerEntry({ entry_id: "not-a-uuid", version: 1 }), null);
  assert.equal(projectProposerEntry(null), null);
});

test("projection slice and messages stay strict and sanitized", () => {
  assert.deepEqual(projectionSlice({ ok: true, a: 1, b: 2, extra: 3 }, ["a", "b"]), { a: 1, b: 2 });
  assert.equal(projectionSlice({ ok: false, a: 1 }, ["a"]), null);
  assert.equal(projectionSlice({ a: 1 }, ["a"]), null);
  assert.equal(projectionSlice({ ok: true, a: 1 }, ["a", "b"]), null);
  assert.equal(projectionSlice(null, ["a"]), null);
  assert.equal(projectionSlice([], ["a"]), null);

  for (const status of [400, 401, 403, 404, 409, 500, 0]) {
    const message = changeRequestErrorMessage(status);
    assert.doesNotMatch(message, /SQLSTATE|pg_|Error:|traceback/i);
  }
  assert.match(changeRequestErrorMessage(409), /tải lại/);
  assert.equal(summarizeProposal({ labor_type: "PERMANENT", project_id: "p" }),
    "Dự án, Loại hình lao động");
  assert.equal(summarizeProposal({}), "");
});
