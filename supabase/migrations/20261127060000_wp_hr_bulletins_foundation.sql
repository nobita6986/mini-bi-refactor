-- =============================================================================
-- HR Bulletins Foundation (Capability `bulletin_manage`, Schema, RLS,
-- Internal Helpers, 12 Entrypoint RPCs, and Fail-Closed Postcheck)
-- =============================================================================

begin;

-- =============================================================================
-- SECTION 1: Extend Capability `bulletin_manage` (at ALL) & Seed Role/Group Caps
-- =============================================================================

alter table public.authz_role_capabilities
  drop constraint authz_role_capabilities_cap_chk;

alter table public.authz_role_capabilities
  add constraint authz_role_capabilities_cap_chk check (capability in (
    'entry_create',
    'entry_own',
    'entry_team',
    'entry_admin',
    'entry_restore',
    'submission_create',
    'change_request_create',
    'change_review',
    'entry_privileged_edit',
    'employment_status.request',
    'employment_status.review',
    'employment_status.apply',
    'document_upload',
    'document_view',
    'recruiter_master_manage',
    'team_master_manage',
    'audit_view',
    'catalog_master_manage',
    'team_manager_assign',
    'report_form_manage',
    'report_assign',
    'report_view',
    'report_analytics_view',
    'report_review',
    'report_delegate',
    'vendor_finance_view',
    'vendor_finance_record',
    'duplicate_cccd_withdraw',
    'worker_edit_history_view',
    'bulletin_manage'
  ));

alter table public.authz_direct_capability_grants
  drop constraint authz_direct_capability_grants_cap_chk;

alter table public.authz_direct_capability_grants
  add constraint authz_direct_capability_grants_cap_chk check (capability in (
    'entry_create',
    'entry_own',
    'entry_team',
    'entry_admin',
    'entry_restore',
    'submission_create',
    'change_request_create',
    'change_review',
    'entry_privileged_edit',
    'employment_status.request',
    'employment_status.review',
    'employment_status.apply',
    'document_upload',
    'document_view',
    'recruiter_master_manage',
    'team_master_manage',
    'audit_view',
    'catalog_master_manage',
    'team_manager_assign',
    'report_form_manage',
    'report_assign',
    'report_view',
    'report_analytics_view',
    'report_review',
    'report_delegate',
    'vendor_finance_view',
    'vendor_finance_record',
    'duplicate_cccd_withdraw',
    'worker_edit_history_view',
    'bulletin_manage'
  ));

alter table public.authz_user_group_capabilities
  drop constraint authz_user_group_capabilities_cap_chk;

alter table public.authz_user_group_capabilities
  add constraint authz_user_group_capabilities_cap_chk check (capability in (
    'entry_create',
    'entry_own',
    'entry_team',
    'entry_admin',
    'entry_restore',
    'submission_create',
    'change_request_create',
    'change_review',
    'entry_privileged_edit',
    'employment_status.request',
    'employment_status.review',
    'employment_status.apply',
    'document_upload',
    'document_view',
    'recruiter_master_manage',
    'team_master_manage',
    'audit_view',
    'catalog_master_manage',
    'team_manager_assign',
    'report_form_manage',
    'report_assign',
    'report_view',
    'report_analytics_view',
    'report_review',
    'report_delegate',
    'vendor_finance_view',
    'vendor_finance_record',
    'duplicate_cccd_withdraw',
    'worker_edit_history_view',
    'bulletin_manage'
  ));

insert into public.authz_role_capabilities (role_code, capability, scope_template, retired_compat, sort_order) values
  ('HR_OPERATOR', 'bulletin_manage', 'ALL', false, 6),
  ('ADMIN', 'bulletin_manage', 'ALL', false, 22)
on conflict (role_code, capability) do nothing;

insert into public.authz_user_group_capabilities (group_id, capability, reason)
select g.group_id, 'bulletin_manage', 'Khởi tạo quyền quản lý bảng tin nhân sự'
  from public.authz_user_groups g
 where g.code in ('SYSTEM_ADMIN', 'HR_CATALOG_OPERATOR')
on conflict (group_id, capability) where ended_at is null do nothing;

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
            'worker_edit_history_view',
            'bulletin_manage'
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

revoke all on function public.direct_entry_resolve_actor_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_resolve_actor_context(uuid)
  to service_role;

-- =============================================================================
-- SECTION 2: Tables (Permanent Web Archive), Indexes, and Fail-Closed RLS
-- =============================================================================

create table public.hr_bulletins (
  bulletin_id uuid primary key default gen_random_uuid(),
  title text not null
    constraint hr_bulletins_title_chk check (
      pg_catalog.btrim(title) = title
      and pg_catalog.length(title) between 1 and 300
      and title !~ '[\x00-\x1f\x7f]'
    ),
  category text not null
    constraint hr_bulletins_category_chk check (
      category in ('HR_NEWS', 'HOLIDAY_SCHEDULE', 'INTERNAL_POLICY', 'GENERAL')
    ),
  badge_text text null
    constraint hr_bulletins_badge_text_chk check (
      badge_text is null
      or (
        pg_catalog.btrim(badge_text) = badge_text
        and pg_catalog.length(badge_text) between 1 and 40
        and badge_text !~ '[\x00-\x1f\x7f]'
      )
    ),
  summary text not null default ''
    constraint hr_bulletins_summary_chk check (
      pg_catalog.length(summary) <= 600
      and summary !~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]'
    ),
  content_sections jsonb not null default '[]'::jsonb
    constraint hr_bulletins_content_sections_type_chk check (
      pg_catalog.jsonb_typeof(content_sections) = 'array'
    ),
  author_display text not null default 'Phòng Hành chính - Nhân sự HRPartner'
    constraint hr_bulletins_author_display_chk check (
      pg_catalog.btrim(author_display) = author_display
      and pg_catalog.length(author_display) between 1 and 160
      and author_display !~ '[\x00-\x1f\x7f]'
    ),
  is_pinned boolean not null default false,
  status text not null default 'DRAFT'
    constraint hr_bulletins_status_chk check (
      status in ('DRAFT', 'PUBLISHED', 'ARCHIVED')
    ),
  published_at timestamptz null,
  archived_at timestamptz null,
  row_version integer not null default 1
    constraint hr_bulletins_row_version_chk check (row_version >= 1),
  created_by uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  updated_by uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hr_bulletins_published_content_chk check (
    status <> 'PUBLISHED' or pg_catalog.jsonb_array_length(content_sections) >= 1
  ),
  constraint hr_bulletins_published_at_chk check (
    status <> 'PUBLISHED' or published_at is not null
  ),
  constraint hr_bulletins_archived_at_chk check (
    status <> 'ARCHIVED' or archived_at is not null
  )
);

create index hr_bulletins_mobile_feed_idx
  on public.hr_bulletins (status, is_pinned desc, published_at desc, bulletin_id desc);

create index hr_bulletins_web_archive_idx
  on public.hr_bulletins (published_at desc, category, created_by);

create index hr_bulletins_status_updated_idx
  on public.hr_bulletins (status, updated_at desc, bulletin_id desc);

create table public.hr_bulletin_attachments (
  attachment_id uuid primary key default gen_random_uuid(),
  bulletin_id uuid not null
    references public.hr_bulletins(bulletin_id) on delete cascade,
  sort_order integer not null default 0
    constraint hr_bulletin_attachments_sort_order_chk check (sort_order >= 0),
  kind text not null
    constraint hr_bulletin_attachments_kind_chk check (kind in ('IMAGE', 'PDF')),
  file_name text not null
    constraint hr_bulletin_attachments_file_name_chk check (
      pg_catalog.btrim(file_name) = file_name
      and pg_catalog.length(file_name) between 1 and 255
      and file_name !~ '[\x00-\x1f\x7f]'
    ),
  title text not null
    constraint hr_bulletin_attachments_title_chk check (
      pg_catalog.btrim(title) = title
      and pg_catalog.length(title) between 1 and 255
      and title !~ '[\x00-\x1f\x7f]'
    ),
  mime_type text not null
    constraint hr_bulletin_attachments_mime_type_chk check (
      mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
    ),
  file_size_bytes bigint not null
    constraint hr_bulletin_attachments_file_size_chk check (
      file_size_bytes > 0 and file_size_bytes <= 15728640
    ),
  storage_key text not null unique
    constraint hr_bulletin_attachments_storage_key_chk check (
      pg_catalog.btrim(storage_key) = storage_key
      and pg_catalog.length(storage_key) between 1 and 512
      and storage_key !~ '[\x00-\x1f\x7f]'
    ),
  width integer null
    constraint hr_bulletin_attachments_width_chk check (width is null or width > 0),
  height integer null
    constraint hr_bulletin_attachments_height_chk check (height is null or height > 0),
  page_count integer null
    constraint hr_bulletin_attachments_page_count_chk check (page_count is null or page_count > 0),
  sha256 char(64) not null
    constraint hr_bulletin_attachments_sha256_chk check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  constraint hr_bulletin_attachments_kind_mime_chk check (
    (kind = 'PDF' and mime_type = 'application/pdf')
    or (kind = 'IMAGE' and mime_type in ('image/jpeg', 'image/png', 'image/webp'))
  )
);

