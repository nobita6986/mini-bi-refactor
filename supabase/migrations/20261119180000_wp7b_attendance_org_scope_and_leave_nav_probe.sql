-- =============================================================================
-- WP7B: Attendance Organization Scope, Per-Day Historical Filtering, Special
--       Account Protection (History Preserved), and Read-Only Leave Nav Probe
-- =============================================================================
-- Forward-only migration implementing T0 locked decisions D-WP7B-01..03 and R7:
--   1. D-WP7B-01: DEPARTMENT_HEAD reads department-scoped Attendance reports,
--      monthly matrix, XLSX export, and check-in photos (no ALL, no HQ/branch/
--      slot-policy config); closes unpaired ALL Cartesian escalation in
--      attendance__internal_assert_report_reader via WP5 paired capabilities.
--   2. D-WP7B-02 (Option A): Strict server-side per-day as-of membership
--      filtering across check-in report, monthly matrix, totals, dropdowns,
--      pagination, snapshot_token, and photo access. Out-of-scope days use
--      strict-parser-compatible UPCOMING shape (zero sensitive data, zero
--      MISSING/0-work, zero total contribution, 100% old-Web compatible).
--   3. D-WP7B-03: Block new check-ins & fake MISSING/obligations/new branch or
--      slot-policy assignments for verified SHARED/SERVICE and unconflicted
--      legacy is_shared_non_employee; keep unlinked NORMAL accounts and keep
--      real historical check-in records queryable & exportable; never auto-
--      exclude when a verified active Person contradicts is_shared_non_employee.
--   4. R7: Add pure read-only STABLE RPC leave_management_get_actor_access
--      (allowlisted for service_role) so AppShell nav & /leave/admin SSR never
--      trigger leave accrual writes while real Leave endpoints keep sync intact.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. R7: Read-only Leave nav access probe (zero accrual writes, zero locks)
-- -----------------------------------------------------------------------------
create or replace function public.leave_management_get_actor_access(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_is_shared boolean := false;
begin
  v_auth := public.leave_management__internal_resolve_authority(
    p_actor_auth_subject,
    p_actor_app_user_id
  );
  v_is_shared := coalesce((v_auth->>'is_shared_non_employee')::boolean, false);

  return pg_catalog.jsonb_build_object(
    'can_access', (not v_is_shared),
    'is_shared_non_employee', v_is_shared,
    'can_submit_request', coalesce((v_auth->>'can_submit_request')::boolean, false),
    'can_approve_requests', coalesce((v_auth->>'can_approve_requests')::boolean, false),
    'can_manage_config', coalesce((v_auth->>'can_manage_config')::boolean, false),
    'can_view_monthly_report', coalesce((v_auth->>'can_view_monthly_report')::boolean, false)
  );
end;
$function$;

revoke all on function public.leave_management_get_actor_access(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.leave_management_get_actor_access(uuid, uuid)
  to service_role;

comment on function public.leave_management_get_actor_access(uuid, uuid) is
  'WP7B R7 read-only STABLE Leave access probe for AppShell navigation and /leave/admin SSR. Performs zero DB writes and zero accrual sync; real Leave business RPCs retain accrual sync.';

-- -----------------------------------------------------------------------------
-- 2. WP7B Internal Helpers (all REVOKED from PUBLIC/anon/authenticated/service_role)
-- -----------------------------------------------------------------------------

-- 2a. Non-employee / special account classification helper (D-WP7B-03 + R5):
--   - TRUE  for verified account_type in ('SHARED', 'SERVICE').
--   - TRUE  for account_type = 'NORMAL' with legacy leave_employee_profiles.is_shared_non_employee = true
--           ONLY when NOT contradicted by a verified active organization_persons link.
--   - FALSE for all NORMAL accounts (linked or unlinked) without is_shared_non_employee,
--           AND FALSE when active verified Person contradicts legacy is_shared_non_employee
--           (conflict is surfaced to T0 via preflight, never auto-excluded).
create or replace function public.attendance__internal_is_non_employee_account(
  p_app_user_id uuid,
  p_as_of timestamptz default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_account_type text;
  v_legacy_shared boolean := false;
  v_has_active_person boolean := false;
begin
  if p_app_user_id is null then
    return false;
  end if;

  select coalesce(u.account_type, 'NORMAL')
    into v_account_type
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found then
    return false;
  end if;

  if v_account_type in ('SHARED', 'SERVICE') then
    return true;
  end if;

  select coalesce(lp.is_shared_non_employee, false)
    into v_legacy_shared
    from public.leave_employee_profiles lp
   where lp.app_user_id = p_app_user_id;

  if not coalesce(v_legacy_shared, false) then
    return false;
  end if;

  -- Do NOT auto-apply legacy is_shared_non_employee when contradicted by an active verified Person.
  select exists (
    select 1
      from public.organization_account_person_links l
      join public.organization_persons op
        on op.person_id = l.person_id
       and op.status = 'ACTIVE'
     where l.app_user_id = p_app_user_id
       and l.started_at <= v_as_of
       and (l.ended_at is null or (l.ended_at > l.started_at and v_as_of < l.ended_at))
  ) into v_has_active_person;

  return not coalesce(v_has_active_person, false);
end;
$function$;

revoke all on function public.attendance__internal_is_non_employee_account(uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- 2b. Canonical as-of instant for a VN business date:
--   - Past dates (d < today_vn): end of VN business day d (23:59:59.999999+07),
--     so the last effective assignment on day d owns day d (matching DATE-based
--     recruiter_team_memberships semantics and avoiding same-day double counting).
--   - Today & future dates (d >= today_vn): v_now (immediate effective state).
create or replace function public.attendance__internal_day_as_of(
  p_business_date date,
  p_today_vn date,
  p_now timestamptz
)
returns timestamptz
language sql
immutable
security definer
set search_path = pg_catalog, public
as $function$
  select case
    when p_business_date < p_today_vn then
      (((p_business_date + 1)::timestamp without time zone) at time zone 'Asia/Ho_Chi_Minh')
        - interval '1 microsecond'
    else p_now
  end;
$function$;

revoke all on function public.attendance__internal_day_as_of(date, date, timestamptz)
  from public, anon, authenticated, service_role;

-- 2c. Per-day historical membership scope check (D-WP7B-02 Option A):
--   - Never infers past membership before verified valid_from / started_at.
--   - Half-open intervals exclude zero-length cancelled rows (valid_to = valid_from, ended_at = started_at).
create or replace function public.attendance__internal_is_employee_in_scope_on_date(
  p_scope_kind text,
  p_scope_team_ids uuid[],
  p_scope_department_ids uuid[],
  p_target_app_user_id uuid,
  p_business_date date,
  p_today_vn date,
  p_now timestamptz
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_day_as_of timestamptz;
begin
  if p_scope_kind = 'all' then
    return true;
  end if;

  if p_target_app_user_id is null or p_business_date is null then
    return false;
  end if;

  -- Team scope (recruiter_team_memberships + verified recruiter link on business_date)
  if coalesce(pg_catalog.cardinality(p_scope_team_ids), 0) > 0 then
    if exists (
      select 1
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiter_team_memberships m
          on m.recruiter_id = l.recruiter_id
       where l.app_user_id = p_target_app_user_id
         and l.verified = true
         and l.valid_from <= p_business_date
         and (
           l.valid_to is null
           or (l.valid_to > l.valid_from and p_business_date < l.valid_to)
         )
         and m.team_id = any(p_scope_team_ids)
         and m.valid_from <= p_business_date
         and (
           m.valid_to is null
           or (m.valid_to > m.valid_from and p_business_date < m.valid_to)
         )
    ) then
      return true;
    end if;
  end if;

  -- Department scope (organization_account_person_links + organization_person_department_memberships as-of day)
  if coalesce(pg_catalog.cardinality(p_scope_department_ids), 0) > 0 then
    v_day_as_of := public.attendance__internal_day_as_of(p_business_date, p_today_vn, p_now);
    if exists (
      select 1
        from public.organization_account_person_links l
        join public.organization_person_department_memberships m
          on m.person_id = l.person_id
       where l.app_user_id = p_target_app_user_id
         and l.started_at <= v_day_as_of
         and (
           l.ended_at is null
           or (l.ended_at > l.started_at and v_day_as_of < l.ended_at)
         )
         and m.department_id = any(p_scope_department_ids)
         and m.started_at <= v_day_as_of
         and (
           m.ended_at is null
           or (m.ended_at > m.started_at and v_day_as_of < m.ended_at)
         )
    ) then
      return true;
    end if;
  end if;

  return false;
end;
$function$;

revoke all on function public.attendance__internal_is_employee_in_scope_on_date(
  text, uuid[], uuid[], uuid, date, date, timestamptz
) from public, anon, authenticated, service_role;

-- 2d. Range scope check (exact union over business dates in [p_from_date, p_to_date])
create or replace function public.attendance__internal_has_any_scope_day_in_range(
  p_scope_kind text,
  p_scope_team_ids uuid[],
  p_scope_department_ids uuid[],
  p_target_app_user_id uuid,
  p_from_date date,
  p_to_date date,
  p_today_vn date,
  p_now timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select case
    when p_scope_kind = 'all' then true
    when p_target_app_user_id is null or p_from_date is null or p_to_date is null or p_from_date > p_to_date then false
    else exists (
      select 1
        from pg_catalog.generate_series(
          p_from_date::timestamp without time zone,
          p_to_date::timestamp without time zone,
          interval '1 day'
        ) as gs(d)
       where public.attendance__internal_is_employee_in_scope_on_date(
         p_scope_kind,
         p_scope_team_ids,
         p_scope_department_ids,
         p_target_app_user_id,
         gs.d::date,
         p_today_vn,
         p_now
       )
    )
  end;
$function$;

revoke all on function public.attendance__internal_has_any_scope_day_in_range(
  text, uuid[], uuid[], uuid, date, date, date, timestamptz
) from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Harden attendance__internal_assert_report_reader with WP5 Paired ALL scope
--    (Closes HR_OPERATOR at ALL + TEAM_LEADER at TEAM Cartesian escalation)
-- -----------------------------------------------------------------------------
create or replace function public.attendance__internal_assert_report_reader(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_is_full_admin boolean;
  v_is_bod boolean;
begin
  if p_auth_subject is null
     or p_app_user_id is null
     or not exists (
       select 1
         from public.direct_entry_app_users u
        where u.app_user_id = p_app_user_id
          and u.auth_subject = p_auth_subject
          and u.enabled = true
     ) then
    raise exception 'ATTENDANCE_ACTOR_DENIED' using errcode = '42501';
  end if;

  v_is_full_admin :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);

  v_is_bod :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
    or (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_analytics_view', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_view', 'ALL', null)
    );

  if not v_is_full_admin and not v_is_bod then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  return v_is_full_admin;
end;
$function$;

revoke all on function public.attendance__internal_assert_report_reader(uuid, uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Multi-Scope Attendance Report Resolver (ALL | TEAM | DEPARTMENT | BOTH)
-- -----------------------------------------------------------------------------
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
    if v_authz_managed then
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
    else
      v_tl_caps_ok :=
        public.direct_entry_has_capability(p_app_user_id, 'team_manager_assign')
        and public.direct_entry_has_capability(p_app_user_id, 'report_view')
        and public.direct_entry_has_capability(p_app_user_id, 'report_analytics_view');
    end if;

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

revoke all on function public.attendance__internal_resolve_report_scope_v2(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Keep legacy 3-column internal helper signature compatible
create or replace function public.attendance__internal_resolve_report_scope(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns table (
  scope_kind text,
  team_id uuid,
  can_configure_hq boolean
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope record;
begin
  select s.scope_kind, s.team_ids, s.can_configure_hq
    into v_scope
    from public.attendance__internal_resolve_report_scope_v2(
      p_auth_subject,
      p_app_user_id
    ) s;

  return query select
    v_scope.scope_kind,
    case
      when v_scope.team_ids is not null and pg_catalog.cardinality(v_scope.team_ids) > 0
      then v_scope.team_ids[1]
      else null::uuid
    end,
    v_scope.can_configure_hq;
end;
$function$;

revoke all on function public.attendance__internal_resolve_report_scope(uuid, uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Align Employee Identity Resolution with WP3 organization_persons
--    (Zero literal at-sign characters: uses chr(64))
-- -----------------------------------------------------------------------------
create or replace function public.attendance__internal_resolve_employee_identity(
  p_app_user_id uuid
)
returns table (
  employee_display_name text,
  personnel_code text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_auth_subject uuid;
  v_user_display_name text;
  v_login_id text;
  v_person_full_name text;
  v_person_employee_code text;
  v_linked_display_name text;
  v_linked_personnel_code text;
  v_matched_display_name text;
  v_matched_personnel_code text;
  v_lookup_code text;
  v_resolved_code text;
  v_candidate_name text;
begin
  select
    u.auth_subject,
    nullif(pg_catalog.btrim(u.display_name), '')
    into v_auth_subject, v_user_display_name
  from public.direct_entry_app_users u
  where u.app_user_id = p_app_user_id;

  if not found then
    return query select 'Chưa cập nhật họ tên'::text, null::text;
    return;
  end if;

  -- Priority 1: Canonical WP3 active linked organization_persons identity
  select
    nullif(pg_catalog.btrim(op.full_name), ''),
    nullif(pg_catalog.btrim(op.employee_code), '')
    into v_person_full_name, v_person_employee_code
  from public.organization_account_person_links apl
  join public.organization_persons op
    on op.person_id = apl.person_id
  where apl.app_user_id = p_app_user_id
    and apl.ended_at is null
    and apl.started_at <= v_now
  order by apl.started_at desc, apl.link_id desc
  limit 1;

  if v_person_full_name is not null then
    return query select v_person_full_name, v_person_employee_code;
    return;
  end if;

  select pg_catalog.lower(
           nullif(
             pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1),
             ''
           )
         )
    into v_login_id
  from auth.users au
  where au.id = v_auth_subject;

  select
    case when count(*) = 1 then max(nullif(pg_catalog.btrim(r.display_name), '')) else null end,
    case when count(*) = 1 then max(nullif(pg_catalog.btrim(r.personnel_code), '')) else null end
    into v_linked_display_name, v_linked_personnel_code
  from public.direct_entry_app_user_recruiter_links l
  join public.recruiters r
    on r.recruiter_id = l.recruiter_id
   and r.active = true
  where l.app_user_id = p_app_user_id
    and l.verified = true
    and l.is_current = true;

  if v_linked_personnel_code is null and v_linked_display_name is null then
    v_lookup_code := coalesce(
      v_login_id,
      case
        when public.attendance__internal_is_login_or_code_like(v_user_display_name, null, null) then
          pg_catalog.lower(v_user_display_name)
        else null
      end
    );

    if v_lookup_code is not null then
      select
        case when count(*) = 1 then max(nullif(pg_catalog.btrim(r.display_name), '')) else null end,
        case when count(*) = 1 then max(nullif(pg_catalog.btrim(r.personnel_code), '')) else null end
        into v_matched_display_name, v_matched_personnel_code
      from public.recruiters r
      where r.active = true
        and r.personnel_code is not null
        and pg_catalog.lower(pg_catalog.btrim(r.personnel_code)) = v_lookup_code;
    end if;
  end if;

  v_resolved_code := coalesce(v_person_employee_code, v_linked_personnel_code, v_matched_personnel_code);

  if v_linked_display_name is not null
     and not public.attendance__internal_is_login_or_code_like(
       v_linked_display_name,
       v_resolved_code,
       v_login_id
     ) then
    v_candidate_name := v_linked_display_name;
  elsif v_matched_display_name is not null
     and not public.attendance__internal_is_login_or_code_like(
       v_matched_display_name,
       v_resolved_code,
       v_login_id
     ) then
    v_candidate_name := v_matched_display_name;
  elsif v_user_display_name is not null
     and not public.attendance__internal_is_login_or_code_like(
       v_user_display_name,
       v_resolved_code,
       v_login_id
     ) then
    v_candidate_name := v_user_display_name;
  else
    v_candidate_name := null;
  end if;

  if v_candidate_name is null then
    return query select
      'Chưa cập nhật họ tên'::text,
      coalesce(v_resolved_code, v_login_id, v_user_display_name);
  else
    return query select
      v_candidate_name,
      v_resolved_code;
  end if;
end;
$function$;

revoke all on function public.attendance__internal_resolve_employee_identity(uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. Align direct_entry_resolve_actor_context DEPARTMENT_HEAD assigned_roles
--    with WP7A/WP7B canonical checks (exact 12/13-key JSON contract unchanged)
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_resolve_actor_context(p_auth_subject uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_app_user_id uuid;
  v_enabled boolean;
  v_review_scopes jsonb;
  v_team_leader_team_id uuid := null;
  v_allowed_worker_tabs jsonb := '[]'::jsonb;
  v_effective_grants jsonb := '[]'::jsonb;
  v_assigned_roles jsonb := '[]'::jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_has_active_person boolean := false;
  v_is_non_employee boolean := false;
begin
  select u.app_user_id, u.enabled
    into v_app_user_id, v_enabled
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject;
  if not found then return null; end if;

  select case when not u.enabled then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
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
           where public.direct_entry_has_capability(u.app_user_id, 'report_review')
             and public.direct_entry_has_scope(u.app_user_id, 'all')
          union all
          select 'team'::text as kind, t.team_id, coalesce(t.display_name, t.code) as label
            from public.direct_entry_scope_grants g
            join public.teams t on t.team_id = g.team_id and t.active
           where public.direct_entry_has_capability(u.app_user_id, 'report_review')
             and g.app_user_id = u.app_user_id
             and g.scope_kind = 'team'
             and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
          union all
          select d.scope_kind as kind,
                 case when d.scope_kind = 'team' then d.scope_team_id else null end as team_id,
                 case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end as label
            from public.work_report_delegations d
            left join public.teams tm on tm.team_id = d.scope_team_id
           where d.delegate_app_user_id = u.app_user_id
             and d.capability = 'report_review'
             and d.state = 'ACTIVE'
             and d.is_current
             and statement_timestamp() >= d.effective_from
             and (d.effective_to is null or statement_timestamp() <= d.effective_to)
             and public.work_report__internal_is_delegation_effective(d.delegation_id, statement_timestamp())
        ) raw_scopes
      ) s
  ), '[]'::jsonb) end
    into v_review_scopes
    from public.direct_entry_app_users u
   where u.app_user_id = v_app_user_id;

  if v_enabled and public.direct_entry_has_capability(v_app_user_id, 'team_manager_assign') then
    begin
      v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
        p_auth_subject, v_app_user_id, null
      );
    exception when insufficient_privilege then
      v_team_leader_team_id := null;
    end;
  end if;

  if v_enabled then
    select coalesce(
      jsonb_agg(t.tab_id order by t.ord),
      '[]'::jsonb
    )
    into v_allowed_worker_tabs
    from (
      select 'uploader'::text as tab_id, 1 as ord
       where (
         (
           select count(*)::integer
             from public.direct_entry_scope_grants g
            where g.app_user_id = v_app_user_id
              and g.scope_kind = 'own'
              and g.team_id is null
              and g.is_current
         ) = 1
         and public.direct_entry_has_capability(v_app_user_id, 'submission_create')
       )
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
          where l.app_user_id = v_app_user_id
            and l.verified
            and l.is_current
       )
      union all
      select 'managed'::text as tab_id, 3 as ord
       where public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'team'::text as tab_id, 4 as ord
       where v_team_leader_team_id is not null
      union all
      select 'all'::text as tab_id, 5 as ord
       where public.direct_entry_has_scope(v_app_user_id, 'all')
         and (
           public.direct_entry_has_capability(v_app_user_id, 'entry_admin')
           or public.direct_entry_has_capability(v_app_user_id, 'change_review')
         )
    ) t;

    v_effective_grants := public.direct_entry_authz__internal_resolve_effective_grants(v_app_user_id);
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
          rd.sort_order,
          ara.role_code,
          rd.display_name,
          'GLOBAL'::text as assignment_mode,
          null::text as scope_kind,
          null::text as scope_id,
          ara.assignment_id::text as assignment_id,
          ara.is_protected,
          (not ara.is_protected) as can_revoke,
          case when ara.is_protected then 'PROTECTED_OWNER_ADMIN' else null end as cannot_revoke_reason
        from public.authz_account_role_assignments ara
        join public.authz_role_definitions rd on rd.role_code = ara.role_code
        where ara.app_user_id = v_app_user_id
          and ara.ended_at is null
          and ara.started_at <= v_now
          and (not rd.requires_active_person or coalesce(v_has_active_person, false))
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
      ) ar;
  end if;

  return (
    select jsonb_build_object(
      'auth_subject', u.auth_subject,
      'app_user_id', u.app_user_id,
      'display_name', u.display_name,
      'enabled', u.enabled,
      'capabilities', coalesce((
        select jsonb_agg(distinct g.capability order by g.capability)
          from public.direct_entry_capability_grants g
         where g.app_user_id = u.app_user_id
           and public.direct_entry__internal_capability_grant_effective(g.grant_id)
      ), '[]'::jsonb),
      'recruiter_links', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', l.app_user_id, 'recruiter_id', l.recruiter_id, 'verified', l.verified,
          'valid_from', l.valid_from, 'valid_to', l.valid_to
        ) order by l.valid_from, l.recruiter_id)
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
         where l.app_user_id = u.app_user_id and l.verified and l.is_current and u.enabled
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object('team_id', t.team_id, 'code', t.code,
          'display', t.display_name, 'active', t.active) order by t.team_id)
          from public.teams t
         where t.active and exists (
           select 1 from public.direct_entry_scope_grants g
            where g.app_user_id = u.app_user_id and g.scope_kind = 'team'
              and g.team_id = t.team_id
              and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
         )
      ), '[]'::jsonb),
      'team_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('team_id', g.team_id,
          'valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from, g.team_id)
          from public.direct_entry_scope_grants g
          join public.teams t on t.team_id = g.team_id and t.active
         where g.app_user_id = u.app_user_id
           and g.scope_kind = 'team'
           and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
      ), '[]'::jsonb),
      'all_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from)
          from public.direct_entry_scope_grants g
         where g.app_user_id = u.app_user_id and g.scope_kind = 'all' and g.is_current and u.enabled
      ), '[]'::jsonb),
      'allowed_worker_tabs', v_allowed_worker_tabs,
      'effective_grants', coalesce(v_effective_grants, '[]'::jsonb),
      'assigned_roles', coalesce(v_assigned_roles, '[]'::jsonb)
    ) || case
      when jsonb_array_length(v_review_scopes) > 0 then jsonb_build_object('effective_report_review_scopes', v_review_scopes)
      else '{}'::jsonb
    end
    from public.direct_entry_app_users u where u.app_user_id = v_app_user_id
  );
