-- =============================================================================
-- Cross-Department Recruitment Guards (Tuyển dụng liên phòng ban)
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. Add internal helper org_department__internal_person_is_active_in_org(uuid, timestamptz)
--      while preserving org_department__internal_person_is_active_in_recruitment intact.
--   2. Update org_department__internal_recruiter_org_allows_recruitment_team(uuid, uuid, timestamptz)
--      to allow any active primary Org department while preserving multi-person,
--      Source C unlinked fail-closed, and pure legacy semantics.
--   3. Update 7 Org/account writers (preserving all WP10-2 locks, Tier 2b actor
--      FOR SHARE, post-lock completeness guards, OCC, idempotency, and audits):
--      - org_department_link_account_person_admin
--      - org_department_create_person_admin
--      - direct_entry_account_operation_link_recruiter
--      - direct_entry_account_operation_create_personnel
--      - org_department_assign_person_member_admin
--      - org_department_assign_accounting_member
--      - org_department_transfer_person_member_admin
--      (Explicitly keeps unlink, end_person_member, and update_person_admin('INACTIVE')
--       blocking with PT409 PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT.)
--   4. Update leave_management__internal_resolve_routing_snapshot(uuid, date) so the
--      is_requester_team_leader -> ADMIN_BOD_DIRECT short-circuit applies ONLY when
--      (department_id is null or department_system_key in ('RECRUITMENT', 'MANAGEMENT_BOD'))
--      and unit_kind not in ('MARKETING', 'IT', 'ACCOUNTING'), preserving PENDING snapshots.
--   5. Owner alignment, SECURITY DEFINER, SET search_path = pg_catalog, public,
--      and strict REVOKE/GRANT verification.
-- =============================================================================

begin;

-- =============================================================================
-- 1. Internal Cross-Domain Helpers
-- =============================================================================

