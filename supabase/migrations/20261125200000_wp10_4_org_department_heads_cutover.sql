-- =============================================================================
-- WP10-4: Cut Over Leave & Attendance Explanation Department Routing/Approver
--         Authority Exclusively to Org Department Heads (organization_department_heads)
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. public.leave_management__internal_resolve_routing_snapshot(uuid, date):
--      Remove leave_department_approvers fallback and compat_dept_approver_id /
--      is_requester_compat_dept_approver; route non-RECRUITMENT, non-MANAGEMENT_BOD
--      departments exclusively via active eligible Org Department Head, falling
--      back to ADMIN_BOD_FALLBACK ('DEPARTMENT_APPROVER_NOT_CONFIGURED') otherwise.
--   2. public.leave_management__internal_resolve_authority(uuid, uuid):
--      Remove leave_department_approvers compat query; is_department_approver
--      comes strictly from active eligible Org Department Heads, preserving
--      v_has_pending_snapshot_approval and bootstrap executor grant.
--   3. public.leave_management__internal_can_actor_decide_request(uuid, public.leave_requests, date):
--      Preserve frozen PENDING primary_approver_app_user_id contract; for
--      APPROVED cancellation, verify active Org Department Head via
--      leave_management__internal_resolve_department_head_user without legacy
--      leave_department_approvers fallback.
--   4. public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer, text):
--      Return read-only active eligible Org Department Heads (with additive
--      department_id/code/name/system_key) instead of leave_department_approvers.
--   5. public.leave_management_set_department_approver_admin(...):
--      Keep exact 9-arg RPC signature restricted to service_role; assert
--      admin/BoD then fail closed with PT409 LEAVE_DEPARTMENT_APPROVER_MANAGED_BY_ORG_ADMIN.
--   6. public.direct_entry_authz_get_account_groups_admin(uuid, uuid, uuid):
--      Remove LEAVE_DEPARTMENT_APPROVER query and align DEPARTMENT_HEAD query
--      with active person/membership/account-link/enabled-user authority.
--   7. Preserve public.leave_department_approvers table & historical rows until
--      WP10-7; assert owner alignment, SECURITY DEFINER, search_path, ACLs, and
--      zero pg_proc prosrc references to leave_department_approvers in public.
-- =============================================================================

begin;

-- =============================================================================
-- 1. Routing Snapshot Resolver (Leave & Attendance Explanations)
-- =============================================================================

