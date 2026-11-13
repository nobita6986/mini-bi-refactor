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
    pg_catalog.transaction_timestamp() as current_ts,
    (coalesce(nullif(current_setting('wp2a.as_of_ts', true), '')::timestamptz, pg_catalog.transaction_timestamp()) at time zone 'Asia/Ho_Chi_Minh')::date as as_of_date,
    (pg_catalog.transaction_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date as current_bkk_date,
    nullif(current_setting('wp2a.app_user_id', true), '')::uuid as target_app_user_id
),
eligible_users as materialized (
  select
    p.as_of_ts,
    p.current_ts,
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
      when u.as_of_ts < pg_catalog.transaction_timestamp()
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
      when u.as_of_ts < pg_catalog.transaction_timestamp()
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
      when u.as_of_ts < pg_catalog.transaction_timestamp()
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
      when u.as_of_ts < pg_catalog.transaction_timestamp()
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
      when u.as_of_ts < pg_catalog.transaction_timestamp()
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
      when u.as_of_ts < pg_catalog.transaction_timestamp()
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
      when u.as_of_ts < pg_catalog.transaction_timestamp()
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
      when u.as_of_ts < pg_catalog.transaction_timestamp()
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
      when u.as_of_ts < pg_catalog.transaction_timestamp()
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
      when u.as_of_ts < pg_catalog.transaction_timestamp()
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
      exists (
        select 1
        from curr_full_admin_users fa
        where fa.app_user_id = u.app_user_id
      )
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
      when u.as_of_ts < pg_catalog.transaction_timestamp()
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
        and exists (
          select 1
          from public.teams tm
          where tm.team_id = wrd.scope_team_id
            and tm.active = true
        )
        and (
          exists (
            select 1
            from curr_r1_scopes dsg
            where dsg.app_user_id = u.app_user_id
              and dsg.scope_kind = 'team'
              and dsg.scope_ref = wrd.scope_team_id::text
          )
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
        and (
          ga_del.scope_kind = 'all'
          or (wrd.scope_kind = 'team' and ga_del.scope_kind = 'team' and ga_del.scope_ref = wrd.scope_team_id::text)
        )
    )
    and exists (
      select 1
      from curr_grantor_work_report_authority ga_cap
      where ga_cap.grantor_user_id = wrd.grantor_user_id
        and ga_cap.capability = wrd.capability
        and (
          ga_cap.scope_kind = 'all'
          or (wrd.scope_kind = 'team' and ga_cap.scope_kind = 'team' and ga_cap.scope_ref = wrd.scope_team_id::text)
        )
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
  union all
  select * from curr_r1_scopes
  union all
  select * from curr_recruiter_links
  union all
  select * from curr_team_leader_assignments
  union all
  select * from curr_project_manager_assignments
  union all
  select * from curr_org_dept_memberships
  union all
  select * from curr_leave_grants
  union all
  select * from curr_vendor_finance_grants
  union all
  select * from curr_work_report_delegations
),
curr_module_ops_raw as (
  -- 1a/1b/1c. Legacy Dashboard widening: any curr_r1_scopes(all) unlocks all 3 Dashboard ops in current baseline
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'dashboard'::text as module_code,
    op.action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    op.grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
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
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'dashboard'::text as module_code,
    'op:dashboard:view_general'::text as action_code,
    'team'::text as scope_kind,
    s.scope_ref,
    'derived:direct_entry_reporting_resolve_audience'::text as grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from curr_r1_scopes s
  where s.scope_kind = 'team'
    and not exists (
      select 1
      from curr_r1_scopes s_all
      where s_all.app_user_id = s.app_user_id
        and s_all.scope_kind = 'all'
    )

  union all

  select
    rl.as_of_ts,
    rl.as_of_date,
    rl.app_user_id,
    rl.user_created_date,
    'MODULE_OP'::text as row_layer,
    'dashboard'::text as module_code,
    'op:dashboard:view_general'::text as action_code,
    'recruited'::text as scope_kind,
    rl.scope_ref,
    'derived:direct_entry_reporting_resolve_audience'::text as grant_source,
    rl.valid_from,
    rl.valid_to,
    rl.reconstructibility
  from curr_recruiter_links rl
  where (
    select count(*)
    from curr_recruiter_links rl2
    where rl2.app_user_id = rl.app_user_id
  ) = 1
    and not exists (
    select 1
    from curr_r1_scopes s_other
    where s_other.app_user_id = rl.app_user_id
      and s_other.scope_kind in ('all', 'team')
  )

  union all

  -- 2. Workforce Offboarding (`all` = Full Admin or BoD entry_privileged_edit; `team` = canonical Team Leader)
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'workforce'::text as module_code,
    'op:workforce:offboarding_view'::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:direct_entry_offboarding_authority'::text as grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from curr_r1_scopes s
  where s.scope_kind = 'all'
    and (
      exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or exists (select 1 from curr_full_admin_users fa where fa.app_user_id = s.app_user_id)
    )

  union all

  select
    tla.as_of_ts,
    tla.as_of_date,
    tla.app_user_id,
    tla.user_created_date,
    'MODULE_OP'::text as row_layer,
    'workforce'::text as module_code,
    'op:workforce:offboarding_view'::text as action_code,
    'team'::text as scope_kind,
    tla.scope_ref,
    'derived:direct_entry_offboarding_authority'::text as grant_source,
    tla.valid_from,
    tla.valid_to,
    case
      when s.reconstructibility <> 'POINT_IN_TIME_CURRENT' then s.reconstructibility
      else tla.reconstructibility
    end as reconstructibility
  from curr_team_leader_assignments tla
  join curr_r1_scopes s
    on s.app_user_id = tla.app_user_id
   and s.scope_kind = 'team'
   and s.scope_ref = tla.scope_ref
  where exists (select 1 from curr_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:team_manager_assign')
    and not exists (
      select 1
      from curr_r1_scopes s_all
      where s_all.app_user_id = tla.app_user_id
        and s_all.scope_kind = 'all'
        and (
          exists (select 1 from curr_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:entry_privileged_edit')
          or exists (select 1 from curr_full_admin_users fa where fa.app_user_id = tla.app_user_id)
        )
    )

  union all

  -- 3. Direct Entry Workers All Tab
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'direct_entry'::text as module_code,
    'op:direct_entry:workers_all_tab'::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:direct_entry_submission_list_all_read'::text as grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from curr_r1_scopes s
  where s.scope_kind = 'all'
    and exists (
      select 1
      from curr_r1_capabilities c
      where c.app_user_id = s.app_user_id
        and c.action_code in ('cap:entry_admin', 'cap:change_review')
    )

  union all

  -- 4. Attendance Report
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'attendance'::text as module_code,
    'op:attendance:report_view'::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:attendance__internal_assert_report_reader'::text as grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from curr_r1_scopes s
  where s.scope_kind = 'all'
    and (
      exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or exists (select 1 from curr_full_admin_users fa where fa.app_user_id = s.app_user_id)
      or (
        exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view')
        and exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view')
      )
    )

  union all

  select
    tla.as_of_ts,
    tla.as_of_date,
    tla.app_user_id,
    tla.user_created_date,
    'MODULE_OP'::text as row_layer,
    'attendance'::text as module_code,
    'op:attendance:report_view'::text as action_code,
    'team'::text as scope_kind,
    tla.scope_ref,
    'derived:attendance__internal_resolve_report_scope'::text as grant_source,
    tla.valid_from,
    tla.valid_to,
    tla.reconstructibility
  from curr_team_leader_assignments tla
  join curr_r1_scopes s
    on s.app_user_id = tla.app_user_id
   and s.scope_kind = 'team'
   and s.scope_ref = tla.scope_ref
  where exists (select 1 from curr_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:team_manager_assign')
    and exists (select 1 from curr_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_view')
    and exists (select 1 from curr_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_analytics_view')
    and not exists (
      select 1
      from curr_r1_scopes s_all
      where s_all.app_user_id = tla.app_user_id
        and s_all.scope_kind = 'all'
        and (
          exists (select 1 from curr_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:entry_privileged_edit')
          or exists (select 1 from curr_full_admin_users fa where fa.app_user_id = tla.app_user_id)
          or (
            exists (select 1 from curr_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_view')
            and exists (select 1 from curr_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_analytics_view')
          )
        )
    )

  union all

  -- 5. Leave (current snapshot does not filter shared-service flag on explicit grants/TL rows)
  select
    lg.as_of_ts,
    lg.as_of_date,
    lg.app_user_id,
    lg.user_created_date,
    'MODULE_OP'::text as row_layer,
    'leave'::text as module_code,
    'op:leave:approve_department'::text as action_code,
    lg.scope_kind,
    lg.scope_ref,
    'derived:leave_can_approve_department'::text as grant_source,
    lg.valid_from,
    lg.valid_to,
    lg.reconstructibility
  from curr_leave_grants lg
  where lg.action_code like 'department_approver:%'

  union all

  select
    tla.as_of_ts,
    tla.as_of_date,
    tla.app_user_id,
    tla.user_created_date,
    'MODULE_OP'::text as row_layer,
    'leave'::text as module_code,
    'op:leave:approve_team'::text as action_code,
    'team'::text as scope_kind,
    tla.scope_ref,
    'derived:leave_can_approve_recruitment_team'::text as grant_source,
    tla.valid_from,
    tla.valid_to,
    tla.reconstructibility
  from curr_team_leader_assignments tla

  union all

  select
    lg.as_of_ts,
    lg.as_of_date,
    lg.app_user_id,
    lg.user_created_date,
    'MODULE_OP'::text as row_layer,
    'leave'::text as module_code,
    ('op:leave:hr_grant_' || replace(lg.action_code, 'leave_role:', ''))::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:leave_user_has_any_role'::text as grant_source,
    lg.valid_from,
    lg.valid_to,
    lg.reconstructibility
  from curr_leave_grants lg
  where lg.action_code like 'leave_role:%'

  union all

  -- 6. Vendor Finance & Salary Advance & Recruitment Posts PM
  select
    vf.as_of_ts,
    vf.as_of_date,
    vf.app_user_id,
    vf.user_created_date,
    'MODULE_OP'::text as row_layer,
    op.module_code,
    op.action_code,
    'project'::text as scope_kind,
    vf.scope_ref,
    'derived:vendor_finance_project_accountants'::text as grant_source,
    vf.valid_from,
    vf.valid_to,
    vf.reconstructibility
  from curr_vendor_finance_grants vf
  cross join (
    values
      ('vendor_finance', 'op:vendor_finance:project_ledger_operate'),
      ('salary_advance', 'op:salary_advance:accountant_decide')
  ) as op(module_code, action_code)
  where vf.action_code = 'vfin_project_accountant'

  union all

  select
    vf.as_of_ts,
    vf.as_of_date,
    vf.app_user_id,
    vf.user_created_date,
    'MODULE_OP'::text as row_layer,
    'vendor_finance'::text as module_code,
    ('op:vendor_finance:global_' || replace(vf.action_code, 'vfin_role:', ''))::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:vendor_finance_global_roles'::text as grant_source,
    vf.valid_from,
    vf.valid_to,
    vf.reconstructibility
  from curr_vendor_finance_grants vf
  where vf.action_code like 'vfin_role:%'

  union all

  select
    pma.as_of_ts,
    pma.as_of_date,
    pma.app_user_id,
    pma.user_created_date,
    'MODULE_OP'::text as row_layer,
    op.module_code,
    op.action_code,
    'project'::text as scope_kind,
    pma.scope_ref,
    'derived:project_manager_assignments'::text as grant_source,
    pma.valid_from,
    pma.valid_to,
    pma.reconstructibility
  from curr_project_manager_assignments pma
  cross join (
    values
      ('vendor_finance', 'op:vendor_finance:pm_project_view'),
      ('salary_advance', 'op:salary_advance:pm_request'),
      ('recruitment_posts', 'op:recruitment_posts:pm_manage_project')
  ) as op(module_code, action_code)

  union all

  -- 7. Work Reports
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'work_reports'::text as module_code,
    ('op:work_reports:' || replace(caps.cap_name, 'report_', ''))::text as action_code,
    s.scope_kind,
    s.scope_ref,
    ('derived:work_report_direct_' || replace(caps.cap_name, 'report_', ''))::text as grant_source,
    coalesce(
      (
        select greatest(s.valid_from::date, c.valid_from::date)::text
        from curr_r1_capabilities c
        where c.app_user_id = s.app_user_id
          and c.action_code = ('cap:' || caps.cap_name)
      ),
      (
        select greatest(s.valid_from::date, fa.valid_from_date)::text
        from curr_full_admin_users fa
        where fa.app_user_id = s.app_user_id
      )
    ) as valid_from,
    coalesce(
      (
        select
          case
            when least(
              case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end,
              case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end
            ) = '9999-12-31'::date then 'infinity'
            else least(
              case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end,
              case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end
            )::text
          end
        from curr_r1_capabilities c
        where c.app_user_id = s.app_user_id
          and c.action_code = ('cap:' || caps.cap_name)
      ),
      s.valid_to
    ) as valid_to,
    s.reconstructibility
  from curr_r1_scopes s
  cross join (values ('report_review'), ('report_assign')) as caps(cap_name)
  where s.scope_kind in ('all', 'team')
    and (
      exists (
        select 1
        from curr_r1_capabilities c
        where c.app_user_id = s.app_user_id
          and c.action_code = ('cap:' || caps.cap_name)
      )
      or (
        exists (select 1 from curr_full_admin_users fa where fa.app_user_id = s.app_user_id)
        and not exists (
          select 1
          from public.direct_entry_capability_grants g_rev
          where g_rev.app_user_id = s.app_user_id
            and g_rev.capability = caps.cap_name
            and g_rev.is_current = false
        )
      )
    )

  union all

  select
    wrd.as_of_ts,
    wrd.as_of_date,
    wrd.app_user_id,
    wrd.user_created_date,
    'MODULE_OP'::text as row_layer,
    'work_reports'::text as module_code,
    ('op:work_reports:' || replace(wrd.action_code, 'delegation:report_', ''))::text as action_code,
    wrd.scope_kind,
    wrd.scope_ref,
    'derived:work_report_delegations'::text as grant_source,
    wrd.valid_from,
    wrd.valid_to,
    wrd.reconstructibility
  from curr_work_report_delegations wrd

  union all

  -- 8. Admin & Catalog & Location Catalog & Recruitment Posts & Audit & History & Duplicate CCCD
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'admin'::text as module_code,
    'op:admin:catalog_manage'::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:direct_entry_assert_catalog_operator+catalogOperatorNavPredicate(scope=all+cap)'::text as grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from curr_r1_scopes s
  where s.scope_kind = 'all'
    and (
      exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:catalog_master_manage')
      or exists (select 1 from curr_full_admin_users fa where fa.app_user_id = s.app_user_id)
    )

  union all

  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    op.module_code,
    op.action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    op.grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from curr_r1_scopes s
  cross join (
    values
      ('admin', 'op:admin:location_catalog_manage', 'derived:recruitment_location_is_admin_or_bod'),
      ('recruitment_posts', 'op:recruitment_posts:admin_or_bod_manage', 'derived:recruitment_location_is_admin_or_bod')
  ) as op(module_code, action_code, grant_source)
  where s.scope_kind = 'all'
    and (
      exists (select 1 from curr_full_admin_users fa where fa.app_user_id = s.app_user_id)
      or exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or (
        exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view')
        and exists (select 1 from curr_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view')
      )
    )

  union all

  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'admin'::text as module_code,
    'op:admin:account_and_dept_admin'::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:full_admin_triple_plus_all_scope'::text as grant_source,
    greatest(s.valid_from::date, fa.valid_from_date)::text as valid_from,
    s.valid_to,
    s.reconstructibility
  from curr_r1_scopes s
  join curr_full_admin_users fa
    on fa.app_user_id = s.app_user_id
  where s.scope_kind = 'all'

  union all

  select
    c.as_of_ts,
    c.as_of_date,
    c.app_user_id,
    c.user_created_date,
    'MODULE_OP'::text as row_layer,
    op.module_code,
    op.action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    op.grant_source,
    greatest(c.valid_from::date, s.valid_from::date)::text as valid_from,
    case
      when least(
        case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end,
        case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end
      ) = '9999-12-31'::date then 'infinity'
      else least(
        case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end,
        case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end
      )::text
    end as valid_to,
    case when c.reconstructibility <> 'POINT_IN_TIME_CURRENT' then c.reconstructibility else s.reconstructibility end as reconstructibility
  from curr_r1_capabilities c
  join curr_r1_scopes s
    on s.app_user_id = c.app_user_id
   and s.scope_kind = 'all'
  join (
    values
      ('cap:audit_view', 'admin', 'op:admin:audit_view', 'derived:audit_log_assert_reader'),
      ('cap:worker_edit_history_view', 'admin', 'op:admin:worker_edit_history_view', 'derived:worker_edit_history_assert_actor'),
      ('cap:duplicate_cccd_withdraw', 'direct_entry', 'op:direct_entry:duplicate_cccd_withdraw', 'derived:direct_entry_withdraw_duplicate_cccd')
  ) as op(req_cap, module_code, action_code, grant_source)
    on op.req_cap = c.action_code
),
current_rows as materialized (
  select
    as_of_ts,
    as_of_date,
    app_user_id,
    user_created_date,
    row_layer,
    module_code,
    action_code,
    scope_kind,
    scope_ref,
    min(grant_source) as grant_source,
    min(valid_from) as valid_from,
    max(valid_to) as valid_to,
    min(reconstructibility) as reconstructibility
  from (
    select * from curr_raw_grants
    union all
    select * from curr_module_ops_raw
  ) combined
  where ((select target_app_user_id from params) is null or app_user_id = (select target_app_user_id from params))
  group by
    as_of_ts,
    as_of_date,
    app_user_id,
    user_created_date,
    row_layer,
    module_code,
    action_code,
    scope_kind,
    scope_ref
),
-- =============================================================================
-- PART B: CANDIDATE RESOLVER
-- =============================================================================
cand_r1_capabilities as materialized (
  select
    u.as_of_ts,
    u.current_ts,
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
      when u.as_of_ts < u.current_ts
      then 'CURRENT_STATE_ONLY (LIMITATION_DATE_GRANULARITY_ONLY; no_revocation_ts; u.enabled; wiped_rows_unreconstructible)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.direct_entry_capability_grants cg
    on cg.app_user_id = u.app_user_id
  where cg.valid_from <= u.as_of_date
    and (
      (cg.created_at at time zone 'Asia/Ho_Chi_Minh')::date > cg.valid_from
      or cg.created_at <= u.as_of_ts
    )
    and (
      cg.valid_to is null
      or (cg.valid_to > cg.valid_from and u.as_of_date < cg.valid_to)
    )
    and (cg.is_current = true or cg.valid_to is not null)
  group by
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    cg.capability
),
cand_r1_scopes as materialized (
  select
    u.as_of_ts,
    u.current_ts,
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
      when u.as_of_ts < u.current_ts then
        case
          when sg.scope_kind = 'team'
          then 'CURRENT_STATE_ONLY (LIMITATION_DATE_GRANULARITY_ONLY; no_revocation_ts; u.enabled + t.active; wiped_rows_unreconstructible)'
          else 'CURRENT_STATE_ONLY (LIMITATION_DATE_GRANULARITY_ONLY; no_revocation_ts; u.enabled; wiped_rows_unreconstructible)'
        end
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.direct_entry_scope_grants sg
    on sg.app_user_id = u.app_user_id
  left join public.teams t
    on sg.scope_kind = 'team'
   and t.team_id = sg.team_id
  where sg.valid_from <= u.as_of_date
    and (
      (sg.created_at at time zone 'Asia/Ho_Chi_Minh')::date > sg.valid_from
      or sg.created_at <= u.as_of_ts
    )
    and (
      sg.valid_to is null
      or (sg.valid_to > sg.valid_from and u.as_of_date < sg.valid_to)
    )
    and (sg.is_current = true or sg.valid_to is not null)
    and (
      sg.scope_kind <> 'team'
      or (t.team_id is not null and t.active = true and t.code <> '__system_vendor__')
    )
    and (
      sg.scope_kind <> 'all'
      or exists (
        select 1
        from cand_r1_capabilities cg
        where cg.app_user_id = u.app_user_id
          and cg.action_code in (
            'cap:entry_admin',
            'cap:entry_privileged_edit',
            'cap:entry_create',
            'cap:report_view',
            'cap:report_analytics_view',
            'cap:report_review',
            'cap:report_assign',
            'cap:report_template_manage',
            'cap:report_form_manage',
            'cap:report_delegate',
            'cap:attendance_view',
            'cap:vendor_finance_view',
            'cap:vendor_finance_record',
            'cap:vendor_finance_reconcile',
            'cap:vendor_finance_admin',
            'cap:worker_edit_history_view',
            'cap:change_review',
            'cap:employment_status.review',
            'cap:employment_status.apply',
            'cap:entry_restore',
            'cap:audit_view',
            'cap:catalog_master_manage',
            'cap:duplicate_cccd_withdraw'
          )
      )
    )
  group by
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    sg.scope_kind,
    coalesce(sg.team_id::text, '*')
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
  select
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    rl.recruiter_id,
    rl.valid_from,
    rl.valid_to
  from eligible_users u
  join public.direct_entry_app_user_recruiter_links rl
    on rl.app_user_id = u.app_user_id
   and rl.verified = true
  join public.recruiters r
    on r.recruiter_id = rl.recruiter_id
   and r.active = true
  where rl.valid_from <= u.as_of_date
    and (
      (rl.created_at at time zone 'Asia/Ho_Chi_Minh')::date > rl.valid_from
      or rl.created_at <= u.as_of_ts
    )
    and (
      rl.valid_to is null
      or (rl.valid_to > rl.valid_from and u.as_of_date < rl.valid_to)
    )
    and (rl.is_current = true or rl.valid_to is not null)
),
cand_recruiter_links as materialized (
  select
    b.as_of_ts,
    b.current_ts,
    b.as_of_date,
    b.app_user_id,
    b.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'direct_entry'::text as module_code,
    'recruiter_link:verified'::text as action_code,
    'recruited'::text as scope_kind,
    b.recruiter_id::text as scope_ref,
    'direct_entry_app_user_recruiter_links'::text as grant_source,
    min(b.valid_from)::text as valid_from,
    case
      when bool_or(b.valid_to is null) then 'infinity'
      else max(b.valid_to)::text
    end as valid_to,
    case
      when b.as_of_ts < b.current_ts
      then 'CURRENT_STATE_ONLY (LIMITATION_DATE_GRANULARITY_ONLY; no_revocation_ts; u.enabled + r.active; wiped_rows_unreconstructible)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from cand_recruiter_links_base b
  group by
    b.as_of_ts,
    b.current_ts,
    b.as_of_date,
    b.current_bkk_date,
    b.app_user_id,
    b.user_created_date,
    b.recruiter_id
),
cand_unambiguous_recruiter_links as materialized (
  select
    rl.app_user_id,
    rl.recruiter_id,
    rl.valid_from::text as valid_from,
    rl.valid_to::text as valid_to
  from cand_recruiter_links_base rl
  where (
    select count(*)
    from public.direct_entry_app_user_recruiter_links all_u
    join public.recruiters ru on ru.recruiter_id = all_u.recruiter_id and ru.active = true
    where all_u.app_user_id = rl.app_user_id
      and all_u.verified = true
      and all_u.valid_from <= rl.as_of_date
      and ((all_u.created_at at time zone 'Asia/Ho_Chi_Minh')::date > all_u.valid_from or all_u.created_at <= rl.as_of_ts)
      and (all_u.valid_to is null or (all_u.valid_to > all_u.valid_from and rl.as_of_date < all_u.valid_to))
      and (all_u.is_current = true or all_u.valid_to is not null)
  ) = 1
    and (
      select count(*)
      from public.direct_entry_app_user_recruiter_links all_r
      where all_r.recruiter_id = rl.recruiter_id
        and all_r.verified = true
        and all_r.valid_from <= rl.as_of_date
        and ((all_r.created_at at time zone 'Asia/Ho_Chi_Minh')::date > all_r.valid_from or all_r.created_at <= rl.as_of_ts)
        and (all_r.valid_to is null or (all_r.valid_to > all_r.valid_from and rl.as_of_date < all_r.valid_to))
        and (all_r.is_current = true or all_r.valid_to is not null)
    ) = 1
),
cand_team_leader_assignments as materialized (
  select
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.app_user_id,
    u.user_created_date,
    'RAW_GRANT'::text as row_layer,
    'direct_entry'::text as module_code,
    'assignment:team_leader'::text as action_code,
    'team'::text as scope_kind,
    tla.team_id::text as scope_ref,
    case
      when bool_or(tl_close.close_ts is not null) then 'direct_entry_team_leader_revisions+assignments'
      else 'direct_entry_team_leader_assignments'
    end::text as grant_source,
    min(tla.valid_from)::text as valid_from,
    case
      when bool_or(tla.valid_to is null) then 'infinity'
      else max(tla.valid_to)::text
    end as valid_to,
    case
      when u.as_of_ts < u.current_ts then
        case
          when bool_or(coalesce(tl_has_rev.has_team_rev, false))
           and not bool_or(tla.valid_to is not null and tl_close.close_ts is null)
          then 'CURRENT_STATE_ONLY (INTRADAY_TS_RECONSTRUCTIBLE_VIA_TL_REVISIONS; u.enabled + t.active + r.active)'
          else 'CURRENT_STATE_ONLY (LIMITATION_DATE_GRANULARITY_ONLY; no_tl_revision_ts; u.enabled + t.active + r.active)'
        end
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join cand_unambiguous_recruiter_links url
    on url.app_user_id = u.app_user_id
  join public.direct_entry_team_leader_assignments tla
    on tla.leader_app_user_id = u.app_user_id
   and tla.leader_recruiter_id = url.recruiter_id
  join public.teams t
    on t.team_id = tla.team_id
   and t.active = true
   and t.code <> '__system_vendor__'
  left join lateral (
    select min(rev.created_at) as close_ts
    from public.direct_entry_team_leader_revisions rev
    where tla.valid_to is not null
      and rev.team_id = tla.team_id
      and rev.created_at >= tla.created_at
      and (
        (
          rev.before_snapshot->>'leader_app_user_id' = tla.leader_app_user_id::text
          and coalesce(rev.after_snapshot->>'leader_app_user_id', '') <> tla.leader_app_user_id::text
        )
        or (
          rev.after_snapshot->>'leader_app_user_id' = tla.leader_app_user_id::text
          and rev.after_snapshot->>'valid_to' is not null
        )
      )
  ) tl_close on true
  left join lateral (
    select true as has_team_rev
    from public.direct_entry_team_leader_revisions rev_any
    where rev_any.team_id = tla.team_id
    limit 1
  ) tl_has_rev on true
  where tla.valid_from <= u.as_of_date
    and (
      (tla.created_at at time zone 'Asia/Ho_Chi_Minh')::date > tla.valid_from
      or tla.created_at <= u.as_of_ts
    )
    and (
      (
        tl_close.close_ts is not null
        and u.as_of_ts < tl_close.close_ts
        and (
          (tl_close.close_ts at time zone 'Asia/Ho_Chi_Minh')::date <= tla.valid_to
          or (tla.valid_to > tla.valid_from and u.as_of_date < tla.valid_to)
        )
      )
      or (
        tl_close.close_ts is null
        and (tla.valid_to is null or (tla.valid_to > tla.valid_from and u.as_of_date < tla.valid_to))
        and (tla.is_current = true or tla.valid_to is not null)
      )
    )
  group by
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    tla.team_id
),
cand_project_manager_assignments as materialized (
  select
    u.as_of_ts,
    u.current_ts,
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
      when u.as_of_ts < u.current_ts
      then 'CURRENT_STATE_ONLY (INTRADAY_TS_RECONSTRUCTIBLE_VIA_REVOKED_AT; u.enabled + prj.active; link_date_granularity)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join cand_unambiguous_recruiter_links url
    on url.app_user_id = u.app_user_id
  join public.direct_entry_project_manager_assignments pma
    on pma.manager_recruiter_id = url.recruiter_id
  join public.direct_entry_projects prj
    on prj.project_id = pma.project_id
   and prj.active = true
  where pma.valid_from <= u.as_of_date
    and (
      (pma.created_at at time zone 'Asia/Ho_Chi_Minh')::date > pma.valid_from
      or pma.created_at <= u.as_of_ts
    )
    and (
      (pma.revoked_at is not null and u.as_of_ts < pma.revoked_at)
      or (
        pma.revoked_at is null
        and (
          pma.valid_to is null
          or (pma.valid_to > pma.valid_from and u.as_of_date < pma.valid_to)
        )
        and (pma.is_current = true or pma.valid_to is not null)
      )
    )
  group by
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    pma.project_id
),
cand_org_dept_memberships as materialized (
  select
    u.as_of_ts,
    u.current_ts,
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
      when u.as_of_ts < u.current_ts
      then 'CURRENT_STATE_ONLY (INTRADAY_TS_RECONSTRUCTIBLE_VIA_REVOKED_AT; u.enabled + od.is_active)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.organization_department_memberships odm
    on odm.app_user_id = u.app_user_id
  join public.organization_departments od
    on od.department_id = odm.department_id
   and od.is_active = true
  where odm.valid_from <= u.as_of_date
    and (
      (odm.created_at at time zone 'Asia/Ho_Chi_Minh')::date > odm.valid_from
      or odm.created_at <= u.as_of_ts
    )
    and (
      (odm.revoked_at is not null and u.as_of_ts < odm.revoked_at)
      or (
        odm.revoked_at is null
        and (
          odm.valid_to is null
          or (odm.valid_to > odm.valid_from and u.as_of_date < odm.valid_to)
        )
      )
    )
  group by
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    od.code,
    odm.department_id
),
cand_leave_grants as materialized (
  select
    u.as_of_ts,
    u.current_ts,
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
      when u.as_of_ts < u.current_ts then
        case
          when bool_or(
            lmg.is_current = false
            and coalesce(rev_ev.audit_revoke_ts, case when lmg.valid_to is not null and lmg.updated_at is not null and (lmg.updated_at at time zone 'Asia/Ho_Chi_Minh')::date <= lmg.valid_to then lmg.updated_at else null end) is null
          )
          then 'CURRENT_STATE_ONLY (LIMITATION_DATE_GRANULARITY_ONLY; missing_leave_revoke_ts; u.enabled)'
          else 'CURRENT_STATE_ONLY (INTRADAY_TS_RECONSTRUCTIBLE_VIA_LEAVE_AUDIT_OR_UPDATED_AT; u.enabled)'
        end
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.leave_module_grants lmg
    on lmg.app_user_id = u.app_user_id
  left join lateral (
    select max(lae.created_at) as audit_revoke_ts
    from public.leave_audit_events lae
    where lae.event_type = 'MODULE_GRANT_REVOKE'
      and lae.payload->>'grant_id' = lmg.grant_id::text
  ) rev_ev on true
  where lmg.valid_from <= u.as_of_date
    and (
      (lmg.created_at at time zone 'Asia/Ho_Chi_Minh')::date > lmg.valid_from
      or lmg.created_at <= u.as_of_ts
    )
    and (
      lmg.is_current = true
      or (
        coalesce(
          rev_ev.audit_revoke_ts,
          case
            when lmg.valid_to is not null
             and lmg.updated_at is not null
             and (lmg.updated_at at time zone 'Asia/Ho_Chi_Minh')::date <= lmg.valid_to
            then lmg.updated_at
            else null
          end
        ) is not null
        and u.as_of_ts < coalesce(
          rev_ev.audit_revoke_ts,
          lmg.updated_at
        )
      )
      or (
        rev_ev.audit_revoke_ts is null
        and (
          lmg.updated_at is null
          or lmg.valid_to is null
          or (lmg.updated_at at time zone 'Asia/Ho_Chi_Minh')::date > lmg.valid_to
        )
        and lmg.valid_to is not null
        and lmg.valid_to > lmg.valid_from
        and u.as_of_date < lmg.valid_to
      )
    )
  group by
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    lmg.role_code

  union all

  select
    u.as_of_ts,
    u.current_ts,
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
      when u.as_of_ts < u.current_ts then
        case
          when bool_or(
            lda.is_current = false
            and not (
              lda.valid_to is not null
              and lda.updated_at is not null
              and (lda.updated_at at time zone 'Asia/Ho_Chi_Minh')::date = lda.valid_to
            )
          )
          then 'CURRENT_STATE_ONLY (LIMITATION_DATE_GRANULARITY_ONLY; missing_approver_close_ts; u.enabled)'
          else 'CURRENT_STATE_ONLY (INTRADAY_TS_RECONSTRUCTIBLE_VIA_UPDATED_AT; u.enabled)'
        end
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.leave_department_approvers lda
    on lda.approver_app_user_id = u.app_user_id
  where lda.valid_from <= u.as_of_date
    and (
      (lda.created_at at time zone 'Asia/Ho_Chi_Minh')::date > lda.valid_from
      or lda.created_at <= u.as_of_ts
    )
    and (
      (
        lda.is_current = false
        and lda.valid_to is not null
        and lda.updated_at is not null
        and (lda.updated_at at time zone 'Asia/Ho_Chi_Minh')::date = lda.valid_to
        and u.as_of_ts < lda.updated_at
      )
      or (
        not (
          lda.is_current = false
          and lda.valid_to is not null
          and lda.updated_at is not null
          and (lda.updated_at at time zone 'Asia/Ho_Chi_Minh')::date = lda.valid_to
        )
        and (
          lda.valid_to is null
          or (lda.valid_to > lda.valid_from and u.as_of_date < lda.valid_to)
        )
        and (lda.is_current = true or lda.valid_to is not null)
      )
    )
  group by
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    lda.unit_kind
),
cand_vendor_finance_grants as materialized (
  select
    u.as_of_ts,
    u.current_ts,
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
      when u.as_of_ts < u.current_ts
      then 'CURRENT_STATE_ONLY (INTRADAY_TS_RECONSTRUCTIBLE_VIA_ENDED_AT; u.enabled)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.vendor_finance_global_roles vfgr
    on vfgr.app_user_id = u.app_user_id
  where vfgr.valid_from <= u.as_of_date
    and (
      (vfgr.created_at at time zone 'Asia/Ho_Chi_Minh')::date > vfgr.valid_from
      or vfgr.created_at <= u.as_of_ts
    )
    and (
      (vfgr.ended_at is not null and u.as_of_ts < vfgr.ended_at)
      or (
        vfgr.ended_at is null
        and (
          vfgr.valid_to is null
          or (vfgr.valid_to > vfgr.valid_from and u.as_of_date < vfgr.valid_to)
        )
      )
    )
  group by
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    vfgr.role_code

  union all

  select
    u.as_of_ts,
    u.current_ts,
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
      when u.as_of_ts < u.current_ts
      then 'CURRENT_STATE_ONLY (INTRADAY_TS_RECONSTRUCTIBLE_VIA_ENDED_AT; u.enabled + prj.active)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.vendor_finance_project_accountants vfpa
    on vfpa.accountant_user_id = u.app_user_id
  join public.direct_entry_projects prj
    on prj.project_id = vfpa.project_id
   and prj.active = true
  where vfpa.valid_from <= u.as_of_date
    and (
      (vfpa.created_at at time zone 'Asia/Ho_Chi_Minh')::date > vfpa.valid_from
      or vfpa.created_at <= u.as_of_ts
    )
    and (
      (vfpa.ended_at is not null and u.as_of_ts < vfpa.ended_at)
      or (
        vfpa.ended_at is null
        and (
          vfpa.valid_to is null
          or (vfpa.valid_to > vfpa.valid_from and u.as_of_date < vfpa.valid_to)
        )
      )
    )
  group by
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    vfpa.project_id
),
cand_grantor_work_report_authority as materialized (
  select
    u.app_user_id as grantor_user_id,
    caps.capability,
    s.scope_kind,
    case when s.scope_kind = 'team' then s.scope_ref else '*' end as scope_ref
  from eligible_users u
  cross join (values ('report_delegate'), ('report_assign'), ('report_review')) as caps(capability)
  join cand_r1_scopes s
    on s.app_user_id = u.app_user_id
   and s.scope_kind in ('all', 'team')
  where (
    exists (
      select 1
      from cand_r1_capabilities c
      where c.app_user_id = u.app_user_id
        and c.action_code = ('cap:' || caps.capability)
    )
    or (
      exists (
        select 1
        from cand_full_admin_users fa
        where fa.app_user_id = u.app_user_id
      )
      and not exists (
        select 1
        from public.direct_entry_capability_grants g_rev
        where g_rev.app_user_id = u.app_user_id
          and g_rev.capability = caps.capability
          and g_rev.is_current = false
          and (g_rev.valid_to is null or g_rev.valid_to <= u.as_of_date)
      )
    )
  )
),
cand_work_report_delegations as materialized (
  select
    u.as_of_ts,
    u.current_ts,
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
      when u.as_of_ts < u.current_ts
      then 'CURRENT_STATE_ONLY (INTRADAY_TS_RECONSTRUCTIBLE_VIA_EFFECTIVE_REVOKED_AT; u.enabled + gu.enabled + wt.status)'
      else 'POINT_IN_TIME_CURRENT'
    end::text as reconstructibility
  from eligible_users u
  join public.work_report_delegations wrd
    on wrd.delegate_app_user_id = u.app_user_id
  join eligible_users gu
    on gu.app_user_id = wrd.grantor_user_id
  join public.work_report_templates wt
    on wt.template_id = wrd.template_id
   and wt.status = 'ACTIVE'
   and wt.current_published_version_id is not null
  where wrd.effective_from <= u.as_of_ts
    and (wrd.effective_to is null or u.as_of_ts <= wrd.effective_to)
    and (
      (wrd.revoked_at is null and wrd.state = 'ACTIVE' and wrd.is_current = true)
      or (wrd.revoked_at is not null and u.as_of_ts < wrd.revoked_at)
    )
    and (
      wrd.scope_kind = 'all'
      or (
        wrd.scope_kind = 'team'
        and exists (
          select 1
          from public.teams tm
          where tm.team_id = wrd.scope_team_id
            and tm.active = true
            and tm.code <> '__system_vendor__'
        )
        and (
          exists (
            select 1
            from cand_r1_scopes dsg
            where dsg.app_user_id = u.app_user_id
              and dsg.scope_kind = 'team'
              and dsg.scope_ref = wrd.scope_team_id::text
          )
          or exists (
            select 1
            from cand_unambiguous_recruiter_links url
            join public.recruiter_team_memberships rtm
              on rtm.recruiter_id = url.recruiter_id
             and rtm.team_id = wrd.scope_team_id
            where url.app_user_id = u.app_user_id
              and rtm.valid_from <= u.as_of_date
              and (rtm.valid_to is null or (rtm.valid_to > rtm.valid_from and u.as_of_date < rtm.valid_to))
              and (rtm.is_current = true or rtm.valid_to is not null)
          )
        )
      )
    )
    and exists (
      select 1
      from cand_grantor_work_report_authority ga_del
      where ga_del.grantor_user_id = wrd.grantor_user_id
        and ga_del.capability = 'report_delegate'
        and (
          ga_del.scope_kind = 'all'
          or (wrd.scope_kind = 'team' and ga_del.scope_kind = 'team' and ga_del.scope_ref = wrd.scope_team_id::text)
        )
    )
    and exists (
      select 1
      from cand_grantor_work_report_authority ga_cap
      where ga_cap.grantor_user_id = wrd.grantor_user_id
        and ga_cap.capability = wrd.capability
        and (
          ga_cap.scope_kind = 'all'
          or (wrd.scope_kind = 'team' and ga_cap.scope_kind = 'team' and ga_cap.scope_ref = wrd.scope_team_id::text)
        )
    )
  group by
    u.as_of_ts,
    u.current_ts,
    u.as_of_date,
    u.current_bkk_date,
    u.app_user_id,
    u.user_created_date,
    wrd.capability,
    wrd.scope_kind,
    (wrd.template_id::text || ':' || coalesce(wrd.scope_team_id::text, '*'))
),
cand_raw_grants as (
  select as_of_ts, as_of_date, app_user_id, user_created_date, row_layer, module_code, action_code, scope_kind, scope_ref, grant_source, valid_from, valid_to, reconstructibility from cand_r1_capabilities
  union all
  select as_of_ts, as_of_date, app_user_id, user_created_date, row_layer, module_code, action_code, scope_kind, scope_ref, grant_source, valid_from, valid_to, reconstructibility from cand_r1_scopes
  union all
  select as_of_ts, as_of_date, app_user_id, user_created_date, row_layer, module_code, action_code, scope_kind, scope_ref, grant_source, valid_from, valid_to, reconstructibility from cand_recruiter_links
  union all
  select as_of_ts, as_of_date, app_user_id, user_created_date, row_layer, module_code, action_code, scope_kind, scope_ref, grant_source, valid_from, valid_to, reconstructibility from cand_team_leader_assignments
  union all
  select as_of_ts, as_of_date, app_user_id, user_created_date, row_layer, module_code, action_code, scope_kind, scope_ref, grant_source, valid_from, valid_to, reconstructibility from cand_project_manager_assignments
  union all
  select as_of_ts, as_of_date, app_user_id, user_created_date, row_layer, module_code, action_code, scope_kind, scope_ref, grant_source, valid_from, valid_to, reconstructibility from cand_org_dept_memberships
  union all
  select as_of_ts, as_of_date, app_user_id, user_created_date, row_layer, module_code, action_code, scope_kind, scope_ref, grant_source, valid_from, valid_to, reconstructibility from cand_leave_grants
  union all
  select as_of_ts, as_of_date, app_user_id, user_created_date, row_layer, module_code, action_code, scope_kind, scope_ref, grant_source, valid_from, valid_to, reconstructibility from cand_vendor_finance_grants
  union all
  select as_of_ts, as_of_date, app_user_id, user_created_date, row_layer, module_code, action_code, scope_kind, scope_ref, grant_source, valid_from, valid_to, reconstructibility from cand_work_report_delegations
),
cand_module_ops_raw as (
  -- 1a. Dashboard General Report (`all:*`)
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'dashboard'::text as module_code,
    'op:dashboard:view_general'::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:direct_entry_reporting_resolve_audience+direct_entry_reporting_scoped_facts+direct_entry_workforce_reporting_scoped(overview)'::text as grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'all'
    and (
      exists (
        select 1
        from cand_r1_capabilities c
        where c.app_user_id = s.app_user_id
          and c.action_code in ('cap:report_view', 'cap:entry_privileged_edit')
      )
      or exists (
        select 1
        from cand_full_admin_users fa
        where fa.app_user_id = s.app_user_id
      )
    )

  union all

  -- 1b/1c. Dashboard Deep Workforce + Detailed Matrix (`all:*`)
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'dashboard'::text as module_code,
    op.action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    op.grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from cand_r1_scopes s
  cross join (
    values
      ('op:dashboard:view_workforce_deep', 'derived:canViewDeepWorkforceReport+direct_entry_workforce_reporting_scoped(deep|project_page)'),
      ('op:dashboard:view_detailed_matrix', 'derived:canViewDeepWorkforceReport+direct_entry_reporting_detailed_matrix_catalog+direct_entry_reporting_team_drill_down')
  ) as op(action_code, grant_source)
  where s.scope_kind = 'all'
    and (
      (
        exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view')
        and exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view')
      )
      or exists (
        select 1
        from cand_r1_capabilities c
        where c.app_user_id = s.app_user_id
          and c.action_code = 'cap:entry_privileged_edit'
      )
      or exists (
        select 1
        from cand_full_admin_users fa
        where fa.app_user_id = s.app_user_id
      )
    )

  union all

  -- 1d. Dashboard Team General Report (`team:<id>`)
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'dashboard'::text as module_code,
    'op:dashboard:view_general'::text as action_code,
    'team'::text as scope_kind,
    s.scope_ref,
    'derived:direct_entry_reporting_resolve_audience'::text as grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'team'
    and (
      exists (
        select 1
        from cand_r1_capabilities c
        where c.app_user_id = s.app_user_id
          and c.action_code in ('cap:entry_team', 'cap:report_view', 'cap:entry_privileged_edit')
      )
      or exists (
        select 1
        from cand_full_admin_users fa
        where fa.app_user_id = s.app_user_id
      )
    )
    and not exists (
      select 1
      from cand_r1_scopes s_all
      where s_all.app_user_id = s.app_user_id
        and s_all.scope_kind = 'all'
        and (
          exists (
            select 1
            from cand_r1_capabilities c_all
            where c_all.app_user_id = s_all.app_user_id
              and c_all.action_code in ('cap:report_view', 'cap:entry_privileged_edit')
          )
          or exists (
            select 1
            from cand_full_admin_users fa
            where fa.app_user_id = s_all.app_user_id
          )
        )
    )

  union all

  -- 1e. Dashboard Recruited/Own General Report (`recruited:<recruiter_id>`)
  -- Requires verified 1:1 recruiter link AND explicit reporting/own capability; falls back cleanly after invalid all/team
  select
    rl.as_of_ts,
    rl.as_of_date,
    rl.app_user_id,
    rl.user_created_date,
    'MODULE_OP'::text as row_layer,
    'dashboard'::text as module_code,
    'op:dashboard:view_general'::text as action_code,
    'recruited'::text as scope_kind,
    rl.scope_ref,
    'derived:direct_entry_reporting_resolve_audience'::text as grant_source,
    rl.valid_from,
    rl.valid_to,
    rl.reconstructibility
  from cand_recruiter_links rl
  join cand_unambiguous_recruiter_links url
    on url.app_user_id = rl.app_user_id
   and url.recruiter_id::text = rl.scope_ref
  where (
    exists (
      select 1
      from cand_r1_capabilities c
      where c.app_user_id = rl.app_user_id
        and c.action_code in ('cap:entry_own', 'cap:report_view', 'cap:entry_privileged_edit')
    )
    or exists (
      select 1
      from cand_full_admin_users fa
      where fa.app_user_id = rl.app_user_id
    )
  )
    and not exists (
      select 1
      from cand_r1_scopes s_all
      where s_all.app_user_id = rl.app_user_id
        and s_all.scope_kind = 'all'
        and (
          exists (
            select 1
            from cand_r1_capabilities c_all
            where c_all.app_user_id = s_all.app_user_id
              and c_all.action_code in ('cap:report_view', 'cap:entry_privileged_edit')
          )
          or exists (
            select 1
            from cand_full_admin_users fa
            where fa.app_user_id = s_all.app_user_id
          )
        )
    )
    and not exists (
      select 1
      from cand_r1_scopes s_team
      where s_team.app_user_id = rl.app_user_id
        and s_team.scope_kind = 'team'
        and (
          exists (
            select 1
            from cand_r1_capabilities c_team
            where c_team.app_user_id = s_team.app_user_id
              and c_team.action_code in ('cap:entry_team', 'cap:report_view', 'cap:entry_privileged_edit')
          )
          or exists (
            select 1
            from cand_full_admin_users fa
            where fa.app_user_id = s_team.app_user_id
          )
        )
    )

  union all

  -- 2. Workforce Offboarding (`all` = Full Admin or BoD entry_privileged_edit; `team` = canonical Team Leader)
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'workforce'::text as module_code,
    'op:workforce:offboarding_view'::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:direct_entry_offboarding_authority'::text as grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'all'
    and (
      exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id)
    )

  union all

  select
    tla.as_of_ts,
    tla.as_of_date,
    tla.app_user_id,
    tla.user_created_date,
    'MODULE_OP'::text as row_layer,
    'workforce'::text as module_code,
    'op:workforce:offboarding_view'::text as action_code,
    'team'::text as scope_kind,
    tla.scope_ref,
    'derived:direct_entry_offboarding_authority'::text as grant_source,
    tla.valid_from,
    tla.valid_to,
    case
      when s.reconstructibility like 'CURRENT_STATE_ONLY (LIMITATION_%' then s.reconstructibility
      else tla.reconstructibility
    end as reconstructibility
  from cand_team_leader_assignments tla
  join cand_r1_scopes s
    on s.app_user_id = tla.app_user_id
   and s.scope_kind = 'team'
   and s.scope_ref = tla.scope_ref
  where exists (select 1 from cand_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:team_manager_assign')
    and not exists (
      select 1
      from cand_r1_scopes s_all
      where s_all.app_user_id = tla.app_user_id
        and s_all.scope_kind = 'all'
        and (
          exists (select 1 from cand_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:entry_privileged_edit')
          or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = tla.app_user_id)
        )
    )

  union all

  -- 3. Direct Entry Workers All Tab (`cap:entry_admin` or `cap:change_review` + valid `scope = 'all'`)
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'direct_entry'::text as module_code,
    'op:direct_entry:workers_all_tab'::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:direct_entry_submission_list_all_read'::text as grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'all'
    and exists (
      select 1
      from cand_r1_capabilities c
      where c.app_user_id = s.app_user_id
        and c.action_code in ('cap:entry_admin', 'cap:change_review')
    )

  union all

  -- 4. Attendance Report
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'attendance'::text as module_code,
    'op:attendance:report_view'::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:attendance__internal_assert_report_reader'::text as grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'all'
    and (
      exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id)
      or (
        exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view')
        and exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view')
      )
    )

  union all

  select
    tla.as_of_ts,
    tla.as_of_date,
    tla.app_user_id,
    tla.user_created_date,
    'MODULE_OP'::text as row_layer,
    'attendance'::text as module_code,
    'op:attendance:report_view'::text as action_code,
    'team'::text as scope_kind,
    tla.scope_ref,
    'derived:attendance__internal_resolve_report_scope'::text as grant_source,
    tla.valid_from,
    tla.valid_to,
    case
      when s.reconstructibility like 'CURRENT_STATE_ONLY (LIMITATION_%' then s.reconstructibility
      else tla.reconstructibility
    end as reconstructibility
  from cand_team_leader_assignments tla
  join cand_r1_scopes s
    on s.app_user_id = tla.app_user_id
   and s.scope_kind = 'team'
   and s.scope_ref = tla.scope_ref
  where exists (select 1 from cand_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:team_manager_assign')
    and exists (select 1 from cand_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_view')
    and exists (select 1 from cand_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_analytics_view')
    and not exists (
      select 1
      from cand_r1_scopes s_all
      where s_all.app_user_id = tla.app_user_id
        and s_all.scope_kind = 'all'
        and (
          exists (select 1 from cand_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:entry_privileged_edit')
          or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = tla.app_user_id)
          or (
            exists (select 1 from cand_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_view')
            and exists (select 1 from cand_r1_capabilities c where c.app_user_id = tla.app_user_id and c.action_code = 'cap:report_analytics_view')
          )
        )
    )

  union all

  -- 5. Leave (shared/service accounts excluded from operational Leave grants)
  select
    lg.as_of_ts,
    lg.as_of_date,
    lg.app_user_id,
    lg.user_created_date,
    'MODULE_OP'::text as row_layer,
    'leave'::text as module_code,
    'op:leave:approve_department'::text as action_code,
    lg.scope_kind,
    lg.scope_ref,
    'derived:leave_can_approve_department'::text as grant_source,
    lg.valid_from,
    lg.valid_to,
    lg.reconstructibility
  from cand_leave_grants lg
  left join public.leave_employee_profiles lep
    on lep.app_user_id = lg.app_user_id
  where lg.action_code like 'department_approver:%'
    and not coalesce(lep.is_shared_non_employee, false)

  union all

  select
    tla.as_of_ts,
    tla.as_of_date,
    tla.app_user_id,
    tla.user_created_date,
    'MODULE_OP'::text as row_layer,
    'leave'::text as module_code,
    'op:leave:approve_team'::text as action_code,
    'team'::text as scope_kind,
    tla.scope_ref,
    'derived:leave_can_approve_recruitment_team'::text as grant_source,
    tla.valid_from,
    tla.valid_to,
    tla.reconstructibility
  from cand_team_leader_assignments tla
  left join public.leave_employee_profiles lep
    on lep.app_user_id = tla.app_user_id
  where not coalesce(lep.is_shared_non_employee, false)

  union all

  select
    lg.as_of_ts,
    lg.as_of_date,
    lg.app_user_id,
    lg.user_created_date,
    'MODULE_OP'::text as row_layer,
    'leave'::text as module_code,
    ('op:leave:hr_grant_' || replace(lg.action_code, 'leave_role:', ''))::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:leave_user_has_any_role'::text as grant_source,
    lg.valid_from,
    lg.valid_to,
    lg.reconstructibility
  from cand_leave_grants lg
  left join public.leave_employee_profiles lep
    on lep.app_user_id = lg.app_user_id
  where lg.action_code like 'leave_role:%'
    and not coalesce(lep.is_shared_non_employee, false)

  union all

  -- 6. Vendor Finance & Salary Advance & Recruitment Posts PM
  -- Project Accountant operations strictly require active ACCOUNTING department membership.
  select
    vf.as_of_ts,
    vf.as_of_date,
    vf.app_user_id,
    vf.user_created_date,
    'MODULE_OP'::text as row_layer,
    op.module_code,
    op.action_code,
    'project'::text as scope_kind,
    vf.scope_ref,
    'derived:vendor_finance_project_accountants'::text as grant_source,
    greatest(vf.valid_from::date, odm.valid_from::date)::text as valid_from,
    case
      when least(
        case when vf.valid_to = 'infinity' then '9999-12-31'::date else vf.valid_to::date end,
        case when odm.valid_to = 'infinity' then '9999-12-31'::date else odm.valid_to::date end
      ) = '9999-12-31'::date then 'infinity'
      else least(
        case when vf.valid_to = 'infinity' then '9999-12-31'::date else vf.valid_to::date end,
        case when odm.valid_to = 'infinity' then '9999-12-31'::date else odm.valid_to::date end
      )::text
    end as valid_to,
    vf.reconstructibility
  from cand_vendor_finance_grants vf
  join cand_org_dept_memberships odm
    on odm.app_user_id = vf.app_user_id
   and odm.action_code = 'dept_member:ACCOUNTING'
  cross join (
    values
      ('vendor_finance', 'op:vendor_finance:project_ledger_operate'),
      ('salary_advance', 'op:salary_advance:accountant_decide')
  ) as op(module_code, action_code)
  where vf.action_code = 'vfin_project_accountant'

  union all

  select
    vf.as_of_ts,
    vf.as_of_date,
    vf.app_user_id,
    vf.user_created_date,
    'MODULE_OP'::text as row_layer,
    'vendor_finance'::text as module_code,
    ('op:vendor_finance:global_' || replace(vf.action_code, 'vfin_role:', ''))::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:vendor_finance_global_roles'::text as grant_source,
    vf.valid_from,
    vf.valid_to,
    vf.reconstructibility
  from cand_vendor_finance_grants vf
  where vf.action_code like 'vfin_role:%'

  union all

  select
    pma.as_of_ts,
    pma.as_of_date,
    pma.app_user_id,
    pma.user_created_date,
    'MODULE_OP'::text as row_layer,
    op.module_code,
    op.action_code,
    'project'::text as scope_kind,
    pma.scope_ref,
    'derived:project_manager_assignments'::text as grant_source,
    pma.valid_from,
    pma.valid_to,
    pma.reconstructibility
  from cand_project_manager_assignments pma
  cross join (
    values
      ('vendor_finance', 'op:vendor_finance:pm_project_view'),
      ('salary_advance', 'op:salary_advance:pm_request'),
      ('recruitment_posts', 'op:recruitment_posts:pm_manage_project')
  ) as op(module_code, action_code)

  union all

  -- 7. Work Reports (direct review/assign at all|team + delegations)
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'work_reports'::text as module_code,
    ('op:work_reports:' || replace(caps.cap_name, 'report_', ''))::text as action_code,
    s.scope_kind,
    s.scope_ref,
    ('derived:work_report_direct_' || replace(caps.cap_name, 'report_', ''))::text as grant_source,
    coalesce(
      (
        select greatest(s.valid_from::date, c.valid_from::date)::text
        from cand_r1_capabilities c
        where c.app_user_id = s.app_user_id
          and c.action_code = ('cap:' || caps.cap_name)
      ),
      (
        select greatest(s.valid_from::date, fa.valid_from_date)::text
        from cand_full_admin_users fa
        where fa.app_user_id = s.app_user_id
      )
    ) as valid_from,
    coalesce(
      (
        select
          case
            when least(
              case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end,
              case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end
            ) = '9999-12-31'::date then 'infinity'
            else least(
              case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end,
              case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end
            )::text
          end
        from cand_r1_capabilities c
        where c.app_user_id = s.app_user_id
          and c.action_code = ('cap:' || caps.cap_name)
      ),
      s.valid_to
    ) as valid_to,
    s.reconstructibility
  from cand_r1_scopes s
  cross join (values ('report_review'), ('report_assign')) as caps(cap_name)
  where s.scope_kind in ('all', 'team')
    and (
      exists (
        select 1
        from cand_r1_capabilities c
        where c.app_user_id = s.app_user_id
          and c.action_code = ('cap:' || caps.cap_name)
      )
      or (
        exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id)
        and not exists (
          select 1
          from public.direct_entry_capability_grants g_rev
          where g_rev.app_user_id = s.app_user_id
            and g_rev.capability = caps.cap_name
            and g_rev.is_current = false
            and g_rev.valid_to is null
        )
      )
    )

  union all

  select
    wrd.as_of_ts,
    wrd.as_of_date,
    wrd.app_user_id,
    wrd.user_created_date,
    'MODULE_OP'::text as row_layer,
    'work_reports'::text as module_code,
    ('op:work_reports:' || replace(wrd.action_code, 'delegation:report_', ''))::text as action_code,
    wrd.scope_kind,
    wrd.scope_ref,
    'derived:work_report_delegations'::text as grant_source,
    wrd.valid_from,
    wrd.valid_to,
    wrd.reconstructibility
  from cand_work_report_delegations wrd

  union all

  -- 8. Admin, Catalog, Locations, Recruitment Posts (Admin/BoD), Audit, History, Duplicate CCCD Withdraw
  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'admin'::text as module_code,
    'op:admin:catalog_manage'::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:direct_entry_assert_catalog_operator+catalogOperatorNavPredicate(scope=all+cap)'::text as grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from cand_r1_scopes s
  where s.scope_kind = 'all'
    and (
      exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:catalog_master_manage')
      or exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id)
    )

  union all

  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    op.module_code,
    op.action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    op.grant_source,
    s.valid_from,
    s.valid_to,
    s.reconstructibility
  from cand_r1_scopes s
  cross join (
    values
      ('admin', 'op:admin:location_catalog_manage', 'derived:recruitment_location_is_admin_or_bod'),
      ('recruitment_posts', 'op:recruitment_posts:admin_or_bod_manage', 'derived:recruitment_location_is_admin_or_bod')
  ) as op(module_code, action_code, grant_source)
  where s.scope_kind = 'all'
    and (
      exists (select 1 from cand_full_admin_users fa where fa.app_user_id = s.app_user_id)
      or exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:entry_privileged_edit')
      or (
        exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_view')
        and exists (select 1 from cand_r1_capabilities c where c.app_user_id = s.app_user_id and c.action_code = 'cap:report_analytics_view')
      )
    )

  union all

  select
    s.as_of_ts,
    s.as_of_date,
    s.app_user_id,
    s.user_created_date,
    'MODULE_OP'::text as row_layer,
    'admin'::text as module_code,
    'op:admin:account_and_dept_admin'::text as action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    'derived:full_admin_triple_plus_all_scope'::text as grant_source,
    greatest(s.valid_from::date, fa.valid_from_date)::text as valid_from,
    s.valid_to,
    s.reconstructibility
  from cand_r1_scopes s
  join cand_full_admin_users fa
    on fa.app_user_id = s.app_user_id
  where s.scope_kind = 'all'

  union all

  select
    c.as_of_ts,
    c.as_of_date,
    c.app_user_id,
    c.user_created_date,
    'MODULE_OP'::text as row_layer,
    op.module_code,
    op.action_code,
    'all'::text as scope_kind,
    '*'::text as scope_ref,
    op.grant_source,
    greatest(c.valid_from::date, s.valid_from::date)::text as valid_from,
    case
      when least(
        case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end,
        case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end
      ) = '9999-12-31'::date then 'infinity'
      else least(
        case when c.valid_to = 'infinity' then '9999-12-31'::date else c.valid_to::date end,
        case when s.valid_to = 'infinity' then '9999-12-31'::date else s.valid_to::date end
      )::text
    end as valid_to,
    case when c.reconstructibility <> 'POINT_IN_TIME_CURRENT' then c.reconstructibility else s.reconstructibility end as reconstructibility
  from cand_r1_capabilities c
  join cand_r1_scopes s
    on s.app_user_id = c.app_user_id
   and s.scope_kind = 'all'
  join (
    values
      ('cap:audit_view', 'admin', 'op:admin:audit_view', 'derived:audit_log_assert_reader'),
      ('cap:worker_edit_history_view', 'admin', 'op:admin:worker_edit_history_view', 'derived:worker_edit_history_assert_actor'),
      ('cap:duplicate_cccd_withdraw', 'direct_entry', 'op:direct_entry:duplicate_cccd_withdraw', 'derived:direct_entry_withdraw_duplicate_cccd')
  ) as op(req_cap, module_code, action_code, grant_source)
    on op.req_cap = c.action_code
),
candidate_rows as materialized (
  select
    as_of_ts,
    as_of_date,
    app_user_id,
    user_created_date,
    row_layer,
    module_code,
    action_code,
    scope_kind,
    scope_ref,
    min(grant_source) as grant_source,
    min(valid_from) as valid_from,
    max(valid_to) as valid_to,
    case
      when bool_or(reconstructibility like 'CURRENT_STATE_ONLY (LIMITATION_%')
      then max(reconstructibility) filter (where reconstructibility like 'CURRENT_STATE_ONLY (LIMITATION_%')
      else min(reconstructibility)
    end as reconstructibility
  from (
    select * from cand_raw_grants
    union all
    select * from cand_module_ops_raw
  ) combined
  where ((select target_app_user_id from params) is null or app_user_id = (select target_app_user_id from params))
  group by
    as_of_ts,
    as_of_date,
    app_user_id,
    user_created_date,
    row_layer,
    module_code,
    action_code,
    scope_kind,
    scope_ref
),
-- =============================================================================
-- PART C: CLASSIFIED SHADOW DIFF (INDEPENDENT BASE-TABLE EVIDENCE)
-- =============================================================================
ev_eligible_users as materialized (
  select
    p.as_of_ts,
    p.current_ts,
    p.as_of_date,
    u.app_user_id
  from params p
  join public.direct_entry_app_users u
    on (
      p.target_app_user_id is null
      or u.app_user_id = p.target_app_user_id
      or exists (
        select 1
        from public.work_report_delegations wrd_f
        where wrd_f.delegate_app_user_id = p.target_app_user_id
          and wrd_f.grantor_user_id = u.app_user_id
      )
    )
  where u.enabled = true
    and (u.created_at at time zone 'Asia/Ho_Chi_Minh')::date <= p.as_of_date
),
ev_valid_caps as materialized (
  select distinct
    u.app_user_id,
    cg.capability
  from ev_eligible_users u
  join public.direct_entry_capability_grants cg
    on cg.app_user_id = u.app_user_id
  where cg.valid_from <= u.as_of_date
    and ((cg.created_at at time zone 'Asia/Ho_Chi_Minh')::date > cg.valid_from or cg.created_at <= u.as_of_ts)
    and (cg.valid_to is null or (cg.valid_to > cg.valid_from and u.as_of_date < cg.valid_to))
    and (cg.is_current = true or cg.valid_to is not null)
),
ev_full_admin as materialized (
  select c.app_user_id
  from ev_valid_caps c
  where c.capability in ('entry_admin', 'recruiter_master_manage', 'team_master_manage')
  group by c.app_user_id
  having count(distinct c.capability) = 3
),
ev_valid_all_scope as materialized (
  select distinct u.app_user_id
  from ev_eligible_users u
  join public.direct_entry_scope_grants sg
    on sg.app_user_id = u.app_user_id
   and sg.scope_kind = 'all'
  where sg.valid_from <= u.as_of_date
    and ((sg.created_at at time zone 'Asia/Ho_Chi_Minh')::date > sg.valid_from or sg.created_at <= u.as_of_ts)
    and (sg.valid_to is null or (sg.valid_to > sg.valid_from and u.as_of_date < sg.valid_to))
    and (sg.is_current = true or sg.valid_to is not null)
),
ev_valid_team_scope as materialized (
  select distinct
    u.app_user_id,
    sg.team_id::text as team_id_text
  from ev_eligible_users u
  join public.direct_entry_scope_grants sg
    on sg.app_user_id = u.app_user_id
   and sg.scope_kind = 'team'
  join public.teams t
    on t.team_id = sg.team_id
   and t.active = true
   and t.code <> '__system_vendor__'
  where sg.valid_from <= u.as_of_date
    and ((sg.created_at at time zone 'Asia/Ho_Chi_Minh')::date > sg.valid_from or sg.created_at <= u.as_of_ts)
    and (sg.valid_to is null or (sg.valid_to > sg.valid_from and u.as_of_date < sg.valid_to))
    and (sg.is_current = true or sg.valid_to is not null)
),
ev_valid_accounting_dept as materialized (
  select distinct u.app_user_id
  from ev_eligible_users u
  join public.organization_department_memberships odm
    on odm.app_user_id = u.app_user_id
  join public.organization_departments od
    on od.department_id = odm.department_id
   and od.code = 'ACCOUNTING'
   and od.is_active = true
  where odm.valid_from <= u.as_of_date
    and ((odm.created_at at time zone 'Asia/Ho_Chi_Minh')::date > odm.valid_from or odm.created_at <= u.as_of_ts)
    and (
      (odm.revoked_at is not null and u.as_of_ts < odm.revoked_at)
      or (
        odm.revoked_at is null
        and (odm.valid_to is null or (odm.valid_to > odm.valid_from and u.as_of_date < odm.valid_to))
      )
    )
),
ev_all_active_recruiter_links as materialized (
  select
    rl.app_user_id,
    rl.recruiter_id
  from params p
  join public.direct_entry_app_user_recruiter_links rl
    on rl.verified = true
  join public.recruiters r
    on r.recruiter_id = rl.recruiter_id
   and r.active = true
  where rl.valid_from <= p.as_of_date
    and ((rl.created_at at time zone 'Asia/Ho_Chi_Minh')::date > rl.valid_from or rl.created_at <= p.as_of_ts)
    and (rl.valid_to is null or (rl.valid_to > rl.valid_from and p.as_of_date < rl.valid_to))
    and (rl.is_current = true or rl.valid_to is not null)
),
ev_recruiter_link_counts as materialized (
  select
    l.app_user_id,
    l.recruiter_id,
    count(*) over (partition by l.app_user_id) as user_link_cnt,
    count(*) over (partition by l.recruiter_id) as rec_link_cnt
  from ev_all_active_recruiter_links l
),
ev_unambiguous_recruiter_links as materialized (
  select
    c.app_user_id,
    c.recruiter_id
  from ev_recruiter_link_counts c
  where c.user_link_cnt = 1
    and c.rec_link_cnt = 1
),
ev_ambiguous_recruiter_link_users as materialized (
  select distinct c.app_user_id
  from ev_recruiter_link_counts c
  where c.user_link_cnt > 1
     or c.rec_link_cnt > 1
),
ev_valid_grantor_wr_auth as materialized (
  select distinct
    u.app_user_id as grantor_user_id,
    caps.capability,
    s.scope_kind,
    s.scope_ref
  from ev_eligible_users u
  cross join (values ('report_delegate'), ('report_assign'), ('report_review')) as caps(capability)
  join (
    select a.app_user_id, 'all'::text as scope_kind, '*'::text as scope_ref
    from ev_valid_all_scope a
    where exists (
      select 1 from ev_valid_caps c
      where c.app_user_id = a.app_user_id
        and c.capability in (
          'entry_admin', 'entry_privileged_edit', 'entry_create',
          'report_view', 'report_analytics_view', 'report_review', 'report_assign',
          'report_template_manage', 'report_form_manage', 'report_delegate',
          'attendance_view', 'vendor_finance_view', 'vendor_finance_record',
          'vendor_finance_reconcile', 'vendor_finance_admin', 'worker_edit_history_view',
          'change_review', 'employment_status.review', 'employment_status.apply',
          'entry_restore', 'audit_view', 'catalog_master_manage', 'duplicate_cccd_withdraw'
        )
    )
    union all
    select t.app_user_id, 'team'::text as scope_kind, t.team_id_text as scope_ref
    from ev_valid_team_scope t
  ) s on s.app_user_id = u.app_user_id
  where (
    exists (
      select 1 from ev_valid_caps c
      where c.app_user_id = u.app_user_id
        and c.capability = caps.capability
    )
    or (
      exists (select 1 from ev_full_admin fa where fa.app_user_id = u.app_user_id)
      and not exists (
        select 1
        from public.direct_entry_capability_grants g_rev
        where g_rev.app_user_id = u.app_user_id
          and g_rev.capability = caps.capability
          and g_rev.is_current = false
          and (g_rev.valid_to is null or g_rev.valid_to <= u.as_of_date)
      )
    )
  )
),
ev_valid_delegations as materialized (
  select distinct
    u.app_user_id as delegate_app_user_id,
    wrd.capability,
    ('template_' || wrd.scope_kind)::text as scope_kind,
    (wrd.template_id::text || ':' || coalesce(wrd.scope_team_id::text, '*'))::text as scope_ref
  from ev_eligible_users u
  join public.work_report_delegations wrd
    on wrd.delegate_app_user_id = u.app_user_id
  join ev_eligible_users gu
    on gu.app_user_id = wrd.grantor_user_id
  join public.work_report_templates wt
    on wt.template_id = wrd.template_id
   and wt.status = 'ACTIVE'
   and wt.current_published_version_id is not null
  where wrd.effective_from <= u.as_of_ts
    and (wrd.effective_to is null or u.as_of_ts <= wrd.effective_to)
    and (
      (wrd.revoked_at is null and wrd.state = 'ACTIVE' and wrd.is_current = true)
      or (wrd.revoked_at is not null and u.as_of_ts < wrd.revoked_at)
    )
    and (
      wrd.scope_kind = 'all'
      or (
        wrd.scope_kind = 'team'
        and exists (
          select 1 from public.teams tm
          where tm.team_id = wrd.scope_team_id
            and tm.active = true
            and tm.code <> '__system_vendor__'
        )
        and (
          exists (
            select 1 from ev_valid_team_scope dsg
            where dsg.app_user_id = u.app_user_id
              and dsg.team_id_text = wrd.scope_team_id::text
          )
          or exists (
            select 1
            from ev_unambiguous_recruiter_links url
            join public.recruiter_team_memberships rtm
              on rtm.recruiter_id = url.recruiter_id
             and rtm.team_id = wrd.scope_team_id
            where url.app_user_id = u.app_user_id
              and rtm.valid_from <= u.as_of_date
              and (rtm.valid_to is null or (rtm.valid_to > rtm.valid_from and u.as_of_date < rtm.valid_to))
              and (rtm.is_current = true or rtm.valid_to is not null)
          )
        )
      )
    )
    and exists (
      select 1 from ev_valid_grantor_wr_auth ga_del
      where ga_del.grantor_user_id = wrd.grantor_user_id
        and ga_del.capability = 'report_delegate'
        and (
          ga_del.scope_kind = 'all'
          or (wrd.scope_kind = 'team' and ga_del.scope_kind = 'team' and ga_del.scope_ref = wrd.scope_team_id::text)
        )
    )
    and exists (
      select 1 from ev_valid_grantor_wr_auth ga_cap
      where ga_cap.grantor_user_id = wrd.grantor_user_id
        and ga_cap.capability = wrd.capability
        and (
          ga_cap.scope_kind = 'all'
          or (wrd.scope_kind = 'team' and ga_cap.scope_kind = 'team' and ga_cap.scope_ref = wrd.scope_team_id::text)
        )
    )
),
ev_intraday_closed_before_asof as materialized (
  -- Exact base-table records closed AFTER as_of_ts (active at historical intra-day query time)
  select u.app_user_id, 'PM'::text as src_kind, pma.project_id::text as ref_id
  from ev_eligible_users u
  join ev_unambiguous_recruiter_links url on url.app_user_id = u.app_user_id
  join public.direct_entry_project_manager_assignments pma on pma.manager_recruiter_id = url.recruiter_id
  join public.direct_entry_projects prj on prj.project_id = pma.project_id and prj.active = true
  where u.as_of_ts < u.current_ts
    and pma.valid_from <= u.as_of_date
    and ((pma.created_at at time zone 'Asia/Ho_Chi_Minh')::date > pma.valid_from or pma.created_at <= u.as_of_ts)
    and pma.revoked_at is not null
    and u.as_of_ts < pma.revoked_at

  union all

  select u.app_user_id, 'DEPT'::text as src_kind, odm.department_id::text as ref_id
  from ev_eligible_users u
  join public.organization_department_memberships odm on odm.app_user_id = u.app_user_id
  join public.organization_departments od on od.department_id = odm.department_id and od.is_active = true
  where u.as_of_ts < u.current_ts
    and odm.valid_from <= u.as_of_date
    and ((odm.created_at at time zone 'Asia/Ho_Chi_Minh')::date > odm.valid_from or odm.created_at <= u.as_of_ts)
    and odm.revoked_at is not null
    and u.as_of_ts < odm.revoked_at

  union all

  select u.app_user_id, 'VFIN_GLOBAL'::text as src_kind, vfgr.role_code::text as ref_id
  from ev_eligible_users u
  join public.vendor_finance_global_roles vfgr on vfgr.app_user_id = u.app_user_id
  where u.as_of_ts < u.current_ts
    and vfgr.valid_from <= u.as_of_date
    and ((vfgr.created_at at time zone 'Asia/Ho_Chi_Minh')::date > vfgr.valid_from or vfgr.created_at <= u.as_of_ts)
    and vfgr.ended_at is not null
    and u.as_of_ts < vfgr.ended_at

  union all

  select u.app_user_id, 'VFIN_PA'::text as src_kind, vfpa.project_id::text as ref_id
  from ev_eligible_users u
  join public.vendor_finance_project_accountants vfpa on vfpa.accountant_user_id = u.app_user_id
  join public.direct_entry_projects prj on prj.project_id = vfpa.project_id and prj.active = true
  where u.as_of_ts < u.current_ts
    and vfpa.valid_from <= u.as_of_date
    and ((vfpa.created_at at time zone 'Asia/Ho_Chi_Minh')::date > vfpa.valid_from or vfpa.created_at <= u.as_of_ts)
    and vfpa.ended_at is not null
    and u.as_of_ts < vfpa.ended_at

  union all

  select u.app_user_id, 'LEAVE_GRANT'::text as src_kind, lmg.role_code::text as ref_id
  from ev_eligible_users u
  join public.leave_module_grants lmg on lmg.app_user_id = u.app_user_id
  left join lateral (
    select max(lae.created_at) as audit_revoke_ts
    from public.leave_audit_events lae
    where lae.event_type = 'MODULE_GRANT_REVOKE'
      and lae.payload->>'grant_id' = lmg.grant_id::text
  ) rev_ev on true
  where u.as_of_ts < u.current_ts
    and lmg.is_current = false
    and lmg.valid_from <= u.as_of_date
    and ((lmg.created_at at time zone 'Asia/Ho_Chi_Minh')::date > lmg.valid_from or lmg.created_at <= u.as_of_ts)
    and coalesce(
      rev_ev.audit_revoke_ts,
      case when lmg.valid_to is not null and lmg.updated_at is not null and (lmg.updated_at at time zone 'Asia/Ho_Chi_Minh')::date <= lmg.valid_to then lmg.updated_at else null end
    ) is not null
    and u.as_of_ts < coalesce(rev_ev.audit_revoke_ts, lmg.updated_at)

  union all

  select u.app_user_id, 'LEAVE_APPROVER'::text as src_kind, lda.unit_kind::text as ref_id
  from ev_eligible_users u
  join public.leave_department_approvers lda on lda.approver_app_user_id = u.app_user_id
  where u.as_of_ts < u.current_ts
    and lda.is_current = false
    and lda.valid_from <= u.as_of_date
    and ((lda.created_at at time zone 'Asia/Ho_Chi_Minh')::date > lda.valid_from or lda.created_at <= u.as_of_ts)
    and lda.valid_to is not null
    and lda.updated_at is not null
    and (lda.updated_at at time zone 'Asia/Ho_Chi_Minh')::date = lda.valid_to
    and u.as_of_ts < lda.updated_at

  union all

  select u.app_user_id, 'TL'::text as src_kind, tla.team_id::text as ref_id
  from ev_eligible_users u
  join ev_unambiguous_recruiter_links url on url.app_user_id = u.app_user_id
  join public.direct_entry_team_leader_assignments tla
    on tla.leader_app_user_id = u.app_user_id
   and tla.leader_recruiter_id = url.recruiter_id
  join public.teams t
    on t.team_id = tla.team_id
   and t.active = true
   and t.code <> '__system_vendor__'
  join lateral (
    select min(rev.created_at) as close_ts
    from public.direct_entry_team_leader_revisions rev
    where tla.valid_to is not null
      and rev.team_id = tla.team_id
      and rev.created_at >= tla.created_at
      and (
        (
          rev.before_snapshot->>'leader_app_user_id' = tla.leader_app_user_id::text
          and coalesce(rev.after_snapshot->>'leader_app_user_id', '') <> tla.leader_app_user_id::text
        )
        or (
          rev.after_snapshot->>'leader_app_user_id' = tla.leader_app_user_id::text
          and rev.after_snapshot->>'valid_to' is not null
        )
      )
  ) tl_close on true
  where u.as_of_ts < u.current_ts
    and tla.is_current = false
    and tla.valid_to is not null
    and tla.valid_from <= u.as_of_date
    and ((tla.created_at at time zone 'Asia/Ho_Chi_Minh')::date > tla.valid_from or tla.created_at <= u.as_of_ts)
    and tl_close.close_ts is not null
    and u.as_of_ts < tl_close.close_ts
    and ((tl_close.close_ts at time zone 'Asia/Ho_Chi_Minh')::date <= tla.valid_to or (tla.valid_to > tla.valid_from and u.as_of_date < tla.valid_to))

  union all

  select u.app_user_id, 'WRD'::text as src_kind, (wrd.template_id::text || ':' || coalesce(wrd.scope_team_id::text, '*'))::text as ref_id
  from ev_eligible_users u
  join public.work_report_delegations wrd on wrd.delegate_app_user_id = u.app_user_id
  where u.as_of_ts < u.current_ts
    and wrd.effective_from <= u.as_of_ts
    and (wrd.effective_to is null or u.as_of_ts <= wrd.effective_to)
    and wrd.revoked_at is not null
    and u.as_of_ts < wrd.revoked_at
),
ev_intraday_created_after_asof as materialized (
  select u.app_user_id, 'CAP'::text as src_kind, ('cap:' || cg.capability)::text as ref_id
  from ev_eligible_users u
  join public.direct_entry_capability_grants cg on cg.app_user_id = u.app_user_id
  where u.as_of_ts < u.current_ts
    and cg.is_current = true
    and cg.valid_from = u.as_of_date
    and (cg.created_at at time zone 'Asia/Ho_Chi_Minh')::date = cg.valid_from
    and cg.created_at > u.as_of_ts
    and not exists (
      select 1 from ev_valid_caps vc
      where vc.app_user_id = u.app_user_id
        and vc.capability = cg.capability
    )

  union all

  select u.app_user_id, 'SCOPE'::text as src_kind, (sg.scope_kind || ':' || coalesce(sg.team_id::text, '*'))::text as ref_id
  from ev_eligible_users u
  join public.direct_entry_scope_grants sg on sg.app_user_id = u.app_user_id
  where u.as_of_ts < u.current_ts
    and sg.is_current = true
    and sg.valid_from = u.as_of_date
    and (sg.created_at at time zone 'Asia/Ho_Chi_Minh')::date = sg.valid_from
    and sg.created_at > u.as_of_ts
    and (
      (sg.scope_kind = 'all' and not exists (select 1 from ev_valid_all_scope sa where sa.app_user_id = u.app_user_id))
      or (sg.scope_kind = 'team' and not exists (select 1 from ev_valid_team_scope st where st.app_user_id = u.app_user_id and st.team_id_text = sg.team_id::text))
      or (
        sg.scope_kind = 'own'
        and not exists (
          select 1 from public.direct_entry_scope_grants sg2
          where sg2.app_user_id = u.app_user_id
            and sg2.scope_kind = 'own'
            and sg2.valid_from <= u.as_of_date
            and ((sg2.created_at at time zone 'Asia/Ho_Chi_Minh')::date > sg2.valid_from or sg2.created_at <= u.as_of_ts)
            and (sg2.valid_to is null or (sg2.valid_to > sg2.valid_from and u.as_of_date < sg2.valid_to))
            and (sg2.is_current = true or sg2.valid_to is not null)
        )
      )
    )

  union all

  select u.app_user_id, 'LINK'::text as src_kind, rl.recruiter_id::text as ref_id
  from ev_eligible_users u
  join public.direct_entry_app_user_recruiter_links rl on rl.app_user_id = u.app_user_id
  where u.as_of_ts < u.current_ts
    and rl.is_current = true
    and rl.verified = true
    and rl.valid_from = u.as_of_date
    and (rl.created_at at time zone 'Asia/Ho_Chi_Minh')::date = rl.valid_from
    and rl.created_at > u.as_of_ts
    and not exists (
      select 1 from ev_unambiguous_recruiter_links url
      where url.app_user_id = u.app_user_id
        and url.recruiter_id = rl.recruiter_id
    )

  union all

  select u.app_user_id, 'TL'::text as src_kind, tla.team_id::text as ref_id
  from ev_eligible_users u
  join public.direct_entry_team_leader_assignments tla on tla.leader_app_user_id = u.app_user_id
  join public.teams t on t.team_id = tla.team_id and t.active = true and t.code <> '__system_vendor__'
  where u.as_of_ts < u.current_ts
    and tla.is_current = true
    and tla.valid_from = u.as_of_date
    and (tla.created_at at time zone 'Asia/Ho_Chi_Minh')::date = tla.valid_from
    and tla.created_at > u.as_of_ts
    and not exists (
      select 1
      from public.direct_entry_team_leader_assignments tla2
      left join lateral (
        select min(rev.created_at) as close_ts
        from public.direct_entry_team_leader_revisions rev
        where tla2.valid_to is not null
          and rev.team_id = tla2.team_id
          and rev.created_at >= tla2.created_at
          and (
            (
              rev.before_snapshot->>'leader_app_user_id' = tla2.leader_app_user_id::text
              and coalesce(rev.after_snapshot->>'leader_app_user_id', '') <> tla2.leader_app_user_id::text
            )
            or (
              rev.after_snapshot->>'leader_app_user_id' = tla2.leader_app_user_id::text
              and rev.after_snapshot->>'valid_to' is not null
            )
          )
      ) c2 on true
      where tla2.leader_app_user_id = u.app_user_id
        and tla2.team_id = tla.team_id
        and tla2.valid_from <= u.as_of_date
        and ((tla2.created_at at time zone 'Asia/Ho_Chi_Minh')::date > tla2.valid_from or tla2.created_at <= u.as_of_ts)
        and (
          (c2.close_ts is not null and u.as_of_ts < c2.close_ts)
          or (c2.close_ts is null and (tla2.valid_to is null or (tla2.valid_to > tla2.valid_from and u.as_of_date < tla2.valid_to)) and (tla2.is_current = true or tla2.valid_to is not null))
        )
    )

  union all

  select u.app_user_id, 'PM'::text as src_kind, pma.project_id::text as ref_id
  from ev_eligible_users u
  join public.direct_entry_app_user_recruiter_links rl on rl.app_user_id = u.app_user_id and rl.verified = true and rl.is_current = true
  join public.direct_entry_project_manager_assignments pma on pma.manager_recruiter_id = rl.recruiter_id
  where u.as_of_ts < u.current_ts
    and pma.is_current = true
    and pma.valid_from = u.as_of_date
    and (pma.created_at at time zone 'Asia/Ho_Chi_Minh')::date = pma.valid_from
    and pma.created_at > u.as_of_ts

  union all

  select u.app_user_id, 'DEPT'::text as src_kind, odm.department_id::text as ref_id
  from ev_eligible_users u
  join public.organization_department_memberships odm on odm.app_user_id = u.app_user_id
  join public.organization_departments od on od.department_id = odm.department_id and od.is_active = true
  where u.as_of_ts < u.current_ts
    and odm.revoked_at is null
    and odm.valid_to is null
    and odm.valid_from = u.as_of_date
    and (odm.created_at at time zone 'Asia/Ho_Chi_Minh')::date = odm.valid_from
    and odm.created_at > u.as_of_ts
    and (od.code <> 'ACCOUNTING' or not exists (select 1 from ev_valid_accounting_dept ad where ad.app_user_id = u.app_user_id))

  union all

  select u.app_user_id, 'VFIN_GLOBAL'::text as src_kind, vfgr.role_code::text as ref_id
  from ev_eligible_users u
  join public.vendor_finance_global_roles vfgr on vfgr.app_user_id = u.app_user_id
  where u.as_of_ts < u.current_ts
    and vfgr.ended_at is null
    and vfgr.valid_to is null
    and vfgr.valid_from = u.as_of_date
    and (vfgr.created_at at time zone 'Asia/Ho_Chi_Minh')::date = vfgr.valid_from
    and vfgr.created_at > u.as_of_ts

  union all

  select u.app_user_id, 'VFIN_PA'::text as src_kind, vfpa.project_id::text as ref_id
  from ev_eligible_users u
  join public.vendor_finance_project_accountants vfpa on vfpa.accountant_user_id = u.app_user_id
  where u.as_of_ts < u.current_ts
    and vfpa.ended_at is null
    and vfpa.valid_to is null
    and vfpa.valid_from = u.as_of_date
    and (vfpa.created_at at time zone 'Asia/Ho_Chi_Minh')::date = vfpa.valid_from
    and vfpa.created_at > u.as_of_ts

  union all

  select u.app_user_id, 'LEAVE_GRANT'::text as src_kind, lmg.role_code::text as ref_id
  from ev_eligible_users u
  join public.leave_module_grants lmg on lmg.app_user_id = u.app_user_id
  where u.as_of_ts < u.current_ts
    and lmg.is_current = true
    and lmg.valid_from = u.as_of_date
    and (lmg.created_at at time zone 'Asia/Ho_Chi_Minh')::date = lmg.valid_from
    and lmg.created_at > u.as_of_ts

  union all

  select u.app_user_id, 'LEAVE_APPROVER'::text as src_kind, lda.unit_kind::text as ref_id
  from ev_eligible_users u
  join public.leave_department_approvers lda on lda.approver_app_user_id = u.app_user_id
  where u.as_of_ts < u.current_ts
    and lda.is_current = true
    and lda.valid_from = u.as_of_date
    and (lda.created_at at time zone 'Asia/Ho_Chi_Minh')::date = lda.valid_from
    and lda.created_at > u.as_of_ts

  union all

  select u.app_user_id, 'WRD'::text as src_kind, (wrd.template_id::text || ':' || coalesce(wrd.scope_team_id::text, '*'))::text as ref_id
  from ev_eligible_users u
  join public.work_report_delegations wrd on wrd.delegate_app_user_id = u.app_user_id
  where u.as_of_ts < u.current_ts
    and wrd.is_current = true
    and wrd.state = 'ACTIVE'
    and wrd.effective_from > u.as_of_ts
),
lost_rows as (
  select
    b.as_of_ts,
    b.as_of_date,
    b.app_user_id,
    b.account_id_mask,
    b.diff_status,
    b.diff_classification,
    case b.diff_classification
      when 'EXPECTED_FIX_FUTURE_DATED_GRANT'
        then 'Current runtime accepted future-dated row with stale is_current=true; candidate enforces valid_from <= as_of_date'
      when 'EXPECTED_FIX_EXPIRED_GRANT_STALE_IS_CURRENT'
        then 'Current runtime accepted expired/closed row (valid_to <= as_of_date) due to stale is_current=true; candidate enforces half-open [valid_from, valid_to)'
      when 'EXPECTED_FIX_HISTORICAL_INTRADAY_CREATED_AFTER_ASOF'
        then 'Current runtime snapshot included same-day row created after historical as_of_ts; candidate excludes future intra-day creation timestamps'
      when 'EXPECTED_FIX_ORPHAN_ALL_SCOPE'
        then 'Standalone scope=all with 0 capabilities; candidate requires paired capabilities per WP2A rules (WP5-WP6 explicit role required if BoD access is intended)'
      when 'EXPECTED_FIX_ALL_SCOPE_WRONG_MODULE_CAPABILITY'
        then 'User holds scope=all without required capabilities for this target operation (prevents legacy widening)'
      when 'EXPECTED_FIX_AMBIGUOUS_RECRUITER_LINK'
        then 'Non-1:1 recruiter link blocked from deriving contextual or recruited authority in candidate'
      when 'EXPECTED_FIX_REPORTING_SCOPE_WITHOUT_CAPABILITY'
        then 'Reporting scope without required team/own/reporting capability blocked in candidate'
      when 'EXPECTED_FIX_SHARED_ACCOUNT_EXCLUSION'
        then 'Shared/service account excluded from operational Leave roles and approvals in candidate'
      when 'EXPECTED_FIX_PROJECT_ACCOUNTANT_REQUIRES_ACCOUNTING_DEPT'
        then 'Project accountant assignment inactive for module ops without active ACCOUNTING department membership'
      when 'EXPECTED_FIX_DELEGATION_GRANTOR_INVALID'
        then 'Delegation blocked because independent base-table checks prove invalid grantor capability/scope, expired/revoked delegation, or missing team link'
      else 'Investigate access loss before cutover'
    end::text as t0_decision_reason,
    b.row_layer,
    b.module_code,
    b.action_code,
    b.scope_kind,
    b.scope_ref,
    b.curr_grant_source,
    b.cand_grant_source,
    b.curr_valid_window,
    b.cand_valid_window,
    b.reconstructibility
  from (
    select
      cur.as_of_ts,
      cur.as_of_date,
      cur.app_user_id,
      (left(cur.app_user_id::text, 8) || '...')::text as account_id_mask,
      'LOST_IN_CANDIDATE'::text as diff_status,
      case
        when cur.valid_from <> 'infinity'
         and cur.valid_from::date > cur.as_of_date
        then 'EXPECTED_FIX_FUTURE_DATED_GRANT'
        when cur.valid_to <> 'infinity'
         and cur.valid_to::date <= cur.as_of_date
         and not exists (
           select 1
           from ev_intraday_closed_before_asof intra
           where intra.app_user_id = cur.app_user_id
         )
        then 'EXPECTED_FIX_EXPIRED_GRANT_STALE_IS_CURRENT'
        when exists (
          select 1
          from params p
          where cur.as_of_ts < p.current_ts
        )
         and exists (
           select 1
           from ev_intraday_created_after_asof after_ev
           where after_ev.app_user_id = cur.app_user_id
             and (
               (cur.row_layer = 'RAW_GRANT' and cur.action_code like 'cap:%' and after_ev.src_kind = 'CAP' and after_ev.ref_id = cur.action_code)
               or (cur.row_layer = 'RAW_GRANT' and cur.action_code like 'scope:%' and after_ev.src_kind = 'SCOPE' and after_ev.ref_id = (cur.scope_kind || ':' || cur.scope_ref))
               or (cur.action_code in ('op:dashboard:view_general', 'op:dashboard:view_workforce_deep', 'op:dashboard:view_detailed_matrix', 'op:attendance:report_view', 'op:workforce:offboarding_view', 'op:direct_entry:workers_all_tab', 'op:work_reports:assign', 'op:work_reports:review') and after_ev.src_kind = 'SCOPE' and after_ev.ref_id = (cur.scope_kind || ':' || cur.scope_ref))
               or (cur.action_code = 'op:work_reports:assign' and after_ev.src_kind = 'CAP' and after_ev.ref_id = 'cap:report_assign')
               or (cur.action_code = 'op:work_reports:review' and after_ev.src_kind = 'CAP' and after_ev.ref_id = 'cap:report_review')
               or (cur.action_code in ('recruiter_link:verified', 'op:dashboard:view_general') and cur.scope_kind = 'recruited' and after_ev.src_kind = 'LINK' and after_ev.ref_id = cur.scope_ref)
               or (cur.action_code in ('assignment:team_leader', 'op:leave:approve_team', 'op:attendance:report_view', 'op:workforce:offboarding_view') and cur.scope_kind = 'team' and after_ev.src_kind = 'TL' and after_ev.ref_id = cur.scope_ref)
               or (cur.action_code in ('assignment:project_manager', 'op:vendor_finance:pm_project_view', 'op:salary_advance:pm_request', 'op:recruitment_posts:pm_manage_project') and cur.scope_kind = 'project' and after_ev.src_kind = 'PM' and after_ev.ref_id = cur.scope_ref)
               or (cur.action_code like 'dept_member:%' and after_ev.src_kind = 'DEPT' and after_ev.ref_id = cur.scope_ref)
               or (cur.action_code in ('op:vendor_finance:project_ledger_operate', 'op:salary_advance:accountant_decide') and ((after_ev.src_kind = 'VFIN_PA' and after_ev.ref_id = cur.scope_ref) or after_ev.src_kind = 'DEPT'))
               or (cur.action_code like 'vfin_role:%' and after_ev.src_kind = 'VFIN_GLOBAL')
               or (cur.action_code = 'vfin_project_accountant' and after_ev.src_kind = 'VFIN_PA' and after_ev.ref_id = cur.scope_ref)
               or (cur.module_code = 'vendor_finance' and after_ev.src_kind = 'VFIN_GLOBAL')
               or (cur.action_code in ('department_approver:' || cur.scope_ref, 'op:leave:approve_department') and after_ev.src_kind = 'LEAVE_APPROVER' and after_ev.ref_id = cur.scope_ref)
               or (cur.module_code = 'leave' and after_ev.src_kind = 'LEAVE_GRANT')
               or (cur.module_code = 'work_reports' and after_ev.src_kind = 'WRD' and after_ev.ref_id = cur.scope_ref)
             )
         )
        then 'EXPECTED_FIX_HISTORICAL_INTRADAY_CREATED_AFTER_ASOF'
        when cur.scope_kind = 'all'
         and cur.action_code in (
           'scope:all',
           'op:dashboard:view_general',
           'op:dashboard:view_workforce_deep',
           'op:dashboard:view_detailed_matrix'
         )
         and not exists (
           select 1
           from ev_valid_caps c
           where c.app_user_id = cur.app_user_id
         )
        then 'EXPECTED_FIX_ORPHAN_ALL_SCOPE'
        when cur.scope_kind = 'all'
         and exists (
           select 1
           from ev_valid_caps c
           where c.app_user_id = cur.app_user_id
         )
         and (
           (
             cur.action_code = 'scope:all'
             and not exists (
               select 1
               from ev_valid_caps c
               where c.app_user_id = cur.app_user_id
                 and c.capability in (
                   'entry_admin', 'entry_privileged_edit', 'entry_create',
                   'report_view', 'report_analytics_view', 'report_review', 'report_assign',
                   'report_template_manage', 'report_form_manage', 'report_delegate',
                   'attendance_view', 'vendor_finance_view', 'vendor_finance_record',
                   'vendor_finance_reconcile', 'vendor_finance_admin', 'worker_edit_history_view',
                   'change_review', 'employment_status.review', 'employment_status.apply',
                   'entry_restore', 'audit_view', 'catalog_master_manage', 'duplicate_cccd_withdraw'
                 )
             )
           )
           or (
             cur.action_code = 'op:dashboard:view_general'
             and not exists (select 1 from ev_full_admin fa where fa.app_user_id = cur.app_user_id)
             and not exists (
               select 1 from ev_valid_caps c
               where c.app_user_id = cur.app_user_id
                 and c.capability in ('report_view', 'entry_privileged_edit')
             )
           )
           or (
             cur.action_code in ('op:dashboard:view_workforce_deep', 'op:dashboard:view_detailed_matrix')
             and not exists (select 1 from ev_full_admin fa where fa.app_user_id = cur.app_user_id)
             and not exists (
               select 1 from ev_valid_caps c
               where c.app_user_id = cur.app_user_id
                 and c.capability = 'entry_privileged_edit'
             )
             and not (
               exists (select 1 from ev_valid_caps c where c.app_user_id = cur.app_user_id and c.capability = 'report_view')
               and exists (select 1 from ev_valid_caps c where c.app_user_id = cur.app_user_id and c.capability = 'report_analytics_view')
             )
           )
           or (
             cur.action_code = 'op:direct_entry:workers_all_tab'
             and not exists (
               select 1 from ev_valid_caps c
               where c.app_user_id = cur.app_user_id
                 and c.capability in ('entry_admin', 'change_review')
             )
           )
           or (
             cur.action_code = 'op:workforce:offboarding_view'
             and not exists (select 1 from ev_full_admin fa where fa.app_user_id = cur.app_user_id)
             and not exists (
               select 1 from ev_valid_caps c
               where c.app_user_id = cur.app_user_id
                 and c.capability = 'entry_privileged_edit'
             )
           )
         )
        then 'EXPECTED_FIX_ALL_SCOPE_WRONG_MODULE_CAPABILITY'
        when cur.action_code in (
          'recruiter_link:verified',
          'assignment:project_manager',
          'op:vendor_finance:pm_project_view',
          'op:salary_advance:pm_request',
          'op:recruitment_posts:pm_manage_project',
          'assignment:team_leader',
          'op:leave:approve_team',
          'op:attendance:report_view',
          'op:workforce:offboarding_view',
          'op:dashboard:view_general'
        )
         and cur.scope_kind in ('project', 'team', 'recruited')
         and exists (
           select 1
           from ev_ambiguous_recruiter_link_users amb
           where amb.app_user_id = cur.app_user_id
         )
        then 'EXPECTED_FIX_AMBIGUOUS_RECRUITER_LINK'
        when (
          (
            cur.action_code = 'op:dashboard:view_general'
            and cur.scope_kind = 'team'
            and not exists (select 1 from ev_full_admin fa where fa.app_user_id = cur.app_user_id)
            and not exists (
              select 1 from ev_valid_caps c
              where c.app_user_id = cur.app_user_id
                and c.capability in ('entry_team', 'report_view', 'entry_privileged_edit')
            )
          )
          or (
            cur.action_code = 'op:dashboard:view_general'
            and cur.scope_kind = 'recruited'
            and not exists (select 1 from ev_full_admin fa where fa.app_user_id = cur.app_user_id)
            and not exists (
              select 1 from ev_valid_caps c
              where c.app_user_id = cur.app_user_id
                and c.capability in ('entry_own', 'report_view', 'entry_privileged_edit')
            )
          )
        )
        then 'EXPECTED_FIX_REPORTING_SCOPE_WITHOUT_CAPABILITY'
        when cur.module_code = 'leave'
         and exists (
           select 1
           from public.leave_employee_profiles lep
           where lep.app_user_id = cur.app_user_id
             and coalesce(lep.is_shared_non_employee, false) = true
         )
        then 'EXPECTED_FIX_SHARED_ACCOUNT_EXCLUSION'
        when cur.action_code in (
          'op:vendor_finance:project_ledger_operate',
          'op:salary_advance:accountant_decide'
        )
         and not exists (
           select 1
           from ev_valid_accounting_dept ad
           where ad.app_user_id = cur.app_user_id
         )
        then 'EXPECTED_FIX_PROJECT_ACCOUNTANT_REQUIRES_ACCOUNTING_DEPT'
        when (
          cur.action_code like 'delegation:%'
          or cur.scope_kind like 'template_%'
        )
         and exists (
           select 1
           from public.work_report_delegations wrd
           where wrd.delegate_app_user_id = cur.app_user_id
             and ('delegation:' || wrd.capability = cur.action_code or 'op:work_reports:' || replace(wrd.capability, 'report_', '') = cur.action_code)
             and (wrd.template_id::text || ':' || coalesce(wrd.scope_team_id::text, '*')) = cur.scope_ref
         )
         and not exists (
           select 1
           from ev_valid_delegations vd
           where vd.delegate_app_user_id = cur.app_user_id
             and ('delegation:' || vd.capability = cur.action_code or 'op:work_reports:' || replace(vd.capability, 'report_', '') = cur.action_code)
             and vd.scope_kind = cur.scope_kind
             and vd.scope_ref = cur.scope_ref
         )
        then 'EXPECTED_FIX_DELEGATION_GRANTOR_INVALID'
        else 'UNEXPECTED_REGRESSION_CHECK_REQUIRED'
      end::text as diff_classification,
      cur.row_layer,
      cur.module_code,
      cur.action_code,
      cur.scope_kind,
      cur.scope_ref,
      cur.grant_source as curr_grant_source,
      null::text as cand_grant_source,
      (cur.valid_from || '..' || cur.valid_to)::text as curr_valid_window,
      null::text as cand_valid_window,
      cur.reconstructibility
    from current_rows cur
    where not exists (
      select 1
      from candidate_rows cand
      where cand.app_user_id = cur.app_user_id
        and cand.row_layer = cur.row_layer
        and cand.module_code = cur.module_code
        and cand.action_code = cur.action_code
        and cand.scope_kind = cur.scope_kind
        and cand.scope_ref = cur.scope_ref
    )
  ) b
),
gained_rows as (
  select
    cand.as_of_ts,
    cand.as_of_date,
    cand.app_user_id,
    (left(cand.app_user_id::text, 8) || '...')::text as account_id_mask,
    'GAINED_IN_CANDIDATE'::text as diff_status,
    case
      when cand.row_layer = 'MODULE_OP'
       and cand.module_code = 'dashboard'
       and cand.action_code = 'op:dashboard:view_general'
       and (
         (
           cand.scope_kind = 'team'
           and exists (
             select 1 from current_rows cur_all
             where cur_all.app_user_id = cand.app_user_id
               and cur_all.row_layer = 'MODULE_OP'
               and cur_all.action_code = 'op:dashboard:view_general'
               and cur_all.scope_kind = 'all'
           )
           and not exists (select 1 from ev_full_admin fa where fa.app_user_id = cand.app_user_id)
           and not exists (
             select 1 from ev_valid_caps c
             where c.app_user_id = cand.app_user_id
               and c.capability in ('report_view', 'entry_privileged_edit')
           )
           and exists (
             select 1 from ev_valid_team_scope ts
             where ts.app_user_id = cand.app_user_id
               and ts.team_id_text = cand.scope_ref
           )
           and exists (
             select 1 from ev_valid_caps c
             where c.app_user_id = cand.app_user_id
               and c.capability in ('entry_team', 'report_view', 'entry_privileged_edit')
           )
         )
         or (
           cand.scope_kind = 'recruited'
           and exists (
             select 1 from current_rows cur_hi
             where cur_hi.app_user_id = cand.app_user_id
               and cur_hi.row_layer = 'MODULE_OP'
               and cur_hi.action_code = 'op:dashboard:view_general'
               and cur_hi.scope_kind in ('all', 'team')
           )
           and not exists (
             select 1 from ev_valid_all_scope sa
             join ev_valid_caps c on c.app_user_id = sa.app_user_id
             where sa.app_user_id = cand.app_user_id
               and c.capability in ('report_view', 'entry_privileged_edit')
           )
           and not exists (
             select 1 from ev_valid_all_scope sa
             join ev_full_admin fa on fa.app_user_id = sa.app_user_id
             where sa.app_user_id = cand.app_user_id
           )
           and not exists (
             select 1 from ev_valid_team_scope ts
             join ev_valid_caps c on c.app_user_id = ts.app_user_id
             where ts.app_user_id = cand.app_user_id
               and c.capability in ('entry_team', 'report_view', 'entry_privileged_edit')
           )
           and exists (
             select 1 from ev_unambiguous_recruiter_links url
             where url.app_user_id = cand.app_user_id
               and url.recruiter_id::text = cand.scope_ref
           )
           and (
             exists (
               select 1 from ev_valid_caps c
               where c.app_user_id = cand.app_user_id
                 and c.capability in ('entry_own', 'report_view', 'entry_privileged_edit')
             )
             or exists (select 1 from ev_full_admin fa where fa.app_user_id = cand.app_user_id)
           )
         )
       )
      then 'EXPECTED_FIX_DASHBOARD_FALLBACK_AFTER_INVALID_ALL_SCOPE'
      when exists (
        select 1
        from params p
        where cand.as_of_ts < p.current_ts
      )
       and exists (
         select 1
         from ev_intraday_closed_before_asof intra
         where intra.app_user_id = cand.app_user_id
           and (
             (cand.action_code in ('assignment:project_manager', 'op:vendor_finance:pm_project_view', 'op:salary_advance:pm_request', 'op:recruitment_posts:pm_manage_project') and intra.src_kind = 'PM' and intra.ref_id = cand.scope_ref)
             or (cand.action_code like 'dept_member:%' and intra.src_kind = 'DEPT' and intra.ref_id = cand.scope_ref)
             or (cand.action_code in ('op:vendor_finance:project_ledger_operate', 'op:salary_advance:accountant_decide') and intra.src_kind in ('DEPT', 'VFIN_PA'))
             or (cand.action_code like 'vfin_role:%' and intra.src_kind = 'VFIN_GLOBAL')
             or (cand.action_code = 'vfin_project_accountant' and intra.src_kind = 'VFIN_PA' and intra.ref_id = cand.scope_ref)
             or (cand.module_code = 'vendor_finance' and intra.src_kind in ('VFIN_GLOBAL', 'VFIN_PA'))
             or (cand.module_code = 'leave' and intra.src_kind in ('LEAVE_GRANT', 'LEAVE_APPROVER', 'TL'))
             or (cand.action_code in ('assignment:team_leader', 'op:attendance:report_view', 'op:workforce:offboarding_view') and intra.src_kind = 'TL' and intra.ref_id = cand.scope_ref)
             or (cand.module_code = 'work_reports' and intra.src_kind = 'WRD' and intra.ref_id = cand.scope_ref)
           )
       )
      then 'EXPECTED_FIX_HISTORICAL_INTRADAY_RECONSTRUCTED'
      else 'UNEXPECTED_WIDENING_CHECK_REQUIRED'
    end::text as diff_classification,
    case
      when cand.row_layer = 'MODULE_OP'
       and cand.module_code = 'dashboard'
       and cand.action_code = 'op:dashboard:view_general'
       and cand.scope_kind in ('team', 'recruited')
      then 'Dropping invalid/unpaired broader-scope Dashboard access restores legitimate capability-backed narrow scope'
      when exists (
        select 1
        from ev_intraday_closed_before_asof intra
        where intra.app_user_id = cand.app_user_id
      )
      then 'Candidate reconstructed historical intra-day authority valid before later same-day revocation/handover timestamp'
      else 'Candidate grants access not present in current runtime snapshot'
    end::text as t0_decision_reason,
    cand.row_layer,
    cand.module_code,
    cand.action_code,
    cand.scope_kind,
    cand.scope_ref,
    null::text as curr_grant_source,
    cand.grant_source as cand_grant_source,
    null::text as curr_valid_window,
    (cand.valid_from || '..' || cand.valid_to)::text as cand_valid_window,
    cand.reconstructibility
  from candidate_rows cand
  where not exists (
    select 1
    from current_rows cur
    where cur.app_user_id = cand.app_user_id
      and cur.row_layer = cand.row_layer
      and cur.module_code = cand.module_code
      and cur.action_code = cand.action_code
      and cur.scope_kind = cand.scope_kind
      and cur.scope_ref = cand.scope_ref
  )
)
select *
from (
  select * from lost_rows
  union all
  select * from gained_rows
) all_diffs
order by
  diff_classification,
  module_code,
  row_layer,
  app_user_id,
  action_code,
  scope_kind,
  scope_ref;
