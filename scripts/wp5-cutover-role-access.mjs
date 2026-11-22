#!/usr/bin/env node
/**
 * WP5B-2 — Idempotent Cutover Backfill & Verification CLI/Library
 *
 * Modes:
 *   --read-only-plan   Runs strictly inside REPEATABLE READ READ ONLY + ROLLBACK.
 *                      Produces deterministic manifest_fingerprint and before/after action diff.
 *   --dry-run          Runs the full cutover transaction + SQL postconditions inside BEGIN...ROLLBACK.
 *   --apply            Applies the cutover inside a single transaction and COMMITs.
 *                      Requires BOTH --confirm-apply AND --expected-fingerprint <sha256>.
 */

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADMIN_NON_AUTO_GRANT_TOKENS,
  PROTECTED_OWNER_REASON,
  WP5_ROLE_CATALOG,
  buildWp5FullCutoverManifest,
  computeWp5CutoverActionDiff,
} from "./lib/wp5-cutover-manifest.mjs";
import { parseExternalNwcConfig } from "./run-wp2a-effective-access-shadow.mjs";

const DEFAULT_NWC_CONFIG = "C:/importal/db-test-nwc/DB-staging-for-VPS-nwc.txt";
const SHA256_RE = /^[a-f0-9]{64}$/i;
const ADMIN_BUNDLE_CAPABILITIES = Object.freeze(
  WP5_ROLE_CATALOG.ADMIN.capabilities.map((c) => c.capability),
);

function grantKey(grant) {
  return `${grant.capability}::${grant.scope_kind}::${grant.scope_id ?? ""}`;
}

function uniqueSortedGrantKeys(grants) {
  return [...new Set((grants ?? []).map(grantKey))].sort();
}

function isLoopbackHost(hostname) {
  const lower = String(hostname || "").toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "::1" || lower === "[::1]";
}

/**
 * Parses CLI flags for wp5-cutover-role-access.mjs.
 */
