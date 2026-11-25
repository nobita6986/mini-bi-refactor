-- =============================================================================
-- WP10-6 Slice 1: Server-Authoritative Immediate Effective Date on Work Report
--                 Assignment Creation (+0 net RPCs; backward-compatible replay)
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. public.work_report_create_assignment(...) &
--      public.work_report_create_group_assignment(...):
--      - Keep exact signatures, parameter types/defaults, SECURITY DEFINER,
--        search_path = pg_catalog, public, and service_role-only EXECUTE ACL.
--      - Compute v_business_date := (pg_catalog.now() at time zone 'Asia/Ho_Chi_Minh')::date
--        ONCE at transaction start (not clock_timestamp()).
--      - Early input guard (before locks/scope/idempotency): allow
--        (p_effective_from is null and p_effective_to is null); reject
--        (p_effective_from is null and p_effective_to is not null) or
--        (p_effective_to is not null and p_effective_to < p_effective_from)
--        with SQLSTATE 22023 WORK_REPORT_ASSIGNMENT_INVALID.
--      - Idempotency hash & replay BEFORE brand-new-write date enforcement:
--        * When p_effective_from is null and p_effective_to is null: hash ONLY
--          stable business fields (excluding effective_from, effective_to, and
--          v_business_date) so retries across midnight return the cached result.
--        * When p_effective_from is not null or p_effective_to is not null:
--          hash using the EXACT pre-migration JSONB keys/values including
--          effective_from and effective_to so pre-migration and prior-day
--          replays return cached results cleanly across midnight.
--        * After direct_entry_idempotency_begin returns NULL (brand-new write),
--          enforce p_effective_to is null and (p_effective_from is null or
--          p_effective_from = v_business_date); otherwise raise 22023
--          WORK_REPORT_ASSIGNMENT_INVALID.
--      - Insert effective_from = v_business_date, effective_to = null and
--        immediately materialize obligations for v_business_date.
--   2. Idempotent owner alignment, REVOKE/GRANT ACLs, overload, SECURITY DEFINER,
--      search_path, and exact ACL verification block.
-- =============================================================================

begin;

