-- =============================================================================
-- WP7A: Leave Management & Attendance Explanations -> WP3 Org/Person + WP5 Paired Authz
--
-- Forward-only migration applying cleanly after 20261119090000_hf_account_intent_retention.sql.
-- Zero existing pending request/explanation mutations (snapshots remain frozen).
-- Zero JSON keyset breaks for existing Web/Mobile strict projectors.
-- Zero email literals or at-signs, zero savepoints, zero alter default privileges,
-- exact service_role RPC routine inventory preserved.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Additive nullable department snapshot columns on leave_requests &
--    attendance_explanations (zero backfill/mutation of existing rows)
-- -----------------------------------------------------------------------------
alter table public.leave_requests
  add column if not exists routed_department_id uuid null
    references public.organization_departments(department_id) on delete restrict,
  add column if not exists routed_department_code text null,
  add column if not exists routed_department_name text null;

create index if not exists leave_requests_routed_department_idx
  on public.leave_requests (routed_department_id, status, submitted_at desc)
  where routed_department_id is not null;

alter table public.attendance_explanations
  add column if not exists routed_department_id uuid null
    references public.organization_departments(department_id) on delete restrict,
  add column if not exists routed_department_code text null,
  add column if not exists routed_department_name text null;

create index if not exists attendance_explanations_routed_department_idx
  on public.attendance_explanations (routed_department_id, status, submitted_at desc)
  where routed_department_id is not null;

-- -----------------------------------------------------------------------------
-- 2. New internal WP3 Org/Person helpers for Leave & Attendance Explanations
--    (strictly internal: REVOKE ALL from public, anon, authenticated, service_role)
-- -----------------------------------------------------------------------------
create or replace function public.leave_management__internal_resolve_person_department(
  p_app_user_id uuid,
  p_as_of_ts timestamptz default pg_catalog.clock_timestamp()
)
returns table(
  has_active_person_link boolean,
  person_id uuid,
  employee_code text,
  full_name text,
  person_status text,
  department_id uuid,
  department_code text,
  department_name text,
  department_system_key text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of_ts, pg_catalog.clock_timestamp());
begin
  if p_app_user_id is null then
    return query select false, null::uuid, null::text, null::text, null::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;

  return query
  with active_link as (
    select l.person_id,
           op.employee_code,
           op.full_name,
           op.status as person_status
      from public.direct_entry_app_users u
      join public.organization_account_person_links l
        on l.app_user_id = u.app_user_id
       and l.started_at <= v_as_of
       and (l.ended_at is null or (l.ended_at > l.started_at and v_as_of < l.ended_at))
      join public.organization_persons op
        on op.person_id = l.person_id
     where u.app_user_id = p_app_user_id
       and u.account_type = 'NORMAL'
     order by l.started_at desc, l.link_id desc
     limit 1
  ),
  active_dept as (
    select d.department_id,
           d.code as department_code,
           d.name as department_name,
           d.system_key as department_system_key
      from active_link al
      join public.organization_person_department_memberships m
        on m.person_id = al.person_id
       and m.started_at <= v_as_of
       and (m.ended_at is null or (m.ended_at > m.started_at and v_as_of < m.ended_at))
      join public.organization_departments d
        on d.department_id = m.department_id
       and d.is_active = true
     where al.person_status = 'ACTIVE'
     order by m.started_at desc, m.membership_id desc
     limit 1
  )
  select (al.person_id is not null) as has_active_person_link,
         al.person_id,
         al.employee_code,
         al.full_name,
         al.person_status,
         ad.department_id,
         ad.department_code,
         ad.department_name,
         ad.department_system_key
    from (select 1 as anchor) a
    left join active_link al on true
    left join active_dept ad on true;
end;
$function$;

create or replace function public.leave_management__internal_has_open_department_head(
  p_department_id uuid,
  p_as_of_ts timestamptz default pg_catalog.clock_timestamp()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of_ts, pg_catalog.clock_timestamp());
begin
  if p_department_id is null then
    return false;
  end if;

  return exists (
    select 1
      from public.organization_department_heads dh
      join public.organization_departments d
        on d.department_id = dh.department_id
       and d.is_active = true
     where dh.department_id = p_department_id
       and dh.started_at <= v_as_of
       and (dh.ended_at is null or (dh.ended_at > dh.started_at and v_as_of < dh.ended_at))
  );
end;
$function$;

create or replace function public.leave_management__internal_resolve_department_head_user(
  p_department_id uuid,
  p_as_of_ts timestamptz default pg_catalog.clock_timestamp()
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of_ts, pg_catalog.clock_timestamp());
  v_head_app_user_id uuid;
begin
  if p_department_id is null then
    return null;
  end if;

  select u.app_user_id
    into v_head_app_user_id
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
     and m.started_at <= v_as_of
     and (m.ended_at is null or (m.ended_at > m.started_at and v_as_of < m.ended_at))
    join public.organization_account_person_links l
      on l.person_id = dh.person_id
     and l.started_at <= v_as_of
     and (l.ended_at is null or (l.ended_at > l.started_at and v_as_of < l.ended_at))
    join public.direct_entry_app_users u
      on u.app_user_id = l.app_user_id
     and u.enabled = true
     and u.account_type = 'NORMAL'
   where dh.department_id = p_department_id
     and dh.started_at <= v_as_of
     and (dh.ended_at is null or (dh.ended_at > dh.started_at and v_as_of < dh.ended_at))
     and not exists (
       select 1
         from public.leave_employee_profiles lp
        where lp.app_user_id = u.app_user_id
          and lp.is_shared_non_employee = true
     )
   order by dh.started_at desc, dh.head_assignment_id desc
   limit 1;

  return v_head_app_user_id;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 3. Core Leave & Explanation Internal Resolvers (WP3 Identity/Org + WP5 Paired Authz)
