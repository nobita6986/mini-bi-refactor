-- =============================================================================
-- Migration: 20261112120000_wp1_s1_block_future_org_authz_assignments.sql
-- Work Package: WP1 / S1 — Block future-effective org, personnel & permission assignments
-- Scope:
--   1. Derive effective dates on the server (`v_today`) and reject non-current client
--      effective dates (< or > server business date) with ERRCODE = '22023' across
--      standard organization, personnel, and permission assignment/revocation RPCs.
--   2. Default omitted/null effective date parameters to server business date (`v_today`)
--      while preserving existing RPC parameter signatures.
--   3. Decouple idempotency request fingerprints from the server-computed effective date
--      so retries across midnight replay the committed result instead of failing with 22023.
--   4. Keep PT409 SQLSTATE on optimistic concurrency conflicts (fixing the PR #218
--      regression on direct_entry_apply_team_leader_mutation).
--   5. Do not rewrite historical or pre-existing future-dated rows (reported via WP0 CAT1).
--   6. Work Reports delegations (`public.work_report_delegations`, `report_assign` and
--      `report_review`): take effect immediately at server creation time (`effective_from = statement_timestamp()`,
--      `effective_to = null`) and end immediately upon revocation (`state = 'REVOKED'`,
--      `is_current = false`, `revoked_at = statement_timestamp()`). Client-supplied
--      start/expiration timestamps are rejected in `public.work_report_create_delegation`.
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
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  -- Authorization first: an actor without catalog authority always gets 42501 and
  -- learns nothing about the shape of the input.
  v_authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);

  if p_recruiter_id is null or p_team_id is null then
    raise exception 'recruiter and target team required' using errcode = '22023';
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

  p_valid_from := coalesce(p_valid_from, public.direct_entry_authorization_date());
  if p_valid_from > public.direct_entry_authorization_date() then
    raise exception 'future team memberships require explicit activation' using errcode = '22023';
  end if;
  if p_valid_from < public.direct_entry_authorization_date() then
    raise exception 'past team memberships are not allowed' using errcode = '22023';
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

  p_valid_from := coalesce(p_valid_from, public.direct_entry_authorization_date());
  if p_valid_from > public.direct_entry_authorization_date() then
    raise exception 'future team memberships require explicit activation' using errcode = '22023';
  end if;
  if p_valid_from < public.direct_entry_authorization_date() then
    raise exception 'past team memberships are not allowed' using errcode = '22023';
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

  p_valid_to := coalesce(p_valid_to, public.direct_entry_authorization_date());
  if p_valid_to > public.direct_entry_authorization_date() then
    raise exception 'future team memberships require explicit activation' using errcode = '22023';
  end if;
  if p_valid_to < public.direct_entry_authorization_date() then
    raise exception 'past team memberships are not allowed' using errcode = '22023';
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

  if v_effective_from <> v_today then
    raise exception 'DEPARTMENT_MEMBERSHIP_EFFECTIVE_DATE_INVALID'
      using errcode = '22023';
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
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_effective_to date;
  v_reason text;
  v_dept public.organization_departments%rowtype;
  v_idem public.organization_department_idempotency%rowtype;
  v_target_user_id uuid;
  v_target public.direct_entry_app_users%rowtype;
  v_membership public.organization_department_memberships%rowtype;
  v_updated public.organization_department_memberships%rowtype;
  v_current_pair_version integer;
  v_before jsonb;
  v_after jsonb;
  v_base_payload jsonb;
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

  select d.*
    into v_dept
    from public.organization_departments d
   where d.system_key = 'ACCOUNTING'
   for update;

  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND'
      using errcode = 'P0002';
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
    if v_idem.action <> 'ACCOUNTING_MEMBER_ENDED'
       or v_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_membership_v1'),
    pg_catalog.hashtext(v_dept.department_id::text || ':' || v_target_user_id::text)
  );

  select u.*
    into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = v_target_user_id
   for update;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND'
      using errcode = 'P0002';
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
         revoked_at = now(),
         version = v_current_pair_version + 1
   where membership_id = p_membership_id
  returning * into v_updated;

  v_after := public.org_department__internal_membership_projection(
    v_updated,
    v_updated.version,
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
    v_updated.membership_id,
    v_target_user_id,
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
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ACCOUNTING_MEMBER_ENDED',
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
  if v_valid_from <> v_today
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
  if (p_valid_to is not null and p_valid_to <> v_today)
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
  if v_valid_from <> v_today
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
  if (p_valid_to is not null and p_valid_to <> v_today)
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

  if v_valid_from > v_today then
    raise exception 'LEAVE_DEPARTMENT_APPROVER_FUTURE_DATE_FORBIDDEN'
      using errcode = '22023';
  end if;

  if v_valid_from < v_today then
    raise exception 'LEAVE_DEPARTMENT_APPROVER_PAST_DATE_FORBIDDEN'
      using errcode = '22023';
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
  v_today_vn date := coalesce(
    nullif(current_setting('direct_entry.test_authorization_date', true), '')::date,
    (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  );
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

  if v_valid_from > v_today_vn then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE'
      using errcode = '22023';
  end if;

  if v_valid_from < v_today_vn then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_PAST_DATE'
      using errcode = '22023';
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
  v_today_vn date := coalesce(
    nullif(current_setting('direct_entry.test_authorization_date', true), '')::date,
    (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  );
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

  if v_valid_to > v_today_vn then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_FUTURE_DATE'
      using errcode = '22023';
  end if;

  if v_valid_to < v_today_vn then
    raise exception 'ATTENDANCE_BRANCH_ASSIGNMENT_PAST_DATE'
      using errcode = '22023';
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

create or replace function public.direct_entry_assign_project_manager(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_manager_recruiter_id uuid,
  p_valid_from date,
  p_expected_project_version integer,
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
  v_team_id uuid;
  v_project public.direct_entry_projects;
  v_valid_from date;
  v_membership_count integer;
  v_matching_membership_count integer;
  v_link_count integer;
  v_enabled_link_count integer;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_assignment_id uuid;
  v_reason_id uuid;
  v_revision_id uuid;
  v_project_version integer;
  v_before jsonb;
  v_prior jsonb;
  v_result jsonb;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;
  if p_manager_recruiter_id is null then
    raise exception 'project manager required' using errcode = '22023';
  end if;
  if p_expected_project_version is null or p_expected_project_version < 1 then
    raise exception 'expected project version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  select a.authority, a.team_id
    into v_authority, v_team_id
    from public.direct_entry_assert_project_operation_authority(
      p_auth_subject, p_app_user_id
    ) a;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_manager_assignment_assign', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'project_id', p_project_id,
      'manager_recruiter_id', p_manager_recruiter_id,
      'valid_from', p_valid_from,
      'expected_project_version', p_expected_project_version
    ))
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_valid_from := coalesce(p_valid_from, public.direct_entry_authorization_date());
  if v_valid_from > public.direct_entry_authorization_date() then
    raise exception 'future project manager assignments require explicit activation' using errcode = '22023';
  end if;
  if v_valid_from < public.direct_entry_authorization_date() then
    raise exception 'past project manager assignments are not allowed' using errcode = '22023';
  end if;

  -- Lock project first, then the effective mapping, then the canonical leader/team and
  -- target-recruiter authority aggregates in the same order as W01C/W01D before
  -- validating; the mapping is re-read AFTER every lock is held.
  v_project := public.direct_entry_lock_project(p_project_id, p_expected_project_version);
  if not v_project.active then
    raise exception 'project is not active' using errcode = '22023';
  end if;
  if v_authority = 'team_manager_assign' then
    if not public.direct_entry_lock_project_team_scope(p_project_id, v_team_id) then
      raise exception 'project team scope denied' using errcode = '42501';
    end if;
    perform public.direct_entry_lock_project_team_manager_context(
      p_auth_subject, p_app_user_id, v_team_id, p_manager_recruiter_id
    );
    if not public.direct_entry_project_team_scope_effective(p_project_id, v_team_id) then
      raise exception 'project team scope denied' using errcode = '42501';
    end if;
    select count(*)::int,
           count(*) filter (where m.team_id = v_team_id)::int
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = p_manager_recruiter_id
       and m.is_current;
    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'team manager assignment denied' using errcode = '42501';
    end if;
    select count(*)::int
      into v_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.is_current;
    select count(*)::int
      into v_enabled_link_count
      from public.direct_entry_app_user_recruiter_links l
      join public.direct_entry_app_users au on au.app_user_id = l.app_user_id
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.is_current
       and au.enabled
       and au.auth_subject is not null;
    select count(*)::int,
           count(*) filter (
             where m.provider_type = 'hrp' and m.vendor_id is null
           )::int
      into v_provider_count, v_hrp_provider_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = p_manager_recruiter_id
       and m.is_current;
    if v_link_count <> 1 or v_enabled_link_count <> 1
       or v_provider_count <> 1 or v_hrp_provider_count <> 1
       or not exists (
         select 1 from public.recruiters r
          where r.recruiter_id = p_manager_recruiter_id and r.active
       ) then
      raise exception 'team manager assignment denied' using errcode = '42501';
    end if;
  end if;
  if not exists (
    select 1 from public.recruiters r
     where r.recruiter_id = p_manager_recruiter_id and r.active
  ) then
    raise exception 'project manager recruiter is not active' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.direct_entry_app_user_recruiter_links l
     where l.recruiter_id = p_manager_recruiter_id
       and l.verified
       and l.is_current
  ) then
    raise exception 'project manager has no verified account link' using errcode = '22023';
  end if;
  select count(*)::int
    into v_link_count
    from public.direct_entry_app_user_recruiter_links l
   where l.recruiter_id = p_manager_recruiter_id
     and l.verified and l.is_current;
  select count(*)::int
    into v_enabled_link_count
    from public.direct_entry_app_user_recruiter_links l
    join public.direct_entry_app_users au on au.app_user_id = l.app_user_id
   where l.recruiter_id = p_manager_recruiter_id
     and l.verified and l.is_current
     and au.enabled and au.auth_subject is not null;
  if v_link_count <> 1 or v_enabled_link_count <> 1 then
    raise exception 'project manager must have exactly one enabled verified account link'
      using errcode = '22023';
  end if;
  if exists (
    select 1 from public.direct_entry_project_manager_assignments a
     where a.project_id = p_project_id
       and a.manager_recruiter_id = p_manager_recruiter_id
       and a.is_current and a.revoked_at is null
  ) then
    raise exception 'project manager is already assigned to this project'
      using errcode = '23505';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  v_before := public.direct_entry_project_snapshot(v_project);
  insert into public.direct_entry_project_manager_assignments
    (project_id, manager_recruiter_id, valid_from, valid_to,
     created_by_user_id, reason_id, version, is_current)
  values
    (p_project_id, p_manager_recruiter_id, v_valid_from, null,
     p_app_user_id, v_reason_id, 1, true)
  returning assignment_id into v_assignment_id;

  select b.project_version, b.revision_id
    into v_project_version, v_revision_id
    from public.direct_entry_bump_project_version(
      p_project_id, p_app_user_id, v_reason_id, v_before,
      jsonb_set(
        public.direct_entry_project_snapshot(v_project),
        '{assignment_change}',
        jsonb_build_object(
          'change', 'ASSIGN',
          'assignment_id', v_assignment_id,
          'manager_recruiter_id', p_manager_recruiter_id,
          'valid_from', v_valid_from,
          'valid_to', null
        ),
        true
      )
    ) b;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     scope_team_id, outcome, reason_id, changed_fields, project_revision_id)
  values
    (p_auth_subject, p_app_user_id, 'project_manager_assignment_assign',
     v_authority, v_assignment_id::text,
     case when v_authority = 'team_manager_assign' then 'team' else 'all' end,
     case when v_authority = 'team_manager_assign' then v_team_id else null end,
     'APPLIED', v_reason_id,
     array['project_id', 'manager_recruiter_id', 'valid_from'], v_revision_id);

  v_result := jsonb_build_object(
    'assignment_id', v_assignment_id,
    'project_id', p_project_id,
    'manager_recruiter_id', p_manager_recruiter_id,
    'valid_from', v_valid_from,
    'valid_to', null,
    'version', 1,
    'project_version', v_project_version,
    'already_assigned', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_manager_assignment_assign', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_grant_project_team_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_team_id uuid,
  p_expected_pair_version integer,
  p_effective_from date,
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
  v_project public.direct_entry_projects;
  v_team public.teams;
  v_effective_from date;
  v_current_version integer;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_mapping public.direct_entry_project_team_scopes;
  v_result jsonb;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_project_id is null or length(btrim(p_project_id)) = 0 then
    raise exception 'project required' using errcode = '22023';
  end if;
  if p_team_id is null then
    raise exception 'team required' using errcode = '22023';
  end if;
  if p_expected_pair_version is null or p_expected_pair_version < 0 then
    raise exception 'expected mapping version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Canonical Full Admin triple at effective all scope; resolved server-side only.
  v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'project_id', p_project_id,
    'team_id', p_team_id,
    'expected_pair_version', p_expected_pair_version,
    'valid_from', p_effective_from,
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_team_scope_grant', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_effective_from := coalesce(p_effective_from, public.direct_entry_authorization_date());
  if v_effective_from > public.direct_entry_authorization_date() then
    raise exception 'future project-team scopes require explicit activation' using errcode = '22023';
  end if;
  if v_effective_from < public.direct_entry_authorization_date() then
    raise exception 'past project-team scopes are not allowed' using errcode = '22023';
  end if;

  -- Lock order: project row first, then the target team row.
  select p.* into v_project
    from public.direct_entry_projects p
   where p.project_id = p_project_id
   for update;
  if not found then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  if not v_project.active then
    raise exception 'project is not active' using errcode = '22023';
  end if;

  select t.* into v_team
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team not found' using errcode = 'P0002';
  end if;
  if not v_team.active or v_team.code = '__system_vendor__' then
    raise exception 'team is not active' using errcode = '22023';
  end if;

  select coalesce(max(s.version), 0)::int into v_current_version
    from public.direct_entry_project_team_scopes s
   where s.project_id = p_project_id
     and s.team_id = p_team_id;
  if v_current_version <> p_expected_pair_version then
    raise exception 'project team mapping version conflict' using errcode = 'PT409';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  insert into public.direct_entry_project_team_scopes (
    project_id, team_id, valid_from, valid_to, version,
    granted_by_user_id, reason_id, is_current
  ) values (
    p_project_id, p_team_id, v_effective_from, null, v_current_version + 1,
    p_app_user_id, v_reason_id, true
  ) returning * into v_mapping;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields)
  values
    (p_auth_subject, p_app_user_id, 'project_team_scope_grant', v_authority,
     v_mapping.mapping_id::text, 'all', 'APPLIED', v_reason_id,
     array['project_id', 'team_id', 'valid_from']);

  v_result := jsonb_build_object(
    'mapping_id', v_mapping.mapping_id,
    'project_id', v_mapping.project_id,
    'team_id', v_mapping.team_id,
    'valid_from', v_mapping.valid_from,
    'valid_to', v_mapping.valid_to,
    'version', v_mapping.version,
    'created', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_team_scope_grant', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_revoke_project_team_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_mapping_id uuid,
  p_expected_pair_version integer,
  p_effective_to date,
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
  v_project_id text;
  v_project public.direct_entry_projects;
  v_mapping public.direct_entry_project_team_scopes;
  v_revoke_to date;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_result jsonb;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_mapping_id is null then
    raise exception 'mapping required' using errcode = '22023';
  end if;
  if p_expected_pair_version is null or p_expected_pair_version < 1 then
    raise exception 'expected mapping version required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  -- Canonical Full Admin triple at effective all scope; resolved server-side only.
  v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'mapping_id', p_mapping_id,
    'expected_pair_version', p_expected_pair_version,
    'effective_to', p_effective_to,
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_team_scope_revoke', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if p_effective_to is not null
     and p_effective_to > public.direct_entry_authorization_date() then
    raise exception 'revoke date must not be in the future' using errcode = '22023';
  end if;
  if p_effective_to is not null
     and p_effective_to < public.direct_entry_authorization_date() then
    raise exception 'revoke date must not be in the past' using errcode = '22023';
  end if;

  -- Mapping identity is immutable: this unlocked read discovers only the project.
  -- Lock order is always project row first, mapping row second.
  select s.project_id into v_project_id
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id;
  if v_project_id is null then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;

  select p.* into v_project
    from public.direct_entry_projects p
   where p.project_id = v_project_id
   for update;
  if not found then
    raise exception 'project not found' using errcode = 'P0002';
  end if;

  select s.* into v_mapping
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id
   for update;
  if not found then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;
  if not v_mapping.is_current or v_mapping.revoked_at is not null then
    raise exception 'project team mapping is already revoked' using errcode = '22023';
  end if;
  if v_mapping.version <> p_expected_pair_version then
    raise exception 'project team mapping version conflict' using errcode = 'PT409';
  end if;

  -- An explicit end date must not precede the grant. valid_to = valid_from is the
  -- audited same-day cancellation marker and is only armed here.
  if p_effective_to is not null and p_effective_to < v_mapping.valid_from then
    raise exception 'revoke date must not precede the mapping start' using errcode = '22023';
  end if;
  v_revoke_to := greatest(
    coalesce(p_effective_to, public.direct_entry_authorization_date()),
    v_mapping.valid_from
  );

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  if v_revoke_to = v_mapping.valid_from then
    perform set_config('direct_entry.project_team_scope_marker', 'on', true);
  end if;
  update public.direct_entry_project_team_scopes
     set valid_to = v_revoke_to,
         revoked_by_user_id = p_app_user_id,
         revoked_at = now(),
         revoke_reason_id = v_reason_id,
         version = version + 1
   where mapping_id = p_mapping_id
  returning * into v_mapping;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields)
  values
    (p_auth_subject, p_app_user_id, 'project_team_scope_revoke', v_authority,
     p_mapping_id::text, 'all', 'APPLIED', v_reason_id, array['valid_to']);

  v_result := jsonb_build_object(
    'mapping_id', v_mapping.mapping_id,
    'project_id', v_mapping.project_id,
    'team_id', v_mapping.team_id,
    'valid_to', v_mapping.valid_to,
    'version', v_mapping.version,
    'revoked', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_team_scope_revoke', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

create or replace function public.direct_entry_revoke_project_team_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_mapping_id uuid,
  p_effective_to date,
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
  v_project_id text;
  v_mapping public.direct_entry_project_team_scopes;
  v_revoke_to date;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_result jsonb;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_mapping_id is null then
    raise exception 'mapping required' using errcode = '22023';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;

  v_authority := public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'mapping_id', p_mapping_id,
    'effective_to', p_effective_to,
    'reason', p_reason
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'project_team_scope_revoke_v2', p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if p_effective_to is not null
     and p_effective_to > public.direct_entry_authorization_date() then
    raise exception 'revoke date must not be in the future' using errcode = '22023';
  end if;
  if p_effective_to is not null
     and p_effective_to < public.direct_entry_authorization_date() then
    raise exception 'revoke date must not be in the past' using errcode = '22023';
  end if;

  select s.project_id into v_project_id
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id;
  if v_project_id is null then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;

  -- Immutable mapping identity; project then mapping row is the migration #94 lock order.
  perform p.project_id
    from public.direct_entry_projects p
   where p.project_id = v_project_id
   for update;
  if not found then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  select s.* into v_mapping
    from public.direct_entry_project_team_scopes s
   where s.mapping_id = p_mapping_id
   for update;
  if not found then
    raise exception 'project team mapping not found' using errcode = 'P0002';
  end if;
  if not v_mapping.is_current or v_mapping.revoked_at is not null then
    raise exception 'project team mapping is already revoked' using errcode = '22023';
  end if;
  if p_effective_to is not null and p_effective_to < v_mapping.valid_from then
    raise exception 'revoke date must not precede the mapping start' using errcode = '22023';
  end if;
  v_revoke_to := greatest(
    coalesce(p_effective_to, public.direct_entry_authorization_date()),
    v_mapping.valid_from
  );

  v_reason_id := public.direct_entry_reason(p_app_user_id, p_reason);
  if v_revoke_to = v_mapping.valid_from then
    perform set_config('direct_entry.project_team_scope_marker', 'on', true);
  end if;
  update public.direct_entry_project_team_scopes
     set valid_to = v_revoke_to,
         revoked_by_user_id = p_app_user_id,
         revoked_at = now(),
         revoke_reason_id = v_reason_id,
         version = version + 1
   where mapping_id = p_mapping_id
  returning * into v_mapping;

  insert into public.direct_entry_audit_events
    (auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
     outcome, reason_id, changed_fields)
  values
    (p_auth_subject, p_app_user_id, 'project_team_scope_revoke', v_authority,
     p_mapping_id::text, 'all', 'APPLIED', v_reason_id, array['valid_to']);

  v_result := jsonb_build_object(
    'mapping_id', v_mapping.mapping_id,
    'project_id', v_mapping.project_id,
    'team_id', v_mapping.team_id,
    'valid_to', v_mapping.valid_to,
    'version', v_mapping.version,
    'revoked', true
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'project_team_scope_revoke_v2', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

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
  v_payload_hash text;
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
  v_next_capability_start date;
  v_next_scope_start date;
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
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then return v_prior; end if;

  v_valid_from := coalesce(p_valid_from, v_today);
  if v_valid_from <> v_today then
    raise exception 'provider valid from is invalid' using errcode = '22023';
  end if;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref
   for update;
  if not found then raise exception 'account not found' using errcode = 'P0002'; end if;
  if not v_account.enabled then raise exception 'account is not enabled' using errcode = '23514'; end if;
  select lower(nullif(split_part(u.email, '@', 1), '')) into v_login_id
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
  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;
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

  foreach v_capability in array array[
    'entry_create', 'entry_own', 'submission_create', 'change_request_create',
    'employment_status.request', 'document_upload', 'document_view'
  ]::text[]
  loop
    if not exists (
      select 1 from public.direct_entry_capability_grants g
       where g.app_user_id = p_account_ref and g.capability = v_capability
         and g.is_current
    ) then
      select min(g.valid_from) into v_next_capability_start
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_account_ref and g.capability = v_capability
         and g.valid_from > v_today;
      insert into public.direct_entry_capability_grants
        (app_user_id, capability, valid_from, valid_to, is_current)
      values (p_account_ref, v_capability, v_today, v_next_capability_start, true);
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
      ) values (
        p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
        p_account_ref::text, 'APPLIED', v_reason_id, array['valid_from', 'valid_to']
      );
    end if;
  end loop;

  if not exists (
    select 1 from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref and g.scope_kind = 'own'
       and g.is_current
  ) then
    select min(g.valid_from) into v_next_scope_start
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref and g.scope_kind = 'own'
       and g.valid_from > v_today;
    insert into public.direct_entry_scope_grants (app_user_id, scope_kind, valid_from, valid_to, is_current)
    values (p_account_ref, 'own', v_today, v_next_scope_start, true);
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id, changed_fields
    ) values (
      p_auth_subject, p_actor_app_user_id, 'scope_default_grant', 'entry_own',
      p_account_ref::text, 'own', 'APPLIED', v_reason_id, array['scope_kind', 'valid_from', 'valid_to']
    );
  end if;

  update public.direct_entry_app_users set version = version + 1, updated_at = now()
   where app_user_id = p_account_ref returning version into v_account.version;
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
  perform public.direct_entry_idempotency_finish(p_actor_app_user_id, v_action, p_idempotency_key, v_result);
  return v_result;
