import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssignRequest,
  buildCreateRequest,
  buildRenameRequest,
  buildSetActiveRequest,
  buildUnassignRequest,
  buildUpdateProjectLocationRequest,
  candidateLabel,
  classifyResponse,
  executeProjectRequest,
  filterProjects,
  mutationProjectVersion,
  parseCandidatesResponse,
  parseDetailResponse,
  parseListResponse,
  parseProjectLocation,
  paginateProjects,
  projectStatusLabel,
  splitAssignments,
  validatePendingAssignments,
  validateProjectId,
  validateReason,
} from "./project-operations-model.ts";

const KEY = "55555555-5555-4555-8555-555555555555";
const RECRUITER = "66666666-6666-4666-8666-666666666666";
const RECRUITER_2 = "88888888-8888-4888-8888-888888888888";
const ASSIGNMENT = "77777777-7777-4777-8777-777777777777";
const TODAY_VN = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Ho_Chi_Minh",
}).format(new Date());

const FORBIDDEN = ["actor", "auth_subject", "app_user_id", "capability",
  "capabilities", "scope", "scopes", "role", "roles", "created_by"];

function assertNoAuthorityFields(body) {
  for (const key of FORBIDDEN) {
    assert.equal(key in body, false, "client khong duoc gui " + key);
  }
}

test("tao du an: body dung key va khong gui truong quyen", () => {
  const result = buildCreateRequest({ projectId: "du-an-01", displayName: " Dự án 01 ",
    reason: "khoi tao", idempotencyKey: KEY });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.body).sort(), ["display_name", "idempotency_key",
    "project_id", "reason"]);
  assert.equal(result.body.display_name, "Dự án 01");
  assertNoAuthorityFields(result.body);
});

test("doi ten du an: bat buoc expected_version (OCC) va reason", () => {
  const missingVersion = buildRenameRequest({ displayName: "X", reason: "r",
    expectedVersion: undefined, idempotencyKey: KEY });
  assert.equal(missingVersion.ok, false, "thieu expected_version phai bi chan");

  const ok = buildRenameRequest({ displayName: "Tên mới", reason: "doi ten",
    expectedVersion: 3, idempotencyKey: KEY });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.expected_version, 3);
  assert.equal(ok.body.reason, "doi ten");
  assertNoAuthorityFields(ok.body);
});

test("ngung/kich hoat: CHI doi co active, khong co RPC rieng", () => {
  const off = buildSetActiveRequest({ active: false, reason: "ngung su dung",
    expectedVersion: 4, idempotencyKey: KEY });
  assert.equal(off.ok, true);
  assert.equal(off.body.active, false);
  assert.equal("action" in off.body, false);
  assert.equal("rpc" in off.body, false);

  const on = buildSetActiveRequest({ active: true, reason: "khoi phuc",
    expectedVersion: 5, idempotencyKey: KEY });
  assert.equal(on.body.active, true);
  assert.equal(projectStatusLabel(true), "Đang hoạt động");
  assert.equal(projectStatusLabel(false), "Đã ngừng");
});

test("danh sach: tim theo ma/ten va loc trang thai ma khong doi authority", () => {
  const projects = [
    { project_id: "jahwa", display_name: "Công ty Jahwa Vina", active: true, version: 1 },
    { project_id: "compal", display_name: "Compal Việt Nam", active: false, version: 2 },
  ];
  assert.deepEqual(filterProjects(projects, "JAH", "all"), [projects[0]]);
  assert.deepEqual(filterProjects(projects, "việt nam", "all"), [projects[1]]);
  assert.deepEqual(filterProjects(projects, "", "active"), [projects[0]]);
  assert.deepEqual(filterProjects(projects, "", "inactive"), [projects[1]]);
  assert.deepEqual(filterProjects(projects, "không có", "all"), []);
});

test("phan trang client giu du ket qua sau khi loc va kep trang hop le", () => {
  const projects = Array.from({ length: 25 }, (_, index) => ({ project_id: "p" + index }));
  const page = paginateProjects(projects, 2, 10);
  assert.deepEqual(page.items, projects.slice(10, 20));
  assert.equal(page.page, 2);
  assert.equal(page.pageCount, 3);
  assert.equal(page.from, 11);
  assert.equal(page.to, 20);
  assert.equal(page.total, 25);
  assert.equal(paginateProjects(projects, 9, 10).page, 3);
  assert.deepEqual(paginateProjects([], 2, 10), {
    items: [], page: 1, pageCount: 1, from: 0, to: 0, total: 0,
  });
});

