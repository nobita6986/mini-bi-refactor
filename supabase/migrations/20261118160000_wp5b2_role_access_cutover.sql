-- =============================================================================
-- WP5B-2: Cutover Helpers, Post-Cutover Propagators & Group A / AI / TL Enforcements
--
-- Forward migration applying after 20261114150000_wp5b1_role_effective_access_foundation.sql.
-- Preserves cutover_ready = false during migration apply (executed atomically by
-- scripts/wp5-cutover-role-access.mjs --apply --confirm-apply --expected-fingerprint ...).
-- Zero email literals or at-signs, zero savepoints, zero alter default privileges,
-- exact service_role RPC routine inventory preserved.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Effective Grant Resolver: add narrow Work Reports TL compatibility bridge
--    for report_review at CONTEXT_TEAM until WP8, while keeping generic
--    legacy_bridge_candidates strictly gated on (not v_user.authz_managed).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_authz__internal_resolve_effective_grants(
  p_app_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_has_active_person boolean := false;
  v_result jsonb := '[]'::jsonb;
begin
  if p_app_user_id is null then
    return '[]'::jsonb;
  end if;

  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  -- D10: disabled account ALWAYS resolves 0 effective grants, even if protected.
  if not found or not v_user.enabled then
    return '[]'::jsonb;
  end if;

  select exists (
    select 1
      from public.organization_account_person_links l
      join public.organization_persons p
        on p.person_id = l.person_id
       and p.status = 'ACTIVE'
     where l.app_user_id = p_app_user_id
       and l.ended_at is null
  ) into v_has_active_person;

  with
  role_bundle_grants as (
    select
      rc.capability,
      rc.scope_template as scope_kind,
      null::text as scope_id,
      'ROLE_BUNDLE'::text as source_type,
      ara.assignment_id::text as source_id,
      rc.scope_template as scope_label
    from public.authz_account_role_assignments ara
    join public.authz_role_definitions rd
      on rd.role_code = ara.role_code
    join public.authz_role_capabilities rc
      on rc.role_code = ara.role_code
    where ara.app_user_id = p_app_user_id
      and ara.ended_at is null
      and ara.started_at <= v_now
      and (not rd.requires_active_person or coalesce(v_has_active_person, false))
  ),
  direct_grant_items as (
    select
      g.capability,
      g.scope_kind,
      g.scope_id,
      'DIRECT_GRANT'::text as source_type,
      g.direct_grant_id::text as source_id,
      case
        when g.scope_kind in ('OWN', 'ALL') then g.scope_kind
        when g.scope_kind = 'CONTEXT_TEAM' then coalesce(tm.display_name, tm.code, g.scope_id)
        when g.scope_kind = 'CONTEXT_PROJECT' then coalesce(pr.display_name, g.scope_id)
        when g.scope_kind = 'CONTEXT_DEPARTMENT' then coalesce(dm.name, dm.code, g.scope_id)
        else g.scope_kind
      end as scope_label
    from public.authz_direct_capability_grants g
    left join public.teams tm
      on g.scope_kind = 'CONTEXT_TEAM'
     and tm.team_id::text = g.scope_id
    left join public.direct_entry_projects pr
      on g.scope_kind = 'CONTEXT_PROJECT'
     and pr.project_id = g.scope_id
    left join public.organization_departments dm
      on g.scope_kind = 'CONTEXT_DEPARTMENT'
     and dm.department_id::text = g.scope_id
    where g.app_user_id = p_app_user_id
      and g.ended_at is null
      and g.started_at <= v_now
      and (
        g.scope_kind in ('OWN', 'ALL')
        or (g.scope_kind = 'CONTEXT_TEAM' and tm.team_id is not null and tm.active)
        or (g.scope_kind = 'CONTEXT_PROJECT' and pr.project_id is not null and pr.active)
        or (g.scope_kind = 'CONTEXT_DEPARTMENT' and dm.department_id is not null and dm.is_active)
      )
  ),
  contextual_tl_grants as (
    select
      rc.capability,
      'CONTEXT_TEAM'::text as scope_kind,
      t.team_id::text as scope_id,
      'CONTEXTUAL_ASSIGNMENT'::text as source_type,
      tla.assignment_id::text as source_id,
      coalesce(t.display_name, t.code) as scope_label
    from public.direct_entry_team_leader_assignments tla
    join public.teams t
      on t.team_id = tla.team_id
     and t.active
     and t.code <> '__system_vendor__'
    join public.authz_role_capabilities rc
      on rc.role_code = 'TEAM_LEADER'
    where tla.leader_app_user_id = p_app_user_id
      and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
  ),
  contextual_pa_grants as (
    select
      rc.capability,
      'CONTEXT_PROJECT'::text as scope_kind,
      pa.project_id as scope_id,
      'CONTEXTUAL_ASSIGNMENT'::text as source_type,
      pa.assignment_id::text as source_id,
      coalesce(pr.display_name, pa.project_id) as scope_label
    from public.vendor_finance_project_accountants pa
    join public.direct_entry_projects pr
      on pr.project_id = pa.project_id
     and pr.active
    join public.authz_role_capabilities rc
      on rc.role_code = 'PROJECT_ACCOUNTANT'
    where pa.accountant_user_id = p_app_user_id
      and pa.ended_at is null
      and pa.valid_from <= v_today
      and (pa.valid_to is null or (pa.valid_to > pa.valid_from and v_today < pa.valid_to))
  ),
  tl_wr_compat_bridge as (
    -- Narrow compatibility bridge until WP8: active Team Leader holding open report_review grant.
    select
      'report_review'::text as capability,
      'CONTEXT_TEAM'::text as scope_kind,
      t.team_id::text as scope_id,
      'LEGACY_BRIDGE'::text as source_type,
      cg.grant_id::text as source_id,
      coalesce(t.display_name, t.code) as scope_label
    from public.work_report_team_leader_capability_grants x
    join public.direct_entry_team_leader_assignments tla
      on tla.assignment_id = x.leader_assignment_id
    join public.teams t
      on t.team_id = tla.team_id
     and t.active
     and t.code <> '__system_vendor__'
    join public.direct_entry_capability_grants cg
      on cg.grant_id = x.capability_grant_id
   where tla.leader_app_user_id = p_app_user_id
     and x.capability = 'report_review'
     and cg.app_user_id = p_app_user_id
     and cg.capability = 'report_review'
     and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
     and public.direct_entry__internal_capability_grant_effective(cg.grant_id, v_today)
  ),
  legacy_bridge_candidates as (
    -- Only bridge legacy capability x scope grants when NOT authz_managed.
    select
      cg.capability,
      'ALL'::text as scope_kind,
      null::text as scope_id,
      'LEGACY_BRIDGE'::text as source_type,
      cg.grant_id::text as source_id,
      'ALL'::text as scope_label
    from public.direct_entry_capability_grants cg
    where not v_user.authz_managed
      and cg.app_user_id = p_app_user_id
      and cg.capability <> 'entry_own'
      and public.direct_entry__internal_capability_grant_effective(cg.grant_id, v_today)
      and exists (
        select 1
          from public.direct_entry_scope_grants sg
         where sg.app_user_id = p_app_user_id
           and sg.scope_kind = 'all'
           and sg.is_current
           and not sg.suspended_by_account_disable
           and sg.valid_from <= v_today
           and (sg.valid_to is null or (sg.valid_to > sg.valid_from and v_today < sg.valid_to))
      )
    union all
    select
      cg.capability,
      'OWN'::text as scope_kind,
      null::text as scope_id,
      'LEGACY_BRIDGE'::text as source_type,
      cg.grant_id::text as source_id,
      'OWN'::text as scope_label
    from public.direct_entry_capability_grants cg
    where not v_user.authz_managed
      and cg.app_user_id = p_app_user_id
      and cg.capability in (
        'entry_own', 'entry_create', 'submission_create', 'document_upload',
        'document_view', 'change_request_create', 'employment_status.request'
      )
      and public.direct_entry__internal_capability_grant_effective(cg.grant_id, v_today)
      and exists (
        select 1
          from public.direct_entry_scope_grants sg
         where sg.app_user_id = p_app_user_id
           and sg.scope_kind = 'own'
           and sg.is_current
           and not sg.suspended_by_account_disable
           and sg.valid_from <= v_today
           and (sg.valid_to is null or (sg.valid_to > sg.valid_from and v_today < sg.valid_to))
      )
    union all
    select
      cg.capability,
      'CONTEXT_TEAM'::text as scope_kind,
      t.team_id::text as scope_id,
      'LEGACY_BRIDGE'::text as source_type,
      cg.grant_id::text as source_id,
      coalesce(t.display_name, t.code) as scope_label
    from public.direct_entry_capability_grants cg
    join public.direct_entry_scope_grants sg
      on sg.app_user_id = cg.app_user_id
     and sg.scope_kind = 'team'
    join public.teams t
      on t.team_id = sg.team_id
     and t.active
     and t.code <> '__system_vendor__'
    where not v_user.authz_managed
      and cg.app_user_id = p_app_user_id
      and cg.capability in ('entry_team', 'team_manager_assign', 'report_view', 'report_analytics_view', 'report_assign', 'report_review')
      and public.direct_entry__internal_capability_grant_effective(cg.grant_id, v_today)
      and public.direct_entry__internal_team_scope_grant_effective(sg.grant_id, v_today)
  ),
  canonical_items as (
    select * from role_bundle_grants
    union all
    select * from direct_grant_items
    union all
    select * from contextual_tl_grants
    union all
    select * from contextual_pa_grants
  ),
  combined_legacy_and_compat as (
    select lb.* from legacy_bridge_candidates lb
    union all
    select tw.*
      from tl_wr_compat_bridge tw
     where not exists (
       select 1
         from legacy_bridge_candidates lb2
        where lb2.capability = tw.capability
          and lb2.scope_kind = tw.scope_kind
          and lb2.scope_id is not distinct from tw.scope_id
     )
  ),
  all_grants as (
    select * from canonical_items
    union all
    select lb.*
      from combined_legacy_and_compat lb
     where not exists (
       select 1
         from canonical_items ci
        where ci.capability = lb.capability
          and ci.scope_kind = lb.scope_kind
          and ci.scope_id is not distinct from lb.scope_id
     )
  )
  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'capability', g.capability,
        'scope_kind', g.scope_kind,
        'scope_id', g.scope_id,
        'source_type', g.source_type,
        'source_id', g.source_id,
        'scope_label', g.scope_label
      )
      order by g.capability, g.scope_kind, g.scope_id nulls first, g.source_type, g.source_id
    ),
    '[]'::jsonb
  )
    into v_result
    from all_grants g;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

