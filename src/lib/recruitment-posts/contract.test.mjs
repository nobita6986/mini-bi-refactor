import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RECRUITMENT_POST_PAGE_SIZE,
  MAX_RECRUITMENT_POST_PAGE_SIZE,
  RECRUITMENT_POST_ERROR_CODES,
  containsForbiddenClientAuthorityKey,
  parseCreateRecruitmentPostBody,
  parseIdempotencyKeyHeader,
  parseListMyRecruitmentPostsQuery,
  parseListRecruitmentPostsQuery,
  parseNoQueryParams,
  parseUpdateRecruitmentPostBody,
  parseUuidParam,
  parseWithdrawRecruitmentPostBody,
  projectRecruitmentPostContext,
  projectRecruitmentPostGet,
  projectRecruitmentPostIndustrialParkFacet,
  projectRecruitmentPostItem,
  projectRecruitmentPostLaborTypeFacet,
  projectRecruitmentPostList,
  projectRecruitmentPostListWithFacets,
  projectRecruitmentPostMutation,
  projectRecruitmentPostPublicFeedV1,
  projectRecruitmentPostPublicJobItemV1,
  recruitmentPostHttpStatusForError,
} from "./contract.ts";

const BRIEF_ID = "11111111-1111-4111-8111-111111111111";
const PROVINCE_ID = "22222222-2222-4222-8222-222222222222";
const PARK_ID = "33333333-3333-4333-8333-333333333333";
const IDEM_KEY = "44444444-4444-4444-8444-444444444444";
const FILTER_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

function makeValidContentInput() {
  return {
    general: {
      customer_name: " Công ty TNHH Điện tử A ",
      investment_origin: "Hàn Quốc",
      manufacturing_industry: "Linh kiện điện tử",
      job_description: " Lắp ráp linh kiện điện tử ",
      environment_types: ["NORMAL_ROOM", "CLEAN_ROOM"],
      work_postures: ["SITTING", "STANDING"],
      shift_pattern: "TWO_SHIFTS",
      shift_details: null,
      manager_name: " Nguyễn Văn Quản Lý ",
      manager_phone: " 0912 345 678 ",
      labor_type_keys: ["THOI_VU", "CHINH_THUC"],
      supply_schedule_text: "Cung ứng tuần 1-4",
      expected_headcount: 50,
    },
    candidate: {
      age_min: 18,
      age_max: 40,
      gender_requirement: "ANY",
      education_requirement: "SECONDARY",
      experience_required: false,
      experience_details: null,
      accept_former_customer_workers: true,
      entry_assessment_text: "Phỏng vấn trực tiếp",
      other_requirements_text: null,
    },
    compensation: {
      base_salary_vnd: "6000000",
      base_salary_conditions: "Đủ 26 công",
      attendance_bonus_vnd: "500000",
      attendance_bonus_conditions: "Không nghỉ",
      living_allowance_vnd: "300000",
      living_allowance_conditions: null,
      seniority_allowance_vnd: null,
      seniority_allowance_conditions: null,
      eyesight_allowance_vnd: null,
      eyesight_allowance_conditions: null,
      other_allowance_text: null,
      average_income_min_vnd: "9000000",
      average_income_max_vnd: "12000000",
      salary_payment_schedule: "Ngày 10 hàng tháng",
      salary_advance_available: true,
      salary_advance_amount_vnd: "2000000",
      salary_advance_schedule: "Ngày 25 hàng tháng",
      weekly_salary_available: false,
      weekly_salary_payment_schedule: null,
      day_shift_8h_vnd: "250000",
      day_shift_11h_vnd: "350000",
      night_shift_8h_vnd: "290000",
      night_shift_11h_vnd: "410000",
      sunday_day_11h_vnd: "500000",
      sunday_night_11h_vnd: "580000",
      holiday_day_11h_vnd: "750000",
      holiday_night_11h_vnd: "850000",
      ppe_provided: true,
      ppe_details: "Áo chống tĩnh điện, giày bảo hộ",
      other_benefits: "Bao cơm ca",
    },
    documents: {
      require_original_cccd_and_copy: true,
      require_certified_resume: false,
      require_health_certificate_within_6_months: false,
      require_photo_3x4: true,
      require_degree_or_certificate: false,
      require_social_insurance_book: false,
      require_other_documents: false,
      other_documents_text: null,
    },
  };
}

