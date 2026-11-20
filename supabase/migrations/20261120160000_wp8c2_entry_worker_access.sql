-- WP8C-2: Migrate remaining Direct Entry / Worker / Document / Portrait / CCCD /
-- Duplicate CCCD / Change Request SQL authorization guards to WP5 paired effective
-- access (`direct_entry_authz__internal_has_paired_capability` /
-- `direct_entry_authz__internal_resolve_effective_grants`).
--
-- Scope & Parallel Ownership Boundaries:
--   - Append-only migration #230; zero new service_role RPCs (keeps exact 337
--     service_role RPCs, zero client/PUBLIC EXECUTE).
--   - Does NOT redefine T1B-owned functions (`direct_entry_resolve_actor_context`,
--     `direct_entry_authz__internal_resolve_effective_grants`, or any `work_report_*`).
--   - Preserves pre-cutover (`authz_managed = false`) R1 compatibility branches and
--     all post-R1 patches (`PT409` SQLSTATE, optional reasons, `worker-profile/1.2`,
--     `created_at`/`created_by`, effective recruiter membership intervals, and
--     `direct_entry_catalog_bootstrap_executor` ownership).
--   - Zero literal at-sign characters, zero SAVEPOINT, zero ALTER DEFAULT PRIVILEGES.

begin;

-- =============================================================================
-- SECTION 1: Draft / Create / Catalog / Submission / Read Projection
-- =============================================================================

create or replace function public.direct_entry_assert_draft_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_resource_scope_date date,
  p_required_scope text default null::text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_canonical_tl_team_id uuid := null;
  v_scope text;
  v_capability text;
  v_matches integer;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
    v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);

    if p_team_id is not null and exists (
      select 1
        from pg_catalog.jsonb_to_recordset(v_grants) as g(
          capability text,
          scope_kind text,
          scope_id text,
          source_type text
        )
       where g.capability = 'entry_team'
         and g.scope_kind = 'CONTEXT_TEAM'
         and g.scope_id = p_team_id::text
         and g.source_type = 'CONTEXTUAL_ASSIGNMENT'
    ) then
      begin
        v_canonical_tl_team_id := public.direct_entry_assert_team_leader_current_team(
          p_auth_subject, p_app_user_id, p_team_id
        );
      exception when insufficient_privilege then
        v_canonical_tl_team_id := null;
      end;
    end if;

    select count(*)::integer, min(matched.legacy_scope)
      into v_matches, v_scope
      from (
        select case
                 when g.capability = 'entry_admin'
                      and g.scope_kind = 'ALL'
                      and g.scope_id is null
                   then 'all'
                 when g.capability = 'entry_own'
                      and g.scope_kind = 'OWN'
                      and g.scope_id is null
                      and p_entry_owner = p_app_user_id
                   then 'own'
                 when g.capability = 'entry_team'
                      and g.scope_kind = 'CONTEXT_TEAM'
                      and p_team_id is not null
                      and g.scope_id = p_team_id::text
                      and (
                        g.source_type is distinct from 'CONTEXTUAL_ASSIGNMENT'
                        or v_canonical_tl_team_id = p_team_id
                      )
                      and exists (
                        select 1
                          from public.teams t
                         where t.team_id = p_team_id
                           and t.active
                           and t.code <> '__system_vendor__'
                      )
                   then 'team'
                 else null
               end as legacy_scope
          from pg_catalog.jsonb_to_recordset(v_grants) as g(
            capability text,
            scope_kind text,
            scope_id text,
            source_type text
          )
      ) matched
     where matched.legacy_scope is not null
       and (p_required_scope is null or matched.legacy_scope = p_required_scope);

    if v_matches = 0 or v_scope is null then
      raise exception 'draft scope/capability denied' using errcode = '42501';
    end if;
    return v_scope;
  end if;

  -- Pre-cutover (`authz_managed = false`) R1 compatibility path.
  select count(*)::integer, min(g.scope_kind)
    into v_matches, v_scope
    from public.direct_entry_scope_grants g
    join public.direct_entry_capability_grants c
      on c.app_user_id = g.app_user_id
     and c.is_current
     and c.capability = case g.scope_kind
       when 'own' then 'entry_own'
       when 'team' then 'entry_team'
       else 'entry_admin'
     end
   where g.app_user_id = p_app_user_id
     and g.is_current
     and (
       g.scope_kind <> 'team'
       or exists (select 1 from public.teams t where t.team_id = g.team_id and t.active)
     )
     and (
       (g.scope_kind = 'own' and p_entry_owner = p_app_user_id)
       or (g.scope_kind = 'team' and g.team_id = p_team_id)
       or g.scope_kind = 'all'
     )
     and (p_required_scope is null or g.scope_kind = p_required_scope);
  if v_matches = 0 then
    raise exception 'draft scope/capability denied' using errcode = '42501';
  end if;
  v_capability := case v_scope
    when 'own' then 'entry_own'
    when 'team' then 'entry_team'
    else 'entry_admin'
  end;
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, v_capability);
  return v_scope;
end;
$function$;

create or replace function public.direct_entry_create_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_first_work_date date default null::date
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if p_project_id is not null
     and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    return 'manager';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    if (
         public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_create', 'OWN', null)
         or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_create', 'ALL', null)
       )
       and (
         public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
         or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null)
       ) then
      return 'legacy';
    end if;
    raise exception 'worker create authority denied' using errcode = '42501';
  end if;

  if public.direct_entry_has_capability(p_app_user_id, 'entry_create')
     and public.direct_entry_has_capability(p_app_user_id, 'submission_create')
     and public.direct_entry_has_scope(p_app_user_id, 'own') then
    return 'legacy';
  end if;
  raise exception 'worker create authority denied' using errcode = '42501';
end;
$function$;

create or replace function public.direct_entry_input_catalog_unscoped_v42(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_effective_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_result jsonb;
begin
  if p_effective_date is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor capability denied' using errcode = '42501';
  end if;

  if v_authz_managed then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_create', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_create', 'ALL', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_own', 'OWN', null)
    ) then
      raise exception 'actor capability denied' using errcode = '42501';
    end if;
  elsif not exists (
    select 1
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability in ('entry_create', 'entry_own')
       and g.is_current
  ) then
    raise exception 'actor capability denied' using errcode = '42501';
  end if;

  with hrp_memberships as (
    select m.recruiter_id, count(*) as membership_count
      from public.recruiter_provider_memberships m
     where m.provider_type = 'hrp'
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date)
     group by m.recruiter_id
  ), vendor_memberships as (
    select m.recruiter_id, m.vendor_id
      from public.recruiter_provider_memberships m
     where m.provider_type = 'vendor'
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date)
  ), hrp_teams as (
    select m.recruiter_id, count(*) as membership_count,
           min(m.team_id::text)::uuid as team_id
      from public.recruiter_team_memberships m
     where public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, p_effective_date)
     group by m.recruiter_id
  ), hrp_recruiters as (
    select r.recruiter_id, r.display_name, r.personnel_code, tt.team_id,
           team.display_name as team_display_name
      from public.recruiters r
      join hrp_memberships p on p.recruiter_id = r.recruiter_id
                            and p.membership_count = 1
      join hrp_teams tt on tt.recruiter_id = r.recruiter_id
                        and tt.membership_count = 1
      join public.teams team on team.team_id = tt.team_id and team.active
     where r.active
  ), vendor_recruiters as (
    select r.recruiter_id, r.display_name, vm.vendor_id,
           v.display_name as vendor_display_name
      from public.recruiters r
      join vendor_memberships vm on vm.recruiter_id = r.recruiter_id
      left join public.vendors v on v.vendor_id = vm.vendor_id and v.active
     where r.active
       and (vm.vendor_id is null or v.vendor_id is not null)
  )
  select jsonb_build_object(
    'effective_date', p_effective_date,
    'labor_types', public.direct_entry_labor_type_options(),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'project_id', p.project_id, 'display_name', p.display_name
      ) order by p.display_name, p.project_id)
        from public.direct_entry_projects p
       where p.active
    ), '[]'::jsonb),
    'recruiters', coalesce((
      select coalesce(jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', r.display_name,
        'personnel_code', r.personnel_code,
        'provider_type', 'hrp',
        'vendor_id', null,
        'team_id', r.team_id,
        'team_display_name', r.team_display_name,
        'label', (
          r.display_name
          || ' · ' || coalesce(r.personnel_code, '—')
          || ' · ' || r.team_display_name
        )
      ) order by r.display_name, r.team_display_name, r.recruiter_id), '[]'::jsonb)
        from hrp_recruiters r
    ) || coalesce((
      select jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', coalesce(r.vendor_display_name, r.display_name),
        'personnel_code', null,
        'provider_type', 'vendor',
        'vendor_id', r.vendor_id,
        'team_id', null,
        'team_display_name', null,
        'label', coalesce(r.vendor_display_name, r.display_name)
      ) order by coalesce(r.vendor_display_name, r.display_name), r.recruiter_id)
        from vendor_recruiters r
    ), '[]'::jsonb), '[]'::jsonb),
    'banks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bank_id', b.bank_id, 'display_name', b.display_name
      ) order by b.display_name, b.bank_id)
        from public.direct_entry_banks b
       where b.active
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

create or replace function public.direct_entry_list_own_drafts(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
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

  if coalesce(v_authz_managed, false) then
    v_employment_apply :=
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'employment_status.apply', 'ALL', null);
  else
    v_employment_apply := exists (
      select 1 from public.direct_entry_capability_grants g
       where g.app_user_id = p_app_user_id
         and g.capability = 'employment_status.apply'
         and g.is_current
    );
  end if;

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
           t.display_name as team_display_name
      from public.direct_entries e
      join public.direct_entry_submissions s on s.submission_id = e.submission_id
      join public.direct_entry_projects p on p.project_id = e.project_id
      join public.recruiters r on r.recruiter_id = e.recruiter_id
      join public.teams t on t.team_id = e.team_id
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

