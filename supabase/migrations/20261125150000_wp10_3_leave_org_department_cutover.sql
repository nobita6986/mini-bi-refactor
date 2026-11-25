-- =============================================================================
-- WP10-3: Cut over Leave & Attendance Explanation Department Source to Org
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. public.leave_management__internal_resolve_routing_snapshot(uuid, date):
--      Remove leave_employee_profiles.unit_kind fallback and legacy_fallback_dept;
--      resolve department strictly from active Org link + active person/dept,
--      preserving PR #32 cross-department Recruitment TL guard, WP10-4
--      leave_department_approvers compat fallback, and exact 4-col / 8-key shape.
--   2. public.leave_management__internal_compute_balance_summary(uuid, integer, date):
--      Remove v_profile.unit_kind fallback; derive unit_kind strictly from Org,
--      preserving all accrual and lot math.
--   3. public.leave_management_create_request(...):
--      Remove unlinked leave_employee_profiles.unit_kind lock fallback and
--      v_profile.unit_kind snapshot init; store routing unit_kind without
--      touching any historical or PENDING snapshots.
--   4. public.leave_management_get_my_summary(...),
--      public.leave_management_get_admin_overview(...),
--      public.leave_management_monthly_report(...):
--      Remove all p.unit_kind fallbacks and add additive org_department object.
--   5. public.leave_management_upsert_employee_profile_admin(...) (exact 13-arg)
--      & public.org_department__internal_guard_leave_profile():
--      Validate optional legacy p_unit_kind enum if provided, ignore it on write
--      (always persist Org-derived unit_kind), align trigger guard with
--      active person/department semantics, and keep transitional column/sync intact.
--   6. Owner alignment, SECURITY DEFINER, SET search_path = pg_catalog, public,
--      and strict REVOKE/GRANT verification.
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
  v_dept_approver_id uuid := null;
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
           ) as org_head_app_user_id,
           (
             select da.approver_app_user_id
               from public.leave_department_approvers da
               join public.direct_entry_app_users u
                 on u.app_user_id = da.approver_app_user_id
                and u.enabled = true
              where ro.unit_kind in ('MARKETING', 'IT', 'ACCOUNTING')
                and da.unit_kind = ro.unit_kind
                and da.valid_from <= p_as_of
                and (da.valid_to is null or p_as_of < da.valid_to)
                and (da.valid_to is null or da.valid_to > da.valid_from)
              order by da.valid_from desc, da.row_version desc
              limit 1
           ) as compat_dept_approver_id
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
           ) as is_requester_dept_head,
           exists (
             select 1
               from now_ctx nc
               join public.leave_department_approvers da
                 on da.approver_app_user_id = p_app_user_id
                and da.valid_from <= p_as_of
                and (da.valid_to is null or p_as_of < da.valid_to)
                and (da.valid_to is null or da.valid_to > da.valid_from)
              where not exists (
                select 1
                  from public.organization_departments d
                  join public.organization_department_heads dh
                    on dh.department_id = d.department_id
                   and dh.started_at <= nc.v_now
                   and (dh.ended_at is null or (dh.ended_at > dh.started_at and nc.v_now < dh.ended_at))
                 where d.system_key = da.unit_kind
                   and d.is_active = true
              )
           ) as is_requester_compat_dept_approver
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
         dhs.compat_dept_approver_id,
         rr.is_requester_team_leader,
         rr.is_requester_dept_head,
         rr.is_requester_compat_dept_approver,
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
     or v_snap.is_requester_compat_dept_approver
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
    if v_snap.has_open_org_head then
      v_dept_approver_id := v_snap.org_head_app_user_id;
    elsif v_snap.unit_kind in ('MARKETING', 'IT', 'ACCOUNTING') then
      v_dept_approver_id := v_snap.compat_dept_approver_id;
    else
      v_dept_approver_id := null;
    end if;

    if v_dept_approver_id is not null and v_dept_approver_id <> p_app_user_id then
      v_routing := pg_catalog.jsonb_build_object(
        'route_kind', 'DEPARTMENT_HEAD',
        'unit_kind', v_snap.unit_kind,
        'primary_approver_app_user_id', v_dept_approver_id,
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
-- 2. Balance Summary Computation (Org-only unit_kind; identical lot/accrual math)
-- =============================================================================

create or replace function public.leave_management__internal_compute_balance_summary(
  p_app_user_id uuid,
  p_leave_year integer,
  p_as_of date default public.leave_management__internal_business_date()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_org record;
  v_effective_unit_kind text := 'UNCLASSIFIED';
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean := false;
  v_profile_configured boolean := false;
  v_total_granted integer := 0;
  v_carry_over_granted integer := 0;
  v_monthly_accrued integer := 0;
  v_seniority_granted integer := 0;
  v_opening_current_year integer := 0;
  v_reserved integer := 0;
  v_consumed integer := 0;
  v_expired integer := 0;
  v_available integer := 0;
  v_carry_over_available integer := 0;
  v_pending_annual integer := 0;
  v_pending_non_annual integer := 0;
  v_pending_unpaid integer := 0;
  v_approved_annual integer := 0;
  v_approved_non_annual integer := 0;
  v_approved_bereavement integer := 0;
  v_approved_marriage integer := 0;
  v_approved_sick integer := 0;
  v_approved_unpaid integer := 0;
  v_lots jsonb := '[]'::jsonb;
begin
  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_app_user_id;

  if found then
    v_has_profile := true;
    v_profile_configured := (
      v_profile.employment_status in ('PROBATION', 'OFFICIAL')
      and v_profile.work_start_date is not null
      and (
        v_profile.employment_status <> 'OFFICIAL'
        or v_profile.official_effective_date is not null
      )
    );
  end if;

  select *
    into v_org
    from public.leave_management__internal_resolve_person_department(p_app_user_id, v_now);

  if coalesce(v_org.has_active_person_link, false) then
    v_effective_unit_kind := coalesce(v_org.department_system_key, 'UNCLASSIFIED');
  else
    v_effective_unit_kind := 'UNCLASSIFIED';
  end if;

  select coalesce(sum(l.granted_units), 0)::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind = 'CARRY_OVER'), 0)::integer,
         coalesce(
           sum(coalesce((l.metadata->>'initial_granted_units')::integer, l.granted_units))
             filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')),
           0
         )::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind = 'SENIORITY_GRANT'), 0)::integer,
         (
           coalesce(
             sum(l.granted_units)
               filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP', 'OPENING_CURRENT_YEAR', 'MANUAL_ADJUSTMENT')),
             0
           )::integer
           - coalesce(
               sum(coalesce((l.metadata->>'initial_granted_units')::integer, l.granted_units))
                 filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')),
               0
             )::integer
         ),
         coalesce(sum(l.reserved_units), 0)::integer,
         coalesce(sum(l.consumed_units), 0)::integer,
         coalesce(sum(l.expired_units), 0)::integer,
         coalesce(
           sum(l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
             filter (
               where l.usable_from_date <= p_as_of
                 and (l.expires_after_date is null or p_as_of <= l.expires_after_date)
             ),
           0
         )::integer,
         coalesce(
           sum(l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
             filter (
               where l.lot_kind = 'CARRY_OVER'
                 and l.usable_from_date <= p_as_of
                 and (l.expires_after_date is null or p_as_of <= l.expires_after_date)
             ),
           0
         )::integer,
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'lot_id', l.lot_id,
               'leave_year', l.leave_year,
               'lot_kind', l.lot_kind,
               'accrual_month', l.accrual_month,
               'granted_units', l.granted_units,
               'reserved_units', l.reserved_units,
               'consumed_units', l.consumed_units,
               'expired_units', l.expired_units,
               'available_units', (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units),
               'usable_from_date', l.usable_from_date,
               'expires_after_date', l.expires_after_date,
               'source_ref', l.source_ref
             )
             order by l.expires_after_date asc nulls last, l.usable_from_date asc, l.created_at asc, l.lot_id asc
           ),
           '[]'::jsonb
         )
    into v_total_granted,
         v_carry_over_granted,
         v_monthly_accrued,
         v_seniority_granted,
         v_opening_current_year,
         v_reserved,
         v_consumed,
         v_expired,
         v_available,
         v_carry_over_available,
         v_lots
    from public.leave_lots l
   where l.app_user_id = p_app_user_id
     and l.leave_year = p_leave_year;

  select coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'PENDING' and d.leave_type = 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'PENDING' and d.leave_type <> 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'PENDING' and d.leave_type = 'UNPAID'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type <> 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'BEREAVEMENT'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'MARRIAGE'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'SICK'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'UNPAID'),
           0
         )::integer
    into v_pending_annual,
         v_pending_non_annual,
         v_pending_unpaid,
         v_approved_annual,
         v_approved_non_annual,
         v_approved_bereavement,
         v_approved_marriage,
         v_approved_sick,
         v_approved_unpaid
    from public.leave_requests r
    join public.leave_request_days d on d.request_id = r.request_id
   where r.app_user_id = p_app_user_id
     and pg_catalog.date_part('year', d.leave_date)::integer = p_leave_year;

  return pg_catalog.jsonb_build_object(
    'leave_year', p_leave_year,
    'as_of_date', p_as_of,
    'has_profile', v_has_profile,
    'profile_configured', v_profile_configured,
    'employment_status', case when v_has_profile then v_profile.employment_status else 'UNCONFIGURED' end,
    'unit_kind', v_effective_unit_kind,
    'work_start_date', case when v_has_profile then v_profile.work_start_date else null end,
    'official_effective_date', case when v_has_profile then v_profile.official_effective_date else null end,
    'next_seniority_effective_date', case when v_has_profile then v_profile.next_seniority_effective_date else null end,
    'next_seniority_units', case when v_has_profile then v_profile.next_seniority_units else 0 end,
    'total_granted_units', v_total_granted,
    'carry_over_granted_units', v_carry_over_granted,
    'carry_over_available_units', v_carry_over_available,
    'monthly_accrued_units', v_monthly_accrued,
    'seniority_granted_units', v_seniority_granted,
    'opening_or_adjustment_units', v_opening_current_year,
    'available_units', v_available,
    'reserved_units', v_reserved,
    'consumed_units', v_consumed,
    'expired_units', v_expired,
    'pending_annual_units', v_pending_annual,
    'pending_non_annual_units', v_pending_non_annual,
    'pending_unpaid_units', v_pending_unpaid,
    'approved_annual_units', v_approved_annual,
    'approved_non_annual_units', v_approved_non_annual,
    'approved_bereavement_units', v_approved_bereavement,
    'approved_marriage_units', v_approved_marriage,
    'approved_sick_units', v_approved_sick,
    'approved_unpaid_units', v_approved_unpaid,
    'lots', v_lots
  );
