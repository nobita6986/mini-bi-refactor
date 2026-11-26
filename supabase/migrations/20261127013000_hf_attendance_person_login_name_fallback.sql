-- =============================================================================
-- Hotfix: Attendance Employee Identity Resolution when organization_persons
--         holds a login-ID / personnel-code placeholder as full_name
-- =============================================================================
-- Context & Root Cause:
--   In WP7B (`20261119180000_wp7b_attendance_org_scope_and_leave_nav_probe.sql`),
--   `public.attendance__internal_resolve_employee_identity(uuid)` added Priority 1
--   lookup via active `organization_account_person_links` -> `organization_persons`:
--
--     if v_person_full_name is not null then
--       return query select v_person_full_name, v_person_employee_code;
--       return;
--     end if;
--
--   Unlike Priority 2/3 (`recruiters.display_name`) and Priority 4
--   (`direct_entry_app_users.display_name`), Priority 1 returned
--   `v_person_full_name` immediately without checking
--   `not public.attendance__internal_is_login_or_code_like(...)`.
--
--   When an account is linked to an `organization_persons` row whose `full_name`
--   still holds a login/code-like placeholder (e.g. `'anhnn.td'`, `'sontv.td'`,
--   `'truongtv.td'`, `'hungnt.td'`, `'ngocva.td'`, `'thuandd.td'`), the function
--   short-circuited and returned `employee_display_name = 'anhnn.td'`, preventing
--   fallback to `public.recruiters.display_name` or
--   `public.direct_entry_app_users.display_name`. On the frontend,
--   `resolveAttendanceEmployeeDisplayIdentity` detected that `employee_display_name`
--   was login/code-like and replaced it with `"Chưa cập nhật họ tên"`.
--
-- Fix:
--   1. Only take the Priority 1 fast path when `v_person_full_name` is non-null
--      AND `not public.attendance__internal_is_login_or_code_like(...)`.
--   2. Preserve `v_person_employee_code` as the primary `personnel_code` source
--      while allowing `employee_display_name` to fall back through:
--        a) `organization_persons.full_name` (if not login/code-like)
--        b) active `recruiters.display_name` linked via `organization_persons.recruiter_id`
--        c) active verified `direct_entry_app_user_recruiter_links` -> active `recruiters.display_name`
--        d) unambiguous active `recruiters.display_name` matched by `personnel_code` / login ID
--        e) `direct_entry_app_users.display_name` (if not login/code-like)
--        f) `'Chưa cập nhật họ tên'`
-- =============================================================================

begin;