create or replace function public.direct_entry_delete_draft_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_submission public.direct_entry_submissions%rowtype;
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_own_scope_count integer;
  v_prior jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_submission_revision_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_deleted_at timestamptz := clock_timestamp();
  v_deleted_entries integer := 0;
  v_cleanup_objects integer := 0;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
    v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
    if not exists (
      select 1
        from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
       where g.capability = 'submission_create'
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  else
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'submission_create'
    );
  end if;

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  if coalesce(v_authz_managed, false) then
    if not exists (
      select 1
        from pg_catalog.jsonb_to_recordset(v_grants) as g(
          capability text,
          scope_kind text,
          scope_id text
        )
       where g.capability = 'submission_create'
         and g.scope_kind in ('OWN', 'ALL')
         and g.scope_id is null
    ) then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
  else
    select count(*) into v_own_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'own'
       and g.team_id is null
       and g.is_current;
    if v_own_scope_count <> 1 then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'submission_id', p_submission_id,
    'expected_version', p_expected_version
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'draft_submission_delete', p_idempotency_key, v_request_hash
  );
  if v_prior is not null then return v_prior; end if;

  perform 1
    from public.direct_entries e
   where e.submission_id = p_submission_id and e.deleted_at is null
   order by e.entry_id
   for update;

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id
   for update;
  if not found or v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.state <> 'DRAFT' then
    raise exception 'submission is not a draft' using errcode = '55000';
  end if;
  if p_expected_version is null or p_expected_version <> v_submission.version then
    raise exception 'submission version conflict' using errcode = 'PT409';
  end if;
  if exists (
    select 1 from public.direct_entry_worker_portrait_stages s
     where s.submission_id = p_submission_id and s.status = 'CLAIMED'
  ) then
    raise exception 'submission document processing' using errcode = '55P03';
  end if;

  if coalesce(v_authz_managed, false) then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null)
    ) then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
  else
    select count(*) into v_own_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'own'
       and g.team_id is null
       and g.is_current;
    if v_own_scope_count <> 1 then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
  end if;

  v_before := jsonb_build_object(
    'state', v_submission.state,
    'version', v_submission.version,
    'entry_count', (
      select count(*)::int from public.direct_entries e
       where e.submission_id = p_submission_id and e.deleted_at is null
    ),
    'submitted_at', v_submission.submitted_at
  );
  v_reason_id := null;

  for v_entry in
    select e.* from public.direct_entries e
     where e.submission_id = p_submission_id and e.deleted_at is null
     order by e.entry_id
  loop
    if coalesce(v_authz_managed, false) then
      v_scope := public.direct_entry_assert_draft_access(
        p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date, 'own'
      );
    else
      v_scope := public.direct_entry_assert_draft_access(
        p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
    end if;
    if v_scope <> 'own' then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
    v_after := public.direct_entry_entry_snapshot(v_entry.entry_id);
    update public.direct_entries
       set deleted_at = v_deleted_at, version = version + 1
     where entry_id = v_entry.entry_id;
    v_revision_id := public.direct_entry_write_revision(
      v_entry.entry_id, p_app_user_id, v_reason_id, v_after,
      public.direct_entry_entry_snapshot(v_entry.entry_id), v_entry.version + 1
    );
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref,
      scope_kind, outcome, reason_id, revision_id, changed_fields
    ) values (
      p_auth_subject, p_app_user_id, 'draft_submission_delete', 'submission_create',
      v_entry.entry_id::text, 'own', 'APPLIED', v_reason_id, v_revision_id,
      array['deleted_at']
    );
    v_deleted_entries := v_deleted_entries + 1;
  end loop;

  insert into public.direct_entry_submission_object_cleanup (
    submission_id, object_kind, stage_id
  )
  select p_submission_id, 'PORTRAIT_STAGE', s.stage_id
    from public.direct_entry_worker_portrait_stages s
   where s.submission_id = p_submission_id and s.status = 'ATTACHED'
  on conflict do nothing;

  insert into public.direct_entry_submission_object_cleanup (
    submission_id, object_kind, document_id, storage_key
  )
  select p_submission_id, kinds.object_kind, d.document_id, d.storage_key
    from public.direct_entry_document_versions d
    join public.direct_entries e on e.candidate_id = d.candidate_id
    cross join (values ('DOCUMENT_STAGED'), ('DOCUMENT_FINAL')) as kinds(object_kind)
   where e.submission_id = p_submission_id
     and not exists (
       select 1 from public.direct_entries other
        where other.candidate_id = d.candidate_id
          and other.submission_id <> p_submission_id
     )
  on conflict do nothing;

  update public.direct_entry_submissions
     set state = 'DELETED', version = version + 1
   where submission_id = p_submission_id;
  v_submission_revision_id := public.direct_entry_write_submission_revision(
    p_submission_id, p_app_user_id, v_reason_id, v_before,
    jsonb_build_object(
      'state', 'DELETED',
      'version', v_submission.version + 1,
      'entry_count', 0,
      'deleted_entry_count', v_deleted_entries,
      'deleted_at', v_deleted_at
    ),
    v_submission.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'draft_submission_delete', 'submission_create',
    p_submission_id::text, 'own', 'APPLIED', v_reason_id,
    v_submission_revision_id, array['state', 'entries_deleted']
  );

  select count(*)::int into v_cleanup_objects
    from public.direct_entry_submission_object_cleanup c
   where c.submission_id = p_submission_id and c.cleanup_completed_at is null;
  v_result := jsonb_build_object(
    'submission_id', p_submission_id,
    'deleted', true,
    'version', v_submission.version + 1,
    'entries_deleted', v_deleted_entries,
    'cleanup_objects_queued', v_cleanup_objects
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'draft_submission_delete', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_submission_duplicate_cccd_preflight(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_submission public.direct_entry_submissions%rowtype;
  v_own_scope_count integer;
  v_state jsonb;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
    v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
    if not exists (
      select 1
        from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
       where g.capability = 'submission_create'
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  else
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'submission_create'
    );
  end if;

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  if coalesce(v_authz_managed, false) then
    if not exists (
      select 1
        from pg_catalog.jsonb_to_recordset(v_grants) as g(
          capability text,
          scope_kind text,
          scope_id text
        )
       where g.capability = 'submission_create'
         and g.scope_kind in ('OWN', 'ALL')
         and g.scope_id is null
    ) then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
  else
    select count(*) into v_own_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'own'
       and g.team_id is null
       and g.is_current;
    if v_own_scope_count <> 1 then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
  end if;

  if v_submission.state <> 'DRAFT' then
    raise exception 'submission is not a draft' using errcode = '22023';
  end if;

  v_state := public.direct_entry_submission_duplicate_cccd_state(p_submission_id);
  return jsonb_build_object(
    'submission_id', p_submission_id,
    'version', v_submission.version,
    'fingerprint', v_state->'fingerprint',
    'conflict_count', v_state->'conflict_count',
    'conflicts', v_state->'conflicts'
  );
end;
$function$;

create or replace function public.direct_entry_transition_submission_apply(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid,
  p_expected_version integer,
  p_target_state text,
  p_idempotency_key text,
  p_ack_fingerprint text,
  p_ack_conflict_count integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_submission public.direct_entry_submissions%rowtype;
  v_own_scope_count integer;
  v_prior_result jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_submission_revision_id uuid;
  v_before jsonb;
  v_state jsonb;
  v_conflict_count integer;
  v_acknowledged boolean := false;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
    v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
    if not exists (
      select 1
        from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
       where g.capability = 'submission_create'
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  else
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'submission_create'
    );
  end if;

  select * into v_submission
    from public.direct_entry_submissions
   where submission_id = p_submission_id
   for update;
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  if v_submission.created_by_user_id <> p_app_user_id then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  if coalesce(v_authz_managed, false) then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null)
    ) then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
  else
    select count(*) into v_own_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'own'
       and g.team_id is null
       and g.is_current;
    if v_own_scope_count <> 1 then
      raise exception 'submission own scope denied' using errcode = '42501';
    end if;
  end if;

  v_request_hash := encode(
    sha256(convert_to(concat_ws('|', p_submission_id::text, p_expected_version::text, p_target_state), 'UTF8')),
    'hex'
  );
  v_prior_result := public.direct_entry_idempotency_begin(
    p_app_user_id, 'submission_transition', p_idempotency_key, v_request_hash
  );
  if v_prior_result is not null then return v_prior_result; end if;
  if p_expected_version is null or p_expected_version <> v_submission.version then
    raise exception 'submission version conflict' using errcode = 'PT409';
  end if;
  if p_target_state = v_submission.state then
    raise exception 'submission transition cannot be a no-op' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.direct_entries e
     where e.submission_id = p_submission_id and e.deleted_at is null
  ) then
    raise exception 'submission must contain at least one entry' using errcode = '23514';
  end if;

  if v_submission.state = 'DRAFT' and p_target_state = 'SUBMITTED' then
      v_state := public.direct_entry_submission_duplicate_cccd_state(p_submission_id);
      v_conflict_count := (v_state->>'conflict_count')::int;
      if v_conflict_count > 0 then
        if p_ack_fingerprint is null
           or p_ack_fingerprint <> (v_state->>'fingerprint')
           or p_ack_conflict_count is null
           or p_ack_conflict_count <> v_conflict_count then
          raise exception 'duplicate cccd acknowledgement required' using errcode = '22023';
        end if;
        v_acknowledged := true;
      end if;
  end if;
  v_before := jsonb_build_object(
    'state', v_submission.state, 'version', v_submission.version,
    'submitted_at', v_submission.submitted_at
  );
  update public.direct_entry_submissions
     set state = p_target_state,
         version = version + 1
   where submission_id = p_submission_id;
  v_reason_id := null;
  insert into public.direct_entry_submission_revisions (
    submission_id, version, actor_user_id, reason_id, before_snapshot, after_snapshot
  ) values (
    p_submission_id, v_submission.version + 1, p_app_user_id, v_reason_id, v_before,
    jsonb_build_object(
      'state', p_target_state, 'version', v_submission.version + 1,
      'submitted_at', case when p_target_state = 'SUBMITTED' then now() else null end
    ) || case when v_acknowledged then jsonb_build_object(
        'duplicate_cccd_acknowledgement', jsonb_build_object(
          'conflict_count', v_conflict_count,
          'fingerprint_prefix', left(p_ack_fingerprint, 12)
        )
      ) else '{}'::jsonb end
  ) returning revision_id into v_submission_revision_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, scope_team_id, outcome, reason_id, submission_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'submission_transition', 'submission_create',
    p_submission_id::text, 'own', null, 'APPLIED', v_reason_id,
    v_submission_revision_id,
    array['state', 'version']
  );
  v_result := jsonb_build_object(
    'submission_id', p_submission_id,
    'state', p_target_state,
    'version', v_submission.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'submission_transition', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

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
    select coalesce(u.authz_managed, false)
      into v_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id;

    if coalesce(v_authz_managed, false) then
      perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
      if not (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'employment_status.apply', 'ALL', null)
        or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'employment_status.apply', 'OWN', null)
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
    else
      perform public.direct_entry_assert_actor(
        p_auth_subject, p_app_user_id, 'employment_status.apply'
      );
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

    select count(*), min(m.provider_type) into v_count, v_provider_type
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(
         m.membership_id, public.direct_entry_authorization_date()
       );
    if v_count <> 1 then
      raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
    end if;
    if v_provider_type = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id
         and public.direct_entry__internal_recruiter_team_membership_effective(
           m.membership_id, public.direct_entry_authorization_date()
         );
      if v_count <> 1 then
        raise exception 'RECRUITER_MEMBERSHIP_INVALID' using errcode = '22023';
      end if;
    end if;

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
      employee_code, worker_details, recruiter_id, team_id, provider_type, labor_type,
      general_note
    ) values (
      v_submission_id, v_candidate_id, p_app_user_id, v_project_id, v_first_work_date,
      v_employee_code, v_worker_details, v_recruiter_id, v_team_id, v_provider_type,
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

create or replace function public.direct_entry_create_full_profile_batch_with_portrait_stages(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_contract_version text,
  p_rows jsonb,
  p_idempotency_key text,
  p_stage_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage_id uuid;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
  v_result jsonb;
  v_submission_id uuid;
  v_linked integer;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  else
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'document_upload'
    );
  end if;

  if p_idempotency_key is null or
     p_idempotency_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_stage_ids is null or cardinality(p_stage_ids) not between 1 and 400
     or exists (select 1 from unnest(p_stage_ids) id where id is null)
     or (select count(distinct id) from unnest(p_stage_ids) id) <> cardinality(p_stage_ids) then
    raise exception 'worker document stage batch invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':' || p_idempotency_key, 0)
  );
  for v_stage_id in select id from unnest(p_stage_ids) id order by id loop
    select * into v_stage
      from public.direct_entry_worker_portrait_stages
     where stage_id = v_stage_id and created_by_user_id = p_app_user_id
     for update;
    if not found then
      raise exception 'worker document stage not found' using errcode = '42501';
    end if;
    if v_stage.status not in ('CLAIMED', 'ATTACHED')
       or v_stage.claim_idempotency_key <> p_idempotency_key then
      raise exception 'worker document stage claim conflict' using errcode = 'PT409';
    end if;
  end loop;

  v_result := public.direct_entry_create_full_profile_batch_v2(
    p_auth_subject, p_app_user_id, p_contract_version, p_rows, p_idempotency_key
  );
  v_submission_id := (v_result->>'submission_id')::uuid;

  update public.direct_entry_worker_portrait_stages s
     set submission_id = v_submission_id
   where s.stage_id = any(p_stage_ids)
     and s.created_by_user_id = p_app_user_id
     and s.claim_idempotency_key = p_idempotency_key
     and (s.submission_id is null or s.submission_id = v_submission_id)
     and (
       s.status = 'CLAIMED'
       or (s.status = 'ATTACHED' and exists (
         select 1 from public.direct_entries e
          where e.entry_id = s.entry_id and e.submission_id = v_submission_id
       ))
     );
  get diagnostics v_linked = row_count;
  if v_linked <> cardinality(p_stage_ids) then
    raise exception 'worker document stage submission mismatch' using errcode = 'PT409';
  end if;

  return v_result;
end;
$function$;

create or replace function public.direct_entry_resolve_submission_read_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_today date := public.direct_entry_authorization_date();
  v_scope text;
  v_entry public.direct_entries%rowtype;
  v_submission_state text;
  v_recruiter_link_count integer;
  v_team_leader_team_id uuid;
  v_can_read_own_submissions boolean;
begin
  v_scope := public.direct_entry_resolve_draft_scope(p_auth_subject, p_app_user_id, p_entry_id);
  if v_scope is not null then return v_scope; end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  select e.* into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id and e.deleted_at is null;
  if not found then return null; end if;

  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id;
  if not found then return null; end if;

  if coalesce(v_authz_managed, false) then
    v_can_read_own_submissions := (
      v_entry.created_by_user_id = p_app_user_id
      and (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
        or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null)
      )
    );
  else
    v_can_read_own_submissions := (
      v_entry.created_by_user_id = p_app_user_id
      and (
        select count(*)::integer
          from public.direct_entry_scope_grants g
         where g.app_user_id = p_app_user_id
           and g.scope_kind = 'own'
           and g.team_id is null
           and g.is_current
      ) = 1
      and public.direct_entry_has_capability(p_app_user_id, 'submission_create')
    );
  end if;

  if v_submission_state <> 'SUBMITTED' then
    if v_can_read_own_submissions then return 'own'; end if;
    return null;
  end if;

  if public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_entry.project_id) then
    return 'project';
  end if;
  if v_can_read_own_submissions then
    return 'own';
  end if;
  if v_entry.team_id is not null then
    begin
      v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
        p_auth_subject, p_app_user_id, v_entry.team_id
      );
      return 'team';
    exception when insufficient_privilege then
      null;
    end;
  end if;
  if exists(
    select 1
      from public.direct_entry_change_request_items i
      join public.direct_entry_change_requests r on r.request_id = i.request_id
     where i.entry_id = v_entry.entry_id
       and public.direct_entry_team_leader_request_team(p_app_user_id, r.request_id) = v_entry.team_id
  ) then
    return 'team_review';
  end if;

  if coalesce(v_authz_managed, false) then
    select count(*)::integer into v_recruiter_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_app_user_id
       and l.verified
       and l.is_current;
    if v_recruiter_link_count = 1 and exists(
      select 1
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
        join public.direct_entry_app_users u
          on u.app_user_id = l.app_user_id
         and u.enabled
         and u.account_type = 'NORMAL'
       where l.app_user_id = p_app_user_id
         and l.recruiter_id = v_entry.recruiter_id
         and l.verified
         and l.is_current
         and not l.suspended_by_account_disable
         and l.valid_from <= v_today
         and (l.valid_to is null or (l.valid_to > l.valid_from and v_today < l.valid_to))
         and not exists (
           select 1
             from public.direct_entry_app_user_recruiter_links other_link
            where other_link.recruiter_id = l.recruiter_id
              and other_link.app_user_id <> p_app_user_id
              and other_link.verified
              and other_link.is_current
              and not other_link.suspended_by_account_disable
              and other_link.valid_from <= v_today
              and (other_link.valid_to is null or (other_link.valid_to > other_link.valid_from and v_today < other_link.valid_to))
         )
    ) then
      return 'recruited';
    end if;
    if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
       or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
      return 'all';
    end if;
  else
    select count(*)::integer into v_recruiter_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_app_user_id and l.verified and l.is_current;
    if v_recruiter_link_count = 1 and exists(
      select 1
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
       where l.app_user_id = p_app_user_id
         and l.recruiter_id = v_entry.recruiter_id
         and l.verified
         and l.is_current
    ) then
      return 'recruited';
    end if;
    if public.direct_entry_has_scope(p_app_user_id, 'all') and (
        public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
        or public.direct_entry_has_capability(p_app_user_id, 'change_review')
    ) then
      return 'all';
    end if;
  end if;

  return null;
end;
$function$;

create or replace function public.direct_entry_read_projection(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns jsonb
language plpgsql
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
    v_documents := exists (
      select 1 from public.direct_entry_capability_grants g
       where g.app_user_id = p_app_user_id and g.capability = 'document_view'
         and g.is_current
    ) or (
      v_entry.created_by_user_id = p_app_user_id
      and v_scope = 'project'
      and exists (
        select 1 from public.direct_entry_submissions s
         where s.submission_id = v_entry.submission_id and s.state = 'DRAFT'
      )
    );
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
    'provider_type', v_entry.provider_type, 'labor_type', v_entry.labor_type,
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

-- =============================================================================
-- SECTION 2: Restricted-Owner Catalog Bootstrap RPCs
-- (Preserves owner = direct_entry_catalog_bootstrap_executor and zero stray DDL grants)
-- =============================================================================

grant execute on function public.direct_entry_authz__internal_has_paired_capability(uuid, text, text, text)
  to direct_entry_catalog_bootstrap_executor;

do $wp8c2_executor_setup$
declare
  v_executor oid;
begin
  if current_user <> session_user then
    raise exception 'WP8C-2 catalog bootstrap migration requires session_user = current_user';
  end if;
  select r.oid into v_executor
    from pg_catalog.pg_roles r
   where r.rolname = 'direct_entry_catalog_bootstrap_executor';
  if v_executor is null then
    raise exception 'WP8C-2 catalog bootstrap executor role is missing';
  end if;
  perform pg_catalog.set_config('mini_bi.wp8c2_added_catalog_executor_membership', 'false', true);
  perform pg_catalog.set_config('mini_bi.wp8c2_added_catalog_executor_create', 'false', true);
  if not pg_catalog.pg_has_role(session_user, v_executor, 'SET') then
    if exists (
      select 1 from pg_catalog.pg_auth_members m
       where m.member = session_user::regrole
         and m.roleid = v_executor
         and m.grantor = current_user::regrole
    ) then
      raise exception 'WP8C-2 found stale migration executor membership';
    end if;
    execute pg_catalog.format(
      'GRANT direct_entry_catalog_bootstrap_executor TO %I WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
      session_user
    );
    perform pg_catalog.set_config('mini_bi.wp8c2_added_catalog_executor_membership', 'true', true);
  end if;
  if pg_catalog.has_schema_privilege(v_executor, 'public', 'CREATE') then
    raise exception 'catalog bootstrap executor unexpectedly has CREATE on public';
  end if;
  execute 'GRANT CREATE ON SCHEMA public TO direct_entry_catalog_bootstrap_executor';
  perform pg_catalog.set_config('mini_bi.wp8c2_added_catalog_executor_create', 'true', true);
end;
$wp8c2_executor_setup$;

set local role direct_entry_catalog_bootstrap_executor;

create or replace function public.direct_entry_catalog_bootstrap_plan(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_projection jsonb;
  v_capability_count integer;
  v_catalog_empty boolean;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'catalog bootstrap actor required' using errcode = '22023';
  end if;
  perform set_config('mini_bi.catalog_bootstrap_app_user_id', p_app_user_id::text, true);
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if v_authz_managed then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null)
    ) then
      raise exception 'catalog bootstrap capability denied' using errcode = '42501';
    end if;
  else
    select count(distinct g.capability)::integer into v_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability in ('entry_admin', 'recruiter_master_manage', 'team_master_manage')
       and g.is_current;
    if v_capability_count <> 3 then
      raise exception 'catalog bootstrap capability denied' using errcode = '42501';
    end if;
  end if;

  v_projection := public.direct_entry_catalog_bootstrap_projection();
  select not (
    exists (select 1 from public.direct_entry_projects)
    or exists (select 1 from public.recruiters)
    or exists (select 1 from public.teams)
    or exists (select 1 from public.recruiter_aliases)
    or exists (select 1 from public.recruiter_provider_memberships)
    or exists (select 1 from public.recruiter_team_memberships)
    or exists (select 1 from public.direct_entry_banks)
  ) into v_catalog_empty;

  return jsonb_build_object(
    'source_fingerprint', v_projection->'source_fingerprint',
    'project_count', v_projection->'project_count',
    'recruiter_count', v_projection->'recruiter_count',
    'provider_period_count', v_projection->'provider_period_count',
    'invalid_count', v_projection->'invalid_count',
    'ambiguous_count', v_projection->'ambiguous_count',
    'catalog_empty', v_catalog_empty
  );
end;
$function$;