end;
$function$;

create or replace function public.attendance_assign_employee_slot_policy_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_app_user_id uuid,
  p_profile_id uuid,
  p_effective_date date,
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
  v_today_vn date := coalesce(
    nullif(current_setting('direct_entry.test_authorization_date', true), '')::date,
    (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  );
  v_effective_date date := coalesce(p_effective_date, v_today_vn);
  v_existing public.attendance_slot_policy_assignments%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_profile public.attendance_slot_policy_profiles%rowtype;
  v_open public.attendance_slot_policy_assignments%rowtype;
  v_saved public.attendance_slot_policy_assignments%rowtype;
  v_ident record;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if not v_can_manage then
    raise exception 'ATTENDANCE_SLOT_POLICY_WRITE_DENIED'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  if p_target_app_user_id is null
     or p_profile_id is null then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_slot_policy_assignments_user'),
    hashtext(p_target_app_user_id::text)
  );

  select *
    into v_existing
  from public.attendance_slot_policy_assignments a
  where a.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;

    select *
      into v_profile
    from public.attendance_slot_policy_profiles pr
    where pr.profile_id = v_existing.profile_id;

    select *
      into v_target_user
    from public.direct_entry_app_users u
    where u.app_user_id = v_existing.app_user_id;

    select *
      into v_ident
    from public.attendance__internal_resolve_employee_identity(v_existing.app_user_id);

    return jsonb_build_object(
      'replayed', true,
      'assignment', jsonb_build_object(
        'assignment_id', v_existing.assignment_id,
        'app_user_id', v_existing.app_user_id,
        'employee_display_name', v_ident.employee_display_name,
        'personnel_code', v_ident.personnel_code,
        'enabled', v_target_user.enabled,
        'profile_id', v_profile.profile_id,
        'profile_code', v_profile.profile_code,
        'profile_name', v_profile.display_name,
        'valid_from', pg_catalog.to_char(v_existing.valid_from, 'YYYY-MM-DD'),
        'valid_to', case when v_existing.valid_to is null then null else pg_catalog.to_char(v_existing.valid_to, 'YYYY-MM-DD') end,
        'superseded_same_day', v_existing.superseded_same_day,
        'effective', (
          not v_existing.superseded_same_day
          and v_existing.valid_from <= v_today_vn
          and (v_existing.valid_to is null or v_today_vn <= v_existing.valid_to)
          and v_profile.active = true
        ),
        'version', v_existing.version
      )
    );
  end if;

  if v_effective_date > v_today_vn then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE'
      using errcode = '22023',
            detail = 'Slot policy profile assignment takes effect immediately and cannot be scheduled in the future.';
  end if;

  if v_effective_date < v_today_vn then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_PAST_DATE'
      using errcode = '22023',
            detail = 'Slot policy profile assignment takes effect immediately today and cannot retroactively alter past dates.';
  end if;

  select *
    into v_target_user
  from public.direct_entry_app_users u
  where u.app_user_id = p_target_app_user_id
  for update;

  if not found or v_target_user.enabled is distinct from true then
    raise exception 'ATTENDANCE_SLOT_POLICY_TARGET_USER_INVALID'
      using errcode = '22023';
  end if;

  select *
    into v_profile
  from public.attendance_slot_policy_profiles pr
  where pr.profile_id = p_profile_id
  for share;

  if not found then
    raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_profile.is_default then
    raise exception 'ATTENDANCE_SLOT_POLICY_DEFAULT_ASSIGNMENT_REDUNDANT'
      using errcode = '22023';
  end if;

  if not v_profile.active then
    raise exception 'ATTENDANCE_SLOT_POLICY_PROFILE_INACTIVE'
      using errcode = '22023';
  end if;

  select *
    into v_open
  from public.attendance_slot_policy_assignments a
  where a.app_user_id = p_target_app_user_id
    and a.valid_to is null
    and not a.superseded_same_day
  order by a.valid_from desc, a.assigned_at desc
  limit 1
  for update;

  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  if (v_open.assignment_id is null and p_expected_version <> 0)
     or (v_open.assignment_id is not null and v_open.version <> p_expected_version) then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_open.assignment_id is not null then
    if v_open.valid_from > v_effective_date then
      raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_DATE_ORDER_INVALID'
        using errcode = '22023';
    end if;

    if v_open.valid_from = v_effective_date then
      update public.attendance_slot_policy_assignments a
      set valid_to = v_effective_date,
          superseded_same_day = true,
          revoked_by_user_id = p_app_user_id,
          revoked_at = clock_timestamp(),
          version = a.version + 1,
          updated_at = clock_timestamp()
      where a.assignment_id = v_open.assignment_id;
    else
      update public.attendance_slot_policy_assignments a
      set valid_to = (v_effective_date - 1),
          superseded_same_day = false,
          revoked_by_user_id = p_app_user_id,
          revoked_at = clock_timestamp(),
          version = a.version + 1,
          updated_at = clock_timestamp()
      where a.assignment_id = v_open.assignment_id;
    end if;
  end if;

  begin
    insert into public.attendance_slot_policy_assignments (
      app_user_id,
      profile_id,
      valid_from,
      valid_to,
      superseded_same_day,
      version,
      assigned_by_user_id,
      assigned_at,
      idempotency_key,
      request_fingerprint
    )
    values (
      p_target_app_user_id,
      p_profile_id,
      v_effective_date,
      null,
      false,
      1,
      p_app_user_id,
      clock_timestamp(),
      p_idempotency_key,
      p_request_fingerprint
    )
    returning * into v_saved;
  exception
    when exclusion_violation or unique_violation then
      raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_OVERLAP'
        using errcode = 'PT409';
  end;

  select *
    into v_ident
  from public.attendance__internal_resolve_employee_identity(p_target_app_user_id);

  insert into public.direct_entry_audit_events (
    auth_subject,
    app_user_id,
    action,
    capability,
    resource_ref,
    scope_kind,
    outcome,
    changed_fields
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'attendance_slot_policy_assign',
    'entry_admin',
    'attendance_slot_policy_assignment:' || v_saved.assignment_id::text,
    'all',
    'APPLIED',
    array[
      'target_app_user_id:' || p_target_app_user_id::text,
      'profile_code:' || v_profile.profile_code,
      'valid_from:' || v_saved.valid_from::text
    ]
  );

  return jsonb_build_object(
    'replayed', false,
    'assignment', jsonb_build_object(
      'assignment_id', v_saved.assignment_id,
      'app_user_id', v_saved.app_user_id,
      'employee_display_name', v_ident.employee_display_name,
      'personnel_code', v_ident.personnel_code,
      'enabled', v_target_user.enabled,
      'profile_id', v_profile.profile_id,
      'profile_code', v_profile.profile_code,
      'profile_name', v_profile.display_name,
      'valid_from', pg_catalog.to_char(v_saved.valid_from, 'YYYY-MM-DD'),
      'valid_to', case when v_saved.valid_to is null then null else pg_catalog.to_char(v_saved.valid_to, 'YYYY-MM-DD') end,
      'superseded_same_day', v_saved.superseded_same_day,
      'effective', (
        not v_saved.superseded_same_day
        and v_saved.valid_from <= v_today_vn
        and (v_saved.valid_to is null or v_today_vn <= v_saved.valid_to)
        and v_profile.active = true
      ),
      'version', v_saved.version
    )
  );
