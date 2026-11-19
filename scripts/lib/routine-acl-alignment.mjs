/**
 * Canonical routine ACL verification, preflight inventory, rollback rehearsal,
 * and controlled remediation for Mini BI PostgreSQL environments.
 *
 * Security invariants:
 * - Canonical expected ACLs are derived STRICTLY from the target database's
 *   applied migrations (`public.schema_migrations`), cross-checked between
 *   ephemeral PGlite replay and `buildExpectedS0T1CAllowlist` (zero hardcoded
 *   permanent counts, zero unapplied migrations pulled in).
 * - Only `public` routines matching `S0_T1_C_TARGET_ROUTINE_PATTERN` and
 *   present in the applied canonical set are touched.
 * - Never alters function bodies, business tables, `schema_migrations`,
 *   `pg_default_acl`, unrelated `public` routines, or other schemas.
 * - Handles `direct_entry_catalog_bootstrap_executor`-owned routines under
 *   non-superuser logins with multiple `pg_auth_members` grantors/flags by
 *   snapshotting `pg_auth_members`, elevating strictly `SET` inside a single
 *   transaction, restoring byte-for-byte before `COMMIT`, and failing closed
 *   (rolling back) if restoration or postconditions drift by even one flag.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

import {
  buildExpectedS0T1CAllowlist,
  readMigrations,
  S0_T1_C_CURRENT_CHECKSUM,
  S0_T1_C_MIGRATION_NAME,
  S0_T1_C_PRE_PR92_CHECKSUM,
  S0_T1_C_TARGET_ROUTINE_PATTERN,
  verifyS0T1CSecurityPostconditions,
} from "./migration-validation.mjs";

export const BOOTSTRAP_EXECUTOR_ROLE = "direct_entry_catalog_bootstrap_executor";

export const BOOTSTRAP_HELPER_FUNCTIONS = [
  "public.direct_entry_authorization_date()",
  "public.direct_entry_reason(uuid, text)",
  "public.recruitment_dimension_key(text)",
  "public.recruitment_dimension_display(text)",
];

const PUBLIC_ROUTINES_ACL_SQL = `
  select p.oid::pg_catalog.regprocedure::text as signature,
         p.proname as routine_name,
         p.prosecdef,
         pg_catalog.pg_get_userbyid(p.proowner) as owner,
         (p.prorettype = 'trigger'::pg_catalog.regtype) as is_trigger,
         pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
         pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
         pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE') as owner_exec,
         exists (
           select 1
             from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
            where a.grantee = 0
              and a.privilege_type = 'EXECUTE'
         ) as public
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and p.proname ~ $1
   order by 1
`;

const ROUTINE_ACL_GRANTORS_SQL = `
  select p.oid::pg_catalog.regprocedure::text as signature,
         pg_catalog.pg_get_userbyid(p.proowner) as owner,
         case when a.grantee = 0 then 'PUBLIC' else pg_catalog.pg_get_userbyid(a.grantee) end as grantee,
         pg_catalog.pg_get_userbyid(a.grantor) as grantor,
         a.privilege_type,
         a.is_grantable
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    cross join lateral pg_catalog.aclexplode(
      coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
    ) a
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and p.proname ~ $1
   order by 1, 3, 4, 5
`;

const BOOTSTRAP_MEMBERSHIPS_SQL = `
  select pg_catalog.pg_get_userbyid(m.roleid) as role_name,
         pg_catalog.pg_get_userbyid(m.member) as member_name,
         pg_catalog.pg_get_userbyid(m.grantor) as grantor_name,
         m.admin_option,
         m.inherit_option,
         m.set_option
    from pg_catalog.pg_auth_members m
   where m.roleid = (select oid from pg_catalog.pg_roles where rolname = $1)
      or m.member = (select oid from pg_catalog.pg_roles where rolname = $1)
   order by 1, 2, 3, 4, 5, 6
`;

function sha256Json(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function quoteIdent(ident) {
  return `"${String(ident).replaceAll('"', '""')}"`;
}

/**
 * Derive canonical routine ACLs strictly for the exact prefix of migrations
 * recorded in `appliedMap`, by replaying those exact migrations in an ephemeral
 * in-memory PGlite instance and cross-checking against `buildExpectedS0T1CAllowlist`.
 */
