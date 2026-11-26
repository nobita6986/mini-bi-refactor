-- HF Worker Edit History: literal case-insensitive substring match for employee_code filter.
begin;

create or replace function public.worker_edit_history_search(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_national_id text default null,
  p_full_name text default null,
  p_from_date date default null,
  p_to_date date default null,
  p_project_query text default null,
  p_recruiter_query text default null,
  p_action_group text default null,
  p_page_size integer default 50,
  p_cursor text default null,
  p_employee_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_project_id text := nullif(pg_catalog.btrim(p_project_query), '');
  v_recruiter_text text := nullif(pg_catalog.btrim(p_recruiter_query), '');
  v_recruiter_id uuid;
  v_employee_code text := nullif(pg_catalog.btrim(p_employee_code), '');
  v_action_group text := nullif(pg_catalog.btrim(p_action_group), '');
  v_from_date date := p_from_date;
  v_to_date date := p_to_date;
  v_page_size integer := coalesce(p_page_size, 50);
  v_cursor_at timestamptz;
  v_cursor_id uuid;
  v_rows jsonb := '[]'::jsonb;
  v_next_cursor text := null;
  v_has_more boolean := false;
begin
  perform public.worker_edit_history_assert_actor(p_auth_subject, p_app_user_id);

  if p_national_id is not null or p_full_name is not null then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_employee_code is not null and (
    pg_catalog.char_length(v_employee_code) > 64
    or v_employee_code ~ E'[\\x00-\\x1F\\x7F\\s]'
  ) then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_project_id is not null and v_project_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_recruiter_text is not null then
    begin
      v_recruiter_id := v_recruiter_text::uuid;
    exception when others then
      raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
    end;
  end if;

  if v_action_group is not null and v_action_group not in (
    'NEW_ENTRY',
    'DUPLICATE_WITHDRAWN',
    'PROFILE_EDIT',
    'STATUS_CHANGE',
    'DOCUMENT_CHANGE'
  ) then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_from_date is null or v_to_date is null
     or v_to_date < v_from_date
     or (v_to_date - v_from_date) > 92 then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_page_size not between 1 and 100 then
    raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
  end if;

  if p_cursor is not null and pg_catalog.btrim(p_cursor) <> '' then
    if pg_catalog.strpos(p_cursor, '|') <= 1 then
      raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
    end if;
    begin
      v_cursor_at := pg_catalog.split_part(p_cursor, '|', 1)::timestamptz;
      v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;
    exception when others then
      raise exception 'WORKER_EDIT_HISTORY_QUERY_INVALID' using errcode = '22023';
    end;
  end if;

  with revision_rows as (
    select r.revision_id,
           r.entry_id,
           r.version,
           r.created_at,
           r.actor_user_id,
           coalesce(au.display_name, r.actor_user_id::text, 'Hệ thống') as actor_display_name,
           rr.reason_text,
           e.employee_code,
           coalesce(
             nullif(pg_catalog.btrim(s.after_snapshot->'worker_details'->>'display_name'), ''),
             nullif(pg_catalog.btrim(e.worker_details->>'display_name'), ''),
             '(Chưa có họ tên)'
           ) as display_name,
           coalesce(
             nullif(s.after_snapshot->'worker_details'->'national_id'->>'value', ''),
             case
               when e.worker_details->'national_id'->>'state' = 'provided'
                 then e.worker_details->'national_id'->>'value'
               else null
             end
           ) as national_id,
           e.project_id,
           coalesce(pr.display_name, e.project_id) as project_name,
           e.recruiter_id,
           coalesce(nullif(pg_catalog.btrim(rc.display_name), ''), 'Không tìm thấy tên người tuyển') as recruiter_name,
           e.first_work_date,
           e.provider_type,
           e.labor_type,
           e.voided_at,
           case when s.revision_id is not null then 'COMPLETE' else 'LEGACY_LIMITED' end as snapshot_state,
           coalesce(audit_meta.actions, array[]::text[]) as audit_actions,
           coalesce(audit_meta.changed_fields, array[]::text[]) as changed_fields,
           case
             when coalesce(audit_meta.actions, array[]::text[]) && array[
               'duplicate_cccd_self_service_withdraw',
               'entry_void_apply',
               'entry_void_request'
             ]::text[]
               or coalesce(audit_meta.changed_fields, array[]::text[]) && array['ENTRY_VOID', 'voided_at']::text[]
               or (
                 s.after_snapshot->>'voided_at' is not null
                 and (s.before_snapshot is null or s.before_snapshot->>'voided_at' is null)
               )
               then 'DUPLICATE_WITHDRAWN'
             when coalesce(audit_meta.actions, array[]::text[]) && array[
               'document_direct_reserve',
               'document_direct_finalize',
               'document_reserve',
               'portrait_stage_attach'
             ]::text[]
               or coalesce(audit_meta.changed_fields, array[]::text[]) && array[
                 'document_metadata',
                 'document_lifecycle',
                 'documents'
               ]::text[]
               then 'DOCUMENT_CHANGE'
             when coalesce(audit_meta.actions, array[]::text[]) && array[
               'employment_status_apply',
               'employment_status_request',
               'employment_status_review'
             ]::text[]
               or (
                 coalesce(audit_meta.changed_fields, array[]::text[]) @> array['employment_status']::text[]
                 and pg_catalog.cardinality(coalesce(audit_meta.changed_fields, array[]::text[])) = 1
               )
               then 'STATUS_CHANGE'
             when r.version = 1 and r.before_snapshot is null
               then 'NEW_ENTRY'
             else 'PROFILE_EDIT'
           end as action_group
      from public.direct_entry_revisions r
      join public.direct_entries e on e.entry_id = r.entry_id
      left join public.direct_entry_worker_revision_snapshots s on s.revision_id = r.revision_id
      left join public.direct_entry_app_users au on au.app_user_id = r.actor_user_id
      left join public.direct_entry_restricted_reasons rr on rr.reason_id = r.reason_id
      left join public.direct_entry_projects pr on pr.project_id = e.project_id
      left join public.recruiters rc on rc.recruiter_id = e.recruiter_id
      left join lateral (
        select array_agg(distinct ae.action order by ae.action) as actions,
               array_agg(distinct cf.field_name order by cf.field_name)
                 filter (where cf.field_name is not null) as changed_fields
          from public.direct_entry_audit_events ae
          left join lateral unnest(ae.changed_fields) as cf(field_name) on true
         where ae.revision_id = r.revision_id
      ) audit_meta on true
     where (
       v_from_date is null
       or (
         r.created_at >= (v_from_date::timestamp at time zone 'Asia/Ho_Chi_Minh')
         and r.created_at < ((v_to_date + 1)::timestamp at time zone 'Asia/Ho_Chi_Minh')
       )
     )
       and (v_project_id is null or e.project_id = v_project_id)
       and (v_recruiter_id is null or e.recruiter_id = v_recruiter_id)
       and (
         v_employee_code is null
         or pg_catalog.strpos(pg_catalog.lower(e.employee_code), pg_catalog.lower(v_employee_code)) > 0
       )
       and (
         v_cursor_at is null
         or (r.created_at, r.revision_id) < (v_cursor_at, v_cursor_id)
       )
  ),
  filtered as (
    select *
      from revision_rows
     where v_action_group is null or action_group = v_action_group
     order by created_at desc, revision_id desc
     limit v_page_size + 1
  ),
  page_rows as (
    select *
      from filtered
     order by created_at desc, revision_id desc
     limit v_page_size
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'revision_id', p.revision_id,
               'entry_id', p.entry_id,
               'version', p.version,
               'created_at', p.created_at,
               'actor_user_id', p.actor_user_id,
               'actor_display_name', p.actor_display_name,
               'reason_text', p.reason_text,
               'employee_code', p.employee_code,
               'display_name', p.display_name,
               'national_id', p.national_id,
               'project_id', p.project_id,
               'project_name', p.project_name,
               'recruiter_id', p.recruiter_id,
               'recruiter_name', p.recruiter_name,
               'first_work_date', p.first_work_date,
               'provider_type', p.provider_type,
               'labor_type', p.labor_type,
               'voided_at', p.voided_at,
               'action_group', p.action_group,
               'snapshot_state', p.snapshot_state,
               'audit_actions', to_jsonb(p.audit_actions),
               'changed_fields', to_jsonb(p.changed_fields)
             )
             order by p.created_at desc, p.revision_id desc
           ),
           '[]'::jsonb
         ),
         (select count(*) > v_page_size from filtered),
         (
           select case
             when (select count(*) > v_page_size from filtered) then
               (
                 select pg_catalog.to_char(
                          last_row.created_at at time zone 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                        ) || '|' || last_row.revision_id::text
                   from page_rows last_row
                  order by last_row.created_at asc, last_row.revision_id asc
                  limit 1
               )
             else null
           end
         )
    into v_rows, v_has_more, v_next_cursor
    from page_rows p;

  return jsonb_build_object(
    'rows', v_rows,
    'has_more', v_has_more,
    'next_cursor', v_next_cursor,
    'applied_window', case
      when v_from_date is null then null
      else jsonb_build_object('from_date', v_from_date, 'to_date', v_to_date)
    end
  );
