-- ============================================================================
-- WP9: Org Obligations (S6) — Attendance & Work Reports
-- Append-only migration #232 (baseline: 231 migrations, 337 service_role RPCs).
--
-- Scope (ponytail minimal):
--   1. Shared temporal obligation / employment-status helpers (3 new internal
--      helpers, revoked from public/anon/authenticated/service_role -> +0 new
--      service_role RPCs):
--      - attendance__internal_is_non_employee_account: temporal D-WP7B-03 check
--        so later Person deactivation never retroactively alters prior dates.
--      - attendance__internal_is_person_inactive_as_of: authoritative INACTIVE
--        Person check as-of timestamp (never excludes unlinked NORMAL or
--        Person ACTIVE + account disabled per R5/D10/DEC-T0-03).
--      - attendance__internal_is_employee_obligated_on_date: per-day obligation
--        from account_type, unconflicted legacy shared, evidenced joined_on,
--        and Person deactivation (NEVER infers start date from created_at,
--        link.started_at, or disable timestamp).
--      - work_report__internal_team_on_date: as-of verified active team lookup.
--   2. Attendance & Leave Explanations:
--      - attendance_monthly_matrix_report: per-day obligation across ALL/TEAM/
--        DEPARTMENT scopes, R5/D10 retention for disabled active Persons
--        without pulling old unlinked disabled accounts, and consistent
--        future-only slot policy fallback ordering.
--      - attendance_record_checkin / attendance_lookup_checkin_idempotency /
--        attendance_list_branches_admin / attendance_assign_employee_branch_admin /
--        attendance_get_slot_policies_admin / attendance_assign_employee_slot_policy_admin:
--        block INACTIVE Person cleanly with Tier 1 organization_persons FOR SHARE
--        lock strictly before Tier 2 direct_entry_app_users.
--      - attendance_explanation__internal_evaluate_employee_day_slots: zero fake
--        MISSING / explanation eligibility on non-obligated dates.
--      - leave_management__internal_resolve_authority: align D-WP7B-03 conflict
--        resolution with attendance__internal_is_non_employee_account while
--        preserving direct_entry_catalog_bootstrap_executor EXECUTE grant.
--   3. Work Reports:
--      - Exclude SHARED/SERVICE/unconflicted legacy-shared and INACTIVE Person
--        from assignment/group/delegation pickers, writers, and materializers
--        without deleting or mutating historical obligations/submissions.
--      - Evaluate TEAM membership and GROUP member join date as-of each
--        business_date in materialization (eliminates 7-day retroactive fake
--        OVERDUE on team transfer / new group member) and stamp per-period
--        as-of snapshot_team_id.
--      - Add ONCE dedup guard + ACTIVE template filter in direct/window
--        materializers; anchor ONCE in actor lookback to earliest eligible date.
--      - Align work_report_has_active_obligations (strictly STABLE read-only)
--        with work_report_assert_actor for non-employee accounts.
--      - Allow all-scope Admin to PAUSE/REVOKE a USER assignment after target
--        disable/team exit while keeping team-scoped fail-closed.
--      - Add Tier 1 organization_persons ASC FOR SHARE lock before Tier 2 in
--        Work Report writers checking Person status.
-- ============================================================================

begin;

-- ============================================================================
-- PART 1: SHARED TEMPORAL OBLIGATION & EMPLOYMENT-STATUS HELPERS
-- ============================================================================

