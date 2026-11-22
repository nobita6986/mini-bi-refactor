import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const component = readFileSync(new URL("./project-team-scope-manager.tsx", import.meta.url), "utf8");
const model = readFileSync(new URL("../../lib/admin/project-team-scope-ui-model.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/admin/catalog/project-team-scopes/page.tsx", import.meta.url), "utf8");
const navigation = readFileSync(new URL("../../lib/admin/admin-navigation.ts", import.meta.url), "utf8");

test("mapping manager loads project and active-team choices from their existing server APIs", () => {
  assert.match(component, /\/api\/direct-entry\/projects\?include_inactive=true/);
  assert.match(component, /parseListResponse\(await response\.json\(\)\)/);
  assert.match(component, /\/api\/admin\/catalog\/teams\?\$\{query\.toString\(\)\}/);
  assert.match(component, /buildTeamListQuery\(\{ search: teamSearch, includeInactive: false, page: teamPage \}\)/);
  assert.match(component, /projectTeamListForQuery\(await response\.json\(\)/);
  assert.match(component, /type="checkbox" checked=\{checked\}/);
  assert.match(component, /Tìm dự án/);
  assert.match(component, /Tìm tổ đội/);
  assert.match(component, /selectedProjectIds/);
  assert.match(component, /setProjectPage/);
  assert.match(component, /setTeamPage/);
  assert.match(component, /Thử tải lại/);
  assert.match(component, /projectPicker\.kind === "denied"/);
  assert.match(component, /teamPicker\.kind === "error"/);
  assert.match(component, /<select required value=\{selectedTeam\?\.team_id/);
  assert.match(component, /MAX_BATCH_PROJECTS/);
  assert.match(component, /selectedProjectIds\.length >= MAX_BATCH_PROJECTS/);
});

test("grant/revoke submit only versionless API bodies and use server-projected batch results", () => {
  assert.match(component, /buildGrantRequest\(\{[\s\S]*?projectIds: selectedProjectIds,[\s\S]*?teamId: selectedTeam\?\.team_id/);
  assert.match(component, /buildRevokeRequest\(\{[\s\S]*?mappingId: dialog\.mapping\.mapping_id,[\s\S]*?effectiveTo: revokeEffectiveTo/);
  assert.match(component, /classifyGrantResponse\(/);
  assert.match(component, /classifyRevokeResponse\(/);
  assert.match(component, /\/api\/admin\/catalog\/project-team-scopes/);
  assert.match(component, /\/\$\{encodeURIComponent\(dialog\.mapping\.mapping_id\)\}\/revoke/);
  assert.match(model, /createdMessage/);
  assert.match(model, /skippedMessage/);
  assert.match(component, /Idempotency-Key/);
  assert.match(component, /pendingIntent\.current/);
  assert.doesNotMatch(component, /grantPairVersion|grantEffectiveFrom|expectedPairVersion/);
  assert.doesNotMatch(component, /expected_pair_version|effective_from:\s*grant/);
  assert.doesNotMatch(component, /Phiên bản cặp mapping/);
});

test("mapping page/nav stay Full Admin restricted and existing history/filter/error UX remains", () => {
  assert.match(page, /decideAccountAccessPageAccess\(\{ actor \}\)/);
  assert.doesNotMatch(page, /decideAdminAreaAccess/);
  assert.match(navigation, /project-team-scopes[^\n]*visible:\s*adminSecurityNavPredicate/);
  assert.match(component, /Chỉ Quản trị viên/);
  assert.match(component, /searchInput/);
  assert.match(component, /searchFilter/);
  assert.match(component, /includeHistory/);
  assert.match(component, /setPage\(/);
  assert.match(component, /Chưa có phân công nào/);
  assert.match(component, /state === "denied"/);
  assert.match(component, /state === "error"/);
  assert.match(component, /Thu hồi/);
  assert.match(component, /useNotify\(\)/);
  assert.doesNotMatch(component, /title="Trạng thái thao tác"/);
});

test("mapping search is one fuzzy box that debounces instead of firing per keystroke", () => {
  // One search box replaces the exact Project ID / Team ID inputs.
  assert.match(component, /Tìm dự án hoặc tổ đội/);
  assert.match(component, /buildMappingListQuery\(\{ search: searchFilter, includeHistory, page \}\)/);
  assert.doesNotMatch(component, /projectIdFilter/);
  assert.doesNotMatch(component, /teamIdFilter/);
  // Debounced (250-350 ms) so typing never fires one request per character.
  assert.match(component, /setTimeout\(\(\) => \{ setSearchFilter\(searchInput\); setPage\(1\); \}, 300\)/);
  assert.match(component, /clearTimeout\(handle\)/);
  assert.match(component, /\}, \[searchInput\]\)/);
  // The list effect reacts to the committed filter, not the raw input.
  assert.match(component, /\}, \[includeHistory, page, searchFilter, reloadToken\]\)/);
  // Submitting the form applies immediately.
  assert.match(component, /onSubmit=\{\(e\) => \{ e\.preventDefault\(\); setSearchFilter\(searchInput\); setPage\(1\); reloadList\(\); \}\}/);
});