end;
$function$;

revoke all on function public.leave_management__internal_compute_balance_summary(uuid, integer, date)
  from public, anon, authenticated, service_role;

-- =============================================================================
-- 3. Create Request (Remove unlinked unit_kind lock & snapshot fallbacks)
-- =============================================================================

create or replace function public.leave_management_create_request(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_days jsonb,
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
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_reason text := null;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_lock_person_id uuid := null;
  v_lock_dept_id uuid := null;
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean := false;
  v_profile_configured boolean := false;
  v_emp_status_snapshot text;
  v_routing_snap record;
  v_routing jsonb;
  v_raw_days jsonb;
  v_raw_allocs jsonb := null;
  v_day_item jsonb;
  v_day_date_text text;
  v_day_date date;
  v_session_code text;
  v_explicit_leave_type text;
  v_item_units integer;
  v_half_day_units integer;
  v_total_units integer := 0;
  v_seq integer := 0;
  v_alloc_item jsonb;
  v_alloc_seq integer := 0;
  v_alloc_type text;
  v_alloc_units integer;
  v_alloc_days numeric;
  v_alloc_total_units integer := 0;
  v_has_explicit_day_types boolean := false;
  v_all_days_have_explicit_types boolean := true;
  v_mismatch_count integer := 0;
  v_annual_units integer := 0;
  v_sim_lot record;
  v_sim_needed integer;
  v_request_row public.leave_requests%rowtype;
  v_projected_request jsonb;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;

  perform public.leave_management__internal_lock_employee(p_actor_app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'CREATE_REQUEST'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  -- Acquire org locks in canonical WP3B §4.2 order (person -> department -> app_user)
  -- BEFORE sync_employee_accruals locks leave_employee_profiles FOR UPDATE, preventing
  -- FK FOR KEY SHARE vs FOR UPDATE 40P01 deadlocks against org_department_transfer_person_member_admin.
  select l.person_id
    into v_lock_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_actor_app_user_id
     and l.ended_at is null
   order by l.started_at desc, l.link_id desc
   limit 1;

  if v_lock_person_id is not null then
    perform public.org_department__internal_lock_person(v_lock_person_id);
    select m.department_id
      into v_lock_dept_id
      from public.organization_account_person_links l
      join public.organization_person_department_memberships m
        on m.person_id = l.person_id
       and m.ended_at is null
     where l.app_user_id = p_actor_app_user_id
       and l.person_id = v_lock_person_id
       and l.ended_at is null
     order by m.started_at desc, m.membership_id desc
     limit 1;
  end if;

  if v_lock_dept_id is not null then
    perform public.org_department__internal_lock_department(v_lock_dept_id);
  end if;
  perform public.org_department__internal_lock_app_user(p_actor_app_user_id);

  perform public.leave_management__internal_sync_employee_accruals(p_actor_app_user_id, v_today);

  if p_days is null then
    raise exception 'LEAVE_REQUEST_DAYS_INVALID'
      using errcode = '22023';
  elsif pg_catalog.jsonb_typeof(p_days) = 'object' then
    v_raw_days := p_days->'days';
    v_raw_allocs := coalesce(p_days->'type_allocations', p_days->'allocations');
  elsif pg_catalog.jsonb_typeof(p_days) = 'array' then
    v_raw_days := p_days;
    v_raw_allocs := null;
  else
    raise exception 'LEAVE_REQUEST_DAYS_INVALID'
      using errcode = '22023';
  end if;

  if v_raw_days is null
     or pg_catalog.jsonb_typeof(v_raw_days) <> 'array'
     or pg_catalog.jsonb_array_length(v_raw_days) < 1
     or pg_catalog.jsonb_array_length(v_raw_days) > 120 then
    raise exception 'LEAVE_REQUEST_DAYS_INVALID'
      using errcode = '22023';
  end if;

  create temporary table if not exists pg_temp.leave_req_input_days (
    seq_no integer primary key,
    leave_date date not null,
    session_code text not null,
    half_day_units integer not null,
    explicit_leave_type text null
  ) on commit drop;

  create temporary table if not exists pg_temp.leave_req_normalized_days (
    seq_no integer primary key,
    leave_date date not null,
    session_code text not null,
    half_day_units integer not null,
    leave_type text not null
  ) on commit drop;

  truncate table pg_temp.leave_req_input_days;
  truncate table pg_temp.leave_req_normalized_days;

  for v_day_item in
    select value
      from pg_catalog.jsonb_array_elements(v_raw_days)
  loop
    if pg_catalog.jsonb_typeof(v_day_item) <> 'object' then
      raise exception 'LEAVE_REQUEST_DAYS_INVALID'
        using errcode = '22023';
    end if;

    v_seq := v_seq + 1;
    v_day_date_text := pg_catalog.btrim(coalesce(v_day_item->>'leave_date', ''));
    v_session_code := pg_catalog.upper(pg_catalog.btrim(coalesce(v_day_item->>'session_code', '')));
    v_explicit_leave_type := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(v_day_item->>'leave_type', ''))), '');

    if v_day_date_text !~ '^\d{4}-\d{2}-\d{2}$'
       or v_session_code not in ('FULL', 'AM', 'PM') then
      raise exception 'LEAVE_REQUEST_DAYS_INVALID'
        using errcode = '22023';
    end if;

    if v_explicit_leave_type is not null then
      if v_explicit_leave_type not in ('ANNUAL', 'BEREAVEMENT', 'MARRIAGE', 'SICK', 'UNPAID') then
        raise exception 'LEAVE_TYPE_INVALID'
          using errcode = '22023';
      end if;
      v_has_explicit_day_types := true;
    else
      v_all_days_have_explicit_types := false;
    end if;

    begin
      v_day_date := v_day_date_text::date;
    exception
      when others then
        raise exception 'LEAVE_REQUEST_DAYS_INVALID'
          using errcode = '22023';
    end;

    if pg_catalog.date_part('year', v_day_date)::integer <> v_year then
      raise exception 'LEAVE_REQUEST_YEAR_OUT_OF_RANGE'
        using errcode = '22023';
    end if;

    v_half_day_units := case when v_session_code = 'FULL' then 2 else 1 end;

    if v_day_item ? 'half_day_units' and pg_catalog.jsonb_typeof(v_day_item->'half_day_units') <> 'null' then
      begin
        v_item_units := (v_day_item->>'half_day_units')::integer;
      exception
        when others then
          raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
            using errcode = '22023';
      end;

      if v_item_units is distinct from v_half_day_units then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;
    end if;

    if exists (
      select 1
        from pg_temp.leave_req_input_days i
       where i.leave_date = v_day_date
         and (
           i.session_code = 'FULL'
           or v_session_code = 'FULL'
           or i.session_code = v_session_code
           or coalesce(i.explicit_leave_type, 'ANNUAL') = coalesce(v_explicit_leave_type, 'ANNUAL')
         )
    ) then
      raise exception 'LEAVE_REQUEST_DUPLICATE_DATE'
        using errcode = '22023';
    end if;

    if exists (
      select 1
        from public.leave_request_days d
       where d.app_user_id = p_actor_app_user_id
         and d.leave_date = v_day_date
         and d.is_active = true
         and (
           d.session_code = 'FULL'
           or v_session_code = 'FULL'
           or d.session_code = v_session_code
         )
    ) then
      raise exception 'LEAVE_REQUEST_OVERLAP'
        using errcode = '23505';
    end if;

    insert into pg_temp.leave_req_input_days (
      seq_no,
      leave_date,
      session_code,
      half_day_units,
      explicit_leave_type
    )
    values (
      v_seq,
      v_day_date,
      v_session_code,
      v_half_day_units,
      v_explicit_leave_type
    );

    v_total_units := v_total_units + v_half_day_units;
  end loop;

  if v_raw_allocs is not null and pg_catalog.jsonb_typeof(v_raw_allocs) <> 'null' then
    if pg_catalog.jsonb_typeof(v_raw_allocs) <> 'array'
       or pg_catalog.jsonb_array_length(v_raw_allocs) < 1
       or pg_catalog.jsonb_array_length(v_raw_allocs) > 20 then
      raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
        using errcode = '22023';
    end if;

    create temporary table if not exists pg_temp.leave_req_type_allocs (
      alloc_seq integer primary key,
      leave_type text not null,
      half_day_units integer not null
    ) on commit drop;

    truncate table pg_temp.leave_req_type_allocs;

    for v_alloc_item in
      select value
        from pg_catalog.jsonb_array_elements(v_raw_allocs)
    loop
      if pg_catalog.jsonb_typeof(v_alloc_item) <> 'object' then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      v_alloc_seq := v_alloc_seq + 1;
      v_alloc_type := pg_catalog.upper(pg_catalog.btrim(coalesce(v_alloc_item->>'leave_type', '')));

      if v_alloc_type not in ('ANNUAL', 'BEREAVEMENT', 'MARRIAGE', 'SICK', 'UNPAID') then
        raise exception 'LEAVE_TYPE_INVALID'
          using errcode = '22023';
      end if;

      v_alloc_units := null;
      if v_alloc_item ? 'half_day_units' and pg_catalog.jsonb_typeof(v_alloc_item->'half_day_units') <> 'null' then
        begin
          v_alloc_units := (v_alloc_item->>'half_day_units')::integer;
        exception
          when others then
            raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
              using errcode = '22023';
        end;
      end if;

      if v_alloc_item ? 'days' and pg_catalog.jsonb_typeof(v_alloc_item->'days') <> 'null' then
        begin
          v_alloc_days := (v_alloc_item->>'days')::numeric;
        exception
          when others then
            raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
              using errcode = '22023';
        end;

        if v_alloc_days <= 0 or pg_catalog.mod(v_alloc_days * 2, 1) <> 0 then
          raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
            using errcode = '22023';
        end if;

        if v_alloc_units is not null and v_alloc_units <> (v_alloc_days * 2)::integer then
          raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
            using errcode = '22023';
        end if;

        v_alloc_units := (v_alloc_days * 2)::integer;
      end if;

      if v_alloc_units is null or v_alloc_units < 1 then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      insert into pg_temp.leave_req_type_allocs (
        alloc_seq,
        leave_type,
        half_day_units
      )
      values (
        v_alloc_seq,
        v_alloc_type,
        v_alloc_units
      );

      v_alloc_total_units := v_alloc_total_units + v_alloc_units;
    end loop;

    if v_alloc_total_units <> v_total_units then
      raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
        using errcode = '22023';
    end if;

    if v_has_explicit_day_types then
      if not v_all_days_have_explicit_types then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      select count(*)::integer
        into v_mismatch_count
        from (
          select i.explicit_leave_type as leave_type,
                 sum(i.half_day_units)::integer as day_units
            from pg_temp.leave_req_input_days i
           group by i.explicit_leave_type
        ) d_sum
        full outer join (
          select a.leave_type,
                 sum(a.half_day_units)::integer as alloc_units
            from pg_temp.leave_req_type_allocs a
           group by a.leave_type
        ) a_sum on a_sum.leave_type = d_sum.leave_type
       where coalesce(d_sum.day_units, 0) <> coalesce(a_sum.alloc_units, 0);

      if v_mismatch_count > 0 then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      insert into pg_temp.leave_req_normalized_days (
        seq_no,
        leave_date,
        session_code,
        half_day_units,
        leave_type
      )
      select pg_catalog.row_number() over (
               order by i.leave_date asc,
                        case i.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                        i.seq_no asc
             )::integer,
             i.leave_date,
             i.session_code,
             i.half_day_units,
             i.explicit_leave_type
        from pg_temp.leave_req_input_days i;
    else
      insert into pg_temp.leave_req_normalized_days (
        seq_no,
        leave_date,
        session_code,
        half_day_units,
        leave_type
      )
      with expanded_day_slots as (
        select pg_catalog.row_number() over (
                 order by i.leave_date asc,
                          case i.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                          i.seq_no asc,
                          s.slot_idx asc
               )::integer as slot_no,
               i.seq_no as orig_seq_no,
               i.leave_date,
               i.session_code as orig_session_code,
               case
                 when i.session_code = 'FULL' and s.slot_idx = 1 then 'AM'
                 when i.session_code = 'FULL' and s.slot_idx = 2 then 'PM'
                 else i.session_code
               end as slot_session_code
          from pg_temp.leave_req_input_days i
          cross join lateral pg_catalog.generate_series(1, i.half_day_units) as s(slot_idx)
      ),
      expanded_alloc_slots as (
        select pg_catalog.row_number() over (
                 order by a.alloc_seq asc, s.slot_idx asc
               )::integer as slot_no,
               a.leave_type
          from pg_temp.leave_req_type_allocs a
          cross join lateral pg_catalog.generate_series(1, a.half_day_units) as s(slot_idx)
      ),
      assigned_slots as (
        select d.slot_no,
               d.orig_seq_no,
               d.leave_date,
               d.orig_session_code,
               d.slot_session_code,
               a.leave_type
          from expanded_day_slots d
          join expanded_alloc_slots a on a.slot_no = d.slot_no
      ),
      merged_days as (
        select min(s.slot_no) as first_slot_no,
               s.leave_date,
               'FULL'::text as session_code,
               2::integer as half_day_units,
               min(s.leave_type) as leave_type
          from assigned_slots s
         where s.orig_session_code = 'FULL'
         group by s.orig_seq_no, s.leave_date
        having count(distinct s.leave_type) = 1
        union all
        select s.slot_no as first_slot_no,
               s.leave_date,
               s.slot_session_code as session_code,
               1::integer as half_day_units,
               s.leave_type
          from assigned_slots s
         where s.orig_session_code <> 'FULL'
            or s.orig_seq_no in (
              select s2.orig_seq_no
                from assigned_slots s2
               where s2.orig_session_code = 'FULL'
               group by s2.orig_seq_no
              having count(distinct s2.leave_type) > 1
            )
      )
      select pg_catalog.row_number() over (
               order by m.leave_date asc,
                        case m.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                        m.first_slot_no asc
             )::integer,
             m.leave_date,
             m.session_code,
             m.half_day_units,
             m.leave_type
        from merged_days m;
    end if;
  else
    insert into pg_temp.leave_req_normalized_days (
      seq_no,
      leave_date,
      session_code,
      half_day_units,
      leave_type
    )
    select pg_catalog.row_number() over (
             order by i.leave_date asc,
                      case i.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                      i.seq_no asc
           )::integer,
           i.leave_date,
           i.session_code,
           i.half_day_units,
           coalesce(i.explicit_leave_type, 'ANNUAL')
      from pg_temp.leave_req_input_days i;
  end if;

  if exists (
    select 1
      from (
        select n.leave_type,
               sum(n.half_day_units)::integer as type_units
          from pg_temp.leave_req_normalized_days n
         group by n.leave_type
      ) s
     where (s.leave_type in ('BEREAVEMENT', 'MARRIAGE') and s.type_units > 6)
        or (s.leave_type in ('SICK', 'UNPAID') and s.type_units > 14)
  ) then
    raise exception 'LEAVE_TYPE_LIMIT_EXCEEDED'
      using errcode = '22023';
  end if;

  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_actor_app_user_id;

  if found then
    v_has_profile := true;
    v_profile_configured := (
      v_profile.employment_status in ('PROBATION', 'OFFICIAL')
      and v_profile.work_start_date is not null
      and (
        v_profile.employment_status <> 'OFFICIAL'
        or v_profile.official_effective_date is not null
      )
    );
    v_emp_status_snapshot := v_profile.employment_status;
  else
    v_emp_status_snapshot := 'UNCONFIGURED';
  end if;

  select coalesce(sum(n.half_day_units), 0)::integer
    into v_annual_units
    from pg_temp.leave_req_normalized_days n
   where n.leave_type = 'ANNUAL';

  if v_annual_units > 0 then
    create temporary table if not exists pg_temp.leave_sim_lots (
      lot_id uuid primary key,
      usable_from_date date not null,
      expires_after_date date null,
      created_at timestamptz not null,
      remaining_units integer not null
    ) on commit drop;

    truncate table pg_temp.leave_sim_lots;

    insert into pg_temp.leave_sim_lots (
      lot_id,
      usable_from_date,
      expires_after_date,
      created_at,
      remaining_units
    )
    select l.lot_id,
           l.usable_from_date,
           l.expires_after_date,
           l.created_at,
           (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
      from public.leave_lots l
     where l.app_user_id = p_actor_app_user_id
       and l.leave_year = v_year
       and (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units) > 0;

    for v_day_date, v_half_day_units in
      select n.leave_date,
             n.half_day_units
        from pg_temp.leave_req_normalized_days n
       where n.leave_type = 'ANNUAL'
       order by n.leave_date asc, n.seq_no asc
    loop
      v_sim_needed := v_half_day_units;
      for v_sim_lot in
         select s.lot_id,
                s.remaining_units
           from pg_temp.leave_sim_lots s
          where s.remaining_units > 0
            and s.usable_from_date <= v_day_date
            and (s.expires_after_date is null or v_day_date <= s.expires_after_date)
          order by s.expires_after_date asc nulls last,
                   s.usable_from_date asc,
                   s.created_at asc,
                   s.lot_id asc
      loop
        if v_sim_lot.remaining_units >= v_sim_needed then
          update pg_temp.leave_sim_lots
             set remaining_units = remaining_units - v_sim_needed
           where lot_id = v_sim_lot.lot_id;
          v_sim_needed := 0;
          exit;
        else
          v_sim_needed := v_sim_needed - v_sim_lot.remaining_units;
          update pg_temp.leave_sim_lots
             set remaining_units = 0
           where lot_id = v_sim_lot.lot_id;
        end if;
      end loop;

      if v_sim_needed > 0 then
        raise exception 'LEAVE_INSUFFICIENT_BALANCE'
          using errcode = '22023';
      end if;
    end loop;
  end if;

  -- Single atomic snapshot of route_kind, unit_kind, primary_approver, and routed_department
  select *
    into v_routing_snap
    from public.leave_management__internal_resolve_routing_snapshot(p_actor_app_user_id, v_today);
  v_routing := v_routing_snap.routing;

  insert into public.leave_requests (
    app_user_id,
    status,
    pay_treatment,
    employment_status_snapshot,
    unit_kind_snapshot,
    profile_configured_at_submit,
    requested_units,
    reason,
    route_kind,
    primary_approver_app_user_id,
    routed_team_id,
    routed_team_code,
    routed_team_name,
    routed_department_id,
    routed_department_code,
    routed_department_name,
    fallback_reason,
    row_version
  )
  values (
    p_actor_app_user_id,
    'PENDING',
    null,
    v_emp_status_snapshot,
    coalesce(v_routing->>'unit_kind', 'UNCLASSIFIED'),
    v_profile_configured,
    v_total_units,
    v_reason,
    v_routing->>'route_kind',
    nullif(v_routing->>'primary_approver_app_user_id', '')::uuid,
    nullif(v_routing->>'team_id', '')::uuid,
    nullif(v_routing->>'team_code', ''),
    nullif(v_routing->>'team_name', ''),
    v_routing_snap.routed_department_id,
    v_routing_snap.routed_department_code,
    v_routing_snap.routed_department_name,
    nullif(v_routing->>'fallback_reason', ''),
    1
  )
  returning * into v_request_row;

  begin
    insert into public.leave_request_days (
      request_id,
      app_user_id,
      leave_date,
      session_code,
      leave_type,
      half_day_units,
      is_active
    )
    select v_request_row.request_id,
           p_actor_app_user_id,
           n.leave_date,
           n.session_code,
           n.leave_type,
           n.half_day_units,
           true
      from pg_temp.leave_req_normalized_days n
     order by n.leave_date asc,
              case n.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
              n.seq_no asc;
  exception
    when unique_violation then
      raise exception 'LEAVE_REQUEST_OVERLAP'
        using errcode = '23505';
  end;

  v_projected_request := public.leave_management__internal_project_request(v_request_row);

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    request_id,
    reason,
    payload
  )
  values (
    'REQUEST_CREATED',
    p_actor_app_user_id,
    p_actor_app_user_id,
    v_request_row.request_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'leave_types', v_projected_request->'leave_types',
      'type_breakdown', v_projected_request->'type_breakdown',
      'requested_units', v_total_units,
      'requested_annual_units', v_annual_units,
      'route_kind', v_request_row.route_kind,
      'primary_approver_app_user_id', v_request_row.primary_approver_app_user_id,
      'fallback_reason', v_request_row.fallback_reason
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'request', v_projected_request,
    'balance', public.leave_management__internal_compute_balance_summary(p_actor_app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'CREATE_REQUEST',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

revoke all on function public.leave_management_create_request(uuid, uuid, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.leave_management_create_request(uuid, uuid, jsonb, text, text, text)
  to service_role;

-- =============================================================================
-- 4. Summary, Admin Overview & Monthly Report (Org-only + additive org_department)
-- =============================================================================

create or replace function public.leave_management_get_my_summary(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_leave_year integer default null::integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.leave_management__internal_business_date();
  v_year integer := coalesce(p_leave_year, pg_catalog.date_part('year', v_today)::integer);
  v_auth jsonb;
  v_account jsonb;
  v_routing jsonb;
  v_balance jsonb;
  v_org record;
  v_org_department jsonb;
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_requests jsonb := '[]'::jsonb;
  v_ledger jsonb := '[]'::jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  perform public.leave_management__internal_sync_employee_accruals(p_actor_app_user_id, v_today);

  v_account := public.leave_management__internal_account_summary(p_actor_app_user_id);
  v_routing := public.leave_management__internal_resolve_routing(p_actor_app_user_id, v_today);
  v_balance := public.leave_management__internal_compute_balance_summary(p_actor_app_user_id, v_year, v_today);

  select *
    into v_org
    from public.leave_management__internal_resolve_person_department(p_actor_app_user_id, v_now);

  v_org_department := pg_catalog.jsonb_build_object(
    'has_active_person_link', coalesce(v_org.has_active_person_link, false),
    'person_status', v_org.person_status,
    'department_id', v_org.department_id,
    'department_code', v_org.department_code,
    'department_name', v_org.department_name,
    'department_system_key', v_org.department_system_key
  );

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
             public.leave_management__internal_project_request(r)
             order by r.submitted_at desc, r.request_id desc
           ),
           '[]'::jsonb
         )
    into v_requests
    from public.leave_requests r
   where r.app_user_id = p_actor_app_user_id;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'ledger_entry_id', le.ledger_entry_id,
               'lot_id', le.lot_id,
               'request_id', le.request_id,
               'entry_type', le.entry_type,
               'effective_date', le.effective_date,
               'delta_available_units', le.delta_available_units,
               'delta_reserved_units', le.delta_reserved_units,
               'delta_consumed_units', le.delta_consumed_units,
               'delta_expired_units', le.delta_expired_units,
               'reason', le.reason,
               'created_at', le.created_at
             )
             order by le.created_at desc
           ),
           '[]'::jsonb
         )
    into v_ledger
    from (
      select e.*
        from public.leave_ledger_entries e
       where e.app_user_id = p_actor_app_user_id
       order by e.created_at desc
       limit 100
    ) le;

  return pg_catalog.jsonb_build_object(
    'as_of_date', v_today,
    'leave_year', v_year,
    'account', v_account,
    'authority', v_auth,
    'routing', v_routing,
    'org_department', v_org_department,
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
    'balance', v_balance,
    'requests', v_requests,
    'ledger_entries', v_ledger
  );
