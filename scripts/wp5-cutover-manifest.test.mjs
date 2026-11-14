import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_NON_AUTO_GRANT_TOKENS,
  CANONICAL_OWNER_EMAIL,
  INITIAL_ADMIN_LOGIN_IDS,
  PROTECTED_OWNER_REASON,
  WP5_CUTOVER_MANIFEST_VERSION,
  WP5_ROLE_CATALOG,
  buildWp5CutoverPlan,
  isCanonicalOwnerEmail,
  normalizeCanonicalEmail,
  resolveCanonicalOwnerAccount,
} from "./lib/wp5-cutover-manifest.mjs";

const OWNER_ID = "10000000-0000-4000-8000-000000000001";
const LUANPT_ID = "10000000-0000-4000-8000-000000000002";
const LIENVU_ID = "10000000-0000-4000-8000-000000000003";
const NGATTT_ID = "10000000-0000-4000-8000-000000000004";
const DISABLED_HIST_ID = "10000000-0000-4000-8000-000000000005";
const COLLISION_ID = "10000000-0000-4000-8000-000000000006";

function baseAccounts() {
  return [
    {
      app_user_id: COLLISION_ID,
      email: "nobita6986@hrpartner.vn",
      login_id: "nobita.hrp",
      display_name: "Same Local-Part Non-Owner",
      enabled: true,
      version: 1,
    },
    {
      app_user_id: OWNER_ID,
      email: "  Nobita6986@GMAIL.com ",
      display_name: "Canonical Owner",
      enabled: true,
      version: 2,
    },
    {
      app_user_id: LUANPT_ID,
      email: "luanpt@hrpartner.vn",
      display_name: "Phan Thành Luân",
      enabled: true,
      version: 1,
    },
    {
      app_user_id: LIENVU_ID,
      email: "lienvu@hrpartner.vn",
      display_name: "Vũ Liên",
      enabled: true,
      version: 1,
    },
    {
      app_user_id: NGATTT_ID,
      email: "ngattt@hrpartner.vn",
      display_name: "Trần Thị Thu Ngà",
      enabled: true,
      version: 1,
    },
    {
      app_user_id: DISABLED_HIST_ID,
      email: "former.staff@hrpartner.vn",
      display_name: "Former Staff",
      enabled: false,
      version: 4,
    },
  ];
}

test("normalizeCanonicalEmail and isCanonicalOwnerEmail strictly match nobita6986@gmail.com only", () => {
  assert.equal(CANONICAL_OWNER_EMAIL, "nobita6986@gmail.com");
  assert.equal(normalizeCanonicalEmail("  Nobita6986@Gmail.COM  "), "nobita6986@gmail.com");
  assert.equal(isCanonicalOwnerEmail("  Nobita6986@Gmail.COM  "), true);

  for (const nonCanonical of [
    "nobita6986@hrpartner.vn",
    "nobita6986+tag@gmail.com",
    "other@gmail.com",
    "nobita6986@gmail..com",
    "nobita6986 @gmail.com",
    "nobita6986@gmail.com\n",
    "",
    null,
    123,
  ]) {
    assert.equal(isCanonicalOwnerEmail(nonCanonical), false, String(nonCanonical));
  }
});

test("resolveCanonicalOwnerAccount logs non-canonical local-part collisions and fails closed on missing, ambiguous, or invalid UUID", () => {
  const resolved = resolveCanonicalOwnerAccount(baseAccounts());
  assert.equal(resolved.app_user_id, OWNER_ID);
  assert.equal(resolved.email, CANONICAL_OWNER_EMAIL);
  assert.equal(resolved.rejected_local_part_collisions.length, 1);
  assert.deepEqual(resolved.rejected_local_part_collisions[0], {
    index: 0,
    app_user_id: COLLISION_ID,
    email: "nobita6986@hrpartner.vn",
    login_id: "nobita.hrp",
  });

  // Even if nobita6986@hrpartner.vn exists, missing exact nobita6986@gmail.com MUST throw
  assert.throws(
    () =>
      resolveCanonicalOwnerAccount([
        { app_user_id: COLLISION_ID, email: "nobita6986@hrpartner.vn", enabled: true },
      ]),
    /CANONICAL_OWNER_NOT_FOUND/,
  );

  // Duplicate exact nobita6986@gmail.com MUST throw
  assert.throws(
    () =>
      resolveCanonicalOwnerAccount([
        { app_user_id: OWNER_ID, email: "nobita6986@gmail.com", enabled: true },
        { app_user_id: COLLISION_ID, email: "NOBITA6986@gmail.com", enabled: true },
      ]),
    /CANONICAL_OWNER_AMBIGUOUS/,
  );

  // Invalid UUID MUST throw
  assert.throws(
    () =>
      resolveCanonicalOwnerAccount([
        { app_user_id: "not-a-uuid", email: "nobita6986@gmail.com", enabled: true },
      ]),
    /CANONICAL_OWNER_INVALID_ACCOUNT_ID/,
  );
});

