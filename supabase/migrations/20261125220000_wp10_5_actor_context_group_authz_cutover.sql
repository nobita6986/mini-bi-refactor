-- =============================================================================
-- WP10-5: Cut Over Actor Session Context (direct_entry_resolve_actor_context)
--         for Group-Authz Managed Accounts Exclusively to Effective Grants
--
-- Scope (100% forward migration; zero historical migration edits):
--   1. public.direct_entry_resolve_actor_context(uuid):
--      - Keep exact RPC signature, STABLE SECURITY DEFINER, locked search_path,
--        service_role-only EXECUTE ACL, and 12/13-key JSON contract
--        (assigned_roles, effective_report_review_scopes, allowed_worker_tabs,
--        effective_grants, internal v_team_leader_team_id).
--      - When not v_enabled: return empty arrays ('[]'::jsonb) for
--        capabilities, recruiter_links, teams, team_scope_grants,
--        all_scope_grants, allowed_worker_tabs, effective_grants,
--        assigned_roles (and empty v_review_scopes / null v_team_leader_team_id)
--        without reading legacy grant tables.
--      - When v_enabled and v_authz_managed: derive capabilities, teams,
--        team_scope_grants, and all_scope_grants strictly from valid paired
--        entries in v_effective_grants matching PAIRED_CAPABILITY_ALLOWED_SCOPE_KINDS
--        (e.g. excluding vendor_finance_view @ CONTEXT_PROJECT), deduplicating
--        teams and team_scope_grants by active non-vendor team_id and capping
--        all_scope_grants at 1 row { valid_from: v_today::text, valid_to: null },
--        with zero reads of direct_entry_capability_grants or
--        direct_entry_scope_grants.
--      - When v_enabled and not v_authz_managed: preserve the legacy grant read
--        path so unmigrated accounts continue working unchanged.
--   2. Preserve legacy tables (direct_entry_capability_grants,
--      direct_entry_scope_grants) and mirror/sync helpers intact for rollback.
--   3. Align owner, REVOKE/GRANT ACLs, SECURITY DEFINER, search_path, and
--      stability in an idempotent self-check block.
-- =============================================================================

begin;

CREATE OR REPLACE FUNCTION public.direct_entry_resolve_actor_context(p_auth_subject uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
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

  if v_enabled then
    v_effective_grants := public.direct_entry_authz__internal_resolve_effective_grants(v_app_user_id);

    if v_authz_managed then
      -- Derive legacy session fields strictly from valid paired effective grants
      -- matching PAIRED_CAPABILITY_ALLOWED_SCOPE_KINDS (never legacy grant tables).
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
              'worker_edit_history_view'
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
    else
      select
        coalesce((
          select pg_catalog.jsonb_agg(distinct g.capability order by g.capability)
            from public.direct_entry_capability_grants g
           where g.app_user_id = v_app_user_id
             and public.direct_entry__internal_capability_grant_effective(g.grant_id)
        ), '[]'::jsonb),
        coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'team_id', t.team_id,
              'code', t.code,
              'display', t.display_name,
              'active', t.active
            )
            order by t.team_id
          )
            from public.teams t
           where t.active
             and exists (
               select 1
                 from public.direct_entry_scope_grants g
                where g.app_user_id = v_app_user_id
                  and g.scope_kind = 'team'
                  and g.team_id = t.team_id
                  and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
             )
        ), '[]'::jsonb),
        coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'team_id', g.team_id,
              'valid_from', g.valid_from,
              'valid_to', g.valid_to
            )
            order by g.valid_from, g.team_id
          )
            from public.direct_entry_scope_grants g
            join public.teams t
              on t.team_id = g.team_id
             and t.active
           where g.app_user_id = v_app_user_id
             and g.scope_kind = 'team'
             and public.direct_entry__internal_team_scope_grant_effective(g.grant_id)
        ), '[]'::jsonb),
        coalesce((
          select pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'valid_from', g.valid_from,
              'valid_to', g.valid_to
            )
            order by g.valid_from
          )
            from public.direct_entry_scope_grants g
           where g.app_user_id = v_app_user_id
             and g.scope_kind = 'all'
             and g.is_current
        ), '[]'::jsonb)
      into v_capabilities, v_teams, v_team_scope_grants, v_all_scope_grants;
    end if;

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

    if v_authz_managed then
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

do $align_and_check_wp10_5$
declare
  v_sig text := 'public.direct_entry_resolve_actor_context(uuid)';
  v_oid oid;
  v_proc_owner oid;
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean := false;
  v_rec record;
  v_overloads integer := 0;
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner is null or v_base_owner_oid is null then
    raise exception 'WP10-5 alignment failed: base owner missing' using errcode = '55000';
  end if;

  if pg_catalog.to_regclass('public.direct_entry_capability_grants') is null
     or pg_catalog.to_regclass('public.direct_entry_scope_grants') is null then
    raise exception 'WP10-5 check failed: legacy grant tables must remain intact for rollback' using errcode = '55000';
  end if;

  select count(*)::integer
    into v_overloads
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'direct_entry_resolve_actor_context';

  if v_overloads <> 1 then
    raise exception 'WP10-5 check failed: expected single direct_entry_resolve_actor_context overload, found %', v_overloads using errcode = '55000';
  end if;

  v_oid := pg_catalog.to_regprocedure(v_sig);
  if v_oid is null then
    raise exception 'WP10-5 check failed: missing service RPC %', v_sig using errcode = '55000';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');
  select p.proowner into v_proc_owner from pg_catalog.pg_proc p where p.oid = v_oid;
  if v_can_set_owner and v_proc_owner is distinct from v_base_owner_oid then
    execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
  end if;

  revoke all on function public.direct_entry_resolve_actor_context(uuid)
    from public, anon, authenticated, service_role;
  grant execute on function public.direct_entry_resolve_actor_context(uuid)
    to service_role;

  select p.prosecdef, p.provolatile, p.proconfig
    into v_rec
    from pg_catalog.pg_proc p
   where p.oid = v_oid;

  if not coalesce(v_rec.prosecdef, false)
     or v_rec.provolatile <> 's'
     or not ('search_path=pg_catalog, public' = any(coalesce(v_rec.proconfig, array[]::text[]))) then
    raise exception 'WP10-5 check failed: definer/volatility/search_path invalid on %', v_sig using errcode = '55000';
  end if;

  if not pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     or pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') then
    raise exception 'WP10-5 check failed: RPC ACL invalid on %', v_sig using errcode = '55000';
  end if;
end
$align_and_check_wp10_5$;

commit;
