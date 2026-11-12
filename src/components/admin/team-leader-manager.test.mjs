import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("./team-leader-manager.tsx", import.meta.url), "utf8");
const catalog = readFileSync(new URL("./team-catalog-manager.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/admin/catalog/teams/page.tsx", import.meta.url), "utf8");
const model = readFileSync(new URL("../../lib/admin/team-leader-model.ts", import.meta.url), "utf8");

test("current, scheduled and history reads are parallel, bounded and team-scoped", () => {
  assert.match(component, /const STATES: readonly TeamLeaderState\[\] = \["CURRENT", "SCHEDULED", "HISTORY"\]/);
  assert.match(component, /Promise\.all\(STATES\.map\(\(state\) => readLeaderList\(teamId, state, 1, controller\.signal\)\)\)/);
  assert.match(component, /\/api\/admin\/catalog\/team-leaders\?\$\{query\.toString\(\)\}/);
  assert.match(component, /buildTeamLeaderListQuery\(teamId, state, page\)/);
  assert.match(component, /TEAM_LEADER_CANDIDATE_PAGE_SIZE/);
  assert.match(component, /loadPage\(activeState, pages\[activeState\] \+ 1\)/);
  assert.doesNotMatch(component, /STATES\.map[\s\S]{0,450}team-leader-candidates/);
});

test("candidate lookup is on demand and renders the strict display-only three-key projection", () => {
  assert.match(component, /if \(!teamId \|\| !candidateEnabled \|\| !candidateQueryString\)/);
  assert.match(component, /\/api\/admin\/catalog\/team-leader-candidates\?\$\{candidateQueryString\}/);
  assert.match(component, /projectTeamLeaderCandidates\(await response\.json\(\), candidatePage\)/);
  assert.match(component, /candidate\.display_name/);
  assert.match(component, /candidate\.personnel_code/);
  assert.match(component, /value=\{candidate\.app_user_id\}/);
  assert.doesNotMatch(component, /candidate\.(?:email|role|title|app_user_id)\s*\}\s*</);
  assert.match(component, /<th scope="row"[^>]*>\{leader\.leader_display_name\}<\/th>/);
  assert.doesNotMatch(component, /<(?:td|th)[^>]*>\{leader\.(?:team_id|leader_app_user_id|leader_recruiter_id|assignment_id)\}/);
});

test("designation, replacement and revoke preserve canonical team path, effective date, reason, OCC and idempotency while scheduled rows are read-only", () => {
  assert.match(component, /buildTeamLeaderDesignation/);
  assert.match(component, /buildTeamLeaderRevocation/);
  assert.match(component, /expectedVersion: team\.version/);
  assert.match(component, /effectiveDate: form\.effectiveDate/);
  assert.match(component, /reason: form\.reason/);
  assert.match(component, /const idempotencyKey = newTeamLeaderIntentKey\(\)/);
  assert.match(component, /"Idempotency-Key": String\(intent\.body\.idempotency_key\)/);
  assert.match(component, /body: JSON\.stringify\(intent\.body\)/);
  assert.match(component, /onClick=\{\(\) => void sendIntent\(workflow\.intent!\)\}/);
  assert.match(component, /activeState === "CURRENT"/);
  assert.doesNotMatch(component, /Hủy lịch/);
  assert.match(component, /Lịch trưởng nhóm tương lai cũ đang cản thao tác gán hoặc thu hồi ngay/);
  assert.match(component, /change: form\.kind/);
});

test("applied and conflicted writes remain entity-locked until team and all leader projections reload", () => {
  const sendOutcome = component.indexOf('if (outcome.kind === "applied" || outcome.kind === "conflict")');
  const reloadCall = component.indexOf("await reloadAuthoritative(intent.teamId, intent, successMessage)", sendOutcome);
  assert.ok(sendOutcome >= 0 && reloadCall > sendOutcome);
  const reload = component.slice(component.indexOf("const reloadAuthoritative"), component.indexOf("const sendIntent"));
  assert.match(reload, /Promise\.all\(\[/);
  assert.match(reload, /projectTeamLeaderSnapshot\(id/);
  assert.match(reload, /onLockChange\(id, false\)/);
  assert.match(reload, /onTeamReloaded\(snapshot\.team\)/);
  assert.match(reload, /phase: "reload-error"/);
  assert.match(reload, /Nhóm vẫn bị khóa/);
  assert.match(component, /onLockChange\(intent\.teamId, true\)/);
  assert.match(component, /onLockChange\(intent\.teamId, false\)/);
  assert.match(component, /useNotify\(\)/);
  assert.doesNotMatch(component, /title="Trạng thái thao tác"/);
  assert.match(catalog, /setTeamConflictLock\(current, teamId, locked\)/);
  assert.match(catalog, /leaderLocks\.has\(team\.team_id\)/);
});

test("loading, empty, errors, denied states and actions remain explicit and sanitized", () => {
  assert.match(component, /Đang tải \{stateLabel\(activeState\)\.toLowerCase\(\)\}/);
  assert.match(component, /Chưa có trưởng nhóm trong mục này/);
  assert.match(component, /Không có quyền xem dữ liệu trưởng nhóm/);
  assert.match(component, /Không thể tải dữ liệu trưởng nhóm/);
  assert.match(component, /Thử tải lại/);
  assert.match(component, /Thử lại đúng thao tác/);
  assert.match(component, /Tải lại dữ liệu có thẩm quyền/);
  assert.match(component, /candidateState\.kind === "denied"/);
  assert.match(component, /workflow\.phase !== "idle" \|\| teamOperationLocked/);
  assert.match(component, /<Dialog\.Title/);
  assert.match(component, /<Dialog\.Description/);
  assert.match(page, /decideTeamCatalogPageAccess/);
  assert.doesNotMatch(page, /role.*email|capabilities.*request/i);
  assert.doesNotMatch(component, /createClient|supabase\.from|\.rpc\(/i);
});

test("revoke reserved/inactive and other invalid outcomes receive sanitized Vietnamese copy", () => {
  assert.match(model, /nhóm không thể nhận thay đổi này; hãy kiểm tra trạng thái nhóm \(bao gồm nhóm hệ thống\)/i);
  assert.match(model, /Bạn không có quyền thực hiện thao tác này/);
  assert.match(model, /Nhóm hoặc dữ liệu trưởng nhóm không còn khả dụng/);
  assert.match(model, /Nhóm đã thay đổi ở nơi khác/);
  assert.doesNotMatch(model, /raw database detail|postgres|sqlstate|constraint/i);
  assert.doesNotMatch(component, /raw database detail|postgres|sqlstate|constraint/i);
});

test("Team Catalog integrates one accessible leader dialog without inferring client authority", () => {
  assert.equal((catalog.match(/<TeamLeaderManager\b/g) ?? []).length, 1);
  assert.match(catalog, /setLeaderTeam\(team\)/);
  assert.match(catalog, /team=\{leaderTeam\}/);
  assert.match(catalog, /onTeamReloaded=\{onLeaderTeamReloaded\}/);
  assert.match(catalog, /onLockChange=\{onLeaderLockChange\}/);
  assert.match(component, /role="tablist"/);
  assert.match(component, /role="tab" aria-selected=\{activeState === state\}/);
  assert.match(component, /aria-label="Đóng hộp thoại"/);
  assert.match(page, /decideTeamCatalogPageAccess/);
});
