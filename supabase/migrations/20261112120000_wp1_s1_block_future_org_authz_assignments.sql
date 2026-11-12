-- =============================================================================
-- Migration: 20261112120000_wp1_s1_block_future_org_authz_assignments.sql
-- Work Package: WP1 / S1 — Block future-effective org, personnel & permission assignments
-- Scope:
--   1. Reject future effective dates (> server business date) with ERRCODE = '22023'
--      across all organization, personnel, and permission assignment/revocation RPCs
--      that previously accepted future dates or required explicit date input when
--      standard UI date inputs are removed.
--   2. Default omitted/null effective date parameters to server business date (`v_today`)
--      while preserving existing RPC parameter signatures.
--   3. Keep PT409 SQLSTATE on optimistic concurrency conflicts (fixing the PR #218
--      regression on direct_entry_apply_team_leader_mutation).
--   4. Do not rewrite historical or pre-existing future-dated rows (reported via WP0 CAT1).
-- =============================================================================

begin;

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
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_authority text;
  v_reason_id uuid;
  v_subject public.recruiters;
  v_membership public.recruiter_team_memberships;
  v_recruiter_version integer;
  v_revision_id uuid;
  v_changed text[];
  v_prior jsonb;
  v_result jsonb;
begin
  -- Authorization first: an actor without catalog authority always gets 42501 and
  -- learns nothing about the shape of the input.
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null or p_team_id is null then
    raise exception 'recruiter and target team required' using errcode = '22023';
  end if;
  p_valid_from := coalesce(p_valid_from, public.direct_entry_authorization_date());
  if p_valid_from > public.direct_entry_authorization_date() then
    raise exception 'future team memberships require explicit activation' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_membership_assign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'team_id', p_team_id,
      'valid_from', p_valid_from,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_subject := public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
  perform public.direct_entry_assert_membership_target_team(p_team_id);

  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_from, p_team_id) then
    raise exception 'membership change would rewrite worker attribution' using errcode = '23514';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);

  -- The overlap trigger is the only authority on "at most one effective
  -- membership": no pre-check here, and the recruiter row is already locked.
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
set search_path to 'pg_catalog', 'public'
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
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null or p_team_id is null then
    raise exception 'recruiter and target team required' using errcode = '22023';
  end if;
  p_valid_from := coalesce(p_valid_from, public.direct_entry_authorization_date());
  if p_valid_from > public.direct_entry_authorization_date() then
    raise exception 'future team memberships require explicit activation' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_membership_move', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'team_id', p_team_id,
      'valid_from', p_valid_from,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_subject := public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
  perform public.direct_entry_assert_membership_target_team(p_team_id);

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

  -- Same-day move collapses the outgoing interval into an inert cancellation
  -- marker; that write is announced so the marker guard accepts it.
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
set search_path to 'pg_catalog', 'public'
as $function$
declare
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
  v_prior jsonb;
  v_result jsonb;
