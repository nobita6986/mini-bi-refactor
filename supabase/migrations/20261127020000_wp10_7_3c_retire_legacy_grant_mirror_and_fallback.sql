-- =============================================================================
-- WP10-7 Slice 3C: Retire legacy grant mirror writes and `not authz_managed`
-- runtime fallback reads; switch `direct_entry_app_users.authz_managed`
-- default to `true`.
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. Pre-DDL fail-closed preflight ($wp10_7_3c_preflight$): block if ANY
--      account (enabled = true or enabled = false) has authz_managed = false,
--      or if direct_entry_authz__internal_resolve_effective_grants emits ANY
--      LEGACY_BRIDGE row.
--   2. Column default: ALTER TABLE public.direct_entry_app_users
--      ALTER COLUMN authz_managed SET DEFAULT true.
--   3. Stop all mirror sync calls, legacy table writes/updates/locks, and
--      uncutover checks across group, account-ops, disable/status, PM lock,
--      and team-leader routines; turn sync_legacy_grants and
--      work_report_sync_team_leader_capabilities into no-ops (kept for 3D).
--   4. Retire all runtime fallback reads of direct_entry_capability_grants,
--      direct_entry_scope_grants, and work_report_team_leader_capability_grants
--      across all 63 live pg_proc blockers; fail-close legacy predicates
--      (kept until 3D) with zero callers remaining.
--   5. Preserve all 3 legacy tables, FKs, triggers, RLS, data, #47 transition
--      provenance routing, and all 5 shared trigger functions intact for 3D.
--   6. Postcheck ($wp10_7_3c_postcheck$) verifying blocking_static_procs = 0,
--      blocking_dynamic_execute_procs = 0, DEFAULT true, triggers, owners,
--      SECURITY DEFINER, search_path, and exact ACLs (310 service_role RPCs).
-- =============================================================================

begin;

-- =============================================================================
-- SECTION 1: Pre-DDL Fail-Closed Preflight & Column Default
-- =============================================================================

do $wp10_7_3c_preflight$
declare
  v_unmanaged_total integer := 0;
  v_unmanaged_active integer := 0;
  v_unmanaged_disabled integer := 0;
  v_legacy_bridge_count integer := 0;
begin
  select count(*)::integer,
         count(*) filter (where u.enabled)::integer,
         count(*) filter (where not u.enabled)::integer
    into v_unmanaged_total, v_unmanaged_active, v_unmanaged_disabled
    from public.direct_entry_app_users u
   where not coalesce(u.authz_managed, false);

  if v_unmanaged_total > 0 then
    raise exception 'WP10_7_3C_PREFLIGHT_BLOCKED: % unmanaged account(s) remain (active=%, disabled=%)',
      v_unmanaged_total, v_unmanaged_active, v_unmanaged_disabled
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_legacy_bridge_count
    from public.direct_entry_app_users u
    cross join lateral pg_catalog.jsonb_to_recordset(
      public.direct_entry_authz__internal_resolve_effective_grants(u.app_user_id)
    ) as eg(source_type text)
   where eg.source_type = 'LEGACY_BRIDGE';

  if v_legacy_bridge_count > 0 then
    raise exception 'WP10_7_3C_PREFLIGHT_BLOCKED: % LEGACY_BRIDGE effective grant row(s) remain',
      v_legacy_bridge_count
      using errcode = '55000';
  end if;
end
$wp10_7_3c_preflight$;

alter table public.direct_entry_app_users
  alter column authz_managed set default true;

-- =============================================================================
-- SECTION 2: No-Op Sync / Bridge Trigger & Fail-Closed Legacy Predicates (Kept for 3D)
-- =============================================================================

create or replace function public.direct_entry_authz__internal_sync_legacy_grants(
  p_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  return;
end;
$function$;

create or replace function public.work_report_sync_team_leader_capabilities()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  return new;
end;
$function$;

create or replace function public.direct_entry_has_capability(
  p_app_user_id uuid,
  p_capability text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select false
$function$;

create or replace function public.direct_entry_has_scope(
  p_app_user_id uuid,
  p_scope_kind text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select false
$function$;

create or replace function public.direct_entry_assert_actor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  raise exception 'capability denied' using errcode = '42501';
end;
$function$;

-- =============================================================================
-- SECTION 3: Central Resolver & Actor Session Context
-- =============================================================================

create or replace function public.direct_entry_authz__internal_resolve_effective_grants(
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_result jsonb := '[]'::jsonb;
begin
  if p_app_user_id is null then
    return '[]'::jsonb;
  end if;

  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled or not coalesce(v_user.authz_managed, false) then
    return '[]'::jsonb;
  end if;

  with
  group_bundle_grants as (
    select
      gc.capability,
      case
        when g.is_system_admin then
          case when gc.capability = 'entry_own' then 'OWN'::text else 'ALL'::text end
        when g.team_id is not null then
          case
            when gc.capability in (
              'entry_create',
              'entry_own',
              'submission_create',
              'document_upload',
              'document_view',
              'change_request_create',
              'employment_status.request'
            ) then 'OWN'::text
            else 'CONTEXT_TEAM'::text
          end
        else
          case
            when gc.capability in (
              'entry_create',
              'entry_own',
              'submission_create',
              'document_upload',
              'change_request_create',
              'employment_status.request'
            ) then 'OWN'::text
            when gc.capability = 'document_view' then
              case
                when exists (
                  select 1
                    from public.authz_user_group_capabilities gc2
                   where gc2.group_id = g.group_id
                     and gc2.ended_at is null
                     and gc2.started_at <= v_now
                     and gc2.capability in (
                       'recruiter_master_manage',
                       'team_master_manage',
                       'catalog_master_manage',
                       'audit_view'
                     )
                ) then 'ALL'::text
                else 'OWN'::text
              end
            else 'ALL'::text
          end
      end as scope_kind,
      case
        when g.team_id is not null
             and gc.capability not in (
               'entry_create',
               'entry_own',
               'submission_create',
               'document_upload',
               'document_view',
               'change_request_create',
               'employment_status.request'
             ) then g.team_id::text
        else null::text
      end as scope_id,
      case
        when g.team_id is not null
             and gc.capability not in (
               'entry_create',
               'entry_own',
               'submission_create',
               'document_upload',
               'document_view',
               'change_request_create',
               'employment_status.request'
             ) then 'CONTEXTUAL_ASSIGNMENT'::text
        else 'ROLE_BUNDLE'::text
      end as source_type,
      m.membership_id::text as source_id,
      case
        when g.team_id is not null
             and gc.capability not in (
               'entry_create',
               'entry_own',
               'submission_create',
               'document_upload',
               'document_view',
               'change_request_create',
               'employment_status.request'
             ) then coalesce(t.display_name, t.code)
        when g.is_system_admin then
          case when gc.capability = 'entry_own' then 'OWN'::text else 'ALL'::text end
        when gc.capability in (
          'entry_create',
          'entry_own',
          'submission_create',
          'document_upload',
          'change_request_create',
          'employment_status.request'
        ) then 'OWN'::text
        when gc.capability = 'document_view' then
          case
            when exists (
              select 1
                from public.authz_user_group_capabilities gc2
               where gc2.group_id = g.group_id
                 and gc2.ended_at is null
                 and gc2.started_at <= v_now
                 and gc2.capability in (
                   'recruiter_master_manage',
                   'team_master_manage',
                   'catalog_master_manage',
                   'audit_view'
                 )
            ) then 'ALL'::text
            else 'OWN'::text
          end
        else 'ALL'::text
      end as scope_label
    from public.authz_user_group_members m
    join public.authz_user_groups g
      on g.group_id = m.group_id
     and g.active = true
    join public.organization_departments d
      on d.department_id = g.department_id
     and d.is_active = true
    left join public.teams t
      on t.team_id = g.team_id
     and t.active = true
     and t.code <> '__system_vendor__'
    join public.authz_user_group_capabilities gc
      on gc.group_id = g.group_id
     and gc.ended_at is null
     and gc.started_at <= v_now
    where m.app_user_id = p_app_user_id
      and m.ended_at is null
      and m.started_at <= v_now
      and (g.team_id is null or t.team_id is not null)
  ),
  contextual_tl_grants as (
    select
      rc.capability,
      'CONTEXT_TEAM'::text as scope_kind,
      t.team_id::text as scope_id,
      'CONTEXTUAL_ASSIGNMENT'::text as source_type,
      tla.assignment_id::text as source_id,
      coalesce(t.display_name, t.code) as scope_label
    from public.direct_entry_team_leader_assignments tla
    join public.teams t
      on t.team_id = tla.team_id
     and t.active
     and t.code <> '__system_vendor__'
    join public.authz_role_capabilities rc
      on rc.role_code = 'TEAM_LEADER'
    where tla.leader_app_user_id = p_app_user_id
      and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
  ),
  contextual_tl_wr_review_grants as (
    select
      'report_review'::text as capability,
      'CONTEXT_TEAM'::text as scope_kind,
      t.team_id::text as scope_id,
      'CONTEXTUAL_ASSIGNMENT'::text as source_type,
      tla.assignment_id::text as source_id,
      coalesce(t.display_name, t.code) as scope_label
    from public.direct_entry_team_leader_assignments tla
    join public.teams t
      on t.team_id = tla.team_id
     and t.active
     and t.code <> '__system_vendor__'
    where tla.leader_app_user_id = p_app_user_id
      and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
  ),
  contextual_pa_grants as (
    select
      rc.capability,
      'CONTEXT_PROJECT'::text as scope_kind,
      pa.project_id as scope_id,
      'CONTEXTUAL_ASSIGNMENT'::text as source_type,
      pa.assignment_id::text as source_id,
      coalesce(pr.display_name, pa.project_id) as scope_label
    from public.vendor_finance_project_accountants pa
    join public.direct_entry_projects pr
      on pr.project_id = pa.project_id
     and pr.active
    join public.authz_role_capabilities rc
      on rc.role_code = 'PROJECT_ACCOUNTANT'
    where pa.accountant_user_id = p_app_user_id
      and pa.ended_at is null
      and pa.valid_from <= v_today
      and (pa.valid_to is null or (pa.valid_to > pa.valid_from and v_today < pa.valid_to))
  ),
  all_grants as (
    select * from group_bundle_grants
    union all
    select * from contextual_tl_grants
    union all
    select * from contextual_tl_wr_review_grants
    union all
    select * from contextual_pa_grants
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'capability', g.capability,
        'scope_kind', g.scope_kind,
        'scope_id', g.scope_id,
        'source_type', g.source_type,
        'source_id', g.source_id,
        'scope_label', g.scope_label
      )
      order by g.capability, g.scope_kind, g.scope_id nulls first, g.source_type, g.source_id
    ),
    '[]'::jsonb
  )
    into v_result
    from all_grants g;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

create or replace function public.direct_entry_resolve_actor_context(
  p_auth_subject uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_app_user_id uuid;
  v_enabled boolean;
  v_authz_managed boolean := false;
  v_capabilities jsonb := '[]'::jsonb;
  v_recruiter_links jsonb := '[]'::jsonb;
  v_teams jsonb := '[]'::jsonb;
  v_team_scope_grants jsonb := '[]'::jsonb;
  v_all_scope_grants jsonb := '[]'::jsonb;
  v_review_scopes jsonb := '[]'::jsonb;
  v_team_leader_team_id uuid := null;
  v_allowed_worker_tabs jsonb := '[]'::jsonb;
  v_effective_grants jsonb := '[]'::jsonb;
  v_assigned_roles jsonb := '[]'::jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_has_active_person boolean := false;
  v_is_non_employee boolean := false;
  v_has_tl_effective_grant boolean := false;
begin
  select u.app_user_id, u.enabled, coalesce(u.authz_managed, false)
    into v_app_user_id, v_enabled, v_authz_managed
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject;
  if not found then return null; end if;

  if not v_authz_managed then
    raise exception 'actor account is not authz managed' using errcode = '42501';
  end if;

  if v_enabled then
    v_effective_grants := public.direct_entry_authz__internal_resolve_effective_grants(v_app_user_id);

    with valid_paired_grants as (
      select
        g.capability,
        g.scope_kind,
        g.scope_id
      from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(
        capability text,
        scope_kind text,
        scope_id text
      )
      where (
        (
          g.capability in ('entry_create', 'submission_create', 'employment_status.request')
          and g.scope_kind in ('OWN', 'ALL')
          and g.scope_id is null
        )
        or (
          g.capability = 'entry_own'
          and g.scope_kind = 'OWN'
          and g.scope_id is null
        )
        or (
          g.capability in (
            'entry_team',
            'change_review',
            'report_assign',
            'report_view',
            'report_analytics_view',
            'report_review',
            'report_delegate'
          )
          and (
            (g.scope_kind = 'ALL' and g.scope_id is null)
            or (
              g.scope_kind = 'CONTEXT_TEAM'
              and g.scope_id is not null
              and pg_catalog.btrim(g.scope_id) <> ''
            )
          )
        )
        or (
          g.capability in (
            'entry_admin',
            'employment_status.review',
            'recruiter_master_manage',
            'team_master_manage',
            'audit_view',
            'entry_restore',
            'catalog_master_manage',
            'report_form_manage',
            'vendor_finance_view',
            'vendor_finance_record',
            'duplicate_cccd_withdraw',
            'worker_edit_history_view'
          )
          and g.scope_kind = 'ALL'
          and g.scope_id is null
        )
        or (
          g.capability in ('change_request_create', 'document_upload', 'document_view')
          and (
            (g.scope_kind in ('OWN', 'ALL') and g.scope_id is null)
            or (
              g.scope_kind in ('CONTEXT_TEAM', 'CONTEXT_PROJECT')
              and g.scope_id is not null
              and pg_catalog.btrim(g.scope_id) <> ''
            )
          )
        )
        or (
          g.capability in ('entry_privileged_edit', 'employment_status.apply')
          and (
            (g.scope_kind in ('OWN', 'ALL') and g.scope_id is null)
            or (
              g.scope_kind = 'CONTEXT_TEAM'
              and g.scope_id is not null
              and pg_catalog.btrim(g.scope_id) <> ''
            )
          )
        )
        or (
          g.capability = 'team_manager_assign'
          and g.scope_kind = 'CONTEXT_TEAM'
          and g.scope_id is not null
          and pg_catalog.btrim(g.scope_id) <> ''
        )
      )
    ),
    valid_active_teams as (
      select distinct
        t.team_id,
        t.code,
        t.display_name,
        t.active
      from valid_paired_grants pg
      join public.teams t
        on t.team_id::text = pg.scope_id
       and t.active
       and t.code <> '__system_vendor__'
      where pg.scope_kind = 'CONTEXT_TEAM'
    )
    select
      coalesce((
        select pg_catalog.jsonb_agg(distinct pg.capability order by pg.capability)
          from valid_paired_grants pg
      ), '[]'::jsonb),
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'team_id', vt.team_id,
            'code', vt.code,
            'display', vt.display_name,
            'active', vt.active
          )
          order by vt.team_id
        )
          from valid_active_teams vt
      ), '[]'::jsonb),
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'team_id', vt.team_id,
            'valid_from', v_today::text,
            'valid_to', null
          )
          order by vt.team_id
        )
          from valid_active_teams vt
      ), '[]'::jsonb),
      case
        when exists (
          select 1
            from valid_paired_grants pg
           where pg.scope_kind = 'ALL'
             and pg.scope_id is null
        )
        then pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'valid_from', v_today::text,
            'valid_to', null
          )
        )
        else '[]'::jsonb
      end
    into v_capabilities, v_teams, v_team_scope_grants, v_all_scope_grants;

    select coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'app_user_id', l.app_user_id,
          'recruiter_id', l.recruiter_id,
          'verified', l.verified,
          'valid_from', l.valid_from,
          'valid_to', l.valid_to
        )
        order by l.valid_from, l.recruiter_id
      )
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r
          on r.recruiter_id = l.recruiter_id
         and r.active
       where l.app_user_id = v_app_user_id
         and l.verified
         and l.is_current
    ), '[]'::jsonb)
      into v_recruiter_links;

    select coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'kind', s.kind,
        'team_id', s.team_id,
        'label', s.label
      ) order by case when s.kind = 'all' then 0 else 1 end, s.label, s.team_id)
        from (
          select distinct
            raw_scopes.kind,
            raw_scopes.team_id,
            raw_scopes.label
          from (
            select 'all'::text as kind, null::uuid as team_id, 'Toàn công ty'::text as label
             where exists (
               select 1
                 from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(capability text, scope_kind text, scope_id text)
                where g.capability = 'report_review'
                  and g.scope_kind = 'ALL'
                  and g.scope_id is null
             )
            union all
            select 'team'::text as kind, t.team_id, coalesce(t.display_name, t.code) as label
              from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(capability text, scope_kind text, scope_id text)
              join public.teams t
                on t.team_id::text = g.scope_id
               and t.active
               and t.code <> '__system_vendor__'
             where g.capability = 'report_review'
               and g.scope_kind = 'CONTEXT_TEAM'
               and g.scope_id is not null
               and pg_catalog.btrim(g.scope_id) <> ''
            union all
            select d.scope_kind as kind,
                   case when d.scope_kind = 'team' then d.scope_team_id else null end as team_id,
                   case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end as label
              from public.work_report_delegations d
              left join public.teams tm on tm.team_id = d.scope_team_id
             where d.delegate_app_user_id = v_app_user_id
               and d.capability = 'report_review'
               and d.state = 'ACTIVE'
               and d.is_current
               and statement_timestamp() >= d.effective_from
               and (d.effective_to is null or statement_timestamp() <= d.effective_to)
               and public.work_report__internal_is_delegation_effective(d.delegation_id, statement_timestamp())
          ) raw_scopes
        ) s
    ), '[]'::jsonb)
      into v_review_scopes;

    select exists (
      select 1
        from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(capability text, scope_kind text, scope_id text)
       where g.capability = 'team_manager_assign'
         and g.scope_kind = 'CONTEXT_TEAM'
         and g.scope_id is not null
         and pg_catalog.btrim(g.scope_id) <> ''
    ) into v_has_tl_effective_grant;

    if coalesce(v_has_tl_effective_grant, false) then
      begin
        v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
          p_auth_subject, v_app_user_id, null
        );
      exception when insufficient_privilege then
        v_team_leader_team_id := null;
      end;
    end if;

    select coalesce(
      jsonb_agg(t.tab_id order by t.ord),
      '[]'::jsonb
    )
    into v_allowed_worker_tabs
    from (
      select 'uploader'::text as tab_id, 1 as ord
       where public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'submission_create', 'OWN', null)
          or public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'submission_create', 'ALL', null)
          or public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'recruited'::text as tab_id, 2 as ord
       where (
         select count(*)::integer
           from public.direct_entry_app_user_recruiter_links l
          where l.app_user_id = v_app_user_id
            and l.verified
            and l.is_current
       ) = 1
       and exists (
         select 1
           from public.direct_entry_app_user_recruiter_links l
           join public.recruiters r
             on r.recruiter_id = l.recruiter_id
            and r.active
           join public.direct_entry_app_users u
             on u.app_user_id = l.app_user_id
            and u.enabled
          where l.app_user_id = v_app_user_id
            and l.verified
            and l.is_current
            and not l.suspended_by_account_disable
            and l.valid_from <= v_today
            and (l.valid_to is null or (l.valid_to > l.valid_from and v_today < l.valid_to))
       )
      union all
      select 'managed'::text as tab_id, 3 as ord
       where public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'team'::text as tab_id, 4 as ord
       where v_team_leader_team_id is not null
      union all
      select 'all'::text as tab_id, 5 as ord
       where public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'entry_admin', 'ALL', null)
          or public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'change_review', 'ALL', null)
    ) t;

    v_is_non_employee := public.attendance__internal_is_non_employee_account(v_app_user_id, v_now);

    select exists (
      select 1
        from public.organization_account_person_links l
        join public.organization_persons p on p.person_id = l.person_id and p.status = 'ACTIVE'
       where l.app_user_id = v_app_user_id
         and l.ended_at is null
         and l.started_at <= v_now
    ) into v_has_active_person;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'role_code', ar.role_code,
          'display_name', ar.display_name,
          'assignment_mode', ar.assignment_mode,
          'scope_kind', ar.scope_kind,
          'scope_id', ar.scope_id,
          'assignment_id', ar.assignment_id,
          'is_protected', ar.is_protected,
          'can_revoke', ar.can_revoke,
          'cannot_revoke_reason', ar.cannot_revoke_reason
        )
        order by ar.sort_order, ar.role_code, ar.scope_id nulls first
      ),
      '[]'::jsonb
    )
      into v_assigned_roles
      from (
        select
          case
            when g.is_system_admin then 4
            when g.code = 'HR_CATALOG_OPERATOR' then 3
            when g.code = 'RECRUITER_OPERATIONS' then 2
            else 1
          end as sort_order,
          case
            when g.is_system_admin then 'ADMIN'::text
            when g.code = 'HR_CATALOG_OPERATOR' then 'HR_OPERATOR'::text
            when g.code = 'RECRUITER_OPERATIONS' then 'RECRUITER'::text
          end as role_code,
          g.name as display_name,
          case when g.team_id is not null then 'CONTEXTUAL'::text else 'GLOBAL'::text end as assignment_mode,
          case when g.team_id is not null then 'CONTEXT_TEAM'::text else null::text end as scope_kind,
          g.team_id::text as scope_id,
          m.membership_id::text as assignment_id,
          m.is_protected,
          (not m.is_protected) as can_revoke,
          case when m.is_protected then 'PROTECTED_OWNER_ADMIN' else null end as cannot_revoke_reason
        from public.authz_user_group_members m
        join public.authz_user_groups g
          on g.group_id = m.group_id
         and g.active = true
        join public.organization_departments d
          on d.department_id = g.department_id
         and d.is_active = true
        left join public.teams t
          on t.team_id = g.team_id
         and t.active = true
         and t.code <> '__system_vendor__'
        where m.app_user_id = v_app_user_id
          and m.ended_at is null
          and m.started_at <= v_now
          and (g.team_id is null or t.team_id is not null)
        union all
        select
          5 as sort_order,
          'TEAM_LEADER'::text as role_code,
          'Trưởng nhóm (Team Leader)'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_TEAM'::text as scope_kind,
          t.team_id::text as scope_id,
          tla.assignment_id::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.direct_entry_team_leader_assignments tla
        join public.teams t on t.team_id = tla.team_id and t.active and t.code <> '__system_vendor__'
        where tla.leader_app_user_id = v_app_user_id
          and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
        union all
        select
          6 as sort_order,
          'DEPARTMENT_HEAD'::text as role_code,
          'Trưởng phòng ban'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_DEPARTMENT'::text as scope_kind,
          dh.department_id::text as scope_id,
          dh.head_assignment_id::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.organization_account_person_links apl
        join public.organization_department_heads dh
          on dh.person_id = apl.person_id
         and dh.ended_at is null
         and dh.started_at <= v_now
        join public.organization_departments dm
          on dm.department_id = dh.department_id
         and dm.is_active
        join public.organization_person_department_memberships pm
          on pm.person_id = apl.person_id
         and pm.department_id = dh.department_id
         and pm.ended_at is null
         and pm.started_at <= v_now
        where apl.app_user_id = v_app_user_id
          and apl.ended_at is null
          and apl.started_at <= v_now
          and coalesce(v_has_active_person, false)
          and not v_is_non_employee
        union all
        select
          7 as sort_order,
          'PROJECT_MANAGER'::text as role_code,
          'Quản lý dự án (PM)'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_PROJECT'::text as scope_kind,
          pma.project_id as scope_id,
          pma.assignment_id::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.direct_entry_project_manager_assignments pma
        join public.direct_entry_projects pr on pr.project_id = pma.project_id and pr.active
        join public.recruiters r on r.recruiter_id = pma.manager_recruiter_id and r.active
        join public.direct_entry_app_user_recruiter_links rl
          on rl.recruiter_id = pma.manager_recruiter_id
         and rl.app_user_id = v_app_user_id
         and rl.verified = true
         and rl.is_current = true
         and not rl.suspended_by_account_disable
         and (rl.valid_to is null or v_today < rl.valid_to)
        where pma.is_current = true
          and pma.revoked_at is null
          and (pma.valid_to is null or (pma.valid_to > pma.valid_from and v_today < pma.valid_to))
          and pma.valid_from <= v_today
          and rl.valid_from <= v_today
          and (rl.valid_to > rl.valid_from or rl.valid_to is null)
          and public.direct_entry_actor_is_assigned_project_manager(v_app_user_id, pr.project_id)
        union all
        select
          8 as sort_order,
          'PROJECT_ACCOUNTANT'::text as role_code,
          'Kế toán dự án'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_PROJECT'::text as scope_kind,
          pa.project_id as scope_id,
          pa.assignment_id::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.vendor_finance_project_accountants pa
        join public.direct_entry_projects pr on pr.project_id = pa.project_id and pr.active
        where pa.accountant_user_id = v_app_user_id
          and pa.ended_at is null
          and pa.valid_from <= v_today
          and (pa.valid_to is null or (pa.valid_to > pa.valid_from and v_today < pa.valid_to))
      ) ar
      where ar.role_code is not null;
  end if;

  return (
    select pg_catalog.jsonb_build_object(
      'auth_subject', u.auth_subject,
      'app_user_id', u.app_user_id,
      'display_name', u.display_name,
      'enabled', u.enabled,
      'capabilities', coalesce(v_capabilities, '[]'::jsonb),
      'recruiter_links', coalesce(v_recruiter_links, '[]'::jsonb),
      'teams', coalesce(v_teams, '[]'::jsonb),
      'team_scope_grants', coalesce(v_team_scope_grants, '[]'::jsonb),
      'all_scope_grants', coalesce(v_all_scope_grants, '[]'::jsonb),
      'allowed_worker_tabs', coalesce(v_allowed_worker_tabs, '[]'::jsonb),
      'effective_grants', coalesce(v_effective_grants, '[]'::jsonb),
      'assigned_roles', coalesce(v_assigned_roles, '[]'::jsonb)
    ) || case
      when pg_catalog.jsonb_array_length(v_review_scopes) > 0
        then pg_catalog.jsonb_build_object('effective_report_review_scopes', v_review_scopes)
      else '{}'::jsonb
    end
    from public.direct_entry_app_users u
    where u.app_user_id = v_app_user_id
  );
end;
$function$;

-- =============================================================================
-- SECTION 4: Account & Permission Group Mutations (Stop Mirror Sync & Locks)
-- =============================================================================

create or replace function public.direct_entry_authz_assign_group_member_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_group_id uuid,
  p_expected_account_version integer,
  p_reason text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_op text := 'AUTHZ_GROUP_MEMBER_ASSIGNED';
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_locked_id uuid;
  v_group public.authz_user_groups%rowtype;
  v_target public.direct_entry_app_users%rowtype;
  v_existing_idem public.authz_group_idempotency%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_inserted public.authz_user_group_members%rowtype;
  v_new_version integer;
  v_result jsonb;
begin
  if p_auth_subject is null or p_actor_app_user_id is null then
    raise exception 'AUTHZ_FORBIDDEN' using errcode = '42501';
  end if;
  if p_target_app_user_id is null
     or p_group_id is null
     or p_expected_account_version is null
     or p_expected_account_version < 1
     or p_idempotency_key is null
     or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'AUTHZ_REASON_INVALID' using errcode = '22023';
  end if;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select g.* into v_group
    from public.authz_user_groups g
   where g.group_id = p_group_id
   for share;

  if not found then
    raise exception 'GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not v_group.active then
    raise exception 'GROUP_INACTIVE' using errcode = 'PT409';
  end if;

  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id asc
     for update
  loop
    null;
  end loop;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select i.* into v_existing_idem
    from public.authz_group_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.operation_name = v_op
     and i.target_key = p_target_app_user_id::text || ':' || p_group_id::text
     and i.idempotency_key = p_idempotency_key::text
   for update;

  if found then
    if v_existing_idem.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if v_target.version <> p_expected_account_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_version', v_target.version)::text;
  end if;

  if not v_target.enabled then
    raise exception 'ACCOUNT_DISABLED' using errcode = 'PT409';
  end if;

  if exists (
    select 1
      from public.authz_user_group_members m
     where m.group_id = p_group_id
       and m.app_user_id = p_target_app_user_id
       and m.ended_at is null
  ) then
    raise exception 'GROUP_MEMBER_ALREADY_ASSIGNED' using errcode = 'PT409';
  end if;

  insert into public.authz_user_group_members (
    group_id,
    app_user_id,
    source_kind,
    reason,
    started_at,
    assigned_by_app_user_id,
    is_protected,
    protected_reason,
    created_at
  ) values (
    p_group_id,
    p_target_app_user_id,
    'ADMIN_ASSIGNMENT',
    v_reason,
    v_now,
    p_actor_app_user_id,
    false,
    null,
    v_now
  ) returning * into v_inserted;

  update public.direct_entry_app_users u
     set authz_managed = true,
         version = u.version + 1,
         updated_at = v_now
   where u.app_user_id = p_target_app_user_id
  returning u.version into v_new_version;

  v_result := pg_catalog.jsonb_build_object(
    'membership_id', v_inserted.membership_id,
    'group_id', v_group.group_id,
    'group_code', v_group.code,
    'group_name', v_group.name,
    'account_ref', p_target_app_user_id,
    'account_version', v_new_version,
    'is_protected', v_inserted.is_protected,
    'started_at', public.org_department__internal_iso_utc(v_inserted.started_at),
    'replayed', false
  );

  insert into public.authz_group_audit_events (
    actor_auth_subject, actor_app_user_id, group_id, target_app_user_id,
    membership_id, operation_name, before_payload, after_payload, reason, created_at
  ) values (
    p_auth_subject, p_actor_app_user_id, v_group.group_id, p_target_app_user_id,
    v_inserted.membership_id, v_op,
    pg_catalog.jsonb_build_object('account_version', v_target.version),
    v_result, v_reason, v_now
  );

  insert into public.authz_group_idempotency (
    actor_app_user_id, operation_name, target_key, idempotency_key,
    request_hash, response_payload, created_at
  ) values (
    p_actor_app_user_id, v_op,
    p_target_app_user_id::text || ':' || p_group_id::text,
    p_idempotency_key::text, p_request_hash, v_result, v_now
  );

  return v_result;
end;
$function$;

create or replace function public.direct_entry_authz_remove_group_member_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_membership_id uuid,
  p_expected_account_version integer,
  p_reason text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_op text := 'AUTHZ_GROUP_MEMBER_REMOVED';
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_locked_id uuid;
  v_target public.direct_entry_app_users%rowtype;
  v_membership public.authz_user_group_members%rowtype;
  v_group public.authz_user_groups%rowtype;
  v_existing_idem public.authz_group_idempotency%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_new_version integer;
  v_result jsonb;
begin
  if p_auth_subject is null or p_actor_app_user_id is null then
    raise exception 'AUTHZ_FORBIDDEN' using errcode = '42501';
  end if;
  if p_target_app_user_id is null
     or p_membership_id is null
     or p_expected_account_version is null
     or p_expected_account_version < 1
     or p_idempotency_key is null
     or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'AUTHZ_REASON_INVALID' using errcode = '22023';
  end if;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id asc
     for update
  loop
    null;
  end loop;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select i.* into v_existing_idem
    from public.authz_group_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.operation_name = v_op
     and i.target_key = p_target_app_user_id::text || ':' || p_membership_id::text
     and i.idempotency_key = p_idempotency_key::text
   for update;

  if found then
    if v_existing_idem.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select m.* into v_membership
    from public.authz_user_group_members m
   where m.membership_id = p_membership_id
     and m.app_user_id = p_target_app_user_id
   for update;

  if not found then
    raise exception 'GROUP_MEMBERSHIP_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_membership.is_protected then
    raise exception 'AUTHZ_PROTECTED_ASSIGNMENT' using errcode = 'PT409';
  end if;

  if v_membership.ended_at is not null then
    raise exception 'GROUP_MEMBERSHIP_ALREADY_ENDED' using errcode = 'PT409';
  end if;

  if v_target.version <> p_expected_account_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_version', v_target.version)::text;
  end if;

  select g.* into v_group
    from public.authz_user_groups g
   where g.group_id = v_membership.group_id;

  update public.authz_user_group_members m
     set ended_at = v_now,
         ended_reason = v_reason,
         ended_by_app_user_id = p_actor_app_user_id
   where m.membership_id = p_membership_id;

  update public.direct_entry_app_users u
     set authz_managed = true,
         version = u.version + 1,
         updated_at = v_now
   where u.app_user_id = p_target_app_user_id
  returning u.version into v_new_version;

  v_result := pg_catalog.jsonb_build_object(
    'membership_id', p_membership_id,
    'group_id', v_group.group_id,
    'group_code', v_group.code,
    'group_name', v_group.name,
    'account_ref', p_target_app_user_id,
    'account_version', v_new_version,
    'ended_at', public.org_department__internal_iso_utc(v_now),
    'replayed', false
  );

  insert into public.authz_group_audit_events (
    actor_auth_subject, actor_app_user_id, group_id, target_app_user_id,
    membership_id, operation_name, before_payload, after_payload, reason, created_at
  ) values (
    p_auth_subject, p_actor_app_user_id, v_group.group_id, p_target_app_user_id,
    p_membership_id, v_op,
    pg_catalog.jsonb_build_object(
      'account_version', v_target.version,
      'group_id', v_group.group_id,
      'group_code', v_group.code
    ),
    v_result, v_reason, v_now
  );

  insert into public.authz_group_idempotency (
    actor_app_user_id, operation_name, target_key, idempotency_key,
    request_hash, response_payload, created_at
  ) values (
    p_actor_app_user_id, v_op,
    p_target_app_user_id::text || ':' || p_membership_id::text,
    p_idempotency_key::text, p_request_hash, v_result, v_now
  );

  return v_result;
end;
$function$;

create or replace function public.direct_entry_authz_update_group_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_group_id uuid,
  p_expected_version integer,
  p_name text,
  p_description text,
  p_department_id uuid,
  p_team_id uuid,
  p_active boolean,
  p_capabilities text[],
  p_module_roles jsonb,
  p_reason text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_op text := 'AUTHZ_GROUP_UPDATED';
  v_name text := nullif(pg_catalog.btrim(p_name), '');
  v_desc text := coalesce(pg_catalog.btrim(p_description), '');
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_existing_idem public.authz_group_idempotency%rowtype;
  v_group public.authz_user_groups%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_before jsonb;
  v_new_caps text[];
  v_cap text;
  v_mr jsonb;
  v_mr_module text;
  v_mr_role text;
  v_mr_pairs text[] := array[]::text[];
  v_member_id uuid;
  v_result jsonb;