end;
$function$;

revoke all on function public.direct_entry_resolve_actor_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_resolve_actor_context(uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 7. D-WP7B-03: Block New Check-ins for Verified SHARED / SERVICE & Legacy
--    Unconflicted is_shared_non_employee (Keep Unlinked NORMAL & Replay Safe)
-- -----------------------------------------------------------------------------
create or replace function public.attendance_lookup_checkin_idempotency(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_existing public.attendance_checkins%rowtype;
  v_daily_count integer;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'ACTOR_NOT_AVAILABLE' using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled = true
  ) then
    raise exception 'ACTOR_NOT_AVAILABLE' using errcode = '42501';
  end if;

  if public.attendance__internal_is_non_employee_account(p_app_user_id, pg_catalog.clock_timestamp()) then
    raise exception 'ATTENDANCE_SHARED_ACCOUNT_FORBIDDEN' using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_INVALID' using errcode = '22023';
  end if;

  if p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_REQUEST_INVALID' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('attendance_checkin_v1'),
    pg_catalog.hashtext(p_app_user_id::text)
  );

  select *
    into v_existing
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.idempotency_key = p_idempotency_key;

  if not found then
    return pg_catalog.jsonb_build_object('found', false);
  end if;

  if v_existing.request_fingerprint <> p_request_fingerprint then
    raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
  end if;

  select count(*)::integer
    into v_daily_count
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.business_date = v_existing.business_date;

  return pg_catalog.jsonb_build_object(
    'found', true,
    'photo_storage_key', v_existing.photo_storage_key,
    'checkin', pg_catalog.jsonb_build_object(
      'checkin_id', v_existing.checkin_id,
      'business_date', v_existing.business_date::text,
      'sequence_in_day', v_existing.sequence_in_day,
      'daily_count', v_daily_count,
      'captured_at', pg_catalog.to_char(v_existing.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'received_at', pg_catalog.to_char(v_existing.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'time_source', v_existing.time_source,
      'replayed', true
    )
  );
end;
$function$;

revoke all on function public.attendance_lookup_checkin_idempotency(uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_lookup_checkin_idempotency(uuid, uuid, uuid, text)
  to service_role;

create or replace function public.attendance_record_checkin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_meters double precision,
  p_address_hint text,
  p_note text,
  p_device_claimed_at timestamp with time zone,
  p_time_source text,
  p_time_anchor_issued_at timestamp with time zone,
  p_elapsed_since_anchor_ms bigint,
  p_time_token_digest text,
  p_photo_storage_key text,
  p_photo_sha256 text,
  p_photo_size_bytes integer,
  p_photo_mime_type text,
  p_received_at timestamp with time zone default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_address_hint text;
  v_note text;
  v_existing public.attendance_checkins%rowtype;
  v_inserted public.attendance_checkins%rowtype;
  v_received_at timestamp with time zone;
  v_captured_at timestamp with time zone;
  v_time_verified boolean;
  v_business_date date;
  v_effective_at timestamp with time zone;
  v_sync_delay_seconds integer;
  v_sequence_in_day integer;
  v_daily_count integer;
  v_gps_valid boolean;
  v_distance_target_kind text;
  v_branch_id_used uuid := null;
  v_branch_code_used text := null;
  v_branch_name_used text := null;
  v_branch_version_used integer := null;
  v_hq_version_used integer := null;
  v_target_lat double precision := null;
  v_target_lon double precision := null;
  v_distance_meters double precision := null;
  v_distance_status text := null;
  v_user_enabled boolean := false;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'ACTOR_NOT_AVAILABLE' using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if p_idempotency_key is null then
    raise exception 'IDEMPOTENCY_KEY_INVALID' using errcode = '22023';
  end if;

  if p_request_fingerprint is null or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_REQUEST_INVALID' using errcode = '22023';
  end if;

  if p_latitude is null
     or p_latitude in (
       'NaN'::double precision,
       'Infinity'::double precision,
       '-Infinity'::double precision
     )
     or p_latitude < -90.0
     or p_latitude > 90.0
     or p_longitude is null
     or p_longitude in (
       'NaN'::double precision,
       'Infinity'::double precision,
       '-Infinity'::double precision
     )
     or p_longitude < -180.0
     or p_longitude > 180.0 then
    raise exception 'GPS_COORDINATES_INVALID' using errcode = '22023';
  end if;

  if p_accuracy_meters is null
     or p_accuracy_meters in (
       'NaN'::double precision,
       'Infinity'::double precision,
       '-Infinity'::double precision
     )
     or p_accuracy_meters < 0.0 then
    raise exception 'GPS_ACCURACY_INVALID' using errcode = '22023';
  end if;

  v_address_hint := pg_catalog.btrim(coalesce(p_address_hint, ''));
  v_note := pg_catalog.btrim(coalesce(p_note, ''));
  if pg_catalog.length(v_address_hint) > 500 or pg_catalog.length(v_note) > 2000 then
    raise exception 'ATTENDANCE_REQUEST_INVALID' using errcode = '22023';
  end if;

  if p_device_claimed_at is null
     or p_device_claimed_at in ('infinity'::timestamp with time zone, '-infinity'::timestamp with time zone) then
    raise exception 'CAPTURED_AT_INVALID' using errcode = '22023';
  end if;

  if p_photo_storage_key is null
     or pg_catalog.length(pg_catalog.btrim(p_photo_storage_key)) not between 1 and 512
     or p_photo_sha256 is null
     or p_photo_sha256 !~ '^[0-9a-f]{64}$'
     or p_photo_size_bytes is null
     or p_photo_size_bytes < 1
     or p_photo_size_bytes > 10485760
     or p_photo_mime_type is distinct from 'image/jpeg' then
    raise exception 'PHOTO_INVALID' using errcode = '22023';
  end if;

  -- Per-actor transaction advisory lock serializes same-key retries & sequence_in_day.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('attendance_checkin_v1'),
    pg_catalog.hashtext(p_app_user_id::text)
  );

  -- Share-lock app_user row so concurrent disable or NORMAL -> SHARED reclassification serializes cleanly.
  select u.enabled
    into v_user_enabled
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
   for share;

  if not found or v_user_enabled is distinct from true then
    raise exception 'ACTOR_NOT_AVAILABLE' using errcode = '42501';
  end if;

  if public.attendance__internal_is_non_employee_account(p_app_user_id, pg_catalog.clock_timestamp()) then
    raise exception 'ATTENDANCE_SHARED_ACCOUNT_FORBIDDEN' using errcode = '42501';
  end if;

  select *
    into v_existing
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;

    select count(*)::integer
      into v_daily_count
      from public.attendance_checkins c
     where c.app_user_id = p_app_user_id
       and c.business_date = v_existing.business_date;

    return pg_catalog.jsonb_build_object(
      'checkin_id', v_existing.checkin_id,
      'business_date', v_existing.business_date::text,
      'sequence_in_day', v_existing.sequence_in_day,
      'daily_count', v_daily_count,
      'captured_at', pg_catalog.to_char(v_existing.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'received_at', pg_catalog.to_char(v_existing.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'time_source', v_existing.time_source,
      'replayed', true
    );
  end if;

  v_received_at := coalesce(p_received_at, pg_catalog.clock_timestamp());
  if v_received_at in ('infinity'::timestamp with time zone, '-infinity'::timestamp with time zone) then
    raise exception 'ATTENDANCE_REQUEST_INVALID' using errcode = '22023';
  end if;

  if p_time_source = 'SERVER_ANCHORED' then
    if p_time_anchor_issued_at is null
       or p_time_anchor_issued_at in ('infinity'::timestamp with time zone, '-infinity'::timestamp with time zone)
       or p_time_token_digest is null
       or p_time_token_digest !~ '^[0-9a-f]{64}$' then
      raise exception 'ATTENDANCE_TIME_TOKEN_INVALID' using errcode = '22023';
    end if;

    if p_elapsed_since_anchor_ms is null
       or p_elapsed_since_anchor_ms < 0
       or p_elapsed_since_anchor_ms > 86400000 then
      raise exception 'ATTENDANCE_TIME_ELAPSED_INVALID' using errcode = '22023';
    end if;

    v_captured_at := p_time_anchor_issued_at + (p_elapsed_since_anchor_ms * interval '1 millisecond');

    if p_device_claimed_at - v_captured_at > interval '5 seconds'
       or v_captured_at - p_device_claimed_at > interval '5 seconds' then
      raise exception 'ATTENDANCE_TIME_MISMATCH' using errcode = '22023';
    end if;

    if p_time_anchor_issued_at > v_received_at + interval '30 seconds'
       or v_captured_at > v_received_at + interval '30 seconds'
       or p_device_claimed_at > v_received_at + interval '30 seconds' then
      raise exception 'CAPTURED_AT_FUTURE' using errcode = '22023';
    end if;

    if v_received_at > v_captured_at + interval '168 hours' then
      raise exception 'ATTENDANCE_SYNC_WINDOW_EXPIRED' using errcode = '22023';
    end if;

    v_time_verified := true;
  elsif p_time_source = 'DEVICE_CLOCK_UNVERIFIED' then
    if p_time_anchor_issued_at is not null
       or p_elapsed_since_anchor_ms is not null
       or p_time_token_digest is not null then
      raise exception 'ATTENDANCE_REQUEST_INVALID' using errcode = '22023';
    end if;

    v_captured_at := p_device_claimed_at;
    v_time_verified := false;
  else
    raise exception 'ATTENDANCE_REQUEST_INVALID' using errcode = '22023';
  end if;

  if v_captured_at > v_received_at + interval '30 seconds'
     or p_device_claimed_at > v_received_at + interval '30 seconds' then
    raise exception 'CAPTURED_AT_FUTURE' using errcode = '22023';
  end if;

  v_business_date := (v_captured_at at time zone 'Asia/Ho_Chi_Minh')::date;
  v_effective_at := case when v_time_verified then v_captured_at else v_received_at end;
  v_sync_delay_seconds := greatest(
    0,
    pg_catalog.floor(extract(epoch from (v_received_at - v_captured_at)))::integer
  );

  select coalesce(max(c.sequence_in_day), 0) + 1
    into v_sequence_in_day
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.business_date = v_business_date;

  v_gps_valid := (p_accuracy_meters <= 100000.0);

  select
    a.branch_id,
    coalesce(rev.branch_code, b.branch_code),
    coalesce(rev.display_name, b.display_name),
    coalesce(rev.version, b.version),
    case when rev.version is not null then rev.latitude else b.latitude end,
    case when rev.version is not null then rev.longitude else b.longitude end
  into
    v_branch_id_used,
    v_branch_code_used,
    v_branch_name_used,
    v_branch_version_used,
    v_target_lat,
    v_target_lon
  from public.attendance_branch_assignments a
  join public.attendance_branches b
    on b.branch_id = a.branch_id
  left join lateral (
    select
      r.version,
      r.branch_code,
      r.display_name,
      r.latitude,
      r.longitude,
      r.active
    from public.attendance_branch_revisions r
    where r.branch_id = a.branch_id
      and r.effective_from <= v_effective_at
    order by r.effective_from desc, r.version desc
    limit 1
  ) rev on true
  where a.app_user_id = p_app_user_id
    and a.valid_from <= v_business_date
    and (a.valid_to is null or v_business_date <= a.valid_to)
    and coalesce(rev.active, b.active) = true
  order by a.valid_from desc
  limit 1;

  if v_branch_id_used is not null then
    v_distance_target_kind := 'BRANCH';
    v_hq_version_used := null;
    if not v_gps_valid then
      v_distance_status := 'INVALID_GPS';
      v_distance_meters := null;
      v_branch_version_used := null;
    elsif v_target_lat is null or v_target_lon is null then
      v_distance_status := 'BRANCH_NOT_CONFIGURED';
      v_distance_meters := null;
    else
      v_distance_status := 'COMPUTED';
      v_distance_meters := pg_catalog.round(
        (
          2.0 * 6371000.0 * pg_catalog.asin(
            least(
              1.0::double precision,
              pg_catalog.sqrt(
                greatest(
                  0.0::double precision,
                  pg_catalog.power(pg_catalog.sin(pg_catalog.radians(p_latitude - v_target_lat) / 2.0), 2.0)
                  + pg_catalog.cos(pg_catalog.radians(v_target_lat))
                    * pg_catalog.cos(pg_catalog.radians(p_latitude))
                    * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(p_longitude - v_target_lon) / 2.0), 2.0)
                )
              )
            )
          )
        )::numeric,
        1
      )::double precision;
    end if;
  else
    v_distance_target_kind := 'HQ';
    select
      r.version,
      r.latitude,
      r.longitude
    into
      v_hq_version_used,
      v_target_lat,
      v_target_lon
    from public.attendance_hq_location_revisions r
    where r.effective_from <= v_effective_at
    order by r.effective_from desc, r.version desc
    limit 1;

    if not v_gps_valid then
      v_distance_status := 'INVALID_GPS';
      v_distance_meters := null;
      v_hq_version_used := null;
    elsif v_hq_version_used is null then
      v_distance_status := 'HQ_NOT_CONFIGURED';
      v_distance_meters := null;
    else
      v_distance_status := 'COMPUTED';
      v_distance_meters := pg_catalog.round(
        (
          2.0 * 6371000.0 * pg_catalog.asin(
            least(
              1.0::double precision,
              pg_catalog.sqrt(
                greatest(
                  0.0::double precision,
                  pg_catalog.power(pg_catalog.sin(pg_catalog.radians(p_latitude - v_target_lat) / 2.0), 2.0)
                  + pg_catalog.cos(pg_catalog.radians(v_target_lat))
                    * pg_catalog.cos(pg_catalog.radians(p_latitude))
                    * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(p_longitude - v_target_lon) / 2.0), 2.0)
                )
              )
            )
          )
        )::numeric,
        1
      )::double precision;
    end if;
  end if;

  insert into public.attendance_checkins (
    app_user_id,
    business_date,
    sequence_in_day,
    latitude,
    longitude,
    accuracy_meters,
    address_hint,
    note,
    device_claimed_at,
    captured_at,
    received_at,
    time_source,
    time_verified,
    time_anchor_issued_at,
    elapsed_since_anchor_ms,
    sync_delay_seconds,
    idempotency_key,
    request_fingerprint,
    time_token_digest,
    photo_storage_key,
    photo_sha256,
    photo_size_bytes,
    photo_mime_type,
    distance_target_kind,
    branch_id_used,
    branch_code_used,
    branch_name_used,
    branch_version_used,
    hq_version_used,
    distance_meters,
    distance_status
  ) values (
    p_app_user_id,
    v_business_date,
    v_sequence_in_day,
    p_latitude,
    p_longitude,
    p_accuracy_meters,
    v_address_hint,
    v_note,
    p_device_claimed_at,
    v_captured_at,
    v_received_at,
    p_time_source,
    v_time_verified,
    p_time_anchor_issued_at,
    p_elapsed_since_anchor_ms,
    v_sync_delay_seconds,
    p_idempotency_key,
    p_request_fingerprint,
    p_time_token_digest,
    pg_catalog.btrim(p_photo_storage_key),
    p_photo_sha256,
    p_photo_size_bytes,
    p_photo_mime_type,
    v_distance_target_kind,
    v_branch_id_used,
    v_branch_code_used,
    v_branch_name_used,
    v_branch_version_used,
    v_hq_version_used,
    v_distance_meters,
    v_distance_status
  )
  returning * into v_inserted;

  select count(*)::integer
    into v_daily_count
    from public.attendance_checkins c
   where c.app_user_id = p_app_user_id
     and c.business_date = v_business_date;

  return pg_catalog.jsonb_build_object(
    'checkin_id', v_inserted.checkin_id,
    'business_date', v_inserted.business_date::text,
    'sequence_in_day', v_inserted.sequence_in_day,
    'daily_count', v_daily_count,
    'captured_at', pg_catalog.to_char(v_inserted.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'received_at', pg_catalog.to_char(v_inserted.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'time_source', v_inserted.time_source,
    'replayed', false
  );
end;
$function$;

revoke all on function public.attendance_record_checkin(
  uuid, uuid, uuid, text, double precision, double precision, double precision,
  text, text, timestamptz, text, timestamptz, bigint, text, text, text,
  integer, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.attendance_record_checkin(
  uuid, uuid, uuid, text, double precision, double precision, double precision,
  text, text, timestamptz, text, timestamptz, bigint, text, text, text,
  integer, text, timestamptz
) to service_role;

-- -----------------------------------------------------------------------------
-- 8. D-WP7B-01/02/03: attendance_admin_report (Per-Day Historical Scope + HEAD)
--    (7-arg wrapper delegates directly to this 8-arg definition)
-- -----------------------------------------------------------------------------
create or replace function public.attendance_admin_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_from_date date,
  p_to_date date,
  p_page integer,
  p_page_size integer,
  p_search text,
  p_employee_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_kind text;
  v_scope_team_ids uuid[];
  v_scope_department_ids uuid[];
  v_can_configure_hq boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today_vn date := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
  v_to_date date := coalesce(p_to_date, v_today_vn);
  v_from_date date := coalesce(p_from_date, coalesce(p_to_date, v_today_vn) - 6);
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_search text := nullif(pg_catalog.btrim(coalesce(p_search, '')), '');
  v_search_pattern text;
  v_employee_options jsonb := '[]'::jsonb;
  v_current_hq jsonb;
  v_overview jsonb;
  v_total_rows integer := 0;
  v_total_pages integer := 1;
  v_items jsonb := '[]'::jsonb;
begin
  select s.scope_kind, s.team_ids, s.department_ids, s.can_configure_hq
    into v_scope_kind, v_scope_team_ids, v_scope_department_ids, v_can_configure_hq
    from public.attendance__internal_resolve_report_scope_v2(
      p_auth_subject,
      p_app_user_id
    ) s;

  if v_from_date in ('infinity'::date, '-infinity'::date)
     or v_to_date in ('infinity'::date, '-infinity'::date)
     or v_from_date > v_to_date
     or (v_to_date - v_from_date) > 366 then
    raise exception 'ATTENDANCE_REPORT_RANGE_INVALID' using errcode = '22023';
  end if;

  if v_page < 1 or v_page > 1000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'ATTENDANCE_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  if v_search is not null then
    if pg_catalog.length(v_search) > 120 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'ATTENDANCE_REPORT_SEARCH_INVALID' using errcode = '22023';
    end if;
    if p_employee_id is not null then
      raise exception 'ATTENDANCE_REPORT_FILTER_CONFLICT' using errcode = '22023';
    end if;
    v_search_pattern :=
      '%' || pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(v_search, '\', '\\'),
          '%',
          '\%'
        ),
        '_',
        '\_'
      ) || '%';
  end if;

  if v_scope_kind <> 'all'
     and p_employee_id is not null
     and not public.attendance__internal_has_any_scope_day_in_range(
       v_scope_kind,
       v_scope_team_ids,
       v_scope_department_ids,
       p_employee_id,
       v_from_date,
       v_to_date,
       v_today_vn,
       v_now
     ) then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  if v_scope_kind = 'all' then
    select jsonb_build_object(
             'version', h.version,
             'latitude', h.latitude,
             'longitude', h.longitude,
             'effective_from', pg_catalog.to_char(h.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'effective_from_local', pg_catalog.to_char(h.effective_from at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS'),
             'configured_by_display_name', coalesce(ident.employee_display_name, u.display_name)
           )
      into v_current_hq
      from public.attendance_hq_location_revisions h
      join public.direct_entry_app_users u
        on u.app_user_id = h.configured_by_user_id
      left join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident on true
     order by h.effective_from desc, h.version desc
     limit 1;
  else
    v_current_hq := null;
  end if;

  -- Strictly filter check-ins per business_date BEFORE building employee_options, overview, or pagination.
  -- Real historical check-ins of SHARED/SERVICE/DISABLED accounts stay visible to authorized viewers.
  with scoped_checkins as materialized (
    select
      c.*,
      u.display_name as raw_display_name
    from public.attendance_checkins c
    join public.direct_entry_app_users u
      on u.app_user_id = c.app_user_id
    where c.business_date between v_from_date and v_to_date
      and (
        v_scope_kind = 'all'
        or public.attendance__internal_is_employee_in_scope_on_date(
          v_scope_kind,
          v_scope_team_ids,
          v_scope_department_ids,
          c.app_user_id,
          c.business_date,
          v_today_vn,
          v_now
        )
      )
  ),
  scoped_employee_identities as materialized (
    select
      du.app_user_id,
      du.raw_display_name,
      ident.employee_display_name,
      ident.personnel_code
    from (
      select distinct
        sc.app_user_id,
        sc.raw_display_name
      from scoped_checkins sc
    ) du
    cross join lateral public.attendance__internal_resolve_employee_identity(
      du.app_user_id
    ) ident
  ),
  employee_options_agg as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'app_user_id', sei.app_user_id,
          'display_name', sei.employee_display_name,
          'personnel_code', sei.personnel_code
        )
        order by pg_catalog.lower(sei.employee_display_name) asc,
                 sei.employee_display_name asc,
                 coalesce(sei.personnel_code, '') asc,
                 sei.app_user_id asc
      ),
      '[]'::jsonb
    ) as employee_options
    from scoped_employee_identities sei
  ),
  filtered_employees as materialized (
    select
      sei.app_user_id,
      sei.employee_display_name,
      sei.personnel_code
    from scoped_employee_identities sei
    where (p_employee_id is null or sei.app_user_id = p_employee_id)
      and (
        v_search_pattern is null
        or sei.employee_display_name ilike v_search_pattern escape '\'
        or sei.raw_display_name ilike v_search_pattern escape '\'
        or coalesce(sei.personnel_code, '') ilike v_search_pattern escape '\'
      )
  ),
  filtered_base as (
    select
      c.checkin_id,
      c.app_user_id,
      fe.employee_display_name,
      fe.personnel_code,
      c.business_date,
      c.sequence_in_day,
      c.captured_at,
      c.received_at,
      c.time_source,
      c.time_verified,
      c.sync_delay_seconds,
      c.latitude,
      c.longitude,
      c.accuracy_meters,
      c.address_hint,
      c.note,
      c.distance_target_kind,
      c.branch_id_used,
      c.branch_code_used,
      c.branch_name_used,
      c.branch_version_used,
      c.hq_version_used as persisted_hq_version_used,
      c.distance_meters as persisted_distance_meters,
      c.distance_status as persisted_distance_status,
      (
        c.latitude is not null
        and c.longitude is not null
        and c.accuracy_meters is not null
        and c.latitude not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
        and c.longitude not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
        and c.accuracy_meters not in ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
        and c.latitude >= -90.0 and c.latitude <= 90.0
        and c.longitude >= -180.0 and c.longitude <= 180.0
        and c.accuracy_meters >= 0.0 and c.accuracy_meters <= 100000.0
      ) as gps_valid,
      hq.version as hq_version,
      hq.latitude as hq_latitude,
      hq.longitude as hq_longitude
    from scoped_checkins c
    join filtered_employees fe
      on fe.app_user_id = c.app_user_id
    left join lateral (
      select h.version, h.latitude, h.longitude
        from public.attendance_hq_location_revisions h
       where c.distance_status is null
         and h.effective_from <= (
           case when c.time_verified then c.captured_at else c.received_at end
         )
       order by h.effective_from desc, h.version desc
       limit 1
    ) hq on true
  ),
  computed as (
    select
      b.checkin_id,
      b.app_user_id,
      b.employee_display_name,
      b.personnel_code,
      b.business_date,
      b.sequence_in_day,
      b.captured_at,
      b.received_at,
      b.time_source,
      b.time_verified,
      b.sync_delay_seconds,
      case when b.gps_valid then b.latitude else null end as latitude,
      case when b.gps_valid then b.longitude else null end as longitude,
      case when b.gps_valid then b.accuracy_meters else null end as accuracy_meters,
      b.address_hint,
      b.note,
      case
        when b.persisted_distance_status is not null then
          coalesce(b.distance_target_kind, case when b.branch_id_used is not null then 'BRANCH' else 'HQ' end)
        else 'HQ'
      end as distance_target_kind,
      case
        when b.persisted_distance_status is not null then b.persisted_distance_status
        when not b.gps_valid then 'INVALID_GPS'
        when b.hq_version is null then 'HQ_NOT_CONFIGURED'
        else 'COMPUTED'
      end as distance_status,
      case
        when b.persisted_distance_status is not null then b.persisted_hq_version_used
        when b.gps_valid and b.hq_version is not null then b.hq_version
        else null
      end as hq_version_used,
      b.branch_id_used,
      b.branch_code_used,
      b.branch_name_used,
      case
        when b.persisted_distance_status is not null then b.branch_version_used
        else null
      end as branch_version_used,
      case
        when b.persisted_distance_status is not null then b.persisted_distance_meters
        when not b.gps_valid or b.hq_version is null then null
        else pg_catalog.round(
          (
            2.0 * 6371000.0 * pg_catalog.asin(
              least(
                1.0::double precision,
                pg_catalog.sqrt(
                  greatest(
                    0.0::double precision,
                    pg_catalog.power(pg_catalog.sin(pg_catalog.radians(b.latitude - b.hq_latitude) / 2.0), 2.0)
                    + pg_catalog.cos(pg_catalog.radians(b.hq_latitude))
                      * pg_catalog.cos(pg_catalog.radians(b.latitude))
                      * pg_catalog.power(pg_catalog.sin(pg_catalog.radians(b.longitude - b.hq_longitude) / 2.0), 2.0)
                  )
                )
              )
            )
          )::numeric,
          1
        )::double precision
      end as distance_meters
    from filtered_base b
  ),
  agg as (
    select
      count(*)::integer as total_checkins,
      count(distinct c.app_user_id)::integer as unique_employees,
      count(*) filter (where c.time_verified)::integer as verified_time_count,
      count(*) filter (where not c.time_verified)::integer as unverified_time_count,
      count(*) filter (where c.distance_status = 'COMPUTED')::integer as distance_computed_count,
      count(*) filter (where c.distance_status <> 'COMPUTED')::integer as distance_unavailable_count,
      case
        when count(*) filter (where c.distance_status = 'COMPUTED') = 0 then null
        else pg_catalog.round(
          (avg(c.distance_meters) filter (where c.distance_status = 'COMPUTED'))::numeric,
          1
        )::double precision
      end as avg_distance_meters,
      case
        when count(*) filter (where c.distance_status = 'COMPUTED') = 0 then null
        else pg_catalog.round(
          (max(c.distance_meters) filter (where c.distance_status = 'COMPUTED'))::numeric,
          1
        )::double precision
      end as max_distance_meters
    from computed c
  ),
  paged as (
    select
      c.checkin_id,
      c.captured_at as raw_captured_at,
      c.employee_display_name,
      c.personnel_code,
      c.business_date::text as business_date,
      c.sequence_in_day,
      pg_catalog.to_char(c.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as captured_at,
      pg_catalog.to_char(c.captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as captured_at_local,
      pg_catalog.to_char(c.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as received_at,
      c.time_source,
      c.time_verified,
      c.sync_delay_seconds,
      c.latitude,
      c.longitude,
      c.accuracy_meters,
      c.address_hint,
      c.note,
      c.distance_meters,
      c.distance_status,
      c.distance_target_kind,
      c.hq_version_used,
      c.branch_id_used,
      c.branch_code_used,
      c.branch_name_used,
      c.branch_version_used
    from computed c
    order by c.captured_at desc, c.checkin_id desc
    offset ((v_page - 1) * v_page_size)
    limit v_page_size
  )
  select
    eoa.employee_options,
    jsonb_build_object(
      'total_checkins', a.total_checkins,
      'unique_employees', a.unique_employees,
      'verified_time_count', a.verified_time_count,
      'unverified_time_count', a.unverified_time_count,
      'distance_computed_count', a.distance_computed_count,
      'distance_unavailable_count', a.distance_unavailable_count,
      'avg_distance_meters', a.avg_distance_meters,
      'max_distance_meters', a.max_distance_meters
    ),
    a.total_checkins,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'checkin_id', p.checkin_id,
            'employee_display_name', p.employee_display_name,
            'personnel_code', p.personnel_code,
            'business_date', p.business_date,
            'sequence_in_day', p.sequence_in_day,
            'captured_at', p.captured_at,
            'captured_at_local', p.captured_at_local,
            'received_at', p.received_at,
            'time_source', p.time_source,
            'time_verified', p.time_verified,
            'sync_delay_seconds', p.sync_delay_seconds,
            'latitude', p.latitude,
            'longitude', p.longitude,
            'accuracy_meters', p.accuracy_meters,
            'address_hint', p.address_hint,
            'note', p.note,
            'distance_meters', p.distance_meters,
            'distance_status', p.distance_status,
            'hq_version_used', p.hq_version_used,
            'branch_id_used', p.branch_id_used,
            'branch_code_used', p.branch_code_used,
            'branch_name_used', p.branch_name_used,
            'branch_version_used', p.branch_version_used
          )
          order by p.raw_captured_at desc, p.checkin_id desc
        )
        from paged p
      ),
      '[]'::jsonb
    )
    into v_employee_options, v_overview, v_total_rows, v_items
    from agg a
    cross join employee_options_agg eoa;

  v_total_pages := greatest(
    1,
    pg_catalog.ceil(v_total_rows::numeric / v_page_size::numeric)::integer
  );

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_configure_hq', v_can_configure_hq
    ),
    'filters', jsonb_build_object(
      'from_date', v_from_date::text,
      'to_date', v_to_date::text,
      'search', v_search,
      'employee_id', p_employee_id,
      'timezone', 'Asia/Ho_Chi_Minh'
    ),
    'employee_options', v_employee_options,
    'current_hq', v_current_hq,
    'overview', v_overview,
    'pagination', jsonb_build_object(
      'page', v_page,
      'page_size', v_page_size,
      'total_rows', v_total_rows,
      'total_pages', v_total_pages,
      'has_more', (v_page * v_page_size) < v_total_rows
    ),
    'items', v_items
  );
