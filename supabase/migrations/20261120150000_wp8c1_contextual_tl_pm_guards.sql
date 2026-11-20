-- Migration: 20261120150000_wp8c1_contextual_tl_pm_guards.sql
-- Purpose: WP8C-1 — Migrate shared Team Leader / Project Manager / Entry Access
--   guards and tightly coupled actor-context / directory / submission callers
--   to canonical WP5 contextual & paired effective access.
--
-- Scope (ponytail minimal):
--   0. public.direct_entry_authz__internal_resolve_effective_grants(uuid)
--        - Extends the WP8B-1 pre-cutover (not authz_managed) R1 alignment to
--          the OWN legacy-bridge branch (sg.is_current and not
--          sg.suspended_by_account_disable) and adds 'change_review' to the
--          CONTEXT_TEAM legacy-bridge allowlist so pre-cutover SQL and TS
--          predicates remain 100% synchronized. Zero change to authz_managed=true.
--   1. public.direct_entry_assert_team_leader_current_team(uuid, uuid, uuid)
--        - authz_managed = true: resolves strictly from canonical
--          direct_entry_team_leader_assignments + active non-vendor team +
--          unique paired team_manager_assign at CONTEXT_TEAM in WP5
--          effective_grants + verified current non-suspended recruiter link
--          (NORMAL account, no Person requirement for quarantine accounts) +
--          active recruiter + unique effective HRP provider & matching team
--          membership. Zero legacy capability/scope mirror reads; fail-closed
--          on wrong p_team_id, multi-team ambiguity, non-TL direct grant, or
--          empty effective_grants.
--        - authz_managed = false: preserves pre-cutover R1 & rollover behavior.
--   2. public.direct_entry_offboarding_authority(uuid, uuid)
--        - Deduplicates Branch 3 by delegating directly to the upgraded
--          canonical direct_entry_assert_team_leader_current_team + paired check.
--   3. public.direct_entry_project_assignment_effective(uuid, text)
--        - Aligns with WP5/WP8A invariants (not suspended_by_account_disable,
--          account_type = 'NORMAL', half-open valid_from/valid_to on both
--          assignment & link, unique verified current link per recruiter).
--        - Deliberately does NOT filter direct_entry_projects.active so
--          recruitment_post_create keeps raising 22023
--          RECRUITMENT_POST_CONTENT_INVALID for inactive projects and R1
--          historical project access remains intact.
--        - Deliberately does NOT require organization_account_person_links so
--          quarantine operational accounts retain PM authority.
--        - public.direct_entry_actor_is_assigned_project_manager(uuid, text)
--          inherits these tightened invariants automatically.
--   4. public.direct_entry_assert_project_operation_authority(uuid, uuid)
--      & public.direct_entry_lock_project_team_manager_context(uuid, uuid, uuid, uuid)
--        - Step 3 / post-lock re-check delegate directly to
--          direct_entry_assert_team_leader_current_team instead of
--          direct_entry_assert_team_leader_read_authority, closing the latent
--          team_master_manage at ALL -> (team_manager_assign, NULL) bypass and
--          enabling managed TLs without legacy mirror rows.
--        - Lock set and lock ordering in direct_entry_lock_project_team_manager_context
--          are unchanged; shared guards acquire zero locks.
--   5. public.direct_entry_assert_entry_access(...)
--      & public.direct_entry_has_entry_access(...)
--      & public.direct_entry_resolve_direct_edit_authority(...)
--      & public.direct_entry_actor_can_access_project(...)
--        - authz_managed = true evaluates strictly from WP5 paired
--          effective_grants (ALL / OWN / CONTEXT_TEAM), closing cross-scope
--          escalation (e.g. HR_OPERATOR + RECRUITER document_upload) while
--          preserving 'all' < 'own' < 'team', p_required_scope, exact 42501
--          messages ('actor mapping denied', 'capability denied', 'resource
--          scope denied'), and pre-cutover compatibility.
--   6. public.direct_entry_resolve_actor_context(uuid),
--      public.direct_entry_worker_directory_audience(uuid, uuid, text, text),
--      public.direct_entry_list_own_submissions(uuid, uuid, integer, text, text),
--      public.direct_entry_read_own_submission(uuid, uuid, uuid)
--        - Synchronizes v_team_leader_team_id, allowed_worker_tabs, directory
--          audiences ('recruited'/'managed'/'team'/'all'), and own-submission
--          uploaders on WP5 paired/canonical access for authz_managed accounts
--          while preserving exact 12/13-key actor payload, pre-cutover R1
--          parity, and zero changes to WP8D read-only nav probe.
--
-- Adds +0 new service_role RPCs (preserves exact 337 service_role RPCs).

begin;

-- -----------------------------------------------------------------------------
-- 0. public.direct_entry_authz__internal_resolve_effective_grants(uuid) -> jsonb
--    Identical to WP8B-1 (#226) except pre-cutover (not authz_managed):
--      - OWN legacy_bridge branch aligns with R1 current-state authority
--        (sg.is_current and not sg.suspended_by_account_disable), matching the
--        ALL branch aligned in WP8B-1.
--      - CONTEXT_TEAM legacy_bridge allowlist includes 'change_review' so
--        pre-cutover team reviewers keep SQL/TS parity.
--    Post-cutover (authz_managed = true) is completely unchanged (zero legacy).
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
    -- Narrow compatibility bridge until WP8D: active Team Leader holding open report_review grant.
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
    -- ALL and OWN branches follow R1 current-state authority (is_current and not suspended_by_account_disable),
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
        'report_view', 'report_analytics_view', 'report_assign', 'report_review'
      )
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
-- 1. public.direct_entry_assert_team_leader_current_team(uuid, uuid, uuid) -> uuid
--    STABLE, SECURITY DEFINER, zero locks, revoked from all runtime roles.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_team_leader_current_team(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date := public.direct_entry_authorization_date();
  v_authz_managed boolean := false;
  v_account_type text;
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

  select coalesce(u.authz_managed, false), u.account_type
    into v_authz_managed, v_account_type
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if v_authz_managed then
    if v_account_type is distinct from 'NORMAL' then
      raise exception 'team leader authority denied' using errcode = '42501';
    end if;

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
$function$;

revoke all on function public.direct_entry_assert_team_leader_current_team(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_assert_team_leader_current_team(uuid, uuid, uuid) is
  'WP8C-1 canonical Team Leader current-team guard: authz_managed accounts resolve strictly from direct_entry_team_leader_assignments + WP5 paired team_manager_assign at unique CONTEXT_TEAM + HRP/recruiter/team structural invariants (zero legacy mirror dependency); pre-cutover accounts preserve R1 & rollover semantics. STABLE, zero locks, revoked from every non-owner role.';

-- -----------------------------------------------------------------------------
-- 2. public.direct_entry_offboarding_authority(uuid, uuid) -> jsonb
--    Deduplicates Branch 3 by delegating directly to the canonical shared
--    direct_entry_assert_team_leader_current_team + paired CONTEXT_TEAM check.
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
  'WP8C-1 deduplicated Offboarding authority guard: Full Admin (WP8B-1 paired), BoD (entry_privileged_edit paired at ALL), or active Team Leader via canonical direct_entry_assert_team_leader_current_team + paired CONTEXT_TEAM check. STABLE, zero locks, revoked from every non-owner role.';

-- -----------------------------------------------------------------------------
-- 3. public.direct_entry_project_assignment_effective(uuid, text) -> boolean
--    Aligned with WP5/WP8A invariants without filtering direct_entry_projects.active
--    (preserves recruitment_post_create 22023 RECRUITMENT_POST_CONTENT_INVALID for
--    inactive projects and R1 historical project access) and without requiring
--    organization_account_person_links (preserves quarantine operational accounts).
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_project_assignment_effective(
  p_app_user_id uuid,
  p_project_id text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
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
          and (not coalesce(u.authz_managed, false) or u.account_type = 'NORMAL')
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
               and (not coalesce(linked_user.authz_managed, false) or linked_user.account_type = 'NORMAL')
          ) = 1
     );
$function$;

revoke all on function public.direct_entry_project_assignment_effective(uuid, text)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_project_assignment_effective(uuid, text) is
  'WP8C-1 canonical Project Manager assignment effectiveness check: requires current non-revoked assignment within [valid_from, valid_to), unique verified non-suspended current recruiter link within [valid_from, valid_to), active recruiter, and enabled NORMAL account with auth_subject (no Person link required). Preserves inactive-project history and recruitment_post_create 22023 ordering. STABLE, zero locks, revoked from every non-owner role.';

-- -----------------------------------------------------------------------------
-- 4. public.direct_entry_assert_project_operation_authority(uuid, uuid)
--    & public.direct_entry_lock_project_team_manager_context(uuid, uuid, uuid, uuid)
--    Branch 3 & post-lock re-check call direct_entry_assert_team_leader_current_team
--    directly, closing the team_master_manage at ALL -> (team_manager_assign, NULL)
--    bypass while preserving lock order and canonical TL evaluation.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_project_operation_authority(
  p_auth_subject uuid,
  p_app_user_id uuid
)
returns table (authority text, team_id uuid)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  begin
    authority := public.direct_entry_assert_catalog_operator(p_auth_subject, p_app_user_id);
    team_id := null;
    return next;
    return;
  exception
    when insufficient_privilege then
      null;
  end;

  begin
    perform public.direct_entry_assert_project_admin(p_auth_subject, p_app_user_id);
    authority := 'entry_admin';
    team_id := null;
    return next;
    return;
  exception
    when insufficient_privilege then
      null;
  end;

  team_id := public.direct_entry_assert_team_leader_current_team(
    p_auth_subject, p_app_user_id, null
  );
  authority := 'team_manager_assign';
  return next;
end;
$function$;

revoke all on function public.direct_entry_assert_project_operation_authority(uuid, uuid)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_assert_project_operation_authority(uuid, uuid) is
  'WP8C-1 internal project-operation authority selector: catalog operator (WP8B-1 paired), project admin (entry_admin paired at ALL), or active Team Leader via canonical direct_entry_assert_team_leader_current_team (never admits team_master_manage at ALL with NULL team_id). STABLE, zero locks, revoked from every non-owner role.';

create or replace function public.direct_entry_lock_project_team_manager_context(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid,
  p_manager_recruiter_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_app_user_ids uuid[];
  v_leader_recruiter_id uuid;
  v_link_count integer;
  v_locked_team_id uuid;
  v_lock_key text;
begin
  if p_team_id is null or p_manager_recruiter_id is null then
    raise exception 'team manager context required' using errcode = '22023';
  end if;

  perform t.team_id
    from public.teams t
   where t.team_id = p_team_id
   for update;
  if not found then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  select pg_catalog.array_agg(ids.app_user_id order by ids.app_user_id)
    into v_app_user_ids
    from (
      select p_app_user_id as app_user_id
      union
      select l.app_user_id
        from public.direct_entry_app_user_recruiter_links l
       where l.recruiter_id = p_manager_recruiter_id
         and l.verified
         and l.is_current
    ) ids;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_app_user_ids)
   order by u.app_user_id
   for update;
  perform s.grant_id
    from public.direct_entry_scope_grants s
   where s.app_user_id = p_app_user_id
     and s.scope_kind = 'team'
   order by s.grant_id
   for update;
  perform g.grant_id
    from public.direct_entry_capability_grants g
   where g.app_user_id = p_app_user_id
     and g.capability = 'team_manager_assign'
   order by g.grant_id
   for update;

  for v_lock_key in
    select distinct keys.key
      from (
        select 'capability:' || p_app_user_id::text || ':team_manager_assign' as key
        union all
        select 'scope:' || p_app_user_id::text || ':team:' || p_team_id::text
        union all
        select 'recruiter-link:' || ids.app_user_id::text
          from unnest(v_app_user_ids) ids(app_user_id)
      ) keys
     order by keys.key
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key, 0));
  end loop;

  perform l.link_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_app_user_ids)
   order by l.link_id
   for update;

  select count(*)::integer,
         (pg_catalog.array_agg(l.recruiter_id order by l.link_id))[1]
    into v_link_count, v_leader_recruiter_id
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = p_app_user_id
     and l.verified
     and l.is_current
     and not l.suspended_by_account_disable;
  if v_link_count <> 1 or v_leader_recruiter_id is null then
    raise exception 'team leader authority denied' using errcode = '42501';
  end if;

  perform r.recruiter_id
    from public.recruiters r
   where r.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by r.recruiter_id
   for update;

  for v_lock_key in
    select distinct keys.key
      from unnest(array[
        'provider:' || v_leader_recruiter_id::text,
        'team-membership:' || v_leader_recruiter_id::text,
        'provider:' || p_manager_recruiter_id::text,
        'team-membership:' || p_manager_recruiter_id::text
      ]) keys(key)
     order by keys.key
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_lock_key, 0));
  end loop;

  perform m.membership_id
    from public.recruiter_provider_memberships m
   where m.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by m.recruiter_id, m.membership_id
   for update;
  perform m.membership_id
    from public.recruiter_team_memberships m
   where m.recruiter_id in (v_leader_recruiter_id, p_manager_recruiter_id)
   order by m.recruiter_id, m.membership_id
   for update;

  v_locked_team_id := public.direct_entry_assert_team_leader_current_team(
    p_auth_subject, p_app_user_id, p_team_id
  );
  if v_locked_team_id is distinct from p_team_id then
    raise exception 'team leader authority changed' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function public.direct_entry_lock_project_team_manager_context(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. public.direct_entry_assert_entry_access(...)
--    public.direct_entry_has_entry_access(...)
--    public.direct_entry_resolve_direct_edit_authority(...)
--    public.direct_entry_actor_can_access_project(...)
--    WP5 paired scope evaluation for authz_managed accounts; R1 compatibility
--    preserved for pre-cutover accounts. All STABLE, zero locks.
-- -----------------------------------------------------------------------------
create or replace function public.direct_entry_assert_entry_access(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text,
  p_entry_owner uuid,
  p_team_id uuid,
  p_effective_date date,
  p_required_scope text default null
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_grants jsonb := '[]'::jsonb;
  v_has_cap boolean := false;
  v_scope text;
  v_matches integer := 0;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if v_authz_managed then
    if p_capability is null
       or pg_catalog.btrim(p_capability) = ''
       or p_capability in ('pii_view', 'pii_export', 'payment_view', 'payment_edit') then
      raise exception 'capability denied' using errcode = '42501';
    end if;

    v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);

    select exists (
      select 1
        from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text, scope_kind text, scope_id text)
       where g.capability = p_capability
    ) into v_has_cap;

    if not coalesce(v_has_cap, false) then
      raise exception 'capability denied' using errcode = '42501';
    end if;

    select count(*)::integer, min(matched.legacy_scope)
      into v_matches, v_scope
      from (
        select case
                 when g.scope_kind = 'ALL' and g.scope_id is null then 'all'
                 when g.scope_kind = 'OWN' and g.scope_id is null and p_entry_owner = p_app_user_id then 'own'
                 when g.scope_kind = 'CONTEXT_TEAM'
                      and p_team_id is not null
                      and g.scope_id = p_team_id::text
                      and exists (
                        select 1
                          from public.teams t
                         where t.team_id = p_team_id
                           and t.active
                           and t.code <> '__system_vendor__'
                      ) then 'team'
                 else null
               end as legacy_scope
          from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text, scope_kind text, scope_id text)
         where g.capability = p_capability
      ) matched
     where matched.legacy_scope is not null
       and (p_required_scope is null or matched.legacy_scope = p_required_scope);

    if v_matches = 0 or v_scope is null then
      raise exception 'resource scope denied' using errcode = '42501';
    end if;

    return v_scope;
  end if;

  -- Pre-cutover (authz_managed = false): preserve exact R1 semantics.
  perform public.direct_entry_assert_actor(p_auth_subject, p_app_user_id, p_capability);
  select count(*)::integer, min(g.scope_kind) into v_matches, v_scope
    from public.direct_entry_scope_grants g
   where g.app_user_id = p_app_user_id and g.is_current
     and (g.scope_kind <> 'team' or exists (
       select 1 from public.teams t where t.team_id = g.team_id and t.active
     ))
     and ((g.scope_kind = 'own' and p_entry_owner = p_app_user_id)
       or (g.scope_kind = 'team' and g.team_id = p_team_id)
       or g.scope_kind = 'all')
     and (p_required_scope is null or g.scope_kind = p_required_scope);
  if v_matches = 0 then
    raise exception 'resource scope denied' using errcode = '42501';
  end if;
  return v_scope;