begin
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  if p_group_id is null
     or p_expected_version is null
     or p_expected_version < 1
     or p_department_id is null
     or p_active is null
     or p_idempotency_key is null
     or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_name is null or pg_catalog.length(v_name) not between 2 and 128 then
    raise exception 'GROUP_NAME_INVALID' using errcode = '22023';
  end if;
  if pg_catalog.length(v_desc) > 500 then
    raise exception 'GROUP_DESCRIPTION_INVALID' using errcode = '22023';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'AUTHZ_REASON_INVALID' using errcode = '22023';
  end if;
  if p_module_roles is not null and pg_catalog.jsonb_typeof(p_module_roles) <> 'array' then
    raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
  end if;

  select g.* into v_group
    from public.authz_user_groups g
   where g.group_id = p_group_id
   for update;

  if not found then
    raise exception 'GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  for v_member_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id = p_actor_app_user_id
        or u.app_user_id in (
          select m.app_user_id
            from public.authz_user_group_members m
           where m.group_id = p_group_id
             and m.ended_at is null
        )
     order by u.app_user_id asc
     for update
  loop
    null;
  end loop;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select i.* into v_existing_idem
    from public.authz_group_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.operation_name = v_op
     and i.target_key = 'group:' || p_group_id::text
     and i.idempotency_key = p_idempotency_key::text
   for update;

  if found then
    if v_existing_idem.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if v_group.version <> p_expected_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_version', v_group.version)::text;
  end if;

  if v_group.is_system_admin then
    raise exception 'GROUP_SYSTEM_ADMIN_IMMUTABLE' using errcode = 'PT409';
  end if;

  if not exists (
    select 1 from public.organization_departments d
     where d.department_id = p_department_id and d.is_active = true
  ) then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = '22023';
  end if;

  if p_team_id is not null and not exists (
    select 1 from public.teams t
     where t.team_id = p_team_id and t.active = true and t.code <> '__system_vendor__'
  ) then
    raise exception 'TEAM_NOT_FOUND' using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'group_id', v_group.group_id,
    'name', v_group.name,
    'description', v_group.description,
    'department_id', v_group.department_id,
    'team_id', v_group.team_id,
    'active', v_group.active,
    'version', v_group.version,
    'capabilities', coalesce((
      select pg_catalog.jsonb_agg(gc.capability order by gc.capability asc)
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id and gc.ended_at is null
    ), '[]'::jsonb),
    'module_roles', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('module_code', mr.module_code, 'role_code', mr.role_code)
        order by mr.module_code asc, mr.role_code asc
      )
        from public.authz_user_group_module_roles mr
       where mr.group_id = p_group_id and mr.ended_at is null
    ), '[]'::jsonb)
  );

  update public.authz_user_groups g
     set name = v_name,
         description = v_desc,
         department_id = p_department_id,
         team_id = p_team_id,
         active = p_active,
         version = g.version + 1,
         updated_by_app_user_id = p_actor_app_user_id,
         updated_at = v_now
   where g.group_id = p_group_id
  returning * into v_group;

  v_new_caps := coalesce(
    array(
      select distinct nullif(pg_catalog.btrim(x), '')
        from unnest(coalesce(p_capabilities, array[]::text[])) as x
       where nullif(pg_catalog.btrim(x), '') is not null
       order by 1 asc
    ),
    array[]::text[]
  );

  update public.authz_user_group_capabilities gc
     set ended_at = v_now,
         ended_by_app_user_id = p_actor_app_user_id
   where gc.group_id = p_group_id
     and gc.ended_at is null
     and not (gc.capability = any(v_new_caps));

  foreach v_cap in array v_new_caps loop
    insert into public.authz_user_group_capabilities (
      group_id, capability, started_at, granted_by_app_user_id, reason, created_at
    ) values (
      p_group_id, v_cap, v_now, p_actor_app_user_id, v_reason, v_now
    )
    on conflict (group_id, capability) where ended_at is null do nothing;
  end loop;

  if p_team_id is not null then
    if exists (
      select 1
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id
         and gc.ended_at is null
         and gc.capability not in (
           'entry_team', 'team_manager_assign', 'change_review',
           'report_view', 'report_analytics_view', 'report_assign',
           'report_review', 'report_delegate', 'worker_edit_history_view',
           'entry_create', 'entry_own', 'submission_create',
           'document_upload', 'document_view', 'change_request_create',
           'employment_status.request'
         )
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP' using errcode = '22023';
    end if;
  else
    if exists (
      select 1
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id
         and gc.ended_at is null
         and gc.capability in (
           'entry_admin', 'entry_team', 'entry_restore', 'entry_privileged_edit',
           'change_review', 'employment_status.review', 'employment_status.apply',
           'team_manager_assign', 'report_view', 'report_analytics_view', 'vendor_finance_record'
         )
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_DEPARTMENT_GROUP' using errcode = '22023';
    end if;
  end if;

  if p_module_roles is not null then
    for v_mr in
      select value from pg_catalog.jsonb_array_elements(p_module_roles)
    loop
      if pg_catalog.jsonb_typeof(v_mr) <> 'object' then
        raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
      end if;
      v_mr_module := nullif(pg_catalog.btrim(v_mr->>'module_code'), '');
      v_mr_role := nullif(pg_catalog.btrim(v_mr->>'role_code'), '');
      if v_mr_module is null or v_mr_role is null then
        raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
      end if;
      v_mr_pairs := array_append(v_mr_pairs, v_mr_module || ':' || v_mr_role);
    end loop;
  end if;

  update public.authz_user_group_module_roles mr
     set ended_at = v_now,
         ended_by_app_user_id = p_actor_app_user_id
   where mr.group_id = p_group_id
     and mr.ended_at is null
     and not ((mr.module_code || ':' || mr.role_code) = any(v_mr_pairs));

  if p_module_roles is not null then
    for v_mr in
      select value from pg_catalog.jsonb_array_elements(p_module_roles)
    loop
      v_mr_module := nullif(pg_catalog.btrim(v_mr->>'module_code'), '');
      v_mr_role := nullif(pg_catalog.btrim(v_mr->>'role_code'), '');
      insert into public.authz_user_group_module_roles (
        group_id, module_code, role_code, started_at, granted_by_app_user_id, reason, created_at
      ) values (
        p_group_id, v_mr_module, v_mr_role, v_now, p_actor_app_user_id, v_reason, v_now
      )
      on conflict (group_id, module_code, role_code) where ended_at is null do nothing;
    end loop;
  end if;

  if p_team_id is not null and exists (
    select 1
      from public.authz_user_group_module_roles mr
     where mr.group_id = p_group_id and mr.ended_at is null
  ) then
    raise exception 'GROUP_MODULE_ROLE_FORBIDDEN_FOR_TEAM_GROUP' using errcode = '22023';
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'group_id', v_group.group_id,
    'code', v_group.code,
    'name', v_group.name,
    'description', v_group.description,
    'department_id', v_group.department_id,
    'team_id', v_group.team_id,
    'is_system_admin', v_group.is_system_admin,
    'active', v_group.active,
    'version', v_group.version,
    'capabilities', coalesce((
      select pg_catalog.jsonb_agg(gc.capability order by gc.capability asc)
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id and gc.ended_at is null
    ), '[]'::jsonb),
    'module_roles', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('module_code', mr.module_code, 'role_code', mr.role_code)
        order by mr.module_code asc, mr.role_code asc
      )
        from public.authz_user_group_module_roles mr
       where mr.group_id = p_group_id and mr.ended_at is null
    ), '[]'::jsonb),
    'replayed', false
  );

  insert into public.authz_group_audit_events (
    actor_auth_subject, actor_app_user_id, group_id, operation_name,
    before_payload, after_payload, reason, created_at
  ) values (
    p_auth_subject, p_actor_app_user_id, p_group_id, v_op,
    v_before, v_result, v_reason, v_now
  );

  insert into public.authz_group_idempotency (
    actor_app_user_id, operation_name, target_key, idempotency_key,
    request_hash, response_payload, created_at
  ) values (
    p_actor_app_user_id, v_op, 'group:' || p_group_id::text, p_idempotency_key::text,
    p_request_hash, v_result, v_now
  );

  return v_result;
end;
$function$;

create or replace function public.direct_entry_account_operation_finalize_create(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_intent_id uuid,
  p_intent_token uuid,
  p_created_auth_subject uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'account_created';
  v_intent public.direct_entry_account_operation_intents;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_app_user public.direct_entry_app_users;
  v_revision_id uuid;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_created_auth_subject is null or p_intent_id is null or p_intent_token is null then
    raise exception 'intent, token and auth subject required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'intent_id', p_intent_id, 'intent_token', p_intent_token,
    'auth_subject', p_created_auth_subject
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_intent := public.direct_entry_lock_account_operation(p_intent_id);
  if v_intent.kind <> 'CREATE_ACCOUNT' then
    raise exception 'account operation kind mismatch' using errcode = '22023';
  end if;

  if v_intent.state in ('APPLIED', 'FAILED', 'EXPIRED', 'BLOCKED', 'CONFLICT') then
    v_prior := jsonb_build_object(
      'intent_id', v_intent.intent_id,
      'intent_state', v_intent.state,
      'account_ref', v_intent.account_ref
    );
    perform public.direct_entry_idempotency_finish(
      p_actor_app_user_id, v_action, p_idempotency_key, v_prior
    );
    return v_prior;
  end if;
  if v_intent.state not in ('IN_FLIGHT', 'INDETERMINATE') then
    raise exception 'account operation is not claimable' using errcode = '22023';
  end if;

  if v_intent.intent_token <> p_intent_token then
    update public.direct_entry_account_operation_intents
       set state = 'BLOCKED', resolved_at = now(), updated_at = now()
     where intent_id = p_intent_id;
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, denial_code, reason_id
    ) values (
      p_auth_subject, p_actor_app_user_id, 'account_operation_finish', 'entry_admin',
      p_intent_id::text, 'all', 'REJECTED', 'provenance_mismatch', v_intent.reason_id
    );
    v_prior := jsonb_build_object(
      'intent_id', p_intent_id, 'intent_state', 'BLOCKED', 'account_ref', null
    );
    perform public.direct_entry_idempotency_finish(
      p_actor_app_user_id, v_action, p_idempotency_key, v_prior
    );
    return v_prior;
  end if;

  v_reason_id := v_intent.reason_id;
  insert into public.direct_entry_app_users (auth_subject, enabled, display_name, authz_managed)
  values (p_created_auth_subject, true, v_intent.display_name, true)
  returning * into v_app_user;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    v_app_user.app_user_id, v_app_user.version, p_actor_app_user_id, v_action,
    null, jsonb_build_object('display_name', v_app_user.display_name, 'enabled', true), v_reason_id
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
    v_app_user.app_user_id::text, 'all', 'APPLIED', v_reason_id,
    array['auth_subject', 'enabled', 'display_name'], v_revision_id
  );

  update public.direct_entry_account_operation_intents
     set state = 'APPLIED', resolved_at = now(), updated_at = now(),
         auth_subject = p_created_auth_subject,
         account_ref = v_app_user.app_user_id
   where intent_id = p_intent_id;

  v_prior := jsonb_build_object(
    'app_user_id', v_app_user.app_user_id,
    'auth_subject', v_app_user.auth_subject,
    'display_name', v_app_user.display_name,
    'version', v_app_user.version,
    'revision_id', v_revision_id,
    'intent_id', p_intent_id,
    'intent_state', 'APPLIED'
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_prior
  );
  return v_prior;
end;
$function$;

create or replace function public.direct_entry_account_operation_link_recruiter(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_recruiter_id uuid,
  p_expected_recruiter_version integer,
  p_account_ref uuid,
  p_expected_account_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'account_recruiter_link_create';
  v_today date := public.direct_entry_authorization_date();
  v_lock_key text;
  v_account public.direct_entry_app_users%rowtype;
  v_recruiter public.recruiters%rowtype;
  v_acct_person_id uuid := null;
  v_rec_person_id uuid := null;
  v_target_person_id uuid := null;
  v_current_acct_person_id uuid := null;
  v_current_rec_person_id uuid := null;
  v_lock_person_id uuid;
  v_lock_id uuid;
  v_locked_person_ids uuid[];
  v_locked_dept_ids uuid[];
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_locked_team_ids uuid[];
  v_acct_person public.organization_persons%rowtype;
  v_rec_person public.organization_persons%rowtype;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_login_id text;
  v_code text;
  v_payload_hash text;
  v_prior_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_link_id uuid;
  v_capability text;
  v_prev_grants jsonb;
  v_after_grants jsonb;
  v_prev_caps text[];
  v_had_own_scope boolean;
  v_app_user_revision_id uuid;
  v_now timestamptz;
  v_result jsonb;
  v_auto_reason text;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if p_recruiter_id is null
     or p_expected_recruiter_version is null
     or p_expected_recruiter_version < 1 then
    raise exception 'personnel reference or version invalid' using errcode = '22023';
  end if;
  if p_account_ref is null
     or p_expected_account_version is null
     or p_expected_account_version < 1 then
    raise exception 'account reference or version invalid' using errcode = '22023';
  end if;
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'recruiter_id', p_recruiter_id,
    'expected_recruiter_version', p_expected_recruiter_version,
    'account_ref', p_account_ref,
    'expected_account_version', p_expected_account_version,
    'reason', p_reason
  ));
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = v_action
     and i.idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  select l.person_id
    into v_acct_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_account_ref
     and l.ended_at is null
   limit 1;

  select p.person_id
    into v_rec_person_id
    from public.organization_persons p
   where p.recruiter_id = p_recruiter_id
   limit 1;

  select coalesce(array_agg(distinct pid order by pid), array[]::uuid[])
    into v_locked_person_ids
    from unnest(array[v_acct_person_id, v_rec_person_id]) as t(pid)
   where pid is not null;

  foreach v_lock_person_id in array v_locked_person_ids loop
    perform public.org_department__internal_lock_person(v_lock_person_id);
  end loop;

  if cardinality(v_locked_person_ids) > 0 then
    for v_lock_person_id in
      select p.person_id
        from public.organization_persons p
       where p.person_id = any(v_locked_person_ids)
       order by p.person_id asc
       for update
    loop
      if v_lock_person_id = v_acct_person_id then
        select p.* into v_acct_person from public.organization_persons p where p.person_id = v_acct_person_id;
      end if;
      if v_lock_person_id = v_rec_person_id then
        select p.* into v_rec_person from public.organization_persons p where p.person_id = v_rec_person_id;
      end if;
    end loop;

    select coalesce(array_agg(distinct m.department_id order by m.department_id), array[]::uuid[])
      into v_locked_dept_ids
      from public.organization_person_department_memberships m
     where m.person_id = any(v_locked_person_ids)
       and m.ended_at is null;

    foreach v_lock_id in array v_locked_dept_ids loop
      perform public.org_department__internal_lock_department(v_lock_id);
    end loop;

    if cardinality(v_locked_dept_ids) > 0 then
      perform d.department_id
        from public.organization_departments d
       where d.department_id = any(v_locked_dept_ids)
       order by d.department_id asc
       for update;

      perform m.membership_id
        from public.organization_person_department_memberships m
       where m.person_id = any(v_locked_person_ids)
         and m.ended_at is null
       order by m.membership_id asc
       for update;
    end if;
  else
    v_locked_dept_ids := array[]::uuid[];
  end if;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select p_account_ref as uid
      union
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.recruiter_id = p_recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  foreach v_lock_id in array v_locked_user_ids loop
    perform public.org_department__internal_lock_app_user(v_lock_id);
  end loop;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_actor_app_user_id as uid
      union all
      select unnest(v_locked_user_ids) as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = any(v_locked_user_ids) then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for share;
    end if;
  end loop;

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select p_recruiter_id as rid
      union
      select v_acct_person.recruiter_id as rid
      union
      select rl.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = any(v_locked_user_ids)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = any(v_locked_user_ids)
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) s
   where rid is not null;

  perform r.recruiter_id
    from public.recruiters r
   where r.recruiter_id = any(v_locked_recruiter_ids)
   order by r.recruiter_id asc
   for update;

  select r.* into v_recruiter
    from public.recruiters r
   where r.recruiter_id = p_recruiter_id;
  if not found then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct tid order by tid), array[]::uuid[])
    into v_locked_team_ids
    from (
      select m.team_id as tid
        from public.recruiter_team_memberships m
       where m.recruiter_id = any(v_locked_recruiter_ids)
         and (m.is_current = true or m.valid_to is null or m.valid_to >= v_today)
      union
      select a.team_id as tid
        from public.direct_entry_team_leader_assignments a
       where (a.leader_recruiter_id = any(v_locked_recruiter_ids) or a.leader_app_user_id = any(v_locked_user_ids))
         and (a.is_current = true or a.suspended_by_account_disable = true or a.valid_to is null or a.valid_to >= v_today)
    ) s
   where tid is not null;

  if cardinality(v_locked_team_ids) > 0 then
    perform t.team_id
      from public.teams t
     where t.team_id = any(v_locked_team_ids)
     order by t.team_id asc
     for update;
  end if;

  select l.person_id
    into v_current_acct_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_account_ref
     and l.ended_at is null
   limit 1;

  select p.person_id
    into v_current_rec_person_id
    from public.organization_persons p
   where p.recruiter_id = p_recruiter_id
   limit 1;

  if v_current_acct_person_id is distinct from v_acct_person_id
     or v_current_rec_person_id is distinct from v_rec_person_id then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = any(v_locked_user_ids)
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.recruiter_id = any(v_locked_recruiter_ids))
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.recruiter_id = p_recruiter_id
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where (a.leader_app_user_id = any(v_locked_user_ids) or a.leader_recruiter_id = any(v_locked_recruiter_ids))
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and (
         not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
         or not (a.team_id = any(v_locked_team_ids))
       )
  ) or exists (
    select 1
      from public.recruiter_team_memberships m
     where m.recruiter_id = any(v_locked_recruiter_ids)
       and (m.is_current = true or m.valid_to is null or m.valid_to >= v_today)
       and not (m.team_id = any(v_locked_team_ids))
  ) then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

  -- Tier 5 Canonical Child Locks (RPM -> RTM -> URL -> TLA)
  perform m.membership_id
    from public.recruiter_provider_memberships m
   where m.recruiter_id = any(v_locked_recruiter_ids)
   order by m.membership_id asc
   for update;

  for v_lock_key in
    select 'provider:' || rid::text as k
      from unnest(v_locked_recruiter_ids) as rid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform m.membership_id
    from public.recruiter_team_memberships m
   where m.recruiter_id = any(v_locked_recruiter_ids)
   order by m.membership_id asc
   for update;

  for v_lock_key in
    select 'team-membership:' || rid::text as k
      from unnest(v_locked_recruiter_ids) as rid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_locked_user_ids)
      or l.recruiter_id = any(v_locked_recruiter_ids)
   order by l.link_id asc
   for update;

  for v_lock_key in
    select distinct 'recruiter-link:' || uid::text as k
      from unnest(v_locked_user_ids) as uid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  for v_lock_key in
    select distinct 'recruiter-link-recruiter:' || rid::text as k
      from unnest(v_locked_recruiter_ids) as rid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform a.assignment_id
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = any(v_locked_user_ids)
      or a.leader_recruiter_id = any(v_locked_recruiter_ids)
      or a.team_id = any(v_locked_team_ids)
   order by a.assignment_id asc
   for update;

  if not exists (
    select 1
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter.recruiter_id
       and m.provider_type = 'hrp'
       and m.vendor_id is null
       and (m.is_current or (not v_recruiter.active and m.valid_to is null
         and (select count(*) from public.recruiter_provider_memberships x
               where x.recruiter_id = v_recruiter.recruiter_id and x.valid_to is null) = 1))
  ) then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;

  if v_acct_person.person_id is not null and v_rec_person.person_id is not null
     and v_acct_person.person_id <> v_rec_person.person_id then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;
  if v_acct_person.person_id is not null and v_acct_person.recruiter_id is not null
     and v_acct_person.recruiter_id <> p_recruiter_id then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;
  if v_acct_person.person_id is null and v_rec_person.person_id is not null
     and exists (
       select 1
         from public.organization_account_person_links l
        where l.person_id = v_rec_person.person_id
          and l.ended_at is null
          and l.app_user_id <> p_account_ref
     ) then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;
  if v_recruiter.version <> p_expected_recruiter_version then
    raise exception 'personnel version conflict' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_target_person_id := coalesce(v_acct_person.person_id, v_rec_person.person_id);

  if v_target_person_id is not null
     and public.org_department__internal_subject_has_blocking_team_assignment(
       v_locked_recruiter_ids,
       v_locked_user_ids,
       v_today
     )
     and not public.org_department__internal_person_is_active_in_org(v_target_person_id, v_now) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT' using errcode = 'PT409';
  end if;

  if not v_account.enabled then
    raise exception 'account is not enabled' using errcode = '23514';
  end if;
  if not v_recruiter.active then
    raise exception 'personnel is not active' using errcode = '23514';
  end if;

  select count(*)::int,
         count(*) filter (where m.provider_type = 'hrp' and m.vendor_id is null)::int
    into v_provider_count, v_hrp_provider_count
    from public.recruiter_provider_memberships m
   where m.recruiter_id = p_recruiter_id
     and m.is_current;
  if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
    raise exception 'personnel requires an active HRP provider membership' using errcode = '23514';
  end if;

  if v_recruiter.personnel_position is not null
     and v_recruiter.personnel_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '23514';
  end if;

  v_code := lower(nullif(btrim(coalesce(v_recruiter.personnel_code, '')), ''));
  if v_code is null or not public.direct_entry_is_canonical_login_id(v_code) then
    raise exception 'personnel code is missing or not canonical for account linking' using errcode = '22023';
  end if;

  select lower(nullif(btrim(split_part(au.email, pg_catalog.chr(64), 1)), ''))
    into v_login_id
    from auth.users au
   where au.id = v_account.auth_subject;
  if v_login_id is null
     or not public.direct_entry_is_canonical_login_id(v_login_id)
     or v_login_id <> v_code then
    raise exception 'personnel code does not match account login ID' using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_account_ref
       and l.verified
       and (l.is_current or l.valid_to is null or l.valid_to > v_today)
  ) then
    raise exception 'account already has an effective recruiter link' using errcode = '23P01';
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_recruiter_id
       and l.verified
       and (l.is_current or l.valid_to is null or l.valid_to > v_today)
  ) then
    raise exception 'personnel already has an effective account link' using errcode = '23P01';
  end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  insert into public.direct_entry_app_user_recruiter_links (
    app_user_id, recruiter_id, verified, valid_from, is_current
  ) values (
    p_account_ref, p_recruiter_id, true, v_today, true
  ) returning link_id into v_link_id;

  v_prev_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_account_ref);

  select coalesce(array_agg(distinct g.capability), array[]::text[])
    into v_prev_caps
    from pg_catalog.jsonb_to_recordset(v_prev_grants) as g(capability text);

  select exists (
    select 1
      from pg_catalog.jsonb_to_recordset(v_prev_grants) as g(scope_kind text, scope_id text)
     where g.scope_kind = 'OWN'
       and g.scope_id is null
  ) into v_had_own_scope;

  v_auto_reason := left(coalesce(p_reason, 'Auto-granted upon recruiter account link'), 500);
  if pg_catalog.length(pg_catalog.btrim(v_auto_reason)) < 3 then
    v_auto_reason := 'Auto-granted upon recruiter account link';
  end if;

  insert into public.authz_user_group_members (
    group_id, app_user_id, source_kind, reason, started_at, assigned_by_app_user_id, is_protected, protected_reason
  )
  select
    g.group_id, p_account_ref, 'ADMIN_ASSIGNMENT', v_auto_reason, v_now, p_actor_app_user_id, false, null
    from public.authz_user_groups g
   where g.code = 'RECRUITER_OPERATIONS'
     and g.active = true
  on conflict (group_id, app_user_id) where ended_at is null do nothing;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = v_now,
         authz_managed = true
   where app_user_id = p_account_ref
  returning version, authz_managed into v_account.version, v_account.authz_managed;

  v_after_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_account_ref);

  if not v_had_own_scope
     and exists (
       select 1
         from pg_catalog.jsonb_to_recordset(v_after_grants) as g(scope_kind text, scope_id text)
        where g.scope_kind = 'OWN'
          and g.scope_id is null
     ) then
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_actor_app_user_id, 'scope_default_grant', 'entry_own',
      p_account_ref::text, 'own', 'APPLIED', v_reason_id, array['scope_kind', 'valid_from', 'valid_to']
    );
  end if;

  foreach v_capability in array array[
    'entry_create', 'entry_own', 'submission_create', 'change_request_create',
    'employment_status.request', 'document_upload', 'document_view'
  ]::text[]
  loop
    if not (v_capability = any(v_prev_caps))
       and exists (
         select 1
           from pg_catalog.jsonb_to_recordset(v_after_grants) as g(capability text)
          where g.capability = v_capability
       ) then
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
      ) values (
        p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
        p_account_ref::text, 'APPLIED', v_reason_id, array['valid_from', 'valid_to']
      );
    end if;
  end loop;

  if v_acct_person.person_id is not null and v_acct_person.recruiter_id is null then
    update public.organization_persons
       set recruiter_id = p_recruiter_id,
           version = v_acct_person.version + 1,
           updated_at = v_now,
           updated_by_app_user_id = p_actor_app_user_id
     where person_id = v_acct_person.person_id;
  end if;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_account_ref,
    v_account.version,
    p_actor_app_user_id,
    'link_create',
    jsonb_build_object('recruiter_id', null),
    jsonb_build_object('recruiter_id', v_recruiter.recruiter_id),
    v_reason_id
  ) returning revision_id into v_app_user_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, 'link_create', 'entry_admin', p_account_ref::text,
    'all', 'APPLIED', v_reason_id, array['recruiter_link'], v_app_user_revision_id
  );

  v_result := jsonb_build_object(
    'link_id', v_link_id,
    'app_user_id', p_account_ref,
    'app_user_version', v_account.version,
    'app_user_revision_id', v_app_user_revision_id,
    'recruiter_id', v_recruiter.recruiter_id,
    'recruiter_version', v_recruiter.version,
    'personnel_code', v_recruiter.personnel_code,
    'valid_from', v_today
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_account_operation_create_personnel(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_account_ref uuid,
  p_expected_account_version integer,
  p_personnel_code text,
  p_personnel_position text,
  p_valid_from date,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'personnel_created';
  v_code text := lower(btrim(p_personnel_code));
  v_login_id text;
  v_position text := p_personnel_position;
  v_account public.direct_entry_app_users;
  v_linked_person_id uuid := null;
  v_current_linked_person_id uuid := null;
  v_linked_dept_id uuid := null;
  v_current_linked_dept_id uuid := null;
  v_related_recruiter_ids uuid[];
  v_tla_team_ids uuid[];
  v_lock_id uuid;
  v_all_user_ids uuid[];
  v_lock_key text;
  v_person public.organization_persons;
  v_payload_hash text;
  v_prior_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_recruiter public.recruiters;
  v_membership_id uuid;
  v_link_id uuid;
  v_personnel_revision_id uuid;
  v_app_user_revision_id uuid;
  v_result jsonb;
  v_capability text;
  v_today date := public.direct_entry_authorization_date();
  v_valid_from date;
  v_now timestamptz;
  v_prev_grants jsonb;
  v_after_grants jsonb;
  v_prev_caps text[];
  v_had_own_scope boolean;
  v_auto_reason text;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_account_ref is null or p_expected_account_version is null or p_expected_account_version < 1 then
    raise exception 'account reference or version invalid' using errcode = '22023';
  end if;
  if v_code is null or not public.direct_entry_is_canonical_login_id(v_code) then
    raise exception 'personnel code must be the account login ID' using errcode = '22023';
  end if;
  if v_position is null or v_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'account_ref', p_account_ref, 'expected_account_version', p_expected_account_version,
    'personnel_code', v_code, 'personnel_position', v_position,
    'valid_from', p_valid_from, 'reason', p_reason
  ));
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = v_action
     and i.idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  select l.person_id
    into v_linked_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_account_ref
     and l.ended_at is null
   limit 1;

  if v_linked_person_id is not null then
    perform public.org_department__internal_lock_person(v_linked_person_id);
    select p.*
      into v_person
      from public.organization_persons p
     where p.person_id = v_linked_person_id
     for update;

    select m.department_id
      into v_linked_dept_id
      from public.organization_person_department_memberships m
     where m.person_id = v_linked_person_id
       and m.ended_at is null
     limit 1;

    if v_linked_dept_id is not null then
      perform public.org_department__internal_lock_department(v_linked_dept_id);
      perform d.department_id
        from public.organization_departments d
       where d.department_id = v_linked_dept_id
       for update;

      perform m.membership_id
        from public.organization_person_department_memberships m
       where m.person_id = v_linked_person_id
         and m.ended_at is null
       order by m.membership_id asc
       for update;
    end if;
  end if;

  perform public.org_department__internal_lock_app_user(p_account_ref);

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_actor_app_user_id as uid
      union all
      select p_account_ref as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = p_account_ref then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for share;
    end if;
  end loop;

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_valid_from := coalesce(p_valid_from, v_today);
  if v_valid_from <> v_today then
    raise exception 'provider valid from is invalid' using errcode = '22023';
  end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref;
  if not found then raise exception 'account not found' using errcode = 'P0002'; end if;

  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_related_recruiter_ids
    from (
      select v_person.recruiter_id as rid
      union
      select rl.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = p_account_ref
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_account_ref
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) rids
   where rid is not null;

  select coalesce(array_agg(distinct tid order by tid), array[]::uuid[])
    into v_tla_team_ids
    from (
      select a.team_id as tid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_account_ref
          or a.leader_recruiter_id = any(v_related_recruiter_ids)
      union
      select m.team_id as tid
        from public.recruiter_team_memberships m
       where m.recruiter_id = any(v_related_recruiter_ids)
    ) tids
   where tid is not null;

  if cardinality(v_related_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_related_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  if cardinality(v_tla_team_ids) > 0 then
    perform t.team_id
      from public.teams t
     where t.team_id = any(v_tla_team_ids)
     order by t.team_id asc
     for update;
  end if;

  -- Phase 2: Tier 5 Canonical Child Locks (RPM -> RTM -> URL -> TLA)
  if cardinality(v_related_recruiter_ids) > 0 then
    perform m.membership_id
      from public.recruiter_provider_memberships m
     where m.recruiter_id = any(v_related_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'provider:' || rid::text as k
        from unnest(v_related_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    perform m.membership_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = any(v_related_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'team-membership:' || rid::text as k
        from unnest(v_related_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;
  end if;

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_account_ref
      or (cardinality(v_related_recruiter_ids) > 0 and l.recruiter_id = any(v_related_recruiter_ids))
   order by l.link_id asc
   for update;

  perform pg_advisory_xact_lock(hashtextextended('recruiter-link:' || p_account_ref::text, 0));
  for v_lock_key in
    select 'recruiter-link-recruiter:' || rid::text as k
      from unnest(coalesce(v_related_recruiter_ids, array[]::uuid[])) as rid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform a.assignment_id
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = p_account_ref
      or (cardinality(v_related_recruiter_ids) > 0 and a.leader_recruiter_id = any(v_related_recruiter_ids))
      or (cardinality(v_tla_team_ids) > 0 and a.team_id = any(v_tla_team_ids))
   order by a.assignment_id asc
   for update;

  select l.person_id
    into v_current_linked_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_account_ref
     and l.ended_at is null
   limit 1;

  if v_current_linked_person_id is distinct from v_linked_person_id then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;

  if v_linked_person_id is not null then
    select m.department_id
      into v_current_linked_dept_id
      from public.organization_person_department_memberships m
     where m.person_id = v_linked_person_id
       and m.ended_at is null
     limit 1;

    if v_current_linked_dept_id is distinct from v_linked_dept_id then
      raise exception 'app user version conflict' using errcode = 'PT409';
    end if;
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = p_account_ref
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.recruiter_id = any(v_related_recruiter_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id = p_account_ref
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and (
         not (a.leader_recruiter_id = any(v_related_recruiter_ids))
         or not (a.team_id = any(v_tla_team_ids))
       )
  ) then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;

  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;
  if v_person.person_id is not null and v_person.recruiter_id is not null then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();

  if v_person.person_id is not null
     and public.org_department__internal_subject_has_blocking_team_assignment(
       case when v_person.recruiter_id is not null then array[v_person.recruiter_id] else array[]::uuid[] end,
       array[p_account_ref],
       v_today
     )
     and not public.org_department__internal_person_is_active_in_org(v_person.person_id, v_now) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT' using errcode = 'PT409';
  end if;

  if not v_account.enabled then raise exception 'account is not enabled' using errcode = '23514'; end if;

  select lower(nullif(split_part(u.email, pg_catalog.chr(64), 1), '')) into v_login_id
    from auth.users u where u.id = v_account.auth_subject;
  if v_login_id is null or not public.direct_entry_is_canonical_login_id(v_login_id)
     or v_code <> v_login_id then
    raise exception 'personnel code does not match account login ID' using errcode = '22023';
  end if;
  if lower(btrim(v_account.display_name)) = v_login_id then
    raise exception 'account real name must be updated before personnel creation' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_account_ref and l.verified
       and l.is_current
  ) then raise exception 'account already has an effective recruiter link' using errcode = '23514'; end if;
  if exists (
    select 1 from public.recruiters r
     where r.personnel_code is not null
       and lower(public.recruitment_dimension_key(r.personnel_code))
           = lower(public.recruitment_dimension_key(v_code))
  ) then raise exception 'personnel code already exists' using errcode = '23505'; end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);
  insert into public.recruiters (display_name, personnel_code, personnel_position, active, version)
  values (v_account.display_name, v_code, v_position, true, 1)
  returning * into v_recruiter;
  insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, vendor_id, is_current)
  values (v_recruiter.recruiter_id, 'hrp', v_valid_from, null, true)
  returning membership_id into v_membership_id;
  insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
  values (p_account_ref, v_recruiter.recruiter_id, true, v_valid_from, true)
  returning link_id into v_link_id;

  v_prev_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_account_ref);

  select coalesce(array_agg(distinct g.capability), array[]::text[])
    into v_prev_caps
    from pg_catalog.jsonb_to_recordset(v_prev_grants) as g(capability text);

  select exists (
    select 1
      from pg_catalog.jsonb_to_recordset(v_prev_grants) as g(scope_kind text, scope_id text)
     where g.scope_kind = 'OWN'
       and g.scope_id is null
  ) into v_had_own_scope;

  v_auto_reason := left(coalesce(p_reason, 'Auto-granted upon personnel creation'), 500);
  if pg_catalog.length(pg_catalog.btrim(v_auto_reason)) < 3 then
    v_auto_reason := 'Auto-granted upon personnel creation';
  end if;

  insert into public.authz_user_group_members (
    group_id, app_user_id, source_kind, reason, started_at, assigned_by_app_user_id, is_protected, protected_reason
  )
  select
    g.group_id, p_account_ref, 'ADMIN_ASSIGNMENT', v_auto_reason, v_now, p_actor_app_user_id, false, null
    from public.authz_user_groups g
   where g.code = 'RECRUITER_OPERATIONS'
     and g.active = true
  on conflict (group_id, app_user_id) where ended_at is null do nothing;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = v_now,
         authz_managed = true
   where app_user_id = p_account_ref
  returning version, authz_managed into v_account.version, v_account.authz_managed;

  v_after_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_account_ref);

  foreach v_capability in array array[
    'entry_create', 'entry_own', 'submission_create', 'change_request_create',
    'employment_status.request', 'document_upload', 'document_view'
  ]::text[]
  loop
    if not (v_capability = any(v_prev_caps))
       and exists (
         select 1
           from pg_catalog.jsonb_to_recordset(v_after_grants) as g(capability text)
          where g.capability = v_capability
       ) then
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
      ) values (
        p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
        p_account_ref::text, 'APPLIED', v_reason_id, array['valid_from', 'valid_to']
      );
    end if;
  end loop;

  if not v_had_own_scope
     and exists (
       select 1
         from pg_catalog.jsonb_to_recordset(v_after_grants) as g(scope_kind text, scope_id text)
        where g.scope_kind = 'OWN'
          and g.scope_id is null
     ) then
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_actor_app_user_id, 'scope_default_grant', 'entry_own',
      p_account_ref::text, 'own', 'APPLIED', v_reason_id, array['scope_kind', 'valid_from', 'valid_to']
    );
  end if;

  if v_person.person_id is not null and v_person.recruiter_id is null then
    update public.organization_persons
       set recruiter_id = v_recruiter.recruiter_id,
           version = v_person.version + 1,
           updated_at = v_now,
           updated_by_app_user_id = p_actor_app_user_id
     where person_id = v_person.person_id;
  end if;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_account_ref, v_account.version, p_actor_app_user_id, 'link_create',
    jsonb_build_object('recruiter_id', null), jsonb_build_object('recruiter_id', v_recruiter.recruiter_id), v_reason_id
  ) returning revision_id into v_app_user_revision_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, 'link_create', 'entry_admin', p_account_ref::text,
    'all', 'APPLIED', v_reason_id, array['recruiter_link'], v_app_user_revision_id
  );
  v_personnel_revision_id := public.direct_entry_write_personnel_revision(
    v_recruiter.recruiter_id, v_recruiter.version, p_actor_app_user_id, v_reason_id,
    null, public.direct_entry_personnel_snapshot(v_recruiter)
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, personnel_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin', v_recruiter.recruiter_id::text,
    'all', 'APPLIED', v_reason_id, array['display_name', 'personnel_code', 'personnel_position', 'active'],
    v_personnel_revision_id
  );
  v_result := jsonb_build_object(
    'recruiter_id', v_recruiter.recruiter_id, 'display_name', v_recruiter.display_name,
    'personnel_code', v_recruiter.personnel_code, 'personnel_position', v_recruiter.personnel_position,
    'version', v_recruiter.version, 'link_id', v_link_id, 'membership_id', v_membership_id,
    'app_user_version', v_account.version, 'app_user_revision_id', v_app_user_revision_id,
    'personnel_revision_id', v_personnel_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

-- =============================================================================
-- SECTION 5: App User Enable/Disable, Clear Authority Trigger & PM Lock
-- =============================================================================

create or replace function public.direct_entry_mutate_app_user_status(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_expected_app_user_version integer,
  p_reason text,
  p_idempotency_key text,
  p_enable boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_locked_id uuid;
  v_actor public.direct_entry_app_users;
  v_target public.direct_entry_app_users;
  v_action text := case when p_enable then 'enable' else 'disable' end;
  v_payload_hash text;
  v_existing_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_today date := public.direct_entry_authorization_date();
  v_rl record;
  v_tla record;
  v_can_restore_tl boolean;
  v_prev_marker text := pg_catalog.current_setting('direct_entry.team_leader_marker', true);
  v_locked_person_ids uuid[];
  v_locked_dept_ids uuid[];
  v_recruiter_ids uuid[];
  v_team_ids uuid[];
  v_lock_key text;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_auth_subject is null or p_actor_app_user_id is null or p_target_app_user_id is null then
    raise exception 'actor and target are required' using errcode = '22023';
  end if;
  if p_expected_app_user_version is null or p_expected_app_user_version < 1 then
    raise exception 'expected app user version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Phase 1: Unlocked candidate discovery for Tier 1 (P -> D -> M) before Tier 2 (U)
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_recruiter_ids
    from (
      select l.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = p_target_app_user_id
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_app_user_id
    ) rids
   where rid is not null;

  select coalesce(array_agg(distinct pid order by pid), array[]::uuid[])
    into v_locked_person_ids
    from (
      select l.person_id as pid
        from public.organization_account_person_links l
       where l.app_user_id = p_target_app_user_id
         and l.ended_at is null
      union
      select p.person_id as pid
        from public.organization_persons p
       where p.recruiter_id = any(v_recruiter_ids)
    ) pids
   where pid is not null;

  -- Tier 1 (P -> D -> M) BEFORE Tier 2 (U)
  foreach v_locked_id in array v_locked_person_ids loop
    perform public.org_department__internal_lock_person(v_locked_id);
  end loop;

  if cardinality(v_locked_person_ids) > 0 then
    perform p.person_id
      from public.organization_persons p
     where p.person_id = any(v_locked_person_ids)
     order by p.person_id asc
     for update;

    select coalesce(array_agg(distinct m.department_id order by m.department_id), array[]::uuid[])
      into v_locked_dept_ids
      from public.organization_person_department_memberships m
     where m.person_id = any(v_locked_person_ids)
       and m.ended_at is null;

    foreach v_locked_id in array v_locked_dept_ids loop
      perform public.org_department__internal_lock_department(v_locked_id);
    end loop;

    if cardinality(v_locked_dept_ids) > 0 then
      perform d.department_id
        from public.organization_departments d
       where d.department_id = any(v_locked_dept_ids)
       order by d.department_id asc
       for update;

      perform m.membership_id
        from public.organization_person_department_memberships m
       where m.person_id = any(v_locked_person_ids)
         and m.ended_at is null
       order by m.membership_id asc
       for update;
    end if;
  end if;

  -- Tier 2a (U advisory: lock write-target account BEFORE any direct_entry_app_users row lock)
  perform public.org_department__internal_lock_app_user(p_target_app_user_id);

  -- Tier 2b (U row: ascending UUID order, FOR UPDATE target, FOR SHARE pure operator)
  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id asc
  loop
    if v_locked_id = p_target_app_user_id then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_locked_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_locked_id
       for share;
    end if;
  end loop;

  select u.* into v_actor
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id;
  if not found then
    raise exception 'actor identity is not derived from the session' using errcode = '42501';
  end if;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'action', v_action,
    'target_app_user_id', p_target_app_user_id,
    'expected_app_user_version', p_expected_app_user_version,
    'reason', p_reason
  ));

  select i.request_hash, i.result
    into v_existing_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = 'app_user_' || v_action
     and i.idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
    return v_prior;
  end if;

  if v_target.version <> p_expected_app_user_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if p_enable and v_target.enabled then
    raise exception 'target app user is already enabled' using errcode = '23514';
  end if;
  if not p_enable and not v_target.enabled then
    raise exception 'target app user is already disabled' using errcode = '23514';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, 'app_user_' || v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Tier 3 & Tier 4 (R_full -> T)
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_recruiter_ids
    from (
      select l.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = p_target_app_user_id
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_app_user_id
      union
      select p.recruiter_id as rid
        from public.organization_persons p
       where p.person_id = any(v_locked_person_ids)
         and p.recruiter_id is not null
    ) rids
   where rid is not null;

  select coalesce(array_agg(distinct a.team_id order by a.team_id), array[]::uuid[])
    into v_team_ids
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = p_target_app_user_id
     and a.team_id is not null;

  if cardinality(v_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  if cardinality(v_team_ids) > 0 then
    perform t.team_id
      from public.teams t
     where t.team_id = any(v_team_ids)
     order by t.team_id asc
     for update;
  end if;

  -- Post-lock completeness guard (check Person / Recruiter drift before touching child state)
  if exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = p_target_app_user_id
       and l.ended_at is null
       and not (l.person_id = any(v_locked_person_ids))
  ) or exists (
    select 1
      from public.organization_persons p
     where p.recruiter_id = any(v_recruiter_ids)
       and not (p.person_id = any(v_locked_person_ids))
  ) then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;

  -- Tier 5 Canonical Child Locks (RPM -> RTM -> URL -> TLA)
  if cardinality(v_recruiter_ids) > 0 then
    perform m.membership_id
      from public.recruiter_provider_memberships m
     where m.recruiter_id = any(v_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'provider:' || rid::text as k
        from unnest(v_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    perform m.membership_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = any(v_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'team-membership:' || rid::text as k
        from unnest(v_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;
  end if;

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_target_app_user_id
      or (cardinality(v_recruiter_ids) > 0 and l.recruiter_id = any(v_recruiter_ids))
   order by l.link_id asc
   for update;

  perform pg_advisory_xact_lock(hashtextextended('recruiter-link:' || p_target_app_user_id::text, 0));
  for v_lock_key in
    select 'recruiter-link-recruiter:' || rid::text as k
      from unnest(coalesce(v_recruiter_ids, array[]::uuid[])) as rid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform a.assignment_id
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = p_target_app_user_id
      or (cardinality(v_team_ids) > 0 and a.team_id = any(v_team_ids))
   order by a.assignment_id asc
   for update;

  v_before := public.direct_entry_app_user_snapshot(
    p_target_app_user_id, v_target.enabled, p_actor_app_user_id
  );

  update public.direct_entry_app_users
     set enabled = p_enable,
         version = version + 1,
         updated_at = pg_catalog.clock_timestamp()
   where app_user_id = p_target_app_user_id
   returning * into v_target;

  if p_enable then
    -- Step 1: Restore recruiter links before TL assignments
    for v_rl in
      select l.*, r.active as recruiter_active
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = p_target_app_user_id
         and l.suspended_by_account_disable = true
       order by l.link_id
    loop
      if (v_rl.valid_to is null or v_rl.valid_to > v_today)
         and v_rl.valid_from <= v_today
         and coalesce(v_rl.recruiter_active, false)
         and not exists (
           select 1 from public.direct_entry_app_user_recruiter_links other
            where other.link_id <> v_rl.link_id
              and other.is_current = true
              and (
                other.app_user_id = p_target_app_user_id
                or (v_rl.verified and other.verified and other.recruiter_id = v_rl.recruiter_id)
              )
         ) then
        update public.direct_entry_app_user_recruiter_links
           set is_current = true,
               suspended_by_account_disable = false
         where link_id = v_rl.link_id;
      else
        update public.direct_entry_app_user_recruiter_links
           set suspended_by_account_disable = false
         where link_id = v_rl.link_id;
      end if;
    end loop;

    -- Step 2: Restore TL assignments ONLY if Org §2.3 & team/recruiter invariants still hold
    for v_tla in
      select a.*, t.active as team_active, t.code as team_code, r.active as recruiter_active
        from public.direct_entry_team_leader_assignments a
        join public.teams t on t.team_id = a.team_id
        join public.recruiters r on r.recruiter_id = a.leader_recruiter_id
       where a.leader_app_user_id = p_target_app_user_id
         and a.suspended_by_account_disable = true
       order by a.assignment_id
    loop
      v_can_restore_tl := (
        v_tla.valid_to is null
        and v_tla.valid_from <= v_today
        and coalesce(v_tla.team_active, false)
        and v_tla.team_code <> '__system_vendor__'
        and coalesce(v_tla.recruiter_active, false)
        and public.org_department__internal_recruiter_org_allows_recruitment_team(
          v_tla.leader_recruiter_id,
          p_target_app_user_id,
          pg_catalog.clock_timestamp()
        )
        and exists (
          select 1 from public.direct_entry_app_user_recruiter_links l
           where l.app_user_id = p_target_app_user_id
             and l.recruiter_id = v_tla.leader_recruiter_id
             and l.verified = true
             and l.is_current = true
        )
        and (
          select count(*)::int from public.recruiter_provider_memberships m
           where m.recruiter_id = v_tla.leader_recruiter_id
             and m.provider_type = 'hrp'
             and m.vendor_id is null
             and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today)
        ) = 1
        and (
          select count(*)::int from public.recruiter_team_memberships m
           where m.recruiter_id = v_tla.leader_recruiter_id
             and m.team_id = v_tla.team_id
             and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
        ) = 1
        and not exists (
          select 1 from public.direct_entry_team_leader_assignments other
           where other.assignment_id <> v_tla.assignment_id
             and (other.team_id = v_tla.team_id or other.leader_app_user_id = p_target_app_user_id)
             and (
               other.is_current
               or (
                 (other.valid_to is null or other.valid_to > other.valid_from)
                 and daterange(other.valid_from, other.valid_to, '[)') && daterange(v_today, null, '[)')
               )
             )
        )
      );

      if v_can_restore_tl then
        update public.direct_entry_team_leader_assignments a
           set is_current = true,
               suspended_by_account_disable = false
         where a.assignment_id = v_tla.assignment_id;
      else
        perform pg_catalog.set_config('direct_entry.team_leader_marker', 'on', true);

        update public.direct_entry_team_leader_assignments a
           set is_current = false,
               suspended_by_account_disable = false,
               valid_to = coalesce(a.valid_to, greatest(v_today, a.valid_from))
         where a.assignment_id = v_tla.assignment_id;

        perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
      end if;
    end loop;
  end if;

  v_after := public.direct_entry_app_user_snapshot(
    p_target_app_user_id, v_target.enabled, p_actor_app_user_id
  );

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  insert into public.direct_entry_app_user_revisions
    (app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id)
  values
    (p_target_app_user_id, v_target.version, p_actor_app_user_id, v_action,
     v_before, v_after, v_reason_id)
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, app_user_revision_id)
  values
    (p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
     p_target_app_user_id::text, 'all', 'APPLIED', v_reason_id,
     array['enabled'], v_revision_id);

  v_result := jsonb_build_object(
    'app_user_id', p_target_app_user_id,
    'version', v_target.version,
    'revision_id', v_revision_id,
    'change', v_action
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, 'app_user_' || v_action, p_idempotency_key, v_result
  );
  return v_result;
exception
  when others then
    perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
    raise;
end;
$function$;

create or replace function public.direct_entry_clear_authority_on_disable()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_lock_key text;
begin
  if tg_op = 'UPDATE' then
    if tg_table_name = 'direct_entry_app_users' then
      if old.enabled and not new.enabled then
        perform l.link_id
          from public.direct_entry_app_user_recruiter_links l
         where l.app_user_id = new.app_user_id
         order by l.link_id asc
         for update;

        perform pg_advisory_xact_lock(hashtextextended('recruiter-link:' || new.app_user_id::text, 0));
        for v_lock_key in
          select distinct 'recruiter-link-recruiter:' || l.recruiter_id::text as k
            from public.direct_entry_app_user_recruiter_links l
           where l.app_user_id = new.app_user_id
           order by k asc
        loop
          perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
        end loop;

        perform a.assignment_id
          from public.direct_entry_team_leader_assignments a
         where a.leader_app_user_id = new.app_user_id
         order by a.assignment_id asc
         for update;

        update public.direct_entry_app_user_recruiter_links
           set is_current = false,
               suspended_by_account_disable = true
         where app_user_id = new.app_user_id
           and is_current = true;
        update public.direct_entry_team_leader_assignments
           set is_current = false,
               suspended_by_account_disable = true
         where leader_app_user_id = new.app_user_id
           and is_current = true;
      end if;
    elsif tg_table_name = 'recruiters' then
      if old.active and not new.active then
        perform m.membership_id
          from public.recruiter_provider_memberships m
         where m.recruiter_id = new.recruiter_id
         order by m.membership_id asc
         for update;
        perform pg_advisory_xact_lock(hashtextextended('provider:' || new.recruiter_id::text, 0));

        perform m.membership_id
          from public.recruiter_team_memberships m
         where m.recruiter_id = new.recruiter_id
         order by m.membership_id asc
         for update;
        perform pg_advisory_xact_lock(hashtextextended('team-membership:' || new.recruiter_id::text, 0));

        perform l.link_id
          from public.direct_entry_app_user_recruiter_links l
         where l.recruiter_id = new.recruiter_id
         order by l.link_id asc
         for update;
        for v_lock_key in
          select distinct 'recruiter-link:' || l.app_user_id::text as k
            from public.direct_entry_app_user_recruiter_links l
           where l.recruiter_id = new.recruiter_id
           order by k asc
        loop
          perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
        end loop;
        perform pg_advisory_xact_lock(hashtextextended('recruiter-link-recruiter:' || new.recruiter_id::text, 0));

        perform a.assignment_id
          from public.direct_entry_project_manager_assignments a
         where a.manager_recruiter_id = new.recruiter_id
         order by a.assignment_id asc
         for update;

        perform a.assignment_id
          from public.direct_entry_team_leader_assignments a
         where a.leader_recruiter_id = new.recruiter_id
         order by a.assignment_id asc
         for update;

        update public.recruiter_provider_memberships set is_current = false where recruiter_id = new.recruiter_id;
        update public.recruiter_team_memberships set is_current = false where recruiter_id = new.recruiter_id;
        update public.direct_entry_app_user_recruiter_links set is_current = false, suspended_by_account_disable = false where recruiter_id = new.recruiter_id;
        update public.direct_entry_project_manager_assignments set is_current = false where manager_recruiter_id = new.recruiter_id;
        update public.direct_entry_team_leader_assignments set is_current = false, suspended_by_account_disable = false where leader_recruiter_id = new.recruiter_id;
      elsif not old.active and new.active then
        perform m.membership_id
          from public.recruiter_provider_memberships m
         where m.recruiter_id = new.recruiter_id
         order by m.membership_id asc
         for update;
        perform pg_advisory_xact_lock(hashtextextended('provider:' || new.recruiter_id::text, 0));
        update public.recruiter_provider_memberships set is_current = true
         where recruiter_id = new.recruiter_id and valid_to is null
           and (select count(*) from public.recruiter_provider_memberships m
                 where m.recruiter_id = new.recruiter_id and m.valid_to is null) = 1;
      end if;
    elsif tg_table_name = 'teams' then
      if old.active and not new.active then
        perform m.membership_id
          from public.recruiter_team_memberships m
         where m.team_id = new.team_id
         order by m.membership_id asc
         for update;
        for v_lock_key in
          select distinct 'team-membership:' || m.recruiter_id::text as k
            from public.recruiter_team_memberships m
           where m.team_id = new.team_id
           order by k asc
        loop
          perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
        end loop;

        perform p.mapping_id
          from public.direct_entry_project_team_scopes p
         where p.team_id = new.team_id
         order by p.mapping_id asc
         for update;

        perform a.assignment_id
          from public.direct_entry_team_leader_assignments a
         where a.team_id = new.team_id
         order by a.assignment_id asc
         for update;

        update public.recruiter_team_memberships set is_current = false where team_id = new.team_id;
        update public.direct_entry_project_team_scopes set is_current = false where team_id = new.team_id;
        update public.direct_entry_team_leader_assignments set is_current = false, suspended_by_account_disable = false where team_id = new.team_id;
      end if;
    elsif tg_table_name = 'direct_entry_projects' then
      if old.active and not new.active then
        update public.direct_entry_project_team_scopes set is_current = false where project_id = new.project_id;
      end if;
    elsif tg_table_name = 'vendors' then
      if old.active and not new.active then
        update public.recruiter_provider_memberships set is_current = false where vendor_id = new.vendor_id;
      end if;
    end if;
  end if;
  return new;
end;
$function$;

create or replace function public.direct_entry_lock_project_team_manager_context(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_manager_recruiter_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_app_user_ids uuid[];
  v_leader_recruiter_id uuid;
  v_link_count integer;
  v_locked_team_id uuid;
  v_lock_key text;
begin
  if p_team_id is null or p_manager_recruiter_id is null then
    raise exception 'team manager context required' using errcode = '22023';
  end if;

  perform t.team_id
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select pg_catalog.array_agg(ids.app_user_id order by ids.app_user_id)
    into v_app_user_ids
    from (
      select p_app_user_id as app_user_id
      union
      select l.app_user_id
        from public.direct_entry_app_user_recruiter_links l
       where l.recruiter_id = p_manager_recruiter_id
         and l.verified
         and l.is_current
    ) ids;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_app_user_ids)
   order by u.app_user_id
   for update;

  for v_lock_key in
    select distinct 'recruiter-link:' || ids.app_user_id::text as key
      from unnest(v_app_user_ids) ids(app_user_id)
     order by key
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key, 0));
  end loop;

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_app_user_ids)
   order by l.link_id
   for update;

  select count(*)::integer,
         (pg_catalog.array_agg(l.recruiter_id order by l.link_id))[1]
    into v_link_count, v_leader_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.is_current
     and not l.suspended_by_account_disable;
  if v_link_count <> 1 or v_leader_recruiter_id is null then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  perform r.recruiter_id
    from public.recruiters r
   where r.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by r.recruiter_id
   for update;

  for v_lock_key in
    select distinct keys.key
      from unnest(array[
        'provider:' || v_leader_recruiter_id::text,
        'team-membership:' || v_leader_recruiter_id::text,
        'provider:' || p_manager_recruiter_id::text,
        'team-membership:' || p_manager_recruiter_id::text
      ]) keys(key)
     order by keys.key
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key, 0));
  end loop;

  perform m.membership_id
    from public.recruiter_provider_memberships m
   where m.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by m.recruiter_id, m.membership_id
   for update;
  perform m.membership_id
    from public.recruiter_team_memberships m
   where m.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by m.recruiter_id, m.membership_id
   for update;

  v_locked_team_id := public.direct_entry_assert_team_leader_current_team(
    p_auth_subject, p_app_user_id, p_team_id
  );
  if v_locked_team_id is distinct from p_team_id then
    raise exception 'team leader authority changed' using errcode = '42501';
  end if;