create or replace function public.work_report_create_assignment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_target_kind text,
  p_target_user_id uuid,
  p_target_team_id uuid,
  p_target_user_ids uuid[],
  p_frequency text,
  p_is_mandatory boolean,
  p_due_day_offset integer,
  p_due_time_local time without time zone,
  p_exclude_sundays boolean,
  p_effective_from date,
  p_effective_to date,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_business_date date := (pg_catalog.now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_template public.work_report_templates%rowtype;
  v_assignment_id uuid;
  v_scope text;
  v_scope_team_id uuid;
  v_delegation_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_person_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_template_id is null
     or p_target_kind is null
     or p_target_kind not in ('USER', 'TEAM', 'USER_SET')
     or p_frequency is null
     or p_frequency not in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')
     or p_due_day_offset is null
     or p_due_day_offset not between 0 and 31
     or p_due_time_local is null
     or (p_effective_from is null and p_effective_to is not null)
     or (p_effective_to is not null and p_effective_to < p_effective_from)
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;
  if (p_target_kind = 'USER') <> (p_target_user_id is not null and p_target_team_id is null)
     or (p_target_kind = 'TEAM') <> (p_target_team_id is not null and p_target_user_id is null)
     or (p_target_kind = 'USER_SET' and (p_target_user_id is not null or p_target_team_id is not null)) then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;
  if p_target_kind = 'USER_SET' and coalesce(pg_catalog.cardinality(p_target_user_ids), 0) < 1 then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;

  -- Collect user set for strict Tier 1 -> Tier 2 -> Tier 3 locking.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.template_id = p_template_id
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select p_target_user_id as uid
       where p_target_kind = 'USER' and p_target_user_id is not null
      union all
      select x.uid
        from unnest(coalesce(p_target_user_ids, array[]::uuid[])) as x(uid)
       where p_target_kind = 'USER_SET' and x.uid is not null
    ) u_ids
   where uid is not null;

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + active report_assign delegation grantors + target users.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of actor, grantors & target users (serializes against move_team_membership for USER, USER_SET, and delegated TEAM).
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_target_kind = 'TEAM' then
    v_scope_team_id := p_target_team_id;
  elsif p_target_kind = 'USER' then
    v_scope_team_id := public.work_report_resolve_assignment_user_team(p_target_user_id);
  end if;

  select * into v_template from public.work_report_templates where template_id = p_template_id for share;

  -- Tier WR-3 FOR SHARE on active report_assign delegations for this actor + template.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.template_id = p_template_id
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if p_target_kind in ('USER', 'TEAM') then
    select a.acting_scope_kind, a.delegation_id
      into v_scope, v_delegation_id
      from public.work_report__internal_resolve_capability_authority(
        p_app_user_id, 'report_assign', p_template_id, v_scope_team_id
      ) a;
    if v_scope is null then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if p_target_kind = 'USER'
       and not public.work_report__internal_is_eligible_assignee(p_target_user_id) then
      raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
    end if;
  else
    if exists (
      select 1
        from unnest(p_target_user_ids) x(user_id)
       where not exists (
         select 1
           from public.work_report__internal_resolve_capability_authority(
             p_app_user_id, 'report_assign', p_template_id, public.work_report_current_team(x.user_id)
           ) a
       )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if exists (
      select 1
        from unnest(p_target_user_ids) x(user_id)
       where not public.work_report__internal_is_eligible_assignee(x.user_id)
    ) then
      raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
    end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
        or exists (
          select 1
            from public.work_report_delegations d
           where d.delegate_app_user_id = p_app_user_id
             and d.capability = 'report_assign'
             and d.template_id = p_template_id
             and d.scope_kind = 'all'
             and public.work_report__internal_is_delegation_effective(d.delegation_id)
        ) then 'all'
      else 'team'
    end;
  end if;

  if v_template.template_id is null or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;

  if p_effective_from is null and p_effective_to is null then
    v_request_hash := public.direct_entry_payload_hash(pg_catalog.jsonb_build_object(
      'template_id', p_template_id,
      'target_kind', p_target_kind,
      'target_user_id', p_target_user_id,
      'target_team_id', p_target_team_id,
      'target_user_ids', p_target_user_ids,
      'frequency', p_frequency,
      'is_mandatory', p_is_mandatory,
      'due_day_offset', p_due_day_offset,
      'due_time_local', p_due_time_local,
      'exclude_sundays', p_exclude_sundays
    ));
  else
    v_request_hash := public.direct_entry_payload_hash(pg_catalog.jsonb_build_object(
      'template_id', p_template_id,
      'target_kind', p_target_kind,
      'target_user_id', p_target_user_id,
      'target_team_id', p_target_team_id,
      'target_user_ids', p_target_user_ids,
      'frequency', p_frequency,
      'is_mandatory', p_is_mandatory,
      'due_day_offset', p_due_day_offset,
      'due_time_local', p_due_time_local,
      'exclude_sundays', p_exclude_sundays,
      'effective_from', p_effective_from,
      'effective_to', p_effective_to
    ));
  end if;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'work_report_assignment_create', p_idempotency_key, v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if p_effective_to is not null
     or (p_effective_from is not null and p_effective_from <> v_business_date) then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;

  insert into public.work_report_assignments (
    template_id,
    template_version_id,
    target_kind,
    target_user_id,
    target_team_id,
    frequency,
    is_mandatory,
    due_day_offset,
    due_time_local,
    exclude_sundays,
    effective_from,
    effective_to,
    assigned_by_user_id
  )
  values (
    p_template_id,
    v_template.current_published_version_id,
    p_target_kind,
    p_target_user_id,
    p_target_team_id,
    p_frequency,
    coalesce(p_is_mandatory, true),
    p_due_day_offset,
    p_due_time_local,
    coalesce(p_exclude_sundays, false),
    v_business_date,
    null,
    p_app_user_id
  )
  returning assignment_id into v_assignment_id;

  if p_target_kind = 'USER_SET' then
    insert into public.work_report_assignment_targets (assignment_id, target_user_id)
      select v_assignment_id, x
        from (select distinct unnest(p_target_user_ids) x) q;
  end if;

  perform public.work_report__internal_materialize_assignment_for_date(
    v_assignment_id,
    v_business_date
  );

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    scope_team_id,
    template_id,
    outcome,
    metadata_json
  )
  values (
    'ASSIGNMENT_CREATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    case when v_scope = 'team' then v_scope_team_id else null end,
    p_template_id,
    'APPLIED',
    pg_catalog.jsonb_build_object(
      'assignment_id', v_assignment_id,
      'target_kind', p_target_kind,
      'delegation_id', v_delegation_id
    )
  );

  v_result := pg_catalog.jsonb_build_object('assignment_id', v_assignment_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'work_report_assignment_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.work_report_create_assignment(
  uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text
) from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_assignment(
  uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text
) to service_role;

