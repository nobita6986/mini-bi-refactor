-- =============================================================================
-- WP8A: Salary Advance + Vendor Finance on Canonical WP3 Org & WP5 Paired Access
-- =============================================================================
-- Goals:
--   1. Move Accounting department membership checks (`org_department__internal_has_active_membership`)
--      to canonical WP3 `organization_person_department_memberships` + `organization_persons.status='ACTIVE'`
--      for Person-linked accounts, while preserving valid unlinked `NORMAL` account compat
--      (e.g., legacy `.kt` accounts) and blocking `SHARED`/`SERVICE` & disabled accounts.
--   2. Block `SHARED`/`SERVICE` reclassification when active PA or VFIN global role exists.
--   3. Move Salary Advance & Vendor Finance authority resolution & governance guards from
--      legacy unpaired capability/scope helpers to WP5 paired `direct_entry_authz__internal_has_paired_capability`.
--   4. Align Salary Advance PM checks with WP5B-1 R2 canonical PM predicate (active interval,
--      not suspended_by_account_disable, `account_type = 'NORMAL'`) and enforce dual-role
--      self-approval prevention (`created_by_user_id IS DISTINCT FROM p_app_user_id`).
--   5. Prioritize WP3 `organization_persons.full_name` in read-time/new-entry actor display names
--      without mutating immutable historical financial snapshots.
--   6. Enforce a single acyclic cross-domain lock DAG across all Salary Advance & Vendor Finance
--      write RPCs:
--        [1] idem adv lock -> [2] direct_entry_projects FOR SHARE -> [3] vfin_project adv lock
--        -> [4] vfin_global_role adv lock -> [5] direct_entry_app_users (ASC) FOR SHARE
--        -> [6] vfin_vendor adv lock + vendors FOR UPDATE -> [7] domain row locks/writes
--      eliminating TOCTOU authority races and AB-BA deadlocks against account disable,
--      role revoke, WP3 org mutations, PM revoke (Admin & TL paths), PA revoke, and global role revoke.
--   7. Zero new public service_role RPCs (exact 336 allowlist & old-Web contract preserved).
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Shared Canonical WP3 Org / Accounting Membership & Identity Helpers
-- -----------------------------------------------------------------------------

create or replace function public.org_department__internal_has_active_membership(
  p_app_user_id uuid,
  p_system_key text,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p_app_user_id is not null
     and p_system_key is not null
     and p_as_of is not null
     and exists (
       select 1
         from public.direct_entry_app_users u
        where u.app_user_id = p_app_user_id
          and u.enabled = true
          and u.account_type = 'NORMAL'
          and case
            when exists (
              select 1
                from public.organization_account_person_links l_any
               where l_any.app_user_id = u.app_user_id
                 and l_any.ended_at is null
            ) then exists (
              select 1
                from public.organization_account_person_links l
                join public.organization_persons p
                  on p.person_id = l.person_id
                 and p.status = 'ACTIVE'
                join public.organization_person_department_memberships pm
                  on pm.person_id = p.person_id
                 and pm.ended_at is null
                 and pm.started_at <= pg_catalog.clock_timestamp()
                join public.organization_departments d
                  on d.department_id = pm.department_id
                 and d.system_key = p_system_key
                 and d.is_active = true
               where l.app_user_id = u.app_user_id
                 and l.ended_at is null
            )
            else exists (
              select 1
                from public.organization_department_memberships m
                join public.organization_departments d
                  on d.department_id = m.department_id
                 and d.system_key = p_system_key
                 and d.is_active = true
               where m.app_user_id = u.app_user_id
                 and m.valid_from <= p_as_of
                 and (m.valid_to is null or p_as_of < m.valid_to)
                 and (m.valid_to is null or m.valid_to > m.valid_from)
            )
          end
     );
$function$;

revoke all on function public.org_department__internal_has_active_membership(uuid, text, date)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_resolve_vfin_default_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_as_of date default public.direct_entry_authorization_date()
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_as_of date := coalesce(p_as_of, public.direct_entry_authorization_date());
  v_full_admin boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);

  v_full_admin := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
    and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);

  if v_full_admin then
    return pg_catalog.jsonb_build_object(
      'allowed', true,
      'authority_source', 'full_admin',
      'can_view', true,
      'can_record', true
    );
  end if;

  if public.org_department__internal_has_active_membership(p_app_user_id, 'ACCOUNTING', v_as_of) then
    return pg_catalog.jsonb_build_object(
      'allowed', true,
      'authority_source', 'accounting_department',
      'can_view', true,
      'can_record', true
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'allowed', false,
    'authority_source', 'none',
    'can_view', false,
    'can_record', false
  );
end;
$function$;

