-- Migration #237: PR #28 — Fail-closed preflight, atomic group-only authorization cutover,
-- obsolete integration/per-account-role/module-grant RPC retirement, and legacy column cleanup.
--
-- Preconditions enforced atomically before ANY DDL or DML:
--   1. Zero rows in public.direct_entry_app_users with account_type IN ('SHARED', 'SERVICE').
--   2. Zero rows in public.leave_employee_profiles with is_shared_non_employee = true.
--   3. Zero unmappable active rows in public.authz_direct_capability_grants outside D1 group ceiling.
--   4. Zero enabled uncutover rows (authz_managed = false) with active direct_entry_capability_grants.
--
-- Historical tables (authz_account_role_assignments, authz_direct_capability_grants,
-- vendor_finance_global_roles, leave_module_grants) and audit CHECK constraints preserving
-- 'ACCOUNT_TYPE_UPDATED' remain 100% intact for immutable history; runtime readers & writers
-- cut over exclusively to permission groups + independent business resource assignments.

begin;

-- ============================================================================
-- 1. FAIL-CLOSED PREFLIGHT GATES (aborts with 0 DDL/DML if preconditions fail)
-- ============================================================================
do $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_legacy_acct_count integer := 0;
  v_legacy_shared_profile_count integer := 0;
  v_unmappable_direct_count integer := 0;
  v_uncutover_legacy_count integer := 0;
begin
  -- Gate 1: Unresolved legacy technical account types
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'direct_entry_app_users'
       and column_name = 'account_type'
  ) then
    execute 'select count(*)::integer from public.direct_entry_app_users where account_type in (''SHARED'', ''SERVICE'')'
       into v_legacy_acct_count;
    if v_legacy_acct_count > 0 then
      raise exception 'PR28_CLEANUP_BLOCKED_UNRESOLVED_LEGACY_ACCOUNT_TYPES: % row(s) still have account_type IN (SHARED, SERVICE)', v_legacy_acct_count
        using errcode = 'P0001';
    end if;
  end if;

  -- Gate 2: Unresolved legacy shared leave employee profiles
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'leave_employee_profiles'
       and column_name = 'is_shared_non_employee'
  ) then
    execute 'select count(*)::integer from public.leave_employee_profiles where is_shared_non_employee = true'
       into v_legacy_shared_profile_count;
    if v_legacy_shared_profile_count > 0 then
      raise exception 'PR28_CLEANUP_BLOCKED_UNRESOLVED_LEGACY_SHARED_PROFILES: % row(s) still have is_shared_non_employee = true', v_legacy_shared_profile_count
        using errcode = 'P0001';
    end if;
  end if;

  -- Gate 3: Unmappable active authz_direct_capability_grants outside D1 group ceiling
  -- (never auto-upgrades non-Admin report-only or project/department exceptions to Admin,
  --  never treats an overlapping role/group as covering an independent direct grant,
  --  never silently drops them, and never retains infinite legacy fallback).
  select count(*)::integer
    into v_unmappable_direct_count
    from public.authz_direct_capability_grants dg
   where dg.ended_at is null
     and dg.started_at <= v_now
     -- Ignore grants already migrated by their own direct_grant_id lineage
     and not exists (
       select 1
         from public.authz_legacy_direct_grant_migrations dm
        where dm.direct_grant_id = dg.direct_grant_id
     )
     and not exists (
       select 1
         from public.authz_user_group_members m_prev
        where m_prev.migrated_from_source = 'authz_direct_capability_grants'
          and m_prev.migrated_from_id = dg.direct_grant_id
     )
     -- Ignore grants that ARE cleanly D1-mappable by direct_entry_authz__internal_backfill_legacy_to_groups()
     and not (
       (dg.capability = 'vendor_finance_view' and dg.scope_kind = 'ALL' and dg.scope_id is null)
       or (
         dg.scope_kind = 'CONTEXT_TEAM'
         and dg.scope_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         and dg.capability in (
           'entry_team', 'team_manager_assign', 'change_review',
           'report_view', 'report_analytics_view', 'report_assign',
           'report_review', 'report_delegate', 'worker_edit_history_view'
         )
         and exists (
           select 1 from public.teams t
            where t.team_id = dg.scope_id::uuid
              and t.active = true
              and t.code <> '__system_vendor__'
         )
       )
       or (
         dg.scope_kind = 'OWN'
         and dg.scope_id is null
         and dg.capability in (
           'entry_create', 'entry_own', 'submission_create', 'document_upload',
           'document_view', 'change_request_create', 'employment_status.request'
         )
       )
       or (
         dg.scope_kind = 'ALL'
         and dg.scope_id is null
         and dg.capability in (
           'recruiter_master_manage', 'team_master_manage', 'audit_view',
           'catalog_master_manage', 'report_form_manage', 'report_assign',
           'report_review', 'report_delegate', 'duplicate_cccd_withdraw',
           'worker_edit_history_view'
         )
       )
     );

  if v_unmappable_direct_count > 0 then
    raise exception 'PR28_CLEANUP_BLOCKED_UNMAPPABLE_DIRECT_GRANTS: % active authz_direct_capability_grants row(s) cannot map to D1 permission groups without T0/Owner decision', v_unmappable_direct_count
      using errcode = 'P0001';
  end if;

  -- Gate 4: Uncutover legacy users still relying on pre-WP5 direct_entry_capability_grants
  -- (enabled with is_current = true, OR disabled with suspended_by_account_disable = true
  --  which would resurrect pre-WP5 legacy grants upon re-enable)
  select count(distinct u.app_user_id)::integer
    into v_uncutover_legacy_count
    from public.direct_entry_app_users u
    join public.direct_entry_capability_grants cg
      on cg.app_user_id = u.app_user_id
     and (
       (u.enabled = true and cg.is_current = true)
       or cg.suspended_by_account_disable = true
     )
   where not coalesce(u.authz_managed, false);

  if v_uncutover_legacy_count > 0 then
    raise exception 'PR28_CLEANUP_BLOCKED_UNCUTOVER_LEGACY_GRANTS: % user(s) still have authz_managed = false with active or suspended direct_entry_capability_grants', v_uncutover_legacy_count
      using errcode = 'P0001';
  end if;
end;
$$;

-- ============================================================================
-- 1B. IDEMPOTENT CATCH-UP BACKFILL BEFORE GROUP-ONLY CUTOVER
-- ============================================================================
do $$
begin
  perform public.direct_entry_authz__internal_backfill_legacy_to_groups();

  -- Mark any account that holds a backfilled or admin-assigned group membership as authz_managed = true
  update public.direct_entry_app_users u
     set authz_managed = true,
         updated_at = pg_catalog.clock_timestamp()
   where not coalesce(u.authz_managed, false)
     and exists (
       select 1
         from public.authz_user_group_members m
        where m.app_user_id = u.app_user_id
          and m.ended_at is null
     );
end;
$$;

-- ============================================================================
-- 2. CLEAN ACTIVE SQL FUNCTIONS & TRIGGERS (0 account_type / is_shared_non_employee)
-- ============================================================================

-- direct_entry_list_app_users_admin(uuid,uuid,text,text,integer,integer)
CREATE OR REPLACE FUNCTION public.direct_entry_list_app_users_admin(p_auth_subject uuid, p_app_user_id uuid, p_search text DEFAULT NULL::text, p_enabled text DEFAULT 'all'::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_search text;
  v_total integer;
  v_accounts jsonb;
  v_offset integer;
begin
  perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);

  if (p_search is not null and (btrim(p_search) = '' or length(p_search) > 256))
     or p_enabled is null or p_enabled not in ('all', 'true', 'false')
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'account list query is invalid' using errcode = '22023';
  end if;

  v_search := nullif(btrim(p_search), '');
  v_offset := (p_page - 1) * p_page_size;

  select count(*)::integer
    into v_total
    from public.direct_entry_app_users u
    join auth.users au on au.id = u.auth_subject
    left join lateral (
      select op.full_name
        from public.organization_account_person_links pl
        join public.organization_persons op on op.person_id = pl.person_id
       where pl.app_user_id = u.app_user_id
         and pl.ended_at is null
       order by pl.started_at desc, pl.link_id desc
       limit 1
    ) active_person on true
    left join lateral (
      select r.display_name
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified
         and l.is_current
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
   where (v_search is null
       or coalesce(active_person.full_name, linked.display_name, u.display_name) ilike '%' || v_search || '%'
       or pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1) ilike '%' || v_search || '%')
     and (p_enabled = 'all'
       or (p_enabled = 'true' and u.enabled)
       or (p_enabled = 'false' and not u.enabled));

  select coalesce(
           jsonb_agg(
             public.direct_entry_app_user_projection(account_row.app_user)
             order by account_row.resolved_name, account_row.resolved_login, account_row.app_user_id
           ),
           '[]'::jsonb
         )
    into v_accounts
    from (
      select u as app_user,
             u.app_user_id,
             coalesce(active_person.full_name, linked.display_name, u.display_name) as resolved_name,
             pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1) as resolved_login
        from public.direct_entry_app_users u
        join auth.users au on au.id = u.auth_subject
        left join lateral (
          select op.full_name
            from public.organization_account_person_links pl
            join public.organization_persons op on op.person_id = pl.person_id
           where pl.app_user_id = u.app_user_id
             and pl.ended_at is null
           order by pl.started_at desc, pl.link_id desc
           limit 1
        ) active_person on true
        left join lateral (
          select r.display_name
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = u.app_user_id
             and l.verified
             and l.is_current
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) linked on true
       where (v_search is null
           or coalesce(active_person.full_name, linked.display_name, u.display_name) ilike '%' || v_search || '%'
           or pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1) ilike '%' || v_search || '%')
         and (p_enabled = 'all'
           or (p_enabled = 'true' and u.enabled)
           or (p_enabled = 'false' and not u.enabled))
       order by coalesce(active_person.full_name, linked.display_name, u.display_name),
                pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1),
                u.app_user_id
       limit p_page_size offset v_offset
    ) account_row;

  return jsonb_build_object(
    'search', v_search,
    'enabled', p_enabled,
    'page', p_page,
    'page_size', p_page_size,
    'total', v_total,
    'accounts', v_accounts
  );
end;
$function$
;

-- attendance__internal_is_non_employee_account(uuid,timestamp with time zone)
CREATE OR REPLACE FUNCTION public.attendance__internal_is_non_employee_account(p_app_user_id uuid, p_as_of timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  -- PR #28: all remaining login accounts are personal human accounts after legacy technical cleanup.
  return false;
end;
$function$
;

-- attendance_decide_explanation(uuid,uuid,uuid,text,integer,text,text,text)
CREATE OR REPLACE FUNCTION public.attendance_decide_explanation(p_actor_auth_subject uuid, p_actor_app_user_id uuid, p_explanation_id uuid, p_decision text, p_expected_row_version integer, p_decision_note text DEFAULT ''::text, p_idempotency_key text DEFAULT NULL::text, p_request_fingerprint text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_auth jsonb;
  v_today_local date := (pg_catalog.clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_decision text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_decision, '')));
  v_note text := pg_catalog.btrim(coalesce(p_decision_note, ''));
  v_idempotency_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_request_fingerprint, '')));
  v_existing_idem public.attendance_explanation_idempotency_records%rowtype;
  v_row public.attendance_explanations%rowtype;
  v_next_status text;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(
    p_actor_auth_subject,
    p_actor_app_user_id
  );

  -- Replay already-completed decision for the same active non-shared actor before live
  -- approver gate (e.g. a revoked HEAD retrying their final frozen pending explanation).
  if pg_catalog.char_length(v_idempotency_key) >= 8
     and pg_catalog.char_length(v_idempotency_key) <= 128
     and v_fingerprint ~ '^[0-9a-f]{64}$' then
    select *
      into v_existing_idem
      from public.attendance_explanation_idempotency_records r
     where r.app_user_id = p_actor_app_user_id
       and r.operation = 'explanation_decide'
       and r.idempotency_key = v_idempotency_key;

    if found then
      if v_existing_idem.request_fingerprint <> v_fingerprint then
        raise exception 'IDEMPOTENCY_CONFLICT'
          using errcode = 'PT409';
      end if;
      return pg_catalog.jsonb_set(v_existing_idem.response_payload, '{replayed}', 'true'::jsonb, true);
    end if;
  end if;

  if not coalesce((v_auth ->> 'can_approve_requests')::boolean, false) then
    raise exception 'ATTENDANCE_EXPLANATION_DECIDE_DENIED'
      using errcode = '42501';
  end if;

  if pg_catalog.char_length(v_idempotency_key) < 8
     or pg_catalog.char_length(v_idempotency_key) > 128
     or v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'ATTENDANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('attendance_explanation_decide'),
    pg_catalog.hashtext(coalesce(p_explanation_id::text, ''))
  );

  select *
    into v_existing_idem
    from public.attendance_explanation_idempotency_records r
   where r.app_user_id = p_actor_app_user_id
     and r.operation = 'explanation_decide'
     and r.idempotency_key = v_idempotency_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'IDEMPOTENCY_CONFLICT'
        using errcode = 'PT409';
    end if;
    return pg_catalog.jsonb_set(v_existing_idem.response_payload, '{replayed}', 'true'::jsonb, true);
  end if;

  if p_explanation_id is null
     or v_decision not in ('APPROVE', 'REJECT')
     or p_expected_row_version is null
     or p_expected_row_version < 1 then
    raise exception 'ATTENDANCE_EXPLANATION_DECISION_INVALID'
      using errcode = '22023';
  end if;

  if pg_catalog.char_length(v_note) > 500
     or v_note ~ '[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]' then
    raise exception 'ATTENDANCE_EXPLANATION_NOTE_INVALID'
      using errcode = '22023';
  end if;

  select *
    into v_row
    from public.attendance_explanations ae
   where ae.explanation_id = p_explanation_id
   for update;

  if not found then
    raise exception 'ATTENDANCE_EXPLANATION_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_row.app_user_id = p_actor_app_user_id then
    raise exception 'ATTENDANCE_EXPLANATION_SELF_APPROVAL_FORBIDDEN'
      using errcode = '42501';
  end if;

  if not public.attendance_explanation__internal_can_actor_decide(
    p_actor_app_user_id,
    v_row,
    v_today_local
  ) then
    raise exception 'ATTENDANCE_EXPLANATION_DECIDE_DENIED'
      using errcode = '42501';
  end if;

  if v_row.row_version <> p_expected_row_version then
    raise exception 'ATTENDANCE_EXPLANATION_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_row.status <> 'PENDING' then
    raise exception 'ATTENDANCE_EXPLANATION_ALREADY_DECIDED'
      using errcode = 'PT409';
  end if;

  v_next_status := case when v_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end;

  update public.attendance_explanations
     set status = v_next_status,
         decided_at = pg_catalog.clock_timestamp(),
         decided_by_app_user_id = p_actor_app_user_id,
         decision_note = v_note,
         row_version = v_row.row_version + 1,
         updated_at = pg_catalog.clock_timestamp()
   where explanation_id = p_explanation_id
  returning * into v_row;

  insert into public.attendance_explanation_audit_events (
    explanation_id,
    action,
    actor_app_user_id,
    before_status,
    after_status,
    note,
    payload
  )
  values (
    v_row.explanation_id,
    v_next_status,
    p_actor_app_user_id,
    'PENDING',
    v_next_status,
    v_note,
    pg_catalog.jsonb_build_object(
      'decision', v_decision,
      'business_date', v_row.business_date::text,
      'slot_code', v_row.slot_code
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'explanation', public.attendance_explanation__internal_project_item(v_row)
  );

  insert into public.attendance_explanation_idempotency_records (
    app_user_id,
    operation,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    p_actor_app_user_id,
    'explanation_decide',
    v_idempotency_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$
;

-- attendance_get_my_explanations_overview(uuid,uuid,date,integer,integer)
CREATE OR REPLACE FUNCTION public.attendance_get_my_explanations_overview(p_actor_auth_subject uuid, p_actor_app_user_id uuid, p_business_date date DEFAULT NULL::date, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_auth jsonb;
  v_today_local date := (clock_timestamp() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_selected_date date := coalesce(p_business_date, v_today_local);
  v_limit integer := coalesce(p_limit, 50);
  v_offset integer := coalesce(p_offset, 0);
  v_routing jsonb;
  v_primary_approver_id uuid;
  v_day_evaluation jsonb;
  v_total_rows integer := 0;
  v_items jsonb := '[]'::jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(
    p_actor_auth_subject,
    p_actor_app_user_id
  );

  if v_selected_date < date '2000-01-01' or v_selected_date > date '2100-12-31' then
    raise exception 'ATTENDANCE_EXPLANATION_DATE_INVALID'
      using errcode = '22023';
  end if;

  if v_limit < 1 or v_limit > 200 or v_offset < 0 then
    raise exception 'ATTENDANCE_EXPLANATION_PAGINATION_INVALID'
      using errcode = '22023';
  end if;

  v_routing := public.leave_management__internal_resolve_routing(
    p_actor_app_user_id,
    v_today_local
  );

  if (v_routing ->> 'primary_approver_app_user_id') is not null then
    v_primary_approver_id := (v_routing ->> 'primary_approver_app_user_id')::uuid;
  end if;

  v_day_evaluation := public.attendance_explanation__internal_evaluate_employee_day_slots(
    p_actor_app_user_id,
    v_selected_date
  );

  select count(*)::integer
    into v_total_rows
  from public.attendance_explanations ae
  where ae.app_user_id = p_actor_app_user_id;

  select coalesce(
    jsonb_agg(
      public.attendance_explanation__internal_project_item(s.row_data)
      order by s.submitted_at desc, s.explanation_id desc
    ),
    '[]'::jsonb
  )
    into v_items
  from (
    select ae as row_data, ae.submitted_at, ae.explanation_id
    from public.attendance_explanations ae
    where ae.app_user_id = p_actor_app_user_id
    order by ae.submitted_at desc, ae.explanation_id desc
    limit v_limit
    offset v_offset
  ) s;

  return jsonb_build_object(
    'viewer', jsonb_build_object(
      'app_user_id', p_actor_app_user_id,
      'can_submit_explanation', (v_auth ->> 'can_submit_request')::boolean,
      'can_approve_explanations', (v_auth ->> 'can_approve_requests')::boolean,
      'is_full_admin', (v_auth ->> 'is_full_admin')::boolean,
      'is_bod', (v_auth ->> 'is_bod')::boolean
    ),
    'routing', jsonb_build_object(
      'route_kind', v_routing ->> 'route_kind',
      'unit_kind', v_routing ->> 'unit_kind',
      'primary_approver', case
        when v_primary_approver_id is not null then
          public.leave_management__internal_account_summary(v_primary_approver_id)
        else null
      end,
      'team_id', v_routing ->> 'team_id',
      'team_code', v_routing ->> 'team_code',
      'team_name', v_routing ->> 'team_name',
      'fallback_reason', v_routing ->> 'fallback_reason',
      'profile_configured', (v_routing ->> 'profile_configured')::boolean
    ),
    'today_local', v_today_local::text,
    'selected_date', v_selected_date::text,
    'day_evaluation', v_day_evaluation,
    'pagination', jsonb_build_object(
      'limit', v_limit,
      'offset', v_offset,
      'total_rows', v_total_rows
    ),
    'items', v_items
  );
end;
$function$
;

-- direct_entry_account_operation_create_personnel(uuid,uuid,uuid,integer,text,text,date,text,text)
CREATE OR REPLACE FUNCTION public.direct_entry_account_operation_create_personnel(p_auth_subject uuid, p_actor_app_user_id uuid, p_account_ref uuid, p_expected_account_version integer, p_personnel_code text, p_personnel_position text, p_valid_from date, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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

  -- Legacy mirrors are strictly derived from active permission groups (zero direct writes outside group sync)
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
$function$
;

-- direct_entry_account_operation_link_recruiter(uuid,uuid,uuid,integer,uuid,integer,text,text)
CREATE OR REPLACE FUNCTION public.direct_entry_account_operation_link_recruiter(p_auth_subject uuid, p_actor_app_user_id uuid, p_recruiter_id uuid, p_expected_recruiter_version integer, p_account_ref uuid, p_expected_account_version integer, p_reason text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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

  -- Legacy mirrors are strictly derived from active permission groups (zero direct writes outside group sync)
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
$function$
;

-- direct_entry_app_user_projection(direct_entry_app_users)
CREATE OR REPLACE FUNCTION public.direct_entry_app_user_projection(p_app_user direct_entry_app_users)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_login_id text := null;
  v_active_person_link jsonb := null;
  v_display_name text := null;
  v_today date := public.direct_entry_authorization_date();
begin
  select pg_catalog.lower(
           nullif(
             pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1),
             ''
           )
         )
    into v_login_id
    from auth.users au
   where au.id = p_app_user.auth_subject;

  select pg_catalog.jsonb_build_object(
           'link_id', l.link_id,
           'person_id', p.person_id,
           'employee_code', p.employee_code,
           'full_name', p.full_name,
           'started_at', public.org_department__internal_iso_utc(l.started_at),
           'person_version', p.version
         ),
         p.full_name
    into v_active_person_link, v_display_name
    from public.organization_account_person_links l
    join public.organization_persons p
      on p.person_id = l.person_id
   where l.app_user_id = p_app_user.app_user_id
     and l.ended_at is null
   order by l.started_at desc, l.link_id desc
   limit 1;

  if v_active_person_link is null then
    select r.display_name
      into v_display_name
      from public.direct_entry_app_user_recruiter_links rl
      join public.recruiters r
        on r.recruiter_id = rl.recruiter_id
     where rl.app_user_id = p_app_user.app_user_id
       and rl.verified = true
       and rl.valid_from <= v_today
       and (rl.valid_to is null or v_today < rl.valid_to)
     order by rl.valid_from desc, rl.link_id desc
     limit 1;
  end if;

  return pg_catalog.jsonb_build_object(
    'account_ref', p_app_user.app_user_id,
    'login_id', v_login_id,
    'display_name', coalesce(v_display_name, nullif(p_app_user.display_name, v_login_id)),
    'enabled', p_app_user.enabled,
    'version', p_app_user.version,
    'active_person_link', v_active_person_link
  );
end;
$function$
;

-- direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)
CREATE OR REPLACE FUNCTION public.direct_entry_assert_team_leader_current_team(p_auth_subject uuid, p_app_user_id uuid, p_team_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_authz_managed boolean := false;
  v_scope_count integer := 0;
  v_scope_team_id uuid;
  v_assignment_count integer := 0;
  v_matching_assignment_count integer := 0;
  v_assignment_recruiter_id uuid;
  v_paired_team_count integer := 0;
  v_matching_paired_team_count integer := 0;
  v_link_count integer := 0;
  v_link_recruiter_id uuid;
  v_provider_count integer := 0;
  v_hrp_provider_count integer := 0;
  v_membership_count integer := 0;
  v_matching_membership_count integer := 0;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if v_authz_managed then
    select count(*)::integer,
           (pg_catalog.array_agg(a.team_id order by a.assignment_id))[1],
           (pg_catalog.array_agg(a.leader_recruiter_id order by a.assignment_id))[1]
      into v_assignment_count, v_scope_team_id, v_assignment_recruiter_id
      from public.direct_entry_team_leader_assignments a
      join public.teams t
        on t.team_id = a.team_id
       and t.active
       and t.code <> '__system_vendor__'
     where a.leader_app_user_id = p_app_user_id
       and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today);

    if v_assignment_count <> 1
       or v_scope_team_id is null
       or v_assignment_recruiter_id is null
       or (p_team_id is not null and p_team_id <> v_scope_team_id) then
      raise exception 'team leader authority denied' using errcode = '42501';
    end if;

    select count(*)::integer,
           count(*) filter (where g.scope_id = v_scope_team_id::text)::integer
      into v_paired_team_count, v_matching_paired_team_count
      from (
        select distinct g.scope_id
          from pg_catalog.jsonb_to_recordset(
            public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id)
          ) as g(capability text, scope_kind text, scope_id text)
         where g.capability = 'team_manager_assign'
           and g.scope_kind = 'CONTEXT_TEAM'
           and g.scope_id is not null
           and pg_catalog.btrim(g.scope_id) <> ''
      ) g;

    if v_paired_team_count <> 1
       or v_matching_paired_team_count <> 1 then
      raise exception 'team leader authority denied' using errcode = '42501';
    end if;

    select count(*)::integer
      into v_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_app_user_id
       and l.verified
       and l.is_current;

    if v_link_count <> 1 then
      raise exception 'team leader authority denied' using errcode = '42501';
    end if;

    select l.recruiter_id
      into v_link_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r
        on r.recruiter_id = l.recruiter_id
       and r.active
     where l.app_user_id = p_app_user_id
       and l.verified
       and l.is_current
       and not l.suspended_by_account_disable
       and l.valid_from <= v_today
       and (l.valid_to is null or (l.valid_to > l.valid_from and v_today < l.valid_to));

    if v_link_recruiter_id is null or v_link_recruiter_id <> v_assignment_recruiter_id then
      raise exception 'team leader authority denied' using errcode = '42501';
    end if;

    select count(*)::integer,
           count(*) filter (where m.provider_type = 'hrp' and m.vendor_id is null)::integer
      into v_provider_count, v_hrp_provider_count
      from public.recruiter_provider_memberships m
     where m.recruiter_id = v_link_recruiter_id
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today);

    if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
      raise exception 'team leader authority denied' using errcode = '42501';
    end if;

    select count(*)::integer,
           count(*) filter (where m.team_id = v_scope_team_id)::integer
      into v_membership_count, v_matching_membership_count
      from public.recruiter_team_memberships m
     where m.recruiter_id = v_link_recruiter_id
       and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today);

    if v_membership_count <> 1 or v_matching_membership_count <> 1 then
      raise exception 'team leader authority denied' using errcode = '42501';
    end if;

    return v_scope_team_id;
  end if;

  -- Pre-cutover (authz_managed = false): preserve exact R1 & rollover behavior.
  if not public.direct_entry_has_capability(p_app_user_id, 'team_manager_assign') then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::integer, (pg_catalog.array_agg(s.team_id))[1]
    into v_scope_count, v_scope_team_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_app_user_id
     and s.scope_kind = 'team'
     and public.direct_entry__internal_team_scope_grant_effective(s.grant_id, v_today);

  if v_scope_count <> 1 or v_scope_team_id is null
     or (p_team_id is not null and p_team_id <> v_scope_team_id) then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.teams t
     where t.team_id = v_scope_team_id and t.active and t.code <> '__system_vendor__'
  ) then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::integer, (pg_catalog.array_agg(l.recruiter_id))[1]
    into v_link_count, v_link_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id and l.verified and l.is_current;

  if v_link_count <> 1 or v_link_recruiter_id is null then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.recruiters r
     where r.recruiter_id = v_link_recruiter_id and r.active
  ) then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::integer,
         count(*) filter (where m.provider_type = 'hrp' and m.vendor_id is null)::integer
    into v_provider_count, v_hrp_provider_count
    from public.recruiter_provider_memberships m
   where m.recruiter_id = v_link_recruiter_id
     and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, v_today);

  if v_provider_count <> 1 or v_hrp_provider_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::integer,
         count(*) filter (where m.team_id = v_scope_team_id)::integer
    into v_membership_count, v_matching_membership_count
    from public.recruiter_team_memberships m
   where m.recruiter_id = v_link_recruiter_id
     and public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, v_today);

  if v_membership_count <> 1 or v_matching_membership_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select count(*)::integer,
         count(*) filter (where a.leader_recruiter_id = v_link_recruiter_id
                            and a.team_id = v_scope_team_id)::integer
    into v_assignment_count, v_matching_assignment_count
    from public.direct_entry_team_leader_assignments a
   where a.leader_app_user_id = p_app_user_id
     and public.direct_entry__internal_team_leader_assignment_effective(a.assignment_id, v_today);

  if v_assignment_count <> 1 or v_matching_assignment_count <> 1 then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  return v_scope_team_id;
end;
$function$
;

