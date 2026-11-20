-- =============================================================================
-- WP8D-2: Migrate Entire Work Reports Subsystem Authorization to WP5 Paired Access
--
-- Scope & Invariants:
--   1. Preserves 100% of migration #229 (WP8C-1) TL/PM/Entry Access/allowed_worker_tabs
--      and exact 12/13-key direct_entry_resolve_actor_context contract.
--   2. Replaces legacy direct_entry_capability_grants / direct_entry_scope_grants reads
--      across all Work Reports internal authz helpers and public RPCs with paired WP5
--      evaluation when authz_managed = true (preserving pre-cutover R1 parity when
--      authz_managed = false).
--   3. Canonicalizes active Team Leader report_review on CONTEXT_TEAM for authz_managed
--      accounts directly from direct_entry_team_leader_assignments (eliminating legacy
--      mirror dependency from tl_wr_compat_bridge while keeping TEAM_LEADER 5-cap and
--      ADMIN 21-cap catalog invariants untouched).
--   4. Preserves the approved Canonical Full Admin Work Reports override (paired triple
--      entry_admin + recruiter_master_manage + team_master_manage at ALL) without adding
--      report_form_manage/report_assign/report_review/report_delegate into ADMIN bundle
--      or treating report_view/report_analytics_view as assign/review/delegate authority.
--   5. Keeps R3 invariant (zero blanket delegation grants in effective_grants), immediate
--      open-ended delegation semantics, no-self-review, no delegation chaining, READ ONLY
--      STABLE navbar probe chain (#18), idempotency before OCC, +0 new service_role RPCs,
--      and strict ascending lock order (direct_entry_app_users ASC -> WR entities).
--   6. Aligns public.work_report_list_pending_reviews and
--      public.work_report_get_review_submission JSON output with the runtime TypeScript
--      review-repository DTO (F-WD-DRIFT-01) using real obligation/submission/revision
--      columns while preserving legacy aliases for SQL-before-Web compatibility and
--      strictly excluding payload_json/draft_payload_json from pending-list items.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Shared WP5 Effective Grants Resolver (preserves 100% of #229 WP8C-1)
--    - Adds canonical contextual_tl_wr_review_grants for authz_managed NORMAL TLs
--      so managed TLs retain report_review on CONTEXT_TEAM with zero legacy mirror.
--    - Restricts tl_wr_compat_bridge to pre-cutover (not authz_managed).
--    - Adds 'report_delegate' to pre-cutover legacy CONTEXT_TEAM bridge allowlist.
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
  contextual_tl_wr_review_grants as (
    -- WP8D-2 canonical contextual Work Reports review authority for managed active Team Leaders (OD-04 = PA1).
    -- Derived strictly from direct_entry_team_leader_assignments with zero dependency on legacy mirrors.
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
      and v_user.account_type = 'NORMAL'
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
    -- Pre-cutover only compatibility bridge (not authz_managed): active Team Leader holding open report_review grant.
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
        'report_view', 'report_analytics_view', 'report_assign', 'report_review', 'report_delegate'
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
$function$;

revoke all on function public.direct_entry_authz__internal_resolve_effective_grants(uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Work Reports Core Paired Authority Internal Helpers (ALL STABLE, ZERO LOCKS)
-- -----------------------------------------------------------------------------
create or replace function public.work_report__internal_is_full_admin(
  p_app_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
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
    if v_user.account_type is distinct from 'NORMAL' then
      return false;
    end if;
    return public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
       and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
       and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);
  end if;

  return public.direct_entry_has_capability(p_app_user_id, 'entry_admin')
     and public.direct_entry_has_capability(p_app_user_id, 'recruiter_master_manage')
     and public.direct_entry_has_capability(p_app_user_id, 'team_master_manage')
     and public.direct_entry_has_scope(p_app_user_id, 'all');
end;
$function$;

revoke all on function public.work_report__internal_is_full_admin(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_has_direct_capability(
  p_app_user_id uuid,
  p_capability text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
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
    if v_user.account_type is distinct from 'NORMAL' then
      return false;
    end if;

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
$function$;

revoke all on function public.work_report__internal_has_direct_capability(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_has_direct_scope(
  p_app_user_id uuid,
  p_capability text,
  p_scope_kind text,
  p_team_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
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
    if v_user.account_type is distinct from 'NORMAL' then
      return false;
    end if;

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
$function$;

revoke all on function public.work_report__internal_has_direct_scope(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_direct_team_ids(
  p_app_user_id uuid,
  p_capability text
)
returns uuid[]
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
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
    if v_user.account_type is distinct from 'NORMAL' then
      return array[]::uuid[];
    end if;

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
$function$;

revoke all on function public.work_report__internal_direct_team_ids(uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.work_report_assert_actor(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text default null
)
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
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
     and not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
end;
$function$;

revoke all on function public.work_report_assert_actor(uuid, uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.work_report_assert_scope(
  p_app_user_id uuid,
  p_capability text,
  p_team_id uuid default null,
  p_require_all boolean default false
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if not public.work_report__internal_has_direct_capability(p_app_user_id, p_capability) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if public.work_report__internal_has_direct_scope(p_app_user_id, p_capability, 'all', null) then
    return 'all';
  end if;
  if p_require_all then
    raise exception 'WORK_REPORT_ALL_SCOPE_REQUIRED' using errcode = '42501';
  end if;
  if p_team_id is not null
     and public.work_report__internal_has_direct_scope(p_app_user_id, p_capability, 'team', p_team_id) then
    return 'team';
  end if;
  raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
end;
$function$;

revoke all on function public.work_report_assert_scope(uuid, text, uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_is_delegation_effective(
  p_delegation_id uuid,
  p_as_of timestamptz default statement_timestamp()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
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
  if coalesce(v_delegate.authz_managed, false) and v_delegate.account_type is distinct from 'NORMAL' then
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
$function$;

revoke all on function public.work_report__internal_is_delegation_effective(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_resolve_capability_authority(
  p_app_user_id uuid,
  p_capability text,
  p_template_id uuid,
  p_team_id uuid,
  p_as_of timestamptz default statement_timestamp()
)
returns table(
  acting_scope_kind text,
  acting_team_id uuid,
  delegation_id uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_delegation_id uuid;
  v_del_scope_kind text;
  v_del_team_id uuid;
begin
  if public.work_report__internal_has_direct_scope(p_app_user_id, p_capability, 'all', null) then
    return query select 'all'::text, null::uuid, null::uuid;
    return;
  end if;
  if p_team_id is not null
     and public.work_report__internal_has_direct_scope(p_app_user_id, p_capability, 'team', p_team_id) then
    return query select 'team'::text, p_team_id, null::uuid;
    return;
  end if;

  if p_capability in ('report_assign', 'report_review') and p_template_id is not null then
    select d.delegation_id,
           d.scope_kind,
           case when d.scope_kind = 'team' then d.scope_team_id else null end
      into v_delegation_id, v_del_scope_kind, v_del_team_id
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = p_capability
       and d.template_id = p_template_id
       and d.state = 'ACTIVE'
       and d.is_current
       and p_as_of >= d.effective_from
       and (d.effective_to is null or p_as_of <= d.effective_to)
       and (
         d.scope_kind = 'all'
         or (d.scope_kind = 'team' and p_team_id is not null and d.scope_team_id = p_team_id)
       )
       and public.work_report__internal_is_delegation_effective(d.delegation_id, p_as_of)
     order by case when d.scope_kind = 'all' then 0 else 1 end, d.created_at desc, d.delegation_id desc
     limit 1;

    if v_delegation_id is not null then
      return query select v_del_scope_kind, v_del_team_id, v_delegation_id;
      return;
    end if;
  end if;
end;
$function$;

revoke all on function public.work_report__internal_resolve_capability_authority(uuid, text, uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_has_any_capability_authority(
  p_app_user_id uuid,
  p_capability text,
  p_as_of timestamptz default statement_timestamp()
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
begin
  if public.work_report__internal_has_direct_scope(p_app_user_id, p_capability, 'all', null) then
    return true;
  end if;
  if coalesce(pg_catalog.cardinality(public.work_report__internal_direct_team_ids(p_app_user_id, p_capability)), 0) > 0 then
    return true;
  end if;

  if p_capability in ('report_assign', 'report_review') and exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = p_capability
       and d.state = 'ACTIVE'
       and d.is_current
       and p_as_of >= d.effective_from
       and (d.effective_to is null or p_as_of <= d.effective_to)
       and public.work_report__internal_is_delegation_effective(d.delegation_id, p_as_of)
  ) then
    return true;
  end if;

  return false;
end;
$function$;

revoke all on function public.work_report__internal_has_any_capability_authority(uuid, text, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_actor_can_assign_member(
  p_app_user_id uuid,
  p_member_user_id uuid,
  p_template_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_member_team_id uuid;
begin
  if p_app_user_id is null or p_member_user_id is null then
    return false;
  end if;

  if not exists (
    select 1
      from public.direct_entry_app_users u
     where u.app_user_id = p_member_user_id
  ) then
    return false;
  end if;

  v_member_team_id := public.work_report_current_team(p_member_user_id);

  if p_template_id is not null then
    return exists (
      select 1
        from public.work_report__internal_resolve_capability_authority(
          p_app_user_id,
          'report_assign',
          p_template_id,
          v_member_team_id
        )
    );
  end if;

  if public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null) then
    return true;
  end if;

  if exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = 'report_assign'
       and d.scope_kind = 'all'
       and public.work_report__internal_is_delegation_effective(d.delegation_id)
  ) then
    return true;
  end if;

  if v_member_team_id is null then
    return false;
  end if;

  if public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'team', v_member_team_id) then
    return true;
  end if;

  if exists (
    select 1
      from public.work_report_delegations d
      join public.teams t
        on t.team_id = d.scope_team_id
       and t.active
       and t.code <> '__system_vendor__'
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = 'report_assign'
       and d.scope_kind = 'team'
       and d.scope_team_id = v_member_team_id
       and public.work_report__internal_is_delegation_effective(d.delegation_id)
  ) then
    return true;
  end if;

  return false;
end;
$function$;

revoke all on function public.work_report__internal_actor_can_assign_member(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.work_report__internal_resolve_analytics_scope(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_require_report_view boolean default false,
  p_filter_team_id uuid default null,
  p_filter_assignee_id uuid default null,
  p_template_id uuid default null
)
returns table(
  scope_kind text,
  scope_label text,
  authorized_team_ids uuid[]
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_analytics_all boolean;
  v_view_all boolean;
  v_all_scope boolean;
  v_analytics_teams uuid[];
  v_view_teams uuid[];
  v_team_ids uuid[];
  v_label text;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_analytics_view');
  if p_require_report_view then
    perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_view');
  end if;

  v_analytics_all := public.work_report__internal_has_direct_scope(p_app_user_id, 'report_analytics_view', 'all', null);
  v_view_all := case
    when p_require_report_view then public.work_report__internal_has_direct_scope(p_app_user_id, 'report_view', 'all', null)
    else true
  end;
  v_all_scope := v_analytics_all and v_view_all;

  if v_all_scope then
    if p_filter_team_id is not null then
      select coalesce(t.display_name, t.code)
        into v_label
        from public.teams t
       where t.team_id = p_filter_team_id;
      if not found then
        raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
      end if;
      v_team_ids := array[p_filter_team_id];
    else
      v_label := 'Toàn công ty';
      v_team_ids := null;
    end if;

    if p_filter_assignee_id is not null and not exists (
      select 1 from public.direct_entry_app_users u where u.app_user_id = p_filter_assignee_id
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;

    return query select 'all'::text, v_label, v_team_ids;
    return;
  end if;

  if not v_analytics_all then
    v_analytics_teams := public.work_report__internal_direct_team_ids(p_app_user_id, 'report_analytics_view');
  end if;
  if p_require_report_view and not v_view_all then
    v_view_teams := public.work_report__internal_direct_team_ids(p_app_user_id, 'report_view');
  end if;

  select pg_catalog.array_agg(t.team_id order by t.code),
         pg_catalog.string_agg(coalesce(t.display_name, t.code), ', ' order by t.code)
    into v_team_ids, v_label
    from public.teams t
   where t.active
     and t.code <> '__system_vendor__'
     and (v_analytics_all or t.team_id = any(coalesce(v_analytics_teams, array[]::uuid[])))
     and (not p_require_report_view or v_view_all or t.team_id = any(coalesce(v_view_teams, array[]::uuid[])));

  if coalesce(pg_catalog.cardinality(v_team_ids), 0) = 0 then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if p_filter_team_id is not null then
    if not (p_filter_team_id = any(v_team_ids)) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    v_team_ids := array[p_filter_team_id];
    select coalesce(t.display_name, t.code)
      into v_label
      from public.teams t
     where t.team_id = p_filter_team_id;
  end if;

  if p_filter_assignee_id is not null then
    if not (
      coalesce(public.work_report_current_team(p_filter_assignee_id) = any(v_team_ids), false)
      or exists (
        select 1
          from public.work_report_obligations o
         where o.assignee_app_user_id = p_filter_assignee_id
           and o.snapshot_team_id = any(v_team_ids)
           and (p_template_id is null or o.template_id = p_template_id)
      )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  return query select 'team'::text, v_label, v_team_ids;
end;
$function$;

revoke all on function public.work_report__internal_resolve_analytics_scope(uuid, uuid, boolean, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 3. Shared Actor Context Resolver (preserves 100% of #229 WP8C-1)
--    - Upgrades effective_report_review_scopes for authz_managed accounts to
--      derive direct ALL/CONTEXT_TEAM review scopes strictly from paired
--      v_effective_grants (closing cross-scope HR_OPERATOR + TL escalation)
--      plus active work_report_delegations (preserving R3 & exact 12/13 keys).
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
  v_account_type text := 'NORMAL';
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
  select u.app_user_id, u.enabled, coalesce(u.authz_managed, false), coalesce(u.account_type, 'NORMAL')
    into v_app_user_id, v_enabled, v_authz_managed, v_account_type
    from public.direct_entry_app_users u
   where u.auth_subject = p_auth_subject;
  if not found then return null; end if;

  if v_enabled then
    v_effective_grants := public.direct_entry_authz__internal_resolve_effective_grants(v_app_user_id);

    if v_authz_managed then
      if v_account_type = 'NORMAL' then
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
      end if;
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

-- -----------------------------------------------------------------------------
-- 4. Work Reports Public Read RPCs — Paired WP5 Enforcement
-- -----------------------------------------------------------------------------
create or replace function public.work_report_get_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
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
      perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_view');
    exception when insufficient_privilege then
      raise exception 'WORK_REPORT_ACCESS_DENIED' using errcode = '42501';
    end;
    if not public.work_report__internal_has_direct_scope(p_app_user_id, 'report_view', 'all', null) then
      perform public.work_report_assert_scope(p_app_user_id, 'report_view', v_obligation.snapshot_team_id, false);
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
$function$;

revoke all on function public.work_report_get_submission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_get_submission(uuid, uuid, uuid)
  to service_role;

create or replace function public.work_report_list_readable_submissions(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid default null,
  p_version_id uuid default null,
  p_from date default null,
  p_to date default null,
  p_team_id uuid default null,
  p_assignee_id uuid default null,
  p_state text default null,
  p_cursor text default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_all_scope boolean;
  v_scope_kind text;
  v_scope_label text;
  v_authorized_team_ids uuid[];
  v_filter_team_ids uuid[];
  v_cursor_parts text[];
  v_cursor_submitted_at timestamptz;
  v_cursor_submission_id uuid;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_view');

  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'WORK_REPORT_DATE_RANGE_INVALID' using errcode = '22023';
  end if;

  if p_state is not null and p_state not in ('COMPLETED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED') then
    raise exception 'WORK_REPORT_STATE_INVALID' using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'WORK_REPORT_LIMIT_INVALID' using errcode = '22023';
  end if;

  if p_cursor is not null then
    v_cursor_parts := string_to_array(p_cursor, '|');
    if coalesce(cardinality(v_cursor_parts), 0) <> 2
       or v_cursor_parts[1] !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$'
       or v_cursor_parts[2] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end if;
    begin
      v_cursor_submitted_at := v_cursor_parts[1]::timestamptz;
      v_cursor_submission_id := v_cursor_parts[2]::uuid;
    exception when others then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end;
  end if;

  v_all_scope := public.work_report__internal_has_direct_scope(p_app_user_id, 'report_view', 'all', null);

  if v_all_scope then
    v_scope_kind := 'all';
    v_authorized_team_ids := null;

    if p_team_id is not null then
      select coalesce(t.display_name, t.code)
        into v_scope_label
        from public.teams t
       where t.team_id = p_team_id;
      if not found then
        raise exception 'WORK_REPORT_TEAM_NOT_FOUND' using errcode = 'P0002';
      end if;
      v_filter_team_ids := array[p_team_id];
    else
      v_scope_label := 'Toàn công ty';
      v_filter_team_ids := null;
    end if;

    if p_assignee_id is not null and not exists (
      select 1 from public.direct_entry_app_users u where u.app_user_id = p_assignee_id
    ) then
      raise exception 'WORK_REPORT_ASSIGNEE_NOT_FOUND' using errcode = 'P0002';
    end if;
  else
    select pg_catalog.array_agg(t.team_id order by t.code),
           pg_catalog.string_agg(coalesce(t.display_name, t.code), ', ' order by t.code)
      into v_authorized_team_ids, v_scope_label
      from public.teams t
     where t.active
       and t.code <> '__system_vendor__'
       and t.team_id = any(public.work_report__internal_direct_team_ids(p_app_user_id, 'report_view'));

    if coalesce(pg_catalog.cardinality(v_authorized_team_ids), 0) = 0 then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;

    v_scope_kind := 'team';

    if p_team_id is not null then
      perform public.work_report_assert_scope(p_app_user_id, 'report_view', p_team_id, false);
      if not (p_team_id = any(v_authorized_team_ids)) then
        raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
      end if;
      v_filter_team_ids := array[p_team_id];
      select coalesce(t.display_name, t.code)
        into v_scope_label
        from public.teams t
       where t.team_id = p_team_id;
    else
      v_filter_team_ids := v_authorized_team_ids;
    end if;

    if p_assignee_id is not null then
      if not (
        coalesce(public.work_report_current_team(p_assignee_id) = any(v_filter_team_ids), false)
        or exists (
          select 1
            from public.work_report_obligations o
           where o.assignee_app_user_id = p_assignee_id
             and o.snapshot_team_id = any(v_filter_team_ids)
             and (p_template_id is null or o.template_id = p_template_id)
        )
      ) then
        raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
      end if;
    end if;
  end if;

  if p_template_id is not null and not exists (
    select 1 from public.work_report_templates t where t.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_version_id is not null and not exists (
    select 1
      from public.work_report_template_versions tv
     where tv.version_id = p_version_id
       and (p_template_id is null or tv.template_id = p_template_id)
  ) then
    raise exception 'WORK_REPORT_VERSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  with authorized_obligations as (
    select o.obligation_id,
           o.template_id,
           o.template_version_id,
           o.assignee_app_user_id,
           o.snapshot_team_id,
           o.snapshot_team_code,
           o.snapshot_team_display_name
      from public.work_report_obligations o
     where (v_all_scope or o.snapshot_team_id = any(v_authorized_team_ids))
       and (
         o.obligation_status in ('ACTIVE', 'EXEMPTED')
         or exists (
           select 1
             from public.work_report_submissions s2
            where s2.obligation_id = o.obligation_id
              and s2.current_revision_id is not null
         )
       )
  ),
  scoped_template_versions as (
    select distinct
           ao.template_id,
           tv.version_id,
           tv.version_no,
           tv.status
      from authorized_obligations ao
      join public.work_report_template_versions tv on tv.version_id = ao.template_version_id
  ),
  template_options as (
    select t.template_id,
           t.template_code,
           t.display_name,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'version_id', stv.version_id,
               'version_no', stv.version_no,
               'status', stv.status
             ) order by stv.version_no desc, stv.version_id desc)
               from scoped_template_versions stv
              where stv.template_id = t.template_id
           ), '[]'::jsonb) as versions
      from (select distinct template_id from authorized_obligations) dt
      join public.work_report_templates t on t.template_id = dt.template_id
  ),
  team_options as (
    select ao.snapshot_team_id as team_id,
           coalesce(tm.code, max(ao.snapshot_team_code), ao.snapshot_team_id::text) as code,
           coalesce(
             tm.display_name,
             max(ao.snapshot_team_display_name),
             tm.code,
             max(ao.snapshot_team_code),
             ao.snapshot_team_id::text
           ) as display_name
      from authorized_obligations ao
      left join public.teams tm on tm.team_id = ao.snapshot_team_id
     where ao.snapshot_team_id is not null
     group by ao.snapshot_team_id, tm.code, tm.display_name
  ),
  assignee_options as (
    select distinct
           u.app_user_id,
           coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name
      from authorized_obligations ao
      join public.direct_entry_app_users u on u.app_user_id = ao.assignee_app_user_id
  ),
  fetched as (
    select o.obligation_id,
           s.submission_id,
           o.template_id,
           t.display_name as template_name,
           s.template_version_id,
           tv.version_no as template_version_no,
           o.assignee_app_user_id,
           coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as assignee_display_name,
           o.snapshot_team_id as team_id,
           case
             when o.snapshot_team_id is null then null
             else coalesce(o.snapshot_team_display_name, tm.display_name, o.snapshot_team_code, tm.code)
           end as team_display_name,
           o.period_key,
           o.period_start_date,
           o.period_end_date,
           s.state,
           s.latest_submitted_at,
           s.is_late,
           s.has_post_deadline_amendment,
           rev.revision_no as current_revision_no
      from public.work_report_submissions s
      join public.work_report_obligations o on o.obligation_id = s.obligation_id
      join public.work_report_submission_revisions rev
        on rev.revision_id = s.current_revision_id
       and rev.submission_id = s.submission_id
      join public.work_report_templates t on t.template_id = o.template_id
      join public.work_report_template_versions tv on tv.version_id = s.template_version_id
      join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
      left join public.teams tm on tm.team_id = o.snapshot_team_id
     where s.current_revision_id is not null
       and s.first_submitted_at is not null
       and s.latest_submitted_at is not null
       and s.state in ('COMPLETED', 'PENDING_REVIEW', 'APPROVED', 'REJECTED')
       and (v_filter_team_ids is null or o.snapshot_team_id = any(v_filter_team_ids))
       and (p_template_id is null or o.template_id = p_template_id)
       and (p_version_id is null or s.template_version_id = p_version_id)
       and (p_from is null or o.period_start_date >= p_from)
       and (p_to is null or o.period_start_date <= p_to)
       and (p_assignee_id is null or o.assignee_app_user_id = p_assignee_id)
       and (p_state is null or s.state = p_state)
       and (
         p_cursor is null
         or s.latest_submitted_at < v_cursor_submitted_at
         or (s.latest_submitted_at = v_cursor_submitted_at and s.submission_id < v_cursor_submission_id)
       )
     order by s.latest_submitted_at desc, s.submission_id desc
     limit p_limit + 1
  ),
  page_meta as (
    select (count(*) > p_limit) as has_more
      from fetched
  ),
  page_rows as (
    select *
      from fetched
     order by latest_submitted_at desc, submission_id desc
     limit p_limit
  )
  select jsonb_build_object(
    'effective_scope', jsonb_build_object(
      'kind', v_scope_kind,
      'label', v_scope_label
    ),
    'filter_options', jsonb_build_object(
      'templates', coalesce((
        select jsonb_agg(jsonb_build_object(
          'template_id', topt.template_id,
          'template_code', topt.template_code,
          'display_name', topt.display_name,
          'versions', topt.versions
        ) order by topt.display_name, topt.template_code, topt.template_id)
          from template_options topt
      ), '[]'::jsonb),
      'teams', coalesce((
        select jsonb_agg(jsonb_build_object(
          'team_id', tmopt.team_id,
          'code', tmopt.code,
          'display_name', tmopt.display_name
        ) order by tmopt.code, tmopt.team_id)
          from team_options tmopt
      ), '[]'::jsonb),
      'assignees', coalesce((
        select jsonb_agg(jsonb_build_object(
          'app_user_id', aopt.app_user_id,
          'display_name', aopt.display_name
        ) order by aopt.display_name, aopt.app_user_id)
          from assignee_options aopt
      ), '[]'::jsonb)
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'obligation_id', pr.obligation_id,
        'submission_id', pr.submission_id,
        'template_id', pr.template_id,
        'template_name', pr.template_name,
        'template_version_id', pr.template_version_id,
        'template_version_no', pr.template_version_no,
        'assignee_app_user_id', pr.assignee_app_user_id,
        'assignee_display_name', pr.assignee_display_name,
        'team_id', pr.team_id,
        'team_display_name', pr.team_display_name,
        'period_key', pr.period_key,
        'period_start_date', pr.period_start_date::text,
        'period_end_date', pr.period_end_date::text,
        'state', pr.state,
        'latest_submitted_at', pr.latest_submitted_at,
        'is_late', pr.is_late,
        'has_post_deadline_amendment', pr.has_post_deadline_amendment,
        'current_revision_no', pr.current_revision_no
      ) order by pr.latest_submitted_at desc, pr.submission_id desc)
        from page_rows pr
    ), '[]'::jsonb),
    'next_cursor', case
      when pm.has_more then (
        select to_char(pr.latest_submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               || '|' || pr.submission_id::text
          from page_rows pr
         order by pr.latest_submitted_at asc, pr.submission_id asc
         limit 1
      )
      else null
    end,
    'has_more', pm.has_more
  )
    into v_result
    from page_meta pm;

  return v_result;
end;
$function$;

revoke all on function public.work_report_list_readable_submissions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_readable_submissions(uuid, uuid, uuid, uuid, date, date, uuid, uuid, text, text, integer)
  to service_role;

create or replace function public.work_report_list_groups(
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
  v_all_scope boolean;
  v_has_team_scope boolean;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_all_scope := public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
    or exists (
      select 1
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.scope_kind = 'all'
         and public.work_report__internal_is_delegation_effective(d.delegation_id)
    );

  if not v_all_scope then
    v_has_team_scope := (
      coalesce(pg_catalog.cardinality(public.work_report__internal_direct_team_ids(p_app_user_id, 'report_assign')), 0) > 0
    ) or exists (
      select 1
        from public.work_report_delegations d
        join public.teams t on t.team_id = d.scope_team_id and t.active and t.code <> '__system_vendor__'
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.scope_kind = 'team'
         and public.work_report__internal_is_delegation_effective(d.delegation_id)
    );
    if not v_has_team_scope then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'scope_kind', case when v_all_scope then 'all' else 'team' end,
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'group_id', g.group_id,
        'display_name', g.display_name,
        'description', g.description,
        'active', g.active,
        'version', g.version,
        'created_at', g.created_at,
        'updated_at', g.updated_at,
        'assignment_count', (
          select count(*)::integer
            from public.work_report_assignments a
           where a.target_group_id = g.group_id
        ),
        'members', coalesce((
          select jsonb_agg(jsonb_build_object(
            'app_user_id', grp_member.app_user_id,
            'display_name', grp_member.display_name,
            'enabled', grp_member.enabled,
            'team_id', grp_member.team_id,
            'team_code', grp_member.team_code,
            'team_display_name', grp_member.team_display_name
          ) order by grp_member.display_name, grp_member.app_user_id)
            from (
              select u.app_user_id,
                     coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name,
                     u.enabled,
                     tm.team_id,
                     tm.code as team_code,
                     tm.display_name as team_display_name
                from public.work_report_group_members gm
                join public.direct_entry_app_users u on u.app_user_id = gm.member_user_id
                left join public.teams tm on tm.team_id = public.work_report_current_team(u.app_user_id)
               where gm.group_id = g.group_id
            ) grp_member
        ), '[]'::jsonb)
      ) order by g.active desc, g.display_name asc, g.group_id asc)
        from public.work_report_groups g
       where exists (
         select 1
           from public.work_report_group_members gm0
          where gm0.group_id = g.group_id
       )
         and not exists (
           select 1
             from public.work_report_group_members gm_out
            where gm_out.group_id = g.group_id
              and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm_out.member_user_id, null)
         )
    ), '[]'::jsonb),
    'eligible_users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'app_user_id', eligible.app_user_id,
        'display_name', eligible.display_name,
        'team_id', eligible.team_id,
        'team_code', eligible.team_code,
        'team_display_name', eligible.team_display_name
      ) order by eligible.display_name, eligible.app_user_id)
        from (
          select u.app_user_id,
                 coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name,
                 tm.team_id,
                 tm.code as team_code,
                 tm.display_name as team_display_name
            from public.direct_entry_app_users u
            left join public.teams tm on tm.team_id = public.work_report_current_team(u.app_user_id)
           where public.work_report__internal_is_eligible_assignee(u.app_user_id)
             and public.work_report__internal_actor_can_assign_member(p_app_user_id, u.app_user_id, null)
        ) eligible
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.work_report_list_groups(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_groups(uuid, uuid)
  to service_role;

create or replace function public.work_report_list_assignment_options(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_direct_all boolean;
  v_direct_team_ids uuid[];
  v_direct_has_team boolean;
  v_delegated_all boolean;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_direct_all := public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null);
  v_direct_team_ids := public.work_report__internal_direct_team_ids(p_app_user_id, 'report_assign');
  v_direct_has_team := coalesce(pg_catalog.cardinality(v_direct_team_ids), 0) > 0;
  v_delegated_all := exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = 'report_assign'
       and d.scope_kind = 'all'
       and public.work_report__internal_is_delegation_effective(d.delegation_id)
  );

  if p_team_id is not null then
    if not exists (
      select 1 from public.teams t
       where t.team_id = p_team_id
         and t.active
         and t.code <> '__system_vendor__'
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if not (
      v_direct_all
      or v_delegated_all
      or p_team_id = any(v_direct_team_ids)
      or exists (
        select 1 from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'team'
           and d.scope_team_id = p_team_id
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object(
    'templates', coalesce((
      select jsonb_agg(jsonb_build_object(
        'template_id', t.template_id,
        'template_code', t.template_code,
        'display_name', t.display_name,
        'default_frequency', t.default_frequency,
        'current_published_version_id', t.current_published_version_id
      ) order by t.template_code)
        from public.work_report_templates t
       where t.status = 'ACTIVE'
         and t.current_published_version_id is not null
         and (
           v_direct_all
           or v_direct_has_team
           or exists (
             select 1 from public.work_report_delegations d
              where d.delegate_app_user_id = p_app_user_id
                and d.capability = 'report_assign'
                and d.template_id = t.template_id
                and public.work_report__internal_is_delegation_effective(d.delegation_id)
           )
         )
    ), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
        'team_id', t.team_id, 'code', t.code, 'display_name', t.display_name
      ) order by t.code)
        from public.teams t
       where t.active
         and t.code <> '__system_vendor__'
         and (
           v_direct_all
           or v_delegated_all
           or t.team_id = any(v_direct_team_ids)
           or exists (
             select 1 from public.work_report_delegations d
              where d.delegate_app_user_id = p_app_user_id
                and d.capability = 'report_assign'
                and d.scope_kind = 'team'
                and d.scope_team_id = t.team_id
                and public.work_report__internal_is_delegation_effective(d.delegation_id)
           )
         )
    ), '[]'::jsonb),
    'users', case when p_team_id is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'app_user_id', eligible.app_user_id, 'display_name', eligible.display_name
      ) order by eligible.display_name, eligible.app_user_id)
        from (
          select distinct
                 u.app_user_id,
                 coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as display_name
            from public.direct_entry_app_user_recruiter_links l
            join public.direct_entry_app_users u on u.app_user_id = l.app_user_id and u.enabled
            join public.recruiters r on r.recruiter_id = l.recruiter_id and r.active
            join public.recruiter_team_memberships m on m.recruiter_id = r.recruiter_id
              and m.team_id = p_team_id and m.is_current
           where l.verified and l.is_current
             and exists (
               select 1 from public.teams t
                where t.team_id = p_team_id
                  and t.active
                  and t.code <> '__system_vendor__'
             )
        ) eligible
    ), '[]'::jsonb) end
  );
end;
$function$;

revoke all on function public.work_report_list_assignment_options(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_assignment_options(uuid, uuid, uuid)
  to service_role;

create or replace function public.work_report_list_assignments(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_team_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_direct_all boolean;
  v_direct_team_ids uuid[];
  v_delegated_all boolean;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_direct_all := public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null);
  v_direct_team_ids := public.work_report__internal_direct_team_ids(p_app_user_id, 'report_assign');
  v_delegated_all := exists (
    select 1
      from public.work_report_delegations d
     where d.delegate_app_user_id = p_app_user_id
       and d.capability = 'report_assign'
       and d.scope_kind = 'all'
       and public.work_report__internal_is_delegation_effective(d.delegation_id)
  );

  if p_team_id is not null then
    if not exists (
      select 1 from public.teams t
       where t.team_id = p_team_id
         and t.active
         and t.code <> '__system_vendor__'
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if not (
      v_direct_all
      or v_delegated_all
      or p_team_id = any(v_direct_team_ids)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'team'
           and d.scope_team_id = p_team_id
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'assignment_id', tracked.assignment_id,
      'template_id', tracked.template_id,
      'template_code', tracked.template_code,
      'template_name', tracked.template_name,
      'target_kind', tracked.target_kind,
      'target_group_id', tracked.target_group_id,
      'target_label', tracked.target_label,
      'target_member_count', tracked.target_member_count,
      'frequency', tracked.frequency,
      'is_mandatory', tracked.is_mandatory,
      'due_day_offset', tracked.due_day_offset,
      'due_time_local', to_char(tracked.due_time_local, 'HH24:MI:SS'),
      'exclude_sundays', tracked.exclude_sundays,
      'effective_from', tracked.effective_from,
      'effective_to', tracked.effective_to,
      'state', tracked.state,
      'version', tracked.version,
      'created_at', tracked.created_at,
      'obligation_total', tracked.obligation_total,
      'submitted_count', tracked.submitted_count,
      'not_started_count', tracked.not_started_count,
      'draft_count', tracked.draft_count,
      'overdue_count', tracked.overdue_count,
      'rejected_count', tracked.rejected_count,
      'exempted_count', tracked.exempted_count,
      'cancelled_count', tracked.cancelled_count
    ) order by tracked.updated_at desc, tracked.assignment_id)
      from (
        select a.assignment_id,
               a.template_id,
               t.template_code,
               t.display_name as template_name,
               a.target_kind,
               a.target_group_id,
               case a.target_kind
                 when 'TEAM' then coalesce(team.display_name, team.code, 'Nhóm không còn hoạt động')
                 when 'USER' then coalesce(
                   public.work_report__internal_user_display_name(a.target_user_id),
                   target_user.display_name,
                   'Tài khoản không còn hoạt động'
                 )
                 when 'GROUP' then case
                   when grp.group_id is null then 'Nhóm báo cáo'
                   when grp.active then grp.display_name
                   else grp.display_name || ' (Ngừng sử dụng)'
                 end
                 else coalesce(target_list.target_label, 'Danh sách nhân viên')
               end as target_label,
               case a.target_kind
                 when 'USER' then 1
                 when 'USER_SET' then coalesce(target_list.member_count, 0)
                 when 'GROUP' then coalesce((
                   select count(*)::integer
                     from public.work_report_group_members gm_cnt
                    where gm_cnt.group_id = a.target_group_id
                      and public.work_report__internal_is_eligible_assignee(gm_cnt.member_user_id)
                 ), 0)
                 when 'TEAM' then coalesce((
                   select count(distinct l.app_user_id)::integer
                     from public.direct_entry_app_user_recruiter_links l
                     join public.recruiter_team_memberships m
                       on m.recruiter_id = l.recruiter_id
                      and m.is_current
                     join public.direct_entry_app_users du
                       on du.app_user_id = l.app_user_id
                      and du.enabled
                    where m.team_id = a.target_team_id
                      and l.verified
                      and l.is_current
                 ), 0)
                 else 0
               end as target_member_count,
               a.frequency,
               a.is_mandatory,
               a.due_day_offset,
               a.due_time_local,
               a.exclude_sundays,
               a.effective_from,
               a.effective_to,
               a.state,
               a.version,
               a.created_at,
               a.updated_at,
               count(o.obligation_id)::integer as obligation_total,
               count(o.obligation_id) filter (where s.first_submitted_at is not null)::integer as submitted_count,
               count(o.obligation_id) filter (where o.obligation_status = 'ACTIVE' and s.submission_id is null)::integer as not_started_count,
               count(o.obligation_id) filter (where o.obligation_status = 'ACTIVE' and s.state = 'DRAFT')::integer as draft_count,
               count(o.obligation_id) filter (
                 where o.obligation_status = 'ACTIVE'
                   and coalesce(s.state, 'NOT_STARTED') in ('NOT_STARTED', 'DRAFT')
                   and now() > o.due_at
                   and coalesce(o.reopened_until < now(), true)
               )::integer as overdue_count,
               count(o.obligation_id) filter (
                 where o.obligation_status = 'ACTIVE'
                   and s.state = 'REJECTED'
               )::integer as rejected_count,
               count(o.obligation_id) filter (where o.obligation_status = 'EXEMPTED')::integer as exempted_count,
               count(o.obligation_id) filter (where o.obligation_status = 'CANCELLED')::integer as cancelled_count
          from public.work_report_assignments a
          join public.work_report_templates t on t.template_id = a.template_id
          left join public.teams team on team.team_id = a.target_team_id
          left join public.direct_entry_app_users target_user on target_user.app_user_id = a.target_user_id
          left join public.work_report_groups grp on grp.group_id = a.target_group_id
          left join lateral (
            select string_agg(
                     coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name),
                     ', '
                     order by coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name), u.app_user_id
                   ) as target_label,
                   count(*)::integer as member_count
              from public.work_report_assignment_targets x
              join public.direct_entry_app_users u on u.app_user_id = x.target_user_id
             where x.assignment_id = a.assignment_id
          ) target_list on true
          left join public.work_report_obligations o on o.assignment_id = a.assignment_id
          left join public.work_report_submissions s on s.obligation_id = o.obligation_id
         where (
           (a.target_kind = 'TEAM' and exists (
             select 1
               from public.work_report__internal_resolve_capability_authority(
                 p_app_user_id, 'report_assign', a.template_id, a.target_team_id
               )
           )) or
           (a.target_kind = 'USER' and exists (
             select 1
               from public.work_report__internal_resolve_capability_authority(
                 p_app_user_id, 'report_assign', a.template_id, public.work_report_current_team(a.target_user_id)
               )
           )) or
           (a.target_kind = 'USER_SET'
             and exists (select 1 from public.work_report_assignment_targets x where x.assignment_id = a.assignment_id)
             and not exists (
               select 1
                 from public.work_report_assignment_targets x
                where x.assignment_id = a.assignment_id
                  and not exists (
                    select 1
                      from public.work_report__internal_resolve_capability_authority(
                        p_app_user_id, 'report_assign', a.template_id, public.work_report_current_team(x.target_user_id)
                      )
                  )
             )
           ) or
           (a.target_kind = 'GROUP'
             and exists (select 1 from public.work_report_group_members gm where gm.group_id = a.target_group_id)
             and not exists (
               select 1
                 from public.work_report_group_members gm
                where gm.group_id = a.target_group_id
                  and not public.work_report__internal_actor_can_assign_member(
                    p_app_user_id,
                    gm.member_user_id,
                    a.template_id
                  )
             )
           )
         )
           and (
             p_team_id is null
             or (a.target_kind = 'TEAM' and a.target_team_id = p_team_id)
             or (a.target_kind = 'USER' and public.work_report_current_team(a.target_user_id) = p_team_id)
             or (a.target_kind = 'USER_SET' and exists (
               select 1
                 from public.work_report_assignment_targets x
                where x.assignment_id = a.assignment_id
                  and public.work_report_current_team(x.target_user_id) = p_team_id
             ))
             or (a.target_kind = 'GROUP' and exists (
               select 1
                 from public.work_report_group_members gm
                where gm.group_id = a.target_group_id
                  and public.work_report_current_team(gm.member_user_id) = p_team_id
             ))
           )
         group by a.assignment_id, t.template_code, t.display_name, team.display_name, team.code,
           target_user.display_name, grp.group_id, grp.display_name, grp.active,
           target_list.target_label, target_list.member_count
      ) tracked
  ), '[]'::jsonb));
end;
$function$;

revoke all on function public.work_report_list_assignments(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_assignments(uuid, uuid, uuid)
  to service_role;

create or replace function public.work_report_list_delegations(
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
               and (not coalesce(u.authz_managed, false) or u.account_type = 'NORMAL')
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
$function$;

revoke all on function public.work_report_list_delegations(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_delegations(uuid, uuid)
  to service_role;

create or replace function public.work_report_list_pending_reviews(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid default null,
  p_cursor text default null,
  p_page_size integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := statement_timestamp();
  v_limit integer := coalesce(p_page_size, 50);
  v_cursor_parts text[];
  v_has_cursor boolean := false;
  v_cursor_submitted_at timestamptz;
  v_cursor_obligation_id uuid;
  v_items jsonb;
  v_next_cursor text;
  v_has_more boolean := false;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_review', v_as_of) then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if v_limit not between 1 and 100 then
    raise exception 'WORK_REPORT_PAGINATION_INVALID' using errcode = '22023';
  end if;

  if p_template_id is not null and not exists (
    select 1 from public.work_report_templates t where t.template_id = p_template_id
  ) then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_cursor is not null and btrim(p_cursor) <> '' then
    v_cursor_parts := string_to_array(p_cursor, '|');
    if coalesce(array_length(v_cursor_parts, 1), 0) <> 2 then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end if;
    begin
      if v_cursor_parts[1] !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$' then
        raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
      end if;
      v_cursor_submitted_at := v_cursor_parts[1]::timestamptz;
      v_cursor_obligation_id := v_cursor_parts[2]::uuid;
      v_has_cursor := true;
    exception when others then
      raise exception 'WORK_REPORT_CURSOR_INVALID' using errcode = '22023';
    end;
  end if;

  with candidate_rows as (
    select o.obligation_id,
           s.submission_id,
           o.template_id,
           t.template_code,
           t.display_name as template_name,
           v.version_no as template_version,
           o.assignee_app_user_id,
           coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name) as assignee_display_name,
           o.snapshot_team_id,
           coalesce(o.snapshot_team_display_name, tm.display_name, o.snapshot_team_code, tm.code) as team_display_name,
           o.period_key,
           o.period_start_date,
           o.period_end_date,
           o.due_at,
           coalesce(s.latest_submitted_at, s.updated_at, s.created_at) as submitted_at,
           s.is_late,
           s.has_post_deadline_amendment,
           s.state,
           s.version as submission_version
      from public.work_report_obligations o
      join public.work_report_submissions s on s.obligation_id = o.obligation_id
      join public.work_report_templates t on t.template_id = o.template_id
      join public.work_report_template_versions v on v.version_id = o.template_version_id
      join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
      left join public.teams tm on tm.team_id = o.snapshot_team_id
     where o.obligation_status = 'ACTIVE'
       and s.state = 'PENDING_REVIEW'
       and (p_template_id is null or o.template_id = p_template_id)
       and exists (
         select 1
           from public.work_report__internal_resolve_capability_authority(
             p_app_user_id, 'report_review', o.template_id, o.snapshot_team_id, v_as_of
           ) auth
       )
  ),
  window_rows as (
    select c.*
      from candidate_rows c
     where not v_has_cursor
        or c.submitted_at < v_cursor_submitted_at
        or (c.submitted_at = v_cursor_submitted_at and c.obligation_id < v_cursor_obligation_id)
     order by c.submitted_at desc, c.obligation_id desc
     limit (v_limit + 1)
  ),
  page_rows as (
    select *
      from window_rows
     order by submitted_at desc, obligation_id desc
     limit v_limit
  )
  select coalesce((
           select jsonb_agg(jsonb_build_object(
             'obligation_id', pr.obligation_id,
             'submission_id', pr.submission_id,
             'template_id', pr.template_id,
             'template_code', pr.template_code,
             'template_name', pr.template_name,
             'template_version', pr.template_version,
             'period_key', pr.period_key,
             'period_start_date', pr.period_start_date,
             'period_end_date', pr.period_end_date,
             'due_at', pr.due_at,
             'assignee_app_user_id', pr.assignee_app_user_id,
             'assignee_display_name', pr.assignee_display_name,
             'assignee_label', pr.assignee_display_name,
             'snapshot_team_id', pr.snapshot_team_id,
             'team_id', pr.snapshot_team_id,
             'team_display_name', pr.team_display_name,
             'team_label', coalesce(pr.team_display_name, 'Chưa phân nhóm'),
             'submitted_at', pr.submitted_at,
             'is_late', pr.is_late,
             'has_post_deadline_amendment', pr.has_post_deadline_amendment,
             'state', pr.state,
             'submission_version', pr.submission_version,
             'version', pr.submission_version
           ) order by pr.submitted_at desc, pr.obligation_id desc)
           from page_rows pr
         ), '[]'::jsonb),
         (select count(*) > v_limit from window_rows),
         case
           when (select count(*) > v_limit from window_rows) then (
             select to_char(pr.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || pr.obligation_id::text
               from page_rows pr
              order by pr.submitted_at asc, pr.obligation_id asc
              limit 1
           )
           else null
         end
    into v_items, v_has_more, v_next_cursor;

  return jsonb_build_object(
    'items', v_items,
    'next_cursor', v_next_cursor,
    'has_more', v_has_more
  );
end;
$function$;

revoke all on function public.work_report_list_pending_reviews(uuid, uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_list_pending_reviews(uuid, uuid, uuid, text, integer)
  to service_role;

create or replace function public.work_report_get_review_submission(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of timestamptz := statement_timestamp();
  v_obligation public.work_report_obligations%rowtype;
  v_scope text;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  select o.* into v_obligation
    from public.work_report_obligations o
   where o.obligation_id = p_obligation_id
      or exists (
        select 1 from public.work_report_submissions s
         where s.submission_id = p_obligation_id
           and s.obligation_id = o.obligation_id
      );
  if not found then
    raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select a.acting_scope_kind into v_scope
    from public.work_report__internal_resolve_capability_authority(
      p_app_user_id, 'report_review', v_obligation.template_id, v_obligation.snapshot_team_id, v_as_of
    ) a;
  if v_scope is null then
    raise exception 'WORK_REPORT_ACCESS_DENIED' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from public.work_report_submissions s
     where s.obligation_id = v_obligation.obligation_id
       and s.current_revision_id is not null
  ) then
    raise exception 'WORK_REPORT_SUBMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select jsonb_build_object(
    'obligation', jsonb_build_object(
      'obligation_id', o.obligation_id,
      'assignment_id', o.assignment_id,
      'template_id', o.template_id,
      'template_version_id', o.template_version_id,
      'assignee_app_user_id', o.assignee_app_user_id,
      'assignee_display_name', coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name),
      'snapshot_team_id', o.snapshot_team_id,
      'snapshot_team_code', o.snapshot_team_code,
      'snapshot_team_display_name', o.snapshot_team_display_name,
      'team_display_name', coalesce(o.snapshot_team_display_name, tm.display_name, o.snapshot_team_code, tm.code),
      'period_type', o.period_type,
      'period_key', o.period_key,
      'period_start_date', o.period_start_date,
      'period_end_date', o.period_end_date,
      'due_at', o.due_at,
      'is_mandatory', o.is_mandatory,
      'obligation_status', o.obligation_status,
      'reopened_until', o.reopened_until,
      'version', o.version
    ),
    'template', jsonb_build_object(
      'template_id', t.template_id,
      'template_code', t.template_code,
      'display_name', t.display_name,
      'version_id', v.version_id,
      'version_no', v.version_no,
      'requires_review', v.requires_review,
      'schema_json', v.schema_json
    ),
    'submission', case when s.submission_id is null then null else jsonb_build_object(
      'submission_id', s.submission_id,
      'state', s.state,
      'first_submitted_at', s.first_submitted_at,
      'latest_submitted_at', s.latest_submitted_at,
      'is_late', s.is_late,
      'has_post_deadline_amendment', s.has_post_deadline_amendment,
      'current_revision_id', s.current_revision_id,
      'version', s.version
    ) end,
    'current_revision', case when r.revision_id is null then null else jsonb_build_object(
      'revision_id', r.revision_id,
      'revision_no', r.revision_no,
      'payload_json', r.payload_json,
      'created_at', r.created_at
    ) end,
    'revisions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'revision_id', sr.revision_id,
        'revision_no', sr.revision_no,
        'payload_json', sr.payload_json,
        'created_at', sr.created_at
      ) order by sr.revision_no desc)
        from public.work_report_submission_revisions sr
       where sr.submission_id = s.submission_id
    ), '[]'::jsonb),
    'assignee_display_name', coalesce(public.work_report__internal_user_display_name(u.app_user_id), u.display_name),
    'team_display_name', coalesce(o.snapshot_team_display_name, tm.display_name, o.snapshot_team_code, tm.code),
    'review_events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'review_event_id', re.review_event_id,
        'revision_id', re.revision_id,
        'reviewer_user_id', re.reviewer_user_id,
        'decision', re.decision,
        'reason', re.reason_text,
        'acting_scope_kind', re.acting_scope_kind,
        'acting_team_id', re.acting_team_id,
        'delegation_id', re.delegation_id,
        'created_at', re.created_at,
        'reviewed_at', re.created_at,
        'reviewer_display_name', coalesce(public.work_report__internal_user_display_name(ru.app_user_id), ru.display_name),
        'revision_no', rr.revision_no
      ) order by re.created_at desc, re.review_event_id desc)
        from public.work_report_review_events re
        join public.direct_entry_app_users ru on ru.app_user_id = re.reviewer_user_id
        left join public.work_report_submission_revisions rr on rr.revision_id = re.revision_id
       where re.submission_id = s.submission_id
    ), '[]'::jsonb)
  ) into v_result
    from public.work_report_obligations o
    join public.work_report_templates t on t.template_id = o.template_id
    join public.work_report_template_versions v on v.version_id = o.template_version_id
    join public.direct_entry_app_users u on u.app_user_id = o.assignee_app_user_id
    left join public.teams tm on tm.team_id = o.snapshot_team_id
    left join public.work_report_submissions s on s.obligation_id = o.obligation_id
    left join public.work_report_submission_revisions r on r.revision_id = s.current_revision_id
   where o.obligation_id = v_obligation.obligation_id;

  return v_result;
