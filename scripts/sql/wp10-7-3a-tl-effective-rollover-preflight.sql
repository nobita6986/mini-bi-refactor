-- =============================================================================
-- WP10-7 Slice 3A Preflight (Read-Only)
-- Compare pre-3A `old_effective` (with legacy rollover branch) vs post-3A
-- `new_effective` (without legacy rollover branch) across EVERY row of
-- `public.direct_entry_team_leader_assignments` at:
--   - today (`public.direct_entry_authorization_date()`)
--   - historical_valid_from (`a.valid_from <= today`)
--   - historical_valid_to_minus_1 (`a.valid_to is not null and a.valid_to > a.valid_from and (a.valid_to - 1) <= today`)
--   - historical_monthly_report_month_end (`v_sync_as_of` month-end dates from `min(valid_from)` up to `today`)
--   - future (`greatest(a.valid_from, today + 1)`)
--
-- Safe for REQ, NWC, and Production before deploying Slice 3A.
-- =============================================================================

BEGIN TRANSACTION READ ONLY;

-- -----------------------------------------------------------------------------
-- Query 1: Summary Gate
-- -----------------------------------------------------------------------------
with ctx as (
  select public.direct_entry_authorization_date() as authorization_date
),
bounds as (
  select min(a.valid_from) as min_valid_from
    from public.direct_entry_team_leader_assignments a
),
monthly_report_month_ends as (
  select distinct least(
           ctx.authorization_date,
           (m_start + interval '1 month - 1 day')::date
         ) as month_end_date
    from ctx
    cross join bounds b
    cross join lateral pg_catalog.generate_series(
      pg_catalog.date_trunc('month', b.min_valid_from)::date,
      pg_catalog.date_trunc('month', ctx.authorization_date)::date,
      interval '1 month'
    ) as m_start
   where b.min_valid_from is not null
     and pg_catalog.date_trunc('month', b.min_valid_from)::date
         <= pg_catalog.date_trunc('month', ctx.authorization_date)::date
),
assignments_eval as (
  select a.assignment_id,
         a.team_id,
         t.code as team_code,
         a.leader_app_user_id,
         a.valid_from,
         a.valid_to,
         a.is_current,
         a.suspended_by_account_disable,
         (
           t.team_id is not null
           and t.active
           and t.code <> '__system_vendor__'
           and u.app_user_id is not null
           and u.enabled
           and r.recruiter_id is not null
           and r.active
           and not a.suspended_by_account_disable
           and (a.valid_to is null or a.valid_to > a.valid_from)
         ) as structural_ok,
         coalesce(sg.cnt, 0)::integer as matching_scope_grants,
         coalesce(cg.cnt, 0)::integer as matching_capability_grants,
         coalesce(rev.cnt, 0)::integer as matching_revisions
    from public.direct_entry_team_leader_assignments a
    left join public.teams t
      on t.team_id = a.team_id
    left join public.direct_entry_app_users u
      on u.app_user_id = a.leader_app_user_id
    left join public.recruiters r
      on r.recruiter_id = a.leader_recruiter_id
    left join lateral (
      select count(*)::integer as cnt
        from public.direct_entry_scope_grants s
       where s.app_user_id = a.leader_app_user_id
         and s.scope_kind = 'team'
         and s.team_id = a.team_id
         and s.valid_from <= a.valid_from
         and s.valid_to is not distinct from a.valid_to
         and (s.valid_to is null or s.valid_to > s.valid_from)
         and not s.is_current
         and not s.suspended_by_account_disable
    ) sg on true
    left join lateral (
      select count(*)::integer as cnt
        from public.direct_entry_capability_grants g
       where g.app_user_id = a.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and g.valid_from = a.valid_from
         and g.valid_to is not distinct from a.valid_to
         and (g.valid_to is null or g.valid_to > g.valid_from)
         and not g.is_current
         and not g.suspended_by_account_disable
    ) cg on true
    left join lateral (
      select count(*)::integer as cnt
        from public.direct_entry_team_leader_revisions rev
       where rev.team_id = a.team_id
         and rev.action in ('designate', 'replace')
         and rev.after_snapshot->>'leader_app_user_id' = a.leader_app_user_id::text
         and rev.after_snapshot->>'valid_from' = a.valid_from::text
    ) rev on true
),
probe_dates as (
  select a.assignment_id,
         ctx.authorization_date as probe_date,
         'today'::text as probe_kind
    from assignments_eval a
    cross join ctx

  union all

  select a.assignment_id,
         a.valid_from as probe_date,
         'historical_valid_from'::text as probe_kind
    from assignments_eval a
    cross join ctx
   where a.valid_from <= ctx.authorization_date

  union all

  select a.assignment_id,
         (a.valid_to - 1) as probe_date,
         'historical_valid_to_minus_1'::text as probe_kind
    from assignments_eval a
    cross join ctx
   where a.valid_to is not null
     and a.valid_to > a.valid_from
     and (a.valid_to - 1) <= ctx.authorization_date

  union all

  select a.assignment_id,
         m.month_end_date as probe_date,
         'historical_monthly_report_month_end'::text as probe_kind
    from assignments_eval a
    join monthly_report_month_ends m
      on m.month_end_date >= a.valid_from
     and (a.valid_to is null or m.month_end_date < a.valid_to)

  union all

  select a.assignment_id,
         greatest(a.valid_from, ctx.authorization_date + 1) as probe_date,
         'future'::text as probe_kind
    from assignments_eval a
    cross join ctx
),
evaluated_probes as (
  select a.assignment_id,
         p.probe_kind,
         p.probe_date,
         (
           a.structural_ok
           and a.valid_from <= p.probe_date
           and (a.valid_to is null or p.probe_date < a.valid_to)
           and (
             a.is_current
             or p.probe_date > ctx.authorization_date
             or (
               not a.is_current
               and not a.suspended_by_account_disable
               and a.matching_scope_grants > 0
               and a.matching_capability_grants > 0
               and a.matching_revisions > 0
             )
           )
         ) as old_effective,
         (
           a.structural_ok
           and a.valid_from <= p.probe_date
           and (a.valid_to is null or p.probe_date < a.valid_to)
           and (
             a.is_current
             or p.probe_date > ctx.authorization_date
             or (
               p.probe_date < ctx.authorization_date
               and a.valid_to is not null
               and a.valid_to <= ctx.authorization_date
               and a.matching_revisions > 0
             )
           )
         ) as new_effective
    from assignments_eval a
    join probe_dates p
      on p.assignment_id = a.assignment_id
    cross join ctx
),
assignment_summary as (
  select count(*)::integer as total_assignments,
         coalesce(count(*) filter (where is_current), 0)::integer as current_assignments,
         coalesce(count(*) filter (where suspended_by_account_disable), 0)::integer as suspended_assignments
    from assignments_eval
),
probe_summary as (
  select coalesce(
           count(*) filter (
             where probe_kind = 'today'
               and old_effective is distinct from new_effective
           ),
           0
         )::integer as changed_at_today_count,
         coalesce(
           count(*) filter (
             where probe_kind in (
                     'historical_valid_from',
                     'historical_valid_to_minus_1',
                     'historical_monthly_report_month_end'
                   )
               and old_effective is distinct from new_effective
           ),
           0
         )::integer as changed_at_historical_dates_count,
         coalesce(
           count(*) filter (
             where probe_kind = 'future'
               and old_effective is distinct from new_effective
           ),
           0
         )::integer as changed_at_future_dates_count,
         coalesce(
           count(distinct assignment_id) filter (
             where old_effective is distinct from new_effective
           ),
           0
         )::integer as distinct_changed_assignment_count
    from evaluated_probes
)
select ctx.authorization_date,
       asum.total_assignments,
       asum.current_assignments,
       asum.suspended_assignments,
       psum.changed_at_today_count,
       psum.changed_at_historical_dates_count,
       psum.changed_at_future_dates_count,
       psum.distinct_changed_assignment_count,
       (psum.distinct_changed_assignment_count = 0) as ready_for_slice_3a
  from ctx
  cross join assignment_summary asum
  cross join probe_summary psum;

