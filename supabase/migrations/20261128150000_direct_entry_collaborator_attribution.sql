-- =============================================================================
-- Migration #261: Direct Entry Collaborator (CTV) Attribution (Branch B)
-- Assumes Branch A (20261128140000_collaborators_catalog.sql) created public.collaborators.
-- =============================================================================
begin;

-- ---------------------------------------------------------------------------
-- 1. Schema: direct_entries.collaborator_id + consistency check + index
-- ---------------------------------------------------------------------------
alter table public.direct_entries
  add column collaborator_id text null
    references public.collaborators(collaborator_id) on delete restrict;

alter table public.direct_entries
  add constraint direct_entries_collaborator_id_consistency_check
    check ((provider_type = 'hrp') or (collaborator_id is null));

create index direct_entries_collaborator_reporting_idx
  on public.direct_entries (collaborator_id, first_work_date)
  where deleted_at is null and voided_at is null and collaborator_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Collaborator Resolution Helper
-- ---------------------------------------------------------------------------
create or replace function public.direct_entry_resolve_entry_collaborator_id(
  p_raw text,
  p_provider_type text,
  p_require_active boolean default true
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_id text;
begin
  v_id := nullif(pg_catalog.btrim(p_raw), '');
  if v_id is null then
    return null::text;
  end if;
  if p_provider_type is distinct from 'hrp' then
    raise exception 'provider collaborator_id invalid' using errcode = '23514';
  end if;
  if coalesce(p_require_active, true) then
    if not exists (
      select 1
        from public.collaborators c
       where c.collaborator_id = v_id
         and c.active
    ) then
      raise exception 'collaborator is not active' using errcode = '23514';
    end if;
  else
    if not exists (
      select 1
        from public.collaborators c
       where c.collaborator_id = v_id
    ) then
      raise exception 'collaborator is not active' using errcode = '23514';
    end if;
  end if;
  return v_id;
end;
$function$;

revoke all on function public.direct_entry_resolve_entry_collaborator_id(text, text, boolean)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Snapshots & Entry Validation Trigger / Guard
-- ---------------------------------------------------------------------------
create or replace function public.direct_entry_entry_snapshot(p_entry_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select jsonb_build_object(
    'entry_id', e.entry_id,
    'submission_id', e.submission_id,
    'candidate_id', e.candidate_id,
    'worker_portrait', (
      select jsonb_build_object(
        'origin', c.worker_portrait_origin,
        'added_at', c.worker_portrait_added_at,
        'current', case when d.document_id is null then null else jsonb_build_object(
          'document_id', d.document_id, 'version', d.version,
          'checksum_sha256', d.checksum_sha256, 'mime_type', d.mime_type,
          'size_bytes', d.size_bytes
        ) end
      )
        from public.direct_entry_candidates c
        left join lateral (
          select cd.document_id, cd.version, cd.checksum_sha256, cd.mime_type, cd.size_bytes
            from public.direct_entry_current_documents cd
           where cd.candidate_id = c.candidate_id
             and cd.document_type = 'WORKER_PORTRAIT'
        ) d on true
       where c.candidate_id = e.candidate_id
    ),
    'created_by_user_id', e.created_by_user_id,
    'project_id', e.project_id,
    'first_work_date', e.first_work_date,
    'employee_code', e.employee_code,
    'worker_details', jsonb_build_object(
      'present', e.worker_details is not null and e.worker_details <> '{}'::jsonb
    ),
    'general_note', jsonb_build_object('present', e.general_note is not null),
    'recruiter_id', e.recruiter_id,
    'team_id', e.team_id,
    'provider_type', e.provider_type,
    'vendor_id', e.vendor_id,
    'collaborator_id', e.collaborator_id,
    'labor_type', e.labor_type,
    'version', e.version,
    'deleted_at', e.deleted_at,
    'voided_at', e.voided_at,
    'voided_by_user_id', e.voided_by_user_id,
    'void_reason_id', e.void_reason_id,
    'employment_status', (
      select jsonb_build_object(
        'status', st.status, 'effective_date', st.effective_date, 'version', st.version
      )
        from public.direct_entry_employment_status_events st
       where st.entry_id = e.entry_id
       order by st.version desc
       limit 1
    ),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'upload_status', latest.upload_status,
        'scan_status', latest.scan_status, 'validation_status', latest.validation_status,
        'updated_at', latest.created_at
      ) order by d.document_type, d.version)
        from public.direct_entry_document_versions d
        join lateral (
          select ev.upload_status, ev.scan_status, ev.validation_status, ev.created_at
            from public.direct_entry_document_events ev
           where ev.document_id = d.document_id
           order by ev.version desc
           limit 1
        ) latest on true
       where d.candidate_id = e.candidate_id
    ), '[]'::jsonb),
    'payment', case when p.entry_id is null then null else jsonb_build_object(
      'state', p.state, 'version', p.version
    ) end
  )
  from public.direct_entries e
  left join public.direct_entry_payments p on p.entry_id = e.entry_id
  where e.entry_id = p_entry_id
$function$;

revoke all on function public.direct_entry_entry_snapshot(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.worker_edit_history_snapshot(p_entry_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select case
    when e.entry_id is null then null
    else jsonb_build_object(
      'entry_id', e.entry_id,
      'submission_id', e.submission_id,
      'candidate_id', e.candidate_id,
      'created_by_user_id', e.created_by_user_id,
      'project_id', e.project_id,
      'project_name', coalesce(pr.display_name, e.project_id),
      'first_work_date', e.first_work_date,
      'employee_code', e.employee_code,
      'worker_details', e.worker_details,
      'general_note', e.general_note,
      'recruiter_id', e.recruiter_id,
      'recruiter_name', nullif(pg_catalog.btrim(rc.display_name), ''),
      'team_id', e.team_id,
      'team_name', nullif(pg_catalog.btrim(tm.display_name), ''),
      'provider_type', e.provider_type,
      'vendor_id', e.vendor_id,
      'vendor_name', nullif(pg_catalog.btrim(v.display_name), ''),
      'collaborator_id', e.collaborator_id,
      'collaborator_name', nullif(pg_catalog.btrim(c.display_name), ''),
      'labor_type', e.labor_type,
      'version', e.version,
      'deleted_at', e.deleted_at,
      'voided_at', e.voided_at,
      'voided_by_user_id', e.voided_by_user_id,
      'employment_status', (
        select jsonb_build_object(
          'event_id', st.event_id,
          'status', st.status,
          'effective_date', st.effective_date,
          'leave_date', st.leave_date,
          'leave_reason_text', st.leave_reason_text,
          'version', st.version,
          'actor_user_id', st.actor_user_id,
          'actor_display_name', coalesce(stu.display_name, st.actor_user_id::text),
          'created_at', st.applied_at
        )
          from public.direct_entry_employment_status_events st
          left join public.direct_entry_app_users stu on stu.app_user_id = st.actor_user_id
         where st.entry_id = e.entry_id
         order by st.version desc
         limit 1
      ),
      'payment', case
        when p.entry_id is null then null
        else jsonb_build_object(
          'state', p.state,
          'account_number', p.account_number,
          'bank_id', p.bank_id,
          'bank_name', coalesce(nullif(pg_catalog.btrim(p.bank_name), ''), b.display_name),
          'account_holder_name', p.account_holder_name,
          'version', p.version,
          'updated_at', p.updated_at
        )
      end,
      'documents', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'document_id', d.document_id,
            'document_type', d.document_type,
            'version', d.version,
            'size_bytes', d.size_bytes,
            'mime_type', d.mime_type,
            'upload_status', latest.upload_status,
            'scan_status', latest.scan_status,
            'validation_status', latest.validation_status,
            'created_by_user_id', d.created_by_user_id,
            'uploader_display_name', coalesce(du.display_name, d.created_by_user_id::text),
            'supersedes_document_id', d.supersedes_document_id,
            'created_at', d.created_at,
            'updated_at', latest.created_at
          )
          order by d.document_type, d.version
        )
          from public.direct_entry_document_versions d
          left join public.direct_entry_app_users du on du.app_user_id = d.created_by_user_id
          join lateral (
            select ev.upload_status, ev.scan_status, ev.validation_status, ev.created_at
              from public.direct_entry_document_events ev
             where ev.document_id = d.document_id
             order by ev.version desc
             limit 1
          ) latest on true
         where d.candidate_id = e.candidate_id
      ), '[]'::jsonb)
    )
  end
  from public.direct_entries e
  left join public.direct_entry_projects pr on pr.project_id = e.project_id
  left join public.recruiters rc on rc.recruiter_id = e.recruiter_id
  left join public.teams tm on tm.team_id = e.team_id
  left join public.vendors v on v.vendor_id = e.vendor_id
  left join public.collaborators c on c.collaborator_id = e.collaborator_id
  left join public.direct_entry_payments p on p.entry_id = e.entry_id
  left join public.direct_entry_banks b on b.bank_id = p.bank_id
 where e.entry_id = p_entry_id;
$function$;

revoke all on function public.worker_edit_history_snapshot(uuid)
  from public, anon, authenticated, service_role;

-- =============================================================================

create or replace function public.direct_entry_validate_new_entry()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  v_auth_date date := public.direct_entry_authorization_date();
  v_provider_count integer;
  v_provider_type text;
  v_membership_vendor_id text;
  v_team_count integer;
begin
  if new.collaborator_id is not null and new.provider_type is distinct from 'hrp' then
    raise exception 'provider collaborator_id invalid' using errcode = '23514';
  end if;

  if TG_OP = 'INSERT' or (new.collaborator_id is distinct from old.collaborator_id) then
    if new.collaborator_id is not null and not exists (
      select 1
        from public.collaborators c
       where c.collaborator_id = new.collaborator_id
         and c.active
    ) then
      raise exception 'collaborator is not active' using errcode = '23514';
    end if;
  end if;

  if (new.provider_type = 'hrp' and new.vendor_id is not null)
     or new.vendor_id = '__system_vendor__' then
    raise exception 'provider vendor_id invalid' using errcode = '23514';
  end if;

  if (tg_op = 'INSERT' or old.recruiter_id is distinct from new.recruiter_id)
     and not exists (
       select 1 from public.recruiters r
        where r.recruiter_id = new.recruiter_id and r.active
     ) then
    raise exception 'recruiter is not active' using errcode = '23514';
  end if;

  if (tg_op = 'INSERT' or old.team_id is distinct from new.team_id)
     and not exists (
       select 1 from public.teams t where t.team_id = new.team_id and t.active
     ) then
    raise exception 'team is not active' using errcode = '23514';
  end if;

  if (tg_op = 'INSERT' or old.project_id is distinct from new.project_id)
     and not exists (
       select 1 from public.direct_entry_projects p
        where p.project_id = new.project_id and p.active
     ) then
    raise exception 'project is not active' using errcode = '23514';
  end if;

  if tg_op = 'INSERT'
     or old.recruiter_id is distinct from new.recruiter_id
     or old.team_id is distinct from new.team_id
     or old.provider_type is distinct from new.provider_type then
    select count(*), min(m.provider_type), min(m.vendor_id)
      into v_provider_count, v_provider_type, v_membership_vendor_id
      from public.recruiter_provider_memberships m
     where m.recruiter_id = new.recruiter_id
       and m.valid_from <= v_auth_date
       and (m.valid_to is null or v_auth_date < m.valid_to)
       and (m.valid_to is null or m.valid_to > m.valid_from);
    if v_provider_count <> 1 or v_provider_type <> new.provider_type then
      raise exception 'provider membership missing, ambiguous, or mismatched' using errcode = '23514';
    end if;

    if new.provider_type = 'vendor' then
      if v_membership_vendor_id is null
         or v_membership_vendor_id = '__system_vendor__'
         or not exists (
           select 1 from public.vendors v
            where v.vendor_id = v_membership_vendor_id and v.active
         )
         or new.vendor_id is distinct from v_membership_vendor_id then
        raise exception 'provider vendor_id invalid' using errcode = '23514';
      end if;
    elsif new.vendor_id is not null then
      raise exception 'provider vendor_id invalid' using errcode = '23514';
    end if;

    if new.provider_type = 'vendor'
       and new.team_id = public.direct_entry_system_vendor_team_id() then
      null;
    else
      select count(*) into v_team_count
        from public.recruiter_team_memberships m
       where m.recruiter_id = new.recruiter_id
         and m.team_id = new.team_id
         and m.valid_from <= v_auth_date
         and (m.valid_to is null or v_auth_date < m.valid_to)
         and (m.valid_to is null or m.valid_to > m.valid_from);
      if v_team_count <> 1 then
        raise exception 'team membership missing or ambiguous' using errcode = '23514';
      end if;
    end if;
  elsif tg_op = 'UPDATE' and old.vendor_id is distinct from new.vendor_id then
    -- Allow ONLY one-time historical backfill when source fields stay unchanged
    if not (
      old.provider_type = 'vendor'
      and old.vendor_id is null
      and new.vendor_id is not null
      and new.vendor_id <> '__system_vendor__'
      and exists (
        select 1 from public.vendors v
         where v.vendor_id = new.vendor_id
      )
      and exists (
        select 1 from public.recruiter_provider_memberships rpm
         where rpm.recruiter_id = new.recruiter_id
           and rpm.provider_type = 'vendor'
           and rpm.vendor_id = new.vendor_id
      )
    ) then
      raise exception 'provider vendor_id invalid' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.direct_entry_validate_new_entry()
  from public, anon, authenticated, service_role;

drop trigger if exists direct_entry_validate_identity on public.direct_entries;
create trigger direct_entry_validate_identity
  before insert or update of project_id, first_work_date, recruiter_id, team_id, provider_type, vendor_id, collaborator_id
  on public.direct_entries
  for each row execute function public.direct_entry_validate_new_entry();


create or replace function public.direct_entry_entry_version_guard()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $function$
declare
  v_is_vendor_backfill boolean := false;
