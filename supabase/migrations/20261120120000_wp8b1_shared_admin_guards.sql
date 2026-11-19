-- WP8B-1: Shared Admin / Catalog Operator / Project Admin SQL Guards on WP5 Paired Effective Access
--
-- Scope (strictly limited to 3 existing internal shared guard functions):
--   1. public.direct_entry_assert_actor_app_user_admin(uuid, uuid) -> text
--      Full Admin = entry_admin + recruiter_master_manage + team_master_manage, each paired at ALL.
--   2. public.direct_entry_assert_catalog_operator(uuid, uuid) -> text
--      Catalog Operator = Full Admin (paired triple at ALL) OR catalog_master_manage paired at ALL.
--   3. public.direct_entry_assert_project_admin(uuid, uuid) -> void
--      Project Admin = entry_admin paired at ALL (never escalated to Full Admin triple).
--
-- Hard invariants preserved:
--   - Exact signatures, return types/values, SQLSTATE 42501, and error messages classified by callers.
--   - Zero row/advisory locks added inside these shared guards (safe for callers that acquire locks
--     before calling the guard and for all STABLE direct/indirect callers).
--   - Zero new public/service_role RPCs (all 3 remain strictly internal, revoked from PUBLIC, anon,
--     authenticated, service_role; preserves exact 336 service_role allowlist).
--   - Zero data/role/mapping mutation or backfill; zero email literals; zero nested tx-points; zero default-privilege changes.
--   - Post-cutover accounts (authz_managed = true) evaluate strictly via WP5 paired
--     direct_entry_authz__internal_has_paired_capability with zero legacy table fallback.
--   - Pre-cutover accounts (authz_managed = false) preserve R1 current-state compatibility on legacy
--     rows without ever cross-pairing canonical grants with legacy scopes.

begin;

-- -----------------------------------------------------------------------------
-- 1. public.direct_entry_assert_actor_app_user_admin(uuid, uuid) -> text
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_actor_app_user_admin(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_full_admin boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_full_admin :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);

  if not v_full_admin and not v_authz_managed then
    -- Pre-cutover (authz_managed = false) R1 current-state compatibility:
    -- preserves legacy current rows whose inert historical valid_to precedes today
    -- while keeping capabilities and ALL scope strictly within the same legacy source.
    v_full_admin :=
      public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
      and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
      and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
      and exists (
        select 1
          from public.direct_entry_scope_grants s
         where s.app_user_id = p_app_user_id
           and s.scope_kind = 'all'
           and s.is_current
           and not s.suspended_by_account_disable
      );
  end if;

  if not v_full_admin then
    raise exception 'actor is not a Full Admin' using errcode = '42501';
  end if;

  return 'entry_admin';
end;
$function$;

revoke all on function public.direct_entry_assert_actor_app_user_admin(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_assert_actor_app_user_admin(uuid, uuid) is
  'WP8B-1 internal guard: actor mapping + paired Full Admin triple (entry_admin, recruiter_master_manage, team_master_manage) at ALL scope. Returns entry_admin; zero locks; revoked from every non-owner role.';

-- -----------------------------------------------------------------------------
-- 2. public.direct_entry_assert_catalog_operator(uuid, uuid) -> text
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_catalog_operator(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_full_admin boolean := false;
  v_catalog_manage boolean := false;
  v_has_legacy_all boolean := false;
  v_grants jsonb;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_full_admin :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);

  if not v_full_admin and not v_authz_managed then
    select exists (
      select 1
        from public.direct_entry_scope_grants s
       where s.app_user_id = p_app_user_id
         and s.scope_kind = 'all'
         and s.is_current
         and not s.suspended_by_account_disable
    ) into v_has_legacy_all;

    if v_has_legacy_all then
      v_full_admin :=
        public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
        and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
        and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage');
    end if;
  end if;

  if v_full_admin then
    return 'entry_admin';
  end if;

  v_catalog_manage :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'catalog_master_manage', 'ALL', null);

  if not v_catalog_manage and not v_authz_managed and v_has_legacy_all then
    v_catalog_manage := public.direct_entry_has_capability(p_app_user_id, 'catalog_master_manage');
  end if;

  if v_catalog_manage then
    return 'catalog_master_manage';
  end if;

  -- Denial diagnostics only (allow/deny is already decided above): preserve
  -- historical SQLSTATE 42501 message split between missing capability vs missing ALL scope.
  v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
  if exists (
       select 1
         from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
        where g.capability = 'catalog_master_manage'
     )
     or (
       exists (
         select 1
           from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
          where g.capability = 'entry_admin'
       )
       and exists (
         select 1
           from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
          where g.capability = 'recruiter_master_manage'
       )
       and exists (
         select 1
           from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
          where g.capability = 'team_master_manage'
       )
     )
     or (
       not v_authz_managed
       and (
         public.direct_entry_has_capability(p_app_user_id, 'catalog_master_manage')
         or (
           public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
           and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
           and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
         )
       )
     ) then
    raise exception 'catalog operation requires all scope' using errcode = '42501';
  end if;

  raise exception 'catalog operator denied' using errcode = '42501';