end;
$function$;

-- =============================================================================
-- SECTION 6: Team Leader Candidates & Mutation (No Legacy Grants)
-- =============================================================================

create or replace function public.direct_entry_list_team_leader_candidates(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_candidates jsonb;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.direct_entry_authz__internal_has_paired_capability(
    p_app_user_id, 'team_master_manage', 'ALL', null
  ) then
    raise exception 'insufficient privilege for team leader candidates' using errcode = '42501';
  end if;

  if p_team_id is null or not exists (
    select 1 from public.teams t
     where t.team_id = p_team_id
       and t.active
       and t.code <> '__system_vendor__'
  ) then
    raise exception 'team leader candidates unavailable' using errcode = 'P0002';
  end if;
  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid team leader candidate search' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');

  with eligible as (
    select u.app_user_id, links.recruiter_id, r.display_name, r.personnel_code
      from public.direct_entry_app_users u
      cross join lateral (
        select count(*)::int as link_count,
               count(*) filter (where l.verified)::int as verified_link_count,
               (array_agg(l.recruiter_id order by l.link_id)
                 filter (where l.verified))[1] as recruiter_id
          from public.direct_entry_app_user_recruiter_links l
         where l.app_user_id = u.app_user_id
           and l.is_current
      ) links
      join public.recruiters r on r.recruiter_id = links.recruiter_id
      cross join lateral (
        select count(*)::int as provider_count,
               count(*) filter (
                 where m.provider_type = 'hrp' and m.vendor_id is null
               )::int as hrp_count
          from public.recruiter_provider_memberships m
         where m.recruiter_id = r.recruiter_id
           and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today)
      ) providers
      cross join lateral (
        select count(*)::int as membership_count,
               count(*) filter (where m.team_id = p_team_id)::int as target_count
          from public.recruiter_team_memberships m
         where m.recruiter_id = r.recruiter_id
           and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
      ) memberships
     where u.enabled
       and coalesce(u.authz_managed, false)
       and r.active
       and links.link_count = 1
       and links.verified_link_count = 1
       and providers.provider_count = 1
       and providers.hrp_count = 1
       and memberships.membership_count = 1
       and memberships.target_count = 1
       and not exists (
         select 1 from public.direct_entry_team_leader_assignments a
          where a.leader_app_user_id = u.app_user_id
            and (
              public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today)
              or (a.valid_from > v_today and (a.valid_to is null or a.valid_to > a.valid_from))
            )
       )
  ), filtered as (
    select * from eligible
     where v_search is null
        or display_name ilike '%' || v_search || '%'
        or coalesce(personnel_code, '') ilike '%' || v_search || '%'
  ), page_rows as (
    select * from filtered
     order by display_name, app_user_id
     limit v_page_size offset (v_page - 1) * v_page_size
  )
  select (select count(*)::int from filtered),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'app_user_id', app_user_id,
             'display_name', display_name,
             'personnel_code', personnel_code
           ) order by display_name, app_user_id)
             from page_rows
         ), '[]'::jsonb)
    into v_total, v_candidates;

  return jsonb_build_object(
    'authorization_date', v_today,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'candidates', v_candidates
  );
end;
$function$;

create or replace function public.direct_entry_apply_team_leader_mutation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_target_leader_app_user_id uuid,
  p_effective_date date,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text,
  p_operation text,
  p_authority text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_team public.teams;
  v_old public.direct_entry_team_leader_assignments%rowtype;
  v_new public.direct_entry_team_leader_assignments%rowtype;
  v_old_count integer := 0;
  v_origin public.direct_entry_team_leader_revisions%rowtype;
  v_previous public.direct_entry_team_leader_assignments%rowtype;
  v_restore boolean := false;
  v_restore_recruiter_id uuid;
  v_candidate_user_enabled boolean;
  v_target_authz_managed boolean := false;
  v_link_count integer;
  v_verified_link_count integer;
  v_recruiter_id uuid;
  v_recruiter_active boolean;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_idempotency_action text;
  v_prior_hash text;
  v_change text;
  v_prior jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_team_version integer;
  v_before jsonb;
  v_after jsonb;
  v_changed_fields text[] := array[
    'team_leader_assignment', 'team_scope', 'team_manager_assign'
  ];
  v_locked_person_ids uuid[];
  v_locked_dept_ids uuid[];
  v_write_user_ids uuid[];
  v_all_user_ids uuid[];
  v_cand_recruiter_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_locked_id uuid;
  v_lock_key text;
  v_post_team_assignment_count integer;
  v_post_target_team_assignment_count integer;
  v_post_target_assignment_count integer;
  v_post_outgoing_assignment_count integer;
  v_post_closed_assignment_count integer;
  v_post_restored_assignment_count integer;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_operation not in ('designate', 'revoke') then
    raise exception 'invalid team leader operation' using errcode = '22023';
  end if;
  if (p_operation = 'designate') <> (p_target_leader_app_user_id is not null) then
    raise exception 'target leader does not match operation' using errcode = '22023';
  end if;
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected team version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Phase 1: Unlocked candidate discovery (covers target in designate AND v_previous same-day restore candidate in revoke)
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_write_user_ids
    from (
      select p_target_leader_app_user_id as uid
      union
      select a.leader_app_user_id as uid
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and (
           a.is_current
           or a.suspended_by_account_disable
           or a.valid_to is null
           or a.valid_to >= v_today
         )
    ) users
   where uid is not null;

  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_cand_recruiter_ids
    from (
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where (a.team_id = p_team_id or a.leader_app_user_id = any(v_write_user_ids))
         and (
           a.is_current
           or a.suspended_by_account_disable
           or a.valid_to is null
           or a.valid_to >= v_today
         )
      union
      select l.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = any(v_write_user_ids)
    ) rids
   where rid is not null;

  select coalesce(array_agg(distinct pid order by pid), array[]::uuid[])
    into v_locked_person_ids
    from (
      select p.person_id as pid
        from public.organization_persons p
       where p.recruiter_id = any(v_cand_recruiter_ids)
      union
      select l.person_id as pid
        from public.organization_account_person_links l
       where l.app_user_id = any(v_write_user_ids)
         and l.ended_at is null
      union
      select l.person_id as pid
        from public.organization_account_person_links l
        join public.direct_entry_app_user_recruiter_links rl
          on rl.app_user_id = l.app_user_id
       where rl.recruiter_id = any(v_cand_recruiter_ids)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
         and l.ended_at is null
    ) pids
   where pid is not null;

  -- Phase 2: Canonical Tier 1 (P -> D -> M BEFORE Tier 2 U!)
  foreach v_locked_id in array v_locked_person_ids loop
    perform public.org_department__internal_lock_person(v_locked_id);
  end loop;

  if cardinality(v_locked_person_ids) > 0 then
    perform p.person_id
      from public.organization_persons p
     where p.person_id = any(v_locked_person_ids)
     order by p.person_id asc
     for update;

    select coalesce(array_agg(distinct m.department_id order by m.department_id), array[]::uuid[])
      into v_locked_dept_ids
      from public.organization_person_department_memberships m
     where m.person_id = any(v_locked_person_ids)
       and m.ended_at is null;

    foreach v_locked_id in array v_locked_dept_ids loop
      perform public.org_department__internal_lock_department(v_locked_id);
    end loop;

    if cardinality(v_locked_dept_ids) > 0 then
      perform d.department_id
        from public.organization_departments d
       where d.department_id = any(v_locked_dept_ids)
       order by d.department_id asc
       for update;

      perform m.membership_id
        from public.organization_person_department_memberships m
       where m.person_id = any(v_locked_person_ids)
         and m.ended_at is null
       order by m.membership_id asc
       for update;
    end if;
  end if;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union
      select unnest(v_write_user_ids) as uid
    ) all_users
   where uid is not null;

  -- Phase 2a: Canonical Tier 2 (U advisory: sorted ascending, deduplicated write-target accounts FIRST)
  foreach v_locked_id in array coalesce(v_write_user_ids, array[]::uuid[]) loop
    if v_locked_id is not null then
      perform public.org_department__internal_lock_app_user(v_locked_id);
    end if;
  end loop;

  -- Phase 2b: Canonical Tier 2 (U row: ascending UUID order, FOR UPDATE targets, FOR SHARE pure operator)
  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id = any(v_all_user_ids)
     order by u.app_user_id asc
  loop
    if v_locked_id = any(v_write_user_ids) then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_locked_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_locked_id
       for share;
    end if;
  end loop;

  -- Re-assert operator team_master_manage [ALL] authority under U lock BEFORE idempotency / OCC
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.direct_entry_authz__internal_has_paired_capability(
    p_app_user_id, 'team_master_manage', 'ALL', null
  ) then
    raise exception 'insufficient privilege for team leader management' using errcode = '42501';
  end if;
  p_authority := case
    when public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
     and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      then 'entry_admin'
    else 'team_master_manage'
  end;

  -- Canonical Tier 3 (R_full: affected recruiters in ascending ID order)
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where (a.team_id = p_team_id or a.leader_app_user_id = any(v_write_user_ids))
         and (
           a.is_current
           or a.suspended_by_account_disable
           or a.valid_to is null
           or a.valid_to >= v_today
         )
      union
      select l.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = any(v_write_user_ids)
      union
      select p.recruiter_id as rid
        from public.organization_persons p
       where p.person_id = any(v_locked_person_ids)
         and p.recruiter_id is not null
    ) rids
   where rid is not null;

  if cardinality(v_locked_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_locked_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  -- Canonical Tier 4 (T: target team)
  select t.* into v_team
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if v_team.code = '__system_vendor__' then
    raise exception 'reserved team cannot have a leader' using errcode = '23514';
  end if;

  v_idempotency_action := case p_operation
    when 'designate' then 'team_leader_designate'
    else 'team_leader_revoke'
  end;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'team_id', p_team_id,
    'target_leader_app_user_id', p_target_leader_app_user_id,
    'effective_date', p_effective_date,
    'expected_version', p_expected_version,
    'reason', p_reason
  ));
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_app_user_id
     and i.action = v_idempotency_action
     and i.idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash <> v_request_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    if v_prior is null then
      raise exception 'completed idempotency result is missing' using errcode = '55000';
    end if;
    return v_prior;
  end if;

  p_effective_date := coalesce(p_effective_date, v_today);
  if p_effective_date > v_today then
    raise exception 'future team leader assignments require explicit activation'
      using errcode = '22023';
  end if;
  if p_effective_date < v_today then
    raise exception 'past team leader assignments are not allowed'
      using errcode = '22023';
  end if;

  if v_team.version <> p_expected_version then
    raise exception 'team version conflict' using errcode = 'PT409';
  end if;
  if p_operation = 'designate' and not v_team.active then
    raise exception 'target team is inactive' using errcode = '23514';
  end if;

  -- Post-lock completeness guard (extended across P, U, and R_full)
  if exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and (
         a.is_current
         or a.suspended_by_account_disable
         or a.valid_to is null
         or a.valid_to >= v_today
       )
       and (
         not (a.leader_app_user_id = any(v_write_user_ids))
         or not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
       )
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = any(v_write_user_ids)
       and not (l.recruiter_id = any(v_locked_recruiter_ids))
  ) or exists (
    select 1
      from public.organization_persons p
     where p.recruiter_id = any(v_locked_recruiter_ids)
       and not (p.person_id = any(v_locked_person_ids))
  ) or exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = any(v_write_user_ids)
       and l.ended_at is null
       and not (l.person_id = any(v_locked_person_ids))
  ) or exists (
    select 1
      from public.organization_account_person_links l
      join public.direct_entry_app_user_recruiter_links rl
        on rl.app_user_id = l.app_user_id
     where rl.recruiter_id = any(v_locked_recruiter_ids)
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and l.ended_at is null
       and not (l.person_id = any(v_locked_person_ids))
  ) then
    raise exception 'team version conflict' using errcode = 'PT409';
  end if;

  -- Canonical child tiers: RPM -> RTM -> URL -> TLA
  if cardinality(v_locked_recruiter_ids) > 0 then
    perform m.membership_id
      from public.recruiter_provider_memberships m
     where m.recruiter_id = any(v_locked_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'provider:' || rid::text as k
        from unnest(v_locked_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    perform m.membership_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = any(v_locked_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'team-membership:' || rid::text as k
        from unnest(v_locked_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;
  end if;

  if cardinality(v_write_user_ids) > 0 or cardinality(v_locked_recruiter_ids) > 0 then
    perform l.link_id
      from public.direct_entry_app_user_recruiter_links l
     where (cardinality(v_write_user_ids) > 0 and l.app_user_id = any(v_write_user_ids))
        or (cardinality(v_locked_recruiter_ids) > 0 and l.recruiter_id = any(v_locked_recruiter_ids))
     order by l.link_id asc
     for update;

    for v_lock_key in
      select distinct 'recruiter-link:' || uid::text as k
        from unnest(coalesce(v_write_user_ids, array[]::uuid[])) as uid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    for v_lock_key in
      select distinct 'recruiter-link-recruiter:' || rid::text as k
        from unnest(coalesce(v_locked_recruiter_ids, array[]::uuid[])) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;
  end if;

  perform a.assignment_id
    from public.direct_entry_team_leader_assignments a
   where a.team_id = p_team_id
      or (cardinality(v_write_user_ids) > 0 and a.leader_app_user_id = any(v_write_user_ids))
   order by a.assignment_id asc
   for update;

  -- Phase 3: Materialize expired/effective state under full locks (TLA only)
  update public.direct_entry_team_leader_assignments a
     set is_current = false,
         suspended_by_account_disable = false
   where a.team_id = p_team_id
     and a.is_current
     and a.valid_to is not null
     and a.valid_to <= v_today;

  update public.direct_entry_team_leader_assignments a
     set is_current = true
   where a.team_id = p_team_id
     and not a.is_current
     and not a.suspended_by_account_disable
     and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today);

  select count(*)::int into v_old_count
    from public.direct_entry_team_leader_assignments a
   where a.team_id = p_team_id
     and (a.valid_to is null or a.valid_to > a.valid_from)
     and daterange(a.valid_from, a.valid_to, '[)')
         && daterange(p_effective_date, null, '[)');
  if v_old_count > 1 then
    raise exception 'team leader assignment is ambiguous' using errcode = '42501';
  end if;
  if v_old_count = 1 then
    select a.* into v_old
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and daterange(a.valid_from, a.valid_to, '[)')
           && daterange(p_effective_date, null, '[)')
     order by a.valid_from, a.assignment_id
     limit 1;
    if v_old.valid_from > p_effective_date then
      raise exception 'future team leader must be cancelled at its start date'
        using errcode = '23514';
    end if;
  elsif p_operation = 'revoke' then
    raise exception 'no leader assignment to revoke' using errcode = '22023';
  end if;
  if p_operation = 'designate'
     and v_old_count = 1
     and v_old.leader_app_user_id = p_target_leader_app_user_id then
    raise exception 'leader is already assigned to this team' using errcode = '23514';
  end if;

  if p_operation = 'revoke'
     and v_old_count = 1
     and p_effective_date = v_old.valid_from then
    select r.* into v_origin
      from public.direct_entry_team_leader_revisions r
     where r.team_id = p_team_id
       and r.after_snapshot->>'leader_app_user_id' = v_old.leader_app_user_id::text
       and r.after_snapshot->>'valid_from' = v_old.valid_from::text
     order by r.version desc
     limit 1;
    if found and v_origin.action = 'replace' then
      select a.* into v_previous
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and a.valid_to = v_old.valid_from
         and a.valid_from < a.valid_to
         and exists (
           select 1
             from public.direct_entry_team_leader_revisions r
            where r.team_id = p_team_id
              and r.version <= v_origin.version
              and r.action = 'replace'
              and r.after_snapshot->>'valid_from' = v_old.valid_from::text
              and r.before_snapshot->>'leader_app_user_id' = a.leader_app_user_id::text
              and r.before_snapshot->>'leader_recruiter_id' = a.leader_recruiter_id::text
              and r.before_snapshot->>'valid_from' = a.valid_from::text
              and not exists (
                select 1
                  from public.direct_entry_team_leader_revisions r2
                 where r2.team_id = p_team_id
                   and r2.version > r.version
                   and (
                     r2.action <> 'replace'
                     or r2.after_snapshot->>'valid_from' <> v_old.valid_from::text
                   )
              )
         )
       order by a.valid_from desc, a.assignment_id desc
       limit 1;
    end if;
  end if;

  if p_operation = 'designate' then
    select u.enabled, coalesce(u.authz_managed, false)
      into v_candidate_user_enabled, v_target_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = p_target_leader_app_user_id;
    if not found or not coalesce(v_candidate_user_enabled, false) then
      raise exception 'target leader account is not enabled' using errcode = '42501';
    end if;
    if not coalesce(v_target_authz_managed, false) then
      raise exception 'target leader account is not authz managed' using errcode = '42501';
    end if;

    select count(*)::int,
           count(*) filter (where l.verified)::int,
           (array_agg(l.recruiter_id order by l.link_id))[1]
      into v_link_count, v_verified_link_count, v_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_target_leader_app_user_id
       and (
         l.is_current
         or (
           p_effective_date > v_today
           and l.valid_from <= p_effective_date
           and (l.valid_to is null or p_effective_date < l.valid_to)
           and (l.valid_to is null or l.valid_to > l.valid_from)
         )
       );
    if v_link_count <> 1 or v_verified_link_count <> 1 or v_recruiter_id is null then
      raise exception 'target leader requires exactly one verified recruiter link'
        using errcode = '42501';
    end if;

    select r.active into v_recruiter_active
      from public.recruiters r
     where r.recruiter_id = v_recruiter_id;
    if not found or not coalesce(v_recruiter_active, false) then
      raise exception 'target recruiter is not active' using errcode = '42501';
    end if;

    -- Cross-domain s2.3 guard under full locks (reject 23514 if mapped to non-RECRUITMENT / INACTIVE / Source C)
    if not public.org_department__internal_recruiter_org_allows_recruitment_team(
      v_recruiter_id,
      p_target_leader_app_user_id,
      pg_catalog.clock_timestamp()
    ) then
      raise exception 'target leader organization assignment does not allow recruitment team leadership'
        using errcode = '23514';
    end if;

    select count(*)::int,
           count(*) filter (
             where m.provider_type = 'hrp' and m.vendor_id is null
           )::int
      into v_provider_count, v_hrp_provider_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date);
    if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
      raise exception 'target recruiter requires exactly one effective HRP provider'
        using errcode = '42501';
    end if;

    select count(*)::int,
           count(*) filter (where m.team_id = p_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, p_effective_date);
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'target recruiter must have exactly one effective membership in the target team'
        using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_leader_app_user_id
         and a.team_id <> p_team_id
         and (
           a.is_current
           or (
             (a.valid_to is null or a.valid_to > a.valid_from)
             and daterange(a.valid_from, a.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
    ) then
      raise exception 'target leader is assigned or scheduled for another team'
        using errcode = '42501';
    end if;
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, v_idempotency_action, p_idempotency_key, v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if p_operation = 'revoke' and v_previous.assignment_id is not null then
    select (array_agg(l.recruiter_id order by l.link_id) filter (where l.verified))[1]
      into v_restore_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = v_previous.leader_app_user_id
       and l.is_current;

    if v_team.active
       and v_restore_recruiter_id is not null
       and v_restore_recruiter_id = v_previous.leader_recruiter_id
       and public.org_department__internal_recruiter_org_allows_recruitment_team(
         v_previous.leader_recruiter_id,
         v_previous.leader_app_user_id,
         pg_catalog.clock_timestamp()
       )
       and exists (
         select 1
           from public.direct_entry_app_users u
           join public.recruiters r on r.recruiter_id = v_restore_recruiter_id
          where u.app_user_id = v_previous.leader_app_user_id
            and u.enabled
            and coalesce(u.authz_managed, false)
            and r.active
       )
       and (
         select count(*)::int
           from public.direct_entry_app_user_recruiter_links l
          where l.app_user_id = v_previous.leader_app_user_id
            and l.is_current
       ) = 1
       and (
         select count(*)::int
           from public.recruiter_provider_memberships m
          where m.recruiter_id = v_restore_recruiter_id
            and m.provider_type = 'hrp'
            and m.vendor_id is null
            and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today)
       ) = 1
       and (
         select count(*)::int
           from public.recruiter_team_memberships m
          where m.recruiter_id = v_restore_recruiter_id
            and m.team_id = p_team_id
            and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
       ) = 1
       and not exists (
         select 1
           from public.direct_entry_team_leader_assignments a
          where a.assignment_id not in (v_old.assignment_id, v_previous.assignment_id)
            and (a.team_id = p_team_id or a.leader_app_user_id = v_previous.leader_app_user_id)
            and (
              a.is_current
              or (
                (a.valid_to is null or a.valid_to > a.valid_from)
                and daterange(a.valid_from, a.valid_to, '[)')
                    && daterange(v_previous.valid_from, null, '[)')
              )
            )
       ) then
      v_restore := true;
    end if;
  end if;

  if v_old_count = 1 then
    if p_effective_date = v_old.valid_from then
      perform set_config('direct_entry.team_leader_marker', 'on', true);
    end if;

    update public.direct_entry_team_leader_assignments
       set valid_to = p_effective_date,
           is_current = (p_effective_date > v_old.valid_from and v_old.valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
           suspended_by_account_disable = false
     where assignment_id = v_old.assignment_id;
  end if;

  if v_restore then
    update public.direct_entry_team_leader_assignments
       set valid_to = null,
           is_current = (v_previous.valid_from <= v_today),
           suspended_by_account_disable = false
     where assignment_id = v_previous.assignment_id;
  end if;

  if p_operation = 'designate' then
    insert into public.direct_entry_team_leader_assignments
      (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current, suspended_by_account_disable)
    values
      (p_team_id, p_target_leader_app_user_id, v_recruiter_id, p_effective_date, (p_effective_date <= v_today), false)
    returning * into v_new;

    v_change := case when v_old_count = 1 then 'replace' else 'designate' end;
  else
    v_new := v_old;
    v_change := 'revoke';
  end if;

  if p_operation = 'designate' then
    select count(*) filter (where a.team_id = p_team_id)::int,
           count(*) filter (
             where a.team_id = p_team_id
               and a.leader_app_user_id = p_target_leader_app_user_id
           )::int,
           count(*) filter (
             where a.leader_app_user_id = p_target_leader_app_user_id
           )::int
      into v_post_team_assignment_count, v_post_target_team_assignment_count,
           v_post_target_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from);

    if v_post_team_assignment_count <> 1
       or v_post_target_team_assignment_count <> 1
       or v_post_target_assignment_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;

    if v_old_count = 1 then
      select count(*)::int into v_post_outgoing_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and a.leader_app_user_id = v_old.leader_app_user_id
         and a.valid_from <= p_effective_date
         and (a.valid_to is null or p_effective_date < a.valid_to)
         and (a.valid_to is null or a.valid_to > a.valid_from);
      select count(*)::int into v_post_closed_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.assignment_id = v_old.assignment_id
         and a.valid_to = p_effective_date;
      if v_post_outgoing_assignment_count <> 0
         or v_post_closed_assignment_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    end if;
  else
    select count(*)::int into v_post_team_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from);
    select count(*)::int into v_post_closed_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_old.assignment_id
       and a.valid_to = p_effective_date;
    if v_post_closed_assignment_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;

    if v_restore then
      select count(*)::int into v_post_restored_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.assignment_id = v_previous.assignment_id
         and a.valid_to is null
         and a.is_current = (v_previous.valid_from <= v_today);
      if v_post_team_assignment_count <> 1
         or v_post_restored_assignment_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    else
      if v_post_team_assignment_count <> 0 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    end if;
  end if;

  update public.teams t
     set version = t.version + 1
   where t.team_id = p_team_id
  returning t.version into v_team_version;
  if v_team_version is null then
    raise exception 'team not found' using errcode = 'P0002';
  end if;

  if v_old_count = 1 then
    v_before := public.direct_entry_team_leader_snapshot(
      p_team_id, v_old.leader_app_user_id, v_old.leader_recruiter_id,
      v_old.valid_from, v_old.valid_to, null, v_team.version, v_change
    );
  end if;
  if p_operation = 'designate' then
    v_after := public.direct_entry_team_leader_snapshot(
      p_team_id, v_new.leader_app_user_id, v_new.leader_recruiter_id,
      v_new.valid_from, v_new.valid_to,
      case when v_old_count = 1 then v_old.leader_recruiter_id end,
      v_team_version, v_change
    );
  else
    v_after := public.direct_entry_team_leader_snapshot(
      p_team_id, v_old.leader_app_user_id, v_old.leader_recruiter_id,
      v_old.valid_from, p_effective_date,
      case when v_restore then v_previous.leader_recruiter_id else null end,
      v_team_version, v_change
    );
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_team_leader_revisions
    (team_id, version, actor_user_id, action, before_snapshot, after_snapshot)
  values
    (p_team_id, v_team_version, p_app_user_id, v_change, v_before, v_after)
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, leader_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_leader_' || v_change, p_authority,
     p_team_id::text, 'all', 'APPLIED', v_reason_id, v_changed_fields, v_revision_id);

  v_result := jsonb_build_object(
    'team_id', p_team_id,
    'assignment_id', v_new.assignment_id,
    'leader_app_user_id', v_new.leader_app_user_id,
    'leader_recruiter_id', v_new.leader_recruiter_id,
    'valid_from', v_new.valid_from,
    'valid_to', case when p_operation = 'revoke' then p_effective_date else v_new.valid_to end,
    'version', v_team_version,
    'revision_id', v_revision_id,
    'change', v_change
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, v_idempotency_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

-- =============================================================================
-- SECTION 7: Input Catalog & Catalog Bootstrap (Retire Legacy Fallback)
-- =============================================================================

create or replace function public.direct_entry_input_catalog_unscoped_v42(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_effective_date date
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_result jsonb;
begin
  if p_effective_date is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found or not coalesce(v_authz_managed, false) then
    raise exception 'actor capability denied' using errcode = '42501';
  end if;

  if not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_create', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_create', 'ALL', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_own', 'OWN', null)
  ) then
    raise exception 'actor capability denied' using errcode = '42501';
  end if;

  with hrp_memberships as (
    select m.recruiter_id, count(*) as membership_count
      from public.recruiter_provider_memberships m
     where m.provider_type = 'hrp'
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date)
     group by m.recruiter_id
  ), vendor_memberships as (
    select m.recruiter_id, m.vendor_id
      from public.recruiter_provider_memberships m
     where m.provider_type = 'vendor'
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date)
  ), hrp_teams as (
    select m.recruiter_id, count(*) as membership_count,
           min(m.team_id::text)::uuid as team_id
      from public.recruiter_team_memberships m
     where public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, p_effective_date)
     group by m.recruiter_id
  ), hrp_recruiters as (
    select r.recruiter_id, r.display_name, r.personnel_code, tt.team_id,
           team.display_name as team_display_name
      from public.recruiters r
      join hrp_memberships p on p.recruiter_id = r.recruiter_id
                            and p.membership_count = 1
      join hrp_teams tt on tt.recruiter_id = r.recruiter_id
                        and tt.membership_count = 1
      join public.teams team on team.team_id = tt.team_id and team.active
     where r.active
  ), vendor_recruiters as (
    select r.recruiter_id, r.display_name, vm.vendor_id,
           v.display_name as vendor_display_name
      from public.recruiters r
      join vendor_memberships vm on vm.recruiter_id = r.recruiter_id
      left join public.vendors v on v.vendor_id = vm.vendor_id and v.active
     where r.active
       and (vm.vendor_id is null or v.vendor_id is not null)
  )
  select jsonb_build_object(
    'effective_date', p_effective_date,
    'labor_types', public.direct_entry_labor_type_options(),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'project_id', p.project_id, 'display_name', p.display_name
      ) order by p.display_name, p.project_id)
        from public.direct_entry_projects p
       where p.active
    ), '[]'::jsonb),
    'recruiters', coalesce((
      select coalesce(jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', r.display_name,
        'personnel_code', r.personnel_code,
        'provider_type', 'hrp',
        'vendor_id', null,
        'team_id', r.team_id,
        'team_display_name', r.team_display_name,
        'label', (
          r.display_name
          || ' · ' || coalesce(r.personnel_code, '—')
          || ' · ' || r.team_display_name
        )
      ) order by r.display_name, r.team_display_name, r.recruiter_id), '[]'::jsonb)
        from hrp_recruiters r
    ) || coalesce((
      select jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', coalesce(r.vendor_display_name, r.display_name),
        'personnel_code', null,
        'provider_type', 'vendor',
        'vendor_id', r.vendor_id,
        'team_id', null,
        'team_display_name', null,
        'label', coalesce(r.vendor_display_name, r.display_name)
      ) order by coalesce(r.vendor_display_name, r.display_name), r.recruiter_id)
        from vendor_recruiters r
    ), '[]'::jsonb), '[]'::jsonb),
    'banks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bank_id', b.bank_id, 'display_name', b.display_name
      ) order by b.display_name, b.bank_id)
        from public.direct_entry_banks b
       where b.active
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