revoke all on function public.direct_entry_authz__internal_resolve_effective_grants(uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Post-cutover authz_managed propagation in finalize_create, create_personnel & link_recruiter
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_account_operation_finalize_create(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_intent_id uuid,
  p_intent_token uuid,
  p_created_auth_subject uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_action text := 'account_created';
  v_intent public.direct_entry_account_operation_intents;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_reason_text text;
  v_auto_reason text;
  v_app_user public.direct_entry_app_users;
  v_revision_id uuid;
  v_assignment_id uuid;
  v_cutover_ready boolean := false;
  v_now timestamptz;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_created_auth_subject is null or p_intent_id is null or p_intent_token is null then
    raise exception 'intent, token and auth subject required' using errcode = '22023';
  end if;

  -- Canonical lock order matching cutover (system_state -> account/FK -> intent/ledger):
  -- acquire FOR SHARE on authz_system_state BEFORE checking authority or inserting into
  -- direct_entry_rpc_idempotency (which takes an FK KEY SHARE on direct_entry_app_users).
  select coalesce(s.cutover_ready, false)
    into v_cutover_ready
    from public.authz_system_state s
   where s.singleton_id = true
   for share;
  v_cutover_ready := coalesce(v_cutover_ready, false);

  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_actor_app_user_id);

  v_payload_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'intent_id', p_intent_id, 'intent_token', p_intent_token,
    'auth_subject', p_created_auth_subject
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  v_intent := public.direct_entry_lock_account_operation(p_intent_id);
  if v_intent.kind <> 'CREATE_ACCOUNT' then
    raise exception 'account operation kind mismatch' using errcode = '22023';
  end if;

  -- Terminal first: APPLIED/FAILED/EXPIRED/BLOCKED/CONFLICT are immutable.
  if v_intent.state in ('APPLIED', 'FAILED', 'EXPIRED', 'BLOCKED', 'CONFLICT') then
    v_prior := jsonb_build_object(
      'intent_id', v_intent.intent_id,
      'intent_state', v_intent.state,
      'account_ref', v_intent.account_ref
    );
    perform public.direct_entry_idempotency_finish(
      p_actor_app_user_id, v_action, p_idempotency_key, v_prior
    );
    return v_prior;
  end if;
  if v_intent.state not in ('IN_FLIGHT', 'INDETERMINATE') then
    raise exception 'account operation is not claimable' using errcode = '22023';
  end if;

  if v_intent.intent_token <> p_intent_token then
    update public.direct_entry_account_operation_intents
       set state = 'BLOCKED', resolved_at = now(), updated_at = now()
     where intent_id = p_intent_id;
    insert into public.direct_entry_audit_events (
      auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, denial_code, reason_id
    ) values (
      p_auth_subject, p_actor_app_user_id, 'account_operation_finish', 'entry_admin',
      p_intent_id::text, 'all', 'REJECTED', 'provenance_mismatch', v_intent.reason_id
    );
    v_prior := jsonb_build_object(
      'intent_id', p_intent_id, 'intent_state', 'BLOCKED', 'account_ref', null
    );
    perform public.direct_entry_idempotency_finish(
      p_actor_app_user_id, v_action, p_idempotency_key, v_prior
    );
    return v_prior;
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_reason_id := v_intent.reason_id;
  insert into public.direct_entry_app_users (auth_subject, enabled, display_name, authz_managed)
  values (p_created_auth_subject, true, v_intent.display_name, v_cutover_ready)
  returning * into v_app_user;
  -- Retired PII/payment capabilities are not provisioned for new accounts.

  if v_cutover_ready then
    if v_reason_id is not null then
      select r.reason_text
        into v_reason_text
        from public.direct_entry_restricted_reasons r
       where r.reason_id = v_reason_id;
    end if;

    v_auto_reason := pg_catalog.btrim(
      pg_catalog.left(
        coalesce(nullif(pg_catalog.btrim(v_reason_text), ''), 'Auto-granted EMPLOYEE_BASE upon account creation'),
        500
      )
    );
    if v_auto_reason is null or pg_catalog.length(v_auto_reason) < 3 then
      v_auto_reason := 'Auto-granted EMPLOYEE_BASE upon account creation';
    end if;

    insert into public.authz_account_role_assignments (
      app_user_id, role_code, scope_kind, scope_ref, source_kind, reason, started_at, assigned_by_app_user_id
    ) values (
      v_app_user.app_user_id, 'EMPLOYEE_BASE', 'GLOBAL', null, 'ADMIN_ASSIGNMENT', v_auto_reason, v_now, p_actor_app_user_id
    )
    on conflict do nothing
    returning assignment_id into v_assignment_id;

    if v_assignment_id is not null then
      insert into public.authz_audit_events (
        actor_auth_subject, actor_app_user_id, target_app_user_id,
        operation_name, assignment_id, after_payload, reason, created_at
      ) values (
        p_auth_subject, p_actor_app_user_id, v_app_user.app_user_id,
        'AUTHZ_ACCOUNT_CREATE_BASE_ROLE', v_assignment_id,
        pg_catalog.jsonb_build_object(
          'role_code', 'EMPLOYEE_BASE',
          'source_kind', 'ADMIN_ASSIGNMENT',
          'authz_managed', true
        ),
        v_auto_reason, v_now
      );
    end if;

    perform public.direct_entry_authz__internal_sync_legacy_grants(v_app_user.app_user_id);
  end if;

  insert into public.direct_entry_app_user_revisions (
    app_user_id, version, actor_user_id, action, before_snapshot, after_snapshot, reason_id
  ) values (
    v_app_user.app_user_id, v_app_user.version, p_actor_app_user_id, v_action,
    null, jsonb_build_object('display_name', v_app_user.display_name, 'enabled', true), v_reason_id
  ) returning revision_id into v_revision_id;

  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind, outcome, reason_id,
    changed_fields, app_user_revision_id
  ) values (
    p_auth_subject, p_actor_app_user_id, v_action, 'entry_admin',
    v_app_user.app_user_id::text, 'all', 'APPLIED', v_reason_id,
    array['auth_subject', 'enabled', 'display_name'], v_revision_id
  );

  update public.direct_entry_account_operation_intents
     set state = 'APPLIED', resolved_at = now(), updated_at = now(),
         auth_subject = p_created_auth_subject,
         account_ref = v_app_user.app_user_id
   where intent_id = p_intent_id;

  v_prior := jsonb_build_object(
    'app_user_id', v_app_user.app_user_id,
    'auth_subject', v_app_user.auth_subject,
    'display_name', v_app_user.display_name,
    'version', v_app_user.version,
    'revision_id', v_revision_id,
    'intent_id', p_intent_id,
    'intent_state', 'APPLIED'
  );
  perform public.direct_entry_idempotency_finish(
    p_actor_app_user_id, v_action, p_idempotency_key, v_prior
  );
  return v_prior;
