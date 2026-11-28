-- =============================================================================
-- Vendor Referrer Attribution (BoD-managed)
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. Capability ('vendor_referrer_manage') in authz_user_group_capabilities,
--      guard trigger & group admin RPCs (allowed ONLY on SYSTEM_ADMIN or
--      teamless MANAGEMENT_BOD department groups), seeded onto SYSTEM_ADMIN,
--      and exposed in direct_entry_resolve_actor_context(uuid).
--   2. Internal BoD & eligibility helpers (SECURITY DEFINER, locked search_path,
--      zero external EXECUTE grants):
--      - org_department__internal_user_is_active_bod(uuid, timestamptz)
--      - direct_entry_vendor_referrer__internal_assert_bod_actor(uuid, uuid, timestamptz)
--      - direct_entry_vendor_referrer__internal_person_is_eligible_hrp_recruiter(uuid, timestamptz)
--   3. Tables (ENABLE + FORCE RLS, 0 policies, REVOKE ALL):
--      - public.vendor_referrer_links (with non-overlap interval guard trigger)
--      - public.vendor_referrer_audit_events (append-only, idempotency unique)
--   4. 7 service_role-only RPCs:
--      - direct_entry_vendor_referrer_get_actor_access(uuid, uuid)
--      - direct_entry_vendor_referrer_list_candidates(uuid, uuid, text, integer)
--      - direct_entry_vendor_referrer_list_vendors(uuid, uuid, text, boolean, integer, integer)
--      - direct_entry_vendor_referrer_get_history(uuid, uuid, text)
--      - direct_entry_vendor_referrer_assign(uuid, uuid, text, uuid, date, uuid, text, text)
--      - direct_entry_vendor_referrer_revoke(uuid, uuid, text, date, uuid, text, text)
--      - direct_entry_vendor_referrer_monthly_report(uuid, uuid, text, uuid, text, text)
-- =============================================================================

begin;

-- =============================================================================
-- SECTION 1: Permission Group Capability (vendor_referrer_manage)
-- =============================================================================

alter table public.authz_user_group_capabilities
  drop constraint if exists authz_user_group_capabilities_cap_chk;

alter table public.authz_user_group_capabilities
  add constraint authz_user_group_capabilities_cap_chk check (capability in (
    'entry_create',
    'entry_own',
    'entry_team',
    'entry_admin',
    'entry_restore',
    'submission_create',
    'change_request_create',
    'change_review',
    'entry_privileged_edit',
    'employment_status.request',
    'employment_status.review',
    'employment_status.apply',
    'document_upload',
    'document_view',
    'recruiter_master_manage',
    'team_master_manage',
    'audit_view',
    'catalog_master_manage',
    'team_manager_assign',
    'report_form_manage',
    'report_assign',
    'report_view',
    'report_analytics_view',
    'report_review',
    'report_delegate',
    'vendor_finance_view',
    'vendor_finance_record',
    'duplicate_cccd_withdraw',
    'worker_edit_history_view',
    'bulletin_manage',
    'vendor_referrer_manage'
  ));

create or replace function public.direct_entry_authz__trg_guard_user_group_capability()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_group public.authz_user_groups%rowtype;
  v_dept_system_key text;