create or replace function public.direct_entry_apply_catalog_bootstrap(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_expected_source_fingerprint text,
  p_idempotency_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_projection jsonb;
  v_capability_count integer;
  v_existing public.direct_entry_catalog_bootstrap_runs%rowtype;
  v_run_id uuid;
  v_reason_id uuid;
  v_team_id uuid;
  v_item jsonb;
  v_period jsonb;
  v_recruiter_id uuid;
  v_project_count integer;
  v_recruiter_count integer;
  v_provider_count integer;
  v_snapshot_date date;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_auth_subject is null
     or p_app_user_id is null
     or p_expected_source_fingerprint is null
     or p_expected_source_fingerprint !~ '^[a-f0-9]{64}$'
     or p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'invalid catalog bootstrap request' using errcode = '22023';
  end if;
  perform set_config('mini_bi.catalog_bootstrap_app_user_id', p_app_user_id::text, true);
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if v_authz_managed then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null)
    ) then
      raise exception 'catalog bootstrap capability denied' using errcode = '42501';
    end if;
  else
    select count(distinct g.capability)::integer into v_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability in ('entry_admin', 'recruiter_master_manage', 'team_master_manage')
       and g.is_current;
    if v_capability_count <> 3 then
      raise exception 'catalog bootstrap capability denied' using errcode = '42501';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('direct_entry_catalog_bootstrap', 0));
  v_projection := public.direct_entry_catalog_bootstrap_projection();
  if v_projection->>'source_fingerprint' <> p_expected_source_fingerprint then
    raise exception 'catalog bootstrap source conflict' using errcode = 'PT409';
  end if;
  if (v_projection->>'invalid_count')::integer <> 0
     or (v_projection->>'ambiguous_count')::integer <> 0
     or (v_projection->>'project_count')::integer = 0
     or (v_projection->>'recruiter_count')::integer = 0
     or (v_projection->>'provider_period_count')::integer = 0 then
    raise exception 'catalog bootstrap source is not valid' using errcode = '23514';
  end if;

  select * into v_existing
    from public.direct_entry_catalog_bootstrap_runs
   where app_user_id = p_app_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.source_fingerprint <> p_expected_source_fingerprint then
      raise exception 'catalog bootstrap replay conflict' using errcode = '23505';
    end if;
    return jsonb_build_object(
      'status', 'ALREADY_APPLIED',
      'source_fingerprint', v_existing.source_fingerprint,
      'project_count', v_existing.project_count,
      'recruiter_count', v_existing.recruiter_count,
      'team_count', v_existing.team_count,
      'provider_membership_count', v_existing.provider_membership_count,
      'replayed', true
    );
  end if;

  if exists (select 1 from public.direct_entry_projects)
     or exists (select 1 from public.recruiters)
     or exists (select 1 from public.teams)
     or exists (select 1 from public.recruiter_aliases)
     or exists (select 1 from public.recruiter_provider_memberships)
     or exists (select 1 from public.recruiter_team_memberships)
     or exists (select 1 from public.direct_entry_banks) then
    raise exception 'catalog bootstrap target is not empty' using errcode = '23505';
  end if;

  v_run_id := gen_random_uuid();
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_snapshot_date := public.direct_entry_authorization_date();

  insert into public.direct_entry_projects(project_id, display_name)
  select x.project_id, x.display_name
    from jsonb_to_recordset(v_projection->'projects') as x(project_id text, display_name text);
  v_project_count := (v_projection->>'project_count')::integer;

  insert into public.teams(code, display_name)
  values ('unassigned', 'Chưa phân nhóm')
  returning team_id into v_team_id;

  for v_item in select value from jsonb_array_elements(v_projection->'recruiters') loop
    insert into public.recruiters(display_name)
    values (v_item->>'display_name')
    returning recruiter_id into v_recruiter_id;

    insert into public.recruiter_aliases(recruiter_id, reporting_key, valid_from)
    values (v_recruiter_id, v_item->>'reporting_key', (v_item->>'alias_from')::date);

    insert into public.recruiter_team_memberships(recruiter_id, team_id, valid_from, is_current)
    values (v_recruiter_id, v_team_id, (v_item->>'team_from')::date,
      (v_item->>'team_from')::date <= v_snapshot_date);

    for v_period in select value from jsonb_array_elements(v_item->'periods') loop
      insert into public.recruiter_provider_memberships(
        recruiter_id, provider_type, valid_from, valid_to, is_current
      ) values (
        v_recruiter_id, v_period->>'provider_type',
        (v_period->>'valid_from')::date, (v_period->>'valid_to')::date,
        (v_period->>'valid_from')::date <= v_snapshot_date
          and (v_period->>'valid_to' is null or v_snapshot_date < (v_period->>'valid_to')::date)
      );
    end loop;
  end loop;

  v_recruiter_count := (v_projection->>'recruiter_count')::integer;
  v_provider_count := (v_projection->>'provider_period_count')::integer;

  insert into public.direct_entry_catalog_bootstrap_runs(
    run_id, app_user_id, source_fingerprint, project_count, recruiter_count,
    team_count, provider_membership_count, status, idempotency_key, reason_id
  ) values (
    v_run_id, p_app_user_id, p_expected_source_fingerprint, v_project_count,
    v_recruiter_count, 1, v_provider_count, 'APPLIED', p_idempotency_key, v_reason_id
  );

  insert into public.direct_entry_audit_events(
    auth_subject, app_user_id, action, capability, resource_ref,
    scope_kind, outcome, reason_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'catalog_bootstrap', 'entry_admin',
    'catalog-bootstrap:' || v_run_id::text, 'all', 'APPLIED', v_reason_id,
    array[
      'projects', 'recruiters', 'recruiter_aliases', 'teams',
      'recruiter_team_memberships', 'recruiter_provider_memberships'
    ]
  );

  return jsonb_build_object(
    'status', 'APPLIED',
    'source_fingerprint', p_expected_source_fingerprint,
    'project_count', v_project_count,
    'recruiter_count', v_recruiter_count,
    'team_count', 1,
    'provider_membership_count', v_provider_count,
    'replayed', false
  );
end;
$function$;

reset role;

do $wp8c2_executor_cleanup$
declare
  v_executor oid;
begin
  select r.oid into v_executor
    from pg_catalog.pg_roles r
   where r.rolname = 'direct_entry_catalog_bootstrap_executor';
  if current_setting('mini_bi.wp8c2_added_catalog_executor_create', true) = 'true' then
    execute pg_catalog.format(
      'REVOKE CREATE ON SCHEMA public FROM direct_entry_catalog_bootstrap_executor GRANTED BY %I',
      current_user
    );
  end if;
  if current_setting('mini_bi.wp8c2_added_catalog_executor_membership', true) = 'true' then
    execute pg_catalog.format(
      'REVOKE direct_entry_catalog_bootstrap_executor FROM %I GRANTED BY %I',
      session_user, current_user
    );
  end if;
  if pg_catalog.has_schema_privilege(v_executor, 'public', 'CREATE') then
    raise exception 'WP8C-2 catalog bootstrap executor retained CREATE on public';
  end if;
  if exists (
    select 1 from pg_catalog.pg_auth_members m
     where m.member = session_user::regrole
       and m.roleid = v_executor
       and m.grantor = current_user::regrole
  ) then
    raise exception 'WP8C-2 migration executor membership was not removed';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.direct_entry_catalog_bootstrap_plan(uuid,uuid)'::regprocedure
       and p.proowner = v_executor and p.prosecdef
  ) or not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)'::regprocedure
       and p.proowner = v_executor and p.prosecdef
  ) then
    raise exception 'WP8C-2 changed catalog bootstrap function owner or SECURITY DEFINER';
  end if;
end;
$wp8c2_executor_cleanup$;

-- =============================================================================
-- SECTION 3: Document / Portrait Stage / CCCD / Duplicate CCCD
-- =============================================================================

create or replace function public.direct_entry_assert_payment_document_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_resource_scope_date date,
  p_submission_id uuid,
  p_privileged_capability text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_state text;
begin
  select s.state into v_state from public.direct_entry_submissions s
   where s.submission_id = p_submission_id for update;
  if v_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if v_state = 'DRAFT' then
    if p_privileged_capability = 'document_upload' then
      if coalesce(v_authz_managed, false) then
        perform public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'document_upload',
          p_entry_owner, p_team_id, p_resource_scope_date
        );
      else
        perform public.direct_entry_assert_actor(
          p_auth_subject, p_app_user_id, 'document_upload'
        );
      end if;
    end if;
    return public.direct_entry_assert_draft_access(
      p_auth_subject, p_app_user_id, p_entry_owner, p_team_id, p_resource_scope_date
    );
  end if;
  if v_state = 'REVIEW' then
    raise exception 'REVIEW submissions are read-only' using errcode = '42501';
  end if;
  if p_privileged_capability = 'document_upload' then
    if coalesce(v_authz_managed, false) then
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'entry_privileged_edit',
        p_entry_owner, p_team_id, p_resource_scope_date
      );
    else
      perform public.direct_entry_assert_actor(
        p_auth_subject, p_app_user_id, 'entry_privileged_edit'
      );
    end if;
  end if;
  return public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, p_privileged_capability,
    p_entry_owner, p_team_id, p_resource_scope_date
  );
end;
$function$;

create or replace function public.direct_entry_assert_document_upload_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_entry public.direct_entries%rowtype;
  v_submission_state text;
  v_draft_scope text;
  v_read_scope text;
  v_is_full_admin boolean := false;
  v_current_team_leader_team_id uuid;
  v_direct_edit_authority text;
  v_has_doc_upload_all boolean := false;
  v_has_doc_upload_own boolean := false;
  v_has_doc_upload_team boolean := false;
  v_has_doc_upload_project boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id and e.deleted_at is null
   for update;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  select s.state into v_submission_state
    from public.direct_entry_submissions s
   where s.submission_id = v_entry.submission_id
   for update;
  if v_submission_state is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;

  if coalesce(v_authz_managed, false) then
    v_has_doc_upload_all :=
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null);
    v_has_doc_upload_own :=
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null);
    v_has_doc_upload_team :=
      v_entry.team_id is not null
      and public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'document_upload', 'CONTEXT_TEAM', v_entry.team_id::text
      );
    v_has_doc_upload_project :=
      public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'document_upload', 'CONTEXT_PROJECT', v_entry.project_id
      );

    if v_submission_state = 'DRAFT' then
      begin
        if not (v_has_doc_upload_all or v_has_doc_upload_own or v_has_doc_upload_team or v_has_doc_upload_project) then
          raise exception 'capability denied' using errcode = '42501';
        end if;
        v_draft_scope := public.direct_entry_assert_draft_access(
          p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
          v_entry.team_id, v_entry.first_work_date
        );
        if (v_draft_scope = 'all' and not (v_has_doc_upload_all or (v_entry.created_by_user_id = p_app_user_id and v_has_doc_upload_own)))
           or (v_draft_scope = 'team' and not (v_has_doc_upload_all or v_has_doc_upload_team or v_has_doc_upload_own))
           or (v_draft_scope = 'own' and not (v_has_doc_upload_all or v_has_doc_upload_own or v_has_doc_upload_team)) then
          raise exception 'capability denied' using errcode = '42501';
        end if;
        return v_draft_scope;
      exception when insufficient_privilege then
        if v_entry.created_by_user_id = p_app_user_id
           and public.direct_entry_actor_can_access_project(
             p_app_user_id, v_entry.project_id
           ) then
          return 'project';
        end if;
        if v_entry.created_by_user_id = p_app_user_id then
          raise;
        end if;
      end;
    end if;

    if v_submission_state = 'REVIEW' then
      raise exception 'REVIEW submissions are read-only' using errcode = '42501';
    end if;

    if not (v_has_doc_upload_all or v_has_doc_upload_own or v_has_doc_upload_team or v_has_doc_upload_project) then
      raise exception 'capability denied' using errcode = '42501';
    end if;

    if v_submission_state = 'SUBMITTED'
       and v_entry.created_by_user_id = p_app_user_id then
      if v_has_doc_upload_all then
        return 'all';
      elsif v_has_doc_upload_own then
        return 'own';
      elsif v_has_doc_upload_team then
        return 'team';
      elsif v_has_doc_upload_project then
        return 'project';
      end if;
      raise exception 'capability denied' using errcode = '42501';
    end if;

    if v_submission_state = 'SUBMITTED'
       and exists (
         select 1
           from public.direct_entry_cccd_reconciliations r
          where r.entry_id = v_entry.entry_id
       ) then
      v_read_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_read_scope is not null then
        if (v_read_scope = 'all' and v_has_doc_upload_all)
           or (v_read_scope = 'own' and (v_has_doc_upload_all or v_has_doc_upload_own or v_has_doc_upload_team))
           or (v_read_scope in ('team', 'team_review') and (v_has_doc_upload_all or v_has_doc_upload_team or v_has_doc_upload_own))
           or (v_read_scope = 'project' and (v_has_doc_upload_all or v_has_doc_upload_project or v_has_doc_upload_own))
           or (v_read_scope = 'recruited' and (v_has_doc_upload_all or v_has_doc_upload_own)) then
          return v_read_scope;
        end if;
      end if;
    end if;

    if v_submission_state in ('DRAFT', 'SUBMITTED') then
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
      if v_direct_edit_authority is not null then
        if v_direct_edit_authority in ('admin_all', 'privileged_all') then
          if not v_has_doc_upload_all then
            raise exception 'capability denied' using errcode = '42501';
          end if;
          return 'all';
        elsif v_direct_edit_authority = 'team_leader' then
          if not (v_has_doc_upload_all or v_has_doc_upload_team or v_has_doc_upload_own) then
            raise exception 'capability denied' using errcode = '42501';
          end if;
          return 'team';
        elsif v_direct_edit_authority = 'privileged_team' then
          if not (v_has_doc_upload_all or v_has_doc_upload_team) then
            raise exception 'capability denied' using errcode = '42501';
          end if;
          return 'team';
        elsif v_direct_edit_authority = 'project_manager' then
          if not (v_has_doc_upload_all or v_has_doc_upload_project or v_has_doc_upload_own) then
            raise exception 'capability denied' using errcode = '42501';
          end if;
          return 'project';
        elsif v_direct_edit_authority = 'privileged_own' then
          if not (v_has_doc_upload_all or v_has_doc_upload_own) then
            raise exception 'capability denied' using errcode = '42501';
          end if;
          return 'own';
        else
          if not v_has_doc_upload_all then
            raise exception 'capability denied' using errcode = '42501';
          end if;
          return 'all';
        end if;
      end if;
    end if;

    perform public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'entry_privileged_edit',
      v_entry.created_by_user_id, v_entry.team_id,
      v_entry.first_work_date, null
    );
    return public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'document_upload',
      v_entry.created_by_user_id, v_entry.team_id,
      v_entry.first_work_date, null
    );
  end if;

  -- Pre-cutover (`authz_managed = false`) R1 compatibility path.
  if v_submission_state = 'DRAFT' then
    begin
      perform public.direct_entry_assert_actor(
        p_auth_subject, p_app_user_id, 'document_upload'
      );
      return public.direct_entry_assert_draft_access(
        p_auth_subject, p_app_user_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
    exception when insufficient_privilege then
      if v_entry.created_by_user_id = p_app_user_id
         and public.direct_entry_actor_can_access_project(
           p_app_user_id, v_entry.project_id
         ) then
        return 'project';
      end if;
      if v_entry.created_by_user_id = p_app_user_id then
        raise;
      end if;
    end;
  end if;

  if v_submission_state = 'REVIEW' then
    raise exception 'REVIEW submissions are read-only' using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'document_upload'
  );

  if v_submission_state = 'SUBMITTED'
     and v_entry.created_by_user_id = p_app_user_id then
    return public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'document_upload',
      v_entry.created_by_user_id, v_entry.team_id,
      v_entry.first_work_date, null
    );
  end if;

  if v_submission_state = 'SUBMITTED'
     and exists (
       select 1
         from public.direct_entry_cccd_reconciliations r
        where r.entry_id = v_entry.entry_id
     )
     and public.direct_entry_resolve_submission_read_scope(
       p_auth_subject, p_app_user_id, v_entry.entry_id
     ) is not null then
    return public.direct_entry_resolve_submission_read_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id
    );
  end if;

  if v_submission_state in ('DRAFT', 'SUBMITTED') then
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'document_upload'
    );
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
    if v_direct_edit_authority is not null then
      perform public.direct_entry_assert_actor(
        p_auth_subject, p_app_user_id, 'document_upload'
      );
      return case
        when v_direct_edit_authority = 'admin_all' then 'all'
        when v_direct_edit_authority = 'team_leader' then 'team'
        when v_direct_edit_authority = 'project_manager' then 'project'
        when v_direct_edit_authority like 'privileged_%'
          then substring(v_direct_edit_authority from 12)
        else 'all'
      end;
    end if;
  end if;

  perform public.direct_entry_assert_actor(
    p_auth_subject, p_app_user_id, 'entry_privileged_edit'
  );
  return public.direct_entry_assert_entry_access(
    p_auth_subject, p_app_user_id, 'document_upload',
    v_entry.created_by_user_id, v_entry.team_id,
    v_entry.first_work_date, null
  );
end;
$function$;