end;
$function$;

revoke all on function public.direct_entry_account_operation_finalize_create(uuid, uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_finalize_create(uuid, uuid, uuid, uuid, uuid, text)
  to service_role;

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
  v_person public.organization_persons;
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
  v_now timestamptz;
  v_next_capability_start date;
  v_next_scope_start date;
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
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then return v_prior; end if;

  v_valid_from := coalesce(p_valid_from, v_today);
  if v_valid_from <> v_today then
    raise exception 'provider valid from is invalid' using errcode = '22023';
  end if;

  select l.person_id
    into v_linked_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_account_ref
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

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref
   for update;
  if not found then raise exception 'account not found' using errcode = 'P0002'; end if;
  if not v_account.enabled then raise exception 'account is not enabled' using errcode = '23514'; end if;
  if v_account.account_type in ('SHARED', 'SERVICE') then
    raise exception 'ACCOUNT_TYPE_LINK_FORBIDDEN' using errcode = 'PT409';
  end if;
  if v_person.person_id is not null and v_person.recruiter_id is not null then
    raise exception 'RECRUITER_IDENTITY_CONFLICT' using errcode = 'PT409';
  end if;

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
  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;
  if exists (
    select 1 from public.recruiters r
     where r.personnel_code is not null
       and lower(public.recruitment_dimension_key(r.personnel_code))
           = lower(public.recruitment_dimension_key(v_code))
  ) then raise exception 'personnel code already exists' using errcode = '23505'; end if;

  v_now := pg_catalog.clock_timestamp();
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

  v_auto_reason := left(coalesce(p_reason, 'Auto-granted upon personnel creation'), 500);
  if pg_catalog.length(pg_catalog.btrim(v_auto_reason)) < 3 then
    v_auto_reason := 'Auto-granted upon personnel creation';
  end if;

  insert into public.authz_account_role_assignments (
    app_user_id, role_code, scope_kind, scope_ref, source_kind, reason, started_at, assigned_by_app_user_id
  ) values
    (p_account_ref, 'EMPLOYEE_BASE', 'GLOBAL', null, 'PERSONNEL_LINK_AUTO', v_auto_reason, v_now, p_actor_app_user_id),
    (p_account_ref, 'RECRUITER', 'GLOBAL', null, 'PERSONNEL_LINK_AUTO', v_auto_reason, v_now, p_actor_app_user_id)
  on conflict do nothing;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = v_now,
         authz_managed = (
           authz_managed
           or coalesce(
             (select s.cutover_ready from public.authz_system_state s where s.singleton_id = true),
             false
           )
         )
   where app_user_id = p_account_ref
  returning version, authz_managed into v_account.version, v_account.authz_managed;

  if v_account.authz_managed then
    perform public.direct_entry_authz__internal_sync_legacy_grants(p_account_ref);
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

revoke all on function public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)
  to service_role;

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
  v_account public.direct_entry_app_users;
  v_recruiter public.recruiters;
  v_acct_person_id uuid := null;
  v_rec_person_id uuid := null;
  v_current_acct_person_id uuid := null;
  v_current_rec_person_id uuid := null;
  v_lock_person_id uuid;
  v_acct_person public.organization_persons;
  v_rec_person public.organization_persons;
  v_provider_count integer;
  v_hrp_provider_count integer;
  v_login_id text;
  v_code text;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_link_id uuid;
  v_capability text;
  v_next_capability_start date;
  v_next_scope_start date;
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
  v_prior := public.direct_entry_idempotency_begin(
    p_actor_app_user_id, v_action, p_idempotency_key, v_payload_hash
  );
  if v_prior is not null then
    return v_prior;
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

  for v_lock_person_id in
    select distinct pid
      from unnest(array[v_acct_person_id, v_rec_person_id]) as t(pid)
     where pid is not null
     order by pid
  loop
    perform public.org_department__internal_lock_person(v_lock_person_id);
  end loop;

  for v_lock_person_id in
    select p.person_id
      from public.organization_persons p
     where p.person_id in (v_acct_person_id, v_rec_person_id)
     order by p.person_id
     for update
  loop
    if v_lock_person_id = v_acct_person_id then
      select p.* into v_acct_person from public.organization_persons p where p.person_id = v_acct_person_id;
    end if;
    if v_lock_person_id = v_rec_person_id then
      select p.* into v_rec_person from public.organization_persons p where p.person_id = v_rec_person_id;
    end if;
  end loop;

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_account_ref
   for update;
  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  if v_account.account_type in ('SHARED', 'SERVICE') then
    raise exception 'ACCOUNT_TYPE_LINK_FORBIDDEN' using errcode = 'PT409';
  end if;

  select r.* into v_recruiter
    from public.recruiters r
   where r.recruiter_id = p_recruiter_id
   for update;
  if not found then
    raise exception 'personnel not found' using errcode = 'P0002';
  end if;

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

  perform m.membership_id
    from public.recruiter_provider_memberships m
   where m.recruiter_id = p_recruiter_id
   order by m.membership_id asc
   for update;

  perform pg_advisory_xact_lock(hashtextextended('provider:' || p_recruiter_id::text, 0));

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

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_account_ref
      or l.recruiter_id = p_recruiter_id
   order by l.link_id asc
   for update;

  perform pg_advisory_xact_lock(hashtextextended('recruiter-link:' || p_account_ref::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('recruiter-link-recruiter:' || p_recruiter_id::text, 0));

  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_account_ref
     and s.scope_kind in ('own', 'all')
   order by s.grant_id asc
   for update;

  for v_lock_key in
    select distinct k
      from unnest(array[
        'scope:' || p_account_ref::text || ':all:' || p_account_ref::text,
        'scope:' || p_account_ref::text || ':own:' || p_account_ref::text
      ]) as t(k)
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

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
        select rc.capability
          from public.authz_account_role_assignments ara
          join public.authz_role_capabilities rc on rc.role_code = ara.role_code
         where ara.app_user_id = p_account_ref
           and ara.ended_at is null
        union
        select dg.capability
          from public.authz_direct_capability_grants dg
         where dg.app_user_id = p_account_ref
           and dg.ended_at is null
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

  if v_account.version <> p_expected_account_version then
    raise exception 'app user version conflict' using errcode = 'PT409';
  end if;
  if v_recruiter.version <> p_expected_recruiter_version then
    raise exception 'personnel version conflict' using errcode = 'PT409';
  end if;

  v_now := pg_catalog.clock_timestamp();
  v_reason_id := public.direct_entry_reason(p_actor_app_user_id, p_reason);

  insert into public.direct_entry_app_user_recruiter_links (
    app_user_id, recruiter_id, verified, valid_from, is_current
  ) values (
    p_account_ref, p_recruiter_id, true, v_today, true
  ) returning link_id into v_link_id;

  if not exists (
    select 1
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_account_ref
       and g.scope_kind = 'own'
       and g.is_current
  ) then
    if exists (
      select 1
        from public.direct_entry_scope_grants g
       where g.app_user_id = p_account_ref
         and g.scope_kind = 'own'
         and g.valid_from <= v_today
         and (g.valid_to is null or v_today < g.valid_to)
    ) then
      update public.direct_entry_scope_grants g
         set is_current = true
       where g.app_user_id = p_account_ref
         and g.scope_kind = 'own'
         and g.valid_from <= v_today
         and (g.valid_to is null or v_today < g.valid_to);
    else
      select min(g.valid_from)
        into v_next_scope_start
        from public.direct_entry_scope_grants g
       where g.app_user_id = p_account_ref
         and g.scope_kind = 'own'
         and g.valid_from > v_today;
      insert into public.direct_entry_scope_grants (
        app_user_id, scope_kind, valid_from, valid_to, is_current
      ) values (
        p_account_ref, 'own', v_today, v_next_scope_start, true
      );
    end if;
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
    if not exists (
      select 1
        from public.direct_entry_capability_grants g
       where g.app_user_id = p_account_ref
         and g.capability = v_capability
         and g.is_current
    ) then
      if exists (
        select 1
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_account_ref
           and g.capability = v_capability
           and g.valid_from <= v_today
           and (g.valid_to is null or v_today < g.valid_to)
      ) then
        update public.direct_entry_capability_grants g
           set is_current = true
         where g.app_user_id = p_account_ref
           and g.capability = v_capability
           and g.valid_from <= v_today
           and (g.valid_to is null or v_today < g.valid_to);
      else
        select min(g.valid_from)
          into v_next_capability_start
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_account_ref
           and g.capability = v_capability
           and g.valid_from > v_today;
        insert into public.direct_entry_capability_grants (
          app_user_id, capability, valid_from, valid_to, is_current
        ) values (
          p_account_ref, v_capability, v_today, v_next_capability_start, true
        );
      end if;
      insert into public.direct_entry_audit_events (
        auth_subject, app_user_id, action, capability, resource_ref, outcome, reason_id, changed_fields
      ) values (
        p_auth_subject, p_actor_app_user_id, 'capability_default_grant', v_capability,
        p_account_ref::text, 'APPLIED', v_reason_id, array['valid_from', 'valid_to']
      );
    end if;
  end loop;

  v_auto_reason := left(coalesce(p_reason, 'Auto-granted upon recruiter account link'), 500);
  if pg_catalog.length(pg_catalog.btrim(v_auto_reason)) < 3 then
    v_auto_reason := 'Auto-granted upon recruiter account link';
  end if;

  insert into public.authz_account_role_assignments (
    app_user_id, role_code, scope_kind, scope_ref, source_kind, reason, started_at, assigned_by_app_user_id
  ) values
    (p_account_ref, 'EMPLOYEE_BASE', 'GLOBAL', null, 'PERSONNEL_LINK_AUTO', v_auto_reason, v_now, p_actor_app_user_id),
    (p_account_ref, 'RECRUITER', 'GLOBAL', null, 'PERSONNEL_LINK_AUTO', v_auto_reason, v_now, p_actor_app_user_id)
  on conflict do nothing;

  update public.direct_entry_app_users
     set version = version + 1,
         updated_at = v_now,
         authz_managed = (
           authz_managed
           or coalesce(
             (select s.cutover_ready from public.authz_system_state s where s.singleton_id = true),
             false
           )
         )
   where app_user_id = p_account_ref
  returning version, authz_managed into v_account.version, v_account.authz_managed;

  if v_account.authz_managed then
    perform public.direct_entry_authz__internal_sync_legacy_grants(p_account_ref);
  end if;

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

revoke all on function public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 3. Group A: Reporting Audience (paired ALL / CONTEXT_TEAM / OWN + link checks)
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_reporting_resolve_audience(
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
  v_found boolean;
  v_team jsonb;
  v_link jsonb;
  v_link_count integer;
  v_recruiter_id uuid;
  v_has_own_cap boolean := false;
begin
  select exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) into v_found;
  if not v_found then
    raise exception 'reporting actor unavailable' using errcode = '42501';
  end if;

  if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
     or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_analytics_view', 'ALL', null) then
    return jsonb_build_object(
      'audience', 'all',
      'label', 'Toàn công ty',
      'team_ids', '[]'::jsonb,
      'recruiter_id', null
    );
  end if;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('team_id', t.team_id, 'label', t.display_name)
      order by t.display_name, t.team_id
    ),
    '[]'::jsonb
  )
    into v_team
    from public.teams t
   where t.active
     and t.code <> '__system_vendor__'
     and (
       public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_team', 'CONTEXT_TEAM', t.team_id::text)
       or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_analytics_view', 'CONTEXT_TEAM', t.team_id::text)
     );

  if pg_catalog.jsonb_array_length(v_team) > 0 then
    return jsonb_build_object(
      'audience', 'team',
      'label', v_team->0->>'label',
      'team_ids', (
        select coalesce(pg_catalog.jsonb_agg(x->'team_id'), '[]'::jsonb)
          from pg_catalog.jsonb_array_elements(v_team) x
      ),
      'recruiter_id', null
    );
  end if;

  select count(*)::integer, (array_agg(l.recruiter_id order by l.link_id))[1]
    into v_link_count, v_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.is_current
     and not l.suspended_by_account_disable;

  if v_link_count > 1 then
    raise exception 'reporting actor ambiguous recruiter link' using errcode = '42501';
  end if;

  if v_link_count = 1 and exists (
    select 1
      from public.direct_entry_app_user_recruiter_links l2
      join public.direct_entry_app_users u2
        on u2.app_user_id = l2.app_user_id
       and u2.enabled
     where l2.recruiter_id = v_recruiter_id
       and l2.app_user_id <> p_app_user_id
       and l2.verified
       and l2.is_current
       and not l2.suspended_by_account_disable
  ) then
    raise exception 'reporting actor ambiguous recruiter link' using errcode = '42501';
  end if;

  v_has_own_cap :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_own', 'OWN', null)
    or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_analytics_view', 'OWN', null);

  if v_link_count = 1 and v_has_own_cap then
    select jsonb_build_object('recruiter_id', l.recruiter_id, 'label', r.display_name)
      into v_link
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r
        on r.recruiter_id = l.recruiter_id
       and r.active
     where l.app_user_id = p_app_user_id
       and l.verified
       and l.is_current
       and not l.suspended_by_account_disable
     limit 1;
  else
    v_link := null;
  end if;

  return jsonb_build_object(
    'audience', 'own',
    'label', coalesce(v_link->>'label', 'Cá nhân'),
    'team_ids', '[]'::jsonb,
    'recruiter_id', v_link->>'recruiter_id'
  );
