import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const listPage = readFileSync(
  new URL("../../app/admin/departments/page.tsx", import.meta.url),
  "utf8",
);
const detailPage = readFileSync(
  new URL("../../app/admin/departments/[departmentId]/page.tsx", import.meta.url),
  "utf8",
);
const listManager = readFileSync(
  new URL("./department-list-manager.tsx", import.meta.url),
  "utf8",
);
const detailManager = readFileSync(
  new URL("./department-detail-manager.tsx", import.meta.url),
  "utf8",
);
const uiModel = readFileSync(
  new URL("../../lib/admin/department-ui-model.ts", import.meta.url),
  "utf8",
);
const adminNav = readFileSync(
  new URL("../../lib/admin/admin-navigation.ts", import.meta.url),
  "utf8",
);

test("/admin/departments and /admin/departments/[departmentId] enforce Full Admin server gates and Next.js 16 async params", () => {
  for (const pageSrc of [listPage, detailPage]) {
    assert.match(pageSrc, /export const dynamic = "force-dynamic"/);
    assert.match(pageSrc, /resolveActorForRequest\(\)/);
    assert.match(pageSrc, /decideAccountAccessPageAccess\(\{ actor \}\)/);
    assert.doesNotMatch(pageSrc, /decideAdminAreaAccess/);
    assert.match(pageSrc, /case "NOT_FOUND":\s*notFound\(\)/);
    assert.match(pageSrc, /case "ACCOUNT_UNAVAILABLE":\s*return <AccountUnavailable \/>/);
    assert.match(pageSrc, /case "TEMPORARY_UNAVAILABLE":\s*return <TemporaryUnavailable \/>/);
    assert.match(pageSrc, /case "ACCESS_DENIED":\s*return <AccessDenied \/>/);
  }

  assert.match(detailPage, /params:\s*Promise<\{\s*departmentId:\s*string\s*\}>/);
  assert.match(detailPage, /await params/);
  assert.match(
    adminNav,
    /\{\s*id:\s*"departments",\s*label:\s*"Phòng ban",\s*href:\s*"\/admin\/departments",\s*visible:\s*adminSecurityNavPredicate\s*\}/,
  );
});

