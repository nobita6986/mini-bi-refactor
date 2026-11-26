-- =============================================================================
-- WP10-7 Slice 3A: Retire legacy rollover branch from
-- public.direct_entry__internal_team_leader_assignment_effective(uuid, date)
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. Fail-closed preflight DO $$ block BEFORE replacing the function:
--      Block if ANY row in public.direct_entry_team_leader_assignments (joined
--      with active non-system team, enabled app_user, active recruiter,
--      not is_current, not suspended_by_account_disable, valid_from <= today,
--      valid interval (valid_to is null or valid_to > valid_from)) would
--      change effective status between pre-3A (old_effective) and post-3A
--      (new_effective) at any date.
--      Specifically, block only rows that have designate/replace provenance
--      (direct_entry_team_leader_revisions.action in ('designate', 'replace'))
--      AND:
--        - Case A (old=true -> new=false): unclosed or still-active rollover row
--          at today (valid_to is null or valid_to > today) that also has the
--          legacy grant pair (scope_grants + capability_grants).
--        - Case B (old=false -> new=true): closed historical assignment
--          (valid_to is not null and valid_to <= today) missing the legacy
--          grant pair (previously hidden on historical dates).
--      Assignments without designate/replace provenance (such as legacy
--      'transition' rows) and valid closed historical designate/replace
--      assignments with the legacy grant pair keep the same effective status
--      on every date and are NOT blocked.
--   2. CREATE OR REPLACE FUNCTION
--      public.direct_entry__internal_team_leader_assignment_effective(uuid, date)
--      preserving all non-rollover guards and closed-historical validity
--      (p_as_of < authorization_date and valid_to is not null and
--      valid_to <= authorization_date and designate/replace revision
--      provenance in direct_entry_team_leader_revisions), while removing
--      ALL reads of direct_entry_scope_grants and direct_entry_capability_grants.
--   3. Preserve exact ACL:
--      REVOKE ALL ... FROM public, anon, authenticated, service_role.
--   4. Owner alignment + fail-closed postcheck verification.
-- =============================================================================

begin;

do $wp10_7_3a_preflight$
declare
  v_today date := public.direct_entry_authorization_date();
  v_blocked_count integer := 0;
  v_sample record;
begin
  with candidate_assignments as (
    select a.assignment_id,
           a.team_id,
           a.leader_app_user_id,
           a.valid_from,
           a.valid_to,
           (
             exists (
               select 1
                 from public.direct_entry_scope_grants s
                where s.app_user_id = a.leader_app_user_id
                  and s.scope_kind = 'team'
                  and s.team_id = a.team_id
                  and s.valid_from <= a.valid_from
                  and s.valid_to is not distinct from a.valid_to
                  and (s.valid_to is null or s.valid_to > s.valid_from)
                  and not s.is_current
                  and not s.suspended_by_account_disable
             )
             and exists (
               select 1
                 from public.direct_entry_capability_grants g
                where g.app_user_id = a.leader_app_user_id
                  and g.capability = 'team_manager_assign'
                  and g.valid_from = a.valid_from
                  and g.valid_to is not distinct from a.valid_to
                  and (g.valid_to is null or g.valid_to > g.valid_from)
                  and not g.is_current
                  and not g.suspended_by_account_disable
             )
           ) as has_legacy_grant_pair,
           exists (
             select 1
               from public.direct_entry_team_leader_revisions rev
              where rev.team_id = a.team_id
                and rev.action in ('designate', 'replace')
                and rev.after_snapshot->>'leader_app_user_id' = a.leader_app_user_id::text
                and rev.after_snapshot->>'valid_from' = a.valid_from::text
           ) as has_designate_or_replace_revision
      from public.direct_entry_team_leader_assignments a
      join public.teams t
        on t.team_id = a.team_id
       and t.active
       and t.code <> '__system_vendor__'
      join public.direct_entry_app_users u
        on u.app_user_id = a.leader_app_user_id
       and u.enabled
      join public.recruiters r
        on r.recruiter_id = a.leader_recruiter_id
       and r.active
     where not a.is_current
       and not a.suspended_by_account_disable
       and a.valid_from <= v_today
       and (a.valid_to is null or a.valid_to > a.valid_from)
  ),
  blocked_assignments as (
    select c.assignment_id,
           c.team_id,
           c.leader_app_user_id,
           c.valid_from,
           c.valid_to
      from candidate_assignments c
     where c.has_designate_or_replace_revision
       and (
             (
               (c.valid_to is null or c.valid_to > v_today)
               and c.has_legacy_grant_pair
             )
             or (
               c.valid_to is not null
               and c.valid_to <= v_today
               and not c.has_legacy_grant_pair
             )
           )
  )
  select count(*) over ()::integer as blocked_count,
         b.assignment_id,
         b.team_id,
         b.leader_app_user_id,
         b.valid_from,
         b.valid_to
    into v_sample
    from blocked_assignments b
   order by b.valid_from desc, b.assignment_id asc
   limit 1;

  if found then
    v_blocked_count := v_sample.blocked_count;
    raise exception 'WP10_7_3A_PREFLIGHT_BLOCKED: % team leader assignment(s) would change effective status (sample assignment_id=%, team_id=%, leader_app_user_id=%, valid_from=%, valid_to=%)',
      v_blocked_count,
      v_sample.assignment_id,
      v_sample.team_id,
      v_sample.leader_app_user_id,
      v_sample.valid_from,
      v_sample.valid_to
      using errcode = 'P0001';
  end if;
