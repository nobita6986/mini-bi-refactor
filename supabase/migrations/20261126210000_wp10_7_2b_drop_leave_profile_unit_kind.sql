-- =============================================================================
-- WP10-7 Slice 2B: Drop legacy public.leave_employee_profiles.unit_kind column
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. Fail-closed pre-drop gate (do $wp10_7_2b_precheck$):
--      (a) Verify public.leave_employee_profiles and non-dropped column
--          unit_kind exist.
--      (b) Verify pg_depend on (refobjid = v_tbl, refobjsubid = v_attnum)
--          contains ONLY unit_kind's own pg_attrdef default and table-local
--          CHECK / PG18 NOT NULL pg_constraint entries on v_tbl.
--      (c) Explicitly verify 0 FKs, 0 indexes, 0 RLS policies referencing
--          unit_kind, and 0 triggers on any table calling
--          public.org_department__internal_guard_leave_profile() other than
--          leave_employee_profiles_org_guard_trg on public.leave_employee_profiles.
--      (d) Scan pg_proc across all non-system application schemas (normalized
--          prosrc with comments and string literals stripped) and fail closed
--          (55000) if any function/procedure (except the guard trigger function
--          being dropped) references the guard function, qualified
--          leave_employee_profiles.unit_kind, or reads/writes unit_kind on
--          leave_employee_profiles.
--   2. Drop trigger leave_employee_profiles_org_guard_trg, drop guard function
--      public.org_department__internal_guard_leave_profile() RESTRICT, and
--      alter table public.leave_employee_profiles drop column unit_kind RESTRICT.
--   3. Fail-closed post-drop self-check (do $wp10_7_2b_postcheck$):
--      (a) Verify unit_kind column, leave_employee_profiles_unit_kind_chk,
--          leave_employee_profiles_org_guard_trg, and
--          public.org_department__internal_guard_leave_profile() are absent.
--      (b) Verify preserved snapshot columns, leave_employee_profiles columns
--          and FORCE RLS, audit tables, and organization_department_heads.
--      (c) Verify Leave & Org service_role RPCs retain SECURITY DEFINER,
--          search_path = pg_catalog, public, and service_role-only EXECUTE ACL.
-- =============================================================================

begin;

do $wp10_7_2b_precheck$
declare
  v_tbl oid;
  v_attnum smallint;
  v_guard_oid oid;
  v_guard_overloads integer := 0;
  v_dep_count integer := 0;
  v_deps text;
  v_fk_count integer := 0;
  v_fks text;
  v_idx_count integer := 0;
  v_idxs text;
  v_pol_count integer := 0;
  v_pols text;
  v_extra_trg_count integer := 0;
  v_extra_trgs text;
  v_proc record;
  v_norm text;
  v_no_comments text;
  v_dyn text;
  v_pass integer;
  v_scan_sql text;
  v_prefix text;
  v_stmt text;
  v_stmt_no_as text;
  v_alias text;
  v_reason text;
  v_bad_procs text[] := array[]::text[];
  v_keywords constant text[] := array[
    'on', 'where', 'set', 'join', 'left', 'right', 'inner', 'outer', 'full',
    'cross', 'natural', 'using', 'group', 'order', 'having', 'limit', 'offset',
    'union', 'intersect', 'except', 'for', 'into', 'values', 'returning',
    'and', 'or', 'not', 'null', 'as', 'from', 'select', 'update', 'insert',
    'delete', 'when', 'then', 'else', 'end', 'loop', 'begin', 'declare',
    'wait', 'nowait', 'skip', 'locked', 'share', 'key', 'no', 'of'
  ];