end;
$$;

create or replace function public.attendance_unassign_employee_slot_policy_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_effective_date date,
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
  v_today_vn date := coalesce(
    nullif(current_setting('direct_entry.test_authorization_date', true), '')::date,
    (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date
  );
  v_effective_date date := coalesce(p_effective_date, v_today_vn);
  v_existing public.attendance_slot_policy_assignments%rowtype;
  v_current public.attendance_slot_policy_assignments%rowtype;
  v_updated public.attendance_slot_policy_assignments%rowtype;
  v_profile public.attendance_slot_policy_profiles%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_ident record;
begin
  v_can_manage := public.attendance__internal_assert_report_reader(
    p_auth_subject,
    p_app_user_id
  );

  if not v_can_manage then
    raise exception 'ATTENDANCE_SLOT_POLICY_WRITE_DENIED'
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
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('attendance_slot_policy_assignments_unassign'),
    hashtext(p_assignment_id::text)
  );

  select *
    into v_existing
  from public.attendance_slot_policy_assignments a
  where a.revoke_idempotency_key = p_idempotency_key;

  if found then
    if v_existing.revoke_request_fingerprint <> p_request_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;

    select *
      into v_profile
    from public.attendance_slot_policy_profiles pr
    where pr.profile_id = v_existing.profile_id;

    select *
      into v_target_user
    from public.direct_entry_app_users u
    where u.app_user_id = v_existing.app_user_id;

    select *
      into v_ident
    from public.attendance__internal_resolve_employee_identity(v_existing.app_user_id);

    return jsonb_build_object(
      'replayed', true,
      'assignment', jsonb_build_object(
        'assignment_id', v_existing.assignment_id,
        'app_user_id', v_existing.app_user_id,
        'employee_display_name', v_ident.employee_display_name,
        'personnel_code', v_ident.personnel_code,
        'enabled', v_target_user.enabled,
        'profile_id', v_profile.profile_id,
        'profile_code', v_profile.profile_code,
        'profile_name', v_profile.display_name,
        'valid_from', pg_catalog.to_char(v_existing.valid_from, 'YYYY-MM-DD'),
        'valid_to', case when v_existing.valid_to is null then null else pg_catalog.to_char(v_existing.valid_to, 'YYYY-MM-DD') end,
        'superseded_same_day', v_existing.superseded_same_day,
        'effective', false,
        'version', v_existing.version
      )
    );
  end if;

  if v_effective_date > v_today_vn then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_FUTURE_DATE'
      using errcode = '22023',
            detail = 'Slot policy profile unassignment takes effect immediately and cannot be scheduled in the future.';
  end if;

  if v_effective_date < v_today_vn then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_PAST_DATE'
      using errcode = '22023',
            detail = 'Slot policy profile unassignment takes effect immediately today and cannot retroactively alter past dates.';
  end if;

  select *
    into v_current
  from public.attendance_slot_policy_assignments a
  where a.assignment_id = p_assignment_id
  for update;

  if not found then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_current.version <> p_expected_version then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_current.valid_to is not null or v_current.superseded_same_day then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_ALREADY_CLOSED'
      using errcode = 'PT409';
  end if;

  if v_effective_date < v_current.valid_from then
    raise exception 'ATTENDANCE_SLOT_POLICY_ASSIGNMENT_RANGE_INVALID'
      using errcode = '22023';
  end if;

  if v_effective_date = v_current.valid_from then
    update public.attendance_slot_policy_assignments a
    set valid_to = v_effective_date,
        superseded_same_day = true,
        revoked_by_user_id = p_app_user_id,
        revoked_at = clock_timestamp(),
        revoke_idempotency_key = p_idempotency_key,
        revoke_request_fingerprint = p_request_fingerprint,
        version = a.version + 1,
        updated_at = clock_timestamp()
    where a.assignment_id = p_assignment_id
    returning * into v_updated;
  else
    update public.attendance_slot_policy_assignments a
    set valid_to = (v_effective_date - 1),
        superseded_same_day = false,
        revoked_by_user_id = p_app_user_id,
        revoked_at = clock_timestamp(),
        revoke_idempotency_key = p_idempotency_key,
        revoke_request_fingerprint = p_request_fingerprint,
        version = a.version + 1,
        updated_at = clock_timestamp()
    where a.assignment_id = p_assignment_id
    returning * into v_updated;
  end if;

  select *
    into v_profile
  from public.attendance_slot_policy_profiles pr
  where pr.profile_id = v_updated.profile_id;

  select *
    into v_target_user
  from public.direct_entry_app_users u
  where u.app_user_id = v_updated.app_user_id;

  select *
    into v_ident
  from public.attendance__internal_resolve_employee_identity(v_updated.app_user_id);

  insert into public.direct_entry_audit_events (
    auth_subject,
    app_user_id,
    action,
    capability,
    resource_ref,
    scope_kind,
    outcome,
    changed_fields
  )
  values (
    p_auth_subject,
    p_app_user_id,
    'attendance_slot_policy_unassign',
    'entry_admin',
    'attendance_slot_policy_assignment:' || v_updated.assignment_id::text,
    'all',
    'APPLIED',
    array[
      'target_app_user_id:' || v_updated.app_user_id::text,
      'profile_code:' || v_profile.profile_code,
      'valid_to:' || v_updated.valid_to::text,
      'superseded_same_day:' || v_updated.superseded_same_day::text
    ]
  );

  return jsonb_build_object(
    'replayed', false,
    'assignment', jsonb_build_object(
      'assignment_id', v_updated.assignment_id,
      'app_user_id', v_updated.app_user_id,
      'employee_display_name', v_ident.employee_display_name,
      'personnel_code', v_ident.personnel_code,
      'enabled', v_target_user.enabled,
      'profile_id', v_profile.profile_id,
      'profile_code', v_profile.profile_code,
      'profile_name', v_profile.display_name,
      'valid_from', pg_catalog.to_char(v_updated.valid_from, 'YYYY-MM-DD'),
      'valid_to', case when v_updated.valid_to is null then null else pg_catalog.to_char(v_updated.valid_to, 'YYYY-MM-DD') end,
      'superseded_same_day', v_updated.superseded_same_day,
      'effective', false,
      'version', v_updated.version
    )
  );