do $wp10_7_3c_executor_setup$
declare
  v_executor oid;
begin
  if current_user <> session_user then
    raise exception 'WP10.7 3C catalog bootstrap migration requires session_user = current_user';
  end if;
  select r.oid into v_executor
    from pg_catalog.pg_roles r
   where r.rolname = 'direct_entry_catalog_bootstrap_executor';
  if v_executor is null then
    raise exception 'WP10.7 3C catalog bootstrap executor role is missing';
  end if;
  perform pg_catalog.set_config('mini_bi.wp10_7_3c_added_catalog_executor_membership', 'false', true);
  perform pg_catalog.set_config('mini_bi.wp10_7_3c_added_catalog_executor_create', 'false', true);
  if not pg_catalog.pg_has_role(session_user, v_executor, 'SET') then
    if exists (
      select 1 from pg_catalog.pg_auth_members m
       where m.member = session_user::regrole
         and m.roleid = v_executor
         and m.grantor = current_user::regrole
    ) then
      raise exception 'WP10.7 3C found stale migration executor membership';
    end if;
    execute pg_catalog.format(
      'GRANT direct_entry_catalog_bootstrap_executor TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
      session_user
    );
    perform pg_catalog.set_config('mini_bi.wp10_7_3c_added_catalog_executor_membership', 'true', true);
  end if;
  if pg_catalog.has_schema_privilege(v_executor, 'public', 'CREATE') then
    raise exception 'catalog bootstrap executor unexpectedly has CREATE on public';
  end if;
  execute 'GRANT CREATE ON SCHEMA public TO direct_entry_catalog_bootstrap_executor';
  perform pg_catalog.set_config('mini_bi.wp10_7_3c_added_catalog_executor_create', 'true', true);
end;
$wp10_7_3c_executor_setup$;

set local role direct_entry_catalog_bootstrap_executor;

create or replace function public.direct_entry_catalog_bootstrap_plan(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_projection jsonb;
  v_catalog_empty boolean;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'catalog bootstrap actor required' using errcode = '22023';
  end if;
  perform set_config('mini_bi.catalog_bootstrap_app_user_id', p_app_user_id::text, true);
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if not coalesce(v_authz_managed, false) or not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null)
  ) then
    raise exception 'catalog bootstrap capability denied' using errcode = '42501';
  end if;

  v_projection := public.direct_entry_catalog_bootstrap_projection();
  select not (
    exists (select 1 from public.direct_entry_projects)
    or exists (select 1 from public.recruiters)
    or exists (select 1 from public.teams)
    or exists (select 1 from public.recruiter_aliases)
    or exists (select 1 from public.recruiter_provider_memberships)
    or exists (select 1 from public.recruiter_team_memberships)
    or exists (select 1 from public.direct_entry_banks)
  ) into v_catalog_empty;

  return jsonb_build_object(
    'source_fingerprint', v_projection->'source_fingerprint',
    'project_count', v_projection->'project_count',
    'recruiter_count', v_projection->'recruiter_count',
    'provider_period_count', v_projection->'provider_period_count',
    'invalid_count', v_projection->'invalid_count',
    'ambiguous_count', v_projection->'ambiguous_count',
    'catalog_empty', v_catalog_empty
  );
end;
$function$;

create or replace function public.direct_entry_apply_catalog_bootstrap(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_source_fingerprint text,
  p_idempotency_key text,
  p_reason text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_projection jsonb;
  v_existing public.direct_entry_catalog_bootstrap_runs%rowtype;
  v_run_id uuid;
  v_reason_id uuid;
  v_team_id uuid;
  v_item jsonb;
  v_period jsonb;
  v_recruiter_id uuid;
  v_project_count integer;
  v_recruiter_count integer;
  v_provider_count integer;
  v_snapshot_date date;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_auth_subject is null
     or p_app_user_id is null
     or p_expected_source_fingerprint is null
     or p_expected_source_fingerprint !~ '^[a-f0-9]{64}$'
     or p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid catalog bootstrap request' using errcode = '22023';
  end if;
  perform set_config('mini_bi.catalog_bootstrap_app_user_id', p_app_user_id::text, true);
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if not coalesce(v_authz_managed, false) or not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null)
  ) then
    raise exception 'catalog bootstrap capability denied' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('direct_entry_catalog_bootstrap', 0));
  v_projection := public.direct_entry_catalog_bootstrap_projection();
  if v_projection->>'source_fingerprint' <> p_expected_source_fingerprint then
    raise exception 'catalog bootstrap source conflict' using errcode = 'PT409';
  end if;
  if (v_projection->>'invalid_count')::integer <> 0
     or (v_projection->>'ambiguous_count')::integer <> 0
     or (v_projection->>'project_count')::integer = 0
     or (v_projection->>'recruiter_count')::integer = 0
     or (v_projection->>'provider_period_count')::integer = 0 then
    raise exception 'catalog bootstrap source is not valid' using errcode = '23514';
  end if;

  select * into v_existing
    from public.direct_entry_catalog_bootstrap_runs
   where app_user_id = p_app_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.source_fingerprint <> p_expected_source_fingerprint then
      raise exception 'catalog bootstrap replay conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'status', 'ALREADY_APPLIED',
      'source_fingerprint', v_existing.source_fingerprint,
      'project_count', v_existing.project_count,
      'recruiter_count', v_existing.recruiter_count,
      'team_count', v_existing.team_count,
      'provider_membership_count', v_existing.provider_membership_count,
      'replayed', true
    );
  end if;

  if exists (select 1 from public.direct_entry_projects)
     or exists (select 1 from public.recruiters)
     or exists (select 1 from public.teams)
     or exists (select 1 from public.recruiter_aliases)
     or exists (select 1 from public.recruiter_provider_memberships)
     or exists (select 1 from public.recruiter_team_memberships)
     or exists (select 1 from public.direct_entry_banks) then
    raise exception 'catalog bootstrap target is not empty' using errcode = '23505';
  end if;

  v_run_id := gen_random_uuid();
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_snapshot_date := public.direct_entry_authorization_date();

  insert into public.direct_entry_projects(project_id, display_name)
  select x.project_id, x.display_name
    from jsonb_to_recordset(v_projection->'projects') as x(project_id text, display_name text);
  v_project_count := (v_projection->>'project_count')::integer;

  insert into public.teams(code, display_name)
  values ('unassigned', 'Chưa phân nhóm')
  returning team_id into v_team_id;

  for v_item in select value from jsonb_array_elements(v_projection->'recruiters') loop
    insert into public.recruiters(display_name)
    values (v_item->>'display_name')
    returning recruiter_id into v_recruiter_id;

    insert into public.recruiter_aliases(recruiter_id, reporting_key, valid_from)
    values (v_recruiter_id, v_item->>'reporting_key', (v_item->>'alias_from')::date);

    insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from, is_current)
    values (v_recruiter_id, v_team_id, (v_item->>'team_from')::date,
      (v_item->>'team_from')::date <= v_snapshot_date);

    for v_period in select value from jsonb_array_elements(v_item->'periods') loop
      insert into public.recruiter_provider_memberships(
        recruiter_id, provider_type, valid_from, valid_to, is_current
      ) values (
        v_recruiter_id, v_period->>'provider_type',
        (v_period->>'valid_from')::date, (v_period->>'valid_to')::date,
        (v_period->>'valid_from')::date <= v_snapshot_date
          and (v_period->>'valid_to' is null or v_snapshot_date < (v_period->>'valid_to')::date)
      );
    end loop;
  end loop;

  v_recruiter_count := (v_projection->>'recruiter_count')::integer;
  v_provider_count := (v_projection->>'provider_period_count')::integer;

  insert into public.direct_entry_catalog_bootstrap_runs(
    run_id, app_user_id, source_fingerprint, project_count, recruiter_count,
    team_count, provider_membership_count, status, idempotency_key, reason_id
  ) values (
    v_run_id, p_app_user_id, p_expected_source_fingerprint, v_project_count,
    v_recruiter_count, 1, v_provider_count, 'APPLIED', p_idempotency_key, v_reason_id
  );

  insert into public.direct_entry_audit_events(
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'catalog_bootstrap', 'entry_admin',
    'catalog-bootstrap:' || v_run_id::text, 'all', 'APPLIED', v_reason_id,
    array[
      'projects', 'recruiters', 'recruiter_aliases', 'teams',
      'recruiter_team_memberships', 'recruiter_provider_memberships'
    ]
  );

  return jsonb_build_object(
    'status', 'APPLIED',
    'source_fingerprint', p_expected_source_fingerprint,
    'project_count', v_project_count,
    'recruiter_count', v_recruiter_count,
    'team_count', 1,
    'provider_membership_count', v_provider_count,
    'replayed', false
  );
end;
$function$;

reset role;

do $wp10_7_3c_executor_cleanup$
declare
  v_executor oid;
begin
  select r.oid into v_executor
    from pg_catalog.pg_roles r
   where r.rolname = 'direct_entry_catalog_bootstrap_executor';
  if current_setting('mini_bi.wp10_7_3c_added_catalog_executor_create', true) = 'true' then
    execute pg_catalog.format(
      'REVOKE CREATE ON SCHEMA public FROM direct_entry_catalog_bootstrap_executor GRANTED BY %I',
      current_user
    );
  end if;
  if current_setting('mini_bi.wp10_7_3c_added_catalog_executor_membership', true) = 'true' then
    execute pg_catalog.format(
      'REVOKE direct_entry_catalog_bootstrap_executor FROM %I GRANTED BY %I',
      session_user, current_user
    );
  end if;
  if pg_catalog.has_schema_privilege(v_executor, 'public', 'CREATE') then
    raise exception 'WP10.7 3C catalog bootstrap executor retained CREATE on public';
  end if;
  if exists (
    select 1 from pg_catalog.pg_auth_members m
     where m.member = session_user::regrole
       and m.roleid = v_executor
       and m.grantor = current_user::regrole
  ) then
    raise exception 'WP10.7 3C migration executor membership was not removed';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.direct_entry_catalog_bootstrap_plan(uuid,uuid)'::regprocedure
       and p.proowner = v_executor and p.prosecdef
  ) or not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)'::regprocedure
       and p.proowner = v_executor and p.prosecdef
  ) then
    raise exception 'WP10.7 3C changed catalog bootstrap function owner or SECURITY DEFINER';
  end if;
end;
$wp10_7_3c_executor_cleanup$;

-- =============================================================================
-- SECTION 8 (Part 1): Direct Entry / Uploader / CCCD / CR Guards (#17-#36)
-- =============================================================================

create or replace function public.direct_entry__internal_assert_cccd_qr_read_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_entry public.direct_entries%rowtype;
  v_scope text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id
     and e.deleted_at is null
     and e.voided_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  begin
    return public.direct_entry_assert_document_upload_access(
      p_auth_subject, p_app_user_id, p_entry_id
    );
  exception when insufficient_privilege then
    null;
  end;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'cccd qr read denied' using errcode = '42501';
  end if;

  if not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
    or (
      v_entry.team_id is not null
      and public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'document_view', 'CONTEXT_TEAM', v_entry.team_id::text
      )
    )
    or public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, 'document_view', 'CONTEXT_PROJECT', v_entry.project_id
    )
  ) then
    raise exception 'cccd qr read denied' using errcode = '42501';
  end if;

  v_scope := public.direct_entry_resolve_submission_read_scope(
    p_auth_subject, p_app_user_id, v_entry.entry_id
  );
  if v_scope is null then
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'document_view',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  end if;
  if v_scope is null then
    raise exception 'cccd qr read denied' using errcode = '42501';
  end if;

  if not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
    or (
      (v_scope = 'own' or v_entry.created_by_user_id = p_app_user_id)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
    )
    or (
      v_scope in ('team', 'team_review')
      and (
        (
          v_entry.team_id is not null
          and public.direct_entry_authz__internal_has_paired_capability(
            p_app_user_id, 'document_view', 'CONTEXT_TEAM', v_entry.team_id::text
          )
        )
        or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
      )
    )
    or (
      v_scope = 'project'
      and (
        public.direct_entry_authz__internal_has_paired_capability(
          p_app_user_id, 'document_view', 'CONTEXT_PROJECT', v_entry.project_id
        )
        or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
      )
    )
    or (
      v_scope = 'recruited'
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
    )
  ) then
    raise exception 'cccd qr read denied' using errcode = '42501';
  end if;

  return v_scope;
end;
$function$;

create or replace function public.direct_entry__internal_resolve_cccd_review_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_project_id text,
  p_is_full_admin boolean,
  p_team_leader_team_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_auth text;
begin
  v_auth := public.direct_entry_resolve_direct_edit_authority(
    p_auth_subject,
    p_app_user_id,
    p_entry_owner,
    p_team_id,
    p_project_id,
    p_is_full_admin,
    p_team_leader_team_id
  );
  if v_auth is not null then
    return v_auth;
  end if;

  if p_entry_owner = p_app_user_id then
    return 'creator_own';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    return null;
  end if;

  if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
     or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
    return 'all';
  end if;
  if p_team_id is not null and (
    public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, 'entry_admin', 'CONTEXT_TEAM', p_team_id::text
    )
    or public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, 'change_review', 'CONTEXT_TEAM', p_team_id::text
    )
  ) then
    return 'team';
  end if;

  return null;
end;
$function$;

create or replace function public.direct_entry_apply_change_item(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_entry public.direct_entries,
  p_target_kind text,
  p_proposal jsonb,
  p_reason_id uuid
)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid := p_reason_id;
  v_revision_id uuid;
  v_scope text;
  v_review_capability text := 'change_review';
  v_team_review boolean;
  v_team_id uuid;
  v_provider text;
  v_date date;
  v_recruiter_id uuid;
  v_target_project_id text;
  v_count integer;
  v_document_id uuid;
  v_status_version integer;
  v_latest public.direct_entry_employment_status_events%rowtype;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_team_review := public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) = p_entry.team_id;
  if p_target_kind = 'ENTRY_VOID' then
    if v_team_review then
      if not coalesce(v_authz_managed, false) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
      perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
      if not public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'team_manager_assign', 'CONTEXT_TEAM', p_entry.team_id::text
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
      v_scope := 'team';
      v_review_capability := 'team_manager_assign';
    else
      if not coalesce(v_authz_managed, false) then
        raise exception 'entry void review scope/capability denied' using errcode = '42501';
      end if;
      perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
      if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null) then
        v_scope := 'all';
        v_review_capability := 'entry_admin';
      elsif public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null) then
        v_scope := 'all';
        v_review_capability := 'entry_privileged_edit';
      elsif public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
        v_scope := 'all';
        v_review_capability := 'change_review';
      else
        raise exception 'entry void review scope/capability denied' using errcode = '42501';
      end if;
    end if;
  elsif v_team_review then
    v_scope := 'team';
    v_review_capability := 'team_manager_assign';
  else
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review', p_entry.created_by_user_id,
      p_entry.team_id, p_entry.first_work_date
    );
  end if;

  if p_target_kind = 'DOCUMENT' then
    if not coalesce(v_authz_managed, false) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
    if v_scope = 'all' then
      if not (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
    elsif v_scope = 'team' then
      if not (
        (
          public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
          or (
            p_entry.team_id is not null
            and public.direct_entry_authz__internal_has_paired_capability(
              p_app_user_id, 'document_view', 'CONTEXT_TEAM', p_entry.team_id::text
            )
          )
        )
        and (
          public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
          or (
            p_entry.team_id is not null
            and public.direct_entry_authz__internal_has_paired_capability(
              p_app_user_id, 'document_upload', 'CONTEXT_TEAM', p_entry.team_id::text
            )
          )
        )
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
    else
      if not (
        public.direct_entry_has_entry_access(
          p_app_user_id, 'document_view', p_entry.created_by_user_id, p_entry.team_id, p_entry.first_work_date
        )
        and public.direct_entry_has_entry_access(
          p_app_user_id, 'document_upload', p_entry.created_by_user_id, p_entry.team_id, p_entry.first_work_date
        )
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
    end if;
  end if;

  if p_target_kind = 'ENTRY_VOID' then
    if p_proposal is distinct from '{}'::jsonb
       or p_entry.voided_at is not null
       or (select count(*) from public.direct_entry_change_request_items i
            where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID') <> 1
       or not exists (
         select 1 from public.direct_entry_submissions s
          where s.submission_id = p_entry.submission_id and s.state = 'SUBMITTED'
       ) then
      raise exception 'entry void target is not active' using errcode = 'PT409';
    end if;
    return public.direct_entry__internal_apply_entry_void(
      p_auth_subject,
      p_app_user_id,
      p_entry.entry_id,
      p_entry.version,
      v_reason_id,
      'change_request_approve',
      v_review_capability,
      v_scope,
      case when v_scope = 'team' then p_entry.team_id else null end
    );
  end if;

  v_before := public.direct_entry_entry_snapshot(p_entry.entry_id);
  if p_target_kind = 'ENTRY_FIELD' then
    if (p_proposal - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type']) <> '{}'::jsonb
       or p_proposal = '{}'::jsonb
       or (p_proposal ? 'worker_details'
           and public.direct_entry_w04_worker_details_allowed(p_proposal->'worker_details') is not true) then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;
    v_recruiter_id := case when p_proposal ? 'recruiter_id'
      then (p_proposal->>'recruiter_id')::uuid else p_entry.recruiter_id end;
    v_date := case when p_proposal ? 'first_work_date'
      then (p_proposal->>'first_work_date')::date else p_entry.first_work_date end;
    v_target_project_id := case when p_proposal ? 'project_id'
      then p_proposal->>'project_id' else p_entry.project_id end;
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(
         m.membership_id, public.direct_entry_authorization_date()
       );
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    if v_provider = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id
         and public.direct_entry__internal_recruiter_team_membership_effective(
           m.membership_id, public.direct_entry_authorization_date()
         );
      if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
    end if;
    if v_team_review then
      if v_team_id is distinct from p_entry.team_id then
        raise exception 'entry scope/capability denied' using errcode = '42501';
      end if;
      if (p_proposal ? 'recruiter_id' or p_proposal ? 'project_id' or p_proposal ? 'first_work_date')
         and (not public.direct_entry_project_team_scope_effective(p_entry.project_id, v_team_id)
           or not public.direct_entry_project_team_scope_effective(v_target_project_id, v_team_id)) then
        raise exception 'team leader project scope denied' using errcode = '42501';
      end if;
    else
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'change_review',
        p_entry.created_by_user_id, v_team_id, v_date, v_scope
      );
    end if;
    update public.direct_entries set
      project_id = v_target_project_id,
      first_work_date = v_date,
      employee_code = case when p_proposal ? 'employee_code' then p_proposal->>'employee_code' else employee_code end,
      worker_details = case when p_proposal ? 'worker_details' then p_proposal->'worker_details' else worker_details end,
      recruiter_id = v_recruiter_id, team_id = v_team_id, provider_type = v_provider,
      labor_type = case when p_proposal ? 'labor_type' then p_proposal->>'labor_type' else labor_type end,
      version = version + 1
     where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'PAYMENT' then
    if (p_proposal - array['state','account_number','bank_id','account_holder_name']) <> '{}'::jsonb then
      raise exception 'unsupported payment proposal field' using errcode = '22023';
    end if;
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, account_holder_name, version
    ) values (
      p_entry.entry_id, p_proposal->>'state', p_proposal->>'account_number',
      p_proposal->>'bank_id', p_proposal->>'account_holder_name', 1
    ) on conflict (entry_id) do update set
      state = excluded.state, account_number = excluded.account_number,
      bank_id = excluded.bank_id, account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1, updated_at = now();
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'WORK_STATUS' then
    if (p_proposal - array['status','effective_date','leave_reason']) <> '{}'::jsonb then
      raise exception 'unsupported status proposal field' using errcode = '22023';
    end if;
    select * into v_latest from public.direct_entry_employment_status_events
     where entry_id = p_entry.entry_id order by version desc limit 1 for update;
    v_status_version := coalesce(v_latest.version, 0) + 1;
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, leave_date, leave_reason_text,
      version, actor_user_id, reason_id, supersedes_event_id
    ) values (
      p_entry.entry_id, p_proposal->>'status', (p_proposal->>'effective_date')::date,
      case when p_proposal->>'status' = 'OFF' then (p_proposal->>'effective_date')::date end,
      case when p_proposal->>'status' = 'OFF' then p_proposal->>'leave_reason' end,
      v_status_version, p_app_user_id, v_reason_id, null
    );
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'DOCUMENT' then
    if (p_proposal - array['document_type','idempotency_key','checksum_sha256','size_bytes','mime_type']) <> '{}'::jsonb then
      raise exception 'unsupported document proposal field' using errcode = '22023';
    end if;
    select document_id into v_document_id
      from public.direct_entry_create_document_record(
        p_entry.candidate_id, p_proposal->>'document_type',
        p_proposal->>'idempotency_key', p_proposal->>'checksum_sha256',
        (p_proposal->>'size_bytes')::bigint, p_proposal->>'mime_type', p_app_user_id
      );
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  else
    raise exception 'unsupported change target' using errcode = '22023';
  end if;
  v_after := public.direct_entry_entry_snapshot(p_entry.entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry.entry_id, p_app_user_id, v_reason_id, v_before, v_after, p_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'change_request_approve', v_review_capability,
    p_entry.entry_id::text, v_scope,
    case when v_scope = 'team' then
      case when p_target_kind = 'ENTRY_FIELD' then v_team_id else p_entry.team_id end
      else null end,
    'APPLIED', v_reason_id, v_revision_id, array[p_target_kind]
  );
  return v_revision_id;
end;
$function$;

create or replace function public.direct_entry_assert_catalog_operator(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_grants jsonb;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
     and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
     and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null) then
    return 'entry_admin';
  end if;

  if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'catalog_master_manage', 'ALL', null) then
    return 'catalog_master_manage';
  end if;

  -- Denial diagnostics only (allow/deny is already decided above): preserve
  -- historical SQLSTATE 42501 message split between missing capability vs missing ALL scope.
  v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
  if exists (
       select 1
         from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
        where g.capability = 'catalog_master_manage'
     )
     or (
       exists (
         select 1
           from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
          where g.capability = 'entry_admin'
       )
       and exists (
         select 1
           from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
          where g.capability = 'recruiter_master_manage'
       )
       and exists (
         select 1
           from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
          where g.capability = 'team_master_manage'
       )
     ) then
    raise exception 'catalog operation requires all scope' using errcode = '42501';
  end if;

  raise exception 'catalog operator denied' using errcode = '42501';
end;
$function$;

create or replace function public.direct_entry_assert_change_request_capabilities(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_capability text;
  v_tl_team_id uuid;
  v_team_leader_review boolean;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_tl_team_id := public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id);

  if exists (
    select 1 from public.direct_entry_change_request_items i
     where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID'
  ) then
    if (
      select count(*) from public.direct_entry_change_request_items i
       where i.request_id = p_request_id
    ) <> 1 then
      raise exception 'entry void request must contain one item' using errcode = '42501';
    end if;

    if v_tl_team_id is not null then
      if not coalesce(v_authz_managed, false) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
      perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
      if not public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'team_manager_assign', 'CONTEXT_TEAM', v_tl_team_id::text
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
      return;
    end if;

    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
    if not coalesce(v_authz_managed, false) or not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null)
    ) then
      raise exception 'entry void review scope/capability denied' using errcode = '42501';
    end if;
    return;
  end if;

  v_team_leader_review := v_tl_team_id is not null;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not coalesce(v_authz_managed, false) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  if v_team_leader_review then
    if not public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, 'team_manager_assign', 'CONTEXT_TEAM', v_tl_team_id::text
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  else
    if not public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
      v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
      if exists (
        select 1
          from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
         where g.capability = 'change_review'
      ) then
        raise exception 'scope denied' using errcode = '42501';
      end if;
      raise exception 'capability denied' using errcode = '42501';
    end if;
  end if;

  for v_capability in
    select capability
      from unnest(public.direct_entry_change_request_required_capabilities(p_request_id)) as required(capability)
     where not (v_team_leader_review and capability = 'change_review')
  loop
    if v_team_leader_review then
      if not (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, v_capability, 'ALL', null)
        or public.direct_entry_authz__internal_has_paired_capability(
          p_app_user_id, v_capability, 'CONTEXT_TEAM', v_tl_team_id::text
        )
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
    else
      if not public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, v_capability, 'ALL', null) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
    end if;
  end loop;
