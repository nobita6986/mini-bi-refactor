-- =============================================================================
-- WP10-7 Slice 3D (STAGED TEMPLATE — activate into supabase/migrations/ ONLY
-- after Slice 3C merges to main with a timestamp > Slice 3C):
--   Target filename pattern:
--     <YYYYMMDDHHMMSS>_wp10_7_3d_drop_direct_entry_legacy_grants.sql
--
-- Scope (100% forward migration; ZERO CASCADE; zero historical migration edits):
--   1. Fail-closed pre-drop gate (do $wp10_7_3d_precheck$):
--      (a) Verify all 3 legacy tables exist and acquire ACCESS EXCLUSIVE locks
--          in canonical order:
--            public.work_report_team_leader_capability_grants,
--            public.direct_entry_capability_grants,
--            public.direct_entry_scope_grants.
--      (b) Verify 0 active or disabled `authz_managed = false` accounts.
--      (c) Verify 0 views / materialized views referencing the 3 target tables.
--      (d) Verify 0 incoming FKs from any 4th table and 0 unexpected pg_depend
--          external objects on the 3 target tables.
--      (e) Verify work_report_sync_team_leader_capabilities() is attached ONLY
--          to public.direct_entry_team_leader_assignments.
--      (f) Hardened pg_proc dependency & dynamic EXECUTE scan across ALL
--          non-system application schemas:
--            - Pass 1 (static SQL): 0 routines outside planned 3D drop/trim set.
--            - Pass 2 (hardened dynamic EXECUTE — closes T0 Roadmap L437):
--              flags ANY non-allowlisted active routine containing dynamic
--              EXECUTE (catching concatenated table-name SQL and format(...));
--              only allowlists verified historical helper
--              public.direct_entry_hf_replace_proc_source(regprocedure, text, text, integer)
--              AFTER verifying its EXECUTE privileges are revoked from PUBLIC,
--              anon, authenticated, and service_role.
--            - Pass 3 (string-literal table name check): 0 routines outside
--              planned 3D drop/trim set referencing the 3 target tables.
--   2. Ordered RESTRICT DDL (ZERO CASCADE):
--      (a) Drop bridge trigger on direct_entry_team_leader_assignments +
--          drop function public.work_report_sync_team_leader_capabilities() RESTRICT.
--      (b) Drop public.work_report_team_leader_capability_grants RESTRICT FIRST
--          (releases incoming ON DELETE CASCADE FK into direct_entry_capability_grants).
--      (c) Revoke SELECT on direct_entry_capability_grants from
--          direct_entry_catalog_bootstrap_executor and drop RLS policy
--          direct_entry_catalog_bootstrap_capability_read.
--      (d) Drop all 7 direct triggers on direct_entry_capability_grants (3)
--          and direct_entry_scope_grants (4).
--      (e) Drop public.direct_entry_scope_grants RESTRICT and
--          public.direct_entry_capability_grants RESTRICT.
--      (f) Preserve ALL 5 shared trigger functions intact — ONLY trim legacy
--          cap/scope branches in direct_entry_guard_effective_interval() and
--          direct_entry_set_current_on_insert().
--      (g) Drop obsolete legacy & 3 dead historical functions using RESTRICT
--          (in dependency-safe order: callers before LANGUAGE sql callees).
--   3. Fail-closed post-drop self-check (do $wp10_7_3d_postcheck$):
--      (a) Verify 3 target tables and 10 dropped legacy functions are absent.
--      (b) Verify ALL 5 shared trigger functions remain intact with hardened
--          search_path, owner-only EXECUTE ACL, and live triggers attached.
--      (c) Verify 0 remaining pg_proc references to the 3 dropped tables.
--      (d) Verify preserved authz & org tables remain intact with FORCE RLS.
-- =============================================================================

begin;

-- =============================================================================
-- 1. Fail-closed pre-drop gate
-- =============================================================================