end;
$function$;

revoke all on function public.direct_entry_assert_entry_access(uuid, uuid, text, uuid, uuid, date, text)
  from public, anon, authenticated, service_role;

comment on function public.direct_entry_assert_entry_access(uuid, uuid, text, uuid, uuid, date, text) is
  'WP8C-1 entry access guard: evaluates strictly paired (capability, scope) from WP5 effective_grants for authz_managed accounts (closing cross-scope escalation and legacy mirror dependency) while preserving pre-cutover R1 compatibility, all < own < team precedence, p_required_scope, and exact 42501 messages. STABLE, zero locks.';

create or replace function public.direct_entry_has_entry_access(
  p_app_user_id uuid,
  p_capability text,
  p_entry_owner uuid,
  p_team_id uuid,
  p_effective_date date
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_enabled boolean := false;
  v_authz_managed boolean := false;
  v_grants jsonb := '[]'::jsonb;
begin
  if p_app_user_id is null
     or p_capability is null
     or pg_catalog.btrim(p_capability) = ''
     or p_capability in ('pii_view', 'pii_export', 'payment_view', 'payment_edit') then
    return false;
  end if;

  select u.enabled, coalesce(u.authz_managed, false)
    into v_enabled, v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found or not coalesce(v_enabled, false) then
    return false;
  end if;

  if v_authz_managed then
    v_grants := public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id);
    return exists (
      select 1
        from pg_catalog.jsonb_to_recordset(v_grants) as g(capability text, scope_kind text, scope_id text)
       where g.capability = p_capability
         and (
           (g.scope_kind = 'ALL' and g.scope_id is null)
           or (g.scope_kind = 'OWN' and g.scope_id is null and p_entry_owner = p_app_user_id)
           or (
             g.scope_kind = 'CONTEXT_TEAM'
             and p_team_id is not null
             and g.scope_id = p_team_id::text
             and exists (
               select 1
                 from public.teams t
                where t.team_id = p_team_id
                  and t.active
                  and t.code <> '__system_vendor__'
             )
           )
         )
    );
  end if;

  return public.direct_entry_has_capability(p_app_user_id, p_capability)
     and exists (
       select 1 from public.direct_entry_scope_grants sg
        where sg.app_user_id = p_app_user_id and sg.is_current
          and (sg.scope_kind <> 'team' or exists (
            select 1 from public.teams t where t.team_id = sg.team_id and t.active
          ))
          and ((sg.scope_kind = 'own' and p_entry_owner = p_app_user_id)
            or (sg.scope_kind = 'team' and p_team_id is not null and sg.team_id = p_team_id)
            or sg.scope_kind = 'all')
     );
