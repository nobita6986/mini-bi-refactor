import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manager = readFileSync(new URL("./team-catalog-manager.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../../app/admin/catalog/teams/page.tsx", import.meta.url), "utf8");

test("Team UI scopes department reads and preserves canonical Team Catalog writes and sends the key in header and body", () => {
  assert.ok(manager.includes('departmentId ? "/api/admin/departments/recruitment/teams" : "/api/admin/catalog/teams"'));
  assert.match(manager, /url: "\/api\/admin\/catalog\/teams"/);
  assert.match(manager, /url: `\/api\/admin\/catalog\/teams\/\$\{encodeURIComponent\(dialog\.team\.team_id\)\}`/);
  assert.match(manager, /\/active`/);
  assert.match(manager, /"Idempotency-Key": String\(intent\.body\.idempotency_key\)/);
  assert.match(manager, /body: JSON\.stringify\(intent\.body\)/);
  assert.match(manager, /setPendingIntent\(\{ \.\.\.intent, retryState: "retry" \}\)/);
  assert.match(manager, /sendIntent\(pendingIntent\)/);
});

test("applied changes stay locked until authoritative detail/list reload confirms current data", () => {
  const applied = manager.indexOf('if (outcome.kind === "applied")');
  const reload = manager.indexOf("await reloadConflictedTeam(intent)", applied);
  assert.ok(applied >= 0 && reload > applied);
  assert.match(manager.slice(applied, reload), /setConflictLocks/);
  assert.match(manager.slice(applied, reload), /setConflictIntents/);
  assert.match(manager, /team\.team_id !== intent\.teamId/);
  assert.match(manager, /teamListConfirmsCode\(list, code\)/);
  assert.match(manager, /clearConflict\(intent\.lockId\)/);
  assert.match(manager, /Không tải được dữ liệu có thẩm quyền/);
  assert.match(manager, /useNotify\(\)/);
  assert.doesNotMatch(manager, /title="Trạng thái thao tác"/);
});

test("conflict alerts are scoped to the open team and remain available after closing", () => {
  assert.match(manager, /teamConflictsForDialog\(conflictIntents, dialogLockId\)/);
  assert.match(manager, /dialog === null \?\s*\(\s*Array\.from\(conflictIntents\.values\(\)/);
  assert.match(manager, /disabled=\{busy \|\| conflictLocks\.has\(team\.team_id\)/);
});

test("dialogs expose accessible, sanitized errors and do not access Supabase directly", () => {
  assert.match(manager, /role="alert"/);
  assert.match(manager, /<Alert tone="error" role="alert"/);
  assert.match(manager, /role="status"/);
  assert.match(manager, /Dialog\.Title/);
  assert.match(manager, /Dialog\.Description/);
  assert.doesNotMatch(manager, /createClient|supabase\.from|\.rpc\(/i);
  assert.doesNotMatch(manager, /auth_subject|raw database detail/i);
  assert.doesNotMatch(page, /capabilities.*request|role.*email/i);
  assert.match(page, /decideTeamCatalogPageAccess/);
});
