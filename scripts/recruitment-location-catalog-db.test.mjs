/**
 * Phase 1 — Recruitment Location Catalog Foundation (`administrative_provinces` & `industrial_parks`)
 * PGlite Database Acceptance & Regression Suite.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PGlite } from "@electric-sql/pglite";
import { canManageRecruitmentLocations } from "../src/lib/recruitment-locations/location-catalog-contract.ts";
import { AUTH_PROLOGUE } from "./lib/s04c-read-fixture.mjs";
import {
  RECRUITMENT_LOCATION_CATALOG_MIGRATION_NAME,
  RECRUITMENT_LOCATION_CATALOG_RPC_SIGNATURES,
} from "./lib/migration-validation.mjs";

const MIGRATION_DIR = path.resolve("supabase/migrations");

const NOBITA_ADMIN = {
  auth: "10000000-0000-4000-8000-0000000000c1",
  app: "20000000-0000-4000-8000-0000000000c1",
  email: "nobita6986@gmail.com",
  display_name: "Nobita Admin",
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: ["all"],
};

const LIENVU_BOD = {
  auth: "10000000-0000-4000-8000-0000000000c2",
  app: "20000000-0000-4000-8000-0000000000c2",
  email: "lienvu@hrpartner.vn",
  display_name: "Lien Vu BOD (Privileged Edit)",
  capabilities: ["entry_privileged_edit"],
  scopes: ["all"],
};

const BOD_EXECUTIVE_REPORTS = {
  auth: "10000000-0000-4000-8000-0000000000c3",
  app: "20000000-0000-4000-8000-0000000000c3",
  email: "bod.reports@hrpartner.vn",
  display_name: "BOD Executive Reports",
  capabilities: ["report_analytics_view", "report_view"],
  scopes: ["all"],
};

const CATALOG_OPERATOR = {
  auth: "10000000-0000-4000-8000-0000000000c4",
  app: "20000000-0000-4000-8000-0000000000c4",
  email: "catalog.op@hrpartner.vn",
  display_name: "Catalog Operator",
  capabilities: ["catalog_master_manage"],
  scopes: ["all"],
};

const PM_USER = {
  auth: "10000000-0000-4000-8000-0000000000c5",
  app: "20000000-0000-4000-8000-0000000000c5",
  email: "pm.user@hrpartner.vn",
  display_name: "Project Manager",
  capabilities: ["change_request_create"],
  scopes: ["own"],
};

const TEAM_LEADER = {
  auth: "10000000-0000-4000-8000-0000000000c6",
  app: "20000000-0000-4000-8000-0000000000c6",
  email: "leader.user@hrpartner.vn",
  display_name: "Team Leader",
  capabilities: [
    "entry_team",
    "team_manager_assign",
    "report_analytics_view",
    "report_view",
  ],
  scopes: ["team"],
};

const REGULAR_STAFF = {
  auth: "10000000-0000-4000-8000-0000000000c7",
  app: "20000000-0000-4000-8000-0000000000c7",
  email: "staff.user@hrpartner.vn",
  display_name: "Regular Staff",
  capabilities: ["submission_create", "entry_own"],
  scopes: ["own"],
};

const ADMIN_TRIPLE_TEAM_ONLY = {
  auth: "10000000-0000-4000-8000-0000000000c8",
  app: "20000000-0000-4000-8000-0000000000c8",
  email: "admin.team@hrpartner.vn",
  display_name: "Full Admin Triple Without All Scope",
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: ["team"],
};

const DISABLED_ADMIN = {
  auth: "10000000-0000-4000-8000-0000000000c9",
  app: "20000000-0000-4000-8000-0000000000c9",
  email: "disabled.admin@hrpartner.vn",
  display_name: "Disabled Admin",
  enabled: false,
  capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
  scopes: ["all"],
};

const REVIEWER_PROJECT_ADMIN = {
  auth: "10000000-0000-4000-8000-0000000000ca",
  app: "20000000-0000-4000-8000-0000000000ca",
  email: "reviewer.admin@hrpartner.vn",
  display_name: "Reviewer + Project Admin",
  capabilities: ["entry_admin", "change_review"],
  scopes: ["all"],
};

const WORKER_HISTORY_VIEWER = {
  auth: "10000000-0000-4000-8000-0000000000cb",
  app: "20000000-0000-4000-8000-0000000000cb",
  email: "history.viewer@hrpartner.vn",
  display_name: "Worker Edit History Viewer",
  capabilities: ["worker_edit_history_view"],
  scopes: ["all"],
};

const BOD_PRIVILEGED_TEAM_ONLY = {
  auth: "10000000-0000-4000-8000-0000000000cc",
  app: "20000000-0000-4000-8000-0000000000cc",
  email: "bod.priv.team@hrpartner.vn",
  display_name: "BOD Privileged Team Only",
  capabilities: ["entry_privileged_edit"],
  scopes: ["team"],
};

const ANALYTICS_ONLY = {
  auth: "10000000-0000-4000-8000-0000000000cd",
  app: "20000000-0000-4000-8000-0000000000cd",
  email: "analytics.only@hrpartner.vn",
  display_name: "Analytics Only Viewer",
  capabilities: ["report_analytics_view"],
  scopes: ["all"],
};

const REPORT_VIEW_ONLY = {
  auth: "10000000-0000-4000-8000-0000000000ce",
  app: "20000000-0000-4000-8000-0000000000ce",
  email: "report.view.only@hrpartner.vn",
  display_name: "Report View Only Viewer",
  capabilities: ["report_view"],
  scopes: ["all"],
};

const TEAM_FIXTURE_ID = "94000000-0000-4000-8000-0000000000e1";
const KEY = (suffix) => `40000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const RPC_PARAMS = {
  administrative_province_list_admin: [
    "p_auth_subject",
    "p_app_user_id",
    "p_search",
    "p_include_inactive",
    "p_page",
    "p_page_size",
  ],
  administrative_province_create_admin: [
    "p_auth_subject",
    "p_app_user_id",
    "p_expected_version",
    "p_province_code",
    "p_display_name",
    "p_reason",
    "p_idempotency_key",
  ],
  administrative_province_update_admin: [
    "p_auth_subject",
    "p_app_user_id",
    "p_province_id",
    "p_expected_version",
    "p_display_name",
    "p_reason",
    "p_idempotency_key",
  ],
  administrative_province_set_active_admin: [
    "p_auth_subject",
    "p_app_user_id",
    "p_province_id",
    "p_active",
    "p_expected_version",
    "p_reason",
    "p_idempotency_key",
  ],
  industrial_park_list_admin: [
    "p_auth_subject",
    "p_app_user_id",
    "p_province_id",
    "p_search",
    "p_include_inactive",
    "p_page",
    "p_page_size",
  ],
  industrial_park_create_admin: [
    "p_auth_subject",
    "p_app_user_id",
    "p_expected_version",
    "p_industrial_park_code",
    "p_province_id",
    "p_display_name",
    "p_reason",
    "p_idempotency_key",
  ],
  industrial_park_update_admin: [
    "p_auth_subject",
    "p_app_user_id",
    "p_industrial_park_id",
    "p_expected_version",
    "p_province_id",
    "p_display_name",
    "p_reason",
    "p_idempotency_key",
  ],
  industrial_park_set_active_admin: [
    "p_auth_subject",
    "p_app_user_id",
    "p_industrial_park_id",
    "p_active",
    "p_expected_version",
    "p_reason",
    "p_idempotency_key",
  ],
};

async function createDatabase() {
  const db = new PGlite();
  await db.exec(AUTH_PROLOGUE);
  const names = (await readdir(MIGRATION_DIR))
    .filter((name) => name.endsWith(".sql") && name <= "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql")
    .sort();
  assert.ok(
    names.includes(RECRUITMENT_LOCATION_CATALOG_MIGRATION_NAME),
    `Expected migration ${RECRUITMENT_LOCATION_CATALOG_MIGRATION_NAME}`,
  );
  for (const name of names) {
    await db.exec(await readFile(path.join(MIGRATION_DIR, name), "utf8"));
  }
  return db;
}

async function rpc(db, name, args = {}) {
  const order = RPC_PARAMS[name];
  assert.ok(order, `unknown rpc ${name}`);
  const values = order.map((key) => {
    if (key in args) return args[key];
    if (key === "p_page") return 1;
    if (key === "p_page_size") return 50;
    if (key === "p_include_inactive") return true;
    return null;
  });
  const placeholders = order.map((_, index) => `$${index + 1}`).join(", ");
  const { rows } = await db.query(
    `select public.${name}(${placeholders}) as result`,
    values,
  );
  return rows[0].result;
}

async function rpcError(db, name, args = {}) {
  try {
    await rpc(db, name, args);
    return null;
  } catch (error) {
    return { code: error.code, message: error.message };
  }
}

async function addActor(db, actor) {
  await db.query("insert into auth.users (id, email) values ($1::uuid, $2)", [
    actor.auth,
    actor.email,
  ]);
  await db.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, enabled, display_name)
     values ($1::uuid, $2::uuid, $3, $4)`,
    [actor.app, actor.auth, actor.enabled !== false, actor.display_name],
  );
  for (const capability of actor.capabilities ?? []) {
    await db.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2020-01-01', true)`,
      [actor.app, capability],
    );
  }
  for (const kind of actor.scopes ?? []) {
    await db.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, $2, $3::uuid, '2020-01-01', true)`,
      [actor.app, kind, kind === "team" ? TEAM_FIXTURE_ID : null],
    );
  }
}

const db = await createDatabase();
await db.exec(
  `insert into public.teams (team_id, code, display_name, active)
   values ('${TEAM_FIXTURE_ID}', 'TEAM_LOC_FIX', 'Team Location Fixture', true)
   on conflict (team_id) do nothing;`,
);

const ALL_PERSONAS = [
  NOBITA_ADMIN,
  LIENVU_BOD,
  BOD_EXECUTIVE_REPORTS,
  CATALOG_OPERATOR,
  PM_USER,
  TEAM_LEADER,
  REGULAR_STAFF,
  ADMIN_TRIPLE_TEAM_ONLY,
  DISABLED_ADMIN,
  REVIEWER_PROJECT_ADMIN,
  WORKER_HISTORY_VIEWER,
  BOD_PRIVILEGED_TEAM_ONLY,
  ANALYTICS_ONLY,
  REPORT_VIEW_ONLY,
];

for (const actor of ALL_PERSONAS) {
  await addActor(db, actor);
}

test("1. Seed verification & schema purity: 4 provinces and 13 industrial parks are seeded idempotently with zero out-of-scope columns", async () => {
  const provinceList = await rpc(db, "administrative_province_list_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_include_inactive: true,
    p_search: null,
  });

  assert.equal(provinceList.provinces.length, 4);
  assert.equal(provinceList.total, 4);
  const byCode = Object.fromEntries(
    provinceList.provinces.map((item) => [item.province_code, item]),
  );
  assert.deepEqual(
    Object.keys(byCode).sort(),
    ["BAC_GIANG", "HOA_BINH", "PHU_THO", "VINH_PHUC"],
  );
  assert.equal(byCode.VINH_PHUC.display_name, "Vĩnh Phúc");
  assert.equal(byCode.VINH_PHUC.normalized_key, "vinhphuc");
  assert.equal(byCode.VINH_PHUC.industrial_park_count, 6);
  assert.equal(byCode.PHU_THO.display_name, "Phú Thọ");
  assert.equal(byCode.PHU_THO.normalized_key, "phutho");
  assert.equal(byCode.PHU_THO.industrial_park_count, 3);
  assert.equal(byCode.HOA_BINH.display_name, "Hòa Bình");
  assert.equal(byCode.HOA_BINH.normalized_key, "hoabinh");
  assert.equal(byCode.HOA_BINH.industrial_park_count, 1);
  assert.equal(byCode.BAC_GIANG.display_name, "Bắc Giang");
  assert.equal(byCode.BAC_GIANG.normalized_key, "bacgiang");
  assert.equal(byCode.BAC_GIANG.industrial_park_count, 3);

  const parkList = await rpc(db, "industrial_park_list_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_province_id: null,
    p_include_inactive: true,
    p_search: null,
  });
  assert.equal(parkList.industrial_parks.length, 13);
  assert.equal(parkList.total, 13);

  const expectedParks = [
    ["VP_BA_THIEN_1", "VINH_PHUC", "KCN Bá Thiện 1", "bathien1"],
    ["VP_BA_THIEN_2", "VINH_PHUC", "KCN Bá Thiện 2", "bathien2"],
    ["VP_BINH_XUYEN_1", "VINH_PHUC", "KCN Bình Xuyên 1", "binhxuyen1"],
    ["VP_BINH_XUYEN_2", "VINH_PHUC", "KCN Bình Xuyên 2", "binhxuyen2"],
    ["VP_KHAI_QUANG", "VINH_PHUC", "KCN Khai Quang", "khaiquang"],
    ["VP_THANG_LONG_3", "VINH_PHUC", "KCN Thăng Long 3", "thanglong3"],
    ["PT_PHU_HA", "PHU_THO", "KCN Phú Hà", "phuha"],
    ["PT_CAM_KHE", "PHU_THO", "KCN Cẩm Khê", "camkhe"],
    ["PT_THUY_VAN", "PHU_THO", "KCN Thụy Vân", "thuyvan"],
    ["HB_LUONG_SON", "HOA_BINH", "KCN Lương Sơn", "luongson"],
    ["BG_QUANG_CHAU", "BAC_GIANG", "KCN Quang Châu", "quangchau"],
    ["BG_DINH_TRAM", "BAC_GIANG", "KCN Đình Trám", "dinhtram"],
    ["BG_VAN_TRUNG", "BAC_GIANG", "KCN Vân Trung", "vantrung"],
  ];
  const parksByCode = Object.fromEntries(
    parkList.industrial_parks.map((item) => [item.industrial_park_code, item]),
  );
  for (const [code, provinceCode, displayName, normalizedKey] of expectedParks) {
    assert.ok(parksByCode[code], `missing seeded park ${code}`);
    assert.equal(parksByCode[code].province_code, provinceCode);
    assert.equal(parksByCode[code].display_name, displayName);
    assert.equal(parksByCode[code].normalized_key, normalizedKey);
    assert.equal(parksByCode[code].active, true);
    assert.equal(parksByCode[code].version, 1);
  }

  // Verify no out-of-scope columns exist (no address, coordinates, radius, attendance branch, or project link)
  const { rows: columnRows } = await db.query(
    `select table_name, column_name
       from information_schema.columns
      where table_schema = 'public'
        and table_name in ('administrative_provinces', 'industrial_parks')`,
  );
  const forbiddenFragments = [
    "address",
    "lat",
    "lng",
    "lon",
    "coord",
    "radius",
    "branch",
    "project_id",
  ];
  for (const row of columnRows) {
    for (const fragment of forbiddenFragments) {
      assert.equal(
        row.column_name.includes(fragment),
        false,
        `Unexpected out-of-scope column ${row.table_name}.${row.column_name}`,
      );
    }
  }
});

test("2. Normalization & duplicate protection: Khai Quang / KHAIQUANG / KCN Khai Quang / Khu công nghiệp Khai-Quang collide in the same province, while Roman vs Arabic numerals and cross-province keys succeed", async () => {
  const { rows: normRows } = await db.query(
    `select
       public.industrial_park_normalize_key('Khai Quang') as k1,
       public.industrial_park_normalize_key('KHAIQUANG') as k2,
       public.industrial_park_normalize_key('KCN Khai Quang') as k3,
       public.industrial_park_normalize_key('Khu công nghiệp Khai-Quang') as k4,
       public.industrial_park_normalize_key('Thăng Long 3') as tl_arabic,
       public.industrial_park_normalize_key('Thăng Long III') as tl_roman,
       public.administrative_province_normalize_key('Tỉnh Vĩnh Phúc') as vp1,
       public.administrative_province_normalize_key('Vĩnh-Phúc') as vp2`,
  );
  assert.equal(normRows[0].k1, "khaiquang");
  assert.equal(normRows[0].k2, "khaiquang");
  assert.equal(normRows[0].k3, "khaiquang");
  assert.equal(normRows[0].k4, "khaiquang");
  assert.equal(normRows[0].tl_arabic, "thanglong3");
  assert.equal(normRows[0].tl_roman, "thanglongiii");
  assert.notEqual(normRows[0].tl_arabic, normRows[0].tl_roman);
  assert.equal(normRows[0].vp1, "vinhphuc");
  assert.equal(normRows[0].vp2, "vinhphuc");

  const provinceList = await rpc(db, "administrative_province_list_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_include_inactive: true,
    p_search: null,
  });
  const vinhPhuc = provinceList.provinces.find(
    (item) => item.province_code === "VINH_PHUC",
  );
  const phuTho = provinceList.provinces.find(
    (item) => item.province_code === "PHU_THO",
  );
  assert.ok(vinhPhuc && phuTho);

  let idx = 10;
  for (const duplicateName of [
    "Khai Quang",
    "KHAIQUANG",
    "KCN Khai Quang",
    "Khu công nghiệp Khai-Quang",
  ]) {
    idx += 1;
    const err = await rpcError(db, "industrial_park_create_admin", {
      p_auth_subject: NOBITA_ADMIN.auth,
      p_app_user_id: NOBITA_ADMIN.app,
      p_expected_version: 0,
      p_province_id: vinhPhuc.province_id,
      p_industrial_park_code: `VP_DUP_${idx}`,
      p_display_name: duplicateName,
      p_reason: "Test duplicate normalization",
      p_idempotency_key: KEY(idx),
    });
    assert.ok(err, `Expected duplicate rejection for "${duplicateName}"`);
    assert.equal(err.code, "23505");
  }

  // Creating "Khai Quang" in a different province (Phú Thọ) succeeds because unique is (province_id, normalized_key)
  const crossProvinceCreate = await rpc(db, "industrial_park_create_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_expected_version: 0,
    p_province_id: phuTho.province_id,
    p_industrial_park_code: "PT_KHAI_QUANG",
    p_display_name: "KCN Khai Quang",
    p_reason: "Cross-province same normalized_key is allowed",
    p_idempotency_key: KEY(25),
  });
  assert.equal(crossProvinceCreate.created, true);
  assert.equal(crossProvinceCreate.normalized_key, "khaiquang");
  assert.equal(crossProvinceCreate.province_code, "PHU_THO");
});

test("3. Authority boundaries: strictly Full Admin triple, BOD (entry_privileged_edit), and BOD (report_analytics_view + report_view) with all scope succeed; missing all scope, Catalog Operator, Reviewer, Worker History Viewer, PM, Team Leader, regular staff, and disabled admin fail closed with 42501, and UI/API predicate matches SQL", async () => {
  const allowedActors = [NOBITA_ADMIN, LIENVU_BOD, BOD_EXECUTIVE_REPORTS];
  const deniedActors = [
    CATALOG_OPERATOR,
    REVIEWER_PROJECT_ADMIN,
    WORKER_HISTORY_VIEWER,
    ANALYTICS_ONLY,
    REPORT_VIEW_ONLY,
    PM_USER,
    TEAM_LEADER,
    REGULAR_STAFF,
    ADMIN_TRIPLE_TEAM_ONLY,
    BOD_PRIVILEGED_TEAM_ONLY,
    DISABLED_ADMIN,
  ];

  for (const allowedActor of allowedActors) {
    assert.equal(
      canManageRecruitmentLocations({
        capabilities: allowedActor.capabilities,
        scopes: allowedActor.scopes.map((kind) => ({ kind })),
      }),
      true,
      `Expected canManageRecruitmentLocations=true for ${allowedActor.email}`,
    );

    const { rows: boolRows } = await db.query(
      "select public.recruitment_location_is_admin_or_bod($1::uuid) as allowed",
      [allowedActor.app],
    );
    assert.equal(boolRows[0].allowed, true);

    const res = await rpc(db, "administrative_province_list_admin", {
      p_auth_subject: allowedActor.auth,
      p_app_user_id: allowedActor.app,
      p_include_inactive: true,
      p_search: null,
    });
    assert.ok(res.provinces.length >= 4);
  }

  for (const deniedActor of deniedActors) {
    if (deniedActor.enabled !== false) {
      assert.equal(
        canManageRecruitmentLocations({
          capabilities: deniedActor.capabilities,
          scopes: deniedActor.scopes.map((kind) => ({ kind })),
        }),
        false,
        `Expected canManageRecruitmentLocations=false for ${deniedActor.email}`,
      );

      const { rows: boolRows } = await db.query(
        "select public.recruitment_location_is_admin_or_bod($1::uuid) as allowed",
        [deniedActor.app],
      );
      assert.equal(
        boolRows[0].allowed,
        false,
        `Expected SQL recruitment_location_is_admin_or_bod=false for ${deniedActor.email}`,
      );
    }

    const listErr = await rpcError(db, "administrative_province_list_admin", {
      p_auth_subject: deniedActor.auth,
      p_app_user_id: deniedActor.app,
      p_include_inactive: true,
      p_search: null,
    });
    assert.ok(listErr, `Expected 42501 for ${deniedActor.email} on province list`);
    assert.equal(listErr.code, "42501");

    const createErr = await rpcError(
      db,
      "administrative_province_create_admin",
      {
        p_auth_subject: deniedActor.auth,
        p_app_user_id: deniedActor.app,
        p_expected_version: 0,
        p_province_code: "BAC_NINH",
        p_display_name: "Bắc Ninh",
        p_reason: "Unauthorized create attempt",
        p_idempotency_key: KEY(30),
      },
    );
    assert.ok(createErr, `Expected 42501 for ${deniedActor.email} on province create`);
    assert.equal(createErr.code, "42501");
  }

  // Mismatched auth_subject and app_user_id fails with 42501
  const mismatchErr = await rpcError(db, "industrial_park_list_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: LIENVU_BOD.app,
    p_province_id: null,
    p_include_inactive: true,
    p_search: null,
  });
  assert.ok(mismatchErr);
  assert.equal(mismatchErr.code, "42501");
});

test("4. Lifecycle, OCC expected_version, idempotency replay/conflict, soft deactivate, and append-only revisions/audit events", async () => {
  // Create province by LienVu BOD
  const createdProv = await rpc(db, "administrative_province_create_admin", {
    p_auth_subject: LIENVU_BOD.auth,
    p_app_user_id: LIENVU_BOD.app,
    p_expected_version: 0,
    p_province_code: "BAC_NINH",
    p_display_name: "Tỉnh Bắc Ninh",
    p_reason: "Add Bac Ninh province",
    p_idempotency_key: KEY(40),
  });
  assert.equal(createdProv.created, true);
  assert.equal(createdProv.province_code, "BAC_NINH");
  assert.equal(createdProv.display_name, "Tỉnh Bắc Ninh");
  assert.equal(createdProv.normalized_key, "bacninh");
  assert.equal(createdProv.version, 1);

  // Idempotent replay with same key & input returns identical result without creating extra revisions
  const replayedProv = await rpc(db, "administrative_province_create_admin", {
    p_auth_subject: LIENVU_BOD.auth,
    p_app_user_id: LIENVU_BOD.app,
    p_expected_version: 0,
    p_province_code: "BAC_NINH",
    p_display_name: "Tỉnh Bắc Ninh",
    p_reason: "Add Bac Ninh province",
    p_idempotency_key: KEY(40),
  });
  assert.deepEqual(replayedProv, createdProv);

  // Reusing same idempotency_key with different input fails with 22023
  const idemMismatchErr = await rpcError(
    db,
    "administrative_province_create_admin",
    {
      p_auth_subject: LIENVU_BOD.auth,
      p_app_user_id: LIENVU_BOD.app,
      p_expected_version: 0,
      p_province_code: "HAI_DUONG",
      p_display_name: "Hải Dương",
      p_reason: "Add Hai Duong",
      p_idempotency_key: KEY(40),
    },
  );
  assert.ok(idemMismatchErr);
  assert.equal(idemMismatchErr.code, "22023");
  assert.equal(
    idemMismatchErr.message,
    "idempotency key reused with different input",
  );

  // Update province by BOD_EXECUTIVE_REPORTS
  const updatedProv = await rpc(db, "administrative_province_update_admin", {
    p_auth_subject: BOD_EXECUTIVE_REPORTS.auth,
    p_app_user_id: BOD_EXECUTIVE_REPORTS.app,
    p_province_id: createdProv.province_id,
    p_expected_version: 1,
    p_display_name: "Bắc Ninh",
    p_reason: "Shorten province display name",
    p_idempotency_key: KEY(41),
  });
  assert.equal(updatedProv.display_name, "Bắc Ninh");
  assert.equal(updatedProv.normalized_key, "bacninh");
  assert.equal(updatedProv.version, 2);

  // Stale expected_version on update raises 40001
  const staleErr = await rpcError(db, "administrative_province_update_admin", {
    p_auth_subject: BOD_EXECUTIVE_REPORTS.auth,
    p_app_user_id: BOD_EXECUTIVE_REPORTS.app,
    p_province_id: createdProv.province_id,
    p_expected_version: 1,
    p_display_name: "Bắc Ninh Stale",
    p_reason: null,
    p_idempotency_key: KEY(42),
  });
  assert.ok(staleErr);
  assert.equal(staleErr.code, "40001");

  // Soft deactivate province
  const deactivatedProv = await rpc(
    db,
    "administrative_province_set_active_admin",
    {
      p_auth_subject: NOBITA_ADMIN.auth,
      p_app_user_id: NOBITA_ADMIN.app,
      p_province_id: createdProv.province_id,
      p_active: false,
      p_expected_version: 2,
      p_reason: "Temporarily pause Bac Ninh",
      p_idempotency_key: KEY(43),
    },
  );
  assert.equal(deactivatedProv.active, false);
  assert.equal(deactivatedProv.version, 3);

  // Active-only list excludes deactivated province; include_inactive=true includes it
  const activeOnly = await rpc(db, "administrative_province_list_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_include_inactive: false,
    p_search: "Bắc Ninh",
  });
  assert.equal(activeOnly.provinces.length, 0);

  const withInactive = await rpc(db, "administrative_province_list_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_include_inactive: true,
    p_search: "Bắc Ninh",
  });
  assert.equal(withInactive.provinces.length, 1);
  assert.equal(withInactive.provinces[0].active, false);

  // Verify revisions & audit events
  const { rows: revRows } = await db.query(
    `select version, action, (after_snapshot->>'active')::boolean as active
       from public.administrative_province_revisions
      where province_id = $1::uuid
      order by version asc`,
    [createdProv.province_id],
  );
  assert.deepEqual(
    revRows.map((r) => [r.version, r.action, r.active]),
    [
      [1, "CREATE", true],
      [2, "UPDATE", true],
      [3, "SET_ACTIVE", false],
    ],
  );

  // Hard delete on master and revision tables is blocked by trigger
  await assert.rejects(
    () =>
      db.query(
        "delete from public.administrative_provinces where province_id = $1::uuid",
        [createdProv.province_id],
      ),
    /cannot be deleted/,
  );
  await assert.rejects(
    () =>
      db.query(
        "delete from public.administrative_province_revisions where province_id = $1::uuid",
        [createdProv.province_id],
      ),
    /append-only/,
  );
});

test("5. Moving an industrial park to another province with a conflicting normalized_key fails with 23505 and rolls back atomically", async () => {
  const provinceList = await rpc(db, "administrative_province_list_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_include_inactive: true,
    p_search: null,
  });
  const vinhPhuc = provinceList.provinces.find(
    (item) => item.province_code === "VINH_PHUC",
  );
  const hoaBinh = provinceList.provinces.find(
    (item) => item.province_code === "HOA_BINH",
  );
  assert.ok(vinhPhuc && hoaBinh);

  // Create "Khai Quang" in Hòa Bình
  const hbPark = await rpc(db, "industrial_park_create_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_expected_version: 0,
    p_province_id: hoaBinh.province_id,
    p_industrial_park_code: "HB_KHAI_QUANG",
    p_display_name: "Khai Quang",
    p_reason: "Create HB Khai Quang",
    p_idempotency_key: KEY(50),
  });
  assert.equal(hbPark.version, 1);

  // Attempt to move HB_KHAI_QUANG into Vĩnh Phúc (which already has VP_KHAI_QUANG with normalized_key = 'khaiquang')
  const moveConflict = await rpcError(db, "industrial_park_update_admin", {
    p_auth_subject: NOBITA_ADMIN.auth,
    p_app_user_id: NOBITA_ADMIN.app,
    p_industrial_park_id: hbPark.industrial_park_id,
    p_expected_version: 1,
    p_province_id: vinhPhuc.province_id,
    p_display_name: "KCN Khai Quang",
    p_reason: "Move to Vinh Phuc should conflict",
    p_idempotency_key: KEY(51),
  });
  assert.ok(moveConflict);
  assert.equal(moveConflict.code, "23505");

  // Verify HB_KHAI_QUANG remained in Hòa Bình at version 1 with 1 revision
  const { rows: checkRows } = await db.query(
    `select p.province_id, p.version,
            (select count(*)::int from public.industrial_park_revisions r where r.industrial_park_id = p.industrial_park_id) as rev_count
       from public.industrial_parks p
      where p.industrial_park_id = $1::uuid`,
    [hbPark.industrial_park_id],
  );
  assert.equal(checkRows[0].province_id, hoaBinh.province_id);
  assert.equal(checkRows[0].version, 1);
  assert.equal(checkRows[0].rev_count, 1);
});

test("6. Table RLS and RPC ACL boundaries are enforced for anon, authenticated, PUBLIC, and service_role", async () => {
  const { rows: rlsRows } = await db.query(
    `select relname, relrowsecurity, relforcerowsecurity
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and relname in (
          'administrative_provinces',
          'administrative_province_revisions',
          'industrial_parks',
          'industrial_park_revisions'
        )
      order by relname`,
  );
  assert.equal(rlsRows.length, 4);
  for (const row of rlsRows) {
    assert.equal(row.relrowsecurity, true, `${row.relname} must enable RLS`);
    assert.equal(row.relforcerowsecurity, true, `${row.relname} must force RLS`);
  }

  for (const signature of RECRUITMENT_LOCATION_CATALOG_RPC_SIGNATURES) {
    const { rows: aclRows } = await db.query(
      `select
         pg_catalog.has_function_privilege('anon', $1::regprocedure, 'EXECUTE') as anon_exec,
         pg_catalog.has_function_privilege('authenticated', $1::regprocedure, 'EXECUTE') as auth_exec,
         pg_catalog.has_function_privilege('service_role', $1::regprocedure, 'EXECUTE') as service_exec`,
      [signature],
    );
    assert.equal(aclRows[0].anon_exec, false, `${signature} anon_exec`);
    assert.equal(aclRows[0].auth_exec, false, `${signature} auth_exec`);
    assert.equal(aclRows[0].service_exec, true, `${signature} service_exec`);
  }
});