export async function buildCanonicalRoutineAclsForAppliedMigrations({
  migrationsDir = path.resolve("supabase/migrations"),
  appliedMap,
}) {
  if (!(appliedMap instanceof Map) || appliedMap.size === 0) {
    throw new Error("TARGET_SCHEMA_MIGRATIONS_EMPTY: public.schema_migrations has no applied migrations.");
  }

  const allLocalMigrations = await readMigrations(migrationsDir);
  const localByName = new Map(allLocalMigrations.map((m) => [m.name, m]));

  const unknownApplied = [];
  const checksumErrors = [];
  const appliedMigrations = [];

  for (const [version, appliedChecksum] of [...appliedMap.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const local = localByName.get(version);
    if (!local) {
      unknownApplied.push(version);
      continue;
    }
    const isControlledS0Historical =
      version === S0_T1_C_MIGRATION_NAME &&
      local.checksum === S0_T1_C_CURRENT_CHECKSUM &&
      appliedChecksum === S0_T1_C_PRE_PR92_CHECKSUM;

    if (appliedChecksum !== local.checksum && !isControlledS0Historical) {
      checksumErrors.push({
        version,
        appliedChecksum,
        localChecksum: local.checksum,
      });
      continue;
    }
    appliedMigrations.push(local);
  }

  if (unknownApplied.length > 0) {
    throw new Error(
      `UNKNOWN_APPLIED_MIGRATIONS: target DB has applied migrations absent from local repository: ${unknownApplied.join(", ")}`,
    );
  }
  if (checksumErrors.length > 0) {
    throw new Error(
      `APPLIED_CHECKSUM_MISMATCH: refusing ACL alignment while migration ledger checksums differ: ${checksumErrors
        .map((e) => e.version)
        .join(", ")}`,
    );
  }

  const s0Migration = localByName.get(S0_T1_C_MIGRATION_NAME);
  if (!s0Migration || !appliedMap.has(S0_T1_C_MIGRATION_NAME)) {
    throw new Error(
      `S0_T1_C_NOT_APPLIED: ${S0_T1_C_MIGRATION_NAME} is not recorded in target public.schema_migrations.`,
    );
  }

  const unappliedLocalCount = allLocalMigrations.length - appliedMigrations.length;

  const pglite = new PGlite();
  let canonicalRoutines;
  let normalizedAllowlist;
  try {
    await pglite.exec(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text unique);",
    );
    for (const migration of appliedMigrations) {
      await pglite.exec(migration.sql);
    }
    await pglite.exec("set search_path = pg_catalog, public;");
    const res = await pglite.query(PUBLIC_ROUTINES_ACL_SQL, [S0_T1_C_TARGET_ROUTINE_PATTERN]);
    canonicalRoutines = res.rows;

    const rawAllowlist = buildExpectedS0T1CAllowlist(s0Migration.sql, appliedMap);
    const normRes = await pglite.query(
      `select coalesce(
                array_agg(
                  pg_catalog.to_regprocedure(u.sig)::pg_catalog.regprocedure::text
                  order by pg_catalog.to_regprocedure(u.sig)::pg_catalog.regprocedure::text
                ),
                array[]::text[]
              ) as normalized,
              coalesce(
                array_agg(u.sig order by u.sig) filter (where pg_catalog.to_regprocedure(u.sig) is null),
                array[]::text[]
              ) as missing
         from unnest($1::text[]) as u(sig)`,
      [rawAllowlist],
    );
    if ((normRes.rows[0]?.missing ?? []).length > 0) {
      throw new Error(
        `CANONICAL_ALLOWLIST_MISSING_SIGNATURES: allowlist references missing routines for applied prefix: ${normRes.rows[0].missing.join(", ")}`,
      );
    }
    normalizedAllowlist = normRes.rows[0].normalized;
  } finally {
    await pglite.close();
  }

  const canonicalExposed = canonicalRoutines.filter((r) => r.anon || r.authenticated || r.public);
  if (canonicalExposed.length > 0) {
    throw new Error(
      `CANONICAL_REPLAY_EXPOSED: canonical PGlite replay unexpectedly exposed ${canonicalExposed.length} routine(s) to client/PUBLIC.`,
    );
  }

  const canonicalService = canonicalRoutines
    .filter((r) => r.service_role)
    .map((r) => r.signature)
    .sort();
  if (
    canonicalService.length !== normalizedAllowlist.length ||
    canonicalService.some((sig, idx) => sig !== normalizedAllowlist[idx])
  ) {
    const pgliteSet = new Set(canonicalService);
    const allowSet = new Set(normalizedAllowlist);
    const onlyInPglite = canonicalService.filter((s) => !allowSet.has(s));
    const onlyInAllowlist = normalizedAllowlist.filter((s) => !pgliteSet.has(s));
    throw new Error(
      `CANONICAL_ALLOWLIST_PARITY_MISMATCH: PGlite replay (${canonicalService.length}) and S0 allowlist (${normalizedAllowlist.length}) disagree. ` +
        `onlyInPglite=[${onlyInPglite.join(", ")}], onlyInAllowlist=[${onlyInAllowlist.join(", ")}]`,
    );
  }

  return {
    appliedMigrationCount: appliedMigrations.length,
    unappliedLocalMigrationCount: unappliedLocalCount,
    latestAppliedMigration: appliedMigrations.at(-1)?.name ?? null,
    s0MigrationSql: s0Migration.sql,
    canonicalRoutines,
    canonicalBySignature: new Map(canonicalRoutines.map((r) => [r.signature, r])),
    canonicalServiceSignatures: canonicalService,
  };
}

