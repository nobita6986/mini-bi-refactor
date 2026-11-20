-- =============================================================================
-- WP8D (Nav Slice): Pure Read-Only Work Report Obligations Probe for AppShell
-- =============================================================================
-- Eliminates DB writes, advisory locks, obligation materialization, and
-- schema_json loading during AppShell navbar construction.
--
-- Semantics invariant:
--   For any valid enabled actor (p_auth_subject, p_app_user_id),
--   `work_report_has_active_obligations(p_auth_subject, p_app_user_id)` returns
--   `{"has_active_obligations": boolean}` strictly inside READ ONLY transactions
--   and matches `jsonb_array_length(work_report_list_my_obligations(..., 'ACTIVE')->'items') > 0`
--   without mutating any table or acquiring advisory/row locks:
--     1. Existing ACTIVE obligations (including historical/submitted/approved/ended).
--     2. Unmaterialized eligible assignments (USER, USER_SET, TEAM, GROUP +
--        eligibility + group member assignability + ONCE + 7-day VN lookback window).
--     3. Reactivatable CANCELLED obligations (never submitted: first_submitted_at is null)
--        vs non-reactivatable EXEMPTED or submitted CANCELLED obligations.
--
-- Materialization remains intact in `work_report_list_my_obligations` and
-- `work_report__internal_materialize_actor_obligations`, sharing the same pure
-- read-only candidate query helper so probe and materializer cannot drift.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Shared pure read-only STABLE candidate query helper (internal, no grants)
-- -----------------------------------------------------------------------------
create or replace function public.work_report__internal_actor_materialization_candidates(
  p_app_user_id uuid,
  p_business_date date,
  p_lookback_days integer default 7
)
returns table (
  template_id uuid,
  template_version_id uuid,
  assignment_id uuid,
  snapshot_group_id uuid,
  snapshot_group_name text,
  frequency text,
  period_key text,
  period_start_date date,
  period_end_date date,
  due_at timestamptz,
  is_mandatory boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_days integer := greatest(least(coalesce(p_lookback_days, 7), 31), 1);
  v_window_start date;
  v_is_eligible boolean;
begin
  if p_app_user_id is null or p_business_date is null then
    return;
  end if;

  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.enabled
  ) then
    return;
  end if;

  v_window_start := p_business_date - (v_days - 1);
  v_is_eligible := public.work_report__internal_is_eligible_assignee(p_app_user_id);

  return query
  with window_dates as (
    select gs::date as business_date
      from pg_catalog.generate_series(
        v_window_start::timestamp,
        p_business_date::timestamp,
        interval '1 day'
      ) gs
  ),
  actor_assignments as (
    select a.assignment_id,
           a.template_id,
           a.template_version_id,
           a.frequency,
           a.due_day_offset,
           a.due_time_local,
           a.exclude_sundays,
           a.is_mandatory,
           a.effective_from,
           a.effective_to,
           a.created_at,
           case
             when a.target_kind = 'GROUP' then g.group_id
             else null::uuid
           end as snapshot_group_id,
           case
             when a.target_kind = 'GROUP' then g.display_name
             else null::text
           end as snapshot_group_name
      from public.work_report_assignments a
      join public.work_report_templates tpl
        on tpl.template_id = a.template_id
       and tpl.status = 'ACTIVE'
      left join public.work_report_groups g
        on a.target_kind = 'GROUP'
       and g.group_id = a.target_group_id
     where a.is_current
       and a.state = 'ACTIVE'
       and a.effective_from <= p_business_date
       and (a.effective_to is null or a.effective_to >= v_window_start)
       and (
         (a.target_kind = 'USER' and a.target_user_id = p_app_user_id)
         or (
           a.target_kind = 'USER_SET'
           and exists (
             select 1
               from public.work_report_assignment_targets x
              where x.assignment_id = a.assignment_id
                and x.target_user_id = p_app_user_id
           )
         )
         or (
           a.target_kind = 'TEAM'
           and exists (
             select 1
               from public.direct_entry_app_user_recruiter_links l
               join public.recruiter_team_memberships m
                 on m.recruiter_id = l.recruiter_id
                and m.is_current
              where l.app_user_id = p_app_user_id
                and l.verified
                and l.is_current
                and m.team_id = a.target_team_id
           )
         )
         or (
           a.target_kind = 'GROUP'
           and v_is_eligible
           and g.active is true
           and exists (
             select 1
               from public.work_report_group_members gm
              where gm.group_id = a.target_group_id
                and gm.member_user_id = p_app_user_id
           )
           and not exists (
             select 1
               from public.work_report_group_members gm_out
              where gm_out.group_id = a.target_group_id
                and not public.work_report__internal_actor_can_assign_member(
                  a.assigned_by_user_id,
                  gm_out.member_user_id,
                  a.template_id
                )
           )
         )
       )
  ),
  materialized as (
    select aa.template_id,
           aa.template_version_id,
           aa.assignment_id,
           aa.snapshot_group_id,
           aa.snapshot_group_name,
           aa.frequency,
           p.period_key,
           p.period_start_date,
           p.period_end_date,
           public.work_report_due_at(
             p.period_end_date,
             aa.due_day_offset,
             aa.due_time_local,
             aa.exclude_sundays
           ) as due_at,
           aa.is_mandatory,
           aa.created_at
      from actor_assignments aa
      join window_dates wd
        on aa.effective_from <= wd.business_date
       and (aa.effective_to is null or wd.business_date <= aa.effective_to)
       and (
         aa.frequency <> 'ONCE'
         or (
           wd.business_date = greatest(aa.effective_from, v_window_start)
           and not exists (
             select 1
               from public.work_report_obligations o_once
              where o_once.assignment_id = aa.assignment_id
                and o_once.assignee_app_user_id = p_app_user_id
           )
         )
       )
      cross join lateral public.work_report_period(aa.frequency, wd.business_date) p
  )
  select distinct on (m.template_id, m.period_key)
         m.template_id,
         m.template_version_id,
         m.assignment_id,
         m.snapshot_group_id,
         m.snapshot_group_name,
         m.frequency,
         m.period_key,
         m.period_start_date,
         m.period_end_date,
         m.due_at,
         m.is_mandatory
    from materialized m
   order by m.template_id, m.period_key, m.due_at asc, m.created_at asc, m.assignment_id asc;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 2. Keep actor materializer identical in semantics while reusing candidate query