--    Exact JSON keysets preserved for backward compatibility with Web & Mobile.
-- -----------------------------------------------------------------------------
create or replace function public.leave_management__internal_account_summary(
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
  v_person_name text;
  v_person_code text;
  v_recruiter_id uuid;
  v_recruiter_name text;
  v_recruiter_code text;
  v_login_id text;
begin
  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found then
    return null;
  end if;

  select op.full_name, op.employee_code
    into v_person_name, v_person_code
    from public.organization_account_person_links l
    join public.organization_persons op
      on op.person_id = l.person_id
   where l.app_user_id = v_user.app_user_id
     and l.started_at <= v_now
     and (l.ended_at is null or (l.ended_at > l.started_at and v_now < l.ended_at))
   order by l.started_at desc, l.link_id desc
   limit 1;

  select r.recruiter_id, r.display_name, r.personnel_code
    into v_recruiter_id, v_recruiter_name, v_recruiter_code
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r on r.recruiter_id = l.recruiter_id
   where l.app_user_id = v_user.app_user_id
     and l.verified = true
     and l.is_current = true
   order by l.valid_from desc, l.link_id desc
   limit 1;

  select pg_catalog.lower(
           nullif(
             pg_catalog.split_part(
               coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
               pg_catalog.chr(64),
               1
             ),
             ''
           )
         )
    into v_login_id
    from auth.users au
   where au.id = v_user.auth_subject;

  return pg_catalog.jsonb_build_object(
    'app_user_id', v_user.app_user_id,
    'display_name', coalesce(v_person_name, v_recruiter_name, v_user.display_name),
    'login_id', v_login_id,
    'personnel_code', coalesce(v_person_code, v_recruiter_code),
    'recruiter_id', v_recruiter_id,
    'account_enabled', v_user.enabled
  );
end;
$function$;

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
  v_account_type text := 'NORMAL';
  v_profile_is_shared boolean := false;
  v_is_shared boolean := false;
  v_is_full_admin boolean := false;
  v_is_bod boolean := false;
  v_is_admin_bod_grant boolean := false;
  v_is_hr_operator boolean := false;
  v_is_hr_report_viewer boolean := false;
  v_is_team_leader boolean := false;
  v_is_dept_head boolean := false;
  v_is_compat_dept_approver boolean := false;
  v_is_dept_approver boolean := false;
  v_has_pending_snapshot_approval boolean := false;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'Direct entry actor mapping is not active'
      using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select u.account_type
    into v_account_type
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  select exists (
           select 1
             from public.leave_employee_profiles p
            where p.app_user_id = p_app_user_id
              and p.is_shared_non_employee = true
         )
    into v_profile_is_shared;

  v_is_shared := (coalesce(v_account_type, 'NORMAL') in ('SHARED', 'SERVICE'))
                 or coalesce(v_profile_is_shared, false);

  if not v_is_shared then
    -- WP5 paired capability + scope checks (eliminates HR_OPERATOR + TEAM_LEADER Cartesian escalation)
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

    select exists (
             select 1
               from public.leave_module_grants g
              where g.app_user_id = p_app_user_id
                and g.role_code = 'LEAVE_ADMIN_BOD_APPROVER'
                and g.is_current = true
                and g.valid_from <= v_today
                and (g.valid_to is null or v_today < g.valid_to)
           ),
           exists (
             select 1
               from public.leave_module_grants g
              where g.app_user_id = p_app_user_id
                and g.role_code = 'HR_LEAVE_OPERATOR'
                and g.is_current = true
                and g.valid_from <= v_today
                and (g.valid_to is null or v_today < g.valid_to)
           ),
           exists (
             select 1
               from public.leave_module_grants g
              where g.app_user_id = p_app_user_id
                and g.role_code = 'HR_REPORT_VIEWER'
                and g.is_current = true
                and g.valid_from <= v_today
                and (g.valid_to is null or v_today < g.valid_to)
           )
      into v_is_admin_bod_grant, v_is_hr_operator, v_is_hr_report_viewer;

    select exists (
             select 1
               from public.direct_entry_team_leader_assignments tla
              where tla.leader_app_user_id = p_app_user_id
                and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
           )
      into v_is_team_leader;

    -- Canonical WP3 Department HEAD (must hold active membership in active dept + active person + active link)
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

    -- Compatibility fallback to legacy leave_department_approvers ONLY when the unit has no open org HEAD
    select exists (
             select 1
               from public.leave_department_approvers da
              where da.approver_app_user_id = p_app_user_id
                and da.valid_from <= v_today
                and (da.valid_to is null or v_today < da.valid_to)
                and (da.valid_to is null or da.valid_to > da.valid_from)
                and not exists (
                  select 1
                    from public.organization_departments d
                   where d.system_key = da.unit_kind
                     and d.is_active = true
                     and public.leave_management__internal_has_open_department_head(d.department_id, v_now)
                )
           )
      into v_is_compat_dept_approver;

    v_is_dept_approver := (v_is_dept_head or v_is_compat_dept_approver);

    -- Allow a previously snapshotted primary approver to access inbox strictly for pending frozen items
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
    'is_shared_non_employee', v_is_shared,
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

-- Single-statement MVCC-atomic routing + routed_department resolver.
-- Evaluates org membership, department metadata, department head, legacy compat approver,
-- and recruiter team/leader inside ONE SQL query so route_kind, unit_kind, primary_approver,
-- and routed_department_{id,code,name} are guaranteed to belong to the exact same state.
create or replace function public.leave_management__internal_resolve_routing_snapshot(
  p_app_user_id uuid,
  p_as_of date default public.leave_management__internal_business_date()
)
returns table (
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
    select coalesce(u.account_type, 'NORMAL') as account_type,
           (p.app_user_id is not null) as has_profile,
           (
             p.app_user_id is not null
             and coalesce(u.account_type, 'NORMAL') = 'NORMAL'
             and not p.is_shared_non_employee
             and p.employment_status in ('PROBATION', 'OFFICIAL')
             and p.work_start_date is not null
             and (
               p.employment_status <> 'OFFICIAL'
               or p.official_effective_date is not null
             )
           ) as profile_configured,
           p.unit_kind as profile_unit_kind
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
       and u.account_type = 'NORMAL'
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
  legacy_fallback_dept as (
    select d.department_id,
           d.code as department_code,
           d.name as department_name,
           d.system_key as department_system_key
      from user_ctx uc
      left join active_link al on true
      join public.organization_departments d
        on d.system_key = uc.profile_unit_kind
       and d.is_active = true
     where al.person_id is null
       and uc.has_profile = true
       and uc.profile_unit_kind in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD')
     order by d.department_id asc
     limit 1
  ),
  resolved_org as (
    select (al.person_id is not null) as has_active_person_link,
           case
             when al.person_id is not null then apd.department_id
             else lfd.department_id
           end as department_id,
           case
             when al.person_id is not null then apd.department_code
             else lfd.department_code
           end as department_code,
           case
             when al.person_id is not null then apd.department_name
             else lfd.department_name
           end as department_name,
           case
             when al.person_id is not null then apd.department_system_key
             else lfd.department_system_key
           end as department_system_key,
           case
             when al.person_id is not null then coalesce(apd.department_system_key, 'UNCLASSIFIED')
             when uc.has_profile then uc.profile_unit_kind
             else 'UNCLASSIFIED'
           end as unit_kind
      from user_ctx uc
      left join active_link al on true
      left join active_person_dept apd on true
      left join legacy_fallback_dept lfd on true
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
                and u.account_type = 'NORMAL'
              where ro.department_id is not null
                and dh.started_at <= nc.v_now
                and (dh.ended_at is null or (dh.ended_at > dh.started_at and nc.v_now < dh.ended_at))
                and not exists (
                  select 1
                    from public.leave_employee_profiles lp
                   where lp.app_user_id = u.app_user_id
                     and lp.is_shared_non_employee = true
                )
              order by dh.started_at desc, dh.head_assignment_id desc
              limit 1
           ) as org_head_app_user_id,
           (
             select da.approver_app_user_id
               from public.leave_department_approvers da
               join public.direct_entry_app_users u
                 on u.app_user_id = da.approver_app_user_id
                and u.enabled = true
                and u.account_type = 'NORMAL'
              where ro.unit_kind in ('MARKETING', 'IT', 'ACCOUNTING')
                and da.unit_kind = ro.unit_kind
                and da.valid_from <= p_as_of
                and (da.valid_to is null or p_as_of < da.valid_to)
                and (da.valid_to is null or da.valid_to > da.valid_from)
                and not exists (
                  select 1
                    from public.leave_employee_profiles lp
                   where lp.app_user_id = u.app_user_id
                     and lp.is_shared_non_employee = true
                )
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
                and u.account_type = 'NORMAL'
              where not exists (
                select 1
                  from public.leave_employee_profiles lp
                 where lp.app_user_id = u.app_user_id
                   and lp.is_shared_non_employee = true
              )
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
       and lu.account_type = 'NORMAL'
     where tc.team_count = 1
       and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, p_as_of)
       and not exists (
         select 1
           from public.leave_employee_profiles lp
          where lp.app_user_id = lu.app_user_id
            and lp.is_shared_non_employee = true
       )
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

  if v_snap.is_requester_team_leader
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

-- Exact 8-key public routing projection wrapper (zero extra keys leaked to strict projectors)
create or replace function public.leave_management__internal_resolve_routing(
  p_app_user_id uuid,
  p_as_of date default public.leave_management__internal_business_date()
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select s.routing
    from public.leave_management__internal_resolve_routing_snapshot(p_app_user_id, p_as_of) s
   limit 1;
$function$;

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
  v_has_open_org_head boolean := false;
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

  if not found or not v_user.enabled or v_user.account_type <> 'NORMAL' then
    return false;
  end if;

  v_auth := public.leave_management__internal_resolve_authority(v_user.auth_subject, p_actor_app_user_id);
  if coalesce((v_auth->>'is_shared_non_employee')::boolean, false) then
    return false;
  end if;

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

      if v_dept_id is not null then
        v_has_open_org_head := public.leave_management__internal_has_open_department_head(v_dept_id, v_now);
        if public.leave_management__internal_resolve_department_head_user(v_dept_id, v_now) = p_actor_app_user_id then
          return true;
        end if;
      end if;

      if not v_has_open_org_head and p_request.unit_kind_snapshot in ('MARKETING', 'IT', 'ACCOUNTING') then
        select exists (
                 select 1
                   from public.leave_department_approvers da
                  where da.unit_kind = p_request.unit_kind_snapshot
                    and da.approver_app_user_id = p_actor_app_user_id
                    and da.valid_from <= v_as_of
                    and (da.valid_to is null or v_as_of < da.valid_to)
                    and (da.valid_to is null or da.valid_to > da.valid_from)
               )
          into v_is_live_route_approver;
        return v_is_live_route_approver;
      end if;
    end if;
  end if;

  return false;
end;
$function$;

create or replace function public.attendance_explanation__internal_can_actor_decide(
  p_actor_app_user_id uuid,
  p_explanation public.attendance_explanations,
  p_as_of date default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_leave_req public.leave_requests%rowtype;
begin
  v_leave_req.request_id := p_explanation.explanation_id;
  v_leave_req.app_user_id := p_explanation.app_user_id;
  v_leave_req.status := p_explanation.status;
  v_leave_req.unit_kind_snapshot := p_explanation.unit_kind_snapshot;
  v_leave_req.route_kind := p_explanation.route_kind;
  v_leave_req.primary_approver_app_user_id := p_explanation.primary_approver_app_user_id;
  v_leave_req.routed_team_id := p_explanation.routed_team_id;
  v_leave_req.routed_team_code := p_explanation.routed_team_code;
  v_leave_req.routed_team_name := p_explanation.routed_team_name;
  v_leave_req.routed_department_id := p_explanation.routed_department_id;
  v_leave_req.routed_department_code := p_explanation.routed_department_code;
  v_leave_req.routed_department_name := p_explanation.routed_department_name;
  v_leave_req.fallback_reason := p_explanation.fallback_reason;

  return public.leave_management__internal_can_actor_decide_request(
    p_actor_app_user_id,
    v_leave_req,
    coalesce(p_as_of, public.leave_management__internal_business_date())
  );
end;
$function$;

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
  v_account_type text := 'NORMAL';
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
  select u.account_type
    into v_account_type
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_app_user_id;

  if found then
    v_has_profile := true;
    v_profile_configured := (
      coalesce(v_account_type, 'NORMAL') = 'NORMAL'
      and not v_profile.is_shared_non_employee
      and v_profile.employment_status in ('PROBATION', 'OFFICIAL')
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
    v_effective_unit_kind := case when v_has_profile then v_profile.unit_kind else 'UNCLASSIFIED' end;
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

-- -----------------------------------------------------------------------------
-- 4. Public service_role RPC Updates (exact existing signatures preserved)
-- -----------------------------------------------------------------------------
create or replace function public.leave_management_list_approval_inbox(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_status_filter text default 'PENDING',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_auth jsonb;
  v_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_status_filter, 'PENDING')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_items jsonb := '[]'::jsonb;
  v_total integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_approve_requests')::boolean, false) then
    raise exception 'LEAVE_APPROVAL_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_status not in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'WITHDRAWN', 'ALL') then
    raise exception 'LEAVE_FILTER_INVALID'
      using errcode = '22023';
  end if;

  select count(*)::integer
    into v_total
    from public.leave_requests r
   where (v_status = 'ALL' or r.status = v_status)
     and (
       public.leave_management__internal_can_actor_decide_request(p_actor_app_user_id, r, v_today)
       or r.decided_by_app_user_id = p_actor_app_user_id
     );

  select coalesce(
           pg_catalog.jsonb_agg(
             public.leave_management__internal_project_request(sub.r)
             order by sub.submitted_at desc, sub.request_id desc
           ),
           '[]'::jsonb
         )
    into v_items
    from (
      select r,
             r.submitted_at,
             r.request_id
        from public.leave_requests r
       where (v_status = 'ALL' or r.status = v_status)
         and (
           public.leave_management__internal_can_actor_decide_request(p_actor_app_user_id, r, v_today)
           or r.decided_by_app_user_id = p_actor_app_user_id
         )
       order by r.submitted_at desc, r.request_id desc
       limit v_limit
      offset v_offset
    ) sub;

  return pg_catalog.jsonb_build_object(
    'as_of_date', v_today,
    'status_filter', v_status,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'items', v_items
  );
end;
$function$;

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

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'grant_id', g.grant_id,
               'app_user_id', g.app_user_id,
               'account', public.leave_management__internal_account_summary(g.app_user_id),
               'role_code', g.role_code,
               'valid_from', g.valid_from,
               'valid_to', g.valid_to,
               'is_current', g.is_current,
               'reason', g.reason,
               'row_version', g.row_version
             )
             order by g.role_code asc, g.created_at desc
           ),
           '[]'::jsonb
         )
    into v_module_grants
    from public.leave_module_grants g
   where g.is_current = true;

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
                     'is_shared_non_employee', sub.is_shared_non_employee,
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
                     'is_shared_non_employee', sub.is_shared_non_employee,
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
             (u.account_type in ('SHARED', 'SERVICE') or coalesce(p.is_shared_non_employee, false)) as is_shared_non_employee,
             coalesce(p.employment_status, 'UNCONFIGURED') as employment_status,
             case
               when org_p.has_active_person_link then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
               else coalesce(p.unit_kind, 'UNCLASSIFIED')
             end as unit_kind,
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

create or replace function public.leave_management_monthly_report(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_year_month text,
  p_unit_kind_filter text default null,
  p_search text default null,
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
   where u.account_type = 'NORMAL'
     and coalesce(p.is_shared_non_employee, false) = false
     and (
       v_unit_filter is null
       or v_unit_filter = 'ALL'
       or (
         case
           when org_p.has_active_person_link then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
           else coalesce(p.unit_kind, 'UNCLASSIFIED')
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
       where u.account_type = 'NORMAL'
         and coalesce(p.is_shared_non_employee, false) = false
         and (
           v_unit_filter is null
           or v_unit_filter = 'ALL'
           or (
             case
               when org_p.has_active_person_link then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
               else coalesce(p.unit_kind, 'UNCLASSIFIED')
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
       and u.account_type = 'NORMAL'
       and (
         (
           p.app_user_id is not null
           and p.is_shared_non_employee = false
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
             coalesce(p.employment_status, 'UNCONFIGURED') as employment_status,
             case
               when org_p.has_active_person_link then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
               else coalesce(p.unit_kind, 'UNCLASSIFIED')
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
  v_today date := public.leave_management__internal_business_date();
  v_auth jsonb;
  v_reason text;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_unit text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_unit_kind, '')));
  v_valid_from date := coalesce(p_valid_from, v_today);
  v_current public.leave_department_approvers%rowtype;
  v_has_current boolean := false;
  v_new_row public.leave_department_approvers%rowtype;
  v_approver_user public.direct_entry_app_users%rowtype;
  v_approver_is_shared boolean := false;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  ) then
    raise exception 'LEAVE_DEPARTMENT_APPROVER_ADMIN_FORBIDDEN'
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

  if v_unit not in ('MARKETING', 'IT', 'ACCOUNTING') then
    raise exception 'LEAVE_UNIT_KIND_INVALID'
      using errcode = '22023';
  end if;

  -- Serialize concurrent writes per unit_kind (including initial row creation) before idempotency check
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('leave_dept_approver_v1'),
    pg_catalog.hashtext(v_unit)
  );

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'SET_DEPARTMENT_APPROVER_ADMIN'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if v_valid_from > v_today then
    raise exception 'LEAVE_DEPARTMENT_APPROVER_FUTURE_DATE_FORBIDDEN'
      using errcode = '22023';
  end if;

  if v_valid_from < v_today then
    raise exception 'LEAVE_DEPARTMENT_APPROVER_PAST_DATE_FORBIDDEN'
      using errcode = '22023';
  end if;

  if p_approver_app_user_id is not null then
    select u.*
      into v_approver_user
      from public.direct_entry_app_users u
     where u.app_user_id = p_approver_app_user_id
       and u.enabled = true;

    if not found then
      raise exception 'LEAVE_APPROVER_USER_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    select (
             v_approver_user.account_type in ('SHARED', 'SERVICE')
             or exists (
               select 1
                 from public.leave_employee_profiles lp
                where lp.app_user_id = p_approver_app_user_id
                  and lp.is_shared_non_employee = true
             )
           )
      into v_approver_is_shared;

    if v_approver_is_shared then
      raise exception 'LEAVE_SHARED_ACCOUNT_FORBIDDEN'
        using errcode = '42501';
    end if;
  end if;

  select da.*
    into v_current
    from public.leave_department_approvers da
   where da.unit_kind = v_unit
     and da.is_current = true
   for update;

  if found then
    v_has_current := true;
    if p_expected_row_version is null or v_current.row_version <> p_expected_row_version then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;

    update public.leave_department_approvers
       set is_current = false,
           valid_to = case
             when valid_from < v_valid_from then v_valid_from
             else valid_from
           end,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now()),
           updated_by_app_user_id = p_actor_app_user_id
     where unit_kind = v_unit
       and (is_current = true or valid_to is null or valid_to > v_valid_from);
  else
    if coalesce(p_expected_row_version, 0) <> 0 then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;
  end if;

  if p_approver_app_user_id is not null then
    insert into public.leave_department_approvers (
      unit_kind,
      approver_app_user_id,
      valid_from,
      valid_to,
      is_current,
      reason,
      row_version,
      updated_by_app_user_id
    )
    values (
      v_unit,
      p_approver_app_user_id,
      v_valid_from,
      null,
      true,
      v_reason,
      case when v_has_current then v_current.row_version + 1 else 1 end,
      p_actor_app_user_id
    )
    returning * into v_new_row;
  end if;

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    reason,
    payload
  )
  values (
    'DEPARTMENT_APPROVER_UPDATED',
    p_actor_app_user_id,
    p_approver_app_user_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'unit_kind', v_unit,
      'approver_app_user_id', p_approver_app_user_id,
      'valid_from', v_valid_from
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'department_approver', case
      when p_approver_app_user_id is not null then
        pg_catalog.jsonb_build_object(
          'approver_assignment_id', v_new_row.approver_assignment_id,
          'unit_kind', v_new_row.unit_kind,
          'approver_app_user_id', v_new_row.approver_app_user_id,
          'approver', public.leave_management__internal_account_summary(v_new_row.approver_app_user_id),
          'valid_from', v_new_row.valid_from,
          'valid_to', v_new_row.valid_to,
          'is_current', v_new_row.is_current,
          'reason', v_new_row.reason,
          'row_version', v_new_row.row_version
        )
      else
        null
    end
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'SET_DEPARTMENT_APPROVER_ADMIN',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

create or replace function public.leave_management_preview_opening_batch(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_leave_year integer,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := coalesce(p_leave_year, pg_catalog.date_part('year', v_today)::integer);
  v_auth jsonb;
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_rows_fingerprint text;
  v_item jsonb;
  v_lock_uid uuid;
  v_idx integer := 0;
  v_target_id_text text;
  v_target_id uuid;
  v_target_account_type text := 'NORMAL';
  v_carry_units integer;
  v_open_units integer;
  v_sen_units integer;
  v_note text;
  v_seen_ids uuid[] := array[]::uuid[];
  v_account jsonb;
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean;
  v_row_errors jsonb;
  v_preview_rows jsonb := '[]'::jsonb;
  v_rows_state jsonb := '[]'::jsonb;
  v_error_count integer := 0;
  v_total_carry integer := 0;
  v_total_open integer := 0;
  v_total_sen integer := 0;
  v_has_carry_expiry_error boolean := false;
  v_current_year_accrued integer := 0;
  v_current_year_granted integer := 0;
  v_current_year_locked integer := 0;
  v_current_year_available integer := 0;
  v_delta_current_year integer := 0;
  v_reconciled_current_year_granted integer := 0;
  v_reconciled_current_year_available integer := 0;
  v_profile_row_version integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_year < 2020 or v_year > 2100 then
    raise exception 'LEAVE_YEAR_INVALID'
      using errcode = '22023';
  end if;

  if p_rows is null
     or pg_catalog.jsonb_typeof(p_rows) <> 'array'
     or pg_catalog.jsonb_array_length(p_rows) < 1
     or pg_catalog.jsonb_array_length(p_rows) > 300 then
    raise exception 'LEAVE_OPENING_ROWS_INVALID'
      using errcode = '22023';
  end if;

  v_rows_fingerprint := public.leave_management__internal_opening_rows_fingerprint(p_rows);

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  v_carry_over_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  -- Canonical ascending lock order across all distinct valid UUID targets before looping
  for v_lock_uid in
    select distinct (pg_catalog.btrim(elem->>'app_user_id'))::uuid as uid
      from pg_catalog.jsonb_array_elements(p_rows) as elem
     where pg_catalog.jsonb_typeof(elem) = 'object'
       and pg_catalog.btrim(coalesce(elem->>'app_user_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     order by 1 asc
  loop
    perform public.leave_management__internal_lock_employee(v_lock_uid);
  end loop;

  for v_item in
    select value
      from pg_catalog.jsonb_array_elements(p_rows)
  loop
    v_idx := v_idx + 1;
    v_row_errors := '[]'::jsonb;
    v_target_id := null;
    v_target_account_type := 'NORMAL';
    v_account := null;
    v_has_profile := false;
    v_current_year_accrued := 0;
    v_current_year_granted := 0;
    v_current_year_locked := 0;
    v_current_year_available := 0;
    v_delta_current_year := 0;
    v_reconciled_current_year_granted := 0;
    v_reconciled_current_year_available := 0;
    v_profile_row_version := 0;

    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('ROW_NOT_OBJECT');
      v_carry_units := 0;
      v_open_units := 0;
      v_sen_units := 0;
      v_note := null;
    else
      v_target_id_text := pg_catalog.btrim(coalesce(v_item->>'app_user_id', ''));
      begin
        v_target_id := v_target_id_text::uuid;
      exception
        when others then
          v_target_id := null;
      end;

      begin
        v_carry_units := coalesce((v_item->>'carry_over_units')::integer, 0);
        v_open_units := coalesce((v_item->>'opening_current_year_units')::integer, 0);
        v_sen_units := coalesce((v_item->>'seniority_units')::integer, 0);
      exception
        when others then
          v_carry_units := -1;
          v_open_units := -1;
          v_sen_units := -1;
      end;

      v_note := nullif(pg_catalog.btrim(coalesce(v_item->>'note', '')), '');
      v_delta_current_year := greatest(coalesce(v_open_units, 0), 0);
      v_reconciled_current_year_granted := greatest(coalesce(v_open_units, 0), 0);
      v_reconciled_current_year_available := greatest(coalesce(v_open_units, 0), 0);

      if v_target_id is null then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('INVALID_APP_USER_ID');
      else
        if v_target_id = any(v_seen_ids) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('DUPLICATE_APP_USER_IN_BATCH');
        else
          v_seen_ids := pg_catalog.array_append(v_seen_ids, v_target_id);
        end if;

        v_account := public.leave_management__internal_account_summary(v_target_id);
        if v_account is null then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('APP_USER_NOT_FOUND');
        else
          select u.account_type
            into v_target_account_type
            from public.direct_entry_app_users u
           where u.app_user_id = v_target_id;
        end if;

        select p.*
          into v_profile
          from public.leave_employee_profiles p
         where p.app_user_id = v_target_id;
        v_has_profile := found;

        if coalesce(v_target_account_type, 'NORMAL') in ('SHARED', 'SERVICE')
           or (v_has_profile and v_profile.is_shared_non_employee) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('SHARED_ACCOUNT_NOT_ELIGIBLE');
        elsif v_account is not null and (not v_has_profile or v_profile.employment_status <> 'OFFICIAL') then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('EMPLOYEE_NOT_OFFICIAL');
        elsif v_account is not null and v_has_profile and v_profile.employment_status = 'OFFICIAL' then
          perform public.leave_management__internal_sync_employee_accruals(v_target_id, v_today);

          select p.*
            into v_profile
            from public.leave_employee_profiles p
           where p.app_user_id = v_target_id;

          v_profile_row_version := coalesce(v_profile.row_version, 1);

          select
            coalesce(
              sum(coalesce((l.metadata->>'initial_granted_units')::integer, l.granted_units))
                filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')),
              0
            )::integer,
            coalesce(sum(l.granted_units), 0)::integer,
            coalesce(sum(l.reserved_units + l.consumed_units + l.expired_units), 0)::integer,
            coalesce(sum(greatest(l.granted_units - l.reserved_units - l.consumed_units - l.expired_units, 0)), 0)::integer
          into
            v_current_year_accrued,
            v_current_year_granted,
            v_current_year_locked,
            v_current_year_available
          from public.leave_lots l
          where l.app_user_id = v_target_id
            and l.leave_year = v_year
            and l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP', 'OPENING_CURRENT_YEAR', 'MANUAL_ADJUSTMENT');

          v_delta_current_year := greatest(coalesce(v_open_units, 0), 0) - v_current_year_granted;
          v_reconciled_current_year_granted := greatest(coalesce(v_open_units, 0), 0);
          v_reconciled_current_year_available := greatest(
            greatest(coalesce(v_open_units, 0), 0) - v_current_year_locked,
            0
          );

          if v_open_units >= 0 and v_open_units < v_current_year_locked then
            v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('OPENING_TARGET_BELOW_LOCKED_BALANCE');
          end if;
        end if;
      end if;

      if v_carry_units < 0 or v_carry_units > 120
         or v_open_units < 0 or v_open_units > 120
         or v_sen_units < 0 or v_sen_units > 60 then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('UNITS_OUT_OF_RANGE');
      elsif (v_carry_units + v_open_units + v_sen_units) <= 0 and v_delta_current_year = 0 then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('ZERO_UNITS_ROW');
      end if;

      if v_carry_units > 0 and v_carry_over_expiry is null then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED');
        v_has_carry_expiry_error := true;
      end if;

      if v_target_id is not null and v_carry_units > 0 then
        if exists (
          select 1
            from public.leave_lots l
           where l.app_user_id = v_target_id
             and l.leave_year = v_year
             and l.lot_kind = 'CARRY_OVER'
        ) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('CARRY_OVER_LOT_ALREADY_EXISTS');
        end if;
      end if;

      if v_target_id is not null and v_sen_units > 0 then
        if exists (
          select 1
            from public.leave_lots l
           where l.app_user_id = v_target_id
             and l.leave_year = v_year
             and l.lot_kind = 'SENIORITY_GRANT'
        ) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('SENIORITY_LOT_ALREADY_EXISTS');
        end if;
      end if;
    end if;

    if pg_catalog.jsonb_array_length(v_row_errors) > 0 then
      v_error_count := v_error_count + 1;
    else
      v_total_carry := v_total_carry + v_carry_units;
      v_total_open := v_total_open + v_open_units;
      v_total_sen := v_total_sen + v_sen_units;
    end if;

    v_rows_state := v_rows_state || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'row_index', v_idx,
        'app_user_id', v_target_id,
        'employment_status', case when v_has_profile then v_profile.employment_status else null end,
        'profile_row_version', v_profile_row_version,
        'current_year_accrued_units', v_current_year_accrued,
        'current_year_granted_units', v_current_year_granted,
        'current_year_locked_units', v_current_year_locked,
        'current_year_available_units', v_current_year_available,
        'delta_current_year_units', v_delta_current_year
      )
    );

    v_preview_rows := v_preview_rows || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'row_index', v_idx,
        'app_user_id', v_target_id,
        'account', v_account,
        'as_of_date', v_today,
        'carry_over_units', greatest(coalesce(v_carry_units, 0), 0),
        'opening_current_year_units', greatest(coalesce(v_open_units, 0), 0),
        'target_current_year_units', greatest(coalesce(v_open_units, 0), 0),
        'current_year_accrued_units', v_current_year_accrued,
        'current_year_granted_units', v_current_year_granted,
        'current_year_locked_units', v_current_year_locked,
        'current_year_available_units', v_current_year_available,
        'delta_current_year_units', v_delta_current_year,
        'reconciled_current_year_granted_units', v_reconciled_current_year_granted,
        'reconciled_current_year_available_units', v_reconciled_current_year_available,
        'profile_row_version', v_profile_row_version,
        'seniority_units', greatest(coalesce(v_sen_units, 0), 0),
        'note', v_note,
        'valid', (pg_catalog.jsonb_array_length(v_row_errors) = 0),
        'errors', v_row_errors
      )
    );
  end loop;

  if v_error_count = 0 and v_idx > 0 then
    insert into public.leave_opening_preview_snapshots (
      actor_app_user_id,
      leave_year,
      rows_fingerprint,
      as_of_date,
      carry_over_expires_after_date,
      rows_state,
      created_at,
      consumed_at
    )
    values (
      p_actor_app_user_id,
      v_year,
      v_rows_fingerprint,
      v_today,
      v_carry_over_expiry,
      v_rows_state,
      pg_catalog.timezone('utc', pg_catalog.now()),
      null
    )
    on conflict (actor_app_user_id, leave_year, rows_fingerprint) do update
      set as_of_date = excluded.as_of_date,
          carry_over_expires_after_date = excluded.carry_over_expires_after_date,
          rows_state = excluded.rows_state,
          created_at = excluded.created_at,
          consumed_at = null;
  end if;

  return pg_catalog.jsonb_build_object(
    'leave_year', v_year,
    'as_of_date', v_today,
    'carry_over_expires_after_date', v_carry_over_expiry,
    'valid', (v_error_count = 0),
    'has_carry_over_expiry_error', v_has_carry_expiry_error,
    'row_count', v_idx,
    'error_row_count', v_error_count,
    'total_carry_over_units', v_total_carry,
    'total_opening_current_year_units', v_total_open,
    'total_seniority_units', v_total_sen,
    'rows_state', v_rows_state,
    'rows', v_preview_rows
  );
end;
$function$;

create or replace function public.attendance_decide_explanation(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_explanation_id uuid,
  p_decision text,
  p_expected_row_version integer,
  p_decision_note text default '',
  p_idempotency_key text default null,
  p_request_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_today_local date := (pg_catalog.clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_decision text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_decision, '')));
  v_note text := pg_catalog.btrim(coalesce(p_decision_note, ''));
  v_idempotency_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_request_fingerprint, '')));
  v_existing_idem public.attendance_explanation_idempotency_records%rowtype;
  v_row public.attendance_explanations%rowtype;
  v_next_status text;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(
    p_actor_auth_subject,
    p_actor_app_user_id
  );

  if coalesce((v_auth ->> 'is_shared_non_employee')::boolean, false) then
    raise exception 'ATTENDANCE_EXPLANATION_DECIDE_DENIED'
      using errcode = '42501';
  end if;

  -- Replay already-completed decision for the same active non-shared actor before live
  -- approver gate (e.g. a revoked HEAD retrying their final frozen pending explanation).
  if pg_catalog.char_length(v_idempotency_key) >= 8
     and pg_catalog.char_length(v_idempotency_key) <= 128
     and v_fingerprint ~ '^[0-9a-f]{64}$' then
    select *
      into v_existing_idem
      from public.attendance_explanation_idempotency_records r
     where r.app_user_id = p_actor_app_user_id
       and r.operation = 'explanation_decide'
       and r.idempotency_key = v_idempotency_key;

    if found then
      if v_existing_idem.request_fingerprint <> v_fingerprint then
        raise exception 'IDEMPOTENCY_CONFLICT'
          using errcode = 'PT409';
      end if;
      return pg_catalog.jsonb_set(v_existing_idem.response_payload, '{replayed}', 'true'::jsonb, true);
    end if;
  end if;

  if not coalesce((v_auth ->> 'can_approve_requests')::boolean, false) then
    raise exception 'ATTENDANCE_EXPLANATION_DECIDE_DENIED'
      using errcode = '42501';
  end if;

  if pg_catalog.char_length(v_idempotency_key) < 8
     or pg_catalog.char_length(v_idempotency_key) > 128
     or v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('attendance_explanation_decide'),
    pg_catalog.hashtext(coalesce(p_explanation_id::text, ''))
  );

  select *
    into v_existing_idem
    from public.attendance_explanation_idempotency_records r
   where r.app_user_id = p_actor_app_user_id
     and r.operation = 'explanation_decide'
     and r.idempotency_key = v_idempotency_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;
    return pg_catalog.jsonb_set(v_existing_idem.response_payload, '{replayed}', 'true'::jsonb, true);
  end if;

  if p_explanation_id is null
     or v_decision not in ('APPROVE', 'REJECT')
     or p_expected_row_version is null
     or p_expected_row_version < 1 then
    raise exception 'ATTENDANCE_EXPLANATION_DECISION_INVALID'
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_note) > 500
     or v_note ~ '[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]' then
    raise exception 'ATTENDANCE_EXPLANATION_NOTE_INVALID'
      using errcode = '22023';
  end if;

  select *
    into v_row
    from public.attendance_explanations ae
   where ae.explanation_id = p_explanation_id
   for update;

  if not found then
    raise exception 'ATTENDANCE_EXPLANATION_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_row.app_user_id = p_actor_app_user_id then
    raise exception 'ATTENDANCE_EXPLANATION_SELF_APPROVAL_FORBIDDEN'
      using errcode = '42501';
  end if;

  if not public.attendance_explanation__internal_can_actor_decide(
    p_actor_app_user_id,
    v_row,
    v_today_local
  ) then
    raise exception 'ATTENDANCE_EXPLANATION_DECIDE_DENIED'
      using errcode = '42501';
  end if;

  if v_row.row_version <> p_expected_row_version then
    raise exception 'ATTENDANCE_EXPLANATION_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_row.status <> 'PENDING' then
    raise exception 'ATTENDANCE_EXPLANATION_ALREADY_DECIDED'
      using errcode = 'PT409';
  end if;

  v_next_status := case when v_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end;

  update public.attendance_explanations
     set status = v_next_status,
         decided_at = pg_catalog.clock_timestamp(),
         decided_by_app_user_id = p_actor_app_user_id,
         decision_note = v_note,
         row_version = v_row.row_version + 1,
         updated_at = pg_catalog.clock_timestamp()
   where explanation_id = p_explanation_id
  returning * into v_row;

  insert into public.attendance_explanation_audit_events (
    explanation_id,
    action,
    actor_app_user_id,
    before_status,
    after_status,
    note,
    payload
  )
  values (
    v_row.explanation_id,
    v_next_status,
    p_actor_app_user_id,
    'PENDING',
    v_next_status,
    v_note,
    pg_catalog.jsonb_build_object(
      'decision', v_decision,
      'business_date', v_row.business_date::text,
      'slot_code', v_row.slot_code
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'explanation', public.attendance_explanation__internal_project_item(v_row)
  );

  insert into public.attendance_explanation_idempotency_records (
    app_user_id,
    operation,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    p_actor_app_user_id,
    'explanation_decide',
    v_idempotency_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

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
  v_unit_kind_snapshot text;
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
  if coalesce((v_auth->>'is_shared_non_employee')::boolean, false) then
    raise exception 'LEAVE_SHARED_ACCOUNT_FORBIDDEN'
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
  else
    select d.department_id
      into v_lock_dept_id
      from public.leave_employee_profiles lp
      join public.organization_departments d
        on d.system_key = lp.unit_kind
       and d.is_active = true
     where lp.app_user_id = p_actor_app_user_id
       and lp.unit_kind in ('MARKETING', 'IT', 'ACCOUNTING')
     order by d.department_id asc
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
      not v_profile.is_shared_non_employee
      and v_profile.employment_status in ('PROBATION', 'OFFICIAL')
      and v_profile.work_start_date is not null
      and (
        v_profile.employment_status <> 'OFFICIAL'
        or v_profile.official_effective_date is not null
      )
    );
    v_emp_status_snapshot := v_profile.employment_status;
    v_unit_kind_snapshot := v_profile.unit_kind;
  else
    v_emp_status_snapshot := 'UNCONFIGURED';
    v_unit_kind_snapshot := 'UNCLASSIFIED';
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
    coalesce(v_routing->>'unit_kind', v_unit_kind_snapshot),
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

create or replace function public.attendance_submit_explanation(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_business_date date,
  p_slot_code text,
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
  v_today_local date := (pg_catalog.clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_slot_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_slot_code, '')));
  v_reason text := pg_catalog.btrim(coalesce(p_reason, ''));
  v_idempotency_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_request_fingerprint, '')));
  v_existing_idem public.attendance_explanation_idempotency_records%rowtype;
  v_day_evaluation jsonb;
  v_policy_profile_id_used uuid;
  v_policy_profile_code_used text;
  v_policy_profile_name_used text;
  v_policy_version_used integer;
  v_slot_eval jsonb;
  v_original_slot_status text;
  v_routing_snap record;
  v_routing jsonb;
  v_inserted public.attendance_explanations%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(
    p_actor_auth_subject,
    p_actor_app_user_id
  );

  if not (v_auth ->> 'can_submit_request')::boolean then
    raise exception 'ATTENDANCE_EXPLANATION_SUBMIT_DENIED'
      using errcode = '42501';
  end if;

  if pg_catalog.char_length(v_idempotency_key) < 8
     or pg_catalog.char_length(v_idempotency_key) > 128
     or v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('attendance_explanation_submit:' || p_actor_app_user_id::text),
    pg_catalog.hashtext(coalesce(p_business_date::text, '') || ':' || v_slot_code)
  );

  select *
    into v_existing_idem
    from public.attendance_explanation_idempotency_records r
   where r.app_user_id = p_actor_app_user_id
     and r.operation = 'explanation_submit'
     and r.idempotency_key = v_idempotency_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;
    return pg_catalog.jsonb_set(v_existing_idem.response_payload, '{replayed}', 'true'::jsonb, true);
  end if;

  if p_business_date is null
     or p_business_date < date '2000-01-01'
     or p_business_date > date '2100-12-31' then
    raise exception 'ATTENDANCE_EXPLANATION_DATE_INVALID'
      using errcode = '22023';
  end if;

  if p_business_date > v_today_local then
    raise exception 'ATTENDANCE_EXPLANATION_FUTURE_DATE_NOT_ALLOWED'
      using errcode = '22023';
  end if;

  if v_slot_code !~ '^SLOT_([1-9]|1[0-2])$' then
    raise exception 'ATTENDANCE_EXPLANATION_SLOT_INVALID'
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_reason) < 3
     or pg_catalog.char_length(v_reason) > 500
     or v_reason ~ '[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]' then
    raise exception 'ATTENDANCE_EXPLANATION_REASON_INVALID'
      using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.attendance_explanations ae
     where ae.app_user_id = p_actor_app_user_id
       and ae.business_date = p_business_date
       and ae.slot_code = v_slot_code
       and ae.status in ('PENDING', 'APPROVED')
  ) then
    raise exception 'ATTENDANCE_EXPLANATION_ALREADY_EXISTS'
      using errcode = 'PT409';
  end if;

  v_day_evaluation := public.attendance_explanation__internal_evaluate_employee_day_slots(
    p_actor_app_user_id,
    p_business_date
  );
  v_policy_profile_id_used := coalesce(
    (v_day_evaluation ->> 'policy_profile_id_used')::uuid,
    '00000000-0000-4000-8000-000000000001'::uuid
  );
  v_policy_profile_code_used := coalesce(v_day_evaluation ->> 'policy_profile_code_used', 'DEFAULT');
  v_policy_profile_name_used := coalesce(v_day_evaluation ->> 'policy_profile_name_used', 'Mặc định');
  v_policy_version_used := (v_day_evaluation ->> 'policy_version_used')::integer;

  select elem
    into v_slot_eval
    from pg_catalog.jsonb_array_elements(v_day_evaluation -> 'slots') as elem
   where elem ->> 'slot_code' = v_slot_code
   limit 1;

  if v_slot_eval is null then
    raise exception 'ATTENDANCE_EXPLANATION_SLOT_INVALID'
      using errcode = '22023';
  end if;

  v_original_slot_status := v_slot_eval ->> 'original_slot_status';
  if coalesce((v_slot_eval ->> 'eligible_for_explanation')::boolean, false) is not true
     or v_original_slot_status not in ('MISSING', 'OUT_OF_GRACE') then
    raise exception 'ATTENDANCE_EXPLANATION_SLOT_NOT_ELIGIBLE'
      using errcode = 'PT409';
  end if;

  -- Single atomic MVCC snapshot of route_kind, unit_kind, primary_approver, and routed_department
  select *
    into v_routing_snap
    from public.leave_management__internal_resolve_routing_snapshot(
      p_actor_app_user_id,
      v_today_local
    );
  v_routing := v_routing_snap.routing;

  insert into public.attendance_explanations (
    app_user_id,
    business_date,
    slot_code,
    slot_index,
    slot_label,
    session_code,
    target_time,
    grace_before_minutes,
    grace_after_minutes,
    policy_profile_id_used,
    policy_profile_code_used,
    policy_profile_name_used,
    policy_version_used,
    original_slot_status,
    related_checkins_snapshot,
    reason,
    status,
    unit_kind_snapshot,
    route_kind,
    primary_approver_app_user_id,
    routed_team_id,
    routed_team_code,
    routed_team_name,
    routed_department_id,
    routed_department_code,
    routed_department_name,
    fallback_reason,
    submitted_at,
    row_version,
    updated_at
  )
  values (
    p_actor_app_user_id,
    p_business_date,
    v_slot_code,
    (v_slot_eval ->> 'slot_index')::integer,
    v_slot_eval ->> 'slot_label',
    v_slot_eval ->> 'session_code',
    v_slot_eval ->> 'target_time',
    (v_slot_eval ->> 'grace_before_minutes')::integer,
    (v_slot_eval ->> 'grace_after_minutes')::integer,
    v_policy_profile_id_used,
    v_policy_profile_code_used,
    v_policy_profile_name_used,
    v_policy_version_used,
    v_original_slot_status,
    coalesce(v_slot_eval -> 'checkins', '[]'::jsonb),
    v_reason,
    'PENDING',
    v_routing ->> 'unit_kind',
    v_routing ->> 'route_kind',
    case
      when (v_routing ->> 'primary_approver_app_user_id') is not null then
        (v_routing ->> 'primary_approver_app_user_id')::uuid
      else null
    end,
    case
      when (v_routing ->> 'team_id') is not null then
        (v_routing ->> 'team_id')::uuid
      else null
    end,
    v_routing ->> 'team_code',
    v_routing ->> 'team_name',
    v_routing_snap.routed_department_id,
    v_routing_snap.routed_department_code,
    v_routing_snap.routed_department_name,
    v_routing ->> 'fallback_reason',
    pg_catalog.clock_timestamp(),
    1,
    pg_catalog.clock_timestamp()
  )
  returning * into v_inserted;

  insert into public.attendance_explanation_audit_events (
    explanation_id,
    action,
    actor_app_user_id,
    before_status,
    after_status,
    note,
    payload
  )
  values (
    v_inserted.explanation_id,
    'SUBMITTED',
    p_actor_app_user_id,
    null,
    'PENDING',
    v_reason,
    pg_catalog.jsonb_build_object(
      'business_date', p_business_date::text,
      'slot_code', v_slot_code,
      'policy_profile_id_used', v_policy_profile_id_used,
      'policy_profile_code_used', v_policy_profile_code_used,
      'policy_profile_name_used', v_policy_profile_name_used,
      'policy_version_used', v_policy_version_used,
      'original_slot_status', v_original_slot_status,
      'route_kind', v_inserted.route_kind,
      'primary_approver_app_user_id', v_inserted.primary_approver_app_user_id
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'explanation', public.attendance_explanation__internal_project_item(v_inserted)
  );

  insert into public.attendance_explanation_idempotency_records (
    app_user_id,
    operation,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    p_actor_app_user_id,
    'explanation_submit',
    v_idempotency_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

-- -----------------------------------------------------------------------------
-- 5. Strict Routine ACLs, Guarded Owner Alignment & Fail-Closed Self-Check
-- -----------------------------------------------------------------------------
revoke all on function
  public.leave_management__internal_resolve_person_department(uuid, timestamptz),
  public.leave_management__internal_has_open_department_head(uuid, timestamptz),
  public.leave_management__internal_resolve_department_head_user(uuid, timestamptz),
  public.leave_management__internal_account_summary(uuid),
  public.leave_management__internal_resolve_authority(uuid, uuid),
  public.leave_management__internal_resolve_routing_snapshot(uuid, date),
  public.leave_management__internal_resolve_routing(uuid, date),
  public.leave_management__internal_can_actor_decide_request(uuid, public.leave_requests, date),
  public.attendance_explanation__internal_can_actor_decide(uuid, public.attendance_explanations, date),
  public.leave_management__internal_compute_balance_summary(uuid, integer, date),
  public.leave_management_create_request(uuid, uuid, jsonb, text, text, text),
  public.leave_management_list_approval_inbox(uuid, uuid, text, integer, integer),
  public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer, text),
  public.leave_management_monthly_report(uuid, uuid, text, text, text, integer, integer),
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text),
  public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb),
  public.attendance_submit_explanation(uuid, uuid, date, text, text, text, text),
  public.attendance_decide_explanation(uuid, uuid, uuid, text, integer, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.leave_management_create_request(uuid, uuid, jsonb, text, text, text),
  public.leave_management_list_approval_inbox(uuid, uuid, text, integer, integer),
  public.leave_management_get_admin_overview(uuid, uuid, text, integer, integer, text),
  public.leave_management_monthly_report(uuid, uuid, text, text, text, integer, integer),
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text),
  public.leave_management_preview_opening_batch(uuid, uuid, integer, jsonb),
  public.attendance_submit_explanation(uuid, uuid, date, text, text, text, text),
  public.attendance_decide_explanation(uuid, uuid, uuid, text, integer, text, text, text)