end;
$$;

alter table public.work_report_delegations
  alter column effective_to drop not null;

create or replace function public.work_report__internal_is_delegation_effective(
  p_delegation_id uuid,
  p_as_of timestamptz default statement_timestamp()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_del public.work_report_delegations%rowtype;
begin
  select * into v_del
    from public.work_report_delegations d
   where d.delegation_id = p_delegation_id;
  if not found then
    return false;
  end if;
  if v_del.state <> 'ACTIVE' or not v_del.is_current then
    return false;
  end if;
  if p_as_of < v_del.effective_from
     or (v_del.effective_to is not null and p_as_of > v_del.effective_to) then
    return false;
  end if;
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = v_del.delegate_app_user_id and u.enabled
  ) then
    return false;
  end if;
  if not exists (
    select 1 from public.work_report_templates t
     where t.template_id = v_del.template_id
       and t.status = 'ACTIVE'
       and t.current_published_version_id is not null
  ) then
    return false;
  end if;
  if v_del.scope_kind = 'team' then
    if not exists (
      select 1 from public.teams tm where tm.team_id = v_del.scope_team_id and tm.active
    ) then
      return false;
    end if;
    if public.work_report_current_team(v_del.delegate_app_user_id) is distinct from v_del.scope_team_id
       and not exists (
         select 1 from public.direct_entry_scope_grants sg
          where sg.app_user_id = v_del.delegate_app_user_id
            and sg.scope_kind = 'team'
            and sg.team_id = v_del.scope_team_id
            and sg.is_current
       ) then
      return false;
    end if;
  end if;
  if not public.work_report__internal_has_direct_scope(
    v_del.grantor_user_id, 'report_delegate', v_del.scope_kind, v_del.scope_team_id
  ) then
    return false;
  end if;
  if not public.work_report__internal_has_direct_scope(
    v_del.grantor_user_id, v_del.capability, v_del.scope_kind, v_del.scope_team_id
  ) then
    return false;
  end if;
  return true;