end;
$function$;

-- -----------------------------------------------------------------------------
-- 4. Group A: Remove 3-email allowlist (Worker Edit History & Missing Documents)
-- -----------------------------------------------------------------------------
create or replace function public.worker_edit_history_assert_actor(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.direct_entry_authz__internal_has_paired_capability(
    p_app_user_id, 'worker_edit_history_view', 'ALL', null
  ) then
    raise exception 'WORKER_EDIT_HISTORY_ACCESS_DENIED' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function public.worker_edit_history_assert_actor(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_list_missing_document_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_missing_type text default null,
  p_project_id text default null,
  p_employment_status text default null,
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
  v_missing_type text := coalesce(nullif(pg_catalog.upper(pg_catalog.btrim(p_missing_type)), ''), 'ALL');
  v_employment_status text := coalesce(nullif(pg_catalog.upper(pg_catalog.btrim(p_employment_status)), ''), 'ALL');
  v_project_id text := nullif(pg_catalog.btrim(p_project_id), '');
  v_search text := nullif(pg_catalog.btrim(p_search), '');
  v_page integer := coalesce(p_page, 1);
  v_page_size integer := coalesce(p_page_size, 25);
  v_offset integer;
  v_is_global_viewer boolean := false;
  v_has_doc_upload_all boolean := false;
  v_has_doc_upload_own boolean := false;
  v_managed_project_ids text[] := array[]::text[];
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

  select coalesce(array_agg(distinct pma.project_id order by pma.project_id), array[]::text[])
    into v_managed_project_ids
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r
      on r.recruiter_id = l.recruiter_id
     and r.active
    join public.direct_entry_project_manager_assignments pma
      on pma.manager_recruiter_id = l.recruiter_id
     and pma.is_current
     and pma.revoked_at is null
    join public.direct_entry_projects pr
      on pr.project_id = pma.project_id
     and pr.active
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.is_current;

  select coalesce(array_agg(distinct l.recruiter_id order by l.recruiter_id), array[]::uuid[])
    into v_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r
      on r.recruiter_id = l.recruiter_id
     and r.active
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.is_current;

  if v_is_global_viewer then
    v_scope_kind := 'all';
    v_can_upload := v_has_doc_upload_all;
  elsif pg_catalog.cardinality(v_managed_project_ids) > 0 then
    v_scope_kind := 'project';
    -- QLDA typically receives document_upload at OWN via RECRUITER role.
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

revoke all on function public.direct_entry_list_missing_document_workers(uuid, uuid, text, text, text, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_missing_document_workers(uuid, uuid, text, text, text, text, integer, integer)
  to service_role;

create or replace function public.direct_entry_reserve_document_direct_upload(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_expected_entry_version integer,
  p_document_type text,
  p_idempotency_key text,
  p_size_bytes bigint,
  p_mime_type text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_entry public.direct_entries%rowtype;
  v_scope text;
  v_submission_state text;
  v_prior jsonb;
  v_document public.direct_entry_document_versions%rowtype;
  v_latest public.direct_entry_document_events%rowtype;
  v_document_id uuid := gen_random_uuid();
  v_version integer;
  v_supersedes uuid;
  v_before jsonb;
  v_after jsonb;
  v_reason_id uuid;
  v_revision_id uuid;
  v_result jsonb;
begin
  if p_reason is not null and length(p_reason) > 4000 then
    raise exception 'reason exceeds maximum length' using errcode = '22023';
  end if;
  p_reason := nullif(btrim(p_reason), '');
  if p_document_type not in (
       'CCCD_FRONT', 'CCCD_BACK', 'EMPLOYMENT_CONTRACT', 'WORKER_PORTRAIT'
     )
     or (p_document_type = 'WORKER_PORTRAIT' and p_mime_type = 'application/pdf')
     or p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128
     or p_size_bytes is null or p_size_bytes not between 1 and 10485760
     or p_mime_type not in ('application/pdf', 'image/jpeg', 'image/png') then
    raise exception 'invalid document reservation' using errcode = '22023';
  end if;

  select * into v_entry
    from public.direct_entries
   where entry_id = p_entry_id
   for update;
  if not found or v_entry.deleted_at is not null then
    raise exception 'entry not found' using errcode = 'P0002';
  end if;

  v_scope := public.direct_entry_assert_document_upload_access(
    p_auth_subject, p_app_user_id, p_entry_id
  );
  select state into v_submission_state
    from public.direct_entry_submissions
   where submission_id = v_entry.submission_id;

  if (v_submission_state = 'SUBMITTED' and p_reason is not null)
     or (p_reason is not null and p_reason ilike '%hồ sơ còn thiếu%') then
    if not (
         public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'worker_edit_history_view', 'ALL', null)
         and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'document_upload', 'ALL', null)
       )
       and not public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, v_entry.project_id)
       and v_scope not in ('all', 'project', 'team') then
      raise exception 'missing document upload denied for recruiter' using errcode = '42501';
    end if;
  end if;

  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'document_direct_reserve', p_idempotency_key,
    public.direct_entry_payload_hash(jsonb_build_object(
      'entry_id', p_entry_id, 'expected_version', p_expected_entry_version,
      'document_type', p_document_type, 'size', p_size_bytes,
      'mime', p_mime_type, 'reason', p_reason
    ))
  );
  if v_prior is not null then
    select * into v_document
      from public.direct_entry_document_versions d
     where d.document_id = (v_prior->>'document_id')::uuid;
    select * into v_latest
      from public.direct_entry_document_events e
     where e.document_id = v_document.document_id
     order by e.version desc
     limit 1;
    return jsonb_build_object(
      'document_id', v_document.document_id, 'version', v_document.version,
      'entry_version', v_entry.version, 'storage_key', v_document.storage_key,
      'upload_status', v_latest.upload_status, 'scan_status', v_latest.scan_status,
      'validation_status', v_latest.validation_status, 'reused', true
    );
  end if;

  if p_expected_entry_version is null
     or not public.direct_entry__internal_version_compatible_after_qr_autofill(
       p_entry_id, p_expected_entry_version, v_entry.version
     ) then
    raise exception 'entry version conflict' using errcode = '40001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'document:' || v_entry.candidate_id::text || ':' || p_document_type, 0
  ));
  select coalesce(max(d.version), 0) + 1,
         (array_agg(d.document_id order by d.version desc))[1]
    into v_version, v_supersedes
    from public.direct_entry_document_versions d
   where d.candidate_id = v_entry.candidate_id
     and d.document_type = p_document_type;

  v_before := public.direct_entry_entry_snapshot(p_entry_id);
  v_reason_id := public.direct_entry_reason(
    p_app_user_id,
    coalesce(
      p_reason,
      case
        when v_submission_state = 'SUBMITTED'
         and v_entry.created_by_user_id = p_app_user_id
          then 'Android background attachment upload'
      end
    )
  );

  insert into public.direct_entry_document_versions (
    document_id, candidate_id, document_type, version, idempotency_key,
    checksum_sha256, size_bytes, mime_type, storage_key, upload_status,
    scan_status, created_by_user_id, supersedes_document_id
  ) values (
    v_document_id, v_entry.candidate_id, p_document_type, v_version,
    p_idempotency_key, null, p_size_bytes, p_mime_type,
    'p1.6/' || v_entry.candidate_id::text || '/' || p_document_type || '/' ||
      v_version::text || '/' || v_document_id::text,
    'QUEUED', 'PENDING', p_app_user_id, v_supersedes
  );
  insert into public.direct_entry_document_events (
    document_id, upload_status, scan_status, attempts
  ) values (v_document_id, 'QUEUED', 'PENDING', 0);

  update public.direct_entries
     set version = version + 1
   where entry_id = p_entry_id;
  v_after := public.direct_entry_entry_snapshot(p_entry_id);
  v_revision_id := public.direct_entry_write_revision(
    p_entry_id, p_app_user_id, v_reason_id,
    v_before, v_after, v_entry.version + 1
  );
  insert into public.direct_entry_audit_events (
    auth_subject, app_user_id, action, capability, resource_ref, scope_kind,
    scope_team_id, outcome, reason_id, revision_id, changed_fields
  ) values (
    p_auth_subject, p_app_user_id, 'document_direct_reserve', 'document_upload',
    p_entry_id::text, v_scope,
    case when v_scope = 'team' then v_entry.team_id else null end,
    'APPLIED', v_reason_id, v_revision_id, array['document_metadata']
  );

  v_result := jsonb_build_object(
    'document_id', v_document_id, 'version', v_version,
    'entry_version', v_entry.version + 1,
    'storage_key', 'p1.6/' || v_entry.candidate_id::text || '/' ||
      p_document_type || '/' || v_version::text || '/' || v_document_id::text,
    'upload_status', 'QUEUED', 'scan_status', 'PENDING',
    'validation_status', 'PENDING', 'reused', false
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'document_direct_reserve', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.direct_entry_reserve_document_direct_upload(uuid, uuid, uuid, integer, text, text, bigint, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_reserve_document_direct_upload(uuid, uuid, uuid, integer, text, text, bigint, text, text)
  to service_role;

drop function if exists public.worker_edit_history_is_allowlisted_admin(uuid, uuid);

-- -----------------------------------------------------------------------------
-- 5. Group A: Tighten Team Leader designate/revoke/candidates to team_master_manage at ALL
--    Preserve R1 canonical lock order (U sorted -> R sorted -> T -> children).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_team_leader_read_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if public.direct_entry_authz__internal_has_paired_capability(
    p_app_user_id, 'team_master_manage', 'ALL', null
  ) then
    return p_team_id;
  end if;
  begin
    perform public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);
    return p_team_id;
  exception when insufficient_privilege then
    return public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, p_team_id
    );
  end;