begin
  v_is_vendor_backfill :=
    old.provider_type = 'vendor'
    and old.vendor_id is null
    and new.vendor_id is not null
    and new.vendor_id <> '__system_vendor__'
    and new.version = old.version
    and new.entry_id is not distinct from old.entry_id
    and new.submission_id is not distinct from old.submission_id
    and new.candidate_id is not distinct from old.candidate_id
    and new.created_by_user_id is not distinct from old.created_by_user_id
    and new.project_id is not distinct from old.project_id
    and new.first_work_date is not distinct from old.first_work_date
    and new.employee_code is not distinct from old.employee_code
    and new.worker_details is not distinct from old.worker_details
    and new.recruiter_id is not distinct from old.recruiter_id
    and new.team_id is not distinct from old.team_id
    and new.provider_type is not distinct from old.provider_type
    and new.labor_type is not distinct from old.labor_type
    and new.created_at is not distinct from old.created_at
    and new.deleted_at is not distinct from old.deleted_at
    and new.general_note is not distinct from old.general_note
    and new.voided_at is not distinct from old.voided_at
    and new.voided_by_user_id is not distinct from old.voided_by_user_id
    and new.void_reason_id is not distinct from old.void_reason_id
    and new.collaborator_id is not distinct from old.collaborator_id;

  if v_is_vendor_backfill then
    new.updated_at := old.updated_at;
    return new;
  end if;

  if new.entry_id <> old.entry_id
     or new.submission_id <> old.submission_id
     or new.candidate_id <> old.candidate_id
     or new.created_by_user_id <> old.created_by_user_id
     or new.version <> old.version + 1 then
    raise exception 'invalid entry mutation or stale version' using errcode = '40001';
  end if;
  new.updated_at := now();
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Write RPCs (Batch, Draft, Full Profile, Change Request, Privileged Edit)
-- ---------------------------------------------------------------------------
create or replace function public.direct_entry_create_batch(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_rows jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_row jsonb;
  v_submission_id uuid := gen_random_uuid();
  v_candidate_id uuid;
  v_entry_id uuid;
  v_recruiter_id uuid;
  v_project_id text;
  v_first_work_date date;
  v_employee_code text;
  v_worker_details jsonb;
  v_labor_type text;
  v_provider_type text;
  v_team_id uuid;
  v_vendor_id text;
  v_collaborator_id text;
  v_scope text;
  v_count integer;
  v_reason_id uuid;
  v_submission_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_entry_ids jsonb := '[]'::jsonb;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 100 then
    raise exception 'invalid batch input' using errcode = '22023';
  end if;
  -- P2.5-HF: per-row project authority, before the idempotency record and the
  -- submission insert.
  select count(*)::int into v_count
    from jsonb_array_elements(p_rows) as e(value)
   where public.direct_entry_create_authority(
           p_auth_subject, p_app_user_id, e.value->>'project_id',
           case when coalesce(e.value->>'first_work_date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then (e.value->>'first_work_date')::date end
         ) <> 'manager';
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'batch_create', p_idempotency_key,
    public.direct_entry_payload_hash(p_rows)
  );
  if v_prior is not null then return v_prior; end if;
  insert into public.direct_entry_submissions (submission_id, created_by_user_id)
    values (v_submission_id, p_app_user_id);
  v_reason_id := null;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if (v_row - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type','collaborator_id'])
       <> '{}'::jsonb
       or ((v_row ? 'collaborator_id') and jsonb_typeof(v_row->'collaborator_id') not in ('string','null')) then
      raise exception 'unsupported batch field' using errcode = '22023';
    end if;
    v_project_id := v_row->>'project_id';
    v_first_work_date := (v_row->>'first_work_date')::date;
    v_employee_code := v_row->>'employee_code';
    v_worker_details := v_row->'worker_details';
    v_recruiter_id := (v_row->>'recruiter_id')::uuid;
    v_labor_type := v_row->>'labor_type';
    if public.direct_entry_contains_authority(v_worker_details) then
      raise exception 'client authority field forbidden' using errcode = '22023';
    end if;
    if v_project_id is null or v_first_work_date is null or v_employee_code is null
       or jsonb_typeof(v_worker_details) <> 'object'
       or v_recruiter_id is null or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
      raise exception 'incomplete batch row' using errcode = '22023';
    end if;
    select rs.provider_type, rs.team_id, rs.vendor_id
      into v_provider_type, v_team_id, v_vendor_id
      from public.direct_entry__internal_resolve_recruiter_source(
        v_recruiter_id, '42501', 'recruiter provider membership denied', 'recruiter team membership denied'
      ) rs;
    v_collaborator_id := public.direct_entry_resolve_entry_collaborator_id(
      case when jsonb_typeof(v_row->'collaborator_id') = 'string' then v_row->>'collaborator_id' else null end,
      v_provider_type,
      true
    );
    insert into public.direct_entry_candidates default values returning candidate_id into v_candidate_id;
    insert into public.direct_entries (
      submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
      employee_code, worker_details, recruiter_id, team_id, provider_type, vendor_id, collaborator_id, labor_type
    ) values (
      v_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
      v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type, v_vendor_id, v_collaborator_id, v_labor_type
    ) returning entry_id into v_entry_id;
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, version, actor_user_id, reason_id
    ) values (
      v_entry_id, 'ON', v_first_work_date, 1, p_app_user_id, v_reason_id
    );
    perform public.direct_entry_write_revision(
      v_entry_id, p_app_user_id, v_reason_id, null,
      public.direct_entry_entry_snapshot(v_entry_id), 1
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'entry_create', 'entry_create', v_entry_id::text,
      'own', 'APPLIED', v_reason_id, array['entry_created']
    );
    v_entry_ids := v_entry_ids || jsonb_build_array(v_entry_id);
  end loop;
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_submission_id, p_app_user_id, v_reason_id, null,
    jsonb_build_object('state','DRAFT','version',1,'entry_count',jsonb_array_length(p_rows)), 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'batch_create', 'entry_create',
    v_submission_id::text, 'own', 'APPLIED', v_reason_id,
    v_submission_revision_id, array['submission_created','entries_created']
  );
  v_result := jsonb_build_object(
    'submission_id', v_submission_id, 'state', 'DRAFT', 'version', 1, 'entry_ids', v_entry_ids
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'batch_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.direct_entry_create_batch(uuid, uuid, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_batch(uuid, uuid, jsonb, text)
  to service_role;

create or replace function public.direct_entry_create_draft_row(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid,
  p_expected_submission_version integer,
  p_row jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_submission public.direct_entry_submissions%rowtype;
  v_entry_id uuid;
  v_candidate_id uuid;
  v_recruiter_id uuid;
  v_new_recruiter_id uuid;
  v_new_work_date date;
  v_team_id uuid;
  v_provider_type text;
  v_vendor_id text;
  v_collaborator_id text;
  v_project_id text;
  v_first_work_date date;
  v_employee_code text;
  v_worker_details jsonb;
  v_labor_type text;
  v_count integer;
  v_scope text;
  v_reason_id uuid;
  v_submission_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_row) <> 'object'
     or (p_row - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type','collaborator_id'])
        <> '{}'::jsonb
     or ((p_row ? 'collaborator_id') and jsonb_typeof(p_row->'collaborator_id') not in ('string','null')) then
    raise exception 'invalid draft row input' using errcode = '22023';
  end if;
  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id;
  if not found or v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'draft submission scope denied' using errcode = '42501';
  end if;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_row_create', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'submission_id', p_submission_id, 'expected_version', p_expected_submission_version,
      'row', p_row
    ))
  );
  if v_prior is not null then return v_prior; end if;
  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id
   for update;
  if not found or v_submission.created_by_user_id <> p_app_user_id
     or v_submission.state <> 'DRAFT' then
    raise exception 'draft submission denied' using errcode = '42501';
  end if;
  if p_expected_submission_version is null or p_expected_submission_version <> v_submission.version then
    raise exception 'submission version conflict' using errcode = 'PT409';
  end if;
  v_project_id := p_row->>'project_id';
  v_first_work_date := (p_row->>'first_work_date')::date;
  v_employee_code := p_row->>'employee_code';
  v_worker_details := p_row->'worker_details';
  v_recruiter_id := (p_row->>'recruiter_id')::uuid;
  v_labor_type := p_row->>'labor_type';
  if public.direct_entry_contains_authority(v_worker_details) then
    raise exception 'client authority field forbidden' using errcode = '22023';
  end if;
  if v_project_id is null or v_first_work_date is null or v_employee_code is null
     or jsonb_typeof(v_worker_details) <> 'object'
     or v_recruiter_id is null or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
    raise exception 'incomplete draft row' using errcode = '22023';
  end if;
  perform public.direct_entry_create_authority(
    p_auth_subject, p_app_user_id, v_project_id, v_first_work_date
  );
  select rs.provider_type, rs.team_id, rs.vendor_id
    into v_provider_type, v_team_id, v_vendor_id
    from public.direct_entry__internal_resolve_recruiter_source(
      v_recruiter_id, '42501', 'recruiter provider membership denied', 'recruiter team membership denied'
    ) rs;
  v_collaborator_id := public.direct_entry_resolve_entry_collaborator_id(
    case when jsonb_typeof(p_row->'collaborator_id') = 'string' then p_row->>'collaborator_id' else null end,
    v_provider_type,
    true
  );
  insert into public.direct_entry_candidates default values returning candidate_id into v_candidate_id;
  insert into public.direct_entries (
    submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
    employee_code, worker_details, recruiter_id, team_id, provider_type, vendor_id, collaborator_id, labor_type
  ) values (
    p_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
    v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type, v_vendor_id, v_collaborator_id, v_labor_type
  ) returning entry_id into v_entry_id;
  update public.direct_entry_submissions
     set version = version + 1
   where submission_id = p_submission_id;
  v_reason_id := null;
  insert into public.direct_entry_employment_status_events (
    entry_id, status, effective_date, version, actor_user_id, reason_id
  ) values (
    v_entry_id, 'ON', v_first_work_date, 1, p_app_user_id, v_reason_id
  );
  perform public.direct_entry_write_revision(
    v_entry_id, p_app_user_id, v_reason_id, null,
    public.direct_entry_entry_snapshot(v_entry_id), 1
  );
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    p_submission_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state','DRAFT','version',v_submission.version,'entry_count',
      (select count(*) - 1 from public.direct_entries
        where submission_id=p_submission_id and deleted_at is null)),
    jsonb_build_object('state','DRAFT','version',v_submission.version + 1,'entry_count',
      (select count(*) from public.direct_entries where submission_id=p_submission_id)),
    v_submission.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, revision_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'draft_row_create', 'entry_create',
    v_entry_id::text, 'own', 'APPLIED', v_reason_id,
    (select revision_id from public.direct_entry_revisions where entry_id=v_entry_id and version=1),
    v_submission_revision_id, array['entry_created']
  );
  v_result := jsonb_build_object(
    'entry_id', v_entry_id, 'candidate_id', v_candidate_id,
    'submission_id', p_submission_id, 'version', 1,
    'submission_version', v_submission.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_row_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.direct_entry_create_draft_row(uuid, uuid, uuid, integer, jsonb, text)
  from public, anon, authenticated, service_role;


create or replace function public.direct_entry_create_full_profile_batch(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_contract_version text,
  p_rows jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_auth_date date := public.direct_entry_authorization_date();
  v_row jsonb;
  v_worker_input jsonb;
  v_worker_details jsonb;
  v_payment jsonb;
  v_employment jsonb;
  v_note jsonb;
  v_state text;
  v_project_id text;
  v_recruiter_id uuid;
  v_first_work_date date;
  v_employee_code text;
  v_labor_type text;
  v_display_name text;
  v_general_note text;
  v_payment_state text;
  v_account_number text;
  v_bank_id text;
  v_bank_name text;
  v_account_holder_name text;
  v_status text;
  v_leave_date date;
  v_leave_reason_text text;
  v_provider_type text;
  v_team_id uuid;
  v_vendor_id text;
  v_collaborator_id text;
  v_count integer;
  v_submission_id uuid := gen_random_uuid();
  v_candidate_id uuid;
  v_entry_id uuid;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_trim_chars text := E' \t\n\r' || chr(11) || chr(12) || chr(160) || chr(5760)
    || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197)
    || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202) || chr(8232)
    || chr(8233) || chr(8239) || chr(8287) || chr(12288) || chr(65279);
  v_entry_ids jsonb := '[]'::jsonb;
  v_codes text[] := '{}';
  v_national_ids text[] := '{}';
  v_national_id text;
  v_has_payment boolean := false;
  v_has_status boolean := false;
  v_prior jsonb;
  v_hash text;
  v_result jsonb;
