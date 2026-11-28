begin;

-- Hotfix: optimize Dashboard Recruitment options and scoped facts reads under
-- concurrent load without altering reporting semantics or security boundaries.

create index if not exists direct_entries_active_first_work_date_idx
  on public.direct_entries (first_work_date, submission_id)
  where deleted_at is null and voided_at is null;

create index if not exists direct_entries_active_team_idx
  on public.direct_entries (team_id, first_work_date)
  where deleted_at is null and voided_at is null;

create index if not exists direct_entries_active_recruiter_idx
  on public.direct_entries (recruiter_id, first_work_date)
  where deleted_at is null and voided_at is null;

-- Internal single-pass bucket scan for direct-entry reporting options.
-- Takes an already-resolved audience object so callers never invoke
-- direct_entry_reporting_resolve_audience twice.
create or replace function public.direct_entry_reporting__internal_de_option_buckets(
  p_audience jsonb
)
returns table (
  dim_kind text,
  project_id text,
  recruiter_id uuid,
  provider_type text,
  labor_type text,
  cnt bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_kind text := p_audience->>'audience';
  v_team_ids uuid[];
  v_recruiter_id uuid;
begin
  if v_kind = 'all' then
    return query
      select case
               when grouping(e.project_id) = 0 then 'project'
               when grouping(e.recruiter_id) = 0 then 'recruiter'
               when grouping(e.provider_type) = 0 then 'provider'
               else 'employment'
             end as dim_kind,
             e.project_id,
             e.recruiter_id,
             e.provider_type,
             e.labor_type,
             count(*)::bigint as cnt
        from public.direct_entries e
        join public.direct_entry_submissions s
          on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null
         and e.voided_at is null
       group by grouping sets (
         (e.project_id),
         (e.recruiter_id),
         (e.provider_type),
         (e.labor_type)
       );
  elsif v_kind = 'team' then
    v_team_ids := array(
      select jsonb_array_elements_text(p_audience->'team_ids')::uuid
    );
    return query
      select case
               when grouping(e.project_id) = 0 then 'project'
               when grouping(e.recruiter_id) = 0 then 'recruiter'
               when grouping(e.provider_type) = 0 then 'provider'
               else 'employment'
             end as dim_kind,
             e.project_id,
             e.recruiter_id,
             e.provider_type,
             e.labor_type,
             count(*)::bigint as cnt
        from public.direct_entries e
        join public.direct_entry_submissions s
          on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null
         and e.voided_at is null
         and e.team_id = any(v_team_ids)
       group by grouping sets (
         (e.project_id),
         (e.recruiter_id),
         (e.provider_type),
         (e.labor_type)
       );
  else
    v_recruiter_id := nullif(p_audience->>'recruiter_id', '')::uuid;
    if v_recruiter_id is null then
      return;
    end if;
    return query
      select case
               when grouping(e.project_id) = 0 then 'project'
               when grouping(e.recruiter_id) = 0 then 'recruiter'
               when grouping(e.provider_type) = 0 then 'provider'
               else 'employment'
             end as dim_kind,
             e.project_id,
             e.recruiter_id,
             e.provider_type,
             e.labor_type,
             count(*)::bigint as cnt
        from public.direct_entries e
        join public.direct_entry_submissions s
          on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null
         and e.voided_at is null
         and e.recruiter_id = v_recruiter_id
       group by grouping sets (
         (e.project_id),
         (e.recruiter_id),
         (e.provider_type),
         (e.labor_type)
       );
  end if;
end;
$$;

comment on function public.direct_entry_reporting__internal_de_option_buckets(jsonb) is
  'Internal helper: single-pass GROUPING SETS bucket counts for direct-entry reporting options from a pre-resolved audience.';
revoke all on function public.direct_entry_reporting__internal_de_option_buckets(jsonb)
  from public, anon, authenticated, service_role;

-- Internal option label normalizer & merger operating only on distinct buckets.
create or replace function public.direct_entry_reporting__internal_de_options_for_audience(
  p_audience jsonb
)
returns table (
  dimension text,
  key text,
  display text,
  recruited_count integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with grouped_raw as materialized (
    select b.dim_kind,
           b.project_id,
           b.recruiter_id,
           b.provider_type,
           b.labor_type,
           b.cnt
      from public.direct_entry_reporting__internal_de_option_buckets(p_audience) b
  ),
  normalized as (
    select 'project'::text as dimension,
           public.direct_entry_reporting_dim_key(p.display_name) as key,
           p.display_name as display,
           g.cnt
      from grouped_raw g
      join public.direct_entry_projects p
        on p.project_id = g.project_id
     where g.dim_kind = 'project'
    union all
    select 'recruiter'::text as dimension,
           public.direct_entry_reporting_dim_key(r.display_name) as key,
           r.display_name as display,
           g.cnt
      from grouped_raw g
      join public.recruiters r
        on r.recruiter_id = g.recruiter_id
     where g.dim_kind = 'recruiter'
    union all
    select 'provider'::text as dimension,
           g.provider_type as key,
           case g.provider_type
             when 'hrp' then 'HRP'
             when 'vendor' then 'Vendor'
             else 'Không xác định'
           end as display,
           g.cnt
      from grouped_raw g
     where g.dim_kind = 'provider'
    union all
    select 'employment'::text as dimension,
           emp.employment_type_key as key,
           emp.employment_type_display as display,
           g.cnt
      from grouped_raw g
      cross join lateral (
        select public.direct_entry_reporting_employment_key(g.labor_type) as employment_type_key,
               public.direct_entry_reporting_employment_display(g.labor_type) as employment_type_display
      ) emp
     where g.dim_kind = 'employment'
  )
  select n.dimension,
         n.key,
         n.display,
         sum(n.cnt)::integer as recruited_count
    from normalized n
   group by n.dimension, n.key, n.display
$$;

comment on function public.direct_entry_reporting__internal_de_options_for_audience(jsonb) is
  'Internal helper: normalize and merge distinct reporting dimension option buckets for a pre-resolved audience.';
revoke all on function public.direct_entry_reporting__internal_de_options_for_audience(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_reporting_de_options_scoped(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns table (
  dimension text,
  key text,
  display text,
  recruited_count integer
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  -- Delegates to __internal_de_options_for_audience, which resolves
  -- employment_type_key and employment_type_display via the labor-type catalog.
  select o.dimension,
         o.key,
         o.display,
         o.recruited_count
    from public.direct_entry_reporting__internal_de_options_for_audience(
           public.direct_entry_reporting_resolve_audience(p_auth_subject, p_app_user_id)
         ) o
$$;

revoke all on function public.direct_entry_reporting_de_options_scoped(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_reporting_scoped_options(
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
  v_audience jsonb := public.direct_entry_reporting_resolve_audience(
    p_auth_subject, p_app_user_id
  );
  v_dimensions jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'dimension', d.dimension,
           'key', d.key,
           'display', d.display,
           'recruited_count', d.recruited_count
         ) order by d.dimension, d.key, d.display), '[]'::jsonb)
    into v_dimensions
    from public.direct_entry_reporting__internal_de_options_for_audience(v_audience) d;

  return jsonb_build_object(
    'audience', v_audience,
    'dimensions', v_dimensions,
    'sources', '[]'::jsonb
  );
end;
$$;

comment on function public.direct_entry_reporting_scoped_options(uuid, uuid) is
  'HF: single-pass actor-scoped Direct Entry dimensions without redundant resolve_audience or facts_v01 sort.';
revoke all on function public.direct_entry_reporting_scoped_options(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_scoped_options(uuid, uuid)
  to service_role;

-- Internal entry scanner for direct_entry_reporting_scoped_facts:
-- pushes audience, date bounds, and provider_type before dimension joins.
create or replace function public.direct_entry_reporting__internal_scoped_facts_entries(
  p_audience jsonb,
  p_from date,
  p_to date,
  p_provider text
)
returns table (
  entry_id uuid,
  submission_id uuid,
  project_id text,
  recruiter_id uuid,
  team_id uuid,
  first_work_date date,
  provider_type text,
  labor_type text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_kind text := p_audience->>'audience';
  v_team_ids uuid[];
  v_recruiter_id uuid;
  v_from_bound date := coalesce(p_from, '0001-01-01'::date);
  v_to_bound date := coalesce(p_to, '9999-12-31'::date);
begin
  if v_kind = 'all' then
    return query
      select e.entry_id,
             e.submission_id,
             e.project_id,
             e.recruiter_id,
             e.team_id,
             e.first_work_date,
             e.provider_type,
             e.labor_type
        from public.direct_entries e
        join public.direct_entry_submissions s
          on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null
         and e.voided_at is null
         and e.first_work_date >= v_from_bound
         and e.first_work_date <= v_to_bound
         and (p_provider is null or e.provider_type = p_provider);
  elsif v_kind = 'team' then
    v_team_ids := array(
      select jsonb_array_elements_text(p_audience->'team_ids')::uuid
    );
    return query
      select e.entry_id,
             e.submission_id,
             e.project_id,
             e.recruiter_id,
             e.team_id,
             e.first_work_date,
             e.provider_type,
             e.labor_type
        from public.direct_entries e
        join public.direct_entry_submissions s
          on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null
         and e.voided_at is null
         and e.team_id = any(v_team_ids)
         and e.first_work_date >= v_from_bound
         and e.first_work_date <= v_to_bound
         and (p_provider is null or e.provider_type = p_provider);
  else
    v_recruiter_id := nullif(p_audience->>'recruiter_id', '')::uuid;
    if v_recruiter_id is null then
      return;
    end if;
    return query
      select e.entry_id,
             e.submission_id,
             e.project_id,
             e.recruiter_id,
             e.team_id,
             e.first_work_date,
             e.provider_type,
             e.labor_type
        from public.direct_entries e
        join public.direct_entry_submissions s
          on s.submission_id = e.submission_id
       where s.state = 'SUBMITTED'
         and e.deleted_at is null
         and e.voided_at is null
         and e.recruiter_id = v_recruiter_id
         and e.first_work_date >= v_from_bound
         and e.first_work_date <= v_to_bound
         and (p_provider is null or e.provider_type = p_provider);
  end if;
end;
$$;

comment on function public.direct_entry_reporting__internal_scoped_facts_entries(jsonb, date, date, text) is
  'Internal helper: scoped active submitted direct_entries reader with audience, date, and provider pushdown.';
revoke all on function public.direct_entry_reporting__internal_scoped_facts_entries(jsonb, date, date, text)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_reporting_scoped_facts(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_filters jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_audience jsonb := public.direct_entry_reporting_resolve_audience(
    p_auth_subject, p_app_user_id
  );
  v_from date;
  v_to date;
  v_project text;
  v_recruiter text;
  v_provider text;
  v_employment text;
  v_status text;
  v_status_as_of date;
  v_source_id text := public.direct_entry_reporting_source_id()::text;
  v_facts jsonb;
begin
  v_from := nullif(p_filters->>'from', '')::date;
  v_to := nullif(p_filters->>'to', '')::date;
  v_project := nullif(p_filters->>'project', '');
  v_recruiter := nullif(p_filters->>'recruiter', '');
  v_provider := nullif(p_filters->>'provider', '');
  v_employment := nullif(p_filters->>'employment', '');
  v_status := nullif(p_filters->>'status', '');
  if v_status is not null and v_status not in ('ON', 'OFF', 'UNCONFIRMED') then
    raise exception 'invalid work status filter' using errcode = '22023';
  end if;
  v_status_as_of := coalesce(v_to, public.direct_entry_authorization_date());

  with proj as materialized (
    select p.project_id,
           p.display_name,
           public.direct_entry_reporting_dim_key(p.display_name) as project_key
      from public.direct_entry_projects p
  ),
  rec as materialized (
    select r.recruiter_id,
           r.display_name,
           public.direct_entry_reporting_dim_key(r.display_name) as recruiter_key
      from public.recruiters r
  ),
  lt as materialized (
    select l.labor_type_key,
           l.reporting_key,
           l.display_name
      from public.direct_entry_labor_types l
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'source_id', v_source_id,
           'business_date', to_char(e.first_work_date, 'YYYY-MM-DD'),
           'project_key', p.project_key,
           'project_display', p.display_name,
           'recruiter_key', r.recruiter_key,
           'recruiter_display', r.display_name,
           'provider_type_key', e.provider_type,
           'provider_type_display', case e.provider_type
             when 'hrp' then 'HRP'
             when 'vendor' then 'Vendor'
             else 'Không xác định'
           end,
           'employment_type_key', coalesce(l.reporting_key, '__unknown__'),
           'employment_type_display', coalesce(l.display_name, 'Không xác định'),
           'recruited_count', 1::integer,
           'first_work_date', to_char(e.first_work_date, 'YYYY-MM-DD'),
           'entry_id', e.entry_id,
           'submission_id', e.submission_id,
           'cutoff_date', null,
           'team_id', t.team_id,
           'team_code', t.code,
           'team_display_name', t.display_name,
           'team_active', t.active
         ) order by e.first_work_date, p.project_key, r.recruiter_key,
                    e.provider_type, coalesce(l.reporting_key, '__unknown__'), e.entry_id), '[]'::jsonb)
    into v_facts
    from public.direct_entry_reporting__internal_scoped_facts_entries(
           v_audience, v_from, v_to, v_provider
         ) e
    join proj p
      on p.project_id = e.project_id
    join rec r
      on r.recruiter_id = e.recruiter_id
    left join lt l
      on l.labor_type_key = e.labor_type
    left join public.teams t
      on t.team_id = e.team_id
   where (v_project is null or p.project_key = v_project)
     and (v_recruiter is null or r.recruiter_key = v_recruiter)
     and (v_employment is null or coalesce(l.reporting_key, '__unknown__') = v_employment)
     and (
       v_status is null
       or (
         e.first_work_date <= v_status_as_of
         and coalesce((
           select ev.status
             from public.direct_entry_employment_status_events ev
            where ev.entry_id = e.entry_id
              and ev.effective_date <= v_status_as_of
              and not exists (
                select 1
                  from public.direct_entry_employment_status_events replacement
                 where replacement.supersedes_event_id = ev.event_id
              )
            order by ev.effective_date desc, ev.version desc
            limit 1
         ), 'UNKNOWN') = v_status
       )
     );

  return jsonb_build_object(
    'audience', v_audience,
    'facts', v_facts,
    'sources', '[]'::jsonb,
    'latest_runs', '[]'::jsonb,
    'presence', '[]'::jsonb
  );
end;
$$;

comment on function public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb) is
  'HF: actor-scoped Direct Entry facts with single resolve_audience, filter pushdown, and set-based labor/dim lookup.';
revoke all on function public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.direct_entry_reporting_scoped_facts(uuid, uuid, jsonb)
  to service_role;

commit;