end;
$function$;

revoke all on function public.direct_entry_assert_team_leader_read_authority(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

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
       and not exists (
         select 1 from public.direct_entry_scope_grants s
          where s.app_user_id = u.app_user_id
            and s.scope_kind = 'team'
            and (
              public.direct_entry__internal_team_scope_grant_effective(s.grant_id, v_today)
              or (s.valid_from > v_today and (s.valid_to is null or s.valid_to > s.valid_from))
            )
       )
       and not exists (
         select 1 from public.direct_entry_capability_grants g
          where g.app_user_id = u.app_user_id
            and g.capability = 'team_manager_assign'
            and (
              public.direct_entry__internal_capability_grant_effective(g.grant_id, v_today)
              or (g.valid_from > v_today and (g.valid_to is null or g.valid_to > g.valid_from))
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
  v_write_user_ids uuid[];
  v_all_user_ids uuid[];
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

  -- Phase 1: Unlocked candidate discovery before acquiring U -> R -> T locks
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

  select coalesce(array_agg(distinct uid order by uid), array[]::uuid[])
    into v_all_user_ids
    from (
      select p_app_user_id as uid
      union
      select unnest(v_write_user_ids) as uid
    ) all_users
   where uid is not null;

  -- Phase 2: Canonical Tier 2 (U: FOR UPDATE targets, FOR SHARE pure operator)
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

  -- Canonical Tier 3 (R: affected recruiters in ascending ID order)
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

revoke all on function public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_designate_team_leader(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_leader_app_user_id uuid,
  p_effective_date date,
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
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.direct_entry_authz__internal_has_paired_capability(
    p_app_user_id, 'team_master_manage', 'ALL', null
  ) then
    raise exception 'insufficient privilege for team leader management' using errcode = '42501';
  end if;
  v_authority := case
    when public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
     and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      then 'entry_admin'
    else 'team_master_manage'
  end;
  return public.direct_entry_apply_team_leader_mutation(
    p_auth_subject, p_app_user_id, p_team_id, p_leader_app_user_id,
    p_effective_date, p_expected_version, p_reason, p_idempotency_key,
    'designate', v_authority
  );
end;
$function$;

revoke all on function public.direct_entry_designate_team_leader(uuid, uuid, uuid, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_designate_team_leader(uuid, uuid, uuid, uuid, date, integer, text, text)
  to service_role;

create or replace function public.direct_entry_revoke_team_leader(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_effective_date date,
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
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if not public.direct_entry_authz__internal_has_paired_capability(
    p_app_user_id, 'team_master_manage', 'ALL', null
  ) then
    raise exception 'insufficient privilege for team leader management' using errcode = '42501';
  end if;
  v_authority := case
    when public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
     and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      then 'entry_admin'
    else 'team_master_manage'
  end;
  return public.direct_entry_apply_team_leader_mutation(
    p_auth_subject, p_app_user_id, p_team_id, null,
    p_effective_date, p_expected_version, p_reason, p_idempotency_key,
    'revoke', v_authority
  );
end;
$function$;

revoke all on function public.direct_entry_revoke_team_leader(uuid, uuid, uuid, date, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_revoke_team_leader(uuid, uuid, uuid, date, integer, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 6. AI Settings (OD-WP5-04): enforce Full Admin [ALL] inside the 5 mutating
--    ai_provider_config_* RPCs, locking direct_entry_app_users FOR SHARE before
--    config advisory/row locks.
-- -----------------------------------------------------------------------------
create or replace function public.ai_provider_config_save(
  p_config_id text,
  p_expected_version integer,
  p_provider_profile text,
  p_api_base_url text,
  p_sanitized_host text,
  p_model text,
  p_envelope jsonb,
  p_key_fingerprint text,
  p_actor_ref text,
  p_action text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor_id uuid;
  v_actor_enabled boolean := false;
  v_current integer;
  v_next integer;
  v_row public.ai_provider_configs;
begin
  if p_actor_ref is null
     or p_actor_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return jsonb_build_object('ok', false, 'code', 'AI_FORBIDDEN', 'message', 'không có quyền quản trị cấu hình AI');
  end if;
  v_actor_id := p_actor_ref::uuid;

  select u.enabled
    into v_actor_enabled
    from public.direct_entry_app_users u
   where u.app_user_id = v_actor_id
   for share;

  if not found
     or not coalesce(v_actor_enabled, false)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'entry_admin', 'ALL', null)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'recruiter_master_manage', 'ALL', null)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'team_master_manage', 'ALL', null) then
    return jsonb_build_object('ok', false, 'code', 'AI_FORBIDDEN', 'message', 'không có quyền quản trị cấu hình AI');
  end if;

  if p_action not in ('config_created','credential_rotated') then
    return jsonb_build_object('ok', false, 'code', 'AI_INPUT_INVALID', 'message', 'action không hợp lệ');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ai_provider_config_save:' || coalesce(p_config_id, '')));

  select max(version) into v_current from public.ai_provider_configs where config_id = p_config_id;

  if v_current is null then
    if p_expected_version is not null then
      insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code)
      values (p_config_id, greatest(coalesce(p_expected_version, 0), 0), 'config_mutation_rejected', p_actor_ref, 'failure', 'version_conflict');
      return jsonb_build_object('ok', false, 'code', 'AI_VERSION_CONFLICT', 'message', 'cấu hình đã thay đổi');
    end if;
    v_next := 1;
  else
    if p_expected_version is distinct from v_current then
      insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code)
      values (p_config_id, v_current, 'config_mutation_rejected', p_actor_ref, 'failure', 'version_conflict');
      return jsonb_build_object('ok', false, 'code', 'AI_VERSION_CONFLICT', 'message', 'cấu hình đã thay đổi');
    end if;
    v_next := v_current + 1;
  end if;

  insert into public.ai_provider_configs (
    config_id, version, provider_profile, api_base_url, sanitized_host, model,
    envelope, key_fingerprint, status, verified_at, last_tested_at,
    optimistic_version, created_by_ref, created_at, updated_by_ref, updated_at
  ) values (
    p_config_id, v_next, p_provider_profile, p_api_base_url, p_sanitized_host, p_model,
    p_envelope, p_key_fingerprint, 'draft', null, null,
    v_next, p_actor_ref, now(), p_actor_ref, now()
  )
  returning * into v_row;

  insert into public.ai_provider_config_audit_events (
    config_id, version, event_type, actor_ref, outcome, reason_code,
    provider_profile, sanitized_host, model, key_fingerprint
  ) values (
    v_row.config_id, v_row.version, p_action, p_actor_ref, 'success', 'ok',
    v_row.provider_profile, v_row.sanitized_host, v_row.model, v_row.key_fingerprint
  );

  return jsonb_build_object('ok', true, 'config', public.ai_provider_config_public_json(v_row));
end;
$function$;

revoke all on function public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text)
  to service_role;

create or replace function public.ai_provider_config_test_result(
  p_config_id text,
  p_version integer,
  p_success boolean,
  p_reason_code text,
  p_actor_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor_id uuid;
  v_actor_enabled boolean := false;
  v_row public.ai_provider_configs;
  v_outcome text;
begin
  if p_actor_ref is null
     or p_actor_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return jsonb_build_object('ok', false, 'code', 'AI_FORBIDDEN', 'message', 'không có quyền quản trị cấu hình AI');
  end if;
  v_actor_id := p_actor_ref::uuid;

  select u.enabled
    into v_actor_enabled
    from public.direct_entry_app_users u
   where u.app_user_id = v_actor_id
   for share;

  if not found
     or not coalesce(v_actor_enabled, false)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'entry_admin', 'ALL', null)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'recruiter_master_manage', 'ALL', null)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'team_master_manage', 'ALL', null) then
    return jsonb_build_object('ok', false, 'code', 'AI_FORBIDDEN', 'message', 'không có quyền quản trị cấu hình AI');
  end if;

  select * into v_row
    from public.ai_provider_configs
   where config_id = p_config_id and version = p_version
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_CONFIG_NOT_FOUND', 'message', 'không tìm thấy version');
  end if;

  v_outcome := case when p_success then 'success' else 'failure' end;

  if v_row.status = 'active' then
    update public.ai_provider_configs
       set last_tested_at = now(),
           optimistic_version = optimistic_version + 1,
           updated_by_ref = p_actor_ref,
           updated_at = now()
     where config_id = p_config_id and version = p_version
     returning * into v_row;
  else
    update public.ai_provider_configs
       set status = case when p_success then 'verified' else 'test_failed' end,
           verified_at = case when p_success then now() else null end,
           last_tested_at = now(),
           optimistic_version = optimistic_version + 1,
           updated_by_ref = p_actor_ref,
           updated_at = now()
     where config_id = p_config_id and version = p_version
     returning * into v_row;
  end if;

  insert into public.ai_provider_config_audit_events (
    config_id, version, event_type, actor_ref, outcome, reason_code,
    provider_profile, sanitized_host, model, key_fingerprint
  ) values (
    v_row.config_id, v_row.version, 'connection_tested', p_actor_ref, v_outcome, p_reason_code,
    v_row.provider_profile, v_row.sanitized_host, v_row.model, v_row.key_fingerprint
  );

  return jsonb_build_object('ok', true, 'config', public.ai_provider_config_public_json(v_row));
end;
$function$;

revoke all on function public.ai_provider_config_test_result(text, integer, boolean, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.ai_provider_config_test_result(text, integer, boolean, text, text)
  to service_role;

create or replace function public.ai_provider_config_activate(
  p_config_id text,
  p_version integer,
  p_actor_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor_id uuid;
  v_actor_enabled boolean := false;
  v_row public.ai_provider_configs;
  v_previous public.ai_provider_configs;
begin
  if p_actor_ref is null
     or p_actor_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return jsonb_build_object('ok', false, 'code', 'AI_FORBIDDEN', 'message', 'không có quyền quản trị cấu hình AI');
  end if;
  v_actor_id := p_actor_ref::uuid;

  select u.enabled
    into v_actor_enabled
    from public.direct_entry_app_users u
   where u.app_user_id = v_actor_id
   for share;

  if not found
     or not coalesce(v_actor_enabled, false)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'entry_admin', 'ALL', null)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'recruiter_master_manage', 'ALL', null)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'team_master_manage', 'ALL', null) then
    return jsonb_build_object('ok', false, 'code', 'AI_FORBIDDEN', 'message', 'không có quyền quản trị cấu hình AI');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('ai_provider_config_activate:pilot'));

  select * into v_row
    from public.ai_provider_configs
   where config_id = p_config_id and version = p_version
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_CONFIG_NOT_FOUND', 'message', 'không tìm thấy version');
  end if;
  if v_row.status <> 'verified' or v_row.verified_at is null then
    insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code,
      provider_profile, sanitized_host, model, key_fingerprint)
    values (v_row.config_id, v_row.version, 'config_mutation_rejected', p_actor_ref, 'failure', 'not_verified',
      v_row.provider_profile, v_row.sanitized_host, v_row.model, v_row.key_fingerprint);
    return jsonb_build_object('ok', false, 'code', 'AI_CONFIG_NOT_VERIFIED', 'message', 'cấu hình chưa verified');
  end if;

  for v_previous in
    select * from public.ai_provider_configs
     where pilot_scope = v_row.pilot_scope and status = 'active'
       and not (config_id = p_config_id and version = p_version)
     for update
  loop
    update public.ai_provider_configs
       set status = 'disabled',
           optimistic_version = optimistic_version + 1,
           updated_by_ref = p_actor_ref,
           updated_at = now()
     where config_id = v_previous.config_id and version = v_previous.version;
    insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code,
      provider_profile, sanitized_host, model, key_fingerprint)
    values (v_previous.config_id, v_previous.version, 'config_disabled', p_actor_ref, 'success', 'superseded',
      v_previous.provider_profile, v_previous.sanitized_host, v_previous.model, v_previous.key_fingerprint);
  end loop;

  update public.ai_provider_configs
     set status = 'active',
         optimistic_version = optimistic_version + 1,
         updated_by_ref = p_actor_ref,
         updated_at = now()
   where config_id = p_config_id and version = p_version
   returning * into v_row;

  insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code,
    provider_profile, sanitized_host, model, key_fingerprint)
  values (v_row.config_id, v_row.version, 'config_activated', p_actor_ref, 'success', 'ok',
    v_row.provider_profile, v_row.sanitized_host, v_row.model, v_row.key_fingerprint);

  return jsonb_build_object('ok', true, 'config', public.ai_provider_config_public_json(v_row));
