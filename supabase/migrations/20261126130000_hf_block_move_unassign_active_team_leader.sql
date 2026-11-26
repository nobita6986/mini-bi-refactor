-- =============================================================================
-- Hotfix: Block direct_entry_move_team_membership and
-- direct_entry_unassign_team_membership while recruiter holds an active or
-- restorable team leader assignment on a different team.
--
-- Scope (100% forward migration; +0 net functions; zero historical edits):
--   1. public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)
--      - Preserves 8-arg signature, SECURITY DEFINER, search_path, pre-lock
--        idempotency replay, Phase 1 discovery, Phase 2 canonical lock order
--        (P -> D -> M -> U -> idempotency_begin -> R -> T), Phase 3 post-lock
--        completeness guard, and §2.3 org check.
--      - Extends Phase 1 & Phase 3 TL discovery with
--        direct_entry__internal_team_leader_assignment_effective(a.assignment_id, direct_entry_authorization_date()).
--      - Blocks move with PT409 ('recruiter holds active or restorable team leader assignment')
--        before direct_entry_reason or any writes when recruiter/user holds an
--        active, effective, or suspended-restorable TL assignment on another team.
--   2. public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text)
--      - Preserves 7-arg signature, SECURITY DEFINER, search_path.
--      - Upgrades to pre-lock idempotency replay + Phase 1 unlocked discovery +
--        Phase 2 canonical lock order (P -> D -> M -> U -> idempotency_begin ->
--        Tier 3 R via direct_entry_lock_membership_close_target, and T FOR SHARE
--        via direct_entry_assert_membership_target_team when v_restore = true) +
--        Phase 3 post-lock completeness guard (PT409 on drift).
--      - Keeps direct_entry_lock_membership_close_target and omits §2.3 org check
--        so inactive recruiters/teams without active/restorable TL remain closable.
--      - Blocks unassign with PT409 ('recruiter holds active or restorable team leader assignment')
--        before direct_entry_reason or any writes when recruiter/user holds an
--        active, effective, or suspended-restorable TL assignment on a team
--        distinct from the restore target (null when not restoring).
--   3. Owner alignment, strict service_role-only EXECUTE ACL, and DO self-check.
-- =============================================================================

