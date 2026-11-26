-- =============================================================================
-- WP10-6 Slice 2: Work Report Assignment Pause Windows
--                 (+0 net public RPCs; strictly forward migration)
--
-- Scope:
--   1. Minimal internal table public.work_report_assignment_pause_windows
--      recording half-open Vietnam business-date intervals [paused_date, resumed_date)
--      (resumed_date IS NULL => open-ended pause), with:
--      - CHECK (resumed_date is null or resumed_date >= paused_date)
--      - partial unique index (assignment_id) where resumed_date is null
--      - lookup index (assignment_id, paused_date, resumed_date)
--      - RLS enabled + forced; REVOKE ALL from PUBLIC, anon, authenticated, service_role.
--   2. Pre-upgrade closed + open pause-window backfill from authoritative
--      work_report_audit_events evidence ONLY (action = 'ASSIGNMENT_STATE',
--      outcome = 'APPLIED', state in ('PAUSED', 'ACTIVE', 'REVOKED')), grouped
--      into (assignment_id, created_at) timestamp buckets ordered strictly by
--      created_at ASC (NEVER using random audit_event_id UUIDs to guess order):
--      - Same-timestamp conflicting states (COUNT(DISTINCT state) > 1) are
--        marked bucket_state = 'AMBIGUOUS' and act as strict sequence barriers.
--      - Collapses consecutive unambiguous PAUSED buckets via LAG(bucket_state).
--      - Pairs each pause stretch with the first subsequent non-PAUSED bucket:
--        * ACTIVE/REVOKED -> closed [paused_date, greatest(paused_date, resumed_date))
--          for ALL matching assignments (including currently ACTIVE assignments).
--        * AMBIGUOUS -> skipped (never fabricates a close date or bridges across it).
--        * NULL (no later non-PAUSED bucket) -> open [paused_date, NULL) ONLY when
--          a.state = 'PAUSED' and a.is_current (never locks out ACTIVE assignments
--          and never fabricates paused_date when audit evidence is absent).
--      - Includes a read-only preflight diagnostic query comment block plus an
--        apply-time RAISE NOTICE diagnostic block reporting all 4 ambiguous/
--        missing-audit classes.
--   3. Apply the identical half-open Vietnam business-date pause exclusion across
--      every materialization and read-only probe path:
--      - public.work_report__internal_actor_materialization_candidates (STABLE;
--        serves both work_report_list_my_obligations and READ ONLY
--        work_report_has_active_obligations)
--      - public.work_report__internal_materialize_actor_obligations
--      - public.work_report__internal_materialize_assignment_for_date
--      - public.work_report_ensure_obligations_for_window
--   4. Maintain pause windows atomically on state transitions:
--      - public.work_report_set_assignment_state (uses FOR NO KEY UPDATE on
--        work_report_assignments to avoid FK FOR KEY SHARE deadlock against
--        concurrent materializers; opens window on non-PAUSED -> PAUSED; closes
--        open window with greatest(paused_date, v_today_vn) on -> ACTIVE/REVOKED
--        BEFORE immediate materialization)
--      - public.work_report_archive_template (locks current assignments in
--        assignment_id ASC order FOR NO KEY UPDATE, revokes them, and closes
--        any open pause windows)
--   5. Idempotent owner alignment, RLS/ACL, volatility, and overload self-check.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Pause Windows Table, Indexes & Lockdown
-- -----------------------------------------------------------------------------
create table public.work_report_assignment_pause_windows (
  pause_window_id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.work_report_assignments(assignment_id) on delete cascade,
  paused_date date not null,
  resumed_date date check (resumed_date is null or resumed_date >= paused_date),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

create unique index work_report_assignment_pause_windows_open_uidx
  on public.work_report_assignment_pause_windows (assignment_id)
  where resumed_date is null;

create index work_report_assignment_pause_windows_lookup_idx
  on public.work_report_assignment_pause_windows (assignment_id, paused_date, resumed_date);

alter table public.work_report_assignment_pause_windows enable row level security;
alter table public.work_report_assignment_pause_windows force row level security;
revoke all on table public.work_report_assignment_pause_windows
  from public, anon, authenticated, service_role;

comment on table public.work_report_assignment_pause_windows is
  'WP10-6 internal table recording half-open Vietnam business-date pause intervals [paused_date, resumed_date) for work_report_assignments.';

-- -----------------------------------------------------------------------------
-- 2. Backfill Closed & Open Pre-Upgrade Pause Windows (Timestamp-Bucket Pairing)
--    (Strictly from authoritative ASSIGNMENT_STATE audit events; NEVER infers
--     business order from random audit_event_id UUIDs; treats same-created_at
--     conflicting states as an 'AMBIGUOUS' sequence barrier; never fabricates
--     paused_date; never inserts an open window for non-PAUSED assignments)
--
-- Read-only preflight diagnostic query (runnable inside BEGIN TRANSACTION READ ONLY
-- BEFORE applying this migration; references only work_report_assignments &
-- work_report_audit_events):
--
--   with state_buckets as (
--     select a.assignment_id,
--            a.state as current_state,
--            a.is_current,
--            e.created_at,
--            (e.created_at at time zone 'Asia/Ho_Chi_Minh')::date as business_date_vn,
--            case
--              when pg_catalog.count(distinct (e.metadata_json ->> 'state')) = 1
--                then pg_catalog.min(e.metadata_json ->> 'state')
--              else 'AMBIGUOUS'
--            end as bucket_state,
--            pg_catalog.string_agg(
--              distinct (e.metadata_json ->> 'state'), ','
--              order by (e.metadata_json ->> 'state')
--            ) as states_csv
--       from public.work_report_audit_events e
--       join public.work_report_assignments a
--         on e.metadata_json ->> 'assignment_id' = a.assignment_id::text
--      where e.action = 'ASSIGNMENT_STATE'
--        and e.outcome = 'APPLIED'
--        and e.metadata_json ->> 'state' in ('PAUSED', 'ACTIVE', 'REVOKED')
--      group by a.assignment_id, a.state, a.is_current, e.created_at
--   ),
--   ordered_buckets as (
--     select sb.*,
--            lag(sb.bucket_state) over (
--              partition by sb.assignment_id
--              order by sb.created_at asc
--            ) as prev_bucket_state,
--            row_number() over (
--              partition by sb.assignment_id
--              order by sb.created_at asc
--            ) as seq_no
--       from state_buckets sb
--   ),
--   pause_starts as (
--     select ob.assignment_id,
--            ob.current_state,
--            ob.is_current,
--            ob.seq_no,
--            ob.created_at as paused_at,
--            ob.business_date_vn as paused_date
--       from ordered_buckets ob
--      where ob.bucket_state = 'PAUSED'
--        and (ob.prev_bucket_state is null or ob.prev_bucket_state <> 'PAUSED')
--   ),
--   paired_windows as (
--     select ps.*,
--            next_b.bucket_state as next_bucket_state,
--            next_b.created_at as next_event_at
--       from pause_starts ps
--       left join lateral (
--         select ob2.bucket_state, ob2.created_at
--           from ordered_buckets ob2
--          where ob2.assignment_id = ps.assignment_id
--            and ob2.seq_no > ps.seq_no
--            and ob2.bucket_state <> 'PAUSED'
--          order by ob2.seq_no asc
--          limit 1
--       ) next_b on true
--   )
--   select 'CONFLICTING_SAME_TIMESTAMP_BUCKET'::text as diagnostic_kind,
--          sb.assignment_id,
--          sb.created_at as event_at,
--          'states=' || sb.states_csv as detail
--     from state_buckets sb
--    where sb.bucket_state = 'AMBIGUOUS'
--   union all
--   select 'PAUSE_TRUNCATED_BY_AMBIGUOUS_BUCKET'::text as diagnostic_kind,
--          pw.assignment_id,
--          pw.paused_at as event_at,
--          'paused_date=' || pw.paused_date::text || ',ambiguous_at=' || pw.next_event_at::text as detail
--     from paired_windows pw
--    where pw.next_bucket_state = 'AMBIGUOUS'
--   union all
--   select 'PAUSED_WITHOUT_AUTHORITATIVE_OPEN_WINDOW'::text as diagnostic_kind,
--          a.assignment_id,
--          null::timestamptz as event_at,
--          'current_state=PAUSED'::text as detail
--     from public.work_report_assignments a
--    where a.state = 'PAUSED'
--      and a.is_current
--      and not exists (
--        select 1
--          from paired_windows pw
--         where pw.assignment_id = a.assignment_id
--           and pw.next_bucket_state is null
--      )
--   union all
--   select 'ACTIVE_WITH_UNPAIRED_TRAILING_PAUSE'::text as diagnostic_kind,
--          pw.assignment_id,
--          pw.paused_at as event_at,
--          'paused_date=' || pw.paused_date::text || ',current_state=ACTIVE' as detail
--     from paired_windows pw
--    where pw.next_bucket_state is null
--      and pw.current_state = 'ACTIVE'
--      and pw.is_current
--   order by diagnostic_kind, assignment_id, event_at nulls first;
-- -----------------------------------------------------------------------------
with state_buckets as (
  select a.assignment_id,
         a.state as current_state,
         a.is_current,
         e.created_at,
         (e.created_at at time zone 'Asia/Ho_Chi_Minh')::date as business_date_vn,
         case
           when pg_catalog.count(distinct (e.metadata_json ->> 'state')) = 1
             then pg_catalog.min(e.metadata_json ->> 'state')
           else 'AMBIGUOUS'
         end as bucket_state
    from public.work_report_audit_events e
    join public.work_report_assignments a
      on e.metadata_json ->> 'assignment_id' = a.assignment_id::text
   where e.action = 'ASSIGNMENT_STATE'
     and e.outcome = 'APPLIED'
     and e.metadata_json ->> 'state' in ('PAUSED', 'ACTIVE', 'REVOKED')
   group by a.assignment_id, a.state, a.is_current, e.created_at
),
ordered_buckets as (
  select sb.assignment_id,
         sb.current_state,
         sb.is_current,
         sb.created_at,
         sb.business_date_vn,
         sb.bucket_state,
         lag(sb.bucket_state) over (
           partition by sb.assignment_id
           order by sb.created_at asc
         ) as prev_bucket_state,
         row_number() over (
           partition by sb.assignment_id
           order by sb.created_at asc
         ) as seq_no
    from state_buckets sb
),
pause_starts as (
  select ob.assignment_id,
         ob.current_state,
         ob.is_current,
         ob.seq_no,
         ob.created_at as paused_at,
         ob.business_date_vn as paused_date
    from ordered_buckets ob
   where ob.bucket_state = 'PAUSED'
     and (ob.prev_bucket_state is null or ob.prev_bucket_state <> 'PAUSED')
),
paired_windows as (
  select ps.assignment_id,
         ps.current_state,
         ps.is_current,
         ps.paused_at,
         ps.paused_date,
         next_b.bucket_state as next_bucket_state,
         case
           when next_b.bucket_state in ('ACTIVE', 'REVOKED') then
             greatest(ps.paused_date, next_b.business_date_vn)
           else null::date
         end as resumed_date
    from pause_starts ps
    left join lateral (
      select ob2.bucket_state,
             ob2.business_date_vn
        from ordered_buckets ob2
       where ob2.assignment_id = ps.assignment_id
         and ob2.seq_no > ps.seq_no
         and ob2.bucket_state <> 'PAUSED'
       order by ob2.seq_no asc
       limit 1
    ) next_b on true
),
deduped_windows as (
  select pw.assignment_id,
         pw.paused_date,
         pw.resumed_date,
         min(pw.paused_at) as created_at
    from paired_windows pw
   where pw.next_bucket_state in ('ACTIVE', 'REVOKED')
      or (
        pw.next_bucket_state is null
        and pw.current_state = 'PAUSED'
        and pw.is_current
      )
   group by pw.assignment_id, pw.paused_date, pw.resumed_date
)
insert into public.work_report_assignment_pause_windows (
  assignment_id,
  paused_date,
  resumed_date,
  created_at,
  updated_at
)
select dw.assignment_id,
       dw.paused_date,
       dw.resumed_date,
       dw.created_at,
       pg_catalog.now()
  from deduped_windows dw
 where not exists (
   select 1
     from public.work_report_assignment_pause_windows existing
    where existing.assignment_id = dw.assignment_id
      and existing.paused_date = dw.paused_date
      and existing.resumed_date is not distinct from dw.resumed_date
 )
on conflict (assignment_id) where resumed_date is null do nothing;

-- Apply-time diagnostic notice for any ambiguous or missing-audit pause chain
-- (silent when 0 anomalies exist).
do $diagnose_wp10_6_pause_audit$
declare
  v_diag record;
begin
  for v_diag in
    with state_buckets as (
      select a.assignment_id,
             a.state as current_state,
             a.is_current,
             e.created_at,
             (e.created_at at time zone 'Asia/Ho_Chi_Minh')::date as business_date_vn,
             case
               when pg_catalog.count(distinct (e.metadata_json ->> 'state')) = 1
                 then pg_catalog.min(e.metadata_json ->> 'state')
               else 'AMBIGUOUS'
             end as bucket_state,
             pg_catalog.string_agg(
               distinct (e.metadata_json ->> 'state'), ','
               order by (e.metadata_json ->> 'state')
             ) as states_csv
        from public.work_report_audit_events e
        join public.work_report_assignments a
          on e.metadata_json ->> 'assignment_id' = a.assignment_id::text
       where e.action = 'ASSIGNMENT_STATE'
         and e.outcome = 'APPLIED'
         and e.metadata_json ->> 'state' in ('PAUSED', 'ACTIVE', 'REVOKED')
       group by a.assignment_id, a.state, a.is_current, e.created_at
    ),
    ordered_buckets as (
      select sb.*,
             lag(sb.bucket_state) over (
               partition by sb.assignment_id
               order by sb.created_at asc
             ) as prev_bucket_state,
             row_number() over (
               partition by sb.assignment_id
               order by sb.created_at asc
             ) as seq_no
        from state_buckets sb
    ),
    pause_starts as (
      select ob.assignment_id,
             ob.current_state,
             ob.is_current,
             ob.seq_no,
             ob.created_at as paused_at,
             ob.business_date_vn as paused_date
        from ordered_buckets ob
       where ob.bucket_state = 'PAUSED'
         and (ob.prev_bucket_state is null or ob.prev_bucket_state <> 'PAUSED')
    ),
    paired_windows as (
      select ps.assignment_id,
             ps.current_state,
             ps.is_current,
             ps.paused_at,
             ps.paused_date,
             next_b.bucket_state as next_bucket_state,
             next_b.created_at as next_event_at
        from pause_starts ps
        left join lateral (
          select ob2.bucket_state,
                 ob2.created_at
            from ordered_buckets ob2
           where ob2.assignment_id = ps.assignment_id
             and ob2.seq_no > ps.seq_no
             and ob2.bucket_state <> 'PAUSED'
           order by ob2.seq_no asc
           limit 1
        ) next_b on true
    )
    select 'CONFLICTING_SAME_TIMESTAMP_BUCKET'::text as diagnostic_kind,
           sb.assignment_id,
           sb.created_at as event_at,
           'states=' || sb.states_csv as detail
      from state_buckets sb
     where sb.bucket_state = 'AMBIGUOUS'
    union all
    select 'PAUSE_TRUNCATED_BY_AMBIGUOUS_BUCKET'::text as diagnostic_kind,
           pw.assignment_id,
           pw.paused_at as event_at,
           'paused_date=' || pw.paused_date::text || ',ambiguous_at=' || pw.next_event_at::text as detail
      from paired_windows pw
     where pw.next_bucket_state = 'AMBIGUOUS'
    union all
    select 'PAUSED_WITHOUT_AUTHORITATIVE_OPEN_WINDOW'::text as diagnostic_kind,
           a.assignment_id,
           null::timestamptz as event_at,
           'current_state=PAUSED'::text as detail
      from public.work_report_assignments a
     where a.state = 'PAUSED'
       and a.is_current
       and not exists (
         select 1
           from paired_windows pw
          where pw.assignment_id = a.assignment_id
            and pw.next_bucket_state is null
       )
    union all
    select 'ACTIVE_WITH_UNPAIRED_TRAILING_PAUSE'::text as diagnostic_kind,
           pw.assignment_id,
           pw.paused_at as event_at,
           'paused_date=' || pw.paused_date::text || ',current_state=ACTIVE' as detail
      from paired_windows pw
     where pw.next_bucket_state is null
       and pw.current_state = 'ACTIVE'
       and pw.is_current
    order by diagnostic_kind, assignment_id, event_at nulls first
  loop
    raise notice 'WP10-6 pause-windows audit diagnostic: kind=% assignment_id=% event_at=% detail=%',
      v_diag.diagnostic_kind,
      v_diag.assignment_id,
      coalesce(v_diag.event_at::text, 'none'),
      v_diag.detail;
  end loop;
end
$diagnose_wp10_6_pause_audit$;

-- -----------------------------------------------------------------------------
-- 3. Materialization & Read-Only Probe Paths (Unified Pause-Window Exclusion)
-- -----------------------------------------------------------------------------
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
       and not exists (
         select 1
           from public.work_report_assignment_pause_windows pw
          where pw.assignment_id = aa.assignment_id
            and pw.paused_date <= wd.business_date
            and (pw.resumed_date is null or wd.business_date < pw.resumed_date)
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
             else coalesce(
               (
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
                    and not exists (
                      select 1
                        from public.work_report_assignment_pause_windows pw
                       where pw.assignment_id = a.assignment_id
                         and pw.paused_date <= gs::date
                         and (pw.resumed_date is null or gs::date < pw.resumed_date)
                    )
                  order by gs desc
                  limit 1
               ),
               public.work_report__internal_team_on_date(p_app_user_id, d.period_start_date)
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
       and not exists (
         select 1
           from public.work_report_assignment_pause_windows pw
          where pw.assignment_id = a.assignment_id
            and pw.paused_date <= p_business_date
            and (pw.resumed_date is null or p_business_date < pw.resumed_date)
       )
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
                  and (
                    o_once.obligation_status <> 'CANCELLED'
                    or exists (
                      select 1
                        from public.work_report_submissions s_once
                       where s_once.obligation_id = o_once.obligation_id
                         and s_once.first_submitted_at is not null
                    )
                  )
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
    select a.assignment_id,
           a.template_id,
           a.template_version_id,
           a.target_kind,
           a.target_user_id,
           a.target_team_id,
           a.target_group_id,
           a.frequency,
           a.is_mandatory,
           a.due_day_offset,
           a.due_time_local,
           a.exclude_sundays,
           a.effective_from,
           a.effective_to,
           a.assigned_by_user_id,
           a.state,
           a.is_current,
           a.version,
           a.created_at,
           a.updated_at,
           a.assignee_id,
           case
             when a.frequency = 'ONCE' and o_cancel.period_start_date is not null then
               case
                 when a.target_kind = 'TEAM' then a.target_team_id
                 else public.work_report__internal_team_on_date(a.assignee_id, o_cancel.period_start_date)
               end
             else a.team_id
           end as team_id,
           a.snapshot_group_id,
           a.snapshot_group_name,
           coalesce(o_cancel.period_key, p.period_key) as period_key,
           coalesce(o_cancel.period_start_date, p.period_start_date) as period_start_date,
           coalesce(o_cancel.period_end_date, p.period_end_date) as period_end_date,
           public.work_report_due_at(
             coalesce(o_cancel.period_end_date, p.period_end_date),
             a.due_day_offset,
             a.due_time_local,
             a.exclude_sundays
           ) as due_at
      from authorized a
      cross join lateral public.work_report_period(a.frequency, p_business_date) p
      left join lateral (
        select o_c.period_key,
               o_c.period_start_date,
               o_c.period_end_date
          from public.work_report_obligations o_c
         where a.frequency = 'ONCE'
           and o_c.assignment_id = a.assignment_id
           and o_c.assignee_app_user_id = a.assignee_id
           and o_c.period_type = 'ONCE'
           and o_c.obligation_status = 'CANCELLED'
           and not exists (
             select 1
               from public.work_report_submissions s_c
              where s_c.obligation_id = o_c.obligation_id
                and s_c.first_submitted_at is not null
           )
         order by o_c.period_start_date asc, o_c.obligation_id asc
         limit 1
      ) o_cancel on true
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
       and not exists (
         select 1
           from public.work_report_assignment_pause_windows pw
          where pw.assignment_id = a.assignment_id
            and pw.paused_date <= p_business_date
            and (pw.resumed_date is null or p_business_date < pw.resumed_date)
       )
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
                  and (
                    o_once.obligation_status <> 'CANCELLED'
                    or exists (
                      select 1
                        from public.work_report_submissions s_once
                       where s_once.obligation_id = o_once.obligation_id
                         and s_once.first_submitted_at is not null
                    )
                  )
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
    select a.assignment_id,
           a.template_id,
           a.template_version_id,
           a.target_kind,
           a.target_user_id,
           a.target_team_id,
           a.target_group_id,
           a.frequency,
           a.is_mandatory,
           a.due_day_offset,
           a.due_time_local,
           a.exclude_sundays,
           a.effective_from,
           a.effective_to,
           a.assigned_by_user_id,
           a.state,
           a.is_current,
           a.version,
           a.created_at,
           a.updated_at,
           a.assignee_id,
           case
             when a.frequency = 'ONCE' and o_cancel.period_start_date is not null then
               case
                 when a.target_kind = 'TEAM' then a.target_team_id
                 else public.work_report__internal_team_on_date(a.assignee_id, o_cancel.period_start_date)
               end
             else a.team_id
           end as team_id,
           a.snapshot_group_id,
           a.snapshot_group_name,
           coalesce(o_cancel.period_key, p.period_key) as period_key,
           coalesce(o_cancel.period_start_date, p.period_start_date) as period_start_date,
           coalesce(o_cancel.period_end_date, p.period_end_date) as period_end_date,
           public.work_report_due_at(
             coalesce(o_cancel.period_end_date, p.period_end_date),
             a.due_day_offset,
             a.due_time_local,
             a.exclude_sundays
           ) as due_at
      from authorized a
      cross join lateral public.work_report_period(a.frequency, p_business_date) p
      left join lateral (
        select o_c.period_key,
               o_c.period_start_date,
               o_c.period_end_date
          from public.work_report_obligations o_c
         where a.frequency = 'ONCE'
           and o_c.assignment_id = a.assignment_id
           and o_c.assignee_app_user_id = a.assignee_id
           and o_c.period_type = 'ONCE'
           and o_c.obligation_status = 'CANCELLED'
           and not exists (
             select 1
               from public.work_report_submissions s_c
              where s_c.obligation_id = o_c.obligation_id
                and s_c.first_submitted_at is not null
           )
         order by o_c.period_start_date asc, o_c.obligation_id asc
         limit 1
      ) o_cancel on true
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
    pg_catalog.jsonb_build_object('business_date', p_business_date, 'inserted_count', v_inserted)
  );

  return pg_catalog.jsonb_build_object('business_date', p_business_date, 'inserted_count', v_inserted);
end;
$$;

revoke all on function public.work_report_ensure_obligations_for_window(uuid, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_ensure_obligations_for_window(uuid, uuid, date)
  to service_role;

-- -----------------------------------------------------------------------------
-- 4. State Transition & Bulk Template Archive Pause-Window Maintenance
-- -----------------------------------------------------------------------------
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
  v_now timestamptz := pg_catalog.now();
  v_today_vn date := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
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

  -- FOR NO KEY UPDATE serializes all state/pause-window mutations on this assignment
  -- without blocking FK FOR KEY SHARE checks from concurrent obligation materializers.
  select *
    into v_assignment
    from public.work_report_assignments
   where assignment_id = p_assignment_id
     for no key update;
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

  v_request_hash := public.direct_entry_payload_hash(pg_catalog.jsonb_build_object(
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
         updated_at = v_now
   where assignment_id = p_assignment_id;

  -- Maintain half-open pause windows under the assignment FOR NO KEY UPDATE lock.
  if v_assignment.state <> 'PAUSED' and p_state = 'PAUSED' then
    insert into public.work_report_assignment_pause_windows (
      assignment_id,
      paused_date,
      resumed_date,
      created_at,
      updated_at
    )
    values (
      p_assignment_id,
      v_today_vn,
      null,
      v_now,
      v_now
    )
    on conflict (assignment_id) where resumed_date is null do nothing;
  elsif p_state in ('ACTIVE', 'REVOKED') then
    -- Safe 0-row no-op if pre-upgrade PAUSED had no open window; greatest() guards clock skew.
    update public.work_report_assignment_pause_windows
       set resumed_date = greatest(paused_date, v_today_vn),
           updated_at = v_now
     where assignment_id = p_assignment_id
       and resumed_date is null;
  end if;

  if p_state = 'REVOKED' then
    update public.work_report_obligations
       set obligation_status = 'CANCELLED',
           status_changed_by_user_id = p_app_user_id,
           version = version + 1,
           updated_at = v_now
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
      v_today_vn
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
    pg_catalog.jsonb_build_object(
      'assignment_id', p_assignment_id,
      'state', p_state,
      'delegation_id', v_delegation_id
    )
  );

  v_result := pg_catalog.jsonb_build_object(
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
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)
  to service_role;

create or replace function public.work_report_archive_template(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_today_vn date := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_revoked_assignment_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  -- Tier 2 FOR SHARE lock on actor to serialize against concurrent disable / role revoke.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
   for share;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  v_request_hash := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object('template_id', p_template_id, 'expected_version', p_expected_version)
  );
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_template_archive',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  update public.work_report_templates
     set status = 'ARCHIVED', version = version + 1, updated_at = v_now
   where template_id = p_template_id
     and version = p_expected_version
     and status <> 'ARCHIVED';
  if not found then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  -- Lock current assignments in deterministic assignment_id ASC order before bulk revoke
  -- and closing any open pause windows.
  select pg_catalog.array_agg(locked.assignment_id order by locked.assignment_id asc)
    into v_revoked_assignment_ids
    from (
      select a.assignment_id
        from public.work_report_assignments a
       where a.template_id = p_template_id
         and a.is_current
       order by a.assignment_id asc
       for no key update
    ) locked;

  if coalesce(pg_catalog.cardinality(v_revoked_assignment_ids), 0) > 0 then
    update public.work_report_assignments
       set state = 'REVOKED', is_current = false, version = version + 1, updated_at = v_now
     where assignment_id = any(v_revoked_assignment_ids);

    update public.work_report_assignment_pause_windows
       set resumed_date = greatest(paused_date, v_today_vn),
           updated_at = v_now
     where assignment_id = any(v_revoked_assignment_ids)
       and resumed_date is null;
  end if;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    template_id,
    outcome
  )
  values (
    'TEMPLATE_ARCHIVE',
    p_app_user_id,
    'report_form_manage',
    'all',
    p_template_id,
    'APPLIED'
  );

  v_result := pg_catalog.jsonb_build_object(
    'template_id', p_template_id,
    'status', 'ARCHIVED',
    'version', p_expected_version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_template_archive',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$$;

revoke all on function public.work_report_archive_template(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_archive_template(uuid, uuid, uuid, integer, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 5. Owner Alignment & Install-Time Security / Volatility / ACL Self-Check
-- -----------------------------------------------------------------------------
do $align_and_check_wp10_6_pause_windows$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_table_owner_oid oid;
  v_rls boolean;
  v_force_rls boolean;
  v_table_exposed integer;
  v_proc_owner_oid oid;
  v_overload_cnt integer := 0;
  v_oid oid;
  v_secdef boolean;
  v_volatile char;
  v_proconfig text[];
  v_owner_priv boolean;
  v_owner_exec boolean;
  v_service_exec boolean;
  v_exposed integer;
  v_name text;
  v_sig text;
  v_fn_names text[] := array[
    'work_report__internal_actor_materialization_candidates',
    'work_report__internal_materialize_actor_obligations',
    'work_report__internal_materialize_assignment_for_date',
    'work_report_ensure_obligations_for_window',
    'work_report_set_assignment_state',
    'work_report_archive_template',
    'work_report_has_active_obligations'
  ];
  v_internal_fns text[] := array[
    'public.work_report__internal_actor_materialization_candidates(uuid,date,integer)',
    'public.work_report__internal_materialize_actor_obligations(uuid,date,integer)',
    'public.work_report__internal_materialize_assignment_for_date(uuid,date)'
  ];
  v_service_rpcs text[] := array[
    'public.work_report_ensure_obligations_for_window(uuid,uuid,date)',
    'public.work_report_set_assignment_state(uuid,uuid,uuid,integer,text,text)',
    'public.work_report_archive_template(uuid,uuid,uuid,integer,text)'
  ];
  v_stable_fns text[] := array[
    'public.work_report__internal_actor_materialization_candidates(uuid,date,integer)',
    'public.work_report_has_active_obligations(uuid,uuid)'
  ];
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.work_report_assignments'::pg_catalog.regclass;

  if v_base_owner_oid is null or v_base_owner is null then
    raise exception 'WP10-6 pause-windows alignment failed: missing base table owner'
      using errcode = '55000';
  end if;

  -- Align table owner and verify strict RLS + zero runtime table privileges.
  select c.relowner
    into v_table_owner_oid
    from pg_catalog.pg_class c
   where c.oid = 'public.work_report_assignment_pause_windows'::pg_catalog.regclass;

  if v_table_owner_oid is distinct from v_base_owner_oid
     and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    execute pg_catalog.format(
      'alter table public.work_report_assignment_pause_windows owner to %I',
      v_base_owner
    );
  end if;

  revoke all on table public.work_report_assignment_pause_windows
    from public, anon, authenticated, service_role;

  select c.relrowsecurity, c.relforcerowsecurity
    into v_rls, v_force_rls
    from pg_catalog.pg_class c
   where c.oid = 'public.work_report_assignment_pause_windows'::pg_catalog.regclass;

  select pg_catalog.count(*)::integer
    into v_table_exposed
    from pg_catalog.pg_class c
    cross join lateral pg_catalog.aclexplode(
      coalesce(c.relacl, pg_catalog.acldefault('r', c.relowner))
    ) a
    left join pg_catalog.pg_roles gr on gr.oid = a.grantee
   where c.oid = 'public.work_report_assignment_pause_windows'::pg_catalog.regclass
     and (a.grantee = 0 or gr.rolname in ('anon', 'authenticated', 'service_role'));

  if not coalesce(v_rls, false)
     or not coalesce(v_force_rls, false)
     or v_table_exposed <> 0
     or pg_catalog.has_table_privilege('anon', 'public.work_report_assignment_pause_windows', 'SELECT')
     or pg_catalog.has_table_privilege('authenticated', 'public.work_report_assignment_pause_windows', 'SELECT')
     or pg_catalog.has_table_privilege('service_role', 'public.work_report_assignment_pause_windows', 'SELECT') then
    raise exception 'WP10-6 pause-windows check failed: table RLS/ACL invalid'
      using errcode = '55000';
  end if;

  foreach v_name in array v_fn_names loop
    select pg_catalog.count(*)::integer
      into v_overload_cnt
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = v_name;

    if v_overload_cnt <> 1 then
      raise exception 'WP10-6 pause-windows check failed: expected single overload for %, found %',
        v_name, v_overload_cnt
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-6 pause-windows check failed: missing internal function %', v_sig
        using errcode = '55000';
    end if;

    select p.proowner into v_proc_owner_oid from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;

    execute pg_catalog.format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      v_sig
    );

    select p.prosecdef,
           p.proconfig,
           (r.rolsuper or r.rolbypassrls),
           pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE')
      into v_secdef, v_proconfig, v_owner_priv, v_owner_exec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_secdef, false)
       or not coalesce(v_owner_priv, false)
       or not coalesce(v_owner_exec, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP10-6 pause-windows check failed: definer/owner/search_path invalid on %', v_sig
        using errcode = '55000';
    end if;

    select pg_catalog.count(*)::integer
      into v_exposed
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) a
      left join pg_catalog.pg_roles gr on gr.oid = a.grantee
     where p.oid = v_oid
       and (a.grantee = 0 or gr.rolname in ('anon', 'authenticated', 'service_role'));

    if v_exposed <> 0
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'WP10-6 pause-windows check failed: internal ACL exposed on %', v_sig
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-6 pause-windows check failed: missing service RPC %', v_sig
        using errcode = '55000';
    end if;

    select p.proowner into v_proc_owner_oid from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;

    execute pg_catalog.format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      v_sig
    );
    execute pg_catalog.format(
      'grant execute on function %s to service_role',
      v_sig
    );

    select p.prosecdef,
           p.proconfig,
           (r.rolsuper or r.rolbypassrls),
           pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE'),
           pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
      into v_secdef, v_proconfig, v_owner_priv, v_owner_exec, v_service_exec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_secdef, false)
       or not coalesce(v_owner_priv, false)
       or not coalesce(v_owner_exec, false)
       or not coalesce(v_service_exec, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP10-6 pause-windows check failed: definer/owner/search_path invalid on %', v_sig
        using errcode = '55000';
    end if;

    select pg_catalog.count(*)::integer
      into v_exposed
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) a
      left join pg_catalog.pg_roles gr on gr.oid = a.grantee
     where p.oid = v_oid
       and (a.grantee = 0 or gr.rolname in ('anon', 'authenticated'));

    if v_exposed <> 0
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'WP10-6 pause-windows check failed: RPC ACL exposed on %', v_sig
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_stable_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    select p.provolatile into v_volatile from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_volatile is distinct from 's' then
      raise exception 'WP10-6 pause-windows check failed: expected STABLE volatility on %', v_sig
        using errcode = '55000';
    end if;
  end loop;
end
$align_and_check_wp10_6_pause_windows$;

commit;
