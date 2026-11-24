-- =============================================================================
-- WP10-2: Immediate-Effective Organizational Assignment Contract & Cross-Domain
-- Guards (Rev 6 + T0 Review Directives)
--
-- Scope (100% forward migration; no historical migration edits):
--   1. Four internal helpers (zero EXECUTE grants to public/anon/authenticated/service_role):
--      - org_department__internal_person_is_active_in_recruitment(uuid, timestamptz)
--      - org_department__internal_subject_has_blocking_team_assignment(uuid[], uuid[], date)
--      - org_department__internal_person_has_blocking_team_assignment(uuid, date)
--      - org_department__internal_recruiter_org_allows_recruitment_team(uuid, uuid, timestamptz)
--   2. Universal 3-phase global lock protocol across all 14 cross-domain RPCs:
--      Tier 1 (P -> D -> M) -> Tier 2 (U) -> Tier 3 (R_full ascending UUID) -> Tier 4 (T)
--      -> Tier 5 (Child: RPM -> RTM -> URL -> SG -> TLA -> CG)
--      plus post-lock completeness guards (abort PT409/40001 on lock-set drift, never lock backwards)
--      and post-lock G1/G2/G3 + §2.3 evaluation.
--   3. Custom departments (system_key IS NULL) guarded via `IS DISTINCT FROM 'RECRUITMENT'`
--      in create_person_admin, assign_person_member_admin, and transfer_person_member_admin.
--   4. Same-day `v_restore` in direct_entry_apply_team_leader_mutation('revoke') ALWAYS closes
--      v_old cleanly and only restores v_previous (+ grants) when Org §2.3 passes under full locks.
-- =============================================================================

begin;

-- =============================================================================
-- 1. Internal Cross-Domain Helpers (All Revoked from Every Role)
-- =============================================================================

create or replace function public.org_department__internal_person_is_active_in_recruitment(
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
       and d.system_key = 'RECRUITMENT'
       and d.is_active = true
  );
end;
$function$;

revoke all on function public.org_department__internal_person_is_active_in_recruitment(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_subject_has_blocking_team_assignment(
  p_recruiter_ids uuid[],
  p_app_user_ids uuid[],
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := coalesce(p_as_of, public.direct_entry_authorization_date());
  v_r_seed uuid[];
  v_u_seed uuid[];
  v_r_all uuid[];
  v_u_all uuid[];
begin
  select coalesce(array_agg(distinct x order by x), array[]::uuid[])
    into v_r_seed
    from unnest(coalesce(p_recruiter_ids, array[]::uuid[])) as t(x)
   where x is not null;

  select coalesce(array_agg(distinct x order by x), array[]::uuid[])
    into v_u_seed
    from unnest(coalesce(p_app_user_ids, array[]::uuid[])) as t(x)
   where x is not null;

  select coalesce(array_agg(distinct x order by x), array[]::uuid[])
    into v_r_all
    from (
      select unnest(v_r_seed) as x
      union
      select rl.recruiter_id as x
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = any(v_u_seed)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as x
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = any(v_u_seed)
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) r_exp
   where x is not null;

  select coalesce(array_agg(distinct x order by x), array[]::uuid[])
    into v_u_all
    from (
      select unnest(v_u_seed) as x
      union
      select rl.app_user_id as x
        from public.direct_entry_app_user_recruiter_links rl
       where rl.recruiter_id = any(v_r_all)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
    ) u_exp
   where x is not null;

  select coalesce(array_agg(distinct x order by x), array[]::uuid[])
    into v_r_all
    from (
      select unnest(v_r_all) as x
      union
      select rl.recruiter_id as x
        from public.direct_entry_app_user_recruiter_links rl
       where rl.app_user_id = any(v_u_all)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_recruiter_id as x
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = any(v_u_all)
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) r_final
   where x is not null;

  -- G1: Effective team membership via canonical helper
  if cardinality(v_r_all) > 0 and exists (
    select 1
      from public.recruiter_team_memberships m
     where m.recruiter_id = any(v_r_all)
       and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
  ) then
    return true;
  end if;

  -- G2: Effective team leader assignment via canonical helper (covers direct leader_app_user_id)
  if (cardinality(v_r_all) > 0 or cardinality(v_u_all) > 0) and exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where (a.leader_recruiter_id = any(v_r_all) or a.leader_app_user_id = any(v_u_all))
       and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today)
  ) then
    return true;
  end if;

  -- G3: Suspended restorable team leader assignment on disabled account
  if (cardinality(v_r_all) > 0 or cardinality(v_u_all) > 0) and exists (
    select 1
      from public.direct_entry_team_leader_assignments a
      join public.teams t
        on t.team_id = a.team_id
      join public.recruiters r
        on r.recruiter_id = a.leader_recruiter_id
     where (a.leader_recruiter_id = any(v_r_all) or a.leader_app_user_id = any(v_u_all))
       and a.suspended_by_account_disable = true
       and a.is_current = false
       and a.valid_from <= v_today
       and a.valid_to is null
       and t.active = true
       and t.code <> '__system_vendor__'
       and r.active = true
  ) then
    return true;
  end if;

  return false;
end;
$function$;