begin;

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
  v_today date := public.direct_entry_authorization_date();
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
         and (
           a.is_current = true
           or a.suspended_by_account_disable = true
           or public.direct_entry__internal_team_leader_assignment_effective(
             a.assignment_id, public.direct_entry_authorization_date()
           )
         )
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

  p_valid_from := coalesce(p_valid_from, v_today);
  if p_valid_from > v_today then
    raise exception 'future team memberships require explicit activation' using errcode = '22023';
  end if;
  if p_valid_from < v_today then
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
       and (
         a.is_current = true
         or a.suspended_by_account_disable = true
         or public.direct_entry__internal_team_leader_assignment_effective(
           a.assignment_id, public.direct_entry_authorization_date()
         )
       )
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
       and v_today < m.valid_to
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

  -- Block moving a recruiter who holds an active or restorable team leader assignment
  if exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where (
       a.leader_recruiter_id = p_recruiter_id
       or a.leader_app_user_id = any(v_locked_user_ids)
     )
       and a.team_id is distinct from p_team_id
       and (
         (
           a.is_current = true
           and (
             a.valid_to is null
             or (a.valid_to > a.valid_from and v_today < a.valid_to)
           )
         )
         or public.direct_entry__internal_team_leader_assignment_effective(
           a.assignment_id, v_today
         )
         or (
           a.suspended_by_account_disable = true
           and a.valid_to is null
           and a.valid_from <= v_today
           and coalesce(v_subject.active, false)
           and public.org_department__internal_recruiter_org_allows_recruitment_team(
             a.leader_recruiter_id,
             a.leader_app_user_id,
             pg_catalog.clock_timestamp()
           )
           and exists (
             select 1
               from public.teams tl_team
              where tl_team.team_id = a.team_id
                and tl_team.active = true
                and tl_team.code <> '__system_vendor__'
           )
           and exists (
             select 1
               from public.recruiters tl_rec
              where tl_rec.recruiter_id = a.leader_recruiter_id
                and tl_rec.active = true
           )
           and (
             select count(*)::int
               from public.recruiter_provider_memberships rpm
              where rpm.recruiter_id = a.leader_recruiter_id
                and rpm.provider_type = 'hrp'
                and rpm.vendor_id is null
                and public.direct_entry__internal_recruiter_provider_membership_effective(rpm.membership_id, v_today)
           ) = 1
           and (
             select count(*)::int
               from public.recruiter_team_memberships rtm
              where rtm.recruiter_id = a.leader_recruiter_id
                and rtm.team_id = a.team_id
                and public.direct_entry__internal_recruiter_team_membership_effective(rtm.membership_id, v_today)
           ) = 1
           and exists (
             select 1
               from public.direct_entry_app_user_recruiter_links rl
              where rl.app_user_id = a.leader_app_user_id
                and rl.recruiter_id = a.leader_recruiter_id
                and rl.verified = true
                and (
                  rl.is_current = true
                  or (
                    rl.suspended_by_account_disable = true
                    and rl.valid_from <= v_today
                    and (rl.valid_to is null or rl.valid_to > v_today)
                    and not exists (
                      select 1
                        from public.direct_entry_app_user_recruiter_links other_rl
                       where other_rl.link_id <> rl.link_id
                         and other_rl.is_current = true
                         and (
                           other_rl.app_user_id = a.leader_app_user_id
                           or (
                             other_rl.verified = true
                             and other_rl.recruiter_id = a.leader_recruiter_id
                           )
                         )
                    )
                  )
                )
           )
           and not exists (
             select 1
               from public.direct_entry_team_leader_assignments other
              where other.assignment_id <> a.assignment_id
                and (
                  other.team_id = a.team_id
                  or other.leader_app_user_id = a.leader_app_user_id
                )
                and (
                  other.is_current = true
                  or (
                    (other.valid_to is null or other.valid_to > other.valid_from)
                    and daterange(other.valid_from, other.valid_to, '[)')
                        && daterange(v_today, null, '[)')
                  )
                )
           )
         )
       )
  ) then
    raise exception 'recruiter holds active or restorable team leader assignment'
      using errcode = 'PT409';
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
     and valid_to <= v_today;

  update public.recruiter_team_memberships set valid_to = p_valid_from, is_current = false
   where membership_id = v_open.membership_id;

  insert into public.recruiter_team_memberships (recruiter_id, team_id, valid_from, valid_to, is_current)
  values (p_recruiter_id, p_team_id, p_valid_from, null, true)
  returning * into v_membership;

  v_changed := array['team_id', 'valid_to'];
  if p_valid_from = v_open.valid_from then
    v_changed := array_append(v_changed, 'cancellation_marker');
  end if;
  if p_valid_from < v_today then
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

