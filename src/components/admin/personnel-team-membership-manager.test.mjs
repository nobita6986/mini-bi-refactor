import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("./personnel-team-membership-manager.tsx", import.meta.url), "utf8");
const personnelManager = readFileSync(new URL("./personnel-catalog-manager.tsx", import.meta.url), "utf8");

test("successful refresh is informational, warnings are reserved for stopped reloads", () => {
  assert.match(component, /activeConflict && busy \?/);
  assert.match(component, /tone="info" title="Đang cập nhật danh sách"/);
  assert.match(component, /useNotify\(\)/);
  assert.match(component, /Chưa có ngày kết thúc/);
  assert.match(component, /membership\.valid_to === membership\.valid_from \? "Đã hủy lịch"/);
  assert.match(component, /Phân công mới không có ngày kết thúc/);
  assert.doesNotMatch(component, /Nhóm mới chỉ có hiệu lực/);
});

test("technical counters are hidden while finite move dates and OCC remain intact", () => {
  for (const file of ["./personnel-catalog-manager.tsx", "./team-catalog-manager.tsx", "./team-leader-manager.tsx",
    "../direct-entry/worker-operations.tsx", "../direct-entry/project-operations.tsx",
    "../direct-entry/direct-entry-change-request-list.tsx", "../direct-entry/direct-entry-submission-list.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /Phiên bản/);
  }
  assert.doesNotMatch(component, /Phiên bản hồ sơ|xung đột phiên bản/);
  assert.match(component, /expectedVersion: membership\.recruiter_version/);
  assert.match(component, /validTo: membership\.valid_to/);
  assert.match(component, /operation\.kind === "move" && operation\.validTo/);
  assert.match(component, /formatDate\(operation\.validTo\)/);
  assert.match(component, /formError \? <p>\{formError\}<\/p>/);
});

test("membership API reads only after opening one selected personnel and never preloads per row", () => {
  assert.match(component, /if \(!personnel\) return;/);
  assert.match(component, /Promise\.all\(STATES\.map\(\(state\) => readMembershipList\(recruiterId, state, 1\)\)\)/);
  assert.match(personnelManager, /setMembershipPersonnel\(personnel\)/);
  assert.doesNotMatch(personnelManager, /api\/admin\/catalog\/team-memberships/);
  assert.doesNotMatch(personnelManager, /list\.personnel\.map[\s\S]{0,700}team-memberships/);
  assert.match(component, /\/api\/admin\/catalog\/team-memberships\?\$\{query\.toString\(\)\}/);
});

test("current, scheduled and history use separate strict bounded reads and pagers", () => {
  assert.match(component, /const STATES: readonly MembershipState\[\] = \["CURRENT", "SCHEDULED", "HISTORY"\]/);
  assert.match(component, /stateLabel\(state\)/);
  assert.match(component, /projectMembershipList\(await response\.json\(\)/);
  assert.match(component, /onPage=\{\(page\) => void loadOneState\(state, page\)\}/);
  assert.match(component, /MEMBERSHIP_PAGE_SIZE/);
  assert.match(component, /readState\.kind === "unauthenticated" \|\| readState\.kind === "denied"/);
  assert.match(component, /readState\.kind === "not-found" \|\| readState\.kind === "unavailable"/);
  assert.match(component, /readState\.kind === "error"/);
  assert.match(component, /list\.memberships\.length === 0/);
});

test("team catalog is strict, active-only and reserved teams are not reconstructed", () => {
  assert.match(component, /\/api\/admin\/catalog\/teams\?\$\{query\.toString\(\)\}/);
  assert.match(component, /projectActiveTeams\(await response\.json\(\), page\)/);
  assert.match(component, /teamState\.teams/);
  assert.match(component, /team\.display_name\} \(\{team\.code\}\)/);
  assert.doesNotMatch(component, /__system_vendor__|Vendor team/i);
});

test("mutations use canonical methods, headers, versioned strict requests and no direct database access", () => {
  assert.match(component, /buildAssignMembershipRequest/);
  assert.match(component, /buildUnassignMembershipRequest/);
  assert.match(component, /method: "POST"/);
  assert.match(component, /"Idempotency-Key": intent\.idempotencyKey/);
  assert.match(component, /const idempotencyKey = newMembershipIntentKey\(\)/);
  assert.match(component, /recordMembershipIntent\(current, pendingIntent\)/);
  assert.match(component, /const intent: MembershipIntent/);
  assert.match(component, /body: JSON\.stringify\(intent\.body\)/);
  assert.match(component, /classifyMembershipMutation/);
  assert.match(component, /expectedVersion: operation\.kind === "move" \? operation\.expectedVersion : personnel\.version/);
  assert.match(component, /expectedVersion: operation\.membership\.recruiter_version/);
  assert.match(component, /if \(outcome\.kind === "conflict"\)/);
  assert.match(component, /membershipWorkflowLocked\(activeEntry\)/);
  assert.doesNotMatch(component, /supabase|\.rpc\(|createClient\(|from\(["']recruiter_team_memberships/i);
});

test("successful mutation reloads authoritative detail and each separate list; failed reload retains lock", () => {
  assert.match(component, /refreshAuthoritative\(intent\.recruiterId, requestGeneration\)/);
  assert.match(component, /projectPersonnelItem\(await response\.json\(\)\)/);
  assert.match(component, /Promise\.all\(STATES\.map\(\(state\) => readMembershipList\(recruiterId, state, 1\)\)\)/);
  assert.match(component, /finishMembershipReload\(current, intent\.recruiterId, refresh\)/);
  assert.match(component, /finishMembershipReload\(current, recruiterId, result\)/);
  assert.match(component, /finishMembershipReload/);
  assert.match(component, /lockEntity\(recruiterId, false\)/);
  assert.match(component, /onPersonnelUnavailable\(recruiterId\)/);
  assert.match(component, /onCloseAutoFocus=\{\(event\) => event\.preventDefault\(\)\}/);
  assert.match(personnelManager, /membershipTrigger\.current\?\.focus\(\)/);
});

test("membership form captures DOM values before the queued React state updater runs", () => {
  assert.doesNotMatch(
    component,
    /setActiveForm\(\(value\) => \(\{[^}]*event\.currentTarget\.value/s,
  );
  assert.match(component, /const teamId = event\.currentTarget\.value;[\s\S]*teamId \}\)\);/);
  assert.doesNotMatch(component, /id="membership-effective-date"\s+type="date"/);
  assert.match(component, /const reason = event\.currentTarget\.value;[\s\S]*reason \}\)\);/);
});

test("inactive personnel can still close membership, while assign and move require active personnel and scheduled rows are read-only with conflict alert", () => {
  assert.match(component, /onMove=\{personnel\.active && state === "CURRENT" && !hasScheduledConflict/);
  assert.match(component, /onClose=\{state === "CURRENT"/);
  assert.match(component, /const showScheduledSection = hasScheduledConflict/);
  assert.match(component, /const visibleStates = STATES\.filter\(\(state\) => state !== "SCHEDULED" \|\| showScheduledSection\)/);
  assert.match(component, /visibleStates\.map\(\(state\) =>/);
  assert.doesNotMatch(component, /onCancelScheduled/);
  assert.doesNotMatch(component, />Hủy lịch</);
  assert.match(component, /startClose\(membership\)/);
  assert.match(component, /Lịch phân công tương lai cũ đang cản thao tác gán hoặc chuyển nhóm ngay/);
});

test("UI never displays technical UUIDs and retains accessible state and personnel-create form scope", () => {
  assert.match(component, /<table/);
  assert.match(component, /role="status"/);
  assert.match(component, /role="alert"/);
  assert.doesNotMatch(component, /<td[^>]*>\s*\{membership\.(membership_id|team_id)\}/);
  assert.match(personnelManager, /Quản lý nhóm/);
  assert.doesNotMatch(personnelManager, /label="Mật khẩu"|label="Tài khoản đăng nhập"|label="Nhóm"/i);
});

test("assignment is fail-closed and user-facing copy uses Vietnamese terminology", () => {
  assert.match(component, /canAssignMembership\(visibleLists\.CURRENT, visibleLists\.SCHEDULED\)/);
  assert.match(component, /\{canAssign && personnel\.active \?/);
  assert.match(component, /otherAttentionEntries/);
  assert.match(component, /Đóng cửa sổ này để mở lại đúng hồ sơ/);
  const visibleLabels = Array.from(component.matchAll(/\b(?:title|description|aria-label)="([^"]*)"/gi),
    (match) => match[1]);
  assert.doesNotMatch(visibleLabels.join("\n"), /\bmembership\b/i);
  assert.doesNotMatch(component, /(?:title|description|aria-label)=\{`[^`]*\bmembership\b/i);
});
