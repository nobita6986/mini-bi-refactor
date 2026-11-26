-- =============================================================================
-- WP10-7 Slice 3B: Team Leader authz_managed cutover (stop legacy TL grant
-- writes and legacy TL interval guards for authz_managed = true accounts)
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. public.direct_entry_list_team_leader_candidates(uuid, uuid, uuid, text, integer, integer)
--      - Gate legacy scope('team') and capability('team_manager_assign') NOT EXISTS
--        filters with coalesce(u.authz_managed, false) or (...) while preserving
--        all actor, team, account, recruiter, HRP, membership, and
--        direct_entry_team_leader_assignments checks.
--   2. public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text)
--      - Preserve Phase 1/2 canonical locks (Tier 1..5), completeness guards,
--        idempotency, OCC (PT409), Org checks, and direct_entry_team_leader_assignments
--        invariants.
--      - Gate Phase 3 legacy SG/CG is_current activation on not coalesce(u.authz_managed, false).
--      - Skip legacy pre-existing checks, SG/CG inserts, and legacy postconditions
--        for authz_managed = true targets; preserve 100% legacy behavior when false.
--      - For outgoing v_old with authz_managed = true, skip 23514/42501 legacy checks
--        and legacy postconditions, close TLA, and best-effort close matching pre-3B
--        scope_grants(team) and capability_grants('team_manager_assign') (only if
--        no active group grants team_manager_assign).
--      - For same-day v_restore, gate legacy checks/restoration/postconditions on
--        not v_prev_authz_managed and replace NOT IN with NULL-safe IS DISTINCT FROM.
--   3. public.work_report_sync_team_leader_capabilities()
--      - Preserve locking and existing bridge-row UPDATE branches so pre-3B
--        assignments still clean up cleanly.
--      - Skip inserting new work_report_* capability_grants / bridge rows when
--        coalesce(u.authz_managed, false) is true on new.leader_app_user_id.
--   4. Fail-closed postcheck ($wp10_7_3b_postcheck$) verifying ACLs and active triggers.
-- =============================================================================

begin;

-- =============================================================================
-- 1. direct_entry_list_team_leader_candidates
-- =============================================================================

create or replace function public.direct_entry_list_team_leader_candidates(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_search text default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_candidates jsonb;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.direct_entry_authz__internal_has_paired_capability(
    p_app_user_id, 'team_master_manage', 'ALL', null
  ) then
    raise exception 'insufficient privilege for team leader candidates' using errcode = '42501';
  end if;

  if p_team_id is null or not exists (
    select 1 from public.teams t
     where t.team_id = p_team_id
       and t.active
       and t.code <> '__system_vendor__'
  ) then
    raise exception 'team leader candidates unavailable' using errcode = 'P0002';
  end if;
  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid team leader candidate search' using errcode = '22023';
  end if;
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');

  with eligible as (
    select u.app_user_id, links.recruiter_id, r.display_name, r.personnel_code
      from public.direct_entry_app_users u
      cross join lateral (
        select count(*)::int as link_count,
               count(*) filter (where l.verified)::int as verified_link_count,
               (array_agg(l.recruiter_id order by l.link_id)
                 filter (where l.verified))[1] as recruiter_id
          from public.direct_entry_app_user_recruiter_links l
         where l.app_user_id = u.app_user_id
           and l.is_current
      ) links
      join public.recruiters r on r.recruiter_id = links.recruiter_id
      cross join lateral (
        select count(*)::int as provider_count,
               count(*) filter (
                 where m.provider_type = 'hrp' and m.vendor_id is null
               )::int as hrp_count
          from public.recruiter_provider_memberships m
         where m.recruiter_id = r.recruiter_id
           and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today)
      ) providers
      cross join lateral (
        select count(*)::int as membership_count,
               count(*) filter (where m.team_id = p_team_id)::int as target_count
          from public.recruiter_team_memberships m
         where m.recruiter_id = r.recruiter_id
           and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today)
      ) memberships
     where u.enabled
       and r.active
       and links.link_count = 1
       and links.verified_link_count = 1
       and providers.provider_count = 1
       and providers.hrp_count = 1
       and memberships.membership_count = 1
       and memberships.target_count = 1
       and not exists (
         select 1 from public.direct_entry_team_leader_assignments a
          where a.leader_app_user_id = u.app_user_id
            and (
              public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today)
              or (a.valid_from > v_today and (a.valid_to is null or a.valid_to > a.valid_from))
            )
       )
       and (
         coalesce(u.authz_managed, false)
         or not exists (
           select 1 from public.direct_entry_scope_grants s
            where s.app_user_id = u.app_user_id
              and s.scope_kind = 'team'
              and (
                public.direct_entry__internal_team_scope_grant_effective(s.grant_id, v_today)
                or (s.valid_from > v_today and (s.valid_to is null or s.valid_to > s.valid_from))
              )
         )
       )
       and (
         coalesce(u.authz_managed, false)
         or not exists (
           select 1 from public.direct_entry_capability_grants g
            where g.app_user_id = u.app_user_id
              and g.capability = 'team_manager_assign'
              and (
                public.direct_entry__internal_capability_grant_effective(g.grant_id, v_today)
                or (g.valid_from > v_today and (g.valid_to is null or g.valid_to > g.valid_from))
              )
         )
       )
  ), filtered as (
    select * from eligible
     where v_search is null
        or display_name ilike '%' || v_search || '%'
        or coalesce(personnel_code, '') ilike '%' || v_search || '%'
  ), page_rows as (
    select * from filtered
     order by display_name, app_user_id
     limit v_page_size offset (v_page - 1) * v_page_size
  )
  select (select count(*)::int from filtered),
         coalesce((
           select jsonb_agg(jsonb_build_object(
             'app_user_id', app_user_id,
             'display_name', display_name,
             'personnel_code', personnel_code
           ) order by display_name, app_user_id)
             from page_rows
         ), '[]'::jsonb)
    into v_total, v_candidates;

  return jsonb_build_object(
    'authorization_date', v_today,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'candidates', v_candidates
  );