create or replace function public.work_report_create_group_assignment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_target_group_id uuid,
  p_frequency text,
  p_is_mandatory boolean,
  p_due_day_offset integer,
  p_due_time_local time without time zone,
  p_exclude_sundays boolean,
  p_effective_from date,
  p_effective_to date,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_business_date date := (pg_catalog.now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_template public.work_report_templates%rowtype;
  v_group public.work_report_groups%rowtype;
  v_assignment_id uuid;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_person_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_template_id is null
     or p_target_group_id is null
     or p_frequency is null
     or p_frequency not in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')
     or p_due_day_offset is null
     or p_due_day_offset not between 0 and 31
     or p_due_time_local is null
     or (p_effective_from is null and p_effective_to is not null)
     or (p_effective_to is not null and p_effective_to < p_effective_from)
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;

  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.template_id = p_template_id
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select gm.member_user_id as uid
        from public.work_report_group_members gm
       where gm.group_id = p_target_group_id
    ) u_ids
   where uid is not null;

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + active report_assign delegation grantors + group members.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of group members (serializes against move_team_membership).
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  select *
    into v_group
    from public.work_report_groups g
   where g.group_id = p_target_group_id
     for share;

  if not found then
    raise exception 'WORK_REPORT_GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  select *
    into v_template
    from public.work_report_templates t
   where t.template_id = p_template_id
     for share;

  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.template_id = p_template_id
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if not exists (
    select 1
      from public.work_report_group_members gm0
     where gm0.group_id = p_target_group_id
  ) or exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_target_group_id
       and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm.member_user_id, p_template_id)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if not v_group.active then
    raise exception 'WORK_REPORT_GROUP_INACTIVE' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_target_group_id
       and public.work_report__internal_is_eligible_assignee(gm.member_user_id)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  if v_template.template_id is null or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;

  if p_effective_from is null and p_effective_to is null then
    v_request_hash := public.direct_entry_payload_hash(pg_catalog.jsonb_build_object(
      'template_id', p_template_id,
      'target_kind', 'GROUP',
      'target_group_id', p_target_group_id,
      'frequency', p_frequency,
      'is_mandatory', p_is_mandatory,
      'due_day_offset', p_due_day_offset,
      'due_time_local', p_due_time_local,
      'exclude_sundays', p_exclude_sundays
    ));
  else
    v_request_hash := public.direct_entry_payload_hash(pg_catalog.jsonb_build_object(
      'template_id', p_template_id,
      'target_kind', 'GROUP',
      'target_group_id', p_target_group_id,
      'frequency', p_frequency,
      'is_mandatory', p_is_mandatory,
      'due_day_offset', p_due_day_offset,
      'due_time_local', p_due_time_local,
      'exclude_sundays', p_exclude_sundays,
      'effective_from', p_effective_from,
      'effective_to', p_effective_to
    ));
  end if;
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_assignment_create',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if p_effective_to is not null
     or (p_effective_from is not null and p_effective_from <> v_business_date) then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;

  insert into public.work_report_assignments (
    template_id,
    template_version_id,
    target_kind,
    target_user_id,
    target_team_id,
    target_group_id,
    frequency,
    is_mandatory,
    due_day_offset,
    due_time_local,
    exclude_sundays,
    effective_from,
    effective_to,
    assigned_by_user_id
  )
  values (
    p_template_id,
    v_template.current_published_version_id,
    'GROUP',
    null,
    null,
    p_target_group_id,
    p_frequency,
    coalesce(p_is_mandatory, true),
    p_due_day_offset,
    p_due_time_local,
    coalesce(p_exclude_sundays, false),
    v_business_date,
    null,
    p_app_user_id
  )
  returning assignment_id into v_assignment_id;

  perform public.work_report__internal_materialize_assignment_for_date(
    v_assignment_id,
    v_business_date
  );

  v_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.template_id = p_template_id
           and d.scope_kind = 'all'
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      ) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    template_id,
    outcome,
    metadata_json
  )
  values (
    'ASSIGNMENT_CREATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    p_template_id,
    'APPLIED',
    pg_catalog.jsonb_build_object(
      'assignment_id', v_assignment_id,
      'target_kind', 'GROUP',
      'target_group_id', p_target_group_id
    )
  );

  v_result := pg_catalog.jsonb_build_object('assignment_id', v_assignment_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_assignment_create',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$$;

revoke all on function public.work_report_create_group_assignment(
  uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text
) from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_group_assignment(
  uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text
) to service_role;

do $align_and_check_wp10_6$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_proc_owner_oid oid;
  v_overload_cnt integer := 0;
  v_oid oid;
  v_secdef boolean;
  v_proconfig text[];
  v_owner_priv boolean;
  v_owner_exec boolean;
  v_service_exec boolean;
  v_exposed integer;
  v_name text;
  v_sig text;
  v_fn_names text[] := array[
    'work_report_create_assignment',
    'work_report_create_group_assignment'
  ];
  v_service_rpcs text[] := array[
    'public.work_report_create_assignment(uuid,uuid,uuid,text,uuid,uuid,uuid[],text,boolean,integer,time without time zone,boolean,date,date,text)',
    'public.work_report_create_group_assignment(uuid,uuid,uuid,uuid,text,boolean,integer,time without time zone,boolean,date,date,text)'
  ];
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.work_report_assignments'::pg_catalog.regclass;

  if v_base_owner_oid is null or v_base_owner is null then
    raise exception 'WP10-6 alignment failed: missing base table owner' using errcode = '55000';
  end if;

  foreach v_name in array v_fn_names loop
    select pg_catalog.count(*)::integer
      into v_overload_cnt
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = v_name;

    if v_overload_cnt <> 1 then
      raise exception 'WP10-6 check failed: expected single overload for %, found %', v_name, v_overload_cnt
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP10-6 check failed: missing service RPC %', v_sig using errcode = '55000';
    end if;

    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = v_oid;

    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;

    execute pg_catalog.format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      v_sig
    );
    execute pg_catalog.format(
      'grant execute on function %s to service_role',
      v_sig
    );

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
       or not coalesce(v_service_exec, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP10-6 check failed: definer/owner/search_path invalid on %', v_sig using errcode = '55000';
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
      raise exception 'WP10-6 check failed: RPC ACL exposed on %', v_sig using errcode = '55000';
    end if;
  end loop;
end
$align_and_check_wp10_6$;

commit;
