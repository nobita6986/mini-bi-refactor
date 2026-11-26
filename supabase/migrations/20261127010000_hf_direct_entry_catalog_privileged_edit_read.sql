-- =============================================================================
-- Hotfix: Allow entry_privileged_edit, Team Leader, Project Manager, and
-- Full Admin actors to read direct_entry_input_catalog_unscoped_v42 without
-- requiring entry_create or entry_own grants.
--
-- Scope (ponytail minimal; 100% forward migration; +0 net functions):
--   1. public.direct_entry_input_catalog_unscoped_v42(uuid, uuid, date)
--      - Preserves up-front p_effective_date IS NULL guard (22023) and
--        direct_entry_app_users (app_user_id, auth_subject, enabled) guard
--        (42501 'actor capability denied') for ALL roles.
--      - Evaluates catalog read authorization strictly against CURRENT actor
--        authority (never p_effective_date):
--          * authz_managed = true: entry_create (OWN/ALL), entry_own (OWN),
--            or entry_privileged_edit (ALL/OWN with blank/null scope_id, or
--            CONTEXT_TEAM matching active non-__system_vendor__ team).
--          * authz_managed = false: current entry_create/entry_own capability
--            grant, or entry_privileged_edit + current all/own/active-team
--            scope grant.
--          * Fallback for both modes: current Full Admin, current Team Leader,
--            or current Project Manager assignment.
--      - Preserves exact catalog payload & p_effective_date lookup semantics.
--   2. Preserves strict REVOKE ALL FROM public, anon, authenticated, service_role
--      and guarded owner alignment.
--   3. Fail-closed postcheck DO $$ verifying overload, SECURITY DEFINER,
--      search_path, function body markers, and ACLs on both
--      direct_entry_input_catalog_unscoped_v42 and direct_entry_input_catalog.
-- =============================================================================

begin;