do $wp10_7_3d_precheck$
declare
  v_cap_oid oid;
  v_scope_oid oid;
  v_bridge_oid oid;
  v_unmanaged_total integer := 0;
  v_unmanaged_active integer := 0;
  v_unmanaged_disabled integer := 0;
  v_view_count integer := 0;
  v_views text;
  v_ext_fk_count integer := 0;
  v_ext_fks text;
  v_dep_count integer := 0;
  v_deps text;
  v_wr_sync_oid oid;
  v_wr_sync_overloads integer := 0;
  v_extra_wr_trgs integer := 0;
  v_extra_wr_trg_names text;
  v_proc record;
  v_norm text;
  v_no_comments text;
  v_public_acl_exec boolean;
  v_privs_revoked boolean;
  v_bad_static text[] := array[]::text[];
  v_bad_dynamic text[] := array[]::text[];
  v_bad_literal text[] := array[]::text[];
  v_planned_drop_names constant text[] := array[
    'direct_entry_authz__internal_sync_legacy_grants',
    'work_report_sync_team_leader_capabilities',
    'direct_entry_has_capability',
    'direct_entry_has_scope',
    'direct_entry__internal_capability_grant_effective',
    'direct_entry__internal_team_scope_grant_effective',
    'direct_entry_assert_actor',
    'direct_entry__internal_reconcile_cancelled_team_leaders',
    'direct_entry_transition_legacy_team_leaders',
    'direct_entry_seed_team_scope_grants'
  ];
  v_dynamic_execute_allowlist constant text[] := array[
    'public.direct_entry_hf_replace_proc_source(regprocedure, text, text, integer)'
  ];