function makeValidProjectedItem() {
  const content = makeValidContentInput();
  const generalRest = { ...content.general };
  delete generalRest.labor_type_keys;
  return {
    brief_id: BRIEF_ID,
    version: 1,
    status: "PUBLISHED",
    project: {
      project_id: "PROJ_A",
      display_name: "Dự án A",
    },
    industrial_park: {
      industrial_park_id: PARK_ID,
      industrial_park_code: "VP_BA_THIEN_1",
      display_name: "KCN Bá Thiện 1",
      active: true,
    },
    province: {
      province_id: PROVINCE_ID,
      province_code: "VINH_PHUC",
      display_name: "Vĩnh Phúc",
    },
    published_at: "2026-11-10T08:00:00.123456Z",
    updated_at: "2026-11-10T08:00:00.123456Z",
    withdrawn_at: null,
    created_by_display_name: "Nguyễn Văn A",
    updated_by_display_name: "Nguyễn Văn A",
    withdrawn_by_display_name: null,
    general: {
      ...generalRest,
      customer_name: "Công ty TNHH Điện tử A",
      job_description: "Lắp ráp linh kiện điện tử",
      environment_types: ["CLEAN_ROOM", "NORMAL_ROOM"],
      work_postures: ["SITTING", "STANDING"],
      manager_name: "Nguyễn Văn Quản Lý",
      manager_phone: "0912 345 678",
      labor_types: [
        { labor_type_key: "CHINH_THUC", display_name: "Chính thức" },
        { labor_type_key: "THOI_VU", display_name: "Thời vụ" },
      ],
    },
    candidate: content.candidate,
    compensation: content.compensation,
    documents: content.documents,
    allowed_actions: {
      can_edit: true,
      can_withdraw: true,
    },
  };
}

test("error code catalog and HTTP status mapping do not include ACTIVE_PAIR_EXISTS", () => {
  assert.ok(
    !RECRUITMENT_POST_ERROR_CODES.includes(
      "RECRUITMENT_POST_ACTIVE_PAIR_EXISTS",
    ),
  );
  assert.equal(recruitmentPostHttpStatusForError("NOT_FOUND"), 404);
  assert.equal(recruitmentPostHttpStatusForError("UNAUTHENTICATED"), 401);
  assert.equal(recruitmentPostHttpStatusForError("ACTOR_NOT_AVAILABLE"), 403);
  assert.equal(recruitmentPostHttpStatusForError("CSRF_ORIGIN_DENIED"), 403);
  assert.equal(
    recruitmentPostHttpStatusForError("CLIENT_AUTHORITY_FIELD_FORBIDDEN"),
    400,
  );
  assert.equal(recruitmentPostHttpStatusForError("INVALID_JSON"), 400);
  assert.equal(
    recruitmentPostHttpStatusForError("REQUEST_BODY_TOO_LARGE"),
    413,
  );
  assert.equal(
    recruitmentPostHttpStatusForError("RECRUITMENT_POST_IDEMPOTENCY_INVALID"),
    400,
  );
  assert.equal(
    recruitmentPostHttpStatusForError("RECRUITMENT_POST_INPUT_INVALID"),
    400,
  );
  assert.equal(
    recruitmentPostHttpStatusForError("RECRUITMENT_POST_SNAPSHOT_INVALID"),
    400,
  );
  assert.equal(
    recruitmentPostHttpStatusForError("RECRUITMENT_POST_CONTENT_INVALID"),
    422,
  );
  assert.equal(
    recruitmentPostHttpStatusForError("RECRUITMENT_POST_ACCESS_DENIED"),
    403,
  );
  assert.equal(
    recruitmentPostHttpStatusForError("RECRUITMENT_POST_NOT_FOUND"),
    404,
  );
  assert.equal(
    recruitmentPostHttpStatusForError("RECRUITMENT_POST_STALE"),
    409,
  );
  assert.equal(
    recruitmentPostHttpStatusForError("RECRUITMENT_POST_ALREADY_WITHDRAWN"),
    409,
  );
  assert.equal(
    recruitmentPostHttpStatusForError("RECRUITMENT_POST_IDEMPOTENCY_CONFLICT"),
    409,
  );
  assert.equal(
    recruitmentPostHttpStatusForError("RECRUITMENT_POST_UNAVAILABLE"),
    503,
  );
});