begin
  if tg_op = 'DELETE' then
    raise exception 'AUTHZ_GROUP_CAPABILITY_DELETE_FORBIDDEN' using errcode = '55000';
  end if;

  select g.* into v_group
    from public.authz_user_groups g
   where g.group_id = new.group_id;
  if not found then
    raise exception 'GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  if tg_op = 'UPDATE' then
    if old.ended_at is not null then
      raise exception 'AUTHZ_GROUP_CAPABILITY_HISTORY_IMMUTABLE' using errcode = '55000';
    end if;
    if old.group_id <> new.group_id
       or old.capability <> new.capability
       or old.started_at <> new.started_at then
      raise exception 'AUTHZ_GROUP_CAPABILITY_HISTORY_IMMUTABLE' using errcode = '55000';
    end if;
    if v_group.is_system_admin and new.ended_at is not null then
      raise exception 'GROUP_SYSTEM_ADMIN_IMMUTABLE' using errcode = 'PT409';
    end if;
    return new;
  end if;

  -- Enforce strict group capability ceilings on INSERT
  if v_group.is_system_admin then
    if new.capability in (
      'catalog_master_manage',
      'team_manager_assign',
      'report_form_manage',
      'report_assign',
      'report_review',
      'report_delegate',
      'vendor_finance_view',
      'vendor_finance_record'
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_SYSTEM_ADMIN' using errcode = '22023';
    end if;
  elsif v_group.team_id is not null then
    if new.capability not in (
      'entry_team',
      'team_manager_assign',
      'change_review',
      'report_view',
      'report_analytics_view',
      'report_assign',
      'report_review',
      'report_delegate',
      'worker_edit_history_view',
      'entry_create',
      'entry_own',
      'submission_create',
      'document_upload',
      'document_view',
      'change_request_create',
      'employment_status.request'
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP' using errcode = '22023';
    end if;
  else
    select d.system_key
      into v_dept_system_key
      from public.organization_departments d
     where d.department_id = v_group.department_id;

    if new.capability in (
      'entry_admin',
      'entry_team',
      'entry_restore',
      'entry_privileged_edit',
      'change_review',
      'employment_status.review',
      'employment_status.apply',
      'team_manager_assign',
      'report_view',
      'report_analytics_view',
      'vendor_finance_record'
    ) or (
      new.capability = 'vendor_referrer_manage'
      and coalesce(v_dept_system_key, '') <> 'MANAGEMENT_BOD'
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_DEPARTMENT_GROUP' using errcode = '22023';
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.direct_entry_authz__trg_guard_user_group_capability()
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_authz_create_group_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_code text,
  p_name text,
  p_description text,
  p_department_id uuid,
  p_team_id uuid,
  p_capabilities text[],
  p_module_roles jsonb,
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
  v_op text := 'AUTHZ_GROUP_CREATED';
  v_code text := upper(nullif(pg_catalog.btrim(p_code), ''));
  v_name text := nullif(pg_catalog.btrim(p_name), '');
  v_desc text := coalesce(pg_catalog.btrim(p_description), '');
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_dept public.organization_departments%rowtype;
  v_team public.teams%rowtype;
  v_existing_idem public.authz_group_idempotency%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_group public.authz_user_groups%rowtype;
  v_cap text;
  v_mr jsonb;
  v_mr_module text;
  v_mr_role text;
  v_result jsonb;
begin
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  if v_code is null or v_code !~ '^[A-Z][A-Z0-9_]{1,63}$' or v_code = 'SYSTEM_ADMIN' then
    raise exception 'GROUP_CODE_INVALID' using errcode = '22023';
  end if;
  if v_name is null or pg_catalog.length(v_name) not between 2 and 128 then
    raise exception 'GROUP_NAME_INVALID' using errcode = '22023';
  end if;
  if pg_catalog.length(v_desc) > 500 then
    raise exception 'GROUP_DESCRIPTION_INVALID' using errcode = '22023';
  end if;
  if p_department_id is null then
    raise exception 'GROUP_DEPARTMENT_REQUIRED' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_request_hash is null or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'AUTHZ_REASON_INVALID' using errcode = '22023';
  end if;
  if p_module_roles is not null and pg_catalog.jsonb_typeof(p_module_roles) <> 'array' then
    raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
  end if;

  -- Lock actor + idempotency slot
  perform 1
    from public.direct_entry_app_users u
   where u.app_user_id = p_actor_app_user_id
   for update;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select i.* into v_existing_idem
    from public.authz_group_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.operation_name = v_op
     and i.target_key = 'group_code:' || v_code
     and i.idempotency_key = p_idempotency_key::text
   for update;

  if found then
    if v_existing_idem.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id
     and d.is_active = true;
  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = '22023';
  end if;

  if p_team_id is not null then
    select t.* into v_team
      from public.teams t
     where t.team_id = p_team_id
       and t.active = true
       and t.code <> '__system_vendor__';
    if not found then
      raise exception 'TEAM_NOT_FOUND' using errcode = '22023';
    end if;
  end if;

  if exists (select 1 from public.authz_user_groups g where g.code = v_code) then
    raise exception 'GROUP_CODE_CONFLICT' using errcode = 'PT409';
  end if;

  insert into public.authz_user_groups (
    code, name, description, department_id, team_id, is_system_admin, active,
    version, created_by_app_user_id, updated_by_app_user_id, created_at, updated_at
  ) values (
    v_code, v_name, v_desc, p_department_id, p_team_id, false, true,
    1, p_actor_app_user_id, p_actor_app_user_id, v_now, v_now
  ) returning * into v_group;

  if p_capabilities is not null then
    for v_cap in
      select distinct nullif(pg_catalog.btrim(x), '')
        from unnest(p_capabilities) as x
       where nullif(pg_catalog.btrim(x), '') is not null
       order by 1 asc
    loop
      if p_team_id is not null then
        if v_cap not in (
          'entry_team', 'team_manager_assign', 'change_review',
          'report_view', 'report_analytics_view', 'report_assign',
          'report_review', 'report_delegate', 'worker_edit_history_view',
          'entry_create', 'entry_own', 'submission_create',
          'document_upload', 'document_view', 'change_request_create',
          'employment_status.request'
        ) then
          raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP' using errcode = '22023';
        end if;
      else
        if v_cap in (
          'entry_admin', 'entry_team', 'entry_restore', 'entry_privileged_edit',
          'change_review', 'employment_status.review', 'employment_status.apply',
          'team_manager_assign', 'report_view', 'report_analytics_view', 'vendor_finance_record'
        ) or (
          v_cap = 'vendor_referrer_manage'
          and coalesce(v_dept.system_key, '') <> 'MANAGEMENT_BOD'
        ) then
          raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_DEPARTMENT_GROUP' using errcode = '22023';
        end if;
      end if;

      insert into public.authz_user_group_capabilities (
        group_id, capability, started_at, granted_by_app_user_id, reason, created_at
      ) values (
        v_group.group_id, v_cap, v_now, p_actor_app_user_id, v_reason, v_now
      );
    end loop;
  end if;

  if p_module_roles is not null then
    for v_mr in
      select value from pg_catalog.jsonb_array_elements(p_module_roles)
    loop
      if pg_catalog.jsonb_typeof(v_mr) <> 'object' then
        raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
      end if;
      v_mr_module := nullif(pg_catalog.btrim(v_mr->>'module_code'), '');
      v_mr_role := nullif(pg_catalog.btrim(v_mr->>'role_code'), '');
      if v_mr_module is null or v_mr_role is null then
        raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
      end if;
      insert into public.authz_user_group_module_roles (
        group_id, module_code, role_code, started_at, granted_by_app_user_id, reason, created_at
      ) values (
        v_group.group_id, v_mr_module, v_mr_role, v_now, p_actor_app_user_id, v_reason, v_now
      )
      on conflict (group_id, module_code, role_code) where ended_at is null do nothing;
    end loop;
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'group_id', v_group.group_id,
    'code', v_group.code,
    'name', v_group.name,
    'description', v_group.description,
    'department_id', v_group.department_id,
    'team_id', v_group.team_id,
    'is_system_admin', v_group.is_system_admin,
    'active', v_group.active,
    'version', v_group.version,
    'capabilities', coalesce((
      select pg_catalog.jsonb_agg(gc.capability order by gc.capability asc)
        from public.authz_user_group_capabilities gc
       where gc.group_id = v_group.group_id and gc.ended_at is null
    ), '[]'::jsonb),
    'module_roles', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('module_code', mr.module_code, 'role_code', mr.role_code)
        order by mr.module_code asc, mr.role_code asc
      )
        from public.authz_user_group_module_roles mr
       where mr.group_id = v_group.group_id and mr.ended_at is null
    ), '[]'::jsonb),
    'replayed', false
  );

  insert into public.authz_group_audit_events (
    actor_auth_subject, actor_app_user_id, group_id, operation_name,
    before_payload, after_payload, reason, created_at
  ) values (
    p_auth_subject, p_actor_app_user_id, v_group.group_id, v_op,
    null, v_result, v_reason, v_now
  );

  insert into public.authz_group_idempotency (
    actor_app_user_id, operation_name, target_key, idempotency_key,
    request_hash, response_payload, created_at
  ) values (
    p_actor_app_user_id, v_op, 'group_code:' || v_code, p_idempotency_key::text,
    p_request_hash, v_result, v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.direct_entry_authz_create_group_admin(uuid, uuid, text, text, text, uuid, uuid, text[], jsonb, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_create_group_admin(uuid, uuid, text, text, text, uuid, uuid, text[], jsonb, text, uuid, text)
  to service_role;

create or replace function public.direct_entry_authz_update_group_admin(
  p_auth_subject uuid,
  p_actor_app_user_id uuid,
  p_group_id uuid,
  p_expected_version integer,
  p_name text,
  p_description text,
  p_department_id uuid,
  p_team_id uuid,
  p_active boolean,
  p_capabilities text[],
  p_module_roles jsonb,
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
  v_op text := 'AUTHZ_GROUP_UPDATED';
  v_name text := nullif(pg_catalog.btrim(p_name), '');
  v_desc text := coalesce(pg_catalog.btrim(p_description), '');
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_existing_idem public.authz_group_idempotency%rowtype;
  v_group public.authz_user_groups%rowtype;
  v_dept public.organization_departments%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_before jsonb;
  v_new_caps text[];
  v_cap text;
  v_mr jsonb;
  v_mr_module text;
  v_mr_role text;
  v_mr_pairs text[] := array[]::text[];
  v_member_id uuid;
  v_result jsonb;
begin
  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  if p_group_id is null
     or p_expected_version is null
     or p_expected_version < 1
     or p_department_id is null
     or p_active is null
     or p_idempotency_key is null
     or p_request_hash is null
     or p_request_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'AUTHZ_VALIDATION_ERROR' using errcode = '22023';
  end if;
  if v_name is null or pg_catalog.length(v_name) not between 2 and 128 then
    raise exception 'GROUP_NAME_INVALID' using errcode = '22023';
  end if;
  if pg_catalog.length(v_desc) > 500 then
    raise exception 'GROUP_DESCRIPTION_INVALID' using errcode = '22023';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) not between 3 and 500 then
    raise exception 'AUTHZ_REASON_INVALID' using errcode = '22023';
  end if;
  if p_module_roles is not null and pg_catalog.jsonb_typeof(p_module_roles) <> 'array' then
    raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
  end if;

  select g.* into v_group
    from public.authz_user_groups g
   where g.group_id = p_group_id
   for update;

  if not found then
    raise exception 'GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  for v_member_id in
    select u.app_user_id
      from public.direct_entry_app_users u
     where u.app_user_id = p_actor_app_user_id
        or u.app_user_id in (
          select m.app_user_id
            from public.authz_user_group_members m
           where m.group_id = p_group_id
             and m.ended_at is null
        )
     order by u.app_user_id asc
     for update
  loop
    null;
  end loop;

  perform public.direct_entry_authz__internal_assert_full_admin(p_auth_subject, p_actor_app_user_id);

  select i.* into v_existing_idem
    from public.authz_group_idempotency i
   where i.actor_app_user_id = p_actor_app_user_id
     and i.operation_name = v_op
     and i.target_key = 'group:' || p_group_id::text
     and i.idempotency_key = p_idempotency_key::text
   for update;

  if found then
    if v_existing_idem.request_hash <> p_request_hash then
      raise exception 'IDEMPOTENCY_CONFLICT' using errcode = 'PT409';
    end if;
    return v_existing_idem.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if v_group.version <> p_expected_version then
    raise exception 'VERSION_CONFLICT'
      using errcode = 'PT409',
            detail = pg_catalog.jsonb_build_object('current_version', v_group.version)::text;
  end if;

  if v_group.is_system_admin then
    raise exception 'GROUP_SYSTEM_ADMIN_IMMUTABLE' using errcode = 'PT409';
  end if;

  select d.* into v_dept
    from public.organization_departments d
   where d.department_id = p_department_id
     and d.is_active = true;
  if not found then
    raise exception 'DEPARTMENT_NOT_FOUND' using errcode = '22023';
  end if;

  if p_team_id is not null and not exists (
    select 1 from public.teams t
     where t.team_id = p_team_id and t.active = true and t.code <> '__system_vendor__'
  ) then
    raise exception 'TEAM_NOT_FOUND' using errcode = '22023';
  end if;

  v_before := pg_catalog.jsonb_build_object(
    'group_id', v_group.group_id,
    'name', v_group.name,
    'description', v_group.description,
    'department_id', v_group.department_id,
    'team_id', v_group.team_id,
    'active', v_group.active,
    'version', v_group.version,
    'capabilities', coalesce((
      select pg_catalog.jsonb_agg(gc.capability order by gc.capability asc)
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id and gc.ended_at is null
    ), '[]'::jsonb),
    'module_roles', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('module_code', mr.module_code, 'role_code', mr.role_code)
        order by mr.module_code asc, mr.role_code asc
      )
        from public.authz_user_group_module_roles mr
       where mr.group_id = p_group_id and mr.ended_at is null
    ), '[]'::jsonb)
  );

  update public.authz_user_groups g
     set name = v_name,
         description = v_desc,
         department_id = p_department_id,
         team_id = p_team_id,
         active = p_active,
         version = g.version + 1,
         updated_by_app_user_id = p_actor_app_user_id,
         updated_at = v_now
   where g.group_id = p_group_id
  returning * into v_group;

  v_new_caps := coalesce(
    array(
      select distinct nullif(pg_catalog.btrim(x), '')
        from unnest(coalesce(p_capabilities, array[]::text[])) as x
       where nullif(pg_catalog.btrim(x), '') is not null
       order by 1 asc
    ),
    array[]::text[]
  );

  update public.authz_user_group_capabilities gc
     set ended_at = v_now,
         ended_by_app_user_id = p_actor_app_user_id
   where gc.group_id = p_group_id
     and gc.ended_at is null
     and not (gc.capability = any(v_new_caps));

  foreach v_cap in array v_new_caps loop
    insert into public.authz_user_group_capabilities (
      group_id, capability, started_at, granted_by_app_user_id, reason, created_at
    ) values (
      p_group_id, v_cap, v_now, p_actor_app_user_id, v_reason, v_now
    )
    on conflict (group_id, capability) where ended_at is null do nothing;
  end loop;

  if p_team_id is not null then
    if exists (
      select 1
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id
         and gc.ended_at is null
         and gc.capability not in (
           'entry_team', 'team_manager_assign', 'change_review',
           'report_view', 'report_analytics_view', 'report_assign',
           'report_review', 'report_delegate', 'worker_edit_history_view',
           'entry_create', 'entry_own', 'submission_create',
           'document_upload', 'document_view', 'change_request_create',
           'employment_status.request'
         )
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_TEAM_GROUP' using errcode = '22023';
    end if;
  else
    if exists (
      select 1
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id
         and gc.ended_at is null
         and (
           gc.capability in (
             'entry_admin', 'entry_team', 'entry_restore', 'entry_privileged_edit',
             'change_review', 'employment_status.review', 'employment_status.apply',
             'team_manager_assign', 'report_view', 'report_analytics_view', 'vendor_finance_record'
           )
           or (
             gc.capability = 'vendor_referrer_manage'
             and coalesce(v_dept.system_key, '') <> 'MANAGEMENT_BOD'
           )
         )
    ) then
      raise exception 'GROUP_CAPABILITY_FORBIDDEN_FOR_DEPARTMENT_GROUP' using errcode = '22023';
    end if;
  end if;

  if p_module_roles is not null then
    for v_mr in
      select value from pg_catalog.jsonb_array_elements(p_module_roles)
    loop
      if pg_catalog.jsonb_typeof(v_mr) <> 'object' then
        raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
      end if;
      v_mr_module := nullif(pg_catalog.btrim(v_mr->>'module_code'), '');
      v_mr_role := nullif(pg_catalog.btrim(v_mr->>'role_code'), '');
      if v_mr_module is null or v_mr_role is null then
        raise exception 'GROUP_MODULE_ROLES_INVALID' using errcode = '22023';
      end if;
      v_mr_pairs := array_append(v_mr_pairs, v_mr_module || ':' || v_mr_role);
    end loop;
  end if;

  update public.authz_user_group_module_roles mr
     set ended_at = v_now,
         ended_by_app_user_id = p_actor_app_user_id
   where mr.group_id = p_group_id
     and mr.ended_at is null
     and not ((mr.module_code || ':' || mr.role_code) = any(v_mr_pairs));

  if p_module_roles is not null then
    for v_mr in
      select value from pg_catalog.jsonb_array_elements(p_module_roles)
    loop
      v_mr_module := nullif(pg_catalog.btrim(v_mr->>'module_code'), '');
      v_mr_role := nullif(pg_catalog.btrim(v_mr->>'role_code'), '');
      insert into public.authz_user_group_module_roles (
        group_id, module_code, role_code, started_at, granted_by_app_user_id, reason, created_at
      ) values (
        p_group_id, v_mr_module, v_mr_role, v_now, p_actor_app_user_id, v_reason, v_now
      )
      on conflict (group_id, module_code, role_code) where ended_at is null do nothing;
    end loop;
  end if;

  if p_team_id is not null and exists (
    select 1
      from public.authz_user_group_module_roles mr
     where mr.group_id = p_group_id and mr.ended_at is null
  ) then
    raise exception 'GROUP_MODULE_ROLE_FORBIDDEN_FOR_TEAM_GROUP' using errcode = '22023';
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'group_id', v_group.group_id,
    'code', v_group.code,
    'name', v_group.name,
    'description', v_group.description,
    'department_id', v_group.department_id,
    'team_id', v_group.team_id,
    'is_system_admin', v_group.is_system_admin,
    'active', v_group.active,
    'version', v_group.version,
    'capabilities', coalesce((
      select pg_catalog.jsonb_agg(gc.capability order by gc.capability asc)
        from public.authz_user_group_capabilities gc
       where gc.group_id = p_group_id and gc.ended_at is null
    ), '[]'::jsonb),
    'module_roles', coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('module_code', mr.module_code, 'role_code', mr.role_code)
        order by mr.module_code asc, mr.role_code asc
      )
        from public.authz_user_group_module_roles mr
       where mr.group_id = p_group_id and mr.ended_at is null
    ), '[]'::jsonb),
    'replayed', false
  );

  insert into public.authz_group_audit_events (
    actor_auth_subject, actor_app_user_id, group_id, operation_name,
    before_payload, after_payload, reason, created_at
  ) values (
    p_auth_subject, p_actor_app_user_id, p_group_id, v_op,
    v_before, v_result, v_reason, v_now
  );

  insert into public.authz_group_idempotency (
    actor_app_user_id, operation_name, target_key, idempotency_key,
    request_hash, response_payload, created_at
  ) values (
    p_actor_app_user_id, v_op, 'group:' || p_group_id::text, p_idempotency_key::text,
    p_request_hash, v_result, v_now
  );

  return v_result;
