import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  decideEffectiveAccessPageAccess,
  effectiveAccessAdminNavPredicate,
  hasPairedFullAdminAuthority,
  hasPairedGrantsAdminAuthority,
} from "./effective-access-page-guard.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function makeFullAdminActor(overrides = {}) {
  return {
    app_user_id: "11111111-1111-4111-8111-111111111111",
    login_id: "owner",
    display_name: "System Owner",
    enabled: true,
    capabilities: [
      "entry_admin",
      "recruiter_master_manage",
      "team_master_manage",
      "employment_status.decide",
    ],
    scopes: [{ kind: "all" }],
    effective_grants: [
      {
        capability: "entry_admin",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "ROLE_BUNDLE",
        source_id: null,
      },
      {
        capability: "recruiter_master_manage",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "ROLE_BUNDLE",
        source_id: null,
      },
      {
        capability: "team_master_manage",
        scope_kind: "ALL",
        scope_id: null,
        source_type: "ROLE_BUNDLE",
        source_id: null,
      },
    ],
    ...overrides,
  };
}

test("hasPairedFullAdminAuthority requires all 3 Full Admin capabilities paired with ALL scope", () => {
  assert.equal(hasPairedFullAdminAuthority(makeFullAdminActor()), true);

  // Missing one of the 3 Full Admin paired capabilities (HR_OPERATOR profile)
  assert.equal(
    hasPairedFullAdminAuthority(
      makeFullAdminActor({
        capabilities: ["recruiter_master_manage", "team_master_manage"],
        effective_grants: [
          {
            capability: "recruiter_master_manage",
            scope_kind: "ALL",
            scope_id: null,
            source_type: "ROLE_BUNDLE",
            source_id: null,
          },
          {
            capability: "team_master_manage",
            scope_kind: "ALL",
            scope_id: null,
            source_type: "ROLE_BUNDLE",
            source_id: null,
          },
        ],
      }),
    ),
    false,
  );

  // Cross-paired bypass attempt: unpaired arrays pass, paired grant has entry_admin @ TEAM instead of ALL
  assert.equal(
    hasPairedFullAdminAuthority(
      makeFullAdminActor({
        capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
        scopes: [{ kind: "all" }, { kind: "team", team_id: "22222222-2222-4222-8222-222222222222" }],
        effective_grants: [
          {
            capability: "entry_admin",
            scope_kind: "CONTEXT_TEAM",
            scope_id: "22222222-2222-4222-8222-222222222222",
            source_type: "DIRECT_GRANT",
            source_id: null,
          },
          {
            capability: "recruiter_master_manage",
            scope_kind: "ALL",
            scope_id: null,
            source_type: "ROLE_BUNDLE",
            source_id: null,
          },
          {
            capability: "team_master_manage",
            scope_kind: "ALL",
            scope_id: null,
            source_type: "ROLE_BUNDLE",
            source_id: null,
          },
        ],
      }),
    ),
    false,
  );

  // Malformed grant (ALL with non-null scope_id) fails closed
  assert.equal(
    hasPairedFullAdminAuthority(
      makeFullAdminActor({
        effective_grants: [
          {
            capability: "entry_admin",
            scope_kind: "ALL",
            scope_id: "22222222-2222-4222-8222-222222222222",
            source_type: "ROLE_BUNDLE",
            source_id: null,
          },
          {
            capability: "recruiter_master_manage",
            scope_kind: "ALL",
            scope_id: null,
            source_type: "ROLE_BUNDLE",
            source_id: null,
          },
          {
            capability: "team_master_manage",
            scope_kind: "ALL",
            scope_id: null,
            source_type: "ROLE_BUNDLE",
            source_id: null,
          },
        ],
      }),
    ),
    false,
  );

  // Disabled actor fails closed even with grants present
  assert.equal(hasPairedFullAdminAuthority(makeFullAdminActor({ enabled: false })), false);

  // Missing effective_grants fails closed
  assert.equal(
    hasPairedFullAdminAuthority(makeFullAdminActor({ effective_grants: undefined })),
    false,
  );
  assert.equal(hasPairedFullAdminAuthority(null), false);
});

