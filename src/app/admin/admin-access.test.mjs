import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  decideAccountAccessPageAccess,
  decideAdminAreaAccess,
  decideAttendanceReportPageAccess,
  decidePersonnelCatalogPageAccess,
  decideRecruitmentLocationCatalogPageAccess,
} from "../../lib/auth/direct-entry-page-access.ts";

function actor(capabilities, scopes = [{ kind: "all", reference: "all" }]) {
  return {
    ok: true,
    actor: {
      auth_subject: "subject-fixture",
      app_user_id: "user-fixture",
      display_name: "Fixture",
      enabled: true,
      capabilities,
      scopes,
      self_recruiter_suggestion: null,
      session: { provider: "supabase", verification: "getUser", authenticated_at: null },
    },
  };
}

test("Admin and Personnel direct-page decisions allow Full Admin and catalog operator", () => {
  const full = actor(["entry_admin", "recruiter_master_manage", "team_master_manage"]);
  const accounting = actor(["catalog_master_manage"]);
  for (const pageDecision of [decideAdminAreaAccess, decidePersonnelCatalogPageAccess]) {
    assert.equal(pageDecision({ actor: full }), "ALLOW");
    assert.equal(pageDecision({ actor: accounting }), "ALLOW");
    assert.equal(pageDecision({ actor: actor(["catalog_master_manage"], [{ kind: "team", reference: "t" }]) }), "ACCESS_DENIED");
    assert.equal(pageDecision({ actor: actor(["entry_admin"]) }), "ACCESS_DENIED");
    assert.equal(pageDecision({ actor: actor(["team_manager_assign"]) }), "ACCESS_DENIED");
  }
});

test("disabled, unmapped, ambiguous and missing actor resolutions fail closed", () => {
  for (const reason of ["ACTOR_DISABLED", "ACTOR_MAPPING_MISSING"]) {
    assert.equal(decideAdminAreaAccess({ actor: { ok: false, reason } }), "ACCOUNT_UNAVAILABLE");
  }
  for (const reason of ["AMBIGUOUS_RECRUITER_LINK", "AMBIGUOUS_TEAM_MEMBERSHIP"]) {
    assert.equal(decidePersonnelCatalogPageAccess({ actor: { ok: false, reason } }), "TEMPORARY_UNAVAILABLE");
  }
  assert.equal(decideAdminAreaAccess({ actor: null }), "TEMPORARY_UNAVAILABLE");
  assert.equal(decideAdminAreaAccess({ actor: { ok: false, reason: "UNAUTHENTICATED" } }), "REDIRECT_LOGIN");
});

test("both Admin URL surfaces resolve actor server-side and use explicit access decisions", () => {
  const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
  const adminPage = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  const personnelPage = readFileSync(new URL("./catalog/personnel/page.tsx", import.meta.url), "utf8");
  const vendorPage = readFileSync(new URL("./catalog/vendors/page.tsx", import.meta.url), "utf8");
  assert.match(layout, /resolveActorForRequest\(\)/);
  assert.match(layout, /decideAdminAreaAccess/);
  assert.match(layout, /mx-auto w-full max-w-7xl px-4 py-6 sm:px-6/);
  assert.doesNotMatch(layout, /max-w-6xl/);
  assert.match(adminPage, /resolveActorForRequest\(\)/);
  assert.match(adminPage, /decideAdminAreaAccess/);
  assert.match(personnelPage, /resolveActorForRequest\(\)/);
  assert.match(personnelPage, /decidePersonnelCatalogPageAccess/);
  assert.match(vendorPage, /resolveActorForRequest\(\)/);
  assert.match(vendorPage, /decideVendorCatalogPageAccess/);
  assert.doesNotMatch(layout + adminPage + personnelPage + vendorPage, /DIRECT_ENTRY_UI_ENABLED/);
});

test("/admin preserves its server gate then redirects straight to Personnel", () => {
  const adminPage = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  assert.match(adminPage, /resolveActorForRequest\(\)/);
  assert.match(adminPage, /decideAdminAreaAccess\(\{ actor \}\)/);
  assert.match(adminPage, /case "ALLOW":\s*redirect\("\/admin\/catalog\/personnel"\)/);
  assert.doesNotMatch(adminPage, /useEffect|useRouter/);
  assert.doesNotMatch(adminPage, /<h1[^>]*>Quản trị|Mở danh mục nhân sự|CardHeader|<Card/);
});