end;
$function$;

revoke all on function public.direct_entry_authz_update_group_admin(uuid, uuid, uuid, integer, text, text, uuid, uuid, boolean, text[], jsonb, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_authz_update_group_admin(uuid, uuid, uuid, integer, text, text, uuid, uuid, boolean, text[], jsonb, text, uuid, text)
  to service_role;

-- Seed 'vendor_referrer_manage' onto active SYSTEM_ADMIN group
insert into public.authz_user_group_capabilities (group_id, capability, reason)
select g.group_id, 'vendor_referrer_manage', 'Bổ sung quyền Quản lý người giới thiệu NCC cho nhóm BoD/Admin'
  from public.authz_user_groups g
 where g.is_system_admin = true
   and g.active = true
on conflict (group_id, capability) where ended_at is null do nothing;

-- Update direct_entry_resolve_actor_context(uuid) adding 'vendor_referrer_manage'
create or replace function public.direct_entry_resolve_actor_context(
  p_auth_subject uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_app_user_id uuid;
  v_enabled boolean;
  v_authz_managed boolean := false;
  v_capabilities jsonb := '[]'::jsonb;
  v_recruiter_links jsonb := '[]'::jsonb;
  v_teams jsonb := '[]'::jsonb;
  v_team_scope_grants jsonb := '[]'::jsonb;
  v_all_scope_grants jsonb := '[]'::jsonb;
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

  if not v_authz_managed then
    raise exception 'actor account is not authz managed' using errcode = '42501';
  end if;

  if v_enabled then
    v_effective_grants := public.direct_entry_authz__internal_resolve_effective_grants(v_app_user_id);

    with valid_paired_grants as (
      select
        g.capability,
        g.scope_kind,
        g.scope_id
      from pg_catalog.jsonb_to_recordset(v_effective_grants) as g(
        capability text,
        scope_kind text,
        scope_id text
      )
      where (
        (
          g.capability in ('entry_create', 'submission_create', 'employment_status.request')
          and g.scope_kind in ('OWN', 'ALL')
          and g.scope_id is null
        )
        or (
          g.capability = 'entry_own'
          and g.scope_kind = 'OWN'
          and g.scope_id is null
        )
        or (
          g.capability in (
            'entry_team',
            'change_review',
            'report_assign',
            'report_view',
            'report_analytics_view',
            'report_review',
            'report_delegate'
          )
          and (
            (g.scope_kind = 'ALL' and g.scope_id is null)
            or (
              g.scope_kind = 'CONTEXT_TEAM'
              and g.scope_id is not null
              and pg_catalog.btrim(g.scope_id) <> ''
            )
          )
        )
        or (
          g.capability in (
            'entry_admin',
            'employment_status.review',
            'recruiter_master_manage',
            'team_master_manage',
            'audit_view',
            'entry_restore',
            'catalog_master_manage',
            'report_form_manage',
            'vendor_finance_view',
            'vendor_finance_record',
            'duplicate_cccd_withdraw',
            'worker_edit_history_view',
            'bulletin_manage',
            'vendor_referrer_manage'
          )
          and g.scope_kind = 'ALL'
          and g.scope_id is null
        )
        or (
          g.capability in ('change_request_create', 'document_upload', 'document_view')
          and (
            (g.scope_kind in ('OWN', 'ALL') and g.scope_id is null)
            or (
              g.scope_kind in ('CONTEXT_TEAM', 'CONTEXT_PROJECT')
              and g.scope_id is not null
              and pg_catalog.btrim(g.scope_id) <> ''
            )
          )
        )
        or (
          g.capability in ('entry_privileged_edit', 'employment_status.apply')
          and (
            (g.scope_kind in ('OWN', 'ALL') and g.scope_id is null)
            or (
              g.scope_kind = 'CONTEXT_TEAM'
              and g.scope_id is not null
              and pg_catalog.btrim(g.scope_id) <> ''
            )
          )
        )
        or (
          g.capability = 'team_manager_assign'
          and g.scope_kind = 'CONTEXT_TEAM'
          and g.scope_id is not null
          and pg_catalog.btrim(g.scope_id) <> ''
        )
      )
    ),
    valid_active_teams as (
      select distinct
        t.team_id,
        t.code,
        t.display_name,
        t.active
      from valid_paired_grants pg
      join public.teams t
        on t.team_id::text = pg.scope_id
       and t.active
       and t.code <> '__system_vendor__'
      where pg.scope_kind = 'CONTEXT_TEAM'
    )
    select
      coalesce((
        select pg_catalog.jsonb_agg(distinct pg.capability order by pg.capability)
          from valid_paired_grants pg
      ), '[]'::jsonb),
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'team_id', vt.team_id,
            'code', vt.code,
            'display', vt.display_name,
            'active', vt.active
          )
          order by vt.team_id
        )
          from valid_active_teams vt
      ), '[]'::jsonb),
      coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'team_id', vt.team_id,
            'valid_from', v_today::text,
            'valid_to', null
          )
          order by vt.team_id
        )
          from valid_active_teams vt
      ), '[]'::jsonb),
      case
        when exists (
          select 1
            from valid_paired_grants pg
           where pg.scope_kind = 'ALL'
             and pg.scope_id is null
        )
        then pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'valid_from', v_today::text,
            'valid_to', null
          )
        )
        else '[]'::jsonb
      end
    into v_capabilities, v_teams, v_team_scope_grants, v_all_scope_grants;

    select coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'app_user_id', l.app_user_id,
          'recruiter_id', l.recruiter_id,
          'verified', l.verified,
          'valid_from', l.valid_from,
          'valid_to', l.valid_to
        )
        order by l.valid_from, l.recruiter_id
      )
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r
          on r.recruiter_id = l.recruiter_id
         and r.active
       where l.app_user_id = v_app_user_id
         and l.verified
         and l.is_current
    ), '[]'::jsonb)
      into v_recruiter_links;

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

    select coalesce(
      jsonb_agg(t.tab_id order by t.ord),
      '[]'::jsonb
    )
    into v_allowed_worker_tabs
    from (
      select 'uploader'::text as tab_id, 1 as ord
       where public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'submission_create', 'OWN', null)
          or public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'submission_create', 'ALL', null)
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
            and l.valid_from <= v_today
            and (l.valid_to is null or (l.valid_to > l.valid_from and v_today < l.valid_to))
       )
      union all
      select 'managed'::text as tab_id, 3 as ord
       where public.direct_entry_actor_has_project_assignment(v_app_user_id)
      union all
      select 'team'::text as tab_id, 4 as ord
       where v_team_leader_team_id is not null
      union all
      select 'all'::text as tab_id, 5 as ord
       where public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'entry_admin', 'ALL', null)
          or public.direct_entry_authz__internal_has_paired_capability(v_app_user_id, 'change_review', 'ALL', null)
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
      ) ar
      where ar.role_code is not null;
  end if;

  return (
    select pg_catalog.jsonb_build_object(
      'auth_subject', u.auth_subject,
      'app_user_id', u.app_user_id,
      'display_name', u.display_name,
      'enabled', u.enabled,
      'capabilities', coalesce(v_capabilities, '[]'::jsonb),
      'recruiter_links', coalesce(v_recruiter_links, '[]'::jsonb),
      'teams', coalesce(v_teams, '[]'::jsonb),
      'team_scope_grants', coalesce(v_team_scope_grants, '[]'::jsonb),
      'all_scope_grants', coalesce(v_all_scope_grants, '[]'::jsonb),
      'allowed_worker_tabs', coalesce(v_allowed_worker_tabs, '[]'::jsonb),
      'effective_grants', coalesce(v_effective_grants, '[]'::jsonb),
      'assigned_roles', coalesce(v_assigned_roles, '[]'::jsonb)
    ) || case
      when pg_catalog.jsonb_array_length(v_review_scopes) > 0
        then pg_catalog.jsonb_build_object('effective_report_review_scopes', v_review_scopes)
      else '{}'::jsonb
    end
    from public.direct_entry_app_users u
    where u.app_user_id = v_app_user_id
  );