test("cac hanh dong UI tao dung request va xu ly success/conflict qua executor", async () => {
  async function send(url, method, request, status = 200, payload = { ok: true }) {
    const calls = [];
    const result = await executeProjectRequest(url, method, request, KEY,
      async (requestUrl, init) => {
        calls.push({ url: requestUrl, ...init });
        return { status, json: async () => payload };
      });
    return { calls, result };
  }

  const create = await send("/api/direct-entry/projects", "POST", buildCreateRequest({
    projectId: "p-new", displayName: "Tên mới", reason: "khởi tạo", idempotencyKey: KEY,
  }));
  assert.deepEqual(JSON.parse(create.calls[0].body), {
    project_id: "p-new", display_name: "Tên mới", reason: "khởi tạo", idempotency_key: KEY,
  });
  assert.equal(create.calls[0].method, "POST");
  assert.equal(create.calls[0].headers["idempotency-key"], KEY);
  assert.equal(create.result.outcome.kind, "applied");

  const rename = await send("/api/direct-entry/projects/p1", "PATCH", buildRenameRequest({
    displayName: "Tên sau", reason: "đổi tên", expectedVersion: 7, idempotencyKey: KEY,
  }));
  assert.deepEqual(JSON.parse(rename.calls[0].body), {
    display_name: "Tên sau", reason: "đổi tên", expected_version: 7, idempotency_key: KEY,
  });
  assert.equal(rename.result.outcome.kind, "applied");

  for (const active of [true, false]) {
    const result = await send("/api/direct-entry/projects/p1/active", "POST",
      buildSetActiveRequest({ active, reason: "cập nhật trạng thái", expectedVersion: 8,
        idempotencyKey: KEY }));
    assert.deepEqual(JSON.parse(result.calls[0].body), {
      active, reason: "cập nhật trạng thái", expected_version: 8, idempotency_key: KEY,
    });
    assert.equal(result.result.outcome.kind, "applied");
  }

  const assign = await send("/api/direct-entry/projects/p1/managers", "POST", buildAssignRequest({
    managerRecruiterId: RECRUITER, validFrom: TODAY_VN, reason: "phân công",
    expectedProjectVersion: 9, idempotencyKey: KEY,
  }));
  assert.deepEqual(JSON.parse(assign.calls[0].body), {
    manager_recruiter_id: RECRUITER, valid_from: TODAY_VN, reason: "phân công",
    expected_project_version: 9, idempotency_key: KEY,
  });
  assert.equal(assign.result.outcome.kind, "applied");

  const unassign = await send("/api/direct-entry/projects/p1/managers/" + ASSIGNMENT, "POST",
    buildUnassignRequest({ reason: "thu hồi", expectedVersion: 4,
      expectedProjectVersion: 10, idempotencyKey: KEY }));
  assert.deepEqual(JSON.parse(unassign.calls[0].body), {
    reason: "thu hồi", expected_version: 4, expected_project_version: 10,
    idempotency_key: KEY,
  });
  assert.equal(unassign.result.outcome.kind, "applied");

  const conflict = await send("/api/direct-entry/projects/p1", "PATCH", buildRenameRequest({
    displayName: "Tên khác", reason: "đổi tên", expectedVersion: 7, idempotencyKey: KEY,
  }), 409, { ok: false, code: "PROJECT_CONFLICT", message: "raw database error" });
  assert.equal(conflict.result.outcome.kind, "reload-required");
  assert.match(conflict.result.outcome.message, /tải lại/i);
  assert.equal(conflict.result.outcome.message.includes("raw database error"), false);

  const staleAssignment = await send("/api/direct-entry/projects/p1/managers/" + ASSIGNMENT,
    "POST", buildUnassignRequest({ reason: "thu hồi", expectedVersion: 3,
      expectedProjectVersion: 10, idempotencyKey: KEY }), 409,
    { ok: false, code: "PROJECT_CONFLICT" });
  assert.equal(staleAssignment.result.outcome.kind, "reload-required");

  let invalidFetchCount = 0;
  const invalid = await executeProjectRequest("/api/direct-entry/projects/p1", "PATCH",
    buildRenameRequest({ displayName: "  ", reason: "đổi tên", expectedVersion: 7,
      idempotencyKey: KEY }), KEY, async () => {
      invalidFetchCount += 1;
      return { status: 200, json: async () => ({ ok: true }) };
    });
  assert.equal(invalid.outcome.kind, "invalid");
  assert.equal(invalidFetchCount, 0, "validation fails before sending an API request");
});