end;
$function$;

create or replace function public.work_report__internal_resolve_capability_authority(
  p_app_user_id uuid,
  p_capability text,
  p_template_id uuid,
  p_team_id uuid,
  p_as_of timestamptz default statement_timestamp()
)
returns table(
  acting_scope_kind text,
  acting_team_id uuid,
  delegation_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_delegation_id uuid;
  v_del_scope_kind text;
  v_del_team_id uuid;
begin
  if public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    if public.direct_entry_has_scope(p_app_user_id, 'all') then
      return query select 'all'::text, null::uuid, null::uuid;
      return;
    end if;
    if p_team_id is not null and exists (
      select 1
        from public.direct_entry_scope_grants s
        join public.teams t on t.team_id = s.team_id and t.active
       where s.app_user_id = p_app_user_id
         and s.scope_kind = 'team'
         and s.team_id = p_team_id
         and s.is_current
    ) then
      return query select 'team'::text, p_team_id, null::uuid;
      return;
    end if;
  end if;

  if p_capability in ('report_assign', 'report_review') and p_template_id is not null then
    select d.delegation_id,
           d.scope_kind,
           case when d.scope_kind = 'team' then d.scope_team_id else null end
      into v_delegation_id, v_del_scope_kind, v_del_team_id
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = p_capability
       and d.template_id = p_template_id
       and d.state = 'ACTIVE'
       and d.is_current
       and p_as_of >= d.effective_from
       and (d.effective_to is null or p_as_of <= d.effective_to)
       and (
         d.scope_kind = 'all'
         or (d.scope_kind = 'team' and p_team_id is not null and d.scope_team_id = p_team_id)
       )
       and public.work_report__internal_is_delegation_effective(d.delegation_id, p_as_of)
     order by case when d.scope_kind = 'all' then 0 else 1 end, d.created_at desc, d.delegation_id desc
     limit 1;

    if v_delegation_id is not null then
      return query select v_del_scope_kind, v_del_team_id, v_delegation_id;
      return;
    end if;
  end if;
end;
$function$;

create or replace function public.work_report__internal_has_any_capability_authority(
  p_app_user_id uuid,
  p_capability text,
  p_as_of timestamptz default statement_timestamp()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    if public.direct_entry_has_scope(p_app_user_id, 'all') then
      return true;
    end if;
    if exists (
      select 1
        from public.direct_entry_scope_grants s
        join public.teams t on t.team_id = s.team_id and t.active
       where s.app_user_id = p_app_user_id
         and s.scope_kind = 'team'
         and s.is_current
    ) then
      return true;
    end if;
  end if;

  if p_capability in ('report_assign', 'report_review') and exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = p_capability
       and d.state = 'ACTIVE'
       and d.is_current
       and p_as_of >= d.effective_from
       and (d.effective_to is null or p_as_of <= d.effective_to)
       and public.work_report__internal_is_delegation_effective(d.delegation_id, p_as_of)
  ) then
    return true;
  end if;

  return false;
end;
$function$;

drop function if exists public.work_report_create_delegation(
  uuid,
  uuid,
  text,
  uuid,
  uuid,
  text,
  uuid,
  timestamptz,
  timestamptz,
  text
);

create or replace function public.work_report_create_delegation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text,
  p_delegate_app_user_id uuid,
  p_template_id uuid,
  p_scope_kind text,
  p_scope_team_id uuid,
  p_effective_from timestamptz default null,
  p_effective_to timestamptz default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_delegation_id uuid;
  v_effective_from timestamptz;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');

  if p_capability is null or p_capability not in ('report_assign', 'report_review') then
    raise exception 'WORK_REPORT_DELEGATION_CAPABILITY_INVALID' using errcode = '22023';
  end if;

  if not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_delegate_app_user_id is null
     or p_template_id is null
     or p_scope_kind is null
     or p_scope_kind not in ('all', 'team')
     or p_effective_from is not null
     or p_effective_to is not null
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_DELEGATION_INVALID' using errcode = '22023';
  end if;

  if (p_scope_kind = 'all' and p_scope_team_id is not null)
     or (p_scope_kind = 'team' and p_scope_team_id is null) then
    raise exception 'WORK_REPORT_DELEGATION_SCOPE_INVALID' using errcode = '22023';
  end if;

  if p_delegate_app_user_id = p_app_user_id then
    raise exception 'WORK_REPORT_SELF_DELEGATION_FORBIDDEN' using errcode = '22023';
  end if;

  if not public.work_report__internal_has_direct_scope(p_app_user_id, 'report_delegate', p_scope_kind, p_scope_team_id)
     or not public.work_report__internal_has_direct_scope(p_app_user_id, p_capability, p_scope_kind, p_scope_team_id) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'capability', p_capability,
    'delegate_app_user_id', p_delegate_app_user_id,
    'template_id', p_template_id,
    'scope_kind', p_scope_kind,
    'scope_id', p_scope_team_id
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_delegation_create', p_idempotency_key, v_request_hash);
  if v_prior is not null then
    return v_prior;
  end if;

  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_delegate_app_user_id and u.enabled
  ) then
    raise exception 'WORK_REPORT_DELEGATE_NOT_AVAILABLE' using errcode = '42501';
  end if;

  if p_scope_kind = 'team' then
    if public.work_report_current_team(p_delegate_app_user_id) is distinct from p_scope_team_id
       and not exists (
         select 1
           from public.direct_entry_scope_grants sg
          where sg.app_user_id = p_delegate_app_user_id
            and sg.scope_kind = 'team'
            and sg.team_id = p_scope_team_id
            and sg.is_current
       ) then
      raise exception 'WORK_REPORT_DELEGATE_OUTSIDE_SCOPE' using errcode = '42501';
    end if;
  end if;

  select * into v_template
    from public.work_report_templates
   where template_id = p_template_id
   for share;
  if not found or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;

  v_effective_from := statement_timestamp();

  insert into public.work_report_delegations
    (grantor_user_id, delegate_app_user_id, capability, template_id, template_version_id,
     scope_kind, scope_team_id, effective_from, effective_to, state, is_current, version)
  values
    (p_app_user_id, p_delegate_app_user_id, p_capability, p_template_id, v_template.current_published_version_id,
     p_scope_kind, p_scope_team_id, v_effective_from, null, 'ACTIVE', true, 1)
  returning delegation_id into v_delegation_id;

  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, scope_team_id, template_id, outcome, metadata_json)
  values
    ('DELEGATION_CREATE', p_app_user_id, 'report_delegate', p_scope_kind, p_scope_team_id, p_template_id, 'APPLIED',
     jsonb_build_object(
       'delegation_id', v_delegation_id,
       'delegated_capability', p_capability,
       'delegate_app_user_id', p_delegate_app_user_id,
       'effective_from', v_effective_from,
       'effective_to', null
     ));

  v_result := jsonb_build_object(
    'delegation_id', v_delegation_id,
    'status', 'ACTIVE',
    'state', 'ACTIVE',
    'effective_from', v_effective_from,
    'effective_to', null,
    'version', 1
  );
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_delegation_create', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

