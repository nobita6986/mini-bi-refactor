import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveRecruitmentTeamsRedirectHref,
  resolveTeamReturnHref,
} from "./recruitment-team-routing.ts";

const AUTH_SUBJECT = "10000000-0000-4000-8000-000000000001";
const APP_USER_ID = "20000000-0000-4000-8000-000000000001";
const RECRUITMENT_DEPT_ID = "30000000-0000-4000-8000-000000000011";
const ACCOUNTING_DEPT_ID = "30000000-0000-4000-8000-000000000022";

function makeFullAdminActor() {
  return {
    ok: true,
    actor: {
      auth_subject: AUTH_SUBJECT,
      app_user_id: APP_USER_ID,
      display_name: "Owner",
      capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage", "catalog_master_manage"],
      scopes: [{ kind: "all", reference: "all", valid_from: "2020-01-01", valid_to: null }],
      effective_grants: [
        { capability: "entry_admin", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: "r1" },
        { capability: "recruiter_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: "r1" },
        { capability: "team_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: "r1" },
        { capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: "r1" },
      ],
    },
  };
}

function makeCatalogOnlyActor() {
  return {
    ok: true,
    actor: {
      auth_subject: AUTH_SUBJECT,
      app_user_id: APP_USER_ID,
      display_name: "HR Catalog",
      capabilities: ["catalog_master_manage"],
      scopes: [{ kind: "all", reference: "all", valid_from: "2020-01-01", valid_to: null }],
      effective_grants: [
        { capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null, source_type: "ROLE_BUNDLE", source_id: "r2" },
      ],
    },
  };
}

function makeDepartmentSummary(systemKey, departmentId, name) {
  return {
    department_id: departmentId,
    system_key: systemKey,
    code: systemKey,
    name,
    is_active: true,
    version: 1,
    membership_mode: systemKey === "RECRUITMENT" ? "MANAGED_MEMBERSHIP_AND_TEAMS" : "MANAGED_MEMBERSHIP",
    default_policy_code: systemKey === "RECRUITMENT" ? "EXISTING_TEAM_AUTHORITY_READ_ONLY" : "VENDOR_FINANCE_VIEW_AND_RECORD",
    active_member_count: 1,
    team_count: systemKey === "RECRUITMENT" ? 2 : 0,
    active_team_count: systemKey === "RECRUITMENT" ? 2 : 0,
    active_head: null,
    created_at: "2026-11-21T00:00:00.000Z",
    updated_at: "2026-11-21T00:00:00.000Z",
  };
}

test("resolveTeamReturnHref always resolves actual RECRUITMENT department by system_key for Full Admin, never Accounting or arbitrary URL department_id", async () => {
  let listCalls = 0;
  const href = await resolveTeamReturnHref({
    actor: makeFullAdminActor(),
    apiEnabled: true,
    departmentRepository: {
      async listDepartments() {
        listCalls += 1;
        return {
          ok: true,
          data: {
            authorization_date: "2026-11-23",
            as_of: "2026-11-23T04:00:00.000Z",
            departments: [
              makeDepartmentSummary("ACCOUNTING", ACCOUNTING_DEPT_ID, "Phòng Tuyển dụng (giả mạo)"),
              makeDepartmentSummary("RECRUITMENT", RECRUITMENT_DEPT_ID, "Đơn vị Nhân sự & Tuyển dụng"),
            ],
          },
        };
      },
    },
  });

  assert.equal(listCalls, 1);
  assert.equal(href, `/admin/departments/${RECRUITMENT_DEPT_ID}?view=teams`);
  assert.equal(href.includes(ACCOUNTING_DEPT_ID), false);
});

test("resolveTeamReturnHref falls back safely to /admin/catalog/teams when Full Admin department lookup fails or has only Accounting", async () => {
  const onlyAccounting = await resolveTeamReturnHref({
    actor: makeFullAdminActor(),
    apiEnabled: true,
    departmentRepository: {
      async listDepartments() {
        return {
          ok: true,
          data: {
            authorization_date: "2026-11-23",
            as_of: "2026-11-23T04:00:00.000Z",
            departments: [makeDepartmentSummary("ACCOUNTING", ACCOUNTING_DEPT_ID, "Phòng Kế toán")],
          },
        };
      },
    },
  });
  assert.equal(onlyAccounting, "/admin/catalog/teams");

  const rpcFailure = await resolveTeamReturnHref({
    actor: makeFullAdminActor(),
    apiEnabled: true,
    departmentRepository: {
      async listDepartments() {
        return { ok: false, code: "DEPARTMENT_UNAVAILABLE" };
      },
    },
  });
  assert.equal(rpcFailure, "/admin/catalog/teams");
});

test("resolveTeamReturnHref and resolveRecruitmentTeamsRedirectHref keep /admin/catalog/teams for HR_OPERATOR/catalog-only with 0 department queries", async () => {
  let listCalls = 0;
  const repo = {
    async listDepartments() {
      listCalls += 1;
      return {
        ok: true,
        data: {
          authorization_date: "2026-11-23",
          as_of: "2026-11-23T04:00:00.000Z",
          departments: [makeDepartmentSummary("RECRUITMENT", RECRUITMENT_DEPT_ID, "Phòng Tuyển dụng")],
        },
      };
    },
  };

  assert.equal(
    await resolveTeamReturnHref({ actor: makeCatalogOnlyActor(), apiEnabled: true, departmentRepository: repo }),
    "/admin/catalog/teams",
  );
  assert.equal(
    await resolveRecruitmentTeamsRedirectHref({ actor: makeCatalogOnlyActor(), apiEnabled: true, departmentRepository: repo }),
    null,
  );
  assert.equal(
    await resolveTeamReturnHref({ actor: null, apiEnabled: true, departmentRepository: repo }),
    "/admin/catalog/teams",
  );
  assert.equal(listCalls, 0);
});

test("resolveRecruitmentTeamsRedirectHref redirects Full Admin bookmark /admin/catalog/teams to RECRUITMENT ?view=teams when enabled", async () => {
  const repo = {
    async listDepartments() {
      return {
        ok: true,
        data: {
          authorization_date: "2026-11-23",
          as_of: "2026-11-23T04:00:00.000Z",
          departments: [
            makeDepartmentSummary("ACCOUNTING", ACCOUNTING_DEPT_ID, "Phòng Kế toán"),
            makeDepartmentSummary("RECRUITMENT", RECRUITMENT_DEPT_ID, "Phòng Tuyển dụng"),
          ],
        },
      };
    },
  };

  assert.equal(
    await resolveRecruitmentTeamsRedirectHref({ actor: makeFullAdminActor(), apiEnabled: true, departmentRepository: repo }),
    `/admin/departments/${RECRUITMENT_DEPT_ID}?view=teams`,
  );
  assert.equal(
    await resolveRecruitmentTeamsRedirectHref({ actor: makeFullAdminActor(), apiEnabled: false, departmentRepository: repo }),
    null,
  );
});