create or replace function public.leave_management__internal_resolve_routing_snapshot(
  p_app_user_id uuid,
  p_as_of date default public.leave_management__internal_business_date()
)
returns table(
  routing jsonb,
  routed_department_id uuid,
  routed_department_code text,
  routed_department_name text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_snap record;
  v_routing jsonb;
begin
  with now_ctx as materialized (
    select pg_catalog.clock_timestamp() as v_now
  ),
  user_ctx as (
    select (p.app_user_id is not null) as has_profile,
           (
             p.app_user_id is not null
             and p.employment_status in ('PROBATION', 'OFFICIAL')
             and p.work_start_date is not null
             and (
               p.employment_status <> 'OFFICIAL'
               or p.official_effective_date is not null
             )
           ) as profile_configured
      from (select 1 as anchor) a
      left join public.direct_entry_app_users u
        on u.app_user_id = p_app_user_id
      left join public.leave_employee_profiles p
        on p.app_user_id = p_app_user_id
  ),
  active_link as (
    select l.person_id,
           op.status as person_status
      from now_ctx nc
      join public.direct_entry_app_users u
        on u.app_user_id = p_app_user_id
      join public.organization_account_person_links l
        on l.app_user_id = u.app_user_id
       and l.started_at <= nc.v_now
       and (l.ended_at is null or (l.ended_at > l.started_at and nc.v_now < l.ended_at))
      join public.organization_persons op
        on op.person_id = l.person_id
     order by l.started_at desc, l.link_id desc
     limit 1
  ),
  active_person_dept as (
    select d.department_id,
           d.code as department_code,
           d.name as department_name,
           d.system_key as department_system_key
      from now_ctx nc
      join active_link al
        on al.person_status = 'ACTIVE'
      join public.organization_person_department_memberships m
        on m.person_id = al.person_id
       and m.started_at <= nc.v_now
       and (m.ended_at is null or (m.ended_at > m.started_at and nc.v_now < m.ended_at))
      join public.organization_departments d
        on d.department_id = m.department_id
       and d.is_active = true
     order by m.started_at desc, m.membership_id desc
     limit 1
  ),
  resolved_org as (
    select (al.person_id is not null) as has_active_person_link,
           apd.department_id,
           apd.department_code,
           apd.department_name,
           apd.department_system_key,
           case
             when al.person_id is not null then coalesce(apd.department_system_key, 'UNCLASSIFIED')
             else 'UNCLASSIFIED'
           end as unit_kind
      from user_ctx uc
      left join active_link al on true
      left join active_person_dept apd on true
  ),
  dept_head_state as (
    select exists (
             select 1
               from now_ctx nc
               join public.organization_department_heads dh
                 on dh.department_id = ro.department_id
               join public.organization_departments d
                 on d.department_id = dh.department_id
                and d.is_active = true
              where ro.department_id is not null
                and dh.started_at <= nc.v_now
                and (dh.ended_at is null or (dh.ended_at > dh.started_at and nc.v_now < dh.ended_at))
           ) as has_open_org_head,
           (
             select u.app_user_id
               from now_ctx nc
               join public.organization_department_heads dh
                 on dh.department_id = ro.department_id
               join public.organization_departments d
                 on d.department_id = dh.department_id
                and d.is_active = true
               join public.organization_persons op
                 on op.person_id = dh.person_id
                and op.status = 'ACTIVE'
               join public.organization_person_department_memberships m
                 on m.person_id = dh.person_id
                and m.department_id = dh.department_id
                and m.started_at <= nc.v_now
                and (m.ended_at is null or (m.ended_at > m.started_at and nc.v_now < m.ended_at))
               join public.organization_account_person_links l
                 on l.person_id = dh.person_id
                and l.started_at <= nc.v_now
                and (l.ended_at is null or (l.ended_at > l.started_at and nc.v_now < l.ended_at))
               join public.direct_entry_app_users u
                 on u.app_user_id = l.app_user_id
                and u.enabled = true
              where ro.department_id is not null
                and dh.started_at <= nc.v_now
                and (dh.ended_at is null or (dh.ended_at > dh.started_at and nc.v_now < dh.ended_at))
              order by dh.started_at desc, dh.head_assignment_id desc
              limit 1
           ) as org_head_app_user_id
      from resolved_org ro
  ),
  requester_roles as (
    select exists (
             select 1
               from public.direct_entry_team_leader_assignments tla
              where tla.leader_app_user_id = p_app_user_id
                and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, p_as_of)
           ) as is_requester_team_leader,
           exists (
             select 1
               from now_ctx nc
               join public.organization_department_heads dh
                 on dh.started_at <= nc.v_now
                and (dh.ended_at is null or (dh.ended_at > dh.started_at and nc.v_now < dh.ended_at))
               join public.organization_departments d
                 on d.department_id = dh.department_id
                and d.is_active = true
               join public.organization_persons op
                 on op.person_id = dh.person_id
                and op.status = 'ACTIVE'
               join public.organization_person_department_memberships m
                 on m.person_id = dh.person_id
                and m.department_id = dh.department_id
                and m.started_at <= nc.v_now
                and (m.ended_at is null or (m.ended_at > m.started_at and nc.v_now < m.ended_at))
               join public.organization_account_person_links l
                 on l.person_id = dh.person_id
                and l.app_user_id = p_app_user_id
                and l.started_at <= nc.v_now
                and (l.ended_at is null or (l.ended_at > l.started_at and nc.v_now < l.ended_at))
               join public.direct_entry_app_users u
                 on u.app_user_id = l.app_user_id
                and u.enabled = true
           ) as is_requester_dept_head
  ),
  recruiter_ctx as (
    select l.recruiter_id
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r on r.recruiter_id = l.recruiter_id
     where l.app_user_id = p_app_user_id
       and l.verified = true
       and l.is_current = true
       and not coalesce(l.suspended_by_account_disable, false)
       and r.active = true
       and coalesce(r.personnel_code, '') <> '__system_vendor__'
     order by l.valid_from desc, l.link_id desc
     limit 1
  ),
  team_ctx as (
    select count(*)::integer as team_count,
           (pg_catalog.array_agg(t.team_id order by t.code))[1] as team_id,
           (pg_catalog.array_agg(t.code order by t.code))[1] as team_code,
           (pg_catalog.array_agg(t.display_name order by t.code))[1] as team_name
      from recruiter_ctx rc
      join public.recruiter_team_memberships rtm
        on rtm.recruiter_id = rc.recruiter_id
      join public.teams t
        on t.team_id = rtm.team_id
     where t.active = true
       and t.code <> '__system_vendor__'
       and public.direct_entry__internal_recruiter_team_membership_effective(rtm.membership_id, p_as_of)
  ),
  leader_ctx as (
    select count(distinct tla.leader_app_user_id)::integer as leader_count,
           (pg_catalog.array_agg(tla.leader_app_user_id order by tla.valid_from desc, tla.assignment_id desc))[1] as leader_app_user_id
      from team_ctx tc
      join public.direct_entry_team_leader_assignments tla
        on tla.team_id = tc.team_id
      join public.direct_entry_app_users lu
        on lu.app_user_id = tla.leader_app_user_id
     where tc.team_count = 1
       and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, p_as_of)
  )
  select uc.has_profile,
         uc.profile_configured,
         ro.department_id,
         ro.department_code,
         ro.department_name,
         ro.department_system_key,
         ro.unit_kind,
         dhs.has_open_org_head,
         dhs.org_head_app_user_id,
         rr.is_requester_team_leader,
         rr.is_requester_dept_head,
         rc.recruiter_id,
         coalesce(tc.team_count, 0) as team_count,
         tc.team_id,
         tc.team_code,
         tc.team_name,
         coalesce(lc.leader_count, 0) as leader_count,
         lc.leader_app_user_id
    into v_snap
    from user_ctx uc
    cross join resolved_org ro
    cross join dept_head_state dhs
    cross join requester_roles rr
    left join recruiter_ctx rc on true
    left join team_ctx tc on true
    left join leader_ctx lc on true;

  if (
       v_snap.is_requester_team_leader
       and (
         v_snap.department_id is null
         or coalesce(v_snap.department_system_key, '') in ('RECRUITMENT', 'MANAGEMENT_BOD')
       )
       and v_snap.unit_kind not in ('MARKETING', 'IT', 'ACCOUNTING')
     )
     or v_snap.is_requester_dept_head
     or v_snap.unit_kind = 'MANAGEMENT_BOD' then
    v_routing := pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_DIRECT',
      'unit_kind', case when v_snap.unit_kind = 'UNCLASSIFIED' and v_snap.is_requester_team_leader then 'RECRUITMENT' else v_snap.unit_kind end,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', null,
      'profile_configured', v_snap.profile_configured
    );
    return query select v_routing, null::uuid, null::text, null::text;
    return;
  end if;

  -- Non-Recruitment, non-BoD departments (MARKETING, IT, ACCOUNTING, AND dynamic custom departments)
  if (
    v_snap.department_id is not null
    and coalesce(v_snap.department_system_key, '') not in ('RECRUITMENT', 'MANAGEMENT_BOD')
  ) or v_snap.unit_kind in ('MARKETING', 'IT', 'ACCOUNTING') then
    if v_snap.has_open_org_head
       and v_snap.org_head_app_user_id is not null
       and v_snap.org_head_app_user_id <> p_app_user_id then
      v_routing := pg_catalog.jsonb_build_object(
        'route_kind', 'DEPARTMENT_HEAD',
        'unit_kind', v_snap.unit_kind,
        'primary_approver_app_user_id', v_snap.org_head_app_user_id,
        'team_id', null,
        'team_code', null,
        'team_name', null,
        'fallback_reason', null,
        'profile_configured', v_snap.profile_configured
      );
      return query select v_routing, v_snap.department_id, v_snap.department_code, v_snap.department_name;
      return;
    end if;

    v_routing := pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_FALLBACK',
      'unit_kind', v_snap.unit_kind,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', 'DEPARTMENT_APPROVER_NOT_CONFIGURED',
      'profile_configured', v_snap.profile_configured
    );
    return query select v_routing, null::uuid, null::text, null::text;
    return;
  end if;

  if v_snap.recruiter_id is not null then
    if v_snap.team_count = 1 then
      if v_snap.leader_count = 1
         and v_snap.leader_app_user_id is not null
         and v_snap.leader_app_user_id <> p_app_user_id then
        v_routing := pg_catalog.jsonb_build_object(
          'route_kind', 'TEAM_LEADER',
          'unit_kind', case when v_snap.unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_snap.unit_kind end,
          'primary_approver_app_user_id', v_snap.leader_app_user_id,
          'team_id', v_snap.team_id,
          'team_code', v_snap.team_code,
          'team_name', v_snap.team_name,
          'fallback_reason', null,
          'profile_configured', v_snap.profile_configured
        );
        return query select v_routing, null::uuid, null::text, null::text;
        return;
      end if;

      v_routing := pg_catalog.jsonb_build_object(
        'route_kind', 'ADMIN_BOD_FALLBACK',
        'unit_kind', case when v_snap.unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_snap.unit_kind end,
        'primary_approver_app_user_id', null,
        'team_id', v_snap.team_id,
        'team_code', v_snap.team_code,
        'team_name', v_snap.team_name,
        'fallback_reason', case when v_snap.leader_count = 0 then 'TEAM_WITHOUT_ACTIVE_LEADER' else 'TEAM_MULTIPLE_LEADERS_OR_SELF' end,
        'profile_configured', v_snap.profile_configured
      );
      return query select v_routing, null::uuid, null::text, null::text;
      return;
    end if;

    v_routing := pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_FALLBACK',
      'unit_kind', case when v_snap.unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_snap.unit_kind end,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', case when v_snap.team_count = 0 then 'RECRUITER_WITHOUT_ACTIVE_TEAM' else 'RECRUITER_MULTI_ACTIVE_TEAMS' end,
      'profile_configured', v_snap.profile_configured
    );
    return query select v_routing, null::uuid, null::text, null::text;
    return;
  end if;

  v_routing := pg_catalog.jsonb_build_object(
    'route_kind', 'ADMIN_BOD_FALLBACK',
    'unit_kind', v_snap.unit_kind,
    'primary_approver_app_user_id', null,
    'team_id', null,
    'team_code', null,
    'team_name', null,
    'fallback_reason', case when not v_snap.has_profile or not v_snap.profile_configured then 'PROFILE_UNCONFIGURED_OR_UNMAPPED' else 'UNMAPPED_UNIT_OR_RECRUITER' end,
    'profile_configured', v_snap.profile_configured
  );
  return query select v_routing, null::uuid, null::text, null::text;
