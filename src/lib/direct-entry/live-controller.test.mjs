import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptDraftCreate,
  acceptDraftUpdate,
  applyServerDraft,
  buildDraftUpdatePayload,
  changedDraftFields,
  draftRowFromProjection,
  editableFields,
  failDraftWrite,
  fieldsDiffer,
  keepLocalDraft,
  markDraftConflict,
  newDraftRow,
  stableLiveDraftKey,
  updateLiveDraftRow,
} from "./live-controller.ts";

const projection = {
  submission_id: "a1000000-0000-4000-8000-000000000001",
  submission_version: 2,
  entry_id: "a2000000-0000-4000-8000-000000000001",
  entry_version: 3,
  employee_code: "hrp-2026-900001",
  first_work_date: "2026-10-15",
  worker_display_name: "Synthetic Worker",
  project_id: "project_synthetic_01",
  project_display_name: "Synthetic project",
  recruiter_id: "93000000-0000-4000-8000-000000000001",
  recruiter_display_name: "Synthetic recruiter",
  provider_type: "hrp",
  team_id: "94000000-0000-4000-8000-000000000001",
  team_display_name: "Synthetic team",
  labor_type: "PROBATION",
  labor_type_display: "Thử việc",
  employment_status: "UNCONFIRMED",
  created_at: "2026-10-03T00:00:00.000Z",
  updated_at: "2026-10-03T00:00:00.000Z",
  profile: {
    contract_version: "worker-profile/1.0",
    worker_details: {
      display_name: { state: "provided", value: "Synthetic Worker" },
      gender: { state: "omitted" },
      date_of_birth: { state: "omitted" },
      national_id: { state: "omitted" },
      national_id_issued_at: { state: "omitted" },
      national_id_issued_place: { state: "omitted" },
      address: { state: "omitted" },
      phone: { state: "omitted" },
    },
    general_note: { state: "omitted" },
    employment: null,
    payment: null,
  },
};

const visiblePayment = {
  state: "provided",
  account_number: { state: "provided", value: "000098765432" },
  bank_name: { state: "provided", value: "Synthetic Bank" },
  account_holder_name: { state: "provided", value: "Synthetic Holder" },
  version: 2,
};

function fieldsWithPayment(payment) {
  const row = draftRowFromProjection({
    ...projection,
    profile: { ...projection.profile, payment },
  });
  return editableFields(row);
}

test("draft update payload omits unchanged payment during unrelated edits", () => {
  const fields = fieldsWithPayment(visiblePayment);
  const patch = buildDraftUpdatePayload({
    ...fields,
    workerName: "Synthetic renamed worker",
    firstWorkDate: "2026-10-16",
  }, visiblePayment);
  assert.ok(patch);
  assert.equal(Object.hasOwn(patch, "payment"), false);
});

test("masked or redacted payment stays omitted and cannot be explicitly blanked", () => {
  const hiddenPayment = {
    state: "provided",
    account_number: { state: "masked", value: "••••5432" },
    bank_name: { state: "redacted", present: true },
    account_holder_name: { state: "redacted", present: true },
    version: 3,
  };
  const fields = fieldsWithPayment(hiddenPayment);
  const unrelated = buildDraftUpdatePayload({ ...fields, workerName: "Synthetic rename" }, hiddenPayment);
  assert.ok(unrelated);
  assert.equal(Object.hasOwn(unrelated, "payment"), false);

  const edited = {
    ...fields,
    profile: {
      ...fields.profile,
      payment: {
        ...hiddenPayment,
        account_number: { state: "provided", value: "00001234" },
      },
    },
  };
  assert.equal(buildDraftUpdatePayload(edited, hiddenPayment), null,
    "an explicit payment edit is rejected while any source field is unreadable");
});

test("explicit payment edit keeps leading zeros and explicit clearing remains intentional", () => {
  const fields = fieldsWithPayment(visiblePayment);
  const changed = {
    ...fields,
    profile: {
      ...fields.profile,
      payment: {
        ...visiblePayment,
        account_number: { state: "provided", value: "000012340056" },
      },
    },
  };
  const patch = buildDraftUpdatePayload(changed, visiblePayment);
  assert.deepEqual(patch?.payment, {
    state: "provided",
    account_number: "000012340056",
    bank_name: "Synthetic Bank",
    account_holder_name: "Synthetic Holder",
  });

  const cleared = {
    ...fields,
    profile: {
      ...fields.profile,
      payment: {
        ...visiblePayment,
        account_number: { state: "intentionally_blank" },
        bank_name: { state: "intentionally_blank" },
        account_holder_name: { state: "intentionally_blank" },
      },
    },
  };
  assert.deepEqual(buildDraftUpdatePayload(cleared, visiblePayment)?.payment, {
    state: "intentionally_blank",
    account_number: null,
    bank_name: null,
    account_holder_name: null,
  });
});

test("persisted IDs, versions and fields hydrate from server; unsaved rows use temporary identity", () => {
  const persisted = draftRowFromProjection(projection);
  assert.equal(persisted.rowId, projection.entry_id);
  assert.equal(persisted.entryVersion, 3);
  assert.equal(persisted.submissionVersion, 2);
  assert.equal(persisted.state, "clean");
  assert.equal(persisted.laborType, "PROBATION");
  assert.equal(persisted.laborTypeDisplay, "Thử việc");
  assert.deepEqual(Object.keys(editableFields(persisted)), [
    "employeeCode", "firstWorkDate", "workerName", "projectId", "recruiterId", "laborType",
    "providerType", "collaboratorId", "profile",
  ]);
  assert.deepEqual(persisted.profile, projection.profile);
  const unsaved = newDraftRow("local-temp-1", "2026-10-15");
  assert.equal(unsaved.employmentStatus, "ON");
  assert.equal(unsaved.entryId, null);
  assert.equal(unsaved.laborTypeDisplay, "");
  assert.equal(stableLiveDraftKey(unsaved), "local-temp-1");
  assert.equal(stableLiveDraftKey(persisted), projection.entry_id);
});

