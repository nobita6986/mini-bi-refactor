/**
 * WP10-7 Slice 3D — Archive, Locked Parity Gate, Hardened Dynamic SQL Precheck,
 * Ordered RESTRICT Drop, Post-Drop Runtime Regression & 8-Dimension Restore Parity Drill.
 *
 * Pure ESM (runs under `node --conditions=react-server --test`) against an isolated
 * native PostgreSQL 18 cluster (`initdb` + `pg_ctl` + `psql`).
 *
 * Uses a temporary copy of `supabase/migrations/` in `os.tmpdir()` combining:
 *   - All real migrations from `supabase/migrations/` (253 on 76b3fae2)
 *   - A clean simulated Slice 3C cutover migration (when real 3C is not yet in `supabase/migrations/`)
 *   - The real staged Slice 3D migration template (asserted byte-for-byte equal to
 *     `C:/CodeApp/bi-refactor-next/wp10/t1b/wp10-7-3d-migration-template.sql` when present locally)
 * and exercises the REAL `scripts/apply-migrations.mjs` CLI end-to-end!
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Client } from "pg";

import {
  decideAccountAccessPageAccess,
  decideAdminAreaAccess,
  decideDirectEntryPageAccess,
  decideProjectOperationsPageAccess,
  decideWorkerOperationsPageAccess,
} from "../src/lib/auth/direct-entry-page-access.ts";
import { resolveActor } from "../src/lib/auth/direct-entry-v2.ts";
import { createAuthSessionResponse } from "../src/lib/auth/auth-session-core.ts";
import { assignAccountGroupAdmin, removeAccountGroupAdmin } from "../src/lib/admin/permission-group-api.ts";
import { createServicePermissionGroupRepository } from "../src/lib/admin/permission-group-repository.ts";
import { mutateAccount } from "../src/lib/direct-entry/app-user-access-api.ts";
import { createAccountAccessRepository } from "../src/lib/direct-entry/app-user-access-repository.ts";
import { getInputCatalog, getOwnDrafts } from "../src/lib/direct-entry/draft-api.ts";
import { createDirectEntrySessionResponse } from "../src/lib/direct-entry/session-bootstrap.ts";
import { listOwnSubmissions } from "../src/lib/direct-entry/submission-read-api.ts";
import { createSubmissionReadRepository } from "../src/lib/direct-entry/submission-read-repository.ts";
import { listWorkers } from "../src/lib/direct-entry/worker-directory-api.ts";
import { createWorkerDirectoryRepository } from "../src/lib/direct-entry/worker-directory-repository.ts";
import { createDirectEntryWriteRepository } from "../src/lib/direct-entry/write-repository.ts";
import {
  isWp1073dMigrationName,
  loadAndVerifyWp1073dArchiveManifest,
  migrationChecksum,
  PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME,
  S0_T1_C_MIGRATION_NAME,
  verifyS0T1CSecurityPostconditions,
  WP10_7_3D_MIGRATION_SUFFIX,
} from "./lib/migration-validation.mjs";
import {
  computeWp1073dLiveFingerprintsInTx,
  exportWp1073dLegacyGrantsArchive,
  restoreWp1073dLegacyGrantsArchive,
  runWp1073dPrecheck,
  verifyWp1073dRestoreParity,
  WP10_7_3D_PRESERVED_SHARED_TRIGGER_FUNCTIONS,
} from "./lib/wp10-7-3d-legacy-grants-archive.mjs";
import { runWp5Cutover } from "./wp5-cutover-role-access.mjs";

const ROOT = process.cwd();
const MIGRATION_DIR = path.join(ROOT, "supabase", "migrations");
const LOCAL_STAGED_3D_TEMPLATE_PATH =
  "C:/CodeApp/bi-refactor-next/wp10/t1b/wp10-7-3d-migration-template.sql";
const WP10_7_3B_MIGRATION_NAME =
  "20261126233000_wp10_7_3b_team_leader_authz_managed_cutover.sql";
const SIMULATED_3C_MIGRATION_NAME =
  "20261127020000_wp10_7_3c_simulated_cutover_for_3d_rehearsal.sql";
const STAGED_3D_MIGRATION_NAME = `20261127050000${WP10_7_3D_MIGRATION_SUFFIX}`;

// Exact staged WP10-7 Slice 3D migration template (kept byte-for-byte identical to
// C:/CodeApp/bi-refactor-next/wp10/t1b/wp10-7-3d-migration-template.sql for CI portability).
const EMBEDDED_STAGED_3D_TEMPLATE_SQL = [
  "-- =============================================================================",
  "-- WP10-7 Slice 3D (STAGED TEMPLATE — activate into supabase/migrations/ ONLY",
  "-- after Slice 3C merges to main with a timestamp > Slice 3C):",
  "--   Target filename pattern:",
  "--     <YYYYMMDDHHMMSS>_wp10_7_3d_drop_direct_entry_legacy_grants.sql",
  "--",
  "-- Scope (100% forward migration; ZERO CASCADE; zero historical migration edits):",
  "--   1. Fail-closed pre-drop gate (do $wp10_7_3d_precheck$):",
  "--      (a) Verify all 3 legacy tables exist and acquire ACCESS EXCLUSIVE locks",
  "--          in canonical order:",
  "--            public.work_report_team_leader_capability_grants,",
  "--            public.direct_entry_capability_grants,",
  "--            public.direct_entry_scope_grants.",
  "--      (b) Verify 0 active or disabled `authz_managed = false` accounts.",
  "--      (c) Verify 0 views / materialized views referencing the 3 target tables.",
  "--      (d) Verify 0 incoming FKs from any 4th table and 0 unexpected pg_depend",
  "--          external objects on the 3 target tables.",
  "--      (e) Verify work_report_sync_team_leader_capabilities() is attached ONLY",
  "--          to public.direct_entry_team_leader_assignments.",
  "--      (f) Hardened pg_proc dependency & dynamic EXECUTE scan across ALL",
  "--          non-system application schemas:",
  "--            - Pass 1 (static SQL): 0 routines outside planned 3D drop/trim set.",
  "--            - Pass 2 (hardened dynamic EXECUTE — closes T0 Roadmap L437):",
  "--              flags ANY non-allowlisted active routine containing dynamic",
  "--              EXECUTE (catching concatenated table-name SQL and format(...));",
  "--              only allowlists verified historical helper",
  "--              public.direct_entry_hf_replace_proc_source(regprocedure, text, text, integer)",
  "--              AFTER verifying its EXECUTE privileges are revoked from PUBLIC,",
  "--              anon, authenticated, and service_role.",
  "--            - Pass 3 (string-literal table name check): 0 routines outside",
  "--              planned 3D drop/trim set referencing the 3 target tables.",
  "--   2. Ordered RESTRICT DDL (ZERO CASCADE):",
  "--      (a) Drop bridge trigger on direct_entry_team_leader_assignments +",
  "--          drop function public.work_report_sync_team_leader_capabilities() RESTRICT.",
  "--      (b) Drop public.work_report_team_leader_capability_grants RESTRICT FIRST",
  "--          (releases incoming ON DELETE CASCADE FK into direct_entry_capability_grants).",
  "--      (c) Revoke SELECT on direct_entry_capability_grants from",
  "--          direct_entry_catalog_bootstrap_executor and drop RLS policy",
  "--          direct_entry_catalog_bootstrap_capability_read.",
  "--      (d) Drop all 7 direct triggers on direct_entry_capability_grants (3)",
  "--          and direct_entry_scope_grants (4).",
  "--      (e) Drop public.direct_entry_scope_grants RESTRICT and",
  "--          public.direct_entry_capability_grants RESTRICT.",
  "--      (f) Preserve ALL 5 shared trigger functions intact — ONLY trim legacy",
  "--          cap/scope branches in direct_entry_guard_effective_interval() and",
  "--          direct_entry_set_current_on_insert().",
  "--      (g) Drop obsolete legacy & 3 dead historical functions using RESTRICT",
  "--          (in dependency-safe order: callers before LANGUAGE sql callees).",
  "--   3. Fail-closed post-drop self-check (do $wp10_7_3d_postcheck$):",
  "--      (a) Verify 3 target tables and 10 dropped legacy functions are absent.",
  "--      (b) Verify ALL 5 shared trigger functions remain intact with hardened",
  "--          search_path, owner-only EXECUTE ACL, and live triggers attached.",
  "--      (c) Verify 0 remaining pg_proc references to the 3 dropped tables.",
  "--      (d) Verify preserved authz & org tables remain intact with FORCE RLS.",
  "-- =============================================================================",
  "",
  "begin;",
  "",
  "-- =============================================================================",
  "-- 1. Fail-closed pre-drop gate",
  "-- =============================================================================",
  "",
  "do $wp10_7_3d_precheck$",
  "declare",
  "  v_cap_oid oid;",
  "  v_scope_oid oid;",
  "  v_bridge_oid oid;",
  "  v_unmanaged_total integer := 0;",
  "  v_unmanaged_active integer := 0;",
  "  v_unmanaged_disabled integer := 0;",
  "  v_view_count integer := 0;",
  "  v_views text;",
  "  v_ext_fk_count integer := 0;",
  "  v_ext_fks text;",
  "  v_dep_count integer := 0;",
  "  v_deps text;",
  "  v_wr_sync_oid oid;",
  "  v_wr_sync_overloads integer := 0;",
  "  v_extra_wr_trgs integer := 0;",
  "  v_extra_wr_trg_names text;",
  "  v_proc record;",
  "  v_norm text;",
  "  v_no_comments text;",
  "  v_public_acl_exec boolean;",
  "  v_privs_revoked boolean;",
  "  v_bad_static text[] := array[]::text[];",
  "  v_bad_dynamic text[] := array[]::text[];",
  "  v_bad_literal text[] := array[]::text[];",
  "  v_planned_drop_names constant text[] := array[",
  "    'direct_entry_authz__internal_sync_legacy_grants',",
  "    'work_report_sync_team_leader_capabilities',",
  "    'direct_entry_has_capability',",
  "    'direct_entry_has_scope',",
  "    'direct_entry__internal_capability_grant_effective',",
  "    'direct_entry__internal_team_scope_grant_effective',",
  "    'direct_entry_assert_actor',",
  "    'direct_entry__internal_reconcile_cancelled_team_leaders',",
  "    'direct_entry_transition_legacy_team_leaders',",
  "    'direct_entry_seed_team_scope_grants'",
  "  ];",
  "  v_dynamic_execute_allowlist constant text[] := array[",
  "    'public.direct_entry_hf_replace_proc_source(regprocedure, text, text, integer)'",
  "  ];",
  "begin",
  "  -- 1a. Verify all 3 target tables exist, then acquire ACCESS EXCLUSIVE locks in canonical order",
  "  v_bridge_oid := pg_catalog.to_regclass('public.work_report_team_leader_capability_grants');",
  "  v_cap_oid := pg_catalog.to_regclass('public.direct_entry_capability_grants');",
  "  v_scope_oid := pg_catalog.to_regclass('public.direct_entry_scope_grants');",
  "",
  "  if v_bridge_oid is null or v_cap_oid is null or v_scope_oid is null then",
  "    raise exception 'WP10-7-3D precheck failed: one or more legacy grant tables are missing (bridge=%, cap=%, scope=%)',",
  "      v_bridge_oid is not null, v_cap_oid is not null, v_scope_oid is not null",
  "      using errcode = '55000';",
  "  end if;",
  "",
  "  lock table",
  "    public.work_report_team_leader_capability_grants,",
  "    public.direct_entry_capability_grants,",
  "    public.direct_entry_scope_grants",
  "    in access exclusive mode;",
  "",
  "  -- 1b. Verify 0 active or disabled authz_managed = false accounts",
  "  select count(*)::integer,",
  "         count(*) filter (where u.enabled)::integer,",
  "         count(*) filter (where not u.enabled)::integer",
  "    into v_unmanaged_total, v_unmanaged_active, v_unmanaged_disabled",
  "    from public.direct_entry_app_users u",
  "   where not coalesce(u.authz_managed, false);",
  "",
  "  if v_unmanaged_total > 0 then",
  "    raise exception 'WP10-7-3D precheck failed: % authz_managed=false account(s) still exist (active=%, disabled=%)',",
  "      v_unmanaged_total, v_unmanaged_active, v_unmanaged_disabled",
  "      using errcode = '55000';",
  "  end if;",
  "",
  "  -- 1c. Verify 0 views / materialized views reference the 3 target tables",
  "  select count(*)::integer,",
  "         pg_catalog.string_agg(obj, ', ' order by obj)",
  "    into v_view_count, v_views",
  "    from (",
  "      select 'VIEW ' || v.schemaname || '.' || v.viewname as obj",
  "        from pg_catalog.pg_views v",
  "       where v.schemaname not in ('pg_catalog', 'information_schema')",
  "         and v.definition ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\\M'",
  "      union all",
  "      select 'MATVIEW ' || mv.schemaname || '.' || mv.matviewname as obj",
  "        from pg_catalog.pg_matviews mv",
  "       where mv.schemaname not in ('pg_catalog', 'information_schema')",
  "         and mv.definition ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\\M'",
  "    ) s;",
  "",
  "  if v_view_count > 0 then",
  "    raise exception 'WP10-7-3D precheck failed: % view(s)/matview(s) still reference legacy grant tables: %',",
  "      v_view_count, coalesce(v_views, '<unknown>')",
  "      using errcode = '55000';",
  "  end if;",
  "",
  "  -- 1d. Verify 0 incoming FKs from any 4th table & 0 unexpected external pg_depend objects",
  "  select count(*)::integer,",
  "         pg_catalog.string_agg(",
  "           cn.nspname || '.' || c.relname || '.' || con.conname || ' -> ' || fn.nspname || '.' || fc.relname,",
  "           ', '",
  "           order by cn.nspname, c.relname, con.conname",
  "         )",
  "    into v_ext_fk_count, v_ext_fks",
  "    from pg_catalog.pg_constraint con",
  "    join pg_catalog.pg_class c on c.oid = con.conrelid",
  "    join pg_catalog.pg_namespace cn on cn.oid = c.relnamespace",
  "    join pg_catalog.pg_class fc on fc.oid = con.confrelid",
  "    join pg_catalog.pg_namespace fn on fn.oid = fc.relnamespace",
  "   where con.contype = 'f'",
  "     and con.confrelid in (v_bridge_oid, v_cap_oid, v_scope_oid)",
  "     and con.conrelid not in (v_bridge_oid, v_cap_oid, v_scope_oid);",
  "",
  "  if v_ext_fk_count > 0 then",
  "    raise exception 'WP10-7-3D precheck failed: % incoming foreign key(s) from external table(s): %',",
  "      v_ext_fk_count, coalesce(v_ext_fks, '<unknown>')",
  "      using errcode = '55000';",
  "  end if;",
  "",
  "  select count(*)::integer,",
  "         pg_catalog.string_agg(",
  "           distinct pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid),",
  "           ', '",
  "         )",
  "    into v_dep_count, v_deps",
  "    from pg_catalog.pg_depend d",
  "   where d.refobjid in (v_bridge_oid, v_cap_oid, v_scope_oid)",
  "     and d.deptype in ('n', 'a', 'i')",
  "     and d.classid not in (",
  "       'pg_catalog.pg_type'::pg_catalog.regclass,",
  "       'pg_catalog.pg_class'::pg_catalog.regclass,",
  "       'pg_catalog.pg_trigger'::pg_catalog.regclass,",
  "       'pg_catalog.pg_attrdef'::pg_catalog.regclass",
  "     )",
  "     and not (",
  "       d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass",
  "       and exists (",
  "         select 1",
  "           from pg_catalog.pg_constraint con",
  "          where con.oid = d.objid",
  "            and con.conrelid in (v_bridge_oid, v_cap_oid, v_scope_oid)",
  "       )",
  "     )",
  "     and not (",
  "       d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass",
  "       and pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)",
  "           = 'policy direct_entry_catalog_bootstrap_capability_read on table direct_entry_capability_grants'",
  "     );",
  "",
  "  if v_dep_count > 0 then",
  "    raise exception 'WP10-7-3D precheck failed: % unexpected pg_depend object(s) reference legacy grant tables: %',",
  "      v_dep_count, coalesce(v_deps, '<unknown>')",
  "      using errcode = '55000';",
  "  end if;",
  "",
  "  -- 1e. Verify work_report_sync_team_leader_capabilities() trigger attachment",
  "  select count(*)::integer",
  "    into v_wr_sync_overloads",
  "    from pg_catalog.pg_proc p",
  "    join pg_catalog.pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname = 'public'",
  "     and p.proname = 'work_report_sync_team_leader_capabilities';",
  "",
  "  v_wr_sync_oid := pg_catalog.to_regprocedure('public.work_report_sync_team_leader_capabilities()');",
  "  if v_wr_sync_overloads <> 1 or v_wr_sync_oid is null then",
  "    raise exception 'WP10-7-3D precheck failed: expected single public.work_report_sync_team_leader_capabilities(), found %',",
  "      v_wr_sync_overloads",
  "      using errcode = '55000';",
  "  end if;",
  "",
  "  select count(*)::integer,",
  "         pg_catalog.string_agg(",
  "           t.tgrelid::pg_catalog.regclass::text || '.' || t.tgname,",
  "           ', '",
  "           order by t.tgrelid::pg_catalog.regclass::text, t.tgname",
  "         )",
  "    into v_extra_wr_trgs, v_extra_wr_trg_names",
  "    from pg_catalog.pg_trigger t",
  "   where t.tgfoid = v_wr_sync_oid",
  "     and not (",
  "       t.tgrelid = 'public.direct_entry_team_leader_assignments'::pg_catalog.regclass",
  "       and t.tgname = 'work_report_sync_team_leader_capabilities'",
  "       and not t.tgisinternal",
  "     );",
  "",
  "  if v_extra_wr_trgs > 0 then",
  "    raise exception 'WP10-7-3D precheck failed: % unexpected trigger(s) call work_report_sync_team_leader_capabilities(): %',",
  "      v_extra_wr_trgs, coalesce(v_extra_wr_trg_names, '<unknown>')",
  "      using errcode = '55000';",
  "  end if;",
  "",
  "  -- 1f. Hardened pg_proc dependency & dynamic EXECUTE scan across ALL non-system schemas",
  "  for v_proc in",
  "    select p.oid,",
  "           n.nspname as schema_name,",
  "           p.proname as proc_name,",
  "           n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' as sig,",
  "           p.prosrc,",
  "           p.proowner,",
  "           p.proacl",
  "      from pg_catalog.pg_proc p",
  "      join pg_catalog.pg_namespace n on n.oid = p.pronamespace",
  "     where n.nspname <> 'pg_catalog'",
  "       and n.nspname <> 'information_schema'",
  "       and n.nspname not like 'pg\\_%' escape '\\'",
  "       and n.nspname not in (",
  "         'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public',",
  "         'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions',",
  "         'supabase_migrations', 'net', 'pgtle', 'cron', 'pgbouncer'",
  "       )",
  "       and p.prokind in ('f', 'p')",
  "     order by n.nspname, p.proname, p.oid",
  "  loop",
  "    v_norm := pg_catalog.regexp_replace(",
  "      coalesce(v_proc.prosrc, ''),",
  "      $rx$('([^']|'')*'|--[^\\r\\n]*|/\\*([^*]|\\*+[^*/])*\\*+/)$rx$,",
  "      ' ',",
  "      'g'",
  "    );",
  "    v_no_comments := pg_catalog.regexp_replace(",
  "      pg_catalog.regexp_replace(",
  "        coalesce(v_proc.prosrc, ''),",
  "        $rx$(--[^\\r\\n]*|/\\*([^*]|\\*+[^*/])*\\*+/)$rx$,",
  "        ' ',",
  "        'g'",
  "      ),",
  "      '''''',",
  "      '''',",
  "      'g'",
  "    );",
  "",
  "    -- Pass 1: Static SQL reference check",
  "    if v_norm ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants|direct_entry_authz__internal_sync_legacy_grants|work_report_sync_team_leader_capabilities|direct_entry_has_capability|direct_entry_has_scope|direct_entry__internal_capability_grant_effective|direct_entry__internal_team_scope_grant_effective|direct_entry_assert_actor|direct_entry__internal_reconcile_cancelled_team_leaders|direct_entry_transition_legacy_team_leaders|direct_entry_seed_team_scope_grants)\\M'",
  "       and not (v_proc.schema_name = 'public' and v_proc.proc_name = any(v_planned_drop_names))",
  "       and not (v_proc.schema_name = 'public' and v_proc.proc_name = 'direct_entry_guard_effective_interval')",
  "    then",
  "      v_bad_static := array_append(v_bad_static, v_proc.sig);",
  "    end if;",
  "",
  "    -- Pass 2: Hardened dynamic EXECUTE check (catches concatenated table-name SQL / format(...))",
  "    if v_norm ~* '\\mexecute\\M' then",
  "      select exists (",
  "        select 1",
  "          from pg_catalog.aclexplode(coalesce(v_proc.proacl, pg_catalog.acldefault('f', v_proc.proowner))) a",
  "         where a.grantee = 0",
  "           and a.privilege_type = 'EXECUTE'",
  "      ) into v_public_acl_exec;",
  "",
  "      v_privs_revoked :=",
  "        not v_public_acl_exec",
  "        and not pg_catalog.has_function_privilege('public', v_proc.oid, 'EXECUTE')",
  "        and not pg_catalog.has_function_privilege('anon', v_proc.oid, 'EXECUTE')",
  "        and not pg_catalog.has_function_privilege('authenticated', v_proc.oid, 'EXECUTE')",
  "        and not pg_catalog.has_function_privilege('service_role', v_proc.oid, 'EXECUTE');",
  "",
  "      if not (v_proc.sig = any(v_dynamic_execute_allowlist) and v_privs_revoked) then",
  "        v_bad_dynamic := array_append(",
  "          v_bad_dynamic,",
  "          v_proc.sig || case",
  "            when v_proc.sig = any(v_dynamic_execute_allowlist) then ' [allowlisted helper privileges not revoked]'",
  "            else ' [non-allowlisted dynamic EXECUTE]'",
  "          end",
  "        );",
  "      end if;",
  "    end if;",
  "",
  "    -- Pass 3: Unexpected string-literal references to target table names",
  "    if v_no_comments ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\\M'",
  "       and not (v_norm ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\\M')",
  "       and not (v_proc.schema_name = 'public' and v_proc.proc_name = any(v_planned_drop_names))",
  "       and not (",
  "         v_proc.schema_name = 'public'",
  "         and v_proc.proc_name in ('direct_entry_guard_effective_interval', 'direct_entry_set_current_on_insert')",
  "       )",
  "    then",
  "      v_bad_literal := array_append(v_bad_literal, v_proc.sig);",
  "    end if;",
  "  end loop;",
  "",
  "  if coalesce(pg_catalog.array_length(v_bad_static, 1), 0) > 0 then",
  "    raise exception 'WP10-7-3D precheck failed: % non-system routine(s) still statically reference legacy grant tables/functions: %',",
  "      pg_catalog.array_length(v_bad_static, 1),",
  "      pg_catalog.array_to_string(v_bad_static, '; ')",
  "      using errcode = '55000';",
  "  end if;",
  "",
  "  if coalesce(pg_catalog.array_length(v_bad_dynamic, 1), 0) > 0 then",
  "    raise exception 'WP10-7-3D precheck failed: % non-allowlisted dynamic EXECUTE routine(s) found: %',",
  "      pg_catalog.array_length(v_bad_dynamic, 1),",
  "      pg_catalog.array_to_string(v_bad_dynamic, '; ')",
  "      using errcode = '55000';",
  "  end if;",
  "",
  "  if coalesce(pg_catalog.array_length(v_bad_literal, 1), 0) > 0 then",
  "    raise exception 'WP10-7-3D precheck failed: % routine(s) contain unexpected string-literal references to legacy grant tables: %',",
  "      pg_catalog.array_length(v_bad_literal, 1),",
  "      pg_catalog.array_to_string(v_bad_literal, '; ')",
  "      using errcode = '55000';",
  "  end if;",
  "end",
  "$wp10_7_3d_precheck$;",
  "",
  "-- =============================================================================",
  "-- 2. Ordered RESTRICT DDL (ZERO CASCADE; preserve ALL 5 shared trigger functions)",
  "-- =============================================================================",
  "",
  "-- 2a. Drop external bridge trigger + exclusive trigger function",
  "drop trigger work_report_sync_team_leader_capabilities on public.direct_entry_team_leader_assignments;",
  "drop function public.work_report_sync_team_leader_capabilities() restrict;",
  "",
  "-- 2b. Drop bridge table FIRST with RESTRICT (releases incoming FK into direct_entry_capability_grants)",
  "drop table public.work_report_team_leader_capability_grants restrict;",
  "",
  "-- 2c. Revoke bootstrap executor table privilege & drop RLS policy on direct_entry_capability_grants",
  "revoke select on public.direct_entry_capability_grants from direct_entry_catalog_bootstrap_executor;",
  "drop policy direct_entry_catalog_bootstrap_capability_read on public.direct_entry_capability_grants;",
  "",
  "-- 2d. Explicitly drop all 7 direct triggers on the legacy grant tables",
  "drop trigger direct_entry_capability_grant_marker_guard on public.direct_entry_capability_grants;",
  "drop trigger direct_entry_capability_grant_no_overlap on public.direct_entry_capability_grants;",
  "drop trigger direct_entry_set_current_on_insert on public.direct_entry_capability_grants;",
  "",
  "drop trigger direct_entry_no_vendor_team_scope on public.direct_entry_scope_grants;",
  "drop trigger direct_entry_scope_grant_marker_guard on public.direct_entry_scope_grants;",
  "drop trigger direct_entry_scope_grant_no_overlap on public.direct_entry_scope_grants;",
  "drop trigger direct_entry_set_current_on_insert on public.direct_entry_scope_grants;",
  "",
  "-- 2e. Drop remaining 2 legacy grant tables with RESTRICT",
  "drop table public.direct_entry_scope_grants restrict;",
  "drop table public.direct_entry_capability_grants restrict;",
  "",
  "-- 2f. Trim ONLY legacy cap/scope branches in 2 shared trigger functions (DO NOT DROP!)",
  "create or replace function public.direct_entry_guard_effective_interval()",
  "returns trigger",
  "language plpgsql",
  "set search_path = pg_catalog, public",
  "as $$",
  "declare",
  "  v_key text;",
  "  v_overlap boolean;",
  "begin",
  "  if tg_table_name = 'recruiter_provider_memberships' then",
  "    v_key := 'provider:' || new.recruiter_id::text;",
  "    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));",
  "    select exists (",
  "      select 1 from public.recruiter_provider_memberships m",
  "       where m.recruiter_id = new.recruiter_id",
  "         and m.membership_id <> coalesce(new.membership_id, '00000000-0000-0000-0000-000000000000'::uuid)",
  "         and daterange(m.valid_from, m.valid_to, '[)') &&",
  "             daterange(new.valid_from, new.valid_to, '[)')",
  "    ) into v_overlap;",
  "  elsif tg_table_name = 'recruiter_team_memberships' then",
  "    v_key := 'team-membership:' || new.recruiter_id::text;",
  "    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));",
  "    select exists (",
  "      select 1 from public.recruiter_team_memberships m",
  "       where m.recruiter_id = new.recruiter_id",
  "         and m.membership_id <> coalesce(new.membership_id, '00000000-0000-0000-0000-000000000000'::uuid)",
  "         and daterange(m.valid_from, m.valid_to, '[)') &&",
  "             daterange(new.valid_from, new.valid_to, '[)')",
  "    ) into v_overlap;",
  "  elsif tg_table_name = 'direct_entry_app_user_recruiter_links' and new.verified then",
  "    v_key := 'recruiter-link:' || new.app_user_id;",
  "    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));",
  "    select exists (",
  "      select 1 from public.direct_entry_app_user_recruiter_links l",
  "       where l.app_user_id = new.app_user_id",
  "         and l.verified",
  "         and l.link_id <> coalesce(new.link_id, '00000000-0000-0000-0000-000000000000'::uuid)",
  "         and daterange(l.valid_from, l.valid_to, '[)') &&",
  "             daterange(new.valid_from, new.valid_to, '[)')",
  "    ) into v_overlap;",
  "  else",
  "    raise exception 'unsupported interval table: %', tg_table_name using errcode = '22023';",
  "  end if;",
  "",
  "  if v_overlap then",
  "    raise exception 'effective interval overlaps an existing grant or membership'",
  "      using errcode = '23P01';",
  "  end if;",
  "  return new;",
  "end;",
  "$$;",
  "",
  "revoke all on function public.direct_entry_guard_effective_interval()",
  "  from public, anon, authenticated, service_role;",
  "",
  "create or replace function public.direct_entry_set_current_on_insert()",
  "returns trigger",
  "language plpgsql",
  "security definer",
  "set search_path = pg_catalog, public",
  "as $function$",
  "declare",
  "begin",
  "  if tg_op = 'UPDATE' then",
  "    if tg_table_name in ('direct_entry_project_manager_assignments', 'direct_entry_project_team_scopes') then",
  "      if old.revoked_at is null and new.revoked_at is not null then",
  "        new.is_current := false;",
  "        return new;",
  "      end if;",
  "    elsif tg_table_name = 'direct_entry_app_user_recruiter_links' then",
  "      if old.verified and not new.verified then",
  "        new.is_current := false;",
  "        return new;",
  "      end if;",
  "    end if;",
  "  end if;",
  "",
  "  -- Markers are set by the audited grant/activation operation. A scheduled",
  "  -- insert defaults to false and dates never promote it on a later request.",
  "  if not new.is_current then",
  "    return new;",
  "  end if;",
  "",
  "  case tg_table_name",
  "    when 'direct_entry_app_user_recruiter_links' then",
  "      select new.verified and u.enabled and r.active into new.is_current",
  "        from public.direct_entry_app_users u join public.recruiters r on r.recruiter_id = new.recruiter_id",
  "       where u.app_user_id = new.app_user_id;",
  "    when 'recruiter_team_memberships' then",
  "      select r.active and t.active into new.is_current",
  "        from public.recruiters r join public.teams t on t.team_id = new.team_id",
  "       where r.recruiter_id = new.recruiter_id;",
  "    when 'recruiter_provider_memberships' then",
  "      select r.active and (new.vendor_id is null or v.active) into new.is_current",
  "        from public.recruiters r left join public.vendors v on v.vendor_id = new.vendor_id",
  "       where r.recruiter_id = new.recruiter_id;",
  "    when 'direct_entry_project_manager_assignments' then",
  "      select new.revoked_at is null and r.active",
  "        and (select count(*)::int",
  "               from public.direct_entry_app_user_recruiter_links l",
  "              where l.recruiter_id = new.manager_recruiter_id and l.verified and l.is_current) = 1",
  "        and (select count(*)::int",
  "               from public.direct_entry_app_user_recruiter_links l",
  "               join public.direct_entry_app_users u on u.app_user_id = l.app_user_id",
  "              where l.recruiter_id = new.manager_recruiter_id and l.verified and l.is_current",
  "                and u.enabled and u.auth_subject is not null) = 1",
  "        into new.is_current",
  "        from public.recruiters r",
  "       where r.recruiter_id = new.manager_recruiter_id;",
  "    when 'direct_entry_project_team_scopes' then",
  "      select new.revoked_at is null and p.active and t.active into new.is_current",
  "        from public.direct_entry_projects p join public.teams t on t.team_id = new.team_id",
  "       where p.project_id = new.project_id;",
  "    when 'direct_entry_team_leader_assignments' then",
  "      select t.active and u.enabled and r.active and exists (",
  "        select 1 from public.direct_entry_app_user_recruiter_links l",
  "         where l.app_user_id = new.leader_app_user_id and l.recruiter_id = new.leader_recruiter_id",
  "           and l.verified and l.is_current",
  "      ) into new.is_current",
  "        from public.teams t join public.direct_entry_app_users u on u.app_user_id = new.leader_app_user_id",
  "        join public.recruiters r on r.recruiter_id = new.leader_recruiter_id",
  "       where t.team_id = new.team_id;",
  "    else",
  "      raise exception 'unsupported current-state table %', tg_table_name using errcode = '22023';",
  "  end case;",
  "  new.is_current := coalesce(new.is_current, false);",
  "  return new;",
  "end;",
  "$function$;",
  "",
  "revoke all on function public.direct_entry_set_current_on_insert()",
  "  from public, anon, authenticated, service_role;",
  "",
  "-- 2g. Drop obsolete legacy & 3 dead historical functions using RESTRICT (callers before LANGUAGE sql callees)",
  "drop function public.direct_entry__internal_reconcile_cancelled_team_leaders(date) restrict;",
  "drop function public.direct_entry_transition_legacy_team_leaders(date) restrict;",
  "drop function public.direct_entry_seed_team_scope_grants() restrict;",
  "drop function public.direct_entry_authz__internal_sync_legacy_grants(uuid) restrict;",
  "drop function public.direct_entry_assert_actor(uuid, uuid, text) restrict;",
  "drop function public.direct_entry_has_capability(uuid, text) restrict;",
  "drop function public.direct_entry_has_scope(uuid, text) restrict;",
  "drop function public.direct_entry__internal_capability_grant_effective(uuid, date) restrict;",
  "drop function public.direct_entry__internal_team_scope_grant_effective(uuid, date) restrict;",
  "",
  "-- =============================================================================",
  "-- 3. Fail-closed post-drop self-check",
  "-- =============================================================================",
  "",
  "do $wp10_7_3d_postcheck$",
  "declare",
  "  v_tbl_name text;",
  "  v_fn_name text;",
  "  v_sig text;",
  "  v_oid oid;",
  "  v_rec record;",
  "  v_rel record;",
  "  v_public_exec boolean;",
  "  v_remaining_overloads integer;",
  "  v_remaining_refs integer;",
  "  v_remaining_ref_sigs text;",
  "  v_dropped_tables constant text[] := array[",
  "    'public.work_report_team_leader_capability_grants',",
  "    'public.direct_entry_capability_grants',",
  "    'public.direct_entry_scope_grants'",
  "  ];",
  "  v_dropped_fn_names constant text[] := array[",
  "    'work_report_sync_team_leader_capabilities',",
  "    'direct_entry_authz__internal_sync_legacy_grants',",
  "    'direct_entry_has_capability',",
  "    'direct_entry_has_scope',",
  "    'direct_entry__internal_capability_grant_effective',",
  "    'direct_entry__internal_team_scope_grant_effective',",
  "    'direct_entry_assert_actor',",
  "    'direct_entry__internal_reconcile_cancelled_team_leaders',",
  "    'direct_entry_transition_legacy_team_leaders',",
  "    'direct_entry_seed_team_scope_grants'",
  "  ];",
  "  v_shared_trigger_fns constant text[] := array[",
  "    'public.direct_entry_clear_authority_on_disable()',",
  "    'public.direct_entry_guard_effective_interval()',",
  "    'public.direct_entry_set_current_on_insert()',",
  "    'public.direct_entry_reject_system_vendor_business_team()',",
  "    'public.direct_entry_team_leader_marker()'",
  "  ];",
  "  v_secdef_shared_fns constant text[] := array[",
  "    'public.direct_entry_clear_authority_on_disable()',",
  "    'public.direct_entry_set_current_on_insert()',",
  "    'public.direct_entry_reject_system_vendor_business_team()',",
  "    'public.direct_entry_team_leader_marker()'",
  "  ];",
  "  v_preserved_tables constant text[] := array[",
  "    'public.direct_entry_app_users',",
  "    'public.authz_user_groups',",
  "    'public.authz_user_group_members',",
  "    'public.direct_entry_team_leader_assignments',",
  "    'public.direct_entry_project_manager_assignments',",
  "    'public.direct_entry_app_user_recruiter_links',",
  "    'public.recruiter_team_memberships'",
  "  ];",
  "  v_live_triggers constant text[][] := array[",
  "    array['public.recruiter_provider_memberships', 'direct_entry_provider_membership_no_overlap'],",
  "    array['public.recruiter_team_memberships', 'direct_entry_team_membership_no_overlap'],",
  "    array['public.direct_entry_app_user_recruiter_links', 'direct_entry_recruiter_link_no_overlap'],",
  "    array['public.direct_entry_app_user_recruiter_links', 'direct_entry_set_current_on_insert'],",
  "    array['public.recruiter_team_memberships', 'direct_entry_set_current_on_insert'],",
  "    array['public.recruiter_provider_memberships', 'direct_entry_set_current_on_insert'],",
  "    array['public.direct_entry_project_manager_assignments', 'direct_entry_set_current_on_insert'],",
  "    array['public.direct_entry_project_team_scopes', 'direct_entry_set_current_on_insert'],",
  "    array['public.direct_entry_team_leader_assignments', 'direct_entry_set_current_on_insert'],",
  "    array['public.recruiter_team_memberships', 'direct_entry_no_vendor_recruiter_team_membership'],",
  "    array['public.direct_entry_team_leader_assignments', 'direct_entry_team_leader_assignment_marker_guard'],",
  "    array['public.direct_entry_app_users', 'direct_entry_clear_authority_on_disable'],",
  "    array['public.recruiters', 'direct_entry_clear_authority_on_disable'],",
  "    array['public.teams', 'direct_entry_clear_authority_on_disable'],",
  "    array['public.direct_entry_projects', 'direct_entry_clear_authority_on_disable'],",
  "    array['public.vendors', 'direct_entry_clear_authority_on_disable']",
  "  ];",
  "  v_idx integer;",
  "begin",
  "  -- 3a. Verify 3 target tables and 10 dropped functions are absent",
  "  foreach v_tbl_name in array v_dropped_tables loop",
  "    if pg_catalog.to_regclass(v_tbl_name) is not null then",
  "      raise exception 'WP10-7-3D postcheck failed: dropped table % still exists', v_tbl_name",
  "        using errcode = '55000';",
  "    end if;",
  "  end loop;",
  "",
  "  foreach v_fn_name in array v_dropped_fn_names loop",
  "    select count(*)::integer",
  "      into v_remaining_overloads",
  "      from pg_catalog.pg_proc p",
  "      join pg_catalog.pg_namespace n on n.oid = p.pronamespace",
  "     where n.nspname = 'public'",
  "       and p.proname = v_fn_name;",
  "",
  "    if v_remaining_overloads <> 0 then",
  "      raise exception 'WP10-7-3D postcheck failed: expected 0 overloads of public.%, found %',",
  "        v_fn_name, v_remaining_overloads",
  "        using errcode = '55000';",
  "    end if;",
  "  end loop;",
  "",
  "  -- 3b. Verify ALL 5 shared trigger functions remain intact with hardened search_path & ACL",
  "  foreach v_sig in array v_shared_trigger_fns loop",
  "    v_oid := pg_catalog.to_regprocedure(v_sig);",
  "    if v_oid is null then",
  "      raise exception 'WP10-7-3D postcheck failed: shared trigger function % missing', v_sig",
  "        using errcode = '55000';",
  "    end if;",
  "",
  "    select p.prosecdef, p.proconfig, p.proowner, p.proacl",
  "      into v_rec",
  "      from pg_catalog.pg_proc p",
  "     where p.oid = v_oid;",
  "",
  "    if not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then",
  "      raise exception 'WP10-7-3D postcheck failed: shared trigger function % missing hardened search_path', v_sig",
  "        using errcode = '55000';",
  "    end if;",
  "",
  "    if v_sig = any(v_secdef_shared_fns) and not coalesce(v_rec.prosecdef, false) then",
  "      raise exception 'WP10-7-3D postcheck failed: shared trigger function % lost SECURITY DEFINER', v_sig",
  "        using errcode = '55000';",
  "    end if;",
  "",
  "    select exists (",
  "      select 1",
  "        from pg_catalog.aclexplode(coalesce(v_rec.proacl, pg_catalog.acldefault('f', v_rec.proowner))) a",
  "       where a.grantee = 0",
  "         and a.privilege_type = 'EXECUTE'",
  "    ) into v_public_exec;",
  "",
  "    if v_public_exec",
  "       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')",
  "       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')",
  "       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')",
  "       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')",
  "       or not pg_catalog.has_function_privilege(v_rec.proowner, v_oid, 'EXECUTE') then",
  "      raise exception 'WP10-7-3D postcheck failed: invalid EXECUTE ACL on shared trigger function %', v_sig",
  "        using errcode = '55000';",
  "    end if;",
  "  end loop;",
  "",
  "  for v_idx in 1 .. pg_catalog.array_length(v_live_triggers, 1) loop",
  "    if not exists (",
  "      select 1",
  "        from pg_catalog.pg_trigger t",
  "       where t.tgrelid = pg_catalog.to_regclass(v_live_triggers[v_idx][1])",
  "         and t.tgname = v_live_triggers[v_idx][2]",
  "         and not t.tgisinternal",
  "    ) then",
  "      raise exception 'WP10-7-3D postcheck failed: live trigger %.% missing',",
  "        v_live_triggers[v_idx][1], v_live_triggers[v_idx][2]",
  "        using errcode = '55000';",
  "    end if;",
  "  end loop;",
  "",
  "  -- 3c. Verify 0 remaining pg_proc references to the 3 dropped tables across non-system schemas",
  "  select count(*)::integer,",
  "         pg_catalog.string_agg(",
  "           n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',",
  "           ', '",
  "           order by n.nspname, p.proname",
  "         )",
  "    into v_remaining_refs, v_remaining_ref_sigs",
  "    from pg_catalog.pg_proc p",
  "    join pg_catalog.pg_namespace n on n.oid = p.pronamespace",
  "   where n.nspname <> 'pg_catalog'",
  "     and n.nspname <> 'information_schema'",
  "     and n.nspname not like 'pg\\_%' escape '\\'",
  "     and n.nspname not in (",
  "       'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public',",
  "       'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions',",
  "       'supabase_migrations', 'net', 'pgtle', 'cron', 'pgbouncer'",
  "     )",
  "     and p.prokind in ('f', 'p')",
  "     and pg_catalog.regexp_replace(",
  "           coalesce(p.prosrc, ''),",
  "           $rx$(--[^\\r\\n]*|/\\*([^*]|\\*+[^*/])*\\*+/)$rx$,",
  "           ' ',",
  "           'g'",
  "         ) ~* '\\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\\M';",
  "",
  "  if v_remaining_refs > 0 then",
  "    raise exception 'WP10-7-3D postcheck failed: % routine(s) still mention dropped legacy grant tables: %',",
  "      v_remaining_refs, coalesce(v_remaining_ref_sigs, '<unknown>')",
  "      using errcode = '55000';",
  "  end if;",
  "",
  "  -- 3d. Verify preserved authz & org tables remain intact with RLS enabled & forced",
  "  foreach v_tbl_name in array v_preserved_tables loop",
  "    v_oid := pg_catalog.to_regclass(v_tbl_name);",
  "    if v_oid is null then",
  "      raise exception 'WP10-7-3D postcheck failed: preserved table % missing', v_tbl_name",
  "        using errcode = '55000';",
  "    end if;",
  "    select c.relrowsecurity, c.relforcerowsecurity",
  "      into v_rel",
  "      from pg_catalog.pg_class c",
  "     where c.oid = v_oid;",
  "    if not coalesce(v_rel.relrowsecurity, false)",
  "       or not coalesce(v_rel.relforcerowsecurity, false) then",
  "      raise exception 'WP10-7-3D postcheck failed: preserved table % must keep RLS enabled and forced', v_tbl_name",
  "        using errcode = '55000';",
  "    end if;",
  "  end loop;",
  "end",
  "$wp10_7_3d_postcheck$;",
  "",
  "commit;",
  ""
].join("\n");