-- direct_entry_authz__internal_resolve_effective_grants(uuid)
CREATE OR REPLACE FUNCTION public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  group_bundle_grants as (
    -- Compatibility projection derived strictly per-group from authz_user_groups*.
    -- Anti-Cartesian: each capability stays bound to its own group's (is_system_admin, team_id).
    select
      gc.capability,
      case
        when g.is_system_admin then
          case when gc.capability = 'entry_own' then 'OWN'::text else 'ALL'::text end
        when g.team_id is not null then
          case
            when gc.capability in (
              'entry_create',
              'entry_own',
              'submission_create',
              'document_upload',
              'document_view',
              'change_request_create',
              'employment_status.request'
            ) then 'OWN'::text
            else 'CONTEXT_TEAM'::text
          end
        else
          case
            when gc.capability in (
              'entry_create',
              'entry_own',
              'submission_create',
              'document_upload',
              'change_request_create',
              'employment_status.request'
            ) then 'OWN'::text
            when gc.capability = 'document_view' then
              case
                when exists (
                  select 1
                    from public.authz_user_group_capabilities gc2
                   where gc2.group_id = g.group_id
                     and gc2.ended_at is null
                     and gc2.started_at <= v_now
                     and gc2.capability in (
                       'recruiter_master_manage',
                       'team_master_manage',
                       'catalog_master_manage',
                       'audit_view'
                     )
                ) then 'ALL'::text
                else 'OWN'::text
              end
            else 'ALL'::text
          end
      end as scope_kind,
      case
        when g.team_id is not null
             and gc.capability not in (
               'entry_create',
               'entry_own',
               'submission_create',
               'document_upload',
               'document_view',
               'change_request_create',
               'employment_status.request'
             ) then g.team_id::text
        else null::text
      end as scope_id,
      case
        when g.team_id is not null
             and gc.capability not in (
               'entry_create',
               'entry_own',
               'submission_create',
               'document_upload',
               'document_view',
               'change_request_create',
               'employment_status.request'
             ) then 'CONTEXTUAL_ASSIGNMENT'::text
        else 'ROLE_BUNDLE'::text
      end as source_type,
      m.membership_id::text as source_id,
      case
        when g.team_id is not null
             and gc.capability not in (
               'entry_create',
               'entry_own',
               'submission_create',
               'document_upload',
               'document_view',
               'change_request_create',
               'employment_status.request'
             ) then coalesce(t.display_name, t.code)
        when g.is_system_admin then
          case when gc.capability = 'entry_own' then 'OWN'::text else 'ALL'::text end
        when gc.capability in (
          'entry_create',
          'entry_own',
          'submission_create',
          'document_upload',
          'change_request_create',
          'employment_status.request'
        ) then 'OWN'::text
        when gc.capability = 'document_view' then
          case
            when exists (
              select 1
                from public.authz_user_group_capabilities gc2
               where gc2.group_id = g.group_id
                 and gc2.ended_at is null
                 and gc2.started_at <= v_now
                 and gc2.capability in (
                   'recruiter_master_manage',
                   'team_master_manage',
                   'catalog_master_manage',
                   'audit_view'
                 )
            ) then 'ALL'::text
            else 'OWN'::text
          end
        else 'ALL'::text
      end as scope_label
    from public.authz_user_group_members m
    join public.authz_user_groups g
      on g.group_id = m.group_id
     and g.active = true
    join public.organization_departments d
      on d.department_id = g.department_id
     and d.is_active = true
    left join public.teams t
      on t.team_id = g.team_id
     and t.active = true
     and t.code <> '__system_vendor__'
    join public.authz_user_group_capabilities gc
      on gc.group_id = g.group_id
     and gc.ended_at is null
     and gc.started_at <= v_now
    where m.app_user_id = p_app_user_id
      and m.ended_at is null
      and m.started_at <= v_now
      and (g.team_id is null or t.team_id is not null)
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
  contextual_tl_wr_review_grants as (
    select
      'report_review'::text as capability,
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
    where v_user.authz_managed
      and tla.leader_app_user_id = p_app_user_id
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
   where not v_user.authz_managed
     and tla.leader_app_user_id = p_app_user_id
     and x.capability = 'report_review'
     and cg.app_user_id = p_app_user_id
     and cg.capability = 'report_review'
     and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
     and public.direct_entry__internal_capability_grant_effective(cg.grant_id, v_today)
  ),
  legacy_bridge_candidates as (
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
      and cg.capability in (
        'entry_team', 'team_manager_assign', 'change_review',
        'report_view', 'report_analytics_view', 'report_assign', 'report_review', 'report_delegate'
      )
      and public.direct_entry__internal_capability_grant_effective(cg.grant_id, v_today)
      and public.direct_entry__internal_team_scope_grant_effective(sg.grant_id, v_today)
  ),
  canonical_items as (
    select * from group_bundle_grants
    union all
    select * from contextual_tl_grants
    union all
    select * from contextual_tl_wr_review_grants
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
$function$
;

-- direct_entry_list_missing_document_workers(uuid,uuid,text,text,text,text,integer,integer)
CREATE OR REPLACE FUNCTION public.direct_entry_list_missing_document_workers(p_auth_subject uuid, p_app_user_id uuid, p_missing_type text DEFAULT NULL::text, p_project_id text DEFAULT NULL::text, p_employment_status text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
$function$
;

-- direct_entry_mutate_app_user_status(uuid,uuid,uuid,integer,text,text,boolean)
CREATE OR REPLACE FUNCTION public.direct_entry_mutate_app_user_status(p_auth_subject uuid, p_actor_app_user_id uuid, p_target_app_user_id uuid, p_expected_app_user_version integer, p_reason text, p_idempotency_key text, p_enable boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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

  -- Canonical child lock acquisition before any writes (R -> T -> RPM -> RTM -> URL -> SG -> TLA -> CG)
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

  -- D10: On enable, restore ONLY suspended_by_account_disable rows whose invariants still hold.
  -- 12 pre-WP5 disabled accounts have suspended_by_account_disable = false and 0 authz_* rows.
  if p_enable then
    -- Step 1: Restore recruiter links before TL assignments (direct_entry_set_current_on_insert checks current link)
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

    -- Step 2: Restore TL assignments whose team, recruiter, and slot were not deactivated/replaced while disabled
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

    -- Clear any stale suspended_by_account_disable flags on remaining rows
    update public.direct_entry_scope_grants
       set suspended_by_account_disable = false
     where app_user_id = p_target_app_user_id
       and suspended_by_account_disable = true;

    update public.direct_entry_capability_grants
       set suspended_by_account_disable = false
     where app_user_id = p_target_app_user_id
       and suspended_by_account_disable = true;

    -- One-way sync when authz_managed = true
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
$function$
;

-- direct_entry_project_assignment_effective(uuid,text)
CREATE OR REPLACE FUNCTION public.direct_entry_project_assignment_effective(p_app_user_id uuid, p_project_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select p_app_user_id is not null
     and exists (
       select 1
         from public.direct_entry_project_manager_assignments a
         join public.direct_entry_app_user_recruiter_links l
           on l.recruiter_id = a.manager_recruiter_id
          and l.app_user_id = p_app_user_id
          and l.verified = true
          and l.is_current = true
          and not l.suspended_by_account_disable
         join public.direct_entry_app_users u
           on u.app_user_id = l.app_user_id
          and u.enabled = true
          and u.auth_subject is not null
         join public.recruiters r
           on r.recruiter_id = a.manager_recruiter_id
          and r.active = true
        where (p_project_id is null or a.project_id = p_project_id)
          and a.is_current = true
          and a.revoked_at is null
          and (
            not coalesce(u.authz_managed, false)
            or (
              a.valid_from <= public.direct_entry_authorization_date()
              and (
                a.valid_to is null
                or (a.valid_to > a.valid_from and public.direct_entry_authorization_date() < a.valid_to)
              )
              and l.valid_from <= public.direct_entry_authorization_date()
              and (
                l.valid_to is null
                or (l.valid_to > l.valid_from and public.direct_entry_authorization_date() < l.valid_to)
              )
            )
          )
          and (
            select count(*)::integer
              from public.direct_entry_app_user_recruiter_links current_link
             where current_link.recruiter_id = a.manager_recruiter_id
               and current_link.verified = true
               and current_link.is_current = true
          ) = 1
          and (
            select count(*)::integer
              from public.direct_entry_app_user_recruiter_links current_link
              join public.direct_entry_app_users linked_user
                on linked_user.app_user_id = current_link.app_user_id
             where current_link.recruiter_id = a.manager_recruiter_id
               and current_link.verified = true
               and current_link.is_current = true
               and linked_user.enabled = true
               and linked_user.auth_subject is not null
          ) = 1
     );
$function$
;

-- direct_entry_reporting_detailed_matrix_catalog(uuid,uuid)
CREATE OR REPLACE FUNCTION public.direct_entry_reporting_detailed_matrix_catalog(p_auth_subject uuid, p_app_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_aud jsonb;
  v_teams jsonb := '[]'::jsonb;
  v_recruiters jsonb := '[]'::jsonb;
begin
  v_aud := public.direct_entry_reporting_resolve_audience(p_auth_subject, p_app_user_id);
  if coalesce(v_aud->>'audience', '') <> 'all' then
    raise exception 'detailed recruitment matrix requires all scope'
      using errcode = '42501';
  end if;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'team_id', t.team_id,
               'team_code', t.code,
               'display_name', t.display_name
             )
             order by t.display_name asc, t.team_id asc
           ),
           '[]'::jsonb
         )
    into v_teams
    from public.teams t
   where t.active = true
     and t.code <> '__system_vendor__';

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'recruiter_id', sub.recruiter_id,
               'recruiter_key', sub.recruiter_key,
               'display_name', sub.display_name,
               'personnel_code', sub.personnel_code,
               'active', sub.active,
               'is_active_hrp', sub.is_active_hrp,
               'current_team_ids', sub.current_team_ids,
               'work_start_date', sub.work_start_date
             )
             order by sub.is_active_hrp desc, sub.active desc, sub.display_name asc, sub.recruiter_id asc
           ),
           '[]'::jsonb
         )
    into v_recruiters
    from (
      select r.recruiter_id,
             public.direct_entry_reporting_dim_key(r.display_name) as recruiter_key,
             pg_catalog.btrim(r.display_name) as display_name,
             nullif(pg_catalog.btrim(coalesce(r.personnel_code, '')), '') as personnel_code,
             r.active,
             (
               r.active
               and exists (
                 select 1
                   from public.recruiter_provider_memberships m
                  where m.recruiter_id = r.recruiter_id
                    and m.provider_type = 'hrp'
                    and m.vendor_id is null
                    and m.is_current = true
               )
             ) as is_active_hrp,
             coalesce(
               (
                 select pg_catalog.jsonb_agg(rtm.team_id order by t.display_name asc, rtm.team_id asc)
                   from public.recruiter_team_memberships rtm
                   join public.teams t
                     on t.team_id = rtm.team_id
                    and t.active = true
                    and t.code <> '__system_vendor__'
                  where rtm.recruiter_id = r.recruiter_id
                    and rtm.is_current = true
               ),
               '[]'::jsonb
             ) as current_team_ids,
             (
               select pg_catalog.to_char(lep.work_start_date, 'YYYY-MM-DD')
                 from public.direct_entry_app_user_recruiter_links l
                 join public.leave_employee_profiles lep
                   on lep.app_user_id = l.app_user_id
                where l.recruiter_id = r.recruiter_id
                  and l.verified = true
                  and (l.is_current = true or l.valid_to is null or l.valid_to > l.valid_from)
                  and coalesce(lep.employment_status, 'UNCONFIGURED') <> 'UNCONFIGURED'
                  and lep.work_start_date is not null
                order by l.is_current desc, l.valid_from desc, l.link_id asc
                limit 1
             ) as work_start_date
        from public.recruiters r
    ) sub;

  return pg_catalog.jsonb_build_object(
    'teams', v_teams,
    'recruiters', v_recruiters
  );
end;
$function$
;

-- direct_entry_resolve_actor_context(uuid)
CREATE OR REPLACE FUNCTION public.direct_entry_resolve_actor_context(p_auth_subject uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_app_user_id uuid;
  v_enabled boolean;
  v_authz_managed boolean := false;
  v_review_scopes jsonb := '[]'::jsonb;
  v_team_leader_team_id uuid := null;
  v_allowed_worker_tabs jsonb := '[]'::jsonb;
  v_effective_grants jsonb := '[]'::jsonb;
  v_assigned_roles jsonb := '[]'::jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_has_active_person boolean := false;
  v_is_non_employee boolean := false;
  v_has_tl_effective_grant boolean := false;
begin
  select u.app_user_id, u.enabled, coalesce(u.authz_managed, false)
    into v_app_user_id, v_enabled, v_authz_managed
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject;
  if not found then return null; end if;

  if v_enabled then
    v_effective_grants := public.direct_entry_authz__internal_resolve_effective_grants(v_app_user_id);

    if v_authz_managed then
      select coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
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
               where exists (
                 select 1
                   from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(capability text, scope_kind text, scope_id text)
                  where g.capability = 'report_review'
                    and g.scope_kind = 'ALL'
                    and g.scope_id is null
               )
              union all
              select 'team'::text as kind, t.team_id, coalesce(t.display_name, t.code) as label
                from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(capability text, scope_kind text, scope_id text)
                join public.teams t
                  on t.team_id::text = g.scope_id
                 and t.active
                 and t.code <> '__system_vendor__'
               where g.capability = 'report_review'
                 and g.scope_kind = 'CONTEXT_TEAM'
                 and g.scope_id is not null
                 and pg_catalog.btrim(g.scope_id) <> ''
              union all
              select d.scope_kind as kind,
                     case when d.scope_kind = 'team' then d.scope_team_id else null end as team_id,
                     case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end as label
                from public.work_report_delegations d
                left join public.teams tm on tm.team_id = d.scope_team_id
               where d.delegate_app_user_id = v_app_user_id
                 and d.capability = 'report_review'
                 and d.state = 'ACTIVE'
                 and d.is_current
                 and statement_timestamp() >= d.effective_from
                 and (d.effective_to is null or statement_timestamp() <= d.effective_to)
                 and public.work_report__internal_is_delegation_effective(d.delegation_id, statement_timestamp())
            ) raw_scopes
          ) s
      ), '[]'::jsonb)
        into v_review_scopes;
    else
      select coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
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
               where public.direct_entry_has_capability(v_app_user_id, 'report_review')
                 and public.direct_entry_has_scope(v_app_user_id, 'all')
              union all
              select 'team'::text as kind, t.team_id, coalesce(t.display_name, t.code) as label
                from public.direct_entry_scope_grants g
                join public.teams t on t.team_id = g.team_id and t.active
               where public.direct_entry_has_capability(v_app_user_id, 'report_review')
                 and g.app_user_id = v_app_user_id
                 and g.scope_kind = 'team'
                 and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
              union all
              select d.scope_kind as kind,
                     case when d.scope_kind = 'team' then d.scope_team_id else null end as team_id,
                     case when d.scope_kind = 'all' then 'Toàn công ty' else coalesce(tm.display_name, tm.code, 'Nhóm') end as label
                from public.work_report_delegations d
                left join public.teams tm on tm.team_id = d.scope_team_id
               where d.delegate_app_user_id = v_app_user_id
                 and d.capability = 'report_review'
                 and d.state = 'ACTIVE'
                 and d.is_current
                 and statement_timestamp() >= d.effective_from
                 and (d.effective_to is null or statement_timestamp() <= d.effective_to)
                 and public.work_report__internal_is_delegation_effective(d.delegation_id, statement_timestamp())
            ) raw_scopes
          ) s
      ), '[]'::jsonb)
        into v_review_scopes;
    end if;

    if v_authz_managed then
      select exists (
        select 1
          from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(capability text, scope_kind text, scope_id text)
         where g.capability = 'team_manager_assign'
           and g.scope_kind = 'CONTEXT_TEAM'
           and g.scope_id is not null
           and pg_catalog.btrim(g.scope_id) <> ''
      ) into v_has_tl_effective_grant;

      if coalesce(v_has_tl_effective_grant, false) then
        begin
          v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
            p_auth_subject, v_app_user_id, null
          );
        exception when insufficient_privilege then
          v_team_leader_team_id := null;
        end;
      end if;
    elsif public.direct_entry_has_capability(v_app_user_id, 'team_manager_assign') then
      begin
        v_team_leader_team_id := public.direct_entry_assert_team_leader_current_team(
          p_auth_subject, v_app_user_id, null
        );
      exception when insufficient_privilege then
        v_team_leader_team_id := null;
      end;
    end if;

    select coalesce(
      jsonb_agg(t.tab_id order by t.ord),
      '[]'::jsonb
    )
    into v_allowed_worker_tabs
    from (
      select 'uploader'::text as tab_id, 1 as ord
       where (
         case
           when v_authz_managed then (
             public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'submission_create', 'OWN', null)
             or public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'submission_create', 'ALL', null)
           )
           else (
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
         end
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
           join public.direct_entry_app_users u
             on u.app_user_id = l.app_user_id
            and u.enabled
          where l.app_user_id = v_app_user_id
            and l.verified
            and l.is_current
            and not l.suspended_by_account_disable
            and (
              not v_authz_managed
              or (
                l.valid_from <= v_today
                and (l.valid_to is null or (l.valid_to > l.valid_from and v_today < l.valid_to))
              )
            )
       )
      union all
      select 'managed'::text as tab_id, 3 as ord
       where public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'team'::text as tab_id, 4 as ord
       where v_team_leader_team_id is not null
      union all
      select 'all'::text as tab_id, 5 as ord
       where case
         when v_authz_managed then (
           public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'entry_admin', 'ALL', null)
           or public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'change_review', 'ALL', null)
         )
         else (
           public.direct_entry_has_scope(v_app_user_id, 'all')
           and (
             public.direct_entry_has_capability(v_app_user_id, 'entry_admin')
             or public.direct_entry_has_capability(v_app_user_id, 'change_review')
           )
         )
       end
    ) t;

    v_is_non_employee := public.attendance__internal_is_non_employee_account(v_app_user_id, v_now);

    select exists (
      select 1
        from public.organization_account_person_links l
        join public.organization_persons p on p.person_id = l.person_id and p.status = 'ACTIVE'
       where l.app_user_id = v_app_user_id
         and l.ended_at is null
         and l.started_at <= v_now
    ) into v_has_active_person;

    select coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'role_code', ar.role_code,
          'display_name', ar.display_name,
          'assignment_mode', ar.assignment_mode,
          'scope_kind', ar.scope_kind,
          'scope_id', ar.scope_id,
          'assignment_id', ar.assignment_id,
          'is_protected', ar.is_protected,
          'can_revoke', ar.can_revoke,
          'cannot_revoke_reason', ar.cannot_revoke_reason
        )
        order by ar.sort_order, ar.role_code, ar.scope_id nulls first
      ),
      '[]'::jsonb
    )
      into v_assigned_roles
      from (
        select
          case
            when g.is_system_admin then 4
            when g.code = 'HR_CATALOG_OPERATOR' then 3
            when g.code = 'RECRUITER_OPERATIONS' then 2
            else 1
          end as sort_order,
          case
            when g.is_system_admin then 'ADMIN'::text
            when g.code = 'HR_CATALOG_OPERATOR' then 'HR_OPERATOR'::text
            when g.code = 'RECRUITER_OPERATIONS' then 'RECRUITER'::text
            else g.code
          end as role_code,
          g.name as display_name,
          case when g.team_id is not null then 'CONTEXTUAL'::text else 'GLOBAL'::text end as assignment_mode,
          case when g.team_id is not null then 'CONTEXT_TEAM'::text else null::text end as scope_kind,
          g.team_id::text as scope_id,
          m.membership_id::text as assignment_id,
          m.is_protected,
          (not m.is_protected) as can_revoke,
          case when m.is_protected then 'PROTECTED_OWNER_ADMIN' else null end as cannot_revoke_reason
        from public.authz_user_group_members m
        join public.authz_user_groups g
          on g.group_id = m.group_id
         and g.active = true
        join public.organization_departments d
          on d.department_id = g.department_id
         and d.is_active = true
        left join public.teams t
          on t.team_id = g.team_id
         and t.active = true
         and t.code <> '__system_vendor__'
        where m.app_user_id = v_app_user_id
          and m.ended_at is null
          and m.started_at <= v_now
          and (g.team_id is null or t.team_id is not null)
        union all
        select
          5 as sort_order,
          'TEAM_LEADER'::text as role_code,
          'Trưởng nhóm (Team Leader)'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_TEAM'::text as scope_kind,
          t.team_id::text as scope_id,
          tla.assignment_id::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.direct_entry_team_leader_assignments tla
        join public.teams t on t.team_id = tla.team_id and t.active and t.code <> '__system_vendor__'
        where tla.leader_app_user_id = v_app_user_id
          and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
        union all
        select
          6 as sort_order,
          'DEPARTMENT_HEAD'::text as role_code,
          'Trưởng phòng ban'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_DEPARTMENT'::text as scope_kind,
          dh.department_id::text as scope_id,
          dh.head_assignment_id::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.organization_account_person_links apl
        join public.organization_department_heads dh
          on dh.person_id = apl.person_id
         and dh.ended_at is null
         and dh.started_at <= v_now
        join public.organization_departments dm
          on dm.department_id = dh.department_id
         and dm.is_active
        join public.organization_person_department_memberships pm
          on pm.person_id = apl.person_id
         and pm.department_id = dh.department_id
         and pm.ended_at is null
         and pm.started_at <= v_now
        where apl.app_user_id = v_app_user_id
          and apl.ended_at is null
          and apl.started_at <= v_now
          and coalesce(v_has_active_person, false)
          and not v_is_non_employee
        union all
        select
          7 as sort_order,
          'PROJECT_MANAGER'::text as role_code,
          'Quản lý dự án (PM)'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_PROJECT'::text as scope_kind,
          pma.project_id as scope_id,
          pma.assignment_id::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.direct_entry_project_manager_assignments pma
        join public.direct_entry_projects pr on pr.project_id = pma.project_id and pr.active
        join public.recruiters r on r.recruiter_id = pma.manager_recruiter_id and r.active
        join public.direct_entry_app_user_recruiter_links rl
          on rl.recruiter_id = pma.manager_recruiter_id
         and rl.app_user_id = v_app_user_id
         and rl.verified = true
         and rl.is_current = true
         and not rl.suspended_by_account_disable
         and (rl.valid_to is null or v_today < rl.valid_to)
        where pma.is_current = true
          and pma.revoked_at is null
          and (pma.valid_to is null or (pma.valid_to > pma.valid_from and v_today < pma.valid_to))
          and pma.valid_from <= v_today
          and rl.valid_from <= v_today
          and (rl.valid_to > rl.valid_from or rl.valid_to is null)
          and public.direct_entry_actor_is_assigned_project_manager(v_app_user_id, pr.project_id)
        union all
        select
          8 as sort_order,
          'PROJECT_ACCOUNTANT'::text as role_code,
          'Kế toán dự án'::text as display_name,
          'CONTEXTUAL'::text as assignment_mode,
          'CONTEXT_PROJECT'::text as scope_kind,
          pa.project_id as scope_id,
          pa.assignment_id::text as assignment_id,
          false as is_protected,
          false as can_revoke,
          null::text as cannot_revoke_reason
        from public.vendor_finance_project_accountants pa
        join public.direct_entry_projects pr on pr.project_id = pa.project_id and pr.active
        where pa.accountant_user_id = v_app_user_id
          and pa.ended_at is null
          and pa.valid_from <= v_today
          and (pa.valid_to is null or (pa.valid_to > pa.valid_from and v_today < pa.valid_to))
      ) ar;
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
      'allowed_worker_tabs', v_allowed_worker_tabs,
      'effective_grants', coalesce(v_effective_grants, '[]'::jsonb),
      'assigned_roles', coalesce(v_assigned_roles, '[]'::jsonb)
    ) || case
      when jsonb_array_length(v_review_scopes) > 0 then jsonb_build_object('effective_report_review_scopes', v_review_scopes)
      else '{}'::jsonb
    end
    from public.direct_entry_app_users u where u.app_user_id = v_app_user_id
  );
end;
$function$
;

-- direct_entry_resolve_submission_read_scope(uuid,uuid,uuid)
CREATE OR REPLACE FUNCTION public.direct_entry_resolve_submission_read_scope(p_auth_subject uuid, p_app_user_id uuid, p_entry_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
$function$
;

-- direct_entry_worker_directory_audience(uuid,uuid,text,text)
CREATE OR REPLACE FUNCTION public.direct_entry_worker_directory_audience(p_auth_subject uuid, p_app_user_id uuid, p_scope text, p_project_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_authz_managed boolean := false;
  v_link_count integer := 0;
  v_recruiter_id uuid;
  v_project_ids jsonb;
  v_team_id uuid;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  if p_scope is null or p_scope not in ('recruited', 'managed', 'team', 'all') then
    raise exception 'invalid worker directory scope' using errcode = '22023';
  end if;
  if p_project_id is not null and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'invalid project filter' using errcode = '22023';
  end if;

  if p_scope = 'team' then
    v_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
    return pg_catalog.jsonb_build_object('scope', 'team', 'team_id', v_team_id,
      'recruiter_ids', '[]'::jsonb, 'project_ids', '[]'::jsonb,
      'view_pii', true, 'view_payment', true);
  end if;

  if p_scope = 'recruited' then
    select count(*)::integer into v_link_count
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_app_user_id and l.verified and l.is_current;
    if v_link_count <> 1 then
      raise exception 'worker directory recruiter link unavailable or ambiguous' using errcode = '42501';
    end if;
    select l.recruiter_id into v_recruiter_id
      from public.direct_entry_app_user_recruiter_links l
      join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
      join public.direct_entry_app_users u
        on u.app_user_id = l.app_user_id
       and u.enabled
     where l.app_user_id = p_app_user_id
       and l.verified
       and l.is_current
       and not l.suspended_by_account_disable
       and (
         not coalesce(u.authz_managed, false)
         or (
           l.valid_from <= v_today
           and (l.valid_to is null or (l.valid_to > l.valid_from and v_today < l.valid_to))
         )
       );
    if v_recruiter_id is null then
      raise exception 'worker directory recruiter unavailable' using errcode = '42501';
    end if;
    return pg_catalog.jsonb_build_object('scope', 'recruited', 'recruiter_ids', pg_catalog.jsonb_build_array(v_recruiter_id),
      'project_ids', '[]'::jsonb, 'view_pii', true, 'view_payment', true);
  end if;

  if p_scope = 'managed' then
    if not public.direct_entry_actor_has_project_assignment(p_app_user_id) then
      raise exception 'worker directory project assignment required' using errcode = '42501';
    end if;
    select coalesce(pg_catalog.jsonb_agg(distinct a.project_id), '[]'::jsonb) into v_project_ids
      from public.direct_entry_project_manager_assignments a
      join public.direct_entry_app_user_recruiter_links l
        on l.recruiter_id = a.manager_recruiter_id
       and l.app_user_id = p_app_user_id
       and l.verified
       and l.is_current
       and not l.suspended_by_account_disable
     where a.is_current
       and a.revoked_at is null
       and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, a.project_id);
    if pg_catalog.jsonb_array_length(v_project_ids) = 0 then
      raise exception 'worker directory project assignment required' using errcode = '42501';
    end if;
    if p_project_id is not null and not (v_project_ids ? p_project_id) then
      raise exception 'worker directory project is out of scope' using errcode = '42501';
    end if;
    return pg_catalog.jsonb_build_object('scope', 'managed', 'recruiter_ids', '[]'::jsonb,
      'project_ids', v_project_ids, 'view_pii', true, 'view_payment', true);
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if v_authz_managed then
    if not (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'change_review', 'ALL', null)
    ) then
      raise exception 'worker directory requires all scope' using errcode = '42501';
    end if;
  elsif not public.direct_entry_has_scope(p_app_user_id, 'all')
        or not (
          public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
          or public.direct_entry_has_capability(p_app_user_id, 'change_review')
        ) then
    raise exception 'worker directory requires all scope' using errcode = '42501';
  end if;

  return pg_catalog.jsonb_build_object('scope', 'all', 'recruiter_ids', '[]'::jsonb,
    'project_ids', '[]'::jsonb, 'view_pii', true, 'view_payment', true);
end;
$function$
;

-- leave_management__internal_can_actor_decide_request(uuid,leave_requests,date)
CREATE OR REPLACE FUNCTION public.leave_management__internal_can_actor_decide_request(p_actor_app_user_id uuid, p_request leave_requests, p_as_of date DEFAULT leave_management__internal_business_date())
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_as_of date := coalesce(p_as_of, public.leave_management__internal_business_date());
  v_user public.direct_entry_app_users%rowtype;
  v_auth jsonb;
  v_is_admin_or_bod boolean := false;
  v_is_live_route_approver boolean := false;
  v_dept_id uuid := p_request.routed_department_id;
  v_has_open_org_head boolean := false;
begin
  if p_actor_app_user_id is null or p_request.request_id is null then
    return false;
  end if;

  if p_actor_app_user_id = p_request.app_user_id then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id;

  if not found or not v_user.enabled then
    return false;
  end if;

  v_auth := public.leave_management__internal_resolve_authority(v_user.auth_subject, p_actor_app_user_id);
  v_is_admin_or_bod := (
    coalesce((v_auth->>'is_full_admin')::boolean, false)
    or coalesce((v_auth->>'is_bod')::boolean, false)
  );

  if v_is_admin_or_bod then
    return true;
  end if;

  -- Pending (and non-APPROVED terminal states so concurrent OCC / invalid-transition errors
  -- take precedence over 403) honor ONLY the frozen snapshot primary_approver_app_user_id
  -- (or Admin/BoD): zero silent bulk re-routing to replacement TL/HEAD or another dept's HEAD.
  if coalesce(p_request.status, 'PENDING') <> 'APPROVED' then
    return (
      p_request.primary_approver_app_user_id is not null
      and p_request.primary_approver_app_user_id = p_actor_app_user_id
    );
  end if;

  -- Cancelling an already-APPROVED leave request by a non-Admin/BoD requires BOTH being the
  -- snapshotted primary approver AND still holding active authority on that snapshotted route.
  if p_request.status = 'APPROVED'
     and p_request.primary_approver_app_user_id is not null
     and p_request.primary_approver_app_user_id = p_actor_app_user_id then
    if p_request.route_kind = 'TEAM_LEADER' and p_request.routed_team_id is not null then
      select exists (
               select 1
                 from public.direct_entry_team_leader_assignments tla
                where tla.team_id = p_request.routed_team_id
                  and tla.leader_app_user_id = p_actor_app_user_id
                  and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_as_of)
             )
        into v_is_live_route_approver;
      return v_is_live_route_approver;
    end if;

    if p_request.route_kind = 'DEPARTMENT_HEAD' then
      if v_dept_id is null and p_request.unit_kind_snapshot in ('MARKETING', 'IT', 'ACCOUNTING') then
        select d.department_id
          into v_dept_id
          from public.organization_departments d
         where d.system_key = p_request.unit_kind_snapshot
           and d.is_active = true
         limit 1;
      end if;

      if v_dept_id is not null then
        v_has_open_org_head := public.leave_management__internal_has_open_department_head(v_dept_id, v_now);
        if public.leave_management__internal_resolve_department_head_user(v_dept_id, v_now) = p_actor_app_user_id then
          return true;
        end if;
      end if;

      if not v_has_open_org_head and p_request.unit_kind_snapshot in ('MARKETING', 'IT', 'ACCOUNTING') then
        select exists (
                 select 1
                   from public.leave_department_approvers da
                  where da.unit_kind = p_request.unit_kind_snapshot
                    and da.approver_app_user_id = p_actor_app_user_id
                    and da.valid_from <= v_as_of
                    and (da.valid_to is null or v_as_of < da.valid_to)
                    and (da.valid_to is null or da.valid_to > da.valid_from)
               )
          into v_is_live_route_approver;
        return v_is_live_route_approver;
      end if;
    end if;
  end if;

  return false;
end;
$function$
;

-- leave_management__internal_compute_balance_summary(uuid,integer,date)
CREATE OR REPLACE FUNCTION public.leave_management__internal_compute_balance_summary(p_app_user_id uuid, p_leave_year integer, p_as_of date DEFAULT leave_management__internal_business_date())
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_org record;
  v_effective_unit_kind text := 'UNCLASSIFIED';
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean := false;
  v_profile_configured boolean := false;
  v_total_granted integer := 0;
  v_carry_over_granted integer := 0;
  v_monthly_accrued integer := 0;
  v_seniority_granted integer := 0;
  v_opening_current_year integer := 0;
  v_reserved integer := 0;
  v_consumed integer := 0;
  v_expired integer := 0;
  v_available integer := 0;
  v_carry_over_available integer := 0;
  v_pending_annual integer := 0;
  v_pending_non_annual integer := 0;
  v_pending_unpaid integer := 0;
  v_approved_annual integer := 0;
  v_approved_non_annual integer := 0;
  v_approved_bereavement integer := 0;
  v_approved_marriage integer := 0;
  v_approved_sick integer := 0;
  v_approved_unpaid integer := 0;
  v_lots jsonb := '[]'::jsonb;
begin
  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_app_user_id;

  if found then
    v_has_profile := true;
    v_profile_configured := (
      v_profile.employment_status in ('PROBATION', 'OFFICIAL')
      and v_profile.work_start_date is not null
      and (
        v_profile.employment_status <> 'OFFICIAL'
        or v_profile.official_effective_date is not null
      )
    );
  end if;

  select *
    into v_org
    from public.leave_management__internal_resolve_person_department(p_app_user_id, v_now);

  if coalesce(v_org.has_active_person_link, false) then
    v_effective_unit_kind := coalesce(v_org.department_system_key, 'UNCLASSIFIED');
  else
    v_effective_unit_kind := case when v_has_profile then v_profile.unit_kind else 'UNCLASSIFIED' end;
  end if;

  select coalesce(sum(l.granted_units), 0)::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind = 'CARRY_OVER'), 0)::integer,
         coalesce(
           sum(coalesce((l.metadata->>'initial_granted_units')::integer, l.granted_units))
             filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')),
           0
         )::integer,
         coalesce(sum(l.granted_units) filter (where l.lot_kind = 'SENIORITY_GRANT'), 0)::integer,
         (
           coalesce(
             sum(l.granted_units)
               filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP', 'OPENING_CURRENT_YEAR', 'MANUAL_ADJUSTMENT')),
             0
           )::integer
           - coalesce(
               sum(coalesce((l.metadata->>'initial_granted_units')::integer, l.granted_units))
                 filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')),
               0
             )::integer
         ),
         coalesce(sum(l.reserved_units), 0)::integer,
         coalesce(sum(l.consumed_units), 0)::integer,
         coalesce(sum(l.expired_units), 0)::integer,
         coalesce(
           sum(l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
             filter (
               where l.usable_from_date <= p_as_of
                 and (l.expires_after_date is null or p_as_of <= l.expires_after_date)
             ),
           0
         )::integer,
         coalesce(
           sum(l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
             filter (
               where l.lot_kind = 'CARRY_OVER'
                 and l.usable_from_date <= p_as_of
                 and (l.expires_after_date is null or p_as_of <= l.expires_after_date)
             ),
           0
         )::integer,
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'lot_id', l.lot_id,
               'leave_year', l.leave_year,
               'lot_kind', l.lot_kind,
               'accrual_month', l.accrual_month,
               'granted_units', l.granted_units,
               'reserved_units', l.reserved_units,
               'consumed_units', l.consumed_units,
               'expired_units', l.expired_units,
               'available_units', (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units),
               'usable_from_date', l.usable_from_date,
               'expires_after_date', l.expires_after_date,
               'source_ref', l.source_ref
             )
             order by l.expires_after_date asc nulls last, l.usable_from_date asc, l.created_at asc, l.lot_id asc
           ),
           '[]'::jsonb
         )
    into v_total_granted,
         v_carry_over_granted,
         v_monthly_accrued,
         v_seniority_granted,
         v_opening_current_year,
         v_reserved,
         v_consumed,
         v_expired,
         v_available,
         v_carry_over_available,
         v_lots
    from public.leave_lots l
   where l.app_user_id = p_app_user_id
     and l.leave_year = p_leave_year;

  select coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'PENDING' and d.leave_type = 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'PENDING' and d.leave_type <> 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'PENDING' and d.leave_type = 'UNPAID'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type <> 'ANNUAL'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'BEREAVEMENT'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'MARRIAGE'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'SICK'),
           0
         )::integer,
         coalesce(
           sum(d.half_day_units)
             filter (where r.status = 'APPROVED' and d.leave_type = 'UNPAID'),
           0
         )::integer
    into v_pending_annual,
         v_pending_non_annual,
         v_pending_unpaid,
         v_approved_annual,
         v_approved_non_annual,
         v_approved_bereavement,
         v_approved_marriage,
         v_approved_sick,
         v_approved_unpaid
    from public.leave_requests r
    join public.leave_request_days d on d.request_id = r.request_id
   where r.app_user_id = p_app_user_id
     and pg_catalog.date_part('year', d.leave_date)::integer = p_leave_year;

  return pg_catalog.jsonb_build_object(
    'leave_year', p_leave_year,
    'as_of_date', p_as_of,
    'has_profile', v_has_profile,
    'profile_configured', v_profile_configured,
    'employment_status', case when v_has_profile then v_profile.employment_status else 'UNCONFIGURED' end,
    'unit_kind', v_effective_unit_kind,
    'work_start_date', case when v_has_profile then v_profile.work_start_date else null end,
    'official_effective_date', case when v_has_profile then v_profile.official_effective_date else null end,
    'next_seniority_effective_date', case when v_has_profile then v_profile.next_seniority_effective_date else null end,
    'next_seniority_units', case when v_has_profile then v_profile.next_seniority_units else 0 end,
    'total_granted_units', v_total_granted,
    'carry_over_granted_units', v_carry_over_granted,
    'carry_over_available_units', v_carry_over_available,
    'monthly_accrued_units', v_monthly_accrued,
    'seniority_granted_units', v_seniority_granted,
    'opening_or_adjustment_units', v_opening_current_year,
    'available_units', v_available,
    'reserved_units', v_reserved,
    'consumed_units', v_consumed,
    'expired_units', v_expired,
    'pending_annual_units', v_pending_annual,
    'pending_non_annual_units', v_pending_non_annual,
    'pending_unpaid_units', v_pending_unpaid,
    'approved_annual_units', v_approved_annual,
    'approved_non_annual_units', v_approved_non_annual,
    'approved_bereavement_units', v_approved_bereavement,
    'approved_marriage_units', v_approved_marriage,
    'approved_sick_units', v_approved_sick,
    'approved_unpaid_units', v_approved_unpaid,
    'lots', v_lots
  );