end;
$function$;

revoke all on function public.direct_entry_assert_catalog_operator(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_assert_catalog_operator(uuid, uuid) is
  'WP8B-1 internal guard: actor mapping + (paired Full Admin triple at ALL OR catalog_master_manage paired at ALL). Returns entry_admin or catalog_master_manage for audit; entry_admin alone is denied; zero locks; revoked from every non-owner role.';

-- -----------------------------------------------------------------------------
-- 3. public.direct_entry_assert_project_admin(uuid, uuid) -> void
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_project_admin(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_project_admin boolean := false;
  v_grants jsonb;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  v_project_admin :=
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null);

  if not v_project_admin and not v_authz_managed then
    v_project_admin :=
      public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
      and exists (
        select 1
          from public.direct_entry_scope_grants s
         where s.app_user_id = p_app_user_id
           and s.scope_kind = 'all'
           and s.is_current
           and not s.suspended_by_account_disable
      );
  end if;

  if v_project_admin then
    return;
  end if;

  -- Denial diagnostics only (allow/deny is already decided above): preserve
  -- historical SQLSTATE 42501 message split between missing capability vs missing ALL scope.
  v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
  if exists (
       select 1
         from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text)
        where g.capability = 'entry_admin'
     )
     or (
       not v_authz_managed
       and public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
     ) then
    raise exception 'project administration requires all scope' using errcode = '42501';
  end if;

  raise exception 'capability denied' using errcode = '42501';
end;
$function$;

revoke all on function public.direct_entry_assert_project_admin(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_assert_project_admin(uuid, uuid) is
  'WP8B-1 internal guard: actor mapping + entry_admin paired at ALL scope (not escalated to Full Admin triple). Zero locks; revoked from every non-owner role.';

-- -----------------------------------------------------------------------------
-- 4. Guarded owner alignment ($align_wp8b1$)
-- -----------------------------------------------------------------------------
do $align_wp8b1$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean;
  v_sig text;
  v_proc_owner_oid oid;
  v_sigs text[] := array[
    'public.direct_entry_assert_actor_app_user_admin(uuid,uuid)',
    'public.direct_entry_assert_catalog_operator(uuid,uuid)',
    'public.direct_entry_assert_project_admin(uuid,uuid)'
  ];
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner_oid is null then
    raise exception 'WP8B1_ALIGN_BASE_OWNER_MISSING' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_sigs loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = v_sig::pg_catalog.regprocedure;

    if v_proc_owner_oid is null then
      raise exception 'WP8B1_ALIGN_FUNCTION_MISSING: %', v_sig using errcode = '55000';
    end if;

    if v_proc_owner_oid <> v_base_owner_oid and v_can_set_owner then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
  end loop;
end
$align_wp8b1$;

-- -----------------------------------------------------------------------------
-- 5. Fail-closed security, overload, search_path, and ACL self-check ($check_wp8b1$)
-- -----------------------------------------------------------------------------
do $check_wp8b1$
declare
  v_sig text;
  v_name text;
  v_oid oid;
  v_secdef boolean;
  v_proconfig text[];
  v_owner_priv boolean;
  v_owner_exec boolean;
  v_exposed integer;
  v_overload_cnt integer;
  v_internal_fns text[] := array[
    'public.direct_entry_assert_actor_app_user_admin(uuid,uuid)',
    'public.direct_entry_assert_catalog_operator(uuid,uuid)',
    'public.direct_entry_assert_project_admin(uuid,uuid)'
  ];
  v_fn_names text[] := array[
    'direct_entry_assert_actor_app_user_admin',
    'direct_entry_assert_catalog_operator',
    'direct_entry_assert_project_admin'
  ];
begin
  foreach v_name in array v_fn_names loop
    select count(*)::integer
      into v_overload_cnt
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = v_name;

    if v_overload_cnt <> 1 then
      raise exception 'WP8B1_CHECK_OVERLOAD_COUNT_FAILED: % (count=%)', v_name, v_overload_cnt
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := v_sig::pg_catalog.regprocedure;

    select p.prosecdef,
           p.proconfig,
           (r.rolsuper or r.rolbypassrls),
           pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE')
      into v_secdef, v_proconfig, v_owner_priv, v_owner_exec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_secdef, false)
       or not coalesce(v_owner_priv, false)
       or not coalesce(v_owner_exec, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP8B1_CHECK_INTERNAL_DEF_FAILED: %', v_sig using errcode = '55000';
    end if;

    select count(*)::integer
      into v_exposed
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) a
      left join pg_catalog.pg_roles gr on gr.oid = a.grantee
     where p.oid = v_oid
       and (a.grantee = 0 or gr.rolname in ('anon', 'authenticated', 'service_role'));

    if v_exposed <> 0 then
      raise exception 'WP8B1_CHECK_INTERNAL_ACL_EXPOSED: % (% grants)', v_sig, v_exposed
        using errcode = '55000';
    end if;
  end loop;
end
$check_wp8b1$;

commit;