revoke all on function public.org_department__internal_resolve_vfin_default_authority(uuid, uuid, date)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_has_personal_assignments(
  p_app_user_id uuid,
  p_as_of timestamptz default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_eff_now timestamptz := coalesce(p_as_of, pg_catalog.clock_timestamp());
  v_today date := (v_eff_now at time zone 'Asia/Ho_Chi_Minh')::date;
begin
  if p_app_user_id is null then
    return false;
  end if;

  return exists (
    select 1
      from public.organization_account_person_links l
     where l.app_user_id = p_app_user_id
       and l.ended_at is null
  ) or exists (
    select 1
      from public.organization_department_memberships lm
     where lm.app_user_id = p_app_user_id
       and (
         lm.valid_to is null
         or (lm.valid_from <= v_today and v_today < lm.valid_to and lm.valid_to > lm.valid_from)
       )
  ) or exists (
    select 1
      from public.vendor_finance_project_accountants pa
     where pa.accountant_user_id = p_app_user_id
       and (
         pa.valid_to is null
         or (pa.valid_from <= v_today and v_today < pa.valid_to and pa.valid_to > pa.valid_from)
       )
  ) or exists (
    select 1
      from public.vendor_finance_global_roles gr
     where gr.app_user_id = p_app_user_id
       and (
         gr.valid_to is null
         or (gr.valid_from <= v_today and v_today < gr.valid_to and gr.valid_to > gr.valid_from)
       )
  ) or exists (
    select 1
      from public.direct_entry_app_user_recruiter_links rl
     where rl.app_user_id = p_app_user_id
       and rl.verified = true
       and (
         rl.is_current = true
         or rl.suspended_by_account_disable = true
       )
       and (rl.valid_to is null or v_today < rl.valid_to)
  ) or exists (
    select 1
      from public.direct_entry_team_leader_assignments tla
     where tla.leader_app_user_id = p_app_user_id
       and (
         tla.is_current = true
         or tla.suspended_by_account_disable = true
       )
       and (tla.valid_to is null or v_today < tla.valid_to)
  ) or exists (
    select 1
      from public.leave_department_approvers lda
     where lda.approver_app_user_id = p_app_user_id
       and lda.is_current = true
       and (lda.valid_to is null or v_today <= lda.valid_to)
  ) or exists (
    select 1
      from public.work_report_delegations wrd
     where (wrd.grantor_user_id = p_app_user_id or wrd.delegate_app_user_id = p_app_user_id)
       and (
         public.work_report__internal_is_delegation_effective(wrd.delegation_id, v_eff_now)
         or (
           wrd.is_current = true
           and wrd.state = 'ACTIVE'
           and wrd.revoked_at is null
           and wrd.effective_from <= v_eff_now
           and (wrd.effective_to is null or v_eff_now <= wrd.effective_to)
         )
       )
  ) or exists (
    select 1
      from public.authz_account_role_assignments ara
     where ara.app_user_id = p_app_user_id
       and ara.ended_at is null
       and ara.started_at <= v_eff_now
  ) or exists (
    select 1
      from public.authz_direct_capability_grants dg
     where dg.app_user_id = p_app_user_id
       and dg.ended_at is null
       and dg.started_at <= v_eff_now
  );
end;
$function$;

revoke all on function public.org_department__internal_has_personal_assignments(uuid, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function public.org_department__internal_account_summary(
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
  v_person_name text := null;
  v_person_code text := null;
  v_linked_name text := null;
  v_personnel_code text := null;
  v_login_id text := null;
begin
  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  if not found then
    return null;
  end if;

  select nullif(pg_catalog.btrim(coalesce(p.full_name, '')), ''),
         nullif(pg_catalog.btrim(coalesce(p.employee_code, '')), '')
    into v_person_name, v_person_code
    from public.organization_account_person_links l
    join public.organization_persons p
      on p.person_id = l.person_id
   where l.app_user_id = v_user.app_user_id
     and l.ended_at is null
   order by l.started_at desc, l.link_id desc
   limit 1;

  select nullif(pg_catalog.btrim(coalesce(r.display_name, '')), ''),
         nullif(pg_catalog.btrim(coalesce(r.personnel_code, '')), '')
    into v_linked_name, v_personnel_code
    from public.direct_entry_app_user_recruiter_links l
    join public.recruiters r on r.recruiter_id = l.recruiter_id
   where l.app_user_id = v_user.app_user_id
     and l.verified = true
     and l.is_current = true
   order by l.valid_from desc, l.link_id desc
   limit 1;

  select pg_catalog.lower(
           nullif(
             pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1),
             ''
           )
         )
    into v_login_id
    from auth.users au
   where au.id = v_user.auth_subject;

  return pg_catalog.jsonb_build_object(
    'account_ref', v_user.app_user_id,
    'display_name', coalesce(v_person_name, v_linked_name, v_user.display_name),
    'login_id', v_login_id,
    'personnel_code', coalesce(v_person_code, v_personnel_code),
    'account_enabled', v_user.enabled
  );
end;
$function$;

revoke all on function public.org_department__internal_account_summary(uuid)
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. Salary Advance: Canonical PM Predicate, WP3 Display Name, Paired Authority,
--    Self-Approval Prevention & Acyclic Cross-Domain Lock Order
-- -----------------------------------------------------------------------------

create or replace function public.salary_advance__internal_is_effective_project_manager(
  p_app_user_id uuid,
  p_project_id text,
  p_as_of date default public.direct_entry_authorization_date()
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $function$
  select p_app_user_id is not null
     and p_project_id is not null
     and p_as_of is not null
     and exists (
       select 1
         from public.direct_entry_project_manager_assignments a
         join public.direct_entry_app_user_recruiter_links l
           on l.recruiter_id = a.manager_recruiter_id
          and l.app_user_id = p_app_user_id
          and l.verified = true
          and l.is_current = true
          and not l.suspended_by_account_disable
          and l.valid_from <= p_as_of
          and (l.valid_to is null or (l.valid_to > l.valid_from and p_as_of < l.valid_to))
         join public.direct_entry_app_users u
           on u.app_user_id = l.app_user_id
          and u.enabled = true
          and u.auth_subject is not null
          and u.account_type = 'NORMAL'
         join public.recruiters r
           on r.recruiter_id = a.manager_recruiter_id
          and r.active = true
        where a.project_id = p_project_id
          and a.is_current = true
          and a.revoked_at is null
          and a.valid_from <= p_as_of
          and (a.valid_to is null or (a.valid_to > a.valid_from and p_as_of < a.valid_to))
          and (
            select count(*)::int
              from public.direct_entry_app_user_recruiter_links current_link
             where current_link.recruiter_id = a.manager_recruiter_id
               and current_link.verified = true
               and current_link.is_current = true
          ) = 1
          and (
            select count(*)::int
              from public.direct_entry_app_user_recruiter_links current_link
              join public.direct_entry_app_users linked_user
                on linked_user.app_user_id = current_link.app_user_id
             where current_link.recruiter_id = a.manager_recruiter_id
               and current_link.verified = true
               and current_link.is_current = true
               and linked_user.enabled = true
               and linked_user.auth_subject is not null
          ) = 1
     );
$function$;

revoke all on function public.salary_advance__internal_is_effective_project_manager(uuid, text, date)
  from public, anon, authenticated, service_role;

create or replace function public.salary_advance__internal_actor_display_name(
  p_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_name text;
begin
  if p_user_id is null then
    return 'Chưa cập nhật tên';
  end if;

  select coalesce(
           case
             when org_person.full_name is not null
                  and org_person.full_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then org_person.full_name
             else null
           end,
           case
             when linked.display_name is not null
                  and linked.display_name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then linked.display_name
             else null
           end,
           case
             when nullif(pg_catalog.btrim(coalesce(u.display_name, '')), '') is not null
                  and pg_catalog.btrim(u.display_name) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then pg_catalog.btrim(u.display_name)
             else null
           end,
           case
             when auth_login.login_id is not null
                  and auth_login.login_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               then auth_login.login_id
             else null
           end,
           'Chưa cập nhật tên'
         )
    into v_name
    from public.direct_entry_app_users u
    left join lateral (
      select nullif(pg_catalog.btrim(coalesce(p.full_name, '')), '') as full_name
        from public.organization_account_person_links l
        join public.organization_persons p
          on p.person_id = l.person_id
       where l.app_user_id = u.app_user_id
         and l.ended_at is null
       order by l.started_at desc, l.link_id desc
       limit 1
    ) org_person on true
    left join lateral (
      select nullif(pg_catalog.btrim(coalesce(r.display_name, '')), '') as display_name
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
    left join lateral (
      select pg_catalog.lower(
               nullif(
                 pg_catalog.btrim(
                   pg_catalog.split_part(coalesce(pg_catalog.to_jsonb(au)->>'email', ''), pg_catalog.chr(64), 1)
                 ),
                 ''
               )
             ) as login_id
        from auth.users au
       where au.id = u.auth_subject
       limit 1
    ) auth_login on true
   where u.app_user_id = p_user_id;

  return pg_catalog.left(coalesce(v_name, 'Chưa cập nhật tên'), 256);
end;
$function$;

revoke all on function public.salary_advance__internal_actor_display_name(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.salary_advance__internal_resolve_authority(
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
  v_today date;
  v_account_type text := 'NORMAL';
  v_is_full_admin boolean := false;
  v_is_bod boolean := false;
  v_is_supervisory_viewer boolean := false;
  v_accounting_member boolean := false;
  v_managed_project_ids text[] := array[]::text[];
  v_accountant_project_ids text[] := array[]::text[];
  v_is_project_manager boolean := false;
  v_is_project_accountant boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  select coalesce(u.account_type, 'NORMAL')
    into v_account_type
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  -- Canonical paired Full Admin (`entry_admin` + `recruiter_master_manage` + `team_master_manage` at `ALL`).
  if v_account_type <> 'SHARED' then
    v_is_full_admin := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);

    -- Canonical paired BoD (`entry_privileged_edit` at `ALL` OR (`report_analytics_view` + `report_view` at `ALL`)).
    -- Never infer BoD from `vendor_finance_*`, `vendor_finance_global_roles`, or cross-source `HR_OPERATOR + TEAM_LEADER`.
    v_is_bod := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_privileged_edit', 'ALL', null)
      or (
        public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_analytics_view', 'ALL', null)
        and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'report_view', 'ALL', null)
      );
  end if;

  v_is_supervisory_viewer := v_is_full_admin or v_is_bod;

  if v_account_type = 'NORMAL' then
    -- Active assigned Project Manager projects (canonical WP5B-1 R2 predicate).
    select coalesce(pg_catalog.array_agg(p.project_id order by p.project_id), array[]::text[])
      into v_managed_project_ids
      from public.direct_entry_projects p
     where public.salary_advance__internal_is_effective_project_manager(p_app_user_id, p.project_id, v_today);

    -- Active assigned Project Accountant projects (requires canonical active ACCOUNTING department membership).
    v_accounting_member := public.org_department__internal_has_active_membership(
      p_app_user_id,
      'ACCOUNTING',
      v_today
    );

    if v_accounting_member then
      select coalesce(pg_catalog.array_agg(distinct pa.project_id order by pa.project_id), array[]::text[])
        into v_accountant_project_ids
        from public.vendor_finance_project_accountants pa
        join public.direct_entry_projects p
          on p.project_id = pa.project_id
       where pa.accountant_user_id = p_app_user_id
         and pa.valid_from <= v_today
         and (pa.valid_to is null or pa.valid_to > v_today)
         and (pa.valid_to is null or pa.valid_to > pa.valid_from);
    end if;
  end if;

  v_is_project_manager := coalesce(pg_catalog.array_length(v_managed_project_ids, 1), 0) > 0;
  v_is_project_accountant := coalesce(pg_catalog.array_length(v_accountant_project_ids, 1), 0) > 0;

  return pg_catalog.jsonb_build_object(
    'allowed', (v_is_supervisory_viewer or v_is_project_manager or v_is_project_accountant),
    'is_project_manager', v_is_project_manager,
    'is_project_accountant', v_is_project_accountant,
    'is_supervisory_viewer', v_is_supervisory_viewer,
    'is_full_admin', v_is_full_admin,
    'is_bod', v_is_bod,
    'managed_project_ids', pg_catalog.to_jsonb(v_managed_project_ids),
    'accountant_project_ids', pg_catalog.to_jsonb(v_accountant_project_ids),
    'authorization_date', v_today::text
  );
end;
$function$;

revoke all on function public.salary_advance__internal_resolve_authority(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.salary_advance__internal_request_access(
  p_auth jsonb,
  p_app_user_id uuid,
  p_req public.salary_advance_requests
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_acct_info jsonb;
  v_acct_user_id uuid;
  v_is_creator_pm boolean := false;
  v_is_assigned_accountant boolean := false;
  v_can_act_as_accountant boolean := false;
  v_is_supervisory boolean := false;
  v_can_view boolean := false;
begin
  v_today := (p_auth->>'authorization_date')::date;
  v_is_supervisory := coalesce((p_auth->>'is_supervisory_viewer')::boolean, false);

  v_is_creator_pm := (p_req.created_by_user_id = p_app_user_id)
    and public.salary_advance__internal_is_effective_project_manager(p_app_user_id, p_req.project_id, v_today);

  v_acct_info := public.vendor_finance__internal_resolve_active_project_accountant(
    p_req.project_id,
    v_today
  );

  if coalesce((v_acct_info->>'accountant_active')::boolean, false) then
    v_acct_user_id := (v_acct_info->>'accountant_user_id')::uuid;
  end if;

  v_is_assigned_accountant := v_acct_user_id is not null
    and v_acct_user_id = p_app_user_id;

  -- Self-approval guard: even if an actor holds both PM and PA on the same project,
  -- they cannot execute accountant decisions or evidence reviews on a request they created.
  v_can_act_as_accountant := v_is_assigned_accountant
    and (p_req.created_by_user_id is distinct from p_app_user_id);

  v_can_view := v_is_creator_pm or v_is_assigned_accountant or v_is_supervisory;

  return pg_catalog.jsonb_build_object(
    'can_view', v_can_view,
    'is_creator_project_manager', v_is_creator_pm,
    'is_assigned_project_accountant', v_is_assigned_accountant,
    'is_supervisory_viewer', v_is_supervisory,
    'current_project_accountant', case
      when v_acct_user_id is not null then
        pg_catalog.jsonb_build_object(
          'app_user_id', v_acct_user_id,
          'display_name', public.salary_advance__internal_actor_display_name(v_acct_user_id)
        )
      else null
    end,
    'allowed_actions', pg_catalog.jsonb_build_object(
      'can_post_message', (
        (v_is_creator_pm or v_is_assigned_accountant)
        and p_req.request_state in ('OPEN', 'NEEDS_INFO', 'APPROVED')
      ),
      'can_provide_info', (
        v_is_creator_pm
        and p_req.request_state = 'NEEDS_INFO'
      ),
      'can_withdraw', (
        v_is_creator_pm
        and p_req.request_state in ('OPEN', 'NEEDS_INFO')
      ),
      'can_upload_evidence', (
        v_is_creator_pm
        and p_req.request_state = 'APPROVED'
        and p_req.evidence_review_state in ('NOT_UPLOADED', 'RETAKE_REQUIRED', 'PENDING_REVIEW')
      ),
      'can_request_info', (
        v_can_act_as_accountant
        and p_req.request_state = 'OPEN'
      ),
      'can_approve', (
        v_can_act_as_accountant
        and p_req.request_state in ('OPEN', 'NEEDS_INFO')
      ),
      'can_reject', (
        v_can_act_as_accountant
        and p_req.request_state in ('OPEN', 'NEEDS_INFO')
      ),
      'can_mark_handled_externally', (
        v_can_act_as_accountant
        and p_req.request_state = 'APPROVED'
      ),
      'can_review_evidence', (
        v_can_act_as_accountant
        and p_req.request_state = 'APPROVED'
        and p_req.evidence_review_state = 'PENDING_REVIEW'
        and p_req.current_evidence_version >= 1
      )
    )
  );
end;
$function$;

revoke all on function public.salary_advance__internal_request_access(jsonb, uuid, public.salary_advance_requests)
  from public, anon, authenticated, service_role;

create or replace function public.salary_advance_list_project_workers(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_search text default null,
  p_cursor text default null,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_managed_project_ids text[] := array[]::text[];
  v_today date;
  v_page_size integer;
  v_search text;
  v_cursor_code text := null;
  v_cursor_id uuid := null;
  v_items jsonb := '[]'::jsonb;
  v_total_fetched integer := 0;
  v_next_cursor text := null;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'SALARY_ADVANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  v_today := coalesce(
    (v_auth->>'authorization_date')::date,
    public.direct_entry_authorization_date()
  );

  if not public.salary_advance__internal_is_effective_project_manager(p_app_user_id, p_project_id, v_today) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  v_managed_project_ids := array(
    select pg_catalog.jsonb_array_elements_text(coalesce(v_auth->'managed_project_ids', '[]'::jsonb))
  );

  v_page_size := coalesce(p_page_size, 25);
  if v_page_size < 1 or v_page_size > 100 then
    raise exception 'SALARY_ADVANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  v_search := public.salary_advance__internal_validate_text(
    p_search,
    1,
    120,
    true,
    'SALARY_ADVANCE_QUERY_INVALID'
  );

  if p_cursor is not null and pg_catalog.btrim(p_cursor) <> '' then
    if p_cursor !~ '^[^|]+\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'SALARY_ADVANCE_QUERY_INVALID'
        using errcode = '22023';
    end if;
    v_cursor_code := pg_catalog.split_part(p_cursor, '|', 1);
    v_cursor_id := pg_catalog.split_part(p_cursor, '|', 2)::uuid;
  end if;

  with eligible as (
    select e.entry_id as worker_entry_id,
           e.employee_code,
           public.salary_advance__internal_worker_display_name(e.worker_details) as display_name,
           pg_catalog.to_char(e.first_work_date, 'YYYY-MM-DD') as first_work_date,
           (public.salary_advance__internal_resolve_worker_portrait(e.candidate_id) is not null) as has_portrait
      from public.direct_entries e
      join public.direct_entry_submissions s
        on s.submission_id = e.submission_id
     where e.project_id = p_project_id
       and e.deleted_at is null
       and e.voided_at is null
       and s.state = 'SUBMITTED'
       and coalesce(e.provider_type, '') <> 'vendor'
       and not exists (
         select 1
           from public.recruiter_provider_memberships m
          where m.recruiter_id = e.recruiter_id
            and m.is_current = true
            and (m.provider_type = 'vendor' or m.vendor_id is not null)
       )
  ),
  filtered as (
    select w.*
      from eligible w
     where (
       v_search is null
       or pg_catalog.lower(w.employee_code) like '%' || pg_catalog.lower(v_search) || '%'
       or pg_catalog.lower(w.display_name) like '%' || pg_catalog.lower(v_search) || '%'
     )
       and (
         v_cursor_code is null
         or (w.employee_code, w.worker_entry_id::text) > (v_cursor_code, v_cursor_id::text)
       )
     order by w.employee_code asc, w.worker_entry_id asc
     limit v_page_size + 1
  ),
  trimmed as (
    select t.*,
           public.salary_advance__internal_evaluate_worker(t.worker_entry_id) as eval,
           public.salary_advance__internal_compute_worker_30d_summary(
             t.worker_entry_id,
             false,
             v_managed_project_ids,
             v_today
           ) as advance_30d_summary
      from (
        select *
          from filtered
         order by employee_code asc, worker_entry_id asc
         limit v_page_size
      ) t
  )
  select (select count(*)::integer from filtered),
         coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'worker_entry_id', t.worker_entry_id,
               'employee_code', t.employee_code,
               'display_name', t.display_name,
               'first_work_date', t.first_work_date,
               'provider_type', coalesce(t.eval->>'provider_type', 'hrp'),
               'recruiter_display_name', t.eval->>'recruiter_display_name',
               'recruiter_code', t.eval->'recruiter_code',
               'has_portrait', t.has_portrait,
               'employment_status', t.eval->>'employment_status',
               'active_on_project_count', (t.eval->>'active_on_project_count')::integer,
               'has_duplicate_cccd', (t.eval->>'has_duplicate_cccd')::boolean,
               'is_eligible', (t.eval->>'is_eligible')::boolean,
               'ineligible_reasons', t.eval->'ineligible_reasons',
               'bank_transfer_eligible', (t.eval->>'bank_transfer_eligible')::boolean,
               'bank_ineligible_reason', t.eval->'bank_ineligible_reason',
               'bank_account', case
                 when t.eval->'bank_account' is not null
                      and pg_catalog.jsonb_typeof(t.eval->'bank_account') = 'object' then
                   pg_catalog.jsonb_build_object(
                     'bank_id', t.eval->'bank_account'->'bank_id',
                     'institution_name', t.eval->'bank_account'->'institution_name',
                     'account_number', t.eval->'bank_account'->'account_number',
                     'account_number_masked', t.eval->'bank_account'->'account_number_masked',
                     'account_holder_name', t.eval->'bank_account'->'account_holder_name',
                     'has_bank_account', t.eval->'bank_account'->'has_bank_account',
                     'is_self_owned', t.eval->'bank_account'->'is_self_owned'
                   )
                 else null
               end,
               'advance_30d_summary', t.advance_30d_summary
             )
             order by t.employee_code asc, t.worker_entry_id asc
           ),
           '[]'::jsonb
         ),
         (
           select t2.employee_code || '|' || t2.worker_entry_id::text
             from trimmed t2
            order by t2.employee_code desc, t2.worker_entry_id desc
            limit 1
         )
    into v_total_fetched, v_items, v_next_cursor
    from trimmed t;

  return pg_catalog.jsonb_build_object(
    'project_id', p_project_id,
    'workers', v_items,
    'has_more', (v_total_fetched > v_page_size),
    'next_cursor', case when v_total_fetched > v_page_size then v_next_cursor else null end
  );
end;
$function$;

revoke all on function public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer)
  to service_role;

create or replace function public.salary_advance_list_project_worker_history(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_worker_entry_id uuid,
  p_period_mode text default 'THIS_MONTH',
  p_month text default null,
  p_from_date text default null,
  p_to_date text default null,
  p_cursor text default null,
  p_page_size integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_entry public.direct_entries%rowtype;
  v_recruiter_info jsonb;
  v_managed_project_ids text[] := array[]::text[];
  v_today date;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'SALARY_ADVANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  v_today := coalesce(
    (v_auth->>'authorization_date')::date,
    public.direct_entry_authorization_date()
  );

  if not public.salary_advance__internal_is_effective_project_manager(p_app_user_id, p_project_id, v_today) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if p_worker_entry_id is null then
    raise exception 'SALARY_ADVANCE_WORKER_INVALID'
      using errcode = '22023';
  end if;

  select e.*
    into v_entry
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
   where e.entry_id = p_worker_entry_id
     and e.deleted_at is null
     and e.voided_at is null
     and s.state = 'SUBMITTED';

  if not found then
    raise exception 'SALARY_ADVANCE_WORKER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_entry.project_id <> p_project_id then
    raise exception 'SALARY_ADVANCE_WORKER_PROJECT_MISMATCH'
      using errcode = '22023';
  end if;

  v_recruiter_info := public.salary_advance__internal_worker_recruiter_info(p_worker_entry_id);
  if coalesce((v_recruiter_info->>'is_vendor_recruited')::boolean, false) then
    raise exception 'SALARY_ADVANCE_WORKER_VENDOR_RECRUITED'
      using errcode = 'PT409';
  end if;

  v_managed_project_ids := array(
    select pg_catalog.jsonb_array_elements_text(coalesce(v_auth->'managed_project_ids', '[]'::jsonb))
  );

  return public.salary_advance__internal_query_worker_history(
    null,
    p_worker_entry_id,
    false,
    v_managed_project_ids,
    v_today,
    p_period_mode,
    p_month,
    p_from_date,
    p_to_date,
    p_cursor,
    p_page_size
  );
end;
$function$;

revoke all on function public.salary_advance_list_project_worker_history(uuid, uuid, text, uuid, text, text, text, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.salary_advance_list_project_worker_history(uuid, uuid, text, uuid, text, text, text, text, text, integer)
  to service_role;

create or replace function public.salary_advance_create_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_worker_entry_id uuid,
  p_requested_amount_vnd text,
  p_initial_content text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_payment_method text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_today date;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_payment_method text;
  v_project public.direct_entry_projects%rowtype;
  v_pa_candidate_id uuid := null;
  v_acct_info jsonb;
  v_entry public.direct_entries%rowtype;
  v_worker_eval jsonb;
  v_destination_snapshot jsonb := null;
  v_amount bigint;
  v_content text;
  v_now timestamptz := now();
  v_req public.salary_advance_requests%rowtype;
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  v_today := (v_auth->>'authorization_date')::date;

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'CREATE_REQUEST'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  v_payment_method := pg_catalog.upper(pg_catalog.btrim(coalesce(p_payment_method, '')));
  if v_payment_method not in ('CASH', 'BANK_TRANSFER') then
    raise exception 'SALARY_ADVANCE_PAYMENT_METHOD_INVALID'
      using errcode = '22023';
  end if;

  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'SALARY_ADVANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  -- Canonical DAG [2]: lock direct_entry_projects FOR SHARE FIRST
  select p.*
    into v_project
    from public.direct_entry_projects p
   where p.project_id = p_project_id
   for share;

  if not found then
    if not public.salary_advance__internal_is_effective_project_manager(p_app_user_id, p_project_id, v_today) then
      raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    raise exception 'SALARY_ADVANCE_PROJECT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- Canonical DAG [3]: shared lock vfin_project:<project_id> (blocks PA assign/end, allows concurrent project requests)
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('vfin_project:' || v_project.project_id, 0)
  );

  select pa.accountant_user_id
    into v_pa_candidate_id
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_project.project_id
     and pa.valid_from <= v_today
     and (pa.valid_to is null or pa.valid_to > v_today)
     and (pa.valid_to is null or pa.valid_to > pa.valid_from)
   order by pa.valid_from desc, pa.version desc
   limit 1;

  -- Canonical DAG [5]: lock actor & active PA candidate in ascending app_user_id order FOR SHARE
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
      or (v_pa_candidate_id is not null and u.app_user_id = v_pa_candidate_id)
   order by u.app_user_id asc
   for share;

  -- Re-verify actor, PM assignment, project active status, and PA eligibility UNDER LOCK
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  v_today := (v_auth->>'authorization_date')::date;

  if not public.salary_advance__internal_is_effective_project_manager(p_app_user_id, p_project_id, v_today) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if not v_project.active then
    raise exception 'SALARY_ADVANCE_PROJECT_INACTIVE'
      using errcode = 'PT409';
  end if;

  v_acct_info := public.vendor_finance__internal_resolve_active_project_accountant(
    p_project_id,
    v_today
  );

  if not coalesce((v_acct_info->>'has_assignment')::boolean, false)
     or not coalesce((v_acct_info->>'accountant_active')::boolean, false) then
    raise exception 'SALARY_ADVANCE_PROJECT_ACCOUNTANT_UNASSIGNED'
      using errcode = 'PT409';
  end if;

  if p_worker_entry_id is null then
    raise exception 'SALARY_ADVANCE_WORKER_INVALID'
      using errcode = '22023';
  end if;

  select e.*
    into v_entry
    from public.direct_entries e
    join public.direct_entry_submissions s
      on s.submission_id = e.submission_id
   where e.entry_id = p_worker_entry_id
     and e.deleted_at is null
     and e.voided_at is null
     and s.state = 'SUBMITTED';

  if not found then
    raise exception 'SALARY_ADVANCE_WORKER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_entry.project_id <> p_project_id then
    raise exception 'SALARY_ADVANCE_WORKER_PROJECT_MISMATCH'
      using errcode = '22023';
  end if;

  v_worker_eval := public.salary_advance__internal_evaluate_worker(p_worker_entry_id);

  if coalesce((v_worker_eval->>'is_vendor_recruited')::boolean, false) then
    raise exception 'SALARY_ADVANCE_WORKER_VENDOR_RECRUITED'
      using errcode = 'PT409';
  end if;

  if coalesce(v_worker_eval->>'employment_status', 'UNCONFIRMED') <> 'ON' then
    raise exception 'SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS'
      using errcode = 'PT409';
  end if;

  if coalesce((v_worker_eval->>'active_on_project_count')::integer, 0) >= 2 then
    raise exception 'SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON'
      using errcode = 'PT409';
  end if;

  if coalesce((v_worker_eval->>'has_duplicate_cccd')::boolean, false) then
    raise exception 'SALARY_ADVANCE_WORKER_DUPLICATE_CCCD'
      using errcode = 'PT409';
  end if;

  if v_payment_method = 'BANK_TRANSFER' then
    if coalesce(v_worker_eval->>'bank_ineligible_reason', '') = 'BANK_ACCOUNT_MISSING' then
      raise exception 'SALARY_ADVANCE_BANK_ACCOUNT_MISSING'
        using errcode = 'PT409';
    end if;

    if not coalesce((v_worker_eval->>'bank_transfer_eligible')::boolean, false) then
      raise exception 'SALARY_ADVANCE_BANK_ACCOUNT_NOT_SELF_OWNED'
        using errcode = 'PT409';
    end if;

    v_destination_snapshot := pg_catalog.jsonb_build_object(
      'bank_id', v_worker_eval->'bank_account'->'bank_id',
      'institution_name', coalesce(
        nullif(pg_catalog.btrim(coalesce(v_worker_eval->'bank_account'->>'institution_name', '')), ''),
        public.direct_entry_vietqr_bank_display_name(v_worker_eval->'bank_account'->>'bank_id'),
        nullif(pg_catalog.btrim(coalesce(v_worker_eval->'bank_account'->>'bank_id', '')), ''),
        'Ngân hàng (đã cung cấp STK)'
      ),
      'account_number', v_worker_eval->'bank_account'->>'account_number',
      'account_number_masked', v_worker_eval->'bank_account'->>'account_number_masked',
      'account_holder_name', v_worker_eval->'bank_account'->>'account_holder_name',
      'normalized_holder_name', v_worker_eval->'bank_account'->>'normalized_holder_name',
      'payment_version', coalesce((v_worker_eval->'bank_account'->>'payment_version')::integer, 1),
      'captured_at', pg_catalog.to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    );
  end if;

  v_amount := public.salary_advance__internal_parse_positive_amount(p_requested_amount_vnd);
  v_content := public.salary_advance__internal_validate_text(
    p_initial_content,
    1,
    2000,
    false,
    'SALARY_ADVANCE_CONTENT_INVALID'
  );

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  insert into public.salary_advance_requests (
    project_id,
    worker_entry_id,
    requested_amount_vnd,
    initial_content,
    payment_method,
    payment_destination_snapshot,
    request_state,
    evidence_review_state,
    version,
    created_by_user_id,
    last_activity_at,
    last_actor_user_id,
    created_at,
    updated_at
  ) values (
    p_project_id,
    p_worker_entry_id,
    v_amount,
    v_content,
    v_payment_method,
    v_destination_snapshot,
    'OPEN',
    'NOT_UPLOADED',
    1,
    p_app_user_id,
    v_now,
    p_app_user_id,
    v_now,
    v_now
  )
  returning * into v_req;

  insert into public.salary_advance_events (
    request_id,
    event_seq,
    event_type,
    actor_user_id,
    actor_role,
    from_request_state,
    to_request_state,
    from_evidence_review_state,
    to_evidence_review_state,
    message_text,
    created_at
  ) values (
    v_req.request_id,
    1,
    'REQUEST_CREATED',
    p_app_user_id,
    'PROJECT_MANAGER',
    null,
    'OPEN',
    null,
    'NOT_UPLOADED',
    v_content,
    v_now
  );

  v_detail := public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    'CREATE_REQUEST',
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text, text)
  to service_role;

create or replace function public.salary_advance_post_message(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_message_text text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req_project_id text;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_is_pm boolean;
  v_is_acct boolean;
  v_actor_role text;
  v_message text;
  v_next_seq integer;
  v_new_req_state text;
  v_event_type text;
  v_now timestamptz := now();
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'POST_MESSAGE'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_request_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  v_message := public.salary_advance__internal_validate_text(
    p_message_text,
    1,
    2000,
    false,
    'SALARY_ADVANCE_MESSAGE_REQUIRED'
  );

  select r.project_id
    into v_req_project_id
    from public.salary_advance_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- Canonical DAG: [2] projects FOR SHARE -> [3] vfin_project (SHARED) -> [5] app_users FOR SHARE -> [7] request FOR UPDATE
  perform 1 from public.direct_entry_projects p where p.project_id = v_req_project_id for share;
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('vfin_project:' || v_req_project_id, 0));
  perform 1 from public.direct_entry_app_users u where u.app_user_id = p_app_user_id for share;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  v_is_pm := coalesce((v_access->>'is_creator_project_manager')::boolean, false);
  v_is_acct := coalesce((v_access->>'is_assigned_project_accountant')::boolean, false);

  if not v_is_pm and not v_is_acct then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  -- Creator posting on their own request always logs as PROJECT_MANAGER (even if dual-role PM+PA).
  v_actor_role := case when v_is_pm then 'PROJECT_MANAGER' else 'PROJECT_ACCOUNTANT' end;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.request_state not in ('OPEN', 'NEEDS_INFO', 'APPROVED') then
    raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.request_state = 'NEEDS_INFO' and v_is_pm then
    v_new_req_state := 'OPEN';
    v_event_type := 'INFO_PROVIDED';
  else
    v_new_req_state := v_req.request_state;
    v_event_type := 'MESSAGE_POSTED';
  end if;

  select coalesce(max(ev.event_seq), 0)::integer + 1
    into v_next_seq
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id;

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  update public.salary_advance_requests
     set request_state = v_new_req_state,
         version = v_req.version + 1,
         last_activity_at = v_now,
         last_actor_user_id = p_app_user_id,
         updated_at = v_now
   where request_id = v_req.request_id
  returning * into v_req;

  insert into public.salary_advance_events (
    request_id,
    event_seq,
    event_type,
    actor_user_id,
    actor_role,
    from_request_state,
    to_request_state,
    from_evidence_review_state,
    to_evidence_review_state,
    message_text,
    created_at
  ) values (
    v_req.request_id,
    v_next_seq,
    v_event_type,
    p_app_user_id,
    v_actor_role,
    case when v_event_type = 'INFO_PROVIDED' then 'NEEDS_INFO' else v_new_req_state end,
    v_new_req_state,
    v_req.evidence_review_state,
    v_req.evidence_review_state,
    v_message,
    v_now
  );

  v_detail := public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    'POST_MESSAGE',
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.salary_advance_post_message(uuid, uuid, uuid, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.salary_advance_post_message(uuid, uuid, uuid, integer, text, text, text)
  to service_role;

create or replace function public.salary_advance_transition_request(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_action text,
  p_expected_version integer,
  p_message_text text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_action text;
  v_idem_action text;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req_project_id text;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_is_pm boolean;
  v_is_acct boolean;
  v_actor_role text;
  v_from_state text;
  v_to_state text;
  v_event_type text;
  v_note text;
  v_worker_eval jsonb;
  v_next_seq integer;
  v_now timestamptz := now();
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_action := pg_catalog.upper(pg_catalog.btrim(coalesce(p_action, '')));
  if v_action not in (
    'REQUEST_INFO',
    'PROVIDE_INFO',
    'APPROVE',
    'REJECT',
    'WITHDRAW',
    'MARK_HANDLED_EXTERNALLY'
  ) then
    raise exception 'SALARY_ADVANCE_ACTION_INVALID'
      using errcode = '22023';
  end if;

  v_idem_action := case v_action
    when 'REQUEST_INFO' then 'REQUEST_INFO'
    when 'PROVIDE_INFO' then 'PROVIDE_INFO'
    when 'APPROVE' then 'APPROVE_REQUEST'
    when 'REJECT' then 'REJECT_REQUEST'
    when 'WITHDRAW' then 'WITHDRAW_REQUEST'
    else 'MARK_HANDLED_EXTERNALLY'
  end;

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> v_idem_action
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_request_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select r.project_id
    into v_req_project_id
    from public.salary_advance_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- Canonical DAG: [2] projects FOR SHARE -> [3] vfin_project (SHARED) -> [5] app_users FOR SHARE -> [7] request FOR UPDATE
  perform 1 from public.direct_entry_projects p where p.project_id = v_req_project_id for share;
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('vfin_project:' || v_req_project_id, 0));
  perform 1 from public.direct_entry_app_users u where u.app_user_id = p_app_user_id for share;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  v_is_pm := coalesce((v_access->>'is_creator_project_manager')::boolean, false);
  v_is_acct := coalesce((v_access->>'is_assigned_project_accountant')::boolean, false);

  if v_action in ('REQUEST_INFO', 'APPROVE', 'REJECT', 'MARK_HANDLED_EXTERNALLY') then
    -- Self-approval guard: assigned accountant cannot act on a request they created.
    if not v_is_acct or v_req.created_by_user_id = p_app_user_id then
      raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    v_actor_role := 'PROJECT_ACCOUNTANT';
  else
    if not v_is_pm then
      raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    v_actor_role := 'PROJECT_MANAGER';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  v_from_state := v_req.request_state;

  if v_action = 'REQUEST_INFO' then
    if v_from_state <> 'OPEN' then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      2000,
      false,
      'SALARY_ADVANCE_MESSAGE_REQUIRED'
    );
    v_to_state := 'NEEDS_INFO';
    v_event_type := 'INFO_REQUESTED';

  elsif v_action = 'PROVIDE_INFO' then
    if v_from_state <> 'NEEDS_INFO' then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      2000,
      false,
      'SALARY_ADVANCE_MESSAGE_REQUIRED'
    );
    v_to_state := 'OPEN';
    v_event_type := 'INFO_PROVIDED';

  elsif v_action = 'APPROVE' then
    if v_from_state not in ('OPEN', 'NEEDS_INFO') then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;

    -- Re-verify worker eligibility at approval time without mutating/deleting the request
    v_worker_eval := public.salary_advance__internal_evaluate_worker(v_req.worker_entry_id);

    if coalesce(v_worker_eval->>'employment_status', 'UNCONFIRMED') <> 'ON' then
      raise exception 'SALARY_ADVANCE_WORKER_INELIGIBLE_STATUS'
        using errcode = 'PT409';
    end if;

    if coalesce((v_worker_eval->>'active_on_project_count')::integer, 0) >= 2 then
      raise exception 'SALARY_ADVANCE_WORKER_MULTI_PROJECT_ON'
        using errcode = 'PT409';
    end if;

    if coalesce((v_worker_eval->>'has_duplicate_cccd')::boolean, false) then
      raise exception 'SALARY_ADVANCE_WORKER_DUPLICATE_CCCD'
        using errcode = 'PT409';
    end if;

    if coalesce(v_req.payment_method, 'CASH') = 'BANK_TRANSFER'
       and v_req.payment_destination_snapshot is null then
      raise exception 'SALARY_ADVANCE_BANK_ACCOUNT_MISSING'
        using errcode = 'PT409';
    end if;

    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      true,
      'SALARY_ADVANCE_NOTE_INVALID'
    );
    v_to_state := 'APPROVED';
    v_event_type := 'REQUEST_APPROVED';

  elsif v_action = 'REJECT' then
    if v_from_state not in ('OPEN', 'NEEDS_INFO') then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      false,
      'SALARY_ADVANCE_REASON_REQUIRED'
    );
    v_to_state := 'REJECTED';
    v_event_type := 'REQUEST_REJECTED';

  elsif v_action = 'WITHDRAW' then
    if v_from_state not in ('OPEN', 'NEEDS_INFO') then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      true,
      'SALARY_ADVANCE_NOTE_INVALID'
    );
    v_to_state := 'WITHDRAWN';
    v_event_type := 'REQUEST_WITHDRAWN';

  elsif v_action = 'MARK_HANDLED_EXTERNALLY' then
    if v_from_state <> 'APPROVED' then
      raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
        using errcode = 'PT409';
    end if;
    v_note := public.salary_advance__internal_validate_text(
      p_message_text,
      1,
      1000,
      true,
      'SALARY_ADVANCE_NOTE_INVALID'
    );
    v_to_state := 'HANDLED_EXTERNALLY';
    v_event_type := 'HANDLED_EXTERNALLY_MARKED';
  end if;

  select coalesce(max(ev.event_seq), 0)::integer + 1
    into v_next_seq
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id;

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  update public.salary_advance_requests
     set request_state = v_to_state,
         version = v_req.version + 1,
         decided_by_user_id = case
           when v_action in ('APPROVE', 'REJECT') then p_app_user_id
           else decided_by_user_id
         end,
         decided_at = case
           when v_action in ('APPROVE', 'REJECT') then v_now
           else decided_at
         end,
         decision_note = case
           when v_action in ('APPROVE', 'REJECT') then v_note
           else decision_note
         end,
         handled_externally_by_user_id = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then p_app_user_id
           else handled_externally_by_user_id
         end,
         handled_externally_at = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then v_now
           else handled_externally_at
         end,
         handled_externally_note = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then v_note
           else handled_externally_note
         end,
         withdrawn_by_user_id = case
           when v_action = 'WITHDRAW' then p_app_user_id
           else withdrawn_by_user_id
         end,
         withdrawn_at = case
           when v_action = 'WITHDRAW' then v_now
           else withdrawn_at
         end,
         withdrawn_note = case
           when v_action = 'WITHDRAW' then v_note
           else withdrawn_note
         end,
         pending_upload_id = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_id
         end,
         pending_upload_storage_key = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_storage_key
         end,
         pending_upload_mime_type = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_mime_type
         end,
         pending_upload_size_bytes = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_size_bytes
         end,
         pending_upload_checksum_sha256 = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_checksum_sha256
         end,
         pending_upload_caption_note = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_caption_note
         end,
         pending_upload_reserved_by_user_id = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_reserved_by_user_id
         end,
         pending_upload_expires_at = case
           when v_action = 'MARK_HANDLED_EXTERNALLY' then null
           else pending_upload_expires_at
         end,
         last_activity_at = v_now,
         last_actor_user_id = p_app_user_id,
         updated_at = v_now
   where request_id = v_req.request_id
  returning * into v_req;

  insert into public.salary_advance_events (
    request_id,
    event_seq,
    event_type,
    actor_user_id,
    actor_role,
    from_request_state,
    to_request_state,
    from_evidence_review_state,
    to_evidence_review_state,
    message_text,
    created_at
  ) values (
    v_req.request_id,
    v_next_seq,
    v_event_type,
    p_app_user_id,
    v_actor_role,
    v_from_state,
    v_to_state,
    v_req.evidence_review_state,
    v_req.evidence_review_state,
    v_note,
    v_now
  );

  v_detail := public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    v_idem_action,
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.salary_advance_transition_request(uuid, uuid, uuid, text, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.salary_advance_transition_request(uuid, uuid, uuid, text, integer, text, text, text)
  to service_role;

create or replace function public.salary_advance_reserve_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_mime_type text,
  p_size_bytes integer,
  p_checksum_sha256 text,
  p_caption_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req_project_id text;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_caption text;
  v_checksum text;
  v_upload_id uuid;
  v_storage_key text;
  v_expires_at timestamptz;
  v_superseded_key text;
  v_payload jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'RESERVE_EVIDENCE'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object(
      'superseded_storage_key', null,
      'replayed', true
    );
  end if;

  if p_request_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  if p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/png') then
    raise exception 'SALARY_ADVANCE_EVIDENCE_MIME_INVALID'
      using errcode = '22023';
  end if;

  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 10485760 then
    raise exception 'SALARY_ADVANCE_EVIDENCE_SIZE_INVALID'
      using errcode = '22023';
  end if;

  v_checksum := pg_catalog.lower(pg_catalog.btrim(coalesce(p_checksum_sha256, '')));
  if v_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'SALARY_ADVANCE_EVIDENCE_CHECKSUM_INVALID'
      using errcode = '22023';
  end if;

  v_caption := public.salary_advance__internal_validate_text(
    p_caption_note,
    1,
    1000,
    true,
    'SALARY_ADVANCE_NOTE_INVALID'
  );

  select r.project_id
    into v_req_project_id
    from public.salary_advance_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform 1 from public.direct_entry_projects p where p.project_id = v_req_project_id for share;
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('vfin_project:' || v_req_project_id, 0));
  perform 1 from public.direct_entry_app_users u where u.app_user_id = p_app_user_id for share;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'is_creator_project_manager')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_req.request_state <> 'APPROVED'
     or v_req.evidence_review_state not in ('NOT_UPLOADED', 'RETAKE_REQUIRED', 'PENDING_REVIEW') then
    raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  v_superseded_key := v_req.pending_upload_storage_key;
  v_upload_id := gen_random_uuid();
  v_storage_key := 'salary-advance/requests/' || v_req.request_id::text || '/evidence/' || v_upload_id::text;
  v_expires_at := clock_timestamp() + interval '15 minutes';

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  update public.salary_advance_requests
     set pending_upload_id = v_upload_id,
         pending_upload_storage_key = v_storage_key,
         pending_upload_mime_type = p_mime_type,
         pending_upload_size_bytes = p_size_bytes,
         pending_upload_checksum_sha256 = v_checksum,
         pending_upload_caption_note = v_caption,
         pending_upload_reserved_by_user_id = p_app_user_id,
         pending_upload_expires_at = v_expires_at,
         updated_at = now()
   where request_id = v_req.request_id;

  v_payload := pg_catalog.jsonb_build_object(
    'request_id', v_req.request_id,
    'upload_id', v_upload_id,
    'expected_version', v_req.version,
    'storage_key', v_storage_key,
    'mime_type', p_mime_type,
    'size_bytes', p_size_bytes,
    'checksum_sha256', v_checksum,
    'expires_at', pg_catalog.to_char(v_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    'RESERVE_EVIDENCE',
    v_fingerprint,
    v_payload,
    now()
  );

  return v_payload || pg_catalog.jsonb_build_object(
    'superseded_storage_key', v_superseded_key,
    'replayed', false
  );
end;
$function$;

revoke all on function public.salary_advance_reserve_evidence(uuid, uuid, uuid, integer, text, integer, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.salary_advance_reserve_evidence(uuid, uuid, uuid, integer, text, integer, text, text, text, text)
  to service_role;

create or replace function public.salary_advance_finalize_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_upload_id uuid,
  p_expected_version integer,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req_project_id text;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_evidence_kind text;
  v_next_seq integer;
  v_next_ev_version integer;
  v_from_ev_state text;
  v_event_id uuid;
  v_now timestamptz := now();
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'FINALIZE_EVIDENCE'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_request_id is null or p_upload_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  select r.project_id
    into v_req_project_id
    from public.salary_advance_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform 1 from public.direct_entry_projects p where p.project_id = v_req_project_id for share;
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('vfin_project:' || v_req_project_id, 0));
  perform 1 from public.direct_entry_app_users u where u.app_user_id = p_app_user_id for share;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'is_creator_project_manager')::boolean, false) then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_req.request_state <> 'APPROVED'
     or v_req.evidence_review_state not in ('NOT_UPLOADED', 'RETAKE_REQUIRED', 'PENDING_REVIEW') then
    raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.pending_upload_id is null or v_req.pending_upload_id <> p_upload_id then
    raise exception 'SALARY_ADVANCE_UPLOAD_SUPERSEDED'
      using errcode = 'PT409';
  end if;

  if v_req.pending_upload_expires_at is null
     or v_req.pending_upload_expires_at <= clock_timestamp() then
    raise exception 'SALARY_ADVANCE_UPLOAD_EXPIRED'
      using errcode = 'PT409';
  end if;

  v_from_ev_state := v_req.evidence_review_state;
  v_next_ev_version := v_req.current_evidence_version + 1;
  v_evidence_kind := case
    when coalesce(v_req.payment_method, 'CASH') = 'BANK_TRANSFER' then 'BANK_TRANSFER_RECEIPT'
    else 'CASH_HANDOVER_PHOTO'
  end;

  select coalesce(max(ev.event_seq), 0)::integer + 1
    into v_next_seq
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id;

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  insert into public.salary_advance_events (
    request_id,
    event_seq,
    event_type,
    actor_user_id,
    actor_role,
    from_request_state,
    to_request_state,
    from_evidence_review_state,
    to_evidence_review_state,
    message_text,
    evidence_kind,
    evidence_version,
    evidence_storage_key,
    evidence_mime_type,
    evidence_size_bytes,
    evidence_checksum_sha256,
    created_at
  ) values (
    v_req.request_id,
    v_next_seq,
    'EVIDENCE_UPLOADED',
    p_app_user_id,
    'PROJECT_MANAGER',
    v_req.request_state,
    'APPROVED',
    v_from_ev_state,
    'PENDING_REVIEW',
    v_req.pending_upload_caption_note,
    v_evidence_kind,
    v_next_ev_version,
    v_req.pending_upload_storage_key,
    v_req.pending_upload_mime_type,
    v_req.pending_upload_size_bytes,
    v_req.pending_upload_checksum_sha256,
    v_now
  )
  returning event_id into v_event_id;

  update public.salary_advance_requests
     set evidence_review_state = 'PENDING_REVIEW',
         current_evidence_version = v_next_ev_version,
         current_evidence_event_id = v_event_id,
         current_evidence_storage_key = v_req.pending_upload_storage_key,
         current_evidence_mime_type = v_req.pending_upload_mime_type,
         current_evidence_size_bytes = v_req.pending_upload_size_bytes,
         current_evidence_checksum_sha256 = v_req.pending_upload_checksum_sha256,
         current_evidence_uploaded_by_user_id = p_app_user_id,
         current_evidence_uploaded_at = v_now,
         evidence_reviewed_by_user_id = null,
         evidence_reviewed_at = null,
         evidence_review_note = null,
         reviewed_worker_portrait_document_id = null,
         reviewed_worker_portrait_version = null,
         pending_upload_id = null,
         pending_upload_storage_key = null,
         pending_upload_mime_type = null,
         pending_upload_size_bytes = null,
         pending_upload_checksum_sha256 = null,
         pending_upload_caption_note = null,
         pending_upload_reserved_by_user_id = null,
         pending_upload_expires_at = null,
         version = v_req.version + 1,
         last_activity_at = v_now,
         last_actor_user_id = p_app_user_id,
         updated_at = v_now
   where request_id = v_req.request_id
  returning * into v_req;

  v_detail := public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    'FINALIZE_EVIDENCE',
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.salary_advance_finalize_evidence(uuid, uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.salary_advance_finalize_evidence(uuid, uuid, uuid, uuid, integer, text, text)
  to service_role;

create or replace function public.salary_advance_review_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_evidence_version integer,
  p_decision text,
  p_expected_worker_portrait_document_id uuid,
  p_expected_worker_portrait_version integer,
  p_note text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_decision text;
  v_idem_key text;
  v_fingerprint text;
  v_existing_idem public.salary_advance_idempotency%rowtype;
  v_req_project_id text;
  v_req public.salary_advance_requests%rowtype;
  v_access jsonb;
  v_payment_method text;
  v_evidence_kind text;
  v_entry public.direct_entries%rowtype;
  v_portrait jsonb;
  v_reviewed_portrait_doc_id uuid := null;
  v_reviewed_portrait_version integer := null;
  v_note text;
  v_next_seq integer;
  v_event_type text;
  v_now timestamptz := now();
  v_detail jsonb;
begin
  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);

  v_decision := pg_catalog.upper(pg_catalog.btrim(coalesce(p_decision, '')));
  if v_decision not in ('REVIEWED', 'RETAKE_REQUIRED') then
    raise exception 'SALARY_ADVANCE_DECISION_INVALID'
      using errcode = '22023';
  end if;

  v_idem_key := public.salary_advance__internal_validate_text(
    p_idempotency_key,
    8,
    128,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );
  v_fingerprint := public.salary_advance__internal_validate_text(
    p_request_fingerprint,
    16,
    512,
    false,
    'SALARY_ADVANCE_IDEMPOTENCY_INVALID'
  );

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('sal_adv_idem:' || p_app_user_id::text || ':' || v_idem_key, 0)
  );

  select i.*
    into v_existing_idem
    from public.salary_advance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = v_idem_key;

  if found then
    if v_existing_idem.action <> 'REVIEW_EVIDENCE'
       or v_existing_idem.request_fingerprint <> v_fingerprint then
      raise exception 'SALARY_ADVANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_request_id is null
     or p_expected_version is null
     or p_expected_version < 1
     or p_evidence_version is null
     or p_evidence_version < 1 then
    raise exception 'SALARY_ADVANCE_REQUEST_INVALID'
      using errcode = '22023';
  end if;

  v_note := public.salary_advance__internal_validate_text(
    p_note,
    1,
    1000,
    true,
    'SALARY_ADVANCE_NOTE_INVALID'
  );

  select r.project_id
    into v_req_project_id
    from public.salary_advance_requests r
   where r.request_id = p_request_id;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  perform 1 from public.direct_entry_projects p where p.project_id = v_req_project_id for share;
  perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('vfin_project:' || v_req_project_id, 0));
  perform 1 from public.direct_entry_app_users u where u.app_user_id = p_app_user_id for share;

  select r.*
    into v_req
    from public.salary_advance_requests r
   where r.request_id = p_request_id
   for update;

  if not found then
    raise exception 'SALARY_ADVANCE_REQUEST_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  v_auth := public.salary_advance__internal_resolve_authority(p_auth_subject, p_app_user_id);
  v_access := public.salary_advance__internal_request_access(v_auth, p_app_user_id, v_req);
  if not coalesce((v_access->>'is_assigned_project_accountant')::boolean, false)
     or v_req.created_by_user_id = p_app_user_id then
    raise exception 'SALARY_ADVANCE_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_req.request_state <> 'APPROVED'
     or v_req.evidence_review_state <> 'PENDING_REVIEW'
     or v_req.current_evidence_version < 1 then
    raise exception 'SALARY_ADVANCE_STATE_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.version <> p_expected_version then
    raise exception 'SALARY_ADVANCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if v_req.current_evidence_version <> p_evidence_version then
    raise exception 'SALARY_ADVANCE_EVIDENCE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  v_payment_method := coalesce(v_req.payment_method, 'CASH');
  v_evidence_kind := case
    when v_payment_method = 'BANK_TRANSFER' then 'BANK_TRANSFER_RECEIPT'
    else 'CASH_HANDOVER_PHOTO'
  end;

  if v_payment_method = 'BANK_TRANSFER' then
    if p_expected_worker_portrait_document_id is not null
       or p_expected_worker_portrait_version is not null then
      raise exception 'SALARY_ADVANCE_PORTRAIT_LOCK_INVALID'
        using errcode = '22023';
    end if;

    if v_req.payment_destination_snapshot is null then
      raise exception 'SALARY_ADVANCE_BANK_ACCOUNT_MISSING'
        using errcode = 'PT409';
    end if;
  end if;

  if v_decision = 'REVIEWED' then
    if v_payment_method = 'CASH' then
      if p_expected_worker_portrait_document_id is null
         or p_expected_worker_portrait_version is null
         or p_expected_worker_portrait_version < 1 then
        raise exception 'SALARY_ADVANCE_PORTRAIT_LOCK_INVALID'
          using errcode = '22023';
      end if;

      select e.*
        into v_entry
        from public.direct_entries e
       where e.entry_id = v_req.worker_entry_id;

      v_portrait := public.salary_advance__internal_resolve_worker_portrait(v_entry.candidate_id);
      if v_portrait is null then
        raise exception 'SALARY_ADVANCE_WORKER_PORTRAIT_MISSING'
          using errcode = 'PT409';
      end if;

      if (v_portrait->>'document_id')::uuid <> p_expected_worker_portrait_document_id
         or (v_portrait->>'version')::integer <> p_expected_worker_portrait_version then
        raise exception 'SALARY_ADVANCE_WORKER_PORTRAIT_VERSION_CONFLICT'
          using errcode = 'PT409';
      end if;

      v_reviewed_portrait_doc_id := p_expected_worker_portrait_document_id;
      v_reviewed_portrait_version := p_expected_worker_portrait_version;
    end if;

    v_event_type := 'EVIDENCE_REVIEWED';
  else
    v_event_type := 'EVIDENCE_RETAKE_REQUESTED';
  end if;

  select coalesce(max(ev.event_seq), 0)::integer + 1
    into v_next_seq
    from public.salary_advance_events ev
   where ev.request_id = v_req.request_id;

  perform pg_catalog.set_config('salary_advance.write_marker', 'on', true);

  update public.salary_advance_requests
     set evidence_review_state = v_decision,
         evidence_reviewed_by_user_id = p_app_user_id,
         evidence_reviewed_at = v_now,
         evidence_review_note = v_note,
         reviewed_worker_portrait_document_id = v_reviewed_portrait_doc_id,
         reviewed_worker_portrait_version = v_reviewed_portrait_version,
         version = v_req.version + 1,
         last_activity_at = v_now,
         last_actor_user_id = p_app_user_id,
         updated_at = v_now
   where request_id = v_req.request_id
  returning * into v_req;

  insert into public.salary_advance_events (
    request_id,
    event_seq,
    event_type,
    actor_user_id,
    actor_role,
    from_request_state,
    to_request_state,
    from_evidence_review_state,
    to_evidence_review_state,
    message_text,
    evidence_kind,
    evidence_version,
    reviewed_worker_portrait_document_id,
    reviewed_worker_portrait_version,
    created_at
  ) values (
    v_req.request_id,
    v_next_seq,
    v_event_type,
    p_app_user_id,
    'PROJECT_ACCOUNTANT',
    'APPROVED',
    'APPROVED',
    'PENDING_REVIEW',
    v_decision,
    v_note,
    v_evidence_kind,
    v_req.current_evidence_version,
    v_reviewed_portrait_doc_id,
    v_reviewed_portrait_version,
    v_now
  );

  v_detail := public.salary_advance__internal_build_request_detail(v_req, v_auth, p_app_user_id);

  insert into public.salary_advance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload,
    created_at
  ) values (
    p_app_user_id,
    v_idem_key,
    'REVIEW_EVIDENCE',
    v_fingerprint,
    v_detail,
    v_now
  );

  return v_detail || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.salary_advance_review_evidence(uuid, uuid, uuid, integer, integer, text, uuid, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.salary_advance_review_evidence(uuid, uuid, uuid, integer, integer, text, uuid, integer, text, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 3. Vendor Finance: Canonical WP3 Accounting Membership, WP5 Paired Authority,
--    WP3 Display Name, Governance Guards & Cross-Domain Lock Primitives
-- -----------------------------------------------------------------------------

create or replace function public.vendor_finance__internal_actor_display_name(
  p_app_user_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_name text;
begin
  select coalesce(
           nullif(pg_catalog.btrim(org_person.full_name), ''),
           nullif(pg_catalog.btrim(linked.display_name), ''),
           nullif(pg_catalog.btrim(u.display_name), ''),
           'Hệ thống BI'
         )
    into v_name
    from public.direct_entry_app_users u
    left join lateral (
      select p.full_name
        from public.organization_account_person_links l
        join public.organization_persons p
          on p.person_id = l.person_id
       where l.app_user_id = u.app_user_id
         and l.ended_at is null
       order by l.started_at desc, l.link_id desc
       limit 1
    ) org_person on true
    left join lateral (
      select r.display_name
        from public.direct_entry_app_user_recruiter_links l
        join public.recruiters r on r.recruiter_id = l.recruiter_id
       where l.app_user_id = u.app_user_id
         and l.verified = true
         and l.is_current = true
       order by l.valid_from desc, l.link_id desc
       limit 1
    ) linked on true
   where u.app_user_id = p_app_user_id;

  if v_name is null then
    raise exception 'VENDOR_FINANCE_ACTOR_NOT_FOUND'
      using errcode = '42501';
  end if;

  return pg_catalog.left(v_name, 256);
end;
$function$;

revoke all on function public.vendor_finance__internal_actor_display_name(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.vendor_finance__internal_lock_project(
  p_project_id text
)
returns public.direct_entry_projects
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_project public.direct_entry_projects%rowtype;
begin
  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  -- Canonical DAG [2]: lock direct_entry_projects FOR SHARE FIRST so subsequent FK checks
  -- and concurrent direct_entry_assign/unassign_project_manager (projects -> app_users) share one order.
  select p.*
    into v_project
    from public.direct_entry_projects p
   where p.project_id = p_project_id
   for share;

  if not found then
    raise exception 'VENDOR_FINANCE_PROJECT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- Canonical DAG [3]: lock project advisory key
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_project:' || v_project.project_id, 0)
  );

  return v_project;
end;
$function$;

revoke all on function public.vendor_finance__internal_lock_project(text)
  from public, anon, authenticated, service_role;

create or replace function public.vendor_finance__internal_resolve_active_project_accountant(
  p_project_id text,
  p_as_of date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_project public.direct_entry_projects%rowtype;
  v_assign public.vendor_finance_project_accountants%rowtype;
  v_user public.direct_entry_app_users%rowtype;
  v_acct_name text;
  v_acct_in_dept boolean := false;
begin
  if p_project_id is null or p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  select p.*
    into v_project
    from public.direct_entry_projects p
   where p.project_id = p_project_id;

  if not found then
    raise exception 'VENDOR_FINANCE_PROJECT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select pa.*
    into v_assign
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_project.project_id
     and pa.valid_from <= p_as_of
     and (pa.valid_to is null or pa.valid_to > p_as_of)
     and (pa.valid_to is null or pa.valid_to > pa.valid_from)
   order by pa.valid_from desc, pa.version desc
   limit 1;

  if not found then
    return pg_catalog.jsonb_build_object(
      'project_id', v_project.project_id,
      'project_display_name', v_project.display_name,
      'project_active', v_project.active,
      'has_assignment', false,
      'accountant_active', false,
      'assignment_id', null,
      'accountant_user_id', null,
      'accountant_display_name', null
    );
  end if;

  select u.*
    into v_user
    from public.direct_entry_app_users u
   where u.app_user_id = v_assign.accountant_user_id;

  v_acct_in_dept := coalesce(v_user.enabled, false)
    and coalesce(v_user.account_type, 'NORMAL') = 'NORMAL'
    and public.org_department__internal_has_active_membership(
      v_assign.accountant_user_id,
      'ACCOUNTING',
      p_as_of
    );

  v_acct_name := public.vendor_finance__internal_actor_display_name(v_assign.accountant_user_id);

  return pg_catalog.jsonb_build_object(
    'project_id', v_project.project_id,
    'project_display_name', v_project.display_name,
    'project_active', v_project.active,
    'has_assignment', true,
    'accountant_active', v_acct_in_dept,
    'assignment_id', v_assign.assignment_id,
    'accountant_user_id', v_assign.accountant_user_id,
    'accountant_display_name', v_acct_name
  );
end;
$function$;

revoke all on function public.vendor_finance__internal_resolve_active_project_accountant(text, date)
  from public, anon, authenticated, service_role;

create or replace function public.vendor_finance__internal_can_actor_write_subledger(
  p_auth jsonb,
  p_app_user_id uuid,
  p_write_kind text,
  p_ledger_scope text,
  p_project_id text,
  p_responsible_accountant_user_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_scope text;
  v_today date := (p_auth->>'authorization_date')::date;
  v_active_acct uuid;
begin
  if p_write_kind = 'record' then
    v_scope := coalesce(p_auth->>'record_scope', 'NONE');
  else
    v_scope := coalesce(p_auth->>'reconcile_scope', 'NONE');
  end if;

  if v_scope = 'NONE' then
    return false;
  end if;

  if v_scope = 'ALL' then
    return true;
  end if;

  if p_ledger_scope <> 'PROJECT_ACCOUNTANT'
     or p_project_id is null
     or p_responsible_accountant_user_id is distinct from p_app_user_id then
    return false;
  end if;

  if not public.org_department__internal_has_active_membership(p_app_user_id, 'ACCOUNTING', v_today) then
    return false;
  end if;

  select pa.accountant_user_id
    into v_active_acct
    from public.vendor_finance_project_accountants pa
   where pa.project_id = p_project_id
     and pa.valid_from <= v_today
     and (pa.valid_to is null or pa.valid_to > v_today)
     and (pa.valid_to is null or pa.valid_to > pa.valid_from)
   limit 1;

  return v_active_acct = p_app_user_id;
end;
$function$;

revoke all on function public.vendor_finance__internal_can_actor_write_subledger(jsonb, uuid, text, text, text, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.vendor_finance__internal_resolve_authority(
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
  v_today date;
  v_account_type text := 'NORMAL';
  v_full_admin boolean := false;
  v_direct_record boolean := false;
  v_direct_view boolean := false;
  v_accounting_member boolean := false;
  v_global_role text := null;
  v_visibility_scope text := 'NONE';
  v_record_scope text := 'NONE';
  v_reconcile_scope text := 'NONE';
  v_authority_source text := 'none';
  v_assigned_project_count integer := 0;
  v_can_view_shared_advance boolean := false;
  v_can_fund_vendor_advance boolean := false;
  v_can_record_vendor_refund boolean := false;
  v_can_apply_vendor_advance boolean := false;
begin
  perform public.direct_entry_assert_actor_mapping(p_auth_subject, p_app_user_id);
  v_today := public.direct_entry_authorization_date();

  select coalesce(u.account_type, 'NORMAL')
    into v_account_type
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id;

  -- WP5 paired `ALL` capability checks: blocks unpaired `all` scope + unrelated capability
  -- and blocks `PROJECT_ACCOUNTANT` (`vendor_finance_view` at `CONTEXT_PROJECT`) from escalating to `ALL`.
  if v_account_type <> 'SHARED' then
    v_full_admin := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'entry_admin', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'recruiter_master_manage', 'ALL', null)
      and public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'team_master_manage', 'ALL', null);

    v_direct_record := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'vendor_finance_record', 'ALL', null);
    v_direct_view := public.direct_entry_authz__internal_has_paired_capability(p_app_user_id, 'vendor_finance_view', 'ALL', null);
  end if;

  if v_account_type = 'NORMAL' then
    v_accounting_member := public.org_department__internal_has_active_membership(
      p_app_user_id,
      'ACCOUNTING',
      v_today
    );

    -- Preserve specialized VFIN module grants (`CASH_HOLDER*`, `GLOBAL_*`) strictly in their own table.
    select gr.role_code
      into v_global_role
      from public.vendor_finance_global_roles gr
     where gr.app_user_id = p_app_user_id
       and gr.valid_from <= v_today
       and (gr.valid_to is null or gr.valid_to > v_today)
       and (gr.valid_to is null or gr.valid_to > gr.valid_from)
     order by gr.valid_from desc, gr.version desc
     limit 1;
  end if;

  if v_accounting_member then
    select count(*)::integer
      into v_assigned_project_count
      from public.vendor_finance_project_accountants pa
      join public.direct_entry_projects p
        on p.project_id = pa.project_id
       and p.active = true
     where pa.accountant_user_id = p_app_user_id
       and pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from);
  end if;

  if v_full_admin or v_direct_record or v_direct_view or v_global_role is not null then
    v_visibility_scope := 'ALL';
  elsif v_accounting_member then
    v_visibility_scope := 'PROJECT_SCOPED';
  else
    v_visibility_scope := 'NONE';
  end if;

  if v_full_admin or v_direct_record or v_global_role = 'CASH_HOLDER_RECORD_BEHALF' then
    v_record_scope := 'ALL';
  elsif v_accounting_member then
    v_record_scope := 'ASSIGNED_PROJECTS';
  else
    v_record_scope := 'NONE';
  end if;

  if v_full_admin
     or v_direct_record
     or v_global_role in ('CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF', 'GLOBAL_RECONCILER') then
    v_reconcile_scope := 'ALL';
  elsif v_accounting_member then
    v_reconcile_scope := 'ASSIGNED_PROJECTS';
  else
    v_reconcile_scope := 'NONE';
  end if;

  if v_full_admin then
    v_authority_source := 'full_admin';
  elsif v_global_role = 'CASH_HOLDER_RECORD_BEHALF' then
    v_authority_source := 'cash_holder_record_behalf';
  elsif v_direct_record then
    v_authority_source := 'direct_grant_record';
  elsif v_global_role = 'CASH_HOLDER' then
    v_authority_source := 'cash_holder';
  elsif v_global_role = 'GLOBAL_RECONCILER' then
    v_authority_source := 'global_reconciler';
  elsif v_global_role = 'GLOBAL_VIEWER' or v_direct_view then
    v_authority_source := 'direct_grant_view';
  elsif v_accounting_member then
    v_authority_source := 'accounting_department';
  else
    v_authority_source := 'none';
  end if;

  v_can_view_shared_advance := coalesce(
    v_visibility_scope = 'ALL'
    or (v_visibility_scope = 'PROJECT_SCOPED' and v_assigned_project_count > 0),
    false
  );

  v_can_fund_vendor_advance := coalesce(
    v_full_admin
    or v_direct_record
    or v_global_role in ('CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF'),
    false
  );
  v_can_record_vendor_refund := v_can_fund_vendor_advance;

  v_can_apply_vendor_advance := coalesce(
    v_record_scope = 'ALL'
    or (v_record_scope = 'ASSIGNED_PROJECTS' and v_assigned_project_count > 0),
    false
  );

  return pg_catalog.jsonb_build_object(
    'allowed', (v_visibility_scope <> 'NONE'),
    'authority_source', v_authority_source,
    'visibility_scope', v_visibility_scope,
    'record_scope', v_record_scope,
    'reconcile_scope', v_reconcile_scope,
    'global_role_code', v_global_role,
    'can_view', (v_visibility_scope <> 'NONE'),
    'can_record', (v_record_scope <> 'NONE'),
    'can_reconcile', (v_reconcile_scope <> 'NONE'),
    'can_manage_project_assignments', v_full_admin,
    'can_view_shared_advance', v_can_view_shared_advance,
    'can_fund_vendor_advance', v_can_fund_vendor_advance,
    'can_record_vendor_refund', v_can_record_vendor_refund,
    'can_apply_vendor_advance', v_can_apply_vendor_advance,
    'active_assigned_project_count', v_assigned_project_count,
    'authorization_date', v_today::text
  );
end;
$function$;

revoke all on function public.vendor_finance__internal_resolve_authority(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.vendor_finance__internal_lock_actor_and_assert_authority(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_mode text,
  p_extra_user_ids uuid[] default array[]::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
begin
  -- Canonical DAG [4]: shared lock actor's VFIN global role key (blocks assign/end global role, allows concurrent reads/writes by actor)
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('vfin_global_role:' || p_app_user_id::text, 0)
  );

  -- Canonical DAG [5]: lock actor & ALL referenced user IDs (active PA, historical responsible accountant, etc.)
  -- in strict ascending app_user_id order FOR SHARE so subsequent FK RI checks never acquire an out-of-order user lock.
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id = p_app_user_id
      or u.app_user_id = any(coalesce(p_extra_user_ids, array[]::uuid[]))
   order by u.app_user_id asc
   for share;

  -- Re-assert authority under lock
  return public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, p_mode);
end;
$function$;

revoke all on function public.vendor_finance__internal_lock_actor_and_assert_authority(uuid, uuid, text, uuid[])
  from public, anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 4. Vendor Finance Governance Admin RPCs (Paired Admin Guard + Canonical Locks)
-- -----------------------------------------------------------------------------

create or replace function public.vendor_finance_list_project_accountants_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_include_history boolean default true,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_search text := null;
  v_offset integer;
  v_total integer;
  v_eligible jsonb;
  v_projects jsonb;
begin
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');
  v_today := public.direct_entry_authorization_date();

  if p_include_history is null
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'VENDOR_FINANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = '' or pg_catalog.length(v_search) > 120 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'VENDOR_FINANCE_SEARCH_INVALID'
        using errcode = '22023';
    end if;
  end if;

  v_offset := (p_page - 1) * p_page_size;

  select coalesce(
           pg_catalog.jsonb_agg(
             public.org_department__internal_account_summary(u.app_user_id)
             order by pg_catalog.lower(coalesce(u.display_name, '')), u.app_user_id
           ),
           '[]'::jsonb
         )
    into v_eligible
    from public.direct_entry_app_users u
   where u.enabled = true
     and u.account_type = 'NORMAL'
     and public.org_department__internal_has_active_membership(u.app_user_id, 'ACCOUNTING', v_today);

  with filtered_projects as (
    select p.*
      from public.direct_entry_projects p
     where v_search is null
        or p.project_id ilike '%' || v_search || '%'
        or p.display_name ilike '%' || v_search || '%'
  )
  select (select count(*)::integer from filtered_projects),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'project_id', fp.project_id,
                        'display_name', fp.display_name,
                        'active', fp.active,
                        'next_version', coalesce(ver.max_version, 0) + 1,
                        'transacted_vendor_count', coalesce(lnk.cnt, 0),
                        'current_assignment', cur_asg.item,
                        'assignments', asg_list.items
                      )
                      order by (not fp.active) asc, pg_catalog.lower(fp.display_name) asc, fp.project_id asc
                    )
               from (
                 select f.*
                   from filtered_projects f
                  order by (not f.active) asc, pg_catalog.lower(f.display_name) asc, f.project_id asc
                  limit p_page_size offset v_offset
               ) fp
               left join lateral (
                 select max(pa.version)::integer as max_version
                   from public.vendor_finance_project_accountants pa
                  where pa.project_id = fp.project_id
               ) ver on true
               left join lateral (
                 select count(distinct e.vendor_id)::integer as cnt
                   from public.vendor_finance_entries e
                  where e.project_id = fp.project_id
                    and e.ledger_scope = 'PROJECT_ACCOUNTANT'
               ) lnk on true
               left join lateral (
                 select pg_catalog.jsonb_build_object(
                          'assignment_id', pa.assignment_id,
                          'project_id', pa.project_id,
                          'version', coalesce(ver.max_version, pa.version),
                          'accountant', public.org_department__internal_account_summary(pa.accountant_user_id),
                          'accountant_in_accounting_department', public.org_department__internal_has_active_membership(
                            pa.accountant_user_id, 'ACCOUNTING', v_today
                          ),
                          'valid_from', pa.valid_from::text,
                          'valid_to', case when pa.valid_to is null then null else pa.valid_to::text end,
                          'state', case
                            when pa.valid_to is not null and pa.valid_to = pa.valid_from then 'CANCELLED'
                            when pa.valid_to is not null and pa.valid_to <= v_today then 'ENDED'
                            when pa.valid_from > v_today then 'SCHEDULED'
                            else 'ACTIVE'
                          end,
                          'assign_reason', pa.assign_reason,
                          'end_reason', pa.end_reason,
                          'created_at', pg_catalog.to_jsonb(pa.created_at)
                        ) as item
                   from public.vendor_finance_project_accountants pa
                  where pa.project_id = fp.project_id
                    and pa.valid_to is null
                  limit 1
               ) cur_asg on true
               left join lateral (
                 select coalesce(
                          pg_catalog.jsonb_agg(
                            pg_catalog.jsonb_build_object(
                              'assignment_id', pa.assignment_id,
                              'project_id', pa.project_id,
                              'version', coalesce(ver.max_version, pa.version),
                              'accountant', public.org_department__internal_account_summary(pa.accountant_user_id),
                              'accountant_in_accounting_department', public.org_department__internal_has_active_membership(
                                pa.accountant_user_id, 'ACCOUNTING', v_today
                              ),
                              'valid_from', pa.valid_from::text,
                              'valid_to', case when pa.valid_to is null then null else pa.valid_to::text end,
                              'state', case
                                when pa.valid_to is not null and pa.valid_to = pa.valid_from then 'CANCELLED'
                                when pa.valid_to is not null and pa.valid_to <= v_today then 'ENDED'
                                when pa.valid_from > v_today then 'SCHEDULED'
                                else 'ACTIVE'
                              end,
                              'assign_reason', pa.assign_reason,
                              'end_reason', pa.end_reason,
                              'created_at', pg_catalog.to_jsonb(pa.created_at)
                            )
                            order by pa.version desc
                          ),
                          '[]'::jsonb
                        ) as items
                   from public.vendor_finance_project_accountants pa
                  where pa.project_id = fp.project_id
                    and (p_include_history or pa.valid_to is null)
               ) asg_list on true
           ),
           '[]'::jsonb
         )
    into v_total, v_projects;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_today::text,
    'eligible_accountants', v_eligible,
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'projects', v_projects
  );