-- -----------------------------------------------------------------------------
create or replace function public.work_report__internal_materialize_actor_obligations(
  p_app_user_id uuid,
  p_business_date date,
  p_lookback_days integer default 7
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_days integer := greatest(least(coalesce(p_lookback_days, 7), 31), 1);
  v_team_id uuid;
  v_inserted integer := 0;
begin
  if p_app_user_id is null or p_business_date is null then
    return 0;
  end if;

  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.enabled
  ) then
    return 0;
  end if;

  -- Serialize concurrent personal-list materializations for the same actor without blocking other actors.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('work_report_materialize_actor'),
    pg_catalog.hashtext(p_app_user_id::text)
  );

  v_team_id := public.work_report_current_team(p_app_user_id);

  with inserted as (
    insert into public.work_report_obligations as existing (
      template_id,
      template_version_id,
      assignment_id,
      assignee_app_user_id,
      snapshot_team_id,
      snapshot_team_code,
      snapshot_team_display_name,
      snapshot_group_id,
      snapshot_group_name,
      period_type,
      period_key,
      period_start_date,
      period_end_date,
      due_at,
      is_mandatory
    )
    select d.template_id,
           d.template_version_id,
           d.assignment_id,
           p_app_user_id,
           v_team_id,
           t.code,
           t.display_name,
           d.snapshot_group_id,
           d.snapshot_group_name,
           d.frequency,
           d.period_key,
           d.period_start_date,
           d.period_end_date,
           d.due_at,
           d.is_mandatory
      from public.work_report__internal_actor_materialization_candidates(
             p_app_user_id,
             p_business_date,
             v_days
           ) d
      left join public.teams t on t.team_id = v_team_id
     order by d.template_id, d.period_key
    on conflict (template_id, assignee_app_user_id, period_key) do update
       set template_version_id = excluded.template_version_id,
           assignment_id = excluded.assignment_id,
           snapshot_team_id = excluded.snapshot_team_id,
           snapshot_team_code = excluded.snapshot_team_code,
           snapshot_team_display_name = excluded.snapshot_team_display_name,
           snapshot_group_id = excluded.snapshot_group_id,
           snapshot_group_name = excluded.snapshot_group_name,
           period_type = excluded.period_type,
           period_start_date = excluded.period_start_date,
           period_end_date = excluded.period_end_date,
           due_at = excluded.due_at,
           is_mandatory = excluded.is_mandatory,
           obligation_status = 'ACTIVE',
           status_changed_by_user_id = null,
           status_reason_id = null,
           reopened_until = null,
           version = existing.version + 1,
           updated_at = pg_catalog.now()
     where existing.obligation_status = 'CANCELLED'
       and not exists (
         select 1
           from public.work_report_submissions s
          where s.obligation_id = existing.obligation_id
            and s.first_submitted_at is not null
       )
    returning 1
  )
  select count(*)::integer into v_inserted from inserted;

  return v_inserted;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Pure read-only STABLE boolean helper for a target business date (internal)
