-- PR #28 Phase A: Canonical Unified User Directory Read Model
--
-- Provides two read-only Full Admin service_role RPCs that merge
-- `public.organization_persons` and `public.direct_entry_app_users` strictly via
-- verified effective 1:1 rows in `public.organization_account_person_links` at
-- the same as-of timestamp (`v_as_of`):
--   1. `public.org_department_list_user_directory_admin(...)`
--      Server-side unified directory with filter-before-COUNT, deterministic
--      total ordering, and server pagination across page boundaries.
--   2. `public.org_department_get_user_directory_entry_admin(...)`
--      Canonical detail & deep-link resolver by either `person_id` or
--      `account_ref` (never redirects blindly to a nonexistent Person).
--
-- Merge invariants (Rev 2):
--   - ONLY unique effective rows in `organization_account_person_links`
--     (`started_at <= v_as_of` and `(ended_at is null or v_as_of < ended_at)`
--     and `(ended_at is null or ended_at > started_at)`) with zero recruiter
--     identity contradictions merge a Person and an Account into one
--     `LINKED_PERSON_ACCOUNT` row.
--   - NEVER merges by full_name, display_name, email, login_id, or recruiters.
--   - NEVER synthesizes rows from `public.recruiters` alone.
--   - NEVER drops unlinked accounts (`UNLINKED_ACCOUNT`) or reads `account_type`.
--   - Keeps `person.status` (ACTIVE/INACTIVE) and `account.enabled` (true/false)
--     independent on linked rows.
--   - If conflicting / multiple effective links or recruiter contradictions touch
--     a Person or Account, NEVER picks LIMIT 1 or drops any account: emits
--     `PERSON_LINK_CONFLICT` and `ACCOUNT_LINK_CONFLICT` separately with
--     `link_conflict = true` and `identity_mutation_blocked = true`.

begin;