create or replace function public.direct_entry_document_direct_context(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_document_id uuid,
  p_purpose text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_entry public.direct_entries%rowtype;
  v_document public.direct_entry_document_versions%rowtype;
  v_scope text;
  v_latest public.direct_entry_document_events%rowtype;
begin
  if p_purpose not in ('finalize', 'download', 'preview', 'cccd_preview') then
    raise exception 'invalid document context purpose' using errcode = '22023';
  end if;
  select * into v_entry from public.direct_entries
   where entry_id = p_entry_id and deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  if p_purpose = 'finalize' then
    perform public.direct_entry_assert_document_upload_access(
      p_auth_subject, p_app_user_id, p_entry_id
    );
  else
    if p_purpose = 'download' then
      v_scope := public.direct_entry_assert_document_download_access(
        p_auth_subject, p_app_user_id, v_entry.entry_id, p_document_id, v_entry.created_by_user_id,
        v_entry.team_id, v_entry.first_work_date
      );
    elsif p_purpose = 'cccd_preview' then
      select * into v_document from public.direct_entry_document_versions d
       where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
      if not found or v_document.document_type not in ('CCCD_FRONT', 'CCCD_BACK') then
        raise exception 'document is not a CCCD image' using errcode = 'P0002';
      end if;
      v_scope := public.direct_entry_resolve_submission_read_scope(
        p_auth_subject, p_app_user_id, v_entry.entry_id
      );
      if v_scope is null and v_entry.created_by_user_id = p_app_user_id
         and exists (
           select 1
             from public.direct_entry_cccd_reconciliations r
            where r.entry_id = v_entry.entry_id
         ) then
        v_scope := 'own';
      end if;
      if v_scope is null then
        v_scope := public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'document_view',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    else
      select * into v_document from public.direct_entry_document_versions d
       where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
      if not found then
        raise exception 'document not found' using errcode = 'P0002';
      end if;
      if v_document.document_type <> 'WORKER_PORTRAIT' then
        raise exception 'private preview is portrait-only' using errcode = 'P0002';
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
    end if;

    select coalesce(u.authz_managed, false)
      into v_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id;

    if coalesce(v_authz_managed, false) then
      if not (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
        or (
          (v_scope = 'own' or v_entry.created_by_user_id = p_app_user_id)
          and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
        )
        or (
          v_scope in ('team', 'team_review')
          and (
            (
              v_entry.team_id is not null
              and public.direct_entry_authz__internal_has_paired_capability(
                p_app_user_id, 'document_view', 'CONTEXT_TEAM', v_entry.team_id::text
              )
            )
            or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
          )
        )
        or (
          v_scope = 'project'
          and (
            public.direct_entry_authz__internal_has_paired_capability(
              p_app_user_id, 'document_view', 'CONTEXT_PROJECT', v_entry.project_id
            )
            or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
          )
        )
        or (
          v_scope = 'recruited'
          and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
        )
      ) then
        raise exception 'document view denied' using errcode = '42501';
      end if;
    elsif not exists (
      select 1 from public.direct_entry_capability_grants g
       where g.app_user_id = p_app_user_id and g.capability = 'document_view'
         and g.is_current
    ) then
      raise exception 'document view denied' using errcode = '42501';
    end if;
  end if;

  select * into v_document from public.direct_entry_document_versions d
   where d.document_id = p_document_id and d.candidate_id = v_entry.candidate_id;
  if not found then
    raise exception 'document not found' using errcode = 'P0002';
  end if;
  select * into v_latest from public.direct_entry_document_events e
   where e.document_id = p_document_id order by e.version desc limit 1;
  if p_purpose = 'download' and v_document.document_type = 'WORKER_PORTRAIT' then
    raise exception 'portrait requires private preview' using errcode = 'P0002';
  end if;
  if p_purpose = 'preview' and (
    v_document.document_type <> 'WORKER_PORTRAIT'
    or not exists (
      select 1 from public.direct_entry_current_documents cd
       where cd.document_id = p_document_id
         and cd.candidate_id = v_entry.candidate_id
         and cd.document_type = 'WORKER_PORTRAIT'
    )
  ) then
    raise exception 'portrait is not current' using errcode = 'P0002';
  end if;
  if p_purpose in ('download', 'preview', 'cccd_preview') and not (
    v_latest.upload_status = 'READY' and v_latest.validation_status = 'VALIDATED'
    and v_latest.scan_status in ('CLEAN', 'NOT_REQUIRED')
  ) then
    raise exception 'document not eligible' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'document_id', v_document.document_id, 'document_type', v_document.document_type,
    'version', v_document.version, 'storage_key', v_document.storage_key,
    'size_bytes', coalesce((
      select o.size_bytes from public.direct_entry_document_objects o
       where o.document_id = v_document.document_id
    ), v_document.size_bytes),
    'mime_type', v_document.mime_type,
    'checksum_sha256', (
      select o.checksum_sha256 from public.direct_entry_document_objects o
       where o.document_id = v_document.document_id
    ),
    'upload_status', v_latest.upload_status, 'scan_status', v_latest.scan_status,
    'validation_status', v_latest.validation_status, 'entry_version', v_entry.version
  );
end;
$function$;

create or replace function public.direct_entry_create_worker_document_stage_idempotent(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_document_type text,
  p_mime_type text,
  p_size_bytes bigint,
  p_checksum_sha256 text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
  v_key text := lower(p_idempotency_key);
  v_replayed boolean := false;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if v_authz_managed then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  else
    perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'document_upload');
  end if;

  if v_key is null or
     v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
     p_document_type not in ('WORKER_PORTRAIT', 'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT') or
     p_mime_type not in ('image/jpeg', 'image/png', 'application/pdf') or
     (p_document_type = 'WORKER_PORTRAIT' and p_mime_type = 'application/pdf') or
     p_size_bytes not between 1 and 10485760 or
     p_checksum_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'worker document stage invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':document-stage:' || v_key, 0)
  );
  select * into v_stage
    from public.direct_entry_worker_portrait_stages
   where created_by_user_id = p_app_user_id
     and create_idempotency_key = v_key
   for update;
  if found then
    if v_stage.document_type <> p_document_type or v_stage.mime_type <> p_mime_type or
       v_stage.size_bytes <> p_size_bytes or v_stage.checksum_sha256 <> p_checksum_sha256 then
      raise exception 'worker document stage idempotency conflict' using errcode = 'PT409';
    end if;
    v_replayed := true;
  else
    insert into public.direct_entry_worker_portrait_stages (
      stage_id, created_by_user_id, document_type, mime_type, size_bytes,
      checksum_sha256, create_idempotency_key
    ) values (
      p_stage_id, p_app_user_id, p_document_type, p_mime_type, p_size_bytes,
      p_checksum_sha256, v_key
    ) returning * into v_stage;
  end if;

  return jsonb_build_object(
    'stage', jsonb_build_object(
      'stage_id', v_stage.stage_id, 'document_type', v_stage.document_type,
      'mime_type', v_stage.mime_type, 'size_bytes', v_stage.size_bytes,
      'checksum_sha256', v_stage.checksum_sha256, 'status', v_stage.status,
      'claim_idempotency_key', v_stage.claim_idempotency_key,
      'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
    ),
    'replayed', v_replayed
  );
end;
$function$;

create or replace function public.direct_entry_complete_worker_document_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_idempotency_key text,
  p_entry_id uuid,
  p_document_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if v_authz_managed then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  else
    perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'document_upload');
  end if;

  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if v_stage.status = 'ATTACHED' then
    if v_stage.claim_idempotency_key = p_idempotency_key and
       v_stage.entry_id = p_entry_id and v_stage.document_id = p_document_id then return true; end if;
    raise exception 'worker document stage attachment conflict' using errcode = 'PT409';
  end if;
  if v_stage.status <> 'CLAIMED' or v_stage.claim_idempotency_key <> p_idempotency_key or
     not exists (
       select 1 from public.direct_entries e
       join public.direct_entry_document_versions d on d.candidate_id = e.candidate_id
        where e.entry_id = p_entry_id and d.document_id = p_document_id
          and d.document_type = v_stage.document_type
          and d.created_by_user_id = p_app_user_id
          and d.size_bytes = v_stage.size_bytes
          and d.mime_type = v_stage.mime_type
          and coalesce(
            (select o.checksum_sha256 from public.direct_entry_document_objects o
              where o.document_id = d.document_id), d.checksum_sha256
          ) = v_stage.checksum_sha256
          and exists (
            select 1 from public.direct_entry_document_events ev
             where ev.document_id = d.document_id and ev.upload_status = 'READY'
               and ev.validation_status = 'VALIDATED'
               and ev.scan_status in ('CLEAN', 'NOT_REQUIRED')
               and ev.version = (
                 select max(latest.version) from public.direct_entry_document_events latest
                  where latest.document_id = d.document_id
               )
          )
     ) then
    raise exception 'worker document stage attachment conflict' using errcode = 'PT409';
  end if;
  update public.direct_entry_worker_portrait_stages
     set status = 'ATTACHED', entry_id = p_entry_id, document_id = p_document_id
   where stage_id = p_stage_id;
  return true;
end;
$function$;

create or replace function public.direct_entry_create_worker_portrait_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_mime_type text,
  p_size_bytes bigint,
  p_checksum_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_date date := public.direct_entry_authorization_date();
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if v_authz_managed then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  elsif not exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability = 'document_upload'
       and g.is_current
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  if p_mime_type not in ('image/jpeg', 'image/png') or
     p_size_bytes not between 1 and 10485760 or
     p_checksum_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'portrait stage invalid' using errcode = '22023';
  end if;
  insert into public.direct_entry_worker_portrait_stages (
    stage_id, created_by_user_id, mime_type, size_bytes, checksum_sha256
  ) values (
    p_stage_id, p_app_user_id, p_mime_type, p_size_bytes, p_checksum_sha256
  ) returning * into v_stage;
  return jsonb_build_object(
    'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
    'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
    'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
    'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
  );
end;
$function$;

create or replace function public.direct_entry_create_worker_portrait_stage_idempotent(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_mime_type text,
  p_size_bytes bigint,
  p_checksum_sha256 text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
  v_key text := lower(p_idempotency_key);
  v_replayed boolean := false;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if v_authz_managed then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  else
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'document_upload'
    );
  end if;

  if v_key is null or
     v_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' or
     p_mime_type not in ('image/jpeg', 'image/png') or
     p_size_bytes not between 1 and 10485760 or
     p_checksum_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'portrait stage invalid' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_app_user_id::text || ':portrait-stage:' || v_key, 0)
  );
  select * into v_stage
    from public.direct_entry_worker_portrait_stages
   where created_by_user_id = p_app_user_id
     and create_idempotency_key = v_key
   for update;
  if found then
    if v_stage.mime_type <> p_mime_type or
       v_stage.size_bytes <> p_size_bytes or
       v_stage.checksum_sha256 <> p_checksum_sha256 then
      raise exception 'portrait stage idempotency conflict' using errcode = 'PT409';
    end if;
    v_replayed := true;
  else
    insert into public.direct_entry_worker_portrait_stages (
      stage_id, created_by_user_id, mime_type, size_bytes, checksum_sha256,
      create_idempotency_key
    ) values (
      p_stage_id, p_app_user_id, p_mime_type, p_size_bytes, p_checksum_sha256, v_key
    ) returning * into v_stage;
  end if;

  return jsonb_build_object(
    'stage', jsonb_build_object(
      'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
      'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
      'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
      'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
    ),
    'replayed', v_replayed
  );
end;
$function$;

create or replace function public.direct_entry_claim_worker_portrait_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_date date := public.direct_entry_authorization_date();
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if v_authz_managed then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  elsif not exists (
    select 1 from public.direct_entry_capability_grants g
     where g.app_user_id = p_app_user_id
       and g.capability = 'document_upload'
       and g.is_current
  ) then
    raise exception 'capability denied' using errcode = '42501';
  end if;

  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'portrait stage claim invalid' using errcode = '22023';
  end if;
  if v_stage.status = 'STAGED' then
    update public.direct_entry_worker_portrait_stages
       set status = 'CLAIMED', claim_idempotency_key = p_idempotency_key
     where stage_id = p_stage_id returning * into v_stage;
  elsif v_stage.status not in ('CLAIMED', 'ATTACHED') or
        v_stage.claim_idempotency_key <> p_idempotency_key then
    raise exception 'portrait stage already claimed' using errcode = 'PT409';
  end if;
  return jsonb_build_object(
    'stage_id', v_stage.stage_id, 'mime_type', v_stage.mime_type,
    'size_bytes', v_stage.size_bytes, 'checksum_sha256', v_stage.checksum_sha256,
    'status', v_stage.status, 'claim_idempotency_key', v_stage.claim_idempotency_key,
    'entry_id', v_stage.entry_id, 'document_id', v_stage.document_id
  );
end;
$function$;

create or replace function public.direct_entry_complete_worker_portrait_stage(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_stage_id uuid,
  p_idempotency_key text,
  p_entry_id uuid,
  p_document_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_stage public.direct_entry_worker_portrait_stages%rowtype;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor mapping denied' using errcode = '42501';
  end if;

  if v_authz_managed then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
    ) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  else
    perform public.direct_entry_assert_actor(
      p_auth_subject, p_app_user_id, 'document_upload'
    );
  end if;

  select * into v_stage from public.direct_entry_worker_portrait_stages
   where stage_id = p_stage_id and created_by_user_id = p_app_user_id for update;
  if not found then raise exception 'stage not found' using errcode = '42501'; end if;
  if v_stage.status = 'ATTACHED' then
    if v_stage.claim_idempotency_key = p_idempotency_key and
       v_stage.entry_id = p_entry_id and v_stage.document_id = p_document_id then
      return true;
    end if;
    raise exception 'portrait stage attachment conflict' using errcode = 'PT409';
  end if;
  if v_stage.status <> 'CLAIMED' or v_stage.claim_idempotency_key <> p_idempotency_key or
     not exists (
       select 1 from public.direct_entries e
       join public.direct_entry_document_versions d on d.candidate_id = e.candidate_id
        where e.entry_id = p_entry_id and d.document_id = p_document_id
          and d.document_type = 'WORKER_PORTRAIT'
          and d.created_by_user_id = p_app_user_id
          and d.size_bytes = v_stage.size_bytes
          and d.mime_type = v_stage.mime_type
          and coalesce(
            (select o.checksum_sha256 from public.direct_entry_document_objects o
              where o.document_id = d.document_id),
            d.checksum_sha256
          ) = v_stage.checksum_sha256
          and exists (
            select 1 from public.direct_entry_document_events ev
             where ev.document_id = d.document_id
               and ev.upload_status = 'READY'
               and ev.validation_status = 'VALIDATED'
               and ev.scan_status in ('CLEAN', 'NOT_REQUIRED')
               and ev.version = (
                 select max(latest.version) from public.direct_entry_document_events latest
                  where latest.document_id = d.document_id
               )
          )
     ) then
    raise exception 'portrait stage attachment conflict' using errcode = 'PT409';
  end if;
  update public.direct_entry_worker_portrait_stages
     set status = 'ATTACHED', entry_id = p_entry_id, document_id = p_document_id
   where stage_id = p_stage_id;
  return true;
end;
$function$;

create or replace function public.direct_entry__internal_assert_cccd_qr_read_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_entry public.direct_entries%rowtype;
  v_scope text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select * into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id
     and e.deleted_at is null
     and e.voided_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  begin
    return public.direct_entry_assert_document_upload_access(
      p_auth_subject, p_app_user_id, p_entry_id
    );
  exception when insufficient_privilege then
    null;
  end;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
      or (
        v_entry.team_id is not null
        and public.direct_entry_authz__internal_has_paired_capability(
          p_app_user_id, 'document_view', 'CONTEXT_TEAM', v_entry.team_id::text
        )
      )
      or public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'document_view', 'CONTEXT_PROJECT', v_entry.project_id
      )
    ) then
      raise exception 'cccd qr read denied' using errcode = '42501';
    end if;

    v_scope := public.direct_entry_resolve_submission_read_scope(
      p_auth_subject, p_app_user_id, v_entry.entry_id
    );
    if v_scope is null then
      v_scope := public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'document_view',
        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
      );
    end if;
    if v_scope is null then
      raise exception 'cccd qr read denied' using errcode = '42501';
    end if;

    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'ALL', null)
      or (
        (v_scope = 'own' or v_entry.created_by_user_id = p_app_user_id)
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
      )
      or (
        v_scope in ('team', 'team_review')
        and (
          (
            v_entry.team_id is not null
            and public.direct_entry_authz__internal_has_paired_capability(
              p_app_user_id, 'document_view', 'CONTEXT_TEAM', v_entry.team_id::text
            )
          )
          or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
        )
      )
      or (
        v_scope = 'project'
        and (
          public.direct_entry_authz__internal_has_paired_capability(
            p_app_user_id, 'document_view', 'CONTEXT_PROJECT', v_entry.project_id
          )
          or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
        )
      )
      or (
        v_scope = 'recruited'
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_view', 'OWN', null)
      )
    ) then
      raise exception 'cccd qr read denied' using errcode = '42501';
    end if;

    return v_scope;
  end if;

  if not public.direct_entry_has_capability(p_app_user_id, 'document_view') then
    raise exception 'cccd qr read denied' using errcode = '42501';
  end if;

  v_scope := public.direct_entry_resolve_submission_read_scope(
    p_auth_subject, p_app_user_id, v_entry.entry_id
  );
  if v_scope is null then
    v_scope := public.direct_entry_assert_entry_access(
      p_auth_subject, p_app_user_id, 'document_view',
      v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
    );
  end if;
  if v_scope is null then
    raise exception 'cccd qr read denied' using errcode = '42501';
  end if;

  return v_scope;