create or replace function public.work_report_list_delegations(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_all_scope boolean;
  v_as_of timestamptz := statement_timestamp();
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');
  v_all_scope := public.direct_entry_has_scope(p_app_user_id, 'all');

  if not v_all_scope and not exists (
    select 1
      from public.direct_entry_scope_grants s
      join public.teams t on t.team_id = s.team_id and t.active
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'team'
       and s.is_current
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'delegation_id', d.delegation_id,
        'grantor_user_id', d.grantor_user_id,
        'grantor_display_name', coalesce(public.work_report__internal_user_display_name(gu.app_user_id), gu.display_name),
        'capability', d.capability,
        'delegate_app_user_id', d.delegate_app_user_id,
        'delegate_display_name', coalesce(public.work_report__internal_user_display_name(du.app_user_id), du.display_name),
        'template_id', d.template_id,
        'template_code', t.template_code,
        'template_name', t.display_name,
        'template_version_id', d.template_version_id,
        'scope_kind', d.scope_kind,
        'scope_id', d.scope_team_id,
        'scope_team_id', d.scope_team_id,
        'scope_label', case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end,
        'effective_from', d.effective_from,
        'effective_to', d.effective_to,
        'revoked_at', d.revoked_at,
        'state', d.state,
        'status', case
          when d.state = 'REVOKED' or not d.is_current then 'REVOKED'
          when d.effective_to is not null and v_as_of > d.effective_to then 'EXPIRED'
          else 'ACTIVE'
        end,
        'is_current', d.is_current,
        'is_effective', public.work_report__internal_is_delegation_effective(d.delegation_id, v_as_of),
        'version', d.version,
        'created_at', d.created_at
      ) order by d.created_at desc, d.delegation_id desc)
        from public.work_report_delegations d
        join public.direct_entry_app_users gu on gu.app_user_id = d.grantor_user_id
        join public.direct_entry_app_users du on du.app_user_id = d.delegate_app_user_id
        join public.work_report_templates t on t.template_id = d.template_id
        left join public.teams tm on tm.team_id = d.scope_team_id
       where v_all_scope
          or d.grantor_user_id = p_app_user_id
          or (
            d.scope_kind = 'team'
            and exists (
              select 1
                from public.direct_entry_scope_grants s
                join public.teams scoped_team on scoped_team.team_id = s.team_id and scoped_team.active
               where s.app_user_id = p_app_user_id
                 and s.scope_kind = 'team'
                 and s.team_id = d.scope_team_id
                 and s.is_current
            )
          )
    ), '[]'::jsonb),
    'options', jsonb_build_object(
      'delegates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', del_opt.app_user_id,
          'display_name', del_opt.display_name
        ) order by del_opt.display_name, del_opt.app_user_id)
          from (
            select u.app_user_id,
                   coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name
              from public.direct_entry_app_users u
             where u.enabled
               and u.app_user_id <> p_app_user_id
               and (
                 v_all_scope
                 or exists (
                   select 1
                     from public.direct_entry_scope_grants s
                     join public.teams scoped_team on scoped_team.team_id = s.team_id and scoped_team.active
                    where s.app_user_id = p_app_user_id
                      and s.scope_kind = 'team'
                      and s.is_current
                      and s.team_id = public.work_report_current_team(u.app_user_id)
                 )
               )
          ) del_opt
      ), '[]'::jsonb),
      'templates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'template_id', t.template_id,
          'version_id', t.current_published_version_id,
          'name', t.display_name,
          'template_code', t.template_code,
          'display_name', t.display_name
        ) order by t.template_code)
          from public.work_report_templates t
         where t.status = 'ACTIVE'
           and t.current_published_version_id is not null
      ), '[]'::jsonb),
      'scopes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'scope_kind', sc.scope_kind,
          'scope_id', sc.scope_id,
          'label', sc.label
        ) order by sc.sort_order, sc.label)
          from (
            select 0 as sort_order, 'all'::text as scope_kind, null::uuid as scope_id, 'Toàn công ty'::text as label
             where v_all_scope
            union all
            select 1 as sort_order, 'team'::text as scope_kind, t.team_id as scope_id, coalesce(t.display_name, t.code) as label
              from public.teams t
             where t.active
               and (
                 v_all_scope
                 or exists (
                   select 1
                     from public.direct_entry_scope_grants s
                    where s.app_user_id = p_app_user_id
                      and s.scope_kind = 'team'
                      and s.team_id = t.team_id
                      and s.is_current
                 )
               )
          ) sc
      ), '[]'::jsonb),
      'capabilities', coalesce((
        select jsonb_agg(cap order by cap)
          from unnest(array['report_assign', 'report_review']::text[]) as cap
         where public.work_report__internal_has_direct_capability(p_app_user_id, cap)
      ), '[]'::jsonb)
    )
  );