const OWNER = {
  auth: "94300000-0000-4000-8000-00000000a001",
  app: "94300000-0000-4000-8000-00000000b001",
  email: "nobita6986@gmail.com",
  name: "Owner WP10-7-3D",
};
const LUANPT = {
  auth: "94300000-0000-4000-8000-00000000a002",
  app: "94300000-0000-4000-8000-00000000b002",
  email: "luanpt@hrpartner.vn",
  name: "Luan PT",
};
const LIENVU = {
  auth: "94300000-0000-4000-8000-00000000a003",
  app: "94300000-0000-4000-8000-00000000b003",
  email: "lienvu@hrpartner.vn",
  name: "Lien Vu",
};
const NGATTT = {
  auth: "94300000-0000-4000-8000-00000000a004",
  app: "94300000-0000-4000-8000-00000000b004",
  email: "ngattt@hrpartner.vn",
  name: "Nga TTT",
};

let seq = 1;
function nextUuid() {
  return `94310000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
}
function sha256(val) {
  return createHash("sha256").update(String(val), "utf8").digest("hex");
}
function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

function binary(name) {
  const binDir =
    process.env.P3_1_W02A_PG_BIN ??
    (process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\18\\bin" : "");
  const candidate = binDir
    ? path.join(binDir, `${name}${process.platform === "win32" ? ".exe" : ""}`)
    : name;
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  return result.error ? null : candidate;
}

function runBin(file, args, { ignoreOutput = false, input = undefined, cwd = undefined } = {}) {
  const result = spawnSync(file, args, {
    encoding: "utf8",
    windowsHide: true,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(ignoreOutput ? { stdio: "ignore" } : {}),
  });
  assert.equal(result.status, 0, `${path.basename(file)} failed:\n${result.stderr || result.stdout}`);
  return result;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

async function connect(port, appName, database = "postgres") {
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    database,
    application_name: appName,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function serviceQuery(client, sql, params = []) {
  await client.query(
    "begin; set local deadlock_timeout = '100ms'; set local statement_timeout = '15s'; set local role service_role",
  );
  try {
    const res = await client.query(sql, params);
    await client.query("commit");
    return res;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function serviceRpc(client, fnName, args = [], casts = []) {
  const placeholders = args
    .map((_, i) => (casts[i] ? `$${i + 1}::${casts[i]}` : `$${i + 1}`))
    .join(", ");
  const res = await serviceQuery(client, `select public.${fnName}(${placeholders}) as data`, args);
  return res.rows[0]?.data;
}

async function serviceRpcNamed(client, fnName, namedArgs = {}) {
  const entries = Object.entries(namedArgs);
  const placeholders = entries.map(([k], i) => `${k} => $${i + 1}`).join(", ");
  const values = entries.map(([, v]) => v);
  try {
    const res = await serviceQuery(client, `select public.${fnName}(${placeholders}) as data`, values);
    return { data: res.rows[0]?.data, error: null };
  } catch (err) {
    return { data: null, error: { code: err?.code, message: err?.message, detail: err?.detail } };
  }
}

async function tryServiceRpc(client, fnName, args = [], casts = []) {
  try {
    const data = await serviceRpc(client, fnName, args, casts);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, code: err?.code ?? "ERR", message: err?.message ?? String(err) };
  }
}

async function seedLegacyAdmin(client, user) {
  await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [user.auth, user.email]);
  await client.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, true, false, 1)`,
    [user.app, user.auth, user.name],
  );
  await client.query(
    `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, is_current)
     values ($1::uuid, 'all', null, '2026-01-01', true)`,
    [user.app],
  );
  for (const cap of ["entry_admin", "recruiter_master_manage", "team_master_manage"]) {
    await client.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2, '2026-01-01', true)`,
      [user.app, cap],
    );
  }
}

async function seedAccount(client, slug, displayName, { authzManaged = true, enabled = true } = {}) {
  const auth = nextUuid();
  const app = nextUuid();
  await client.query("insert into auth.users (id, email) values ($1::uuid, $2)", [auth, `${slug}@hrpartner.local`]);
  await client.query(
    `insert into public.direct_entry_app_users (app_user_id, auth_subject, display_name, enabled, authz_managed, version)
     values ($1::uuid, $2::uuid, $3, $4, $5, 1)`,
    [app, auth, displayName, enabled, authzManaged],
  );
  return { auth, app, slug, name: displayName };
}

async function getAccountVersion(client, appUserId) {
  const { rows } = await client.query(
    "select version, enabled, authz_managed from public.direct_entry_app_users where app_user_id = $1::uuid",
    [appUserId],
  );
  return rows[0];
}

async function getTeamVersion(client, teamId) {
  const { rows: [r] } = await client.query("select version from public.teams where team_id = $1::uuid", [teamId]);
  return r.version;
}

async function seedRecruiterPerson(client, slug, displayName, teamId, deptId, { position = "STAFF", authzManaged = true, groupId = null } = {}) {
  const acc = await seedAccount(client, slug, displayName, { authzManaged });
  const rec = nextUuid();
  const code = `R3D_${slug.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)}_${seq}`;
  await client.query(
    `insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active)
     values ($1::uuid, $2, $3, $4, true)`,
    [rec, displayName, code, position],
  );
  await client.query(
    `insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, is_current)
     values ($1::uuid, 'hrp', '2026-01-01', true)`,
    [rec],
  );
  await client.query(
    `insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
     values ($1::uuid, $2::uuid, true, '2026-01-01', true)`,
    [acc.app, rec],
  );
  if (teamId) {
    await client.query(
      `insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, '2026-01-01', true)`,
      [rec, teamId],
    );
  }
  if (deptId) {
    await serviceRpc(client, "org_department_create_person_admin", [
      OWNER.auth, OWNER.app, `PER-${code}`, displayName, "2026-01-01",
      deptId, acc.app, 1, rec, `Seed person ${slug}`, nextUuid(), sha256(`per:${acc.app}:${seq}`),
    ]);
  }
  if (groupId && authzManaged) {
    const ver = (await getAccountVersion(client, acc.app)).version;
    const idemp = nextUuid();
    await serviceRpc(
      client,
      "direct_entry_authz_assign_group_member_admin",
      [OWNER.auth, OWNER.app, acc.app, groupId, ver, `Assign group ${slug}`, idemp, sha256(`grp:${acc.app}:${groupId}:${idemp}`)],
      ["uuid", "uuid", "uuid", "uuid", "integer", "text", "uuid", "text"],
    );
  }
  return { ...acc, rec, code };
}

async function apiAssignGroup(client, targetAppUserId, groupId, reason, atIso) {
  const { version } = await getAccountVersion(client, targetAppUserId);
  const ownerCtx = await serviceRpc(client, "direct_entry_resolve_actor_context", [OWNER.auth], ["uuid"]);
  const ownerTs = await resolveActor({
    session: { auth_subject: OWNER.auth, provider: "supabase", authenticated_at: atIso },
    repository: { loadByAuthSubject: async () => ownerCtx },
    at: atIso,
  });
  const repo = createServicePermissionGroupRepository((name, args) => serviceRpcNamed(client, name, args));
  const req = new Request(`http://localhost/api/admin/access/accounts/${targetAppUserId}/groups`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
      "sec-fetch-site": "same-origin",
      "idempotency-key": nextUuid(),
    },
    body: JSON.stringify({ group_id: groupId, expected_account_version: version, reason }),
  });
  const res = await assignAccountGroupAdmin(req, targetAppUserId, "true", {
    resolveSession: async () => ({ actor: ownerTs, response_headers: {} }),
    repository: repo,
  });
  const body = await res.json();
  assert.equal(res.status, 201, `assignAccountGroupAdmin failed: ${res.status} ${JSON.stringify(body)}`);
  return body.membership;
}

