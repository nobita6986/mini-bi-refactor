import assert from "node:assert/strict";
import test from "node:test";

import {
  MAPPING_SEARCH_MAX_LENGTH,
  buildGrantRequest,
  buildMappingListQuery,
  buildRevokeRequest,
  classifyGrantResponse,
  classifyRevokeResponse,
  filterActiveProjects,
  paginateProjects,
  toggleProjectSelection,
} from "./project-team-scope-ui-model.ts";

const TEAM = "66666666-6666-4666-8666-666666666666";
const MAPPING = "77777777-7777-4777-8777-777777777777";
const KEY = "55555555-5555-4555-8555-555555555555";
const IDS = ["project-1", "project-2"];
const TODAY_VN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

test("mapping query is bounded and sends only the trimmed fuzzy search", () => {
  assert.equal(buildMappingListQuery({ search: "x", includeHistory: false, page: 0 }), null);
  assert.equal(buildMappingListQuery({ search: "x", includeHistory: false, page: 1001 }), null);
  assert.deepEqual([...buildMappingListQuery({ search: "  Compal  ", includeHistory: true, page: 2 }).entries()], [
    ["page", "2"], ["page_size", "25"], ["search", "Compal"], ["include_history", "true"],
  ]);
  // A blank/whitespace-only box is "no filter", never a stray search parameter.
  assert.deepEqual([...buildMappingListQuery({ search: "   ", includeHistory: false, page: 1 }).entries()], [
    ["page", "1"], ["page_size", "25"],
  ]);
  // Oversized input is capped so the API boundary never rejects a resent value.
  assert.equal(
    buildMappingListQuery({ search: "x".repeat(300), includeHistory: false, page: 1 }).get("search").length,
    MAPPING_SEARCH_MAX_LENGTH,
  );
});

test("project selection survives filtering and paging and is limited to one hundred unique projects", () => {
  const projects = Array.from({ length: 31 }, (_, index) => ({
    project_id: `project-${index + 1}`,
    display_name: index === 1 ? "Archived Project" : `Project ${index + 1}`,
    active: index !== 1,
  }));
  const matching = filterActiveProjects(projects, "project 3");
  assert.deepEqual(matching.map(({ project_id }) => project_id), ["project-3", "project-30", "project-31"]);
  assert.deepEqual(filterActiveProjects(projects, "archived"), []);
  assert.equal(paginateProjects(projects, 2).length, 6);

  const firstPageSelection = toggleProjectSelection([], "project-1", true);
  const afterChangingFilterAndPage = toggleProjectSelection(firstPageSelection, "project-27", true);
  assert.deepEqual(afterChangingFilterAndPage, ["project-1", "project-27"]);
  assert.deepEqual(toggleProjectSelection(afterChangingFilterAndPage, "project-1", false), ["project-27"]);
  assert.equal(toggleProjectSelection(Array.from({ length: 100 }, (_, i) => `p-${i}`), "another", true).length, 100);
});

test("batch grant body has only the exact versionless contract keys and enforces 1-100 unique IDs", () => {
  const request = buildGrantRequest({
    projectIds: IDS,
    teamId: TEAM,
    reason: "reviewed",
    idempotencyKey: KEY,
  });
  assert.deepEqual(request, {
    ok: true,
    body: { team_id: TEAM, project_ids: IDS, reason: "reviewed", idempotency_key: KEY },
  });
  assert.deepEqual(Object.keys(request.body).sort(), ["idempotency_key", "project_ids", "reason", "team_id"]);
  const optional = buildGrantRequest({ projectIds: IDS, teamId: TEAM, idempotencyKey: KEY });
  assert.deepEqual(optional, { ok: true, body: {
    team_id: TEAM, project_ids: IDS, reason: null, idempotency_key: KEY,
  } });
  assert.equal(buildGrantRequest({ projectIds: [], teamId: TEAM, reason: "r", idempotencyKey: KEY }).ok, false);
  assert.equal(buildGrantRequest({ projectIds: Array.from({ length: 101 }, (_, i) => `p-${i}`), teamId: TEAM, reason: "r", idempotencyKey: KEY }).ok, false);
  assert.equal(buildGrantRequest({ projectIds: ["same", "same"], teamId: TEAM, reason: "r", idempotencyKey: KEY }).ok, false);
});

test("revoke body is versionless and exactly matches the current contract", () => {
  const request = buildRevokeRequest({
    mappingId: MAPPING,
    effectiveTo: "",
    reason: "same-day",
    idempotencyKey: KEY,
  });
  assert.deepEqual(request, {
    ok: true,
    body: { mapping_id: MAPPING, effective_to: null, reason: "same-day", idempotency_key: KEY },
  });
  assert.deepEqual(Object.keys(request.body).sort(), ["effective_to", "idempotency_key", "mapping_id", "reason"]);
  const optional = buildRevokeRequest({ mappingId: MAPPING, effectiveTo: TODAY_VN, idempotencyKey: KEY });
  assert.deepEqual(optional, { ok: true, body: {
    mapping_id: MAPPING, effective_to: TODAY_VN, reason: null, idempotency_key: KEY,
  } });
});

test("batch outcome strictly distinguishes created and already-effective projects", () => {
  const labels = new Map([["project-1", "Project One"], ["project-2", "Project Two"]]);
  const outcome = classifyGrantResponse(200, {
    ok: true,
    batch: {
      team_id: TEAM,
      effective_from: "2026-10-15",
      created: [{
        mapping_id: MAPPING,
        project_id: "project-1",
        team_id: TEAM,
        valid_from: "2026-10-15",
        valid_to: null,
        version: 1,
        created: true,
      }],
      skipped: [{
        project_id: "project-2",
        status: "ALREADY_EFFECTIVE",
        mapping_id: "88888888-8888-4888-8888-888888888888",
        version: 1,
      }],
    },
  }, TEAM, IDS, labels);
  assert.deepEqual(outcome, {
    kind: "applied",
    message: "Đã tạo 1 mapping: Project One. Đã bỏ qua 1 dự án đã có mapping hiệu lực: Project Two. Hiệu lực từ 2026-10-15.",
  });
  assert.equal(classifyGrantResponse(200, { ok: true }, TEAM, IDS, labels).kind, "unavailable");
  assert.equal(classifyGrantResponse(200, {
    ok: true,
    batch: { team_id: TEAM, effective_from: "2026-10-15", created: [], skipped: [] },
  }, TEAM, IDS, labels).kind, "unavailable");
});

test("mutation errors remain sanitized and revoke success requires the exact authoritative projection", () => {
  assert.equal(classifyGrantResponse(401, null, TEAM, IDS, new Map()).kind, "denied");
  assert.equal(classifyGrantResponse(403, null, TEAM, IDS, new Map()).kind, "denied");
  assert.equal(classifyGrantResponse(409, null, TEAM, IDS, new Map()).kind, "conflict");
  assert.equal(classifyGrantResponse(422, null, TEAM, IDS, new Map()).kind, "invalid");
  assert.equal(classifyGrantResponse(503, null, TEAM, IDS, new Map()).kind, "unavailable");
  assert.deepEqual(classifyRevokeResponse(200, {
    ok: true,
    scope: {
      mapping_id: MAPPING,
      project_id: "project-1",
      team_id: TEAM,
      valid_to: "2026-10-15",
      version: 2,
      revoked: true,
    },
  }, MAPPING), {
    kind: "applied",
    message: "Đã thu hồi mapping. Danh sách đang được cập nhật.",
  });
  assert.equal(classifyRevokeResponse(200, { ok: true }, MAPPING).kind, "unavailable");
});
