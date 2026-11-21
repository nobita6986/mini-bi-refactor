import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  resolveLegacyAccountsRedirectTarget,
  resolveLegacyEffectiveRedirectTarget,
} from "../../lib/admin/legacy-admin-redirect.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const accountDetailSource = readFileSync(
  new URL("./account-directory-detail-manager.tsx", import.meta.url),
  "utf8",
);
const listSource = readFileSync(new URL("./person-list-manager.tsx", import.meta.url), "utf8");
const accountsPage = readFileSync(
  new URL("../../app/admin/access/accounts/page.tsx", import.meta.url),
  "utf8",
);
const effectivePage = readFileSync(
  new URL("../../app/admin/access/effective/page.tsx", import.meta.url),
  "utf8",
);
const groupsPage = readFileSync(
  new URL("../../app/admin/access/groups/page.tsx", import.meta.url),
  "utf8",
);
const nav = readFileSync(new URL("../../lib/admin/admin-navigation.ts", import.meta.url), "utf8");
const pageAccess = readFileSync(
  new URL("../../lib/auth/direct-entry-page-access.ts", import.meta.url),
  "utf8",
);

test("PR #28: legacy technical admin UI screens & account classification route are completely removed", () => {
  for (const deletedRel of [
    "src/components/admin/account-access-workspace.tsx",
    "src/components/admin/account-manager.tsx",
    "src/components/admin/account-auxiliary-dialogs.tsx",
    "src/components/admin/account-global-roles-panel.tsx",
    "src/components/admin/effective-access-workspace.tsx",
    "src/components/admin/account-roles-embedded-section.tsx",
    "src/app/api/admin/access/accounts/[accountRef]/classification/route.ts",
  ]) {
    assert.equal(existsSync(path.join(repoRoot, deletedRel)), false, `must be deleted: ${deletedRel}`);
  }
});

test("PR #28: AccountDirectoryDetailManager handles lock/unlock, edit display name, reset password, and groups with strict OCC & idempotency", () => {
  assert.match(accountDetailSource, /\/api\/admin\/organization\/user-directory\/detail\?account_ref=/);
  assert.match(accountDetailSource, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(account\.account_ref\)\}\/\$\{action\}/);
  assert.match(accountDetailSource, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(account\.account_ref\)\}\/display-name/);
  assert.match(accountDetailSource, /\/api\/admin\/access\/accounts\/\$\{encodeURIComponent\(account\.account_ref\)\}\/reset-password/);
  assert.match(accountDetailSource, /"Idempotency-Key":/);
  assert.match(accountDetailSource, /AccountGroupsSection/);
  assert.match(accountDetailSource, /role="status"/);
  assert.match(accountDetailSource, /role="alert"/);
  assert.doesNotMatch(accountDetailSource, /Phiên bản|auth_subject|account_type|NORMAL|SHARED|SERVICE/);
});

test("PR #28: legacy /admin/access/accounts and /admin/access/effective enforce Full Admin server gate then redirect safely", () => {
  for (const page of [accountsPage, effectivePage, groupsPage]) {
    assert.match(page, /resolveActorForRequest\(\)/);
    assert.doesNotMatch(page, /DIRECT_ENTRY_UI_ENABLED|useEffect|useRouter/);
  }
  assert.match(accountsPage, /decideAccountAccessPageAccess/);
  assert.match(accountsPage, /resolveLegacyAccountsRedirectTarget/);
  assert.match(accountsPage, /createServiceUserDirectoryRepository/);
  assert.match(effectivePage, /decideEffectiveAccessPageAccess/);
  assert.match(effectivePage, /resolveLegacyEffectiveRedirectTarget/);
  assert.match(pageAccess, /decideAccountAccessPageAccess[\s\S]{0,220}adminSecurityNavPredicate/);

  // Unit verification of every legacy URL resolution branch (N1: never blindly redirects to non-existent Person)
  const linkedPersonEntry = {
    directory_entry_key: "person:p1",
    record_kind: "LINKED_PERSON_ACCOUNT",
    display_name: "Nguyễn Văn A",
    login_state: "ENABLED",
    person_id: "11111111-1111-4111-8111-111111111111",
    account_ref: "22222222-2222-4222-8222-222222222222",
    active_link_id: "33333333-3333-4333-8333-333333333333",
    link_conflict: false,
    identity_mutation_blocked: false,
    conflict_details: null,
    person: null,
    account: null,
    active_link: null,
    department_history: [],
    head_assignments: [],
    link_history: [],
  };
  const unlinkedAccountEntry = {
    ...linkedPersonEntry,
    directory_entry_key: "account:a2",
    record_kind: "UNLINKED_ACCOUNT",
    person_id: null,
    active_link_id: null,
  };
  const conflictEntry = {
    ...linkedPersonEntry,
    directory_entry_key: "conflict:a2",
    record_kind: "ACCOUNT_LINK_CONFLICT",
    link_conflict: true,
    identity_mutation_blocked: true,
  };

  assert.equal(
    resolveLegacyAccountsRedirectTarget({ accountEntry: linkedPersonEntry }),
    "/admin/organization/persons/11111111-1111-4111-8111-111111111111",
  );
  assert.equal(
    resolveLegacyAccountsRedirectTarget({ accountEntry: unlinkedAccountEntry }),
    "/admin/organization/persons/account/22222222-2222-4222-8222-222222222222",
  );
  assert.equal(
    resolveLegacyAccountsRedirectTarget({ accountEntry: conflictEntry }),
    "/admin/organization/persons/account/22222222-2222-4222-8222-222222222222",
  );
  assert.equal(
    resolveLegacyAccountsRedirectTarget({ view: "unlinked" }),
    "/admin/organization/persons?record_kind=unlinked_account",
  );
  assert.equal(
    resolveLegacyAccountsRedirectTarget({ tab: "global-roles" }),
    "/admin/access/groups",
  );
  assert.equal(resolveLegacyAccountsRedirectTarget({}), "/admin/organization/persons");
  assert.equal(
    resolveLegacyEffectiveRedirectTarget({ accountEntry: linkedPersonEntry }),
    "/admin/organization/persons/11111111-1111-4111-8111-111111111111",
  );
  assert.equal(
    resolveLegacyEffectiveRedirectTarget({ accountEntry: unlinkedAccountEntry }),
    "/admin/organization/persons/account/22222222-2222-4222-8222-222222222222",
  );
  assert.equal(resolveLegacyEffectiveRedirectTarget({}), "/admin/access/groups");
});

test("PR #28: Admin navigation shows Người dùng & Nhóm quyền and completely removes Quyền hiệu lực & utility bars", () => {
  assert.match(nav, /id: "organization-persons", label: "Người dùng", href: "\/admin\/organization\/persons"/);
  assert.match(nav, /id: "permission-groups", label: "Nhóm quyền", href: "\/admin\/access\/groups"/);
  assert.doesNotMatch(nav, /id: "effective-access"|Quyền hiệu lực|\/admin\/access\/effective|\/admin\/access\/accounts/);
  assert.doesNotMatch(listSource, /persons-utility-bar|Tài khoản đặc biệt|Đối chiếu dữ liệu cũ|Quyền hiệu lực/);
});