end;
$function$
;

-- leave_management__internal_resolve_authority(uuid,uuid)
CREATE OR REPLACE FUNCTION public.leave_management__internal_resolve_authority(p_auth_subject uuid, p_app_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.leave_management__internal_business_date();
  v_is_shared boolean := false;
  v_is_full_admin boolean := false;
  v_is_bod boolean := false;
  v_is_admin_bod_grant boolean := false;
  v_is_hr_operator boolean := false;
  v_is_hr_report_viewer boolean := false;
  v_is_team_leader boolean := false;
  v_is_dept_head boolean := false;
  v_is_compat_dept_approver boolean := false;
  v_is_dept_approver boolean := false;
  v_has_pending_snapshot_approval boolean := false;
begin
  if p_auth_subject is null or p_app_user_id is null then
    raise exception 'Direct entry actor mapping is not active'
      using errcode = '42501';
  end if;

  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  v_is_shared := public.attendance__internal_is_non_employee_account(p_app_user_id, v_now);

  if not v_is_shared then
    v_is_full_admin := (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null)
    );

    v_is_bod := (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
      or (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_analytics_view', 'ALL', null)
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_view', 'ALL', null)
      )
    );

    -- D4 cutover: Leave module roles resolve EXCLUSIVELY from active permission groups
    -- (historical leave_module_grants rows stay preserved for audit, never read as runtime fallback).
    select public.direct_entry_authz__internal_group_has_module_role(
             p_app_user_id, 'leave', 'LEAVE_ADMIN_BOD_APPROVER'
           ),
           public.direct_entry_authz__internal_group_has_module_role(
             p_app_user_id, 'leave', 'HR_LEAVE_OPERATOR'
           ),
           public.direct_entry_authz__internal_group_has_module_role(
             p_app_user_id, 'leave', 'HR_REPORT_VIEWER'
           )
      into v_is_admin_bod_grant, v_is_hr_operator, v_is_hr_report_viewer;

    select exists (
             select 1
               from public.direct_entry_team_leader_assignments tla
              where tla.leader_app_user_id = p_app_user_id
                and public.direct_entry__internal_team_leader_assignment_effective(tla.assignment_id, v_today)
           )
      into v_is_team_leader;

    select exists (
             select 1
               from public.organization_department_heads dh
               join public.organization_departments d
                 on d.department_id = dh.department_id
                and d.is_active = true
              where dh.started_at <= v_now
                and (dh.ended_at is null or (dh.ended_at > dh.started_at and v_now < dh.ended_at))
                and public.leave_management__internal_resolve_department_head_user(dh.department_id, v_now) = p_app_user_id
           )
      into v_is_dept_head;

    select exists (
             select 1
               from public.leave_department_approvers da
              where da.approver_app_user_id = p_app_user_id
                and da.valid_from <= v_today
                and (da.valid_to is null or v_today < da.valid_to)
                and (da.valid_to is null or da.valid_to > da.valid_from)
                and not exists (
                  select 1
                    from public.organization_departments d
                   where d.system_key = da.unit_kind
                     and d.is_active = true
                     and public.leave_management__internal_has_open_department_head(d.department_id, v_now)
                )
           )
      into v_is_compat_dept_approver;

    v_is_dept_approver := (v_is_dept_head or v_is_compat_dept_approver);

    select (
             exists (
               select 1
                 from public.leave_requests lr
                where lr.status = 'PENDING'
                  and lr.primary_approver_app_user_id = p_app_user_id
                  and lr.app_user_id <> p_app_user_id
             )
             or exists (
               select 1
                 from public.attendance_explanations ae
                where ae.status = 'PENDING'
                  and ae.primary_approver_app_user_id = p_app_user_id
                  and ae.app_user_id <> p_app_user_id
             )
           )
      into v_has_pending_snapshot_approval;
  end if;

  return pg_catalog.jsonb_build_object(
    'app_user_id', p_app_user_id,
    'is_full_admin', v_is_full_admin,
    'is_bod', (v_is_bod or v_is_admin_bod_grant),
    'is_hr_operator', v_is_hr_operator,
    'is_hr_report_viewer', v_is_hr_report_viewer,
    'is_team_leader', v_is_team_leader,
    'is_department_approver', v_is_dept_approver,
    'can_submit_request', (not v_is_shared),
    'can_approve_requests', (
      not v_is_shared
      and (
        v_is_full_admin
        or v_is_bod
        or v_is_admin_bod_grant
        or v_is_team_leader
        or v_is_dept_approver
        or v_has_pending_snapshot_approval
      )
    ),
    'can_view_monthly_report', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_hr_operator or v_is_hr_report_viewer)),
    'can_manage_config', (not v_is_shared and (v_is_full_admin or v_is_bod or v_is_hr_operator))
  );
end;
$function$
;

-- leave_management__internal_resolve_department_head_user(uuid,timestamp with time zone)
CREATE OR REPLACE FUNCTION public.leave_management__internal_resolve_department_head_user(p_department_id uuid, p_as_of_ts timestamp with time zone DEFAULT clock_timestamp())
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_as_of timestamptz := coalesce(p_as_of_ts, pg_catalog.clock_timestamp());
  v_head_app_user_id uuid;
begin
  if p_department_id is null then
    return null;
  end if;

  select u.app_user_id
    into v_head_app_user_id
    from public.organization_department_heads dh
    join public.organization_departments d
      on d.department_id = dh.department_id
     and d.is_active = true
    join public.organization_persons op
      on op.person_id = dh.person_id
     and op.status = 'ACTIVE'
    join public.organization_person_department_memberships m
      on m.person_id = dh.person_id
     and m.department_id = dh.department_id
     and m.started_at <= v_as_of
     and (m.ended_at is null or (m.ended_at > m.started_at and v_as_of < m.ended_at))
    join public.organization_account_person_links l
      on l.person_id = dh.person_id
     and l.started_at <= v_as_of
     and (l.ended_at is null or (l.ended_at > l.started_at and v_as_of < l.ended_at))
    join public.direct_entry_app_users u
      on u.app_user_id = l.app_user_id
     and u.enabled = true
   where dh.department_id = p_department_id
     and dh.started_at <= v_as_of
     and (dh.ended_at is null or (dh.ended_at > dh.started_at and v_as_of < dh.ended_at))
   order by dh.started_at desc, dh.head_assignment_id desc
   limit 1;

  return v_head_app_user_id;
end;
$function$
;

-- leave_management__internal_resolve_person_department(uuid,timestamp with time zone)
CREATE OR REPLACE FUNCTION public.leave_management__internal_resolve_person_department(p_app_user_id uuid, p_as_of_ts timestamp with time zone DEFAULT clock_timestamp())
 RETURNS TABLE(has_active_person_link boolean, person_id uuid, employee_code text, full_name text, person_status text, department_id uuid, department_code text, department_name text, department_system_key text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_as_of timestamptz := coalesce(p_as_of_ts, pg_catalog.clock_timestamp());
begin
  if p_app_user_id is null then
    return query select false, null::uuid, null::text, null::text, null::text, null::uuid, null::text, null::text, null::text;
    return;
  end if;

  return query
  with active_link as (
    select l.person_id,
           op.employee_code,
           op.full_name,
           op.status as person_status
      from public.direct_entry_app_users u
      join public.organization_account_person_links l
        on l.app_user_id = u.app_user_id
       and l.started_at <= v_as_of
       and (l.ended_at is null or (l.ended_at > l.started_at and v_as_of < l.ended_at))
      join public.organization_persons op
        on op.person_id = l.person_id
     where u.app_user_id = p_app_user_id
     order by l.started_at desc, l.link_id desc
     limit 1
  ),
  active_dept as (
    select d.department_id,
           d.code as department_code,
           d.name as department_name,
           d.system_key as department_system_key
      from active_link al
      join public.organization_person_department_memberships m
        on m.person_id = al.person_id
       and m.started_at <= v_as_of
       and (m.ended_at is null or (m.ended_at > m.started_at and v_as_of < m.ended_at))
      join public.organization_departments d
        on d.department_id = m.department_id
       and d.is_active = true
     where al.person_status = 'ACTIVE'
     order by m.started_at desc, m.membership_id desc
     limit 1
  )
  select (al.person_id is not null) as has_active_person_link,
         al.person_id,
         al.employee_code,
         al.full_name,
         al.person_status,
         ad.department_id,
         ad.department_code,
         ad.department_name,
         ad.department_system_key
    from (select 1 as anchor) a
    left join active_link al on true
    left join active_dept ad on true;
end;
$function$
;

-- leave_management__internal_resolve_routing_snapshot(uuid,date)
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

  if v_snap.is_requester_team_leader
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
$function$
;

-- leave_management__internal_sync_employee_accruals(uuid,date)
CREATE OR REPLACE FUNCTION public.leave_management__internal_sync_employee_accruals(p_app_user_id uuid, p_as_of date DEFAULT leave_management__internal_business_date())
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_profile public.leave_employee_profiles%rowtype;
  v_policy public.leave_policy_configs%rowtype;
  v_alloc record;
  v_lot record;
  v_lot_avail integer;
  v_year integer := pg_catalog.date_part('year', p_as_of)::integer;
  v_current_month integer := pg_catalog.date_part('month', p_as_of)::integer;
  v_start_year integer;
  v_start_month integer;
  v_official_date date;
  v_m integer;
  v_month_first date;
  v_usable_from date;
  v_lot_kind text;
  v_entry_type text;
  v_new_lot_id uuid;
  v_sen_units integer := 0;
  v_sen_date date := null;
  v_existing_sen_units integer := 0;
  v_diff_sen integer := 0;
  v_full_years integer := 0;
  v_anniv_date date;
begin
  if p_app_user_id is null then
    return;
  end if;

  perform public.leave_management__internal_lock_employee(p_app_user_id);

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  -- Step 1: Settle due RESERVED allocations where leave_date <= p_as_of into CONSUMED
  for v_alloc in
    select a.allocation_id,
           a.request_id,
           a.request_day_id,
           a.lot_id,
           a.leave_date,
           a.allocated_units
      from public.leave_request_lot_allocations a
      join public.leave_requests r on r.request_id = a.request_id
     where r.app_user_id = p_app_user_id
       and r.status = 'APPROVED'
       and a.status = 'RESERVED'
       and a.leave_date <= p_as_of
     order by a.leave_date asc, a.allocation_id asc
     for update of a
  loop
    update public.leave_request_lot_allocations
       set status = 'CONSUMED',
           settled_at = pg_catalog.timezone('utc', pg_catalog.now())
     where allocation_id = v_alloc.allocation_id;

    update public.leave_lots
       set reserved_units = reserved_units - v_alloc.allocated_units,
           consumed_units = consumed_units + v_alloc.allocated_units,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where lot_id = v_alloc.lot_id;

    insert into public.leave_ledger_entries (
      app_user_id,
      lot_id,
      request_id,
      request_day_id,
      entry_type,
      effective_date,
      delta_available_units,
      delta_reserved_units,
      delta_consumed_units,
      delta_expired_units,
      actor_app_user_id,
      reason,
      metadata
    )
    values (
      p_app_user_id,
      v_alloc.lot_id,
      v_alloc.request_id,
      v_alloc.request_day_id,
      'SETTLE_RESERVE_TO_CONSUME',
      v_alloc.leave_date,
      0,
      -v_alloc.allocated_units,
      v_alloc.allocated_units,
      0,
      null,
      'Chốt phép giữ chỗ khi đến ngày nghỉ thực tế',
      pg_catalog.jsonb_build_object(
        'allocation_id', v_alloc.allocation_id,
        'leave_date', v_alloc.leave_date,
        'settled_as_of', p_as_of
      )
    );
  end loop;

  -- Step 2: Expire remaining available units on lots where expires_after_date < p_as_of
  for v_lot in
    select l.*
      from public.leave_lots l
     where l.app_user_id = p_app_user_id
       and l.expires_after_date is not null
       and l.expires_after_date < p_as_of
     order by l.expires_after_date asc, l.lot_id asc
     for update of l
  loop
    v_lot_avail := v_lot.granted_units - v_lot.reserved_units - v_lot.consumed_units - v_lot.expired_units;
    if v_lot_avail > 0 then
      update public.leave_lots
         set expired_units = expired_units + v_lot_avail,
             updated_at = pg_catalog.timezone('utc', pg_catalog.now())
       where lot_id = v_lot.lot_id;

      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        entry_type,
        effective_date,
        delta_available_units,
        delta_reserved_units,
        delta_consumed_units,
        delta_expired_units,
        actor_app_user_id,
        reason,
        metadata
      )
      values (
        p_app_user_id,
        v_lot.lot_id,
        'EXPIRE_CARRY_OVER',
        (v_lot.expires_after_date + 1),
        -v_lot_avail,
        0,
        0,
        v_lot_avail,
        null,
        'Hết hạn phép chuyển năm sau ngày ' || v_lot.expires_after_date::text,
        pg_catalog.jsonb_build_object(
          'expires_after_date', v_lot.expires_after_date,
          'expired_as_of', p_as_of
        )
      );
    end if;
  end loop;

  -- Step 3: Accrue monthly & probation catch-up & seniority lots for OFFICIAL configured profile
  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_app_user_id
   for update;

  if not found then
    return;
  end if;

  if v_profile.employment_status <> 'OFFICIAL'
     or v_profile.work_start_date is null then
    return;
  end if;

  v_official_date := coalesce(v_profile.official_effective_date, v_profile.work_start_date);
  if p_as_of < v_official_date then
    return;
  end if;

  v_start_year := pg_catalog.date_part('year', v_profile.work_start_date)::integer;
  if v_start_year > v_year then
    return;
  end if;

  if v_start_year = v_year then
    v_start_month := pg_catalog.date_part('month', v_profile.work_start_date)::integer;
  else
    v_start_month := 1;
  end if;

  for v_m in v_start_month..v_current_month loop
    v_month_first := pg_catalog.make_date(v_year, v_m, 1);
    v_usable_from := greatest(v_month_first, v_profile.work_start_date, v_official_date);

    if v_official_date > v_profile.work_start_date
       and (
         pg_catalog.date_part('year', v_official_date)::integer > v_year
         or (
           pg_catalog.date_part('year', v_official_date)::integer = v_year
           and v_m < pg_catalog.date_part('month', v_official_date)::integer
         )
       ) then
      v_lot_kind := 'PROBATION_CATCHUP';
      v_entry_type := 'GRANT_PROBATION_CATCHUP';
    else
      v_lot_kind := 'MONTHLY_ACCRUAL';
      v_entry_type := 'GRANT_MONTHLY_ACCRUAL';
    end if;

    v_new_lot_id := null;

    insert into public.leave_lots (
      app_user_id,
      leave_year,
      lot_kind,
      accrual_month,
      granted_units,
      usable_from_date,
      expires_after_date,
      source_ref,
      created_by_app_user_id
    )
    values (
      p_app_user_id,
      v_year,
      v_lot_kind,
      v_m,
      coalesce(v_policy.monthly_accrual_units, 2),
      v_usable_from,
      pg_catalog.make_date(v_year, 12, 31),
      pg_catalog.format('AUTO_MONTH:%s:%s', v_year, lpad(v_m::text, 2, '0')),
      null
    )
    on conflict (app_user_id, leave_year, accrual_month)
      where lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')
      do nothing
    returning lot_id into v_new_lot_id;

    if v_new_lot_id is not null then
      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        entry_type,
        effective_date,
        delta_available_units,
        delta_reserved_units,
        delta_consumed_units,
        delta_expired_units,
        actor_app_user_id,
        reason,
        metadata
      )
      values (
        p_app_user_id,
        v_new_lot_id,
        v_entry_type,
        v_usable_from,
        coalesce(v_policy.monthly_accrual_units, 2),
        0,
        0,
        0,
        null,
        case
          when v_lot_kind = 'PROBATION_CATCHUP' then
            pg_catalog.format('Tính bù phép tháng %s/%s khi lên chính thức', lpad(v_m::text, 2, '0'), v_year)
          else
            pg_catalog.format('Cộng phép định kỳ tháng %s/%s', lpad(v_m::text, 2, '0'), v_year)
        end,
        pg_catalog.jsonb_build_object(
          'leave_year', v_year,
          'accrual_month', v_m,
          'usable_from_date', v_usable_from,
          'lot_kind', v_lot_kind
        )
      );
    end if;
  end loop;

  -- Step 4: Seniority grant (configured next_seniority_effective_date/units applied strictly once in its effective year, or default 5-year milestone in its anniversary year)
  if v_profile.next_seniority_effective_date is not null and v_profile.next_seniority_units > 0 then
    if pg_catalog.date_part('year', v_profile.next_seniority_effective_date)::integer = v_year
       and p_as_of >= v_profile.next_seniority_effective_date then
      v_sen_units := v_profile.next_seniority_units;
      v_sen_date := greatest(
        pg_catalog.make_date(v_year, 1, 1),
        v_profile.next_seniority_effective_date,
        v_official_date
      );
    end if;
  else
    v_full_years := pg_catalog.date_part('year', pg_catalog.age(p_as_of, v_profile.work_start_date))::integer;
    if v_full_years >= 5 and (v_full_years % 5) = 0 then
      v_anniv_date := (v_profile.work_start_date + pg_catalog.make_interval(years => v_full_years))::date;
      if pg_catalog.date_part('year', v_anniv_date)::integer = v_year
         and p_as_of >= v_anniv_date then
        v_sen_units := (v_full_years / 5) * coalesce(v_policy.default_seniority_step_units, 2);
        v_sen_date := greatest(
          pg_catalog.make_date(v_year, 1, 1),
          v_anniv_date,
          v_official_date
        );
      end if;
    end if;
  end if;

  if v_sen_units > 0 and v_sen_date is not null and p_as_of >= v_sen_date then
    select coalesce(sum(l.granted_units), 0)::integer
      into v_existing_sen_units
      from public.leave_lots l
     where l.app_user_id = p_app_user_id
       and l.leave_year = v_year
       and l.lot_kind = 'SENIORITY_GRANT';

    v_diff_sen := v_sen_units - v_existing_sen_units;
    if v_diff_sen > 0 then
      insert into public.leave_lots (
        app_user_id,
        leave_year,
        lot_kind,
        accrual_month,
        granted_units,
        usable_from_date,
        expires_after_date,
        source_ref,
        created_by_app_user_id
      )
      values (
        p_app_user_id,
        v_year,
        'SENIORITY_GRANT',
        null,
        v_diff_sen,
        v_sen_date,
        pg_catalog.make_date(v_year, 12, 31),
        pg_catalog.format('AUTO_SENIORITY:%s:%s', v_year, v_sen_units),
        null
      )
      returning lot_id into v_new_lot_id;

      insert into public.leave_ledger_entries (
        app_user_id,
        lot_id,
        entry_type,
        effective_date,
        delta_available_units,
        delta_reserved_units,
        delta_consumed_units,
        delta_expired_units,
        actor_app_user_id,
        reason,
        metadata
      )
      values (
        p_app_user_id,
        v_new_lot_id,
        'GRANT_SENIORITY',
        v_sen_date,
        v_diff_sen,
        0,
        0,
        0,
        null,
        pg_catalog.format('Cộng phép thâm niên năm %s', v_year),
        pg_catalog.jsonb_build_object(
          'leave_year', v_year,
          'usable_from_date', v_sen_date,
          'target_seniority_units', v_sen_units,
          'granted_delta_units', v_diff_sen
        )
      );
    end if;
  end if;
end;
$function$
;