revoke all on function public.org_department__internal_subject_has_blocking_team_assignment(uuid[], uuid[], date)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_person_has_blocking_team_assignment(
  p_person_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_recruiter_id uuid;
  v_linked_user_ids uuid[];
begin
  if p_person_id is null then
    return false;
  end if;

  select p.recruiter_id
    into v_recruiter_id
    from public.organization_persons p
   where p.person_id = p_person_id;

  select coalesce(array_agg(distinct l.app_user_id order by l.app_user_id), array[]::uuid[])
    into v_linked_user_ids
    from public.organization_account_person_links l
   where l.person_id = p_person_id
     and l.ended_at is null;

  return public.org_department__internal_subject_has_blocking_team_assignment(
    case when v_recruiter_id is not null then array[v_recruiter_id] else array[]::uuid[] end,
    v_linked_user_ids,
    coalesce(p_as_of, public.direct_entry_authorization_date())
  );
end;
$function$;

revoke all on function public.org_department__internal_person_has_blocking_team_assignment(uuid, date)
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
    return public.org_department__internal_person_is_active_in_recruitment(
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
     and not public.org_department__internal_person_is_active_in_recruitment(p_person_id, v_now) then
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
-- 3. Writer Group #2: org_department_create_person_admin (with IS DISTINCT FROM)
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

  -- Cross-domain guard: IS DISTINCT FROM 'RECRUITMENT' covers custom departments (system_key IS NULL)
  if (v_resolved_recruiter_id is not null or p_account_ref is not null)
     and public.org_department__internal_subject_has_blocking_team_assignment(
       v_locked_recruiter_ids,
       v_locked_user_ids,
       v_today
     )
     and (
       p_initial_department_id is null
       or v_dept.system_key is distinct from 'RECRUITMENT'
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
     and not public.org_department__internal_person_is_active_in_recruitment(v_target_person_id, v_now) then
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
--    Exact Rev 6 §3.2.2 child lock order: RPM -> RTM -> URL -> SG -> TLA -> CG
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
     and not public.org_department__internal_person_is_active_in_recruitment(v_person.person_id, v_now) then
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
-- 6. Writer Group #5: org_department_unlink_account_person_admin
-- =============================================================================

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
volatile
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
  perform public.org_department__internal_sync_leave_profile_from_org(
    p_target_app_user_id,
    p_app_user_id,
    v_now,
    true
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

-- =============================================================================
-- 7. Writer Group #6: org_department_assign_person_member_admin (IS DISTINCT FROM)
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

  -- Cross-domain guard: IS DISTINCT FROM 'RECRUITMENT' covers custom departments (system_key IS NULL)
  if v_dept.system_key is distinct from 'RECRUITMENT'
     and public.org_department__internal_person_has_blocking_team_assignment(p_person_id, v_today) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT' using errcode = 'PT409';
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
-- 8. Writer Group #7: org_department_assign_accounting_member
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

  -- Cross-domain guard: target department is always ACCOUNTING (<> RECRUITMENT)
  if public.org_department__internal_subject_has_blocking_team_assignment(
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
-- 9. Writer Group #8: org_department_transfer_person_member_admin (IS DISTINCT FROM)
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

  -- Cross-domain guard: IS DISTINCT FROM 'RECRUITMENT' covers custom departments (system_key IS NULL)
  if v_to_dept.system_key is distinct from 'RECRUITMENT'
     and public.org_department__internal_person_has_blocking_team_assignment(p_person_id, v_today) then
    raise exception 'PERSON_HAS_ACTIVE_TEAM_ASSIGNMENT' using errcode = 'PT409';
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
-- 10. Writer Group #9: org_department_end_person_member_admin
-- =============================================================================

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
volatile
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
    perform public.org_department__internal_sync_leave_profile_from_org(v_linked_app_user_id, p_app_user_id, v_now, true);
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

-- =============================================================================
-- 11. Writer Group #10: org_department_update_person_admin
-- =============================================================================

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
volatile
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

    perform public.org_department__internal_sync_leave_profile_from_org(
      v_acc_row.app_user_id,
      p_app_user_id,
      v_now,
      false
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

-- =============================================================================
-- 12. Writer Group #11: direct_entry_assign_team_membership &
--                       direct_entry_move_team_membership
-- =============================================================================

create or replace function public.direct_entry_assign_team_membership(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid,
  p_team_id uuid,
  p_valid_from date,
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
  v_authority text;
  v_reason_id uuid;
  v_subject public.recruiters;
  v_membership public.recruiter_team_memberships;
  v_recruiter_version integer;
  v_revision_id uuid;
  v_changed text[];
  v_payload_hash text;
  v_prior_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_person_ids uuid[];
  v_locked_dept_ids uuid[];
  v_lock_id uuid;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null or p_team_id is null then
    raise exception 'recruiter and target team required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'recruiter_id', p_recruiter_id,
    'team_id', p_team_id,
    'valid_from', p_valid_from,
    'expected_version', p_expected_version
  ));
  -- Pre-lock unlocked replay check only: avoid FK FOR KEY SHARE on U_actor before Tier 1/2
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_app_user_id
     and i.action = 'team_membership_assign'
     and i.idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  -- Phase 1: Unlocked discovery of Org Persons & Users linked to p_recruiter_id
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.recruiter_id = p_recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_app_user_id as uid
        from public.direct_entry_team_leader_assignments a
       where a.leader_recruiter_id = p_recruiter_id
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  select coalesce(array_agg(distinct pid order by pid), array[]::uuid[])
    into v_locked_person_ids
    from (
      select p.person_id as pid
        from public.organization_persons p
       where p.recruiter_id = p_recruiter_id
      union
      select l.person_id as pid
        from public.organization_account_person_links l
       where l.app_user_id = any(v_locked_user_ids)
         and l.ended_at is null
    ) s
   where pid is not null;

  -- Phase 2: Canonical Lock Order P -> D -> M -> U -> R -> T
  foreach v_lock_id in array v_locked_person_ids loop
    perform public.org_department__internal_lock_person(v_lock_id);
  end loop;

  if cardinality(v_locked_person_ids) > 0 then
    perform p.person_id
      from public.organization_persons p
     where p.person_id = any(v_locked_person_ids)
     order by p.person_id asc
     for update;

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
  end if;

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

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_membership_assign', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  p_valid_from := coalesce(p_valid_from, public.direct_entry_authorization_date());
  if p_valid_from > public.direct_entry_authorization_date() then
    raise exception 'future team memberships require explicit activation' using errcode = '22023';
  end if;
  if p_valid_from < public.direct_entry_authorization_date() then
    raise exception 'past team memberships are not allowed' using errcode = '22023';
  end if;

  -- Tier 3 (R) & Tier 4 (T)
  v_subject := public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
  perform t.team_id from public.teams t where t.team_id = p_team_id for share;
  perform public.direct_entry_assert_membership_target_team(p_team_id);

  -- Phase 3: Post-lock completeness guard (never acquire higher-tier locks after U/R!)
  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.recruiter_id = p_recruiter_id
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_recruiter_id = p_recruiter_id
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and not (a.leader_app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.organization_persons p
     where p.recruiter_id = p_recruiter_id
       and not (p.person_id = any(v_locked_person_ids))
  ) or exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = any(v_locked_user_ids)
       and l.ended_at is null
       and not (l.person_id = any(v_locked_person_ids))
  ) then
    raise exception 'recruiter version conflict' using errcode = 'PT409';
  end if;

  -- Cross-domain §2.3 guard under full locks
  if not public.org_department__internal_recruiter_org_allows_recruitment_team(
    p_recruiter_id,
    null,
    pg_catalog.clock_timestamp()
  ) then
    raise exception 'recruiter organization assignment does not allow recruitment team membership'
      using errcode = '23514';
  end if;

  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_from, p_team_id) then
    raise exception 'membership change would rewrite worker attribution' using errcode = '23514';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, is_current)
  values (p_recruiter_id, p_team_id, p_valid_from, true)
  returning * into v_membership;

  v_changed := array['team_id', 'valid_from'];
  if p_valid_from < public.direct_entry_authorization_date() then
    v_changed := array_append(v_changed, 'backdated');
  end if;

  select b.recruiter_version, b.revision_id
    into v_recruiter_version, v_revision_id
    from public.direct_entry_bump_membership_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      null,
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, p_team_id, p_valid_from, null, v_subject.version + 1, 'ASSIGN'
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome,
     reason_id, changed_fields, team_membership_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_membership_assign', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id, v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'membership_id', v_membership.membership_id,
    'recruiter_id', p_recruiter_id,
    'team_id', p_team_id,
    'valid_from', to_jsonb(v_membership.valid_from),
    'valid_to', to_jsonb(v_membership.valid_to),
    'recruiter_version', v_recruiter_version,
    'revision_id', v_revision_id,
    'change', 'ASSIGN'
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_membership_assign', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_move_team_membership(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid,
  p_team_id uuid,
  p_valid_from date,
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
  v_authority text;
  v_reason_id uuid;
  v_subject public.recruiters;
  v_open public.recruiter_team_memberships;
  v_membership public.recruiter_team_memberships;
  v_recruiter_version integer;
  v_revision_id uuid;
  v_changed text[];
  v_payload_hash text;
  v_prior_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_locked_user_ids uuid[];
  v_all_user_ids uuid[];
  v_locked_person_ids uuid[];
  v_locked_dept_ids uuid[];
  v_lock_id uuid;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null or p_team_id is null then
    raise exception 'recruiter and target team required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'recruiter_id', p_recruiter_id,
    'team_id', p_team_id,
    'valid_from', p_valid_from,
    'expected_version', p_expected_version
  ));
  -- Pre-lock unlocked replay check only: avoid FK FOR KEY SHARE on U_actor before Tier 1/2
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_app_user_id
     and i.action = 'team_membership_move'
     and i.idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    if v_prior is not null then
      return v_prior;
    end if;
  end if;

  -- Phase 1: Unlocked discovery
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_locked_user_ids
    from (
      select rl.app_user_id as uid
        from public.direct_entry_app_user_recruiter_links rl
       where rl.recruiter_id = p_recruiter_id
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
      union
      select a.leader_app_user_id as uid
        from public.direct_entry_team_leader_assignments a
       where a.leader_recruiter_id = p_recruiter_id
         and (a.is_current = true or a.suspended_by_account_disable = true)
    ) s
   where uid is not null;

  select coalesce(array_agg(distinct pid order by pid), array[]::uuid[])
    into v_locked_person_ids
    from (
      select p.person_id as pid
        from public.organization_persons p
       where p.recruiter_id = p_recruiter_id
      union
      select l.person_id as pid
        from public.organization_account_person_links l
       where l.app_user_id = any(v_locked_user_ids)
         and l.ended_at is null
    ) s
   where pid is not null;

  -- Phase 2: Canonical Lock Order P -> D -> M -> U -> R -> T
  foreach v_lock_id in array v_locked_person_ids loop
    perform public.org_department__internal_lock_person(v_lock_id);
  end loop;

  if cardinality(v_locked_person_ids) > 0 then
    perform p.person_id
      from public.organization_persons p
     where p.person_id = any(v_locked_person_ids)
     order by p.person_id asc
     for update;

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
  end if;

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

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_membership_move', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  p_valid_from := coalesce(p_valid_from, public.direct_entry_authorization_date());
  if p_valid_from > public.direct_entry_authorization_date() then
    raise exception 'future team memberships require explicit activation' using errcode = '22023';
  end if;
  if p_valid_from < public.direct_entry_authorization_date() then
    raise exception 'past team memberships are not allowed' using errcode = '22023';
  end if;

  -- Tier 3 (R) & Tier 4 (T)
  v_subject := public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
  perform t.team_id from public.teams t where t.team_id = p_team_id for share;
  perform public.direct_entry_assert_membership_target_team(p_team_id);

  -- Phase 3: Post-lock completeness guard
  if exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.recruiter_id = p_recruiter_id
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and not (rl.app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.leader_recruiter_id = p_recruiter_id
       and (a.is_current = true or a.suspended_by_account_disable = true)
       and not (a.leader_app_user_id = any(v_locked_user_ids))
  ) or exists (
    select 1
      from public.organization_persons p
     where p.recruiter_id = p_recruiter_id
       and not (p.person_id = any(v_locked_person_ids))
  ) or exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = any(v_locked_user_ids)
       and l.ended_at is null
       and not (l.person_id = any(v_locked_person_ids))
  ) then
    raise exception 'recruiter version conflict' using errcode = 'PT409';
  end if;

  -- Cross-domain §2.3 guard under full locks
  if not public.org_department__internal_recruiter_org_allows_recruitment_team(
    p_recruiter_id,
    null,
    pg_catalog.clock_timestamp()
  ) then
    raise exception 'recruiter organization assignment does not allow recruitment team membership'
      using errcode = '23514';
  end if;

  select m.* into v_open
    from public.recruiter_team_memberships m
   where m.recruiter_id = p_recruiter_id
     and (m.valid_to is null or (
       m.valid_from <= p_valid_from and p_valid_from < m.valid_to
       and public.direct_entry_authorization_date() < m.valid_to
     ))
   order by m.valid_from desc
   limit 1;
  if not found then
    raise exception 'no open membership to move' using errcode = '22023';
  end if;
  if v_open.team_id = p_team_id then
    raise exception 'membership already targets this team' using errcode = '22023';
  end if;
  if p_valid_from < v_open.valid_from then
    raise exception 'move date precedes the open membership' using errcode = '22023';
  end if;
  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_from, p_team_id) then
    raise exception 'membership change would rewrite worker attribution' using errcode = '23514';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  if p_valid_from = v_open.valid_from then
    perform set_config('direct_entry.membership_cancel_marker', 'on', true);
  end if;

  update public.recruiter_team_memberships set is_current = false
   where recruiter_id = p_recruiter_id
     and is_current
     and membership_id <> v_open.membership_id
     and valid_to is not null
     and valid_to <= public.direct_entry_authorization_date();

  update public.recruiter_team_memberships set valid_to = p_valid_from, is_current = false
   where membership_id = v_open.membership_id;

  insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, valid_to, is_current)
  values (p_recruiter_id, p_team_id, p_valid_from, null, true)
  returning * into v_membership;

  v_changed := array['team_id', 'valid_to'];
  if p_valid_from = v_open.valid_from then
    v_changed := array_append(v_changed, 'cancellation_marker');
  end if;
  if p_valid_from < public.direct_entry_authorization_date() then
    v_changed := array_append(v_changed, 'backdated');
  end if;

  select b.recruiter_version, b.revision_id
    into v_recruiter_version, v_revision_id
    from public.direct_entry_bump_membership_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, v_open.team_id, v_open.valid_from, v_open.valid_to,
        v_subject.version, 'MOVE'
      ),
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, p_team_id, p_valid_from, null, v_subject.version + 1, 'MOVE'
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome,
     reason_id, changed_fields, team_membership_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_membership_move', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id, v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'membership_id', v_membership.membership_id,
    'recruiter_id', p_recruiter_id,
    'team_id', p_team_id,
    'valid_from', to_jsonb(v_membership.valid_from),
    'valid_to', to_jsonb(v_membership.valid_to),
    'recruiter_version', v_recruiter_version,
    'revision_id', v_revision_id,
    'change', 'MOVE'
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_membership_move', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