to service_role;

do $align_wp7a$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_can_set_owner boolean := false;
  v_fn regprocedure;
  v_proc_owner_oid oid;
  v_all_fns regprocedure[] := array[
    'public.leave_management__internal_resolve_person_department(uuid,timestamptz)'::pg_catalog.regprocedure,
    'public.leave_management__internal_has_open_department_head(uuid,timestamptz)'::pg_catalog.regprocedure,
    'public.leave_management__internal_resolve_department_head_user(uuid,timestamptz)'::pg_catalog.regprocedure,
    'public.leave_management__internal_account_summary(uuid)'::pg_catalog.regprocedure,
    'public.leave_management__internal_resolve_authority(uuid,uuid)'::pg_catalog.regprocedure,
    'public.leave_management__internal_resolve_routing_snapshot(uuid,date)'::pg_catalog.regprocedure,
    'public.leave_management__internal_resolve_routing(uuid,date)'::pg_catalog.regprocedure,
    'public.leave_management__internal_can_actor_decide_request(uuid,public.leave_requests,date)'::pg_catalog.regprocedure,
    'public.attendance_explanation__internal_can_actor_decide(uuid,public.attendance_explanations,date)'::pg_catalog.regprocedure,
    'public.leave_management__internal_compute_balance_summary(uuid,integer,date)'::pg_catalog.regprocedure,
    'public.leave_management_create_request(uuid,uuid,jsonb,text,text,text)'::pg_catalog.regprocedure,
    'public.leave_management_list_approval_inbox(uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure,
    'public.leave_management_get_admin_overview(uuid,uuid,text,integer,integer,text)'::pg_catalog.regprocedure,
    'public.leave_management_monthly_report(uuid,uuid,text,text,text,integer,integer)'::pg_catalog.regprocedure,
    'public.leave_management_set_department_approver_admin(uuid,uuid,text,uuid,date,integer,text,text,text)'::pg_catalog.regprocedure,
    'public.leave_management_preview_opening_batch(uuid,uuid,integer,jsonb)'::pg_catalog.regprocedure,
    'public.attendance_submit_explanation(uuid,uuid,date,text,text,text,text)'::pg_catalog.regprocedure,
    'public.attendance_decide_explanation(uuid,uuid,uuid,text,integer,text,text,text)'::pg_catalog.regprocedure
  ];
