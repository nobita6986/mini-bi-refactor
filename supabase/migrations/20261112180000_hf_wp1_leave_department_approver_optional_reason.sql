-- Hotfix WP1/S1: Restore optional reason validation on leave_management_set_department_approver_admin
-- while preserving server-controlled immediate effective date (coalesce(p_valid_from, v_today)),
-- future/past date guards, PT409 row-version conflict handling, and strict RPC ACLs.

begin;

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

  v_reason := case
    when nullif(pg_catalog.btrim(coalesce(p_reason, '')), '') is null then null
    else public.leave_management__internal_validate_reason(p_reason, 'LEAVE_REASON_INVALID')
  end;

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

do $owner_align$
declare
  v_base_owner_oid oid;
  v_owner name;
  v_fn regprocedure := 'public.leave_management_set_department_approver_admin(uuid,uuid,text,uuid,date,integer,text,text,text)'::pg_catalog.regprocedure;
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

  select p.proowner
    into v_proc_owner_oid
    from pg_catalog.pg_proc p
   where p.oid = v_fn;

  if v_proc_owner_oid is distinct from v_base_owner_oid
     and pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET') then
    execute pg_catalog.format('alter function %s owner to %I', v_fn, v_owner);
  end if;
end
$owner_align$;

revoke all on function
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.leave_management_set_department_approver_admin(uuid, uuid, text, uuid, date, integer, text, text, text)
to service_role;

do $self_check$
declare
  v_rpc_fn regprocedure := 'public.leave_management_set_department_approver_admin(uuid,uuid,text,uuid,date,integer,text,text,text)'::pg_catalog.regprocedure;
  v_secdef boolean;
  v_config text;
  v_src text;
begin
  select p.prosecdef,
         coalesce(pg_catalog.array_to_string(p.proconfig, ','), ''),
         p.prosrc
    into v_secdef, v_config, v_src
    from pg_catalog.pg_proc p
   where p.oid = v_rpc_fn;

  if not coalesce(v_secdef, false)
     or v_config <> 'search_path=pg_catalog, public' then
    raise exception 'HF-WP1 RPC security definer or search_path drift on %', v_rpc_fn
      using errcode = '55000';
  end if;

  if pg_catalog.has_function_privilege('public', v_rpc_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_rpc_fn, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_rpc_fn, 'EXECUTE')
     or not pg_catalog.has_function_privilege('service_role', v_rpc_fn, 'EXECUTE') then
    raise exception 'HF-WP1 RPC EXECUTE privilege drift on %', v_rpc_fn
      using errcode = '55000';
  end if;

  if pg_catalog.strpos(v_src, 'LEAVE_REASON_REQUIRED') > 0
     or pg_catalog.strpos(v_src, 'LEAVE_REASON_INVALID') = 0 then
    raise exception 'HF-WP1 leave_management_set_department_approver_admin optional reason guard missing'
      using errcode = '55000';
  end if;
end
$self_check$;

commit;