create or replace function public.direct_entry_unassign_team_membership(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_recruiter_id uuid,
  p_valid_to date,
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
  v_today date := public.direct_entry_authorization_date();
  v_authority text;
  v_reason_id uuid;
  v_subject public.recruiters;
  v_open public.recruiter_team_memberships;
  v_previous public.recruiter_team_memberships;
  v_origin public.direct_entry_team_membership_revisions;
  v_restore boolean := false;
  v_membership public.recruiter_team_memberships;
  v_recruiter_version integer;
  v_revision_id uuid;
  v_change text;
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

  if p_recruiter_id is null then
    raise exception 'recruiter required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'recruiter_id', p_recruiter_id,
    'valid_to', p_valid_to,
    'expected_version', p_expected_version
  ));
  -- Pre-lock unlocked replay check only: avoid FK FOR KEY SHARE on U_actor before Tier 1/2
  select i.request_hash, i.result
    into v_prior_hash, v_prior
    from public.direct_entry_rpc_idempotency i
   where i.app_user_id = p_app_user_id
     and i.action = 'team_membership_unassign'
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
         and (
           a.is_current = true
           or a.suspended_by_account_disable = true
           or public.direct_entry__internal_team_leader_assignment_effective(
             a.assignment_id, public.direct_entry_authorization_date()
           )
         )
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

  -- Phase 2: Canonical Lock Order P -> D -> M -> U -> idempotency_begin -> R (-> T on restore)
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
    p_app_user_id, 'team_membership_unassign', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  p_valid_to := coalesce(p_valid_to, v_today);
  if p_valid_to > v_today then
    raise exception 'future team memberships require explicit activation' using errcode = '22023';
  end if;
  if p_valid_to < v_today then
    raise exception 'past team memberships are not allowed' using errcode = '22023';
  end if;

  -- Close-only lock (Tier 3 R): revocation must stay possible for an inactive
  -- recruiter or inactive team when no active/restorable TL assignment exists.
  v_subject := public.direct_entry_lock_membership_close_target(p_recruiter_id, p_expected_version);

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
       and (
         a.is_current = true
         or a.suspended_by_account_disable = true
         or public.direct_entry__internal_team_leader_assignment_effective(
           a.assignment_id, public.direct_entry_authorization_date()
         )
       )
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

  select m.* into v_open
    from public.recruiter_team_memberships m
   where m.recruiter_id = p_recruiter_id
     and (m.valid_to is null or (
       m.valid_from <= p_valid_to and p_valid_to < m.valid_to
       and v_today < m.valid_to
     ))
   order by m.valid_from desc
   limit 1;
  if not found then
    raise exception 'no open membership to unassign' using errcode = '22023';
  end if;
  if p_valid_to < v_open.valid_from then
    raise exception 'unassign date precedes the open membership' using errcode = '22023';
  end if;

  -- Restore only a predecessor closed by the audited MOVE chain at this date.
  -- Cancelling a standalone ASSIGN or an already-effective interval stays close-only.
  if p_valid_to = v_open.valid_from
     and v_today < v_open.valid_from then
    select r.* into v_origin
      from public.direct_entry_team_membership_revisions r
     where r.recruiter_id = p_recruiter_id
       and r.after_snapshot->>'team_id' = v_open.team_id::text
       and r.after_snapshot->>'valid_from' = v_open.valid_from::text
     order by r.version desc limit 1;
    if v_origin.after_snapshot->>'change' = 'MOVE' then
      select m.* into v_previous
        from public.recruiter_team_memberships m
       where m.recruiter_id = p_recruiter_id
         and m.valid_to = v_open.valid_from and m.valid_from < m.valid_to
         and exists (
           select 1 from public.direct_entry_team_membership_revisions r
            where r.recruiter_id = p_recruiter_id and r.version <= v_origin.version
              and r.after_snapshot->>'change' = 'MOVE'
              and r.after_snapshot->>'valid_from' = v_open.valid_from::text
              and r.before_snapshot->>'team_id' = m.team_id::text
              and r.before_snapshot->>'valid_from' = m.valid_from::text
         );
      if found then
        -- Restoration is not a pure revocation: enforce creation guards & lock Tier 4 T after R.
        perform public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
        perform t.team_id from public.teams t where t.team_id = v_previous.team_id for share;
        perform public.direct_entry_assert_membership_target_team(v_previous.team_id);
        v_restore := true;
      end if;
    end if;
  end if;

  -- Block unassigning a recruiter who holds an active or restorable team leader assignment
  if exists (
    select 1
      from public.direct_entry_team_leader_assignments a
     where (
       a.leader_recruiter_id = p_recruiter_id
       or a.leader_app_user_id = any(v_locked_user_ids)
     )
       and a.team_id is distinct from (
         case when v_restore then v_previous.team_id else null end
       )
       and (
         (
           a.is_current = true
           and (
             a.valid_to is null
             or (a.valid_to > a.valid_from and v_today < a.valid_to)
           )
         )
         or public.direct_entry__internal_team_leader_assignment_effective(
           a.assignment_id, v_today
         )
         or (
           a.suspended_by_account_disable = true
           and a.valid_to is null
           and a.valid_from <= v_today
           and coalesce(v_subject.active, false)
           and public.org_department__internal_recruiter_org_allows_recruitment_team(
             a.leader_recruiter_id,
             a.leader_app_user_id,
             pg_catalog.clock_timestamp()
           )
           and exists (
             select 1
               from public.teams tl_team
              where tl_team.team_id = a.team_id
                and tl_team.active = true
                and tl_team.code <> '__system_vendor__'
           )
           and exists (
             select 1
               from public.recruiters tl_rec
              where tl_rec.recruiter_id = a.leader_recruiter_id
                and tl_rec.active = true
           )
           and (
             select count(*)::int
               from public.recruiter_provider_memberships rpm
              where rpm.recruiter_id = a.leader_recruiter_id
                and rpm.provider_type = 'hrp'
                and rpm.vendor_id is null
                and public.direct_entry__internal_recruiter_provider_membership_effective(rpm.membership_id, v_today)
           ) = 1
           and (
             select count(*)::int
               from public.recruiter_team_memberships rtm
              where rtm.recruiter_id = a.leader_recruiter_id
                and rtm.team_id = a.team_id
                and public.direct_entry__internal_recruiter_team_membership_effective(rtm.membership_id, v_today)
           ) = 1
           and exists (
             select 1
               from public.direct_entry_app_user_recruiter_links rl
              where rl.app_user_id = a.leader_app_user_id
                and rl.recruiter_id = a.leader_recruiter_id
                and rl.verified = true
                and (
                  rl.is_current = true
                  or (
                    rl.suspended_by_account_disable = true
                    and rl.valid_from <= v_today
                    and (rl.valid_to is null or rl.valid_to > v_today)
                    and not exists (
                      select 1
                        from public.direct_entry_app_user_recruiter_links other_rl
                       where other_rl.link_id <> rl.link_id
                         and other_rl.is_current = true
                         and (
                           other_rl.app_user_id = a.leader_app_user_id
                           or (
                             other_rl.verified = true
                             and other_rl.recruiter_id = a.leader_recruiter_id
                           )
                         )
                    )
                  )
                )
           )
           and not exists (
             select 1
               from public.direct_entry_team_leader_assignments other
              where other.assignment_id <> a.assignment_id
                and (
                  other.team_id = a.team_id
                  or other.leader_app_user_id = a.leader_app_user_id
                )
                and (
                  other.is_current = true
                  or (
                    (other.valid_to is null or other.valid_to > other.valid_from)
                    and daterange(other.valid_from, other.valid_to, '[)')
                        && daterange(v_today, null, '[)')
                  )
                )
           )
         )
       )
  ) then
    raise exception 'recruiter holds active or restorable team leader assignment'
      using errcode = 'PT409';
  end if;

  if public.direct_entry_membership_attribution_conflict(
    p_recruiter_id, p_valid_to,
    case when v_restore then v_previous.team_id else null end
  ) then
    raise exception 'membership change would rewrite worker attribution' using errcode = '23514';
  end if;

  v_change := case when p_valid_to = v_open.valid_from then 'CANCEL' else 'UNASSIGN' end;
  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  if v_change = 'CANCEL' then
    perform set_config('direct_entry.membership_cancel_marker', 'on', true);
  end if;

  update public.recruiter_team_memberships set valid_to = p_valid_to, is_current = false
   where membership_id = v_open.membership_id
  returning * into v_membership;

  if v_restore then
    update public.recruiter_team_memberships set valid_to = null
     where membership_id = v_previous.membership_id;
  else
    update public.recruiter_team_memberships set is_current = false
     where recruiter_id = p_recruiter_id
       and is_current
       and valid_to is not null
       and valid_to <= v_today;
  end if;
  v_changed := array['valid_to'];
  if v_restore then
    v_changed := array_append(v_changed, 'previous_membership_restored');
  end if;
  if v_change = 'CANCEL' then
    v_changed := array_append(v_changed, 'cancellation_marker');
  end if;
  if p_valid_to < v_today then
    v_changed := array_append(v_changed, 'backdated');
  end if;

  select b.recruiter_version, b.revision_id
    into v_recruiter_version, v_revision_id
    from public.direct_entry_bump_membership_version(
      p_recruiter_id, p_app_user_id, v_reason_id,
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, v_open.team_id, v_open.valid_from, v_open.valid_to,
        v_subject.version, v_change
      ) || case when v_restore then jsonb_build_object('restored_membership',
        public.direct_entry_team_membership_snapshot(p_recruiter_id, v_previous.team_id,
          v_previous.valid_from, v_previous.valid_to, v_subject.version, 'CANCEL'))
        else '{}'::jsonb end,
      public.direct_entry_team_membership_snapshot(
        p_recruiter_id, v_open.team_id, v_open.valid_from, p_valid_to,
        v_subject.version + 1, v_change
      ) || case when v_restore then jsonb_build_object('restored_membership',
        public.direct_entry_team_membership_snapshot(p_recruiter_id, v_previous.team_id,
          v_previous.valid_from, null, v_subject.version + 1, 'CANCEL'))
        else '{}'::jsonb end
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome,
     reason_id, changed_fields, team_membership_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'team_membership_unassign', v_authority,
     p_recruiter_id::text, 'all', 'APPLIED', v_reason_id, v_changed, v_revision_id);

  v_result := jsonb_build_object(
    'membership_id', v_membership.membership_id,
    'recruiter_id', p_recruiter_id,
    'team_id', v_membership.team_id,
    'valid_from', to_jsonb(v_membership.valid_from),
    'valid_to', to_jsonb(v_membership.valid_to),
    'recruiter_version', v_recruiter_version,
    'revision_id', v_revision_id,
    'change', v_change
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'team_membership_unassign', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_list_team_leaders_suspended(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null,
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
  v_effective_team_id uuid := public.direct_entry_assert_team_leader_read_authority(p_auth_subject, p_app_user_id, p_team_id);
  v_search text;
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_total integer;
  v_leaders jsonb;
begin
  if p_search is not null and length(btrim(p_search)) > 256 then
    raise exception 'invalid team leader search' using errcode = '22023';
  end if;
  v_search := nullif(btrim(coalesce(p_search, '')), '');
  if v_page < 1 or v_page > 1000 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;

  select count(*)::int into v_total
    from public.direct_entry_team_leader_assignments a
    join public.teams t on t.team_id = a.team_id
    join public.recruiters r on r.recruiter_id = a.leader_recruiter_id
   where t.code <> '__system_vendor__'
     and a.suspended_by_account_disable = true
     and not a.is_current
     and a.valid_to is null
     and a.valid_from <= v_today
     and (v_effective_team_id is null or a.team_id = v_effective_team_id)
     and (p_team_id is null or a.team_id = p_team_id)
     and (
       v_search is null
       or t.display_name ilike '%' || v_search || '%'
       or t.code ilike '%' || v_search || '%'
       or r.display_name ilike '%' || v_search || '%'
     );

  select coalesce(jsonb_agg(entry.projection), '[]'::jsonb) into v_leaders
    from (
      select (
        public.direct_entry_team_leader_projection(a, t.display_name, r.display_name)
        || jsonb_build_object('state', 'SUSPENDED')
      ) as projection
        from public.direct_entry_team_leader_assignments a
        join public.teams t on t.team_id = a.team_id
        join public.recruiters r on r.recruiter_id = a.leader_recruiter_id
       where t.code <> '__system_vendor__'
         and a.suspended_by_account_disable = true
         and not a.is_current
         and a.valid_to is null
         and a.valid_from <= v_today
         and (v_effective_team_id is null or a.team_id = v_effective_team_id)
         and (p_team_id is null or a.team_id = p_team_id)
         and (
           v_search is null
           or t.display_name ilike '%' || v_search || '%'
           or t.code ilike '%' || v_search || '%'
           or r.display_name ilike '%' || v_search || '%'
         )
       order by t.display_name, a.assignment_id
       limit v_page_size offset (v_page - 1) * v_page_size
    ) entry;

  return jsonb_build_object(
    'authorization_date', v_today,
    'page', v_page,
    'page_size', v_page_size,
    'total', v_total,
    'leaders', v_leaders
  );
end;
$function$;

revoke all on function public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)
  to service_role;

revoke all on function public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text)
  to service_role;