end;
$function$;

revoke all on function public.direct_entry_resolve_actor_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_resolve_actor_context(uuid)
  to service_role;

-- =============================================================================
-- SECTION 2: Internal BoD & Eligibility Helpers
-- =============================================================================

create or replace function public.org_department__internal_user_is_active_bod(
  p_app_user_id uuid,
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
  if p_app_user_id is null then
    return false;
  end if;

  return exists (
    select 1
      from public.direct_entry_app_users u
      join public.organization_account_person_links l
        on l.app_user_id = u.app_user_id
       and l.ended_at is null
      join public.organization_persons p
        on p.person_id = l.person_id
       and p.status = 'ACTIVE'
      join public.organization_person_department_memberships m
        on m.person_id = p.person_id
       and m.ended_at is null
       and m.started_at <= v_as_of
      join public.organization_departments d
        on d.department_id = m.department_id
       and d.is_active = true
       and d.system_key = 'MANAGEMENT_BOD'
     where u.app_user_id = p_app_user_id
       and u.enabled = true
       and coalesce(u.authz_managed, false) = true
  );
end;
$function$;

revoke all on function public.org_department__internal_user_is_active_bod(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_vendor_referrer__internal_assert_bod_actor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_as_of timestamptz default pg_catalog.clock_timestamp()
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if not (
    public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, 'vendor_referrer_manage', 'ALL', null
    )
    and public.org_department__internal_user_is_active_bod(p_app_user_id, v_as_of)
  ) then
    raise exception 'VENDOR_REFERRER_BOD_REQUIRED' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function public.direct_entry_vendor_referrer__internal_assert_bod_actor(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_vendor_referrer__internal_person_is_eligible_hrp_recruiter(
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
  v_today date := (v_as_of at time zone 'Asia/Ho_Chi_Minh')::date;
  v_recruiter_id uuid;
begin
  if p_person_id is null then
    return false;
  end if;

  select p.recruiter_id
    into v_recruiter_id
    from public.organization_persons p
   where p.person_id = p_person_id
     and p.status = 'ACTIVE'
     and p.recruiter_id is not null;

  if not found or v_recruiter_id is null then
    return false;
  end if;

  if not public.org_department__internal_person_is_active_in_org(p_person_id, v_as_of) then
    return false;
  end if;

  if not exists (
    select 1
      from public.recruiters r
      join public.recruiter_provider_memberships rpm
        on rpm.recruiter_id = r.recruiter_id
       and rpm.provider_type = 'hrp'
       and rpm.vendor_id is null
       and rpm.is_current = true
       and rpm.valid_from <= v_today
       and (rpm.valid_to is null or v_today < rpm.valid_to)
     where r.recruiter_id = v_recruiter_id
       and r.active = true
  ) then
    return false;
  end if;

  return coalesce(
    public.org_department__internal_recruiter_org_allows_recruitment_team(
      v_recruiter_id, null, v_as_of
    ),
    false
  );
end;
$function$;

revoke all on function public.direct_entry_vendor_referrer__internal_person_is_eligible_hrp_recruiter(uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- =============================================================================
-- SECTION 3: Tables, Constraints, Indexes, Triggers & Strict RLS
-- =============================================================================

create table if not exists public.vendor_referrer_links (
  link_id uuid primary key default gen_random_uuid(),
  vendor_id text not null
    references public.vendors(vendor_id) on delete restrict
    constraint vendor_referrer_links_vendor_chk check (vendor_id <> '__system_vendor__'),
  referrer_person_id uuid not null
    references public.organization_persons(person_id) on delete restrict,
  effective_from date not null,
  effective_to date null,
  is_current boolean not null default true,
  reason text not null
    constraint vendor_referrer_links_reason_chk check (
      reason = pg_catalog.btrim(reason)
      and pg_catalog.length(reason) between 1 and 4000
      and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  created_by_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  ended_by_app_user_id uuid null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  ended_at timestamptz null,
  ended_reason text null
    constraint vendor_referrer_links_ended_reason_chk check (
      ended_reason is null
      or (
        ended_reason = pg_catalog.btrim(ended_reason)
        and pg_catalog.length(ended_reason) between 1 and 4000
        and ended_reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
      )
    ),
  constraint vendor_referrer_links_interval_chk check (
    effective_to is null or effective_to >= effective_from
  ),
  constraint vendor_referrer_links_state_chk check (
    (
      is_current
      and effective_to is null
      and ended_at is null
      and ended_by_app_user_id is null
      and ended_reason is null
    )
    or (
      not is_current
      and effective_to is not null
      and ended_at is not null
      and ended_by_app_user_id is not null
      and ended_reason is not null
    )
  )
);

create unique index if not exists vendor_referrer_links_current_vendor_uidx
  on public.vendor_referrer_links (vendor_id)
  where is_current = true;

create index if not exists vendor_referrer_links_vendor_dates_idx
  on public.vendor_referrer_links (vendor_id, effective_from, effective_to);

create index if not exists vendor_referrer_links_person_current_idx
  on public.vendor_referrer_links (referrer_person_id, is_current, effective_from);

alter table public.vendor_referrer_links enable row level security;
alter table public.vendor_referrer_links force row level security;
revoke all on table public.vendor_referrer_links
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_vendor_referrer__internal_guard_link()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'VENDOR_REFERRER_LINK_DELETE_FORBIDDEN' using errcode = '55000';
  end if;

  if tg_op = 'UPDATE' then
    if not old.is_current then
      raise exception 'VENDOR_REFERRER_LINK_HISTORY_IMMUTABLE' using errcode = '55000';
    end if;
    if new.link_id <> old.link_id
       or new.vendor_id <> old.vendor_id
       or new.referrer_person_id <> old.referrer_person_id
       or new.effective_from <> old.effective_from
       or new.created_by_app_user_id <> old.created_by_app_user_id
       or new.created_at <> old.created_at then
      raise exception 'VENDOR_REFERRER_LINK_IMMUTABLE' using errcode = '55000';
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vendor-referrer:' || new.vendor_id, 0)
  );

  if exists (
    select 1
      from public.vendor_referrer_links l
     where l.vendor_id = new.vendor_id
       and l.link_id <> new.link_id
       and pg_catalog.daterange(l.effective_from, l.effective_to, '[)')
           && pg_catalog.daterange(new.effective_from, new.effective_to, '[)')
  ) then
    raise exception 'VENDOR_REFERRER_LINK_OVERLAP' using errcode = '23P01';
  end if;

  return new;
end;
$function$;

revoke all on function public.direct_entry_vendor_referrer__internal_guard_link()
  from public, anon, authenticated, service_role;

drop trigger if exists vendor_referrer_links_interval_guard_trg on public.vendor_referrer_links;
create trigger vendor_referrer_links_interval_guard_trg
  before insert or update or delete on public.vendor_referrer_links
  for each row execute function public.direct_entry_vendor_referrer__internal_guard_link();

create table if not exists public.vendor_referrer_audit_events (
  event_id uuid primary key default gen_random_uuid(),
  vendor_id text not null
    references public.vendors(vendor_id) on delete restrict,
  action text not null
    constraint vendor_referrer_audit_events_action_chk
    check (action in ('ASSIGN', 'REPLACE', 'REVOKE')),
  link_id uuid null
    references public.vendor_referrer_links(link_id) on delete restrict,
  previous_link_id uuid null
    references public.vendor_referrer_links(link_id) on delete restrict,
  referrer_person_id uuid null
    references public.organization_persons(person_id) on delete restrict,
  previous_referrer_person_id uuid null
    references public.organization_persons(person_id) on delete restrict,
  effective_date date not null,
  actor_app_user_id uuid not null
    references public.direct_entry_app_users(app_user_id) on delete restrict,
  reason text not null
    constraint vendor_referrer_audit_events_reason_chk check (
      reason = pg_catalog.btrim(reason)
      and pg_catalog.length(reason) between 1 and 4000
      and reason !~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'
    ),
  idempotency_key text not null
    constraint vendor_referrer_audit_events_idempotency_key_chk
    check (idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_fingerprint text not null,
  response_payload jsonb not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint vendor_referrer_audit_events_actor_idem_uk unique (actor_app_user_id, idempotency_key)
);

create index if not exists vendor_referrer_audit_events_vendor_idx
  on public.vendor_referrer_audit_events (vendor_id, created_at desc, event_id desc);

alter table public.vendor_referrer_audit_events enable row level security;
alter table public.vendor_referrer_audit_events force row level security;
revoke all on table public.vendor_referrer_audit_events
  from public, anon, authenticated, service_role;

drop trigger if exists vendor_referrer_audit_events_immutable_trg on public.vendor_referrer_audit_events;
create trigger vendor_referrer_audit_events_immutable_trg
  before update or delete on public.vendor_referrer_audit_events
  for each row execute function public.direct_entry_reject_immutable_change();

-- =============================================================================
-- SECTION 4: 7 Service-Role-Only RPCs
-- =============================================================================

-- 4.1 direct_entry_vendor_referrer_get_actor_access
create or replace function public.direct_entry_vendor_referrer_get_actor_access(
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
  v_has_capability boolean := false;
  v_is_active_bod boolean := false;
  v_can_manage boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  v_has_capability := coalesce(
    public.direct_entry_authz__internal_has_paired_capability(
      p_app_user_id, 'vendor_referrer_manage', 'ALL', null
    ),
    false
  );
  v_is_active_bod := coalesce(
    public.org_department__internal_user_is_active_bod(
      p_app_user_id, pg_catalog.clock_timestamp()
    ),
    false
  );
  v_can_manage := (v_has_capability and v_is_active_bod);

  return pg_catalog.jsonb_build_object(
    'can_manage', v_can_manage,
    'can_view_report', v_can_manage,
    'has_capability', v_has_capability,
    'is_active_bod', v_is_active_bod
  );
end;
$function$;

revoke all on function public.direct_entry_vendor_referrer_get_actor_access(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_vendor_referrer_get_actor_access(uuid, uuid)
  to service_role;

-- 4.2 direct_entry_vendor_referrer_list_candidates
create or replace function public.direct_entry_vendor_referrer_list_candidates(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_limit integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_search text := null;
  v_search_lower text := null;
  v_items jsonb := '[]'::jsonb;
  v_total integer := 0;
begin
  perform public.direct_entry_vendor_referrer__internal_assert_bod_actor(
    p_auth_subject, p_app_user_id, v_now
  );

  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'VENDOR_REFERRER_QUERY_INVALID' using errcode = '22023';
  end if;

  if p_search is not null then
    if p_search ~ '[\x00-\x1F\x7F]' or pg_catalog.length(pg_catalog.btrim(p_search)) > 120 then
      raise exception 'VENDOR_REFERRER_SEARCH_INVALID' using errcode = '22023';
    end if;
    v_search := nullif(pg_catalog.btrim(p_search), '');
    if v_search is not null then
      v_search_lower := pg_catalog.lower(v_search);
    end if;
  end if;

  with eligible as (
    select
      p.person_id,
      p.employee_code,
      p.full_name,
      d.department_id,
      d.name as department_name,
      d.system_key as department_system_key,
      r.recruiter_id,
      r.display_name as recruiter_display_name,
      r.personnel_code
    from public.organization_persons p
    join public.organization_person_department_memberships m
      on m.person_id = p.person_id
     and m.ended_at is null
     and m.started_at <= v_now
    join public.organization_departments d
      on d.department_id = m.department_id
     and d.is_active = true
    join public.recruiters r
      on r.recruiter_id = p.recruiter_id
     and r.active = true
   where p.status = 'ACTIVE'
     and p.recruiter_id is not null
     and public.direct_entry_vendor_referrer__internal_person_is_eligible_hrp_recruiter(p.person_id, v_now)
     and (
       v_search_lower is null
       or pg_catalog.strpos(pg_catalog.lower(p.employee_code), v_search_lower) > 0
       or pg_catalog.strpos(pg_catalog.lower(p.full_name), v_search_lower) > 0
       or pg_catalog.strpos(pg_catalog.lower(coalesce(r.personnel_code, '')), v_search_lower) > 0
       or pg_catalog.strpos(pg_catalog.lower(r.display_name), v_search_lower) > 0
       or pg_catalog.strpos(pg_catalog.lower(d.name), v_search_lower) > 0
     )
  ),
  limited as (
    select e.*
      from eligible e
     order by pg_catalog.lower(e.full_name) asc, pg_catalog.lower(e.employee_code) asc, e.person_id asc
     limit p_limit
  )
  select
    (select count(*)::integer from eligible),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'person_id', l.person_id,
          'employee_code', l.employee_code,
          'full_name', l.full_name,
          'department_id', l.department_id,
          'department_name', l.department_name,
          'department_system_key', l.department_system_key,
          'recruiter_id', l.recruiter_id,
          'recruiter_display_name', l.recruiter_display_name,
          'personnel_code', l.personnel_code
        )
        order by pg_catalog.lower(l.full_name) asc, pg_catalog.lower(l.employee_code) asc, l.person_id asc
      )
        from limited l
    ), '[]'::jsonb)
    into v_total, v_items;

  return pg_catalog.jsonb_build_object(
    'items', coalesce(v_items, '[]'::jsonb),
    'total', coalesce(v_total, 0),
    'authorization_date', v_today::text
  );
end;
$function$;

revoke all on function public.direct_entry_vendor_referrer_list_candidates(uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_vendor_referrer_list_candidates(uuid, uuid, text, integer)
  to service_role;

-- 4.3 direct_entry_vendor_referrer_list_vendors
create or replace function public.direct_entry_vendor_referrer_list_vendors(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_include_inactive boolean default false,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_search text := null;
  v_search_lower text := null;
  v_offset integer;
  v_total integer := 0;
  v_items jsonb := '[]'::jsonb;
begin
  perform public.direct_entry_vendor_referrer__internal_assert_bod_actor(
    p_auth_subject, p_app_user_id, v_now
  );

  if p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'VENDOR_REFERRER_QUERY_INVALID' using errcode = '22023';
  end if;

  if p_search is not null then
    if p_search ~ '[\x00-\x1F\x7F]' or pg_catalog.length(pg_catalog.btrim(p_search)) > 120 then
      raise exception 'VENDOR_REFERRER_SEARCH_INVALID' using errcode = '22023';
    end if;
    v_search := nullif(pg_catalog.btrim(p_search), '');
    if v_search is not null then
      v_search_lower := pg_catalog.lower(v_search);
    end if;
  end if;

  v_offset := (p_page - 1) * p_page_size;

  with vendor_rows as (
    select
      v.vendor_id,
      v.display_name,
      v.active,
      v.version,
      cl.link_id as current_link_id,
      cl.referrer_person_id as current_referrer_person_id,
      cp.employee_code as current_referrer_employee_code,
      cp.full_name as current_referrer_full_name,
      cd.name as current_referrer_department_name,
      cl.effective_from as current_effective_from,
      cl.reason as current_reason,
      cl.created_at as current_created_at,
      (
        select count(*)::integer
          from public.vendor_referrer_links l_hist
         where l_hist.vendor_id = v.vendor_id
      ) as history_count
    from public.vendors v
    left join public.vendor_referrer_links cl
      on cl.vendor_id = v.vendor_id
     and cl.is_current = true
    left join public.organization_persons cp
      on cp.person_id = cl.referrer_person_id
    left join public.organization_person_department_memberships cm
      on cm.person_id = cp.person_id
     and cm.ended_at is null
    left join public.organization_departments cd
      on cd.department_id = cm.department_id
   where v.vendor_id <> '__system_vendor__'
     and (coalesce(p_include_inactive, false) or v.active = true)
     and (
       v_search_lower is null
       or pg_catalog.strpos(pg_catalog.lower(v.vendor_id), v_search_lower) > 0
       or pg_catalog.strpos(pg_catalog.lower(v.display_name), v_search_lower) > 0
       or pg_catalog.strpos(pg_catalog.lower(coalesce(cp.employee_code, '')), v_search_lower) > 0
       or pg_catalog.strpos(pg_catalog.lower(coalesce(cp.full_name, '')), v_search_lower) > 0
     )
  ),
  paged as (
    select vr.*
      from vendor_rows vr
     order by (vr.active = false) asc, pg_catalog.lower(vr.display_name) asc, vr.vendor_id asc
     limit p_page_size offset v_offset
  )
  select
    (select count(*)::integer from vendor_rows),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'vendor_id', p.vendor_id,
          'display_name', p.display_name,
          'active', p.active,
          'version', p.version,
          'current_link', case
            when p.current_link_id is null then null
            else pg_catalog.jsonb_build_object(
              'link_id', p.current_link_id,
              'referrer_person_id', p.current_referrer_person_id,
              'referrer_employee_code', p.current_referrer_employee_code,
              'referrer_full_name', p.current_referrer_full_name,
              'referrer_department_name', p.current_referrer_department_name,
              'effective_from', p.current_effective_from::text,
              'reason', p.current_reason,
              'created_at', public.org_department__internal_iso_utc(p.current_created_at)
            )
          end,
          'history_count', p.history_count
        )
        order by (p.active = false) asc, pg_catalog.lower(p.display_name) asc, p.vendor_id asc
      )
        from paged p
    ), '[]'::jsonb)
    into v_total, v_items;

  return pg_catalog.jsonb_build_object(
    'items', coalesce(v_items, '[]'::jsonb),
    'total', coalesce(v_total, 0),
    'page', p_page,
    'page_size', p_page_size,
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'authorization_date', v_today::text
  );
end;
$function$;

revoke all on function public.direct_entry_vendor_referrer_list_vendors(uuid, uuid, text, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_vendor_referrer_list_vendors(uuid, uuid, text, boolean, integer, integer)
  to service_role;

-- 4.4 direct_entry_vendor_referrer_get_history
create or replace function public.direct_entry_vendor_referrer_get_history(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_vendor public.vendors%rowtype;
  v_current_link jsonb := null;
  v_links jsonb := '[]'::jsonb;
  v_audit_events jsonb := '[]'::jsonb;
begin
  perform public.direct_entry_vendor_referrer__internal_assert_bod_actor(
    p_auth_subject, p_app_user_id, v_now
  );

  if p_vendor_id is null
     or p_vendor_id = '__system_vendor__'
     or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_REFERRER_VENDOR_INVALID' using errcode = '22023';
  end if;

  select v.*
    into v_vendor
    from public.vendors v
   where v.vendor_id = p_vendor_id
     and v.vendor_id <> '__system_vendor__';

  if not found then
    raise exception 'VENDOR_REFERRER_VENDOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  select pg_catalog.jsonb_build_object(
    'link_id', l.link_id,
    'referrer_person_id', l.referrer_person_id,
    'referrer_employee_code', p.employee_code,
    'referrer_full_name', p.full_name,
    'referrer_department_name', d.name,
    'effective_from', l.effective_from::text,
    'reason', l.reason,
    'created_at', public.org_department__internal_iso_utc(l.created_at)
  )
    into v_current_link
    from public.vendor_referrer_links l
    join public.organization_persons p
      on p.person_id = l.referrer_person_id
    left join public.organization_person_department_memberships m
      on m.person_id = p.person_id
     and m.ended_at is null
    left join public.organization_departments d
      on d.department_id = m.department_id
   where l.vendor_id = v_vendor.vendor_id
     and l.is_current = true
   limit 1;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'link_id', l.link_id,
        'vendor_id', l.vendor_id,
        'referrer_person_id', l.referrer_person_id,
        'referrer_employee_code', p.employee_code,
        'referrer_full_name', p.full_name,
        'referrer_department_name', d.name,
        'effective_from', l.effective_from::text,
        'effective_to', case when l.effective_to is null then null else l.effective_to::text end,
        'is_current', l.is_current,
        'reason', l.reason,
        'created_by_app_user_id', l.created_by_app_user_id,
        'created_by_display_name', coalesce(cu.display_name, cu.app_user_id::text),
        'created_at', public.org_department__internal_iso_utc(l.created_at),
        'ended_by_app_user_id', l.ended_by_app_user_id,
        'ended_by_display_name', case when l.ended_by_app_user_id is null then null else coalesce(eu.display_name, eu.app_user_id::text) end,
        'ended_at', case when l.ended_at is null then null else public.org_department__internal_iso_utc(l.ended_at) end,
        'ended_reason', l.ended_reason
      )
      order by l.is_current desc, l.effective_from desc, l.created_at desc, l.link_id desc
    ),
    '[]'::jsonb
  )
    into v_links
    from public.vendor_referrer_links l
    join public.organization_persons p
      on p.person_id = l.referrer_person_id
    left join public.organization_person_department_memberships m
      on m.person_id = p.person_id
     and m.ended_at is null
    left join public.organization_departments d
      on d.department_id = m.department_id
    join public.direct_entry_app_users cu
      on cu.app_user_id = l.created_by_app_user_id
    left join public.direct_entry_app_users eu
      on eu.app_user_id = l.ended_by_app_user_id
   where l.vendor_id = v_vendor.vendor_id;

  select coalesce(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'event_id', ae.event_id,
        'action', ae.action,
        'link_id', ae.link_id,
        'previous_link_id', ae.previous_link_id,
        'referrer_person_id', ae.referrer_person_id,
        'previous_referrer_person_id', ae.previous_referrer_person_id,
        'effective_date', ae.effective_date::text,
        'actor_app_user_id', ae.actor_app_user_id,
        'actor_display_name', coalesce(au.display_name, au.app_user_id::text),
        'referrer_full_name', rp.full_name,
        'previous_referrer_full_name', prp.full_name,
        'reason', ae.reason,
        'created_at', public.org_department__internal_iso_utc(ae.created_at)
      )
      order by ae.created_at desc, ae.event_id desc
    ),
    '[]'::jsonb
  )
    into v_audit_events
    from public.vendor_referrer_audit_events ae
    join public.direct_entry_app_users au
      on au.app_user_id = ae.actor_app_user_id
    left join public.organization_persons rp
      on rp.person_id = ae.referrer_person_id
    left join public.organization_persons prp
      on prp.person_id = ae.previous_referrer_person_id
   where ae.vendor_id = v_vendor.vendor_id;

  return pg_catalog.jsonb_build_object(
    'vendor', pg_catalog.jsonb_build_object(
      'vendor_id', v_vendor.vendor_id,
      'display_name', v_vendor.display_name,
      'active', v_vendor.active,
      'version', v_vendor.version,
      'current_link', v_current_link
    ),
    'links', coalesce(v_links, '[]'::jsonb),
    'audit_events', coalesce(v_audit_events, '[]'::jsonb),
    'authorization_date', v_today::text
  );