-- -----------------------------------------------------------------------------
-- Query 2: Exact Mismatch Inspector
-- -----------------------------------------------------------------------------
with ctx as (
  select public.direct_entry_authorization_date() as authorization_date
),
bounds as (
  select min(a.valid_from) as min_valid_from
    from public.direct_entry_team_leader_assignments a
),
monthly_report_month_ends as (
  select distinct least(
           ctx.authorization_date,
           (m_start + interval '1 month - 1 day')::date
         ) as month_end_date
    from ctx
    cross join bounds b
    cross join lateral pg_catalog.generate_series(
      pg_catalog.date_trunc('month', b.min_valid_from)::date,
      pg_catalog.date_trunc('month', ctx.authorization_date)::date,
      interval '1 month'
    ) as m_start
   where b.min_valid_from is not null
     and pg_catalog.date_trunc('month', b.min_valid_from)::date
         <= pg_catalog.date_trunc('month', ctx.authorization_date)::date
),
assignments_eval as (
  select a.assignment_id,
         a.team_id,
         t.code as team_code,
         a.leader_app_user_id,
         a.valid_from,
         a.valid_to,
         a.is_current,
         a.suspended_by_account_disable,
         (
           t.team_id is not null
           and t.active
           and t.code <> '__system_vendor__'
           and u.app_user_id is not null
           and u.enabled
           and r.recruiter_id is not null
           and r.active
           and not a.suspended_by_account_disable
           and (a.valid_to is null or a.valid_to > a.valid_from)
         ) as structural_ok,
         coalesce(sg.cnt, 0)::integer as matching_scope_grants,
         coalesce(cg.cnt, 0)::integer as matching_capability_grants,
         coalesce(rev.cnt, 0)::integer as matching_revisions
    from public.direct_entry_team_leader_assignments a
    left join public.teams t
      on t.team_id = a.team_id
    left join public.direct_entry_app_users u
      on u.app_user_id = a.leader_app_user_id
    left join public.recruiters r
      on r.recruiter_id = a.leader_recruiter_id
    left join lateral (
      select count(*)::integer as cnt
        from public.direct_entry_scope_grants s
       where s.app_user_id = a.leader_app_user_id
         and s.scope_kind = 'team'
         and s.team_id = a.team_id
         and s.valid_from <= a.valid_from
         and s.valid_to is not distinct from a.valid_to
         and (s.valid_to is null or s.valid_to > s.valid_from)
         and not s.is_current
         and not s.suspended_by_account_disable
    ) sg on true
    left join lateral (
      select count(*)::integer as cnt
        from public.direct_entry_capability_grants g
       where g.app_user_id = a.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and g.valid_from = a.valid_from
         and g.valid_to is not distinct from a.valid_to
         and (g.valid_to is null or g.valid_to > g.valid_from)
         and not g.is_current
         and not g.suspended_by_account_disable
    ) cg on true
    left join lateral (
      select count(*)::integer as cnt
        from public.direct_entry_team_leader_revisions rev
       where rev.team_id = a.team_id
         and rev.action in ('designate', 'replace')
         and rev.after_snapshot->>'leader_app_user_id' = a.leader_app_user_id::text
         and rev.after_snapshot->>'valid_from' = a.valid_from::text
    ) rev on true
),
probe_dates as (
  select a.assignment_id,
         ctx.authorization_date as probe_date,
         'today'::text as probe_kind
    from assignments_eval a
    cross join ctx

  union all

  select a.assignment_id,
         a.valid_from as probe_date,
         'historical_valid_from'::text as probe_kind
    from assignments_eval a
    cross join ctx
   where a.valid_from <= ctx.authorization_date

  union all

  select a.assignment_id,
         (a.valid_to - 1) as probe_date,
         'historical_valid_to_minus_1'::text as probe_kind
    from assignments_eval a
    cross join ctx
   where a.valid_to is not null
     and a.valid_to > a.valid_from
     and (a.valid_to - 1) <= ctx.authorization_date

  union all

  select a.assignment_id,
         m.month_end_date as probe_date,
         'historical_monthly_report_month_end'::text as probe_kind
    from assignments_eval a
    join monthly_report_month_ends m
      on m.month_end_date >= a.valid_from
     and (a.valid_to is null or m.month_end_date < a.valid_to)

  union all

  select a.assignment_id,
         greatest(a.valid_from, ctx.authorization_date + 1) as probe_date,
         'future'::text as probe_kind
    from assignments_eval a
    cross join ctx
),
evaluated_probes as (
  select a.assignment_id,
         a.team_id,
         a.team_code,
         a.leader_app_user_id,
         a.valid_from,
         a.valid_to,
         a.is_current,
         a.suspended_by_account_disable,
         p.probe_date,
         p.probe_kind,
         (
           a.structural_ok
           and a.valid_from <= p.probe_date
           and (a.valid_to is null or p.probe_date < a.valid_to)
           and (
             a.is_current
             or p.probe_date > ctx.authorization_date
             or (
               not a.is_current
               and not a.suspended_by_account_disable
               and a.matching_scope_grants > 0
               and a.matching_capability_grants > 0
               and a.matching_revisions > 0
             )
           )
         ) as old_effective,
         (
           a.structural_ok
           and a.valid_from <= p.probe_date
           and (a.valid_to is null or p.probe_date < a.valid_to)
           and (
             a.is_current
             or p.probe_date > ctx.authorization_date
             or (
               p.probe_date < ctx.authorization_date
               and a.valid_to is not null
               and a.valid_to <= ctx.authorization_date
               and a.matching_revisions > 0
             )
           )
         ) as new_effective,
         a.matching_scope_grants,
         a.matching_capability_grants,
         a.matching_revisions
    from assignments_eval a
    join probe_dates p
      on p.assignment_id = a.assignment_id
    cross join ctx
)
select ep.assignment_id,
       ep.team_id,
       ep.team_code,
       ep.leader_app_user_id,
       ep.valid_from,
       ep.valid_to,
       ep.is_current,
       ep.suspended_by_account_disable,
       ep.probe_date,
       ep.probe_kind,
       ep.old_effective,
       ep.new_effective,
       ep.matching_scope_grants,
       ep.matching_capability_grants,
       ep.matching_revisions
  from evaluated_probes ep
 where ep.old_effective is distinct from ep.new_effective
 order by ep.probe_kind, ep.probe_date desc, ep.team_code nulls last, ep.assignment_id;

ROLLBACK;
