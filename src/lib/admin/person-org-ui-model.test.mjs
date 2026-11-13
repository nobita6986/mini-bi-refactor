import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAssignPersonDepartmentRequest,
  buildCreatePersonRequest,
  buildEndPersonDepartmentRequest,
  buildPersonListQuery,
  buildTransferPersonDepartmentRequest,
  buildUpdatePersonRequest,
  classifyPersonOrgMutationResponse,
  classifyPersonOrgReadError,
  DEFAULT_ORG_PAGE_SIZE,
  projectPersonDetailEnvelope,
  projectPersonListEnvelope,
} from "./person-org-ui-model.ts";

const UUID_PERSON = "11111111-1111-4111-8111-111111111111";
const UUID_DEPT_A = "22222222-2222-4222-8222-222222222222";
const UUID_DEPT_B = "33333333-3333-4333-8333-333333333333";
const UUID_ACCOUNT = "44444444-4444-4444-8444-444444444444";
const UUID_RECRUITER = "55555555-5555-4555-8555-555555555555";
const UUID_MEMBERSHIP = "66666666-6666-4666-8666-666666666666";
const UUID_LINK = "77777777-7777-4777-8777-777777777777";
const UUID_HEAD = "88888888-8888-4888-8888-888888888888";
const UUID_IDEM = "99999999-9999-4999-8999-999999999999";

function makePersonDetail(overrides = {}) {
  return {
    person_id: UUID_PERSON,
    employee_code: "HRP-NS-001",
    full_name: "Nguyễn Văn A",
    status: "ACTIVE",
    joined_on: "2026-10-01",
    recruiter_id: null,
    version: 2,
    active_account_link: null,
    active_department: null,
    department_history: [],
    head_assignments: [],
    ...overrides,
  };
}

function makePersonSummary(overrides = {}) {
  return {
    person_id: UUID_PERSON,
    employee_code: "HRP-NS-001",
    full_name: "Nguyễn Văn A",
    status: "ACTIVE",
    joined_on: "2026-10-01",
    recruiter_id: null,
    version: 2,
    active_account_link: null,
    active_department: null,
    ...overrides,
  };
}

test("buildPersonListQuery chuẩn hóa query và tuyệt đối không gửi sentinel department_id=unassigned", () => {
  const baseQuery = buildPersonListQuery({
    search: "  An Nguyễn  ",
    status: "active",
    departmentId: null,
    linkState: "all",
    page: 1,
  });
  assert.ok(baseQuery);
  assert.equal(baseQuery.get("search"), "An Nguyễn");
  assert.equal(baseQuery.get("status"), "active");
  assert.equal(baseQuery.get("link_state"), "all");
  assert.equal(baseQuery.get("page"), "1");
  assert.equal(baseQuery.get("page_size"), String(DEFAULT_ORG_PAGE_SIZE));
  assert.equal(baseQuery.has("department_id"), false);

  const allDeptQuery = buildPersonListQuery({
    search: "",
    status: "inactive",
    departmentId: "all",
    linkState: "unlinked",
    page: 2,
  });
  assert.ok(allDeptQuery);
  assert.equal(allDeptQuery.has("department_id"), false);
  assert.equal(allDeptQuery.has("search"), false);

  const uuidDeptQuery = buildPersonListQuery({
    search: "",
    status: "all",
    departmentId: UUID_DEPT_A.toUpperCase(),
    linkState: "linked",
    page: 1,
  });
  assert.ok(uuidDeptQuery);
  assert.equal(uuidDeptQuery.get("department_id"), UUID_DEPT_A);

  assert.equal(
    buildPersonListQuery({
      search: "",
      status: "all",
      departmentId: "unassigned",
      linkState: "all",
      page: 1,
    }),
    null,
  );
  assert.equal(
    buildPersonListQuery({
      search: "abc\u0007",
      status: "all",
      departmentId: null,
      linkState: "all",
      page: 1,
    }),
    null,
  );
});