revoke all on function public.direct_entry_list_team_leaders_suspended(uuid, uuid, uuid, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_team_leaders_suspended(uuid, uuid, uuid, text, integer, integer)
  to service_role;

do $align_and_check_hf_block_move_unassign_tl$
declare
  v_fn_names text[] := array[
    'direct_entry_move_team_membership',
    'direct_entry_unassign_team_membership',
    'direct_entry_list_team_leaders_suspended'
  ];
  v_service_rpcs text[] := array[
    'public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)',
    'public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text)',
    'public.direct_entry_list_team_leaders_suspended(uuid, uuid, uuid, text, integer, integer)'
  ];
  v_guard_rpcs text[] := array[
    'public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text)',
    'public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text)'
  ];
  v_fn_name text;
  v_overloads integer;
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
    raise exception 'HF TL guard alignment failed: base owner missing' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_fn_name in array v_fn_names loop
    select count(*)::integer
      into v_overloads
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = v_fn_name;

    if v_overloads <> 1 then
      raise exception 'HF TL guard check failed: expected single overload for public.%, found %',
        v_fn_name, v_overloads
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'HF TL guard check failed: missing service RPC %', v_sig using errcode = '55000';
    end if;

    select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;

    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_sig);
    execute pg_catalog.format('grant execute on function %s to service_role', v_sig);

    select p.proowner, p.prosecdef, p.proconfig, p.prosrc
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
      raise exception 'HF TL guard check failed: definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege(v_rec.proowner, v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'HF TL guard check failed: RPC ACL invalid on %', v_sig using errcode = '55000';
    end if;

    if v_sig = any(v_guard_rpcs) and (
         v_rec.prosrc !~ 'recruiter holds active or restorable team leader assignment'
         or v_rec.prosrc !~ 'PT409'
         or v_rec.prosrc ~ 'TEAM_LEADER'
       ) then
      raise exception 'HF TL guard check failed: expected TL guard contract missing on %', v_sig using errcode = '55000';
    end if;
  end loop;
end
$align_and_check_hf_block_move_unassign_tl$;

commit;
