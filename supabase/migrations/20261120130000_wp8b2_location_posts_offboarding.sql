-- WP8B-2: Location Catalog, Recruitment Posts & Offboarding Authz on WP5 Paired Effective Access
--
-- Scope (strictly limited to the 3 internal authz guards across Location Catalog,
-- Recruitment Posts via recruitment_location_is_admin_or_bod, and Offboarding):
--   1. public.recruitment_location_is_admin_or_bod(uuid) -> boolean
--      Paired ALL check for Full Admin triple (entry_admin + recruiter_master_manage +
--      team_master_manage), OR entry_privileged_edit at ALL, OR (report_analytics_view +
--      report_view) both paired at ALL.
--      Also directly backs public.recruitment_post__internal_actor_is_full_admin_or_bod(uuid),
--      preserving exact 19 recruitment_post routines, C4 PM-only create, public feed, and facets.
--   2. public.recruitment_location_assert_admin_or_bod(uuid, uuid) -> text
--      Actor mapping + paired ALL authority check returning the exact paired qualifying audit
--      capability (entry_admin, entry_privileged_edit, or report_analytics_view).
--   3. public.direct_entry_offboarding_authority(uuid, uuid) -> jsonb
--      Preserves Full Admin (WP8B-1 paired), upgrades BoD branch to paired entry_privileged_edit
--      at ALL (without widening to report-only BoD), and pairs Team Leader branch with
--      team_manager_assign on CONTEXT_TEAM matching v_team_id alongside
--      direct_entry_assert_team_leader_current_team (WP8C shared helper kept untouched).
--
-- Hard invariants preserved:
--   - Exact signatures, return types/values, STABLE volatility, SQLSTATE 42501, and messages.
--   - Zero row/advisory locks added (safe for STABLE read RPCs and post-lock callers such as
--     recruitment_post_update and recruitment_post_withdraw).
--   - Zero new public/service_role RPCs (preserves exact 336 service_role allowlist).
--   - Zero data/role/mapping mutation or backfill; zero email literals; zero default-privilege changes.

begin;