end;
$function$;

revoke all on function public.leave_management__internal_resolve_routing_snapshot(uuid, date)
  from public, anon, authenticated, service_role;

-- =============================================================================
-- 2. Authority Resolver (Org Department Heads only; preserves PENDING snapshots)
-- =============================================================================

create or replace function public.leave_management__internal_resolve_authority(
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
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.leave_management__internal_business_date();
  v_is_shared boolean := false;
  v_is_full_admin boolean := false;
  v_is_bod boolean := false;
  v_is_admin_bod_grant boolean := false;
  v_is_hr_operator boolean := false;
  v_is_hr_report_viewer boolean := false;
  v_is_team_leader boolean := false;
  v_is_dept_head boolean := false;
  v_is_dept_approver boolean := false;
  v_has_pending_snapshot_approval boolean := false;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'Direct entry actor mapping is not active'
      using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  v_is_shared := public.attendance__internal_is_non_employee_account(p_app_user_id, v_now);

  if not v_is_shared then
    v_is_full_admin := (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null)
    );

    v_is_bod := (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
      or (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_analytics_view', 'ALL', null)
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_view', 'ALL', null)
      )
    );

    -- D4 cutover: Leave module roles resolve EXCLUSIVELY from active permission groups
    -- (historical leave_module_grants rows stay preserved for audit, never read as runtime fallback).
    select public.direct_entry_authz__internal_group_has_module_role(
             p_app_user_id, 'leave', 'LEAVE_ADMIN_BOD_APPROVER'
           ),
           public.direct_entry_authz__internal_group_has_module_role(
             p_app_user_id, 'leave', 'HR_LEAVE_OPERATOR'
           ),
           public.direct_entry_authz__internal_group_has_module_role(
             p_app_user_id, 'leave', 'HR_REPORT_VIEWER'
           )
      into v_is_admin_bod_grant, v_is_hr_operator, v_is_hr_report_viewer;

    select exists (
             select 1
               from public.direct_entry_team_leader_assignments tla
              where tla.leader_app_user_id = p_app_user_id
                and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
           )
      into v_is_team_leader;

    select exists (
             select 1
               from public.organization_department_heads dh
               join public.organization_departments d
                 on d.department_id = dh.department_id
                and d.is_active = true
              where dh.started_at <= v_now
                and (dh.ended_at is null or (dh.ended_at > dh.started_at and v_now < dh.ended_at))
                and public.leave_management__internal_resolve_department_head_user(dh.department_id, v_now) = p_app_user_id
           )
      into v_is_dept_head;

    v_is_dept_approver := v_is_dept_head;

    select (
             exists (
               select 1
                 from public.leave_requests lr
                where lr.status = 'PENDING'
                  and lr.primary_approver_app_user_id = p_app_user_id
                  and lr.app_user_id <> p_app_user_id
             )
             or exists (
               select 1
                 from public.attendance_explanations ae
                where ae.status = 'PENDING'
                  and ae.primary_approver_app_user_id = p_app_user_id
                  and ae.app_user_id <> p_app_user_id
             )
           )
      into v_has_pending_snapshot_approval;
  end if;

  return pg_catalog.jsonb_build_object(
    'app_user_id', p_app_user_id,
    'is_full_admin', v_is_full_admin,
    'is_bod', (v_is_bod or v_is_admin_bod_grant),
    'is_hr_operator', v_is_hr_operator,
    'is_hr_report_viewer', v_is_hr_report_viewer,
    'is_team_leader', v_is_team_leader,
    'is_department_approver', v_is_dept_approver,
    'can_submit_request', (not v_is_shared),
    'can_approve_requests', (
      not v_is_shared
      and (
        v_is_full_admin
        or v_is_bod
        or v_is_admin_bod_grant
        or v_is_team_leader
        or v_is_dept_approver
        or v_has_pending_snapshot_approval
      )
    ),
    'can_view_monthly_report', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_hr_operator or v_is_hr_report_viewer)),
    'can_manage_config', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_hr_operator))
  );