end;
$function$;

revoke all on function public.direct_entry_vendor_referrer_get_history(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_vendor_referrer_get_history(uuid, uuid, text)
  to service_role;

-- 4.5 direct_entry_vendor_referrer_assign
create or replace function public.direct_entry_vendor_referrer_assign(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_referrer_person_id uuid,
  p_effective_date date default null,
  p_expected_current_link_id uuid default null,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_effective_from date;
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_request_fingerprint text;
  v_existing_event public.vendor_referrer_audit_events%rowtype;
  v_vendor public.vendors%rowtype;
  v_person public.organization_persons%rowtype;
  v_current public.vendor_referrer_links%rowtype;
  v_new_link public.vendor_referrer_links%rowtype;
  v_action text;
  v_replaced_link_id uuid := null;
  v_prev_referrer_person_id uuid := null;
  v_dept_name text := null;
  v_current_link_json jsonb;
  v_response jsonb;
begin
  perform public.direct_entry_vendor_referrer__internal_assert_bod_actor(
    p_auth_subject, p_app_user_id, v_now
  );

  if p_vendor_id is null
     or p_vendor_id = '__system_vendor__'
     or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_REFERRER_VENDOR_INVALID' using errcode = '22023';
  end if;

  if p_referrer_person_id is null then
    raise exception 'VENDOR_REFERRER_PERSON_REQUIRED' using errcode = '22023';
  end if;

  if v_reason is null
     or pg_catalog.length(v_reason) > 4000
     or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'VENDOR_REFERRER_REASON_INVALID' using errcode = '22023';
  end if;

  if p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'VENDOR_REFERRER_IDEMPOTENCY_KEY_INVALID' using errcode = '22023';
  end if;

  v_effective_from := coalesce(p_effective_date, v_today);
  if v_effective_from > v_today then
    raise exception 'VENDOR_REFERRER_FUTURE_EFFECTIVE_DATE' using errcode = '22023';
  end if;

  v_request_fingerprint := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'op', 'ASSIGN',
      'vendor_id', p_vendor_id,
      'referrer_person_id', p_referrer_person_id,
      'effective_date', case when p_effective_date is null then null else p_effective_date::text end,
      'expected_current_link_id', p_expected_current_link_id,
      'reason', v_reason
    )
  );

  -- Lock actor row to serialize same-actor idempotency checks, then re-verify BoD authority
  perform 1
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
   for update;

  perform public.direct_entry_vendor_referrer__internal_assert_bod_actor(
    p_auth_subject, p_app_user_id, v_now
  );

  select ae.*
    into v_existing_event
    from public.vendor_referrer_audit_events ae
   where ae.actor_app_user_id = p_app_user_id
     and ae.idempotency_key = p_idempotency_key
   for update;

  if found then
    if v_existing_event.request_fingerprint <> v_request_fingerprint then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    return v_existing_event.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select v.*
    into v_vendor
    from public.vendors v
   where v.vendor_id = p_vendor_id
     and v.vendor_id <> '__system_vendor__'
   for update;

  if not found then
    raise exception 'VENDOR_REFERRER_VENDOR_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not v_vendor.active then
    raise exception 'VENDOR_REFERRER_VENDOR_INACTIVE' using errcode = '22023';
  end if;

  select p.*
    into v_person
    from public.organization_persons p
   where p.person_id = p_referrer_person_id
   for update;

  if not found then
    raise exception 'VENDOR_REFERRER_PERSON_NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.direct_entry_vendor_referrer__internal_person_is_eligible_hrp_recruiter(
    p_referrer_person_id, v_now
  ) then
    raise exception 'VENDOR_REFERRER_CANDIDATE_INELIGIBLE' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vendor-referrer:' || p_vendor_id, 0)
  );

  select l.*
    into v_current
    from public.vendor_referrer_links l
   where l.vendor_id = p_vendor_id
     and l.is_current = true
   for update;

  if p_expected_current_link_id is distinct from v_current.link_id then
    raise exception 'VENDOR_REFERRER_CONCURRENT_MODIFICATION' using errcode = 'PT409';
  end if;

  if v_current.link_id is not null then
    if v_current.referrer_person_id = p_referrer_person_id then
      raise exception 'VENDOR_REFERRER_SAME_REFERRER' using errcode = '22023';
    end if;
    if v_effective_from < v_current.effective_from then
      raise exception 'VENDOR_REFERRER_EFFECTIVE_DATE_CONFLICT' using errcode = 'PT409';
    end if;

    update public.vendor_referrer_links l
       set effective_to = v_effective_from,
           is_current = false,
           ended_by_app_user_id = p_app_user_id,
           ended_at = v_now,
           ended_reason = v_reason
     where l.link_id = v_current.link_id;

    v_action := 'REPLACE';
    v_replaced_link_id := v_current.link_id;
    v_prev_referrer_person_id := v_current.referrer_person_id;
  else
    v_action := 'ASSIGN';
    v_replaced_link_id := null;
    v_prev_referrer_person_id := null;
  end if;

  insert into public.vendor_referrer_links (
    vendor_id,
    referrer_person_id,
    effective_from,
    effective_to,
    is_current,
    reason,
    created_by_app_user_id,
    created_at
  ) values (
    p_vendor_id,
    p_referrer_person_id,
    v_effective_from,
    null,
    true,
    v_reason,
    p_app_user_id,
    v_now
  )
  returning * into v_new_link;

  select d.name
    into v_dept_name
    from public.organization_person_department_memberships m
    join public.organization_departments d
      on d.department_id = m.department_id
   where m.person_id = v_person.person_id
     and m.ended_at is null
     and m.started_at <= v_now
   order by m.started_at desc
   limit 1;

  v_current_link_json := pg_catalog.jsonb_build_object(
    'link_id', v_new_link.link_id,
    'vendor_id', v_new_link.vendor_id,
    'referrer_person_id', v_new_link.referrer_person_id,
    'referrer_employee_code', v_person.employee_code,
    'referrer_full_name', v_person.full_name,
    'referrer_department_name', v_dept_name,
    'effective_from', v_new_link.effective_from::text,
    'is_current', v_new_link.is_current,
    'reason', v_new_link.reason,
    'created_at', public.org_department__internal_iso_utc(v_new_link.created_at)
  );

  v_response := pg_catalog.jsonb_build_object(
    'vendor_id', p_vendor_id,
    'action', v_action,
    'current_link', v_current_link_json,
    'replaced_link_id', v_replaced_link_id,
    'replayed', false
  );

  insert into public.vendor_referrer_audit_events (
    vendor_id,
    action,
    link_id,
    previous_link_id,
    referrer_person_id,
    previous_referrer_person_id,
    effective_date,
    actor_app_user_id,
    reason,
    idempotency_key,
    request_fingerprint,
    response_payload,
    created_at
  ) values (
    p_vendor_id,
    v_action,
    v_new_link.link_id,
    v_replaced_link_id,
    p_referrer_person_id,
    v_prev_referrer_person_id,
    v_effective_from,
    p_app_user_id,
    v_reason,
    p_idempotency_key,
    v_request_fingerprint,
    v_response,
    v_now
  );

  return v_response;