-- leave_management_create_request(uuid,uuid,jsonb,text,text,text)
CREATE OR REPLACE FUNCTION public.leave_management_create_request(p_actor_auth_subject uuid, p_actor_app_user_id uuid, p_days jsonb, p_reason text, p_idempotency_key text, p_request_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_reason text := null;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_lock_person_id uuid := null;
  v_lock_dept_id uuid := null;
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean := false;
  v_profile_configured boolean := false;
  v_emp_status_snapshot text;
  v_unit_kind_snapshot text;
  v_routing_snap record;
  v_routing jsonb;
  v_raw_days jsonb;
  v_raw_allocs jsonb := null;
  v_day_item jsonb;
  v_day_date_text text;
  v_day_date date;
  v_session_code text;
  v_explicit_leave_type text;
  v_item_units integer;
  v_half_day_units integer;
  v_total_units integer := 0;
  v_seq integer := 0;
  v_alloc_item jsonb;
  v_alloc_seq integer := 0;
  v_alloc_type text;
  v_alloc_units integer;
  v_alloc_days numeric;
  v_alloc_total_units integer := 0;
  v_has_explicit_day_types boolean := false;
  v_all_days_have_explicit_types boolean := true;
  v_mismatch_count integer := 0;
  v_annual_units integer := 0;
  v_sim_lot record;
  v_sim_needed integer;
  v_request_row public.leave_requests%rowtype;
  v_projected_request jsonb;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;

  perform public.leave_management__internal_lock_employee(p_actor_app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'CREATE_REQUEST'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  -- Acquire org locks in canonical WP3B §4.2 order (person -> department -> app_user)
  -- BEFORE sync_employee_accruals locks leave_employee_profiles FOR UPDATE, preventing
  -- FK FOR KEY SHARE vs FOR UPDATE 40P01 deadlocks against org_department_transfer_person_member_admin.
  select l.person_id
    into v_lock_person_id
    from public.organization_account_person_links l
   where l.app_user_id = p_actor_app_user_id
     and l.ended_at is null
   order by l.started_at desc, l.link_id desc
   limit 1;

  if v_lock_person_id is not null then
    perform public.org_department__internal_lock_person(v_lock_person_id);
    select m.department_id
      into v_lock_dept_id
      from public.organization_account_person_links l
      join public.organization_person_department_memberships m
        on m.person_id = l.person_id
       and m.ended_at is null
     where l.app_user_id = p_actor_app_user_id
       and l.person_id = v_lock_person_id
       and l.ended_at is null
     order by m.started_at desc, m.membership_id desc
     limit 1;
  else
    select d.department_id
      into v_lock_dept_id
      from public.leave_employee_profiles lp
      join public.organization_departments d
        on d.system_key = lp.unit_kind
       and d.is_active = true
     where lp.app_user_id = p_actor_app_user_id
       and lp.unit_kind in ('MARKETING', 'IT', 'ACCOUNTING')
     order by d.department_id asc
     limit 1;
  end if;

  if v_lock_dept_id is not null then
    perform public.org_department__internal_lock_department(v_lock_dept_id);
  end if;
  perform public.org_department__internal_lock_app_user(p_actor_app_user_id);

  perform public.leave_management__internal_sync_employee_accruals(p_actor_app_user_id, v_today);

  if p_days is null then
    raise exception 'LEAVE_REQUEST_DAYS_INVALID'
      using errcode = '22023';
  elsif pg_catalog.jsonb_typeof(p_days) = 'object' then
    v_raw_days := p_days->'days';
    v_raw_allocs := coalesce(p_days->'type_allocations', p_days->'allocations');
  elsif pg_catalog.jsonb_typeof(p_days) = 'array' then
    v_raw_days := p_days;
    v_raw_allocs := null;
  else
    raise exception 'LEAVE_REQUEST_DAYS_INVALID'
      using errcode = '22023';
  end if;

  if v_raw_days is null
     or pg_catalog.jsonb_typeof(v_raw_days) <> 'array'
     or pg_catalog.jsonb_array_length(v_raw_days) < 1
     or pg_catalog.jsonb_array_length(v_raw_days) > 120 then
    raise exception 'LEAVE_REQUEST_DAYS_INVALID'
      using errcode = '22023';
  end if;

  create temporary table if not exists pg_temp.leave_req_input_days (
    seq_no integer primary key,
    leave_date date not null,
    session_code text not null,
    half_day_units integer not null,
    explicit_leave_type text null
  ) on commit drop;

  create temporary table if not exists pg_temp.leave_req_normalized_days (
    seq_no integer primary key,
    leave_date date not null,
    session_code text not null,
    half_day_units integer not null,
    leave_type text not null
  ) on commit drop;

  truncate table pg_temp.leave_req_input_days;
  truncate table pg_temp.leave_req_normalized_days;

  for v_day_item in
    select value
      from pg_catalog.jsonb_array_elements(v_raw_days)
  loop
    if pg_catalog.jsonb_typeof(v_day_item) <> 'object' then
      raise exception 'LEAVE_REQUEST_DAYS_INVALID'
        using errcode = '22023';
    end if;

    v_seq := v_seq + 1;
    v_day_date_text := pg_catalog.btrim(coalesce(v_day_item->>'leave_date', ''));
    v_session_code := pg_catalog.upper(pg_catalog.btrim(coalesce(v_day_item->>'session_code', '')));
    v_explicit_leave_type := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(v_day_item->>'leave_type', ''))), '');

    if v_day_date_text !~ '^\d{4}-\d{2}-\d{2}$'
       or v_session_code not in ('FULL', 'AM', 'PM') then
      raise exception 'LEAVE_REQUEST_DAYS_INVALID'
        using errcode = '22023';
    end if;

    if v_explicit_leave_type is not null then
      if v_explicit_leave_type not in ('ANNUAL', 'BEREAVEMENT', 'MARRIAGE', 'SICK', 'UNPAID') then
        raise exception 'LEAVE_TYPE_INVALID'
          using errcode = '22023';
      end if;
      v_has_explicit_day_types := true;
    else
      v_all_days_have_explicit_types := false;
    end if;

    begin
      v_day_date := v_day_date_text::date;
    exception
      when others then
        raise exception 'LEAVE_REQUEST_DAYS_INVALID'
          using errcode = '22023';
    end;

    if pg_catalog.date_part('year', v_day_date)::integer <> v_year then
      raise exception 'LEAVE_REQUEST_YEAR_OUT_OF_RANGE'
        using errcode = '22023';
    end if;

    v_half_day_units := case when v_session_code = 'FULL' then 2 else 1 end;

    if v_day_item ? 'half_day_units' and pg_catalog.jsonb_typeof(v_day_item->'half_day_units') <> 'null' then
      begin
        v_item_units := (v_day_item->>'half_day_units')::integer;
      exception
        when others then
          raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
            using errcode = '22023';
      end;

      if v_item_units is distinct from v_half_day_units then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;
    end if;

    if exists (
      select 1
        from pg_temp.leave_req_input_days i
       where i.leave_date = v_day_date
         and (
           i.session_code = 'FULL'
           or v_session_code = 'FULL'
           or i.session_code = v_session_code
           or coalesce(i.explicit_leave_type, 'ANNUAL') = coalesce(v_explicit_leave_type, 'ANNUAL')
         )
    ) then
      raise exception 'LEAVE_REQUEST_DUPLICATE_DATE'
        using errcode = '22023';
    end if;

    if exists (
      select 1
        from public.leave_request_days d
       where d.app_user_id = p_actor_app_user_id
         and d.leave_date = v_day_date
         and d.is_active = true
         and (
           d.session_code = 'FULL'
           or v_session_code = 'FULL'
           or d.session_code = v_session_code
         )
    ) then
      raise exception 'LEAVE_REQUEST_OVERLAP'
        using errcode = '23505';
    end if;

    insert into pg_temp.leave_req_input_days (
      seq_no,
      leave_date,
      session_code,
      half_day_units,
      explicit_leave_type
    )
    values (
      v_seq,
      v_day_date,
      v_session_code,
      v_half_day_units,
      v_explicit_leave_type
    );

    v_total_units := v_total_units + v_half_day_units;
  end loop;

  if v_raw_allocs is not null and pg_catalog.jsonb_typeof(v_raw_allocs) <> 'null' then
    if pg_catalog.jsonb_typeof(v_raw_allocs) <> 'array'
       or pg_catalog.jsonb_array_length(v_raw_allocs) < 1
       or pg_catalog.jsonb_array_length(v_raw_allocs) > 20 then
      raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
        using errcode = '22023';
    end if;

    create temporary table if not exists pg_temp.leave_req_type_allocs (
      alloc_seq integer primary key,
      leave_type text not null,
      half_day_units integer not null
    ) on commit drop;

    truncate table pg_temp.leave_req_type_allocs;

    for v_alloc_item in
      select value
        from pg_catalog.jsonb_array_elements(v_raw_allocs)
    loop
      if pg_catalog.jsonb_typeof(v_alloc_item) <> 'object' then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      v_alloc_seq := v_alloc_seq + 1;
      v_alloc_type := pg_catalog.upper(pg_catalog.btrim(coalesce(v_alloc_item->>'leave_type', '')));

      if v_alloc_type not in ('ANNUAL', 'BEREAVEMENT', 'MARRIAGE', 'SICK', 'UNPAID') then
        raise exception 'LEAVE_TYPE_INVALID'
          using errcode = '22023';
      end if;

      v_alloc_units := null;
      if v_alloc_item ? 'half_day_units' and pg_catalog.jsonb_typeof(v_alloc_item->'half_day_units') <> 'null' then
        begin
          v_alloc_units := (v_alloc_item->>'half_day_units')::integer;
        exception
          when others then
            raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
              using errcode = '22023';
        end;
      end if;

      if v_alloc_item ? 'days' and pg_catalog.jsonb_typeof(v_alloc_item->'days') <> 'null' then
        begin
          v_alloc_days := (v_alloc_item->>'days')::numeric;
        exception
          when others then
            raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
              using errcode = '22023';
        end;

        if v_alloc_days <= 0 or pg_catalog.mod(v_alloc_days * 2, 1) <> 0 then
          raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
            using errcode = '22023';
        end if;

        if v_alloc_units is not null and v_alloc_units <> (v_alloc_days * 2)::integer then
          raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
            using errcode = '22023';
        end if;

        v_alloc_units := (v_alloc_days * 2)::integer;
      end if;

      if v_alloc_units is null or v_alloc_units < 1 then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      insert into pg_temp.leave_req_type_allocs (
        alloc_seq,
        leave_type,
        half_day_units
      )
      values (
        v_alloc_seq,
        v_alloc_type,
        v_alloc_units
      );

      v_alloc_total_units := v_alloc_total_units + v_alloc_units;
    end loop;

    if v_alloc_total_units <> v_total_units then
      raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
        using errcode = '22023';
    end if;

    if v_has_explicit_day_types then
      if not v_all_days_have_explicit_types then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      select count(*)::integer
        into v_mismatch_count
        from (
          select i.explicit_leave_type as leave_type,
                 sum(i.half_day_units)::integer as day_units
            from pg_temp.leave_req_input_days i
           group by i.explicit_leave_type
        ) d_sum
        full outer join (
          select a.leave_type,
                 sum(a.half_day_units)::integer as alloc_units
            from pg_temp.leave_req_type_allocs a
           group by a.leave_type
        ) a_sum on a_sum.leave_type = d_sum.leave_type
       where coalesce(d_sum.day_units, 0) <> coalesce(a_sum.alloc_units, 0);

      if v_mismatch_count > 0 then
        raise exception 'LEAVE_TYPE_ALLOCATION_MISMATCH'
          using errcode = '22023';
      end if;

      insert into pg_temp.leave_req_normalized_days (
        seq_no,
        leave_date,
        session_code,
        half_day_units,
        leave_type
      )
      select pg_catalog.row_number() over (
               order by i.leave_date asc,
                        case i.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                        i.seq_no asc
             )::integer,
             i.leave_date,
             i.session_code,
             i.half_day_units,
             i.explicit_leave_type
        from pg_temp.leave_req_input_days i;
    else
      insert into pg_temp.leave_req_normalized_days (
        seq_no,
        leave_date,
        session_code,
        half_day_units,
        leave_type
      )
      with expanded_day_slots as (
        select pg_catalog.row_number() over (
                 order by i.leave_date asc,
                          case i.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                          i.seq_no asc,
                          s.slot_idx asc
               )::integer as slot_no,
               i.seq_no as orig_seq_no,
               i.leave_date,
               i.session_code as orig_session_code,
               case
                 when i.session_code = 'FULL' and s.slot_idx = 1 then 'AM'
                 when i.session_code = 'FULL' and s.slot_idx = 2 then 'PM'
                 else i.session_code
               end as slot_session_code
          from pg_temp.leave_req_input_days i
          cross join lateral pg_catalog.generate_series(1, i.half_day_units) as s(slot_idx)
      ),
      expanded_alloc_slots as (
        select pg_catalog.row_number() over (
                 order by a.alloc_seq asc, s.slot_idx asc
               )::integer as slot_no,
               a.leave_type
          from pg_temp.leave_req_type_allocs a
          cross join lateral pg_catalog.generate_series(1, a.half_day_units) as s(slot_idx)
      ),
      assigned_slots as (
        select d.slot_no,
               d.orig_seq_no,
               d.leave_date,
               d.orig_session_code,
               d.slot_session_code,
               a.leave_type
          from expanded_day_slots d
          join expanded_alloc_slots a on a.slot_no = d.slot_no
      ),
      merged_days as (
        select min(s.slot_no) as first_slot_no,
               s.leave_date,
               'FULL'::text as session_code,
               2::integer as half_day_units,
               min(s.leave_type) as leave_type
          from assigned_slots s
         where s.orig_session_code = 'FULL'
         group by s.orig_seq_no, s.leave_date
        having count(distinct s.leave_type) = 1
        union all
        select s.slot_no as first_slot_no,
               s.leave_date,
               s.slot_session_code as session_code,
               1::integer as half_day_units,
               s.leave_type
          from assigned_slots s
         where s.orig_session_code <> 'FULL'
            or s.orig_seq_no in (
              select s2.orig_seq_no
                from assigned_slots s2
               where s2.orig_session_code = 'FULL'
               group by s2.orig_seq_no
              having count(distinct s2.leave_type) > 1
            )
      )
      select pg_catalog.row_number() over (
               order by m.leave_date asc,
                        case m.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                        m.first_slot_no asc
             )::integer,
             m.leave_date,
             m.session_code,
             m.half_day_units,
             m.leave_type
        from merged_days m;
    end if;
  else
    insert into pg_temp.leave_req_normalized_days (
      seq_no,
      leave_date,
      session_code,
      half_day_units,
      leave_type
    )
    select pg_catalog.row_number() over (
             order by i.leave_date asc,
                      case i.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                      i.seq_no asc
           )::integer,
           i.leave_date,
           i.session_code,
           i.half_day_units,
           coalesce(i.explicit_leave_type, 'ANNUAL')
      from pg_temp.leave_req_input_days i;
  end if;

  if exists (
    select 1
      from (
        select n.leave_type,
               sum(n.half_day_units)::integer as type_units
          from pg_temp.leave_req_normalized_days n
         group by n.leave_type
      ) s
     where (s.leave_type in ('BEREAVEMENT', 'MARRIAGE') and s.type_units > 6)
        or (s.leave_type in ('SICK', 'UNPAID') and s.type_units > 14)
  ) then
    raise exception 'LEAVE_TYPE_LIMIT_EXCEEDED'
      using errcode = '22023';
  end if;

  select p.*
    into v_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_actor_app_user_id;

  if found then
    v_has_profile := true;
    v_profile_configured := (
      v_profile.employment_status in ('PROBATION', 'OFFICIAL')
      and v_profile.work_start_date is not null
      and (
        v_profile.employment_status <> 'OFFICIAL'
        or v_profile.official_effective_date is not null
      )
    );
    v_emp_status_snapshot := v_profile.employment_status;
    v_unit_kind_snapshot := v_profile.unit_kind;
  else
    v_emp_status_snapshot := 'UNCONFIGURED';
    v_unit_kind_snapshot := 'UNCLASSIFIED';
  end if;

  select coalesce(sum(n.half_day_units), 0)::integer
    into v_annual_units
    from pg_temp.leave_req_normalized_days n
   where n.leave_type = 'ANNUAL';

  if v_annual_units > 0 then
    create temporary table if not exists pg_temp.leave_sim_lots (
      lot_id uuid primary key,
      usable_from_date date not null,
      expires_after_date date null,
      created_at timestamptz not null,
      remaining_units integer not null
    ) on commit drop;

    truncate table pg_temp.leave_sim_lots;

    insert into pg_temp.leave_sim_lots (
      lot_id,
      usable_from_date,
      expires_after_date,
      created_at,
      remaining_units
    )
    select l.lot_id,
           l.usable_from_date,
           l.expires_after_date,
           l.created_at,
           (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units)
      from public.leave_lots l
     where l.app_user_id = p_actor_app_user_id
       and l.leave_year = v_year
       and (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units) > 0;

    for v_day_date, v_half_day_units in
      select n.leave_date,
             n.half_day_units
        from pg_temp.leave_req_normalized_days n
       where n.leave_type = 'ANNUAL'
       order by n.leave_date asc, n.seq_no asc
    loop
      v_sim_needed := v_half_day_units;
      for v_sim_lot in
        select s.lot_id,
               s.remaining_units
          from pg_temp.leave_sim_lots s
         where s.remaining_units > 0
           and s.usable_from_date <= v_day_date
           and (s.expires_after_date is null or v_day_date <= s.expires_after_date)
         order by s.expires_after_date asc nulls last,
                  s.usable_from_date asc,
                  s.created_at asc,
                  s.lot_id asc
      loop
        if v_sim_lot.remaining_units >= v_sim_needed then
          update pg_temp.leave_sim_lots
             set remaining_units = remaining_units - v_sim_needed
           where lot_id = v_sim_lot.lot_id;
          v_sim_needed := 0;
          exit;
        else
          v_sim_needed := v_sim_needed - v_sim_lot.remaining_units;
          update pg_temp.leave_sim_lots
             set remaining_units = 0
           where lot_id = v_sim_lot.lot_id;
        end if;
      end loop;

      if v_sim_needed > 0 then
        raise exception 'LEAVE_INSUFFICIENT_BALANCE'
          using errcode = '22023';
      end if;
    end loop;
  end if;

  -- Single atomic snapshot of route_kind, unit_kind, primary_approver, and routed_department
  select *
    into v_routing_snap
    from public.leave_management__internal_resolve_routing_snapshot(p_actor_app_user_id, v_today);
  v_routing := v_routing_snap.routing;

  insert into public.leave_requests (
    app_user_id,
    status,
    pay_treatment,
    employment_status_snapshot,
    unit_kind_snapshot,
    profile_configured_at_submit,
    requested_units,
    reason,
    route_kind,
    primary_approver_app_user_id,
    routed_team_id,
    routed_team_code,
    routed_team_name,
    routed_department_id,
    routed_department_code,
    routed_department_name,
    fallback_reason,
    row_version
  )
  values (
    p_actor_app_user_id,
    'PENDING',
    null,
    v_emp_status_snapshot,
    coalesce(v_routing->>'unit_kind', v_unit_kind_snapshot),
    v_profile_configured,
    v_total_units,
    v_reason,
    v_routing->>'route_kind',
    nullif(v_routing->>'primary_approver_app_user_id', '')::uuid,
    nullif(v_routing->>'team_id', '')::uuid,
    nullif(v_routing->>'team_code', ''),
    nullif(v_routing->>'team_name', ''),
    v_routing_snap.routed_department_id,
    v_routing_snap.routed_department_code,
    v_routing_snap.routed_department_name,
    nullif(v_routing->>'fallback_reason', ''),
    1
  )
  returning * into v_request_row;

  begin
    insert into public.leave_request_days (
      request_id,
      app_user_id,
      leave_date,
      session_code,
      leave_type,
      half_day_units,
      is_active
    )
    select v_request_row.request_id,
           p_actor_app_user_id,
           n.leave_date,
           n.session_code,
           n.leave_type,
           n.half_day_units,
           true
      from pg_temp.leave_req_normalized_days n
     order by n.leave_date asc,
              case n.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
              n.seq_no asc;
  exception
    when unique_violation then
      raise exception 'LEAVE_REQUEST_OVERLAP'
        using errcode = '23505';
  end;

  v_projected_request := public.leave_management__internal_project_request(v_request_row);

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    request_id,
    reason,
    payload
  )
  values (
    'REQUEST_CREATED',
    p_actor_app_user_id,
    p_actor_app_user_id,
    v_request_row.request_id,
    v_reason,
    pg_catalog.jsonb_build_object(
      'leave_types', v_projected_request->'leave_types',
      'type_breakdown', v_projected_request->'type_breakdown',
      'requested_units', v_total_units,
      'requested_annual_units', v_annual_units,
      'route_kind', v_request_row.route_kind,
      'primary_approver_app_user_id', v_request_row.primary_approver_app_user_id,
      'fallback_reason', v_request_row.fallback_reason
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'request', v_projected_request,
    'balance', public.leave_management__internal_compute_balance_summary(p_actor_app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'CREATE_REQUEST',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$
;

-- leave_management_decide_request(uuid,uuid,uuid,text,integer,text,text,text)
CREATE OR REPLACE FUNCTION public.leave_management_decide_request(p_actor_auth_subject uuid, p_actor_app_user_id uuid, p_request_id uuid, p_decision text, p_expected_row_version integer, p_reason text, p_idempotency_key text, p_request_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_decision text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_decision, '')));
  v_reason text := null;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_req public.leave_requests%rowtype;
  v_day record;
  v_lot record;
  v_alloc record;
  v_needed integer;
  v_lot_avail integer;
  v_take integer;
  v_alloc_status text;
  v_entry_type text;
  v_projected_request jsonb;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  if v_decision not in ('APPROVE', 'REJECT', 'CANCEL_APPROVED') then
    raise exception 'LEAVE_DECISION_INVALID'
      using errcode = '22023';
  end if;

  v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;

  select r.*
    into v_req
    from public.leave_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'LEAVE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform public.leave_management__internal_lock_employee(v_req.app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'DECIDE_REQUEST'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select r.*
    into v_req
    from public.leave_requests r
   where r.request_id = p_request_id
   for update;

  if p_actor_app_user_id = v_req.app_user_id then
    raise exception 'LEAVE_SELF_APPROVAL_FORBIDDEN'
      using errcode = '42501';
  end if;

  if not public.leave_management__internal_can_actor_decide_request(p_actor_app_user_id, v_req, v_today) then
    raise exception 'LEAVE_APPROVAL_FORBIDDEN'
      using errcode = '42501';
  end if;

  if p_expected_row_version is null or v_req.row_version <> p_expected_row_version then
    raise exception 'LEAVE_ROW_VERSION_CONFLICT'
      using ERRCODE = 'PT409';
  end if;

  perform public.leave_management__internal_sync_employee_accruals(v_req.app_user_id, v_today);

  if v_decision = 'APPROVE' then
    if v_req.status <> 'PENDING' then
      raise exception 'LEAVE_INVALID_STATE_TRANSITION'
        using errcode = '22023';
    end if;

    -- Strictly deduct/reserve FIFO lots only for ANNUAL leave days
    for v_day in
      select d.request_day_id,
             d.leave_date,
             d.session_code,
             d.leave_type,
             d.half_day_units
        from public.leave_request_days d
       where d.request_id = v_req.request_id
         and d.leave_type = 'ANNUAL'
       order by d.leave_date asc,
                case d.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                d.request_day_id asc
    loop
      v_needed := v_day.half_day_units;

      for v_lot in
        select l.*
          from public.leave_lots l
         where l.app_user_id = v_req.app_user_id
           and l.usable_from_date <= v_day.leave_date
           and (l.expires_after_date is null or v_day.leave_date <= l.expires_after_date)
           and (l.granted_units - l.reserved_units - l.consumed_units - l.expired_units) > 0
         order by l.expires_after_date asc nulls last,
                  l.usable_from_date asc,
                  l.created_at asc,
                  l.lot_id asc
         for update
      loop
        v_lot_avail := v_lot.granted_units - v_lot.reserved_units - v_lot.consumed_units - v_lot.expired_units;
        if v_lot_avail <= 0 then
          continue;
        end if;

        v_take := least(v_needed, v_lot_avail);

        if v_day.leave_date <= v_today then
          v_alloc_status := 'CONSUMED';
          v_entry_type := 'CONSUME';

          update public.leave_lots
             set consumed_units = consumed_units + v_take,
                 updated_at = pg_catalog.timezone('utc', pg_catalog.now())
           where lot_id = v_lot.lot_id;

          insert into public.leave_request_lot_allocations (
            request_id,
            request_day_id,
            lot_id,
            leave_date,
            allocated_units,
            status,
            settled_at
          )
          values (
            v_req.request_id,
            v_day.request_day_id,
            v_lot.lot_id,
            v_day.leave_date,
            v_take,
            v_alloc_status,
            pg_catalog.timezone('utc', pg_catalog.now())
          );

          insert into public.leave_ledger_entries (
            app_user_id,
            lot_id,
            request_id,
            request_day_id,
            entry_type,
            effective_date,
            delta_available_units,
            delta_reserved_units,
            delta_consumed_units,
            delta_expired_units,
            actor_app_user_id,
            reason,
            metadata
          )
          values (
            v_req.app_user_id,
            v_lot.lot_id,
            v_req.request_id,
            v_day.request_day_id,
            v_entry_type,
            v_day.leave_date,
            -v_take,
            0,
            v_take,
            0,
            p_actor_app_user_id,
            coalesce(v_reason, 'Duyệt đơn nghỉ phép năm (trừ phép trực tiếp)'),
            pg_catalog.jsonb_build_object(
              'leave_date', v_day.leave_date,
              'session_code', v_day.session_code,
              'leave_type', v_day.leave_type,
              'lot_kind', v_lot.lot_kind
            )
          );
        else
          v_alloc_status := 'RESERVED';
          v_entry_type := 'RESERVE';

          update public.leave_lots
             set reserved_units = reserved_units + v_take,
                 updated_at = pg_catalog.timezone('utc', pg_catalog.now())
           where lot_id = v_lot.lot_id;

          insert into public.leave_request_lot_allocations (
            request_id,
            request_day_id,
            lot_id,
            leave_date,
            allocated_units,
            status,
            settled_at
          )
          values (
            v_req.request_id,
            v_day.request_day_id,
            v_lot.lot_id,
            v_day.leave_date,
            v_take,
            v_alloc_status,
            null
          );

          insert into public.leave_ledger_entries (
            app_user_id,
            lot_id,
            request_id,
            request_day_id,
            entry_type,
            effective_date,
            delta_available_units,
            delta_reserved_units,
            delta_consumed_units,
            delta_expired_units,
            actor_app_user_id,
            reason,
            metadata
          )
          values (
            v_req.app_user_id,
            v_lot.lot_id,
            v_req.request_id,
            v_day.request_day_id,
            v_entry_type,
            v_day.leave_date,
            -v_take,
            v_take,
            0,
            0,
            p_actor_app_user_id,
            coalesce(v_reason, 'Duyệt đơn nghỉ phép năm (giữ chỗ ngày tương lai)'),
            pg_catalog.jsonb_build_object(
              'leave_date', v_day.leave_date,
              'session_code', v_day.session_code,
              'leave_type', v_day.leave_type,
              'lot_kind', v_lot.lot_kind
            )
          );
        end if;

        v_needed := v_needed - v_take;
        exit when v_needed = 0;
      end loop;

      if v_needed > 0 then
        raise exception 'LEAVE_INSUFFICIENT_BALANCE'
          using errcode = '22023';
      end if;
    end loop;

    update public.leave_requests
       set status = 'APPROVED',
           decided_at = pg_catalog.timezone('utc', pg_catalog.now()),
           decided_by_app_user_id = p_actor_app_user_id,
           decision_reason = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where request_id = v_req.request_id
     returning * into v_req;

    v_projected_request := public.leave_management__internal_project_request(v_req);

    insert into public.leave_audit_events (
      event_type,
      actor_app_user_id,
      target_app_user_id,
      request_id,
      reason,
      payload
    )
    values (
      'REQUEST_APPROVED',
      p_actor_app_user_id,
      v_req.app_user_id,
      v_req.request_id,
      v_reason,
      pg_catalog.jsonb_build_object(
        'leave_types', v_projected_request->'leave_types',
        'type_breakdown', v_projected_request->'type_breakdown',
        'requested_units', v_req.requested_units,
        'requested_annual_units', v_projected_request->'requested_annual_units',
        'row_version', v_req.row_version
      )
    );

  elsif v_decision = 'REJECT' then
    if v_req.status <> 'PENDING' then
      raise exception 'LEAVE_INVALID_STATE_TRANSITION'
        using errcode = '22023';
    end if;

    update public.leave_request_days
       set is_active = false
     where request_id = v_req.request_id;

    update public.leave_requests
       set status = 'REJECTED',
           decided_at = pg_catalog.timezone('utc', pg_catalog.now()),
           decided_by_app_user_id = p_actor_app_user_id,
           decision_reason = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where request_id = v_req.request_id
     returning * into v_req;

    v_projected_request := public.leave_management__internal_project_request(v_req);

    insert into public.leave_audit_events (
      event_type,
      actor_app_user_id,
      target_app_user_id,
      request_id,
      reason,
      payload
    )
    values (
      'REQUEST_REJECTED',
      p_actor_app_user_id,
      v_req.app_user_id,
      v_req.request_id,
      v_reason,
      pg_catalog.jsonb_build_object(
        'row_version', v_req.row_version
      )
    );

  elsif v_decision = 'CANCEL_APPROVED' then
    if v_req.status <> 'APPROVED' then
      raise exception 'LEAVE_INVALID_STATE_TRANSITION'
        using errcode = '22023';
    end if;

    for v_alloc in
      select a.*
        from public.leave_request_lot_allocations a
       where a.request_id = v_req.request_id
         and a.status in ('RESERVED', 'CONSUMED')
       order by a.allocation_id asc
       for update
    loop
      select l.*
        into v_lot
        from public.leave_lots l
       where l.lot_id = v_alloc.lot_id
       for update;

      if v_alloc.status = 'RESERVED' then
        update public.leave_request_lot_allocations
           set status = 'RELEASED',
               released_at = pg_catalog.timezone('utc', pg_catalog.now())
         where allocation_id = v_alloc.allocation_id;

        update public.leave_lots
           set reserved_units = reserved_units - v_alloc.allocated_units,
               updated_at = pg_catalog.timezone('utc', pg_catalog.now())
         where lot_id = v_lot.lot_id;

        insert into public.leave_ledger_entries (
          app_user_id,
          lot_id,
          request_id,
          request_day_id,
          entry_type,
          effective_date,
          delta_available_units,
          delta_reserved_units,
          delta_consumed_units,
          delta_expired_units,
          actor_app_user_id,
          reason,
          metadata
        )
        values (
          v_req.app_user_id,
          v_lot.lot_id,
          v_req.request_id,
          v_alloc.request_day_id,
          'RELEASE_RESERVE',
          v_today,
          v_alloc.allocated_units,
          -v_alloc.allocated_units,
          0,
          0,
          p_actor_app_user_id,
          v_reason,
          pg_catalog.jsonb_build_object(
            'allocation_id', v_alloc.allocation_id,
            'leave_date', v_alloc.leave_date
          )
        );
      else
        update public.leave_request_lot_allocations
           set status = 'REVERSED',
               released_at = pg_catalog.timezone('utc', pg_catalog.now())
         where allocation_id = v_alloc.allocation_id;

        update public.leave_lots
           set consumed_units = consumed_units - v_alloc.allocated_units,
               updated_at = pg_catalog.timezone('utc', pg_catalog.now())
         where lot_id = v_lot.lot_id;

        insert into public.leave_ledger_entries (
          app_user_id,
          lot_id,
          request_id,
          request_day_id,
          entry_type,
          effective_date,
          delta_available_units,
          delta_reserved_units,
          delta_consumed_units,
          delta_expired_units,
          actor_app_user_id,
          reason,
          metadata
        )
        values (
          v_req.app_user_id,
          v_lot.lot_id,
          v_req.request_id,
          v_alloc.request_day_id,
          'REVERSAL_CONSUME',
          v_today,
          v_alloc.allocated_units,
          0,
          -v_alloc.allocated_units,
          0,
          p_actor_app_user_id,
          v_reason,
          pg_catalog.jsonb_build_object(
            'allocation_id', v_alloc.allocation_id,
            'leave_date', v_alloc.leave_date
          )
        );
      end if;

      -- If the lot has already expired as of v_today, immediately expire the returned units
      if v_lot.expires_after_date is not null and v_lot.expires_after_date < v_today then
        update public.leave_lots
           set expired_units = expired_units + v_alloc.allocated_units,
               updated_at = pg_catalog.timezone('utc', pg_catalog.now())
         where lot_id = v_lot.lot_id;

        insert into public.leave_ledger_entries (
          app_user_id,
          lot_id,
          request_id,
          request_day_id,
          entry_type,
          effective_date,
          delta_available_units,
          delta_reserved_units,
          delta_consumed_units,
          delta_expired_units,
          actor_app_user_id,
          reason,
          metadata
        )
        values (
          v_req.app_user_id,
          v_lot.lot_id,
          v_req.request_id,
          v_alloc.request_day_id,
          'EXPIRE_CARRY_OVER',
          v_today,
          -v_alloc.allocated_units,
          0,
          0,
          v_alloc.allocated_units,
          p_actor_app_user_id,
          'Hết hạn ngay phần phép hoàn lại do lô phép chuyển năm đã quá hạn ' || v_lot.expires_after_date::text,
          pg_catalog.jsonb_build_object(
            'allocation_id', v_alloc.allocation_id,
            'expires_after_date', v_lot.expires_after_date
          )
        );
      end if;
    end loop;

    update public.leave_request_days
       set is_active = false
     where request_id = v_req.request_id;

    update public.leave_requests
       set status = 'CANCELLED',
           cancelled_at = pg_catalog.timezone('utc', pg_catalog.now()),
           cancelled_by_app_user_id = p_actor_app_user_id,
           cancellation_reason = v_reason,
           row_version = row_version + 1,
           updated_at = pg_catalog.timezone('utc', pg_catalog.now())
     where request_id = v_req.request_id
     returning * into v_req;

    v_projected_request := public.leave_management__internal_project_request(v_req);

    insert into public.leave_audit_events (
      event_type,
      actor_app_user_id,
      target_app_user_id,
      request_id,
      reason,
      payload
    )
    values (
      'REQUEST_CANCELLED',
      p_actor_app_user_id,
      v_req.app_user_id,
      v_req.request_id,
      v_reason,
      pg_catalog.jsonb_build_object(
        'row_version', v_req.row_version
      )
    );
  end if;

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'request', v_projected_request,
    'requester_balance', public.leave_management__internal_compute_balance_summary(v_req.app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'DECIDE_REQUEST',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$
;

-- leave_management_get_actor_access(uuid,uuid)
CREATE OR REPLACE FUNCTION public.leave_management_get_actor_access(p_actor_auth_subject uuid, p_actor_app_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_auth jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(
    p_actor_auth_subject,
    p_actor_app_user_id
  );

  return pg_catalog.jsonb_build_object(
    'can_access', true,
    'can_submit_request', coalesce((v_auth->>'can_submit_request')::boolean, false),
    'can_approve_requests', coalesce((v_auth->>'can_approve_requests')::boolean, false),
    'can_manage_config', coalesce((v_auth->>'can_manage_config')::boolean, false),
    'can_view_monthly_report', coalesce((v_auth->>'can_view_monthly_report')::boolean, false)
  );
end;
$function$
;

-- leave_management_get_admin_overview(uuid,uuid,text,integer,integer,text)
CREATE OR REPLACE FUNCTION public.leave_management_get_admin_overview(p_actor_auth_subject uuid, p_actor_app_user_id uuid, p_search text, p_limit integer, p_offset integer, p_account_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_search text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, ''))), '');
  v_account_status text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_account_status, '')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 300));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_dept_approvers jsonb := '[]'::jsonb;
  v_module_grants jsonb := '[]'::jsonb;
  v_employees jsonb := '[]'::jsonb;
  v_total_employees integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_account_status not in ('ACTIVE', 'INACTIVE', 'ALL') then
    raise exception 'LEAVE_FILTER_INVALID'
      using errcode = '22023';
  end if;

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  v_carry_over_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'approver_assignment_id', da.approver_assignment_id,
               'unit_kind', da.unit_kind,
               'approver_app_user_id', da.approver_app_user_id,
               'approver', public.leave_management__internal_account_summary(da.approver_app_user_id),
               'valid_from', da.valid_from,
               'valid_to', da.valid_to,
               'is_current', da.is_current,
               'reason', da.reason,
               'row_version', da.row_version
             )
             order by da.unit_kind asc
           ),
           '[]'::jsonb
         )
    into v_dept_approvers
    from public.leave_department_approvers da
   where da.is_current = true;

  -- D4 cutover: project active group-managed Leave module roles (read-only in Leave admin overview)
  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'grant_id', m.membership_id,
               'app_user_id', m.app_user_id,
               'account', public.leave_management__internal_account_summary(m.app_user_id),
               'role_code', mr.role_code,
               'valid_from', (m.started_at at time zone 'Asia/Ho_Chi_Minh')::date,
               'valid_to', null,
               'is_current', true,
               'reason', 'Qua nhóm quyền: ' || grp.name,
               'row_version', grp.version
             )
             order by mr.role_code asc, m.created_at desc, m.membership_id asc
           ),
           '[]'::jsonb
         )
    into v_module_grants
    from public.authz_user_group_members m
    join public.direct_entry_app_users u
      on u.app_user_id = m.app_user_id
     and u.enabled = true
    join public.authz_user_groups grp
      on grp.group_id = m.group_id
     and grp.active = true
     and grp.team_id is null
     and grp.is_system_admin = false
    join public.organization_departments dept
      on dept.department_id = grp.department_id
     and dept.is_active = true
    join public.authz_user_group_module_roles mr
      on mr.group_id = grp.group_id
     and mr.ended_at is null
     and mr.started_at <= v_now
     and mr.module_code = 'leave'
   where m.ended_at is null
     and m.started_at <= v_now;

  select count(*)::integer
    into v_total_employees
    from public.direct_entry_app_users u
    left join lateral (
      select op.full_name, op.employee_code
        from public.organization_account_person_links ol
        join public.organization_persons op on op.person_id = ol.person_id
       where ol.app_user_id = u.app_user_id
         and ol.started_at <= v_now
         and (ol.ended_at is null or (ol.ended_at > ol.started_at and v_now < ol.ended_at))
       order by ol.started_at desc, ol.link_id desc
       limit 1
    ) org_p on true
    left join lateral (
      select r.display_name, r.personnel_code
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
   where (
     v_account_status = 'ALL'
     or (v_account_status = 'ACTIVE' and u.enabled = true)
     or (v_account_status = 'INACTIVE' and u.enabled = false)
   )
     and (
       v_search is null
       or pg_catalog.lower(coalesce(org_p.full_name, linked.display_name, u.display_name, '')) like '%' || v_search || '%'
       or pg_catalog.lower(coalesce(org_p.employee_code, linked.personnel_code, '')) like '%' || v_search || '%'
     );

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'account', public.leave_management__internal_account_summary(sub.app_user_id),
               'profile', case
                 when sub.profile_found then
                   pg_catalog.jsonb_build_object(
                     'app_user_id', sub.app_user_id,
                     'employment_status', sub.employment_status,
                     'unit_kind', sub.unit_kind,
                     'work_start_date', sub.work_start_date,
                     'official_effective_date', sub.official_effective_date,
                     'next_seniority_effective_date', sub.next_seniority_effective_date,
                     'next_seniority_units', sub.next_seniority_units,
                     'notes', sub.notes,
                     'row_version', sub.row_version
                   )
                 else
                   pg_catalog.jsonb_build_object(
                     'app_user_id', sub.app_user_id,
                     'employment_status', 'UNCONFIGURED',
                     'unit_kind', sub.unit_kind,
                     'work_start_date', null,
                     'official_effective_date', null,
                     'next_seniority_effective_date', null,
                     'next_seniority_units', 0,
                     'notes', null,
                     'row_version', 0
                   )
               end,
               'routing', public.leave_management__internal_resolve_routing(sub.app_user_id, v_today),
               'balance', public.leave_management__internal_compute_balance_summary(sub.app_user_id, v_year, v_today)
             )
             order by sub.sort_name asc, sub.app_user_id asc
           ),
           '[]'::jsonb
         )
    into v_employees
    from (
      select u.app_user_id,
             coalesce(org_p.full_name, linked.display_name, u.display_name) as sort_name,
             (p.app_user_id is not null) as profile_found,
             coalesce(p.employment_status, 'UNCONFIGURED') as employment_status,
             case
               when org_p.has_active_person_link then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
               else coalesce(p.unit_kind, 'UNCLASSIFIED')
             end as unit_kind,
             p.work_start_date,
             p.official_effective_date,
             p.next_seniority_effective_date,
             coalesce(p.next_seniority_units, 0) as next_seniority_units,
             p.notes,
             coalesce(p.row_version, 0) as row_version
        from public.direct_entry_app_users u
        left join public.leave_employee_profiles p
          on p.app_user_id = u.app_user_id
        left join lateral (
          select *
            from public.leave_management__internal_resolve_person_department(u.app_user_id, v_now)
        ) org_p on true
        left join lateral (
          select r.display_name, r.personnel_code
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = u.app_user_id
             and l.verified = true
             and l.is_current = true
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) linked on true
       where (
         v_account_status = 'ALL'
         or (v_account_status = 'ACTIVE' and u.enabled = true)
         or (v_account_status = 'INACTIVE' and u.enabled = false)
       )
         and (
           v_search is null
           or pg_catalog.lower(coalesce(org_p.full_name, linked.display_name, u.display_name, '')) like '%' || v_search || '%'
           or pg_catalog.lower(coalesce(org_p.employee_code, linked.personnel_code, '')) like '%' || v_search || '%'
         )
       order by coalesce(org_p.full_name, linked.display_name, u.display_name) asc, u.app_user_id asc
       limit v_limit
      offset v_offset
    ) sub;

  return pg_catalog.jsonb_build_object(
    'as_of_date', v_today,
    'leave_year', v_year,
    'authority', v_auth,
    'policy', pg_catalog.jsonb_build_object(
      'annual_base_units', v_policy.annual_base_units,
      'monthly_accrual_units', v_policy.monthly_accrual_units,
      'default_seniority_years', v_policy.default_seniority_years,
      'default_seniority_step_units', v_policy.default_seniority_step_units,
      'carry_over_expiry_month', v_policy.carry_over_expiry_month,
      'carry_over_expiry_day', v_policy.carry_over_expiry_day,
      'carry_over_expires_after_date', v_carry_over_expiry,
      'row_version', v_policy.row_version
    ),
    'department_approvers', v_dept_approvers,
    'module_grants', v_module_grants,
    'total_employees', v_total_employees,
    'account_status', v_account_status,
    'limit', v_limit,
    'offset', v_offset,
    'employees', v_employees
  );