end;
$function$;

revoke all on function public.direct_entry_has_entry_access(uuid, text, uuid, uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_resolve_direct_edit_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_owner uuid,
  p_team_id uuid,
  p_project_id text,
  p_is_full_admin boolean,
  p_team_leader_team_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_enabled boolean := false;
  v_authz_managed boolean := false;
  v_scope text;
begin
  if p_is_full_admin then
    return 'admin_all';
  end if;

  -- Exception-free evaluation (required by R2.1: called per-row in directory & duplicate-CCCD queries).
  select u.enabled, coalesce(u.authz_managed, false)
    into v_enabled, v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
     and u.auth_subject = p_auth_subject;

  if found and coalesce(v_enabled, false) then
    if v_authz_managed then
      select min(matched.legacy_scope)
        into v_scope
        from (
          select case
            when g.scope_kind = 'ALL'
                 and (g.scope_id is null or pg_catalog.btrim(g.scope_id) = '')
              then 'all'::text
            when g.scope_kind = 'OWN'
                 and (g.scope_id is null or pg_catalog.btrim(g.scope_id) = '')
                 and p_entry_owner = p_app_user_id
              then 'own'::text
            when g.scope_kind = 'CONTEXT_TEAM'
                 and p_team_id is not null
                 and g.scope_id = p_team_id::text
                 and exists (
                   select 1
                     from public.teams t
                    where t.team_id = p_team_id
                      and t.active
                      and t.code <> '__system_vendor__'
                 )
              then 'team'::text
            else null::text
          end as legacy_scope
            from pg_catalog.jsonb_to_recordset(
              public.direct_entry_authz__internal_resolve_effective_grants(p_app_user_id)
            ) as g(capability text, scope_kind text, scope_id text)
           where g.capability = 'entry_privileged_edit'
        ) matched
       where matched.legacy_scope is not null;

      if v_scope is not null then
        return 'privileged_' || v_scope;
      end if;
    elsif public.direct_entry_has_entry_access(
      p_app_user_id, 'entry_privileged_edit', p_entry_owner, p_team_id, null
    ) then
      select min(g.scope_kind)
        into v_scope
        from public.direct_entry_scope_grants g
       where g.app_user_id = p_app_user_id
         and g.is_current
         and (g.scope_kind <> 'team' or exists (
           select 1 from public.teams t where t.team_id = g.team_id and t.active
         ))
         and ((g.scope_kind = 'own' and p_entry_owner = p_app_user_id)
           or (g.scope_kind = 'team' and p_team_id is not null and g.team_id = p_team_id)
           or g.scope_kind = 'all');
      if v_scope is not null then
        return 'privileged_' || v_scope;
      end if;
    end if;
  end if;

  if public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, p_project_id) then
    return 'project_manager';
  end if;
  if p_team_id is not null and p_team_id = p_team_leader_team_id then
    return 'team_leader';
  end if;
  return null;