end;
$function$;

create or replace function public.direct_entry__internal_resolve_cccd_review_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_project_id text,
  p_is_full_admin boolean,
  p_team_leader_team_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_auth text;
begin
  v_auth := public.direct_entry_resolve_direct_edit_authority(
    p_auth_subject,
    p_app_user_id,
    p_entry_owner,
    p_team_id,
    p_project_id,
    p_is_full_admin,
    p_team_leader_team_id
  );
  if v_auth is not null then
    return v_auth;
  end if;

  if p_entry_owner = p_app_user_id then
    return 'creator_own';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
       or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
      return 'all';
    end if;
    if p_team_id is not null and (
      public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'entry_admin', 'CONTEXT_TEAM', p_team_id::text
      )
      or public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'change_review', 'CONTEXT_TEAM', p_team_id::text
      )
    ) then
      return 'team';
    end if;
    return null;
  end if;

  if public.direct_entry_has_entry_access(
       p_app_user_id, 'entry_admin', p_entry_owner, p_team_id, null
     )
     or public.direct_entry_has_entry_access(
       p_app_user_id, 'change_review', p_entry_owner, p_team_id, null
     ) then
    if public.direct_entry_has_scope(p_app_user_id, 'all') then
      return 'all';
    elsif p_team_id is not null then
      return 'team';
    end if;
  end if;

  return null;
end;
$function$;

create or replace function public.direct_entry_list_cccd_review_queue(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_status_filter text default 'NEEDS_REVIEW'::text,
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
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_filter text := coalesce(nullif(btrim(p_status_filter), ''), 'NEEDS_REVIEW');
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_is_full_admin boolean := false;
  v_team_leader_team_id uuid := null;
  v_has_any_role boolean := false;
  v_counts jsonb;
  v_total integer := 0;
  v_rows jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
begin
  if v_filter not in ('NEEDS_REVIEW', 'MISMATCH', 'QR_UNREADABLE', 'PENDING', 'RESOLVED', 'ALL') then
    raise exception 'invalid cccd review status filter' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid cccd review page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid cccd review page size' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    v_is_full_admin := false;
  end;

  begin
    v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    v_team_leader_team_id := null;
  end;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
    v_has_any_role := v_is_full_admin
      or v_team_leader_team_id is not null
      or exists (
        select 1
          from pg_catalog.jsonb_to_recordset(v_grants) as g(
            capability text,
            scope_kind text,
            scope_id text
          )
         where g.capability in (
           'entry_create',
           'entry_own',
           'submission_create',
           'document_upload',
           'document_view',
           'entry_privileged_edit',
           'entry_admin',
           'change_review',
           'change_request_create'
         )
           and (
             (g.scope_kind = 'ALL' and g.scope_id is null)
             or (g.scope_kind = 'OWN' and g.scope_id is null)
             or (g.scope_kind = 'CONTEXT_TEAM' and g.scope_id is not null)
             or (g.scope_kind = 'CONTEXT_PROJECT' and g.scope_id is not null)
           )
      )
      or public.direct_entry_actor_has_project_assignment(p_app_user_id);
  else
    v_has_any_role := v_is_full_admin
      or v_team_leader_team_id is not null
      or exists (
        select 1
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_app_user_id
           and g.is_current
           and g.capability in (
             'entry_create',
             'entry_own',
             'submission_create',
             'document_upload',
             'document_view',
             'pii_view',
             'entry_privileged_edit',
             'entry_admin',
             'change_review',
             'change_request_create'
           )
      )
      or exists (
        select 1
          from public.direct_entry_app_user_recruiter_links l
          join public.direct_entry_project_manager_assignments pma
            on pma.manager_recruiter_id = l.recruiter_id
           and pma.is_current
         where l.app_user_id = p_app_user_id
           and l.verified
           and l.is_current
      );
  end if;

  if not v_has_any_role then
    raise exception 'cccd review queue denied' using errcode = '42501';
  end if;

  with scoped as (
    select r.*,
           e.version as entry_version,
           e.submission_id,
           e.project_id,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.recruiter_id,
           e.team_id,
           e.provider_type,
           e.labor_type,
           e.created_by_user_id,
           public.direct_entry__internal_resolve_cccd_review_authority(
             p_auth_subject,
             p_app_user_id,
             e.created_by_user_id,
             e.team_id,
             e.project_id,
             v_is_full_admin,
             v_team_leader_team_id
           ) as actor_authority
      from public.direct_entry_cccd_reconciliations r
      join public.direct_entries e
        on e.entry_id = r.entry_id
     where e.deleted_at is null
       and e.voided_at is null
  ),
  authorized as (
    select s.*
      from scoped s
     where s.actor_authority is not null
  ),
  filtered as (
    select a.*
      from authorized a
     where (
       (v_filter = 'NEEDS_REVIEW' and a.status in ('MISMATCH', 'QR_UNREADABLE'))
       or (v_filter = 'MISMATCH' and a.status = 'MISMATCH')
       or (v_filter = 'QR_UNREADABLE' and a.status = 'QR_UNREADABLE')
       or (v_filter = 'PENDING' and a.status = 'PENDING')
       or (v_filter = 'RESOLVED' and a.status in ('MATCHED_INITIAL', 'RESOLVED_FROM_QR', 'RESOLVED_EDITED_CCCD'))
       or v_filter = 'ALL'
     )
  ),
  paged as (
    select f.*
      from filtered f
     order by
       case f.status
         when 'MISMATCH' then 0
         when 'QR_UNREADABLE' then 1
         when 'PENDING' then 2
         else 3
       end asc,
       f.updated_at desc,
       f.entry_id asc
     limit v_page_size + 1
    offset v_offset
  )
  select jsonb_build_object(
           'needs_review', count(*) filter (where a.status in ('MISMATCH', 'QR_UNREADABLE'))::int,
           'mismatch', count(*) filter (where a.status = 'MISMATCH')::int,
           'qr_unreadable', count(*) filter (where a.status = 'QR_UNREADABLE')::int,
           'pending', count(*) filter (where a.status = 'PENDING')::int,
           'resolved', count(*) filter (where a.status in ('MATCHED_INITIAL', 'RESOLVED_FROM_QR', 'RESOLVED_EDITED_CCCD'))::int,
           'all', count(*)::int
         ),
         coalesce((select count(*)::int from filtered), 0),
         coalesce((
           select jsonb_agg(item_row.item_json order by item_row.ord)
             from (
               select row_number() over (
                        order by
                          case p.status
                            when 'MISMATCH' then 0
                            when 'QR_UNREADABLE' then 1
                            when 'PENDING' then 2
                            else 3
                          end asc,
                          p.updated_at desc,
                          p.entry_id asc
                      ) as ord,
                      jsonb_build_object(
                        'entry_id', p.entry_id,
                        'entry_version', p.entry_version,
                        'submission_state', coalesce(sub.state, 'DRAFT'),
                        'employee_code', p.employee_code,
                        'project_id', p.project_id,
                        'project_display', coalesce(pj.display_name, p.project_id),
                        'recruiter_id', p.recruiter_id,
                        'recruiter_display', coalesce(rec.display_name, ''),
                        'team_id', case when p.provider_type = 'vendor' then null else p.team_id end,
                        'team_display', case
                          when p.provider_type = 'vendor' then 'Không áp dụng'
                          else coalesce(tm.display_name, '')
                        end,
                        'provider_type', p.provider_type,
                        'labor_type', p.labor_type,
                        'first_work_date', to_char(p.first_work_date, 'YYYY-MM-DD'),
                        'created_by_user_id', p.created_by_user_id,
                        'created_by_display', coalesce(creator.display_name, ''),
                        'actor_authority', p.actor_authority,
                        'reconciliation_status', p.status,
                        'entered_national_id', p.entered_national_id,
                        'entered_national_id_masked', case
                          when p.entered_national_id is not null and length(p.entered_national_id) >= 4
                            then '••••••••' || right(p.entered_national_id, 4)
                          else null
                        end,
                        'qr_national_id', p.qr_national_id,
                        'qr_national_id_masked', case
                          when p.qr_national_id is not null and length(p.qr_national_id) >= 4
                            then '••••••••' || right(p.qr_national_id, 4)
                          else null
                        end,
                        'worker_details', jsonb_build_object(
                          'display_name', coalesce(p.worker_details->>'display_name', ''),
                          'date_of_birth', coalesce(p.worker_details->'date_of_birth', '{"state":"omitted"}'::jsonb),
                          'gender', coalesce(p.worker_details->'gender', '{"state":"omitted"}'::jsonb),
                          'address', coalesce(p.worker_details->'address', '{"state":"omitted"}'::jsonb),
                          'phone', coalesce(p.worker_details->'phone', '{"state":"omitted"}'::jsonb),
                          'national_id_issued_at', coalesce(p.worker_details->'national_id_issued_at', '{"state":"omitted"}'::jsonb),
                          'national_id_issued_place', coalesce(p.worker_details->'national_id_issued_place', '{"state":"omitted"}'::jsonb)
                        ),
                        'extracted_fields', coalesce(p.extracted_fields, '{}'::jsonb),
                        'auto_applied_fields', to_jsonb(coalesce(p.auto_applied_fields, '{}'::text[])),
                        'matched_document_id', p.matched_document_id,
                        'matched_document_type', p.matched_document_type,
                        'matched_document_version', p.matched_document_version,
                        'last_error_code', p.last_error_code,
                        'last_error_field', p.last_error_field,
                        'resolved_at', case
                          when p.resolved_at is null then null
                          else to_char(p.resolved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                        end,
                        'resolved_by_user_id', p.resolved_by_user_id,
                        'resolved_by_display', resolver.display_name,
                        'resolution_action', p.resolution_action,
                        'resolution_note', p.resolution_note,
                        'updated_at', to_char(p.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                        'documents', coalesce((
                          select jsonb_agg(
                                   jsonb_build_object(
                                     'document_id', cd.document_id,
                                     'document_type', cd.document_type,
                                     'document_version', cd.version,
                                     'mime_type', cd.mime_type,
                                     'size_bytes', cd.size_bytes,
                                     'qr_status', q.status,
                                     'qr_reconciliation_status', q.reconciliation_status,
                                     'qr_error_code', q.error_code,
                                     'qr_error_field', q.error_field,
                                     'qr_candidate_data', q.candidate_data
                                   )
                                   order by
                                     case when cd.document_type = 'CCCD_FRONT' then 0 else 1 end asc,
                                     cd.version desc
                                 )
                            from public.direct_entry_current_documents cd
                            left join public.direct_entry_cccd_qr_extractions q
                              on q.document_id = cd.document_id
                           where cd.candidate_id = p.candidate_id
                             and cd.document_type in ('CCCD_FRONT', 'CCCD_BACK')
                             and cd.mime_type in ('image/jpeg', 'image/png')
                        ), '[]'::jsonb)
                      ) as item_json
                 from paged p
                 left join public.direct_entry_submissions sub on sub.submission_id = p.submission_id
                 left join public.direct_entry_projects pj on pj.project_id = p.project_id
                 left join public.recruiters rec on rec.recruiter_id = p.recruiter_id
                 left join public.teams tm on tm.team_id = p.team_id
                 left join public.direct_entry_app_users creator on creator.app_user_id = p.created_by_user_id
                 left join public.direct_entry_app_users resolver on resolver.app_user_id = p.resolved_by_user_id
             ) item_row
         ), '[]'::jsonb)
    into v_counts, v_total, v_rows
    from authorized a;

  v_has_more := jsonb_array_length(v_rows) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb)
      into v_items
      from jsonb_array_elements(v_rows) with ordinality as t(value, ord)
     where t.ord <= v_page_size;
  else
    v_items := v_rows;
  end if;

  return jsonb_build_object(
    'status_filter', v_filter,
    'page', v_page,
    'page_size', v_page_size,
    'total_items', v_total,
    'has_more', v_has_more,
    'counts', v_counts,
    'items', v_items
  );
end;
$function$;

create or replace function public.direct_entry_list_missing_document_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_missing_type text default null::text,
  p_project_id text default null::text,
  p_employment_status text default null::text,
  p_search text default null::text,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_missing_type text := coalesce(nullif(pg_catalog.upper(pg_catalog.btrim(p_missing_type)), ''), 'ALL');
  v_employment_status text := coalesce(nullif(pg_catalog.upper(pg_catalog.btrim(p_employment_status)), ''), 'ALL');
  v_project_id text := nullif(pg_catalog.btrim(p_project_id), '');
  v_search text := nullif(pg_catalog.btrim(p_search), '');
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_today date := public.direct_entry_authorization_date();
  v_authz_managed boolean := false;
  v_is_global_viewer boolean := false;
  v_has_doc_upload_all boolean := false;
  v_has_doc_upload_own boolean := false;
  v_managed_project_ids text[] := array[]::text[];
  v_recruiter_link_count integer := 0;
  v_single_recruiter_id uuid;
  v_recruiter_ids uuid[] := array[]::uuid[];
  v_scope_kind text;
  v_can_upload boolean := false;
  v_summary jsonb;
  v_project_options jsonb;
  v_total_count integer := 0;
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
begin
  if v_missing_type not in ('ALL', 'WORKER_PORTRAIT', 'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT') then
    raise exception 'MISSING_DOCUMENTS_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_employment_status not in ('ALL', 'ON', 'UNCONFIRMED') then
    raise exception 'MISSING_DOCUMENTS_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_project_id is not null and (
    pg_catalog.char_length(v_project_id) > 128
    or v_project_id ~ '[[:cntrl:]]'
  ) then
    raise exception 'MISSING_DOCUMENTS_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_search is not null and (
    pg_catalog.char_length(v_search) > 100
    or v_search ~ '[[:cntrl:]]'
  ) then
    raise exception 'MISSING_DOCUMENTS_QUERY_INVALID' using errcode = '22023';
  end if;

  if v_page < 1 or v_page > 1000 or v_page_size < 1 or v_page_size > 100 then
    raise exception 'MISSING_DOCUMENTS_QUERY_INVALID' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  v_is_global_viewer :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'worker_edit_history_view', 'ALL', null);
  v_has_doc_upload_all :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null);
  v_has_doc_upload_own :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'OWN', null);

  select coalesce(array_agg(distinct pr.project_id order by pr.project_id), array[]::text[])
    into v_managed_project_ids
    from public.direct_entry_projects pr
   where pr.active
     and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, pr.project_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    select count(*)::integer
      into v_recruiter_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_app_user_id
       and l.verified
       and l.is_current;

    if v_recruiter_link_count = 1 then
      select l.recruiter_id
        into v_single_recruiter_id
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r
          on r.recruiter_id = l.recruiter_id
         and r.active
        join public.direct_entry_app_users u
          on u.app_user_id = l.app_user_id
         and u.enabled
         and u.account_type = 'NORMAL'
       where l.app_user_id = p_app_user_id
         and l.verified
         and l.is_current
         and not l.suspended_by_account_disable
         and l.valid_from <= v_today
         and (l.valid_to is null or (l.valid_to > l.valid_from and v_today < l.valid_to))
         and not exists (
           select 1
             from public.direct_entry_app_user_recruiter_links other_link
            where other_link.recruiter_id = l.recruiter_id
              and other_link.app_user_id <> p_app_user_id
              and other_link.verified
              and other_link.is_current
              and not other_link.suspended_by_account_disable
              and other_link.valid_from <= v_today
              and (other_link.valid_to is null or (other_link.valid_to > other_link.valid_from and v_today < other_link.valid_to))
         );
    end if;

    v_recruiter_ids := case
      when v_single_recruiter_id is not null then array[v_single_recruiter_id]
      else array[]::uuid[]
    end;
  else
    select coalesce(array_agg(distinct l.recruiter_id order by l.recruiter_id), array[]::uuid[])
      into v_recruiter_ids
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r
        on r.recruiter_id = l.recruiter_id
       and r.active
     where l.app_user_id = p_app_user_id
       and l.verified
       and l.is_current
       and not l.suspended_by_account_disable;
  end if;

  if v_is_global_viewer then
    v_scope_kind := 'all';
    v_can_upload := v_has_doc_upload_all;
  elsif pg_catalog.cardinality(v_managed_project_ids) > 0 then
    v_scope_kind := 'project';
    v_can_upload := (v_has_doc_upload_all or v_has_doc_upload_own);
  elsif pg_catalog.cardinality(v_recruiter_ids) > 0 then
    v_scope_kind := 'recruited';
    v_can_upload := false;
  else
    raise exception 'MISSING_DOCUMENTS_ACCESS_DENIED' using errcode = '42501';
  end if;

  with eligible_entries as (
    select e.entry_id,
           e.version as entry_version,
           e.candidate_id,
           e.submission_id,
           e.project_id,
           coalesce(pr.display_name, e.project_id) as project_display,
           e.recruiter_id,
           coalesce(rc.display_name, '') as recruiter_display,
           e.first_work_date,
           e.employee_code,
           e.worker_details,
           e.created_by_user_id,
           coalesce(creator.display_name, '') as created_by_display,
           coalesce(st.status, 'UNCONFIRMED') as employment_status,
           coalesce(
             nullif(pg_catalog.btrim(e.worker_details->>'display_name'), ''),
             '(Chưa có họ tên)'
           ) as display_name,
           case
             when e.worker_details->'national_id'->>'state' = 'provided'
               then e.worker_details->'national_id'->>'value'
             else null
           end as national_id,
           array_remove(array[
             case when not exists (
               select 1
                 from public.direct_entry_current_documents cd
                where cd.candidate_id = e.candidate_id
                  and cd.document_type = 'WORKER_PORTRAIT'
             ) then 'WORKER_PORTRAIT' end,
             case when not exists (
               select 1
                 from public.direct_entry_current_documents cd
                where cd.candidate_id = e.candidate_id
                  and cd.document_type = 'CCCD_FRONT'
             ) then 'CCCD_FRONT' end,
             case when not exists (
               select 1
                 from public.direct_entry_current_documents cd
                where cd.candidate_id = e.candidate_id
                  and cd.document_type = 'CCCD_BACK'
             ) then 'CCCD_BACK' end,
             case when not exists (
               select 1
                 from public.direct_entry_current_documents cd
                where cd.candidate_id = e.candidate_id
                  and cd.document_type = 'EMPLOYMENT_CONTRACT'
             ) then 'EMPLOYMENT_CONTRACT' end
           ], null) as missing_documents
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
       and s.state in ('DRAFT', 'SUBMITTED')
      left join public.direct_entry_projects pr
        on pr.project_id = e.project_id
      left join public.recruiters rc
        on rc.recruiter_id = e.recruiter_id
      left join public.direct_entry_app_users creator
        on creator.app_user_id = e.created_by_user_id
      left join lateral (
        select ev.status
          from public.direct_entry_employment_status_events ev
         where ev.entry_id = e.entry_id
         order by ev.version desc
         limit 1
      ) st on true
     where e.deleted_at is null
       and e.voided_at is null
       and coalesce(st.status, 'UNCONFIRMED') in ('ON', 'UNCONFIRMED')
       and (
         (v_scope_kind = 'all')
         or (v_scope_kind = 'project' and e.project_id = any(v_managed_project_ids))
         or (v_scope_kind = 'recruited' and e.recruiter_id = any(v_recruiter_ids))
       )
  ),
  missing_only as (
    select ee.*
      from eligible_entries ee
     where pg_catalog.cardinality(ee.missing_documents) > 0
  ),
  base_filtered as (
    select m.*
      from missing_only m
     where (v_project_id is null or m.project_id = v_project_id)
       and (v_employment_status = 'ALL' or m.employment_status = v_employment_status)
       and (
         v_search is null
         or pg_catalog.strpos(pg_catalog.lower(m.display_name), pg_catalog.lower(v_search)) > 0
         or pg_catalog.strpos(pg_catalog.lower(coalesce(m.national_id, '')), pg_catalog.lower(v_search)) > 0
         or pg_catalog.strpos(pg_catalog.lower(coalesce(m.employee_code, '')), pg_catalog.lower(v_search)) > 0
       )
  ),
  type_filtered as (
    select bf.*
      from base_filtered bf
     where v_missing_type = 'ALL' or v_missing_type = any(bf.missing_documents)
  ),
  paged as (
    select tf.*
      from type_filtered tf
     order by tf.first_work_date desc, tf.entry_id asc
     limit v_page_size + 1
    offset v_offset
  ),
  page_rows as (
    select *
      from paged
     order by first_work_date desc, entry_id asc
     limit v_page_size
  )
  select jsonb_build_object(
           'total_workers', count(*)::int,
           'missing_worker_portrait', count(*) filter (where 'WORKER_PORTRAIT' = any(bf.missing_documents))::int,
           'missing_cccd_front', count(*) filter (where 'CCCD_FRONT' = any(bf.missing_documents))::int,
           'missing_cccd_back', count(*) filter (where 'CCCD_BACK' = any(bf.missing_documents))::int,
           'missing_employment_contract', count(*) filter (where 'EMPLOYMENT_CONTRACT' = any(bf.missing_documents))::int
         ),
         coalesce((select count(*)::int from type_filtered), 0),
         coalesce((select count(*) > v_page_size from paged), false),
         coalesce((
           select jsonb_agg(
                    jsonb_build_object(
                      'project_id', po.project_id,
                      'project_display', po.project_display
                    )
                    order by po.project_display asc, po.project_id asc
                  )
             from (
               select distinct m.project_id, m.project_display
                 from missing_only m
             ) po
         ), '[]'::jsonb),
         coalesce((
           select jsonb_agg(item_row.item_json order by item_row.ord)
             from (
               select row_number() over (order by pr.first_work_date desc, pr.entry_id asc) as ord,
                      jsonb_build_object(
                        'entry_id', pr.entry_id,
                        'entry_version', pr.entry_version,
                        'employee_code', pr.employee_code,
                        'display_name', pr.display_name,
                        'national_id', pr.national_id,
                        'project_id', pr.project_id,
                        'project_display', pr.project_display,
                        'recruiter_id', pr.recruiter_id,
                        'recruiter_display', pr.recruiter_display,
                        'first_work_date', pg_catalog.to_char(pr.first_work_date, 'YYYY-MM-DD'),
                        'employment_status', pr.employment_status,
                        'created_by_user_id', pr.created_by_user_id,
                        'created_by_display', pr.created_by_display,
                        'missing_documents', to_jsonb(pr.missing_documents),
                        'can_upload', v_can_upload,
                        'documents', coalesce((
                          select jsonb_agg(
                                   jsonb_build_object(
                                     'document_id', cd.document_id,
                                     'document_type', cd.document_type,
                                     'document_version', cd.version,
                                     'mime_type', cd.mime_type,
                                     'size_bytes', cd.size_bytes,
                                     'updated_at', pg_catalog.to_char(cd.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
                                   )
                                   order by
                                     case cd.document_type
                                       when 'WORKER_PORTRAIT' then 0
                                       when 'CCCD_FRONT' then 1
                                       when 'CCCD_BACK' then 2
                                       else 3
                                     end asc
                                 )
                            from public.direct_entry_current_documents cd
                           where cd.candidate_id = pr.candidate_id
                             and cd.document_type in ('WORKER_PORTRAIT', 'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT')
                        ), '[]'::jsonb)
                      ) as item_json
                 from page_rows pr
             ) item_row
         ), '[]'::jsonb)
    into v_summary, v_total_count, v_has_more, v_project_options, v_items
    from base_filtered bf;

  return jsonb_build_object(
    'scope_kind', v_scope_kind,
    'can_upload', v_can_upload,
    'filter_missing_type', v_missing_type,
    'filter_employment_status', v_employment_status,
    'filter_project_id', v_project_id,
    'filter_search', v_search,
    'page', v_page,
    'page_size', v_page_size,
    'total_count', v_total_count,
    'has_more', v_has_more,
    'summary', coalesce(v_summary, jsonb_build_object(
      'total_workers', 0,
      'missing_worker_portrait', 0,
      'missing_cccd_front', 0,
      'missing_cccd_back', 0,
      'missing_employment_contract', 0
    )),
    'project_options', coalesce(v_project_options, '[]'::jsonb),
    'items', coalesce(v_items, '[]'::jsonb)
  );
end;
$function$;

create or replace function public.direct_entry_duplicate_cccd_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page integer,
  p_page_size integer,
  p_managed_only boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_can_withdraw_all boolean := false;
  v_authority text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_managed_only boolean := coalesce(p_managed_only, false);
  v_offset integer;
  v_is_full_admin boolean := false;
  v_current_team_leader_team_id uuid;
  v_total_groups integer := 0;
  v_total_entries integer := 0;
  v_rows jsonb;
  v_has_more boolean := false;
  v_groups jsonb;
begin
  if v_page < 1 or v_page > 1000 then
    raise exception 'duplicate_report_page_invalid' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'duplicate_report_page_size_invalid' using errcode = '22023';
  end if;
  v_offset := (v_page - 1) * v_page_size;

  v_authority :=
    public.direct_entry_assert_duplicate_cccd_reader(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    v_can_withdraw_all :=
      public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'duplicate_cccd_withdraw', 'ALL', null
      );
  else
    v_can_withdraw_all :=
      public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw');
  end if;

  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    v_is_full_admin := true;
  exception when insufficient_privilege then
    v_is_full_admin := false;
  end;

  begin
    v_current_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
  exception when insufficient_privilege then
    v_current_team_leader_team_id := null;
  end;

  with canonical as (
    select e.entry_id,
           e.version as entry_version,
           e.submission_id,
           e.created_by_user_id,
           e.team_id,
           e.project_id,
           e.employee_code,
           e.first_work_date,
           nullif(btrim(coalesce(e.worker_details->>'display_name', '')), '') as display_name,
           public.direct_entry_canonical_national_id(
             e.worker_details->'national_id'->>'value'
           ) as cccd
      from public.direct_entries e
     where e.deleted_at is null and e.voided_at is null
       and e.worker_details->'national_id'->>'state' = 'provided'
  ),
  statused as (
    select c.entry_id,
           c.entry_version,
           c.submission_id,
           c.created_by_user_id,
           c.team_id,
           c.project_id,
           c.employee_code,
           c.first_work_date,
           c.display_name,
           c.cccd,
           coalesce((
             select st.status
               from public.direct_entry_employment_status_events st
              where st.entry_id = c.entry_id
              order by st.version desc
              limit 1
           ), 'UNCONFIRMED') as latest_status,
           case
             when c.project_id is not null and c.first_work_date is not null then
               count(*) over (
                 partition by c.cccd, c.project_id, c.first_work_date
               )
             else 1
           end as same_project_day_count
      from canonical c
     where public.direct_entry_is_canonical_national_id(c.cccd)
  ),
  live as (
    select s.entry_id,
           s.entry_version,
           s.submission_id,
           s.created_by_user_id,
           s.team_id,
           s.project_id,
           s.employee_code,
           s.first_work_date,
           s.display_name,
           s.cccd,
           s.latest_status
      from statused s
     where s.same_project_day_count >= 2
  ),
  managed_projects as (
    select distinct l.project_id
      from live l
     where v_managed_only
       and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, l.project_id)
  ),
  grouped as (
    select l.cccd,
           count(*)::int as profile_count,
           count(distinct l.project_id)::int as project_count,
           count(*) filter (where l.latest_status = 'ON')::int as active_profile_count,
           min(l.first_work_date) as earliest_first_work_date,
           max(l.first_work_date) as latest_first_work_date
      from live l
     group by l.cccd
    having count(*) >= 2
       and (
         not v_managed_only
         or bool_or(exists (
           select 1 from managed_projects mp where mp.project_id = l.project_id
         ))
       )
  ),
  page_groups as (
    select g.*
      from grouped g
     order by g.cccd
     limit v_page_size + 1
    offset v_offset
  )
  select coalesce((select count(*)::int from grouped), 0),
         coalesce((select sum(g.profile_count)::int from grouped g), 0),
         coalesce((
           select jsonb_agg(gp.row_json order by gp.cccd)
             from (
               select pg.cccd,
                      jsonb_build_object(
                        'cccd_last4', right(pg.cccd, 4),
                        'cccd_length', length(pg.cccd),
                        'profile_count', pg.profile_count,
                        'project_count', pg.project_count,
                        'active_profile_count', pg.active_profile_count,
                        'first_work_date',
                          pg_catalog.to_char(pg.earliest_first_work_date, 'YYYY-MM-DD'),
                        'latest_first_work_date',
                          pg_catalog.to_char(pg.latest_first_work_date, 'YYYY-MM-DD'),
                        'episodes', coalesce((
                          select jsonb_agg(jsonb_build_object(
                                   'entry_id', l.entry_id,
                                   'entry_version', l.entry_version,
                                   'employee_code', l.employee_code,
                                   'display_name', l.display_name,
                                   'project_id', l.project_id,
                                   'project_display', pj.display_name,
                                   'first_work_date',
                                     pg_catalog.to_char(l.first_work_date, 'YYYY-MM-DD'),
                                   'latest_status', l.latest_status,
                                   'active', l.latest_status = 'ON',
                                   'can_mark_off', (
                                     l.latest_status = 'ON'
                                     and coalesce(sub.state, '') in ('DRAFT', 'SUBMITTED')
                                     and public.direct_entry_resolve_direct_edit_authority(
                                       p_auth_subject,
                                       p_app_user_id,
                                       l.created_by_user_id,
                                       l.team_id,
                                       l.project_id,
                                       v_is_full_admin,
                                       v_current_team_leader_team_id
                                     ) is not null
                                   ),
                                   'can_self_withdraw', (
                                     l.latest_status in ('ON','OFF')
                                     and exists (
                                       select 1
                                         from statused same_day_active
                                        where same_day_active.entry_id <> l.entry_id
                                          and same_day_active.cccd = l.cccd
                                          and same_day_active.project_id = l.project_id
                                          and same_day_active.first_work_date = l.first_work_date
                                          and same_day_active.latest_status in ('ON','OFF')
                                     )
                                     and (
                                       l.created_by_user_id = p_app_user_id
                                       or v_can_withdraw_all
                                       or public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, l.project_id)
                                     )
                                   )
                                 ) order by l.first_work_date asc, l.entry_id asc)
                            from live l
                            left join public.direct_entry_projects pj
                              on pj.project_id = l.project_id
                            left join public.direct_entry_submissions sub
                              on sub.submission_id = l.submission_id
                           where l.cccd = pg.cccd
                        ), '[]'::jsonb)
                      ) as row_json
                 from page_groups pg
             ) gp
         ), '[]'::jsonb)
    into v_total_groups, v_total_entries, v_rows;

  v_has_more := jsonb_array_length(v_rows) > v_page_size;
  if v_has_more then
    select coalesce(jsonb_agg(t.value order by t.ord), '[]'::jsonb)
      into v_groups
      from jsonb_array_elements(v_rows) with ordinality as t(value, ord)
     where t.ord <= v_page_size;
  else
    v_groups := v_rows;
  end if;

  return jsonb_build_object(
    'authority', v_authority,
    'authorization_date', public.direct_entry_authorization_date(),
    'page', v_page,
    'page_size', v_page_size,
    'total_groups', v_total_groups,
    'total_entries', v_total_entries,
    'has_more', v_has_more,
    'groups', v_groups
  );