end;
$function$;

revoke all on function public.attendance_admin_report(
  uuid, uuid, date, date, integer, integer, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.attendance_admin_report(
  uuid, uuid, date, date, integer, integer, text, uuid
) to service_role;

-- -----------------------------------------------------------------------------
-- 9. D-WP7B-01/02/03: attendance_admin_checkin_photo (Per-Day Scope + HEAD)
-- -----------------------------------------------------------------------------
create or replace function public.attendance_admin_checkin_photo(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_checkin_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope_kind text;
  v_scope_team_ids uuid[];
  v_scope_department_ids uuid[];
  v_can_configure_hq boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today_vn date := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
  v_checkin_app_user_id uuid;
  v_checkin_business_date date;
  v_storage_key text;
begin
  select s.scope_kind, s.team_ids, s.department_ids, s.can_configure_hq
    into v_scope_kind, v_scope_team_ids, v_scope_department_ids, v_can_configure_hq
    from public.attendance__internal_resolve_report_scope_v2(
      p_auth_subject,
      p_app_user_id
    ) s;

  if p_checkin_id is null then
    raise exception 'ATTENDANCE_REPORT_QUERY_INVALID' using errcode = '22023';
  end if;

  select c.app_user_id, c.business_date, c.photo_storage_key
    into v_checkin_app_user_id, v_checkin_business_date, v_storage_key
    from public.attendance_checkins c
   where c.checkin_id = p_checkin_id;

  if not found then
    return jsonb_build_object('found', false);
  end if;

  if v_scope_kind <> 'all'
     and not public.attendance__internal_is_employee_in_scope_on_date(
       v_scope_kind,
       v_scope_team_ids,
       v_scope_department_ids,
       v_checkin_app_user_id,
       v_checkin_business_date,
       v_today_vn,
       v_now
     ) then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'found', true,
    'photo_storage_key', v_storage_key
  );
end;
$function$;

revoke all on function public.attendance_admin_checkin_photo(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_admin_checkin_photo(uuid, uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 10. D-WP7B-01/02/03: attendance_monthly_matrix_report
--     - DEPARTMENT_HEAD + TEAM_LEADER + ALL paired scoping
--     - Per-day server-side as-of membership filtering (Option A)
--     - Out-of-scope & non-obligated empty days emitted with strict-parser-
--       compatible UPCOMING shape (zero sensitive data, zero MISSING, zero totals)
--     - SHARED/SERVICE & legacy is_shared_non_employee excluded from obligations
--       while real historical check-ins remain queryable & exportable
-- -----------------------------------------------------------------------------
create or replace function public.attendance_monthly_matrix_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_year_month text default null,
  p_branch_id uuid default null,
  p_employee_id uuid default null,
  p_search text default null,
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
  v_default_profile_id constant uuid := '00000000-0000-4000-8000-000000000001'::uuid;
  v_scope_kind text;
  v_scope_team_ids uuid[];
  v_scope_department_ids uuid[];
  v_can_configure_hq boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_now_vn timestamp without time zone := v_now at time zone 'Asia/Ho_Chi_Minh';
  v_today_vn date := v_now_vn::date;
  v_year_month text := coalesce(nullif(btrim(p_year_month), ''), to_char(v_today_vn, 'YYYY-MM'));
  v_year integer;
  v_month integer;
  v_month_start date;
  v_month_end date;
  v_ref_date date;
  v_days_in_month integer;
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
  v_escaped_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_current_hq jsonb;
  v_slot_policy jsonb;
  v_calendar_days jsonb;
  v_branch_options jsonb := '[]'::jsonb;
  v_employee_options jsonb := '[]'::jsonb;
  v_overview jsonb;
  v_total_rows integer := 0;
  v_total_pages integer := 0;
  v_snapshot_token text;
  v_items jsonb := '[]'::jsonb;
begin
  select s.scope_kind, s.team_ids, s.department_ids, s.can_configure_hq
    into v_scope_kind, v_scope_team_ids, v_scope_department_ids, v_can_configure_hq
    from public.attendance__internal_resolve_report_scope_v2(
      p_auth_subject,
      p_app_user_id
    ) s;

  if v_year_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'ATTENDANCE_MATRIX_MONTH_INVALID'
      using errcode = '22023';
  end if;

  v_year := split_part(v_year_month, '-', 1)::integer;
  v_month := split_part(v_year_month, '-', 2)::integer;

  if v_year < 2000 or v_year > 2100 then
    raise exception 'ATTENDANCE_MATRIX_MONTH_INVALID'
      using errcode = '22023';
  end if;

  v_month_start := make_date(v_year, v_month, 1);
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;
  v_ref_date := least(v_today_vn, v_month_end);
  v_days_in_month := (v_month_end - v_month_start) + 1;

  if p_employee_id is not null and v_search is not null then
    raise exception 'ATTENDANCE_REPORT_FILTER_CONFLICT'
      using errcode = '22023';
  end if;

  if v_search is not null then
    if length(v_search) > 100 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'ATTENDANCE_REPORT_SEARCH_INVALID'
        using errcode = '22023';
    end if;
    v_escaped_search := replace(
      replace(
        replace(lower(v_search), '\', '\\'),
        '%',
        '\%'
      ),
      '_',
      '\_'
    );
  end if;

  if v_page < 1 or v_page > 1000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'ATTENDANCE_REPORT_PAGINATION_INVALID'
      using errcode = '22023';
  end if;

  if v_scope_kind <> 'all'
     and p_employee_id is not null
     and not public.attendance__internal_has_any_scope_day_in_range(
       v_scope_kind,
       v_scope_team_ids,
       v_scope_department_ids,
       p_employee_id,
       v_month_start,
       v_month_end,
       v_today_vn,
       v_now
     ) then
    raise exception 'ATTENDANCE_REPORT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_offset := (v_page - 1) * v_page_size;

  if v_scope_kind = 'all' then
    select jsonb_build_object(
      'version', r.version,
      'latitude', r.latitude,
      'longitude', r.longitude,
      'effective_from', to_char(r.effective_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effective_from_local', to_char(r.effective_from at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS'),
      'configured_by_display_name', coalesce(ident.employee_display_name, u.display_name)
    )
      into v_current_hq
    from public.attendance_hq_location_revisions r
    join public.direct_entry_app_users u
      on u.app_user_id = r.configured_by_user_id
    left join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident on true
    order by r.effective_from desc, r.version desc
    limit 1;

    with policy_with_bounds as materialized (
      select
        p as policy_row,
        p.profile_id,
        p.version,
        p.effective_from_date,
        (
          lead(p.effective_from_date) over (
            partition by p.profile_id
            order by p.effective_from_date asc, p.version asc
          ) - 1
        ) as effective_to_date,
        coalesce(ident.employee_display_name, u.display_name) as actor_display_name
      from public.attendance_slot_policy_versions p
      left join public.direct_entry_app_users u
        on u.app_user_id = p.configured_by_user_id
      left join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident on true
    ),
    default_month_active_versions as (
      select distinct on (pb.version)
        pb.*
      from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal(d)
      join lateral (
        select p2.*
        from policy_with_bounds p2
        where p2.profile_id = v_default_profile_id
        order by (p2.effective_from_date <= cal.d::date) desc, p2.effective_from_date desc, p2.version desc
        limit 1
      ) pb on true
      order by pb.version asc
    )
    select jsonb_build_object(
      'current_policy', (
        select public.attendance__internal_format_slot_policy(
          pb.policy_row,
          pb.effective_to_date,
          pb.actor_display_name
        )
        from policy_with_bounds pb
        where pb.profile_id = v_default_profile_id
        order by (pb.effective_from_date <= v_today_vn) desc, pb.effective_from_date desc, pb.version desc
        limit 1
      ),
      'latest_policy', (
        select public.attendance__internal_format_slot_policy(
          pb.policy_row,
          pb.effective_to_date,
          pb.actor_display_name
        )
        from policy_with_bounds pb
        where pb.profile_id = v_default_profile_id
        order by pb.version desc
        limit 1
      ),
      'month_policies', coalesce(
        (
          select jsonb_agg(
            public.attendance__internal_format_slot_policy(
              mv.policy_row,
              mv.effective_to_date,
              mv.actor_display_name
            )
            order by mv.version asc
          )
          from default_month_active_versions mv
        ),
        '[]'::jsonb
      ),
      'profiles', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'profile_id', pr.profile_id,
              'profile_code', pr.profile_code,
              'display_name', pr.display_name,
              'description', pr.description,
              'is_default', pr.is_default,
              'active', pr.active,
              'version', pr.version,
              'current_policy', (
                select public.attendance__internal_format_slot_policy(
                  pb_c.policy_row,
                  pb_c.effective_to_date,
                  pb_c.actor_display_name
                )
                from policy_with_bounds pb_c
                where pb_c.profile_id = pr.profile_id
                order by (pb_c.effective_from_date <= v_today_vn) desc, pb_c.effective_from_date desc, pb_c.version desc
                limit 1
              ),
              'latest_policy', (
                select public.attendance__internal_format_slot_policy(
                  pb_l.policy_row,
                  pb_l.effective_to_date,
                  pb_l.actor_display_name
                )
                from policy_with_bounds pb_l
                where pb_l.profile_id = pr.profile_id
                order by pb_l.version desc
                limit 1
              ),
              'month_policies', coalesce((
                select jsonb_agg(
                  public.attendance__internal_format_slot_policy(
                    pmv.policy_row,
                    pmv.effective_to_date,
                    pmv.actor_display_name
                  )
                  order by pmv.version asc
                )
                from (
                  select distinct on (pb_m.version)
                    pb_m.*
                  from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal_m(d)
                  join lateral (
                    select p3.*
                    from policy_with_bounds p3
                    where p3.profile_id = pr.profile_id
                    order by (p3.effective_from_date <= cal_m.d::date) desc, p3.effective_from_date desc, p3.version desc
                    limit 1
                  ) pb_m on true
                  order by pb_m.version asc
                ) pmv
              ), '[]'::jsonb)
            )
            order by
              pr.is_default desc,
              pr.active desc,
              lower(pr.display_name) asc,
              lower(pr.profile_code) asc,
              pr.profile_id asc
          )
          from public.attendance_slot_policy_profiles pr
        ),
        '[]'::jsonb
      )
    )
      into v_slot_policy;
  else
    v_current_hq := null;
    v_slot_policy := null;
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'business_date', d::date,
      'day_of_month', extract(day from d)::integer,
      'day_of_week', extract(isodow from d)::integer
    )
    order by d::date asc
  )
    into v_calendar_days
  from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as d;

  with month_calendar_days as materialized (
    select
      cal.d::date as business_date,
      extract(day from cal.d)::integer as day_of_month
    from generate_series(v_month_start::timestamp, v_month_end::timestamp, interval '1 day') as cal(d)
  ),
  user_scoped_days as materialized (
    -- For scoped viewers, exact per-day in-scope set derived strictly from verified historical memberships.
    -- For scope_kind = 'all', kept empty and bypassed cleanly below.
    select
      u.app_user_id,
      cal.business_date
    from public.direct_entry_app_users u
    cross join month_calendar_days cal
    where v_scope_kind <> 'all'
      and public.attendance__internal_is_employee_in_scope_on_date(
        v_scope_kind,
        v_scope_team_ids,
        v_scope_department_ids,
        u.app_user_id,
        cal.business_date,
        v_today_vn,
        v_now
      )
  ),
  users_with_obligations as materialized (
    select
      u.app_user_id,
      u.display_name as raw_display_name,
      u.enabled,
      not public.attendance__internal_is_non_employee_account(u.app_user_id, v_now) as is_obligated
    from public.direct_entry_app_users u
    where v_scope_kind = 'all'
       or exists (
         select 1
         from user_scoped_days usd
         where usd.app_user_id = u.app_user_id
       )
  ),
  eligible_month_users as materialized (
    -- Include:
    --   (1) Enabled obligated employees (NORMAL linked or unlinked, not blocked as SHARED/SERVICE), OR
    --   (2) Any account (including DISABLED or SHARED/SERVICE) that has real historical check-ins,
    --       approved leave, or attendance explanations on at least one IN-SCOPE day of this month.
    select
      u.app_user_id,
      u.raw_display_name,
      u.enabled,
      u.is_obligated
    from users_with_obligations u
    where (u.enabled = true and u.is_obligated = true)
       or exists (
         select 1
         from public.attendance_checkins c
         where c.app_user_id = u.app_user_id
           and c.business_date between v_month_start and v_month_end
           and (
             v_scope_kind = 'all'
             or exists (
               select 1
               from user_scoped_days usd
               where usd.app_user_id = c.app_user_id
                 and usd.business_date = c.business_date
             )
           )
       )
       or exists (
         select 1
         from public.leave_request_days ld
         join public.leave_requests lr
           on lr.request_id = ld.request_id
         where ld.app_user_id = u.app_user_id
           and lr.status = 'APPROVED'
           and ld.is_active = true
           and ld.leave_date between v_month_start and v_month_end
           and (
             v_scope_kind = 'all'
             or exists (
               select 1
               from user_scoped_days usd
               where usd.app_user_id = ld.app_user_id
                 and usd.business_date = ld.leave_date
             )
           )
       )
       or exists (
         select 1
         from public.attendance_explanations ae
         where ae.app_user_id = u.app_user_id
           and ae.business_date between v_month_start and v_month_end
           and (
             v_scope_kind = 'all'
             or exists (
               select 1
               from user_scoped_days usd
               where usd.app_user_id = ae.app_user_id
                 and usd.business_date = ae.business_date
             )
           )
       )
  ),
  month_candidate_users as materialized (
    select
      u.app_user_id,
      u.raw_display_name,
      ident.employee_display_name,
      u.enabled,
      u.is_obligated,
      ident.personnel_code,
      br.branch_id,
      br.branch_code,
      br.display_name as branch_display_name,
      br.address as branch_address,
      br.latitude as branch_latitude,
      br.longitude as branch_longitude,
      br.active as branch_active,
      br.version as branch_version,
      br.valid_from as branch_valid_from,
      br.valid_to as branch_valid_to,
      coalesce(sp.profile_id, v_default_profile_id) as slot_profile_id,
      coalesce(sp.profile_code, 'DEFAULT') as slot_profile_code,
      coalesce(sp.display_name, 'Mặc định') as slot_profile_name,
      coalesce(sp.is_default, true) as slot_profile_is_default,
      sp.assignment_id as slot_assignment_id,
      sp.valid_from as slot_assignment_valid_from,
      sp.valid_to as slot_assignment_valid_to
    from eligible_month_users u
    cross join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident
    left join lateral (
      select
        b.branch_id,
        b.branch_code,
        b.display_name,
        b.address,
        b.latitude,
        b.longitude,
        b.active,
        b.version,
        a.valid_from,
        a.valid_to
      from public.attendance_branch_assignments a
      join public.attendance_branches b
        on b.branch_id = a.branch_id
      where a.app_user_id = u.app_user_id
        and a.valid_from <= v_month_end
        and (a.valid_to is null or a.valid_to >= v_month_start)
        and (
          v_scope_kind = 'all'
          or exists (
            select 1
            from user_scoped_days usd
            where usd.app_user_id = u.app_user_id
              and a.valid_from <= usd.business_date
              and (a.valid_to is null or usd.business_date <= a.valid_to)
          )
        )
      order by a.valid_from desc
      limit 1
    ) br on true
    left join lateral (
      select
        pr.profile_id,
        pr.profile_code,
        pr.display_name,
        pr.is_default,
        a.assignment_id,
        a.valid_from,
        a.valid_to
      from public.attendance_slot_policy_assignments a
      join public.attendance_slot_policy_profiles pr
        on pr.profile_id = a.profile_id
      where a.app_user_id = u.app_user_id
        and not a.superseded_same_day
        and a.valid_from <= v_month_end
        and (a.valid_to is null or a.valid_to >= v_month_start)
        and (
          v_scope_kind = 'all'
          or exists (
            select 1
            from user_scoped_days usd
            where usd.app_user_id = u.app_user_id
              and a.valid_from <= usd.business_date
              and (a.valid_to is null or usd.business_date <= a.valid_to)
          )
        )
      order by
        (a.valid_from <= v_ref_date and (a.valid_to is null or v_ref_date <= a.valid_to)) desc,
        a.valid_from desc,
        a.assigned_at desc,
        a.assignment_id desc
      limit 1
    ) sp on true
  ),
  branch_options_agg as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'branch_id', b.branch_id,
          'branch_code', b.branch_code,
          'display_name', b.display_name,
          'active', b.active,
          'latitude', b.latitude,
          'longitude', b.longitude,
          'version', b.version
        )
        order by b.branch_code asc, b.branch_id asc
      ),
      '[]'::jsonb
    ) as branch_options
    from public.attendance_branches b
    where v_scope_kind = 'all'
       or exists (
         select 1
         from month_candidate_users m
         where m.branch_id = b.branch_id
       )
       or exists (
         select 1
         from month_candidate_users m
         join public.attendance_checkins c
           on c.app_user_id = m.app_user_id
         where c.business_date between v_month_start and v_month_end
           and c.branch_id_used = b.branch_id
           and exists (
             select 1
             from user_scoped_days usd
             where usd.app_user_id = c.app_user_id
               and usd.business_date = c.business_date
           )
       )
  ),
  employee_options_agg as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'app_user_id', m.app_user_id,
          'display_name', m.employee_display_name,
          'personnel_code', m.personnel_code,
          'branch_id', m.branch_id,
          'branch_code', m.branch_code,
          'branch_name', m.branch_display_name,
          'slot_profile_id', m.slot_profile_id,
          'slot_profile_code', m.slot_profile_code,
          'slot_profile_name', m.slot_profile_name
        )
        order by lower(m.employee_display_name) asc, m.app_user_id asc
      ),
      '[]'::jsonb
    ) as employee_options
    from month_candidate_users m
  ),
  profile_day_policies as materialized (
    select
      pr.profile_id,
      pr.profile_code,
      pr.display_name as profile_name,
      pr.is_default,
      cal.business_date,
      cal.day_of_month,
      pol.version as policy_version,
      pol.slots as policy_slots
    from public.attendance_slot_policy_profiles pr
    cross join month_calendar_days cal
    join lateral (
      select p.*
      from public.attendance_slot_policy_versions p
      where p.profile_id = pr.profile_id
      order by (p.effective_from_date <= cal.business_date) desc, p.effective_from_date desc, p.version desc
      limit 1
    ) pol on true
  ),
  profile_day_slot_defs as materialized (
    select
      pdp.profile_id,
      pdp.profile_code,
      pdp.profile_name,
      pdp.is_default,
      pdp.business_date,
      pdp.day_of_month,
      pdp.policy_version,
      (slot_elem->>'slot_index')::integer as slot_index,
      slot_elem->>'slot_code' as slot_code,
      coalesce(
        nullif(btrim(coalesce(slot_elem->>'slot_label', '')), ''),
        'Time ' || (slot_elem->>'slot_index')
      ) as slot_label,
      slot_elem->>'session_code' as session_code,
      slot_elem->>'target_time' as target_time,
      (
        split_part(slot_elem->>'target_time', ':', 1)::integer * 60
        + split_part(slot_elem->>'target_time', ':', 2)::integer
      ) as target_minute,
      (slot_elem->>'grace_before_minutes')::integer as grace_before_minutes,
      (slot_elem->>'grace_after_minutes')::integer as grace_after_minutes,
      (
        pdp.business_date < v_today_vn
        or (
          pdp.business_date = v_today_vn
          and v_now_vn > pdp.business_date
            + (slot_elem->>'target_time')::time
            + make_interval(mins => (slot_elem->>'grace_after_minutes')::integer)
        )
      ) as is_due
    from profile_day_policies pdp
    cross join lateral jsonb_array_elements(pdp.policy_slots) as slot_elem
  ),
  candidate_employees as materialized (
    select
      m.app_user_id,
      m.employee_display_name,
      m.enabled,
      m.is_obligated,
      m.personnel_code,
      m.branch_id,
      m.branch_code,
      m.branch_display_name,
      m.branch_address,
      m.branch_latitude,
      m.branch_longitude,
      m.branch_active,
      m.branch_version,
      m.branch_valid_from,
      m.branch_valid_to,
      m.slot_profile_id,
      m.slot_profile_code,
      m.slot_profile_name,
      m.slot_profile_is_default,
      m.slot_assignment_id,
      m.slot_assignment_valid_from,
      m.slot_assignment_valid_to
    from month_candidate_users m
    where (p_employee_id is null or m.app_user_id = p_employee_id)
      and (
        p_branch_id is null
        or m.branch_id = p_branch_id
        or exists (
          select 1
          from public.attendance_checkins c
          where c.app_user_id = m.app_user_id
            and c.business_date between v_month_start and v_month_end
            and c.branch_id_used = p_branch_id
            and (
              v_scope_kind = 'all'
              or exists (
                select 1
                from user_scoped_days usd
                where usd.app_user_id = c.app_user_id
                  and usd.business_date = c.business_date
              )
            )
        )
      )
      and (
        v_escaped_search is null
        or lower(m.employee_display_name) like '%' || v_escaped_search || '%' escape '\'
        or lower(m.raw_display_name) like '%' || v_escaped_search || '%' escape '\'
        or lower(coalesce(m.personnel_code, '')) like '%' || v_escaped_search || '%' escape '\'
        or lower(coalesce(m.branch_code, '')) like '%' || v_escaped_search || '%' escape '\'
        or lower(coalesce(m.branch_display_name, '')) like '%' || v_escaped_search || '%' escape '\'
        or lower(coalesce(m.slot_profile_code, '')) like '%' || v_escaped_search || '%' escape '\'
        or lower(coalesce(m.slot_profile_name, '')) like '%' || v_escaped_search || '%' escape '\'
      )
  ),
  employee_day_scope as materialized (
    select
      ce.app_user_id,
      cal.business_date,
      cal.day_of_month,
      ce.is_obligated,
      (
        v_scope_kind = 'all'
        or exists (
          select 1
          from user_scoped_days usd
          where usd.app_user_id = ce.app_user_id
            and usd.business_date = cal.business_date
        )
      ) as is_in_scope
    from candidate_employees ce
    cross join month_calendar_days cal
  ),
  month_slot_assignments as materialized (
    select
      a.assignment_id,
      a.app_user_id,
      a.profile_id,
      a.valid_from,
      a.valid_to,
      a.assigned_at
    from public.attendance_slot_policy_assignments a
    join candidate_employees ce
      on ce.app_user_id = a.app_user_id
    where not a.superseded_same_day
      and a.valid_from <= v_month_end
      and (a.valid_to is null or a.valid_to >= v_month_start)
  ),
  employee_day_profile_ids as materialized (
    -- Out-of-scope days strictly use DEFAULT profile so custom profile assignments never leak.
    select
      eds.app_user_id,
      eds.business_date,
      eds.is_in_scope,
      eds.is_obligated,
      case
        when eds.is_in_scope then
          coalesce(
            (
              select msa.profile_id
              from month_slot_assignments msa
              where msa.app_user_id = eds.app_user_id
                and msa.valid_from <= eds.business_date
                and (msa.valid_to is null or eds.business_date <= msa.valid_to)
              order by msa.valid_from desc, msa.assigned_at desc, msa.assignment_id desc
              limit 1
            ),
            v_default_profile_id
          )
        else v_default_profile_id
      end as profile_id
    from employee_day_scope eds
  ),
  employee_day_policies as materialized (
    select
      edpi.app_user_id,
      pdp.business_date,
      pdp.day_of_month,
      edpi.is_in_scope,
      edpi.is_obligated,
      pdp.profile_id,
      pdp.profile_code,
      pdp.profile_name,
      pdp.is_default,
      pdp.policy_version,
      pdp.policy_slots
    from employee_day_profile_ids edpi
    join profile_day_policies pdp
      on pdp.profile_id = edpi.profile_id
     and pdp.business_date = edpi.business_date
  ),
  team_policy_with_bounds as materialized (
    select
      p as policy_row,
      p.profile_id,
      pr.is_default,
      pr.display_name as profile_name,
      pr.profile_code,
      p.version,
      p.effective_from_date,
      (
        lead(p.effective_from_date) over (
          partition by p.profile_id
          order by p.effective_from_date asc, p.version asc
        ) - 1
      ) as effective_to_date
    from public.attendance_slot_policy_versions p
    join public.attendance_slot_policy_profiles pr
      on pr.profile_id = p.profile_id
    where v_scope_kind <> 'all'
      and (
        pr.profile_id = v_default_profile_id
        or exists (
          select 1
          from employee_day_policies edp_tp
          where edp_tp.is_in_scope
            and edp_tp.profile_id = pr.profile_id
        )
      )
  ),
  team_default_month_versions as (
    select distinct on (tpb.version)
      tpb.*
    from month_calendar_days cal
    join lateral (
      select p2.*
      from team_policy_with_bounds p2
      where p2.profile_id = v_default_profile_id
      order by (p2.effective_from_date <= cal.business_date) desc, p2.effective_from_date desc, p2.version desc
      limit 1
    ) tpb on true
    where v_scope_kind <> 'all'
    order by tpb.version asc
  ),
  team_scoped_month_versions as (
    select
      tpb.*
    from team_policy_with_bounds tpb
    where v_scope_kind <> 'all'
      and exists (
        select 1
        from employee_day_policies edp_tv
        where edp_tv.is_in_scope
          and edp_tv.profile_id = tpb.profile_id
          and edp_tv.policy_version = tpb.version
      )
    union all
    select
      tdmv.*
    from team_default_month_versions tdmv
    where v_scope_kind <> 'all'
      and not exists (
        select 1
        from employee_day_policies edp_any
        where edp_any.is_in_scope
      )
  ),
  team_slot_policy_agg as (
    select
      case
        when v_scope_kind <> 'all' then
          jsonb_build_object(
            'current_policy', (
              select public.attendance__internal_format_slot_policy(
                tmv.policy_row,
                tmv.effective_to_date,
                null
              )
              from team_scoped_month_versions tmv
              order by
                tmv.is_default desc,
                (tmv.effective_from_date <= v_ref_date) desc,
                tmv.effective_from_date desc,
                tmv.version desc,
                lower(tmv.profile_name) asc,
                lower(tmv.profile_code) asc,
                tmv.profile_id asc
              limit 1
            ),
            'latest_policy', (
              select public.attendance__internal_format_slot_policy(
                tmv.policy_row,
                tmv.effective_to_date,
                null
              )
              from team_scoped_month_versions tmv
              order by
                tmv.is_default desc,
                tmv.version desc,
                tmv.effective_from_date desc,
                lower(tmv.profile_name) asc,
                lower(tmv.profile_code) asc,
                tmv.profile_id asc
              limit 1
            ),
            'month_policies', coalesce(
              (
                select jsonb_agg(
                  public.attendance__internal_format_slot_policy(
                    tmv.policy_row,
                    tmv.effective_to_date,
                    null
                  )
                  order by
                    tmv.is_default desc,
                    lower(tmv.profile_name) asc,
                    lower(tmv.profile_code) asc,
                    tmv.profile_id asc,
                    tmv.version asc
                )
                from team_scoped_month_versions tmv
              ),
              '[]'::jsonb
            )
          )
        else v_slot_policy
      end as slot_policy
  ),
  -- Strictly restrict check-ins, leaves, and explanations to is_in_scope days only.
  month_checkins_raw as materialized (
    select
      c.checkin_id,
      c.app_user_id,
      c.business_date,
      eds.is_obligated,
      c.sequence_in_day,
      c.captured_at,
      to_char(c.captured_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as captured_at_utc,
      to_char(c.captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as captured_at_local,
      to_char(c.captured_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI') as time_local,
      (
        extract(hour from (c.captured_at at time zone 'Asia/Ho_Chi_Minh'))::integer * 60
        + extract(minute from (c.captured_at at time zone 'Asia/Ho_Chi_Minh'))::integer
      ) as local_minute_of_day,
      c.time_verified,
      case
        when c.distance_status is not null then coalesce(c.distance_target_kind, case when c.branch_id_used is not null then 'BRANCH' else 'HQ' end)
        else 'HQ'
      end as distance_target_kind,
      c.branch_id_used,
      c.branch_code_used,
      c.branch_name_used,
      case
        when c.distance_status is not null then c.branch_version_used
        else null
      end as branch_version_used,
      case
        when c.distance_status is not null then c.hq_version_used
        when c.accuracy_meters <= 100000.0 then hq.version
        else null
      end as hq_version_used,
      case
        when c.distance_status is not null then c.distance_status
        when c.accuracy_meters > 100000.0 then 'INVALID_GPS'
        when hq.version is null then 'HQ_NOT_CONFIGURED'
        else 'COMPUTED'
      end as distance_status,
      case
        when c.distance_status is not null then c.distance_meters
        when c.accuracy_meters > 100000.0 or hq.version is null then null
        else round(
          (
            2.0 * 6371000.0 * asin(
              least(
                1.0::double precision,
                sqrt(
                  greatest(
                    0.0::double precision,
                    power(sin(radians(c.latitude - hq.latitude) / 2.0), 2)
                    + cos(radians(hq.latitude))
                      * cos(radians(c.latitude))
                      * power(sin(radians(c.longitude - hq.longitude) / 2.0), 2)
                  )
                )
              )
            )
          )::numeric,
          1
        )::double precision
      end as distance_meters
    from public.attendance_checkins c
    join employee_day_scope eds
      on eds.app_user_id = c.app_user_id
     and eds.business_date = c.business_date
     and eds.is_in_scope = true
    left join lateral (
      select
        r.version,
        r.latitude,
        r.longitude
      from public.attendance_hq_location_revisions r
      where c.distance_status is null
        and r.effective_from <= (
          case
            when c.time_verified then c.captured_at
            else c.received_at
          end
        )
      order by r.effective_from desc, r.version desc
      limit 1
    ) hq on true
    where c.business_date between v_month_start and v_month_end
  ),
  month_checkins_enriched as materialized (
    select distinct on (mcr.checkin_id)
      mcr.*,
      edp.profile_id as policy_profile_id,
      edp.profile_code as policy_profile_code,
      edp.profile_name as policy_profile_name,
      s.policy_version,
      s.slot_index as assigned_slot_index,
      s.slot_code as assigned_slot_code,
      s.target_time as assigned_slot_target_time,
      (mcr.local_minute_of_day - s.target_minute)::integer as delta_minutes,
      case
        when (mcr.local_minute_of_day - s.target_minute) < (-s.grace_before_minutes) then
          ((- (mcr.local_minute_of_day - s.target_minute)) - s.grace_before_minutes)::integer
        when (mcr.local_minute_of_day - s.target_minute) > s.grace_after_minutes then
          ((mcr.local_minute_of_day - s.target_minute) - s.grace_after_minutes)::integer
        else 0
      end as over_grace_minutes,
      case
        when (mcr.local_minute_of_day - s.target_minute) < (-s.grace_before_minutes) then 'EARLY'
        when (mcr.local_minute_of_day - s.target_minute) > s.grace_after_minutes then 'LATE'
        else 'ON_TIME'
      end as deviation_status
    from month_checkins_raw mcr
    join employee_day_policies edp
      on edp.app_user_id = mcr.app_user_id
     and edp.business_date = mcr.business_date
    join profile_day_slot_defs s
      on s.profile_id = edp.profile_id
     and s.business_date = mcr.business_date
    order by
      mcr.checkin_id,
      abs(mcr.local_minute_of_day - s.target_minute) asc,
      s.slot_index asc
  ),
  daily_slot_checkins as materialized (
    select
      mc.app_user_id,
      mc.business_date,
      mc.assigned_slot_index as slot_index,
      count(*)::integer as checkin_count,
      count(*) filter (where mc.deviation_status <> 'ON_TIME')::integer as out_of_grace_count,
      jsonb_agg(
        jsonb_build_object(
          'checkin_id', mc.checkin_id,
          'sequence_in_day', mc.sequence_in_day,
          'captured_at', mc.captured_at_utc,
          'captured_at_local', mc.captured_at_local,
          'time_local', mc.time_local,
          'time_verified', mc.time_verified,
          'assigned_slot_code', mc.assigned_slot_code,
          'delta_minutes', mc.delta_minutes,
          'over_grace_minutes', mc.over_grace_minutes,
          'deviation_status', mc.deviation_status,
          'distance_target_kind', mc.distance_target_kind,
          'distance_status', mc.distance_status,
          'distance_meters', mc.distance_meters
        )
        order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc
      ) as checkins
    from month_checkins_enriched mc
    group by mc.app_user_id, mc.business_date, mc.assigned_slot_index
  ),
  daily_checkins as materialized (
    select
      mc.app_user_id,
      mc.business_date,
      bool_or(mc.is_obligated) as is_obligated,
      count(*)::integer as checkin_count,
      count(*) filter (where mc.time_verified)::integer as verified_checkin_count,
      count(*) filter (where not mc.time_verified)::integer as unverified_checkin_count,
      count(*) filter (where mc.deviation_status <> 'ON_TIME')::integer as late_or_early_checkin_count,
      count(*) filter (where mc.distance_status = 'COMPUTED')::integer as distance_computed_count,
      count(*) filter (where mc.distance_status <> 'COMPUTED')::integer as distance_unavailable_count,
      (array_agg(mc.checkin_id order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as first_checkin_id,
      (array_agg(mc.checkin_id order by mc.captured_at desc, mc.sequence_in_day desc, mc.checkin_id desc))[1] as last_checkin_id,
      min(mc.captured_at) as first_captured_at,
      max(mc.captured_at) as last_captured_at,
      (array_agg(mc.distance_target_kind order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as distance_target_kind,
      (array_agg(mc.branch_id_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_id_used,
      (array_agg(mc.branch_code_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_code_used,
      (array_agg(mc.branch_name_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_name_used,
      (array_agg(mc.branch_version_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as branch_version_used,
      (array_agg(mc.hq_version_used order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as hq_version_used,
      (array_agg(mc.distance_status order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as distance_status,
      (array_agg(mc.distance_meters order by mc.captured_at asc, mc.sequence_in_day asc, mc.checkin_id asc))[1] as distance_meters,
      min(mc.distance_meters) as min_distance_meters,
      max(mc.distance_meters) as max_distance_meters
    from month_checkins_enriched mc
    group by mc.app_user_id, mc.business_date
  ),
  daily_leaves as materialized (
    select
      ld.app_user_id,
      ld.leave_date as business_date,
      bool_or(eds.is_obligated) as is_obligated,
      sum(ld.half_day_units)::integer as half_day_units,
      round((sum(ld.half_day_units)::numeric / 2.0), 1)::double precision as leave_units,
      bool_or(ld.session_code in ('FULL', 'AM')) as am_covered,
      bool_or(ld.session_code in ('FULL', 'PM')) as pm_covered,
      jsonb_agg(
        jsonb_build_object(
          'request_id', ld.request_id,
          'leave_date', ld.leave_date,
          'session_code', ld.session_code,
          'leave_type', ld.leave_type,
          'half_day_units', ld.half_day_units
        )
        order by
          case ld.session_code
            when 'FULL' then 1
            when 'AM' then 2
            when 'PM' then 3
            else 4
          end asc,
          ld.leave_type asc,
          ld.request_id asc
      ) as approved_leaves
    from public.leave_request_days ld
    join public.leave_requests lr
      on lr.request_id = ld.request_id
    join employee_day_scope eds
      on eds.app_user_id = ld.app_user_id
     and eds.business_date = ld.leave_date
     and eds.is_in_scope = true
    where lr.status = 'APPROVED'
      and ld.is_active = true
      and ld.leave_date between v_month_start and v_month_end
    group by ld.app_user_id, ld.leave_date
  ),
  daily_slot_explanations as materialized (
    select distinct on (ae.app_user_id, ae.business_date, ae.slot_code)
      ae.explanation_id,
      ae.app_user_id,
      ae.business_date,
      ae.slot_code,
      ae.slot_index,
      ae.original_slot_status,
      ae.reason,
      ae.status,
      ae.submitted_at,
      to_char(ae.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as submitted_at_utc,
      to_char(ae.submitted_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as submitted_at_local,
      ae.decided_at,
      case
        when ae.decided_at is not null then
          to_char(ae.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        else null
      end as decided_at_utc,
      case
        when ae.decided_at is not null then
          to_char(ae.decided_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
        else null
      end as decided_at_local,
      coalesce(dec_ident.employee_display_name, du.display_name) as decided_by_display_name,
      ae.decision_note,
      ae.row_version
    from public.attendance_explanations ae
    join employee_day_scope eds
      on eds.app_user_id = ae.app_user_id
     and eds.business_date = ae.business_date
     and eds.is_in_scope = true
    left join public.direct_entry_app_users du
      on du.app_user_id = ae.decided_by_app_user_id
    left join lateral public.attendance__internal_resolve_employee_identity(du.app_user_id) dec_ident
      on du.app_user_id is not null
    where ae.business_date between v_month_start and v_month_end
    order by
      ae.app_user_id asc,
      ae.business_date asc,
      ae.slot_code asc,
      case ae.status
        when 'APPROVED' then 1
        when 'PENDING' then 2
        else 3
      end asc,
      ae.submitted_at desc,
      ae.explanation_id desc
  ),
  employee_profile_names_agg as (
    select
      sub_p.app_user_id,
      jsonb_agg(sub_p.profile_name order by sub_p.first_date asc) as profile_names_in_month
    from (
      select
        edp_p.app_user_id,
        edp_p.profile_name,
        min(edp_p.business_date) as first_date
      from employee_day_policies edp_p
      where edp_p.is_in_scope = true
      group by edp_p.app_user_id, edp_p.profile_name
    ) sub_p
    group by sub_p.app_user_id
  ),
  employee_scoped_obligated_days as (
    select
      eds.app_user_id,
      count(*) filter (
        where eds.business_date < v_today_vn
          and eds.is_in_scope = true
          and eds.is_obligated = true
      )::integer as completed_obligated_scoped_days
    from employee_day_scope eds
    group by eds.app_user_id
  ),
  employee_checkins_agg as (
    select
      dc.app_user_id,
      count(*)::integer as checkin_day_count,
      coalesce(sum(dc.checkin_count), 0)::integer as total_checkins,
      coalesce(sum(dc.distance_computed_count), 0)::integer as distance_computed_count,
      coalesce(sum(dc.distance_unavailable_count), 0)::integer as distance_unavailable_count,
      min(dc.min_distance_meters) as min_distance_meters,
      max(dc.max_distance_meters) as max_distance_meters,
      count(*) filter (
        where dc.business_date < v_today_vn
          and dc.is_obligated = true
          and dc.checkin_count > 0
      )::integer as elapsed_checkin_day_count
    from daily_checkins dc
    group by dc.app_user_id
  ),
  employee_leaves_agg as (
    select
      dl.app_user_id,
      count(*)::integer as approved_leave_day_count,
      coalesce(round((sum(dl.half_day_units)::numeric / 2.0), 1)::double precision, 0.0::double precision) as approved_leave_units,
      count(*) filter (
        where dl.business_date < v_today_vn
          and dl.is_obligated = true
          and dl.leave_units > 0
      )::integer as elapsed_leave_day_count
    from daily_leaves dl
    group by dl.app_user_id
  ),
  employee_overlap_agg as (
    select
      dc.app_user_id,
      count(*)::integer as overlap_day_count,
      count(*) filter (
        where dc.business_date < v_today_vn
          and dc.is_obligated = true
          and dc.checkin_count > 0
          and dl.leave_units > 0
      )::integer as elapsed_overlap_day_count
    from daily_checkins dc
    join daily_leaves dl
      on dl.app_user_id = dc.app_user_id
     and dl.business_date = dc.business_date
    group by dc.app_user_id
  ),
  employee_rollup as materialized (
    select
      ce.app_user_id,
      ce.employee_display_name,
      ce.personnel_code,
      ce.enabled,
      ce.branch_id,
      ce.branch_code,
      ce.branch_display_name,
      ce.branch_address,
      ce.branch_latitude,
      ce.branch_longitude,
      ce.branch_active,
      ce.branch_version,
      ce.branch_valid_from,
      ce.branch_valid_to,
      ce.slot_profile_id,
      ce.slot_profile_code,
      ce.slot_profile_name,
      ce.slot_profile_is_default,
      ce.slot_assignment_id,
      ce.slot_assignment_valid_from,
      ce.slot_assignment_valid_to,
      coalesce(prof_names.profile_names_in_month, jsonb_build_array(ce.slot_profile_name)) as profile_names_in_month,
      coalesce(chk.checkin_day_count, 0) as checkin_day_count,
      coalesce(chk.total_checkins, 0) as total_checkins,
      coalesce(chk.distance_computed_count, 0) as distance_computed_count,
      coalesce(chk.distance_unavailable_count, 0) as distance_unavailable_count,
      chk.min_distance_meters,
      chk.max_distance_meters,
      coalesce(lv.approved_leave_day_count, 0) as approved_leave_day_count,
      coalesce(lv.approved_leave_units, 0.0::double precision) as approved_leave_units,
      coalesce(both_days.overlap_day_count, 0) as checkin_and_leave_day_count,
      greatest(
        0,
        coalesce(esod.completed_obligated_scoped_days, 0) - coalesce(chk.elapsed_checkin_day_count, 0)
      )::integer as no_checkin_day_count,
      greatest(
        0,
        coalesce(esod.completed_obligated_scoped_days, 0)
        - coalesce(chk.elapsed_checkin_day_count, 0)
        - (coalesce(lv.elapsed_leave_day_count, 0) - coalesce(both_days.elapsed_overlap_day_count, 0))
      )::integer as no_checkin_without_leave_day_count
    from candidate_employees ce
    left join employee_scoped_obligated_days esod
      on esod.app_user_id = ce.app_user_id
    left join employee_profile_names_agg prof_names
      on prof_names.app_user_id = ce.app_user_id
    left join employee_checkins_agg chk
      on chk.app_user_id = ce.app_user_id
    left join employee_leaves_agg lv
      on lv.app_user_id = ce.app_user_id
    left join employee_overlap_agg both_days
      on both_days.app_user_id = ce.app_user_id
  ),
  agg as (
    select
      count(*)::integer as total_employees,
      count(*) filter (where er.checkin_day_count > 0)::integer as employees_with_checkins,
      count(*) filter (where er.approved_leave_day_count > 0)::integer as employees_with_approved_leave,
      coalesce(sum(er.total_checkins), 0)::integer as total_checkins,
      coalesce(sum(er.checkin_day_count), 0)::integer as total_checkin_days,
      coalesce(sum(er.approved_leave_day_count), 0)::integer as total_approved_leave_days,
      coalesce(round(sum(er.approved_leave_units)::numeric, 1)::double precision, 0.0::double precision) as total_approved_leave_units,
      coalesce(sum(er.no_checkin_day_count), 0)::integer as total_no_checkin_days,
      coalesce(sum(er.no_checkin_without_leave_day_count), 0)::integer as total_no_checkin_without_leave_days,
      pg_catalog.md5(
        case
          when v_scope_kind <> 'all' then
            v_scope_kind
            || ':t=' || coalesce(pg_catalog.array_to_string(v_scope_team_ids, ','), '')
            || ';d=' || coalesce(pg_catalog.array_to_string(v_scope_department_ids, ','), '')
            || '|'
          else ''
        end
        || coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'u', er2.app_user_id,
                'n', er2.employee_display_name,
                'p', er2.personnel_code,
                'e', er2.enabled,
                'b', er2.branch_id,
                'bc', er2.branch_code,
                'bn', er2.branch_display_name,
                'ba', er2.branch_address,
                'blat', er2.branch_latitude,
                'blon', er2.branch_longitude,
                'bact', er2.branch_active,
                'bv', er2.branch_version,
                'bf', er2.branch_valid_from,
                'bt', er2.branch_valid_to,
                'sp', er2.slot_profile_id,
                'spc', er2.slot_profile_code,
                'spn', er2.slot_profile_name,
                'cd', er2.checkin_day_count,
                'tc', er2.total_checkins,
                'dc', er2.distance_computed_count,
                'du', er2.distance_unavailable_count,
                'dmin', er2.min_distance_meters,
                'dmax', er2.max_distance_meters,
                'ld', er2.approved_leave_day_count,
                'lu', er2.approved_leave_units,
                'ov', er2.checkin_and_leave_day_count,
                'nc', er2.no_checkin_day_count,
                'ncw', er2.no_checkin_without_leave_day_count
              )
              order by
                lower(er2.employee_display_name) asc,
                coalesce(er2.personnel_code, '') asc,
                er2.app_user_id asc
            )::text
            from employee_rollup er2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', mc2.checkin_id,
                'u', mc2.app_user_id,
                'd', mc2.business_date,
                'seq', mc2.sequence_in_day,
                't', mc2.captured_at_utc,
                'v', mc2.time_verified,
                'pr', mc2.policy_profile_id,
                's', mc2.assigned_slot_code,
                'dm', mc2.delta_minutes,
                'og', mc2.over_grace_minutes,
                'dv', mc2.deviation_status,
                'k', mc2.distance_target_kind,
                'bi', mc2.branch_id_used,
                'bv', mc2.branch_version_used,
                'hv', mc2.hq_version_used,
                'ds', mc2.distance_status,
                'dist', mc2.distance_meters
              )
              order by mc2.app_user_id asc, mc2.business_date asc, mc2.captured_at asc, mc2.sequence_in_day asc, mc2.checkin_id asc
            )::text
            from month_checkins_enriched mc2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'u', dl2.app_user_id,
                'd', dl2.business_date,
                'h', dl2.half_day_units,
                'l', dl2.approved_leaves
              )
              order by dl2.app_user_id asc, dl2.business_date asc
            )::text
            from daily_leaves dl2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'u', edp2.app_user_id,
                'd', edp2.business_date,
                'sc', edp2.is_in_scope,
                'ob', edp2.is_obligated,
                'pr', edp2.profile_id,
                'pv', edp2.policy_version,
                'sl', edp2.policy_slots
              )
              order by edp2.app_user_id asc, edp2.business_date asc
            )::text
            from employee_day_policies edp2
          ),
          '[]'
        )
        || '|' ||
        coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'id', dse2.explanation_id,
                'u', dse2.app_user_id,
                'd', dse2.business_date,
                'sc', dse2.slot_code,
                'st', dse2.status,
                'rv', dse2.row_version
              )
              order by dse2.app_user_id asc, dse2.business_date asc, dse2.slot_code asc
            )::text
            from daily_slot_explanations dse2
          ),
          '[]'
        )
        || '|' || coalesce(
          (
            select pg_catalog.jsonb_agg(
              pg_catalog.jsonb_build_object(
                'pr', mds2.profile_id,
                'd', mds2.business_date,
                'sc', mds2.slot_code,
                'due', mds2.is_due
              )
              order by mds2.profile_id asc, mds2.business_date asc, mds2.slot_index asc
            )::text
            from profile_day_slot_defs mds2
            where v_scope_kind = 'all'
               or exists (
                 select 1
                 from employee_day_policies edp_s
                 where edp_s.is_in_scope
                   and edp_s.profile_id = mds2.profile_id
               )
          ),
          '[]'
        )
      ) as snapshot_token
    from employee_rollup er
  ),
  paged_employees as materialized (
    select er.*
    from employee_rollup er
    order by
      lower(er.employee_display_name) asc,
      coalesce(er.personnel_code, '') asc,
      er.app_user_id asc
    limit v_page_size
    offset v_offset
  ),
  paged_employee_day_policies as materialized (
    select edp.*
    from employee_day_policies edp
    join paged_employees pe
      on pe.app_user_id = edp.app_user_id
  ),
  paged_day_slots as materialized (
    select
      edp.app_user_id,
      edp.business_date,
      count(*) filter (
        where edp.is_in_scope = true
          and edp.is_obligated = true
          and mds.is_due
          and coalesce(dsc.checkin_count, 0) = 0
          and not (
            case
              when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
              else coalesce(dl.pm_covered, false)
            end
          )
          and coalesce(dse.status, '') <> 'APPROVED'
      )::integer as missing_slot_count,
      coalesce(
        sum(dsc.out_of_grace_count) filter (
          where edp.is_in_scope = true
            and coalesce(dse.status, '') <> 'APPROVED'
        ),
        0
      )::integer as late_or_early_checkin_count,
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'slot_code', mds.slot_code,
            'slot_index', mds.slot_index,
            'slot_label', mds.slot_label,
            'session_code', mds.session_code,
            'target_time', mds.target_time,
            'grace_before_minutes', mds.grace_before_minutes,
            'grace_after_minutes', mds.grace_after_minutes,
            'is_leave_covered', case
              when not edp.is_in_scope then false
              when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
              else coalesce(dl.pm_covered, false)
            end,
            'slot_status', case
              when not edp.is_in_scope then 'UPCOMING'
              when dse.status = 'APPROVED' and (
                (coalesce(dsc.checkin_count, 0) > 0 and coalesce(dsc.out_of_grace_count, 0) > 0)
                or (
                  coalesce(dsc.checkin_count, 0) = 0
                  and not (
                    case
                      when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
                      else coalesce(dl.pm_covered, false)
                    end
                  )
                )
              ) then 'EXPLAINED_APPROVED'
              when coalesce(dsc.checkin_count, 0) > 0 and coalesce(dsc.out_of_grace_count, 0) > 0 then 'OUT_OF_GRACE'
              when coalesce(dsc.checkin_count, 0) > 0 then 'ON_TIME'
              when (
                case
                  when mds.session_code = 'AM' then coalesce(dl.am_covered, false)
                  else coalesce(dl.pm_covered, false)
                end
              ) then 'LEAVE_COVERED'
              when not edp.is_obligated then 'UPCOMING'
              when not mds.is_due then 'UPCOMING'
              else 'MISSING'
            end,
            'checkins', case
              when edp.is_in_scope then coalesce(dsc.checkins, '[]'::jsonb)
              else '[]'::jsonb
            end,
            'explanation', case
              when edp.is_in_scope and dse.explanation_id is not null then
                jsonb_build_object(
                  'explanation_id', dse.explanation_id,
                  'status', dse.status,
                  'original_slot_status', dse.original_slot_status,
                  'reason', dse.reason,
                  'submitted_at', dse.submitted_at_utc,
                  'submitted_at_local', dse.submitted_at_local,
                  'decided_at', dse.decided_at_utc,
                  'decided_at_local', dse.decided_at_local,
                  'decided_by_display_name', dse.decided_by_display_name,
                  'decision_note', dse.decision_note,
                  'row_version', dse.row_version
                )
              else null
            end
          )
          order by mds.slot_index asc
        ),
        '[]'::jsonb
      ) as slots
    from paged_employee_day_policies edp
    join profile_day_slot_defs mds
      on mds.profile_id = edp.profile_id
     and mds.business_date = edp.business_date
    left join daily_leaves dl
      on dl.app_user_id = edp.app_user_id
     and dl.business_date = edp.business_date
    left join daily_slot_checkins dsc
      on dsc.app_user_id = edp.app_user_id
     and dsc.business_date = edp.business_date
     and dsc.slot_index = mds.slot_index
    left join daily_slot_explanations dse
      on dse.app_user_id = edp.app_user_id
     and dse.business_date = edp.business_date
     and dse.slot_code = mds.slot_code
    group by edp.app_user_id, edp.business_date
  ),
  paged_days_agg as materialized (
    select
      edp.app_user_id,
      jsonb_agg(
        jsonb_build_object(
          'business_date', edp.business_date,
          'day_of_month', edp.day_of_month,
          'policy_profile_id_used', edp.profile_id,
          'policy_profile_code_used', edp.profile_code,
          'policy_profile_name_used', edp.profile_name,
          'policy_is_default_used', edp.is_default,
          'policy_version_used', edp.policy_version,
          'has_checkin', (edp.is_in_scope and dc.checkin_count is not null and dc.checkin_count > 0),
          'checkin_count', case when edp.is_in_scope then coalesce(dc.checkin_count, 0) else 0 end,
          'first_checkin_id', case when edp.is_in_scope then dc.first_checkin_id else null end,
          'last_checkin_id', case when edp.is_in_scope then dc.last_checkin_id else null end,
          'first_captured_at', case when edp.is_in_scope then dc.first_captured_at else null end,
          'first_captured_at_local', case
            when edp.is_in_scope and dc.first_captured_at is not null then
              to_char(dc.first_captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
            else null
          end,
          'first_time_local', case
            when edp.is_in_scope and dc.first_captured_at is not null then
              to_char(dc.first_captured_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI')
            else null
          end,
          'last_captured_at', case when edp.is_in_scope then dc.last_captured_at else null end,
          'last_captured_at_local', case
            when edp.is_in_scope and dc.last_captured_at is not null then
              to_char(dc.last_captured_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS')
            else null
          end,
          'last_time_local', case
            when edp.is_in_scope and dc.last_captured_at is not null then
              to_char(dc.last_captured_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI')
            else null
          end,
          'verified_checkin_count', case when edp.is_in_scope then coalesce(dc.verified_checkin_count, 0) else 0 end,
          'unverified_checkin_count', case when edp.is_in_scope then coalesce(dc.unverified_checkin_count, 0) else 0 end,
          'distance_target_kind', case when edp.is_in_scope then dc.distance_target_kind else null end,
          'branch_id_used', case when edp.is_in_scope then dc.branch_id_used else null end,
          'branch_code_used', case when edp.is_in_scope then dc.branch_code_used else null end,
          'branch_name_used', case when edp.is_in_scope then dc.branch_name_used else null end,
          'branch_version_used', case when edp.is_in_scope then dc.branch_version_used else null end,
          'hq_version_used', case when edp.is_in_scope then dc.hq_version_used else null end,
          'distance_status', case when edp.is_in_scope then dc.distance_status else null end,
          'distance_meters', case when edp.is_in_scope then dc.distance_meters else null end,
          'min_distance_meters', case when edp.is_in_scope then dc.min_distance_meters else null end,
          'max_distance_meters', case when edp.is_in_scope then dc.max_distance_meters else null end,
          'has_approved_leave', (edp.is_in_scope and dl.leave_units is not null and dl.leave_units > 0),
          'approved_leave_units', case when edp.is_in_scope then coalesce(dl.leave_units, 0.0::double precision) else 0.0::double precision end,
          'approved_leaves', case when edp.is_in_scope then coalesce(dl.approved_leaves, '[]'::jsonb) else '[]'::jsonb end,
          'day_status', case
            when not edp.is_in_scope then 'UPCOMING'
            when dc.checkin_count is not null and dc.checkin_count > 0
                 and dl.leave_units is not null and dl.leave_units > 0 then 'CHECKED_IN_AND_LEAVE'
            when dc.checkin_count is not null and dc.checkin_count > 0 then 'CHECKED_IN'
            when dl.leave_units is not null and dl.leave_units > 0 then 'APPROVED_LEAVE'
            when coalesce(day_slots.missing_slot_count, 0) > 0 then 'NO_CHECKIN'
            else 'UPCOMING'
          end,
          'missing_slot_count', case when edp.is_in_scope then coalesce(day_slots.missing_slot_count, 0) else 0 end,
          'late_or_early_checkin_count', case when edp.is_in_scope then coalesce(day_slots.late_or_early_checkin_count, 0) else 0 end,
          'slots', coalesce(day_slots.slots, '[]'::jsonb)
        )
        order by edp.business_date asc
      ) as days
    from paged_employee_day_policies edp
    left join daily_checkins dc
      on dc.app_user_id = edp.app_user_id
     and dc.business_date = edp.business_date
    left join daily_leaves dl
      on dl.app_user_id = edp.app_user_id
     and dl.business_date = edp.business_date
    left join paged_day_slots day_slots
      on day_slots.app_user_id = edp.app_user_id
     and day_slots.business_date = edp.business_date
    group by edp.app_user_id
  ),
  paged_with_days as (
    select
      pe.*,
      coalesce(pda.days, '[]'::jsonb) as days
    from paged_employees pe
    left join paged_days_agg pda
      on pda.app_user_id = pe.app_user_id
  )
  select
    boa.branch_options,
    eoa.employee_options,
    tspa.slot_policy,
    a.total_employees,
    a.snapshot_token,
    jsonb_build_object(
      'total_employees', a.total_employees,
      'employees_with_checkins', a.employees_with_checkins,
      'employees_with_approved_leave', a.employees_with_approved_leave,
      'total_checkins', a.total_checkins,
      'total_checkin_days', a.total_checkin_days,
      'total_approved_leave_days', a.total_approved_leave_days,
      'total_approved_leave_units', a.total_approved_leave_units,
      'total_no_checkin_days', a.total_no_checkin_days,
      'total_no_checkin_without_leave_days', a.total_no_checkin_without_leave_days
    ),
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'app_user_id', pwd.app_user_id,
            'employee_display_name', pwd.employee_display_name,
            'personnel_code', pwd.personnel_code,
            'enabled', pwd.enabled,
            'branch', case
              when pwd.branch_id is not null then
                jsonb_build_object(
                  'branch_id', pwd.branch_id,
                  'branch_code', pwd.branch_code,
                  'display_name', pwd.branch_display_name,
                  'address', pwd.branch_address,
                  'latitude', pwd.branch_latitude,
                  'longitude', pwd.branch_longitude,
                  'active', pwd.branch_active,
                  'version', pwd.branch_version,
                  'valid_from', pwd.branch_valid_from,
                  'valid_to', pwd.branch_valid_to
                )
              else null
            end,
            'slot_policy_profile', jsonb_build_object(
              'profile_id', pwd.slot_profile_id,
              'profile_code', pwd.slot_profile_code,
              'display_name', pwd.slot_profile_name,
              'is_default', pwd.slot_profile_is_default,
              'assignment_id', pwd.slot_assignment_id,
              'valid_from', pwd.slot_assignment_valid_from,
              'valid_to', pwd.slot_assignment_valid_to,
              'profile_names_in_month', pwd.profile_names_in_month
            ),
            'summary', jsonb_build_object(
              'checkin_day_count', pwd.checkin_day_count,
              'total_checkins', pwd.total_checkins,
              'approved_leave_day_count', pwd.approved_leave_day_count,
              'approved_leave_units', pwd.approved_leave_units,
              'checkin_and_leave_day_count', pwd.checkin_and_leave_day_count,
              'no_checkin_day_count', pwd.no_checkin_day_count,
              'no_checkin_without_leave_day_count', pwd.no_checkin_without_leave_day_count,
              'distance_computed_count', pwd.distance_computed_count,
              'distance_unavailable_count', pwd.distance_unavailable_count,
              'min_distance_meters', pwd.min_distance_meters,
              'max_distance_meters', pwd.max_distance_meters
            ),
            'days', pwd.days
          )
          order by
            lower(pwd.employee_display_name) asc,
            coalesce(pwd.personnel_code, '') asc,
            pwd.app_user_id asc
        )
        from paged_with_days pwd
      ),
      '[]'::jsonb
    )
  into v_branch_options, v_employee_options, v_slot_policy, v_total_rows, v_snapshot_token, v_overview, v_items
  from agg a
  cross join branch_options_agg boa
  cross join employee_options_agg eoa
  cross join team_slot_policy_agg tspa;

  v_total_pages := case
    when v_total_rows = 0 then 0
    else ceil(v_total_rows::numeric / v_page_size::numeric)::integer
  end;

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_configure_hq', v_can_configure_hq,
      'can_manage_branches', v_can_configure_hq,
      'can_manage_slot_policy', v_can_configure_hq
    ),
    'filters', jsonb_build_object(
      'year_month', v_year_month,
      'from_date', v_month_start,
      'to_date', v_month_end,
      'branch_id', p_branch_id,
      'employee_id', p_employee_id,
      'search', v_search,
      'timezone', 'Asia/Ho_Chi_Minh'
    ),
    'days_in_month', v_days_in_month,
    'calendar_days', v_calendar_days,
    'current_hq', v_current_hq,
    'slot_policy', v_slot_policy,
    'branch_options', v_branch_options,
    'employee_options', v_employee_options,
    'overview', v_overview,
    'pagination', jsonb_build_object(
      'page', v_page,
      'page_size', v_page_size,
      'total_rows', v_total_rows,
      'total_pages', v_total_pages,
      'has_more', (v_page < v_total_pages),
      'snapshot_token', v_snapshot_token
    ),
    'items', v_items
  );
end;
$function$;

revoke all on function public.attendance_monthly_matrix_report(
  uuid, uuid, text, uuid, uuid, text, integer, integer
) from public, anon, authenticated, service_role;
grant execute on function public.attendance_monthly_matrix_report(
  uuid, uuid, text, uuid, uuid, text, integer, integer
) to service_role;

-- -----------------------------------------------------------------------------
-- 11. D-WP7B-03: Exclude Non-Employee Special Accounts from Branch & Slot Policy
--     Dropdowns and New Assignments (Existing Assignments Kept for History/Unassign)
-- -----------------------------------------------------------------------------
create or replace function public.attendance_list_branches_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_include_inactive boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_can_manage boolean;
  v_include_inactive boolean := coalesce(p_include_inactive, true);
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today_vn date := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
  v_branches jsonb;
  v_assignments jsonb;
  v_employee_options jsonb;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'branch_id', b.branch_id,
        'branch_code', b.branch_code,
        'display_name', b.display_name,
        'address', b.address,
        'latitude', b.latitude,
        'longitude', b.longitude,
        'active', b.active,
        'version', b.version,
        'active_assignment_count', coalesce(cnt.active_count, 0),
        'created_at', b.created_at,
        'updated_at', b.updated_at,
        'updated_by_display_name', coalesce(ident.employee_display_name, u.display_name)
      )
      order by b.branch_code asc, b.branch_id asc
    ),
    '[]'::jsonb
  )
    into v_branches
  from public.attendance_branches b
  join public.direct_entry_app_users u
    on u.app_user_id = b.updated_by_user_id
  left join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident on true
  left join lateral (
    select count(*)::integer as active_count
    from public.attendance_branch_assignments a
    where a.branch_id = b.branch_id
      and a.valid_from <= v_today_vn
      and (a.valid_to is null or v_today_vn <= a.valid_to)
  ) cnt on true
  where v_include_inactive or b.active = true;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'assignment_id', a.assignment_id,
        'app_user_id', a.app_user_id,
        'employee_display_name', ident.employee_display_name,
        'personnel_code', ident.personnel_code,
        'branch_id', a.branch_id,
        'branch_code', b.branch_code,
        'branch_name', b.display_name,
        'valid_from', a.valid_from,
        'valid_to', a.valid_to,
        'effective', (
          a.valid_from <= v_today_vn
          and (a.valid_to is null or v_today_vn <= a.valid_to)
          and b.active = true
        ),
        'version', a.version,
        'created_at', a.created_at,
        'updated_at', a.updated_at
      )
      order by
        (a.valid_to is null) desc,
        a.valid_from desc,
        lower(ident.employee_display_name) asc,
        a.assignment_id asc
    ),
    '[]'::jsonb
  )
    into v_assignments
  from public.attendance_branch_assignments a
  join public.attendance_branches b
    on b.branch_id = a.branch_id
  join public.direct_entry_app_users emp
    on emp.app_user_id = a.app_user_id
  cross join lateral public.attendance__internal_resolve_employee_identity(emp.app_user_id) ident
  where v_include_inactive or a.valid_to is null;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'app_user_id', u.app_user_id,
        'display_name', ident.employee_display_name,
        'personnel_code', ident.personnel_code,
        'enabled', u.enabled
      )
      order by lower(ident.employee_display_name) asc, u.app_user_id asc
    ),
    '[]'::jsonb
  )
    into v_employee_options
  from public.direct_entry_app_users u
  cross join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident
  where u.enabled = true
    and not public.attendance__internal_is_non_employee_account(u.app_user_id, v_now);

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_manage_branches', v_can_manage
    ),
    'business_date', v_today_vn,
    'include_inactive', v_include_inactive,
    'branches', v_branches,
    'assignments', v_assignments,
    'employee_options', v_employee_options
  );
