import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyRecruitmentPostError,
  createRecruitmentPostRepository,
} from "./repository.ts";

const ACTOR = {
  auth_subject: "11111111-1111-4111-8111-111111111111",
  app_user_id: "22222222-2222-4222-8222-222222222222",
};
const BRIEF_ID = "33333333-3333-4333-8333-333333333333";
const PROVINCE_ID = "44444444-4444-4444-8444-444444444444";
const PARK_ID = "55555555-5555-4555-8555-555555555555";
const IDEM_KEY = "66666666-6666-4666-8666-666666666666";
const FILTER_HASH = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

const SAMPLE_CONTEXT = {
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
};

const SAMPLE_ITEM = {
  brief_id: BRIEF_ID,
  version: 1,
  status: "PUBLISHED",
  project: { project_id: "PROJ_A", display_name: "Dự án A" },
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
    customer_name: "Công ty A",
    investment_origin: null,
    manufacturing_industry: null,
    job_description: "Lắp ráp điện tử",
    environment_types: ["CLEAN_ROOM"],
    work_postures: ["STANDING"],
    shift_pattern: "TWO_SHIFTS",
    shift_details: null,
    manager_name: "Nguyễn Văn Quản Lý",
    manager_phone: "0912345678",
    labor_types: [{ labor_type_key: "CHINH_THUC", display_name: "Chính thức" }],
    supply_schedule_text: null,
    expected_headcount: 30,
  },
  candidate: {
    age_min: 18,
    age_max: 40,
    gender_requirement: "ANY",
    education_requirement: "NONE",
    experience_required: false,
    experience_details: null,
    accept_former_customer_workers: true,
    entry_assessment_text: null,
    other_requirements_text: null,
  },
  compensation: {
    base_salary_vnd: "6000000",
    base_salary_conditions: null,
    attendance_bonus_vnd: null,
    attendance_bonus_conditions: null,
    living_allowance_vnd: null,
    living_allowance_conditions: null,
    seniority_allowance_vnd: null,
    seniority_allowance_conditions: null,
    eyesight_allowance_vnd: null,
    eyesight_allowance_conditions: null,
    other_allowance_text: null,
    average_income_min_vnd: "9000000",
    average_income_max_vnd: "12000000",
    salary_payment_schedule: null,
    salary_advance_available: false,
    salary_advance_amount_vnd: null,
    salary_advance_schedule: null,
    weekly_salary_available: false,
    weekly_salary_payment_schedule: null,
    day_shift_8h_vnd: null,
    day_shift_11h_vnd: null,
    night_shift_8h_vnd: null,
    night_shift_11h_vnd: null,
    sunday_day_11h_vnd: null,
    sunday_night_11h_vnd: null,
    holiday_day_11h_vnd: null,
    holiday_night_11h_vnd: null,
    ppe_provided: false,
    ppe_details: null,
    other_benefits: null,
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
  allowed_actions: {
    can_edit: true,
    can_withdraw: true,
  },
};

test("classifyRecruitmentPostError maps explicit SQL message tokens and SQLSTATE fallbacks without ACTIVE_PAIR_EXISTS", () => {
  assert.equal(
    classifyRecruitmentPostError({
      code: "22023",
      message: "RECRUITMENT_POST_SNAPSHOT_INVALID",
    }),
    "RECRUITMENT_POST_SNAPSHOT_INVALID",
  );
  assert.equal(
    classifyRecruitmentPostError({
      code: "22023",
      message: "RECRUITMENT_POST_IDEMPOTENCY_INVALID",
    }),
    "RECRUITMENT_POST_IDEMPOTENCY_INVALID",
  );
  assert.equal(
    classifyRecruitmentPostError({
      code: "22023",
      message: "RECRUITMENT_POST_CONTENT_INVALID",
    }),
    "RECRUITMENT_POST_CONTENT_INVALID",
  );
  assert.equal(
    classifyRecruitmentPostError({
      code: "22023",
      message: "RECRUITMENT_POST_INPUT_INVALID",
    }),
    "RECRUITMENT_POST_INPUT_INVALID",
  );
  assert.equal(
    classifyRecruitmentPostError({
      code: "PT409",
      message: "RECRUITMENT_POST_ALREADY_WITHDRAWN",
    }),
    "RECRUITMENT_POST_ALREADY_WITHDRAWN",
  );
  assert.equal(
    classifyRecruitmentPostError({
      code: "PT409",
      message: "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT",
    }),
    "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(
    classifyRecruitmentPostError({
      code: "22023",
      message: "idempotency key reused with different input",
    }),
    "RECRUITMENT_POST_IDEMPOTENCY_CONFLICT",
  );
  assert.equal(
    classifyRecruitmentPostError({ code: "42501" }),
    "RECRUITMENT_POST_ACCESS_DENIED",
  );
  assert.equal(
    classifyRecruitmentPostError({ code: "P0002" }),
    "RECRUITMENT_POST_NOT_FOUND",
  );
  assert.equal(
    classifyRecruitmentPostError({ code: "PT409" }),
    "RECRUITMENT_POST_STALE",
  );
  assert.equal(
    classifyRecruitmentPostError({ code: "23514" }),
    "RECRUITMENT_POST_CONTENT_INVALID",
  );
  assert.equal(
    classifyRecruitmentPostError({ code: "23505" }),
    "RECRUITMENT_POST_UNAVAILABLE",
  );
});