end;
$function$;

revoke all on function public.leave_management__internal_resolve_authority(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.leave_management__internal_resolve_authority(uuid, uuid)
  to direct_entry_catalog_bootstrap_executor;

-- =============================================================================
-- 3. Decision & APPROVED-Cancellation Guard (Leave & Attendance Explanations)
-- =============================================================================

create or replace function public.leave_management__internal_can_actor_decide_request(
  p_actor_app_user_id uuid,
  p_request public.leave_requests,
  p_as_of date default public.leave_management__internal_business_date()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_as_of date := coalesce(p_as_of, public.leave_management__internal_business_date());
  v_user public.direct_entry_app_users%rowtype;
  v_auth jsonb;
  v_is_admin_or_bod boolean := false;
  v_is_live_route_approver boolean := false;
  v_dept_id uuid := p_request.routed_department_id;
begin
  if p_actor_app_user_id is null or p_request.request_id is null then
    return false;
  end if;

  if p_actor_app_user_id = p_request.app_user_id then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id;

  if not found or not v_user.enabled then
    return false;
  end if;

  v_auth := public.leave_management__internal_resolve_authority(v_user.auth_subject, p_actor_app_user_id);
  v_is_admin_or_bod := (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  );

  if v_is_admin_or_bod then
    return true;
  end if;

  -- Pending (and non-APPROVED terminal states so concurrent OCC / invalid-transition errors
  -- take precedence over 403) honor ONLY the frozen snapshot primary_approver_app_user_id
  -- (or Admin/BoD): zero silent bulk re-routing to replacement TL/HEAD or another dept's HEAD.
  if coalesce(p_request.status, 'PENDING') <> 'APPROVED' then
    return (
      p_request.primary_approver_app_user_id is not null
      and p_request.primary_approver_app_user_id = p_actor_app_user_id
    );
  end if;

  -- Cancelling an already-APPROVED leave request by a non-Admin/BoD requires BOTH being the
  -- snapshotted primary approver AND still holding active authority on that snapshotted route.
  if p_request.status = 'APPROVED'
     and p_request.primary_approver_app_user_id is not null
     and p_request.primary_approver_app_user_id = p_actor_app_user_id then
    if p_request.route_kind = 'TEAM_LEADER' and p_request.routed_team_id is not null then
      select exists (
               select 1
                 from public.direct_entry_team_leader_assignments tla
                where tla.team_id = p_request.routed_team_id
                  and tla.leader_app_user_id = p_actor_app_user_id
                  and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_as_of)
             )
        into v_is_live_route_approver;
      return v_is_live_route_approver;
    end if;

    if p_request.route_kind = 'DEPARTMENT_HEAD' then
      if v_dept_id is null and p_request.unit_kind_snapshot in ('MARKETING', 'IT', 'ACCOUNTING') then
        select d.department_id
          into v_dept_id
          from public.organization_departments d
         where d.system_key = p_request.unit_kind_snapshot
           and d.is_active = true
         limit 1;
      end if;

      if v_dept_id is not null
         and public.leave_management__internal_resolve_department_head_user(v_dept_id, v_now) = p_actor_app_user_id then
        return true;
      end if;
    end if;
  end if;

  return false;
end;
$function$;

revoke all on function public.leave_management__internal_can_actor_decide_request(uuid, public.leave_requests, date)
  from public, anon, authenticated, service_role;

-- =============================================================================
-- 4. Leave Admin Overview (Read-only Org Department Heads projection)
-- =============================================================================

create or replace function public.leave_management_get_admin_overview(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_search text,
  p_limit integer,
  p_offset integer,
  p_account_status text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_search text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, ''))), '');
  v_account_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_account_status, '')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 300));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_dept_approvers jsonb := '[]'::jsonb;
  v_module_grants jsonb := '[]'::jsonb;
  v_employees jsonb := '[]'::jsonb;
  v_total_employees integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_account_status not in ('ACTIVE', 'INACTIVE', 'ALL') then
    raise exception 'LEAVE_FILTER_INVALID'
      using errcode = '22023';
  end if;

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  v_carry_over_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'approver_assignment_id', head_row.head_assignment_id,
               'unit_kind', coalesce(head_row.system_key, 'UNCLASSIFIED'),
               'department_id', head_row.department_id,
               'department_code', head_row.code,
               'department_name', head_row.name,
               'department_system_key', head_row.system_key,
               'approver_app_user_id', head_row.approver_app_user_id,
               'approver', public.leave_management__internal_account_summary(head_row.approver_app_user_id),
               'valid_from', (head_row.started_at at time zone 'Asia/Ho_Chi_Minh')::date,
               'valid_to', null,
               'is_current', true,
               'reason', head_row.reason,
               'row_version', head_row.dept_version
             )
             order by coalesce(head_row.system_key, 'UNCLASSIFIED') asc,
                      pg_catalog.lower(head_row.name) asc,
                      head_row.department_id asc
           ),
           '[]'::jsonb
         )
    into v_dept_approvers
    from (
      select d.department_id,
             d.code,
             d.name,
             d.system_key,
             d.version as dept_version,
             dh.head_assignment_id,
             dh.started_at,
             dh.reason,
             public.leave_management__internal_resolve_department_head_user(d.department_id, v_now) as approver_app_user_id
        from public.organization_departments d
        join lateral (
          select h.head_assignment_id,
                 h.started_at,
                 h.reason
            from public.organization_department_heads h
           where h.department_id = d.department_id
             and h.started_at <= v_now
             and (h.ended_at is null or (h.ended_at > h.started_at and v_now < h.ended_at))
           order by h.started_at desc, h.head_assignment_id desc
           limit 1
        ) dh on true
       where d.is_active = true
         and coalesce(d.system_key, '') not in ('RECRUITMENT', 'MANAGEMENT_BOD')
    ) head_row
   where head_row.approver_app_user_id is not null;

  -- D4 cutover: project active group-managed Leave module roles (read-only in Leave admin overview)
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'grant_id', m.membership_id,
               'app_user_id', m.app_user_id,
               'account', public.leave_management__internal_account_summary(m.app_user_id),
               'role_code', mr.role_code,
               'valid_from', (m.started_at at time zone 'Asia/Ho_Chi_Minh')::date,
               'valid_to', null,
               'is_current', true,
               'reason', 'Qua nhóm quyền: ' || grp.name,
               'row_version', grp.version
             )
             order by mr.role_code asc, m.created_at desc, m.membership_id asc
           ),
           '[]'::jsonb
         )
    into v_module_grants
    from public.authz_user_group_members m
    join public.direct_entry_app_users u
      on u.app_user_id = m.app_user_id
     and u.enabled = true
    join public.authz_user_groups grp
      on grp.group_id = m.group_id
     and grp.active = true
     and grp.team_id is null
     and grp.is_system_admin = false
    join public.organization_departments dept
      on dept.department_id = grp.department_id
     and dept.is_active = true
    join public.authz_user_group_module_roles mr
      on mr.group_id = grp.group_id
     and mr.ended_at is null
     and mr.started_at <= v_now
     and mr.module_code = 'leave'
   where m.ended_at is null
     and m.started_at <= v_now;

  select count(*)::integer
    into v_total_employees
    from public.direct_entry_app_users u
    left join lateral (
      select op.full_name, op.employee_code
        from public.organization_account_person_links ol
        join public.organization_persons op on op.person_id = ol.person_id
       where ol.app_user_id = u.app_user_id
         and ol.started_at <= v_now
         and (ol.ended_at is null or (ol.ended_at > ol.started_at and v_now < ol.ended_at))
       order by ol.started_at desc, ol.link_id desc
       limit 1
    ) org_p on true
    left join lateral (
      select r.display_name, r.personnel_code
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
   where (
     v_account_status = 'ALL'
     or (v_account_status = 'ACTIVE' and u.enabled = true)
     or (v_account_status = 'INACTIVE' and u.enabled = false)
   )
     and (
       v_search is null
       or pg_catalog.lower(coalesce(org_p.full_name, linked.display_name, u.display_name, '')) like '%' || v_search || '%'
       or pg_catalog.lower(coalesce(org_p.employee_code, linked.personnel_code, '')) like '%' || v_search || '%'
     );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'account', public.leave_management__internal_account_summary(sub.app_user_id),
               'profile', case
                 when sub.profile_found then
                   pg_catalog.jsonb_build_object(
                     'app_user_id', sub.app_user_id,
                     'employment_status', sub.employment_status,
                     'unit_kind', sub.unit_kind,
                     'work_start_date', sub.work_start_date,
                     'official_effective_date', sub.official_effective_date,
                     'next_seniority_effective_date', sub.next_seniority_effective_date,
                     'next_seniority_units', sub.next_seniority_units,
                     'notes', sub.notes,
                     'row_version', sub.row_version
                   )
                 else
                   pg_catalog.jsonb_build_object(
                     'app_user_id', sub.app_user_id,
                     'employment_status', 'UNCONFIGURED',
                     'unit_kind', sub.unit_kind,
                     'work_start_date', null,
                     'official_effective_date', null,
                     'next_seniority_effective_date', null,
                     'next_seniority_units', 0,
                     'notes', null,
                     'row_version', 0
                   )
               end,
               'org_department', sub.org_department,
               'routing', public.leave_management__internal_resolve_routing(sub.app_user_id, v_today),
               'balance', public.leave_management__internal_compute_balance_summary(sub.app_user_id, v_year, v_today)
             )
             order by sub.sort_name asc, sub.app_user_id asc
           ),
           '[]'::jsonb
         )
    into v_employees
    from (
      select u.app_user_id,
             coalesce(org_p.full_name, linked.display_name, u.display_name) as sort_name,
             (p.app_user_id is not null) as profile_found,
             coalesce(p.employment_status, 'UNCONFIGURED') as employment_status,
             case
               when coalesce(org_p.has_active_person_link, false) then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
               else 'UNCLASSIFIED'
             end as unit_kind,
             pg_catalog.jsonb_build_object(
               'has_active_person_link', coalesce(org_p.has_active_person_link, false),
               'person_status', org_p.person_status,
               'department_id', org_p.department_id,
               'department_code', org_p.department_code,
               'department_name', org_p.department_name,
               'department_system_key', org_p.department_system_key
             ) as org_department,
             p.work_start_date,
             p.official_effective_date,
             p.next_seniority_effective_date,
             coalesce(p.next_seniority_units, 0) as next_seniority_units,
             p.notes,
             coalesce(p.row_version, 0) as row_version
        from public.direct_entry_app_users u
        left join public.leave_employee_profiles p
          on p.app_user_id = u.app_user_id
        left join lateral (
          select *
            from public.leave_management__internal_resolve_person_department(u.app_user_id, v_now)
        ) org_p on true
        left join lateral (
          select r.display_name, r.personnel_code
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = u.app_user_id
             and l.verified = true
             and l.is_current = true
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) linked on true
       where (
         v_account_status = 'ALL'
         or (v_account_status = 'ACTIVE' and u.enabled = true)
         or (v_account_status = 'INACTIVE' and u.enabled = false)
       )
         and (
           v_search is null
           or pg_catalog.lower(coalesce(org_p.full_name, linked.display_name, u.display_name, '')) like '%' || v_search || '%'
           or pg_catalog.lower(coalesce(org_p.employee_code, linked.personnel_code, '')) like '%' || v_search || '%'
         )
       order by coalesce(org_p.full_name, linked.display_name, u.display_name) asc, u.app_user_id asc
       limit v_limit
      offset v_offset
    ) sub;

  return pg_catalog.jsonb_build_object(
    'as_of_date', v_today,
    'leave_year', v_year,
    'authority', v_auth,
    'policy', pg_catalog.jsonb_build_object(
      'annual_base_units', v_policy.annual_base_units,
      'monthly_accrual_units', v_policy.monthly_accrual_units,
      'default_seniority_years', v_policy.default_seniority_years,
      'default_seniority_step_units', v_policy.default_seniority_step_units,
      'carry_over_expiry_month', v_policy.carry_over_expiry_month,
      'carry_over_expiry_day', v_policy.carry_over_expiry_day,
      'carry_over_expires_after_date', v_carry_over_expiry,
      'row_version', v_policy.row_version
    ),
    'department_approvers', v_dept_approvers,
    'module_grants', v_module_grants,
    'total_employees', v_total_employees,
    'account_status', v_account_status,
    'limit', v_limit,
    'offset', v_offset,
    'employees', v_employees
  );