begin
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null then
    raise exception 'recruiter required' using errcode = '22023';
  end if;
  p_valid_to := coalesce(p_valid_to, public.direct_entry_authorization_date());
  if p_valid_to > public.direct_entry_authorization_date() then
    raise exception 'future team memberships require explicit activation' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 1 and 4000 then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'team_membership_unassign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'recruiter_id', p_recruiter_id,
      'valid_to', p_valid_to,
      'expected_version', p_expected_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  -- Close-only lock: revocation must stay possible for a person who is no longer an
  -- eligible creation subject. No target-team check either: an existing membership in
  -- a team that has since become inactive stays readable and must remain closable.
  v_subject := public.direct_entry_lock_membership_close_target(p_recruiter_id, p_expected_version);
  select m.* into v_open
    from public.recruiter_team_memberships m
   where m.recruiter_id = p_recruiter_id
     and (m.valid_to is null or (
       m.valid_from <= p_valid_to and p_valid_to < m.valid_to
       and public.direct_entry_authorization_date() < m.valid_to
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
     and public.direct_entry_authorization_date() < v_open.valid_from then
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
        -- Restoration is not a pure revocation: enforce the creation guards too.
        perform public.direct_entry_lock_membership_subject(p_recruiter_id, p_expected_version);
        perform public.direct_entry_assert_membership_target_team(v_previous.team_id);
        v_restore := true;
      end if;
    end if;
  end if;
  if public.direct_entry_membership_attribution_conflict(p_recruiter_id, p_valid_to,
    case when v_restore then v_previous.team_id else null end) then
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
       and valid_to <= public.direct_entry_authorization_date();
  end if;
  v_changed := array['valid_to'];
  if v_restore then
    v_changed := array_append(v_changed, 'previous_membership_restored');
  end if;
  if v_change = 'CANCEL' then
    v_changed := array_append(v_changed, 'cancellation_marker');
  end if;
  if p_valid_to < public.direct_entry_authorization_date() then
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
  v_actor_ids uuid[];
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
  p_effective_date := coalesce(p_effective_date, v_today);
  if p_effective_date > v_today then
    raise exception 'future team leader assignments require explicit activation'
      using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'expected team version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

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

  if v_team.version <> p_expected_version then
    raise exception 'team version conflict' using errcode = 'PT409';
  end if;
  if p_operation = 'designate' and not v_team.active then
    raise exception 'target team is inactive' using errcode = '23514';
  end if;

  update public.direct_entry_team_leader_assignments a
     set is_current = false
   where a.team_id = p_team_id
     and a.is_current
     and a.valid_to is not null
     and a.valid_to <= v_today;

  update public.direct_entry_scope_grants s
     set is_current = false
   where s.scope_kind = 'team'
     and s.team_id = p_team_id
     and s.is_current
     and s.valid_to is not null
     and s.valid_to <= v_today;

  update public.direct_entry_capability_grants g
     set is_current = false
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

  update public.direct_entry_team_leader_assignments a
     set is_current = true
   where a.team_id = p_team_id
     and not a.is_current
     and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today);

  update public.direct_entry_scope_grants s
     set is_current = true
   where s.scope_kind = 'team'
     and s.team_id = p_team_id
     and not s.is_current
     and public.direct_entry__internal_team_scope_grant_effective(s.grant_id, v_today);

  update public.direct_entry_capability_grants g
     set is_current = true
   where g.capability = 'team_manager_assign'
     and not g.is_current
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

  v_actor_ids := array_remove(array[
    case when v_old_count = 1 then v_old.leader_app_user_id end,
    p_target_leader_app_user_id,
    v_previous.leader_app_user_id
  ]::uuid[], null);

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_actor_ids)
   order by u.app_user_id
   for update;
  if p_operation = 'designate' then
    select u.enabled into v_candidate_user_enabled
      from public.direct_entry_app_users u
     where u.app_user_id = p_target_leader_app_user_id;
    if not found or not coalesce(v_candidate_user_enabled, false) then
      raise exception 'target leader account is not enabled' using errcode = '42501';
    end if;
  end if;
  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = any(v_actor_ids)
     and s.scope_kind = 'team'
   order by s.app_user_id, s.grant_id
   for update;
  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = any(v_actor_ids)
     and g.capability = 'team_manager_assign'
   order by g.app_user_id, g.grant_id
   for update;

  for v_lock_key in
    select distinct key
      from unnest(array[
        case when v_old_count = 1 then
          'capability:' || v_old.leader_app_user_id::text || ':team_manager_assign' end,
        case when v_old_count = 1 then
          'scope:' || v_old.leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when v_previous.assignment_id is not null then
          'capability:' || v_previous.leader_app_user_id::text || ':team_manager_assign' end,
        case when v_previous.assignment_id is not null then
          'scope:' || v_previous.leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when v_previous.assignment_id is not null then
          'recruiter-link:' || v_previous.leader_app_user_id::text end,
        case when p_operation = 'designate' then
          'capability:' || p_target_leader_app_user_id::text || ':team_manager_assign' end,
        case when p_operation = 'designate' then
          'scope:' || p_target_leader_app_user_id::text || ':team:' || p_team_id::text end,
        case when p_operation = 'designate' then
          'recruiter-link:' || p_target_leader_app_user_id::text end
      ]) as keys(key)
     where key is not null
     order by key
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  if p_operation = 'designate' then
    perform l.link_id
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_target_leader_app_user_id
     order by l.link_id
     for update;
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
     where r.recruiter_id = v_recruiter_id
     for update;
    if not found or not coalesce(v_recruiter_active, false) then
      raise exception 'target recruiter is not active' using errcode = '42501';
    end if;

    for v_lock_key in
      select key
        from unnest(array[
          'provider:' || v_recruiter_id::text,
          'team-membership:' || v_recruiter_id::text
        ]) as keys(key)
       order by key
    loop
      perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
    end loop;

    perform m.membership_id
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_recruiter_id
     order by m.membership_id
     for update;
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

    perform m.membership_id
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_recruiter_id
     order by m.membership_id
     for update;
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
    perform a.assignment_id
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_old.assignment_id
     for update;

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
    perform a.assignment_id
      from public.direct_entry_team_leader_assignments a
     where a.assignment_id = v_previous.assignment_id
     for update;

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
    update public.direct_entry_team_leader_assignments
       set valid_to = p_effective_date,
           is_current = (p_effective_date > v_old.valid_from and v_old.valid_from <= v_today and v_today < p_effective_date)
     where assignment_id = v_old.assignment_id;
    update public.direct_entry_scope_grants
       set valid_to = p_effective_date,
           is_current = (p_effective_date > valid_from and valid_from <= v_today and v_today < p_effective_date)
     where grant_id = v_scope_grant_id;
    update public.direct_entry_capability_grants
       set valid_to = p_effective_date,
           is_current = (p_effective_date > valid_from and valid_from <= v_today and v_today < p_effective_date)
     where grant_id = v_capability_grant_id;
  end if;

  if v_restore then
    update public.direct_entry_team_leader_assignments
       set valid_to = null,
           is_current = (v_previous.valid_from <= v_today)
     where assignment_id = v_previous.assignment_id;
    update public.direct_entry_scope_grants
       set valid_to = null,
           is_current = (valid_from <= v_today)
     where grant_id = v_prev_scope_grant_id;
    update public.direct_entry_capability_grants
       set valid_to = null,
           is_current = (valid_from <= v_today)
     where grant_id = v_prev_capability_grant_id;
  end if;

  if p_operation = 'designate' then
    insert into public.direct_entry_team_leader_assignments
      (team_id, leader_app_user_id, leader_recruiter_id, valid_from, is_current)
    values
      (p_team_id, p_target_leader_app_user_id, v_recruiter_id, p_effective_date, (p_effective_date <= v_today))
    returning * into v_new;
    insert into public.direct_entry_scope_grants
      (app_user_id, scope_kind, team_id, valid_from, is_current)
    values
      (p_target_leader_app_user_id, 'team', p_team_id, p_effective_date, (p_effective_date <= v_today));
    insert into public.direct_entry_capability_grants
      (app_user_id, capability, valid_from, is_current)
    values
      (p_target_leader_app_user_id, 'team_manager_assign', p_effective_date, (p_effective_date <= v_today));
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
       or v_post_target_team_assignment_count <> 1 then
      raise exception 'team leader mutation postcondition failed' using errcode = '55000';
    end if;
    if v_post_target_assignment_count <> 1
       or v_post_target_team_assignment_count <> 1 then
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
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_effective_from date;
  v_reason text;
  v_dept public.organization_departments%rowtype;
  v_idem public.organization_department_idempotency%rowtype;
  v_target public.direct_entry_app_users%rowtype;
  v_current_pair_version integer;
  v_inserted public.organization_department_memberships%rowtype;
  v_projection jsonb;
  v_base_payload jsonb;
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
  if v_effective_from > v_today then
    raise exception 'DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID'
      using errcode = '22023';
  end if;

  select d.*
    into v_dept
    from public.organization_departments d
   where d.system_key = 'ACCOUNTING'
   for update;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if not v_dept.is_active then
    raise exception 'DEPARTMENT_INACTIVE'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_idem_v1'),
    pg_catalog.hashtext(p_app_user_id::text)
  );

  select i.*
    into v_idem
    from public.organization_department_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_idem.action <> 'ACCOUNTING_MEMBER_ASSIGNED'
       or v_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_membership_v1'),
    pg_catalog.hashtext(v_dept.department_id::text || ':' || p_target_app_user_id::text)
  );

  select u.*
    into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id
   for update;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if not v_target.enabled then
    raise exception 'TARGET_ACCOUNT_DISABLED'
      using errcode = '23514';
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

  v_projection := public.org_department__internal_membership_projection(
    v_inserted,
    v_inserted.version,
    v_today
  );

  insert into public.organization_department_audit_events (
    department_id,
    membership_id,
    target_app_user_id,
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
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ACCOUNTING_MEMBER_ASSIGNED',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.vendor_finance_assign_project_accountant_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_accountant_user_id uuid,
  p_expected_version integer,
  p_valid_from date,
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
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_reason text;
  v_valid_from date;
  v_max_version integer;
  v_target_user public.direct_entry_app_users%rowtype;
  v_inserted public.vendor_finance_project_accountants%rowtype;
  v_base_payload jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'ASSIGN_PROJECT_ACCOUNTANT'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_accountant_user_id is null or p_expected_version is null or p_expected_version < 0 then
    raise exception 'VENDOR_FINANCE_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  v_valid_from := coalesce(p_valid_from, v_today);
  if v_valid_from > v_today
     or pg_catalog.date_part('year', v_valid_from)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);
  v_project := public.vendor_finance__internal_lock_project(p_project_id);

  if not v_project.active then
    raise exception 'VENDOR_FINANCE_PROJECT_INACTIVE'
      using errcode = '42200';
  end if;

  select u.*
    into v_target_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_accountant_user_id;

  if not found or not v_target_user.enabled
     or not public.org_department__internal_has_active_membership(p_accountant_user_id, 'ACCOUNTING', v_today) then
    raise exception 'VENDOR_FINANCE_ACCOUNTANT_NOT_ELIGIBLE'
      using errcode = '42200';
  end if;

  select coalesce(max(pa.version), 0)::integer
    into v_max_version
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_project.project_id;

  if v_max_version <> p_expected_version then
    raise exception 'VENDOR_FINANCE_ASSIGNMENT_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1
      from public.vendor_finance_project_accountants pa
     where pa.project_id = v_project.project_id
       and pa.valid_to is null
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ALREADY_ASSIGNED'
      using errcode = '23505';
  end if;

  perform pg_catalog.set_config('vendor_finance.admin_write_marker', 'on', true);

  insert into public.vendor_finance_project_accountants (
    project_id,
    accountant_user_id,
    version,
    valid_from,
    assigned_by_user_id,
    assign_reason
  ) values (
    v_project.project_id,
    p_accountant_user_id,
    v_max_version + 1,
    v_valid_from,
    p_app_user_id,
    v_reason
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    project_id,
    project_accountant_assignment_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_project.project_id,
    v_inserted.assignment_id,
    p_app_user_id,
    'full_admin',
    'PROJECT_ACCOUNTANT_ASSIGNED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'accountant_user_id', v_inserted.accountant_user_id,
      'valid_from', v_inserted.valid_from::text,
      'version', v_inserted.version
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'assignment_id', v_inserted.assignment_id,
    'project_id', v_inserted.project_id,
    'version', v_inserted.version
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ASSIGN_PROJECT_ACCOUNTANT',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.vendor_finance_end_project_accountant_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_expected_version integer,
  p_valid_to date,
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
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_target public.vendor_finance_project_accountants%rowtype;
  v_max_version integer;
  v_valid_to date;
  v_reason text;
  v_updated public.vendor_finance_project_accountants%rowtype;
  v_base_payload jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'END_PROJECT_ACCOUNTANT'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_assignment_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'VENDOR_FINANCE_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  select pa.*
    into v_target
    from public.vendor_finance_project_accountants pa
   where pa.assignment_id = p_assignment_id;

  if not found then
    raise exception 'VENDOR_FINANCE_ASSIGNMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform public.vendor_finance__internal_lock_project(v_target.project_id);

  select pa.*
    into v_target
    from public.vendor_finance_project_accountants pa
   where pa.assignment_id = p_assignment_id;

  select coalesce(max(pa.version), 0)::integer
    into v_max_version
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_target.project_id;

  if v_target.valid_to is not null or v_max_version <> p_expected_version then
    raise exception 'VENDOR_FINANCE_ASSIGNMENT_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  v_valid_to := case
    when p_valid_to is null then greatest(v_today, v_target.valid_from)
    else p_valid_to
  end;
  if (p_valid_to is not null and p_valid_to > v_today)
     or v_valid_to < v_target.valid_from
     or pg_catalog.date_part('year', v_valid_to)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.set_config('vendor_finance.admin_write_marker', 'on', true);

  update public.vendor_finance_project_accountants pa
     set valid_to = v_valid_to,
         ended_by_user_id = p_app_user_id,
         ended_at = now(),
         end_reason = v_reason,
         updated_at = now()
   where pa.assignment_id = v_target.assignment_id
  returning * into v_updated;

  insert into public.vendor_finance_audit_events (
    project_id,
    project_accountant_assignment_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_updated.project_id,
    v_updated.assignment_id,
    p_app_user_id,
    'full_admin',
    'PROJECT_ACCOUNTANT_ENDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'accountant_user_id', v_updated.accountant_user_id,
      'valid_from', v_updated.valid_from::text,
      'valid_to', v_updated.valid_to::text,
      'version', v_max_version
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'assignment_id', v_updated.assignment_id,
    'project_id', v_updated.project_id,
    'valid_to', v_updated.valid_to::text
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'END_PROJECT_ACCOUNTANT',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.vendor_finance_assign_global_role_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_user_id uuid,
  p_role_code text,
  p_expected_version integer,
  p_valid_from date,
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
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_valid_from date;
  v_reason text;
  v_max_version integer;
  v_inserted public.vendor_finance_global_roles%rowtype;
  v_base_payload jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'ASSIGN_GLOBAL_ROLE'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_target_user_id is null
     or p_role_code is null
     or p_role_code not in ('GLOBAL_VIEWER', 'GLOBAL_RECONCILER', 'CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF')
     or p_expected_version is null or p_expected_version < 0 then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_INVALID'
      using errcode = '22023';
  end if;

  v_valid_from := coalesce(p_valid_from, v_today);
  if v_valid_from > v_today
     or pg_catalog.date_part('year', v_valid_from)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_global_role:' || p_target_user_id::text, 0)
  );

  select u.*
    into v_target_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_user_id;

  if not found or not v_target_user.enabled then
    raise exception 'VENDOR_FINANCE_ACCOUNT_NOT_ELIGIBLE'
      using errcode = '42200';
  end if;

  select coalesce(max(gr.version), 0)::integer
    into v_max_version
    from public.vendor_finance_global_roles gr
   where gr.app_user_id = p_target_user_id;

  if v_max_version <> p_expected_version then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1
      from public.vendor_finance_global_roles gr
     where gr.app_user_id = p_target_user_id
       and gr.valid_to is null
  ) then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_ALREADY_ASSIGNED'
      using errcode = '23505';
  end if;

  perform pg_catalog.set_config('vendor_finance.admin_write_marker', 'on', true);

  insert into public.vendor_finance_global_roles (
    app_user_id,
    role_code,
    version,
    valid_from,
    granted_by_user_id,
    grant_reason
  ) values (
    p_target_user_id,
    p_role_code,
    v_max_version + 1,
    v_valid_from,
    p_app_user_id,
    v_reason
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    global_role_grant_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_inserted.role_grant_id,
    p_app_user_id,
    'full_admin',
    'GLOBAL_ROLE_ASSIGNED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'target_user_id', v_inserted.app_user_id,
      'role_code', v_inserted.role_code,
      'valid_from', v_inserted.valid_from::text,
      'version', v_inserted.version
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'role_grant_id', v_inserted.role_grant_id,
    'account_ref', v_inserted.app_user_id,
    'role_code', v_inserted.role_code,
    'version', v_inserted.version
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ASSIGN_GLOBAL_ROLE',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.vendor_finance_end_global_role_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_role_grant_id uuid,
  p_expected_version integer,
  p_valid_to date,
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
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_target public.vendor_finance_global_roles%rowtype;
  v_max_version integer;
  v_valid_to date;
  v_reason text;
  v_updated public.vendor_finance_global_roles%rowtype;
  v_base_payload jsonb;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'END_GLOBAL_ROLE'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_role_grant_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  select gr.*
    into v_target
    from public.vendor_finance_global_roles gr
   where gr.role_grant_id = p_role_grant_id;

  if not found then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_global_role:' || v_target.app_user_id::text, 0)
  );

  select gr.*
    into v_target
    from public.vendor_finance_global_roles gr
   where gr.role_grant_id = p_role_grant_id;

  select coalesce(max(gr.version), 0)::integer
    into v_max_version
    from public.vendor_finance_global_roles gr
   where gr.app_user_id = v_target.app_user_id;

  if v_target.valid_to is not null or v_max_version <> p_expected_version then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  v_valid_to := case
    when p_valid_to is null then greatest(v_today, v_target.valid_from)
    else p_valid_to
  end;
  if (p_valid_to is not null and p_valid_to > v_today)
     or v_valid_to < v_target.valid_from
     or pg_catalog.date_part('year', v_valid_to)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.set_config('vendor_finance.admin_write_marker', 'on', true);

  update public.vendor_finance_global_roles gr
     set valid_to = v_valid_to,
         ended_by_user_id = p_app_user_id,
         ended_at = now(),
         end_reason = v_reason,
         updated_at = now()
   where gr.role_grant_id = v_target.role_grant_id
  returning * into v_updated;

  insert into public.vendor_finance_audit_events (
    global_role_grant_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_updated.role_grant_id,
    p_app_user_id,
    'full_admin',
    'GLOBAL_ROLE_ENDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'target_user_id', v_updated.app_user_id,
      'role_code', v_updated.role_code,
      'valid_to', v_updated.valid_to::text,
      'version', v_max_version
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'role_grant_id', v_updated.role_grant_id,
    'account_ref', v_updated.app_user_id,
    'valid_to', v_updated.valid_to::text
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'END_GLOBAL_ROLE',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

create or replace function public.leave_management_set_department_approver_admin(
  p_actor_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_unit_kind text,
  p_approver_app_user_id uuid,
  p_valid_from date,
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
  v_today date := public.leave_management__internal_business_date();
  v_auth jsonb;
  v_reason text;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_unit text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_unit_kind, '')));
  v_valid_from date := coalesce(p_valid_from, v_today);
  v_current public.leave_department_approvers%rowtype;
  v_has_current boolean := false;
  v_new_row public.leave_department_approvers%rowtype;
  v_approver_user public.direct_entry_app_users%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  ) then
    raise exception 'LEAVE_DEPARTMENT_APPROVER_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_REQUIRED');

  if v_unit not in ('MARKETING', 'IT', 'ACCOUNTING') then
    raise exception 'LEAVE_UNIT_KIND_INVALID'
      using errcode = '22023';
  end if;

  if v_valid_from > v_today then
    raise exception 'LEAVE_DEPARTMENT_APPROVER_FUTURE_DATE_FORBIDDEN'
      using errcode = '22023';
  end if;

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'SET_DEPARTMENT_APPROVER_ADMIN'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_approver_app_user_id is not null then
    select u.*
      into v_approver_user
      from public.direct_entry_app_users u
     where u.app_user_id = p_approver_app_user_id
       and u.enabled = true;

    if not found then
      raise exception 'LEAVE_APPROVER_USER_NOT_FOUND'
        using errcode = 'P0002';
    end if;
  end if;

  select da.*
    into v_current
    from public.leave_department_approvers da
   where da.unit_kind = v_unit
     and da.is_current = true
   for update;

  if found then
    v_has_current := true;
    if p_expected_row_version is null or v_current.row_version <> p_expected_row_version then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;

    update public.leave_department_approvers
       set is_current = false,
           valid_to = case
             when valid_from < v_valid_from then v_valid_from
             else valid_from
           end,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now()),
           updated_by_app_user_id = p_actor_app_user_id
     where unit_kind = v_unit
       and (is_current = true or valid_to is null or valid_to > v_valid_from);
  else
    if coalesce(p_expected_row_version, 0) <> 0 then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using errcode = 'PT409';
    end if;
  end if;

  if p_approver_app_user_id is not null then
    insert into public.leave_department_approvers (
      unit_kind,
      approver_app_user_id,
      valid_from,
      valid_to,
      is_current,
      reason,
      row_version,
      updated_by_app_user_id
    )
    values (
      v_unit,
      p_approver_app_user_id,
      v_valid_from,
      null,
      true,
      v_reason,
      case when v_has_current then v_current.row_version + 1 else 1 end,
      p_actor_app_user_id
    )
    returning * into v_new_row;
  end if;

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    reason,
    payload
  )
  values (
    'DEPARTMENT_APPROVER_UPDATED',
    p_actor_app_user_id,
    p_approver_app_user_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'unit_kind', v_unit,
      'approver_app_user_id', p_approver_app_user_id,
      'valid_from', v_valid_from
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'department_approver', case
      when p_approver_app_user_id is not null then
        pg_catalog.jsonb_build_object(
          'approver_assignment_id', v_new_row.approver_assignment_id,
          'unit_kind', v_new_row.unit_kind,
          'approver_app_user_id', v_new_row.approver_app_user_id,
          'approver', public.leave_management__internal_account_summary(v_new_row.approver_app_user_id),
          'valid_from', v_new_row.valid_from,
          'valid_to', v_new_row.valid_to,
          'is_current', v_new_row.is_current,
          'reason', v_new_row.reason,
          'row_version', v_new_row.row_version
        )
      else
        null
    end
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'SET_DEPARTMENT_APPROVER_ADMIN',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$;

create or replace function public.attendance_assign_employee_branch_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_branch_id uuid,
  p_valid_from date,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_can_manage boolean;
  v_existing public.attendance_branch_assignments%rowtype;
  v_branch public.attendance_branches%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_today_vn date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_valid_from date := coalesce(p_valid_from, v_today_vn);
  v_inserted public.attendance_branch_assignments%rowtype;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if not v_can_manage then
    raise exception 'ATTENDANCE_BRANCH_WRITE_DENIED'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  if p_target_app_user_id is null
     or p_branch_id is null
     or p_expected_version is null
     or p_expected_version < 1 then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  if v_valid_from > v_today_vn then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_branch_assignments_user'),
    hashtext(p_target_app_user_id::text)
  );

  select *
    into v_existing
  from public.attendance_branch_assignments a
  where a.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;

    select *
      into v_branch
    from public.attendance_branches b
    where b.branch_id = v_existing.branch_id;

    return jsonb_build_object(
      'replayed', true,
      'assignment', jsonb_build_object(
        'assignment_id', v_existing.assignment_id,
        'app_user_id', v_existing.app_user_id,
        'branch_id', v_existing.branch_id,
        'branch_code', v_branch.branch_code,
        'branch_name', v_branch.display_name,
        'valid_from', v_existing.valid_from,
        'valid_to', v_existing.valid_to,
        'version', v_existing.version
      )
    );
  end if;

  select *
    into v_target_user
  from public.direct_entry_app_users u
  where u.app_user_id = p_target_app_user_id;

  if not found or v_target_user.enabled is distinct from true then
    raise exception 'ATTENDANCE_BRANCH_TARGET_USER_INVALID'
      using errcode = '22023';
  end if;

  select *
    into v_branch
  from public.attendance_branches b
  where b.branch_id = p_branch_id
  for share;

  if not found then
    raise exception 'ATTENDANCE_BRANCH_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_branch.version <> p_expected_version then
    raise exception 'ATTENDANCE_BRANCH_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if not v_branch.active then
    raise exception 'ATTENDANCE_BRANCH_INACTIVE'
      using errcode = '22023';
  end if;

  insert into public.attendance_branch_assignments (
    app_user_id,
    branch_id,
    valid_from,
    valid_to,
    version,
    assigned_by_user_id,
    idempotency_key,
    request_fingerprint
  )
  values (
    p_target_app_user_id,
    p_branch_id,
    v_valid_from,
    null,
    1,
    p_app_user_id,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  return jsonb_build_object(
    'replayed', false,
    'assignment', jsonb_build_object(
      'assignment_id', v_inserted.assignment_id,
      'app_user_id', v_inserted.app_user_id,
      'branch_id', v_inserted.branch_id,
      'branch_code', v_branch.branch_code,
      'branch_name', v_branch.display_name,
      'valid_from', v_inserted.valid_from,
      'valid_to', v_inserted.valid_to,
      'version', v_inserted.version
    )
  );
end;
$$;

create or replace function public.attendance_unassign_employee_branch_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_valid_to date,
  p_expected_version integer,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_can_manage boolean;
  v_existing public.attendance_branch_assignments%rowtype;
  v_current public.attendance_branch_assignments%rowtype;
  v_today_vn date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_valid_to date := coalesce(p_valid_to, v_today_vn);
  v_updated public.attendance_branch_assignments%rowtype;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if not v_can_manage then
    raise exception 'ATTENDANCE_BRANCH_WRITE_DENIED'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  if p_assignment_id is null
     or p_expected_version is null
     or p_expected_version < 1 then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  if v_valid_to > v_today_vn then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_branch_assignments_unassign'),
    hashtext(p_assignment_id::text)
  );

  select *
    into v_existing
  from public.attendance_branch_assignments a
  where a.revoke_idempotency_key = p_idempotency_key;

  if found then
    if v_existing.revoke_request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;

    return jsonb_build_object(
      'replayed', true,
      'assignment', jsonb_build_object(
        'assignment_id', v_existing.assignment_id,
        'app_user_id', v_existing.app_user_id,
        'branch_id', v_existing.branch_id,
        'valid_from', v_existing.valid_from,
        'valid_to', v_existing.valid_to,
        'version', v_existing.version
      )
    );
  end if;

  select *
    into v_current
  from public.attendance_branch_assignments a
  where a.assignment_id = p_assignment_id
  for update;

  if not found then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_current.version <> p_expected_version then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_current.valid_to is not null then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_ALREADY_CLOSED'
      using errcode = 'PT409';
  end if;

  if v_valid_to < v_current.valid_from then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_RANGE_INVALID'
      using errcode = '22023';
  end if;

  update public.attendance_branch_assignments
  set
    valid_to = v_valid_to,
    version = v_current.version + 1,
    revoked_by_user_id = p_app_user_id,
    revoked_at = clock_timestamp(),
    revoke_idempotency_key = p_idempotency_key,
    revoke_request_fingerprint = p_request_fingerprint,
    updated_at = clock_timestamp()
  where assignment_id = p_assignment_id
  returning * into v_updated;

  return jsonb_build_object(
    'replayed', false,
    'assignment', jsonb_build_object(
      'assignment_id', v_updated.assignment_id,
      'app_user_id', v_updated.app_user_id,
      'branch_id', v_updated.branch_id,
      'valid_from', v_updated.valid_from,
      'valid_to', v_updated.valid_to,
      'version', v_updated.version
    )
  );