end;
$function$;

revoke all on function public.work_report_get_review_submission(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_get_review_submission(uuid, uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 5. Work Reports Public Mutating RPCs — Paired WP5 Enforcement, Ordered Locks,
--    Idempotency Before OCC
-- -----------------------------------------------------------------------------
create or replace function public.work_report_create_group(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_display_name text,
  p_description text,
  p_member_user_ids uuid[],
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_name text;
  v_description text;
  v_distinct_count integer;
  v_group_id uuid;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_name := pg_catalog.btrim(coalesce(p_display_name, ''));
  v_description := case
    when p_description is null then null
    else nullif(pg_catalog.btrim(p_description), '')
  end;

  if pg_catalog.length(v_name) not between 1 and 160
     or (v_description is not null and pg_catalog.length(v_description) > 1000)
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128
     or coalesce(cardinality(p_member_user_ids), 0) < 1
     or exists (select 1 from unnest(p_member_user_ids) as x(uid) where x.uid is null) then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  select count(distinct x.uid)::integer
    into v_distinct_count
    from unnest(p_member_user_ids) as x(uid);
  if v_distinct_count <> cardinality(p_member_user_ids) then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + grantors + target members.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select x.uid
        from unnest(p_member_user_ids) as x(uid)
    ) u_ids
   where uid is not null;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of actor, grantors & target members (serializes against move_team_membership).
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  -- Tier WR-5 strict ASC FOR SHARE lock on actor's active report_assign delegations.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_actor_can_assign_member(p_app_user_id, x.uid, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_is_eligible_assignee(x.uid)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'display_name', v_name,
    'description', v_description,
    'member_user_ids', (
      select jsonb_agg(x.uid order by x.uid)
        from unnest(p_member_user_ids) as x(uid)
    )
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_group_create',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  insert into public.work_report_groups (
    display_name,
    description,
    active,
    created_by_user_id,
    updated_by_user_id
  )
  values (
    v_name,
    v_description,
    true,
    p_app_user_id,
    p_app_user_id
  )
  returning group_id into v_group_id;

  insert into public.work_report_group_members (
    group_id,
    member_user_id,
    added_by_user_id
  )
  select v_group_id, x.uid, p_app_user_id
    from unnest(p_member_user_ids) as x(uid);

  v_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'all'
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      ) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    outcome,
    metadata_json
  )
  values (
    'GROUP_CREATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    'APPLIED',
    jsonb_build_object(
      'group_id', v_group_id,
      'member_count', v_distinct_count
    )
  );

  v_result := jsonb_build_object('group_id', v_group_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_group_create',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.work_report_create_group(uuid, uuid, text, text, uuid[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_group(uuid, uuid, text, text, uuid[], text)
  to service_role;

create or replace function public.work_report_update_group(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_group_id uuid,
  p_expected_version integer,
  p_display_name text,
  p_description text,
  p_member_user_ids uuid[],
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_group public.work_report_groups%rowtype;
  v_name text;
  v_description text;
  v_distinct_count integer;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  v_name := pg_catalog.btrim(coalesce(p_display_name, ''));
  v_description := case
    when p_description is null then null
    else nullif(pg_catalog.btrim(p_description), '')
  end;

  if p_group_id is null
     or p_expected_version is null or p_expected_version < 1
     or pg_catalog.length(v_name) not between 1 and 160
     or (v_description is not null and pg_catalog.length(v_description) > 1000)
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128
     or coalesce(cardinality(p_member_user_ids), 0) < 1
     or exists (select 1 from unnest(p_member_user_ids) as x(uid) where x.uid is null) then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  select count(distinct x.uid)::integer
    into v_distinct_count
    from unnest(p_member_user_ids) as x(uid);
  if v_distinct_count <> cardinality(p_member_user_ids) then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + grantors + existing & target group members.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select gm.member_user_id as uid
        from public.work_report_group_members gm
       where gm.group_id = p_group_id
      union all
      select x.uid
        from unnest(p_member_user_ids) as x(uid)
    ) u_ids
   where uid is not null;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of group members.
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  select *
    into v_group
    from public.work_report_groups g
   where g.group_id = p_group_id
     for update;

  if not found then
    raise exception 'WORK_REPORT_GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier WR-5 strict ASC FOR SHARE lock on actor's active report_assign delegations.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_group_id
       and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm.member_user_id, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_actor_can_assign_member(p_app_user_id, x.uid, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'group_id', p_group_id,
    'expected_version', p_expected_version,
    'display_name', v_name,
    'description', v_description,
    'member_user_ids', (
      select jsonb_agg(x.uid order by x.uid)
        from unnest(p_member_user_ids) as x(uid)
    )
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_group_update',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_group.version <> p_expected_version then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if exists (
    select 1
      from unnest(p_member_user_ids) as x(uid)
     where not public.work_report__internal_is_eligible_assignee(x.uid)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  update public.work_report_groups
     set display_name = v_name,
         description = v_description,
         updated_by_user_id = p_app_user_id,
         version = version + 1,
         updated_at = now()
   where group_id = p_group_id;

  delete from public.work_report_group_members gm
   where gm.group_id = p_group_id
     and not (gm.member_user_id = any(p_member_user_ids));

  insert into public.work_report_group_members (
    group_id,
    member_user_id,
    added_by_user_id
  )
  select p_group_id, x.uid, p_app_user_id
    from unnest(p_member_user_ids) as x(uid)
  on conflict (group_id, member_user_id) do nothing;

  v_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'all'
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      ) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    outcome,
    metadata_json
  )
  values (
    'GROUP_UPDATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    'APPLIED',
    jsonb_build_object(
      'group_id', p_group_id,
      'member_count', v_distinct_count,
      'version', p_expected_version + 1
    )
  );

  v_result := jsonb_build_object('group_id', p_group_id, 'version', p_expected_version + 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_group_update',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.work_report_update_group(uuid, uuid, uuid, integer, text, text, uuid[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_update_group(uuid, uuid, uuid, integer, text, text, uuid[], text)
  to service_role;

create or replace function public.work_report_set_group_active(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_group_id uuid,
  p_expected_version integer,
  p_active boolean,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_group public.work_report_groups%rowtype;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_group_id is null
     or p_expected_version is null or p_expected_version < 1
     or p_active is null
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_GROUP_INVALID' using errcode = '22023';
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + grantors + group members.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select gm.member_user_id as uid
        from public.work_report_group_members gm
       where gm.group_id = p_group_id
    ) u_ids
   where uid is not null;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of group members.
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  select *
    into v_group
    from public.work_report_groups g
   where g.group_id = p_group_id
     for update;

  if not found then
    raise exception 'WORK_REPORT_GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier WR-5 strict ASC FOR SHARE lock on actor's active report_assign delegations.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if not exists (
    select 1
      from public.work_report_group_members gm0
     where gm0.group_id = p_group_id
  ) or exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_group_id
       and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm.member_user_id, null)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'group_id', p_group_id,
    'expected_version', p_expected_version,
    'active', p_active
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_group_active',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_group.version <> p_expected_version then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if p_active and not exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_group_id
       and public.work_report__internal_is_eligible_assignee(gm.member_user_id)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  update public.work_report_groups
     set active = p_active,
         updated_by_user_id = p_app_user_id,
         version = version + 1,
         updated_at = now()
   where group_id = p_group_id;

  v_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'all'
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      ) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    outcome,
    metadata_json
  )
  values (
    case when p_active then 'GROUP_ACTIVATE' else 'GROUP_DEACTIVATE' end,
    p_app_user_id,
    'report_assign',
    v_scope,
    'APPLIED',
    jsonb_build_object(
      'group_id', p_group_id,
      'active', p_active,
      'version', p_expected_version + 1
    )
  );

  v_result := jsonb_build_object(
    'group_id', p_group_id,
    'active', p_active,
    'version', p_expected_version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_group_active',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_set_group_active(uuid, uuid, uuid, integer, boolean, text)
  to service_role;

create or replace function public.work_report_ensure_obligations_for_window(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_business_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_inserted integer;
  v_audit_scope text;
  v_lock_user_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_business_date is null then
    raise exception 'WORK_REPORT_DATE_INVALID' using errcode = '22023';
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + active report_assign delegation grantors.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.state = 'ACTIVE'
         and d.is_current
    ) u_ids
   where uid is not null;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of actor + grantors.
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);

  -- Tier WR-5 strict ASC FOR SHARE lock on actor's active report_assign delegations.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  with candidate as (
    select a.*,
           u.app_user_id as assignee_id,
           public.work_report_current_team(u.app_user_id) as team_id,
           u.snapshot_group_id,
           u.snapshot_group_name
      from public.work_report_assignments a
      cross join lateral (
        select a.target_user_id as app_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
         where a.target_kind = 'USER'
        union all
        select x.target_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
          from public.work_report_assignment_targets x
         where a.target_kind = 'USER_SET'
           and x.assignment_id = a.assignment_id
        union all
        select l.app_user_id,
               null::uuid as snapshot_group_id,
               null::text as snapshot_group_name
          from public.direct_entry_app_user_recruiter_links l
          join public.recruiter_team_memberships m
            on m.recruiter_id = l.recruiter_id and m.is_current
         where a.target_kind = 'TEAM'
           and m.team_id = a.target_team_id
           and l.verified
           and l.is_current
        union all
        select gm.member_user_id,
               g.group_id as snapshot_group_id,
               g.display_name as snapshot_group_name
          from public.work_report_groups g
          join public.work_report_group_members gm
            on gm.group_id = g.group_id
         where a.target_kind = 'GROUP'
           and g.group_id = a.target_group_id
           and g.active
      ) u
     where a.is_current
       and a.state = 'ACTIVE'
       and a.effective_from <= p_business_date
       and (a.effective_to is null or p_business_date <= a.effective_to)
  ),
  authorized as (
    select c.*
      from candidate c
     where exists (
       select 1
         from public.work_report__internal_resolve_capability_authority(
           p_app_user_id,
           'report_assign',
           c.template_id,
           c.team_id
         ) auth
     )
       and (
         c.target_kind <> 'GROUP'
         or (
           public.work_report__internal_is_eligible_assignee(c.assignee_id)
           and not exists (
             select 1
               from public.work_report_group_members gm_out
              where gm_out.group_id = c.target_group_id
                and not public.work_report__internal_actor_can_assign_member(
                  p_app_user_id,
                  gm_out.member_user_id,
                  c.template_id
                )
           )
         )
       )
  ),
  materialized as (
    select a.*,
           p.period_key,
           p.period_start_date,
           p.period_end_date,
           public.work_report_due_at(
             p.period_end_date,
             a.due_day_offset,
             a.due_time_local,
             a.exclude_sundays
           ) as due_at
      from authorized a
      cross join lateral public.work_report_period(a.frequency, p_business_date) p
  ),
  deduplicated as (
    select distinct on (m.template_id, m.assignee_id, m.period_key)
           m.*
      from materialized m
     where exists (
       select 1
         from public.direct_entry_app_users u
        where u.app_user_id = m.assignee_id
          and u.enabled
     )
     order by m.template_id, m.assignee_id, m.period_key, m.due_at asc, m.created_at asc, m.assignment_id asc
  ),
  inserted as (
    insert into public.work_report_obligations (
      template_id,
      template_version_id,
      assignment_id,
      assignee_app_user_id,
      snapshot_team_id,
      snapshot_team_code,
      snapshot_team_display_name,
      snapshot_group_id,
      snapshot_group_name,
      period_type,
      period_key,
      period_start_date,
      period_end_date,
      due_at,
      is_mandatory
    )
    select d.template_id,
           d.template_version_id,
           d.assignment_id,
           d.assignee_id,
           d.team_id,
           t.code,
           t.display_name,
           d.snapshot_group_id,
           d.snapshot_group_name,
           d.frequency,
           d.period_key,
           d.period_start_date,
           d.period_end_date,
           d.due_at,
           d.is_mandatory
      from deduplicated d
      left join public.teams t on t.team_id = d.team_id
    on conflict (template_id, assignee_app_user_id, period_key) do nothing
    returning 1
  )
  select count(*)::integer into v_inserted from inserted;

  v_audit_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.scope_kind = 'all'
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      ) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    outcome,
    metadata_json
  )
  values (
    'OBLIGATION_MATERIALIZE',
    p_app_user_id,
    'report_assign',
    v_audit_scope,
    'APPLIED',
    jsonb_build_object('business_date', p_business_date, 'inserted_count', v_inserted)
  );

  return jsonb_build_object('business_date', p_business_date, 'inserted_count', v_inserted);