-- -----------------------------------------------------------------------------
create or replace function public.work_report__internal_has_active_obligations_for_date(
  p_app_user_id uuid,
  p_business_date date,
  p_lookback_days integer default 7
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if p_app_user_id is null or p_business_date is null then
    return false;
  end if;

  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.enabled
  ) then
    return false;
  end if;

  -- Fast indexed path: existing ACTIVE obligation (historical, submitted, approved, or ended assignment).
  if exists (
    select 1
      from public.work_report_obligations o
     where o.assignee_app_user_id = p_app_user_id
       and o.obligation_status = 'ACTIVE'
  ) then
    return true;
  end if;

  -- Read-only candidate path: true iff materializer would insert a new ACTIVE obligation
  -- or reactivate an unsubmitted CANCELLED obligation (never reactivates EXEMPTED or submitted rows).
  return exists (
    select 1
      from public.work_report__internal_actor_materialization_candidates(
             p_app_user_id,
             p_business_date,
             p_lookback_days
           ) c
     where not exists (
             select 1
               from public.work_report_obligations existing
              where existing.template_id = c.template_id
                and existing.assignee_app_user_id = p_app_user_id
                and existing.period_key = c.period_key
                and (
                  existing.obligation_status <> 'CANCELLED'
                  or exists (
                    select 1
                      from public.work_report_submissions s
                     where s.obligation_id = existing.obligation_id
                       and s.first_submitted_at is not null
                  )
                )
           )
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Public service_role STABLE read-only nav probe RPC
-- -----------------------------------------------------------------------------
create or replace function public.work_report_has_active_obligations(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_business_date date := (pg_catalog.now() at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  if p_auth_subject is null or p_app_user_id is null or not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) then
    raise exception 'WORK_REPORT_ACTOR_DENIED' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object(
    'has_active_obligations',
    public.work_report__internal_has_active_obligations_for_date(
      p_app_user_id,
      v_business_date,
      7
    )
  );
end;
$function$;

comment on function public.work_report_has_active_obligations(uuid, uuid) is
  'WP8D read-only STABLE Work Reports nav probe for AppShell. Returns boolean matching work_report_list_my_obligations(ACTIVE) without DB writes, advisory locks, materialization, or schema loading.';

-- -----------------------------------------------------------------------------
-- 5. Strict ACLs (internal helpers revoked from all; probe granted only to service_role)
-- -----------------------------------------------------------------------------
revoke all on function public.work_report__internal_actor_materialization_candidates(uuid, date, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report__internal_materialize_actor_obligations(uuid, date, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.work_report__internal_has_active_obligations_for_date(uuid, date, integer)
  from public, anon, authenticated, service_role;

revoke all on function public.work_report_has_active_obligations(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_has_active_obligations(uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 6. Owner Alignment & Install-Time Security/Volatility Self-Check
-- -----------------------------------------------------------------------------
do $align_wp8d_nav_readonly$
declare
  v_owner_oid oid;
  v_owner name;
  v_signature text;
  v_proc_owner_oid oid;
begin
  select c.relowner, pg_catalog.pg_get_userbyid(c.relowner)
    into v_owner_oid, v_owner
    from pg_catalog.pg_class c
   where c.oid = 'public.work_report_assignments'::pg_catalog.regclass;

  if v_owner_oid is null then
    raise exception 'WP8D_NAV_READONLY_MISSING_BASE_TABLE' using errcode = '55000';
  end if;

  foreach v_signature in array array[
    'public.work_report__internal_actor_materialization_candidates(uuid, date, integer)',
    'public.work_report__internal_materialize_actor_obligations(uuid, date, integer)',
    'public.work_report__internal_has_active_obligations_for_date(uuid, date, integer)',
    'public.work_report_has_active_obligations(uuid, uuid)'
  ]
  loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_signature);

    if v_proc_owner_oid is distinct from v_owner_oid
       and pg_catalog.pg_has_role(current_user, v_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_signature, v_owner);
    end if;
  end loop;
end
$align_wp8d_nav_readonly$;

do $check_wp8d_nav_readonly$
declare
  v_owner_oid oid;
  v_fn pg_catalog.regprocedure;
  v_proc record;
begin
  select c.relowner
    into v_owner_oid
    from pg_catalog.pg_class c
   where c.oid = 'public.work_report_assignments'::pg_catalog.regclass;

  if v_owner_oid is null then
    raise exception 'WP8D_NAV_READONLY_MISSING_BASE_TABLE' using errcode = '55000';
  end if;

  -- Internal helpers: SECURITY DEFINER, owner aligned + BYPASSRLS/superuser, pinned search_path, zero runtime EXECUTE
  foreach v_fn in array array[
    'public.work_report__internal_actor_materialization_candidates(uuid, date, integer)'::pg_catalog.regprocedure,
    'public.work_report__internal_materialize_actor_obligations(uuid, date, integer)'::pg_catalog.regprocedure,
    'public.work_report__internal_has_active_obligations_for_date(uuid, date, integer)'::pg_catalog.regprocedure
  ]
  loop
    select p.proowner,
           p.prosecdef,
           p.provolatile,
           coalesce(pg_catalog.array_to_string(p.proconfig, ','), '') as config_str,
           p.proacl,
           (r.rolsuper or r.rolbypassrls) as owner_bypasses_rls
      into v_proc
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_fn;

    if not found
       or v_proc.proowner is distinct from v_owner_oid
       or not coalesce(v_proc.prosecdef, false)
       or v_proc.config_str <> 'search_path=pg_catalog, public'
       or not coalesce(v_proc.owner_bypasses_rls, false) then
      raise exception 'WP8D_NAV_READONLY_CHECK_FAILED: unsafe secdef/owner/search_path on %', v_fn
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(v_proc.proacl, pg_catalog.acldefault('f', v_proc.proowner))) a
          where a.grantee = 0
            and a.privilege_type = 'EXECUTE'
       ) then
      raise exception 'WP8D_NAV_READONLY_CHECK_FAILED: internal helper must stay revoked from all runtime roles: %', v_fn
        using errcode = '55000';
    end if;
  end loop;

  -- Public nav probe RPC: STABLE, SECURITY DEFINER, owner aligned + BYPASSRLS/superuser, service_role EXECUTE only
  v_fn := 'public.work_report_has_active_obligations(uuid, uuid)'::pg_catalog.regprocedure;
  select p.proowner,
         p.prosecdef,
         p.provolatile,
         coalesce(pg_catalog.array_to_string(p.proconfig, ','), '') as config_str,
         p.proacl,
         (r.rolsuper or r.rolbypassrls) as owner_bypasses_rls
    into v_proc
    from pg_catalog.pg_proc p
    join pg_catalog.pg_roles r on r.oid = p.proowner
   where p.oid = v_fn;

  if not found
     or v_proc.proowner is distinct from v_owner_oid
     or not coalesce(v_proc.prosecdef, false)
     or v_proc.provolatile <> 's'
     or v_proc.config_str <> 'search_path=pg_catalog, public'
     or not coalesce(v_proc.owner_bypasses_rls, false) then
    raise exception 'WP8D_NAV_READONLY_CHECK_FAILED: probe RPC must be STABLE SECURITY DEFINER with pinned search_path'
      using errcode = '55000';
  end if;

  if pg_catalog.has_function_privilege('public', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_fn, 'EXECUTE')
     or exists (
       select 1
         from pg_catalog.aclexplode(coalesce(v_proc.proacl, pg_catalog.acldefault('f', v_proc.proowner))) a
        where a.grantee = 0
          and a.privilege_type = 'EXECUTE'
     ) then
    raise exception 'WP8D_NAV_READONLY_CHECK_FAILED: probe RPC must grant EXECUTE only to service_role'
      using errcode = '55000';
  end if;

  -- Verify read-only internal helpers are strictly STABLE
  foreach v_fn in array array[
    'public.work_report__internal_actor_materialization_candidates(uuid, date, integer)'::pg_catalog.regprocedure,
    'public.work_report__internal_has_active_obligations_for_date(uuid, date, integer)'::pg_catalog.regprocedure
  ]
  loop
    if (select p.provolatile from pg_catalog.pg_proc p where p.oid = v_fn) <> 's' then
      raise exception 'WP8D_NAV_READONLY_CHECK_FAILED: read-only helper % must be STABLE', v_fn
        using errcode = '55000';
    end if;
  end loop;
end
$check_wp8d_nav_readonly$;

commit;