test("parseCreateRecruitmentPostBody accepts nested content and flat sections, normalizes and sorts arrays", () => {
  const nested = parseCreateRecruitmentPostBody({
    project_id: "PROJ_A",
    industrial_park_id: PARK_ID.toUpperCase(),
    content: makeValidContentInput(),
  });
  assert.equal(nested.ok, true);
  if (nested.ok) {
    assert.equal(nested.value.industrial_park_id, PARK_ID);
    assert.equal(
      nested.value.content.general.customer_name,
      "Công ty TNHH Điện tử A",
    );
    assert.deepEqual(nested.value.content.general.environment_types, [
      "CLEAN_ROOM",
      "NORMAL_ROOM",
    ]);
    assert.deepEqual(nested.value.content.general.work_postures, [
      "SITTING",
      "STANDING",
    ]);
    assert.deepEqual(nested.value.content.general.labor_type_keys, [
      "CHINH_THUC",
      "THOI_VU",
    ]);
  }

  const flat = parseCreateRecruitmentPostBody({
    project_id: "PROJ_A",
    industrial_park_id: PARK_ID,
    ...makeValidContentInput(),
  });
  assert.equal(flat.ok, true);

  // Server actorDisplayName override replaces client manager_name in both content and rpc_payload
  const clientSpoofedContent = makeValidContentInput();
  clientSpoofedContent.general.manager_name = "Client Spoofed Manager";
  const overridden = parseCreateRecruitmentPostBody(
    {
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: clientSpoofedContent,
    },
    { actorDisplayName: "  Trần Văn PM Server  " },
  );
  assert.equal(overridden.ok, true);
  if (overridden.ok) {
    assert.equal(
      overridden.value.content.general.manager_name,
      "Trần Văn PM Server",
    );
    assert.equal(
      overridden.value.rpc_payload.general.manager_name,
      "Trần Văn PM Server",
    );
  }

  // Server managerNameOverride on update replaces tampered client manager_name while keeping expected_version
  const updateTamperedContent = makeValidContentInput();
  updateTamperedContent.general.manager_name = "Tên Giả Mạo Khi Sửa";
  updateTamperedContent.general.manager_phone = "0988777666";
  const overriddenUpdate = parseUpdateRecruitmentPostBody(
    {
      expected_version: 3,
      content: updateTamperedContent,
    },
    { managerNameOverride: "  Nguyễn Văn Quản Lý Gốc  " },
  );
  assert.equal(overriddenUpdate.ok, true);
  if (overriddenUpdate.ok) {
    assert.equal(overriddenUpdate.value.expected_version, 3);
    assert.equal(
      overriddenUpdate.value.content.general.manager_name,
      "Nguyễn Văn Quản Lý Gốc",
    );
    assert.equal(
      overriddenUpdate.value.rpc_payload.general.manager_name,
      "Nguyễn Văn Quản Lý Gốc",
    );
    assert.equal(
      overriddenUpdate.value.rpc_payload.general.manager_phone,
      "0988777666",
    );
  }
});

