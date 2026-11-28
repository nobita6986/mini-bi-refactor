-- =============================================================================
-- Migration #259: Snapshot direct_entries.vendor_id & Use Snapshot in Monthly Report
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. Add nullable `vendor_id` FK (`public.vendors`) + consistency check +
--      partial reporting index on `public.direct_entries`.
--   2. Update `direct_entry_entry_snapshot(uuid)` and
--      `worker_edit_history_snapshot(uuid)` to capture `vendor_id` (and
--      `vendor_name` for worker edit history).
--   3. Update `direct_entry_validate_identity` trigger &
--      `direct_entry_validate_new_entry()` to enforce `vendor_id` invariants
--      on INSERT / source change, allow one-time historical backfill, and
--      preserve saved `vendor_id` on date/detail/project edits.
--   4. Add private helper `direct_entry__internal_resolve_recruiter_source` and
--      update all 6 direct-entry write RPCs (`create_batch`, `create_draft_row`,
--      `create_full_profile_batch`, `update_draft_row`, `privileged_edit`,
--      `apply_change_item`) to snapshot `vendor_id` and stop re-resolving
--      recruiter/vendor when `recruiter_id` is unchanged.
--   5. Run idempotent historical backfill (`UNIQUE_MATCH` only) with
--      `direct_entry_audit_events` logging and fail-closed conservation checks.
--   6. Update `direct_entry_vendor_referrer_monthly_report` to attribute
--      directly from `e.vendor_id` instead of looking up `rpm` at `first_work_date`.
--   7. Verify owner, SECURITY DEFINER, search_path, trigger, and exact ACLs.
-- =============================================================================

begin;

-- =============================================================================
-- SECTION 1: Schema & Index on public.direct_entries
-- =============================================================================

alter table public.direct_entries
  add column if not exists vendor_id text
  references public.vendors(vendor_id) on delete restrict;

alter table public.direct_entries
  drop constraint if exists direct_entries_vendor_id_consistency_check;

alter table public.direct_entries
  add constraint direct_entries_vendor_id_consistency_check check (
    (provider_type = 'hrp' and vendor_id is null)
    or (provider_type = 'vendor' and (vendor_id is null or vendor_id <> '__system_vendor__'))
  );

create index if not exists direct_entries_vendor_reporting_idx
  on public.direct_entries (vendor_id, first_work_date)
  where provider_type = 'vendor' and deleted_at is null and voided_at is null;

-- =============================================================================
-- SECTION 2: Revision Snapshots
-- =============================================================================

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
  left join public.direct_entry_payments p on p.entry_id = e.entry_id
  left join public.direct_entry_banks b on b.bank_id = p.bank_id
 where e.entry_id = p_entry_id;
$function$;

revoke all on function public.worker_edit_history_snapshot(uuid)
  from public, anon, authenticated, service_role;

-- =============================================================================
-- SECTION 3: Identity Trigger & Validation Function
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
  before insert or update of project_id, first_work_date, recruiter_id, team_id, provider_type, vendor_id
  on public.direct_entries
  for each row execute function public.direct_entry_validate_new_entry();

-- =============================================================================
-- SECTION 4: Recruiter Source Helper & All 6 Direct-Entry Write RPCs
-- =============================================================================