create index hr_bulletin_attachments_bulletin_order_idx
  on public.hr_bulletin_attachments (bulletin_id, sort_order asc, created_at asc, attachment_id asc);

create table public.hr_bulletin_reads (
  bulletin_id uuid not null
    references public.hr_bulletins(bulletin_id) on delete cascade,
  app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (bulletin_id, app_user_id)
);

create index hr_bulletin_reads_user_bulletin_idx
  on public.hr_bulletin_reads (app_user_id, bulletin_id);

create table public.hr_bulletin_idempotency (
  idempotency_record_id uuid primary key default gen_random_uuid(),
  actor_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  operation_name text not null
    constraint hr_bulletin_idempotency_op_chk check (
      pg_catalog.btrim(operation_name) = operation_name
      and pg_catalog.length(operation_name) between 1 and 96
    ),
  target_key text not null
    constraint hr_bulletin_idempotency_target_chk check (
      pg_catalog.btrim(target_key) = target_key
      and pg_catalog.length(target_key) between 1 and 128
    ),
  idempotency_key text not null
    constraint hr_bulletin_idempotency_key_chk check (
      pg_catalog.btrim(idempotency_key) = idempotency_key
      and pg_catalog.length(idempotency_key) between 1 and 128
    ),
  request_hash text not null
    constraint hr_bulletin_idempotency_hash_chk check (request_hash ~ '^[a-f0-9]{64}$'),
  response_payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (actor_app_user_id, operation_name, target_key, idempotency_key)
);

alter table public.hr_bulletins enable row level security;
alter table public.hr_bulletins force row level security;
revoke all on table public.hr_bulletins from public, anon, authenticated, service_role;

alter table public.hr_bulletin_attachments enable row level security;
alter table public.hr_bulletin_attachments force row level security;
revoke all on table public.hr_bulletin_attachments from public, anon, authenticated, service_role;

alter table public.hr_bulletin_reads enable row level security;
alter table public.hr_bulletin_reads force row level security;
revoke all on table public.hr_bulletin_reads from public, anon, authenticated, service_role;

alter table public.hr_bulletin_idempotency enable row level security;
alter table public.hr_bulletin_idempotency force row level security;
revoke all on table public.hr_bulletin_idempotency from public, anon, authenticated, service_role;

-- =============================================================================
-- SECTION 3: Internal Helpers (`hr_bulletin__internal_*`)
-- =============================================================================

create or replace function public.hr_bulletin__internal_assert_active_actor(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_created_at timestamptz;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'BULLETIN_ACTOR_FORBIDDEN' using errcode = '42501';
  end if;

  select u.created_at
    into v_created_at
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject
     and u.app_user_id = p_app_user_id
     and u.enabled = true
     and coalesce(u.authz_managed, false) = true;

  if not found then
    raise exception 'BULLETIN_ACTOR_FORBIDDEN' using errcode = '42501';
  end if;

  return greatest(pg_catalog.clock_timestamp() - interval '7 days', v_created_at);
end;
$function$;

create or replace function public.hr_bulletin__internal_has_manage_authority(
  p_app_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'bulletin_manage', 'ALL', null),
    false
  )
  or (
    coalesce(public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null), false)
    and coalesce(public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_restore', 'ALL', null), false)
    and coalesce(public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null), false)
  );
$function$;

create or replace function public.hr_bulletin__internal_count_unread(
  p_app_user_id uuid,
  p_cutoff timestamptz
)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select coalesce(count(*), 0)::integer
    from public.hr_bulletins b
   where b.status = 'PUBLISHED'
     and b.published_at >= p_cutoff
     and not exists (
       select 1
         from public.hr_bulletin_reads r
        where r.bulletin_id = b.bulletin_id
          and r.app_user_id = p_app_user_id
     );
$function$;

create or replace function public.hr_bulletin__internal_normalize_text(
  p_value text,
  p_min_len integer,
  p_max_len integer,
  p_allow_multiline boolean,
  p_err_code text
)
returns text
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_trimmed text;
begin
  if p_value is null then
    raise exception '%', p_err_code using errcode = '22023';
  end if;

  v_trimmed := pg_catalog.btrim(p_value);
  if pg_catalog.length(v_trimmed) < p_min_len
     or pg_catalog.length(v_trimmed) > p_max_len then
    raise exception '%', p_err_code using errcode = '22023';
  end if;

  if p_allow_multiline then
    if v_trimmed ~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' then
      raise exception '%', p_err_code using errcode = '22023';
    end if;
  else
    if v_trimmed ~ '[\x00-\x1f\x7f]' then
      raise exception '%', p_err_code using errcode = '22023';
    end if;
  end if;

  return v_trimmed;
end;
$function$;

create or replace function public.hr_bulletin__internal_validate_sections(
  p_sections jsonb,
  p_require_non_empty boolean
)
returns jsonb
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_len integer;
  v_elem jsonb;
  v_trimmed text;
  v_out jsonb := '[]'::jsonb;
begin
  if p_sections is null or pg_catalog.jsonb_typeof(p_sections) <> 'array' then
    raise exception 'BULLETIN_CONTENT_SECTIONS_INVALID' using errcode = '22023';
  end if;

  v_len := pg_catalog.jsonb_array_length(p_sections);
  if v_len = 0 then
    if coalesce(p_require_non_empty, false) then
      raise exception 'BULLETIN_PUBLISH_CONTENT_REQUIRED' using errcode = '22023';
    end if;
    return '[]'::jsonb;
  end if;

  if v_len > 50 then
    raise exception 'BULLETIN_CONTENT_SECTIONS_INVALID' using errcode = '22023';
  end if;

  for v_elem in
    select value from pg_catalog.jsonb_array_elements(p_sections)
  loop
    if pg_catalog.jsonb_typeof(v_elem) <> 'string' then
      raise exception 'BULLETIN_CONTENT_SECTIONS_INVALID' using errcode = '22023';
    end if;

    v_trimmed := public.hr_bulletin__internal_normalize_text(
      v_elem #>> '{}',
      1,
      8000,
      true,
      'BULLETIN_CONTENT_SECTIONS_INVALID'
    );
    v_out := v_out || pg_catalog.jsonb_build_array(v_trimmed);
  end loop;

  return v_out;
end;
$function$;