begin
  select c.relowner, pg_catalog.pg_get_userbyid(c.relowner)
    into v_base_owner_oid, v_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'direct_entry_app_users';

  if v_base_owner_oid is null then
    raise exception 'WP7A owner alignment failed: public.direct_entry_app_users not found'
      using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_fn in array v_all_fns loop
    select p.proowner into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = v_fn::oid;
    if v_can_set_owner and v_proc_owner_oid is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;
end;
$align_wp7a$;

do $check_wp7a$
declare
  v_internal_fns regprocedure[] := array[
    'public.leave_management__internal_resolve_person_department(uuid,timestamptz)'::pg_catalog.regprocedure,
    'public.leave_management__internal_has_open_department_head(uuid,timestamptz)'::pg_catalog.regprocedure,
    'public.leave_management__internal_resolve_department_head_user(uuid,timestamptz)'::pg_catalog.regprocedure,
    'public.leave_management__internal_account_summary(uuid)'::pg_catalog.regprocedure,
    'public.leave_management__internal_resolve_authority(uuid,uuid)'::pg_catalog.regprocedure,
    'public.leave_management__internal_resolve_routing_snapshot(uuid,date)'::pg_catalog.regprocedure,
    'public.leave_management__internal_resolve_routing(uuid,date)'::pg_catalog.regprocedure,
    'public.leave_management__internal_can_actor_decide_request(uuid,public.leave_requests,date)'::pg_catalog.regprocedure,
    'public.attendance_explanation__internal_can_actor_decide(uuid,public.attendance_explanations,date)'::pg_catalog.regprocedure,
    'public.leave_management__internal_compute_balance_summary(uuid,integer,date)'::pg_catalog.regprocedure
  ];
  v_public_fns regprocedure[] := array[
    'public.leave_management_create_request(uuid,uuid,jsonb,text,text,text)'::pg_catalog.regprocedure,
    'public.leave_management_list_approval_inbox(uuid,uuid,text,integer,integer)'::pg_catalog.regprocedure,
    'public.leave_management_get_admin_overview(uuid,uuid,text,integer,integer,text)'::pg_catalog.regprocedure,
    'public.leave_management_monthly_report(uuid,uuid,text,text,text,integer,integer)'::pg_catalog.regprocedure,
    'public.leave_management_set_department_approver_admin(uuid,uuid,text,uuid,date,integer,text,text,text)'::pg_catalog.regprocedure,
    'public.leave_management_preview_opening_batch(uuid,uuid,integer,jsonb)'::pg_catalog.regprocedure,
    'public.attendance_submit_explanation(uuid,uuid,date,text,text,text,text)'::pg_catalog.regprocedure,
    'public.attendance_decide_explanation(uuid,uuid,uuid,text,integer,text,text,text)'::pg_catalog.regprocedure
  ];
  v_fn regprocedure;
  v_proc record;
