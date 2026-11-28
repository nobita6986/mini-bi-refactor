import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

function readRel(relPath) {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

function resolveCandidatePath(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
  ];
  return (
    candidates.find((candidate) => {
      try {
        return existsSync(candidate) && statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/link") {
      return nextResolve("next/link.js", context);
    }
    if (specifier === "next/navigation") {
      return nextResolve("next/navigation.js", context);
    }
    if (specifier.startsWith("@/")) {
      const target = resolveCandidatePath(path.join(repoRoot, "src", specifier.slice(2)));
      if (target) {
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:") &&
      !context.parentURL.includes("/node_modules/") &&
      !context.parentURL.includes("\\node_modules\\")
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const target = resolveCandidatePath(path.resolve(parentDir, specifier));
      if (target) {
        return { url: pathToFileURL(target).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && (url.endsWith(".ts") || url.endsWith(".tsx"))) {
      const filePath = fileURLToPath(url);
      const sourceText = readFileSync(filePath, "utf8");
      const transpiled = ts.transpileModule(sourceText, {
        fileName: filePath,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
        },
      });
      return {
        format: "module",
        source: transpiled.outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

const {
  buildReferrerCandidateQuery,
  buildReferrerVendorListQuery,
  classifyReferrerApiFailure,
  classifyReferrerLinkInterval,
  filterReferrerCandidates,
  formatCandidateOptionLabel,
  formatReferrerAuditAction,
  validateAssignReferrerInput,
  validateRevokeReferrerInput,
} = await import("@/components/admin/vendor-referrer-panel");

const {
  buildVendorReferralReportQuery,
  checkReconciliationConservation,
  classifyVendorReferralReportError,
  formatPeriodLabel,
  summarizeReferralPairs,
} = await import("@/components/admin/vendor-referral-report-view");

const {
  resolveAllowedGroupCapabilities,
  stripDisallowedCapabilitiesForScope,
} = await import("@/components/admin/permission-groups-manager");

const PERSON_A = "11111111-1111-4111-8111-111111111111";
const PERSON_B = "22222222-2222-4222-8222-222222222222";
const LINK_ID = "33333333-3333-4333-8333-333333333333";
const DEPT_ID = "44444444-4444-4444-8444-444444444444";
const REC_ID = "55555555-5555-4555-8555-555555555555";

const CANDIDATES = [
  {
    person_id: PERSON_A,
    employee_code: "EMP-001",
    full_name: "Nguyễn Văn An",
    department_id: DEPT_ID,
    department_name: "Phòng Tuyển dụng",
    department_system_key: "RECRUITMENT",
    recruiter_id: REC_ID,
    recruiter_display_name: "Nguyễn Văn An (HRP)",
    personnel_code: "HRP-TD-01",
  },
  {
    person_id: PERSON_B,
    employee_code: "EMP-002",
    full_name: "Trần Thị Bình",
    department_id: DEPT_ID,
    department_name: "Phòng Marketing",
    department_system_key: "MARKETING",
    recruiter_id: REC_ID,
    recruiter_display_name: "Trần Thị Bình (HRP)",
    personnel_code: null,
  },
];

describe("Vendor Referrer Panel pure UI helpers", () => {
  it("builds bounded vendor and candidate queries", () => {
    const q1 = buildReferrerVendorListQuery({
      search: "  ALPHA ",
      includeInactive: true,
      page: 2,
    });
    assert.equal(q1?.get("search"), "ALPHA");
    assert.equal(q1?.get("include_inactive"), "true");
    assert.equal(q1?.get("page"), "2");
    assert.equal(q1?.get("page_size"), "25");

    assert.equal(
      buildReferrerVendorListQuery({ search: "", includeInactive: false, page: 0 }),
      null,
    );
    assert.equal(
      buildReferrerVendorListQuery({ search: "x".repeat(121), includeInactive: false, page: 1 }),
      null,
    );

    const cq = buildReferrerCandidateQuery({ search: "  Marketing  ", limit: 300 });
    assert.equal(cq?.get("search"), "Marketing");
    assert.equal(cq?.get("limit"), "300");
    assert.equal(buildReferrerCandidateQuery({ limit: 501 }), null);
  });

  it("formats and filters cross-department candidate options", () => {
    assert.equal(
      formatCandidateOptionLabel(CANDIDATES[0]),
      "Nguyễn Văn An · EMP-001 · Phòng Tuyển dụng",
    );
    assert.deepEqual(
      filterReferrerCandidates(CANDIDATES, "marketing").map((c) => c.person_id),
      [PERSON_B],
    );
    assert.deepEqual(
      filterReferrerCandidates(CANDIDATES, "EMP-001").map((c) => c.person_id),
      [PERSON_A],
    );
    assert.equal(filterReferrerCandidates(CANDIDATES, "").length, 2);
  });

  it("validates assign/replace inputs fail-closed (inactive vendor, same referrer, invalid/early date)", () => {
    assert.equal(
      validateAssignReferrerInput({
        vendor: { active: false, current_link: null },
        referrerPersonId: PERSON_A,
        effectiveDate: "2026-11-27",
      }).ok,
      false,
    );

    const activeUnassigned = { active: true, current_link: null };
    assert.equal(
      validateAssignReferrerInput({
        vendor: activeUnassigned,
        referrerPersonId: "not-a-uuid",
        effectiveDate: "2026-11-27",
      }).ok,
      false,
    );

    assert.equal(
      validateAssignReferrerInput({
        vendor: activeUnassigned,
        referrerPersonId: PERSON_A,
        effectiveDate: "2026-02-30",
      }).ok,
      false,
    );

    const activeWithLink = {
      active: true,
      current_link: {
        link_id: LINK_ID,
        referrer_person_id: PERSON_A,
        referrer_employee_code: "EMP-001",
        referrer_full_name: "Nguyễn Văn An",
        referrer_department_name: "Phòng Tuyển dụng",
        effective_from: "2026-11-10",
        reason: "Ban đầu",
        created_at: "2026-11-10T08:00:00Z",
      },
    };

    const sameRef = validateAssignReferrerInput({
      vendor: activeWithLink,
      referrerPersonId: PERSON_A,
      effectiveDate: "2026-11-27",
    });
    assert.equal(sameRef.ok, false);

    const earlyDate = validateAssignReferrerInput({
      vendor: activeWithLink,
      referrerPersonId: PERSON_B,
      effectiveDate: "2026-11-09",
    });
    assert.equal(earlyDate.ok, false);

    const validReplace = validateAssignReferrerInput({
      vendor: activeWithLink,
      referrerPersonId: PERSON_B,
      effectiveDate: "2026-11-10",
    });
    assert.deepEqual(validReplace, {
      ok: true,
      referrer_person_id: PERSON_B,
      effective_date: "2026-11-10",
      expected_current_link_id: LINK_ID,
    });
  });

  it("validates revoke inputs and classifies history/audit states incl. same-day [D, D)", () => {
    assert.equal(
      validateRevokeReferrerInput({
        vendor: { current_link: null },
        effectiveDate: "2026-11-27",
      }).ok,
      false,
    );

    const currentLink = {
      link_id: LINK_ID,
      referrer_person_id: PERSON_A,
      referrer_employee_code: "EMP-001",
      referrer_full_name: "Nguyễn Văn An",
      referrer_department_name: "Phòng Tuyển dụng",
      effective_from: "2026-11-10",
      reason: "Ban đầu",
      created_at: "2026-11-10T08:00:00Z",
    };

    assert.equal(
      validateRevokeReferrerInput({
        vendor: { current_link: currentLink },
        effectiveDate: "2026-11-09",
      }).ok,
      false,
    );

    assert.deepEqual(
      validateRevokeReferrerInput({
        vendor: { current_link: currentLink },
        effectiveDate: "2026-11-27",
      }),
      {
        ok: true,
        effective_date: "2026-11-27",
        expected_current_link_id: LINK_ID,
      },
    );

    assert.deepEqual(
      classifyReferrerLinkInterval({
        link_id: LINK_ID,
        vendor_id: "V1",
        referrer_person_id: PERSON_A,
        referrer_employee_code: "EMP-001",
        referrer_full_name: "Nguyễn Văn An",
        referrer_department_name: "Phòng Tuyển dụng",
        effective_from: "2026-11-27",
        effective_to: null,
        is_current: true,
        reason: "Gán",
        created_by_display_name: "BoD",
        created_at: "2026-11-27T08:00:00Z",
        ended_by_display_name: null,
        ended_at: null,
        ended_reason: null,
      }),
      { label: "Đang hiệu lực", tone: "success", isSameDaySuperseded: false },
    );

    assert.deepEqual(
      classifyReferrerLinkInterval({
        link_id: LINK_ID,
        vendor_id: "V1",
        referrer_person_id: PERSON_A,
        referrer_employee_code: "EMP-001",
        referrer_full_name: "Nguyễn Văn An",
        referrer_department_name: "Phòng Tuyển dụng",
        effective_from: "2026-11-27",
        effective_to: "2026-11-27",
        is_current: false,
        reason: "Gán",
        created_by_display_name: "BoD",
        created_at: "2026-11-27T08:00:00Z",
        ended_by_display_name: "BoD",
        ended_at: "2026-11-27T09:00:00Z",
        ended_reason: "Thay thế cùng ngày",
      }),
      { label: "Đã kết thúc", tone: "neutral", isSameDaySuperseded: true },
    );

    assert.equal(formatReferrerAuditAction("ASSIGN").label, "Gán mới");
    assert.equal(formatReferrerAuditAction("REPLACE").label, "Thay thế");
    assert.equal(formatReferrerAuditAction("REVOKE").label, "Thu hồi");
    assert.equal(classifyReferrerApiFailure(409, { code: "VENDOR_REFERRER_CONFLICT" }).kind, "conflict");
    assert.equal(classifyReferrerApiFailure(403, { code: "VENDOR_REFERRER_DENIED" }).kind, "denied");
    assert.equal(classifyReferrerApiFailure(503, null).kind, "unavailable");
  });
});

describe("Vendor Referral Monthly Report pure UI helpers", () => {
  it("adds project turns for the same NVTD and Vendor, keeping other pairs separate", () => {
    const first = {
      referrer_person_id: PERSON_A, referrer_full_name: "NVTD A", referrer_employee_code: "A",
      vendor_id: "abc", vendor_display_name: "Vendor ABC", project_id: "p1", turns: 2,
    };
    const rows = summarizeReferralPairs([
      first,
      { ...first, project_id: "p2", turns: 3 },
      { ...first, referrer_person_id: PERSON_B, referrer_full_name: "NVTD B", turns: 1 },
    ]);
    assert.deepEqual(rows.map(({ referrer, vendorId, turns }) => [referrer, vendorId, turns]), [
      ["NVTD A", "abc", 5], ["NVTD B", "abc", 1],
    ]);
  });
  it("builds report query params cleanly and rejects invalid filters", () => {
    const defaultQuery = buildVendorReferralReportQuery({ month: "", allTime: false });
    assert.equal(defaultQuery?.toString(), "");

    const allQuery = buildVendorReferralReportQuery({
      month: "2026-11",
      allTime: true,
      referrerPersonId: PERSON_A,
      vendorId: "VENDOR_ALPHA",
      projectId: "PROJ_01",
    });
    assert.equal(allQuery?.get("month"), "ALL");
    assert.equal(allQuery?.get("referrer_person_id"), PERSON_A);
    assert.equal(allQuery?.get("vendor_id"), "VENDOR_ALPHA");
    assert.equal(allQuery?.get("project_id"), "PROJ_01");

    assert.equal(buildVendorReferralReportQuery({ month: "2026-13", allTime: false }), null);
    assert.equal(
      buildVendorReferralReportQuery({ month: "2026-11", allTime: false, referrerPersonId: "bad" }),
      null,
    );
    assert.equal(
      buildVendorReferralReportQuery({
        month: "2026-11",
        allTime: false,
        vendorId: "__system_vendor__",
      }),
      null,
    );
  });

  it("verifies conservation equation and error classification", () => {
    const balanced = checkReconciliationConservation({
      total_vendor_turns: 20,
      matched_vendor_turns: 17,
      attributed_turns: 12,
      unassigned_vendor_turns: 5,
      unresolved_vendor_turns: 3,
    });
    assert.equal(balanced.balanced, true);
    assert.equal(balanced.sum, 20);

    const unbalanced = checkReconciliationConservation({
      total_vendor_turns: 20,
      matched_vendor_turns: 17,
      attributed_turns: 12,
      unassigned_vendor_turns: 4,
      unresolved_vendor_turns: 3,
    });
    assert.equal(unbalanced.balanced, false);

    assert.equal(classifyVendorReferralReportError(403, { code: "VENDOR_REFERRER_DENIED" }).kind, "denied");
    assert.equal(classifyVendorReferralReportError(400, { code: "VENDOR_REFERRER_INVALID" }).kind, "error");
    assert.equal(classifyVendorReferralReportError(503, null).kind, "unavailable");

    assert.match(
      formatPeriodLabel({
        month: "ALL",
        period_from: null,
        period_to: null,
        authorization_date: "2026-11-27",
      }),
      /Toàn bộ thời gian/,
    );
    assert.match(
      formatPeriodLabel({
        month: "2026-11",
        period_from: "2026-11-01",
        period_to: "2026-11-30",
        authorization_date: "2026-11-27",
      }),
      /2026-11-01 → 2026-11-30/,
    );
  });
});

describe("Vendor Referrer UI server gates, wiring, and strict zero-compensation compliance", () => {
  const vendorsPage = readRel("src/app/admin/catalog/vendors/page.tsx");
  const catalogManager = readRel("src/components/admin/vendor-catalog-manager.tsx");
  const referrerPanel = readRel("src/components/admin/vendor-referrer-panel.tsx");
  const reportPage = readRel("src/app/admin/vendor-referrals/page.tsx");
  const reportView = readRel("src/components/admin/vendor-referral-report-view.tsx");

  it("keeps the report under Vendor navigation and guards direct access", () => {
    assert.match(vendorsPage, /resolveActorForRequest\(\)/);
    assert.match(vendorsPage, /decideVendorCatalogPageAccess\(/);
    assert.match(vendorsPage, /decideVendorReferrerReportPageAccess\(\{ actor, hasVendorReferrerAccess: access\.canViewReport \}\)/);
    assert.match(vendorsPage, /Danh mục Vendor/);
    assert.match(vendorsPage, /Gán người giới thiệu/);
    assert.match(vendorsPage, /Lượt tuyển qua Vendor/);
    assert.match(vendorsPage, /aria-current/);
    assert.match(vendorsPage, /<VendorReferrerPanel \/>/);
    assert.match(vendorsPage, /<VendorReferralReportView/);
    assert.match(catalogManager, /Danh mục nhà cung cấp/);
    assert.match(reportPage, /redirect\("\/admin\/catalog\/vendors\?tab=referral-report"\)/);
  });

  it("wires VendorReferrerPanel endpoints, idempotency, OCC, inactive guard, and history audit trail", () => {
    assert.match(referrerPanel, /\/api\/admin\/vendor-referrals\/vendors/);
    assert.match(referrerPanel, /\/api\/admin\/vendor-referrals\/candidates/);
    assert.match(referrerPanel, /\/history/);
    assert.match(referrerPanel, /tab=referral-report&vendor_id=/);
    assert.match(referrerPanel, /projectVendorHistory\(rawData, "api"\)/);
    assert.doesNotMatch(referrerPanel, /referrer-reason|Lý do thao tác/);
    assert.match(referrerPanel, /\/assign/);
    assert.match(referrerPanel, /\/revoke/);
    assert.match(referrerPanel, /crypto\.randomUUID/);
    assert.match(referrerPanel, /"Idempotency-Key": intent\.idempotencyKey/);
    assert.match(referrerPanel, /idempotency_key: idempotencyKey/);
    assert.match(referrerPanel, /expected_current_link_id/);
    assert.match(referrerPanel, /listState\.data\.authorization_date/);
    assert.match(referrerPanel, /Ngừng hoạt động — không thể gán\/thay thế/);
    assert.match(referrerPanel, /Thay thế cùng ngày/);
    assert.doesNotMatch(referrerPanel, /new Date\(\)|toISOString\(\)/);
  });

  it("shows a selected zero-result assignment and makes reconciliation optional", () => {
    assert.match(reportView, /\/api\/admin\/vendor-referrals\/report/);
    assert.match(reportView, /Toàn bộ thời gian/);
    assert.match(reportView, /Lượt tuyển theo NVTD và Vendor/);
    assert.match(reportView, /Chi tiết theo dự án/);
    assert.match(reportView, /showZeroPair[\s\S]*turns: 0/);
    assert.match(reportView, /<details[\s\S]*Đối soát/);
    assert.match(reportView, /Đã biết Vendor nhưng chưa có NVTD giới thiệu hiệu lực tại ngày vào làm/);
    assert.match(reportView, /Chưa đủ dữ liệu xác định Vendor/);
    assert.match(reportView, /chưa đủ dữ liệu xác định Vendor từ dữ liệu hồ sơ/);
    assert.match(reportView, /setServerMonth\(projected\.month\)/);
    assert.doesNotMatch(reportView, /first_work_date|recruiter_provider_memberships|toàn bộ REQ/);
  });

  it("exposes vendor_referrer_manage ONLY for MANAGEMENT_BOD (or SYSTEM_ADMIN) non-team groups and strips on dept/team switch", () => {
    const bodCaps = resolveAllowedGroupCapabilities({
      isTeamScoped: false,
      departmentSystemKey: "MANAGEMENT_BOD",
      isSystemAdmin: false,
    });
    assert.ok(bodCaps.includes("vendor_referrer_manage"));

    const sysAdminCaps = resolveAllowedGroupCapabilities({
      isTeamScoped: false,
      departmentSystemKey: "IT",
      isSystemAdmin: true,
    });
    assert.ok(sysAdminCaps.includes("vendor_referrer_manage"));

    for (const deptKey of ["RECRUITMENT", "ACCOUNTING", "HR", "MARKETING", null]) {
      const caps = resolveAllowedGroupCapabilities({
        isTeamScoped: false,
        departmentSystemKey: deptKey,
        isSystemAdmin: false,
      });
      assert.equal(caps.includes("vendor_referrer_manage"), false);
    }

    const teamCaps = resolveAllowedGroupCapabilities({
      isTeamScoped: true,
      departmentSystemKey: "MANAGEMENT_BOD",
      isSystemAdmin: false,
    });
    assert.equal(teamCaps.includes("vendor_referrer_manage"), false);

    assert.deepEqual(
      stripDisallowedCapabilitiesForScope(["catalog_master_manage", "vendor_referrer_manage"], {
        isTeamScoped: false,
        departmentSystemKey: "ACCOUNTING",
      }),
      ["catalog_master_manage"],
    );
    assert.deepEqual(
      stripDisallowedCapabilitiesForScope(["catalog_master_manage", "vendor_referrer_manage"], {
        isTeamScoped: false,
        departmentSystemKey: "MANAGEMENT_BOD",
      }),
      ["catalog_master_manage", "vendor_referrer_manage"],
    );
  });

  it("contains strictly zero monetary, commission, payout, or accounting fields/copy", () => {
    const forbidden =
      /\b(commission|hoa_hong|hoa hồng|payout|fee_amount|vnd|salary|bonus|tiền thưởng|chi trả|mức chi|rate)\b/i;
    for (const [label, src] of [
      ["vendors/page.tsx", vendorsPage],
      ["vendor-catalog-manager.tsx", catalogManager],
      ["vendor-referrer-panel.tsx", referrerPanel],
      ["vendor-referrals/page.tsx", reportPage],
      ["vendor-referral-report-view.tsx", reportView],
    ]) {
      assert.doesNotMatch(src, forbidden, `Forbidden monetary/compensation term found in ${label}`);
    }
  });
});