create or replace function public.attendance__internal_is_non_employee_account(
  p_app_user_id uuid,
  p_as_of timestamptz default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
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

  -- D-WP7B-03: Do NOT auto-apply legacy is_shared_non_employee when contradicted
  -- by a verified Person active at v_as_of (covering link at v_as_of, or current
  -- open link when the account was linked retroactively after v_as_of).
  select exists (
    select 1
      from public.organization_account_person_links l
      join public.organization_persons op
        on op.person_id = l.person_id
       and (
         op.status = 'ACTIVE'
         or (op.deactivated_at is not null and op.deactivated_at > v_as_of)
       )
     where l.app_user_id = p_app_user_id
       and (
         (
           l.started_at <= v_as_of
           and (l.ended_at is null or (l.ended_at > l.started_at and v_as_of < l.ended_at))
         )
         or (
           l.ended_at is null
           and not exists (
             select 1
               from public.organization_account_person_links l_hist
              where l_hist.app_user_id = p_app_user_id
                and l_hist.started_at <= v_as_of
                and (
                  l_hist.ended_at is null
                  or (l_hist.ended_at > l_hist.started_at and v_as_of < l_hist.ended_at)
                )
           )
         )
       )
  ) into v_has_active_person;

  return not coalesce(v_has_active_person, false);
end;
$$;

revoke all on function public.attendance__internal_is_non_employee_account(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.attendance__internal_is_person_inactive_as_of(
  p_app_user_id uuid,
  p_as_of timestamptz default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_person_status text;
  v_deactivated_at timestamptz;
begin
  if p_app_user_id is null then
    return false;
  end if;

  select op.status, op.deactivated_at
    into v_person_status, v_deactivated_at
    from public.organization_account_person_links l
    join public.organization_persons op
      on op.person_id = l.person_id
   where l.app_user_id = p_app_user_id
     and l.started_at <= v_as_of
     and (l.ended_at is null or (l.ended_at > l.started_at and v_as_of < l.ended_at))
   order by l.started_at desc, l.link_id desc
   limit 1;

  if not found then
    select op.status, op.deactivated_at
      into v_person_status, v_deactivated_at
      from public.organization_account_person_links l
      join public.organization_persons op
        on op.person_id = l.person_id
     where l.app_user_id = p_app_user_id
       and l.ended_at is null
     order by l.started_at desc, l.link_id desc
     limit 1;
  end if;

  if not found then
    return false;
  end if;

  return (
    v_person_status = 'INACTIVE'
    and v_deactivated_at is not null
    and v_deactivated_at <= v_as_of
  );
end;
$$;

revoke all on function public.attendance__internal_is_person_inactive_as_of(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.attendance__internal_is_employee_obligated_on_date(
  p_app_user_id uuid,
  p_business_date date,
  p_today_vn date default null,
  p_now timestamptz default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  v_today_vn date := coalesce(p_today_vn, (v_now at time zone 'Asia/Ho_Chi_Minh')::date);
  v_as_of timestamptz;
  v_joined_on date;
  v_person_status text;
  v_deactivated_at timestamptz;
begin
  if p_app_user_id is null or p_business_date is null then
    return false;
  end if;

  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
  ) then
    return false;
  end if;

  v_as_of := public.attendance__internal_day_as_of(p_business_date, v_today_vn, v_now);

  if public.attendance__internal_is_non_employee_account(p_app_user_id, v_as_of) then
    return false;
  end if;

  -- Resolve Person via covering link at v_as_of, falling back to current open link
  -- so retroactive Person linking still respects evidenced joined_on / deactivated_at
  -- without EVER inferring start date from link.started_at or account created_at (DEC-T0-03).
  select op.joined_on, op.status, op.deactivated_at
    into v_joined_on, v_person_status, v_deactivated_at
    from public.organization_account_person_links l
    join public.organization_persons op
      on op.person_id = l.person_id
   where l.app_user_id = p_app_user_id
     and l.started_at <= v_as_of
     and (l.ended_at is null or (l.ended_at > l.started_at and v_as_of < l.ended_at))
   order by l.started_at desc, l.link_id desc
   limit 1;

  if not found then
    select op.joined_on, op.status, op.deactivated_at
      into v_joined_on, v_person_status, v_deactivated_at
      from public.organization_account_person_links l
      join public.organization_persons op
        on op.person_id = l.person_id
     where l.app_user_id = p_app_user_id
       and l.ended_at is null
     order by l.started_at desc, l.link_id desc
     limit 1;
  end if;

  if not found then
    -- Unlinked NORMAL account is NEVER auto-excluded (S6 / DEC-T0-03).
    return true;
  end if;

  if v_joined_on is not null and p_business_date < v_joined_on then
    return false;
  end if;

  if v_person_status = 'INACTIVE'
     and v_deactivated_at is not null
     and v_deactivated_at <= v_as_of then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.attendance__internal_is_employee_obligated_on_date(uuid, date, date, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_team_on_date(
  p_app_user_id uuid,
  p_business_date date
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_team_id uuid;
  v_count integer;
begin
  if p_app_user_id is null or p_business_date is null then
    return null;
  end if;

  select count(distinct m.team_id)::integer,
         (pg_catalog.array_agg(distinct m.team_id order by m.team_id))[1]
    into v_count, v_team_id
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r
      on r.recruiter_id = l.recruiter_id
     and r.active = true
    join public.recruiter_team_memberships m
      on m.recruiter_id = l.recruiter_id
    join public.teams t
      on t.team_id = m.team_id
     and t.active = true
     and t.code <> '__system_vendor__'
   where l.app_user_id = p_app_user_id
     and l.verified = true
     and l.valid_from <= p_business_date
     and (l.valid_to is null or (l.valid_to > l.valid_from and p_business_date < l.valid_to))
     and (l.valid_to is not null or l.is_current = true)
     and m.valid_from <= p_business_date
     and (m.valid_to is null or (m.valid_to > m.valid_from and p_business_date < m.valid_to))
     and (m.valid_to is not null or m.is_current = true);

  if v_count <> 1 then
    return null;
  end if;
  return v_team_id;
end;
$$;

revoke all on function public.work_report__internal_team_on_date(uuid, date)
  from public, anon, authenticated, service_role;

-- ============================================================================
-- PART 2: ATTENDANCE & LEAVE EXPLANATIONS
-- ============================================================================

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
as $$
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
        order by
          (p2.effective_from_date <= cal.d::date) desc,
          case when p2.effective_from_date <= cal.d::date then p2.effective_from_date end desc nulls last,
          case when p2.effective_from_date <= cal.d::date then p2.version end desc nulls last,
          p2.version asc
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
        order by
          (pb.effective_from_date <= v_today_vn) desc,
          case when pb.effective_from_date <= v_today_vn then pb.effective_from_date end desc nulls last,
          case when pb.effective_from_date <= v_today_vn then pb.version end desc nulls last,
          pb.version asc
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
                order by
                  (pb_c.effective_from_date <= v_today_vn) desc,
                  case when pb_c.effective_from_date <= v_today_vn then pb_c.effective_from_date end desc nulls last,
                  case when pb_c.effective_from_date <= v_today_vn then pb_c.version end desc nulls last,
                  pb_c.version asc
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
                    order by
                      (p3.effective_from_date <= cal_m.d::date) desc,
                      case when p3.effective_from_date <= cal_m.d::date then p3.effective_from_date end desc nulls last,
                      case when p3.effective_from_date <= cal_m.d::date then p3.version end desc nulls last,
                      p3.version asc
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
  scoped_users as materialized (
    select
      u.app_user_id,
      u.display_name as raw_display_name,
      u.enabled
    from public.direct_entry_app_users u
    where v_scope_kind = 'all'
       or exists (
         select 1
         from user_scoped_days usd
         where usd.app_user_id = u.app_user_id
       )
  ),
  user_month_day_obligations as materialized (
    select
      su.app_user_id,
      cal.business_date,
      public.attendance__internal_is_employee_obligated_on_date(
        su.app_user_id,
        cal.business_date,
        v_today_vn,
        v_now
      ) as is_obligated
    from scoped_users su
    cross join month_calendar_days cal
    where v_scope_kind = 'all'
       or exists (
         select 1
         from user_scoped_days usd
         where usd.app_user_id = su.app_user_id
           and usd.business_date = cal.business_date
       )
  ),
  eligible_month_users as materialized (
    -- Include:
    --   (1) Enabled accounts with >=1 obligated in-scope day in this month (linked ACTIVE Person or unlinked NORMAL), OR
    --   (2) Disabled accounts backed by a covering/open Person link with >=1 obligated in-scope day in this month
    --       (R5/D10: disabling account != resignation; old unlinked disabled legacy accounts without activity stay excluded), OR
    --   (3) Any account (including DISABLED, INACTIVE Person, or SHARED/SERVICE) that has real historical check-ins,
    --       approved leave, or attendance explanations on at least one IN-SCOPE day of this month.
    select
      u.app_user_id,
      u.raw_display_name,
      u.enabled
    from scoped_users u
    where (
            u.enabled = true
            and exists (
              select 1
              from user_month_day_obligations udo
              where udo.app_user_id = u.app_user_id
                and udo.is_obligated = true
            )
          )
       or (
            u.enabled = false
            and exists (
              select 1
              from user_month_day_obligations udo
              where udo.app_user_id = u.app_user_id
                and udo.is_obligated = true
                and exists (
                  select 1
                  from public.organization_account_person_links l
                  where l.app_user_id = u.app_user_id
                    and (
                      l.ended_at is null
                      or (
                        l.started_at <= public.attendance__internal_day_as_of(udo.business_date, v_today_vn, v_now)
                        and l.ended_at > l.started_at
                        and public.attendance__internal_day_as_of(udo.business_date, v_today_vn, v_now) < l.ended_at
                      )
                    )
                )
            )
          )
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
      order by
        (p.effective_from_date <= cal.business_date) desc,
        case when p.effective_from_date <= cal.business_date then p.effective_from_date end desc nulls last,
        case when p.effective_from_date <= cal.business_date then p.version end desc nulls last,
        p.version asc
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
      coalesce(udo.is_obligated, false) as is_obligated,
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
    left join user_month_day_obligations udo
      on udo.app_user_id = ce.app_user_id
     and udo.business_date = cal.business_date
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
      order by
        (p2.effective_from_date <= cal.business_date) desc,
        case when p2.effective_from_date <= cal.business_date then p2.effective_from_date end desc nulls last,
        case when p2.effective_from_date <= cal.business_date then p2.version end desc nulls last,
        p2.version asc
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
                case when tmv.effective_from_date <= v_ref_date then tmv.effective_from_date end desc nulls last,
                case when tmv.effective_from_date <= v_ref_date then tmv.version end desc nulls last,
                tmv.version asc,
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
$$;

revoke all on function public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)
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
security definer
set search_path = pg_catalog, public
as $$
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
  v_lock_person_ids uuid[];
  v_check_now timestamptz;
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

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users
  -- so concurrent org_department_update_person_admin (ACTIVE -> INACTIVE) serializes cleanly without deadlock.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id = p_app_user_id
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  -- Tier 2 share-lock app_user row so concurrent disable or NORMAL -> SHARED reclassification serializes cleanly.
  select u.enabled
    into v_user_enabled
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
   for share;

  if not found or v_user_enabled is distinct from true then
    raise exception 'ACTOR_NOT_AVAILABLE' using errcode = '42501';
  end if;

  v_check_now := pg_catalog.clock_timestamp();

  if public.attendance__internal_is_non_employee_account(p_app_user_id, v_check_now) then
    raise exception 'ATTENDANCE_SHARED_ACCOUNT_FORBIDDEN' using errcode = '42501';
  end if;

  if public.attendance__internal_is_person_inactive_as_of(p_app_user_id, v_check_now) then
    raise exception 'ACTOR_NOT_AVAILABLE' using errcode = '42501';
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
$$;

revoke all on function public.attendance_record_checkin(
  uuid, uuid, uuid, text, double precision, double precision, double precision, text, text,
  timestamp with time zone, text, timestamp with time zone, bigint, text, text, text, integer, text, timestamp with time zone
) from public, anon, authenticated;
grant execute on function public.attendance_record_checkin(
  uuid, uuid, uuid, text, double precision, double precision, double precision, text, text,
  timestamp with time zone, text, timestamp with time zone, bigint, text, text, text, integer, text, timestamp with time zone
) to service_role;

create or replace function public.attendance_lookup_checkin_idempotency(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_existing public.attendance_checkins%rowtype;
  v_daily_count integer;
  v_check_now timestamptz := pg_catalog.clock_timestamp();
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

  if public.attendance__internal_is_non_employee_account(p_app_user_id, v_check_now) then
    raise exception 'ATTENDANCE_SHARED_ACCOUNT_FORBIDDEN' using errcode = '42501';
  end if;

  if public.attendance__internal_is_person_inactive_as_of(p_app_user_id, v_check_now) then
    raise exception 'ACTOR_NOT_AVAILABLE' using errcode = '42501';
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
$$;

revoke all on function public.attendance_lookup_checkin_idempotency(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.attendance_lookup_checkin_idempotency(uuid, uuid, uuid, text)
  to service_role;

create or replace function public.attendance_list_branches_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_include_inactive boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
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
    and not public.attendance__internal_is_non_employee_account(u.app_user_id, v_now)
    and not public.attendance__internal_is_person_inactive_as_of(u.app_user_id, v_now);

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
$$;

revoke all on function public.attendance_list_branches_admin(uuid, uuid, boolean)
  from public, anon, authenticated;
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
as $$
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
  v_lock_person_ids uuid[];
  v_check_now timestamptz;
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

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id = p_target_app_user_id
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  select *
    into v_target_user
  from public.direct_entry_app_users u
  where u.app_user_id = p_target_app_user_id
  for share;

  v_check_now := pg_catalog.clock_timestamp();

  if not found
     or v_target_user.enabled is distinct from true
     or public.attendance__internal_is_non_employee_account(p_target_app_user_id, v_check_now)
     or public.attendance__internal_is_person_inactive_as_of(p_target_app_user_id, v_check_now) then
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
$$;

revoke all on function public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)
  from public, anon, authenticated;
grant execute on function public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)
  to service_role;

create or replace function public.attendance_get_slot_policies_admin(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
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
      order by
        (pb.effective_from_date <= v_today_vn) desc,
        case when pb.effective_from_date <= v_today_vn then pb.effective_from_date end desc nulls last,
        case when pb.effective_from_date <= v_today_vn then pb.version end desc nulls last,
        pb.version asc
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
              order by
                (pb_cur.effective_from_date <= v_today_vn) desc,
                case when pb_cur.effective_from_date <= v_today_vn then pb_cur.effective_from_date end desc nulls last,
                case when pb_cur.effective_from_date <= v_today_vn then pb_cur.version end desc nulls last,
                pb_cur.version asc
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
    and not public.attendance__internal_is_non_employee_account(u.app_user_id, v_now)
    and not public.attendance__internal_is_person_inactive_as_of(u.app_user_id, v_now);

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
$$;

revoke all on function public.attendance_get_slot_policies_admin(uuid, uuid)
  from public, anon, authenticated;
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
as $$
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
  v_lock_person_ids uuid[];
  v_check_now timestamptz;
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

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id = p_target_app_user_id
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  select *
    into v_target_user
  from public.direct_entry_app_users u
  where u.app_user_id = p_target_app_user_id
  for update;

  v_check_now := pg_catalog.clock_timestamp();

  if not found
     or v_target_user.enabled is distinct from true
     or public.attendance__internal_is_non_employee_account(p_target_app_user_id, v_check_now)
     or public.attendance__internal_is_person_inactive_as_of(p_target_app_user_id, v_check_now) then
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
$$;

revoke all on function public.attendance_assign_employee_slot_policy_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)
  from public, anon, authenticated;
grant execute on function public.attendance_assign_employee_slot_policy_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)
  to service_role;

create or replace function public.attendance_explanation__internal_evaluate_employee_day_slots(
  p_app_user_id uuid,
  p_business_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_now_local timestamp without time zone := v_now at time zone 'Asia/Ho_Chi_Minh';
  v_today_local date := v_now_local::date;
  v_is_obligated boolean;
  v_resolved record;
  v_slots jsonb;
begin
  if p_app_user_id is null or p_business_date is null then
    raise exception 'ATTENDANCE_EXPLANATION_QUERY_INVALID'
      using errcode = '22023';
  end if;

  v_is_obligated := public.attendance__internal_is_employee_obligated_on_date(
    p_app_user_id,
    p_business_date,
    v_today_local,
    v_now
  );

  select *
    into v_resolved
  from public.attendance__internal_resolve_employee_slot_policy(
    p_app_user_id,
    p_business_date
  );

  with slot_defs as (
    select
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
        p_business_date < v_today_local
        or (
          p_business_date = v_today_local
          and v_now_local > p_business_date
            + (slot_elem->>'target_time')::time
            + make_interval(mins => (slot_elem->>'grace_after_minutes')::integer)
        )
      ) as is_due
    from jsonb_array_elements(v_resolved.slots) as slot_elem
  ),
  raw_checkins as (
    select
      c.checkin_id,
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
    where c.app_user_id = p_app_user_id
      and c.business_date = p_business_date
  ),
  enriched_checkins as (
    select
      rc.*,
      ns.slot_index as assigned_slot_index,
      ns.slot_code as assigned_slot_code,
      (rc.local_minute_of_day - ns.target_minute)::integer as delta_minutes,
      case
        when (rc.local_minute_of_day - ns.target_minute) < (-ns.grace_before_minutes) then
          ((- (rc.local_minute_of_day - ns.target_minute)) - ns.grace_before_minutes)::integer
        when (rc.local_minute_of_day - ns.target_minute) > ns.grace_after_minutes then
          ((rc.local_minute_of_day - ns.target_minute) - ns.grace_after_minutes)::integer
        else 0
      end as over_grace_minutes,
      case
        when (rc.local_minute_of_day - ns.target_minute) < (-ns.grace_before_minutes) then 'EARLY'
        when (rc.local_minute_of_day - ns.target_minute) > ns.grace_after_minutes then 'LATE'
        else 'ON_TIME'
      end as deviation_status
    from raw_checkins rc
    cross join lateral (
      select
        s.slot_index,
        s.slot_code,
        s.target_minute,
        s.grace_before_minutes,
        s.grace_after_minutes
      from slot_defs s
      order by abs(rc.local_minute_of_day - s.target_minute) asc, s.slot_index asc
      limit 1
    ) ns
  ),
  slot_checkins as (
    select
      ec.assigned_slot_index as slot_index,
      count(*)::integer as checkin_count,
      count(*) filter (where ec.deviation_status <> 'ON_TIME')::integer as out_of_grace_count,
      jsonb_agg(
        jsonb_build_object(
          'checkin_id', ec.checkin_id,
          'sequence_in_day', ec.sequence_in_day,
          'captured_at', ec.captured_at_utc,
          'captured_at_local', ec.captured_at_local,
          'time_local', ec.time_local,
          'time_verified', ec.time_verified,
          'assigned_slot_code', ec.assigned_slot_code,
          'delta_minutes', ec.delta_minutes,
          'over_grace_minutes', ec.over_grace_minutes,
          'deviation_status', ec.deviation_status,
          'distance_target_kind', ec.distance_target_kind,
          'distance_status', ec.distance_status,
          'distance_meters', ec.distance_meters
        )
        order by ec.captured_at asc, ec.sequence_in_day asc, ec.checkin_id asc
      ) as checkins
    from enriched_checkins ec
    group by ec.assigned_slot_index
  ),
  leave_coverage as (
    select
      coalesce(bool_or(ld.session_code in ('FULL', 'AM')), false) as am_covered,
      coalesce(bool_or(ld.session_code in ('FULL', 'PM')), false) as pm_covered
    from public.leave_request_days ld
    join public.leave_requests lr
      on lr.request_id = ld.request_id
    where ld.app_user_id = p_app_user_id
      and ld.leave_date = p_business_date
      and ld.is_active = true
      and lr.status = 'APPROVED'
  ),
  slot_explanations as (
    select distinct on (ae.slot_code)
      ae.explanation_id,
      ae.slot_code,
      ae.status,
      ae.original_slot_status,
      ae.reason,
      to_char(ae.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as submitted_at_utc,
      to_char(ae.submitted_at at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD HH24:MI:SS') as submitted_at_local,
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
    left join public.direct_entry_app_users du
      on du.app_user_id = ae.decided_by_app_user_id
    left join lateral public.attendance__internal_resolve_employee_identity(du.app_user_id) dec_ident
      on du.app_user_id is not null
    where ae.app_user_id = p_app_user_id
      and ae.business_date = p_business_date
    order by
      ae.slot_code asc,
      case ae.status
        when 'APPROVED' then 1
        when 'PENDING' then 2
        else 3
      end asc,
      ae.submitted_at desc,
      ae.explanation_id desc
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slot_code', sd.slot_code,
        'slot_index', sd.slot_index,
        'slot_label', sd.slot_label,
        'session_code', sd.session_code,
        'target_time', sd.target_time,
        'grace_before_minutes', sd.grace_before_minutes,
        'grace_after_minutes', sd.grace_after_minutes,
        'is_leave_covered', (
          case
            when sd.session_code = 'AM' then lc.am_covered
            else lc.pm_covered
          end
        ),
        'original_slot_status', (
          case
            when coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0 then 'OUT_OF_GRACE'
            when coalesce(sc.checkin_count, 0) > 0 then 'ON_TIME'
            when (
              case
                when sd.session_code = 'AM' then lc.am_covered
                else lc.pm_covered
              end
            ) then 'LEAVE_COVERED'
            else 'MISSING'
          end
        ),
        'slot_status', (
          case
            when se.status = 'APPROVED' and (
              (coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0)
              or (
                coalesce(sc.checkin_count, 0) = 0
                and not (
                  case
                    when sd.session_code = 'AM' then lc.am_covered
                    else lc.pm_covered
                  end
                )
              )
            ) then 'EXPLAINED_APPROVED'
            when coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0 then 'OUT_OF_GRACE'
            when coalesce(sc.checkin_count, 0) > 0 then 'ON_TIME'
            when (
              case
                when sd.session_code = 'AM' then lc.am_covered
                else lc.pm_covered
              end
            ) then 'LEAVE_COVERED'
            when not v_is_obligated then 'UPCOMING'
            when not sd.is_due then 'UPCOMING'
            else 'MISSING'
          end
        ),
        'eligible_for_explanation', (
          v_is_obligated
          and sd.is_due
          and coalesce(se.status, '') not in ('PENDING', 'APPROVED')
          and (
            (coalesce(sc.checkin_count, 0) > 0 and coalesce(sc.out_of_grace_count, 0) > 0)
            or (
              coalesce(sc.checkin_count, 0) = 0
              and not (
                case
                  when sd.session_code = 'AM' then lc.am_covered
                  else lc.pm_covered
                end
              )
            )
          )
        ),
        'checkins', coalesce(sc.checkins, '[]'::jsonb),
        'explanation', case
          when se.explanation_id is not null then
            jsonb_build_object(
              'explanation_id', se.explanation_id,
              'status', se.status,
              'original_slot_status', se.original_slot_status,
              'reason', se.reason,
              'submitted_at', se.submitted_at_utc,
              'submitted_at_local', se.submitted_at_local,
              'decided_at', se.decided_at_utc,
              'decided_at_local', se.decided_at_local,
              'decided_by_display_name', se.decided_by_display_name,
              'decision_note', se.decision_note,
              'row_version', se.row_version
            )
          else null
        end
      )
      order by sd.slot_index asc
    ),
    '[]'::jsonb
  )
    into v_slots
  from slot_defs sd
  cross join leave_coverage lc
  left join slot_checkins sc
    on sc.slot_index = sd.slot_index
  left join slot_explanations se
    on se.slot_code = sd.slot_code;

  return jsonb_build_object(
    'business_date', p_business_date::text,
    'policy_profile_id_used', v_resolved.profile_id,
    'policy_profile_code_used', v_resolved.profile_code,
    'policy_profile_name_used', v_resolved.profile_name,
    'policy_is_default_used', v_resolved.is_default,
    'policy_version_used', v_resolved.policy_version,
    'slots', v_slots
  );
end;
$$;

revoke all on function public.attendance_explanation__internal_evaluate_employee_day_slots(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.leave_management__internal_resolve_authority(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
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
  v_is_compat_dept_approver boolean := false;
  v_is_dept_approver boolean := false;
  v_has_pending_snapshot_approval boolean := false;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'Direct entry actor mapping is not active'
      using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  -- Align D-WP7B-03 conflict resolution with Attendance so an ACTIVE linked Person
  -- with stale leave_employee_profiles.is_shared_non_employee = true is not split-brained
  -- between check-in/matrix and Attendance Explanations / Leave nav.
  v_is_shared := public.attendance__internal_is_non_employee_account(p_app_user_id, v_now);

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
$$;

revoke all on function public.leave_management__internal_resolve_authority(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.leave_management__internal_resolve_authority(uuid, uuid)
  to direct_entry_catalog_bootstrap_executor;

-- ============================================================================
-- PART 3: WORK REPORTS — ELIGIBILITY, AS-OF MATERIALIZATION, ONCE, & LOCKS
-- ============================================================================

create or replace function public.work_report__internal_is_eligible_assignee(
  p_app_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_current_link_count integer;
  v_valid_link_count integer;
begin
  if p_app_user_id is null then
    return false;
  end if;

  if not exists (
    select 1
      from public.direct_entry_app_users u
      join auth.users au on au.id = u.auth_subject
     where u.app_user_id = p_app_user_id
       and u.enabled
  ) then
    return false;
  end if;

  if public.attendance__internal_is_non_employee_account(p_app_user_id, v_now)
     or public.attendance__internal_is_person_inactive_as_of(p_app_user_id, v_now) then
    return false;
  end if;

  select count(*)::integer,
         count(*) filter (where l.verified and r.active)::integer
    into v_current_link_count, v_valid_link_count
    from public.direct_entry_app_user_recruiter_links l
    left join public.recruiters r on r.recruiter_id = l.recruiter_id
   where l.app_user_id = p_app_user_id
     and l.is_current;

  if v_current_link_count > 0 then
    if v_current_link_count <> 1 or v_valid_link_count <> 1 then
      return false;
    end if;
    return public.work_report_current_team(p_app_user_id) is not null;
  end if;

  return true;
end;
$$;

revoke all on function public.work_report__internal_is_eligible_assignee(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.work_report_assert_actor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text default null
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
       and u.account_type = 'NORMAL'
       and not public.attendance__internal_is_non_employee_account(p_app_user_id, pg_catalog.clock_timestamp())
  ) then
    raise exception 'WORK_REPORT_ACTOR_DENIED' using errcode = '42501';
  end if;
  if p_capability is not null
     and not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
end;
$$;

revoke all on function public.work_report_assert_actor(uuid, uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_actor_materialization_candidates(
  p_app_user_id uuid,
  p_business_date date,
  p_lookback_days integer default 7
)
returns table(
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
as $$
declare
  v_days integer := greatest(least(coalesce(p_lookback_days, 7), 31), 1);
  v_window_start date;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today_vn date := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
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

  if public.attendance__internal_is_non_employee_account(p_app_user_id, v_now) then
    return;
  end if;

  v_window_start := p_business_date - (v_days - 1);
  v_is_eligible := public.work_report__internal_is_eligible_assignee(p_app_user_id);

  return query
  with window_dates as (
    select gs::date as business_date,
           public.work_report__internal_team_on_date(p_app_user_id, gs::date) as team_id_on_date
      from pg_catalog.generate_series(
        v_window_start::timestamp,
        p_business_date::timestamp,
        interval '1 day'
      ) gs
     where public.attendance__internal_is_employee_obligated_on_date(
       p_app_user_id,
       gs::date,
       v_today_vn,
       v_now
     )
  ),
  actor_assignments as (
    select a.assignment_id,
           a.template_id,
           a.template_version_id,
           a.target_kind,
           a.target_team_id,
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
           end as snapshot_group_name,
           case
             when a.target_kind = 'GROUP' then gm_self.created_at
             else null::timestamptz
           end as member_created_at
      from public.work_report_assignments a
      join public.work_report_templates tpl
        on tpl.template_id = a.template_id
       and tpl.status = 'ACTIVE'
      left join public.work_report_groups g
        on a.target_kind = 'GROUP'
       and g.group_id = a.target_group_id
      left join public.work_report_group_members gm_self
        on a.target_kind = 'GROUP'
       and gm_self.group_id = a.target_group_id
       and gm_self.member_user_id = p_app_user_id
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
               from window_dates wd_t
              where wd_t.team_id_on_date = a.target_team_id
           )
         )
         or (
           a.target_kind = 'GROUP'
           and v_is_eligible
           and g.active is true
           and gm_self.member_user_id is not null
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
  eligible_assignment_dates as (
    select aa.*,
           wd.business_date,
           min(wd.business_date) over (partition by aa.assignment_id) as first_eligible_date
      from actor_assignments aa
      join window_dates wd
        on aa.effective_from <= wd.business_date
       and (aa.effective_to is null or wd.business_date <= aa.effective_to)
       and (
         aa.target_kind <> 'TEAM'
         or wd.team_id_on_date = aa.target_team_id
       )
       and (
         aa.target_kind <> 'GROUP'
         or aa.member_created_at <= aa.created_at
         or (aa.member_created_at at time zone 'Asia/Ho_Chi_Minh')::date <= wd.business_date
       )
  ),
  materialized as (
    select ead.template_id,
           ead.template_version_id,
           ead.assignment_id,
           ead.snapshot_group_id,
           ead.snapshot_group_name,
           ead.frequency,
           p.period_key,
           p.period_start_date,
           p.period_end_date,
           public.work_report_due_at(
             p.period_end_date,
             ead.due_day_offset,
             ead.due_time_local,
             ead.exclude_sundays
           ) as due_at,
           ead.is_mandatory,
           ead.created_at
      from eligible_assignment_dates ead
      cross join lateral public.work_report_period(ead.frequency, ead.business_date) p
     where ead.frequency <> 'ONCE'
        or (
          ead.business_date = ead.first_eligible_date
          and not exists (
            select 1
              from public.work_report_obligations o_once
             where o_once.assignment_id = ead.assignment_id
               and o_once.assignee_app_user_id = p_app_user_id
          )
        )
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
$$;

revoke all on function public.work_report__internal_actor_materialization_candidates(uuid, date, integer)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_materialize_actor_obligations(
  p_app_user_id uuid,
  p_business_date date,
  p_lookback_days integer default 7
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_days integer := greatest(least(coalesce(p_lookback_days, 7), 31), 1);
  v_window_start date;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today_vn date := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
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

  if public.attendance__internal_is_non_employee_account(p_app_user_id, v_now) then
    return 0;
  end if;

  v_window_start := p_business_date - (v_days - 1);

  -- Serialize concurrent personal-list materializations for the same actor without blocking other actors.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('work_report_materialize_actor'),
    pg_catalog.hashtext(p_app_user_id::text)
  );

  with candidates_with_team as (
    select d.*,
           case
             when a.target_kind = 'TEAM' then a.target_team_id
             else (
               select public.work_report__internal_team_on_date(p_app_user_id, gs::date)
                 from pg_catalog.generate_series(
                   greatest(d.period_start_date, v_window_start, a.effective_from)::timestamp,
                   least(d.period_end_date, p_business_date, coalesce(a.effective_to, p_business_date))::timestamp,
                   interval '1 day'
                 ) gs
                where public.attendance__internal_is_employee_obligated_on_date(
                        p_app_user_id,
                        gs::date,
                        v_today_vn,
                        v_now
                      )
                  and (
                    a.target_kind <> 'GROUP'
                    or gm_self.created_at <= a.created_at
                    or (gm_self.created_at at time zone 'Asia/Ho_Chi_Minh')::date <= gs::date
                  )
                order by gs desc
                limit 1
             )
           end as row_team_id
      from public.work_report__internal_actor_materialization_candidates(
             p_app_user_id,
             p_business_date,
             v_days
           ) d
      join public.work_report_assignments a
        on a.assignment_id = d.assignment_id
      left join public.work_report_group_members gm_self
        on a.target_kind = 'GROUP'
       and gm_self.group_id = a.target_group_id
       and gm_self.member_user_id = p_app_user_id
  ),
  inserted as (
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
           d.row_team_id,
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
      from candidates_with_team d
      left join public.teams t on t.team_id = d.row_team_id
     order by d.assignment_id, d.template_id, d.period_key
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
$$;

revoke all on function public.work_report__internal_materialize_actor_obligations(uuid, date, integer)
  from public, anon, authenticated, service_role;

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
as $$
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

  if public.attendance__internal_is_non_employee_account(p_app_user_id, pg_catalog.clock_timestamp()) then
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
$$;

revoke all on function public.work_report__internal_has_active_obligations_for_date(uuid, date, integer)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_materialize_assignment_for_date(
  p_assignment_id uuid,
  p_business_date date
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today_vn date := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
  v_inserted integer := 0;
begin
  if p_assignment_id is null or p_business_date is null then
    return 0;
  end if;

  with candidate as (
    select a.*,
           u.app_user_id as assignee_id,
           public.work_report__internal_team_on_date(u.app_user_id, p_business_date) as team_id,
           u.snapshot_group_id,
           u.snapshot_group_name
      from public.work_report_assignments a
      join public.work_report_templates tpl
        on tpl.template_id = a.template_id
       and tpl.status = 'ACTIVE'
      cross join lateral (
        select a.target_user_id as app_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
         where a.target_kind = 'USER'
        union all
        select x.target_user_id as app_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
          from public.work_report_assignment_targets x
         where a.target_kind = 'USER_SET'
           and x.assignment_id = a.assignment_id
        union all
        select distinct l.app_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiter_team_memberships m
            on m.recruiter_id = l.recruiter_id
         where a.target_kind = 'TEAM'
           and m.team_id = a.target_team_id
           and l.verified = true
           and l.valid_from <= p_business_date
           and (l.valid_to is null or (l.valid_to > l.valid_from and p_business_date < l.valid_to))
           and m.valid_from <= p_business_date
           and (m.valid_to is null or (m.valid_to > m.valid_from and p_business_date < m.valid_to))
           and public.work_report__internal_team_on_date(l.app_user_id, p_business_date) = a.target_team_id
        union all
        select gm.member_user_id as app_user_id,
               g.group_id as snapshot_group_id,
               g.display_name as snapshot_group_name
          from public.work_report_groups g
          join public.work_report_group_members gm
            on gm.group_id = g.group_id
         where a.target_kind = 'GROUP'
           and g.group_id = a.target_group_id
           and g.active
           and (
             gm.created_at <= a.created_at
             or (gm.created_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_business_date
           )
      ) u
     where a.assignment_id = p_assignment_id
       and a.is_current
       and a.state = 'ACTIVE'
       and a.effective_from <= p_business_date
       and (a.effective_to is null or p_business_date <= a.effective_to)
  ),
  authorized as (
    select c.*
      from candidate c
     where exists (
             select 1
               from public.direct_entry_app_users du
              where du.app_user_id = c.assignee_id
                and du.enabled
           )
       and public.attendance__internal_is_employee_obligated_on_date(
             c.assignee_id,
             p_business_date,
             v_today_vn,
             v_now
           )
       and (
             c.frequency <> 'ONCE'
             or not exists (
               select 1
                 from public.work_report_obligations o_once
                where o_once.assignment_id = c.assignment_id
                  and o_once.assignee_app_user_id = c.assignee_id
             )
           )
       and (
             c.target_kind <> 'GROUP'
             or (
               public.work_report__internal_is_eligible_assignee(c.assignee_id)
               and not exists (
                 select 1
                   from public.work_report_group_members gm_out
                  where gm_out.group_id = c.target_group_id
                    and not public.work_report__internal_actor_can_assign_member(
                      c.assigned_by_user_id,
                      gm_out.member_user_id,
                      c.template_id
                    )
               )
             )
           )
  ),
  materialized as (
    select a.*,
           p.period_key,
           p.period_start_date,
           p.period_end_date,
           public.work_report_due_at(
             p.period_end_date,
             a.due_day_offset,
             a.due_time_local,
             a.exclude_sundays
           ) as due_at
      from authorized a
      cross join lateral public.work_report_period(a.frequency, p_business_date) p
  ),
  deduplicated as (
    select distinct on (m.template_id, m.assignee_id, m.period_key)
           m.*
      from materialized m
     order by m.template_id, m.assignee_id, m.period_key, m.due_at asc, m.created_at asc, m.assignment_id asc
  ),
  inserted as (
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
           d.assignee_id,
           d.team_id,
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
      from deduplicated d
      left join public.teams t on t.team_id = d.team_id
     order by d.assignment_id, d.assignee_id, d.template_id, d.period_key
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
$$;

revoke all on function public.work_report__internal_materialize_assignment_for_date(uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.work_report_ensure_obligations_for_window(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_business_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today_vn date := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
  v_inserted integer;
  v_audit_scope text;
  v_lock_user_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_business_date is null then
    raise exception 'WORK_REPORT_DATE_INVALID' using errcode = '22023';
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + active report_assign delegation grantors.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.state = 'ACTIVE'
         and d.is_current
    ) u_ids
   where uid is not null;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of actor + grantors.
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);

  -- Tier WR-5 strict ASC FOR SHARE lock on actor's active report_assign delegations.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  with candidate as (
    select a.*,
           u.app_user_id as assignee_id,
           public.work_report__internal_team_on_date(u.app_user_id, p_business_date) as team_id,
           u.snapshot_group_id,
           u.snapshot_group_name
      from public.work_report_assignments a
      join public.work_report_templates tpl
        on tpl.template_id = a.template_id
       and tpl.status = 'ACTIVE'
      cross join lateral (
        select a.target_user_id as app_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
         where a.target_kind = 'USER'
        union all
        select x.target_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
          from public.work_report_assignment_targets x
         where a.target_kind = 'USER_SET'
           and x.assignment_id = a.assignment_id
        union all
        select distinct l.app_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiter_team_memberships m
            on m.recruiter_id = l.recruiter_id
         where a.target_kind = 'TEAM'
           and m.team_id = a.target_team_id
           and l.verified = true
           and l.valid_from <= p_business_date
           and (l.valid_to is null or (l.valid_to > l.valid_from and p_business_date < l.valid_to))
           and m.valid_from <= p_business_date
           and (m.valid_to is null or (m.valid_to > m.valid_from and p_business_date < m.valid_to))
           and public.work_report__internal_team_on_date(l.app_user_id, p_business_date) = a.target_team_id
        union all
        select gm.member_user_id,
               g.group_id as snapshot_group_id,
               g.display_name as snapshot_group_name
          from public.work_report_groups g
          join public.work_report_group_members gm
            on gm.group_id = g.group_id
         where a.target_kind = 'GROUP'
           and g.group_id = a.target_group_id
           and g.active
           and (
             gm.created_at <= a.created_at
             or (gm.created_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_business_date
           )
      ) u
     where a.is_current
       and a.state = 'ACTIVE'
       and a.effective_from <= p_business_date
       and (a.effective_to is null or p_business_date <= a.effective_to)
  ),
  authorized as (
    select c.*
      from candidate c
     where exists (
       select 1
         from public.work_report__internal_resolve_capability_authority(
           p_app_user_id,
           'report_assign',
           c.template_id,
           c.team_id
         ) auth
     )
       and public.attendance__internal_is_employee_obligated_on_date(
             c.assignee_id,
             p_business_date,
             v_today_vn,
             v_now
           )
       and (
             c.frequency <> 'ONCE'
             or not exists (
               select 1
                 from public.work_report_obligations o_once
                where o_once.assignment_id = c.assignment_id
                  and o_once.assignee_app_user_id = c.assignee_id
             )
           )
       and (
         c.target_kind <> 'GROUP'
         or (
           public.work_report__internal_is_eligible_assignee(c.assignee_id)
           and not exists (
             select 1
               from public.work_report_group_members gm_out
              where gm_out.group_id = c.target_group_id
                and not public.work_report__internal_actor_can_assign_member(
                  p_app_user_id,
                  gm_out.member_user_id,
                  c.template_id
                )
           )
         )
       )
  ),
  materialized as (
    select a.*,
           p.period_key,
           p.period_start_date,
           p.period_end_date,
           public.work_report_due_at(
             p.period_end_date,
             a.due_day_offset,
             a.due_time_local,
             a.exclude_sundays
           ) as due_at
      from authorized a
      cross join lateral public.work_report_period(a.frequency, p_business_date) p
  ),
  deduplicated as (
    select distinct on (m.template_id, m.assignee_id, m.period_key)
           m.*
      from materialized m
     where exists (
       select 1
         from public.direct_entry_app_users u
        where u.app_user_id = m.assignee_id
          and u.enabled
     )
     order by m.template_id, m.assignee_id, m.period_key, m.due_at asc, m.created_at asc, m.assignment_id asc
  ),
  inserted as (
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
           d.assignee_id,
           d.team_id,
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
      from deduplicated d
      left join public.teams t on t.team_id = d.team_id
     order by d.assignment_id, d.assignee_id, d.template_id, d.period_key
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

  v_audit_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'all'
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      ) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    outcome,
    metadata_json
  )
  values (
    'OBLIGATION_MATERIALIZE',
    p_app_user_id,
    'report_assign',
    v_audit_scope,
    'APPLIED',
    jsonb_build_object('business_date', p_business_date, 'inserted_count', v_inserted)
  );

  return jsonb_build_object('business_date', p_business_date, 'inserted_count', v_inserted);
end;
$$;

revoke all on function public.work_report_ensure_obligations_for_window(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function public.work_report_ensure_obligations_for_window(uuid, uuid, date)
  to service_role;

create or replace function public.work_report_create_assignment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_target_kind text,
  p_target_user_id uuid,
  p_target_team_id uuid,
  p_target_user_ids uuid[],
  p_frequency text,
  p_is_mandatory boolean,
  p_due_day_offset integer,
  p_due_time_local time without time zone,
  p_exclude_sundays boolean,
  p_effective_from date,
  p_effective_to date,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_template public.work_report_templates%rowtype;
  v_assignment_id uuid;
  v_scope text;
  v_scope_team_id uuid;
  v_delegation_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_person_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_target_kind not in ('USER', 'TEAM', 'USER_SET')
     or p_frequency not in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')
     or p_due_day_offset not between 0 and 31
     or p_effective_from is null
     or (p_effective_to is not null and p_effective_to < p_effective_from)
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;
  if (p_target_kind = 'USER') <> (p_target_user_id is not null and p_target_team_id is null)
     or (p_target_kind = 'TEAM') <> (p_target_team_id is not null and p_target_user_id is null)
     or (p_target_kind = 'USER_SET' and (p_target_user_id is not null or p_target_team_id is not null)) then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;
  if p_target_kind = 'USER_SET' and coalesce(cardinality(p_target_user_ids), 0) < 1 then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;

  -- Collect user set for strict Tier 1 -> Tier 2 -> Tier 3 locking.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.template_id = p_template_id
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select p_target_user_id as uid
       where p_target_kind = 'USER' and p_target_user_id is not null
      union all
      select x.uid
        from unnest(coalesce(p_target_user_ids, array[]::uuid[])) as x(uid)
       where p_target_kind = 'USER_SET' and x.uid is not null
    ) u_ids
   where uid is not null;

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + active report_assign delegation grantors + target users.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of actor, grantors & target users (serializes against move_team_membership for USER, USER_SET, and delegated TEAM).
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_target_kind = 'TEAM' then
    v_scope_team_id := p_target_team_id;
  elsif p_target_kind = 'USER' then
    v_scope_team_id := public.work_report_resolve_assignment_user_team(p_target_user_id);
  end if;

  select * into v_template from public.work_report_templates where template_id = p_template_id for share;

  -- Tier WR-3 FOR SHARE on active report_assign delegations for this actor + template.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.template_id = p_template_id
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if p_target_kind in ('USER', 'TEAM') then
    select a.acting_scope_kind, a.delegation_id
      into v_scope, v_delegation_id
      from public.work_report__internal_resolve_capability_authority(
        p_app_user_id, 'report_assign', p_template_id, v_scope_team_id
      ) a;
    if v_scope is null then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if p_target_kind = 'USER'
       and not public.work_report__internal_is_eligible_assignee(p_target_user_id) then
      raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
    end if;
  else
    if exists (
      select 1
        from unnest(p_target_user_ids) x(user_id)
       where not exists (
         select 1
           from public.work_report__internal_resolve_capability_authority(
             p_app_user_id, 'report_assign', p_template_id, public.work_report_current_team(x.user_id)
           ) a
       )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if exists (
      select 1
        from unnest(p_target_user_ids) x(user_id)
       where not public.work_report__internal_is_eligible_assignee(x.user_id)
    ) then
      raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
    end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
        or exists (
          select 1
            from public.work_report_delegations d
           where d.delegate_app_user_id = p_app_user_id
             and d.capability = 'report_assign'
             and d.template_id = p_template_id
             and d.scope_kind = 'all'
             and public.work_report__internal_is_delegation_effective(d.delegation_id)
        ) then 'all'
      else 'team'
    end;
  end if;

  if v_template.template_id is null or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id', p_template_id,
    'target_kind', p_target_kind,
    'target_user_id', p_target_user_id,
    'target_team_id', p_target_team_id,
    'target_user_ids', p_target_user_ids,
    'frequency', p_frequency,
    'is_mandatory', p_is_mandatory,
    'due_day_offset', p_due_day_offset,
    'due_time_local', p_due_time_local,
    'exclude_sundays', p_exclude_sundays,
    'effective_from', p_effective_from,
    'effective_to', p_effective_to
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'work_report_assignment_create', p_idempotency_key, v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  insert into public.work_report_assignments (
    template_id,
    template_version_id,
    target_kind,
    target_user_id,
    target_team_id,
    frequency,
    is_mandatory,
    due_day_offset,
    due_time_local,
    exclude_sundays,
    effective_from,
    effective_to,
    assigned_by_user_id
  )
  values (
    p_template_id,
    v_template.current_published_version_id,
    p_target_kind,
    p_target_user_id,
    p_target_team_id,
    p_frequency,
    coalesce(p_is_mandatory, true),
    p_due_day_offset,
    p_due_time_local,
    coalesce(p_exclude_sundays, false),
    p_effective_from,
    p_effective_to,
    p_app_user_id
  )
  returning assignment_id into v_assignment_id;

  if p_target_kind = 'USER_SET' then
    insert into public.work_report_assignment_targets (assignment_id, target_user_id)
      select v_assignment_id, x
        from (select distinct unnest(p_target_user_ids) x) q;
  end if;

  perform public.work_report__internal_materialize_assignment_for_date(
    v_assignment_id,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    scope_team_id,
    template_id,
    outcome,
    metadata_json
  )
  values (
    'ASSIGNMENT_CREATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    case when v_scope = 'team' then v_scope_team_id else null end,
    p_template_id,
    'APPLIED',
    jsonb_build_object(
      'assignment_id', v_assignment_id,
      'target_kind', p_target_kind,
      'delegation_id', v_delegation_id
    )
  );

  v_result := jsonb_build_object('assignment_id', v_assignment_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'work_report_assignment_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.work_report_create_assignment(
  uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text
) from public, anon, authenticated;
grant execute on function public.work_report_create_assignment(
  uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text
) to service_role;

create or replace function public.work_report_list_assignment_options(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_direct_all boolean;
  v_direct_team_ids uuid[];
  v_direct_has_team boolean;
  v_delegated_all boolean;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_direct_all := public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null);
  v_direct_team_ids := public.work_report__internal_direct_team_ids(p_app_user_id, 'report_assign');
  v_direct_has_team := coalesce(pg_catalog.cardinality(v_direct_team_ids), 0) > 0;
  v_delegated_all := exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = 'report_assign'
       and d.scope_kind = 'all'
       and public.work_report__internal_is_delegation_effective(d.delegation_id)
  );

  if p_team_id is not null then
    if not exists (
      select 1 from public.teams t
       where t.team_id = p_team_id
         and t.active
         and t.code <> '__system_vendor__'
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if not (
      v_direct_all
      or v_delegated_all
      or p_team_id = any(v_direct_team_ids)
      or exists (
        select 1 from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'team'
           and d.scope_team_id = p_team_id
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'templates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'template_id', t.template_id,
        'template_code', t.template_code,
        'display_name', t.display_name,
        'default_frequency', t.default_frequency,
        'current_published_version_id', t.current_published_version_id
      ) order by t.template_code)
        from public.work_report_templates t
       where t.status = 'ACTIVE'
         and t.current_published_version_id is not null
         and (
           v_direct_all
           or v_direct_has_team
           or exists (
             select 1 from public.work_report_delegations d
              where d.delegate_app_user_id = p_app_user_id
                and d.capability = 'report_assign'
                and d.template_id = t.template_id
                and public.work_report__internal_is_delegation_effective(d.delegation_id)
           )
         )
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'team_id', t.team_id, 'code', t.code, 'display_name', t.display_name
      ) order by t.code)
        from public.teams t
       where t.active
         and t.code <> '__system_vendor__'
         and (
           v_direct_all
           or v_delegated_all
           or t.team_id = any(v_direct_team_ids)
           or exists (
             select 1 from public.work_report_delegations d
              where d.delegate_app_user_id = p_app_user_id
                and d.capability = 'report_assign'
                and d.scope_kind = 'team'
                and d.scope_team_id = t.team_id
                and public.work_report__internal_is_delegation_effective(d.delegation_id)
           )
         )
    ), '[]'::jsonb),
    'users', case when p_team_id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'app_user_id', eligible.app_user_id, 'display_name', eligible.display_name
      ) order by eligible.display_name, eligible.app_user_id)
        from (
          select distinct
                 u.app_user_id,
                 coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name
            from public.direct_entry_app_user_recruiter_links l
            join public.direct_entry_app_users u on u.app_user_id = l.app_user_id and u.enabled
            join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
            join public.recruiter_team_memberships m on m.recruiter_id = r.recruiter_id
              and m.team_id = p_team_id and m.is_current
           where l.verified and l.is_current
             and public.work_report__internal_is_eligible_assignee(u.app_user_id)
             and exists (
               select 1 from public.teams t
                where t.team_id = p_team_id
                  and t.active
                  and t.code <> '__system_vendor__'
             )
        ) eligible
    ), '[]'::jsonb) end
  );
end;
$$;

revoke all on function public.work_report_list_assignment_options(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.work_report_list_assignment_options(uuid, uuid, uuid)
  to service_role;

create or replace function public.work_report_list_assignments(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_direct_all boolean;
  v_direct_team_ids uuid[];
  v_delegated_all boolean;
begin
  perform public.work_report__internal_assert_read_actor(p_auth_subject, p_app_user_id, null);
  v_direct_all := public.work_report__internal_has_read_scope(p_app_user_id, 'report_assign', 'all', null);
  v_direct_team_ids := public.work_report__internal_read_team_ids(p_app_user_id, 'report_assign');

  if not v_direct_all
     and coalesce(pg_catalog.cardinality(v_direct_team_ids), 0) = 0
     and not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_delegated_all := exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = 'report_assign'
       and d.scope_kind = 'all'
       and public.work_report__internal_is_delegation_effective(d.delegation_id)
  );

  if p_team_id is not null then
    if not exists (
      select 1 from public.teams t
       where t.team_id = p_team_id
         and t.active
         and t.code <> '__system_vendor__'
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if not (
      v_direct_all
      or v_delegated_all
      or p_team_id = any(v_direct_team_ids)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'team'
           and d.scope_team_id = p_team_id
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'assignment_id', tracked.assignment_id,
      'template_id', tracked.template_id,
      'template_code', tracked.template_code,
      'template_name', tracked.template_name,
      'target_kind', tracked.target_kind,
      'target_group_id', tracked.target_group_id,
      'target_label', tracked.target_label,
      'target_member_count', tracked.target_member_count,
      'frequency', tracked.frequency,
      'is_mandatory', tracked.is_mandatory,
      'due_day_offset', tracked.due_day_offset,
      'due_time_local', to_char(tracked.due_time_local, 'HH24:MI:SS'),
      'exclude_sundays', tracked.exclude_sundays,
      'effective_from', tracked.effective_from,
      'effective_to', tracked.effective_to,
      'state', tracked.state,
      'version', tracked.version,
      'created_at', tracked.created_at,
      'obligation_total', tracked.obligation_total,
      'submitted_count', tracked.submitted_count,
      'not_started_count', tracked.not_started_count,
      'draft_count', tracked.draft_count,
      'overdue_count', tracked.overdue_count,
      'rejected_count', tracked.rejected_count,
      'exempted_count', tracked.exempted_count,
      'cancelled_count', tracked.cancelled_count
    ) order by tracked.updated_at desc, tracked.assignment_id)
      from (
        select a.assignment_id,
               a.template_id,
               t.template_code,
               t.display_name as template_name,
               a.target_kind,
               a.target_group_id,
               case a.target_kind
                 when 'TEAM' then coalesce(team.display_name, team.code, 'Nhóm không còn hoạt động')
                 when 'USER' then coalesce(
                   public.work_report__internal_user_display_name(a.target_user_id),
                   target_user.display_name,
                   'Tài khoản không còn hoạt động'
                 )
                 when 'GROUP' then case
                   when grp.group_id is null then 'Nhóm báo cáo'
                   when grp.active then grp.display_name
                   else grp.display_name || ' (Ngừng sử dụng)'
                 end
                 else coalesce(target_list.target_label, 'Danh sách nhân viên')
               end as target_label,
               case a.target_kind
                 when 'USER' then 1
                 when 'USER_SET' then coalesce(target_list.member_count, 0)
                 when 'GROUP' then coalesce((
                   select count(*)::integer
                     from public.work_report_group_members gm_cnt
                    where gm_cnt.group_id = a.target_group_id
                      and public.work_report__internal_is_eligible_assignee(gm_cnt.member_user_id)
                 ), 0)
                 when 'TEAM' then coalesce((
                   select count(distinct l.app_user_id)::integer
                     from public.direct_entry_app_user_recruiter_links l
                     join public.recruiters r
                       on r.recruiter_id = l.recruiter_id
                      and r.active
                     join public.recruiter_team_memberships m
                       on m.recruiter_id = l.recruiter_id
                      and m.is_current
                     join public.direct_entry_app_users du
                       on du.app_user_id = l.app_user_id
                      and du.enabled
                    where m.team_id = a.target_team_id
                      and l.verified
                      and l.is_current
                      and public.work_report__internal_is_eligible_assignee(l.app_user_id)
                 ), 0)
                 else 0
               end as target_member_count,
               a.frequency,
               a.is_mandatory,
               a.due_day_offset,
               a.due_time_local,
               a.exclude_sundays,
               a.effective_from,
               a.effective_to,
               a.state,
               a.version,
               a.created_at,
               a.updated_at,
               count(o.obligation_id)::integer as obligation_total,
               count(o.obligation_id) filter (where s.first_submitted_at is not null)::integer as submitted_count,
               count(o.obligation_id) filter (where o.obligation_status = 'ACTIVE' and s.submission_id is null)::integer as not_started_count,
               count(o.obligation_id) filter (where o.obligation_status = 'ACTIVE' and s.state = 'DRAFT')::integer as draft_count,
               count(o.obligation_id) filter (
                 where o.obligation_status = 'ACTIVE'
                   and coalesce(s.state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT')
                   and now() > o.due_at
                   and coalesce(o.reopened_until < now(), true)
               )::integer as overdue_count,
               count(o.obligation_id) filter (
                 where o.obligation_status = 'ACTIVE'
                   and s.state = 'REJECTED'
               )::integer as rejected_count,
               count(o.obligation_id) filter (where o.obligation_status = 'EXEMPTED')::integer as exempted_count,
               count(o.obligation_id) filter (where o.obligation_status = 'CANCELLED')::integer as cancelled_count
          from public.work_report_assignments a
          join public.work_report_templates t on t.template_id = a.template_id
          left join public.teams team on team.team_id = a.target_team_id
          left join public.direct_entry_app_users target_user on target_user.app_user_id = a.target_user_id
          left join public.work_report_groups grp on grp.group_id = a.target_group_id
          left join lateral (
            select string_agg(
                     coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name),
                     ', '
                     order by coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name), u.app_user_id
                   ) as target_label,
                   count(*)::integer as member_count
              from public.work_report_assignment_targets x
              join public.direct_entry_app_users u on u.app_user_id = x.target_user_id
             where x.assignment_id = a.assignment_id
          ) target_list on true
          left join public.work_report_obligations o on o.assignment_id = a.assignment_id
          left join public.work_report_submissions s on s.obligation_id = o.obligation_id
         where (
           (a.target_kind = 'TEAM' and (
             v_direct_all
             or (a.target_team_id is not null and a.target_team_id = any(v_direct_team_ids))
             or exists (
               select 1
                 from public.work_report__internal_resolve_capability_authority(
                   p_app_user_id, 'report_assign', a.template_id, a.target_team_id
                 )
             )
           )) or
           (a.target_kind = 'USER' and (
             v_direct_all
             or (
               public.work_report_current_team(a.target_user_id) is not null
               and public.work_report_current_team(a.target_user_id) = any(v_direct_team_ids)
             )
             or exists (
               select 1
                 from public.work_report__internal_resolve_capability_authority(
                   p_app_user_id, 'report_assign', a.template_id, public.work_report_current_team(a.target_user_id)
                 )
             )
           )) or
           (a.target_kind = 'USER_SET'
             and exists (select 1 from public.work_report_assignment_targets x where x.assignment_id = a.assignment_id)
             and not exists (
               select 1
                 from public.work_report_assignment_targets x
                where x.assignment_id = a.assignment_id
                  and not coalesce(
                    v_direct_all
                    or (
                      public.work_report_current_team(x.target_user_id) is not null
                      and public.work_report_current_team(x.target_user_id) = any(v_direct_team_ids)
                    )
                    or exists (
                      select 1
                        from public.work_report__internal_resolve_capability_authority(
                          p_app_user_id, 'report_assign', a.template_id, public.work_report_current_team(x.target_user_id)
                        )
                    ),
                    false
                  )
             )
           ) or
           (a.target_kind = 'GROUP'
             and exists (select 1 from public.work_report_group_members gm where gm.group_id = a.target_group_id)
             and not exists (
               select 1
                 from public.work_report_group_members gm
                where gm.group_id = a.target_group_id
                  and not coalesce(
                    v_direct_all
                    or (
                      public.work_report_current_team(gm.member_user_id) is not null
                      and public.work_report_current_team(gm.member_user_id) = any(v_direct_team_ids)
                    )
                    or public.work_report__internal_actor_can_assign_member(
                      p_app_user_id,
                      gm.member_user_id,
                      a.template_id
                    ),
                    false
                  )
             )
           )
         )
           and (
             p_team_id is null
             or (a.target_kind = 'TEAM' and a.target_team_id = p_team_id)
             or (a.target_kind = 'USER' and public.work_report_current_team(a.target_user_id) = p_team_id)
             or (a.target_kind = 'USER_SET' and exists (
               select 1
                 from public.work_report_assignment_targets x
                where x.assignment_id = a.assignment_id
                  and public.work_report_current_team(x.target_user_id) = p_team_id
             ))
             or (a.target_kind = 'GROUP' and exists (
               select 1
                 from public.work_report_group_members gm
                where gm.group_id = a.target_group_id
                  and public.work_report_current_team(gm.member_user_id) = p_team_id
             ))
           )
         group by a.assignment_id, t.template_code, t.display_name, team.display_name, team.code,
           target_user.display_name, grp.group_id, grp.display_name, grp.active,
           target_list.target_label, target_list.member_count
      ) tracked
  ), '[]'::jsonb));
end;
$$;

revoke all on function public.work_report_list_assignments(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.work_report_list_assignments(uuid, uuid, uuid)
  to service_role;

create or replace function public.work_report_set_assignment_state(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_expected_version integer,
  p_state text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_assignment public.work_report_assignments%rowtype;
  v_group_active boolean;
  v_team_id uuid;
  v_scope text;
  v_delegation_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_pre_group_id uuid;
  v_lock_user_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_state not in ('ACTIVE', 'PAUSED', 'REVOKED') then
    raise exception 'WORK_REPORT_ASSIGNMENT_STATE_INVALID' using errcode = '22023';
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + active report_assign grantors + target members.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select a.target_user_id as uid
        from public.work_report_assignments a
       where a.assignment_id = p_assignment_id
         and a.target_kind = 'USER'
         and a.target_user_id is not null
      union all
      select t.target_user_id as uid
        from public.work_report_assignment_targets t
       where t.assignment_id = p_assignment_id
      union all
      select gm.member_user_id as uid
        from public.work_report_assignments a
        join public.work_report_group_members gm on gm.group_id = a.target_group_id
       where a.assignment_id = p_assignment_id
         and a.target_kind = 'GROUP'
    ) u_ids
   where uid is not null;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of actor, grantors & target members.
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  -- Tier WR-1 FOR SHARE on target group (if GROUP assignment) before locking assignment row.
  select a.target_group_id
    into v_pre_group_id
    from public.work_report_assignments a
   where a.assignment_id = p_assignment_id
     and a.target_kind = 'GROUP';

  if v_pre_group_id is not null then
    perform g.group_id
      from public.work_report_groups g
     where g.group_id = v_pre_group_id
     for share;
  end if;

  select *
    into v_assignment
    from public.work_report_assignments
   where assignment_id = p_assignment_id
     for update;
  if not found then
    raise exception 'WORK_REPORT_ASSIGNMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier WR-5 strict ASC FOR SHARE lock on active report_assign delegations for actor + template.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.template_id = v_assignment.template_id
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  -- Non-throwing current-team lookup allows all-scope Admin to PAUSE/REVOKE a USER assignment
  -- even after target user leaves their team or is disabled; team-scoped actors still fail closed.
  v_team_id := case v_assignment.target_kind
    when 'TEAM' then v_assignment.target_team_id
    when 'USER' then public.work_report_current_team(v_assignment.target_user_id)
    else null
  end;

  if v_assignment.target_kind = 'USER_SET' then
    if exists (
      select 1
        from public.work_report_assignment_targets x
       where x.assignment_id = p_assignment_id
         and not exists (
           select 1
             from public.work_report__internal_resolve_capability_authority(
               p_app_user_id,
               'report_assign',
               v_assignment.template_id,
               public.work_report_current_team(x.target_user_id)
             ) a
         )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
        or exists (
          select 1
            from public.work_report_delegations d
           where d.delegate_app_user_id = p_app_user_id
             and d.capability = 'report_assign'
             and d.template_id = v_assignment.template_id
             and d.scope_kind = 'all'
             and public.work_report__internal_is_delegation_effective(d.delegation_id)
        ) then 'all'
      else 'team'
    end;
  elsif v_assignment.target_kind = 'GROUP' then
    if not exists (
      select 1
        from public.work_report_group_members gm0
       where gm0.group_id = v_assignment.target_group_id
    ) or exists (
      select 1
        from public.work_report_group_members gm
       where gm.group_id = v_assignment.target_group_id
         and not public.work_report__internal_actor_can_assign_member(
           p_app_user_id,
           gm.member_user_id,
           v_assignment.template_id
         )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if p_state = 'ACTIVE' then
      select g.active
        into v_group_active
        from public.work_report_groups g
       where g.group_id = v_assignment.target_group_id;
      if not coalesce(v_group_active, false) then
        raise exception 'WORK_REPORT_GROUP_INACTIVE' using errcode = '22023';
      end if;
    end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
        or exists (
          select 1
            from public.work_report_delegations d
           where d.delegate_app_user_id = p_app_user_id
             and d.capability = 'report_assign'
             and d.template_id = v_assignment.template_id
             and d.scope_kind = 'all'
             and public.work_report__internal_is_delegation_effective(d.delegation_id)
        ) then 'all'
      else 'team'
    end;
  else
    select a.acting_scope_kind, a.delegation_id
      into v_scope, v_delegation_id
      from public.work_report__internal_resolve_capability_authority(
        p_app_user_id,
        'report_assign',
        v_assignment.template_id,
        v_team_id
      ) a;
    if v_scope is null then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'assignment_id', p_assignment_id,
    'expected_version', p_expected_version,
    'state', p_state
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_assignment_state',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_assignment.version <> p_expected_version then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  update public.work_report_assignments
     set state = p_state,
         is_current = (p_state <> 'REVOKED'),
         version = version + 1,
         updated_at = now()
   where assignment_id = p_assignment_id;

  if p_state = 'REVOKED' then
    update public.work_report_obligations
       set obligation_status = 'CANCELLED',
           status_changed_by_user_id = p_app_user_id,
           version = version + 1,
           updated_at = now()
     where assignment_id = p_assignment_id
       and obligation_status = 'ACTIVE'
       and not exists (
         select 1
           from public.work_report_submissions s
          where s.obligation_id = work_report_obligations.obligation_id
            and s.first_submitted_at is not null
       );
  elsif p_state = 'ACTIVE' then
    perform public.work_report__internal_materialize_assignment_for_date(
      p_assignment_id,
      (now() at time zone 'Asia/Ho_Chi_Minh')::date
    );
  end if;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    scope_team_id,
    template_id,
    outcome,
    metadata_json
  )
  values (
    'ASSIGNMENT_STATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    case when v_scope = 'team' then v_team_id end,
    v_assignment.template_id,
    'APPLIED',
    jsonb_build_object(
      'assignment_id', p_assignment_id,
      'state', p_state,
      'delegation_id', v_delegation_id
    )
  );

  v_result := jsonb_build_object(
    'assignment_id', p_assignment_id,
    'state', p_state,
    'version', p_expected_version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_assignment_state',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$$;

revoke all on function public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)
  to service_role;

create or replace function public.work_report_create_group(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_display_name text,
  p_description text,
  p_member_user_ids uuid[],
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_name text;
  v_description text;
  v_distinct_count integer;
  v_group_id uuid;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_person_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_name := pg_catalog.btrim(coalesce(p_display_name, ''));
  v_description := case
    when p_description is null then null
    else nullif(pg_catalog.btrim(p_description), '')
  end;

  if pg_catalog.length(v_name) not between 1 and 160
     or (v_description is not null and pg_catalog.length(v_description) > 1000)
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128
     or coalesce(cardinality(p_member_user_ids), 0) < 1
     or exists (select 1 from unnest(p_member_user_ids) as x(uid) where x.uid is null) then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  select count(distinct x.uid)::integer
    into v_distinct_count
    from unnest(p_member_user_ids) as x(uid);
  if v_distinct_count <> cardinality(p_member_user_ids) then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select x.uid
        from unnest(p_member_user_ids) as x(uid)
    ) u_ids
   where uid is not null;

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + grantors + target members.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of actor, grantors & target members (serializes against move_team_membership).
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  -- Tier WR-5 strict ASC FOR SHARE lock on actor's active report_assign delegations.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_actor_can_assign_member(p_app_user_id, x.uid, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_is_eligible_assignee(x.uid)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'display_name', v_name,
    'description', v_description,
    'member_user_ids', (
      select jsonb_agg(x.uid order by x.uid)
        from unnest(p_member_user_ids) as x(uid)
    )
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_group_create',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  insert into public.work_report_groups (
    display_name,
    description,
    active,
    created_by_user_id,
    updated_by_user_id
  )
  values (
    v_name,
    v_description,
    true,
    p_app_user_id,
    p_app_user_id
  )
  returning group_id into v_group_id;

  insert into public.work_report_group_members (
    group_id,
    member_user_id,
    added_by_user_id
  )
  select v_group_id, x.uid, p_app_user_id
    from unnest(p_member_user_ids) as x(uid);

  v_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'all'
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      ) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    outcome,
    metadata_json
  )
  values (
    'GROUP_CREATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    'APPLIED',
    jsonb_build_object(
      'group_id', v_group_id,
      'member_count', v_distinct_count
    )
  );

  v_result := jsonb_build_object('group_id', v_group_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_group_create',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$$;

revoke all on function public.work_report_create_group(uuid, uuid, text, text, uuid[], text)
  from public, anon, authenticated;
grant execute on function public.work_report_create_group(uuid, uuid, text, text, uuid[], text)
  to service_role;

create or replace function public.work_report_update_group(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_group_id uuid,
  p_expected_version integer,
  p_display_name text,
  p_description text,
  p_member_user_ids uuid[],
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_group public.work_report_groups%rowtype;
  v_name text;
  v_description text;
  v_distinct_count integer;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_person_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_name := pg_catalog.btrim(coalesce(p_display_name, ''));
  v_description := case
    when p_description is null then null
    else nullif(pg_catalog.btrim(p_description), '')
  end;

  if p_group_id is null
     or p_expected_version is null or p_expected_version < 1
     or pg_catalog.length(v_name) not between 1 and 160
     or (v_description is not null and pg_catalog.length(v_description) > 1000)
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128
     or coalesce(cardinality(p_member_user_ids), 0) < 1
     or exists (select 1 from unnest(p_member_user_ids) as x(uid) where x.uid is null) then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  select count(distinct x.uid)::integer
    into v_distinct_count
    from unnest(p_member_user_ids) as x(uid);
  if v_distinct_count <> cardinality(p_member_user_ids) then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select gm.member_user_id as uid
        from public.work_report_group_members gm
       where gm.group_id = p_group_id
      union all
      select x.uid
        from unnest(p_member_user_ids) as x(uid)
    ) u_ids
   where uid is not null;

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + grantors + existing & target group members.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of group members.
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  select *
    into v_group
    from public.work_report_groups g
   where g.group_id = p_group_id
     for update;

  if not found then
    raise exception 'WORK_REPORT_GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier WR-5 strict ASC FOR SHARE lock on actor's active report_assign delegations.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_group_id
       and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm.member_user_id, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_actor_can_assign_member(p_app_user_id, x.uid, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'group_id', p_group_id,
    'expected_version', p_expected_version,
    'display_name', v_name,
    'description', v_description,
    'member_user_ids', (
      select jsonb_agg(x.uid order by x.uid)
        from unnest(p_member_user_ids) as x(uid)
    )
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_group_update',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_group.version <> p_expected_version then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_is_eligible_assignee(x.uid)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  update public.work_report_groups
     set display_name = v_name,
         description = v_description,
         updated_by_user_id = p_app_user_id,
         version = version + 1,
         updated_at = now()
   where group_id = p_group_id;

  delete from public.work_report_group_members gm
   where gm.group_id = p_group_id
     and not (gm.member_user_id = any(p_member_user_ids));

  insert into public.work_report_group_members (
    group_id,
    member_user_id,
    added_by_user_id
  )
  select p_group_id, x.uid, p_app_user_id
    from unnest(p_member_user_ids) as x(uid)
  on conflict (group_id, member_user_id) do nothing;

  v_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'all'
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      ) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    outcome,
    metadata_json
  )
  values (
    'GROUP_UPDATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    'APPLIED',
    jsonb_build_object(
      'group_id', p_group_id,
      'member_count', v_distinct_count,
      'version', p_expected_version + 1
    )
  );

  v_result := jsonb_build_object('group_id', p_group_id, 'version', p_expected_version + 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_group_update',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$$;

revoke all on function public.work_report_update_group(uuid, uuid, uuid, integer, text, text, uuid[], text)
  from public, anon, authenticated;
grant execute on function public.work_report_update_group(uuid, uuid, uuid, integer, text, text, uuid[], text)
  to service_role;

create or replace function public.work_report_set_group_active(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_group_id uuid,
  p_expected_version integer,
  p_active boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_group public.work_report_groups%rowtype;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_person_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_group_id is null
     or p_expected_version is null or p_expected_version < 1
     or p_active is null
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select gm.member_user_id as uid
        from public.work_report_group_members gm
       where gm.group_id = p_group_id
    ) u_ids
   where uid is not null;

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + grantors + group members.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of group members.
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  select *
    into v_group
    from public.work_report_groups g
   where g.group_id = p_group_id
     for update;

  if not found then
    raise exception 'WORK_REPORT_GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier WR-5 strict ASC FOR SHARE lock on actor's active report_assign delegations.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if not exists (
    select 1
      from public.work_report_group_members gm0
     where gm0.group_id = p_group_id
  ) or exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_group_id
       and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm.member_user_id, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'group_id', p_group_id,
    'expected_version', p_expected_version,
    'active', p_active
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_group_active',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_group.version <> p_expected_version then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if p_active and not exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_group_id
       and public.work_report__internal_is_eligible_assignee(gm.member_user_id)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  update public.work_report_groups
     set active = p_active,
         updated_by_user_id = p_app_user_id,
         version = version + 1,
         updated_at = now()
   where group_id = p_group_id;

  v_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'all'
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      ) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    outcome,
    metadata_json
  )
  values (
    case when p_active then 'GROUP_ACTIVATE' else 'GROUP_DEACTIVATE' end,
    p_app_user_id,
    'report_assign',
    v_scope,
    'APPLIED',
    jsonb_build_object(
      'group_id', p_group_id,
      'active', p_active,
      'version', p_expected_version + 1
    )
  );

  v_result := jsonb_build_object(
    'group_id', p_group_id,
    'active', p_active,
    'version', p_expected_version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_group_active',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$$;

revoke all on function public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)
  from public, anon, authenticated;
grant execute on function public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)
  to service_role;

create or replace function public.work_report_create_group_assignment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_target_group_id uuid,
  p_frequency text,
  p_is_mandatory boolean,
  p_due_day_offset integer,
  p_due_time_local time without time zone,
  p_exclude_sundays boolean,
  p_effective_from date,
  p_effective_to date,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_template public.work_report_templates%rowtype;
  v_group public.work_report_groups%rowtype;
  v_assignment_id uuid;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_person_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_template_id is null
     or p_target_group_id is null
     or p_frequency not in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')
     or p_due_day_offset not between 0 and 31
     or p_due_time_local is null
     or p_effective_from is null
     or (p_effective_to is not null and p_effective_to < p_effective_from)
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.template_id = p_template_id
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select gm.member_user_id as uid
        from public.work_report_group_members gm
       where gm.group_id = p_target_group_id
    ) u_ids
   where uid is not null;

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + active report_assign delegation grantors + group members.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of group members (serializes against move_team_membership).
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  select *
    into v_group
    from public.work_report_groups g
   where g.group_id = p_target_group_id
     for share;

  if not found then
    raise exception 'WORK_REPORT_GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  select *
    into v_template
    from public.work_report_templates t
   where t.template_id = p_template_id
     for share;

  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.template_id = p_template_id
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if not exists (
    select 1
      from public.work_report_group_members gm0
     where gm0.group_id = p_target_group_id
  ) or exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_target_group_id
       and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm.member_user_id, p_template_id)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if not v_group.active then
    raise exception 'WORK_REPORT_GROUP_INACTIVE' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_target_group_id
       and public.work_report__internal_is_eligible_assignee(gm.member_user_id)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  if v_template.template_id is null or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id', p_template_id,
    'target_kind', 'GROUP',
    'target_group_id', p_target_group_id,
    'frequency', p_frequency,
    'is_mandatory', p_is_mandatory,
    'due_day_offset', p_due_day_offset,
    'due_time_local', p_due_time_local,
    'exclude_sundays', p_exclude_sundays,
    'effective_from', p_effective_from,
    'effective_to', p_effective_to
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_assignment_create',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  insert into public.work_report_assignments (
    template_id,
    template_version_id,
    target_kind,
    target_user_id,
    target_team_id,
    target_group_id,
    frequency,
    is_mandatory,
    due_day_offset,
    due_time_local,
    exclude_sundays,
    effective_from,
    effective_to,
    assigned_by_user_id
  )
  values (
    p_template_id,
    v_template.current_published_version_id,
    'GROUP',
    null,
    null,
    p_target_group_id,
    p_frequency,
    coalesce(p_is_mandatory, true),
    p_due_day_offset,
    p_due_time_local,
    coalesce(p_exclude_sundays, false),
    p_effective_from,
    p_effective_to,
    p_app_user_id
  )
  returning assignment_id into v_assignment_id;

  perform public.work_report__internal_materialize_assignment_for_date(
    v_assignment_id,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  v_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.template_id = p_template_id
           and d.scope_kind = 'all'
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      ) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    template_id,
    outcome,
    metadata_json
  )
  values (
    'ASSIGNMENT_CREATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    p_template_id,
    'APPLIED',
    jsonb_build_object(
      'assignment_id', v_assignment_id,
      'target_kind', 'GROUP',
      'target_group_id', p_target_group_id
    )
  );

  v_result := jsonb_build_object('assignment_id', v_assignment_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_assignment_create',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$$;

revoke all on function public.work_report_create_group_assignment(
  uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text
) from public, anon, authenticated;
grant execute on function public.work_report_create_group_assignment(
  uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text
) to service_role;

create or replace function public.work_report_create_delegation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text,
  p_delegate_app_user_id uuid,
  p_template_id uuid,
  p_scope_kind text,
  p_scope_team_id uuid,
  p_effective_from timestamp with time zone default null,
  p_effective_to timestamp with time zone default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
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
     or v_delegate.account_type is distinct from 'NORMAL'
     or public.attendance__internal_is_non_employee_account(p_delegate_app_user_id, v_check_now)
     or public.attendance__internal_is_person_inactive_as_of(p_delegate_app_user_id, v_check_now) then
    raise exception 'WORK_REPORT_DELEGATE_NOT_AVAILABLE' using errcode = '42501';
  end if;

  if p_scope_kind = 'team' then
    if public.work_report_current_team(p_delegate_app_user_id) is distinct from p_scope_team_id then
      if coalesce(v_delegate.authz_managed, false) then
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
      else
        if not exists (
          select 1
            from public.direct_entry_scope_grants sg
           where sg.app_user_id = p_delegate_app_user_id
             and sg.scope_kind = 'team'
             and sg.team_id = p_scope_team_id
             and sg.is_current
        ) then
          raise exception 'WORK_REPORT_DELEGATE_OUTSIDE_SCOPE' using errcode = '42501';
        end if;
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
$$;

revoke all on function public.work_report_create_delegation(
  uuid, uuid, text, uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone, text
) from public, anon, authenticated;
grant execute on function public.work_report_create_delegation(
  uuid, uuid, text, uuid, uuid, text, uuid, timestamp with time zone, timestamp with time zone, text
) to service_role;

create or replace function public.work_report_list_delegations(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_all_scope boolean;
  v_team_ids uuid[];
  v_as_of timestamptz := statement_timestamp();
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');
  v_all_scope := public.work_report__internal_has_direct_scope(p_app_user_id, 'report_delegate', 'all', null);
  v_team_ids := public.work_report__internal_direct_team_ids(p_app_user_id, 'report_delegate');

  if not v_all_scope and coalesce(pg_catalog.cardinality(v_team_ids), 0) = 0 then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'delegation_id', d.delegation_id,
        'grantor_user_id', d.grantor_user_id,
        'grantor_display_name', coalesce(public.work_report__internal_user_display_name(gu.app_user_id), gu.display_name),
        'capability', d.capability,
        'delegate_app_user_id', d.delegate_app_user_id,
        'delegate_display_name', coalesce(public.work_report__internal_user_display_name(du.app_user_id), du.display_name),
        'template_id', d.template_id,
        'template_code', t.template_code,
        'template_name', t.display_name,
        'template_version_id', d.template_version_id,
        'scope_kind', d.scope_kind,
        'scope_id', d.scope_team_id,
        'scope_team_id', d.scope_team_id,
        'scope_label', case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end,
        'effective_from', d.effective_from,
        'effective_to', d.effective_to,
        'revoked_at', d.revoked_at,
        'state', d.state,
        'status', case
          when d.state = 'REVOKED' or not d.is_current then 'REVOKED'
          when d.effective_to is not null and v_as_of > d.effective_to then 'EXPIRED'
          else 'ACTIVE'
        end,
        'is_current', d.is_current,
        'is_effective', public.work_report__internal_is_delegation_effective(d.delegation_id, v_as_of),
        'version', d.version,
        'created_at', d.created_at
      ) order by d.created_at desc, d.delegation_id desc)
        from public.work_report_delegations d
        join public.direct_entry_app_users gu on gu.app_user_id = d.grantor_user_id
        join public.direct_entry_app_users du on du.app_user_id = d.delegate_app_user_id
        join public.work_report_templates t on t.template_id = d.template_id
        left join public.teams tm on tm.team_id = d.scope_team_id
       where v_all_scope
          or d.grantor_user_id = p_app_user_id
          or (d.scope_kind = 'team' and d.scope_team_id = any(v_team_ids))
    ), '[]'::jsonb),
    'options', jsonb_build_object(
      'delegates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', del_opt.app_user_id,
          'display_name', del_opt.display_name
        ) order by del_opt.display_name, del_opt.app_user_id)
          from (
            select u.app_user_id,
                   coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name
              from public.direct_entry_app_users u
             where u.enabled
               and u.account_type = 'NORMAL'
               and not public.attendance__internal_is_non_employee_account(u.app_user_id, v_as_of)
               and not public.attendance__internal_is_person_inactive_as_of(u.app_user_id, v_as_of)
               and u.app_user_id <> p_app_user_id
               and (
                 v_all_scope
                 or public.work_report_current_team(u.app_user_id) = any(v_team_ids)
               )
          ) del_opt
      ), '[]'::jsonb),
      'templates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'template_id', t.template_id,
          'version_id', t.current_published_version_id,
          'name', t.display_name,
          'template_code', t.template_code,
          'display_name', t.display_name
        ) order by t.template_code)
          from public.work_report_templates t
         where t.status = 'ACTIVE'
           and t.current_published_version_id is not null
      ), '[]'::jsonb),
      'scopes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'scope_kind', sc.scope_kind,
          'scope_id', sc.scope_id,
          'label', sc.label
        ) order by sc.sort_order, sc.label)
          from (
            select 0 as sort_order, 'all'::text as scope_kind, null::uuid as scope_id, 'Toàn công ty'::text as label
             where v_all_scope
            union all
            select 1 as sort_order, 'team'::text as scope_kind, t.team_id as scope_id, coalesce(t.display_name, t.code) as label
              from public.teams t
             where t.active
               and t.code <> '__system_vendor__'
               and (v_all_scope or t.team_id = any(v_team_ids))
          ) sc
      ), '[]'::jsonb),
      'capabilities', coalesce((
        select jsonb_agg(cap order by cap)
          from unnest(array['report_assign', 'report_review']::text[]) as cap
         where (
           v_all_scope
           and (
             public.work_report__internal_has_direct_scope(p_app_user_id, cap, 'all', null)
             or coalesce(pg_catalog.cardinality(public.work_report__internal_direct_team_ids(p_app_user_id, cap)), 0) > 0
           )
         ) or exists (
           select 1
             from unnest(v_team_ids) as tid
            where public.work_report__internal_has_direct_scope(p_app_user_id, cap, 'team', tid)
         )
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.work_report_list_delegations(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.work_report_list_delegations(uuid, uuid)
  to service_role;

create or replace function public.work_report__internal_is_delegation_effective(
  p_delegation_id uuid,
  p_as_of timestamp with time zone default statement_timestamp()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
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
  if not found or not v_delegate.enabled then
    return false;
  end if;
  if v_delegate.account_type is distinct from 'NORMAL'
     or public.attendance__internal_is_non_employee_account(v_del.delegate_app_user_id, p_as_of)
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
      if coalesce(v_delegate.authz_managed, false) then
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
      else
        if not exists (
          select 1 from public.direct_entry_scope_grants sg
           where sg.app_user_id = v_del.delegate_app_user_id
             and sg.scope_kind = 'team'
             and sg.team_id = v_del.scope_team_id
             and sg.is_current
        ) then
          return false;
        end if;
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
$$;

revoke all on function public.work_report__internal_is_delegation_effective(uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- Concurrency-safe ONCE obligation guard (<= 1 ONCE obligation per (assignment_id, assignee_app_user_id))
-- without risking migration-apply failure or deleting historical rows if legacy duplicates exist.
create or replace function public.work_report__internal_enforce_once_obligation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.period_type <> 'ONCE' then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('work_report_once_obligation'),
    pg_catalog.hashtext(new.assignment_id::text || ':' || new.assignee_app_user_id::text)
  );

  if exists (
    select 1
      from public.work_report_obligations o
     where o.assignment_id = new.assignment_id
       and o.assignee_app_user_id = new.assignee_app_user_id
       and o.period_type = 'ONCE'
  ) then
    return null;
  end if;

  return new;
end;
$$;

revoke all on function public.work_report__internal_enforce_once_obligation()
  from public, anon, authenticated, service_role;

drop trigger if exists work_report_obligations_once_singleton_guard
  on public.work_report_obligations;
create trigger work_report_obligations_once_singleton_guard
  before insert on public.work_report_obligations
  for each row
  when (new.period_type = 'ONCE')
  execute function public.work_report__internal_enforce_once_obligation();

-- =============================================================================
-- Owner Alignment & Install-Time Security / Volatility / Trigger Self-Check
-- =============================================================================
do $align_wp9$
declare
  v_owner_oid oid;
  v_owner name;
  v_signature text;
  v_proc_owner_oid oid;
  v_all_sigs text[] := array[
    'public.attendance__internal_is_non_employee_account(uuid, timestamptz)',
    'public.attendance__internal_is_person_inactive_as_of(uuid, timestamptz)',
    'public.attendance__internal_is_employee_obligated_on_date(uuid, date, date, timestamptz)',
    'public.work_report__internal_team_on_date(uuid, date)',
    'public.leave_management__internal_resolve_authority(uuid, uuid)',
    'public.work_report__internal_is_eligible_assignee(uuid)',
    'public.work_report_assert_actor(uuid, uuid, text)',
    'public.work_report__internal_actor_materialization_candidates(uuid, date, integer)',
    'public.work_report__internal_has_active_obligations_for_date(uuid, date, integer)',
    'public.work_report__internal_is_delegation_effective(uuid, timestamptz)',
    'public.attendance_explanation__internal_evaluate_employee_day_slots(uuid, date)',
    'public.work_report__internal_materialize_actor_obligations(uuid, date, integer)',
    'public.work_report__internal_materialize_assignment_for_date(uuid, date)',
    'public.work_report__internal_enforce_once_obligation()',
    'public.attendance_monthly_matrix_report(uuid, uuid, text, uuid, uuid, text, integer, integer)',
    'public.attendance_record_checkin(uuid, uuid, uuid, text, double precision, double precision, double precision, text, text, timestamptz, text, timestamptz, bigint, text, text, text, integer, text, timestamptz)',
    'public.attendance_lookup_checkin_idempotency(uuid, uuid, uuid, text)',
    'public.attendance_list_branches_admin(uuid, uuid, boolean)',
    'public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)',
    'public.attendance_get_slot_policies_admin(uuid, uuid)',
    'public.attendance_assign_employee_slot_policy_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text)',
    'public.work_report_ensure_obligations_for_window(uuid, uuid, date)',
    'public.work_report_create_assignment(uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text)',
    'public.work_report_list_assignment_options(uuid, uuid, uuid)',
    'public.work_report_list_assignments(uuid, uuid, uuid)',
    'public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)',
    'public.work_report_create_group(uuid, uuid, text, text, uuid[], text)',
    'public.work_report_update_group(uuid, uuid, uuid, integer, text, text, uuid[], text)',
    'public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)',
    'public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)',
    'public.work_report_create_delegation(uuid, uuid, text, uuid, uuid, text, uuid, timestamptz, timestamptz, text)',
    'public.work_report_list_delegations(uuid, uuid)'
  ];
begin
  select c.relowner, pg_catalog.pg_get_userbyid(c.relowner)
    into v_owner_oid, v_owner
    from pg_catalog.pg_class c
   where c.oid = 'public.work_report_assignments'::pg_catalog.regclass;

  if v_owner_oid is null then
    raise exception 'WP9_CHECK_MISSING_BASE_TABLE' using errcode = '55000';
  end if;

  foreach v_signature in array v_all_sigs loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = pg_catalog.to_regprocedure(v_signature);

    if v_proc_owner_oid is null then
      raise exception 'WP9_ALIGN_MISSING_FUNCTION: %', v_signature using errcode = '55000';
    end if;

    if v_proc_owner_oid is distinct from v_owner_oid
       and pg_catalog.pg_has_role(current_user, v_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_signature, v_owner);
    end if;
  end loop;
end
$align_wp9$;

do $check_wp9$
declare
  v_sig text;
  v_dep_sig text;
  v_name text;
  v_oid oid;
  v_dep_oid oid;
  v_owner_oid oid;
  v_secdef boolean;
  v_volatile "char";
  v_proconfig text[];
  v_owner_priv boolean;
  v_owner_exec boolean;
  v_service_exec boolean;
  v_boot_exec boolean;
  v_exposed integer;
  v_overload_cnt integer;
  v_trig_enabled "char";
  v_trig_fn oid;
  v_stable_internal_fns text[] := array[
    'public.attendance__internal_is_non_employee_account(uuid,timestamptz)',
    'public.attendance__internal_is_person_inactive_as_of(uuid,timestamptz)',
    'public.attendance__internal_is_employee_obligated_on_date(uuid,date,date,timestamptz)',
    'public.work_report__internal_team_on_date(uuid,date)',
    'public.leave_management__internal_resolve_authority(uuid,uuid)',
    'public.work_report__internal_is_eligible_assignee(uuid)',
    'public.work_report_assert_actor(uuid,uuid,text)',
    'public.work_report__internal_actor_materialization_candidates(uuid,date,integer)',
    'public.work_report__internal_has_active_obligations_for_date(uuid,date,integer)',
    'public.work_report__internal_is_delegation_effective(uuid,timestamptz)'
  ];
  v_volatile_internal_fns text[] := array[
    'public.attendance_explanation__internal_evaluate_employee_day_slots(uuid,date)',
    'public.work_report__internal_materialize_actor_obligations(uuid,date,integer)',
    'public.work_report__internal_materialize_assignment_for_date(uuid,date)',
    'public.work_report__internal_enforce_once_obligation()'
  ];
  v_service_rpcs text[] := array[
    'public.attendance_monthly_matrix_report(uuid,uuid,text,uuid,uuid,text,integer,integer)',
    'public.attendance_record_checkin(uuid,uuid,uuid,text,double precision,double precision,double precision,text,text,timestamptz,text,timestamptz,bigint,text,text,text,integer,text,timestamptz)',
    'public.attendance_lookup_checkin_idempotency(uuid,uuid,uuid,text)',
    'public.attendance_list_branches_admin(uuid,uuid,boolean)',
    'public.attendance_assign_employee_branch_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)',
    'public.attendance_get_slot_policies_admin(uuid,uuid)',
    'public.attendance_assign_employee_slot_policy_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)',
    'public.work_report_ensure_obligations_for_window(uuid,uuid,date)',
    'public.work_report_create_assignment(uuid,uuid,uuid,text,uuid,uuid,uuid[],text,boolean,integer,time without time zone,boolean,date,date,text)',
    'public.work_report_list_assignment_options(uuid,uuid,uuid)',
    'public.work_report_list_assignments(uuid,uuid,uuid)',
    'public.work_report_set_assignment_state(uuid,uuid,uuid,integer,text,text)',
    'public.work_report_create_group(uuid,uuid,text,text,uuid[],text)',
    'public.work_report_update_group(uuid,uuid,uuid,integer,text,text,uuid[],text)',
    'public.work_report_set_group_active(uuid,uuid,uuid,integer,boolean,text)',
    'public.work_report_create_group_assignment(uuid,uuid,uuid,uuid,text,boolean,integer,time without time zone,boolean,date,date,text)',
    'public.work_report_create_delegation(uuid,uuid,text,uuid,uuid,text,uuid,timestamptz,timestamptz,text)',
    'public.work_report_list_delegations(uuid,uuid)'
  ];
  v_fn_names text[] := array[
    'attendance__internal_is_non_employee_account',
    'attendance__internal_is_person_inactive_as_of',
    'attendance__internal_is_employee_obligated_on_date',
    'work_report__internal_team_on_date',
    'leave_management__internal_resolve_authority',
    'work_report__internal_is_eligible_assignee',
    'work_report_assert_actor',
    'work_report__internal_actor_materialization_candidates',
    'work_report__internal_has_active_obligations_for_date',
    'work_report__internal_is_delegation_effective',
    'attendance_explanation__internal_evaluate_employee_day_slots',
    'work_report__internal_materialize_actor_obligations',
    'work_report__internal_materialize_assignment_for_date',
    'work_report__internal_enforce_once_obligation',
    'attendance_monthly_matrix_report',
    'attendance_record_checkin',
    'attendance_lookup_checkin_idempotency',
    'attendance_list_branches_admin',
    'attendance_assign_employee_branch_admin',
    'attendance_get_slot_policies_admin',
    'attendance_assign_employee_slot_policy_admin',
    'work_report_ensure_obligations_for_window',
    'work_report_create_assignment',
    'work_report_list_assignment_options',
    'work_report_list_assignments',
    'work_report_set_assignment_state',
    'work_report_create_group',
    'work_report_update_group',
    'work_report_set_group_active',
    'work_report_create_group_assignment',
    'work_report_create_delegation',
    'work_report_list_delegations'
  ];
  v_internal_deps text[] := array[
    'public.attendance__internal_is_non_employee_account(uuid,timestamptz)',
    'public.attendance__internal_is_person_inactive_as_of(uuid,timestamptz)',
    'public.attendance__internal_is_employee_obligated_on_date(uuid,date,date,timestamptz)',
    'public.work_report__internal_team_on_date(uuid,date)',
    'public.work_report__internal_is_eligible_assignee(uuid)',
    'public.work_report__internal_enforce_once_obligation()'
  ];
  v_probe_chain_stable text[] := array[
    'public.leave_management_get_actor_access(uuid,uuid)',
    'public.leave_management__internal_resolve_authority(uuid,uuid)',
    'public.attendance__internal_is_non_employee_account(uuid,timestamptz)',
    'public.attendance__internal_is_person_inactive_as_of(uuid,timestamptz)',
    'public.attendance__internal_is_employee_obligated_on_date(uuid,date,date,timestamptz)',
    'public.work_report_has_active_obligations(uuid,uuid)',
    'public.work_report__internal_has_active_obligations_for_date(uuid,date,integer)',
    'public.work_report__internal_actor_materialization_candidates(uuid,date,integer)',
    'public.work_report__internal_team_on_date(uuid,date)',
    'public.work_report__internal_is_eligible_assignee(uuid)',
    'public.work_report__internal_is_delegation_effective(uuid,timestamptz)'
  ];
begin
  foreach v_name in array v_fn_names loop
    select count(*)::integer
      into v_overload_cnt
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = v_name;

    if v_overload_cnt <> 1 then
      raise exception 'WP9_CHECK_OVERLOAD_COUNT_FAILED: % (count=%)', v_name, v_overload_cnt
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array (v_stable_internal_fns || v_volatile_internal_fns) loop
    v_oid := v_sig::pg_catalog.regprocedure;

    select p.proowner,
           p.prosecdef,
           p.provolatile,
           p.proconfig,
           (r.rolsuper or r.rolbypassrls),
           pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE')
      into v_owner_oid, v_secdef, v_volatile, v_proconfig, v_owner_priv, v_owner_exec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_secdef, false)
       or not coalesce(v_owner_priv, false)
       or not coalesce(v_owner_exec, false)
       or (v_sig = any(v_stable_internal_fns) and v_volatile <> 's')
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP9_CHECK_INTERNAL_DEF_FAILED: %', v_sig using errcode = '55000';
    end if;

    foreach v_dep_sig in array v_internal_deps loop
      v_dep_oid := v_dep_sig::pg_catalog.regprocedure;
      if not pg_catalog.has_function_privilege(v_owner_oid, v_dep_oid, 'EXECUTE') then
        raise exception 'WP9_CHECK_OWNER_CALLEE_EXEC_FAILED: % -> %', v_sig, v_dep_sig
          using errcode = '55000';
      end if;
    end loop;

    select count(*)::integer
      into v_exposed
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) a
      left join pg_catalog.pg_roles gr on gr.oid = a.grantee
     where p.oid = v_oid
       and (a.grantee = 0 or gr.rolname in ('anon', 'authenticated', 'service_role'));

    if v_exposed <> 0 then
      raise exception 'WP9_CHECK_INTERNAL_ACL_EXPOSED: % (% grants)', v_sig, v_exposed
        using errcode = '55000';
    end if;
  end loop;

  -- Preserve direct_entry_catalog_bootstrap_executor EXECUTE on leave_management__internal_resolve_authority
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'direct_entry_catalog_bootstrap_executor') then
    select pg_catalog.has_function_privilege(
             'direct_entry_catalog_bootstrap_executor',
             'public.leave_management__internal_resolve_authority(uuid,uuid)'::pg_catalog.regprocedure,
             'EXECUTE'
           )
      into v_boot_exec;
    if not coalesce(v_boot_exec, false) then
      raise exception 'WP9_CHECK_BOOTSTRAP_EXECUTOR_GRANT_MISSING' using errcode = '55000';
    end if;
  end if;

  foreach v_sig in array v_service_rpcs loop
    v_oid := v_sig::pg_catalog.regprocedure;

    select p.proowner,
           p.prosecdef,
           p.provolatile,
           p.proconfig,
           (r.rolsuper or r.rolbypassrls),
           pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE'),
           pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
      into v_owner_oid, v_secdef, v_volatile, v_proconfig, v_owner_priv, v_owner_exec, v_service_exec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_secdef, false)
       or not coalesce(v_owner_priv, false)
       or not coalesce(v_owner_exec, false)
       or not coalesce(v_service_exec, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP9_CHECK_SERVICE_RPC_DEF_FAILED: %', v_sig using errcode = '55000';
    end if;

    foreach v_dep_sig in array v_internal_deps loop
      v_dep_oid := v_dep_sig::pg_catalog.regprocedure;
      if not pg_catalog.has_function_privilege(v_owner_oid, v_dep_oid, 'EXECUTE') then
        raise exception 'WP9_CHECK_RPC_OWNER_CALLEE_EXEC_FAILED: % -> %', v_sig, v_dep_sig
          using errcode = '55000';
      end if;
    end loop;

    select count(*)::integer
      into v_exposed
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) a
      left join pg_catalog.pg_roles gr on gr.oid = a.grantee
     where p.oid = v_oid
       and (a.grantee = 0 or gr.rolname in ('anon', 'authenticated'));

    if v_exposed <> 0 then
      raise exception 'WP9_CHECK_SERVICE_RPC_ACL_EXPOSED: % (% grants)', v_sig, v_exposed
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_probe_chain_stable loop
    v_oid := v_sig::pg_catalog.regprocedure;
    select p.provolatile into v_volatile from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_volatile is distinct from 's' then
      raise exception 'WP9_CHECK_PROBE_CHAIN_NOT_STABLE: % (provolatile=%)', v_sig, v_volatile
        using errcode = '55000';
    end if;
  end loop;

  select t.tgenabled, t.tgfoid
    into v_trig_enabled, v_trig_fn
    from pg_catalog.pg_trigger t
   where t.tgrelid = 'public.work_report_obligations'::pg_catalog.regclass
     and t.tgname = 'work_report_obligations_once_singleton_guard'
     and not t.tgisinternal;

  if v_trig_enabled is distinct from 'O'
     or v_trig_fn is distinct from 'public.work_report__internal_enforce_once_obligation()'::pg_catalog.regprocedure then
    raise exception 'WP9_CHECK_ONCE_TRIGGER_FAILED: enabled=% fn=%', v_trig_enabled, v_trig_fn
      using errcode = '55000';
  end if;
end
$check_wp9$;

commit;