end;
$function$;

revoke all on function public.work_report_ensure_obligations_for_window(uuid, uuid, date)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_ensure_obligations_for_window(uuid, uuid, date)
  to service_role;

create or replace function public.work_report_create_delegation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_capability text,
  p_delegate_app_user_id uuid,
  p_template_id uuid,
  p_scope_kind text,
  p_scope_team_id uuid,
  p_effective_from timestamptz default null,
  p_effective_to timestamptz default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_delegate public.direct_entry_app_users%rowtype;
  v_template public.work_report_templates%rowtype;
  v_delegation_id uuid;
  v_effective_from timestamptz;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_recruiter_ids uuid[];
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

  if not found
     or not v_delegate.enabled
     or (coalesce(v_delegate.authz_managed, false) and v_delegate.account_type is distinct from 'NORMAL') then
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
$function$;

revoke all on function public.work_report_create_delegation(uuid, uuid, text, uuid, uuid, text, uuid, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_delegation(uuid, uuid, text, uuid, uuid, text, uuid, timestamptz, timestamptz, text)
  to service_role;

create or replace function public.work_report_revoke_delegation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_delegation_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_delegation public.work_report_delegations%rowtype;
  v_now timestamptz := statement_timestamp();
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');

  if p_delegation_id is null
     or p_expected_version is null
     or p_expected_version < 1
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_DELEGATION_INVALID' using errcode = '22023';
  end if;

  -- Tier 2 FOR SHARE lock on actor before locking delegation row FOR UPDATE.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
   for share;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_delegate');

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'delegation_id', p_delegation_id,
    'expected_version', p_expected_version
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_delegation_revoke', p_idempotency_key, v_request_hash);
  if v_prior is not null then
    return v_prior;
  end if;

  select * into v_delegation
    from public.work_report_delegations
   where delegation_id = p_delegation_id
   for update;
  if not found then
    raise exception 'WORK_REPORT_DELEGATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not public.work_report__internal_has_direct_scope(p_app_user_id, 'report_delegate', 'all', null)
     and v_delegation.grantor_user_id <> p_app_user_id
     and not (
       v_delegation.scope_kind = 'team'
       and public.work_report__internal_has_direct_scope(p_app_user_id, 'report_delegate', 'team', v_delegation.scope_team_id)
     ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if v_delegation.version <> p_expected_version or v_delegation.state = 'REVOKED' then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  update public.work_report_delegations
     set state = 'REVOKED',
         is_current = false,
         revoked_by_user_id = p_app_user_id,
         revoked_at = v_now,
         version = version + 1,
         updated_at = v_now
   where delegation_id = p_delegation_id;

  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, scope_team_id, template_id, outcome, metadata_json)
  values
    ('DELEGATION_REVOKE', p_app_user_id, 'report_delegate', v_delegation.scope_kind, v_delegation.scope_team_id,
     v_delegation.template_id, 'APPLIED',
     jsonb_build_object(
       'delegation_id', p_delegation_id,
       'delegate_app_user_id', v_delegation.delegate_app_user_id,
       'delegated_capability', v_delegation.capability
     ));

  v_result := jsonb_build_object(
    'delegation_id', p_delegation_id,
    'status', 'REVOKED',
    'state', 'REVOKED',
    'version', p_expected_version + 1
  );
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_delegation_revoke', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

revoke all on function public.work_report_revoke_delegation(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_revoke_delegation(uuid, uuid, uuid, integer, text)
  to service_role;

create or replace function public.work_report_decide_review(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid,
  p_decision text,
  p_reason text,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_submission public.work_report_submissions%rowtype;
  v_decision text;
  v_clean_reason text;
  v_reason_id uuid;
  v_acting_scope_kind text;
  v_acting_team_id uuid;
  v_delegation_id uuid;
  v_review_event_id uuid;
  v_now timestamptz := statement_timestamp();
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);

  v_decision := case upper(btrim(coalesce(p_decision, '')))
    when 'APPROVE' then 'APPROVED'
    when 'APPROVED' then 'APPROVED'
    when 'REJECT' then 'REJECTED'
    when 'REJECTED' then 'REJECTED'
    else null
  end;
  if v_decision is null then
    raise exception 'WORK_REPORT_REVIEW_DECISION_INVALID' using errcode = '22023';
  end if;

  v_clean_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_decision = 'REJECTED' and (v_clean_reason is null or length(v_clean_reason) > 4000) then
    raise exception 'WORK_REPORT_REVIEW_REASON_REQUIRED: rejection requires a reason' using errcode = '22023';
  end if;
  if v_clean_reason is not null and length(v_clean_reason) > 4000 then
    raise exception 'WORK_REPORT_REVIEW_REASON_INVALID' using errcode = '22023';
  end if;

  if p_obligation_id is null
     or p_expected_version is null
     or p_expected_version < 1
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_REVIEW_INVALID' using errcode = '22023';
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on reviewer + any active delegation grantors before WR locks.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_review'
         and d.state = 'ACTIVE'
         and d.is_current
    ) u_ids
   where uid is not null;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on reviewer + grantors' recruiters (serializes team-scoped delegate move_team_membership).
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);

  select * into v_obligation
    from public.work_report_obligations
   where obligation_id = p_obligation_id
   for update;
  if not found then
    raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  select * into v_submission
    from public.work_report_submissions
   where obligation_id = p_obligation_id
   for update;
  if not found or v_submission.current_revision_id is null then
    raise exception 'WORK_REPORT_SUBMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier WR-5 strict ASC FOR SHARE lock on ALL active report_review delegations for actor + template
  -- (prevents unlocked secondary delegation fallback during concurrent revocations).
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_review'
     and d.template_id = v_obligation.template_id
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  select a.acting_scope_kind, a.acting_team_id, a.delegation_id
    into v_acting_scope_kind, v_acting_team_id, v_delegation_id
    from public.work_report__internal_resolve_capability_authority(
      p_app_user_id, 'report_review', v_obligation.template_id, v_obligation.snapshot_team_id, v_now
    ) a;

  if v_acting_scope_kind is null then
    raise exception 'WORK_REPORT_REVIEW_ACCESS_DENIED' using errcode = '42501';
  end if;

  if v_obligation.assignee_app_user_id = p_app_user_id
     or v_submission.assignee_app_user_id = p_app_user_id
     or v_submission.submitted_by_user_id = p_app_user_id then
    raise exception 'WORK_REPORT_SELF_REVIEW_FORBIDDEN' using errcode = '42501';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'obligation_id', p_obligation_id,
    'decision', v_decision,
    'reason', v_clean_reason,
    'expected_version', p_expected_version
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_decide_review', p_idempotency_key, v_request_hash);
  if v_prior is not null then
    return v_prior;
  end if;

  if v_submission.version <> p_expected_version or v_submission.state <> 'PENDING_REVIEW' then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  if v_clean_reason is not null then
    v_reason_id := public.direct_entry_reason(p_app_user_id, v_clean_reason);
  end if;

  update public.work_report_submissions
     set state = v_decision,
         reviewed_by_user_id = p_app_user_id,
         reviewed_at = v_now,
         review_reason_id = v_reason_id,
         version = version + 1,
         updated_at = v_now
   where submission_id = v_submission.submission_id
   returning * into v_submission;

  if v_decision = 'APPROVED' then
    update public.work_report_metric_values
       set is_current_revision = true,
           is_provisional = false,
           is_final = true,
           is_eligible = true
     where submission_id = v_submission.submission_id
       and revision_id = v_submission.current_revision_id;
  else
    update public.work_report_metric_values
       set is_current_revision = true,
           is_provisional = false,
           is_final = false,
           is_eligible = false
     where submission_id = v_submission.submission_id
       and revision_id = v_submission.current_revision_id;
  end if;

  insert into public.work_report_review_events
    (submission_id, revision_id, obligation_id, template_id, reviewer_user_id, author_user_id,
     decision, reason_id, reason_text, acting_scope_kind, acting_team_id, delegation_id, created_at)
  values
    (v_submission.submission_id, v_submission.current_revision_id, p_obligation_id, v_obligation.template_id,
     p_app_user_id, v_obligation.assignee_app_user_id, v_decision, v_reason_id, v_clean_reason,
     v_acting_scope_kind, v_acting_team_id, v_delegation_id, v_now)
  returning review_event_id into v_review_event_id;

  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, scope_team_id, template_id, obligation_id, submission_id, outcome, reason_id, metadata_json)
  values
    (case when v_decision = 'APPROVED' then 'REVIEW_APPROVE' else 'REVIEW_REJECT' end,
     p_app_user_id, 'report_review', v_acting_scope_kind, v_acting_team_id,
     v_obligation.template_id, p_obligation_id, v_submission.submission_id, 'APPLIED', v_reason_id,
     jsonb_build_object(
       'review_event_id', v_review_event_id,
       'revision_id', v_submission.current_revision_id,
       'decision', v_decision,
       'delegation_id', v_delegation_id
     ));

  v_result := jsonb_build_object(
    'submission_id', v_submission.submission_id,
    'obligation_id', p_obligation_id,
    'revision_id', v_submission.current_revision_id,
    'review_event_id', v_review_event_id,
    'state', v_decision,
    'version', v_submission.version,
    'acting_scope_kind', v_acting_scope_kind,
    'acting_team_id', v_acting_team_id,
    'delegation_id', v_delegation_id
  );
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_decide_review', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