begin
  if p_contract_version is null
     or p_contract_version not in ('worker-profile/1.0', 'worker-profile/1.2') then
    raise exception 'CONTRACT_VERSION_UNSUPPORTED' using errcode = '22023';
  end if;
  if p_idempotency_key is null
     or p_idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) not between 1 and 100 then
    raise exception 'BATCH_INVALID' using errcode = '22023';
  end if;
  for v_row in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(v_row) <> 'object'
       or v_row - array[
         'project_id','first_work_date','employee_code','recruiter_id','labor_type','collaborator_id',
         'display_name','worker_details','general_note','payment','employment'
       ] <> '{}'::jsonb
       or ((v_row ? 'collaborator_id') and jsonb_typeof(v_row->'collaborator_id') not in ('string','null')) then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    if v_row ? 'payment'
       and coalesce(v_row->'payment'->>'state', 'omitted') <> 'omitted'
       and not (
         v_row->'payment'->>'state' = 'provided'
         and nullif(btrim(v_row->'payment'->>'account_number', v_trim_chars), '') is null
         and nullif(btrim(v_row->'payment'->>'bank_name', v_trim_chars), '') is null
         and nullif(btrim(v_row->'payment'->>'account_holder_name', v_trim_chars), '') is null
         and nullif(btrim(v_row->'payment'->>'bank_id'), '') is null
       ) then
      v_has_payment := true;
    end if;
    if coalesce(v_row->'employment'->>'initial_status', '') = 'OFF' then
      v_has_status := true;
    end if;
  end loop;

  select count(*)::int into v_count
    from jsonb_array_elements(p_rows) as e(value)
   where public.direct_entry_create_authority(
           p_auth_subject, p_app_user_id, e.value->>'project_id',
           case when coalesce(e.value->>'first_work_date','') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
             then (e.value->>'first_work_date')::date end
         ) <> 'manager';

  if v_has_status and v_count > 0 then
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

    select coalesce(u.authz_managed, false)
      into v_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id;

    if not coalesce(v_authz_managed, false) or not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'employment_status.apply', 'ALL', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'employment_status.apply', 'OWN', null)
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  end if;

  v_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'contract_version', p_contract_version, 'rows', p_rows
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'full_profile_batch_create', p_idempotency_key, v_hash
  );
  if v_prior is not null then
    return v_prior || jsonb_build_object('replayed', true);
  end if;

  insert into public.direct_entry_submissions (submission_id, created_by_user_id)
    values (v_submission_id, p_app_user_id);
  v_reason_id := null;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    if v_row ? 'worker_details' and jsonb_typeof(v_row->'worker_details') <> 'object' then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_worker_input := coalesce(v_row->'worker_details', '{}'::jsonb);
    if v_worker_input - array[
      'gender','date_of_birth','national_id','national_id_issued_at',
      'national_id_issued_place','address','phone'
    ] <> '{}'::jsonb then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;

    v_project_id := v_row->>'project_id';
    v_recruiter_id := case
      when coalesce(v_row->>'recruiter_id','') ~*
        '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then (v_row->>'recruiter_id')::uuid else null end;
    v_employee_code := v_row->>'employee_code';
    v_labor_type := v_row->>'labor_type';
    v_display_name := v_row->>'display_name';
    begin
      if coalesce(v_row->>'first_work_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'invalid date';
      end if;
      v_first_work_date := (v_row->>'first_work_date')::date;
      if to_char(v_first_work_date, 'YYYY-MM-DD') <> v_row->>'first_work_date' then
        raise exception 'invalid date';
      end if;
    exception when others then
      raise exception 'PROFILE_DATE_INVALID' using errcode = '22023';
    end;

    if v_project_id is null or v_project_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
       or not exists (
         select 1 from public.direct_entry_projects p
          where p.project_id = v_project_id and p.active
       ) then
      raise exception 'PROJECT_NOT_ACTIVE' using errcode = '22023';
    end if;
    if v_recruiter_id is null or not exists (
      select 1 from public.recruiters r
       where r.recruiter_id = v_recruiter_id and r.active
    ) then
      raise exception 'RECRUITER_NOT_ACTIVE' using errcode = '22023';
    end if;
    if v_employee_code is null then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    elsif v_employee_code ~ '^hrp-[0-9]{4}-[0-9]+$'
       and v_employee_code !~ '^hrp-[0-9]{4}-[0-9]{6}$' then
      raise exception 'EMPLOYEE_CODE_LEGACY_QUARANTINE' using errcode = '22023';
    elsif v_employee_code !~ '^hrp-[0-9]{4}-[0-9]{6}$' then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    elsif substring(v_employee_code from 5 for 4) <> to_char(v_first_work_date, 'YYYY') then
      raise exception 'EMPLOYEE_CODE_YEAR' using errcode = '22023';
    end if;
    if v_employee_code = any(v_codes) then
      raise exception 'EMPLOYEE_CODE_DUPLICATE' using errcode = '22023';
    end if;
    v_codes := array_append(v_codes, v_employee_code);

    if p_contract_version = 'worker-profile/1.2' then
      if v_row ? 'display_name'
         and jsonb_typeof(v_row->'display_name') not in ('string', 'null') then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      v_display_name := coalesce(btrim(v_display_name, v_trim_chars), '');
      if length(v_display_name) > 256
         or coalesce(v_worker_input->'national_id'->>'state', '') <> 'provided'
         or coalesce(v_worker_input->'national_id'->>'value', '') !~ '^[0-9]{12}$'
         or v_worker_input->'national_id'->>'value' = '000000000000'
         or coalesce(v_row->'employment'->>'initial_status', 'ON') = 'OFF'
         or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
    elsif v_display_name is null or length(btrim(v_display_name)) not between 1 and 256
       or (v_labor_type is not null and not public.direct_entry_is_active_labor_type(v_labor_type)) then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_worker_details := jsonb_build_object(
      'display_name', v_display_name,
      'gender', coalesce(v_worker_input->'gender', '{"state":"omitted"}'::jsonb),
      'date_of_birth', coalesce(v_worker_input->'date_of_birth', '{"state":"omitted"}'::jsonb),
      'national_id', coalesce(v_worker_input->'national_id', '{"state":"omitted"}'::jsonb),
      'national_id_issued_at', coalesce(v_worker_input->'national_id_issued_at', '{"state":"omitted"}'::jsonb),
      'national_id_issued_place', '{"state":"provided","value":"Bộ Công An"}'::jsonb,
      'address', coalesce(v_worker_input->'address', '{"state":"omitted"}'::jsonb),
      'phone', coalesce(v_worker_input->'phone', '{"state":"omitted"}'::jsonb)
    );
    if not public.direct_entry_valid_worker_details(v_worker_details) then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_national_id := case
      when v_worker_details->'national_id'->>'state' = 'provided'
      then v_worker_details->'national_id'->>'value'
      else null
    end;
    if v_national_id is not null then
      v_national_ids := array_append(v_national_ids, v_national_id);
    end if;

    select rs.provider_type, rs.team_id, rs.vendor_id
      into v_provider_type, v_team_id, v_vendor_id
      from public.direct_entry__internal_resolve_recruiter_source(
        v_recruiter_id, '22023', 'RECRUITER_MEMBERSHIP_INVALID', 'RECRUITER_MEMBERSHIP_INVALID'
      ) rs;
    v_collaborator_id := public.direct_entry_resolve_entry_collaborator_id(
      case when jsonb_typeof(v_row->'collaborator_id') = 'string' then v_row->>'collaborator_id' else null end,
      v_provider_type,
      true
    );

    v_note := coalesce(v_row->'general_note', '{"state":"omitted"}'::jsonb);
    if jsonb_typeof(v_note) <> 'object'
       or v_note - array['state','value'] <> '{}'::jsonb
       or not (v_note ? 'state') then
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;
    v_state := v_note->>'state';
    if v_state = 'provided' then
      v_general_note := v_note->>'value';
      if jsonb_typeof(v_note->'value') <> 'string'
         or not (v_note ? 'value')
         or length(btrim(v_general_note)) not between 1 and 4000 then
        raise exception 'GENERAL_NOTE_TOO_LONG' using errcode = '22023';
      end if;
    elsif v_state = 'omitted' then
      if v_note ? 'value' then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      v_general_note := null;
    else
      raise exception 'BATCH_INVALID' using errcode = '22023';
    end if;

    v_payment := nullif(v_row->'payment', 'null'::jsonb);
    v_payment_state := null;
    v_account_number := null;
    v_bank_id := null;
    v_account_holder_name := null;
    if v_payment is not null then
      if jsonb_typeof(v_payment) <> 'object'
         or v_payment - array['state','account_number','bank_id','bank_name','account_holder_name'] <> '{}'::jsonb
         or not (v_payment ? 'state') then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
      v_payment_state := v_payment->>'state';
      if v_payment_state not in ('omitted','unknown','intentionally_blank','provided') then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
      v_account_number := nullif(btrim(v_payment->>'account_number', v_trim_chars), '');
      v_bank_id := nullif(btrim(v_payment->>'bank_id'), '');
      v_bank_name := nullif(btrim(v_payment->>'bank_name', v_trim_chars), '');
      v_account_holder_name := nullif(
        btrim(v_payment->>'account_holder_name', v_trim_chars), ''
      );
      if (v_payment ? 'account_number' and jsonb_typeof(v_payment->'account_number') not in ('string','null'))
         or (v_payment ? 'bank_id' and jsonb_typeof(v_payment->'bank_id') not in ('string','null'))
         or (v_payment ? 'bank_name' and jsonb_typeof(v_payment->'bank_name') not in ('string','null'))
         or (v_payment ? 'account_holder_name' and jsonb_typeof(v_payment->'account_holder_name') not in ('string','null'))
         or (v_account_number is not null and (length(v_account_number) not between 1 and 64
           or v_account_number ~ '[[:cntrl:]]'))
         or (v_bank_name is not null and (length(v_bank_name) not between 1 and 256
           or v_bank_name ~ '[[:cntrl:]]'))
         or (v_account_holder_name is not null and
           (length(v_account_holder_name) not between 1 and 256
             or v_account_holder_name ~ '[[:cntrl:]]'))
         or (v_bank_id is not null and
           v_bank_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') then
        raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
      end if;
      if v_bank_id is not null and not exists (
        select 1 from public.direct_entry_banks b
         where b.bank_id = v_bank_id and b.active
      ) then
        raise exception 'BANK_NOT_ACTIVE' using errcode = '22023';
      end if;
      if v_payment_state <> 'provided' then
        if v_account_number is not null or v_bank_id is not null or v_bank_name is not null
           or v_account_holder_name is not null then
          raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
        end if;
      elsif v_account_number is null and v_bank_name is null and v_account_holder_name is null then
        if v_bank_id is not null then
          raise exception 'PAYMENT_DETAILS_INVALID' using errcode = '22023';
        end if;
        v_payment_state := 'omitted';
      end if;
    end if;

    v_employment := nullif(v_row->'employment', 'null'::jsonb);
    v_status := null;
    v_leave_date := null;
    v_leave_reason_text := null;
    if v_employment is not null then
      if jsonb_typeof(v_employment) <> 'object'
         or v_employment - array['initial_status','leave_date','leave_reason_text'] <> '{}'::jsonb
         or not (v_employment ? 'initial_status') then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      v_status := v_employment->>'initial_status';
      if v_status not in ('UNCONFIRMED','ON','OFF') then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
      if v_status = 'OFF' then
        begin
          if coalesce(v_employment->>'leave_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
            raise exception 'invalid date';
          end if;
          v_leave_date := (v_employment->>'leave_date')::date;
          if to_char(v_leave_date, 'YYYY-MM-DD') <> v_employment->>'leave_date' then
            raise exception 'invalid date';
          end if;
        exception when others then
          raise exception 'OFF_REQUIRES_DATE_AND_REASON' using errcode = '22023';
        end;
        v_leave_reason_text := v_employment->>'leave_reason_text';
        if v_leave_date < v_first_work_date or v_leave_date > v_auth_date
           or v_leave_reason_text is null
           or length(btrim(v_leave_reason_text)) not between 1 and 4000 then
          raise exception 'OFF_REQUIRES_DATE_AND_REASON' using errcode = '22023';
        end if;
      elsif v_employment ? 'leave_date' or v_employment ? 'leave_reason_text' then
        raise exception 'BATCH_INVALID' using errcode = '22023';
      end if;
    end if;

    insert into public.direct_entry_candidates default values
      returning candidate_id into v_candidate_id;
    insert into public.direct_entries (
      submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
      employee_code, worker_details, recruiter_id, team_id, provider_type, vendor_id, collaborator_id, labor_type,
      general_note
    ) values (
      v_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
      v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type, v_vendor_id, v_collaborator_id,
      v_labor_type, v_general_note
    ) returning entry_id into v_entry_id;

    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, version, actor_user_id, reason_id
    ) values (
      v_entry_id, case when v_status = 'UNCONFIRMED' then 'UNCONFIRMED' else 'ON' end, v_first_work_date, 1, p_app_user_id, v_reason_id
    );
    if v_status = 'OFF' then
      insert into public.direct_entry_employment_status_events (
        entry_id, status, effective_date, leave_date, leave_reason_text,
        version, actor_user_id, reason_id
      ) values (
        v_entry_id, v_status,
        case when v_status = 'OFF' then v_leave_date else v_first_work_date end,
        v_leave_date, v_leave_reason_text, 2, p_app_user_id, v_reason_id
      );
    end if;
    if v_payment_state is not null and v_payment_state <> 'omitted' then
      insert into public.direct_entry_payments (
        entry_id, state, account_number, bank_id, bank_name, account_holder_name
      ) values (
        v_entry_id, v_payment_state, v_account_number, v_bank_id, v_bank_name, v_account_holder_name
      );
    end if;

    v_revision_id := public.direct_entry_write_revision(
      v_entry_id, p_app_user_id, v_reason_id, null,
      public.direct_entry_entry_snapshot(v_entry_id), 1
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, revision_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'entry_create', 'entry_create',
      v_entry_id::text, 'own', 'APPLIED', v_reason_id, v_revision_id,
      array['entry_created','worker_details','general_note']
        || case when v_payment_state is not null and v_payment_state <> 'omitted'
             then array['payment']::text[] else '{}'::text[] end
        || case when v_status is not null
             then array['employment_status']::text[] else '{}'::text[] end
    );
    if p_contract_version = 'worker-profile/1.2' and v_national_id is not null then
      insert into public.direct_entry_cccd_reconciliations (
        entry_id, candidate_id, status, entered_national_id
      ) values (
        v_entry_id, v_candidate_id, 'PENDING', v_national_id
      )
      on conflict (entry_id) do update
        set entered_national_id = excluded.entered_national_id,
            updated_at = clock_timestamp();
    end if;
    v_entry_ids := v_entry_ids || jsonb_build_array(v_entry_id);
  end loop;

  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_submission_id, p_app_user_id, v_reason_id, null,
    jsonb_build_object('state','DRAFT','version',1,'entry_count',jsonb_array_length(p_rows)), 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'full_profile_batch_create', 'entry_create',
    v_submission_id::text, 'own', 'APPLIED', v_reason_id,
    v_submission_revision_id, array['submission_created','entries_created']
  );
  v_result := jsonb_build_object(
    'submission_id', v_submission_id,
    'state', 'DRAFT',
    'version', 1,
    'entry_ids', v_entry_ids,
    'replayed', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'full_profile_batch_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.direct_entry_create_full_profile_batch(uuid, uuid, text, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_create_full_profile_batch(uuid, uuid, text, jsonb, text)
  to service_role;

do $patch_v2_unscoped_h03$
declare
  v_sig regprocedure := 'public.direct_entry_create_full_profile_batch_v2_unscoped_h03(uuid,uuid,text,jsonb,text)'::regprocedure;
  v_def text;
  v_updated text;
begin
  v_def := replace(pg_get_functiondef(v_sig), chr(13) || chr(10), chr(10));
  v_updated := replace(
    v_def,
$old$         'project_id','first_work_date','provider_type','recruiter_id','labor_type',
         'display_name','worker_details','general_note','payment','employment'
       ] <> '{}'::jsonb$old$,
$new$         'project_id','first_work_date','provider_type','recruiter_id','labor_type','collaborator_id',
         'display_name','worker_details','general_note','payment','employment'
       ] <> '{}'::jsonb
       or ((v_row ? 'collaborator_id') and jsonb_typeof(v_row->'collaborator_id') not in ('string','null'))$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch collaborator keys on v2_unscoped_h03' using errcode = '55000';
  end if;
  v_def := v_updated;
  v_updated := replace(
    v_def,
$old$    if v_membership_count <> 1 then
      raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
    end if;

    insert into public.direct_entry_employee_code_counters$old$,
$new$    if v_membership_count <> 1 then
      raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
    end if;
    perform public.direct_entry_resolve_entry_collaborator_id(
      case when jsonb_typeof(v_row->'collaborator_id') = 'string' then v_row->>'collaborator_id' else null end,
      v_provider_type,
      true
    );

    insert into public.direct_entry_employee_code_counters$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch collaborator check on v2_unscoped_h03' using errcode = '55000';
  end if;
  execute v_updated;
end
$patch_v2_unscoped_h03$;

create or replace function public.direct_entry_update_draft_row(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_patch jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_submission public.direct_entry_submissions%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_patch_fields text[];
  v_scope text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_new_recruiter_id uuid;
  v_new_work_date date;
  v_provider text;
  v_team uuid;
  v_vendor_id text;
  v_new_collaborator_id text;
  v_candidate_collaborator_id text;
  v_count integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
     or public.direct_entry_contains_authority(p_patch)
     or exists (
       select 1 from jsonb_object_keys(p_patch) as patch_key(key)
        where patch_key.key not in (
          'project_id', 'first_work_date', 'employee_code', 'worker_details',
          'recruiter_id', 'labor_type', 'collaborator_id', 'general_note', 'payment'
        )
     )
     or ((p_patch ? 'collaborator_id') and jsonb_typeof(p_patch->'collaborator_id') not in ('string', 'null')) then
    raise exception 'invalid draft patch' using errcode = '22023';
  end if;
  if p_patch ? 'general_note' and jsonb_typeof(p_patch->'general_note') <> 'null'
     and (jsonb_typeof(p_patch->'general_note') <> 'string'
          or length(p_patch->>'general_note') > 4000
          or btrim(p_patch->>'general_note') = '') then
    raise exception 'invalid draft general note' using errcode = '22023';
  end if;
  if p_patch ? 'payment' then
    if jsonb_typeof(p_patch->'payment') <> 'object'
       or exists (
         select 1 from jsonb_object_keys(p_patch->'payment') as payment_key(key)
          where payment_key.key not in ('state','account_number','bank_name','account_holder_name')
       )
       or not (p_patch->'payment' ? 'state')
       or (p_patch->'payment' ? 'account_number' and
           jsonb_typeof(p_patch->'payment'->'account_number') not in ('string','null'))
       or (p_patch->'payment' ? 'bank_name' and
           jsonb_typeof(p_patch->'payment'->'bank_name') not in ('string','null'))
       or (p_patch->'payment' ? 'account_holder_name' and
           jsonb_typeof(p_patch->'payment'->'account_holder_name') not in ('string','null'))
       or p_patch->'payment'->>'state' not in ('provided','unknown','intentionally_blank','omitted') then
      raise exception 'invalid draft payment text' using errcode = '22023';
    end if;
    if p_patch->'payment'->>'state' = 'provided' then
      if (p_patch->'payment'->>'account_number' is not null and
          (length(p_patch->'payment'->>'account_number') > 64 or
           p_patch->'payment'->>'account_number' ~ '[[:cntrl:]]')) or
         (p_patch->'payment'->>'bank_name' is not null and
          (length(p_patch->'payment'->>'bank_name') > 256 or
           p_patch->'payment'->>'bank_name' ~ '[[:cntrl:]]')) or
         (p_patch->'payment'->>'account_holder_name' is not null and
          (length(p_patch->'payment'->>'account_holder_name') > 256 or
           p_patch->'payment'->>'account_holder_name' ~ '[[:cntrl:]]')) or
         (nullif(btrim(p_patch->'payment'->>'account_number'), '') is null and
          nullif(btrim(p_patch->'payment'->>'bank_name'), '') is null and
          nullif(btrim(p_patch->'payment'->>'account_holder_name'), '') is null) then
        raise exception 'invalid draft payment text' using errcode = '22023';
      end if;
    elsif coalesce(p_patch->'payment'->'account_number' <> 'null'::jsonb, false) or
          coalesce(p_patch->'payment'->'bank_name' <> 'null'::jsonb, false) or
          coalesce(p_patch->'payment'->'account_holder_name' <> 'null'::jsonb, false) then
      raise exception 'invalid draft payment text' using errcode = '22023';
    end if;
  end if;
  if p_patch ? 'worker_details' then
    if jsonb_typeof(p_patch->'worker_details') <> 'object'
       or p_patch->'worker_details' = '{}'::jsonb then
      raise exception 'invalid draft worker patch' using errcode = '22023';
    end if;
    if p_patch->'worker_details' ? 'display_name'
       and jsonb_typeof(p_patch->'worker_details'->'display_name') <> 'string' then
      raise exception 'invalid draft worker patch' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_object_keys(p_patch->'worker_details') as worker_key(key)
       where worker_key.key not in (
         'display_name', 'gender', 'date_of_birth', 'national_id',
         'national_id_issued_at', 'national_id_issued_place', 'address', 'phone'
       )
    ) then
      raise exception 'invalid draft worker patch' using errcode = '22023';
    end if;
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_resolve_draft_scope(
    p_auth_subject, p_app_user_id, p_entry_id
  );
  if v_scope is null then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_row_update', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'expected_version', p_expected_version, 'patch', p_patch
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if v_entry.deleted_at is not null then
    raise exception 'draft row not found' using errcode = 'P0002';
  end if;
  select * into v_submission from public.direct_entry_submissions
   where submission_id = v_entry.submission_id for update;
  if v_submission.state <> 'DRAFT' then
    raise exception 'draft submission is not editable' using errcode = '42501';
  end if;
  if p_expected_version is null or p_expected_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = 'PT409';
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_new_recruiter_id := case when p_patch ? 'recruiter_id'
    then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end;
  v_new_work_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  if v_new_recruiter_id is distinct from v_entry.recruiter_id then
    select rs.provider_type, rs.team_id, rs.vendor_id
      into v_provider, v_team, v_vendor_id
      from public.direct_entry__internal_resolve_recruiter_source(
        v_new_recruiter_id, '42501', 'provider membership denied', 'team membership denied'
      ) rs;
  else
    -- A date-only or non-recruiter edit must not re-resolve or rewrite the recruiter/vendor snapshot.
    v_provider := v_entry.provider_type;
    v_team := v_entry.team_id;
    v_vendor_id := v_entry.vendor_id;
  end if;
  if v_provider <> 'hrp' then
    if p_patch ? 'collaborator_id'
       and jsonb_typeof(p_patch->'collaborator_id') = 'string'
       and nullif(pg_catalog.btrim(p_patch->>'collaborator_id'), '') is not null then
      raise exception 'provider collaborator_id invalid' using errcode = '23514';
    end if;
    v_new_collaborator_id := null::text;
  elsif p_patch ? 'collaborator_id' then
    v_candidate_collaborator_id := nullif(
      pg_catalog.btrim(case when jsonb_typeof(p_patch->'collaborator_id') = 'string' then p_patch->>'collaborator_id' else null end),
      ''
    );
    if v_candidate_collaborator_id is null then
      v_new_collaborator_id := null::text;
    elsif v_candidate_collaborator_id is distinct from v_entry.collaborator_id then
      v_new_collaborator_id := public.direct_entry_resolve_entry_collaborator_id(
        v_candidate_collaborator_id, v_provider, true
      );
    else
      v_new_collaborator_id := v_entry.collaborator_id;
    end if;
  else
    v_new_collaborator_id := v_entry.collaborator_id;
  end if;
  if (v_new_recruiter_id is distinct from v_entry.recruiter_id and not exists (
        select 1 from public.recruiters r
         where r.recruiter_id = v_new_recruiter_id and r.active
      )) or not exists (
        select 1 from public.direct_entry_projects p
         where p.project_id = coalesce(p_patch->>'project_id', v_entry.project_id) and p.active
      ) or (v_new_recruiter_id is distinct from v_entry.recruiter_id and not exists (
        select 1 from public.teams t where t.team_id = v_team and t.active
      )) then
    raise exception 'inactive draft master' using errcode = '22023';
  end if;
  v_scope := public.direct_entry_resolve_draft_scope(
    p_auth_subject, p_app_user_id, p_entry_id,
    coalesce(p_patch->>'project_id', v_entry.project_id)
  );
  if v_scope is null then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;
  update public.direct_entries set
    project_id = case when p_patch ? 'project_id' then p_patch->>'project_id' else project_id end,
    first_work_date = case when p_patch ? 'first_work_date' then (p_patch->>'first_work_date')::date else first_work_date end,
    employee_code = case when p_patch ? 'employee_code' then p_patch->>'employee_code' else employee_code end,
    worker_details = case when p_patch ? 'worker_details'
      then v_entry.worker_details || (p_patch->'worker_details') else worker_details end,
    general_note = case when p_patch ? 'general_note'
      then case when jsonb_typeof(p_patch->'general_note') = 'null'
        then null else p_patch->>'general_note' end
      else general_note end,
    recruiter_id = case when p_patch ? 'recruiter_id' then (p_patch->>'recruiter_id')::uuid else recruiter_id end,
    labor_type = case when p_patch ? 'labor_type' then p_patch->>'labor_type' else labor_type end,
    team_id = v_team,
    provider_type = v_provider,
    vendor_id = v_vendor_id,
    collaborator_id = v_new_collaborator_id,
    version = version + 1
   where entry_id = p_entry_id;
  if p_patch ? 'payment' then
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, bank_name, account_holder_name, version
    ) values (
      p_entry_id, p_patch->'payment'->>'state',
      nullif(p_patch->'payment'->>'account_number', ''), null,
      nullif(p_patch->'payment'->>'bank_name', ''),
      nullif(p_patch->'payment'->>'account_holder_name', ''), 1
    ) on conflict (entry_id) do update set
      state = excluded.state, account_number = excluded.account_number,
      bank_id = null, bank_name = excluded.bank_name,
      account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1, updated_at = now();
  end if;
  update public.direct_entry_submissions set version = version + 1
   where submission_id = v_entry.submission_id;
  v_reason_id := null;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    v_entry.submission_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state','DRAFT','version',v_submission.version,
      'entry_count',(select count(*) from public.direct_entries
        where submission_id=v_entry.submission_id and deleted_at is null)),
    jsonb_build_object('state','DRAFT','version',v_submission.version + 1,
      'entry_count',(select count(*) from public.direct_entries
        where submission_id=v_entry.submission_id and deleted_at is null)),
    v_submission.version + 1
  );
  select array_agg(key order by key) into v_patch_fields from jsonb_object_keys(p_patch) key;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id,
    submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'draft_row_update',
    case v_scope when 'own' then 'entry_own' when 'team' then 'entry_team'
      when 'project' then 'project_manager' else 'entry_admin' end,
    p_entry_id::text, case when v_scope = 'project' then null else v_scope end,
    case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, v_submission_revision_id, v_patch_fields
  );
  v_result := jsonb_build_object(
    'entry_id', p_entry_id, 'version', v_entry.version + 1,
    'submission_version', v_submission.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_row_update', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.direct_entry_update_draft_row(uuid, uuid, uuid, integer, jsonb, text)
  from public, anon, authenticated, service_role;

-- 4.5 direct_entry_privileged_edit
create or replace function public.direct_entry_privileged_edit(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_patch jsonb,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_submission_state text;
  v_before jsonb;
  v_after jsonb;
  v_scope text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_fields text[];
  v_team uuid;
  v_provider text;
  v_vendor_id text;
  v_new_collaborator_id text;
  v_candidate_collaborator_id text;
  v_new_recruiter_id uuid;
  v_count integer;
  v_target_date date;
  v_status jsonb;
  v_latest_status public.direct_entry_employment_status_events%rowtype;
  v_status_version integer;
  v_payment jsonb;
  v_payment_account_number text;
  v_payment_bank_id text;
  v_payment_bank_name text;
  v_payment_account_holder text;
  v_vietqr_bank_name text;
  v_team_leader_team_id uuid;
  v_target_project_id text;
  v_is_full_admin boolean := false;
  v_current_team_leader_team_id uuid;
  v_direct_edit_authority text;
  v_target_direct_edit_authority text;
begin
  if p_reason is not null and length(p_reason) > 1000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'
     or public.direct_entry_contains_authority(p_patch)
     or (p_patch - array['project_id','first_work_date','employee_code','worker_details',
                        'recruiter_id','labor_type','collaborator_id','employment_status','payment']) <> '{}'::jsonb
     or ((p_patch ? 'collaborator_id') and jsonb_typeof(p_patch->'collaborator_id') not in ('string','null')) then
    raise exception 'invalid privileged edit input' using errcode = '22023';
  end if;
  if p_patch ? 'employment_status' then
    v_status := p_patch->'employment_status';
    if jsonb_typeof(v_status) <> 'object'
       or (v_status - array['status','effective_date','leave_reason']) <> '{}'::jsonb
       or jsonb_typeof(v_status->'status') <> 'string'
       or v_status->>'status' not in ('UNCONFIRMED','ON','OFF')
       or jsonb_typeof(v_status->'effective_date') <> 'string'
       or (v_status->>'status' = 'OFF' and (
         jsonb_typeof(v_status->'leave_reason') <> 'string'
         or length(btrim(v_status->>'leave_reason')) not between 1 and 4000
       ))
       or (v_status->>'status' <> 'OFF' and v_status ? 'leave_reason') then
      raise exception 'invalid privileged employment status' using errcode = '22023';
    end if;
  end if;
  if p_patch ? 'payment' then
    v_payment := p_patch->'payment';
    if jsonb_typeof(v_payment) <> 'object'
       or (v_payment - array['state','account_number','bank_id','bank_name','account_holder_name']) <> '{}'::jsonb
       or not (v_payment ? 'state' and v_payment ? 'account_number' and v_payment ? 'bank_id' and v_payment ? 'account_holder_name')
       or jsonb_typeof(v_payment->'state') <> 'string'
       or v_payment->>'state' not in ('omitted','unknown','intentionally_blank','provided')
       or jsonb_typeof(v_payment->'account_number') not in ('string','null')
       or jsonb_typeof(v_payment->'bank_id') not in ('string','null')
       or (v_payment ? 'bank_name' and jsonb_typeof(v_payment->'bank_name') not in ('string','null'))
       or jsonb_typeof(v_payment->'account_holder_name') not in ('string','null') then
      raise exception 'invalid privileged payment input' using errcode = '22023';
    end if;
    v_payment_account_number := case
      when jsonb_typeof(v_payment->'account_number') = 'string' then btrim(v_payment->>'account_number')
      else null
    end;
    v_payment_bank_id := case
      when jsonb_typeof(v_payment->'bank_id') = 'string' then btrim(v_payment->>'bank_id')
      else null
    end;
    v_payment_bank_name := case
      when v_payment ? 'bank_name' and jsonb_typeof(v_payment->'bank_name') = 'string' then btrim(v_payment->>'bank_name')
      else null
    end;
    v_payment_account_holder := case
      when jsonb_typeof(v_payment->'account_holder_name') = 'string' then btrim(v_payment->>'account_holder_name')
      else null
    end;
    if v_payment->>'state' <> 'provided' then
      if v_payment_account_number is not null
         or v_payment_bank_id is not null
         or v_payment_bank_name is not null
         or v_payment_account_holder is not null then
        raise exception 'invalid privileged payment input' using errcode = '22023';
      end if;
    else
      if (v_payment_account_number is not null and v_payment_account_number !~ '^[0-9]{1,64}$')
         or (v_payment_bank_id is not null and v_payment_bank_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
         or (v_payment_bank_name is not null and (
           length(v_payment_bank_name) not between 1 and 256
           or v_payment_bank_name ~ '[[:cntrl:]]'
         ))
         or (v_payment_account_holder is not null and (
           length(v_payment_account_holder) not between 1 and 256
           or v_payment_account_holder ~ '[[:cntrl:]]'
         ))
         or (
           v_payment_account_number is null
           and v_payment_bank_id is null
           and v_payment_bank_name is null
           and v_payment_account_holder is null
         ) then
        raise exception 'invalid privileged payment input' using errcode = '22023';
      end if;
    end if;
  end if;
  select * into v_entry from public.direct_entries where entry_id = p_entry_id for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id
   for update;
  if v_submission_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission_state not in ('DRAFT', 'SUBMITTED') then
    raise exception 'privileged edit requires a draft or submitted entry' using errcode = '42501';
  end if;
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    null;
  end;
  begin
    v_current_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    v_current_team_leader_team_id := null;
  end;
  v_direct_edit_authority := public.direct_entry_resolve_direct_edit_authority(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id, v_entry.team_id,
    v_entry.project_id, v_is_full_admin, v_current_team_leader_team_id
  );
  if v_direct_edit_authority is null then
    raise exception 'entry scope/capability denied' using errcode = '42501';
  end if;
  v_scope := case
    when v_direct_edit_authority = 'admin_all' then 'all'
    when v_direct_edit_authority = 'team_leader' then 'team'
    when v_direct_edit_authority = 'project_manager' then 'project'
    when v_direct_edit_authority like 'privileged_%'
      then substring(v_direct_edit_authority from 12)
    else null
  end;
  v_team_leader_team_id := case when v_direct_edit_authority = 'team_leader'
    then v_current_team_leader_team_id else null end;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'entry_privileged_edit', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'version', p_expected_version, 'patch', p_patch, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;
  if p_expected_version is null or p_expected_version <> v_entry.version then
    raise exception 'entry version conflict' using errcode = 'PT409';
  end if;
  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_target_date := case when p_patch ? 'first_work_date'
    then (p_patch->>'first_work_date')::date else v_entry.first_work_date end;
  v_new_recruiter_id := case when p_patch ? 'recruiter_id'
    then (p_patch->>'recruiter_id')::uuid else v_entry.recruiter_id end;

  if v_new_recruiter_id is distinct from v_entry.recruiter_id then
    select rs.provider_type, rs.team_id, rs.vendor_id
      into v_provider, v_team, v_vendor_id
      from public.direct_entry__internal_resolve_recruiter_source(
        v_new_recruiter_id, '42501', 'provider membership denied', 'team membership denied'
      ) rs;
  else
    v_team := v_entry.team_id;
    v_provider := v_entry.provider_type;
    v_vendor_id := v_entry.vendor_id;
  end if;
  if v_provider <> 'hrp' then
    if p_patch ? 'collaborator_id'
       and jsonb_typeof(p_patch->'collaborator_id') = 'string'
       and nullif(pg_catalog.btrim(p_patch->>'collaborator_id'), '') is not null then
      raise exception 'provider collaborator_id invalid' using errcode = '23514';
    end if;
    v_new_collaborator_id := null::text;
  elsif p_patch ? 'collaborator_id' then
    v_candidate_collaborator_id := nullif(
      pg_catalog.btrim(case when jsonb_typeof(p_patch->'collaborator_id') = 'string' then p_patch->>'collaborator_id' else null end),
      ''
    );
    if v_candidate_collaborator_id is null then
      v_new_collaborator_id := null::text;
    elsif v_candidate_collaborator_id is distinct from v_entry.collaborator_id then
      v_new_collaborator_id := public.direct_entry_resolve_entry_collaborator_id(
        v_candidate_collaborator_id, v_provider, true
      );
    else
      v_new_collaborator_id := v_entry.collaborator_id;
    end if;
  else
    v_new_collaborator_id := v_entry.collaborator_id;
  end if;

  v_target_project_id := case when p_patch ? 'project_id'
    then p_patch->>'project_id' else v_entry.project_id end;
  v_is_full_admin := false;
  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    null;
  end;
  v_current_team_leader_team_id := null;
  begin
    v_current_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    null;
  end;
  v_target_direct_edit_authority := public.direct_entry_resolve_direct_edit_authority(
    p_auth_subject, p_app_user_id, v_entry.created_by_user_id, v_team,
    v_target_project_id, v_is_full_admin, v_current_team_leader_team_id
  );
  if v_target_direct_edit_authority is null then
    raise exception 'direct edit target scope denied' using errcode = '42501';
  end if;
  if v_team_leader_team_id is not null then
    if v_entry.team_id is distinct from v_team_leader_team_id
       or v_team is distinct from v_team_leader_team_id then
      raise exception 'team leader edit target denied' using errcode = '42501';
    end if;
    if (p_patch ? 'recruiter_id' or p_patch ? 'project_id' or p_patch ? 'first_work_date')
       and (not public.direct_entry_project_team_scope_effective(v_entry.project_id, v_team_leader_team_id)
         or not public.direct_entry_project_team_scope_effective(v_target_project_id, v_team_leader_team_id)) then
      raise exception 'team leader project scope denied' using errcode = '42501';
    end if;
    perform public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, v_team_leader_team_id
    );
  end if;
  update public.direct_entries set
    project_id = case when p_patch ? 'project_id' then p_patch->>'project_id' else project_id end,
    first_work_date = v_target_date,
    employee_code = case when p_patch ? 'employee_code' then p_patch->>'employee_code' else employee_code end,
    worker_details = case when p_patch ? 'worker_details' then p_patch->'worker_details' else worker_details end,
    recruiter_id = v_new_recruiter_id,
    labor_type = case when p_patch ? 'labor_type' then p_patch->>'labor_type' else labor_type end,
    team_id = v_team,
    provider_type = v_provider,
    vendor_id = v_vendor_id,
    collaborator_id = v_new_collaborator_id,
    version = version + 1
   where entry_id = p_entry_id;
  if v_status is not null then
    select * into v_latest_status
      from public.direct_entry_employment_status_events
     where entry_id = p_entry_id
     order by version desc limit 1 for update;
    if not found then
      raise exception 'employment status not found' using errcode = '23514';
    end if;
    v_status_version := v_latest_status.version + 1;
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, leave_date, leave_reason_text,
      version, actor_user_id, reason_id, supersedes_event_id
    ) values (
      p_entry_id, v_status->>'status', (v_status->>'effective_date')::date,
      case when v_status->>'status' = 'OFF' then (v_status->>'effective_date')::date else null end,
      case when v_status->>'status' = 'OFF' then btrim(v_status->>'leave_reason') else null end,
      v_status_version, p_app_user_id, v_reason_id, null
    );
  end if;
  if v_payment is not null then
    if v_payment->>'state' = 'provided' and v_payment_bank_id is not null then
      if not exists (
        select 1 from public.direct_entry_banks b where b.bank_id = v_payment_bank_id
      ) then
        v_vietqr_bank_name := public.direct_entry_vietqr_bank_display_name(v_payment_bank_id);
        if v_vietqr_bank_name is not null then
          insert into public.direct_entry_banks (bank_id, display_name, active)
          values (v_payment_bank_id, v_vietqr_bank_name, true)
          on conflict (bank_id) do nothing;
        end if;
      end if;
      if v_payment_bank_name is null then
        select b.display_name
          into v_payment_bank_name
          from public.direct_entry_banks b
         where b.bank_id = v_payment_bank_id;
      end if;
    end if;
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, bank_name, account_holder_name, version
    ) values (
      p_entry_id,
      v_payment->>'state',
      v_payment_account_number,
      v_payment_bank_id,
      v_payment_bank_name,
      v_payment_account_holder,
      1
    )
    on conflict (entry_id) do update set
      state = excluded.state,
      account_number = excluded.account_number,
      bank_id = excluded.bank_id,
      bank_name = excluded.bank_name,
      account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1,
      updated_at = now();
  end if;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id, v_before, v_after, v_entry.version + 1
  );
  select array_agg(k order by k) into v_fields
    from (
      select key as k from jsonb_object_keys(p_patch) key
      union
      select 'collaborator_id'::text as k
       where v_new_collaborator_id is distinct from v_entry.collaborator_id
    ) changed_keys;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'entry_privileged_edit', 'entry_privileged_edit',
    p_entry_id::text, v_scope, case when v_scope = 'team' then v_team else null end,
    'APPLIED', v_reason_id, v_revision_id, v_fields
  );
  v_result := jsonb_build_object('entry_id', p_entry_id, 'version', v_entry.version + 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'entry_privileged_edit', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text)
  to service_role;