end;
$function$;

revoke all on function public.vendor_finance_list_project_accountants_admin(uuid, uuid, text, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_list_project_accountants_admin(uuid, uuid, text, boolean, integer, integer)
  to service_role;

create or replace function public.vendor_finance_assign_project_accountant_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_accountant_user_id uuid,
  p_expected_version integer,
  p_valid_from date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_valid_from date;
  v_reason text;
  v_max_version integer;
  v_inserted public.vendor_finance_project_accountants%rowtype;
  v_base_payload jsonb;
begin
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');
  v_today := public.direct_entry_authorization_date();

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'ASSIGN_PROJECT_ACCOUNTANT'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_accountant_user_id is null or p_expected_version is null or p_expected_version < 0 then
    raise exception 'VENDOR_FINANCE_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  v_valid_from := coalesce(p_valid_from, v_today);
  if v_valid_from <> v_today
     or pg_catalog.date_part('year', v_valid_from)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  -- Canonical DAG [2]+[3]: projects FOR SHARE -> vfin_project adv lock
  v_project := public.vendor_finance__internal_lock_project(p_project_id);

  -- Canonical DAG [5]: lock actor & target in ascending app_user_id order FOR SHARE
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id in (p_app_user_id, p_accountant_user_id)
   order by u.app_user_id asc
   for share;

  -- Re-assert caller admin authority & target eligibility under lock
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');

  if not v_project.active then
    raise exception 'VENDOR_FINANCE_PROJECT_INACTIVE'
      using errcode = '42200';
  end if;

  select u.*
    into v_target_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_accountant_user_id;

  if not found
     or not v_target_user.enabled
     or coalesce(v_target_user.account_type, 'NORMAL') <> 'NORMAL'
     or not public.org_department__internal_has_active_membership(p_accountant_user_id, 'ACCOUNTING', v_today) then
    raise exception 'VENDOR_FINANCE_ACCOUNTANT_NOT_ELIGIBLE'
      using errcode = '42200';
  end if;

  select coalesce(max(pa.version), 0)::integer
    into v_max_version
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_project.project_id;

  if v_max_version <> p_expected_version then
    raise exception 'VENDOR_FINANCE_ASSIGNMENT_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1
      from public.vendor_finance_project_accountants pa
     where pa.project_id = v_project.project_id
       and pa.valid_to is null
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ALREADY_ASSIGNED'
      using errcode = '23505';
  end if;

  perform pg_catalog.set_config('vendor_finance.admin_write_marker', 'on', true);

  insert into public.vendor_finance_project_accountants (
    project_id,
    accountant_user_id,
    version,
    valid_from,
    assigned_by_user_id,
    assign_reason
  ) values (
    v_project.project_id,
    p_accountant_user_id,
    v_max_version + 1,
    v_valid_from,
    p_app_user_id,
    v_reason
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    project_id,
    project_accountant_assignment_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_project.project_id,
    v_inserted.assignment_id,
    p_app_user_id,
    'full_admin',
    'PROJECT_ACCOUNTANT_ASSIGNED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'accountant_user_id', v_inserted.accountant_user_id,
      'valid_from', v_inserted.valid_from::text,
      'version', v_inserted.version
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'assignment_id', v_inserted.assignment_id,
    'project_id', v_inserted.project_id,
    'version', v_inserted.version
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ASSIGN_PROJECT_ACCOUNTANT',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_end_project_accountant_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_assignment_id uuid,
  p_expected_version integer,
  p_valid_to date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_target public.vendor_finance_project_accountants%rowtype;
  v_max_version integer;
  v_valid_to date;
  v_reason text;
  v_updated public.vendor_finance_project_accountants%rowtype;
  v_base_payload jsonb;
begin
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');
  v_today := public.direct_entry_authorization_date();

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'END_PROJECT_ACCOUNTANT'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_assignment_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'VENDOR_FINANCE_ASSIGNMENT_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  select pa.*
    into v_target
    from public.vendor_finance_project_accountants pa
   where pa.assignment_id = p_assignment_id;

  if not found then
    raise exception 'VENDOR_FINANCE_ASSIGNMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- Canonical DAG [2]+[3]: projects FOR SHARE -> vfin_project adv lock
  perform public.vendor_finance__internal_lock_project(v_target.project_id);

  -- Canonical DAG [5]: lock actor & target PA in ascending app_user_id order FOR SHARE
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id in (p_app_user_id, v_target.accountant_user_id)
   order by u.app_user_id asc
   for share;

  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');

  select pa.*
    into v_target
    from public.vendor_finance_project_accountants pa
   where pa.assignment_id = p_assignment_id;

  select coalesce(max(pa.version), 0)::integer
    into v_max_version
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_target.project_id;

  if v_target.valid_to is not null or v_max_version <> p_expected_version then
    raise exception 'VENDOR_FINANCE_ASSIGNMENT_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  v_valid_to := case
    when p_valid_to is null then greatest(v_today, v_target.valid_from)
    else p_valid_to
  end;
  if (p_valid_to is not null and p_valid_to <> v_today)
     or v_valid_to < v_target.valid_from
     or pg_catalog.date_part('year', v_valid_to)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.set_config('vendor_finance.admin_write_marker', 'on', true);

  update public.vendor_finance_project_accountants pa
     set valid_to = v_valid_to,
         ended_by_user_id = p_app_user_id,
         ended_at = now(),
         end_reason = v_reason,
         updated_at = now()
   where pa.assignment_id = v_target.assignment_id
  returning * into v_updated;

  insert into public.vendor_finance_audit_events (
    project_id,
    project_accountant_assignment_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_updated.project_id,
    v_updated.assignment_id,
    p_app_user_id,
    'full_admin',
    'PROJECT_ACCOUNTANT_ENDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'accountant_user_id', v_updated.accountant_user_id,
      'valid_from', v_updated.valid_from::text,
      'valid_to', v_updated.valid_to::text,
      'version', v_max_version
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'assignment_id', v_updated.assignment_id,
    'project_id', v_updated.project_id,
    'valid_to', v_updated.valid_to::text
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'END_PROJECT_ACCOUNTANT',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_list_global_roles_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_search text default null,
  p_include_history boolean default true,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_search text := null;
  v_offset integer;
  v_total integer;
  v_roles jsonb;
  v_candidates jsonb;
begin
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');
  v_today := public.direct_entry_authorization_date();

  if p_include_history is null
     or p_page is null or p_page < 1 or p_page > 1000
     or p_page_size is null or p_page_size < 1 or p_page_size > 100 then
    raise exception 'VENDOR_FINANCE_QUERY_INVALID'
      using errcode = '22023';
  end if;

  if p_search is not null then
    v_search := pg_catalog.btrim(p_search);
    if v_search = '' or pg_catalog.length(v_search) > 120 or v_search ~ '[\x00-\x1F\x7F]' then
      raise exception 'VENDOR_FINANCE_SEARCH_INVALID'
        using errcode = '22023';
    end if;
  end if;

  v_offset := (p_page - 1) * p_page_size;

  with role_rows as (
    select gr.*,
           public.org_department__internal_account_summary(gr.app_user_id) as acct_summary,
           (
             select max(gr2.version)::integer
               from public.vendor_finance_global_roles gr2
              where gr2.app_user_id = gr.app_user_id
           ) as pair_version
      from public.vendor_finance_global_roles gr
     where p_include_history or gr.valid_to is null
  ),
  filtered as (
    select rr.*
      from role_rows rr
     where v_search is null
        or coalesce(rr.acct_summary->>'display_name', '') ilike '%' || v_search || '%'
        or coalesce(rr.acct_summary->>'login_id', '') ilike '%' || v_search || '%'
        or coalesce(rr.acct_summary->>'personnel_code', '') ilike '%' || v_search || '%'
  )
  select (select count(*)::integer from filtered),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'role_grant_id', page_row.role_grant_id,
                        'account', page_row.acct_summary,
                        'role_code', page_row.role_code,
                        'version', page_row.pair_version,
                        'valid_from', page_row.valid_from::text,
                        'valid_to', case when page_row.valid_to is null then null else page_row.valid_to::text end,
                        'state', case
                          when page_row.valid_to is not null and page_row.valid_to = page_row.valid_from then 'CANCELLED'
                          when page_row.valid_to is not null and page_row.valid_to <= v_today then 'ENDED'
                          when page_row.valid_from > v_today then 'SCHEDULED'
                          else 'ACTIVE'
                        end,
                        'grant_reason', page_row.grant_reason,
                        'end_reason', page_row.end_reason,
                        'created_at', pg_catalog.to_jsonb(page_row.created_at)
                      )
                      order by (page_row.valid_to is not null) asc, page_row.created_at desc, page_row.role_grant_id desc
                    )
               from (
                 select f.*
                   from filtered f
                  order by (f.valid_to is not null) asc, f.created_at desc, f.role_grant_id desc
                  limit p_page_size offset v_offset
               ) page_row
           ),
           '[]'::jsonb
         )
    into v_total, v_roles;

  select coalesce(
           pg_catalog.jsonb_agg(
             pg_catalog.jsonb_build_object(
               'account', c.acct_summary,
               'next_version', coalesce(c.max_version, 0) + 1,
               'has_open_role', c.has_open_role
             )
             order by pg_catalog.lower(coalesce(c.acct_summary->>'display_name', '')), (c.acct_summary->>'account_ref')
           ),
           '[]'::jsonb
         )
    into v_candidates
    from (
      select public.org_department__internal_account_summary(u.app_user_id) as acct_summary,
             (
               select max(gr.version)::integer
                 from public.vendor_finance_global_roles gr
                where gr.app_user_id = u.app_user_id
             ) as max_version,
             exists (
               select 1
                 from public.vendor_finance_global_roles gr
                where gr.app_user_id = u.app_user_id
                  and gr.valid_to is null
             ) as has_open_role
        from public.direct_entry_app_users u
       where u.enabled = true
         and u.account_type = 'NORMAL'
    ) c
   where not c.has_open_role
     and (
       v_search is null
       or coalesce(c.acct_summary->>'display_name', '') ilike '%' || v_search || '%'
       or coalesce(c.acct_summary->>'login_id', '') ilike '%' || v_search || '%'
       or coalesce(c.acct_summary->>'personnel_code', '') ilike '%' || v_search || '%'
     )
   limit 50;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_today::text,
    'page', p_page,
    'page_size', p_page_size,
    'total', coalesce(v_total, 0),
    'has_more', (v_offset + p_page_size) < coalesce(v_total, 0),
    'roles', v_roles,
    'candidates', v_candidates
  );
