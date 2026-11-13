-- =============================================================================
-- WP2A Shadow Query 02: Candidate Effective Access & Shadow Diff (Read-Only)
-- Standalone equivalent of `public.direct_entry_authz_compare_shadow_access(as_of_ts, app_user_id)`.
-- Works directly on unmigrated NWC DBs inside `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; ... ROLLBACK;`.
-- Optional session GUCs:
--   - wp2a.as_of_ts    (timestamptz ISO string; defaults to transaction_timestamp())
--   - wp2a.app_user_id (uuid; defaults to NULL = all users)
-- =============================================================================

with params as materialized (
  select
    coalesce(nullif(current_setting('wp2a.as_of_ts', true), '')::timestamptz, pg_catalog.transaction_timestamp()) as as_of_ts,
    (coalesce(nullif(current_setting('wp2a.as_of_ts', true), '')::timestamptz, pg_catalog.transaction_timestamp()) at time zone 'Asia/Ho_Chi_Minh')::date as as_of_date,
    (pg_catalog.transaction_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date as current_bkk_date,
    nullif(current_setting('wp2a.app_user_id', true), '')::uuid as target_app_user_id
),
eligible_users as materialized (
  select
    p.as_of_ts,
    p.as_of_date,
    p.current_bkk_date,
    u.app_user_id,
    (u.created_at at time zone 'Asia/Ho_Chi_Minh')::date as user_created_date
  from params p
  join public.direct_entry_app_users u
    on (
      p.target_app_user_id is null
      or u.app_user_id = p.target_app_user_id
      or exists (
        select 1
        from public.work_report_delegations wrd_g
        where wrd_g.delegate_app_user_id = p.target_app_user_id
          and wrd_g.grantor_user_id = u.app_user_id
      )
    )
  where u.enabled = true
    and (u.created_at at time zone 'Asia/Ho_Chi_Minh')::date <= p.as_of_date
),
-- =============================================================================
-- PART A: CURRENT SNAPSHOT
-- =============================================================================
curr_r1_capabilities as materialized (
  select
    u.as_of_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    case
      when cg.capability in (
        'report_assign',
        'report_review',
        'report_analytics_view',
        'report_template_manage',
        'report_form_manage',
        'report_delegate'
      ) then 'work_reports'
      when cg.capability = 'attendance_view' then 'attendance'
      when cg.capability like 'vendor_finance_%' then 'vendor_finance'
      else 'direct_entry'
    end::text as module_code,
    ('cap:' || cg.capability)::text as action_code,
    'capability'::text as scope_kind,
    '*'::text as scope_ref,
    'direct_entry_capability_grants'::text as grant_source,
    min(cg.valid_from)::text as valid_from,
    case
      when bool_or(cg.valid_to is null) then 'infinity'
      else max(cg.valid_to)::text
    end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date
      then 'CURRENT_STATE_ONLY (u.enabled + is_current; legacy_r1_no_date_check)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.direct_entry_capability_grants cg
    on cg.app_user_id = u.app_user_id
   and cg.is_current = true
  group by
    u.as_of_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    cg.capability
),
curr_r1_scopes as materialized (
  select
    u.as_of_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'direct_entry'::text as module_code,
    ('scope:' || sg.scope_kind)::text as action_code,
    sg.scope_kind::text as scope_kind,
    coalesce(sg.team_id::text, '*')::text as scope_ref,
    'direct_entry_scope_grants'::text as grant_source,
    min(sg.valid_from)::text as valid_from,
    case
      when bool_or(sg.valid_to is null) then 'infinity'
      else max(sg.valid_to)::text
    end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date
      then 'CURRENT_STATE_ONLY (u.enabled + is_current; legacy_r1_no_date_check)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.direct_entry_scope_grants sg
    on sg.app_user_id = u.app_user_id
   and sg.is_current = true
  left join public.teams t
    on sg.scope_kind = 'team'
   and t.team_id = sg.team_id
  where (
    sg.scope_kind <> 'team'
    or (t.team_id is not null and t.active = true)
  )
  group by
    u.as_of_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    sg.scope_kind,
    coalesce(sg.team_id::text, '*')
),
curr_full_admin_users as materialized (
  select
    c.app_user_id,
    greatest(
      max(c.valid_from::date) filter (where c.action_code = 'cap:entry_admin'),
      max(c.valid_from::date) filter (where c.action_code = 'cap:recruiter_master_manage'),
      max(c.valid_from::date) filter (where c.action_code = 'cap:team_master_manage')
    ) as valid_from_date
  from curr_r1_capabilities c
  where c.action_code in ('cap:entry_admin', 'cap:recruiter_master_manage', 'cap:team_master_manage')
  group by c.app_user_id
  having count(distinct c.action_code) = 3
),
curr_recruiter_links as materialized (
  select
    u.as_of_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'direct_entry'::text as module_code,
    'recruiter_link:verified'::text as action_code,
    'recruited'::text as scope_kind,
    rl.recruiter_id::text as scope_ref,
    'direct_entry_app_user_recruiter_links'::text as grant_source,
    min(rl.valid_from)::text as valid_from,
    case
      when bool_or(rl.valid_to is null) then 'infinity'
      else max(rl.valid_to)::text
    end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date
      then 'CURRENT_STATE_ONLY (u.enabled + is_current + r.active)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.direct_entry_app_user_recruiter_links rl
    on rl.app_user_id = u.app_user_id
   and rl.is_current = true
   and rl.verified = true
  join public.recruiters r
    on r.recruiter_id = rl.recruiter_id
   and r.active = true
  group by
    u.as_of_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    rl.recruiter_id
),
curr_team_leader_assignments as materialized (
  select
    u.as_of_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'direct_entry'::text as module_code,
    'assignment:team_leader'::text as action_code,
    'team'::text as scope_kind,
    tla.team_id::text as scope_ref,
    'direct_entry_team_leader_assignments'::text as grant_source,
    min(tla.valid_from)::text as valid_from,
    case
      when bool_or(tla.valid_to is null) then 'infinity'
      else max(tla.valid_to)::text
    end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date
      then 'CURRENT_STATE_ONLY (u.enabled + is_current + t.active; interval_reconstructible)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.direct_entry_team_leader_assignments tla
    on tla.leader_app_user_id = u.app_user_id
   and tla.is_current = true
  join public.teams t
    on t.team_id = tla.team_id
   and t.active = true
  where tla.valid_from <= u.as_of_date
    and (tla.valid_to is null or (tla.valid_to > tla.valid_from and u.as_of_date < tla.valid_to))
  group by
    u.as_of_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    tla.team_id
),
curr_project_manager_assignments as materialized (
  select
    u.as_of_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'direct_entry'::text as module_code,
    'assignment:project_manager'::text as action_code,
    'project'::text as scope_kind,
    pma.project_id::text as scope_ref,
    'direct_entry_project_manager_assignments'::text as grant_source,
    min(pma.valid_from)::text as valid_from,
    case
      when bool_or(pma.valid_to is null) then 'infinity'
      else max(pma.valid_to)::text
    end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date
      then 'CURRENT_STATE_ONLY (u.enabled + rl.is_current + pma.is_current + prj.active; interval_reconstructible)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join curr_recruiter_links rl
    on rl.app_user_id = u.app_user_id
  join public.direct_entry_project_manager_assignments pma
    on pma.manager_recruiter_id::text = rl.scope_ref
   and pma.is_current = true
   and pma.revoked_at is null
  join public.direct_entry_projects prj
    on prj.project_id = pma.project_id
   and prj.active = true
  where pma.valid_from <= u.as_of_date
    and (pma.valid_to is null or (pma.valid_to > pma.valid_from and u.as_of_date < pma.valid_to))
  group by
    u.as_of_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    pma.project_id
),
curr_org_dept_memberships as materialized (
  select
    u.as_of_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'org'::text as module_code,
    ('dept_member:' || od.code)::text as action_code,
    'department'::text as scope_kind,
    odm.department_id::text as scope_ref,
    'organization_department_memberships'::text as grant_source,
    min(odm.valid_from)::text as valid_from,
    case
      when bool_or(odm.valid_to is null) then 'infinity'
      else max(odm.valid_to)::text
    end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date
      then 'CURRENT_STATE_ONLY (u.enabled + od.is_active; interval_reconstructible)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.organization_department_memberships odm
    on odm.app_user_id = u.app_user_id
  join public.organization_departments od
    on od.department_id = odm.department_id
   and od.is_active = true
  where odm.valid_from <= u.as_of_date
    and (odm.valid_to is null or (odm.valid_to > odm.valid_from and u.as_of_date < odm.valid_to))
    and (odm.revoked_at is null or u.as_of_ts < odm.revoked_at)
  group by
    u.as_of_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    od.code,
    odm.department_id
),
curr_leave_grants as materialized (
  select
    u.as_of_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'leave'::text as module_code,
    ('leave_role:' || lmg.role_code)::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'leave_module_grants'::text as grant_source,
    min(lmg.valid_from)::text as valid_from,
    case
      when bool_or(lmg.valid_to is null) then 'infinity'
      else max(lmg.valid_to)::text
    end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date
      then 'CURRENT_STATE_ONLY (u.enabled + is_current; interval_reconstructible)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.leave_module_grants lmg
    on lmg.app_user_id = u.app_user_id
   and lmg.is_current = true
  where lmg.valid_from <= u.as_of_date
    and (lmg.valid_to is null or (lmg.valid_to > lmg.valid_from and u.as_of_date < lmg.valid_to))
  group by
    u.as_of_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    lmg.role_code

  union all

  select
    u.as_of_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'leave'::text as module_code,
    ('department_approver:' || lda.unit_kind)::text as action_code,
    'unit_kind'::text as scope_kind,
    lda.unit_kind::text as scope_ref,
    'leave_department_approvers'::text as grant_source,
    min(lda.valid_from)::text as valid_from,
    case
      when bool_or(lda.valid_to is null) then 'infinity'
      else max(lda.valid_to)::text
    end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date
      then 'CURRENT_STATE_ONLY (u.enabled + is_current; interval_reconstructible)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.leave_department_approvers lda
    on lda.approver_app_user_id = u.app_user_id
   and lda.is_current = true
  where lda.valid_from <= u.as_of_date
    and (lda.valid_to is null or (lda.valid_to > lda.valid_from and u.as_of_date < lda.valid_to))
  group by
    u.as_of_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    lda.unit_kind
),
curr_vendor_finance_grants as materialized (
  select
    u.as_of_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'vendor_finance'::text as module_code,
    ('vfin_role:' || vfgr.role_code)::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'vendor_finance_global_roles'::text as grant_source,
    min(vfgr.valid_from)::text as valid_from,
    case
      when bool_or(vfgr.valid_to is null) then 'infinity'
      else max(vfgr.valid_to)::text
    end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date
      then 'CURRENT_STATE_ONLY (u.enabled + ended_at_is_null; interval_reconstructible)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.vendor_finance_global_roles vfgr
    on vfgr.app_user_id = u.app_user_id
   and vfgr.ended_at is null
  where vfgr.valid_from <= u.as_of_date
    and (vfgr.valid_to is null or (vfgr.valid_to > vfgr.valid_from and u.as_of_date < vfgr.valid_to))
  group by
    u.as_of_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    vfgr.role_code

  union all

  select
    u.as_of_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'vendor_finance'::text as module_code,
    'vfin_project_accountant'::text as action_code,
    'project'::text as scope_kind,
    vfpa.project_id::text as scope_ref,
    'vendor_finance_project_accountants'::text as grant_source,
    min(vfpa.valid_from)::text as valid_from,
    case
      when bool_or(vfpa.valid_to is null) then 'infinity'
      else max(vfpa.valid_to)::text
    end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date
      then 'CURRENT_STATE_ONLY (u.enabled + ended_at_is_null + prj.active; interval_reconstructible)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.vendor_finance_project_accountants vfpa
    on vfpa.accountant_user_id = u.app_user_id
   and vfpa.ended_at is null
  join public.direct_entry_projects prj
    on prj.project_id = vfpa.project_id
   and prj.active = true
  where vfpa.valid_from <= u.as_of_date
    and (vfpa.valid_to is null or (vfpa.valid_to > vfpa.valid_from and u.as_of_date < vfpa.valid_to))
  group by
    u.as_of_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    vfpa.project_id
),
curr_grantor_work_report_authority as materialized (
  select
    u.app_user_id as grantor_user_id,
    caps.capability,
    s.scope_kind,
    case when s.scope_kind = 'team' then s.scope_ref else '*' end as scope_ref
  from eligible_users u
  cross join (values ('report_delegate'), ('report_assign'), ('report_review')) as caps(capability)
  join curr_r1_scopes s
    on s.app_user_id = u.app_user_id
   and s.scope_kind in ('all', 'team')
  where (
    exists (
      select 1
      from curr_r1_capabilities c
      where c.app_user_id = u.app_user_id
        and c.action_code = ('cap:' || caps.capability)
    )
    or (
      exists (select 1 from curr_full_admin_users fa where fa.app_user_id = u.app_user_id)
      and not exists (
        select 1
        from public.direct_entry_capability_grants g_rev
        where g_rev.app_user_id = u.app_user_id
          and g_rev.capability = caps.capability
          and g_rev.is_current = false
      )
    )
  )
),
curr_work_report_delegations as materialized (
  select
    u.as_of_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'work_reports'::text as module_code,
    ('delegation:' || wrd.capability)::text as action_code,
    ('template_' || wrd.scope_kind)::text as scope_kind,
    (wrd.template_id::text || ':' || coalesce(wrd.scope_team_id::text, '*'))::text as scope_ref,
    'work_report_delegations'::text as grant_source,
    min((wrd.effective_from at time zone 'Asia/Ho_Chi_Minh')::date)::text as valid_from,
    case
      when bool_or(wrd.effective_to is null) then 'infinity'
      else max((wrd.effective_to at time zone 'Asia/Ho_Chi_Minh')::date)::text
    end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date
      then 'CURRENT_STATE_ONLY (u.enabled + gu.enabled + is_current + state)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.work_report_delegations wrd
    on wrd.delegate_app_user_id = u.app_user_id
   and wrd.state = 'ACTIVE'
   and wrd.is_current = true
  join eligible_users gu
    on gu.app_user_id = wrd.grantor_user_id
  join public.work_report_templates wt
    on wt.template_id = wrd.template_id
   and wt.status = 'ACTIVE'
   and wt.current_published_version_id is not null
  where wrd.effective_from <= u.as_of_ts
    and (wrd.effective_to is null or u.as_of_ts <= wrd.effective_to)
    and (
      wrd.scope_kind = 'all'
      or (
        wrd.scope_kind = 'team'
        and exists (select 1 from public.teams tm where tm.team_id = wrd.scope_team_id and tm.active = true)
        and (
          exists (select 1 from curr_r1_scopes dsg where dsg.app_user_id = u.app_user_id and dsg.scope_kind = 'team' and dsg.scope_ref = wrd.scope_team_id::text)
          or exists (
            select 1
            from curr_recruiter_links rl
            join public.recruiter_team_memberships rtm
              on rtm.recruiter_id::text = rl.scope_ref
             and rtm.team_id = wrd.scope_team_id
            where rl.app_user_id = u.app_user_id
              and rtm.valid_from <= u.as_of_date
              and (rtm.valid_to is null or (rtm.valid_to > rtm.valid_from and u.as_of_date < rtm.valid_to))
              and rtm.is_current = true
          )
        )
      )
    )
    and exists (
      select 1
      from curr_grantor_work_report_authority ga_del
      where ga_del.grantor_user_id = wrd.grantor_user_id
        and ga_del.capability = 'report_delegate'
        and (ga_del.scope_kind = 'all' or (wrd.scope_kind = 'team' and ga_del.scope_kind = 'team' and ga_del.scope_ref = wrd.scope_team_id::text))
    )
    and exists (
      select 1
      from curr_grantor_work_report_authority ga_cap
      where ga_cap.grantor_user_id = wrd.grantor_user_id
        and ga_cap.capability = wrd.capability
        and (ga_cap.scope_kind = 'all' or (wrd.scope_kind = 'team' and ga_cap.scope_kind = 'team' and ga_cap.scope_ref = wrd.scope_team_id::text))
    )
  group by
    u.as_of_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    wrd.capability,
    wrd.scope_kind,
    (wrd.template_id::text || ':' || coalesce(wrd.scope_team_id::text, '*'))
),
curr_raw_grants as (
  select * from curr_r1_capabilities
  union all select * from curr_r1_scopes
  union all select * from curr_recruiter_links
  union all select * from curr_team_leader_assignments
  union all select * from curr_project_manager_assignments
  union all select * from curr_org_dept_memberships
  union all select * from curr_leave_grants
  union all select * from curr_vendor_finance_grants
  union all select * from curr_work_report_delegations
),
curr_module_ops_raw as (
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text as row_layer, 'dashboard'::text as module_code, op.action_code, 'all'::text as scope_kind, '*'::text as scope_ref,
    op.grant_source, s.valid_from, s.valid_to, s.reconstructibility
  from curr_r1_scopes s
  cross join (
    values
      ('op:dashboard:view_general', 'derived:direct_entry_reporting_resolve_audience+direct_entry_reporting_scoped_facts+direct_entry_workforce_reporting_scoped(overview)'),
      ('op:dashboard:view_workforce_deep', 'derived:canViewDeepWorkforceReport+direct_entry_workforce_reporting_scoped(deep|project_page)'),
      ('op:dashboard:view_detailed_matrix', 'derived:canViewDeepWorkforceReport+direct_entry_reporting_detailed_matrix_catalog+direct_entry_reporting_team_drill_down')
  ) as op(action_code, grant_source)
  where s.scope_kind = 'all'
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'dashboard'::text, 'op:dashboard:view_general'::text, 'team'::text, s.scope_ref,
    'derived:direct_entry_reporting_resolve_audience'::text, s.valid_from, s.valid_to, s.reconstructibility
  from curr_r1_scopes s
  where s.scope_kind = 'team'
    and not exists (select 1 from curr_r1_scopes s_all where s_all.app_user_id = s.app_user_id and s_all.scope_kind = 'all')
  union all
  select
    rl.as_of_ts, rl.as_of_date, rl.app_user_id, rl.user_created_date,
    'MODULE_OP'::text, 'dashboard'::text, 'op:dashboard:view_general'::text, 'recruited'::text, rl.scope_ref,
    'derived:direct_entry_reporting_resolve_audience'::text, rl.valid_from, rl.valid_to, rl.reconstructibility
  from curr_recruiter_links rl
  where not exists (select 1 from curr_r1_scopes s_other where s_other.app_user_id = rl.app_user_id and s_other.scope_kind in ('all', 'team'))
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'workforce'::text, 'op:workforce:offboarding_view'::text, 'all'::text, '*'::text,
    'derived:canAccessOffboardingReport+offboarding_report_read'::text, s.valid_from, s.valid_to, s.reconstructibility
  from curr_r1_scopes s
  where s.scope_kind = 'all'
    and (
      (exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view')
       and exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view'))
      or exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or exists (select 1 from curr_full_admin_users fa where fa.app_user_id = s.app_user_id)
    )
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'direct_entry'::text, 'op:direct_entry:workers_all_tab'::text, 'all'::text, '*'::text,
    'derived:direct_entry_submission_list_all_read'::text, s.valid_from, s.valid_to, s.reconstructibility
  from curr_r1_scopes s
  where s.scope_kind = 'all'
    and (
      exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code in ('cap:entry_privileged_edit', 'cap:change_review'))
      or exists (select 1 from curr_full_admin_users fa where fa.app_user_id = s.app_user_id)
    )
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'attendance'::text, 'op:attendance:report_view'::text, 'all'::text, '*'::text,
    'derived:attendance__internal_assert_report_reader'::text, s.valid_from, s.valid_to, s.reconstructibility
  from curr_r1_scopes s
  where s.scope_kind = 'all'
    and (
      exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or exists (select 1 from curr_full_admin_users fa where fa.app_user_id = s.app_user_id)
      or (exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view')
          and exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view'))
    )
  union all
  select
    tla.as_of_ts, tla.as_of_date, tla.app_user_id, tla.user_created_date,
    'MODULE_OP'::text, 'attendance'::text, 'op:attendance:report_view'::text, 'team'::text, tla.scope_ref,
    'derived:attendance__internal_resolve_report_scope'::text, tla.valid_from, tla.valid_to, tla.reconstructibility
  from curr_team_leader_assignments tla
  where exists (select 1 from curr_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:team_manager_assign')
    and exists (select 1 from curr_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_view')
    and exists (select 1 from curr_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_analytics_view')
  union all
  select
    lg.as_of_ts, lg.as_of_date, lg.app_user_id, lg.user_created_date,
    'MODULE_OP'::text, 'leave'::text, 'op:leave:approve_department'::text, lg.scope_kind, lg.scope_ref,
    'derived:leave_can_approve_department'::text, lg.valid_from, lg.valid_to, lg.reconstructibility
  from curr_leave_grants lg
  where lg.action_code like 'department_approver:%'
  union all
  select
    tla.as_of_ts, tla.as_of_date, tla.app_user_id, tla.user_created_date,
    'MODULE_OP'::text, 'leave'::text, 'op:leave:approve_team'::text, 'team'::text, tla.scope_ref,
    'derived:leave_can_approve_recruitment_team'::text, tla.valid_from, tla.valid_to, tla.reconstructibility
  from curr_team_leader_assignments tla
  union all
  select
    lg.as_of_ts, lg.as_of_date, lg.app_user_id, lg.user_created_date,
    'MODULE_OP'::text, 'leave'::text, ('op:leave:hr_grant_' || replace(lg.action_code, 'leave_role:', ''))::text, 'all'::text, '*'::text,
    'derived:leave_user_has_any_role'::text, lg.valid_from, lg.valid_to, lg.reconstructibility
  from curr_leave_grants lg
  where lg.action_code like 'leave_role:%'
  union all
  select
    vf.as_of_ts, vf.as_of_date, vf.app_user_id, vf.user_created_date,
    'MODULE_OP'::text, op.module_code, op.action_code, 'project'::text, vf.scope_ref,
    'derived:vendor_finance_project_accountants'::text, vf.valid_from, vf.valid_to, vf.reconstructibility
  from curr_vendor_finance_grants vf
  cross join (values ('vendor_finance', 'op:vendor_finance:project_ledger_operate'), ('salary_advance', 'op:salary_advance:accountant_decide')) as op(module_code, action_code)
  where vf.action_code = 'vfin_project_accountant'
  union all
  select
    vf.as_of_ts, vf.as_of_date, vf.app_user_id, vf.user_created_date,
    'MODULE_OP'::text, 'vendor_finance'::text, ('op:vendor_finance:global_' || replace(vf.action_code, 'vfin_role:', ''))::text, 'all'::text, '*'::text,
    'derived:vendor_finance_global_roles'::text, vf.valid_from, vf.valid_to, vf.reconstructibility
  from curr_vendor_finance_grants vf
  where vf.action_code like 'vfin_role:%'
  union all
  select
    pma.as_of_ts, pma.as_of_date, pma.app_user_id, pma.user_created_date,
    'MODULE_OP'::text, op.module_code, op.action_code, 'project'::text, pma.scope_ref,
    'derived:project_manager_assignments'::text, pma.valid_from, pma.valid_to, pma.reconstructibility
  from curr_project_manager_assignments pma
  cross join (values ('vendor_finance', 'op:vendor_finance:pm_project_view'), ('salary_advance', 'op:salary_advance:pm_request'), ('recruitment_posts', 'op:recruitment_posts:pm_manage_project')) as op(module_code, action_code)
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'work_reports'::text, ('op:work_reports:' || replace(caps.cap_name, 'report_', ''))::text, s.scope_kind, s.scope_ref,
    ('derived:work_report_direct_' || replace(caps.cap_name, 'report_', ''))::text,
    coalesce(
      (select greatest(s.valid_from::date, c.valid_from::date)::text from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = ('cap:' || caps.cap_name)),
      (select greatest(s.valid_from::date, fa.valid_from_date)::text from curr_full_admin_users fa where fa.app_user_id = s.app_user_id)
    ),
    coalesce(
      (select case when least(case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end, case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end) = '9999-12-31'::date then 'infinity' else least(case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end, case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end)::text end from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = ('cap:' || caps.cap_name)),
      s.valid_to
    ),
    s.reconstructibility
  from curr_r1_scopes s
  cross join (values ('report_review'), ('report_assign')) as caps(cap_name)
  where s.scope_kind in ('all', 'team')
    and (
      exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = ('cap:' || caps.cap_name))
      or (exists (select 1 from curr_full_admin_users fa where fa.app_user_id = s.app_user_id) and not exists (select 1 from public.direct_entry_capability_grants g_rev where g_rev.app_user_id = s.app_user_id and g_rev.capability = caps.cap_name and g_rev.is_current = false))
    )
  union all
  select
    wrd.as_of_ts, wrd.as_of_date, wrd.app_user_id, wrd.user_created_date,
    'MODULE_OP'::text, 'work_reports'::text, ('op:work_reports:' || replace(wrd.action_code, 'delegation:report_', ''))::text, wrd.scope_kind, wrd.scope_ref,
    'derived:work_report_delegations'::text, wrd.valid_from, wrd.valid_to, wrd.reconstructibility
  from curr_work_report_delegations wrd
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'admin'::text, 'op:admin:catalog_manage'::text, 'all'::text, '*'::text,
    'derived:direct_entry_assert_catalog_operator+catalogOperatorNavPredicate(scope=all+cap)'::text, s.valid_from, s.valid_to, s.reconstructibility
  from curr_r1_scopes s
  where s.scope_kind = 'all'
    and (exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:catalog_master_manage') or exists (select 1 from curr_full_admin_users fa where fa.app_user_id = s.app_user_id))
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, op.module_code, op.action_code, 'all'::text, '*'::text,
    op.grant_source, s.valid_from, s.valid_to, s.reconstructibility
  from curr_r1_scopes s
  cross join (values ('admin', 'op:admin:location_catalog_manage', 'derived:recruitment_location_is_admin_or_bod'), ('recruitment_posts', 'op:recruitment_posts:admin_or_bod_manage', 'derived:recruitment_location_is_admin_or_bod')) as op(module_code, action_code, grant_source)
  where s.scope_kind = 'all'
    and (
      exists (select 1 from curr_full_admin_users fa where fa.app_user_id = s.app_user_id)
      or exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or (exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view') and exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view'))
    )
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'admin'::text, 'op:admin:account_and_dept_admin'::text, 'all'::text, '*'::text,
    'derived:full_admin_triple_plus_all_scope'::text, greatest(s.valid_from::date, fa.valid_from_date)::text, s.valid_to, s.reconstructibility
  from curr_r1_scopes s
  join curr_full_admin_users fa on fa.app_user_id = s.app_user_id
  where s.scope_kind = 'all'
  union all
  select
    c.as_of_ts, c.as_of_date, c.app_user_id, c.user_created_date,
    'MODULE_OP'::text, op.module_code, op.action_code, 'all'::text, '*'::text,
    op.grant_source,
    greatest(c.valid_from::date, s.valid_from::date)::text,
    case when least(case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end, case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end) = '9999-12-31'::date then 'infinity' else least(case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end, case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end)::text end,
    case when c.reconstructibility <> 'POINT_IN_TIME_CURRENT' then c.reconstructibility else s.reconstructibility end
  from curr_r1_capabilities c
  join curr_r1_scopes s on s.app_user_id = c.app_user_id and s.scope_kind = 'all'
  join (
    values
      ('cap:audit_view', 'admin', 'op:admin:audit_view', 'derived:audit_log_assert_reader'),
      ('cap:worker_edit_history_view', 'admin', 'op:admin:worker_edit_history_view', 'derived:worker_edit_history_assert_actor'),
      ('cap:duplicate_cccd_withdraw', 'direct_entry', 'op:direct_entry:duplicate_cccd_withdraw', 'derived:direct_entry_withdraw_duplicate_cccd')
  ) as op(req_cap, module_code, action_code, grant_source)
    on op.req_cap = c.action_code
),
-- =============================================================================
-- PART B: CANDIDATE EFFECTIVE ACCESS
-- =============================================================================
cand_r1_capabilities as materialized (
  select
    u.as_of_ts, u.as_of_date, u.app_user_id, u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    case
      when cg.capability in ('report_assign', 'report_review', 'report_analytics_view', 'report_template_manage', 'report_form_manage', 'report_delegate') then 'work_reports'
      when cg.capability = 'attendance_view' then 'attendance'
      when cg.capability like 'vendor_finance_%' then 'vendor_finance'
      else 'direct_entry'
    end::text as module_code,
    ('cap:' || cg.capability)::text as action_code,
    'capability'::text as scope_kind,
    '*'::text as scope_ref,
    'direct_entry_capability_grants'::text as grant_source,
    min(cg.valid_from)::text as valid_from,
    case when bool_or(cg.valid_to is null) then 'infinity' else max(cg.valid_to)::text end as valid_to,
    case when u.as_of_date < u.current_bkk_date then 'CURRENT_STATE_ONLY (u.enabled; interval_reconstructible_except_wiped_rows)' else 'POINT_IN_TIME_CURRENT' end::text as reconstructibility
  from eligible_users u
  join public.direct_entry_capability_grants cg on cg.app_user_id = u.app_user_id
  where cg.valid_from <= u.as_of_date
    and (cg.valid_to is null or (cg.valid_to > cg.valid_from and u.as_of_date < cg.valid_to))
    and (cg.is_current = true or cg.valid_to is not null)
  group by u.as_of_ts, u.as_of_date, u.current_bkk_date, u.app_user_id, u.user_created_date, cg.capability
),
cand_r1_scopes as materialized (
  select
    u.as_of_ts, u.as_of_date, u.app_user_id, u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'direct_entry'::text as module_code,
    ('scope:' || sg.scope_kind)::text as action_code,
    sg.scope_kind::text as scope_kind,
    coalesce(sg.team_id::text, '*')::text as scope_ref,
    'direct_entry_scope_grants'::text as grant_source,
    min(sg.valid_from)::text as valid_from,
    case when bool_or(sg.valid_to is null) then 'infinity' else max(sg.valid_to)::text end as valid_to,
    case
      when u.as_of_date < u.current_bkk_date then
        case when sg.scope_kind = 'team' then 'CURRENT_STATE_ONLY (u.enabled + t.active; interval_reconstructible_except_wiped_rows)' else 'CURRENT_STATE_ONLY (u.enabled; interval_reconstructible_except_wiped_rows)' end
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.direct_entry_scope_grants sg on sg.app_user_id = u.app_user_id
  left join public.teams t on sg.scope_kind = 'team' and t.team_id = sg.team_id
  where sg.valid_from <= u.as_of_date
    and (sg.valid_to is null or (sg.valid_to > sg.valid_from and u.as_of_date < sg.valid_to))
    and (sg.is_current = true or sg.valid_to is not null)
    and (sg.scope_kind <> 'team' or (t.team_id is not null and t.active = true))
    and (
      sg.scope_kind <> 'all'
      or exists (
        select 1
        from cand_r1_capabilities cg
        where cg.app_user_id = u.app_user_id
          and cg.action_code in (
            'cap:entry_admin', 'cap:entry_privileged_edit', 'cap:entry_create',
            'cap:report_view', 'cap:report_analytics_view', 'cap:report_review',
            'cap:report_assign', 'cap:report_template_manage', 'cap:report_form_manage',
            'cap:report_delegate', 'cap:attendance_view',
            'cap:vendor_finance_view', 'cap:vendor_finance_record', 'cap:vendor_finance_reconcile', 'cap:vendor_finance_admin',
            'cap:worker_edit_history_view', 'cap:change_review',
            'cap:employment_status.review', 'cap:employment_status.apply',
            'cap:entry_restore', 'cap:audit_view', 'cap:catalog_master_manage', 'cap:duplicate_cccd_withdraw'
          )
      )
    )
  group by u.as_of_ts, u.as_of_date, u.current_bkk_date, u.app_user_id, u.user_created_date, sg.scope_kind, coalesce(sg.team_id::text, '*')
),
cand_full_admin_users as materialized (
  select
    c.app_user_id,
    greatest(
      max(c.valid_from::date) filter (where c.action_code = 'cap:entry_admin'),
      max(c.valid_from::date) filter (where c.action_code = 'cap:recruiter_master_manage'),
      max(c.valid_from::date) filter (where c.action_code = 'cap:team_master_manage')
    ) as valid_from_date
  from cand_r1_capabilities c
  where c.action_code in ('cap:entry_admin', 'cap:recruiter_master_manage', 'cap:team_master_manage')
  group by c.app_user_id
  having count(distinct c.action_code) = 3
),
cand_recruiter_links_base as materialized (
  select u.as_of_ts, u.as_of_date, u.current_bkk_date, u.app_user_id, u.user_created_date, rl.recruiter_id, rl.valid_from, rl.valid_to
  from eligible_users u
  join public.direct_entry_app_user_recruiter_links rl on rl.app_user_id = u.app_user_id and rl.verified = true
  join public.recruiters r on r.recruiter_id = rl.recruiter_id and r.active = true
  where rl.valid_from <= u.as_of_date
    and (rl.valid_to is null or (rl.valid_to > rl.valid_from and u.as_of_date < rl.valid_to))
    and (rl.is_current = true or rl.valid_to is not null)
),
cand_recruiter_links as materialized (
  select
    b.as_of_ts, b.as_of_date, b.app_user_id, b.user_created_date,
    'RAW_GRANT'::text as row_layer, 'direct_entry'::text as module_code, 'recruiter_link:verified'::text as action_code, 'recruited'::text as scope_kind, b.recruiter_id::text as scope_ref,
    'direct_entry_app_user_recruiter_links'::text as grant_source, min(b.valid_from)::text as valid_from,
    case when bool_or(b.valid_to is null) then 'infinity' else max(b.valid_to)::text end as valid_to,
    case when b.as_of_date < b.current_bkk_date then 'CURRENT_STATE_ONLY (u.enabled + r.active; interval_reconstructible_except_wiped_rows)' else 'POINT_IN_TIME_CURRENT' end::text as reconstructibility
  from cand_recruiter_links_base b
  group by b.as_of_ts, b.as_of_date, b.current_bkk_date, b.app_user_id, b.user_created_date, b.recruiter_id
),
cand_unambiguous_recruiter_links as materialized (
  select rl.app_user_id, rl.recruiter_id
  from cand_recruiter_links_base rl
  where (
    select count(*)
    from public.direct_entry_app_user_recruiter_links all_u
    where all_u.app_user_id = rl.app_user_id
      and all_u.verified = true
      and all_u.valid_from <= rl.as_of_date
      and (all_u.valid_to is null or (all_u.valid_to > all_u.valid_from and rl.as_of_date < all_u.valid_to))
      and (all_u.is_current = true or all_u.valid_to is not null)
  ) = 1
    and (
      select count(*)
      from public.direct_entry_app_user_recruiter_links all_r
      where all_r.recruiter_id = rl.recruiter_id
        and all_r.verified = true
        and all_r.valid_from <= rl.as_of_date
        and (all_r.valid_to is null or (all_r.valid_to > all_r.valid_from and rl.as_of_date < all_r.valid_to))
        and (all_r.is_current = true or all_r.valid_to is not null)
    ) = 1
),
cand_team_leader_assignments as materialized (
  select
    u.as_of_ts, u.as_of_date, u.app_user_id, u.user_created_date,
    'RAW_GRANT'::text as row_layer, 'direct_entry'::text as module_code, 'assignment:team_leader'::text as action_code, 'team'::text as scope_kind, tla.team_id::text as scope_ref,
    'direct_entry_team_leader_assignments'::text as grant_source, min(tla.valid_from)::text as valid_from,
    case when bool_or(tla.valid_to is null) then 'infinity' else max(tla.valid_to)::text end as valid_to,
    case when u.as_of_date < u.current_bkk_date then 'CURRENT_STATE_ONLY (u.enabled + t.active; interval_reconstructible_except_wiped_rows)' else 'POINT_IN_TIME_CURRENT' end::text as reconstructibility
  from eligible_users u
  join public.direct_entry_team_leader_assignments tla on tla.leader_app_user_id = u.app_user_id
  join public.teams t on t.team_id = tla.team_id and t.active = true
  where tla.valid_from <= u.as_of_date
    and (tla.valid_to is null or (tla.valid_to > tla.valid_from and u.as_of_date < tla.valid_to))
    and (tla.is_current = true or tla.valid_to is not null)
  group by u.as_of_ts, u.as_of_date, u.current_bkk_date, u.app_user_id, u.user_created_date, tla.team_id
),
cand_project_manager_assignments as materialized (
  select
    u.as_of_ts, u.as_of_date, u.app_user_id, u.user_created_date,
    'RAW_GRANT'::text as row_layer, 'direct_entry'::text as module_code, 'assignment:project_manager'::text as action_code, 'project'::text as scope_kind, pma.project_id::text as scope_ref,
    'direct_entry_project_manager_assignments'::text as grant_source, min(pma.valid_from)::text as valid_from,
    case when bool_or(pma.valid_to is null) then 'infinity' else max(pma.valid_to)::text end as valid_to,
    case when u.as_of_date < u.current_bkk_date then 'CURRENT_STATE_ONLY (u.enabled + prj.active; interval_reconstructible)' else 'POINT_IN_TIME_CURRENT' end::text as reconstructibility
  from eligible_users u
  join cand_unambiguous_recruiter_links url on url.app_user_id = u.app_user_id
  join public.direct_entry_project_manager_assignments pma on pma.manager_recruiter_id = url.recruiter_id
  join public.direct_entry_projects prj on prj.project_id = pma.project_id and prj.active = true
  where pma.valid_from <= u.as_of_date
    and (pma.valid_to is null or (pma.valid_to > pma.valid_from and u.as_of_date < pma.valid_to))
    and ((pma.revoked_at is null and pma.is_current = true) or (pma.revoked_at is not null and u.as_of_ts < pma.revoked_at))
  group by u.as_of_ts, u.as_of_date, u.current_bkk_date, u.app_user_id, u.user_created_date, pma.project_id
),
cand_org_dept_memberships as materialized (
  select
    u.as_of_ts, u.as_of_date, u.app_user_id, u.user_created_date,
    'RAW_GRANT'::text as row_layer, 'org'::text as module_code, ('dept_member:' || od.code)::text as action_code, 'department'::text as scope_kind, odm.department_id::text as scope_ref,
    'organization_department_memberships'::text as grant_source, min(odm.valid_from)::text as valid_from,
    case when bool_or(odm.valid_to is null) then 'infinity' else max(odm.valid_to)::text end as valid_to,
    case when u.as_of_date < u.current_bkk_date then 'CURRENT_STATE_ONLY (u.enabled + od.is_active; interval_reconstructible)' else 'POINT_IN_TIME_CURRENT' end::text as reconstructibility
  from eligible_users u
  join public.organization_department_memberships odm on odm.app_user_id = u.app_user_id
  join public.organization_departments od on od.department_id = odm.department_id and od.is_active = true
  where odm.valid_from <= u.as_of_date
    and (odm.valid_to is null or (odm.valid_to > odm.valid_from and u.as_of_date < odm.valid_to))
    and (odm.revoked_at is null or u.as_of_ts < odm.revoked_at)
  group by u.as_of_ts, u.as_of_date, u.current_bkk_date, u.app_user_id, u.user_created_date, od.code, odm.department_id
),
cand_leave_grants as materialized (
  select
    u.as_of_ts, u.as_of_date, u.app_user_id, u.user_created_date,
    'RAW_GRANT'::text as row_layer, 'leave'::text as module_code, ('leave_role:' || lmg.role_code)::text as action_code, 'all'::text as scope_kind, '*'::text as scope_ref,
    'leave_module_grants'::text as grant_source, min(lmg.valid_from)::text as valid_from,
    case when bool_or(lmg.valid_to is null) then 'infinity' else max(lmg.valid_to)::text end as valid_to,
    case when u.as_of_date < u.current_bkk_date then 'CURRENT_STATE_ONLY (u.enabled + updated_at_same_day_revoke; interval_reconstructible)' else 'POINT_IN_TIME_CURRENT' end::text as reconstructibility
  from eligible_users u
  join public.leave_module_grants lmg on lmg.app_user_id = u.app_user_id
  where lmg.valid_from <= u.as_of_date
    and (lmg.valid_to is null or (lmg.valid_to > lmg.valid_from and u.as_of_date < lmg.valid_to))
    and (lmg.is_current = true or (lmg.valid_to is not null and lmg.updated_at is not null and (lmg.updated_at at time zone 'Asia/Ho_Chi_Minh')::date > lmg.valid_from and u.as_of_ts < lmg.updated_at))
  group by u.as_of_ts, u.as_of_date, u.current_bkk_date, u.app_user_id, u.user_created_date, lmg.role_code
  union all
  select
    u.as_of_ts, u.as_of_date, u.app_user_id, u.user_created_date,
    'RAW_GRANT'::text, 'leave'::text, ('department_approver:' || lda.unit_kind)::text, 'unit_kind'::text, lda.unit_kind::text,
    'leave_department_approvers'::text, min(lda.valid_from)::text,
    case when bool_or(lda.valid_to is null) then 'infinity' else max(lda.valid_to)::text end,
    case when u.as_of_date < u.current_bkk_date then 'CURRENT_STATE_ONLY (u.enabled; interval_reconstructible_except_wiped_rows)' else 'POINT_IN_TIME_CURRENT' end::text
  from eligible_users u
  join public.leave_department_approvers lda on lda.approver_app_user_id = u.app_user_id
  where lda.valid_from <= u.as_of_date
    and (lda.valid_to is null or (lda.valid_to > lda.valid_from and u.as_of_date < lda.valid_to))
    and (lda.is_current = true or lda.valid_to is not null)
  group by u.as_of_ts, u.as_of_date, u.current_bkk_date, u.app_user_id, u.user_created_date, lda.unit_kind
),
cand_vendor_finance_grants as materialized (
  select
    u.as_of_ts, u.as_of_date, u.app_user_id, u.user_created_date,
    'RAW_GRANT'::text as row_layer, 'vendor_finance'::text as module_code, ('vfin_role:' || vfgr.role_code)::text as action_code, 'all'::text as scope_kind, '*'::text as scope_ref,
    'vendor_finance_global_roles'::text as grant_source, min(vfgr.valid_from)::text as valid_from,
    case when bool_or(vfgr.valid_to is null) then 'infinity' else max(vfgr.valid_to)::text end as valid_to,
    case when u.as_of_date < u.current_bkk_date then 'CURRENT_STATE_ONLY (u.enabled; interval_reconstructible)' else 'POINT_IN_TIME_CURRENT' end::text as reconstructibility
  from eligible_users u
  join public.vendor_finance_global_roles vfgr on vfgr.app_user_id = u.app_user_id
  where vfgr.valid_from <= u.as_of_date
    and (vfgr.valid_to is null or (vfgr.valid_to > vfgr.valid_from and u.as_of_date < vfgr.valid_to))
    and (vfgr.ended_at is null or (vfgr.valid_to is not null and u.as_of_ts < vfgr.ended_at))
  group by u.as_of_ts, u.as_of_date, u.current_bkk_date, u.app_user_id, u.user_created_date, vfgr.role_code
  union all
  select
    u.as_of_ts, u.as_of_date, u.app_user_id, u.user_created_date,
    'RAW_GRANT'::text, 'vendor_finance'::text, 'vfin_project_accountant'::text, 'project'::text, vfpa.project_id::text,
    'vendor_finance_project_accountants'::text, min(vfpa.valid_from)::text,
    case when bool_or(vfpa.valid_to is null) then 'infinity' else max(vfpa.valid_to)::text end,
    case when u.as_of_date < u.current_bkk_date then 'CURRENT_STATE_ONLY (u.enabled + prj.active; interval_reconstructible)' else 'POINT_IN_TIME_CURRENT' end::text
  from eligible_users u
  join public.vendor_finance_project_accountants vfpa on vfpa.accountant_user_id = u.app_user_id
  join public.direct_entry_projects prj on prj.project_id = vfpa.project_id and prj.active = true
  where vfpa.valid_from <= u.as_of_date
    and (vfpa.valid_to is null or (vfpa.valid_to > vfpa.valid_from and u.as_of_date < vfpa.valid_to))
    and (vfpa.ended_at is null or (vfpa.valid_to is not null and u.as_of_ts < vfpa.ended_at))
  group by u.as_of_ts, u.as_of_date, u.current_bkk_date, u.app_user_id, u.user_created_date, vfpa.project_id
),
cand_grantor_work_report_authority as materialized (
  select
    u.app_user_id as grantor_user_id, caps.capability, s.scope_kind,
    case when s.scope_kind = 'team' then s.scope_ref else '*' end as scope_ref
  from eligible_users u
  cross join (values ('report_delegate'), ('report_assign'), ('report_review')) as caps(capability)
  join cand_r1_scopes s on s.app_user_id = u.app_user_id and s.scope_kind in ('all', 'team')
  where (
    exists (select 1 from cand_r1_capabilities c where c.app_user_id = u.app_user_id and c.action_code = ('cap:' || caps.capability))
    or (
      exists (select 1 from cand_full_admin_users fa where fa.app_user_id = u.app_user_id)
      and not exists (select 1 from public.direct_entry_capability_grants g_rev where g_rev.app_user_id = u.app_user_id and g_rev.capability = caps.capability and g_rev.is_current = false and g_rev.valid_to is null)
    )
  )
),
cand_work_report_delegations as materialized (
  select
    u.as_of_ts, u.as_of_date, u.app_user_id, u.user_created_date,
    'RAW_GRANT'::text as row_layer, 'work_reports'::text as module_code, ('delegation:' || wrd.capability)::text as action_code, ('template_' || wrd.scope_kind)::text as scope_kind,
    (wrd.template_id::text || ':' || coalesce(wrd.scope_team_id::text, '*'))::text as scope_ref,
    'work_report_delegations'::text as grant_source,
    min((wrd.effective_from at time zone 'Asia/Ho_Chi_Minh')::date)::text as valid_from,
    case when bool_or(wrd.effective_to is null) then 'infinity' else max((wrd.effective_to at time zone 'Asia/Ho_Chi_Minh')::date)::text end as valid_to,
    case when u.as_of_date < u.current_bkk_date then 'CURRENT_STATE_ONLY (u.enabled + gu.enabled + wt.status; timestamp_reconstructible)' else 'POINT_IN_TIME_CURRENT' end::text as reconstructibility
  from eligible_users u
  join public.work_report_delegations wrd on wrd.delegate_app_user_id = u.app_user_id
  join eligible_users gu on gu.app_user_id = wrd.grantor_user_id
  join public.work_report_templates wt on wt.template_id = wrd.template_id and wt.status = 'ACTIVE' and wt.current_published_version_id is not null
  where wrd.effective_from <= u.as_of_ts
    and (wrd.effective_to is null or u.as_of_ts <= wrd.effective_to)
    and ((wrd.revoked_at is null and wrd.state = 'ACTIVE' and wrd.is_current = true) or (wrd.revoked_at is not null and u.as_of_ts < wrd.revoked_at))
    and (
      wrd.scope_kind = 'all'
      or (
        wrd.scope_kind = 'team'
        and exists (select 1 from public.teams tm where tm.team_id = wrd.scope_team_id and tm.active = true)
        and (
          exists (select 1 from cand_r1_scopes dsg where dsg.app_user_id = u.app_user_id and dsg.scope_kind = 'team' and dsg.scope_ref = wrd.scope_team_id::text)
          or exists (
            select 1
            from cand_recruiter_links_base rl
            join public.recruiter_team_memberships rtm on rtm.recruiter_id = rl.recruiter_id and rtm.team_id = wrd.scope_team_id
            where rl.app_user_id = u.app_user_id
              and rtm.valid_from <= u.as_of_date
              and (rtm.valid_to is null or (rtm.valid_to > rtm.valid_from and u.as_of_date < rtm.valid_to))
              and (rtm.is_current = true or rtm.valid_to is not null)
          )
        )
      )
    )
    and exists (
      select 1 from cand_grantor_work_report_authority ga_del
      where ga_del.grantor_user_id = wrd.grantor_user_id and ga_del.capability = 'report_delegate'
        and (ga_del.scope_kind = 'all' or (wrd.scope_kind = 'team' and ga_del.scope_kind = 'team' and ga_del.scope_ref = wrd.scope_team_id::text))
    )
    and exists (
      select 1 from cand_grantor_work_report_authority ga_cap
      where ga_cap.grantor_user_id = wrd.grantor_user_id and ga_cap.capability = wrd.capability
        and (ga_cap.scope_kind = 'all' or (wrd.scope_kind = 'team' and ga_cap.scope_kind = 'team' and ga_cap.scope_ref = wrd.scope_team_id::text))
    )
  group by u.as_of_ts, u.as_of_date, u.current_bkk_date, u.app_user_id, u.user_created_date, wrd.capability, wrd.scope_kind, (wrd.template_id::text || ':' || coalesce(wrd.scope_team_id::text, '*'))
),
cand_raw_grants as (
  select * from cand_r1_capabilities
  union all select * from cand_r1_scopes
  union all select * from cand_recruiter_links
  union all select * from cand_team_leader_assignments
  union all select * from cand_project_manager_assignments
  union all select * from cand_org_dept_memberships
  union all select * from cand_leave_grants
  union all select * from cand_vendor_finance_grants
  union all select * from cand_work_report_delegations
),
cand_module_ops_raw as (
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text as row_layer, 'dashboard'::text as module_code, 'op:dashboard:view_general'::text as action_code, 'all'::text as scope_kind, '*'::text as scope_ref,
    'derived:direct_entry_reporting_resolve_audience+direct_entry_reporting_scoped_facts+direct_entry_workforce_reporting_scoped(overview)'::text as grant_source,
    s.valid_from, s.valid_to, s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'all'
    and (exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code in ('cap:report_view', 'cap:entry_privileged_edit')) or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id))
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'dashboard'::text, op.action_code, 'all'::text, '*'::text,
    op.grant_source, s.valid_from, s.valid_to, s.reconstructibility
  from cand_r1_scopes s
  cross join (
    values
      ('op:dashboard:view_workforce_deep', 'derived:canViewDeepWorkforceReport+direct_entry_workforce_reporting_scoped(deep|project_page)'),
      ('op:dashboard:view_detailed_matrix', 'derived:canViewDeepWorkforceReport+direct_entry_reporting_detailed_matrix_catalog+direct_entry_reporting_team_drill_down')
  ) as op(action_code, grant_source)
  where s.scope_kind = 'all'
    and (
      (exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view')
       and exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view'))
      or exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id)
    )
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'dashboard'::text, 'op:dashboard:view_general'::text, 'team'::text, s.scope_ref,
    'derived:direct_entry_reporting_resolve_audience'::text, s.valid_from, s.valid_to, s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'team'
    and not exists (
      select 1 from cand_r1_scopes s_all
      where s_all.app_user_id = s.app_user_id and s_all.scope_kind = 'all'
        and (exists (select 1 from cand_r1_capabilities c_all where c_all.app_user_id = s_all.app_user_id and c_all.action_code in ('cap:report_view', 'cap:entry_privileged_edit')) or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s_all.app_user_id))
    )
  union all
  select
    rl.as_of_ts, rl.as_of_date, rl.app_user_id, rl.user_created_date,
    'MODULE_OP'::text, 'dashboard'::text, 'op:dashboard:view_general'::text, 'recruited'::text, rl.scope_ref,
    'derived:direct_entry_reporting_resolve_audience'::text, rl.valid_from, rl.valid_to, rl.reconstructibility
  from cand_recruiter_links rl
  where not exists (
    select 1 from cand_r1_scopes s_other
    where s_other.app_user_id = rl.app_user_id
      and (s_other.scope_kind = 'team' or (s_other.scope_kind = 'all' and (exists (select 1 from cand_r1_capabilities c_all where c_all.app_user_id = s_other.app_user_id and c_all.action_code in ('cap:report_view', 'cap:entry_privileged_edit')) or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s_other.app_user_id))))
  )
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'workforce'::text, 'op:workforce:offboarding_view'::text, 'all'::text, '*'::text,
    'derived:canAccessOffboardingReport+offboarding_report_read'::text, s.valid_from, s.valid_to, s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'all'
    and (
      (exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view')
       and exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view'))
      or exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id)
    )
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'direct_entry'::text, 'op:direct_entry:workers_all_tab'::text, 'all'::text, '*'::text,
    'derived:direct_entry_submission_list_all_read'::text, s.valid_from, s.valid_to, s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'all'
    and (exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code in ('cap:entry_privileged_edit', 'cap:change_review')) or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id))
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'attendance'::text, 'op:attendance:report_view'::text, 'all'::text, '*'::text,
    'derived:attendance__internal_assert_report_reader'::text, s.valid_from, s.valid_to, s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'all'
    and (
      exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id)
      or (exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view')
          and exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view'))
    )
  union all
  select
    tla.as_of_ts, tla.as_of_date, tla.app_user_id, tla.user_created_date,
    'MODULE_OP'::text, 'attendance'::text, 'op:attendance:report_view'::text, 'team'::text, tla.scope_ref,
    'derived:attendance__internal_resolve_report_scope'::text, tla.valid_from, tla.valid_to, tla.reconstructibility
  from cand_team_leader_assignments tla
  where exists (select 1 from cand_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:team_manager_assign')
    and exists (select 1 from cand_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_view')
    and exists (select 1 from cand_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_analytics_view')
  union all
  select
    lg.as_of_ts, lg.as_of_date, lg.app_user_id, lg.user_created_date,
    'MODULE_OP'::text, 'leave'::text, 'op:leave:approve_department'::text, lg.scope_kind, lg.scope_ref,
    'derived:leave_can_approve_department'::text, lg.valid_from, lg.valid_to, lg.reconstructibility
  from cand_leave_grants lg
  left join public.leave_employee_profiles lep on lep.app_user_id = lg.app_user_id
  where lg.action_code like 'department_approver:%' and not coalesce(lep.is_shared_non_employee, false)
  union all
  select
    tla.as_of_ts, tla.as_of_date, tla.app_user_id, tla.user_created_date,
    'MODULE_OP'::text, 'leave'::text, 'op:leave:approve_team'::text, 'team'::text, tla.scope_ref,
    'derived:leave_can_approve_recruitment_team'::text, tla.valid_from, tla.valid_to, tla.reconstructibility
  from cand_team_leader_assignments tla
  left join public.leave_employee_profiles lep on lep.app_user_id = tla.app_user_id
  where not coalesce(lep.is_shared_non_employee, false)
  union all
  select
    lg.as_of_ts, lg.as_of_date, lg.app_user_id, lg.user_created_date,
    'MODULE_OP'::text, 'leave'::text, ('op:leave:hr_grant_' || replace(lg.action_code, 'leave_role:', ''))::text, 'all'::text, '*'::text,
    'derived:leave_user_has_any_role'::text, lg.valid_from, lg.valid_to, lg.reconstructibility
  from cand_leave_grants lg
  left join public.leave_employee_profiles lep on lep.app_user_id = lg.app_user_id
  where lg.action_code like 'leave_role:%' and not coalesce(lep.is_shared_non_employee, false)
  union all
  select
    vf.as_of_ts, vf.as_of_date, vf.app_user_id, vf.user_created_date,
    'MODULE_OP'::text, op.module_code, op.action_code, 'project'::text, vf.scope_ref,
    'derived:vendor_finance_project_accountants'::text,
    greatest(vf.valid_from::date, odm.valid_from::date)::text,
    case when least(case when vf.valid_to = 'infinity' then '9999-12-31'::date else vf.valid_to::date end, case when odm.valid_to = 'infinity' then '9999-12-31'::date else odm.valid_to::date end) = '9999-12-31'::date then 'infinity' else least(case when vf.valid_to = 'infinity' then '9999-12-31'::date else vf.valid_to::date end, case when odm.valid_to = 'infinity' then '9999-12-31'::date else odm.valid_to::date end)::text end,
    vf.reconstructibility
  from cand_vendor_finance_grants vf
  join cand_org_dept_memberships odm on odm.app_user_id = vf.app_user_id and odm.action_code = 'dept_member:ACCOUNTING'
  cross join (values ('vendor_finance', 'op:vendor_finance:project_ledger_operate'), ('salary_advance', 'op:salary_advance:accountant_decide')) as op(module_code, action_code)
  where vf.action_code = 'vfin_project_accountant'
  union all
  select
    vf.as_of_ts, vf.as_of_date, vf.app_user_id, vf.user_created_date,
    'MODULE_OP'::text, 'vendor_finance'::text, ('op:vendor_finance:global_' || replace(vf.action_code, 'vfin_role:', ''))::text, 'all'::text, '*'::text,
    'derived:vendor_finance_global_roles'::text, vf.valid_from, vf.valid_to, vf.reconstructibility
  from cand_vendor_finance_grants vf
  where vf.action_code like 'vfin_role:%'
  union all
  select
    pma.as_of_ts, pma.as_of_date, pma.app_user_id, pma.user_created_date,
    'MODULE_OP'::text, op.module_code, op.action_code, 'project'::text, pma.scope_ref,
    'derived:project_manager_assignments'::text, pma.valid_from, pma.valid_to, pma.reconstructibility
  from cand_project_manager_assignments pma
  cross join (values ('vendor_finance', 'op:vendor_finance:pm_project_view'), ('salary_advance', 'op:salary_advance:pm_request'), ('recruitment_posts', 'op:recruitment_posts:pm_manage_project')) as op(module_code, action_code)
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'work_reports'::text, ('op:work_reports:' || replace(caps.cap_name, 'report_', ''))::text, s.scope_kind, s.scope_ref,
    ('derived:work_report_direct_' || replace(caps.cap_name, 'report_', ''))::text,
    coalesce(
      (select greatest(s.valid_from::date, c.valid_from::date)::text from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = ('cap:' || caps.cap_name)),
      (select greatest(s.valid_from::date, fa.valid_from_date)::text from cand_full_admin_users fa where fa.app_user_id = s.app_user_id)
    ),
    coalesce(
      (select case when least(case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end, case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end) = '9999-12-31'::date then 'infinity' else least(case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end, case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end)::text end from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = ('cap:' || caps.cap_name)),
      s.valid_to
    ),
    s.reconstructibility
  from cand_r1_scopes s
  cross join (values ('report_review'), ('report_assign')) as caps(cap_name)
  where s.scope_kind in ('all', 'team')
    and (
      exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = ('cap:' || caps.cap_name))
      or (exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id) and not exists (select 1 from public.direct_entry_capability_grants g_rev where g_rev.app_user_id = s.app_user_id and g_rev.capability = caps.cap_name and g_rev.is_current = false and g_rev.valid_to is null))
    )
  union all
  select
    wrd.as_of_ts, wrd.as_of_date, wrd.app_user_id, wrd.user_created_date,
    'MODULE_OP'::text, 'work_reports'::text, ('op:work_reports:' || replace(wrd.action_code, 'delegation:report_', ''))::text, wrd.scope_kind, wrd.scope_ref,
    'derived:work_report_delegations'::text, wrd.valid_from, wrd.valid_to, wrd.reconstructibility
  from cand_work_report_delegations wrd
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'admin'::text, 'op:admin:catalog_manage'::text, 'all'::text, '*'::text,
    'derived:direct_entry_assert_catalog_operator+catalogOperatorNavPredicate(scope=all+cap)'::text, s.valid_from, s.valid_to, s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'all'
    and (exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:catalog_master_manage') or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id))
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, op.module_code, op.action_code, 'all'::text, '*'::text,
    op.grant_source, s.valid_from, s.valid_to, s.reconstructibility
  from cand_r1_scopes s
  cross join (values ('admin', 'op:admin:location_catalog_manage', 'derived:recruitment_location_is_admin_or_bod'), ('recruitment_posts', 'op:recruitment_posts:admin_or_bod_manage', 'derived:recruitment_location_is_admin_or_bod')) as op(module_code, action_code, grant_source)
  where s.scope_kind = 'all'
    and (
      exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id)
      or exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or (exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view') and exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view'))
    )
  union all
  select
    s.as_of_ts, s.as_of_date, s.app_user_id, s.user_created_date,
    'MODULE_OP'::text, 'admin'::text, 'op:admin:account_and_dept_admin'::text, 'all'::text, '*'::text,
    'derived:full_admin_triple_plus_all_scope'::text, greatest(s.valid_from::date, fa.valid_from_date)::text, s.valid_to, s.reconstructibility
  from cand_r1_scopes s
  join cand_full_admin_users fa on fa.app_user_id = s.app_user_id
  where s.scope_kind = 'all'
  union all
  select
    c.as_of_ts, c.as_of_date, c.app_user_id, c.user_created_date,
    'MODULE_OP'::text, op.module_code, op.action_code, 'all'::text, '*'::text,
    op.grant_source,
    greatest(c.valid_from::date, s.valid_from::date)::text,
    case when least(case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end, case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end) = '9999-12-31'::date then 'infinity' else least(case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end, case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end)::text end,
    case when c.reconstructibility <> 'POINT_IN_TIME_CURRENT' then c.reconstructibility else s.reconstructibility end
  from cand_r1_capabilities c
  join cand_r1_scopes s on s.app_user_id = c.app_user_id and s.scope_kind = 'all'
  join (
    values
      ('cap:audit_view', 'admin', 'op:admin:audit_view', 'derived:audit_log_assert_reader'),
      ('cap:worker_edit_history_view', 'admin', 'op:admin:worker_edit_history_view', 'derived:worker_edit_history_assert_actor'),
      ('cap:duplicate_cccd_withdraw', 'direct_entry', 'op:direct_entry:duplicate_cccd_withdraw', 'derived:direct_entry_withdraw_duplicate_cccd')
  ) as op(req_cap, module_code, action_code, grant_source)
    on op.req_cap = c.action_code
),
-- =============================================================================
-- PART C: DEDUPLICATED SNAPSHOTS + SHADOW DIFF
-- =============================================================================
current_rows as materialized (
  select
    as_of_ts, as_of_date, app_user_id, user_created_date,
    row_layer, module_code, action_code, scope_kind, scope_ref,
    min(grant_source) as grant_source, min(valid_from) as valid_from, max(valid_to) as valid_to, min(reconstructibility) as reconstructibility
  from (select * from curr_raw_grants union all select * from curr_module_ops_raw) curr_all
  where (select target_app_user_id from params) is null
     or app_user_id = (select target_app_user_id from params)
  group by as_of_ts, as_of_date, app_user_id, user_created_date, row_layer, module_code, action_code, scope_kind, scope_ref
),
candidate_rows as materialized (
  select
    as_of_ts, as_of_date, app_user_id, user_created_date,
    row_layer, module_code, action_code, scope_kind, scope_ref,
    min(grant_source) as grant_source, min(valid_from) as valid_from, max(valid_to) as valid_to, min(reconstructibility) as reconstructibility
  from (select * from cand_raw_grants union all select * from cand_module_ops_raw) cand_all
  where (select target_app_user_id from params) is null
     or app_user_id = (select target_app_user_id from params)
  group by as_of_ts, as_of_date, app_user_id, user_created_date, row_layer, module_code, action_code, scope_kind, scope_ref
),
lost_rows as (
  select
    cur.as_of_ts,
    cur.as_of_date,
    cur.app_user_id,
    (left(cur.app_user_id::text, 8) || '...')::text as account_id_mask,
    'LOST_IN_CANDIDATE'::text as diff_status,
    case
      when cur.valid_from <> 'infinity' and cur.valid_from::date > cur.as_of_date
      then 'EXPECTED_FIX_FUTURE_DATED_GRANT'
      when cur.valid_to <> 'infinity' and cur.valid_to::date <= cur.as_of_date
      then 'EXPECTED_FIX_EXPIRED_GRANT_STALE_IS_CURRENT'
      when cur.scope_kind = 'all'
       and cur.action_code in ('scope:all', 'op:dashboard:view_general', 'op:dashboard:view_workforce_deep', 'op:dashboard:view_detailed_matrix')
       and not exists (select 1 from candidate_rows cand_c where cand_c.app_user_id = cur.app_user_id and cand_c.row_layer = 'RAW_GRANT' and cand_c.action_code like 'cap:%')
      then 'EXPECTED_FIX_ORPHAN_ALL_SCOPE'
      when cur.scope_kind = 'all'
       and cur.action_code in ('scope:all', 'op:dashboard:view_general', 'op:dashboard:view_workforce_deep', 'op:dashboard:view_detailed_matrix')
       and exists (select 1 from candidate_rows cand_c where cand_c.app_user_id = cur.app_user_id and cand_c.row_layer = 'RAW_GRANT' and cand_c.action_code like 'cap:%')
      then 'EXPECTED_FIX_ALL_SCOPE_WRONG_MODULE_CAPABILITY'
      when cur.module_code = 'leave'
       and exists (select 1 from public.leave_employee_profiles lep where lep.app_user_id = cur.app_user_id and coalesce(lep.is_shared_non_employee, false) = true)
      then 'EXPECTED_FIX_SHARED_ACCOUNT_EXCLUSION'
      when cur.action_code in ('op:vendor_finance:project_ledger_operate', 'op:salary_advance:accountant_decide')
       and not exists (select 1 from candidate_rows cand_dept where cand_dept.app_user_id = cur.app_user_id and cand_dept.row_layer = 'RAW_GRANT' and cand_dept.action_code = 'dept_member:ACCOUNTING')
      then 'EXPECTED_FIX_PROJECT_ACCOUNTANT_REQUIRES_ACCOUNTING_DEPT'
      when cur.action_code in ('assignment:project_manager', 'op:vendor_finance:pm_project_view', 'op:salary_advance:pm_request', 'op:recruitment_posts:pm_manage_project')
       and exists (select 1 from candidate_rows cand_rl where cand_rl.app_user_id = cur.app_user_id and cand_rl.row_layer = 'RAW_GRANT' and cand_rl.action_code = 'recruiter_link:verified')
       and exists (
         select 1
         from public.direct_entry_app_user_recruiter_links rl_check
         where rl_check.verified = true
           and rl_check.valid_from <= cur.as_of_date
           and (rl_check.valid_to is null or (rl_check.valid_to > rl_check.valid_from and cur.as_of_date < rl_check.valid_to))
           and (rl_check.is_current = true or rl_check.valid_to is not null)
           and (rl_check.app_user_id = cur.app_user_id or rl_check.recruiter_id in (select rl2.recruiter_id from public.direct_entry_app_user_recruiter_links rl2 where rl2.app_user_id = cur.app_user_id and rl2.verified = true))
       )
      then 'EXPECTED_FIX_AMBIGUOUS_RECRUITER_LINK'
      when (cur.action_code like 'delegation:%' or cur.scope_kind like 'template_%')
       and exists (select 1 from public.work_report_delegations wrd where wrd.delegate_app_user_id = cur.app_user_id and ('delegation:' || wrd.capability = cur.action_code or 'op:work_reports:' || replace(wrd.capability, 'report_', '') = cur.action_code))
      then 'EXPECTED_FIX_DELEGATION_GRANTOR_INVALID'
      else 'UNEXPECTED_REGRESSION_CHECK_REQUIRED'
    end::text as diff_classification,
    case
      when cur.valid_from <> 'infinity' and cur.valid_from::date > cur.as_of_date
      then 'Current runtime accepted future-dated row with stale is_current=true; candidate enforces valid_from <= as_of_date'
      when cur.valid_to <> 'infinity' and cur.valid_to::date <= cur.as_of_date
      then 'Current runtime accepted expired/closed row (valid_to <= as_of_date) due to stale is_current=true; candidate enforces half-open [valid_from, valid_to)'
      when cur.scope_kind = 'all'
       and cur.action_code in ('scope:all', 'op:dashboard:view_general', 'op:dashboard:view_workforce_deep', 'op:dashboard:view_detailed_matrix')
       and not exists (select 1 from candidate_rows cand_c where cand_c.app_user_id = cur.app_user_id and cand_c.row_layer = 'RAW_GRANT' and cand_c.action_code like 'cap:%')
      then 'Standalone scope=all with 0 capabilities; candidate requires paired capabilities per WP2A rules (WP5-WP6 explicit role required if BoD access is intended)'
      when cur.scope_kind = 'all'
       and cur.action_code in ('scope:all', 'op:dashboard:view_general', 'op:dashboard:view_workforce_deep', 'op:dashboard:view_detailed_matrix')
       and exists (select 1 from candidate_rows cand_c where cand_c.app_user_id = cur.app_user_id and cand_c.row_layer = 'RAW_GRANT' and cand_c.action_code like 'cap:%')
      then 'User holds scope=all with capabilities that do not authorize this target operation (prevents legacy Dashboard widening)'
      when cur.module_code = 'leave'
       and exists (select 1 from public.leave_employee_profiles lep where lep.app_user_id = cur.app_user_id and coalesce(lep.is_shared_non_employee, false) = true)
      then 'Shared/service account excluded from operational Leave roles and approvals in candidate'
      when cur.action_code in ('op:vendor_finance:project_ledger_operate', 'op:salary_advance:accountant_decide')
       and not exists (select 1 from candidate_rows cand_dept where cand_dept.app_user_id = cur.app_user_id and cand_dept.row_layer = 'RAW_GRANT' and cand_dept.action_code = 'dept_member:ACCOUNTING')
      then 'Project accountant assignment inactive for module ops without active ACCOUNTING department membership'
      when cur.action_code in ('assignment:project_manager', 'op:vendor_finance:pm_project_view', 'op:salary_advance:pm_request', 'op:recruitment_posts:pm_manage_project')
       and exists (select 1 from candidate_rows cand_rl where cand_rl.app_user_id = cur.app_user_id and cand_rl.row_layer = 'RAW_GRANT' and cand_rl.action_code = 'recruiter_link:verified')
      then 'Non-1:1 recruiter link blocked from deriving project manager authority in candidate'
      when (cur.action_code like 'delegation:%' or cur.scope_kind like 'template_%')
      then 'Delegation blocked because grantor lost valid interval-bounded authority in candidate'
      else 'Investigate access loss before cutover'
    end::text as t0_decision_reason,
    cur.row_layer, cur.module_code, cur.action_code, cur.scope_kind, cur.scope_ref,
    cur.grant_source as curr_grant_source, null::text as cand_grant_source,
    (cur.valid_from || '..' || cur.valid_to)::text as curr_valid_window, null::text as cand_valid_window,
    cur.reconstructibility
  from current_rows cur
  where not exists (
    select 1 from candidate_rows cand
    where cand.app_user_id = cur.app_user_id and cand.row_layer = cur.row_layer and cand.module_code = cur.module_code
      and cand.action_code = cur.action_code and cand.scope_kind = cur.scope_kind and cand.scope_ref = cur.scope_ref
  )
),
gained_rows as (
  select
    cand.as_of_ts,
    cand.as_of_date,
    cand.app_user_id,
    (left(cand.app_user_id::text, 8) || '...')::text as account_id_mask,
    'GAINED_IN_CANDIDATE'::text as diff_status,
    case
      when cand.row_layer = 'MODULE_OP' and cand.module_code = 'dashboard' and cand.action_code = 'op:dashboard:view_general' and cand.scope_kind in ('team', 'recruited')
       and exists (select 1 from current_rows cur_all where cur_all.app_user_id = cand.app_user_id and cur_all.row_layer = 'MODULE_OP' and cur_all.action_code = 'op:dashboard:view_general' and cur_all.scope_kind = 'all')
      then 'EXPECTED_FIX_DASHBOARD_FALLBACK_AFTER_INVALID_ALL_SCOPE'
      else 'UNEXPECTED_WIDENING_CHECK_REQUIRED'
    end::text as diff_classification,
    case
      when cand.row_layer = 'MODULE_OP' and cand.module_code = 'dashboard' and cand.action_code = 'op:dashboard:view_general' and cand.scope_kind in ('team', 'recruited')
       and exists (select 1 from current_rows cur_all where cur_all.app_user_id = cand.app_user_id and cur_all.row_layer = 'MODULE_OP' and cur_all.action_code = 'op:dashboard:view_general' and cur_all.scope_kind = 'all')
      then 'Dropping invalid/unpaired all-scope Dashboard access restores legitimate narrow team/recruited Dashboard scope'
      else 'Candidate grants access not present in current runtime snapshot'
    end::text as t0_decision_reason,
    cand.row_layer, cand.module_code, cand.action_code, cand.scope_kind, cand.scope_ref,
    null::text as curr_grant_source, cand.grant_source as cand_grant_source,
    null::text as curr_valid_window, (cand.valid_from || '..' || cand.valid_to)::text as cand_valid_window,
    cand.reconstructibility
  from candidate_rows cand
  where not exists (
    select 1 from current_rows cur
    where cur.app_user_id = cand.app_user_id and cur.row_layer = cand.row_layer and cur.module_code = cand.module_code
      and cur.action_code = cand.action_code and cur.scope_kind = cand.scope_kind and cur.scope_ref = cand.scope_ref
  )
)
select *
from (select * from lost_rows union all select * from gained_rows) all_diffs
order by diff_classification, module_code, row_layer, app_user_id, action_code, scope_kind, scope_ref;