create or replace function public.direct_entry_apply_change_item(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_entry public.direct_entries,
  p_target_kind text,
  p_proposal jsonb,
  p_reason_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid := p_reason_id;
  v_revision_id uuid;
  v_scope text;
  v_review_capability text := 'change_review';
  v_team_review boolean;
  v_team_id uuid;
  v_provider text;
  v_vendor_id text;
  v_next_collaborator_id text;
  v_candidate_collaborator_id text;
  v_date date;
  v_recruiter_id uuid;
  v_target_project_id text;
  v_count integer;
  v_document_id uuid;
  v_status_version integer;
  v_latest public.direct_entry_employment_status_events%rowtype;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_team_review := public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) = p_entry.team_id;
  if p_target_kind = 'ENTRY_VOID' then
    if v_team_review then
      if not coalesce(v_authz_managed, false) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
      perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
      if not public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'team_manager_assign', 'CONTEXT_TEAM', p_entry.team_id::text
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
      v_scope := 'team';
      v_review_capability := 'team_manager_assign';
    else
      if not coalesce(v_authz_managed, false) then
        raise exception 'entry void review scope/capability denied' using errcode = '42501';
      end if;
      perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
      if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null) then
        v_scope := 'all';
        v_review_capability := 'entry_admin';
      elsif public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null) then
        v_scope := 'all';
        v_review_capability := 'entry_privileged_edit';
      elsif public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
        v_scope := 'all';
        v_review_capability := 'change_review';
      else
        raise exception 'entry void review scope/capability denied' using errcode = '42501';
      end if;
    end if;
  elsif v_team_review then
    v_scope := 'team';
    v_review_capability := 'team_manager_assign';
  else
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'change_review', p_entry.created_by_user_id,
      p_entry.team_id, p_entry.first_work_date
    );
  end if;

  if p_target_kind = 'DOCUMENT' then
    if not coalesce(v_authz_managed, false) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
    if v_scope = 'all' then
      if not (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
    elsif v_scope = 'team' then
      if not (
        (
          public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
          or (
            p_entry.team_id is not null
            and public.direct_entry_authz__internal_has_paired_capability(
              p_app_user_id, 'document_view', 'CONTEXT_TEAM', p_entry.team_id::text
            )
          )
        )
        and (
          public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
          or (
            p_entry.team_id is not null
            and public.direct_entry_authz__internal_has_paired_capability(
              p_app_user_id, 'document_upload', 'CONTEXT_TEAM', p_entry.team_id::text
            )
          )
        )
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
    else
      if not (
        public.direct_entry_has_entry_access(
          p_app_user_id, 'document_view', p_entry.created_by_user_id, p_entry.team_id, p_entry.first_work_date
        )
        and public.direct_entry_has_entry_access(
          p_app_user_id, 'document_upload', p_entry.created_by_user_id, p_entry.team_id, p_entry.first_work_date
        )
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
    end if;
  end if;

  if p_target_kind = 'ENTRY_VOID' then
    if p_proposal is distinct from '{}'::jsonb
       or p_entry.voided_at is not null
       or (select count(*) from public.direct_entry_change_request_items i
            where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID') <> 1
       or not exists (
         select 1 from public.direct_entry_submissions s
          where s.submission_id = p_entry.submission_id and s.state = 'SUBMITTED'
       ) then
      raise exception 'entry void target is not active' using errcode = 'PT409';
    end if;
    return public.direct_entry__internal_apply_entry_void(
      p_auth_subject,
      p_app_user_id,
      p_entry.entry_id,
      p_entry.version,
      v_reason_id,
      'change_request_approve',
      v_review_capability,
      v_scope,
      case when v_scope = 'team' then p_entry.team_id else null end
    );
  end if;

  v_before := public.direct_entry_entry_snapshot(p_entry.entry_id);
  if p_target_kind = 'ENTRY_FIELD' then
    if (p_proposal - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type','collaborator_id']) <> '{}'::jsonb
       or ((p_proposal ? 'collaborator_id') and jsonb_typeof(p_proposal->'collaborator_id') not in ('string','null'))
       or p_proposal = '{}'::jsonb
       or (p_proposal ? 'worker_details'
           and public.direct_entry_w04_worker_details_allowed(p_proposal->'worker_details') is not true) then
      raise exception 'unsupported entry proposal field' using errcode = '22023';
    end if;
    v_recruiter_id := case when p_proposal ? 'recruiter_id'
      then (p_proposal->>'recruiter_id')::uuid else p_entry.recruiter_id end;
    v_date := case when p_proposal ? 'first_work_date'
      then (p_proposal->>'first_work_date')::date else p_entry.first_work_date end;
    v_target_project_id := case when p_proposal ? 'project_id'
      then p_proposal->>'project_id' else p_entry.project_id end;

    if v_recruiter_id is distinct from p_entry.recruiter_id then
      select rs.provider_type, rs.team_id, rs.vendor_id
        into v_provider, v_team_id, v_vendor_id
        from public.direct_entry__internal_resolve_recruiter_source(
          v_recruiter_id, '42501', 'provider membership denied', 'team membership denied'
        ) rs;
    else
      v_provider := p_entry.provider_type;
      v_team_id := p_entry.team_id;
      v_vendor_id := p_entry.vendor_id;
    end if;
    if v_provider <> 'hrp' then
      if p_proposal ? 'collaborator_id'
         and jsonb_typeof(p_proposal->'collaborator_id') = 'string'
         and nullif(pg_catalog.btrim(p_proposal->>'collaborator_id'), '') is not null then
        raise exception 'provider collaborator_id invalid' using errcode = '23514';
      end if;
      v_next_collaborator_id := null::text;
    elsif p_proposal ? 'collaborator_id' then
      v_candidate_collaborator_id := nullif(
        pg_catalog.btrim(case when jsonb_typeof(p_proposal->'collaborator_id') = 'string' then p_proposal->>'collaborator_id' else null end),
        ''
      );
      if v_candidate_collaborator_id is null then
        v_next_collaborator_id := null::text;
      elsif v_candidate_collaborator_id is distinct from p_entry.collaborator_id then
        v_next_collaborator_id := public.direct_entry_resolve_entry_collaborator_id(
          v_candidate_collaborator_id, v_provider, true
        );
      else
        v_next_collaborator_id := p_entry.collaborator_id;
      end if;
    else
      v_next_collaborator_id := p_entry.collaborator_id;
    end if;

    if v_team_review then
      if v_team_id is distinct from p_entry.team_id then
        raise exception 'entry scope/capability denied' using errcode = '42501';
      end if;
      if (p_proposal ? 'recruiter_id' or p_proposal ? 'project_id' or p_proposal ? 'first_work_date')
         and (not public.direct_entry_project_team_scope_effective(p_entry.project_id, v_team_id)
           or not public.direct_entry_project_team_scope_effective(v_target_project_id, v_team_id)) then
        raise exception 'team leader project scope denied' using errcode = '42501';
      end if;
    else
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'change_review',
        p_entry.created_by_user_id, v_team_id, v_date, v_scope
      );
    end if;
    update public.direct_entries set
      project_id = v_target_project_id,
      first_work_date = v_date,
      employee_code = case when p_proposal ? 'employee_code' then p_proposal->>'employee_code' else employee_code end,
      worker_details = case when p_proposal ? 'worker_details' then p_proposal->'worker_details' else worker_details end,
      recruiter_id = v_recruiter_id,
      team_id = v_team_id,
      provider_type = v_provider,
      vendor_id = v_vendor_id,
      collaborator_id = v_next_collaborator_id,
      labor_type = case when p_proposal ? 'labor_type' then p_proposal->>'labor_type' else labor_type end,
      version = version + 1
     where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'PAYMENT' then
    if (p_proposal - array['state','account_number','bank_id','account_holder_name']) <> '{}'::jsonb then
      raise exception 'unsupported payment proposal field' using errcode = '22023';
    end if;
    insert into public.direct_entry_payments (
      entry_id, state, account_number, bank_id, account_holder_name, version
    ) values (
      p_entry.entry_id, p_proposal->>'state', p_proposal->>'account_number',
      p_proposal->>'bank_id', p_proposal->>'account_holder_name', 1
    ) on conflict (entry_id) do update set
      state = excluded.state, account_number = excluded.account_number,
      bank_id = excluded.bank_id, account_holder_name = excluded.account_holder_name,
      version = public.direct_entry_payments.version + 1, updated_at = now();
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'WORK_STATUS' then
    if (p_proposal - array['status','effective_date','leave_reason']) <> '{}'::jsonb then
      raise exception 'unsupported status proposal field' using errcode = '22023';
    end if;
    select * into v_latest from public.direct_entry_employment_status_events
     where entry_id = p_entry.entry_id order by version desc limit 1 for update;
    v_status_version := coalesce(v_latest.version, 0) + 1;
    insert into public.direct_entry_employment_status_events (
      entry_id, status, effective_date, leave_date, leave_reason_text,
      version, actor_user_id, reason_id, supersedes_event_id
    ) values (
      p_entry.entry_id, p_proposal->>'status', (p_proposal->>'effective_date')::date,
      case when p_proposal->>'status' = 'OFF' then (p_proposal->>'effective_date')::date end,
      case when p_proposal->>'status' = 'OFF' then p_proposal->>'leave_reason' end,
      v_status_version, p_app_user_id, v_reason_id, null
    );
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  elsif p_target_kind = 'DOCUMENT' then
    if (p_proposal - array['document_type','idempotency_key','checksum_sha256','size_bytes','mime_type']) <> '{}'::jsonb then
      raise exception 'unsupported document proposal field' using errcode = '22023';
    end if;
    select document_id into v_document_id
      from public.direct_entry_create_document_record(
        p_entry.candidate_id, p_proposal->>'document_type',
        p_proposal->>'idempotency_key', p_proposal->>'checksum_sha256',
        (p_proposal->>'size_bytes')::bigint, p_proposal->>'mime_type', p_app_user_id
      );
    update public.direct_entries set version = version + 1 where entry_id = p_entry.entry_id;
  else
    raise exception 'unsupported change target' using errcode = '22023';
  end if;
  v_after := public.direct_entry_entry_snapshot(p_entry.entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry.entry_id, p_app_user_id, v_reason_id, v_before, v_after, p_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'change_request_approve', v_review_capability,
    p_entry.entry_id::text, v_scope,
    case when v_scope = 'team' then
      case when p_target_kind = 'ENTRY_FIELD' then v_team_id else p_entry.team_id end
      else null end,
    'APPLIED', v_reason_id, v_revision_id, array[p_target_kind]
  );
  return v_revision_id;
end;
$function$;

revoke all on function public.direct_entry_apply_change_item(uuid, uuid, uuid, public.direct_entries, text, jsonb, uuid)
  from public, anon, authenticated, service_role;


do $patch_create_change_request$
declare
  v_sig regprocedure := 'public.direct_entry_create_change_request(uuid,uuid,jsonb,text,text)'::regprocedure;
  v_def text;
  v_updated text;
begin
  v_def := replace(pg_get_functiondef(v_sig), chr(13) || chr(10), chr(10));
  v_updated := replace(
    v_def,
$old$    if (v_item->>'target_kind' = 'ENTRY_FIELD'
          and ((v_item->'proposal') - array[
            'project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'
          ]) <> '{}'::jsonb)$old$,
$new$    if (v_item->>'target_kind' = 'ENTRY_FIELD'
          and ((v_item->'proposal') - array[
            'project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type','collaborator_id'
          ]) <> '{}'::jsonb)
       or (v_item->>'target_kind' = 'ENTRY_FIELD'
          and ((v_item->'proposal') ? 'collaborator_id')
          and jsonb_typeof(v_item->'proposal'->'collaborator_id') not in ('string','null'))$new$
  );
  if v_updated = v_def then
    raise exception 'failed to patch collaborator_id allowlist on direct_entry_create_change_request' using errcode = '55000';
  end if;
  execute v_updated;
end
$patch_create_change_request$;

create or replace function public.direct_entry_change_request_proposal_projection(
  p_target_kind text,
  p_proposal jsonb,
  p_pii_view boolean,
  p_payment_view boolean,
  p_document_view boolean
)
returns jsonb
language sql
immutable
as $$
  select case p_target_kind
    when 'ENTRY_FIELD' then
      (
        select coalesce(jsonb_object_agg(entry_field.key, entry_field.value), '{}'::jsonb)
          from jsonb_each(p_proposal) as entry_field(key, value)
         where entry_field.key in (
           'project_id', 'first_work_date', 'employee_code', 'recruiter_id', 'labor_type', 'collaborator_id'
         )
      ) || case
             when p_proposal ? 'worker_details' then
               case when coalesce(p_pii_view, false)
                 then jsonb_build_object('worker_details', p_proposal->'worker_details')
                 else jsonb_build_object('worker_details', jsonb_build_object('present', true))
               end
             else '{}'::jsonb
           end
    when 'PAYMENT' then
      jsonb_strip_nulls(jsonb_build_object(
        'state', p_proposal->'state',
        'account_number', case
          when p_proposal ? 'account_number' then
            case when coalesce(p_payment_view, false) then p_proposal->'account_number'
              else to_jsonb(
                case when p_proposal->>'account_number' is null then null
                  else repeat('•', greatest(length(p_proposal->>'account_number') - 4, 0))
                       || right(p_proposal->>'account_number', 4) end
              )
            end
          end,
        'bank_id', case when coalesce(p_payment_view, false) then p_proposal->'bank_id' end,
        'account_holder_name',
          case when coalesce(p_payment_view, false) then p_proposal->'account_holder_name' end
      ))
    when 'WORK_STATUS' then
      jsonb_strip_nulls(jsonb_build_object(
        'status', p_proposal->'status',
        'effective_date', p_proposal->'effective_date'
      ))
    when 'DOCUMENT' then
      jsonb_strip_nulls(jsonb_build_object(
        'document_type', p_proposal->'document_type',
        'size_bytes', case when coalesce(p_document_view, false) then p_proposal->'size_bytes' end,
        'mime_type', case when coalesce(p_document_view, false) then p_proposal->'mime_type' end
      ))
    else '{}'::jsonb
  end;
$$;
revoke all on function public.direct_entry_change_request_proposal_projection(text, jsonb, boolean, boolean, boolean)
  from public, anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. Read / Directory / Export Projections
-- ---------------------------------------------------------------------------
create or replace function public.direct_entry_list_own_drafts(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_result jsonb;
  v_count integer;
  v_employment_apply boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_employment_apply :=
    coalesce(v_authz_managed, false)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'employment_status.apply', 'ALL', null);

  select count(*) into v_count
    from public.direct_entries e
    join public.direct_entry_submissions s on s.submission_id = e.submission_id
   where s.state = 'DRAFT'
     and e.deleted_at is null
     and public.direct_entry_resolve_draft_scope(
       p_auth_subject, p_app_user_id, e.entry_id
     ) is not null;
  if v_count > 500 then
    raise exception 'draft list exceeds supported size' using errcode = '54000';
  end if;

  with eligible as materialized (
    select e.*, s.version as submission_version,
           (s.created_by_user_id = p_app_user_id and e.created_by_user_id = p_app_user_id)
             as own_submission,
           p.display_name as project_display_name,
           r.display_name as recruiter_display_name,
           t.display_name as team_display_name,
           c.display_name as collaborator_display_name
      from public.direct_entries e
      join public.direct_entry_submissions s on s.submission_id = e.submission_id
      join public.direct_entry_projects p on p.project_id = e.project_id
      join public.recruiters r on r.recruiter_id = e.recruiter_id
      join public.teams t on t.team_id = e.team_id
      left join public.collaborators c on c.collaborator_id = e.collaborator_id
     where s.state = 'DRAFT'
       and e.deleted_at is null
       and public.direct_entry_resolve_draft_scope(
         p_auth_subject, p_app_user_id, e.entry_id
       ) is not null
  ),
  authorized as materialized (
    select e.*,
           public.direct_entry_resolve_draft_scope(
             p_auth_subject, p_app_user_id, e.entry_id
           ) as resolved_scope
      from eligible e
  )
  select jsonb_build_object(
    'projection_version', 'direct-entry-draft-list/2',
    'drafts', coalesce(jsonb_agg(jsonb_build_object(
      'submission_id', e.submission_id,
      'submission_version', e.submission_version,
      'entry_id', e.entry_id,
      'entry_version', e.version,
      'employee_code', e.employee_code,
      'first_work_date', e.first_work_date,
      'worker_display_name', case when e.own_submission then e.worker_details->>'display_name' else '' end,
      'project_id', e.project_id,
      'project_display_name', e.project_display_name,
      'recruiter_id', e.recruiter_id,
      'recruiter_display_name', e.recruiter_display_name,
      'provider_type', e.provider_type,
      'collaborator_id', e.collaborator_id,
      'collaborator_display_name', e.collaborator_display_name,
      'team_id', e.team_id,
      'team_display_name', case when e.provider_type = 'vendor'
        then 'Không áp dụng' else e.team_display_name end,
      'labor_type', e.labor_type,
      'labor_type_display', (select lt.display_name from public.direct_entry_labor_types lt
        where lt.labor_type_key = e.labor_type),
      'employment_status', status.status,
      'created_at', e.created_at,
      'updated_at', e.updated_at,
      'profile', jsonb_build_object(
        'contract_version', 'worker-profile/1.0',
        'worker_details', jsonb_build_object(
          'display_name', case when e.own_submission then jsonb_build_object(
            'state', 'provided', 'value', e.worker_details->>'display_name'
          ) else jsonb_build_object('state', 'redacted', 'present', true) end,
          'gender', public.direct_entry_draft_profile_field(e.worker_details->'gender', e.own_submission),
          'date_of_birth', public.direct_entry_draft_profile_field(e.worker_details->'date_of_birth', e.own_submission),
          'national_id', public.direct_entry_draft_profile_field(e.worker_details->'national_id', e.own_submission),
          'national_id_issued_at', public.direct_entry_draft_profile_field(e.worker_details->'national_id_issued_at', e.own_submission),
          'national_id_issued_place', public.direct_entry_draft_profile_field(e.worker_details->'national_id_issued_place', e.own_submission),
          'address', public.direct_entry_draft_profile_field(e.worker_details->'address', e.own_submission),
          'phone', public.direct_entry_draft_profile_field(e.worker_details->'phone', e.own_submission)
        ),
        'general_note', case
          when e.general_note is null then jsonb_build_object('state', 'omitted')
          when e.own_submission then jsonb_build_object('state', 'provided', 'value', e.general_note)
          else jsonb_build_object('state', 'redacted', 'present', true)
        end,
        'employment', case when status.version is null then null else jsonb_build_object(
            'status', status.status,
            'effective_date', status.effective_date,
            'version', status.version,
            'leave_date', case
              when status.leave_date is null then jsonb_build_object('state', 'omitted')
              when not (
                v_employment_apply
                or e.own_submission
                or (
                  coalesce(v_authz_managed, false)
                  and e.team_id is not null
                  and public.direct_entry_authz__internal_has_paired_capability(
                    p_app_user_id, 'employment_status.apply', 'CONTEXT_TEAM', e.team_id::text
                  )
                )
              ) then jsonb_build_object('state', 'omitted')
              when e.own_submission
                then jsonb_build_object('state', 'provided', 'value', status.leave_date)
              else jsonb_build_object('state', 'redacted', 'present', true)
            end,
            'leave_reason_text', case
              when status.leave_reason_text is null then jsonb_build_object('state', 'omitted')
              when not (
                v_employment_apply
                or e.own_submission
                or (
                  coalesce(v_authz_managed, false)
                  and e.team_id is not null
                  and public.direct_entry_authz__internal_has_paired_capability(
                    p_app_user_id, 'employment_status.apply', 'CONTEXT_TEAM', e.team_id::text
                  )
                )
              ) then jsonb_build_object('state', 'omitted')
              when e.own_submission
                then jsonb_build_object('state', 'provided', 'value', status.leave_reason_text)
              else jsonb_build_object('state', 'redacted', 'present', true)
            end
          ) end,
        'payment', case when payment.entry_id is null then null else jsonb_build_object(
            'state', payment.state,
            'account_number', case
              when payment.account_number is null then jsonb_build_object('state', 'omitted')
              when e.own_submission then jsonb_build_object(
                'state', 'provided', 'value', payment.account_number
              )
              else jsonb_build_object(
                'state', 'masked',
                'value', repeat('•', greatest(length(payment.account_number) - 4, 0)) ||
                  right(payment.account_number, 4)
              )
            end,
            'bank_name', case
              when payment.bank_name is null then jsonb_build_object('state', 'omitted')
              when e.own_submission then jsonb_build_object(
                'state', 'provided', 'value', payment.bank_name
              )
              else jsonb_build_object('state', 'redacted', 'present', true)
            end,
            'account_holder_name', case
              when payment.account_holder_name is null then jsonb_build_object('state', 'omitted')
              when e.own_submission then jsonb_build_object(
                'state', 'provided', 'value', payment.account_holder_name
              )
              else jsonb_build_object('state', 'redacted', 'present', true)
            end,
            'version', payment.version
          ) end
      )
    ) order by e.created_at, e.entry_id), '[]'::jsonb)
  ) into v_result
    from authorized e
    left join lateral (
      select st.status, st.effective_date, st.version, st.leave_date, st.leave_reason_text
        from public.direct_entry_employment_status_events st
       where st.entry_id = e.entry_id
       order by st.version desc
       limit 1
    ) status on true
    left join public.direct_entry_payments payment on payment.entry_id = e.entry_id
   where e.resolved_scope in ('own', 'team', 'all', 'project');

  return v_result;
end;
$function$;
revoke all on function public.direct_entry_list_own_drafts(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_own_drafts(uuid, uuid) to service_role;


create or replace function public.direct_entry_read_change_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_request public.direct_entry_change_requests%rowtype;
  v_audience text;
  v_pii_view boolean;
  v_payment_view boolean;
  v_request_reason text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if p_request_id is null then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id;
  if not found then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_audience := public.direct_entry_change_request_audience(
    p_app_user_id, v_request.proposer_user_id, v_request.request_id
  );
  if v_audience = 'NONE' then
    if v_request.proposer_user_id = p_app_user_id then
      v_audience := 'PROPOSER_HISTORY';
    elsif v_request.state in ('APPROVED', 'REJECTED')
          and v_request.decided_by_user_id = p_app_user_id
          and v_request.proposer_user_id <> p_app_user_id then
      v_audience := 'DECIDER_HISTORY';
    elsif v_request.state in ('APPROVED', 'REJECTED') and coalesce(v_authz_managed, false) then
      if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
         or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
        v_audience := 'AUDITOR';
      end if;
    end if;
  end if;
  if v_audience = 'NONE' then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;

  v_pii_view := true;
  v_payment_view := true;

  if v_audience in ('REVIEWER', 'AUDITOR', 'DECIDER_HISTORY') then
    select rr.reason_text into v_request_reason
      from public.direct_entry_restricted_reasons rr
     where rr.reason_id = v_request.reason_id;
  end if;
  return jsonb_build_object(
    'request_id', v_request.request_id,
    'state', v_request.state,
    'version', v_request.version,
    'created_at', pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_request.created_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z',
    'request_reason', v_request_reason,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'entry_id', i.entry_id,
               'target_kind', i.target_kind,
               'expected_version', i.expected_version,
               'proposal', case
                 when i.target_kind = 'WORK_STATUS'
                      and v_audience in ('REVIEWER', 'AUDITOR', 'DECIDER_HISTORY')
                      and i.proposal ? 'leave_reason'
                   then public.direct_entry_change_request_proposal_projection(
                     i.target_kind, i.proposal, v_pii_view, v_payment_view,
                     case
                       when not coalesce(v_authz_managed, false) or e.entry_id is null then false
                       else (
                         public.direct_entry_has_entry_access(
                           p_app_user_id, 'document_view', e.created_by_user_id, e.team_id, e.first_work_date
                         )
                         or (
                           v_audience = 'PROPOSER'
                           and public.direct_entry_authz__internal_has_paired_capability(
                             p_app_user_id, 'document_view', 'CONTEXT_PROJECT', e.project_id
                           )
                         )
                       )
                     end
                   ) || jsonb_build_object('leave_reason', i.proposal->'leave_reason')
                 else public.direct_entry_change_request_proposal_projection(
                   i.target_kind, i.proposal, v_pii_view, v_payment_view,
                   case
                     when not coalesce(v_authz_managed, false) or e.entry_id is null then false
                     else (
                       public.direct_entry_has_entry_access(
                         p_app_user_id, 'document_view', e.created_by_user_id, e.team_id, e.first_work_date
                       )
                       or (
                         v_audience = 'PROPOSER'
                         and public.direct_entry_authz__internal_has_paired_capability(
                           p_app_user_id, 'document_view', 'CONTEXT_PROJECT', e.project_id
                         )
                       )
                     )
                   end
                 )
               end,
               'labor_type_display', case
                 when i.target_kind = 'ENTRY_FIELD'
                      and nullif(i.proposal->>'labor_type', '') is not null
                   then (select lt.display_name from public.direct_entry_labor_types lt
                          where lt.labor_type_key = i.proposal->>'labor_type')
                 else null end,
               'collaborator_display', case
                 when i.target_kind = 'ENTRY_FIELD'
                      and nullif(i.proposal->>'collaborator_id', '') is not null
                   then (select c.display_name from public.collaborators c
                          where c.collaborator_id = i.proposal->>'collaborator_id')
                 else null end
             ) order by i.entry_id), '[]'::jsonb)
        from public.direct_entry_change_request_items i
        left join public.direct_entries e on e.entry_id = i.entry_id
       where i.request_id = v_request.request_id
    ),
    'can_withdraw', (v_audience = 'PROPOSER' and v_request.state = 'PENDING'),
    'can_decide', (v_audience = 'REVIEWER' and v_request.state = 'PENDING')
  );
end;
$function$;
revoke all on function public.direct_entry_read_change_request(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_read_change_request(uuid, uuid, uuid) to service_role;


create or replace function public.direct_entry_read_projection(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_result jsonb;
  v_pii boolean;
  v_payment boolean;
  v_documents boolean;
begin
  select * into v_entry from public.direct_entries
   where entry_id = p_entry_id and deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  v_scope := public.direct_entry_resolve_submission_read_scope(
    p_auth_subject, p_app_user_id, v_entry.entry_id
  );
  if v_scope is null then
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'entry_privileged_edit',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  end if;
  if v_scope is null then
    raise exception 'entry scope/capability denied' using errcode = '42501';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_pii := true;
  v_payment := true;
  if coalesce(v_authz_managed, false) then
    v_documents :=
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
      or (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
        and (
          v_entry.created_by_user_id = p_app_user_id
          or v_scope in ('project', 'team', 'team_review', 'recruited')
        )
      )
      or (
        v_entry.team_id is not null
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'CONTEXT_TEAM', v_entry.team_id::text)
      )
      or (
        v_scope = 'project'
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'CONTEXT_PROJECT', v_entry.project_id)
      )
      or (
        v_entry.created_by_user_id = p_app_user_id
        and v_scope = 'project'
        and exists (
          select 1 from public.direct_entry_submissions s
           where s.submission_id = v_entry.submission_id and s.state = 'DRAFT'
        )
      );
  else
    v_documents := false;
  end if;

  if v_scope = 'project' and exists (
       select 1 from public.direct_entry_submissions s
        where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
     ) then
    v_pii := true;
    v_payment := true;
  end if;
  v_result := jsonb_build_object(
    'created_at', pg_catalog.to_char(v_entry.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_entry.created_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z',
    'created_by', (
      select jsonb_build_object(
        'display_name', coalesce(
          recruiter.display_name,
          nullif(creator.display_name, login.login_id)
        ),
        'login_id', login.login_id
      )
        from public.direct_entry_app_users creator
        left join auth.users auth_user on auth_user.id = creator.auth_subject
        cross join lateral (
          select lower(nullif(split_part(to_jsonb(auth_user)->>'email', pg_catalog.chr(64), 1), '')) as login_id
        ) login
        left join lateral (
          select r.display_name
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = creator.app_user_id
             and l.verified
             and l.is_current
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) recruiter on true
       where creator.app_user_id = v_entry.created_by_user_id
    ),
    'entry_id', v_entry.entry_id, 'submission_id', v_entry.submission_id,
    'project_id', v_entry.project_id, 'first_work_date', v_entry.first_work_date,
    'employee_code', v_entry.employee_code,
    'worker_details', case when v_pii then v_entry.worker_details else jsonb_build_object(
      'display_name', jsonb_build_object('present', v_entry.worker_details ? 'display_name'),
      'gender', jsonb_build_object('state', v_entry.worker_details->'gender'->>'state'),
      'date_of_birth', jsonb_build_object('state', v_entry.worker_details->'date_of_birth'->>'state'),
      'national_id', jsonb_build_object('state', v_entry.worker_details->'national_id'->>'state'),
      'national_id_issued_at', jsonb_build_object(
        'state', v_entry.worker_details->'national_id_issued_at'->>'state'
      ),
      'national_id_issued_place', jsonb_build_object(
        'state', v_entry.worker_details->'national_id_issued_place'->>'state'
      ),
      'address', jsonb_build_object('state', v_entry.worker_details->'address'->>'state'),
      'phone', jsonb_build_object('state', v_entry.worker_details->'phone'->>'state')
    ) end,
    'general_note', case when v_entry.general_note is null then null
      when v_pii then to_jsonb(v_entry.general_note)
      else jsonb_build_object('present', true) end,
    'recruiter_id', v_entry.recruiter_id, 'team_id', v_entry.team_id,
    'provider_type', v_entry.provider_type,
    'collaborator_id', v_entry.collaborator_id,
    'collaborator_display_name', (select c.display_name from public.collaborators c where c.collaborator_id = v_entry.collaborator_id),
    'labor_type', v_entry.labor_type,
    'labor_type_display', (select lt.display_name from public.direct_entry_labor_types lt
      where lt.labor_type_key = v_entry.labor_type),
    'version', v_entry.version, 'scope_kind', v_scope,
    'payment', (
      select case when v_payment then jsonb_build_object(
        'state', p.state, 'account_number', p.account_number, 'bank_id', p.bank_id,
        'bank_name', p.bank_name, 'account_holder_name', p.account_holder_name,
        'version', p.version
      ) else jsonb_build_object(
        'state', p.state,
        'account_number', case when p.account_number is null then null
          else repeat('•', greatest(length(p.account_number) - 4, 0)) ||
            right(p.account_number, 4) end,
        'version', p.version
      ) end
        from public.direct_entry_payments p
       where p.entry_id = p_entry_id
    ),
    'employment_status', (
      select jsonb_build_object(
        'status', st.status, 'effective_date', st.effective_date, 'version', st.version
      )
        from public.direct_entry_employment_status_events st
       where st.entry_id = p_entry_id
       order by st.version desc
       limit 1
    ),
    'worker_portrait', case when v_documents then (
      select jsonb_build_object(
        'origin', c.worker_portrait_origin,
        'added_at', c.worker_portrait_added_at,
        'status', coalesce(latest.upload_status, 'MISSING'),
        'current', case when current_document.document_id is null then null
          else jsonb_build_object(
            'document_id', current_document.document_id,
            'version', current_document.version,
            'checksum_sha256', current_document.checksum_sha256,
            'mime_type', current_document.mime_type,
            'size_bytes', current_document.size_bytes
          )
        end
      )
        from public.direct_entry_candidates c
        left join lateral (
          select e.upload_status
            from public.direct_entry_document_versions d
            join lateral (
              select ev.upload_status
                from public.direct_entry_document_events ev
               where ev.document_id = d.document_id
               order by ev.version desc
               limit 1
            ) e on true
           where d.candidate_id = c.candidate_id
             and d.document_type = 'WORKER_PORTRAIT'
           order by d.version desc
           limit 1
        ) latest on true
        left join lateral (
          select cd.document_id, cd.version, cd.checksum_sha256, cd.mime_type, cd.size_bytes
            from public.direct_entry_current_documents cd
           where cd.candidate_id = c.candidate_id
             and cd.document_type = 'WORKER_PORTRAIT'
        ) current_document on true
       where c.candidate_id = v_entry.candidate_id
    ) else null end,
    'documents', case when v_documents then (
      select coalesce(jsonb_agg(jsonb_build_object(
        'document_id', d.document_id, 'document_type', d.document_type,
        'version', d.version, 'size_bytes', d.size_bytes, 'mime_type', d.mime_type,
        'upload_status', d.upload_status, 'scan_status', d.scan_status,
        'validation_status', d.validation_status
      ) order by d.document_type, d.version), '[]'::jsonb)
        from public.direct_entry_current_documents d
       where d.candidate_id = v_entry.candidate_id
         and d.document_type <> 'WORKER_PORTRAIT'
    ) else '[]'::jsonb end
  );
  return v_result;
end;
$function$;
revoke all on function public.direct_entry_read_projection(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_read_projection(uuid, uuid, uuid) to service_role;


create or replace function public.direct_entry_list_workers_search(
  p_search text,
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text,
  p_recruiter_id uuid,
  p_employment_status text,
  p_cursor text,
  p_page_size integer,
  p_first_work_date_from date,
  p_first_work_date_to date,
  p_provider_type text,
  p_labor_type text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_audience jsonb;
  v_scope text;
  v_recruiter_ids uuid[];
  v_project_ids text[];
  v_view_pii boolean;
  v_view_payment boolean;
  v_is_full_admin boolean := false;
  v_team_leader_team_id uuid;
  v_page_size integer;
  v_cursor_stamp timestamptz;
  v_cursor_id uuid;
  v_scanned integer;
  v_items jsonb;
  v_next_cursor text;
  v_summary jsonb;
  v_team_id uuid;
begin
  v_audience := public.direct_entry_worker_directory_audience(
    p_auth_subject, p_app_user_id, p_scope, p_project_id
  );
  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    null;
  end;
  begin
    v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    v_team_leader_team_id := null;
  end;
  v_scope := v_audience->>'scope';
  v_team_id := nullif(v_audience->>'team_id', '')::uuid;
  v_view_pii := true;
  v_view_payment := true;
  v_recruiter_ids := case
    when pg_catalog.jsonb_array_length(v_audience->'recruiter_ids') = 0 then null
    else array(select pg_catalog.jsonb_array_elements_text(v_audience->'recruiter_ids')::uuid)
  end;
  v_project_ids := case
    when pg_catalog.jsonb_array_length(v_audience->'project_ids') = 0 then null
    else array(select pg_catalog.jsonb_array_elements_text(v_audience->'project_ids'))
  end;

  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_employment_status is not null
     and p_employment_status not in ('UNCONFIRMED', 'ON', 'OFF') then
    raise exception 'invalid employment status filter' using errcode = '22023';
  end if;
  p_provider_type := nullif(pg_catalog.btrim(p_provider_type), '');
  if p_provider_type is not null
     and p_provider_type not in ('hrp', 'hrp_direct', 'hrp_ctv', 'vendor') then
    raise exception 'invalid provider type filter' using errcode = '22023';
  end if;
  p_labor_type := nullif(pg_catalog.btrim(p_labor_type), '');
  if p_labor_type is not null
     and p_labor_type !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'invalid labor type filter' using errcode = '22023';
  end if;
  if p_first_work_date_from is not null
     and p_first_work_date_to is not null
     and p_first_work_date_from > p_first_work_date_to then
    raise exception 'invalid first work date range' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, '|', 1)::timestamptz;
    v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;
  end if;

  p_search := nullif(pg_catalog.btrim(p_search), '');
  if p_search is not null and
     (pg_catalog.char_length(p_search) > 100 or p_search ~ '[[:cntrl:]]') then
    raise exception 'invalid worker search' using errcode = '22023';
  end if;

  with candidates as (
    select e.entry_id,
           e.created_at,
           e.version,
           e.project_id,
           e.team_id,
           e.created_by_user_id,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.recruiter_id,
           e.provider_type,
           e.collaborator_id,
           col.display_name as collaborator_display_name,
           e.labor_type,
           (select lt.display_name from public.direct_entry_labor_types lt
             where lt.labor_type_key = e.labor_type) as labor_type_display,
           s.state,
           pr.display_name as project_display,
           rc.display_name as recruiter_display,
           st.status as employment_status,
           pay.state as payment_state,
           pay.account_number,
           pay.bank_id,
           pay.account_holder_name,
           pay.version as payment_version
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
      join public.direct_entry_projects pr
        on pr.project_id = e.project_id
      join public.recruiters rc
        on rc.recruiter_id = e.recruiter_id
      left join public.collaborators col
        on col.collaborator_id = e.collaborator_id
      left join lateral (
        select ev.status
          from public.direct_entry_employment_status_events ev
         where ev.entry_id = e.entry_id
         order by ev.version desc
         limit 1
      ) st on true
      left join public.direct_entry_payments pay
        on pay.entry_id = e.entry_id
     where e.deleted_at is null and e.voided_at is null
       and s.state = 'SUBMITTED'
       and (
         v_scope = 'all'
         or (v_scope = 'recruited' and e.recruiter_id = any(v_recruiter_ids))
         or (v_scope = 'managed' and e.project_id = any(v_project_ids))
         or (v_scope = 'team' and e.team_id = v_team_id)
       )
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_recruiter_id is null or e.recruiter_id = p_recruiter_id)
       and (p_employment_status is null or st.status = p_employment_status)
       and (p_first_work_date_from is null or e.first_work_date >= p_first_work_date_from)
       and (p_first_work_date_to is null or e.first_work_date <= p_first_work_date_to)
       and (
         p_provider_type is null
         or (p_provider_type = 'hrp' and e.provider_type = 'hrp')
         or (p_provider_type = 'hrp_direct' and e.provider_type = 'hrp' and e.collaborator_id is null)
         or (p_provider_type = 'hrp_ctv' and e.provider_type = 'hrp' and e.collaborator_id is not null)
         or (p_provider_type = 'vendor' and e.provider_type = 'vendor')
       )
       and (p_labor_type is null or e.labor_type = p_labor_type)
       and (p_search is null
         or pg_catalog.strpos(pg_catalog.lower(coalesce(e.worker_details->>'display_name', '')), pg_catalog.lower(p_search)) > 0
         or pg_catalog.strpos(pg_catalog.lower(coalesce(e.employee_code, '')), pg_catalog.lower(p_search)) > 0)
  ),
  summary as (
    select count(*)::bigint as total_workers,
           count(distinct project_id)::bigint as project_count,
           count(distinct recruiter_id)::bigint as recruiter_count
      from candidates
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             || '|' || c.entry_id::text as cursor
      from candidates c
     where v_cursor_stamp is null
        or (c.created_at, c.entry_id) < (v_cursor_stamp, v_cursor_id)
     order by c.created_at desc, c.entry_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by created_at desc, entry_id desc limit v_page_size
  )
  select
    (select count(*)::int from page),
    (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'entry_id', t.entry_id,
               'entry_version', t.version,
               'submission_state', t.state,
               'employee_code', t.employee_code,
               'display_name', t.worker_details->>'display_name',
               'project_id', t.project_id,
               'project_display', t.project_display,
               'first_work_date', pg_catalog.to_char(t.first_work_date, 'YYYY-MM-DD'),
               'labor_type', t.labor_type,
               'labor_type_display', t.labor_type_display,
               'employment_status', t.employment_status,
               'recruiter_id', t.recruiter_id,
               'recruiter_display', t.recruiter_display,
               'provider_type', t.provider_type,
               'collaborator_id', t.collaborator_id,
               'collaborator_display_name', t.collaborator_display_name,
               'payment', case
                 when v_view_payment and t.payment_state is not null then pg_catalog.jsonb_build_object(
                   'state', t.payment_state,
                   'account_number', t.account_number,
                   'bank_id', t.bank_id,
                   'account_holder_name', t.account_holder_name,
                   'version', t.payment_version
                 )
                 else null
               end,
               'pending_request', case when pr.request_id is null then null else pg_catalog.jsonb_build_object(
                 'request_id', pr.request_id,
                 'state', 'PENDING',
                 'version', pr.version
               ) end,
               'last_decision', case when ld.state is null then null else pg_catalog.jsonb_build_object(
                 'state', ld.state,
                 'decided_at', pg_catalog.to_char(ld.decided_at at time zone 'UTC', 'YYYY-MM-DD')
                   || 'T' || pg_catalog.to_char(ld.decided_at at time zone 'UTC', 'HH24:MI:SS.US')
                   || 'Z'
               ) end,
               'is_project_manager',
                 public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, t.project_id),
               'allowed_actions', pg_catalog.jsonb_build_object(
                 'view', true,
                 'view_pii', v_view_pii,
                 'view_payment', v_view_payment,
                 'direct_edit', public.direct_entry_resolve_direct_edit_authority(
                   p_auth_subject, p_app_user_id, t.created_by_user_id, t.team_id,
                   t.project_id, v_is_full_admin, v_team_leader_team_id
                 ) is not null,
                 'propose_change',
                   public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, t.project_id),
                 'propose_change_code', case
                   when public.direct_entry_actor_is_assigned_project_manager(
                     p_app_user_id, t.project_id
                   ) then null
                   else 'NOT_PROJECT_MANAGER'
                 end
               )
             ) order by t.created_at desc, t.entry_id desc), '[]'::jsonb)
        from trimmed t
        left join lateral (
          select r.request_id, r.version
            from public.direct_entry_change_requests r
            join public.direct_entry_change_request_items i
              on i.request_id = r.request_id
           where i.entry_id = t.entry_id
             and r.state = 'PENDING'
           order by r.created_at desc, r.request_id desc
           limit 1
        ) pr on true
        left join lateral (
          select r.state, r.decided_at
            from public.direct_entry_change_requests r
            join public.direct_entry_change_request_items i
              on i.request_id = r.request_id
           where i.entry_id = t.entry_id
             and r.state in ('APPROVED', 'REJECTED')
           order by r.decided_at desc nulls last, r.request_id desc
           limit 1
        ) ld on true
    ),
    (
      select t.cursor from trimmed t
       order by t.created_at asc, t.entry_id asc
       limit 1
    ),
    (
      select pg_catalog.jsonb_build_object(
        'total_workers', s.total_workers,
        'project_count', s.project_count,
        'recruiter_count', s.recruiter_count
      ) from summary s
    )
  into v_scanned, v_items, v_next_cursor, v_summary;

  return pg_catalog.jsonb_build_object(
    'items', v_items,
    'scope', v_scope,
    'page_size', v_page_size,
    'has_more', v_scanned > v_page_size,
    'next_cursor', case when v_scanned > v_page_size then v_next_cursor else null end,
    'summary', v_summary,
    'authorization_date', public.direct_entry_authorization_date()
  );