end;
$function$;

revoke all on function public.ai_provider_config_activate(text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.ai_provider_config_activate(text, integer, text)
  to service_role;

create or replace function public.ai_provider_config_disable(
  p_config_id text,
  p_version integer,
  p_actor_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor_id uuid;
  v_actor_enabled boolean := false;
  v_row public.ai_provider_configs;
begin
  if p_actor_ref is null
     or p_actor_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return jsonb_build_object('ok', false, 'code', 'AI_FORBIDDEN', 'message', 'không có quyền quản trị cấu hình AI');
  end if;
  v_actor_id := p_actor_ref::uuid;

  select u.enabled
    into v_actor_enabled
    from public.direct_entry_app_users u
   where u.app_user_id = v_actor_id
   for share;

  if not found
     or not coalesce(v_actor_enabled, false)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'entry_admin', 'ALL', null)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'recruiter_master_manage', 'ALL', null)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'team_master_manage', 'ALL', null) then
    return jsonb_build_object('ok', false, 'code', 'AI_FORBIDDEN', 'message', 'không có quyền quản trị cấu hình AI');
  end if;

  select * into v_row
    from public.ai_provider_configs
   where config_id = p_config_id and version = p_version
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AI_CONFIG_NOT_FOUND', 'message', 'không tìm thấy version');
  end if;

  update public.ai_provider_configs
     set status = 'disabled',
         optimistic_version = optimistic_version + 1,
         updated_by_ref = p_actor_ref,
         updated_at = now()
   where config_id = p_config_id and version = p_version
   returning * into v_row;

  insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code,
    provider_profile, sanitized_host, model, key_fingerprint)
  values (v_row.config_id, v_row.version, 'config_disabled', p_actor_ref, 'success', 'owner_disabled',
    v_row.provider_profile, v_row.sanitized_host, v_row.model, v_row.key_fingerprint);

  return jsonb_build_object('ok', true, 'config', public.ai_provider_config_public_json(v_row));