begin
  foreach v_fn in array v_internal_fns loop
    select p.prosecdef,
           p.proconfig,
           p.proacl,
           r.rolsuper,
           r.rolbypassrls
      into v_proc
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_fn::oid;

    if not found
       or not v_proc.prosecdef
       or not (v_proc.rolsuper or v_proc.rolbypassrls)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proc.proconfig, array[]::text[]))) then
      raise exception 'WP7A self-check failed on internal routine hardening: %', v_fn
        using errcode = '55000';
    end if;

    if exists (
      select 1
        from pg_catalog.aclexplode(coalesce(v_proc.proacl, array[]::aclitem[])) a
       where a.grantee = 0
          or a.grantee in (
            select oid from pg_catalog.pg_roles where rolname in ('anon', 'authenticated', 'service_role')
          )
    ) then
      raise exception 'WP7A self-check failed: internal routine % has unauthorized EXECUTE grant', v_fn
        using errcode = '55000';
    end if;
  end loop;

  foreach v_fn in array v_public_fns loop
    select p.prosecdef,
           p.proconfig,
           p.proacl,
           r.rolsuper,
           r.rolbypassrls
      into v_proc
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_fn::oid;

    if not found
       or not v_proc.prosecdef
       or not (v_proc.rolsuper or v_proc.rolbypassrls)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proc.proconfig, array[]::text[]))) then
      raise exception 'WP7A self-check failed on public RPC hardening: %', v_fn
        using errcode = '55000';
    end if;

    if exists (
      select 1
        from pg_catalog.aclexplode(coalesce(v_proc.proacl, array[]::aclitem[])) a
       where a.grantee = 0
          or a.grantee in (
            select oid from pg_catalog.pg_roles where rolname in ('anon', 'authenticated')
          )
    ) then
      raise exception 'WP7A self-check failed: public RPC % has client/PUBLIC EXECUTE grant', v_fn
        using errcode = '55000';
    end if;

    if not exists (
      select 1
        from pg_catalog.aclexplode(coalesce(v_proc.proacl, array[]::aclitem[])) a
       where a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'service_role')
         and a.privilege_type = 'EXECUTE'
    ) then
      raise exception 'WP7A self-check failed: public RPC % missing service_role EXECUTE', v_fn
        using errcode = '55000';
    end if;
  end loop;

  if not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'leave_requests'
       and column_name = 'routed_department_id'
  ) or not exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'attendance_explanations'
       and column_name = 'routed_department_id'
  ) then
    raise exception 'WP7A self-check failed: routed_department_id snapshot columns missing'
      using errcode = '55000';
  end if;
end;
$check_wp7a$;

commit;