end;
$function$;

revoke all on function public.attendance_list_branches_admin(uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_list_branches_admin(uuid, uuid, boolean)
  to service_role;

create or replace function public.attendance_assign_employee_branch_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_branch_id uuid,
  p_valid_from date,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_can_manage boolean;
  v_existing public.attendance_branch_assignments%rowtype;
  v_branch public.attendance_branches%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today_vn date := coalesce(
    nullif(current_setting('direct_entry.test_authorization_date', true), '')::date,
    (v_now at time zone 'Asia/Ho_Chi_Minh')::date
  );
  v_valid_from date := coalesce(p_valid_from, v_today_vn);
  v_inserted public.attendance_branch_assignments%rowtype;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if not v_can_manage then
    raise exception 'ATTENDANCE_BRANCH_WRITE_DENIED'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  if p_target_app_user_id is null
     or p_branch_id is null
     or p_expected_version is null
     or p_expected_version < 1 then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_branch_assignments_user'),
    hashtext(p_target_app_user_id::text)
  );

  select *
    into v_existing
  from public.attendance_branch_assignments a
  where a.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;

    select *
      into v_branch
    from public.attendance_branches b
    where b.branch_id = v_existing.branch_id;

    return jsonb_build_object(
      'replayed', true,
      'assignment', jsonb_build_object(
        'assignment_id', v_existing.assignment_id,
        'app_user_id', v_existing.app_user_id,
        'branch_id', v_existing.branch_id,
        'branch_code', v_branch.branch_code,
        'branch_name', v_branch.display_name,
        'valid_from', v_existing.valid_from,
        'valid_to', v_existing.valid_to,
        'version', v_existing.version
      )
    );
  end if;

  if v_valid_from > v_today_vn then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE'
      using errcode = '22023';
  end if;

  if v_valid_from < v_today_vn then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_PAST_DATE'
      using errcode = '22023';
  end if;

  select *
    into v_target_user
  from public.direct_entry_app_users u
  where u.app_user_id = p_target_app_user_id
  for share;

  if not found
     or v_target_user.enabled is distinct from true
     or public.attendance__internal_is_non_employee_account(p_target_app_user_id, v_now) then
    raise exception 'ATTENDANCE_BRANCH_TARGET_USER_INVALID'
      using errcode = '22023';
  end if;

  select *
    into v_branch
  from public.attendance_branches b
  where b.branch_id = p_branch_id
  for share;

  if not found then
    raise exception 'ATTENDANCE_BRANCH_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_branch.version <> p_expected_version then
    raise exception 'ATTENDANCE_BRANCH_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if not v_branch.active then
    raise exception 'ATTENDANCE_BRANCH_INACTIVE'
      using errcode = '22023';
  end if;

  insert into public.attendance_branch_assignments (
    app_user_id,
    branch_id,
    valid_from,
    valid_to,
    version,
    assigned_by_user_id,
    idempotency_key,
    request_fingerprint
  )
  values (
    p_target_app_user_id,
    p_branch_id,
    v_valid_from,
    null,
    1,
    p_app_user_id,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  return jsonb_build_object(
    'replayed', false,
    'assignment', jsonb_build_object(
      'assignment_id', v_inserted.assignment_id,
      'app_user_id', v_inserted.app_user_id,
      'branch_id', v_inserted.branch_id,
      'branch_code', v_branch.branch_code,
      'branch_name', v_branch.display_name,
      'valid_from', v_inserted.valid_from,
      'valid_to', v_inserted.valid_to,
      'version', v_inserted.version
    )
  );
end;
$function$;

revoke all on function public.attendance_assign_employee_branch_admin(
  uuid, uuid, uuid, uuid, date, integer, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.attendance_assign_employee_branch_admin(
  uuid, uuid, uuid, uuid, date, integer, uuid, text
) to service_role;

create or replace function public.attendance_get_slot_policies_admin(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_default_profile_id constant uuid := '00000000-0000-4000-8000-000000000001'::uuid;
  v_can_manage boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today_vn date := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
  v_default_profile public.attendance_slot_policy_profiles%rowtype;
  v_current_policy jsonb;
  v_latest_policy jsonb;
  v_versions jsonb;
  v_profiles jsonb;
  v_assignments jsonb;
  v_employee_options jsonb;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  select pr.*
    into v_default_profile
  from public.attendance_slot_policy_profiles pr
  where pr.profile_id = v_default_profile_id;

  with policy_with_bounds as (
    select
      p as policy_row,
      p.profile_id,
      p.version,
      p.effective_from_date,
      (
        lead(p.effective_from_date) over (
          partition by p.profile_id
          order by p.effective_from_date asc, p.version asc
        ) - 1
      ) as effective_to_date,
      coalesce(ident.employee_display_name, u.display_name) as actor_display_name
    from public.attendance_slot_policy_versions p
    left join public.direct_entry_app_users u
      on u.app_user_id = p.configured_by_user_id
    left join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident
      on u.app_user_id is not null
  )
  select
    (
      select public.attendance__internal_format_slot_policy(
        pb.policy_row,
        pb.effective_to_date,
        pb.actor_display_name
      )
      from policy_with_bounds pb
      where pb.profile_id = v_default_profile_id
      order by (pb.effective_from_date <= v_today_vn) desc, pb.effective_from_date desc, pb.version desc
      limit 1
    ),
    (
      select public.attendance__internal_format_slot_policy(
        pb.policy_row,
        pb.effective_to_date,
        pb.actor_display_name
      )
      from policy_with_bounds pb
      where pb.profile_id = v_default_profile_id
      order by pb.version desc
      limit 1
    ),
    coalesce(
      (
        select jsonb_agg(
          public.attendance__internal_format_slot_policy(
            pb.policy_row,
            pb.effective_to_date,
            pb.actor_display_name
          )
          order by pb.version desc
        )
        from policy_with_bounds pb
        where pb.profile_id = v_default_profile_id
      ),
      '[]'::jsonb
    ),
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'profile_id', pr.profile_id,
            'profile_code', pr.profile_code,
            'display_name', pr.display_name,
            'description', pr.description,
            'is_default', pr.is_default,
            'active', pr.active,
            'version', pr.version,
            'active_assignment_count', coalesce((
              select count(*)::integer
              from public.attendance_slot_policy_assignments a
              where a.profile_id = pr.profile_id
                and not a.superseded_same_day
                and a.valid_from <= v_today_vn
                and (a.valid_to is null or v_today_vn <= a.valid_to)
            ), 0),
            'current_policy', (
              select public.attendance__internal_format_slot_policy(
                pb_cur.policy_row,
                pb_cur.effective_to_date,
                pb_cur.actor_display_name
              )
              from policy_with_bounds pb_cur
              where pb_cur.profile_id = pr.profile_id
              order by (pb_cur.effective_from_date <= v_today_vn) desc, pb_cur.effective_from_date desc, pb_cur.version desc
              limit 1
            ),
            'latest_policy', (
              select public.attendance__internal_format_slot_policy(
                pb_lat.policy_row,
                pb_lat.effective_to_date,
                pb_lat.actor_display_name
              )
              from policy_with_bounds pb_lat
              where pb_lat.profile_id = pr.profile_id
              order by pb_lat.version desc
              limit 1
            ),
            'versions', coalesce((
              select jsonb_agg(
                public.attendance__internal_format_slot_policy(
                  pb_all.policy_row,
                  pb_all.effective_to_date,
                  pb_all.actor_display_name
                )
                order by pb_all.version desc
              )
              from policy_with_bounds pb_all
              where pb_all.profile_id = pr.profile_id
            ), '[]'::jsonb)
          )
          order by
            pr.is_default desc,
            pr.active desc,
            lower(pr.display_name) asc,
            lower(pr.profile_code) asc,
            pr.profile_id asc
        )
        from public.attendance_slot_policy_profiles pr
      ),
      '[]'::jsonb
    )
  into v_current_policy, v_latest_policy, v_versions, v_profiles;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'assignment_id', a.assignment_id,
        'app_user_id', a.app_user_id,
        'employee_display_name', ident.employee_display_name,
        'personnel_code', ident.personnel_code,
        'enabled', u.enabled,
        'profile_id', pr.profile_id,
        'profile_code', pr.profile_code,
        'profile_name', pr.display_name,
        'valid_from', pg_catalog.to_char(a.valid_from, 'YYYY-MM-DD'),
        'valid_to', case when a.valid_to is null then null else pg_catalog.to_char(a.valid_to, 'YYYY-MM-DD') end,
        'superseded_same_day', a.superseded_same_day,
        'effective', (
          not a.superseded_same_day
          and a.valid_from <= v_today_vn
          and (a.valid_to is null or v_today_vn <= a.valid_to)
          and pr.active = true
        ),
        'version', a.version,
        'created_at', pg_catalog.to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updated_at', pg_catalog.to_char(a.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
      order by
        (
          not a.superseded_same_day
          and a.valid_from <= v_today_vn
          and (a.valid_to is null or v_today_vn <= a.valid_to)
        ) desc,
        lower(ident.employee_display_name) asc,
        a.valid_from desc,
        a.assigned_at desc,
        a.assignment_id desc
    ),
    '[]'::jsonb
  )
    into v_assignments
  from public.attendance_slot_policy_assignments a
  join public.attendance_slot_policy_profiles pr
    on pr.profile_id = a.profile_id
  join public.direct_entry_app_users u
    on u.app_user_id = a.app_user_id
  cross join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'app_user_id', u.app_user_id,
        'display_name', ident.employee_display_name,
        'employee_display_name', ident.employee_display_name,
        'personnel_code', ident.personnel_code,
        'enabled', u.enabled,
        'current_profile_id', coalesce(cur_a.profile_id, v_default_profile.profile_id),
        'current_profile_code', coalesce(cur_a.profile_code, v_default_profile.profile_code),
        'current_profile_name', coalesce(cur_a.profile_name, v_default_profile.display_name),
        'current_profile_is_default', (cur_a.assignment_id is null),
        'current_assignment_id', cur_a.assignment_id,
        'current_assignment_version', cur_a.version,
        'current_assignment_valid_from', cur_a.valid_from
      )
      order by lower(ident.employee_display_name) asc, u.app_user_id asc
    ),
    '[]'::jsonb
  )
    into v_employee_options
  from public.direct_entry_app_users u
  cross join lateral public.attendance__internal_resolve_employee_identity(u.app_user_id) ident
  left join lateral (
    select
      a.assignment_id,
      a.profile_id,
      pr.profile_code,
      pr.display_name as profile_name,
      a.version,
      pg_catalog.to_char(a.valid_from, 'YYYY-MM-DD') as valid_from
    from public.attendance_slot_policy_assignments a
    join public.attendance_slot_policy_profiles pr
      on pr.profile_id = a.profile_id
    where a.app_user_id = u.app_user_id
      and not a.superseded_same_day
      and a.valid_from <= v_today_vn
      and (a.valid_to is null or v_today_vn <= a.valid_to)
    order by a.valid_from desc, a.assigned_at desc, a.assignment_id desc
    limit 1
  ) cur_a on true
  where u.enabled = true
    and not public.attendance__internal_is_non_employee_account(u.app_user_id, v_now);

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'can_manage_slot_policy', v_can_manage
    ),
    'business_date', v_today_vn::text,
    'current_policy', v_current_policy,
    'latest_policy', v_latest_policy,
    'versions', v_versions,
    'profiles', v_profiles,
    'assignments', v_assignments,
    'employee_options', v_employee_options
  );