end;
$function$;

revoke all on function public.ai_provider_config_disable(text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.ai_provider_config_disable(text, integer, text)
  to service_role;

create or replace function public.ai_provider_config_rejected(
  p_config_id text,
  p_version integer,
  p_actor_ref text,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_actor_id uuid;
  v_actor_enabled boolean := false;
begin
  if p_actor_ref is null
     or p_actor_ref !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return jsonb_build_object('ok', false, 'code', 'AI_FORBIDDEN', 'message', 'không có quyền quản trị cấu hình AI');
  end if;
  v_actor_id := p_actor_ref::uuid;

  select u.enabled
    into v_actor_enabled
    from public.direct_entry_app_users u
   where u.app_user_id = v_actor_id
   for share;

  if not found
     or not coalesce(v_actor_enabled, false)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'entry_admin', 'ALL', null)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'recruiter_master_manage', 'ALL', null)
     or not public.direct_entry_authz__internal_has_paired_capability(v_actor_id, 'team_master_manage', 'ALL', null) then
    return jsonb_build_object('ok', false, 'code', 'AI_FORBIDDEN', 'message', 'không có quyền quản trị cấu hình AI');
  end if;

  insert into public.ai_provider_config_audit_events (config_id, version, event_type, actor_ref, outcome, reason_code)
  values (p_config_id, greatest(coalesce(p_version, 0), 0), 'config_mutation_rejected', p_actor_ref, 'failure', p_reason_code);
  return jsonb_build_object('ok', true);