test("gan nhieu quan ly: chan trung lap va du lieu sai", () => {
  assert.equal(validatePendingAssignments([]), "Cần ít nhất một quản lý dự án.");
  assert.notEqual(validatePendingAssignments([
    { managerRecruiterId: RECRUITER, validFrom: "2026-10-01" },
    { managerRecruiterId: RECRUITER, validFrom: "2026-10-02" },
  ]), null, "khong duoc gan trung mot quan ly");
  assert.equal(validatePendingAssignments([
    { managerRecruiterId: RECRUITER, validFrom: TODAY_VN },
    { managerRecruiterId: RECRUITER_2, validFrom: TODAY_VN },
  ]), null);

  const bad = buildAssignRequest({ managerRecruiterId: "khong-phai-uuid",
    validFrom: TODAY_VN, reason: "r", expectedProjectVersion: 1, idempotencyKey: KEY });
  assert.equal(bad.ok, false);

  const badDate = buildAssignRequest({ managerRecruiterId: RECRUITER,
    validFrom: "01/10/2026", reason: "r", expectedProjectVersion: 1, idempotencyKey: KEY });
  assert.equal(badDate.ok, false, "ngay phai ISO YYYY-MM-DD");
});

test("thu hoi: gui CA hai version (assignment + project) va reason nullable", () => {
  const noReason = buildUnassignRequest({ reason: "  ", expectedVersion: 1,
    expectedProjectVersion: 2, idempotencyKey: KEY });
  assert.equal(noReason.ok, true, "reason rong duoc canonicalize thanh null");
  if (noReason.ok) assert.equal(noReason.body.reason, null);

  const ok = buildUnassignRequest({ reason: "thu hoi", expectedVersion: 1,
    expectedProjectVersion: 2, idempotencyKey: KEY });
  assert.equal(ok.ok, true);
  assert.equal(ok.body.expected_version, 1);
  assert.equal(ok.body.expected_project_version, 2);
  assertNoAuthorityFields(ok.body);
});

test("ly do thao tac tuy chon cho moi thao tac thay doi", () => {
  assert.equal(validateReason(""), null);
  assert.equal(validateReason("   "), null);
  assert.notEqual(validateReason("x".repeat(4001)), null);
  assert.equal(validateReason("hop le"), null);

  const builders = [
    () => buildCreateRequest({ projectId: "p1", displayName: "X", reason: "",
      idempotencyKey: KEY }),
    () => buildRenameRequest({ displayName: "X", reason: " ",
      expectedVersion: 1, idempotencyKey: KEY }),
    () => buildSetActiveRequest({ active: false, reason: "",
      expectedVersion: 1, idempotencyKey: KEY }),
    () => buildAssignRequest({ managerRecruiterId: RECRUITER, validFrom: TODAY_VN,
      reason: "", expectedProjectVersion: 1, idempotencyKey: KEY }),
    () => buildUnassignRequest({ reason: "", expectedVersion: 1,
      expectedProjectVersion: 1, idempotencyKey: KEY }),
  ];
  for (const build of builders) {
    const result = build();
    assert.equal(result.ok, true, "reason trong duoc chap nhan");
    if (result.ok) assert.equal(result.body.reason, null);
  }
  assert.equal(buildCreateRequest({ projectId: "p1", displayName: "X", reason: "x".repeat(4001),
    idempotencyKey: KEY }).ok, false);
});

test("ma du an: chi chap nhan shape DB cho phep", () => {
  assert.equal(validateProjectId("du-an.01:A"), null);
  assert.notEqual(validateProjectId("   "), null);
  assert.notEqual(validateProjectId("-bat-dau-sai"), null);
  assert.notEqual(validateProjectId("x".repeat(129)), null);
});

test("xung dot OCC: version du an CU => bat buoc tai lai, khong ghi de", () => {
  const staleProject = classifyResponse(409, { ok: false, code: "PROJECT_CONFLICT" });
  assert.equal(staleProject.kind, "reload-required");
  assert.match(staleProject.message, /tải lại/i);

  // Cung ket qua khi server tra 409 khong kem code (van phai tai lai).
  assert.equal(classifyResponse(409, null).kind, "reload-required");
});

test("xung dot OCC: version phan cong CU cung bat buoc tai lai", () => {
  const staleAssignment = classifyResponse(409, { ok: false, code: "PROJECT_CONFLICT" });
  assert.equal(staleAssignment.kind, "reload-required");
});

