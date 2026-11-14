import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./account-manager.tsx", import.meta.url), "utf8");
const model = readFileSync(new URL("../../lib/admin/account-access-model.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/admin/access/accounts/page.tsx", import.meta.url), "utf8");
const nav = readFileSync(new URL("../../lib/admin/admin-navigation.ts", import.meta.url), "utf8");
const pageAccess = readFileSync(new URL("../../lib/auth/direct-entry-page-access.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));

test("account manager provides list loading, empty, denied, unavailable, error and retry states", () => {
  for (const state of ['"loading"', '"loaded"', '"denied"', '"unavailable"', '"error"']) {
    assert.ok(source.includes(state), `missing state ${state}`);
  }
  assert.match(source, /Đang tải danh sách tài khoản/);
  assert.match(source, /Chưa có tài khoản phù hợp/);
  assert.match(source, /Không có quyền xem danh sách tài khoản/);
  assert.match(source, /Dịch vụ tài khoản hiện không khả dụng/);
  assert.match(source, /Thử tải lại/);
  assert.match(source, /role="status"/);
  assert.match(source, /role="alert"/);
});

test("account manager wires search, enabled filter, pagination and strict projection", () => {
  assert.match(source, /buildAccountListQuery/);
  assert.match(source, /projectAccountListForQuery/);
  assert.match(source, /method: "GET",\s*cache: "no-store"/);
  assert.match(source, /<option value="all">Tất cả<\/option>/);
  assert.match(source, /<option value="true">Đang hoạt động<\/option>/);
  assert.match(source, /<option value="false">Ngừng hoạt động<\/option>/);
  assert.match(source, /Trang trước/);
  assert.match(source, /Trang sau/);
  assert.match(source, /Tìm kiếm theo tên hiển thị/);
});

test("enable/disable use exact API routes, optional reason, authoritative version and idempotency header", () => {
  assert.match(source, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(dialog\.account\.account_ref\)\}\/\$\{dialog\.nextEnabled \? "enable" : "disable"\}/);
  assert.match(source, /method: "POST",\s*operation: dialog\.nextEnabled \? "enable" : "disable"/);
  assert.match(source, /buildAccountStateRequest/);
  assert.match(source, /newAccountIntentKey\(\)/);
  assert.match(source, /"Idempotency-Key": String\(intent\.body\.idempotency_key\)/);
  assert.match(source, /expectedVersion: dialog\.account\.version/);
  assert.match(source, /Lý do thao tác \(không bắt buộc\)/);
  assert.match(source, /maxLength=\{4000\}/);
  assert.doesNotMatch(source, /maxLength=\{4000\} required|aria-required="true"/);
  assert.match(source, /Xác nhận kích hoạt/);
  assert.match(source, /Xác nhận ngừng/);
  assert.match(source, /radix-ui\/dialog/);
  assert.match(source, /aria-describedby="account-dialog-description"/);
  assert.match(source, /aria-label="Đóng hộp thoại"/);
});

test("reason field is locked once a mutation intent exists so retry replays the captured reason", () => {
  // locked covers in-flight, transport-uncertain retry and applied/conflict reload states.
  assert.match(source, /const locked = busy \|\| pendingIntent !== null \|\| conflictIntent !== null;/);
  // ReasonField is driven by that same locked flag.
  assert.match(source, /<ReasonField value=\{reason\} disabled=\{locked\}/);
  // ReasonField forwards disabled to the native textarea.
  assert.match(source, /function ReasonField\(\{ value, disabled, onChange \}: \{ value: string; disabled: boolean; onChange\(value: string\): void \}\)/);
  assert.match(source, /rows=\{3\} disabled=\{disabled\}/);
});

test("real display name is primary and login id is secondary; account_ref and version stay internal", () => {
  assert.match(source, /<span className="block font-medium">\{account\.display_name \?\? "Chưa cập nhật tên thật"\}<\/span>/);
  assert.match(source, /\{account\.login_id \? <span className="block text-xs text-muted">\{account\.login_id\}<\/span> : null\}/);
  assert.match(source, /<strong>\{dialog\.account\.display_name \?\? "Chưa cập nhật tên thật"\}<\/strong>/);
  // No JSX text interpolation of the opaque ref or the OCC version.
  assert.doesNotMatch(source, /\{account\.version\}/);
  assert.doesNotMatch(source, /\{dialog\.account\.version\}/);
  assert.doesNotMatch(source, /<td[^>]*>\s*\{account\.account_ref\}/);
  assert.doesNotMatch(source, /\{dialog\.account\.account_ref\}/);
  // No version/label/raw-identity column or field anywhere in the surface.
  for (const file of [source, model]) {
    assert.doesNotMatch(file, /Phiên bản|auth_subject|revision|account_ref<\/th>|UUID<\/th/i);
    assert.doesNotMatch(file, /\.email|display_name \|\|/);
  }
  // Five columns: Tên hiển thị, Phân loại, Hồ sơ người liên kết, Trạng thái, Thao tác.
  assert.equal(source.match(/<th scope="col"/g)?.length, 5);
});

test("no optimistic success: applied/conflict lock the account until strict authoritative reload", () => {
  assert.match(source, /outcome\.kind === "applied" \|\| outcome\.kind === "conflict"/);
  assert.match(source, /setConflictIntent\(intent\)/);
  assert.match(source, /await reloadAuthoritative\(intent\)/);
  assert.match(source, /projectAccountItem\(await response\.json\(\)\)/);
  assert.match(source, /account\.account_ref !== intent\.accountRef/);
  assert.match(source, /setConflictIntent\(null\)[\s\S]{0,120}setPendingIntent\(null\)/);
  assert.match(source, /Thao tác vẫn đang bị khóa/);
  assert.match(source, /pendingIntent \|\| conflictIntent/);
  // The manager never reads a projected row out of the mutation outcome/response.
  assert.doesNotMatch(source, /outcome\.account|outcome\.list|payload\.account|payload\.list/);
  // A malformed reload (null projection or ref mismatch) keeps the lock via throw.
  assert.match(source, /if \(!account \|\| account\.account_ref !== intent\.accountRef\) \{\s*throw new Error/);
  // Action outcomes route through useNotify() without inline action-result Alert banners.
  assert.match(source, /useNotify\(\)/);
  assert.doesNotMatch(source, /title="Trạng thái thao tác"/);
});

test("page gate resolves actor server-side and uses the Full-Admin-only account access decision", () => {
  assert.match(page, /resolveActorForRequest\(\)/);
  assert.match(page, /decideAccountAccessPageAccess/);
  assert.match(page, /redirect\("\/login\?next=\/admin\/access\/accounts"\)/);
  assert.doesNotMatch(page, /DIRECT_ENTRY_UI_ENABLED|useEffect|useRouter/);
  // The decision must use the canonical Full Admin triple, never the broader Admin-area predicate.
  assert.match(pageAccess, /decideAccountAccessPageAccess[\s\S]{0,220}adminSecurityNavPredicate/);
  assert.doesNotMatch(pageAccess, /decideAccountAccessPageAccess[\s\S]{0,220}decideAdminAreaAccess/);
});

test("Accounts navigation is visible only to the Full Admin triple, not the Admin-area predicate", () => {
  assert.match(nav, /id: "accounts", label: "Tài khoản truy cập", href: "\/admin\/access\/accounts", visible: adminSecurityNavPredicate/);
  assert.doesNotMatch(nav, /id: "accounts"[^}]*adminAreaNavPredicate/);
  assert.match(nav, /\.filter\(\(section\) => section\.visible\(actor\)\)[\s\S]{0,120}\.map\(\(\{ id, label, href \}\) => \(\{ id, label, href \}\)\)/);
  // Catalog sections keep their existing Admin-area visibility.
  assert.match(nav, /id: "personnel"[^}]*adminAreaNavPredicate/);
});