create or replace function public.hr_bulletin__internal_format_item(
  p_bulletin_id uuid,
  p_app_user_id uuid,
  p_cutoff timestamptz,
  p_include_admin_meta boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_b public.hr_bulletins%rowtype;
  v_is_read boolean;
  v_image_count integer := 0;
  v_pdf_count integer := 0;
  v_attachments jsonb := '[]'::jsonb;
  v_item jsonb;
begin
  select b.*
    into v_b
    from public.hr_bulletins b
   where b.bulletin_id = p_bulletin_id;

  if not found then
    return null;
  end if;

  if v_b.status <> 'PUBLISHED' or v_b.published_at < p_cutoff then
    v_is_read := true;
  else
    select exists (
      select 1
        from public.hr_bulletin_reads r
       where r.bulletin_id = v_b.bulletin_id
         and r.app_user_id = p_app_user_id
    ) into v_is_read;
  end if;

  select
    coalesce(count(*) filter (where a.kind = 'IMAGE'), 0)::integer,
    coalesce(count(*) filter (where a.kind = 'PDF'), 0)::integer,
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'attachment_id', a.attachment_id,
          'id', a.attachment_id,
          'kind', a.kind,
          'file_name', a.file_name,
          'title', a.title,
          'mime_type', a.mime_type,
          'file_size_bytes', a.file_size_bytes,
          'url', '/api/bulletins/' || v_b.bulletin_id::text || '/attachments/' || a.attachment_id::text || '/content',
          'thumbnail_url', null,
          'width', a.width,
          'height', a.height,
          'page_count', a.page_count,
          'sha256', pg_catalog.btrim(a.sha256::text)
        )
        order by a.sort_order asc, a.created_at asc, a.attachment_id asc
      ),
      '[]'::jsonb
    )
    into v_image_count, v_pdf_count, v_attachments
    from public.hr_bulletin_attachments a
   where a.bulletin_id = v_b.bulletin_id;

  v_item := pg_catalog.jsonb_build_object(
    'bulletin_id', v_b.bulletin_id,
    'id', v_b.bulletin_id,
    'title', v_b.title,
    'category', v_b.category,
    'category_display', case v_b.category
      when 'HR_NEWS' then 'Tin nhân sự'
      when 'HOLIDAY_SCHEDULE' then 'Lịch nghỉ lễ'
      when 'INTERNAL_POLICY' then 'Vận hành'
      when 'GENERAL' then 'Thông báo chung'
    end,
    'badge_text', v_b.badge_text,
    'is_pinned', v_b.is_pinned,
    'is_read', v_is_read,
    'published_at', case
      when v_b.published_at is not null
        then pg_catalog.to_char(v_b.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      else null
    end,
    'published_date_display', case
      when v_b.status <> 'DRAFT' and v_b.published_at is not null
        then pg_catalog.to_char(v_b.published_at at time zone 'Asia/Ho_Chi_Minh', 'DD-MM-YYYY')
      else ''
    end,
    'author_display', v_b.author_display,
    'summary', v_b.summary,
    'content_sections', v_b.content_sections,
    'image_count', v_image_count,
    'pdf_count', v_pdf_count,
    'attachment_summary', pg_catalog.jsonb_build_object(
      'image_count', v_image_count,
      'pdf_count', v_pdf_count
    ),
    'attachments', v_attachments
  );

  if coalesce(p_include_admin_meta, false) then
    v_item := v_item || pg_catalog.jsonb_build_object(
      'status', v_b.status,
      'row_version', v_b.row_version,
      'archived_at', case
        when v_b.archived_at is not null
          then pg_catalog.to_char(v_b.archived_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        else null
      end,
      'created_at', pg_catalog.to_char(v_b.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updated_at', pg_catalog.to_char(v_b.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'created_by', v_b.created_by,
      'updated_by', v_b.updated_by
    );
  end if;

  return v_item;
end;
$function$;

create or replace function public.hr_bulletin__internal_idempotency_begin(
  p_actor_app_user_id uuid,
  p_operation_name text,
  p_target_key text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_idem_key text;
  v_existing public.hr_bulletin_idempotency%rowtype;
begin
  v_idem_key := nullif(pg_catalog.btrim(p_idempotency_key), '');
  if v_idem_key is null
     or pg_catalog.length(v_idem_key) > 128
     or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'BULLETIN_IDEMPOTENCY_INVALID' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'hr_bulletin:idem:' || p_actor_app_user_id::text || ':' || p_operation_name || ':' || p_target_key || ':' || v_idem_key,
      0
    )
  );

  select i.*
    into v_existing
    from public.hr_bulletin_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.operation_name = p_operation_name
     and i.target_key = p_target_key
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_existing.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  return null;
end;
$function$;

create or replace function public.hr_bulletin__internal_idempotency_finish(
  p_actor_app_user_id uuid,
  p_operation_name text,
  p_target_key text,
  p_idempotency_key text,
  p_request_hash text,
  p_response_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  insert into public.hr_bulletin_idempotency (
    actor_app_user_id,
    operation_name,
    target_key,
    idempotency_key,
    request_hash,
    response_payload
  ) values (
    p_actor_app_user_id,
    p_operation_name,
    p_target_key,
    pg_catalog.btrim(p_idempotency_key),
    p_request_hash,
    p_response_payload
  );
end;
$function$;

create or replace function public.hr_bulletin__internal_lock_for_manage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_bulletin_id uuid,
  p_expected_row_version integer
)
returns public.hr_bulletins
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_row public.hr_bulletins%rowtype;
begin
  perform public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);
  if not public.hr_bulletin__internal_has_manage_authority(p_app_user_id) then
    raise exception 'BULLETIN_FORBIDDEN' using errcode = '42501';
  end if;

  if p_bulletin_id is null or p_expected_row_version is null or p_expected_row_version < 1 then
    raise exception 'BULLETIN_VALIDATION_ERROR' using errcode = '22023';
  end if;

  select b.*
    into v_row
    from public.hr_bulletins b
   where b.bulletin_id = p_bulletin_id
   for update;

  if not found then
    raise exception 'BULLETIN_NOT_FOUND' using errcode = 'P0002';
  end if;

  return v_row;
end;
$function$;

-- =============================================================================
-- SECTION 4: 12 Public Entrypoint RPCs
-- =============================================================================

-- 1. hr_bulletin_list_mobile_feed
create or replace function public.hr_bulletin_list_mobile_feed(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_category text default null,
  p_page_size integer default 10,
  p_cursor_is_pinned boolean default null,
  p_cursor_published_at timestamptz default null,
  p_cursor_bulletin_id uuid default null,
  p_cursor_offset_count integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cutoff timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_category text;
  v_page_size integer;
  v_offset_count integer;
  v_has_cursor boolean;
  v_windowed_count integer := 0;
  v_use_fallback boolean := false;
  v_remaining_cap integer;
  v_fetch_limit integer;
  v_fetched_count integer := 0;
  v_returned_count integer := 0;
  v_new_offset integer;
  v_has_more boolean := false;
  v_items jsonb := '[]'::jsonb;
  v_next_cursor jsonb := null;
  v_latest_published_at text := null;
  v_rec record;
  v_last_is_pinned boolean := null;
  v_last_published_at timestamptz := null;
  v_last_bulletin_id uuid := null;
begin
  v_cutoff := public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);

  v_category := upper(nullif(pg_catalog.btrim(p_category), ''));
  if v_category = 'ALL' then
    v_category := null;
  end if;
  if v_category is not null and v_category not in ('HR_NEWS', 'HOLIDAY_SCHEDULE', 'INTERNAL_POLICY', 'GENERAL') then
    raise exception 'BULLETIN_CATEGORY_INVALID' using errcode = '22023';
  end if;

  v_page_size := least(20, greatest(1, coalesce(p_page_size, 10)));
  v_offset_count := coalesce(p_cursor_offset_count, 0);
  if v_offset_count < 0 then
    raise exception 'BULLETIN_CURSOR_INVALID' using errcode = '22023';
  end if;

  if p_cursor_is_pinned is null and p_cursor_published_at is null and p_cursor_bulletin_id is null then
    v_has_cursor := false;
  elsif p_cursor_is_pinned is not null and p_cursor_published_at is not null and p_cursor_bulletin_id is not null then
    v_has_cursor := true;
  else
    raise exception 'BULLETIN_CURSOR_INVALID' using errcode = '22023';
  end if;

  select pg_catalog.to_char(max(b.published_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    into v_latest_published_at
    from public.hr_bulletins b
   where b.status = 'PUBLISHED';

  v_remaining_cap := greatest(0, 20 - v_offset_count);
  v_fetch_limit := least(v_page_size, v_remaining_cap);

  if v_fetch_limit > 0 then
    select count(*)::integer
      into v_windowed_count
      from public.hr_bulletins b
     where b.status = 'PUBLISHED'
       and (v_category is null or b.category = v_category)
       and (b.is_pinned = true or b.published_at >= v_now - interval '30 days');

    v_use_fallback := (v_windowed_count < 5);

    for v_rec in
      with eligible as (
        select b.bulletin_id, b.is_pinned, b.published_at
          from public.hr_bulletins b
         where b.status = 'PUBLISHED'
           and (v_category is null or b.category = v_category)
           and (
             v_use_fallback
             or b.is_pinned = true
             or b.published_at >= v_now - interval '30 days'
           )
         order by b.is_pinned desc, b.published_at desc, b.bulletin_id desc
         limit case when v_use_fallback then 5 else 20 end
      )
      select e.bulletin_id, e.is_pinned, e.published_at
        from eligible e
       where (
         not v_has_cursor
         or e.is_pinned < p_cursor_is_pinned
         or (e.is_pinned = p_cursor_is_pinned and e.published_at < p_cursor_published_at)
         or (
           e.is_pinned = p_cursor_is_pinned
           and e.published_at = p_cursor_published_at
           and e.bulletin_id < p_cursor_bulletin_id
         )
       )
       order by e.is_pinned desc, e.published_at desc, e.bulletin_id desc
       limit v_fetch_limit + 1
    loop
      v_fetched_count := v_fetched_count + 1;
      if v_fetched_count <= v_fetch_limit then
        v_returned_count := v_returned_count + 1;
        v_items := v_items || pg_catalog.jsonb_build_array(
          public.hr_bulletin__internal_format_item(v_rec.bulletin_id, p_app_user_id, v_cutoff, false)
        );
        v_last_is_pinned := v_rec.is_pinned;
        v_last_published_at := v_rec.published_at;
        v_last_bulletin_id := v_rec.bulletin_id;
      end if;
    end loop;

    v_new_offset := v_offset_count + v_returned_count;
    v_has_more := (v_fetched_count > v_fetch_limit) and (v_new_offset < 20);
    if v_has_more and v_last_bulletin_id is not null then
      v_next_cursor := pg_catalog.jsonb_build_object(
        'is_pinned', v_last_is_pinned,
        'published_at', pg_catalog.to_char(v_last_published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'bulletin_id', v_last_bulletin_id,
        'offset_count', v_new_offset
      );
    end if;
  end if;

  return pg_catalog.jsonb_build_object(
    'items', v_items,
    'unread_count', public.hr_bulletin__internal_count_unread(p_app_user_id, v_cutoff),
    'latest_published_at', v_latest_published_at,
    'page_size', v_page_size,
    'has_more', v_has_more,
    'next_cursor_tuple', v_next_cursor
  );
end;
$function$;

-- 2. hr_bulletin_get_detail
create or replace function public.hr_bulletin_get_detail(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_bulletin_id uuid,
  p_allow_non_published boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cutoff timestamptz;
  v_allow_non_pub boolean := coalesce(p_allow_non_published, false);
  v_status text;
begin
  v_cutoff := public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);

  if v_allow_non_pub and not public.hr_bulletin__internal_has_manage_authority(p_app_user_id) then
    raise exception 'BULLETIN_FORBIDDEN' using errcode = '42501';
  end if;

  if p_bulletin_id is null then
    raise exception 'BULLETIN_NOT_FOUND' using errcode = 'P0002';
  end if;

  select b.status
    into v_status
    from public.hr_bulletins b
   where b.bulletin_id = p_bulletin_id;

  if not found or (not v_allow_non_pub and v_status <> 'PUBLISHED') then
    raise exception 'BULLETIN_NOT_FOUND' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'item',
    public.hr_bulletin__internal_format_item(p_bulletin_id, p_app_user_id, v_cutoff, v_allow_non_pub)
  );
end;
$function$;

-- 3. hr_bulletin_mark_read
create or replace function public.hr_bulletin_mark_read(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_bulletin_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cutoff timestamptz;
begin
  v_cutoff := public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);

  if p_bulletin_id is null or not exists (
    select 1
      from public.hr_bulletins b
     where b.bulletin_id = p_bulletin_id
       and b.status = 'PUBLISHED'
  ) then
    raise exception 'BULLETIN_NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.hr_bulletin_reads (bulletin_id, app_user_id, read_at)
  values (p_bulletin_id, p_app_user_id, pg_catalog.clock_timestamp())
  on conflict (bulletin_id, app_user_id) do nothing;

  return pg_catalog.jsonb_build_object(
    'bulletin_id', p_bulletin_id,
    'is_read', true,
    'unread_count', public.hr_bulletin__internal_count_unread(p_app_user_id, v_cutoff)
  );
end;
$function$;

-- 4. hr_bulletin_mark_all_read
create or replace function public.hr_bulletin_mark_all_read(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cutoff timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  v_cutoff := public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);

  insert into public.hr_bulletin_reads (bulletin_id, app_user_id, read_at)
  select b.bulletin_id, p_app_user_id, v_now
    from public.hr_bulletins b
   where b.status = 'PUBLISHED'
     and b.published_at >= v_cutoff
     and not exists (
       select 1
         from public.hr_bulletin_reads r
        where r.bulletin_id = b.bulletin_id
          and r.app_user_id = p_app_user_id
     )
  on conflict (bulletin_id, app_user_id) do nothing;

  return pg_catalog.jsonb_build_object('unread_count', 0);
end;
$function$;

-- 5. hr_bulletin_get_attachment_content_meta
create or replace function public.hr_bulletin_get_attachment_content_meta(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_bulletin_id uuid,
  p_attachment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_can_manage boolean;
  v_status text;
  v_att public.hr_bulletin_attachments%rowtype;
begin
  perform public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);
  v_can_manage := public.hr_bulletin__internal_has_manage_authority(p_app_user_id);

  if p_bulletin_id is null then
    raise exception 'BULLETIN_NOT_FOUND' using errcode = 'P0002';
  end if;

  select b.status
    into v_status
    from public.hr_bulletins b
   where b.bulletin_id = p_bulletin_id;

  if not found or (v_status <> 'PUBLISHED' and not v_can_manage) then
    raise exception 'BULLETIN_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_attachment_id is null then
    raise exception 'BULLETIN_ATTACHMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select a.*
    into v_att
    from public.hr_bulletin_attachments a
   where a.bulletin_id = p_bulletin_id
     and a.attachment_id = p_attachment_id;

  if not found then
    raise exception 'BULLETIN_ATTACHMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  return pg_catalog.jsonb_build_object(
    'attachment_id', v_att.attachment_id,
    'id', v_att.attachment_id,
    'bulletin_id', v_att.bulletin_id,
    'kind', v_att.kind,
    'file_name', v_att.file_name,
    'title', v_att.title,
    'mime_type', v_att.mime_type,
    'file_size_bytes', v_att.file_size_bytes,
    'storage_key', v_att.storage_key,
    'width', v_att.width,
    'height', v_att.height,
    'page_count', v_att.page_count,
    'sha256', pg_catalog.btrim(v_att.sha256::text)
  );
end;
$function$;

-- 6. hr_bulletin_list_archive
create or replace function public.hr_bulletin_list_archive(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_from_date date default null,
  p_to_date date default null,
  p_category text default null,
  p_status text default null,
  p_author text default null,
  p_created_by uuid default null,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cutoff timestamptz;
  v_can_manage boolean;
  v_category text;
  v_status text;
  v_effective_status text;
  v_author text;
  v_author_like text;
  v_search text;
  v_search_like text;
  v_page integer;
  v_page_size integer;
  v_offset integer;
  v_total_count integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_authors jsonb := '[]'::jsonb;
begin
  v_cutoff := public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);
  v_can_manage := public.hr_bulletin__internal_has_manage_authority(p_app_user_id);

  if p_from_date is not null and p_to_date is not null and p_from_date > p_to_date then
    raise exception 'BULLETIN_DATE_RANGE_INVALID' using errcode = '22023';
  end if;

  v_category := upper(nullif(pg_catalog.btrim(p_category), ''));
  if v_category = 'ALL' then
    v_category := null;
  end if;
  if v_category is not null and v_category not in ('HR_NEWS', 'HOLIDAY_SCHEDULE', 'INTERNAL_POLICY', 'GENERAL') then
    raise exception 'BULLETIN_CATEGORY_INVALID' using errcode = '22023';
  end if;

  v_status := upper(nullif(pg_catalog.btrim(p_status), ''));
  if v_status is not null and v_status not in ('ALL', 'DRAFT', 'PUBLISHED', 'ARCHIVED') then
    raise exception 'BULLETIN_STATUS_INVALID' using errcode = '22023';
  end if;
  if not v_can_manage and v_status in ('DRAFT', 'ARCHIVED', 'ALL') then
    raise exception 'BULLETIN_FORBIDDEN' using errcode = '42501';
  end if;

  v_effective_status := case
    when not v_can_manage then 'PUBLISHED'
    when v_status = 'ALL' then null
    else v_status
  end;

  v_author := nullif(pg_catalog.btrim(p_author), '');
  if v_author is not null then
    v_author_like := '%' || pg_catalog.regexp_replace(v_author, '([%_\\])', '\\\1', 'g') || '%';
  end if;

  v_search := nullif(pg_catalog.btrim(p_search), '');
  if v_search is not null then
    v_search_like := '%' || pg_catalog.regexp_replace(v_search, '([%_\\])', '\\\1', 'g') || '%';
  end if;

  v_page := greatest(1, coalesce(p_page, 1));
  v_page_size := least(100, greatest(1, coalesce(p_page_size, 20)));
  v_offset := (v_page - 1) * v_page_size;

  select count(*)::integer
    into v_total_count
    from public.hr_bulletins b
    left join public.direct_entry_app_users u
      on u.app_user_id = b.created_by
   where (v_effective_status is null or b.status = v_effective_status)
     and (v_category is null or b.category = v_category)
     and (p_created_by is null or b.created_by = p_created_by)
     and (
       p_from_date is null
       or (coalesce(b.published_at, b.created_at) at time zone 'Asia/Ho_Chi_Minh')::date >= p_from_date
     )
     and (
       p_to_date is null
       or (coalesce(b.published_at, b.created_at) at time zone 'Asia/Ho_Chi_Minh')::date <= p_to_date
     )
     and (
       v_author_like is null
       or b.author_display ilike v_author_like escape '\'
       or coalesce(u.display_name, '') ilike v_author_like escape '\'
     )
     and (
       v_search_like is null
       or b.title ilike v_search_like escape '\'
       or b.summary ilike v_search_like escape '\'
       or b.author_display ilike v_search_like escape '\'
       or b.content_sections::text ilike v_search_like escape '\'
     );

  select coalesce(
    pg_catalog.jsonb_agg(
      public.hr_bulletin__internal_format_item(paged.bulletin_id, p_app_user_id, v_cutoff, v_can_manage)
      order by paged.ord
    ),
    '[]'::jsonb
  )
    into v_items
    from (
      select b.bulletin_id, row_number() over (
        order by b.is_pinned desc, coalesce(b.published_at, b.created_at) desc, b.updated_at desc, b.bulletin_id desc
      ) as ord
        from public.hr_bulletins b
        left join public.direct_entry_app_users u
          on u.app_user_id = b.created_by
       where (v_effective_status is null or b.status = v_effective_status)
         and (v_category is null or b.category = v_category)
         and (p_created_by is null or b.created_by = p_created_by)
         and (
           p_from_date is null
           or (coalesce(b.published_at, b.created_at) at time zone 'Asia/Ho_Chi_Minh')::date >= p_from_date
         )
         and (
           p_to_date is null
           or (coalesce(b.published_at, b.created_at) at time zone 'Asia/Ho_Chi_Minh')::date <= p_to_date
         )
         and (
           v_author_like is null
           or b.author_display ilike v_author_like escape '\'
           or coalesce(u.display_name, '') ilike v_author_like escape '\'
         )
         and (
           v_search_like is null
           or b.title ilike v_search_like escape '\'
           or b.summary ilike v_search_like escape '\'
           or b.author_display ilike v_search_like escape '\'
           or b.content_sections::text ilike v_search_like escape '\'
         )
       order by b.is_pinned desc, coalesce(b.published_at, b.created_at) desc, b.updated_at desc, b.bulletin_id desc
       limit v_page_size offset v_offset
    ) paged;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'app_user_id', a.app_user_id,
        'display_name', a.display_name
      )
      order by a.display_name asc, a.app_user_id asc
    ),
    '[]'::jsonb
  )
    into v_authors
    from (
      select distinct u.app_user_id, u.display_name
        from public.hr_bulletins b
        join public.direct_entry_app_users u
          on u.app_user_id = b.created_by
       where v_can_manage or b.status = 'PUBLISHED'
    ) a;

  return pg_catalog.jsonb_build_object(
    'items', v_items,
    'total_count', v_total_count,
    'page', v_page,
    'page_size', v_page_size,
    'unread_count', public.hr_bulletin__internal_count_unread(p_app_user_id, v_cutoff),
    'can_manage', v_can_manage,
    'authors', v_authors
  );