test("loi duoc sanitized: khong lo ma DB/raw message", () => {
  const cases = [
    [403, { ok: false, code: "PROJECT_DENIED" }, "denied"],
    [404, { ok: false, code: "PROJECT_NOT_FOUND" }, "not-found"],
    [400, { ok: false, code: "PROJECT_INVALID" }, "invalid"],
    [401, { ok: false, code: "UNAUTHENTICATED" }, "unauthenticated"],
    [500, { ok: false, code: "PROJECT_UNAVAILABLE" }, "unavailable"],
  ];
  for (const [status, payload, kind] of cases) {
    const outcome = classifyResponse(status, payload);
    assert.equal(outcome.kind, kind);
    for (const leak of ["P0002", "42501", "23505", "40001", "SQLSTATE", "postgres",
      "duplicate key", "relation "]) {
      assert.equal(outcome.message.includes(leak), false, "ro ri " + leak);
    }
  }
});

test("parse response: fail-closed khi shape sai", () => {
  assert.equal(parseListResponse(null), null);
  assert.equal(parseListResponse({ ok: false }), null);
  assert.equal(parseListResponse({ ok: true, list: { projects: [{}] } }), null);
  assert.equal(parseListResponse({ ok: true, list: { projects: [
    { project_id: "p1", display_name: "A", active: true, version: 2 },
  ] } }), null, "server flags are required, never inferred client-side");
  assert.deepEqual(parseListResponse({ ok: true, list: { projects: [
    { project_id: "p1", display_name: "A", active: true, version: 2,
      can_manage_project_master: false, can_assign_managers: true },
  ] } }), [{ project_id: "p1", display_name: "A", active: true, version: 2,
    can_manage_project_master: false, can_assign_managers: true }]);

  // F4: detail co shape moi { master, assignments } (get + list assignments).
  assert.equal(parseDetailResponse({ ok: true, detail: { master: {} } }), null);
  const detail = parseDetailResponse({ ok: true, detail: {
    master: { project_id: "p1", display_name: "Dự án 01", active: true, version: 2,
      can_manage_project_master: false, can_assign_managers: true },
    assignments: { authorization_date: "2026-10-07", project_id: "p1", project_version: 2,
      project_active: true, include_history: true, active_assignment_count: 1,
      assignments: [{ assignment_id: ASSIGNMENT, project_id: "p1", project_version: 2,
        manager_recruiter_id: RECRUITER, valid_from: "2026-10-01", valid_to: null,
        effective: true, version: 1, revoked_at: null,
        created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z" }] } } });
  assert.equal(detail.assignments.length, 1);
  assert.equal(detail.display_name, "Dự án 01");
  assert.equal(detail.project_version, 2);
  assert.equal(detail.can_manage_project_master, false);
  assert.equal(detail.can_assign_managers, true);
});

test("F3: mutationProjectVersion doc project_version, KHONG dung assignment version", () => {
  // Project version ban dau KHAC assignment version; phai lay project_version.
  const payload = { ok: true, project: { assignment_id: ASSIGNMENT, project_id: "p1",
    version: 1, project_version: 7, valid_to: null, already_assigned: false } };
  assert.equal(mutationProjectVersion(payload), 7);
  assert.notEqual(mutationProjectVersion(payload), 1, "khong duoc dung version (assignment)");
  assert.equal(mutationProjectVersion({ ok: true, project: { version: 1 } }), null);
  assert.equal(mutationProjectVersion(null), null);
});

test("W06A-R2: 3-way split current / future / history", () => {
  const make = (id, effective, validTo, from) => ({ assignment_id: id, project_id: "p1",
    project_version: 1, manager_recruiter_id: RECRUITER, valid_from: from, valid_to: validTo,
    effective, version: 1, revoked_at: validTo, created_at: from });
  const split = splitAssignments([
    make("cur", true, null, "2026-10-01"),        // effective now
    make("fut", false, null, "2026-11-01"),       // open, future valid_from
    make("his", false, "2026-09-30", "2026-09-01"), // closed/revoked
  ]);
  assert.equal(split.current.length, 1);
  assert.equal(split.current[0].assignment_id, "cur");
  assert.equal(split.future.length, 1);
  assert.equal(split.future[0].assignment_id, "fut", "future must NOT be history");
  assert.equal(split.history.length, 1);
  assert.equal(split.history[0].assignment_id, "his");
});

test("W06A-R2: parse candidates + label (name/code, never auth/user)", () => {
  const payload = { ok: true, candidates: [
    { recruiter_id: RECRUITER, display_name: "Nguyễn Văn A", personnel_code: "vinht.td", personnel_position: "STAFF" },
    { recruiter_id: RECRUITER_2, display_name: "Trần Thị B", personnel_code: null, personnel_position: null },
  ] };
  const candidates = parseCandidatesResponse(payload);
  assert.equal(candidates.length, 2);
  assert.equal(candidateLabel(candidates[0]), "Nguyễn Văn A · vinht.td");
  assert.equal(candidateLabel(candidates[1]), "Trần Thị B");
  assert.equal(parseCandidatesResponse({ ok: true, candidates: [{ recruiter_id: "x" }] }), null);
  assert.equal(parseCandidatesResponse({ ok: false }), null);
  for (const key of ["auth_subject", "app_user_id"]) {
    assert.equal(key in payload.candidates[0], false, "candidate projection khong tra " + key);
  }
});

test("project location: parse location + buildUpdateProjectLocationRequest (all-or-nothing lat/lon, radius 50-2000, clear)", () => {
  const validLoc = parseProjectLocation({
    address: "123 Nguyễn Huệ, Q.1, TP.HCM",
    latitude: 10.776889,
    longitude: 106.700806,
    radius_meters: 250,
    confirmed_at: "2026-10-20T08:30:00Z",
  });
  assert.deepEqual(validLoc, {
    address: "123 Nguyễn Huệ, Q.1, TP.HCM",
    latitude: 10.776889,
    longitude: 106.700806,
    radius_meters: 250,
    confirmed_at: "2026-10-20T08:30:00Z",
  });
  assert.equal(parseProjectLocation({ address: null, latitude: 10, longitude: 106, radius_meters: 49, confirmed_at: null }), null);
  assert.equal(parseProjectLocation({ address: null, latitude: 95, longitude: 106, radius_meters: 200, confirmed_at: null }), null);

  const listWithLocation = parseListResponse({
    ok: true,
    list: {
      projects: [
        {
          project_id: "p1",
          display_name: "Dự án A",
          active: true,
          version: 3,
          can_manage_project_master: true,
          can_assign_managers: true,
          location: {
            address: "KCN Bắc Thăng Long",
            latitude: 21.123456,
            longitude: 105.765432,
            radius_meters: 200,
            confirmed_at: "2026-10-21T01:00:00Z",
          },
        },
      ],
    },
  });
  assert.equal(listWithLocation?.[0]?.location?.radius_meters, 200);
  assert.equal(listWithLocation?.[0]?.location?.confirmed_at, "2026-10-21T01:00:00Z");

  // Fail when only latitude or only longitude is provided
  const missingLon = buildUpdateProjectLocationRequest({
    address: "Test",
    latitudeInput: "10.77",
    longitudeInput: "",
    radiusInput: "200",
    expectedVersion: 3,
    idempotencyKey: KEY,
  });
  assert.equal(missingLon.ok, false);

  const missingLat = buildUpdateProjectLocationRequest({
    address: "Test",
    latitudeInput: "",
    longitudeInput: "106.70",
    radiusInput: "200",
    expectedVersion: 3,
    idempotencyKey: KEY,
  });
  assert.equal(missingLat.ok, false);

  // Radius out of range (50..2000)
  assert.equal(
    buildUpdateProjectLocationRequest({
      latitudeInput: "10.77",
      longitudeInput: "106.70",
      radiusInput: "40",
      expectedVersion: 3,
      idempotencyKey: KEY,
    }).ok,
    false,
  );
  assert.equal(
    buildUpdateProjectLocationRequest({
      latitudeInput: "10.77",
      longitudeInput: "106.70",
      radiusInput: "2500",
      expectedVersion: 3,
      idempotencyKey: KEY,
    }).ok,
    false,
  );

  // Valid update with default radius 200 when blank
  const updated = buildUpdateProjectLocationRequest({
    address: "  Số 1 Lê Duẩn  ",
    latitudeInput: "10.776889",
    longitudeInput: "106.700806",
    radiusInput: "",
    reason: "Cập nhật vị trí dự án",
    expectedVersion: 3,
    idempotencyKey: KEY,
  });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.body, {
    expected_version: 3,
    address: "Số 1 Lê Duẩn",
    latitude: 10.776889,
    longitude: 106.700806,
    radius_meters: 200,
    clear: false,
    reason: "Cập nhật vị trí dự án",
    idempotency_key: KEY,
  });

  // Clear location (explicit clear: true or both coordinates blank)
  const cleared = buildUpdateProjectLocationRequest({
    clear: true,
    reason: "Xóa tọa độ cũ",
    expectedVersion: 4,
    idempotencyKey: KEY,
  });
  assert.equal(cleared.ok, true);
  assert.deepEqual(cleared.body, {
    expected_version: 4,
    address: null,
    latitude: null,
    longitude: null,
    radius_meters: 200,
    clear: true,
    reason: "Xóa tọa độ cũ",
    idempotency_key: KEY,
  });
});
