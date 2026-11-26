-- =============================================================================
-- WP10-7 Slice 2A: Stop mirroring Leave employee profile unit_kind from Org
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. Create 3 internal helpers (SECURITY DEFINER, search_path = pg_catalog, public,
--      REVOKE ALL FROM public, anon, authenticated, service_role; +0 net RPCs):
--      - public.org_department__internal_resolve_leave_classification(uuid, timestamptz)
--      - public.org_department__internal_resolve_person_leave_classification(uuid, timestamptz)
--      - public.org_department__internal_bump_leave_profile_version_on_org_change(
--          uuid, uuid, text, uuid, timestamptz)
--   2. Replace public.org_department__internal_guard_leave_profile() to remove
--      app.org_leave_profile_sync bypass and Org queries, and freeze unit_kind
--      mutations on leave_employee_profiles (INSERT must be 'UNCLASSIFIED';
--      UPDATE must keep NEW.unit_kind IS NOT DISTINCT FROM OLD.unit_kind).
--   3. Update public.leave_management_upsert_employee_profile_admin(...) (13-arg)
--      to omit unit_kind on INSERT/UPDATE, drop app.org_leave_profile_sync GUC,
--      resolve classification from Org for audit/response, and preserve exact
--      idempotency replay + p_unit_kind enum validation.
--   4. Update all 9 Org RPCs calling org_department__internal_sync_leave_profile_from_org
--      to capture before (department_id, unit_kind) after canonical locks and
--      v_now finalization, and call
--      org_department__internal_bump_leave_profile_version_on_org_change(...)
--      without touching leave_employee_profiles.unit_kind.
--   5. DROP FUNCTION public.org_department__internal_sync_leave_profile_from_org(
--        uuid, uuid, timestamptz, boolean) RESTRICT.
--   6. Postcondition DO $$ verification + owner alignment.
-- =============================================================================

begin;

-- =============================================================================
-- 1. Internal Classification & OCC Row-Version Bump Helpers
-- =============================================================================

create or replace function public.org_department__internal_resolve_leave_classification(
  p_app_user_id uuid,
  p_as_of_ts timestamptz default pg_catalog.clock_timestamp()
)
returns table(
  department_id uuid,
  unit_kind text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of_ts, pg_catalog.clock_timestamp());
begin
  if p_app_user_id is null then
    return query select null::uuid, 'UNCLASSIFIED'::text;
    return;
  end if;

  return query
  select case
           when coalesce(r.has_active_person_link, false) then r.department_id
           else null::uuid
         end as department_id,
         case
           when coalesce(r.has_active_person_link, false)
                and r.department_system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD')
             then r.department_system_key
           else 'UNCLASSIFIED'
         end as unit_kind
    from public.leave_management__internal_resolve_person_department(p_app_user_id, v_as_of) r
   limit 1;
end;
$function$;