end;
$function$;

revoke all on function public.ai_provider_config_rejected(text, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.ai_provider_config_rejected(text, integer, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 7. Security Alignment & Fail-Closed Postcondition Blocks
-- -----------------------------------------------------------------------------
do $align_wp5b2$
declare
  v_service_rpcs text[] := array[
    'public.direct_entry_account_operation_finalize_create(uuid, uuid, uuid, uuid, uuid, text)',
    'public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)',
    'public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)',
    'public.direct_entry_list_missing_document_workers(uuid, uuid, text, text, text, text, integer, integer)',
    'public.direct_entry_reserve_document_direct_upload(uuid, uuid, uuid, integer, text, text, bigint, text, text)',
    'public.direct_entry_list_team_leader_candidates(uuid, uuid, uuid, text, integer, integer)',
    'public.direct_entry_designate_team_leader(uuid, uuid, uuid, uuid, date, integer, text, text)',
    'public.direct_entry_revoke_team_leader(uuid, uuid, uuid, date, integer, text, text)',
    'public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text)',
    'public.ai_provider_config_test_result(text, integer, boolean, text, text)',
    'public.ai_provider_config_activate(text, integer, text)',
    'public.ai_provider_config_disable(text, integer, text)',
    'public.ai_provider_config_rejected(text, integer, text, text)'
  ];
  v_internal_fns text[] := array[
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
    'public.direct_entry_reporting_resolve_audience(uuid, uuid)',
    'public.worker_edit_history_assert_actor(uuid, uuid)',
    'public.direct_entry_assert_team_leader_read_authority(uuid, uuid, uuid)',
    'public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text)'
  ];
  v_sig text;
  v_oid oid;
  v_proc_owner oid;
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean := false;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner is null or v_base_owner_oid is null then
    raise exception 'WP5B2 alignment failed: base owner missing' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_sig);
    execute pg_catalog.format('grant execute on function %s to service_role', v_sig);
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
    execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_sig);
  end loop;
end
$align_wp5b2$;

do $check_wp5b2$
declare
  v_service_rpcs text[] := array[
    'public.direct_entry_account_operation_finalize_create(uuid, uuid, uuid, uuid, uuid, text)',
    'public.direct_entry_account_operation_create_personnel(uuid, uuid, uuid, integer, text, text, date, text, text)',
    'public.direct_entry_account_operation_link_recruiter(uuid, uuid, uuid, integer, uuid, integer, text, text)',
    'public.direct_entry_list_missing_document_workers(uuid, uuid, text, text, text, text, integer, integer)',
    'public.direct_entry_reserve_document_direct_upload(uuid, uuid, uuid, integer, text, text, bigint, text, text)',
    'public.direct_entry_list_team_leader_candidates(uuid, uuid, uuid, text, integer, integer)',
    'public.direct_entry_designate_team_leader(uuid, uuid, uuid, uuid, date, integer, text, text)',
    'public.direct_entry_revoke_team_leader(uuid, uuid, uuid, date, integer, text, text)',
    'public.ai_provider_config_save(text, integer, text, text, text, text, jsonb, text, text, text)',
    'public.ai_provider_config_test_result(text, integer, boolean, text, text)',
    'public.ai_provider_config_activate(text, integer, text)',
    'public.ai_provider_config_disable(text, integer, text)',
    'public.ai_provider_config_rejected(text, integer, text, text)'
  ];
  v_internal_fns text[] := array[
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
    'public.direct_entry_reporting_resolve_audience(uuid, uuid)',
    'public.worker_edit_history_assert_actor(uuid, uuid)',
    'public.direct_entry_assert_team_leader_read_authority(uuid, uuid, uuid)',
    'public.direct_entry_apply_team_leader_mutation(uuid, uuid, uuid, uuid, date, integer, text, text, text, text)'
  ];
  v_tables text[] := array[
    'authz_system_state',
    'authz_role_definitions',
    'authz_role_capabilities',
    'authz_account_role_assignments',
    'authz_direct_capability_grants',
    'authz_audit_events',
    'authz_idempotency'
  ];
  v_base_owner_oid oid;
  v_sig text;
  v_tbl text;
  v_oid oid;
  v_rec record;
begin
  if pg_catalog.to_regprocedure('public.worker_edit_history_is_allowlisted_admin(uuid, uuid)') is not null then
    raise exception 'WP5B2 security check failed: worker_edit_history_is_allowlisted_admin must be dropped'
      using errcode = '55000';
  end if;

  select p.proowner
    into v_base_owner_oid
    from pg_catalog.pg_proc p
   where p.oid = 'public.direct_entry_resolve_actor_context(uuid)'::pg_catalog.regprocedure;

  foreach v_tbl in array v_tables loop
    v_oid := pg_catalog.to_regclass('public.' || v_tbl);
    if v_oid is null then
      raise exception 'WP5B2 security check failed: missing table %', v_tbl using errcode = '55000';
    end if;

    select c.relrowsecurity, c.relforcerowsecurity
      into v_rec
      from pg_catalog.pg_class c
     where c.oid = v_oid;

    if not coalesce(v_rec.relrowsecurity, false)
       or not coalesce(v_rec.relforcerowsecurity, false) then
      raise exception 'WP5B2 security check failed: FORCE RLS missing on %', v_tbl using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP5B2 security check failed: missing service RPC %', v_sig using errcode = '55000';
    end if;

    select p.prosecdef, p.proconfig, p.proowner, p.proacl, r.rolsuper, r.rolbypassrls
      into v_rec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[])))
       or not (coalesce(v_rec.rolsuper, false) or coalesce(v_rec.rolbypassrls, false))
       or not pg_catalog.pg_has_role(v_rec.proowner, v_base_owner_oid, 'USAGE') then
      raise exception 'WP5B2 security definer owner/RLS/ACL boundary drift: owner/config invalid for %', v_sig
        using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(v_rec.proacl, '{}'::aclitem[])) a
          where a.grantee = 0
       ) then
      raise exception 'WP5B2 security definer owner/RLS/ACL boundary drift: ACL invalid for %', v_sig
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'WP5B2 security check failed: missing internal function %', v_sig using errcode = '55000';
    end if;

    select p.prosecdef, p.proconfig, p.proowner, p.proacl, r.rolsuper, r.rolbypassrls
      into v_rec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_rec.prosecdef, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[])))
       or not (coalesce(v_rec.rolsuper, false) or coalesce(v_rec.rolbypassrls, false)) then
      raise exception 'WP5B2 security definer owner/RLS/ACL boundary drift: internal owner/config invalid for %', v_sig
        using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or exists (
         select 1
           from pg_catalog.aclexplode(coalesce(v_rec.proacl, '{}'::aclitem[])) a
          where a.grantee = 0
       ) then
      raise exception 'WP5B2 security definer owner/RLS/ACL boundary drift: internal ACL invalid for %', v_sig
        using errcode = '55000';
    end if;
  end loop;
end
$check_wp5b2$;

commit;