create or replace function public.org_department__internal_person_is_active_in_org(
  p_person_id uuid,
  p_as_of timestamptz default pg_catalog.clock_timestamp()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
begin
  if p_person_id is null then
    return false;
  end if;

  return exists (
    select 1
      from public.organization_persons p
      join public.organization_person_department_memberships m
        on m.person_id = p.person_id
       and m.ended_at is null
       and m.started_at <= v_as_of
      join public.organization_departments d
        on d.department_id = m.department_id
     where p.person_id = p_person_id
       and p.status = 'ACTIVE'
       and d.is_active = true
  );
end;
$function$;

revoke all on function public.org_department__internal_person_is_active_in_org(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_recruiter_org_allows_recruitment_team(
  p_recruiter_id uuid,
  p_app_user_id uuid default null,
  p_as_of timestamptz default pg_catalog.clock_timestamp()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_cand_user_ids uuid[];
  v_active_person_ids uuid[];
begin
  if p_recruiter_id is null then
    return false;
  end if;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_cand_user_ids
    from (
      select p_app_user_id as uid
      union
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.recruiter_id = p_recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  -- Source A (organization_persons.recruiter_id) UNION Source B (open account-person links)
  select coalesce(array_agg(distinct pid order by pid), array[]::uuid[])
    into v_active_person_ids
    from (
      select p.person_id as pid
        from public.organization_persons p
       where p.recruiter_id = p_recruiter_id
      union
      select l.person_id as pid
        from public.organization_account_person_links l
       where l.app_user_id = any(v_cand_user_ids)
         and l.ended_at is null
    ) s
   where pid is not null;

  if cardinality(v_active_person_ids) > 1 then
    return false;
  end if;

  if cardinality(v_active_person_ids) = 1 then
    return public.org_department__internal_person_is_active_in_org(
      v_active_person_ids[1],
      v_as_of
    );
  end if;

  -- Source C (fail-closed if linked account previously had an Org Person link that was unlinked)
  if cardinality(v_cand_user_ids) > 0 and exists (
    select 1
      from public.organization_account_person_links l_hist
     where l_hist.app_user_id = any(v_cand_user_ids)
       and l_hist.ended_at is not null
  ) then
    return false;
  end if;

  -- Pure legacy unmapped recruiter
  return true;
end;
$function$;

revoke all on function public.org_department__internal_recruiter_org_allows_recruitment_team(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- =============================================================================
-- 2. Writer Group #1: org_department_link_account_person_admin
-- =============================================================================

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
  perform public.org_department__internal_sync_leave_profile_from_org(
    p_target_app_user_id,
    p_app_user_id,
    v_now,
    false
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

-- =============================================================================
-- 3. Writer Group #2: org_department_create_person_admin
-- =============================================================================

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

    perform public.org_department__internal_sync_leave_profile_from_org(
      p_account_ref,
      p_app_user_id,
      v_now,
      false
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

-- =============================================================================
-- 4. Writer Group #3: direct_entry_account_operation_link_recruiter
-- =============================================================================

create or replace function public.direct_entry_account_operation_link_recruiter(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_recruiter_id uuid,
  p_expected_recruiter_version integer,
  p_account_ref uuid,
  p_expected_account_version integer,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'account_recruiter_link_create';
  v_today date := public.direct_entry_authorization_date();
  v_lock_key text;
  v_account public.direct_entry_app_users%rowtype;
  v_recruiter public.recruiters%rowtype;
  v_acct_person_id uuid := null;
  v_rec_person_id uuid := null;
  v_target_person_id uuid := null;
  v_current_acct_person_id uuid := null;
  v_current_rec_person_id uuid := null;
  v_lock_person_id uuid;
  v_lock_id uuid;
  v_locked_person_ids uuid[];
  v_locked_dept_ids uuid[];
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_locked_team_ids uuid[];
  v_acct_person public.organization_persons%rowtype;
  v_rec_person public.organization_persons%rowtype;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_login_id text;
  v_code text;
  v_payload_hash text;
  v_prior_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_link_id uuid;
  v_capability text;
  v_prev_caps text[];
  v_had_own_scope boolean;
  v_app_user_revision_id uuid;
  v_now timestamptz;
  v_result jsonb;
  v_auto_reason text;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if p_recruiter_id is null
     or p_expected_recruiter_version is null
     or p_expected_recruiter_version < 1 then
    raise exception 'personnel reference or version invalid' using errcode = '22023';
  end if;
  if p_account_ref is null
     or p_expected_account_version is null
     or p_expected_account_version < 1 then
    raise exception 'account reference or version invalid' using errcode = '22023';
  end if;
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'recruiter_id', p_recruiter_id,
    'expected_recruiter_version', p_expected_recruiter_version,
    'account_ref', p_account_ref,
    'expected_account_version', p_expected_account_version,
    'reason', p_reason
  ));
  -- Pre-lock unlocked replay check only: avoid FK FOR KEY SHARE on U_actor before Tier 1/2
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = v_action
     and i.idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  select l.person_id
    into v_acct_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_account_ref
     and l.ended_at is null
   limit 1;

  select p.person_id
    into v_rec_person_id
    from public.organization_persons p
   where p.recruiter_id = p_recruiter_id
   limit 1;

  select coalesce(array_agg(distinct pid order by pid), array[]::uuid[])
    into v_locked_person_ids
    from unnest(array[v_acct_person_id, v_rec_person_id]) as t(pid)
   where pid is not null;

  -- Tier 1 (P -> D -> M)
  foreach v_lock_person_id in array v_locked_person_ids loop
    perform public.org_department__internal_lock_person(v_lock_person_id);
  end loop;

  if cardinality(v_locked_person_ids) > 0 then
    for v_lock_person_id in
      select p.person_id
        from public.organization_persons p
       where p.person_id = any(v_locked_person_ids)
       order by p.person_id asc
       for update
    loop
      if v_lock_person_id = v_acct_person_id then
        select p.* into v_acct_person from public.organization_persons p where p.person_id = v_acct_person_id;
      end if;
      if v_lock_person_id = v_rec_person_id then
        select p.* into v_rec_person from public.organization_persons p where p.person_id = v_rec_person_id;
      end if;
    end loop;

    select coalesce(array_agg(distinct m.department_id order by m.department_id), array[]::uuid[])
      into v_locked_dept_ids
      from public.organization_person_department_memberships m
     where m.person_id = any(v_locked_person_ids)
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
       where m.person_id = any(v_locked_person_ids)
         and m.ended_at is null
       order by m.membership_id asc
       for update;
    end if;
  else
    v_locked_dept_ids := array[]::uuid[];
  end if;

  -- Tier 2 (U)
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select p_account_ref as uid
      union
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.recruiter_id = p_recruiter_id
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
      select p_actor_app_user_id as uid
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

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  -- Tier 3 (R_full)
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select p_recruiter_id as rid
      union
      select v_acct_person.recruiter_id as rid
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

  perform r.recruiter_id
    from public.recruiters r
   where r.recruiter_id = any(v_locked_recruiter_ids)
   order by r.recruiter_id asc
   for update;

  select r.* into v_recruiter
    from public.recruiters r
   where r.recruiter_id = p_recruiter_id;
  if not found then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;

  -- Tier 4 (T): discover & lock related teams before Tier 5
  select coalesce(array_agg(distinct tid order by tid), array[]::uuid[])
    into v_locked_team_ids
    from (
      select m.team_id as tid
        from public.recruiter_team_memberships m
       where m.recruiter_id = any(v_locked_recruiter_ids)
         and (m.is_current = true or m.valid_to is null or m.valid_to >= v_today)
      union
      select a.team_id as tid
        from public.direct_entry_team_leader_assignments a
       where (a.leader_recruiter_id = any(v_locked_recruiter_ids) or a.leader_app_user_id = any(v_locked_user_ids))
         and (a.is_current = true or a.suspended_by_account_disable = true or a.valid_to is null or a.valid_to >= v_today)
    ) s
   where tid is not null;

  if cardinality(v_locked_team_ids) > 0 then
    perform t.team_id
      from public.teams t
     where t.team_id = any(v_locked_team_ids)
     order by t.team_id asc
     for update;
  end if;

  -- Post-lock completeness guard (never lock backwards)
  select l.person_id
    into v_current_acct_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_account_ref
     and l.ended_at is null
   limit 1;

  select p.person_id
    into v_current_rec_person_id
    from public.organization_persons p
   where p.recruiter_id = p_recruiter_id
   limit 1;

  if v_current_acct_person_id is distinct from v_acct_person_id
     or v_current_rec_person_id is distinct from v_rec_person_id then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

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
     where rl.recruiter_id = p_recruiter_id
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where (a.leader_app_user_id = any(v_locked_user_ids) or a.leader_recruiter_id = any(v_locked_recruiter_ids))
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and (
         not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
         or not (a.team_id = any(v_locked_team_ids))
       )
  ) or exists (
    select 1
      from public.recruiter_team_memberships m
     where m.recruiter_id = any(v_locked_recruiter_ids)
       and (m.is_current = true or m.valid_to is null or m.valid_to >= v_today)
       and not (m.team_id = any(v_locked_team_ids))
  ) then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

  -- Tier 5 Canonical Child Locks: RPM -> RTM -> URL -> SG -> TLA -> CG
  perform m.membership_id
    from public.recruiter_provider_memberships m
   where m.recruiter_id = any(v_locked_recruiter_ids)
   order by m.membership_id asc
   for update;

  for v_lock_key in
    select 'provider:' || rid::text as k
      from unnest(v_locked_recruiter_ids) as rid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform m.membership_id
    from public.recruiter_team_memberships m
   where m.recruiter_id = any(v_locked_recruiter_ids)
   order by m.membership_id asc
   for update;

  for v_lock_key in
    select 'team-membership:' || rid::text as k
      from unnest(v_locked_recruiter_ids) as rid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_locked_user_ids)
      or l.recruiter_id = any(v_locked_recruiter_ids)
   order by l.link_id asc
   for update;

  for v_lock_key in
    select distinct 'recruiter-link:' || uid::text as k
      from unnest(v_locked_user_ids) as uid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  for v_lock_key in
    select distinct 'recruiter-link-recruiter:' || rid::text as k
      from unnest(v_locked_recruiter_ids) as rid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_account_ref
     and (s.scope_kind in ('own', 'all') or s.team_id = any(v_locked_team_ids))
   order by s.grant_id asc
   for update;

  for v_lock_key in
    select distinct k
      from (
        select 'scope:' || p_account_ref::text || ':all:' || p_account_ref::text as k
        union
        select 'scope:' || p_account_ref::text || ':own:' || p_account_ref::text as k
        union
        select 'scope:' || s.app_user_id::text || ':' || s.scope_kind || ':' || coalesce(s.team_id::text, s.app_user_id::text) as k
          from public.direct_entry_scope_grants s
         where s.app_user_id = p_account_ref
            or s.team_id = any(v_locked_team_ids)
      ) keys
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform a.assignment_id
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = any(v_locked_user_ids)
      or a.leader_recruiter_id = any(v_locked_recruiter_ids)
      or a.team_id = any(v_locked_team_ids)
   order by a.assignment_id asc
   for update;

  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_account_ref
   order by g.grant_id asc
   for update;

  for v_lock_key in
    select distinct 'capability:' || p_account_ref::text || ':' || caps.capability as k
      from (
        select g.capability
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_account_ref
        union
        select gc.capability
          from public.authz_user_group_members m
          join public.authz_user_groups g on g.group_id = m.group_id and g.active = true
          join public.authz_user_group_capabilities gc on gc.group_id = g.group_id and gc.ended_at is null
         where m.app_user_id = p_account_ref
           and m.ended_at is null
        union
        select unnest(array[
          'entry_create', 'entry_own', 'submission_create', 'change_request_create',
          'employment_status.request', 'document_upload', 'document_view'
        ]::text[]) as capability
      ) caps
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  if not exists (
    select 1
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter.recruiter_id
       and m.provider_type = 'hrp'
       and m.vendor_id is null
       and (m.is_current or (not v_recruiter.active and m.valid_to is null
         and (select count(*) from public.recruiter_provider_memberships x
               where x.recruiter_id = v_recruiter.recruiter_id and x.valid_to is null) = 1))
  ) then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;

  if v_acct_person.person_id is not null and v_rec_person.person_id is not null
     and v_acct_person.person_id <> v_rec_person.person_id then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;
  if v_acct_person.person_id is not null and v_acct_person.recruiter_id is not null
     and v_acct_person.recruiter_id <> p_recruiter_id then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;
  if v_acct_person.person_id is null and v_rec_person.person_id is not null
     and exists (
       select 1
         from public.organization_account_person_links l
        where l.person_id = v_rec_person.person_id
          and l.ended_at is null
          and l.app_user_id <> p_account_ref
     ) then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;
  if v_recruiter.version <> p_expected_recruiter_version then
    raise exception 'personnel version conflict' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_target_person_id := coalesce(v_acct_person.person_id, v_rec_person.person_id);

  -- Cross-domain guard evaluated AFTER locks & completeness check and BEFORE `if not v_account.enabled`
  if v_target_person_id is not null
     and public.org_department__internal_subject_has_blocking_team_assignment(
       v_locked_recruiter_ids,
       v_locked_user_ids,
       v_today
     )
     and not public.org_department__internal_person_is_active_in_org(v_target_person_id, v_now) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT' using errcode = 'PT409';
  end if;

  if not v_account.enabled then
    raise exception 'account is not enabled' using errcode = '23514';
  end if;
  if not v_recruiter.active then
    raise exception 'personnel is not active' using errcode = '23514';
  end if;

  select count(*)::int,
         count(*) filter (where m.provider_type = 'hrp' and m.vendor_id is null)::int
    into v_provider_count, v_hrp_provider_count
    from public.recruiter_provider_memberships m
   where m.recruiter_id = p_recruiter_id
     and m.is_current;
  if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
    raise exception 'personnel requires an active HRP provider membership' using errcode = '23514';
  end if;

  if v_recruiter.personnel_position is not null
     and v_recruiter.personnel_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '23514';
  end if;

  v_code := lower(nullif(btrim(coalesce(v_recruiter.personnel_code, '')), ''));
  if v_code is null or not public.direct_entry_is_canonical_login_id(v_code) then
    raise exception 'personnel code is missing or not canonical for account linking' using errcode = '22023';
  end if;

  select lower(nullif(btrim(split_part(au.email, pg_catalog.chr(64), 1)), ''))
    into v_login_id
    from auth.users au
   where au.id = v_account.auth_subject;
  if v_login_id is null
     or not public.direct_entry_is_canonical_login_id(v_login_id)
     or v_login_id <> v_code then
    raise exception 'personnel code does not match account login ID' using errcode = '22023';
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_account_ref
       and l.verified
       and (l.is_current or l.valid_to is null or l.valid_to > v_today)
  ) then
    raise exception 'account already has an effective recruiter link' using errcode = '23P01';
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_recruiter_id
       and l.verified
       and (l.is_current or l.valid_to is null or l.valid_to > v_today)
  ) then
    raise exception 'personnel already has an effective account link' using errcode = '23P01';
  end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  insert into public.direct_entry_app_user_recruiter_links (
    app_user_id, recruiter_id, verified, valid_from, is_current
  ) values (
    p_account_ref, p_recruiter_id, true, v_today, true
  ) returning link_id into v_link_id;

  select coalesce(array_agg(distinct g.capability), array[]::text[])
    into v_prev_caps
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_account_ref
     and g.is_current;

  select exists (
    select 1
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref
       and g.scope_kind = 'own'
       and g.is_current
  ) into v_had_own_scope;

  v_auto_reason := left(coalesce(p_reason, 'Auto-granted upon recruiter account link'), 500);
  if pg_catalog.length(pg_catalog.btrim(v_auto_reason)) < 3 then
    v_auto_reason := 'Auto-granted upon recruiter account link';
  end if;

  insert into public.authz_user_group_members (
    group_id, app_user_id, source_kind, reason, started_at, assigned_by_app_user_id, is_protected, protected_reason
  )
  select
    g.group_id, p_account_ref, 'ADMIN_ASSIGNMENT', v_auto_reason, v_now, p_actor_app_user_id, false, null
    from public.authz_user_groups g
   where g.code = 'RECRUITER_OPERATIONS'
     and g.active = true
  on conflict (group_id, app_user_id) where ended_at is null do nothing;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = v_now,
         authz_managed = true
   where app_user_id = p_account_ref
  returning version, authz_managed into v_account.version, v_account.authz_managed;

  -- Legacy mirrors derived from active permission groups
  perform public.direct_entry_authz__internal_sync_legacy_grants(p_account_ref);

  if not v_had_own_scope
     and exists (
       select 1
         from public.direct_entry_scope_grants g
        where g.app_user_id = p_account_ref
          and g.scope_kind = 'own'
          and g.is_current
     ) then
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_actor_app_user_id, 'scope_default_grant', 'entry_own',
      p_account_ref::text, 'own', 'APPLIED', v_reason_id, array['scope_kind', 'valid_from', 'valid_to']
    );
  end if;

  foreach v_capability in array array[
    'entry_create', 'entry_own', 'submission_create', 'change_request_create',
    'employment_status.request', 'document_upload', 'document_view'
  ]::text[]
  loop
    if not (v_capability = any(v_prev_caps))
       and exists (
         select 1
           from public.direct_entry_capability_grants g
          where g.app_user_id = p_account_ref
            and g.capability = v_capability
            and g.is_current
       ) then
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
      ) values (
        p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
        p_account_ref::text, 'APPLIED', v_reason_id, array['valid_from', 'valid_to']
      );
    end if;
  end loop;

  if v_acct_person.person_id is not null and v_acct_person.recruiter_id is null then
    update public.organization_persons
       set recruiter_id = p_recruiter_id,
           version = v_acct_person.version + 1,
           updated_at = v_now,
           updated_by_app_user_id = p_actor_app_user_id
     where person_id = v_acct_person.person_id;
  end if;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_account_ref,
    v_account.version,
    p_actor_app_user_id,
    'link_create',
    jsonb_build_object('recruiter_id', null),
    jsonb_build_object('recruiter_id', v_recruiter.recruiter_id),
    v_reason_id
  ) returning revision_id into v_app_user_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, 'link_create', 'entry_admin', p_account_ref::text,
    'all', 'APPLIED', v_reason_id, array['recruiter_link'], v_app_user_revision_id
  );

  v_result := jsonb_build_object(
    'link_id', v_link_id,
    'app_user_id', p_account_ref,
    'app_user_version', v_account.version,
    'app_user_revision_id', v_app_user_revision_id,
    'recruiter_id', v_recruiter.recruiter_id,
    'recruiter_version', v_recruiter.version,
    'personnel_code', v_recruiter.personnel_code,
    'valid_from', v_today
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

-- =============================================================================
-- 5. Writer Group #4: direct_entry_account_operation_create_personnel
-- =============================================================================

create or replace function public.direct_entry_account_operation_create_personnel(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_account_ref uuid,
  p_expected_account_version integer,
  p_personnel_code text,
  p_personnel_position text,
  p_valid_from date,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'personnel_created';
  v_code text := lower(btrim(p_personnel_code));
  v_login_id text;
  v_position text := p_personnel_position;
  v_account public.direct_entry_app_users;
  v_linked_person_id uuid := null;
  v_current_linked_person_id uuid := null;
  v_linked_dept_id uuid := null;
  v_current_linked_dept_id uuid := null;
  v_related_recruiter_ids uuid[];
  v_tla_team_ids uuid[];
  v_lock_id uuid;
  v_all_user_ids uuid[];
  v_lock_key text;
  v_person public.organization_persons;
  v_payload_hash text;
  v_prior_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_recruiter public.recruiters;
  v_membership_id uuid;
  v_link_id uuid;
  v_personnel_revision_id uuid;
  v_app_user_revision_id uuid;
  v_result jsonb;
  v_capability text;
  v_today date := public.direct_entry_authorization_date();
  v_valid_from date;
  v_now timestamptz;
  v_prev_caps text[];
  v_had_own_scope boolean;
  v_auto_reason text;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_account_ref is null or p_expected_account_version is null or p_expected_account_version < 1 then
    raise exception 'account reference or version invalid' using errcode = '22023';
  end if;
  if v_code is null or not public.direct_entry_is_canonical_login_id(v_code) then
    raise exception 'personnel code must be the account login ID' using errcode = '22023';
  end if;
  if v_position is null or v_position not in ('STAFF', 'TEAM_LEADER') then
    raise exception 'personnel position is invalid' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'account_ref', p_account_ref, 'expected_account_version', p_expected_account_version,
    'personnel_code', v_code, 'personnel_position', v_position,
    'valid_from', p_valid_from, 'reason', p_reason
  ));
  -- Pre-lock unlocked replay check only: avoid FK FOR KEY SHARE on U_actor before Tier 1/2
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = v_action
     and i.idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  -- Phase 1: Unlocked Candidate Discovery
  select l.person_id
    into v_linked_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_account_ref
     and l.ended_at is null
   limit 1;

  -- Phase 2: Canonical Tier 1 (P -> D -> M)
  if v_linked_person_id is not null then
    perform public.org_department__internal_lock_person(v_linked_person_id);
    select p.*
      into v_person
      from public.organization_persons p
     where p.person_id = v_linked_person_id
     for update;

    select m.department_id
      into v_linked_dept_id
      from public.organization_person_department_memberships m
     where m.person_id = v_linked_person_id
       and m.ended_at is null
     limit 1;

    if v_linked_dept_id is not null then
      perform public.org_department__internal_lock_department(v_linked_dept_id);
      perform d.department_id
        from public.organization_departments d
       where d.department_id = v_linked_dept_id
       for update;

      perform m.membership_id
        from public.organization_person_department_memberships m
       where m.person_id = v_linked_person_id
         and m.ended_at is null
       order by m.membership_id asc
       for update;
    end if;
  end if;

  -- Phase 2: Canonical Tier 2 (U)
  perform public.org_department__internal_lock_app_user(p_account_ref);

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_actor_app_user_id as uid
      union all
      select p_account_ref as uid
    ) s
   where uid is not null;

  foreach v_lock_id in array v_all_user_ids loop
    if v_lock_id = p_account_ref then
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

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_valid_from := coalesce(p_valid_from, v_today);
  if v_valid_from <> v_today then
    raise exception 'provider valid from is invalid' using errcode = '22023';
  end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref;
  if not found then raise exception 'account not found' using errcode = 'P0002'; end if;

  -- Discover R_full & T before Tier 3/4 locks
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_related_recruiter_ids
    from (
      select v_person.recruiter_id as rid
      union
      select rl.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = p_account_ref
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_account_ref
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) rids
   where rid is not null;

  select coalesce(array_agg(distinct tid order by tid), array[]::uuid[])
    into v_tla_team_ids
    from (
      select a.team_id as tid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_account_ref
          or a.leader_recruiter_id = any(v_related_recruiter_ids)
      union
      select m.team_id as tid
        from public.recruiter_team_memberships m
       where m.recruiter_id = any(v_related_recruiter_ids)
      union
      select s.team_id as tid
        from public.direct_entry_scope_grants s
       where s.app_user_id = p_account_ref
         and s.team_id is not null
    ) tids
   where tid is not null;

  -- Phase 2: Tier 3 (R_full ascending UUID)
  if cardinality(v_related_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_related_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  -- Phase 2: Tier 4 (T ascending UUID)
  if cardinality(v_tla_team_ids) > 0 then
    perform t.team_id
      from public.teams t
     where t.team_id = any(v_tla_team_ids)
     order by t.team_id asc
     for update;
  end if;

  -- Phase 2: Tier 5 Canonical Child Locks (RPM -> RTM -> URL -> SG -> TLA -> CG)
  if cardinality(v_related_recruiter_ids) > 0 then
    perform m.membership_id
      from public.recruiter_provider_memberships m
     where m.recruiter_id = any(v_related_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'provider:' || rid::text as k
        from unnest(v_related_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    perform m.membership_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = any(v_related_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'team-membership:' || rid::text as k
        from unnest(v_related_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;
  end if;

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_account_ref
      or (cardinality(v_related_recruiter_ids) > 0 and l.recruiter_id = any(v_related_recruiter_ids))
   order by l.link_id asc
   for update;

  perform pg_advisory_xact_lock(hashtextextended('recruiter-link:' || p_account_ref::text, 0));
  for v_lock_key in
    select 'recruiter-link-recruiter:' || rid::text as k
      from unnest(coalesce(v_related_recruiter_ids, array[]::uuid[])) as rid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_account_ref
      or (cardinality(v_tla_team_ids) > 0 and s.team_id = any(v_tla_team_ids))
   order by s.grant_id asc
   for update;

  for v_lock_key in
    select distinct k
      from (
        select 'scope:' || p_account_ref::text || ':all:' || p_account_ref::text as k
        union
        select 'scope:' || p_account_ref::text || ':own:' || p_account_ref::text as k
        union
        select 'scope:' || s.app_user_id::text || ':' || s.scope_kind || ':' || coalesce(s.team_id::text, s.app_user_id::text) as k
          from public.direct_entry_scope_grants s
         where s.app_user_id = p_account_ref
            or (cardinality(v_tla_team_ids) > 0 and s.team_id = any(v_tla_team_ids))
      ) keys
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform a.assignment_id
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = p_account_ref
      or (cardinality(v_related_recruiter_ids) > 0 and a.leader_recruiter_id = any(v_related_recruiter_ids))
      or (cardinality(v_tla_team_ids) > 0 and a.team_id = any(v_tla_team_ids))
   order by a.assignment_id asc
   for update;

  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_account_ref
   order by g.grant_id asc
   for update;

  for v_lock_key in
    select distinct 'capability:' || p_account_ref::text || ':' || caps.capability as k
      from (
        select g.capability
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_account_ref
        union
        select gc.capability
          from public.authz_user_group_members m
          join public.authz_user_groups g on g.group_id = m.group_id and g.active = true
          join public.authz_user_group_capabilities gc on gc.group_id = g.group_id and gc.ended_at is null
         where m.app_user_id = p_account_ref
           and m.ended_at is null
        union
        select unnest(array[
          'entry_create', 'entry_own', 'submission_create', 'change_request_create',
          'employment_status.request', 'document_upload', 'document_view'
        ]::text[]) as capability
      ) caps
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  -- Phase 3: Post-Lock Completeness Guard (abort on external mutation during lock wait; zero backward locks)
  select l.person_id
    into v_current_linked_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_account_ref
     and l.ended_at is null
   limit 1;

  if v_current_linked_person_id is distinct from v_linked_person_id then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;

  if v_linked_person_id is not null then
    select m.department_id
      into v_current_linked_dept_id
      from public.organization_person_department_memberships m
     where m.person_id = v_linked_person_id
       and m.ended_at is null
     limit 1;

    if v_current_linked_dept_id is distinct from v_linked_dept_id then
      raise exception 'app user version conflict' using errcode = 'PT409';
    end if;
  end if;

  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = p_account_ref
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.recruiter_id = any(v_related_recruiter_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_app_user_id = p_account_ref
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and (
         not (a.leader_recruiter_id = any(v_related_recruiter_ids))
         or not (a.team_id = any(v_tla_team_ids))
       )
  ) then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;

  -- OCC & Identity Conflict Checks
  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;
  if v_person.person_id is not null and v_person.recruiter_id is not null then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();

  -- Phase 3 Cross-Domain Invariant Guard BEFORE `if not v_account.enabled` (covers G3 on disabled accounts & direct leader_app_user_id)
  if v_person.person_id is not null
     and public.org_department__internal_subject_has_blocking_team_assignment(
       case when v_person.recruiter_id is not null then array[v_person.recruiter_id] else array[]::uuid[] end,
       array[p_account_ref],
       v_today
     )
     and not public.org_department__internal_person_is_active_in_org(v_person.person_id, v_now) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT' using errcode = 'PT409';
  end if;

  if not v_account.enabled then raise exception 'account is not enabled' using errcode = '23514'; end if;

  select lower(nullif(split_part(u.email, pg_catalog.chr(64), 1), '')) into v_login_id
    from auth.users u where u.id = v_account.auth_subject;
  if v_login_id is null or not public.direct_entry_is_canonical_login_id(v_login_id)
     or v_code <> v_login_id then
    raise exception 'personnel code does not match account login ID' using errcode = '22023';
  end if;
  if lower(btrim(v_account.display_name)) = v_login_id then
    raise exception 'account real name must be updated before personnel creation' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_account_ref and l.verified
       and l.is_current
  ) then raise exception 'account already has an effective recruiter link' using errcode = '23514'; end if;
  if exists (
    select 1 from public.recruiters r
     where r.personnel_code is not null
       and lower(public.recruitment_dimension_key(r.personnel_code))
           = lower(public.recruitment_dimension_key(v_code))
  ) then raise exception 'personnel code already exists' using errcode = '23505'; end if;

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);
  insert into public.recruiters (display_name, personnel_code, personnel_position, active, version)
  values (v_account.display_name, v_code, v_position, true, 1)
  returning * into v_recruiter;
  insert into public.recruiter_provider_memberships (recruiter_id, provider_type, valid_from, vendor_id, is_current)
  values (v_recruiter.recruiter_id, 'hrp', v_valid_from, null, true)
  returning membership_id into v_membership_id;
  insert into public.direct_entry_app_user_recruiter_links (app_user_id, recruiter_id, verified, valid_from, is_current)
  values (p_account_ref, v_recruiter.recruiter_id, true, v_valid_from, true)
  returning link_id into v_link_id;

  select coalesce(array_agg(distinct g.capability), array[]::text[])
    into v_prev_caps
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_account_ref
     and g.is_current;

  select exists (
    select 1 from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref and g.scope_kind = 'own'
       and g.is_current
  ) into v_had_own_scope;

  v_auto_reason := left(coalesce(p_reason, 'Auto-granted upon personnel creation'), 500);
  if pg_catalog.length(pg_catalog.btrim(v_auto_reason)) < 3 then
    v_auto_reason := 'Auto-granted upon personnel creation';
  end if;

  insert into public.authz_user_group_members (
    group_id, app_user_id, source_kind, reason, started_at, assigned_by_app_user_id, is_protected, protected_reason
  )
  select
    g.group_id, p_account_ref, 'ADMIN_ASSIGNMENT', v_auto_reason, v_now, p_actor_app_user_id, false, null
    from public.authz_user_groups g
   where g.code = 'RECRUITER_OPERATIONS'
     and g.active = true
  on conflict (group_id, app_user_id) where ended_at is null do nothing;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = v_now,
         authz_managed = true
   where app_user_id = p_account_ref
  returning version, authz_managed into v_account.version, v_account.authz_managed;

  perform public.direct_entry_authz__internal_sync_legacy_grants(p_account_ref);

  foreach v_capability in array array[
    'entry_create', 'entry_own', 'submission_create', 'change_request_create',
    'employment_status.request', 'document_upload', 'document_view'
  ]::text[]
  loop
    if not (v_capability = any(v_prev_caps))
       and exists (
         select 1 from public.direct_entry_capability_grants g
          where g.app_user_id = p_account_ref
            and g.capability = v_capability
            and g.is_current
       ) then
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
      ) values (
        p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
        p_account_ref::text, 'APPLIED', v_reason_id, array['valid_from', 'valid_to']
      );
    end if;
  end loop;

  if not v_had_own_scope
     and exists (
       select 1 from public.direct_entry_scope_grants g
        where g.app_user_id = p_account_ref
          and g.scope_kind = 'own'
          and g.is_current
     ) then
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_actor_app_user_id, 'scope_default_grant', 'entry_own',
      p_account_ref::text, 'own', 'APPLIED', v_reason_id, array['scope_kind', 'valid_from', 'valid_to']
    );
  end if;

  if v_person.person_id is not null and v_person.recruiter_id is null then
    update public.organization_persons
       set recruiter_id = v_recruiter.recruiter_id,
           version = v_person.version + 1,
           updated_at = v_now,
           updated_by_app_user_id = p_actor_app_user_id
     where person_id = v_person.person_id;
  end if;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    p_account_ref, v_account.version, p_actor_app_user_id, 'link_create',
    jsonb_build_object('recruiter_id', null), jsonb_build_object('recruiter_id', v_recruiter.recruiter_id), v_reason_id
  ) returning revision_id into v_app_user_revision_id;
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, 'link_create', 'entry_admin', p_account_ref::text,
    'all', 'APPLIED', v_reason_id, array['recruiter_link'], v_app_user_revision_id
  );
  v_personnel_revision_id := public.direct_entry_write_personnel_revision(
    v_recruiter.recruiter_id, v_recruiter.version, p_actor_app_user_id, v_reason_id,
    null, public.direct_entry_personnel_snapshot(v_recruiter)
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, personnel_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin', v_recruiter.recruiter_id::text,
    'all', 'APPLIED', v_reason_id, array['display_name', 'personnel_code', 'personnel_position', 'active'],
    v_personnel_revision_id
  );
  v_result := jsonb_build_object(
    'recruiter_id', v_recruiter.recruiter_id, 'display_name', v_recruiter.display_name,
    'personnel_code', v_recruiter.personnel_code, 'personnel_position', v_recruiter.personnel_position,
    'version', v_recruiter.version, 'link_id', v_link_id, 'membership_id', v_membership_id,
    'app_user_version', v_account.version, 'app_user_revision_id', v_app_user_revision_id,
    'personnel_revision_id', v_personnel_revision_id
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

-- =============================================================================
-- 6. Writer Group #5: org_department_assign_person_member_admin
-- =============================================================================

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
    perform public.org_department__internal_sync_leave_profile_from_org(v_linked_app_user_id, p_app_user_id, v_now);
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

-- =============================================================================
-- 7. Writer Group #6: org_department_assign_accounting_member
-- =============================================================================

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

  perform public.org_department__internal_sync_leave_profile_from_org(
    p_target_app_user_id,
    p_app_user_id,
    v_now,
    false
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

-- =============================================================================
-- 8. Writer Group #7: org_department_transfer_person_member_admin
-- =============================================================================

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

    perform public.org_department__internal_sync_leave_profile_from_org(
      v_acc_row.app_user_id,
      p_app_user_id,
      v_now,
      false
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

-- =============================================================================
-- 9. Leave & Attendance Routing Snapshot (Cross-Dept Team Leader Routing)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.leave_management__internal_resolve_routing_snapshot(p_app_user_id uuid, p_as_of date DEFAULT leave_management__internal_business_date())
 RETURNS TABLE(routing jsonb, routed_department_id uuid, routed_department_code text, routed_department_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_snap record;
  v_dept_approver_id uuid := null;
  v_routing jsonb;
begin
  with now_ctx as materialized (
    select pg_catalog.clock_timestamp() as v_now
  ),
  user_ctx as (
    select (p.app_user_id is not null) as has_profile,
           (
             p.app_user_id is not null
             and p.employment_status in ('PROBATION', 'OFFICIAL')
             and p.work_start_date is not null
             and (
               p.employment_status <> 'OFFICIAL'
               or p.official_effective_date is not null
             )
           ) as profile_configured,
           p.unit_kind as profile_unit_kind
      from (select 1 as anchor) a
      left join public.direct_entry_app_users u
        on u.app_user_id = p_app_user_id
      left join public.leave_employee_profiles p
        on p.app_user_id = p_app_user_id
  ),
  active_link as (
    select l.person_id,
           op.status as person_status
      from now_ctx nc
      join public.direct_entry_app_users u
        on u.app_user_id = p_app_user_id
      join public.organization_account_person_links l
        on l.app_user_id = u.app_user_id
       and l.started_at <= nc.v_now
       and (l.ended_at is null or (l.ended_at > l.started_at and nc.v_now < l.ended_at))
      join public.organization_persons op
        on op.person_id = l.person_id
     order by l.started_at desc, l.link_id desc
     limit 1
  ),
  active_person_dept as (
    select d.department_id,
           d.code as department_code,
           d.name as department_name,
           d.system_key as department_system_key
      from now_ctx nc
      join active_link al
        on al.person_status = 'ACTIVE'
      join public.organization_person_department_memberships m
        on m.person_id = al.person_id
       and m.started_at <= nc.v_now
       and (m.ended_at is null or (m.ended_at > m.started_at and nc.v_now < m.ended_at))
      join public.organization_departments d
        on d.department_id = m.department_id
       and d.is_active = true
     order by m.started_at desc, m.membership_id desc
     limit 1
  ),
  legacy_fallback_dept as (
    select d.department_id,
           d.code as department_code,
           d.name as department_name,
           d.system_key as department_system_key
      from user_ctx uc
      left join active_link al on true
      join public.organization_departments d
        on d.system_key = uc.profile_unit_kind
       and d.is_active = true
     where al.person_id is null
       and uc.has_profile = true
       and uc.profile_unit_kind in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD')
     order by d.department_id asc
     limit 1
  ),
  resolved_org as (
    select (al.person_id is not null) as has_active_person_link,
           case
             when al.person_id is not null then apd.department_id
             else lfd.department_id
           end as department_id,
           case
             when al.person_id is not null then apd.department_code
             else lfd.department_code
           end as department_code,
           case
             when al.person_id is not null then apd.department_name
             else lfd.department_name
           end as department_name,
           case
             when al.person_id is not null then apd.department_system_key
             else lfd.department_system_key
           end as department_system_key,
           case
             when al.person_id is not null then coalesce(apd.department_system_key, 'UNCLASSIFIED')
             when uc.has_profile then uc.profile_unit_kind
             else 'UNCLASSIFIED'
           end as unit_kind
      from user_ctx uc
      left join active_link al on true
      left join active_person_dept apd on true
      left join legacy_fallback_dept lfd on true
  ),
  dept_head_state as (
    select exists (
             select 1
               from now_ctx nc
               join public.organization_department_heads dh
                 on dh.department_id = ro.department_id
               join public.organization_departments d
                 on d.department_id = dh.department_id
                and d.is_active = true
              where ro.department_id is not null
                and dh.started_at <= nc.v_now
                and (dh.ended_at is null or (dh.ended_at > dh.started_at and nc.v_now < dh.ended_at))
           ) as has_open_org_head,
           (
             select u.app_user_id
               from now_ctx nc
               join public.organization_department_heads dh
                 on dh.department_id = ro.department_id
               join public.organization_departments d
                 on d.department_id = dh.department_id
                and d.is_active = true
               join public.organization_persons op
                 on op.person_id = dh.person_id
                and op.status = 'ACTIVE'
               join public.organization_person_department_memberships m
                 on m.person_id = dh.person_id
                and m.department_id = dh.department_id
                and m.started_at <= nc.v_now
                and (m.ended_at is null or (m.ended_at > m.started_at and nc.v_now < m.ended_at))
               join public.organization_account_person_links l
                 on l.person_id = dh.person_id
                and l.started_at <= nc.v_now
                and (l.ended_at is null or (l.ended_at > l.started_at and nc.v_now < l.ended_at))
               join public.direct_entry_app_users u
                 on u.app_user_id = l.app_user_id
                and u.enabled = true
              where ro.department_id is not null
                and dh.started_at <= nc.v_now
                and (dh.ended_at is null or (dh.ended_at > dh.started_at and nc.v_now < dh.ended_at))
              order by dh.started_at desc, dh.head_assignment_id desc
              limit 1
           ) as org_head_app_user_id,
           (
             select da.approver_app_user_id
               from public.leave_department_approvers da
               join public.direct_entry_app_users u
                 on u.app_user_id = da.approver_app_user_id
                and u.enabled = true
              where ro.unit_kind in ('MARKETING', 'IT', 'ACCOUNTING')
                and da.unit_kind = ro.unit_kind
                and da.valid_from <= p_as_of
                and (da.valid_to is null or p_as_of < da.valid_to)
                and (da.valid_to is null or da.valid_to > da.valid_from)
              order by da.valid_from desc, da.row_version desc
              limit 1
           ) as compat_dept_approver_id
      from resolved_org ro
  ),
  requester_roles as (
    select exists (
             select 1
               from public.direct_entry_team_leader_assignments tla
              where tla.leader_app_user_id = p_app_user_id
                and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, p_as_of)
           ) as is_requester_team_leader,
           exists (
             select 1
               from now_ctx nc
               join public.organization_department_heads dh
                 on dh.started_at <= nc.v_now
                and (dh.ended_at is null or (dh.ended_at > dh.started_at and nc.v_now < dh.ended_at))
               join public.organization_departments d
                 on d.department_id = dh.department_id
                and d.is_active = true
               join public.organization_persons op
                 on op.person_id = dh.person_id
                and op.status = 'ACTIVE'
               join public.organization_person_department_memberships m
                 on m.person_id = dh.person_id
                and m.department_id = dh.department_id
                and m.started_at <= nc.v_now
                and (m.ended_at is null or (m.ended_at > m.started_at and nc.v_now < m.ended_at))
               join public.organization_account_person_links l
                 on l.person_id = dh.person_id
                and l.app_user_id = p_app_user_id
                and l.started_at <= nc.v_now
                and (l.ended_at is null or (l.ended_at > l.started_at and nc.v_now < l.ended_at))
               join public.direct_entry_app_users u
                 on u.app_user_id = l.app_user_id
                and u.enabled = true
           ) as is_requester_dept_head,
           exists (
             select 1
               from now_ctx nc
               join public.leave_department_approvers da
                 on da.approver_app_user_id = p_app_user_id
                and da.valid_from <= p_as_of
                and (da.valid_to is null or p_as_of < da.valid_to)
                and (da.valid_to is null or da.valid_to > da.valid_from)
              where not exists (
                select 1
                  from public.organization_departments d
                  join public.organization_department_heads dh
                    on dh.department_id = d.department_id
                   and dh.started_at <= nc.v_now
                   and (dh.ended_at is null or (dh.ended_at > dh.started_at and nc.v_now < dh.ended_at))
                 where d.system_key = da.unit_kind
                   and d.is_active = true
              )
           ) as is_requester_compat_dept_approver
  ),
  recruiter_ctx as (
    select l.recruiter_id
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r on r.recruiter_id = l.recruiter_id
     where l.app_user_id = p_app_user_id
       and l.verified = true
       and l.is_current = true
       and not coalesce(l.suspended_by_account_disable, false)
       and r.active = true
       and coalesce(r.personnel_code, '') <> '__system_vendor__'
     order by l.valid_from desc, l.link_id desc
     limit 1
  ),
  team_ctx as (
    select count(*)::integer as team_count,
           (pg_catalog.array_agg(t.team_id order by t.code))[1] as team_id,
           (pg_catalog.array_agg(t.code order by t.code))[1] as team_code,
           (pg_catalog.array_agg(t.display_name order by t.code))[1] as team_name
      from recruiter_ctx rc
      join public.recruiter_team_memberships rtm
        on rtm.recruiter_id = rc.recruiter_id
      join public.teams t
        on t.team_id = rtm.team_id
     where t.active = true
       and t.code <> '__system_vendor__'
       and public.direct_entry__internal_recruiter_team_membership_effective(rtm.membership_id, p_as_of)
  ),
  leader_ctx as (
    select count(distinct tla.leader_app_user_id)::integer as leader_count,
           (pg_catalog.array_agg(tla.leader_app_user_id order by tla.valid_from desc, tla.assignment_id desc))[1] as leader_app_user_id
      from team_ctx tc
      join public.direct_entry_team_leader_assignments tla
        on tla.team_id = tc.team_id
      join public.direct_entry_app_users lu
        on lu.app_user_id = tla.leader_app_user_id
     where tc.team_count = 1
       and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, p_as_of)
  )
  select uc.has_profile,
         uc.profile_configured,
         ro.department_id,
         ro.department_code,
         ro.department_name,
         ro.department_system_key,
         ro.unit_kind,
         dhs.has_open_org_head,
         dhs.org_head_app_user_id,
         dhs.compat_dept_approver_id,
         rr.is_requester_team_leader,
         rr.is_requester_dept_head,
         rr.is_requester_compat_dept_approver,
         rc.recruiter_id,
         coalesce(tc.team_count, 0) as team_count,
         tc.team_id,
         tc.team_code,
         tc.team_name,
         coalesce(lc.leader_count, 0) as leader_count,
         lc.leader_app_user_id
    into v_snap
    from user_ctx uc
    cross join resolved_org ro
    cross join dept_head_state dhs
    cross join requester_roles rr
    left join recruiter_ctx rc on true
    left join team_ctx tc on true
    left join leader_ctx lc on true;

  if (
       v_snap.is_requester_team_leader
       and (
         v_snap.department_id is null
         or coalesce(v_snap.department_system_key, '') in ('RECRUITMENT', 'MANAGEMENT_BOD')
       )
       and v_snap.unit_kind not in ('MARKETING', 'IT', 'ACCOUNTING')
     )
     or v_snap.is_requester_dept_head
     or v_snap.is_requester_compat_dept_approver
     or v_snap.unit_kind = 'MANAGEMENT_BOD' then
    v_routing := pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_DIRECT',
      'unit_kind', case when v_snap.unit_kind = 'UNCLASSIFIED' and v_snap.is_requester_team_leader then 'RECRUITMENT' else v_snap.unit_kind end,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', null,
      'profile_configured', v_snap.profile_configured
    );
    return query select v_routing, null::uuid, null::text, null::text;
    return;
  end if;

  -- Non-Recruitment, non-BoD departments (MARKETING, IT, ACCOUNTING, AND dynamic custom departments)
  if (
    v_snap.department_id is not null
    and coalesce(v_snap.department_system_key, '') not in ('RECRUITMENT', 'MANAGEMENT_BOD')
  ) or v_snap.unit_kind in ('MARKETING', 'IT', 'ACCOUNTING') then
    if v_snap.has_open_org_head then
      v_dept_approver_id := v_snap.org_head_app_user_id;
    elsif v_snap.unit_kind in ('MARKETING', 'IT', 'ACCOUNTING') then
      v_dept_approver_id := v_snap.compat_dept_approver_id;
    else
      v_dept_approver_id := null;
    end if;

    if v_dept_approver_id is not null and v_dept_approver_id <> p_app_user_id then
      v_routing := pg_catalog.jsonb_build_object(
        'route_kind', 'DEPARTMENT_HEAD',
        'unit_kind', v_snap.unit_kind,
        'primary_approver_app_user_id', v_dept_approver_id,
        'team_id', null,
        'team_code', null,
        'team_name', null,
        'fallback_reason', null,
        'profile_configured', v_snap.profile_configured
      );
      return query select v_routing, v_snap.department_id, v_snap.department_code, v_snap.department_name;
      return;
    end if;

    v_routing := pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_FALLBACK',
      'unit_kind', v_snap.unit_kind,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', 'DEPARTMENT_APPROVER_NOT_CONFIGURED',
      'profile_configured', v_snap.profile_configured
    );
    return query select v_routing, null::uuid, null::text, null::text;
    return;
  end if;

  if v_snap.recruiter_id is not null then
    if v_snap.team_count = 1 then
      if v_snap.leader_count = 1
         and v_snap.leader_app_user_id is not null
         and v_snap.leader_app_user_id <> p_app_user_id then
        v_routing := pg_catalog.jsonb_build_object(
          'route_kind', 'TEAM_LEADER',
          'unit_kind', case when v_snap.unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_snap.unit_kind end,
          'primary_approver_app_user_id', v_snap.leader_app_user_id,
          'team_id', v_snap.team_id,
          'team_code', v_snap.team_code,
          'team_name', v_snap.team_name,
          'fallback_reason', null,
          'profile_configured', v_snap.profile_configured
        );
        return query select v_routing, null::uuid, null::text, null::text;
        return;
      end if;

      v_routing := pg_catalog.jsonb_build_object(
        'route_kind', 'ADMIN_BOD_FALLBACK',
        'unit_kind', case when v_snap.unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_snap.unit_kind end,
        'primary_approver_app_user_id', null,
        'team_id', v_snap.team_id,
        'team_code', v_snap.team_code,
        'team_name', v_snap.team_name,
        'fallback_reason', case when v_snap.leader_count = 0 then 'TEAM_WITHOUT_ACTIVE_LEADER' else 'TEAM_MULTIPLE_LEADERS_OR_SELF' end,
        'profile_configured', v_snap.profile_configured
      );
      return query select v_routing, null::uuid, null::text, null::text;
      return;
    end if;

    v_routing := pg_catalog.jsonb_build_object(
      'route_kind', 'ADMIN_BOD_FALLBACK',
      'unit_kind', case when v_snap.unit_kind = 'UNCLASSIFIED' then 'RECRUITMENT' else v_snap.unit_kind end,
      'primary_approver_app_user_id', null,
      'team_id', null,
      'team_code', null,
      'team_name', null,
      'fallback_reason', case when v_snap.team_count = 0 then 'RECRUITER_WITHOUT_ACTIVE_TEAM' else 'RECRUITER_MULTI_ACTIVE_TEAMS' end,
      'profile_configured', v_snap.profile_configured
    );
    return query select v_routing, null::uuid, null::text, null::text;
    return;
  end if;

  v_routing := pg_catalog.jsonb_build_object(
    'route_kind', 'ADMIN_BOD_FALLBACK',
    'unit_kind', v_snap.unit_kind,
    'primary_approver_app_user_id', null,
    'team_id', null,
    'team_code', null,
    'team_name', null,
    'fallback_reason', case when not v_snap.has_profile or not v_snap.profile_configured then 'PROFILE_UNCONFIGURED_OR_UNMAPPED' else 'UNMAPPED_UNIT_OR_RECRUITER' end,
    'profile_configured', v_snap.profile_configured
  );
  return query select v_routing, null::uuid, null::text, null::text;