begin
  -- 1a. Assert table and non-dropped unit_kind column exist, then lock table
  v_tbl := pg_catalog.to_regclass('public.leave_employee_profiles');
  if v_tbl is null then
    raise exception 'WP10-7-2B precheck failed: public.leave_employee_profiles does not exist'
      using errcode = '55000';
  end if;

  select a.attnum
    into v_attnum
    from pg_catalog.pg_attribute a
   where a.attrelid = v_tbl
     and a.attname = 'unit_kind'
     and a.attnum > 0
     and not a.attisdropped;

  if v_attnum is null then
    raise exception 'WP10-7-2B precheck failed: public.leave_employee_profiles.unit_kind does not exist'
      using errcode = '55000';
  end if;

  lock table public.leave_employee_profiles in access exclusive mode;

  -- 1b. pg_depend gate on (refobjid = v_tbl, refobjsubid = v_attnum):
  --     allow ONLY unit_kind's own default (pg_attrdef) and table-local
  --     CHECK / PG18 NOT NULL constraints on v_tbl.
  select count(*)::integer,
         pg_catalog.string_agg(
           distinct case
             when d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass then
               coalesce(vn.nspname || '.' || vc.relname || ' (' || vc.relkind::text || ')', 'pg_rewrite:' || d.objid::text)
             when d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass then
               coalesce(vn.nspname || '.' || vc.relname || ' (' || vc.relkind::text || ')', 'pg_class:' || d.objid::text)
             when d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass then
               coalesce(dp.oid::pg_catalog.regprocedure::text, 'pg_proc:' || d.objid::text)
             when d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass then
               coalesce(dc.conrelid::pg_catalog.regclass::text || '.' || dc.conname, 'pg_constraint:' || d.objid::text)
             when d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass then
               coalesce(dpol.polrelid::pg_catalog.regclass::text || '.' || dpol.polname, 'pg_policy:' || d.objid::text)
             when d.classid = 'pg_catalog.pg_trigger'::pg_catalog.regclass then
               coalesce(dtrg.tgrelid::pg_catalog.regclass::text || '.' || dtrg.tgname, 'pg_trigger:' || d.objid::text)
             when d.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass then
               coalesce(dad.adrelid::pg_catalog.regclass::text || '.attnum=' || dad.adnum::text, 'pg_attrdef:' || d.objid::text)
             else
               d.classid::pg_catalog.regclass::text || ':' || d.objid::text
           end,
           ', '
         )
    into v_dep_count, v_deps
    from pg_catalog.pg_depend d
    left join pg_catalog.pg_rewrite rw
      on d.classid = 'pg_catalog.pg_rewrite'::pg_catalog.regclass
     and rw.oid = d.objid
    left join pg_catalog.pg_class vc
      on vc.oid = coalesce(rw.ev_class, case when d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass then d.objid end)
    left join pg_catalog.pg_namespace vn
      on vn.oid = vc.relnamespace
    left join pg_catalog.pg_proc dp
      on d.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
     and dp.oid = d.objid
    left join pg_catalog.pg_constraint dc
      on d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
     and dc.oid = d.objid
    left join pg_catalog.pg_policy dpol
      on d.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass
     and dpol.oid = d.objid
    left join pg_catalog.pg_trigger dtrg
      on d.classid = 'pg_catalog.pg_trigger'::pg_catalog.regclass
     and dtrg.oid = d.objid
    left join pg_catalog.pg_attrdef dad
      on d.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass
     and dad.oid = d.objid
   where d.refobjid = v_tbl
     and d.refobjsubid = v_attnum
     and not (
       d.classid = 'pg_catalog.pg_attrdef'::pg_catalog.regclass
       and exists (
         select 1
           from pg_catalog.pg_attrdef ad
          where ad.oid = d.objid
            and ad.adrelid = v_tbl
            and ad.adnum = v_attnum
       )
     )
     and not (
       d.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
       and exists (
         select 1
           from pg_catalog.pg_constraint c
          where c.oid = d.objid
            and c.conrelid = v_tbl
            and c.contype in ('c', 'n')
       )
     );

  if v_dep_count > 0 then
    raise exception 'WP10-7-2B precheck failed: % unexpected pg_depend object(s) depend on public.leave_employee_profiles.unit_kind: %',
      v_dep_count, coalesce(v_deps, '<unknown>')
      using errcode = '55000';
  end if;

  -- 1c. Explicit checks: 0 FKs, 0 indexes, 0 RLS policies, and 0 other triggers
  select count(*)::integer,
         pg_catalog.string_agg(
           c.conrelid::pg_catalog.regclass::text || '.' || c.conname,
           ', '
           order by c.conrelid::pg_catalog.regclass::text, c.conname
         )
    into v_fk_count, v_fks
    from pg_catalog.pg_constraint c
   where c.contype = 'f'
     and (
       (c.conrelid = v_tbl and v_attnum = any(c.conkey))
       or (c.confrelid = v_tbl and v_attnum = any(c.confkey))
     );

  if v_fk_count > 0 then
    raise exception 'WP10-7-2B precheck failed: % foreign key(s) reference public.leave_employee_profiles.unit_kind: %',
      v_fk_count, coalesce(v_fks, '<unknown>')
      using errcode = '55000';
  end if;

  select count(*)::integer,
         pg_catalog.string_agg(
           i.indexrelid::pg_catalog.regclass::text,
           ', '
           order by i.indexrelid::pg_catalog.regclass::text
         )
    into v_idx_count, v_idxs
    from pg_catalog.pg_index i
   where i.indrelid = v_tbl
     and v_attnum = any(i.indkey::smallint[]);

  if v_idx_count > 0 then
    raise exception 'WP10-7-2B precheck failed: % index(es) reference public.leave_employee_profiles.unit_kind: %',
      v_idx_count, coalesce(v_idxs, '<unknown>')
      using errcode = '55000';
  end if;

  select count(*)::integer,
         pg_catalog.string_agg(pol.polname, ', ' order by pol.polname)
    into v_pol_count, v_pols
    from pg_catalog.pg_policy pol
   where pol.polrelid = v_tbl
     and (
       coalesce(pg_catalog.pg_get_expr(pol.polqual, pol.polrelid), '') ~* '\munit_kind\M'
       or coalesce(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~* '\munit_kind\M'
     );

  if v_pol_count > 0 then
    raise exception 'WP10-7-2B precheck failed: % RLS policy(ies) on public.leave_employee_profiles reference unit_kind: %',
      v_pol_count, coalesce(v_pols, '<unknown>')
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_guard_overloads
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'org_department__internal_guard_leave_profile';

  v_guard_oid := pg_catalog.to_regprocedure('public.org_department__internal_guard_leave_profile()');
  if v_guard_overloads <> 1 or v_guard_oid is null then
    raise exception 'WP10-7-2B precheck failed: expected single public.org_department__internal_guard_leave_profile() function, found %',
      v_guard_overloads
      using errcode = '55000';
  end if;

  select count(*)::integer,
         pg_catalog.string_agg(
           t.tgrelid::pg_catalog.regclass::text || '.' || t.tgname,
           ', '
           order by t.tgrelid::pg_catalog.regclass::text, t.tgname
         )
    into v_extra_trg_count, v_extra_trgs
    from pg_catalog.pg_trigger t
   where t.tgfoid = v_guard_oid
     and not (
       t.tgrelid = v_tbl
       and t.tgname = 'leave_employee_profiles_org_guard_trg'
       and not t.tgisinternal
     );

  if v_extra_trg_count > 0 then
    raise exception 'WP10-7-2B precheck failed: % unexpected trigger(s) still call org_department__internal_guard_leave_profile(): %',
      v_extra_trg_count, coalesce(v_extra_trgs, '<unknown>')
      using errcode = '55000';
  end if;

  -- 1d. Scan pg_proc across ALL non-system application schemas
  for v_proc in
    select p.oid,
           n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as sig,
           p.prosrc
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
       and p.oid <> v_guard_oid
     order by n.nspname, p.proname, p.oid
  loop
    v_norm := pg_catalog.regexp_replace(
      coalesce(v_proc.prosrc, ''),
      $rx$('([^']|'')*'|--[^\r\n]*|/\*.*?\*/)$rx$,
      ' ',
      'g'
    );
    v_reason := null;

    for v_pass in 1..2 loop
      exit when v_reason is not null;
      if v_pass = 1 then
        v_scan_sql := v_norm;
        v_prefix := '';
      else
        exit when v_norm !~* '\mexecute\M';
        v_no_comments := pg_catalog.regexp_replace(
          coalesce(v_proc.prosrc, ''),
          $rx$(--[^\r\n]*|/\*.*?\*/)$rx$,
          ' ',
          'g'
        );
        exit when v_no_comments !~* '\morg_department__internal_guard_leave_profile\M'
          and not (
            v_no_comments ~* '\mleave_employee_profiles\M'
            and v_no_comments ~* '\munit_kind\M'
          );
        v_dyn := pg_catalog.replace(
          pg_catalog.regexp_replace(v_no_comments, $rx$''([^']|'''')*''$rx$, ' ', 'g'),
          '''',
          ' '
        );
        v_scan_sql := v_dyn;
        v_prefix := 'dynamic EXECUTE: ';
      end if;

      if v_scan_sql ~* '\morg_department__internal_guard_leave_profile\M' then
        v_reason := v_prefix || 'references org_department__internal_guard_leave_profile';
      elsif v_scan_sql ~* '\mleave_employee_profiles\s*\.\s*unit_kind\M' then
        v_reason := v_prefix || 'references leave_employee_profiles.unit_kind';
      elsif v_scan_sql ~* '\mleave_employee_profiles\M' then
        -- Check table aliases, FOR record variables, and %ROWTYPE variables bound to leave_employee_profiles
        for v_alias in
          select m[1]
            from pg_catalog.regexp_matches(
                   v_scan_sql,
                   '\mleave_employee_profiles\s+(?:as\s+)?([a-z_][a-z0-9_]*)\M',
                   'gi'
                 ) as m
          union
          select m[1]
            from pg_catalog.regexp_matches(
                   v_scan_sql,
                   '\m([a-z_][a-z0-9_]*)\s+(?:[a-z_][a-z0-9_]*\s*\.\s*)?leave_employee_profiles\s*%\s*rowtype\M',
                   'gi'
                 ) as m
          union
          select m[1]
            from pg_catalog.regexp_matches(
                   v_scan_sql,
                   '\mfor\s+([a-z_][a-z0-9_]*)\s+in\b[^;]*?\mleave_employee_profiles\M',
                   'gi'
                 ) as m
        loop
          if lower(v_alias) <> all(v_keywords)
             and v_scan_sql ~* ('\m' || v_alias || '\s*\.\s*unit_kind\M') then
            v_reason := v_prefix || 'references ' || v_alias || '.unit_kind';
            exit;
          end if;
        end loop;

        if v_reason is null then
          for v_stmt in
            select s
              from pg_catalog.regexp_split_to_table(v_scan_sql, ';') as s
             where s ~* '\mleave_employee_profiles\M'
          loop
            if v_stmt ~* '\mupdate\s+(?:only\s+)?(?:[a-z_][a-z0-9_]*\s*\.\s*)?leave_employee_profiles\b.*?\mset\b.*?\munit_kind\s*=' then
              v_reason := v_prefix || 'UPDATE SET unit_kind';
              exit;
            elsif v_stmt ~* '\minsert\s+into\s+(?:[a-z_][a-z0-9_]*\s*\.\s*)?leave_employee_profiles\s*\([^)]*\munit_kind\M' then
              v_reason := v_prefix || 'INSERT INTO leave_employee_profiles (... unit_kind ...)';
              exit;
            elsif v_stmt ~* '\m(insert\s+into|update|delete\s+from)\b.*?\mleave_employee_profiles\b.*?\mreturning\b.*?\munit_kind\M' then
              v_reason := v_prefix || 'RETURNING unit_kind';
              exit;
            else
              v_stmt_no_as := pg_catalog.regexp_replace(v_stmt, '\mas\s+unit_kind\M', ' ', 'gi');
              if v_stmt_no_as ~* '(^|[^a-z0-9_.])unit_kind\M' then
                v_reason := v_prefix || 'unqualified unit_kind in statement referencing leave_employee_profiles';
                exit;
              end if;
            end if;
          end loop;
        end if;
      end if;
    end loop;

    if v_reason is not null then
      v_bad_procs := array_append(v_bad_procs, v_proc.sig || ' [' || v_reason || ']');
    end if;
  end loop;

  if coalesce(pg_catalog.array_length(v_bad_procs, 1), 0) > 0 then
    raise exception 'WP10-7-2B precheck failed: % non-system routine(s) still reference guard/unit_kind: %',
      pg_catalog.array_length(v_bad_procs, 1),
      pg_catalog.array_to_string(v_bad_procs, '; ')
      using errcode = '55000';
  end if;
end
$wp10_7_2b_precheck$;

-- =============================================================================
-- 2. Drop legacy guard trigger, guard function, and leave_employee_profiles.unit_kind
-- =============================================================================

drop trigger if exists leave_employee_profiles_org_guard_trg on public.leave_employee_profiles;

drop function public.org_department__internal_guard_leave_profile() restrict;

alter table public.leave_employee_profiles drop column unit_kind restrict;

-- =============================================================================
-- 3. Fail-closed post-drop self-check
-- =============================================================================

do $wp10_7_2b_postcheck$
declare
  v_tbl oid;
  v_rel record;
  v_guard_overloads integer := 0;
  v_preserved_tables text[] := array[
    'public.leave_employee_profiles',
    'public.leave_requests',
    'public.attendance_explanations',
    'public.leave_audit_events',
    'public.attendance_explanation_audit_events',
    'public.organization_department_heads'
  ];
  v_preserved_cols text[][] := array[
    array['public.leave_requests', 'unit_kind_snapshot'],
    array['public.attendance_explanations', 'unit_kind_snapshot'],
    array['public.leave_employee_profiles', 'app_user_id'],
    array['public.leave_employee_profiles', 'employment_status'],
    array['public.leave_employee_profiles', 'work_start_date'],
    array['public.leave_employee_profiles', 'official_effective_date'],
    array['public.leave_employee_profiles', 'next_seniority_effective_date'],
    array['public.leave_employee_profiles', 'next_seniority_units'],
    array['public.leave_employee_profiles', 'notes'],
    array['public.leave_employee_profiles', 'row_version'],
    array['public.leave_employee_profiles', 'created_at'],
    array['public.leave_employee_profiles', 'updated_at'],
    array['public.leave_employee_profiles', 'updated_by_app_user_id']
  ];
  v_service_rpcs text[] := array[
    'public.leave_management_apply_opening_batch(uuid, uuid, integer, jsonb, text, text, text)',
    'public.leave_management_create_request(uuid, uuid, jsonb, text, text, text)',
    'public.leave_management_decide_request(uuid, uuid, uuid, text, integer, text, text, text)',
    'public.leave_management_get_actor_access(uuid, uuid)',
    'public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer, text)',
    'public.leave_management_get_my_summary(uuid, uuid, integer)',
    'public.leave_management_list_approval_inbox(uuid, uuid, text, integer, integer)',
    'public.leave_management_monthly_report(uuid, uuid, text, text, text, integer, integer)',
    'public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb)',
    'public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text)',
    'public.leave_management_update_policy_admin(uuid, uuid, integer, integer, integer, text, text, text)',
    'public.leave_management_upsert_employee_profile_admin(uuid, uuid, uuid, text, text, date, date, date, integer, integer, text, text, text)',
    'public.leave_management_withdraw_request(uuid, uuid, uuid, integer, text, text, text)',
    'public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.org_department_assign_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)',
    'public.org_department_create_department_admin(uuid, uuid, text, text, text, uuid, text)',
    'public.org_department_create_person_admin(uuid, uuid, text, text, date, uuid, uuid, integer, uuid, text, uuid, text)',
    'public.org_department_designate_head_admin(uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text)',
    'public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.org_department_end_head_admin(uuid, uuid, uuid, integer, uuid, text, uuid, text)',
    'public.org_department_end_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)',
    'public.org_department_get_department_admin(uuid, uuid, uuid, timestamptz)',
    'public.org_department_get_person_admin(uuid, uuid, uuid, timestamptz)',
    'public.org_department_get_user_directory_entry_admin(uuid, uuid, uuid, uuid, timestamptz)',
    'public.org_department_link_account_person_admin(uuid, uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)',
    'public.org_department_list_accounting_candidates_admin(uuid, uuid, text, integer, integer)',
    'public.org_department_list_accounting_memberships_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.org_department_list_department_heads_admin(uuid, uuid, uuid, boolean, timestamptz, integer, integer)',
    'public.org_department_list_departments_admin(uuid, uuid, boolean, timestamptz)',
    'public.org_department_list_person_memberships_admin(uuid, uuid, uuid, text, text, timestamptz, integer, integer)',
    'public.org_department_list_persons_admin(uuid, uuid, text, text, uuid, text, timestamptz, integer, integer)',
    'public.org_department_list_recruitment_teams_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.org_department_list_user_directory_admin(uuid, uuid, text, text, text, text, uuid, timestamptz, integer, integer)',
    'public.org_department_transfer_person_member_admin(uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text)',
    'public.org_department_unlink_account_person_admin(uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)',
    'public.org_department_update_department_admin(uuid, uuid, uuid, integer, text, boolean, text, uuid, text)',
    'public.org_department_update_person_admin(uuid, uuid, uuid, integer, text, text, date, text, text, uuid, text)'
  ];
  v_internal_fns text[] := array[
    'public.org_department__internal_resolve_leave_classification(uuid, timestamptz)',
    'public.org_department__internal_resolve_person_leave_classification(uuid, timestamptz)',
    'public.org_department__internal_bump_leave_profile_version_on_org_change(uuid, uuid, text, uuid, timestamptz)'
  ];
  v_tbl_name text;
  v_idx integer;
  v_sig text;
  v_oid oid;
  v_rec record;
  v_public_exec boolean := false;
begin
  -- 3a. Dropped column, constraint, trigger, and guard function must be absent
  v_tbl := pg_catalog.to_regclass('public.leave_employee_profiles');
  if v_tbl is null then
    raise exception 'WP10-7-2B postcheck failed: public.leave_employee_profiles missing'
      using errcode = '55000';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = v_tbl
       and a.attname = 'unit_kind'
       and a.attnum > 0
       and not a.attisdropped
  ) then
    raise exception 'WP10-7-2B postcheck failed: public.leave_employee_profiles.unit_kind still exists'
      using errcode = '55000';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_constraint c
     where c.conrelid = v_tbl
       and c.conname in ('leave_employee_profiles_unit_kind_chk', 'leave_employee_profiles_unit_kind_not_null')
  ) then
    raise exception 'WP10-7-2B postcheck failed: unit_kind constraint still exists on public.leave_employee_profiles'
      using errcode = '55000';
  end if;

  if exists (
    select 1
      from pg_catalog.pg_trigger t
     where t.tgrelid = v_tbl
       and t.tgname = 'leave_employee_profiles_org_guard_trg'
  ) then
    raise exception 'WP10-7-2B postcheck failed: leave_employee_profiles_org_guard_trg still exists'
      using errcode = '55000';
  end if;

  if pg_catalog.to_regprocedure('public.org_department__internal_guard_leave_profile()') is not null then
    raise exception 'WP10-7-2B postcheck failed: public.org_department__internal_guard_leave_profile() still exists'
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_guard_overloads
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'org_department__internal_guard_leave_profile';

  if v_guard_overloads <> 0 then
    raise exception 'WP10-7-2B postcheck failed: expected 0 overloads of org_department__internal_guard_leave_profile, found %',
      v_guard_overloads
      using errcode = '55000';
  end if;

  -- 3b. Preserved tables, RLS, and columns must remain intact
  foreach v_tbl_name in array v_preserved_tables loop
    if pg_catalog.to_regclass(v_tbl_name) is null then
      raise exception 'WP10-7-2B postcheck failed: preserved table % missing', v_tbl_name
        using errcode = '55000';
    end if;
  end loop;

  select c.relrowsecurity, c.relforcerowsecurity
    into v_rel
    from pg_catalog.pg_class c
   where c.oid = v_tbl;

  if not coalesce(v_rel.relrowsecurity, false)
     or not coalesce(v_rel.relforcerowsecurity, false) then
    raise exception 'WP10-7-2B postcheck failed: public.leave_employee_profiles must keep RLS enabled and forced'
      using errcode = '55000';
  end if;

  for v_idx in 1 .. pg_catalog.array_length(v_preserved_cols, 1) loop
    if not exists (
      select 1
        from pg_catalog.pg_attribute a
       where a.attrelid = pg_catalog.to_regclass(v_preserved_cols[v_idx][1])
         and a.attname = v_preserved_cols[v_idx][2]
         and a.attnum > 0
         and not a.attisdropped
    ) then
      raise exception 'WP10-7-2B postcheck failed: preserved column %.% missing',
        v_preserved_cols[v_idx][1], v_preserved_cols[v_idx][2]
        using errcode = '55000';
    end if;
  end loop;

  -- 3c. Leave & Org service_role RPCs & internal helpers security invariants
  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-7-2B postcheck failed: missing service RPC %', v_sig
        using errcode = '55000';
    end if;

    select p.prosecdef, p.proconfig, p.proowner, p.proacl
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'WP10-7-2B postcheck failed: service RPC % missing SECURITY DEFINER or search_path',
        v_sig using errcode = '55000';
    end if;

    select exists (
      select 1
        from pg_catalog.aclexplode(coalesce(v_rec.proacl, pg_catalog.acldefault('f', v_rec.proowner))) a
       where a.grantee = 0
         and a.privilege_type = 'EXECUTE'
    ) into v_public_exec;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege(v_rec.proowner, v_oid, 'EXECUTE')
       or v_public_exec
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'WP10-7-2B postcheck failed: invalid EXECUTE ACL on service RPC %', v_sig
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-7-2B postcheck failed: missing internal function %', v_sig
        using errcode = '55000';
    end if;

    select p.prosecdef, p.proconfig, p.proowner, p.proacl
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'WP10-7-2B postcheck failed: internal function % missing SECURITY DEFINER or search_path',
        v_sig using errcode = '55000';
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
      raise exception 'WP10-7-2B postcheck failed: invalid EXECUTE ACL on internal function %', v_sig
        using errcode = '55000';
    end if;
  end loop;
end
$wp10_7_2b_postcheck$;

commit;