end;
$function$;

create or replace function public.direct_entry_self_withdraw_duplicate_cccd(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_has_withdraw_cap boolean := false;
  v_entry public.direct_entries%rowtype;
  v_cccd text;
  v_target_status text;
  v_other_active_count integer := 0;
  v_reason_id uuid;
  v_revision_id uuid;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_entry_id is null then
    raise exception 'entry id required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected entry version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null
     or length(btrim(p_idempotency_key)) = 0
     or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid idempotency key' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    v_has_withdraw_cap :=
      public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'duplicate_cccd_withdraw', 'ALL', null
      );
  else
    v_has_withdraw_cap :=
      public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw');
  end if;

  select * into v_entry
    from public.direct_entries
   where entry_id = p_entry_id;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;
  if v_entry.created_by_user_id is distinct from p_app_user_id
     and not v_has_withdraw_cap
     and not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_entry.project_id) then
    raise exception 'self withdraw requires entry creator, assigned project manager, or duplicate CCCD withdraw capability' using errcode = '42501';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'entry_self_withdraw_duplicate_cccd',
    p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id,
      'expected_version', p_expected_version,
      'reason', p_reason
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_cccd := case
    when v_entry.worker_details->'national_id'->>'state' = 'provided' then
      public.direct_entry_canonical_national_id(
        v_entry.worker_details->'national_id'->>'value'
      )
    else null
  end;

  perform 1
    from public.direct_entries e
   where e.entry_id = p_entry_id
      or (
        public.direct_entry_is_canonical_national_id(v_cccd)
        and e.deleted_at is null
        and e.worker_details->'national_id'->>'state' = 'provided'
        and public.direct_entry_canonical_national_id(
              e.worker_details->'national_id'->>'value'
            ) = v_cccd
      )
   order by e.entry_id asc
   for update;

  select * into v_entry
    from public.direct_entries
   where entry_id = p_entry_id;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  -- Post-lock re-check ensures an entry creator disabled mid-race cannot void post-disable.
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if coalesce(v_authz_managed, false) then
    v_has_withdraw_cap :=
      public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'duplicate_cccd_withdraw', 'ALL', null
      );
  else
    v_has_withdraw_cap :=
      public.direct_entry_has_capability(p_app_user_id, 'duplicate_cccd_withdraw');
  end if;

  if v_entry.created_by_user_id is distinct from p_app_user_id
     and not v_has_withdraw_cap
     and not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_entry.project_id) then
    raise exception 'self withdraw requires entry creator, assigned project manager, or duplicate CCCD withdraw capability' using errcode = '42501';
  end if;
  if v_entry.voided_at is not null then
    raise exception 'entry already voided' using errcode = 'PT409';
  end if;
  if v_entry.version <> p_expected_version then
    raise exception 'entry version conflict' using errcode = 'PT409';
  end if;

  v_cccd := case
    when v_entry.worker_details->'national_id'->>'state' = 'provided' then
      public.direct_entry_canonical_national_id(
        v_entry.worker_details->'national_id'->>'value'
      )
    else null
  end;
  if not public.direct_entry_is_canonical_national_id(v_cccd) then
    raise exception 'self withdraw target is not an active duplicate' using errcode = 'PT409';
  end if;

  select coalesce((
    select st.status
      from public.direct_entry_employment_status_events st
     where st.entry_id = v_entry.entry_id
     order by st.version desc
     limit 1
  ), 'UNCONFIRMED')
    into v_target_status;
  if v_target_status not in ('ON', 'OFF')
     or v_entry.project_id is null
     or v_entry.first_work_date is null then
    raise exception 'self withdraw target is not in a same-project same-day duplicate cluster'
      using errcode = 'PT409';
  end if;

  select count(*)::int
    into v_other_active_count
    from public.direct_entries e
   where e.entry_id <> v_entry.entry_id
     and e.deleted_at is null
     and e.voided_at is null
     and e.worker_details->'national_id'->>'state' = 'provided'
     and public.direct_entry_canonical_national_id(
           e.worker_details->'national_id'->>'value'
         ) = v_cccd
     and e.project_id = v_entry.project_id
     and e.first_work_date = v_entry.first_work_date
     and coalesce((
           select st.status
             from public.direct_entry_employment_status_events st
            where st.entry_id = e.entry_id
            order by st.version desc
            limit 1
         ), 'UNCONFIRMED') in ('ON', 'OFF');

  if v_other_active_count < 1 then
    raise exception 'self withdraw target is not an active duplicate' using errcode = 'PT409';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_revision_id := public.direct_entry__internal_apply_entry_void(
    p_auth_subject,
    p_app_user_id,
    v_entry.entry_id,
    v_entry.version,
    v_reason_id,
    'entry_self_withdraw_duplicate_cccd',
    case
      when v_entry.created_by_user_id = p_app_user_id then 'entry_creator_self_withdraw'
      when v_has_withdraw_cap then 'duplicate_cccd_withdraw'
      else 'project_manager_self_withdraw'
    end,
    case
      when v_entry.created_by_user_id = p_app_user_id then 'own'
      when v_has_withdraw_cap then 'all'
      else 'project'
    end,
    null
  );

  v_result := jsonb_build_object(
    'entry_id', v_entry.entry_id,
    'version', v_entry.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'entry_self_withdraw_duplicate_cccd', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

-- =============================================================================
-- SECTION 4: Change Requests
-- =============================================================================

create or replace function public.direct_entry_assert_change_request_capabilities(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb;
  v_capability text;
  v_tl_team_id uuid;
  v_team_leader_review boolean;
begin
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_tl_team_id := public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id);

  if exists (
    select 1 from public.direct_entry_change_request_items i
     where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID'
  ) then
    if (
      select count(*) from public.direct_entry_change_request_items i
       where i.request_id = p_request_id
    ) <> 1 then
      raise exception 'entry void request must contain one item' using errcode = '42501';
    end if;

    if v_tl_team_id is not null then
      if coalesce(v_authz_managed, false) then
        perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
        if not public.direct_entry_authz__internal_has_paired_capability(
          p_app_user_id, 'team_manager_assign', 'CONTEXT_TEAM', v_tl_team_id::text
        ) then
          raise exception 'capability denied' using errcode = '42501';
        end if;
      else
        perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'team_manager_assign');
      end if;
      return;
    end if;

    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
    if coalesce(v_authz_managed, false) then
      if not (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
        or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
        or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null)
      ) then
        raise exception 'entry void review scope/capability denied' using errcode = '42501';
      end if;
    elsif not public.direct_entry_has_scope(p_app_user_id, 'all')
       or not (
         public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
         or public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
         or public.direct_entry_has_capability(p_app_user_id, 'change_review')
       ) then
      raise exception 'entry void review scope/capability denied' using errcode = '42501';
    end if;
    return;
  end if;

  v_team_leader_review := v_tl_team_id is not null;

  if coalesce(v_authz_managed, false) then
    perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
    if v_team_leader_review then
      if not public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'team_manager_assign', 'CONTEXT_TEAM', v_tl_team_id::text
      ) then
        raise exception 'capability denied' using errcode = '42501';
      end if;
    else
      if not public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
        v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
        if exists (
          select 1
            from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
           where g.capability = 'change_review'
        ) then
          raise exception 'scope denied' using errcode = '42501';
        end if;
        raise exception 'capability denied' using errcode = '42501';
      end if;
    end if;

    for v_capability in
      select capability
        from unnest(public.direct_entry_change_request_required_capabilities(p_request_id)) as required(capability)
       where not (v_team_leader_review and capability = 'change_review')
    loop
      if v_team_leader_review then
        if not (
          public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, v_capability, 'ALL', null)
          or public.direct_entry_authz__internal_has_paired_capability(
            p_app_user_id, v_capability, 'CONTEXT_TEAM', v_tl_team_id::text
          )
        ) then
          raise exception 'capability denied' using errcode = '42501';
        end if;
      else
        if not public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, v_capability, 'ALL', null) then
          raise exception 'capability denied' using errcode = '42501';
        end if;
      end if;
    end loop;
    return;
  end if;

  if v_team_leader_review then
    perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'team_manager_assign');
  else
    perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'change_review');
    if not public.direct_entry_has_scope(p_app_user_id, 'all') then
      raise exception 'scope denied' using errcode = '42501';
    end if;
  end if;
  for v_capability in
    select capability
      from unnest(public.direct_entry_change_request_required_capabilities(p_request_id)) as required(capability)
     where not (v_team_leader_review and capability = 'change_review')
  loop
    if not public.direct_entry_has_capability(p_app_user_id, v_capability) then
      raise exception 'capability denied' using errcode = '42501';
    end if;
  end loop;