end
$wp10_7_3a_preflight$;

create or replace function public.direct_entry__internal_team_leader_assignment_effective(
  p_assignment_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select exists (
    select 1
      from public.direct_entry_team_leader_assignments a
      join public.teams t
        on t.team_id = a.team_id
       and t.active
       and t.code <> '__system_vendor__'
      join public.direct_entry_app_users u
        on u.app_user_id = a.leader_app_user_id
       and u.enabled
      join public.recruiters r
        on r.recruiter_id = a.leader_recruiter_id
       and r.active
     where a.assignment_id = p_assignment_id
       and not a.suspended_by_account_disable
       and a.valid_from <= p_as_of
       and (a.valid_to is null or p_as_of < a.valid_to)
       and (a.valid_to is null or a.valid_to > a.valid_from)
       and (
         a.is_current
         or p_as_of > public.direct_entry_authorization_date()
         or (
           p_as_of < public.direct_entry_authorization_date()
           and a.valid_to is not null
           and a.valid_to <= public.direct_entry_authorization_date()
           and exists (
             select 1
               from public.direct_entry_team_leader_revisions rev
              where rev.team_id = a.team_id
                and rev.action in ('designate', 'replace')
                and rev.after_snapshot->>'leader_app_user_id' = a.leader_app_user_id::text
                and rev.after_snapshot->>'valid_from' = a.valid_from::text
           )
         )
       )
  )
$function$;

revoke all on function public.direct_entry__internal_team_leader_assignment_effective(uuid, date)
  from public, anon, authenticated, service_role;

do $wp10_7_3a_postcheck$
declare
  v_fn_sig constant text := 'public.direct_entry__internal_team_leader_assignment_effective(uuid, date)';
  v_overload_count integer := 0;
  v_oid oid;
  v_base_owner_oid oid;
  v_base_owner text;
  v_can_set_owner boolean := false;
  v_rec record;
begin
  select count(*)::integer
    into v_overload_count
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'direct_entry__internal_team_leader_assignment_effective';

  if v_overload_count <> 1 then
    raise exception 'WP10-7-3A postcheck failed: expected single overload for direct_entry__internal_team_leader_assignment_effective, found %',
      v_overload_count
      using errcode = '55000';
  end if;

  v_oid := pg_catalog.to_regprocedure(v_fn_sig);
  if v_oid is null then
    raise exception 'WP10-7-3A postcheck failed: missing function %', v_fn_sig
      using errcode = '55000';
  end if;

  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner is null then
    raise exception 'WP10-7-3A postcheck failed: unable to resolve base owner'
      using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  select p.proowner, p.prosecdef, p.provolatile, p.proconfig, p.prosrc
    into v_rec
    from pg_catalog.pg_proc p
   where p.oid = v_oid;

  if v_can_set_owner and v_rec.proowner is distinct from v_base_owner_oid then
    execute pg_catalog.format('alter function %s owner to %I', v_fn_sig, v_base_owner);
    select p.proowner, p.prosecdef, p.provolatile, p.proconfig, p.prosrc
      into v_rec
      from pg_catalog.pg_proc p
     where p.oid = v_oid;
  end if;

  if not coalesce(v_rec.prosecdef, false)
     or v_rec.provolatile <> 's'
     or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
    raise exception 'WP10-7-3A postcheck failed: function metadata invalid on %', v_fn_sig
      using errcode = '55000';
  end if;

  if v_rec.prosrc ~* '(direct_entry_scope_grants|direct_entry_capability_grants)' then
    raise exception 'WP10-7-3A postcheck failed: legacy grant table reference remains in %', v_fn_sig
      using errcode = '55000';
  end if;

  if not (v_rec.prosrc ~* 'direct_entry_team_leader_revisions') then
    raise exception 'WP10-7-3A postcheck failed: missing team leader revision provenance check in %', v_fn_sig
      using errcode = '55000';
  end if;

  if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
     or not pg_catalog.has_function_privilege(v_rec.proowner, v_oid, 'EXECUTE') then
    raise exception 'WP10-7-3A postcheck failed: invalid EXECUTE ACL on %', v_fn_sig
      using errcode = '55000';
  end if;
end
$wp10_7_3a_postcheck$;

commit;