end;
$function$;

revoke all on function public.leave_management_get_my_summary(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.leave_management_get_my_summary(uuid, uuid, integer)
  to service_role;

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
               'approver_assignment_id', da.approver_assignment_id,
               'unit_kind', da.unit_kind,
               'approver_app_user_id', da.approver_app_user_id,
               'approver', public.leave_management__internal_account_summary(da.approver_app_user_id),
               'valid_from', da.valid_from,
               'valid_to', da.valid_to,
               'is_current', da.is_current,
               'reason', da.reason,
               'row_version', da.row_version
             )
             order by da.unit_kind asc
           ),
           '[]'::jsonb
         )
    into v_dept_approvers
    from public.leave_department_approvers da
   where da.is_current = true;

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

create or replace function public.leave_management_monthly_report(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_year_month text,
  p_unit_kind_filter text default null::text,
  p_search text default null::text,
  p_limit integer default 200,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.leave_management__internal_business_date();
  v_auth jsonb;
  v_ym text := pg_catalog.btrim(coalesce(p_year_month, pg_catalog.to_char(v_today, 'YYYY-MM')));
  v_unit_filter text := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_unit_kind_filter, ''))), '');
  v_search text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, ''))), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 500));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_month_start date;
  v_month_end date;
  v_year integer;
  v_month integer;
  v_sync_as_of date;
  v_page_user_ids uuid[] := array[]::uuid[];
  v_emp record;
  v_rows jsonb := '[]'::jsonb;
  v_total integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_view_monthly_report')::boolean, false) then
    raise exception 'LEAVE_REPORT_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_ym !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'LEAVE_REPORT_YEAR_MONTH_INVALID'
      using errcode = '22023';
  end if;

  if v_unit_filter is not null
     and v_unit_filter not in ('ALL', 'UNCLASSIFIED', 'RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD') then
    raise exception 'LEAVE_FILTER_INVALID'
      using errcode = '22023';
  end if;

  v_month_start := (v_ym || '-01')::date;
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;
  v_year := pg_catalog.date_part('year', v_month_start)::integer;
  v_month := pg_catalog.date_part('month', v_month_start)::integer;
  v_sync_as_of := least(v_today, v_month_end);

  select count(*)::integer
    into v_total
    from public.direct_entry_app_users u
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
       v_unit_filter is null
       or v_unit_filter = 'ALL'
       or (
         case
           when coalesce(org_p.has_active_person_link, false) then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
           else 'UNCLASSIFIED'
         end
       ) = v_unit_filter
     )
     and (
       v_search is null
       or pg_catalog.lower(coalesce(org_p.full_name, linked.display_name, u.display_name, '')) like '%' || v_search || '%'
       or pg_catalog.lower(coalesce(org_p.employee_code, linked.personnel_code, '')) like '%' || v_search || '%'
     );

  select coalesce(pg_catalog.array_agg(paged.app_user_id order by paged.sort_name asc, paged.app_user_id asc), array[]::uuid[])
    into v_page_user_ids
    from (
      select u.app_user_id,
             coalesce(org_p.full_name, linked.display_name, u.display_name) as sort_name
        from public.direct_entry_app_users u
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
           v_unit_filter is null
           or v_unit_filter = 'ALL'
           or (
             case
               when coalesce(org_p.has_active_person_link, false) then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
               else 'UNCLASSIFIED'
             end
           ) = v_unit_filter
         )
         and (
           v_search is null
           or pg_catalog.lower(coalesce(org_p.full_name, linked.display_name, u.display_name, '')) like '%' || v_search || '%'
           or pg_catalog.lower(coalesce(org_p.employee_code, linked.personnel_code, '')) like '%' || v_search || '%'
         )
       order by coalesce(org_p.full_name, linked.display_name, u.display_name) asc, u.app_user_id asc
       limit v_limit
      offset v_offset
    ) paged;

  for v_emp in
    select u.app_user_id
      from public.direct_entry_app_users u
      left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
     where u.app_user_id = any(v_page_user_ids)
       and (
         (
           p.app_user_id is not null
           and p.employment_status = 'OFFICIAL'
           and p.work_start_date is not null
         )
         or exists (
           select 1
             from public.leave_lots l
            where l.app_user_id = u.app_user_id
         )
       )
     order by u.app_user_id asc
  loop
    perform public.leave_management__internal_sync_employee_accruals(v_emp.app_user_id, v_sync_as_of);
  end loop;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'app_user_id', sub.app_user_id,
               'account', sub.account,
               'routing', sub.routing,
               'org_department', sub.org_department,
               'employment_status', sub.employment_status,
               'unit_kind', sub.unit_kind,
               'work_start_date', sub.work_start_date,
               'official_effective_date', sub.official_effective_date,
               'attendance_day_count', sub.attendance_day_count,
               'attendance_dates', sub.attendance_dates,
               'attendance_days', sub.attendance_days,
               'leave_days', sub.leave_days,
               'pending_leave_days', sub.pending_leave_days,
               'month_annual_leave_units', sub.month_annual_leave_units,
               'month_bereavement_leave_units', sub.month_bereavement_leave_units,
               'month_marriage_leave_units', sub.month_marriage_leave_units,
               'month_sick_leave_units', sub.month_sick_leave_units,
               'month_unpaid_leave_units', sub.month_unpaid_leave_units,
               'month_total_approved_leave_units', sub.month_total_approved_leave_units,
               'month_pending_units', sub.month_pending_units,
               'month_approved_request_count', sub.month_approved_request_count,
               'balance', sub.balance
             )
             order by sub.sort_name asc, sub.app_user_id asc
           ),
           '[]'::jsonb
         )
    into v_rows
    from (
      select u.app_user_id,
             coalesce(org_p.full_name, linked.display_name, u.display_name) as sort_name,
             public.leave_management__internal_account_summary(u.app_user_id) as account,
             public.leave_management__internal_resolve_routing(u.app_user_id, v_sync_as_of) as routing,
             pg_catalog.jsonb_build_object(
               'has_active_person_link', coalesce(org_p.has_active_person_link, false),
               'person_status', org_p.person_status,
               'department_id', org_p.department_id,
               'department_code', org_p.department_code,
               'department_name', org_p.department_name,
               'department_system_key', org_p.department_system_key
             ) as org_department,
             coalesce(p.employment_status, 'UNCONFIGURED') as employment_status,
             case
               when coalesce(org_p.has_active_person_link, false) then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
               else 'UNCLASSIFIED'
             end as unit_kind,
             p.work_start_date,
             p.official_effective_date,
             coalesce(att.attendance_day_count, 0)::integer as attendance_day_count,
             coalesce(att.attendance_dates, '[]'::jsonb) as attendance_dates,
             coalesce(att.attendance_days, '[]'::jsonb) as attendance_days,
             coalesce(m.leave_days, '[]'::jsonb) as leave_days,
             coalesce(m.pending_leave_days, '[]'::jsonb) as pending_leave_days,
             coalesce(m.annual_units, 0)::integer as month_annual_leave_units,
             coalesce(m.bereavement_units, 0)::integer as month_bereavement_leave_units,
             coalesce(m.marriage_units, 0)::integer as month_marriage_leave_units,
             coalesce(m.sick_units, 0)::integer as month_sick_leave_units,
             coalesce(m.unpaid_units, 0)::integer as month_unpaid_leave_units,
             coalesce(m.total_approved_units, 0)::integer as month_total_approved_leave_units,
             coalesce(m.pending_units, 0)::integer as month_pending_units,
             coalesce(m.approved_request_count, 0)::integer as month_approved_request_count,
             public.leave_management__internal_compute_balance_summary(u.app_user_id, v_year, v_sync_as_of) as balance
        from public.direct_entry_app_users u
        left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
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
        left join lateral (
          select count(*)::integer as attendance_day_count,
                 coalesce(
                   pg_catalog.jsonb_agg(day_row.business_date order by day_row.business_date asc),
                   '[]'::jsonb
                 ) as attendance_dates,
                 coalesce(
                   pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'business_date', day_row.business_date,
                       'checkin_count', day_row.checkin_count,
                       'first_captured_at', day_row.first_captured_at,
                       'last_captured_at', day_row.last_captured_at
                     )
                     order by day_row.business_date asc
                   ),
                   '[]'::jsonb
                 ) as attendance_days
            from (
              select ac.business_date,
                     count(*)::integer as checkin_count,
                     min(ac.captured_at) as first_captured_at,
                     max(ac.captured_at) as last_captured_at
                from public.attendance_checkins ac
               where ac.app_user_id = u.app_user_id
                 and ac.business_date between v_month_start and v_month_end
               group by ac.business_date
            ) day_row
        ) att on true
        left join lateral (
          select coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'ANNUAL'),
                   0
                 ) as annual_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'BEREAVEMENT'),
                   0
                 ) as bereavement_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'MARRIAGE'),
                   0
                 ) as marriage_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'SICK'),
                   0
                 ) as sick_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'UNPAID'),
                   0
                 ) as unpaid_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED'),
                   0
                 ) as total_approved_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'PENDING'),
                   0
                 ) as pending_units,
                 count(distinct req.request_id)
                   filter (where req.status = 'APPROVED') as approved_request_count,
                 coalesce(
                   pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'request_id', req.request_id,
                       'request_day_id', d.request_day_id,
                       'leave_date', d.leave_date,
                       'session_code', d.session_code,
                       'leave_type', d.leave_type,
                       'half_day_units', d.half_day_units
                     )
                     order by d.leave_date asc,
                              case d.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                              d.request_day_id asc
                   ) filter (where req.status = 'APPROVED'),
                   '[]'::jsonb
                 ) as leave_days,
                 coalesce(
                   pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'request_id', req.request_id,
                       'request_day_id', d.request_day_id,
                       'leave_date', d.leave_date,
                       'session_code', d.session_code,
                       'leave_type', d.leave_type,
                       'half_day_units', d.half_day_units
                     )
                     order by d.leave_date asc,
                              case d.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                              d.request_day_id asc
                   ) filter (where req.status = 'PENDING'),
                   '[]'::jsonb
                 ) as pending_leave_days
            from public.leave_request_days d
            join public.leave_requests req on req.request_id = d.request_id
           where d.app_user_id = u.app_user_id
             and d.leave_date between v_month_start and v_month_end
        ) m on true
       where u.app_user_id = any(v_page_user_ids)
    ) sub;

  return pg_catalog.jsonb_build_object(
    'year_month', v_ym,
    'leave_year', v_year,
    'month', v_month,
    'as_of_date', v_sync_as_of,
    'unit_kind_filter', coalesce(v_unit_filter, 'ALL'),
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'rows', v_rows
  );