test("/admin/departments and /admin/departments/[departmentId] require Full Admin (decideAccountAccessPageAccess)", () => {
  const full = actor(["entry_admin", "recruiter_master_manage", "team_master_manage"]);
  const catalogOperator = actor(["catalog_master_manage"]);
  assert.equal(decideAccountAccessPageAccess({ actor: full }), "ALLOW");
  assert.equal(decideAccountAccessPageAccess({ actor: catalogOperator }), "ACCESS_DENIED");
  assert.equal(decideAccountAccessPageAccess({ actor: actor(["entry_admin"]) }), "ACCESS_DENIED");

  const departmentsPage = readFileSync(new URL("./departments/page.tsx", import.meta.url), "utf8");
  const departmentDetailPage = readFileSync(
    new URL("./departments/[departmentId]/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(departmentsPage, /resolveActorForRequest\(\)/);
  assert.match(departmentsPage, /decideAccountAccessPageAccess\(\{ actor \}\)/);
  assert.match(departmentDetailPage, /resolveActorForRequest\(\)/);
  assert.match(departmentDetailPage, /decideAccountAccessPageAccess\(\{ actor \}\)/);
});

test("/admin/organization/persons and [personId] enforce Full Admin gate via decideOrganizationPersonsPageAccess", () => {
  const personsPage = readFileSync(new URL("./organization/persons/page.tsx", import.meta.url), "utf8");
  const personDetailPage = readFileSync(
    new URL("./organization/persons/[personId]/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(personsPage, /resolveActorForRequest\(\)/);
  assert.match(personsPage, /decideOrganizationPersonsPageAccess\(\{ actor \}\)/);
  assert.match(personDetailPage, /resolveActorForRequest\(\)/);
  assert.match(personDetailPage, /decideOrganizationPersonsPageAccess\(\{ actor \}\)/);
  assert.doesNotMatch(personsPage + personDetailPage, /decideAdminAreaAccess|decideRecruitmentLocationCatalogPageAccess/);
});

test("/admin/catalog/provinces and /admin/catalog/industrial-parks allow Full Admin and BoD only", () => {
  const full = actor(["entry_admin", "recruiter_master_manage", "team_master_manage"]);
  const bodPrivileged = actor(["entry_privileged_edit"]);
  const bodReporting = actor(["report_analytics_view", "report_view"]);
  const catalogOperator = actor(["catalog_master_manage"]);

  assert.equal(decideRecruitmentLocationCatalogPageAccess({ actor: full }), "ALLOW");
  assert.equal(decideRecruitmentLocationCatalogPageAccess({ actor: bodPrivileged }), "ALLOW");
  assert.equal(decideRecruitmentLocationCatalogPageAccess({ actor: bodReporting }), "ALLOW");
  assert.equal(decideRecruitmentLocationCatalogPageAccess({ actor: catalogOperator }), "ACCESS_DENIED");
  assert.equal(decideRecruitmentLocationCatalogPageAccess({ actor: actor(["entry_admin"]) }), "ACCESS_DENIED");

  const teamLeader = actor(
    ["team_manager_assign", "report_view", "report_analytics_view"],
    [{ kind: "team", reference: "team-fixture" }],
  );
  assert.equal(decideAdminAreaAccess({ actor: teamLeader }), "ALLOW");
  assert.equal(decideAttendanceReportPageAccess({ actor: teamLeader }), "ALLOW");
  assert.equal(decideRecruitmentLocationCatalogPageAccess({ actor: teamLeader }), "ACCESS_DENIED");
  assert.equal(decidePersonnelCatalogPageAccess({ actor: teamLeader }), "ACCESS_DENIED");
  assert.equal(decideAccountAccessPageAccess({ actor: teamLeader }), "ACCESS_DENIED");

  const provincesPage = readFileSync(new URL("./catalog/provinces/page.tsx", import.meta.url), "utf8");
  const parksPage = readFileSync(new URL("./catalog/industrial-parks/page.tsx", import.meta.url), "utf8");
  assert.match(provincesPage, /resolveActorForRequest\(\)/);
  assert.match(provincesPage, /decideRecruitmentLocationCatalogPageAccess\(\{ actor \}\)/);
  assert.match(parksPage, /resolveActorForRequest\(\)/);
  assert.match(parksPage, /decideRecruitmentLocationCatalogPageAccess\(\{ actor \}\)/);
});