test("buildWp5CutoverPlan emits exact 4 ADMIN assignments, 1 protected Owner, legacy remediations, D10 disabled preservation, and deterministic fingerprint", () => {
  assert.deepEqual(INITIAL_ADMIN_LOGIN_IDS, ["luanpt", "lienvu", "ngattt"]);
  assert.equal(PROTECTED_OWNER_REASON, "PROTECTED_OWNER_ADMIN");
  assert.equal(ADMIN_NON_AUTO_GRANT_TOKENS.length, 8);
  assert.equal(Object.keys(WP5_ROLE_CATALOG).length, 8);

  const planA = buildWp5CutoverPlan(baseAccounts());
  const planB = buildWp5CutoverPlan([...baseAccounts()].reverse());

  assert.equal(planA.schema_version, WP5_CUTOVER_MANIFEST_VERSION);
  assert.equal(planA.dry_run, true);
  assert.equal(planA.role_catalog_summary.role_count, 8);
  assert.equal(planA.role_catalog_summary.admin_capability_count, 21);
  assert.equal(planA.role_catalog_summary.admin_excluded_tokens.length, 8);

  assert.equal(planA.admin_assignments.length, 4);
  const ownerRow = planA.admin_assignments.find((row) => row.app_user_id === OWNER_ID);
  assert.ok(ownerRow);
  assert.equal(ownerRow.is_canonical_owner, true);
  assert.equal(ownerRow.is_protected, true);
  assert.equal(ownerRow.protected_reason, "PROTECTED_OWNER_ADMIN");
  assert.equal(ownerRow.can_revoke, false);
  assert.equal(ownerRow.cannot_revoke_reason, "PROTECTED_OWNER_ADMIN");

  const nonOwnerAdmins = planA.admin_assignments.filter((row) => row.app_user_id !== OWNER_ID);
  assert.equal(nonOwnerAdmins.length, 3);
  assert.deepEqual(
    nonOwnerAdmins.map((row) => row.login_id),
    ["luanpt", "lienvu", "ngattt"],
  );
  for (const row of nonOwnerAdmins) {
    assert.equal(row.is_canonical_owner, false);
    assert.equal(row.is_protected, false);
    assert.equal(row.can_revoke, true);
    assert.equal(row.cannot_revoke_reason, null);
  }

  assert.deepEqual(planA.account_state_updates.disabled_accounts_zero_effective_grants_ids, [DISABLED_HIST_ID]);
  assert.equal(planA.account_state_updates.set_authz_managed_true_app_user_ids.includes(DISABLED_HIST_ID), false);
  assert.equal(planA.legacy_remediations.length, 2);
  assert.equal(planA.legacy_remediations[0].action, "CLOSE_UNMAPPED_ALL_SCOPE");
  assert.equal(planA.legacy_remediations[0].app_user_id, LUANPT_ID);
  assert.equal(planA.legacy_remediations[1].action, "ABSORB_CCCD_EXCEPTION_INTO_ADMIN_BUNDLE");

  assert.deepEqual(planA.invariants, {
    protected_assignment_count: 1,
    protected_only_on_canonical_owner: true,
    no_last_admin_lock: true,
    recruitment_post_create_pm_only: true,
    admin_excluded_tokens_verified: true,
    rejected_local_part_collision_count: 1,
  });

  // Note: rejected_local_part_collisions records original array index so same ordering is bit-identical;
  // without collisions, reversed array also produces identical plan_fingerprint.
  const withoutCollisionA = baseAccounts().slice(1);
  const withoutCollisionB = [...withoutCollisionA].reverse();
  assert.equal(
    buildWp5CutoverPlan(withoutCollisionA).plan_fingerprint,
    buildWp5CutoverPlan(withoutCollisionB).plan_fingerprint,
  );
  assert.match(planA.plan_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(planB.plan_fingerprint.length, 64);

  // Fail closed if Owner is disabled
  assert.throws(
    () =>
      buildWp5CutoverPlan(
        baseAccounts().map((a) => (a.app_user_id === OWNER_ID ? { ...a, enabled: false } : a)),
      ),
    /CANONICAL_OWNER_DISABLED/,
  );

  // Fail closed if initial admin is missing, disabled, or ambiguous
  assert.throws(
    () => buildWp5CutoverPlan(baseAccounts().filter((a) => a.app_user_id !== NGATTT_ID)),
    /INITIAL_ADMIN_NOT_FOUND/,
  );
  assert.throws(
    () =>
      buildWp5CutoverPlan(
        baseAccounts().map((a) => (a.app_user_id === LIENVU_ID ? { ...a, enabled: false } : a)),
      ),
    /INITIAL_ADMIN_ACCOUNT_DISABLED/,
  );
  assert.throws(
    () =>
      buildWp5CutoverPlan([
        ...baseAccounts(),
        { app_user_id: "10000000-0000-4000-8000-000000000099", email: "luanpt@example.com", enabled: true },
      ]),
    /INITIAL_ADMIN_AMBIGUOUS/,
  );
});