test("the client surface never derives authority from actor, role, capability or email", () => {
  for (const file of [source, model]) {
    assert.doesNotMatch(file, /capabilities|resolveActor|useActor|\.scopes\b|actor\./i);
  }
});

test("canonical pnpm test invokes the W05-A lane exactly once", () => {
  assert.ok(packageJson.scripts["test:p3-1-w05-a-existing-account-ui"]);
  const occurrences = packageJson.scripts.test.match(/test:p3-1-w05-a-existing-account-ui/g) ?? [];
  assert.equal(occurrences.length, 1);
  for (const member of [
    /account-access-model\.test\.mjs/,
    /account-manager\.test\.mjs/,
    /admin-navigation\.test\.mjs/,
    /direct-entry-page-access\.test\.mjs/,
  ]) {
    assert.match(packageJson.scripts["test:p3-1-w05-a-existing-account-ui"], member);
  }
});

test("WP4 account manager supports classification, searchable Person linking, manual recruiter mismatch confirmation, and session-loss clearing", () => {
  assert.match(source, /accountTypeBadgeMeta\(account\.account_type\)/);
  assert.match(source, /PersonSearchPicker/);
  assert.match(source, /RecruiterConfirmPicker/);
  assert.match(source, /confirmedRecruiterId:/);
  assert.match(source, /mismatchConfirmRequired/);
  assert.match(source, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(targetAccount\.account_ref\)\}\/classification/);
  assert.match(source, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(targetAccount\.account_ref\)\}\/person-link\/end/);
  assert.match(source, /Khóa tài khoản không làm ngừng hồ sơ nhân sự/);
  assert.match(source, /Thử gửi lại cùng yêu cầu/);
  assert.match(source, /handleOrgSessionLost/);
  // Never require manual UUID input for person or recruiter linking
  assert.doesNotMatch(source, /Nhập UUID|person_id.*<input/i);
});