create or replace function public.direct_entry__internal_resolve_recruiter_source(
  p_recruiter_id uuid,
  p_errcode text default '42501',
  p_provider_err_msg text default 'provider membership denied',
  p_team_err_msg text default 'team membership denied'
)
returns table (
  provider_type text,
  team_id uuid,
  vendor_id text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth_date date := public.direct_entry_authorization_date();
  v_count integer;
  v_provider_type text;
  v_vendor_id text;
  v_team_id uuid;
begin
  if p_recruiter_id is null then
    raise exception '%', p_provider_err_msg using errcode = p_errcode;
  end if;

  select count(*), min(m.provider_type), min(m.vendor_id)
    into v_count, v_provider_type, v_vendor_id
    from public.recruiter_provider_memberships m
   where m.recruiter_id = p_recruiter_id
     and public.direct_entry__internal_recruiter_provider_membership_effective(
       m.membership_id, v_auth_date
     );

  if v_count <> 1 then
    raise exception '%', p_provider_err_msg using errcode = p_errcode;
  end if;

  if v_provider_type = 'vendor' then
    if v_vendor_id is null
       or v_vendor_id = '__system_vendor__'
       or not exists (
         select 1 from public.vendors v
          where v.vendor_id = v_vendor_id and v.active
       ) then
      raise exception 'provider vendor_id invalid' using errcode = '23514';
    end if;
    v_team_id := public.direct_entry_system_vendor_team_id();
    return query select v_provider_type, v_team_id, v_vendor_id;
    return;
  end if;

  select count(*), (array_agg(m.team_id))[1]
    into v_count, v_team_id
    from public.recruiter_team_memberships m
   where m.recruiter_id = p_recruiter_id
     and public.direct_entry__internal_recruiter_team_membership_effective(
       m.membership_id, v_auth_date
     );

  if v_count <> 1 then
    raise exception '%', p_team_err_msg using errcode = p_errcode;
  end if;

  return query select v_provider_type, v_team_id, null::text;
end;
$function$;

revoke all on function public.direct_entry__internal_resolve_recruiter_source(uuid, text, text, text)
  from public, anon, authenticated, service_role;

-- 4.1 direct_entry_create_batch
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
    if (v_row - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'])
       <> '{}'::jsonb then
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
    insert into public.direct_entry_candidates default values returning candidate_id into v_candidate_id;
    insert into public.direct_entries (
      submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
      employee_code, worker_details, recruiter_id, team_id, provider_type, vendor_id, labor_type
    ) values (
      v_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
      v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type, v_vendor_id, v_labor_type
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

-- 4.2 direct_entry_create_draft_row
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
     or (p_row - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type'])
        <> '{}'::jsonb then
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
  insert into public.direct_entry_candidates default values returning candidate_id into v_candidate_id;
  insert into public.direct_entries (
    submission_id, candidate_id, created_by_user_id, project_id, first_work_date,
    employee_code, worker_details, recruiter_id, team_id, provider_type, vendor_id, labor_type
  ) values (
    p_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
    v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type, v_vendor_id, v_labor_type
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

-- 4.3 direct_entry_create_full_profile_batch
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
         'project_id','first_work_date','employee_code','recruiter_id','labor_type',
         'display_name','worker_details','general_note','payment','employment'
       ] <> '{}'::jsonb then
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
      employee_code, worker_details, recruiter_id, team_id, provider_type, vendor_id, labor_type,
      general_note
    ) values (
      v_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
      v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type, v_vendor_id,
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

-- 4.4 direct_entry_update_draft_row
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
  v_count integer;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb
     or public.direct_entry_contains_authority(p_patch)
     or exists (
       select 1 from jsonb_object_keys(p_patch) as patch_key(key)
        where patch_key.key not in (
          'project_id', 'first_work_date', 'employee_code', 'worker_details',
          'recruiter_id', 'labor_type', 'general_note', 'payment'
        )
     ) then
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
                        'recruiter_id','labor_type','employment_status','payment']) <> '{}'::jsonb then
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
  select array_agg(key order by key) into v_fields from jsonb_object_keys(p_patch) key;
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

-- 4.6 direct_entry_apply_change_item
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
    if (p_proposal - array['project_id','first_work_date','employee_code','worker_details','recruiter_id','labor_type']) <> '{}'::jsonb
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

-- =============================================================================
-- SECTION 5: Safe Idempotent Historical Backfill (version-preserving)
-- =============================================================================

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
    and new.void_reason_id is not distinct from old.void_reason_id;

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

do $backfill_vendor_entry_snapshots$
declare
  v_before_submitted_turns integer := 0;
  v_after_submitted_turns integer := 0;
  v_bad_hrp_vendor_count integer := 0;
  v_bad_system_vendor_count integer := 0;
  v_backfilled_count integer := 0;
  v_version_drift_count integer := 0;
  v_after_version integer := null;
  v_row record;
begin
  select count(*)::integer
    into v_before_submitted_turns
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
   where e.deleted_at is null
     and e.voided_at is null
     and e.provider_type = 'vendor'
     and s.state = 'SUBMITTED';

  for v_row in
    with pending_vendor_entries as (
      select e.entry_id, e.recruiter_id, e.created_at, e.version
        from public.direct_entries e
       where e.provider_type = 'vendor'
         and e.vendor_id is null
       order by e.entry_id asc
    ),
    rev_state as (
      select
        p.entry_id,
        p.recruiter_id,
        p.created_at,
        p.version,
        exists (
          select 1
            from public.direct_entry_revisions rev
           where rev.entry_id = p.entry_id
        ) as has_any_revisions,
        exists (
          select 1
            from public.direct_entry_revisions rev
           where rev.entry_id = p.entry_id
             and (
               rev.after_snapshot->>'recruiter_id' is distinct from p.recruiter_id::text
               or rev.after_snapshot->>'provider_type' is distinct from 'vendor'
               or (
                 rev.before_snapshot is not null
                 and (
                   rev.before_snapshot->>'recruiter_id' is distinct from p.recruiter_id::text
                   or rev.before_snapshot->>'provider_type' is distinct from 'vendor'
                 )
               )
             )
        ) as has_disagreeing_rev,
        latest.after_snapshot as latest_after_snapshot,
        src.created_at as src_created_at
      from pending_vendor_entries p
      left join lateral (
        select rev.after_snapshot
          from public.direct_entry_revisions rev
         where rev.entry_id = p.entry_id
         order by rev.version desc, rev.created_at desc, rev.revision_id desc
         limit 1
      ) latest on true
      left join lateral (
        select rev.created_at
          from public.direct_entry_revisions rev
         where rev.entry_id = p.entry_id
           and rev.after_snapshot->>'recruiter_id' = p.recruiter_id::text
           and rev.after_snapshot->>'provider_type' = 'vendor'
           and (
             rev.before_snapshot is null
             or rev.before_snapshot->>'recruiter_id' is distinct from rev.after_snapshot->>'recruiter_id'
             or rev.before_snapshot->>'provider_type' is distinct from rev.after_snapshot->>'provider_type'
           )
         order by rev.version desc, rev.created_at desc, rev.revision_id desc
         limit 1
      ) src on true
    ),
    source_timed as (
      select
        rs.entry_id,
        rs.recruiter_id,
        rs.version,
        (
          rs.has_any_revisions
          and (
            rs.latest_after_snapshot->>'recruiter_id' is distinct from rs.recruiter_id::text
            or rs.latest_after_snapshot->>'provider_type' is distinct from 'vendor'
            or (rs.src_created_at is null and rs.has_disagreeing_rev)
          )
        ) as has_revision_conflict,
        case
          when not rs.has_any_revisions then rs.created_at
          when rs.src_created_at is not null
           and rs.latest_after_snapshot->>'recruiter_id' is not distinct from rs.recruiter_id::text
           and rs.latest_after_snapshot->>'provider_type' is not distinct from 'vendor'
            then rs.src_created_at
          when rs.src_created_at is null
           and not rs.has_disagreeing_rev
           and rs.latest_after_snapshot->>'recruiter_id' is not distinct from rs.recruiter_id::text
           and rs.latest_after_snapshot->>'provider_type' is not distinct from 'vendor'
            then rs.created_at
          else null
        end as source_recorded_at
      from rev_state rs
    ),
    classified as (
      select
        st.entry_id,
        st.version,
        st.has_revision_conflict,
        st.source_recorded_at,
        (st.source_recorded_at at time zone 'Asia/Ho_Chi_Minh')::date as source_vn_date,
        exists (
          select 1
            from public.recruiter_provider_memberships rpm_hrp
           where st.source_recorded_at is not null
             and rpm_hrp.recruiter_id = st.recruiter_id
             and rpm_hrp.provider_type = 'hrp'
             and rpm_hrp.valid_from <= (st.source_recorded_at at time zone 'Asia/Ho_Chi_Minh')::date
             and (
               rpm_hrp.valid_to is null
               or (st.source_recorded_at at time zone 'Asia/Ho_Chi_Minh')::date < rpm_hrp.valid_to
             )
             and (rpm_hrp.valid_to is null or rpm_hrp.valid_to > rpm_hrp.valid_from)
             and rpm_hrp.created_at <= st.source_recorded_at
        ) as has_hrp_conflict,
        coalesce((
          select count(distinct rpm.vendor_id)::integer
            from public.recruiter_provider_memberships rpm
            join public.vendors v
              on v.vendor_id = rpm.vendor_id
           where st.source_recorded_at is not null
             and rpm.recruiter_id = st.recruiter_id
             and rpm.provider_type = 'vendor'
             and rpm.vendor_id is not null
             and rpm.vendor_id <> '__system_vendor__'
             and rpm.valid_from <= (st.source_recorded_at at time zone 'Asia/Ho_Chi_Minh')::date
             and (
               rpm.valid_to is null
               or (st.source_recorded_at at time zone 'Asia/Ho_Chi_Minh')::date < rpm.valid_to
             )
             and (rpm.valid_to is null or rpm.valid_to > rpm.valid_from)
             and rpm.created_at <= st.source_recorded_at
        ), 0) as matched_vendor_count,
        (
          select min(rpm.vendor_id)
            from public.recruiter_provider_memberships rpm
            join public.vendors v
              on v.vendor_id = rpm.vendor_id
           where st.source_recorded_at is not null
             and rpm.recruiter_id = st.recruiter_id
             and rpm.provider_type = 'vendor'
             and rpm.vendor_id is not null
             and rpm.vendor_id <> '__system_vendor__'
             and rpm.valid_from <= (st.source_recorded_at at time zone 'Asia/Ho_Chi_Minh')::date
             and (
               rpm.valid_to is null
               or (st.source_recorded_at at time zone 'Asia/Ho_Chi_Minh')::date < rpm.valid_to
             )
             and (rpm.valid_to is null or rpm.valid_to > rpm.valid_from)
             and rpm.created_at <= st.source_recorded_at
        ) as matched_vendor_id
      from source_timed st
    )
    select c.entry_id, c.version, c.matched_vendor_id
      from classified c
     where not c.has_revision_conflict
       and not c.has_hrp_conflict
       and c.matched_vendor_count = 1
       and c.matched_vendor_id is not null
     order by c.entry_id asc
  loop
    update public.direct_entries e
       set vendor_id = v_row.matched_vendor_id
     where e.entry_id = v_row.entry_id
       and e.provider_type = 'vendor'
       and e.vendor_id is null
    returning e.version into v_after_version;

    if found then
      v_backfilled_count := v_backfilled_count + 1;
      if v_after_version is distinct from v_row.version then
        v_version_drift_count := v_version_drift_count + 1;
      end if;
      insert into public.direct_entry_audit_events (
        auth_subject,
        app_user_id,
        action,
        capability,
        resource_ref,
        scope_kind,
        scope_team_id,
        outcome,
        reason_id,
        changed_fields
      ) values (
        null,
        null,
        'vendor_entry_snapshot_backfill',
        null,
        v_row.entry_id::text,
        null,
        null,
        'APPLIED',
        null,
        array['vendor_id']
      );
    end if;
  end loop;

  select count(*)::integer
    into v_after_submitted_turns
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
   where e.deleted_at is null
     and e.voided_at is null
     and e.provider_type = 'vendor'
     and s.state = 'SUBMITTED';

  if v_after_submitted_turns <> v_before_submitted_turns then
    raise exception 'Vendor snapshot backfill postcheck failed: submitted turns changed from % to %',
      v_before_submitted_turns, v_after_submitted_turns
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_bad_hrp_vendor_count
    from public.direct_entries e
   where e.provider_type = 'hrp'
     and e.vendor_id is not null;

  if v_bad_hrp_vendor_count <> 0 then
    raise exception 'Vendor snapshot backfill postcheck failed: % HRP rows have non-null vendor_id',
      v_bad_hrp_vendor_count
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_bad_system_vendor_count
    from public.direct_entries e
   where e.vendor_id = '__system_vendor__';

  if v_version_drift_count <> 0 then
    raise exception 'Vendor snapshot backfill postcheck failed: % backfilled rows drifted from latest revision version',
      v_version_drift_count
      using errcode = '55000';
  end if;

  if v_bad_system_vendor_count <> 0 then
    raise exception 'Vendor snapshot backfill postcheck failed: % rows have __system_vendor__',
      v_bad_system_vendor_count
      using errcode = '55000';
  end if;
end
$backfill_vendor_entry_snapshots$;

-- =============================================================================
-- SECTION 6: Update Monthly Report RPC to Use direct_entries.vendor_id Snapshot
-- =============================================================================

create or replace function public.direct_entry_vendor_referrer_monthly_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_month text default null,
  p_referrer_person_id uuid default null,
  p_vendor_id text default null,
  p_project_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_month text;
  v_period_from date := null;
  v_period_to date := null;
  v_vendor_id text := null;
  v_project_id text := null;
  v_reconciliation jsonb;
  v_filtered_summary jsonb;
  v_by_referrer jsonb;
  v_rows jsonb;
  v_unassigned_vendors jsonb;
  v_unresolved_vendor_breakdown jsonb;
  v_filter_options jsonb;
begin
  perform public.direct_entry_vendor_referrer__internal_assert_bod_actor(
    p_auth_subject, p_app_user_id, v_now
  );

  if p_month is null or nullif(pg_catalog.btrim(p_month), '') is null then
    v_month := pg_catalog.to_char(v_today, 'YYYY-MM');
  else
    v_month := pg_catalog.btrim(p_month);
    if pg_catalog.upper(v_month) = 'ALL' then
      v_month := 'ALL';
    elsif v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception 'VENDOR_REFERRER_MONTH_INVALID' using errcode = '22023';
    end if;
  end if;

  if v_month <> 'ALL' then
    v_period_from := pg_catalog.to_date(v_month || '-01', 'YYYY-MM-DD');
    v_period_to := (v_period_from + interval '1 month' - interval '1 day')::date;
  end if;

  if p_vendor_id is not null then
    v_vendor_id := nullif(pg_catalog.btrim(p_vendor_id), '');
    if v_vendor_id is not null and (
      v_vendor_id = '__system_vendor__'
      or v_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'
    ) then
      raise exception 'VENDOR_REFERRER_VENDOR_INVALID' using errcode = '22023';
    end if;
  end if;

  if p_project_id is not null then
    v_project_id := nullif(pg_catalog.btrim(p_project_id), '');
    if v_project_id is not null and v_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
      raise exception 'VENDOR_REFERRER_PROJECT_INVALID' using errcode = '22023';
    end if;
  end if;

  with all_vendor_turns as (
    select
      e.entry_id,
      e.first_work_date,
      e.project_id,
      p.display_name as project_display_name,
      e.recruiter_id,
      r.display_name as recruiter_display_name,
      v.vendor_id,
      v.display_name as vendor_display_name,
      vrl.link_id as referrer_link_id,
      vrl.referrer_person_id,
      rp.employee_code as referrer_employee_code,
      rp.full_name as referrer_full_name,
      rd.name as referrer_department_name
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
    join public.direct_entry_projects p
      on p.project_id = e.project_id
    join public.recruiters r
      on r.recruiter_id = e.recruiter_id
    left join public.vendors v
      on v.vendor_id = e.vendor_id
     and v.vendor_id <> '__system_vendor__'
    left join public.vendor_referrer_links vrl
      on vrl.vendor_id = v.vendor_id
     and vrl.effective_from <= e.first_work_date
     and (vrl.effective_to is null or e.first_work_date < vrl.effective_to)
    left join public.organization_persons rp
      on rp.person_id = vrl.referrer_person_id
    left join public.organization_person_department_memberships rdm
      on rdm.person_id = rp.person_id
     and rdm.ended_at is null
    left join public.organization_departments rd
      on rd.department_id = rdm.department_id
   where e.deleted_at is null
     and e.voided_at is null
     and e.provider_type = 'vendor'
     and s.state = 'SUBMITTED'
     and (
       v_period_from is null
       or (e.first_work_date >= v_period_from and e.first_work_date <= v_period_to)
     )
  ),
  filtered_attributed as (
    select t.*
      from all_vendor_turns t
     where t.vendor_id is not null
       and t.referrer_link_id is not null
       and (p_referrer_person_id is null or t.referrer_person_id = p_referrer_person_id)
       and (v_vendor_id is null or t.vendor_id = v_vendor_id)
       and (v_project_id is null or t.project_id = v_project_id)
  ),
  reconciliation_agg as (
    select
      count(*)::integer as total_vendor_turns,
      count(*) filter (where t.vendor_id is not null)::integer as matched_vendor_turns,
      count(*) filter (where t.vendor_id is not null and t.referrer_link_id is not null)::integer as attributed_turns,
      count(*) filter (where t.vendor_id is not null and t.referrer_link_id is null)::integer as unassigned_vendor_turns,
      count(*) filter (where t.vendor_id is null)::integer as unresolved_vendor_turns
    from all_vendor_turns t
  ),
  filtered_agg as (
    select
      count(*)::integer as attributed_turns,
      count(distinct f.referrer_person_id)::integer as referrer_count,
      count(distinct f.vendor_id)::integer as vendor_count,
      count(distinct f.project_id)::integer as project_count
    from filtered_attributed f
  ),
  referrer_rollup as (
    select
      f.referrer_person_id,
      f.referrer_employee_code,
      f.referrer_full_name,
      f.referrer_department_name,
      count(*)::integer as turns,
      count(distinct f.vendor_id)::integer as vendor_count,
      count(distinct f.project_id)::integer as project_count
    from filtered_attributed f
    group by
      f.referrer_person_id,
      f.referrer_employee_code,
      f.referrer_full_name,
      f.referrer_department_name
  ),
  matrix_rollup as (
    select
      f.referrer_person_id,
      f.referrer_employee_code,
      f.referrer_full_name,
      f.referrer_department_name,
      f.vendor_id,
      f.vendor_display_name,
      f.project_id,
      f.project_display_name,
      count(*)::integer as turns
    from filtered_attributed f
    group by
      f.referrer_person_id,
      f.referrer_employee_code,
      f.referrer_full_name,
      f.referrer_department_name,
      f.vendor_id,
      f.vendor_display_name,
      f.project_id,
      f.project_display_name
  ),
  unassigned_rollup as (
    select
      t.vendor_id,
      t.vendor_display_name,
      count(*)::integer as turns,
      count(distinct t.project_id)::integer as project_count
    from all_vendor_turns t
    where t.vendor_id is not null
      and t.referrer_link_id is null
    group by t.vendor_id, t.vendor_display_name
  ),
  unresolved_rollup as (
    select
      t.recruiter_id,
      t.recruiter_display_name,
      t.project_id,
      t.project_display_name,
      count(*)::integer as turns
    from all_vendor_turns t
    where t.vendor_id is null
    group by
      t.recruiter_id,
      t.recruiter_display_name,
      t.project_id,
      t.project_display_name
  ),
  opt_referrers as (
    select distinct
      t.referrer_person_id as person_id,
      t.referrer_employee_code as employee_code,
      t.referrer_full_name as full_name,
      t.referrer_department_name as department_name
    from all_vendor_turns t
    where t.vendor_id is not null
      and t.referrer_link_id is not null
  ),
  opt_vendors as (
    select distinct
      t.vendor_id,
      t.vendor_display_name as display_name
    from all_vendor_turns t
    where t.vendor_id is not null
  ),
  opt_projects as (
    select distinct
      t.project_id,
      t.project_display_name as display_name
    from all_vendor_turns t
  )
  select
    pg_catalog.jsonb_build_object(
      'total_vendor_turns', r.total_vendor_turns,
      'matched_vendor_turns', r.matched_vendor_turns,
      'attributed_turns', r.attributed_turns,
      'unassigned_vendor_turns', r.unassigned_vendor_turns,
      'unresolved_vendor_turns', r.unresolved_vendor_turns
    ),
    pg_catalog.jsonb_build_object(
      'attributed_turns', fa.attributed_turns,
      'referrer_count', fa.referrer_count,
      'vendor_count', fa.vendor_count,
      'project_count', fa.project_count
    ),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'referrer_person_id', rr.referrer_person_id,
          'referrer_employee_code', rr.referrer_employee_code,
          'referrer_full_name', rr.referrer_full_name,
          'referrer_department_name', rr.referrer_department_name,
          'turns', rr.turns,
          'vendor_count', rr.vendor_count,
          'project_count', rr.project_count
        )
        order by rr.turns desc, pg_catalog.lower(rr.referrer_full_name) asc, rr.referrer_person_id asc
      )
        from referrer_rollup rr
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'referrer_person_id', mr.referrer_person_id,
          'referrer_employee_code', mr.referrer_employee_code,
          'referrer_full_name', mr.referrer_full_name,
          'referrer_department_name', mr.referrer_department_name,
          'vendor_id', mr.vendor_id,
          'vendor_display_name', mr.vendor_display_name,
          'project_id', mr.project_id,
          'project_display_name', mr.project_display_name,
          'turns', mr.turns
        )
        order by
          mr.turns desc,
          pg_catalog.lower(mr.referrer_full_name) asc,
          pg_catalog.lower(mr.vendor_display_name) asc,
          pg_catalog.lower(mr.project_display_name) asc,
          mr.vendor_id asc,
          mr.project_id asc
      )
        from matrix_rollup mr
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'vendor_id', ur.vendor_id,
          'vendor_display_name', ur.vendor_display_name,
          'turns', ur.turns,
          'project_count', ur.project_count
        )
        order by ur.turns desc, pg_catalog.lower(ur.vendor_display_name) asc, ur.vendor_id asc
      )
        from unassigned_rollup ur
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recruiter_id', uvr.recruiter_id,
          'recruiter_display_name', uvr.recruiter_display_name,
          'project_id', uvr.project_id,
          'project_display_name', uvr.project_display_name,
          'turns', uvr.turns
        )
        order by uvr.turns desc, pg_catalog.lower(uvr.recruiter_display_name) asc, uvr.project_id asc
      )
        from unresolved_rollup uvr
    ), '[]'::jsonb),
    pg_catalog.jsonb_build_object(
      'referrers', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'person_id', oref.person_id,
            'employee_code', oref.employee_code,
            'full_name', oref.full_name,
            'department_name', oref.department_name
          )
          order by pg_catalog.lower(oref.full_name) asc, oref.person_id asc
        )
          from opt_referrers oref
      ), '[]'::jsonb),
      'vendors', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'vendor_id', ov.vendor_id,
            'display_name', ov.display_name
          )
          order by pg_catalog.lower(ov.display_name) asc, ov.vendor_id asc
        )
          from opt_vendors ov
      ), '[]'::jsonb),
      'projects', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'project_id', op.project_id,
            'display_name', op.display_name
          )
          order by pg_catalog.lower(op.display_name) asc, op.project_id asc
        )
          from opt_projects op
      ), '[]'::jsonb)
    )
    into
      v_reconciliation,
      v_filtered_summary,
      v_by_referrer,
      v_rows,
      v_unassigned_vendors,
      v_unresolved_vendor_breakdown,
      v_filter_options
    from reconciliation_agg r
    cross join filtered_agg fa;

  return pg_catalog.jsonb_build_object(
    'month', v_month,
    'period_from', case when v_period_from is null then null else v_period_from::text end,
    'period_to', case when v_period_to is null then null else v_period_to::text end,
    'authorization_date', v_today::text,
    'reconciliation', v_reconciliation,
    'filtered_summary', v_filtered_summary,
    'by_referrer', v_by_referrer,
    'rows', v_rows,
    'unassigned_vendors', v_unassigned_vendors,
    'unresolved_vendor_breakdown', v_unresolved_vendor_breakdown,
    'filter_options', v_filter_options
  );