create or replace function public.org_department_list_user_directory_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_record_kind text default 'all',
  p_person_status text default 'all',
  p_login_state text default 'all',
  p_department_id uuid default null,
  p_as_of timestamp with time zone default null,
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
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_auth_date date := (v_as_of at time zone 'Asia/Ho_Chi_Minh')::date;
  v_search text := null;
  v_search_pattern text := null;
  v_offset integer;
  v_total integer := 0;
  v_summary jsonb;
  v_entries jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_record_kind is null or p_record_kind not in ('all', 'person', 'unlinked_account', 'conflict')
     or p_person_status is null or p_person_status not in ('all', 'active', 'inactive', 'none')
     or p_login_state is null or p_login_state not in ('all', 'enabled', 'disabled', 'no_account')
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = '' or pg_catalog.length(v_search) > 100 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
    end if;
    v_search_pattern :=
      '%' ||
      pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(v_search, '\', '\\'),
          '%',
          '\%'
        ),
        '_',
        '\_'
      ) ||
      '%';
  end if;

  v_offset := (p_page - 1) * p_page_size;

  with effective_links as (
    select l.link_id,
           l.app_user_id,
           l.person_id,
           l.started_at,
           l.source_kind,
           l.evidence_date,
           l.version
      from public.organization_account_person_links l
     where l.started_at <= v_as_of
       and (l.ended_at is null or v_as_of < l.ended_at)
       and (l.ended_at is null or l.ended_at > l.started_at)
  ),
  -- Honors R1/WP5B1 semantics: deactivated recruiter links have valid_to IS NULL + is_current = false
  -- + suspended_by_account_disable = false, whereas account-disabled links keep suspended_by_account_disable = true.
  effective_recruiter_links as (
    select rl.app_user_id,
           rl.recruiter_id
      from public.direct_entry_app_user_recruiter_links rl
     where rl.verified = true
       and (
         (p_as_of is null and (rl.is_current = true or rl.suspended_by_account_disable = true))
         or (
           p_as_of is not null
           and rl.valid_from <= v_auth_date
           and (
             (rl.valid_to is not null and rl.valid_to > rl.valid_from and v_auth_date < rl.valid_to)
             or (rl.valid_to is null and (rl.is_current = true or rl.suspended_by_account_disable = true))
           )
         )
       )
  ),
  person_link_stats as (
    select el.person_id,
           count(*)::integer as link_count
      from effective_links el
     group by el.person_id
  ),
  account_link_stats as (
    select el.app_user_id,
           count(*)::integer as link_count
      from effective_links el
     group by el.app_user_id
  ),
  evaluated_links as (
    select el.link_id,
           el.app_user_id,
           el.person_id,
           el.started_at,
           el.source_kind,
           el.evidence_date,
           el.version,
           pls.link_count as person_link_count,
           als.link_count as account_link_count,
           (
             -- Symmetric recruiter contradiction checks (WP3B R-INV-2):
             -- 1. Account verified-linked to a recruiter different from Person's recruiter_id
             exists (
               select 1
                 from public.organization_persons p_r
                 join effective_recruiter_links rl
                   on rl.app_user_id = el.app_user_id
                where p_r.person_id = el.person_id
                  and p_r.recruiter_id is not null
                  and rl.recruiter_id <> p_r.recruiter_id
             )
             -- 2. Account verified-linked to a recruiter owned by a different Person
             or exists (
               select 1
                 from effective_recruiter_links rl
                 join public.organization_persons p_other
                   on p_other.recruiter_id = rl.recruiter_id
                  and p_other.person_id <> el.person_id
                where rl.app_user_id = el.app_user_id
             )
             -- 3. Person's recruiter_id is verified-linked to a different Account
             or exists (
               select 1
                 from public.organization_persons p_r
                 join effective_recruiter_links rl_other
                   on rl_other.recruiter_id = p_r.recruiter_id
                  and rl_other.app_user_id <> el.app_user_id
                where p_r.person_id = el.person_id
                  and p_r.recruiter_id is not null
             )
             -- 4. Linked Account holds > 1 distinct effective verified recruiter links
             or (
               select count(distinct rl_cnt.recruiter_id)
                 from effective_recruiter_links rl_cnt
                where rl_cnt.app_user_id = el.app_user_id
             ) > 1
           ) as has_recruiter_conflict
      from effective_links el
      join person_link_stats pls on pls.person_id = el.person_id
      join account_link_stats als on als.app_user_id = el.app_user_id
  ),
  classified_links as (
    select ev.*,
           (
             ev.person_link_count = 1
             and ev.account_link_count = 1
             and not ev.has_recruiter_conflict
             and exists (
               select 1
                 from public.organization_persons p_chk
                where p_chk.person_id = ev.person_id
             )
             and exists (
               select 1
                 from public.direct_entry_app_users u_chk
                where u_chk.app_user_id = ev.app_user_id
             )
           ) as is_clean_unique
      from evaluated_links ev
  ),
  clean_links as (
    select *
      from classified_links
     where is_clean_unique
  ),
  conflict_links as (
    select *
      from classified_links
     where not is_clean_unique
  ),
  person_conflicts as (
    select cl.person_id,
           count(*)::integer as conflict_link_count,
           max(cl.person_link_count)::integer as person_link_count,
           bool_or(cl.has_recruiter_conflict) as has_recruiter_conflict,
           pg_catalog.jsonb_agg(cl.link_id order by cl.link_id asc) as link_ids,
           (
             select pg_catalog.jsonb_agg(distinct_pid order by distinct_pid asc)
               from (
                 select distinct cl2.person_id as distinct_pid
                   from conflict_links cl2
                  where cl2.person_id = cl.person_id
               ) pid_rows
           ) as related_person_ids,
           (
             select pg_catalog.jsonb_agg(distinct_uid order by distinct_uid asc)
               from (
                 select distinct cl2.app_user_id as distinct_uid
                   from conflict_links cl2
                  where cl2.person_id = cl.person_id
               ) uid_rows
           ) as related_account_refs
      from conflict_links cl
     group by cl.person_id
  ),
  account_conflicts as (
    select cl.app_user_id,
           count(*)::integer as conflict_link_count,
           max(cl.account_link_count)::integer as account_link_count,
           bool_or(cl.has_recruiter_conflict) as has_recruiter_conflict,
           pg_catalog.jsonb_agg(cl.link_id order by cl.link_id asc) as link_ids,
           (
             select pg_catalog.jsonb_agg(distinct_pid order by distinct_pid asc)
               from (
                 select distinct cl2.person_id as distinct_pid
                   from conflict_links cl2
                  where cl2.app_user_id = cl.app_user_id
               ) pid_rows
           ) as related_person_ids,
           (
             select pg_catalog.jsonb_agg(distinct_uid order by distinct_uid asc)
               from (
                 select distinct cl2.app_user_id as distinct_uid
                   from conflict_links cl2
                  where cl2.app_user_id = cl.app_user_id
               ) uid_rows
           ) as related_account_refs
      from conflict_links cl
     group by cl.app_user_id
  ),
  person_branch as (
    select 'person:' || p.person_id::text as directory_entry_key,
           case
             when pc.conflict_link_count is not null then 'PERSON_LINK_CONFLICT'
             when cl.link_id is not null then 'LINKED_PERSON_ACCOUNT'
             else 'PERSON_ONLY'
           end as record_kind,
           p.full_name as display_name,
           case
             when u.app_user_id is null then 'NO_ACCOUNT'
             when u.enabled then 'ENABLED'
             else 'DISABLED'
           end as login_state,
           p.person_id as person_id,
           u.app_user_id as account_ref,
           cl.link_id as active_link_id,
           (pc.conflict_link_count is not null) as link_conflict,
           (pc.conflict_link_count is not null) as identity_mutation_blocked,
           p.status as person_status,
           dept.department_id as active_department_id,
           p.full_name as sort_name,
           p.employee_code as sort_secondary,
           p.full_name as search_person_name,
           p.employee_code as search_employee_code,
           u.display_name as search_account_name,
           pg_catalog.lower(
             nullif(
               pg_catalog.btrim(
                 pg_catalog.split_part(
                   coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
                   pg_catalog.chr(64),
                   1
                 )
               ),
               ''
             )
           ) as search_login_id,
           pg_catalog.jsonb_build_object(
             'directory_entry_key', 'person:' || p.person_id::text,
             'record_kind',
               case
                 when pc.conflict_link_count is not null then 'PERSON_LINK_CONFLICT'
                 when cl.link_id is not null then 'LINKED_PERSON_ACCOUNT'
                 else 'PERSON_ONLY'
               end,
             'display_name', p.full_name,
             'login_state',
               case
                 when u.app_user_id is null then 'NO_ACCOUNT'
                 when u.enabled then 'ENABLED'
                 else 'DISABLED'
               end,
             'person_id', p.person_id,
             'account_ref', u.app_user_id,
             'active_link_id', cl.link_id,
             'link_conflict', (pc.conflict_link_count is not null),
             'identity_mutation_blocked', (pc.conflict_link_count is not null),
             'conflict_details',
               case
                 when pc.conflict_link_count is null then null
                 else pg_catalog.jsonb_build_object(
                   'reason',
                     case
                       when pc.person_link_count > 1 then 'MULTIPLE_ACTIVE_LINKS_FOR_PERSON'
                       when pc.has_recruiter_conflict then 'RECRUITER_IDENTITY_CONFLICT'
                       else 'ENDPOINT_LINK_CONFLICT'
                     end,
                   'link_ids', pc.link_ids,
                   'related_person_ids', pc.related_person_ids,
                   'related_account_refs', pc.related_account_refs
                 )
               end,
             'person', pg_catalog.jsonb_build_object(
               'person_id', p.person_id,
               'employee_code', p.employee_code,
               'full_name', p.full_name,
               'status', p.status,
               'joined_on', case when p.joined_on is null then null else p.joined_on::text end,
               'recruiter_id', p.recruiter_id,
               'version', p.version,
               'active_department', dept.department_json
             ),
             'account',
               case
                 when u.app_user_id is null then null
                 else pg_catalog.jsonb_build_object(
                   'account_ref', u.app_user_id,
                   'login_id', pg_catalog.lower(
                     nullif(
                       pg_catalog.btrim(
                         pg_catalog.split_part(
                           coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
                           pg_catalog.chr(64),
                           1
                         )
                       ),
                       ''
                     )
                   ),
                   'display_name', u.display_name,
                   'enabled', u.enabled,
                   'version', u.version,
                   'auth_user_present', (au.id is not null)
                 )
               end,
             'active_link',
               case
                 when cl.link_id is null then null
                 else pg_catalog.jsonb_build_object(
                   'link_id', cl.link_id,
                   'started_at', public.org_department__internal_iso_utc(cl.started_at),
                   'source_kind', cl.source_kind,
                   'evidence_date', case when cl.evidence_date is null then null else cl.evidence_date::text end,
                   'version', cl.version
                 )
               end
           ) as entry_json
      from public.organization_persons p
      left join clean_links cl on cl.person_id = p.person_id
      left join public.direct_entry_app_users u on u.app_user_id = cl.app_user_id
      left join auth.users au on au.id = u.auth_subject
      left join person_conflicts pc on pc.person_id = p.person_id
      left join lateral (
        select d.department_id,
               pg_catalog.jsonb_build_object(
                 'membership_id', m.membership_id,
                 'department_id', d.department_id,
                 'system_key', d.system_key,
                 'code', d.code,
                 'name', d.name,
                 'started_at', public.org_department__internal_iso_utc(m.started_at),
                 'source_kind', m.source_kind,
                 'evidence_date', case when m.evidence_date is null then null else m.evidence_date::text end,
                 'version', m.version
               ) as department_json
          from public.organization_person_department_memberships m
          join public.organization_departments d on d.department_id = m.department_id
         where m.person_id = p.person_id
           and m.started_at <= v_as_of
           and (m.ended_at is null or v_as_of < m.ended_at)
           and (m.ended_at is null or m.ended_at > m.started_at)
         order by m.started_at desc, m.membership_id desc
         limit 1
      ) dept on true
  ),
  account_branch as (
    select 'account:' || u.app_user_id::text as directory_entry_key,
           case
             when ac.conflict_link_count is not null then 'ACCOUNT_LINK_CONFLICT'
             else 'UNLINKED_ACCOUNT'
           end as record_kind,
           coalesce(
             nullif(pg_catalog.btrim(coalesce(u.display_name, '')), ''),
             pg_catalog.lower(
               nullif(
                 pg_catalog.btrim(
                   pg_catalog.split_part(
                     coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
                     pg_catalog.chr(64),
                     1
                   )
                 ),
                 ''
               )
             ),
             u.app_user_id::text
           ) as display_name,
           case
             when u.enabled then 'ENABLED'
             else 'DISABLED'
           end as login_state,
           null::uuid as person_id,
           u.app_user_id as account_ref,
           null::uuid as active_link_id,
           (ac.conflict_link_count is not null) as link_conflict,
           (ac.conflict_link_count is not null) as identity_mutation_blocked,
           null::text as person_status,
           null::uuid as active_department_id,
           coalesce(
             nullif(pg_catalog.btrim(coalesce(u.display_name, '')), ''),
             pg_catalog.lower(
               nullif(
                 pg_catalog.btrim(
                   pg_catalog.split_part(
                     coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
                     pg_catalog.chr(64),
                     1
                   )
                 ),
                 ''
               )
             ),
             u.app_user_id::text
           ) as sort_name,
           coalesce(
             pg_catalog.lower(
               nullif(
                 pg_catalog.btrim(
                   pg_catalog.split_part(
                     coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
                     pg_catalog.chr(64),
                     1
                   )
                 ),
                 ''
               )
             ),
             ''
           ) as sort_secondary,
           null::text as search_person_name,
           null::text as search_employee_code,
           u.display_name as search_account_name,
           pg_catalog.lower(
             nullif(
               pg_catalog.btrim(
                 pg_catalog.split_part(
                   coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
                   pg_catalog.chr(64),
                   1
                 )
               ),
               ''
             )
           ) as search_login_id,
           pg_catalog.jsonb_build_object(
             'directory_entry_key', 'account:' || u.app_user_id::text,
             'record_kind',
               case
                 when ac.conflict_link_count is not null then 'ACCOUNT_LINK_CONFLICT'
                 else 'UNLINKED_ACCOUNT'
               end,
             'display_name',
               coalesce(
                 nullif(pg_catalog.btrim(coalesce(u.display_name, '')), ''),
                 pg_catalog.lower(
                   nullif(
                     pg_catalog.btrim(
                       pg_catalog.split_part(
                         coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
                         pg_catalog.chr(64),
                         1
                       )
                     ),
                     ''
                   )
                 ),
                 u.app_user_id::text
               ),
             'login_state',
               case
                 when u.enabled then 'ENABLED'
                 else 'DISABLED'
               end,
             'person_id', null,
             'account_ref', u.app_user_id,
             'active_link_id', null,
             'link_conflict', (ac.conflict_link_count is not null),
             'identity_mutation_blocked', (ac.conflict_link_count is not null),
             'conflict_details',
               case
                 when ac.conflict_link_count is null then null
                 else pg_catalog.jsonb_build_object(
                   'reason',
                     case
                       when ac.account_link_count > 1 then 'MULTIPLE_ACTIVE_LINKS_FOR_ACCOUNT'
                       when ac.has_recruiter_conflict then 'RECRUITER_IDENTITY_CONFLICT'
                       else 'ENDPOINT_LINK_CONFLICT'
                     end,
                   'link_ids', ac.link_ids,
                   'related_person_ids', ac.related_person_ids,
                   'related_account_refs', ac.related_account_refs
                 )
               end,
             'person', null,
             'account', pg_catalog.jsonb_build_object(
               'account_ref', u.app_user_id,
               'login_id', pg_catalog.lower(
                 nullif(
                   pg_catalog.btrim(
                     pg_catalog.split_part(
                       coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
                       pg_catalog.chr(64),
                       1
                     )
                   ),
                   ''
                 )
               ),
               'display_name', u.display_name,
               'enabled', u.enabled,
               'version', u.version,
               'auth_user_present', (au.id is not null)
             ),
             'active_link', null
           ) as entry_json
      from public.direct_entry_app_users u
      left join auth.users au on au.id = u.auth_subject
      left join account_conflicts ac on ac.app_user_id = u.app_user_id
     where not exists (
       select 1
         from clean_links cl
        where cl.app_user_id = u.app_user_id
     )
  ),
  unified as (
    select * from person_branch
    union all
    select * from account_branch
  ),
  filtered as (
    select *
      from unified r
     where (
         p_record_kind = 'all'
         or (p_record_kind = 'person' and r.record_kind in ('LINKED_PERSON_ACCOUNT', 'PERSON_ONLY'))
         or (p_record_kind = 'unlinked_account' and r.record_kind = 'UNLINKED_ACCOUNT')
         or (p_record_kind = 'conflict' and r.link_conflict)
       )
       and (
         p_person_status = 'all'
         or (p_person_status = 'active' and r.person_status = 'ACTIVE')
         or (p_person_status = 'inactive' and r.person_status = 'INACTIVE')
         or (p_person_status = 'none' and r.person_status is null)
       )
       and (
         p_login_state = 'all'
         or (p_login_state = 'enabled' and r.login_state = 'ENABLED')
         or (p_login_state = 'disabled' and r.login_state = 'DISABLED')
         or (p_login_state = 'no_account' and r.login_state = 'NO_ACCOUNT')
       )
       and (p_department_id is null or r.active_department_id = p_department_id)
       and (
         v_search_pattern is null
         or coalesce(r.search_person_name, '') ilike v_search_pattern escape '\'
         or coalesce(r.search_employee_code, '') ilike v_search_pattern escape '\'
         or coalesce(r.search_account_name, '') ilike v_search_pattern escape '\'
         or coalesce(r.search_login_id, '') ilike v_search_pattern escape '\'
       )
  )
  select (select count(*)::integer from filtered),
         (
           select pg_catalog.jsonb_build_object(
             'total_all', count(*)::integer,
             'linked_count', count(*) filter (where u0.record_kind = 'LINKED_PERSON_ACCOUNT')::integer,
             'person_only_count', count(*) filter (where u0.record_kind = 'PERSON_ONLY')::integer,
             'unlinked_account_count', count(*) filter (where u0.record_kind = 'UNLINKED_ACCOUNT')::integer,
             'conflict_count', count(*) filter (where u0.link_conflict)::integer
           )
             from unified u0
         ),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      paged.entry_json
                      order by pg_catalog.lower(paged.sort_name) asc,
                               pg_catalog.lower(coalesce(paged.sort_secondary, '')) asc,
                               paged.directory_entry_key asc
                    )
               from (
                 select f.entry_json,
                        f.sort_name,
                        f.sort_secondary,
                        f.directory_entry_key
                   from filtered f
                  order by pg_catalog.lower(f.sort_name) asc,
                           pg_catalog.lower(coalesce(f.sort_secondary, '')) asc,
                           f.directory_entry_key asc
                  limit p_page_size offset v_offset
               ) paged
           ),
           '[]'::jsonb
         )
    into v_total, v_summary, v_entries;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth_date::text,
    'as_of', public.org_department__internal_iso_utc(v_as_of),
    'search', v_search,
    'record_kind', p_record_kind,
    'person_status', p_person_status,
    'login_state', p_login_state,
    'department_id', p_department_id,
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'summary', coalesce(
      v_summary,
      pg_catalog.jsonb_build_object(
        'total_all', 0,
        'linked_count', 0,
        'person_only_count', 0,
        'unlinked_account_count', 0,
        'conflict_count', 0
      )
    ),
    'entries', coalesce(v_entries, '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.org_department_list_user_directory_admin(uuid, uuid, text, text, text, text, uuid, timestamp with time zone, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_list_user_directory_admin(uuid, uuid, text, text, text, text, uuid, timestamp with time zone, integer, integer)
  to service_role;

create or replace function public.org_department_get_user_directory_entry_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_person_id uuid default null,
  p_account_ref uuid default null,
  p_as_of timestamp with time zone default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_auth_date date := (v_as_of at time zone 'Asia/Ho_Chi_Minh')::date;
  v_resolved_person_id uuid := null;
  v_resolved_account_ref uuid := null;
  v_entry jsonb := null;
  v_dept_history jsonb := '[]'::jsonb;
  v_head_history jsonb := '[]'::jsonb;
  v_link_history jsonb := '[]'::jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if (p_person_id is null and p_account_ref is null)
     or (p_person_id is not null and p_account_ref is not null) then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;

  if p_person_id is not null then
    if not exists (
      select 1
        from public.organization_persons p
       where p.person_id = p_person_id
    ) then
      raise exception 'USER_DIRECTORY_ENTRY_NOT_FOUND' using errcode = 'P0002';
    end if;
  else
    if not exists (
      select 1
        from public.direct_entry_app_users u
       where u.app_user_id = p_account_ref
    ) then
      raise exception 'USER_DIRECTORY_ENTRY_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  with effective_links as (
    select l.link_id,
           l.app_user_id,
           l.person_id,
           l.started_at,
           l.source_kind,
           l.evidence_date,
           l.version
      from public.organization_account_person_links l
     where l.started_at <= v_as_of
       and (l.ended_at is null or v_as_of < l.ended_at)
       and (l.ended_at is null or l.ended_at > l.started_at)
  ),
  effective_recruiter_links as (
    select rl.app_user_id,
           rl.recruiter_id
      from public.direct_entry_app_user_recruiter_links rl
     where rl.verified = true
       and (
         (p_as_of is null and (rl.is_current = true or rl.suspended_by_account_disable = true))
         or (
           p_as_of is not null
           and rl.valid_from <= v_auth_date
           and (
             (rl.valid_to is not null and rl.valid_to > rl.valid_from and v_auth_date < rl.valid_to)
             or (rl.valid_to is null and (rl.is_current = true or rl.suspended_by_account_disable = true))
           )
         )
       )
  ),
  person_link_stats as (
    select el.person_id,
           count(*)::integer as link_count
      from effective_links el
     group by el.person_id
  ),
  account_link_stats as (
    select el.app_user_id,
           count(*)::integer as link_count
      from effective_links el
     group by el.app_user_id
  ),
  evaluated_links as (
    select el.link_id,
           el.app_user_id,
           el.person_id,
           el.started_at,
           el.source_kind,
           el.evidence_date,
           el.version,
           pls.link_count as person_link_count,
           als.link_count as account_link_count,
           (
             exists (
               select 1
                 from public.organization_persons p_r
                 join effective_recruiter_links rl
                   on rl.app_user_id = el.app_user_id
                where p_r.person_id = el.person_id
                  and p_r.recruiter_id is not null
                  and rl.recruiter_id <> p_r.recruiter_id
             )
             or exists (
               select 1
                 from effective_recruiter_links rl
                 join public.organization_persons p_other
                   on p_other.recruiter_id = rl.recruiter_id
                  and p_other.person_id <> el.person_id
                where rl.app_user_id = el.app_user_id
             )
             or exists (
               select 1
                 from public.organization_persons p_r
                 join effective_recruiter_links rl_other
                   on rl_other.recruiter_id = p_r.recruiter_id
                  and rl_other.app_user_id <> el.app_user_id
                where p_r.person_id = el.person_id
                  and p_r.recruiter_id is not null
             )
             or (
               select count(distinct rl_cnt.recruiter_id)
                 from effective_recruiter_links rl_cnt
                where rl_cnt.app_user_id = el.app_user_id
             ) > 1
           ) as has_recruiter_conflict
      from effective_links el
      join person_link_stats pls on pls.person_id = el.person_id
      join account_link_stats als on als.app_user_id = el.app_user_id
  ),
  classified_links as (
    select ev.*,
           (
             ev.person_link_count = 1
             and ev.account_link_count = 1
             and not ev.has_recruiter_conflict
             and exists (
               select 1
                 from public.organization_persons p_chk
                where p_chk.person_id = ev.person_id
             )
             and exists (
               select 1
                 from public.direct_entry_app_users u_chk
                where u_chk.app_user_id = ev.app_user_id
             )
           ) as is_clean_unique
      from evaluated_links ev
  ),
  clean_links as (
    select * from classified_links where is_clean_unique
  ),
  conflict_links as (
    select * from classified_links where not is_clean_unique
  ),
  person_conflicts as (
    select cl.person_id,
           count(*)::integer as conflict_link_count,
           max(cl.person_link_count)::integer as person_link_count,
           bool_or(cl.has_recruiter_conflict) as has_recruiter_conflict,
           pg_catalog.jsonb_agg(cl.link_id order by cl.link_id asc) as link_ids,
           (
             select pg_catalog.jsonb_agg(distinct_pid order by distinct_pid asc)
               from (
                 select distinct cl2.person_id as distinct_pid
                   from conflict_links cl2
                  where cl2.person_id = cl.person_id
               ) pid_rows
           ) as related_person_ids,
           (
             select pg_catalog.jsonb_agg(distinct_uid order by distinct_uid asc)
               from (
                 select distinct cl2.app_user_id as distinct_uid
                   from conflict_links cl2
                  where cl2.person_id = cl.person_id
               ) uid_rows
           ) as related_account_refs
      from conflict_links cl
     group by cl.person_id
  ),
  account_conflicts as (
    select cl.app_user_id,
           count(*)::integer as conflict_link_count,
           max(cl.account_link_count)::integer as account_link_count,
           bool_or(cl.has_recruiter_conflict) as has_recruiter_conflict,
           pg_catalog.jsonb_agg(cl.link_id order by cl.link_id asc) as link_ids,
           (
             select pg_catalog.jsonb_agg(distinct_pid order by distinct_pid asc)
               from (
                 select distinct cl2.person_id as distinct_pid
                   from conflict_links cl2
                  where cl2.app_user_id = cl.app_user_id
               ) pid_rows
           ) as related_person_ids,
           (
             select pg_catalog.jsonb_agg(distinct_uid order by distinct_uid asc)
               from (
                 select distinct cl2.app_user_id as distinct_uid
                   from conflict_links cl2
                  where cl2.app_user_id = cl.app_user_id
               ) uid_rows
           ) as related_account_refs
      from conflict_links cl
     group by cl.app_user_id
  ),
  target_person as (
    select coalesce(
             p_person_id,
             (select cl.person_id from clean_links cl where cl.app_user_id = p_account_ref)
           ) as person_id
  ),
  resolved_row as (
    select p.person_id as resolved_person_id,
           u.app_user_id as resolved_account_ref,
           pg_catalog.jsonb_build_object(
             'directory_entry_key', 'person:' || p.person_id::text,
             'record_kind',
               case
                 when pc.conflict_link_count is not null then 'PERSON_LINK_CONFLICT'
                 when cl.link_id is not null then 'LINKED_PERSON_ACCOUNT'
                 else 'PERSON_ONLY'
               end,
             'display_name', p.full_name,
             'login_state',
               case
                 when u.app_user_id is null then 'NO_ACCOUNT'
                 when u.enabled then 'ENABLED'
                 else 'DISABLED'
               end,
             'person_id', p.person_id,
             'account_ref', u.app_user_id,
             'active_link_id', cl.link_id,
             'link_conflict', (pc.conflict_link_count is not null),
             'identity_mutation_blocked', (pc.conflict_link_count is not null),
             'conflict_details',
               case
                 when pc.conflict_link_count is null then null
                 else pg_catalog.jsonb_build_object(
                   'reason',
                     case
                       when pc.person_link_count > 1 then 'MULTIPLE_ACTIVE_LINKS_FOR_PERSON'
                       when pc.has_recruiter_conflict then 'RECRUITER_IDENTITY_CONFLICT'
                       else 'ENDPOINT_LINK_CONFLICT'
                     end,
                   'link_ids', pc.link_ids,
                   'related_person_ids', pc.related_person_ids,
                   'related_account_refs', pc.related_account_refs
                 )
               end,
             'person', pg_catalog.jsonb_build_object(
               'person_id', p.person_id,
               'employee_code', p.employee_code,
               'full_name', p.full_name,
               'status', p.status,
               'joined_on', case when p.joined_on is null then null else p.joined_on::text end,
               'recruiter_id', p.recruiter_id,
               'version', p.version,
               'active_department', dept.department_json
             ),
             'account',
               case
                 when u.app_user_id is null then null
                 else pg_catalog.jsonb_build_object(
                   'account_ref', u.app_user_id,
                   'login_id', pg_catalog.lower(
                     nullif(
                       pg_catalog.btrim(
                         pg_catalog.split_part(
                           coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
                           pg_catalog.chr(64),
                           1
                         )
                       ),
                       ''
                     )
                   ),
                   'display_name', u.display_name,
                   'enabled', u.enabled,
                   'version', u.version,
                   'auth_user_present', (au.id is not null)
                 )
               end,
             'active_link',
               case
                 when cl.link_id is null then null
                 else pg_catalog.jsonb_build_object(
                   'link_id', cl.link_id,
                   'started_at', public.org_department__internal_iso_utc(cl.started_at),
                   'source_kind', cl.source_kind,
                   'evidence_date', case when cl.evidence_date is null then null else cl.evidence_date::text end,
                   'version', cl.version
                 )
               end
           ) as entry_json
      from target_person tp
      join public.organization_persons p on p.person_id = tp.person_id
      left join clean_links cl on cl.person_id = p.person_id
      left join public.direct_entry_app_users u on u.app_user_id = cl.app_user_id
      left join auth.users au on au.id = u.auth_subject
      left join person_conflicts pc on pc.person_id = p.person_id
      left join lateral (
        select pg_catalog.jsonb_build_object(
                 'membership_id', m.membership_id,
                 'department_id', d.department_id,
                 'system_key', d.system_key,
                 'code', d.code,
                 'name', d.name,
                 'started_at', public.org_department__internal_iso_utc(m.started_at),
                 'source_kind', m.source_kind,
                 'evidence_date', case when m.evidence_date is null then null else m.evidence_date::text end,
                 'version', m.version
               ) as department_json
          from public.organization_person_department_memberships m
          join public.organization_departments d on d.department_id = m.department_id
         where m.person_id = p.person_id
           and m.started_at <= v_as_of
           and (m.ended_at is null or v_as_of < m.ended_at)
           and (m.ended_at is null or m.ended_at > m.started_at)
         order by m.started_at desc, m.membership_id desc
         limit 1
      ) dept on true
    union all
    select null::uuid as resolved_person_id,
           u.app_user_id as resolved_account_ref,
           pg_catalog.jsonb_build_object(
             'directory_entry_key', 'account:' || u.app_user_id::text,
             'record_kind',
               case
                 when ac.conflict_link_count is not null then 'ACCOUNT_LINK_CONFLICT'
                 else 'UNLINKED_ACCOUNT'
               end,
             'display_name',
               coalesce(
                 nullif(pg_catalog.btrim(coalesce(u.display_name, '')), ''),
                 pg_catalog.lower(
                   nullif(
                     pg_catalog.btrim(
                       pg_catalog.split_part(
                         coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
                         pg_catalog.chr(64),
                         1
                       )
                     ),
                     ''
                   )
                 ),
                 u.app_user_id::text
               ),
             'login_state',
               case
                 when u.enabled then 'ENABLED'
                 else 'DISABLED'
               end,
             'person_id', null,
             'account_ref', u.app_user_id,
             'active_link_id', null,
             'link_conflict', (ac.conflict_link_count is not null),
             'identity_mutation_blocked', (ac.conflict_link_count is not null),
             'conflict_details',
               case
                 when ac.conflict_link_count is null then null
                 else pg_catalog.jsonb_build_object(
                   'reason',
                     case
                       when ac.account_link_count > 1 then 'MULTIPLE_ACTIVE_LINKS_FOR_ACCOUNT'
                       when ac.has_recruiter_conflict then 'RECRUITER_IDENTITY_CONFLICT'
                       else 'ENDPOINT_LINK_CONFLICT'
                     end,
                   'link_ids', ac.link_ids,
                   'related_person_ids', ac.related_person_ids,
                   'related_account_refs', ac.related_account_refs
                 )
               end,
             'person', null,
             'account', pg_catalog.jsonb_build_object(
               'account_ref', u.app_user_id,
               'login_id', pg_catalog.lower(
                 nullif(
                   pg_catalog.btrim(
                     pg_catalog.split_part(
                       coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
                       pg_catalog.chr(64),
                       1
                     )
                   ),
                   ''
                 )
               ),
               'display_name', u.display_name,
               'enabled', u.enabled,
               'version', u.version,
               'auth_user_present', (au.id is not null)
             ),
             'active_link', null
           ) as entry_json
      from target_person tp
      join public.direct_entry_app_users u on tp.person_id is null and u.app_user_id = p_account_ref
      left join auth.users au on au.id = u.auth_subject
      left join account_conflicts ac on ac.app_user_id = u.app_user_id
  )
  select rr.resolved_person_id,
         rr.resolved_account_ref,
         rr.entry_json
    into v_resolved_person_id, v_resolved_account_ref, v_entry
    from resolved_row rr;

  if v_entry is null then
    raise exception 'USER_DIRECTORY_ENTRY_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_resolved_person_id is not null then
    select coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'membership_id', m.membership_id,
                 'department_id', d.department_id,
                 'system_key', d.system_key,
                 'code', d.code,
                 'name', d.name,
                 'started_at', public.org_department__internal_iso_utc(m.started_at),
                 'ended_at', public.org_department__internal_iso_utc(m.ended_at),
                 'source_kind', m.source_kind,
                 'evidence_date', case when m.evidence_date is null then null else m.evidence_date::text end,
                 'version', m.version
               )
               order by m.started_at desc, m.membership_id desc
             ),
             '[]'::jsonb
           )
      into v_dept_history
      from public.organization_person_department_memberships m
      join public.organization_departments d on d.department_id = m.department_id
     where m.person_id = v_resolved_person_id;

    select coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'head_assignment_id', h.head_assignment_id,
                 'department_id', d.department_id,
                 'system_key', d.system_key,
                 'code', d.code,
                 'name', d.name,
                 'started_at', public.org_department__internal_iso_utc(h.started_at),
                 'ended_at', public.org_department__internal_iso_utc(h.ended_at),
                 'source_kind', h.source_kind,
                 'evidence_date', case when h.evidence_date is null then null else h.evidence_date::text end,
                 'version', h.version
               )
               order by h.started_at desc, h.head_assignment_id desc
             ),
             '[]'::jsonb
           )
      into v_head_history
      from public.organization_department_heads h
      join public.organization_departments d on d.department_id = h.department_id
     where h.person_id = v_resolved_person_id;
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'link_id', l.link_id,
               'person_id', l.person_id,
               'account_ref', l.app_user_id,
               'started_at', public.org_department__internal_iso_utc(l.started_at),
               'ended_at', public.org_department__internal_iso_utc(l.ended_at),
               'source_kind', l.source_kind,
               'evidence_date', case when l.evidence_date is null then null else l.evidence_date::text end,
               'version', l.version
             )
             order by l.started_at desc, l.link_id desc
           ),
           '[]'::jsonb
         )
    into v_link_history
    from public.organization_account_person_links l
   where (v_resolved_person_id is not null and l.person_id = v_resolved_person_id)
      or (v_resolved_account_ref is not null and l.app_user_id = v_resolved_account_ref);

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth_date::text,
    'as_of', public.org_department__internal_iso_utc(v_as_of),
    'entry', v_entry || pg_catalog.jsonb_build_object(
      'department_history', coalesce(v_dept_history, '[]'::jsonb),
      'head_assignments', coalesce(v_head_history, '[]'::jsonb),
      'link_history', coalesce(v_link_history, '[]'::jsonb)
    )
  );
end;
$function$;

revoke all on function public.org_department_get_user_directory_entry_admin(uuid, uuid, uuid, uuid, timestamp with time zone)
  from public, anon, authenticated, service_role;
grant execute on function public.org_department_get_user_directory_entry_admin(uuid, uuid, uuid, uuid, timestamp with time zone)
  to service_role;

commit;
