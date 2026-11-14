import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const listPage = readFileSync(
  new URL("../../app/admin/organization/persons/page.tsx", import.meta.url),
  "utf8",
);
const detailPage = readFileSync(
  new URL("../../app/admin/organization/persons/[personId]/page.tsx", import.meta.url),
  "utf8",
);
const listManager = readFileSync(new URL("./person-list-manager.tsx", import.meta.url), "utf8");
const detailManager = readFileSync(new URL("./person-detail-manager.tsx", import.meta.url), "utf8");
const pickerSource = readFileSync(new URL("./org-entity-picker.tsx", import.meta.url), "utf8");
const uiModel = readFileSync(new URL("../../lib/admin/person-org-ui-model.ts", import.meta.url), "utf8");
const personnelCatalog = readFileSync(
  new URL("./personnel-catalog-manager.tsx", import.meta.url),
  "utf8",
);

test("WP4 Person pages dùng Full Admin guard, force-dynamic và async params của Next 16", () => {
  for (const page of [listPage, detailPage]) {
    assert.match(page, /export const dynamic = "force-dynamic"/);
    assert.match(page, /resolveActorForRequest\(\)/);
    assert.match(page, /decideOrganizationPersonsPageAccess\(\{ actor \}\)/);
    assert.doesNotMatch(
      page,
      /decideAdminAreaAccess|decidePersonnelCatalogPageAccess|decideRecruitmentLocationCatalogPageAccess/,
    );
  }
  assert.match(detailPage, /params:\s*Promise<\{\s*personId:\s*string\s*\}>/);
  assert.match(detailPage, /normalizeOrgUuid\(personId\)/);
  assert.match(detailPage, /if \(!safeId\) \{\s*notFound\(\);\s*\}/);
});

test("WP4 UI & model tái sử dụng contract WP3B và an toàn bundle phía client", () => {
  assert.match(uiModel, /from "\.\.\/organization\/person-contract\.ts"/);
  assert.match(uiModel, /from "\.\.\/departments\/department-contract\.ts"/);

  const clientBundleSources = [listManager, detailManager, pickerSource, uiModel].join("\n");
  assert.doesNotMatch(clientBundleSources, /from\s+["'](?:node:|server-only)/);
  assert.doesNotMatch(clientBundleSources, /import\s*\{[^}]*compute[A-Za-z]+Fingerprint/);
  assert.doesNotMatch(clientBundleSources, /supabase|\.rpc\(|createClient\(/i);
  assert.doesNotMatch(clientBundleSources, /transition-all|localStorage|sessionStorage/);
});

test("WP4 Nhân sự nội bộ: mã nhân sự do Admin nhập tay, không tự sinh NV-xxxx, không gửi unassigned và không có trường đặt lịch", () => {
  const personUiSources = [listManager, detailManager].join("\n");

  // Không tự sinh / gợi ý mã NV-xxxx
  assert.doesNotMatch(personUiSources, /NV-\d{3,}|generateEmployeeCode|nextEmployeeCode|suggestEmployeeCode/i);
  assert.match(personUiSources, /hrp-YYYY-XXXXXX/);
  assert.match(listManager, /Nhập mã nhân sự nội bộ/);

  // Không gửi sentinel department_id=unassigned
  assert.doesNotMatch(personUiSources, /department_id=unassigned|value="unassigned"/);

  // Không có ô đặt lịch hiệu lực
  assert.doesNotMatch(
    personUiSources,
    /name="(valid_from|valid_to|effective_from|effective_to)"|id="person-(valid|effective)-/,
  );

  // Phân biệt rõ Ngừng hoạt động hồ sơ người với khóa tài khoản đăng nhập
  assert.match(detailManager, /không tự khóa tài khoản[\s\S]*đăng nhập liên kết/i);
  assert.match(listManager, /không tự khóa tài khoản đăng nhập/i);
});

test("WP4 dùng PageShell, FormDialog, bảng responsive, AbortController, uncertain retry, 409 reload và xóa dữ liệu khi mất phiên", () => {
  for (const source of [listManager, detailManager]) {
    assert.match(source, /<PageShell\b/);
    assert.match(source, /<FormDialog\b/);
    assert.match(source, /<DataTableContainer\b/);
    assert.match(source, /useNotify\(\)/);
    assert.match(source, /AbortController/);
    assert.match(source, /handleSessionLost/);
    assert.match(source, /newOrgIdempotencyKey\(\)/);
    assert.match(source, /preserveIdempotencyKey|outcome\.kind === "uncertain"/);
    assert.match(source, /Tải lại (?:danh sách|để đối chiếu)|Tải bản mới nhất/);
  }
  assert.match(detailManager, /PERSON_IS_ACTIVE_DEPARTMENT_HEAD|outcome\.kind === "active-head-block"/);
  assert.match(detailManager, /Lịch sử phòng ban/);
  assert.match(detailManager, /Lịch sử chức danh Trưởng phòng/);
});

test("WP4 bộ chọn dùng tìm kiếm (không bắt nhập UUID) và phân biệt rõ Hồ sơ tính công tuyển dụng", () => {
  for (const picker of [
    "DepartmentSelectPicker",
    "PersonSearchPicker",
    "AccountSearchPicker",
    "RecruiterConfirmPicker",
  ]) {
    assert.match(pickerSource, new RegExp(`export function ${picker}\\b`));
  }
  assert.doesNotMatch(pickerSource, /Nhập UUID|UUID của/i);

  assert.match(personnelCatalog, /Hồ sơ tính công tuyển dụng/);
  assert.match(personnelCatalog, /\/api\/admin\/catalog\/personnel/);
});