end;
$function$;

revoke all on function public.vendor_finance_list_global_roles_admin(uuid, uuid, text, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_list_global_roles_admin(uuid, uuid, text, boolean, integer, integer)
  to service_role;

create or replace function public.vendor_finance_assign_global_role_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_user_id uuid,
  p_role_code text,
  p_expected_version integer,
  p_valid_from date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_target_user public.direct_entry_app_users%rowtype;
  v_valid_from date;
  v_reason text;
  v_max_version integer;
  v_inserted public.vendor_finance_global_roles%rowtype;
  v_base_payload jsonb;
begin
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');
  v_today := public.direct_entry_authorization_date();

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'ASSIGN_GLOBAL_ROLE'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_target_user_id is null
     or p_role_code is null
     or p_role_code not in ('GLOBAL_VIEWER', 'GLOBAL_RECONCILER', 'CASH_HOLDER', 'CASH_HOLDER_RECORD_BEHALF')
     or p_expected_version is null or p_expected_version < 0 then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_INVALID'
      using errcode = '22023';
  end if;

  v_valid_from := coalesce(p_valid_from, v_today);
  if v_valid_from <> v_today
     or pg_catalog.date_part('year', v_valid_from)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  -- Canonical DAG [4]: lock target global role slot
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_global_role:' || p_target_user_id::text, 0)
  );

  -- Canonical DAG [5]: lock actor & target in ascending app_user_id order FOR SHARE
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id in (p_app_user_id, p_target_user_id)
   order by u.app_user_id asc
   for share;

  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');

  select u.*
    into v_target_user
    from public.direct_entry_app_users u
   where u.app_user_id = p_target_user_id;

  if not found
     or not v_target_user.enabled
     or coalesce(v_target_user.account_type, 'NORMAL') <> 'NORMAL' then
    raise exception 'VENDOR_FINANCE_ACCOUNT_NOT_ELIGIBLE'
      using errcode = '42200';
  end if;

  select coalesce(max(gr.version), 0)::integer
    into v_max_version
    from public.vendor_finance_global_roles gr
   where gr.app_user_id = p_target_user_id;

  if v_max_version <> p_expected_version then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1
      from public.vendor_finance_global_roles gr
     where gr.app_user_id = p_target_user_id
       and gr.valid_to is null
  ) then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_ALREADY_ASSIGNED'
      using errcode = '23505';
  end if;

  perform pg_catalog.set_config('vendor_finance.admin_write_marker', 'on', true);

  insert into public.vendor_finance_global_roles (
    app_user_id,
    role_code,
    version,
    valid_from,
    granted_by_user_id,
    grant_reason
  ) values (
    p_target_user_id,
    p_role_code,
    v_max_version + 1,
    v_valid_from,
    p_app_user_id,
    v_reason
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    global_role_grant_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_inserted.role_grant_id,
    p_app_user_id,
    'full_admin',
    'GLOBAL_ROLE_ASSIGNED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'target_user_id', v_inserted.app_user_id,
      'role_code', v_inserted.role_code,
      'valid_from', v_inserted.valid_from::text,
      'version', v_inserted.version
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'role_grant_id', v_inserted.role_grant_id,
    'account_ref', v_inserted.app_user_id,
    'role_code', v_inserted.role_code,
    'version', v_inserted.version
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'ASSIGN_GLOBAL_ROLE',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_end_global_role_admin(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_role_grant_id uuid,
  p_expected_version integer,
  p_valid_to date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_today date;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_target public.vendor_finance_global_roles%rowtype;
  v_max_version integer;
  v_valid_to date;
  v_reason text;
  v_updated public.vendor_finance_global_roles%rowtype;
  v_base_payload jsonb;
begin
  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');
  v_today := public.direct_entry_authorization_date();

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'END_GLOBAL_ROLE'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_role_grant_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  select gr.*
    into v_target
    from public.vendor_finance_global_roles gr
   where gr.role_grant_id = p_role_grant_id;

  if not found then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- Canonical DAG [4]: lock target global role slot
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_global_role:' || v_target.app_user_id::text, 0)
  );

  -- Canonical DAG [5]: lock actor & target in ascending app_user_id order FOR SHARE
  perform u.app_user_id
    from public.direct_entry_app_users u
   where u.app_user_id in (p_app_user_id, v_target.app_user_id)
   order by u.app_user_id asc
   for share;

  perform public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'admin');

  select gr.*
    into v_target
    from public.vendor_finance_global_roles gr
   where gr.role_grant_id = p_role_grant_id;

  select coalesce(max(gr.version), 0)::integer
    into v_max_version
    from public.vendor_finance_global_roles gr
   where gr.app_user_id = v_target.app_user_id;

  if v_target.valid_to is not null or v_max_version <> p_expected_version then
    raise exception 'VENDOR_FINANCE_GLOBAL_ROLE_VERSION_CONFLICT'
      using errcode = 'PT409';
  end if;

  v_valid_to := case
    when p_valid_to is null then greatest(v_today, v_target.valid_from)
    else p_valid_to
  end;
  if (p_valid_to is not null and p_valid_to <> v_today)
     or v_valid_to < v_target.valid_from
     or pg_catalog.date_part('year', v_valid_to)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.set_config('vendor_finance.admin_write_marker', 'on', true);

  update public.vendor_finance_global_roles gr
     set valid_to = v_valid_to,
         ended_by_user_id = p_app_user_id,
         ended_at = now(),
         end_reason = v_reason,
         updated_at = now()
   where gr.role_grant_id = v_target.role_grant_id
  returning * into v_updated;

  insert into public.vendor_finance_audit_events (
    global_role_grant_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_updated.role_grant_id,
    p_app_user_id,
    'full_admin',
    'GLOBAL_ROLE_ENDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'target_user_id', v_updated.app_user_id,
      'role_code', v_updated.role_code,
      'valid_to', v_updated.valid_to::text,
      'version', v_max_version
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'role_grant_id', v_updated.role_grant_id,
    'account_ref', v_updated.app_user_id,
    'valid_to', v_updated.valid_to::text
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'END_GLOBAL_ROLE',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_get_monthly_report(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_month text,
  p_project_id text default null,
  p_accountant_user_id uuid default null,
  p_vendor_id text default null,
  p_contract_type text default 'all'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_vis text;
  v_today date;
  v_month_start date;
  v_month_end date;
  v_totals jsonb;
  v_project_summaries jsonb;
  v_rows jsonb;
  v_legacy_rows jsonb := '[]'::jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');
  v_vis := v_auth->>'visibility_scope';
  v_today := (v_auth->>'authorization_date')::date;

  if p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  if p_contract_type is null or p_contract_type not in ('all', 'SEASONAL', 'OFFICIAL', 'UNCLASSIFIED') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  v_month_start := pg_catalog.to_date(p_month || '-01', 'YYYY-MM-DD');
  if pg_catalog.date_part('year', v_month_start)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;
  v_month_end := (v_month_start + interval '1 month')::date;

  if p_project_id is not null and p_project_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
    raise exception 'VENDOR_FINANCE_PROJECT_INVALID'
      using errcode = '22023';
  end if;

  if p_vendor_id is not null and (
    p_vendor_id = '__system_vendor__'
    or p_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'
  ) then
    raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
      using errcode = '22023';
  end if;

  if v_vis = 'PROJECT_SCOPED' then
    if p_accountant_user_id is not null and p_accountant_user_id <> p_app_user_id then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;

    if p_project_id is not null and not exists (
      select 1
        from public.vendor_finance_project_accountants pa
       where pa.project_id = p_project_id
         and pa.accountant_user_id = p_app_user_id
         and pa.valid_from <= v_today
         and (pa.valid_to is null or pa.valid_to > v_today)
         and (pa.valid_to is null or pa.valid_to > pa.valid_from)
         and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
      union all
      select 1
        from public.vendor_finance_entries e
       where e.ledger_scope = 'PROJECT_ACCOUNTANT'
         and e.project_id = p_project_id
         and e.responsible_accountant_user_id = p_app_user_id
      union all
      select 1
        from public.vendor_finance_reconciliations r
       where r.ledger_scope = 'PROJECT_ACCOUNTANT'
         and r.project_id = p_project_id
         and r.responsible_accountant_user_id = p_app_user_id
    ) then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
  end if;

  with active_assignments as (
    select pa.project_id,
           pa.accountant_user_id
      from public.vendor_finance_project_accountants pa
      join public.direct_entry_app_users u
        on u.app_user_id = pa.accountant_user_id
       and u.enabled = true
       and u.account_type = 'NORMAL'
     where pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from)
       and public.org_department__internal_has_active_membership(pa.accountant_user_id, 'ACCOUNTING', v_today)
  ),
  candidate_books as (
    select distinct
           src.project_id,
           src.accountant_user_id,
           src.vendor_id,
           src.contract_type
      from (
        select e.project_id,
               e.responsible_accountant_user_id as accountant_user_id,
               e.vendor_id,
               e.contract_type
          from public.vendor_finance_entries e
         where e.ledger_scope = 'PROJECT_ACCOUNTANT'
        union
        select r.project_id,
               r.responsible_accountant_user_id as accountant_user_id,
               r.vendor_id,
               r.contract_type
          from public.vendor_finance_reconciliations r
         where r.ledger_scope = 'PROJECT_ACCOUNTANT'
      ) src
     where (v_vis = 'ALL' or src.accountant_user_id = p_app_user_id)
       and (p_project_id is null or src.project_id = p_project_id)
       and (p_accountant_user_id is null or src.accountant_user_id = p_accountant_user_id)
       and (p_vendor_id is null or src.vendor_id = p_vendor_id)
       and (p_contract_type = 'all' or src.contract_type = p_contract_type)
  ),
  entry_flags as (
    select e.*,
           exists (
             select 1
               from public.vendor_finance_entries rev
              where rev.reverses_entry_id = e.entry_id
           ) as is_reversed
      from public.vendor_finance_entries e
     where e.ledger_scope = 'PROJECT_ACCOUNTANT'
       and (v_vis = 'ALL' or e.responsible_accountant_user_id = p_app_user_id)
       and (p_project_id is null or e.project_id = p_project_id)
       and (p_accountant_user_id is null or e.responsible_accountant_user_id = p_accountant_user_id)
       and (p_vendor_id is null or e.vendor_id = p_vendor_id)
       and (p_contract_type = 'all' or e.contract_type = p_contract_type)
  ),
  book_metrics as (
    select cb.project_id,
           p.display_name as project_display_name,
           p.active as project_active,
           cb.accountant_user_id,
           public.vendor_finance__internal_actor_display_name(cb.accountant_user_id) as accountant_display_name,
           coalesce(aa.accountant_user_id = cb.accountant_user_id, false) as is_currently_assigned,
           cb.vendor_id,
           v.display_name as vendor_display_name,
           v.active as vendor_active,
           cb.contract_type,
           coalesce(sum(ef.balance_delta_minor::numeric) filter (where ef.effective_date < v_month_start), 0::numeric) as before_month_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'OPENING_PAYABLE'
               and not ef.is_reversed
           ), 0::numeric) as opening_payable_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'OPENING_ADVANCE'
               and not ef.is_reversed
           ), 0::numeric) as opening_advance_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type in ('DEBT_RECORDED', 'PAYROLL_RECORDED', 'ADJUSTMENT_INCREASE')
               and not ef.is_reversed
           ), 0::numeric) as obligations_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type in ('PAYMENT_RECORDED', 'ADJUSTMENT_DECREASE')
               and not ef.is_reversed
           ), 0::numeric) as paid_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'ADVANCE_RECORDED'
               and not ef.is_reversed
           ), 0::numeric) as advanced_num,
           coalesce(sum(ef.amount_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
               and ef.entry_type = 'ADVANCE_OFFSET_RECORDED'
               and not ef.is_reversed
           ), 0::numeric) as advance_offset_num,
           coalesce(sum(ef.balance_delta_minor::numeric) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
           ), 0::numeric) as net_change_num,
           coalesce(sum(ef.balance_delta_minor::numeric) filter (
             where ef.effective_date < v_month_end
           ), 0::numeric) as closing_num,
           coalesce(sum(ef.balance_delta_minor::numeric), 0::numeric) as current_num,
           count(ef.entry_id) filter (
             where ef.effective_date >= v_month_start
               and ef.effective_date < v_month_end
           )::integer as in_month_entry_count,
           count(ef.entry_id)::integer as total_entry_count
      from candidate_books cb
      join public.direct_entry_projects p on p.project_id = cb.project_id
      join public.vendors v on v.vendor_id = cb.vendor_id
      left join active_assignments aa on aa.project_id = cb.project_id
      left join entry_flags ef
        on ef.project_id = cb.project_id
       and ef.responsible_accountant_user_id = cb.accountant_user_id
       and ef.vendor_id = cb.vendor_id
       and ef.contract_type = cb.contract_type
     group by cb.project_id, p.display_name, p.active,
              cb.accountant_user_id, aa.accountant_user_id,
              cb.vendor_id, v.display_name, v.active,
              cb.contract_type
  ),
  book_metrics_enriched as (
    select bm.*,
           (bm.paid_num + bm.advanced_num) as paid_and_advanced_num,
           greatest(bm.closing_num, 0::numeric) as closing_payable_num,
           greatest(-bm.closing_num, 0::numeric) as closing_advance_num
      from book_metrics bm
  ),
  pa_groups as (
    select bme.project_id,
           bme.project_display_name,
           bme.project_active,
           bme.accountant_user_id,
           bme.accountant_display_name,
           bme.is_currently_assigned,
           bme.contract_type,
           count(*)::integer as vendor_count,
           coalesce(sum(bme.obligations_num), 0::numeric) as obligations_num,
           coalesce(sum(bme.paid_num), 0::numeric) as paid_num,
           coalesce(sum(bme.advanced_num), 0::numeric) as advanced_num,
           coalesce(sum(bme.advance_offset_num), 0::numeric) as advance_offset_num,
           coalesce(sum(bme.paid_and_advanced_num), 0::numeric) as paid_and_advanced_num,
           coalesce(sum(bme.closing_payable_num), 0::numeric) as closing_payable_num,
           coalesce(sum(bme.closing_advance_num), 0::numeric) as closing_advance_num,
           coalesce(sum(bme.in_month_entry_count), 0)::integer as in_month_entry_count
      from book_metrics_enriched bme
     group by bme.project_id, bme.project_display_name, bme.project_active,
              bme.accountant_user_id, bme.accountant_display_name, bme.is_currently_assigned,
              bme.contract_type
  )
  select pg_catalog.jsonb_build_object(
           'project_revenue_status', 'MISSING_CANONICAL_SOURCE',
           'project_revenue_minor', null,
           'project_accountant_book_count', (select count(*)::integer from pa_groups),
           'sub_ledger_count', (select count(*)::integer from book_metrics_enriched),
           'obligations_in_month_minor', pg_catalog.trunc(coalesce((select sum(obligations_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'paid_in_month_minor', pg_catalog.trunc(coalesce((select sum(paid_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'advanced_in_month_minor', pg_catalog.trunc(coalesce((select sum(advanced_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'advance_offset_in_month_minor', pg_catalog.trunc(coalesce((select sum(advance_offset_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'paid_and_advanced_in_month_minor', pg_catalog.trunc(coalesce((select sum(paid_and_advanced_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'closing_payable_minor', pg_catalog.trunc(coalesce((select sum(closing_payable_num) from book_metrics_enriched), 0::numeric), 0)::text,
           'closing_advance_minor', pg_catalog.trunc(coalesce((select sum(closing_advance_num) from book_metrics_enriched), 0::numeric), 0)::text
         ),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'project_id', pg.project_id,
                        'project_display_name', pg.project_display_name,
                        'project_active', pg.project_active,
                        'accountant_ref', pg.accountant_user_id,
                        'responsible_accountant_display_name', pg.accountant_display_name,
                        'is_currently_assigned', pg.is_currently_assigned,
                        'contract_type', pg.contract_type,
                        'project_revenue_status', 'MISSING_CANONICAL_SOURCE',
                        'project_revenue_minor', null,
                        'vendor_count', pg.vendor_count,
                        'obligations_in_month_minor', pg_catalog.trunc(pg.obligations_num, 0)::text,
                        'paid_in_month_minor', pg_catalog.trunc(pg.paid_num, 0)::text,
                        'advanced_in_month_minor', pg_catalog.trunc(pg.advanced_num, 0)::text,
                        'advance_offset_in_month_minor', pg_catalog.trunc(pg.advance_offset_num, 0)::text,
                        'paid_and_advanced_in_month_minor', pg_catalog.trunc(pg.paid_and_advanced_num, 0)::text,
                        'closing_payable_minor', pg_catalog.trunc(pg.closing_payable_num, 0)::text,
                        'closing_advance_minor', pg_catalog.trunc(pg.closing_advance_num, 0)::text,
                        'in_month_entry_count', pg.in_month_entry_count
                      )
                      order by
                        (not pg.is_currently_assigned) asc,
                        pg_catalog.lower(pg.project_display_name) asc,
                        pg.project_id asc,
                        pg_catalog.lower(pg.accountant_display_name) asc,
                        case pg.contract_type
                          when 'SEASONAL' then 1
                          when 'OFFICIAL' then 2
                          else 3
                        end asc
                    )
               from pa_groups pg
           ),
           '[]'::jsonb
         ),
         coalesce(
           (
             select pg_catalog.jsonb_agg(
                      pg_catalog.jsonb_build_object(
                        'project_id', r.project_id,
                        'project_display_name', r.project_display_name,
                        'project_active', r.project_active,
                        'accountant_ref', r.accountant_user_id,
                        'responsible_accountant_display_name', r.accountant_display_name,
                        'is_currently_assigned', r.is_currently_assigned,
                        'vendor_id', r.vendor_id,
                        'vendor_display_name', r.vendor_display_name,
                        'vendor_active', r.vendor_active,
                        'contract_type', r.contract_type,
                        'project_revenue_status', 'MISSING_CANONICAL_SOURCE',
                        'project_revenue_minor', null,
                        'balance_before_month_minor', pg_catalog.trunc(r.before_month_num, 0)::text,
                        'opening_payable_in_month_minor', pg_catalog.trunc(r.opening_payable_num, 0)::text,
                        'opening_advance_in_month_minor', pg_catalog.trunc(r.opening_advance_num, 0)::text,
                        'obligations_in_month_minor', pg_catalog.trunc(r.obligations_num, 0)::text,
                        'paid_in_month_minor', pg_catalog.trunc(r.paid_num, 0)::text,
                        'advanced_in_month_minor', pg_catalog.trunc(r.advanced_num, 0)::text,
                        'advance_offset_in_month_minor', pg_catalog.trunc(r.advance_offset_num, 0)::text,
                        'paid_and_advanced_in_month_minor', pg_catalog.trunc(r.paid_and_advanced_num, 0)::text,
                        'net_change_in_month_minor', pg_catalog.trunc(r.net_change_num, 0)::text,
                        'closing_balance_minor', pg_catalog.trunc(r.closing_num, 0)::text,
                        'closing_direction', case
                          when r.closing_num > 0 then 'PAYABLE'
                          when r.closing_num < 0 then 'ADVANCE'
                          else 'BALANCED'
                        end,
                        'closing_payable_minor', pg_catalog.trunc(r.closing_payable_num, 0)::text,
                        'closing_advance_minor', pg_catalog.trunc(r.closing_advance_num, 0)::text,
                        'current_balance_minor', pg_catalog.trunc(r.current_num, 0)::text,
                        'in_month_entry_count', r.in_month_entry_count,
                        'total_entry_count', r.total_entry_count
                      )
                      order by
                        (not r.is_currently_assigned) asc,
                        pg_catalog.lower(r.project_display_name) asc,
                        r.project_id asc,
                        pg_catalog.lower(r.accountant_display_name) asc,
                        case r.contract_type
                          when 'SEASONAL' then 1
                          when 'OFFICIAL' then 2
                          else 3
                        end asc,
                        pg_catalog.abs(r.closing_num) desc,
                        pg_catalog.lower(r.vendor_display_name) asc,
                        r.vendor_id asc
                    )
               from book_metrics_enriched r
           ),
           '[]'::jsonb
         )
    into v_totals, v_project_summaries, v_rows;

  if v_vis = 'ALL'
     and p_project_id is null
     and p_accountant_user_id is null
     and p_contract_type in ('all', 'UNCLASSIFIED') then
    with legacy_flags as (
      select e.*,
             exists (
               select 1
                 from public.vendor_finance_entries rev
                where rev.reverses_entry_id = e.entry_id
             ) as is_reversed
        from public.vendor_finance_entries e
       where e.ledger_scope = 'LEGACY_UNALLOCATED'
         and (p_vendor_id is null or e.vendor_id = p_vendor_id)
    ),
    legacy_books as (
      select lf.vendor_id,
             v.display_name as vendor_display_name,
             v.active as vendor_active,
             coalesce(sum(lf.balance_delta_minor::numeric) filter (where lf.effective_date < v_month_start), 0::numeric) as before_month_num,
             coalesce(sum(lf.amount_minor::numeric) filter (
               where lf.effective_date >= v_month_start
                 and lf.effective_date < v_month_end
                 and lf.entry_type in ('DEBT_RECORDED', 'PAYROLL_RECORDED', 'ADJUSTMENT_INCREASE')
                 and not lf.is_reversed
             ), 0::numeric) as obligations_num,
             coalesce(sum(lf.amount_minor::numeric) filter (
               where lf.effective_date >= v_month_start
                 and lf.effective_date < v_month_end
                 and lf.entry_type in ('PAYMENT_RECORDED', 'ADVANCE_RECORDED', 'ADJUSTMENT_DECREASE')
                 and not lf.is_reversed
             ), 0::numeric) as paid_and_advanced_num,
             coalesce(sum(lf.balance_delta_minor::numeric) filter (where lf.effective_date < v_month_end), 0::numeric) as closing_num,
             count(*) filter (where lf.effective_date >= v_month_start and lf.effective_date < v_month_end)::integer as in_month_entry_count
        from legacy_flags lf
        join public.vendors v on v.vendor_id = lf.vendor_id
       group by lf.vendor_id, v.display_name, v.active
    )
    select coalesce(
             pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'vendor_id', lb.vendor_id,
                 'vendor_display_name', lb.vendor_display_name,
                 'vendor_active', lb.vendor_active,
                 'balance_before_month_minor', pg_catalog.trunc(lb.before_month_num, 0)::text,
                 'obligations_in_month_minor', pg_catalog.trunc(lb.obligations_num, 0)::text,
                 'paid_and_advanced_in_month_minor', pg_catalog.trunc(lb.paid_and_advanced_num, 0)::text,
                 'closing_balance_minor', pg_catalog.trunc(lb.closing_num, 0)::text,
                 'closing_direction', case
                   when lb.closing_num > 0 then 'PAYABLE'
                   when lb.closing_num < 0 then 'ADVANCE'
                   else 'BALANCED'
                 end,
                 'in_month_entry_count', lb.in_month_entry_count
               )
               order by pg_catalog.abs(lb.closing_num) desc, pg_catalog.lower(lb.vendor_display_name) asc, lb.vendor_id asc
             ),
             '[]'::jsonb
           )
      into v_legacy_rows
      from legacy_books lb;
  end if;

  return pg_catalog.jsonb_build_object(
    'authorization_date', v_auth->>'authorization_date',
    'allowed_actions', pg_catalog.jsonb_build_object(
      'visibility_scope', v_vis,
      'can_view', true,
      'can_record', coalesce((v_auth->>'can_record')::boolean, false),
      'can_reconcile', coalesce((v_auth->>'can_reconcile')::boolean, false),
      'can_manage_project_assignments', coalesce((v_auth->>'can_manage_project_assignments')::boolean, false),
      'can_view_shared_advance', coalesce((v_auth->>'can_view_shared_advance')::boolean, false),
      'can_fund_vendor_advance', coalesce((v_auth->>'can_fund_vendor_advance')::boolean, false),
      'can_record_vendor_refund', coalesce((v_auth->>'can_record_vendor_refund')::boolean, false),
      'can_apply_vendor_advance', coalesce((v_auth->>'can_apply_vendor_advance')::boolean, false),
      'active_assigned_project_count', coalesce((v_auth->>'active_assigned_project_count')::integer, 0)
    ),
    'filters', pg_catalog.jsonb_build_object(
      'month', p_month,
      'project_id', p_project_id,
      'accountant_ref', p_accountant_user_id,
      'vendor_id', p_vendor_id,
      'contract_type', p_contract_type
    ),
    'totals', v_totals,
    'project_accountant_summaries', v_project_summaries,
    'rows', v_rows,
    'legacy_unallocated_rows', v_legacy_rows
  );
end;
$function$;

revoke all on function public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text, text)
  to service_role;

-- -----------------------------------------------------------------------------
-- 5. Vendor Finance Transactional Write RPCs (Canonical Lock DAG + Locked Re-Assert)
-- -----------------------------------------------------------------------------

create or replace function public.vendor_finance_record_entry(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_project_id text,
  p_contract_type text,
  p_entry_type text,
  p_amount_minor text,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_today date;
  v_record_scope text;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_pa_candidate_id uuid := null;
  v_vendor public.vendors%rowtype;
  v_proj_acct jsonb;
  v_active_acct_id uuid;
  v_active_acct_name text;
  v_has_entries boolean;
  v_amount bigint;
  v_delta bigint;
  v_reason text;
  v_actor_name text;
  v_prev_seq bigint;
  v_prev_balance bigint;
  v_next_seq bigint;
  v_after_balance bigint;
  v_doc_no text;
  v_inserted public.vendor_finance_entries%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'record');
  v_today := (v_auth->>'authorization_date')::date;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'RECORD_ENTRY'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_contract_type is null or p_contract_type not in ('SEASONAL', 'OFFICIAL') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if p_entry_type is null or p_entry_type not in (
    'DEBT_RECORDED',
    'PAYROLL_RECORDED',
    'PAYMENT_RECORDED',
    'ADVANCE_RECORDED',
    'ADJUSTMENT_INCREASE',
    'ADJUSTMENT_DECREASE'
  ) then
    raise exception 'VENDOR_FINANCE_ENTRY_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if p_entry_type = 'ADVANCE_RECORDED' then
    raise exception 'VENDOR_FINANCE_RECORD_DENIED'
      using errcode = '42501';
  end if;

  if p_effective_date is null
     or pg_catalog.date_part('year', p_effective_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_amount := public.vendor_finance__internal_parse_positive_minor(p_amount_minor);
  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  -- Canonical DAG: [2]+[3] project -> [4]+[5] actor (+ active PA) -> [6] vendor
  v_project := public.vendor_finance__internal_lock_project(p_project_id);

  select pa.accountant_user_id
    into v_pa_candidate_id
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_project.project_id
     and pa.valid_from <= v_today
     and (pa.valid_to is null or pa.valid_to > v_today)
     and (pa.valid_to is null or pa.valid_to > pa.valid_from)
   order by pa.valid_from desc, pa.version desc
   limit 1;

  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'record',
    array[v_pa_candidate_id]
  );
  v_today := (v_auth->>'authorization_date')::date;
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');
  v_authority_source := v_auth->>'authority_source';
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(v_project.project_id, v_today);

  if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
    if v_record_scope = 'ASSIGNED_PROJECTS' then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
      using errcode = '40900';
  end if;

  v_active_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
  v_active_acct_name := v_proj_acct->>'accountant_display_name';

  if v_record_scope = 'ASSIGNED_PROJECTS' and v_active_acct_id <> p_app_user_id then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  if not v_vendor.active or not v_project.active then
    select exists (
             select 1
               from public.vendor_finance_entries e
              where e.vendor_id = v_vendor.vendor_id
                and e.ledger_scope = 'PROJECT_ACCOUNTANT'
                and e.project_id = v_project.project_id
                and e.responsible_accountant_user_id = v_active_acct_id
                and e.contract_type = p_contract_type
           )
      into v_has_entries;

    if not v_has_entries then
      if not v_project.active then
        raise exception 'VENDOR_FINANCE_PROJECT_INACTIVE'
          using errcode = '42200';
      end if;
      raise exception 'VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN'
        using errcode = '23514';
    end if;

    if p_entry_type not in ('PAYMENT_RECORDED', 'ADJUSTMENT_INCREASE', 'ADJUSTMENT_DECREASE') then
      if not v_project.active then
        raise exception 'VENDOR_FINANCE_PROJECT_INACTIVE'
          using errcode = '42200';
      end if;
      raise exception 'VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN'
        using errcode = '23514';
    end if;
  end if;

  if p_entry_type in ('DEBT_RECORDED', 'PAYROLL_RECORDED', 'ADJUSTMENT_INCREASE') then
    v_delta := v_amount;
  else
    v_delta := -v_amount;
  end if;

  select e.vendor_sequence, e.balance_after_minor
    into v_prev_seq, v_prev_balance
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_active_acct_id
     and e.contract_type = p_contract_type
   order by e.vendor_sequence desc
   limit 1;

  if not found then
    v_prev_seq := 0;
    v_prev_balance := 0;
  end if;

  if p_entry_type = 'PAYMENT_RECORDED'
     and (v_prev_balance <= 0 or v_amount > v_prev_balance) then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE'
      using errcode = '23514';
  end if;

  v_next_seq := v_prev_seq + 1;
  v_after_balance := public.vendor_finance__internal_checked_add_minor(v_prev_balance, v_delta);
  v_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);

  perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);

  insert into public.vendor_finance_entries (
    vendor_id,
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    vendor_sequence,
    entry_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    vendor_display_name_snapshot,
    opening_batch_id,
    reverses_entry_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_project.display_name,
    v_active_acct_id,
    v_active_acct_name,
    p_contract_type,
    v_next_seq,
    p_entry_type,
    v_amount,
    v_delta,
    v_prev_balance,
    v_after_balance,
    p_effective_date,
    v_reason,
    v_doc_no,
    v_vendor.display_name,
    null,
    null,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    v_inserted.entry_id,
    p_app_user_id,
    v_authority_source,
    'ENTRY_RECORDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'document_no', v_inserted.document_no,
      'project_id', v_inserted.project_id,
      'responsible_accountant_user_id', v_inserted.responsible_accountant_user_id,
      'contract_type', v_inserted.contract_type,
      'entry_type', v_inserted.entry_type,
      'amount_minor', v_inserted.amount_minor::text,
      'balance_before_minor', v_inserted.balance_before_minor::text,
      'balance_delta_minor', v_inserted.balance_delta_minor::text,
      'balance_after_minor', v_inserted.balance_after_minor::text,
      'effective_date', v_inserted.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'entry', public.vendor_finance__internal_entry_projection(v_inserted, v_auth)
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'RECORD_ENTRY',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_record_payment_with_offset(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_project_id text,
  p_contract_type text,
  p_payment_amount_minor text,
  p_offset_amount_minor text,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_today date;
  v_record_scope text;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_pa_candidate_id uuid := null;
  v_vendor public.vendors%rowtype;
  v_proj_acct jsonb;
  v_active_acct_id uuid;
  v_active_acct_name text;
  v_has_entries boolean;
  v_payment_amount bigint;
  v_offset_amount bigint;
  v_total_settlement bigint;
  v_payment_delta bigint;
  v_offset_delta bigint;
  v_reason text;
  v_actor_name text;
  v_shared_prev_seq bigint;
  v_shared_prev_balance bigint;
  v_shared_next_seq bigint;
  v_shared_after_balance bigint;
  v_sub_prev_seq bigint;
  v_sub_prev_balance bigint;
  v_payment_seq bigint;
  v_after_payment_balance bigint;
  v_offset_seq bigint;
  v_after_offset_balance bigint;
  v_payment_doc_no text;
  v_offset_entry_doc_no text;
  v_mov_doc_no text;
  v_offset_entry_idem_key uuid;
  v_payment_entry public.vendor_finance_entries%rowtype;
  v_offset_entry public.vendor_finance_entries%rowtype;
  v_inserted_mov public.vendor_finance_shared_advance_movements%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'shared_advance_apply'
  );
  v_today := (v_auth->>'authorization_date')::date;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'RECORD_PAYMENT_WITH_OFFSET'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_contract_type is null or p_contract_type not in ('SEASONAL', 'OFFICIAL') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if p_effective_date is null
     or pg_catalog.date_part('year', p_effective_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_payment_amount := public.vendor_finance__internal_parse_positive_minor(p_payment_amount_minor);
  v_offset_amount := public.vendor_finance__internal_parse_positive_minor(p_offset_amount_minor);
  v_total_settlement := public.vendor_finance__internal_checked_add_minor(v_payment_amount, v_offset_amount);
  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  -- Canonical DAG: [2]+[3] project -> [4]+[5] actor (+ active PA) -> [6] vendor
  v_project := public.vendor_finance__internal_lock_project(p_project_id);

  select pa.accountant_user_id
    into v_pa_candidate_id
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_project.project_id
     and pa.valid_from <= v_today
     and (pa.valid_to is null or pa.valid_to > v_today)
     and (pa.valid_to is null or pa.valid_to > pa.valid_from)
   order by pa.valid_from desc, pa.version desc
   limit 1;

  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'shared_advance_apply',
    array[v_pa_candidate_id]
  );
  v_today := (v_auth->>'authorization_date')::date;
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');
  v_authority_source := v_auth->>'authority_source';
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(v_project.project_id, v_today);

  if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
    if v_record_scope = 'ASSIGNED_PROJECTS' then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
      using errcode = '40900';
  end if;

  v_active_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
  v_active_acct_name := v_proj_acct->>'accountant_display_name';

  if v_record_scope = 'ASSIGNED_PROJECTS' and v_active_acct_id <> p_app_user_id then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  if not v_vendor.active or not v_project.active then
    select exists (
             select 1
               from public.vendor_finance_entries e
              where e.vendor_id = v_vendor.vendor_id
                and e.ledger_scope = 'PROJECT_ACCOUNTANT'
                and e.project_id = v_project.project_id
                and e.responsible_accountant_user_id = v_active_acct_id
                and e.contract_type = p_contract_type
           )
      into v_has_entries;

    if not v_has_entries then
      if not v_project.active then
        raise exception 'VENDOR_FINANCE_PROJECT_INACTIVE'
          using errcode = '42200';
      end if;
      raise exception 'VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN'
        using errcode = '23514';
    end if;
  end if;

  select e.vendor_sequence, e.balance_after_minor
    into v_sub_prev_seq, v_sub_prev_balance
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_active_acct_id
     and e.contract_type = p_contract_type
   order by e.vendor_sequence desc
   limit 1;

  if not found then
    v_sub_prev_seq := 0;
    v_sub_prev_balance := 0;
  end if;

  if v_sub_prev_balance <= 0 or v_total_settlement > v_sub_prev_balance then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE'
      using errcode = '23514';
  end if;

  select m.vendor_advance_sequence, m.balance_after_minor
    into v_shared_prev_seq, v_shared_prev_balance
    from public.vendor_finance_shared_advance_movements m
   where m.vendor_id = v_vendor.vendor_id
   order by m.vendor_advance_sequence desc
   limit 1;

  if not found then
    v_shared_prev_seq := 0;
    v_shared_prev_balance := 0;
  end if;

  if v_shared_prev_balance <= 0 or v_offset_amount > v_shared_prev_balance then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE'
      using errcode = '23514';
  end if;

  v_payment_delta := -v_payment_amount;
  v_offset_delta := -v_offset_amount;

  v_payment_seq := v_sub_prev_seq + 1;
  v_after_payment_balance := public.vendor_finance__internal_checked_add_minor(
    v_sub_prev_balance,
    v_payment_delta
  );

  v_offset_seq := v_sub_prev_seq + 2;
  v_after_offset_balance := public.vendor_finance__internal_checked_add_minor(
    v_after_payment_balance,
    v_offset_delta
  );

  v_shared_next_seq := v_shared_prev_seq + 1;
  v_shared_after_balance := public.vendor_finance__internal_checked_add_minor(
    v_shared_prev_balance,
    v_offset_delta
  );

  v_payment_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);
  v_offset_entry_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);
  v_mov_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);

  v_offset_entry_idem_key := pg_catalog.md5('vfin_05_offset_entry:' || p_idempotency_key::text)::uuid;
  if v_offset_entry_idem_key = p_idempotency_key then
    v_offset_entry_idem_key := pg_catalog.md5('vfin_05_offset_entry_alt:' || p_idempotency_key::text)::uuid;
  end if;

  perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);
  perform pg_catalog.set_config('vendor_finance.shared_advance_write_marker', 'on', true);

  insert into public.vendor_finance_entries (
    vendor_id,
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    vendor_sequence,
    entry_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    vendor_display_name_snapshot,
    opening_batch_id,
    reverses_entry_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_project.display_name,
    v_active_acct_id,
    v_active_acct_name,
    p_contract_type,
    v_payment_seq,
    'PAYMENT_RECORDED',
    v_payment_amount,
    v_payment_delta,
    v_sub_prev_balance,
    v_after_payment_balance,
    p_effective_date,
    v_reason,
    v_payment_doc_no,
    v_vendor.display_name,
    null,
    null,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_payment_entry;

  insert into public.vendor_finance_entries (
    vendor_id,
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    vendor_sequence,
    entry_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    vendor_display_name_snapshot,
    opening_batch_id,
    reverses_entry_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_project.display_name,
    v_active_acct_id,
    v_active_acct_name,
    p_contract_type,
    v_offset_seq,
    'ADVANCE_OFFSET_RECORDED',
    v_offset_amount,
    v_offset_delta,
    v_after_payment_balance,
    v_after_offset_balance,
    p_effective_date,
    v_reason,
    v_offset_entry_doc_no,
    v_vendor.display_name,
    null,
    null,
    p_app_user_id,
    v_actor_name,
    v_offset_entry_idem_key,
    p_request_fingerprint
  )
  returning * into v_offset_entry;

  insert into public.vendor_finance_shared_advance_movements (
    vendor_id,
    vendor_display_name_snapshot,
    vendor_advance_sequence,
    movement_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    project_entry_id,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    reverses_movement_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_vendor.display_name,
    v_shared_next_seq,
    'PROJECT_OFFSET_APPLIED',
    v_offset_amount,
    v_offset_delta,
    v_shared_prev_balance,
    v_shared_after_balance,
    p_effective_date,
    v_reason,
    v_mov_doc_no,
    v_offset_entry.entry_id,
    v_project.project_id,
    v_project.display_name,
    v_active_acct_id,
    v_active_acct_name,
    p_contract_type,
    null,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted_mov;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    v_payment_entry.entry_id,
    p_app_user_id,
    v_authority_source,
    'ENTRY_RECORDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'document_no', v_payment_entry.document_no,
      'project_id', v_payment_entry.project_id,
      'responsible_accountant_user_id', v_payment_entry.responsible_accountant_user_id,
      'contract_type', v_payment_entry.contract_type,
      'entry_type', v_payment_entry.entry_type,
      'amount_minor', v_payment_entry.amount_minor::text,
      'balance_before_minor', v_payment_entry.balance_before_minor::text,
      'balance_delta_minor', v_payment_entry.balance_delta_minor::text,
      'balance_after_minor', v_payment_entry.balance_after_minor::text,
      'effective_date', v_payment_entry.effective_date::text
    ),
    p_idempotency_key
  );

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    shared_advance_movement_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    v_offset_entry.entry_id,
    v_inserted_mov.movement_id,
    p_app_user_id,
    v_authority_source,
    'SHARED_ADVANCE_OFFSET_APPLIED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'movement_id', v_inserted_mov.movement_id,
      'movement_document_no', v_inserted_mov.document_no,
      'entry_id', v_offset_entry.entry_id,
      'entry_document_no', v_offset_entry.document_no,
      'project_id', v_offset_entry.project_id,
      'responsible_accountant_user_id', v_offset_entry.responsible_accountant_user_id,
      'contract_type', v_offset_entry.contract_type,
      'amount_minor', v_offset_entry.amount_minor::text,
      'subledger_balance_before_minor', v_offset_entry.balance_before_minor::text,
      'subledger_balance_after_minor', v_offset_entry.balance_after_minor::text,
      'shared_advance_before_minor', v_inserted_mov.balance_before_minor::text,
      'shared_advance_after_minor', v_inserted_mov.balance_after_minor::text,
      'effective_date', v_offset_entry.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'payment_entry', public.vendor_finance__internal_entry_projection(v_payment_entry, v_auth),
    'offset_entry', public.vendor_finance__internal_entry_projection(v_offset_entry, v_auth),
    'movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted_mov, v_auth),
    'shared_advance_balance_minor', v_inserted_mov.balance_after_minor::text
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'RECORD_PAYMENT_WITH_OFFSET',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_record_payment_with_offset(uuid, uuid, text, text, text, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_record_payment_with_offset(uuid, uuid, text, text, text, text, text, date, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_apply_opening_batch(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_project_id text,
  p_contract_type text,
  p_cutoff_date date,
  p_items jsonb,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_today date;
  v_record_scope text;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_pa_candidate_id uuid := null;
  v_proj_acct jsonb;
  v_active_acct_id uuid;
  v_active_acct_name text;
  v_reason text;
  v_actor_name text;
  v_len integer;
  v_idx integer;
  v_item jsonb;
  v_vendor_id text;
  v_entry_type text;
  v_amount bigint;
  v_seen text[] := array[]::text[];
  v_all_vendor_ids text[] := array[]::text[];
  v_sorted_vendor_id text;
  v_vendor public.vendors%rowtype;
  v_has_entries boolean;
  v_skipped_zero integer := 0;
  v_vendor_count integer := 0;
  v_total_payable bigint := 0;
  v_total_advance bigint := 0;
  v_net bigint;
  v_batch public.vendor_finance_opening_batches%rowtype;
  v_delta bigint;
  v_doc_no text;
  v_inserted public.vendor_finance_entries%rowtype;
  v_entries_json jsonb := '[]'::jsonb;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'record');
  v_today := (v_auth->>'authorization_date')::date;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'APPLY_OPENING_BATCH'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_contract_type is null or p_contract_type not in ('SEASONAL', 'OFFICIAL') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if p_cutoff_date is null
     or pg_catalog.date_part('year', p_cutoff_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' then
    raise exception 'VENDOR_FINANCE_OPENING_BATCH_INVALID'
      using errcode = '22023';
  end if;

  v_len := pg_catalog.jsonb_array_length(p_items);
  if v_len < 1 or v_len > 200 then
    raise exception 'VENDOR_FINANCE_OPENING_BATCH_SIZE_INVALID'
      using errcode = '22023';
  end if;

  -- Canonical DAG: [2]+[3] project -> [4]+[5] actor (+ active PA) -> [6] sorted vendors
  v_project := public.vendor_finance__internal_lock_project(p_project_id);

  select pa.accountant_user_id
    into v_pa_candidate_id
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_project.project_id
     and pa.valid_from <= v_today
     and (pa.valid_to is null or pa.valid_to > v_today)
     and (pa.valid_to is null or pa.valid_to > pa.valid_from)
   order by pa.valid_from desc, pa.version desc
   limit 1;

  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'record',
    array[v_pa_candidate_id]
  );
  v_today := (v_auth->>'authorization_date')::date;
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');
  v_authority_source := v_auth->>'authority_source';
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(v_project.project_id, v_today);

  if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
    if v_record_scope = 'ASSIGNED_PROJECTS' then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
      using errcode = '40900';
  end if;

  v_active_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
  v_active_acct_name := v_proj_acct->>'accountant_display_name';

  if v_record_scope = 'ASSIGNED_PROJECTS' and v_active_acct_id <> p_app_user_id then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  if not v_project.active then
    raise exception 'VENDOR_FINANCE_PROJECT_INACTIVE'
      using errcode = '42200';
  end if;

  for v_idx in 0..(v_len - 1) loop
    v_item := p_items->v_idx;
    if v_item is null or pg_catalog.jsonb_typeof(v_item) <> 'object' then
      raise exception 'VENDOR_FINANCE_OPENING_BATCH_INVALID'
        using errcode = '22023';
    end if;

    v_vendor_id := v_item->>'vendor_id';
    v_entry_type := v_item->>'entry_type';

    if v_vendor_id is null
       or v_vendor_id = '__system_vendor__'
       or v_vendor_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$' then
      raise exception 'VENDOR_FINANCE_VENDOR_INVALID'
        using errcode = '22023';
    end if;

    if v_vendor_id = any(v_seen) then
      raise exception 'VENDOR_FINANCE_OPENING_BATCH_DUPLICATE_VENDOR'
        using errcode = '22023';
    end if;
    v_seen := pg_catalog.array_append(v_seen, v_vendor_id);

    if v_entry_type is null or v_entry_type not in ('OPENING_PAYABLE', 'OPENING_ADVANCE') then
      raise exception 'VENDOR_FINANCE_ENTRY_TYPE_INVALID'
        using errcode = '22023';
    end if;

    if v_entry_type = 'OPENING_ADVANCE' then
      raise exception 'VENDOR_FINANCE_RECORD_DENIED'
        using errcode = '42501';
    end if;

    v_amount := public.vendor_finance__internal_parse_non_negative_minor(v_item->>'amount_minor');
    v_all_vendor_ids := pg_catalog.array_append(v_all_vendor_ids, v_vendor_id);

    if v_amount = 0 then
      v_skipped_zero := v_skipped_zero + 1;
    else
      v_vendor_count := v_vendor_count + 1;
      if v_entry_type = 'OPENING_PAYABLE' then
        v_total_payable := public.vendor_finance__internal_checked_add_minor(v_total_payable, v_amount);
      else
        v_total_advance := public.vendor_finance__internal_checked_add_minor(v_total_advance, v_amount);
      end if;
    end if;
  end loop;

  if v_vendor_count = 0 then
    raise exception 'VENDOR_FINANCE_OPENING_BATCH_EMPTY'
      using errcode = '22023';
  end if;

  for v_sorted_vendor_id in
    select u.vid
      from pg_catalog.unnest(v_all_vendor_ids) as u(vid)
     order by u.vid asc
  loop
    perform public.vendor_finance__internal_lock_vendor(v_sorted_vendor_id);
  end loop;

  for v_idx in 0..(v_len - 1) loop
    v_item := p_items->v_idx;
    v_vendor_id := v_item->>'vendor_id';
    v_amount := public.vendor_finance__internal_parse_non_negative_minor(v_item->>'amount_minor');

    select v.* into v_vendor from public.vendors v
     where v.vendor_id = v_vendor_id and v.vendor_id <> '__system_vendor__';

    if not found then
      raise exception 'VENDOR_FINANCE_VENDOR_NOT_FOUND' using errcode = 'P0002';
    end if;
    if not v_vendor.active then
      raise exception 'VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN' using errcode = '23514';
    end if;

    if v_amount = 0 then
      continue;
    end if;

    select exists (
             select 1
               from public.vendor_finance_entries e
              where e.vendor_id = v_vendor_id
                and e.ledger_scope = 'PROJECT_ACCOUNTANT'
                and e.project_id = v_project.project_id
                and e.responsible_accountant_user_id = v_active_acct_id
                and e.contract_type = p_contract_type
           )
      into v_has_entries;

    if v_has_entries then
      raise exception 'VENDOR_FINANCE_VENDOR_ALREADY_INITIALIZED'
        using errcode = '23505';
    end if;
  end loop;

  v_net := public.vendor_finance__internal_checked_sub_minor(v_total_payable, v_total_advance);

  insert into public.vendor_finance_opening_batches (
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    cutoff_date,
    vendor_count,
    skipped_zero_count,
    total_payable_minor,
    total_advance_minor,
    net_balance_minor,
    reason,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_project.display_name,
    v_active_acct_id,
    v_active_acct_name,
    p_contract_type,
    p_cutoff_date,
    v_vendor_count,
    v_skipped_zero,
    v_total_payable,
    v_total_advance,
    v_net,
    v_reason,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_batch;

  perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);

  for v_idx in 0..(v_len - 1) loop
    v_item := p_items->v_idx;
    v_amount := public.vendor_finance__internal_parse_non_negative_minor(v_item->>'amount_minor');
    if v_amount = 0 then
      continue;
    end if;

    v_vendor_id := v_item->>'vendor_id';
    v_entry_type := v_item->>'entry_type';

    select v.* into v_vendor from public.vendors v where v.vendor_id = v_vendor_id;

    v_delta := case when v_entry_type = 'OPENING_PAYABLE' then v_amount else -v_amount end;
    v_doc_no := public.vendor_finance__internal_next_document_no(p_cutoff_date);

    insert into public.vendor_finance_entries (
      vendor_id,
      ledger_scope,
      project_id,
      project_display_name_snapshot,
      responsible_accountant_user_id,
      responsible_accountant_display_name_snapshot,
      contract_type,
      vendor_sequence,
      entry_type,
      amount_minor,
      balance_delta_minor,
      balance_before_minor,
      balance_after_minor,
      effective_date,
      reason,
      document_no,
      vendor_display_name_snapshot,
      opening_batch_id,
      reverses_entry_id,
      created_by_user_id,
      created_by_display_name_snapshot,
      idempotency_key,
      request_fingerprint
    ) values (
      v_vendor.vendor_id,
      'PROJECT_ACCOUNTANT',
      v_project.project_id,
      v_project.display_name,
      v_active_acct_id,
      v_active_acct_name,
      p_contract_type,
      1,
      v_entry_type,
      v_amount,
      v_delta,
      0,
      v_delta,
      p_cutoff_date,
      v_reason,
      v_doc_no,
      v_vendor.display_name,
      v_batch.batch_id,
      null,
      p_app_user_id,
      v_actor_name,
      p_idempotency_key,
      p_request_fingerprint
    )
    returning * into v_inserted;

    v_entries_json := v_entries_json || pg_catalog.jsonb_build_array(
      public.vendor_finance__internal_entry_projection(v_inserted, v_auth)
    );
  end loop;

  insert into public.vendor_finance_audit_events (
    project_id,
    opening_batch_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_project.project_id,
    v_batch.batch_id,
    p_app_user_id,
    v_authority_source,
    'OPENING_BATCH_APPLIED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'project_id', v_batch.project_id,
      'responsible_accountant_user_id', v_batch.responsible_accountant_user_id,
      'contract_type', v_batch.contract_type,
      'cutoff_date', v_batch.cutoff_date::text,
      'vendor_count', v_batch.vendor_count,
      'skipped_zero_count', v_batch.skipped_zero_count,
      'total_payable_minor', v_batch.total_payable_minor::text,
      'total_advance_minor', v_batch.total_advance_minor::text,
      'net_balance_minor', v_batch.net_balance_minor::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'batch', pg_catalog.jsonb_build_object(
      'batch_id', v_batch.batch_id,
      'ledger_scope', v_batch.ledger_scope,
      'project_id', v_batch.project_id,
      'project_display_name_snapshot', v_batch.project_display_name_snapshot,
      'accountant_ref', v_batch.responsible_accountant_user_id,
      'responsible_accountant_display_name', v_batch.responsible_accountant_display_name_snapshot,
      'contract_type', v_batch.contract_type,
      'cutoff_date', v_batch.cutoff_date::text,
      'vendor_count', v_batch.vendor_count,
      'skipped_zero_count', v_batch.skipped_zero_count,
      'total_payable_minor', v_batch.total_payable_minor::text,
      'total_advance_minor', v_batch.total_advance_minor::text,
      'net_balance_minor', v_batch.net_balance_minor::text,
      'reason', v_batch.reason,
      'created_by_display_name', v_batch.created_by_display_name_snapshot,
      'created_at', pg_catalog.to_jsonb(v_batch.created_at)
    ),
    'entries', v_entries_json
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'APPLY_OPENING_BATCH',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_apply_opening_batch(uuid, uuid, text, text, date, jsonb, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_apply_opening_batch(uuid, uuid, text, text, date, jsonb, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_fund_shared_advance(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_amount_minor text,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_vendor public.vendors%rowtype;
  v_amount bigint;
  v_reason text;
  v_actor_name text;
  v_prev_seq bigint;
  v_prev_balance bigint;
  v_next_seq bigint;
  v_after_balance bigint;
  v_doc_no text;
  v_inserted public.vendor_finance_shared_advance_movements%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'shared_advance_fund'
  );

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'FUND_SHARED_ADVANCE'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_effective_date is null
     or pg_catalog.date_part('year', p_effective_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_amount := public.vendor_finance__internal_parse_positive_minor(p_amount_minor);
  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  -- Canonical DAG: [4]+[5] actor -> [6] vendor
  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'shared_advance_fund',
    array[]::uuid[]
  );
  v_authority_source := v_auth->>'authority_source';
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  if not v_vendor.active then
    raise exception 'VENDOR_FINANCE_VENDOR_INACTIVE_ENTRY_FORBIDDEN'
      using errcode = '23514';
  end if;

  select m.vendor_advance_sequence, m.balance_after_minor
    into v_prev_seq, v_prev_balance
    from public.vendor_finance_shared_advance_movements m
   where m.vendor_id = v_vendor.vendor_id
   order by m.vendor_advance_sequence desc
   limit 1;

  if not found then
    v_prev_seq := 0;
    v_prev_balance := 0;
  end if;

  v_next_seq := v_prev_seq + 1;
  v_after_balance := public.vendor_finance__internal_checked_add_minor(v_prev_balance, v_amount);
  v_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);

  perform pg_catalog.set_config('vendor_finance.shared_advance_write_marker', 'on', true);

  insert into public.vendor_finance_shared_advance_movements (
    vendor_id,
    vendor_display_name_snapshot,
    vendor_advance_sequence,
    movement_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    project_entry_id,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    reverses_movement_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_vendor.display_name,
    v_next_seq,
    'ADVANCE_FUNDED',
    v_amount,
    v_amount,
    v_prev_balance,
    v_after_balance,
    p_effective_date,
    v_reason,
    v_doc_no,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    p_app_user_id,
    v_authority_source,
    'SHARED_ADVANCE_FUNDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'movement_id', v_inserted.movement_id,
      'document_no', v_inserted.document_no,
      'movement_type', v_inserted.movement_type,
      'amount_minor', v_inserted.amount_minor::text,
      'balance_before_minor', v_inserted.balance_before_minor::text,
      'balance_delta_minor', v_inserted.balance_delta_minor::text,
      'balance_after_minor', v_inserted.balance_after_minor::text,
      'effective_date', v_inserted.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted, v_auth),
    'shared_advance_balance_minor', v_inserted.balance_after_minor::text
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'FUND_SHARED_ADVANCE',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_fund_shared_advance(uuid, uuid, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_fund_shared_advance(uuid, uuid, text, text, date, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_record_vendor_refund(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_amount_minor text,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_vendor public.vendors%rowtype;
  v_amount bigint;
  v_delta bigint;
  v_reason text;
  v_actor_name text;
  v_prev_seq bigint;
  v_prev_balance bigint;
  v_next_seq bigint;
  v_after_balance bigint;
  v_doc_no text;
  v_inserted public.vendor_finance_shared_advance_movements%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'shared_advance_refund'
  );

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'RECORD_VENDOR_REFUND'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_effective_date is null
     or pg_catalog.date_part('year', p_effective_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_amount := public.vendor_finance__internal_parse_positive_minor(p_amount_minor);
  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  -- Canonical DAG: [4]+[5] actor -> [6] vendor
  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'shared_advance_refund',
    array[]::uuid[]
  );
  v_authority_source := v_auth->>'authority_source';
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  select m.vendor_advance_sequence, m.balance_after_minor
    into v_prev_seq, v_prev_balance
    from public.vendor_finance_shared_advance_movements m
   where m.vendor_id = v_vendor.vendor_id
   order by m.vendor_advance_sequence desc
   limit 1;

  if not found then
    v_prev_seq := 0;
    v_prev_balance := 0;
  end if;

  if v_amount > v_prev_balance then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE'
      using errcode = '23514';
  end if;

  v_next_seq := v_prev_seq + 1;
  v_delta := -v_amount;
  v_after_balance := public.vendor_finance__internal_checked_add_minor(v_prev_balance, v_delta);
  v_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);

  perform pg_catalog.set_config('vendor_finance.shared_advance_write_marker', 'on', true);

  insert into public.vendor_finance_shared_advance_movements (
    vendor_id,
    vendor_display_name_snapshot,
    vendor_advance_sequence,
    movement_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    project_entry_id,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    reverses_movement_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_vendor.display_name,
    v_next_seq,
    'VENDOR_REFUND_RECORDED',
    v_amount,
    v_delta,
    v_prev_balance,
    v_after_balance,
    p_effective_date,
    v_reason,
    v_doc_no,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    p_app_user_id,
    v_authority_source,
    'VENDOR_REFUND_RECORDED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'movement_id', v_inserted.movement_id,
      'document_no', v_inserted.document_no,
      'movement_type', v_inserted.movement_type,
      'amount_minor', v_inserted.amount_minor::text,
      'balance_before_minor', v_inserted.balance_before_minor::text,
      'balance_delta_minor', v_inserted.balance_delta_minor::text,
      'balance_after_minor', v_inserted.balance_after_minor::text,
      'effective_date', v_inserted.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted, v_auth),
    'shared_advance_balance_minor', v_inserted.balance_after_minor::text
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'RECORD_VENDOR_REFUND',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_record_vendor_refund(uuid, uuid, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_record_vendor_refund(uuid, uuid, text, text, date, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_apply_shared_advance_offset(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_project_id text,
  p_contract_type text,
  p_amount_minor text,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_today date;
  v_record_scope text;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_pa_candidate_id uuid := null;
  v_vendor public.vendors%rowtype;
  v_proj_acct jsonb;
  v_active_acct_id uuid;
  v_active_acct_name text;
  v_amount bigint;
  v_delta bigint;
  v_reason text;
  v_actor_name text;
  v_shared_prev_seq bigint;
  v_shared_prev_balance bigint;
  v_shared_next_seq bigint;
  v_shared_after_balance bigint;
  v_sub_prev_seq bigint;
  v_sub_prev_balance bigint;
  v_sub_next_seq bigint;
  v_sub_after_balance bigint;
  v_entry_doc_no text;
  v_mov_doc_no text;
  v_inserted_entry public.vendor_finance_entries%rowtype;
  v_inserted_mov public.vendor_finance_shared_advance_movements%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'shared_advance_apply'
  );
  v_today := (v_auth->>'authorization_date')::date;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'APPLY_SHARED_ADVANCE_OFFSET'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_contract_type is null or p_contract_type not in ('SEASONAL', 'OFFICIAL') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if p_effective_date is null
     or pg_catalog.date_part('year', p_effective_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_amount := public.vendor_finance__internal_parse_positive_minor(p_amount_minor);
  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  -- Canonical DAG: [2]+[3] project -> [4]+[5] actor (+ active PA) -> [6] vendor
  v_project := public.vendor_finance__internal_lock_project(p_project_id);

  select pa.accountant_user_id
    into v_pa_candidate_id
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_project.project_id
     and pa.valid_from <= v_today
     and (pa.valid_to is null or pa.valid_to > v_today)
     and (pa.valid_to is null or pa.valid_to > pa.valid_from)
   order by pa.valid_from desc, pa.version desc
   limit 1;

  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'shared_advance_apply',
    array[v_pa_candidate_id]
  );
  v_today := (v_auth->>'authorization_date')::date;
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');
  v_authority_source := v_auth->>'authority_source';
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(v_project.project_id, v_today);

  if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
    if v_record_scope = 'ASSIGNED_PROJECTS' then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
    raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
      using errcode = '40900';
  end if;

  v_active_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
  v_active_acct_name := v_proj_acct->>'accountant_display_name';

  if v_record_scope = 'ASSIGNED_PROJECTS' and v_active_acct_id <> p_app_user_id then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  select m.vendor_advance_sequence, m.balance_after_minor
    into v_shared_prev_seq, v_shared_prev_balance
    from public.vendor_finance_shared_advance_movements m
   where m.vendor_id = v_vendor.vendor_id
   order by m.vendor_advance_sequence desc
   limit 1;

  if not found then
    v_shared_prev_seq := 0;
    v_shared_prev_balance := 0;
  end if;

  if v_shared_prev_balance <= 0 or v_amount > v_shared_prev_balance then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE'
      using errcode = '23514';
  end if;

  select e.vendor_sequence, e.balance_after_minor
    into v_sub_prev_seq, v_sub_prev_balance
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_active_acct_id
     and e.contract_type = p_contract_type
   order by e.vendor_sequence desc
   limit 1;

  if not found then
    v_sub_prev_seq := 0;
    v_sub_prev_balance := 0;
  end if;

  if v_sub_prev_balance <= 0 or v_amount > v_sub_prev_balance then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SUBLEDGER_PAYABLE'
      using errcode = '23514';
  end if;

  v_delta := -v_amount;
  v_sub_next_seq := v_sub_prev_seq + 1;
  v_sub_after_balance := public.vendor_finance__internal_checked_add_minor(v_sub_prev_balance, v_delta);

  v_shared_next_seq := v_shared_prev_seq + 1;
  v_shared_after_balance := public.vendor_finance__internal_checked_add_minor(v_shared_prev_balance, v_delta);

  v_entry_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);
  v_mov_doc_no := public.vendor_finance__internal_next_document_no(p_effective_date);

  perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);
  perform pg_catalog.set_config('vendor_finance.shared_advance_write_marker', 'on', true);

  insert into public.vendor_finance_entries (
    vendor_id,
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    vendor_sequence,
    entry_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    vendor_display_name_snapshot,
    opening_batch_id,
    reverses_entry_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_project.display_name,
    v_active_acct_id,
    v_active_acct_name,
    p_contract_type,
    v_sub_next_seq,
    'ADVANCE_OFFSET_RECORDED',
    v_amount,
    v_delta,
    v_sub_prev_balance,
    v_sub_after_balance,
    p_effective_date,
    v_reason,
    v_entry_doc_no,
    v_vendor.display_name,
    null,
    null,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted_entry;

  insert into public.vendor_finance_shared_advance_movements (
    vendor_id,
    vendor_display_name_snapshot,
    vendor_advance_sequence,
    movement_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    project_entry_id,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    reverses_movement_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_vendor.display_name,
    v_shared_next_seq,
    'PROJECT_OFFSET_APPLIED',
    v_amount,
    v_delta,
    v_shared_prev_balance,
    v_shared_after_balance,
    p_effective_date,
    v_reason,
    v_mov_doc_no,
    v_inserted_entry.entry_id,
    v_project.project_id,
    v_project.display_name,
    v_active_acct_id,
    v_active_acct_name,
    p_contract_type,
    null,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted_mov;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    v_inserted_entry.entry_id,
    p_app_user_id,
    v_authority_source,
    'SHARED_ADVANCE_OFFSET_APPLIED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'movement_id', v_inserted_mov.movement_id,
      'movement_document_no', v_inserted_mov.document_no,
      'entry_id', v_inserted_entry.entry_id,
      'entry_document_no', v_inserted_entry.document_no,
      'project_id', v_inserted_entry.project_id,
      'responsible_accountant_user_id', v_inserted_entry.responsible_accountant_user_id,
      'contract_type', v_inserted_entry.contract_type,
      'amount_minor', v_inserted_entry.amount_minor::text,
      'subledger_balance_before_minor', v_inserted_entry.balance_before_minor::text,
      'subledger_balance_after_minor', v_inserted_entry.balance_after_minor::text,
      'shared_advance_before_minor', v_inserted_mov.balance_before_minor::text,
      'shared_advance_after_minor', v_inserted_mov.balance_after_minor::text,
      'effective_date', v_inserted_entry.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted_mov, v_auth),
    'entry', public.vendor_finance__internal_entry_projection(v_inserted_entry, v_auth),
    'shared_advance_balance_minor', v_inserted_mov.balance_after_minor::text
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'APPLY_SHARED_ADVANCE_OFFSET',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_apply_shared_advance_offset(uuid, uuid, text, text, text, text, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_apply_shared_advance_offset(uuid, uuid, text, text, text, text, date, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_reverse_entry(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_entry_id uuid,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_record_scope text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_orig public.vendor_finance_entries%rowtype;
  v_orig_mov public.vendor_finance_shared_advance_movements%rowtype;
  v_has_orig_mov boolean := false;
  v_vendor public.vendors%rowtype;
  v_effective_date date;
  v_reason text;
  v_actor_name text;
  v_existing_rev uuid;
  v_existing_mov_rev uuid;
  v_prev_seq bigint;
  v_prev_balance bigint;
  v_next_seq bigint;
  v_delta bigint;
  v_after_balance bigint;
  v_doc_no text;
  v_inserted public.vendor_finance_entries%rowtype;
  v_mov_prev_seq bigint;
  v_mov_prev_balance bigint;
  v_mov_next_seq bigint;
  v_mov_delta bigint;
  v_mov_after_balance bigint;
  v_mov_doc_no text;
  v_inserted_mov public.vendor_finance_shared_advance_movements%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'record');

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'REVERSE_ENTRY'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_entry_id is null then
    raise exception 'VENDOR_FINANCE_ENTRY_INVALID'
      using errcode = '22023';
  end if;

  v_effective_date := coalesce(p_effective_date, (v_auth->>'authorization_date')::date);
  if pg_catalog.date_part('year', v_effective_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  select e.*
    into v_orig
    from public.vendor_finance_entries e
   where e.entry_id = p_entry_id;

  if not found then
    raise exception 'VENDOR_FINANCE_ENTRY_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  -- Canonical DAG: [2]+[3] project (if any) -> [4]+[5] actor + responsible accountant (ASC) -> [6] vendor
  if v_orig.project_id is not null then
    perform public.vendor_finance__internal_lock_project(v_orig.project_id);
  end if;

  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'record',
    array[v_orig.responsible_accountant_user_id]
  );
  v_authority_source := v_auth->>'authority_source';
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  if v_orig.entry_type in ('ADVANCE_RECORDED', 'OPENING_ADVANCE') and v_record_scope <> 'ALL' then
    raise exception 'VENDOR_FINANCE_RECORD_DENIED'
      using errcode = '42501';
  end if;

  v_vendor := public.vendor_finance__internal_lock_vendor(v_orig.vendor_id);

  -- Re-read v_orig under project + vendor locks so concurrent sub-ledger classification
  -- (`UNCLASSIFIED` -> `SEASONAL`/`OFFICIAL`) is observed cleanly before computing reversal balances.
  select e.*
    into v_orig
    from public.vendor_finance_entries e
   where e.entry_id = p_entry_id;

  if not found then
    raise exception 'VENDOR_FINANCE_ENTRY_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if not public.vendor_finance__internal_can_actor_write_subledger(
    v_auth,
    p_app_user_id,
    'record',
    v_orig.ledger_scope,
    v_orig.project_id,
    v_orig.responsible_accountant_user_id
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_orig.entry_type = 'REVERSAL' then
    raise exception 'VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL'
      using errcode = '23514';
  end if;

  select r.entry_id
    into v_existing_rev
    from public.vendor_finance_entries r
   where r.reverses_entry_id = v_orig.entry_id;

  if found then
    raise exception 'VENDOR_FINANCE_ENTRY_ALREADY_REVERSED'
      using errcode = '23505';
  end if;

  if v_orig.entry_type = 'ADVANCE_OFFSET_RECORDED' then
    select m.*
      into v_orig_mov
      from public.vendor_finance_shared_advance_movements m
     where m.project_entry_id = v_orig.entry_id
       and m.movement_type = 'PROJECT_OFFSET_APPLIED';

    if not found then
      raise exception 'VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    v_has_orig_mov := true;

    select rm.movement_id
      into v_existing_mov_rev
      from public.vendor_finance_shared_advance_movements rm
     where rm.reverses_movement_id = v_orig_mov.movement_id;

    if found then
      raise exception 'VENDOR_FINANCE_ENTRY_ALREADY_REVERSED'
        using errcode = '23505';
    end if;
  end if;

  v_delta := -v_orig.balance_delta_minor;

  select e.vendor_sequence, e.balance_after_minor
    into v_prev_seq, v_prev_balance
    from public.vendor_finance_entries e
   where e.vendor_id = v_orig.vendor_id
     and e.ledger_scope = v_orig.ledger_scope
     and e.project_id is not distinct from v_orig.project_id
     and e.responsible_accountant_user_id is not distinct from v_orig.responsible_accountant_user_id
     and e.contract_type = v_orig.contract_type
   order by e.vendor_sequence desc
   limit 1;

  v_next_seq := coalesce(v_prev_seq, 0) + 1;
  v_after_balance := public.vendor_finance__internal_checked_add_minor(coalesce(v_prev_balance, 0), v_delta);
  v_doc_no := public.vendor_finance__internal_next_document_no(v_effective_date);

  perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);

  insert into public.vendor_finance_entries (
    vendor_id,
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    vendor_sequence,
    entry_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    vendor_display_name_snapshot,
    opening_batch_id,
    reverses_entry_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_orig.ledger_scope,
    v_orig.project_id,
    v_orig.project_display_name_snapshot,
    v_orig.responsible_accountant_user_id,
    v_orig.responsible_accountant_display_name_snapshot,
    v_orig.contract_type,
    v_next_seq,
    'REVERSAL',
    v_orig.amount_minor,
    v_delta,
    coalesce(v_prev_balance, 0),
    v_after_balance,
    v_effective_date,
    v_reason,
    v_doc_no,
    v_vendor.display_name,
    null,
    v_orig.entry_id,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  if v_has_orig_mov then
    select m.vendor_advance_sequence, m.balance_after_minor
      into v_mov_prev_seq, v_mov_prev_balance
      from public.vendor_finance_shared_advance_movements m
     where m.vendor_id = v_vendor.vendor_id
     order by m.vendor_advance_sequence desc
     limit 1;

    v_mov_next_seq := coalesce(v_mov_prev_seq, 0) + 1;
    v_mov_delta := -v_orig_mov.balance_delta_minor;
    v_mov_after_balance := public.vendor_finance__internal_checked_add_minor(
      coalesce(v_mov_prev_balance, 0),
      v_mov_delta
    );
    v_mov_doc_no := public.vendor_finance__internal_next_document_no(v_effective_date);

    perform pg_catalog.set_config('vendor_finance.shared_advance_write_marker', 'on', true);

    insert into public.vendor_finance_shared_advance_movements (
      vendor_id,
      vendor_display_name_snapshot,
      vendor_advance_sequence,
      movement_type,
      amount_minor,
      balance_delta_minor,
      balance_before_minor,
      balance_after_minor,
      effective_date,
      reason,
      document_no,
      project_entry_id,
      project_id,
      project_display_name_snapshot,
      responsible_accountant_user_id,
      responsible_accountant_display_name_snapshot,
      contract_type,
      reverses_movement_id,
      created_by_user_id,
      created_by_display_name_snapshot,
      idempotency_key,
      request_fingerprint
    ) values (
      v_vendor.vendor_id,
      v_vendor.display_name,
      v_mov_next_seq,
      'REVERSAL',
      v_orig_mov.amount_minor,
      v_mov_delta,
      coalesce(v_mov_prev_balance, 0),
      v_mov_after_balance,
      v_effective_date,
      v_reason,
      v_mov_doc_no,
      v_inserted.entry_id,
      v_orig.project_id,
      v_orig.project_display_name_snapshot,
      v_orig.responsible_accountant_user_id,
      v_orig.responsible_accountant_display_name_snapshot,
      v_orig.contract_type,
      v_orig_mov.movement_id,
      p_app_user_id,
      v_actor_name,
      p_idempotency_key,
      p_request_fingerprint
    )
    returning * into v_inserted_mov;

    select m.*
      into v_orig_mov
      from public.vendor_finance_shared_advance_movements m
     where m.movement_id = v_orig_mov.movement_id;
  end if;

  select e.* into v_orig from public.vendor_finance_entries e where e.entry_id = v_orig.entry_id;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_orig.project_id,
    v_inserted.entry_id,
    p_app_user_id,
    v_authority_source,
    'ENTRY_REVERSED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'document_no', v_inserted.document_no,
      'project_id', v_inserted.project_id,
      'responsible_accountant_user_id', v_inserted.responsible_accountant_user_id,
      'contract_type', v_inserted.contract_type,
      'reverses_entry_id', v_orig.entry_id,
      'reverses_document_no', v_orig.document_no,
      'amount_minor', v_inserted.amount_minor::text,
      'balance_before_minor', v_inserted.balance_before_minor::text,
      'balance_delta_minor', v_inserted.balance_delta_minor::text,
      'balance_after_minor', v_inserted.balance_after_minor::text,
      'effective_date', v_inserted.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'reversal_entry', public.vendor_finance__internal_entry_projection(v_inserted, v_auth),
    'reversed_entry', public.vendor_finance__internal_entry_projection(v_orig, v_auth)
  );

  if v_has_orig_mov then
    v_base_payload := v_base_payload || pg_catalog.jsonb_build_object(
      'reversal_movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted_mov, v_auth),
      'reversed_movement', public.vendor_finance__internal_shared_advance_movement_projection(v_orig_mov, v_auth),
      'shared_advance_balance_minor', v_inserted_mov.balance_after_minor::text
    );
  end if;

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'REVERSE_ENTRY',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_reverse_shared_advance_movement(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_movement_id uuid,
  p_effective_date date,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_orig_mov public.vendor_finance_shared_advance_movements%rowtype;
  v_orig_entry public.vendor_finance_entries%rowtype;
  v_has_orig_entry boolean := false;
  v_vendor public.vendors%rowtype;
  v_effective_date date;
  v_reason text;
  v_actor_name text;
  v_existing_mov_rev uuid;
  v_existing_entry_rev uuid;
  v_mov_prev_seq bigint;
  v_mov_prev_balance bigint;
  v_mov_next_seq bigint;
  v_mov_delta bigint;
  v_mov_after_balance bigint;
  v_mov_doc_no text;
  v_inserted_mov public.vendor_finance_shared_advance_movements%rowtype;
  v_entry_prev_seq bigint;
  v_entry_prev_balance bigint;
  v_entry_next_seq bigint;
  v_entry_delta bigint;
  v_entry_after_balance bigint;
  v_entry_doc_no text;
  v_inserted_entry public.vendor_finance_entries%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'REVERSE_SHARED_ADVANCE_MOVEMENT'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_movement_id is null then
    raise exception 'VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID'
      using errcode = '22023';
  end if;

  v_effective_date := coalesce(p_effective_date, (v_auth->>'authorization_date')::date);
  if pg_catalog.date_part('year', v_effective_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  select m.*
    into v_orig_mov
    from public.vendor_finance_shared_advance_movements m
   where m.movement_id = p_movement_id;

  if not found then
    raise exception 'VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_orig_mov.movement_type = 'REVERSAL' then
    raise exception 'VENDOR_FINANCE_CANNOT_REVERSE_REVERSAL'
      using errcode = '23514';
  end if;

  if v_orig_mov.movement_type in ('ADVANCE_FUNDED', 'VENDOR_REFUND_RECORDED') then
    -- Canonical DAG: [4]+[5] actor + responsible accountant (ASC) -> [6] vendor
    v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
      p_auth_subject,
      p_app_user_id,
      'shared_advance_fund',
      array[v_orig_mov.responsible_accountant_user_id]
    );
    v_authority_source := v_auth->>'authority_source';
    v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);
    v_vendor := public.vendor_finance__internal_lock_vendor(v_orig_mov.vendor_id);

    select m.*
      into v_orig_mov
      from public.vendor_finance_shared_advance_movements m
     where m.movement_id = p_movement_id;
  elsif v_orig_mov.movement_type = 'PROJECT_OFFSET_APPLIED' then
    -- Canonical DAG: [2]+[3] project -> [4]+[5] actor + responsible accountant (ASC) -> [6] vendor
    perform public.vendor_finance__internal_lock_project(v_orig_mov.project_id);
    v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
      p_auth_subject,
      p_app_user_id,
      'shared_advance_apply',
      array[
        v_orig_mov.responsible_accountant_user_id,
        (select e.responsible_accountant_user_id from public.vendor_finance_entries e where e.entry_id = v_orig_mov.project_entry_id)
      ]
    );
    v_authority_source := v_auth->>'authority_source';
    v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);
    v_vendor := public.vendor_finance__internal_lock_vendor(v_orig_mov.vendor_id);

    select m.*
      into v_orig_mov
      from public.vendor_finance_shared_advance_movements m
     where m.movement_id = p_movement_id;

    if not public.vendor_finance__internal_can_actor_write_subledger(
      v_auth,
      p_app_user_id,
      'record',
      'PROJECT_ACCOUNTANT',
      v_orig_mov.project_id,
      v_orig_mov.responsible_accountant_user_id
    ) then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;

    select e.*
      into v_orig_entry
      from public.vendor_finance_entries e
     where e.entry_id = v_orig_mov.project_entry_id;

    if not found then
      raise exception 'VENDOR_FINANCE_ENTRY_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    v_has_orig_entry := true;
  else
    raise exception 'VENDOR_FINANCE_SHARED_ADVANCE_MOVEMENT_INVALID'
      using errcode = '22023';
  end if;

  select rm.movement_id
    into v_existing_mov_rev
    from public.vendor_finance_shared_advance_movements rm
   where rm.reverses_movement_id = v_orig_mov.movement_id;

  if found then
    raise exception 'VENDOR_FINANCE_MOVEMENT_ALREADY_REVERSED'
      using errcode = '23505';
  end if;

  if v_has_orig_entry then
    select re.entry_id
      into v_existing_entry_rev
      from public.vendor_finance_entries re
     where re.reverses_entry_id = v_orig_entry.entry_id;

    if found then
      raise exception 'VENDOR_FINANCE_MOVEMENT_ALREADY_REVERSED'
        using errcode = '23505';
    end if;
  end if;

  select m.vendor_advance_sequence, m.balance_after_minor
    into v_mov_prev_seq, v_mov_prev_balance
    from public.vendor_finance_shared_advance_movements m
   where m.vendor_id = v_vendor.vendor_id
   order by m.vendor_advance_sequence desc
   limit 1;

  v_mov_next_seq := coalesce(v_mov_prev_seq, 0) + 1;
  v_mov_delta := -v_orig_mov.balance_delta_minor;
  v_mov_after_balance := public.vendor_finance__internal_checked_add_minor(
    coalesce(v_mov_prev_balance, 0),
    v_mov_delta
  );

  if v_mov_after_balance < 0 then
    raise exception 'VENDOR_FINANCE_INSUFFICIENT_SHARED_ADVANCE'
      using errcode = '23514';
  end if;

  if v_has_orig_entry then
    v_entry_delta := -v_orig_entry.balance_delta_minor;

    select e.vendor_sequence, e.balance_after_minor
      into v_entry_prev_seq, v_entry_prev_balance
      from public.vendor_finance_entries e
     where e.vendor_id = v_orig_entry.vendor_id
       and e.ledger_scope = v_orig_entry.ledger_scope
       and e.project_id is not distinct from v_orig_entry.project_id
       and e.responsible_accountant_user_id is not distinct from v_orig_entry.responsible_accountant_user_id
       and e.contract_type = v_orig_entry.contract_type
     order by e.vendor_sequence desc
     limit 1;

    v_entry_next_seq := coalesce(v_entry_prev_seq, 0) + 1;
    v_entry_after_balance := public.vendor_finance__internal_checked_add_minor(
      coalesce(v_entry_prev_balance, 0),
      v_entry_delta
    );
    v_entry_doc_no := public.vendor_finance__internal_next_document_no(v_effective_date);

    perform pg_catalog.set_config('vendor_finance.entry_write_marker', 'on', true);

    insert into public.vendor_finance_entries (
      vendor_id,
      ledger_scope,
      project_id,
      project_display_name_snapshot,
      responsible_accountant_user_id,
      responsible_accountant_display_name_snapshot,
      contract_type,
      vendor_sequence,
      entry_type,
      amount_minor,
      balance_delta_minor,
      balance_before_minor,
      balance_after_minor,
      effective_date,
      reason,
      document_no,
      vendor_display_name_snapshot,
      opening_batch_id,
      reverses_entry_id,
      created_by_user_id,
      created_by_display_name_snapshot,
      idempotency_key,
      request_fingerprint
    ) values (
      v_vendor.vendor_id,
      v_orig_entry.ledger_scope,
      v_orig_entry.project_id,
      v_orig_entry.project_display_name_snapshot,
      v_orig_entry.responsible_accountant_user_id,
      v_orig_entry.responsible_accountant_display_name_snapshot,
      v_orig_entry.contract_type,
      v_entry_next_seq,
      'REVERSAL',
      v_orig_entry.amount_minor,
      v_entry_delta,
      coalesce(v_entry_prev_balance, 0),
      v_entry_after_balance,
      v_effective_date,
      v_reason,
      v_entry_doc_no,
      v_vendor.display_name,
      null,
      v_orig_entry.entry_id,
      p_app_user_id,
      v_actor_name,
      p_idempotency_key,
      p_request_fingerprint
    )
    returning * into v_inserted_entry;
  end if;

  v_mov_doc_no := public.vendor_finance__internal_next_document_no(v_effective_date);

  perform pg_catalog.set_config('vendor_finance.shared_advance_write_marker', 'on', true);

  insert into public.vendor_finance_shared_advance_movements (
    vendor_id,
    vendor_display_name_snapshot,
    vendor_advance_sequence,
    movement_type,
    amount_minor,
    balance_delta_minor,
    balance_before_minor,
    balance_after_minor,
    effective_date,
    reason,
    document_no,
    project_entry_id,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    reverses_movement_id,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_vendor.display_name,
    v_mov_next_seq,
    'REVERSAL',
    v_orig_mov.amount_minor,
    v_mov_delta,
    coalesce(v_mov_prev_balance, 0),
    v_mov_after_balance,
    v_effective_date,
    v_reason,
    v_mov_doc_no,
    case when v_has_orig_entry then v_inserted_entry.entry_id else null end,
    v_orig_mov.project_id,
    v_orig_mov.project_display_name_snapshot,
    v_orig_mov.responsible_accountant_user_id,
    v_orig_mov.responsible_accountant_display_name_snapshot,
    v_orig_mov.contract_type,
    v_orig_mov.movement_id,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted_mov;

  select m.*
    into v_orig_mov
    from public.vendor_finance_shared_advance_movements m
   where m.movement_id = v_orig_mov.movement_id;

  if v_has_orig_entry then
    select e.*
      into v_orig_entry
      from public.vendor_finance_entries e
     where e.entry_id = v_orig_entry.entry_id;
  end if;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_orig_mov.project_id,
    case when v_has_orig_entry then v_inserted_entry.entry_id else null end,
    p_app_user_id,
    v_authority_source,
    'SHARED_ADVANCE_MOVEMENT_REVERSED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'movement_id', v_inserted_mov.movement_id,
      'document_no', v_inserted_mov.document_no,
      'reverses_movement_id', v_orig_mov.movement_id,
      'reverses_document_no', v_orig_mov.document_no,
      'amount_minor', v_inserted_mov.amount_minor::text,
      'balance_before_minor', v_inserted_mov.balance_before_minor::text,
      'balance_delta_minor', v_inserted_mov.balance_delta_minor::text,
      'balance_after_minor', v_inserted_mov.balance_after_minor::text,
      'effective_date', v_inserted_mov.effective_date::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'reversal_movement', public.vendor_finance__internal_shared_advance_movement_projection(v_inserted_mov, v_auth),
    'reversed_movement', public.vendor_finance__internal_shared_advance_movement_projection(v_orig_mov, v_auth),
    'shared_advance_balance_minor', v_inserted_mov.balance_after_minor::text
  );

  if v_has_orig_entry then
    v_base_payload := v_base_payload || pg_catalog.jsonb_build_object(
      'reversal_entry', public.vendor_finance__internal_entry_projection(v_inserted_entry, v_auth),
      'reversed_entry', public.vendor_finance__internal_entry_projection(v_orig_entry, v_auth)
    );
  end if;

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'REVERSE_SHARED_ADVANCE_MOVEMENT',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_reverse_shared_advance_movement(uuid, uuid, uuid, date, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_reverse_shared_advance_movement(uuid, uuid, uuid, date, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_create_reconciliation(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_project_id text,
  p_accountant_user_id uuid,
  p_contract_type text,
  p_as_of_date date,
  p_confirmed_balance_minor text,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_today date;
  v_reconcile_scope text;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_pa_candidate_id uuid := null;
  v_vendor public.vendors%rowtype;
  v_proj_acct jsonb;
  v_target_acct_id uuid;
  v_target_acct_name text;
  v_confirmed bigint;
  v_reason text;
  v_actor_name text;
  v_system_num numeric;
  v_system bigint;
  v_latest_seq bigint;
  v_diff bigint;
  v_inserted public.vendor_finance_reconciliations%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'reconcile');
  v_today := (v_auth->>'authorization_date')::date;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'CREATE_RECONCILIATION'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_contract_type is null or p_contract_type not in ('SEASONAL', 'OFFICIAL', 'UNCLASSIFIED') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  if p_as_of_date is null
     or pg_catalog.date_part('year', p_as_of_date)::integer not between 1970 and 2999 then
    raise exception 'VENDOR_FINANCE_DATE_INVALID'
      using errcode = '22023';
  end if;

  v_confirmed := public.vendor_finance__internal_parse_signed_minor(p_confirmed_balance_minor);
  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  -- Canonical DAG: [2]+[3] project -> [4]+[5] actor (+ active PA) -> [6] vendor
  v_project := public.vendor_finance__internal_lock_project(p_project_id);

  select pa.accountant_user_id
    into v_pa_candidate_id
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_project.project_id
     and pa.valid_from <= v_today
     and (pa.valid_to is null or pa.valid_to > v_today)
     and (pa.valid_to is null or pa.valid_to > pa.valid_from)
   order by pa.valid_from desc, pa.version desc
   limit 1;

  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'reconcile',
    array[v_pa_candidate_id, p_accountant_user_id]
  );
  v_today := (v_auth->>'authorization_date')::date;
  v_reconcile_scope := coalesce(v_auth->>'reconcile_scope', 'NONE');
  v_authority_source := v_auth->>'authority_source';
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(v_project.project_id, v_today);

  if p_accountant_user_id is null then
    if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
      if v_reconcile_scope = 'ASSIGNED_PROJECTS' then
        raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
          using errcode = '42501';
      end if;
      raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
        using errcode = '40900';
    end if;

    v_target_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
    v_target_acct_name := v_proj_acct->>'accountant_display_name';
  else
    v_target_acct_id := p_accountant_user_id;
    if v_reconcile_scope = 'ASSIGNED_PROJECTS' and v_target_acct_id <> p_app_user_id then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;

    if not exists (
      select 1
        from public.vendor_finance_project_accountants pa
       where pa.project_id = v_project.project_id
         and pa.accountant_user_id = v_target_acct_id
      union all
      select 1
        from public.vendor_finance_entries e
       where e.vendor_id = v_vendor.vendor_id
         and e.ledger_scope = 'PROJECT_ACCOUNTANT'
         and e.project_id = v_project.project_id
         and e.responsible_accountant_user_id = v_target_acct_id
    ) then
      raise exception 'VENDOR_FINANCE_ACCOUNT_NOT_ELIGIBLE'
        using errcode = '42200';
    end if;

    v_target_acct_name := public.vendor_finance__internal_actor_display_name(v_target_acct_id);
  end if;

  if not public.vendor_finance__internal_can_actor_write_subledger(
    v_auth,
    p_app_user_id,
    'reconcile',
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_target_acct_id
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_reconcile_scope = 'ASSIGNED_PROJECTS'
     and not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  if not exists (
    select 1 from public.vendor_finance_entries e
     where e.vendor_id = v_vendor.vendor_id
       and e.ledger_scope = 'PROJECT_ACCOUNTANT'
       and e.project_id = v_project.project_id
       and e.responsible_accountant_user_id = v_target_acct_id
       and e.contract_type = p_contract_type
    union all
    select 1 from public.vendor_finance_reconciliations r
     where r.vendor_id = v_vendor.vendor_id
       and r.ledger_scope = 'PROJECT_ACCOUNTANT'
       and r.project_id = v_project.project_id
       and r.responsible_accountant_user_id = v_target_acct_id
       and r.contract_type = p_contract_type
    union all
    select 1 from public.vendor_finance_project_accountants pa
     where p_contract_type in ('SEASONAL', 'OFFICIAL')
       and v_vendor.active = true
       and v_project.active = true
       and coalesce((v_proj_acct->>'has_assignment')::boolean, false)
       and coalesce((v_proj_acct->>'accountant_active')::boolean, false)
       and pa.project_id = v_project.project_id
       and pa.accountant_user_id = v_target_acct_id
       and pa.valid_from <= v_today
       and (pa.valid_to is null or pa.valid_to > v_today)
       and (pa.valid_to is null or pa.valid_to > pa.valid_from)
  ) then
    raise exception 'VENDOR_FINANCE_SUBLEDGER_NOT_FOUND' using errcode = 'P0002';
  end if;

  select coalesce(sum(e.balance_delta_minor::numeric) filter (where e.effective_date <= p_as_of_date), 0::numeric),
         coalesce(max(e.vendor_sequence), 0)::bigint
    into v_system_num, v_latest_seq
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_target_acct_id
     and e.contract_type = p_contract_type;

  if v_system_num < (-9223372036854775808)::numeric
     or v_system_num > 9223372036854775807::numeric then
    raise exception 'VENDOR_FINANCE_AMOUNT_OVERFLOW'
      using errcode = '22003';
  end if;

  v_system := v_system_num::bigint;
  v_diff := public.vendor_finance__internal_checked_sub_minor(v_confirmed, v_system);

  insert into public.vendor_finance_reconciliations (
    vendor_id,
    ledger_scope,
    project_id,
    project_display_name_snapshot,
    responsible_accountant_user_id,
    responsible_accountant_display_name_snapshot,
    contract_type,
    as_of_date,
    system_balance_minor,
    confirmed_balance_minor,
    difference_minor,
    ledger_sequence_at_reconciliation,
    reason,
    created_by_user_id,
    created_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_project.display_name,
    v_target_acct_id,
    v_target_acct_name,
    p_contract_type,
    p_as_of_date,
    v_system,
    v_confirmed,
    v_diff,
    v_latest_seq,
    v_reason,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    reconciliation_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    v_inserted.reconciliation_id,
    p_app_user_id,
    v_authority_source,
    'RECONCILIATION_CREATED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'project_id', v_inserted.project_id,
      'responsible_accountant_user_id', v_inserted.responsible_accountant_user_id,
      'contract_type', v_inserted.contract_type,
      'as_of_date', v_inserted.as_of_date::text,
      'system_balance_minor', v_inserted.system_balance_minor::text,
      'confirmed_balance_minor', v_inserted.confirmed_balance_minor::text,
      'difference_minor', v_inserted.difference_minor::text,
      'ledger_sequence_at_reconciliation', v_inserted.ledger_sequence_at_reconciliation
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'reconciliation', public.vendor_finance__internal_reconciliation_projection(v_inserted, v_auth)
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'CREATE_RECONCILIATION',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, text, date, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, text, date, text, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_classify_unclassified_subledger(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_vendor_id text,
  p_project_id text,
  p_accountant_user_id uuid,
  p_target_contract_type text,
  p_reason text,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_today date;
  v_record_scope text;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_project public.direct_entry_projects%rowtype;
  v_pa_candidate_id uuid := null;
  v_vendor public.vendors%rowtype;
  v_proj_acct jsonb;
  v_target_acct_id uuid;
  v_target_acct_name text;
  v_reason text;
  v_actor_name text;
  v_entry_count integer;
  v_rec_count integer;
  v_closing_balance bigint;
  v_target_busy boolean;
  v_inserted public.vendor_finance_subledger_classifications%rowtype;
  v_base_payload jsonb;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'record');
  v_today := (v_auth->>'authorization_date')::date;

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'CLASSIFY_SUBLEDGER_CONTRACT_TYPE'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;
    return v_existing_idem.result_payload || pg_catalog.jsonb_build_object('replayed', true);
  end if;

  if p_target_contract_type is null or p_target_contract_type not in ('SEASONAL', 'OFFICIAL') then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_INVALID'
      using errcode = '22023';
  end if;

  v_reason := public.vendor_finance__internal_validate_reason(p_reason);

  -- Canonical DAG: [2]+[3] project -> [4]+[5] actor (+ active PA) -> [6] vendor
  v_project := public.vendor_finance__internal_lock_project(p_project_id);

  select pa.accountant_user_id
    into v_pa_candidate_id
    from public.vendor_finance_project_accountants pa
   where pa.project_id = v_project.project_id
     and pa.valid_from <= v_today
     and (pa.valid_to is null or pa.valid_to > v_today)
     and (pa.valid_to is null or pa.valid_to > pa.valid_from)
   order by pa.valid_from desc, pa.version desc
   limit 1;

  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    'record',
    array[v_pa_candidate_id, p_accountant_user_id]
  );
  v_today := (v_auth->>'authorization_date')::date;
  v_record_scope := coalesce(v_auth->>'record_scope', 'NONE');
  v_authority_source := v_auth->>'authority_source';
  v_actor_name := public.vendor_finance__internal_actor_display_name(p_app_user_id);

  v_vendor := public.vendor_finance__internal_lock_vendor(p_vendor_id);

  v_proj_acct := public.vendor_finance__internal_resolve_active_project_accountant(v_project.project_id, v_today);

  if p_accountant_user_id is null then
    if not coalesce((v_proj_acct->>'has_assignment')::boolean, false) then
      if v_record_scope = 'ASSIGNED_PROJECTS' then
        raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
          using errcode = '42501';
      end if;
      raise exception 'VENDOR_FINANCE_PROJECT_UNASSIGNED'
        using errcode = '40900';
    end if;
    v_target_acct_id := (v_proj_acct->>'accountant_user_id')::uuid;
  else
    v_target_acct_id := p_accountant_user_id;
    if v_record_scope = 'ASSIGNED_PROJECTS' and v_target_acct_id <> p_app_user_id then
      raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
        using errcode = '42501';
    end if;
  end if;

  if not public.vendor_finance__internal_can_actor_write_subledger(
    v_auth,
    p_app_user_id,
    'record',
    'PROJECT_ACCOUNTANT',
    v_project.project_id,
    v_target_acct_id
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  if v_record_scope = 'ASSIGNED_PROJECTS'
     and not coalesce((v_proj_acct->>'accountant_active')::boolean, false) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCOUNTANT_INACTIVE'
      using errcode = '40900';
  end if;

  if exists (
    select 1
      from public.vendor_finance_subledger_classifications c
     where c.vendor_id = v_vendor.vendor_id
       and c.project_id = v_project.project_id
       and c.responsible_accountant_user_id = v_target_acct_id
  ) then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_ALREADY_CLASSIFIED'
      using errcode = '23505';
  end if;

  select count(*)::integer
    into v_entry_count
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_target_acct_id
     and e.contract_type = 'UNCLASSIFIED';

  if coalesce(v_entry_count, 0) = 0 then
    raise exception 'VENDOR_FINANCE_SUBLEDGER_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  select count(*)::integer
    into v_rec_count
    from public.vendor_finance_reconciliations r
   where r.vendor_id = v_vendor.vendor_id
     and r.ledger_scope = 'PROJECT_ACCOUNTANT'
     and r.project_id = v_project.project_id
     and r.responsible_accountant_user_id = v_target_acct_id
     and r.contract_type = 'UNCLASSIFIED';

  select e.balance_after_minor
    into v_closing_balance
    from public.vendor_finance_entries e
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_target_acct_id
     and e.contract_type = 'UNCLASSIFIED'
   order by e.vendor_sequence desc
   limit 1;

  select exists (
           select 1
             from public.vendor_finance_entries e
            where e.vendor_id = v_vendor.vendor_id
              and e.ledger_scope = 'PROJECT_ACCOUNTANT'
              and e.project_id = v_project.project_id
              and e.responsible_accountant_user_id = v_target_acct_id
              and e.contract_type = p_target_contract_type
           union all
           select 1
             from public.vendor_finance_reconciliations r
            where r.vendor_id = v_vendor.vendor_id
              and r.ledger_scope = 'PROJECT_ACCOUNTANT'
              and r.project_id = v_project.project_id
              and r.responsible_accountant_user_id = v_target_acct_id
              and r.contract_type = p_target_contract_type
         )
    into v_target_busy;

  if v_target_busy then
    raise exception 'VENDOR_FINANCE_CONTRACT_TYPE_TARGET_NOT_EMPTY'
      using errcode = '23505';
  end if;

  v_target_acct_name := public.vendor_finance__internal_actor_display_name(v_target_acct_id);

  perform pg_catalog.set_config('vendor_finance.classify_write_marker', 'on', true);

  update public.vendor_finance_entries e
     set contract_type = p_target_contract_type
   where e.vendor_id = v_vendor.vendor_id
     and e.ledger_scope = 'PROJECT_ACCOUNTANT'
     and e.project_id = v_project.project_id
     and e.responsible_accountant_user_id = v_target_acct_id
     and e.contract_type = 'UNCLASSIFIED';

  update public.vendor_finance_reconciliations r
     set contract_type = p_target_contract_type
   where r.vendor_id = v_vendor.vendor_id
     and r.ledger_scope = 'PROJECT_ACCOUNTANT'
     and r.project_id = v_project.project_id
     and r.responsible_accountant_user_id = v_target_acct_id
     and r.contract_type = 'UNCLASSIFIED';

  update public.vendor_finance_opening_batches b
     set contract_type = p_target_contract_type
   where b.ledger_scope = 'PROJECT_ACCOUNTANT'
     and b.project_id = v_project.project_id
     and b.responsible_accountant_user_id = v_target_acct_id
     and b.contract_type = 'UNCLASSIFIED'
     and exists (
       select 1
         from public.vendor_finance_entries e
        where e.opening_batch_id = b.batch_id
          and e.vendor_id = v_vendor.vendor_id
          and e.contract_type = p_target_contract_type
     )
     and not exists (
       select 1
         from public.vendor_finance_entries e2
        where e2.opening_batch_id = b.batch_id
          and e2.contract_type <> p_target_contract_type
     );

  insert into public.vendor_finance_subledger_classifications (
    vendor_id,
    project_id,
    responsible_accountant_user_id,
    source_contract_type,
    target_contract_type,
    classified_entry_count,
    classified_reconciliation_count,
    closing_balance_minor,
    reason,
    classified_by_user_id,
    classified_by_display_name_snapshot,
    idempotency_key,
    request_fingerprint
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    v_target_acct_id,
    'UNCLASSIFIED',
    p_target_contract_type,
    v_entry_count,
    coalesce(v_rec_count, 0),
    coalesce(v_closing_balance, 0),
    v_reason,
    p_app_user_id,
    v_actor_name,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  perform pg_catalog.set_config('vendor_finance.classify_write_marker', '', true);

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    actor_user_id,
    authority_source,
    action,
    reason,
    metadata,
    idempotency_key
  ) values (
    v_vendor.vendor_id,
    v_project.project_id,
    p_app_user_id,
    v_authority_source,
    'SUBLEDGER_CONTRACT_TYPE_CLASSIFIED',
    v_reason,
    pg_catalog.jsonb_build_object(
      'classification_id', v_inserted.classification_id,
      'project_id', v_inserted.project_id,
      'responsible_accountant_user_id', v_inserted.responsible_accountant_user_id,
      'source_contract_type', v_inserted.source_contract_type,
      'target_contract_type', v_inserted.target_contract_type,
      'classified_entry_count', v_inserted.classified_entry_count,
      'classified_reconciliation_count', v_inserted.classified_reconciliation_count,
      'closing_balance_minor', v_inserted.closing_balance_minor::text
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'classification', pg_catalog.jsonb_build_object(
      'classification_id', v_inserted.classification_id,
      'vendor_id', v_inserted.vendor_id,
      'project_id', v_inserted.project_id,
      'project_display_name_snapshot', v_project.display_name,
      'accountant_ref', v_inserted.responsible_accountant_user_id,
      'responsible_accountant_display_name', v_target_acct_name,
      'source_contract_type', v_inserted.source_contract_type,
      'target_contract_type', v_inserted.target_contract_type,
      'classified_entry_count', v_inserted.classified_entry_count,
      'classified_reconciliation_count', v_inserted.classified_reconciliation_count,
      'closing_balance_minor', v_inserted.closing_balance_minor::text,
      'reason', v_inserted.reason,
      'classified_by_display_name', v_inserted.classified_by_display_name_snapshot,
      'classified_at', pg_catalog.to_jsonb(v_inserted.classified_at)
    )
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'CLASSIFY_SUBLEDGER_CONTRACT_TYPE',
    p_request_fingerprint,
    v_base_payload
  );

  return v_base_payload || pg_catalog.jsonb_build_object('replayed', false);
end;
$function$;

revoke all on function public.vendor_finance_classify_unclassified_subledger(uuid, uuid, text, text, uuid, text, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_classify_unclassified_subledger(uuid, uuid, text, text, uuid, text, text, uuid, text)
  to service_role;

create or replace function public.vendor_finance_reserve_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_target_kind text,
  p_target_id uuid,
  p_mime_type text,
  p_size_bytes integer,
  p_checksum_sha256 text,
  p_ttl_seconds integer,
  p_idempotency_key uuid,
  p_request_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_existing_idem public.vendor_finance_idempotency%rowtype;
  v_replayed_ev public.vendor_finance_evidence%rowtype;
  v_entry public.vendor_finance_entries%rowtype;
  v_rec public.vendor_finance_reconciliations%rowtype;
  v_vendor_id text;
  v_project_id text := null;
  v_ledger_scope text;
  v_acct_id uuid := null;
  v_entry_id uuid := null;
  v_reconciliation_id uuid := null;
  v_target_segment text;
  v_write_mode text;
  v_ready_exists boolean;
  v_superseded_keys text[] := array[]::text[];
  v_evidence_id uuid;
  v_storage_key text;
  v_now timestamptz := now();
  v_expires_at timestamptz;
  v_inserted public.vendor_finance_evidence%rowtype;
  v_base_payload jsonb;
begin
  v_write_mode := case when p_target_kind = 'RECONCILIATION' then 'reconcile' else 'record' end;
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, v_write_mode);

  if p_idempotency_key is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_IDEMPOTENCY_INVALID'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('vfin_idem:' || p_app_user_id::text || ':' || p_idempotency_key::text, 0)
  );

  select i.*
    into v_existing_idem
    from public.vendor_finance_idempotency i
   where i.actor_user_id = p_app_user_id
     and i.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_idem.action <> 'RESERVE_EVIDENCE'
       or v_existing_idem.request_fingerprint <> p_request_fingerprint then
      raise exception 'VENDOR_FINANCE_IDEMPOTENCY_CONFLICT'
        using errcode = '23505';
    end if;

    select ev.*
      into v_replayed_ev
      from public.vendor_finance_evidence ev
     where ev.evidence_id = (v_existing_idem.result_payload->'reservation'->>'evidence_id')::uuid;

    if not found or v_replayed_ev.status <> 'RESERVED' or v_replayed_ev.expires_at <= v_now then
      if found and v_replayed_ev.status = 'READY' then
        raise exception 'VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED'
          using errcode = '23505';
      end if;
      raise exception 'VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED'
        using errcode = '40900';
    end if;

    return pg_catalog.jsonb_build_object(
      'reservation', v_existing_idem.result_payload->'reservation',
      'superseded_storage_keys', '[]'::jsonb,
      'replayed', true
    );
  end if;

  if p_target_kind is null or p_target_kind not in ('ENTRY', 'RECONCILIATION')
     or p_target_id is null then
    raise exception 'VENDOR_FINANCE_EVIDENCE_TARGET_INVALID'
      using errcode = '22023';
  end if;

  if p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/png') then
    raise exception 'VENDOR_FINANCE_EVIDENCE_MIME_INVALID'
      using errcode = '22023';
  end if;

  if p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 10485760 then
    raise exception 'VENDOR_FINANCE_EVIDENCE_SIZE_INVALID'
      using errcode = '22023';
  end if;

  if p_checksum_sha256 is null or p_checksum_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'VENDOR_FINANCE_EVIDENCE_CHECKSUM_INVALID'
      using errcode = '22023';
  end if;

  if p_ttl_seconds is null or p_ttl_seconds < 1 or p_ttl_seconds > 900 then
    raise exception 'VENDOR_FINANCE_EVIDENCE_TTL_INVALID'
      using errcode = '22023';
  end if;

  if p_target_kind = 'ENTRY' then
    select e.*
      into v_entry
      from public.vendor_finance_entries e
     where e.entry_id = p_target_id;

    if not found then
      raise exception 'VENDOR_FINANCE_ENTRY_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    v_vendor_id := v_entry.vendor_id;
    v_project_id := v_entry.project_id;
    v_ledger_scope := v_entry.ledger_scope;
    v_acct_id := v_entry.responsible_accountant_user_id;
    v_entry_id := v_entry.entry_id;
    v_target_segment := 'entry';
  else
    select r.*
      into v_rec
      from public.vendor_finance_reconciliations r
     where r.reconciliation_id = p_target_id;

    if not found then
      raise exception 'VENDOR_FINANCE_RECONCILIATION_NOT_FOUND'
        using errcode = 'P0002';
    end if;

    v_vendor_id := v_rec.vendor_id;
    v_project_id := v_rec.project_id;
    v_ledger_scope := v_rec.ledger_scope;
    v_acct_id := v_rec.responsible_accountant_user_id;
    v_reconciliation_id := v_rec.reconciliation_id;
    v_target_segment := 'reconciliation';
  end if;

  -- Canonical DAG: [2]+[3] project (if any) -> [4]+[5] actor -> [6] vendor
  if v_project_id is not null then
    perform public.vendor_finance__internal_lock_project(v_project_id);
  end if;

  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    v_write_mode,
    array[]::uuid[]
  );
  v_authority_source := v_auth->>'authority_source';

  if not public.vendor_finance__internal_can_actor_write_subledger(
    v_auth, p_app_user_id, v_write_mode, v_ledger_scope, v_project_id, v_acct_id
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  perform public.vendor_finance__internal_lock_vendor(v_vendor_id);

  if v_entry_id is not null then
    select exists (
             select 1
               from public.vendor_finance_evidence ev
              where ev.entry_id = v_entry_id
                and ev.status = 'READY'
           )
      into v_ready_exists;
  else
    select exists (
             select 1
               from public.vendor_finance_evidence ev
              where ev.reconciliation_id = v_reconciliation_id
                and ev.status = 'READY'
           )
      into v_ready_exists;
  end if;

  if v_ready_exists then
    raise exception 'VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED'
      using errcode = '23505';
  end if;

  perform pg_catalog.set_config('vendor_finance.evidence_transition', 'on', true);

  if v_entry_id is not null then
    with superseded as (
      update public.vendor_finance_evidence ev
         set status = 'EXPIRED',
             cleanup_after = v_now,
             failure_code = 'SUPERSEDED_BY_RETRY'
       where ev.entry_id = v_entry_id
         and ev.status = 'RESERVED'
      returning ev.storage_key
    )
    select coalesce(pg_catalog.array_agg(s.storage_key), array[]::text[])
      into v_superseded_keys
      from superseded s;
  else
    with superseded as (
      update public.vendor_finance_evidence ev
         set status = 'EXPIRED',
             cleanup_after = v_now,
             failure_code = 'SUPERSEDED_BY_RETRY'
       where ev.reconciliation_id = v_reconciliation_id
         and ev.status = 'RESERVED'
      returning ev.storage_key
    )
    select coalesce(pg_catalog.array_agg(s.storage_key), array[]::text[])
      into v_superseded_keys
      from superseded s;
  end if;

  v_evidence_id := gen_random_uuid();
  v_storage_key := 'vfin-01/' || v_target_segment || '/' || p_target_id::text || '/' || v_evidence_id::text;
  v_expires_at := v_now + pg_catalog.make_interval(secs => p_ttl_seconds);

  insert into public.vendor_finance_evidence (
    evidence_id,
    entry_id,
    reconciliation_id,
    status,
    storage_key,
    mime_type,
    size_bytes,
    checksum_sha256,
    reserved_by_user_id,
    reserved_at,
    expires_at,
    idempotency_key,
    request_fingerprint
  ) values (
    v_evidence_id,
    v_entry_id,
    v_reconciliation_id,
    'RESERVED',
    v_storage_key,
    p_mime_type,
    p_size_bytes,
    p_checksum_sha256,
    p_app_user_id,
    v_now,
    v_expires_at,
    p_idempotency_key,
    p_request_fingerprint
  )
  returning * into v_inserted;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    reconciliation_id,
    evidence_id,
    actor_user_id,
    authority_source,
    action,
    metadata,
    idempotency_key
  ) values (
    v_vendor_id,
    v_project_id,
    v_entry_id,
    v_reconciliation_id,
    v_inserted.evidence_id,
    p_app_user_id,
    v_authority_source,
    'EVIDENCE_RESERVED',
    pg_catalog.jsonb_build_object(
      'target_kind', p_target_kind,
      'mime_type', v_inserted.mime_type,
      'size_bytes', v_inserted.size_bytes,
      'checksum_sha256', v_inserted.checksum_sha256
    ),
    p_idempotency_key
  );

  v_base_payload := pg_catalog.jsonb_build_object(
    'reservation', pg_catalog.jsonb_build_object(
      'evidence_id', v_inserted.evidence_id,
      'target_kind', p_target_kind,
      'target_id', p_target_id,
      'status', v_inserted.status,
      'storage_key', v_inserted.storage_key,
      'mime_type', v_inserted.mime_type,
      'size_bytes', v_inserted.size_bytes,
      'checksum_sha256', v_inserted.checksum_sha256,
      'reserved_at', pg_catalog.to_jsonb(v_inserted.reserved_at),
      'expires_at', pg_catalog.to_jsonb(v_inserted.expires_at)
    )
  );

  insert into public.vendor_finance_idempotency (
    actor_user_id,
    idempotency_key,
    action,
    request_fingerprint,
    result_payload
  ) values (
    p_app_user_id,
    p_idempotency_key,
    'RESERVE_EVIDENCE',
    p_request_fingerprint,
    v_base_payload
  );

  return pg_catalog.jsonb_build_object(
    'reservation', v_base_payload->'reservation',
    'superseded_storage_keys', pg_catalog.to_jsonb(v_superseded_keys),
    'replayed', false
  );
end;
$function$;

revoke all on function public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)
  to service_role;

create or replace function public.vendor_finance_complete_evidence(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_evidence_id uuid,
  p_outcome text,
  p_failure_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_authority_source text;
  v_ev public.vendor_finance_evidence%rowtype;
  v_entry public.vendor_finance_entries%rowtype;
  v_rec public.vendor_finance_reconciliations%rowtype;
  v_vendor_id text;
  v_project_id text := null;
  v_ledger_scope text;
  v_acct_id uuid := null;
  v_write_mode text;
  v_now timestamptz := now();
  v_updated public.vendor_finance_evidence%rowtype;
  v_target_kind text;
  v_target_id uuid;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');

  if not coalesce((v_auth->>'can_record')::boolean, false)
     and not coalesce((v_auth->>'can_reconcile')::boolean, false) then
    raise exception 'VENDOR_FINANCE_RECORD_DENIED'
      using errcode = '42501';
  end if;

  if p_evidence_id is null
     or p_outcome is null
     or p_outcome not in ('INFO', 'READY', 'FAILED', 'EXPIRED') then
    raise exception 'VENDOR_FINANCE_EVIDENCE_INVALID'
      using errcode = '22023';
  end if;

  select ev.*
    into v_ev
    from public.vendor_finance_evidence ev
   where ev.evidence_id = p_evidence_id;

  if not found then
    raise exception 'VENDOR_FINANCE_EVIDENCE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_ev.entry_id is not null then
    select e.* into v_entry
      from public.vendor_finance_entries e
     where e.entry_id = v_ev.entry_id;

    v_vendor_id := v_entry.vendor_id;
    v_project_id := v_entry.project_id;
    v_ledger_scope := v_entry.ledger_scope;
    v_acct_id := v_entry.responsible_accountant_user_id;
    v_write_mode := 'record';
    v_target_kind := 'ENTRY';
    v_target_id := v_ev.entry_id;
  else
    select r.* into v_rec
      from public.vendor_finance_reconciliations r
     where r.reconciliation_id = v_ev.reconciliation_id;

    v_vendor_id := v_rec.vendor_id;
    v_project_id := v_rec.project_id;
    v_ledger_scope := v_rec.ledger_scope;
    v_acct_id := v_rec.responsible_accountant_user_id;
    v_write_mode := 'reconcile';
    v_target_kind := 'RECONCILIATION';
    v_target_id := v_ev.reconciliation_id;
  end if;

  -- Canonical DAG: [2]+[3] project (if any) -> [4]+[5] actor -> [6] vendor
  if v_project_id is not null then
    perform public.vendor_finance__internal_lock_project(v_project_id);
  end if;

  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    v_write_mode,
    array[]::uuid[]
  );
  v_authority_source := v_auth->>'authority_source';

  if not public.vendor_finance__internal_can_actor_write_subledger(
    v_auth, p_app_user_id, v_write_mode, v_ledger_scope, v_project_id, v_acct_id
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  perform public.vendor_finance__internal_lock_vendor(v_vendor_id);

  select ev.* into v_ev
    from public.vendor_finance_evidence ev
   where ev.evidence_id = p_evidence_id;

  if p_outcome = 'INFO' then
    if v_ev.status = 'RESERVED' and v_ev.expires_at <= v_now then
      perform pg_catalog.set_config('vendor_finance.evidence_transition', 'on', true);

      update public.vendor_finance_evidence ev
         set status = 'EXPIRED',
             cleanup_after = v_now,
             failure_code = 'RESERVATION_TTL_EXPIRED'
       where ev.evidence_id = v_ev.evidence_id
      returning * into v_ev;

      insert into public.vendor_finance_audit_events (
        vendor_id,
        project_id,
        entry_id,
        reconciliation_id,
        evidence_id,
        actor_user_id,
        authority_source,
        action,
        metadata
      ) values (
        v_vendor_id,
        v_project_id,
        v_ev.entry_id,
        v_ev.reconciliation_id,
        v_ev.evidence_id,
        p_app_user_id,
        v_authority_source,
        'EVIDENCE_EXPIRED',
        pg_catalog.jsonb_build_object(
          'failure_code', v_ev.failure_code
        )
      );
    end if;

    return pg_catalog.jsonb_build_object(
      'evidence_id', v_ev.evidence_id,
      'target_kind', v_target_kind,
      'target_id', v_target_id,
      'status', v_ev.status,
      'storage_key', v_ev.storage_key,
      'mime_type', v_ev.mime_type,
      'size_bytes', v_ev.size_bytes,
      'checksum_sha256', v_ev.checksum_sha256,
      'expires_at', pg_catalog.to_jsonb(v_ev.expires_at),
      'finalized_at', pg_catalog.to_jsonb(v_ev.finalized_at),
      'is_expired', (v_ev.status = 'EXPIRED')
    );
  end if;

  if v_ev.status = 'READY' then
    if p_outcome = 'READY' then
      return pg_catalog.jsonb_build_object(
        'evidence', pg_catalog.jsonb_build_object(
          'evidence_id', v_ev.evidence_id,
          'target_kind', v_target_kind,
          'target_id', v_target_id,
          'status', v_ev.status,
          'mime_type', v_ev.mime_type,
          'size_bytes', v_ev.size_bytes,
          'checksum_sha256', v_ev.checksum_sha256,
          'finalized_at', pg_catalog.to_jsonb(v_ev.finalized_at)
        ),
        'replayed', true
      );
    end if;
    raise exception 'VENDOR_FINANCE_EVIDENCE_ALREADY_ATTACHED'
      using errcode = '23505';
  end if;

  if p_outcome = 'EXPIRED' then
    if v_ev.status in ('EXPIRED', 'FAILED') then
      return pg_catalog.jsonb_build_object(
        'evidence_id', v_ev.evidence_id,
        'status', v_ev.status,
        'failure_code', v_ev.failure_code
      );
    end if;

    perform pg_catalog.set_config('vendor_finance.evidence_transition', 'on', true);

    update public.vendor_finance_evidence ev
       set status = 'EXPIRED',
           cleanup_after = v_now,
           failure_code = coalesce(nullif(pg_catalog.btrim(p_failure_code), ''), 'RESERVATION_TTL_EXPIRED')
     where ev.evidence_id = v_ev.evidence_id
    returning * into v_updated;

    insert into public.vendor_finance_audit_events (
      vendor_id,
      project_id,
      entry_id,
      reconciliation_id,
      evidence_id,
      actor_user_id,
      authority_source,
      action,
      metadata
    ) values (
      v_vendor_id,
      v_project_id,
      v_ev.entry_id,
      v_ev.reconciliation_id,
      v_updated.evidence_id,
      p_app_user_id,
      v_authority_source,
      'EVIDENCE_EXPIRED',
      pg_catalog.jsonb_build_object(
        'failure_code', v_updated.failure_code
      )
    );

    return pg_catalog.jsonb_build_object(
      'evidence_id', v_updated.evidence_id,
      'status', v_updated.status,
      'failure_code', v_updated.failure_code
    );
  end if;

  if v_ev.status <> 'RESERVED' then
    raise exception 'VENDOR_FINANCE_EVIDENCE_RESERVATION_EXPIRED'
      using errcode = '40900';
  end if;

  perform pg_catalog.set_config('vendor_finance.evidence_transition', 'on', true);

  if p_outcome = 'FAILED' then
    update public.vendor_finance_evidence ev
       set status = 'FAILED',
           cleanup_after = v_now,
           failure_code = coalesce(nullif(pg_catalog.btrim(p_failure_code), ''), 'VERIFICATION_FAILED')
     where ev.evidence_id = v_ev.evidence_id
    returning * into v_updated;

    insert into public.vendor_finance_audit_events (
      vendor_id,
      project_id,
      entry_id,
      reconciliation_id,
      evidence_id,
      actor_user_id,
      authority_source,
      action,
      metadata
    ) values (
      v_vendor_id,
      v_project_id,
      v_ev.entry_id,
      v_ev.reconciliation_id,
      v_updated.evidence_id,
      p_app_user_id,
      v_authority_source,
      'EVIDENCE_FAILED',
      pg_catalog.jsonb_build_object(
        'failure_code', v_updated.failure_code
      )
    );

    return pg_catalog.jsonb_build_object(
      'evidence_id', v_updated.evidence_id,
      'status', v_updated.status,
      'failure_code', v_updated.failure_code
    );
  end if;

  if v_ev.expires_at <= v_now then
    update public.vendor_finance_evidence ev
       set status = 'EXPIRED',
           cleanup_after = v_now,
           failure_code = 'RESERVATION_TTL_EXPIRED'
     where ev.evidence_id = v_ev.evidence_id
    returning * into v_updated;

    insert into public.vendor_finance_audit_events (
      vendor_id,
      project_id,
      entry_id,
      reconciliation_id,
      evidence_id,
      actor_user_id,
      authority_source,
      action,
      metadata
    ) values (
      v_vendor_id,
      v_project_id,
      v_ev.entry_id,
      v_ev.reconciliation_id,
      v_updated.evidence_id,
      p_app_user_id,
      v_authority_source,
      'EVIDENCE_EXPIRED',
      pg_catalog.jsonb_build_object(
        'failure_code', v_updated.failure_code
      )
    );

    return pg_catalog.jsonb_build_object(
      'expired', true,
      'evidence_id', v_updated.evidence_id,
      'status', v_updated.status,
      'failure_code', v_updated.failure_code
    );
  end if;

  update public.vendor_finance_evidence ev
     set status = 'READY',
         finalized_at = v_now
   where ev.evidence_id = v_ev.evidence_id
  returning * into v_updated;

  insert into public.vendor_finance_audit_events (
    vendor_id,
    project_id,
    entry_id,
    reconciliation_id,
    evidence_id,
    actor_user_id,
    authority_source,
    action,
    metadata
  ) values (
    v_vendor_id,
    v_project_id,
    v_ev.entry_id,
    v_ev.reconciliation_id,
    v_updated.evidence_id,
    p_app_user_id,
    v_authority_source,
    'EVIDENCE_FINALIZED',
    pg_catalog.jsonb_build_object(
      'mime_type', v_updated.mime_type,
      'size_bytes', v_updated.size_bytes,
      'checksum_sha256', v_updated.checksum_sha256
    )
  );

  return pg_catalog.jsonb_build_object(
    'evidence', pg_catalog.jsonb_build_object(
      'evidence_id', v_updated.evidence_id,
      'target_kind', v_target_kind,
      'target_id', v_target_id,
      'status', v_updated.status,
      'mime_type', v_updated.mime_type,
      'size_bytes', v_updated.size_bytes,
      'checksum_sha256', v_updated.checksum_sha256,
      'finalized_at', pg_catalog.to_jsonb(v_updated.finalized_at)
    ),
    'replayed', false
  );
end;
$function$;

revoke all on function public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)
  to service_role;

create or replace function public.vendor_finance_mark_evidence_cleaned(
  p_auth_subject uuid,
  p_app_user_id uuid,
  p_evidence_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_auth jsonb;
  v_ev public.vendor_finance_evidence%rowtype;
  v_entry public.vendor_finance_entries%rowtype;
  v_rec public.vendor_finance_reconciliations%rowtype;
  v_vendor_id text;
  v_project_id text := null;
  v_ledger_scope text;
  v_acct_id uuid := null;
  v_write_mode text;
begin
  v_auth := public.vendor_finance__internal_assert_authority(p_auth_subject, p_app_user_id, 'view');

  if not coalesce((v_auth->>'can_record')::boolean, false)
     and not coalesce((v_auth->>'can_reconcile')::boolean, false) then
    raise exception 'VENDOR_FINANCE_RECORD_DENIED'
      using errcode = '42501';
  end if;

  if p_evidence_id is null then
    raise exception 'VENDOR_FINANCE_EVIDENCE_INVALID'
      using errcode = '22023';
  end if;

  select ev.*
    into v_ev
    from public.vendor_finance_evidence ev
   where ev.evidence_id = p_evidence_id;

  if not found then
    raise exception 'VENDOR_FINANCE_EVIDENCE_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if v_ev.entry_id is not null then
    select e.* into v_entry
      from public.vendor_finance_entries e
     where e.entry_id = v_ev.entry_id;

    v_vendor_id := v_entry.vendor_id;
    v_project_id := v_entry.project_id;
    v_ledger_scope := v_entry.ledger_scope;
    v_acct_id := v_entry.responsible_accountant_user_id;
    v_write_mode := 'record';
  else
    select r.* into v_rec
      from public.vendor_finance_reconciliations r
     where r.reconciliation_id = v_ev.reconciliation_id;

    v_vendor_id := v_rec.vendor_id;
    v_project_id := v_rec.project_id;
    v_ledger_scope := v_rec.ledger_scope;
    v_acct_id := v_rec.responsible_accountant_user_id;
    v_write_mode := 'reconcile';
  end if;

  -- Canonical DAG: [2]+[3] project (if any) -> [4]+[5] actor -> [6] vendor
  if v_project_id is not null then
    perform public.vendor_finance__internal_lock_project(v_project_id);
  end if;

  v_auth := public.vendor_finance__internal_lock_actor_and_assert_authority(
    p_auth_subject,
    p_app_user_id,
    v_write_mode,
    array[]::uuid[]
  );

  if not public.vendor_finance__internal_can_actor_write_subledger(
    v_auth, p_app_user_id, v_write_mode, v_ledger_scope, v_project_id, v_acct_id
  ) then
    raise exception 'VENDOR_FINANCE_PROJECT_ACCESS_DENIED'
      using errcode = '42501';
  end if;

  perform public.vendor_finance__internal_lock_vendor(v_vendor_id);

  select ev.*
    into v_ev
    from public.vendor_finance_evidence ev
   where ev.evidence_id = p_evidence_id;

  if v_ev.status not in ('FAILED', 'EXPIRED') then
    raise exception 'VENDOR_FINANCE_EVIDENCE_CLEANUP_INVALID'
      using errcode = '22023';
  end if;

  if v_ev.cleaned_up_at is null then
    perform pg_catalog.set_config('vendor_finance.evidence_transition', 'on', true);
    update public.vendor_finance_evidence ev
       set cleaned_up_at = now()
     where ev.evidence_id = v_ev.evidence_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'evidence_id', v_ev.evidence_id,
    'cleaned', true
  );
end;
$function$;

revoke all on function public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)
  to service_role;

-- -----------------------------------------------------------------------------
-- 6. Owner Alignment (Guarded for non-superuser migration runners)
-- -----------------------------------------------------------------------------

do $align_wp8a$
declare
  v_base_owner_oid oid;
  v_base_owner name;
  v_can_set_owner boolean;
  v_sig text;
  v_proc_owner_oid oid;
  v_sigs text[] := array[
    'public.org_department__internal_has_active_membership(uuid, text, date)',
    'public.org_department__internal_resolve_vfin_default_authority(uuid, uuid, date)',
    'public.org_department__internal_has_personal_assignments(uuid, timestamp with time zone)',
    'public.org_department__internal_account_summary(uuid)',
    'public.salary_advance__internal_is_effective_project_manager(uuid, text, date)',
    'public.salary_advance__internal_actor_display_name(uuid)',
    'public.salary_advance__internal_resolve_authority(uuid, uuid)',
    'public.salary_advance__internal_request_access(jsonb, uuid, public.salary_advance_requests)',
    'public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer)',
    'public.salary_advance_list_project_worker_history(uuid, uuid, text, uuid, text, text, text, text, text, integer)',
    'public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text, text)',
    'public.salary_advance_post_message(uuid, uuid, uuid, integer, text, text, text)',
    'public.salary_advance_transition_request(uuid, uuid, uuid, text, integer, text, text, text)',
    'public.salary_advance_reserve_evidence(uuid, uuid, uuid, integer, text, integer, text, text, text, text)',
    'public.salary_advance_finalize_evidence(uuid, uuid, uuid, uuid, integer, text, text)',
    'public.salary_advance_review_evidence(uuid, uuid, uuid, integer, integer, text, uuid, integer, text, text, text)',
    'public.vendor_finance__internal_actor_display_name(uuid)',
    'public.vendor_finance__internal_lock_project(text)',
    'public.vendor_finance__internal_resolve_active_project_accountant(text, date)',
    'public.vendor_finance__internal_can_actor_write_subledger(jsonb, uuid, text, text, text, uuid)',
    'public.vendor_finance__internal_resolve_authority(uuid, uuid)',
    'public.vendor_finance__internal_lock_actor_and_assert_authority(uuid, uuid, text, uuid[])',
    'public.vendor_finance_list_project_accountants_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text)',
    'public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.vendor_finance_list_global_roles_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text)',
    'public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text, text)',
    'public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)',
    'public.vendor_finance_record_payment_with_offset(uuid, uuid, text, text, text, text, text, date, text, uuid, text)',
    'public.vendor_finance_apply_opening_batch(uuid, uuid, text, text, date, jsonb, text, uuid, text)',
    'public.vendor_finance_fund_shared_advance(uuid, uuid, text, text, date, text, uuid, text)',
    'public.vendor_finance_record_vendor_refund(uuid, uuid, text, text, date, text, uuid, text)',
    'public.vendor_finance_apply_shared_advance_offset(uuid, uuid, text, text, text, text, date, text, uuid, text)',
    'public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)',
    'public.vendor_finance_reverse_shared_advance_movement(uuid, uuid, uuid, date, text, uuid, text)',
    'public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, text, date, text, text, uuid, text)',
    'public.vendor_finance_classify_unclassified_subledger(uuid, uuid, text, text, uuid, text, text, uuid, text)',
    'public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)',
    'public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)',
    'public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)'
  ];
begin
  select c.relowner, r.rolname
    into v_base_owner_oid, v_base_owner
    from pg_catalog.pg_class c
    join pg_catalog.pg_roles r on r.oid = c.relowner
   where c.oid = 'public.direct_entry_app_users'::pg_catalog.regclass;

  if v_base_owner_oid is null then
    raise exception 'WP8A_ALIGN_BASE_OWNER_MISSING';
  end if;

  v_can_set_owner := pg_catalog.pg_has_role(current_user, v_base_owner_oid, 'SET');

  foreach v_sig in array v_sigs loop
    select p.proowner
      into v_proc_owner_oid
      from pg_catalog.pg_proc p
     where p.oid = v_sig::pg_catalog.regprocedure;

    if v_proc_owner_oid is null then
      raise exception 'WP8A_ALIGN_FUNCTION_MISSING: %', v_sig;
    end if;

    if v_proc_owner_oid <> v_base_owner_oid and v_can_set_owner then
      execute pg_catalog.format('alter function %s owner to %I', v_sig, v_base_owner);
    end if;
  end loop;
end
$align_wp8a$;

-- -----------------------------------------------------------------------------
-- 7. Fail-Closed ACL & Security Postcondition Self-Check
-- -----------------------------------------------------------------------------

do $check_wp8a$
declare
  v_sig text;
  v_oid oid;
  v_secdef boolean;
  v_proconfig text[];
  v_owner_priv boolean;
  v_exposed integer;
  v_svc_grant integer;
  v_internal_fns text[] := array[
    'public.org_department__internal_has_active_membership(uuid, text, date)',
    'public.org_department__internal_resolve_vfin_default_authority(uuid, uuid, date)',
    'public.org_department__internal_has_personal_assignments(uuid, timestamp with time zone)',
    'public.org_department__internal_account_summary(uuid)',
    'public.salary_advance__internal_is_effective_project_manager(uuid, text, date)',
    'public.salary_advance__internal_actor_display_name(uuid)',
    'public.salary_advance__internal_resolve_authority(uuid, uuid)',
    'public.salary_advance__internal_request_access(jsonb, uuid, public.salary_advance_requests)',
    'public.vendor_finance__internal_actor_display_name(uuid)',
    'public.vendor_finance__internal_lock_project(text)',
    'public.vendor_finance__internal_resolve_active_project_accountant(text, date)',
    'public.vendor_finance__internal_can_actor_write_subledger(jsonb, uuid, text, text, text, uuid)',
    'public.vendor_finance__internal_resolve_authority(uuid, uuid)',
    'public.vendor_finance__internal_lock_actor_and_assert_authority(uuid, uuid, text, uuid[])'
  ];
  v_public_fns text[] := array[
    'public.salary_advance_list_project_workers(uuid, uuid, text, text, text, integer)',
    'public.salary_advance_list_project_worker_history(uuid, uuid, text, uuid, text, text, text, text, text, integer)',
    'public.salary_advance_create_request(uuid, uuid, text, uuid, text, text, text, text, text)',
    'public.salary_advance_post_message(uuid, uuid, uuid, integer, text, text, text)',
    'public.salary_advance_transition_request(uuid, uuid, uuid, text, integer, text, text, text)',
    'public.salary_advance_reserve_evidence(uuid, uuid, uuid, integer, text, integer, text, text, text, text)',
    'public.salary_advance_finalize_evidence(uuid, uuid, uuid, uuid, integer, text, text)',
    'public.salary_advance_review_evidence(uuid, uuid, uuid, integer, integer, text, uuid, integer, text, text, text)',
    'public.vendor_finance_list_project_accountants_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.vendor_finance_assign_project_accountant_admin(uuid, uuid, text, uuid, integer, date, text, uuid, text)',
    'public.vendor_finance_end_project_accountant_admin(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.vendor_finance_list_global_roles_admin(uuid, uuid, text, boolean, integer, integer)',
    'public.vendor_finance_assign_global_role_admin(uuid, uuid, uuid, text, integer, date, text, uuid, text)',
    'public.vendor_finance_end_global_role_admin(uuid, uuid, uuid, integer, date, text, uuid, text)',
    'public.vendor_finance_get_monthly_report(uuid, uuid, text, text, uuid, text, text)',
    'public.vendor_finance_record_entry(uuid, uuid, text, text, text, text, text, date, text, uuid, text)',
    'public.vendor_finance_record_payment_with_offset(uuid, uuid, text, text, text, text, text, date, text, uuid, text)',
    'public.vendor_finance_apply_opening_batch(uuid, uuid, text, text, date, jsonb, text, uuid, text)',
    'public.vendor_finance_fund_shared_advance(uuid, uuid, text, text, date, text, uuid, text)',
    'public.vendor_finance_record_vendor_refund(uuid, uuid, text, text, date, text, uuid, text)',
    'public.vendor_finance_apply_shared_advance_offset(uuid, uuid, text, text, text, text, date, text, uuid, text)',
    'public.vendor_finance_reverse_entry(uuid, uuid, uuid, date, text, uuid, text)',
    'public.vendor_finance_reverse_shared_advance_movement(uuid, uuid, uuid, date, text, uuid, text)',
    'public.vendor_finance_create_reconciliation(uuid, uuid, text, text, uuid, text, date, text, text, uuid, text)',
    'public.vendor_finance_classify_unclassified_subledger(uuid, uuid, text, text, uuid, text, text, uuid, text)',
    'public.vendor_finance_reserve_evidence(uuid, uuid, text, uuid, text, integer, text, integer, uuid, text)',
    'public.vendor_finance_complete_evidence(uuid, uuid, uuid, text, text)',
    'public.vendor_finance_mark_evidence_cleaned(uuid, uuid, uuid)'
  ];
begin
  foreach v_sig in array v_internal_fns loop
    v_oid := v_sig::pg_catalog.regprocedure;
    select p.prosecdef,
           p.proconfig,
           (r.rolsuper or r.rolbypassrls)
      into v_secdef, v_proconfig, v_owner_priv
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_secdef, false)
       or not coalesce(v_owner_priv, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP8A_CHECK_INTERNAL_DEF_FAILED: %', v_sig;
    end if;

    select count(*)::integer
      into v_exposed
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      left join pg_catalog.pg_roles gr on gr.oid = a.grantee
     where p.oid = v_oid
       and (a.grantee = 0 or gr.rolname in ('anon', 'authenticated', 'service_role'));

    if v_exposed <> 0 then
      raise exception 'WP8A_CHECK_INTERNAL_ACL_EXPOSED: % (% grants)', v_sig, v_exposed;
    end if;
  end loop;

  foreach v_sig in array v_public_fns loop
    v_oid := v_sig::pg_catalog.regprocedure;
    select p.prosecdef,
           p.proconfig,
           (r.rolsuper or r.rolbypassrls)
      into v_secdef, v_proconfig, v_owner_priv
      from pg_catalog.pg_proc p
      join pg_catalog.pg_roles r on r.oid = p.proowner
     where p.oid = v_oid;

    if not coalesce(v_secdef, false)
       or not coalesce(v_owner_priv, false)
       or not ('search_path=pg_catalog, public' = any(coalesce(v_proconfig, array[]::text[]))) then
      raise exception 'WP8A_CHECK_PUBLIC_DEF_FAILED: %', v_sig;
    end if;

    select count(*)::integer
      into v_exposed
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      left join pg_catalog.pg_roles gr on gr.oid = a.grantee
     where p.oid = v_oid
       and (a.grantee = 0 or gr.rolname in ('anon', 'authenticated'));

    if v_exposed <> 0 then
      raise exception 'WP8A_CHECK_PUBLIC_ACL_EXPOSED: % (% grants)', v_sig, v_exposed;
    end if;

    select count(*)::integer
      into v_svc_grant
      from pg_catalog.pg_proc p
      cross join lateral pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
      join pg_catalog.pg_roles gr on gr.oid = a.grantee
     where p.oid = v_oid
       and gr.rolname = 'service_role'
       and a.privilege_type = 'EXECUTE';

    if v_svc_grant < 1 then
      raise exception 'WP8A_CHECK_PUBLIC_SERVICE_ROLE_MISSING: %', v_sig;
    end if;
  end loop;
end
$check_wp8a$;

commit;