end;
$function$;

revoke all on function public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer, text)
  to service_role;

-- =============================================================================
-- 5. Legacy Department Approver Writer Retirement (Fail-Closed PT409)
-- =============================================================================

create or replace function public.leave_management_set_department_approver_admin(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_unit_kind text,
  p_approver_app_user_id uuid,
  p_valid_from date,
  p_expected_row_version integer,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  ) then
    raise exception 'LEAVE_DEPARTMENT_APPROVER_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  raise exception 'LEAVE_DEPARTMENT_APPROVER_MANAGED_BY_ORG_ADMIN'
    using errcode = 'PT409';
end;
$function$;

revoke all on function public.leave_management_set_department_approver_admin(
  uuid, uuid, text, uuid, date, integer, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.leave_management_set_department_approver_admin(
  uuid, uuid, text, uuid, date, integer, text, text, text
) to service_role;

-- =============================================================================
-- 6. Permission Group Account Detail (DEPARTMENT_HEAD aligned; legacy removed)
-- =============================================================================

create or replace function public.direct_entry_authz_get_account_groups_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_target public.direct_entry_app_users%rowtype;
  v_memberships jsonb := '[]'::jsonb;
  v_resource_assignments jsonb := '[]'::jsonb;
begin
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  if p_target_app_user_id is null then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;

  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'membership_id', m.membership_id,
        'group_id', g.group_id,
        'group_code', g.code,
        'group_name', g.name,
        'group_description', g.description,
        'department_id', g.department_id,
        'department_name', d.name,
        'team_id', g.team_id,
        'team_name', coalesce(t.display_name, t.code),
        'is_system_admin', g.is_system_admin,
        'group_active', g.active,
        'is_protected', m.is_protected,
        'can_remove', (not m.is_protected),
        'cannot_remove_reason', m.protected_reason,
        'started_at', public.org_department__internal_iso_utc(m.started_at),
        'capabilities', coalesce((
          select pg_catalog.jsonb_agg(gc.capability order by gc.capability asc)
            from public.authz_user_group_capabilities gc
           where gc.group_id = g.group_id and gc.ended_at is null and gc.started_at <= v_now
        ), '[]'::jsonb),
        'module_roles', coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object('module_code', mr.module_code, 'role_code', mr.role_code)
            order by mr.module_code asc, mr.role_code asc
          )
            from public.authz_user_group_module_roles mr
           where mr.group_id = g.group_id and mr.ended_at is null and mr.started_at <= v_now
        ), '[]'::jsonb)
      )
      order by g.is_system_admin desc, lower(d.name) asc, lower(g.name) asc, m.membership_id asc
    ),
    '[]'::jsonb
  )
    into v_memberships
    from public.authz_user_group_members m
    join public.authz_user_groups g
      on g.group_id = m.group_id
    join public.organization_departments d
      on d.department_id = g.department_id
    left join public.teams t
      on t.team_id = g.team_id
   where m.app_user_id = p_target_app_user_id
     and m.ended_at is null;

  -- Business resource assignments (shown for clarity on user detail, managed on their resources)
  with raw_resources as (
    select
      'TEAM_LEADER'::text as assignment_kind,
      t.team_id::text as resource_ref,
      coalesce(t.display_name, t.code) as resource_label
    from public.direct_entry_team_leader_assignments tla
    join public.teams t
      on t.team_id = tla.team_id
     and t.active = true
     and t.code <> '__system_vendor__'
    where tla.leader_app_user_id = p_target_app_user_id
      and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
    union all
    select
      'PROJECT_MANAGER'::text as assignment_kind,
      p.project_id as resource_ref,
      coalesce(p.display_name, p.project_id) as resource_label
    from public.direct_entry_project_manager_assignments pma
    join public.direct_entry_projects p
      on p.project_id = pma.project_id
     and p.active = true
    join public.recruiters r
      on r.recruiter_id = pma.manager_recruiter_id
     and r.active = true
    join public.direct_entry_app_user_recruiter_links rl
      on rl.recruiter_id = pma.manager_recruiter_id
     and rl.app_user_id = p_target_app_user_id
     and rl.verified = true
     and rl.valid_from <= v_today
     and (rl.valid_to is null or (rl.valid_to > rl.valid_from and v_today < rl.valid_to))
     and (rl.is_current = true or rl.suspended_by_account_disable = true)
    where pma.revoked_at is null
      and pma.valid_from <= v_today
      and (pma.valid_to is null or (pma.valid_to > pma.valid_from and v_today < pma.valid_to))
    union all
    select
      'PROJECT_ACCOUNTANT'::text as assignment_kind,
      p.project_id as resource_ref,
      coalesce(p.display_name, p.project_id) as resource_label
    from public.vendor_finance_project_accountants pa
    join public.direct_entry_projects p
      on p.project_id = pa.project_id
     and p.active = true
    where pa.accountant_user_id = p_target_app_user_id
      and pa.ended_at is null
      and pa.valid_from <= v_today
      and (pa.valid_to is null or (pa.valid_to > pa.valid_from and v_today < pa.valid_to))
    union all
    select
      'DEPARTMENT_HEAD'::text as assignment_kind,
      d.department_id::text as resource_ref,
      d.name as resource_label
    from public.organization_department_heads dh
    join public.organization_departments d
      on d.department_id = dh.department_id
     and d.is_active = true
    join public.organization_persons op
      on op.person_id = dh.person_id
     and op.status = 'ACTIVE'
    join public.organization_person_department_memberships m
      on m.person_id = dh.person_id
     and m.department_id = dh.department_id
     and m.ended_at is null
     and m.started_at <= v_now
    join public.organization_account_person_links l
      on l.person_id = dh.person_id
     and l.app_user_id = p_target_app_user_id
     and l.ended_at is null
     and l.started_at <= v_now
    join public.direct_entry_app_users u
      on u.app_user_id = l.app_user_id
     and u.enabled = true
    where dh.started_at <= v_now
      and (dh.ended_at is null or (dh.ended_at > dh.started_at and v_now < dh.ended_at))
    union all
    select
      'WORK_REPORT_DELEGATE'::text as assignment_kind,
      wd.delegation_id::text as resource_ref,
      coalesce(wt.display_name, wt.template_code) || ' (' ||
        case when wd.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Đội') end
        || ')' as resource_label
    from public.work_report_delegations wd
    join public.work_report_templates wt
      on wt.template_id = wd.template_id
    left join public.teams tm
      on tm.team_id = wd.scope_team_id
    where wd.delegate_app_user_id = p_target_app_user_id
      and public.work_report__internal_is_delegation_effective(wd.delegation_id, v_now)
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'assignment_kind', r.assignment_kind,
        'resource_ref', r.resource_ref,
        'resource_label', r.resource_label
      )
      order by r.assignment_kind asc, lower(r.resource_label) asc, r.resource_ref asc
    ),
    '[]'::jsonb
  )
    into v_resource_assignments
    from raw_resources r;

  return pg_catalog.jsonb_build_object(
    'as_of', public.org_department__internal_iso_utc(v_now),
    'account_ref', v_target.app_user_id,
    'account_version', v_target.version,
    'enabled', v_target.enabled,
    'memberships', v_memberships,
    'resource_assignments', v_resource_assignments
  );