test("createRecruitmentPostRepository calls all 7 RPCs with server-resolved actor and enforces fail-closed projection", async () => {
  const calls = [];
  const rpcResponses = {
    recruitment_post_get_context: SAMPLE_CONTEXT,
    recruitment_post_list: {
      items: [SAMPLE_ITEM],
      page_size: 15,
      has_more: false,
      next_cursor: null,
      snapshot_token: `S1.1.${FILTER_HASH}`,
    },
    recruitment_post_list_mine: {
      items: [
        SAMPLE_ITEM,
        {
          ...SAMPLE_ITEM,
          brief_id: "77777777-7777-4777-8777-777777777777",
          status: "WITHDRAWN",
          withdrawn_at: "2026-11-10T09:00:00.123456Z",
          withdrawn_by_display_name: "Nguyễn Văn A",
          allowed_actions: { can_edit: false, can_withdraw: false },
        },
      ],
      page_size: 15,
      has_more: false,
      next_cursor: null,
      snapshot_token: `S1.1.${FILTER_HASH}`,
    },
    recruitment_post_get: { post: SAMPLE_ITEM },
    recruitment_post_create: {
      post: SAMPLE_ITEM,
      changed: true,
      replayed: false,
    },
    recruitment_post_update: {
      post: { ...SAMPLE_ITEM, version: 2 },
      changed: true,
      replayed: false,
    },
    recruitment_post_withdraw: {
      post: {
        ...SAMPLE_ITEM,
        version: 3,
        status: "WITHDRAWN",
        withdrawn_at: "2026-11-10T09:00:00.123456Z",
        withdrawn_by_display_name: "Nguyễn Văn A",
        allowed_actions: { can_edit: false, can_withdraw: false },
      },
      changed: true,
      replayed: false,
    },
  };

  const repo = createRecruitmentPostRepository(async (name, args) => {
    calls.push([name, args]);
    return { data: rpcResponses[name], error: null };
  });

  const ctxRes = await repo.getContext(ACTOR);
  assert.equal(ctxRes.ok, true);

  const listRes = await repo.list({
    ...ACTOR,
    project_id: "PROJ_A",
    province_id: PROVINCE_ID,
    industrial_park_id: PARK_ID,
    labor_type_key: "CHINH_THUC",
    updated_from: "2026-11-01",
    updated_to: "2026-11-10",
    cursor: null,
    snapshot_token: null,
    page_size: 15,
  });
  assert.equal(listRes.ok, true);

  const listMineRes = await repo.listMine({
    ...ACTOR,
    cursor: null,
    snapshot_token: null,
    page_size: 15,
  });
  assert.equal(listMineRes.ok, true);
  if (listMineRes.ok) {
    assert.equal(listMineRes.data.items.length, 2);
    assert.equal(listMineRes.data.items[1].status, "WITHDRAWN");
  }

  const getRes = await repo.get({ ...ACTOR, brief_id: BRIEF_ID });
  assert.equal(getRes.ok, true);

  const createRes = await repo.create({
    ...ACTOR,
    payload: { project_id: "PROJ_A" },
    idempotency_key: IDEM_KEY,
  });
  assert.equal(createRes.ok, true);

  const updateRes = await repo.update({
    ...ACTOR,
    brief_id: BRIEF_ID,
    expected_version: 1,
    payload: {},
    idempotency_key: IDEM_KEY,
  });
  assert.equal(updateRes.ok, true);

  const withdrawRes = await repo.withdraw({
    ...ACTOR,
    brief_id: BRIEF_ID,
    expected_version: 2,
    idempotency_key: IDEM_KEY,
  });
  assert.equal(withdrawRes.ok, true);

  assert.deepEqual(
    calls.map(([name]) => name),
    Object.keys(rpcResponses),
  );
  assert.ok(
    calls.every(
      ([, args]) =>
        args.p_auth_subject === ACTOR.auth_subject &&
        args.p_app_user_id === ACTOR.app_user_id,
    ),
  );

  // Malformed projection fails closed with RECRUITMENT_POST_UNAVAILABLE
  const badRepo = createRecruitmentPostRepository(async () => ({
    data: { ...SAMPLE_CONTEXT, extra_field: true },
    error: null,
  }));
  assert.deepEqual(await badRepo.getContext(ACTOR), {
    ok: false,
    code: "RECRUITMENT_POST_UNAVAILABLE",
  });

  // Public feed RPC (`recruitment_post_public_feed_v1`) takes no actor args and validates public allowlist
  const publicFeedCalls = [];
  const publicJobItem = {
    id: BRIEF_ID,
    brief_id: BRIEF_ID,
    version: 1,
    published_at: SAMPLE_ITEM.published_at,
    updated_at: SAMPLE_ITEM.updated_at,
    location: {
      province_code: SAMPLE_ITEM.province.province_code,
      province_name: SAMPLE_ITEM.province.display_name,
      industrial_park_code: SAMPLE_ITEM.industrial_park.industrial_park_code,
      industrial_park_name: SAMPLE_ITEM.industrial_park.display_name,
    },
    general: {
      customer_name: SAMPLE_ITEM.general.customer_name,
      investment_origin: SAMPLE_ITEM.general.investment_origin,
      manufacturing_industry: SAMPLE_ITEM.general.manufacturing_industry,
      job_description: SAMPLE_ITEM.general.job_description,
      environment_types: SAMPLE_ITEM.general.environment_types,
      work_postures: SAMPLE_ITEM.general.work_postures,
      shift_pattern: SAMPLE_ITEM.general.shift_pattern,
      shift_details: SAMPLE_ITEM.general.shift_details,
      labor_types: SAMPLE_ITEM.general.labor_types,
      supply_schedule_text: SAMPLE_ITEM.general.supply_schedule_text,
      expected_headcount: SAMPLE_ITEM.general.expected_headcount,
    },
    candidate: {
      ...SAMPLE_ITEM.candidate,
      gender_label: "Nam/Nữ",
    },
    compensation: SAMPLE_ITEM.compensation,
    documents: SAMPLE_ITEM.documents,
  };
  const publicRepo = createRecruitmentPostRepository(async (name, args) => {
    publicFeedCalls.push([name, args]);
    return {
      data: { schema_version: 1, jobs: [publicJobItem] },
      error: null,
    };
  });
  const publicFeedRes = await publicRepo.listPublicFeedV1();
  assert.equal(publicFeedRes.ok, true);
  assert.deepEqual(publicFeedCalls, [["recruitment_post_public_feed_v1", {}]]);

  // list({ include_facets: true }) calls recruitment_post_list_with_facets in a single RPC call
  const facetsCalls = [];
  const facetsPayload = {
    items: [SAMPLE_ITEM],
    page_size: 10,
    has_more: false,
    next_cursor: null,
    snapshot_token: `S1.1.${FILTER_HASH}`,
    total_count: 1,
    industrial_parks: [
      {
        industrial_park_id: PARK_ID,
        industrial_park_code: "VP_BA_THIEN_1",
        display_name: "KCN Bá Thiện 1",
        active: true,
        job_count: 1,
      },
    ],
    labor_types: [
      {
        labor_type_key: "CHINH_THUC",
        display_name: "Chính thức",
        job_count: 1,
      },
    ],
  };
  const facetsRepo = createRecruitmentPostRepository(async (name, args) => {
    facetsCalls.push([name, args]);
    return { data: facetsPayload, error: null };
  });
  const facetsRes = await facetsRepo.list({
    ...ACTOR,
    project_id: null,
    province_id: null,
    industrial_park_id: PARK_ID,
    labor_type_key: "CHINH_THUC",
    updated_from: null,
    updated_to: null,
    cursor: null,
    snapshot_token: null,
    page_size: 10,
    include_facets: true,
  });
  assert.equal(facetsRes.ok, true);
  assert.equal(facetsCalls.length, 1);
  assert.equal(facetsCalls[0][0], "recruitment_post_list_with_facets");
  assert.equal(facetsCalls[0][1].p_page_size, 10);
  if (facetsRes.ok && "total_count" in facetsRes.data) {
    assert.equal(facetsRes.data.total_count, 1);
    assert.equal(facetsRes.data.industrial_parks.length, 1);
    assert.equal(facetsRes.data.labor_types.length, 1);
  }
});