end;
$function$;

create or replace function public.direct_entry_resolve_actor_context(p_auth_subject uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_app_user_id uuid;
  v_enabled boolean;
  v_review_scopes jsonb;
  v_team_leader_team_id uuid := null;
  v_allowed_worker_tabs jsonb := '[]'::jsonb;
begin
  select u.app_user_id, u.enabled
    into v_app_user_id, v_enabled
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject;
  if not found then return null; end if;

  select case when not u.enabled then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
      'kind', s.kind,
      'team_id', s.team_id,
      'label', s.label
    ) order by case when s.kind = 'all' then 0 else 1 end, s.label, s.team_id)
      from (
        select distinct
          raw_scopes.kind,
          raw_scopes.team_id,
          raw_scopes.label
        from (
          select 'all'::text as kind, null::uuid as team_id, 'Toàn công ty'::text as label
           where public.direct_entry_has_capability(u.app_user_id, 'report_review')
             and public.direct_entry_has_scope(u.app_user_id, 'all')
          union all
          select 'team'::text as kind, t.team_id, coalesce(t.display_name, t.code) as label
            from public.direct_entry_scope_grants g
            join public.teams t on t.team_id = g.team_id and t.active
           where public.direct_entry_has_capability(u.app_user_id, 'report_review')
             and g.app_user_id = u.app_user_id
             and g.scope_kind = 'team'
             and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
          union all
          select d.scope_kind as kind,
                 case when d.scope_kind = 'team' then d.scope_team_id else null end as team_id,
                 case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end as label
            from public.work_report_delegations d
            left join public.teams tm on tm.team_id = d.scope_team_id
           where d.delegate_app_user_id = u.app_user_id
             and d.capability = 'report_review'
             and d.state = 'ACTIVE'
             and d.is_current
             and statement_timestamp() >= d.effective_from
             and (d.effective_to is null or statement_timestamp() <= d.effective_to)
             and public.work_report__internal_is_delegation_effective(d.delegation_id, statement_timestamp())
        ) raw_scopes
      ) s
  ), '[]'::jsonb) end
    into v_review_scopes
    from public.direct_entry_app_users u
   where u.app_user_id = v_app_user_id;

  if v_enabled and public.direct_entry_has_capability(v_app_user_id, 'team_manager_assign') then
    begin
      v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
        p_auth_subject, v_app_user_id, null
      );
    exception when insufficient_privilege then
      v_team_leader_team_id := null;
    end;
  end if;

  if v_enabled then
    select coalesce(
      jsonb_agg(t.tab_id order by t.ord),
      '[]'::jsonb
    )
    into v_allowed_worker_tabs
    from (
      select 'uploader'::text as tab_id, 1 as ord
       where (
         (
           select count(*)::integer
             from public.direct_entry_scope_grants g
            where g.app_user_id = v_app_user_id
              and g.scope_kind = 'own'
              and g.team_id is null
              and g.is_current
         ) = 1
         and public.direct_entry_has_capability(v_app_user_id, 'submission_create')
       )
       or public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'recruited'::text as tab_id, 2 as ord
       where (
         select count(*)::integer
           from public.direct_entry_app_user_recruiter_links l
          where l.app_user_id = v_app_user_id
            and l.verified
            and l.is_current
       ) = 1
       and exists (
         select 1
           from public.direct_entry_app_user_recruiter_links l
           join public.recruiters r
             on r.recruiter_id = l.recruiter_id
            and r.active
          where l.app_user_id = v_app_user_id
            and l.verified
            and l.is_current
       )
      union all
      select 'managed'::text as tab_id, 3 as ord
       where public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'team'::text as tab_id, 4 as ord
       where v_team_leader_team_id is not null
      union all
      select 'all'::text as tab_id, 5 as ord
       where public.direct_entry_has_scope(v_app_user_id, 'all')
         and (
           public.direct_entry_has_capability(v_app_user_id, 'entry_admin')
           or public.direct_entry_has_capability(v_app_user_id, 'change_review')
         )
    ) t;
  end if;

  return (
    select jsonb_build_object(
      'auth_subject', u.auth_subject,
      'app_user_id', u.app_user_id,
      'display_name', u.display_name,
      'enabled', u.enabled,
      'capabilities', coalesce((
        select jsonb_agg(distinct g.capability order by g.capability)
          from public.direct_entry_capability_grants g
         where g.app_user_id = u.app_user_id
           and public.direct_entry__internal_capability_grant_effective(g.grant_id)
      ), '[]'::jsonb),
      'recruiter_links', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', l.app_user_id, 'recruiter_id', l.recruiter_id, 'verified', l.verified,
          'valid_from', l.valid_from, 'valid_to', l.valid_to
        ) order by l.valid_from, l.recruiter_id)
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
         where l.app_user_id = u.app_user_id and l.verified and l.is_current and u.enabled
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object('team_id', t.team_id, 'code', t.code,
          'display', t.display_name, 'active', t.active) order by t.team_id)
          from public.teams t
         where t.active and exists (
           select 1 from public.direct_entry_scope_grants g
            where g.app_user_id = u.app_user_id and g.scope_kind = 'team'
              and g.team_id = t.team_id
              and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
         )
      ), '[]'::jsonb),
      'team_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('team_id', g.team_id,
          'valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from, g.team_id)
          from public.direct_entry_scope_grants g
          join public.teams t on t.team_id = g.team_id and t.active
         where g.app_user_id = u.app_user_id
           and g.scope_kind = 'team'
           and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
      ), '[]'::jsonb),
      'all_scope_grants', coalesce((
        select jsonb_agg(jsonb_build_object('valid_from', g.valid_from, 'valid_to', g.valid_to) order by g.valid_from)
          from public.direct_entry_scope_grants g
         where g.app_user_id = u.app_user_id and g.scope_kind = 'all' and g.is_current and u.enabled
      ), '[]'::jsonb),
      'allowed_worker_tabs', v_allowed_worker_tabs
    ) || case
      when jsonb_array_length(v_review_scopes) > 0 then jsonb_build_object('effective_report_review_scopes', v_review_scopes)
      else '{}'::jsonb
    end
    from public.direct_entry_app_users u where u.app_user_id = v_app_user_id
  );