revoke all on function public.work_report_decide_review(uuid, uuid, uuid, text, text, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_decide_review(uuid, uuid, uuid, text, text, integer, text)
  to service_role;

create or replace function public.work_report_create_assignment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_target_kind text,
  p_target_user_id uuid,
  p_target_team_id uuid,
  p_target_user_ids uuid[],
  p_frequency text,
  p_is_mandatory boolean,
  p_due_day_offset integer,
  p_due_time_local time without time zone,
  p_exclude_sundays boolean,
  p_effective_from date,
  p_effective_to date,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_assignment_id uuid;
  v_scope text;
  v_scope_team_id uuid;
  v_delegation_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_target_kind not in ('USER', 'TEAM', 'USER_SET')
     or p_frequency not in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')
     or p_due_day_offset not between 0 and 31
     or p_effective_from is null
     or (p_effective_to is not null and p_effective_to < p_effective_from)
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;
  if (p_target_kind = 'USER') <> (p_target_user_id is not null and p_target_team_id is null)
     or (p_target_kind = 'TEAM') <> (p_target_team_id is not null and p_target_user_id is null)
     or (p_target_kind = 'USER_SET' and (p_target_user_id is not null or p_target_team_id is not null)) then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;
  if p_target_kind = 'USER_SET' and coalesce(cardinality(p_target_user_ids), 0) < 1 then
    raise exception 'WORK_REPORT_ASSIGNMENT_TARGET_INVALID' using errcode = '22023';
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + active report_assign delegation grantors + target users.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.template_id = p_template_id
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select p_target_user_id as uid
       where p_target_kind = 'USER' and p_target_user_id is not null
      union all
      select x.uid
        from unnest(coalesce(p_target_user_ids, array[]::uuid[])) as x(uid)
       where p_target_kind = 'USER_SET' and x.uid is not null
    ) u_ids
   where uid is not null;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of actor, grantors & target users (serializes against move_team_membership for USER, USER_SET, and delegated TEAM).
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_target_kind = 'TEAM' then
    v_scope_team_id := p_target_team_id;
  elsif p_target_kind = 'USER' then
    v_scope_team_id := public.work_report_resolve_assignment_user_team(p_target_user_id);
  end if;

  select * into v_template from public.work_report_templates where template_id = p_template_id for share;

  -- Tier WR-3 FOR SHARE on active report_assign delegations for this actor + template.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.template_id = p_template_id
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if p_target_kind in ('USER', 'TEAM') then
    select a.acting_scope_kind, a.delegation_id
      into v_scope, v_delegation_id
      from public.work_report__internal_resolve_capability_authority(
        p_app_user_id, 'report_assign', p_template_id, v_scope_team_id
      ) a;
    if v_scope is null then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  else
    if exists (
      select 1
        from unnest(p_target_user_ids) x(user_id)
       where not exists (
         select 1
           from public.work_report__internal_resolve_capability_authority(
             p_app_user_id, 'report_assign', p_template_id, public.work_report_current_team(x.user_id)
           ) a
       )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
        or exists (
          select 1
            from public.work_report_delegations d
           where d.delegate_app_user_id = p_app_user_id
             and d.capability = 'report_assign'
             and d.template_id = p_template_id
             and d.scope_kind = 'all'
             and public.work_report__internal_is_delegation_effective(d.delegation_id)
        ) then 'all'
      else 'team'
    end;
  end if;

  if v_template.template_id is null or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id', p_template_id,
    'target_kind', p_target_kind,
    'target_user_id', p_target_user_id,
    'target_team_id', p_target_team_id,
    'target_user_ids', p_target_user_ids,
    'frequency', p_frequency,
    'is_mandatory', p_is_mandatory,
    'due_day_offset', p_due_day_offset,
    'due_time_local', p_due_time_local,
    'exclude_sundays', p_exclude_sundays,
    'effective_from', p_effective_from,
    'effective_to', p_effective_to
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'work_report_assignment_create', p_idempotency_key, v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  insert into public.work_report_assignments (
    template_id,
    template_version_id,
    target_kind,
    target_user_id,
    target_team_id,
    frequency,
    is_mandatory,
    due_day_offset,
    due_time_local,
    exclude_sundays,
    effective_from,
    effective_to,
    assigned_by_user_id
  )
  values (
    p_template_id,
    v_template.current_published_version_id,
    p_target_kind,
    p_target_user_id,
    p_target_team_id,
    p_frequency,
    coalesce(p_is_mandatory, true),
    p_due_day_offset,
    p_due_time_local,
    coalesce(p_exclude_sundays, false),
    p_effective_from,
    p_effective_to,
    p_app_user_id
  )
  returning assignment_id into v_assignment_id;

  if p_target_kind = 'USER_SET' then
    insert into public.work_report_assignment_targets (assignment_id, target_user_id)
      select v_assignment_id, x
        from (select distinct unnest(p_target_user_ids) x) q;
  end if;

  perform public.work_report__internal_materialize_assignment_for_date(
    v_assignment_id,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    scope_team_id,
    template_id,
    outcome,
    metadata_json
  )
  values (
    'ASSIGNMENT_CREATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    case when v_scope = 'team' then v_scope_team_id else null end,
    p_template_id,
    'APPLIED',
    jsonb_build_object(
      'assignment_id', v_assignment_id,
      'target_kind', p_target_kind,
      'delegation_id', v_delegation_id
    )
  );

  v_result := jsonb_build_object('assignment_id', v_assignment_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'work_report_assignment_create', p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.work_report_create_assignment(uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_assignment(uuid, uuid, uuid, text, uuid, uuid, uuid[], text, boolean, integer, time without time zone, boolean, date, date, text)
  to service_role;

create or replace function public.work_report_create_group_assignment(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_target_group_id uuid,
  p_frequency text,
  p_is_mandatory boolean,
  p_due_day_offset integer,
  p_due_time_local time without time zone,
  p_exclude_sundays boolean,
  p_effective_from date,
  p_effective_to date,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_group public.work_report_groups%rowtype;
  v_assignment_id uuid;
  v_scope text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  if p_template_id is null
     or p_target_group_id is null
     or p_frequency not in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')
     or p_due_day_offset not between 0 and 31
     or p_due_time_local is null
     or p_effective_from is null
     or (p_effective_to is not null and p_effective_to < p_effective_from)
     or pg_catalog.length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_ASSIGNMENT_INVALID' using errcode = '22023';
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + active report_assign delegation grantors + group members.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.template_id = p_template_id
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select gm.member_user_id as uid
        from public.work_report_group_members gm
       where gm.group_id = p_target_group_id
    ) u_ids
   where uid is not null;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of group members (serializes against move_team_membership).
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  select *
    into v_group
    from public.work_report_groups g
   where g.group_id = p_target_group_id
     for share;

  if not found then
    raise exception 'WORK_REPORT_GROUP_NOT_FOUND' using errcode = 'P0002';
  end if;

  select *
    into v_template
    from public.work_report_templates t
   where t.template_id = p_template_id
     for share;

  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.template_id = p_template_id
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  if not exists (
    select 1
      from public.work_report_group_members gm0
     where gm0.group_id = p_target_group_id
  ) or exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_target_group_id
       and not public.work_report__internal_actor_can_assign_member(p_app_user_id, gm.member_user_id, p_template_id)
  ) then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if not v_group.active then
    raise exception 'WORK_REPORT_GROUP_INACTIVE' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from public.work_report_group_members gm
     where gm.group_id = p_target_group_id
       and public.work_report__internal_is_eligible_assignee(gm.member_user_id)
  ) then
    raise exception 'WORK_REPORT_GROUP_MEMBER_INELIGIBLE' using errcode = '22023';
  end if;

  if v_template.template_id is null or v_template.status <> 'ACTIVE' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_ACTIVE' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id', p_template_id,
    'target_kind', 'GROUP',
    'target_group_id', p_target_group_id,
    'frequency', p_frequency,
    'is_mandatory', p_is_mandatory,
    'due_day_offset', p_due_day_offset,
    'due_time_local', p_due_time_local,
    'exclude_sundays', p_exclude_sundays,
    'effective_from', p_effective_from,
    'effective_to', p_effective_to
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_assignment_create',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  insert into public.work_report_assignments (
    template_id,
    template_version_id,
    target_kind,
    target_user_id,
    target_team_id,
    target_group_id,
    frequency,
    is_mandatory,
    due_day_offset,
    due_time_local,
    exclude_sundays,
    effective_from,
    effective_to,
    assigned_by_user_id
  )
  values (
    p_template_id,
    v_template.current_published_version_id,
    'GROUP',
    null,
    null,
    p_target_group_id,
    p_frequency,
    coalesce(p_is_mandatory, true),
    p_due_day_offset,
    p_due_time_local,
    coalesce(p_exclude_sundays, false),
    p_effective_from,
    p_effective_to,
    p_app_user_id
  )
  returning assignment_id into v_assignment_id;

  perform public.work_report__internal_materialize_assignment_for_date(
    v_assignment_id,
    (now() at time zone 'Asia/Ho_Chi_Minh')::date
  );

  v_scope := case
    when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
      or exists (
        select 1
          from public.work_report_delegations d
         where d.delegate_app_user_id = p_app_user_id
           and d.capability = 'report_assign'
           and d.template_id = p_template_id
           and d.scope_kind = 'all'
           and public.work_report__internal_is_delegation_effective(d.delegation_id)
      ) then 'all'
    else 'team'
  end;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    template_id,
    outcome,
    metadata_json
  )
  values (
    'ASSIGNMENT_CREATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    p_template_id,
    'APPLIED',
    jsonb_build_object(
      'assignment_id', v_assignment_id,
      'target_kind', 'GROUP',
      'target_group_id', p_target_group_id
    )
  );

  v_result := jsonb_build_object('assignment_id', v_assignment_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_assignment_create',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_group_assignment(uuid, uuid, uuid, uuid, text, boolean, integer, time without time zone, boolean, date, date, text)
  to service_role;

create or replace function public.work_report_set_assignment_state(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_expected_version integer,
  p_state text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_assignment public.work_report_assignments%rowtype;
  v_group_active boolean;
  v_team_id uuid;
  v_scope text;
  v_delegation_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_pre_group_id uuid;
  v_lock_user_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_state not in ('ACTIVE', 'PAUSED', 'REVOKED') then
    raise exception 'WORK_REPORT_ASSIGNMENT_STATE_INVALID' using errcode = '22023';
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + active report_assign grantors + target members.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.state = 'ACTIVE'
         and d.is_current
      union all
      select a.target_user_id as uid
        from public.work_report_assignments a
       where a.assignment_id = p_assignment_id
         and a.target_kind = 'USER'
         and a.target_user_id is not null
      union all
      select t.target_user_id as uid
        from public.work_report_assignment_targets t
       where t.assignment_id = p_assignment_id
      union all
      select gm.member_user_id as uid
        from public.work_report_assignments a
        join public.work_report_group_members gm on gm.group_id = a.target_group_id
       where a.assignment_id = p_assignment_id
         and a.target_kind = 'GROUP'
    ) u_ids
   where uid is not null;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of actor, grantors & target members.
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  -- Tier WR-1 FOR SHARE on target group (if GROUP assignment) before locking assignment row.
  select a.target_group_id
    into v_pre_group_id
    from public.work_report_assignments a
   where a.assignment_id = p_assignment_id
     and a.target_kind = 'GROUP';

  if v_pre_group_id is not null then
    perform g.group_id
      from public.work_report_groups g
     where g.group_id = v_pre_group_id
     for share;
  end if;

  select *
    into v_assignment
    from public.work_report_assignments
   where assignment_id = p_assignment_id
     for update;
  if not found then
    raise exception 'WORK_REPORT_ASSIGNMENT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier WR-5 strict ASC FOR SHARE lock on active report_assign delegations for actor + template.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.template_id = v_assignment.template_id
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  v_team_id := case v_assignment.target_kind
    when 'TEAM' then v_assignment.target_team_id
    when 'USER' then public.work_report_resolve_assignment_user_team(v_assignment.target_user_id)
    else null
  end;

  if v_assignment.target_kind = 'USER_SET' then
    if exists (
      select 1
        from public.work_report_assignment_targets x
       where x.assignment_id = p_assignment_id
         and not exists (
           select 1
             from public.work_report__internal_resolve_capability_authority(
               p_app_user_id,
               'report_assign',
               v_assignment.template_id,
               public.work_report_current_team(x.target_user_id)
             ) a
         )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
        or exists (
          select 1
            from public.work_report_delegations d
           where d.delegate_app_user_id = p_app_user_id
             and d.capability = 'report_assign'
             and d.template_id = v_assignment.template_id
             and d.scope_kind = 'all'
             and public.work_report__internal_is_delegation_effective(d.delegation_id)
        ) then 'all'
      else 'team'
    end;
  elsif v_assignment.target_kind = 'GROUP' then
    if not exists (
      select 1
        from public.work_report_group_members gm0
       where gm0.group_id = v_assignment.target_group_id
    ) or exists (
      select 1
        from public.work_report_group_members gm
       where gm.group_id = v_assignment.target_group_id
         and not public.work_report__internal_actor_can_assign_member(
           p_app_user_id,
           gm.member_user_id,
           v_assignment.template_id
         )
    ) then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
    if p_state = 'ACTIVE' then
      select g.active
        into v_group_active
        from public.work_report_groups g
       where g.group_id = v_assignment.target_group_id;
      if not coalesce(v_group_active, false) then
        raise exception 'WORK_REPORT_GROUP_INACTIVE' using errcode = '22023';
      end if;
    end if;
    v_scope := case
      when public.work_report__internal_has_direct_scope(p_app_user_id, 'report_assign', 'all', null)
        or exists (
          select 1
            from public.work_report_delegations d
           where d.delegate_app_user_id = p_app_user_id
             and d.capability = 'report_assign'
             and d.template_id = v_assignment.template_id
             and d.scope_kind = 'all'
             and public.work_report__internal_is_delegation_effective(d.delegation_id)
        ) then 'all'
      else 'team'
    end;
  else
    select a.acting_scope_kind, a.delegation_id
      into v_scope, v_delegation_id
      from public.work_report__internal_resolve_capability_authority(
        p_app_user_id,
        'report_assign',
        v_assignment.template_id,
        v_team_id
      ) a;
    if v_scope is null then
      raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
    end if;
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'assignment_id', p_assignment_id,
    'expected_version', p_expected_version,
    'state', p_state
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id,
    'work_report_assignment_state',
    p_idempotency_key,
    v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_assignment.version <> p_expected_version then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  update public.work_report_assignments
     set state = p_state,
         is_current = (p_state <> 'REVOKED'),
         version = version + 1,
         updated_at = now()
   where assignment_id = p_assignment_id;

  if p_state = 'REVOKED' then
    update public.work_report_obligations
       set obligation_status = 'CANCELLED',
           status_changed_by_user_id = p_app_user_id,
           version = version + 1,
           updated_at = now()
     where assignment_id = p_assignment_id
       and obligation_status = 'ACTIVE'
       and not exists (
         select 1
           from public.work_report_submissions s
          where s.obligation_id = work_report_obligations.obligation_id
            and s.first_submitted_at is not null
       );
  elsif p_state = 'ACTIVE' then
    perform public.work_report__internal_materialize_assignment_for_date(
      p_assignment_id,
      (now() at time zone 'Asia/Ho_Chi_Minh')::date
    );
  end if;

  insert into public.work_report_audit_events (
    action,
    actor_user_id,
    capability,
    scope_kind,
    scope_team_id,
    template_id,
    outcome,
    metadata_json
  )
  values (
    'ASSIGNMENT_STATE',
    p_app_user_id,
    'report_assign',
    v_scope,
    case when v_scope = 'team' then v_team_id end,
    v_assignment.template_id,
    'APPLIED',
    jsonb_build_object(
      'assignment_id', p_assignment_id,
      'state', p_state,
      'delegation_id', v_delegation_id
    )
  );

  v_result := jsonb_build_object(
    'assignment_id', p_assignment_id,
    'state', p_state,
    'version', p_expected_version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id,
    'work_report_assignment_state',
    p_idempotency_key,
    v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_set_assignment_state(uuid, uuid, uuid, integer, text, text)
  to service_role;

create or replace function public.work_report_change_obligation_status(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_obligation_id uuid,
  p_expected_version integer,
  p_action text,
  p_reason text,
  p_reopened_until timestamp with time zone,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_obligation public.work_report_obligations%rowtype;
  v_scope text;
  v_delegation_id uuid;
  v_reason_id uuid;
  v_status text;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
  v_lock_user_ids uuid[];
  v_lock_recruiter_ids uuid[];
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;
  if p_action not in ('EXEMPT', 'REOPEN') or length(btrim(coalesce(p_reason, ''))) not between 1 and 4000 then
    raise exception 'WORK_REPORT_REASON_REQUIRED' using errcode = '22023';
  end if;

  -- Tier 2 strict ASC FOR SHARE lock on actor + active report_assign grantors.
  select coalesce(pg_catalog.array_agg(distinct uid order by uid asc), array[p_app_user_id])
    into v_lock_user_ids
    from (
      select p_app_user_id as uid
      union all
      select d.grantor_user_id as uid
        from public.work_report_delegations d
       where d.delegate_app_user_id = p_app_user_id
         and d.capability = 'report_assign'
         and d.state = 'ACTIVE'
         and d.is_current
    ) u_ids
   where uid is not null;

  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = any(v_lock_user_ids)
   order by u.app_user_id asc
   for share;

  -- Tier 3 strict ASC FOR SHARE lock on verified recruiters of actor + grantors.
  select pg_catalog.array_agg(distinct l.recruiter_id order by l.recruiter_id asc)
    into v_lock_recruiter_ids
    from public.direct_entry_app_user_recruiter_links l
   where l.app_user_id = any(v_lock_user_ids)
     and l.verified
     and l.is_current;

  if coalesce(pg_catalog.cardinality(v_lock_recruiter_ids), 0) > 0 then
    perform r.recruiter_id
      from public.recruiters r
     where r.recruiter_id = any(v_lock_recruiter_ids)
     order by r.recruiter_id asc
     for share;
  end if;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, null);
  if not public.work_report__internal_has_any_capability_authority(p_app_user_id, 'report_assign') then
    raise exception 'WORK_REPORT_CAPABILITY_DENIED' using errcode = '42501';
  end if;

  select * into v_obligation
    from public.work_report_obligations
   where obligation_id = p_obligation_id
   for update;
  if not found then
    raise exception 'WORK_REPORT_OBLIGATION_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Tier WR-5 strict ASC FOR SHARE lock on active report_assign delegations for actor + template.
  perform d.delegation_id
    from public.work_report_delegations d
   where d.delegate_app_user_id = p_app_user_id
     and d.capability = 'report_assign'
     and d.template_id = v_obligation.template_id
     and d.state = 'ACTIVE'
     and d.is_current
   order by d.delegation_id asc
   for share;

  select a.acting_scope_kind, a.delegation_id
    into v_scope, v_delegation_id
    from public.work_report__internal_resolve_capability_authority(
      p_app_user_id, 'report_assign', v_obligation.template_id, v_obligation.snapshot_team_id
    ) a;
  if v_scope is null then
    raise exception 'WORK_REPORT_SCOPE_DENIED' using errcode = '42501';
  end if;
  if p_action = 'REOPEN' and (p_reopened_until is null or p_reopened_until <= now()) then
    raise exception 'WORK_REPORT_REOPEN_WINDOW_INVALID' using errcode = '22023';
  end if;

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'obligation_id', p_obligation_id,
    'expected_version', p_expected_version,
    'action', p_action,
    'reason', p_reason,
    'reopened_until', p_reopened_until
  ));
  v_prior := public.direct_entry_idempotency_begin(
    p_app_user_id, 'work_report_obligation_' || lower(p_action), p_idempotency_key, v_request_hash
  );
  if v_prior is not null then
    return v_prior;
  end if;

  if v_obligation.version <> p_expected_version then
    raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409';
  end if;

  v_reason_id := public.direct_entry_reason(p_app_user_id, btrim(p_reason));
  v_status := case when p_action = 'EXEMPT' then 'EXEMPTED' else 'ACTIVE' end;
  update public.work_report_obligations
     set obligation_status = v_status,
         reopened_until = case when p_action = 'REOPEN' then p_reopened_until else null end,
         status_changed_by_user_id = p_app_user_id,
         status_reason_id = v_reason_id,
         version = version + 1,
         updated_at = now()
   where obligation_id = p_obligation_id;

  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, scope_team_id, template_id, obligation_id, outcome, reason_id, metadata_json)
  values (
    p_action, p_app_user_id, 'report_assign', v_scope,
    case when v_scope = 'team' then v_obligation.snapshot_team_id end,
    v_obligation.template_id, p_obligation_id, 'APPLIED', v_reason_id,
    case when p_action = 'REOPEN'
      then jsonb_build_object('reopened_until', p_reopened_until, 'delegation_id', v_delegation_id)
      else jsonb_build_object('delegation_id', v_delegation_id)
    end
  );

  v_result := jsonb_build_object(
    'obligation_id', p_obligation_id,
    'status', v_status,
    'reopened_until', case when p_action = 'REOPEN' then p_reopened_until end,
    'version', p_expected_version + 1
  );
  perform public.direct_entry_idempotency_finish(
    p_app_user_id, 'work_report_obligation_' || lower(p_action), p_idempotency_key, v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.work_report_change_obligation_status(uuid, uuid, uuid, integer, text, text, timestamp with time zone, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_change_obligation_status(uuid, uuid, uuid, integer, text, text, timestamp with time zone, text)
  to service_role;

create or replace function public.work_report_create_template(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_code text,
  p_display_name text,
  p_description text,
  p_default_frequency text,
  p_schema_json jsonb,
  p_metric_contract_json jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template_id uuid;
  v_version_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  -- Tier 2 FOR SHARE lock on actor to serialize against concurrent disable / role revoke.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
   for share;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  if p_template_code is null or p_template_code !~ '^[A-Z][A-Z0-9_]{1,63}$'
     or length(btrim(coalesce(p_display_name, ''))) not between 1 and 256
     or p_default_frequency not in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')
     or not public.work_report_valid_template_schema(p_schema_json)
     or not public.work_report_valid_metric_contract(p_schema_json, p_metric_contract_json)
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_TEMPLATE_INVALID' using errcode = '22023';
  end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_code', p_template_code, 'display_name', p_display_name,
    'description', p_description, 'default_frequency', p_default_frequency,
    'schema_json', p_schema_json, 'metric_contract_json', p_metric_contract_json
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_template_create', p_idempotency_key, v_request_hash);
  if v_prior is not null then return v_prior; end if;
  insert into public.work_report_templates
    (template_code, display_name, description, default_frequency, created_by_user_id)
  values
    (p_template_code, btrim(p_display_name), nullif(btrim(p_description), ''), p_default_frequency, p_app_user_id)
  returning template_id into v_template_id;
  insert into public.work_report_template_versions
    (template_id, version_no, schema_json, metric_contract_json, schema_checksum)
  values
    (v_template_id, 1, p_schema_json, p_metric_contract_json,
     encode(sha256(convert_to(p_schema_json::text, 'UTF8')), 'hex'))
  returning version_id into v_version_id;
  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, template_id, outcome, metadata_json)
  values ('TEMPLATE_CREATE', p_app_user_id, 'report_form_manage', 'all', v_template_id, 'APPLIED',
    jsonb_build_object('version_id', v_version_id));
  v_result := jsonb_build_object('template_id', v_template_id, 'draft_version_id', v_version_id, 'version', 1);
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_template_create', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

revoke all on function public.work_report_create_template(uuid, uuid, text, text, text, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_create_template(uuid, uuid, text, text, text, text, jsonb, jsonb, text)
  to service_role;

create or replace function public.work_report_update_template_draft(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_draft_version_id uuid,
  p_expected_version integer,
  p_display_name text,
  p_description text,
  p_default_frequency text,
  p_schema_json jsonb,
  p_metric_contract_json jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  -- Tier 2 FOR SHARE lock on actor to serialize against concurrent disable / role revoke.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
   for share;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  if p_expected_version is null or p_expected_version < 1
     or length(btrim(coalesce(p_display_name, ''))) not between 1 and 256
     or p_default_frequency not in ('DAILY', 'WEEKLY', 'MONTHLY', 'ONCE')
     or not public.work_report_valid_template_schema(p_schema_json)
     or not public.work_report_valid_metric_contract(p_schema_json, p_metric_contract_json)
     or length(coalesce(p_idempotency_key, '')) not between 1 and 128 then
    raise exception 'WORK_REPORT_TEMPLATE_INVALID' using errcode = '22023';
  end if;
  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id', p_template_id, 'draft_version_id', p_draft_version_id,
    'expected_version', p_expected_version, 'display_name', p_display_name,
    'description', p_description, 'default_frequency', p_default_frequency,
    'schema_json', p_schema_json, 'metric_contract_json', p_metric_contract_json
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_template_update', p_idempotency_key, v_request_hash);
  if v_prior is not null then return v_prior; end if;
  update public.work_report_templates
     set display_name = btrim(p_display_name), description = nullif(btrim(p_description), ''),
         default_frequency = p_default_frequency, version = version + 1, updated_at = now()
   where template_id = p_template_id and version = p_expected_version and status <> 'ARCHIVED';
  if not found then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409'; end if;
  update public.work_report_template_versions
     set schema_json = p_schema_json, metric_contract_json = p_metric_contract_json,
         schema_checksum = encode(sha256(convert_to(p_schema_json::text, 'UTF8')), 'hex'), updated_at = now()
   where version_id = p_draft_version_id and template_id = p_template_id and status = 'DRAFT';
  if not found then raise exception 'WORK_REPORT_DRAFT_NOT_FOUND' using errcode = 'P0002'; end if;
  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, template_id, outcome, metadata_json)
  values ('TEMPLATE_DRAFT_UPDATE', p_app_user_id, 'report_form_manage', 'all', p_template_id, 'APPLIED',
    jsonb_build_object('version_id', p_draft_version_id));
  v_result := jsonb_build_object('template_id', p_template_id, 'draft_version_id', p_draft_version_id,
    'version', p_expected_version + 1);
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_template_update', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

revoke all on function public.work_report_update_template_draft(uuid, uuid, uuid, uuid, integer, text, text, text, jsonb, jsonb, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_update_template_draft(uuid, uuid, uuid, uuid, integer, text, text, text, jsonb, jsonb, text)
  to service_role;

create or replace function public.work_report_publish_template(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_draft_version_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  -- Tier 2 FOR SHARE lock on actor to serialize against concurrent disable / role revoke.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
   for share;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object(
    'template_id', p_template_id, 'draft_version_id', p_draft_version_id, 'expected_version', p_expected_version
  ));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_template_publish', p_idempotency_key, v_request_hash);
  if v_prior is not null then return v_prior; end if;
  select * into v_template from public.work_report_templates where template_id = p_template_id for update;
  if not found then raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_template.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409'; end if;
  if v_template.status = 'ARCHIVED' then raise exception 'WORK_REPORT_TEMPLATE_ARCHIVED' using errcode = '22023'; end if;
  update public.work_report_template_versions
     set status = 'ARCHIVED', updated_at = now()
   where version_id = v_template.current_published_version_id and status = 'PUBLISHED';
  update public.work_report_template_versions
     set status = 'PUBLISHED', published_by_user_id = p_app_user_id, published_at = now(), updated_at = now()
   where version_id = p_draft_version_id and template_id = p_template_id and status = 'DRAFT';
  if not found then raise exception 'WORK_REPORT_DRAFT_NOT_FOUND' using errcode = 'P0002'; end if;
  update public.work_report_templates
     set status = 'ACTIVE', current_published_version_id = p_draft_version_id,
         version = version + 1, updated_at = now()
   where template_id = p_template_id;
  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, template_id, outcome, metadata_json)
  values ('TEMPLATE_PUBLISH', p_app_user_id, 'report_form_manage', 'all', p_template_id, 'APPLIED',
    jsonb_build_object('version_id', p_draft_version_id));
  v_result := jsonb_build_object('template_id', p_template_id, 'published_version_id', p_draft_version_id,
    'version', p_expected_version + 1);
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_template_publish', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

revoke all on function public.work_report_publish_template(uuid, uuid, uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_publish_template(uuid, uuid, uuid, uuid, integer, text)
  to service_role;

create or replace function public.work_report_archive_template(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  -- Tier 2 FOR SHARE lock on actor to serialize against concurrent disable / role revoke.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
   for share;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('template_id', p_template_id, 'expected_version', p_expected_version));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_template_archive', p_idempotency_key, v_request_hash);
  if v_prior is not null then return v_prior; end if;
  update public.work_report_templates
     set status = 'ARCHIVED', version = version + 1, updated_at = now()
   where template_id = p_template_id and version = p_expected_version and status <> 'ARCHIVED';
  if not found then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409'; end if;
  update public.work_report_assignments
     set state = 'REVOKED', is_current = false, version = version + 1, updated_at = now()
   where template_id = p_template_id and is_current;
  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, template_id, outcome)
  values ('TEMPLATE_ARCHIVE', p_app_user_id, 'report_form_manage', 'all', p_template_id, 'APPLIED');
  v_result := jsonb_build_object('template_id', p_template_id, 'status', 'ARCHIVED', 'version', p_expected_version + 1);
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_template_archive', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

revoke all on function public.work_report_archive_template(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_archive_template(uuid, uuid, uuid, integer, text)
  to service_role;

create or replace function public.work_report_clone_template_draft(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_template_id uuid,
  p_expected_version integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_template public.work_report_templates%rowtype;
  v_source public.work_report_template_versions%rowtype;
  v_version_id uuid;
  v_request_hash text;
  v_prior jsonb;
  v_result jsonb;
begin
  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  -- Tier 2 FOR SHARE lock on actor to serialize against concurrent disable / role revoke.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
   for share;

  perform public.work_report_assert_actor(p_auth_subject, p_app_user_id, 'report_form_manage');
  perform public.work_report_assert_scope(p_app_user_id, 'report_form_manage', null, true);

  v_request_hash := public.direct_entry_payload_hash(jsonb_build_object('template_id', p_template_id, 'expected_version', p_expected_version));
  v_prior := public.direct_entry_idempotency_begin(p_app_user_id, 'work_report_template_clone', p_idempotency_key, v_request_hash);
  if v_prior is not null then return v_prior; end if;
  select * into v_template from public.work_report_templates where template_id = p_template_id for update;
  if not found then raise exception 'WORK_REPORT_TEMPLATE_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_template.version <> p_expected_version then raise exception 'WORK_REPORT_VERSION_CONFLICT' using errcode = 'PT409'; end if;
  if v_template.status = 'ARCHIVED' or v_template.current_published_version_id is null then
    raise exception 'WORK_REPORT_TEMPLATE_NOT_PUBLISHED' using errcode = '22023';
  end if;
  if exists (select 1 from public.work_report_template_versions where template_id = p_template_id and status = 'DRAFT') then
    raise exception 'WORK_REPORT_DRAFT_EXISTS' using errcode = '23505';
  end if;
  select * into v_source from public.work_report_template_versions
   where version_id = v_template.current_published_version_id;
  insert into public.work_report_template_versions
    (template_id, version_no, schema_json, metric_contract_json, schema_checksum, requires_review)
  values
    (p_template_id, v_source.version_no + 1, v_source.schema_json, v_source.metric_contract_json,
     v_source.schema_checksum, v_source.requires_review)
  returning version_id into v_version_id;
  update public.work_report_templates set version = version + 1, updated_at = now() where template_id = p_template_id;
  v_result := jsonb_build_object('template_id', p_template_id, 'draft_version_id', v_version_id,
    'version', p_expected_version + 1);
  insert into public.work_report_audit_events
    (action, actor_user_id, capability, scope_kind, template_id, outcome, metadata_json)
  values ('TEMPLATE_DRAFT_CLONE', p_app_user_id, 'report_form_manage', 'all', p_template_id, 'APPLIED',
    jsonb_build_object('version_id', v_version_id));
  perform public.direct_entry_idempotency_finish(p_app_user_id, 'work_report_template_clone', p_idempotency_key, v_result);
  return v_result;
end;
$function$;

revoke all on function public.work_report_clone_template_draft(uuid, uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.work_report_clone_template_draft(uuid, uuid, uuid, integer, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 6. Guarded Owner Alignment ($align_wp8d2$)
-- -----------------------------------------------------------------------------
do $align_wp8d2$
declare
  v_base_owner_oid oid;
  v_base_owner text;
  v_can_set_owner boolean := false;
  v_sig text;
  v_proc_owner_oid oid;
  v_sigs text[] := array[
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
    'public.work_report__internal_is_full_admin(uuid)',
    'public.work_report__internal_has_direct_capability(uuid,text)',
    'public.work_report__internal_has_direct_scope(uuid,text,text,uuid)',
    'public.work_report__internal_direct_team_ids(uuid,text)',
    'public.work_report_assert_actor(uuid,uuid,text)',
    'public.work_report_assert_scope(uuid,text,uuid,boolean)',
    'public.work_report__internal_is_delegation_effective(uuid,timestamptz)',
    'public.work_report__internal_resolve_capability_authority(uuid,text,uuid,uuid,timestamptz)',
    'public.work_report__internal_has_any_capability_authority(uuid,text,timestamptz)',
    'public.work_report__internal_actor_can_assign_member(uuid,uuid,uuid)',
    'public.work_report__internal_resolve_analytics_scope(uuid,uuid,boolean,uuid,uuid,uuid)',
    'public.direct_entry_resolve_actor_context(uuid)',
    'public.work_report_get_submission(uuid,uuid,uuid)',
    'public.work_report_list_readable_submissions(uuid,uuid,uuid,uuid,date,date,uuid,uuid,text,text,integer)',
    'public.work_report_list_groups(uuid,uuid)',
    'public.work_report_list_assignment_options(uuid,uuid,uuid)',
    'public.work_report_list_assignments(uuid,uuid,uuid)',
    'public.work_report_list_delegations(uuid,uuid)',
    'public.work_report_list_pending_reviews(uuid,uuid,uuid,text,integer)',
    'public.work_report_get_review_submission(uuid,uuid,uuid)',
    'public.work_report_create_group(uuid,uuid,text,text,uuid[],text)',
    'public.work_report_update_group(uuid,uuid,uuid,integer,text,text,uuid[],text)',
    'public.work_report_set_group_active(uuid,uuid,uuid,integer,boolean,text)',
    'public.work_report_ensure_obligations_for_window(uuid,uuid,date)',
    'public.work_report_create_delegation(uuid,uuid,text,uuid,uuid,text,uuid,timestamptz,timestamptz,text)',
    'public.work_report_revoke_delegation(uuid,uuid,uuid,integer,text)',
    'public.work_report_decide_review(uuid,uuid,uuid,text,text,integer,text)',
    'public.work_report_create_assignment(uuid,uuid,uuid,text,uuid,uuid,uuid[],text,boolean,integer,time without time zone,boolean,date,date,text)',
    'public.work_report_create_group_assignment(uuid,uuid,uuid,uuid,text,boolean,integer,time without time zone,boolean,date,date,text)',
    'public.work_report_set_assignment_state(uuid,uuid,uuid,integer,text,text)',
    'public.work_report_change_obligation_status(uuid,uuid,uuid,integer,text,text,timestamptz,text)',
    'public.work_report_create_template(uuid,uuid,text,text,text,text,jsonb,jsonb,text)',
    'public.work_report_update_template_draft(uuid,uuid,uuid,uuid,integer,text,text,text,jsonb,jsonb,text)',
    'public.work_report_publish_template(uuid,uuid,uuid,uuid,integer,text)',
    'public.work_report_archive_template(uuid,uuid,uuid,integer,text)',
    'public.work_report_clone_template_draft(uuid,uuid,uuid,integer,text)'
  ];
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner_oid is null then
    raise exception 'WP8D2_ALIGN_BASE_OWNER_MISSING' using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_sigs loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = v_sig::pg_catalog.regprocedure;

    if v_proc_owner_oid is null then
      raise exception 'WP8D2_ALIGN_FUNCTION_MISSING: %', v_sig using errcode = '55000';
    end if;

    if v_proc_owner_oid <> v_base_owner_oid and v_can_set_owner then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
  end loop;
end
$align_wp8d2$;

-- -----------------------------------------------------------------------------
-- 7. Fail-Closed Security, Volatility, Overload, Role Catalog & ACL Self-Check ($check_wp8d2$)
-- -----------------------------------------------------------------------------
do $check_wp8d2$
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
  v_admin_cap_cnt integer;
  v_admin_excluded_cnt integer;
  v_tl_cap_cnt integer;
  v_stable_internal_fns text[] := array[
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
    'public.work_report__internal_is_full_admin(uuid)',
    'public.work_report__internal_has_direct_capability(uuid,text)',
    'public.work_report__internal_has_direct_scope(uuid,text,text,uuid)',
    'public.work_report__internal_direct_team_ids(uuid,text)',
    'public.work_report_assert_actor(uuid,uuid,text)',
    'public.work_report_assert_scope(uuid,text,uuid,boolean)',
    'public.work_report__internal_is_delegation_effective(uuid,timestamptz)',
    'public.work_report__internal_resolve_capability_authority(uuid,text,uuid,uuid,timestamptz)',
    'public.work_report__internal_has_any_capability_authority(uuid,text,timestamptz)',
    'public.work_report__internal_actor_can_assign_member(uuid,uuid,uuid)',
    'public.work_report__internal_resolve_analytics_scope(uuid,uuid,boolean,uuid,uuid,uuid)'
  ];
  v_stable_service_rpcs text[] := array[
    'public.direct_entry_resolve_actor_context(uuid)',
    'public.work_report_get_submission(uuid,uuid,uuid)',
    'public.work_report_list_readable_submissions(uuid,uuid,uuid,uuid,date,date,uuid,uuid,text,text,integer)',
    'public.work_report_list_groups(uuid,uuid)',
    'public.work_report_list_assignment_options(uuid,uuid,uuid)',
    'public.work_report_list_assignments(uuid,uuid,uuid)',
    'public.work_report_list_delegations(uuid,uuid)',
    'public.work_report_list_pending_reviews(uuid,uuid,uuid,text,integer)',
    'public.work_report_get_review_submission(uuid,uuid,uuid)'
  ];
  v_volatile_service_rpcs text[] := array[
    'public.work_report_create_group(uuid,uuid,text,text,uuid[],text)',
    'public.work_report_update_group(uuid,uuid,uuid,integer,text,text,uuid[],text)',
    'public.work_report_set_group_active(uuid,uuid,uuid,integer,boolean,text)',
    'public.work_report_ensure_obligations_for_window(uuid,uuid,date)',
    'public.work_report_create_delegation(uuid,uuid,text,uuid,uuid,text,uuid,timestamptz,timestamptz,text)',
    'public.work_report_revoke_delegation(uuid,uuid,uuid,integer,text)',
    'public.work_report_decide_review(uuid,uuid,uuid,text,text,integer,text)',
    'public.work_report_create_assignment(uuid,uuid,uuid,text,uuid,uuid,uuid[],text,boolean,integer,time without time zone,boolean,date,date,text)',
    'public.work_report_create_group_assignment(uuid,uuid,uuid,uuid,text,boolean,integer,time without time zone,boolean,date,date,text)',
    'public.work_report_set_assignment_state(uuid,uuid,uuid,integer,text,text)',
    'public.work_report_change_obligation_status(uuid,uuid,uuid,integer,text,text,timestamptz,text)',
    'public.work_report_create_template(uuid,uuid,text,text,text,text,jsonb,jsonb,text)',
    'public.work_report_update_template_draft(uuid,uuid,uuid,uuid,integer,text,text,text,jsonb,jsonb,text)',
    'public.work_report_publish_template(uuid,uuid,uuid,uuid,integer,text)',
    'public.work_report_archive_template(uuid,uuid,uuid,integer,text)',
    'public.work_report_clone_template_draft(uuid,uuid,uuid,integer,text)'
  ];
  v_fn_names text[] := array[
    'direct_entry_authz__internal_resolve_effective_grants',
    'work_report__internal_is_full_admin',
    'work_report__internal_has_direct_capability',
    'work_report__internal_has_direct_scope',
    'work_report__internal_direct_team_ids',
    'work_report_assert_actor',
    'work_report_assert_scope',
    'work_report__internal_is_delegation_effective',
    'work_report__internal_resolve_capability_authority',
    'work_report__internal_has_any_capability_authority',
    'work_report__internal_actor_can_assign_member',
    'work_report__internal_resolve_analytics_scope',
    'direct_entry_resolve_actor_context',
    'work_report_get_submission',
    'work_report_list_readable_submissions',
    'work_report_list_groups',
    'work_report_list_assignment_options',
    'work_report_list_assignments',
    'work_report_list_delegations',
    'work_report_list_pending_reviews',
    'work_report_get_review_submission',
    'work_report_create_group',
    'work_report_update_group',
    'work_report_set_group_active',
    'work_report_ensure_obligations_for_window',
    'work_report_create_delegation',
    'work_report_revoke_delegation',
    'work_report_decide_review',
    'work_report_create_assignment',
    'work_report_create_group_assignment',
    'work_report_set_assignment_state',
    'work_report_change_obligation_status',
    'work_report_create_template',
    'work_report_update_template_draft',
    'work_report_publish_template',
    'work_report_archive_template',
    'work_report_clone_template_draft'
  ];
  v_probe_chain_stable text[] := array[
    'public.work_report_has_active_obligations(uuid,uuid)',
    'public.work_report__internal_has_active_obligations_for_date(uuid,date,integer)',
    'public.work_report__internal_actor_materialization_candidates(uuid,date,integer)',
    'public.work_report__internal_actor_can_assign_member(uuid,uuid,uuid)',
    'public.work_report__internal_resolve_capability_authority(uuid,text,uuid,uuid,timestamptz)',
    'public.work_report__internal_has_direct_scope(uuid,text,text,uuid)',
    'public.work_report__internal_is_full_admin(uuid)',
    'public.work_report__internal_is_delegation_effective(uuid,timestamptz)',
    'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)',
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)'
  ];
  v_internal_deps text[] := array[
    'public.direct_entry_authz__internal_resolve_effective_grants(uuid)',
    'public.direct_entry_authz__internal_has_paired_capability(uuid,text,text,text)',
    'public.direct_entry__internal_team_leader_assignment_effective(uuid,date)',
    'public.direct_entry__internal_team_scope_grant_effective(uuid,date)',
    'public.direct_entry__internal_capability_grant_effective(uuid,date)',
    'public.direct_entry_assert_team_leader_current_team(uuid,uuid,uuid)',
    'public.direct_entry_actor_has_project_assignment(uuid)',
    'public.direct_entry_actor_is_assigned_project_manager(uuid,text)',
    'public.work_report__internal_is_full_admin(uuid)',
    'public.work_report__internal_has_direct_capability(uuid,text)',
    'public.work_report__internal_has_direct_scope(uuid,text,text,uuid)',
    'public.work_report__internal_direct_team_ids(uuid,text)',
    'public.work_report_assert_actor(uuid,uuid,text)',
    'public.work_report_assert_scope(uuid,text,uuid,boolean)',
    'public.work_report__internal_is_delegation_effective(uuid,timestamptz)',
    'public.work_report__internal_resolve_capability_authority(uuid,text,uuid,uuid,timestamptz)',
    'public.work_report__internal_has_any_capability_authority(uuid,text,timestamptz)',
    'public.work_report__internal_actor_can_assign_member(uuid,uuid,uuid)',
    'public.work_report__internal_resolve_analytics_scope(uuid,uuid,boolean,uuid,uuid,uuid)',
    'public.work_report__internal_user_display_name(uuid)'
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
      raise exception 'WP8D2_CHECK_OVERLOAD_COUNT_FAILED: % (count=%)', v_name, v_overload_cnt
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_stable_internal_fns loop
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
       or v_volatile <> 's'
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP8D2_CHECK_INTERNAL_DEF_FAILED: %', v_sig using errcode = '55000';
    end if;

    foreach v_dep_sig in array v_internal_deps loop
      v_dep_oid := v_dep_sig::pg_catalog.regprocedure;
      if not pg_catalog.has_function_privilege(v_owner_oid, v_dep_oid, 'EXECUTE') then
        raise exception 'WP8D2_CHECK_OWNER_CALLEE_EXEC_FAILED: % -> %', v_sig, v_dep_sig
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
      raise exception 'WP8D2_CHECK_INTERNAL_ACL_EXPOSED: % (% grants)', v_sig, v_exposed
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array (v_stable_service_rpcs || v_volatile_service_rpcs) loop
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
       or (v_sig = any(v_stable_service_rpcs) and v_volatile <> 's')
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP8D2_CHECK_SERVICE_RPC_DEF_FAILED: %', v_sig using errcode = '55000';
    end if;

    foreach v_dep_sig in array v_internal_deps loop
      v_dep_oid := v_dep_sig::pg_catalog.regprocedure;
      if not pg_catalog.has_function_privilege(v_owner_oid, v_dep_oid, 'EXECUTE') then
        raise exception 'WP8D2_CHECK_RPC_OWNER_CALLEE_EXEC_FAILED: % -> %', v_sig, v_dep_sig
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
      raise exception 'WP8D2_CHECK_SERVICE_RPC_ACL_EXPOSED: % (% grants)', v_sig, v_exposed
        using errcode = '55000';
    end if;
  end loop;

  foreach v_sig in array v_probe_chain_stable loop
    v_oid := v_sig::pg_catalog.regprocedure;
    select p.provolatile into v_volatile from pg_catalog.pg_proc p where p.oid = v_oid;
    if v_volatile is distinct from 's' then
      raise exception 'WP8D2_CHECK_PROBE_CHAIN_NOT_STABLE: % (provolatile=%)', v_sig, v_volatile
        using errcode = '55000';
    end if;
  end loop;

  select count(*)::integer,
         count(*) filter (
           where rc.capability in (
             'catalog_master_manage', 'team_manager_assign',
             'report_form_manage', 'report_assign', 'report_review', 'report_delegate',
             'vendor_finance_view', 'vendor_finance_record'
           )
         )::integer
    into v_admin_cap_cnt, v_admin_excluded_cnt
    from public.authz_role_capabilities rc
   where rc.role_code = 'ADMIN';

  select count(*)::integer
    into v_tl_cap_cnt
    from public.authz_role_capabilities rc
   where rc.role_code = 'TEAM_LEADER';

  if v_admin_cap_cnt <> 21 or v_admin_excluded_cnt <> 0 or v_tl_cap_cnt <> 5 then
    raise exception 'WP8D2_CHECK_ROLE_CATALOG_DRIFT: admin=% excluded=% tl=%',
      v_admin_cap_cnt, v_admin_excluded_cnt, v_tl_cap_cnt
      using errcode = '55000';
  end if;
end
$check_wp8d2$;

commit;