end;
$function$;

revoke all on function public.direct_entry_list_team_leader_candidates(uuid, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_team_leader_candidates(uuid, uuid, uuid, text, integer, integer)
  to service_role;

-- =============================================================================
-- 2. direct_entry_apply_team_leader_mutation
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
  v_target_authz_managed boolean := false;
  v_old_authz_managed boolean := false;
  v_prev_authz_managed boolean := false;
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
  v_now timestamptz;
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
     and public.direct_entry__internal_team_scope_grant_effective(s.grant_id, v_today)
     and exists (
       select 1
         from public.direct_entry_app_users u
        where u.app_user_id = s.app_user_id
          and not coalesce(u.authz_managed, false)
     );

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
         from public.direct_entry_app_users u
        where u.app_user_id = g.app_user_id
          and not coalesce(u.authz_managed, false)
     )
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
    select coalesce(u.authz_managed, false)
      into v_old_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = v_old.leader_app_user_id;
    v_old_authz_managed := coalesce(v_old_authz_managed, false);
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
    select u.enabled, coalesce(u.authz_managed, false)
      into v_candidate_user_enabled, v_target_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = p_target_leader_app_user_id;
    if not found or not coalesce(v_candidate_user_enabled, false) then
      raise exception 'target leader account is not enabled' using errcode = '42501';
    end if;
    v_target_authz_managed := coalesce(v_target_authz_managed, false);

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

    -- Cross-domain s2.3 guard under full locks (reject 23514 if mapped to non-RECRUITMENT / INACTIVE / Source C)
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

    if not v_target_authz_managed then
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
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, v_idempotency_action, p_idempotency_key, v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_old_count = 1 and not v_old_authz_managed then
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
    select coalesce(u.authz_managed, false)
      into v_prev_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = v_previous.leader_app_user_id;
    v_prev_authz_managed := coalesce(v_prev_authz_managed, false);

    if not v_prev_authz_managed then
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
    end if;

    select (array_agg(l.recruiter_id order by l.link_id) filter (where l.verified))[1]
      into v_restore_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = v_previous.leader_app_user_id
       and l.is_current;

    if v_team.active
       and (
         v_prev_authz_managed
         or (v_prev_scope_grant_count = 1 and v_prev_capability_grant_count = 1)
       )
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
       and (
         v_prev_authz_managed
         or (
           not exists (
             select 1
               from public.direct_entry_scope_grants s
              where s.app_user_id = v_previous.leader_app_user_id
                and s.scope_kind = 'team'
                and s.grant_id is distinct from v_scope_grant_id
                and s.grant_id is distinct from v_prev_scope_grant_id
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
                and g.grant_id is distinct from v_capability_grant_id
                and g.grant_id is distinct from v_prev_capability_grant_id
                and (
                  g.is_current
                  or (
                    (g.valid_to is null or g.valid_to > g.valid_from)
                    and daterange(g.valid_from, g.valid_to, '[)')
                        && daterange(v_previous.valid_from, null, '[)')
                  )
                )
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

    if not v_old_authz_managed then
      update public.direct_entry_scope_grants
         set valid_to = p_effective_date,
             is_current = (p_effective_date > valid_from and valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
             suspended_by_account_disable = false
       where grant_id = v_scope_grant_id;
    end if;

    update public.direct_entry_team_leader_assignments
       set valid_to = p_effective_date,
           is_current = (p_effective_date > v_old.valid_from and v_old.valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
           suspended_by_account_disable = false
     where assignment_id = v_old.assignment_id;

    if not v_old_authz_managed then
      update public.direct_entry_capability_grants
         set valid_to = p_effective_date,
             is_current = (p_effective_date > valid_from and valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
             suspended_by_account_disable = false
       where grant_id = v_capability_grant_id;
    else
      v_now := pg_catalog.clock_timestamp();

      update public.direct_entry_scope_grants s
         set valid_to = p_effective_date,
             is_current = (p_effective_date > s.valid_from and s.valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
             suspended_by_account_disable = false
       where s.app_user_id = v_old.leader_app_user_id
         and s.scope_kind = 'team'
         and s.team_id = p_team_id
         and s.valid_from <= v_old.valid_from
         and s.valid_to is not distinct from v_old.valid_to
         and (s.valid_to is null or s.valid_to > s.valid_from);

      update public.direct_entry_capability_grants g
         set valid_to = p_effective_date,
             is_current = (p_effective_date > g.valid_from and g.valid_from <= v_today and v_today < p_effective_date and exists (select 1 from public.direct_entry_app_users u where u.app_user_id = v_old.leader_app_user_id and u.enabled)),
             suspended_by_account_disable = false
       where g.app_user_id = v_old.leader_app_user_id
         and g.capability = 'team_manager_assign'
         and g.valid_from = v_old.valid_from
         and g.valid_to is not distinct from v_old.valid_to
         and (g.valid_to is null or g.valid_to > g.valid_from)
         and not exists (
           select 1
             from public.authz_user_group_members m
             join public.authz_user_groups grp on grp.group_id = m.group_id and grp.active = true
             join public.organization_departments dept on dept.department_id = grp.department_id and dept.is_active = true
             left join public.teams t on t.team_id = grp.team_id and t.active = true and t.code <> '__system_vendor__'
             join public.authz_user_group_capabilities gc on gc.group_id = grp.group_id and gc.ended_at is null and gc.started_at <= v_now
            where m.app_user_id = g.app_user_id
              and m.ended_at is null
              and m.started_at <= v_now
              and (grp.team_id is null or t.team_id is not null)
              and gc.capability = 'team_manager_assign'
         );
    end if;
  end if;

  if v_restore then
    if not v_prev_authz_managed then
      update public.direct_entry_scope_grants
         set valid_to = null,
             is_current = (valid_from <= v_today),
             suspended_by_account_disable = false
       where grant_id = v_prev_scope_grant_id;
    end if;

    update public.direct_entry_team_leader_assignments
       set valid_to = null,
           is_current = (v_previous.valid_from <= v_today),
           suspended_by_account_disable = false
     where assignment_id = v_previous.assignment_id;

    if not v_prev_authz_managed then
      update public.direct_entry_capability_grants
         set valid_to = null,
             is_current = (valid_from <= v_today),
             suspended_by_account_disable = false
       where grant_id = v_prev_capability_grant_id;
    end if;
  end if;

  if p_operation = 'designate' then
    if not v_target_authz_managed then
      insert into public.direct_entry_scope_grants
        (app_user_id, scope_kind, team_id, valid_from, is_current, suspended_by_account_disable)
      values
        (p_target_leader_app_user_id, 'team', p_team_id, p_effective_date, (p_effective_date <= v_today), false);
    end if;

    insert into public.direct_entry_team_leader_assignments
      (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current, suspended_by_account_disable)
    values
      (p_team_id, p_target_leader_app_user_id, v_recruiter_id, p_effective_date, (p_effective_date <= v_today), false)
    returning * into v_new;

    if not v_target_authz_managed then
      insert into public.direct_entry_capability_grants
        (app_user_id, capability, valid_from, is_current, suspended_by_account_disable)
      values
        (p_target_leader_app_user_id, 'team_manager_assign', p_effective_date, (p_effective_date <= v_today), false);
    end if;

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

    if not v_target_authz_managed then
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
    end if;

    if v_old_count = 1 then
      select count(*)::int into v_post_outgoing_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.team_id = p_team_id
         and a.leader_app_user_id = v_old.leader_app_user_id
         and a.valid_from <= p_effective_date
         and (a.valid_to is null or p_effective_date < a.valid_to)
         and (a.valid_to is null or a.valid_to > a.valid_from);
      select count(*)::int into v_post_closed_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.assignment_id = v_old.assignment_id
         and a.valid_to = p_effective_date;
      if v_post_outgoing_assignment_count <> 0
         or v_post_closed_assignment_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;

      if not v_old_authz_managed then
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
        select count(*)::int into v_post_closed_scope_count
          from public.direct_entry_scope_grants s
         where s.grant_id = v_scope_grant_id and s.valid_to = p_effective_date;
        select count(*)::int into v_post_closed_capability_count
          from public.direct_entry_capability_grants g
         where g.grant_id = v_capability_grant_id and g.valid_to = p_effective_date;
        if v_post_outgoing_scope_count <> 0
           or v_post_outgoing_capability_count <> 0
           or v_post_closed_scope_count <> 1
           or v_post_closed_capability_count <> 1 then
          raise exception 'team leader mutation postcondition failed' using errcode = '55000';
        end if;
      end if;
    end if;
  else
    select count(*)::int into v_post_team_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.team_id = p_team_id
       and a.valid_from <= p_effective_date
       and (a.valid_to is null or p_effective_date < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from);
    select count(*)::int into v_post_closed_assignment_count
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_old.assignment_id
       and a.valid_to = p_effective_date;
    if v_post_closed_assignment_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;

    if not v_old_authz_managed then
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
      select count(*)::int into v_post_closed_scope_count
        from public.direct_entry_scope_grants s
       where s.grant_id = v_scope_grant_id and s.valid_to = p_effective_date;
      select count(*)::int into v_post_closed_capability_count
        from public.direct_entry_capability_grants g
       where g.grant_id = v_capability_grant_id and g.valid_to = p_effective_date;
      if v_post_outgoing_scope_count <> 0
         or v_post_outgoing_capability_count <> 0
         or v_post_closed_scope_count <> 1
         or v_post_closed_capability_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;
    end if;

    if v_restore then
      select count(*)::int into v_post_restored_assignment_count
        from public.direct_entry_team_leader_assignments a
       where a.assignment_id = v_previous.assignment_id
         and a.valid_to is null
         and a.is_current = (v_previous.valid_from <= v_today);
      if v_post_team_assignment_count <> 1
         or v_post_restored_assignment_count <> 1 then
        raise exception 'team leader mutation postcondition failed' using errcode = '55000';
      end if;

      if not v_prev_authz_managed then
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
        if v_post_restored_scope_count <> 1
           or v_post_restored_capability_count <> 1 then
          raise exception 'team leader mutation postcondition failed' using errcode = '55000';
        end if;
      end if;
    else
      if v_post_team_assignment_count <> 0 then
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

revoke all on function public.direct_entry_apply_team_leader_mutation(
  uuid, uuid, uuid, uuid, date, integer, text, text, text, text
) from public, anon, authenticated, service_role;

-- =============================================================================
-- 3. work_report_sync_team_leader_capabilities
-- =============================================================================

create or replace function public.work_report_sync_team_leader_capabilities()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_capability text;
  v_grant_id uuid;
  v_grant_from date;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_lock_key text;
  v_leader_ids uuid[];
  v_leader_authz_managed boolean := false;
begin
  v_leader_ids := array_remove(array[
    case when tg_op = 'UPDATE' then old.leader_app_user_id end,
    new.leader_app_user_id
  ]::uuid[], null);

  if new.is_current or (
    tg_op = 'UPDATE' and (
      (old.is_current and not new.is_current)
      or (new.valid_to is not null and old.valid_to is distinct from new.valid_to)
    )
  ) then
    perform g.grant_id
      from public.direct_entry_capability_grants g
     where g.app_user_id = any(v_leader_ids)
       and (
         g.capability in ('report_analytics_view', 'report_assign', 'report_review', 'report_view')
         or g.grant_id in (
           select x.capability_grant_id
             from public.work_report_team_leader_capability_grants x
            where x.leader_assignment_id = coalesce(new.assignment_id, case when tg_op = 'UPDATE' then old.assignment_id end)
         )
       )
     order by g.grant_id asc
     for update;

    for v_lock_key in
      select distinct 'capability:' || uid::text || ':' || cap as k
        from unnest(v_leader_ids) as uid
        cross join unnest(array[
          'report_analytics_view',
          'report_assign',
          'report_review',
          'report_view'
        ]::text[]) as cap
       order by k asc
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;
  end if;

  if new.is_current then
    if tg_op = 'UPDATE'
       and old.valid_to is null
       and new.valid_to is not null
       and new.valid_to > new.valid_from then
      update public.direct_entry_capability_grants g
         set valid_to = greatest(new.valid_to, g.valid_from)
        from public.work_report_team_leader_capability_grants x
       where x.leader_assignment_id = new.assignment_id
         and x.capability_grant_id = g.grant_id
         and g.valid_to is null
         and not exists (
           select 1
             from public.authz_user_group_members m
             join public.authz_user_groups grp on grp.group_id = m.group_id and grp.active = true
             join public.organization_departments dept on dept.department_id = grp.department_id and dept.is_active = true
             left join public.teams t on t.team_id = grp.team_id and t.active = true and t.code <> '__system_vendor__'
             join public.authz_user_group_capabilities gc on gc.group_id = grp.group_id and gc.ended_at is null and gc.started_at <= v_now
            where m.app_user_id = g.app_user_id
              and m.ended_at is null
              and m.started_at <= v_now
              and (grp.team_id is null or t.team_id is not null)
              and gc.capability = g.capability
         );
    elsif tg_op = 'UPDATE'
       and old.valid_to is not null
       and old.valid_to > old.valid_from
       and new.valid_to is null then
      update public.direct_entry_capability_grants g
         set valid_to = null,
             is_current = true,
             suspended_by_account_disable = false
        from public.work_report_team_leader_capability_grants x
       where x.leader_assignment_id = new.assignment_id
         and x.capability_grant_id = g.grant_id
         and g.valid_to = old.valid_to
         and g.valid_to > g.valid_from
         and not exists (
           select 1
             from public.direct_entry_capability_grants other
            where other.app_user_id = g.app_user_id
              and other.capability = g.capability
              and other.grant_id <> g.grant_id
              and (
                other.is_current
                or (
                  (other.valid_to is null or other.valid_to > other.valid_from)
                  and daterange(other.valid_from, other.valid_to, '[)')
                      && daterange(g.valid_from, null, '[)')
                )
              )
         );
    end if;

    update public.direct_entry_capability_grants g
       set is_current = true,
           suspended_by_account_disable = false
      from public.work_report_team_leader_capability_grants x
     where x.leader_assignment_id = new.assignment_id
       and x.capability_grant_id = g.grant_id
       and not g.is_current
       and g.valid_to is null
       and g.valid_from <= public.direct_entry_authorization_date()
       and not exists (
         select 1
           from public.direct_entry_capability_grants other
          where other.app_user_id = g.app_user_id
            and other.capability = g.capability
            and other.grant_id <> g.grant_id
            and other.is_current
       );

    select coalesce(u.authz_managed, false)
      into v_leader_authz_managed
      from public.direct_entry_app_users u
     where u.app_user_id = new.leader_app_user_id;
    v_leader_authz_managed := coalesce(v_leader_authz_managed, false);

    if not v_leader_authz_managed then
      foreach v_capability in array array['report_view', 'report_analytics_view', 'report_assign', 'report_review'] loop
        if not exists (
          select 1 from public.direct_entry_capability_grants g
           where g.app_user_id = new.leader_app_user_id
             and g.capability = v_capability
             and g.is_current
        ) then
          if exists (
            select 1 from public.direct_entry_capability_grants g
             where g.app_user_id = new.leader_app_user_id
               and g.capability = v_capability
               and not g.is_current
               and g.valid_to is null
          ) then
            perform set_config('direct_entry.team_leader_marker', 'on', true);
            update public.direct_entry_capability_grants g
               set valid_to = greatest(new.valid_from, g.valid_from),
                   suspended_by_account_disable = false
             where g.app_user_id = new.leader_app_user_id
               and g.capability = v_capability
               and not g.is_current
               and g.valid_to is null;
          end if;

          select greatest(new.valid_from, coalesce(max(g.valid_to), new.valid_from))
            into v_grant_from
            from public.direct_entry_capability_grants g
           where g.app_user_id = new.leader_app_user_id
             and g.capability = v_capability
             and not g.is_current
             and g.valid_to is not null
             and g.valid_to > g.valid_from
             and daterange(g.valid_from, g.valid_to, '[)') && daterange(new.valid_from, null, '[)');

          insert into public.direct_entry_capability_grants
            (app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable)
          values (new.leader_app_user_id, v_capability, v_grant_from, null, true, false)
          returning grant_id into v_grant_id;

          insert into public.work_report_team_leader_capability_grants
            (leader_assignment_id, capability, capability_grant_id)
          values (new.assignment_id, v_capability, v_grant_id)
          on conflict (leader_assignment_id, capability) do update
            set capability_grant_id = excluded.capability_grant_id;
        end if;
      end loop;
    end if;
  elsif tg_op = 'UPDATE' and old.is_current and not new.is_current and new.valid_to is null and new.suspended_by_account_disable then
    update public.direct_entry_capability_grants g
       set is_current = false,
           suspended_by_account_disable = true
      from public.work_report_team_leader_capability_grants x
     where x.leader_assignment_id = old.assignment_id
       and x.capability_grant_id = g.grant_id
       and g.is_current = true
       and g.valid_to is null;
  elsif tg_op = 'UPDATE' and (
    (old.is_current and not new.is_current and not new.suspended_by_account_disable)
    or (new.valid_to is not null and old.valid_to is distinct from new.valid_to)
  ) then
    perform set_config('direct_entry.team_leader_marker', 'on', true);
    update public.direct_entry_capability_grants g
       set is_current = false,
           suspended_by_account_disable = false,
           valid_to = greatest(coalesce(new.valid_to, g.valid_from), g.valid_from)
      from public.work_report_team_leader_capability_grants x
     where x.leader_assignment_id = old.assignment_id
       and x.capability_grant_id = g.grant_id
       and (g.is_current or g.valid_to is null)
       and not exists (
         select 1
           from public.authz_user_group_members m
           join public.authz_user_groups grp on grp.group_id = m.group_id and grp.active = true
           join public.organization_departments dept on dept.department_id = grp.department_id and dept.is_active = true
           left join public.teams t on t.team_id = grp.team_id and t.active = true and t.code <> '__system_vendor__'
           join public.authz_user_group_capabilities gc on gc.group_id = grp.group_id and gc.ended_at is null and gc.started_at <= v_now
          where m.app_user_id = g.app_user_id
            and m.ended_at is null
            and m.started_at <= v_now
            and (grp.team_id is null or t.team_id is not null)
            and gc.capability = g.capability
       );
  end if;
  return new;
end;
$function$;

revoke all on function public.work_report_sync_team_leader_capabilities()
  from public, anon, authenticated, service_role;

-- =============================================================================
-- 4. Postcheck: ACLs & active triggers
-- =============================================================================

do $wp10_7_3b_postcheck$
declare
  v_service_sig text := 'public.direct_entry_list_team_leader_candidates(uuid, uuid, uuid, text, integer, integer)';
  v_internal_sigs text[] := array[
    'public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text)',
    'public.work_report_sync_team_leader_capabilities()'
  ];
  v_sig text;
  v_oid oid;
  v_rec record;
  v_public_exec boolean := false;
  v_trg record;
begin
  v_oid := pg_catalog.to_regprocedure(v_service_sig);
  if v_oid is null then
    raise exception 'WP10-7-3B postcheck failed: missing service RPC %', v_service_sig
      using errcode = '55000';
  end if;

  select p.prosecdef, p.proconfig, p.proowner, p.proacl
    into v_rec
    from pg_catalog.pg_proc p
   where p.oid = v_oid;

  if not coalesce(v_rec.prosecdef, false)
     or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
    raise exception 'WP10-7-3B postcheck failed: service RPC % missing SECURITY DEFINER or search_path', v_service_sig
      using errcode = '55000';
  end if;

  select exists (
    select 1
      from pg_catalog.aclexplode(coalesce(v_rec.proacl, pg_catalog.acldefault('f', v_rec.proowner))) a
     where a.grantee = 0
       and a.privilege_type = 'EXECUTE'
  ) into v_public_exec;

  if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
     or not pg_catalog.has_function_privilege(v_rec.proowner, v_oid, 'EXECUTE')
     or v_public_exec
     or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception 'WP10-7-3B postcheck failed: invalid EXECUTE ACL on service RPC %', v_service_sig
      using errcode = '55000';
  end if;

  foreach v_sig in array v_internal_sigs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-7-3B postcheck failed: missing internal function %', v_sig
        using errcode = '55000';
    end if;

    select p.prosecdef, p.proconfig, p.proowner, p.proacl
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'WP10-7-3B postcheck failed: internal function % missing SECURITY DEFINER or search_path', v_sig
        using errcode = '55000';
    end if;

    select exists (
      select 1
        from pg_catalog.aclexplode(coalesce(v_rec.proacl, pg_catalog.acldefault('f', v_rec.proowner))) a
       where a.grantee = 0
         and a.privilege_type = 'EXECUTE'
    ) into v_public_exec;

    if v_public_exec
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege(v_rec.proowner, v_oid, 'EXECUTE') then
      raise exception 'WP10-7-3B postcheck failed: invalid EXECUTE ACL on internal function %', v_sig
        using errcode = '55000';
    end if;
  end loop;

  select t.tgenabled, t.tgfoid
    into v_trg
    from pg_catalog.pg_trigger t
   where t.tgrelid = 'public.direct_entry_team_leader_assignments'::pg_catalog.regclass
     and t.tgname = 'work_report_sync_team_leader_capabilities'
     and not t.tgisinternal;
  if not found
     or v_trg.tgenabled not in ('O', 'A')
     or v_trg.tgfoid <> 'public.work_report_sync_team_leader_capabilities()'::pg_catalog.regprocedure then
    raise exception 'WP10-7-3B postcheck failed: work_report_sync_team_leader_capabilities trigger missing or inactive'
      using errcode = '55000';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.direct_entry_team_leader_assignments'::pg_catalog.regclass
       and t.tgname = 'direct_entry_team_leader_assignment_marker_guard'
       and not t.tgisinternal
       and t.tgenabled in ('O', 'A')
  ) or not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.direct_entry_scope_grants'::pg_catalog.regclass
       and t.tgname = 'direct_entry_scope_grant_marker_guard'
       and not t.tgisinternal
       and t.tgenabled in ('O', 'A')
  ) or not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.direct_entry_scope_grants'::pg_catalog.regclass
       and t.tgname = 'direct_entry_scope_grant_no_overlap'
       and not t.tgisinternal
       and t.tgenabled in ('O', 'A')
  ) or not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.direct_entry_capability_grants'::pg_catalog.regclass
       and t.tgname = 'direct_entry_capability_grant_marker_guard'
       and not t.tgisinternal
       and t.tgenabled in ('O', 'A')
  ) or not exists (
    select 1 from pg_catalog.pg_trigger t
     where t.tgrelid = 'public.direct_entry_capability_grants'::pg_catalog.regclass
       and t.tgname = 'direct_entry_capability_grant_no_overlap'
       and not t.tgisinternal
       and t.tgenabled in ('O', 'A')
  ) then
    raise exception 'WP10-7-3B postcheck failed: required guard trigger missing or inactive'
      using errcode = '55000';
  end if;
end
$wp10_7_3b_postcheck$;

commit;
