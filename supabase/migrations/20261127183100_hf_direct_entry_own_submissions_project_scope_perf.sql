-- Resolve each potentially assigned PM project once in the same statement snapshot
-- used to select and count submissions. Keep the canonical effective-assignment
-- check and share the resulting scope across both reads.

create or replace function public.direct_entry_list_own_submissions(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page_size integer,
  p_cursor text,
  p_state text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_page_size integer;
  v_cursor_stamp text;
  v_cursor_id uuid;
  v_can_list_own boolean := false;
  v_has_project_assignment boolean := false;
  v_scanned integer;
  v_items jsonb;
  v_next_cursor text;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not coalesce(v_authz_managed, false) then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  v_can_list_own :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null);

  v_has_project_assignment := public.direct_entry_actor_has_project_assignment(p_app_user_id);
  if not v_can_list_own and not v_has_project_assignment then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  v_page_size := coalesce(p_page_size, 20);
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_state is not null and p_state not in
       ('DRAFT', 'REVIEW', 'SUBMITTED', 'ACTIVE', 'HISTORY') then
    raise exception 'invalid submission state filter' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with assigned_project_candidates as materialized (
    select distinct a.project_id
      from public.direct_entry_project_manager_assignments a
      join public.direct_entry_app_user_recruiter_links l
        on l.recruiter_id = a.manager_recruiter_id
       and l.app_user_id = p_app_user_id
       and l.verified
       and l.is_current
       and not l.suspended_by_account_disable
     where v_has_project_assignment
       and a.is_current
       and a.revoked_at is null
  ),
  effective_projects as materialized (
    select p.project_id
      from assigned_project_candidates p
     where public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p.project_id)
  ),
  candidates as (
    select s.submission_id,
           s.state,
           s.version,
           s.created_at,
           s.updated_at,
           s.submitted_at,
           not (v_can_list_own and s.created_by_user_id = p_app_user_id) as project_scoped
      from public.direct_entry_submissions s
     where s.state <> 'DELETED' and (
             (v_can_list_own and s.created_by_user_id = p_app_user_id)
             or (
               s.state = 'SUBMITTED'
               and v_has_project_assignment
               and exists (
                 select 1 from public.direct_entries e
                  where e.submission_id = s.submission_id
                    and e.deleted_at is null
                    and exists (
                      select 1 from effective_projects p where p.project_id = e.project_id
                    )
               )
             )
           )
       and (p_state is null
         or (p_state = 'ACTIVE' and s.state in ('DRAFT', 'REVIEW'))
         or (p_state = 'HISTORY' and s.state = 'SUBMITTED')
         or s.state = p_state)
       and (
         v_cursor_stamp is null
         or (
              pg_catalog.to_char(s.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
              s.submission_id::text
            ) < (v_cursor_stamp, v_cursor_id::text)
       )
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
             || ':' || c.submission_id::text as cursor
      from candidates c
     order by c.created_at desc, c.submission_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by created_at desc, submission_id desc limit v_page_size
  )
  select
    (select count(*)::integer from page),
    (
      select coalesce(jsonb_agg(jsonb_build_object(
               'submission_id', t.submission_id,
               'state', t.state,
               'version', t.version,
               'entry_count', (
                 select count(*)::integer from public.direct_entries e
                  where e.submission_id = t.submission_id and e.deleted_at is null
                     and (not t.project_scoped or exists (
                       select 1 from effective_projects p where p.project_id = e.project_id
                     ))
               ),
               'project_scoped', t.project_scoped,
               'created_at',
                 pg_catalog.to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.created_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z',
               'updated_at',
                 pg_catalog.to_char(t.updated_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.updated_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z',
               'submitted_at', case when t.submitted_at is null then null else
                 pg_catalog.to_char(t.submitted_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.submitted_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z' end,
               'allowed_transitions', case t.state
                 when 'DRAFT' then jsonb_build_array('SUBMITTED')
                 when 'REVIEW' then jsonb_build_array('DRAFT', 'SUBMITTED')
                 else jsonb_build_array()
               end
             ) order by t.created_at desc, t.submission_id desc), '[]'::jsonb)
        from trimmed t
    ),
    (
      select t.cursor from trimmed t
       order by t.created_at asc, t.submission_id asc limit 1
    )
  into v_scanned, v_items, v_next_cursor;

  v_has_more := v_scanned > v_page_size;
  return jsonb_build_object(
    'items', v_items,
    'page_size', v_page_size,
    'has_more', v_has_more,
    'next_cursor', case when v_has_more then v_next_cursor else null end
  );
end;
$function$;