end;
$function$;

revoke all on function public.attendance_get_slot_policies_admin(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.attendance_get_slot_policies_admin(uuid, uuid)
  to service_role;

create or replace function public.attendance_assign_employee_slot_policy_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_profile_id uuid,
  p_effective_date date,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_can_manage boolean;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today_vn date := coalesce(
    nullif(current_setting('direct_entry.test_authorization_date', true), '')::date,
    (v_now at time zone 'Asia/Ho_Chi_Minh')::date
  );
  v_effective_date date := coalesce(p_effective_date, v_today_vn);
  v_existing public.attendance_slot_policy_assignments%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_profile public.attendance_slot_policy_profiles%rowtype;
  v_open public.attendance_slot_policy_assignments%rowtype;
  v_saved public.attendance_slot_policy_assignments%rowtype;
  v_ident record;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if not v_can_manage then
    raise exception 'ATTENDANCE_SLOT_POLICY_WRITE_DENIED'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  if p_target_app_user_id is null
     or p_profile_id is null then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_slot_policy_assignments_user'),
    hashtext(p_target_app_user_id::text)
  );

  select *
    into v_existing
  from public.attendance_slot_policy_assignments a
  where a.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;

    select *
      into v_profile
    from public.attendance_slot_policy_profiles pr
    where pr.profile_id = v_existing.profile_id;

    select *
      into v_target_user
    from public.direct_entry_app_users u
    where u.app_user_id = v_existing.app_user_id;

    select *
      into v_ident
    from public.attendance__internal_resolve_employee_identity(v_existing.app_user_id);

    return jsonb_build_object(
      'replayed', true,
      'assignment', jsonb_build_object(
        'assignment_id', v_existing.assignment_id,
        'app_user_id', v_existing.app_user_id,
        'employee_display_name', v_ident.employee_display_name,
        'personnel_code', v_ident.personnel_code,
        'enabled', v_target_user.enabled,
        'profile_id', v_profile.profile_id,
        'profile_code', v_profile.profile_code,
        'profile_name', v_profile.display_name,
        'valid_from', pg_catalog.to_char(v_existing.valid_from, 'YYYY-MM-DD'),
        'valid_to', case when v_existing.valid_to is null then null else pg_catalog.to_char(v_existing.valid_to, 'YYYY-MM-DD') end,
        'superseded_same_day', v_existing.superseded_same_day,
        'effective', (
          not v_existing.superseded_same_day
          and v_existing.valid_from <= v_today_vn
          and (v_existing.valid_to is null or v_today_vn <= v_existing.valid_to)
          and v_profile.active = true
        ),
        'version', v_existing.version
      )
    );
  end if;

  if v_effective_date > v_today_vn then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE'
      using errcode = '22023',
            detail = 'Slot policy profile assignment takes effect immediately and cannot be scheduled in the future.';
  end if;

  if v_effective_date < v_today_vn then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_PAST_DATE'
      using errcode = '22023',
            detail = 'Slot policy profile assignment takes effect immediately today and cannot retroactively alter past dates.';
  end if;

  select *
    into v_target_user
  from public.direct_entry_app_users u
  where u.app_user_id = p_target_app_user_id
  for update;

  if not found
     or v_target_user.enabled is distinct from true
     or public.attendance__internal_is_non_employee_account(p_target_app_user_id, v_now) then
    raise exception 'ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID'
      using errcode = '22023';
  end if;

  select *
    into v_profile
  from public.attendance_slot_policy_profiles pr
  where pr.profile_id = p_profile_id
  for share;

  if not found then
    raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_profile.is_default then
    raise exception 'ATTENDANCE_SLOT_POLICY_DEFAULT_ASSIGNMENT_REDUNDANT'
      using errcode = '22023';
  end if;

  if not v_profile.active then
    raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_INACTIVE'
      using errcode = '22023';
  end if;

  select *
    into v_open
  from public.attendance_slot_policy_assignments a
  where a.app_user_id = p_target_app_user_id
    and a.valid_to is null
    and not a.superseded_same_day
  order by a.valid_from desc, a.assigned_at desc
  limit 1
  for update;

  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  if (v_open.assignment_id is null and p_expected_version <> 0)
     or (v_open.assignment_id is not null and v_open.version <> p_expected_version) then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_open.assignment_id is not null then
    if v_open.valid_from > v_effective_date then
      raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_DATE_ORDER_INVALID'
        using errcode = '22023';
    end if;

    if v_open.valid_from = v_effective_date then
      update public.attendance_slot_policy_assignments a
      set valid_to = v_effective_date,
          superseded_same_day = true,
          revoked_by_user_id = p_app_user_id,
          revoked_at = clock_timestamp(),
          version = a.version + 1,
          updated_at = clock_timestamp()
      where a.assignment_id = v_open.assignment_id;
    else
      update public.attendance_slot_policy_assignments a
      set valid_to = (v_effective_date - 1),
          superseded_same_day = false,
          revoked_by_user_id = p_app_user_id,
          revoked_at = clock_timestamp(),
          version = a.version + 1,
          updated_at = clock_timestamp()
      where a.assignment_id = v_open.assignment_id;
    end if;
  end if;

  begin
    insert into public.attendance_slot_policy_assignments (
      app_user_id,
      profile_id,
      valid_from,
      valid_to,
      superseded_same_day,
      version,
      assigned_by_user_id,
      assigned_at,
      idempotency_key,
      request_fingerprint
    )
    values (
      p_target_app_user_id,
      p_profile_id,
      v_effective_date,
      null,
      false,
      1,
      p_app_user_id,
      clock_timestamp(),
      p_idempotency_key,
      p_request_fingerprint
    )
    returning * into v_saved;
  exception
    when exclusion_violation or unique_violation then
      raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_OVERLAP'
        using errcode = 'PT409';
  end;

  select *
    into v_ident
  from public.attendance__internal_resolve_employee_identity(p_target_app_user_id);

  insert into public.direct_entry_audit_events (
    auth_subject,
    app_user_id,
    action,
    capability,
    resource_ref,
    scope_kind,
    outcome,
    changed_fields
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'attendance_slot_policy_assign',
    'entry_admin',
    'attendance_slot_policy_assignment:' || v_saved.assignment_id::text,
    'all',
    'APPLIED',
    array[
      'target_app_user_id:' || p_target_app_user_id::text,
      'profile_code:' || v_profile.profile_code,
      'valid_from:' || v_saved.valid_from::text
    ]
  );

  return jsonb_build_object(
    'replayed', false,
    'assignment', jsonb_build_object(
      'assignment_id', v_saved.assignment_id,
      'app_user_id', v_saved.app_user_id,
      'employee_display_name', v_ident.employee_display_name,
      'personnel_code', v_ident.personnel_code,
      'enabled', v_target_user.enabled,
      'profile_id', v_profile.profile_id,
      'profile_code', v_profile.profile_code,
      'profile_name', v_profile.display_name,
      'valid_from', pg_catalog.to_char(v_saved.valid_from, 'YYYY-MM-DD'),
      'valid_to', case when v_saved.valid_to is null then null else pg_catalog.to_char(v_saved.valid_to, 'YYYY-MM-DD') end,
      'superseded_same_day', v_saved.superseded_same_day,
      'effective', (
        not v_saved.superseded_same_day
        and v_saved.valid_from <= v_today_vn
        and (v_saved.valid_to is null or v_today_vn <= v_saved.valid_to)
        and v_profile.active = true
      ),
      'version', v_saved.version
    )
  );
