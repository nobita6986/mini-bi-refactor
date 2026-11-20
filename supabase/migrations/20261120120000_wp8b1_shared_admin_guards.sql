-- WP8B-1: Shared Admin / Catalog Operator / Project Admin SQL Guards on WP5 Paired Effective Access
--
-- Scope (strictly limited to the 3 existing internal shared guard functions plus
-- R1 pre-cutover ALL-scope legacy-bridge alignment in direct_entry_authz__internal_resolve_effective_grants):
--   0. public.direct_entry_authz__internal_resolve_effective_grants(uuid) -> jsonb
--      Aligns the pre-cutover (not authz_managed) ALL-scope LEGACY_BRIDGE predicate with R1
--      current-state authorization (sg.is_current AND NOT sg.suspended_by_account_disable) so
--      SQL paired checks and direct_entry_resolve_actor_context -> TS guards share a single
--      source of truth, while keeping post-cutover (authz_managed = true) strictly paired with
--      zero legacy fallback.
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
--   - Zero new public/service_role RPCs (all 4 remain strictly internal, revoked from PUBLIC, anon,
--     authenticated, service_role; preserves exact 336 service_role allowlist).
--   - Zero data/role/mapping mutation or backfill; zero email literals; zero nested tx-points; zero default-privilege changes.

begin;

-- -----------------------------------------------------------------------------
-- 0. public.direct_entry_authz__internal_resolve_effective_grants(uuid) -> jsonb
--    Identical to WP5B-2 (#221) except pre-cutover (not authz_managed) ALL-scope
--    LEGACY_BRIDGE checks sg.is_current and not sg.suspended_by_account_disable
--    (R1 current-state authority, matching direct_entry__internal_capability_grant_effective
--    and direct_entry_has_scope('all')) so SQL and TS resolve identically pre-cutover
--    while post-cutover (authz_managed = true) remains 100% immune to stale legacy rows.
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
    -- ALL branch follows R1 current-state authority (is_current and not suspended_by_account_disable),
    -- keeping SQL guards and direct_entry_resolve_actor_context -> TS guards strictly synchronized.
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
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if not (
    public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null)
  ) then
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
  v_grants jsonb;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
     and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
     and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null) then
    return 'entry_admin';
  end if;

  if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'catalog_master_manage', 'ALL', null) then
    return 'catalog_master_manage';
  end if;

  -- Denial diagnostics only (allow/deny is already decided above): preserve
  -- historical SQLSTATE 42501 message split between missing capability vs missing ALL scope.
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

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
  v_grants jsonb;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  if public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null) then
    return;
  end if;

  -- Denial diagnostics only (allow/deny is already decided above): preserve
  -- historical SQLSTATE 42501 message split between missing capability vs missing ALL scope.
  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

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
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
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
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
    'public.direct_entry_assert_actor_app_user_admin(uuid,uuid)',
    'public.direct_entry_assert_catalog_operator(uuid,uuid)',
    'public.direct_entry_assert_project_admin(uuid,uuid)'
  ];
  v_fn_names text[] := array[
    'direct_entry_authz__internal_resolve_effective_grants',
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