end;
$function$;

create or replace function public.direct_entry_change_request_audience(
  p_app_user_id uuid,
  p_proposer_user_id uuid,
  p_request_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_items integer;
  v_accessible integer;
  v_is_proposer boolean;
begin
  if p_app_user_id is null or p_proposer_user_id is null or p_request_id is null then
    return 'NONE';
  end if;
  v_is_proposer := p_proposer_user_id = p_app_user_id;
  select count(*) into v_items
    from public.direct_entry_change_request_items i
   where i.request_id = p_request_id;
  if v_items < 1 then return 'NONE'; end if;

  if v_is_proposer then
    if exists(
      select 1 from public.direct_entry_change_request_items i
       where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID'
    ) then
      select count(*) into v_accessible
        from public.direct_entry_change_request_items i
        join public.direct_entries e on e.entry_id = i.entry_id
        join public.direct_entry_submissions s on s.submission_id = e.submission_id
       where i.request_id = p_request_id
         and i.target_kind = 'ENTRY_VOID'
         and e.created_by_user_id = p_app_user_id
         and s.state = 'SUBMITTED';
      if v_accessible = v_items then return 'PROPOSER'; end if;
    end if;
    select count(*) into v_accessible
      from public.direct_entry_change_request_items i
      join public.direct_entries e on e.entry_id = i.entry_id
     where i.request_id = p_request_id
       and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
       and exists(
         select 1 from public.direct_entry_submissions s
          where s.submission_id = e.submission_id and s.state = 'SUBMITTED'
       );
    if v_accessible = v_items then return 'PROPOSER'; end if;
  else
    select coalesce(u.authz_managed, false)
      into v_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id;

    if coalesce(v_authz_managed, false) then
      if exists(
        select 1 from public.direct_entry_change_request_items i
         where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID'
      ) then
        if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null)
           or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
           or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null) then
          return 'REVIEWER';
        end if;
      elsif public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
        return 'REVIEWER';
      end if;
    else
      if exists(
        select 1 from public.direct_entry_change_request_items i
         where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID'
      ) then
        if public.direct_entry_has_scope(p_app_user_id, 'all')
           and (
             public.direct_entry_has_capability(p_app_user_id, 'change_review')
             or public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
             or public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
           ) then
          return 'REVIEWER';
        end if;
      elsif public.direct_entry_has_capability(p_app_user_id, 'change_review')
         and public.direct_entry_has_scope(p_app_user_id, 'all') then
        return 'REVIEWER';
      end if;
    end if;

    if public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) is not null then
      return 'REVIEWER';
    end if;
  end if;
  return 'NONE';
end;
$function$;

create or replace function public.direct_entry_list_global_change_request_history(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page_size integer,
  p_cursor text,
  p_days integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_page_size integer := coalesce(p_page_size, 20);
  v_cursor_stamp text;
  v_cursor_id uuid;
  v_scanned integer;
  v_rows jsonb;
  v_next_cursor text;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if coalesce(v_authz_managed, false) then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
    ) then
      raise exception 'global change request history denied' using errcode = '42501';
    end if;
  elsif not public.direct_entry_has_scope(p_app_user_id, 'all')
     or not (
       public.direct_entry_has_capability(p_app_user_id, 'change_review')
       or public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
     ) then
    raise exception 'global change request history denied' using errcode = '42501';
  end if;

  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_days is not null and p_days not in (3, 7, 30) then
    raise exception 'invalid history window' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with candidates as (
    select r.request_id, r.state, r.version, r.created_at, r.decided_at,
           coalesce(nullif(btrim(decider.display_name), ''), 'Người dùng') as decided_by_display_name,
           coalesce(nullif(btrim(proposer.display_name), ''), 'Người dùng') as proposer_display_name,
           (select string_agg(distinct case i.target_kind
              when 'ENTRY_FIELD' then 'Thông tin người lao động'
              when 'WORKER' then 'Thông tin người lao động'
              when 'PAYMENT' then 'Thông tin ngân hàng'
              when 'WORK_STATUS' then 'Trạng thái làm việc'
              when 'DOCUMENT' then 'Tài liệu hồ sơ'
              else 'Yêu cầu thay đổi' end, ' · ' order by case i.target_kind
              when 'ENTRY_FIELD' then 'Thông tin người lao động'
              when 'WORKER' then 'Thông tin người lao động'
              when 'PAYMENT' then 'Thông tin ngân hàng'
              when 'WORK_STATUS' then 'Trạng thái làm việc'
              when 'DOCUMENT' then 'Tài liệu hồ sơ'
              else 'Yêu cầu thay đổi' end)
              from public.direct_entry_change_request_items i where i.request_id = r.request_id) as summary
      from public.direct_entry_change_requests r
      join public.direct_entry_app_users proposer on proposer.app_user_id = r.proposer_user_id
      join public.direct_entry_app_users decider on decider.app_user_id = r.decided_by_user_id
     where r.state in ('APPROVED', 'REJECTED')
       and (p_days is null or r.decided_at >= now() - pg_catalog.make_interval(days => p_days))
       and (v_cursor_stamp is null or (
         pg_catalog.to_char(r.decided_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
         r.request_id::text
       ) < (v_cursor_stamp, v_cursor_id::text))
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.decided_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
             || ':' || c.request_id::text as cursor
      from candidates c
     order by c.decided_at desc, c.request_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by decided_at desc, request_id desc limit v_page_size
  )
  select (select count(*)::int from page),
    (select coalesce(jsonb_agg(jsonb_build_object(
       'request_id', t.request_id, 'state', t.state, 'version', t.version,
       'created_at', pg_catalog.to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD')
         || 'T' || pg_catalog.to_char(t.created_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z',
       'item_count', (select count(*)::int from public.direct_entry_change_request_items i
                       where i.request_id = t.request_id),
       'entry_ids', (select coalesce(jsonb_agg(i.entry_id order by i.entry_id), '[]'::jsonb)
                       from public.direct_entry_change_request_items i
                      where i.request_id = t.request_id),
       'can_withdraw', false, 'can_decide', false,
       'proposer_display_name', t.proposer_display_name,
       'summary', t.summary,
       'decided_by_display_name', t.decided_by_display_name,
       'decided_at', pg_catalog.to_char(t.decided_at at time zone 'UTC', 'YYYY-MM-DD')
         || 'T' || pg_catalog.to_char(t.decided_at at time zone 'UTC', 'HH24:MI:SS.US') || 'Z'
     ) order by t.decided_at desc, t.request_id desc), '[]'::jsonb) from trimmed t),
    (select t.cursor from trimmed t order by t.decided_at asc, t.request_id asc limit 1)
  into v_scanned, v_rows, v_next_cursor;

  return jsonb_build_object(
    'requests', v_rows,
    'page_size', v_page_size,
    'has_more', v_scanned > v_page_size,
    'next_cursor', case when v_scanned > v_page_size then v_next_cursor else null end
  );
end;
$function$;

create or replace function public.direct_entry_read_change_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_request public.direct_entry_change_requests%rowtype;
  v_audience text;
  v_pii_view boolean;
  v_payment_view boolean;
  v_document_view boolean;
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
    elsif v_request.state in ('APPROVED', 'REJECTED') then
      if coalesce(v_authz_managed, false) then
        if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
           or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null) then
          v_audience := 'AUDITOR';
        end if;
      elsif public.direct_entry_has_scope(p_app_user_id, 'all')
            and (
              public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
              or public.direct_entry_has_capability(p_app_user_id, 'change_review')
            ) then
        v_audience := 'AUDITOR';
      end if;
    end if;
  end if;
  if v_audience = 'NONE' then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;

  v_pii_view := true;
  v_payment_view := true;
  if not coalesce(v_authz_managed, false) then
    v_document_view := public.direct_entry_has_capability(p_app_user_id, 'document_view');
  else
    v_document_view := false;
  end if;

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
                       when not coalesce(v_authz_managed, false) then v_document_view
                       when e.entry_id is null then false
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
                     when not coalesce(v_authz_managed, false) then v_document_view
                     when e.entry_id is null then false
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

create or replace function public.direct_entry_resolve_change_request_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_target_kind text
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_entry public.direct_entries%rowtype;
begin
  select e.* into v_entry
    from public.direct_entries e
   where e.entry_id = p_entry_id and e.deleted_at is null;
  if not found then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if p_target_kind = 'ENTRY_VOID' then
    select coalesce(u.authz_managed, false)
      into v_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id;

    if v_entry.voided_at is not null
       or not exists (
         select 1 from public.direct_entry_submissions s
          where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
       )
       or v_entry.created_by_user_id is distinct from p_app_user_id
       or (
         coalesce(v_authz_managed, false)
         and not public.direct_entry_has_entry_access(
           p_app_user_id, 'change_request_create',
           v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
         )
       )
       or (
         not coalesce(v_authz_managed, false)
         and not public.direct_entry_has_capability(p_app_user_id, 'change_request_create')
       ) then
      raise exception 'entry void request access denied' using errcode = '42501';
    end if;
    return 'creator';
  end if;
  if p_target_kind = 'DOCUMENT' then
    raise exception 'project document change requests are not supported'
      using errcode = '42501';
  end if;

  if not exists (
       select 1 from public.direct_entry_submissions s
        where s.submission_id = v_entry.submission_id and s.state = 'SUBMITTED'
     ) or not public.direct_entry_actor_is_assigned_project_manager(
       p_app_user_id, v_entry.project_id
     ) then
    raise exception 'project change request access denied' using errcode = '42501';
  end if;
  return 'project';
end;
$function$;

create or replace function public.direct_entry_decide_change_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_decision text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_request public.direct_entry_change_requests%rowtype;
  v_item record;
  v_entry public.direct_entries%rowtype;
  v_reason_id uuid;
  v_prior jsonb;
  v_result jsonb;
  v_revision_id uuid;
  v_audit_capability text := 'change_review';
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_decision not in ('APPROVED','REJECTED')
     or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'invalid change decision input' using errcode = '22023';
  end if;
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id;
  if not found then
    raise exception 'change request not found' using errcode = 'P0002';
  end if;
  if v_request.proposer_user_id = p_app_user_id then
    raise exception 'change request proposer cannot review own request' using errcode = '42501';
  end if;

  perform public.direct_entry_assert_change_request_capabilities(
    p_auth_subject, p_app_user_id, p_request_id
  );

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if exists(
    select 1 from public.direct_entry_change_request_items i
     where i.request_id = p_request_id and i.target_kind = 'ENTRY_VOID'
  ) then
    if coalesce(v_authz_managed, false) then
      v_audit_capability := case
        when public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) is not null
          then 'team_manager_assign'
        when public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
          then 'entry_admin'
        when public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
          then 'entry_privileged_edit'
        else 'change_review'
      end;
    else
      v_audit_capability := case
        when public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) is not null
          then 'team_manager_assign'
        when public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
          then 'entry_admin'
        when public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
          then 'entry_privileged_edit'
        else 'change_review'
      end;
    end if;
  end if;

  for v_item in
    select i.entry_id, i.target_kind from public.direct_entry_change_request_items i
     where i.request_id = p_request_id
  loop
    select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
    if not found then raise exception 'entry not found' using errcode = 'P0002'; end if;
    if v_item.target_kind <> 'ENTRY_VOID'
       and public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) is null then
      perform public.direct_entry_assert_entry_access(
        p_auth_subject, p_app_user_id, 'change_review',
        v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
      );
    end if;
  end loop;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'change_request_' || lower(p_decision), p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'request_id', p_request_id, 'version', p_expected_version,
      'decision', p_decision, 'reason', p_reason
    ))
  );
  if v_prior is not null then return v_prior; end if;

  select * into v_request from public.direct_entry_change_requests
   where request_id = p_request_id for update;
  if not found or v_request.state <> 'PENDING'
     or v_request.version <> p_expected_version then
    raise exception 'change request version conflict' using errcode = 'PT409';
  end if;
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  if p_decision = 'APPROVED' then
    for v_item in
      select i.* from public.direct_entry_change_request_items i
       where i.request_id = p_request_id order by i.entry_id for update
    loop
      select * into v_entry from public.direct_entries
       where entry_id = v_item.entry_id for update;
      if not found or v_entry.deleted_at is not null or v_entry.voided_at is not null
         or v_entry.version <> v_item.expected_version then
        raise exception 'change item version conflict' using errcode = 'PT409';
      end if;
      perform public.direct_entry_apply_change_item(
        p_auth_subject, p_app_user_id, p_request_id, v_entry,
        v_item.target_kind, v_item.proposal, v_reason_id
      );
    end loop;
  else
    for v_item in
      select i.entry_id, i.target_kind from public.direct_entry_change_request_items i
       where i.request_id = p_request_id
    loop
      select * into v_entry from public.direct_entries where entry_id = v_item.entry_id;
      if v_item.target_kind <> 'ENTRY_VOID'
         and public.direct_entry_team_leader_request_team(p_app_user_id, p_request_id) is null then
        perform public.direct_entry_assert_entry_access(
          p_auth_subject, p_app_user_id, 'change_review',
          v_entry.created_by_user_id, v_entry.team_id, v_entry.first_work_date
        );
      end if;
    end loop;
  end if;
  v_revision_id := public.direct_entry_write_change_request_revision(
    p_request_id, p_app_user_id, v_reason_id,
    jsonb_build_object('state', v_request.state, 'version', v_request.version),
    jsonb_build_object('state', p_decision, 'version', v_request.version + 1),
    v_request.version + 1
  );
  update public.direct_entry_change_requests
     set state = p_decision, version = version + 1,
         decided_by_user_id = p_app_user_id, decided_at = now(),
         decision_reason_id = v_reason_id
   where request_id = p_request_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref,
    outcome, reason_id, change_request_revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'change_request_' || lower(p_decision),
    v_audit_capability, p_request_id::text, 'APPLIED', v_reason_id, v_revision_id,
    array['state','version']
  );
  v_result := jsonb_build_object(
    'request_id', p_request_id, 'state', p_decision, 'version', v_request.version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'change_request_' || lower(p_decision), p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

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
      if coalesce(v_authz_managed, false) then
        perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
        if not public.direct_entry_authz__internal_has_paired_capability(
          p_app_user_id, 'team_manager_assign', 'CONTEXT_TEAM', p_entry.team_id::text
        ) then
          raise exception 'capability denied' using errcode = '42501';
        end if;
      else
        perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, 'team_manager_assign');
      end if;
      v_scope := 'team';
      v_review_capability := 'team_manager_assign';
    elsif coalesce(v_authz_managed, false) then
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
    elsif public.direct_entry_has_scope(p_app_user_id, 'all')
       and public.direct_entry_has_capability(p_app_user_id, 'entry_admin') then
      v_scope := 'all';
      v_review_capability := 'entry_admin';
    elsif public.direct_entry_has_scope(p_app_user_id, 'all')
       and public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit') then
      v_scope := 'all';
      v_review_capability := 'entry_privileged_edit';
    elsif public.direct_entry_has_scope(p_app_user_id, 'all')
       and public.direct_entry_has_capability(p_app_user_id, 'change_review') then
      v_scope := 'all';
      v_review_capability := 'change_review';
    else
      raise exception 'entry void review scope/capability denied' using errcode = '42501';
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
    if coalesce(v_authz_managed, false) then
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
    elsif not (
      public.direct_entry_has_capability(p_app_user_id, 'document_view')
      and public.direct_entry_has_capability(p_app_user_id, 'document_upload')
    ) then
      raise exception 'capability denied' using errcode = '42501';
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
    select count(*), min(m.provider_type) into v_count, v_provider
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(
         m.membership_id, public.direct_entry_authorization_date()
       );
    if v_count <> 1 then raise exception 'provider membership denied' using errcode = '42501'; end if;
    if v_provider = 'vendor' then
      v_team_id := public.direct_entry_system_vendor_team_id();
    else
      select count(*), (array_agg(m.team_id))[1] into v_count, v_team_id
        from public.recruiter_team_memberships m
       where m.recruiter_id = v_recruiter_id
         and public.direct_entry__internal_recruiter_team_membership_effective(
           m.membership_id, public.direct_entry_authorization_date()
         );
      if v_count <> 1 then raise exception 'team membership denied' using errcode = '42501'; end if;
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
      recruiter_id = v_recruiter_id, team_id = v_team_id, provider_type = v_provider,
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