-- -----------------------------------------------------------------------------
-- 1. public.recruitment_location_is_admin_or_bod(uuid) -> boolean
--    Shared by Location Catalog and Recruitment Posts
--    (recruitment_post__internal_actor_is_full_admin_or_bod delegates here).
--    STABLE, zero locks, immune to cross-scope pairing (e.g. HR_OPERATOR + TEAM_LEADER)
--    and stale legacy grants on authz_managed accounts, while preserving pre-cutover R1
--    compatibility through WP8B-1 aligned ALL legacy bridge.
-- -----------------------------------------------------------------------------
create or replace function public.recruitment_location_is_admin_or_bod(
  p_app_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p_app_user_id is not null
    and (
      (
        public.direct_entry_authz__internal_has_paired_capability(
          p_app_user_id, 'entry_admin', 'ALL', null
        )
        and public.direct_entry_authz__internal_has_paired_capability(
          p_app_user_id, 'recruiter_master_manage', 'ALL', null
        )
        and public.direct_entry_authz__internal_has_paired_capability(
          p_app_user_id, 'team_master_manage', 'ALL', null
        )
      )
      or public.direct_entry_authz__internal_has_paired_capability(
        p_app_user_id, 'entry_privileged_edit', 'ALL', null
      )
      or (
        public.direct_entry_authz__internal_has_paired_capability(
          p_app_user_id, 'report_analytics_view', 'ALL', null
        )
        and public.direct_entry_authz__internal_has_paired_capability(
          p_app_user_id, 'report_view', 'ALL', null
        )
      )
    )
$function$;

revoke all on function public.recruitment_location_is_admin_or_bod(uuid)
  from public, anon, authenticated, service_role;

comment on function public.recruitment_location_is_admin_or_bod(uuid) is
  'WP8B-2 internal guard: paired Full Admin triple at ALL, OR entry_privileged_edit at ALL, OR (report_analytics_view + report_view) both paired at ALL. STABLE, zero locks, revoked from every non-owner role; backs Location Catalog and Recruitment Posts admin/BoD override.';

-- -----------------------------------------------------------------------------
-- 2. public.recruitment_location_assert_admin_or_bod(uuid, uuid) -> text
--    Verifies actor mapping + paired ALL authority and returns the exact paired
--    qualifying audit capability in canonical precedence order.
-- -----------------------------------------------------------------------------
create or replace function public.recruitment_location_assert_admin_or_bod(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if public.direct_entry_authz__internal_has_paired_capability(
       p_app_user_id, 'entry_admin', 'ALL', null
     )
     and public.direct_entry_authz__internal_has_paired_capability(
       p_app_user_id, 'recruiter_master_manage', 'ALL', null
     )
     and public.direct_entry_authz__internal_has_paired_capability(
       p_app_user_id, 'team_master_manage', 'ALL', null
     ) then
    return 'entry_admin';
  end if;

  if public.direct_entry_authz__internal_has_paired_capability(
       p_app_user_id, 'entry_privileged_edit', 'ALL', null
     ) then
    return 'entry_privileged_edit';
  end if;

  if public.direct_entry_authz__internal_has_paired_capability(
       p_app_user_id, 'report_analytics_view', 'ALL', null
     )
     and public.direct_entry_authz__internal_has_paired_capability(
       p_app_user_id, 'report_view', 'ALL', null
     ) then
    return 'report_analytics_view';
  end if;

  raise exception 'location catalog admin or bod authority denied' using errcode = '42501';
end;
$function$;

revoke all on function public.recruitment_location_assert_admin_or_bod(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function public.recruitment_location_assert_admin_or_bod(uuid, uuid) is
  'WP8B-2 internal guard: actor mapping + paired Full Admin triple or BoD bundle at ALL scope. Returns exact paired audit capability (entry_admin, entry_privileged_edit, or report_analytics_view); STABLE, zero locks, revoked from every non-owner role.';

-- -----------------------------------------------------------------------------
-- 3. public.direct_entry_offboarding_authority(uuid, uuid) -> jsonb
--    Branch 1: Full Admin via WP8B-1 paired direct_entry_assert_actor_app_user_admin.
--    Branch 2: BoD via paired entry_privileged_edit at ALL (strictly preserving
--              policy: report_analytics_view + report_view alone remains denied).
--    Branch 3: Active Team Leader via direct_entry_assert_team_leader_current_team
--              paired with team_manager_assign on CONTEXT_TEAM matching v_team_id.
--    All 3 branches preserve exact payload keys, flags, STABLE volatility, zero locks,
--    and 42501 error messages across report, export, and hide_snapshot.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_offboarding_authority(
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
  v_team_id uuid;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  begin
    perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
    return pg_catalog.jsonb_build_object(
      'scope', 'all',
      'team_id', null,
      'can_phone', true,
      'can_export', true,
      'can_hide', true,
      'authority', 'admin'
    );
  exception when insufficient_privilege then
    null;
  end;

  if public.direct_entry_authz__internal_has_paired_capability(
    p_app_user_id, 'entry_privileged_edit', 'ALL', null
  ) then
    return pg_catalog.jsonb_build_object(
      'scope', 'all',
      'team_id', null,
      'can_phone', true,
      'can_export', true,
      'can_hide', true,
      'authority', 'bod'
    );
  end if;

  begin
    v_team_id := public.direct_entry_assert_team_leader_current_team(
      p_auth_subject, p_app_user_id, null
    );
    if v_team_id is not null
       and public.direct_entry_authz__internal_has_paired_capability(
         p_app_user_id, 'team_manager_assign', 'CONTEXT_TEAM', v_team_id::text
       ) then
      return pg_catalog.jsonb_build_object(
        'scope', 'team',
        'team_id', v_team_id,
        'can_phone', false,
        'can_export', false,
        'can_hide', false,
        'authority', 'team_leader'
      );
    end if;
  exception when insufficient_privilege then
    null;
  end;

  raise exception 'offboarding report denied' using errcode = '42501';
end;
$function$;

revoke all on function public.direct_entry_offboarding_authority(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_offboarding_authority(uuid, uuid) is
  'WP8B-2 internal guard: Full Admin (WP8B-1 paired), BoD (entry_privileged_edit paired at ALL), or active Team Leader (current team paired with team_manager_assign at CONTEXT_TEAM). STABLE, zero locks, revoked from every non-owner role.';

-- -----------------------------------------------------------------------------
-- 4. Guarded owner alignment ($align_wp8b2$)
-- -----------------------------------------------------------------------------
do $align_wp8b2$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean;
  v_sig text;
  v_proc_owner_oid oid;
  v_sigs text[] := array[
    'public.recruitment_location_is_admin_or_bod(uuid)',
    'public.recruitment_location_assert_admin_or_bod(uuid,uuid)',
    'public.recruitment_post__internal_actor_is_full_admin_or_bod(uuid)',
    'public.direct_entry_offboarding_authority(uuid,uuid)'
  ];
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner_oid is null then
    raise exception 'WP8B2_ALIGN_BASE_OWNER_MISSING' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_sigs loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = v_sig::pg_catalog.regprocedure;

    if v_proc_owner_oid is null then
      raise exception 'WP8B2_ALIGN_FUNCTION_MISSING: %', v_sig using errcode = '55000';
    end if;

    if v_proc_owner_oid <> v_base_owner_oid and v_can_set_owner then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
  end loop;
end
$align_wp8b2$;

-- -----------------------------------------------------------------------------
-- 5. Fail-closed security, volatility, overload, search_path, and ACL self-check ($check_wp8b2$)
-- -----------------------------------------------------------------------------
do $check_wp8b2$
declare
  v_sig text;
  v_name text;
  v_oid oid;
  v_owner_oid oid;
  v_secdef boolean;
  v_volatile char;
  v_proconfig text[];
  v_owner_priv boolean;
  v_owner_exec boolean;
  v_exposed integer;
  v_overload_cnt integer;
  v_paired_helper_oid oid;
  v_loc_helper_oid oid;
  v_internal_fns text[] := array[
    'public.recruitment_location_is_admin_or_bod(uuid)',
    'public.recruitment_location_assert_admin_or_bod(uuid,uuid)',
    'public.recruitment_post__internal_actor_is_full_admin_or_bod(uuid)',
    'public.direct_entry_offboarding_authority(uuid,uuid)'
  ];
  v_fn_names text[] := array[
    'recruitment_location_is_admin_or_bod',
    'recruitment_location_assert_admin_or_bod',
    'recruitment_post__internal_actor_is_full_admin_or_bod',
    'direct_entry_offboarding_authority'
  ];
begin
  v_paired_helper_oid :=
    'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)'::pg_catalog.regprocedure;
  v_loc_helper_oid :=
    'public.recruitment_location_is_admin_or_bod(uuid)'::pg_catalog.regprocedure;

  foreach v_name in array v_fn_names loop
    select count(*)::integer
      into v_overload_cnt
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = v_name;

    if v_overload_cnt <> 1 then
      raise exception 'WP8B2_CHECK_OVERLOAD_COUNT_FAILED: % (count=%)', v_name, v_overload_cnt
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_internal_fns loop
    v_oid := v_sig::pg_catalog.regprocedure;

    select p.proowner,
           p.prosecdef,
           p.provolatile,
           p.proconfig,
           (r.rolsuper or r.rolbypassrls),
           pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE')
      into v_owner_oid, v_secdef, v_volatile, v_proconfig, v_owner_priv, v_owner_exec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_secdef, false)
       or v_volatile <> 's'
       or not coalesce(v_owner_priv, false)
       or not coalesce(v_owner_exec, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP8B2_CHECK_INTERNAL_DEF_FAILED: %', v_sig using errcode = '55000';
    end if;

    if not pg_catalog.has_function_privilege(v_owner_oid, v_paired_helper_oid, 'EXECUTE')
       or not pg_catalog.has_function_privilege(v_owner_oid, v_loc_helper_oid, 'EXECUTE') then
      raise exception 'WP8B2_CHECK_OWNER_CALLEE_EXEC_FAILED: %', v_sig using errcode = '55000';
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
      raise exception 'WP8B2_CHECK_INTERNAL_ACL_EXPOSED: % (% grants)', v_sig, v_exposed
        using errcode = '55000';
    end if;
  end loop;
end
$check_wp8b2$;

commit;