end;
$function$;

revoke all on function public.direct_entry_list_workers_search(
  text, uuid, uuid, text, text, uuid, text, text, integer, date, date, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.direct_entry_list_workers_search(text, uuid, uuid, text, text, uuid, text, text, integer, date, date, text, text) from public, anon, authenticated, service_role;


create or replace function public.direct_entry_export_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text,
  p_recruiter_id uuid,
  p_employment_status text,
  p_reason text,
  p_search text,
  p_first_work_date_from date,
  p_first_work_date_to date,
  p_provider_type text,
  p_labor_type text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_audience jsonb;
  v_scope text;
  v_recruiter_ids uuid[];
  v_project_ids text[];
  v_scope_kind text;
  v_reason_id uuid;
  v_filter_hash text;
  v_total integer;
  v_rows jsonb;
  v_team_id uuid;
begin
  if p_reason is not null and pg_catalog.length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(pg_catalog.btrim(p_reason), '');

  if p_scope is null or p_scope not in ('recruited', 'managed', 'team', 'all') then
    raise exception 'worker export scope denied' using errcode = '42501';
  end if;

  v_audience := public.direct_entry_worker_directory_audience(
    p_auth_subject, p_app_user_id, p_scope, p_project_id
  );
  v_scope := v_audience->>'scope';
  v_team_id := nullif(v_audience->>'team_id', '')::uuid;
  v_recruiter_ids := case
    when pg_catalog.jsonb_array_length(v_audience->'recruiter_ids') = 0 then null
    else array(select pg_catalog.jsonb_array_elements_text(v_audience->'recruiter_ids')::uuid)
  end;
  v_project_ids := case
    when pg_catalog.jsonb_array_length(v_audience->'project_ids') = 0 then null
    else array(select pg_catalog.jsonb_array_elements_text(v_audience->'project_ids'))
  end;

  if p_employment_status is not null
     and p_employment_status not in ('UNCONFIRMED', 'ON', 'OFF') then
    raise exception 'invalid employment status filter' using errcode = '22023';
  end if;

  p_provider_type := nullif(pg_catalog.btrim(p_provider_type), '');
  if p_provider_type is not null
     and p_provider_type not in ('hrp', 'hrp_direct', 'hrp_ctv', 'vendor') then
    raise exception 'invalid provider type filter' using errcode = '22023';
  end if;

  p_labor_type := nullif(pg_catalog.btrim(p_labor_type), '');
  if p_labor_type is not null
     and p_labor_type !~ '^[A-Z][A-Z0-9_]{0,63}$' then
    raise exception 'invalid labor type filter' using errcode = '22023';
  end if;

  if p_first_work_date_from is not null
     and p_first_work_date_to is not null
     and p_first_work_date_from > p_first_work_date_to then
    raise exception 'invalid first work date range' using errcode = '22023';
  end if;

  p_search := nullif(pg_catalog.btrim(p_search), '');
  if p_search is not null and
     (pg_catalog.char_length(p_search) > 100 or p_search ~ '[[:cntrl:]]') then
    raise exception 'invalid worker search' using errcode = '22023';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  with candidates as (
    select e.entry_id,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.provider_type,
           e.collaborator_id,
           c.display_name as collaborator_display_name,
           e.general_note,
           pr.display_name as project_display,
           rc.display_name as recruiter_display,
           (select lt.display_name from public.direct_entry_labor_types lt
             where lt.labor_type_key = e.labor_type) as labor_type_display,
           st.status as employment_status,
           st.leave_date,
           st.leave_reason_text,
           pay.account_number,
           pay.bank_name,
           pay.account_holder_name
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
      join public.direct_entry_projects pr
        on pr.project_id = e.project_id
      join public.recruiters rc
        on rc.recruiter_id = e.recruiter_id
      left join public.collaborators c
        on c.collaborator_id = e.collaborator_id
      left join lateral (
        select ev.status, ev.leave_date, ev.leave_reason_text
          from public.direct_entry_employment_status_events ev
         where ev.entry_id = e.entry_id
         order by ev.version desc
         limit 1
      ) st on true
      left join public.direct_entry_payments pay
        on pay.entry_id = e.entry_id
     where e.deleted_at is null and e.voided_at is null
       and s.state = 'SUBMITTED'
       and (
         (v_scope = 'recruited' and e.recruiter_id = any(v_recruiter_ids))
         or (v_scope = 'managed' and e.project_id = any(v_project_ids))
         or (v_scope = 'team' and e.team_id = v_team_id)
         or (v_scope = 'all')
       )
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_recruiter_id is null or e.recruiter_id = p_recruiter_id)
       and (p_employment_status is null or st.status = p_employment_status)
       and (p_first_work_date_from is null or e.first_work_date >= p_first_work_date_from)
       and (p_first_work_date_to is null or e.first_work_date <= p_first_work_date_to)
       and (
         p_provider_type is null
         or (p_provider_type = 'hrp' and e.provider_type = 'hrp')
         or (p_provider_type = 'hrp_direct' and e.provider_type = 'hrp' and e.collaborator_id is null)
         or (p_provider_type = 'hrp_ctv' and e.provider_type = 'hrp' and e.collaborator_id is not null)
         or (p_provider_type = 'vendor' and e.provider_type = 'vendor')
       )
       and (p_labor_type is null or e.labor_type = p_labor_type)
       and (p_search is null
         or pg_catalog.strpos(pg_catalog.lower(coalesce(e.worker_details->>'display_name', '')), pg_catalog.lower(p_search)) > 0
         or pg_catalog.strpos(pg_catalog.lower(coalesce(e.employee_code, '')), pg_catalog.lower(p_search)) > 0)
  ),
  bounded as (
    select * from candidates
     order by first_work_date desc, entry_id desc
     limit 10001
  )
  select coalesce((select count(*)::int from bounded), 0),
         coalesce((
           select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'employee_code', b.employee_code,
             'display_name', b.worker_details->>'display_name',
             'date_of_birth', case
               when b.worker_details->'date_of_birth'->>'state' = 'provided'
               then b.worker_details->'date_of_birth'->>'value' else null end,
             'national_id', case
               when b.worker_details->'national_id'->>'state' = 'provided'
               then b.worker_details->'national_id'->>'value' else null end,
             'national_id_issued_at', case
               when b.worker_details->'national_id_issued_at'->>'state' = 'provided'
               then b.worker_details->'national_id_issued_at'->>'value' else null end,
             'phone', case
               when b.worker_details->'phone'->>'state' = 'provided'
               then b.worker_details->'phone'->>'value' else null end,
             'address', case
               when b.worker_details->'address'->>'state' = 'provided'
               then b.worker_details->'address'->>'value' else null end,
             'project_display', b.project_display,
             'first_work_date', pg_catalog.to_char(b.first_work_date, 'YYYY-MM-DD'),
             'labor_type_display', b.labor_type_display,
             'recruiter_display', b.recruiter_display,
             'provider_type', case
               when b.collaborator_id is not null then 'CTV'
               else public.recruitment_provider_type_display(b.provider_type)
             end,
             'collaborator_id', b.collaborator_id,
             'collaborator_display_name', b.collaborator_display_name,
             'employment_status', b.employment_status,
             'leave_date', case when b.leave_date is null then null
               else pg_catalog.to_char(b.leave_date, 'YYYY-MM-DD') end,
             'leave_reason', b.leave_reason_text,
             'account_number', b.account_number,
             'bank_name', b.bank_name,
             'account_holder_name', b.account_holder_name,
             'payment_note', null,
             'general_note', b.general_note
           ) order by b.first_work_date desc, b.entry_id desc)
           from bounded b
         ), '[]'::jsonb)
    into v_total, v_rows;

  v_filter_hash := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'scope', p_scope,
      'project_id', p_project_id,
      'recruiter_id', p_recruiter_id,
      'employment_status', p_employment_status
    ) || pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
      'search', p_search,
      'first_work_date_from', p_first_work_date_from,
      'first_work_date_to', p_first_work_date_to,
      'provider_type', p_provider_type,
      'labor_type', p_labor_type
    ))
  );
  v_scope_kind := case
    when p_scope = 'recruited' then 'own'
    when p_scope = 'managed' then 'project'
    when p_scope = 'team' then 'team'
    else 'all'
  end;

  if v_total > 10000 then
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, denial_code, reason_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'worker_export', null,
      'worker-export:' || p_scope || ':' || v_total::text || ':' || v_filter_hash,
      v_scope_kind, 'REJECTED', 'EXPORT_ROW_LIMIT_EXCEEDED', v_reason_id,
      array[]::text[]
    );
    return pg_catalog.jsonb_build_object('status', 'too_many_rows', 'limit', 10000);
  end if;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, denial_code, reason_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'worker_export', null,
    'worker-export:' || p_scope || ':' || v_total::text || ':' || v_filter_hash,
    v_scope_kind, 'ALLOW', null, v_reason_id, array[]::text[]
  );

  return pg_catalog.jsonb_build_object('status', 'ok', 'rows', v_rows);