test("parseCreateRecruitmentPostBody and parseUpdateRecruitmentPostBody enforce exact keys, authority deny-list, and business rules", () => {
  assert.deepEqual(
    parseCreateRecruitmentPostBody({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: makeValidContentInput(),
      app_user_id: BRIEF_ID,
    }),
    { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" },
  );

  assert.deepEqual(
    parseCreateRecruitmentPostBody({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: makeValidContentInput(),
      idempotency_key: IDEM_KEY,
    }),
    { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" },
  );

  assert.deepEqual(
    parseUpdateRecruitmentPostBody({
      expected_version: 1,
      project_id: "PROJ_A",
      content: makeValidContentInput(),
    }),
    { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" },
  );

  // Business content checks -> 422 RECRUITMENT_POST_CONTENT_INVALID
  const badAge = makeValidContentInput();
  badAge.candidate.age_min = 45;
  badAge.candidate.age_max = 30;
  assert.deepEqual(
    parseCreateRecruitmentPostBody({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: badAge,
    }),
    { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" },
  );

  const badShift = makeValidContentInput();
  badShift.general.shift_pattern = "OTHER";
  badShift.general.shift_details = "   ";
  assert.deepEqual(
    parseCreateRecruitmentPostBody({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: badShift,
    }),
    { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" },
  );

  const badExp = makeValidContentInput();
  badExp.candidate.experience_required = true;
  badExp.candidate.experience_details = null;
  assert.deepEqual(
    parseCreateRecruitmentPostBody({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: badExp,
    }),
    { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" },
  );

  const badAdvance = makeValidContentInput();
  badAdvance.compensation.salary_advance_available = false;
  badAdvance.compensation.salary_advance_amount_vnd = "500000";
  assert.deepEqual(
    parseCreateRecruitmentPostBody({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: badAdvance,
    }),
    { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" },
  );

  const badDocs = makeValidContentInput();
  badDocs.documents.require_other_documents = true;
  badDocs.documents.other_documents_text = null;
  assert.deepEqual(
    parseCreateRecruitmentPostBody({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: badDocs,
    }),
    { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" },
  );

  const badVndRange = makeValidContentInput();
  badVndRange.compensation.average_income_min_vnd = "15000000";
  badVndRange.compensation.average_income_max_vnd = "12000000";
  assert.deepEqual(
    parseCreateRecruitmentPostBody({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: badVndRange,
    }),
    { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" },
  );

  const badVndMax = makeValidContentInput();
  badVndMax.compensation.base_salary_vnd = "9007199254740992";
  assert.deepEqual(
    parseCreateRecruitmentPostBody({
      project_id: "PROJ_A",
      industrial_park_id: PARK_ID,
      content: badVndMax,
    }),
    { ok: false, code: "RECRUITMENT_POST_CONTENT_INVALID" },
  );
});

test("parseWithdrawRecruitmentPostBody, parseIdempotencyKeyHeader, parseUuidParam, and parseNoQueryParams validate strictly", () => {
  assert.deepEqual(parseWithdrawRecruitmentPostBody({ expected_version: 2 }), {
    ok: true,
    value: { expected_version: 2 },
  });
  assert.deepEqual(
    parseWithdrawRecruitmentPostBody({ expected_version: 0 }),
    { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" },
  );
  assert.deepEqual(
    parseWithdrawRecruitmentPostBody({
      expected_version: 1,
      reason: "khong cho phep",
    }),
    { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" },
  );

  assert.deepEqual(parseIdempotencyKeyHeader(IDEM_KEY.toUpperCase()), {
    ok: true,
    value: IDEM_KEY,
  });
  assert.deepEqual(parseIdempotencyKeyHeader(null), {
    ok: false,
    code: "RECRUITMENT_POST_IDEMPOTENCY_INVALID",
  });
  assert.deepEqual(parseIdempotencyKeyHeader("not-a-uuid"), {
    ok: false,
    code: "RECRUITMENT_POST_IDEMPOTENCY_INVALID",
  });

  assert.deepEqual(parseUuidParam(BRIEF_ID), { ok: true, value: BRIEF_ID });
  assert.deepEqual(parseUuidParam("bad"), {
    ok: false,
    code: "RECRUITMENT_POST_INPUT_INVALID",
  });

  assert.equal(parseNoQueryParams(new URL("https://app.test/api/x")).ok, true);
  assert.deepEqual(
    parseNoQueryParams(new URL("https://app.test/api/x?foo=1")),
    { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" },
  );
});

test("parseListRecruitmentPostsQuery validates filters and 18-digit bounded S1/C1 snapshot & cursor tokens", () => {
  const token = `S1.42.${FILTER_HASH}`;
  const cursor = `C1.42.${FILTER_HASH}.1762761600123456.${BRIEF_ID}`;
  const parsed = parseListRecruitmentPostsQuery(
    new URL(
      `https://app.test/api/recruitment-posts?project_id=PROJ_A&province_id=${PROVINCE_ID}&industrial_park_id=${PARK_ID}&labor_type_key=CHINH_THUC&updated_from=2026-11-01&updated_to=2026-11-10&page_size=5&snapshot_token=${token}&cursor=${cursor}`,
    ),
  );
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.value.page_size, 5);
    assert.equal(parsed.value.snapshot_token, token);
    assert.equal(parsed.value.cursor, cursor);
  }

  // Cursor without snapshot_token -> RECRUITMENT_POST_SNAPSHOT_INVALID
  assert.deepEqual(
    parseListRecruitmentPostsQuery(
      new URL(`https://app.test/api/recruitment-posts?cursor=${cursor}`),
    ),
    { ok: false, code: "RECRUITMENT_POST_SNAPSHOT_INVALID" },
  );

  // 19-digit integer in snapshot_token -> RECRUITMENT_POST_SNAPSHOT_INVALID
  assert.deepEqual(
    parseListRecruitmentPostsQuery(
      new URL(
        `https://app.test/api/recruitment-posts?snapshot_token=S1.9999999999999999999.${FILTER_HASH}`,
      ),
    ),
    { ok: false, code: "RECRUITMENT_POST_SNAPSHOT_INVALID" },
  );

  // Mismatched snapshot_seq between cursor and snapshot_token -> RECRUITMENT_POST_SNAPSHOT_INVALID
  assert.deepEqual(
    parseListRecruitmentPostsQuery(
      new URL(
        `https://app.test/api/recruitment-posts?snapshot_token=S1.43.${FILTER_HASH}&cursor=${cursor}`,
      ),
    ),
    { ok: false, code: "RECRUITMENT_POST_SNAPSHOT_INVALID" },
  );

  // Duplicate query param -> RECRUITMENT_POST_INPUT_INVALID
  assert.deepEqual(
    parseListRecruitmentPostsQuery(
      new URL(
        "https://app.test/api/recruitment-posts?project_id=A&project_id=B",
      ),
    ),
    { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" },
  );

  // Page size default is 15, max is 15; 16 is rejected
  assert.equal(DEFAULT_RECRUITMENT_POST_PAGE_SIZE, 15);
  assert.equal(MAX_RECRUITMENT_POST_PAGE_SIZE, 15);
  const defaultParsed = parseListRecruitmentPostsQuery(
    new URL("https://app.test/api/recruitment-posts"),
  );
  assert.equal(defaultParsed.ok, true);
  if (defaultParsed.ok) {
    assert.equal(defaultParsed.value.page_size, 15);
  }
  const maxParsed = parseListRecruitmentPostsQuery(
    new URL("https://app.test/api/recruitment-posts?page_size=15"),
  );
  assert.equal(maxParsed.ok, true);
  assert.deepEqual(
    parseListRecruitmentPostsQuery(
      new URL("https://app.test/api/recruitment-posts?page_size=16"),
    ),
    { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" },
  );
});

test("parseListMyRecruitmentPostsQuery accepts only cursor, snapshot_token, and page_size (1..15) and rejects filter or client authority keys", () => {
  const token = `S1.42.${FILTER_HASH}`;
  const cursor = `C1.42.${FILTER_HASH}.1762761600123456.${BRIEF_ID}`;

  const defaultMine = parseListMyRecruitmentPostsQuery(
    new URL("https://app.test/api/recruitment-posts/mine"),
  );
  assert.deepEqual(defaultMine, {
    ok: true,
    value: {
      cursor: null,
      snapshot_token: null,
      page_size: 15,
    },
  });

  const pagedMine = parseListMyRecruitmentPostsQuery(
    new URL(
      `https://app.test/api/recruitment-posts/mine?page_size=15&snapshot_token=${token}&cursor=${cursor}`,
    ),
  );
  assert.deepEqual(pagedMine, {
    ok: true,
    value: {
      cursor,
      snapshot_token: token,
      page_size: 15,
    },
  });

  // Reject page_size=0 or 16
  for (const badSize of ["0", "16", "-1", "abc"]) {
    assert.deepEqual(
      parseListMyRecruitmentPostsQuery(
        new URL(`https://app.test/api/recruitment-posts/mine?page_size=${badSize}`),
      ),
      { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" },
    );
  }

  // Reject feed filter keys (project_id, status, province_id, etc.)
  for (const extraParam of [
    "project_id=PROJ_A",
    "status=WITHDRAWN",
    `province_id=${PROVINCE_ID}`,
  ]) {
    assert.deepEqual(
      parseListMyRecruitmentPostsQuery(
        new URL(`https://app.test/api/recruitment-posts/mine?${extraParam}`),
      ),
      { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" },
    );
  }

  // Reject client authority keys with CLIENT_AUTHORITY_FIELD_FORBIDDEN
  for (const authorityKey of [
    "app_user_id",
    "auth_subject",
    "creator_id",
    "created_by_app_user_id",
    "user_id",
    "email",
    "username",
  ]) {
    assert.deepEqual(
      parseListMyRecruitmentPostsQuery(
        new URL(`https://app.test/api/recruitment-posts/mine?${authorityKey}=spoof`),
      ),
      { ok: false, code: "CLIENT_AUTHORITY_FIELD_FORBIDDEN" },
    );
  }

  // Reject duplicate keys and cursor without snapshot_token
  assert.deepEqual(
    parseListMyRecruitmentPostsQuery(
      new URL("https://app.test/api/recruitment-posts/mine?page_size=10&page_size=15"),
    ),
    { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" },
  );
  assert.deepEqual(
    parseListMyRecruitmentPostsQuery(
      new URL(`https://app.test/api/recruitment-posts/mine?cursor=${cursor}`),
    ),
    { ok: false, code: "RECRUITMENT_POST_SNAPSHOT_INVALID" },
  );
});

test("fail-closed projections accept valid shapes and reject extra or missing keys", () => {
  const ctx = projectRecruitmentPostContext({
    can_create: true,
    managed_projects: [{ project_id: "PROJ_A", display_name: "Dự án A" }],
    filter_projects: [{ project_id: "PROJ_A", display_name: "Dự án A" }],
    provinces: [
      {
        province_id: PROVINCE_ID,
        province_code: "VINH_PHUC",
        display_name: "Vĩnh Phúc",
        active: true,
      },
    ],
    industrial_parks: [
      {
        industrial_park_id: PARK_ID,
        industrial_park_code: "VP_BA_THIEN_1",
        province_id: PROVINCE_ID,
        display_name: "KCN Bá Thiện 1",
        active: true,
      },
    ],
    labor_types: [
      {
        labor_type_key: "CHINH_THUC",
        display_name: "Chính thức",
        active: true,
      },
    ],
  });
  assert.ok(ctx !== null);

  // Missing `active` on labor_types must fail closed
  assert.equal(
    projectRecruitmentPostContext({
      can_create: true,
      managed_projects: [],
      filter_projects: [],
      provinces: [],
      industrial_parks: [],
      labor_types: [
        { labor_type_key: "CHINH_THUC", display_name: "Chính thức" },
      ],
    }),
    null,
  );

  const item = makeValidProjectedItem();
  assert.ok(projectRecruitmentPostItem(item) !== null);
  assert.equal(
    projectRecruitmentPostItem({ ...item, leaked_field: "secret" }),
    null,
  );

  const list = projectRecruitmentPostList({
    items: [item],
    page_size: 10,
    has_more: false,
    next_cursor: null,
    snapshot_token: `S1.1.${FILTER_HASH}`,
  });
  assert.ok(list !== null);

  assert.ok(projectRecruitmentPostGet({ post: item }) !== null);
  assert.ok(
    projectRecruitmentPostMutation({
      post: item,
      changed: true,
      replayed: false,
    }) !== null,
  );
  assert.equal(containsForbiddenClientAuthorityKey({ scope: "all" }), true);
});

test("projectRecruitmentPostPublicFeedV1 enforces explicit allowlist, gender_label 'Nam/Nữ', and rejects internal/admin fields", () => {
  const item = makeValidProjectedItem();
  const validPublicJob = {
    id: item.brief_id,
    brief_id: item.brief_id,
    version: item.version,
    published_at: item.published_at,
    updated_at: item.updated_at,
    location: {
      province_code: item.province.province_code,
      province_name: item.province.display_name,
      industrial_park_code: item.industrial_park.industrial_park_code,
      industrial_park_name: item.industrial_park.display_name,
    },
    general: {
      customer_name: item.general.customer_name,
      investment_origin: item.general.investment_origin,
      manufacturing_industry: item.general.manufacturing_industry,
      job_description: item.general.job_description,
      environment_types: item.general.environment_types,
      work_postures: item.general.work_postures,
      shift_pattern: item.general.shift_pattern,
      shift_details: item.general.shift_details,
      labor_types: item.general.labor_types,
      supply_schedule_text: item.general.supply_schedule_text,
      expected_headcount: item.general.expected_headcount,
    },
    candidate: {
      ...item.candidate,
      gender_label: "Nam/Nữ",
    },
    compensation: item.compensation,
    documents: item.documents,
  };

  const emptyFeed = projectRecruitmentPostPublicFeedV1({
    schema_version: 1,
    jobs: [],
  });
  assert.deepEqual(emptyFeed, { schema_version: 1, jobs: [] });

  const validFeed = projectRecruitmentPostPublicFeedV1({
    schema_version: 1,
    jobs: [validPublicJob],
  });
  assert.ok(validFeed !== null);
  assert.equal(validFeed.schema_version, 1);
  assert.equal(validFeed.jobs.length, 1);
  assert.equal(validFeed.jobs[0].id, BRIEF_ID);
  assert.equal(validFeed.jobs[0].brief_id, BRIEF_ID);
  assert.equal(validFeed.jobs[0].candidate.gender_requirement, "ANY");
  assert.equal(validFeed.jobs[0].candidate.gender_label, "Nam/Nữ");
  assert.equal("manager_phone" in validFeed.jobs[0].general, false);
  assert.equal("manager_name" in validFeed.jobs[0].general, false);
  assert.equal("allowed_actions" in validFeed.jobs[0], false);
  assert.equal("created_by_display_name" in validFeed.jobs[0], false);
  assert.equal("updated_by_display_name" in validFeed.jobs[0], false);

  // Obsolete gender label "Cặp Nam/Nữ" must be rejected fail-closed
  assert.equal(
    projectRecruitmentPostPublicJobItemV1({
      ...validPublicJob,
      candidate: {
        ...validPublicJob.candidate,
        gender_label: "Cặp Nam/Nữ",
      },
    }),
    null,
  );

  // Wrong schema_version must be rejected
  assert.equal(
    projectRecruitmentPostPublicFeedV1({
      schema_version: 2,
      jobs: [],
    }),
    null,
  );

  // Leaked internal fields (manager_phone, manager_name, created_by_display_name, allowed_actions, project_id) must be rejected fail-closed
  for (const leakedJob of [
    {
      ...validPublicJob,
      general: {
        ...validPublicJob.general,
        manager_phone: "0912345678",
      },
    },
    {
      ...validPublicJob,
      general: {
        ...validPublicJob.general,
        manager_name: "Nguyễn Văn Quản Lý",
      },
    },
    {
      ...validPublicJob,
      created_by_display_name: "Nguyễn Văn A",
    },
    {
      ...validPublicJob,
      updated_by_display_name: "Nguyễn Văn A",
    },
    {
      ...validPublicJob,
      allowed_actions: { can_edit: true, can_withdraw: true },
    },
    {
      ...validPublicJob,
      project_id: "PROJ_A",
    },
  ]) {
    assert.equal(projectRecruitmentPostPublicJobItemV1(leakedJob), null);
    assert.equal(
      projectRecruitmentPostPublicFeedV1({
        schema_version: 1,
        jobs: [leakedJob],
      }),
      null,
    );
  }
});

test("parseListRecruitmentPostsQuery and projectRecruitmentPostListWithFacets validate include_facets and 3 facet fields fail-closed", () => {
  const defaultQuery = parseListRecruitmentPostsQuery(
    new URL("https://app.test/api/recruitment-posts"),
  );
  assert.equal(defaultQuery.ok, true);
  if (defaultQuery.ok) {
    assert.equal(defaultQuery.value.include_facets, false);
    assert.equal(defaultQuery.value.page_size, 15);
  }

  const explicitFalseQuery = parseListRecruitmentPostsQuery(
    new URL("https://app.test/api/recruitment-posts?include_facets=false&page_size=10"),
  );
  assert.equal(explicitFalseQuery.ok, true);
  if (explicitFalseQuery.ok) {
    assert.equal(explicitFalseQuery.value.include_facets, false);
    assert.equal(explicitFalseQuery.value.page_size, 10);
  }

  const trueQuery = parseListRecruitmentPostsQuery(
    new URL("https://app.test/api/recruitment-posts?include_facets=true&page_size=10"),
  );
  assert.equal(trueQuery.ok, true);
  if (trueQuery.ok) {
    assert.equal(trueQuery.value.include_facets, true);
    assert.equal(trueQuery.value.page_size, 10);
  }

  for (const invalidVal of ["", "1", "0", "yes", "TRUE"]) {
    assert.deepEqual(
      parseListRecruitmentPostsQuery(
        new URL(`https://app.test/api/recruitment-posts?include_facets=${invalidVal}`),
      ),
      { ok: false, code: "RECRUITMENT_POST_INPUT_INVALID" },
    );
  }

  const item = makeValidProjectedItem();
  const validWithFacets = {
    items: [item],
    page_size: 10,
    has_more: true,
    next_cursor: `C1.1.${FILTER_HASH}.1762761600123456.${BRIEF_ID}`,
    snapshot_token: `S1.1.${FILTER_HASH}`,
    total_count: 3,
    industrial_parks: [
      {
        industrial_park_id: PARK_ID,
        industrial_park_code: "VP_BA_THIEN_1",
        display_name: "KCN Bá Thiện 1",
        active: true,
        job_count: 3,
      },
    ],
    labor_types: [
      {
        labor_type_key: "CHINH_THUC",
        display_name: "Chính thức",
        job_count: 3,
      },
      {
        labor_type_key: "THOI_VU",
        display_name: "Thời vụ",
        job_count: 1,
      },
    ],
  };

  assert.deepEqual(
    projectRecruitmentPostListWithFacets(validWithFacets),
    validWithFacets,
  );
  // 8-key payload must NOT pass legacy 5-key parser, and 5-key payload must NOT pass 8-key parser
  assert.equal(projectRecruitmentPostList(validWithFacets), null);
  assert.equal(
    projectRecruitmentPostListWithFacets({
      items: [item],
      page_size: 10,
      has_more: false,
      next_cursor: null,
      snapshot_token: `S1.1.${FILTER_HASH}`,
    }),
    null,
  );

  // Empty state (total_count = 0 with two empty arrays) is valid
  const emptyWithFacets = {
    items: [],
    page_size: 10,
    has_more: false,
    next_cursor: null,
    snapshot_token: `S1.1.${FILTER_HASH}`,
    total_count: 0,
    industrial_parks: [],
    labor_types: [],
  };
  assert.deepEqual(
    projectRecruitmentPostListWithFacets(emptyWithFacets),
    emptyWithFacets,
  );

  // Reject active: false or job_count: 0 on industrial_parks facet, or mismatched total_count
  assert.equal(
    projectRecruitmentPostIndustrialParkFacet({
      ...validWithFacets.industrial_parks[0],
      active: false,
    }),
    null,
  );
  assert.equal(
    projectRecruitmentPostIndustrialParkFacet({
      ...validWithFacets.industrial_parks[0],
      job_count: 0,
    }),
    null,
  );
  assert.equal(
    projectRecruitmentPostLaborTypeFacet({
      ...validWithFacets.labor_types[0],
      job_count: 0,
    }),
    null,
  );
  assert.equal(
    projectRecruitmentPostListWithFacets({
      ...validWithFacets,
      total_count: 2,
    }),
    null,
  );
  assert.equal(
    projectRecruitmentPostListWithFacets({
      ...emptyWithFacets,
      total_count: 1,
    }),
    null,
  );

  // Vietnamese Intl.Collator("vi") sorting: decomposed Unicode 'KCN A\u0301n' sorts before 'KCN Ang',
  // 'KCN Điềm Thụy' sorts between 'KCN Bá Thiện I' and 'KCN Phú Hà', and duplicate display_name ties break by industrial_park_code
  const unsortedParksPayload = {
    items: [item],
    page_size: 10,
    has_more: false,
    next_cursor: null,
    snapshot_token: `S1.1.${FILTER_HASH}`,
    total_count: 6,
    industrial_parks: [
      {
        industrial_park_id: "10000000-0000-4000-8000-000000000305",
        industrial_park_code: "PT_PHU_HA",
        display_name: "KCN Phú Hà",
        active: true,
        job_count: 1,
      },
      {
        industrial_park_id: "10000000-0000-4000-8000-000000000302",
        industrial_park_code: "AA_ANG",
        display_name: "KCN Ang",
        active: true,
        job_count: 1,
      },
      {
        industrial_park_id: "10000000-0000-4000-8000-000000000304",
        industrial_park_code: "DIEM_THUY",
        display_name: "KCN Điềm Thụy",
        active: true,
        job_count: 1,
      },
      {
        industrial_park_id: "10000000-0000-4000-8000-000000000301",
        industrial_park_code: "ZZ_AN_NFD",
        display_name: "KCN A\u0301n",
        active: true,
        job_count: 1,
      },
      {
        industrial_park_id: "10000000-0000-4000-8000-000000000306",
        industrial_park_code: "AA_PHU_HA_TIE",
        display_name: "KCN Phú Hà",
        active: true,
        job_count: 1,
      },
      {
        industrial_park_id: "10000000-0000-4000-8000-000000000303",
        industrial_park_code: "VP_BA_THIEN_1",
        display_name: "KCN Bá Thiện I",
        active: true,
        job_count: 1,
      },
    ],
    labor_types: [
      {
        labor_type_key: "CHINH_THUC",
        display_name: "Chính thức",
        job_count: 6,
      },
    ],
  };

  const projectedSorted = projectRecruitmentPostListWithFacets(unsortedParksPayload);
  assert.ok(projectedSorted !== null);
  assert.deepEqual(
    projectedSorted.industrial_parks.map(
      (p) => `${p.display_name} (${p.industrial_park_code})`,
    ),
    [
      "KCN A\u0301n (ZZ_AN_NFD)",
      "KCN Ang (AA_ANG)",
      "KCN Bá Thiện I (VP_BA_THIEN_1)",
      "KCN Điềm Thụy (DIEM_THUY)",
      "KCN Phú Hà (AA_PHU_HA_TIE)",
      "KCN Phú Hà (PT_PHU_HA)",
    ],
  );
});