create or replace function public.attendance__internal_resolve_employee_identity(
  p_app_user_id uuid
)
returns table (
  employee_display_name text,
  personnel_code text
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_auth_subject uuid;
  v_user_display_name text;
  v_login_id text;
  v_person_full_name text;
  v_person_employee_code text;
  v_person_recruiter_name text;
  v_person_recruiter_code text;
  v_linked_display_name text;
  v_linked_personnel_code text;
  v_lookup_code text;
  v_matched_display_name text;
  v_matched_personnel_code text;
  v_resolved_code text;
  v_resolved_name text;
begin
  if p_app_user_id is null then
    return query
    select 'Chưa cập nhật họ tên'::text, null::text;
    return;
  end if;

  select
    u.auth_subject,
    nullif(pg_catalog.btrim(u.display_name), '')
  into
    v_auth_subject,
    v_user_display_name
  from public.direct_entry_app_users u
  where u.app_user_id = p_app_user_id;

  if not found then
    return query
    select 'Chưa cập nhật họ tên'::text, null::text;
    return;
  end if;

  if v_auth_subject is not null then
    select
      pg_catalog.lower(
        nullif(
          pg_catalog.split_part(
            coalesce(pg_catalog.to_jsonb(au)->>'email', ''),
            pg_catalog.chr(64),
            1
          ),
          ''
        )
      )
    into v_login_id
    from auth.users au
    where au.id = v_auth_subject;
  end if;

  -- WP7B Priority 1: active organization_account_person_links -> organization_persons
  -- (plus optional active recruiter linked via organization_persons.recruiter_id)
  select
    nullif(pg_catalog.btrim(op.full_name), ''),
    nullif(pg_catalog.btrim(op.employee_code), ''),
    nullif(pg_catalog.btrim(r_op.display_name), ''),
    nullif(pg_catalog.btrim(r_op.personnel_code), '')
  into
    v_person_full_name,
    v_person_employee_code,
    v_person_recruiter_name,
    v_person_recruiter_code
  from public.organization_account_person_links apl
  join public.organization_persons op
    on op.person_id = apl.person_id
  left join public.recruiters r_op
    on r_op.recruiter_id = op.recruiter_id
   and r_op.active = true
  where apl.app_user_id = p_app_user_id
    and apl.ended_at is null
    and apl.started_at <= v_now
  order by apl.started_at desc, apl.link_id desc
  limit 1;

  -- Fast path: only short-circuit when organization_persons.full_name is a real name
  -- (non-null and not login/code-like).
  if v_person_full_name is not null
     and not public.attendance__internal_is_login_or_code_like(
       v_person_full_name,
       coalesce(v_person_employee_code, v_person_recruiter_code),
       v_login_id
     )
  then
    return query
    select
      v_person_full_name,
      coalesce(v_person_employee_code, v_person_recruiter_code);
    return;
  end if;

  -- Priority 2: active verified direct_entry_app_user_recruiter_links -> active recruiters
  select
    case when pg_catalog.count(*) = 1 then pg_catalog.max(nullif(pg_catalog.btrim(r.display_name), '')) else null end,
    case when pg_catalog.count(*) = 1 then pg_catalog.max(nullif(pg_catalog.btrim(r.personnel_code), '')) else null end
  into
    v_linked_display_name,
    v_linked_personnel_code
  from public.direct_entry_app_user_recruiter_links l
  join public.recruiters r
    on r.recruiter_id = l.recruiter_id
   and r.active = true
  where l.app_user_id = p_app_user_id
    and l.verified = true
    and l.is_current = true;

  -- Priority 3: unambiguous active recruiters match by personnel_code / login_id
  if v_linked_personnel_code is null and v_linked_display_name is null then
    v_lookup_code := coalesce(
      pg_catalog.lower(v_person_employee_code),
      pg_catalog.lower(v_person_recruiter_code)
    );

    if v_lookup_code is not null then
      select
        case
          when pg_catalog.count(*) = 1
            then nullif(pg_catalog.btrim(pg_catalog.max(r.display_name)), '')
          else null
        end,
        case
          when pg_catalog.count(*) = 1
            then nullif(pg_catalog.btrim(pg_catalog.max(r.personnel_code)), '')
          else null
        end
      into
        v_matched_display_name,
        v_matched_personnel_code
      from public.recruiters r
      where r.active = true
        and pg_catalog.lower(pg_catalog.btrim(coalesce(r.personnel_code, ''))) = v_lookup_code;
    end if;

    if v_matched_display_name is null and v_matched_personnel_code is null then
      v_lookup_code := coalesce(
        v_login_id,
        case
          when public.attendance__internal_is_login_or_code_like(v_user_display_name, null, null)
            then pg_catalog.lower(v_user_display_name)
          else null
        end,
        case
          when public.attendance__internal_is_login_or_code_like(v_person_full_name, null, null)
            then pg_catalog.lower(v_person_full_name)
          else null
        end
      );

      if v_lookup_code is not null then
        select
          case
            when pg_catalog.count(*) = 1
              then nullif(pg_catalog.btrim(pg_catalog.max(r.display_name)), '')
            else null
          end,
          case
            when pg_catalog.count(*) = 1
              then nullif(pg_catalog.btrim(pg_catalog.max(r.personnel_code)), '')
            else null
          end
        into
          v_matched_display_name,
          v_matched_personnel_code
        from public.recruiters r
        where r.active = true
          and pg_catalog.lower(pg_catalog.btrim(coalesce(r.personnel_code, ''))) = v_lookup_code;
      end if;
    end if;
  end if;

  v_resolved_code := coalesce(
    v_person_employee_code,
    v_person_recruiter_code,
    v_linked_personnel_code,
    v_matched_personnel_code
  );

  if v_person_full_name is not null
     and not public.attendance__internal_is_login_or_code_like(
       v_person_full_name,
       v_resolved_code,
       v_login_id
     )
  then
    v_resolved_name := v_person_full_name;
  elsif v_person_recruiter_name is not null
        and not public.attendance__internal_is_login_or_code_like(
          v_person_recruiter_name,
          v_resolved_code,
          v_login_id
        )
  then
    v_resolved_name := v_person_recruiter_name;
  elsif v_linked_display_name is not null
        and not public.attendance__internal_is_login_or_code_like(
          v_linked_display_name,
          v_resolved_code,
          v_login_id
        )
  then
    v_resolved_name := v_linked_display_name;
  elsif v_matched_display_name is not null
        and not public.attendance__internal_is_login_or_code_like(
          v_matched_display_name,
          v_resolved_code,
          v_login_id
        )
  then
    v_resolved_name := v_matched_display_name;
  elsif v_user_display_name is not null
        and not public.attendance__internal_is_login_or_code_like(
          v_user_display_name,
          v_resolved_code,
          v_login_id
        )
  then
    v_resolved_name := v_user_display_name;
  else
    v_resolved_name := null;
  end if;

  if v_resolved_name is null then
    return query
    select
      'Chưa cập nhật họ tên'::text,
      coalesce(v_resolved_code, v_login_id, v_user_display_name);
  else
    return query
    select
      v_resolved_name,
      v_resolved_code;
  end if;
end;
$$;

revoke all on function public.attendance__internal_resolve_employee_identity(uuid)
  from public, anon, authenticated, service_role;

comment on function public.attendance__internal_resolve_employee_identity(uuid) is
  'Internal attendance employee identity resolver: prefers real organization_persons.full_name, falling back to linked/matched recruiters.display_name and direct_entry_app_users.display_name when organization_persons.full_name is null or login/code-like.';

do $hf_attendance_identity_postcheck$
declare
  v_fn regprocedure;
  v_prosecdef boolean;
  v_provolatile "char";
  v_proconfig text[];
begin
  v_fn := pg_catalog.to_regprocedure('public.attendance__internal_resolve_employee_identity(uuid)');
  if v_fn is null then
    raise exception 'HF_ATTENDANCE_IDENTITY_POSTCHECK_FAILED: public.attendance__internal_resolve_employee_identity(uuid) is missing';
  end if;

  if exists (select 1 from pg_catalog.pg_roles where rolname = 'supabase_admin') then
    execute 'alter function public.attendance__internal_resolve_employee_identity(uuid) owner to supabase_admin';
  end if;

  select p.prosecdef, p.provolatile, p.proconfig
  into v_prosecdef, v_provolatile, v_proconfig
  from pg_catalog.pg_proc p
  where p.oid = v_fn::oid;

  if not coalesce(v_prosecdef, false) then
    raise exception 'HF_ATTENDANCE_IDENTITY_POSTCHECK_FAILED: attendance__internal_resolve_employee_identity must be SECURITY DEFINER';
  end if;

  if v_provolatile is distinct from 's' then
    raise exception 'HF_ATTENDANCE_IDENTITY_POSTCHECK_FAILED: attendance__internal_resolve_employee_identity must be STABLE';
  end if;

  if v_proconfig is null
     or not ('search_path=pg_catalog, public' = any(v_proconfig))
  then
    raise exception 'HF_ATTENDANCE_IDENTITY_POSTCHECK_FAILED: attendance__internal_resolve_employee_identity must pin search_path = pg_catalog, public';
  end if;

  if pg_catalog.has_function_privilege('public', v_fn::oid, 'EXECUTE')
     or (
       exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
       and pg_catalog.has_function_privilege('anon', v_fn::oid, 'EXECUTE')
     )
     or (
       exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
       and pg_catalog.has_function_privilege('authenticated', v_fn::oid, 'EXECUTE')
     )
     or (
       exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role')
       and pg_catalog.has_function_privilege('service_role', v_fn::oid, 'EXECUTE')
     )
  then
    raise exception 'HF_ATTENDANCE_IDENTITY_POSTCHECK_FAILED: attendance__internal_resolve_employee_identity must not grant EXECUTE to public/anon/authenticated/service_role';
  end if;
end;
$hf_attendance_identity_postcheck$;

commit;