/**
 * Collect preservation hashes of objects that routine ACL alignment MUST NOT mutate.
 */
export async function capturePreservationSnapshot(client) {
  const ledgerRes = await client.query(
    "select version, checksum from public.schema_migrations order by version",
  );
  const bodiesRes = await client.query(`
    select p.oid::pg_catalog.regprocedure::text as signature,
           pg_catalog.md5(coalesce(p.prosrc, '')) as body_md5,
           pg_catalog.pg_get_userbyid(p.proowner) as owner,
           p.prosecdef,
           coalesce(p.proconfig, array[]::text[]) as proconfig
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind in ('f', 'p')
     order by 1
  `);
  const defaultAclRes = await client.query(`
    select pg_catalog.pg_get_userbyid(d.defaclrole) as owner,
           coalesce(n.nspname, '') as schema_name,
           d.defaclobjtype as obj_type,
           d.defaclacl::text as acl
      from pg_catalog.pg_default_acl d
      left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
     order by 1, 2, 3, 4
  `);
  const unrelatedAclRes = await client.query(
    `select p.oid::pg_catalog.regprocedure::text as signature,
            coalesce(p.proacl::text, '') as proacl
       from pg_catalog.pg_proc p
       join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prokind in ('f', 'p')
        and p.proname !~ $1
      order by 1`,
    [S0_T1_C_TARGET_ROUTINE_PATTERN],
  );
  const helperGrantsRes = await client.query(
    `select u.sig,
            pg_catalog.to_regprocedure(u.sig) is not null as exists,
            case
              when pg_catalog.to_regprocedure(u.sig) is not null
               and exists (select 1 from pg_catalog.pg_roles where rolname = $2)
              then pg_catalog.has_function_privilege($2, pg_catalog.to_regprocedure(u.sig), 'EXECUTE')
              else null
            end as executor_can_execute
       from unnest($1::text[]) as u(sig)
      order by 1`,
    [BOOTSTRAP_HELPER_FUNCTIONS, BOOTSTRAP_EXECUTOR_ROLE],
  );
  const bootstrapMemRes = await client.query(BOOTSTRAP_MEMBERSHIPS_SQL, [
    BOOTSTRAP_EXECUTOR_ROLE,
  ]);

  return {
    schemaMigrationsHash: sha256Json(ledgerRes.rows),
    routineBodiesHash: sha256Json(bodiesRes.rows),
    defaultPrivilegesHash: sha256Json(defaultAclRes.rows),
    unrelatedPublicRoutinesAclHash: sha256Json(unrelatedAclRes.rows),
    bootstrapHelperGrantsHash: sha256Json(helperGrantsRes.rows),
    bootstrapMembershipsHash: sha256Json(bootstrapMemRes.rows),
    bootstrapHelperGrants: helperGrantsRes.rows,
    bootstrapMemberships: bootstrapMemRes.rows,
  };
}

export function extractPreservationHashes(preservation) {
  return {
    schemaMigrationsHash: preservation.schemaMigrationsHash,
    routineBodiesHash: preservation.routineBodiesHash,
    defaultPrivilegesHash: preservation.defaultPrivilegesHash,
    unrelatedPublicRoutinesAclHash: preservation.unrelatedPublicRoutinesAclHash,
    bootstrapHelperGrantsHash: preservation.bootstrapHelperGrantsHash,
    bootstrapMembershipsHash: preservation.bootstrapMembershipsHash,
  };
}

export function assertPreservationUnchanged(before, after, stageLabel) {
  const keys = [
    "schemaMigrationsHash",
    "routineBodiesHash",
    "defaultPrivilegesHash",
    "unrelatedPublicRoutinesAclHash",
    "bootstrapHelperGrantsHash",
    "bootstrapMembershipsHash",
  ];
  const drifted = keys.filter((k) => before[k] !== after[k]);
  if (drifted.length > 0) {
    throw new Error(
      `PRESERVATION_INVARIANT_FAILED (${stageLabel}): unexpected mutation detected in [${drifted.join(", ")}]`,
    );
  }
}