revoke all on function public.org_department__internal_resolve_leave_classification(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_resolve_person_leave_classification(
  p_person_id uuid,
  p_as_of_ts timestamptz default pg_catalog.clock_timestamp()
)
returns table(
  department_id uuid,
  unit_kind text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of_ts, pg_catalog.clock_timestamp());
begin
  if p_person_id is null then
    return query select null::uuid, 'UNCLASSIFIED'::text;
    return;
  end if;

  return query
  with active_dept as (
    select d.department_id,
           d.system_key as department_system_key
      from public.organization_persons op
      join public.organization_person_department_memberships m
        on m.person_id = op.person_id
       and m.started_at <= v_as_of
       and (m.ended_at is null or (m.ended_at > m.started_at and v_as_of < m.ended_at))
      join public.organization_departments d
        on d.department_id = m.department_id
       and d.is_active = true
     where op.person_id = p_person_id
       and op.status = 'ACTIVE'
     order by m.started_at desc, m.membership_id desc
     limit 1
  )
  select ad.department_id,
         case
           when ad.department_system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD')
             then ad.department_system_key
           else 'UNCLASSIFIED'
         end as unit_kind
    from (select 1 as anchor) a
    left join active_dept ad on true;
end;
$function$;

revoke all on function public.org_department__internal_resolve_person_leave_classification(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_bump_leave_profile_version_on_org_change(
  p_app_user_id uuid,
  p_before_department_id uuid,
  p_before_unit_kind text,
  p_actor_user_id uuid default null::uuid,
  p_now timestamptz default null::timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_eff_now timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  v_actor uuid := coalesce(p_actor_user_id, p_app_user_id);
  v_after_department_id uuid := null;
  v_after_unit_kind text := 'UNCLASSIFIED';
begin
  if p_app_user_id is null then
    return false;
  end if;

  select c.department_id, c.unit_kind
    into v_after_department_id, v_after_unit_kind
    from public.org_department__internal_resolve_leave_classification(p_app_user_id, v_eff_now) c;

  v_after_unit_kind := coalesce(v_after_unit_kind, 'UNCLASSIFIED');

  if v_after_department_id is not distinct from p_before_department_id
     and v_after_unit_kind is not distinct from coalesce(p_before_unit_kind, 'UNCLASSIFIED') then
    return false;
  end if;

  update public.leave_employee_profiles
     set row_version = row_version + 1,
         updated_at = v_eff_now,
         updated_by_app_user_id = v_actor
   where app_user_id = p_app_user_id;

  return found;
end;
$function$;

revoke all on function public.org_department__internal_bump_leave_profile_version_on_org_change(
  uuid, uuid, text, uuid, timestamptz
) from public, anon, authenticated, service_role;

-- =============================================================================
-- 2. Freeze leave_employee_profiles.unit_kind via Guard Trigger Function
-- =============================================================================

create or replace function public.org_department__internal_guard_leave_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'INSERT' then
    if new.unit_kind is distinct from 'UNCLASSIFIED' then
      raise exception 'LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN'
        using errcode = '22023';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.unit_kind is distinct from old.unit_kind then
      raise exception 'LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.org_department__internal_guard_leave_profile()
  from public, anon, authenticated, service_role;

-- =============================================================================
-- 3. Update leave_management_upsert_employee_profile_admin (13-arg)
-- =============================================================================

create or replace function public.leave_management_upsert_employee_profile_admin(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_employment_status text,
  p_unit_kind text,
  p_work_start_date date,
  p_official_effective_date date,
  p_next_seniority_effective_date date,
  p_next_seniority_units integer,
  p_expected_row_version integer,
  p_reason text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz;
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_reason text;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_existing_profile public.leave_employee_profiles%rowtype;
  v_has_existing boolean := false;
  v_emp_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_employment_status, 'UNCONFIGURED')));
  v_requested_unit_kind text := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_unit_kind, ''))), '');
  v_org_dept_id uuid := null;
  v_unit_kind text := 'UNCLASSIFIED';
  v_official_date date := p_official_effective_date;
  v_sen_units integer := coalesce(p_next_seniority_units, 0);
  v_seniority_changed boolean := false;
  v_profile public.leave_employee_profiles%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;

  if p_target_app_user_id is null then
    raise exception 'LEAVE_TARGET_USER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select u.*
    into v_target_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;

  if not found then
    raise exception 'LEAVE_TARGET_USER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform public.leave_management__internal_lock_employee(p_target_app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'UPSERT_EMPLOYEE_PROFILE_ADMIN'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if v_emp_status not in ('UNCONFIGURED', 'PROBATION', 'OFFICIAL')
     or (
       v_requested_unit_kind is not null
       and v_requested_unit_kind not in ('UNCLASSIFIED', 'RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD')
     )
     or v_sen_units < 0
     or v_sen_units > 60 then
    raise exception 'LEAVE_PROFILE_INVALID'
      using errcode = '22023';
  end if;

  if v_emp_status in ('PROBATION', 'OFFICIAL') and p_work_start_date is null then
    raise exception 'LEAVE_PROFILE_WORK_START_DATE_REQUIRED'
      using errcode = '22023';
  end if;

  if v_emp_status = 'OFFICIAL' then
    v_official_date := coalesce(v_official_date, p_work_start_date);
    if v_official_date is null or v_official_date < p_work_start_date then
      raise exception 'LEAVE_PROFILE_OFFICIAL_DATE_INVALID'
        using errcode = '22023';
    end if;
  elsif v_official_date is not null and p_work_start_date is not null and v_official_date < p_work_start_date then
    raise exception 'LEAVE_PROFILE_OFFICIAL_DATE_INVALID'
      using errcode = '22023';
  end if;

  -- Lock direct_entry_app_users (actor + target) in ascending UUID order BEFORE
  -- leave_employee_profiles so FK FOR KEY SHARE checks never deadlock against
  -- Org RPCs holding Tier-2 U FOR UPDATE -> leave_employee_profiles UPDATE.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(array[p_actor_app_user_id, p_target_app_user_id])
   order by u.app_user_id asc
   for key share;

  select p.*
    into v_existing_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_target_app_user_id
   for update;

  if found then
    v_has_existing := true;
    if p_expected_row_version is null or v_existing_profile.row_version <> p_expected_row_version then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_seniority_changed := (
      v_existing_profile.next_seniority_effective_date is distinct from p_next_seniority_effective_date
      or v_existing_profile.next_seniority_units is distinct from v_sen_units
    );
  else
    if coalesce(p_expected_row_version, 0) <> 0 then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_seniority_changed := (
      p_next_seniority_effective_date is not null
      or v_sen_units > 0
    );
  end if;

  if v_seniority_changed and not (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  ) then
    raise exception 'LEAVE_SENIORITY_CONFIG_FORBIDDEN'
      using errcode = '42501';
  end if;

  -- Finalize v_now AFTER all locks and precondition checks so a concurrent Org
  -- transfer that committed while we waited on locks is reflected in classification.
  v_now := pg_catalog.clock_timestamp();

  -- Ignore p_unit_kind on write; derive classification strictly from Org for audit & response
  select c.department_id, c.unit_kind
    into v_org_dept_id, v_unit_kind
    from public.org_department__internal_resolve_leave_classification(p_target_app_user_id, v_now) c;

  v_unit_kind := coalesce(v_unit_kind, 'UNCLASSIFIED');

  if v_has_existing then
    update public.leave_employee_profiles
       set employment_status = v_emp_status,
           work_start_date = p_work_start_date,
           official_effective_date = v_official_date,
           next_seniority_effective_date = p_next_seniority_effective_date,
           next_seniority_units = v_sen_units,
           notes = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now()),
           updated_by_app_user_id = p_actor_app_user_id
     where app_user_id = p_target_app_user_id
     returning * into v_profile;
  else
    insert into public.leave_employee_profiles (
      app_user_id,
      employment_status,
      work_start_date,
      official_effective_date,
      next_seniority_effective_date,
      next_seniority_units,
      notes,
      row_version,
      updated_by_app_user_id
    )
    values (
      p_target_app_user_id,
      v_emp_status,
      p_work_start_date,
      v_official_date,
      p_next_seniority_effective_date,
      v_sen_units,
      v_reason,
      1,
      p_actor_app_user_id
    )
    returning * into v_profile;
  end if;

  perform public.leave_management__internal_sync_employee_accruals(p_target_app_user_id, v_today);

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    reason,
    payload
  )
  values (
    'EMPLOYEE_PROFILE_UPSERTED',
    p_actor_app_user_id,
    p_target_app_user_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'employment_status', v_profile.employment_status,
      'unit_kind', v_unit_kind,
      'work_start_date', v_profile.work_start_date,
      'official_effective_date', v_profile.official_effective_date,
      'next_seniority_effective_date', v_profile.next_seniority_effective_date,
      'next_seniority_units', v_profile.next_seniority_units,
      'row_version', v_profile.row_version
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'profile', pg_catalog.jsonb_build_object(
      'app_user_id', v_profile.app_user_id,
      'employment_status', v_profile.employment_status,
      'unit_kind', v_unit_kind,
      'work_start_date', v_profile.work_start_date,
      'official_effective_date', v_profile.official_effective_date,
      'next_seniority_effective_date', v_profile.next_seniority_effective_date,
      'next_seniority_units', v_profile.next_seniority_units,
      'notes', v_profile.notes,
      'row_version', v_profile.row_version
    ),
    'routing', public.leave_management__internal_resolve_routing(p_target_app_user_id, v_today),
    'balance', public.leave_management__internal_compute_balance_summary(p_target_app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'UPSERT_EMPLOYEE_PROFILE_ADMIN',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

revoke all on function public.leave_management_upsert_employee_profile_admin(
  uuid, uuid, uuid, text, text, date, date, date, integer, integer, text, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.leave_management_upsert_employee_profile_admin(
  uuid, uuid, uuid, text, text, date, date, date, integer, integer, text, text, text
) to service_role;

-- =============================================================================
-- 4. Update all 9 Org RPCs (replace sync_leave_profile_from_org with
--    before-classification capture + bump_leave_profile_version_on_org_change)
-- =============================================================================

-- (1) org_department_link_account_person_admin
create or replace function public.org_department_link_account_person_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_person_id uuid,
  p_expected_account_version integer,
  p_expected_person_version integer,
  p_confirmed_recruiter_id uuid default null::uuid,
  p_reason text default null::text,
  p_idempotency_key uuid default null::uuid,
  p_request_fingerprint text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'ACCOUNT_PERSON_LINKED';
  v_today date := public.direct_entry_authorization_date();
  v_reason text;
  v_replay jsonb;
  v_account public.direct_entry_app_users%rowtype;
  v_person public.organization_persons%rowtype;
  v_recruiter public.recruiters%rowtype;
  v_acct_recruiter_id uuid := null;
  v_effective_recruiter_id uuid := null;
  v_new_link public.organization_account_person_links%rowtype;
  v_updated_account public.direct_entry_app_users%rowtype;
  v_updated_person public.organization_persons%rowtype;
  v_now timestamptz;
  v_reason_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_next_ver integer := 1;
  v_result jsonb;
  v_locked_dept_ids uuid[];
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_lock_id uuid;
  v_before_leave_dept_id uuid := null;
  v_before_leave_unit_kind text := 'UNCLASSIFIED';
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_target_app_user_id is null
     or p_person_id is null
     or p_expected_account_version is null or p_expected_account_version < 1
     or p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'account:' || p_target_app_user_id::text || ':person_link:' || p_person_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- Tier 1 (P): person lock first
  perform public.org_department__internal_lock_person(p_person_id);

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = p_person_id
   for update;

  if not found then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier 1 (D -> M): current open department membership of p_person_id
  select coalesce(array_agg(distinct m.department_id order by m.department_id), array[]::uuid[])
    into v_locked_dept_ids
    from public.organization_person_department_memberships m
   where m.person_id = p_person_id
     and m.ended_at is null;

  foreach v_lock_id in array v_locked_dept_ids loop
    perform public.org_department__internal_lock_department(v_lock_id);
  end loop;

  if cardinality(v_locked_dept_ids) > 0 then
    perform d.department_id
      from public.organization_departments d
     where d.department_id = any(v_locked_dept_ids)
     order by d.department_id asc
     for update;

    perform m.membership_id
      from public.organization_person_department_memberships m
     where m.person_id = p_person_id
       and m.ended_at is null
     order by m.membership_id asc
     for update;
  end if;

  -- Tier 2 (U): candidate accounts in ascending order
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select p_target_app_user_id as uid
      union
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where v_person.recruiter_id is not null
         and rl.recruiter_id = v_person.recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  foreach v_lock_id in array v_locked_user_ids loop
    perform public.org_department__internal_lock_app_user(v_lock_id);
  end loop;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union all
      select unnest(v_locked_user_ids) as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = any(v_locked_user_ids) then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for share;
    end if;
  end loop;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier 3 (R_full): discover & lock all related recruiters before child checks
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select v_person.recruiter_id as rid
      union
      select p_confirmed_recruiter_id as rid
      union
      select rl.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = any(v_locked_user_ids)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = any(v_locked_user_ids)
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) s
   where rid is not null;

  if cardinality(v_locked_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_locked_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  -- Post-lock completeness guard
  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = any(v_locked_user_ids)
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.recruiter_id = any(v_locked_recruiter_ids))
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where v_person.recruiter_id is not null
       and rl.recruiter_id = v_person.recruiter_id
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id = any(v_locked_user_ids)
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
  ) then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_account.version <> p_expected_account_version
     or v_person.version <> p_expected_person_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if exists (
    select 1 from public.organization_account_person_links l
     where (l.app_user_id = p_target_app_user_id or l.person_id = p_person_id)
       and l.ended_at is null
  ) then
    raise exception 'ACCOUNT_OR_PERSON_ALREADY_LINKED' using errcode = 'PT409';
  end if;

  select rl.recruiter_id
    into v_acct_recruiter_id
    from public.direct_entry_app_user_recruiter_links rl
   where rl.app_user_id = p_target_app_user_id
     and rl.verified = true
     and rl.is_current = true
   order by rl.valid_from desc, rl.link_id desc
   limit 1;

  -- R-INV-2 exact validation order
  if v_acct_recruiter_id is not null and v_person.recruiter_id is not null and v_acct_recruiter_id <> v_person.recruiter_id then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

  if v_acct_recruiter_id is not null and v_person.recruiter_id is null then
    if exists (
      select 1 from public.organization_persons p2
       where p2.recruiter_id = v_acct_recruiter_id
         and p2.person_id <> p_person_id
    ) then
      raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
    end if;
    if p_confirmed_recruiter_id is distinct from v_acct_recruiter_id then
      raise exception 'RECRUITER_LINK_MISMATCH' using errcode = 'PT409';
    end if;
  end if;

  v_effective_recruiter_id := coalesce(v_person.recruiter_id, v_acct_recruiter_id);

  if p_confirmed_recruiter_id is not null and v_effective_recruiter_id is distinct from p_confirmed_recruiter_id then
    raise exception 'RECRUITER_LINK_MISMATCH' using errcode = 'PT409';
  end if;

  if v_effective_recruiter_id is not null then
    select r.* into v_recruiter
      from public.recruiters r
     where r.recruiter_id = v_effective_recruiter_id;

    if exists (
      select 1
        from public.direct_entry_app_user_recruiter_links rl2
       where rl2.recruiter_id = v_effective_recruiter_id
         and rl2.verified = true
         and rl2.is_current = true
         and rl2.app_user_id <> p_target_app_user_id
    ) then
      raise exception 'RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT' using errcode = 'PT409';
    end if;
  end if;

  v_now := pg_catalog.clock_timestamp();

  -- Cross-domain guard under full locks (checked BEFORE PERSON_INACTIVE so inactive target Person triggers PT409 PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT)
  if public.org_department__internal_subject_has_blocking_team_assignment(
       v_locked_recruiter_ids,
       v_locked_user_ids,
       v_today
     )
     and not public.org_department__internal_person_is_active_in_org(p_person_id, v_now) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT' using errcode = 'PT409';
  end if;

  if v_person.status <> 'ACTIVE' then
    raise exception 'PERSON_INACTIVE' using errcode = 'PT409';
  end if;

  select c.department_id, c.unit_kind
    into v_before_leave_dept_id, v_before_leave_unit_kind
    from public.org_department__internal_resolve_leave_classification(p_target_app_user_id, v_now) c;

  v_before := pg_catalog.jsonb_build_object(
    'account', public.direct_entry_app_user_projection(v_account),
    'person', public.org_department__internal_person_summary_projection(v_person, v_now)
  );

  select coalesce(max(l2.version), 0) + 1
    into v_next_ver
    from public.organization_account_person_links l2
   where l2.person_id = p_person_id;

  insert into public.organization_account_person_links (
    app_user_id,
    person_id,
    started_at,
    ended_at,
    source_kind,
    version,
    reason,
    created_by_app_user_id,
    created_at,
    updated_at
  )
  values (
    p_target_app_user_id,
    p_person_id,
    v_now,
    null,
    'ADMIN_MUTATION',
    v_next_ver,
    v_reason,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_new_link;

  v_reason_id := public.direct_entry_reason(p_app_user_id, v_reason);

  update public.direct_entry_app_users
     set display_name = v_person.full_name,
         version = v_account.version + 1,
         updated_at = v_now
   where app_user_id = p_target_app_user_id
   returning * into v_updated_account;

  if v_account.display_name is distinct from v_person.full_name then
    insert into public.direct_entry_app_user_revisions (
      app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
    )
    values (
      p_target_app_user_id,
      v_updated_account.version,
      p_app_user_id,
      'display_name_update',
      pg_catalog.jsonb_build_object('display_name', v_account.display_name),
      pg_catalog.jsonb_build_object('display_name', v_person.full_name),
      v_reason_id
    );
  else
    insert into public.direct_entry_app_user_revisions (
      app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
    )
    values (
      p_target_app_user_id,
      v_updated_account.version,
      p_app_user_id,
      'link_create',
      pg_catalog.jsonb_build_object('person_id', null),
      pg_catalog.jsonb_build_object('person_id', p_person_id),
      v_reason_id
    );
  end if;

  update public.organization_persons
     set recruiter_id = v_effective_recruiter_id,
         version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = p_person_id
   returning * into v_updated_person;

  if v_effective_recruiter_id is not null and v_recruiter.display_name is distinct from v_person.full_name then
    update public.recruiters
       set display_name = v_person.full_name
     where recruiter_id = v_effective_recruiter_id;

    perform public.direct_entry_bump_personnel_version(
      v_effective_recruiter_id,
      p_app_user_id,
      v_reason_id,
      public.direct_entry_personnel_snapshot(v_recruiter),
      pg_catalog.jsonb_set(
        public.direct_entry_personnel_snapshot(v_recruiter),
        '{display_name}',
        pg_catalog.to_jsonb(v_person.full_name),
        true
      )
    );
  end if;

  perform public.org_department__internal_sync_accounting_projection(
    p_target_app_user_id,
    p_app_user_id,
    v_reason,
    v_now
  );
  perform public.org_department__internal_bump_leave_profile_version_on_org_change(
    p_target_app_user_id,
    v_before_leave_dept_id,
    v_before_leave_unit_kind,
    p_app_user_id,
    v_now
  );

  v_after := pg_catalog.jsonb_build_object(
    'account', public.direct_entry_app_user_projection(v_updated_account),
    'person', public.org_department__internal_person_summary_projection(v_updated_person, v_now)
  );

  insert into public.organization_department_audit_events (
    target_app_user_id,
    target_person_id,
    link_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_target_app_user_id,
    p_person_id,
    v_new_link.link_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'account_version', v_updated_account.version,
    'person_version', v_updated_person.version,
    'link', pg_catalog.jsonb_build_object(
      'link_id', v_new_link.link_id,
      'account_ref', p_target_app_user_id,
      'person_id', p_person_id,
      'employee_code', v_updated_person.employee_code,
      'full_name', v_updated_person.full_name,
      'started_at', public.org_department__internal_iso_utc(v_new_link.started_at),
      'source_kind', v_new_link.source_kind,
      'evidence_date', null,
      'version', v_new_link.version
    )
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'account:' || p_target_app_user_id::text || ':person_link:' || p_person_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_link_account_person_admin(
  uuid, uuid, uuid, uuid, integer, integer, uuid, text, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.org_department_link_account_person_admin(
  uuid, uuid, uuid, uuid, integer, integer, uuid, text, uuid, text
) to service_role;

-- (2) org_department_unlink_account_person_admin
create or replace function public.org_department_unlink_account_person_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_expected_account_version integer,
  p_expected_person_version integer,
  p_expected_link_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'ACCOUNT_PERSON_UNLINKED';
  v_today date := public.direct_entry_authorization_date();
  v_reason text;
  v_replay jsonb;
  v_link_person_id uuid;
  v_account public.direct_entry_app_users%rowtype;
  v_link public.organization_account_person_links%rowtype;
  v_ended_link public.organization_account_person_links%rowtype;
  v_person public.organization_persons%rowtype;
  v_updated_account public.direct_entry_app_users%rowtype;
  v_updated_person public.organization_persons%rowtype;
  v_now timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_locked_dept_ids uuid[];
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_lock_id uuid;
  v_before_leave_dept_id uuid := null;
  v_before_leave_unit_kind text := 'UNCLASSIFIED';
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_target_app_user_id is null
     or p_expected_account_version is null or p_expected_account_version < 1
     or p_expected_person_version is null or p_expected_person_version < 1
     or p_expected_link_id is null then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'account:' || p_target_app_user_id::text || ':person_unlink',
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- Tier 1 (P -> D -> M)
  select l.person_id
    into v_link_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_target_app_user_id
     and l.ended_at is null
   limit 1;

  if v_link_person_id is not null then
    perform public.org_department__internal_lock_person(v_link_person_id);

    select p.* into v_person
      from public.organization_persons p
     where p.person_id = v_link_person_id
     for update;

    select coalesce(array_agg(distinct m.department_id order by m.department_id), array[]::uuid[])
      into v_locked_dept_ids
      from public.organization_person_department_memberships m
     where m.person_id = v_link_person_id
       and m.ended_at is null;

    foreach v_lock_id in array v_locked_dept_ids loop
      perform public.org_department__internal_lock_department(v_lock_id);
    end loop;

    if cardinality(v_locked_dept_ids) > 0 then
      perform d.department_id
        from public.organization_departments d
       where d.department_id = any(v_locked_dept_ids)
       order by d.department_id asc
       for update;

      perform m.membership_id
        from public.organization_person_department_memberships m
       where m.person_id = v_link_person_id
         and m.ended_at is null
       order by m.membership_id asc
       for update;
    end if;
  end if;

  -- Tier 2 (U)
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select p_target_app_user_id as uid
      union
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where v_person.recruiter_id is not null
         and rl.recruiter_id = v_person.recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  foreach v_lock_id in array v_locked_user_ids loop
    perform public.org_department__internal_lock_app_user(v_lock_id);
  end loop;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union all
      select unnest(v_locked_user_ids) as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = any(v_locked_user_ids) then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for share;
    end if;
  end loop;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier 3 (R_full)
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select v_person.recruiter_id as rid
      union
      select rl.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = any(v_locked_user_ids)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = any(v_locked_user_ids)
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) s
   where rid is not null;

  if cardinality(v_locked_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_locked_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  -- Post-lock completeness guard
  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = any(v_locked_user_ids)
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.recruiter_id = any(v_locked_recruiter_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id = any(v_locked_user_ids)
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
  ) then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  select l.* into v_link
    from public.organization_account_person_links l
   where l.app_user_id = p_target_app_user_id
     and l.ended_at is null
   for update;

  if not found then
    raise exception 'LINK_ALREADY_ENDED' using errcode = 'PT409';
  end if;

  if v_person.person_id is null or v_person.person_id <> v_link.person_id then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_account.version <> p_expected_account_version
     or v_person.version <> p_expected_person_version
     or p_expected_link_id is distinct from v_link.link_id then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  -- Cross-domain guard: cannot unlink an account holding blocking G1/G2/G3 assignments
  if public.org_department__internal_subject_has_blocking_team_assignment(
       v_locked_recruiter_ids,
       array[p_target_app_user_id],
       v_today
     ) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT' using errcode = 'PT409';
  end if;

  v_now := greatest(pg_catalog.clock_timestamp(), v_link.started_at);

  select c.department_id, c.unit_kind
    into v_before_leave_dept_id, v_before_leave_unit_kind
    from public.org_department__internal_resolve_leave_classification(p_target_app_user_id, v_now) c;

  v_before := pg_catalog.jsonb_build_object(
    'account', public.direct_entry_app_user_projection(v_account),
    'person', public.org_department__internal_person_summary_projection(v_person, v_now)
  );

  update public.organization_account_person_links
     set ended_at = v_now,
         ended_reason = v_reason,
         ended_by_app_user_id = p_app_user_id,
         version = v_link.version + 1,
         updated_at = v_now
   where link_id = v_link.link_id
   returning * into v_ended_link;

  update public.direct_entry_app_users
     set version = v_account.version + 1,
         updated_at = v_now
   where app_user_id = p_target_app_user_id
   returning * into v_updated_account;

  update public.organization_persons
     set version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = v_person.person_id
   returning * into v_updated_person;

  perform public.org_department__internal_sync_accounting_projection(
    p_target_app_user_id,
    p_app_user_id,
    v_reason,
    v_now
  );
  perform public.org_department__internal_bump_leave_profile_version_on_org_change(
    p_target_app_user_id,
    v_before_leave_dept_id,
    v_before_leave_unit_kind,
    p_app_user_id,
    v_now
  );

  v_after := pg_catalog.jsonb_build_object(
    'account', public.direct_entry_app_user_projection(v_updated_account),
    'person', public.org_department__internal_person_summary_projection(v_updated_person, v_now)
  );

  insert into public.organization_department_audit_events (
    target_app_user_id,
    target_person_id,
    link_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_target_app_user_id,
    v_person.person_id,
    v_link.link_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'account_version', v_updated_account.version,
    'person_version', v_updated_person.version,
    'ended_link', pg_catalog.jsonb_build_object(
      'link_id', v_ended_link.link_id,
      'account_ref', p_target_app_user_id,
      'person_id', v_person.person_id,
      'started_at', public.org_department__internal_iso_utc(v_ended_link.started_at),
      'ended_at', public.org_department__internal_iso_utc(v_ended_link.ended_at),
      'version', v_ended_link.version
    )
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'account:' || p_target_app_user_id::text || ':person_unlink',
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_unlink_account_person_admin(
  uuid, uuid, uuid, integer, integer, uuid, text, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.org_department_unlink_account_person_admin(
  uuid, uuid, uuid, integer, integer, uuid, text, uuid, text
) to service_role;

-- (3) org_department_create_person_admin
create or replace function public.org_department_create_person_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_employee_code text,
  p_full_name text,
  p_joined_on date default null::date,
  p_initial_department_id uuid default null::uuid,
  p_account_ref uuid default null::uuid,
  p_expected_account_version integer default null::integer,
  p_recruiter_id uuid default null::uuid,
  p_reason text default null::text,
  p_idempotency_key uuid default null::uuid,
  p_request_fingerprint text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'PERSON_CREATED';
  v_today date := public.direct_entry_authorization_date();
  v_code text;
  v_name text;
  v_reason text;
  v_replay jsonb;
  v_dept public.organization_departments%rowtype;
  v_account public.direct_entry_app_users%rowtype;
  v_recruiter public.recruiters%rowtype;
  v_acct_recruiter_id uuid := null;
  v_resolved_recruiter_id uuid := p_recruiter_id;
  v_person public.organization_persons%rowtype;
  v_now timestamptz;
  v_reason_id uuid;
  v_prev_display_name text;
  v_proj jsonb;
  v_result jsonb;
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_lock_id uuid;
  v_before_leave_dept_id uuid := null;
  v_before_leave_unit_kind text := 'UNCLASSIFIED';
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  v_code := pg_catalog.btrim(coalesce(p_employee_code, ''));
  v_name := pg_catalog.btrim(coalesce(p_full_name, ''));
  if pg_catalog.length(v_code) < 2 or pg_catalog.length(v_code) > 64 or v_code ~ '[\x00-\x1F\x7F]' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_code ~* '^hrp-[0-9]{4}-[0-9]{6}$' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if pg_catalog.length(v_name) < 1 or pg_catalog.length(v_name) > 160 or v_name ~ '[\x00-\x1F\x7F]' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  if p_account_ref is not null and (p_expected_account_version is null or p_expected_account_version < 1) then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:create:' || pg_catalog.lower(v_code),
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- Tier 1 (D): initial department
  if p_initial_department_id is not null then
    perform public.org_department__internal_lock_department(p_initial_department_id);
    select d.* into v_dept
      from public.organization_departments d
     where d.department_id = p_initial_department_id
     for update;
    if not found then
      raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  -- Tier 2 (U): p_account_ref plus any verified active/suspended account linked to p_recruiter_id
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select p_account_ref as uid
      union
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where p_recruiter_id is not null
         and rl.recruiter_id = p_recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  foreach v_lock_id in array v_locked_user_ids loop
    perform public.org_department__internal_lock_app_user(v_lock_id);
  end loop;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union all
      select unnest(v_locked_user_ids) as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = any(v_locked_user_ids) then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for share;
    end if;
  end loop;

  if p_account_ref is not null then
    select u.* into v_account
      from public.direct_entry_app_users u
     where u.app_user_id = p_account_ref;
    if not found then
      raise exception 'TARGET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  -- Tier 3 (R_full): lock all candidate recruiters ascending BEFORE evaluation
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select p_recruiter_id as rid
      union
      select rl.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = any(v_locked_user_ids)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = any(v_locked_user_ids)
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) s
   where rid is not null;

  if cardinality(v_locked_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_locked_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  -- Post-lock completeness guard
  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = any(v_locked_user_ids)
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.recruiter_id = any(v_locked_recruiter_ids))
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where p_recruiter_id is not null
       and rl.recruiter_id = p_recruiter_id
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id = any(v_locked_user_ids)
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
  ) then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if p_account_ref is not null then
    if v_account.version <> p_expected_account_version then
      raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
    end if;
    if exists (
      select 1 from public.organization_account_person_links l
       where l.app_user_id = p_account_ref
         and l.ended_at is null
    ) then
      raise exception 'ACCOUNT_OR_PERSON_ALREADY_LINKED' using errcode = 'PT409';
    end if;

    select rl.recruiter_id
      into v_acct_recruiter_id
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = p_account_ref
       and rl.verified = true
       and rl.is_current = true
     order by rl.valid_from desc, rl.link_id desc
     limit 1;

    if v_acct_recruiter_id is not null and p_recruiter_id is not null and v_acct_recruiter_id <> p_recruiter_id then
      raise exception 'RECRUITER_LINK_MISMATCH' using errcode = 'PT409';
    end if;
    if v_resolved_recruiter_id is null and v_acct_recruiter_id is not null then
      v_resolved_recruiter_id := v_acct_recruiter_id;
    end if;
  end if;

  if v_resolved_recruiter_id is not null then
    select r.* into v_recruiter
      from public.recruiters r
     where r.recruiter_id = v_resolved_recruiter_id;
    if not found then
      raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
    end if;
    if exists (select 1 from public.organization_persons p where p.recruiter_id = v_resolved_recruiter_id) then
      raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
    end if;
    if exists (
      select 1
        from public.direct_entry_app_user_recruiter_links rl
       where rl.recruiter_id = v_resolved_recruiter_id
         and rl.verified = true
         and rl.is_current = true
         and (p_account_ref is null or rl.app_user_id <> p_account_ref)
    ) then
      raise exception 'RECRUITER_ALREADY_LINKED_TO_OTHER_ACCOUNT' using errcode = 'PT409';
    end if;
  end if;

  -- Cross-domain guard: any active initial department is required when blocking team/TL assignment exists
  if (v_resolved_recruiter_id is not null or p_account_ref is not null)
     and public.org_department__internal_subject_has_blocking_team_assignment(
       v_locked_recruiter_ids,
       v_locked_user_ids,
       v_today
     )
     and (
       p_initial_department_id is null
       or not v_dept.is_active
     ) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT' using errcode = 'PT409';
  end if;

  if p_initial_department_id is not null and not v_dept.is_active then
    raise exception 'DEPARTMENT_INACTIVE' using errcode = 'PT409';
  end if;

  if exists (
    select 1 from public.organization_persons p
     where pg_catalog.lower(p.employee_code) = pg_catalog.lower(v_code)
  ) then
    raise exception 'DUPLICATE_CODE' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();

  if p_account_ref is not null then
    select c.department_id, c.unit_kind
      into v_before_leave_dept_id, v_before_leave_unit_kind
      from public.org_department__internal_resolve_leave_classification(p_account_ref, v_now) c;
  end if;

  insert into public.organization_persons (
    employee_code,
    full_name,
    joined_on,
    status,
    recruiter_id,
    version,
    created_by_app_user_id,
    updated_by_app_user_id,
    created_at,
    updated_at
  )
  values (
    v_code,
    v_name,
    p_joined_on,
    'ACTIVE',
    v_resolved_recruiter_id,
    1,
    p_app_user_id,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_person;

  if p_initial_department_id is not null then
    insert into public.organization_person_department_memberships (
      person_id,
      department_id,
      started_at,
      ended_at,
      source_kind,
      version,
      reason,
      created_by_app_user_id,
      created_at,
      updated_at
    )
    values (
      v_person.person_id,
      p_initial_department_id,
      v_now,
      null,
      'ADMIN_MUTATION',
      1,
      v_reason,
      p_app_user_id,
      v_now,
      v_now
    );
  end if;

  if v_resolved_recruiter_id is not null and v_recruiter.display_name is distinct from v_person.full_name then
    v_reason_id := coalesce(v_reason_id, public.direct_entry_reason(p_app_user_id, v_reason));
    update public.recruiters
       set display_name = v_person.full_name
     where recruiter_id = v_resolved_recruiter_id;

    perform public.direct_entry_bump_personnel_version(
      v_resolved_recruiter_id,
      p_app_user_id,
      v_reason_id,
      public.direct_entry_personnel_snapshot(v_recruiter),
      pg_catalog.jsonb_set(
        public.direct_entry_personnel_snapshot(v_recruiter),
        '{display_name}',
        pg_catalog.to_jsonb(v_person.full_name),
        true
      )
    );
  end if;

  if p_account_ref is not null then
    insert into public.organization_account_person_links (
      app_user_id,
      person_id,
      started_at,
      source_kind,
      version,
      reason,
      created_by_app_user_id,
      created_at,
      updated_at
    )
    values (
      p_account_ref,
      v_person.person_id,
      v_now,
      'ADMIN_MUTATION',
      1,
      v_reason,
      p_app_user_id,
      v_now,
      v_now
    );

    v_prev_display_name := v_account.display_name;
    v_reason_id := coalesce(v_reason_id, public.direct_entry_reason(p_app_user_id, v_reason));

    update public.direct_entry_app_users
       set display_name = v_person.full_name,
           version = v_account.version + 1,
           updated_at = v_now
     where app_user_id = p_account_ref
     returning * into v_account;

    if v_prev_display_name is distinct from v_person.full_name then
      insert into public.direct_entry_app_user_revisions (
        app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
      )
      values (
        p_account_ref,
        v_account.version,
        p_app_user_id,
        'display_name_update',
        pg_catalog.jsonb_build_object('display_name', v_prev_display_name),
        pg_catalog.jsonb_build_object('display_name', v_person.full_name),
        v_reason_id
      );
    else
      insert into public.direct_entry_app_user_revisions (
        app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
      )
      values (
        p_account_ref,
        v_account.version,
        p_app_user_id,
        'link_create',
        pg_catalog.jsonb_build_object('person_id', null),
        pg_catalog.jsonb_build_object('person_id', v_person.person_id),
        v_reason_id
      );
    end if;

    perform public.org_department__internal_sync_accounting_projection(
      p_account_ref,
      p_app_user_id,
      v_reason,
      v_now
    );

    perform public.org_department__internal_bump_leave_profile_version_on_org_change(
      p_account_ref,
      v_before_leave_dept_id,
      v_before_leave_unit_kind,
      p_app_user_id,
      v_now
    );
  end if;

  v_proj := public.org_department__internal_person_detail_projection(v_person, v_now);

  insert into public.organization_department_audit_events (
    department_id,
    target_app_user_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_initial_department_id,
    p_account_ref,
    v_person.person_id,
    p_app_user_id,
    v_action,
    v_reason,
    null,
    v_proj,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'person', v_proj
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:create:' || pg_catalog.lower(v_code),
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_create_person_admin(
  uuid, uuid, text, text, date, uuid, uuid, integer, uuid, text, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.org_department_create_person_admin(
  uuid, uuid, text, text, date, uuid, uuid, integer, uuid, text, uuid, text
) to service_role;

-- (4) org_department_assign_accounting_member
create or replace function public.org_department_assign_accounting_member(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_expected_pair_version integer,
  p_effective_from date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_effective_from date;
  v_reason text;
  v_now timestamptz;
  v_dept public.organization_departments%rowtype;
  v_lock_dept public.organization_departments%rowtype;
  v_idem public.organization_department_idempotency%rowtype;
  v_target public.direct_entry_app_users%rowtype;
  v_linked_person_id uuid := null;
  v_person public.organization_persons%rowtype;
  v_curr_pm public.organization_person_department_memberships%rowtype;
  v_next_pm_ver integer;
  v_current_pair_version integer;
  v_inserted public.organization_department_memberships%rowtype;
  v_projection jsonb;
  v_base_payload jsonb;
  v_target_ref text;
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_lock_id uuid;
  v_before_leave_dept_id uuid := null;
  v_before_leave_unit_kind text := 'UNCLASSIFIED';
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_target_app_user_id is null
     or p_expected_pair_version is null
     or p_expected_pair_version < 0
     or p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case when p_reason is null then null else pg_catalog.btrim(p_reason) end;
  if v_reason is null
     or pg_catalog.length(v_reason) not between 1 and 4000
     or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'DEPARTMENT_MEMBERSHIP_REASON_INVALID'
      using errcode = '22023';
  end if;

  v_today := public.direct_entry_authorization_date();
  v_effective_from := coalesce(p_effective_from, v_today);
  v_target_ref := 'accounting:' || p_target_app_user_id::text;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_idem_v1'),
    pg_catalog.hashtext(p_app_user_id::text || ':' || p_idempotency_key::text)
  );

  select i.*
    into v_idem
    from public.organization_department_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_idem.action <> 'ACCOUNTING_MEMBER_ASSIGNED'
       or (v_idem.target_ref <> '' and v_idem.target_ref <> v_target_ref)
       or v_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if v_effective_from <> v_today then
    raise exception 'DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID'
      using errcode = '22023';
  end if;

  -- Tier 1: P -> D -> M
  select l.person_id
    into v_linked_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_target_app_user_id
     and l.ended_at is null
   limit 1;

  if v_linked_person_id is not null then
    perform public.org_department__internal_lock_person(v_linked_person_id);
    select p.*
      into v_person
      from public.organization_persons p
     where p.person_id = v_linked_person_id
     for update;

    select m.department_id
      into v_curr_pm.department_id
      from public.organization_person_department_memberships m
     where m.person_id = v_linked_person_id
       and m.ended_at is null
     limit 1;
  end if;

  for v_lock_dept in
    select d.*
      from public.organization_departments d
     where d.system_key = 'ACCOUNTING'
        or (v_curr_pm.department_id is not null and d.department_id = v_curr_pm.department_id)
     order by d.department_id
  loop
    perform public.org_department__internal_lock_department(v_lock_dept.department_id);
  end loop;

  for v_lock_dept in
    select d.*
      from public.organization_departments d
     where d.system_key = 'ACCOUNTING'
        or (v_curr_pm.department_id is not null and d.department_id = v_curr_pm.department_id)
     order by d.department_id
     for update
  loop
    if v_lock_dept.system_key = 'ACCOUNTING' then
      v_dept := v_lock_dept;
    end if;
  end loop;

  if v_dept.department_id is null then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if not v_dept.is_active then
    raise exception 'DEPARTMENT_INACTIVE'
      using errcode = '22023';
  end if;

  if v_person.person_id is not null then
    select m.*
      into v_curr_pm
      from public.organization_person_department_memberships m
     where m.person_id = v_person.person_id
       and m.ended_at is null
     for update;
  end if;

  -- Tier 2: U
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select p_target_app_user_id as uid
      union
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where v_person.recruiter_id is not null
         and rl.recruiter_id = v_person.recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  foreach v_lock_id in array v_locked_user_ids loop
    perform public.org_department__internal_lock_app_user(v_lock_id);
  end loop;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_membership_v1'),
    pg_catalog.hashtext(v_dept.department_id::text || ':' || p_target_app_user_id::text)
  );

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union all
      select unnest(v_locked_user_ids) as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = any(v_locked_user_ids) then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for share;
    end if;
  end loop;

  select u.*
    into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- Tier 3: R_full
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select v_person.recruiter_id as rid
      union
      select rl.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = any(v_locked_user_ids)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = any(v_locked_user_ids)
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) s
   where rid is not null;

  if cardinality(v_locked_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_locked_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  -- Post-lock completeness guard
  if exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = p_target_app_user_id
       and l.ended_at is null
       and l.person_id is distinct from v_linked_person_id
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = any(v_locked_user_ids)
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.recruiter_id = any(v_locked_recruiter_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id = any(v_locked_user_ids)
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
  ) then
    raise exception 'DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  select coalesce(max(m.version), 0)::integer
    into v_current_pair_version
    from public.organization_department_memberships m
   where m.department_id = v_dept.department_id
     and m.app_user_id = p_target_app_user_id;

  if v_current_pair_version <> p_expected_pair_version then
    raise exception 'DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  -- Cross-domain guard: ACCOUNTING is allowed when linked person is ACTIVE (or unlinked);
  -- block only if linked person is INACTIVE while holding an active team/TL assignment.
  if v_person.person_id is not null
     and v_person.status <> 'ACTIVE'
     and public.org_department__internal_subject_has_blocking_team_assignment(
       v_locked_recruiter_ids,
       v_locked_user_ids,
       v_today
     ) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT'
      using errcode = 'PT409';
  end if;

  if not v_target.enabled then
    raise exception 'TARGET_ACCOUNT_DISABLED'
      using errcode = '23514';
  end if;

  if exists (
    select 1
      from public.organization_department_memberships m
     where m.department_id = v_dept.department_id
       and m.app_user_id = p_target_app_user_id
       and (
         m.valid_to is null
         or pg_catalog.daterange(m.valid_from, m.valid_to, '[)')
            && pg_catalog.daterange(v_effective_from, null, '[)')
       )
  ) then
    raise exception 'DEPARTMENT_MEMBERSHIP_OVERLAP'
      using errcode = '23P01';
  end if;

  v_now := pg_catalog.clock_timestamp();

  select c.department_id, c.unit_kind
    into v_before_leave_dept_id, v_before_leave_unit_kind
    from public.org_department__internal_resolve_leave_classification(p_target_app_user_id, v_now) c;

  -- Sync WP3 person_department_memberships if account is linked to a person
  if v_person.person_id is not null then
    if v_person.status <> 'ACTIVE' then
      raise exception 'PERSON_INACTIVE'
        using errcode = 'PT409';
    end if;

    if v_curr_pm.membership_id is not null and v_curr_pm.department_id <> v_dept.department_id then
      raise exception 'PERSON_ALREADY_IN_OTHER_DEPARTMENT'
        using errcode = 'PT409';
    end if;

    if v_curr_pm.membership_id is null then
      select coalesce(max(m2.version), 0) + 1
        into v_next_pm_ver
        from public.organization_person_department_memberships m2
       where m2.person_id = v_person.person_id;

      insert into public.organization_person_department_memberships (
        person_id,
        department_id,
        started_at,
        ended_at,
        source_kind,
        version,
        reason,
        created_by_app_user_id,
        created_at,
        updated_at
      )
      values (
        v_person.person_id,
        v_dept.department_id,
        v_now,
        null,
        'ADMIN_MUTATION',
        v_next_pm_ver,
        pg_catalog.left(v_reason, 500),
        p_app_user_id,
        v_now,
        v_now
      )
      returning * into v_curr_pm;

      update public.organization_persons
         set version = v_person.version + 1,
             updated_at = v_now,
             updated_by_app_user_id = p_app_user_id
       where person_id = v_person.person_id;

      insert into public.organization_department_audit_events (
        department_id,
        membership_id,
        target_app_user_id,
        target_person_id,
        actor_user_id,
        action,
        reason,
        before_snapshot,
        after_snapshot,
        idempotency_key,
        created_at
      ) values (
        v_dept.department_id,
        null,
        p_target_app_user_id,
        v_person.person_id,
        p_app_user_id,
        'PERSON_DEPT_ASSIGNED',
        pg_catalog.left(v_reason, 500),
        null,
        public.org_department__internal_person_membership_projection(v_curr_pm, v_now),
        p_idempotency_key,
        v_now
      );
    end if;
  end if;

  insert into public.organization_department_memberships (
    department_id,
    app_user_id,
    valid_from,
    valid_to,
    version,
    granted_by_user_id,
    grant_reason
  ) values (
    v_dept.department_id,
    p_target_app_user_id,
    v_effective_from,
    null,
    v_current_pair_version + 1,
    p_app_user_id,
    v_reason
  )
  returning * into v_inserted;

  perform public.org_department__internal_bump_leave_profile_version_on_org_change(
    p_target_app_user_id,
    v_before_leave_dept_id,
    v_before_leave_unit_kind,
    p_app_user_id,
    v_now
  );

  v_projection := public.org_department__internal_membership_projection(
    v_inserted,
    v_inserted.version,
    v_today
  );

  insert into public.organization_department_audit_events (
    department_id,
    membership_id,
    target_app_user_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key
  ) values (
    v_dept.department_id,
    v_inserted.membership_id,
    p_target_app_user_id,
    v_person.person_id,
    p_app_user_id,
    'ACCOUNTING_MEMBER_ASSIGNED',
    v_reason,
    null,
    v_projection,
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object('membership', v_projection);

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ACCOUNTING_MEMBER_ASSIGNED',
    v_target_ref,
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.org_department_assign_accounting_member(
  uuid, uuid, uuid, integer, date, text, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.org_department_assign_accounting_member(
  uuid, uuid, uuid, integer, date, text, uuid, text
) to service_role;

-- (5) org_department_end_accounting_member
create or replace function public.org_department_end_accounting_member(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_membership_id uuid,
  p_expected_pair_version integer,
  p_effective_to date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_effective_to date;
  v_reason text;
  v_now timestamptz;
  v_dept public.organization_departments%rowtype;
  v_idem public.organization_department_idempotency%rowtype;
  v_target_user_id uuid;
  v_all_user_ids uuid[];
  v_lock_id uuid;
  v_linked_person_id uuid := null;
  v_person public.organization_persons%rowtype;
  v_curr_pm public.organization_person_department_memberships%rowtype;
  v_target public.direct_entry_app_users%rowtype;
  v_membership public.organization_department_memberships%rowtype;
  v_updated public.organization_department_memberships%rowtype;
  v_current_pair_version integer;
  v_before jsonb;
  v_after jsonb;
  v_base_payload jsonb;
  v_target_ref text;
  v_prev_cancel text := pg_catalog.current_setting('org_department.membership_cancel_marker', true);
  v_before_leave_dept_id uuid := null;
  v_before_leave_unit_kind text := 'UNCLASSIFIED';
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_membership_id is null
     or p_expected_pair_version is null
     or p_expected_pair_version < 1
     or p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'DEPARTMENT_MEMBERSHIP_PAYLOAD_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case when p_reason is null then null else pg_catalog.btrim(p_reason) end;
  if v_reason is null
     or pg_catalog.length(v_reason) not between 1 and 4000
     or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'DEPARTMENT_MEMBERSHIP_REASON_INVALID'
      using errcode = '22023';
  end if;

  v_today := public.direct_entry_authorization_date();
  v_target_ref := 'accounting_end:' || p_membership_id::text;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_idem_v1'),
    pg_catalog.hashtext(p_app_user_id::text || ':' || p_idempotency_key::text)
  );

  select i.*
    into v_idem
    from public.organization_department_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_idem.action <> 'ACCOUNTING_MEMBER_ENDED'
       or (v_idem.target_ref <> '' and v_idem.target_ref <> v_target_ref)
       or v_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select d.department_id
    into v_dept.department_id
    from public.organization_departments d
   where d.system_key = 'ACCOUNTING';

  if v_dept.department_id is null then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select m.app_user_id
    into v_target_user_id
    from public.organization_department_memberships m
   where m.membership_id = p_membership_id
     and m.department_id = v_dept.department_id;

  if not found then
    raise exception 'DEPARTMENT_MEMBERSHIP_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select l.person_id
    into v_linked_person_id
    from public.organization_account_person_links l
   where l.app_user_id = v_target_user_id
     and l.ended_at is null
   limit 1;

  if v_linked_person_id is not null then
    perform public.org_department__internal_lock_person(v_linked_person_id);
    select p.*
      into v_person
      from public.organization_persons p
     where p.person_id = v_linked_person_id
     for update;
  end if;

  perform public.org_department__internal_lock_department(v_dept.department_id);

  select d.*
    into v_dept
    from public.organization_departments d
   where d.department_id = v_dept.department_id
   for update;

  perform public.org_department__internal_lock_app_user(v_target_user_id);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_membership_v1'),
    pg_catalog.hashtext(v_dept.department_id::text || ':' || v_target_user_id::text)
  );

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union all
      select v_target_user_id as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = v_target_user_id then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for share;
    end if;
  end loop;

  select u.*
    into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = v_target_user_id;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = v_target_user_id
       and l.ended_at is null
       and l.person_id is distinct from v_linked_person_id
  ) then
    raise exception 'DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  select m.*
    into v_membership
    from public.organization_department_memberships m
   where m.membership_id = p_membership_id
     and m.department_id = v_dept.department_id
   for update;

  if not found then
    raise exception 'DEPARTMENT_MEMBERSHIP_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select coalesce(max(m.version), 0)::integer
    into v_current_pair_version
    from public.organization_department_memberships m
   where m.department_id = v_dept.department_id
     and m.app_user_id = v_target_user_id;

  if v_current_pair_version <> p_expected_pair_version
     or v_membership.version <> p_expected_pair_version then
    raise exception 'DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_membership.valid_to is not null then
    raise exception 'DEPARTMENT_MEMBERSHIP_ALREADY_ENDED'
      using errcode = 'PT409';
  end if;

  if p_effective_to is not null and p_effective_to <> v_today then
    raise exception 'DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID'
      using errcode = '22023';
  end if;

  if p_effective_to is not null and p_effective_to < v_membership.valid_from then
    raise exception 'DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_effective_to := greatest(coalesce(p_effective_to, v_today), v_membership.valid_from);
  v_now := pg_catalog.clock_timestamp();

  if v_person.person_id is not null then
    select m.*
      into v_curr_pm
      from public.organization_person_department_memberships m
     where m.person_id = v_person.person_id
       and m.department_id = v_dept.department_id
       and m.ended_at is null
     for update;

    if found then
      if exists (
        select 1
          from public.organization_department_heads h
         where h.department_id = v_dept.department_id
           and h.person_id = v_person.person_id
           and h.ended_at is null
      ) then
        raise exception 'PERSON_IS_ACTIVE_DEPARTMENT_HEAD'
          using errcode = 'PT409';
      end if;

      v_now := greatest(v_now, v_curr_pm.started_at);
    end if;
  end if;

  select c.department_id, c.unit_kind
    into v_before_leave_dept_id, v_before_leave_unit_kind
    from public.org_department__internal_resolve_leave_classification(v_target_user_id, v_now) c;

  if v_curr_pm.membership_id is not null then
    update public.organization_person_department_memberships
       set ended_at = v_now,
           ended_reason = pg_catalog.left(v_reason, 500),
           ended_by_app_user_id = p_app_user_id,
           version = v_curr_pm.version + 1,
           updated_at = v_now
     where membership_id = v_curr_pm.membership_id;

    update public.organization_persons
       set version = v_person.version + 1,
           updated_at = v_now,
           updated_by_app_user_id = p_app_user_id
     where person_id = v_person.person_id;
  end if;

  v_before := public.org_department__internal_membership_projection(
    v_membership,
    v_current_pair_version,
    v_today
  );

  if v_effective_to = v_membership.valid_from then
    perform pg_catalog.set_config('org_department.membership_cancel_marker', 'on', true);
  end if;

  update public.organization_department_memberships
     set valid_to = v_effective_to,
         revoked_by_user_id = p_app_user_id,
         revoke_reason = v_reason,
         revoked_at = v_now,
         version = v_current_pair_version + 1
   where membership_id = p_membership_id
  returning * into v_updated;

  perform pg_catalog.set_config('org_department.membership_cancel_marker', coalesce(v_prev_cancel, ''), true);

  perform public.org_department__internal_bump_leave_profile_version_on_org_change(
    v_target_user_id,
    v_before_leave_dept_id,
    v_before_leave_unit_kind,
    p_app_user_id,
    v_now
  );

  v_after := public.org_department__internal_membership_projection(
    v_updated,
    v_updated.version,
    v_today
  );

  insert into public.organization_department_audit_events (
    department_id,
    membership_id,
    target_app_user_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key
  ) values (
    v_dept.department_id,
    v_updated.membership_id,
    v_target_user_id,
    v_person.person_id,
    p_app_user_id,
    'ACCOUNTING_MEMBER_ENDED',
    v_reason,
    v_before,
    v_after,
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object('membership', v_after);

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ACCOUNTING_MEMBER_ENDED',
    v_target_ref,
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
exception
  when others then
    perform pg_catalog.set_config('org_department.membership_cancel_marker', coalesce(v_prev_cancel, ''), true);
    raise;
end;
$function$;

revoke all on function public.org_department_end_accounting_member(
  uuid, uuid, uuid, integer, date, text, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.org_department_end_accounting_member(
  uuid, uuid, uuid, integer, date, text, uuid, text
) to service_role;

-- (6) org_department_assign_person_member_admin
create or replace function public.org_department_assign_person_member_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_department_id uuid,
  p_person_id uuid,
  p_expected_person_version integer,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'PERSON_DEPT_ASSIGNED';
  v_today date := public.direct_entry_authorization_date();
  v_reason text;
  v_replay jsonb;
  v_dept public.organization_departments%rowtype;
  v_person public.organization_persons%rowtype;
  v_existing public.organization_person_department_memberships%rowtype;
  v_inserted public.organization_person_department_memberships%rowtype;
  v_now timestamptz;
  v_next_ver integer;
  v_proj jsonb;
  v_result jsonb;
  v_linked_app_user_id uuid;
  v_locked_dept_ids uuid[];
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_lock_id uuid;
  v_before_leave_dept_id uuid := null;
  v_before_leave_unit_kind text := 'UNCLASSIFIED';
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_department_id is null or p_person_id is null or p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':person:' || p_person_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- Tier 1 (P -> D -> M)
  perform public.org_department__internal_lock_person(p_person_id);

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = p_person_id
   for update;

  select coalesce(array_agg(distinct did order by did), array[]::uuid[])
    into v_locked_dept_ids
    from (
      select p_department_id as did
      union
      select m.department_id as did
        from public.organization_person_department_memberships m
       where m.person_id = p_person_id
         and m.ended_at is null
    ) s
   where did is not null;

  foreach v_lock_id in array v_locked_dept_ids loop
    perform public.org_department__internal_lock_department(v_lock_id);
  end loop;

  perform d.department_id
    from public.organization_departments d
   where d.department_id = any(v_locked_dept_ids)
   order by d.department_id asc
   for update;

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id;

  select m.* into v_existing
    from public.organization_person_department_memberships m
   where m.person_id = p_person_id
     and m.ended_at is null
   for update;

  -- Tier 2 (U) & Tier 3 (R_full) lifted BEFORE any insert/check
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select l.app_user_id as uid
        from public.organization_account_person_links l
       where l.person_id = p_person_id
         and l.ended_at is null
      union
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where v_person.recruiter_id is not null
         and rl.recruiter_id = v_person.recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  foreach v_lock_id in array v_locked_user_ids loop
    perform public.org_department__internal_lock_app_user(v_lock_id);
  end loop;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union all
      select unnest(v_locked_user_ids) as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = any(v_locked_user_ids) then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for share;
    end if;
  end loop;

  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select v_person.recruiter_id as rid
      union
      select rl.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = any(v_locked_user_ids)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = any(v_locked_user_ids)
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) s
   where rid is not null;

  if cardinality(v_locked_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_locked_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  -- Post-lock completeness guard
  if exists (
    select 1
      from public.organization_account_person_links l
     where l.person_id = p_person_id
       and l.ended_at is null
       and not (l.app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = any(v_locked_user_ids)
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.recruiter_id = any(v_locked_recruiter_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id = any(v_locked_user_ids)
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
  ) then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_dept.department_id is null then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_person.person_id is null then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_person.status <> 'ACTIVE' then
    raise exception 'PERSON_INACTIVE' using errcode = 'PT409';
  end if;

  if not v_dept.is_active then
    raise exception 'DEPARTMENT_INACTIVE' using errcode = 'PT409';
  end if;

  if v_existing.membership_id is not null then
    raise exception 'PERSON_ALREADY_IN_DEPARTMENT' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();

  select c.department_id, c.unit_kind
    into v_before_leave_dept_id, v_before_leave_unit_kind
    from public.org_department__internal_resolve_person_leave_classification(p_person_id, v_now) c;

  select coalesce(max(m2.version), 0) + 1
    into v_next_ver
    from public.organization_person_department_memberships m2
   where m2.person_id = p_person_id;

  insert into public.organization_person_department_memberships (
    person_id,
    department_id,
    started_at,
    ended_at,
    source_kind,
    version,
    reason,
    created_by_app_user_id,
    created_at,
    updated_at
  )
  values (
    p_person_id,
    p_department_id,
    v_now,
    null,
    'ADMIN_MUTATION',
    v_next_ver,
    v_reason,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_inserted;

  update public.organization_persons
     set version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = p_person_id;

  for v_linked_app_user_id in
    select l.app_user_id
      from public.organization_account_person_links l
     where l.person_id = p_person_id
       and l.ended_at is null
     order by l.app_user_id
  loop
    if v_dept.system_key = 'ACCOUNTING' then
      perform public.org_department__internal_sync_accounting_projection(
        v_linked_app_user_id,
        p_app_user_id,
        v_reason,
        v_now
      );
    end if;
    perform public.org_department__internal_bump_leave_profile_version_on_org_change(
      v_linked_app_user_id,
      v_before_leave_dept_id,
      v_before_leave_unit_kind,
      p_app_user_id,
      v_now
    );
  end loop;

  v_proj := public.org_department__internal_person_membership_projection(v_inserted, v_now);

  insert into public.organization_department_audit_events (
    department_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_department_id,
    p_person_id,
    p_app_user_id,
    v_action,
    v_reason,
    null,
    v_proj,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'person_version', v_person.version + 1,
    'membership', v_proj
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':person:' || p_person_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_assign_person_member_admin(
  uuid, uuid, uuid, uuid, integer, text, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.org_department_assign_person_member_admin(
  uuid, uuid, uuid, uuid, integer, text, uuid, text
) to service_role;

-- (7) org_department_transfer_person_member_admin
create or replace function public.org_department_transfer_person_member_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_person_id uuid,
  p_target_department_id uuid,
  p_expected_person_version integer,
  p_expected_current_membership_id uuid,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'PERSON_DEPT_TRANSFERRED';
  v_today date := public.direct_entry_authorization_date();
  v_reason text;
  v_replay jsonb;
  v_curr_dept_id uuid;
  v_lock_dept_id uuid;
  v_lock_id uuid;
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_lock_dept public.organization_departments%rowtype;
  v_person public.organization_persons%rowtype;
  v_to_dept public.organization_departments%rowtype;
  v_from_dept public.organization_departments%rowtype;
  v_curr_m public.organization_person_department_memberships%rowtype;
  v_closed_m public.organization_person_department_memberships%rowtype;
  v_new_m public.organization_person_department_memberships%rowtype;
  v_now timestamptz;
  v_before jsonb;
  v_active_proj jsonb;
  v_next_ver integer;
  v_result jsonb;
  v_acc_row public.direct_entry_app_users%rowtype;
  v_before_leave_dept_id uuid := null;
  v_before_leave_unit_kind text := 'UNCLASSIFIED';
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_person_id is null
     or p_target_department_id is null
     or p_expected_person_version is null or p_expected_person_version < 1
     or p_expected_current_membership_id is null then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:' || p_person_id::text || ':transfer:' || p_target_department_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- Tier 1: P -> D -> M
  perform public.org_department__internal_lock_person(p_person_id);

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = p_person_id
   for update;

  select m.department_id
    into v_curr_dept_id
    from public.organization_person_department_memberships m
   where m.person_id = p_person_id
     and m.ended_at is null
   limit 1;

  for v_lock_dept_id in
    select distinct did
      from pg_catalog.unnest(array[p_target_department_id, v_curr_dept_id]) as t(did)
     where did is not null
     order by did
  loop
    perform public.org_department__internal_lock_department(v_lock_dept_id);
  end loop;

  for v_lock_dept in
    select d.*
      from public.organization_departments d
     where d.department_id = p_target_department_id
        or (v_curr_dept_id is not null and d.department_id = v_curr_dept_id)
     order by d.department_id
     for update
  loop
    if v_lock_dept.department_id = p_target_department_id then
      v_to_dept := v_lock_dept;
    end if;
    if v_curr_dept_id is not null and v_lock_dept.department_id = v_curr_dept_id then
      v_from_dept := v_lock_dept;
    end if;
  end loop;

  select m.* into v_curr_m
    from public.organization_person_department_memberships m
   where m.person_id = p_person_id
     and m.ended_at is null
   for update;

  -- Tier 2 (U) & Tier 3 (R_full) lifted BEFORE any writes
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select l.app_user_id as uid
        from public.organization_account_person_links l
       where l.person_id = p_person_id
         and l.ended_at is null
      union
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where v_person.recruiter_id is not null
         and rl.recruiter_id = v_person.recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  foreach v_lock_id in array v_locked_user_ids loop
    perform public.org_department__internal_lock_app_user(v_lock_id);
  end loop;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union all
      select unnest(v_locked_user_ids) as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = any(v_locked_user_ids) then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for share;
    end if;
  end loop;

  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select v_person.recruiter_id as rid
      union
      select rl.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = any(v_locked_user_ids)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = any(v_locked_user_ids)
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) s
   where rid is not null;

  if cardinality(v_locked_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_locked_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  -- Post-lock completeness guard
  if exists (
    select 1
      from public.organization_account_person_links l
     where l.person_id = p_person_id
       and l.ended_at is null
       and not (l.app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = any(v_locked_user_ids)
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.recruiter_id = any(v_locked_recruiter_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id = any(v_locked_user_ids)
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
  ) then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_to_dept.department_id is null then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_person.person_id is null then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_curr_m.membership_id is null or v_curr_m.membership_id is distinct from p_expected_current_membership_id then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_person.status <> 'ACTIVE' then
    raise exception 'PERSON_INACTIVE' using errcode = 'PT409';
  end if;

  if not v_to_dept.is_active then
    raise exception 'DEPARTMENT_INACTIVE' using errcode = 'PT409';
  end if;

  if v_curr_m.department_id = p_target_department_id then
    raise exception 'SAME_TARGET_DEPARTMENT' using errcode = 'PT409';
  end if;

  if exists (
    select 1 from public.organization_department_heads h
     where h.department_id = v_curr_m.department_id
       and h.person_id = p_person_id
       and h.ended_at is null
  ) then
    raise exception 'PERSON_IS_ACTIVE_DEPARTMENT_HEAD' using errcode = 'PT409';
  end if;

  v_now := greatest(pg_catalog.clock_timestamp(), v_curr_m.started_at);

  select c.department_id, c.unit_kind
    into v_before_leave_dept_id, v_before_leave_unit_kind
    from public.org_department__internal_resolve_person_leave_classification(p_person_id, v_now) c;

  v_before := public.org_department__internal_person_membership_projection(v_curr_m, v_now);

  update public.organization_person_department_memberships
     set ended_at = v_now,
         ended_reason = v_reason,
         ended_by_app_user_id = p_app_user_id,
         version = v_curr_m.version + 1,
         updated_at = v_now
   where membership_id = v_curr_m.membership_id
   returning * into v_closed_m;

  select coalesce(max(m2.version), 0) + 1
    into v_next_ver
    from public.organization_person_department_memberships m2
   where m2.person_id = p_person_id;

  insert into public.organization_person_department_memberships (
    person_id,
    department_id,
    started_at,
    ended_at,
    source_kind,
    version,
    reason,
    created_by_app_user_id,
    created_at,
    updated_at
  )
  values (
    p_person_id,
    p_target_department_id,
    v_now,
    null,
    'ADMIN_MUTATION',
    v_next_ver,
    v_reason,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_new_m;

  update public.organization_persons
     set version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = p_person_id;

  for v_acc_row in
    select u.*
      from public.direct_entry_app_users u
     where exists (
       select 1
         from public.organization_account_person_links l
        where l.person_id = p_person_id
          and l.app_user_id = u.app_user_id
          and l.ended_at is null
     )
     order by u.app_user_id
  loop
    perform public.org_department__internal_sync_accounting_projection(
      v_acc_row.app_user_id,
      p_app_user_id,
      v_reason,
      v_now
    );

    perform public.org_department__internal_bump_leave_profile_version_on_org_change(
      v_acc_row.app_user_id,
      v_before_leave_dept_id,
      v_before_leave_unit_kind,
      p_app_user_id,
      v_now
    );
  end loop;

  v_active_proj := pg_catalog.jsonb_build_object(
    'membership_id', v_new_m.membership_id,
    'department_id', v_to_dept.department_id,
    'system_key', v_to_dept.system_key,
    'code', v_to_dept.code,
    'name', v_to_dept.name,
    'started_at', public.org_department__internal_iso_utc(v_new_m.started_at),
    'ended_at', null,
    'source_kind', v_new_m.source_kind,
    'evidence_date', null,
    'version', v_new_m.version
  );

  insert into public.organization_department_audit_events (
    department_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_target_department_id,
    p_person_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_active_proj,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'person_version', v_person.version + 1,
    'closed_membership', pg_catalog.jsonb_build_object(
      'membership_id', v_closed_m.membership_id,
      'department_id', v_closed_m.department_id,
      'started_at', public.org_department__internal_iso_utc(v_closed_m.started_at),
      'ended_at', public.org_department__internal_iso_utc(v_closed_m.ended_at),
      'version', v_closed_m.version
    ),
    'active_membership', v_active_proj
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:' || p_person_id::text || ':transfer:' || p_target_department_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_transfer_person_member_admin(
  uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.org_department_transfer_person_member_admin(
  uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text
) to service_role;

-- (8) org_department_end_person_member_admin
create or replace function public.org_department_end_person_member_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_department_id uuid,
  p_membership_id uuid,
  p_expected_person_version integer,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'PERSON_DEPT_ENDED';
  v_today date := public.direct_entry_authorization_date();
  v_reason text;
  v_replay jsonb;
  v_m_person_id uuid;
  v_m public.organization_person_department_memberships%rowtype;
  v_person public.organization_persons%rowtype;
  v_dept public.organization_departments%rowtype;
  v_ended public.organization_person_department_memberships%rowtype;
  v_now timestamptz;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_linked_app_user_id uuid;
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_lock_id uuid;
  v_before_leave_dept_id uuid := null;
  v_before_leave_unit_kind text := 'UNCLASSIFIED';
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_department_id is null or p_membership_id is null or p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':membership:' || p_membership_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select m.person_id into v_m_person_id
    from public.organization_person_department_memberships m
   where m.membership_id = p_membership_id
     and m.department_id = p_department_id;

  if not found then
    raise exception 'DEPARTMENT_MEMBERSHIP_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier 1: P -> D -> M
  perform public.org_department__internal_lock_person(v_m_person_id);

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = v_m_person_id
   for update;

  perform public.org_department__internal_lock_department(p_department_id);

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id
   for update;

  select m.* into v_m
    from public.organization_person_department_memberships m
   where m.membership_id = p_membership_id
     and m.department_id = p_department_id
   for update;

  if v_m.membership_id is null then
    raise exception 'DEPARTMENT_MEMBERSHIP_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier 2 (U) & Tier 3 (R_full) lifted BEFORE any closing writes
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select l.app_user_id as uid
        from public.organization_account_person_links l
       where l.person_id = v_person.person_id
         and l.ended_at is null
      union
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where v_person.recruiter_id is not null
         and rl.recruiter_id = v_person.recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  foreach v_lock_id in array v_locked_user_ids loop
    perform public.org_department__internal_lock_app_user(v_lock_id);
  end loop;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union all
      select unnest(v_locked_user_ids) as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = any(v_locked_user_ids) then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for share;
    end if;
  end loop;

  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select v_person.recruiter_id as rid
      union
      select rl.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = any(v_locked_user_ids)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = any(v_locked_user_ids)
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) s
   where rid is not null;

  if cardinality(v_locked_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_locked_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  -- Post-lock completeness guard
  if exists (
    select 1
      from public.organization_account_person_links l
     where l.person_id = v_person.person_id
       and l.ended_at is null
       and not (l.app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = any(v_locked_user_ids)
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.recruiter_id = any(v_locked_recruiter_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id = any(v_locked_user_ids)
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
  ) then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_m.ended_at is not null then
    raise exception 'DEPARTMENT_MEMBERSHIP_ALREADY_ENDED' using errcode = 'PT409';
  end if;

  if exists (
    select 1 from public.organization_department_heads h
     where h.department_id = p_department_id
       and h.person_id = v_person.person_id
       and h.ended_at is null
  ) then
    raise exception 'PERSON_IS_ACTIVE_DEPARTMENT_HEAD' using errcode = 'PT409';
  end if;

  -- Cross-domain guard: block ending RECRUITMENT membership while blocking team/leader assignment exists
  if public.org_department__internal_person_has_blocking_team_assignment(v_person.person_id, v_today) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT' using errcode = 'PT409';
  end if;

  v_now := greatest(pg_catalog.clock_timestamp(), v_m.started_at);

  select c.department_id, c.unit_kind
    into v_before_leave_dept_id, v_before_leave_unit_kind
    from public.org_department__internal_resolve_person_leave_classification(v_person.person_id, v_now) c;

  v_before := public.org_department__internal_person_membership_projection(v_m, v_now);

  update public.organization_person_department_memberships
     set ended_at = v_now,
         ended_reason = v_reason,
         ended_by_app_user_id = p_app_user_id,
         version = v_m.version + 1,
         updated_at = v_now
   where membership_id = v_m.membership_id
   returning * into v_ended;

  update public.organization_persons
     set version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = v_person.person_id;

  for v_linked_app_user_id in
    select l.app_user_id
      from public.organization_account_person_links l
     where l.person_id = v_person.person_id
       and l.ended_at is null
     order by l.app_user_id
  loop
    if v_dept.system_key = 'ACCOUNTING' then
      perform public.org_department__internal_sync_accounting_projection(
        v_linked_app_user_id,
        p_app_user_id,
        v_reason,
        v_now
      );
    end if;
    perform public.org_department__internal_bump_leave_profile_version_on_org_change(
      v_linked_app_user_id,
      v_before_leave_dept_id,
      v_before_leave_unit_kind,
      p_app_user_id,
      v_now
    );
  end loop;

  v_after := public.org_department__internal_person_membership_projection(v_ended, v_now);

  insert into public.organization_department_audit_events (
    department_id,
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_department_id,
    v_person.person_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'person_version', v_person.version + 1,
    'membership', v_after
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'department:' || p_department_id::text || ':membership:' || p_membership_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_end_person_member_admin(
  uuid, uuid, uuid, uuid, integer, text, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.org_department_end_person_member_admin(
  uuid, uuid, uuid, uuid, integer, text, uuid, text
) to service_role;

-- (9) org_department_update_person_admin
create or replace function public.org_department_update_person_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_person_id uuid,
  p_expected_person_version integer,
  p_employee_code text,
  p_full_name text,
  p_joined_on date,
  p_status text,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'PERSON_UPDATED';
  v_today date := public.direct_entry_authorization_date();
  v_code text;
  v_name text;
  v_reason text;
  v_replay jsonb;
  v_person public.organization_persons%rowtype;
  v_updated public.organization_persons%rowtype;
  v_now timestamptz;
  v_reason_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_acc_row public.direct_entry_app_users%rowtype;
  v_rec_row public.recruiters%rowtype;
  v_locked_dept_ids uuid[];
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_lock_id uuid;
  v_prev_name text;
  v_before_leave_dept_id uuid := null;
  v_before_leave_unit_kind text := 'UNCLASSIFIED';
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if p_person_id is null or p_expected_person_version is null or p_expected_person_version < 1 then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;

  v_code := pg_catalog.btrim(coalesce(p_employee_code, ''));
  v_name := pg_catalog.btrim(coalesce(p_full_name, ''));
  if pg_catalog.length(v_code) < 2 or pg_catalog.length(v_code) > 64 or v_code ~ '[\x00-\x1F\x7F]' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_code ~* '^hrp-[0-9]{4}-[0-9]{6}$' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if pg_catalog.length(v_name) < 1 or pg_catalog.length(v_name) > 160 or v_name ~ '[\x00-\x1F\x7F]' then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('ACTIVE', 'INACTIVE') then
    raise exception 'ORG_VALIDATION_ERROR' using errcode = '22023';
  end if;
  v_reason := public.org_department__internal_normalize_reason(p_reason);

  v_replay := public.org_department__internal_assert_idempotency(
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:' || p_person_id::text,
    p_request_fingerprint
  );
  if v_replay is not null then
    return v_replay;
  end if;

  -- Tier 1 (P -> D -> M)
  perform public.org_department__internal_lock_person(p_person_id);

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = p_person_id
   for update;

  if not found then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct m.department_id order by m.department_id), array[]::uuid[])
    into v_locked_dept_ids
    from public.organization_person_department_memberships m
   where m.person_id = p_person_id
     and m.ended_at is null;

  foreach v_lock_id in array v_locked_dept_ids loop
    perform public.org_department__internal_lock_department(v_lock_id);
  end loop;

  if cardinality(v_locked_dept_ids) > 0 then
    perform d.department_id
      from public.organization_departments d
     where d.department_id = any(v_locked_dept_ids)
     order by d.department_id asc
     for update;

    perform m.membership_id
      from public.organization_person_department_memberships m
     where m.person_id = p_person_id
       and m.ended_at is null
     order by m.membership_id asc
     for update;
  end if;

  -- Tier 2 (U) & Tier 3 (R_full) lifted BEFORE any update
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select l.app_user_id as uid
        from public.organization_account_person_links l
       where l.person_id = p_person_id
         and l.ended_at is null
      union
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where v_person.recruiter_id is not null
         and rl.recruiter_id = v_person.recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  foreach v_lock_id in array v_locked_user_ids loop
    perform public.org_department__internal_lock_app_user(v_lock_id);
  end loop;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union all
      select unnest(v_locked_user_ids) as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = any(v_locked_user_ids) then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_lock_id
       for share;
    end if;
  end loop;

  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select v_person.recruiter_id as rid
      union
      select rl.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = any(v_locked_user_ids)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = any(v_locked_user_ids)
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) s
   where rid is not null;

  if cardinality(v_locked_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_locked_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  -- Post-lock completeness guard
  if exists (
    select 1
      from public.organization_account_person_links l
     where l.person_id = p_person_id
       and l.ended_at is null
       and not (l.app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = any(v_locked_user_ids)
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.recruiter_id = any(v_locked_recruiter_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id = any(v_locked_user_ids)
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
  ) then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_person.version <> p_expected_person_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if exists (
    select 1 from public.organization_persons p2
     where pg_catalog.lower(p2.employee_code) = pg_catalog.lower(v_code)
       and p2.person_id <> p_person_id
  ) then
    raise exception 'DUPLICATE_CODE' using errcode = 'PT409';
  end if;

  if p_status = 'INACTIVE' and exists (
    select 1 from public.organization_department_heads h
     where h.person_id = p_person_id
       and h.ended_at is null
  ) then
    raise exception 'PERSON_IS_ACTIVE_DEPARTMENT_HEAD' using errcode = 'PT409';
  end if;

  if p_status = 'INACTIVE'
     and public.org_department__internal_person_has_blocking_team_assignment(p_person_id, v_today) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();

  select c.department_id, c.unit_kind
    into v_before_leave_dept_id, v_before_leave_unit_kind
    from public.org_department__internal_resolve_person_leave_classification(p_person_id, v_now) c;

  v_before := public.org_department__internal_person_detail_projection(v_person, v_now);

  update public.organization_persons
     set employee_code = v_code,
         full_name = v_name,
         joined_on = p_joined_on,
         status = p_status,
         deactivated_at = case
           when p_status = 'INACTIVE' then coalesce(v_person.deactivated_at, v_now)
           else null
         end,
         deactivated_by_user_id = case
           when p_status = 'INACTIVE' then coalesce(v_person.deactivated_by_user_id, p_app_user_id)
           else null
         end,
         deactivate_reason = case
           when p_status = 'INACTIVE' then coalesce(v_person.deactivate_reason, v_reason)
           else null
         end,
         version = v_person.version + 1,
         updated_at = v_now,
         updated_by_app_user_id = p_app_user_id
   where person_id = p_person_id
   returning * into v_updated;

  for v_acc_row in
    select u.*
      from public.direct_entry_app_users u
     where exists (
       select 1
         from public.organization_account_person_links l
        where l.person_id = p_person_id
          and l.app_user_id = u.app_user_id
          and l.ended_at is null
     )
     order by u.app_user_id
  loop
    if v_updated.full_name is distinct from v_acc_row.display_name then
      v_prev_name := v_acc_row.display_name;
      v_reason_id := coalesce(v_reason_id, public.direct_entry_reason(p_app_user_id, v_reason));

      update public.direct_entry_app_users
         set display_name = v_updated.full_name,
             version = v_acc_row.version + 1,
             updated_at = v_now
       where app_user_id = v_acc_row.app_user_id;

      insert into public.direct_entry_app_user_revisions (
        app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
      )
      values (
        v_acc_row.app_user_id,
        v_acc_row.version + 1,
        p_app_user_id,
        'display_name_update',
        pg_catalog.jsonb_build_object('display_name', v_prev_name),
        pg_catalog.jsonb_build_object('display_name', v_updated.full_name),
        v_reason_id
      );
    end if;

    perform public.org_department__internal_sync_accounting_projection(
      v_acc_row.app_user_id,
      p_app_user_id,
      v_reason,
      v_now
    );

    perform public.org_department__internal_bump_leave_profile_version_on_org_change(
      v_acc_row.app_user_id,
      v_before_leave_dept_id,
      v_before_leave_unit_kind,
      p_app_user_id,
      v_now
    );
  end loop;

  if v_updated.full_name is distinct from v_person.full_name then
    for v_rec_row in
      select r.*
        from public.recruiters r
       where (
         v_updated.recruiter_id = r.recruiter_id
         or exists (
           select 1
             from public.organization_account_person_links l
             join public.direct_entry_app_user_recruiter_links rl
               on rl.app_user_id = l.app_user_id
              and rl.verified = true
              and rl.is_current = true
            where l.person_id = p_person_id
              and l.ended_at is null
              and rl.recruiter_id = r.recruiter_id
         )
       )
       order by r.recruiter_id
    loop
      if v_rec_row.display_name is distinct from v_updated.full_name then
        v_reason_id := coalesce(v_reason_id, public.direct_entry_reason(p_app_user_id, v_reason));
        update public.recruiters
           set display_name = v_updated.full_name
         where recruiter_id = v_rec_row.recruiter_id;

        perform public.direct_entry_bump_personnel_version(
          v_rec_row.recruiter_id,
          p_app_user_id,
          v_reason_id,
          public.direct_entry_personnel_snapshot(v_rec_row),
          pg_catalog.jsonb_set(
            public.direct_entry_personnel_snapshot(v_rec_row),
            '{display_name}',
            pg_catalog.to_jsonb(v_updated.full_name),
            true
          )
        );
      end if;
    end loop;
  end if;

  v_after := public.org_department__internal_person_detail_projection(v_updated, v_now);

  insert into public.organization_department_audit_events (
    target_person_id,
    actor_user_id,
    action,
    reason,
    before_snapshot,
    after_snapshot,
    idempotency_key,
    created_at
  )
  values (
    p_person_id,
    p_app_user_id,
    v_action,
    v_reason,
    v_before,
    v_after,
    p_idempotency_key,
    v_now
  );

  v_result := pg_catalog.jsonb_build_object(
    'replayed', false,
    'person', v_after
  );

  insert into public.organization_department_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    target_ref,
    request_fingerprint,
    result_payload,
    created_at
  )
  values (
    p_app_user_id,
    p_idempotency_key,
    v_action,
    'person:' || p_person_id::text,
    p_request_fingerprint,
    v_result,
    v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.org_department_update_person_admin(
  uuid, uuid, uuid, integer, text, text, date, text, text, uuid, text
) from public, anon, authenticated, service_role;

grant execute on function public.org_department_update_person_admin(
  uuid, uuid, uuid, integer, text, text, date, text, text, uuid, text
) to service_role;

-- =============================================================================
-- 5. Drop Retired Sync Helper Function
-- =============================================================================

drop function public.org_department__internal_sync_leave_profile_from_org(
  uuid, uuid, timestamptz, boolean
) restrict;

-- =============================================================================
-- 6. Owner Alignment & Fail-Closed Postcondition Checks
-- =============================================================================

do $wp10_7_2a_postcheck$
declare
  v_service_rpcs text[] := array[
    'public.leave_management_upsert_employee_profile_admin(uuid, uuid, uuid, text, text, date, date, date, integer, integer, text, text, text)',
    'public.org_department_link_account_person_admin(uuid, uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)',
    'public.org_department_unlink_account_person_admin(uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)',
    'public.org_department_create_person_admin(uuid, uuid, text, text, date, uuid, uuid, integer, uuid, text, uuid, text)',
    'public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.org_department_assign_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)',
    'public.org_department_transfer_person_member_admin(uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text)',
    'public.org_department_end_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)',
    'public.org_department_update_person_admin(uuid, uuid, uuid, integer, text, text, date, text, text, uuid, text)'
  ];
  v_internal_fns text[] := array[
    'public.org_department__internal_resolve_leave_classification(uuid, timestamptz)',
    'public.org_department__internal_resolve_person_leave_classification(uuid, timestamptz)',
    'public.org_department__internal_bump_leave_profile_version_on_org_change(uuid, uuid, text, uuid, timestamptz)',
    'public.org_department__internal_guard_leave_profile()'
  ];
  v_stable_internal_fns text[] := array[
    'public.org_department__internal_resolve_leave_classification(uuid, timestamptz)',
    'public.org_department__internal_resolve_person_leave_classification(uuid, timestamptz)'
  ];
  v_rpc_names text[] := array[
    'leave_management_upsert_employee_profile_admin',
    'org_department_link_account_person_admin',
    'org_department_unlink_account_person_admin',
    'org_department_create_person_admin',
    'org_department_assign_accounting_member',
    'org_department_end_accounting_member',
    'org_department_assign_person_member_admin',
    'org_department_transfer_person_member_admin',
    'org_department_end_person_member_admin',
    'org_department_update_person_admin'
  ];
  v_sig text;
  v_name text;
  v_oid oid;
  v_proc_owner oid;
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean := false;
  v_rec record;
  v_overload_count integer := 0;
  v_dropped_count integer := 0;
  v_trg record;
  v_bad_sync_count integer := 0;
  v_bad_sync_list text;
  v_bad_col_count integer := 0;
  v_bad_col_list text;
begin
  -- 6a. Base owner discovery for alignment
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner is null or v_base_owner_oid is null then
    raise exception 'WP10-7-2A postcheck failed: base owner missing' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  -- 6b. Transitional column public.leave_employee_profiles.unit_kind MUST remain intact for Slice 2B
  if not exists (
    select 1
      from pg_catalog.pg_attribute a
     where a.attrelid = 'public.leave_employee_profiles'::pg_catalog.regclass
       and a.attname = 'unit_kind'
       and a.attnum > 0
       and not a.attisdropped
  ) then
    raise exception 'WP10-7-2A postcheck failed: public.leave_employee_profiles.unit_kind column missing'
      using errcode = '55000';
  end if;

  -- 6c. Retired sync function MUST be completely dropped
  if pg_catalog.to_regprocedure(
    'public.org_department__internal_sync_leave_profile_from_org(uuid, uuid, timestamptz, boolean)'
  ) is not null then
    raise exception 'WP10-7-2A postcheck failed: org_department__internal_sync_leave_profile_from_org still exists'
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_dropped_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'org_department__internal_sync_leave_profile_from_org';

  if v_dropped_count <> 0 then
    raise exception 'WP10-7-2A postcheck failed: expected 0 overloads of org_department__internal_sync_leave_profile_from_org, found %',
      v_dropped_count
      using errcode = '55000';
  end if;

  -- 6d. Trigger leave_employee_profiles_org_guard_trg exists, is enabled, and targets guard function
  select t.tgenabled, t.tgfoid
    into v_trg
    from pg_catalog.pg_trigger t
   where t.tgrelid = 'public.leave_employee_profiles'::pg_catalog.regclass
     and t.tgname = 'leave_employee_profiles_org_guard_trg'
     and not t.tgisinternal;

  if not found then
    raise exception 'WP10-7-2A postcheck failed: leave_employee_profiles_org_guard_trg missing'
      using errcode = '55000';
  end if;

  if v_trg.tgenabled not in ('O', 'A')
     or v_trg.tgfoid <> 'public.org_department__internal_guard_leave_profile()'::pg_catalog.regprocedure then
    raise exception 'WP10-7-2A postcheck failed: leave_employee_profiles_org_guard_trg disabled or bound to unexpected function'
      using errcode = '55000';
  end if;

  -- 6e. ZERO non-system functions reference org_leave_profile_sync or org_department__internal_sync_leave_profile_from_org
  select count(*)::integer,
         pg_catalog.string_agg(
           n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
           ', '
           order by n.nspname, p.proname
         )
    into v_bad_sync_count, v_bad_sync_list
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname <> 'pg_catalog'
     and n.nspname <> 'information_schema'
     and n.nspname not like 'pg\_%' escape '\'
     and n.nspname not in (
       'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public',
       'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions',
       'supabase_migrations', 'net', 'pgtle', 'cron', 'pgbouncer'
     )
     and p.prokind in ('f', 'p')
     and p.prosrc ~* '(org_leave_profile_sync|org_department__internal_sync_leave_profile_from_org)';

  if v_bad_sync_count > 0 then
    raise exception 'WP10-7-2A postcheck failed: % function(s) still reference org_leave_profile_sync/sync_leave_profile_from_org: %',
      v_bad_sync_count, coalesce(v_bad_sync_list, '<unknown>')
      using errcode = '55000';
  end if;

  -- 6f. ZERO non-system functions (aside from trigger guard checking NEW/OLD.unit_kind)
  --     read or write leave_employee_profiles.unit_kind
  select count(*)::integer,
         pg_catalog.string_agg(
           n.nspname || '.' || p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
           ', '
           order by n.nspname, p.proname
         )
    into v_bad_col_count, v_bad_col_list
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname <> 'pg_catalog'
     and n.nspname <> 'information_schema'
     and n.nspname not like 'pg\_%' escape '\'
     and n.nspname not in (
       'auth', 'storage', 'realtime', 'extensions', 'graphql', 'graphql_public',
       'vault', 'pgsodium', 'pgsodium_masks', 'supabase_functions',
       'supabase_migrations', 'net', 'pgtle', 'cron', 'pgbouncer'
     )
     and p.prokind in ('f', 'p')
     and p.oid <> 'public.org_department__internal_guard_leave_profile()'::pg_catalog.regprocedure
     and (
       p.prosrc ~* '\bleave_employee_profiles\s*\.\s*unit_kind\b'
       or (
         p.prosrc ~* '\bleave_employee_profiles\b'
         and (
           p.prosrc ~* '\bv_(profile|existing_profile|prof|lp)\s*\.\s*unit_kind\b'
           or p.prosrc ~* '\b(lp|lep)\s*\.\s*unit_kind\b'
           or p.prosrc ~* '\bunit_kind\s*=[^>]'
           or p.prosrc ~* 'insert\s+into\s+public\.leave_employee_profiles\s*\([^)]*\bunit_kind\b'
         )
       )
     );

  if v_bad_col_count > 0 then
    raise exception 'WP10-7-2A postcheck failed: % function(s) still read/write leave_employee_profiles.unit_kind: %',
      v_bad_col_count, coalesce(v_bad_col_list, '<unknown>')
      using errcode = '55000';
  end if;

  -- 6g. Single overload check for all 10 updated RPCs
  foreach v_name in array v_rpc_names loop
    select count(*)::integer
      into v_overload_count
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = v_name;
    if v_overload_count <> 1 then
      raise exception 'WP10-7-2A postcheck failed: expected single overload for %, found %',
        v_name, v_overload_count
        using errcode = '55000';
    end if;
  end loop;

  -- 6h. Service RPCs: owner alignment + SECURITY DEFINER + search_path + ACL
  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-7-2A postcheck failed: missing service RPC %', v_sig
        using errcode = '55000';
    end if;

    select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;

    select p.prosecdef, p.proconfig, p.proowner
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'WP10-7-2A postcheck failed: service RPC % missing SECURITY DEFINER or search_path',
        v_sig using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege(v_rec.proowner, v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'WP10-7-2A postcheck failed: invalid ACL on service RPC %', v_sig
        using errcode = '55000';
    end if;
  end loop;

  -- 6i. Internal helpers + trigger guard: owner alignment + SECURITY DEFINER + search_path + REVOKE ALL ACL
  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-7-2A postcheck failed: missing internal function %', v_sig
        using errcode = '55000';
    end if;

    select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;

    select p.prosecdef, p.proconfig, p.provolatile, p.proowner
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'WP10-7-2A postcheck failed: internal function % missing SECURITY DEFINER or search_path',
        v_sig using errcode = '55000';
    end if;

    if (v_sig = any(v_stable_internal_fns)) and v_rec.provolatile <> 's' then
      raise exception 'WP10-7-2A postcheck failed: classification resolver % must be STABLE',
        v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege(v_rec.proowner, v_oid, 'EXECUTE') then
      raise exception 'WP10-7-2A postcheck failed: invalid ACL on internal function %', v_sig
        using errcode = '55000';
    end if;
  end loop;
end
$wp10_7_2a_postcheck$;

commit;