end;
$$;

do $owner_align$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_fn regprocedure;
  v_proc_owner_oid oid;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_owner is null then
    raise exception 'DIRECT_ENTRY_OWNER_RESOLUTION_FAILED';
  end if;

  for v_fn, v_proc_owner_oid in
    select p.oid::regprocedure, p.proowner
      from pg_catalog.pg_proc p
     where p.oid in (
       'public.direct_entry_assign_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_move_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_unassign_team_membership(uuid,uuid,uuid,date,integer,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)'::pg_catalog.regprocedure,
       'public.org_department_assign_accounting_member(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
       'public.vendor_finance_assign_project_accountant_admin(uuid,uuid,text,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
       'public.vendor_finance_end_project_accountant_admin(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
       'public.vendor_finance_assign_global_role_admin(uuid,uuid,uuid,text,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
       'public.vendor_finance_end_global_role_admin(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
       'public.leave_management_set_department_approver_admin(uuid,uuid,text,uuid,date,integer,text,text,text)'::pg_catalog.regprocedure,
       'public.attendance_assign_employee_branch_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_unassign_employee_branch_admin(uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure
     )
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;
end
$owner_align$;

revoke all on function public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text)
  from public, anon, authenticated, service_role;

revoke all on function
  public.direct_entry_assign_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text),
  public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text),
  public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text),
  public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text),
  public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text),
  public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text),
  public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text),
  public.attendance_unassign_employee_branch_admin(uuid, uuid, uuid, date, integer, uuid, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.direct_entry_assign_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text),
  public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text),
  public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text),
  public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text),
  public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text),
  public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text),
  public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text),
  public.attendance_unassign_employee_branch_admin(uuid, uuid, uuid, date, integer, uuid, text)