test("/admin/departments list view uses shared house primitives and handles loading, error, empty, denied, and retry states", () => {
  assert.match(listManager, /PageShell/);
  assert.match(listManager, /PageHeader/);
  assert.match(listManager, /DataTableContainer/);
  assert.match(listManager, /DATA_TABLE_CLASS/);
  assert.match(listManager, /StatusBadge/);
  assert.match(listManager, /EmptyState/);
  assert.match(listManager, /ErrorState/);
  assert.match(listManager, /buildDepartmentListQuery\(\{\s*includeInactive\s*\}\)/);
  assert.match(listManager, /fetch\(`\/api\/admin\/departments\?\$\{query\.toString\(\)\}`/);
  assert.match(listManager, /projectDepartmentListEnvelope\(payload\)/);
  assert.match(listManager, /classifyDepartmentReadError\(response\.status,\s*payload\)/);
  assert.match(listManager, /Thử tải lại/);
  assert.match(listManager, /Làm mới/);
  assert.match(listManager, /Tạo phòng ban tùy chỉnh/);
  assert.match(listManager, /canToggleDepartmentActive\(department\)/);
  assert.match(
    listManager,
    /href=\{`\/admin\/departments\/\$\{encodeURIComponent\(department\.department_id\)\}`\}/,
  );
  // List page creates custom departments and renames/toggles via WP3 contract helpers with Idempotency-Key
  assert.match(listManager, /buildCreateDepartmentRequest\(\{/);
  assert.match(listManager, /buildUpdateDepartmentRequest\(\{/);
  assert.match(listManager, /"Idempotency-Key":\s*intent\.idempotencyKey/);
});

test("Recruitment department detail is strictly read-only, hides __system_vendor__, and exposes zero Team/Leader/Scope write controls", () => {
  const recruitmentStart = detailManager.indexOf(
    "function RecruitmentDepartmentReadOnlySection",
  );
  const accountingStart = detailManager.indexOf(
    "function AccountingDepartmentMembershipsSection",
  );
  assert.ok(recruitmentStart > 0 && accountingStart > recruitmentStart);
  const recruitmentSection = detailManager.slice(recruitmentStart, accountingStart);

  assert.match(
    recruitmentSection,
    /\/api\/admin\/departments\/recruitment\/teams\?\$\{query\.toString\(\)\}/,
  );
  assert.match(recruitmentSection, /projectRecruitmentTeamsEnvelope\(/);
  assert.match(recruitmentSection, /visibleRecruitmentTeams\(/);
  assert.match(recruitmentSection, /Chế độ chỉ đọc — Vỏ Phòng Tuyển dụng/);
  assert.match(
    recruitmentSection,
    /Phòng Tuyển dụng không hỗ trợ gán thành viên trực tiếp/,
  );

  // Recruitment section must have zero mutation calls, dialogs, or links/writes to Team/Leader/Scope APIs
  assert.doesNotMatch(recruitmentSection, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(recruitmentSection, /FormDialog/);
  assert.doesNotMatch(recruitmentSection, /Gán thành viên|Kết thúc/);
  assert.doesNotMatch(
    detailManager,
    /\/api\/admin\/catalog\/(teams|team-leaders|project-team-scopes|personnel)/,
  );
});

test("Accounting department detail displays read-only Vendor Finance policy and wires canonical candidate search, OCC, reason, and idempotency", () => {
  const [, accountingSection] = detailManager.split(
    "function AccountingDepartmentMembershipsSection",
  );
  assert.ok(accountingSection);

  // Exact read-only default permission text
  assert.match(uiModel, /ACCOUNTING_DEFAULT_POLICY_DESCRIPTION = "Xem và ghi nhận tài chính Vendor"/);
  assert.match(accountingSection, /Quyền mặc định Phòng Kế toán \(chỉ đọc\)/);
  assert.match(accountingSection, /ACCOUNTING_DEFAULT_POLICY_DESCRIPTION/);
  assert.match(accountingSection, /departmentDefaultPolicyDescription\(department\)/);

  // Current & historical memberships + debounced search
  assert.match(
    accountingSection,
    /\/api\/admin\/departments\/accounting\/memberships\?\$\{query\.toString\(\)\}/,
  );
  assert.match(accountingSection, /includeHistory/);
  assert.match(accountingSection, /Bao gồm lịch sử/);
  assert.match(accountingSection, /Hiện tại &amp; sắp hiệu lực/);
  assert.match(accountingSection, /setTimeout\(\(\) => \{\s*setSearchFilter\(searchInput\);\s*setPage\(1\);\s*\},\s*300\)/);

  // Canonical candidate picker (radio selection, no manual UUID input)
  assert.match(
    accountingSection,
    /\/api\/admin\/departments\/accounting\/candidates\?\$\{query\.toString\(\)\}/,
  );
  assert.match(accountingSection, /type="radio"/);
  assert.match(accountingSection, /name="accounting-candidate"/);
  assert.doesNotMatch(accountingSection, /Nhập UUID|account_ref.*<input/i);

  // Assign & End mutations with OCC, required reason, and Idempotency-Key header
  assert.match(accountingSection, /buildAssignAccountingMemberRequest\(\{/);
  assert.match(accountingSection, /expectedPairVersion:\s*selectedCandidate\.pair_version/);
  assert.match(accountingSection, /buildEndAccountingMemberRequest\(\{/);
  assert.match(accountingSection, /expectedPairVersion:\s*target\.pair_version/);
  assert.match(
    accountingSection,
    /\/api\/admin\/departments\/accounting\/memberships\/\$\{encodeURIComponent\(built\.membershipId\)\}\/end/,
  );
  assert.match(accountingSection, /"Idempotency-Key":\s*built\.idempotencyKey/);
  assert.match(accountingSection, /classifyDepartmentMutationResponse\(/);

  // Single feedback channel: success toast via notify.success, inline dialog Alert for errors (no duplicate notify.error)
  assert.match(accountingSection, /notify\.success\(/);
  assert.doesNotMatch(accountingSection, /notify\.error\(/);
});

test("Department UI modules contain no capability editor/checkboxes, no browser Supabase calls, and no node/server-only runtime imports", () => {
  const allClientSources = [listManager, detailManager, uiModel].join("\n");

  // No permission matrix / capability or scope checkboxes / direct grant editors
  assert.doesNotMatch(allClientSources, /type="checkbox"/);
  assert.doesNotMatch(allClientSources, /ma trận quyền|permission.?matrix|capability.?editor/i);

  // No direct Supabase / PostgREST imports or client queries
  assert.doesNotMatch(
    [listPage, detailPage, listManager, detailManager, uiModel].join("\n"),
    /@supabase\/|supabase\.from\(|rest\/v1/i,
  );

  // Client & pure model files must stay browser-bundle safe (no node:* or server-only or fingerprint helpers)
  for (const [name, src] of [
    ["department-ui-model.ts", uiModel],
    ["department-list-manager.tsx", listManager],
    ["department-detail-manager.tsx", detailManager],
  ]) {
    assert.doesNotMatch(src, /from\s+["']node:/, `${name} must not import node:*`);
    assert.doesNotMatch(src, /["']server-only["']/, `${name} must not import server-only`);
    assert.doesNotMatch(
      src,
      /compute[A-Za-z]+Fingerprint/,
      `${name} must not import node:crypto fingerprint helpers`,
    );
  }
  for (const [name, src] of [
    ["department-list-manager.tsx", listManager],
    ["department-detail-manager.tsx", detailManager],
  ]) {
    assert.doesNotMatch(
      src,
      /import\s+(?!type\b)[^;]*department-contract/,
      `${name} must only use import type from department-contract`,
    );
  }
});

test("WP4 Department Head and Person membership panels wire OCC, immediate effective mutations, active-head blocks, and zero scheduling fields", () => {
  const wp4Sections = detailManager.slice(0, detailManager.indexOf("function RecruitmentDepartmentReadOnlySection"));
  assert.match(wp4Sections, /DepartmentGovernanceHeaderCard/);
  assert.match(wp4Sections, /DepartmentHeadManagementSection/);
  assert.match(wp4Sections, /DepartmentPersonMembershipsSection/);
  assert.match(wp4Sections, /\/api\/admin\/departments\/\$\{encodeURIComponent\(department\.department_id\)\}\/head\?/);
  assert.match(wp4Sections, /\/api\/admin\/departments\/\$\{encodeURIComponent\(department\.department_id\)\}\/head\/end/);
  assert.match(wp4Sections, /\/api\/admin\/departments\/\$\{encodeURIComponent\(department\.department_id\)\}\/memberships/);
  assert.match(wp4Sections, /\/api\/admin\/organization\/persons\/\$\{encodeURIComponent\([^)]+\)\}\/transfer-department/);
  assert.match(wp4Sections, /PERSON_IS_ACTIVE_DEPARTMENT_HEAD/);
  assert.match(wp4Sections, /Thử gửi lại cùng yêu cầu/);
  assert.match(wp4Sections, /Tải lại để đối chiếu/);
  assert.match(wp4Sections, /onSessionLost/);
  // Zero scheduling inputs in WP4 department forms
  assert.doesNotMatch(listManager + wp4Sections, /valid_from|valid_to|effective_from|effective_to/);
  assert.doesNotMatch(listManager + wp4Sections, /type="date"/);
});