end;
$function$;

revoke all on function public.attendance_assign_employee_slot_policy_admin(
  uuid, uuid, uuid, uuid, date, integer, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.attendance_assign_employee_slot_policy_admin(
  uuid, uuid, uuid, uuid, date, integer, uuid, text
) to service_role;

-- -----------------------------------------------------------------------------
-- 12. Owner Alignment & Fail-Closed Postcondition Self-Check
-- -----------------------------------------------------------------------------
do $align_wp7b$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_can_set_owner boolean := false;
  v_fn regprocedure;
  v_proc_owner_oid oid;
  v_all_fns regprocedure[] := array[
    'public.leave_management_get_actor_access(uuid, uuid)'::pg_catalog.regprocedure,
    'public.attendance__internal_is_non_employee_account(uuid, timestamp with time zone)'::pg_catalog.regprocedure,
    'public.attendance__internal_day_as_of(date, date, timestamp with time zone)'::pg_catalog.regprocedure,
    'public.attendance__internal_is_employee_in_scope_on_date(text, uuid[], uuid[], uuid, date, date, timestamp with time zone)'::pg_catalog.regprocedure,
    'public.attendance__internal_has_any_scope_day_in_range(text, uuid[], uuid[], uuid, date, date, date, timestamp with time zone)'::pg_catalog.regprocedure,
    'public.attendance__internal_assert_report_reader(uuid, uuid)'::pg_catalog.regprocedure,
    'public.attendance__internal_resolve_report_scope_v2(uuid, uuid)'::pg_catalog.regprocedure,
    'public.attendance__internal_resolve_report_scope(uuid, uuid)'::pg_catalog.regprocedure,
    'public.attendance__internal_resolve_employee_identity(uuid)'::pg_catalog.regprocedure,
    'public.direct_entry_resolve_actor_context(uuid)'::pg_catalog.regprocedure,
    'public.attendance_lookup_checkin_idempotency(uuid, uuid, uuid, text)'::pg_catalog.regprocedure,
    'public.attendance_record_checkin(uuid, uuid, uuid, text, double precision, double precision, double precision, text, text, timestamp with time zone, text, timestamp with time zone, bigint, text, text, text, integer, text, timestamp with time zone)'::pg_catalog.regprocedure,
    'public.attendance_admin_report(uuid, uuid, date, date, integer, integer, text, uuid)'::pg_catalog.regprocedure,
    'public.attendance_admin_checkin_photo(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)'::pg_catalog.regprocedure,
    'public.attendance_list_branches_admin(uuid, uuid, boolean)'::pg_catalog.regprocedure,
    'public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)'::pg_catalog.regprocedure,
    'public.attendance_get_slot_policies_admin(uuid, uuid)'::pg_catalog.regprocedure,
    'public.attendance_assign_employee_slot_policy_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)'::pg_catalog.regprocedure
  ];
begin
  select c.relowner, pg_catalog.pg_get_userbyid(c.relowner)
    into v_base_owner_oid, v_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'direct_entry_app_users';

  if v_base_owner_oid is null then
    raise exception 'WP7B_OWNER_ALIGN_MISSING_BASE_TABLE'
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
end
$align_wp7b$;

do $check_wp7b$
declare
  v_internal_fns regprocedure[] := array[
    'public.attendance__internal_is_non_employee_account(uuid, timestamp with time zone)'::pg_catalog.regprocedure,
    'public.attendance__internal_day_as_of(date, date, timestamp with time zone)'::pg_catalog.regprocedure,
    'public.attendance__internal_is_employee_in_scope_on_date(text, uuid[], uuid[], uuid, date, date, timestamp with time zone)'::pg_catalog.regprocedure,
    'public.attendance__internal_has_any_scope_day_in_range(text, uuid[], uuid[], uuid, date, date, date, timestamp with time zone)'::pg_catalog.regprocedure,
    'public.attendance__internal_assert_report_reader(uuid, uuid)'::pg_catalog.regprocedure,
    'public.attendance__internal_resolve_report_scope_v2(uuid, uuid)'::pg_catalog.regprocedure,
    'public.attendance__internal_resolve_report_scope(uuid, uuid)'::pg_catalog.regprocedure,
    'public.attendance__internal_resolve_employee_identity(uuid)'::pg_catalog.regprocedure
  ];
  v_public_fns regprocedure[] := array[
    'public.leave_management_get_actor_access(uuid, uuid)'::pg_catalog.regprocedure,
    'public.direct_entry_resolve_actor_context(uuid)'::pg_catalog.regprocedure,
    'public.attendance_lookup_checkin_idempotency(uuid, uuid, uuid, text)'::pg_catalog.regprocedure,
    'public.attendance_record_checkin(uuid, uuid, uuid, text, double precision, double precision, double precision, text, text, timestamp with time zone, text, timestamp with time zone, bigint, text, text, text, integer, text, timestamp with time zone)'::pg_catalog.regprocedure,
    'public.attendance_admin_report(uuid, uuid, date, date, integer, integer, text, uuid)'::pg_catalog.regprocedure,
    'public.attendance_admin_checkin_photo(uuid, uuid, uuid)'::pg_catalog.regprocedure,
    'public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)'::pg_catalog.regprocedure,
    'public.attendance_list_branches_admin(uuid, uuid, boolean)'::pg_catalog.regprocedure,
    'public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)'::pg_catalog.regprocedure,
    'public.attendance_get_slot_policies_admin(uuid, uuid)'::pg_catalog.regprocedure,
    'public.attendance_assign_employee_slot_policy_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)'::pg_catalog.regprocedure
  ];
  v_fn regprocedure;
  v_proc record;
  v_provolatile "char";
begin
  -- Verify internal helpers are strictly SECURITY DEFINER, BYPASSRLS/superuser-owned, and revoked from ALL roles incl. service_role
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
      raise exception 'WP7B_CHECK_FAILED: unsafe secdef/owner/search_path on internal helper %', v_fn
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
      raise exception 'WP7B_CHECK_FAILED: internal helper % must not grant EXECUTE to client or service_role', v_fn
        using errcode = '55000';
    end if;
  end loop;

  -- Verify allowlisted service_role RPCs (including new read-only leave_management_get_actor_access)
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
      raise exception 'WP7B_CHECK_FAILED: unsafe secdef/owner/search_path on public RPC %', v_fn
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
      raise exception 'WP7B_CHECK_FAILED: public RPC % has client/PUBLIC EXECUTE grant', v_fn
        using errcode = '55000';
    end if;

    if not exists (
      select 1
        from pg_catalog.aclexplode(coalesce(v_proc.proacl, array[]::aclitem[])) a
       where a.grantee = (select oid from pg_catalog.pg_roles where rolname = 'service_role')
         and a.privilege_type = 'EXECUTE'
    ) then
      raise exception 'WP7B_CHECK_FAILED: public RPC % missing service_role EXECUTE', v_fn
        using errcode = '55000';
    end if;
  end loop;

  -- Specifically verify leave_management_get_actor_access is STABLE (read-only nav probe invariant)
  select p.provolatile into v_provolatile
    from pg_catalog.pg_proc p
   where p.oid = 'public.leave_management_get_actor_access(uuid, uuid)'::pg_catalog.regprocedure;
  if v_provolatile <> 's' then
    raise exception 'WP7B_CHECK_FAILED: leave_management_get_actor_access must be STABLE'
      using errcode = '55000';
  end if;
end
$check_wp7b$;

commit;