end;
$function$
;

-- leave_management_get_my_summary(uuid,uuid,integer)
CREATE OR REPLACE FUNCTION public.leave_management_get_my_summary(p_actor_auth_subject uuid, p_actor_app_user_id uuid, p_leave_year integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := coalesce(p_leave_year, pg_catalog.date_part('year', v_today)::integer);
  v_auth jsonb;
  v_account jsonb;
  v_routing jsonb;
  v_balance jsonb;
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_requests jsonb := '[]'::jsonb;
  v_ledger jsonb := '[]'::jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  perform public.leave_management__internal_sync_employee_accruals(p_actor_app_user_id, v_today);

  v_account := public.leave_management__internal_account_summary(p_actor_app_user_id);
  v_routing := public.leave_management__internal_resolve_routing(p_actor_app_user_id, v_today);
  v_balance := public.leave_management__internal_compute_balance_summary(p_actor_app_user_id, v_year, v_today);

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  v_carry_over_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  select coalesce(
           pg_catalog.jsonb_agg(
             public.leave_management__internal_project_request(r)
             order by r.submitted_at desc, r.request_id desc
           ),
           '[]'::jsonb
         )
    into v_requests
    from public.leave_requests r
   where r.app_user_id = p_actor_app_user_id;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'ledger_entry_id', le.ledger_entry_id,
               'lot_id', le.lot_id,
               'request_id', le.request_id,
               'entry_type', le.entry_type,
               'effective_date', le.effective_date,
               'delta_available_units', le.delta_available_units,
               'delta_reserved_units', le.delta_reserved_units,
               'delta_consumed_units', le.delta_consumed_units,
               'delta_expired_units', le.delta_expired_units,
               'reason', le.reason,
               'created_at', le.created_at
             )
             order by le.created_at desc
           ),
           '[]'::jsonb
         )
    into v_ledger
    from (
      select e.*
        from public.leave_ledger_entries e
       where e.app_user_id = p_actor_app_user_id
       order by e.created_at desc
       limit 100
    ) le;

  return pg_catalog.jsonb_build_object(
    'as_of_date', v_today,
    'leave_year', v_year,
    'account', v_account,
    'authority', v_auth,
    'routing', v_routing,
    'policy', pg_catalog.jsonb_build_object(
      'annual_base_units', v_policy.annual_base_units,
      'monthly_accrual_units', v_policy.monthly_accrual_units,
      'default_seniority_years', v_policy.default_seniority_years,
      'default_seniority_step_units', v_policy.default_seniority_step_units,
      'carry_over_expiry_month', v_policy.carry_over_expiry_month,
      'carry_over_expiry_day', v_policy.carry_over_expiry_day,
      'carry_over_expires_after_date', v_carry_over_expiry,
      'row_version', v_policy.row_version
    ),
    'balance', v_balance,
    'requests', v_requests,
    'ledger_entries', v_ledger
  );
end;
$function$
;

-- leave_management_monthly_report(uuid,uuid,text,text,text,integer,integer)
CREATE OR REPLACE FUNCTION public.leave_management_monthly_report(p_actor_auth_subject uuid, p_actor_app_user_id uuid, p_year_month text, p_unit_kind_filter text DEFAULT NULL::text, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 200, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.leave_management__internal_business_date();
  v_auth jsonb;
  v_ym text := pg_catalog.btrim(coalesce(p_year_month, pg_catalog.to_char(v_today, 'YYYY-MM')));
  v_unit_filter text := nullif(pg_catalog.upper(pg_catalog.btrim(coalesce(p_unit_kind_filter, ''))), '');
  v_search text := nullif(pg_catalog.lower(pg_catalog.btrim(coalesce(p_search, ''))), '');
  v_limit integer := greatest(1, least(coalesce(p_limit, 200), 500));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
  v_month_start date;
  v_month_end date;
  v_year integer;
  v_month integer;
  v_sync_as_of date;
  v_page_user_ids uuid[] := array[]::uuid[];
  v_emp record;
  v_rows jsonb := '[]'::jsonb;
  v_total integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_view_monthly_report')::boolean, false) then
    raise exception 'LEAVE_REPORT_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_ym !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'LEAVE_REPORT_YEAR_MONTH_INVALID'
      using errcode = '22023';
  end if;

  if v_unit_filter is not null
     and v_unit_filter not in ('ALL', 'UNCLASSIFIED', 'RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD') then
    raise exception 'LEAVE_FILTER_INVALID'
      using errcode = '22023';
  end if;

  v_month_start := (v_ym || '-01')::date;
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;
  v_year := pg_catalog.date_part('year', v_month_start)::integer;
  v_month := pg_catalog.date_part('month', v_month_start)::integer;
  v_sync_as_of := least(v_today, v_month_end);

  select count(*)::integer
    into v_total
    from public.direct_entry_app_users u
    left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
    left join lateral (
      select *
        from public.leave_management__internal_resolve_person_department(u.app_user_id, v_now)
    ) org_p on true
    left join lateral (
      select r.display_name, r.personnel_code
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
   where (
       v_unit_filter is null
       or v_unit_filter = 'ALL'
       or (
         case
           when org_p.has_active_person_link then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
           else coalesce(p.unit_kind, 'UNCLASSIFIED')
         end
       ) = v_unit_filter
     )
     and (
       v_search is null
       or pg_catalog.lower(coalesce(org_p.full_name, linked.display_name, u.display_name, '')) like '%' || v_search || '%'
       or pg_catalog.lower(coalesce(org_p.employee_code, linked.personnel_code, '')) like '%' || v_search || '%'
     );

  select coalesce(pg_catalog.array_agg(paged.app_user_id order by paged.sort_name asc, paged.app_user_id asc), array[]::uuid[])
    into v_page_user_ids
    from (
      select u.app_user_id,
             coalesce(org_p.full_name, linked.display_name, u.display_name) as sort_name
        from public.direct_entry_app_users u
        left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
        left join lateral (
          select *
            from public.leave_management__internal_resolve_person_department(u.app_user_id, v_now)
        ) org_p on true
        left join lateral (
          select r.display_name, r.personnel_code
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = u.app_user_id
             and l.verified = true
             and l.is_current = true
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) linked on true
       where (
           v_unit_filter is null
           or v_unit_filter = 'ALL'
           or (
             case
               when org_p.has_active_person_link then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
               else coalesce(p.unit_kind, 'UNCLASSIFIED')
             end
           ) = v_unit_filter
         )
         and (
           v_search is null
           or pg_catalog.lower(coalesce(org_p.full_name, linked.display_name, u.display_name, '')) like '%' || v_search || '%'
           or pg_catalog.lower(coalesce(org_p.employee_code, linked.personnel_code, '')) like '%' || v_search || '%'
         )
       order by coalesce(org_p.full_name, linked.display_name, u.display_name) asc, u.app_user_id asc
       limit v_limit
      offset v_offset
    ) paged;

  for v_emp in
    select u.app_user_id
      from public.direct_entry_app_users u
      left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
     where u.app_user_id = any(v_page_user_ids)
       and (
         (
           p.app_user_id is not null
           and p.employment_status = 'OFFICIAL'
           and p.work_start_date is not null
         )
         or exists (
           select 1
             from public.leave_lots l
            where l.app_user_id = u.app_user_id
         )
       )
     order by u.app_user_id asc
  loop
    perform public.leave_management__internal_sync_employee_accruals(v_emp.app_user_id, v_sync_as_of);
  end loop;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'app_user_id', sub.app_user_id,
               'account', sub.account,
               'routing', sub.routing,
               'employment_status', sub.employment_status,
               'unit_kind', sub.unit_kind,
               'work_start_date', sub.work_start_date,
               'official_effective_date', sub.official_effective_date,
               'attendance_day_count', sub.attendance_day_count,
               'attendance_dates', sub.attendance_dates,
               'attendance_days', sub.attendance_days,
               'leave_days', sub.leave_days,
               'pending_leave_days', sub.pending_leave_days,
               'month_annual_leave_units', sub.month_annual_leave_units,
               'month_bereavement_leave_units', sub.month_bereavement_leave_units,
               'month_marriage_leave_units', sub.month_marriage_leave_units,
               'month_sick_leave_units', sub.month_sick_leave_units,
               'month_unpaid_leave_units', sub.month_unpaid_leave_units,
               'month_total_approved_leave_units', sub.month_total_approved_leave_units,
               'month_pending_units', sub.month_pending_units,
               'month_approved_request_count', sub.month_approved_request_count,
               'balance', sub.balance
             )
             order by sub.sort_name asc, sub.app_user_id asc
           ),
           '[]'::jsonb
         )
    into v_rows
    from (
      select u.app_user_id,
             coalesce(org_p.full_name, linked.display_name, u.display_name) as sort_name,
             public.leave_management__internal_account_summary(u.app_user_id) as account,
             public.leave_management__internal_resolve_routing(u.app_user_id, v_sync_as_of) as routing,
             coalesce(p.employment_status, 'UNCONFIGURED') as employment_status,
             case
               when org_p.has_active_person_link then coalesce(org_p.department_system_key, 'UNCLASSIFIED')
               else coalesce(p.unit_kind, 'UNCLASSIFIED')
             end as unit_kind,
             p.work_start_date,
             p.official_effective_date,
             coalesce(att.attendance_day_count, 0)::integer as attendance_day_count,
             coalesce(att.attendance_dates, '[]'::jsonb) as attendance_dates,
             coalesce(att.attendance_days, '[]'::jsonb) as attendance_days,
             coalesce(m.leave_days, '[]'::jsonb) as leave_days,
             coalesce(m.pending_leave_days, '[]'::jsonb) as pending_leave_days,
             coalesce(m.annual_units, 0)::integer as month_annual_leave_units,
             coalesce(m.bereavement_units, 0)::integer as month_bereavement_leave_units,
             coalesce(m.marriage_units, 0)::integer as month_marriage_leave_units,
             coalesce(m.sick_units, 0)::integer as month_sick_leave_units,
             coalesce(m.unpaid_units, 0)::integer as month_unpaid_leave_units,
             coalesce(m.total_approved_units, 0)::integer as month_total_approved_leave_units,
             coalesce(m.pending_units, 0)::integer as month_pending_units,
             coalesce(m.approved_request_count, 0)::integer as month_approved_request_count,
             public.leave_management__internal_compute_balance_summary(u.app_user_id, v_year, v_sync_as_of) as balance
        from public.direct_entry_app_users u
        left join public.leave_employee_profiles p on p.app_user_id = u.app_user_id
        left join lateral (
          select *
            from public.leave_management__internal_resolve_person_department(u.app_user_id, v_now)
        ) org_p on true
        left join lateral (
          select r.display_name, r.personnel_code
            from public.direct_entry_app_user_recruiter_links l
            join public.recruiters r on r.recruiter_id = l.recruiter_id
           where l.app_user_id = u.app_user_id
             and l.verified = true
             and l.is_current = true
           order by l.valid_from desc, l.link_id desc
           limit 1
        ) linked on true
        left join lateral (
          select count(*)::integer as attendance_day_count,
                 coalesce(
                   pg_catalog.jsonb_agg(day_row.business_date order by day_row.business_date asc),
                   '[]'::jsonb
                 ) as attendance_dates,
                 coalesce(
                   pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'business_date', day_row.business_date,
                       'checkin_count', day_row.checkin_count,
                       'first_captured_at', day_row.first_captured_at,
                       'last_captured_at', day_row.last_captured_at
                     )
                     order by day_row.business_date asc
                   ),
                   '[]'::jsonb
                 ) as attendance_days
            from (
              select ac.business_date,
                     count(*)::integer as checkin_count,
                     min(ac.captured_at) as first_captured_at,
                     max(ac.captured_at) as last_captured_at
                from public.attendance_checkins ac
               where ac.app_user_id = u.app_user_id
                 and ac.business_date between v_month_start and v_month_end
               group by ac.business_date
            ) day_row
        ) att on true
        left join lateral (
          select coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'ANNUAL'),
                   0
                 ) as annual_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'BEREAVEMENT'),
                   0
                 ) as bereavement_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'MARRIAGE'),
                   0
                 ) as marriage_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'SICK'),
                   0
                 ) as sick_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED' and d.leave_type = 'UNPAID'),
                   0
                 ) as unpaid_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'APPROVED'),
                   0
                 ) as total_approved_units,
                 coalesce(
                   sum(d.half_day_units)
                     filter (where req.status = 'PENDING'),
                   0
                 ) as pending_units,
                 count(distinct req.request_id)
                   filter (where req.status = 'APPROVED') as approved_request_count,
                 coalesce(
                   pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'request_id', req.request_id,
                       'request_day_id', d.request_day_id,
                       'leave_date', d.leave_date,
                       'session_code', d.session_code,
                       'leave_type', d.leave_type,
                       'half_day_units', d.half_day_units
                     )
                     order by d.leave_date asc,
                              case d.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                              d.request_day_id asc
                   ) filter (where req.status = 'APPROVED'),
                   '[]'::jsonb
                 ) as leave_days,
                 coalesce(
                   pg_catalog.jsonb_agg(
                     pg_catalog.jsonb_build_object(
                       'request_id', req.request_id,
                       'request_day_id', d.request_day_id,
                       'leave_date', d.leave_date,
                       'session_code', d.session_code,
                       'leave_type', d.leave_type,
                       'half_day_units', d.half_day_units
                     )
                     order by d.leave_date asc,
                              case d.session_code when 'FULL' then 1 when 'AM' then 2 else 3 end asc,
                              d.request_day_id asc
                   ) filter (where req.status = 'PENDING'),
                   '[]'::jsonb
                 ) as pending_leave_days
            from public.leave_request_days d
            join public.leave_requests req on req.request_id = d.request_id
           where d.app_user_id = u.app_user_id
             and d.leave_date between v_month_start and v_month_end
        ) m on true
       where u.app_user_id = any(v_page_user_ids)
    ) sub;

  return pg_catalog.jsonb_build_object(
    'year_month', v_ym,
    'leave_year', v_year,
    'month', v_month,
    'as_of_date', v_sync_as_of,
    'unit_kind_filter', coalesce(v_unit_filter, 'ALL'),
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset,
    'rows', v_rows
  );
end;
$function$
;

-- leave_management_preview_opening_batch(uuid,uuid,integer,jsonb)
CREATE OR REPLACE FUNCTION public.leave_management_preview_opening_batch(p_actor_auth_subject uuid, p_actor_app_user_id uuid, p_leave_year integer, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := coalesce(p_leave_year, pg_catalog.date_part('year', v_today)::integer);
  v_auth jsonb;
  v_policy public.leave_policy_configs%rowtype;
  v_carry_over_expiry date;
  v_rows_fingerprint text;
  v_item jsonb;
  v_lock_uid uuid;
  v_idx integer := 0;
  v_target_id_text text;
  v_target_id uuid;
  v_carry_units integer;
  v_open_units integer;
  v_sen_units integer;
  v_note text;
  v_seen_ids uuid[] := array[]::uuid[];
  v_account jsonb;
  v_profile public.leave_employee_profiles%rowtype;
  v_has_profile boolean;
  v_row_errors jsonb;
  v_preview_rows jsonb := '[]'::jsonb;
  v_rows_state jsonb := '[]'::jsonb;
  v_error_count integer := 0;
  v_total_carry integer := 0;
  v_total_open integer := 0;
  v_total_sen integer := 0;
  v_has_carry_expiry_error boolean := false;
  v_current_year_accrued integer := 0;
  v_current_year_granted integer := 0;
  v_current_year_locked integer := 0;
  v_current_year_available integer := 0;
  v_delta_current_year integer := 0;
  v_reconciled_current_year_granted integer := 0;
  v_reconciled_current_year_available integer := 0;
  v_profile_row_version integer := 0;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if not coalesce((v_auth->>'can_manage_config')::boolean, false) then
    raise exception 'LEAVE_ADMIN_FORBIDDEN'
      using errcode = '42501';
  end if;

  if v_year < 2020 or v_year > 2100 then
    raise exception 'LEAVE_YEAR_INVALID'
      using errcode = '22023';
  end if;

  if p_rows is null
     or pg_catalog.jsonb_typeof(p_rows) <> 'array'
     or pg_catalog.jsonb_array_length(p_rows) < 1
     or pg_catalog.jsonb_array_length(p_rows) > 300 then
    raise exception 'LEAVE_OPENING_ROWS_INVALID'
      using errcode = '22023';
  end if;

  v_rows_fingerprint := public.leave_management__internal_opening_rows_fingerprint(p_rows);

  select c.*
    into v_policy
    from public.leave_policy_configs c
   where c.config_key = 'default';

  v_carry_over_expiry := public.leave_management__internal_resolve_carry_over_expiry_date(
    v_year,
    v_policy.carry_over_expiry_month,
    v_policy.carry_over_expiry_day
  );

  -- Canonical ascending lock order across all distinct valid UUID targets before looping
  for v_lock_uid in
    select distinct (pg_catalog.btrim(elem->>'app_user_id'))::uuid as uid
      from pg_catalog.jsonb_array_elements(p_rows) as elem
     where pg_catalog.jsonb_typeof(elem) = 'object'
       and pg_catalog.btrim(coalesce(elem->>'app_user_id', '')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     order by 1 asc
  loop
    perform public.leave_management__internal_lock_employee(v_lock_uid);
  end loop;

  for v_item in
    select value
      from pg_catalog.jsonb_array_elements(p_rows)
  loop
    v_idx := v_idx + 1;
    v_row_errors := '[]'::jsonb;
    v_target_id := null;
    v_account := null;
    v_has_profile := false;
    v_current_year_accrued := 0;
    v_current_year_granted := 0;
    v_current_year_locked := 0;
    v_current_year_available := 0;
    v_delta_current_year := 0;
    v_reconciled_current_year_granted := 0;
    v_reconciled_current_year_available := 0;
    v_profile_row_version := 0;

    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('ROW_NOT_OBJECT');
      v_carry_units := 0;
      v_open_units := 0;
      v_sen_units := 0;
      v_note := null;
    else
      v_target_id_text := pg_catalog.btrim(coalesce(v_item->>'app_user_id', ''));
      begin
        v_target_id := v_target_id_text::uuid;
      exception
        when others then
          v_target_id := null;
      end;

      begin
        v_carry_units := coalesce((v_item->>'carry_over_units')::integer, 0);
        v_open_units := coalesce((v_item->>'opening_current_year_units')::integer, 0);
        v_sen_units := coalesce((v_item->>'seniority_units')::integer, 0);
      exception
        when others then
          v_carry_units := -1;
          v_open_units := -1;
          v_sen_units := -1;
      end;

      v_note := nullif(pg_catalog.btrim(coalesce(v_item->>'note', '')), '');
      v_delta_current_year := greatest(coalesce(v_open_units, 0), 0);
      v_reconciled_current_year_granted := greatest(coalesce(v_open_units, 0), 0);
      v_reconciled_current_year_available := greatest(coalesce(v_open_units, 0), 0);

      if v_target_id is null then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('INVALID_APP_USER_ID');
      else
        if v_target_id = any(v_seen_ids) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('DUPLICATE_APP_USER_IN_BATCH');
        else
          v_seen_ids := pg_catalog.array_append(v_seen_ids, v_target_id);
        end if;

        v_account := public.leave_management__internal_account_summary(v_target_id);
        if v_account is null then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('APP_USER_NOT_FOUND');
        end if;

        select p.*
          into v_profile
          from public.leave_employee_profiles p
         where p.app_user_id = v_target_id;
        v_has_profile := found;

        if v_account is not null and (not v_has_profile or v_profile.employment_status <> 'OFFICIAL') then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('EMPLOYEE_NOT_OFFICIAL');
        elsif v_account is not null and v_has_profile and v_profile.employment_status = 'OFFICIAL' then
          perform public.leave_management__internal_sync_employee_accruals(v_target_id, v_today);

          select p.*
            into v_profile
            from public.leave_employee_profiles p
           where p.app_user_id = v_target_id;

          v_profile_row_version := coalesce(v_profile.row_version, 1);

          select
            coalesce(
              sum(coalesce((l.metadata->>'initial_granted_units')::integer, l.granted_units))
                filter (where l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP')),
              0
            )::integer,
            coalesce(sum(l.granted_units), 0)::integer,
            coalesce(sum(l.reserved_units + l.consumed_units + l.expired_units), 0)::integer,
            coalesce(sum(greatest(l.granted_units - l.reserved_units - l.consumed_units - l.expired_units, 0)), 0)::integer
          into
            v_current_year_accrued,
            v_current_year_granted,
            v_current_year_locked,
            v_current_year_available
          from public.leave_lots l
          where l.app_user_id = v_target_id
            and l.leave_year = v_year
            and l.lot_kind in ('MONTHLY_ACCRUAL', 'PROBATION_CATCHUP', 'OPENING_CURRENT_YEAR', 'MANUAL_ADJUSTMENT');

          v_delta_current_year := greatest(coalesce(v_open_units, 0), 0) - v_current_year_granted;
          v_reconciled_current_year_granted := greatest(coalesce(v_open_units, 0), 0);
          v_reconciled_current_year_available := greatest(
            greatest(coalesce(v_open_units, 0), 0) - v_current_year_locked,
            0
          );

          if v_open_units >= 0 and v_open_units < v_current_year_locked then
            v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('OPENING_TARGET_BELOW_LOCKED_BALANCE');
          end if;
        end if;
      end if;

      if v_carry_units < 0 or v_carry_units > 120
         or v_open_units < 0 or v_open_units > 120
         or v_sen_units < 0 or v_sen_units > 60 then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('UNITS_OUT_OF_RANGE');
      elsif (v_carry_units + v_open_units + v_sen_units) <= 0 and v_delta_current_year = 0 then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('ZERO_UNITS_ROW');
      end if;

      if v_carry_units > 0 and v_carry_over_expiry is null then
        v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('LEAVE_CARRY_OVER_EXPIRY_NOT_CONFIGURED');
        v_has_carry_expiry_error := true;
      end if;

      if v_target_id is not null and v_carry_units > 0 then
        if exists (
          select 1
            from public.leave_lots l
           where l.app_user_id = v_target_id
             and l.leave_year = v_year
             and l.lot_kind = 'CARRY_OVER'
        ) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('CARRY_OVER_LOT_ALREADY_EXISTS');
        end if;
      end if;

      if v_target_id is not null and v_sen_units > 0 then
        if exists (
          select 1
            from public.leave_lots l
           where l.app_user_id = v_target_id
             and l.leave_year = v_year
             and l.lot_kind = 'SENIORITY_GRANT'
        ) then
          v_row_errors := v_row_errors || pg_catalog.jsonb_build_array('SENIORITY_LOT_ALREADY_EXISTS');
        end if;
      end if;
    end if;

    if pg_catalog.jsonb_array_length(v_row_errors) > 0 then
      v_error_count := v_error_count + 1;
    else
      v_total_carry := v_total_carry + v_carry_units;
      v_total_open := v_total_open + v_open_units;
      v_total_sen := v_total_sen + v_sen_units;
    end if;

    v_rows_state := v_rows_state || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'row_index', v_idx,
        'app_user_id', v_target_id,
        'employment_status', case when v_has_profile then v_profile.employment_status else null end,
        'profile_row_version', v_profile_row_version,
        'current_year_accrued_units', v_current_year_accrued,
        'current_year_granted_units', v_current_year_granted,
        'current_year_locked_units', v_current_year_locked,
        'current_year_available_units', v_current_year_available,
        'delta_current_year_units', v_delta_current_year
      )
    );

    v_preview_rows := v_preview_rows || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'row_index', v_idx,
        'app_user_id', v_target_id,
        'account', v_account,
        'as_of_date', v_today,
        'carry_over_units', greatest(coalesce(v_carry_units, 0), 0),
        'opening_current_year_units', greatest(coalesce(v_open_units, 0), 0),
        'target_current_year_units', greatest(coalesce(v_open_units, 0), 0),
        'current_year_accrued_units', v_current_year_accrued,
        'current_year_granted_units', v_current_year_granted,
        'current_year_locked_units', v_current_year_locked,
        'current_year_available_units', v_current_year_available,
        'delta_current_year_units', v_delta_current_year,
        'reconciled_current_year_granted_units', v_reconciled_current_year_granted,
        'reconciled_current_year_available_units', v_reconciled_current_year_available,
        'profile_row_version', v_profile_row_version,
        'seniority_units', greatest(coalesce(v_sen_units, 0), 0),
        'note', v_note,
        'valid', (pg_catalog.jsonb_array_length(v_row_errors) = 0),
        'errors', v_row_errors
      )
    );
  end loop;

  if v_error_count = 0 and v_idx > 0 then
    insert into public.leave_opening_preview_snapshots (
      actor_app_user_id,
      leave_year,
      rows_fingerprint,
      as_of_date,
      carry_over_expires_after_date,
      rows_state,
      created_at,
      consumed_at
    )
    values (
      p_actor_app_user_id,
      v_year,
      v_rows_fingerprint,
      v_today,
      v_carry_over_expiry,
      v_rows_state,
      pg_catalog.timezone('utc', pg_catalog.now()),
      null
    )
    on conflict (actor_app_user_id, leave_year, rows_fingerprint) do update
      set as_of_date = excluded.as_of_date,
          carry_over_expires_after_date = excluded.carry_over_expires_after_date,
          rows_state = excluded.rows_state,
          created_at = excluded.created_at,
          consumed_at = null;
  end if;

  return pg_catalog.jsonb_build_object(
    'leave_year', v_year,
    'as_of_date', v_today,
    'carry_over_expires_after_date', v_carry_over_expiry,
    'valid', (v_error_count = 0),
    'has_carry_over_expiry_error', v_has_carry_expiry_error,
    'row_count', v_idx,
    'error_row_count', v_error_count,
    'total_carry_over_units', v_total_carry,
    'total_opening_current_year_units', v_total_open,
    'total_seniority_units', v_total_sen,
    'rows_state', v_rows_state,
    'rows', v_preview_rows
  );
end;
$function$
;

-- leave_management_set_department_approver_admin(uuid,uuid,text,uuid,date,integer,text,text,text)
CREATE OR REPLACE FUNCTION public.leave_management_set_department_approver_admin(p_actor_auth_subject uuid, p_actor_app_user_id uuid, p_unit_kind text, p_approver_app_user_id uuid, p_valid_from date, p_expected_row_version integer, p_reason text, p_idempotency_key text, p_request_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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
  v_approver_is_shared boolean := false;
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

  v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;

  if v_unit not in ('MARKETING', 'IT', 'ACCOUNTING') then
    raise exception 'LEAVE_UNIT_KIND_INVALID'
      using errcode = '22023';
  end if;

  -- Serialize concurrent writes per unit_kind (including initial row creation) before idempotency check
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('leave_dept_approver_v1'),
    pg_catalog.hashtext(v_unit)
  );

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
$function$
;