export function assertBootstrapMembershipStateRestored(expectedBootstrap, actualBootstrap, stageLabel) {
  const diffs = [];
  if (JSON.stringify(actualBootstrap.memberships) !== JSON.stringify(expectedBootstrap.memberships)) {
    diffs.push("pg_auth_members rows changed");
  }
  if (actualBootstrap.actor.can_set !== expectedBootstrap.actor.can_set) {
    diffs.push(`SET changed (${expectedBootstrap.actor.can_set} -> ${actualBootstrap.actor.can_set})`);
  }
  if (actualBootstrap.actor.usage !== expectedBootstrap.actor.usage) {
    diffs.push(`USAGE/INHERIT changed (${expectedBootstrap.actor.usage} -> ${actualBootstrap.actor.usage})`);
  }
  if (actualBootstrap.actor.member !== expectedBootstrap.actor.member) {
    diffs.push(`MEMBER changed (${expectedBootstrap.actor.member} -> ${actualBootstrap.actor.member})`);
  }
  if (diffs.length > 0) {
    throw new Error(
      `BOOTSTRAP_MEMBERSHIP_RESTORE_DRIFT (${stageLabel}): ${diffs.join("; ")}`,
    );
  }
}

/**
 * Verify all post-COMMIT invariants on a fresh READ ONLY inspection snapshot.
 * Never claims rollback — throws explicit already-committed / forward-fix error on any drift.
 */
export function verifyPostCommitAlignmentInvariants(applied, postCommit) {
  const failures = [];

  if (!postCommit.postconditions.ok) {
    failures.push(`acl_postconditions_failed (${postCommit.postconditions.reason ?? "unknown"})`);
  }
  if (postCommit.summary.mismatchCount !== 0) {
    failures.push(`routine_acl_mismatches=${postCommit.summary.mismatchCount}`);
  }

  let preservationHashesUnchanged = true;
  try {
    assertPreservationUnchanged(applied.preservationHashes, postCommit.preservation, "post-commit");
  } catch (err) {
    preservationHashesUnchanged = false;
    failures.push(err.message);
  }

  let bootstrapMembershipsRestoredExact = true;
  let bootstrapRoleStateUnchanged = true;
  try {
    assertBootstrapMembershipStateRestored(
      applied.bootstrapBefore,
      postCommit.bootstrapContext,
      "post-commit",
    );
  } catch (err) {
    if (
      JSON.stringify(postCommit.bootstrapContext.memberships) !==
      JSON.stringify(applied.bootstrapBefore.memberships)
    ) {
      bootstrapMembershipsRestoredExact = false;
    }
    if (
      postCommit.bootstrapContext.actor.can_set !== applied.bootstrapBefore.actor.can_set ||
      postCommit.bootstrapContext.actor.usage !== applied.bootstrapBefore.actor.usage ||
      postCommit.bootstrapContext.actor.member !== applied.bootstrapBefore.actor.member
    ) {
      bootstrapRoleStateUnchanged = false;
    }
    failures.push(err.message);
  }

  if (failures.length > 0) {
    throw new Error(
      "POST_COMMIT_VERIFY_FAILED (TRANSACTION ALREADY COMMITTED — NOT ROLLED BACK; " +
        "investigate and forward-fix, do not re-expose routine ACLs): " +
        failures.join("; "),
    );
  }

  return {
    committed: true,
    readOnlyTransaction: "REPEATABLE READ READ ONLY ... ROLLBACK",
    aclPostconditionsOk: true,
    mismatchCount: 0,
    preservationHashesUnchanged,
    bootstrapMembershipsRestoredExact,
    bootstrapRoleStateUnchanged,
    passed: true,
  };
}

/**
 * Inspect bootstrap executor role, current login capabilities, and exact `pg_auth_members`
 * grantor/flag rows on the live target DB.
 */