end;
$function$;

create or replace function public.direct_entry_assert_document_upload_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_entry public.direct_entries%rowtype;
  v_submission_state text;
  v_draft_scope text;
  v_read_scope text;
  v_is_full_admin boolean := false;
  v_current_team_leader_team_id uuid;
  v_direct_edit_authority text;
  v_has_doc_upload_all boolean := false;
  v_has_doc_upload_own boolean := false;
  v_has_doc_upload_team boolean := false;
  v_has_doc_upload_project boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id and e.deleted_at is null
   for update;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id
   for update;
  if v_submission_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;

  if not coalesce(v_authz_managed, false) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  v_has_doc_upload_all :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null);
  v_has_doc_upload_own :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null);
  v_has_doc_upload_team :=
    v_entry.team_id is not null
    and public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, 'document_upload', 'CONTEXT_TEAM', v_entry.team_id::text
    );
  v_has_doc_upload_project :=
    public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, 'document_upload', 'CONTEXT_PROJECT', v_entry.project_id
    );

  if v_submission_state = 'DRAFT' then
    begin
      if not (v_has_doc_upload_all or v_has_doc_upload_own or v_has_doc_upload_team or v_has_doc_upload_project) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
      v_draft_scope := public.direct_entry_assert_draft_access(
        p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
      if (v_draft_scope = 'all' and not (v_has_doc_upload_all or (v_entry.created_by_user_id = p_app_user_id and v_has_doc_upload_own)))
         or (v_draft_scope = 'team' and not (v_has_doc_upload_all or v_has_doc_upload_team or v_has_doc_upload_own))
         or (v_draft_scope = 'own' and not (v_has_doc_upload_all or v_has_doc_upload_own or v_has_doc_upload_team)) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
      return v_draft_scope;
    exception when insufficient_privilege then
      if v_entry.created_by_user_id = p_app_user_id
         and public.direct_entry_actor_can_access_project(
           p_app_user_id, v_entry.project_id
         ) then
        return 'project';
      end if;
      if v_entry.created_by_user_id = p_app_user_id then
        raise;
      end if;
    end;
  end if;

  if v_submission_state = 'REVIEW' then
    raise exception 'REVIEW submissions are read-only' using errcode = '42501';
  end if;

  if not (v_has_doc_upload_all or v_has_doc_upload_own or v_has_doc_upload_team or v_has_doc_upload_project) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  if v_submission_state = 'SUBMITTED'
     and v_entry.created_by_user_id = p_app_user_id then
    if v_has_doc_upload_all then
      return 'all';
    elsif v_has_doc_upload_own then
      return 'own';
    elsif v_has_doc_upload_team then
      return 'team';
    elsif v_has_doc_upload_project then
      return 'project';
    end if;
    raise exception 'capability denied' using errcode = '42501';
  end if;

  if v_submission_state = 'SUBMITTED'
     and exists (
       select 1
         from public.direct_entry_cccd_reconciliations r
        where r.entry_id = v_entry.entry_id
     ) then
    v_read_scope := public.direct_entry_resolve_submission_read_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id
    );
    if v_read_scope is not null then
      if (v_read_scope = 'all' and v_has_doc_upload_all)
         or (v_read_scope = 'own' and (v_has_doc_upload_all or v_has_doc_upload_own or v_has_doc_upload_team))
         or (v_read_scope in ('team', 'team_review') and (v_has_doc_upload_all or v_has_doc_upload_team or v_has_doc_upload_own))
         or (v_read_scope = 'project' and (v_has_doc_upload_all or v_has_doc_upload_project or v_has_doc_upload_own))
         or (v_read_scope = 'recruited' and (v_has_doc_upload_all or v_has_doc_upload_own)) then
        return v_read_scope;
      end if;
    end if;
  end if;

  if v_submission_state in ('DRAFT', 'SUBMITTED') then
    begin
      perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
      v_is_full_admin := true;
    exception when insufficient_privilege then
      null;
    end;
    begin
      v_current_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
        p_auth_subject, p_app_user_id, null
      );
    exception when insufficient_privilege then
      v_current_team_leader_team_id := null;
    end;
    v_direct_edit_authority := public.direct_entry_resolve_direct_edit_authority(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id, v_entry.team_id,
      v_entry.project_id, v_is_full_admin, v_current_team_leader_team_id
    );
    if v_direct_edit_authority is not null then
      if v_direct_edit_authority in ('admin_all', 'privileged_all') then
        if not v_has_doc_upload_all then
          raise exception 'capability denied' using errcode = '42501';
        end if;
        return 'all';
      elsif v_direct_edit_authority = 'team_leader' then
        if not (v_has_doc_upload_all or v_has_doc_upload_team or v_has_doc_upload_own) then
          raise exception 'capability denied' using errcode = '42501';
        end if;
        return 'team';
      elsif v_direct_edit_authority = 'privileged_team' then
        if not (v_has_doc_upload_all or v_has_doc_upload_team) then
          raise exception 'capability denied' using errcode = '42501';
        end if;
        return 'team';
      elsif v_direct_edit_authority = 'project_manager' then
        if not (v_has_doc_upload_all or v_has_doc_upload_project or v_has_doc_upload_own) then
          raise exception 'capability denied' using errcode = '42501';
        end if;
        return 'project';
      elsif v_direct_edit_authority = 'privileged_own' then
        if not (v_has_doc_upload_all or v_has_doc_upload_own) then
          raise exception 'capability denied' using errcode = '42501';
        end if;
        return 'own';
      else
        if not v_has_doc_upload_all then
          raise exception 'capability denied' using errcode = '42501';
        end if;
        return 'all';
      end if;
    end if;
  end if;

  perform public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit',
    v_entry.created_by_user_id, v_entry.team_id,
    v_entry.first_work_date, null
  );
  return public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'document_upload',
    v_entry.created_by_user_id, v_entry.team_id,
    v_entry.first_work_date, null
  );
end;
$function$;

create or replace function public.direct_entry_assert_draft_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_resource_scope_date date,
  p_required_scope text default null::text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_canonical_tl_team_id uuid := null;
  v_scope text;
  v_matches integer;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;

  v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);

  if p_team_id is not null and exists (
    select 1
      from pg_catalog.jsonb_to_recordset(v_grants) as g(
        capability text,
        scope_kind text,
        scope_id text,
        source_type text
      )
     where g.capability = 'entry_team'
       and g.scope_kind = 'CONTEXT_TEAM'
       and g.scope_id = p_team_id::text
       and g.source_type = 'CONTEXTUAL_ASSIGNMENT'
  ) then
    begin
      v_canonical_tl_team_id := public.direct_entry_assert_team_leader_current_team(
        p_auth_subject, p_app_user_id, p_team_id
      );
    exception when insufficient_privilege then
      v_canonical_tl_team_id := null;
    end;
  end if;

  select count(*)::integer, min(matched.legacy_scope)
    into v_matches, v_scope
    from (
      select case
               when g.capability = 'entry_admin'
                    and g.scope_kind = 'ALL'
                    and g.scope_id is null
                 then 'all'
               when g.capability = 'entry_own'
                    and g.scope_kind = 'OWN'
                    and g.scope_id is null
                    and p_entry_owner = p_app_user_id
                 then 'own'
               when g.capability = 'entry_team'
                    and g.scope_kind = 'CONTEXT_TEAM'
                    and p_team_id is not null
                    and g.scope_id = p_team_id::text
                    and (
                      g.source_type is distinct from 'CONTEXTUAL_ASSIGNMENT'
                      or v_canonical_tl_team_id = p_team_id
                    )
                    and exists (
                      select 1
                        from public.teams t
                       where t.team_id = p_team_id
                         and t.active
                         and t.code <> '__system_vendor__'
                    )
                 then 'team'
               else null
             end as legacy_scope
        from pg_catalog.jsonb_to_recordset(v_grants) as g(
          capability text,
          scope_kind text,
          scope_id text,
          source_type text
        )
    ) matched
   where matched.legacy_scope is not null
     and (p_required_scope is null or matched.legacy_scope = p_required_scope);

  if v_matches = 0 or v_scope is null then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;
  return v_scope;
end;
$function$;

create or replace function public.direct_entry_assert_entry_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text,
  p_entry_owner uuid,
  p_team_id uuid,
  p_effective_date date,
  p_required_scope text default null
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb := '[]'::jsonb;
  v_has_cap boolean := false;
  v_scope text;
  v_matches integer := 0;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  if p_capability is null
     or pg_catalog.btrim(p_capability) = ''
     or p_capability in ('pii_view', 'pii_export', 'payment_view', 'payment_edit') then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);

  select exists (
    select 1
      from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text, scope_kind text, scope_id text)
     where g.capability = p_capability
  ) into v_has_cap;

  if not coalesce(v_has_cap, false) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  select count(*)::integer, min(matched.legacy_scope)
    into v_matches, v_scope
    from (
      select case
               when g.scope_kind = 'ALL' and g.scope_id is null then 'all'
               when g.scope_kind = 'OWN' and g.scope_id is null and p_entry_owner = p_app_user_id then 'own'
               when g.scope_kind = 'CONTEXT_TEAM'
                    and p_team_id is not null
                    and g.scope_id = p_team_id::text
                    and exists (
                      select 1
                        from public.teams t
                       where t.team_id = p_team_id
                         and t.active
                         and t.code <> '__system_vendor__'
                    ) then 'team'
               else null
             end as legacy_scope
        from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text, scope_kind text, scope_id text)
       where g.capability = p_capability
    ) matched
   where matched.legacy_scope is not null
     and (p_required_scope is null or matched.legacy_scope = p_required_scope);

  if v_matches = 0 or v_scope is null then
    raise exception 'resource scope denied' using errcode = '42501';
  end if;

  return v_scope;
end;
$function$;

create or replace function public.direct_entry_assert_payment_document_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_resource_scope_date date,
  p_submission_id uuid,
  p_privileged_capability text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_state text;
begin
  select s.state into v_state from public.direct_entry_submissions s
   where s.submission_id = p_submission_id for update;
  if v_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  if v_state = 'DRAFT' then
    if p_privileged_capability = 'document_upload' then
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'document_upload',
        p_entry_owner, p_team_id, p_resource_scope_date
      );
    end if;
    return public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, p_entry_owner, p_team_id, p_resource_scope_date
    );
  end if;
  if v_state = 'REVIEW' then
    raise exception 'REVIEW submissions are read-only' using errcode = '42501';
  end if;
  if p_privileged_capability = 'document_upload' then
    perform public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'entry_privileged_edit',
      p_entry_owner, p_team_id, p_resource_scope_date
    );
  end if;
  return public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, p_privileged_capability,
    p_entry_owner, p_team_id, p_resource_scope_date
  );
end;
$function$;

create or replace function public.direct_entry_assert_project_admin(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_grants jsonb;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null) then
    return;
  end if;

  -- Denial diagnostics only (allow/deny is already decided above): preserve
  -- historical SQLSTATE 42501 message split between missing capability vs missing ALL scope.
  v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
  if exists (
       select 1
         from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
        where g.capability = 'entry_admin'
     ) then
    raise exception 'project administration requires all scope' using errcode = '42501';
  end if;

  raise exception 'capability denied' using errcode = '42501';
end;
$function$;

create or replace function public.direct_entry_assert_team_leader_current_team(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null::uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_authz_managed boolean := false;
  v_scope_team_id uuid;
  v_assignment_count integer := 0;
  v_assignment_recruiter_id uuid;
  v_paired_team_count integer := 0;
  v_matching_paired_team_count integer := 0;
  v_link_count integer := 0;
  v_link_recruiter_id uuid;
  v_provider_count integer := 0;
  v_hrp_provider_count integer := 0;
  v_membership_count integer := 0;
  v_matching_membership_count integer := 0;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::integer,
         (pg_catalog.array_agg(a.team_id order by a.assignment_id))[1],
         (pg_catalog.array_agg(a.leader_recruiter_id order by a.assignment_id))[1]
    into v_assignment_count, v_scope_team_id, v_assignment_recruiter_id
    from public.direct_entry_team_leader_assignments a
    join public.teams t
      on t.team_id = a.team_id
     and t.active
     and t.code <> '__system_vendor__'
   where a.leader_app_user_id = p_app_user_id
     and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today);

  if v_assignment_count <> 1
     or v_scope_team_id is null
     or v_assignment_recruiter_id is null
     or (p_team_id is not null and p_team_id <> v_scope_team_id) then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::integer,
         count(*) filter (where g.scope_id = v_scope_team_id::text)::integer
    into v_paired_team_count, v_matching_paired_team_count
    from (
      select distinct g.scope_id
        from pg_catalog.jsonb_to_recordset(
          public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id)
        ) as g(capability text, scope_kind text, scope_id text)
       where g.capability = 'team_manager_assign'
         and g.scope_kind = 'CONTEXT_TEAM'
         and g.scope_id is not null
         and pg_catalog.btrim(g.scope_id) <> ''
    ) g;

  if v_paired_team_count <> 1
     or v_matching_paired_team_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::integer
    into v_link_count
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.is_current;

  if v_link_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select l.recruiter_id
    into v_link_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r
      on r.recruiter_id = l.recruiter_id
     and r.active
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.is_current
     and not l.suspended_by_account_disable
     and l.valid_from <= v_today
     and (l.valid_to is null or (l.valid_to > l.valid_from and v_today < l.valid_to));

  if v_link_recruiter_id is null or v_link_recruiter_id <> v_assignment_recruiter_id then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::integer,
         count(*) filter (where m.provider_type = 'hrp' and m.vendor_id is null)::integer
    into v_provider_count, v_hrp_provider_count
    from public.recruiter_provider_memberships m
   where m.recruiter_id = v_link_recruiter_id
     and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today);

  if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::integer,
         count(*) filter (where m.team_id = v_scope_team_id)::integer
    into v_membership_count, v_matching_membership_count
    from public.recruiter_team_memberships m
   where m.recruiter_id = v_link_recruiter_id
     and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today);

  if v_membership_count <> 1 or v_matching_membership_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  return v_scope_team_id;
end;
$function$;

create or replace function public.direct_entry_change_request_audience(
  p_app_user_id uuid,
  p_proposer_user_id uuid,
  p_request_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_items integer;
  v_accessible integer;
  v_is_proposer boolean;
begin
  if p_app_user_id is null or p_proposer_user_id is null or p_request_id is null then
    return 'NONE';
  end if;
  v_is_proposer := p_proposer_user_id = p_app_user_id;
  select count(*) into v_items
    from public.direct_entry_change_request_items i
   where i.request_id = p_request_id;
  if v_items < 1 then return 'NONE'; end if;

  if v_is_proposer then
    if exists(
      select 1 from public.direct_entry_change_request_items i
       where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID'
    ) then
      select count(*) into v_accessible
        from public.direct_entry_change_request_items i
        join public.direct_entries e on e.entry_id = i.entry_id
        join public.direct_entry_submissions s on s.submission_id = e.submission_id
       where i.request_id = p_request_id
         and i.target_kind = 'ENTRY_VOID'
         and e.created_by_user_id = p_app_user_id
         and s.state = 'SUBMITTED';
      if v_accessible = v_items then return 'PROPOSER'; end if;
    end if;
    select count(*) into v_accessible
      from public.direct_entry_change_request_items i
      join public.direct_entries e on e.entry_id = i.entry_id
     where i.request_id = p_request_id
       and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
       and exists(
         select 1 from public.direct_entry_submissions s
          where s.submission_id = e.submission_id and s.state = 'SUBMITTED'
       );
    if v_accessible = v_items then return 'PROPOSER'; end if;
  else
    select coalesce(u.authz_managed, false)
      into v_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id;

    if not coalesce(v_authz_managed, false) then
      return 'NONE';
    end if;

    if exists(
      select 1 from public.direct_entry_change_request_items i
       where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID'
    ) then
      if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null)
         or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
         or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null) then
        return 'REVIEWER';
      end if;
    elsif public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
      return 'REVIEWER';
    end if;

    if public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) is not null then
      return 'REVIEWER';
    end if;
  end if;
  return 'NONE';
end;
$function$;

create or replace function public.direct_entry_claim_worker_portrait_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if not coalesce(v_authz_managed, false) or not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'portrait stage claim invalid' using errcode = '22023';
  end if;
  if v_stage.status = 'STAGED' then
    update public.direct_entry_worker_portrait_stages
       set status = 'CLAIMED', claim_idempotency_key = p_idempotency_key
     where stage_id = p_stage_id returning * into v_stage;
  elsif v_stage.status not in ('CLAIMED', 'ATTACHED') or
        v_stage.claim_idempotency_key <> p_idempotency_key then
    raise exception 'portrait stage already claimed' using errcode = 'PT409';
  end if;
  return jsonb_build_object(
    'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
    'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
    'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
    'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
  );
end;
$function$;

create or replace function public.direct_entry_complete_worker_document_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_idempotency_key text,
  p_entry_id uuid,
  p_document_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if not coalesce(v_authz_managed, false) or not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if v_stage.status = 'ATTACHED' then
    if v_stage.claim_idempotency_key = p_idempotency_key and
       v_stage.entry_id = p_entry_id and v_stage.document_id = p_document_id then return true; end if;
    raise exception 'worker document stage attachment conflict' using errcode = 'PT409';
  end if;
  if v_stage.status <> 'CLAIMED' or v_stage.claim_idempotency_key <> p_idempotency_key or
     not exists (
       select 1 from public.direct_entries e
       join public.direct_entry_document_versions d on d.candidate_id = e.candidate_id
        where e.entry_id = p_entry_id and d.document_id = p_document_id
          and d.document_type = v_stage.document_type
          and d.created_by_user_id = p_app_user_id
          and d.size_bytes = v_stage.size_bytes
          and d.mime_type = v_stage.mime_type
          and coalesce(
            (select o.checksum_sha256 from public.direct_entry_document_objects o
              where o.document_id = d.document_id), d.checksum_sha256
          ) = v_stage.checksum_sha256
          and exists (
            select 1 from public.direct_entry_document_events ev
             where ev.document_id = d.document_id and ev.upload_status = 'READY'
               and ev.validation_status = 'VALIDATED'
               and ev.scan_status in ('CLEAN', 'NOT_REQUIRED')
               and ev.version = (
                 select max(latest.version) from public.direct_entry_document_events latest
                  where latest.document_id = d.document_id
               )
          )
     ) then
    raise exception 'worker document stage attachment conflict' using errcode = 'PT409';
  end if;
  update public.direct_entry_worker_portrait_stages
     set status = 'ATTACHED', entry_id = p_entry_id, document_id = p_document_id
   where stage_id = p_stage_id;
  return true;
end;
$function$;

create or replace function public.direct_entry_complete_worker_portrait_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_idempotency_key text,
  p_entry_id uuid,
  p_document_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if not coalesce(v_authz_managed, false) or not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if v_stage.status = 'ATTACHED' then
    if v_stage.claim_idempotency_key = p_idempotency_key and
       v_stage.entry_id = p_entry_id and v_stage.document_id = p_document_id then
      return true;
    end if;
    raise exception 'portrait stage attachment conflict' using errcode = 'PT409';
  end if;
  if v_stage.status <> 'CLAIMED' or v_stage.claim_idempotency_key <> p_idempotency_key or
     not exists (
       select 1 from public.direct_entries e
       join public.direct_entry_document_versions d on d.candidate_id = e.candidate_id
        where e.entry_id = p_entry_id and d.document_id = p_document_id
          and d.document_type = 'WORKER_PORTRAIT'
          and d.created_by_user_id = p_app_user_id
          and d.size_bytes = v_stage.size_bytes
          and d.mime_type = v_stage.mime_type
          and coalesce(
            (select o.checksum_sha256 from public.direct_entry_document_objects o
              where o.document_id = d.document_id),
            d.checksum_sha256
          ) = v_stage.checksum_sha256
          and exists (
            select 1 from public.direct_entry_document_events ev
             where ev.document_id = d.document_id
               and ev.upload_status = 'READY'
               and ev.validation_status = 'VALIDATED'
               and ev.scan_status in ('CLEAN', 'NOT_REQUIRED')
               and ev.version = (
                 select max(latest.version) from public.direct_entry_document_events latest
                  where latest.document_id = d.document_id
               )
          )
     ) then
    raise exception 'portrait stage attachment conflict' using errcode = 'PT409';
  end if;
  update public.direct_entry_worker_portrait_stages
     set status = 'ATTACHED', entry_id = p_entry_id, document_id = p_document_id
   where stage_id = p_stage_id;
  return true;
end;
$function$;

create or replace function public.direct_entry_create_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_first_work_date date default null::date
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if p_project_id is not null
     and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    return 'manager';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'worker create authority denied' using errcode = '42501';
  end if;

  if (
       public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_create', 'OWN', null)
       or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_create', 'ALL', null)
     )
     and (
       public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
       or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null)
     ) then
    return 'legacy';
  end if;
  raise exception 'worker create authority denied' using errcode = '42501';
end;
$function$;

create or replace function public.direct_entry_create_full_profile_batch(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_contract_version text,
  p_rows jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_auth_date date := public.direct_entry_authorization_date();
  v_row jsonb;
  v_worker_input jsonb;
  v_worker_details jsonb;
  v_payment jsonb;
  v_employment jsonb;
  v_note jsonb;
  v_state text;
  v_project_id text;
  v_recruiter_id uuid;
  v_first_work_date date;
  v_employee_code text;
  v_labor_type text;
  v_display_name text;
  v_general_note text;
  v_payment_state text;
  v_account_number text;
  v_bank_id text;
  v_bank_name text;
  v_account_holder_name text;
  v_status text;
  v_leave_date date;
  v_leave_reason_text text;
  v_provider_type text;
  v_team_id uuid;
  v_count integer;
  v_submission_id uuid := gen_random_uuid();
  v_candidate_id uuid;
  v_entry_id uuid;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_trim_chars text := E' \t\n\r' || chr(11) || chr(12) || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197)
    || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232)
    || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279);
  v_entry_ids jsonb := '[]'::jsonb;
  v_codes text[] := '{}';
  v_national_ids text[] := '{}';
  v_national_id text;
  v_has_payment boolean := false;
  v_has_status boolean := false;
  v_prior jsonb;
  v_hash text;
  v_result jsonb;
begin
  if p_contract_version is null
     or p_contract_version not in ('worker-profile/1.0', 'worker-profile/1.2') then
    raise exception 'CONTRACT_VERSION_UNSUPPORTED' using errcode = '22023';
  end if;
  if p_idempotency_key is null
     or p_idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 100 then
    raise exception 'BATCH_INVALID' using errcode = '22023';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row - array[
         'project_id','first_work_date','employee_code','recruiter_id','labor_type',
         'display_name','worker_details','general_note','payment','employment'
       ] <> '{}'::jsonb then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    if v_row ? 'payment'
       and coalesce(v_row->'payment'->>'state', 'omitted') <> 'omitted'
       and not (
         v_row->'payment'->>'state' = 'provided'
         and nullif(btrim(v_row->'payment'->>'account_number', v_trim_chars), '') is null
         and nullif(btrim(v_row->'payment'->>'bank_name', v_trim_chars), '') is null
         and nullif(btrim(v_row->'payment'->>'account_holder_name', v_trim_chars), '') is null
         and nullif(btrim(v_row->'payment'->>'bank_id'), '') is null
       ) then
      v_has_payment := true;
    end if;
    if coalesce(v_row->'employment'->>'initial_status', '') = 'OFF' then
      v_has_status := true;
    end if;
  end loop;

  select count(*)::int into v_count
    from jsonb_array_elements(p_rows) as e(value)
   where public.direct_entry_create_authority(
           p_auth_subject, p_app_user_id, e.value->>'project_id',
           case when coalesce(e.value->>'first_work_date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then (e.value->>'first_work_date')::date end
         ) <> 'manager';

  if v_has_status and v_count > 0 then
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

    select coalesce(u.authz_managed, false)
      into v_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id;

    if not coalesce(v_authz_managed, false) or not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'employment_status.apply', 'ALL', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'employment_status.apply', 'OWN', null)
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  end if;

  v_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'contract_version', p_contract_version, 'rows', p_rows
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'full_profile_batch_create', p_idempotency_key, v_hash
  );
  if v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  insert into public.direct_entry_submissions (submission_id, created_by_user_id)
    values (v_submission_id, p_app_user_id);
  v_reason_id := null;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if v_row ? 'worker_details' and jsonb_typeof(v_row->'worker_details') <> 'object' then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_worker_input := coalesce(v_row->'worker_details', '{}'::jsonb);
    if v_worker_input - array[
      'gender','date_of_birth','national_id','national_id_issued_at',
      'national_id_issued_place','address','phone'
    ] <> '{}'::jsonb then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;

    v_project_id := v_row->>'project_id';
    v_recruiter_id := case
      when coalesce(v_row->>'recruiter_id','') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (v_row->>'recruiter_id')::uuid else null end;
    v_employee_code := v_row->>'employee_code';
    v_labor_type := v_row->>'labor_type';
    v_display_name := v_row->>'display_name';
    begin
      if coalesce(v_row->>'first_work_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'invalid date';
      end if;
      v_first_work_date := (v_row->>'first_work_date')::date;
      if to_char(v_first_work_date, 'YYYY-MM-DD') <> v_row->>'first_work_date' then
        raise exception 'invalid date';
      end if;
    exception when others then
      raise exception 'PROFILE_DATE_INVALID' using errcode = '22023';
    end;

    if v_project_id is null or v_project_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       or not exists (
         select 1 from public.direct_entry_projects p
          where p.project_id = v_project_id and p.active
       ) then
      raise exception 'PROJECT_NOT_ACTIVE' using errcode = '22023';
    end if;
    if v_recruiter_id is null or not exists (
      select 1 from public.recruiters r
       where r.recruiter_id = v_recruiter_id and r.active
    ) then
      raise exception 'RECRUITER_NOT_ACTIVE' using errcode = '22023';
    end if;
    if v_employee_code is null then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    elsif v_employee_code ~ '^hrp-[0-9]{4}-[0-9]+$'
       and v_employee_code !~ '^hrp-[0-9]{4}-[0-9]{6}$' then
      raise exception 'EMPLOYEE_CODE_LEGACY_QUARANTINE' using errcode = '22023';
    elsif v_employee_code !~ '^hrp-[0-9]{4}-[0-9]{6}$' then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    elsif substring(v_employee_code from 5 for 4) <> to_char(v_first_work_date, 'YYYY') then
      raise exception 'EMPLOYEE_CODE_YEAR' using errcode = '22023';
    end if;
    if v_employee_code = any(v_codes) then
      raise exception 'EMPLOYEE_CODE_DUPLICATE' using errcode = '22023';
    end if;
    v_codes := array_append(v_codes, v_employee_code);

    if p_contract_version = 'worker-profile/1.2' then
      if v_row ? 'display_name'
         and jsonb_typeof(v_row->'display_name') not in ('string', 'null') then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      v_display_name := coalesce(btrim(v_display_name, v_trim_chars), '');
      if length(v_display_name) > 256
         or coalesce(v_worker_input->'national_id'->>'state', '') <> 'provided'
         or coalesce(v_worker_input->'national_id'->>'value', '') !~ '^[0-9]{12}$'
         or v_worker_input->'national_id'->>'value' = '000000000000'
         or coalesce(v_row->'employment'->>'initial_status', 'ON') = 'OFF'
         or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
    elsif v_display_name is null or length(btrim(v_display_name)) not between 1 and 256
       or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_worker_details := jsonb_build_object(
      'display_name', v_display_name,
      'gender', coalesce(v_worker_input->'gender', '{"state":"omitted"}'::jsonb),
      'date_of_birth', coalesce(v_worker_input->'date_of_birth', '{"state":"omitted"}'::jsonb),
      'national_id', coalesce(v_worker_input->'national_id', '{"state":"omitted"}'::jsonb),
      'national_id_issued_at', coalesce(v_worker_input->'national_id_issued_at', '{"state":"omitted"}'::jsonb),
      'national_id_issued_place', '{"state":"provided","value":"Bộ Công An"}'::jsonb,
      'address', coalesce(v_worker_input->'address', '{"state":"omitted"}'::jsonb),
      'phone', coalesce(v_worker_input->'phone', '{"state":"omitted"}'::jsonb)
    );
    if not public.direct_entry_valid_worker_details(v_worker_details) then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_national_id := case
      when v_worker_details->'national_id'->>'state' = 'provided'
      then v_worker_details->'national_id'->>'value'
      else null
    end;
    if v_national_id is not null then
      v_national_ids := array_append(v_national_ids, v_national_id);
    end if;

    select count(*), min(m.provider_type) into v_count, v_provider_type
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(
         m.membership_id, public.direct_entry_authorization_date()
       );
    if v_count <> 1 then
      raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
    end if;
    if v_provider_type = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id
         and public.direct_entry__internal_recruiter_team_membership_effective(
           m.membership_id, public.direct_entry_authorization_date()
         );
      if v_count <> 1 then
        raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
      end if;
    end if;

    v_note := coalesce(v_row->'general_note', '{"state":"omitted"}'::jsonb);
    if jsonb_typeof(v_note) <> 'object'
       or v_note - array['state','value'] <> '{}'::jsonb
       or not (v_note ? 'state') then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_state := v_note->>'state';
    if v_state = 'provided' then
      v_general_note := v_note->>'value';
      if jsonb_typeof(v_note->'value') <> 'string'
         or not (v_note ? 'value')
         or length(btrim(v_general_note)) not between 1 and 4000 then
        raise exception 'GENERAL_NOTE_TOO_LONG' using errcode = '22023';
      end if;
    elsif v_state = 'omitted' then
      if v_note ? 'value' then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      v_general_note := null;
    else
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;

    v_payment := nullif(v_row->'payment', 'null'::jsonb);
    v_payment_state := null;
    v_account_number := null;
    v_bank_id := null;
    v_account_holder_name := null;
    if v_payment is not null then
      if jsonb_typeof(v_payment) <> 'object'
         or v_payment - array['state','account_number','bank_id','bank_name','account_holder_name'] <> '{}'::jsonb
         or not (v_payment ? 'state') then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
      v_payment_state := v_payment->>'state';
      if v_payment_state not in ('omitted','unknown','intentionally_blank','provided') then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
      v_account_number := nullif(btrim(v_payment->>'account_number', v_trim_chars), '');
      v_bank_id := nullif(btrim(v_payment->>'bank_id'), '');
      v_bank_name := nullif(btrim(v_payment->>'bank_name', v_trim_chars), '');
      v_account_holder_name := nullif(
        btrim(v_payment->>'account_holder_name', v_trim_chars), ''
      );
      if (v_payment ? 'account_number' and jsonb_typeof(v_payment->'account_number') not in ('string','null'))
         or (v_payment ? 'bank_id' and jsonb_typeof(v_payment->'bank_id') not in ('string','null'))
         or (v_payment ? 'bank_name' and jsonb_typeof(v_payment->'bank_name') not in ('string','null'))
         or (v_payment ? 'account_holder_name' and jsonb_typeof(v_payment->'account_holder_name') not in ('string','null'))
         or (v_account_number is not null and (length(v_account_number) not between 1 and 64
           or v_account_number ~ '[[:cntrl:]]'))
         or (v_bank_name is not null and (length(v_bank_name) not between 1 and 256
           or v_bank_name ~ '[[:cntrl:]]'))
         or (v_account_holder_name is not null and
           (length(v_account_holder_name) not between 1 and 256
             or v_account_holder_name ~ '[[:cntrl:]]'))
         or (v_bank_id is not null and
           v_bank_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
      if v_bank_id is not null and not exists (
        select 1 from public.direct_entry_banks b
         where b.bank_id = v_bank_id and b.active
      ) then
        raise exception 'BANK_NOT_ACTIVE' using errcode = '22023';
      end if;
      if v_payment_state <> 'provided' then
        if v_account_number is not null or v_bank_id is not null or v_bank_name is not null
           or v_account_holder_name is not null then
          raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
        end if;
      elsif v_account_number is null and v_bank_name is null and v_account_holder_name is null then
        if v_bank_id is not null then
          raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
        end if;
        v_payment_state := 'omitted';
      end if;
    end if;

    v_employment := nullif(v_row->'employment', 'null'::jsonb);
    v_status := null;
    v_leave_date := null;
    v_leave_reason_text := null;
    if v_employment is not null then
      if jsonb_typeof(v_employment) <> 'object'
         or v_employment - array['initial_status','leave_date','leave_reason_text'] <> '{}'::jsonb
         or not (v_employment ? 'initial_status') then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      v_status := v_employment->>'initial_status';
      if v_status not in ('UNCONFIRMED','ON','OFF') then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      if v_status = 'OFF' then
        begin
          if coalesce(v_employment->>'leave_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
            raise exception 'invalid date';
          end if;
          v_leave_date := (v_employment->>'leave_date')::date;
          if to_char(v_leave_date, 'YYYY-MM-DD') <> v_employment->>'leave_date' then
            raise exception 'invalid date';
          end if;
        exception when others then
          raise exception 'OFF_REQUIRES_DATE_AND_REASON' using errcode = '22023';
        end;
        v_leave_reason_text := v_employment->>'leave_reason_text';
        if v_leave_date < v_first_work_date or v_leave_date > v_auth_date
           or v_leave_reason_text is null
           or length(btrim(v_leave_reason_text)) not between 1 and 4000 then
          raise exception 'OFF_REQUIRES_DATE_AND_REASON' using errcode = '22023';
        end if;
      elsif v_employment ? 'leave_date' or v_employment ? 'leave_reason_text' then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
    end if;

    insert into public.direct_entry_candidates default values
      returning candidate_id into v_candidate_id;
    insert into public.direct_entries (
      submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
      employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type,
      general_note
    ) values (
      v_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
      v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type,
      v_labor_type, v_general_note
    ) returning entry_id into v_entry_id;

    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, version, actor_user_id, reason_id
    ) values (
      v_entry_id, case when v_status = 'UNCONFIRMED' then 'UNCONFIRMED' else 'ON' end, v_first_work_date, 1, p_app_user_id, v_reason_id
    );
    if v_status = 'OFF' then
      insert into public.direct_entry_employment_status_events (
        entry_id, status, effective_date, leave_date, leave_reason_text,
        version, actor_user_id, reason_id
      ) values (
        v_entry_id, v_status,
        case when v_status = 'OFF' then v_leave_date else v_first_work_date end,
        v_leave_date, v_leave_reason_text, 2, p_app_user_id, v_reason_id
      );
    end if;
    if v_payment_state is not null and v_payment_state <> 'omitted' then
      insert into public.direct_entry_payments (
        entry_id, state, account_number, bank_id, bank_name, account_holder_name
      ) values (
        v_entry_id, v_payment_state, v_account_number, v_bank_id, v_bank_name, v_account_holder_name
      );
    end if;

    v_revision_id := public.direct_entry_write_revision(
      v_entry_id, p_app_user_id, v_reason_id, null,
      public.direct_entry_entry_snapshot(v_entry_id), 1
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, revision_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'entry_create', 'entry_create',
      v_entry_id::text, 'own', 'APPLIED', v_reason_id, v_revision_id,
      array['entry_created','worker_details','general_note']
        || case when v_payment_state is not null and v_payment_state <> 'omitted'
             then array['payment']::text[] else '{}'::text[] end
        || case when v_status is not null
             then array['employment_status']::text[] else '{}'::text[] end
    );
    if p_contract_version = 'worker-profile/1.2' and v_national_id is not null then
      insert into public.direct_entry_cccd_reconciliations (
        entry_id, candidate_id, status, entered_national_id
      ) values (
        v_entry_id, v_candidate_id, 'PENDING', v_national_id
      )
      on conflict (entry_id) do update
        set entered_national_id = excluded.entered_national_id,
            updated_at = clock_timestamp();
    end if;
    v_entry_ids := v_entry_ids || jsonb_build_array(v_entry_id);
  end loop;

  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_submission_id, p_app_user_id, v_reason_id, null,
    jsonb_build_object('state','DRAFT','version',1,'entry_count',jsonb_array_length(p_rows)), 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'full_profile_batch_create', 'entry_create',
    v_submission_id::text, 'own', 'APPLIED', v_reason_id,
    v_submission_revision_id, array['submission_created','entries_created']
  );
  v_result := jsonb_build_object(
    'submission_id', v_submission_id,
    'state', 'DRAFT',
    'version', 1,
    'entry_ids', v_entry_ids,
    'replayed', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'full_profile_batch_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_create_full_profile_batch_with_portrait_stages(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_contract_version text,
  p_rows jsonb,
  p_idempotency_key text,
  p_stage_ids uuid[]
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage_id uuid;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
  v_result jsonb;
  v_submission_id uuid;
  v_linked integer;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) or not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  if p_idempotency_key is null or
     p_idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_stage_ids is null or cardinality(p_stage_ids) not between 1 and 400
     or exists (select 1 from unnest(p_stage_ids) id where id is null)
     or (select count(distinct id) from unnest(p_stage_ids) id) <> cardinality(p_stage_ids) then
    raise exception 'worker document stage batch invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':' || p_idempotency_key, 0)
  );
  for v_stage_id in select id from unnest(p_stage_ids) id order by id loop
    select * into v_stage
      from public.direct_entry_worker_portrait_stages
     where stage_id = v_stage_id and created_by_user_id = p_app_user_id
     for update;
    if not found then
      raise exception 'worker document stage not found' using errcode = '42501';
    end if;
    if v_stage.status not in ('CLAIMED', 'ATTACHED')
       or v_stage.claim_idempotency_key <> p_idempotency_key then
      raise exception 'worker document stage claim conflict' using errcode = 'PT409';
    end if;
  end loop;

  v_result := public.direct_entry_create_full_profile_batch_v2(
    p_auth_subject, p_app_user_id, p_contract_version, p_rows, p_idempotency_key
  );
  v_submission_id := (v_result->>'submission_id')::uuid;

  update public.direct_entry_worker_portrait_stages s
     set submission_id = v_submission_id
   where s.stage_id = any(p_stage_ids)
     and s.created_by_user_id = p_app_user_id
     and s.claim_idempotency_key = p_idempotency_key
     and (s.submission_id is null or s.submission_id = v_submission_id)
     and (
       s.status = 'CLAIMED'
       or (s.status = 'ATTACHED' and exists (
         select 1 from public.direct_entries e
          where e.entry_id = s.entry_id and e.submission_id = v_submission_id
       ))
     );
  get diagnostics v_linked = row_count;
  if v_linked <> cardinality(p_stage_ids) then
    raise exception 'worker document stage submission mismatch' using errcode = 'PT409';
  end if;

  return v_result;