end;
$function$;

revoke all on function public.direct_entry_vendor_referrer_monthly_report(uuid, uuid, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_vendor_referrer_monthly_report(uuid, uuid, text, uuid, text, text)
  to service_role;

-- =============================================================================
-- SECTION 7: Owner Alignment & Strict Security/ACL/Trigger Postcheck
-- =============================================================================

do $align_and_verify_vendor_snapshot$
declare
  v_service_rpcs text[] := array[
    'public.direct_entry_create_batch(uuid, uuid, jsonb, text)',
    'public.direct_entry_create_full_profile_batch(uuid, uuid, text, jsonb, text)',
    'public.direct_entry_privileged_edit(uuid, uuid, uuid, integer, jsonb, text, text)',
    'public.direct_entry_vendor_referrer_monthly_report(uuid, uuid, text, uuid, text, text)'
  ];
  v_internal_secdef_fns text[] := array[
    'public.direct_entry_entry_snapshot(uuid)',
    'public.worker_edit_history_snapshot(uuid)',
    'public.direct_entry__internal_resolve_recruiter_source(uuid, text, text, text)',
    'public.direct_entry_create_draft_row(uuid, uuid, uuid, integer, jsonb, text)',
    'public.direct_entry_update_draft_row(uuid, uuid, uuid, integer, jsonb, text)',
    'public.direct_entry_apply_change_item(uuid, uuid, uuid, public.direct_entries, text, jsonb, uuid)'
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
    raise exception 'Vendor snapshot alignment failed: base owner missing' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Vendor snapshot postcheck failed: missing service RPC %', v_sig using errcode = '55000';
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
      raise exception 'Vendor snapshot postcheck failed: definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'Vendor snapshot postcheck failed: RPC ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_secdef_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Vendor snapshot postcheck failed: missing internal fn %', v_sig using errcode = '55000';
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
      raise exception 'Vendor snapshot postcheck failed: internal definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'Vendor snapshot postcheck failed: internal ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_trigger_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Vendor snapshot postcheck failed: missing trigger fn %', v_sig using errcode = '55000';
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
      raise exception 'Vendor snapshot postcheck failed: search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'Vendor snapshot postcheck failed: trigger ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  select pg_catalog.pg_get_triggerdef(t.oid, true)
    into v_trg_def
    from pg_catalog.pg_trigger t
   where t.tgrelid = 'public.direct_entries'::pg_catalog.regclass
     and t.tgname = 'direct_entry_validate_identity'
     and not t.tgisinternal;

  if v_trg_def is null or pg_catalog.strpos(v_trg_def, 'vendor_id') = 0 then
    raise exception 'Vendor snapshot postcheck failed: direct_entry_validate_identity trigger missing vendor_id' using errcode = '55000';
  end if;
end
$align_and_verify_vendor_snapshot$;

commit;