end;
$function$;

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
       'public.direct_entry_assign_project_manager(uuid,uuid,text,uuid,date,integer,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_grant_project_team_scope(uuid,uuid,text,uuid,integer,date,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,integer,date,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,date,text,text)'::pg_catalog.regprocedure,
       'public.direct_entry_account_operation_create_personnel(uuid,uuid,uuid,integer,text,text,date,text,text)'::pg_catalog.regprocedure,
       'public.org_department_assign_accounting_member(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
       'public.org_department_end_accounting_member(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
       'public.vendor_finance_assign_project_accountant_admin(uuid,uuid,text,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
       'public.vendor_finance_end_project_accountant_admin(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
       'public.vendor_finance_assign_global_role_admin(uuid,uuid,uuid,text,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
       'public.vendor_finance_end_global_role_admin(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
       'public.leave_management_set_department_approver_admin(uuid,uuid,text,uuid,date,integer,text,text,text)'::pg_catalog.regprocedure,
       'public.attendance_assign_employee_branch_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_unassign_employee_branch_admin(uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_assign_employee_slot_policy_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.attendance_unassign_employee_slot_policy_admin(uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
       'public.work_report__internal_is_delegation_effective(uuid,timestamptz)'::pg_catalog.regprocedure,
       'public.work_report__internal_resolve_capability_authority(uuid,text,uuid,uuid,timestamptz)'::pg_catalog.regprocedure,
       'public.work_report__internal_has_any_capability_authority(uuid,text,timestamptz)'::pg_catalog.regprocedure,
       'public.work_report_create_delegation(uuid,uuid,text,uuid,uuid,text,uuid,timestamptz,timestamptz,text)'::pg_catalog.regprocedure,
       'public.work_report_list_delegations(uuid,uuid)'::pg_catalog.regprocedure,
       'public.direct_entry_resolve_actor_context(uuid)'::pg_catalog.regprocedure
     )
  loop
    if v_proc_owner_oid is distinct from v_base_owner_oid
       and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
      execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
    end if;
  end loop;
end
$owner_align$;

revoke all on function
  public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text),
  public.direct_entry_grant_project_team_scope(uuid, uuid, text, uuid, integer, date, text, text),
  public.direct_entry_revoke_project_team_scope(uuid, uuid, uuid, integer, date, text, text),
  public.work_report__internal_is_delegation_effective(uuid, timestamptz),
  public.work_report__internal_resolve_capability_authority(uuid, text, uuid, uuid, timestamptz),
  public.work_report__internal_has_any_capability_authority(uuid, text, timestamptz)
from public, anon, authenticated, service_role;

revoke all on function
  public.direct_entry_assign_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text),
  public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text),
  public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text),
  public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text),
  public.direct_entry_revoke_project_team_scope(uuid, uuid, uuid, date, text, text),
  public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text),
  public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text),
  public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text),
  public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text),
  public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text),
  public.attendance_unassign_employee_branch_admin(uuid, uuid, uuid, date, integer, uuid, text),
  public.attendance_assign_employee_slot_policy_admin(uuid, uuid,uuid, uuid, date, integer, uuid, text),
  public.attendance_unassign_employee_slot_policy_admin(uuid, uuid, uuid, date, integer, uuid, text),
  public.work_report_create_delegation(uuid, uuid, text, uuid, uuid, text, uuid, timestamptz, timestamptz, text),
  public.work_report_list_delegations(uuid, uuid),
  public.direct_entry_resolve_actor_context(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.direct_entry_assign_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text),
  public.direct_entry_move_team_membership(uuid, uuid, uuid, uuid, date, integer, text, text),
  public.direct_entry_unassign_team_membership(uuid, uuid, uuid, date, integer, text, text),
  public.direct_entry_assign_project_manager(uuid, uuid, text, uuid, date, integer, text, text),
  public.direct_entry_revoke_project_team_scope(uuid, uuid, uuid, date, text, text),
  public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text),
  public.org_department_assign_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.org_department_end_accounting_member(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text),
  public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text),
  public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text),
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text),
  public.attendance_assign_employee_branch_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text),
  public.attendance_unassign_employee_branch_admin(uuid, uuid, uuid, date, integer, uuid, text),
  public.attendance_assign_employee_slot_policy_admin(uuid, uuid, uuid, uuid, date, integer, uuid, text),
  public.attendance_unassign_employee_slot_policy_admin(uuid, uuid, uuid, date, integer, uuid, text),
  public.work_report_create_delegation(uuid, uuid, text, uuid, uuid, text, uuid, timestamptz, timestamptz, text),
  public.work_report_list_delegations(uuid, uuid),
  public.direct_entry_resolve_actor_context(uuid)
to service_role;

do $self_check$
declare
  v_rpc_fn regprocedure;
  v_internal_fn regprocedure;
  v_secdef boolean;
  v_config text;
begin
  foreach v_rpc_fn in array array[
    'public.direct_entry_assign_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)'::pg_catalog.regprocedure,
    'public.direct_entry_move_team_membership(uuid,uuid,uuid,uuid,date,integer,text,text)'::pg_catalog.regprocedure,
    'public.direct_entry_unassign_team_membership(uuid,uuid,uuid,date,integer,text,text)'::pg_catalog.regprocedure,
    'public.direct_entry_assign_project_manager(uuid,uuid,text,uuid,date,integer,text,text)'::pg_catalog.regprocedure,
    'public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,date,text,text)'::pg_catalog.regprocedure,
    'public.direct_entry_account_operation_create_personnel(uuid,uuid,uuid,integer,text,text,date,text,text)'::pg_catalog.regprocedure,
    'public.org_department_assign_accounting_member(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
    'public.org_department_end_accounting_member(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
    'public.vendor_finance_assign_project_accountant_admin(uuid,uuid,text,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
    'public.vendor_finance_end_project_accountant_admin(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
    'public.vendor_finance_assign_global_role_admin(uuid,uuid,uuid,text,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
    'public.vendor_finance_end_global_role_admin(uuid,uuid,uuid,integer,date,text,uuid,text)'::pg_catalog.regprocedure,
    'public.leave_management_set_department_approver_admin(uuid,uuid,text,uuid,date,integer,text,text,text)'::pg_catalog.regprocedure,
    'public.attendance_assign_employee_branch_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
    'public.attendance_unassign_employee_branch_admin(uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
    'public.attendance_assign_employee_slot_policy_admin(uuid,uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
    'public.attendance_unassign_employee_slot_policy_admin(uuid,uuid,uuid,date,integer,uuid,text)'::pg_catalog.regprocedure,
    'public.work_report_create_delegation(uuid,uuid,text,uuid,uuid,text,uuid,timestamptz,timestamptz,text)'::pg_catalog.regprocedure,
    'public.work_report_list_delegations(uuid,uuid)'::pg_catalog.regprocedure,
    'public.direct_entry_resolve_actor_context(uuid)'::pg_catalog.regprocedure
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

  foreach v_internal_fn in array array[
    'public.direct_entry_apply_team_leader_mutation(uuid,uuid,uuid,uuid,date,integer,text,text,text,text)'::pg_catalog.regprocedure,
    'public.direct_entry_grant_project_team_scope(uuid,uuid,text,uuid,integer,date,text,text)'::pg_catalog.regprocedure,
    'public.direct_entry_revoke_project_team_scope(uuid,uuid,uuid,integer,date,text,text)'::pg_catalog.regprocedure,
    'public.work_report__internal_is_delegation_effective(uuid,timestamptz)'::pg_catalog.regprocedure,
    'public.work_report__internal_resolve_capability_authority(uuid,text,uuid,uuid,timestamptz)'::pg_catalog.regprocedure,
    'public.work_report__internal_has_any_capability_authority(uuid,text,timestamptz)'::pg_catalog.regprocedure
  ]
  loop
    if pg_catalog.has_function_privilege('public', v_internal_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_internal_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_internal_fn, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_internal_fn, 'EXECUTE') then
      raise exception 'WP1-S1 internal helper EXECUTE privilege drift on %', v_internal_fn
        using errcode = '55000';
    end if;
  end loop;
end
$self_check$;

commit;