end;
$function$;

revoke all on function public.direct_entry_vendor_referrer_assign(uuid, uuid, text, uuid, date, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_vendor_referrer_assign(uuid, uuid, text, uuid, date, uuid, text, text)
  to service_role;

-- 4.6 direct_entry_vendor_referrer_revoke
create or replace function public.direct_entry_vendor_referrer_revoke(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_effective_date date default null,
  p_expected_current_link_id uuid default null,
  p_reason text default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_effective_date date;
  v_reason text := nullif(pg_catalog.btrim(p_reason), '');
  v_request_fingerprint text;
  v_existing_event public.vendor_referrer_audit_events%rowtype;
  v_vendor public.vendors%rowtype;
  v_current public.vendor_referrer_links%rowtype;
  v_closed public.vendor_referrer_links%rowtype;
  v_response jsonb;
begin
  perform public.direct_entry_vendor_referrer__internal_assert_bod_actor(
    p_auth_subject, p_app_user_id, v_now
  );

  if p_vendor_id is null
     or p_vendor_id = '__system_vendor__'
     or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_REFERRER_VENDOR_INVALID' using errcode = '22023';
  end if;

  if v_reason is null
     or pg_catalog.length(v_reason) > 4000
     or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'VENDOR_REFERRER_REASON_INVALID' using errcode = '22023';
  end if;

  if p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$' then
    raise exception 'VENDOR_REFERRER_IDEMPOTENCY_KEY_INVALID' using errcode = '22023';
  end if;

  v_effective_date := coalesce(p_effective_date, v_today);
  if v_effective_date > v_today then
    raise exception 'VENDOR_REFERRER_FUTURE_EFFECTIVE_DATE' using errcode = '22023';
  end if;

  v_request_fingerprint := public.direct_entry_payload_hash(
    pg_catalog.jsonb_build_object(
      'op', 'REVOKE',
      'vendor_id', p_vendor_id,
      'effective_date', case when p_effective_date is null then null else p_effective_date::text end,
      'expected_current_link_id', p_expected_current_link_id,
      'reason', v_reason
    )
  );

  -- Lock actor row to serialize same-actor idempotency checks, then re-verify BoD authority
  perform 1
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
   for update;

  perform public.direct_entry_vendor_referrer__internal_assert_bod_actor(
    p_auth_subject, p_app_user_id, v_now
  );

  select ae.*
    into v_existing_event
    from public.vendor_referrer_audit_events ae
   where ae.actor_app_user_id = p_app_user_id
     and ae.idempotency_key = p_idempotency_key
   for update;

  if found then
    if v_existing_event.request_fingerprint <> v_request_fingerprint then
      raise exception 'idempotency key reused with different input' using errcode = '22023';
    end if;
    return v_existing_event.response_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  select v.*
    into v_vendor
    from public.vendors v
   where v.vendor_id = p_vendor_id
     and v.vendor_id <> '__system_vendor__'
   for update;

  if not found then
    raise exception 'VENDOR_REFERRER_VENDOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vendor-referrer:' || p_vendor_id, 0)
  );

  select l.*
    into v_current
    from public.vendor_referrer_links l
   where l.vendor_id = p_vendor_id
     and l.is_current = true
   for update;

  if v_current.link_id is null then
    raise exception 'VENDOR_REFERRER_NO_ACTIVE_LINK' using errcode = 'PT409';
  end if;

  if p_expected_current_link_id is not null and p_expected_current_link_id <> v_current.link_id then
    raise exception 'VENDOR_REFERRER_CONCURRENT_MODIFICATION' using errcode = 'PT409';
  end if;

  if v_effective_date < v_current.effective_from then
    raise exception 'VENDOR_REFERRER_EFFECTIVE_DATE_CONFLICT' using errcode = 'PT409';
  end if;

  update public.vendor_referrer_links l
     set effective_to = v_effective_date,
         is_current = false,
         ended_by_app_user_id = p_app_user_id,
         ended_at = v_now,
         ended_reason = v_reason
   where l.link_id = v_current.link_id
  returning * into v_closed;

  v_response := pg_catalog.jsonb_build_object(
    'vendor_id', p_vendor_id,
    'action', 'REVOKE',
    'revoked_link_id', v_closed.link_id,
    'effective_date', v_effective_date::text,
    'current_link', null,
    'replayed', false
  );

  insert into public.vendor_referrer_audit_events (
    vendor_id,
    action,
    link_id,
    previous_link_id,
    referrer_person_id,
    previous_referrer_person_id,
    effective_date,
    actor_app_user_id,
    reason,
    idempotency_key,
    request_fingerprint,
    response_payload,
    created_at
  ) values (
    p_vendor_id,
    'REVOKE',
    null,
    v_closed.link_id,
    null,
    v_closed.referrer_person_id,
    v_effective_date,
    p_app_user_id,
    v_reason,
    p_idempotency_key,
    v_request_fingerprint,
    v_response,
    v_now
  );

  return v_response;