test("buildCreatePersonRequest & buildUpdatePersonRequest nhập tay mã NS, chặn mã NLĐ dự án và không chứa trường đặt lịch", () => {
  const created = buildCreatePersonRequest({
    employeeCode: " NS-2026-01 ",
    fullName: " Trần Thị B ",
    joinedOn: "2026-11-01",
    initialDepartmentRef: UUID_DEPT_A,
    accountRef: UUID_ACCOUNT,
    expectedAccountVersion: 3,
    recruiterId: UUID_RECRUITER,
    reason: "Tạo hồ sơ nhân sự nội bộ mới",
    idempotencyKey: UUID_IDEM,
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.body.employee_code, "NS-2026-01");
  assert.equal(created.body.full_name, "Trần Thị B");
  assert.equal(created.body.joined_on, "2026-11-01");
  assert.equal(created.body.initial_department_ref, UUID_DEPT_A);
  assert.equal(created.body.account_ref, UUID_ACCOUNT);
  assert.equal(created.body.expected_account_version, 3);
  assert.equal(created.body.recruiter_id, UUID_RECRUITER);
  assert.equal(created.body.idempotency_key, UUID_IDEM);
  for (const forbidden of [
    "valid_from",
    "valid_to",
    "effective_from",
    "effective_to",
    "started_at",
    "ended_at",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(created.body, forbidden), false);
  }

  // Từ chối mã NLĐ dự án hrp-YYYY-XXXXXX
  const projectCodeRejected = buildCreatePersonRequest({
    employeeCode: "hrp-2026-000001",
    fullName: "Trần Thị B",
    reason: "Thử mã NLĐ dự án",
    idempotencyKey: UUID_IDEM,
  });
  assert.equal(projectCodeRejected.ok, false);

  const shortCodeRejected = buildCreatePersonRequest({
    employeeCode: "A",
    fullName: "Trần Thị B",
    reason: "Mã quá ngắn",
    idempotencyKey: UUID_IDEM,
  });
  assert.equal(shortCodeRejected.ok, false);

  const badJoinedOn = buildCreatePersonRequest({
    employeeCode: "NS-002",
    fullName: "Trần Thị B",
    joinedOn: "13/11/2026",
    reason: "Sai định dạng ngày",
    idempotencyKey: UUID_IDEM,
  });
  assert.equal(badJoinedOn.ok, false);

  const updated = buildUpdatePersonRequest({
    expectedPersonVersion: 2,
    employeeCode: "NS-2026-01",
    fullName: "Trần Thị B (Đã sửa)",
    joinedOn: null,
    status: "INACTIVE",
    reason: "Nhân sự nghỉ việc nội bộ",
    idempotencyKey: UUID_IDEM,
  });
  assert.equal(updated.ok, true);
  if (!updated.ok) return;
  assert.equal(updated.body.expected_person_version, 2);
  assert.equal(updated.body.status, "INACTIVE");
  for (const forbidden of [
    "valid_from",
    "valid_to",
    "effective_from",
    "effective_to",
    "started_at",
    "ended_at",
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(updated.body, forbidden), false);
  }

  const updateProjectCodeRejected = buildUpdatePersonRequest({
    expectedPersonVersion: 2,
    employeeCode: "hrp-2026-000099",
    fullName: "Trần Thị B",
    status: "ACTIVE",
    reason: "Cập nhật mã",
    idempotencyKey: UUID_IDEM,
  });
  assert.equal(updateProjectCodeRejected.ok, false);
});

test("builders gán, chuyển và kết thúc phòng ban dựng đúng payload contract áp dụng ngay", () => {
  const assignReq = buildAssignPersonDepartmentRequest({
    personId: UUID_PERSON,
    expectedPersonVersion: 4,
    reason: "Gán phòng ban vận hành",
    idempotencyKey: UUID_IDEM,
  });
  assert.equal(assignReq.ok, true);
  if (assignReq.ok) {
    assert.deepEqual(assignReq.body, {
      person_id: UUID_PERSON,
      expected_person_version: 4,
      reason: "Gán phòng ban vận hành",
      idempotency_key: UUID_IDEM,
    });
  }

  const transferReq = buildTransferPersonDepartmentRequest({
    targetDepartmentRef: UUID_DEPT_B,
    expectedPersonVersion: 4,
    expectedCurrentMembershipId: UUID_MEMBERSHIP,
    reason: "Điều chuyển sang phòng ban mới",
    idempotencyKey: UUID_IDEM,
  });
  assert.equal(transferReq.ok, true);
  if (transferReq.ok) {
    assert.deepEqual(transferReq.body, {
      target_department_ref: UUID_DEPT_B,
      expected_person_version: 4,
      expected_current_membership_id: UUID_MEMBERSHIP,
      reason: "Điều chuyển sang phòng ban mới",
      idempotency_key: UUID_IDEM,
    });
  }

  const endReq = buildEndPersonDepartmentRequest({
    expectedPersonVersion: 5,
    reason: "Kết thúc trực thuộc phòng ban",
    idempotencyKey: UUID_IDEM,
  });
  assert.equal(endReq.ok, true);
  if (endReq.ok) {
    assert.deepEqual(endReq.body, {
      expected_person_version: 5,
      reason: "Kết thúc trực thuộc phòng ban",
      idempotency_key: UUID_IDEM,
    });
  }
});

test("projectPersonListEnvelope & projectPersonDetailEnvelope chặn response cũ không khớp bộ lọc hoặc person_id", () => {
  const filter = {
    search: "An",
    status: "active",
    departmentId: UUID_DEPT_A,
    linkState: "all",
    page: 1,
    pageSize: DEFAULT_ORG_PAGE_SIZE,
  };
  const validListPayload = {
    ok: true,
    authorization_date: "2026-11-13",
    as_of: "2026-11-13T10:00:00.000Z",
    search: "An",
    status: "active",
    department_id: UUID_DEPT_A,
    link_state: "all",
    page: 1,
    page_size: DEFAULT_ORG_PAGE_SIZE,
    total: 1,
    has_more: false,
    persons: [makePersonSummary()],
  };
  const projectedList = projectPersonListEnvelope(validListPayload, filter);
  assert.ok(projectedList);
  assert.equal(projectedList.persons.length, 1);

  // Stale response (khác page / department_id / status) phải bị loại
  assert.equal(projectPersonListEnvelope({ ...validListPayload, page: 2 }, filter), null);
  assert.equal(projectPersonListEnvelope({ ...validListPayload, department_id: UUID_DEPT_B }, filter), null);
  assert.equal(projectPersonListEnvelope({ ...validListPayload, ok: false }, filter), null);

  const detailPayload = {
    ok: true,
    authorization_date: "2026-11-13",
    as_of: "2026-11-13T10:00:00.000Z",
    person: makePersonDetail({
      active_account_link: {
        link_id: UUID_LINK,
        account_ref: UUID_ACCOUNT,
        login_id: "annv",
        display_name: "Nguyễn Văn A",
        enabled: false,
        account_version: 2,
        started_at: "2026-11-01T08:00:00.000Z",
        source_kind: "ADMIN_MUTATION",
        evidence_date: null,
        version: 1,
      },
      head_assignments: [
        {
          head_assignment_id: UUID_HEAD,
          department_id: UUID_DEPT_A,
          system_key: null,
          code: "CUSTOM_OP",
          name: "Phòng Vận hành",
          started_at: "2026-11-01T08:00:00.000Z",
          ended_at: null,
          source_kind: "ADMIN_MUTATION",
          evidence_date: null,
          version: 1,
        },
      ],
    }),
  };
  assert.ok(projectPersonDetailEnvelope(detailPayload, UUID_PERSON));
  assert.equal(projectPersonDetailEnvelope(detailPayload, UUID_ACCOUNT), null);
});

test("classifyPersonOrgReadError & classifyPersonOrgMutationResponse xử lý đúng 401/403, 409 OCC, active head, và uncertain retry", () => {
  assert.equal(classifyPersonOrgReadError(401, { code: "UNAUTHENTICATED" }).kind, "unauthenticated");
  assert.equal(classifyPersonOrgReadError(403, { code: "FORBIDDEN" }).kind, "denied");
  assert.equal(classifyPersonOrgReadError(404, { code: "PERSON_NOT_FOUND" }).kind, "not-found");
  const unavailable = classifyPersonOrgReadError(503, { code: "ORG_UNAVAILABLE" });
  assert.equal(unavailable.kind, "unavailable");
  assert.equal(unavailable.retryable, true);

  // Create/update thành công (kể cả replayed=true)
  const createdOutcome = classifyPersonOrgMutationResponse(
    201,
    { ok: true, replayed: false, person: makePersonDetail() },
    "create",
  );
  assert.equal(createdOutcome.kind, "applied");
  if (createdOutcome.kind === "applied") {
    assert.equal(createdOutcome.replayed, false);
  }

  const replayedUpdate = classifyPersonOrgMutationResponse(
    200,
    { ok: true, replayed: true, person: makePersonDetail({ version: 3 }) },
    "update",
  );
  assert.equal(replayedUpdate.kind, "applied");
  if (replayedUpdate.kind === "applied") {
    assert.equal(replayedUpdate.replayed, true);
  }

  // Transfer phòng ban thành công
  const transferred = classifyPersonOrgMutationResponse(
    200,
    {
      ok: true,
      replayed: false,
      person_version: 4,
      closed_membership: {
        membership_id: UUID_MEMBERSHIP,
        department_id: UUID_DEPT_A,
        started_at: "2026-11-01T08:00:00.000Z",
        ended_at: "2026-11-13T10:00:00.000Z",
        version: 2,
      },
      active_membership: {
        membership_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        department_id: UUID_DEPT_B,
        system_key: null,
        code: "OPS",
        name: "Phòng Khai thác",
        started_at: "2026-11-13T10:00:00.000Z",
        ended_at: null,
        source_kind: "ADMIN_MUTATION",
        evidence_date: null,
        version: 1,
      },
    },
    "transfer-department",
  );
  assert.equal(transferred.kind, "applied");

  // Assign / end department thành công
  const assigned = classifyPersonOrgMutationResponse(
    201,
    {
      ok: true,
      replayed: false,
      person_version: 3,
      membership: {
        membership_id: UUID_MEMBERSHIP,
        department_id: UUID_DEPT_A,
        person_id: UUID_PERSON,
        employee_code: "HRP-NS-001",
        full_name: "Nguyễn Văn A",
        person_status: "ACTIVE",
        person_version: 3,
        active_account_ref: UUID_ACCOUNT,
        is_department_head: false,
        started_at: "2026-11-13T10:00:00.000Z",
        ended_at: null,
        source_kind: "ADMIN_MUTATION",
        evidence_date: null,
        version: 1,
      },
    },
    "assign-department",
  );
  assert.equal(assigned.kind, "applied");

  // Mất phản hồi / malformed 200 / 503 phải giữ nguyên Idempotency-Key để retry
  const malformed200 = classifyPersonOrgMutationResponse(200, { ok: true, weird: true }, "update");
  assert.equal(malformed200.kind, "uncertain");
  assert.equal(malformed200.preserveIdempotencyKey, true);

  const err503 = classifyPersonOrgMutationResponse(503, { code: "ORG_UNAVAILABLE" }, "create");
  assert.equal(err503.kind, "uncertain");
  assert.equal(err503.preserveIdempotencyKey, true);

  const inProgressDirect = classifyPersonOrgMutationResponse(
    409,
    { code: "IDEMPOTENCY_IN_PROGRESS" },
    "update",
  );
  assert.equal(inProgressDirect.kind, "uncertain");
  assert.equal(inProgressDirect.preserveIdempotencyKey, true);

  const inProgressNested = classifyPersonOrgMutationResponse(
    409,
    { ok: false, error: { code: "IDEMPOTENCY_IN_PROGRESS" } },
    "update",
  );
  assert.equal(inProgressNested.kind, "uncertain");
  assert.equal(inProgressNested.preserveIdempotencyKey, true);

  // 401/403 mất phiên/quyền
  const lost401 = classifyPersonOrgMutationResponse(401, { code: "UNAUTHENTICATED" }, "update");
  assert.equal(lost401.kind, "session-lost");
  const lost403 = classifyPersonOrgMutationResponse(403, { code: "FORBIDDEN" }, "end-department");
  assert.equal(lost403.kind, "session-lost");

  // 409 OCC không ghi đè
  const occ = classifyPersonOrgMutationResponse(409, { code: "VERSION_CONFLICT" }, "update");
  assert.equal(occ.kind, "conflict");
  assert.equal(occ.preserveIdempotencyKey, false);

  // 409 PERSON_IS_ACTIVE_DEPARTMENT_HEAD giải thích rõ phải kết thúc/thay chức danh Trưởng phòng
  const headBlock = classifyPersonOrgMutationResponse(
    409,
    { code: "PERSON_IS_ACTIVE_DEPARTMENT_HEAD" },
    "transfer-department",
  );
  assert.equal(headBlock.kind, "active-head-block");
  assert.match(headBlock.message, /Trưởng phòng/);
  assert.match(headBlock.message, /kết thúc hoặc thay chức danh/i);

  // Lỗi nghiệp vụ khác
  for (const code of [
    "DUPLICATE_CODE",
    "ACCOUNT_TYPE_LINK_FORBIDDEN",
    "RECRUITER_IDENTITY_CONFLICT",
  ]) {
    const res = classifyPersonOrgMutationResponse(409, { code }, "create");
    assert.equal(res.kind, "business-error");
    assert.equal(res.preserveIdempotencyKey, false);
  }
  const sched400 = classifyPersonOrgMutationResponse(
    400,
    { code: "CLIENT_SCHEDULE_FIELD_FORBIDDEN" },
    "update",
  );
  assert.equal(sched400.kind, "invalid");
});