test("local edits become dirty, unchanged edits return clean, and saving rows reject mutation", () => {
  const row = draftRowFromProjection(projection);
  const changed = updateLiveDraftRow([row], row.rowId, { workerName: "Synthetic changed" })[0];
  assert.equal(changed.laborTypeDisplay, "Thử việc");
  assert.equal(changed.state, "dirty");
  assert.equal(fieldsDiffer(editableFields(changed), editableFields(row)), true);
  assert.deepEqual(changedDraftFields(editableFields(changed), editableFields(row)), ["Họ tên"]);
  const unchanged = updateLiveDraftRow([changed], row.rowId, { workerName: row.workerName })[0];
  assert.equal(unchanged.state, "clean");
  const saving = { ...row, state: "saving" };
  assert.equal(updateLiveDraftRow([saving], row.rowId, { workerName: "ignored" })[0].workerName, row.workerName);
});

test("date or recruiter edits remain explicit and never derive identity from labels", () => {
  const row = newDraftRow("local-temp-2", "2026-10-15");
  const edited = updateLiveDraftRow([row], row.rowId, {
    recruiterId: "93000000-0000-4000-8000-000000000001",
    firstWorkDate: "2026-10-20",
  })[0];
  assert.equal(edited.recruiterId, "93000000-0000-4000-8000-000000000001");
  assert.equal(edited.recruiterDisplayName, "");
  assert.equal(edited.providerType, null);
  assert.equal(edited.teamId, null);
  assert.equal(edited.state, "dirty");
});

test("a failed operation reuses its key only while its payload is unchanged", () => {
  const row = draftRowFromProjection(projection);
  const pending = {
    key: "same-operation-key",
    fields: editableFields(row),
    expectedVersion: row.entryVersion,
  };
  const failed = { ...row, state: "error", pendingWrite: pending };
  const retry = updateLiveDraftRow([failed], row.rowId, { workerName: row.workerName })[0];
  assert.equal(retry.pendingWrite?.key, pending.key);

  const changed = updateLiveDraftRow([failed], row.rowId, { workerName: "Different synthetic name" })[0];
  assert.equal(changed.pendingWrite, null);
  assert.equal(changed.state, "dirty");
});

test("conflict fields can be compared without changing the local draft", () => {
  const row = draftRowFromProjection(projection);
  const local = updateLiveDraftRow([row], row.rowId, { workerName: "Local synthetic edit" })[0];
  const server = { ...editableFields(row), projectId: "project_synthetic_02" };
  assert.equal(local.workerName, "Local synthetic edit");
  assert.deepEqual(changedDraftFields(editableFields(local), server), ["Họ tên", "Dự án"]);
});

test("create, update, retry failure and explicit conflict choices preserve row state", () => {
  const unsaved = newDraftRow("local-temp-3", "2026-10-15");
  const fields = {
    ...editableFields(unsaved),
    employeeCode: "hrp-2026-900002",
    workerName: "Synthetic New Worker",
    projectId: "project_synthetic_01",
    recruiterId: projection.recruiter_id,
  };
  const pending = { key: "create-key", fields, expectedVersion: null };
  const created = acceptDraftCreate({ ...unsaved, ...fields }, pending, {
    entryId: projection.entry_id,
    submissionId: projection.submission_id,
    entryVersion: 1,
    submissionVersion: 1,
  });
  assert.equal(created.rowId, projection.entry_id);
  assert.equal(created.state, "saved");
  assert.equal(stableLiveDraftKey(created), projection.entry_id);

  const pendingUpdate = {
    key: "update-key",
    fields: { ...fields, workerName: "Synthetic Update" },
    expectedVersion: 1,
  };
  const error = failDraftWrite(created, pendingUpdate, "SAVE_FAILED");
  assert.equal(error.state, "error");
  assert.equal(error.workerName, "Synthetic New Worker");
  assert.equal(error.pendingWrite?.key, "update-key");
  const updated = acceptDraftUpdate({ ...error, ...pendingUpdate.fields }, pendingUpdate, {
    entryVersion: 2,
    submissionVersion: 2,
  });
  assert.equal(updated.state, "saved");
  assert.equal(updated.entryVersion, 2);

  const conflictCopy = {
    version: 3,
    submissionVersion: 3,
    fields: { ...editableFields(updated), workerName: "Synthetic Server Worker" },
  };
  const conflict = markDraftConflict(updated, {
    ...pendingUpdate,
    expectedVersion: 2,
  }, conflictCopy);
  assert.equal(conflict.state, "conflict");
  assert.equal(conflict.workerName, "Synthetic Update");
  const server = applyServerDraft(conflict);
  assert.equal(server.workerName, "Synthetic Server Worker");
  assert.equal(server.entryVersion, 3);
  assert.equal(server.state, "clean");
  const kept = keepLocalDraft(conflict);
  assert.equal(kept.workerName, "Synthetic Update");
  assert.equal(kept.entryVersion, 3);
  assert.equal(kept.state, "dirty");
  assert.equal(kept.pendingWrite, null);
});