-- leave_management_withdraw_request(uuid,uuid,uuid,integer,text,text,text)
CREATE OR REPLACE FUNCTION public.leave_management_withdraw_request(p_actor_auth_subject uuid, p_actor_app_user_id uuid, p_request_id uuid, p_expected_row_version integer, p_reason text, p_idempotency_key text, p_request_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date := public.leave_management__internal_business_date();
  v_year integer := pg_catalog.date_part('year', v_today)::integer;
  v_auth jsonb;
  v_reason text := null;
  v_idem_key text := pg_catalog.btrim(coalesce(p_idempotency_key, ''));
  v_fingerprint text := pg_catalog.btrim(coalesce(p_request_fingerprint, ''));
  v_existing_idem public.leave_idempotency_records%rowtype;
  v_req public.leave_requests%rowtype;
  v_response jsonb;
begin
  v_auth := public.leave_management__internal_resolve_authority(p_actor_auth_subject, p_actor_app_user_id);
  if v_idem_key = '' or pg_catalog.length(v_idem_key) > 200 or v_fingerprint = '' then
    raise exception 'LEAVE_IDEMPOTENCY_KEY_INVALID'
      using errcode = '22023';
  end if;

  if nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is not null then
    v_reason := public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID');
  end if;

  perform public.leave_management__internal_lock_employee(p_actor_app_user_id);

  select ir.*
    into v_existing_idem
    from public.leave_idempotency_records ir
   where ir.operation_code = 'WITHDRAW_REQUEST'
     and ir.actor_app_user_id = p_actor_app_user_id
     and ir.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'LEAVE_IDEMPOTENCY_FINGERPRINT_MISMATCH'
        using errcode = '22023';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select r.*
    into v_req
    from public.leave_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'LEAVE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_req.app_user_id <> p_actor_app_user_id then
    raise exception 'LEAVE_REQUEST_OWNERSHIP_FORBIDDEN'
      using errcode = '42501';
  end if;

  if p_expected_row_version is null or v_req.row_version <> p_expected_row_version then
    raise exception 'LEAVE_ROW_VERSION_CONFLICT'
      using ERRCODE = 'PT409';
  end if;

  if v_req.status <> 'PENDING' then
    raise exception 'LEAVE_INVALID_STATE_TRANSITION'
      using errcode = '22023';
  end if;

  update public.leave_request_days
     set is_active = false
   where request_id = v_req.request_id;

  update public.leave_requests
     set status = 'WITHDRAWN',
         cancelled_at = pg_catalog.timezone('utc', pg_catalog.now()),
         cancelled_by_app_user_id = p_actor_app_user_id,
         cancellation_reason = coalesce(v_reason, 'Người tạo tự rút đơn khi đang chờ duyệt'),
         row_version = row_version + 1,
         updated_at = pg_catalog.timezone('utc', pg_catalog.now())
   where request_id = v_req.request_id
   returning * into v_req;

  insert into public.leave_audit_events (
    event_type,
    actor_app_user_id,
    target_app_user_id,
    request_id,
    reason,
    payload
  )
  values (
    'REQUEST_WITHDRAWN',
    p_actor_app_user_id,
    p_actor_app_user_id,
    v_req.request_id,
    v_req.cancellation_reason,
    pg_catalog.jsonb_build_object(
      'row_version', v_req.row_version
    )
  );

  v_response := pg_catalog.jsonb_build_object(
    'replayed', false,
    'request', public.leave_management__internal_project_request(v_req),
    'balance', public.leave_management__internal_compute_balance_summary(p_actor_app_user_id, v_year, v_today)
  );

  insert into public.leave_idempotency_records (
    operation_code,
    actor_app_user_id,
    idempotency_key,
    request_fingerprint,
    response_payload
  )
  values (
    'WITHDRAW_REQUEST',
    p_actor_app_user_id,
    v_idem_key,
    v_fingerprint,
    v_response
  );

  return v_response;
end;
$function$
;

-- org_department__internal_guard_leave_profile()
CREATE OR REPLACE FUNCTION public.org_department__internal_guard_leave_profile()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_has_person_link boolean := false;
  v_org_unit_kind text := null;
begin
  if pg_catalog.current_setting('app.org_leave_profile_sync', true) = 'on' then
    return new;
  end if;

  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = new.app_user_id;

  if not found then
    return new;
  end if;

  select true,
         case
           when d.system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD') then d.system_key
           else 'UNCLASSIFIED'
         end
    into v_has_person_link, v_org_unit_kind
    from public.organization_account_person_links l
    left join public.organization_person_department_memberships m
      on m.person_id = l.person_id
     and m.ended_at is null
    left join public.organization_departments d
      on d.department_id = m.department_id
   where l.app_user_id = new.app_user_id
     and l.ended_at is null
   limit 1;

  if coalesce(v_has_person_link, false) then
    if new.unit_kind is distinct from coalesce(v_org_unit_kind, 'UNCLASSIFIED') then
      raise exception 'LEAVE_PROFILE_ORG_FIELD_MANAGED_BY_ORG_ADMIN'
        using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$
;

-- org_department__internal_guard_temporal_invariants()
CREATE OR REPLACE FUNCTION public.org_department__internal_guard_temporal_invariants()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_person_status text;
  v_dept_active boolean;
  v_has_member boolean := false;
  v_overlap boolean := false;
  v_new_range tstzrange := pg_catalog.tstzrange(new.started_at, coalesce(new.ended_at, 'infinity'::timestamptz), '[)');
begin
  if tg_table_name = 'organization_account_person_links' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_person_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'person_id'))
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_app_user_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'app_user_id'))
    );

    select exists (
      select 1
        from public.organization_account_person_links l
       where l.link_id <> (pg_catalog.to_jsonb(new)->>'link_id')::uuid
         and (
           l.app_user_id = (pg_catalog.to_jsonb(new)->>'app_user_id')::uuid
           or l.person_id = (pg_catalog.to_jsonb(new)->>'person_id')::uuid
         )
         and (l.ended_at is null or l.ended_at > l.started_at)
         and not pg_catalog.isempty(v_new_range)
         and pg_catalog.tstzrange(l.started_at, coalesce(l.ended_at, 'infinity'::timestamptz), '[)') && v_new_range
    ) into v_overlap;

    if v_overlap then
      raise exception 'ACCOUNT_PERSON_LINK_INTERVAL_OVERLAP'
        using errcode = '23P01';
    end if;
  elsif tg_table_name = 'organization_person_department_memberships' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_person_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'person_id'))
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_dept_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'department_id'))
    );

    if new.ended_at is null then
      select p.status into v_person_status
        from public.organization_persons p
       where p.person_id = (pg_catalog.to_jsonb(new)->>'person_id')::uuid;
      if v_person_status is distinct from 'ACTIVE' then
        raise exception 'PERSON_NOT_ACTIVE'
          using errcode = '23514';
      end if;

      select d.is_active into v_dept_active
        from public.organization_departments d
       where d.department_id = (pg_catalog.to_jsonb(new)->>'department_id')::uuid;
      if v_dept_active is distinct from true then
        raise exception 'DEPARTMENT_NOT_ACTIVE'
          using errcode = '23514';
      end if;
    end if;

    select exists (
      select 1
        from public.organization_person_department_memberships m
       where m.membership_id <> (pg_catalog.to_jsonb(new)->>'membership_id')::uuid
         and m.person_id = (pg_catalog.to_jsonb(new)->>'person_id')::uuid
         and (m.ended_at is null or m.ended_at > m.started_at)
         and not pg_catalog.isempty(v_new_range)
         and pg_catalog.tstzrange(m.started_at, coalesce(m.ended_at, 'infinity'::timestamptz), '[)') && v_new_range
    ) into v_overlap;

    if v_overlap then
      raise exception 'PERSON_DEPARTMENT_MEMBERSHIP_INTERVAL_OVERLAP'
        using errcode = '23P01';
    end if;
  elsif tg_table_name = 'organization_department_heads' then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_person_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'person_id'))
    );
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('org_department_dept_v1'),
      pg_catalog.hashtext((pg_catalog.to_jsonb(new)->>'department_id'))
    );

    if new.ended_at is null then
      select d.is_active into v_dept_active
        from public.organization_departments d
       where d.department_id = (pg_catalog.to_jsonb(new)->>'department_id')::uuid;
      if v_dept_active is distinct from true then
        raise exception 'DEPARTMENT_NOT_ACTIVE'
          using errcode = '23514';
      end if;

      select p.status into v_person_status
        from public.organization_persons p
       where p.person_id = (pg_catalog.to_jsonb(new)->>'person_id')::uuid;
      if v_person_status is distinct from 'ACTIVE' then
        raise exception 'PERSON_NOT_ACTIVE'
          using errcode = '23514';
      end if;

      select exists (
        select 1
          from public.organization_person_department_memberships m
         where m.person_id = (pg_catalog.to_jsonb(new)->>'person_id')::uuid
           and m.department_id = (pg_catalog.to_jsonb(new)->>'department_id')::uuid
           and m.ended_at is null
      ) into v_has_member;
      if not coalesce(v_has_member, false) then
        raise exception 'PERSON_NOT_ACTIVE_MEMBER_OF_DEPARTMENT'
          using errcode = '23514';
      end if;
    end if;

    select exists (
      select 1
        from public.organization_department_heads h
       where h.head_assignment_id <> (pg_catalog.to_jsonb(new)->>'head_assignment_id')::uuid
         and h.department_id = (pg_catalog.to_jsonb(new)->>'department_id')::uuid
         and (h.ended_at is null or h.ended_at > h.started_at)
         and not pg_catalog.isempty(v_new_range)
         and pg_catalog.tstzrange(h.started_at, coalesce(h.ended_at, 'infinity'::timestamptz), '[)') && v_new_range
    ) into v_overlap;

    if v_overlap then
      raise exception 'DEPARTMENT_HEAD_INTERVAL_OVERLAP'
        using errcode = '23P01';
    end if;
  end if;

  return new;
end;
$function$
;

-- org_department__internal_has_active_membership(uuid,text,date)
CREATE OR REPLACE FUNCTION public.org_department__internal_has_active_membership(p_app_user_id uuid, p_system_key text, p_as_of date DEFAULT direct_entry_authorization_date())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select p_app_user_id is not null
     and p_system_key is not null
     and p_as_of is not null
     and exists (
       select 1
         from public.direct_entry_app_users u
        where u.app_user_id = p_app_user_id
          and u.enabled = true
          and case
            when exists (
              select 1
                from public.organization_account_person_links l_any
               where l_any.app_user_id = u.app_user_id
                 and l_any.ended_at is null
            ) then exists (
              select 1
                from public.organization_account_person_links l
                join public.organization_persons p
                  on p.person_id = l.person_id
                 and p.status = 'ACTIVE'
                join public.organization_person_department_memberships pm
                  on pm.person_id = p.person_id
                 and pm.ended_at is null
                 and pm.started_at <= pg_catalog.clock_timestamp()
                join public.organization_departments d
                  on d.department_id = pm.department_id
                 and d.system_key = p_system_key
                 and d.is_active = true
               where l.app_user_id = u.app_user_id
                 and l.ended_at is null
            )
            else exists (
              select 1
                from public.organization_department_memberships m
                join public.organization_departments d
                  on d.department_id = m.department_id
                 and d.system_key = p_system_key
                 and d.is_active = true
               where m.app_user_id = u.app_user_id
                 and m.valid_from <= p_as_of
                 and (m.valid_to is null or p_as_of < m.valid_to)
                 and (m.valid_to is null or m.valid_to > m.valid_from)
            )
          end
     );
$function$
;

-- org_department__internal_sync_accounting_projection(uuid,uuid,text,timestamp with time zone)
CREATE OR REPLACE FUNCTION public.org_department__internal_sync_accounting_projection(p_app_user_id uuid, p_actor_user_id uuid, p_reason text, p_now timestamp with time zone)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_acct_dept_id uuid;
  v_acct_dept_active boolean := false;
  v_user public.direct_entry_app_users%rowtype;
  v_should_be_member boolean := false;
  v_open_legacy public.organization_department_memberships%rowtype;
  v_eff_now timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  v_today date := (v_eff_now at time zone 'Asia/Ho_Chi_Minh')::date;
  v_next_ver integer;
  v_end_date date;
  v_actor uuid := coalesce(p_actor_user_id, p_app_user_id);
  v_prev_cancel text := pg_catalog.current_setting('org_department.membership_cancel_marker', true);
begin
  if p_app_user_id is null then
    return;
  end if;

  select d.department_id, d.is_active
    into v_acct_dept_id, v_acct_dept_active
    from public.organization_departments d
   where d.system_key = 'ACCOUNTING';

  if v_acct_dept_id is null then
    return;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found then
    return;
  end if;

  if coalesce(v_acct_dept_active, false) then
    select exists (
      select 1
        from public.organization_account_person_links l
        join public.organization_persons p
          on p.person_id = l.person_id
         and p.status = 'ACTIVE'
        join public.organization_person_department_memberships m
          on m.person_id = p.person_id
         and m.department_id = v_acct_dept_id
         and m.ended_at is null
       where l.app_user_id = p_app_user_id
         and l.ended_at is null
    ) into v_should_be_member;
  end if;

  select lm.*
    into v_open_legacy
    from public.organization_department_memberships lm
   where lm.department_id = v_acct_dept_id
     and lm.app_user_id = p_app_user_id
     and lm.valid_to is null
   for update;

  if coalesce(v_should_be_member, false) and not found then
    select coalesce(max(lm2.version), 0) + 1
      into v_next_ver
      from public.organization_department_memberships lm2
     where lm2.department_id = v_acct_dept_id
       and lm2.app_user_id = p_app_user_id;

    insert into public.organization_department_memberships (
      department_id,
      app_user_id,
      valid_from,
      valid_to,
      version,
      granted_by_user_id,
      grant_reason,
      created_at,
      updated_at
    )
    values (
      v_acct_dept_id,
      p_app_user_id,
      v_today,
      null,
      v_next_ver,
      v_actor,
      coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'Synced from organization person ACCOUNTING membership'),
      v_eff_now,
      v_eff_now
    );
  elsif not coalesce(v_should_be_member, false) and found then
    if v_today <= v_open_legacy.valid_from then
      v_end_date := v_open_legacy.valid_from;
      perform pg_catalog.set_config('org_department.membership_cancel_marker', 'on', true);
    else
      v_end_date := v_today;
    end if;

    select coalesce(max(lm2.version), v_open_legacy.version) + 1
      into v_next_ver
      from public.organization_department_memberships lm2
     where lm2.department_id = v_acct_dept_id
       and lm2.app_user_id = p_app_user_id;

    update public.organization_department_memberships
       set valid_to = v_end_date,
           version = v_next_ver,
           revoked_by_user_id = v_actor,
           revoke_reason = coalesce(nullif(pg_catalog.btrim(p_reason), ''), 'Synced end from organization person ACCOUNTING membership'),
           revoked_at = v_eff_now,
           updated_at = v_eff_now
     where membership_id = v_open_legacy.membership_id;

    perform pg_catalog.set_config('org_department.membership_cancel_marker', coalesce(v_prev_cancel, ''), true);
  end if;
exception
  when others then
    perform pg_catalog.set_config('org_department.membership_cancel_marker', coalesce(v_prev_cancel, ''), true);
    raise;
end;
$function$
;

-- org_department__internal_sync_leave_profile_from_org(uuid,uuid,timestamp with time zone,boolean)
CREATE OR REPLACE FUNCTION public.org_department__internal_sync_leave_profile_from_org(p_app_user_id uuid, p_actor_user_id uuid DEFAULT NULL::uuid, p_now timestamp with time zone DEFAULT NULL::timestamp with time zone, p_reset_when_unlinked boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_unit_kind text := 'UNCLASSIFIED';
  v_has_person_link boolean := false;
  v_has_legacy_acct boolean := false;
  v_prof public.leave_employee_profiles%rowtype;
  v_prev_sync text := pg_catalog.current_setting('app.org_leave_profile_sync', true);
  v_eff_now timestamptz := coalesce(p_now, pg_catalog.clock_timestamp());
  v_actor uuid := coalesce(p_actor_user_id, p_app_user_id);
begin
  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found then
    return;
  end if;

  select true,
         case
           when d.system_key in ('RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD') then d.system_key
           else 'UNCLASSIFIED'
         end
    into v_has_person_link, v_unit_kind
    from public.organization_account_person_links l
    join public.organization_persons p
      on p.person_id = l.person_id
    left join public.organization_person_department_memberships m
      on m.person_id = p.person_id
     and m.ended_at is null
    left join public.organization_departments d
      on d.department_id = m.department_id
   where l.app_user_id = p_app_user_id
     and l.ended_at is null
   limit 1;

  if not coalesce(v_has_person_link, false) then
    select exists (
      select 1
        from public.organization_department_memberships lm
        join public.organization_departments d
          on d.department_id = lm.department_id
         and d.system_key = 'ACCOUNTING'
       where lm.app_user_id = p_app_user_id
         and lm.valid_to is null
    ) into v_has_legacy_acct;

    if coalesce(v_has_legacy_acct, false) then
      v_unit_kind := 'ACCOUNTING';
    end if;
  end if;

  perform pg_catalog.set_config('app.org_leave_profile_sync', 'on', true);

  select lp.* into v_prof
    from public.leave_employee_profiles lp
   where lp.app_user_id = p_app_user_id
   for update;

  if coalesce(v_has_person_link, false) or coalesce(v_has_legacy_acct, false) then
    if found and v_prof.unit_kind is distinct from coalesce(v_unit_kind, 'UNCLASSIFIED') then
      update public.leave_employee_profiles
         set unit_kind = coalesce(v_unit_kind, 'UNCLASSIFIED'),
             row_version = v_prof.row_version + 1,
             updated_at = v_eff_now,
             updated_by_app_user_id = v_actor
       where app_user_id = p_app_user_id;
    end if;
  elsif p_reset_when_unlinked then
    if found and v_prof.unit_kind is distinct from 'UNCLASSIFIED' then
      update public.leave_employee_profiles
         set unit_kind = 'UNCLASSIFIED',
             row_version = v_prof.row_version + 1,
             updated_at = v_eff_now,
             updated_by_app_user_id = v_actor
       where app_user_id = p_app_user_id;
    end if;
  end if;

  perform pg_catalog.set_config('app.org_leave_profile_sync', coalesce(v_prev_sync, ''), true);
exception
  when others then
    perform pg_catalog.set_config('app.org_leave_profile_sync', coalesce(v_prev_sync, ''), true);
    raise;
end;
$function$
;

-- org_department_assign_accounting_member(uuid,uuid,uuid,integer,date,text,uuid,text)
CREATE OR REPLACE FUNCTION public.org_department_assign_accounting_member(p_auth_subject uuid, p_app_user_id uuid, p_target_app_user_id uuid, p_expected_pair_version integer, p_effective_from date, p_reason text, p_idempotency_key uuid, p_request_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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

  -- Lock order (§4.2): person -> departments -> membership key -> account -> legacy memberships
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

  perform public.org_department__internal_lock_app_user(p_target_app_user_id);

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('org_department_membership_v1'),
    pg_catalog.hashtext(v_dept.department_id::text || ':' || p_target_app_user_id::text)
  );

  select u.*
    into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id
   for update;

  if exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = p_target_app_user_id
       and l.ended_at is null
       and l.person_id is distinct from v_linked_person_id
  ) then
    raise exception 'DEPARTMENT_MEMBERSHIP_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

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

  v_now := pg_catalog.clock_timestamp();

  -- Sync WP3 person_department_memberships if account is linked to a person
  if v_person.person_id is not null then
    if v_person.status <> 'ACTIVE' then
      raise exception 'PERSON_INACTIVE'
        using errcode = 'PT409';
    end if;

    select m.*
      into v_curr_pm
      from public.organization_person_department_memberships m
     where m.person_id = v_person.person_id
       and m.ended_at is null
     for update;

    if found and v_curr_pm.department_id <> v_dept.department_id then
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
$function$
;

-- org_department_create_person_admin(uuid,uuid,text,text,date,uuid,uuid,integer,uuid,text,uuid,text)
CREATE OR REPLACE FUNCTION public.org_department_create_person_admin(p_auth_subject uuid, p_app_user_id uuid, p_employee_code text, p_full_name text, p_joined_on date DEFAULT NULL::date, p_initial_department_id uuid DEFAULT NULL::uuid, p_account_ref uuid DEFAULT NULL::uuid, p_expected_account_version integer DEFAULT NULL::integer, p_recruiter_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid, p_request_fingerprint text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_action text := 'PERSON_CREATED';
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

  -- Lock order (§4.2): persons (new person created below) -> departments -> direct_entry_app_users -> recruiters
  if p_initial_department_id is not null then
    perform public.org_department__internal_lock_department(p_initial_department_id);
    select d.* into v_dept
      from public.organization_departments d
     where d.department_id = p_initial_department_id
     for update;
    if not found then
      raise exception 'DEPARTMENT_NOT_FOUND' using errcode = 'P0002';
    end if;
    if not v_dept.is_active then
      raise exception 'DEPARTMENT_INACTIVE' using errcode = 'PT409';
    end if;
  end if;

  if p_account_ref is not null then
    perform public.org_department__internal_lock_app_user(p_account_ref);
    select u.* into v_account
      from public.direct_entry_app_users u
     where u.app_user_id = p_account_ref
     for update;
    if not found then
      raise exception 'TARGET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
    end if;
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
     where r.recruiter_id = v_resolved_recruiter_id
     for update;
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
$function$
;

-- org_department_link_account_person_admin(uuid,uuid,uuid,uuid,integer,integer,uuid,text,uuid,text)
CREATE OR REPLACE FUNCTION public.org_department_link_account_person_admin(p_auth_subject uuid, p_app_user_id uuid, p_target_app_user_id uuid, p_person_id uuid, p_expected_account_version integer, p_expected_person_version integer, p_confirmed_recruiter_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid, p_request_fingerprint text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_action text := 'ACCOUNT_PERSON_LINKED';
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

  -- Lock order (§4.2): advisory person lock -> person -> account -> recruiter
  perform public.org_department__internal_lock_person(p_person_id);

  select p.* into v_person
    from public.organization_persons p
   where p.person_id = p_person_id
   for update;

  if not found then
    raise exception 'PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform public.org_department__internal_lock_app_user(p_target_app_user_id);

  select u.* into v_account
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id
   for update;

  if not found then
    raise exception 'TARGET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_account.version <> p_expected_account_version
     or v_person.version <> p_expected_person_version then
    raise exception 'VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_person.status <> 'ACTIVE' then
    raise exception 'PERSON_INACTIVE' using errcode = 'PT409';
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
     where r.recruiter_id = v_effective_recruiter_id
     for update;

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
$function$
;

-- salary_advance__internal_is_effective_project_manager(uuid,text,date)
CREATE OR REPLACE FUNCTION public.salary_advance__internal_is_effective_project_manager(p_app_user_id uuid, p_project_id text, p_as_of date DEFAULT direct_entry_authorization_date())
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select p_app_user_id is not null
     and p_project_id is not null
     and p_as_of is not null
     and exists (
       select 1
         from public.direct_entry_project_manager_assignments a
         join public.direct_entry_app_user_recruiter_links l
           on l.recruiter_id = a.manager_recruiter_id
          and l.app_user_id = p_app_user_id
          and l.verified = true
          and l.is_current = true
          and not l.suspended_by_account_disable
          and l.valid_from <= p_as_of
          and (l.valid_to is null or (l.valid_to > l.valid_from and p_as_of < l.valid_to))
         join public.direct_entry_app_users u
           on u.app_user_id = l.app_user_id
          and u.enabled = true
          and u.auth_subject is not null
         join public.recruiters r
           on r.recruiter_id = a.manager_recruiter_id
          and r.active = true
        where a.project_id = p_project_id
          and a.is_current = true
          and a.revoked_at is null
          and a.valid_from <= p_as_of
          and (a.valid_to is null or (a.valid_to > a.valid_from and p_as_of < a.valid_to))
          and (
            select count(*)::int
              from public.direct_entry_app_user_recruiter_links current_link
             where current_link.recruiter_id = a.manager_recruiter_id
               and current_link.verified = true
               and current_link.is_current = true
          ) = 1
          and (
            select count(*)::int
              from public.direct_entry_app_user_recruiter_links current_link
              join public.direct_entry_app_users linked_user
                on linked_user.app_user_id = current_link.app_user_id
             where current_link.recruiter_id = a.manager_recruiter_id
               and current_link.verified = true
               and current_link.is_current = true
               and linked_user.enabled = true
               and linked_user.auth_subject is not null
          ) = 1
     );
$function$
;

-- salary_advance__internal_resolve_authority(uuid,uuid)
CREATE OR REPLACE FUNCTION public.salary_advance__internal_resolve_authority(p_auth_subject uuid, p_app_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date;
  v_is_full_admin boolean := false;
  v_is_bod boolean := false;
  v_is_supervisory_viewer boolean := false;
  v_accounting_member boolean := false;
  v_managed_project_ids text[] := array[]::text[];
  v_accountant_project_ids text[] := array[]::text[];
  v_is_project_manager boolean := false;
  v_is_project_accountant boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  -- Canonical paired Full Admin (`entry_admin` + `recruiter_master_manage` + `team_master_manage` at `ALL`).
  v_is_full_admin := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);

  -- Canonical paired BoD (`entry_privileged_edit` at `ALL` OR (`report_analytics_view` + `report_view` at `ALL`)).
  -- Never infer BoD from `vendor_finance_*`, `vendor_finance_global_roles`, or cross-source `HR_OPERATOR + TEAM_LEADER`.
  v_is_bod := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
    or (
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_analytics_view', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_view', 'ALL', null)
    );

  v_is_supervisory_viewer := v_is_full_admin or v_is_bod;

  -- Active assigned Project Manager projects (canonical WP5B-1 R2 predicate).
    select coalesce(pg_catalog.array_agg(p.project_id order by p.project_id), array[]::text[])
      into v_managed_project_ids
      from public.direct_entry_projects p
     where public.salary_advance__internal_is_effective_project_manager(p_app_user_id, p.project_id, v_today);

    -- Active assigned Project Accountant projects (requires canonical active ACCOUNTING department membership).
    v_accounting_member := public.org_department__internal_has_active_membership(
      p_app_user_id,
      'ACCOUNTING',
      v_today
    );

    if v_accounting_member then
      select coalesce(pg_catalog.array_agg(distinct pa.project_id order by pa.project_id), array[]::text[])
        into v_accountant_project_ids
        from public.vendor_finance_project_accountants pa
        join public.direct_entry_projects p
          on p.project_id = pa.project_id
       where pa.accountant_user_id = p_app_user_id
         and pa.valid_from <= v_today
         and (pa.valid_to is null or pa.valid_to > v_today)
         and (pa.valid_to is null or pa.valid_to > pa.valid_from);
    end if;

  v_is_project_manager := coalesce(pg_catalog.array_length(v_managed_project_ids, 1), 0) > 0;
  v_is_project_accountant := coalesce(pg_catalog.array_length(v_accountant_project_ids, 1), 0) > 0;

  return pg_catalog.jsonb_build_object(
    'allowed', (v_is_supervisory_viewer or v_is_project_manager or v_is_project_accountant),
    'is_project_manager', v_is_project_manager,
    'is_project_accountant', v_is_project_accountant,
    'is_supervisory_viewer', v_is_supervisory_viewer,
    'is_full_admin', v_is_full_admin,
    'is_bod', v_is_bod,
    'managed_project_ids', pg_catalog.to_jsonb(v_managed_project_ids),
    'accountant_project_ids', pg_catalog.to_jsonb(v_accountant_project_ids),
    'authorization_date', v_today::text
  );
end;
$function$
;

-- vendor_finance__internal_resolve_active_project_accountant(text,date)
CREATE OR REPLACE FUNCTION public.vendor_finance__internal_resolve_active_project_accountant(p_project_id text, p_as_of date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_project public.direct_entry_projects%rowtype;
  v_assign public.vendor_finance_project_accountants%rowtype;
  v_user public.direct_entry_app_users%rowtype;
  v_acct_name text;
  v_acct_in_dept boolean := false;
begin
  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  select p.*
    into v_project
    from public.direct_entry_projects p
   where p.project_id = p_project_id;

  if not found then
    raise exception 'VENDOR_FINANCE_PROJECT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select pa.*
    into v_assign
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_project.project_id
     and pa.valid_from <= p_as_of
     and (pa.valid_to is null or pa.valid_to > p_as_of)
     and (pa.valid_to is null or pa.valid_to > pa.valid_from)
   order by pa.valid_from desc, pa.version desc
   limit 1;

  if not found then
    return pg_catalog.jsonb_build_object(
      'project_id', v_project.project_id,
      'project_display_name', v_project.display_name,
      'project_active', v_project.active,
      'has_assignment', false,
      'accountant_active', false,
      'assignment_id', null,
      'accountant_user_id', null,
      'accountant_display_name', null
    );
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = v_assign.accountant_user_id;

  v_acct_in_dept := coalesce(v_user.enabled, false)
    and public.org_department__internal_has_active_membership(
      v_assign.accountant_user_id,
      'ACCOUNTING',
      p_as_of
    );

  v_acct_name := public.vendor_finance__internal_actor_display_name(v_assign.accountant_user_id);

  return pg_catalog.jsonb_build_object(
    'project_id', v_project.project_id,
    'project_display_name', v_project.display_name,
    'project_active', v_project.active,
    'has_assignment', true,
    'accountant_active', v_acct_in_dept,
    'assignment_id', v_assign.assignment_id,
    'accountant_user_id', v_assign.accountant_user_id,
    'accountant_display_name', v_acct_name
  );
end;
$function$
;

-- vendor_finance__internal_resolve_authority(uuid,uuid)
CREATE OR REPLACE FUNCTION public.vendor_finance__internal_resolve_authority(p_auth_subject uuid, p_app_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date;
  v_full_admin boolean := false;
  v_direct_record boolean := false;
  v_direct_view boolean := false;
  v_accounting_member boolean := false;
  v_direct_global_role text := null;
  v_group_global_role text := null;
  v_global_role text := null;
  v_visibility_scope text := 'NONE';
  v_record_scope text := 'NONE';
  v_reconcile_scope text := 'NONE';
  v_authority_source text := 'none';
  v_assigned_project_count integer := 0;
  v_can_view_shared_advance boolean := false;
  v_can_fund_vendor_advance boolean := false;
  v_can_record_vendor_refund boolean := false;
  v_can_apply_vendor_advance boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  v_full_admin := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);

  v_direct_record := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'vendor_finance_record', 'ALL', null);
  v_direct_view := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'vendor_finance_view', 'ALL', null);

  v_accounting_member := public.org_department__internal_has_active_membership(
      p_app_user_id,
      'ACCOUNTING',
      v_today
    );

  -- D4 cutover: Vendor Finance global module role resolves EXCLUSIVELY from active permission groups
  -- (historical vendor_finance_global_roles rows stay preserved for audit; PROJECT_ACCOUNTANT stays per-project).
  v_group_global_role := public.direct_entry_authz__internal_group_vfin_global_role(p_app_user_id);
  v_global_role := v_group_global_role;

  if v_accounting_member then
    select count(*)::integer
      into v_assigned_project_count
      from public.vendor_finance_project_accountants pa
      join public.direct_entry_projects p
        on p.project_id = pa.project_id
       and p.active = true
     where pa.accountant_user_id = p_app_user_id
       and pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from);
  end if;

  if v_full_admin or v_direct_record or v_direct_view or v_global_role is not null then
    v_visibility_scope := 'ALL';
  elsif v_accounting_member then
    v_visibility_scope := 'PROJECT_SCOPED';
  else
    v_visibility_scope := 'NONE';
  end if;

  if v_full_admin or v_direct_record or v_global_role = 'CASH_HOLDER_RECORD_BEHALF' then
    v_record_scope := 'ALL';
  elsif v_accounting_member then
    v_record_scope := 'ASSIGNED_PROJECTS';
  else
    v_record_scope := 'NONE';
  end if;

  if v_full_admin
     or v_direct_record
     or v_global_role in ('CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF', 'GLOBAL_RECONCILER') then
    v_reconcile_scope := 'ALL';
  elsif v_accounting_member then
    v_reconcile_scope := 'ASSIGNED_PROJECTS';
  else
    v_reconcile_scope := 'NONE';
  end if;

  if v_full_admin then
    v_authority_source := 'full_admin';
  elsif v_global_role = 'CASH_HOLDER_RECORD_BEHALF' then
    v_authority_source := 'cash_holder_record_behalf';
  elsif v_direct_record then
    v_authority_source := 'direct_grant_record';
  elsif v_global_role = 'CASH_HOLDER' then
    v_authority_source := 'cash_holder';
  elsif v_global_role = 'GLOBAL_RECONCILER' then
    v_authority_source := 'global_reconciler';
  elsif v_global_role = 'GLOBAL_VIEWER' or v_direct_view then
    v_authority_source := 'direct_grant_view';
  elsif v_accounting_member then
    v_authority_source := 'accounting_department';
  else
    v_authority_source := 'none';
  end if;

  v_can_view_shared_advance := coalesce(
    v_visibility_scope = 'ALL'
    or (v_visibility_scope = 'PROJECT_SCOPED' and v_assigned_project_count > 0),
    false
  );

  v_can_fund_vendor_advance := coalesce(
    v_full_admin
    or v_direct_record
    or v_global_role in ('CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF'),
    false
  );
  v_can_record_vendor_refund := v_can_fund_vendor_advance;

  v_can_apply_vendor_advance := coalesce(
    v_record_scope = 'ALL'
    or (v_record_scope = 'ASSIGNED_PROJECTS' and v_assigned_project_count > 0),
    false
  );

  return pg_catalog.jsonb_build_object(
    'allowed', (v_visibility_scope <> 'NONE'),
    'authority_source', v_authority_source,
    'visibility_scope', v_visibility_scope,
    'record_scope', v_record_scope,
    'reconcile_scope', v_reconcile_scope,
    'global_role_code', v_global_role,
    'can_view', (v_visibility_scope <> 'NONE'),
    'can_record', (v_record_scope <> 'NONE'),
    'can_reconcile', (v_reconcile_scope <> 'NONE'),
    'can_manage_project_assignments', v_full_admin,
    'can_view_shared_advance', v_can_view_shared_advance,
    'can_fund_vendor_advance', v_can_fund_vendor_advance,
    'can_record_vendor_refund', v_can_record_vendor_refund,
    'can_apply_vendor_advance', v_can_apply_vendor_advance,
    'active_assigned_project_count', v_assigned_project_count,
    'authorization_date', v_today::text
  );
end;
$function$
;