-- =============================================================================
-- SECTION 5: ACL Alignment & Fail-Closed Postcondition Checks
-- =============================================================================

do $align_wp8c2$
declare
  v_internal_sigs text[] := array[
    'public.direct_entry_assert_draft_access(uuid,uuid,uuid,uuid,date,text)',
    'public.direct_entry_create_authority(uuid,uuid,text,date)',
    'public.direct_entry_input_catalog_unscoped_v42(uuid,uuid,date)',
    'public.direct_entry_transition_submission_apply(uuid,uuid,uuid,integer,text,text,text,integer)',
    'public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)',
    'public.direct_entry_assert_payment_document_access(uuid,uuid,uuid,uuid,date,uuid,text)',
    'public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)',
    'public.direct_entry_create_worker_portrait_stage(uuid,uuid,uuid,text,bigint,text)',
    'public.direct_entry_create_worker_portrait_stage_idempotent(uuid,uuid,uuid,text,bigint,text,text)',
    'public.direct_entry_complete_worker_portrait_stage(uuid,uuid,uuid,text,uuid,uuid)',
    'public.direct_entry__internal_assert_cccd_qr_read_access(uuid,uuid,uuid)',
    'public.direct_entry__internal_resolve_cccd_review_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)',
    'public.direct_entry_assert_change_request_capabilities(uuid,uuid,uuid)',
    'public.direct_entry_change_request_audience(uuid,uuid,uuid)',
    'public.direct_entry_resolve_change_request_scope(uuid,uuid,uuid,text)',
    'public.direct_entry_decide_change_request(uuid,uuid,uuid,integer,text,text,text)',
    'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)',
    'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)'
  ];
  v_service_sigs text[] := array[
    'public.direct_entry_list_own_drafts(uuid,uuid)',
    'public.direct_entry_delete_draft_submission(uuid,uuid,uuid,integer,text)',
    'public.direct_entry_submission_duplicate_cccd_preflight(uuid,uuid,uuid)',
    'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)',
    'public.direct_entry_create_full_profile_batch_with_portrait_stages(uuid,uuid,text,jsonb,text,uuid[])',
    'public.direct_entry_read_projection(uuid,uuid,uuid)',
    'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)',
    'public.direct_entry_create_worker_document_stage_idempotent(uuid,uuid,uuid,text,text,bigint,text,text)',
    'public.direct_entry_complete_worker_document_stage(uuid,uuid,uuid,text,uuid,uuid)',
    'public.direct_entry_claim_worker_portrait_stage(uuid,uuid,uuid,text)',
    'public.direct_entry_list_cccd_review_queue(uuid,uuid,text,integer,integer)',
    'public.direct_entry_list_missing_document_workers(uuid,uuid,text,text,text,text,integer,integer)',
    'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)',
    'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)',
    'public.direct_entry_list_global_change_request_history(uuid,uuid,integer,text,integer)',
    'public.direct_entry_read_change_request(uuid,uuid,uuid)'
  ];
  v_sig text;
begin
  foreach v_sig in array v_internal_sigs loop
    execute 'revoke all on function ' || v_sig || ' from public, anon, authenticated, service_role';
  end loop;
  foreach v_sig in array v_service_sigs loop
    execute 'revoke all on function ' || v_sig || ' from public, anon, authenticated';
    execute 'grant execute on function ' || v_sig || ' to service_role';
  end loop;
end;
$align_wp8c2$;

do $check_wp8c2$
declare
  v_internal_sigs text[] := array[
    'public.direct_entry_assert_draft_access(uuid,uuid,uuid,uuid,date,text)',
    'public.direct_entry_create_authority(uuid,uuid,text,date)',
    'public.direct_entry_input_catalog_unscoped_v42(uuid,uuid,date)',
    'public.direct_entry_transition_submission_apply(uuid,uuid,uuid,integer,text,text,text,integer)',
    'public.direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)',
    'public.direct_entry_assert_payment_document_access(uuid,uuid,uuid,uuid,date,uuid,text)',
    'public.direct_entry_assert_document_upload_access(uuid,uuid,uuid)',
    'public.direct_entry_create_worker_portrait_stage(uuid,uuid,uuid,text,bigint,text)',
    'public.direct_entry_create_worker_portrait_stage_idempotent(uuid,uuid,uuid,text,bigint,text,text)',
    'public.direct_entry_complete_worker_portrait_stage(uuid,uuid,uuid,text,uuid,uuid)',
    'public.direct_entry__internal_assert_cccd_qr_read_access(uuid,uuid,uuid)',
    'public.direct_entry__internal_resolve_cccd_review_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)',
    'public.direct_entry_assert_change_request_capabilities(uuid,uuid,uuid)',
    'public.direct_entry_change_request_audience(uuid,uuid,uuid)',
    'public.direct_entry_resolve_change_request_scope(uuid,uuid,uuid,text)',
    'public.direct_entry_decide_change_request(uuid,uuid,uuid,integer,text,text,text)',
    'public.direct_entry_apply_change_item(uuid,uuid,uuid,public.direct_entries,text,jsonb,uuid)'
  ];
  v_service_sigs text[] := array[
    'public.direct_entry_catalog_bootstrap_plan(uuid,uuid)',
    'public.direct_entry_apply_catalog_bootstrap(uuid,uuid,text,text,text)',
    'public.direct_entry_list_own_drafts(uuid,uuid)',
    'public.direct_entry_delete_draft_submission(uuid,uuid,uuid,integer,text)',
    'public.direct_entry_submission_duplicate_cccd_preflight(uuid,uuid,uuid)',
    'public.direct_entry_create_full_profile_batch(uuid,uuid,text,jsonb,text)',
    'public.direct_entry_create_full_profile_batch_with_portrait_stages(uuid,uuid,text,jsonb,text,uuid[])',
    'public.direct_entry_read_projection(uuid,uuid,uuid)',
    'public.direct_entry_document_direct_context(uuid,uuid,uuid,uuid,text)',
    'public.direct_entry_create_worker_document_stage_idempotent(uuid,uuid,uuid,text,text,bigint,text,text)',
    'public.direct_entry_complete_worker_document_stage(uuid,uuid,uuid,text,uuid,uuid)',
    'public.direct_entry_claim_worker_portrait_stage(uuid,uuid,uuid,text)',
    'public.direct_entry_list_cccd_review_queue(uuid,uuid,text,integer,integer)',
    'public.direct_entry_list_missing_document_workers(uuid,uuid,text,text,text,text,integer,integer)',
    'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)',
    'public.direct_entry_self_withdraw_duplicate_cccd(uuid,uuid,uuid,integer,text,text)',
    'public.direct_entry_list_global_change_request_history(uuid,uuid,integer,text,integer)',
    'public.direct_entry_read_change_request(uuid,uuid,uuid)'
  ];
  v_stable_sigs text[] := array[
    'public.direct_entry_create_authority(uuid,uuid,text,date)',
    'public.direct_entry_submission_duplicate_cccd_preflight(uuid,uuid,uuid)',
    'public.direct_entry__internal_resolve_cccd_review_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)',
    'public.direct_entry_list_cccd_review_queue(uuid,uuid,text,integer,integer)',
    'public.direct_entry_duplicate_cccd_report(uuid,uuid,integer,integer,boolean)'
  ];
  v_sig text;
  v_proc record;
  v_overload_count integer;
begin
  foreach v_sig in array (v_internal_sigs || v_service_sigs) loop
    select p.oid, p.proname, p.prosecdef, p.provolatile, p.proconfig, p.prosrc,
           pg_catalog.pg_get_userbyid(p.proowner) as owner_name
      into v_proc
      from pg_catalog.pg_proc p
     where p.oid = v_sig::regprocedure;
    if not found then
      raise exception 'WP8C-2 postcondition missing function: %', v_sig;
    end if;
    if not v_proc.prosecdef then
      raise exception 'WP8C-2 function must be SECURITY DEFINER: %', v_sig;
    end if;
    if array_to_string(coalesce(v_proc.proconfig, array[]::text[]), ',') <> 'search_path=pg_catalog, public' then
      raise exception 'WP8C-2 search_path drift on %: %', v_sig, coalesce(array_to_string(v_proc.proconfig, ','), 'null');
    end if;
    if v_proc.prosrc ~ '''40001''' then
      raise exception 'WP8C-2 PT409 regression: found 40001 SQLSTATE in %', v_sig;
    end if;
    select count(*)::integer into v_overload_count
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_proc.proname;
    if (v_proc.proname = 'direct_entry_duplicate_cccd_report' and v_overload_count <> 2)
       or (v_proc.proname <> 'direct_entry_duplicate_cccd_report' and v_overload_count <> 1) then
      raise exception 'WP8C-2 unexpected overload count on %: %', v_proc.proname, v_overload_count;
    end if;
    if has_function_privilege('public', v_proc.oid, 'EXECUTE')
       or has_function_privilege('anon', v_proc.oid, 'EXECUTE')
       or has_function_privilege('authenticated', v_proc.oid, 'EXECUTE') then
      raise exception 'WP8C-2 client/PUBLIC EXECUTE leak on %', v_sig;
    end if;
  end loop;

  foreach v_sig in array v_internal_sigs loop
    if has_function_privilege('service_role', v_sig::regprocedure, 'EXECUTE') then
      raise exception 'WP8C-2 internal helper unexpectedly executable by service_role: %', v_sig;
    end if;
  end loop;

  foreach v_sig in array v_service_sigs loop
    if not has_function_privilege('service_role', v_sig::regprocedure, 'EXECUTE') then
      raise exception 'WP8C-2 service_role missing EXECUTE on %', v_sig;
    end if;
  end loop;

  foreach v_sig in array v_stable_sigs loop
    if (select p.provolatile from pg_catalog.pg_proc p where p.oid = v_sig::regprocedure) <> 's' then
      raise exception 'WP8C-2 expected STABLE volatility on %', v_sig;
    end if;
  end loop;

  if not has_function_privilege(
       'direct_entry_catalog_bootstrap_executor',
       'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)'::regprocedure,
       'EXECUTE'
     )
     or has_function_privilege(
       'public',
       'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)'::regprocedure,
       'EXECUTE'
     )
     or has_function_privilege(
       'anon',
       'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)'::regprocedure,
       'EXECUTE'
     )
     or has_function_privilege(
       'authenticated',
       'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)'::regprocedure,
       'EXECUTE'
     )
     or has_function_privilege(
       'service_role',
       'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)'::regprocedure,
       'EXECUTE'
     ) then
    raise exception 'WP8C-2 paired capability helper ACL drift';
  end if;
end;
$check_wp8c2$;

commit;
