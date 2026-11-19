import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_NON_AUTO_GRANT_TOKENS,
  CANONICAL_OWNER_EMAIL,
  INITIAL_ADMIN_LOGIN_IDS,
  INTENTIONAL_POLICY_CHANGE_REASONS,
  PROTECTED_OWNER_REASON,
  WP5_CUTOVER_MANIFEST_VERSION,
  WP5_ROLE_CATALOG,
  buildWp5CutoverPlan,
  buildWp5FullCutoverManifest,
  computeWp5CutoverActionDiff,
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


test("buildWp5FullCutoverManifest and computeWp5CutoverActionDiff cover full cohort, intentional shifts, WR delegation non-escalation, and reject unexpected drift", () => {
  const TL_ID = "10000000-0000-4000-8000-000000000007";
  const HAIDX_ID = "10000000-0000-4000-8000-000000000008";
  const KT_ID = "10000000-0000-4000-8000-000000000009";
  const CATALOG_ONLY_ID = "10000000-0000-4000-8000-000000000010";
  const HR_OP_ID = "10000000-0000-4000-8000-000000000011";
  const SHARED_ID = "10000000-0000-4000-8000-000000000012";
  const TEAM_1 = "20000000-0000-4000-8000-000000000001";
  const REC_1 = "30000000-0000-4000-8000-000000000001";

  const inventory = {
    authorization_date: "2026-11-18",
    accounts: [
      {
        app_user_id: OWNER_ID,
        auth_subject: "90000000-0000-4000-8000-000000000001",
        email: "nobita6986@gmail.com",
        display_name: "Owner",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: LUANPT_ID,
        auth_subject: "90000000-0000-4000-8000-000000000002",
        email: "luanpt@hrpartner.vn",
        display_name: "Luan PT",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: LIENVU_ID,
        auth_subject: "90000000-0000-4000-8000-000000000003",
        email: "lienvu@hrpartner.vn",
        display_name: "Lien Vu",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: NGATTT_ID,
        auth_subject: "90000000-0000-4000-8000-000000000004",
        email: "ngattt@hrpartner.vn",
        display_name: "Nga TTT",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: TL_ID,
        auth_subject: "90000000-0000-4000-8000-000000000007",
        email: "tl.user@hrpartner.vn",
        display_name: "Team Leader",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: HAIDX_ID,
        auth_subject: "90000000-0000-4000-8000-000000000008",
        email: "haidx.td@hrpartner.vn",
        display_name: "Hai DX",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: KT_ID,
        auth_subject: "90000000-0000-4000-8000-000000000009",
        email: "hieu.kt@hrpartner.vn",
        display_name: "Ke Toan",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: CATALOG_ONLY_ID,
        auth_subject: "90000000-0000-4000-8000-000000000010",
        email: "catalog.only@hrpartner.vn",
        display_name: "Catalog Only",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: HR_OP_ID,
        auth_subject: "90000000-0000-4000-8000-000000000011",
        email: "hrop@hrpartner.vn",
        display_name: "HR Operator",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: DISABLED_HIST_ID,
        auth_subject: "90000000-0000-4000-8000-000000000005",
        email: "former.staff@hrpartner.vn",
        display_name: "Disabled",
        enabled: false,
        account_type: "NORMAL",
        version: 2,
      },
      {
        app_user_id: SHARED_ID,
        auth_subject: "90000000-0000-4000-8000-000000000012",
        email: "shared.bot@hrpartner.vn",
        display_name: "Shared Service",
        enabled: true,
        account_type: "SHARED",
        version: 1,
      },
    ],
    capability_grants: [
      { app_user_id: OWNER_ID, capability: "entry_admin" },
      { app_user_id: OWNER_ID, capability: "worker_edit_history_view" },
      { app_user_id: LIENVU_ID, capability: "entry_admin" },
      { app_user_id: NGATTT_ID, capability: "entry_admin" },
      // luanpt deliberately has 0 capabilities and orphan ALL scope
      // TL has partial bundle (missing entry_team) -> should normalize via TEAM_LEADER_BUNDLE_ENTRY_TEAM_NORMALIZED
      { app_user_id: TL_ID, capability: "team_manager_assign" },
      { app_user_id: TL_ID, capability: "report_view" },
      { app_user_id: TL_ID, capability: "report_analytics_view" },
      { app_user_id: TL_ID, capability: "report_assign" },
      // haidx.td holds full RECRUITER bundle
      ...WP5_ROLE_CATALOG.RECRUITER.capabilities.map((c) => ({
        app_user_id: HAIDX_ID,
        capability: c.capability,
      })),
      // catalog-only operator has catalog_master_manage @ ALL without team_master_manage
      { app_user_id: CATALOG_ONLY_ID, capability: "catalog_master_manage" },
      // HR operator has exact HR_OPERATOR bundle
      ...WP5_ROLE_CATALOG.HR_OPERATOR.capabilities.map((c) => ({
        app_user_id: HR_OP_ID,
        capability: c.capability,
      })),
    ],
    scope_grants: [
      { app_user_id: OWNER_ID, scope_kind: "all", team_id: null },
      { app_user_id: LUANPT_ID, scope_kind: "all", team_id: null },
      { app_user_id: LIENVU_ID, scope_kind: "all", team_id: null },
      { app_user_id: NGATTT_ID, scope_kind: "all", team_id: null },
      { app_user_id: TL_ID, scope_kind: "team", team_id: TEAM_1 },
      { app_user_id: HAIDX_ID, scope_kind: "own", team_id: null },
      { app_user_id: CATALOG_ONLY_ID, scope_kind: "all", team_id: null },
      { app_user_id: HR_OP_ID, scope_kind: "all", team_id: null },
    ],
    recruiter_links: [
      { app_user_id: HAIDX_ID, recruiter_id: REC_1, recruiter_active: true },
    ],
    team_leader_assignments: [
      { assignment_id: "40000000-0000-4000-8000-000000000001", leader_app_user_id: TL_ID, team_id: TEAM_1 },
    ],
    wr_tl_capability_grants: [],
    department_heads: [],
    project_managers: [],
    project_accountants: [],
    open_person_links: [
      { app_user_id: KT_ID, person_id: "50000000-0000-4000-8000-000000000009", person_status: "ACTIVE" },
    ],
    // Template-scoped Work Report delegation to haidx.td MUST NOT produce report_review/report_assign grants
    work_report_delegations: [
      {
        delegation_id: "60000000-0000-4000-8000-000000000001",
        template_id: "0922819d-6957-4b1d-8e50-b749f5cd35c5",
        grantee_app_user_id: HAIDX_ID,
      },
    ],
  };

  const manifest = buildWp5FullCutoverManifest(inventory);
  assert.match(manifest.manifest_fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(manifest.summary.admin_count, 4);
  assert.equal(manifest.summary.protected_assignment_count, 1);
  assert.equal(manifest.summary.work_report_delegation_count, 1);

  const luanPlan = manifest.account_plans.find((p) => p.app_user_id === LUANPT_ID);
  assert.ok(luanPlan);
  assert.deepEqual(luanPlan.global_roles, ["EMPLOYEE_BASE", "ADMIN"]);
  assert.equal(
    luanPlan.post_cutover_effective_grants.some((g) => g.capability === "recruitment_post_create"),
    false,
  );

  const haidxPlan = manifest.account_plans.find((p) => p.app_user_id === HAIDX_ID);
  assert.ok(haidxPlan);
  assert.deepEqual(haidxPlan.global_roles, ["EMPLOYEE_BASE", "RECRUITER"]);
  assert.equal(
    haidxPlan.post_cutover_effective_grants.some(
      (g) => g.capability === "report_review" || g.capability === "report_assign",
    ),
    false,
  );

  const ktPlan = manifest.account_plans.find((p) => p.app_user_id === KT_ID);
  assert.deepEqual(ktPlan.global_roles, ["EMPLOYEE_BASE"]);
  assert.equal(ktPlan.post_cutover_effective_grants.length, 0);

  const disabledPlan = manifest.account_plans.find((p) => p.app_user_id === DISABLED_HIST_ID);
  assert.equal(disabledPlan.set_authz_managed, true);
  assert.deepEqual(disabledPlan.global_roles, []);
  assert.deepEqual(disabledPlan.post_cutover_effective_grants, []);

  const sharedPlan = manifest.account_plans.find((p) => p.app_user_id === SHARED_ID);
  assert.equal(sharedPlan.set_authz_managed, true);
  assert.deepEqual(sharedPlan.global_roles, []);

  const diff = computeWp5CutoverActionDiff(inventory, manifest);
  assert.equal(diff.unexpected_diff_count, 0, JSON.stringify(diff.rows.filter((r) => r.anomalies.length > 0)));
  const catalogRow = diff.rows.find((r) => r.app_user_id === CATALOG_ONLY_ID);
  assert.equal(catalogRow.before_actions.can_manage_team_leaders, true);
  assert.equal(catalogRow.after_actions.can_manage_team_leaders, false);
  assert.ok(catalogRow.reasons.includes(INTENTIONAL_POLICY_CHANGE_REASONS.CATALOG_ONLY_TEAM_LEADER_MUTATION_TIGHTENED));

  const hrOpRow = diff.rows.find((r) => r.app_user_id === HR_OP_ID);
  assert.equal(hrOpRow.before_actions.can_manage_team_leaders, true);
  assert.equal(hrOpRow.after_actions.can_manage_team_leaders, true);

  const tlRow = diff.rows.find((r) => r.app_user_id === TL_ID);
  assert.ok(tlRow.reasons.includes(INTENTIONAL_POLICY_CHANGE_REASONS.TEAM_LEADER_BUNDLE_ENTRY_TEAM_NORMALIZED));

  // Negative check: reject non-NORMAL account holding personal links/assignments
  assert.throws(
    () =>
      buildWp5FullCutoverManifest({
        ...inventory,
        open_person_links: [
          ...inventory.open_person_links,
          { app_user_id: SHARED_ID, person_id: "50000000-0000-4000-8000-000000000099", person_status: "ACTIVE" },
        ],
      }),
    /NON_NORMAL_ACCOUNT_PERSONAL_ASSIGNMENT_VIOLATION/,
  );

  // Negative check: detect UNEXPECTED_DIFF when manifest omits an account's legacy grant or injects unexpected grant
  const corruptedManifest = structuredClone(manifest);
  const haidxMut = corruptedManifest.account_plans.find((p) => p.app_user_id === HAIDX_ID);
  haidxMut.post_cutover_effective_grants.push({
    capability: "report_review",
    scope_kind: "ALL",
    scope_id: null,
  });
  const corruptedDiff = computeWp5CutoverActionDiff(inventory, corruptedManifest);
  assert.equal(corruptedDiff.unexpected_diff_count, 1);
  const failedHaidx = corruptedDiff.rows.find((r) => r.app_user_id === HAIDX_ID);
  assert.equal(failedHaidx.classification, "UNEXPECTED_DIFF");
  assert.ok(failedHaidx.anomalies.some((a) => a.startsWith("UNEXPECTED_NON_ADMIN_GAINS")));
});

test("manifest_fingerprint detects account version/enabled/type & source drift and preserves D10-suspended roles", () => {
  const OWNER_SUBJ = "90000000-0000-4000-8000-000000000001";
  const D10_REC_ID = "10000000-0000-4000-8000-000000000021";
  const D10_REC_RID = "30000000-0000-4000-8000-000000000021";
  const EXTRA_ID = "10000000-0000-4000-8000-000000000022";

  const makeBaseInventory = () => ({
    authorization_date: "2026-11-19",
    accounts: [
      {
        app_user_id: OWNER_ID,
        auth_subject: OWNER_SUBJ,
        email: "nobita6986@gmail.com",
        display_name: "Owner",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: LUANPT_ID,
        auth_subject: "90000000-0000-4000-8000-000000000002",
        email: "luanpt@hrpartner.vn",
        display_name: "Luan PT",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: LIENVU_ID,
        auth_subject: "90000000-0000-4000-8000-000000000003",
        email: "lienvu@hrpartner.vn",
        display_name: "Lien Vu",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: NGATTT_ID,
        auth_subject: "90000000-0000-4000-8000-000000000004",
        email: "ngattt@hrpartner.vn",
        display_name: "Nga TTT",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
      {
        app_user_id: DISABLED_HIST_ID,
        auth_subject: "90000000-0000-4000-8000-000000000005",
        email: "former.staff@hrpartner.vn",
        display_name: "Former Staff",
        enabled: false,
        account_type: "NORMAL",
        version: 2,
      },
      {
        app_user_id: D10_REC_ID,
        auth_subject: "90000000-0000-4000-8000-000000000021",
        email: "d10.rec@hrpartner.vn",
        display_name: "D10 Suspended Recruiter",
        enabled: false,
        account_type: "NORMAL",
        version: 2,
      },
      {
        app_user_id: EXTRA_ID,
        auth_subject: "90000000-0000-4000-8000-000000000022",
        email: "extra.base@hrpartner.vn",
        display_name: "Extra Base",
        enabled: true,
        account_type: "NORMAL",
        version: 1,
      },
    ],
    capability_grants: [
      { app_user_id: OWNER_ID, capability: "entry_admin" },
      { app_user_id: LIENVU_ID, capability: "entry_admin" },
      { app_user_id: NGATTT_ID, capability: "entry_admin" },
    ],
    scope_grants: [
      { app_user_id: OWNER_ID, scope_kind: "all", team_id: null },
      { app_user_id: LUANPT_ID, scope_kind: "all", team_id: null },
      { app_user_id: LIENVU_ID, scope_kind: "all", team_id: null },
      { app_user_id: NGATTT_ID, scope_kind: "all", team_id: null },
    ],
    recruiter_links: [],
    team_leader_assignments: [],
    wr_tl_capability_grants: [],
    department_heads: [],
    project_managers: [],
    project_accountants: [],
    open_person_links: [],
    work_report_delegations: [],
    suspended_capability_grants: WP5_ROLE_CATALOG.RECRUITER.capabilities.map((c) => ({
      app_user_id: D10_REC_ID,
      capability: c.capability,
    })),
    suspended_scope_grants: [
      { grant_id: "70000000-0000-4000-8000-000000000021", app_user_id: D10_REC_ID, scope_kind: "own", team_id: null },
    ],
    suspended_recruiter_links: [
      {
        link_id: "71000000-0000-4000-8000-000000000021",
        app_user_id: D10_REC_ID,
        recruiter_id: D10_REC_RID,
        recruiter_active: true,
      },
    ],
    suspended_team_leader_assignments: [],
    suspended_wr_tl_capability_grants: [],
    existing_open_roles: [],
    existing_open_direct_grants: [],
  });

  const baseInv = makeBaseInventory();
  const baseManifest = buildWp5FullCutoverManifest(baseInv);
  const baseDiff = computeWp5CutoverActionDiff(baseInv, baseManifest);
  assert.equal(baseDiff.unexpected_diff_count, 0);

  const histPlan = baseManifest.account_plans.find((p) => p.app_user_id === DISABLED_HIST_ID);
  assert.equal(histPlan.d10_suspended, false);
  assert.deepEqual(histPlan.global_roles, []);
  assert.deepEqual(histPlan.post_cutover_effective_grants, []);

  const d10Plan = baseManifest.account_plans.find((p) => p.app_user_id === D10_REC_ID);
  assert.equal(d10Plan.enabled, false);
  assert.equal(d10Plan.d10_suspended, true);
  assert.deepEqual(d10Plan.global_roles, ["EMPLOYEE_BASE", "RECRUITER"]);
  assert.deepEqual(d10Plan.post_cutover_effective_grants, []);

  // Mutating version, enabled, account_type, or delegation sources MUST change manifest_fingerprint
  const invVer = makeBaseInventory();
  invVer.accounts.find((a) => a.app_user_id === EXTRA_ID).version = 2;
  assert.notEqual(
    buildWp5FullCutoverManifest(invVer).manifest_fingerprint,
    baseManifest.manifest_fingerprint,
  );

  const invDisabled = makeBaseInventory();
  invDisabled.accounts.find((a) => a.app_user_id === EXTRA_ID).enabled = false;
  assert.notEqual(
    buildWp5FullCutoverManifest(invDisabled).manifest_fingerprint,
    baseManifest.manifest_fingerprint,
  );

  const invType = makeBaseInventory();
  invType.accounts.find((a) => a.app_user_id === EXTRA_ID).account_type = "SHARED";
  assert.notEqual(
    buildWp5FullCutoverManifest(invType).manifest_fingerprint,
    baseManifest.manifest_fingerprint,
  );

  const invDeleg = makeBaseInventory();
  invDeleg.work_report_delegations.push({
    delegation_id: "60000000-0000-4000-8000-000000000099",
    template_id: "0922819d-6957-4b1d-8e50-b749f5cd35c5",
    grantee_app_user_id: EXTRA_ID,
  });
  assert.notEqual(
    buildWp5FullCutoverManifest(invDeleg).manifest_fingerprint,
    baseManifest.manifest_fingerprint,
  );
});