end;
$function$;

create or replace function public.direct_entry_create_worker_document_stage_idempotent(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_document_type text,
  p_mime_type text,
  p_size_bytes bigint,
  p_checksum_sha256 text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
  v_key text := lower(p_idempotency_key);
  v_replayed boolean := false;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if not coalesce(v_authz_managed, false) or not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  if v_key is null or
     v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
     p_document_type not in ('WORKER_PORTRAIT', 'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT') or
     p_mime_type not in ('image/jpeg', 'image/png', 'application/pdf') or
     (p_document_type = 'WORKER_PORTRAIT' and p_mime_type = 'application/pdf') or
     p_size_bytes not between 1 and 10485760 or
     p_checksum_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'worker document stage invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':document-stage:' || v_key, 0)
  );
  select * into v_stage
    from public.direct_entry_worker_portrait_stages
   where created_by_user_id = p_app_user_id
     and create_idempotency_key = v_key
   for update;
  if found then
    if v_stage.document_type <> p_document_type or v_stage.mime_type <> p_mime_type or
       v_stage.size_bytes <> p_size_bytes or v_stage.checksum_sha256 <> p_checksum_sha256 then
      raise exception 'worker document stage idempotency conflict' using errcode = 'PT409';
    end if;
    v_replayed := true;
  else
    insert into public.direct_entry_worker_portrait_stages (
      stage_id, created_by_user_id, document_type, mime_type, size_bytes,
      checksum_sha256, create_idempotency_key
    ) values (
      p_stage_id, p_app_user_id, p_document_type, p_mime_type, p_size_bytes,
      p_checksum_sha256, v_key
    ) returning * into v_stage;
  end if;

  return jsonb_build_object(
    'stage', jsonb_build_object(
      'stage_id', v_stage.stage_id, 'document_type', v_stage.document_type,
      'mime_type', v_stage.mime_type, 'size_bytes', v_stage.size_bytes,
      'checksum_sha256', v_stage.checksum_sha256, 'status', v_stage.status,
      'claim_idempotency_key', v_stage.claim_idempotency_key,
      'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
    ),
    'replayed', v_replayed
  );
end;
$function$;

create or replace function public.direct_entry_create_worker_portrait_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_mime_type text,
  p_size_bytes bigint,
  p_checksum_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if not coalesce(v_authz_managed, false) or not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  if p_mime_type not in ('image/jpeg', 'image/png') or
     p_size_bytes not between 1 and 10485760 or
     p_checksum_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'portrait stage invalid' using errcode = '22023';
  end if;
  insert into public.direct_entry_worker_portrait_stages (
    stage_id, created_by_user_id, mime_type, size_bytes, checksum_sha256
  ) values (
    p_stage_id, p_app_user_id, p_mime_type, p_size_bytes, p_checksum_sha256
  ) returning * into v_stage;
  return jsonb_build_object(
    'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
    'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
    'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
    'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
  );
end;
$function$;


-- =============================================================================
-- SECTION 8 (Part 2): Direct Entry / Uploader / CCCD / CR Guards (#37-#56)
-- =============================================================================

create or replace function public.direct_entry_create_worker_portrait_stage_idempotent(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_mime_type text,
  p_size_bytes bigint,
  p_checksum_sha256 text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
  v_key text := lower(p_idempotency_key);
  v_replayed boolean := false;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if not coalesce(v_authz_managed, false) or not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  if v_key is null or
     v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
     p_mime_type not in ('image/jpeg', 'image/png') or
     p_size_bytes not between 1 and 10485760 or
     p_checksum_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'portrait stage invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':portrait-stage:' || v_key, 0)
  );
  select * into v_stage
    from public.direct_entry_worker_portrait_stages
   where created_by_user_id = p_app_user_id
     and create_idempotency_key = v_key
   for update;
  if found then
    if v_stage.mime_type <> p_mime_type or
       v_stage.size_bytes <> p_size_bytes or
       v_stage.checksum_sha256 <> p_checksum_sha256 then
      raise exception 'portrait stage idempotency conflict' using errcode = 'PT409';
    end if;
    v_replayed := true;
  else
    insert into public.direct_entry_worker_portrait_stages (
      stage_id, created_by_user_id, mime_type, size_bytes, checksum_sha256,
      create_idempotency_key
    ) values (
      p_stage_id, p_app_user_id, p_mime_type, p_size_bytes, p_checksum_sha256, v_key
    ) returning * into v_stage;
  end if;

  return jsonb_build_object(
    'stage', jsonb_build_object(
      'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
      'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
      'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
      'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
    ),
    'replayed', v_replayed
  );
end;
$function$;

create or replace function public.direct_entry_decide_change_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_decision text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_request public.direct_entry_change_requests%rowtype;
  v_item record;
  v_entry public.direct_entries%rowtype;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_revision_id uuid;
  v_audit_capability text := 'change_review';
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_decision not in ('APPROVED','REJECTED')
     or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid change decision input' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id;
  if not found then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  if v_request.proposer_user_id = p_app_user_id then
    raise exception 'change request proposer cannot review own request' using errcode = '42501';
  end if;

  perform public.direct_entry_assert_change_request_capabilities(
    p_auth_subject, p_app_user_id, p_request_id
  );

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  if exists(
    select 1 from public.direct_entry_change_request_items i
     where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID'
  ) then
    v_audit_capability := case
      when public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) is not null
        then 'team_manager_assign'
      when public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
        then 'entry_admin'
      when public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
        then 'entry_privileged_edit'
      else 'change_review'
    end;
  end if;

  for v_item in
    select i.entry_id, i.target_kind from public.direct_entry_change_request_items i
     where i.request_id = p_request_id
  loop
    select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
    if not found then raise exception 'entry not found' using errcode = 'P0002'; end if;
    if v_item.target_kind <> 'ENTRY_VOID'
       and public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) is null then
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'change_review',
        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
      );
    end if;
  end loop;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'change_request_' || lower(p_decision), p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'request_id', p_request_id, 'version', p_expected_version,
      'decision', p_decision, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;

  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id for update;
  if not found or v_request.state <> 'PENDING'
     or v_request.version <> p_expected_version then
    raise exception 'change request version conflict' using errcode = 'PT409';
  end if;
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  if p_decision = 'APPROVED' then
    for v_item in
      select i.* from public.direct_entry_change_request_items i
       where i.request_id = p_request_id order by i.entry_id for update
    loop
      select * into v_entry from public.direct_entries
       where entry_id = v_item.entry_id for update;
      if not found or v_entry.deleted_at is not null or v_entry.voided_at is not null
         or v_entry.version <> v_item.expected_version then
        raise exception 'change item version conflict' using errcode = 'PT409';
      end if;
      perform public.direct_entry_apply_change_item(
        p_auth_subject, p_app_user_id, p_request_id, v_entry,
        v_item.target_kind, v_item.proposal, v_reason_id
      );
    end loop;
  else
    for v_item in
      select i.entry_id, i.target_kind from public.direct_entry_change_request_items i
       where i.request_id = p_request_id
    loop
      select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
      if v_item.target_kind <> 'ENTRY_VOID'
         and public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) is null then
        perform public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'change_review',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    end loop;
  end if;
  v_revision_id := public.direct_entry_write_change_request_revision(
    p_request_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state', v_request.state, 'version', v_request.version),
    jsonb_build_object('state', p_decision, 'version', v_request.version + 1),
    v_request.version + 1
  );
  update public.direct_entry_change_requests
     set state = p_decision, version = version + 1,
         decided_by_user_id = p_app_user_id, decided_at = now(),
         decision_reason_id = v_reason_id
   where request_id = p_request_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    outcome, reason_id, change_request_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'change_request_' || lower(p_decision),
    v_audit_capability, p_request_id::text, 'APPLIED', v_reason_id, v_revision_id,
    array['state','version']
  );
  v_result := jsonb_build_object(
    'request_id', p_request_id, 'state', p_decision, 'version', v_request.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'change_request_' || lower(p_decision), p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_delete_draft_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_submission public.direct_entry_submissions%rowtype;
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_prior jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_deleted_at timestamptz := clock_timestamp();
  v_deleted_entries integer := 0;
  v_cleanup_objects integer := 0;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
  if not exists (
    select 1
      from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
     where g.capability = 'submission_create'
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from pg_catalog.jsonb_to_recordset(v_grants) as g(
        capability text,
        scope_kind text,
        scope_id text
      )
     where g.capability = 'submission_create'
       and g.scope_kind in ('OWN', 'ALL')
       and g.scope_id is null
  ) then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'submission_id', p_submission_id,
    'expected_version', p_expected_version
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_submission_delete', p_idempotency_key, v_request_hash
  );
  if v_prior is not null then return v_prior; end if;

  perform 1
    from public.direct_entries e
   where e.submission_id = p_submission_id and e.deleted_at is null
   order by e.entry_id
   for update;

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id
   for update;
  if not found or v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.state <> 'DRAFT' then
    raise exception 'submission is not a draft' using errcode = '55000';
  end if;
  if p_expected_version is null or p_expected_version <> v_submission.version then
    raise exception 'submission version conflict' using errcode = 'PT409';
  end if;
  if exists (
    select 1 from public.direct_entry_worker_portrait_stages s
     where s.submission_id = p_submission_id and s.status = 'CLAIMED'
  ) then
    raise exception 'submission document processing' using errcode = '55P03';
  end if;

  if not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null)
  ) then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;

  v_before := jsonb_build_object(
    'state', v_submission.state,
    'version', v_submission.version,
    'entry_count', (
      select count(*)::int from public.direct_entries e
       where e.submission_id = p_submission_id and e.deleted_at is null
    ),
    'submitted_at', v_submission.submitted_at
  );
  v_reason_id := null;

  for v_entry in
    select e.* from public.direct_entries e
     where e.submission_id = p_submission_id and e.deleted_at is null
     order by e.entry_id
  loop
    v_scope := public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
      v_entry.team_id, v_entry.first_work_date, 'own'
    );
    if v_scope <> 'own' then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
    v_after := public.direct_entry_entry_snapshot(v_entry.entry_id);
    update public.direct_entries
       set deleted_at = v_deleted_at, version = version + 1
     where entry_id = v_entry.entry_id;
    v_revision_id := public.direct_entry_write_revision(
      v_entry.entry_id, p_app_user_id, v_reason_id, v_after,
      public.direct_entry_entry_snapshot(v_entry.entry_id), v_entry.version + 1
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, revision_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'draft_submission_delete', 'submission_create',
      v_entry.entry_id::text, 'own', 'APPLIED', v_reason_id, v_revision_id,
      array['deleted_at']
    );
    v_deleted_entries := v_deleted_entries + 1;
  end loop;

  insert into public.direct_entry_submission_object_cleanup (
    submission_id, object_kind, stage_id
  )
  select p_submission_id, 'PORTRAIT_STAGE', s.stage_id
    from public.direct_entry_worker_portrait_stages s
   where s.submission_id = p_submission_id and s.status = 'ATTACHED'
  on conflict do nothing;

  insert into public.direct_entry_submission_object_cleanup (
    submission_id, object_kind, document_id, storage_key
  )
  select p_submission_id, kinds.object_kind, d.document_id, d.storage_key
    from public.direct_entry_document_versions d
    join public.direct_entries e on e.candidate_id = d.candidate_id
    cross join (values ('DOCUMENT_STAGED'), ('DOCUMENT_FINAL')) as kinds(object_kind)
   where e.submission_id = p_submission_id
     and not exists (
       select 1 from public.direct_entries other
        where other.candidate_id = d.candidate_id
          and other.submission_id <> p_submission_id
     )
  on conflict do nothing;

  update public.direct_entry_submissions
     set state = 'DELETED', version = version + 1
   where submission_id = p_submission_id;
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    p_submission_id, p_app_user_id, v_reason_id, v_before,
    jsonb_build_object(
      'state', 'DELETED',
      'version', v_submission.version + 1,
      'entry_count', 0,
      'deleted_entry_count', v_deleted_entries,
      'deleted_at', v_deleted_at
    ),
    v_submission.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'draft_submission_delete', 'submission_create',
    p_submission_id::text, 'own', 'APPLIED', v_reason_id,
    v_submission_revision_id, array['state', 'entries_deleted']
  );

  select count(*)::int into v_cleanup_objects
    from public.direct_entry_submission_object_cleanup c
   where c.submission_id = p_submission_id and c.cleanup_completed_at is null;
  v_result := jsonb_build_object(
    'submission_id', p_submission_id,
    'deleted', true,
    'version', v_submission.version + 1,
    'entries_deleted', v_deleted_entries,
    'cleanup_objects_queued', v_cleanup_objects
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_submission_delete', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_document_direct_context(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_document_id uuid,
  p_purpose text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_entry public.direct_entries%rowtype;
  v_document public.direct_entry_document_versions%rowtype;
  v_scope text;
  v_latest public.direct_entry_document_events%rowtype;
begin
  if p_purpose not in ('finalize', 'download', 'preview', 'cccd_preview') then
    raise exception 'invalid document context purpose' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries
   where entry_id = p_entry_id and deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  if p_purpose = 'finalize' then
    perform public.direct_entry_assert_document_upload_access(
      p_auth_subject, p_app_user_id, p_entry_id
    );
  else
    if p_purpose = 'download' then
      v_scope := public.direct_entry_assert_document_download_access(
        p_auth_subject, p_app_user_id, v_entry.entry_id, p_document_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
    elsif p_purpose = 'cccd_preview' then
      select * into v_document from public.direct_entry_document_versions d
       where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
      if not found or v_document.document_type not in ('CCCD_FRONT', 'CCCD_BACK') then
        raise exception 'document is not a CCCD image' using errcode = 'P0002';
      end if;
      v_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_scope is null and v_entry.created_by_user_id = p_app_user_id
         and exists (
           select 1
             from public.direct_entry_cccd_reconciliations r
            where r.entry_id = v_entry.entry_id
         ) then
        v_scope := 'own';
      end if;
      if v_scope is null then
        v_scope := public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'document_view',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    else
      select * into v_document from public.direct_entry_document_versions d
       where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
      if not found then
        raise exception 'document not found' using errcode = 'P0002';
      end if;
      if v_document.document_type <> 'WORKER_PORTRAIT' then
        raise exception 'private preview is portrait-only' using errcode = 'P0002';
      end if;
      v_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_scope is null then
        v_scope := public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'entry_privileged_edit',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    end if;

    select coalesce(u.authz_managed, false)
      into v_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id;

    if not coalesce(v_authz_managed, false) or not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
      or (
        (v_scope = 'own' or v_entry.created_by_user_id = p_app_user_id)
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
      )
      or (
        v_scope in ('team', 'team_review')
        and (
          (
            v_entry.team_id is not null
            and public.direct_entry_authz__internal_has_paired_capability(
              p_app_user_id, 'document_view', 'CONTEXT_TEAM', v_entry.team_id::text
            )
          )
          or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
        )
      )
      or (
        v_scope = 'project'
        and (
          public.direct_entry_authz__internal_has_paired_capability(
            p_app_user_id, 'document_view', 'CONTEXT_PROJECT', v_entry.project_id
          )
          or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
        )
      )
      or (
        v_scope = 'recruited'
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
      )
    ) then
      raise exception 'document view denied' using errcode = '42501';
    end if;
  end if;

  select * into v_document from public.direct_entry_document_versions d
   where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  select * into v_latest from public.direct_entry_document_events e
   where e.document_id = p_document_id order by e.version desc limit 1;
  if p_purpose = 'download' and v_document.document_type = 'WORKER_PORTRAIT' then
    raise exception 'portrait requires private preview' using errcode = 'P0002';
  end if;
  if p_purpose = 'preview' and (
    v_document.document_type <> 'WORKER_PORTRAIT'
    or not exists (
      select 1 from public.direct_entry_current_documents cd
       where cd.document_id = p_document_id
         and cd.candidate_id = v_entry.candidate_id
         and cd.document_type = 'WORKER_PORTRAIT'
    )
  ) then
    raise exception 'portrait is not current' using errcode = 'P0002';
  end if;
  if p_purpose in ('download', 'preview', 'cccd_preview') and not (
    v_latest.upload_status = 'READY' and v_latest.validation_status = 'VALIDATED'
    and v_latest.scan_status in ('CLEAN', 'NOT_REQUIRED')
  ) then
    raise exception 'document not eligible' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'document_id', v_document.document_id, 'document_type', v_document.document_type,
    'version', v_document.version, 'storage_key', v_document.storage_key,
    'size_bytes', coalesce((
      select o.size_bytes from public.direct_entry_document_objects o
       where o.document_id = v_document.document_id
    ), v_document.size_bytes),
    'mime_type', v_document.mime_type,
    'checksum_sha256', (
      select o.checksum_sha256 from public.direct_entry_document_objects o
       where o.document_id = v_document.document_id
    ),
    'upload_status', v_latest.upload_status, 'scan_status', v_latest.scan_status,
    'validation_status', v_latest.validation_status, 'entry_version', v_entry.version
  );
end;
$function$;

create or replace function public.direct_entry_duplicate_cccd_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page integer,
  p_page_size integer,
  p_managed_only boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_can_withdraw_all boolean := false;
  v_authority text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_managed_only boolean := coalesce(p_managed_only, false);
  v_offset integer;
  v_is_full_admin boolean := false;
  v_current_team_leader_team_id uuid;
  v_total_groups integer := 0;
  v_total_entries integer := 0;
  v_rows jsonb;
  v_has_more boolean := false;
  v_groups jsonb;
begin
  if v_page < 1 or v_page > 1000 then
    raise exception 'duplicate_report_page_invalid' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'duplicate_report_page_size_invalid' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  v_authority :=
    public.direct_entry_assert_duplicate_cccd_reader(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_can_withdraw_all :=
    coalesce(v_authz_managed, false)
    and public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, 'duplicate_cccd_withdraw', 'ALL', null
    );

  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    v_is_full_admin := false;
  end;

  begin
    v_current_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    v_current_team_leader_team_id := null;
  end;

  with canonical as (
    select e.entry_id,
           e.version as entry_version,
           e.submission_id,
           e.created_by_user_id,
           e.team_id,
           e.project_id,
           e.employee_code,
           e.first_work_date,
           nullif(btrim(coalesce(e.worker_details->>'display_name', '')), '') as display_name,
           public.direct_entry_canonical_national_id(
             e.worker_details->'national_id'->>'value'
           ) as cccd
      from public.direct_entries e
     where e.deleted_at is null and e.voided_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
  ),
  statused as (
    select c.entry_id,
           c.entry_version,
           c.submission_id,
           c.created_by_user_id,
           c.team_id,
           c.project_id,
           c.employee_code,
           c.first_work_date,
           c.display_name,
           c.cccd,
           coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = c.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') as latest_status,
           case
             when c.project_id is not null and c.first_work_date is not null then
               count(*) over (
                 partition by c.cccd, c.project_id, c.first_work_date
               )
             else 1
           end as same_project_day_count
      from canonical c
     where public.direct_entry_is_canonical_national_id(c.cccd)
  ),
  live as (
    select s.entry_id,
           s.entry_version,
           s.submission_id,
           s.created_by_user_id,
           s.team_id,
           s.project_id,
           s.employee_code,
           s.first_work_date,
           s.display_name,
           s.cccd,
           s.latest_status
      from statused s
     where s.same_project_day_count >= 2
  ),
  managed_projects as (
    select distinct l.project_id
      from live l
     where v_managed_only
       and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, l.project_id)
  ),
  grouped as (
    select l.cccd,
           count(*)::int as profile_count,
           count(distinct l.project_id)::int as project_count,
           count(*) filter (where l.latest_status = 'ON')::int as active_profile_count,
           min(l.first_work_date) as earliest_first_work_date,
           max(l.first_work_date) as latest_first_work_date
      from live l
     group by l.cccd
    having count(*) >= 2
       and (
         not v_managed_only
         or bool_or(exists (
           select 1 from managed_projects mp where mp.project_id = l.project_id
         ))
       )
  ),
  page_groups as (
    select g.*
      from grouped g
     order by g.cccd
     limit v_page_size + 1
    offset v_offset
  )
  select coalesce((select count(*)::int from grouped), 0),
         coalesce((select sum(g.profile_count)::int from grouped g), 0),
         coalesce((
           select jsonb_agg(gp.row_json order by gp.cccd)
             from (
               select pg.cccd,
                      jsonb_build_object(
                        'cccd_last4', right(pg.cccd, 4),
                        'cccd_length', length(pg.cccd),
                        'profile_count', pg.profile_count,
                        'project_count', pg.project_count,
                        'active_profile_count', pg.active_profile_count,
                        'first_work_date',
                          pg_catalog.to_char(pg.earliest_first_work_date, 'YYYY-MM-DD'),
                        'latest_first_work_date',
                          pg_catalog.to_char(pg.latest_first_work_date, 'YYYY-MM-DD'),
                        'episodes', coalesce((
                          select jsonb_agg(jsonb_build_object(
                                   'entry_id', l.entry_id,
                                   'entry_version', l.entry_version,
                                   'employee_code', l.employee_code,
                                   'display_name', l.display_name,
                                   'project_id', l.project_id,
                                   'project_display', pj.display_name,
                                   'first_work_date',
                                     pg_catalog.to_char(l.first_work_date, 'YYYY-MM-DD'),
                                   'latest_status', l.latest_status,
                                   'active', l.latest_status = 'ON',
                                   'can_mark_off', (
                                     l.latest_status = 'ON'
                                     and coalesce(sub.state, '') in ('DRAFT', 'SUBMITTED')
                                     and public.direct_entry_resolve_direct_edit_authority(
                                       p_auth_subject,
                                       p_app_user_id,
                                       l.created_by_user_id,
                                       l.team_id,
                                       l.project_id,
                                       v_is_full_admin,
                                       v_current_team_leader_team_id
                                     ) is not null
                                   ),
                                   'can_self_withdraw', (
                                     l.latest_status in ('ON','OFF')
                                     and exists (
                                       select 1
                                         from statused same_day_active
                                        where same_day_active.entry_id <> l.entry_id
                                          and same_day_active.cccd = l.cccd
                                          and same_day_active.project_id = l.project_id
                                          and same_day_active.first_work_date = l.first_work_date
                                          and same_day_active.latest_status in ('ON','OFF')
                                     )
                                     and (
                                       l.created_by_user_id = p_app_user_id
                                       or v_can_withdraw_all
                                       or public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, l.project_id)
                                     )
                                   )
                                 ) order by l.first_work_date asc, l.entry_id asc)
                            from live l
                            left join public.direct_entry_projects pj
                              on pj.project_id = l.project_id
                            left join public.direct_entry_submissions sub
                              on sub.submission_id = l.submission_id
                           where l.cccd = pg.cccd
                        ), '[]'::jsonb)
                      ) as row_json
                 from page_groups pg
             ) gp
         ), '[]'::jsonb)
    into v_total_groups, v_total_entries, v_rows;

  v_has_more := jsonb_array_length(v_rows) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb)
      into v_groups
      from jsonb_array_elements(v_rows) with ordinality as t(value, ord)
     where t.ord <= v_page_size;
  else
    v_groups := v_rows;
  end if;

  return jsonb_build_object(
    'authority', v_authority,
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total_groups', v_total_groups,
    'total_entries', v_total_entries,
    'has_more', v_has_more,
    'groups', v_groups
  );
end;
$function$;

create or replace function public.direct_entry_has_entry_access(
  p_app_user_id uuid,
  p_capability text,
  p_entry_owner uuid,
  p_team_id uuid,
  p_effective_date date
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_enabled boolean := false;
  v_authz_managed boolean := false;
  v_grants jsonb := '[]'::jsonb;
begin
  if p_app_user_id is null
     or p_capability is null
     or pg_catalog.btrim(p_capability) = ''
     or p_capability in ('pii_view', 'pii_export', 'payment_view', 'payment_edit') then
    return false;
  end if;

  select u.enabled, coalesce(u.authz_managed, false)
    into v_enabled, v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not coalesce(v_enabled, false) or not coalesce(v_authz_managed, false) then
    return false;
  end if;

  v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
  return exists (
    select 1
      from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text, scope_kind text, scope_id text)
     where g.capability = p_capability
       and (
         (g.scope_kind = 'ALL' and g.scope_id is null)
         or (g.scope_kind = 'OWN' and g.scope_id is null and p_entry_owner = p_app_user_id)
         or (
           g.scope_kind = 'CONTEXT_TEAM'
           and p_team_id is not null
           and g.scope_id = p_team_id::text
           and exists (
             select 1
               from public.teams t
              where t.team_id = p_team_id
                and t.active
                and t.code <> '__system_vendor__'
           )
         )
       )
  );
end;
$function$;