end;
$function$;
revoke all on function public.direct_entry_export_workers(uuid, uuid, text, text, uuid, text, text, text, date, date, text, text) from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_export_workers(uuid, uuid, text, text, uuid, text, text, text, date, date, text, text) to service_role;


-- ---------------------------------------------------------------------------
-- 6. Owner / Definer / Search Path / ACL / Trigger Postcheck
-- ---------------------------------------------------------------------------
do $align_and_verify_collaborator_attribution$
declare
  v_service_rpcs text[] := array[
    'public.direct_entry_create_batch(uuid, uuid, jsonb, text)',
    'public.direct_entry_create_draft_row(uuid, uuid, uuid, integer, jsonb, text)',
    'public.direct_entry_create_full_profile_batch(uuid, uuid, text, jsonb, text)',
    'public.direct_entry_create_full_profile_batch_v2_unscoped_h03(uuid, uuid, text, jsonb, text)',
    'public.direct_entry_update_draft_row(uuid, uuid, uuid, integer, jsonb, text)',
    'public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text)',
    'public.direct_entry_create_change_request(uuid, uuid, jsonb, text, text)',
    'public.direct_entry_list_own_drafts(uuid, uuid)',
    'public.direct_entry_read_change_request(uuid, uuid, uuid)',
    'public.direct_entry_read_projection(uuid, uuid, uuid)',
    'public.direct_entry_export_workers(uuid, uuid, text, text, uuid, text, text, text, date, date, text, text)'
  ];
  v_internal_secdef_fns text[] := array[
    'public.direct_entry_entry_snapshot(uuid)',
    'public.worker_edit_history_snapshot(uuid)',
    'public.direct_entry_resolve_entry_collaborator_id(text, text, boolean)',
    'public.direct_entry_apply_change_item(uuid, uuid, uuid, public.direct_entries, text, jsonb, uuid)',
    'public.direct_entry_list_workers_search(text, uuid, uuid, text, text, uuid, text, text, integer, date, date, text, text)'
  ];
  v_trigger_fns text[] := array[
    'public.direct_entry_validate_new_entry()',
    'public.direct_entry_entry_version_guard()'
  ];
  v_sig text;
  v_oid oid;
  v_proc_owner oid;
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean := false;
  v_rec record;
  v_trg_def text;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entries'::pg_catalog.regclass;

  if v_base_owner is null or v_base_owner_oid is null then
    raise exception 'Collaborator attribution postcheck failed: base owner missing' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Collaborator attribution postcheck failed: missing service RPC %', v_sig using errcode = '55000';
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
      raise exception 'Collaborator attribution postcheck failed: definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'Collaborator attribution postcheck failed: RPC ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_secdef_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Collaborator attribution postcheck failed: missing internal fn %', v_sig using errcode = '55000';
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
      raise exception 'Collaborator attribution postcheck failed: internal definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'Collaborator attribution postcheck failed: internal ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_trigger_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Collaborator attribution postcheck failed: missing trigger fn %', v_sig using errcode = '55000';
    end if;
    select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_sig);

    select p.proconfig
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'Collaborator attribution postcheck failed: search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'Collaborator attribution postcheck failed: trigger ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  v_oid := pg_catalog.to_regprocedure('public.direct_entry_change_request_proposal_projection(text, jsonb, boolean, boolean, boolean)');
  if v_oid is null then
    raise exception 'Collaborator attribution postcheck failed: missing proposal projection fn' using errcode = '55000';
  end if;
  execute 'revoke all on function public.direct_entry_change_request_proposal_projection(text, jsonb, boolean, boolean, boolean) from public, anon, authenticated, service_role';

  select pg_catalog.pg_get_triggerdef(t.oid, true)
    into v_trg_def
    from pg_catalog.pg_trigger t
   where t.tgrelid = 'public.direct_entries'::pg_catalog.regclass
     and t.tgname = 'direct_entry_validate_identity'
     and not t.tgisinternal;

  if v_trg_def is null
     or pg_catalog.strpos(v_trg_def, 'vendor_id') = 0
     or pg_catalog.strpos(v_trg_def, 'collaborator_id') = 0 then
    raise exception 'Collaborator attribution postcheck failed: direct_entry_validate_identity trigger missing vendor_id/collaborator_id' using errcode = '55000';
  end if;
end
$align_and_verify_collaborator_attribution$;

commit;