to service_role;

do $self_check$
declare
  v_rpc_fn regprocedure;
  v_secdef boolean;
  v_config text;
begin
  foreach v_rpc_fn in array array[
    'public.direct_entry_assign_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)'::pg_catalog.regprocedure,
    'public.direct_entry_move_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)'::pg_catalog.regprocedure,
    'public.direct_entry_unassign_team_membership(uuid,uuid,uuid,date,integer,text,text)'::pg_catalog.regprocedure,
    'public.org_department_assign_accounting_member(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
    'public.vendor_finance_assign_project_accountant_admin(uuid,uuid,text,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
    'public.vendor_finance_end_project_accountant_admin(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
    'public.vendor_finance_assign_global_role_admin(uuid,uuid,uuid,text,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
    'public.vendor_finance_end_global_role_admin(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
    'public.leave_management_set_department_approver_admin(uuid,uuid,text,uuid,date,integer,text,text,text)'::pg_catalog.regprocedure,
    'public.attendance_assign_employee_branch_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
    'public.attendance_unassign_employee_branch_admin(uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure
  ]
  loop
    select p.prosecdef,
           coalesce(pg_catalog.array_to_string(p.proconfig, ','), '')
      into v_secdef, v_config
      from pg_catalog.pg_proc p
     where p.oid = v_rpc_fn;

    if not coalesce(v_secdef, false)
       or v_config <> 'search_path=pg_catalog, public' then
      raise exception 'WP1-S1 RPC security definer or search_path drift on %', v_rpc_fn
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_rpc_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_rpc_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_rpc_fn, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_rpc_fn, 'EXECUTE') then
      raise exception 'WP1-S1 RPC EXECUTE privilege drift on %', v_rpc_fn
        using errcode = '55000';
    end if;
  end loop;

  if pg_catalog.has_function_privilege(
       'public',
       'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'anon',
       'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)'::pg_catalog.regprocedure,
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'service_role',
       'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)'::pg_catalog.regprocedure,
       'EXECUTE'
     ) then
    raise exception 'WP1-S1 internal helper EXECUTE privilege drift on direct_entry_apply_team_leader_mutation'
      using errcode = '55000';
  end if;
end
$self_check$;

commit;