async function apiRemoveGroup(client, targetAppUserId, membershipId, reason, atIso) {
  const { version } = await getAccountVersion(client, targetAppUserId);
  const ownerCtx = await serviceRpc(client, "direct_entry_resolve_actor_context", [OWNER.auth], ["uuid"]);
  const ownerTs = await resolveActor({
    session: { auth_subject: OWNER.auth, provider: "supabase", authenticated_at: atIso },
    repository: { loadByAuthSubject: async () => ownerCtx },
    at: atIso,
  });
  const repo = createServicePermissionGroupRepository((name, args) => serviceRpcNamed(client, name, args));
  const req = new Request(`http://localhost/api/admin/access/accounts/${targetAppUserId}/groups/${membershipId}`, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
      "sec-fetch-site": "same-origin",
      "idempotency-key": nextUuid(),
    },
    body: JSON.stringify({ expected_account_version: version, reason }),
  });
  const res = await removeAccountGroupAdmin(req, targetAppUserId, membershipId, "true", {
    resolveSession: async () => ({ actor: ownerTs, response_headers: {} }),
    repository: repo,
  });
  const body = await res.json();
  assert.equal(res.status, 200, `removeAccountGroupAdmin failed: ${res.status} ${JSON.stringify(body)}`);
  return body.membership;
}