export async function inspectBootstrapRoleContext(client) {
  const { rows: [actor] } = await client.query(
    `select current_user as current_user,
            session_user as session_user,
            r.rolsuper,
            r.rolcreaterole,
            r.rolbypassrls,
            exists (select 1 from pg_catalog.pg_roles where rolname = $1) as bootstrap_role_exists,
            case
              when exists (select 1 from pg_catalog.pg_roles where rolname = $1)
              then pg_catalog.pg_has_role(session_user, $1, 'MEMBER')
              else false
            end as member,
            case
              when exists (select 1 from pg_catalog.pg_roles where rolname = $1)
              then pg_catalog.pg_has_role(session_user, $1, 'USAGE')
              else false
            end as usage,
            case
              when exists (select 1 from pg_catalog.pg_roles where rolname = $1)
              then pg_catalog.pg_has_role(session_user, $1, 'SET')
              else false
            end as can_set
       from pg_catalog.pg_roles r
      where r.rolname = current_user`,
    [BOOTSTRAP_EXECUTOR_ROLE],
  );

  const { rows: memberships } = await client.query(BOOTSTRAP_MEMBERSHIPS_SQL, [
    BOOTSTRAP_EXECUTOR_ROLE,
  ]);

  const incomingForSessionUser = memberships.filter(
    (m) => m.role_name === BOOTSTRAP_EXECUTOR_ROLE && m.member_name === actor.session_user,
  );
  const hasAdminOption = incomingForSessionUser.some((m) => m.admin_option === true);
  const existingSelfGrantRow =
    incomingForSessionUser.find((m) => m.grantor_name === actor.current_user) ?? null;

  let elevationStrategy = "NOT_NEEDED";
  let canExecuteBootstrapAlignment = true;
  let preconditionFailureReason = null;

  if (!actor.bootstrap_role_exists) {
    elevationStrategy = "MISSING_ROLE";
    canExecuteBootstrapAlignment = false;
    preconditionFailureReason = `Role ${BOOTSTRAP_EXECUTOR_ROLE} does not exist`;
  } else if (actor.can_set) {
    elevationStrategy = "DIRECT_SET_LOCAL_ROLE";
  } else if (actor.current_user !== actor.session_user) {
    elevationStrategy = "BLOCKED_SESSION_MISMATCH";
    canExecuteBootstrapAlignment = false;
    preconditionFailureReason = `current_user (${actor.current_user}) !== session_user (${actor.session_user})`;
  } else if (actor.rolsuper || hasAdminOption) {
    elevationStrategy = existingSelfGrantRow
      ? "TEMP_GRANT_SET_OPTION_AND_REVOKE_SET_OPTION"
      : "TEMP_GRANT_MEMBERSHIP_AND_REVOKE_MEMBERSHIP";
  } else {
    elevationStrategy = "BLOCKED_MISSING_ADMIN_OPTION";
    canExecuteBootstrapAlignment = false;
    preconditionFailureReason =
      `Login ${actor.session_user} has SET=false and ADMIN OPTION=false on ${BOOTSTRAP_EXECUTOR_ROLE}; ` +
      "operator must either run as a role with ADMIN/SET option on the bootstrap executor or grant temporary ADMIN OPTION first";
  }

  return {
    actor,
    memberships,
    hasAdminOption,
    existingSelfGrantRow,
    elevationStrategy,
    canExecuteBootstrapAlignment,
    preconditionFailureReason,
  };
}

/**
 * Inspect live vs canonical routine ACL diff inside the current connection/transaction.
 */