end;
$function$;

revoke all on function public.leave_management_monthly_report(uuid, uuid, text, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.leave_management_monthly_report(uuid, uuid, text, text, text, integer, integer)
  to service_role;

-- =============================================================================
-- 5. Employee Profile Upsert & Aligned Org Guard Trigger
-- =============================================================================

create or replace function public.org_department__internal_guard_leave_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_user public.direct_entry_app_users%rowtype;
  v_has_person_link boolean := false;
  v_org_unit_kind text := null;
begin
  if pg_catalog.current_setting('app.org_leave_profile_sync', true) = 'on' then
    return new;
  end if;

  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = new.app_user_id;

  if not found then
    return new;
  end if;

  select true,
         case
           when op.status = 'ACTIVE'
            and d.is_active = true
            and d.system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD')
           then d.system_key
           else 'UNCLASSIFIED'
         end
    into v_has_person_link, v_org_unit_kind
    from public.organization_account_person_links l
    join public.organization_persons op
      on op.person_id = l.person_id
    left join public.organization_person_department_memberships m
      on m.person_id = l.person_id
     and m.started_at <= v_now
     and (m.ended_at is null or (m.ended_at > m.started_at and v_now < m.ended_at))
    left join public.organization_departments d
      on d.department_id = m.department_id
   where l.app_user_id = new.app_user_id
     and l.started_at <= v_now
     and (l.ended_at is null or (l.ended_at > l.started_at and v_now < l.ended_at))
   order by l.started_at desc, l.link_id desc, m.started_at desc nulls last, m.membership_id desc nulls last
   limit 1;

  if coalesce(v_has_person_link, false) then
    if new.unit_kind is distinct from coalesce(v_org_unit_kind, 'UNCLASSIFIED') then
      raise exception 'LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.org_department__internal_guard_leave_profile()
  from public, anon, authenticated, service_role;

create or replace function public.leave_management_upsert_employee_profile_admin(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_employment_status text,
  p_unit_kind text,
  p_work_start_date date,
  p_official_effective_date date,
  p_next_seniority_effective_date date,
  p_next_seniority_units integer,
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
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_reason text;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_existing_profile public.leave_employee_profiles%rowtype;
  v_has_existing boolean := false;
  v_emp_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_employment_status, 'UNCONFIGURED')));
  v_requested_unit_kind text := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_unit_kind, ''))), '');
  v_org record;
  v_unit_kind text := 'UNCLASSIFIED';
  v_official_date date := p_official_effective_date;
  v_sen_units integer := coalesce(p_next_seniority_units, 0);
  v_seniority_changed boolean := false;
  v_prev_sync text := pg_catalog.current_setting('app.org_leave_profile_sync', true);
  v_profile public.leave_employee_profiles%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;

  if p_target_app_user_id is null then
    raise exception 'LEAVE_TARGET_USER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select u.*
    into v_target_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;

  if not found then
    raise exception 'LEAVE_TARGET_USER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform public.leave_management__internal_lock_employee(p_target_app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'UPSERT_EMPLOYEE_PROFILE_ADMIN'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if v_emp_status not in ('UNCONFIGURED', 'PROBATION', 'OFFICIAL')
     or (
       v_requested_unit_kind is not null
       and v_requested_unit_kind not in ('UNCLASSIFIED', 'RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD')
     )
     or v_sen_units < 0
     or v_sen_units > 60 then
    raise exception 'LEAVE_PROFILE_INVALID'
      using errcode = '22023';
  end if;

  if v_emp_status in ('PROBATION', 'OFFICIAL') and p_work_start_date is null then
    raise exception 'LEAVE_PROFILE_WORK_START_DATE_REQUIRED'
      using errcode = '22023';
  end if;

  if v_emp_status = 'OFFICIAL' then
    v_official_date := coalesce(v_official_date, p_work_start_date);
    if v_official_date is null or v_official_date < p_work_start_date then
      raise exception 'LEAVE_PROFILE_OFFICIAL_DATE_INVALID'
        using errcode = '22023';
    end if;
  elsif v_official_date is not null and p_work_start_date is not null and v_official_date < p_work_start_date then
    raise exception 'LEAVE_PROFILE_OFFICIAL_DATE_INVALID'
      using errcode = '22023';
  end if;

  select p.*
    into v_existing_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_target_app_user_id
   for update;

  if found then
    v_has_existing := true;
    if p_expected_row_version is null or v_existing_profile.row_version <> p_expected_row_version then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using ERRCODE = 'PT409';
    end if;
    v_seniority_changed := (
      v_existing_profile.next_seniority_effective_date is distinct from p_next_seniority_effective_date
      or v_existing_profile.next_seniority_units is distinct from v_sen_units
    );
  else
    if coalesce(p_expected_row_version, 0) <> 0 then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using ERRCODE = 'PT409';
    end if;
    v_seniority_changed := (
      p_next_seniority_effective_date is not null
      or v_sen_units > 0
    );
  end if;

  if v_seniority_changed and not (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  ) then
    raise exception 'LEAVE_SENIORITY_CONFIG_FORBIDDEN'
      using errcode = '42501';
  end if;

  -- Ignore p_unit_kind on write; derive transitional unit_kind strictly from Org
  select *
    into v_org
    from public.leave_management__internal_resolve_person_department(p_target_app_user_id, v_now);

  v_unit_kind := case
    when coalesce(v_org.has_active_person_link, false)
         and v_org.department_system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD')
      then v_org.department_system_key
    else 'UNCLASSIFIED'
  end;

  perform pg_catalog.set_config('app.org_leave_profile_sync', 'on', true);
  begin
    if v_has_existing then
      update public.leave_employee_profiles
         set employment_status = v_emp_status,
             unit_kind = v_unit_kind,
             work_start_date = p_work_start_date,
             official_effective_date = v_official_date,
             next_seniority_effective_date = p_next_seniority_effective_date,
             next_seniority_units = v_sen_units,
             notes = v_reason,
             row_version = row_version + 1,
             updated_at = pg_catalog.timezone('utc', pg_catalog.now()),
             updated_by_app_user_id = p_actor_app_user_id
       where app_user_id = p_target_app_user_id
       returning * into v_profile;
    else
      insert into public.leave_employee_profiles (
        app_user_id,
        employment_status,
        unit_kind,
        work_start_date,
        official_effective_date,
        next_seniority_effective_date,
        next_seniority_units,
        notes,
        row_version,
        updated_by_app_user_id
      )
      values (
        p_target_app_user_id,
        v_emp_status,
        v_unit_kind,
        p_work_start_date,
        v_official_date,
        p_next_seniority_effective_date,
        v_sen_units,
        v_reason,
        1,
        p_actor_app_user_id
      )
      returning * into v_profile;
    end if;

    perform pg_catalog.set_config('app.org_leave_profile_sync', coalesce(v_prev_sync, ''), true);
  exception
    when others then
      perform pg_catalog.set_config('app.org_leave_profile_sync', coalesce(v_prev_sync, ''), true);
      raise;
  end;

  perform public.leave_management__internal_sync_employee_accruals(p_target_app_user_id, v_today);

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    reason,
    payload
  )
  values (
    'EMPLOYEE_PROFILE_UPSERTED',
    p_actor_app_user_id,
    p_target_app_user_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'employment_status', v_profile.employment_status,
      'unit_kind', v_profile.unit_kind,
      'work_start_date', v_profile.work_start_date,
      'official_effective_date', v_profile.official_effective_date,
      'next_seniority_effective_date', v_profile.next_seniority_effective_date,
      'next_seniority_units', v_profile.next_seniority_units,
      'row_version', v_profile.row_version
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'profile', pg_catalog.jsonb_build_object(
      'app_user_id', v_profile.app_user_id,
      'employment_status', v_profile.employment_status,
      'unit_kind', v_profile.unit_kind,
      'work_start_date', v_profile.work_start_date,
      'official_effective_date', v_profile.official_effective_date,
      'next_seniority_effective_date', v_profile.next_seniority_effective_date,
      'next_seniority_units', v_profile.next_seniority_units,
      'notes', v_profile.notes,
      'row_version', v_profile.row_version
    ),
    'routing', public.leave_management__internal_resolve_routing(p_target_app_user_id, v_today),
    'balance', public.leave_management__internal_compute_balance_summary(p_target_app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'UPSERT_EMPLOYEE_PROFILE_ADMIN',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

revoke all on function public.leave_management_upsert_employee_profile_admin(
  uuid, uuid, uuid, text, text, date, date, date, integer, integer, text, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.leave_management_upsert_employee_profile_admin(
  uuid, uuid, uuid, text, text, date, date, date, integer, integer, text, text, text
) to service_role;

-- =============================================================================
-- 6. Owner Alignment & Strict Security/ACL Verification
-- =============================================================================

do $align_and_check_wp10_3$
declare
  v_service_rpcs text[] := array[
    'public.leave_management_create_request(uuid, uuid, jsonb, text, text, text)',
    'public.leave_management_get_my_summary(uuid, uuid, integer)',
    'public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer, text)',
    'public.leave_management_monthly_report(uuid, uuid, text, text, text, integer, integer)',
    'public.leave_management_upsert_employee_profile_admin(uuid, uuid, uuid, text, text, date, date, date, integer, integer, text, text, text)'
  ];
  v_internal_fns text[] := array[
    'public.leave_management__internal_resolve_routing_snapshot(uuid, date)',
    'public.leave_management__internal_compute_balance_summary(uuid, integer, date)',
    'public.org_department__internal_guard_leave_profile()',
    'public.org_department__internal_sync_leave_profile_from_org(uuid, uuid, timestamptz, boolean)'
  ];
  v_sig text;
  v_oid oid;
  v_proc_owner oid;
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean := false;
  v_rec record;
  v_upsert_overload_count integer := 0;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner is null or v_base_owner_oid is null then
    raise exception 'WP10-3 alignment failed: base owner missing' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  select count(*)::integer
    into v_upsert_overload_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'leave_management_upsert_employee_profile_admin';

  if v_upsert_overload_count <> 1 then
    raise exception 'WP10-3 check failed: expected single 13-arg leave_management_upsert_employee_profile_admin, found %', v_upsert_overload_count using errcode = '55000';
  end if;

  if not exists (
    select 1
      from information_schema.columns c
     where c.table_schema = 'public'
       and c.table_name = 'leave_employee_profiles'
       and c.column_name = 'unit_kind'
  ) then
    raise exception 'WP10-3 check failed: transitional leave_employee_profiles.unit_kind column missing' using errcode = '55000';
  end if;

  if not exists (
    select 1
      from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.leave_employee_profiles'::pg_catalog.regclass
       and t.tgname = 'leave_employee_profiles_org_guard_trg'
       and not t.tgisinternal
  ) then
    raise exception 'WP10-3 check failed: leave_employee_profiles_org_guard_trg missing' using errcode = '55000';
  end if;

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-3 check failed: missing service RPC %', v_sig using errcode = '55000';
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
      raise exception 'WP10-3 check failed: definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'WP10-3 check failed: RPC ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-3 check failed: missing internal fn %', v_sig using errcode = '55000';
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
      raise exception 'WP10-3 check failed: internal definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'WP10-3 check failed: internal ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;
end
$align_and_check_wp10_3$;

commit;