end;
$function$;

revoke all on function public.direct_entry_resolve_direct_edit_authority(uuid, uuid, uuid, uuid, text, boolean, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_actor_can_access_project(
  p_app_user_id uuid,
  p_project_id text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p_app_user_id is not null
     and p_project_id is not null
     and (
       public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
       or public.direct_entry_project_assignment_effective(p_app_user_id, p_project_id)
     );
$function$;

revoke all on function public.direct_entry_actor_can_access_project(uuid, text)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 6. public.direct_entry_resolve_actor_context(uuid)
--    public.direct_entry_worker_directory_audience(uuid, uuid, text, text)
--    public.direct_entry_list_own_submissions(uuid, uuid, integer, text, text)
--    public.direct_entry_read_own_submission(uuid, uuid, uuid)
--    Synchronizes v_team_leader_team_id, allowed_worker_tabs, worker directory
--    audiences, and own-submission readers on canonical WP5 access for
--    authz_managed accounts while keeping exact 12/13-key payload and pre-cutover
--    R1 parity.
-- -----------------------------------------------------------------------------
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
  v_authz_managed boolean := false;
  v_review_scopes jsonb;
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

  if v_enabled then
    v_effective_grants := public.direct_entry_authz__internal_resolve_effective_grants(v_app_user_id);

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
            and (not v_authz_managed or u.account_type = 'NORMAL')
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
          rd.sort_order,
          ara.role_code,
          rd.display_name,
          'GLOBAL'::text as assignment_mode,
          null::text as scope_kind,
          null::text as scope_id,
          ara.assignment_id::text as assignment_id,
          ara.is_protected,
          (not ara.is_protected) as can_revoke,
          case when ara.is_protected then 'PROTECTED_OWNER_ADMIN' else null end as cannot_revoke_reason
        from public.authz_account_role_assignments ara
        join public.authz_role_definitions rd on rd.role_code = ara.role_code
        where ara.app_user_id = v_app_user_id
          and ara.ended_at is null
          and ara.started_at <= v_now
          and (not rd.requires_active_person or coalesce(v_has_active_person, false))
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
$function$;

revoke all on function public.direct_entry_resolve_actor_context(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_resolve_actor_context(uuid)
  to service_role;

create or replace function public.direct_entry_worker_directory_audience(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_scope text,
  p_project_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
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
       and (not coalesce(u.authz_managed, false) or u.account_type = 'NORMAL')
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
$function$;

revoke all on function public.direct_entry_worker_directory_audience(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;

create or replace function public.direct_entry_list_own_submissions(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_page_size integer,
  p_cursor text,
  p_state text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_page_size integer;
  v_cursor_stamp text;
  v_cursor_id uuid;
  v_own_scope_count integer;
  v_can_list_own boolean := false;
  v_has_project_assignment boolean := false;
  v_scanned integer;
  v_items jsonb;
  v_next_cursor text;
  v_has_more boolean;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if v_authz_managed then
    v_can_list_own :=
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null);
  else
    select count(*)::integer into v_own_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'own'
       and g.team_id is null
       and g.is_current;
    v_can_list_own := v_own_scope_count = 1
      and public.direct_entry_has_capability(p_app_user_id, 'submission_create');
  end if;

  v_has_project_assignment := public.direct_entry_actor_has_project_assignment(p_app_user_id);
  if not v_can_list_own and not v_has_project_assignment then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  v_page_size := coalesce(p_page_size, 20);
  if v_page_size < 1 or v_page_size > 50 then
    raise exception 'invalid page size' using errcode = '22023';
  end if;
  if p_state is not null and p_state not in
       ('DRAFT', 'REVIEW', 'SUBMITTED', 'ACTIVE', 'HISTORY') then
    raise exception 'invalid submission state filter' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{20}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid cursor' using errcode = '22023';
    end if;
    v_cursor_stamp := pg_catalog.split_part(p_cursor, ':', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, ':', 2)::uuid;
  end if;

  with candidates as (
    select s.submission_id,
           s.state,
           s.version,
           s.created_at,
           s.updated_at,
           s.submitted_at,
           not (v_can_list_own and s.created_by_user_id = p_app_user_id) as project_scoped
      from public.direct_entry_submissions s
     where s.state <> 'DELETED' and (
             (v_can_list_own and s.created_by_user_id = p_app_user_id)
             or (
               s.state = 'SUBMITTED'
               and v_has_project_assignment
               and exists (
                 select 1 from public.direct_entries e
                  where e.submission_id = s.submission_id
                    and e.deleted_at is null
                    and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
               )
             )
           )
       and (p_state is null
         or (p_state = 'ACTIVE' and s.state in ('DRAFT', 'REVIEW'))
         or (p_state = 'HISTORY' and s.state = 'SUBMITTED')
         or s.state = p_state)
       and (
         v_cursor_stamp is null
         or (
              pg_catalog.to_char(s.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS'),
              s.submission_id::text
            ) < (v_cursor_stamp, v_cursor_id::text)
       )
  ),
  page as (
    select c.*,
           pg_catalog.to_char(c.created_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
             || ':' || c.submission_id::text as cursor
      from candidates c
     order by c.created_at desc, c.submission_id desc
     limit v_page_size + 1
  ),
  trimmed as (
    select * from page order by created_at desc, submission_id desc limit v_page_size
  )
  select
    (select count(*)::integer from page),
    (
      select coalesce(jsonb_agg(jsonb_build_object(
               'submission_id', t.submission_id,
               'state', t.state,
               'version', t.version,
               'entry_count', (
                 select count(*)::integer from public.direct_entries e
                  where e.submission_id = t.submission_id and e.deleted_at is null
                     and (not t.project_scoped or
                       public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
                ),
               'project_scoped', t.project_scoped,
               'created_at',
                 pg_catalog.to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.created_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z',
               'updated_at',
                 pg_catalog.to_char(t.updated_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.updated_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z',
               'submitted_at', case when t.submitted_at is null then null else
                 pg_catalog.to_char(t.submitted_at at time zone 'UTC', 'YYYY-MM-DD')
                 || 'T' || pg_catalog.to_char(t.submitted_at at time zone 'UTC', 'HH24:MI:SS.US')
                 || 'Z' end,
               'allowed_transitions', case t.state
                 when 'DRAFT' then jsonb_build_array('SUBMITTED')
                 when 'REVIEW' then jsonb_build_array('DRAFT', 'SUBMITTED')
                 else jsonb_build_array()
               end
             ) order by t.created_at desc, t.submission_id desc), '[]'::jsonb)
        from trimmed t
    ),
    (
      select t.cursor from trimmed t
       order by t.created_at asc, t.submission_id asc limit 1
    )
  into v_scanned, v_items, v_next_cursor;

  v_has_more := v_scanned > v_page_size;
  return jsonb_build_object(
    'items', v_items,
    'page_size', v_page_size,
    'has_more', v_has_more,
    'next_cursor', case when v_has_more then v_next_cursor else null end
  );
end;
$function$;

revoke all on function public.direct_entry_list_own_submissions(uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_list_own_submissions(uuid, uuid, integer, text, text)
  to service_role;

create or replace function public.direct_entry_read_own_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_authz_managed boolean := false;
  v_submission public.direct_entry_submissions%rowtype;
  v_own_scope_count integer;
  v_can_read_own boolean := false;
  v_has_project_assignment boolean := false;
  v_project_scoped boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  select coalesce(u.authz_managed, false)
    into v_authz_managed
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if v_authz_managed then
    v_can_read_own :=
      public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'OWN', null)
      or public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'submission_create', 'ALL', null);
  else
    select count(*)::integer into v_own_scope_count
      from public.direct_entry_scope_grants g
     where g.app_user_id = p_app_user_id
       and g.scope_kind = 'own'
       and g.team_id is null
       and g.is_current;
    v_can_read_own := v_own_scope_count = 1
      and public.direct_entry_has_capability(p_app_user_id, 'submission_create');
  end if;

  v_has_project_assignment := public.direct_entry_actor_has_project_assignment(p_app_user_id);
  if not v_can_read_own and not v_has_project_assignment then
    raise exception 'submission scope denied' using errcode = '42501';
  end if;

  if p_submission_id is null then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  select * into v_submission
    from public.direct_entry_submissions s
   where s.submission_id = p_submission_id and s.state <> 'DELETED';
  if not found then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;
  v_project_scoped := not (
    v_can_read_own and v_submission.created_by_user_id = p_app_user_id
  );
  if v_project_scoped and (
       v_submission.state <> 'SUBMITTED'
       or not exists (
         select 1 from public.direct_entries e
          where e.submission_id = v_submission.submission_id
            and e.deleted_at is null
            and public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id)
       )
     ) then
    raise exception 'submission not found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'submission_id', v_submission.submission_id,
    'state', v_submission.state,
    'version', v_submission.version,
    'entry_count', (
      select count(*)::integer from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
         and (not v_project_scoped or
           public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
    ),
    'project_scoped', v_project_scoped,
    'entry_ids', (
      select coalesce(jsonb_agg(e.entry_id order by e.entry_id), '[]'::jsonb)
        from public.direct_entries e
       where e.submission_id = v_submission.submission_id and e.deleted_at is null
         and (not v_project_scoped or
           public.direct_entry_actor_is_assigned_project_manager(p_app_user_id, e.project_id))
    ),
    'created_at',
      pg_catalog.to_char(v_submission.created_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.created_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z',
    'updated_at',
      pg_catalog.to_char(v_submission.updated_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.updated_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z',
    'submitted_at', case when v_submission.submitted_at is null then null else
      pg_catalog.to_char(v_submission.submitted_at at time zone 'UTC', 'YYYY-MM-DD')
      || 'T' || pg_catalog.to_char(v_submission.submitted_at at time zone 'UTC', 'HH24:MI:SS.US')
      || 'Z' end,
    'allowed_transitions', case v_submission.state
      when 'DRAFT' then jsonb_build_array('SUBMITTED')
      when 'REVIEW' then jsonb_build_array('DRAFT', 'SUBMITTED')
      else jsonb_build_array()
    end
  );
end;
$function$;

revoke all on function public.direct_entry_read_own_submission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.direct_entry_read_own_submission(uuid, uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 7. Guarded owner alignment ($align_wp8c1$)
-- -----------------------------------------------------------------------------
do $align_wp8c1$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean;
  v_sig text;
  v_proc_owner_oid oid;
  v_sigs text[] := array[
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
    'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)',
    'public.direct_entry_offboarding_authority(uuid,uuid)',
    'public.direct_entry_project_assignment_effective(uuid,text)',
    'public.direct_entry_assert_project_operation_authority(uuid,uuid)',
    'public.direct_entry_lock_project_team_manager_context(uuid,uuid,uuid,uuid)',
    'public.direct_entry_assert_entry_access(uuid,uuid,text,uuid,uuid,date,text)',
    'public.direct_entry_has_entry_access(uuid,text,uuid,uuid,date)',
    'public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)',
    'public.direct_entry_actor_can_access_project(uuid,text)',
    'public.direct_entry_worker_directory_audience(uuid,uuid,text,text)',
    'public.direct_entry_resolve_actor_context(uuid)',
    'public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)',
    'public.direct_entry_read_own_submission(uuid,uuid,uuid)'
  ];
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner_oid is null then
    raise exception 'WP8C1_ALIGN_BASE_OWNER_MISSING' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_sigs loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = v_sig::pg_catalog.regprocedure;

    if v_proc_owner_oid is null then
      raise exception 'WP8C1_ALIGN_FUNCTION_MISSING: %', v_sig using errcode = '55000';
    end if;

    if v_proc_owner_oid <> v_base_owner_oid and v_can_set_owner then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
  end loop;
end
$align_wp8c1$;

-- -----------------------------------------------------------------------------
-- 8. Fail-closed security, volatility, overload, search_path & ACL self-check ($check_wp8c1$)
-- -----------------------------------------------------------------------------
do $check_wp8c1$
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
  v_service_exec boolean;
  v_overload_cnt integer;
  v_dep_sig text;
  v_dep_oid oid;
  v_stable_internal_fns text[] := array[
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
    'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)',
    'public.direct_entry_offboarding_authority(uuid,uuid)',
    'public.direct_entry_project_assignment_effective(uuid,text)',
    'public.direct_entry_actor_is_assigned_project_manager(uuid,text)',
    'public.direct_entry_assert_project_operation_authority(uuid,uuid)',
    'public.direct_entry_assert_entry_access(uuid,uuid,text,uuid,uuid,date,text)',
    'public.direct_entry_has_entry_access(uuid,text,uuid,uuid,date)',
    'public.direct_entry_resolve_direct_edit_authority(uuid,uuid,uuid,uuid,text,boolean,uuid)',
    'public.direct_entry_actor_can_access_project(uuid,text)',
    'public.direct_entry_worker_directory_audience(uuid,uuid,text,text)'
  ];
  v_volatile_internal_fns text[] := array[
    'public.direct_entry_lock_project_team_manager_context(uuid,uuid,uuid,uuid)'
  ];
  v_service_rpcs text[] := array[
    'public.direct_entry_resolve_actor_context(uuid)',
    'public.direct_entry_list_own_submissions(uuid,uuid,integer,text,text)',
    'public.direct_entry_read_own_submission(uuid,uuid,uuid)'
  ];
  v_fn_names text[] := array[
    'direct_entry_authz__internal_resolve_effective_grants',
    'direct_entry_assert_team_leader_current_team',
    'direct_entry_offboarding_authority',
    'direct_entry_project_assignment_effective',
    'direct_entry_actor_is_assigned_project_manager',
    'direct_entry_assert_project_operation_authority',
    'direct_entry_lock_project_team_manager_context',
    'direct_entry_assert_entry_access',
    'direct_entry_has_entry_access',
    'direct_entry_resolve_direct_edit_authority',
    'direct_entry_actor_can_access_project',
    'direct_entry_worker_directory_audience',
    'direct_entry_resolve_actor_context',
    'direct_entry_list_own_submissions',
    'direct_entry_read_own_submission'
  ];
  v_internal_deps text[] := array[
    'public.direct_entry_assert_actor_mapping(uuid,uuid)',
    'public.direct_entry_assert_actor(uuid,uuid,text)',
    'public.direct_entry_assert_actor_app_user_admin(uuid,uuid)',
    'public.direct_entry_assert_catalog_operator(uuid,uuid)',
    'public.direct_entry_assert_project_admin(uuid,uuid)',
    'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)',
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
    'public.direct_entry__internal_team_leader_assignment_effective(uuid,date)',
    'public.direct_entry__internal_team_scope_grant_effective(uuid,date)',
    'public.direct_entry__internal_recruiter_provider_membership_effective(uuid,date)',
    'public.direct_entry__internal_recruiter_team_membership_effective(uuid,date)',
    'public.direct_entry_actor_has_project_assignment(uuid)',
    'public.direct_entry_actor_is_assigned_project_manager(uuid,text)',
    'public.direct_entry_project_assignment_effective(uuid,text)',
    'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)',
    'public.direct_entry_assert_entry_access(uuid,uuid,text,uuid,uuid,date,text)'
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
      raise exception 'WP8C1_CHECK_OVERLOAD_COUNT_FAILED: % (count=%)', v_name, v_overload_cnt
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array (v_stable_internal_fns || v_volatile_internal_fns) loop
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
       or not coalesce(v_owner_priv, false)
       or not coalesce(v_owner_exec, false)
       or (v_sig = any(v_stable_internal_fns) and v_volatile <> 's')
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP8C1_CHECK_INTERNAL_DEF_FAILED: %', v_sig using errcode = '55000';
    end if;

    foreach v_dep_sig in array v_internal_deps loop
      v_dep_oid := v_dep_sig::pg_catalog.regprocedure;
      if not pg_catalog.has_function_privilege(v_owner_oid, v_dep_oid, 'EXECUTE') then
        raise exception 'WP8C1_CHECK_OWNER_CALLEE_EXEC_FAILED: % -> %', v_sig, v_dep_sig
          using errcode = '55000';
      end if;
    end loop;

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
      raise exception 'WP8C1_CHECK_INTERNAL_ACL_EXPOSED: % (% grants)', v_sig, v_exposed
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_service_rpcs loop
    v_oid := v_sig::pg_catalog.regprocedure;

    select p.proowner,
           p.prosecdef,
           p.provolatile,
           p.proconfig,
           (r.rolsuper or r.rolbypassrls),
           pg_catalog.has_function_privilege(p.proowner, p.oid, 'EXECUTE'),
           pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
      into v_owner_oid, v_secdef, v_volatile, v_proconfig, v_owner_priv, v_owner_exec, v_service_exec
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_secdef, false)
       or not coalesce(v_owner_priv, false)
       or not coalesce(v_owner_exec, false)
       or not coalesce(v_service_exec, false)
       or (v_sig = 'public.direct_entry_resolve_actor_context(uuid)' and v_volatile <> 's')
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP8C1_CHECK_SERVICE_RPC_DEF_FAILED: %', v_sig using errcode = '55000';
    end if;

    foreach v_dep_sig in array v_internal_deps loop
      v_dep_oid := v_dep_sig::pg_catalog.regprocedure;
      if not pg_catalog.has_function_privilege(v_owner_oid, v_dep_oid, 'EXECUTE') then
        raise exception 'WP8C1_CHECK_RPC_OWNER_CALLEE_EXEC_FAILED: % -> %', v_sig, v_dep_sig
          using errcode = '55000';
      end if;
    end loop;

    select count(*)::integer
      into v_exposed
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) a
      left join pg_catalog.pg_roles gr on gr.oid = a.grantee
     where p.oid = v_oid
       and (a.grantee = 0 or gr.rolname in ('anon', 'authenticated'));

    if v_exposed <> 0 then
      raise exception 'WP8C1_CHECK_SERVICE_RPC_ACL_EXPOSED: % (% grants)', v_sig, v_exposed
        using errcode = '55000';
    end if;
  end loop;
end
$check_wp8c1$;

commit;
