import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildDraftUpdatePayload, draftRowFromProjection, editableFields } from "./live-controller.ts";
import { activeLaborTypeLabel } from "./labor-type-catalog-ui.ts";

const live = readFileSync(
  new URL("../../components/direct-entry/direct-entry-live.tsx", import.meta.url), "utf8");
const grid = readFileSync(
  new URL("../../components/direct-entry/direct-entry-spreadsheet-grid.tsx", import.meta.url), "utf8");
const controller = readFileSync(new URL("./live-controller.ts", import.meta.url), "utf8");

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

test("inactive persisted Own Draft keeps canonical key and separate server label", () => {
  const row = draftRowFromProjection(projection);
  assert.equal(row.laborType, "PROBATION");
  assert.equal(row.laborTypeDisplay, "Thử việc");
  assert.deepEqual(editableFields(row), {
    employeeCode: "hrp-2026-900001",
    firstWorkDate: "2026-10-15",
    workerName: "Synthetic Worker",
    projectId: "project_synthetic_01",
    recruiterId: "93000000-0000-4000-8000-000000000001",
    laborType: "PROBATION",
    providerType: "hrp",
    collaboratorId: null,
    profile: projection.profile,
  });
  assert.match(controller, /laborTypeDisplay: draft\.labor_type_display/);
  assert.doesNotMatch(controller, /laborTypeDisplay:\s*[^,\n]*(?:EditableDraftFields|fields)/);
});

test("persisted grid stores key but shows active catalog label or authoritative Own Draft label", () => {
  assert.equal(activeLaborTypeLabel([{
    labor_type_key: "PROBATION",
    display_name: "Tên catalog hiện tại",
    sort_order: 1,
  }], projection.labor_type), "Tên catalog hiện tại");
  assert.match(live, /labor_type:\s*activeLaborTypeLabel\(fallbackCatalog\?\.labor_types, row\.laborType\)\s*\?\?\s*row\.laborTypeDisplay/);
  assert.match(live, /labor_type:\s*row\.laborType,/);
  assert.doesNotMatch(live, /`\$\{row\.laborType\}\s*·\s*không còn hoạt động`/);
  assert.doesNotMatch(grid, /`\$\{key\}\s*·\s*không còn hoạt động`/);
  assert.match(grid, /activeLaborTypeLabel\(row\.catalogOptions\?\.laborTypes \?\? catalogOptions\?\.laborTypes, key\)\s*\?\?\s*"Loại hình không còn hoạt động"/);
  assert.match(grid, /row\.displayValues\[column\.key\]/);
  const createStart = live.indexOf("function createPayload(");
  const createEnd = live.indexOf("\nfunction ", createStart + 1);
  const createPayload = live.slice(createStart, createEnd);
  assert.match(createPayload, /labor_type:\s*row\.laborType/);
  assert.doesNotMatch(createPayload, /laborTypeDisplay|labor_type_display/);
  const updateStart = controller.indexOf("export function buildDraftUpdatePayload(");
  const updateEnd = controller.indexOf("\nexport function ", updateStart + 1);
  const updatePayloadSource = controller.slice(updateStart, updateEnd);
  assert.match(updatePayloadSource, /labor_type:\s*fields\.laborType/);
  assert.doesNotMatch(updatePayloadSource, /laborTypeDisplay|labor_type_display/);
  assert.match(live, /buildDraftUpdatePayload\(/);
  const updatePayload = buildDraftUpdatePayload(editableFields(draftRowFromProjection(projection)), null);
  assert.equal(updatePayload?.labor_type, "PROBATION");
  assert.equal(Object.hasOwn(updatePayload ?? {}, "labor_type_display"), false);
});

test("desktop inactive option and mobile editor use projection label without making it writable", () => {
  assert.equal(draftRowFromProjection({
    ...projection,
    labor_type_display: "Nhãn mới sau khi tải lại",
  }).laborTypeDisplay, "Nhãn mới sau khi tải lại");
  assert.match(grid, /selectedIsInactive && <option value=\{value\} disabled>[\s\S]*props\.row\.displayValues\?\.labor_type/);
  assert.match(live, /<small>\{selectedRow\.laborTypeDisplay\} · không còn hoạt động<\/small>/);
  assert.match(live, /laborType:\s*event\.currentTarget\.value/);
  assert.doesNotMatch(live, /\/api\/admin\/catalog\/labor-types/);
  assert.doesNotMatch(grid, /\/api\/admin\/catalog\/labor-types/);
  assert.doesNotMatch(live + grid, /LABOR_TYPE_LABELS|TEMPORARY\s*:\s*|PERMANENT\s*:/);
});