create or replace function public.direct_entry_list_cccd_review_queue(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_status_filter text default 'NEEDS_REVIEW'::text,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_filter text := coalesce(nullif(btrim(p_status_filter), ''), 'NEEDS_REVIEW');
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_is_full_admin boolean := false;
  v_team_leader_team_id uuid := null;
  v_has_any_role boolean := false;
  v_counts jsonb;
  v_total integer := 0;
  v_rows jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
begin
  if v_filter not in ('NEEDS_REVIEW', 'MISMATCH', 'QR_UNREADABLE', 'PENDING', 'RESOLVED', 'ALL') then
    raise exception 'invalid cccd review status filter' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid cccd review page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid cccd review page size' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    v_is_full_admin := false;
  end;

  begin
    v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    v_team_leader_team_id := null;
  end;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'cccd review queue denied' using errcode = '42501';
  end if;

  v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
  v_has_any_role := v_is_full_admin
    or v_team_leader_team_id is not null
    or exists (
      select 1
        from pg_catalog.jsonb_to_recordset(v_grants) as g(
          capability text,
          scope_kind text,
          scope_id text
        )
       where g.capability in (
         'entry_create',
         'entry_own',
         'submission_create',
         'document_upload',
         'document_view',
         'entry_privileged_edit',
         'entry_admin',
         'change_review',
         'change_request_create'
       )
         and (
           (g.scope_kind = 'ALL' and g.scope_id is null)
           or (g.scope_kind = 'OWN' and g.scope_id is null)
           or (g.scope_kind = 'CONTEXT_TEAM' and g.scope_id is not null)
           or (g.scope_kind = 'CONTEXT_PROJECT' and g.scope_id is not null)
         )
    )
    or public.direct_entry_actor_has_project_assignment(p_app_user_id);

  if not v_has_any_role then
    raise exception 'cccd review queue denied' using errcode = '42501';
  end if;

  with scoped as (
    select r.*,
           e.version as entry_version,
           e.submission_id,
           e.project_id,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.recruiter_id,
           e.team_id,
           e.provider_type,
           e.labor_type,
           e.created_by_user_id,
           public.direct_entry__internal_resolve_cccd_review_authority(
             p_auth_subject,
             p_app_user_id,
             e.created_by_user_id,
             e.team_id,
             e.project_id,
             v_is_full_admin,
             v_team_leader_team_id
           ) as actor_authority
      from public.direct_entry_cccd_reconciliations r
      join public.direct_entries e
        on e.entry_id = r.entry_id
     where e.deleted_at is null
       and e.voided_at is null
  ),
  authorized as (
    select s.*
      from scoped s
     where s.actor_authority is not null
  ),
  filtered as (
    select a.*
      from authorized a
     where (
       (v_filter = 'NEEDS_REVIEW' and a.status in ('MISMATCH', 'QR_UNREADABLE'))
       or (v_filter = 'MISMATCH' and a.status = 'MISMATCH')
       or (v_filter = 'QR_UNREADABLE' and a.status = 'QR_UNREADABLE')
       or (v_filter = 'PENDING' and a.status = 'PENDING')
       or (v_filter = 'RESOLVED' and a.status in ('MATCHED_INITIAL', 'RESOLVED_FROM_QR', 'RESOLVED_EDITED_CCCD'))
       or v_filter = 'ALL'
     )
  ),
  paged as (
    select f.*
      from filtered f
     order by
       case f.status
         when 'MISMATCH' then 0
         when 'QR_UNREADABLE' then 1
         when 'PENDING' then 2
         else 3
       end asc,
       f.updated_at desc,
       f.entry_id asc
     limit v_page_size + 1
    offset v_offset
  )
  select jsonb_build_object(
           'needs_review', count(*) filter (where a.status in ('MISMATCH', 'QR_UNREADABLE'))::int,
           'mismatch', count(*) filter (where a.status = 'MISMATCH')::int,
           'qr_unreadable', count(*) filter (where a.status = 'QR_UNREADABLE')::int,
           'pending', count(*) filter (where a.status = 'PENDING')::int,
           'resolved', count(*) filter (where a.status in ('MATCHED_INITIAL', 'RESOLVED_FROM_QR', 'RESOLVED_EDITED_CCCD'))::int,
           'all', count(*)::int
         ),
         coalesce((select count(*)::int from filtered), 0),
         coalesce((
           select jsonb_agg(item_row.item_json order by item_row.ord)
             from (
               select row_number() over (
                        order by
                          case p.status
                            when 'MISMATCH' then 0
                            when 'QR_UNREADABLE' then 1
                            when 'PENDING' then 2
                            else 3
                          end asc,
                          p.updated_at desc,
                          p.entry_id asc
                      ) as ord,
                      jsonb_build_object(
                        'entry_id', p.entry_id,
                        'entry_version', p.entry_version,
                        'submission_state', coalesce(sub.state, 'DRAFT'),
                        'employee_code', p.employee_code,
                        'project_id', p.project_id,
                        'project_display', coalesce(pj.display_name, p.project_id),
                        'recruiter_id', p.recruiter_id,
                        'recruiter_display', coalesce(rec.display_name, ''),
                        'team_id', case when p.provider_type = 'vendor' then null else p.team_id end,
                        'team_display', case
                          when p.provider_type = 'vendor' then 'Không áp dụng'
                          else coalesce(tm.display_name, '')
                        end,
                        'provider_type', p.provider_type,
                        'labor_type', p.labor_type,
                        'first_work_date', to_char(p.first_work_date, 'YYYY-MM-DD'),
                        'created_by_user_id', p.created_by_user_id,
                        'created_by_display', coalesce(creator.display_name, ''),
                        'actor_authority', p.actor_authority,
                        'reconciliation_status', p.status,
                        'entered_national_id', p.entered_national_id,
                        'entered_national_id_masked', case
                          when p.entered_national_id is not null and length(p.entered_national_id) >= 4
                            then '••••••••' || right(p.entered_national_id, 4)
                          else null
                        end,
                        'qr_national_id', p.qr_national_id,
                        'qr_national_id_masked', case
                          when p.qr_national_id is not null and length(p.qr_national_id) >= 4
                            then '••••••••' || right(p.qr_national_id, 4)
                          else null
                        end,
                        'worker_details', jsonb_build_object(
                          'display_name', coalesce(p.worker_details->>'display_name', ''),
                          'date_of_birth', coalesce(p.worker_details->'date_of_birth', '{"state":"omitted"}'::jsonb),
                          'gender', coalesce(p.worker_details->'gender', '{"state":"omitted"}'::jsonb),
                          'address', coalesce(p.worker_details->'address', '{"state":"omitted"}'::jsonb),
                          'phone', coalesce(p.worker_details->'phone', '{"state":"omitted"}'::jsonb),
                          'national_id_issued_at', coalesce(p.worker_details->'national_id_issued_at', '{"state":"omitted"}'::jsonb),
                          'national_id_issued_place', coalesce(p.worker_details->'national_id_issued_place', '{"state":"omitted"}'::jsonb)
                        ),
                        'extracted_fields', coalesce(p.extracted_fields, '{}'::jsonb),
                        'auto_applied_fields', to_jsonb(coalesce(p.auto_applied_fields, '{}'::text[])),
                        'matched_document_id', p.matched_document_id,
                        'matched_document_type', p.matched_document_type,
                        'matched_document_version', p.matched_document_version,
                        'last_error_code', p.last_error_code,
                        'last_error_field', p.last_error_field,
                        'resolved_at', case
                          when p.resolved_at is null then null
                          else to_char(p.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                        end,
                        'resolved_by_user_id', p.resolved_by_user_id,
                        'resolved_by_display', resolver.display_name,
                        'resolution_action', p.resolution_action,
                        'resolution_note', p.resolution_note,
                        'updated_at', to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                        'documents', coalesce((
                          select jsonb_agg(
                                   jsonb_build_object(
                                     'document_id', cd.document_id,
                                     'document_type', cd.document_type,
                                     'document_version', cd.version,
                                     'mime_type', cd.mime_type,
                                     'size_bytes', cd.size_bytes,
                                     'qr_status', q.status,
                                     'qr_reconciliation_status', q.reconciliation_status,
                                     'qr_error_code', q.error_code,
                                     'qr_error_field', q.error_field,
                                     'qr_candidate_data', q.candidate_data
                                   )
                                   order by
                                     case when cd.document_type = 'CCCD_FRONT' then 0 else 1 end asc,
                                     cd.version desc
                                 )
                            from public.direct_entry_current_documents cd
                            left join public.direct_entry_cccd_qr_extractions q
                              on q.document_id = cd.document_id
                           where cd.candidate_id = p.candidate_id
                             and cd.document_type in ('CCCD_FRONT', 'CCCD_BACK')
                             and cd.mime_type in ('image/jpeg', 'image/png')
                        ), '[]'::jsonb)
                      ) as item_json
                 from paged p
                 left join public.direct_entry_submissions sub on sub.submission_id = p.submission_id
                 left join public.direct_entry_projects pj on pj.project_id = p.project_id
                 left join public.recruiters rec on rec.recruiter_id = p.recruiter_id
                 left join public.teams tm on tm.team_id = p.team_id
                 left join public.direct_entry_app_users creator on creator.app_user_id = p.created_by_user_id
                 left join public.direct_entry_app_users resolver on resolver.app_user_id = p.resolved_by_user_id
             ) item_row
         ), '[]'::jsonb)
    into v_counts, v_total, v_rows
    from authorized a;

  v_has_more := jsonb_array_length(v_rows) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb)
      into v_items
      from jsonb_array_elements(v_rows) with ordinality as t(value, ord)
     where t.ord <= v_page_size;
  else
    v_items := v_rows;
  end if;

  return jsonb_build_object(
    'status_filter', v_filter,
    'page', v_page,
    'page_size', v_page_size,
    'total_items', v_total,
    'has_more', v_has_more,
    'counts', v_counts,
    'items', v_items
  );
end;
$function$;

create or replace function public.direct_entry_list_global_change_request_history(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page_size integer,
  p_cursor text,
  p_days integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_page_size integer := coalesce(p_page_size, 20);
  v_cursor_stamp text;
  v_cursor_id uuid;
  v_scanned integer;
  v_rows jsonb;
  v_next_cursor text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) or not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
  ) then
    raise exception 'global change request history denied' using errcode = '42501';
  end if;

  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_days is not null and p_days not in (3, 7, 30) then
    raise exception 'invalid history window' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with candidates as (
    select r.request_id, r.state, r.version, r.created_at, r.decided_at,
           coalesce(nullif(btrim(decider.display_name), ''), 'Người dùng') as decided_by_display_name,
           coalesce(nullif(btrim(proposer.display_name), ''), 'Người dùng') as proposer_display_name,
           (select string_agg(distinct case i.target_kind
              when 'ENTRY_FIELD' then 'Thông tin người lao động'
              when 'WORKER' then 'Thông tin người lao động'
              when 'PAYMENT' then 'Thông tin ngân hàng'
              when 'WORK_STATUS' then 'Trạng thái làm việc'
              when 'DOCUMENT' then 'Tài liệu hồ sơ'
              else 'Yêu cầu thay đổi' end, ' · ' order by case i.target_kind
              when 'ENTRY_FIELD' then 'Thông tin người lao động'
              when 'WORKER' then 'Thông tin người lao động'
              when 'PAYMENT' then 'Thông tin ngân hàng'
              when 'WORK_STATUS' then 'Trạng thái làm việc'
              when 'DOCUMENT' then 'Tài liệu hồ sơ'
              else 'Yêu cầu thay đổi' end)
              from public.direct_entry_change_request_items i where i.request_id = r.request_id) as summary
      from public.direct_entry_change_requests r
      join public.direct_entry_app_users proposer on proposer.app_user_id = r.proposer_user_id
      join public.direct_entry_app_users decider on decider.app_user_id = r.decided_by_user_id
     where r.state in ('APPROVED', 'REJECTED')
       and (p_days is null or r.decided_at >= now() - pg_catalog.make_interval(days => p_days))
       and (v_cursor_stamp is null or (
         pg_catalog.to_char(r.decided_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
         r.request_id::text
       ) < (v_cursor_stamp, v_cursor_id::text))
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.decided_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
             || ':' || c.request_id::text as cursor
      from candidates c
     order by c.decided_at desc, c.request_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by decided_at desc, request_id desc limit v_page_size
  )
  select (select count(*)::int from page),
    (select coalesce(jsonb_agg(jsonb_build_object(
       'request_id', t.request_id, 'state', t.state, 'version', t.version,
       'created_at', pg_catalog.to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD')
         || 'T' || pg_catalog.to_char(t.created_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z',
       'item_count', (select count(*)::int from public.direct_entry_change_request_items i
                       where i.request_id = t.request_id),
       'entry_ids', (select coalesce(jsonb_agg(i.entry_id order by i.entry_id), '[]'::jsonb)
                       from public.direct_entry_change_request_items i
                      where i.request_id = t.request_id),
       'can_withdraw', false, 'can_decide', false,
       'proposer_display_name', t.proposer_display_name,
       'summary', t.summary,
       'decided_by_display_name', t.decided_by_display_name,
       'decided_at', pg_catalog.to_char(t.decided_at at time zone 'UTC', 'YYYY-MM-DD')
         || 'T' || pg_catalog.to_char(t.decided_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z'
     ) order by t.decided_at desc, t.request_id desc), '[]'::jsonb) from trimmed t),
    (select t.cursor from trimmed t order by t.decided_at asc, t.request_id asc limit 1)
  into v_scanned, v_rows, v_next_cursor;

  return jsonb_build_object(
    'requests', v_rows,
    'page_size', v_page_size,
    'has_more', v_scanned > v_page_size,
    'next_cursor', case when v_scanned > v_page_size then v_next_cursor else null end
  );
end;
$function$;

create or replace function public.direct_entry_list_own_drafts(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_result jsonb;
  v_count integer;
  v_employment_apply boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_employment_apply :=
    coalesce(v_authz_managed, false)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'employment_status.apply', 'ALL', null);

  select count(*) into v_count
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
   where s.state = 'DRAFT'
     and e.deleted_at is null
     and public.direct_entry_resolve_draft_scope(
       p_auth_subject, p_app_user_id, e.entry_id
     ) is not null;
  if v_count > 500 then
    raise exception 'draft list exceeds supported size' using errcode = '54000';
  end if;

  with eligible as materialized (
    select e.*, s.version as submission_version,
           (s.created_by_user_id = p_app_user_id and e.created_by_user_id = p_app_user_id)
             as own_submission,
           p.display_name as project_display_name,
           r.display_name as recruiter_display_name,
           t.display_name as team_display_name
      from public.direct_entries e
      join public.direct_entry_submissions s on s.submission_id = e.submission_id
      join public.direct_entry_projects p on p.project_id = e.project_id
      join public.recruiters r on r.recruiter_id = e.recruiter_id
      join public.teams t on t.team_id = e.team_id
     where s.state = 'DRAFT'
       and e.deleted_at is null
       and public.direct_entry_resolve_draft_scope(
         p_auth_subject, p_app_user_id, e.entry_id
       ) is not null
  ),
  authorized as materialized (
    select e.*,
           public.direct_entry_resolve_draft_scope(
             p_auth_subject, p_app_user_id, e.entry_id
           ) as resolved_scope
      from eligible e
  )
  select jsonb_build_object(
    'projection_version', 'direct-entry-draft-list/2',
    'drafts', coalesce(jsonb_agg(jsonb_build_object(
      'submission_id', e.submission_id,
      'submission_version', e.submission_version,
      'entry_id', e.entry_id,
      'entry_version', e.version,
      'employee_code', e.employee_code,
      'first_work_date', e.first_work_date,
      'worker_display_name', case when e.own_submission then e.worker_details->>'display_name' else '' end,
      'project_id', e.project_id,
      'project_display_name', e.project_display_name,
      'recruiter_id', e.recruiter_id,
      'recruiter_display_name', e.recruiter_display_name,
      'provider_type', e.provider_type,
      'team_id', e.team_id,
      'team_display_name', case when e.provider_type = 'vendor'
        then 'Không áp dụng' else e.team_display_name end,
      'labor_type', e.labor_type,
      'labor_type_display', (select lt.display_name from public.direct_entry_labor_types lt
        where lt.labor_type_key = e.labor_type),
      'employment_status', status.status,
      'created_at', e.created_at,
      'updated_at', e.updated_at,
      'profile', jsonb_build_object(
        'contract_version', 'worker-profile/1.0',
        'worker_details', jsonb_build_object(
          'display_name', case when e.own_submission then jsonb_build_object(
            'state', 'provided', 'value', e.worker_details->>'display_name'
          ) else jsonb_build_object('state', 'redacted', 'present', true) end,
          'gender', public.direct_entry_draft_profile_field(e.worker_details->'gender', e.own_submission),
          'date_of_birth', public.direct_entry_draft_profile_field(e.worker_details->'date_of_birth', e.own_submission),
          'national_id', public.direct_entry_draft_profile_field(e.worker_details->'national_id', e.own_submission),
          'national_id_issued_at', public.direct_entry_draft_profile_field(e.worker_details->'national_id_issued_at', e.own_submission),
          'national_id_issued_place', public.direct_entry_draft_profile_field(e.worker_details->'national_id_issued_place', e.own_submission),
          'address', public.direct_entry_draft_profile_field(e.worker_details->'address', e.own_submission),
          'phone', public.direct_entry_draft_profile_field(e.worker_details->'phone', e.own_submission)
        ),
        'general_note', case
          when e.general_note is null then jsonb_build_object('state', 'omitted')
          when e.own_submission then jsonb_build_object('state', 'provided', 'value', e.general_note)
          else jsonb_build_object('state', 'redacted', 'present', true)
        end,
        'employment', case when status.version is null then null else jsonb_build_object(
            'status', status.status,
            'effective_date', status.effective_date,
            'version', status.version,
            'leave_date', case
              when status.leave_date is null then jsonb_build_object('state', 'omitted')
              when not (
                v_employment_apply
                or e.own_submission
                or (
                  coalesce(v_authz_managed, false)
                  and e.team_id is not null
                  and public.direct_entry_authz__internal_has_paired_capability(
                    p_app_user_id, 'employment_status.apply', 'CONTEXT_TEAM', e.team_id::text
                  )
                )
              ) then jsonb_build_object('state', 'omitted')
              when e.own_submission
                then jsonb_build_object('state', 'provided', 'value', status.leave_date)
              else jsonb_build_object('state', 'redacted', 'present', true)
            end,
            'leave_reason_text', case
              when status.leave_reason_text is null then jsonb_build_object('state', 'omitted')
              when not (
                v_employment_apply
                or e.own_submission
                or (
                  coalesce(v_authz_managed, false)
                  and e.team_id is not null
                  and public.direct_entry_authz__internal_has_paired_capability(
                    p_app_user_id, 'employment_status.apply', 'CONTEXT_TEAM', e.team_id::text
                  )
                )
              ) then jsonb_build_object('state', 'omitted')
              when e.own_submission
                then jsonb_build_object('state', 'provided', 'value', status.leave_reason_text)
              else jsonb_build_object('state', 'redacted', 'present', true)
            end
          ) end,
        'payment', case when payment.entry_id is null then null else jsonb_build_object(
            'state', payment.state,
            'account_number', case
              when payment.account_number is null then jsonb_build_object('state', 'omitted')
              when e.own_submission then jsonb_build_object(
                'state', 'provided', 'value', payment.account_number
              )
              else jsonb_build_object(
                'state', 'masked',
                'value', repeat('•', greatest(length(payment.account_number) - 4, 0)) ||
                  right(payment.account_number, 4)
              )
            end,
            'bank_name', case
              when payment.bank_name is null then jsonb_build_object('state', 'omitted')
              when e.own_submission then jsonb_build_object(
                'state', 'provided', 'value', payment.bank_name
              )
              else jsonb_build_object('state', 'redacted', 'present', true)
            end,
            'account_holder_name', case
              when payment.account_holder_name is null then jsonb_build_object('state', 'omitted')
              when e.own_submission then jsonb_build_object(
                'state', 'provided', 'value', payment.account_holder_name
              )
              else jsonb_build_object('state', 'redacted', 'present', true)
            end,
            'version', payment.version
          ) end
      )
    ) order by e.created_at, e.entry_id), '[]'::jsonb)
  ) into v_result
    from authorized e
    left join lateral (
      select st.status, st.effective_date, st.version, st.leave_date, st.leave_reason_text
        from public.direct_entry_employment_status_events st
       where st.entry_id = e.entry_id
       order by st.version desc
       limit 1
    ) status on true
    left join public.direct_entry_payments payment on payment.entry_id = e.entry_id
   where e.resolved_scope in ('own', 'team', 'all', 'project');

  return v_result;
end;
$function$;

create or replace function public.direct_entry_list_own_submissions(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page_size integer,
  p_cursor text,
  p_state text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_page_size integer;
  v_cursor_stamp text;
  v_cursor_id uuid;
  v_can_list_own boolean := false;
  v_has_project_assignment boolean := false;
  v_scanned integer;
  v_items jsonb;
  v_next_cursor text;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  v_can_list_own :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null);

  v_has_project_assignment := public.direct_entry_actor_has_project_assignment(p_app_user_id);
  if not v_can_list_own and not v_has_project_assignment then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  v_page_size := coalesce(p_page_size, 20);
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_state is not null and p_state not in
       ('DRAFT', 'REVIEW', 'SUBMITTED', 'ACTIVE', 'HISTORY') then
    raise exception 'invalid submission state filter' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with candidates as (
    select s.submission_id,
           s.state,
           s.version,
           s.created_at,
           s.updated_at,
           s.submitted_at,
           not (v_can_list_own and s.created_by_user_id = p_app_user_id) as project_scoped
      from public.direct_entry_submissions s
     where s.state <> 'DELETED' and (
             (v_can_list_own and s.created_by_user_id = p_app_user_id)
             or (
               s.state = 'SUBMITTED'
               and v_has_project_assignment
               and exists (
                 select 1 from public.direct_entries e
                  where e.submission_id = s.submission_id
                    and e.deleted_at is null
                    and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
               )
             )
           )
       and (p_state is null
         or (p_state = 'ACTIVE' and s.state in ('DRAFT', 'REVIEW'))
         or (p_state = 'HISTORY' and s.state = 'SUBMITTED')
         or s.state = p_state)
       and (
         v_cursor_stamp is null
         or (
              pg_catalog.to_char(s.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
              s.submission_id::text
            ) < (v_cursor_stamp, v_cursor_id::text)
       )
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
             || ':' || c.submission_id::text as cursor
      from candidates c
     order by c.created_at desc, c.submission_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by created_at desc, submission_id desc limit v_page_size
  )
  select
    (select count(*)::integer from page),
    (
      select coalesce(jsonb_agg(jsonb_build_object(
               'submission_id', t.submission_id,
               'state', t.state,
               'version', t.version,
               'entry_count', (
                 select count(*)::integer from public.direct_entries e
                  where e.submission_id = t.submission_id and e.deleted_at is null
                     and (not t.project_scoped or
                       public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
               ),
               'project_scoped', t.project_scoped,
               'created_at',
                 pg_catalog.to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.created_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z',
               'updated_at',
                 pg_catalog.to_char(t.updated_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.updated_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z',
               'submitted_at', case when t.submitted_at is null then null else
                 pg_catalog.to_char(t.submitted_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.submitted_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z' end,
               'allowed_transitions', case t.state
                 when 'DRAFT' then jsonb_build_array('SUBMITTED')
                 when 'REVIEW' then jsonb_build_array('DRAFT', 'SUBMITTED')
                 else jsonb_build_array()
               end
             ) order by t.created_at desc, t.submission_id desc), '[]'::jsonb)
        from trimmed t
    ),
    (
      select t.cursor from trimmed t
       order by t.created_at asc, t.submission_id asc limit 1
    )
  into v_scanned, v_items, v_next_cursor;

  v_has_more := v_scanned > v_page_size;
  return jsonb_build_object(
    'items', v_items,
    'page_size', v_page_size,
    'has_more', v_has_more,
    'next_cursor', case when v_has_more then v_next_cursor else null end
  );
end;
$function$;

create or replace function public.direct_entry_read_change_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_request public.direct_entry_change_requests%rowtype;
  v_audience text;
  v_pii_view boolean;
  v_payment_view boolean;
  v_request_reason text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if p_request_id is null then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id;
  if not found then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_audience := public.direct_entry_change_request_audience(
    p_app_user_id, v_request.proposer_user_id, v_request.request_id
  );
  if v_audience = 'NONE' then
    if v_request.proposer_user_id = p_app_user_id then
      v_audience := 'PROPOSER_HISTORY';
    elsif v_request.state in ('APPROVED', 'REJECTED')
          and v_request.decided_by_user_id = p_app_user_id
          and v_request.proposer_user_id <> p_app_user_id then
      v_audience := 'DECIDER_HISTORY';
    elsif v_request.state in ('APPROVED', 'REJECTED') and coalesce(v_authz_managed, false) then
      if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
         or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
        v_audience := 'AUDITOR';
      end if;
    end if;
  end if;
  if v_audience = 'NONE' then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;

  v_pii_view := true;
  v_payment_view := true;

  if v_audience in ('REVIEWER', 'AUDITOR', 'DECIDER_HISTORY') then
    select rr.reason_text into v_request_reason
      from public.direct_entry_restricted_reasons rr
     where rr.reason_id = v_request.reason_id;
  end if;
  return jsonb_build_object(
    'request_id', v_request.request_id,
    'state', v_request.state,
    'version', v_request.version,
    'created_at', pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z',
    'request_reason', v_request_reason,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'entry_id', i.entry_id,
               'target_kind', i.target_kind,
               'expected_version', i.expected_version,
               'proposal', case
                 when i.target_kind = 'WORK_STATUS'
                      and v_audience in ('REVIEWER', 'AUDITOR', 'DECIDER_HISTORY')
                      and i.proposal ? 'leave_reason'
                   then public.direct_entry_change_request_proposal_projection(
                     i.target_kind, i.proposal, v_pii_view, v_payment_view,
                     case
                       when not coalesce(v_authz_managed, false) or e.entry_id is null then false
                       else (
                         public.direct_entry_has_entry_access(
                           p_app_user_id, 'document_view', e.created_by_user_id, e.team_id, e.first_work_date
                         )
                         or (
                           v_audience = 'PROPOSER'
                           and public.direct_entry_authz__internal_has_paired_capability(
                             p_app_user_id, 'document_view', 'CONTEXT_PROJECT', e.project_id
                           )
                         )
                       )
                     end
                   ) || jsonb_build_object('leave_reason', i.proposal->'leave_reason')
                 else public.direct_entry_change_request_proposal_projection(
                   i.target_kind, i.proposal, v_pii_view, v_payment_view,
                   case
                     when not coalesce(v_authz_managed, false) or e.entry_id is null then false
                     else (
                       public.direct_entry_has_entry_access(
                         p_app_user_id, 'document_view', e.created_by_user_id, e.team_id, e.first_work_date
                       )
                       or (
                         v_audience = 'PROPOSER'
                         and public.direct_entry_authz__internal_has_paired_capability(
                           p_app_user_id, 'document_view', 'CONTEXT_PROJECT', e.project_id
                         )
                       )
                     )
                   end
                 )
               end,
               'labor_type_display', case
                 when i.target_kind = 'ENTRY_FIELD'
                      and nullif(i.proposal->>'labor_type', '') is not null
                   then (select lt.display_name from public.direct_entry_labor_types lt
                          where lt.labor_type_key = i.proposal->>'labor_type')
                 else null end
             ) order by i.entry_id), '[]'::jsonb)
        from public.direct_entry_change_request_items i
        left join public.direct_entries e on e.entry_id = i.entry_id
       where i.request_id = v_request.request_id
    ),
    'can_withdraw', (v_audience = 'PROPOSER' and v_request.state = 'PENDING'),
    'can_decide', (v_audience = 'REVIEWER' and v_request.state = 'PENDING')
  );
end;
$function$;

create or replace function public.direct_entry_read_own_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_submission public.direct_entry_submissions%rowtype;
  v_can_read_own boolean := false;
  v_has_project_assignment boolean := false;
  v_project_scoped boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  v_can_read_own :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null);

  v_has_project_assignment := public.direct_entry_actor_has_project_assignment(p_app_user_id);
  if not v_can_read_own and not v_has_project_assignment then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  if p_submission_id is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select * into v_submission
    from public.direct_entry_submissions s
   where s.submission_id = p_submission_id and s.state <> 'DELETED';
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  v_project_scoped := not (
    v_can_read_own and v_submission.created_by_user_id = p_app_user_id
  );
  if v_project_scoped and (
       v_submission.state <> 'SUBMITTED'
       or not exists (
         select 1 from public.direct_entries e
          where e.submission_id = v_submission.submission_id
            and e.deleted_at is null
            and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
       )
     ) then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'submission_id', v_submission.submission_id,
    'state', v_submission.state,
    'version', v_submission.version,
    'entry_count', (
      select count(*)::integer from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
         and (not v_project_scoped or
           public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
    ),
    'project_scoped', v_project_scoped,
    'entry_ids', (
      select coalesce(jsonb_agg(e.entry_id order by e.entry_id), '[]'::jsonb)
        from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
         and (not v_project_scoped or
           public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
    ),
    'created_at',
      pg_catalog.to_char(v_submission.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.created_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z',
    'updated_at',
      pg_catalog.to_char(v_submission.updated_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.updated_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z',
    'submitted_at', case when v_submission.submitted_at is null then null else
      pg_catalog.to_char(v_submission.submitted_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.submitted_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z' end,
    'allowed_transitions', case v_submission.state
      when 'DRAFT' then jsonb_build_array('SUBMITTED')
      when 'REVIEW' then jsonb_build_array('DRAFT', 'SUBMITTED')
      else jsonb_build_array()
    end
  );
end;
$function$;

create or replace function public.direct_entry_read_projection(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_result jsonb;
  v_pii boolean;
  v_payment boolean;
  v_documents boolean;
begin
  select * into v_entry from public.direct_entries
   where entry_id = p_entry_id and deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_resolve_submission_read_scope(
    p_auth_subject, p_app_user_id, v_entry.entry_id
  );
  if v_scope is null then
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'entry_privileged_edit',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  end if;
  if v_scope is null then
    raise exception 'entry scope/capability denied' using errcode = '42501';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_pii := true;
  v_payment := true;
  if coalesce(v_authz_managed, false) then
    v_documents :=
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
      or (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
        and (
          v_entry.created_by_user_id = p_app_user_id
          or v_scope in ('project', 'team', 'team_review', 'recruited')
        )
      )
      or (
        v_entry.team_id is not null
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'CONTEXT_TEAM', v_entry.team_id::text)
      )
      or (
        v_scope = 'project'
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'CONTEXT_PROJECT', v_entry.project_id)
      )
      or (
        v_entry.created_by_user_id = p_app_user_id
        and v_scope = 'project'
        and exists (
          select 1 from public.direct_entry_submissions s
           where s.submission_id = v_entry.submission_id and s.state = 'DRAFT'
        )
      );
  else
    v_documents := false;
  end if;

  if v_scope = 'project' and exists (
       select 1 from public.direct_entry_submissions s
        where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
     ) then
    v_pii := true;
    v_payment := true;
  end if;
  v_result := jsonb_build_object(
    'created_at', pg_catalog.to_char(v_entry.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_entry.created_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z',
    'created_by', (
      select jsonb_build_object(
        'display_name', coalesce(
          recruiter.display_name,
          nullif(creator.display_name, login.login_id)
        ),
        'login_id', login.login_id
      )
        from public.direct_entry_app_users creator
        left join auth.users auth_user on auth_user.id = creator.auth_subject
        cross join lateral (
          select lower(nullif(split_part(to_jsonb(auth_user)->>'email', pg_catalog.chr(64), 1), '')) as login_id
        ) login
        left join lateral (
          select r.display_name
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = creator.app_user_id
             and l.verified
             and l.is_current
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) recruiter on true
       where creator.app_user_id = v_entry.created_by_user_id
    ),
    'entry_id', v_entry.entry_id, 'submission_id', v_entry.submission_id,
    'project_id', v_entry.project_id, 'first_work_date', v_entry.first_work_date,
    'employee_code', v_entry.employee_code,
    'worker_details', case when v_pii then v_entry.worker_details else jsonb_build_object(
      'display_name', jsonb_build_object('present', v_entry.worker_details ? 'display_name'),
      'gender', jsonb_build_object('state', v_entry.worker_details->'gender'->>'state'),
      'date_of_birth', jsonb_build_object('state', v_entry.worker_details->'date_of_birth'->>'state'),
      'national_id', jsonb_build_object('state', v_entry.worker_details->'national_id'->>'state'),
      'national_id_issued_at', jsonb_build_object(
        'state', v_entry.worker_details->'national_id_issued_at'->>'state'
      ),
      'national_id_issued_place', jsonb_build_object(
        'state', v_entry.worker_details->'national_id_issued_place'->>'state'
      ),
      'address', jsonb_build_object('state', v_entry.worker_details->'address'->>'state'),
      'phone', jsonb_build_object('state', v_entry.worker_details->'phone'->>'state')
    ) end,
    'general_note', case when v_entry.general_note is null then null
      when v_pii then to_jsonb(v_entry.general_note)
      else jsonb_build_object('present', true) end,
    'recruiter_id', v_entry.recruiter_id, 'team_id', v_entry.team_id,
    'provider_type', v_entry.provider_type, 'labor_type', v_entry.labor_type,
    'labor_type_display', (select lt.display_name from public.direct_entry_labor_types lt
      where lt.labor_type_key = v_entry.labor_type),
    'version', v_entry.version, 'scope_kind', v_scope,
    'payment', (
      select case when v_payment then jsonb_build_object(
        'state', p.state, 'account_number', p.account_number, 'bank_id', p.bank_id,
        'bank_name', p.bank_name, 'account_holder_name', p.account_holder_name,
        'version', p.version
      ) else jsonb_build_object(
        'state', p.state,
        'account_number', case when p.account_number is null then null
          else repeat('•', greatest(length(p.account_number) - 4, 0)) ||
            right(p.account_number, 4) end,
        'version', p.version
      ) end
        from public.direct_entry_payments p
       where p.entry_id = p_entry_id
    ),
    'employment_status', (
      select jsonb_build_object(
        'status', st.status, 'effective_date', st.effective_date, 'version', st.version
      )
        from public.direct_entry_employment_status_events st
       where st.entry_id = p_entry_id
       order by st.version desc
       limit 1
    ),
    'worker_portrait', case when v_documents then (
      select jsonb_build_object(
        'origin', c.worker_portrait_origin,
        'added_at', c.worker_portrait_added_at,
        'status', coalesce(latest.upload_status, 'MISSING'),
        'current', case when current_document.document_id is null then null
          else jsonb_build_object(
            'document_id', current_document.document_id,
            'version', current_document.version,
            'checksum_sha256', current_document.checksum_sha256,
            'mime_type', current_document.mime_type,
            'size_bytes', current_document.size_bytes
          )
        end
      )
        from public.direct_entry_candidates c
        left join lateral (
          select e.upload_status
            from public.direct_entry_document_versions d
            join lateral (
              select ev.upload_status
                from public.direct_entry_document_events ev
               where ev.document_id = d.document_id
               order by ev.version desc
               limit 1
            ) e on true
           where d.candidate_id = c.candidate_id
             and d.document_type = 'WORKER_PORTRAIT'
           order by d.version desc
           limit 1
        ) latest on true
        left join lateral (
          select cd.document_id, cd.version, cd.checksum_sha256, cd.mime_type, cd.size_bytes
            from public.direct_entry_current_documents cd
           where cd.candidate_id = c.candidate_id
             and cd.document_type = 'WORKER_PORTRAIT'
        ) current_document on true
       where c.candidate_id = v_entry.candidate_id
    ) else null end,
    'documents', case when v_documents then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'size_bytes', d.size_bytes, 'mime_type', d.mime_type,
        'upload_status', d.upload_status, 'scan_status', d.scan_status,
        'validation_status', d.validation_status
      ) order by d.document_type, d.version), '[]'::jsonb)
        from public.direct_entry_current_documents d
       where d.candidate_id = v_entry.candidate_id
         and d.document_type <> 'WORKER_PORTRAIT'
    ) else '[]'::jsonb end
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_resolve_change_request_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_target_kind text
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_entry public.direct_entries%rowtype;
begin
  select e.* into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id and e.deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if p_target_kind = 'ENTRY_VOID' then
    select coalesce(u.authz_managed, false)
      into v_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id;

    if v_entry.voided_at is not null
       or not exists (
         select 1 from public.direct_entry_submissions s
          where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
       )
       or v_entry.created_by_user_id is distinct from p_app_user_id
       or not coalesce(v_authz_managed, false)
       or not public.direct_entry_has_entry_access(
         p_app_user_id, 'change_request_create',
         v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
       ) then
      raise exception 'entry void request access denied' using errcode = '42501';
    end if;
    return 'creator';
  end if;
  if p_target_kind = 'DOCUMENT' then
    raise exception 'project document change requests are not supported'
      using errcode = '42501';
  end if;

  if not exists (
       select 1 from public.direct_entry_submissions s
        where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
     ) or not public.direct_entry_actor_is_assigned_project_manager(
       p_app_user_id, v_entry.project_id
     ) then
    raise exception 'project change request access denied' using errcode = '42501';
  end if;
  return 'project';
end;
$function$;

create or replace function public.direct_entry_resolve_direct_edit_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_project_id text,
  p_is_full_admin boolean,
  p_team_leader_team_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_enabled boolean := false;
  v_authz_managed boolean := false;
  v_scope text;
begin
  if p_is_full_admin then
    return 'admin_all';
  end if;

  -- Exception-free evaluation (required by R2.1: called per-row in directory & duplicate-CCCD queries).
  select u.enabled, coalesce(u.authz_managed, false)
    into v_enabled, v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject;

  if found and coalesce(v_enabled, false) and coalesce(v_authz_managed, false) then
    select min(matched.legacy_scope)
      into v_scope
      from (
        select case
          when g.scope_kind = 'ALL'
               and (g.scope_id is null or pg_catalog.btrim(g.scope_id) = '')
            then 'all'::text
          when g.scope_kind = 'OWN'
               and (g.scope_id is null or pg_catalog.btrim(g.scope_id) = '')
               and p_entry_owner = p_app_user_id
            then 'own'::text
          when g.scope_kind = 'CONTEXT_TEAM'
               and p_team_id is not null
               and g.scope_id = p_team_id::text
               and exists (
                 select 1
                   from public.teams t
                  where t.team_id = p_team_id
                    and t.active
                    and t.code <> '__system_vendor__'
               )
            then 'team'::text
          else null::text
        end as legacy_scope
          from pg_catalog.jsonb_to_recordset(
            public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id)
          ) as g(capability text, scope_kind text, scope_id text)
         where g.capability = 'entry_privileged_edit'
      ) matched
     where matched.legacy_scope is not null;

    if v_scope is not null then
      return 'privileged_' || v_scope;
    end if;
  end if;

  if public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    return 'project_manager';
  end if;
  if p_team_id is not null and p_team_id = p_team_leader_team_id then
    return 'team_leader';
  end if;
  return null;
end;
$function$;

create or replace function public.direct_entry_resolve_submission_read_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_today date := public.direct_entry_authorization_date();
  v_scope text;
  v_entry public.direct_entries%rowtype;
  v_submission_state text;
  v_recruiter_link_count integer;
  v_team_leader_team_id uuid;
  v_can_read_own_submissions boolean;
begin
  v_scope := public.direct_entry_resolve_draft_scope(p_auth_subject, p_app_user_id, p_entry_id);
  if v_scope is not null then return v_scope; end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    return null;
  end if;

  select e.* into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id and e.deleted_at is null;
  if not found then return null; end if;

  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id;
  if not found then return null; end if;

  v_can_read_own_submissions := (
    v_entry.created_by_user_id = p_app_user_id
    and (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null)
    )
  );

  if v_submission_state <> 'SUBMITTED' then
    if v_can_read_own_submissions then return 'own'; end if;
    return null;
  end if;

  if public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_entry.project_id) then
    return 'project';
  end if;
  if v_can_read_own_submissions then
    return 'own';
  end if;
  if v_entry.team_id is not null then
    begin
      v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
        p_auth_subject, p_app_user_id, v_entry.team_id
      );
      return 'team';
    exception when insufficient_privilege then
      null;
    end;
  end if;
  if exists(
    select 1
      from public.direct_entry_change_request_items i
      join public.direct_entry_change_requests r on r.request_id = i.request_id
     where i.entry_id = v_entry.entry_id
       and public.direct_entry_team_leader_request_team(p_app_user_id, r.request_id) = v_entry.team_id
  ) then
    return 'team_review';
  end if;

  select count(*)::integer into v_recruiter_link_count
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.is_current;
  if v_recruiter_link_count = 1 and exists(
    select 1
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
      join public.direct_entry_app_users u
        on u.app_user_id = l.app_user_id
       and u.enabled
     where l.app_user_id = p_app_user_id
       and l.recruiter_id = v_entry.recruiter_id
       and l.verified
       and l.is_current
       and not l.suspended_by_account_disable
       and l.valid_from <= v_today
       and (l.valid_to is null or (l.valid_to > l.valid_from and v_today < l.valid_to))
       and not exists (
         select 1
           from public.direct_entry_app_user_recruiter_links other_link
          where other_link.recruiter_id = l.recruiter_id
            and other_link.app_user_id <> p_app_user_id
            and other_link.verified
            and other_link.is_current
            and not other_link.suspended_by_account_disable
            and other_link.valid_from <= v_today
            and (other_link.valid_to is null or (other_link.valid_to > other_link.valid_from and v_today < other_link.valid_to))
       )
  ) then
    return 'recruited';
  end if;
  if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
     or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
    return 'all';
  end if;

  return null;
end;
$function$;