async function apiToggleAccount(client, targetAppUserId, action, reason, atIso) {
  const { version } = await getAccountVersion(client, targetAppUserId);
  const ownerCtx = await serviceRpc(client, "direct_entry_resolve_actor_context", [OWNER.auth], ["uuid"]);
  const ownerTs = await resolveActor({
    session: { auth_subject: OWNER.auth, provider: "supabase", authenticated_at: atIso },
    repository: { loadByAuthSubject: async () => ownerCtx },
    at: atIso,
  });
  const repo = createAccountAccessRepository((name, args) => serviceRpcNamed(client, name, args));
  const idempKey = nextUuid();
  const req = new Request(`http://localhost/api/admin/access/accounts/${targetAppUserId}/${action}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
      "sec-fetch-site": "same-origin",
      "idempotency-key": idempKey,
    },
    body: JSON.stringify({ expected_version: version, reason, idempotency_key: idempKey }),
  });
  const res = await mutateAccount(req, targetAppUserId, action, "true", {
    resolveSession: async () => ({ actor: ownerTs, response_headers: {} }),
    repository: repo,
  });
  const body = await res.json();
  assert.equal(res.status, 200, `mutateAccount(${action}) failed: ${res.status} ${JSON.stringify(body)}`);
  return body;
}

function replaceSqlWithEmptyLegacySubqueries(defSql) {
  const emptyCapSubquery =
    "(select null::uuid as grant_id, null::uuid as app_user_id, null::text as capability, null::date as valid_from, null::date as valid_to, null::timestamptz as created_at, false as is_current, false as suspended_by_account_disable where false)";
  const emptyScopeSubquery =
    "(select null::uuid as grant_id, null::uuid as app_user_id, null::text as scope_kind, null::uuid as team_id, null::date as valid_from, null::date as valid_to, null::timestamptz as created_at, false as is_current, false as suspended_by_account_disable where false)";
  const emptyBridgeSubquery =
    "(select null::uuid as leader_assignment_id, null::text as capability, null::uuid as capability_grant_id where false)";

  let out = defSql;
  out = out.replace(/perform\s+public\.direct_entry_authz__internal_sync_legacy_grants\([^;]*\);/gi, "-- 3C: sync retired");
  out = out.replace(/perform\s+public\.direct_entry_assert_actor\([^;]*\);/gi, "raise exception 'legacy authz_managed=false retired' using errcode = '42501';");
  out = out.replace(/public\.direct_entry_has_capability\([^()]*\)/gi, "false");
  out = out.replace(/public\.direct_entry_has_scope\([^()]*\)/gi, "false");
  out = out.replace(/public\.direct_entry__internal_capability_grant_effective\([^()]*\)/gi, "false");
  out = out.replace(/public\.direct_entry__internal_team_scope_grant_effective\([^()]*\)/gi, "false");
  out = out.replace(/public\.direct_entry_capability_grants\b/gi, emptyCapSubquery);
  out = out.replace(/public\.direct_entry_scope_grants\b/gi, emptyScopeSubquery);
  out = out.replace(/public\.work_report_team_leader_capability_grants\b/gi, emptyBridgeSubquery);
  return out;
}

function applyTransforms(sig, sourceSql, transforms) {
  let next = sourceSql;
  for (const [label, regex, replacement] of transforms) {
    assert.ok(regex.test(next), `Simulated 3C regex patch failed for ${sig} :: ${label}`);
    next = next.replace(regex, replacement);
  }
  return next;
}

/**
 * Generates a clean, self-contained simulated WP10-7 Slice 3C migration SQL against the live
 * 253-migration baseline (`76b3fae2`, post-3A & post-3B) so that ALL 63 remaining blocking
 * routines cut over cleanly to `authz_managed = true` with 0 legacy table/fn references while
 * keeping ALL live runtime RPCs 100% functional!
 */
async function buildSimulated3cMigrationSql(client) {
  const precheck = await runWp1073dPrecheck(client);
  const statements = [
    "-- Simulated WP10-7 Slice 3C cutover migration (generated strictly in os.tmpdir() for Stage 1 3D rehearsal)",
    "begin;",
    "alter table public.direct_entry_app_users alter column authz_managed set default true;",
    `create or replace function public.work_report_sync_team_leader_capabilities()
     returns trigger language plpgsql security definer set search_path = pg_catalog, public
     as $function$ begin return new; end; $function$;`,
    `create or replace function public.direct_entry_authz__internal_sync_legacy_grants(p_app_user_id uuid)
     returns void language plpgsql security definer set search_path = pg_catalog, public
     as $function$ begin return; end; $function$;`,
  ];

  const readDef = async (sig) => {
    const { rows: [row] } = await client.query(
      "select pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure($1)) as def",
      [sig],
    );
    assert.ok(row?.def, `Missing function definition for ${sig}`);
    return row.def;
  };

  const handled = new Set();

  // 1. direct_entry_list_team_leader_candidates (post-3B)
  {
    const sig = "public.direct_entry_list_team_leader_candidates(uuid, uuid, uuid, text, integer, integer)";
    handled.add(sig);
    const patched = applyTransforms(sig, await readDef(sig), [[
      "drop-legacy-not-exists-post-3b",
      /and\s*\(\s*coalesce\(u\.authz_managed,\s*false\)\s*or not exists\s*\(\s*select 1 from public\.direct_entry_scope_grants[\s\S]*?(?=\s*\),\s*filtered\s+as\s*\()/i,
      "-- 3C: legacy cap/scope NOT EXISTS retired",
    ]]);
    statements.push(`${patched.trim().replace(/;+$/, "")};`);
  }

  // 2. direct_entry_apply_team_leader_mutation (post-3B)
  {
    const sig = "public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text)";
    handled.add(sig);
    const patched = applyTransforms(sig, await readDef(sig), [
      [
        "remove-phase1-and-postlock-cap-exists",
        /or exists \(\s*select 1\s+from public\.direct_entry_capability_grants g[\s\S]*?and g\.is_current\s*\)/gi,
        "-- 3C: removed cap_grants exists check",
      ],
      [
        "remove-tier5-scope-locks",
        /perform s\.grant_id\s+from public\.direct_entry_scope_grants s[\s\S]*?perform pg_advisory_xact_lock\(hashtextextended\(v_lock_key, 0\)\);\s*end loop;/i,
        "-- 3C: removed tier5 scope_grants locks",
      ],
      [
        "remove-tier5-cap-locks",
        /if cardinality\(v_write_user_ids\) > 0 then\s+perform g\.grant_id\s+from public\.direct_entry_capability_grants g[\s\S]*?perform pg_advisory_xact_lock\(hashtextextended\(v_lock_key, 0\)\);\s*end loop;\s*end if;/i,
        "-- 3C: removed tier5 cap_grants locks",
      ],
      [
        "remove-phase3-scope-expire",
        /update public\.direct_entry_scope_grants s\s+set is_current = false,[\s\S]*?and s\.valid_to <= v_today;/i,
        "-- 3C: removed scope_grants expire sync",
      ],
      [
        "remove-phase3-cap-expire",
        /update public\.direct_entry_capability_grants g\s+set is_current = false,[\s\S]*?and a\.valid_to = g\.valid_to\s*\);/i,
        "-- 3C: removed cap_grants expire sync",
      ],
      [
        "remove-phase3-scope-promote",
        /update public\.direct_entry_scope_grants s\s+set is_current = true[\s\S]*?and not coalesce\(u\.authz_managed, false\)\s*\);/i,
        "-- 3C: removed scope_grants promote sync",
      ],
      [
        "remove-phase3-cap-promote",
        /update public\.direct_entry_capability_grants g\s+set is_current = true[\s\S]*?and g\.valid_to is not distinct from a\.valid_to\s*\);/i,
        "-- 3C: removed cap_grants promote sync",
      ],
      [
        "remove-designate-legacy-preguard",
        /if not v_target_authz_managed then\s+if exists \(\s*select 1\s+from public\.direct_entry_scope_grants s[\s\S]*?raise exception 'target leader has pre-existing leader authority intervals'\s+using errcode = '42501';\s*end if;\s*end if;/i,
        "-- 3C: removed designate legacy preguard",
      ],
      [
        "remove-old-legacy-preguard",
        /if v_old_count = 1 and not v_old_authz_managed then[\s\S]*?raise exception 'outgoing leader has ambiguous future authority intervals'\s+using errcode = '42501';\s*end if;\s*end if;/i,
        "-- 3C: removed outgoing legacy preguard",
      ],
      [
        "remove-prev-restore-legacy-selects",
        /if p_operation = 'revoke' and v_previous\.assignment_id is not null then[\s\S]*?v_restore := true;\s*end if;\s*end if;/i,
        `if p_operation = 'revoke' and v_previous.assignment_id is not null then
    if not exists (
      select 1
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = v_previous.leader_app_user_id
         and a.assignment_id <> v_previous.assignment_id
         and a.is_current
    ) then
      v_restore := true;
    end if;
  end if;`,
      ],
      [
        "remove-old-legacy-writes",
        /if v_old_count = 1 then\s+if p_effective_date = v_old\.valid_from then[\s\S]*?and gc\.capability = 'team_manager_assign'\s*\);\s*end if;\s*end if;/i,
        `if v_old_count = 1 then
    if p_effective_date = v_old.valid_from then
      perform set_config('direct_entry.team_leader_marker', 'on', true);
    end if;
    update public.direct_entry_team_leader_assignments
       set valid_to = p_effective_date,
           is_current = (p_effective_date > v_old.valid_from and v_old.valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
           suspended_by_account_disable = false
     where assignment_id = v_old.assignment_id;
  end if;`,
      ],
      [
        "remove-restore-legacy-writes",
        /if v_restore then\s+if not v_prev_authz_managed then[\s\S]*?where grant_id = v_prev_capability_grant_id;\s*end if;\s*end if;/i,
        `if v_restore then
    update public.direct_entry_team_leader_assignments
       set valid_to = null,
           is_current = (v_previous.valid_from <= v_today),
           suspended_by_account_disable = false
     where assignment_id = v_previous.assignment_id;
  end if;`,
      ],
      [
        "remove-designate-legacy-inserts",
        /if not v_target_authz_managed then\s+insert into public\.direct_entry_scope_grants[\s\S]*?end if;\s+insert into public\.direct_entry_team_leader_assignments[\s\S]*?returning \* into v_new;\s+if not v_target_authz_managed then\s+insert into public\.direct_entry_capability_grants[\s\S]*?end if;/i,
        `insert into public.direct_entry_team_leader_assignments
      (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current, suspended_by_account_disable)
    values
      (p_team_id, p_target_leader_app_user_id, v_recruiter_id, p_effective_date, (p_effective_date <= v_today), false)
    returning * into v_new;`,
      ],
      [
        "remove-designate-legacy-postcondition",
        /if not v_target_authz_managed then\s+select count\(\*\)::int,\s+count\(\*\) filter \(where s\.team_id = p_team_id\)::int[\s\S]*?raise exception 'team leader mutation postcondition failed' using errcode = '55000';\s*end if;\s*end if;/i,
        "-- 3C: removed designate legacy postcondition",
      ],
      [
        "remove-outgoing-legacy-postcondition-queries",
        /if not v_old_authz_managed then\s+select count\(\*\)::int into v_post_outgoing_scope_count[\s\S]*?raise exception 'team leader mutation postcondition failed' using errcode = '55000';\s*end if;\s*end if;/gi,
        "-- 3C: removed outgoing legacy postcondition",
      ],
      [
        "remove-restored-legacy-postcondition-queries",
        /if not v_prev_authz_managed then\s+select count\(\*\)::int into v_post_restored_scope_count[\s\S]*?raise exception 'team leader mutation postcondition failed' using errcode = '55000';\s*end if;\s*end if;/i,
        "-- 3C: removed restored legacy postcondition",
      ],
    ]);
    statements.push(`${replaceSqlWithEmptyLegacySubqueries(patched).trim().replace(/;+$/, "")};`);
  }

  // 3. direct_entry_clear_authority_on_disable()
  {
    const sig = "public.direct_entry_clear_authority_on_disable()";
    handled.add(sig);
    const patched = applyTransforms(sig, await readDef(sig), [
      [
        "remove-all-sg-locks",
        /perform s\.grant_id\s+from public\.direct_entry_scope_grants s[\s\S]*?perform pg_advisory_xact_lock\(hashtextextended\(v_lock_key, 0\)\);\s*end loop;/gi,
        "-- 3C: removed scope_grants locks",
      ],
      [
        "remove-all-cg-locks",
        /perform g\.grant_id\s+from public\.direct_entry_capability_grants g[\s\S]*?perform pg_advisory_xact_lock\(hashtextextended\(v_lock_key, 0\)\);\s*end loop;/gi,
        "-- 3C: removed cap_grants locks",
      ],
      [
        "remove-app-user-sg-cg-suspend",
        /update public\.direct_entry_scope_grants\s+set is_current = false,\s+suspended_by_account_disable = true\s+where app_user_id = new\.app_user_id\s+and is_current = true;\s+update public\.direct_entry_team_leader_assignments\s+set is_current = false,\s+suspended_by_account_disable = true\s+where leader_app_user_id = new\.app_user_id\s+and is_current = true;\s+update public\.direct_entry_capability_grants\s+set is_current = false,\s+suspended_by_account_disable = true\s+where app_user_id = new\.app_user_id\s+and is_current = true;/i,
        `update public.direct_entry_team_leader_assignments
           set is_current = false, suspended_by_account_disable = true
         where leader_app_user_id = new.app_user_id and is_current = true;`,
      ],
      [
        "remove-team-sg-clear",
        /update public\.direct_entry_scope_grants\s+set is_current = false,\s+suspended_by_account_disable = false\s+where team_id = new\.team_id;/i,
        "-- 3C: removed scope_grants clear on team disable",
      ],
    ]);
    statements.push(`${patched.trim().replace(/;+$/, "")};`);
  }

  // 4. direct_entry_mutate_app_user_status(...)
  {
    const sig = "public.direct_entry_mutate_app_user_status(uuid, uuid, uuid, integer, text, text, boolean)";
    handled.add(sig);
    const patched = applyTransforms(sig, await readDef(sig), [
      [
        "remove-team-ids-scope-union",
        /union\s+select s\.team_id as tid\s+from public\.direct_entry_scope_grants s[\s\S]*?and s\.team_id is not null/i,
        "-- 3C: removed scope_grants from v_team_ids",
      ],
      [
        "remove-status-sg-locks",
        /perform s\.grant_id\s+from public\.direct_entry_scope_grants s[\s\S]*?perform pg_advisory_xact_lock\(hashtextextended\(v_lock_key, 0\)\);\s*end loop;/i,
        "-- 3C: removed status scope_grants locks",
      ],
      [
        "remove-status-cg-locks",
        /perform g\.grant_id\s+from public\.direct_entry_capability_grants g[\s\S]*?perform pg_advisory_xact_lock\(hashtextextended\(v_lock_key, 0\)\);\s*end loop;/i,
        "-- 3C: removed status cap_grants locks",
      ],
      [
        "remove-status-tl-restore-and-else-sg-cg",
        /if v_can_restore_tl then\s+update public\.direct_entry_scope_grants s[\s\S]*?perform pg_catalog\.set_config\('direct_entry\.team_leader_marker', coalesce\(v_prev_marker, ''\), true\);\s*end if;/i,
        `if v_can_restore_tl then
        update public.direct_entry_team_leader_assignments a
           set is_current = true, suspended_by_account_disable = false
         where a.assignment_id = v_tla.assignment_id;
      else
        perform pg_catalog.set_config('direct_entry.team_leader_marker', 'on', true);
        update public.direct_entry_team_leader_assignments a
           set is_current = false, suspended_by_account_disable = false,
               valid_to = coalesce(a.valid_to, greatest(v_today, a.valid_from))
         where a.assignment_id = v_tla.assignment_id;
        perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
      end if;`,
      ],
      [
        "remove-status-step3-and-sync",
        /-- Step 3: Restore suspended global scope grants[\s\S]*?if v_target\.authz_managed then\s+perform public\.direct_entry_authz__internal_sync_legacy_grants\(p_target_app_user_id\);\s*end if;/i,
        "-- 3C: removed Step 3 legacy restore & sync_legacy_grants",
      ],
    ]);
    statements.push(`${patched.trim().replace(/;+$/, "")};`);
  }

  // 5. direct_entry_lock_project_team_manager_context(...)
  {
    const sig = "public.direct_entry_lock_project_team_manager_context(uuid, uuid, uuid, uuid)";
    handled.add(sig);
    const patched = applyTransforms(sig, await readDef(sig), [[
      "remove-pm-lock-sg-cg",
      /perform s\.grant_id\s+from public\.direct_entry_scope_grants s[\s\S]*?for update;\s+perform g\.grant_id\s+from public\.direct_entry_capability_grants g[\s\S]*?for update;/i,
      "-- 3C: removed scope/cap FOR UPDATE in lock_project_team_manager_context",
    ]]);
    statements.push(`${patched.trim().replace(/;+$/, "")};`);
  }

  // 6. Permission group mutators
  {
    const sig = "public.direct_entry_authz_assign_group_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)";
    handled.add(sig);
    const patched = applyTransforms(sig, await readDef(sig), [
      [
        "remove-uncutover-cap-check",
        /if not coalesce\(v_target\.authz_managed, false\)\s+and exists \(\s*select 1\s+from public\.direct_entry_capability_grants g[\s\S]*?raise exception 'AUTHZ_CUTOVER_NOT_READY' using errcode = 'PT409';\s*end if;/i,
        "-- 3C: removed uncutover legacy cap check",
      ],
      [
        "remove-assign-sync",
        /perform public\.direct_entry_authz__internal_sync_legacy_grants\(p_target_app_user_id\);/i,
        "-- 3C: sync_legacy_grants stopped",
      ],
    ]);
    statements.push(`${patched.trim().replace(/;+$/, "")};`);
  }
  {
    const sig = "public.direct_entry_authz_remove_group_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)";
    handled.add(sig);
    const patched = applyTransforms(sig, await readDef(sig), [[
      "remove-rm-sync",
      /perform public\.direct_entry_authz__internal_sync_legacy_grants\(p_target_app_user_id\);/i,
      "-- 3C: sync_legacy_grants stopped",
    ]]);
    statements.push(`${patched.trim().replace(/;+$/, "")};`);
  }
  {
    const sig = "public.direct_entry_authz_update_group_admin(uuid, uuid, uuid, integer, text, text, uuid, uuid, boolean, text[], jsonb, text, uuid, text)";
    handled.add(sig);
    const patched = applyTransforms(sig, await readDef(sig), [[
      "remove-upd-sync",
      /perform public\.direct_entry_authz__internal_sync_legacy_grants\(v_member_id\);/i,
      "-- 3C: sync_legacy_grants stopped",
    ]]);
    statements.push(`${patched.trim().replace(/;+$/, "")};`);
  }

  // 7. direct_entry_authz__internal_resolve_effective_grants(uuid)
  {
    const sig = "public.direct_entry_authz__internal_resolve_effective_grants(uuid)";
    handled.add(sig);
    const patched = applyTransforms(sig, await readDef(sig), [
      [
        "tl-wr-review-unconditional",
        /where v_user\.authz_managed\s+and tla\.leader_app_user_id = p_app_user_id/i,
        "where tla.leader_app_user_id = p_app_user_id",
      ],
      [
        "drop-legacy-bridge-ctes",
        /,\s*tl_wr_compat_bridge as \([\s\S]*?all_grants as \([\s\S]*?\)\s*select coalesce\(/i,
        `,\n  all_grants as (\n    select * from group_bundle_grants\n    union all\n    select * from contextual_tl_grants\n    union all\n    select * from contextual_tl_wr_review_grants\n    union all\n    select * from contextual_pa_grants\n  )\n  select coalesce(`,
      ],
    ]);
    statements.push(`${patched.trim().replace(/;+$/, "")};`);
  }

  // 8. direct_entry_resolve_actor_context(uuid)
  {
    const sig = "public.direct_entry_resolve_actor_context(uuid)";
    handled.add(sig);
    const patched = applyTransforms(sig, await readDef(sig), [
      [
        "unify-caps-scopes-projection",
        /if v_authz_managed then[\s\S]*?with valid_paired_grants as \([\s\S]*?into v_capabilities, v_teams, v_team_scope_grants, v_all_scope_grants;\s+else\s+select\s+coalesce\(\([\s\S]*?from public\.direct_entry_scope_grants g[\s\S]*?into v_capabilities, v_teams, v_team_scope_grants, v_all_scope_grants;\s+end if;/i,
        (m) => {
          const elseIdx = m.search(/\belse\s+select\s+coalesce/i);
          assert.ok(elseIdx > 0);
          return `${m.slice(0, elseIdx).replace(/^if v_authz_managed then/i, "-- 3C unified canonical projection\n    if true then")}\n    end if;`;
        },
      ],
      [
        "unify-review-scopes",
        /if v_authz_managed then\s+select coalesce\(\(\s*select pg_catalog\.jsonb_agg\(pg_catalog\.jsonb_build_object\([\s\S]*?into v_review_scopes;\s+else\s+select coalesce\(\([\s\S]*?from public\.direct_entry_scope_grants g[\s\S]*?into v_review_scopes;\s+end if;/i,
        (m) => {
          const elseIdx = m.search(/\belse\s+select coalesce/i);
          assert.ok(elseIdx > 0);
          return `${m.slice(0, elseIdx).replace(/^if v_authz_managed then/i, "-- 3C unified review scopes\n    if true then")}\n    end if;`;
        },
      ],
      [
        "unify-tl-check",
        /if v_authz_managed then\s+select exists \(\s*select 1\s+from pg_catalog\.jsonb_to_recordset\(v_effective_grants\)[\s\S]*?elsif public\.direct_entry_has_capability\(v_app_user_id, 'team_manager_assign'\) then[\s\S]*?end if;/i,
        (m) => {
          const elsifIdx = m.search(/\belsif public\.direct_entry_has_capability/i);
          assert.ok(elsifIdx > 0);
          return `${m.slice(0, elsifIdx).replace(/^if v_authz_managed then/i, "-- 3C unified TL check\n    if true then")}\n    end if;`;
        },
      ],
      [
        "unify-worker-tab-uploader",
        /case\s+when v_authz_managed then \(\s*public\.direct_entry_authz__internal_has_paired_capability\(v_app_user_id, 'submission_create', 'OWN', null\)\s+or public\.direct_entry_authz__internal_has_paired_capability\(v_app_user_id, 'submission_create', 'ALL', null\)\s*\)\s+else \([\s\S]*?end/i,
        `(public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'submission_create', 'OWN', null)
              or public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'submission_create', 'ALL', null))`,
      ],
      [
        "unify-worker-tab-all",
        /case\s+when v_authz_managed then \(\s*public\.direct_entry_authz__internal_has_paired_capability\(v_app_user_id, 'entry_admin', 'ALL', null\)\s+or public\.direct_entry_authz__internal_has_paired_capability\(v_app_user_id, 'change_review', 'ALL', null\)\s*\)\s+else \([\s\S]*?end/i,
        `(public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'entry_admin', 'ALL', null)
            or public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'change_review', 'ALL', null))`,
      ],
    ]);
    statements.push(`${patched.trim().replace(/;+$/, "")};`);
  }

  // 9. Account operation legacy lock/sync removal (create_personnel, link_recruiter, finalize_create)
  for (const sig of [
    "public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)",
    "public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)",
    "public.direct_entry_account_operation_finalize_create(uuid, uuid, uuid, uuid, uuid, text)",
  ]) {
    handled.add(sig);
    let def = await readDef(sig);
    def = def.replace(/perform\s+s\.grant_id\s+from public\.direct_entry_scope_grants[\s\S]*?for update;/gi, "-- 3C: removed scope_grants lock");
    def = def.replace(/perform\s+g\.grant_id\s+from public\.direct_entry_capability_grants[\s\S]*?for update;/gi, "-- 3C: removed cap_grants lock");
    def = replaceSqlWithEmptyLegacySubqueries(def);
    statements.push(`${def.trim().replace(/;+$/, "")};`);
  }

  // 10. All remaining blocking static procs: retire dead `not authz_managed` fallback branches
  //     while keeping 100% of live `authz_managed = true` paths intact!
  for (const proc of precheck.blockingStaticProcs) {
    if (handled.has(proc.signature)) continue;
    let def = await readDef(proc.signature);
    def = def.replace(/perform\s+s\.grant_id\s+from public\.direct_entry_scope_grants[\s\S]*?for update;/gi, "-- 3C: removed scope lock");
    def = def.replace(/perform\s+g\.grant_id\s+from public\.direct_entry_capability_grants[\s\S]*?for update;/gi, "-- 3C: removed cap lock");
    def = def.replace(/for update/gi, (match, offset, str) => {
      const prev = str.slice(Math.max(0, offset - 240), offset);
      if (/direct_entry_(?:capability|scope)_grants/i.test(prev)) return "";
      return match;
    });
    def = replaceSqlWithEmptyLegacySubqueries(def);
    statements.push(`${def.trim().replace(/;+$/, "")};`);
  }

  statements.push("commit;");
  return `${statements.join("\n\n")}\n`;
}

test("WP10-7 Slice 3D (PG18): Fail-closed runner gate, 3-table post-archive drift abort, hardened dynamic EXECUTE precheck, ordered RESTRICT drop, runtime regression & 8/8 restore parity", async () => {
  // ---------------------------------------------------------------------------
  // 0. Template Hygiene & Byte-for-Byte Parity with Local Staged Template (when present)
  // ---------------------------------------------------------------------------
  let staged3dSql = EMBEDDED_STAGED_3D_TEMPLATE_SQL;
  try {
    await stat(LOCAL_STAGED_3D_TEMPLATE_PATH);
    const localTemplateSql = await readFile(LOCAL_STAGED_3D_TEMPLATE_PATH, "utf8");
    assert.equal(
      EMBEDDED_STAGED_3D_TEMPLATE_SQL,
      localTemplateSql,
      "Embedded 3D template SQL must match C:/CodeApp/bi-refactor-next/wp10/t1b/wp10-7-3d-migration-template.sql byte-for-byte",
    );
    staged3dSql = localTemplateSql;
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }

  assert.equal(staged3dSql.includes("\r\n"), false, "3D migration template must use LF line endings");
  assert.equal(staged3dSql.replace(/--[^\n]*/g, "").includes("@"), false, "3D migration template must contain zero literal '@'");
  assert.equal(/\bsavepoint\b/i.test(staged3dSql), false, "3D migration template must contain zero SAVEPOINT");
  assert.equal(/\bcascade\b/i.test(staged3dSql.replace(/--[^\n]*/g, "")), false, "3D migration template must NEVER use CASCADE");
  const dropBridgePos = staged3dSql.search(/drop\s+table\s+public\.work_report_team_leader_capability_grants\s+restrict\s*;/i);
  const dropScopePos = staged3dSql.search(/drop\s+table\s+public\.direct_entry_scope_grants\s+restrict\s*;/i);
  const dropCapPos = staged3dSql.search(/drop\s+table\s+public\.direct_entry_capability_grants\s+restrict\s*;/i);
  assert.ok(
    dropBridgePos > 0 && dropScopePos > dropBridgePos && dropCapPos > dropBridgePos,
    "3D migration must DROP work_report_team_leader_capability_grants RESTRICT before direct_entry_scope_grants and direct_entry_capability_grants",
  );
  assert.equal(isWp1073dMigrationName(STAGED_3D_MIGRATION_NAME), true);

  const initdb = binary("initdb");
  const pgCtl = binary("pg_ctl");
  const psqlBin = binary("psql");
  assert.ok(initdb && pgCtl && psqlBin, "PostgreSQL 18 initdb/pg_ctl/psql binaries are required");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "wp10-7-3d-pg18-"));
  const pgData = path.join(tmpDir, "pgdata");
  const pgLog = path.join(tmpDir, "postgres.log");
  const fakeWorkspace = path.join(tmpDir, "fake-workspace");
  const fakeMigrationsDir = path.join(fakeWorkspace, "supabase", "migrations");
  const port = await freePort();
  let started = false;
  const clients = [];

  try {
    await mkdir(fakeMigrationsDir, { recursive: true });
    const repoMigFiles = (await readdir(MIGRATION_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const fname of repoMigFiles) {
      await copyFile(path.join(MIGRATION_DIR, fname), path.join(fakeMigrationsDir, fname));
    }

    runBin(initdb, ["-D", pgData, "-U", "postgres", "-A", "trust", "--encoding=UTF8", "--no-locale"], {
      ignoreOutput: true,
    });
    runBin(
      pgCtl,
      [
        "-D",
        pgData,
        "-l",
        pgLog,
        "-w",
        "-o",
        `-F -h 127.0.0.1 -p ${port} ${process.platform === "win32" ? "" : '-k "" '}-c deadlock_timeout=100ms -c log_min_messages=warning`,
        "start",
      ],
      { ignoreOutput: true },
    );
    started = true;

    let setup = await connect(port, "wp10-7-3d-setup");
    let observer = await connect(port, "wp10-7-3d-observer");
    clients.push(setup, observer);

    await setup.query(
      "create role anon; create role authenticated; create role service_role;" +
        " create schema auth; create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);",
    );

    const groupsIdx = repoMigFiles.indexOf(PR28_PERMISSION_GROUPS_FOUNDATION_MIGRATION_NAME);
    const wp1073bIdx = repoMigFiles.indexOf(WP10_7_3B_MIGRATION_NAME);
    assert.ok(groupsIdx > 0, "PR28 permission groups migration must exist");
    assert.ok(wp1073bIdx > groupsIdx, "WP10-7 Slice 3B migration must exist");

    // -------------------------------------------------------------------------
    // 1. Apply 0..groupsIdx-1 -> seed legacy admins & run WP5 cutover -> apply groupsIdx..3B-1
    //    Seed pre-3B active Team Leader so bridge table gets 4 real active rows -> apply 3B..253
    // -------------------------------------------------------------------------
    for (let i = 0; i < groupsIdx; i += 1) {
      await setup.query(await readFile(path.join(fakeMigrationsDir, repoMigFiles[i]), "utf8"));
    }
    await seedLegacyAdmin(setup, OWNER);
    await seedLegacyAdmin(setup, LUANPT);
    await seedLegacyAdmin(setup, LIENVU);
    await seedLegacyAdmin(setup, NGATTT);

    const wp5Plan = await runWp5Cutover(setup, { mode: "read-only-plan" });
    assert.equal(wp5Plan.action_diff.unexpected_diff_count, 0);
    const wp5Applied = await runWp5Cutover(setup, {
      mode: "apply",
      confirmApply: true,
      expectedFingerprint: wp5Plan.manifest_fingerprint,
    });
    assert.equal(wp5Applied.status, "APPLIED");

    for (let i = groupsIdx; i < wp1073bIdx; i += 1) {
      await setup.query(await readFile(path.join(fakeMigrationsDir, repoMigFiles[i]), "utf8"));
    }

    const { rows: [dateRow] } = await observer.query("select public.direct_entry_authorization_date()::text as d");
    const todayStr = dateRow.d;
    const yesterdayStr = addDaysIso(todayStr, -1);
    const tomorrowStr = addDaysIso(todayStr, 1);
    const atIso = `${todayStr}T09:00:00Z`;
    const yearMonth = todayStr.slice(0, 7);
    const leaveYear = Number(todayStr.slice(0, 4));

    const TEAM_A = nextUuid();
    const TEAM_B = nextUuid();
    const PRJ_1 = "wp10-7-3d-prj-1";
    await setup.query(
      `insert into public.teams (team_id, code, display_name, active, version)
       values ($1::uuid, 'team_3d_a', 'Đội 3D A', true, 1),
              ($2::uuid, 'team_3d_b', 'Đội 3D B', true, 1)`,
      [TEAM_A, TEAM_B],
    );
    await setup.query(
      `insert into public.direct_entry_projects (project_id, display_name, active, version)
       values ($1, 'Dự án WP10-7 3D', true, 1)`,
      [PRJ_1],
    );
    await setup.query("insert into public.direct_entry_banks (bank_id, display_name, active) values ('vcb', 'Vietcombank', true)");
    for (const tid of [TEAM_A, TEAM_B]) {
      await setup.query(
        `insert into public.direct_entry_project_team_scopes
           (project_id, team_id, valid_from, is_current, version, granted_by_user_id)
         values ($1, $2::uuid, '2026-01-01', true, 1, $3::uuid)`,
        [PRJ_1, tid, OWNER.app],
      );
    }

    const { rows: depts } = await setup.query(
      "select department_id::text, system_key from public.organization_departments where is_active = true",
    );
    const deptByKey = Object.fromEntries(depts.map((d) => [d.system_key, d.department_id]));
    const { rows: grps } = await setup.query(
      "select group_id::text, code from public.authz_user_groups where active = true",
    );
    const grpByCode = Object.fromEntries(grps.map((g) => [g.code, g.group_id]));

    const GRP_CATALOG = (
      await serviceRpc(
        setup,
        "direct_entry_authz_create_group_admin",
        [
          OWNER.auth, OWNER.app, "WP107_3D_CATALOG", "Nhóm Danh mục 3D", "WP10-7 3D test group",
          deptByKey.ACCOUNTING, null, ["catalog_master_manage"], JSON.stringify([]),
          "Create WP107_3D_CATALOG", nextUuid(), sha256("grp:wp107_3d_catalog"),
        ],
        ["uuid", "uuid", "text", "text", "text", "uuid", "uuid", "text[]", "jsonb", "text", "uuid", "text"],
      )
    ).group_id;

    // Seed Work Report Template
    const wrSchema = {
      version: "work-report-schema/1.0",
      sections: [{
        section_key: "kpi", label: "KPI", description: null, sort_order: 10,
        fields: [{
          field_key: "calls", section_key: "kpi", sort_order: 10, label: "Cuộc gọi", description: null,
          field_type: "integer", required: true, default_value: 0,
          validation: { min_value: 0, max_value: 1000, allow_zero: true }, options: null,
          is_metric: true,
          metric_spec: {
            metric_key: "calls", unit: "cuộc", aggregations: ["SUM"],
            null_policy: "EXCLUDE_FROM_AVG", zero_policy: "INCLUDE_AS_ZERO",
            compatible_group: "wp107_3d_calls_v1",
          },
          is_dimension: false,
        }],
      }],
    };
    const wrMetrics = {
      version: "work-report-metrics/1.0",
      metrics: [{
        metric_key: "calls", field_key: "calls", field_type: "integer", unit: "cuộc",
        aggregations: ["SUM"], null_policy: "EXCLUDE_FROM_AVG", zero_policy: "INCLUDE_AS_ZERO",
        compatible_group: "wp107_3d_calls_v1",
      }],
    };
    const wrTpl = await serviceRpc(setup, "work_report_create_template", [
      OWNER.auth, OWNER.app, "WP107_3D_TPL", "WP107_3D_TPL", "Mẫu 3D", "DAILY",
      JSON.stringify(wrSchema), JSON.stringify(wrMetrics), `tpl-${nextUuid()}`,
    ]);
    await serviceRpc(setup, "work_report_publish_template", [
      OWNER.auth, OWNER.app, wrTpl.template_id, wrTpl.draft_version_id, wrTpl.version, `pub-${nextUuid()}`,
    ]);

    const HR_OP = await seedAccount(setup, "hr.3d", "HR Operator 3D");
    await apiAssignGroup(setup, HR_OP.app, grpByCode.HR_CATALOG_OPERATOR, "Assign HR_OP", atIso);

    const UPLOADER = await seedRecruiterPerson(setup, "uploader.3d", "Uploader 3D", TEAM_A, deptByKey.RECRUITMENT, {
      position: "STAFF", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    await serviceRpc(
      setup,
      "leave_management_upsert_employee_profile_admin",
      [
        OWNER.auth, OWNER.app, UPLOADER.app, "OFFICIAL", null,
        "2026-01-01", "2026-01-01", null, 0, 0,
        "Seed uploader leave profile", nextUuid(), sha256(`lv:${UPLOADER.app}`),
      ],
      ["uuid", "uuid", "uuid", "text", "text", "date", "date", "date", "integer", "integer", "text", "text", "text"],
    );
    const { rows: [ltRow] } = await setup.query(
      "select labor_type_key from public.direct_entry_labor_types where active = true order by sort_order, labor_type_key limit 1",
    );
    const validLaborType = ltRow?.labor_type_key ?? "official";
    const createdBatch = await serviceRpc(
      setup,
      "direct_entry_create_batch",
      [
        UPLOADER.auth, UPLOADER.app,
        JSON.stringify([{
          project_id: PRJ_1,
          first_work_date: todayStr,
          employee_code: `hrp-${todayStr.slice(0, 4)}-940001`,
          worker_details: {
            display_name: "Nguyen Van 3D",
            date_of_birth: { state: "omitted" },
            national_id: { state: "omitted" },
            address: { state: "omitted" },
            phone: { state: "omitted" },
          },
          recruiter_id: UPLOADER.rec,
          labor_type: validLaborType,
        }]),
        `3d-batch-${nextUuid()}`,
      ],
      ["uuid", "uuid", "jsonb", "text"],
    );
    const sampleEntryId = createdBatch.entry_ids[0];
    await serviceRpc(
      setup,
      "work_report_create_assignment",
      [
        OWNER.auth, OWNER.app, wrTpl.template_id, "USER", UPLOADER.app, null, null,
        "DAILY", true, 0, "18:00:00", false, null, null, `asgn-${nextUuid()}`,
      ],
      ["uuid", "uuid", "uuid", "text", "uuid", "uuid", "uuid[]", "text", "boolean", "integer", "time", "boolean", "date", "date", "text"],
    );

    const PM_USER = await seedRecruiterPerson(setup, "pm.3d", "PM 3D", TEAM_A, deptByKey.RECRUITMENT, {
      position: "STAFF", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    const pmAssignInit = await serviceRpc(
      setup,
      "direct_entry_assign_project_manager",
      [OWNER.auth, OWNER.app, PRJ_1, PM_USER.rec, todayStr, 1, "Seed PM 3D", `pm-${nextUuid()}`],
      ["uuid", "uuid", "text", "uuid", "date", "integer", "text", "text"],
    );
    const pmAssignmentId = pmAssignInit?.assignment?.assignment_id ?? pmAssignInit?.assignment_id;
    assert.ok(pmAssignmentId, "Expected PM assignment_id");

    const PA_USER = await seedAccount(setup, "pa.3d", "PA 3D");
    await serviceRpc(setup, "org_department_create_person_admin", [
      OWNER.auth, OWNER.app, "PER-PA-3D", "PA 3D", "2026-01-01",
      deptByKey.ACCOUNTING, PA_USER.app, 1, null, "Seed PA person", nextUuid(), sha256(`per:pa:${PA_USER.app}`),
    ]);
    await serviceRpc(
      setup,
      "vendor_finance_assign_project_accountant_admin",
      [OWNER.auth, OWNER.app, PRJ_1, PA_USER.app, 0, todayStr, "Seed PA 3D", nextUuid(), sha256(`pa:${PA_USER.app}`)],
      ["uuid", "uuid", "text", "uuid", "integer", "date", "text", "uuid", "text"],
    );

    // Pre-3B Team Leader designation -> populates 4 genuine rows in work_report_team_leader_capability_grants!
    const TL_ACTIVE = await seedRecruiterPerson(setup, "tl.active.3d", "Trưởng nhóm 3D", TEAM_A, deptByKey.RECRUITMENT, {
      position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    const TL_REPLACE = await seedRecruiterPerson(setup, "tl.replace.3d", "Trưởng nhóm Thay Thế 3D", TEAM_A, deptByKey.RECRUITMENT, {
      position: "TEAM_LEADER", authzManaged: true, groupId: grpByCode.RECRUITER_OPERATIONS,
    });
    const tv0 = await getTeamVersion(setup, TEAM_A);
    await serviceRpc(
      setup,
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, TEAM_A, TL_ACTIVE.app, todayStr, tv0, "Pre-3B active TL populating bridge", `tl-pre3b-${nextUuid()}`],
      ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );

    // Apply remaining real repo migrations (#253 3B .. end of repo migrations)
    for (let i = wp1073bIdx; i < repoMigFiles.length; i += 1) {
      await setup.query(await readFile(path.join(fakeMigrationsDir, repoMigFiles[i]), "utf8"));
    }

    // Seed rich realistic edge-case rows in cap & scope grants (historical closed, cancellation marker, future-dated, suspended)
    const SUSPENDED_USER = await seedAccount(setup, "susp.3d", "Suspended 3D");
    await setup.query("begin; set local direct_entry.team_leader_marker = 'on'");
    await setup.query(
      `insert into public.direct_entry_capability_grants (app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable)
       values ($1::uuid, 'payment_view', $2::date, $3::date, false, false),
              ($1::uuid, 'payment_edit', $3::date, $3::date, false, false),
              ($1::uuid, 'pii_export', $4::date, null, false, false),
              ($5::uuid, 'entry_create', $2::date, null, false, true)`,
      [HR_OP.app, yesterdayStr, todayStr, tomorrowStr, SUSPENDED_USER.app],
    );
    await setup.query(
      `insert into public.direct_entry_scope_grants (app_user_id, scope_kind, team_id, valid_from, valid_to, is_current, suspended_by_account_disable)
       values ($1::uuid, 'team', $2::uuid, $3::date, $4::date, false, false),
              ($1::uuid, 'team', $2::uuid, $4::date, $4::date, false, false),
              ($1::uuid, 'team', $2::uuid, $5::date, null, false, false),
              ($6::uuid, 'own', null, $3::date, null, false, true)`,
      [HR_OP.app, TEAM_B, yesterdayStr, todayStr, tomorrowStr, SUSPENDED_USER.app],
    );
    await setup.query("commit");

    // Verify all 3 target tables are richly populated before 3C/3D
    const preFingerprints = await computeWp1073dLiveFingerprintsInTx(observer);
    assert.ok(preFingerprints.tables.direct_entry_capability_grants.row_count >= 20);
    assert.ok(preFingerprints.tables.direct_entry_scope_grants.row_count >= 8);
    assert.equal(preFingerprints.tables.work_report_team_leader_capability_grants.row_count, 4);

    // -------------------------------------------------------------------------
    // 2. Build & apply simulated Slice 3C migration (#254) + stage REAL Slice 3D (#255)
    //    Record 0..254 in public.schema_migrations so #255 (3D) is PENDING for real CLI!
    // -------------------------------------------------------------------------
    const sim3cSql = await buildSimulated3cMigrationSql(setup);
    await writeFile(path.join(fakeMigrationsDir, SIMULATED_3C_MIGRATION_NAME), sim3cSql, "utf8");
    await writeFile(path.join(fakeMigrationsDir, STAGED_3D_MIGRATION_NAME), staged3dSql, "utf8");
    await setup.query(sim3cSql);

    // Verify precheck on post-3C DB is 100% READY!
    const post3cPrecheck = await runWp1073dPrecheck(observer);
    assert.equal(
      post3cPrecheck.ready,
      true,
      `Expected post-3C precheck ready=true, reasons=${JSON.stringify(post3cPrecheck.reasons)}`,
    );
    assert.equal(post3cPrecheck.summary.blocking_static_procs, 0);
    assert.equal(post3cPrecheck.summary.blocking_dynamic_execute_procs, 0);
    assert.equal(post3cPrecheck.summary.allowlisted_dynamic_execute_procs, 1);
    assert.equal(post3cPrecheck.summary.unexpected_string_literal_procs, 0);
    assert.equal(post3cPrecheck.summary.blocking_views_or_matviews, 0);
    assert.equal(post3cPrecheck.summary.incoming_external_fks, 0);
    assert.equal(post3cPrecheck.summary.unexpected_pg_depend_objects, 0);
    assert.equal(post3cPrecheck.summary.unmanaged_accounts, 0);

    // Seed public.schema_migrations for all migrations up through simulated 3C (leaving 3D pending!)
    await setup.query(`
      create table if not exists public.schema_migrations (
        version     text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      )
    `);
    const allPre3dFiles = [...repoMigFiles, SIMULATED_3C_MIGRATION_NAME].sort();
    for (const fname of allPre3dFiles) {
      const sqlText = await readFile(path.join(fakeMigrationsDir, fname), "utf8");
      await setup.query(
        "insert into public.schema_migrations (version, checksum) values ($1, $2) on conflict (version) do nothing",
        [fname, migrationChecksum(sqlText)],
      );
    }

    // Helper to execute the REAL scripts/apply-migrations.mjs CLI against our temp workspace!
    const cfgPath = path.join(tmpDir, "supabase-3d-local.config");
    await writeFile(
      cfgPath,
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://wp10-7-3d-local.supabase.co",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_local_test",
        "SUPABASE_SECRET_KEY=sb_secret_local_test",
        `SUPABASE_DB_URL=postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
        "",
      ].join("\n"),
      "utf8",
    );
    const runApplyCli = (args) => {
      const cliEnv = {
        ...process.env,
        SUPABASE_DB_SSL_MODE: "disable",
        SUPABASE_SECRET_KEY: "sb_secret_local_test",
        SUPABASE_CONFIG_FILE: cfgPath,
      };
      delete cliEnv.SUPABASE_DB_URL;
      delete cliEnv.SUPABASE_POOLER_HOST;
      delete cliEnv.SUPABASE_POOLER_PORT;
      return spawnSync(process.execPath, [path.join(ROOT, "scripts", "apply-migrations.mjs"), ...args], {
        cwd: fakeWorkspace,
        env: cliEnv,
        encoding: "utf8",
        windowsHide: true,
        timeout: 60000,
      });
    };

    const assertAll3TablesIntact = async (label, expectedFingerprints) => {
      const { rows: [reg] } = await observer.query(`
        select to_regclass('public.direct_entry_capability_grants') is not null as cap,
               to_regclass('public.direct_entry_scope_grants') is not null as scope,
               to_regclass('public.work_report_team_leader_capability_grants') is not null as bridge
      `);
      assert.deepEqual(reg, { cap: true, scope: true, bridge: true }, `${label}: all 3 tables must stay intact`);
      const { rows: mig3d } = await observer.query(
        "select 1 from public.schema_migrations where version = $1",
        [STAGED_3D_MIGRATION_NAME],
      );
      assert.equal(mig3d.length, 0, `${label}: schema_migrations must NOT record 3D`);
      if (expectedFingerprints) {
        const live = await computeWp1073dLiveFingerprintsInTx(observer);
        assert.deepEqual(live.tables, expectedFingerprints.tables, `${label}: live 3-table fingerprints must stay intact`);
        assert.deepEqual(live.bundle, expectedFingerprints.bundle, `${label}: live bundle fingerprint must stay intact`);
      }
    };

    // -------------------------------------------------------------------------
    // REQUIREMENT 1: Default runner fails closed when 3D pending without archive
    // -------------------------------------------------------------------------
    const offlineCli = runApplyCli(["--", "--offline"]);
    assert.equal(offlineCli.status, 0, offlineCli.stderr || offlineCli.stdout);
    assert.match(offlineCli.stdout, /OFFLINE VALIDATION/);

    const dryRunPreCli = runApplyCli(["--dry-run"]);
    assert.equal(dryRunPreCli.status, 0, dryRunPreCli.stderr || dryRunPreCli.stdout);
    assert.match(dryRunPreCli.stdout, new RegExp(`PENDING ${STAGED_3D_MIGRATION_NAME.replaceAll(".", "\\.")}`));

    const defaultNoArchiveCli = runApplyCli([]);
    assert.notEqual(
      defaultNoArchiveCli.status,
      0,
      `Default apply-migrations.mjs without archive MUST fail closed when 3D is pending:\n${defaultNoArchiveCli.stdout}`,
    );
    assert.match(
      defaultNoArchiveCli.stderr,
      /requires verified 3-table archive parity before dropping/,
    );
    await assertAll3TablesIntact("Requirement 1 (default CLI without archive)", preFingerprints);

    // -------------------------------------------------------------------------
    // REQUIREMENT 2: Export verified archive to dirA -> relocate to dirB & delete dirA
    //                + Hardened negative archive-gate checks (before DDL & ledger write)
    //                + Post-archive data drift abort (ALL 3 TABLES!)
    // -------------------------------------------------------------------------
    const archiveDirA = path.join(tmpDir, "wp10-7-3d-archive-dirA");
    const archiveDirB = path.join(tmpDir, "wp10-7-3d-archive-dirB-relocated");
    const exported = await exportWp1073dLegacyGrantsArchive(observer, archiveDirA);

    // Verify restore.sql uses strictly portable relative CSV filenames (zero absolute paths!)
    const exportedRestoreSql = await readFile(exported.restoreSqlPath, "utf8");
    assert.equal(
      exportedRestoreSql.includes(archiveDirA.replaceAll("\\", "/")),
      false,
      "restore.sql must NEVER embed absolute export directory path",
    );
    assert.equal(
      exportedRestoreSql.includes(tmpDir.replaceAll("\\", "/")),
      false,
      "restore.sql must NEVER embed temporary directory prefix",
    );
    assert.equal(
      /FROM\s+'(?:\/|[a-zA-Z]:|\\)/i.test(exportedRestoreSql),
      false,
      "restore.sql \\copy FROM clauses must use relative filenames only",
    );
    assert.match(
      exportedRestoreSql,
      /\\copy public\.direct_entry_capability_grants .* FROM 'direct_entry_capability_grants\.archive\.csv'/,
    );
    assert.match(
      exportedRestoreSql,
      /\\copy public\.direct_entry_scope_grants .* FROM 'direct_entry_scope_grants\.archive\.csv'/,
    );
    assert.match(
      exportedRestoreSql,
      /\\copy public\.work_report_team_leader_capability_grants .* FROM 'work_report_team_leader_capability_grants\.archive\.csv'/,
    );

    // Relocate entire archive directory from dirA -> dirB and DELETE dirA completely!
    await cp(archiveDirA, archiveDirB, { recursive: true });
    await rm(archiveDirA, { recursive: true, force: true });
    await assert.rejects(() => stat(archiveDirA), (err) => err?.code === "ENOENT");

    const relocatedManifestPath = path.join(archiveDirB, "manifest.json");
    const relocatedRestoreSqlPath = path.join(archiveDirB, "restore.sql");
    const verifiedArchive = await loadAndVerifyWp1073dArchiveManifest(relocatedManifestPath);
    assert.equal(verifiedArchive.expectedBundle.row_count, preFingerprints.bundle.row_count);
    assert.equal(verifiedArchive.expectedBundle.canonical_sha256, preFingerprints.bundle.canonical_sha256);
    assert.equal(path.resolve(verifiedArchive.restoreSqlPath), path.resolve(relocatedRestoreSqlPath));
    assert.equal(verifiedArchive.restoreSqlSha256, exported.manifest.restore_sql_sha256);

    // Negative archive-gate tests (ALL 3 T0 review cases): real CLI MUST block BEFORE DDL & ledger write!
    const runNegativeArchiveCase = async (label, mutateDir, expectedPattern) => {
      const badDir = path.join(tmpDir, `bad-arc-${seq++}`);
      await cp(archiveDirB, badDir, { recursive: true });
      try {
        await mutateDir(badDir);
        const badManifestPath = path.join(badDir, "manifest.json");
        const cliRes = runApplyCli(["--wp10-7-3d-archive-manifest", badManifestPath]);
        assert.notEqual(cliRes.status, 0, `${label}: CLI must fail closed BEFORE DDL`);
        assert.match(cliRes.stderr, expectedPattern, `${label}: stderr mismatch`);
        await assertAll3TablesIntact(`Negative archive gate (${label})`, preFingerprints);
      } finally {
        await rm(badDir, { recursive: true, force: true });
      }
    };

    await runNegativeArchiveCase(
      "missing catalog_snapshot",
      async (dir) => {
        const m = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
        delete m.catalog_snapshot;
        await writeFile(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2), "utf8");
      },
      /catalog_snapshot/i,
    );
    await runNegativeArchiveCase(
      "incomplete catalog_snapshot",
      async (dir) => {
        const m = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
        delete m.catalog_snapshot.tables.direct_entry_scope_grants;
        await writeFile(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2), "utf8");
      },
      /catalog_snapshot/i,
    );
    await runNegativeArchiveCase(
      "missing restore_sql_file in manifest",
      async (dir) => {
        const m = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
        delete m.restore_sql_file;
        await writeFile(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2), "utf8");
      },
      /restore_sql_file/i,
    );
    await runNegativeArchiveCase(
      "missing restore.sql on disk",
      async (dir) => {
        await rm(path.join(dir, "restore.sql"), { force: true });
      },
      /ENOENT|restore\.sql/i,
    );
    await runNegativeArchiveCase(
      "tampered restore.sql content on disk",
      async (dir) => {
        const prev = await readFile(path.join(dir, "restore.sql"), "utf8");
        await writeFile(path.join(dir, "restore.sql"), `${prev}-- tampered\n`, "utf8");
      },
      /restore\.sql.*digest|checksum|mismatch/i,
    );
    await runNegativeArchiveCase(
      "mismatched restore_sql_sha256 in manifest",
      async (dir) => {
        const m = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
        m.restore_sql_sha256 = m.restore_sql_sha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
        await writeFile(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2), "utf8");
      },
      /restore\.sql.*digest|checksum|mismatch/i,
    );

    // Drift 2a: direct_entry_capability_grants (+1 row after export)
    const driftCapId = nextUuid();
    await setup.query(
      `insert into public.direct_entry_capability_grants (grant_id, app_user_id, capability, valid_from, is_current)
       values ($1::uuid, $2::uuid, 'worker_edit_history_view', $3::date, true)`,
      [driftCapId, HR_OP.app, todayStr],
    );
    const driftCapCli = runApplyCli(["--wp10-7-3d-archive-manifest", relocatedManifestPath]);
    assert.notEqual(driftCapCli.status, 0, "Drift on direct_entry_capability_grants MUST abort before DDL");
    assert.match(driftCapCli.stderr, /WP10-7-3D archive parity check failed in transaction:.*direct_entry_capability_grants/);
    await assertAll3TablesIntact("Requirement 2a (cap_grants drift)", null);
    await setup.query("delete from public.direct_entry_capability_grants where grant_id = $1::uuid", [driftCapId]);

    // Drift 2b: direct_entry_scope_grants (+1 row after export)
    const driftScopeId = nextUuid();
    await setup.query(
      `insert into public.direct_entry_scope_grants (grant_id, app_user_id, scope_kind, team_id, valid_from, is_current)
       values ($1::uuid, $2::uuid, 'team', $3::uuid, $4::date, false)`,
      [driftScopeId, SUSPENDED_USER.app, TEAM_A, tomorrowStr],
    );
    const driftScopeCli = runApplyCli(["--wp10-7-3d-archive-manifest", relocatedManifestPath]);
    assert.notEqual(driftScopeCli.status, 0, "Drift on direct_entry_scope_grants MUST abort before DDL");
    assert.match(driftScopeCli.stderr, /WP10-7-3D archive parity check failed in transaction:.*direct_entry_scope_grants/);
    await assertAll3TablesIntact("Requirement 2b (scope_grants drift)", null);
    await setup.query("delete from public.direct_entry_scope_grants where grant_id = $1::uuid", [driftScopeId]);

    // Drift 2c: work_report_team_leader_capability_grants (mutate 1 row after export)
    const { rows: [origBridgeRow] } = await observer.query(
      "select leader_assignment_id::text, capability, capability_grant_id::text from public.work_report_team_leader_capability_grants order by leader_assignment_id, capability limit 1",
    );
    await setup.query(
      "delete from public.work_report_team_leader_capability_grants where leader_assignment_id = $1::uuid and capability = $2",
      [origBridgeRow.leader_assignment_id, origBridgeRow.capability],
    );
    const driftBridgeCli = runApplyCli(["--wp10-7-3d-archive-manifest", relocatedManifestPath]);
    assert.notEqual(driftBridgeCli.status, 0, "Drift on work_report_team_leader_capability_grants MUST abort before DDL");
    assert.match(driftBridgeCli.stderr, /WP10-7-3D archive parity check failed in transaction:.*work_report_team_leader_capability_grants/);
    await assertAll3TablesIntact("Requirement 2c (bridge drift)", null);
    await setup.query(
      "insert into public.work_report_team_leader_capability_grants (leader_assignment_id, capability, capability_grant_id) values ($1::uuid, $2, $3::uuid)",
      [origBridgeRow.leader_assignment_id, origBridgeRow.capability, origBridgeRow.capability_grant_id],
    );
    await assertAll3TablesIntact("Post-drift cleanup parity", preFingerprints);

    // -------------------------------------------------------------------------
    // REQUIREMENT 3: Hardened dynamic SQL (EXECUTE) precheck (T0 Roadmap L437 concat case)
    //                + 4th-table incoming FK + dead-fn caller + disabled unmanaged account
    // -------------------------------------------------------------------------
    await setup.query("create schema app_custom;");

    // 3a. Exact Roadmap L437 string-concatenation dynamic EXECUTE probe!
    await setup.query(`
      create function app_custom.roadmap_l437_concat_probe()
      returns integer
      language plpgsql
      as $fn$
      declare
        v_tbl text := 'direct_entry_' || 'capability_grants';
        v_cnt integer;
      begin
        execute 'select count(*)::int from public.' || v_tbl into v_cnt;
        return v_cnt;
      end;
      $fn$;
    `);
    const concatPrecheck = await runWp1073dPrecheck(observer);
    assert.equal(concatPrecheck.ready, false);
    assert.equal(concatPrecheck.summary.blocking_dynamic_execute_procs, 1);
    assert.equal(
      concatPrecheck.blockingDynamicExecuteProcs[0].signature,
      "app_custom.roadmap_l437_concat_probe()",
    );
    const concatCli = runApplyCli(["--wp10-7-3d-archive-manifest", relocatedManifestPath]);
    assert.notEqual(concatCli.status, 0, "Roadmap L437 dynamic EXECUTE concat probe MUST block 3D apply");
    assert.match(concatCli.stderr, /non-allowlisted dynamic EXECUTE.*app_custom\.roadmap_l437_concat_probe\(\)/);
    await assertAll3TablesIntact("Requirement 3a (dynamic EXECUTE concat)", preFingerprints);
    await setup.query("drop function app_custom.roadmap_l437_concat_probe();");

    // 3b. 4th-table incoming FK into direct_entry_capability_grants
    await setup.query(`
      create table app_custom.sneaky_fk_child (
        child_id uuid primary key default gen_random_uuid(),
        cap_grant_id uuid not null references public.direct_entry_capability_grants(grant_id)
      );
    `);
    const fkPrecheck = await runWp1073dPrecheck(observer);
    assert.equal(fkPrecheck.ready, false);
    assert.equal(fkPrecheck.summary.incoming_external_fks, 1);
    const fkCli = runApplyCli(["--wp10-7-3d-archive-manifest", relocatedManifestPath]);
    assert.notEqual(fkCli.status, 0, "4th-table incoming FK MUST block 3D apply before DDL");
    assert.match(fkCli.stderr, /incoming foreign key\(s\) from external table\(s\).*app_custom\.sneaky_fk_child/);
    await assertAll3TablesIntact("Requirement 3b (4th-table incoming FK)", preFingerprints);
    await setup.query("drop table app_custom.sneaky_fk_child;");

    // 3c. Dead-function caller negative test
    await setup.query(`
      create function app_custom.probe_dead_fn_caller()
      returns void
      language plpgsql
      as $fn$
      begin
        perform public.direct_entry_seed_team_scope_grants();
      end;
      $fn$;
    `);
    const deadFnPrecheck = await runWp1073dPrecheck(observer);
    assert.equal(deadFnPrecheck.ready, false);
    assert.equal(deadFnPrecheck.summary.blocking_static_procs, 1);
    const deadFnCli = runApplyCli(["--wp10-7-3d-archive-manifest", relocatedManifestPath]);
    assert.notEqual(deadFnCli.status, 0, "Dead-function caller MUST block 3D apply before DDL");
    assert.match(deadFnCli.stderr, /app_custom\.probe_dead_fn_caller\(\)/);
    await assertAll3TablesIntact("Requirement 3c (dead-fn caller)", preFingerprints);
    await setup.query("drop function app_custom.probe_dead_fn_caller();");

    // 3d. Disabled authz_managed = false account negative test
    const disabledUnmanaged = await seedAccount(setup, "unmanaged.disabled.3d", "Disabled Unmanaged", {
      authzManaged: false,
      enabled: false,
    });
    const unmPrecheck = await runWp1073dPrecheck(observer);
    assert.equal(unmPrecheck.ready, false);
    assert.equal(unmPrecheck.summary.unmanaged_accounts, 1);
    assert.equal(unmPrecheck.summary.disabled_unmanaged_accounts, 1);
    const unmCli = runApplyCli(["--wp10-7-3d-archive-manifest", relocatedManifestPath]);
    assert.notEqual(unmCli.status, 0, "Disabled authz_managed=false account MUST block 3D apply before DDL");
    assert.match(unmCli.stderr, /authz_managed=false account\(s\) still exist/);
    await assertAll3TablesIntact("Requirement 3d (disabled unmanaged account)", preFingerprints);
    await setup.query("delete from public.direct_entry_app_users where app_user_id = $1::uuid", [disabledUnmanaged.app]);
    await setup.query("delete from auth.users where id = $1::uuid", [disabledUnmanaged.auth]);
    await setup.query("drop schema app_custom;");

    // -------------------------------------------------------------------------
    // REQUIREMENT 4: Full locked-tx apply via REAL CLI + idempotent re-run without archive flag
    // -------------------------------------------------------------------------
    const guardedApplyCli = runApplyCli([
      "--wp10-7-3d-archive-manifest",
      relocatedManifestPath,
      "--wp10-7-3d-expected-bundle-sha256",
      exported.manifest.bundle.canonical_sha256,
    ]);
    assert.equal(
      guardedApplyCli.status,
      0,
      `Guarded 3D CLI apply failed:\n${guardedApplyCli.stderr || guardedApplyCli.stdout}`,
    );
    assert.match(
      guardedApplyCli.stdout,
      new RegExp(`APPLY\\s+${STAGED_3D_MIGRATION_NAME.replaceAll(".", "\\.")}`),
    );

    const { rows: [mig3dRow] } = await observer.query(
      "select version, checksum from public.schema_migrations where version = $1",
      [STAGED_3D_MIGRATION_NAME],
    );
    assert.ok(mig3dRow, "public.schema_migrations must record 3D after clean apply");
    assert.equal(mig3dRow.checksum, migrationChecksum(staged3dSql));

    // Re-run default CLI WITHOUT archive flag -> MUST skip cleanly by checksum!
    const idempotentRerunCli = runApplyCli([]);
    assert.equal(
      idempotentRerunCli.status,
      0,
      `Idempotent default CLI re-run after 3D failed:\n${idempotentRerunCli.stderr || idempotentRerunCli.stdout}`,
    );
    assert.match(
      idempotentRerunCli.stdout,
      new RegExp(`SKIP\\s+${STAGED_3D_MIGRATION_NAME.replaceAll(".", "\\.")}`),
    );
    assert.match(
      idempotentRerunCli.stdout,
      new RegExp(`0 áp dụng mới, ${allPre3dFiles.length + 1} bỏ qua`),
    );

    const dryRunAfterCli = runApplyCli(["--dry-run"]);
    assert.equal(dryRunAfterCli.status, 0, dryRunAfterCli.stderr || dryRunAfterCli.stdout);
    assert.match(
      dryRunAfterCli.stdout,
      new RegExp(`APPLIED ${STAGED_3D_MIGRATION_NAME.replaceAll(".", "\\.")}`),
    );

    // -------------------------------------------------------------------------
    // REQUIREMENT 5: Post-drop structural integrity & multi-module runtime regression (0 42P01!)
    // -------------------------------------------------------------------------
    const { rows: [dropCatalogCheck] } = await observer.query(`
      select to_regclass('public.work_report_team_leader_capability_grants') is null as bridge_gone,
             to_regclass('public.direct_entry_capability_grants') is null as cap_gone,
             to_regclass('public.direct_entry_scope_grants') is null as scope_gone,
             to_regprocedure('public.work_report_sync_team_leader_capabilities()') is null as wr_sync_gone,
             to_regprocedure('public.direct_entry_authz__internal_sync_legacy_grants(uuid)') is null as sync_gone,
             to_regprocedure('public.direct_entry_has_capability(uuid,text)') is null as has_cap_gone,
             to_regprocedure('public.direct_entry_has_scope(uuid,text)') is null as has_scope_gone,
             to_regprocedure('public.direct_entry__internal_capability_grant_effective(uuid,date)') is null as cap_eff_gone,
             to_regprocedure('public.direct_entry__internal_team_scope_grant_effective(uuid,date)') is null as scope_eff_gone,
             to_regprocedure('public.direct_entry_assert_actor(uuid,uuid,text)') is null as assert_actor_gone,
             to_regprocedure('public.direct_entry__internal_reconcile_cancelled_team_leaders(date)') is null as dead1_gone,
             to_regprocedure('public.direct_entry_transition_legacy_team_leaders(date)') is null as dead2_gone,
             to_regprocedure('public.direct_entry_seed_team_scope_grants()') is null as dead3_gone
    `);
    for (const [key, ok] of Object.entries(dropCatalogCheck)) {
      assert.equal(ok, true, `Post-drop catalog check failed: ${key}`);
    }

    for (const sharedSig of WP10_7_3D_PRESERVED_SHARED_TRIGGER_FUNCTIONS) {
      const { rows: [fnRow] } = await observer.query(
        "select pg_catalog.to_regprocedure($1) is not null as exists",
        [sharedSig],
      );
      assert.equal(fnRow.exists, true, `Shared trigger function ${sharedSig} must remain intact`);
    }

    // S0-T1-C security postconditions still pass post-3D!
    const s0Sql = await readFile(path.join(fakeMigrationsDir, S0_T1_C_MIGRATION_NAME), "utf8");
    const postFlags = new Map([...allPre3dFiles, STAGED_3D_MIGRATION_NAME].map((f) => [f, true]));
    const postS0 = await verifyS0T1CSecurityPostconditions(observer, s0Sql, postFlags);
    assert.equal(postS0.ok, true, `Post-3D S0-T1-C postcondition failed: ${postS0.reason}`);
    assert.equal(postS0.details.exposedClientOrPublicCount, 0);

    // Live runtime regression across Session/Page Guards/API, Uploader, Reporting, Work Reports,
    // Leave, Attendance, Vendor Finance, Salary Advance, Shared Triggers, Admin/Groups, PM, TL (#42/3A/3B)
    for (const actor of [OWNER, HR_OP, UPLOADER, PM_USER, PA_USER, TL_ACTIVE]) {
      const rpcCtx = await serviceRpc(setup, "direct_entry_resolve_actor_context", [actor.auth], ["uuid"]);
      assert.equal(rpcCtx.enabled, true, `Session resolve failed for ${actor.name}`);
      const tsActor = await resolveActor({
        session: { auth_subject: actor.auth, provider: "supabase", authenticated_at: atIso },
        repository: { loadByAuthSubject: async () => rpcCtx },
        at: atIso,
      });
      assert.equal(tsActor.ok, true);
      const resolveSession = async () => ({ actor: tsActor, response_headers: {} });
      const authResp = await createAuthSessionResponse(resolveSession);
      assert.equal(authResp.status, 200);
      const deResp = await createDirectEntrySessionResponse("true", resolveSession);
      assert.equal(deResp.status, 200);
      assert.ok(decideDirectEntryPageAccess({ uiEnabled: true, actor: tsActor }));
      assert.ok(decideWorkerOperationsPageAccess({ uiEnabled: true, actor: tsActor }));
      assert.ok(decideProjectOperationsPageAccess({ uiEnabled: true, actor: tsActor }));
      assert.ok(decideAdminAreaAccess({ actor: tsActor }));
      assert.ok(decideAccountAccessPageAccess({ actor: tsActor }));
    }

    // Direct Entry / Uploader API + RPCs
    {
      const uploaderCtx = await serviceRpc(setup, "direct_entry_resolve_actor_context", [UPLOADER.auth], ["uuid"]);
      const uploaderTs = await resolveActor({
        session: { auth_subject: UPLOADER.auth, provider: "supabase", authenticated_at: atIso },
        repository: { loadByAuthSubject: async () => uploaderCtx },
        at: atIso,
      });
      const resolveSession = async () => ({ actor: uploaderTs, response_headers: {} });
      const writeRepo = createDirectEntryWriteRepository((name, args) => serviceRpcNamed(setup, name, args));
      const workerRepo = createWorkerDirectoryRepository((name, args) => serviceRpcNamed(setup, name, args));
      const subRepo = createSubmissionReadRepository((name, args) => serviceRpcNamed(setup, name, args));
      assert.equal((await getInputCatalog(todayStr, "true", { resolveSession, repository: writeRepo })).status, 200);
      assert.equal((await getOwnDrafts("true", { resolveSession, repository: writeRepo })).status, 200);
      assert.equal(
        (await listOwnSubmissions(new Request("http://localhost/api/direct-entry/submissions"), "true", { resolveSession, repository: subRepo })).status,
        200,
      );
      assert.equal(
        (await listWorkers(new Request("http://localhost/api/direct-entry/workers?scope=recruited"), "true", { resolveSession, repository: workerRepo })).status,
        200,
      );
      await serviceRpc(setup, "direct_entry_read_projection", [UPLOADER.auth, UPLOADER.app, sampleEntryId], ["uuid", "uuid", "uuid"]);
      await serviceRpc(
        setup,
        "direct_entry_create_batch",
        [
          UPLOADER.auth, UPLOADER.app,
          JSON.stringify([{
            project_id: PRJ_1, first_work_date: todayStr, employee_code: `hrp-${todayStr.slice(0, 4)}-940099`,
            worker_details: {
              display_name: "Post Drop 3D Worker",
              date_of_birth: { state: "omitted" },
              national_id: { state: "omitted" },
              address: { state: "omitted" },
              phone: { state: "omitted" },
            },
            recruiter_id: UPLOADER.rec, labor_type: validLaborType,
          }]),
          `pd-3d-batch-${nextUuid()}`,
        ],
        ["uuid", "uuid", "jsonb", "text"],
      );
    }

    // Reporting, Work Reports, Leave, Attendance, Vendor Finance, Salary Advance
    await serviceRpc(setup, "direct_entry_reporting_scoped_options", [OWNER.auth, OWNER.app], ["uuid", "uuid"]);
    await serviceRpc(setup, "direct_entry_reporting_scoped_facts", [OWNER.auth, OWNER.app, JSON.stringify({})], ["uuid", "uuid", "jsonb"]);
    await serviceRpc(setup, "direct_entry_reporting_scoped_facts", [TL_ACTIVE.auth, TL_ACTIVE.app, JSON.stringify({})], ["uuid", "uuid", "jsonb"]);
    await serviceRpc(setup, "work_report_list_templates", [OWNER.auth, OWNER.app], ["uuid", "uuid"]);
    await serviceRpc(setup, "work_report_list_assignment_options", [TL_ACTIVE.auth, TL_ACTIVE.app, null], ["uuid", "uuid", "uuid"]);
    await serviceRpc(setup, "work_report_list_pending_reviews", [TL_ACTIVE.auth, TL_ACTIVE.app, null, null, 20], ["uuid", "uuid", "uuid", "text", "integer"]);
    await serviceRpc(setup, "work_report_analytics_overview", [TL_ACTIVE.auth, TL_ACTIVE.app, wrTpl.template_id, null, todayStr, todayStr, TEAM_A, null, "final"], ["uuid", "uuid", "uuid", "uuid", "date", "date", "uuid", "uuid", "text"]);
    await serviceRpc(setup, "work_report_list_my_obligations", [UPLOADER.auth, UPLOADER.app, null], ["uuid", "uuid", "text"]);
    await serviceRpc(setup, "work_report_has_active_obligations", [UPLOADER.auth, UPLOADER.app], ["uuid", "uuid"]);
    const lvSummary = await serviceRpc(setup, "leave_management_get_my_summary", [UPLOADER.auth, UPLOADER.app, leaveYear], ["uuid", "uuid", "integer"]);
    assert.equal(
      lvSummary?.routing?.primary_approver_app_user_id ?? lvSummary?.approval_route?.primary_approver_app_user_id,
      TL_ACTIVE.app,
      "Leave routing must resolve active TL after 3D drop",
    );
    await serviceRpc(setup, "attendance_admin_report", [TL_ACTIVE.auth, TL_ACTIVE.app, todayStr, todayStr, 1, 20, null, null], ["uuid", "uuid", "date", "date", "integer", "integer", "text", "uuid"]);
    await serviceRpc(setup, "attendance_monthly_matrix_report", [TL_ACTIVE.auth, TL_ACTIVE.app, yearMonth, null, null, null, 1, 20], ["uuid", "uuid", "text", "uuid", "uuid", "text", "integer", "integer"]);
    const vfAccess = await serviceRpc(setup, "vendor_finance_get_actor_access", [PA_USER.auth, PA_USER.app], ["uuid", "uuid"]);
    assert.equal(vfAccess.can_view, true);
    const saAccess = await serviceRpc(setup, "salary_advance_get_actor_access", [OWNER.auth, OWNER.app], ["uuid", "uuid"]);
    assert.equal(saAccess.can_access, true);

    // #42 Guard: moving or unassigning active TL's team membership MUST still block cleanly!
    const { rows: [tlRecRow] } = await observer.query(
      "select version from public.recruiters where recruiter_id = $1::uuid",
      [TL_ACTIVE.rec],
    );
    const moveRes = await tryServiceRpc(
      setup,
      "direct_entry_move_team_membership",
      [OWNER.auth, OWNER.app, TL_ACTIVE.rec, TEAM_B, todayStr, tlRecRow.version, "Try move active TL post-3D", `mv-${nextUuid()}`],
      ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    assert.equal(moveRes.ok, false, "#42 move guard must still block active TL after 3D drop");
    assert.notEqual(moveRes.code, "42P01");
    const unassignRes = await tryServiceRpc(
      setup,
      "direct_entry_unassign_team_membership",
      [OWNER.auth, OWNER.app, TL_ACTIVE.rec, todayStr, tlRecRow.version, "Try unassign active TL post-3D", `un-${nextUuid()}`],
      ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    assert.equal(unassignRes.ok, false, "#42 unassign guard must still block active TL after 3D drop");
    assert.notEqual(unassignRes.code, "42P01");

    // Shared trigger integrity on Org/membership tables (23P01 overlap guard + set_current_on_insert)
    await setup.query("begin");
    try {
      const testRec = nextUuid();
      await setup.query(
        "insert into public.recruiters (recruiter_id, display_name, personnel_code, personnel_position, active) values ($1::uuid, 'PostDrop3D Rec', 'PD3D_REC', 'STAFF', true)",
        [testRec],
      );
      await setup.query(
        "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-01', true)",
        [testRec, TEAM_B],
      );
      await setup.query("savepoint sp_overlap_3d");
      let overlapCaught = false;
      try {
        await setup.query(
          "insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current) values ($1::uuid, $2::uuid, '2026-01-05', true)",
          [testRec, TEAM_B],
        );
      } catch (err) {
        if (err?.code === "23P01") overlapCaught = true;
        await setup.query("rollback to savepoint sp_overlap_3d");
      }
      await setup.query("release savepoint sp_overlap_3d");
      assert.equal(overlapCaught, true, "Shared trigger direct_entry_guard_effective_interval must still enforce 23P01 on recruiter_team_memberships");
    } finally {
      await setup.query("rollback");
    }

    // Live mutations post-3D: Admin Groups, Account Disable/Enable, PM Unassign/Reassign, TL List/Replace/Revoke
    // (Clone post-drop DB FIRST so restore drill runs cleanly against exact post-drop state AND we can also test psql restore.sql!)
    await observer.end();
    await setup.end();
    const tplAdmin = await connect(port, "wp10-7-3d-tpl", "template1");
    await tplAdmin.query("create database wp1073d_postdrop_psql_restore template postgres");
    await tplAdmin.query("create database wp1073d_postdrop_mutations template postgres");
    await tplAdmin.end();
    setup = await connect(port, "wp10-7-3d-setup");
    observer = await connect(port, "wp10-7-3d-observer");
    const mutClient = await connect(port, "wp10-7-3d-mut", "wp1073d_postdrop_mutations");
    clients.push(setup, observer, mutClient);

    const addedMem = await apiAssignGroup(mutClient, HR_OP.app, GRP_CATALOG, "Post-3D group assign", atIso);
    await apiRemoveGroup(mutClient, HR_OP.app, addedMem.membership_id, "Post-3D group remove", atIso);
    await apiToggleAccount(mutClient, TL_ACTIVE.app, "disable", "Post-3D TL disable", atIso);
    await apiToggleAccount(mutClient, TL_ACTIVE.app, "enable", "Post-3D TL enable", atIso);
    const { rows: [pmaRow] } = await mutClient.query(
      "select version from public.direct_entry_project_manager_assignments where assignment_id = $1::uuid",
      [pmAssignmentId],
    );
    const { rows: [prjRow1] } = await mutClient.query(
      "select version from public.direct_entry_projects where project_id = $1",
      [PRJ_1],
    );
    await serviceRpc(
      mutClient,
      "direct_entry_unassign_project_manager",
      [OWNER.auth, OWNER.app, pmAssignmentId, pmaRow.version, prjRow1.version, "Post-3D unassign PM", `pd-upm-${nextUuid()}`],
      ["uuid", "uuid", "uuid", "integer", "integer", "text", "text"],
    );
    const { rows: [prjRow2] } = await mutClient.query(
      "select version from public.direct_entry_projects where project_id = $1",
      [PRJ_1],
    );
    await serviceRpc(
      mutClient,
      "direct_entry_assign_project_manager",
      [OWNER.auth, OWNER.app, PRJ_1, PM_USER.rec, todayStr, prjRow2.version, "Post-3D reassign PM", `pd-apm-${nextUuid()}`],
      ["uuid", "uuid", "text", "uuid", "date", "integer", "text", "text"],
    );
    const cands = await serviceRpc(
      mutClient,
      "direct_entry_list_team_leader_candidates",
      [OWNER.auth, OWNER.app, TEAM_A, null, 1, 25],
      ["uuid", "uuid", "uuid", "text", "integer", "integer"],
    );
    assert.ok(cands.candidates.some((c) => c.app_user_id === TL_REPLACE.app));
    const tvPost = await getTeamVersion(mutClient, TEAM_A);
    const repRes = await serviceRpc(
      mutClient,
      "direct_entry_designate_team_leader",
      [OWNER.auth, OWNER.app, TEAM_A, TL_REPLACE.app, todayStr, tvPost, "Post-3D replace TL", `pd-rep-${nextUuid()}`],
      ["uuid", "uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    assert.equal(repRes.change, "replace");
    const tvPost2 = await getTeamVersion(mutClient, TEAM_A);
    const revRes = await serviceRpc(
      mutClient,
      "direct_entry_revoke_team_leader",
      [OWNER.auth, OWNER.app, TEAM_A, todayStr, tvPost2, "Post-3D revoke TL", `pd-rev-${nextUuid()}`],
      ["uuid", "uuid", "uuid", "date", "integer", "text", "text"],
    );
    assert.equal(revRes.change, "revoke");
    await mutClient.end();

    // -------------------------------------------------------------------------
    // REQUIREMENT 6: Full 8-Dimension Restore Parity Drill FROM RELOCATED dirB (dirA DELETED!)
    //   (6A) Engine API: restoreWp1073dLegacyGrantsArchive + verifyWp1073dRestoreParity on `postgres`
    //   (6B) Standalone `psql -X -v ON_ERROR_STOP=1 -f restore.sql` (cwd: dirB) on cloned post-drop DB
    // -------------------------------------------------------------------------
    const engineRestore = await restoreWp1073dLegacyGrantsArchive(setup, relocatedManifestPath, {
      verifyParity: true,
    });
    assert.equal(engineRestore.restored, true);
    assert.equal(engineRestore.parity.ok, true);
    assert.deepEqual(engineRestore.parity.dimensions, {
      rowCounts: true,
      canonicalSha256: true,
      structureAndIndexes: true,
      foreignKeys: true,
      triggers: true,
      owner: true,
      tableAcl: true,
      rlsAndPolicies: true,
    });

    // Explicitly double-check critical catalog invariants across all 8 dimensions!
    const snapAfter = engineRestore.parity.liveCatalogSnapshot;
    const totalFks =
      snapAfter.tables.direct_entry_capability_grants.cons.filter((c) => c.contype === "f").length +
      snapAfter.tables.direct_entry_scope_grants.cons.filter((c) => c.contype === "f").length +
      snapAfter.tables.work_report_team_leader_capability_grants.cons.filter((c) => c.contype === "f").length;
    assert.equal(totalFks, 5, "Must restore all 5 foreign keys (ON DELETE CASCADE + RESTRICT)");
    const bridgeFks = snapAfter.tables.work_report_team_leader_capability_grants.cons.filter((c) => c.contype === "f");
    assert.equal(bridgeFks.length, 2);
    assert.ok(bridgeFks.every((fk) => /ON DELETE CASCADE/i.test(fk.condef)));
    const totalDirectTrgs =
      snapAfter.tables.direct_entry_capability_grants.trgs.length +
      snapAfter.tables.direct_entry_scope_grants.trgs.length +
      snapAfter.tables.work_report_team_leader_capability_grants.trgs.length;
    assert.equal(totalDirectTrgs, 7, "Must restore all 7 direct triggers");
    assert.equal(snapAfter.external_bridge_triggers.length, 1, "Must restore external bridge trigger");
    for (const tbl of [
      "direct_entry_capability_grants",
      "direct_entry_scope_grants",
      "work_report_team_leader_capability_grants",
    ]) {
      assert.equal(snapAfter.tables[tbl].owner, "postgres");
      assert.equal(snapAfter.tables[tbl].relrowsecurity, true);
      assert.equal(snapAfter.tables[tbl].relforcerowsecurity, true);
    }
    assert.ok(
      snapAfter.tables.direct_entry_capability_grants.relacl.some((e) =>
        e.startsWith("direct_entry_catalog_bootstrap_executor=r/"),
      ),
      "Must restore direct_entry_catalog_bootstrap_executor SELECT ACL on direct_entry_capability_grants",
    );
    assert.equal(
      snapAfter.tables.direct_entry_capability_grants.pols.some(
        (p) => p.polname === "direct_entry_catalog_bootstrap_capability_read",
      ),
      true,
      "Must restore RLS policy direct_entry_catalog_bootstrap_capability_read",
    );

    // 6B. Standalone `psql -X -v ON_ERROR_STOP=1 -f restore.sql` (cwd: relocated archiveDirB, dirA deleted!)
    runBin(
      psqlBin,
      [
        `postgresql://postgres@127.0.0.1:${port}/wp1073d_postdrop_psql_restore`,
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        "restore.sql",
      ],
      { cwd: archiveDirB },
    );
    const psqlObserver = await connect(port, "wp10-7-3d-psql-restore-obs", "wp1073d_postdrop_psql_restore");
    clients.push(psqlObserver);
    const psqlParity = await verifyWp1073dRestoreParity(psqlObserver, relocatedManifestPath, {
      throwOnMismatch: true,
    });
    assert.equal(psqlParity.ok, true);
    assert.deepEqual(psqlParity.dimensions, {
      rowCounts: true,
      canonicalSha256: true,
      structureAndIndexes: true,
      foreignKeys: true,
      triggers: true,
      owner: true,
      tableAcl: true,
      rlsAndPolicies: true,
    });
    await psqlObserver.end();
  } finally {
    for (const c of clients) {
      await c.end().catch(() => {});
    }
    if (started) {
      spawnSync(pgCtl, ["-D", pgData, "-m", "immediate", "stop"], { stdio: "ignore", windowsHide: true });
    }
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