export function parseCutoverCliArgs(argv) {
  const args = {
    mode: null,
    confirmApply: false,
    expectedFingerprint: null,
    nwcStaging: false,
    configPath: process.env.WP5_NWC_CONFIG_FILE || DEFAULT_NWC_CONFIG,
    dbUrl: process.env.DATABASE_URL || null,
    allowRemoteTarget: false,
    outPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--read-only-plan") {
      args.mode = "read-only-plan";
    } else if (token === "--dry-run") {
      args.mode = "dry-run";
    } else if (token === "--apply") {
      args.mode = "apply";
    } else if (token === "--confirm-apply") {
      args.confirmApply = true;
    } else if (token === "--expected-fingerprint" && argv[i + 1]) {
      args.expectedFingerprint = argv[++i].trim().toLowerCase();
    } else if (token === "--nwc-staging") {
      args.nwcStaging = true;
    } else if (token === "--config" && argv[i + 1]) {
      args.configPath = path.resolve(argv[++i]);
    } else if (token === "--db-url" && argv[i + 1]) {
      args.dbUrl = argv[++i];
    } else if (token === "--allow-remote-target") {
      args.allowRemoteTarget = true;
    } else if (token === "--out" && argv[i + 1]) {
      args.outPath = path.resolve(argv[++i]);
    } else if (token === "--help" || token === "-h") {
      console.log(
        [
          "Usage:",
          "  node scripts/wp5-cutover-role-access.mjs --read-only-plan (--nwc-staging --config <path> | --db-url <url>) [--out <jsonPath>]",
          "  node scripts/wp5-cutover-role-access.mjs --dry-run (--db-url <url> | --nwc-staging --config <path>) [--expected-fingerprint <sha256>] [--out <jsonPath>]",
          "  node scripts/wp5-cutover-role-access.mjs --apply --confirm-apply --expected-fingerprint <sha256> (--db-url <url> | --nwc-staging --config <path>) [--out <jsonPath>]",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown CLI argument: ${token}`);
    }
  }

  if (!args.mode) {
    throw new Error("Specify exactly one mode: --read-only-plan, --dry-run, or --apply");
  }
  if (args.mode === "apply") {
    if (!args.confirmApply) {
      throw new Error("Refusing --apply without explicit --confirm-apply guard");
    }
    if (!args.expectedFingerprint || !SHA256_RE.test(args.expectedFingerprint)) {
      throw new Error("Refusing --apply without valid 64-hex --expected-fingerprint <sha256>");
    }
  } else if (args.expectedFingerprint && !SHA256_RE.test(args.expectedFingerprint)) {
    throw new Error("Invalid --expected-fingerprint: must be 64 hex characters");
  }

  if (args.nwcStaging && args.mode !== "read-only-plan" && !args.allowRemoteTarget && !args.confirmApply) {
    // dry-run on NWC is still safe if explicitly invoked, but block accidental unguarded remote writes unless expected flags match
  }

  if (!args.nwcStaging) {
    if (!args.dbUrl) {
      throw new Error("Specify --nwc-staging or --db-url <postgres-url>");
    }
    const parsed = new URL(args.dbUrl);
    if (!isLoopbackHost(parsed.hostname) && !args.allowRemoteTarget) {
      throw new Error(
        `Refusing non-loopback target "${parsed.hostname}" without --allow-remote-target`,
      );
    }
  }

  return args;
}

/**
 * Reads DB baseline metadata (system state and migration ledger count) without writing.
 */
export async function readCutoverSystemState(queryable) {
  const sysRes = await queryable.query(
    `select singleton_id, cutover_ready, cutover_at::text as cutover_at, updated_at::text as updated_at,
            updated_by_app_user_id::text as updated_by_app_user_id
       from public.authz_system_state
      where singleton_id = true`,
  );
  if (sysRes.rows.length !== 1) {
    throw new Error("AUTHZ_SYSTEM_STATE_ROW_MISSING");
  }

  const regRes = await queryable.query(
    `select (pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null) as has_supabase_migrations,
            (pg_catalog.to_regprocedure('public.worker_edit_history_is_allowlisted_admin(uuid,uuid)') is not null) as has_legacy_allowlist_fn`,
  );
  let migrationCount = null;
  let latestMigrationVersion = null;
  if (regRes.rows[0]?.has_supabase_migrations) {
    const migRes = await queryable.query(
      `select count(*)::int as cnt, max(version)::text as max_version
         from supabase_migrations.schema_migrations`,
    );
    migrationCount = migRes.rows[0]?.cnt ?? null;
    latestMigrationVersion = migRes.rows[0]?.max_version ?? null;
  }

  return {
    ...sysRes.rows[0],
    supabase_migration_count: migrationCount,
    latest_supabase_migration_version: latestMigrationVersion,
    wp5b2_migration_applied: regRes.rows[0]?.has_legacy_allowlist_fn === false,
  };
}

/**
 * Reads the complete read-only cutover inventory from live SQL tables.
 */
export async function readCutoverInventory(queryable) {
  const authDateRes = await queryable.query(
    `select public.direct_entry_authorization_date()::text as authorization_date`,
  );
  const colCheck = await queryable.query(
    `select exists (
       select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'direct_entry_app_users'
          and column_name = 'account_type'
     ) as has_account_type`,
  );
  const accountTypeExpr = colCheck.rows[0]?.has_account_type
    ? "u.account_type"
    : "'NORMAL'::text";
  const accountsRes = await queryable.query(
    `select
       u.app_user_id::text as app_user_id,
       u.auth_subject::text as auth_subject,
       au.email as email,
       u.display_name as display_name,
       u.enabled as enabled,
       ${accountTypeExpr} as account_type,
       u.authz_managed as authz_managed,
       u.version as version
     from public.direct_entry_app_users u
     left join auth.users au on au.id = u.auth_subject
     order by u.app_user_id asc`,
  );
  const capRes = await queryable.query(
    `select
       g.grant_id::text as grant_id,
       g.app_user_id::text as app_user_id,
       g.capability as capability
     from public.direct_entry_capability_grants g
     where public.direct_entry__internal_capability_grant_effective(g.grant_id)
     order by g.app_user_id asc, g.capability asc`,
  );
  const scopeRes = await queryable.query(
    `select
       s.grant_id::text as grant_id,
       s.app_user_id::text as app_user_id,
       s.scope_kind as scope_kind,
       s.team_id::text as team_id
     from public.direct_entry_scope_grants s
     where (
       (s.scope_kind in ('own', 'all')
        and s.is_current = true
        and not s.suspended_by_account_disable
        and s.valid_from <= public.direct_entry_authorization_date()
        and (s.valid_to is null or (s.valid_to > s.valid_from and public.direct_entry_authorization_date() < s.valid_to)))
       or (s.scope_kind = 'team'
           and public.direct_entry__internal_team_scope_grant_effective(s.grant_id, public.direct_entry_authorization_date()))
     )
     order by s.app_user_id asc, s.scope_kind asc, s.team_id asc nulls first`,
  );
  const linksRes = await queryable.query(
    `select
       rl.link_id::text as link_id,
       rl.app_user_id::text as app_user_id,
       rl.recruiter_id::text as recruiter_id,
       r.active as recruiter_active
     from public.direct_entry_app_user_recruiter_links rl
     join public.recruiters r on r.recruiter_id = rl.recruiter_id
     where rl.verified = true
       and rl.is_current = true
       and rl.valid_from <= public.direct_entry_authorization_date()
       and (rl.valid_to is null or (rl.valid_to > rl.valid_from and public.direct_entry_authorization_date() < rl.valid_to))
     order by rl.app_user_id asc, rl.recruiter_id asc`,
  );
  const tlRes = await queryable.query(
    `select
       tla.assignment_id::text as assignment_id,
       tla.leader_app_user_id::text as leader_app_user_id,
       tla.team_id::text as team_id
     from public.direct_entry_team_leader_assignments tla
     join public.teams t on t.team_id = tla.team_id
       and t.active = true
       and t.code <> '__system_vendor__'
     where public.direct_entry__internal_team_leader_assignment_effective(
       tla.assignment_id,
       public.direct_entry_authorization_date()
     )
     order by tla.leader_app_user_id asc, tla.team_id asc`,
  );
  const wrTlRes = await queryable.query(
    `select
       wr.leader_assignment_id::text as leader_assignment_id,
       tla.leader_app_user_id::text as app_user_id,
       tla.team_id::text as team_id,
       wr.capability as capability,
       wr.capability_grant_id::text as grant_id
     from public.work_report_team_leader_capability_grants wr
     join public.direct_entry_team_leader_assignments tla on tla.assignment_id = wr.leader_assignment_id
     join public.teams t on t.team_id = tla.team_id
       and t.active = true
       and t.code <> '__system_vendor__'
     where wr.capability = 'report_review'
       and public.direct_entry__internal_team_leader_assignment_effective(
         tla.assignment_id,
         public.direct_entry_authorization_date()
       )
       and public.direct_entry__internal_capability_grant_effective(wr.capability_grant_id)
     order by tla.leader_app_user_id asc, tla.team_id asc`,
  );
  const dhRes = await queryable.query(
    `select
       dh.head_assignment_id::text as head_id,
       apl.app_user_id::text as app_user_id,
       dh.department_id::text as department_id,
       (p.status = 'ACTIVE') as person_active
     from public.organization_account_person_links apl
     join public.organization_persons p on p.person_id = apl.person_id
     join public.organization_department_heads dh
       on dh.person_id = apl.person_id
      and dh.ended_at is null
      and dh.started_at <= pg_catalog.clock_timestamp()
     join public.organization_departments dm
       on dm.department_id = dh.department_id
      and dm.is_active = true
     where apl.ended_at is null
     order by apl.app_user_id asc, dh.department_id asc`,
  );
  const pmRes = await queryable.query(
    `select
       pma.assignment_id::text as assignment_id,
       rl.app_user_id::text as app_user_id,
       pma.project_id as project_id
     from public.direct_entry_project_manager_assignments pma
     join public.direct_entry_projects pr
       on pr.project_id = pma.project_id
      and pr.active = true
     join public.recruiters r
       on r.recruiter_id = pma.manager_recruiter_id
      and r.active = true
     join public.direct_entry_app_user_recruiter_links rl
       on rl.recruiter_id = pma.manager_recruiter_id
      and rl.verified = true
      and rl.is_current = true
      and rl.valid_from <= public.direct_entry_authorization_date()
      and (rl.valid_to is null or (rl.valid_to > rl.valid_from and public.direct_entry_authorization_date() < rl.valid_to))
     where pma.is_current = true
       and pma.revoked_at is null
       and pma.valid_from <= public.direct_entry_authorization_date()
       and (pma.valid_to is null or (pma.valid_to > pma.valid_from and public.direct_entry_authorization_date() < pma.valid_to))
       and public.direct_entry_actor_is_assigned_project_manager(rl.app_user_id, pr.project_id)
     order by rl.app_user_id asc, pma.project_id asc`,
  );
  const paRes = await queryable.query(
    `select
       pa.assignment_id::text as assignment_id,
       pa.accountant_user_id::text as accountant_user_id,
       pa.project_id as project_id
     from public.vendor_finance_project_accountants pa
     join public.direct_entry_projects pr
       on pr.project_id = pa.project_id
      and pr.active = true
     where pa.ended_at is null
       and pa.valid_from <= public.direct_entry_authorization_date()
       and (pa.valid_to is null or (pa.valid_to > pa.valid_from and public.direct_entry_authorization_date() < pa.valid_to))
     order by pa.accountant_user_id asc, pa.project_id asc`,
  );
  const personLinksRes = await queryable.query(
    `select
       apl.app_user_id::text as app_user_id,
       apl.person_id::text as person_id,
       p.status as person_status
     from public.organization_account_person_links apl
     join public.organization_persons p on p.person_id = apl.person_id
     where apl.ended_at is null
     order by apl.app_user_id asc, apl.person_id asc`,
  );
  const wrDelegRes = await queryable.query(
    `select
       d.delegation_id::text as delegation_id,
       d.template_id::text as template_id,
       d.delegate_app_user_id::text as grantee_app_user_id
     from public.work_report_delegations d
     where public.work_report__internal_is_delegation_effective(d.delegation_id, statement_timestamp())
     order by d.delegation_id asc`,
  );
  const suspCapRes = await queryable.query(
    `select
       g.app_user_id::text as app_user_id,
       g.capability as capability
     from public.direct_entry_capability_grants g
     join public.direct_entry_app_users u on u.app_user_id = g.app_user_id
     where not u.enabled
       and g.suspended_by_account_disable = true
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or (g.valid_to > g.valid_from and public.direct_entry_authorization_date() < g.valid_to))
     order by g.app_user_id asc, g.capability asc, g.grant_id asc`,
  );
  const suspScopeRes = await queryable.query(
    `select
       s.grant_id::text as grant_id,
       s.app_user_id::text as app_user_id,
       s.scope_kind as scope_kind,
       s.team_id::text as team_id
     from public.direct_entry_scope_grants s
     join public.direct_entry_app_users u on u.app_user_id = s.app_user_id
     left join public.teams t on t.team_id = s.team_id
     where not u.enabled
       and s.suspended_by_account_disable = true
       and s.valid_from <= public.direct_entry_authorization_date()
       and (s.valid_to is null or (s.valid_to > s.valid_from and public.direct_entry_authorization_date() < s.valid_to))
       and (
         s.scope_kind in ('own', 'all')
         or (s.scope_kind = 'team' and t.team_id is not null and t.active = true and t.code <> '__system_vendor__')
       )
     order by s.app_user_id asc, s.scope_kind asc, s.team_id asc nulls first, s.grant_id asc`,
  );
  const suspLinksRes = await queryable.query(
    `select
       rl.link_id::text as link_id,
       rl.app_user_id::text as app_user_id,
       rl.recruiter_id::text as recruiter_id,
       r.active as recruiter_active
     from public.direct_entry_app_user_recruiter_links rl
     join public.direct_entry_app_users u on u.app_user_id = rl.app_user_id
     join public.recruiters r on r.recruiter_id = rl.recruiter_id
     where not u.enabled
       and rl.verified = true
       and rl.suspended_by_account_disable = true
       and rl.valid_from <= public.direct_entry_authorization_date()
       and (rl.valid_to is null or (rl.valid_to > rl.valid_from and public.direct_entry_authorization_date() < rl.valid_to))
     order by rl.app_user_id asc, rl.recruiter_id asc, rl.link_id asc`,
  );
  const suspTlRes = await queryable.query(
    `select
       tla.assignment_id::text as assignment_id,
       tla.leader_app_user_id::text as leader_app_user_id,
       tla.team_id::text as team_id
     from public.direct_entry_team_leader_assignments tla
     join public.direct_entry_app_users u on u.app_user_id = tla.leader_app_user_id
     join public.teams t on t.team_id = tla.team_id
       and t.active = true
       and t.code <> '__system_vendor__'
     where not u.enabled
       and tla.suspended_by_account_disable = true
       and tla.valid_from <= public.direct_entry_authorization_date()
       and (tla.valid_to is null or (tla.valid_to > tla.valid_from and public.direct_entry_authorization_date() < tla.valid_to))
     order by tla.leader_app_user_id asc, tla.team_id asc, tla.assignment_id asc`,
  );
  const suspWrTlRes = await queryable.query(
    `select
       wr.leader_assignment_id::text as leader_assignment_id,
       tla.leader_app_user_id::text as app_user_id,
       tla.team_id::text as team_id,
       wr.capability as capability,
       wr.capability_grant_id::text as grant_id
     from public.work_report_team_leader_capability_grants wr
     join public.direct_entry_team_leader_assignments tla on tla.assignment_id = wr.leader_assignment_id
     join public.direct_entry_app_users u on u.app_user_id = tla.leader_app_user_id
     join public.teams t on t.team_id = tla.team_id
       and t.active = true
       and t.code <> '__system_vendor__'
     join public.direct_entry_capability_grants g on g.grant_id = wr.capability_grant_id
     where not u.enabled
       and wr.capability = 'report_review'
       and tla.suspended_by_account_disable = true
       and g.suspended_by_account_disable = true
       and tla.valid_from <= public.direct_entry_authorization_date()
       and (tla.valid_to is null or (tla.valid_to > tla.valid_from and public.direct_entry_authorization_date() < tla.valid_to))
       and g.valid_from <= public.direct_entry_authorization_date()
       and (g.valid_to is null or (g.valid_to > g.valid_from and public.direct_entry_authorization_date() < g.valid_to))
     order by tla.leader_app_user_id asc, tla.team_id asc`,
  );
  const existingRolesRes = await queryable.query(
    `select
       app_user_id::text as app_user_id,
       role_code,
       is_protected
     from public.authz_account_role_assignments
     where ended_at is null
     order by app_user_id asc, role_code asc`,
  );
  const existingDirectRes = await queryable.query(
    `select
       app_user_id::text as app_user_id,
       capability,
       scope_kind,
       scope_id
     from public.authz_direct_capability_grants
     where ended_at is null
     order by app_user_id asc, capability asc, scope_kind asc, scope_id asc nulls first`,
  );

  return {
    authorization_date: authDateRes.rows[0]?.authorization_date ?? null,
    accounts: accountsRes.rows,
    capability_grants: capRes.rows,
    scope_grants: scopeRes.rows,
    recruiter_links: linksRes.rows,
    team_leader_assignments: tlRes.rows,
    wr_tl_capability_grants: wrTlRes.rows,
    department_heads: dhRes.rows,
    project_managers: pmRes.rows,
    project_accountants: paRes.rows,
    open_person_links: personLinksRes.rows,
    work_report_delegations: wrDelegRes.rows,
    suspended_capability_grants: suspCapRes.rows,
    suspended_scope_grants: suspScopeRes.rows,
    suspended_recruiter_links: suspLinksRes.rows,
    suspended_team_leader_assignments: suspTlRes.rows,
    suspended_wr_tl_capability_grants: suspWrTlRes.rows,
    existing_open_roles: existingRolesRes.rows,
    existing_open_direct_grants: existingDirectRes.rows,
  };
}

function canonicalSortValue(value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalSortValue);
  }
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalSortValue(value[key]);
  }
  return sorted;
}

function sortCanonicalRows(rows) {
  return [...(rows ?? [])]
    .map(canonicalSortValue)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/**
 * Computes a deterministic digest over non-grant source links and contextual/org assignments
 * so postcondition verification detects any concurrent source mutation before commit.
 */
export function computeNonGrantInventoryDigest(inventory) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalSortValue({
          authorization_date: inventory.authorization_date ?? null,
          recruiter_links: sortCanonicalRows(inventory.recruiter_links),
          suspended_recruiter_links: sortCanonicalRows(inventory.suspended_recruiter_links),
          team_leader_assignments: sortCanonicalRows(inventory.team_leader_assignments),
          suspended_team_leader_assignments: sortCanonicalRows(
            inventory.suspended_team_leader_assignments,
          ),
          department_heads: sortCanonicalRows(inventory.department_heads),
          project_managers: sortCanonicalRows(inventory.project_managers),
          project_accountants: sortCanonicalRows(inventory.project_accountants),
          open_person_links: sortCanonicalRows(inventory.open_person_links),
          work_report_delegations: sortCanonicalRows(inventory.work_report_delegations),
        }),
      ),
    )
    .digest("hex");
}

/**
 * Verifies post-cutover SQL invariants inside the active connection/transaction.
 */
export async function verifyPostCutoverInvariants(
  queryable,
  manifest = null,
  preSyncInventory = null,
) {
  const sysRes = await queryable.query(
    `select cutover_ready, cutover_at::text as cutover_at
       from public.authz_system_state
      where singleton_id = true`,
  );
  if (sysRes.rows.length !== 1 || sysRes.rows[0].cutover_ready !== true) {
    throw new Error("POSTCONDITION_FAILED: authz_system_state.cutover_ready is not true");
  }

  const unmanagedRes = await queryable.query(
    `select app_user_id::text
       from public.direct_entry_app_users
      where authz_managed = false`,
  );
  if (unmanagedRes.rows.length > 0) {
    throw new Error(
      `POSTCONDITION_FAILED: ${unmanagedRes.rows.length} accounts still have authz_managed = false`,
    );
  }

  const protRes = await queryable.query(
    `select assignment_id::text, app_user_id::text, role_code, protected_reason
       from public.authz_account_role_assignments
      where is_protected = true and ended_at is null`,
  );
  if (protRes.rows.length !== 1 || protRes.rows[0].role_code !== "ADMIN" || protRes.rows[0].protected_reason !== PROTECTED_OWNER_REASON) {
    throw new Error("POSTCONDITION_FAILED: canonical protected Owner ADMIN invariant violated");
  }
  if (manifest && protRes.rows[0].app_user_id !== manifest.canonical_owner.app_user_id) {
    throw new Error("POSTCONDITION_FAILED: protected assignment does not belong to canonical Owner");
  }

  const postColCheck = await queryable.query(
    `select exists (
       select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'direct_entry_app_users'
          and column_name = 'account_type'
     ) as has_account_type`,
  );
  const postAccountTypeExpr = postColCheck.rows[0]?.has_account_type
    ? "u.account_type"
    : "'NORMAL'::text";
  const resolvedRes = await queryable.query(
    `select
       u.app_user_id::text as app_user_id,
       u.enabled as enabled,
       ${postAccountTypeExpr} as account_type,
       u.version as version,
       public.direct_entry_authz__internal_resolve_effective_grants(u.app_user_id) as grants
     from public.direct_entry_app_users u
     order by u.app_user_id asc`,
  );

  const openRolesRes = await queryable.query(
    `select app_user_id::text as app_user_id, role_code
       from public.authz_account_role_assignments
      where ended_at is null
      order by app_user_id asc, role_code asc`,
  );
  const openRolesByUser = new Map();
  for (const row of openRolesRes.rows) {
    if (!openRolesByUser.has(row.app_user_id)) {
      openRolesByUser.set(row.app_user_id, []);
    }
    openRolesByUser.get(row.app_user_id).push(row.role_code);
  }

  const rowByUser = new Map();
  const grantsByUser = new Map();
  for (const row of resolvedRes.rows) {
    const grants = Array.isArray(row.grants) ? row.grants : [];
    rowByUser.set(row.app_user_id, row);
    grantsByUser.set(row.app_user_id, grants);

    if (!row.enabled && grants.length > 0) {
      throw new Error(`POSTCONDITION_FAILED: disabled account ${row.app_user_id} still has effective grants`);
    }
    if (row.account_type !== "NORMAL" && grants.length > 0) {
      throw new Error(`POSTCONDITION_FAILED: non-NORMAL account ${row.app_user_id} has effective grants`);
    }
  }

  const adminRows = await queryable.query(
    `select u.app_user_id::text, u.enabled
       from public.authz_account_role_assignments ara
       join public.direct_entry_app_users u on u.app_user_id = ara.app_user_id
      where ara.role_code = 'ADMIN'
        and ara.ended_at is null`,
  );
  for (const row of adminRows.rows) {
    if (!row.enabled) continue;
    const actualKeys = new Set(uniqueSortedGrantKeys(grantsByUser.get(row.app_user_id)));
    for (const entry of WP5_ROLE_CATALOG.ADMIN.capabilities) {
      const k = grantKey({ capability: entry.capability, scope_kind: entry.scope_template, scope_id: null });
      if (!actualKeys.has(k)) {
        throw new Error(`POSTCONDITION_FAILED: ADMIN ${row.app_user_id} missing bundle grant ${k}`);
      }
    }
    if (manifest) {
      const plan = manifest.account_plans.find((p) => p.app_user_id === row.app_user_id);
      const excKeys = new Set((plan?.direct_grant_exceptions ?? []).map((e) => `${e.capability}::${e.scope_kind}`));
      for (const excludedCap of ADMIN_NON_AUTO_GRANT_TOKENS) {
        for (const actual of actualKeys) {
          if (actual.startsWith(`${excludedCap}::`) && !excKeys.has(`${excludedCap}::ALL`) && !excKeys.has(`${excludedCap}::OWN`)) {
            // Contextual assignments (like PM) may validly emit e.g. recruitment_post_create @ CONTEXT_PROJECT
            const [, sk] = actual.split("::");
            if (sk === "ALL" || sk === "OWN") {
              throw new Error(`POSTCONDITION_FAILED: ADMIN ${row.app_user_id} leaked non-auto token ${actual}`);
            }
          }
        }
      }
    }
  }

  if (manifest) {
    if (resolvedRes.rows.length !== manifest.account_plans.length) {
      throw new Error(
        `POSTCONDITION_FAILED: account count drifted during cutover (actual=${resolvedRes.rows.length} expected=${manifest.account_plans.length})`,
      );
    }
    for (const plan of manifest.account_plans) {
      const accountRow = rowByUser.get(plan.app_user_id);
      if (
        !accountRow ||
        accountRow.enabled !== plan.enabled ||
        accountRow.account_type !== plan.account_type ||
        (plan.account_version !== undefined && accountRow.version !== plan.account_version)
      ) {
        throw new Error(
          `POSTCONDITION_FAILED: account state/version drifted for ${plan.login_id} (${plan.app_user_id})`,
        );
      }

      const actualRoles = [...(openRolesByUser.get(plan.app_user_id) ?? [])].sort();
      const expectedRoles = [...(plan.global_roles ?? [])].sort();
      if (JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)) {
        throw new Error(
          `POSTCONDITION_FAILED: open global roles mismatch for ${plan.login_id} (${plan.app_user_id}): actual=${JSON.stringify(actualRoles)} expected=${JSON.stringify(expectedRoles)}`,
        );
      }

      const actualKeys = uniqueSortedGrantKeys(grantsByUser.get(plan.app_user_id));
      const expectedKeys = uniqueSortedGrantKeys(plan.post_cutover_effective_grants);
      if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
        throw new Error(
          `POSTCONDITION_FAILED: effective grants mismatch for ${plan.login_id} (${plan.app_user_id}): actual=${JSON.stringify(actualKeys)} expected=${JSON.stringify(expectedKeys)}`,
        );
      }
    }
  }

  if (preSyncInventory) {
    const postInventory = await readCutoverInventory(queryable);
    if (
      computeNonGrantInventoryDigest(postInventory) !==
      computeNonGrantInventoryDigest(preSyncInventory)
    ) {
      throw new Error(
        "CUTOVER_SOURCE_STATE_DRIFT: concurrent assignment or organization source changed during cutover",
      );
    }
  }

  return {
    total_accounts_checked: resolvedRes.rows.length,
    active_admin_count: adminRows.rows.filter((r) => r.enabled).length,
    protected_owner_app_user_id: protRes.rows[0].app_user_id,
    admin_bundle_size: ADMIN_BUNDLE_CAPABILITIES.length,
  };
}

/**
 * Redacts PII (email, display names) before saving or printing JSON plan output.
 */
export function sanitizeCutoverReport(report) {
  return {
    schema_version: report.schema_version,
    mode: report.mode,
    status: report.status,
    generated_at: report.generated_at,
    system_state: report.system_state,
    manifest_fingerprint: report.manifest_fingerprint,
    canonical_owner: {
      app_user_id: report.canonical_owner.app_user_id,
      login_id: report.canonical_owner.login_id,
      rejected_local_part_collision_count:
        report.canonical_owner.rejected_local_part_collisions.length,
    },
    summary: report.summary,
    action_diff_summary: {
      total_accounts: report.action_diff.total_accounts,
      unchanged_count: report.action_diff.unchanged_count,
      intentional_change_count: report.action_diff.intentional_change_count,
      unexpected_diff_count: report.action_diff.unexpected_diff_count,
    },
    account_transitions: report.action_diff.rows.map((row) => ({
      app_user_id: row.app_user_id,
      login_id: row.login_id,
      enabled: row.enabled,
      classification: row.classification,
      reasons: row.reasons,
      anomalies: row.anomalies,
      global_roles: row.global_roles,
      contextual_roles: row.contextual_roles,
      direct_grant_exception_count: row.direct_grant_exception_count,
      gained_grant_count: row.gained_grants.length,
      lost_grant_count: row.lost_grants.length,
      gained_grants: row.gained_grants,
      lost_grants: row.lost_grants,
      before_actions: row.before_actions,
      after_actions: row.after_actions,
    })),
    orphan_all_scope_remediations: report.orphan_all_scope_remediations,
    postconditions: report.postconditions ?? null,
    output_digest_sha256: createHash("sha256")
      .update(`${report.manifest_fingerprint}:${report.status}`)
      .digest("hex"),
  };
}

/**
 * Executes read-only-plan, dry-run, or apply against a PG/PGlite queryable connection.
 */
export async function runWp5Cutover(queryable, options = {}) {
  const mode = options.mode ?? "dry-run";
  const confirmApply = options.confirmApply === true;
  const expectedFingerprint = options.expectedFingerprint ?? null;

  if (mode !== "read-only-plan" && mode !== "dry-run" && mode !== "apply") {
    throw new Error(`Invalid cutover mode: ${mode}`);
  }
  if (mode === "apply") {
    if (!confirmApply) {
      throw new Error("CUTOVER_APPLY_REQUIRES_CONFIRM");
    }
    if (!expectedFingerprint || !SHA256_RE.test(expectedFingerprint)) {
      throw new Error("CUTOVER_APPLY_REQUIRES_EXPECTED_FINGERPRINT");
    }
  }

  if (mode === "read-only-plan") {
    await queryable.query("begin transaction isolation level repeatable read read only");
    try {
      const systemState = await readCutoverSystemState(queryable);
      const inventory = await readCutoverInventory(queryable);
      const manifest = buildWp5FullCutoverManifest(inventory);
      const actionDiff = computeWp5CutoverActionDiff(inventory, manifest);
      await queryable.query("rollback");
      return {
        schema_version: manifest.schema_version,
        mode,
        status: "READ_ONLY_PLAN_GENERATED",
        generated_at: new Date().toISOString(),
        system_state: systemState,
        manifest_fingerprint: manifest.manifest_fingerprint,
        canonical_owner: manifest.canonical_owner,
        summary: manifest.summary,
        orphan_all_scope_remediations: manifest.orphan_all_scope_remediations,
        action_diff: actionDiff,
        postconditions: null,
      };
    } catch (err) {
      await queryable.query("rollback").catch(() => {});
      throw err;
    }
  }

  await queryable.query("begin");
  try {
    const preSystemState = await readCutoverSystemState(queryable);
    await queryable.query(
      `select singleton_id, cutover_ready
         from public.authz_system_state
        where singleton_id = true
        for update`,
    );
    const lockedStateRes = await queryable.query(
      `select singleton_id, cutover_ready, cutover_at::text as cutover_at
         from public.authz_system_state
        where singleton_id = true`,
    );
    const alreadyCutover = lockedStateRes.rows[0]?.cutover_ready === true;

    if (alreadyCutover) {
      const postconditions = await verifyPostCutoverInvariants(queryable, null);
      const auditRes = await queryable.query(
        `select after_payload
           from public.authz_audit_events
          where operation_name = 'WP5B2_CUTOVER_APPLY'
          order by created_at desc, audit_event_id desc
          limit 1`,
      );
      const ownerRes = await queryable.query(
        `select ara.app_user_id::text as app_user_id, au.email as email
           from public.authz_account_role_assignments ara
           join public.direct_entry_app_users u on u.app_user_id = ara.app_user_id
           left join auth.users au on au.id = u.auth_subject
          where ara.is_protected = true
            and ara.ended_at is null
          limit 1`,
      );
      const auditPayload = auditRes.rows[0]?.after_payload ?? {};
      const ownerRow = ownerRes.rows[0] ?? null;
      const ownerLoginId =
        typeof ownerRow?.email === "string" && ownerRow.email.includes("@")
          ? ownerRow.email.split("@")[0].toLowerCase()
          : "nobita6986";

      if (mode === "apply") {
        await queryable.query("commit");
      } else {
        await queryable.query("rollback");
      }
      return {
        schema_version: "wp5-cutover-manifest-v2",
        mode,
        status: "ALREADY_APPLIED_NOOP",
        generated_at: new Date().toISOString(),
        system_state: {
          ...preSystemState,
          cutover_ready: true,
          cutover_at: lockedStateRes.rows[0].cutover_at,
        },
        manifest_fingerprint:
          auditPayload.manifest_fingerprint ?? expectedFingerprint ?? null,
        canonical_owner: {
          app_user_id: ownerRow?.app_user_id ?? postconditions.protected_owner_app_user_id,
          login_id: ownerLoginId,
          rejected_local_part_collisions: [],
        },
        summary: auditPayload.summary ?? {
          total_accounts: postconditions.total_accounts_checked,
          global_role_assignment_count: 0,
          direct_grant_exception_count: 0,
          orphan_all_scope_remediation_count: 0,
          quarantined_no_person_count: 0,
          disabled_account_count: 0,
        },
        orphan_all_scope_remediations:
          auditPayload.orphan_all_scope_remediations ?? [],
        action_diff: {
          total_accounts:
            auditPayload.action_diff_summary?.total_accounts ??
            postconditions.total_accounts_checked,
          unchanged_count:
            auditPayload.action_diff_summary?.unchanged_count ?? 0,
          intentional_change_count:
            auditPayload.action_diff_summary?.intentional_change_count ?? 0,
          unexpected_diff_count: 0,
          rows: [],
        },
        postconditions,
      };
    }

    // Lock all app_users deterministically (Tier 1 ascending) BEFORE reading inventory or validating fingerprint.
    await queryable.query(
      `select app_user_id from public.direct_entry_app_users order by app_user_id asc for update`,
    );

    const inventory = await readCutoverInventory(queryable);
    const manifest = buildWp5FullCutoverManifest(inventory);
    const actionDiff = computeWp5CutoverActionDiff(inventory, manifest);

    if (actionDiff.unexpected_diff_count > 0) {
      throw new Error(
        `CUTOVER_UNEXPECTED_DIFF_DETECTED (${actionDiff.unexpected_diff_count} accounts)`,
      );
    }
    if (expectedFingerprint && manifest.manifest_fingerprint !== expectedFingerprint.toLowerCase()) {
      throw new Error(
        `CUTOVER_FINGERPRINT_MISMATCH: expected=${expectedFingerprint} actual=${manifest.manifest_fingerprint}`,
      );
    }

    const ownerId = manifest.canonical_owner.app_user_id;
    const ownerAuthSubject = manifest.canonical_owner.auth_subject;

    // 1) Upsert open global role assignments
    const existingRolesRes = await queryable.query(
      `select assignment_id::text, app_user_id::text, role_code, is_protected
         from public.authz_account_role_assignments
        where ended_at is null`,
    );
    const existingRoleMap = new Map(
      existingRolesRes.rows.map((r) => [`${r.app_user_id}::${r.role_code}`, r]),
    );

    for (const roleRow of manifest.global_role_assignments) {
      const key = `${roleRow.app_user_id}::${roleRow.role_code}`;
      const existing = existingRoleMap.get(key);
      if (existing) {
        if (existing.is_protected !== roleRow.is_protected) {
          throw new Error(
            `CUTOVER_PREEXISTING_ROLE_PROTECTION_CONFLICT for ${key}: existing=${existing.is_protected} desired=${roleRow.is_protected}`,
          );
        }
        continue;
      }
      await queryable.query(
        `insert into public.authz_account_role_assignments (
           app_user_id, role_code, source_kind, reason,
           assigned_by_app_user_id, is_protected, protected_reason
         ) values (
           $1::uuid, $2::text, $3::text, $4::text,
           $5::uuid, $6::boolean, $7::text
         )`,
        [
          roleRow.app_user_id,
          roleRow.role_code,
          roleRow.source_kind,
          roleRow.reason,
          ownerId,
          roleRow.is_protected,
          roleRow.protected_reason,
        ],
      );
    }

    // 2) Upsert open direct capability exceptions
    const existingDirectRes = await queryable.query(
      `select app_user_id::text, capability, scope_kind, coalesce(scope_id, '') as scope_id
         from public.authz_direct_capability_grants
        where ended_at is null`,
    );
    const existingDirectSet = new Set(
      existingDirectRes.rows.map((r) => `${r.app_user_id}::${r.capability}::${r.scope_kind}::${r.scope_id}`),
    );
    for (const exc of manifest.direct_grant_exceptions) {
      const key = `${exc.app_user_id}::${exc.capability}::${exc.scope_kind}::${exc.scope_id ?? ""}`;
      if (existingDirectSet.has(key)) continue;
      await queryable.query(
        `insert into public.authz_direct_capability_grants (
           app_user_id, capability, scope_kind, scope_id,
           source_kind, reason, granted_by_app_user_id
         ) values (
           $1::uuid, $2::text, $3::text, $4::text,
           $5::text, $6::text, $7::uuid
         )`,
        [
          exc.app_user_id,
          exc.capability,
          exc.scope_kind,
          exc.scope_id,
          exc.source_kind,
          exc.reason,
          ownerId,
        ],
      );
    }

    // 3) Flip authz_managed = true on all accounts in the cutover cohort (including pre-WP5 disabled/non-NORMAL so legacy never resurrects)
    const managedIds = manifest.account_plans
      .filter((p) => p.set_authz_managed)
      .map((p) => p.app_user_id);
    if (managedIds.length > 0) {
      await queryable.query(
        `update public.direct_entry_app_users
            set authz_managed = true
          where app_user_id = any($1::uuid[])
            and authz_managed = false`,
        [managedIds],
      );
    }

    // 4) Sync legacy projection tables for every account
    for (const plan of manifest.account_plans) {
      await queryable.query(
        `select public.direct_entry_authz__internal_sync_legacy_grants($1::uuid)`,
        [plan.app_user_id],
      );
    }

    // 5) Flip authz_system_state.cutover_ready = true
    await queryable.query(
      `update public.authz_system_state
          set cutover_ready = true,
              cutover_at = coalesce(cutover_at, pg_catalog.clock_timestamp()),
              updated_at = pg_catalog.clock_timestamp(),
              updated_by_app_user_id = $1::uuid
        where singleton_id = true`,
      [ownerId],
    );

    // 6) Record immutable audit event
    await queryable.query(
      `insert into public.authz_audit_events (
         actor_auth_subject, actor_app_user_id, target_app_user_id,
         operation_name, after_payload, reason
       ) values (
         $1::uuid, $2::uuid, $2::uuid,
         'WP5B2_CUTOVER_APPLY', $3::jsonb, $4::text
       )`,
      [
        ownerAuthSubject,
        ownerId,
        JSON.stringify({
          manifest_fingerprint: manifest.manifest_fingerprint,
          summary: manifest.summary,
          orphan_all_scope_remediations: manifest.orphan_all_scope_remediations,
          action_diff_summary: {
            total_accounts: actionDiff.total_accounts,
            unchanged_count: actionDiff.unchanged_count,
            intentional_change_count: actionDiff.intentional_change_count,
          },
        }),
        "WP5B2_CUTOVER_APPLY",
      ],
    );

    // 7) Run strict SQL postconditions & source drift verification inside the transaction before COMMIT/ROLLBACK
    const postconditions = await verifyPostCutoverInvariants(queryable, manifest, inventory);
    const postStateRes = await queryable.query(
      `select singleton_id, cutover_ready, cutover_at::text as cutover_at, updated_at::text as updated_at,
              updated_by_app_user_id::text as updated_by_app_user_id
         from public.authz_system_state
        where singleton_id = true`,
    );

    if (mode === "dry-run") {
      await queryable.query("rollback");
      return {
        schema_version: manifest.schema_version,
        mode,
        status: "DRY_RUN_VERIFIED",
        generated_at: new Date().toISOString(),
        system_state: { ...preSystemState, verified_cutover_at: postStateRes.rows[0]?.cutover_at ?? null },
        manifest_fingerprint: manifest.manifest_fingerprint,
        canonical_owner: manifest.canonical_owner,
        summary: manifest.summary,
        orphan_all_scope_remediations: manifest.orphan_all_scope_remediations,
        action_diff: actionDiff,
        postconditions,
      };
    }

    await queryable.query("commit");
    return {
      schema_version: manifest.schema_version,
      mode,
      status: "APPLIED",
      generated_at: new Date().toISOString(),
      system_state: {
        ...preSystemState,
        cutover_ready: postStateRes.rows[0]?.cutover_ready === true,
        cutover_at: postStateRes.rows[0]?.cutover_at ?? null,
      },
      manifest_fingerprint: manifest.manifest_fingerprint,
      canonical_owner: manifest.canonical_owner,
      summary: manifest.summary,
      orphan_all_scope_remediations: manifest.orphan_all_scope_remediations,
      action_diff: actionDiff,
      postconditions,
    };
  } catch (err) {
    await queryable.query("rollback").catch(() => {});
    throw err;
  }
}

async function main() {
  const args = parseCutoverCliArgs(process.argv.slice(2));
  const require = createRequire(import.meta.url);
  const { Client } = require("pg");

  let clientConfig;
  if (args.nwcStaging) {
    const nwc = parseExternalNwcConfig(args.configPath);
    clientConfig = {
      connectionString: nwc.connectionString,
      ssl: nwc.ssl,
      application_name: `wp5b2-cutover-${args.mode}`,
    };
  } else {
    clientConfig = {
      connectionString: args.dbUrl,
      application_name: `wp5b2-cutover-${args.mode}`,
    };
  }

  const client = new Client(clientConfig);
  await client.connect();
  try {
    const rawReport = await runWp5Cutover(client, {
      mode: args.mode,
      confirmApply: args.confirmApply,
      expectedFingerprint: args.expectedFingerprint,
    });
    const sanitized = sanitizeCutoverReport(rawReport);
    const jsonText = JSON.stringify(sanitized, null, 2);

    if (args.outPath) {
      await fsp.mkdir(path.dirname(args.outPath), { recursive: true });
      await fsp.writeFile(args.outPath, `${jsonText}\n`, "utf8");
      console.error(`Wrote sanitized cutover report to ${args.outPath}`);
    }
    console.log(jsonText);
  } finally {
    await client.end().catch(() => {});
  }
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