test("hasPairedGrantsAdminAuthority and effectiveAccessAdminNavPredicate enforce paired grants when present", () => {
  assert.equal(
    hasPairedGrantsAdminAuthority(makeFullAdminActor().effective_grants),
    true,
  );
  assert.equal(hasPairedGrantsAdminAuthority([]), false);
  assert.equal(hasPairedGrantsAdminAuthority(null), false);

  assert.equal(
    effectiveAccessAdminNavPredicate({
      capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
      scopes: [{ kind: "all" }],
      effective_grants: makeFullAdminActor().effective_grants,
    }),
    true,
  );

  // Catalog operator only cannot see effective-access admin tab
  assert.equal(
    effectiveAccessAdminNavPredicate({
      capabilities: ["catalog_master_manage"],
      scopes: [{ kind: "all" }],
      effective_grants: [{ capability: "catalog_master_manage", scope_kind: "ALL", scope_id: null }],
    }),
    false,
  );

  // Legacy NavActorProjection without effective_grants delegates to canonical Full Admin triple check
  assert.equal(
    effectiveAccessAdminNavPredicate({
      capabilities: ["entry_admin", "recruiter_master_manage", "team_master_manage"],
      scopes: [{ kind: "all" }],
    }),
    true,
  );
  assert.equal(
    effectiveAccessAdminNavPredicate({
      capabilities: ["entry_admin", "recruiter_master_manage"],
      scopes: [{ kind: "all" }],
    }),
    false,
  );
});

test("decideEffectiveAccessPageAccess maps actor resolutions fail-closed", () => {
  assert.equal(decideEffectiveAccessPageAccess({ actor: null }), "TEMPORARY_UNAVAILABLE");
  assert.equal(
    decideEffectiveAccessPageAccess({ actor: { ok: false, reason: "UNAUTHENTICATED" } }),
    "REDIRECT_LOGIN",
  );
  assert.equal(
    decideEffectiveAccessPageAccess({ actor: { ok: false, reason: "ACTOR_DISABLED" } }),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    decideEffectiveAccessPageAccess({ actor: { ok: false, reason: "ACTOR_MAPPING_MISSING" } }),
    "ACCOUNT_UNAVAILABLE",
  );
  assert.equal(
    decideEffectiveAccessPageAccess({ actor: { ok: false, reason: "LOOKUP_FAILED" } }),
    "TEMPORARY_UNAVAILABLE",
  );
  assert.equal(
    decideEffectiveAccessPageAccess({
      actor: { ok: true, actor: makeFullAdminActor() },
    }),
    "ALLOW",
  );
  assert.equal(
    decideEffectiveAccessPageAccess({
      actor: {
        ok: true,
        actor: makeFullAdminActor({
          effective_grants: [
            { capability: "entry_own", scope_kind: "OWN", scope_id: null },
          ],
        }),
      },
    }),
    "ACCESS_DENIED",
  );
});

test("server page gates for /admin/access/groups, /admin/access/effective, and /admin/access/accounts use trusted server authority", () => {
  const groupsPageSrc = readFileSync(
    path.join(repoRoot, "src/app/admin/access/groups/page.tsx"),
    "utf8",
  );
  assert.match(groupsPageSrc, /resolveActorForRequest/);
  assert.match(groupsPageSrc, /decideEffectiveAccessPageAccess/);
  assert.match(groupsPageSrc, /redirect\("\/login\?next=\/admin\/access\/groups"\)/);
  assert.doesNotMatch(groupsPageSrc, /use client|@supabase|createClient|email/i);

  const effectivePageSrc = readFileSync(
    path.join(repoRoot, "src/app/admin/access/effective/page.tsx"),
    "utf8",
  );
  assert.match(effectivePageSrc, /resolveActorForRequest/);
  assert.match(effectivePageSrc, /decideEffectiveAccessPageAccess/);
  assert.match(effectivePageSrc, /redirect\("\/login\?next=\/admin\/access\/groups"\)/);
  assert.match(effectivePageSrc, /resolveLegacyEffectiveRedirectTarget/);
  assert.match(effectivePageSrc, /await searchParams/);
  assert.doesNotMatch(effectivePageSrc, /use client|@supabase|createClient|email/i);

  const accountsPageSrc = readFileSync(
    path.join(repoRoot, "src/app/admin/access/accounts/page.tsx"),
    "utf8",
  );
  assert.match(accountsPageSrc, /resolveActorForRequest/);
  assert.match(accountsPageSrc, /decideAccountAccessPageAccess/);
  assert.match(accountsPageSrc, /resolveLegacyAccountsRedirectTarget/);
  assert.match(accountsPageSrc, /await searchParams/);
  assert.doesNotMatch(accountsPageSrc, /@gmail|@hrp|owner@|email/i);
});