export async function inspectRoutineAclDrift(
  client,
  { migrationsDir = path.resolve("supabase/migrations") } = {},
) {
  const { rows: ledgerRows } = await client.query(
    "select version, checksum from public.schema_migrations order by version",
  );
  const appliedMap = new Map(ledgerRows.map((r) => [r.version, r.checksum]));

  const canonical = await buildCanonicalRoutineAclsForAppliedMigrations({
    migrationsDir,
    appliedMap,
  });

  await client.query("set local search_path = pg_catalog, public");
  const { rows: liveRoutines } = await client.query(PUBLIC_ROUTINES_ACL_SQL, [
    S0_T1_C_TARGET_ROUTINE_PATTERN,
  ]);
  const { rows: grantorRows } = await client.query(ROUTINE_ACL_GRANTORS_SQL, [
    S0_T1_C_TARGET_ROUTINE_PATTERN,
  ]);
  const bootstrapContext = await inspectBootstrapRoleContext(client);
  const preservation = await capturePreservationSnapshot(client);
  const postconditions = await verifyS0T1CSecurityPostconditions(
    client,
    canonical.s0MigrationSql,
    appliedMap,
  );

  const liveBySignature = new Map(liveRoutines.map((r) => [r.signature, r]));
  const grantorsBySignature = new Map();
  for (const row of grantorRows) {
    const list = grantorsBySignature.get(row.signature) ?? [];
    list.push({
      grantee: row.grantee,
      grantor: row.grantor,
      privilege_type: row.privilege_type,
      is_grantable: row.is_grantable,
    });
    grantorsBySignature.set(row.signature, list);
  }

  const missingCanonicalSignatures = [];
  const unexpectedLiveSignatures = [];
  const ownerMismatches = [];
  const mismatches = [];

  for (const [sig, expected] of canonical.canonicalBySignature.entries()) {
    const actual = liveBySignature.get(sig);
    if (!actual) {
      missingCanonicalSignatures.push(sig);
      continue;
    }
    const isBootstrapExpected = expected.owner === BOOTSTRAP_EXECUTOR_ROLE;
    if (isBootstrapExpected && actual.owner !== BOOTSTRAP_EXECUTOR_ROLE) {
      ownerMismatches.push({ signature: sig, actualOwner: actual.owner, expectedOwner: expected.owner });
    }
    if (!isBootstrapExpected && actual.owner === BOOTSTRAP_EXECUTOR_ROLE) {
      ownerMismatches.push({ signature: sig, actualOwner: actual.owner, expectedOwner: expected.owner });
    }

    const aclDiffKeys = ["anon", "authenticated", "service_role", "public", "owner_exec"].filter(
      (k) => actual[k] !== expected[k],
    );
    if (aclDiffKeys.length > 0) {
      const aclEntries = grantorsBySignature.get(sig) ?? [];
      const nonOwnerGrantors = aclEntries.filter(
        (e) =>
          ["PUBLIC", "anon", "authenticated", "service_role"].includes(e.grantee) &&
          e.grantor !== actual.owner,
      );
      mismatches.push({
        signature: sig,
        owner: actual.owner,
        is_bootstrap_owned: actual.owner === BOOTSTRAP_EXECUTOR_ROLE,
        prosecdef: actual.prosecdef,
        is_trigger: actual.is_trigger,
        diff_keys: aclDiffKeys,
        actual: {
          anon: actual.anon,
          authenticated: actual.authenticated,
          service_role: actual.service_role,
          public: actual.public,
          owner_exec: actual.owner_exec,
        },
        expected: {
          anon: expected.anon,
          authenticated: expected.authenticated,
          service_role: expected.service_role,
          public: expected.public,
          owner_exec: expected.owner_exec,
        },
        non_owner_grantors: nonOwnerGrantors,
      });
    }
  }

  for (const sig of liveBySignature.keys()) {
    if (!canonical.canonicalBySignature.has(sig)) {
      unexpectedLiveSignatures.push(sig);
    }
  }

  const bootstrapMismatches = mismatches.filter((m) => m.is_bootstrap_owned);
  const nonBootstrapMismatches = mismatches.filter((m) => !m.is_bootstrap_owned);
  const nonOwnerGrantorMismatches = mismatches.filter((m) => m.non_owner_grantors.length > 0);
  const unownedByCurrentUser = nonBootstrapMismatches.filter(
    (m) => !bootstrapContext.actor.rolsuper && m.owner !== bootstrapContext.actor.current_user,
  );

  const summary = {
    appliedMigrationCount: canonical.appliedMigrationCount,
    unappliedLocalMigrationCount: canonical.unappliedLocalMigrationCount,
    latestAppliedMigration: canonical.latestAppliedMigration,
    totalCanonicalTargetRoutines: canonical.canonicalRoutines.length,
    totalLiveTargetRoutines: liveRoutines.length,
    canonicalServiceRoleCount: canonical.canonicalServiceSignatures.length,
    mismatchCount: mismatches.length,
    bootstrapMismatchCount: bootstrapMismatches.length,
    nonBootstrapMismatchCount: nonBootstrapMismatches.length,
    exposedClientOrPublicCount: liveRoutines.filter((r) => r.anon || r.authenticated || r.public).length,
    exposedSecurityDefinerCount: liveRoutines.filter(
      (r) => (r.anon || r.authenticated || r.public) && r.prosecdef && !r.is_trigger,
    ).length,
    exposedTriggerCount: liveRoutines.filter(
      (r) => (r.anon || r.authenticated || r.public) && r.is_trigger,
    ).length,
    extraServiceRoleCount: mismatches.filter((m) => m.actual.service_role && !m.expected.service_role).length,
    missingServiceRoleCount: mismatches.filter((m) => !m.actual.service_role && m.expected.service_role).length,
    missingOwnerExecCount: mismatches.filter((m) => !m.actual.owner_exec).length,
    missingCanonicalSignatureCount: missingCanonicalSignatures.length,
    unexpectedLiveSignatureCount: unexpectedLiveSignatures.length,
    ownerMismatchCount: ownerMismatches.length,
    nonOwnerGrantorMismatchCount: nonOwnerGrantorMismatches.length,
    unownedByCurrentUserCount: unownedByCurrentUser.length,
    postconditionsOk: postconditions.ok,
    postconditionsReason: postconditions.ok ? null : postconditions.reason,
  };

  const planFingerprint = sha256Json({
    appliedMigrations: [...appliedMap.entries()].sort(([a], [b]) => a.localeCompare(b)),
    mismatches: mismatches.map((m) => ({
      signature: m.signature,
      owner: m.owner,
      actual: m.actual,
      expected: m.expected,
    })),
    bootstrapMemberships: bootstrapContext.memberships,
    preservationHashes: {
      schemaMigrationsHash: preservation.schemaMigrationsHash,
      routineBodiesHash: preservation.routineBodiesHash,
      defaultPrivilegesHash: preservation.defaultPrivilegesHash,
      unrelatedPublicRoutinesAclHash: preservation.unrelatedPublicRoutinesAclHash,
      bootstrapHelperGrantsHash: preservation.bootstrapHelperGrantsHash,
      bootstrapMembershipsHash: preservation.bootstrapMembershipsHash,
    },
  });

  return {
    summary,
    planFingerprint,
    appliedMap,
    canonical,
    mismatches,
    bootstrapMismatches,
    nonBootstrapMismatches,
    missingCanonicalSignatures,
    unexpectedLiveSignatures,
    ownerMismatches,
    nonOwnerGrantorMismatches,
    unownedByCurrentUser,
    bootstrapContext,
    preservation,
    postconditions,
  };
}

