import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PUBLIC_JOB_HOST,
  PUBLIC_JOB_ORIGIN,
  normalizePortalHost,
  portalRoute,
  resolvePortalProxyDecision,
} from "./host.ts";
import {
  jobDetail,
  jobList,
  jobLookupKey,
  parseJobsQuery,
} from "./jobs-contract.ts";

function source(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function makePublicJobRecord(overrides = {}) {
  const id = overrides.id ?? "11111111-2222-4333-8444-555555555555";
  const slug = overrides.public_slug ?? `cong-nhan-san-xuat-${id}`;
  return {
    id,
    brief_id: overrides.brief_id ?? id,
    public_slug: slug,
    version: 1,
    published_at: "2026-11-28T08:00:00.000000Z",
    updated_at: "2026-11-28T09:00:00.000000Z",
    location: {
      province_code: "VP",
      province_name: "Vĩnh Phúc",
      industrial_park_code: "VP_BA_THIEN_2",
      industrial_park_name: "KCN Bá Thiện 2",
      ...overrides.location,
    },
    general: {
      customer_name: "Công ty Điện tử ABC",
      investment_origin: "Nhật Bản",
      manufacturing_industry: "Linh kiện điện tử",
      job_description: "Lắp ráp linh kiện điện tử trong phòng sạch",
      environment_types: ["CLEAN_ROOM"],
      work_postures: ["SITTING"],
      shift_pattern: "TWO_SHIFTS",
      shift_details: "Ca ngày 08:00-20:00, ca đêm 20:00-08:00",
      labor_types: [{ labor_type_key: "CHINH_THUC", display_name: "Chính thức" }],
      supply_schedule_text: "Phỏng vấn thứ 2 - thứ 6",
      expected_headcount: 50,
      ...overrides.general,
    },
    candidate: {
      age_min: 18,
      age_max: 40,
      gender_requirement: "ANY",
      gender_label: "Nam/Nữ",
      education_requirement: "SECONDARY",
      experience_required: false,
      experience_details: null,
      accept_former_customer_workers: true,
      entry_assessment_text: null,
      other_requirements_text: null,
      ...overrides.candidate,
    },
    compensation: {
      base_salary_vnd: "5500000",
      base_salary_conditions: null,
      attendance_bonus_vnd: "500000",
      attendance_bonus_conditions: null,
      living_allowance_vnd: "400000",
      living_allowance_conditions: null,
      seniority_allowance_vnd: null,
      seniority_allowance_conditions: null,
      eyesight_allowance_vnd: null,
      eyesight_allowance_conditions: null,
      other_allowance_text: null,
      average_income_min_vnd: "8000000",
      average_income_max_vnd: "11000000",
      salary_payment_schedule: "Ngày 10 hàng tháng",
      salary_advance_available: true,
      salary_advance_amount_vnd: "2000000",
      salary_advance_schedule: "Thứ 6 hàng tuần",
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
      ppe_provided: true,
      ppe_details: "Áo chống tĩnh điện",
      other_benefits: "Hỗ trợ ăn ca",
      ...overrides.compensation,
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
      ...overrides.documents,
    },
  };
}

test("normalizePortalHost trims, strips scheme/path/port, lowercases, and returns null when empty", () => {
  assert.equal(PUBLIC_JOB_HOST, "vieclammienbac.com.vn");
  assert.equal(PUBLIC_JOB_ORIGIN, "https://vieclammienbac.com.vn");

  assert.equal(normalizePortalHost(null), null);
  assert.equal(normalizePortalHost(undefined), null);
  assert.equal(normalizePortalHost(""), null);
  assert.equal(normalizePortalHost("   "), null);
  assert.equal(normalizePortalHost("https://"), null);
  assert.equal(normalizePortalHost(":3000"), null);

  assert.equal(
    normalizePortalHost("  HTTPS://ViecLamMienBac.COM.VN:443/viec-lam?q=abc  "),
    "vieclammienbac.com.vn",
  );
  assert.equal(
    normalizePortalHost("http://PREVIEW.Example.COM:3000/portal"),
    "preview.example.com",
  );
  assert.equal(normalizePortalHost("LOCALHOST:3000"), "localhost");
});

test("portalRoute isolates public production/preview hosts from internal staff host", () => {
  // Public production host (including uppercase + port)
  for (const host of [PUBLIC_JOB_HOST, "ViecLamMienBac.COM.VN:443"]) {
    for (const p of [
      "/",
      "/viec-lam",
      "/viec-lam/",
      "/viec-lam/cong-nhan-123",
      "/viec-lam/cong-nhan-123/",
      "/gioi-thieu",
      "/gioi-thieu/",
      "/lien-he",
      "/lien-he/",
      "/robots.txt",
      "/sitemap.xml",
      "/sitemap/1",
      "/sitemap/25",
    ]) {
      assert.equal(portalRoute(host, p, undefined), "rewrite", `${host} ${p}`);
    }
    for (const p of [
      "/api/public/jobs",
      "/api/public/jobs/",
      "/api/public/jobs/cong-nhan-123",
      "/_next/static/chunks/app.js",
      "/brand/hrpartner-logo.png",
      "/favicon.ico",
    ]) {
      assert.equal(portalRoute(host, p, undefined), "public", `${host} ${p}`);
    }
    for (const p of [
      "/dashboard",
      "/login",
      "/admin",
      "/direct-entry",
      "/portal",
      "/portal/viec-lam",
      "/api/recruitment-posts",
      "/api/public/jobs/a/b",
      "/viec-lam/a/b",
      "/gioi-thieu/extra",
      "/lien-he/extra",
      "/sitemap/abc",
      "/sitemap/",
    ]) {
      assert.equal(portalRoute(host, p, undefined), "deny", `${host} ${p}`);
    }
  }

  // Preview hosts: single and comma-separated with URL/port/whitespace
  const previewEnv = "preview-1.example.com, https://PREVIEW-2.Example.Com:8443/viec-lam ";
  assert.equal(portalRoute("preview-1.example.com:3000", "/viec-lam", previewEnv), "rewrite");
  assert.equal(portalRoute("PREVIEW-2.example.com", "/gioi-thieu/", previewEnv), "rewrite");
  assert.equal(portalRoute("preview-2.example.com:443", "/dashboard", previewEnv), "deny");
  assert.equal(portalRoute("other.example.com", "/viec-lam", previewEnv), "deny");

  // Internal staff host blocks all public portal & public API paths, passes staff routes
  for (const host of ["bi.hrpartner.vn", "localhost:3000", null]) {
    for (const p of [
      "/portal",
      "/portal/viec-lam",
      "/viec-lam",
      "/viec-lam/cong-nhan-123",
      "/api/public/jobs",
      "/api/public/jobs/cong-nhan-123",
      "/api/public/jobs/extra/segment",
    ]) {
      assert.equal(portalRoute(host, p, previewEnv), "deny", `internal ${host} ${p}`);
    }
    for (const p of ["/", "/dashboard", "/login", "/admin", "/api/recruitment-posts"]) {
      assert.equal(portalRoute(host, p, previewEnv), "staff", `internal ${host} ${p}`);
    }
  }
});

test("resolvePortalProxyDecision enforces no-store, noindex on non-prod, rewrites, and 404 denies", () => {
  // Production public host: no X-Robots-Tag even with uppercase + port
  const prodRoot = resolvePortalProxyDecision({
    host: "ViecLamMienBac.COM.VN:443",
    path: "/",
    method: "GET",
    preview: undefined,
  });
  assert.deepEqual(prodRoot, {
    kind: "rewrite",
    rewritePathname: "/portal/viec-lam",
    headers: { "Cache-Control": "no-store" },
  });

  const prodDetail = resolvePortalProxyDecision({
    host: PUBLIC_JOB_HOST,
    path: "/viec-lam/cong-nhan-abc",
    method: "HEAD",
    preview: undefined,
  });
  assert.deepEqual(prodDetail, {
    kind: "rewrite",
    rewritePathname: "/portal/viec-lam/cong-nhan-abc",
    headers: { "Cache-Control": "no-store" },
  });

  // Preview host: always sets X-Robots-Tag: noindex, nofollow (even uppercase + port)
  const previewDetail = resolvePortalProxyDecision({
    host: "PREVIEW.Example.COM:3000",
    path: "/gioi-thieu/",
    method: "GET",
    preview: "preview.example.com",
  });
  assert.deepEqual(previewDetail, {
    kind: "rewrite",
    rewritePathname: "/portal/gioi-thieu/",
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });

  // Static assets on preview omit Cache-Control: no-store but keep noindex
  const previewStatic = resolvePortalProxyDecision({
    host: "PREVIEW.Example.COM",
    path: "/_next/static/chunks/main.js",
    method: "GET",
    preview: "preview.example.com",
  });
  assert.deepEqual(previewStatic, {
    kind: "next",
    headers: { "X-Robots-Tag": "noindex, nofollow" },
  });

  // Public API / brand assets on prod keep Cache-Control: no-store without noindex
  const prodApi = resolvePortalProxyDecision({
    host: PUBLIC_JOB_HOST,
    path: "/api/public/jobs",
    method: "GET",
    preview: undefined,
  });
  assert.deepEqual(prodApi, {
    kind: "next",
    headers: { "Cache-Control": "no-store" },
  });

  // Non-GET/HEAD methods and denied paths return 404 with no-store
  for (const denied of [
    { host: PUBLIC_JOB_HOST, path: "/viec-lam", method: "POST" },
    { host: PUBLIC_JOB_HOST, path: "/api/public/jobs", method: "DELETE" },
    { host: PUBLIC_JOB_HOST, path: "/dashboard", method: "GET" },
    { host: PUBLIC_JOB_HOST, path: "/portal/viec-lam", method: "GET" },
    { host: "bi.hrpartner.vn", path: "/viec-lam", method: "GET" },
    { host: "bi.hrpartner.vn", path: "/api/public/jobs", method: "GET" },
  ]) {
    assert.deepEqual(
      resolvePortalProxyDecision({ ...denied, preview: "preview.example.com" }),
      { kind: "deny", status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Internal staff route passes untouched
  assert.deepEqual(
    resolvePortalProxyDecision({
      host: "bi.hrpartner.vn",
      path: "/dashboard",
      method: "GET",
      preview: "preview.example.com",
    }),
    { kind: "staff" },
  );

  // Source invariant: src/proxy.ts delegates cleanly to resolvePortalProxyDecision
  const proxySrc = source("../../proxy.ts");
  assert.match(proxySrc, /resolvePortalProxyDecision/);
  assert.match(proxySrc, /NextResponse\.rewrite/);
  assert.match(proxySrc, /new NextResponse\(null,\s*\{\s*status:\s*decision\.status,\s*headers:\s*decision\.headers\s*\}\)/);
});

test("parseJobsQuery validates filters and rejects invalid or duplicate params", () => {
  assert.deepEqual(parseJobsQuery(new URLSearchParams()), {
    sort: "updated_desc",
    page: 1,
    page_size: 12,
  });

  assert.deepEqual(
    parseJobsQuery(
      new URLSearchParams(
        "q=%20%C4%91i%E1%BB%87n%20t%E1%BB%AD%20&province_code=VP&industrial_park_code=VP_BA_THIEN_2&labor_type_key=CHINH_THUC&shift_pattern=TWO_SHIFTS&gender_requirement=ANY&salary_advance_available=true&sort=published_desc&page=2&page_size=50",
      ),
    ),
    {
      q: "điện tử",
      province_code: "VP",
      industrial_park_code: "VP_BA_THIEN_2",
      labor_type_key: "CHINH_THUC",
      shift_pattern: "TWO_SHIFTS",
      gender_requirement: "ANY",
      salary_advance_available: "true",
      sort: "published_desc",
      page: 2,
      page_size: 50,
    },
  );

  // Rejects duplicate keys, unknown keys, out-of-range page_size, invalid values
  for (const raw of [
    "page=1&page=2",
    "q=a&q=b",
    "unexpected=1",
    "page=0",
    "page=abc",
    "page_size=51",
    "salary_advance_available=false",
    "sort=invalid",
    "province_code=lowercase",
    `q=${"a".repeat(121)}`,
  ]) {
    assert.equal(parseJobsQuery(new URLSearchParams(raw)), null, raw);
  }
});

test("jobLookupKey, jobList, and jobDetail enforce strict schemas and canonical slug binding", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const canonicalSlug = `cong-nhan-san-xuat-${id}`;

  assert.equal(jobLookupKey.test(canonicalSlug), true);
  assert.equal(jobLookupKey.test(`bi-${id}`), true);
  assert.equal(jobLookupKey.test("cong-nhan-alias"), true);
  assert.equal(jobLookupKey.test("Invalid_Slug"), false);
  assert.equal(jobLookupKey.test("a/b"), false);
  assert.equal(jobLookupKey.test("-leading"), false);

  const validItem = makePublicJobRecord({ id, public_slug: canonicalSlug });
  const parsedList = jobList.parse({
    items: [validItem],
    pagination: { page: 1, page_size: 12, total_count: 1, total_pages: 1 },
    facets: {
      total_published_count: 1,
      provinces: [
        { province_code: "VP", display_name: "Vĩnh Phúc", job_count: 1 },
        { province_code: "BG", display_name: "Bắc Giang", job_count: 2 },
      ],
      industrial_parks: [
        {
          industrial_park_code: "VP_BA_THIEN_2",
          province_code: "VP",
          display_name: "KCN Bá Thiện 2",
          job_count: 1,
        },
      ],
      labor_types: [{ labor_type_key: "CHINH_THUC", display_name: "Chính thức", job_count: 1 }],
    },
  });
  assert.deepEqual(
    parsedList.facets.provinces.map((p) => p.province_code),
    ["BG", "VP"],
  );

  // Strict top-level & nested object rejection
  assert.throws(() =>
    jobList.parse({
      items: [validItem],
      pagination: { page: 1, page_size: 12, total_count: 1, total_pages: 1 },
      facets: {
        total_published_count: 1,
        provinces: [],
        industrial_parks: [],
        labor_types: [],
      },
      extra_field: true,
    }),
  );

  // Rejects forbidden internal keys or unexpected properties on item
  assert.throws(() =>
    jobDetail.parse({
      match_status: "FOUND_CANONICAL",
      canonical_slug: canonicalSlug,
      item: { ...validItem, manager_phone: "0900000000" },
      related_items: [],
    }),
  );

  // Rejects mismatched canonical_slug vs item.public_slug or wrong brief_id suffix
  assert.throws(() =>
    jobDetail.parse({
      match_status: "FOUND_CANONICAL",
      canonical_slug: `other-slug-${id}`,
      item: validItem,
      related_items: [],
    }),
  );
  assert.throws(() =>
    jobDetail.parse({
      match_status: "FOUND_CANONICAL",
      canonical_slug: "cong-nhan-san-xuat-99999999-2222-4333-8444-555555555555",
      item: makePublicJobRecord({
        id,
        public_slug: "cong-nhan-san-xuat-99999999-2222-4333-8444-555555555555",
      }),
      related_items: [],
    }),
  );

  // Accepts FOUND_ALIAS when canonical_slug matches item.public_slug
  const aliasDetail = jobDetail.parse({
    match_status: "FOUND_ALIAS",
    canonical_slug: canonicalSlug,
    item: validItem,
    related_items: [],
  });
  assert.equal(aliasDetail.canonical_slug, canonicalSlug);
});

test("Mobile/Desktop 3D gating, offline tile guard, and withdrawn-404 invariants hold", () => {
  const explorerSrc = source("../../components/portal/spatial-explorer.tsx");
  assert.match(explorerSrc, /useState\(false\)/, "wide must default to false");
  assert.match(explorerSrc, /matchMedia\("\(min-width: 900px\)"\)/);
  assert.match(explorerSrc, /if\(!wide\|\|!enabled\|\|!jobs\.length\|\|unavailable\)return;/);
  assert.match(explorerSrc, /import\("\.\/spatial-scene"\)/);
  assert.match(explorerSrc, /Danh sách 2D/);
  assert.match(explorerSrc, /Mở bản đồ 3D/);
  assert.match(explorerSrc, /onFailure=\{\(\)=>setUnavailable\(true\)\}/);

  const engineSrc = source("./spatial/spatial-3d-engine.js");
  assert.match(engineSrc, /_buildMacroMapTileLayer\(\)\s*\{\s*if\s*\(!this\.tileOrigin\)\s*return;/);
  assert.match(
    engineSrc,
    /_loadKcnHighZoomMapCanvas\([^)]*\)\s*\{\s*if\s*\(!this\.tileOrigin\s*\|\|\s*!kcnRec\?\.mapPadState\)\s*return;/,
  );

  const detailPageSrc = source("../../app/portal/viec-lam/[slug]/page.tsx");
  assert.match(detailPageSrc, /if\s*\(!d\)\s*notFound\(\)/);
  assert.match(
    detailPageSrc,
    /if\s*\(d\.match_status==="FOUND_ALIAS"\|\|slug!==d\.canonical_slug\)\s*permanentRedirect\("\/viec-lam\/"\+d\.canonical_slug\)/,
  );
  assert.match(detailPageSrc, /try\s*\{[\s\S]*await get\(slug\)[\s\S]*\}\s*catch/);
  assert.match(detailPageSrc, /Chưa tải được tin tuyển dụng/);

  const notFoundSrc = source("../../app/portal/not-found.tsx");
  assert.match(notFoundSrc, /Tin tuyển dụng không còn hiển thị/);
  assert.match(notFoundSrc, /<a href="\/viec-lam">Xem việc làm đang tuyển<\/a>/);
  assert.doesNotMatch(notFoundSrc, /\/(?:dashboard|login|admin|direct-entry)/);
});