-- =============================================================================
-- 13. Writer Group #13: direct_entry_apply_team_leader_mutation
-- =============================================================================

create or replace function public.direct_entry_apply_team_leader_mutation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_target_leader_app_user_id uuid,
  p_effective_date date,
  p_expected_version integer,
  p_reason text,
  p_idempotency_key text,
  p_operation text,
  p_authority text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_team public.teams;
  v_old public.direct_entry_team_leader_assignments%rowtype;
  v_new public.direct_entry_team_leader_assignments%rowtype;
  v_old_count integer := 0;
  v_origin public.direct_entry_team_leader_revisions%rowtype;
  v_previous public.direct_entry_team_leader_assignments%rowtype;
  v_prev_scope_grant_id uuid;
  v_prev_scope_grant_count integer := 0;
  v_prev_capability_grant_id uuid;
  v_prev_capability_grant_count integer := 0;
  v_restore boolean := false;
  v_restore_recruiter_id uuid;
  v_candidate_user_enabled boolean;
  v_link_count integer;
  v_verified_link_count integer;
  v_recruiter_id uuid;
  v_recruiter_active boolean;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_scope_count integer;
  v_capability_count integer;
  v_scope_grant_id uuid;
  v_capability_grant_id uuid;
  v_idempotency_action text;
  v_prior_hash text;
  v_change text;
  v_prior jsonb;
  v_result jsonb;
  v_request_hash text;
  v_reason_id uuid;
  v_revision_id uuid;
  v_team_version integer;
  v_before jsonb;
  v_after jsonb;
  v_changed_fields text[] := array[
    'team_leader_assignment', 'team_scope', 'team_manager_assign'
  ];
  v_locked_person_ids uuid[];
  v_locked_dept_ids uuid[];
  v_write_user_ids uuid[];
  v_all_user_ids uuid[];
  v_cand_recruiter_ids uuid[];
  v_locked_recruiter_ids uuid[];
  v_locked_id uuid;
  v_lock_key text;
  v_post_team_assignment_count integer;
  v_post_target_team_assignment_count integer;
  v_post_target_assignment_count integer;
  v_post_scope_count integer;
  v_post_target_team_scope_count integer;
  v_post_capability_count integer;
  v_post_coextensive_scope_count integer;
  v_post_coextensive_capability_count integer;
  v_post_outgoing_assignment_count integer;
  v_post_outgoing_scope_count integer;
  v_post_outgoing_capability_count integer;
  v_post_closed_assignment_count integer;
  v_post_closed_scope_count integer;
  v_post_closed_capability_count integer;
  v_post_restored_assignment_count integer;
  v_post_restored_scope_count integer;
  v_post_restored_capability_count integer;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_operation not in ('designate', 'revoke') then
    raise exception 'invalid team leader operation' using errcode = '22023';
  end if;
  if (p_operation = 'designate') <> (p_target_leader_app_user_id is not null) then
    raise exception 'target leader does not match operation' using errcode = '22023';
  end if;
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected team version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Phase 1: Unlocked candidate discovery (covers target in designate AND v_previous same-day restore candidate in revoke)
  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_write_user_ids
    from (
      select p_target_leader_app_user_id as uid
      union
      select a.leader_app_user_id as uid
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and (
           a.is_current
           or a.suspended_by_account_disable
           or a.valid_to is null
           or a.valid_to >= v_today
           or exists (
             select 1
               from public.direct_entry_capability_grants g
              where g.app_user_id = a.leader_app_user_id
                and g.capability = 'team_manager_assign'
                and g.is_current
           )
         )
    ) users
   where uid is not null;

  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_cand_recruiter_ids
    from (
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where (a.team_id = p_team_id or a.leader_app_user_id = any(v_write_user_ids))
         and (
           a.is_current
           or a.suspended_by_account_disable
           or a.valid_to is null
           or a.valid_to >= v_today
         )
      union
      select l.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = any(v_write_user_ids)
    ) rids
   where rid is not null;

  select coalesce(array_agg(distinct pid order by pid), array[]::uuid[])
    into v_locked_person_ids
    from (
      select p.person_id as pid
        from public.organization_persons p
       where p.recruiter_id = any(v_cand_recruiter_ids)
      union
      select l.person_id as pid
        from public.organization_account_person_links l
       where l.app_user_id = any(v_write_user_ids)
         and l.ended_at is null
      union
      select l.person_id as pid
        from public.organization_account_person_links l
        join public.direct_entry_app_user_recruiter_links rl
          on rl.app_user_id = l.app_user_id
       where rl.recruiter_id = any(v_cand_recruiter_ids)
         and rl.verified = true
         and (rl.is_current = true or rl.suspended_by_account_disable = true)
         and l.ended_at is null
    ) pids
   where pid is not null;

  -- Phase 2: Canonical Tier 1 (P -> D -> M BEFORE Tier 2 U!)
  foreach v_locked_id in array v_locked_person_ids loop
    perform public.org_department__internal_lock_person(v_locked_id);
  end loop;

  if cardinality(v_locked_person_ids) > 0 then
    perform p.person_id
      from public.organization_persons p
     where p.person_id = any(v_locked_person_ids)
     order by p.person_id asc
     for update;

    select coalesce(array_agg(distinct m.department_id order by m.department_id), array[]::uuid[])
      into v_locked_dept_ids
      from public.organization_person_department_memberships m
     where m.person_id = any(v_locked_person_ids)
       and m.ended_at is null;

    foreach v_locked_id in array v_locked_dept_ids loop
      perform public.org_department__internal_lock_department(v_locked_id);
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
  end if;

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union
      select unnest(v_write_user_ids) as uid
    ) all_users
   where uid is not null;

  -- Phase 2a: Canonical Tier 2 (U advisory: sorted ascending, deduplicated write-target accounts FIRST)
  foreach v_locked_id in array coalesce(v_write_user_ids, array[]::uuid[]) loop
    if v_locked_id is not null then
      perform public.org_department__internal_lock_app_user(v_locked_id);
    end if;
  end loop;

  -- Phase 2b: Canonical Tier 2 (U row: ascending UUID order, FOR UPDATE targets, FOR SHARE pure operator)
  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id = any(v_all_user_ids)
     order by u.app_user_id asc
  loop
    if v_locked_id = any(v_write_user_ids) then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_locked_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_locked_id
       for share;
    end if;
  end loop;

  -- Re-assert operator team_master_manage [ALL] authority under U lock BEFORE idempotency / OCC
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.direct_entry_authz__internal_has_paired_capability(
    p_app_user_id, 'team_master_manage', 'ALL', null
  ) then
    raise exception 'insufficient privilege for team leader management' using errcode = '42501';
  end if;
  p_authority := case
    when public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
     and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      then 'entry_admin'
    else 'team_master_manage'
  end;

  -- Canonical Tier 3 (R_full: affected recruiters in ascending ID order)
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_locked_recruiter_ids
    from (
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where (a.team_id = p_team_id or a.leader_app_user_id = any(v_write_user_ids))
         and (
           a.is_current
           or a.suspended_by_account_disable
           or a.valid_to is null
           or a.valid_to >= v_today
         )
      union
      select l.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = any(v_write_user_ids)
      union
      select p.recruiter_id as rid
        from public.organization_persons p
       where p.person_id = any(v_locked_person_ids)
         and p.recruiter_id is not null
    ) rids
   where rid is not null;

  if cardinality(v_locked_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_locked_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  -- Canonical Tier 4 (T: target team)
  select t.* into v_team
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if v_team.code = '__system_vendor__' then
    raise exception 'reserved team cannot have a leader' using errcode = '23514';
  end if;

  v_idempotency_action := case p_operation
    when 'designate' then 'team_leader_designate'
    else 'team_leader_revoke'
  end;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'team_id', p_team_id,
    'target_leader_app_user_id', p_target_leader_app_user_id,
    'effective_date', p_effective_date,
    'expected_version', p_expected_version,
    'reason', p_reason
  ));
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_app_user_id
     and i.action = v_idempotency_action
     and i.idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash <> v_request_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    if v_prior is null then
      raise exception 'completed idempotency result is missing' using errcode = '55000';
    end if;
    return v_prior;
  end if;

  p_effective_date := coalesce(p_effective_date, v_today);
  if p_effective_date > v_today then
    raise exception 'future team leader assignments require explicit activation'
      using errcode = '22023';
  end if;
  if p_effective_date < v_today then
    raise exception 'past team leader assignments are not allowed'
      using errcode = '22023';
  end if;

  if v_team.version <> p_expected_version then
    raise exception 'team version conflict' using errcode = 'PT409';
  end if;
  if p_operation = 'designate' and not v_team.active then
    raise exception 'target team is inactive' using errcode = '23514';
  end if;

  -- Post-lock completeness guard (extended across P, U, and R_full)
  if exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and (
         a.is_current
         or a.suspended_by_account_disable
         or a.valid_to is null
         or a.valid_to >= v_today
         or exists (
           select 1
             from public.direct_entry_capability_grants g
            where g.app_user_id = a.leader_app_user_id
              and g.capability = 'team_manager_assign'
              and g.is_current
         )
       )
       and (
         not (a.leader_app_user_id = any(v_write_user_ids))
         or not (a.leader_recruiter_id = any(v_locked_recruiter_ids))
       )
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = any(v_write_user_ids)
       and not (l.recruiter_id = any(v_locked_recruiter_ids))
  ) or exists (
    select 1
      from public.organization_persons p
     where p.recruiter_id = any(v_locked_recruiter_ids)
       and not (p.person_id = any(v_locked_person_ids))
  ) or exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = any(v_write_user_ids)
       and l.ended_at is null
       and not (l.person_id = any(v_locked_person_ids))
  ) or exists (
    select 1
      from public.organization_account_person_links l
      join public.direct_entry_app_user_recruiter_links rl
        on rl.app_user_id = l.app_user_id
     where rl.recruiter_id = any(v_locked_recruiter_ids)
       and rl.verified = true
       and (rl.is_current = true or rl.suspended_by_account_disable = true)
       and l.ended_at is null
       and not (l.person_id = any(v_locked_person_ids))
  ) then
    raise exception 'team version conflict' using errcode = 'PT409';
  end if;

  -- Canonical child tiers: RPM -> RTM -> URL -> SG -> TLA -> CG
  if cardinality(v_locked_recruiter_ids) > 0 then
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
  end if;

  if cardinality(v_write_user_ids) > 0 or cardinality(v_locked_recruiter_ids) > 0 then
    perform l.link_id
      from public.direct_entry_app_user_recruiter_links l
     where (cardinality(v_write_user_ids) > 0 and l.app_user_id = any(v_write_user_ids))
        or (cardinality(v_locked_recruiter_ids) > 0 and l.recruiter_id = any(v_locked_recruiter_ids))
     order by l.link_id asc
     for update;

    for v_lock_key in
      select distinct 'recruiter-link:' || uid::text as k
        from unnest(coalesce(v_write_user_ids, array[]::uuid[])) as uid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    for v_lock_key in
      select distinct 'recruiter-link-recruiter:' || rid::text as k
        from unnest(coalesce(v_locked_recruiter_ids, array[]::uuid[])) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;
  end if;

  perform s.grant_id
    from public.direct_entry_scope_grants s
   where (cardinality(v_write_user_ids) > 0 and s.app_user_id = any(v_write_user_ids) and s.scope_kind = 'team')
      or s.team_id = p_team_id
   order by s.grant_id asc
   for update;

  for v_lock_key in
    select distinct k
      from (
        select 'scope:' || uid::text || ':team:' || p_team_id::text as k
          from unnest(coalesce(v_write_user_ids, array[]::uuid[])) as uid
        union
        select 'scope:' || s.app_user_id::text || ':' || s.scope_kind || ':' || coalesce(s.team_id::text, s.app_user_id::text) as k
          from public.direct_entry_scope_grants s
         where (cardinality(v_write_user_ids) > 0 and s.app_user_id = any(v_write_user_ids) and s.scope_kind = 'team')
            or s.team_id = p_team_id
      ) keys
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform a.assignment_id
    from public.direct_entry_team_leader_assignments a
   where a.team_id = p_team_id
      or (cardinality(v_write_user_ids) > 0 and a.leader_app_user_id = any(v_write_user_ids))
   order by a.assignment_id asc
   for update;

  if cardinality(v_write_user_ids) > 0 then
    perform g.grant_id
      from public.direct_entry_capability_grants g
     where g.app_user_id = any(v_write_user_ids)
     order by g.grant_id asc
     for update;

    for v_lock_key in
      select distinct 'capability:' || caps.uid::text || ':' || caps.capability as k
        from (
          select g.app_user_id as uid, g.capability
            from public.direct_entry_capability_grants g
           where g.app_user_id = any(v_write_user_ids)
          union
          select uid, cap as capability
            from unnest(v_write_user_ids) as uid
            cross join unnest(array[
              'team_manager_assign',
              'report_analytics_view',
              'report_assign',
              'report_review',
              'report_view'
            ]::text[]) as cap
        ) caps
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;
  end if;

  -- Phase 3: Materialize expired/effective state under full locks (SG -> TLA -> CG)
  update public.direct_entry_scope_grants s
     set is_current = false,
         suspended_by_account_disable = false
   where s.scope_kind = 'team'
     and s.team_id = p_team_id
     and s.is_current
     and s.valid_to is not null
     and s.valid_to <= v_today;

  update public.direct_entry_team_leader_assignments a
     set is_current = false,
         suspended_by_account_disable = false
   where a.team_id = p_team_id
     and a.is_current
     and a.valid_to is not null
     and a.valid_to <= v_today;

  update public.direct_entry_capability_grants g
     set is_current = false,
         suspended_by_account_disable = false
   where g.capability = 'team_manager_assign'
     and g.is_current
     and g.valid_to is not null
     and g.valid_to <= v_today
     and exists (
       select 1
         from public.direct_entry_team_leader_assignments a
        where a.team_id = p_team_id
          and a.leader_app_user_id = g.app_user_id
          and a.valid_from = g.valid_from
          and a.valid_to = g.valid_to
     );

  update public.direct_entry_scope_grants s
     set is_current = true
   where s.scope_kind = 'team'
     and s.team_id = p_team_id
     and not s.is_current
     and not s.suspended_by_account_disable
     and public.direct_entry__internal_team_scope_grant_effective(s.grant_id, v_today);

  update public.direct_entry_team_leader_assignments a
     set is_current = true
   where a.team_id = p_team_id
     and not a.is_current
     and not a.suspended_by_account_disable
     and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today);

  update public.direct_entry_capability_grants g
     set is_current = true
   where g.capability = 'team_manager_assign'
     and not g.is_current
     and not g.suspended_by_account_disable
     and public.direct_entry__internal_capability_grant_effective(g.grant_id, v_today)
     and exists (
       select 1
         from public.direct_entry_team_leader_assignments a
        where a.team_id = p_team_id
          and a.leader_app_user_id = g.app_user_id
          and g.valid_from = a.valid_from
          and g.valid_to is not distinct from a.valid_to
     );

  select count(*)::int into v_old_count
    from public.direct_entry_team_leader_assignments a
   where a.team_id = p_team_id
     and (a.valid_to is null or a.valid_to > a.valid_from)
     and daterange(a.valid_from, a.valid_to, '[)')
         && daterange(p_effective_date, null, '[)');
  if v_old_count > 1 then
    raise exception 'team leader assignment is ambiguous' using errcode = '42501';
  end if;
  if v_old_count = 1 then
    select a.* into v_old
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and daterange(a.valid_from, a.valid_to, '[)')
           && daterange(p_effective_date, null, '[)')
     order by a.valid_from, a.assignment_id
     limit 1;
    if v_old.valid_from > p_effective_date then
      raise exception 'future team leader must be cancelled at its start date'
        using errcode = '23514';
    end if;
  elsif p_operation = 'revoke' then
    raise exception 'no leader assignment to revoke' using errcode = '22023';
  end if;
  if p_operation = 'designate'
     and v_old_count = 1
     and v_old.leader_app_user_id = p_target_leader_app_user_id then
    raise exception 'leader is already assigned to this team' using errcode = '23514';
  end if;

  if p_operation = 'revoke'
     and v_old_count = 1
     and p_effective_date = v_old.valid_from then
    select r.* into v_origin
      from public.direct_entry_team_leader_revisions r
     where r.team_id = p_team_id
       and r.after_snapshot->>'leader_app_user_id' = v_old.leader_app_user_id::text
       and r.after_snapshot->>'valid_from' = v_old.valid_from::text
     order by r.version desc
     limit 1;
    if found and v_origin.action = 'replace' then
      select a.* into v_previous
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and a.valid_to = v_old.valid_from
         and a.valid_from < a.valid_to
         and exists (
           select 1
             from public.direct_entry_team_leader_revisions r
            where r.team_id = p_team_id
              and r.version <= v_origin.version
              and r.action = 'replace'
              and r.after_snapshot->>'valid_from' = v_old.valid_from::text
              and r.before_snapshot->>'leader_app_user_id' = a.leader_app_user_id::text
              and r.before_snapshot->>'leader_recruiter_id' = a.leader_recruiter_id::text
              and r.before_snapshot->>'valid_from' = a.valid_from::text
              and not exists (
                select 1
                  from public.direct_entry_team_leader_revisions r2
                 where r2.team_id = p_team_id
                   and r2.version > r.version
                   and (
                     r2.action <> 'replace'
                     or r2.after_snapshot->>'valid_from' <> v_old.valid_from::text
                   )
              )
         )
       order by a.valid_from desc, a.assignment_id desc
       limit 1;
    end if;
  end if;

  if p_operation = 'designate' then
    select u.enabled into v_candidate_user_enabled
      from public.direct_entry_app_users u
     where u.app_user_id = p_target_leader_app_user_id;
    if not found or not coalesce(v_candidate_user_enabled, false) then
      raise exception 'target leader account is not enabled' using errcode = '42501';
    end if;

    select count(*)::int,
           count(*) filter (where l.verified)::int,
           (array_agg(l.recruiter_id order by l.link_id))[1]
      into v_link_count, v_verified_link_count, v_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_target_leader_app_user_id
       and (
         l.is_current
         or (
           p_effective_date > v_today
           and l.valid_from <= p_effective_date
           and (l.valid_to is null or p_effective_date < l.valid_to)
           and (l.valid_to is null or l.valid_to > l.valid_from)
         )
       );
    if v_link_count <> 1 or v_verified_link_count <> 1 or v_recruiter_id is null then
      raise exception 'target leader requires exactly one verified recruiter link'
        using errcode = '42501';
    end if;

    select r.active into v_recruiter_active
      from public.recruiters r
     where r.recruiter_id = v_recruiter_id;
    if not found or not coalesce(v_recruiter_active, false) then
      raise exception 'target recruiter is not active' using errcode = '42501';
    end if;

    -- Cross-domain §2.3 guard under full locks (reject 23514 if mapped to non-RECRUITMENT / INACTIVE / Source C)
    if not public.org_department__internal_recruiter_org_allows_recruitment_team(
      v_recruiter_id,
      p_target_leader_app_user_id,
      pg_catalog.clock_timestamp()
    ) then
      raise exception 'target leader organization assignment does not allow recruitment team leadership'
        using errcode = '23514';
    end if;

    select count(*)::int,
           count(*) filter (
             where m.provider_type = 'hrp' and m.vendor_id is null
           )::int
      into v_provider_count, v_hrp_provider_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date);
    if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
      raise exception 'target recruiter requires exactly one effective HRP provider'
        using errcode = '42501';
    end if;

    select count(*)::int,
           count(*) filter (where m.team_id = p_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
       and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, p_effective_date);
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'target recruiter must have exactly one effective membership in the target team'
        using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_leader_app_user_id
         and a.team_id <> p_team_id
         and (
           a.is_current
           or (
             (a.valid_to is null or a.valid_to > a.valid_from)
             and daterange(a.valid_from, a.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
    ) then
      raise exception 'target leader is assigned or scheduled for another team'
        using errcode = '42501';
    end if;

    if exists (
      select 1
        from public.direct_entry_scope_grants s
       where s.app_user_id = p_target_leader_app_user_id
         and s.scope_kind = 'team'
         and (
           s.is_current
           or (
             (s.valid_to is null or s.valid_to > s.valid_from)
             and daterange(s.valid_from, s.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
    ) or exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_target_leader_app_user_id
         and g.capability = 'team_manager_assign'
         and (
           g.is_current
           or (
             (g.valid_to is null or g.valid_to > g.valid_from)
             and daterange(g.valid_from, g.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
    ) then
      raise exception 'target leader has pre-existing leader authority intervals'
        using errcode = '42501';
    end if;
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, v_idempotency_action, p_idempotency_key, v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_old_count = 1 then
    select count(*)::int, (array_agg(s.grant_id order by s.grant_id))[1]
      into v_scope_count, v_scope_grant_id
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_old.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = p_team_id
       and s.valid_from <= v_old.valid_from
       and s.valid_to is not distinct from v_old.valid_to
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int, (array_agg(g.grant_id order by g.grant_id))[1]
      into v_capability_count, v_capability_grant_id
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_old.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = v_old.valid_from
       and g.valid_to is not distinct from v_old.valid_to
       and (g.valid_to is null or g.valid_to > g.valid_from);
    if v_scope_count <> 1 or v_capability_count <> 1 then
      raise exception 'leader authority interval state conflict'
        using errcode = '23514';
    end if;
    if exists (
      select 1
        from public.direct_entry_scope_grants s
       where s.app_user_id = v_old.leader_app_user_id
         and s.scope_kind = 'team'
         and (
           s.is_current
           or (
             (s.valid_to is null or s.valid_to > s.valid_from)
             and daterange(s.valid_from, s.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
         and s.grant_id <> v_scope_grant_id
    ) or exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = v_old.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and (
           g.is_current
           or (
             (g.valid_to is null or g.valid_to > g.valid_from)
             and daterange(g.valid_from, g.valid_to, '[)')
                 && daterange(p_effective_date, null, '[)')
           )
         )
         and g.grant_id <> v_capability_grant_id
    ) then
      raise exception 'outgoing leader has ambiguous future authority intervals'
        using errcode = '42501';
    end if;
  end if;

  if p_operation = 'revoke' and v_previous.assignment_id is not null then
    select count(*)::int, (array_agg(s.grant_id order by s.grant_id))[1]
      into v_prev_scope_grant_count, v_prev_scope_grant_id
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_previous.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = p_team_id
       and s.valid_from <= v_previous.valid_from
       and s.valid_to = v_previous.valid_to
       and s.valid_to > s.valid_from;

    select count(*)::int, (array_agg(g.grant_id order by g.grant_id))[1]
      into v_prev_capability_grant_count, v_prev_capability_grant_id
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_previous.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = v_previous.valid_from
       and g.valid_to = v_previous.valid_to
       and g.valid_to > g.valid_from;

    select (array_agg(l.recruiter_id order by l.link_id) filter (where l.verified))[1]
      into v_restore_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = v_previous.leader_app_user_id
       and l.is_current;

    if v_team.active
       and v_prev_scope_grant_count = 1
       and v_prev_capability_grant_count = 1
       and v_restore_recruiter_id is not null
       and v_restore_recruiter_id = v_previous.leader_recruiter_id
       and public.org_department__internal_recruiter_org_allows_recruitment_team(
         v_previous.leader_recruiter_id,
         v_previous.leader_app_user_id,
         pg_catalog.clock_timestamp()
       )
       and exists (
         select 1
           from public.direct_entry_app_users u
           join public.recruiters r on r.recruiter_id = v_restore_recruiter_id
          where u.app_user_id = v_previous.leader_app_user_id
            and u.enabled
            and r.active
       )
       and (
         select count(*)::int
           from public.direct_entry_app_user_recruiter_links l
          where l.app_user_id = v_previous.leader_app_user_id
            and l.is_current
       ) = 1
       and (
         select count(*)::int
           from public.recruiter_provider_memberships m
          where m.recruiter_id = v_restore_recruiter_id
            and m.provider_type = 'hrp'
            and m.vendor_id is null
            and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today)
       ) = 1
       and (
         select count(*)::int
           from public.recruiter_team_memberships m
          where m.recruiter_id = v_restore_recruiter_id
            and m.team_id = p_team_id
            and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
       ) = 1
       and not exists (
         select 1
           from public.direct_entry_team_leader_assignments a
          where a.assignment_id not in (v_old.assignment_id, v_previous.assignment_id)
            and (a.team_id = p_team_id or a.leader_app_user_id = v_previous.leader_app_user_id)
            and (
              a.is_current
              or (
                (a.valid_to is null or a.valid_to > a.valid_from)
                and daterange(a.valid_from, a.valid_to, '[)')
                    && daterange(v_previous.valid_from, null, '[)')
              )
            )
       )
       and not exists (
         select 1
           from public.direct_entry_scope_grants s
          where s.app_user_id = v_previous.leader_app_user_id
            and s.scope_kind = 'team'
            and s.grant_id not in (v_scope_grant_id, v_prev_scope_grant_id)
            and (
              s.is_current
              or (
                (s.valid_to is null or s.valid_to > s.valid_from)
                and daterange(s.valid_from, s.valid_to, '[)')
                    && daterange(v_previous.valid_from, null, '[)')
              )
            )
       )
       and not exists (
         select 1
           from public.direct_entry_capability_grants g
          where g.app_user_id = v_previous.leader_app_user_id
            and g.capability = 'team_manager_assign'
            and g.grant_id not in (v_capability_grant_id, v_prev_capability_grant_id)
            and (
              g.is_current
              or (
                (g.valid_to is null or g.valid_to > g.valid_from)
                and daterange(g.valid_from, g.valid_to, '[)')
                    && daterange(v_previous.valid_from, null, '[)')
              )
            )
       ) then
      v_restore := true;
    end if;
  end if;

  if v_old_count = 1 then
    if p_effective_date = v_old.valid_from then
      perform set_config('direct_entry.team_leader_marker', 'on', true);
    end if;
    update public.direct_entry_scope_grants
       set valid_to = p_effective_date,
           is_current = (p_effective_date > valid_from and valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
           suspended_by_account_disable = false
     where grant_id = v_scope_grant_id;
    update public.direct_entry_team_leader_assignments
       set valid_to = p_effective_date,
           is_current = (p_effective_date > v_old.valid_from and v_old.valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
           suspended_by_account_disable = false
     where assignment_id = v_old.assignment_id;
    update public.direct_entry_capability_grants
       set valid_to = p_effective_date,
           is_current = (p_effective_date > valid_from and valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
           suspended_by_account_disable = false
     where grant_id = v_capability_grant_id;
  end if;

  if v_restore then
    update public.direct_entry_scope_grants
       set valid_to = null,
           is_current = (valid_from <= v_today),
           suspended_by_account_disable = false
     where grant_id = v_prev_scope_grant_id;
    update public.direct_entry_team_leader_assignments
       set valid_to = null,
           is_current = (v_previous.valid_from <= v_today),
           suspended_by_account_disable = false
     where assignment_id = v_previous.assignment_id;
    update public.direct_entry_capability_grants
       set valid_to = null,
           is_current = (valid_from <= v_today),
           suspended_by_account_disable = false
     where grant_id = v_prev_capability_grant_id;
  end if;

  if p_operation = 'designate' then
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, team_id, valid_from, is_current, suspended_by_account_disable)
    values
      (p_target_leader_app_user_id, 'team', p_team_id, p_effective_date, (p_effective_date <= v_today), false);
    insert into public.direct_entry_team_leader_assignments
      (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current, suspended_by_account_disable)
    values
      (p_team_id, p_target_leader_app_user_id, v_recruiter_id, p_effective_date, (p_effective_date <= v_today), false)
    returning * into v_new;
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from, is_current, suspended_by_account_disable)
    values
      (p_target_leader_app_user_id, 'team_manager_assign', p_effective_date, (p_effective_date <= v_today), false);
    v_change := case when v_old_count = 1 then 'replace' else 'designate' end;
  else
    v_new := v_old;
    v_change := 'revoke';
  end if;

  if p_operation = 'designate' then
    select count(*) filter (where a.team_id = p_team_id)::int,
           count(*) filter (
             where a.team_id = p_team_id
               and a.leader_app_user_id = p_target_leader_app_user_id
           )::int,
           count(*) filter (
             where a.leader_app_user_id = p_target_leader_app_user_id
           )::int
      into v_post_team_assignment_count, v_post_target_team_assignment_count,
           v_post_target_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from);

    if v_post_team_assignment_count <> 1
       or v_post_target_team_assignment_count <> 1
       or v_post_target_assignment_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;

    select count(*)::int,
           count(*) filter (where s.team_id = p_team_id)::int
      into v_post_scope_count, v_post_target_team_scope_count
      from public.direct_entry_scope_grants s
     where s.app_user_id = p_target_leader_app_user_id
       and s.scope_kind = 'team'
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = p_target_leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
    select count(*)::int into v_post_coextensive_scope_count
      from public.direct_entry_team_leader_assignments a
      join public.direct_entry_scope_grants s
        on s.app_user_id = a.leader_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = a.team_id
       and s.valid_from = a.valid_from
       and s.valid_to is not distinct from a.valid_to
     where a.team_id = p_team_id
       and a.leader_app_user_id = p_target_leader_app_user_id
       and a.valid_from = p_effective_date
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_coextensive_capability_count
      from public.direct_entry_team_leader_assignments a
      join public.direct_entry_capability_grants g
        on g.app_user_id = a.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from = a.valid_from
       and g.valid_to is not distinct from a.valid_to
     where a.team_id = p_team_id
       and a.leader_app_user_id = p_target_leader_app_user_id
       and a.valid_from = p_effective_date
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
    if v_post_scope_count <> 1 or v_post_target_team_scope_count <> 1
       or v_post_capability_count <> 1
       or v_post_coextensive_scope_count <> 1
       or v_post_coextensive_capability_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;

    if v_old_count = 1 then
      select count(*)::int into v_post_outgoing_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and a.leader_app_user_id = v_old.leader_app_user_id
         and a.valid_from <= p_effective_date
         and (a.valid_to is null or p_effective_date < a.valid_to)
         and (a.valid_to is null or a.valid_to > a.valid_from);
      select count(*)::int into v_post_outgoing_scope_count
        from public.direct_entry_scope_grants s
       where s.app_user_id = v_old.leader_app_user_id
         and s.scope_kind = 'team' and s.team_id = p_team_id
         and s.valid_from <= p_effective_date
         and (s.valid_to is null or p_effective_date < s.valid_to)
         and (s.valid_to is null or s.valid_to > s.valid_from);
      select count(*)::int into v_post_outgoing_capability_count
        from public.direct_entry_capability_grants g
       where g.app_user_id = v_old.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and g.valid_from <= p_effective_date
         and (g.valid_to is null or p_effective_date < g.valid_to)
         and (g.valid_to is null or g.valid_to > g.valid_from);
      select count(*)::int into v_post_closed_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.assignment_id = v_old.assignment_id
         and a.valid_to = p_effective_date;
      select count(*)::int into v_post_closed_scope_count
        from public.direct_entry_scope_grants s
       where s.grant_id = v_scope_grant_id and s.valid_to = p_effective_date;
      select count(*)::int into v_post_closed_capability_count
        from public.direct_entry_capability_grants g
       where g.grant_id = v_capability_grant_id and g.valid_to = p_effective_date;
      if v_post_outgoing_assignment_count <> 0
         or v_post_outgoing_scope_count <> 0
         or v_post_outgoing_capability_count <> 0
         or v_post_closed_assignment_count <> 1
         or v_post_closed_scope_count <> 1
         or v_post_closed_capability_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    end if;
  else
    select count(*)::int into v_post_team_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from);
    select count(*)::int into v_post_outgoing_scope_count
      from public.direct_entry_scope_grants s
     where s.app_user_id = v_old.leader_app_user_id
       and s.scope_kind = 'team' and s.team_id = p_team_id
       and s.valid_from <= p_effective_date
       and (s.valid_to is null or p_effective_date < s.valid_to)
       and (s.valid_to is null or s.valid_to > s.valid_from);
    select count(*)::int into v_post_outgoing_capability_count
      from public.direct_entry_capability_grants g
     where g.app_user_id = v_old.leader_app_user_id
       and g.capability = 'team_manager_assign'
       and g.valid_from <= p_effective_date
       and (g.valid_to is null or p_effective_date < g.valid_to)
       and (g.valid_to is null or g.valid_to > g.valid_from);
    select count(*)::int into v_post_closed_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_old.assignment_id
       and a.valid_to = p_effective_date;
    select count(*)::int into v_post_closed_scope_count
      from public.direct_entry_scope_grants s
     where s.grant_id = v_scope_grant_id and s.valid_to = p_effective_date;
    select count(*)::int into v_post_closed_capability_count
      from public.direct_entry_capability_grants g
     where g.grant_id = v_capability_grant_id and g.valid_to = p_effective_date;
    if v_restore then
      select count(*)::int into v_post_restored_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.assignment_id = v_previous.assignment_id
         and a.valid_to is null
         and a.is_current = (v_previous.valid_from <= v_today);
      select count(*)::int into v_post_restored_scope_count
        from public.direct_entry_scope_grants s
       where s.grant_id = v_prev_scope_grant_id
         and s.valid_to is null
         and s.is_current = (s.valid_from <= v_today);
      select count(*)::int into v_post_restored_capability_count
        from public.direct_entry_capability_grants g
       where g.grant_id = v_prev_capability_grant_id
         and g.valid_to is null
         and g.is_current = (g.valid_from <= v_today);
      if v_post_team_assignment_count <> 1
         or v_post_outgoing_scope_count <> 0
         or v_post_outgoing_capability_count <> 0
         or v_post_closed_assignment_count <> 1
         or v_post_closed_scope_count <> 1
         or v_post_closed_capability_count <> 1
         or v_post_restored_assignment_count <> 1
         or v_post_restored_scope_count <> 1
         or v_post_restored_capability_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    else
      if v_post_team_assignment_count <> 0
         or v_post_outgoing_scope_count <> 0
         or v_post_outgoing_capability_count <> 0
         or v_post_closed_assignment_count <> 1
         or v_post_closed_scope_count <> 1
         or v_post_closed_capability_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    end if;
  end if;

  update public.teams t
     set version = t.version + 1
   where t.team_id = p_team_id
  returning t.version into v_team_version;
  if v_team_version is null then
    raise exception 'team not found' using errcode = 'P0002';
  end if;

  if v_old_count = 1 then
    v_before := public.direct_entry_team_leader_snapshot(
      p_team_id, v_old.leader_app_user_id, v_old.leader_recruiter_id,
      v_old.valid_from, v_old.valid_to, null, v_team.version, v_change
    );
  end if;
  if p_operation = 'designate' then
    v_after := public.direct_entry_team_leader_snapshot(
      p_team_id, v_new.leader_app_user_id, v_new.leader_recruiter_id,
      v_new.valid_from, v_new.valid_to,
      case when v_old_count = 1 then v_old.leader_recruiter_id end,
      v_team_version, v_change
    );
  else
    v_after := public.direct_entry_team_leader_snapshot(
      p_team_id, v_old.leader_app_user_id, v_old.leader_recruiter_id,
      v_old.valid_from, p_effective_date,
      case when v_restore then v_previous.leader_recruiter_id else null end,
      v_team_version, v_change
    );
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_team_leader_revisions
    (team_id, version, actor_user_id, action, before_snapshot, after_snapshot)
  values
    (p_team_id, v_team_version, p_app_user_id, v_change, v_before, v_after)
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, leader_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_leader_' || v_change, p_authority,
     p_team_id::text, 'all', 'APPLIED', v_reason_id, v_changed_fields, v_revision_id);

  v_result := jsonb_build_object(
    'team_id', p_team_id,
    'assignment_id', v_new.assignment_id,
    'leader_app_user_id', v_new.leader_app_user_id,
    'leader_recruiter_id', v_new.leader_recruiter_id,
    'valid_from', v_new.valid_from,
    'valid_to', case when p_operation = 'revoke' then p_effective_date else v_new.valid_to end,
    'version', v_team_version,
    'revision_id', v_revision_id,
    'change', v_change
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, v_idempotency_action, p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

-- =============================================================================
-- 14. Writer Group #14: direct_entry_mutate_app_user_status
-- =============================================================================

create or replace function public.direct_entry_mutate_app_user_status(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_expected_app_user_version integer,
  p_reason text,
  p_idempotency_key text,
  p_enable boolean
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_locked_id uuid;
  v_actor public.direct_entry_app_users;
  v_target public.direct_entry_app_users;
  v_action text := case when p_enable then 'enable' else 'disable' end;
  v_payload_hash text;
  v_existing_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_before jsonb;
  v_after jsonb;
  v_result jsonb;
  v_today date := public.direct_entry_authorization_date();
  v_rl record;
  v_tla record;
  v_can_restore_tl boolean;
  v_prev_marker text := pg_catalog.current_setting('direct_entry.team_leader_marker', true);
  v_locked_person_ids uuid[];
  v_locked_dept_ids uuid[];
  v_recruiter_ids uuid[];
  v_team_ids uuid[];
  v_lock_key text;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_auth_subject is null or p_actor_app_user_id is null or p_target_app_user_id is null then
    raise exception 'actor and target are required' using errcode = '22023';
  end if;
  if p_expected_app_user_version is null or p_expected_app_user_version < 1 then
    raise exception 'expected app user version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Phase 1: Unlocked candidate discovery for Tier 1 (P -> D -> M) before Tier 2 (U)
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_recruiter_ids
    from (
      select l.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = p_target_app_user_id
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_app_user_id
    ) rids
   where rid is not null;

  select coalesce(array_agg(distinct pid order by pid), array[]::uuid[])
    into v_locked_person_ids
    from (
      select l.person_id as pid
        from public.organization_account_person_links l
       where l.app_user_id = p_target_app_user_id
         and l.ended_at is null
      union
      select p.person_id as pid
        from public.organization_persons p
       where p.recruiter_id = any(v_recruiter_ids)
    ) pids
   where pid is not null;

  -- Tier 1 (P -> D -> M) BEFORE Tier 2 (U)
  foreach v_locked_id in array v_locked_person_ids loop
    perform public.org_department__internal_lock_person(v_locked_id);
  end loop;

  if cardinality(v_locked_person_ids) > 0 then
    perform p.person_id
      from public.organization_persons p
     where p.person_id = any(v_locked_person_ids)
     order by p.person_id asc
     for update;

    select coalesce(array_agg(distinct m.department_id order by m.department_id), array[]::uuid[])
      into v_locked_dept_ids
      from public.organization_person_department_memberships m
     where m.person_id = any(v_locked_person_ids)
       and m.ended_at is null;

    foreach v_locked_id in array v_locked_dept_ids loop
      perform public.org_department__internal_lock_department(v_locked_id);
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
  end if;

  -- Tier 2a (U advisory: lock write-target account BEFORE any direct_entry_app_users row lock)
  perform public.org_department__internal_lock_app_user(p_target_app_user_id);

  -- Tier 2b (U row: ascending UUID order, FOR UPDATE target, FOR SHARE pure operator)
  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id asc
  loop
    if v_locked_id = p_target_app_user_id then
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_locked_id
       for update;
    else
      perform u.app_user_id
        from public.direct_entry_app_users u
       where u.app_user_id = v_locked_id
       for share;
    end if;
  end loop;

  select u.* into v_actor
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id;
  if not found then
    raise exception 'actor identity is not derived from the session' using errcode = '42501';
  end if;

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'target app user unavailable' using errcode = 'P0002';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'action', v_action,
    'target_app_user_id', p_target_app_user_id,
    'expected_app_user_version', p_expected_app_user_version,
    'reason', p_reason
  ));

  select i.request_hash, i.result
    into v_existing_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_actor_app_user_id
     and i.action = 'app_user_' || v_action
     and i.idempotency_key = p_idempotency_key
   for update;
  if found then
    if v_existing_hash <> v_payload_hash then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);
    return v_prior;
  end if;

  if v_target.version <> p_expected_app_user_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  if p_enable and v_target.enabled then
    raise exception 'target app user is already enabled' using errcode = '23514';
  end if;
  if not p_enable and not v_target.enabled then
    raise exception 'target app user is already disabled' using errcode = '23514';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, 'app_user_' || v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Tier 3 & Tier 4 (R_full -> T)
  select coalesce(array_agg(distinct rid order by rid), array[]::uuid[])
    into v_recruiter_ids
    from (
      select l.recruiter_id as rid
        from public.direct_entry_app_user_recruiter_links l
       where l.app_user_id = p_target_app_user_id
      union
      select a.leader_recruiter_id as rid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_app_user_id
      union
      select p.recruiter_id as rid
        from public.organization_persons p
       where p.person_id = any(v_locked_person_ids)
         and p.recruiter_id is not null
    ) rids
   where rid is not null;

  select coalesce(array_agg(distinct tid order by tid), array[]::uuid[])
    into v_team_ids
    from (
      select a.team_id as tid
        from public.direct_entry_team_leader_assignments a
       where a.leader_app_user_id = p_target_app_user_id
      union
      select s.team_id as tid
        from public.direct_entry_scope_grants s
       where s.app_user_id = p_target_app_user_id
         and s.team_id is not null
    ) tids
   where tid is not null;

  if cardinality(v_recruiter_ids) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_recruiter_ids)
     order by r.recruiter_id asc
     for update;
  end if;

  if cardinality(v_team_ids) > 0 then
    perform t.team_id
      from public.teams t
     where t.team_id = any(v_team_ids)
     order by t.team_id asc
     for update;
  end if;

  -- Post-lock completeness guard (check Person / Recruiter drift before touching child grants)
  if exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = p_target_app_user_id
       and l.ended_at is null
       and not (l.person_id = any(v_locked_person_ids))
  ) or exists (
    select 1
      from public.organization_persons p
     where p.recruiter_id = any(v_recruiter_ids)
       and not (p.person_id = any(v_locked_person_ids))
  ) then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;

  -- Tier 5 Canonical Child Locks (RPM -> RTM -> URL -> SG -> TLA -> CG)
  if cardinality(v_recruiter_ids) > 0 then
    perform m.membership_id
      from public.recruiter_provider_memberships m
     where m.recruiter_id = any(v_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'provider:' || rid::text as k
        from unnest(v_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    perform m.membership_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = any(v_recruiter_ids)
     order by m.membership_id asc
     for update;

    for v_lock_key in
      select 'team-membership:' || rid::text as k
        from unnest(v_recruiter_ids) as rid
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;
  end if;

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_target_app_user_id
      or (cardinality(v_recruiter_ids) > 0 and l.recruiter_id = any(v_recruiter_ids))
   order by l.link_id asc
   for update;

  perform pg_advisory_xact_lock(hashtextextended('recruiter-link:' || p_target_app_user_id::text, 0));
  for v_lock_key in
    select 'recruiter-link-recruiter:' || rid::text as k
      from unnest(coalesce(v_recruiter_ids, array[]::uuid[])) as rid
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_target_app_user_id
   order by s.grant_id asc
   for update;

  for v_lock_key in
    select distinct k
      from (
        select 'scope:' || p_target_app_user_id::text || ':all:' || p_target_app_user_id::text as k
        union
        select 'scope:' || p_target_app_user_id::text || ':own:' || p_target_app_user_id::text as k
        union
        select 'scope:' || p_target_app_user_id::text || ':team:' || tid::text as k
          from unnest(coalesce(v_team_ids, array[]::uuid[])) as tid
        union
        select 'scope:' || s.app_user_id::text || ':' || s.scope_kind || ':' || coalesce(s.team_id::text, s.app_user_id::text) as k
          from public.direct_entry_scope_grants s
         where s.app_user_id = p_target_app_user_id
      ) keys
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform a.assignment_id
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = p_target_app_user_id
      or (cardinality(v_team_ids) > 0 and a.team_id = any(v_team_ids))
   order by a.assignment_id asc
   for update;

  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_target_app_user_id
   order by g.grant_id asc
   for update;

  for v_lock_key in
    select distinct 'capability:' || p_target_app_user_id::text || ':' || caps.capability as k
      from (
        select g.capability
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_target_app_user_id
        union
        select gc.capability
          from public.authz_user_group_members m
          join public.authz_user_groups g on g.group_id = m.group_id and g.active = true
          join public.authz_user_group_capabilities gc on gc.group_id = g.group_id and gc.ended_at is null
         where m.app_user_id = p_target_app_user_id
           and m.ended_at is null
        union
        select unnest(array[
          'team_manager_assign',
          'report_analytics_view',
          'report_assign',
          'report_review',
          'report_view'
        ]::text[]) as capability
      ) caps
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  v_before := public.direct_entry_app_user_snapshot(
    p_target_app_user_id, v_target.enabled, p_actor_app_user_id
  );

  update public.direct_entry_app_users
     set enabled = p_enable,
         version = version + 1,
         updated_at = pg_catalog.clock_timestamp()
   where app_user_id = p_target_app_user_id
   returning * into v_target;

  if p_enable then
    -- Step 1: Restore recruiter links before TL assignments
    for v_rl in
      select l.*, r.active as recruiter_active
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = p_target_app_user_id
         and l.suspended_by_account_disable = true
       order by l.link_id
    loop
      if (v_rl.valid_to is null or v_rl.valid_to > v_today)
         and v_rl.valid_from <= v_today
         and coalesce(v_rl.recruiter_active, false)
         and not exists (
           select 1 from public.direct_entry_app_user_recruiter_links other
            where other.link_id <> v_rl.link_id
              and other.is_current = true
              and (
                other.app_user_id = p_target_app_user_id
                or (v_rl.verified and other.verified and other.recruiter_id = v_rl.recruiter_id)
              )
         ) then
        update public.direct_entry_app_user_recruiter_links
           set is_current = true,
               suspended_by_account_disable = false
         where link_id = v_rl.link_id;
      else
        update public.direct_entry_app_user_recruiter_links
           set suspended_by_account_disable = false
         where link_id = v_rl.link_id;
      end if;
    end loop;

    -- Step 2: Restore TL assignments ONLY if Org §2.3 & team/recruiter invariants still hold
    for v_tla in
      select a.*, t.active as team_active, t.code as team_code, r.active as recruiter_active
        from public.direct_entry_team_leader_assignments a
        join public.teams t on t.team_id = a.team_id
        join public.recruiters r on r.recruiter_id = a.leader_recruiter_id
       where a.leader_app_user_id = p_target_app_user_id
         and a.suspended_by_account_disable = true
       order by a.assignment_id
    loop
      v_can_restore_tl := (
        v_tla.valid_to is null
        and v_tla.valid_from <= v_today
        and coalesce(v_tla.team_active, false)
        and v_tla.team_code <> '__system_vendor__'
        and coalesce(v_tla.recruiter_active, false)
        and public.org_department__internal_recruiter_org_allows_recruitment_team(
          v_tla.leader_recruiter_id,
          p_target_app_user_id,
          pg_catalog.clock_timestamp()
        )
        and exists (
          select 1 from public.direct_entry_app_user_recruiter_links l
           where l.app_user_id = p_target_app_user_id
             and l.recruiter_id = v_tla.leader_recruiter_id
             and l.verified = true
             and l.is_current = true
        )
        and (
          select count(*)::int from public.recruiter_provider_memberships m
           where m.recruiter_id = v_tla.leader_recruiter_id
             and m.provider_type = 'hrp'
             and m.vendor_id is null
             and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today)
        ) = 1
        and (
          select count(*)::int from public.recruiter_team_memberships m
           where m.recruiter_id = v_tla.leader_recruiter_id
             and m.team_id = v_tla.team_id
             and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
        ) = 1
        and not exists (
          select 1 from public.direct_entry_team_leader_assignments other
           where other.assignment_id <> v_tla.assignment_id
             and (other.team_id = v_tla.team_id or other.leader_app_user_id = p_target_app_user_id)
             and (
               other.is_current
               or (
                 (other.valid_to is null or other.valid_to > other.valid_from)
                 and daterange(other.valid_from, other.valid_to, '[)') && daterange(v_today, null, '[)')
               )
             )
        )
      );

      if v_can_restore_tl then
        update public.direct_entry_scope_grants s
           set is_current = true,
               suspended_by_account_disable = false
         where s.app_user_id = p_target_app_user_id
           and s.scope_kind = 'team'
           and s.team_id = v_tla.team_id
           and s.suspended_by_account_disable = true
           and s.valid_to is null;

        update public.direct_entry_team_leader_assignments a
           set is_current = true,
               suspended_by_account_disable = false
         where a.assignment_id = v_tla.assignment_id;

        update public.direct_entry_capability_grants g
           set is_current = true,
               suspended_by_account_disable = false
         where g.app_user_id = p_target_app_user_id
           and g.capability = 'team_manager_assign'
           and g.suspended_by_account_disable = true
           and g.valid_from = v_tla.valid_from
           and g.valid_to is null;
      else
        perform pg_catalog.set_config('direct_entry.team_leader_marker', 'on', true);

        update public.direct_entry_scope_grants s
           set is_current = false,
               suspended_by_account_disable = false,
               valid_to = coalesce(s.valid_to, greatest(v_today, s.valid_from))
         where s.app_user_id = p_target_app_user_id
           and s.scope_kind = 'team'
           and s.team_id = v_tla.team_id
           and s.suspended_by_account_disable = true
           and s.valid_from <= v_tla.valid_from;

        update public.direct_entry_team_leader_assignments a
           set is_current = false,
               suspended_by_account_disable = false,
               valid_to = coalesce(a.valid_to, greatest(v_today, a.valid_from))
         where a.assignment_id = v_tla.assignment_id;

        update public.direct_entry_capability_grants g
           set is_current = false,
               suspended_by_account_disable = false,
               valid_to = coalesce(g.valid_to, greatest(v_today, g.valid_from))
         where g.app_user_id = p_target_app_user_id
           and g.capability = 'team_manager_assign'
           and g.suspended_by_account_disable = true
           and g.valid_from = v_tla.valid_from;

        perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
      end if;
    end loop;

    -- Step 3: Restore suspended global scope grants and non-TL capability grants
    update public.direct_entry_scope_grants s
       set is_current = true,
           suspended_by_account_disable = false
     where s.app_user_id = p_target_app_user_id
       and s.suspended_by_account_disable = true
       and s.scope_kind in ('own', 'all')
       and s.valid_from <= v_today
       and (s.valid_to is null or (s.valid_to > s.valid_from and v_today < s.valid_to));

    update public.direct_entry_capability_grants g
       set is_current = true,
           suspended_by_account_disable = false
     where g.app_user_id = p_target_app_user_id
       and g.suspended_by_account_disable = true
       and g.capability <> 'team_manager_assign'
       and g.valid_from <= v_today
       and (g.valid_to is null or (g.valid_to > g.valid_from and v_today < g.valid_to))
       and (
         not exists (
           select 1 from public.work_report_team_leader_capability_grants x
            where x.capability_grant_id = g.grant_id
         )
         or exists (
           select 1
             from public.work_report_team_leader_capability_grants x
             join public.direct_entry_team_leader_assignments tla
               on tla.assignment_id = x.leader_assignment_id
            where x.capability_grant_id = g.grant_id
              and tla.is_current = true
         )
         or exists (
           select 1
             from public.authz_user_group_members m
             join public.authz_user_groups grp on grp.group_id = m.group_id and grp.active = true
             join public.organization_departments dept on dept.department_id = grp.department_id and dept.is_active = true
             left join public.teams t on t.team_id = grp.team_id and t.active = true and t.code <> '__system_vendor__'
             join public.authz_user_group_capabilities gc on gc.group_id = grp.group_id and gc.ended_at is null
            where m.app_user_id = p_target_app_user_id
              and m.ended_at is null
              and (grp.team_id is null or t.team_id is not null)
              and gc.capability = g.capability
         )
       );

    update public.direct_entry_scope_grants
       set suspended_by_account_disable = false
     where app_user_id = p_target_app_user_id
       and suspended_by_account_disable = true;

    update public.direct_entry_capability_grants
       set suspended_by_account_disable = false
     where app_user_id = p_target_app_user_id
       and suspended_by_account_disable = true;

    if v_target.authz_managed then
      perform public.direct_entry_authz__internal_sync_legacy_grants(p_target_app_user_id);
    end if;
  end if;

  v_after := public.direct_entry_app_user_snapshot(
    p_target_app_user_id, v_target.enabled, p_actor_app_user_id
  );

  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  insert into public.direct_entry_app_user_revisions
    (app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id)
  values
    (p_target_app_user_id, v_target.version, p_actor_app_user_id, v_action,
     v_before, v_after, v_reason_id)
  returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields, app_user_revision_id)
  values
    (p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
     p_target_app_user_id::text, 'all', 'APPLIED', v_reason_id,
     array['enabled'], v_revision_id);

  v_result := jsonb_build_object(
    'app_user_id', p_target_app_user_id,
    'version', v_target.version,
    'revision_id', v_revision_id,
    'change', v_action
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, 'app_user_' || v_action, p_idempotency_key, v_result
  );
  return v_result;
exception
  when others then
    perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
    raise;
end;
$function$;

-- =============================================================================
-- 15. Owner Alignment & Strict Security/ACL Verification
-- =============================================================================

do $align_and_check_wp10_2$
declare
  v_service_rpcs text[] := array[
    'public.org_department_link_account_person_admin(uuid, uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)',
    'public.org_department_create_person_admin(uuid, uuid, text, text, date, uuid, uuid, integer, uuid, text, uuid, text)',
    'public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)',
    'public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)',
    'public.org_department_unlink_account_person_admin(uuid, uuid, uuid, integer, integer, uuid, text, uuid, text)',
    'public.org_department_assign_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)',
    'public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.org_department_transfer_person_member_admin(uuid, uuid, uuid, uuid, integer, uuid, text, uuid, text)',
    'public.org_department_end_person_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)',
    'public.org_department_update_person_admin(uuid, uuid, uuid, integer, text, text, date, text, text, uuid, text)',
    'public.direct_entry_assign_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)',
    'public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)'
  ];
  v_internal_fns text[] := array[
    'public.org_department__internal_person_is_active_in_recruitment(uuid, timestamptz)',
    'public.org_department__internal_subject_has_blocking_team_assignment(uuid[], uuid[], date)',
    'public.org_department__internal_person_has_blocking_team_assignment(uuid, date)',
    'public.org_department__internal_recruiter_org_allows_recruitment_team(uuid, uuid, timestamptz)',
    'public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text)',
    'public.direct_entry_mutate_app_user_status(uuid, uuid, uuid, integer, text, text, boolean)'
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
    raise exception 'WP10-2 alignment failed: base owner missing' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-2 check failed: missing service RPC %', v_sig using errcode = '55000';
    end if;
    select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_sig);
    execute pg_catalog.format('grant execute on function %s to service_role', v_sig);

    select p.prosecdef, p.proconfig, p.proacl
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'WP10-2 check failed: definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'WP10-2 check failed: RPC ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-2 check failed: missing internal fn %', v_sig using errcode = '55000';
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
      raise exception 'WP10-2 check failed: internal definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'WP10-2 check failed: internal ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;
end
$align_and_check_wp10_2$;

commit;