begin
  -- 1a. Verify all 3 target tables exist, then acquire ACCESS EXCLUSIVE locks in canonical order
  v_bridge_oid := pg_catalog.to_regclass('public.work_report_team_leader_capability_grants');
  v_cap_oid := pg_catalog.to_regclass('public.direct_entry_capability_grants');
  v_scope_oid := pg_catalog.to_regclass('public.direct_entry_scope_grants');

  if v_bridge_oid is null or v_cap_oid is null or v_scope_oid is null then
    raise exception 'WP10-7-3D precheck failed: one or more legacy grant tables are missing (bridge=%, cap=%, scope=%)',
      v_bridge_oid is not null, v_cap_oid is not null, v_scope_oid is not null
      using errcode = '55000';
  end if;

  lock table
    public.work_report_team_leader_capability_grants,
    public.direct_entry_capability_grants,
    public.direct_entry_scope_grants
    in access exclusive mode;

  -- 1b. Verify 0 active or disabled authz_managed = false accounts
  select count(*)::integer,
         count(*) filter (where u.enabled)::integer,
         count(*) filter (where not u.enabled)::integer
    into v_unmanaged_total, v_unmanaged_active, v_unmanaged_disabled
    from public.direct_entry_app_users u
   where not coalesce(u.authz_managed, false);

  if v_unmanaged_total > 0 then
    raise exception 'WP10-7-3D precheck failed: % authz_managed=false account(s) still exist (active=%, disabled=%)',
      v_unmanaged_total, v_unmanaged_active, v_unmanaged_disabled
      using errcode = '55000';
  end if;

  -- 1c. Verify 0 views / materialized views reference the 3 target tables
  select count(*)::integer,
         pg_catalog.string_agg(obj, ', ' order by obj)
    into v_view_count, v_views
    from (
      select 'VIEW ' || v.schemaname || '.' || v.viewname as obj
        from pg_catalog.pg_views v
       where v.schemaname not in ('pg_catalog', 'information_schema')
         and v.definition ~* '\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\M'
      union all
      select 'MATVIEW ' || mv.schemaname || '.' || mv.matviewname as obj
        from pg_catalog.pg_matviews mv
       where mv.schemaname not in ('pg_catalog', 'information_schema')
         and mv.definition ~* '\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\M'
    ) s;

  if v_view_count > 0 then
    raise exception 'WP10-7-3D precheck failed: % view(s)/matview(s) still reference legacy grant tables: %',
      v_view_count, coalesce(v_views, '<unknown>')
      using errcode = '55000';
  end if;

  -- 1d. Verify 0 incoming FKs from any 4th table & 0 unexpected external pg_depend objects
  select count(*)::integer,
         pg_catalog.string_agg(
           cn.nspname || '.' || c.relname || '.' || con.conname || ' -> ' || fn.nspname || '.' || fc.relname,
           ', '
           order by cn.nspname, c.relname, con.conname
         )
    into v_ext_fk_count, v_ext_fks
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class c on c.oid = con.conrelid
    join pg_catalog.pg_namespace cn on cn.oid = c.relnamespace
    join pg_catalog.pg_class fc on fc.oid = con.confrelid
    join pg_catalog.pg_namespace fn on fn.oid = fc.relnamespace
   where con.contype = 'f'
     and con.confrelid in (v_bridge_oid, v_cap_oid, v_scope_oid)
     and con.conrelid not in (v_bridge_oid, v_cap_oid, v_scope_oid);

  if v_ext_fk_count > 0 then
    raise exception 'WP10-7-3D precheck failed: % incoming foreign key(s) from external table(s): %',
      v_ext_fk_count, coalesce(v_ext_fks, '<unknown>')
      using errcode = '55000';
  end if;

  select count(*)::integer,
         pg_catalog.string_agg(
           distinct pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid),
           ', '
         )
    into v_dep_count, v_deps
    from pg_catalog.pg_depend d
   where d.refobjid in (v_bridge_oid, v_cap_oid, v_scope_oid)
     and d.deptype in ('n', 'a', 'i')
     and d.classid not in (
       'pg_catalog.pg_type'::pg_catalog.regclass,
       'pg_catalog.pg_class'::pg_catalog.regclass,
       'pg_catalog.pg_trigger'::pg_catalog.regclass,
       'pg_catalog.pg_attrdef'::pg_catalog.regclass
     )
     and not (
       d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
       and exists (
         select 1
           from pg_catalog.pg_constraint con
          where con.oid = d.objid
            and con.conrelid in (v_bridge_oid, v_cap_oid, v_scope_oid)
       )
     )
     and not (
       d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass
       and pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
           = 'policy direct_entry_catalog_bootstrap_capability_read on table direct_entry_capability_grants'
     );

  if v_dep_count > 0 then
    raise exception 'WP10-7-3D precheck failed: % unexpected pg_depend object(s) reference legacy grant tables: %',
      v_dep_count, coalesce(v_deps, '<unknown>')
      using errcode = '55000';
  end if;

  -- 1e. Verify work_report_sync_team_leader_capabilities() trigger attachment
  select count(*)::integer
    into v_wr_sync_overloads
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'work_report_sync_team_leader_capabilities';

  v_wr_sync_oid := pg_catalog.to_regprocedure('public.work_report_sync_team_leader_capabilities()');
  if v_wr_sync_overloads <> 1 or v_wr_sync_oid is null then
    raise exception 'WP10-7-3D precheck failed: expected single public.work_report_sync_team_leader_capabilities(), found %',
      v_wr_sync_overloads
      using errcode = '55000';
  end if;

  select count(*)::integer,
         pg_catalog.string_agg(
           t.tgrelid::pg_catalog.regclass::text || '.' || t.tgname,
           ', '
           order by t.tgrelid::pg_catalog.regclass::text, t.tgname
         )
    into v_extra_wr_trgs, v_extra_wr_trg_names
    from pg_catalog.pg_trigger t
   where t.tgfoid = v_wr_sync_oid
     and not (
       t.tgrelid = 'public.direct_entry_team_leader_assignments'::pg_catalog.regclass
       and t.tgname = 'work_report_sync_team_leader_capabilities'
       and not t.tgisinternal
     );

  if v_extra_wr_trgs > 0 then
    raise exception 'WP10-7-3D precheck failed: % unexpected trigger(s) call work_report_sync_team_leader_capabilities(): %',
      v_extra_wr_trgs, coalesce(v_extra_wr_trg_names, '<unknown>')
      using errcode = '55000';
  end if;

  -- 1f. Hardened pg_proc dependency & dynamic EXECUTE scan across ALL non-system schemas
  for v_proc in
    select p.oid,
           n.nspname as schema_name,
           p.proname as proc_name,
           n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' as sig,
           p.prosrc,
           p.proowner,
           p.proacl
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname <> 'pg_catalog'
       and n.nspname <> 'information_schema'
       and n.nspname not like 'pg\_%' escape '\'
       and n.nspname not in (
         'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public',
         'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions',
         'supabase_migrations', 'net', 'pgtle', 'cron', 'pgbouncer'
       )
       and p.prokind in ('f', 'p')
     order by n.nspname, p.proname, p.oid
  loop
    v_norm := pg_catalog.regexp_replace(
      coalesce(v_proc.prosrc, ''),
      $rx$('([^']|'')*'|--[^\r\n]*|/\*([^*]|\*+[^*/])*\*+/)$rx$,
      ' ',
      'g'
    );
    v_no_comments := pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(
        coalesce(v_proc.prosrc, ''),
        $rx$(--[^\r\n]*|/\*([^*]|\*+[^*/])*\*+/)$rx$,
        ' ',
        'g'
      ),
      '''''',
      '''',
      'g'
    );

    -- Pass 1: Static SQL reference check
    if v_norm ~* '\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants|direct_entry_authz__internal_sync_legacy_grants|work_report_sync_team_leader_capabilities|direct_entry_has_capability|direct_entry_has_scope|direct_entry__internal_capability_grant_effective|direct_entry__internal_team_scope_grant_effective|direct_entry_assert_actor|direct_entry__internal_reconcile_cancelled_team_leaders|direct_entry_transition_legacy_team_leaders|direct_entry_seed_team_scope_grants)\M'
       and not (v_proc.schema_name = 'public' and v_proc.proc_name = any(v_planned_drop_names))
       and not (v_proc.schema_name = 'public' and v_proc.proc_name = 'direct_entry_guard_effective_interval')
    then
      v_bad_static := array_append(v_bad_static, v_proc.sig);
    end if;

    -- Pass 2: Hardened dynamic EXECUTE check (catches concatenated table-name SQL / format(...))
    if v_norm ~* '\mexecute\M' then
      select exists (
        select 1
          from pg_catalog.aclexplode(coalesce(v_proc.proacl, pg_catalog.acldefault('f', v_proc.proowner))) a
         where a.grantee = 0
           and a.privilege_type = 'EXECUTE'
      ) into v_public_acl_exec;

      v_privs_revoked :=
        not v_public_acl_exec
        and not pg_catalog.has_function_privilege('public', v_proc.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', v_proc.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', v_proc.oid, 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', v_proc.oid, 'EXECUTE');

      if not (v_proc.sig = any(v_dynamic_execute_allowlist) and v_privs_revoked) then
        v_bad_dynamic := array_append(
          v_bad_dynamic,
          v_proc.sig || case
            when v_proc.sig = any(v_dynamic_execute_allowlist) then ' [allowlisted helper privileges not revoked]'
            else ' [non-allowlisted dynamic EXECUTE]'
          end
        );
      end if;
    end if;

    -- Pass 3: Unexpected string-literal references to target table names
    if v_no_comments ~* '\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\M'
       and not (v_norm ~* '\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\M')
       and not (v_proc.schema_name = 'public' and v_proc.proc_name = any(v_planned_drop_names))
       and not (
         v_proc.schema_name = 'public'
         and v_proc.proc_name in ('direct_entry_guard_effective_interval', 'direct_entry_set_current_on_insert')
       )
    then
      v_bad_literal := array_append(v_bad_literal, v_proc.sig);
    end if;
  end loop;

  if coalesce(pg_catalog.array_length(v_bad_static, 1), 0) > 0 then
    raise exception 'WP10-7-3D precheck failed: % non-system routine(s) still statically reference legacy grant tables/functions: %',
      pg_catalog.array_length(v_bad_static, 1),
      pg_catalog.array_to_string(v_bad_static, '; ')
      using errcode = '55000';
  end if;

  if coalesce(pg_catalog.array_length(v_bad_dynamic, 1), 0) > 0 then
    raise exception 'WP10-7-3D precheck failed: % non-allowlisted dynamic EXECUTE routine(s) found: %',
      pg_catalog.array_length(v_bad_dynamic, 1),
      pg_catalog.array_to_string(v_bad_dynamic, '; ')
      using errcode = '55000';
  end if;

  if coalesce(pg_catalog.array_length(v_bad_literal, 1), 0) > 0 then
    raise exception 'WP10-7-3D precheck failed: % routine(s) contain unexpected string-literal references to legacy grant tables: %',
      pg_catalog.array_length(v_bad_literal, 1),
      pg_catalog.array_to_string(v_bad_literal, '; ')
      using errcode = '55000';
  end if;
end
$wp10_7_3d_precheck$;

-- =============================================================================
-- 2. Ordered RESTRICT DDL (ZERO CASCADE; preserve ALL 5 shared trigger functions)
-- =============================================================================

-- 2a. Drop external bridge trigger + exclusive trigger function
drop trigger work_report_sync_team_leader_capabilities on public.direct_entry_team_leader_assignments;
drop function public.work_report_sync_team_leader_capabilities() restrict;

-- 2b. Drop bridge table FIRST with RESTRICT (releases incoming FK into direct_entry_capability_grants)
drop table public.work_report_team_leader_capability_grants restrict;

-- 2c. Revoke bootstrap executor table privilege & drop RLS policy on direct_entry_capability_grants
revoke select on public.direct_entry_capability_grants from direct_entry_catalog_bootstrap_executor;
drop policy direct_entry_catalog_bootstrap_capability_read on public.direct_entry_capability_grants;

-- 2d. Explicitly drop all 7 direct triggers on the legacy grant tables
drop trigger direct_entry_capability_grant_marker_guard on public.direct_entry_capability_grants;
drop trigger direct_entry_capability_grant_no_overlap on public.direct_entry_capability_grants;
drop trigger direct_entry_set_current_on_insert on public.direct_entry_capability_grants;

drop trigger direct_entry_no_vendor_team_scope on public.direct_entry_scope_grants;
drop trigger direct_entry_scope_grant_marker_guard on public.direct_entry_scope_grants;
drop trigger direct_entry_scope_grant_no_overlap on public.direct_entry_scope_grants;
drop trigger direct_entry_set_current_on_insert on public.direct_entry_scope_grants;

-- 2e. Drop remaining 2 legacy grant tables with RESTRICT
drop table public.direct_entry_scope_grants restrict;
drop table public.direct_entry_capability_grants restrict;

-- 2f. Trim ONLY legacy cap/scope branches in 2 shared trigger functions (DO NOT DROP!)
create or replace function public.direct_entry_guard_effective_interval()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_key text;
  v_overlap boolean;
begin
  if tg_table_name = 'recruiter_provider_memberships' then
    v_key := 'provider:' || new.recruiter_id::text;
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
    select exists (
      select 1 from public.recruiter_provider_memberships m
       where m.recruiter_id = new.recruiter_id
         and m.membership_id <> coalesce(new.membership_id, '00000000-0000-0000-0000-000000000000'::uuid)
         and daterange(m.valid_from, m.valid_to, '[)') &&
             daterange(new.valid_from, new.valid_to, '[)')
    ) into v_overlap;
  elsif tg_table_name = 'recruiter_team_memberships' then
    v_key := 'team-membership:' || new.recruiter_id::text;
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
    select exists (
      select 1 from public.recruiter_team_memberships m
       where m.recruiter_id = new.recruiter_id
         and m.membership_id <> coalesce(new.membership_id, '00000000-0000-0000-0000-000000000000'::uuid)
         and daterange(m.valid_from, m.valid_to, '[)') &&
             daterange(new.valid_from, new.valid_to, '[)')
    ) into v_overlap;
  elsif tg_table_name = 'direct_entry_app_user_recruiter_links' and new.verified then
    v_key := 'recruiter-link:' || new.app_user_id;
    perform pg_advisory_xact_lock(hashtextextended(v_key, 0));
    select exists (
      select 1 from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = new.app_user_id
         and l.verified
         and l.link_id <> coalesce(new.link_id, '00000000-0000-0000-0000-000000000000'::uuid)
         and daterange(l.valid_from, l.valid_to, '[)') &&
             daterange(new.valid_from, new.valid_to, '[)')
    ) into v_overlap;
  else
    raise exception 'unsupported interval table: %', tg_table_name using errcode = '22023';
  end if;

  if v_overlap then
    raise exception 'effective interval overlaps an existing grant or membership'
      using errcode = '23P01';
  end if;
  return new;
end;
$$;

revoke all on function public.direct_entry_guard_effective_interval()
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_set_current_on_insert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
begin
  if tg_op = 'UPDATE' then
    if tg_table_name in ('direct_entry_project_manager_assignments', 'direct_entry_project_team_scopes') then
      if old.revoked_at is null and new.revoked_at is not null then
        new.is_current := false;
        return new;
      end if;
    elsif tg_table_name = 'direct_entry_app_user_recruiter_links' then
      if old.verified and not new.verified then
        new.is_current := false;
        return new;
      end if;
    end if;
  end if;

  -- Markers are set by the audited grant/activation operation. A scheduled
  -- insert defaults to false and dates never promote it on a later request.
  if not new.is_current then
    return new;
  end if;

  case tg_table_name
    when 'direct_entry_app_user_recruiter_links' then
      select new.verified and u.enabled and r.active into new.is_current
        from public.direct_entry_app_users u join public.recruiters r on r.recruiter_id = new.recruiter_id
       where u.app_user_id = new.app_user_id;
    when 'recruiter_team_memberships' then
      select r.active and t.active into new.is_current
        from public.recruiters r join public.teams t on t.team_id = new.team_id
       where r.recruiter_id = new.recruiter_id;
    when 'recruiter_provider_memberships' then
      select r.active and (new.vendor_id is null or v.active) into new.is_current
        from public.recruiters r left join public.vendors v on v.vendor_id = new.vendor_id
       where r.recruiter_id = new.recruiter_id;
    when 'direct_entry_project_manager_assignments' then
      select new.revoked_at is null and r.active
        and (select count(*)::int
               from public.direct_entry_app_user_recruiter_links l
              where l.recruiter_id = new.manager_recruiter_id and l.verified and l.is_current) = 1
        and (select count(*)::int
               from public.direct_entry_app_user_recruiter_links l
               join public.direct_entry_app_users u on u.app_user_id = l.app_user_id
              where l.recruiter_id = new.manager_recruiter_id and l.verified and l.is_current
                and u.enabled and u.auth_subject is not null) = 1
        into new.is_current
        from public.recruiters r
       where r.recruiter_id = new.manager_recruiter_id;
    when 'direct_entry_project_team_scopes' then
      select new.revoked_at is null and p.active and t.active into new.is_current
        from public.direct_entry_projects p join public.teams t on t.team_id = new.team_id
       where p.project_id = new.project_id;
    when 'direct_entry_team_leader_assignments' then
      select t.active and u.enabled and r.active and exists (
        select 1 from public.direct_entry_app_user_recruiter_links l
         where l.app_user_id = new.leader_app_user_id and l.recruiter_id = new.leader_recruiter_id
           and l.verified and l.is_current
      ) into new.is_current
        from public.teams t join public.direct_entry_app_users u on u.app_user_id = new.leader_app_user_id
        join public.recruiters r on r.recruiter_id = new.leader_recruiter_id
       where t.team_id = new.team_id;
    else
      raise exception 'unsupported current-state table %', tg_table_name using errcode = '22023';
  end case;
  new.is_current := coalesce(new.is_current, false);
  return new;
end;
$function$;

revoke all on function public.direct_entry_set_current_on_insert()
  from public, anon, authenticated, service_role;

-- 2g. Drop obsolete legacy & 3 dead historical functions using RESTRICT (callers before LANGUAGE sql callees)
drop function public.direct_entry__internal_reconcile_cancelled_team_leaders(date) restrict;
drop function public.direct_entry_transition_legacy_team_leaders(date) restrict;
drop function public.direct_entry_seed_team_scope_grants() restrict;
drop function public.direct_entry_authz__internal_sync_legacy_grants(uuid) restrict;
drop function public.direct_entry_assert_actor(uuid, uuid, text) restrict;
drop function public.direct_entry_has_capability(uuid, text) restrict;
drop function public.direct_entry_has_scope(uuid, text) restrict;
drop function public.direct_entry__internal_capability_grant_effective(uuid, date) restrict;
drop function public.direct_entry__internal_team_scope_grant_effective(uuid, date) restrict;

-- =============================================================================
-- 3. Fail-closed post-drop self-check
-- =============================================================================

do $wp10_7_3d_postcheck$
declare
  v_tbl_name text;
  v_fn_name text;
  v_sig text;
  v_oid oid;
  v_rec record;
  v_rel record;
  v_public_exec boolean;
  v_remaining_overloads integer;
  v_remaining_refs integer;
  v_remaining_ref_sigs text;
  v_dropped_tables constant text[] := array[
    'public.work_report_team_leader_capability_grants',
    'public.direct_entry_capability_grants',
    'public.direct_entry_scope_grants'
  ];
  v_dropped_fn_names constant text[] := array[
    'work_report_sync_team_leader_capabilities',
    'direct_entry_authz__internal_sync_legacy_grants',
    'direct_entry_has_capability',
    'direct_entry_has_scope',
    'direct_entry__internal_capability_grant_effective',
    'direct_entry__internal_team_scope_grant_effective',
    'direct_entry_assert_actor',
    'direct_entry__internal_reconcile_cancelled_team_leaders',
    'direct_entry_transition_legacy_team_leaders',
    'direct_entry_seed_team_scope_grants'
  ];
  v_shared_trigger_fns constant text[] := array[
    'public.direct_entry_clear_authority_on_disable()',
    'public.direct_entry_guard_effective_interval()',
    'public.direct_entry_set_current_on_insert()',
    'public.direct_entry_reject_system_vendor_business_team()',
    'public.direct_entry_team_leader_marker()'
  ];
  v_secdef_shared_fns constant text[] := array[
    'public.direct_entry_clear_authority_on_disable()',
    'public.direct_entry_set_current_on_insert()',
    'public.direct_entry_reject_system_vendor_business_team()',
    'public.direct_entry_team_leader_marker()'
  ];
  v_preserved_tables constant text[] := array[
    'public.direct_entry_app_users',
    'public.authz_user_groups',
    'public.authz_user_group_members',
    'public.direct_entry_team_leader_assignments',
    'public.direct_entry_project_manager_assignments',
    'public.direct_entry_app_user_recruiter_links',
    'public.recruiter_team_memberships'
  ];
  v_live_triggers constant text[][] := array[
    array['public.recruiter_provider_memberships', 'direct_entry_provider_membership_no_overlap'],
    array['public.recruiter_team_memberships', 'direct_entry_team_membership_no_overlap'],
    array['public.direct_entry_app_user_recruiter_links', 'direct_entry_recruiter_link_no_overlap'],
    array['public.direct_entry_app_user_recruiter_links', 'direct_entry_set_current_on_insert'],
    array['public.recruiter_team_memberships', 'direct_entry_set_current_on_insert'],
    array['public.recruiter_provider_memberships', 'direct_entry_set_current_on_insert'],
    array['public.direct_entry_project_manager_assignments', 'direct_entry_set_current_on_insert'],
    array['public.direct_entry_project_team_scopes', 'direct_entry_set_current_on_insert'],
    array['public.direct_entry_team_leader_assignments', 'direct_entry_set_current_on_insert'],
    array['public.recruiter_team_memberships', 'direct_entry_no_vendor_recruiter_team_membership'],
    array['public.direct_entry_team_leader_assignments', 'direct_entry_team_leader_assignment_marker_guard'],
    array['public.direct_entry_app_users', 'direct_entry_clear_authority_on_disable'],
    array['public.recruiters', 'direct_entry_clear_authority_on_disable'],
    array['public.teams', 'direct_entry_clear_authority_on_disable'],
    array['public.direct_entry_projects', 'direct_entry_clear_authority_on_disable'],
    array['public.vendors', 'direct_entry_clear_authority_on_disable']
  ];
  v_idx integer;
begin
  -- 3a. Verify 3 target tables and 10 dropped functions are absent
  foreach v_tbl_name in array v_dropped_tables loop
    if pg_catalog.to_regclass(v_tbl_name) is not null then
      raise exception 'WP10-7-3D postcheck failed: dropped table % still exists', v_tbl_name
        using errcode = '55000';
    end if;
  end loop;

  foreach v_fn_name in array v_dropped_fn_names loop
    select count(*)::integer
      into v_remaining_overloads
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = v_fn_name;

    if v_remaining_overloads <> 0 then
      raise exception 'WP10-7-3D postcheck failed: expected 0 overloads of public.%, found %',
        v_fn_name, v_remaining_overloads
        using errcode = '55000';
    end if;
  end loop;

  -- 3b. Verify ALL 5 shared trigger functions remain intact with hardened search_path & ACL
  foreach v_sig in array v_shared_trigger_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-7-3D postcheck failed: shared trigger function % missing', v_sig
        using errcode = '55000';
    end if;

    select p.prosecdef, p.proconfig, p.proowner, p.proacl
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'WP10-7-3D postcheck failed: shared trigger function % missing hardened search_path', v_sig
        using errcode = '55000';
    end if;

    if v_sig = any(v_secdef_shared_fns) and not coalesce(v_rec.prosecdef, false) then
      raise exception 'WP10-7-3D postcheck failed: shared trigger function % lost SECURITY DEFINER', v_sig
        using errcode = '55000';
    end if;

    select exists (
      select 1
        from pg_catalog.aclexplode(coalesce(v_rec.proacl, pg_catalog.acldefault('f', v_rec.proowner))) a
       where a.grantee = 0
         and a.privilege_type = 'EXECUTE'
    ) into v_public_exec;

    if v_public_exec
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege(v_rec.proowner, v_oid, 'EXECUTE') then
      raise exception 'WP10-7-3D postcheck failed: invalid EXECUTE ACL on shared trigger function %', v_sig
        using errcode = '55000';
    end if;
  end loop;

  for v_idx in 1 .. pg_catalog.array_length(v_live_triggers, 1) loop
    if not exists (
      select 1
        from pg_catalog.pg_trigger t
       where t.tgrelid = pg_catalog.to_regclass(v_live_triggers[v_idx][1])
         and t.tgname = v_live_triggers[v_idx][2]
         and not t.tgisinternal
    ) then
      raise exception 'WP10-7-3D postcheck failed: live trigger %.% missing',
        v_live_triggers[v_idx][1], v_live_triggers[v_idx][2]
        using errcode = '55000';
    end if;
  end loop;

  -- 3c. Verify 0 remaining pg_proc references to the 3 dropped tables across non-system schemas
  select count(*)::integer,
         pg_catalog.string_agg(
           n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
           ', '
           order by n.nspname, p.proname
         )
    into v_remaining_refs, v_remaining_ref_sigs
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname <> 'pg_catalog'
     and n.nspname <> 'information_schema'
     and n.nspname not like 'pg\_%' escape '\'
     and n.nspname not in (
       'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public',
       'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions',
       'supabase_migrations', 'net', 'pgtle', 'cron', 'pgbouncer'
     )
     and p.prokind in ('f', 'p')
     and pg_catalog.regexp_replace(
           coalesce(p.prosrc, ''),
           $rx$(--[^\r\n]*|/\*([^*]|\*+[^*/])*\*+/)$rx$,
           ' ',
           'g'
         ) ~* '\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants)\M';

  if v_remaining_refs > 0 then
    raise exception 'WP10-7-3D postcheck failed: % routine(s) still mention dropped legacy grant tables: %',
      v_remaining_refs, coalesce(v_remaining_ref_sigs, '<unknown>')
      using errcode = '55000';
  end if;

  -- 3d. Verify preserved authz & org tables remain intact with RLS enabled & forced
  foreach v_tbl_name in array v_preserved_tables loop
    v_oid := pg_catalog.to_regclass(v_tbl_name);
    if v_oid is null then
      raise exception 'WP10-7-3D postcheck failed: preserved table % missing', v_tbl_name
        using errcode = '55000';
    end if;
    select c.relrowsecurity, c.relforcerowsecurity
      into v_rel
      from pg_catalog.pg_class c
     where c.oid = v_oid;
    if not coalesce(v_rel.relrowsecurity, false)
       or not coalesce(v_rel.relforcerowsecurity, false) then
      raise exception 'WP10-7-3D postcheck failed: preserved table % must keep RLS enabled and forced', v_tbl_name
        using errcode = '55000';
    end if;
  end loop;
end
$wp10_7_3d_postcheck$;

commit;