end;
$function$;

revoke all on function public.leave_management__internal_resolve_routing_snapshot(uuid, date)
  from public, anon, authenticated, service_role;



-- =============================================================================
-- 10. Owner Alignment & Strict Security/ACL Verification
-- =============================================================================

do $align_and_check_cross_dept_recruitment$
declare
  v_service_rpcs text[] := array[
    'public.org_department_link_account_person_admin(uuid, uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)',
    'public.org_department_create_person_admin(uuid, uuid, text, text, date, uuid, uuid, integer, uuid, text, uuid, text)',
    'public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)',
    'public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)',
    'public.org_department_assign_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)',
    'public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.org_department_transfer_person_member_admin(uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text)'
  ];
  v_internal_fns text[] := array[
    'public.org_department__internal_person_is_active_in_org(uuid, timestamptz)',
    'public.org_department__internal_person_is_active_in_recruitment(uuid, timestamptz)',
    'public.org_department__internal_recruiter_org_allows_recruitment_team(uuid, uuid, timestamptz)',
    'public.leave_management__internal_resolve_routing_snapshot(uuid, date)'
  ];
  v_sig text;
  v_oid oid;
  v_proc_owner oid;
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean := false;
  v_rec record;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner is null or v_base_owner_oid is null then
    raise exception 'Cross-dept recruitment alignment failed: base owner missing' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Cross-dept recruitment check failed: missing service RPC %', v_sig using errcode = '55000';
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
      raise exception 'Cross-dept recruitment check failed: definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'Cross-dept recruitment check failed: RPC ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Cross-dept recruitment check failed: missing internal fn %', v_sig using errcode = '55000';
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
      raise exception 'Cross-dept recruitment check failed: internal definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'Cross-dept recruitment check failed: internal ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;
end
$align_and_check_cross_dept_recruitment$;

commit;