end;
$function$;

revoke all on function public.worker_edit_history_search(
  uuid, uuid, text, text, date, date, text, text, text, integer, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.worker_edit_history_search(
  uuid, uuid, text, text, date, date, text, text, text, integer, text, text
) to service_role;

do $assert_hf_worker_edit_history_employee_code_substring$
declare
  v_base_owner_oid oid;
  v_base_owner text;
  v_proc_owner_oid oid;
  v_search_sig text := 'public.worker_edit_history_search(uuid, uuid, text, text, date, date, text, text, text, integer, text, text)';
  v_oid oid;
  v_overload_cnt integer;
  v_secdef boolean;
  v_proconfig text[];
  v_owner_priv boolean;
  v_owner_exec boolean;
  v_service_exec boolean;
  v_exposed integer;
  v_def text;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner_oid is null or v_base_owner is null then
    raise exception 'HF worker edit history substring check failed: base owner missing' using errcode = '55000';
  end if;

  if pg_catalog.to_regprocedure('public.worker_edit_history_search(uuid,uuid,text,text,date,date,text,text,text,integer,text)') is not null then
    raise exception 'HF worker edit history substring check failed: retired 11-arg worker_edit_history_search exists'
      using errcode = '55000';
  end if;

  select pg_catalog.count(*)::integer
    into v_overload_cnt
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'worker_edit_history_search';

  if v_overload_cnt <> 1 then
    raise exception 'HF worker edit history substring check failed: expected single overload for worker_edit_history_search, found %',
      v_overload_cnt using errcode = '55000';
  end if;

  v_oid := pg_catalog.to_regprocedure(v_search_sig);
  if v_oid is null then
    raise exception 'HF worker edit history substring check failed: missing routine %', v_search_sig using errcode = '55000';
  end if;

  select p.proowner into v_proc_owner_oid from pg_catalog.pg_proc p where p.oid = v_oid;
  if pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    if v_proc_owner_oid is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_search_sig, v_base_owner);
      select p.proowner into v_proc_owner_oid from pg_catalog.pg_proc p where p.oid = v_oid;
    end if;
    if v_proc_owner_oid is distinct from v_base_owner_oid then
      raise exception 'HF worker edit history substring check failed: owner mismatch on %', v_search_sig
        using errcode = '55000';
    end if;
  end if;

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
     or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
    raise exception 'HF worker edit history substring check failed: definer/owner/search_path invalid on %', v_search_sig
      using errcode = '55000';
  end if;

  if not coalesce(v_service_exec, false) then
    raise exception 'HF worker edit history substring check failed: service_role missing EXECUTE on %', v_search_sig
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
    raise exception 'HF worker edit history substring check failed: RPC ACL exposed on %', v_search_sig
      using errcode = '55000';
  end if;

  select pg_catalog.pg_get_functiondef(v_oid) into v_def;
  if pg_catalog.strpos(v_def, 'pg_catalog.strpos(pg_catalog.lower(e.employee_code), pg_catalog.lower(v_employee_code)) > 0') = 0
     or pg_catalog.strpos(v_def, 'matched_entries') > 0
     or pg_catalog.strpos(v_def, 'e.project_id = v_project_id') = 0
     or pg_catalog.strpos(v_def, 'e.recruiter_id = v_recruiter_id') = 0 then
    raise exception 'HF worker edit history substring check failed: search definition drift' using errcode = '55000';
  end if;
end;
$assert_hf_worker_edit_history_employee_code_substring$;

commit;