-- vendor_finance_assign_project_accountant_admin(uuid,uuid,text,uuid,integer,date,text,uuid,text)
CREATE OR REPLACE FUNCTION public.vendor_finance_assign_project_accountant_admin(p_auth_subject uuid, p_app_user_id uuid, p_project_id text, p_accountant_user_id uuid, p_expected_version integer, p_valid_from date, p_reason text, p_idempotency_key uuid, p_request_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_valid_from date;
  v_reason text;
  v_max_version integer;
  v_inserted public.vendor_finance_project_accountants%rowtype;
  v_base_payload jsonb;
begin
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');
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

  -- Canonical DAG [2]+[3]: projects FOR SHARE -> vfin_project adv lock
  v_project := public.vendor_finance__internal_lock_project(p_project_id);

  -- Canonical DAG [5]: lock actor & target in ascending app_user_id order FOR SHARE
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id in (p_app_user_id, p_accountant_user_id)
   order by u.app_user_id asc
   for share;

  -- Re-assert caller admin authority & target eligibility under lock
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');

  if not v_project.active then
    raise exception 'VENDOR_FINANCE_PROJECT_INACTIVE'
      using errcode = '42200';
  end if;

  select u.*
    into v_target_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_accountant_user_id;

  if not found
     or not v_target_user.enabled
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
$function$
;

-- vendor_finance_get_monthly_report(uuid,uuid,text,text,uuid,text,text)
CREATE OR REPLACE FUNCTION public.vendor_finance_get_monthly_report(p_auth_subject uuid, p_app_user_id uuid, p_month text, p_project_id text DEFAULT NULL::text, p_accountant_user_id uuid DEFAULT NULL::uuid, p_vendor_id text DEFAULT NULL::text, p_contract_type text DEFAULT 'all'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_auth jsonb;
  v_vis text;
  v_today date;
  v_month_start date;
  v_month_end date;
  v_totals jsonb;
  v_project_summaries jsonb;
  v_rows jsonb;
  v_legacy_rows jsonb := '[]'::jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');
  v_vis := v_auth->>'visibility_scope';
  v_today := (v_auth->>'authorization_date')::date;

  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  if p_contract_type is null or p_contract_type not in ('all', 'SEASONAL', 'OFFICIAL', 'UNCLASSIFIED') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  v_month_start := pg_catalog.to_date(p_month || '-01', 'YYYY-MM-DD');
  if pg_catalog.date_part('year', v_month_start)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;
  v_month_end := (v_month_start + interval '1 month')::date;

  if p_project_id is not null and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if p_vendor_id is not null and (
    p_vendor_id = '__system_vendor__'
    or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'
  ) then
    raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
      using errcode = '22023';
  end if;

  if v_vis = 'PROJECT_SCOPED' then
    if p_accountant_user_id is not null and p_accountant_user_id <> p_app_user_id then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;

    if p_project_id is not null and not exists (
      select 1
        from public.vendor_finance_project_accountants pa
       where pa.project_id = p_project_id
         and pa.accountant_user_id = p_app_user_id
         and pa.valid_from <= v_today
         and (pa.valid_to is null or pa.valid_to > v_today)
         and (pa.valid_to is null or pa.valid_to > pa.valid_from)
         and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
      union all
      select 1
        from public.vendor_finance_entries e
       where e.ledger_scope = 'PROJECT_ACCOUNTANT'
         and e.project_id = p_project_id
         and e.responsible_accountant_user_id = p_app_user_id
      union all
      select 1
        from public.vendor_finance_reconciliations r
       where r.ledger_scope = 'PROJECT_ACCOUNTANT'
         and r.project_id = p_project_id
         and r.responsible_accountant_user_id = p_app_user_id
    ) then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
  end if;

  with active_assignments as (
    select pa.project_id,
           pa.accountant_user_id
      from public.vendor_finance_project_accountants pa
      join public.direct_entry_app_users u
        on u.app_user_id = pa.accountant_user_id
       and u.enabled = true
     where pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from)
       and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
  ),
  candidate_books as (
    select distinct
           src.project_id,
           src.accountant_user_id,
           src.vendor_id,
           src.contract_type
      from (
        select e.project_id,
               e.responsible_accountant_user_id as accountant_user_id,
               e.vendor_id,
               e.contract_type
          from public.vendor_finance_entries e
         where e.ledger_scope = 'PROJECT_ACCOUNTANT'
        union
        select r.project_id,
               r.responsible_accountant_user_id as accountant_user_id,
               r.vendor_id,
               r.contract_type
          from public.vendor_finance_reconciliations r
         where r.ledger_scope = 'PROJECT_ACCOUNTANT'
      ) src
     where (v_vis = 'ALL' or src.accountant_user_id = p_app_user_id)
       and (p_project_id is null or src.project_id = p_project_id)
       and (p_accountant_user_id is null or src.accountant_user_id = p_accountant_user_id)
       and (p_vendor_id is null or src.vendor_id = p_vendor_id)
       and (p_contract_type = 'all' or src.contract_type = p_contract_type)
  ),
  entry_flags as (
    select e.*,
           exists (
             select 1
               from public.vendor_finance_entries rev
              where rev.reverses_entry_id = e.entry_id
           ) as is_reversed
      from public.vendor_finance_entries e
     where e.ledger_scope = 'PROJECT_ACCOUNTANT'
       and (v_vis = 'ALL' or e.responsible_accountant_user_id = p_app_user_id)
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_accountant_user_id is null or e.responsible_accountant_user_id = p_accountant_user_id)
       and (p_vendor_id is null or e.vendor_id = p_vendor_id)
       and (p_contract_type = 'all' or e.contract_type = p_contract_type)
  ),
  book_metrics as (
    select cb.project_id,
           p.display_name as project_display_name,
           p.active as project_active,
           cb.accountant_user_id,
           public.vendor_finance__internal_actor_display_name(cb.accountant_user_id) as accountant_display_name,
           coalesce(aa.accountant_user_id = cb.accountant_user_id, false) as is_currently_assigned,
           cb.vendor_id,
           v.display_name as vendor_display_name,
           v.active as vendor_active,
           cb.contract_type,
           coalesce(sum(ef.balance_delta_minor::numeric) filter (where ef.effective_date < v_month_start), 0::numeric) as before_month_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'OPENING_PAYABLE'
               and not ef.is_reversed
           ), 0::numeric) as opening_payable_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'OPENING_ADVANCE'
               and not ef.is_reversed
           ), 0::numeric) as opening_advance_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type in ('DEBT_RECORDED', 'PAYROLL_RECORDED', 'ADJUSTMENT_INCREASE')
               and not ef.is_reversed
           ), 0::numeric) as obligations_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type in ('PAYMENT_RECORDED', 'ADJUSTMENT_DECREASE')
               and not ef.is_reversed
           ), 0::numeric) as paid_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'ADVANCE_RECORDED'
               and not ef.is_reversed
           ), 0::numeric) as advanced_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'ADVANCE_OFFSET_RECORDED'
               and not ef.is_reversed
           ), 0::numeric) as advance_offset_num,
           coalesce(sum(ef.balance_delta_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
           ), 0::numeric) as net_change_num,
           coalesce(sum(ef.balance_delta_minor::numeric) filter (
             where ef.effective_date < v_month_end
           ), 0::numeric) as closing_num,
           coalesce(sum(ef.balance_delta_minor::numeric), 0::numeric) as current_num,
           count(ef.entry_id) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
           )::integer as in_month_entry_count,
           count(ef.entry_id)::integer as total_entry_count
      from candidate_books cb
      join public.direct_entry_projects p on p.project_id = cb.project_id
      join public.vendors v on v.vendor_id = cb.vendor_id
      left join active_assignments aa on aa.project_id = cb.project_id
      left join entry_flags ef
        on ef.project_id = cb.project_id
       and ef.responsible_accountant_user_id = cb.accountant_user_id
       and ef.vendor_id = cb.vendor_id
       and ef.contract_type = cb.contract_type
     group by cb.project_id, p.display_name, p.active,
              cb.accountant_user_id, aa.accountant_user_id,
              cb.vendor_id, v.display_name, v.active,
              cb.contract_type
  ),
  book_metrics_enriched as (
    select bm.*,
           (bm.paid_num + bm.advanced_num) as paid_and_advanced_num,
           greatest(bm.closing_num, 0::numeric) as closing_payable_num,
           greatest(-bm.closing_num, 0::numeric) as closing_advance_num
      from book_metrics bm
  ),
  pa_groups as (
    select bme.project_id,
           bme.project_display_name,
           bme.project_active,
           bme.accountant_user_id,
           bme.accountant_display_name,
           bme.is_currently_assigned,
           bme.contract_type,
           count(*)::integer as vendor_count,
           coalesce(sum(bme.obligations_num), 0::numeric) as obligations_num,
           coalesce(sum(bme.paid_num), 0::numeric) as paid_num,
           coalesce(sum(bme.advanced_num), 0::numeric) as advanced_num,
           coalesce(sum(bme.advance_offset_num), 0::numeric) as advance_offset_num,
           coalesce(sum(bme.paid_and_advanced_num), 0::numeric) as paid_and_advanced_num,
           coalesce(sum(bme.closing_payable_num), 0::numeric) as closing_payable_num,
           coalesce(sum(bme.closing_advance_num), 0::numeric) as closing_advance_num,
           coalesce(sum(bme.in_month_entry_count), 0)::integer as in_month_entry_count
      from book_metrics_enriched bme
     group by bme.project_id, bme.project_display_name, bme.project_active,
              bme.accountant_user_id, bme.accountant_display_name, bme.is_currently_assigned,
              bme.contract_type
  )
  select pg_catalog.jsonb_build_object(
           'project_revenue_status', 'MISSING_CANONICAL_SOURCE',
           'project_revenue_minor', null,
           'project_accountant_book_count', (select count(*)::integer from pa_groups),
           'sub_ledger_count', (select count(*)::integer from book_metrics_enriched),
           'obligations_in_month_minor', pg_catalog.trunc(coalesce((select sum(obligations_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'paid_in_month_minor', pg_catalog.trunc(coalesce((select sum(paid_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'advanced_in_month_minor', pg_catalog.trunc(coalesce((select sum(advanced_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'advance_offset_in_month_minor', pg_catalog.trunc(coalesce((select sum(advance_offset_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'paid_and_advanced_in_month_minor', pg_catalog.trunc(coalesce((select sum(paid_and_advanced_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'closing_payable_minor', pg_catalog.trunc(coalesce((select sum(closing_payable_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'closing_advance_minor', pg_catalog.trunc(coalesce((select sum(closing_advance_num) from book_metrics_enriched), 0::numeric), 0)::text
         ),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'project_id', pg.project_id,
                        'project_display_name', pg.project_display_name,
                        'project_active', pg.project_active,
                        'accountant_ref', pg.accountant_user_id,
                        'responsible_accountant_display_name', pg.accountant_display_name,
                        'is_currently_assigned', pg.is_currently_assigned,
                        'contract_type', pg.contract_type,
                        'project_revenue_status', 'MISSING_CANONICAL_SOURCE',
                        'project_revenue_minor', null,
                        'vendor_count', pg.vendor_count,
                        'obligations_in_month_minor', pg_catalog.trunc(pg.obligations_num, 0)::text,
                        'paid_in_month_minor', pg_catalog.trunc(pg.paid_num, 0)::text,
                        'advanced_in_month_minor', pg_catalog.trunc(pg.advanced_num, 0)::text,
                        'advance_offset_in_month_minor', pg_catalog.trunc(pg.advance_offset_num, 0)::text,
                        'paid_and_advanced_in_month_minor', pg_catalog.trunc(pg.paid_and_advanced_num, 0)::text,
                        'closing_payable_minor', pg_catalog.trunc(pg.closing_payable_num, 0)::text,
                        'closing_advance_minor', pg_catalog.trunc(pg.closing_advance_num, 0)::text,
                        'in_month_entry_count', pg.in_month_entry_count
                      )
                      order by
                        (not pg.is_currently_assigned) asc,
                        pg_catalog.lower(pg.project_display_name) asc,
                        pg.project_id asc,
                        pg_catalog.lower(pg.accountant_display_name) asc,
                        case pg.contract_type
                          when 'SEASONAL' then 1
                          when 'OFFICIAL' then 2
                          else 3
                        end asc
                    )
               from pa_groups pg
           ),
           '[]'::jsonb
         ),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'project_id', r.project_id,
                        'project_display_name', r.project_display_name,
                        'project_active', r.project_active,
                        'accountant_ref', r.accountant_user_id,
                        'responsible_accountant_display_name', r.accountant_display_name,
                        'is_currently_assigned', r.is_currently_assigned,
                        'vendor_id', r.vendor_id,
                        'vendor_display_name', r.vendor_display_name,
                        'vendor_active', r.vendor_active,
                        'contract_type', r.contract_type,
                        'project_revenue_status', 'MISSING_CANONICAL_SOURCE',
                        'project_revenue_minor', null,
                        'balance_before_month_minor', pg_catalog.trunc(r.before_month_num, 0)::text,
                        'opening_payable_in_month_minor', pg_catalog.trunc(r.opening_payable_num, 0)::text,
                        'opening_advance_in_month_minor', pg_catalog.trunc(r.opening_advance_num, 0)::text,
                        'obligations_in_month_minor', pg_catalog.trunc(r.obligations_num, 0)::text,
                        'paid_in_month_minor', pg_catalog.trunc(r.paid_num, 0)::text,
                        'advanced_in_month_minor', pg_catalog.trunc(r.advanced_num, 0)::text,
                        'advance_offset_in_month_minor', pg_catalog.trunc(r.advance_offset_num, 0)::text,
                        'paid_and_advanced_in_month_minor', pg_catalog.trunc(r.paid_and_advanced_num, 0)::text,
                        'net_change_in_month_minor', pg_catalog.trunc(r.net_change_num, 0)::text,
                        'closing_balance_minor', pg_catalog.trunc(r.closing_num, 0)::text,
                        'closing_direction', case
                          when r.closing_num > 0 then 'PAYABLE'
                          when r.closing_num < 0 then 'ADVANCE'
                          else 'BALANCED'
                        end,
                        'closing_payable_minor', pg_catalog.trunc(r.closing_payable_num, 0)::text,
                        'closing_advance_minor', pg_catalog.trunc(r.closing_advance_num, 0)::text,
                        'current_balance_minor', pg_catalog.trunc(r.current_num, 0)::text,
                        'in_month_entry_count', r.in_month_entry_count,
                        'total_entry_count', r.total_entry_count
                      )
                      order by
                        (not r.is_currently_assigned) asc,
                        pg_catalog.lower(r.project_display_name) asc,
                        r.project_id asc,
                        pg_catalog.lower(r.accountant_display_name) asc,
                        case r.contract_type
                          when 'SEASONAL' then 1
                          when 'OFFICIAL' then 2
                          else 3
                        end asc,
                        pg_catalog.abs(r.closing_num) desc,
                        pg_catalog.lower(r.vendor_display_name) asc,
                        r.vendor_id asc
                    )
               from book_metrics_enriched r
           ),
           '[]'::jsonb
         )
    into v_totals, v_project_summaries, v_rows;

  if v_vis = 'ALL'
     and p_project_id is null
     and p_accountant_user_id is null
     and p_contract_type in ('all', 'UNCLASSIFIED') then
    with legacy_flags as (
      select e.*,
             exists (
               select 1
                 from public.vendor_finance_entries rev
                where rev.reverses_entry_id = e.entry_id
             ) as is_reversed
        from public.vendor_finance_entries e
       where e.ledger_scope = 'LEGACY_UNALLOCATED'
         and (p_vendor_id is null or e.vendor_id = p_vendor_id)
    ),
    legacy_books as (
      select lf.vendor_id,
             v.display_name as vendor_display_name,
             v.active as vendor_active,
             coalesce(sum(lf.balance_delta_minor::numeric) filter (where lf.effective_date < v_month_start), 0::numeric) as before_month_num,
             coalesce(sum(lf.amount_minor::numeric) filter (
               where lf.effective_date >= v_month_start
                 and lf.effective_date < v_month_end
                 and lf.entry_type in ('DEBT_RECORDED', 'PAYROLL_RECORDED', 'ADJUSTMENT_INCREASE')
                 and not lf.is_reversed
             ), 0::numeric) as obligations_num,
             coalesce(sum(lf.amount_minor::numeric) filter (
               where lf.effective_date >= v_month_start
                 and lf.effective_date < v_month_end
                 and lf.entry_type in ('PAYMENT_RECORDED', 'ADVANCE_RECORDED', 'ADJUSTMENT_DECREASE')
                 and not lf.is_reversed
             ), 0::numeric) as paid_and_advanced_num,
             coalesce(sum(lf.balance_delta_minor::numeric) filter (where lf.effective_date < v_month_end), 0::numeric) as closing_num,
             count(*) filter (where lf.effective_date >= v_month_start and lf.effective_date < v_month_end)::integer as in_month_entry_count
        from legacy_flags lf
        join public.vendors v on v.vendor_id = lf.vendor_id
       group by lf.vendor_id, v.display_name, v.active
    )
    select coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'vendor_id', lb.vendor_id,
                 'vendor_display_name', lb.vendor_display_name,
                 'vendor_active', lb.vendor_active,
                 'balance_before_month_minor', pg_catalog.trunc(lb.before_month_num, 0)::text,
                 'obligations_in_month_minor', pg_catalog.trunc(lb.obligations_num, 0)::text,
                 'paid_and_advanced_in_month_minor', pg_catalog.trunc(lb.paid_and_advanced_num, 0)::text,
                 'closing_balance_minor', pg_catalog.trunc(lb.closing_num, 0)::text,
                 'closing_direction', case
                   when lb.closing_num > 0 then 'PAYABLE'
                   when lb.closing_num < 0 then 'ADVANCE'
                   else 'BALANCED'
                 end,
                 'in_month_entry_count', lb.in_month_entry_count
               )
               order by pg_catalog.abs(lb.closing_num) desc, pg_catalog.lower(lb.vendor_display_name) asc, lb.vendor_id asc
             ),
             '[]'::jsonb
           )
      into v_legacy_rows
      from legacy_books lb;
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'allowed_actions', pg_catalog.jsonb_build_object(
      'visibility_scope', v_vis,
      'can_view', true,
      'can_record', coalesce((v_auth->>'can_record')::boolean, false),
      'can_reconcile', coalesce((v_auth->>'can_reconcile')::boolean, false),
      'can_manage_project_assignments', coalesce((v_auth->>'can_manage_project_assignments')::boolean, false),
      'can_view_shared_advance', coalesce((v_auth->>'can_view_shared_advance')::boolean, false),
      'can_fund_vendor_advance', coalesce((v_auth->>'can_fund_vendor_advance')::boolean, false),
      'can_record_vendor_refund', coalesce((v_auth->>'can_record_vendor_refund')::boolean, false),
      'can_apply_vendor_advance', coalesce((v_auth->>'can_apply_vendor_advance')::boolean, false),
      'active_assigned_project_count', coalesce((v_auth->>'active_assigned_project_count')::integer, 0)
    ),
    'filters', pg_catalog.jsonb_build_object(
      'month', p_month,
      'project_id', p_project_id,
      'accountant_ref', p_accountant_user_id,
      'vendor_id', p_vendor_id,
      'contract_type', p_contract_type
    ),
    'totals', v_totals,
    'project_accountant_summaries', v_project_summaries,
    'rows', v_rows,
    'legacy_unallocated_rows', v_legacy_rows
  );
end;
$function$
;

-- vendor_finance_list_project_accountants_admin(uuid,uuid,text,boolean,integer,integer)
CREATE OR REPLACE FUNCTION public.vendor_finance_list_project_accountants_admin(p_auth_subject uuid, p_app_user_id uuid, p_search text DEFAULT NULL::text, p_include_history boolean DEFAULT true, p_page integer DEFAULT 1, p_page_size integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_today date;
  v_search text := null;
  v_offset integer;
  v_total integer;
  v_eligible jsonb;
  v_projects jsonb;
begin
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');
  v_today := public.direct_entry_authorization_date();

  if p_include_history is null
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'VENDOR_FINANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = '' or pg_catalog.length(v_search) > 120 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'VENDOR_FINANCE_SEARCH_INVALID'
        using errcode = '22023';
    end if;
  end if;

  v_offset := (p_page - 1) * p_page_size;

  select coalesce(
           pg_catalog.jsonb_agg(
             public.org_department__internal_account_summary(u.app_user_id)
             order by pg_catalog.lower(coalesce(u.display_name, '')), u.app_user_id
           ),
           '[]'::jsonb
         )
    into v_eligible
    from public.direct_entry_app_users u
   where u.enabled = true
     and public.org_department__internal_has_active_membership(u.app_user_id, 'ACCOUNTING', v_today);

  with filtered_projects as (
    select p.*
      from public.direct_entry_projects p
     where v_search is null
        or p.project_id ilike '%' || v_search || '%'
        or p.display_name ilike '%' || v_search || '%'
  )
  select (select count(*)::integer from filtered_projects),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'project_id', fp.project_id,
                        'display_name', fp.display_name,
                        'active', fp.active,
                        'next_version', coalesce(ver.max_version, 0) + 1,
                        'transacted_vendor_count', coalesce(lnk.cnt, 0),
                        'current_assignment', cur_asg.item,
                        'assignments', asg_list.items
                      )
                      order by (not fp.active) asc, pg_catalog.lower(fp.display_name) asc, fp.project_id asc
                    )
               from (
                 select f.*
                   from filtered_projects f
                  order by (not f.active) asc, pg_catalog.lower(f.display_name) asc, f.project_id asc
                  limit p_page_size offset v_offset
               ) fp
               left join lateral (
                 select max(pa.version)::integer as max_version
                   from public.vendor_finance_project_accountants pa
                  where pa.project_id = fp.project_id
               ) ver on true
               left join lateral (
                 select count(distinct e.vendor_id)::integer as cnt
                   from public.vendor_finance_entries e
                  where e.project_id = fp.project_id
                    and e.ledger_scope = 'PROJECT_ACCOUNTANT'
               ) lnk on true
               left join lateral (
                 select pg_catalog.jsonb_build_object(
                          'assignment_id', pa.assignment_id,
                          'project_id', pa.project_id,
                          'version', coalesce(ver.max_version, pa.version),
                          'accountant', public.org_department__internal_account_summary(pa.accountant_user_id),
                          'accountant_in_accounting_department', public.org_department__internal_has_active_membership(
                            pa.accountant_user_id, 'ACCOUNTING', v_today
                          ),
                          'valid_from', pa.valid_from::text,
                          'valid_to', case when pa.valid_to is null then null else pa.valid_to::text end,
                          'state', case
                            when pa.valid_to is not null and pa.valid_to = pa.valid_from then 'CANCELLED'
                            when pa.valid_to is not null and pa.valid_to <= v_today then 'ENDED'
                            when pa.valid_from > v_today then 'SCHEDULED'
                            else 'ACTIVE'
                          end,
                          'assign_reason', pa.assign_reason,
                          'end_reason', pa.end_reason,
                          'created_at', pg_catalog.to_jsonb(pa.created_at)
                        ) as item
                   from public.vendor_finance_project_accountants pa
                  where pa.project_id = fp.project_id
                    and pa.valid_to is null
                  limit 1
               ) cur_asg on true
               left join lateral (
                 select coalesce(
                          pg_catalog.jsonb_agg(
                            pg_catalog.jsonb_build_object(
                              'assignment_id', pa.assignment_id,
                              'project_id', pa.project_id,
                              'version', coalesce(ver.max_version, pa.version),
                              'accountant', public.org_department__internal_account_summary(pa.accountant_user_id),
                              'accountant_in_accounting_department', public.org_department__internal_has_active_membership(
                                pa.accountant_user_id, 'ACCOUNTING', v_today
                              ),
                              'valid_from', pa.valid_from::text,
                              'valid_to', case when pa.valid_to is null then null else pa.valid_to::text end,
                              'state', case
                                when pa.valid_to is not null and pa.valid_to = pa.valid_from then 'CANCELLED'
                                when pa.valid_to is not null and pa.valid_to <= v_today then 'ENDED'
                                when pa.valid_from > v_today then 'SCHEDULED'
                                else 'ACTIVE'
                              end,
                              'assign_reason', pa.assign_reason,
                              'end_reason', pa.end_reason,
                              'created_at', pg_catalog.to_jsonb(pa.created_at)
                            )
                            order by pa.version desc
                          ),
                          '[]'::jsonb
                        ) as items
                   from public.vendor_finance_project_accountants pa
                  where pa.project_id = fp.project_id
                    and (p_include_history or pa.valid_to is null)
               ) asg_list on true
           ),
           '[]'::jsonb
         )
    into v_total, v_projects;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_today::text,
    'eligible_accountants', v_eligible,
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'projects', v_projects
  );
end;
$function$
;

-- work_report__internal_assert_read_actor(uuid,uuid,text)
CREATE OR REPLACE FUNCTION public.work_report__internal_assert_read_actor(p_auth_subject uuid, p_app_user_id uuid, p_capability text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
  ) then
    raise exception 'WORK_REPORT_ACTOR_DENIED' using errcode = '42501';
  end if;
  if p_capability is not null
     and not public.work_report__internal_has_read_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
end;
$function$
;

-- work_report__internal_direct_team_ids(uuid,text)
CREATE OR REPLACE FUNCTION public.work_report__internal_direct_team_ids(p_app_user_id uuid, p_capability text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_team_ids uuid[];
begin
  if p_app_user_id is null or p_capability is null then
    return array[]::uuid[];
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled then
    return array[]::uuid[];
  end if;

  if coalesce(v_user.authz_managed, false) then
    select coalesce(pg_catalog.array_agg(distinct t.team_id order by t.team_id), array[]::uuid[])
      into v_team_ids
      from pg_catalog.jsonb_to_recordset(
        public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id)
      ) as g(capability text, scope_kind text, scope_id text)
      join public.teams t
        on t.team_id::text = g.scope_id
       and t.active
       and t.code <> '__system_vendor__'
     where g.capability = p_capability
       and g.scope_kind = 'CONTEXT_TEAM'
       and g.scope_id is not null
       and pg_catalog.btrim(g.scope_id) <> '';

    return coalesce(v_team_ids, array[]::uuid[]);
  end if;

  if not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    return array[]::uuid[];
  end if;

  select coalesce(pg_catalog.array_agg(distinct s.team_id order by s.team_id), array[]::uuid[])
    into v_team_ids
    from public.direct_entry_scope_grants s
    join public.teams t
      on t.team_id = s.team_id
     and t.active
     and t.code <> '__system_vendor__'
   where s.app_user_id = p_app_user_id
     and s.scope_kind = 'team'
     and s.is_current;

  return coalesce(v_team_ids, array[]::uuid[]);
end;
$function$
;

-- work_report__internal_has_direct_capability(uuid,text)
CREATE OR REPLACE FUNCTION public.work_report__internal_has_direct_capability(p_app_user_id uuid, p_capability text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.direct_entry_app_users%rowtype;
begin
  if p_app_user_id is null or p_capability is null then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled then
    return false;
  end if;

  if coalesce(v_user.authz_managed, false) then
    if exists (
      select 1
        from pg_catalog.jsonb_to_recordset(
          public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id)
        ) as g(capability text)
       where g.capability = p_capability
    ) then
      return true;
    end if;

    if p_capability in (
      'report_form_manage', 'report_assign', 'report_view',
      'report_analytics_view', 'report_review', 'report_delegate'
    ) and public.work_report__internal_is_full_admin(p_app_user_id) then
      return true;
    end if;

    return false;
  end if;

  -- Pre-cutover R1 compatibility path (not authz_managed)
  if public.direct_entry_has_capability(p_app_user_id, p_capability) then
    return true;
  end if;
  if p_capability in (
    'report_form_manage', 'report_assign', 'report_view',
    'report_analytics_view', 'report_review', 'report_delegate'
  )
     and not exists (
       select 1 from public.direct_entry_capability_grants g
        where g.app_user_id = p_app_user_id
          and g.capability = p_capability
          and not g.is_current
     )
     and public.work_report__internal_is_full_admin(p_app_user_id) then
    return true;
  end if;
  return false;
end;
$function$
;

-- work_report__internal_has_direct_scope(uuid,text,text,uuid)
CREATE OR REPLACE FUNCTION public.work_report__internal_has_direct_scope(p_app_user_id uuid, p_capability text, p_scope_kind text, p_team_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_has_all boolean := false;
begin
  if p_app_user_id is null or p_capability is null or p_scope_kind is null then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled then
    return false;
  end if;

  if coalesce(v_user.authz_managed, false) then
    v_has_all := public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, p_capability, 'ALL', null
    ) or (
      p_capability in (
        'report_form_manage', 'report_assign', 'report_view',
        'report_analytics_view', 'report_review', 'report_delegate'
      )
      and public.work_report__internal_is_full_admin(p_app_user_id)
    );

    if p_scope_kind = 'all' then
      return v_has_all and p_team_id is null;
    end if;

    if p_scope_kind = 'team' and p_team_id is not null then
      if not exists (
        select 1
          from public.teams t
         where t.team_id = p_team_id
           and t.active
           and t.code <> '__system_vendor__'
      ) then
        return false;
      end if;

      if v_has_all then
        return true;
      end if;

      return public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, p_capability, 'CONTEXT_TEAM', p_team_id::text
      );
    end if;

    return false;
  end if;

  -- Pre-cutover R1 compatibility path (not authz_managed)
  if not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    return false;
  end if;
  if public.direct_entry_has_scope(p_app_user_id, 'all') then
    if p_scope_kind = 'all' and p_team_id is null then
      return true;
    end if;
    if p_scope_kind = 'team' and p_team_id is not null and exists (
      select 1 from public.teams t
       where t.team_id = p_team_id
         and t.active
         and t.code <> '__system_vendor__'
    ) then
      return true;
    end if;
    return false;
  end if;
  if p_scope_kind = 'team' and p_team_id is not null and exists (
    select 1
      from public.direct_entry_scope_grants s
      join public.teams t on t.team_id = s.team_id and t.active and t.code <> '__system_vendor__'
     where s.app_user_id = p_app_user_id
       and s.scope_kind = 'team'
       and s.team_id = p_team_id
       and s.is_current
  ) then
    return true;
  end if;
  return false;
end;
$function$
;

-- work_report__internal_has_read_capability(uuid,text)
CREATE OR REPLACE FUNCTION public.work_report__internal_has_read_capability(p_app_user_id uuid, p_capability text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.direct_entry_app_users%rowtype;
begin
  if p_app_user_id is null or p_capability is null then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled then
    return false;
  end if;

  return public.work_report__internal_has_direct_capability(p_app_user_id, p_capability);
end;
$function$
;

-- work_report__internal_has_read_scope(uuid,text,text,uuid)
CREATE OR REPLACE FUNCTION public.work_report__internal_has_read_scope(p_app_user_id uuid, p_capability text, p_scope_kind text, p_team_id uuid DEFAULT NULL::uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.direct_entry_app_users%rowtype;
begin
  if p_app_user_id is null or p_capability is null or p_scope_kind is null then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled then
    return false;
  end if;

  return public.work_report__internal_has_direct_scope(p_app_user_id, p_capability, p_scope_kind, p_team_id);
end;
$function$
;

-- work_report__internal_is_delegation_effective(uuid,timestamp with time zone)
CREATE OR REPLACE FUNCTION public.work_report__internal_is_delegation_effective(p_delegation_id uuid, p_as_of timestamp with time zone DEFAULT statement_timestamp())
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_del public.work_report_delegations%rowtype;
  v_delegate public.direct_entry_app_users%rowtype;
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

  select u.* into v_delegate
    from public.direct_entry_app_users u
   where u.app_user_id = v_del.delegate_app_user_id;
  if not found or not v_delegate.enabled then
    return false;
  end if;
  if public.attendance__internal_is_non_employee_account(v_del.delegate_app_user_id, p_as_of)
     or public.attendance__internal_is_person_inactive_as_of(v_del.delegate_app_user_id, p_as_of) then
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
      select 1 from public.teams tm
       where tm.team_id = v_del.scope_team_id
         and tm.active
         and tm.code <> '__system_vendor__'
    ) then
      return false;
    end if;

    if public.work_report_current_team(v_del.delegate_app_user_id) is distinct from v_del.scope_team_id then
      if coalesce(v_delegate.authz_managed, false) then
        if not exists (
          select 1
            from pg_catalog.jsonb_to_recordset(
              public.direct_entry_authz__internal_resolve_effective_grants(v_del.delegate_app_user_id)
            ) as g(scope_kind text, scope_id text)
           where g.scope_kind = 'CONTEXT_TEAM'
             and g.scope_id = v_del.scope_team_id::text
        ) then
          return false;
        end if;
      else
        if not exists (
          select 1 from public.direct_entry_scope_grants sg
           where sg.app_user_id = v_del.delegate_app_user_id
             and sg.scope_kind = 'team'
             and sg.team_id = v_del.scope_team_id
             and sg.is_current
        ) then
          return false;
        end if;
      end if;
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
$function$
;

-- work_report__internal_is_full_admin(uuid)
CREATE OR REPLACE FUNCTION public.work_report__internal_is_full_admin(p_app_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.direct_entry_app_users%rowtype;
begin
  if p_app_user_id is null then
    return false;
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled then
    return false;
  end if;

  if coalesce(v_user.authz_managed, false) then
    return public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
       and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
       and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);
  end if;

  return public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
     and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
     and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
     and public.direct_entry_has_scope(p_app_user_id, 'all');
end;
$function$
;

-- work_report__internal_read_team_ids(uuid,text)
CREATE OR REPLACE FUNCTION public.work_report__internal_read_team_ids(p_app_user_id uuid, p_capability text)
 RETURNS uuid[]
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.direct_entry_app_users%rowtype;
begin
  if p_app_user_id is null or p_capability is null then
    return array[]::uuid[];
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not v_user.enabled then
    return array[]::uuid[];
  end if;

  return public.work_report__internal_direct_team_ids(p_app_user_id, p_capability);
end;
$function$
;

-- work_report_assert_actor(uuid,uuid,text)
CREATE OR REPLACE FUNCTION public.work_report_assert_actor(p_auth_subject uuid, p_app_user_id uuid, p_capability text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
begin
  if not exists (
    select 1 from public.direct_entry_app_users u
     where u.app_user_id = p_app_user_id
       and u.auth_subject = p_auth_subject
       and u.enabled
       and not public.attendance__internal_is_non_employee_account(p_app_user_id, pg_catalog.clock_timestamp())
  ) then
    raise exception 'WORK_REPORT_ACTOR_DENIED' using errcode = '42501';
  end if;
  if p_capability is not null
     and not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
end;
$function$
;

-- work_report_create_delegation(uuid,uuid,text,uuid,uuid,text,uuid,timestamp with time zone,timestamp with time zone,text)
CREATE OR REPLACE FUNCTION public.work_report_create_delegation(p_auth_subject uuid, p_app_user_id uuid, p_capability text, p_delegate_app_user_id uuid, p_template_id uuid, p_scope_kind text, p_scope_team_id uuid, p_effective_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_effective_to timestamp with time zone DEFAULT NULL::timestamp with time zone, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_delegate public.direct_entry_app_users%rowtype;
  v_template public.work_report_templates%rowtype;
  v_delegation_id uuid;
  v_effective_from timestamptz;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_person_ids uuid[];
  v_lock_recruiter_ids uuid[];
  v_check_now timestamptz;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');

  if p_capability is null or p_capability not in ('report_assign', 'report_review') then
    raise exception 'WORK_REPORT_DELEGATION_CAPABILITY_INVALID' using errcode = '22023';
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

  -- Tier 1 strict ASC FOR SHARE lock on open linked organization_persons BEFORE Tier 2 direct_entry_app_users.
  select pg_catalog.array_agg(distinct l.person_id order by l.person_id asc)
    into v_lock_person_ids
    from public.organization_account_person_links l
   where l.app_user_id in (p_app_user_id, p_delegate_app_user_id)
     and l.ended_at is null;

  if coalesce(pg_catalog.cardinality(v_lock_person_ids), 0) > 0 then
    perform op.person_id
      from public.organization_persons op
     where op.person_id = any(v_lock_person_ids)
     order by op.person_id asc
     for share;
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on grantor + delegate to serialize against disable/revoke.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id in (p_app_user_id, p_delegate_app_user_id)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on delegate's recruiter for team-scoped delegation (serializes against move_team_membership).
  if p_scope_kind = 'team' then
    select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
      into v_lock_recruiter_ids
      from public.direct_entry_app_user_recruiter_links l
     where l.app_user_id = p_delegate_app_user_id
       and l.verified
       and l.is_current;

    if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
      perform r.recruiter_id
        from public.recruiters r
       where r.recruiter_id = any(v_lock_recruiter_ids)
       order by r.recruiter_id asc
       for share;
    end if;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');

  if not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
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

  select u.*
    into v_delegate
    from public.direct_entry_app_users u
   where u.app_user_id = p_delegate_app_user_id;

  v_check_now := pg_catalog.clock_timestamp();

  if not found
     or not v_delegate.enabled
     or public.attendance__internal_is_non_employee_account(p_delegate_app_user_id, v_check_now)
     or public.attendance__internal_is_person_inactive_as_of(p_delegate_app_user_id, v_check_now) then
    raise exception 'WORK_REPORT_DELEGATE_NOT_AVAILABLE' using errcode = '42501';
  end if;

  if p_scope_kind = 'team' then
    if public.work_report_current_team(p_delegate_app_user_id) is distinct from p_scope_team_id then
      if coalesce(v_delegate.authz_managed, false) then
        if not exists (
          select 1
            from pg_catalog.jsonb_to_recordset(
              public.direct_entry_authz__internal_resolve_effective_grants(p_delegate_app_user_id)
            ) as g(scope_kind text, scope_id text)
           where g.scope_kind = 'CONTEXT_TEAM'
             and g.scope_id = p_scope_team_id::text
        ) then
          raise exception 'WORK_REPORT_DELEGATE_OUTSIDE_SCOPE' using errcode = '42501';
        end if;
      else
        if not exists (
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
$function$
;

-- work_report_get_submission(uuid,uuid,uuid)
CREATE OR REPLACE FUNCTION public.work_report_get_submission(p_auth_subject uuid, p_app_user_id uuid, p_obligation_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_is_non_normal_managed boolean := false;
  v_result jsonb;
begin
  perform public.work_report__internal_assert_read_actor(p_auth_subject, p_app_user_id, null);
  select o.* into v_obligation
    from public.work_report_obligations o
   where o.obligation_id = p_obligation_id
      or exists (
        select 1
          from public.work_report_submissions s
         where s.submission_id = p_obligation_id
           and s.obligation_id = o.obligation_id
      );
  if not found then
    raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_obligation.assignee_app_user_id <> p_app_user_id then
    begin
      perform public.work_report__internal_assert_read_actor(p_auth_subject, p_app_user_id, 'report_view');
    exception when insufficient_privilege then
      raise exception 'WORK_REPORT_ACCESS_DENIED' using errcode = '42501';
    end;
    if not public.work_report__internal_has_read_scope(p_app_user_id, 'report_view', 'all', null) then
      if v_obligation.snapshot_team_id is null
         or not public.work_report__internal_has_read_scope(p_app_user_id, 'report_view', 'team', v_obligation.snapshot_team_id) then
        raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
      end if;
    end if;
  end if;
  select jsonb_build_object(
    'obligation', jsonb_build_object(
      'obligation_id', o.obligation_id,
      'template_id', o.template_id,
      'assignee_app_user_id', o.assignee_app_user_id,
      'snapshot_team_id', o.snapshot_team_id,
      'snapshot_team_code', o.snapshot_team_code,
      'snapshot_team_display_name', o.snapshot_team_display_name,
      'period_key', o.period_key,
      'period_start_date', o.period_start_date,
      'period_end_date', o.period_end_date,
      'due_at', o.due_at,
      'obligation_status', o.obligation_status,
      'reopened_until', o.reopened_until,
      'is_overdue', (
        o.obligation_status = 'ACTIVE'
        and coalesce(s.state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT')
        and now() > o.due_at
        and coalesce(o.reopened_until < now(), true)
      ),
      'version', o.version
    ),
    'template', jsonb_build_object(
      'template_code', t.template_code,
      'display_name', t.display_name,
      'schema_json', v.schema_json
    ),
    'submission', case when s.submission_id is null then null else jsonb_build_object(
      'submission_id', s.submission_id,
      'state', s.state,
      'draft_payload_json', s.draft_payload_json,
      'first_submitted_at', s.first_submitted_at,
      'latest_submitted_at', s.latest_submitted_at,
      'is_late', s.is_late,
      'has_post_deadline_amendment', s.has_post_deadline_amendment,
      'current_revision_id', s.current_revision_id,
      'version', s.version
    ) end,
    'latest_review_event', (
      select jsonb_build_object(
        'decision', re.decision,
        'reason', re.reason_text,
        'reviewed_at', re.created_at,
        'revision_no', rr.revision_no
      )
        from public.work_report_review_events re
        left join public.work_report_submission_revisions rr on rr.revision_id = re.revision_id
       where re.submission_id = s.submission_id
       order by re.created_at desc, re.review_event_id desc
       limit 1
    ),
    'revisions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'revision_id', r.revision_id,
        'revision_no', r.revision_no,
        'payload_json', r.payload_json,
        'created_at', r.created_at
      ) order by r.revision_no desc)
        from public.work_report_submission_revisions r
       where r.submission_id = s.submission_id
    ), '[]'::jsonb)
  ) into v_result
    from public.work_report_obligations o
    join public.work_report_templates t on t.template_id = o.template_id
    join public.work_report_template_versions v on v.version_id = o.template_version_id
    left join public.work_report_submissions s on s.obligation_id = o.obligation_id
   where o.obligation_id = v_obligation.obligation_id;
  return v_result;
end;
$function$
;

-- work_report_list_delegations(uuid,uuid)
CREATE OR REPLACE FUNCTION public.work_report_list_delegations(p_auth_subject uuid, p_app_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_all_scope boolean;
  v_team_ids uuid[];
  v_as_of timestamptz := statement_timestamp();
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');
  v_all_scope := public.work_report__internal_has_direct_scope(p_app_user_id, 'report_delegate', 'all', null);
  v_team_ids := public.work_report__internal_direct_team_ids(p_app_user_id, 'report_delegate');

  if not v_all_scope and coalesce(pg_catalog.cardinality(v_team_ids), 0) = 0 then
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
          or (d.scope_kind = 'team' and d.scope_team_id = any(v_team_ids))
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
               and not public.attendance__internal_is_non_employee_account(u.app_user_id, v_as_of)
               and not public.attendance__internal_is_person_inactive_as_of(u.app_user_id, v_as_of)
               and u.app_user_id <> p_app_user_id
               and (
                 v_all_scope
                 or public.work_report_current_team(u.app_user_id) = any(v_team_ids)
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
               and t.code <> '__system_vendor__'
               and (v_all_scope or t.team_id = any(v_team_ids))
          ) sc
      ), '[]'::jsonb),
      'capabilities', coalesce((
        select jsonb_agg(cap order by cap)
          from unnest(array['report_assign', 'report_review']::text[]) as cap
         where (
           v_all_scope
           and (
             public.work_report__internal_has_direct_scope(p_app_user_id, cap, 'all', null)
             or coalesce(pg_catalog.cardinality(public.work_report__internal_direct_team_ids(p_app_user_id, cap)), 0) > 0
           )
         ) or exists (
           select 1
             from unnest(v_team_ids) as tid
            where public.work_report__internal_has_direct_scope(p_app_user_id, cap, 'team', tid)
         )
      ), '[]'::jsonb)
    )
  );
end;
$function$
;

-- ============================================================================
-- 3. REPLACE 14-ARG leave_management_upsert_employee_profile_admin WITH CLEAN 13-ARG SIGNATURE
-- ============================================================================
revoke all on function public.leave_management_upsert_employee_profile_admin(
  uuid, uuid, uuid, boolean, text, text, date, date, date, integer, integer, text, text, text
) from public, anon, authenticated, service_role;

drop function public.leave_management_upsert_employee_profile_admin(
  uuid, uuid, uuid, boolean, text, text, date, date, date, integer, integer, text, text, text
) restrict;

CREATE OR REPLACE FUNCTION public.leave_management_upsert_employee_profile_admin(p_actor_auth_subject uuid, p_actor_app_user_id uuid, p_target_app_user_id uuid, p_employment_status text, p_unit_kind text, p_work_start_date date, p_official_effective_date date, p_next_seniority_effective_date date, p_next_seniority_units integer, p_expected_row_version integer, p_reason text, p_idempotency_key text, p_request_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
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
  v_unit_kind text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_unit_kind, 'UNCLASSIFIED')));
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
     or v_unit_kind not in ('UNCLASSIFIED', 'RECRUITMENT', 'MARKETING', 'IT', 'ACCOUNTING', 'MANAGEMENT_BOD')
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

  select p.*
    into v_existing_profile
    from public.leave_employee_profiles p
   where p.app_user_id = p_target_app_user_id
   for update;

  if found then
    v_has_existing := true;
    if p_expected_row_version is null or v_existing_profile.row_version <> p_expected_row_version then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using ERRCODE = 'PT409';
    end if;
    v_seniority_changed := (
      v_existing_profile.next_seniority_effective_date is distinct from p_next_seniority_effective_date
      or v_existing_profile.next_seniority_units is distinct from v_sen_units
    );
  else
    if coalesce(p_expected_row_version, 0) <> 0 then
      raise exception 'LEAVE_ROW_VERSION_CONFLICT'
        using ERRCODE = 'PT409';
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

  if v_has_existing then
    update public.leave_employee_profiles
       set employment_status = v_emp_status,
           unit_kind = v_unit_kind,
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
      unit_kind,
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
      v_unit_kind,
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
      'unit_kind', v_profile.unit_kind,
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
      'unit_kind', v_profile.unit_kind,
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
$function$
;

revoke all on function public.leave_management_upsert_employee_profile_admin(
  uuid, uuid, uuid, text, text, date, date, date, integer, integer, text, text, text
) from public, anon, authenticated, service_role;

grant execute on function public.leave_management_upsert_employee_profile_admin(
  uuid, uuid, uuid, text, text, date, date, date, integer, integer, text, text, text
) to service_role;

-- ============================================================================
-- 3B. GROUP-ONLY CUTOVER FOR LEGACY MIRROR SYNC, GROUP REMOVAL, ACCOUNT CREATE & TL TRIGGER
-- ============================================================================

-- Post-cutover legacy mirror sync: reads STRICTLY permission groups + independent TL assignments
-- (ZERO read from historical authz_account_role_assignments or authz_direct_capability_grants).
create or replace function public.direct_entry_authz__internal_sync_legacy_grants(
  p_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_user public.direct_entry_app_users%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_desired_caps text[];
  v_desired_scopes text[];
  v_cap text;
  v_scope text;
  v_next_start date;
  v_lock_key text;
  v_prev_marker text := pg_catalog.current_setting('direct_entry.team_leader_marker', true);
begin
  if p_app_user_id is null then
    return;
  end if;

  select u.* into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
   for update;

  if not found or not v_user.authz_managed then
    return;
  end if;

  with tl_open_caps as (
    select g.capability
      from public.work_report_team_leader_capability_grants x
      join public.direct_entry_team_leader_assignments tla
        on tla.assignment_id = x.leader_assignment_id
       and tla.leader_app_user_id = p_app_user_id
       and (tla.valid_to is null or tla.valid_to > v_today)
      join public.direct_entry_capability_grants g
        on g.grant_id = x.capability_grant_id
    union
    select 'team_manager_assign'::text as capability
     where exists (
       select 1
         from public.direct_entry_team_leader_assignments tla
        where tla.leader_app_user_id = p_app_user_id
          and (tla.valid_to is null or tla.valid_to > v_today)
          and (tla.is_current or tla.suspended_by_account_disable)
     )
    union
    select rc.capability
      from public.direct_entry_team_leader_assignments tla
      join public.authz_role_capabilities rc
        on rc.role_code = 'TEAM_LEADER'
     where tla.leader_app_user_id = p_app_user_id
       and (tla.valid_to is null or tla.valid_to > v_today)
       and (tla.is_current or tla.suspended_by_account_disable)
  ),
  group_active_caps as (
    select
      gc.capability,
      grp.is_system_admin,
      grp.team_id,
      grp.group_id
    from public.authz_user_group_members m
    join public.authz_user_groups grp
      on grp.group_id = m.group_id
     and grp.active = true
    join public.organization_departments dept
      on dept.department_id = grp.department_id
     and dept.is_active = true
    left join public.teams t
      on t.team_id = grp.team_id
     and t.active = true
     and t.code <> '__system_vendor__'
    join public.authz_user_group_capabilities gc
      on gc.group_id = grp.group_id
     and gc.ended_at is null
     and gc.started_at <= v_now
    where m.app_user_id = p_app_user_id
      and m.ended_at is null
      and m.started_at <= v_now
      and (grp.team_id is null or t.team_id is not null)
  ),
  desired_cap_set as (
    select gac.capability from group_active_caps gac
    union
    select tc.capability from tl_open_caps tc
  ),
  desired_scope_set as (
    select case
      when gac.is_system_admin then
        case when gac.capability = 'entry_own' then 'own' else 'all' end
      when gac.team_id is not null then
        case
          when gac.capability in (
            'entry_create',
            'entry_own',
            'submission_create',
            'document_upload',
            'document_view',
            'change_request_create',
            'employment_status.request'
          ) then 'own'
          else null
        end
      else
        case
          when gac.capability in (
            'entry_create',
            'entry_own',
            'submission_create',
            'document_upload',
            'change_request_create',
            'employment_status.request'
          ) then 'own'
          when gac.capability = 'document_view' then
            case
              when exists (
                select 1
                  from public.authz_user_group_capabilities gc2
                 where gc2.group_id = gac.group_id
                   and gc2.ended_at is null
                   and gc2.started_at <= v_now
                   and gc2.capability in (
                     'recruiter_master_manage',
                     'team_master_manage',
                     'catalog_master_manage',
                     'audit_view'
                   )
              ) then 'all'
              else 'own'
            end
          else 'all'
        end
    end as scope_kind
    from group_active_caps gac
  )
  select
    coalesce(array(select capability from desired_cap_set where capability is not null order by 1), array[]::text[]),
    coalesce(array(select scope_kind from desired_scope_set where scope_kind is not null order by 1), array[]::text[])
    into v_desired_caps, v_desired_scopes;

  perform pg_catalog.set_config('direct_entry.team_leader_marker', 'on', true);

  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_app_user_id
     and s.scope_kind in ('own', 'all')
   order by s.grant_id asc
   for update;

  for v_lock_key in
    select distinct k
      from unnest(array[
        'scope:' || p_app_user_id::text || ':all:' || p_app_user_id::text,
        'scope:' || p_app_user_id::text || ':own:' || p_app_user_id::text
      ]) as t(k)
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_app_user_id
   order by g.grant_id asc
   for update;

  for v_lock_key in
    select distinct 'capability:' || p_app_user_id::text || ':' || cap as k
      from (
        select unnest(coalesce(v_desired_caps, array[]::text[])) as cap
        union
        select g.capability as cap
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_app_user_id
      ) caps
     where cap is not null
     order by k asc
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_lock_key, 0));
  end loop;

  update public.direct_entry_scope_grants s
     set valid_to = greatest(v_today, s.valid_from),
         is_current = false,
         suspended_by_account_disable = false
   where s.app_user_id = p_app_user_id
     and s.scope_kind in ('own', 'all')
     and (s.is_current or s.valid_to is null or s.valid_to > v_today)
     and s.valid_from <= v_today
     and not (s.scope_kind = any(v_desired_scopes));

  update public.direct_entry_capability_grants g
     set valid_to = greatest(v_today, g.valid_from),
         is_current = false,
         suspended_by_account_disable = false
   where g.app_user_id = p_app_user_id
     and (g.is_current or g.valid_to is null or g.valid_to > v_today)
     and g.valid_from <= v_today
     and not (g.capability = any(v_desired_caps));

  if v_user.enabled then
    foreach v_scope in array v_desired_scopes loop
      if not exists (
        select 1 from public.direct_entry_scope_grants s
         where s.app_user_id = p_app_user_id
           and s.scope_kind = v_scope
           and s.is_current
      ) then
        update public.direct_entry_scope_grants s
           set is_current = true,
               suspended_by_account_disable = false
         where s.grant_id = (
           select s2.grant_id
             from public.direct_entry_scope_grants s2
            where s2.app_user_id = p_app_user_id
              and s2.scope_kind = v_scope
              and s2.valid_from <= v_today
              and (s2.valid_to is null or (s2.valid_to > s2.valid_from and v_today < s2.valid_to))
            order by s2.valid_from desc, s2.grant_id desc
            limit 1
         );

        if not found then
          select min(s.valid_from)
            into v_next_start
            from public.direct_entry_scope_grants s
           where s.app_user_id = p_app_user_id
             and s.scope_kind = v_scope
             and s.valid_from > v_today
             and (s.valid_to is null or s.valid_to > s.valid_from);

          insert into public.direct_entry_scope_grants (
            app_user_id, scope_kind, team_id, valid_from, valid_to, is_current, suspended_by_account_disable
          ) values (
            p_app_user_id, v_scope, null, v_today, v_next_start, true, false
          )
          on conflict do nothing;
        end if;
      end if;
    end loop;

    foreach v_cap in array v_desired_caps loop
      if not exists (
        select 1 from public.direct_entry_capability_grants g
         where g.app_user_id = p_app_user_id
           and g.capability = v_cap
           and g.is_current
      ) then
        update public.direct_entry_capability_grants g
           set is_current = true,
               suspended_by_account_disable = false
         where g.grant_id = (
           select g2.grant_id
             from public.direct_entry_capability_grants g2
            where g2.app_user_id = p_app_user_id
              and g2.capability = v_cap
              and g2.valid_from <= v_today
              and (g2.valid_to is null or (g2.valid_to > g2.valid_from and v_today < g2.valid_to))
            order by g2.valid_from desc, g2.grant_id desc
            limit 1
         );

        if not found then
          select min(g.valid_from)
            into v_next_start
            from public.direct_entry_capability_grants g
           where g.app_user_id = p_app_user_id
             and g.capability = v_cap
             and g.valid_from > v_today
             and (g.valid_to is null or g.valid_to > g.valid_from);

          insert into public.direct_entry_capability_grants (
            app_user_id, capability, valid_from, valid_to, is_current, suspended_by_account_disable
          ) values (
            p_app_user_id, v_cap, v_today, v_next_start, true, false
          )
          on conflict do nothing;
        end if;
      end if;
    end loop;
  end if;

  perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
exception
  when others then
    perform pg_catalog.set_config('direct_entry.team_leader_marker', coalesce(v_prev_marker, ''), true);
    raise;
end;
$function$;

revoke all on function public.direct_entry_authz__internal_sync_legacy_grants(uuid)
  from public, anon, authenticated, service_role;

-- Post-cutover remove_group_member_admin: Owner protection strictly enforced via
-- authz_user_group_members.is_protected + DB trigger; no write to retired role table.
create or replace function public.direct_entry_authz_remove_group_member_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_target_app_user_id uuid,
  p_membership_id uuid,
  p_expected_account_version integer,
  p_reason text,
  p_idempotency_key uuid,
  p_request_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_op text := 'AUTHZ_GROUP_MEMBER_REMOVED';
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_locked_id uuid;
  v_target public.direct_entry_app_users%rowtype;
  v_membership public.authz_user_group_members%rowtype;
  v_group public.authz_user_groups%rowtype;
  v_existing_idem public.authz_group_idempotency%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_new_version integer;
  v_result jsonb;
begin
  if p_auth_subject is null or p_actor_app_user_id is null then
    raise exception 'AUTHZ_FORBIDDEN' using errcode = '42501';
  end if;
  if p_target_app_user_id is null
     or p_membership_id is null
     or p_expected_account_version is null
     or p_expected_account_version < 1
     or p_idempotency_key is null
     or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'AUTHZ_REASON_INVALID' using errcode = '22023';
  end if;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  for v_locked_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id in (p_actor_app_user_id, p_target_app_user_id)
     order by u.app_user_id asc
     for update
  loop
    null;
  end loop;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select u.* into v_target
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_app_user_id;
  if not found then
    raise exception 'ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  select i.* into v_existing_idem
    from public.authz_group_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.operation_name = v_op
     and i.target_key = p_target_app_user_id::text || ':' || p_membership_id::text
     and i.idempotency_key = p_idempotency_key::text
   for update;

  if found then
    if v_existing_idem.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select m.* into v_membership
    from public.authz_user_group_members m
   where m.membership_id = p_membership_id
     and m.app_user_id = p_target_app_user_id
   for update;

  if not found then
    raise exception 'GROUP_MEMBERSHIP_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_membership.is_protected then
    raise exception 'AUTHZ_PROTECTED_ASSIGNMENT' using errcode = 'PT409';
  end if;

  if v_membership.ended_at is not null then
    raise exception 'GROUP_MEMBERSHIP_ALREADY_ENDED' using errcode = 'PT409';
  end if;

  if v_target.version <> p_expected_account_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_version', v_target.version)::text;
  end if;

  select g.* into v_group
    from public.authz_user_groups g
   where g.group_id = v_membership.group_id;

  update public.authz_user_group_members m
     set ended_at = v_now,
         ended_reason = v_reason,
         ended_by_app_user_id = p_actor_app_user_id
   where m.membership_id = p_membership_id;

  update public.direct_entry_app_users u
     set authz_managed = true,
         version = u.version + 1,
         updated_at = v_now
   where u.app_user_id = p_target_app_user_id
  returning u.version into v_new_version;

  perform public.direct_entry_authz__internal_sync_legacy_grants(p_target_app_user_id);

  v_result := pg_catalog.jsonb_build_object(
    'membership_id', p_membership_id,
    'group_id', v_group.group_id,
    'group_code', v_group.code,
    'group_name', v_group.name,
    'account_ref', p_target_app_user_id,
    'account_version', v_new_version,
    'ended_at', public.org_department__internal_iso_utc(v_now),
    'replayed', false
  );

  insert into public.authz_group_audit_events (
    actor_auth_subject, actor_app_user_id, group_id, target_app_user_id,
    membership_id, operation_name, before_payload, after_payload, reason, created_at
  ) values (
    p_auth_subject, p_actor_app_user_id, v_group.group_id, p_target_app_user_id,
    p_membership_id, v_op,
    pg_catalog.jsonb_build_object(
      'account_version', v_target.version,
      'group_id', v_group.group_id,
      'group_code', v_group.code
    ),
    v_result, v_reason, v_now
  );

  insert into public.authz_group_idempotency (
    actor_app_user_id, operation_name, target_key, idempotency_key,
    request_hash, response_payload, created_at
  ) values (
    p_actor_app_user_id, v_op,
    p_target_app_user_id::text || ':' || p_membership_id::text,
    p_idempotency_key::text, p_request_hash, v_result, v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.direct_entry_authz_remove_group_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_remove_group_member_admin(uuid, uuid, uuid, uuid, integer, text, uuid, text)
  to service_role;

-- Post-cutover finalize_create: creates authz_managed account without writing to retired role table
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
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_action text := 'account_created';
  v_intent public.direct_entry_account_operation_intents;
  v_payload_hash text;
  v_prior jsonb;
  v_reason_id uuid;
  v_app_user public.direct_entry_app_users;
  v_revision_id uuid;
begin
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 128 then
    raise exception 'idempotency key required' using errcode = '22023';
  end if;
  if p_created_auth_subject is null or p_intent_id is null or p_intent_token is null then
    raise exception 'intent, token and auth subject required' using errcode = '22023';
  end if;

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

  v_reason_id := v_intent.reason_id;
  insert into public.direct_entry_app_users (auth_subject, enabled, display_name, authz_managed)
  values (p_created_auth_subject, true, v_intent.display_name, true)
  returning * into v_app_user;

  perform public.direct_entry_authz__internal_sync_legacy_grants(v_app_user.app_user_id);

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

-- Post-cutover Team Leader capability trigger: checks active permission groups instead of legacy tables
create or replace function public.work_report_sync_team_leader_capabilities()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_capability text;
  v_grant_id uuid;
  v_grant_from date;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_lock_key text;
  v_leader_ids uuid[];
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

-- Sync legacy mirrors for all managed users to match pure group-only state immediately
do $$
declare
  v_uid uuid;
begin
  for v_uid in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.authz_managed = true
     order by u.app_user_id asc
  loop
    perform public.direct_entry_authz__internal_sync_legacy_grants(v_uid);
  end loop;
end;
$$;

-- ============================================================================
-- 4. RETIRE OBSOLETE INTEGRATION, SHADOW, ACCOUNT-TYPE & PER-ACCOUNT ROLE/MODULE RPCS
-- ============================================================================
revoke all on function public.hrp_sync_catalog(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
drop function public.hrp_sync_catalog(uuid, uuid, uuid) restrict;

revoke all on function public.org_department_set_account_type_admin(
  uuid, uuid, uuid, text, integer, text, uuid, text
) from public, anon, authenticated, service_role;
drop function public.org_department_set_account_type_admin(
  uuid, uuid, uuid, text, integer, text, uuid, text
) restrict;

revoke all on function public.org_department__internal_has_personal_assignments(
  uuid, timestamp with time zone
) from public, anon, authenticated, service_role;
drop function public.org_department__internal_has_personal_assignments(
  uuid, timestamp with time zone
) restrict;

revoke all on function public.direct_entry_authz_resolve_candidate_access(
  timestamp with time zone, uuid
) from public, anon, authenticated, service_role;
drop function public.direct_entry_authz_resolve_candidate_access(
  timestamp with time zone, uuid
) restrict;

revoke all on function public.direct_entry_authz_compare_shadow_access(
  timestamp with time zone, uuid
) from public, anon, authenticated, service_role;
drop function public.direct_entry_authz_compare_shadow_access(
  timestamp with time zone, uuid
) restrict;

revoke all on function public.direct_entry_authz_resolve_current_snapshot(
  timestamp with time zone, uuid
) from public, anon, authenticated, service_role;
drop function public.direct_entry_authz_resolve_current_snapshot(
  timestamp with time zone, uuid
) restrict;

revoke all on function public.direct_entry_list_app_users_filtered_admin(
  uuid, uuid, text, text, integer, integer, text, text
) from public, anon, authenticated, service_role;
drop function public.direct_entry_list_app_users_filtered_admin(
  uuid, uuid, text, text, integer, integer, text, text
) restrict;

revoke all on function public.leave_management_get_admin_overview(
  uuid, uuid, text, integer, integer
) from public, anon, authenticated, service_role;
drop function public.leave_management_get_admin_overview(
  uuid, uuid, text, integer, integer
) restrict;

revoke all on function public.direct_entry_authz_assign_global_role_admin(
  uuid, uuid, uuid, text, integer, text, uuid, text
) from public, anon, authenticated, service_role;
drop function public.direct_entry_authz_assign_global_role_admin(
  uuid, uuid, uuid, text, integer, text, uuid, text
) restrict;

revoke all on function public.direct_entry_authz_revoke_global_role_admin(
  uuid, uuid, uuid, uuid, integer, text, uuid, text
) from public, anon, authenticated, service_role;
drop function public.direct_entry_authz_revoke_global_role_admin(
  uuid, uuid, uuid, uuid, integer, text, uuid, text
) restrict;

revoke all on function public.direct_entry_authz_list_roles_admin(
  uuid, uuid
) from public, anon, authenticated, service_role;
drop function public.direct_entry_authz_list_roles_admin(
  uuid, uuid
) restrict;

revoke all on function public.direct_entry_authz_list_accounts_summary_admin(
  uuid, uuid, text, text, text, integer, integer
) from public, anon, authenticated, service_role;
drop function public.direct_entry_authz_list_accounts_summary_admin(
  uuid, uuid, text, text, text, integer, integer
) restrict;

revoke all on function public.direct_entry_authz_get_account_access_admin(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;
drop function public.direct_entry_authz_get_account_access_admin(
  uuid, uuid, uuid
) restrict;

revoke all on function public.vendor_finance_assign_global_role_admin(
  uuid, uuid, uuid, text, integer, date, text, uuid, text
) from public, anon, authenticated, service_role;
drop function public.vendor_finance_assign_global_role_admin(
  uuid, uuid, uuid, text, integer, date, text, uuid, text
) restrict;

revoke all on function public.vendor_finance_end_global_role_admin(
  uuid, uuid, uuid, integer, date, text, uuid, text
) from public, anon, authenticated, service_role;
drop function public.vendor_finance_end_global_role_admin(
  uuid, uuid, uuid, integer, date, text, uuid, text
) restrict;

revoke all on function public.vendor_finance_list_global_roles_admin(
  uuid, uuid, text, boolean, integer, integer
) from public, anon, authenticated, service_role;
drop function public.vendor_finance_list_global_roles_admin(
  uuid, uuid, text, boolean, integer, integer
) restrict;

revoke all on function public.leave_management_manage_module_grant_admin(
  uuid, uuid, text, uuid, text, integer, text, text, text
) from public, anon, authenticated, service_role;
drop function public.leave_management_manage_module_grant_admin(
  uuid, uuid, text, uuid, text, integer, text, text, text
) restrict;

-- ============================================================================
-- 5. DROP LEGACY CLASSIFICATION COLUMNS & CONSTRAINT (preserving audit CHECK history)
-- ============================================================================
alter table public.direct_entry_app_users
  drop constraint if exists direct_entry_app_users_account_type_chk;

alter table public.direct_entry_app_users
  drop column account_type;

alter table public.leave_employee_profiles
  drop column is_shared_non_employee;

-- ============================================================================
-- 6. PRESERVE INTERNAL BOOTSTRAP EXECUTOR GRANT
-- ============================================================================
grant execute on function public.leave_management__internal_resolve_authority(uuid, uuid)
  to direct_entry_catalog_bootstrap_executor;

commit;