/**
 * Execute routine ACL alignment inside the caller's open transaction (`BEGIN` already active).
 * Caller controls `ROLLBACK` (dry-run rehearsal) vs `COMMIT` (controlled apply).
 */
export async function executeRoutineAclAlignmentInTransaction(
  client,
  {
    migrationsDir = path.resolve("supabase/migrations"),
    expectedFingerprint = null,
    injectErrorAfterBootstrapElevation = false,
  } = {},
) {
  const before = await inspectRoutineAclDrift(client, { migrationsDir });

  if (expectedFingerprint !== null && before.planFingerprint !== expectedFingerprint) {
    throw new Error(
      `PLAN_FINGERPRINT_MISMATCH: expected=${expectedFingerprint} actual=${before.planFingerprint}. Re-run --preflight before applying.`,
    );
  }
  if (before.missingCanonicalSignatures.length > 0) {
    throw new Error(
      `MISSING_CANONICAL_ROUTINES: ${before.missingCanonicalSignatures.join(", ")}`,
    );
  }
  if (before.unexpectedLiveSignatures.length > 0) {
    throw new Error(
      `UNEXPECTED_LIVE_TARGET_ROUTINES: ${before.unexpectedLiveSignatures.join(", ")}`,
    );
  }
  if (before.ownerMismatches.length > 0) {
    throw new Error(
      `ROUTINE_OWNER_MISMATCH: ${JSON.stringify(before.ownerMismatches)}`,
    );
  }
  if (before.unownedByCurrentUser.length > 0) {
    throw new Error(
      `ROUTINE_OWNER_NOT_CURRENT_USER: login ${before.bootstrapContext.actor.current_user} does not own ${before.unownedByCurrentUser
        .map((m) => `${m.signature} (owner=${m.owner})`)
        .join(", ")}`,
    );
  }
  if (
    before.bootstrapMismatches.length > 0 &&
    !before.bootstrapContext.canExecuteBootstrapAlignment
  ) {
    throw new Error(
      `BOOTSTRAP_EXECUTOR_PRECONDITION_FAILED: ${before.bootstrapContext.preconditionFailureReason}`,
    );
  }

  const actions = {
    nonBootstrapAligned: 0,
    bootstrapAligned: 0,
    bootstrapElevationUsed: "NONE",
    bootstrapMembershipsRestoredExact: true,
  };

  // 1. Align non-bootstrap routines owned by current_user (or via superuser)
  for (const item of before.nonBootstrapMismatches) {
    await client.query(
      `revoke execute on function ${item.signature} from public, anon, authenticated, service_role`,
    );
    if (item.expected.service_role) {
      await client.query(`grant execute on function ${item.signature} to service_role`);
    }
    if (!item.actual.owner_exec) {
      await client.query(
        `grant execute on function ${item.signature} to ${quoteIdent(item.owner)}`,
      );
    }
    actions.nonBootstrapAligned += 1;
  }

  // 2. Align the 3 bootstrap executor routines (if any drifted), with exact membership restore
  if (before.bootstrapMismatches.length > 0) {
    const ctx = before.bootstrapContext;
    const sessionUserIdent = quoteIdent(ctx.actor.session_user);
    const currentUserIdent = quoteIdent(ctx.actor.current_user);
    const executorIdent = quoteIdent(BOOTSTRAP_EXECUTOR_ROLE);

    actions.bootstrapElevationUsed = ctx.elevationStrategy;

    if (ctx.elevationStrategy === "TEMP_GRANT_MEMBERSHIP_AND_REVOKE_MEMBERSHIP") {
      await client.query(
        `grant ${executorIdent} to ${sessionUserIdent} with admin false, inherit false, set true`,
      );
    } else if (ctx.elevationStrategy === "TEMP_GRANT_SET_OPTION_AND_REVOKE_SET_OPTION") {
      await client.query(`grant ${executorIdent} to ${sessionUserIdent} with set true`);
    }

    if (injectErrorAfterBootstrapElevation) {
      throw new Error("INJECTED_TEST_FAILURE_AFTER_BOOTSTRAP_ELEVATION");
    }

    const { rows: [canSetCheck] } = await client.query(
      "select pg_catalog.pg_has_role(session_user, $1, 'SET') as can_set",
      [BOOTSTRAP_EXECUTOR_ROLE],
    );
    if (canSetCheck?.can_set !== true) {
      throw new Error(
        `BOOTSTRAP_ELEVATION_FAILED: pg_has_role(session_user, ${BOOTSTRAP_EXECUTOR_ROLE}, 'SET') remained false after ${ctx.elevationStrategy}`,
      );
    }

    await client.query(`set local role ${executorIdent}`);
    try {
      for (const item of before.bootstrapMismatches) {
        await client.query(
          `revoke execute on function ${item.signature} from public, anon, authenticated, service_role`,
        );
        if (item.expected.service_role) {
          await client.query(`grant execute on function ${item.signature} to service_role`);
        }
        if (!item.actual.owner_exec) {
          await client.query(`grant execute on function ${item.signature} to ${executorIdent}`);
        }
        actions.bootstrapAligned += 1;
      }
    } finally {
      await client.query("reset role");
    }

    if (ctx.elevationStrategy === "TEMP_GRANT_MEMBERSHIP_AND_REVOKE_MEMBERSHIP") {
      await client.query(
        `revoke ${executorIdent} from ${sessionUserIdent} granted by ${currentUserIdent}`,
      );
    } else if (ctx.elevationStrategy === "TEMP_GRANT_SET_OPTION_AND_REVOKE_SET_OPTION") {
      await client.query(
        `revoke set option for ${executorIdent} from ${sessionUserIdent} granted by ${currentUserIdent}`,
      );
    }

    const afterCtx = await inspectBootstrapRoleContext(client);
    try {
      assertBootstrapMembershipStateRestored(ctx, afterCtx, "pre-commit");
    } catch (err) {
      actions.bootstrapMembershipsRestoredExact = false;
      throw err;
    }
  }

  // 3. Post-alignment verification & preservation invariants inside transaction before COMMIT/ROLLBACK
  const after = await inspectRoutineAclDrift(client, { migrationsDir });
  assertPreservationUnchanged(before.preservation, after.preservation, "post-alignment");

  if (!after.postconditions.ok) {
    throw new Error(
      `POST_ALIGNMENT_POSTCONDITION_FAILED: ${after.postconditions.reason}`,
    );
  }
  if (after.summary.mismatchCount !== 0) {
    throw new Error(
      `POST_ALIGNMENT_MISMATCHES_REMAIN: ${after.summary.mismatchCount} routine(s) still mismatched ` +
        `(first=${after.mismatches[0]?.signature}, nonOwnerGrantors=${JSON.stringify(after.mismatches[0]?.non_owner_grantors ?? [])})`,
    );
  }

  return {
    planFingerprint: before.planFingerprint,
    beforeSummary: before.summary,
    afterSummary: after.summary,
    bootstrapBefore: {
      actor: before.bootstrapContext.actor,
      memberships: before.bootstrapContext.memberships,
      elevationStrategy: before.bootstrapContext.elevationStrategy,
    },
    bootstrapAfter: {
      actor: after.bootstrapContext.actor,
      memberships: after.bootstrapContext.memberships,
    },
    actions,
    preservationHashes: extractPreservationHashes(after.preservation),
  };
}