create or replace function public.direct_entry_self_withdraw_duplicate_cccd(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_has_withdraw_cap boolean := false;
  v_entry public.direct_entries%rowtype;
  v_cccd text;
  v_target_status text;
  v_other_active_count integer := 0;
  v_reason_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_entry_id is null then
    raise exception 'entry id required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected entry version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null
     or length(btrim(p_idempotency_key)) = 0
     or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_has_withdraw_cap :=
    coalesce(v_authz_managed, false)
    and public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, 'duplicate_cccd_withdraw', 'ALL', null
    );

  select * into v_entry
    from public.direct_entries
   where entry_id = p_entry_id;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  if v_entry.created_by_user_id is distinct from p_app_user_id
     and not v_has_withdraw_cap
     and not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_entry.project_id) then
    raise exception 'self withdraw requires entry creator, assigned project manager, or duplicate CCCD withdraw capability' using errcode = '42501';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'entry_self_withdraw_duplicate_cccd',
    p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id,
      'expected_version', p_expected_version,
      'reason', p_reason
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_cccd := case
    when v_entry.worker_details->'national_id'->>'state' = 'provided' then
      public.direct_entry_canonical_national_id(
        v_entry.worker_details->'national_id'->>'value'
      )
    else null
  end;

  perform 1
    from public.direct_entries e
   where e.entry_id = p_entry_id
      or (
        public.direct_entry_is_canonical_national_id(v_cccd)
        and e.deleted_at is null
        and e.worker_details->'national_id'->>'state' = 'provided'
        and public.direct_entry_canonical_national_id(
              e.worker_details->'national_id'->>'value'
            ) = v_cccd
      )
   order by e.entry_id asc
   for update;

  select * into v_entry
    from public.direct_entries
   where entry_id = p_entry_id;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  -- Post-lock re-check ensures an entry creator disabled mid-race cannot void post-disable.
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_has_withdraw_cap :=
    coalesce(v_authz_managed, false)
    and public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, 'duplicate_cccd_withdraw', 'ALL', null
    );

  if v_entry.created_by_user_id is distinct from p_app_user_id
     and not v_has_withdraw_cap
     and not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_entry.project_id) then
    raise exception 'self withdraw requires entry creator, assigned project manager, or duplicate CCCD withdraw capability' using errcode = '42501';
  end if;
  if v_entry.voided_at is not null then
    raise exception 'entry already voided' using errcode = 'PT409';
  end if;
  if v_entry.version <> p_expected_version then
    raise exception 'entry version conflict' using errcode = 'PT409';
  end if;

  v_cccd := case
    when v_entry.worker_details->'national_id'->>'state' = 'provided' then
      public.direct_entry_canonical_national_id(
        v_entry.worker_details->'national_id'->>'value'
      )
    else null
  end;
  if not public.direct_entry_is_canonical_national_id(v_cccd) then
    raise exception 'self withdraw target is not an active duplicate' using errcode = 'PT409';
  end if;

  select coalesce((
    select st.status
      from public.direct_entry_employment_status_events st
     where st.entry_id = v_entry.entry_id
     order by st.version desc
     limit 1
  ), 'UNCONFIRMED')
    into v_target_status;
  if v_target_status not in ('ON', 'OFF')
     or v_entry.project_id is null
     or v_entry.first_work_date is null then
    raise exception 'self withdraw target is not in a same-project same-day duplicate cluster'
      using errcode = 'PT409';
  end if;

  select count(*)::int
    into v_other_active_count
    from public.direct_entries e
   where e.entry_id <> v_entry.entry_id
     and e.deleted_at is null
     and e.voided_at is null
     and e.worker_details->'national_id'->>'state' = 'provided'
     and public.direct_entry_canonical_national_id(
           e.worker_details->'national_id'->>'value'
         ) = v_cccd
     and e.project_id = v_entry.project_id
     and e.first_work_date = v_entry.first_work_date
     and coalesce((
           select st.status
             from public.direct_entry_employment_status_events st
            where st.entry_id = e.entry_id
            order by st.version desc
            limit 1
         ), 'UNCONFIRMED') in ('ON', 'OFF');

  if v_other_active_count < 1 then
    raise exception 'self withdraw target is not an active duplicate' using errcode = 'PT409';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_revision_id := public.direct_entry__internal_apply_entry_void(
    p_auth_subject,
    p_app_user_id,
    v_entry.entry_id,
    v_entry.version,
    v_reason_id,
    'entry_self_withdraw_duplicate_cccd',
    case
      when v_entry.created_by_user_id = p_app_user_id then 'entry_creator_self_withdraw'
      when v_has_withdraw_cap then 'duplicate_cccd_withdraw'
      else 'project_manager_self_withdraw'
    end,
    case
      when v_entry.created_by_user_id = p_app_user_id then 'own'
      when v_has_withdraw_cap then 'all'
      else 'project'
    end,
    null
  );

  v_result := jsonb_build_object(
    'entry_id', v_entry.entry_id,
    'version', v_entry.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'entry_self_withdraw_duplicate_cccd', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_submission_duplicate_cccd_preflight(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_submission public.direct_entry_submissions%rowtype;
  v_state jsonb;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
  if not exists (
    select 1
      from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
     where g.capability = 'submission_create'
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from pg_catalog.jsonb_to_recordset(v_grants) as g(
        capability text,
        scope_kind text,
        scope_id text
      )
     where g.capability = 'submission_create'
       and g.scope_kind in ('OWN', 'ALL')
       and g.scope_id is null
  ) then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;

  if v_submission.state <> 'DRAFT' then
    raise exception 'submission is not a draft' using errcode = '22023';
  end if;

  v_state := public.direct_entry_submission_duplicate_cccd_state(p_submission_id);
  return jsonb_build_object(
    'submission_id', p_submission_id,
    'version', v_submission.version,
    'fingerprint', v_state->'fingerprint',
    'conflict_count', v_state->'conflict_count',
    'conflicts', v_state->'conflicts'
  );
end;
$function$;

create or replace function public.direct_entry_transition_submission_apply(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid,
  p_expected_version integer,
  p_target_state text,
  p_idempotency_key text,
  p_ack_fingerprint text,
  p_ack_conflict_count integer
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_submission public.direct_entry_submissions%rowtype;
  v_prior_result jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_submission_revision_id uuid;
  v_before jsonb;
  v_state jsonb;
  v_conflict_count integer;
  v_acknowledged boolean := false;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
  if not exists (
    select 1
      from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
     where g.capability = 'submission_create'
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id
   for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  if not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null)
  ) then
    raise exception 'submission own scope denied' using errcode = '42501';
  end if;

  v_request_hash := encode(
    sha256(convert_to(concat_ws('|', p_submission_id::text, p_expected_version::text, p_target_state), 'UTF8')),
    'hex'
  );
  v_prior_result := public.direct_entry_idempotency_begin(
    p_app_user_id, 'submission_transition', p_idempotency_key, v_request_hash
  );
  if v_prior_result is not null then return v_prior_result; end if;
  if p_expected_version is null or p_expected_version <> v_submission.version then
    raise exception 'submission version conflict' using errcode = 'PT409';
  end if;
  if p_target_state = v_submission.state then
    raise exception 'submission transition cannot be a no-op' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.direct_entries e
     where e.submission_id = p_submission_id and e.deleted_at is null
  ) then
    raise exception 'submission must contain at least one entry' using errcode = '23514';
  end if;

  if v_submission.state = 'DRAFT' and p_target_state = 'SUBMITTED' then
      v_state := public.direct_entry_submission_duplicate_cccd_state(p_submission_id);
      v_conflict_count := (v_state->>'conflict_count')::int;
      if v_conflict_count > 0 then
        if p_ack_fingerprint is null
           or p_ack_fingerprint <> (v_state->>'fingerprint')
           or p_ack_conflict_count is null
           or p_ack_conflict_count <> v_conflict_count then
          raise exception 'duplicate cccd acknowledgement required' using errcode = '22023';
        end if;
        v_acknowledged := true;
      end if;
  end if;
  v_before := jsonb_build_object(
    'state', v_submission.state, 'version', v_submission.version,
    'submitted_at', v_submission.submitted_at
  );
  update public.direct_entry_submissions
     set state = p_target_state,
         version = version + 1
   where submission_id = p_submission_id;
  v_reason_id := null;
  insert into public.direct_entry_submission_revisions (
    submission_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_submission_id, v_submission.version + 1, p_app_user_id, v_reason_id, v_before,
    jsonb_build_object(
      'state', p_target_state, 'version', v_submission.version + 1,
      'submitted_at', case when p_target_state = 'SUBMITTED' then now() else null end
    ) || case when v_acknowledged then jsonb_build_object(
        'duplicate_cccd_acknowledgement', jsonb_build_object(
          'conflict_count', v_conflict_count,
          'fingerprint_prefix', left(p_ack_fingerprint, 12)
        )
      ) else '{}'::jsonb end
  ) returning revision_id into v_submission_revision_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'submission_transition', 'submission_create',
    p_submission_id::text, 'own', null, 'APPLIED', v_reason_id,
    v_submission_revision_id,
    array['state', 'version']
  );
  v_result := jsonb_build_object(
    'submission_id', p_submission_id,
    'state', p_target_state,
    'version', v_submission.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'submission_transition', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_worker_directory_audience(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_authz_managed boolean := false;
  v_link_count integer := 0;
  v_recruiter_id uuid;
  v_project_ids jsonb;
  v_team_id uuid;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if p_scope is null or p_scope not in ('recruited', 'managed', 'team', 'all') then
    raise exception 'invalid worker directory scope' using errcode = '22023';
  end if;
  if p_project_id is not null and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'invalid project filter' using errcode = '22023';
  end if;

  if p_scope = 'team' then
    v_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
    return pg_catalog.jsonb_build_object('scope', 'team', 'team_id', v_team_id,
      'recruiter_ids', '[]'::jsonb, 'project_ids', '[]'::jsonb,
      'view_pii', true, 'view_payment', true);
  end if;

  if p_scope = 'recruited' then
    select count(*)::integer into v_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_app_user_id and l.verified and l.is_current;
    if v_link_count <> 1 then
      raise exception 'worker directory recruiter link unavailable or ambiguous' using errcode = '42501';
    end if;
    select l.recruiter_id into v_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
      join public.direct_entry_app_users u
        on u.app_user_id = l.app_user_id
       and u.enabled
     where l.app_user_id = p_app_user_id
       and l.verified
       and l.is_current
       and not l.suspended_by_account_disable
       and l.valid_from <= v_today
       and (l.valid_to is null or (l.valid_to > l.valid_from and v_today < l.valid_to));
    if v_recruiter_id is null then
      raise exception 'worker directory recruiter unavailable' using errcode = '42501';
    end if;
    return pg_catalog.jsonb_build_object('scope', 'recruited', 'recruiter_ids', pg_catalog.jsonb_build_array(v_recruiter_id),
      'project_ids', '[]'::jsonb, 'view_pii', true, 'view_payment', true);
  end if;

  if p_scope = 'managed' then
    if not public.direct_entry_actor_has_project_assignment(p_app_user_id) then
      raise exception 'worker directory project assignment required' using errcode = '42501';
    end if;
    select coalesce(pg_catalog.jsonb_agg(distinct a.project_id), '[]'::jsonb) into v_project_ids
      from public.direct_entry_project_manager_assignments a
      join public.direct_entry_app_user_recruiter_links l
        on l.recruiter_id = a.manager_recruiter_id
       and l.app_user_id = p_app_user_id
       and l.verified
       and l.is_current
       and not l.suspended_by_account_disable
     where a.is_current
       and a.revoked_at is null
       and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, a.project_id);
    if pg_catalog.jsonb_array_length(v_project_ids) = 0 then
      raise exception 'worker directory project assignment required' using errcode = '42501';
    end if;
    if p_project_id is not null and not (v_project_ids ? p_project_id) then
      raise exception 'worker directory project is out of scope' using errcode = '42501';
    end if;
    return pg_catalog.jsonb_build_object('scope', 'managed', 'recruiter_ids', '[]'::jsonb,
      'project_ids', v_project_ids, 'view_pii', true, 'view_payment', true);
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) or not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null)
  ) then
    raise exception 'worker directory requires all scope' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object('scope', 'all', 'recruiter_ids', '[]'::jsonb,
    'project_ids', '[]'::jsonb, 'view_pii', true, 'view_payment', true);
end;
$function$;


-- =============================================================================
-- SECTION 9: Attendance & Work Report Functions (Retire Legacy Fallback)
-- =============================================================================

create or replace function public.attendance__internal_resolve_report_scope_v2(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns table (
  scope_kind text,
  team_ids uuid[],
  department_ids uuid[],
  can_configure_hq boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_authz_managed boolean := false;
  v_is_full_admin boolean := false;
  v_tl_team_id uuid := null;
  v_tl_caps_ok boolean := false;
  v_team_ids uuid[] := array[]::uuid[];
  v_department_ids uuid[] := array[]::uuid[];
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'ATTENDANCE_ACTOR_DENIED' using errcode = '42501';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled = true;

  if not found then
    raise exception 'ATTENDANCE_ACTOR_DENIED' using errcode = '42501';
  end if;

  -- Path 1: Paired Full Admin or BoD on ALL scope
  begin
    v_is_full_admin := public.attendance__internal_assert_report_reader(
      p_auth_subject,
      p_app_user_id
    );
    return query select 'all'::text, null::uuid[], null::uuid[], v_is_full_admin;
    return;
  exception
    when sqlstate '42501' then
      null;
  end;

  -- Non-ALL scoped viewers cannot be verified non-employee accounts
  if public.attendance__internal_is_non_employee_account(p_app_user_id, v_now) then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  if not coalesce(v_authz_managed, false) then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  -- Path 2a: Independent active TEAM_LEADER scope
  begin
    v_tl_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject,
      p_app_user_id,
      null
    );
  exception
    when sqlstate '42501' then
      v_tl_team_id := null;
  end;

  if v_tl_team_id is not null then
    v_tl_caps_ok :=
      public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'team_manager_assign', 'CONTEXT_TEAM', v_tl_team_id::text
      )
      and public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'report_view', 'CONTEXT_TEAM', v_tl_team_id::text
      )
      and public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'report_analytics_view', 'CONTEXT_TEAM', v_tl_team_id::text
      );

    if v_tl_caps_ok then
      v_team_ids := array[v_tl_team_id];
    end if;
  end if;

  -- Path 2b: Independent active DEPARTMENT_HEAD scope (WP3 canonical org tables, matching WP7A)
  select coalesce(
    pg_catalog.array_agg(distinct dh.department_id order by dh.department_id),
    array[]::uuid[]
  )
    into v_department_ids
    from public.organization_account_person_links l
    join public.organization_persons op
      on op.person_id = l.person_id
     and op.status = 'ACTIVE'
    join public.organization_department_heads dh
      on dh.person_id = l.person_id
     and dh.ended_at is null
     and dh.started_at <= v_now
    join public.organization_departments d
      on d.department_id = dh.department_id
     and d.is_active = true
    join public.organization_person_department_memberships m
      on m.person_id = l.person_id
     and m.department_id = dh.department_id
     and m.ended_at is null
     and m.started_at <= v_now
   where l.app_user_id = p_app_user_id
     and l.ended_at is null
     and l.started_at <= v_now;

  if pg_catalog.cardinality(v_team_ids) > 0 and pg_catalog.cardinality(v_department_ids) > 0 then
    return query select 'team_and_department'::text, v_team_ids, v_department_ids, false;
    return;
  elsif pg_catalog.cardinality(v_team_ids) > 0 then
    return query select 'team'::text, v_team_ids, array[]::uuid[], false;
    return;
  elsif pg_catalog.cardinality(v_department_ids) > 0 then
    return query select 'department'::text, array[]::uuid[], v_department_ids, false;
    return;
  end if;

  raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
end;
$function$;

create or replace function public.work_report__internal_direct_team_ids(
  p_app_user_id uuid,
  p_capability text
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_team_ids uuid[];
begin
  if p_app_user_id is null or p_capability is null then
    return array[]::uuid[];
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled or not coalesce(v_user.authz_managed, false) then
    return array[]::uuid[];
  end if;

  select coalesce(pg_catalog.array_agg(distinct t.team_id order by t.team_id), array[]::uuid[])
    into v_team_ids
    from pg_catalog.jsonb_to_recordset(
      public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id)
    ) as g(capability text, scope_kind text, scope_id text)
    join public.teams t
      on t.team_id::text = g.scope_id
     and t.active
     and t.code <> '__system_vendor__'
   where g.capability = p_capability
     and g.scope_kind = 'CONTEXT_TEAM'
     and g.scope_id is not null
     and pg_catalog.btrim(g.scope_id) <> '';

  return coalesce(v_team_ids, array[]::uuid[]);
end;
$function$;

create or replace function public.work_report__internal_has_direct_capability(
  p_app_user_id uuid,
  p_capability text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
begin
  if p_app_user_id is null or p_capability is null then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled or not coalesce(v_user.authz_managed, false) then
    return false;
  end if;

  if exists (
    select 1
      from pg_catalog.jsonb_to_recordset(
        public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id)
      ) as g(capability text)
     where g.capability = p_capability
  ) then
    return true;
  end if;

  if p_capability in (
    'report_form_manage', 'report_assign', 'report_view',
    'report_analytics_view', 'report_review', 'report_delegate'
  ) and public.work_report__internal_is_full_admin(p_app_user_id) then
    return true;
  end if;

  return false;
end;
$function$;

create or replace function public.work_report__internal_has_direct_scope(
  p_app_user_id uuid,
  p_capability text,
  p_scope_kind text,
  p_team_id uuid default null::uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_has_all boolean := false;
begin
  if p_app_user_id is null or p_capability is null or p_scope_kind is null then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled or not coalesce(v_user.authz_managed, false) then
    return false;
  end if;

  v_has_all := public.direct_entry_authz__internal_has_paired_capability(
    p_app_user_id, p_capability, 'ALL', null
  ) or (
    p_capability in (
      'report_form_manage', 'report_assign', 'report_view',
      'report_analytics_view', 'report_review', 'report_delegate'
    )
    and public.work_report__internal_is_full_admin(p_app_user_id)
  );

  if p_scope_kind = 'all' then
    return v_has_all and p_team_id is null;
  end if;

  if p_scope_kind = 'team' and p_team_id is not null then
    if not exists (
      select 1
        from public.teams t
       where t.team_id = p_team_id
         and t.active
         and t.code <> '__system_vendor__'
    ) then
      return false;
    end if;

    if v_has_all then
      return true;
    end if;

    return public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, p_capability, 'CONTEXT_TEAM', p_team_id::text
    );
  end if;

  return false;
end;
$function$;

create or replace function public.work_report__internal_is_delegation_effective(
  p_delegation_id uuid,
  p_as_of timestamp with time zone default statement_timestamp()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_del public.work_report_delegations%rowtype;
  v_delegate public.direct_entry_app_users%rowtype;
begin
  select * into v_del
    from public.work_report_delegations d
   where d.delegation_id = p_delegation_id;
  if not found then
    return false;
  end if;
  if v_del.state <> 'ACTIVE' or not v_del.is_current then
    return false;
  end if;
  if p_as_of < v_del.effective_from
     or (v_del.effective_to is not null and p_as_of > v_del.effective_to) then
    return false;
  end if;

  select u.* into v_delegate
    from public.direct_entry_app_users u
   where u.app_user_id = v_del.delegate_app_user_id;
  if not found or not v_delegate.enabled or not coalesce(v_delegate.authz_managed, false) then
    return false;
  end if;
  if public.attendance__internal_is_non_employee_account(v_del.delegate_app_user_id, p_as_of)
     or public.attendance__internal_is_person_inactive_as_of(v_del.delegate_app_user_id, p_as_of) then
    return false;
  end if;

  if not exists (
    select 1 from public.work_report_templates t
     where t.template_id = v_del.template_id
       and t.status = 'ACTIVE'
       and t.current_published_version_id is not null
  ) then
    return false;
  end if;

  if v_del.scope_kind = 'team' then
    if not exists (
      select 1 from public.teams tm
       where tm.team_id = v_del.scope_team_id
         and tm.active
         and tm.code <> '__system_vendor__'
    ) then
      return false;
    end if;

    if public.work_report_current_team(v_del.delegate_app_user_id) is distinct from v_del.scope_team_id then
      if not exists (
        select 1
          from pg_catalog.jsonb_to_recordset(
            public.direct_entry_authz__internal_resolve_effective_grants(v_del.delegate_app_user_id)
          ) as g(scope_kind text, scope_id text)
         where g.scope_kind = 'CONTEXT_TEAM'
           and g.scope_id = v_del.scope_team_id::text
      ) then
        return false;
      end if;
    end if;
  end if;

  if not public.work_report__internal_has_direct_scope(
    v_del.grantor_user_id, 'report_delegate', v_del.scope_kind, v_del.scope_team_id
  ) then
    return false;
  end if;
  if not public.work_report__internal_has_direct_scope(
    v_del.grantor_user_id, v_del.capability, v_del.scope_kind, v_del.scope_team_id
  ) then
    return false;
  end if;
  return true;
end;
$function$;

create or replace function public.work_report__internal_is_full_admin(
  p_app_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
begin
  if p_app_user_id is null then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled or not coalesce(v_user.authz_managed, false) then
    return false;
  end if;

  return public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
     and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
     and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);
end;
$function$;

create or replace function public.work_report_create_delegation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text,
  p_delegate_app_user_id uuid,
  p_template_id uuid,
  p_scope_kind text,
  p_scope_team_id uuid,
  p_effective_from timestamp with time zone default null::timestamp with time zone,
  p_effective_to timestamp with time zone default null::timestamp with time zone,
  p_idempotency_key text default null::text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_delegate public.direct_entry_app_users%rowtype;
  v_template public.work_report_templates%rowtype;
  v_delegation_id uuid;
  v_effective_from timestamptz;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_person_ids uuid[];
  v_lock_recruiter_ids uuid[];
  v_check_now timestamptz;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');

  if p_capability is null or p_capability not in ('report_assign', 'report_review') then
    raise exception 'WORK_REPORT_DELEGATION_CAPABILITY_INVALID' using errcode = '22023';
  end if;

  if p_delegate_app_user_id is null
     or p_template_id is null
     or p_scope_kind is null
     or p_scope_kind not in ('all', 'team')
     or p_effective_from is not null
     or p_effective_to is not null
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_DELEGATION_INVALID' using errcode = '22023';
  end if;

  if (p_scope_kind = 'all' and p_scope_team_id is not null)
     or (p_scope_kind = 'team' and p_scope_team_id is null) then
    raise exception 'WORK_REPORT_DELEGATION_SCOPE_INVALID' using errcode = '22023';
  end if;

  if p_delegate_app_user_id = p_app_user_id then
    raise exception 'WORK_REPORT_SELF_DELEGATION_FORBIDDEN' using errcode = '22023';
  end if;

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id in (p_app_user_id, p_delegate_app_user_id)
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on grantor + delegate to serialize against disable/revoke.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id in (p_app_user_id, p_delegate_app_user_id)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on delegate's recruiter for team-scoped delegation (serializes against move_team_membership).
  if p_scope_kind = 'team' then
    select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
      into v_lock_recruiter_ids
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_delegate_app_user_id
       and l.verified
       and l.is_current;

    if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
      perform r.recruiter_id
        from public.recruiters r
       where r.recruiter_id = any(v_lock_recruiter_ids)
       order by r.recruiter_id asc
       for share;
    end if;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');

  if not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if not public.work_report__internal_has_direct_scope(p_app_user_id, 'report_delegate', p_scope_kind, p_scope_team_id)
     or not public.work_report__internal_has_direct_scope(p_app_user_id, p_capability, p_scope_kind, p_scope_team_id) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'capability', p_capability,
    'delegate_app_user_id', p_delegate_app_user_id,
    'template_id', p_template_id,
    'scope_kind', p_scope_kind,
    'scope_id', p_scope_team_id
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_delegation_create', p_idempotency_key, v_request_hash);
  if v_prior is not null then
    return v_prior;
  end if;

  select u.*
    into v_delegate
    from public.direct_entry_app_users u
   where u.app_user_id = p_delegate_app_user_id;

  v_check_now := pg_catalog.clock_timestamp();

  if not found
     or not v_delegate.enabled
     or not coalesce(v_delegate.authz_managed, false)
     or public.attendance__internal_is_non_employee_account(p_delegate_app_user_id, v_check_now)
     or public.attendance__internal_is_person_inactive_as_of(p_delegate_app_user_id, v_check_now) then
    raise exception 'WORK_REPORT_DELEGATE_NOT_AVAILABLE' using errcode = '42501';
  end if;

  if p_scope_kind = 'team' then
    if public.work_report_current_team(p_delegate_app_user_id) is distinct from p_scope_team_id then
      if not exists (
        select 1
          from pg_catalog.jsonb_to_recordset(
            public.direct_entry_authz__internal_resolve_effective_grants(p_delegate_app_user_id)
          ) as g(scope_kind text, scope_id text)
         where g.scope_kind = 'CONTEXT_TEAM'
           and g.scope_id = p_scope_team_id::text
      ) then
        raise exception 'WORK_REPORT_DELEGATE_OUTSIDE_SCOPE' using errcode = '42501';
      end if;
    end if;
  end if;

  select * into v_template
    from public.work_report_templates
   where template_id = p_template_id
   for share;
  if not found or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;

  v_effective_from := statement_timestamp();

  insert into public.work_report_delegations
    (grantor_user_id, delegate_app_user_id, capability, template_id, template_version_id,
     scope_kind, scope_team_id, effective_from, effective_to, state, is_current, version)
  values
    (p_app_user_id, p_delegate_app_user_id, p_capability, p_template_id, v_template.current_published_version_id,
     p_scope_kind, p_scope_team_id, v_effective_from, null, 'ACTIVE', true, 1)
  returning delegation_id into v_delegation_id;

  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, scope_team_id, template_id, outcome, metadata_json)
  values
    ('DELEGATION_CREATE', p_app_user_id, 'report_delegate', p_scope_kind, p_scope_team_id, p_template_id, 'APPLIED',
     jsonb_build_object(
       'delegation_id', v_delegation_id,
       'delegated_capability', p_capability,
       'delegate_app_user_id', p_delegate_app_user_id,
       'effective_from', v_effective_from,
       'effective_to', null
     ));

  v_result := jsonb_build_object(
    'delegation_id', v_delegation_id,
    'status', 'ACTIVE',
    'state', 'ACTIVE',
    'effective_from', v_effective_from,
    'effective_to', null,
    'version', 1
  );
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_delegation_create', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

-- =============================================================================
-- SECTION 10: Postcheck Verification (Zero Legacy Blockers & Preserved 3D State)
-- =============================================================================

do $wp10_7_3c_postcheck$
declare
  v_default_expr text;
  v_unmanaged_count integer;
  v_legacy_bridge_count integer;
  v_blocking_static_count integer;
  v_blocking_static_list text;
  v_blocking_dynamic_count integer;
  v_blocking_dynamic_list text;
  v_legacy_table_count integer;
  v_tl_sync_trigger_count integer;
  v_shared_trigger_fn_count integer;
  v_bad_security_count integer;
  v_bad_security_list text;
  v_executor oid;
  v_service_role_rpc_count integer;
  v_client_exec_count integer;
begin
  select pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)
    into v_default_expr
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_attrdef ad
      on ad.adrelid = a.attrelid
     and ad.adnum = a.attnum
   where a.attrelid = 'public.direct_entry_app_users'::regclass
     and a.attname = 'authz_managed'
     and not a.attisdropped;

  if v_default_expr is distinct from 'true' then
    raise exception 'WP10.7 3C postcheck failed: authz_managed default is %, expected true',
      coalesce(v_default_expr, '<null>')
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_unmanaged_count
    from public.direct_entry_app_users u
   where coalesce(u.authz_managed, false) = false;

  if v_unmanaged_count > 0 then
    raise exception 'WP10.7 3C postcheck failed: % account(s) have authz_managed=false',
      v_unmanaged_count
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_legacy_bridge_count
    from public.direct_entry_app_users u
    cross join lateral pg_catalog.jsonb_to_recordset(
      public.direct_entry_authz__internal_resolve_effective_grants(u.app_user_id)
    ) as g(source_type text)
   where g.source_type = 'LEGACY_BRIDGE';

  if v_legacy_bridge_count > 0 then
    raise exception 'WP10.7 3C postcheck failed: % LEGACY_BRIDGE grant row(s) still emitted',
      v_legacy_bridge_count
      using errcode = '55000';
  end if;

  with app_procs as (
    select
      p.oid,
      n.nspname as schema_name,
      p.proname as proc_name,
      n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' as signature,
      pg_catalog.regexp_replace(
        coalesce(p.prosrc, ''),
        $rx$('([^']|'')*'|--[^\r\n]*|/\*.*?\*/)$rx$,
        ' ',
        'g'
      ) as norm_no_strings,
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          coalesce(p.prosrc, ''),
          $rx$(--[^\r\n]*|/\*.*?\*/)$rx$,
          ' ',
          'g'
        ),
        '''''',
        '''',
        'g'
      ) as no_comments_norm_quotes
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
  ),
  hits as (
    select
      ap.signature,
      (ap.norm_no_strings ~* '\mdirect_entry_capability_grants\M') as static_cap,
      (ap.norm_no_strings ~* '\mdirect_entry_scope_grants\M') as static_scope,
      (ap.norm_no_strings ~* '\mwork_report_team_leader_capability_grants\M') as static_bridge,
      (ap.norm_no_strings ~* '\m(direct_entry_authz__internal_sync_legacy_grants|work_report_sync_team_leader_capabilities|direct_entry_has_capability|direct_entry_has_scope|direct_entry__internal_capability_grant_effective|direct_entry__internal_team_scope_grant_effective|direct_entry_assert_actor|direct_entry__internal_reconcile_cancelled_team_leaders|direct_entry_transition_legacy_team_leaders|direct_entry_seed_team_scope_grants)\M') as static_legacy_fn,
      (
        ap.norm_no_strings ~* '\mexecute\M'
        and ap.no_comments_norm_quotes ~* '\m(direct_entry_capability_grants|direct_entry_scope_grants|work_report_team_leader_capability_grants|direct_entry_authz__internal_sync_legacy_grants|work_report_sync_team_leader_capabilities|direct_entry_has_capability|direct_entry_has_scope|direct_entry__internal_capability_grant_effective|direct_entry__internal_team_scope_grant_effective|direct_entry_assert_actor|direct_entry__internal_reconcile_cancelled_team_leaders|direct_entry_transition_legacy_team_leaders|direct_entry_seed_team_scope_grants)\M'
      ) as dynamic_execute_ref,
      (
        ap.schema_name = 'public'
        and ap.proc_name in (
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
        )
      ) as is_planned_3d_drop_fn,
      (
        ap.schema_name = 'public'
        and ap.proc_name in (
          'direct_entry_guard_effective_interval',
          'direct_entry_set_current_on_insert'
        )
      ) as is_shared_trigger_fn_to_trim_in_3d
    from app_procs ap
  )
  select
    count(*) filter (
      where not h.dynamic_execute_ref
        and not h.is_planned_3d_drop_fn
        and not h.is_shared_trigger_fn_to_trim_in_3d
        and (h.static_cap or h.static_scope or h.static_bridge or h.static_legacy_fn)
    )::integer,
    string_agg(h.signature, ', ' order by h.signature) filter (
      where not h.dynamic_execute_ref
        and not h.is_planned_3d_drop_fn
        and not h.is_shared_trigger_fn_to_trim_in_3d
        and (h.static_cap or h.static_scope or h.static_bridge or h.static_legacy_fn)
    ),
    count(*) filter (where h.dynamic_execute_ref)::integer,
    string_agg(h.signature, ', ' order by h.signature) filter (where h.dynamic_execute_ref)
    into v_blocking_static_count, v_blocking_static_list,
         v_blocking_dynamic_count, v_blocking_dynamic_list
    from hits h;

  if v_blocking_static_count <> 0 or v_blocking_dynamic_count <> 0 then
    raise exception 'WP10.7 3C postcheck failed: blocking_static_procs=% (%), blocking_dynamic_execute_procs=% (%)',
      v_blocking_static_count, coalesce(v_blocking_static_list, ''),
      v_blocking_dynamic_count, coalesce(v_blocking_dynamic_list, '')
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_legacy_table_count
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and c.relname in (
       'direct_entry_capability_grants',
       'direct_entry_scope_grants',
       'work_report_team_leader_capability_grants'
     );

  if v_legacy_table_count <> 3 then
    raise exception 'WP10.7 3C postcheck failed: expected 3 legacy tables preserved for 3D, found %',
      v_legacy_table_count
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_tl_sync_trigger_count
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where not t.tgisinternal
     and n.nspname = 'public'
     and c.relname = 'direct_entry_team_leader_assignments'
     and t.tgname = 'work_report_sync_team_leader_capabilities';

  if v_tl_sync_trigger_count <> 1 then
    raise exception 'WP10.7 3C postcheck failed: work_report_sync_team_leader_capabilities trigger missing'
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_shared_trigger_fn_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'direct_entry_guard_effective_interval',
       'direct_entry_set_current_on_insert',
       'direct_entry_reject_system_vendor_business_team',
       'direct_entry_team_leader_marker',
       'direct_entry_clear_authority_on_disable'
     );

  if v_shared_trigger_fn_count <> 5 then
    raise exception 'WP10.7 3C postcheck failed: expected 5 shared trigger functions intact, found %',
      v_shared_trigger_fn_count
      using errcode = '55000';
  end if;

  select count(*)::integer,
         string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    into v_bad_security_count, v_bad_security_list
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and (
       p.proname in (
         'direct_entry_authz__internal_sync_legacy_grants',
         'work_report_sync_team_leader_capabilities',
         'direct_entry_has_capability',
         'direct_entry_has_scope',
         'direct_entry_assert_actor',
         'direct_entry_authz__internal_resolve_effective_grants',
         'direct_entry_resolve_actor_context',
         'direct_entry_authz_assign_group_member_admin',
         'direct_entry_authz_remove_group_member_admin',
         'direct_entry_authz_update_group_admin',
         'direct_entry_account_operation_finalize_create',
         'direct_entry_account_operation_link_recruiter',
         'direct_entry_account_operation_create_personnel',
         'direct_entry_mutate_app_user_status',
         'direct_entry_clear_authority_on_disable',
         'direct_entry_lock_project_team_manager_context',
         'direct_entry_list_team_leader_candidates',
         'direct_entry_apply_team_leader_mutation',
         'direct_entry_input_catalog_unscoped_v42',
         'direct_entry_catalog_bootstrap_plan',
         'direct_entry_apply_catalog_bootstrap',
         'direct_entry__internal_assert_cccd_qr_read_access',
         'direct_entry__internal_resolve_cccd_review_authority',
         'direct_entry_apply_change_item',
         'direct_entry_assert_catalog_operator',
         'direct_entry_assert_change_request_capabilities',
         'direct_entry_assert_document_upload_access',
         'direct_entry_assert_draft_access',
         'direct_entry_assert_entry_access',
         'direct_entry_assert_payment_document_access',
         'direct_entry_assert_project_admin',
         'direct_entry_assert_team_leader_current_team',
         'direct_entry_change_request_audience',
         'direct_entry_claim_worker_portrait_stage',
         'direct_entry_complete_worker_document_stage',
         'direct_entry_complete_worker_portrait_stage',
         'direct_entry_create_authority',
         'direct_entry_create_full_profile_batch',
         'direct_entry_create_full_profile_batch_with_portrait_stages',
         'direct_entry_create_worker_document_stage_idempotent',
         'direct_entry_create_worker_portrait_stage',
         'direct_entry_create_worker_portrait_stage_idempotent',
         'direct_entry_decide_change_request',
         'direct_entry_delete_draft_submission',
         'direct_entry_document_direct_context',
         'direct_entry_has_entry_access',
         'direct_entry_list_cccd_review_queue',
         'direct_entry_list_global_change_request_history',
         'direct_entry_list_own_drafts',
         'direct_entry_list_own_submissions',
         'direct_entry_read_change_request',
         'direct_entry_read_own_submission',
         'direct_entry_read_projection',
         'direct_entry_resolve_change_request_scope',
         'direct_entry_resolve_direct_edit_authority',
         'direct_entry_resolve_submission_read_scope',
         'direct_entry_self_withdraw_duplicate_cccd',
         'direct_entry_submission_duplicate_cccd_preflight',
         'direct_entry_transition_submission_apply',
         'direct_entry_worker_directory_audience',
         'attendance__internal_resolve_report_scope_v2',
         'work_report__internal_direct_team_ids',
         'work_report__internal_has_direct_capability',
         'work_report__internal_has_direct_scope',
         'work_report__internal_is_delegation_effective',
         'work_report__internal_is_full_admin',
         'work_report_create_delegation'
       )
       or p.oid = 'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'::regprocedure
     )
     and (
       not p.prosecdef
       or not ('search_path=pg_catalog, public' = any(coalesce(p.proconfig, array[]::text[])))
     );

  if v_bad_security_count <> 0 then
    raise exception 'WP10.7 3C postcheck failed: % function(s) violate SECURITY DEFINER / search_path: %',
      v_bad_security_count, coalesce(v_bad_security_list, '')
      using errcode = '55000';
  end if;

  select r.oid into v_executor
    from pg_catalog.pg_roles r
   where r.rolname = 'direct_entry_catalog_bootstrap_executor';

  if v_executor is null or not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.direct_entry_catalog_bootstrap_plan(uuid,uuid)'::regprocedure
       and p.proowner = v_executor
       and p.prosecdef
  ) or not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)'::regprocedure
       and p.proowner = v_executor
       and p.prosecdef
  ) then
    raise exception 'WP10.7 3C postcheck failed: catalog bootstrap executor owner check failed'
      using errcode = '55000';
  end if;

  select
    count(*) filter (
      where pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
    )::integer,
    count(*) filter (
      where pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE')
         or pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE')
         or pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE')
    )::integer
    into v_service_role_rpc_count, v_client_exec_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and p.proname !~ '^s0_t1c_'
     and not exists (
       select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_proc'::regclass
          and d.objid = p.oid
          and d.deptype = 'e'
     );

  if v_service_role_rpc_count <> 310 or v_client_exec_count <> 0 then
    raise exception 'WP10.7 3C postcheck failed: expected 310 service_role RPCs and 0 client/PUBLIC EXECUTE, got service_role=% client_public=%',
      v_service_role_rpc_count, v_client_exec_count
      using errcode = '55000';
  end if;
end;
$wp10_7_3c_postcheck$;

commit;