end;
$function$;

revoke all on function public.direct_entry_vendor_referrer_revoke(uuid, uuid, text, date, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_vendor_referrer_revoke(uuid, uuid, text, date, uuid, text, text)
  to service_role;

-- 4.7 direct_entry_vendor_referrer_monthly_report
create or replace function public.direct_entry_vendor_referrer_monthly_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_month text default null,
  p_referrer_person_id uuid default null,
  p_vendor_id text default null,
  p_project_id text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := public.direct_entry_authorization_date();
  v_month text;
  v_period_from date := null;
  v_period_to date := null;
  v_vendor_id text := null;
  v_project_id text := null;
  v_reconciliation jsonb;
  v_filtered_summary jsonb;
  v_by_referrer jsonb;
  v_rows jsonb;
  v_unassigned_vendors jsonb;
  v_unresolved_vendor_breakdown jsonb;
  v_filter_options jsonb;
begin
  perform public.direct_entry_vendor_referrer__internal_assert_bod_actor(
    p_auth_subject, p_app_user_id, v_now
  );

  if p_month is null or nullif(pg_catalog.btrim(p_month), '') is null then
    v_month := pg_catalog.to_char(v_today, 'YYYY-MM');
  else
    v_month := pg_catalog.btrim(p_month);
    if pg_catalog.upper(v_month) = 'ALL' then
      v_month := 'ALL';
    elsif v_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
      raise exception 'VENDOR_REFERRER_MONTH_INVALID' using errcode = '22023';
    end if;
  end if;

  if v_month <> 'ALL' then
    v_period_from := pg_catalog.to_date(v_month || '-01', 'YYYY-MM-DD');
    v_period_to := (v_period_from + interval '1 month' - interval '1 day')::date;
  end if;

  if p_vendor_id is not null then
    v_vendor_id := nullif(pg_catalog.btrim(p_vendor_id), '');
    if v_vendor_id is not null and (
      v_vendor_id = '__system_vendor__'
      or v_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'
    ) then
      raise exception 'VENDOR_REFERRER_VENDOR_INVALID' using errcode = '22023';
    end if;
  end if;

  if p_project_id is not null then
    v_project_id := nullif(pg_catalog.btrim(p_project_id), '');
    if v_project_id is not null and v_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
      raise exception 'VENDOR_REFERRER_PROJECT_INVALID' using errcode = '22023';
    end if;
  end if;

  with all_vendor_turns as (
    select
      e.entry_id,
      e.first_work_date,
      e.project_id,
      p.display_name as project_display_name,
      e.recruiter_id,
      r.display_name as recruiter_display_name,
      v.vendor_id,
      v.display_name as vendor_display_name,
      vrl.link_id as referrer_link_id,
      vrl.referrer_person_id,
      rp.employee_code as referrer_employee_code,
      rp.full_name as referrer_full_name,
      rd.name as referrer_department_name
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
    join public.direct_entry_projects p
      on p.project_id = e.project_id
    join public.recruiters r
      on r.recruiter_id = e.recruiter_id
    left join lateral (
      select rpm.vendor_id
        from public.recruiter_provider_memberships rpm
       where rpm.recruiter_id = e.recruiter_id
         and rpm.provider_type = 'vendor'
         and rpm.valid_from <= e.first_work_date
         and (rpm.valid_to is null or e.first_work_date < rpm.valid_to)
       order by rpm.valid_from desc, rpm.created_at desc, rpm.membership_id desc
       limit 1
    ) vm on true
    left join public.vendors v
      on v.vendor_id = vm.vendor_id
     and v.vendor_id <> '__system_vendor__'
    left join public.vendor_referrer_links vrl
      on vrl.vendor_id = v.vendor_id
     and vrl.effective_from <= e.first_work_date
     and (vrl.effective_to is null or e.first_work_date < vrl.effective_to)
    left join public.organization_persons rp
      on rp.person_id = vrl.referrer_person_id
    left join public.organization_person_department_memberships rdm
      on rdm.person_id = rp.person_id
     and rdm.ended_at is null
    left join public.organization_departments rd
      on rd.department_id = rdm.department_id
   where e.deleted_at is null
     and e.voided_at is null
     and e.provider_type = 'vendor'
     and s.state = 'SUBMITTED'
     and (
       v_period_from is null
       or (e.first_work_date >= v_period_from and e.first_work_date <= v_period_to)
     )
  ),
  filtered_attributed as (
    select t.*
      from all_vendor_turns t
     where t.vendor_id is not null
       and t.referrer_link_id is not null
       and (p_referrer_person_id is null or t.referrer_person_id = p_referrer_person_id)
       and (v_vendor_id is null or t.vendor_id = v_vendor_id)
       and (v_project_id is null or t.project_id = v_project_id)
  ),
  reconciliation_agg as (
    select
      count(*)::integer as total_vendor_turns,
      count(*) filter (where t.vendor_id is not null)::integer as matched_vendor_turns,
      count(*) filter (where t.vendor_id is not null and t.referrer_link_id is not null)::integer as attributed_turns,
      count(*) filter (where t.vendor_id is not null and t.referrer_link_id is null)::integer as unassigned_vendor_turns,
      count(*) filter (where t.vendor_id is null)::integer as unresolved_vendor_turns
    from all_vendor_turns t
  ),
  filtered_agg as (
    select
      count(*)::integer as attributed_turns,
      count(distinct f.referrer_person_id)::integer as referrer_count,
      count(distinct f.vendor_id)::integer as vendor_count,
      count(distinct f.project_id)::integer as project_count
    from filtered_attributed f
  ),
  referrer_rollup as (
    select
      f.referrer_person_id,
      f.referrer_employee_code,
      f.referrer_full_name,
      f.referrer_department_name,
      count(*)::integer as turns,
      count(distinct f.vendor_id)::integer as vendor_count,
      count(distinct f.project_id)::integer as project_count
    from filtered_attributed f
    group by
      f.referrer_person_id,
      f.referrer_employee_code,
      f.referrer_full_name,
      f.referrer_department_name
  ),
  matrix_rollup as (
    select
      f.referrer_person_id,
      f.referrer_employee_code,
      f.referrer_full_name,
      f.referrer_department_name,
      f.vendor_id,
      f.vendor_display_name,
      f.project_id,
      f.project_display_name,
      count(*)::integer as turns
    from filtered_attributed f
    group by
      f.referrer_person_id,
      f.referrer_employee_code,
      f.referrer_full_name,
      f.referrer_department_name,
      f.vendor_id,
      f.vendor_display_name,
      f.project_id,
      f.project_display_name
  ),
  unassigned_rollup as (
    select
      t.vendor_id,
      t.vendor_display_name,
      count(*)::integer as turns,
      count(distinct t.project_id)::integer as project_count
    from all_vendor_turns t
    where t.vendor_id is not null
      and t.referrer_link_id is null
    group by t.vendor_id, t.vendor_display_name
  ),
  unresolved_rollup as (
    select
      t.recruiter_id,
      t.recruiter_display_name,
      t.project_id,
      t.project_display_name,
      count(*)::integer as turns
    from all_vendor_turns t
    where t.vendor_id is null
    group by
      t.recruiter_id,
      t.recruiter_display_name,
      t.project_id,
      t.project_display_name
  ),
  opt_referrers as (
    select distinct
      t.referrer_person_id as person_id,
      t.referrer_employee_code as employee_code,
      t.referrer_full_name as full_name,
      t.referrer_department_name as department_name
    from all_vendor_turns t
    where t.vendor_id is not null
      and t.referrer_link_id is not null
  ),
  opt_vendors as (
    select distinct
      t.vendor_id,
      t.vendor_display_name as display_name
    from all_vendor_turns t
    where t.vendor_id is not null
  ),
  opt_projects as (
    select distinct
      t.project_id,
      t.project_display_name as display_name
    from all_vendor_turns t
  )
  select
    pg_catalog.jsonb_build_object(
      'total_vendor_turns', r.total_vendor_turns,
      'matched_vendor_turns', r.matched_vendor_turns,
      'attributed_turns', r.attributed_turns,
      'unassigned_vendor_turns', r.unassigned_vendor_turns,
      'unresolved_vendor_turns', r.unresolved_vendor_turns
    ),
    pg_catalog.jsonb_build_object(
      'attributed_turns', fa.attributed_turns,
      'referrer_count', fa.referrer_count,
      'vendor_count', fa.vendor_count,
      'project_count', fa.project_count
    ),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'referrer_person_id', rr.referrer_person_id,
          'referrer_employee_code', rr.referrer_employee_code,
          'referrer_full_name', rr.referrer_full_name,
          'referrer_department_name', rr.referrer_department_name,
          'turns', rr.turns,
          'vendor_count', rr.vendor_count,
          'project_count', rr.project_count
        )
        order by rr.turns desc, pg_catalog.lower(rr.referrer_full_name) asc, rr.referrer_person_id asc
      )
        from referrer_rollup rr
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'referrer_person_id', mr.referrer_person_id,
          'referrer_employee_code', mr.referrer_employee_code,
          'referrer_full_name', mr.referrer_full_name,
          'referrer_department_name', mr.referrer_department_name,
          'vendor_id', mr.vendor_id,
          'vendor_display_name', mr.vendor_display_name,
          'project_id', mr.project_id,
          'project_display_name', mr.project_display_name,
          'turns', mr.turns
        )
        order by
          mr.turns desc,
          pg_catalog.lower(mr.referrer_full_name) asc,
          pg_catalog.lower(mr.vendor_display_name) asc,
          pg_catalog.lower(mr.project_display_name) asc,
          mr.vendor_id asc,
          mr.project_id asc
      )
        from matrix_rollup mr
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'vendor_id', ur.vendor_id,
          'vendor_display_name', ur.vendor_display_name,
          'turns', ur.turns,
          'project_count', ur.project_count
        )
        order by ur.turns desc, pg_catalog.lower(ur.vendor_display_name) asc, ur.vendor_id asc
      )
        from unassigned_rollup ur
    ), '[]'::jsonb),
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'recruiter_id', uvr.recruiter_id,
          'recruiter_display_name', uvr.recruiter_display_name,
          'project_id', uvr.project_id,
          'project_display_name', uvr.project_display_name,
          'turns', uvr.turns
        )
        order by uvr.turns desc, pg_catalog.lower(uvr.recruiter_display_name) asc, uvr.project_id asc
      )
        from unresolved_rollup uvr
    ), '[]'::jsonb),
    pg_catalog.jsonb_build_object(
      'referrers', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'person_id', oref.person_id,
            'employee_code', oref.employee_code,
            'full_name', oref.full_name,
            'department_name', oref.department_name
          )
          order by pg_catalog.lower(oref.full_name) asc, oref.person_id asc
        )
          from opt_referrers oref
      ), '[]'::jsonb),
      'vendors', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'vendor_id', ov.vendor_id,
            'display_name', ov.display_name
          )
          order by pg_catalog.lower(ov.display_name) asc, ov.vendor_id asc
        )
          from opt_vendors ov
      ), '[]'::jsonb),
      'projects', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'project_id', op.project_id,
            'display_name', op.display_name
          )
          order by pg_catalog.lower(op.display_name) asc, op.project_id asc
        )
          from opt_projects op
      ), '[]'::jsonb)
    )
    into
      v_reconciliation,
      v_filtered_summary,
      v_by_referrer,
      v_rows,
      v_unassigned_vendors,
      v_unresolved_vendor_breakdown,
      v_filter_options
    from reconciliation_agg r
    cross join filtered_agg fa;

  return pg_catalog.jsonb_build_object(
    'month', v_month,
    'period_from', case when v_period_from is null then null else v_period_from::text end,
    'period_to', case when v_period_to is null then null else v_period_to::text end,
    'authorization_date', v_today::text,
    'reconciliation', v_reconciliation,
    'filtered_summary', v_filtered_summary,
    'by_referrer', v_by_referrer,
    'rows', v_rows,
    'unassigned_vendors', v_unassigned_vendors,
    'unresolved_vendor_breakdown', v_unresolved_vendor_breakdown,
    'filter_options', v_filter_options
  );