create or replace function public.direct_entry_input_catalog_unscoped_v42(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_effective_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_can_read_catalog boolean := false;
  v_result jsonb;
begin
  if p_effective_date is null then
    raise exception 'effective date required' using errcode = '22023';
  end if;

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject
     and u.enabled;
  if not found then
    raise exception 'actor capability denied' using errcode = '42501';
  end if;

  -- Authorization uses CURRENT actor state only; p_effective_date applies strictly to catalog lookups below.
  if v_authz_managed then
    select exists (
      select 1
        from pg_catalog.jsonb_to_recordset(
          public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id)
        ) as g(capability text, scope_kind text, scope_id text)
       where (
         g.capability = 'entry_create'
         and g.scope_kind in ('OWN', 'ALL')
         and nullif(pg_catalog.btrim(coalesce(g.scope_id, '')), '') is null
       )
          or (
         g.capability = 'entry_own'
         and g.scope_kind = 'OWN'
         and nullif(pg_catalog.btrim(coalesce(g.scope_id, '')), '') is null
       )
          or (
         g.capability = 'entry_privileged_edit'
         and (
           (
             g.scope_kind in ('ALL', 'OWN')
             and nullif(pg_catalog.btrim(coalesce(g.scope_id, '')), '') is null
           )
           or (
             g.scope_kind = 'CONTEXT_TEAM'
             and nullif(pg_catalog.btrim(coalesce(g.scope_id, '')), '') is not null
             and exists (
               select 1
                 from public.teams t
                where t.team_id::text = g.scope_id
                  and t.active
                  and t.code <> '__system_vendor__'
             )
           )
         )
       )
    )
      into v_can_read_catalog;
  else
    v_can_read_catalog := (
      exists (
        select 1
          from public.direct_entry_capability_grants g
         where g.app_user_id = p_app_user_id
           and g.capability in ('entry_create', 'entry_own')
           and g.is_current
      )
      or (
        public.direct_entry_has_capability(p_app_user_id, 'entry_privileged_edit')
        and exists (
          select 1
            from public.direct_entry_scope_grants g
           where g.app_user_id = p_app_user_id
             and g.is_current
             and (
               g.scope_kind in ('all', 'own')
               or (
                 g.scope_kind = 'team'
                 and g.team_id is not null
                 and exists (
                   select 1
                     from public.teams t
                    where t.team_id = g.team_id
                      and t.active
                      and t.code <> '__system_vendor__'
                 )
               )
             )
        )
      )
    );
  end if;

  if not coalesce(v_can_read_catalog, false) then
    begin
      perform public.direct_entry_assert_actor_app_user_admin(p_auth_subject, p_app_user_id);
      v_can_read_catalog := true;
    exception
      when insufficient_privilege then
        v_can_read_catalog := false;
    end;
  end if;

  if not coalesce(v_can_read_catalog, false) then
    begin
      v_can_read_catalog :=
        public.direct_entry_assert_team_leader_current_team(p_auth_subject, p_app_user_id, null) is not null;
    exception
      when insufficient_privilege then
        v_can_read_catalog := false;
    end;
  end if;

  if not coalesce(v_can_read_catalog, false) then
    v_can_read_catalog := coalesce(public.direct_entry_actor_has_project_assignment(p_app_user_id), false);
  end if;

  if not coalesce(v_can_read_catalog, false) then
    raise exception 'actor capability denied' using errcode = '42501';
  end if;

  with hrp_memberships as (
    select m.recruiter_id, count(*) as membership_count
      from public.recruiter_provider_memberships m
     where m.provider_type = 'hrp'
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date)
     group by m.recruiter_id
  ), vendor_memberships as (
    select m.recruiter_id, m.vendor_id
      from public.recruiter_provider_memberships m
     where m.provider_type = 'vendor'
       and public.direct_entry__internal_recruiter_provider_membership_effective(m.membership_id, p_effective_date)
  ), hrp_teams as (
    select m.recruiter_id, count(*) as membership_count,
           min(m.team_id::text)::uuid as team_id
      from public.recruiter_team_memberships m
     where public.direct_entry__internal_recruiter_team_membership_effective(m.membership_id, p_effective_date)
     group by m.recruiter_id
  ), hrp_recruiters as (
    select r.recruiter_id, r.display_name, r.personnel_code, tt.team_id,
           team.display_name as team_display_name
      from public.recruiters r
      join hrp_memberships p on p.recruiter_id = r.recruiter_id
                            and p.membership_count = 1
      join hrp_teams tt on tt.recruiter_id = r.recruiter_id
                        and tt.membership_count = 1
      join public.teams team on team.team_id = tt.team_id and team.active
     where r.active
  ), vendor_recruiters as (
    select r.recruiter_id, r.display_name, vm.vendor_id,
           v.display_name as vendor_display_name
      from public.recruiters r
      join vendor_memberships vm on vm.recruiter_id = r.recruiter_id
      left join public.vendors v on v.vendor_id = vm.vendor_id and v.active
     where r.active
       and (vm.vendor_id is null or v.vendor_id is not null)
  )
  select jsonb_build_object(
    'effective_date', p_effective_date,
    'labor_types', public.direct_entry_labor_type_options(),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'project_id', p.project_id, 'display_name', p.display_name
      ) order by p.display_name, p.project_id)
        from public.direct_entry_projects p
       where p.active
    ), '[]'::jsonb),
    'recruiters', coalesce((
      select coalesce(jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', r.display_name,
        'personnel_code', r.personnel_code,
        'provider_type', 'hrp',
        'vendor_id', null,
        'team_id', r.team_id,
        'team_display_name', r.team_display_name,
        'label', (
          r.display_name
          || ' · ' || coalesce(r.personnel_code, '—')
          || ' · ' || r.team_display_name
        )
      ) order by r.display_name, r.team_display_name, r.recruiter_id), '[]'::jsonb)
        from hrp_recruiters r
    ) || coalesce((
      select jsonb_agg(jsonb_build_object(
        'recruiter_id', r.recruiter_id,
        'display_name', coalesce(r.vendor_display_name, r.display_name),
        'personnel_code', null,
        'provider_type', 'vendor',
        'vendor_id', r.vendor_id,
        'team_id', null,
        'team_display_name', null,
        'label', coalesce(r.vendor_display_name, r.display_name)
      ) order by coalesce(r.vendor_display_name, r.display_name), r.recruiter_id)
        from vendor_recruiters r
    ), '[]'::jsonb), '[]'::jsonb),
    'banks', coalesce((
      select jsonb_agg(jsonb_build_object(
        'bank_id', b.bank_id, 'display_name', b.display_name
      ) order by b.display_name, b.bank_id)
        from public.direct_entry_banks b
       where b.active
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

revoke all on function public.direct_entry_input_catalog_unscoped_v42(uuid, uuid, date)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_input_catalog_unscoped_v42(uuid, uuid, date) is
  'Internal unscoped catalog loader: allows current entry_create, entry_own, entry_privileged_edit (ALL/OWN/active CONTEXT_TEAM), Full Admin, Team Leader, or Project Manager actors while keeping p_effective_date scoped strictly to catalog lookups.';

do $hf_catalog_postcheck$
declare
  v_unscoped_sig constant text := 'public.direct_entry_input_catalog_unscoped_v42(uuid,uuid,date)';
  v_outer_sig constant text := 'public.direct_entry_input_catalog(uuid,uuid,date)';
  v_unscoped_oid oid;
  v_outer_oid oid;
  v_overload_count integer := 0;
  v_base_owner_oid oid;
  v_base_owner text;
  v_can_set_owner boolean := false;
  v_rec record;
  v_def text;
begin
  select count(*)::integer
    into v_overload_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'direct_entry_input_catalog_unscoped_v42';

  if v_overload_count <> 1 then
    raise exception 'HF_CATALOG_POSTCHECK_FAILED: expected single overload for direct_entry_input_catalog_unscoped_v42, found %',
      v_overload_count
      using errcode = '55000';
  end if;

  v_unscoped_oid := pg_catalog.to_regprocedure(v_unscoped_sig);
  if v_unscoped_oid is null then
    raise exception 'HF_CATALOG_POSTCHECK_FAILED: missing function %', v_unscoped_sig
      using errcode = '55000';
  end if;

  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner is null then
    raise exception 'HF_CATALOG_POSTCHECK_FAILED: unable to resolve base owner'
      using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  select p.proowner, p.prosecdef, p.proconfig
    into v_rec
    from pg_catalog.pg_proc p
   where p.oid = v_unscoped_oid;

  if v_can_set_owner and v_rec.proowner is distinct from v_base_owner_oid then
    execute pg_catalog.format('alter function %s owner to %I', v_unscoped_sig, v_base_owner);
    select p.proowner, p.prosecdef, p.proconfig
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_unscoped_oid;
  end if;

  if not coalesce(v_rec.prosecdef, false)
     or pg_catalog.array_to_string(coalesce(v_rec.proconfig, array[]::text[]), ',') <> 'search_path=pg_catalog, public' then
    raise exception 'HF_CATALOG_POSTCHECK_FAILED: invalid SECURITY DEFINER or search_path on %', v_unscoped_sig
      using errcode = '55000';
  end if;

  v_def := pg_catalog.pg_get_functiondef(v_unscoped_oid);
  if position('direct_entry_labor_type_options' in v_def) = 0
     or position('entry_privileged_edit' in v_def) = 0 then
    raise exception 'HF_CATALOG_POSTCHECK_FAILED: expected markers missing in %', v_unscoped_sig
      using errcode = '55000';
  end if;

  if pg_catalog.has_function_privilege('public', v_unscoped_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_unscoped_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_unscoped_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', v_unscoped_oid, 'EXECUTE') then
    raise exception 'HF_CATALOG_POSTCHECK_FAILED: unexpected EXECUTE privilege on %', v_unscoped_sig
      using errcode = '55000';
  end if;

  select count(*)::integer
    into v_overload_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'direct_entry_input_catalog';

  if v_overload_count <> 1 then
    raise exception 'HF_CATALOG_POSTCHECK_FAILED: expected single overload for direct_entry_input_catalog, found %',
      v_overload_count
      using errcode = '55000';
  end if;

  v_outer_oid := pg_catalog.to_regprocedure(v_outer_sig);
  if v_outer_oid is null then
    raise exception 'HF_CATALOG_POSTCHECK_FAILED: missing function %', v_outer_sig
      using errcode = '55000';
  end if;

  if not pg_catalog.has_function_privilege('service_role', v_outer_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('public', v_outer_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_outer_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_outer_oid, 'EXECUTE') then
    raise exception 'HF_CATALOG_POSTCHECK_FAILED: invalid EXECUTE ACL on %', v_outer_sig
      using errcode = '55000';
  end if;

  v_def := pg_catalog.pg_get_functiondef(v_outer_oid);
  if position('direct_entry_actor_can_access_project' in v_def) = 0 then
    raise exception 'HF_CATALOG_POSTCHECK_FAILED: missing direct_entry_actor_can_access_project in %', v_outer_sig
      using errcode = '55000';
  end if;
end
$hf_catalog_postcheck$;

commit;