end;
$function$;

revoke all on function public.direct_entry_authz_get_account_groups_admin(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_get_account_groups_admin(uuid, uuid, uuid)
  to service_role;

-- =============================================================================
-- 7. Owner Alignment, ACL Verification, and Runtime Reference Audit
-- =============================================================================

do $align_and_check_wp10_4$
declare
  v_service_rpcs text[] := array[
    'public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer, text)',
    'public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text)',
    'public.direct_entry_authz_get_account_groups_admin(uuid, uuid, uuid)'
  ];
  v_internal_fns text[] := array[
    'public.leave_management__internal_resolve_routing_snapshot(uuid, date)',
    'public.leave_management__internal_resolve_authority(uuid, uuid)',
    'public.leave_management__internal_can_actor_decide_request(uuid, public.leave_requests, date)'
  ];
  v_sig text;
  v_oid oid;
  v_proc_owner oid;
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean := false;
  v_rec record;
  v_set_approver_overloads integer := 0;
  v_legacy_proc_count integer := 0;
  v_legacy_procs text;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner is null or v_base_owner_oid is null then
    raise exception 'WP10-4 alignment failed: base owner missing' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  if pg_catalog.to_regclass('public.leave_department_approvers') is null then
    raise exception 'WP10-4 check failed: historical leave_department_approvers table must remain intact' using errcode = '55000';
  end if;

  select count(*)::integer
    into v_set_approver_overloads
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'leave_management_set_department_approver_admin';

  if v_set_approver_overloads <> 1 then
    raise exception 'WP10-4 check failed: expected single 9-arg leave_management_set_department_approver_admin, found %', v_set_approver_overloads using errcode = '55000';
  end if;

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-4 check failed: missing service RPC %', v_sig using errcode = '55000';
    end if;
    select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_sig);
    execute pg_catalog.format('grant execute on function %s to service_role', v_sig);

    select p.prosecdef, p.proconfig
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'WP10-4 check failed: definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'WP10-4 check failed: RPC ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-4 check failed: missing internal fn %', v_sig using errcode = '55000';
    end if;
    select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_sig);

    select p.prosecdef, p.proconfig
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'WP10-4 check failed: internal definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'WP10-4 check failed: internal ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  grant execute on function public.leave_management__internal_resolve_authority(uuid, uuid)
    to direct_entry_catalog_bootstrap_executor;

  if not pg_catalog.has_function_privilege(
    'direct_entry_catalog_bootstrap_executor',
    'public.leave_management__internal_resolve_authority(uuid, uuid)',
    'EXECUTE'
  ) then
    raise exception 'WP10-4 check failed: bootstrap executor grant missing on leave_management__internal_resolve_authority' using errcode = '55000';
  end if;

  select count(*)::integer,
         pg_catalog.string_agg(p.oid::pg_catalog.regprocedure::text, ', ' order by p.proname)
    into v_legacy_proc_count, v_legacy_procs
    from pg_catalog.pg_proc p
   where p.pronamespace = 'public'::pg_catalog.regnamespace
     and p.prokind in ('f', 'p')
     and p.prosrc ~* 'leave_department_approvers';

  if v_legacy_proc_count > 0 then
    raise exception 'WP10-4 check failed: % public routine(s) still reference leave_department_approvers: %',
      v_legacy_proc_count, coalesce(v_legacy_procs, '<unknown>')
      using errcode = '55000';
  end if;
end
$align_and_check_wp10_4$;

commit;