end;
$function$;

-- 7. hr_bulletin_create_admin
create or replace function public.hr_bulletin_create_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_title text,
  p_category text,
  p_badge_text text,
  p_summary text,
  p_content_sections jsonb,
  p_author_display text,
  p_is_pinned boolean,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cutoff timestamptz;
  v_prior jsonb;
  v_title text;
  v_category text;
  v_badge_text text;
  v_summary text;
  v_sections jsonb;
  v_author_display text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_bulletin_id uuid;
  v_result jsonb;
begin
  v_cutoff := public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);
  if not public.hr_bulletin__internal_has_manage_authority(p_app_user_id) then
    raise exception 'BULLETIN_FORBIDDEN' using errcode = '42501';
  end if;

  v_prior := public.hr_bulletin__internal_idempotency_begin(
    p_app_user_id,
    'hr_bulletin_create_admin',
    'bulletin:create',
    p_idempotency_key,
    p_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_title := public.hr_bulletin__internal_normalize_text(p_title, 1, 300, false, 'BULLETIN_TITLE_INVALID');

  v_category := upper(nullif(pg_catalog.btrim(p_category), ''));
  if v_category is null or v_category not in ('HR_NEWS', 'HOLIDAY_SCHEDULE', 'INTERNAL_POLICY', 'GENERAL') then
    raise exception 'BULLETIN_CATEGORY_INVALID' using errcode = '22023';
  end if;

  v_badge_text := nullif(pg_catalog.btrim(p_badge_text), '');
  if v_badge_text is not null then
    v_badge_text := public.hr_bulletin__internal_normalize_text(v_badge_text, 1, 40, false, 'BULLETIN_BADGE_INVALID');
  end if;

  v_summary := coalesce(pg_catalog.btrim(p_summary), '');
  v_summary := public.hr_bulletin__internal_normalize_text(v_summary, 0, 600, true, 'BULLETIN_SUMMARY_INVALID');

  v_sections := public.hr_bulletin__internal_validate_sections(
    coalesce(p_content_sections, '[]'::jsonb),
    false
  );

  v_author_display := coalesce(nullif(pg_catalog.btrim(p_author_display), ''), 'Phòng Hành chính - Nhân sự HRPartner');
  v_author_display := public.hr_bulletin__internal_normalize_text(v_author_display, 1, 160, false, 'BULLETIN_AUTHOR_INVALID');

  insert into public.hr_bulletins (
    title,
    category,
    badge_text,
    summary,
    content_sections,
    author_display,
    is_pinned,
    status,
    row_version,
    created_by,
    updated_by,
    created_at,
    updated_at
  ) values (
    v_title,
    v_category,
    v_badge_text,
    v_summary,
    v_sections,
    v_author_display,
    coalesce(p_is_pinned, false),
    'DRAFT',
    1,
    p_app_user_id,
    p_app_user_id,
    v_now,
    v_now
  )
  returning bulletin_id into v_bulletin_id;

  v_result := pg_catalog.jsonb_build_object(
    'item',
    public.hr_bulletin__internal_format_item(v_bulletin_id, p_app_user_id, v_cutoff, true),
    'replayed',
    false
  );

  perform public.hr_bulletin__internal_idempotency_finish(
    p_app_user_id,
    'hr_bulletin_create_admin',
    'bulletin:create',
    p_idempotency_key,
    p_request_hash,
    v_result
  );

  return v_result;
end;
$function$;

-- 8. hr_bulletin_update_admin
create or replace function public.hr_bulletin_update_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_bulletin_id uuid,
  p_expected_row_version integer,
  p_title text,
  p_category text,
  p_badge_text text,
  p_summary text,
  p_content_sections jsonb,
  p_author_display text,
  p_is_pinned boolean,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cutoff timestamptz;
  v_row public.hr_bulletins%rowtype;
  v_prior jsonb;
  v_title text;
  v_category text;
  v_badge_text text;
  v_summary text;
  v_sections jsonb;
  v_author_display text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_result jsonb;
begin
  v_row := public.hr_bulletin__internal_lock_for_manage(
    p_auth_subject, p_app_user_id, p_bulletin_id, p_expected_row_version
  );

  v_prior := public.hr_bulletin__internal_idempotency_begin(
    p_app_user_id,
    'hr_bulletin_update_admin',
    'bulletin:' || p_bulletin_id::text,
    p_idempotency_key,
    p_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_row.row_version <> p_expected_row_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_row_version', v_row.row_version)::text;
  end if;

  v_title := public.hr_bulletin__internal_normalize_text(p_title, 1, 300, false, 'BULLETIN_TITLE_INVALID');

  v_category := upper(nullif(pg_catalog.btrim(p_category), ''));
  if v_category is null or v_category not in ('HR_NEWS', 'HOLIDAY_SCHEDULE', 'INTERNAL_POLICY', 'GENERAL') then
    raise exception 'BULLETIN_CATEGORY_INVALID' using errcode = '22023';
  end if;

  v_badge_text := nullif(pg_catalog.btrim(p_badge_text), '');
  if v_badge_text is not null then
    v_badge_text := public.hr_bulletin__internal_normalize_text(v_badge_text, 1, 40, false, 'BULLETIN_BADGE_INVALID');
  end if;

  v_summary := coalesce(pg_catalog.btrim(p_summary), '');
  v_summary := public.hr_bulletin__internal_normalize_text(v_summary, 0, 600, true, 'BULLETIN_SUMMARY_INVALID');

  v_sections := public.hr_bulletin__internal_validate_sections(
    coalesce(p_content_sections, '[]'::jsonb),
    v_row.status = 'PUBLISHED'
  );

  v_author_display := coalesce(nullif(pg_catalog.btrim(p_author_display), ''), 'Phòng Hành chính - Nhân sự HRPartner');
  v_author_display := public.hr_bulletin__internal_normalize_text(v_author_display, 1, 160, false, 'BULLETIN_AUTHOR_INVALID');

  update public.hr_bulletins b
     set title = v_title,
         category = v_category,
         badge_text = v_badge_text,
         summary = v_summary,
         content_sections = v_sections,
         author_display = v_author_display,
         is_pinned = coalesce(p_is_pinned, v_row.is_pinned),
         row_version = b.row_version + 1,
         updated_by = p_app_user_id,
         updated_at = v_now
   where b.bulletin_id = p_bulletin_id;

  v_cutoff := public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);

  v_result := pg_catalog.jsonb_build_object(
    'item',
    public.hr_bulletin__internal_format_item(p_bulletin_id, p_app_user_id, v_cutoff, true),
    'replayed',
    false
  );

  perform public.hr_bulletin__internal_idempotency_finish(
    p_app_user_id,
    'hr_bulletin_update_admin',
    'bulletin:' || p_bulletin_id::text,
    p_idempotency_key,
    p_request_hash,
    v_result
  );

  return v_result;
end;
$function$;

-- 9. hr_bulletin_set_status_admin
create or replace function public.hr_bulletin_set_status_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_bulletin_id uuid,
  p_target_status text,
  p_expected_row_version integer,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cutoff timestamptz;
  v_row public.hr_bulletins%rowtype;
  v_prior jsonb;
  v_target_status text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_result jsonb;
begin
  v_target_status := upper(nullif(pg_catalog.btrim(p_target_status), ''));
  if v_target_status is null or v_target_status not in ('DRAFT', 'PUBLISHED', 'ARCHIVED') then
    raise exception 'BULLETIN_STATUS_INVALID' using errcode = '22023';
  end if;

  v_row := public.hr_bulletin__internal_lock_for_manage(
    p_auth_subject, p_app_user_id, p_bulletin_id, p_expected_row_version
  );

  v_prior := public.hr_bulletin__internal_idempotency_begin(
    p_app_user_id,
    'hr_bulletin_set_status_admin',
    'bulletin:' || p_bulletin_id::text,
    p_idempotency_key,
    p_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_row.row_version <> p_expected_row_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_row_version', v_row.row_version)::text;
  end if;

  if v_target_status = 'PUBLISHED' then
    perform public.hr_bulletin__internal_validate_sections(v_row.content_sections, true);
  end if;

  update public.hr_bulletins b
     set status = v_target_status,
         published_at = case
           when v_target_status = 'PUBLISHED' then coalesce(b.published_at, v_now)
           else b.published_at
         end,
         archived_at = case
           when v_target_status = 'ARCHIVED' then coalesce(b.archived_at, v_now)
           else null
         end,
         row_version = b.row_version + 1,
         updated_by = p_app_user_id,
         updated_at = v_now
   where b.bulletin_id = p_bulletin_id;

  v_cutoff := public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);

  v_result := pg_catalog.jsonb_build_object(
    'item',
    public.hr_bulletin__internal_format_item(p_bulletin_id, p_app_user_id, v_cutoff, true),
    'replayed',
    false
  );

  perform public.hr_bulletin__internal_idempotency_finish(
    p_app_user_id,
    'hr_bulletin_set_status_admin',
    'bulletin:' || p_bulletin_id::text,
    p_idempotency_key,
    p_request_hash,
    v_result
  );

  return v_result;
end;
$function$;

-- 10. hr_bulletin_set_pinned_admin
create or replace function public.hr_bulletin_set_pinned_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_bulletin_id uuid,
  p_is_pinned boolean,
  p_expected_row_version integer,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cutoff timestamptz;
  v_row public.hr_bulletins%rowtype;
  v_prior jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_result jsonb;
begin
  if p_is_pinned is null then
    raise exception 'BULLETIN_VALIDATION_ERROR' using errcode = '22023';
  end if;

  v_row := public.hr_bulletin__internal_lock_for_manage(
    p_auth_subject, p_app_user_id, p_bulletin_id, p_expected_row_version
  );

  v_prior := public.hr_bulletin__internal_idempotency_begin(
    p_app_user_id,
    'hr_bulletin_set_pinned_admin',
    'bulletin:' || p_bulletin_id::text,
    p_idempotency_key,
    p_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_row.row_version <> p_expected_row_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_row_version', v_row.row_version)::text;
  end if;

  update public.hr_bulletins b
     set is_pinned = p_is_pinned,
         row_version = b.row_version + 1,
         updated_by = p_app_user_id,
         updated_at = v_now
   where b.bulletin_id = p_bulletin_id;

  v_cutoff := public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);

  v_result := pg_catalog.jsonb_build_object(
    'item',
    public.hr_bulletin__internal_format_item(p_bulletin_id, p_app_user_id, v_cutoff, true),
    'replayed',
    false
  );

  perform public.hr_bulletin__internal_idempotency_finish(
    p_app_user_id,
    'hr_bulletin_set_pinned_admin',
    'bulletin:' || p_bulletin_id::text,
    p_idempotency_key,
    p_request_hash,
    v_result
  );

  return v_result;
end;
$function$;

-- 11. hr_bulletin_attach_file_admin
create or replace function public.hr_bulletin_attach_file_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_bulletin_id uuid,
  p_expected_row_version integer,
  p_attachment_id uuid,
  p_kind text,
  p_file_name text,
  p_title text,
  p_mime_type text,
  p_file_size_bytes bigint,
  p_storage_key text,
  p_width integer,
  p_height integer,
  p_page_count integer,
  p_sha256 text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cutoff timestamptz;
  v_row public.hr_bulletins%rowtype;
  v_prior jsonb;
  v_attachment_id uuid;
  v_kind text;
  v_file_name text;
  v_title text;
  v_mime_type text;
  v_storage_key text;
  v_sha256 text;
  v_next_sort_order integer := 0;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_result jsonb;
begin
  v_row := public.hr_bulletin__internal_lock_for_manage(
    p_auth_subject, p_app_user_id, p_bulletin_id, p_expected_row_version
  );

  v_prior := public.hr_bulletin__internal_idempotency_begin(
    p_app_user_id,
    'hr_bulletin_attach_file_admin',
    'bulletin:' || p_bulletin_id::text,
    p_idempotency_key,
    p_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_row.row_version <> p_expected_row_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_row_version', v_row.row_version)::text;
  end if;

  v_kind := upper(nullif(pg_catalog.btrim(p_kind), ''));
  if v_kind is null or v_kind not in ('IMAGE', 'PDF') then
    raise exception 'BULLETIN_ATTACHMENT_INVALID' using errcode = '22023';
  end if;

  v_mime_type := lower(nullif(pg_catalog.btrim(p_mime_type), ''));
  if not (
    (v_kind = 'PDF' and v_mime_type = 'application/pdf')
    or (v_kind = 'IMAGE' and v_mime_type in ('image/jpeg', 'image/png', 'image/webp'))
  ) then
    raise exception 'BULLETIN_ATTACHMENT_MIME_INVALID' using errcode = '22023';
  end if;

  v_file_name := public.hr_bulletin__internal_normalize_text(p_file_name, 1, 255, false, 'BULLETIN_ATTACHMENT_INVALID');
  v_title := public.hr_bulletin__internal_normalize_text(
    coalesce(nullif(pg_catalog.btrim(p_title), ''), v_file_name),
    1,
    255,
    false,
    'BULLETIN_ATTACHMENT_INVALID'
  );
  v_storage_key := public.hr_bulletin__internal_normalize_text(p_storage_key, 1, 512, false, 'BULLETIN_ATTACHMENT_INVALID');

  if p_file_size_bytes is null or p_file_size_bytes <= 0 or p_file_size_bytes > 15728640 then
    raise exception 'BULLETIN_ATTACHMENT_SIZE_INVALID' using errcode = '22023';
  end if;

  if (p_width is not null and p_width <= 0)
     or (p_height is not null and p_height <= 0)
     or (p_page_count is not null and p_page_count <= 0) then
    raise exception 'BULLETIN_ATTACHMENT_INVALID' using errcode = '22023';
  end if;

  v_sha256 := lower(nullif(pg_catalog.btrim(p_sha256), ''));
  if v_sha256 is null or v_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'BULLETIN_ATTACHMENT_SHA256_INVALID' using errcode = '22023';
  end if;

  v_attachment_id := coalesce(p_attachment_id, gen_random_uuid());

  select coalesce(max(a.sort_order) + 1, 0)::integer
    into v_next_sort_order
    from public.hr_bulletin_attachments a
   where a.bulletin_id = p_bulletin_id;

  insert into public.hr_bulletin_attachments (
    attachment_id,
    bulletin_id,
    sort_order,
    kind,
    file_name,
    title,
    mime_type,
    file_size_bytes,
    storage_key,
    width,
    height,
    page_count,
    sha256,
    created_at
  ) values (
    v_attachment_id,
    p_bulletin_id,
    v_next_sort_order,
    v_kind,
    v_file_name,
    v_title,
    v_mime_type,
    p_file_size_bytes,
    v_storage_key,
    p_width,
    p_height,
    p_page_count,
    v_sha256,
    v_now
  );

  update public.hr_bulletins b
     set row_version = b.row_version + 1,
         updated_by = p_app_user_id,
         updated_at = v_now
   where b.bulletin_id = p_bulletin_id;

  v_cutoff := public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);

  v_result := pg_catalog.jsonb_build_object(
    'attachment_id', v_attachment_id,
    'item',
    public.hr_bulletin__internal_format_item(p_bulletin_id, p_app_user_id, v_cutoff, true),
    'replayed',
    false
  );

  perform public.hr_bulletin__internal_idempotency_finish(
    p_app_user_id,
    'hr_bulletin_attach_file_admin',
    'bulletin:' || p_bulletin_id::text,
    p_idempotency_key,
    p_request_hash,
    v_result
  );

  return v_result;
end;
$function$;

-- 12. hr_bulletin_delete_attachment_admin
create or replace function public.hr_bulletin_delete_attachment_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_bulletin_id uuid,
  p_attachment_id uuid,
  p_expected_row_version integer,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_cutoff timestamptz;
  v_row public.hr_bulletins%rowtype;
  v_prior jsonb;
  v_deleted_storage_key text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_result jsonb;
begin
  v_row := public.hr_bulletin__internal_lock_for_manage(
    p_auth_subject, p_app_user_id, p_bulletin_id, p_expected_row_version
  );

  v_prior := public.hr_bulletin__internal_idempotency_begin(
    p_app_user_id,
    'hr_bulletin_delete_attachment_admin',
    'bulletin:' || p_bulletin_id::text,
    p_idempotency_key,
    p_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_row.row_version <> p_expected_row_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_row_version', v_row.row_version)::text;
  end if;

  if p_attachment_id is null then
    raise exception 'BULLETIN_ATTACHMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  delete from public.hr_bulletin_attachments a
   where a.bulletin_id = p_bulletin_id
     and a.attachment_id = p_attachment_id
  returning a.storage_key into v_deleted_storage_key;

  if not found then
    raise exception 'BULLETIN_ATTACHMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.hr_bulletins b
     set row_version = b.row_version + 1,
         updated_by = p_app_user_id,
         updated_at = v_now
   where b.bulletin_id = p_bulletin_id;

  v_cutoff := public.hr_bulletin__internal_assert_active_actor(p_auth_subject, p_app_user_id);

  v_result := pg_catalog.jsonb_build_object(
    'deleted_attachment_id', p_attachment_id,
    'deleted_storage_key', v_deleted_storage_key,
    'item',
    public.hr_bulletin__internal_format_item(p_bulletin_id, p_app_user_id, v_cutoff, true),
    'replayed',
    false
  );

  perform public.hr_bulletin__internal_idempotency_finish(
    p_app_user_id,
    'hr_bulletin_delete_attachment_admin',
    'bulletin:' || p_bulletin_id::text,
    p_idempotency_key,
    p_request_hash,
    v_result
  );

  return v_result;
end;
$function$;

-- =============================================================================
-- SECTION 5: Ownership Alignment, Strict ACLs, and Fail-Closed Postcheck
-- =============================================================================

do $align_hr_bulletin_owners$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_rel_owner_oid oid;
  v_proc_owner_oid oid;
  v_tbl text;
  v_fn pg_catalog.regprocedure;
  v_tables constant text[] := array[
    'hr_bulletins',
    'hr_bulletin_attachments',
    'hr_bulletin_reads',
    'hr_bulletin_idempotency'
  ];
  v_fns constant text[] := array[
    'public.direct_entry_resolve_actor_context(uuid)',
    'public.hr_bulletin__internal_assert_active_actor(uuid,uuid)',
    'public.hr_bulletin__internal_has_manage_authority(uuid)',
    'public.hr_bulletin__internal_count_unread(uuid,timestamptz)',
    'public.hr_bulletin__internal_normalize_text(text,integer,integer,boolean,text)',
    'public.hr_bulletin__internal_validate_sections(jsonb,boolean)',
    'public.hr_bulletin__internal_format_item(uuid,uuid,timestamptz,boolean)',
    'public.hr_bulletin__internal_idempotency_begin(uuid,text,text,text,text)',
    'public.hr_bulletin__internal_idempotency_finish(uuid,text,text,text,text,jsonb)',
    'public.hr_bulletin__internal_lock_for_manage(uuid,uuid,uuid,integer)',
    'public.hr_bulletin_list_mobile_feed(uuid,uuid,text,integer,boolean,timestamptz,uuid,integer)',
    'public.hr_bulletin_get_detail(uuid,uuid,uuid,boolean)',
    'public.hr_bulletin_mark_read(uuid,uuid,uuid)',
    'public.hr_bulletin_mark_all_read(uuid,uuid)',
    'public.hr_bulletin_get_attachment_content_meta(uuid,uuid,uuid,uuid)',
    'public.hr_bulletin_list_archive(uuid,uuid,date,date,text,text,text,uuid,text,integer,integer)',
    'public.hr_bulletin_create_admin(uuid,uuid,text,text,text,text,jsonb,text,boolean,text,text)',
    'public.hr_bulletin_update_admin(uuid,uuid,uuid,integer,text,text,text,text,jsonb,text,boolean,text,text)',
    'public.hr_bulletin_set_status_admin(uuid,uuid,uuid,text,integer,text,text)',
    'public.hr_bulletin_set_pinned_admin(uuid,uuid,uuid,boolean,integer,text,text)',
    'public.hr_bulletin_attach_file_admin(uuid,uuid,uuid,integer,uuid,text,text,text,text,bigint,text,integer,integer,integer,text,text,text)',
    'public.hr_bulletin_delete_attachment_admin(uuid,uuid,uuid,uuid,integer,text,text)'
  ];
  v_sig text;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entries'::pg_catalog.regclass;

  if v_base_owner is null then
    raise exception 'Owner resolution failed for public.direct_entries'
      using errcode = '55000';
  end if;

  foreach v_tbl in array v_tables loop
    select c.relowner
      into v_rel_owner_oid
      from pg_catalog.pg_class c
     where c.oid = pg_catalog.to_regclass('public.' || v_tbl);

    if v_rel_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter table public.%I owner to %I', v_tbl, v_base_owner);
    end if;
  end loop;

  foreach v_sig in array v_fns loop
    v_fn := pg_catalog.to_regprocedure(v_sig);
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = v_fn;

    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_base_owner);
    end if;
  end loop;
end
$align_hr_bulletin_owners$;

-- Internal helpers (9): uncallable via PostgREST even with service_role key
revoke all on function public.hr_bulletin__internal_assert_active_actor(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin__internal_has_manage_authority(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin__internal_count_unread(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin__internal_normalize_text(text, integer, integer, boolean, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin__internal_validate_sections(jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin__internal_format_item(uuid, uuid, timestamptz, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin__internal_idempotency_begin(uuid, text, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin__internal_idempotency_finish(uuid, text, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin__internal_lock_for_manage(uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;

-- 12 Public RPCs: revoke from all, grant execute only to service_role
revoke all on function public.hr_bulletin_list_mobile_feed(uuid, uuid, text, integer, boolean, timestamptz, uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin_get_detail(uuid, uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin_mark_read(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin_mark_all_read(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin_get_attachment_content_meta(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin_list_archive(uuid, uuid, date, date, text, text, text, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin_create_admin(uuid, uuid, text, text, text, text, jsonb, text, boolean, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin_update_admin(uuid, uuid, uuid, integer, text, text, text, text, jsonb, text, boolean, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin_set_status_admin(uuid, uuid, uuid, text, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin_set_pinned_admin(uuid, uuid, uuid, boolean, integer, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin_attach_file_admin(uuid, uuid, uuid, integer, uuid, text, text, text, text, bigint, text, integer, integer, integer, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.hr_bulletin_delete_attachment_admin(uuid, uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;

grant execute on function public.hr_bulletin_list_mobile_feed(uuid, uuid, text, integer, boolean, timestamptz, uuid, integer)
  to service_role;
grant execute on function public.hr_bulletin_get_detail(uuid, uuid, uuid, boolean)
  to service_role;
grant execute on function public.hr_bulletin_mark_read(uuid, uuid, uuid)
  to service_role;
grant execute on function public.hr_bulletin_mark_all_read(uuid, uuid)
  to service_role;
grant execute on function public.hr_bulletin_get_attachment_content_meta(uuid, uuid, uuid, uuid)
  to service_role;
grant execute on function public.hr_bulletin_list_archive(uuid, uuid, date, date, text, text, text, uuid, text, integer, integer)
  to service_role;
grant execute on function public.hr_bulletin_create_admin(uuid, uuid, text, text, text, text, jsonb, text, boolean, text, text)
  to service_role;
grant execute on function public.hr_bulletin_update_admin(uuid, uuid, uuid, integer, text, text, text, text, jsonb, text, boolean, text, text)
  to service_role;
grant execute on function public.hr_bulletin_set_status_admin(uuid, uuid, uuid, text, integer, text, text)
  to service_role;
grant execute on function public.hr_bulletin_set_pinned_admin(uuid, uuid, uuid, boolean, integer, text, text)
  to service_role;
grant execute on function public.hr_bulletin_attach_file_admin(uuid, uuid, uuid, integer, uuid, text, text, text, text, bigint, text, integer, integer, integer, text, text, text)
  to service_role;
grant execute on function public.hr_bulletin_delete_attachment_admin(uuid, uuid, uuid, uuid, integer, text, text)
  to service_role;

do $postcheck$
declare
  v_rls_count integer;
  v_policy_count integer;
  v_table_grants integer;
  v_non_bypass_table_owners integer;
  v_role_seed_count integer;
  v_group_seed_count integer;
  v_fn_sig text;
  v_fn_oid oid;
  v_fn_owner_oid oid;
  v_prosecdef boolean;
  v_proconfig text[];
  v_proacl aclitem[];
  v_owner_bypasses_rls boolean;
  v_public_exec boolean;
  v_service_rpc_list constant text[] := array[
    'public.direct_entry_resolve_actor_context(uuid)',
    'public.hr_bulletin_list_mobile_feed(uuid,uuid,text,integer,boolean,timestamptz,uuid,integer)',
    'public.hr_bulletin_get_detail(uuid,uuid,uuid,boolean)',
    'public.hr_bulletin_mark_read(uuid,uuid,uuid)',
    'public.hr_bulletin_mark_all_read(uuid,uuid)',
    'public.hr_bulletin_get_attachment_content_meta(uuid,uuid,uuid,uuid)',
    'public.hr_bulletin_list_archive(uuid,uuid,date,date,text,text,text,uuid,text,integer,integer)',
    'public.hr_bulletin_create_admin(uuid,uuid,text,text,text,text,jsonb,text,boolean,text,text)',
    'public.hr_bulletin_update_admin(uuid,uuid,uuid,integer,text,text,text,text,jsonb,text,boolean,text,text)',
    'public.hr_bulletin_set_status_admin(uuid,uuid,uuid,text,integer,text,text)',
    'public.hr_bulletin_set_pinned_admin(uuid,uuid,uuid,boolean,integer,text,text)',
    'public.hr_bulletin_attach_file_admin(uuid,uuid,uuid,integer,uuid,text,text,text,text,bigint,text,integer,integer,integer,text,text,text)',
    'public.hr_bulletin_delete_attachment_admin(uuid,uuid,uuid,uuid,integer,text,text)'
  ];
  v_internal_fn_list constant text[] := array[
    'public.hr_bulletin__internal_assert_active_actor(uuid,uuid)',
    'public.hr_bulletin__internal_has_manage_authority(uuid)',
    'public.hr_bulletin__internal_count_unread(uuid,timestamptz)',
    'public.hr_bulletin__internal_normalize_text(text,integer,integer,boolean,text)',
    'public.hr_bulletin__internal_validate_sections(jsonb,boolean)',
    'public.hr_bulletin__internal_format_item(uuid,uuid,timestamptz,boolean)',
    'public.hr_bulletin__internal_idempotency_begin(uuid,text,text,text,text)',
    'public.hr_bulletin__internal_idempotency_finish(uuid,text,text,text,text,jsonb)',
    'public.hr_bulletin__internal_lock_for_manage(uuid,uuid,uuid,integer)'
  ];
begin
  select count(*)::integer
    into v_rls_count
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'hr_bulletins',
       'hr_bulletin_attachments',
       'hr_bulletin_reads',
       'hr_bulletin_idempotency'
     )
     and c.relrowsecurity = true
     and c.relforcerowsecurity = true;

  if v_rls_count <> 4 then
    raise exception 'HR bulletins postcheck failed: expected RLS + FORCE RLS on 4 tables, got %', v_rls_count
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_policy_count
    from pg_catalog.pg_policy pol
    join pg_catalog.pg_class c on c.oid = pol.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'hr_bulletins',
       'hr_bulletin_attachments',
       'hr_bulletin_reads',
       'hr_bulletin_idempotency'
     );

  if v_policy_count <> 0 then
    raise exception 'HR bulletins postcheck failed: expected 0 client policies, got %', v_policy_count
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_table_grants
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in (
       'hr_bulletins',
       'hr_bulletin_attachments',
       'hr_bulletin_reads',
       'hr_bulletin_idempotency'
     )
     and g.grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role');

  if v_table_grants <> 0 then
    raise exception 'HR bulletins postcheck failed: expected 0 table grants for runtime roles, got %', v_table_grants
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_non_bypass_table_owners
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where n.nspname = 'public'
     and c.relname in (
       'hr_bulletins',
       'hr_bulletin_attachments',
       'hr_bulletin_reads',
       'hr_bulletin_idempotency'
     )
     and not (coalesce(r.rolsuper, false) or coalesce(r.rolbypassrls, false));

  if v_non_bypass_table_owners <> 0 then
    raise exception 'HR bulletins postcheck failed: % table(s) owned by non-BYPASSRLS role', v_non_bypass_table_owners
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_role_seed_count
    from public.authz_role_capabilities rc
   where rc.capability = 'bulletin_manage'
     and rc.scope_template = 'ALL'
     and rc.role_code in ('ADMIN', 'HR_OPERATOR');

  if v_role_seed_count <> 2 then
    raise exception 'HR bulletins postcheck failed: expected 2 role capability seeds for bulletin_manage, got %', v_role_seed_count
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_group_seed_count
    from public.authz_user_group_capabilities gc
    join public.authz_user_groups g on g.group_id = gc.group_id
   where gc.capability = 'bulletin_manage'
     and gc.ended_at is null
     and g.code in ('SYSTEM_ADMIN', 'HR_CATALOG_OPERATOR');

  if v_group_seed_count <> 2 then
    raise exception 'HR bulletins postcheck failed: expected 2 group capability seeds for bulletin_manage, got %', v_group_seed_count
      using errcode = '55000';
  end if;

  foreach v_fn_sig in array v_service_rpc_list loop
    v_fn_oid := pg_catalog.to_regprocedure(v_fn_sig);
    if v_fn_oid is null then
      raise exception 'HR bulletins postcheck failed: missing RPC %', v_fn_sig
        using errcode = '55000';
    end if;

    select p.proowner,
           p.prosecdef,
           coalesce(p.proconfig, '{}'::text[]),
           p.proacl,
           (coalesce(r.rolsuper, false) or coalesce(r.rolbypassrls, false))
      into v_fn_owner_oid, v_prosecdef, v_proconfig, v_proacl, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_fn_oid;

    if not coalesce(v_prosecdef, false) or not ('search_path=pg_catalog, public' = any(v_proconfig)) then
      raise exception 'HR bulletins postcheck failed: RPC % must be SECURITY DEFINER with search_path=pg_catalog, public', v_fn_sig
        using errcode = '55000';
    end if;

    if not coalesce(v_owner_bypasses_rls, false)
       or not pg_catalog.has_function_privilege(v_fn_owner_oid, v_fn_oid, 'EXECUTE') then
      raise exception 'HR bulletins postcheck failed: owner of RPC % must bypass RLS and hold EXECUTE', v_fn_sig
        using errcode = '55000';
    end if;

    select exists (
      select 1
        from pg_catalog.aclexplode(coalesce(v_proacl, pg_catalog.acldefault('f', v_fn_owner_oid))) a
       where a.grantee = 0
         and a.privilege_type = 'EXECUTE'
    ) into v_public_exec;

    if v_public_exec
       or pg_catalog.has_function_privilege('public', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_fn_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_fn_oid, 'EXECUTE') then
      raise exception 'HR bulletins postcheck failed: unexpected ACL on RPC %', v_fn_sig
        using errcode = '55000';
    end if;
  end loop;

  foreach v_fn_sig in array v_internal_fn_list loop
    v_fn_oid := pg_catalog.to_regprocedure(v_fn_sig);
    if v_fn_oid is null then
      raise exception 'HR bulletins postcheck failed: missing internal helper %', v_fn_sig
        using errcode = '55000';
    end if;

    select p.proowner,
           p.prosecdef,
           coalesce(p.proconfig, '{}'::text[]),
           p.proacl,
           (coalesce(r.rolsuper, false) or coalesce(r.rolbypassrls, false))
      into v_fn_owner_oid, v_prosecdef, v_proconfig, v_proacl, v_owner_bypasses_rls
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_fn_oid;

    if not coalesce(v_prosecdef, false) or not ('search_path=pg_catalog, public' = any(v_proconfig)) then
      raise exception 'HR bulletins postcheck failed: helper % must be SECURITY DEFINER with search_path=pg_catalog, public', v_fn_sig
        using errcode = '55000';
    end if;

    if not coalesce(v_owner_bypasses_rls, false)
       or not pg_catalog.has_function_privilege(v_fn_owner_oid, v_fn_oid, 'EXECUTE') then
      raise exception 'HR bulletins postcheck failed: owner of helper % must bypass RLS and hold EXECUTE', v_fn_sig
        using errcode = '55000';
    end if;

    select exists (
      select 1
        from pg_catalog.aclexplode(coalesce(v_proacl, pg_catalog.acldefault('f', v_fn_owner_oid))) a
       where a.grantee = 0
         and a.privilege_type = 'EXECUTE'
    ) into v_public_exec;

    if v_public_exec
       or pg_catalog.has_function_privilege('public', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_fn_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_fn_oid, 'EXECUTE') then
      raise exception 'HR bulletins postcheck failed: helper % must revoke EXECUTE from public/anon/authenticated/service_role', v_fn_sig
        using errcode = '55000';
    end if;
  end loop;
end
$postcheck$;

commit;