end;
$function$;

revoke all on function public.direct_entry_vendor_referrer_monthly_report(uuid, uuid, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_vendor_referrer_monthly_report(uuid, uuid, text, uuid, text, text)
  to service_role;

-- =============================================================================
-- SECTION 5: Owner Alignment & Strict Security/ACL Verification
-- =============================================================================

do $align_and_verify_vendor_referrer$
declare
  v_service_rpcs text[] := array[
    'public.direct_entry_vendor_referrer_get_actor_access(uuid, uuid)',
    'public.direct_entry_vendor_referrer_list_candidates(uuid, uuid, text, integer)',
    'public.direct_entry_vendor_referrer_list_vendors(uuid, uuid, text, boolean, integer, integer)',
    'public.direct_entry_vendor_referrer_get_history(uuid, uuid, text)',
    'public.direct_entry_vendor_referrer_assign(uuid, uuid, text, uuid, date, uuid, text, text)',
    'public.direct_entry_vendor_referrer_revoke(uuid, uuid, text, date, uuid, text, text)',
    'public.direct_entry_vendor_referrer_monthly_report(uuid, uuid, text, uuid, text, text)'
  ];
  v_internal_fns text[] := array[
    'public.org_department__internal_user_is_active_bod(uuid, timestamptz)',
    'public.direct_entry_vendor_referrer__internal_assert_bod_actor(uuid, uuid, timestamptz)',
    'public.direct_entry_vendor_referrer__internal_person_is_eligible_hrp_recruiter(uuid, timestamptz)',
    'public.direct_entry_vendor_referrer__internal_guard_link()'
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
    raise exception 'Vendor referrer alignment failed: base owner missing' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_service_rpcs loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Vendor referrer postcheck failed: missing service RPC %', v_sig using errcode = '55000';
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
      raise exception 'Vendor referrer postcheck failed: definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
      raise exception 'Vendor referrer postcheck failed: RPC ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := pg_catalog.to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'Vendor referrer postcheck failed: missing internal fn %', v_sig using errcode = '55000';
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
      raise exception 'Vendor referrer postcheck failed: internal definer/search_path invalid on %', v_sig using errcode = '55000';
    end if;

    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
       or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception 'Vendor referrer postcheck failed: internal ACL invalid on %', v_sig using errcode = '55000';
    end if;
  end loop;
end
$align_and_verify_vendor_referrer$;

commit;
